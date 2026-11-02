//! Read-only DeepSeek Harness v0 transcripts; no Cordis or CLI execution.
use openbitfun_product_domains::session_import::*;
use openbitfun_services_core::bounded_fs::{
    collect_bounded_regular_files, is_symlink_or_reparse, BoundedDirectoryWalkLimits,
};
use serde_json::{json, Value};
use sha2::{Digest, Sha256};
use std::collections::{BTreeSet, HashMap};
use std::fs::File;
use std::io::Read;
use std::path::{Path, PathBuf};
use std::time::UNIX_EPOCH;

pub const SOURCE_REVISION: &str = "dsh-session-v1";
/// Prefix used by the host importer to distinguish unsupported source versions
/// from sources that cannot currently be read.
pub const UNSUPPORTED_ERROR_PREFIX: &str = "unsupported:";

pub fn is_unsupported_error(error: &str) -> bool {
    error.starts_with(UNSUPPORTED_ERROR_PREFIX)
}

const ECOSYSTEM: &str = "deepseek-harness";
const MAX_BYTES: usize = 256 * 1024 * 1024;
const MAX_RECORD_BYTES: usize = 8 * 1024 * 1024;
const PREFIX_BYTES: usize = 256 * 1024;

#[derive(Clone)]
pub struct DshSessionReader {
    pub dsh_home: PathBuf,
}

impl Default for DshSessionReader {
    fn default() -> Self {
        Self::new(crate::DshHookProviderOptions::default().dsh_home)
    }
}

impl DshSessionReader {
    pub fn new(dsh_home: PathBuf) -> Self {
        Self { dsh_home }
    }

    fn paths(&self) -> Result<Vec<PathBuf>, String> {
        if !self.dsh_home.is_absolute() {
            return Err("DeepSeek Harness home must be an absolute host path".into());
        }
        let root = self.dsh_home.join("sessions");
        match std::fs::symlink_metadata(&root) {
            Err(error) if error.kind() == std::io::ErrorKind::NotFound => return Ok(Vec::new()),
            Err(error) => return Err(format!("DeepSeek Harness sessions are unreadable: {error}")),
            Ok(metadata) if !metadata.is_dir() || is_symlink_or_reparse(&metadata) => {
                return Err("DeepSeek Harness session root must be a regular directory".into());
            }
            Ok(_) => {}
        }
        collect_bounded_regular_files(
            &root,
            BoundedDirectoryWalkLimits::for_file_limit(100_000),
            |path| {
                path.file_name()
                    .is_some_and(|name| name == "session.jsonl" || name == "session.jsonl.zstd")
            },
        )
        .map_err(|error| format!("DeepSeek Harness discovery failed: {error}"))
    }

    pub fn discover_all(&self) -> Result<ExternalSessionCatalog, String> {
        self.discover_page(0, usize::MAX, "")
    }

    pub fn discover(
        &self,
        cursor: usize,
        limit: usize,
        query: &str,
    ) -> Result<ExternalSessionCatalog, String> {
        self.discover_page(cursor, limit.clamp(1, 50), query)
    }

    fn discover_page(
        &self,
        cursor: usize,
        limit: usize,
        query: &str,
    ) -> Result<ExternalSessionCatalog, String> {
        let mut candidates = HashMap::<String, ExternalSessionCandidate>::new();
        let mut diagnostics = Vec::new();
        for path in self.paths()? {
            match inspect(&path) {
                Ok(Some(candidate)) => {
                    if candidates
                        .get(&candidate.source_session_id)
                        .is_none_or(|old| old.updated_at < candidate.updated_at)
                    {
                        candidates.insert(candidate.source_session_id.clone(), candidate);
                    }
                }
                Ok(None) => {}
                Err(error) if diagnostics.len() < 20 => {
                    diagnostics.push(warning("source_unreadable", &error))
                }
                Err(_) => {}
            }
        }
        let query = query.trim().to_lowercase();
        let mut candidates: Vec<_> = candidates
            .into_values()
            .filter(|candidate| {
                query.is_empty()
                    || format!(
                        "{} {}",
                        candidate.title.as_deref().unwrap_or(""),
                        candidate.cwd.as_deref().unwrap_or("")
                    )
                    .to_lowercase()
                    .contains(&query)
            })
            .collect();
        candidates.sort_by(|left, right| {
            right
                .updated_at
                .cmp(&left.updated_at)
                .then_with(|| left.candidate_id.cmp(&right.candidate_id))
        });
        let end = cursor.saturating_add(limit).min(candidates.len());
        Ok(ExternalSessionCatalog {
            schema_version: EXTERNAL_SESSION_IMPORT_SCHEMA_V1,
            ecosystem_id: ECOSYSTEM.into(),
            source_revision: SOURCE_REVISION.into(),
            next_cursor: (end < candidates.len()).then_some(end),
            candidates: candidates.into_iter().skip(cursor).take(limit).collect(),
            diagnostics,
        })
    }

    pub fn read_candidate(
        &self,
        candidate_id: &str,
        mode: ExternalSessionImportMode,
    ) -> Result<ExternalSessionDocument, String> {
        if mode != ExternalSessionImportMode::Full {
            return Err(format!(
                "{UNSUPPORTED_ERROR_PREFIX}DeepSeek Harness import supports full transcript history only"
            ));
        }
        let id = candidate_id
            .strip_prefix("deepseek-harness:")
            .filter(|id| !id.is_empty() && id.len() <= 1024)
            .ok_or("Invalid DeepSeek Harness candidate ID")?;
        // IDs are opaque data. Resolve only by validated headers, never by joining an ID to a path.
        let mut found: Option<(PathBuf, ExternalSessionCandidate)> = None;
        for path in self.paths()? {
            if let Ok(Some(candidate)) = inspect(&path) {
                if candidate.source_session_id == id
                    && found
                        .as_ref()
                        .is_none_or(|(_, old)| old.updated_at < candidate.updated_at)
                {
                    found = Some((path, candidate));
                }
            }
        }
        let (path, mut candidate) = found.ok_or(
            "DeepSeek Harness session was removed, moved, or is unreadable; refresh the list",
        )?;
        let (text, clipped) = read_text(&path, MAX_BYTES)?;
        if clipped {
            return Err("DeepSeek Harness transcript exceeds the decompression limit".into());
        }
        let (turns, warnings) = translate(&text, id)?;
        candidate.fingerprint = format!("sha256:{}", hex::encode(Sha256::digest(text.as_bytes())));
        candidate.turn_count = Some(turns.len());
        candidate.status = turns
            .last()
            .map(|turn| turn.status)
            .unwrap_or(ExternalSessionStatus::Complete);
        Ok(ExternalSessionDocument {
            candidate,
            turns,
            warnings,
        })
    }
}

fn read_text(path: &Path, limit: usize) -> Result<(String, bool), String> {
    let metadata = std::fs::symlink_metadata(path).map_err(|error| error.to_string())?;
    if !metadata.is_file() || is_symlink_or_reparse(&metadata) {
        return Err("DeepSeek Harness transcript must be a regular file".into());
    }
    if metadata.len() > MAX_BYTES as u64 {
        return Err("DeepSeek Harness transcript exceeds the file limit".into());
    }
    let file = File::open(path).map_err(|error| error.to_string())?;
    let input = file.take(MAX_BYTES as u64 + 1);
    let reader: Box<dyn Read> = if path.extension().is_some_and(|ext| ext == "zstd") {
        // The default decoder reads every concatenated frame, including the separate header frame.
        let mut decoder =
            zstd::stream::read::Decoder::new(input).map_err(|error| error.to_string())?;
        decoder
            .window_log_max(27)
            .map_err(|error| error.to_string())?;
        Box::new(decoder)
    } else {
        Box::new(input)
    };
    let mut bytes = Vec::new();
    reader
        .take(limit as u64 + 1)
        .read_to_end(&mut bytes)
        .map_err(|error| format!("DeepSeek Harness transcript cannot be decoded: {error}"))?;
    let clipped = bytes.len() > limit;
    if clipped {
        bytes.truncate(limit);
        let end = bytes
            .iter()
            .rposition(|byte| *byte == b'\n')
            .ok_or("DeepSeek Harness header exceeds the metadata limit")?;
        bytes.truncate(end + 1);
    }
    Ok((
        String::from_utf8(bytes).map_err(|_| "DeepSeek Harness transcript is not UTF-8")?,
        clipped,
    ))
}

fn header(text: &str) -> Result<Value, String> {
    let value: Value = serde_json::from_str(
        text.lines()
            .next()
            .ok_or("DeepSeek Harness header is missing")?,
    )
    .map_err(|_| "Malformed DeepSeek Harness header")?;
    if value["type"] != "session" || value["version"].as_u64() != Some(0) {
        return Err(format!(
            "{UNSUPPORTED_ERROR_PREFIX}Unsupported DeepSeek Harness session version; only v0 is supported"
        ));
    }
    if value["id"].as_str().is_none_or(str::is_empty)
        || value["delegationDepth"].as_u64().is_none()
        || value["createdAt"].as_u64().is_none()
    {
        return Err("Invalid DeepSeek Harness session metadata".into());
    }
    Ok(value)
}

fn inspect(path: &Path) -> Result<Option<ExternalSessionCandidate>, String> {
    let (text, _) = read_text(path, PREFIX_BYTES)?;
    let header = header(&text)?;
    if header["origin"] == "subagent" || header["delegationDepth"].as_u64().unwrap_or(0) > 0 {
        return Ok(None);
    }
    let id = header["id"].as_str().unwrap_or_default();
    let mut title = None;
    let mut named = false;
    let mut provider = None;
    let mut model = None;
    for line in text.lines().skip(1) {
        let row: Value =
            serde_json::from_str(line).map_err(|_| "Malformed DeepSeek Harness metadata")?;
        if row["type"] == "session/title" {
            if let Some(value) = row["data"]["title"]
                .as_str()
                .filter(|value| !value.trim().is_empty())
            {
                title = Some(value.chars().take(180).collect());
                named = true;
            }
        } else if title.is_none()
            && row["type"] == "user/message"
            && row["surfaceOp"] == "append"
            && row["data"]["source"]["kind"] == "user"
        {
            title = Some(
                visible_text(&row["data"]["content"])
                    .chars()
                    .take(180)
                    .collect(),
            );
        } else if row["type"] == "request/context" {
            provider = row["data"]["provider"].as_str().map(str::to_owned);
            model = row["data"]["model"].as_str().map(str::to_owned);
        }
    }
    let metadata = std::fs::metadata(path).map_err(|error| error.to_string())?;
    let updated = metadata
        .modified()
        .ok()
        .and_then(|time| time.duration_since(UNIX_EPOCH).ok())
        .map(|time| time.as_millis() as u64);
    Ok(Some(ExternalSessionCandidate {
        candidate_id: format!("{ECOSYSTEM}:{id}"),
        ecosystem_id: ECOSYSTEM.into(),
        source_session_id: id.into(),
        title,
        title_is_source_name: named,
        fallback_title: Some(format!(
            "DeepSeek Harness session {}",
            id.chars().take(16).collect::<String>()
        )),
        cwd: header["cwd"].as_str().map(str::to_owned),
        created_at: header["createdAt"].as_u64(),
        updated_at: updated,
        model_provider: provider,
        model_name: model,
        turn_count: None,
        file_size_bytes: metadata.len(),
        format_version: Some("0".into()),
        status: ExternalSessionStatus::Complete,
        fingerprint: format!(
            "metadata:{}:{}",
            metadata.len(),
            updated.unwrap_or_default()
        ),
        source_location: Some(path.display().to_string()),
        target_workspace_id: None,
        target_workspace_name: None,
        imported_session_id: None,
    }))
}

fn translate(
    text: &str,
    session_id: &str,
) -> Result<(Vec<ExternalSessionTurn>, Vec<ExternalSessionImportWarning>), String> {
    let metadata = header(text)?;
    if metadata["id"] != session_id {
        return Err("DeepSeek Harness session identity changed".into());
    }
    let mut seq = 0_u64;
    let mut source_turn = 0_u64;
    let mut turns = Vec::<ExternalSessionTurn>::new();
    let mut tools = HashMap::<String, (usize, usize)>::new();
    let mut warnings = BTreeSet::new();
    for line in text.lines().skip(1).filter(|line| !line.trim().is_empty()) {
        if line.len() > MAX_RECORD_BYTES {
            return Err("DeepSeek Harness record exceeds the read limit".into());
        }
        let row: Value =
            serde_json::from_str(line).map_err(|_| "Malformed DeepSeek Harness record")?;
        let kind = row["type"]
            .as_str()
            .ok_or("DeepSeek Harness event has no type")?;
        let data = &row["data"];
        if matches!(
            kind,
            "text-chunks" | "reasoning-chunks" | "tool-call-chunks"
        ) {
            let values = data[if kind == "tool-call-chunks" {
                "args"
            } else {
                "texts"
            }]
            .as_array()
            .ok_or("Invalid packed DeepSeek Harness chunks")?;
            if row["seq0"].as_u64() != Some(seq)
                || values.is_empty()
                || values.iter().any(|value| !value.is_string())
                || data["dt"].as_array().is_none_or(|gaps| {
                    gaps.len() + 1 != values.len() || gaps.iter().any(|gap| gap.as_i64().is_none())
                })
            {
                return Err("Invalid packed DeepSeek Harness chunk sequence".into());
            }
            seq += values.len() as u64;
            continue; // Assembled messages below own transcript text and tools.
        }
        if row["seq"].as_u64() != Some(seq) {
            return Err("DeepSeek Harness event sequence is incomplete".into());
        }
        seq += 1;
        if matches!(kind, "user/message" | "assistant/message" | "tool/result")
            && row["surfaceOp"] != "append"
        {
            if row["surfaceOp"]["op"] == "replace" {
                warnings.insert("compaction_retained");
                continue;
            }
            return Err("Unsupported DeepSeek Harness surface operation".into());
        }
        match kind {
            "turn/start" => {
                source_turn = data["turn"]
                    .as_u64()
                    .ok_or("DeepSeek Harness turn has no number")?
            }
            "user/message" if data["source"]["kind"] == "user" => {
                let text = visible_text(&clean_content(&data["content"], &mut warnings)?);
                let turn_id = format!("turn-{source_turn}");
                if let Some(turn) = turns
                    .last_mut()
                    .filter(|turn| turn.source_turn_id == turn_id)
                {
                    turn.user_text.push('\n');
                    turn.user_text.push_str(&text);
                    turn.source_event_count += 1;
                } else {
                    if turns.len() >= 4096 {
                        return Err("DeepSeek Harness session exceeds the turn limit".into());
                    }
                    turns.push(ExternalSessionTurn {
                        source_turn_id: turn_id,
                        timestamp: row["time"].as_u64().unwrap_or_default(),
                        user_text: text,
                        items: Vec::new(),
                        source_event_count: 1,
                        status: ExternalSessionStatus::Interrupted,
                    });
                }
            }
            "user/message" => {
                warnings.insert("runtime_context_omitted");
            }
            "assistant/message" => {
                let turn_index = turns
                    .len()
                    .checked_sub(1)
                    .ok_or("DeepSeek Harness assistant has no human turn")?;
                let turn = &mut turns[turn_index];
                turn.source_event_count += 1;
                for block in data["message"]["content"]
                    .as_array()
                    .ok_or("Invalid DeepSeek Harness assistant content")?
                {
                    match block["type"].as_str() {
                        Some("text" | "reasoning") => {
                            let text = block["text"]
                                .as_str()
                                .ok_or("Invalid DeepSeek Harness text block")?
                                .into();
                            turn.items.push(if block["type"] == "reasoning" {
                                ExternalSessionItem::Thinking { text }
                            } else {
                                ExternalSessionItem::Text { text }
                            });
                        }
                        Some("tool-call") => {
                            let id = block["id"]
                                .as_str()
                                .ok_or("DeepSeek Harness tool has no ID")?
                                .to_owned();
                            if tools
                                .insert(id.clone(), (turn_index, turn.items.len()))
                                .is_some()
                            {
                                return Err("Duplicate DeepSeek Harness tool call ID".into());
                            }
                            let raw = block["arguments"]
                                .as_str()
                                .ok_or("Invalid DeepSeek Harness tool arguments")?;
                            // Invalid JSON is a real model/tool error; keep its raw input visible.
                            let input = serde_json::from_str(raw)
                                .unwrap_or_else(|_| Value::String(raw.into()));
                            turn.items.push(ExternalSessionItem::Tool {
                                id,
                                name: block["name"]
                                    .as_str()
                                    .ok_or("DeepSeek Harness tool has no name")?
                                    .into(),
                                input,
                                result: None,
                                success: None,
                            });
                        }
                        Some("image") => {
                            warnings.insert("attachments_not_imported");
                            turn.items.push(ExternalSessionItem::Text {
                                text: "[Attachment retained in DeepSeek Harness]".into(),
                            });
                        }
                        _ => {
                            return Err(
                                "Unsupported DeepSeek Harness assistant content block".into()
                            )
                        }
                    }
                }
            }
            "tool/call" => {
                let id = data["callId"]
                    .as_str()
                    .ok_or("DeepSeek Harness tool event has no call ID")?;
                if !tools.contains_key(id) {
                    return Err("DeepSeek Harness tool event has no assembled call".into());
                }
            }
            "tool/result" => {
                for block in data["message"]["content"]
                    .as_array()
                    .ok_or("Invalid DeepSeek Harness tool result")?
                {
                    let id = block["toolCallId"]
                        .as_str()
                        .filter(|_| block["type"] == "tool-result")
                        .ok_or("DeepSeek Harness tool result has no call ID")?;
                    let &(turn, item) = tools
                        .get(id)
                        .ok_or("DeepSeek Harness tool result has no matching call")?;
                    let output = clean_content(&block["content"], &mut warnings)?;
                    if let ExternalSessionItem::Tool {
                        result, success, ..
                    } = &mut turns[turn].items[item]
                    {
                        if result.is_some() {
                            return Err("Duplicate DeepSeek Harness tool result".into());
                        }
                        *result = Some(output);
                        *success = Some(block["isError"] != true && data.get("error").is_none());
                    }
                    turns[turn].source_event_count += 1;
                }
            }
            "turn/end" => {
                if let Some(turn) = turns.last_mut() {
                    turn.status = if data["reason"]["kind"] == "completed" {
                        ExternalSessionStatus::Complete
                    } else {
                        ExternalSessionStatus::Interrupted
                    };
                    if let Some(error) = data["reason"]["error"]["message"].as_str() {
                        turn.items.push(ExternalSessionItem::Text {
                            text: format!("[DeepSeek Harness source error]\n{error}"),
                        });
                    }
                }
            }
            "assistant/chunk"
            | "step/start"
            | "step/end"
            | "request/header"
            | "request/context"
            | "session/end-seed"
            | "session/title"
            | "session/title-llm-request"
            | "todo/write"
            | "agent/inbox/spliced"
            | "agent-preset/selected"
            | "permission/preset"
            | "sandbox/mode"
            | "approval/policy"
            | "approval/asked"
            | "approval/decided"
            | "goal/change"
            | "subagent/descriptor"
            | "tool-workflow/agent-start"
            | "tool-workflow/agent-end"
            | "compaction/start"
            | "compaction/summary"
            | "compaction/end"
            | "compaction/prune" => {}
            _ => {
                warnings.insert("unknown_events_omitted");
            }
        }
    }
    for turn in &mut turns {
        if turn
            .items
            .iter()
            .any(|item| matches!(item, ExternalSessionItem::Tool { result: None, .. }))
        {
            turn.status = ExternalSessionStatus::Interrupted;
        }
    }
    if serde_json::to_vec(&turns)
        .map_err(|error| error.to_string())?
        .len()
        > MAX_BYTES / 2
    {
        return Err("Converted DeepSeek Harness history exceeds the read limit".into());
    }
    Ok((turns, warnings.into_iter().map(|code| warning(code, match code {
        "compaction_retained" => "The full import retains append-origin conversation; model-only replacement copies are omitted.",
        "runtime_context_omitted" => "Injected runtime and plugin context is omitted; human messages are preserved.",
        "attachments_not_imported" => "Attachment payloads remain in DeepSeek Harness and are not copied or opened.",
        "unknown_events_omitted" => "Events not understood by this adapter are omitted from the imported transcript.",
        _ => "Ignorable extension events are omitted from the imported transcript.",
    })).collect()))
}

fn clean_content(content: &Value, warnings: &mut BTreeSet<&str>) -> Result<Value, String> {
    Ok(Value::Array(
        content
            .as_array()
            .ok_or("Invalid DeepSeek Harness content")?
            .iter()
            .map(|block| match block["type"].as_str() {
                Some("text") if block["text"].is_string() => {
                    Ok(json!({"type":"text", "text":block["text"]}))
                }
                Some("image") => {
                    warnings.insert("attachments_not_imported");
                    Ok(json!({"type":"text", "text":"[Attachment retained in DeepSeek Harness]"}))
                }
                _ => Err("Unsupported DeepSeek Harness content block".into()),
            })
            .collect::<Result<Vec<_>, String>>()?,
    ))
}

fn visible_text(content: &Value) -> String {
    content
        .as_array()
        .map(|blocks| {
            blocks
                .iter()
                .filter(|block| block["type"] == "text")
                .filter_map(|block| block["text"].as_str())
                .collect::<Vec<_>>()
                .join("\n")
        })
        .unwrap_or_default()
}

fn warning(code: &str, detail: &str) -> ExternalSessionImportWarning {
    ExternalSessionImportWarning {
        code: code.into(),
        detail: detail.into(),
    }
}

#[cfg(test)]
mod tests;
