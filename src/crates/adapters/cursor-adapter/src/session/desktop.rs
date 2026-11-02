//! Cursor Desktop's ordered composer/bubble records, including legacy inline history.
use super::*;

pub(super) fn discover(
    root: &Path,
    warnings: &mut Vec<ExternalSessionImportWarning>,
) -> Result<Vec<Source>, String> {
    validate_root(root)?;
    let path = root.join("User/globalStorage/state.vscdb");
    if !path.exists() {
        return Ok(Vec::new());
    }
    let result = discover_database(root, &path, warnings);
    match result {
        Ok(sources) => Ok(sources),
        Err(error) => {
            diagnostic(warnings, "desktop_unreadable", &error);
            Ok(Vec::new())
        }
    }
}

fn discover_database(
    root: &Path,
    path: &Path,
    warnings: &mut Vec<ExternalSessionImportWarning>,
) -> Result<Vec<Source>, String> {
    let connection = store::open(path)?;
    let has_headers = has_headers(&connection)?;
    let mut statement = connection
        .prepare(
            "SELECT key FROM cursorDiskKV WHERE key GLOB 'composerData:*' ORDER BY key LIMIT ?1",
        )
        .map_err(|e| format!("Unsupported Cursor Desktop history database: {e}"))?;
    let keys = statement
        .query_map([MAX_SESSIONS + 1], |row| row.get::<_, String>(0))
        .map_err(|e| e.to_string())?;
    let mut sources = Vec::new();
    for (index, key) in keys.enumerate() {
        if index == MAX_SESSIONS {
            return Err("Cursor Desktop session catalog exceeds the discovery limit".into());
        }
        let key = key.map_err(|e| e.to_string())?;
        let parsed = metadata(&connection, &key, has_headers)
            .and_then(|metadata| inspect(root, path, &key, metadata));
        match parsed {
            Ok(Some(source)) => sources.push(source),
            Ok(None) => {}
            Err(error) => diagnostic(warnings, "desktop_session_unreadable", &error),
        }
    }
    Ok(sources)
}

fn has_headers(connection: &rusqlite::Connection) -> Result<bool, String> {
    connection
        .query_row(
            "SELECT EXISTS(SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = 'composerHeaders')",
            [],
            |row| row.get(0),
        )
        .map_err(|e| e.to_string())
}

fn metadata(
    connection: &rusqlite::Connection,
    key: &str,
    has_headers: bool,
) -> Result<Value, String> {
    let composer = store::json_row(connection, "cursorDiskKV", key)?
        .ok_or("Cursor composer was removed; refresh the list")?;
    let header = if has_headers {
        store::json_row(
            connection,
            "composerHeaders",
            key.strip_prefix("composerData:")
                .ok_or("Invalid Cursor composer key")?,
        )?
    } else {
        None
    };
    // Current Desktop versions keep workspace identity in a separate header.
    // Retain both records for fingerprinting and the read-time snapshot check.
    Ok(serde_json::json!({ "composer": composer, "header": header }))
}

fn inspect(root: &Path, path: &Path, key: &str, metadata: Value) -> Result<Option<Source>, String> {
    let id = key
        .strip_prefix("composerData:")
        .filter(|id| valid_id(id))
        .ok_or("Invalid Cursor composer ID")?;
    let composer = &metadata["composer"];
    let header = &metadata["header"];
    if composer["isDraft"] == true
        || header["isDraft"] == true
        || composer["isEphemeral"] == true
        || id.starts_with("task-")
        || composer.pointer("/subagentInfo/parentComposerId").is_some()
        || header.pointer("/subagentInfo/parentComposerId").is_some()
    {
        return Ok(None);
    }
    if [composer, header].iter().any(|record| {
        record["composerId"]
            .as_str()
            .is_some_and(|stored| stored != id)
    }) {
        return Err("Cursor composer identity does not match its storage key".into());
    }
    if composer["_v"].as_u64().is_some_and(|version| version > 18) {
        return Err("Unsupported Cursor Desktop composer version".into());
    }
    let count = composer["fullConversationHeadersOnly"]
        .as_array()
        .or_else(|| composer["conversation"].as_array())
        .ok_or("Cursor Desktop history has no supported conversation order")?
        .len();
    if count == 0 {
        return Ok(None);
    }
    let mut candidate = candidate(id, path, "cursor-desktop-composer-sqlite");
    candidate.title = header["name"]
        .as_str()
        .filter(|name| !name.trim().is_empty())
        .or_else(|| composer["name"].as_str())
        .filter(|name| !name.trim().is_empty())
        .map(str::to_owned);
    candidate.title_is_source_name = candidate.title.is_some();
    candidate.created_at =
        timestamp(&composer["createdAt"]).or_else(|| timestamp(&header["createdAt"]));
    candidate.updated_at = timestamp(&header["lastUpdatedAt"])
        .or_else(|| timestamp(&composer["lastUpdatedAt"]))
        .or(candidate.created_at);
    candidate.model_name = composer
        .pointer("/modelConfig/modelName")
        .and_then(Value::as_str)
        .map(str::to_owned);
    let workspace = header
        .get("workspaceIdentifier")
        .filter(|value| !value.is_null())
        .unwrap_or(&composer["workspaceIdentifier"]);
    candidate.cwd = uri_path(&workspace["uri"]);
    // Workspace identifiers are opaque. Only an actual workspace.json folder
    // URI can resolve an older ID; .code-workspace and remote URIs stay unresolved.
    if candidate.cwd.is_none() && workspace["uri"].is_null() {
        if let Some(id) = workspace["id"].as_str().filter(|id| valid_id(id)) {
            let workspace = root
                .join("User/workspaceStorage")
                .join(id)
                .join("workspace.json");
            if workspace.exists() {
                let value: Value = serde_json::from_str(&bounded_text(&workspace, 64 * 1024)?)
                    .map_err(|_| "Invalid Cursor workspace metadata")?;
                candidate.cwd = uri_path(&value["folder"]);
            }
        }
    }
    candidate.fingerprint = format!(
        "sha256:{}",
        hex::encode(Sha256::digest(
            serde_json::to_vec(&metadata).map_err(|e| e.to_string())?
        ))
    );
    candidate.file_size_bytes = std::fs::metadata(path).map_err(|e| e.to_string())?.len();
    Ok(Some(Source {
        candidate,
        location: Location::Desktop(path.into()),
        metadata,
    }))
}

pub(super) fn read(source: Source) -> Result<ExternalSessionDocument, String> {
    let Location::Desktop(path) = &source.location else {
        unreachable!()
    };
    let connection = store::open(path)?;
    let id = &source.candidate.source_session_id;
    let metadata = metadata(
        &connection,
        &format!("composerData:{id}"),
        has_headers(&connection)?,
    )?;
    if metadata != source.metadata {
        return Err("Cursor conversation changed during discovery; refresh the list".into());
    }
    let mut fingerprint = Sha256::new();
    fingerprint.update(serde_json::to_vec(&metadata).map_err(|e| e.to_string())?);
    let mut builder = translate::Builder::new(source.candidate.clone());
    let mut bytes = 0usize;
    let composer = &metadata["composer"];
    if let Some(headers) = composer["fullConversationHeadersOnly"].as_array() {
        if headers.len() > 200_000 {
            return Err("Cursor history exceeds the message limit".into());
        }
        for header in headers {
            let bubble_id = header["bubbleId"]
                .as_str()
                .filter(|id| valid_id(id))
                .ok_or("Cursor history header has no valid bubble ID")?;
            let bubble = if let Some(inline) = composer["conversationMap"].get(bubble_id) {
                inline.clone()
            } else {
                store::json_row(
                    &connection,
                    "cursorDiskKV",
                    &format!("bubbleId:{id}:{bubble_id}"),
                )?
                .ok_or(
                    "Cursor history references a missing bubble; no partial import was created",
                )?
            };
            consume(
                &mut builder,
                &bubble,
                bubble_id,
                &mut bytes,
                &mut fingerprint,
            )?;
        }
    } else if let Some(conversation) = composer["conversation"].as_array() {
        for (index, bubble) in conversation.iter().enumerate() {
            let fallback = format!("legacy-{index}");
            let bubble_id = bubble["bubbleId"].as_str().unwrap_or(&fallback);
            consume(
                &mut builder,
                bubble,
                bubble_id,
                &mut bytes,
                &mut fingerprint,
            )?;
        }
    } else {
        return Err("Cursor history has no supported conversation order".into());
    }
    builder.warn("desktop_storage_projection", "Cursor Desktop may strip file contents and other result details before saving; only stored data was imported");
    if !composer["createdFromBackgroundAgent"].is_null() {
        builder.warn(
            "cloud_history_projection",
            "Only locally cached Cursor cloud-agent messages are available",
        );
    }
    builder.finish(&fingerprint.finalize())
}

fn consume(
    builder: &mut translate::Builder,
    bubble: &Value,
    id: &str,
    bytes: &mut usize,
    fingerprint: &mut Sha256,
) -> Result<(), String> {
    let encoded = serde_json::to_vec(bubble).map_err(|e| e.to_string())?;
    *bytes = bytes.saturating_add(encoded.len());
    if *bytes > MAX_FILE_BYTES {
        return Err("Cursor Desktop history exceeds the read limit".into());
    }
    fingerprint.update(id.as_bytes());
    fingerprint.update(encoded);
    if bubble["isSimulatedMsg"] == true
        || bubble["skipRendering"] == true
        || bubble["isDisplayOnly"] == true
    {
        return Ok(());
    }
    let text = bubble["text"].as_str().unwrap_or("");
    match bubble["type"].as_u64() {
        Some(1) => {
            let text = if text.is_empty()
                && bubble["images"]
                    .as_array()
                    .is_some_and(|images| !images.is_empty())
            {
                "[Image attachment omitted]"
            } else {
                text
            };
            if !text.is_empty() {
                builder.start(id.into(), text.into(), timestamp(&bubble["createdAt"]))?;
            }
        }
        Some(2) => {
            if let Some(thinking) = bubble["thinking"]["text"]
                .as_str()
                .filter(|s| !s.is_empty())
            {
                builder.item(ExternalSessionItem::Thinking {
                    text: thinking.into(),
                })?;
            }
            if !text.is_empty() {
                builder.item(ExternalSessionItem::Text { text: text.into() })?;
                builder.status(ExternalSessionStatus::Complete);
            }
            if let Some(tool) = bubble
                .get("toolFormerData")
                .filter(|value| !value.is_null())
            {
                let name = tool["name"]
                    .as_str()
                    .or_else(|| tool["tool"].as_str())
                    .map(str::to_owned)
                    .unwrap_or_else(|| tool_name(tool["tool"].as_u64()));
                let input = tool
                    .get("rawArgs")
                    .filter(|value| value.as_str().is_some_and(|text| !text.trim().is_empty()))
                    .or_else(|| tool.get("params"))
                    .map(decoded_value)
                    .transpose()?
                    .unwrap_or(Value::Null);
                let saved_result = tool.get("result").filter(|value| !value.is_null());
                let additional = tool.get("additionalData").filter(|value| !value.is_null());
                if saved_result.is_none() && additional.is_some() {
                    builder.warn("desktop_tool_projection", "Some Cursor tools save a display projection instead of a full result; the stored projection was retained");
                }
                let result = saved_result.or(additional).map(decoded_value).transpose()?;
                let status = tool["status"].as_str().unwrap_or("");
                let success = match status {
                    "error" | "failed" | "cancelled" | "aborted" => Some(false),
                    "completed" => Some(true),
                    _ => None,
                };
                builder.item(ExternalSessionItem::Tool {
                    id: tool["toolCallId"]
                        .as_str()
                        .filter(|id| !id.is_empty())
                        .unwrap_or(id)
                        .into(),
                    name,
                    input,
                    result,
                    success,
                })?;
                if matches!(
                    status,
                    "error" | "failed" | "cancelled" | "aborted" | "loading" | "running"
                ) {
                    builder.status(ExternalSessionStatus::Interrupted);
                }
            }
            if !bubble["errorDetails"].is_null() {
                builder.status(ExternalSessionStatus::Interrupted);
            }
        }
        _ => return Err("Unsupported Cursor Desktop bubble type".into()),
    }
    Ok(())
}

fn decoded_value(value: &Value) -> Result<Value, String> {
    // Protobuf JSON fields were serialized as JSON strings by Cursor's storage
    // serializer. Preserve plain text outputs; never evaluate binary tool calls.
    if let Some(text) = value.as_str() {
        if text.starts_with('{') || text.starts_with('[') {
            return serde_json::from_str(text)
                .map_err(|_| "Invalid Cursor serialized tool data".into());
        }
    }
    Ok(value.clone())
}

fn tool_name(number: Option<u64>) -> String {
    // Stable ClientSideToolV2 enum values used by Cursor's composer store.
    let name = match number {
        Some(1) => "read_semsearch_files",
        Some(3) => "ripgrep_search",
        Some(5) => "read_file",
        Some(6) => "list_dir",
        Some(7) => "edit_file",
        Some(8) => "file_search",
        Some(9) => "codebase_search",
        Some(11) => "delete_file",
        Some(15) => "run_terminal_cmd",
        Some(18) => "web_search",
        Some(19) => "mcp",
        Some(30) => "read_lints",
        Some(32 | 48) => "task",
        Some(34) => "todo_read",
        Some(35) => "todo_write",
        Some(38) => "edit_file_v2",
        Some(39) => "list_dir_v2",
        Some(40) => "read_file_v2",
        Some(41) => "ripgrep_raw_search",
        Some(42) => "glob_file_search",
        Some(43) => "create_plan",
        Some(51) => "ask_question",
        _ => {
            return format!(
                "CursorTool-{}",
                number
                    .map(|n| n.to_string())
                    .unwrap_or_else(|| "unknown".into())
            )
        }
    };
    name.into()
}
