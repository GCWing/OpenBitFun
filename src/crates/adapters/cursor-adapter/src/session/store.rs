//! Cursor CLI's SQLite metadata and reachable JSON message blobs.
//! Only the small protobuf reference envelope is decoded here; tool payloads
//! stay in their original JSON representation.
use super::*;
use rusqlite::{Connection, OpenFlags, OptionalExtension};
use std::time::Duration;

pub(super) fn open(path: &Path) -> Result<Connection, String> {
    let metadata = std::fs::symlink_metadata(path)
        .map_err(|e| format!("Cursor database is unreadable: {e}"))?;
    if !metadata.is_file() || is_symlink_or_reparse(&metadata) {
        return Err("Cursor database must be a regular non-link file".into());
    }
    let connection = Connection::open_with_flags(
        path,
        OpenFlags::SQLITE_OPEN_READ_ONLY | OpenFlags::SQLITE_OPEN_NO_MUTEX,
    )
    .map_err(|error| format!("Cursor database is unreadable: {error}"))?;
    connection
        .busy_timeout(Duration::from_secs(2))
        .map_err(|e| e.to_string())?;
    connection
        .execute_batch("PRAGMA query_only = ON; BEGIN DEFERRED TRANSACTION;")
        .map_err(|e| e.to_string())?;
    Ok(connection)
}

pub(super) fn json_row(
    connection: &Connection,
    table: &str,
    key: &str,
) -> Result<Option<Value>, String> {
    let sql = match table {
        "cursorDiskKV" => "SELECT CASE WHEN length(CAST(value AS BLOB)) <= ?2 THEN CAST(value AS TEXT) END FROM cursorDiskKV WHERE key = ?1",
        "ItemTable" => "SELECT CASE WHEN length(CAST(value AS BLOB)) <= ?2 THEN CAST(value AS TEXT) END FROM ItemTable WHERE key = ?1",
        "composerHeaders" => "SELECT CASE WHEN length(CAST(value AS BLOB)) <= ?2 THEN CAST(value AS TEXT) END FROM composerHeaders WHERE composerId = ?1",
        _ => return Err("Unsupported Cursor history table".into()),
    };
    let row: Option<Option<String>> = connection
        .query_row(sql, rusqlite::params![key, MAX_RECORD_BYTES], |row| {
            row.get(0)
        })
        .optional()
        .map_err(|e| e.to_string())?;
    match row {
        None => Ok(None),
        Some(None) => Err("Cursor history record exceeds the read limit".into()),
        Some(Some(text)) => serde_json::from_str(&text)
            .map(Some)
            .map_err(|_| "Invalid Cursor history JSON record".into()),
    }
}

fn metadata(connection: &Connection) -> Result<Value, String> {
    let version: u32 = connection
        .query_row("PRAGMA user_version", [], |row| row.get(0))
        .map_err(|e| e.to_string())?;
    if version != 1 {
        return Err(format!("Unsupported Cursor CLI store version {version}"));
    }
    let value: Option<String> = connection
        .query_row(
            "SELECT CASE WHEN length(value) <= ?1 THEN value END FROM meta WHERE key = '0'",
            [512 * 1024],
            |row| row.get(0),
        )
        .map_err(|e| format!("Unsupported Cursor CLI metadata: {e}"))?;
    let bytes = hex::decode(value.ok_or("Cursor CLI metadata exceeds the read limit")?)
        .map_err(|_| "Invalid Cursor CLI metadata encoding")?;
    serde_json::from_slice(&bytes).map_err(|_| "Invalid Cursor CLI metadata JSON".into())
}

pub(super) fn inspect(path: &Path) -> Result<Option<Source>, String> {
    let connection = open(path)?;
    let metadata = metadata(&connection)?;
    if !metadata["subagentInfo"].is_null() {
        return Ok(None);
    }
    let id = metadata["agentId"]
        .as_str()
        .filter(|id| valid_id(id))
        .ok_or("Cursor CLI session ID is missing or invalid")?;
    let root_id = metadata["latestRootBlobId"]
        .as_str()
        .ok_or("Cursor CLI current history reference is missing")?;
    if root_id.is_empty() {
        return Ok(None);
    }
    let mut candidate = candidate(id, path, "cursor-cli-sqlite-v1");
    candidate.created_at = timestamp(&metadata["createdAt"]);
    candidate.model_name = metadata["lastUsedModel"].as_str().map(str::to_owned);
    candidate.title = metadata["name"]
        .as_str()
        .filter(|s| !s.is_empty() && *s != "New Agent")
        .map(str::to_owned);
    candidate.title_is_source_name = candidate.title.is_some();
    let sidecar = path.with_file_name("meta.json");
    match bounded_text(&sidecar, 64 * 1024) {
        Ok(text) => {
            let sidecar: Value = serde_json::from_str(&text)
                .map_err(|_| "Invalid Cursor CLI session metadata sidecar")?;
            if sidecar["schemaVersion"].as_u64().is_some_and(|v| v != 1) {
                return Err("Unsupported Cursor CLI metadata sidecar version".into());
            }
            if sidecar["isSubagent"] == true {
                return Ok(None);
            }
            candidate.cwd = sidecar["cwd"]
                .as_str()
                .filter(|path| Path::new(path).is_absolute())
                .map(str::to_owned);
            candidate.updated_at = timestamp(&sidecar["updatedAtMs"]);
            if let Some(title) = sidecar["title"]
                .as_str()
                .filter(|s| !s.is_empty() && *s != "New Agent")
            {
                candidate.title = Some(title.into());
                candidate.title_is_source_name = true;
            }
        }
        Err(_) if !sidecar.exists() => {}
        Err(error) => return Err(error),
    }
    if candidate.cwd.is_none() {
        let mut blobs = Blobs::new(&connection);
        let root = blobs.get_hex(root_id)?;
        let paths: Vec<_> = fields(&root)?
            .into_iter()
            .filter_map(|field| match field {
                Field::Bytes(9, bytes) => std::str::from_utf8(bytes)
                    .ok()
                    .and_then(|uri| uri_path(&Value::String(uri.into()))),
                _ => None,
            })
            .collect();
        if paths.len() == 1 {
            candidate.cwd = paths.into_iter().next();
        }
    }
    if candidate.title.is_none() {
        // Read only a bounded prompt prefix for an unnamed CLI session. Never
        // enumerate unrelated blobs or expand a conversation during discovery.
        let mut blobs = Blobs::new(&connection);
        let root = blobs.get_hex(root_id)?;
        for message in bytes_fields(&fields(&root)?, 1).into_iter().take(16) {
            let bytes = blobs.get(message)?;
            if blobs.bytes > 256 * 1024 {
                break;
            }
            let record: Value = serde_json::from_slice(&bytes)
                .map_err(|_| "Invalid Cursor discovery message JSON")?;
            if record["role"] == "user"
                && record
                    .pointer("/providerOptions/cursor/requestContextCompleteness")
                    .is_none()
                && record.pointer("/providerOptions/cursor/isSummary") != Some(&Value::Bool(true))
            {
                if let Some(text) = translate::user_text(&record) {
                    candidate.fallback_title = Some(text.chars().take(120).collect());
                    candidate.title = candidate.fallback_title.clone();
                    break;
                }
            }
        }
    }
    let file = std::fs::metadata(path).map_err(|e| e.to_string())?;
    candidate.updated_at = candidate.updated_at.or_else(|| {
        file.modified()
            .ok()
            .and_then(|t| t.duration_since(UNIX_EPOCH).ok())
            .map(|t| t.as_millis() as u64)
    });
    candidate.file_size_bytes = file.len();
    candidate.fingerprint = format!(
        "sha256:{}",
        hex::encode(Sha256::digest(
            serde_json::to_vec(&metadata).map_err(|e| e.to_string())?
        ))
    );
    Ok(Some(Source {
        candidate,
        location: Location::Cli(path.into()),
        metadata,
    }))
}

pub(super) fn read(source: Source) -> Result<ExternalSessionDocument, String> {
    let Location::Cli(path) = &source.location else {
        unreachable!()
    };
    let connection = open(path)?;
    let meta = metadata(&connection)?;
    if meta["agentId"] != source.candidate.source_session_id {
        return Err("Cursor CLI session identity changed; refresh the list".into());
    }
    let mut blobs = Blobs::new(&connection);
    let root = blobs.get_hex(
        meta["latestRootBlobId"]
            .as_str()
            .ok_or("Cursor CLI history reference is missing")?,
    )?;
    let root_fields = fields(&root)?;
    let mut message_ids = Vec::new();
    let mut archives = bytes_fields(&root_fields, 13);
    if archives.is_empty() {
        archives = bytes_fields(&root_fields, 11);
    }
    for archive_id in &archives {
        let archive = blobs.get(archive_id)?;
        for message_id in bytes_fields(&fields(&archive)?, 1) {
            message_ids.push(message_id.to_vec());
        }
    }
    message_ids.extend(
        bytes_fields(&root_fields, 1)
            .into_iter()
            .map(<[u8]>::to_vec),
    );
    if message_ids.is_empty() {
        return Err(
            "Cursor CLI history has no readable JSON messages; this store layout is unsupported"
                .into(),
        );
    }
    if message_ids.len() > 200_000 {
        return Err("Cursor history exceeds the message limit".into());
    }
    // Read source turn identities and timestamps from the same current root.
    let mut turn_info = HashMap::new();
    for turn_id in bytes_fields(&root_fields, 8) {
        let turn = blobs.get(turn_id)?;
        let turn_fields = fields(&turn)?;
        if let Some(agent_turn) = bytes_fields(&turn_fields, 1).first() {
            let agent_fields = fields(agent_turn)?;
            let request_id = field_text(&agent_fields, 3);
            if let Some(user_id) = bytes_fields(&agent_fields, 1).first() {
                let user = blobs.get(user_id)?;
                let user_fields = fields(&user)?;
                let time = user_fields.iter().find_map(|f| match f {
                    Field::Varint(25, time) => Some(*time),
                    _ => None,
                });
                turn_info.insert(request_id, (field_text(&user_fields, 2), time));
            }
        }
    }
    let mut builder = translate::Builder::new(source.candidate);
    if !archives.is_empty() {
        builder.warn(
            "source_compacted",
            "Cursor summary archives were expanded without importing generated summary prompts",
        );
    }
    for (index, message_id) in message_ids.iter().enumerate() {
        let bytes = blobs.get(message_id)?;
        let mut record: Value = serde_json::from_slice(&bytes)
            .map_err(|_| "Cursor referenced message is not valid JSON")?;
        if record["role"] == "system" {
            if let Some(model) = record
                .pointer("/providerOptions/cursor/systemPromptFingerprint/model")
                .and_then(Value::as_str)
            {
                builder.model(model);
            }
        }
        let request_id = record
            .pointer("/providerOptions/cursor/requestId")
            .and_then(Value::as_str)
            .unwrap_or("");
        if let Some((id, time)) = turn_info
            .get(request_id)
            .filter(|_| record["role"] == "user")
        {
            if !id.is_empty() {
                record["id"] = Value::String(id.clone());
            }
            if let Some(time) = time {
                record["createdAt"] = Value::from(*time);
            }
        }
        builder.message(
            &record,
            &format!("message-{index}-{}", hex::encode(message_id)),
        )?;
    }
    builder.finish(&blobs.fingerprint.finalize())
}

struct Blobs<'a> {
    connection: &'a Connection,
    bytes: usize,
    count: usize,
    fingerprint: Sha256,
}

impl<'a> Blobs<'a> {
    fn new(connection: &'a Connection) -> Self {
        Self {
            connection,
            bytes: 0,
            count: 0,
            fingerprint: Sha256::new(),
        }
    }
    fn get(&mut self, id: &[u8]) -> Result<Vec<u8>, String> {
        self.get_hex(&hex::encode(id))
    }
    fn get_hex(&mut self, id: &str) -> Result<Vec<u8>, String> {
        if id.len() != 64 || !id.bytes().all(|c| c.is_ascii_hexdigit()) {
            return Err("Invalid Cursor history blob reference".into());
        }
        self.count += 1;
        if self.count > 250_000 {
            return Err("Cursor history exceeds the reference limit".into());
        }
        let value: Option<Option<Vec<u8>>> = self
            .connection
            .query_row(
                "SELECT CASE WHEN length(data) <= ?2 THEN data END FROM blobs WHERE id = ?1",
                rusqlite::params![id, MAX_RECORD_BYTES],
                |row| row.get(0),
            )
            .optional()
            .map_err(|e| e.to_string())?;
        let bytes = value
            .ok_or("Cursor history references a missing blob; no partial import was created")?
            .ok_or("Cursor history blob exceeds the read limit")?;
        self.bytes = self.bytes.saturating_add(bytes.len());
        if self.bytes > MAX_FILE_BYTES {
            return Err("Cursor history exceeds the read limit".into());
        }
        self.fingerprint.update(id.as_bytes());
        self.fingerprint.update((bytes.len() as u64).to_le_bytes());
        self.fingerprint.update(&bytes);
        Ok(bytes)
    }
}

enum Field<'a> {
    Bytes(u32, &'a [u8]),
    Varint(u32, u64),
}

fn bytes_fields<'a>(fields: &[Field<'a>], number: u32) -> Vec<&'a [u8]> {
    fields
        .iter()
        .filter_map(|field| match field {
            Field::Bytes(n, value) if *n == number => Some(*value),
            _ => None,
        })
        .collect()
}

fn field_text(fields: &[Field<'_>], number: u32) -> String {
    bytes_fields(fields, number)
        .first()
        .and_then(|bytes| std::str::from_utf8(bytes).ok())
        .unwrap_or("")
        .into()
}

fn varint(bytes: &[u8], offset: &mut usize) -> Result<u64, String> {
    let mut value = 0u64;
    for shift in (0..70).step_by(7) {
        let byte = *bytes
            .get(*offset)
            .ok_or("Truncated Cursor protobuf reference envelope")?;
        *offset += 1;
        if shift == 63 && byte > 1 {
            return Err("Invalid Cursor protobuf integer".into());
        }
        value |= u64::from(byte & 127) << shift;
        if byte < 128 {
            return Ok(value);
        }
    }
    Err("Invalid Cursor protobuf integer".into())
}

fn fields(bytes: &[u8]) -> Result<Vec<Field<'_>>, String> {
    let mut offset = 0;
    let mut result = Vec::new();
    while offset < bytes.len() {
        if result.len() >= 250_000 {
            return Err("Cursor protobuf reference limit exceeded".into());
        }
        let tag = varint(bytes, &mut offset)?;
        let number = u32::try_from(tag >> 3)
            .ok()
            .filter(|n| *n > 0 && *n <= 0x1fff_ffff)
            .ok_or("Invalid Cursor protobuf field")?;
        match tag & 7 {
            0 => result.push(Field::Varint(number, varint(bytes, &mut offset)?)),
            2 => {
                let size = usize::try_from(varint(bytes, &mut offset)?)
                    .map_err(|_| "Invalid Cursor protobuf length")?;
                let end = offset
                    .checked_add(size)
                    .filter(|end| *end <= bytes.len())
                    .ok_or("Truncated Cursor protobuf field")?;
                result.push(Field::Bytes(number, &bytes[offset..end]));
                offset = end;
            }
            wire @ (1 | 5) => {
                offset = offset
                    .checked_add(if wire == 1 { 8 } else { 4 })
                    .filter(|end| *end <= bytes.len())
                    .ok_or("Truncated Cursor protobuf scalar")?;
            }
            _ => return Err("Unsupported Cursor protobuf wire type".into()),
        }
    }
    Ok(result)
}
