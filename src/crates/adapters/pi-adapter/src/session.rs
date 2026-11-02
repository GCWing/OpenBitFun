//! Read-only Pi session trees, including legacy v1/v2 records.
use openbitfun_product_domains::session_import::*;
use openbitfun_services_core::bounded_fs::{
    collect_bounded_regular_files, is_symlink_or_reparse, read_bounded_text,
    BoundedDirectoryWalkLimits, BoundedTextRead,
};
use serde_json::{json, Value};
use sha2::{Digest, Sha256};
use std::collections::{BTreeSet, HashMap, HashSet};
use std::fs::File;
use std::io::{Read, Seek, SeekFrom};
use std::path::{Path, PathBuf};
use std::time::UNIX_EPOCH;

pub const SOURCE_REVISION: &str = "pi-session-jsonl-v1";
const MAX_FILE_BYTES: usize = 256 * 1024 * 1024;
const MAX_RECORD_BYTES: usize = 8 * 1024 * 1024;
const MAX_DOCUMENT_BYTES: usize = 128 * 1024 * 1024;
const EDGE_BYTES: usize = 256 * 1024;

#[derive(Clone)]
pub struct PiSessionReader {
    pub agent_dir: PathBuf,
    session_dir: Option<PathBuf>,
}

impl Default for PiSessionReader {
    fn default() -> Self {
        Self {
            agent_dir: crate::PiHookProviderOptions::default().agent_dir,
            session_dir: std::env::var_os("PI_CODING_AGENT_SESSION_DIR")
                .filter(|path| !path.is_empty())
                .map(PathBuf::from),
        }
    }
}

impl PiSessionReader {
    pub fn new(agent_dir: PathBuf) -> Self {
        Self {
            agent_dir,
            session_dir: None,
        }
    }

    fn paths(&self) -> Result<Vec<PathBuf>, String> {
        if !self.agent_dir.is_absolute() {
            return Err("Pi agent directory must be an absolute host path".into());
        }
        let mut roots = vec![self.agent_dir.join("sessions")];
        let settings = self.agent_dir.join("settings.json");
        let configured = if let Some(path) = &self.session_dir {
            Some(path.clone())
        } else {
            match read_bounded_text(&settings, 1024 * 1024) {
                Ok(BoundedTextRead::Content(text)) => {
                    let settings: Value =
                        serde_json::from_str(&text).map_err(|_| "Malformed Pi settings")?;
                    match settings.get("sessionDir") {
                        None | Some(Value::Null) => None,
                        Some(Value::String(path)) => Some(PathBuf::from(path)),
                        _ => return Err("Pi sessionDir must be a path string".into()),
                    }
                }
                Err(error) if error.kind() == std::io::ErrorKind::NotFound => None,
                Err(error) => return Err(format!("Pi settings are unreadable: {error}")),
                _ => return Err("Pi settings exceed the limit or are not UTF-8".into()),
            }
        };
        if let Some(path) = configured {
            let path = expand_home(&path);
            if !path.is_absolute() {
                return Err("Relative Pi sessionDir cannot be discovered globally; use an absolute session directory".into());
            }
            roots.push(path);
        }
        let mut paths = BTreeSet::new();
        for root in roots {
            match std::fs::symlink_metadata(&root) {
                Err(error) if error.kind() == std::io::ErrorKind::NotFound => continue,
                Err(error) => return Err(format!("Pi session directory is unreadable: {error}")),
                Ok(metadata) if !metadata.is_dir() || is_symlink_or_reparse(&metadata) => {
                    return Err("Pi session path must be a regular directory".into());
                }
                Ok(_) => {}
            }
            paths.extend(
                collect_bounded_regular_files(
                    &root,
                    BoundedDirectoryWalkLimits::for_file_limit(100_000),
                    |path| {
                        path.extension()
                            .is_some_and(|extension| extension == "jsonl")
                    },
                )
                .map_err(|error| format!("Pi session discovery failed: {error}"))?,
            );
            if paths.len() > 100_000 {
                return Err("Pi session catalog exceeds the discovery limit".into());
            }
        }
        Ok(paths.into_iter().collect())
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
                Ok(candidate) => {
                    if candidates
                        .get(&candidate.source_session_id)
                        .is_none_or(|old| old.updated_at < candidate.updated_at)
                    {
                        candidates.insert(candidate.source_session_id.clone(), candidate);
                    }
                }
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
            ecosystem_id: "pi".into(),
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
            return Err("Pi import supports full active-branch history only".into());
        }
        let id = candidate_id
            .strip_prefix("pi:")
            .filter(|id| !id.is_empty() && id.len() <= 256 && !id.contains(['/', '\\', ':']))
            .ok_or("Invalid Pi session candidate ID")?;
        let mut found: Option<(PathBuf, ExternalSessionCandidate)> = None;
        for path in self.paths()? {
            let Ok(candidate) = inspect(&path) else {
                continue;
            };
            if candidate.source_session_id == id
                && found
                    .as_ref()
                    .is_none_or(|(_, old)| old.updated_at < candidate.updated_at)
            {
                found = Some((path, candidate));
            }
        }
        let (path, mut candidate) =
            found.ok_or("Pi session was removed, moved, or is unreadable; refresh the list")?;
        let text =
            match read_bounded_text(&path, MAX_FILE_BYTES).map_err(|error| error.to_string())? {
                BoundedTextRead::Content(text) => text,
                BoundedTextRead::TooLarge => return Err("Pi session exceeds the read limit".into()),
                BoundedTextRead::InvalidUtf8 => return Err("Pi session is not UTF-8".into()),
            };
        let (turns, warnings) = translate(&text, id)?;
        candidate.fingerprint = format!("sha256:{}", hex::encode(Sha256::digest(text.as_bytes())));
        candidate.file_size_bytes = text.len() as u64;
        candidate.turn_count = Some(turns.len());
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

fn expand_home(path: &Path) -> PathBuf {
    let value = path.to_string_lossy();
    if value == "~" || value.starts_with("~/") || value.starts_with("~\\") {
        dirs::home_dir()
            .map(|home| home.join(value.get(2..).unwrap_or("")))
            .unwrap_or_else(|| path.into())
    } else {
        path.into()
    }
}

fn inspect(path: &Path) -> Result<ExternalSessionCandidate, String> {
    let mut file = File::open(path).map_err(|error| error.to_string())?;
    let metadata = file.metadata().map_err(|error| error.to_string())?;
    let size = metadata.len();
    let mut head = Vec::new();
    file.by_ref()
        .take(EDGE_BYTES as u64)
        .read_to_end(&mut head)
        .map_err(|error| error.to_string())?;
    let tail_start = size
        .saturating_sub(EDGE_BYTES as u64)
        .max(head.len() as u64);
    let mut tail = Vec::new();
    if tail_start < size {
        file.seek(SeekFrom::Start(tail_start))
            .map_err(|error| error.to_string())?;
        file.take(EDGE_BYTES as u64)
            .read_to_end(&mut tail)
            .map_err(|error| error.to_string())?;
    }
    let mut rows = Vec::<Value>::new();
    for (bytes, skip_first, clipped_end) in [
        (&head, false, size > head.len() as u64),
        (&tail, tail_start > 0, false),
    ] {
        let lines: Vec<_> = bytes.split(|byte| *byte == b'\n').collect();
        for (index, line) in lines.iter().enumerate() {
            if line.is_empty()
                || (skip_first && index == 0)
                || (clipped_end && index + 1 == lines.len())
            {
                continue;
            }
            rows.push(serde_json::from_slice(line).map_err(|_| "Malformed Pi session metadata")?);
        }
    }
    let header = rows
        .first()
        .filter(|row| row["type"] == "session")
        .ok_or("Pi session header is missing")?;
    let id = header["id"]
        .as_str()
        .filter(|id| !id.is_empty())
        .ok_or("Pi session has no ID")?;
    if !matches!(session_version(header)?, 1..=3) {
        return Err("Unsupported Pi session version".into());
    }
    let name = rows
        .iter()
        .rev()
        .find(|row| row["type"] == "session_info")
        .and_then(|row| row["name"].as_str())
        .filter(|name| !name.trim().is_empty());
    let first = rows
        .iter()
        .find(|row| row["type"] == "message" && row["message"]["role"] == "user")
        .map(|row| visible_text(&row["message"]["content"]));
    let model = rows
        .iter()
        .rev()
        .find(|row| row["message"]["role"] == "assistant");
    let updated = metadata
        .modified()
        .ok()
        .and_then(|time| time.duration_since(UNIX_EPOCH).ok())
        .map(|time| time.as_millis() as u64);
    Ok(ExternalSessionCandidate {
        candidate_id: format!("pi:{id}"),
        ecosystem_id: "pi".into(),
        source_session_id: id.into(),
        title: name
            .or(first.as_deref())
            .filter(|text| !text.is_empty())
            .map(|text| text.chars().take(180).collect()),
        fallback_title: Some(format!(
            "Pi session {}",
            id.chars().take(8).collect::<String>()
        )),
        title_is_source_name: name.is_some(),
        cwd: header["cwd"].as_str().map(str::to_owned),
        created_at: timestamp(&header["timestamp"]),
        updated_at: updated,
        model_provider: model
            .and_then(|row| row["message"]["provider"].as_str())
            .map(str::to_owned),
        model_name: model
            .and_then(|row| row["message"]["model"].as_str())
            .map(str::to_owned),
        turn_count: None,
        file_size_bytes: size,
        format_version: Some(session_version(header)?.to_string()),
        status: ExternalSessionStatus::Complete,
        fingerprint: format!("metadata:{size}:{}", updated.unwrap_or_default()),
        source_location: Some(path.display().to_string()),
        target_workspace_id: None,
        target_workspace_name: None,
        imported_session_id: None,
    })
}

fn translate(
    text: &str,
    session_id: &str,
) -> Result<(Vec<ExternalSessionTurn>, Vec<ExternalSessionImportWarning>), String> {
    let mut rows = Vec::<Value>::new();
    for line in text.lines().filter(|line| !line.trim().is_empty()) {
        if line.len() > MAX_RECORD_BYTES {
            return Err("Pi record exceeds the read limit".into());
        }
        rows.push(serde_json::from_str(line).map_err(|_| "Malformed Pi session record")?);
    }
    let header = rows
        .first()
        .filter(|row| row["type"] == "session" && row["id"] == session_id)
        .ok_or("Pi session identity changed")?;
    let version = session_version(header)?;
    if !matches!(version, 1..=3) {
        return Err("Unsupported Pi session version".into());
    }
    let mut by_id = HashMap::new();
    let mut previous: Option<String> = None;
    for (index, entry) in rows.iter_mut().enumerate().skip(1) {
        if version == 1 {
            entry["id"] = format!("legacy-{index}").into();
            entry["parentId"] = json!(previous);
        }
        let id = entry["id"]
            .as_str()
            .ok_or("Pi session entry has no ID")?
            .to_owned();
        if by_id.insert(id.clone(), index).is_some() {
            return Err("Duplicate Pi session entry ID".into());
        }
        previous = Some(id);
    }
    let mut chain = Vec::new();
    let mut seen = HashSet::new();
    let mut current = rows.len().checked_sub(1).filter(|index| *index > 0);
    while let Some(index) = current {
        if !seen.insert(index) {
            return Err("Pi session contains a parent cycle".into());
        }
        chain.push(index);
        current = match rows[index].get("parentId") {
            None | Some(Value::Null) => None,
            Some(Value::String(parent)) => Some(
                *by_id
                    .get(parent)
                    .ok_or("Pi session parent is missing; history is incomplete")?,
            ),
            _ => return Err("Invalid Pi session parent ID".into()),
        };
    }
    chain.reverse();
    let mut edits = HashMap::new();
    for &index in &chain {
        let entry = &rows[index];
        if entry["type"] == "context_edit" {
            let target = entry["targetId"]
                .as_str()
                .ok_or("Pi context edit has no target")?;
            if !by_id
                .get(target)
                .is_some_and(|target| seen.contains(target) && *target < index)
            {
                return Err("Pi context edit target is not on the active branch".into());
            }
            let replacement = entry
                .get("replacement")
                .ok_or("Pi context edit has no replacement")?;
            if !replacement.is_null()
                && !replacement["content"].is_string()
                && !replacement["content"].is_array()
            {
                return Err("Invalid Pi context edit content".into());
            }
            edits.insert(target.to_owned(), replacement.clone());
        }
    }
    let mut turns = Vec::<ExternalSessionTurn>::new();
    let mut tools = HashMap::<String, (usize, usize)>::new();
    let mut warnings = BTreeSet::new();
    let mut pending = Vec::new();
    for index in chain {
        let entry = &rows[index];
        match entry["type"].as_str() {
            Some("compaction") => {
                warnings.insert("compaction_retained");
                continue;
            }
            Some("branch_summary") => {
                if let Some(text) = entry["summary"].as_str() {
                    let item = ExternalSessionItem::Text {
                        text: format!("[Pi branch summary]\n{text}"),
                    };
                    if let Some(turn) = turns.last_mut() {
                        turn.items.push(item);
                    } else {
                        pending.push(item);
                    }
                }
                continue;
            }
            Some(
                "model_change"
                | "thinking_level_change"
                | "session_info"
                | "label"
                | "usage"
                | "custom"
                | "context_edit",
            ) => continue,
            Some("message" | "custom_message") => {}
            _ => return Err("Unsupported Pi session entry type".into()),
        }
        let mut message = if entry["type"] == "custom_message" {
            json!({"role":"custom", "content":entry["content"], "display":entry["display"]})
        } else {
            entry["message"].clone()
        };
        if let Some(edit) = edits.get(entry["id"].as_str().unwrap_or_default()) {
            warnings.insert("context_edits_applied");
            if edit.is_null() {
                continue;
            }
            message["content"] = edit["content"].clone();
        }
        let content = &message["content"];
        match message["role"].as_str() {
            Some("system") => continue,
            Some("custom" | "hookMessage") => {
                warnings.insert("extension_context");
                if message["display"] == true {
                    let item = ExternalSessionItem::Text {
                        text: format!("[Pi extension message]\n{}", visible_text(content)),
                    };
                    if let Some(turn) = turns.last_mut() {
                        turn.items.push(item);
                    } else {
                        pending.push(item);
                    }
                }
                continue;
            }
            Some("user") => {
                if turns.len() >= 4096 {
                    return Err("Pi session exceeds the turn limit".into());
                }
                let clean = clean_content(content, &mut warnings)?;
                turns.push(ExternalSessionTurn {
                    source_turn_id: entry["id"].as_str().unwrap_or_default().into(),
                    timestamp: timestamp(&message["timestamp"])
                        .or_else(|| timestamp(&entry["timestamp"]))
                        .unwrap_or_default(),
                    user_text: visible_text(&clean),
                    items: std::mem::take(&mut pending),
                    source_event_count: 1,
                    status: ExternalSessionStatus::Interrupted,
                });
            }
            Some("assistant") => {
                let turn_index = turns
                    .len()
                    .checked_sub(1)
                    .ok_or("Pi assistant history has no user turn")?;
                let turn = &mut turns[turn_index];
                turn.source_event_count += 1;
                let blocks = if content.is_string() {
                    vec![json!({"type":"text","text":content})]
                } else {
                    content
                        .as_array()
                        .ok_or("Invalid Pi assistant content")?
                        .clone()
                };
                for block in blocks {
                    match block["type"].as_str() {
                        Some("text") => turn.items.push(ExternalSessionItem::Text {
                            text: block["text"]
                                .as_str()
                                .ok_or("Invalid Pi text block")?
                                .into(),
                        }),
                        Some("thinking") => turn.items.push(ExternalSessionItem::Thinking {
                            text: block["thinking"].as_str().unwrap_or_default().into(),
                        }),
                        Some("toolCall") => {
                            let id = block["id"]
                                .as_str()
                                .ok_or("Pi tool call has no ID")?
                                .to_owned();
                            if tools
                                .insert(id.clone(), (turn_index, turn.items.len()))
                                .is_some()
                            {
                                return Err("Duplicate Pi tool call ID".into());
                            }
                            turn.items.push(ExternalSessionItem::Tool {
                                id,
                                name: block["name"]
                                    .as_str()
                                    .ok_or("Pi tool call has no name")?
                                    .into(),
                                input: block["arguments"].clone(),
                                result: None,
                                success: None,
                            });
                        }
                        _ => return Err("Unsupported Pi assistant content block".into()),
                    }
                }
                turn.status = if message["stopReason"] == "stop" {
                    ExternalSessionStatus::Complete
                } else {
                    ExternalSessionStatus::Interrupted
                };
                if let Some(error) = message["errorMessage"].as_str() {
                    warnings.insert("source_turn_error");
                    turn.items.push(ExternalSessionItem::Text {
                        text: format!("[Pi source error]\n{error}"),
                    });
                }
            }
            Some("toolResult") => {
                let id = message["toolCallId"]
                    .as_str()
                    .ok_or("Pi tool result has no call ID")?;
                let &(turn, item) = tools.get(id).ok_or("Pi tool result has no matching call")?;
                let output = clean_content(content, &mut warnings)?;
                if let ExternalSessionItem::Tool {
                    result, success, ..
                } = &mut turns[turn].items[item]
                {
                    if result.is_some() {
                        return Err("Duplicate Pi tool result".into());
                    }
                    *result = Some(output);
                    *success = Some(message["isError"] != true);
                }
                turns[turn].source_event_count += 1;
            }
            Some("bashExecution") => {
                if message["excludeFromContext"] == true {
                    warnings.insert("excluded_command");
                    continue;
                }
                let command = message["command"]
                    .as_str()
                    .ok_or("Pi shell record has no command")?;
                let success = message["exitCode"]
                    .as_i64()
                    .map(|code| code == 0 && message["cancelled"] != true);
                turns.push(ExternalSessionTurn {
                    source_turn_id: entry["id"].as_str().unwrap_or_default().into(),
                    timestamp: timestamp(&message["timestamp"]).unwrap_or_default(),
                    user_text: format!("Ran `{command}`"),
                    items: vec![ExternalSessionItem::Tool {
                        id: entry["id"].as_str().unwrap_or_default().into(),
                        name: "bash".into(),
                        input: json!({"command":command}),
                        result: Some(
                            json!({"output":message["output"],"exit_code":message["exitCode"]}),
                        ),
                        success,
                    }],
                    source_event_count: 1,
                    status: if success == Some(true) {
                        ExternalSessionStatus::Complete
                    } else {
                        ExternalSessionStatus::Interrupted
                    },
                });
            }
            _ => return Err("Unsupported Pi message role".into()),
        }
    }
    if turns.is_empty() {
        return Err("Pi session has no usable human conversation".into());
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
        return Err("Converted Pi history exceeds the read limit".into());
    }
    Ok((turns, warnings.into_iter().map(|code| warning(code, match code {
        "compaction_retained" => "Pi compacted the active branch; the full import retains available earlier conversation instead of adding duplicate summary turns.",
        "context_edits_applied" => "Saved Pi context edits were applied to the active branch without modifying the source.",
        "attachments_not_imported" => "Attachment payloads remain in Pi and are not copied or opened.",
        "extension_context" => "Visible extension messages are shown as source notes; hidden extension context is omitted.",
        "excluded_command" => "Shell commands explicitly excluded from Pi model context are omitted.",
        _ => "The Pi source includes an interrupted or failed turn.",
    })).collect()))
}

fn clean_content(content: &Value, warnings: &mut BTreeSet<&str>) -> Result<Value, String> {
    if content.is_string() {
        return Ok(content.clone());
    }
    let blocks = content.as_array().ok_or("Invalid Pi message content")?;
    Ok(Value::Array(
        blocks
            .iter()
            .map(|block| match block["type"].as_str() {
                Some("text") if block["text"].is_string() => {
                    Ok(json!({"type":"text","text":block["text"]}))
                }
                Some("image") => {
                    warnings.insert("attachments_not_imported");
                    Ok(json!({"type":"text","text":"[Attachment retained in Pi]"}))
                }
                _ => Err("Unsupported Pi message content block".into()),
            })
            .collect::<Result<Vec<_>, String>>()?,
    ))
}

fn visible_text(content: &Value) -> String {
    content.as_str().map(str::to_owned).unwrap_or_else(|| {
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
    })
}

fn session_version(header: &Value) -> Result<u64, String> {
    match header.get("version") {
        None => Ok(1), // The original Pi format predates the explicit version field.
        Some(value) => value
            .as_u64()
            .ok_or_else(|| "Invalid Pi session version".into()),
    }
}

fn timestamp(value: &Value) -> Option<u64> {
    value.as_u64().or_else(|| {
        value
            .as_str()
            .and_then(|value| chrono::DateTime::parse_from_rfc3339(value).ok())
            .and_then(|date| u64::try_from(date.timestamp_millis()).ok())
    })
}

fn warning(code: &str, detail: &str) -> ExternalSessionImportWarning {
    ExternalSessionImportWarning {
        code: code.into(),
        detail: detail.into(),
    }
}

#[cfg(test)]
mod tests;
