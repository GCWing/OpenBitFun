//! Read-only Claude Code transcripts. Discovery reads bounded head/tail metadata;
//! history follows the selected conversation's parent links, never file order.
use openbitfun_product_domains::session_import::*;
use openbitfun_services_core::bounded_fs::{
    collect_bounded_regular_files_with_prune, is_symlink_or_reparse, read_bounded_text,
    BoundedDirectoryWalkLimits, BoundedTextRead,
};
use serde_json::Value;
use sha2::{Digest, Sha256};
use std::collections::{BTreeMap, HashMap, HashSet};
use std::fs::File;
use std::io::{Read, Seek, SeekFrom};
use std::path::{Path, PathBuf};
use std::time::UNIX_EPOCH;

pub const SOURCE_REVISION: &str = "claude-code-transcript-v2";
const MAX_FILE_BYTES: usize = 256 * 1024 * 1024;
const MAX_LINE_BYTES: usize = 8 * 1024 * 1024;
const MAX_DOCUMENT_BYTES: usize = 128 * 1024 * 1024;
const HEADER_BYTES: usize = 256 * 1024;

#[derive(Clone)]
pub struct ClaudeCodeSessionReader {
    pub claude_home: PathBuf,
}

impl Default for ClaudeCodeSessionReader {
    fn default() -> Self {
        Self::new(
            std::env::var_os("CLAUDE_CONFIG_DIR")
                .map(PathBuf::from)
                .or_else(|| dirs::home_dir().map(|home| home.join(".claude")))
                .unwrap_or_default(),
        )
    }
}

impl ClaudeCodeSessionReader {
    pub fn new(claude_home: PathBuf) -> Self {
        Self { claude_home }
    }

    fn paths(&self) -> Result<Vec<PathBuf>, String> {
        if !self.claude_home.is_absolute() {
            return Err("Claude Code home must be an absolute host path".into());
        }
        let root = self.claude_home.join("projects");
        match std::fs::symlink_metadata(&root) {
            Err(error) if error.kind() == std::io::ErrorKind::NotFound => return Ok(Vec::new()),
            Err(error) => {
                return Err(format!(
                    "Claude Code projects directory is unreadable: {error}"
                ))
            }
            Ok(metadata) if !metadata.is_dir() || is_symlink_or_reparse(&metadata) => {
                return Err("Claude Code projects path must be a regular directory".into());
            }
            Ok(_) => {}
        }
        collect_bounded_regular_files_with_prune(
            &root,
            BoundedDirectoryWalkLimits::for_file_limit(100_000),
            |path| path.parent() == Some(root.as_path()),
            |path| {
                path.extension()
                    .is_some_and(|extension| extension == "jsonl")
                    && path.parent().and_then(Path::parent) == Some(root.as_path())
            },
        )
        .map_err(|error| format!("Claude Code session discovery failed: {error}"))
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
        let mut sessions = HashMap::<String, ExternalSessionCandidate>::new();
        let mut diagnostics = Vec::new();
        for path in self.paths()? {
            match inspect(&path) {
                Ok(Some(candidate)) => {
                    let old = sessions.get(&candidate.source_session_id);
                    if old.is_none_or(|old| candidate.updated_at > old.updated_at) {
                        sessions.insert(candidate.source_session_id.clone(), candidate);
                    }
                }
                Ok(None) => {}
                Err(error) if diagnostics.len() < 20 => {
                    diagnostics.push(warning("source_unreadable", &error));
                }
                Err(_) => {}
            }
        }
        let query = query.trim().to_lowercase();
        let mut candidates = sessions
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
            .collect::<Vec<_>>();
        candidates.sort_by(|left, right| {
            right
                .updated_at
                .cmp(&left.updated_at)
                .then_with(|| left.candidate_id.cmp(&right.candidate_id))
        });
        let end = cursor.saturating_add(limit).min(candidates.len());
        Ok(ExternalSessionCatalog {
            schema_version: EXTERNAL_SESSION_IMPORT_SCHEMA_V1,
            ecosystem_id: "claude-code".into(),
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
        let id = candidate_id
            .strip_prefix("claude-code:")
            .filter(|id| !id.is_empty() && id.len() <= 256 && !id.contains(['/', '\\', ':']))
            .ok_or("Invalid Claude Code session candidate ID")?;
        let mut paths = self
            .paths()?
            .into_iter()
            .filter(|path| path.file_stem().is_some_and(|stem| stem == id))
            .collect::<Vec<_>>();
        paths.sort_by_key(|path| {
            std::fs::metadata(path)
                .and_then(|metadata| metadata.modified())
                .ok()
        });
        let path = paths
            .last()
            .ok_or("Claude Code session was removed or moved; refresh the list")?;
        let mut candidate =
            inspect(path)?.ok_or("Claude Code session has no visible conversation")?;
        let content =
            match read_bounded_text(path, MAX_FILE_BYTES).map_err(|error| error.to_string())? {
                BoundedTextRead::Content(content) => content,
                BoundedTextRead::TooLarge => {
                    return Err("Claude Code transcript exceeds the read limit".into())
                }
                BoundedTextRead::InvalidUtf8 => {
                    return Err("Claude Code transcript is not UTF-8".into())
                }
            };
        let (turns, warnings) = translate(&content, id, mode)?;
        candidate.fingerprint =
            format!("sha256:{}", hex::encode(Sha256::digest(content.as_bytes())));
        candidate.turn_count = Some(turns.len());
        candidate.file_size_bytes = content.len() as u64;
        candidate.status = turns
            .last()
            .map(|turn| turn.status)
            .unwrap_or(ExternalSessionStatus::Interrupted);
        Ok(ExternalSessionDocument {
            candidate,
            turns,
            warnings,
        })
    }
}

fn inspect(path: &Path) -> Result<Option<ExternalSessionCandidate>, String> {
    let mut file = File::open(path).map_err(|error| error.to_string())?;
    let metadata = file.metadata().map_err(|error| error.to_string())?;
    let size = metadata.len();
    let mut head = Vec::new();
    file.by_ref()
        .take(HEADER_BYTES as u64)
        .read_to_end(&mut head)
        .map_err(|error| error.to_string())?;
    let mut tail = Vec::new();
    let tail_start = size
        .saturating_sub(HEADER_BYTES as u64)
        .max(head.len() as u64);
    if tail_start < size {
        file.seek(SeekFrom::Start(tail_start))
            .map_err(|error| error.to_string())?;
        file.take(HEADER_BYTES as u64)
            .read_to_end(&mut tail)
            .map_err(|error| error.to_string())?;
    }
    let mut rows = Vec::new();
    for (bytes, skip_first, clipped_end) in [
        (&head, false, size > head.len() as u64),
        (&tail, tail_start > 0, false),
    ] {
        let lines = bytes.split(|byte| *byte == b'\n').collect::<Vec<_>>();
        for (index, line) in lines.iter().enumerate() {
            if (skip_first && index == 0)
                || (clipped_end && index + 1 == lines.len())
                || line.is_empty()
            {
                continue;
            }
            let value: Value = serde_json::from_slice(line)
                .map_err(|_| "Malformed Claude Code transcript metadata")?;
            rows.push(value);
        }
    }
    if rows
        .iter()
        .find(|row| row["type"] == "user" || row["type"] == "assistant")
        .is_some_and(|row| row["isSidechain"] == true || row["teamName"].is_string())
    {
        return Ok(None);
    }
    let id = path
        .file_stem()
        .and_then(|stem| stem.to_str())
        .ok_or("Invalid Claude Code transcript name")?;
    let first = rows
        .iter()
        .find(|row| row["sessionId"] == id && row["cwd"].is_string());
    let Some(first) = first else {
        return Ok(None);
    };
    let named = |field: &str| {
        rows.iter()
            .rev()
            .find_map(|row| row[field].as_str())
            .map(|text| preview(text, 240))
    };
    let source_title = named("customTitle").or_else(|| named("aiTitle"));
    let prompt = rows
        .iter()
        .filter(|row| is_title_user_entry(row))
        .find_map(|row| text_content(&row["message"]["content"]).filter(|text| !text.is_empty()));
    let title = source_title
        .clone()
        .or_else(|| prompt.map(|text| preview(&text, 120)));
    if title.is_none() {
        return Ok(None);
    }
    let updated = metadata
        .modified()
        .ok()
        .and_then(|time| time.duration_since(UNIX_EPOCH).ok())
        .map(|time| time.as_millis() as u64);
    Ok(Some(ExternalSessionCandidate {
        candidate_id: format!("claude-code:{id}"),
        ecosystem_id: "claude-code".into(),
        source_session_id: id.into(),
        title,
        fallback_title: None,
        title_is_source_name: source_title.is_some(),
        cwd: first["cwd"].as_str().map(str::to_owned),
        created_at: rows.iter().find_map(|row| timestamp(&row["timestamp"])),
        updated_at: updated,
        model_provider: None,
        model_name: rows
            .iter()
            .rev()
            .find_map(|row| row["message"]["model"].as_str())
            .map(str::to_owned),
        turn_count: None,
        file_size_bytes: size,
        format_version: first["version"].as_str().map(str::to_owned),
        status: ExternalSessionStatus::Complete,
        fingerprint: format!("metadata:{size}:{}", updated.unwrap_or_default()),
        source_location: Some(path.display().to_string()),
        target_workspace_id: None,
        target_workspace_name: None,
        imported_session_id: None,
    }))
}

fn translate(
    content: &str,
    session_id: &str,
    mode: ExternalSessionImportMode,
) -> Result<(Vec<ExternalSessionTurn>, Vec<ExternalSessionImportWarning>), String> {
    let mut entries = Vec::<Value>::new();
    let mut by_id = HashMap::<String, usize>::new();
    for line in content.lines().filter(|line| !line.trim().is_empty()) {
        if line.len() > MAX_LINE_BYTES {
            return Err("Claude Code record exceeds the read limit".into());
        }
        let value: Value =
            serde_json::from_str(line).map_err(|_| "Malformed Claude Code transcript record")?;
        if matches!(
            value["type"].as_str(),
            Some("user" | "assistant" | "progress" | "system" | "attachment")
        ) {
            if matches!(value["type"].as_str(), Some("user" | "assistant"))
                && value["uuid"].as_str().is_none()
            {
                return Err("Claude Code message has no UUID".into());
            }
            if let Some(id) = value["uuid"].as_str() {
                if value["sessionId"]
                    .as_str()
                    .is_some_and(|id| id != session_id)
                {
                    return Err("Claude Code transcript identity changed".into());
                }
                by_id.insert(id.to_owned(), entries.len());
                entries.push(value);
            }
        }
    }
    let leaf = entries
        .iter()
        .rposition(|entry| is_history_leaf_entry(entry));
    let Some(mut current) = leaf else {
        return Err("Claude Code session has no visible conversation".into());
    };
    let mut chain = Vec::new();
    let mut seen = HashSet::new();
    let mut warnings = BTreeMap::<&str, &str>::new();
    loop {
        if !seen.insert(current) {
            return Err("Claude Code transcript contains a parent cycle".into());
        }
        chain.push(current);
        let entry = &entries[current];
        let parent = entry["parentUuid"].as_str().or_else(|| {
            if mode != ExternalSessionImportMode::Full || entry["subtype"] != "compact_boundary" {
                return None;
            }
            // Newer Claude versions can point logicalParentUuid at an in-memory
            // entry that was never persisted. Their explicit preserved tail is
            // the durable predecessor; do not guess it from file adjacency.
            entry["logicalParentUuid"]
                .as_str()
                .filter(|id| by_id.contains_key(*id))
                .or_else(|| entry["compactMetadata"]["preservedSegment"]["tailUuid"].as_str())
                .or_else(|| entry["logicalParentUuid"].as_str())
        });
        let Some(parent) = parent else {
            break;
        };
        current = *by_id
            .get(parent)
            .ok_or("Claude Code transcript parent is missing; history is incomplete")?;
    }
    chain.reverse();
    let mut turns = Vec::<ExternalSessionTurn>::new();
    let mut tools = HashMap::<String, (usize, usize)>::new();
    for index in chain {
        let entry = &entries[index];
        if entry["isSidechain"] == true || entry["teamName"].is_string() {
            continue;
        }
        if is_internal_user_entry(entry) {
            if is_interruption_entry(entry) {
                if let Some(turn) = turns.last_mut() {
                    turn.status = ExternalSessionStatus::Interrupted;
                }
                warnings.insert(
                    "source_turn_interrupted",
                    "The source conversation includes a user interruption.",
                );
            } else {
                warnings.insert(
                    "internal_commands_omitted",
                    "Claude Code local command and background task records are omitted from imported user history.",
                );
            }
            continue;
        }
        if entry["subtype"] == "compact_boundary" || entry["isCompactSummary"] == true {
            warnings.insert("compaction_present", "Claude Code compacted this conversation; full import retains available earlier history.");
        }
        if entry["isMeta"] == true || !matches!(entry["type"].as_str(), Some("user" | "assistant"))
        {
            continue;
        }
        if entry["isCompactSummary"] == true
            && mode == ExternalSessionImportMode::Full
            && !turns.is_empty()
        {
            continue;
        }
        let message = &entry["message"];
        let content = &message["content"];
        if entry["type"] == "user" {
            let text = text_content(content).unwrap_or_default();
            let attachment = content.as_array().is_some_and(|blocks| {
                blocks
                    .iter()
                    .any(|block| matches!(block["type"].as_str(), Some("image" | "document")))
            });
            if !text.is_empty() || attachment {
                if turns.len() >= 4096 {
                    return Err("Claude Code session exceeds the turn limit".into());
                }
                let mut text = text;
                if attachment {
                    if !text.is_empty() {
                        text.push('\n');
                    }
                    text.push_str("[Attachment retained in Claude Code]");
                    warnings.insert(
                        "attachments_not_imported",
                        "Attachment contents remain in Claude Code and are not copied or opened.",
                    );
                }
                turns.push(ExternalSessionTurn {
                    source_turn_id: entry["uuid"].as_str().unwrap_or_default().into(),
                    timestamp: timestamp(&entry["timestamp"]).unwrap_or_default(),
                    user_text: text,
                    items: Vec::new(),
                    source_event_count: 0,
                    status: ExternalSessionStatus::Interrupted,
                });
            }
        }
        if turns.is_empty() {
            return Err("Claude Code history starts without a user message".into());
        }
        let turn_index = turns.len() - 1;
        turns[turn_index].source_event_count += 1;
        if let Some(blocks) = content.as_array() {
            for block in blocks {
                match block["type"].as_str() {
                    Some("text") if entry["type"] == "assistant" => {
                        turns[turn_index].items.push(ExternalSessionItem::Text {
                            text: block["text"]
                                .as_str()
                                .ok_or("Invalid Claude Code text block")?
                                .into(),
                        })
                    }
                    Some("thinking") => {
                        turns[turn_index].items.push(ExternalSessionItem::Thinking {
                            text: block["thinking"]
                                .as_str()
                                .ok_or("Invalid Claude Code thinking block")?
                                .into(),
                        })
                    }
                    Some("tool_use") => {
                        let id = block["id"]
                            .as_str()
                            .ok_or("Claude Code tool call has no ID")?
                            .to_owned();
                        if tools.contains_key(&id) {
                            return Err("Duplicate Claude Code tool call ID".into());
                        }
                        tools.insert(id.clone(), (turn_index, turns[turn_index].items.len()));
                        turns[turn_index].items.push(ExternalSessionItem::Tool {
                            id,
                            name: block["name"]
                                .as_str()
                                .ok_or("Claude Code tool call has no name")?
                                .into(),
                            input: block["input"].clone(),
                            result: None,
                            success: None,
                        });
                    }
                    Some("tool_result") => {
                        let id = block["tool_use_id"]
                            .as_str()
                            .ok_or("Claude Code tool result has no ID")?;
                        let &(turn, item) = tools
                            .get(id)
                            .ok_or("Claude Code tool result has no matching call")?;
                        if let ExternalSessionItem::Tool {
                            result, success, ..
                        } = &mut turns[turn].items[item]
                        {
                            *result = Some(if let Some(blocks) = block["content"].as_array() {
                                Value::Array(blocks.iter().map(|content| {
                                    if matches!(content["type"].as_str(), Some("image" | "document")) {
                                        warnings.insert("attachments_not_imported", "Attachment contents remain in Claude Code and are not copied or opened.");
                                        serde_json::json!({"type":"text","text":"[Attachment retained in Claude Code]"})
                                    } else {
                                        content.clone()
                                    }
                                }).collect())
                            } else {
                                block["content"].clone()
                            });
                            *success = Some(block["is_error"] != true);
                        }
                    }
                    Some("image" | "document" | "redacted_thinking") => {
                        warnings.insert(
                            "attachments_not_imported",
                            "Attachment or protected thinking contents remain in Claude Code.",
                        );
                    }
                    Some("text") => {}
                    _ => return Err("Unsupported Claude Code content block".into()),
                }
            }
        } else if entry["type"] == "assistant" {
            turns[turn_index].items.push(ExternalSessionItem::Text {
                text: content
                    .as_str()
                    .ok_or("Invalid Claude Code message content")?
                    .into(),
            });
        } else if !content.is_string() {
            return Err("Invalid Claude Code message content".into());
        }
        if entry["type"] == "assistant" {
            if matches!(
                message["stop_reason"].as_str(),
                Some("end_turn" | "stop_sequence")
            ) && entry["isApiErrorMessage"] != true
            {
                turns[turn_index].status = ExternalSessionStatus::Complete;
            } else {
                turns[turn_index].status = ExternalSessionStatus::Interrupted;
            }
            if entry["isApiErrorMessage"] == true {
                warnings.insert(
                    "source_turn_error",
                    "The source conversation includes an API error.",
                );
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
        > MAX_DOCUMENT_BYTES
    {
        return Err("Converted Claude Code history exceeds the read limit".into());
    }
    Ok((
        turns,
        warnings
            .into_iter()
            .map(|(code, detail)| warning(code, detail))
            .collect(),
    ))
}

fn text_content(content: &Value) -> Option<String> {
    content.as_str().map(str::to_owned).or_else(|| {
        content.as_array().map(|blocks| {
            blocks
                .iter()
                .filter(|block| block["type"] == "text")
                .filter_map(|block| block["text"].as_str())
                .collect::<Vec<_>>()
                .join("\n")
        })
    })
}

fn is_title_user_entry(entry: &Value) -> bool {
    entry["type"] == "user"
        && entry["isMeta"] != true
        && entry["isCompactSummary"] != true
        && !is_internal_user_entry(entry)
}

fn is_history_leaf_entry(entry: &Value) -> bool {
    if entry["isSidechain"] == true || entry["teamName"].is_string() {
        return false;
    }
    match entry["type"].as_str() {
        Some("assistant") => entry["isMeta"] != true,
        Some("user") => {
            entry["isMeta"] != true
                && (!is_internal_user_entry(entry) || is_interruption_entry(entry))
        }
        _ => false,
    }
}

fn is_internal_user_entry(entry: &Value) -> bool {
    entry["type"] == "user"
        && text_content(&entry["message"]["content"])
            .is_some_and(|text| is_internal_user_text(&text))
}

fn is_interruption_entry(entry: &Value) -> bool {
    text_content(&entry["message"]["content"])
        .is_some_and(|text| text.trim() == "[Request interrupted by user for tool use]")
}

fn is_internal_user_text(text: &str) -> bool {
    let text = text.trim_start();
    text.starts_with("<command-name>")
        || text.starts_with("<command-message>")
        || text.starts_with("<command-args>")
        || text.starts_with("<local-command-caveat>")
        || text.starts_with("<local-command-stdout>")
        || text.starts_with("<local-command-stderr>")
        || text.starts_with("<task-notification>")
        || text.starts_with("[Request interrupted by user for tool use]")
}

fn timestamp(value: &Value) -> Option<u64> {
    value.as_u64().or_else(|| {
        value
            .as_str()
            .and_then(|value| chrono::DateTime::parse_from_rfc3339(value).ok())
            .and_then(|date| u64::try_from(date.timestamp_millis()).ok())
    })
}

fn preview(text: &str, limit: usize) -> String {
    text.chars().take(limit).collect()
}
fn warning(code: &str, detail: &str) -> ExternalSessionImportWarning {
    ExternalSessionImportWarning {
        code: code.into(),
        detail: detail.into(),
    }
}

#[cfg(test)]
mod tests;
