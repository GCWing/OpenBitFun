//! Append-only durability for the Runtime's executing-Turn event log.
//!
//! One file per Session, one line per event, written as the event happens.
//! Reload replays that log through the Runtime's own materialization, so a
//! restored Turn and a live one are produced by a single implementation.
//!
//! This is deliberately scoped to the Turn **in flight**. The persisted Session
//! record remains the history of completed work; it cannot represent a running
//! Turn because it stores one as idle so a restart never revives work. When a
//! Turn reaches a terminal state the Session record owns it and this log is
//! dropped, so the two never describe the same thing at the same time.

use super::session_projection_format::LoggedEvent;
use openbitfun_agent_runtime::sdk::{SessionEventProjectionStore, StoredSessionEvents};
use openbitfun_events::AgenticEvent;
use std::collections::HashMap;
use std::fs::{File, OpenOptions};
use std::io::{BufRead, BufReader, Write};
use std::path::{Path, PathBuf};
use std::sync::{Arc, Mutex};

const DEFAULT_RUNTIME_EVENT_PAGE_SIZE: usize = 200;
const MAX_RUNTIME_EVENT_PAGE_SIZE: usize = 1_000;

#[derive(Debug, Clone)]
pub struct RuntimeEventRecord {
    pub stream_id: String,
    pub cursor: u64,
    pub event: AgenticEvent,
}

#[derive(Debug, Clone)]
pub struct RuntimeEventPage {
    pub stream_id: String,
    pub events: Vec<RuntimeEventRecord>,
    pub next_cursor: u64,
    pub has_more: bool,
}

/// Open append handles, keyed by Session. Holding the handle is what makes a
/// per-event write an append to an already-open file rather than an open/close
/// cycle per token.
type OpenLogs = Mutex<HashMap<String, Arc<Mutex<File>>>>;

pub struct FileSessionProjectionStore {
    root: PathBuf,
    logs: OpenLogs,
}

impl std::fmt::Debug for FileSessionProjectionStore {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.debug_struct("FileSessionProjectionStore")
            .field("root", &self.root)
            .finish_non_exhaustive()
    }
}

/// Where every Host on this machine keeps its in-flight Turn logs.
///
/// Shared so Desktop and CLI agree without either hard-coding a path: they can
/// own the same Session at different times, and a log written by one must be
/// the log the other replays.
pub fn runtime_event_log_dir(
    path_manager: &crate::infrastructure::PathManager,
) -> std::path::PathBuf {
    path_manager.product_home_dir().join("runtime-events")
}

pub fn read_runtime_events_since(
    root: &Path,
    session_id: &str,
    stream_id: Option<&str>,
    after_cursor: u64,
    requested_limit: Option<u32>,
) -> Result<Option<RuntimeEventPage>, String> {
    let path = log_path(root, session_id);
    let file = match File::open(&path) {
        Ok(file) => file,
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => return Ok(None),
        Err(error) => {
            return Err(format!(
                "Failed to open runtime event log for {session_id}: {error}"
            ))
        }
    };

    let limit = requested_limit
        .map(|value| value as usize)
        .unwrap_or(DEFAULT_RUNTIME_EVENT_PAGE_SIZE)
        .clamp(1, MAX_RUNTIME_EVENT_PAGE_SIZE);
    let mut latest_stream_id: Option<String> = None;
    let mut active_after_cursor = after_cursor;
    let mut events = Vec::new();
    let mut has_more = false;
    let mut next_cursor = after_cursor;

    for line in BufReader::new(file).lines() {
        let line = line.map_err(|error| {
            format!("Failed to read runtime event log for {session_id}: {error}")
        })?;
        if line.trim().is_empty() {
            continue;
        }
        let record = match serde_json::from_str::<LoggedEvent>(&line) {
            Ok(record) => record,
            Err(_) => break,
        };
        match latest_stream_id.as_deref() {
            Some(current) if current != record.stream_id => {
                active_after_cursor = match stream_id {
                    Some(requested) if requested == record.stream_id => after_cursor,
                    Some(_) => 0,
                    None => after_cursor,
                };
                events.clear();
                has_more = false;
                next_cursor = active_after_cursor;
                latest_stream_id = Some(record.stream_id.clone());
            }
            None => {
                active_after_cursor = match stream_id {
                    Some(requested) if requested == record.stream_id => after_cursor,
                    Some(_) => 0,
                    None => after_cursor,
                };
                next_cursor = active_after_cursor;
                latest_stream_id = Some(record.stream_id.clone());
            }
            _ => {}
        }
        if record.cursor <= active_after_cursor {
            continue;
        }
        if events.len() >= limit {
            has_more = true;
            continue;
        }
        next_cursor = record.cursor;
        events.push(RuntimeEventRecord {
            stream_id: record.stream_id,
            cursor: record.cursor,
            event: record.event,
        });
    }

    let Some(latest_stream_id) = latest_stream_id else {
        return Ok(None);
    };
    Ok(Some(RuntimeEventPage {
        stream_id: latest_stream_id,
        events,
        next_cursor,
        has_more,
    }))
}

impl FileSessionProjectionStore {
    pub fn new(root: PathBuf) -> Self {
        if let Err(error) = std::fs::create_dir_all(&root) {
            log::warn!(
                "Runtime event log unavailable at {}: {error}",
                root.display()
            );
        }
        Self {
            root,
            logs: Mutex::new(HashMap::new()),
        }
    }

    fn log_handle(&self, session_id: &str) -> Option<Arc<Mutex<File>>> {
        let mut logs = lock(&self.logs);
        if let Some(handle) = logs.get(session_id) {
            return Some(Arc::clone(handle));
        }
        let file = OpenOptions::new()
            .create(true)
            .append(true)
            .open(log_path(&self.root, session_id))
            .map_err(|error| {
                log::warn!("Failed to open runtime event log for {session_id}: {error}");
            })
            .ok()?;
        let handle = Arc::new(Mutex::new(file));
        logs.insert(session_id.to_string(), Arc::clone(&handle));
        Some(handle)
    }
}

impl SessionEventProjectionStore for FileSessionProjectionStore {
    fn append(&self, session_id: &str, stream_id: &str, cursor: u64, event: &AgenticEvent) {
        let record = LoggedEvent {
            stream_id: stream_id.to_string(),
            cursor,
            event: event.clone(),
        };
        let Ok(mut line) = serde_json::to_vec(&record) else {
            return;
        };
        line.push(b'\n');

        let Some(handle) = self.log_handle(session_id) else {
            return;
        };
        let mut file = lock(&handle);
        // No fsync: an append reaches the page cache immediately, which already
        // survives a process crash — the case this log exists for. Paying a
        // disk flush per token would throttle the stream it is recording.
        if let Err(error) = file.write_all(&line) {
            log::warn!("Failed to append runtime event for {session_id}: {error}");
        }
    }

    fn load(&self, session_id: &str) -> Option<StoredSessionEvents> {
        let file = File::open(log_path(&self.root, session_id)).ok()?;
        let mut stream_id: Option<String> = None;
        let mut events = Vec::new();
        for line in BufReader::new(file).lines() {
            let Ok(line) = line else { break };
            if line.trim().is_empty() {
                continue;
            }
            // A torn final line is expected after a hard kill mid-append. Stop
            // there and keep everything already durable.
            let Ok(record) = serde_json::from_str::<LoggedEvent>(&line) else {
                break;
            };
            match stream_id.as_deref() {
                // A newer Runtime process reused this file; its events replace
                // the older process's, which describe a Turn that no longer runs.
                Some(current) if current != record.stream_id => {
                    events.clear();
                    stream_id = Some(record.stream_id);
                }
                None => stream_id = Some(record.stream_id),
                _ => {}
            }
            events.push(record.event);
        }
        if events.is_empty() {
            return None;
        }
        stream_id.map(|stream_id| StoredSessionEvents { stream_id, events })
    }

    fn discard(&self, session_id: &str) {
        lock(&self.logs).remove(session_id);
        let _ = std::fs::remove_file(log_path(&self.root, session_id));
    }
}

fn lock<T>(value: &Mutex<T>) -> std::sync::MutexGuard<'_, T> {
    value
        .lock()
        .unwrap_or_else(|poisoned| poisoned.into_inner())
}

/// Session ids are host-generated UUIDs, but this still refuses anything that
/// could escape the log directory rather than trusting that invariant.
fn log_path(root: &Path, session_id: &str) -> PathBuf {
    let safe: String = session_id
        .chars()
        .map(|character| {
            if character.is_ascii_alphanumeric() || character == '-' || character == '_' {
                character
            } else {
                '_'
            }
        })
        .collect();
    root.join(format!("{safe}.jsonl"))
}

#[cfg(test)]
mod tests {
    use super::*;

    fn temp_root() -> PathBuf {
        std::env::temp_dir().join(format!("openbitfun-evlog-{}", uuid::Uuid::new_v4()))
    }

    fn text(session_id: &str, value: &str) -> AgenticEvent {
        AgenticEvent::TextChunk {
            session_id: session_id.to_string(),
            turn_id: "turn-1".to_string(),
            round_id: "round-1".to_string(),
            attempt_id: None,
            attempt_index: None,
            text: value.to_string(),
        }
    }

    #[test]
    fn every_event_is_durable_the_moment_it_is_appended() {
        let root = temp_root();
        let store = FileSessionProjectionStore::new(root.clone());

        store.append("session-1", "stream-1", 1, &text("session-1", "a"));
        store.append("session-1", "stream-1", 2, &text("session-1", "b"));

        // A separate store reads the same directory: nothing is held back in
        // process memory waiting for a flush interval.
        let reader = FileSessionProjectionStore::new(root.clone());
        let stored = reader.load("session-1").expect("events are on disk");
        assert_eq!(stored.events.len(), 2);
        assert_eq!(stored.stream_id, "stream-1");
        let _ = std::fs::remove_dir_all(&root);
    }

    #[test]
    fn a_newer_runtime_process_supersedes_an_older_log() {
        let root = temp_root();
        let store = FileSessionProjectionStore::new(root.clone());

        store.append("session-1", "stream-old", 1, &text("session-1", "stale"));
        store.append("session-1", "stream-new", 1, &text("session-1", "fresh"));

        let stored = store.load("session-1").expect("log is readable");
        assert_eq!(stored.stream_id, "stream-new");
        assert_eq!(stored.events.len(), 1);
        let _ = std::fs::remove_dir_all(&root);
    }

    #[test]
    fn output_pages_reset_cursor_when_stream_changes() {
        let root = temp_root();
        let store = FileSessionProjectionStore::new(root.clone());

        store.append("session-1", "stream-old", 100, &text("session-1", "stale"));
        store.append("session-1", "stream-new", 1, &text("session-1", "fresh"));

        let page =
            read_runtime_events_since(&root, "session-1", Some("stream-old"), 100, Some(10))
                .expect("page read succeeds")
                .expect("latest stream exists");
        assert_eq!(page.stream_id, "stream-new");
        assert_eq!(page.events.len(), 1);
        assert_eq!(page.events[0].cursor, 1);
        assert_eq!(page.next_cursor, 1);
        let _ = std::fs::remove_dir_all(&root);
    }

    #[test]
    fn a_torn_final_line_keeps_everything_already_durable() {
        let root = temp_root();
        let store = FileSessionProjectionStore::new(root.clone());
        store.append("session-1", "stream-1", 1, &text("session-1", "a"));
        store.discard("session-1");

        let path = log_path(&root, "session-1");
        std::fs::write(
            &path,
            format!(
                "{}\n{{\"streamId\":\"stream-1\",\"cur",
                serde_json::to_string(&LoggedEvent {
                    stream_id: "stream-1".to_string(),
                    cursor: 1,
                    event: text("session-1", "a"),
                })
                .unwrap()
            ),
        )
        .unwrap();

        let stored = store.load("session-1").expect("surviving prefix is served");
        assert_eq!(stored.events.len(), 1);
        let _ = std::fs::remove_dir_all(&root);
    }

    #[test]
    fn a_terminal_turn_hands_the_record_back_to_the_session() {
        let root = temp_root();
        let store = FileSessionProjectionStore::new(root.clone());

        store.append("session-1", "stream-1", 1, &text("session-1", "a"));
        store.discard("session-1");

        assert!(store.load("session-1").is_none());
        assert!(!log_path(&root, "session-1").exists());
        let _ = std::fs::remove_dir_all(&root);
    }

    #[test]
    fn a_session_id_cannot_escape_the_log_directory() {
        let root = PathBuf::from("/tmp/openbitfun-evlog-root");
        assert_eq!(
            log_path(&root, "../../etc/passwd").parent(),
            Some(root.as_path())
        );
    }
}
