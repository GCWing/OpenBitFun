//! Bounded translation of Zcode's persisted session/message/part database.
use openbitfun_product_domains::session_import::*;
use rusqlite::{Connection, OpenFlags, OptionalExtension};
use serde_json::Value;
use sha2::{Digest, Sha256};
use std::collections::{BTreeSet, HashMap};
use std::path::PathBuf;
use std::time::Duration;

pub const SOURCE_REVISION: &str = "zcode-session-sqlite-v1";
const MAX_SESSIONS: usize = 100_000;
const MAX_RECORDS: usize = 200_000;
const MAX_RECORD_BYTES: u64 = 8 * 1024 * 1024;
const MAX_DOCUMENT_BYTES: u64 = 128 * 1024 * 1024;

#[derive(Clone)]
pub struct ZcodeSessionReader {
    pub zcode_home: PathBuf,
}

impl Default for ZcodeSessionReader {
    fn default() -> Self {
        Self::new(
            dirs::home_dir()
                .map(|home| home.join(".zcode"))
                .unwrap_or_default(),
        )
    }
}

struct StoreSchema {
    message_sequence: bool,
    part_sequence: bool,
}

struct Record {
    id: String,
    message_id: Option<String>,
    created: u64,
    data: Value,
}

impl ZcodeSessionReader {
    pub fn new(zcode_home: PathBuf) -> Self {
        Self { zcode_home }
    }

    fn open(&self) -> Result<Option<(Connection, StoreSchema)>, String> {
        if !self.zcode_home.is_absolute() {
            return Err("Zcode home must be an absolute host path".into());
        }
        let path = self.zcode_home.join("cli/db/db.sqlite");
        match std::fs::metadata(&path) {
            Err(error) if error.kind() == std::io::ErrorKind::NotFound => return Ok(None),
            Err(error) => return Err(format!("Zcode session database is unreadable: {error}")),
            Ok(metadata) if !metadata.is_file() => {
                return Err("Zcode session database is not a file".into())
            }
            Ok(_) => {}
        }
        // Do not use immutable=1: Zcode may still have committed history in WAL.
        let connection = Connection::open_with_flags(
            path,
            OpenFlags::SQLITE_OPEN_READ_ONLY | OpenFlags::SQLITE_OPEN_NO_MUTEX,
        )
        .map_err(database_error)?;
        connection
            .busy_timeout(Duration::from_secs(2))
            .map_err(database_error)?;
        connection
            .execute_batch("PRAGMA query_only = ON; BEGIN DEFERRED TRANSACTION;")
            .map_err(database_error)?;
        let session = columns(&connection, "session")?;
        let message = columns(&connection, "message")?;
        let part = columns(&connection, "part")?;
        for (found, required) in [
            (
                &session,
                &[
                    "id",
                    "parent_id",
                    "directory",
                    "title",
                    "version",
                    "time_created",
                    "time_updated",
                ][..],
            ),
            (&message, &["id", "session_id", "time_created", "data"][..]),
            (
                &part,
                &["id", "message_id", "session_id", "time_created", "data"][..],
            ),
        ] {
            if required.iter().any(|field| !found.contains(*field)) {
                return Err("Unsupported Zcode session database schema; update OpenBitFun to read this format".into());
            }
        }
        Ok(Some((
            connection,
            StoreSchema {
                message_sequence: message.contains("sequence"),
                part_sequence: part.contains("sequence"),
            },
        )))
    }

    pub fn discover(
        &self,
        cursor: usize,
        limit: usize,
        query: &str,
    ) -> Result<ExternalSessionCatalog, String> {
        self.discover_page(cursor, limit.clamp(1, 50), query)
    }

    /// Read one bounded SQLite catalog snapshot for host-owned discovery.
    pub fn discover_all(&self) -> Result<ExternalSessionCatalog, String> {
        self.discover_page(0, usize::MAX, "")
    }

    fn discover_page(
        &self,
        cursor: usize,
        limit: usize,
        query: &str,
    ) -> Result<ExternalSessionCatalog, String> {
        let mut catalog = ExternalSessionCatalog {
            schema_version: EXTERNAL_SESSION_IMPORT_SCHEMA_V1,
            ecosystem_id: "zcode".into(),
            source_revision: SOURCE_REVISION.into(),
            candidates: Vec::new(),
            diagnostics: Vec::new(),
            next_cursor: None,
        };
        let Some((connection, _)) = self.open()? else {
            return Ok(catalog);
        };
        let mut statement = connection
            .prepare(
                "SELECT id, directory, title, version, time_created, time_updated FROM session \
             WHERE parent_id IS NULL ORDER BY time_updated DESC, id LIMIT ?1",
            )
            .map_err(database_error)?;
        let rows = statement
            .query_map([MAX_SESSIONS as i64 + 1], candidate_from_row)
            .map_err(database_error)?;
        let query = query.trim().to_lowercase();
        let mut candidates = Vec::new();
        for (index, row) in rows.enumerate() {
            if index >= MAX_SESSIONS {
                return Err("Zcode session catalog exceeds the discovery limit".into());
            }
            let candidate = row.map_err(database_error)?;
            if query.is_empty()
                || format!(
                    "{} {}",
                    candidate.title.as_deref().unwrap_or(""),
                    candidate.cwd.as_deref().unwrap_or("")
                )
                .to_lowercase()
                .contains(&query)
            {
                candidates.push(candidate);
            }
        }
        let end = cursor.saturating_add(limit).min(candidates.len());
        catalog.next_cursor = (end < candidates.len()).then_some(end);
        catalog.candidates = candidates.into_iter().skip(cursor).take(limit).collect();
        Ok(catalog)
    }

    pub fn read_candidate(
        &self,
        candidate_id: &str,
        mode: ExternalSessionImportMode,
    ) -> Result<ExternalSessionDocument, String> {
        if mode != ExternalSessionImportMode::Full {
            return Err("Zcode session import supports full history only".into());
        }
        let id = candidate_id
            .strip_prefix("zcode:")
            .filter(|id| !id.is_empty() && id.len() <= 256)
            .ok_or("Invalid Zcode session candidate ID")?;
        let (connection, schema) = self
            .open()?
            .ok_or("Zcode session database was removed or moved; refresh the list")?;
        let mut candidate = connection.query_row(
            "SELECT id, directory, title, version, time_created, time_updated FROM session WHERE id = ?1 AND parent_id IS NULL",
            [id], candidate_from_row,
        ).optional().map_err(database_error)?.ok_or("Zcode session was removed or moved; refresh the list")?;

        let mut total_bytes = 0u64;
        for table in ["message", "part"] {
            let (count, bytes, largest): (u64, u64, u64) = connection.query_row(
                &format!("SELECT count(*), coalesce(sum(length(cast(data as blob))), 0), coalesce(max(length(cast(data as blob))), 0) FROM {table} WHERE session_id = ?1"),
                [id], |row| Ok((row.get(0)?, row.get(1)?, row.get(2)?)),
            ).map_err(database_error)?;
            total_bytes = total_bytes.saturating_add(bytes);
            if count > MAX_RECORDS as u64
                || largest > MAX_RECORD_BYTES
                || total_bytes > MAX_DOCUMENT_BYTES
            {
                return Err("Zcode session exceeds the safe import size limit".into());
            }
        }
        let mut hasher = Sha256::new();
        hasher.update(SOURCE_REVISION.as_bytes());
        hasher.update(serde_json::to_vec(&candidate).map_err(|error| error.to_string())?);
        let messages = records(
            &connection,
            "message",
            id,
            schema.message_sequence,
            &mut hasher,
        )?;
        let parts = records(&connection, "part", id, schema.part_sequence, &mut hasher)?;
        let mut parts_by_message: HashMap<String, Vec<Record>> = HashMap::new();
        for part in parts {
            parts_by_message
                .entry(part.message_id.clone().unwrap_or_default())
                .or_default()
                .push(part);
        }
        let mut turns: Vec<ExternalSessionTurn> = Vec::new();
        let mut user_turns = HashMap::new();
        let mut hidden_users = BTreeSet::new();
        let mut warnings = BTreeSet::new();
        for message in messages {
            let parts = parts_by_message.remove(&message.id).unwrap_or_default();
            let data = &message.data;
            if hidden_message(data) {
                if data["role"] == "user" {
                    hidden_users.insert(message.id);
                }
                continue;
            }
            match data["role"].as_str() {
                Some("user") => {
                    let mut text = Vec::new();
                    for part in &parts {
                        if part.data["synthetic"] == true || part.data["ignored"] == true {
                            continue;
                        }
                        match part.data["type"].as_str() {
                            Some("text") => {
                                if let Some(value) = part.data["text"]
                                    .as_str()
                                    .filter(|text| !text.trim().is_empty())
                                {
                                    text.push(value.to_owned());
                                }
                            }
                            Some("file") => {
                                let name = part.data["filename"].as_str().unwrap_or("attachment");
                                text.push(format!("[Source attachment: {name}]"));
                                warnings.insert("attachment_reference_only");
                            }
                            Some("compaction") => {
                                warnings.insert("compaction_marker");
                            }
                            Some(_) => {
                                warnings.insert("unsupported_part");
                            }
                            None => return Err("Malformed Zcode session part: missing type".into()),
                        }
                    }
                    if text.is_empty() {
                        hidden_users.insert(message.id);
                        continue;
                    }
                    user_turns.insert(message.id.clone(), turns.len());
                    turns.push(ExternalSessionTurn {
                        source_turn_id: message.id,
                        timestamp: data["time"]["created"].as_u64().unwrap_or(message.created),
                        user_text: text.join("\n\n"),
                        items: Vec::new(),
                        source_event_count: 1 + parts.len(),
                        status: ExternalSessionStatus::Interrupted,
                    });
                }
                Some("assistant") => {
                    if data["semantics"]["kind"] == "timeline_event" {
                        continue;
                    }
                    let index = match data.get("parentID").filter(|value| !value.is_null()) {
                        Some(parent) => {
                            let id = parent
                                .as_str()
                                .ok_or("Malformed Zcode session: invalid assistant parent ID")?;
                            if hidden_users.contains(id) {
                                continue;
                            }
                            user_turns.get(id).copied()
                        }
                        None => turns.len().checked_sub(1),
                    };
                    let Some(index) = index else {
                        if parts.iter().any(|part| {
                            matches!(
                                part.data["type"].as_str(),
                                Some("text" | "tool" | "reasoning")
                            )
                        }) {
                            return Err("Malformed Zcode session: assistant history has no readable user turn".into());
                        }
                        continue;
                    };
                    let turn = &mut turns[index];
                    turn.source_event_count += 1 + parts.len();
                    candidate.model_provider =
                        string(data.get("providerId")).or(candidate.model_provider);
                    candidate.model_name = string(data.get("modelId")).or(candidate.model_name);
                    let mut unfinished_tool = false;
                    for part in parts {
                        if part.data["ignored"] == true {
                            continue;
                        }
                        match part.data["type"].as_str() {
                            Some("text" | "reasoning") => {
                                if let Some(text) =
                                    part.data["text"].as_str().filter(|text| !text.is_empty())
                                {
                                    turn.items.push(if part.data["type"] == "reasoning" {
                                        ExternalSessionItem::Thinking {
                                            text: text.to_owned(),
                                        }
                                    } else {
                                        ExternalSessionItem::Text {
                                            text: text.to_owned(),
                                        }
                                    });
                                }
                            }
                            Some("tool") => {
                                let state = &part.data["state"];
                                let (result, success) = match state["status"].as_str() {
                                    Some("completed") => (state.get("output").cloned(), Some(true)),
                                    Some("error") => (state.get("error").cloned(), Some(false)),
                                    Some("pending" | "running") => { unfinished_tool = true; (None, None) }
                                    _ => return Err("Unsupported Zcode tool state; update OpenBitFun to read this format".into()),
                                };
                                turn.items.push(ExternalSessionItem::Tool {
                                    id: part.data["callID"].as_str().unwrap_or(&part.id).to_owned(),
                                    name: part.data["tool"]
                                        .as_str()
                                        .ok_or("Malformed Zcode tool record: missing name")?
                                        .to_owned(),
                                    input: state.get("input").cloned().unwrap_or(Value::Null),
                                    result,
                                    success,
                                });
                            }
                            Some(
                                "step-start" | "step-finish" | "timeline" | "snapshot" | "patch",
                            ) => {}
                            Some(_) => {
                                warnings.insert("unsupported_part");
                            }
                            None => return Err("Malformed Zcode session part: missing type".into()),
                        }
                    }
                    turn.status = if data.get("error").is_none_or(Value::is_null)
                        && matches!(data["finish"].as_str(), Some("stop" | "end_turn"))
                        && !unfinished_tool
                    {
                        ExternalSessionStatus::Complete
                    } else {
                        ExternalSessionStatus::Interrupted
                    };
                }
                Some("system") => {}
                _ => {
                    return Err(
                        "Unsupported Zcode message role; update OpenBitFun to read this format"
                            .into(),
                    )
                }
            }
        }
        if !parts_by_message.is_empty() {
            return Err("Malformed Zcode session: orphaned message parts".into());
        }
        if turns.is_empty() {
            return Err("No usable human conversation was found in this Zcode session".into());
        }
        candidate.status = if turns
            .iter()
            .any(|turn| turn.status == ExternalSessionStatus::Interrupted)
        {
            ExternalSessionStatus::Interrupted
        } else {
            ExternalSessionStatus::Complete
        };
        candidate.turn_count = Some(turns.len());
        candidate.file_size_bytes = total_bytes;
        candidate.fingerprint = format!("sha256:{}", hex::encode(hasher.finalize()));
        Ok(ExternalSessionDocument {
            candidate, turns,
            warnings: warnings.into_iter().map(|code| ExternalSessionImportWarning {
                code: format!("zcode_{code}"),
                detail: match code {
                    "attachment_reference_only" => "Attachment names were preserved; source attachment files were not copied.",
                    "compaction_marker" => "Compaction control records are omitted; retained conversation history is imported.",
                    _ => "Some Zcode display or control parts have no supported history representation.",
                }.into(),
            }).collect(),
        })
    }
}

fn columns(connection: &Connection, table: &str) -> Result<BTreeSet<String>, String> {
    let mut statement = connection
        .prepare(&format!("PRAGMA table_info({table})"))
        .map_err(database_error)?;
    let columns = statement
        .query_map([], |row| row.get(1))
        .map_err(database_error)?
        .collect::<Result<_, _>>()
        .map_err(database_error)?;
    Ok(columns)
}

fn database_error(error: rusqlite::Error) -> String {
    format!("Could not read Zcode session database: {error}")
}

fn candidate_from_row(row: &rusqlite::Row<'_>) -> rusqlite::Result<ExternalSessionCandidate> {
    let id: String = row.get(0)?;
    let updated_at: Option<u64> = row.get(5)?;
    Ok(ExternalSessionCandidate {
        candidate_id: format!("zcode:{id}"),
        ecosystem_id: "zcode".into(),
        source_session_id: id,
        cwd: row.get(1)?,
        title: row.get(2)?,
        fallback_title: None,
        title_is_source_name: true,
        format_version: row.get(3)?,
        created_at: row.get(4)?,
        updated_at,
        model_provider: None,
        model_name: None,
        turn_count: None,
        file_size_bytes: 0,
        status: ExternalSessionStatus::Complete,
        fingerprint: format!("metadata:{}", updated_at.unwrap_or(0)),
        source_location: Some("~/.zcode/cli/db/db.sqlite".into()),
        target_workspace_id: None,
        target_workspace_name: None,
        imported_session_id: None,
    })
}

fn records(
    connection: &Connection,
    table: &str,
    id: &str,
    sequence: bool,
    hasher: &mut Sha256,
) -> Result<Vec<Record>, String> {
    let order = if sequence {
        "coalesce(sequence, time_created), time_created, id"
    } else {
        "time_created, id"
    };
    let parent = if table == "part" {
        "message_id"
    } else {
        "NULL"
    };
    let mut statement = connection.prepare(&format!("SELECT id, {parent}, time_created, data FROM {table} WHERE session_id = ?1 ORDER BY {order}")).map_err(database_error)?;
    let mut rows = statement.query([id]).map_err(database_error)?;
    let mut result = Vec::new();
    while let Some(row) = rows.next().map_err(database_error)? {
        let id: String = row.get(0).map_err(database_error)?;
        let message_id: Option<String> = row.get(1).map_err(database_error)?;
        let raw: String = row.get(3).map_err(database_error)?;
        hasher.update(table.as_bytes());
        hasher.update(id.as_bytes());
        hasher.update(raw.as_bytes());
        let data: Value =
            serde_json::from_str(&raw).map_err(|_| "Malformed Zcode session record".to_string())?;
        if !data.is_object() {
            return Err("Malformed Zcode session record".into());
        }
        result.push(Record {
            id,
            message_id,
            created: row.get(2).map_err(database_error)?,
            data,
        });
    }
    Ok(result)
}

fn hidden_message(data: &Value) -> bool {
    data["semantics"]["uiVisibility"] == "hidden"
        || data["semantics"]["transcriptVisibility"] == "hidden"
        || matches!(
            data["semantics"]["kind"].as_str(),
            Some("system_reminder" | "todo_reminder")
        )
}

fn string(value: Option<&Value>) -> Option<String> {
    value.and_then(Value::as_str).map(str::to_owned)
}

#[cfg(test)]
mod tests;
