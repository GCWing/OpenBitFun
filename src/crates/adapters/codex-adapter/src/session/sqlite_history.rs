//! Read Codex's projected ThreadItem history without starting its runtime or
//! modifying its databases. The state catalog and history store are separate.
use super::*;
use rusqlite::{params, Connection, OpenFlags};
use std::time::Duration;

pub(super) struct Thread {
    pub candidate: ExternalSessionCandidate,
    pub rollout_path: Option<String>,
    pub directory: PathBuf,
    pub subagent: bool,
}

impl Thread {
    pub(super) fn matches_locator(&self, locator: &str) -> bool {
        self.candidate.candidate_id == locator
            || self.rollout_path.as_deref().is_some_and(|path| {
                // Keep already-persisted file locators usable after Codex has
                // migrated their bodies and removed the old JSONL files.
                candidate_id(Path::new(path)) == locator
                    || candidate_id(Path::new(path.strip_prefix("\\\\?\\").unwrap_or(path)))
                        == locator
            })
    }
}

fn database_path(directory: &Path) -> Result<PathBuf, String> {
    for entry in fs::read_dir(directory).map_err(|error| error.to_string())? {
        let entry = entry.map_err(|error| error.to_string())?;
        let filename = entry.file_name();
        if filename
            .to_string_lossy()
            .strip_prefix("thread_history_")
            .and_then(|name| name.strip_suffix(".sqlite"))
            .and_then(|version| version.parse::<u32>().ok())
            .is_some_and(|version| version > 1)
        {
            return Err("Unsupported Codex paginated history database version; no partial import was created".into());
        }
    }
    let path = directory.join("thread_history_1.sqlite");
    if !path.is_file() {
        return Err(
            "Codex paginated history database is unavailable; the source session was preserved"
                .into(),
        );
    }
    Ok(path)
}

fn read_error(error: rusqlite::Error) -> String {
    format!("Codex paginated history cannot be read: {error}")
}

fn hash_value(hasher: &mut Sha256, value: &[u8]) {
    hasher.update((value.len() as u64).to_le_bytes());
    hasher.update(value);
}

pub(super) fn read(
    thread: &Thread,
    mode: ExternalSessionImportMode,
    titles: &TitleSnapshot,
) -> Result<CodexSessionDocument, String> {
    let connection = Connection::open_with_flags(
        database_path(&thread.directory)?,
        OpenFlags::SQLITE_OPEN_READ_ONLY | OpenFlags::SQLITE_OPEN_NO_MUTEX,
    )
    .map_err(read_error)?;
    connection
        .busy_timeout(Duration::from_secs(2))
        .map_err(read_error)?;
    // A read transaction sees one committed snapshot, including WAL. immutable
    // would miss recent records, and reading a whole DB would expose other chats.
    connection
        .execute_batch("PRAGMA query_only = ON; BEGIN DEFERRED TRANSACTION;")
        .map_err(read_error)?;
    let id = &thread.candidate.source_session_id;
    let (item_count, source_bytes, max_item): (u64, u64, u64) = connection
        .query_row(
            "SELECT COUNT(*), COALESCE(SUM(length(CAST(item_json AS BLOB))), 0),
            COALESCE(MAX(length(CAST(item_json AS BLOB))), 0)
         FROM thread_items WHERE thread_id = ?1",
            [id],
            |row| Ok((row.get(0)?, row.get(1)?, row.get(2)?)),
        )
        .map_err(read_error)?;
    if source_bytes > MAX_FILE_BYTES {
        return Err("Source exceeds the 256 MiB import limit".into());
    }
    if max_item > MAX_LINE_BYTES as u64 {
        return Err("Codex history item exceeds the 8 MiB import limit".into());
    }
    let mut turn_query = connection
        .prepare(
            "SELECT turn_id, status, started_at, error_json FROM thread_turns
         WHERE thread_id = ?1 ORDER BY rollout_ordinal, turn_id LIMIT ?2",
        )
        .map_err(read_error)?;
    let stored_turns = turn_query
        .query_map(params![id, MAX_TURNS as i64 + 1], |row| {
            Ok((
                row.get::<_, String>(0)?,
                row.get::<_, String>(1)?,
                row.get::<_, Option<i64>>(2)?,
                row.get::<_, Option<String>>(3)?,
            ))
        })
        .map_err(read_error)?
        .collect::<Result<Vec<_>, _>>()
        .map_err(read_error)?;
    if stored_turns.len() > MAX_TURNS {
        return Err("Conversation exceeds the 4096 turn import limit".into());
    }
    let mut item_query = connection
        .prepare(
            "SELECT item_id, created_at_ms, item_json FROM thread_items
         WHERE thread_id = ?1 AND turn_id = ?2 ORDER BY rollout_ordinal, item_id",
        )
        .map_err(read_error)?;
    let mut turns = Vec::new();
    let mut warnings = BTreeSet::new();
    let mut diagnostics = titles.diagnostics.clone();
    let mut hasher = Sha256::new();
    let mut read_items = 0u64;
    let mut converted_bytes = 0usize;
    for (turn_id, status, started_at, error) in stored_turns {
        hash_value(
            &mut hasher,
            serde_json::to_string(&(&turn_id, &status, started_at, &error))
                .map_err(|error| error.to_string())?
                .as_bytes(),
        );
        let status = match status.as_str() {
            "completed" => ExternalSessionStatus::Complete,
            "inProgress" | "interrupted" | "failed" => ExternalSessionStatus::Interrupted,
            _ => return Err(format!("Unsupported Codex turn status: {status}")),
        };
        if let Some(error) = error.filter(|error| error != "null") {
            if diagnostics.len() < 20 {
                diagnostics.push(warning("source_turn_error", &error));
            }
        }
        let time = started_at
            .and_then(|time| u64::try_from(time).ok())
            .and_then(|time| time.checked_mul(1000))
            .or(thread.candidate.created_at)
            .unwrap_or(0);
        let mut turn = empty_turn(turn_id.clone(), time, status);
        let mut rows = item_query.query(params![id, turn_id]).map_err(read_error)?;
        while let Some(row) = rows.next().map_err(read_error)? {
            let item_id: String = row.get(0).map_err(read_error)?;
            let created_at: Option<u64> = row.get(1).map_err(read_error)?;
            let raw: String = row.get(2).map_err(read_error)?;
            hash_value(&mut hasher, item_id.as_bytes());
            hash_value(&mut hasher, &created_at.unwrap_or(time).to_le_bytes());
            hash_value(&mut hasher, raw.as_bytes());
            read_items += 1;
            let item: Value = serde_json::from_str(&raw)
                .map_err(|_| "Malformed Codex history item; no partial import was created")?;
            let kind = item["type"]
                .as_str()
                .ok_or("Codex history item type is missing")?;
            if item["id"].as_str() != Some(item_id.as_str()) {
                return Err("Codex history item id does not match its database record".into());
            }
            if kind == "userMessage" {
                let text = user_text(&item["content"], &mut warnings)?;
                if is_injected(&text) {
                    warnings.insert("source_instructions_not_imported");
                    continue;
                }
                if !turn.user_text.is_empty() || !turn.items.is_empty() {
                    push_turn(&mut turns, turn, &mut converted_bytes)?;
                    turn = empty_turn(
                        format!("{turn_id}:{item_id}"),
                        created_at.unwrap_or(time),
                        status,
                    );
                }
                turn.user_text = text;
                turn.timestamp = created_at.unwrap_or(time);
            } else if let Some(projected) = project_item(&item, mode, &mut warnings)? {
                turn.items.push(projected);
            }
            turn.source_event_count += 1;
        }
        if !turn.user_text.is_empty() || !turn.items.is_empty() {
            push_turn(&mut turns, turn, &mut converted_bytes)?;
        }
    }
    if read_items != item_count {
        return Err("Codex paginated history contains items without a readable turn; no partial import was created".into());
    }
    if turns.is_empty() {
        return Err("No usable human conversation was found in Codex paginated history".into());
    }
    if mode == ExternalSessionImportMode::LatestCompacted
        && !warnings.contains("compaction_present")
    {
        warnings.insert("no_compaction");
    }
    let mut candidate = thread.candidate.clone();
    titles.apply(&mut candidate);
    candidate.file_size_bytes = source_bytes;
    candidate.fingerprint = format!("sha256:{}", hex::encode(hasher.finalize()));
    candidate.turn_count = Some(turns.len());
    candidate.status = turns.last().unwrap().status;
    diagnostics.extend(warnings.into_iter().map(|code| warning(code, code)));
    Ok(CodexSessionDocument {
        candidate,
        turns,
        warnings: diagnostics,
    })
}

fn empty_turn(id: String, timestamp: u64, status: ExternalSessionStatus) -> ExternalSessionTurn {
    ExternalSessionTurn {
        source_turn_id: id,
        timestamp,
        user_text: String::new(),
        items: Vec::new(),
        source_event_count: 0,
        status,
    }
}

fn push_turn(
    turns: &mut Vec<ExternalSessionTurn>,
    turn: ExternalSessionTurn,
    bytes: &mut usize,
) -> Result<(), String> {
    if turns.len() >= MAX_TURNS {
        return Err("Conversation exceeds the 4096 turn import limit".into());
    }
    *bytes += serde_json::to_vec(&turn)
        .map_err(|error| error.to_string())?
        .len();
    if *bytes > MAX_DOCUMENT_BYTES {
        return Err("Converted history exceeds the 128 MiB storage budget".into());
    }
    turns.push(turn);
    Ok(())
}

fn user_text(content: &Value, warnings: &mut BTreeSet<&'static str>) -> Result<String, String> {
    let mut parts = Vec::new();
    for part in content
        .as_array()
        .ok_or("Codex user message content is not an array")?
    {
        match part["type"].as_str().unwrap_or("") {
            "text" => parts.push(
                part["text"]
                    .as_str()
                    .ok_or("Codex user text is missing")?
                    .to_owned(),
            ),
            "image" | "localImage" | "file" | "skill" | "mention" => {
                warnings.insert("attachments_not_imported");
                // Keep the reference visible without reading arbitrary source
                // files, copying credentials, or activating skills/mentions.
                parts.push(format!("[Codex attachment: {}]", part));
            }
            kind => return Err(format!("Unsupported Codex user content type: {kind}")),
        }
    }
    Ok(parts.join("\n"))
}

fn tool_success(item: &Value) -> Result<Option<bool>, String> {
    match item["status"].as_str() {
        Some("completed") => Ok(Some(
            item["success"] != false
                && item["error"].is_null()
                && item["failure"].is_null()
                && item["exitCode"].as_i64().is_none_or(|code| code == 0),
        )),
        Some("failed" | "declined" | "interrupted") => Ok(Some(false)),
        Some("inProgress") | None => Ok(None),
        Some("generating") if item["type"] == "imageGeneration" => Ok(None),
        Some(status) => Err(format!("Unsupported Codex tool status: {status}")),
    }
}

fn project_item(
    item: &Value,
    mode: ExternalSessionImportMode,
    warnings: &mut BTreeSet<&'static str>,
) -> Result<Option<ExternalSessionItem>, String> {
    let kind = item["type"].as_str().unwrap_or("");
    match kind {
        "agentMessage" | "plan" => {
            return Ok(Some(ExternalSessionItem::Text {
                text: item["text"]
                    .as_str()
                    .ok_or("Codex agent text is missing")?
                    .to_owned(),
            }))
        }
        "reasoning" => {
            let mut parts = Vec::new();
            for key in ["summary", "content"] {
                if let Some(items) = item[key].as_array() {
                    for text in items {
                        parts.push(text.as_str().ok_or("Unsupported Codex reasoning content")?);
                    }
                }
            }
            return Ok((!parts.is_empty()).then(|| ExternalSessionItem::Thinking {
                text: parts.join("\n"),
            }));
        }
        "contextCompaction" => {
            warnings.insert("compaction_present");
            if mode == ExternalSessionImportMode::LatestCompacted {
                return Err("Codex paginated history has no readable compaction replacement; select full history to preserve readable conversation".into());
            }
            return Ok(None);
        }
        _ => {}
    }
    let success = tool_success(item)?;
    let (name, input, result) = match kind {
        "commandExecution" => (
            "exec_command".into(),
            json!({"cmd":item["command"],"workdir":item["cwd"]}),
            (success.is_some() || !item["aggregatedOutput"].is_null()).then(|| {
                json!({
                "output":item["aggregatedOutput"],"exit_code":item["exitCode"],
                "wall_time_seconds":item["durationMs"].as_f64().map(|ms| ms / 1000.0),
                "session_id":item["processId"],"status":item["status"]})
            }),
        ),
        "fileChange" => (
            "apply_patch".into(),
            json!({"changes":item["changes"]}),
            success.map(|_| json!({"status":item["status"]})),
        ),
        "mcpToolCall" => (
            format!(
                "mcp__{}__{}",
                item["server"]
                    .as_str()
                    .ok_or("Codex MCP server is missing")?,
                item["tool"].as_str().ok_or("Codex MCP tool is missing")?
            ),
            item["arguments"].clone(),
            if !item["error"].is_null() {
                Some(json!({"error":item["error"],"result":item["result"],"is_error":true}))
            } else {
                item.get("result")
                    .filter(|result| !result.is_null())
                    .cloned()
            },
        ),
        "dynamicToolCall" => {
            let tool = item["tool"]
                .as_str()
                .ok_or("Codex dynamic tool name is missing")?;
            let name = item["namespace"]
                .as_str()
                .filter(|ns| !ns.is_empty())
                .map_or_else(|| tool.to_owned(), |ns| format!("{ns}.{tool}"));
            let output = item
                .get("contentItems")
                .filter(|value| !value.is_null())
                .map(|content| {
                    // ThreadItem uses inputText for its display blocks; the neutral
                    // tool renderer already understands the standard text blocks.
                    let mut content = content.clone();
                    if let Some(parts) = content.as_array_mut() {
                        for part in parts {
                            if part["type"] == "inputText" {
                                part["type"] = Value::String("text".into());
                            }
                        }
                    }
                    content
                });
            (name, item["arguments"].clone(), output)
        }
        "webSearch" => {
            let input = if item["action"]["type"] == "search" || item["action"].is_null() {
                let queries = item["action"]["queries"]
                    .as_array()
                    .cloned()
                    .unwrap_or_else(|| vec![item["query"].clone()]);
                json!({"search_query":queries.into_iter().map(|q| json!({"q":q})).collect::<Vec<_>>()})
            } else {
                json!({"query":item["query"],"action":item["action"]})
            };
            ("web.run".into(), input, item.get("results").cloned())
        }
        "imageView" => (
            "view_image".into(),
            json!({"path":item["path"]}),
            Some(json!({"path":item["path"]})),
        ),
        "imageGeneration" => {
            // result can contain megabytes of inline image data. Separate the
            // request from its output so one image is stored only once.
            let mut input = item
                .as_object()
                .cloned()
                .ok_or("Codex image generation item is invalid")?;
            let mut result = serde_json::Map::new();
            for key in ["result", "failure", "savedPath", "status"] {
                if let Some(value) = input.remove(key) {
                    result.insert(key.into(), value);
                }
            }
            (
                "codex.imageGeneration".into(),
                Value::Object(input),
                Some(Value::Object(result)),
            )
        }
        "sleep"
        | "subAgentActivity"
        | "collabAgentToolCall"
        | "hookPrompt"
        | "enteredReviewMode"
        | "exitedReviewMode" => {
            // These source records have no native runtime or permission state.
            // Preserve their complete payload as a non-executable history card.
            (format!("codex.{kind}"), item.clone(), Some(item.clone()))
        }
        _ => {
            return Err(format!(
                "Unsupported Codex history item type: {kind}; no partial import was created"
            ))
        }
    };
    Ok(Some(ExternalSessionItem::Tool {
        id: item["id"]
            .as_str()
            .ok_or("Codex tool id is missing")?
            .to_owned(),
        name,
        input,
        result,
        success,
    }))
}
