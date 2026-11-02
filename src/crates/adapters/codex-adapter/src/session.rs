//! Bounded, read-only Codex rollout and paginated SQLite history import.
//! Discovery reads metadata, never full histories.
use openbitfun_product_domains::session_import::*;
use serde_json::{json, Value};
use sha2::{Digest, Sha256};
use std::collections::{BTreeSet, HashMap, HashSet};
use std::fs::{self, File};
use std::io::{BufRead, BufReader, Read};
use std::path::{Path, PathBuf};
use std::sync::{Arc, Mutex};
use std::time::{SystemTime, UNIX_EPOCH};

mod sqlite_history;
#[cfg(test)]
mod sqlite_history_tests;
mod titles;
use titles::{TitleCache, TitleSnapshot};

pub const SOURCE_REVISION: &str = "codex-rollout-and-sqlite-v3";
const MAX_FILE_BYTES: u64 = 256 * 1024 * 1024;
const MAX_LINE_BYTES: usize = 8 * 1024 * 1024;
const MAX_DOCUMENT_BYTES: usize = 128 * 1024 * 1024;
const HEADER_BYTES: usize = 256 * 1024;
const MAX_FILES: usize = 100_000;
const MAX_TURNS: usize = 4096;

#[derive(Clone)]
pub struct CodexSessionReader {
    pub codex_home: PathBuf,
    headers: Arc<Mutex<HashMap<PathBuf, CachedHeader>>>,
    titles: Arc<Mutex<TitleCache>>,
    #[cfg(test)]
    header_reads: Arc<std::sync::atomic::AtomicUsize>,
}

#[derive(Clone)]
struct CachedHeader {
    modified: Option<SystemTime>,
    size: u64,
    candidate: ExternalSessionCandidate,
}
impl Default for CodexSessionReader {
    fn default() -> Self {
        Self::new(
            std::env::var_os("CODEX_HOME")
                .map(PathBuf::from)
                .or_else(|| dirs::home_dir().map(|home| home.join(".codex")))
                .unwrap_or_default(),
        )
    }
}
impl CodexSessionReader {
    pub fn new(codex_home: PathBuf) -> Self {
        Self {
            codex_home,
            headers: Arc::default(),
            titles: Arc::default(),
            #[cfg(test)]
            header_reads: Arc::default(),
        }
    }
    pub fn source_revision(&self) -> &'static str {
        SOURCE_REVISION
    }

    fn title_snapshot(&self) -> Arc<TitleSnapshot> {
        self.titles
            .lock()
            .unwrap_or_else(|error| error.into_inner())
            .snapshot(&self.codex_home)
    }
    fn paths(&self) -> Result<Vec<PathBuf>, String> {
        if !self.codex_home.is_absolute() {
            return Err("Codex home must be an absolute host path".into());
        }
        let mut paths = Vec::new();
        let mut visits = 0usize;
        for name in ["sessions", "archived_sessions"] {
            let root = self.codex_home.join(name);
            if root.exists() {
                collect(&root, &mut paths, 0, &mut visits)?;
            }
        }
        let present = paths.iter().collect::<HashSet<_>>();
        self.headers
            .lock()
            .unwrap_or_else(|error| error.into_inner())
            .retain(|path, _| present.contains(path));
        Ok(paths)
    }
    pub fn discover(
        &self,
        cursor: usize,
        limit: usize,
        query: &str,
    ) -> Result<ExternalSessionCatalog, String> {
        self.discover_page(cursor, limit.clamp(1, 50), query)
    }

    /// Host-owned automatic discovery traverses the bounded source index once,
    /// rather than rescanning every rollout header for each UI page.
    pub fn discover_all(&self) -> Result<ExternalSessionCatalog, String> {
        self.discover_page(0, usize::MAX, "")
    }

    fn discover_page(
        &self,
        cursor: usize,
        limit: usize,
        query: &str,
    ) -> Result<ExternalSessionCatalog, String> {
        let titles = self.title_snapshot();
        let mut diagnostics = titles.diagnostics.clone();
        let paths = self.logical_session_paths(&titles, &mut diagnostics)?;
        let mut available = titles
            .paginated
            .values()
            .filter(|thread| !thread.subagent)
            .map(|thread| {
                let mut candidate = thread.candidate.clone();
                titles.apply(&mut candidate);
                candidate
            })
            .collect::<Vec<_>>();
        for path in paths {
            match self.inspect_path_with_titles(&path, &titles) {
                Ok(candidate) if !titles.paginated.contains_key(&candidate.source_session_id) => {
                    available.push(candidate)
                }
                Ok(_) => {}
                Err(error) if diagnostics.len() < 20 => {
                    diagnostics.push(warning("source_unreadable", &error))
                }
                Err(_) => {}
            }
        }
        available.sort_by(|left, right| {
            right
                .updated_at
                .cmp(&left.updated_at)
                .then_with(|| left.candidate_id.cmp(&right.candidate_id))
        });
        let mut candidates = Vec::new();
        let mut matched = 0usize;
        let mut has_more = false;
        let query = query.to_lowercase();
        for candidate in available {
            if !query.is_empty()
                && !format!(
                    "{} {}",
                    candidate.title.as_deref().unwrap_or(""),
                    candidate.cwd.as_deref().unwrap_or("")
                )
                .to_lowercase()
                .contains(&query)
            {
                continue;
            }
            matched += 1;
            if matched <= cursor {
                continue;
            }
            if candidates.len() == limit {
                has_more = true;
                break;
            }
            candidates.push(candidate);
        }
        Ok(ExternalSessionCatalog {
            schema_version: 1,
            ecosystem_id: "codex".into(),
            source_revision: SOURCE_REVISION.into(),
            next_cursor: has_more.then_some(cursor + candidates.len()),
            candidates,
            diagnostics,
        })
    }

    pub fn read_candidate(
        &self,
        id: &str,
        mode: ExternalSessionImportMode,
    ) -> Result<CodexSessionDocument, String> {
        if !self.codex_home.is_absolute() {
            return Err("Codex home must be an absolute host path".into());
        }
        let titles = self.title_snapshot();
        if let Some(thread) = titles
            .paginated
            .values()
            .find(|thread| thread.matches_locator(id))
        {
            return sqlite_history::read(thread, mode, &titles);
        }
        let cached = self
            .headers
            .lock()
            .unwrap_or_else(|error| error.into_inner())
            .iter()
            .find(|(_, header)| header.candidate.candidate_id == id)
            .map(|(path, _)| path.clone());
        if let Some(path) =
            cached.filter(|path| path.starts_with(&self.codex_home) && path.is_file())
        {
            return self.read_current_rollout(&path, mode);
        }
        let path = self
            .paths()?
            .into_iter()
            .find(|path| candidate_id(path) == id)
            .ok_or("Codex session was removed or moved; refresh the list")?;
        // Populate the bounded header cache so a legacy locator can resolve to
        // the current rollout of the same logical Codex thread.
        let titles = self.title_snapshot();
        self.logical_session_paths(&titles, &mut Vec::new())?;
        self.read_current_rollout(&path, mode)
    }

    /// Codex can leave several rollout files for one thread after a resume or
    /// retry. Prefer its current state-database locator; timestamps are only a
    /// fallback for installations without that optional column/database.
    fn logical_session_paths(
        &self,
        titles: &TitleSnapshot,
        diagnostics: &mut Vec<ExternalSessionImportWarning>,
    ) -> Result<Vec<PathBuf>, String> {
        let mut selected: HashMap<String, (PathBuf, ExternalSessionCandidate)> = HashMap::new();
        for path in self.paths()? {
            let candidate = match self.inspect_header(&path) {
                Ok(candidate) => candidate,
                Err(error) => {
                    if diagnostics.len() < 20 {
                        diagnostics.push(warning("source_unreadable", &error));
                    }
                    continue;
                }
            };
            let rank = |path: &Path, candidate: &ExternalSessionCandidate| {
                (
                    titles.is_current_rollout(&candidate.source_session_id, path),
                    candidate.created_at,
                    candidate.updated_at,
                    path.to_path_buf(),
                )
            };
            let replace = selected.get(&candidate.source_session_id).is_none_or(
                |(previous_path, previous)| rank(&path, &candidate) > rank(previous_path, previous),
            );
            if replace {
                selected.insert(candidate.source_session_id.clone(), (path, candidate));
            }
        }
        let mut selected = selected.into_values().collect::<Vec<_>>();
        selected.sort_by(|(left_path, left), (right_path, right)| {
            right
                .updated_at
                .cmp(&left.updated_at)
                .then_with(|| left_path.cmp(right_path))
        });
        Ok(selected.into_iter().map(|(path, _)| path).collect())
    }

    fn read_current_rollout(
        &self,
        path: &Path,
        mode: ExternalSessionImportMode,
    ) -> Result<CodexSessionDocument, String> {
        let candidate = self.inspect_header(path)?;
        let titles = self.title_snapshot();
        if let Some(thread) = titles.paginated.get(&candidate.source_session_id) {
            return sqlite_history::read(thread, mode, &titles);
        }
        // A resume can publish a new rollout after the last catalog scan. Read
        // only this thread's indexed file, after checking the source boundary.
        if let Some(current) = titles.current_rollout(&candidate.source_session_id) {
            let current = PathBuf::from(current.strip_prefix("\\\\?\\").unwrap_or(current));
            if let (Ok(resolved), Ok(home)) = (
                fs::canonicalize(&current),
                fs::canonicalize(&self.codex_home),
            ) {
                if ["sessions", "archived_sessions"]
                    .iter()
                    .any(|name| resolved.starts_with(home.join(name)))
                    && self
                        .inspect_header(&current)
                        .is_ok_and(|header| header.source_session_id == candidate.source_session_id)
                {
                    return self.read_path(&current, mode);
                }
            }
        }
        let selected = self
            .headers
            .lock()
            .unwrap_or_else(|error| error.into_inner())
            .iter()
            .filter(|(path, header)| {
                header.candidate.source_session_id == candidate.source_session_id && path.is_file()
            })
            .max_by_key(|(path, header)| {
                (
                    titles.is_current_rollout(&candidate.source_session_id, path),
                    header.candidate.created_at,
                    header.candidate.updated_at,
                    (*path).clone(),
                )
            })
            .map(|(path, _)| path.clone())
            .unwrap_or_else(|| path.to_path_buf());
        self.read_path(&selected, mode)
    }
    pub fn inspect_path(&self, path: &Path) -> Result<ExternalSessionCandidate, String> {
        self.inspect_path_with_titles(path, &self.title_snapshot())
    }

    fn inspect_path_with_titles(
        &self,
        path: &Path,
        titles: &TitleSnapshot,
    ) -> Result<ExternalSessionCandidate, String> {
        let mut candidate = self.inspect_header(path)?;
        titles.apply(&mut candidate);
        Ok(candidate)
    }

    fn inspect_header(&self, path: &Path) -> Result<ExternalSessionCandidate, String> {
        let meta = fs::symlink_metadata(path).map_err(|e| e.to_string())?;
        if !meta.is_file() {
            return Err("Codex rollout is not a regular file".into());
        }
        if let Some(cached) = self
            .headers
            .lock()
            .unwrap_or_else(|error| error.into_inner())
            .get(path)
        {
            if cached.modified == meta.modified().ok() && cached.size == meta.len() {
                return Ok(cached.candidate.clone());
            }
        }
        #[cfg(test)]
        self.header_reads
            .fetch_add(1, std::sync::atomic::Ordering::Relaxed);
        let mut reader = BufReader::new(File::open(path).map_err(|error| error.to_string())?)
            .take(HEADER_BYTES as u64);
        let mut line = Vec::new();
        let mut session = None;
        let mut title = None;
        let mut fallback_title = None;
        let mut model = None;
        loop {
            line.clear();
            if reader
                .read_until(b'\n', &mut line)
                .map_err(|error| error.to_string())?
                == 0
            {
                break;
            }
            let Ok(value) = serde_json::from_slice::<Value>(&line) else {
                continue;
            };
            match value["type"].as_str().unwrap_or("") {
                "session_meta" => {
                    session = Some(
                        value["payload"]
                            .get("meta")
                            .unwrap_or(&value["payload"])
                            .clone(),
                    )
                }
                "turn_context" => model = value["payload"]["model"].as_str().map(str::to_owned),
                "response_item" => {
                    let p = value["payload"].get("item").unwrap_or(&value["payload"]);
                    if p["type"] == "message" && p["role"] == "user" && title.is_none() {
                        let text = content_text(&p["content"]);
                        if !text.is_empty() && !is_injected(&text) {
                            fallback_title.get_or_insert_with(|| preview(&text, 120));
                            title = user_title_preview(&text);
                        }
                    }
                }
                _ => {}
            }
            if session.is_some() && title.is_some() {
                break;
            }
        }
        let session = session.ok_or("Rollout header not found in the bounded prefix")?;
        let source_id = session["id"]
            .as_str()
            .or_else(|| session["session_id"].as_str())
            .ok_or("Codex session id is missing")?
            .to_owned();
        let updated = meta
            .modified()
            .ok()
            .and_then(|time| time.duration_since(UNIX_EPOCH).ok())
            .map(|d| d.as_millis() as u64);
        let candidate = ExternalSessionCandidate {
            candidate_id: candidate_id(path),
            ecosystem_id: "codex".into(),
            source_session_id: source_id,
            title: session["name"]
                .as_str()
                .or_else(|| session["title"].as_str())
                .filter(|title| !title.trim().is_empty())
                .map(str::to_owned)
                .or(title),
            fallback_title,
            title_is_source_name: session["name"]
                .as_str()
                .or_else(|| session["title"].as_str())
                .is_some_and(|title| !title.trim().is_empty()),
            cwd: session["cwd"].as_str().map(str::to_owned),
            created_at: timestamp(&session["timestamp"]),
            updated_at: updated,
            model_provider: session["model_provider"].as_str().map(str::to_owned),
            model_name: model,
            turn_count: None,
            file_size_bytes: meta.len(),
            format_version: session["cli_version"].as_str().map(str::to_owned),
            status: if meta.len() > MAX_FILE_BYTES {
                ExternalSessionStatus::Unsupported
            } else {
                ExternalSessionStatus::Complete
            },
            fingerprint: format!("metadata:{}:{}", meta.len(), updated.unwrap_or(0)),
            source_location: path
                .strip_prefix(&self.codex_home)
                .ok()
                .map(|p| format!("$CODEX_HOME/{}", p.to_string_lossy().replace('\\', "/"))),
            target_workspace_id: None,
            target_workspace_name: None,
            imported_session_id: None,
        };
        self.headers
            .lock()
            .unwrap_or_else(|error| error.into_inner())
            .insert(
                path.to_path_buf(),
                CachedHeader {
                    modified: meta.modified().ok(),
                    size: meta.len(),
                    candidate: candidate.clone(),
                },
            );
        Ok(candidate)
    }
    fn read_path(
        &self,
        path: &Path,
        mode: ExternalSessionImportMode,
    ) -> Result<CodexSessionDocument, String> {
        let titles = self.title_snapshot();
        let mut candidate = self.inspect_path_with_titles(path, &titles)?;
        if candidate.file_size_bytes > MAX_FILE_BYTES {
            return Err("Source exceeds the 256 MiB import limit".into());
        }
        let mut reader = BufReader::new(File::open(path).map_err(|e| e.to_string())?);
        let mut hasher = Sha256::new();
        let mut state = Materializer::default();
        let mut line = Vec::new();
        let mut warnings = BTreeSet::new();
        let mut total = 0usize;
        let mut compacted = false;
        loop {
            line.clear();
            let read = reader
                .by_ref()
                .take((MAX_LINE_BYTES + 1) as u64)
                .read_until(b'\n', &mut line)
                .map_err(|e| e.to_string())?;
            if read == 0 {
                break;
            }
            if read > MAX_LINE_BYTES {
                return Err("JSONL line exceeds the 8 MiB import limit".into());
            }
            total += read;
            if total as u64 > MAX_FILE_BYTES {
                return Err("Source grew beyond the import limit".into());
            }
            hasher.update(&line);
            if line.iter().all(u8::is_ascii_whitespace) {
                continue;
            }
            let record: Value = match serde_json::from_slice(&line) {
                Ok(record) => record,
                Err(_)
                    if !line.ends_with(b"\n")
                        && reader.fill_buf().map_err(|e| e.to_string())?.is_empty() =>
                {
                    warnings.insert("torn_tail");
                    state.interrupt();
                    break;
                }
                Err(_) => {
                    return Err(
                        "Malformed JSONL inside the rollout; no partial import was created".into(),
                    )
                }
            };
            let time = timestamp(&record["timestamp"])
                .or(candidate.created_at)
                .unwrap_or(0);
            match record["type"].as_str().unwrap_or("") {
                "response_item" => state.item(
                    record["payload"].get("item").unwrap_or(&record["payload"]),
                    time,
                    mode,
                    &mut warnings,
                )?,
                "turn_context" => {
                    if let Some(model) = record["payload"]["model"].as_str() {
                        candidate.model_name = Some(model.into());
                    }
                }
                "event_msg" => state.event(&record["payload"], &mut warnings)?,
                "compacted" => {
                    compacted = true;
                    warnings.insert("compaction_present");
                    if mode == ExternalSessionImportMode::LatestCompacted {
                        let payload = &record["payload"];
                        if let Some(items) = payload["replacement_history"].as_array() {
                            state = Materializer::default();
                            for item in items {
                                state.item(item, time, mode, &mut warnings)?;
                            }
                        } else if let Some(summary) =
                            payload["message"].as_str().filter(|s| !s.is_empty())
                        {
                            state = Materializer::default();
                            state.item(
                                &json!({"type":"message","role":"user","content":format!("[Imported Codex compaction summary]\n{summary}")}),
                                time,
                                mode,
                                &mut warnings,
                            )?;
                            warnings.insert("summary_only");
                        } else {
                            return Err(
                                "Codex compaction has no readable replacement history or summary"
                                    .into(),
                            );
                        }
                    }
                }
                "session_meta" | "token_usage_record" | "retained_context" => {}
                _ => {
                    warnings.insert("unknown_records");
                }
            }
        }
        if mode == ExternalSessionImportMode::LatestCompacted && !compacted {
            warnings.insert("no_compaction");
        }
        state.finish();
        if state.turns.is_empty() {
            return Err("No usable human conversation was found".into());
        }
        if state.turns.len() > MAX_TURNS {
            return Err("Conversation exceeds the 4096 turn import limit".into());
        }
        let text_bytes: usize = state
            .turns
            .iter()
            .map(|t| {
                t.user_text.len()
                    + t.items
                        .iter()
                        .map(|i| serde_json::to_vec(i).map_or(0, |v| v.len()))
                        .sum::<usize>()
            })
            .sum();
        if text_bytes > MAX_DOCUMENT_BYTES {
            return Err("Converted history exceeds the 128 MiB storage budget".into());
        }
        candidate.fingerprint = format!("sha256:{}", hex::encode(hasher.finalize()));
        candidate.turn_count = Some(state.turns.len());
        candidate.status = state.turns.last().unwrap().status;
        Ok(CodexSessionDocument {
            candidate,
            turns: state.turns,
            warnings: warnings
                .into_iter()
                .map(|code| warning(code, code))
                .chain(titles.diagnostics.iter().cloned())
                .collect(),
        })
    }
}

#[derive(Default)]
struct Materializer {
    turns: Vec<ExternalSessionTurn>,
    seen: HashSet<String>,
}
impl Materializer {
    fn item(
        &mut self,
        item: &Value,
        time: u64,
        mode: ExternalSessionImportMode,
        warnings: &mut BTreeSet<&'static str>,
    ) -> Result<(), String> {
        if let Some(id) = item["id"].as_str() {
            if !self.seen.insert(id.into()) {
                return Ok(());
            }
        }
        match item["type"].as_str().unwrap_or("") {
            "message" | "agent_message" => {
                let text = content_text(&item["content"]);
                if item["content"].as_array().is_some_and(|items| {
                    items
                        .iter()
                        .any(|i| matches!(i["type"].as_str(), Some("input_image" | "image")))
                }) {
                    warnings.insert("images_not_imported");
                }
                if text.is_empty() {
                    return Ok(());
                }
                match item["role"].as_str().unwrap_or("assistant") {
                    "user" if !is_injected(&text) => {
                        self.finish();
                        self.turns.push(ExternalSessionTurn {
                            source_turn_id: format!("source-turn-{}", self.turns.len()),
                            timestamp: time,
                            user_text: text,
                            items: Vec::new(),
                            source_event_count: 1,
                            status: ExternalSessionStatus::Interrupted,
                        });
                    }
                    "assistant" => {
                        if let Some(turn) = self.turns.last_mut() {
                            turn.items.push(ExternalSessionItem::Text { text });
                            turn.source_event_count += 1;
                        }
                    }
                    _ => {
                        warnings.insert("source_instructions_not_imported");
                    }
                }
            }
            "reasoning" => {
                let text = content_text(&item["summary"]);
                if let Some(turn) = self.turns.last_mut() {
                    if !text.is_empty() {
                        turn.items.push(ExternalSessionItem::Thinking { text });
                    }
                }
            }
            "function_call" | "custom_tool_call" => {
                if let Some(turn) = self.turns.last_mut() {
                    let id = item["call_id"]
                        .as_str()
                        .or_else(|| item["id"].as_str())
                        .ok_or("Tool call id is missing")?
                        .to_owned();
                    let name = item["name"].as_str().unwrap_or("unknown").to_owned();
                    let raw = item
                        .get("arguments")
                        .or_else(|| item.get("input"))
                        .cloned()
                        .unwrap_or(Value::Null);
                    let input = raw
                        .as_str()
                        .and_then(|s| serde_json::from_str(s).ok())
                        .unwrap_or(raw);
                    turn.items.push(ExternalSessionItem::Tool {
                        id,
                        name,
                        input,
                        result: None,
                        success: None,
                    });
                    turn.source_event_count += 1;
                }
            }
            "function_call_output" | "custom_tool_call_output" => {
                let id = item["call_id"].as_str().unwrap_or("");
                let mut matched = false;
                for turn in self.turns.iter_mut().rev() {
                    if let Some(ExternalSessionItem::Tool {
                        result, success, ..
                    }) = turn.items.iter_mut().rev().find(
                        |i| matches!(i, ExternalSessionItem::Tool { id: call, .. } if call == id),
                    ) {
                        *result = Some(item.get("output").cloned().unwrap_or(Value::Null));
                        *success = Some(item["is_error"] != true);
                        matched = true;
                        break;
                    }
                }
                if !matched {
                    warnings.insert("orphan_tool_result");
                }
            }
            "compaction" | "context_compaction" => {
                warnings.insert("compaction_present");
                if mode == ExternalSessionImportMode::LatestCompacted {
                    return Err(
                        "Codex compacted history contains an encrypted context summary; select full history to preserve readable conversation"
                            .into(),
                    );
                }
            }
            _ => {
                warnings.insert("unsupported_response_item");
            }
        }
        Ok(())
    }
    fn event(
        &mut self,
        event: &Value,
        warnings: &mut BTreeSet<&'static str>,
    ) -> Result<(), String> {
        match event["type"].as_str().unwrap_or("") {
            "task_complete" | "turn_complete" => {
                if let Some(t) = self.turns.last_mut() {
                    t.status = ExternalSessionStatus::Complete;
                }
            }
            "turn_aborted" | "error" => self.interrupt(),
            "thread_rolled_back" => {
                let n = event["num_turns"]
                    .as_u64()
                    .ok_or("Invalid rollback count")? as usize;
                self.turns.truncate(self.turns.len().saturating_sub(n));
                self.seen.clear();
                warnings.insert("rolled_back_history");
            }
            // Event mirrors never become additional human prompts or assistant output.
            "user_message" | "agent_message" | "task_started" | "turn_started" | "token_count"
            | "agent_reasoning" | "item_completed" => {}
            _ => {
                warnings.insert("unknown_events");
            }
        }
        Ok(())
    }
    fn interrupt(&mut self) {
        if let Some(t) = self.turns.last_mut() {
            t.status = ExternalSessionStatus::Interrupted;
        }
    }
    fn finish(&mut self) {
        if let Some(t) = self.turns.last_mut() {
            if t.status == ExternalSessionStatus::Interrupted
                && t.items
                    .iter()
                    .any(|i| matches!(i, ExternalSessionItem::Text { .. }))
                && !t
                    .items
                    .iter()
                    .any(|i| matches!(i, ExternalSessionItem::Tool { result: None, .. }))
            {
                t.status = ExternalSessionStatus::Complete;
            }
        }
    }
}
fn collect(
    root: &Path,
    paths: &mut Vec<PathBuf>,
    depth: usize,
    visits: &mut usize,
) -> Result<(), String> {
    if depth > 8 {
        return Err("Codex session directory exceeds the discovery depth limit".into());
    }
    for entry in fs::read_dir(root).map_err(|e| e.to_string())? {
        *visits += 1;
        if *visits > MAX_FILES {
            return Err("Codex discovery exceeds 100000 directory entries".into());
        }
        let entry = entry.map_err(|e| e.to_string())?;
        let kind = entry.file_type().map_err(|e| e.to_string())?;
        if kind.is_symlink() {
            continue;
        }
        if kind.is_dir() {
            collect(&entry.path(), paths, depth + 1, visits)?;
        } else if kind.is_file()
            && entry.file_name().to_string_lossy().starts_with("rollout-")
            && entry.path().extension().is_some_and(|e| e == "jsonl")
        {
            paths.push(entry.path());
        }
    }
    Ok(())
}
fn candidate_id(path: &Path) -> String {
    format!(
        "codex:{}",
        hex::encode(Sha256::digest(path.to_string_lossy().as_bytes()))
    )
}
fn timestamp(value: &Value) -> Option<u64> {
    value.as_u64().or_else(|| {
        value
            .as_str()
            .and_then(|s| chrono::DateTime::parse_from_rfc3339(s).ok())
            .and_then(|d| u64::try_from(d.timestamp_millis()).ok())
    })
}
fn content_text(v: &Value) -> String {
    if let Some(text) = v.as_str() {
        return text.into();
    }
    v.as_array()
        .map(|items| {
            items
                .iter()
                .filter(|i| {
                    matches!(
                        i["type"].as_str(),
                        Some("input_text" | "output_text" | "text" | "summary_text")
                    )
                })
                .filter_map(|i| i["text"].as_str())
                .collect::<Vec<_>>()
                .join("\n")
        })
        .unwrap_or_default()
}
fn is_injected(text: &str) -> bool {
    let text = text.trim_start();
    text.starts_with("# AGENTS.md instructions for ")
        || text.starts_with("<environment_context>")
        || text.starts_with("<turn_aborted>")
        || text.starts_with("<permissions instructions>")
        || text.starts_with("<codex_internal_context ")
        || (text.starts_with("<external_codex_apps_open_page>")
            && text
                .trim_end()
                .ends_with("</external_codex_apps_open_page>"))
}
fn user_title_preview(text: &str) -> Option<String> {
    let mut text = text.trim();
    // These are Codex UI context envelopes, not the human's session name.
    for (start, end) in [
        ("<recommended_plugins>", "</recommended_plugins>"),
        ("<in-app-browser-context", "</in-app-browser-context>"),
    ] {
        if text.starts_with(start) {
            text = text.split_once(end)?.1.trim();
        }
    }
    if text.starts_with("# Files mentioned by the user:") {
        text = text.split_once("## My request:")?.1.trim();
    }
    (!text.is_empty()).then(|| preview(text, 120))
}

pub fn preview(text: &str, chars: usize) -> String {
    text.chars().take(chars).collect()
}
fn warning(code: &str, detail: &str) -> ExternalSessionImportWarning {
    ExternalSessionImportWarning {
        code: code.into(),
        detail: detail.into(),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn resumed_rollout(root: &Path, name: &str, timestamp: &str, answer: Option<&str>) -> PathBuf {
        let path = root.join("sessions").join(format!("rollout-{name}.jsonl"));
        let mut rows = vec![
            json!({"type":"session_meta","timestamp":timestamp,"payload":{"id":"one","cwd":"/project","timestamp":timestamp}}),
            msg("user", "Original question"),
        ];
        if let Some(answer) = answer {
            rows.push(msg("assistant", answer));
        }
        fs::write(
            &path,
            rows.iter()
                .map(Value::to_string)
                .collect::<Vec<_>>()
                .join("\n")
                + "\n",
        )
        .unwrap();
        path
    }

    #[test]
    fn resumed_threads_are_deduplicated_before_paging_and_legacy_locators_read_the_current_rollout()
    {
        let dir = tempfile::tempdir().unwrap();
        fs::create_dir(dir.path().join("sessions")).unwrap();
        let old = resumed_rollout(dir.path(), "old", "2026-10-15T03:08:00Z", None);
        let current = resumed_rollout(
            dir.path(),
            "current",
            "2026-10-15T03:22:00Z",
            Some("Complete answer"),
        );
        let reader = CodexSessionReader::new(dir.path().into());
        let page = reader.discover(0, 1, "").unwrap();
        assert_eq!(page.candidates.len(), 1);
        assert!(page.next_cursor.is_none());
        assert_eq!(page.candidates[0].candidate_id, candidate_id(&current));
        for reader in [reader, CodexSessionReader::new(dir.path().into())] {
            let document = reader
                .read_candidate(&candidate_id(&old), ExternalSessionImportMode::Full)
                .unwrap();
            assert_eq!(document.candidate.candidate_id, candidate_id(&current));
            assert!(
                matches!(&document.turns[0].items[0], ExternalSessionItem::Text { text } if text == "Complete answer")
            );
        }
    }

    #[test]
    fn state_locator_wins_over_retry_timestamps_and_refreshes_after_discovery() {
        let dir = tempfile::tempdir().unwrap();
        fs::create_dir(dir.path().join("sessions")).unwrap();
        let old = resumed_rollout(dir.path(), "old", "2026-10-15T03:22:00Z", None);
        let reader = CodexSessionReader::new(dir.path().into());
        reader.discover_all().unwrap();
        let current = resumed_rollout(
            dir.path(),
            "current",
            "2026-10-15T03:08:00Z",
            Some("Indexed answer"),
        );
        let connection = rusqlite::Connection::open(dir.path().join("state_5.sqlite")).unwrap();
        connection
            .execute_batch("CREATE TABLE threads (id TEXT, title TEXT, rollout_path TEXT)")
            .unwrap();
        connection
            .execute(
                "INSERT INTO threads VALUES ('one', 'Saved name', ?1)",
                [current.to_string_lossy().as_ref()],
            )
            .unwrap();
        let document = reader
            .read_candidate(&candidate_id(&old), ExternalSessionImportMode::Full)
            .unwrap();
        assert_eq!(document.candidate.candidate_id, candidate_id(&current));
        assert_eq!(
            reader.discover_all().unwrap().candidates[0].candidate_id,
            candidate_id(&current)
        );
    }

    #[test]
    #[ignore = "Read-only inspection of one installed Codex thread, selected by environment variable"]
    fn inspect_installed_codex_thread_history() {
        let id = std::env::var("OPENBITFUN_TEST_CODEX_THREAD")
            .expect("Set OPENBITFUN_TEST_CODEX_THREAD");
        let reader = CodexSessionReader::default();
        let catalog = reader.discover_all().unwrap();
        let candidates = catalog
            .candidates
            .iter()
            .filter(|candidate| candidate.source_session_id == id)
            .collect::<Vec<_>>();
        assert_eq!(candidates.len(), 1);
        let document = reader
            .read_candidate(&candidates[0].candidate_id, ExternalSessionImportMode::Full)
            .unwrap();
        let text_count = document
            .turns
            .iter()
            .flat_map(|turn| &turn.items)
            .filter(|item| matches!(item, ExternalSessionItem::Text { .. }))
            .count();
        let tool_count = document
            .turns
            .iter()
            .flat_map(|turn| &turn.items)
            .filter(|item| matches!(item, ExternalSessionItem::Tool { .. }))
            .count();
        assert!(!document.turns.is_empty());
        assert!(text_count > 0);
        println!("Codex history inspection: {} logical thread, {} turns, {} text items, {} tool items; warning codes: {:?}", candidates.len(), document.turns.len(), text_count, tool_count, document.warnings.iter().map(|warning| &warning.code).collect::<Vec<_>>());
    }

    #[test]
    fn persisted_names_override_prompt_previews_in_catalogs_and_imports() {
        let dir = fixture(vec![
            json!({"type":"session_meta","payload":{"id":"one","cwd":"/project"}}),
            msg("user", "Original question"),
            msg("assistant", "Saved answer"),
        ]);
        let connection = rusqlite::Connection::open(dir.path().join("state_5.sqlite")).unwrap();
        connection.execute_batch("CREATE TABLE threads (id TEXT, title TEXT, name TEXT, future_column TEXT);
            INSERT INTO threads VALUES ('one', 'Original question', 'User named conversation', 'ignored');").unwrap();
        fs::write(
            dir.path().join("session_index.jsonl"),
            "{\"id\":\"one\",\"thread_name\":\"Earlier indexed name\"}\n",
        )
        .unwrap();
        let reader = CodexSessionReader::new(dir.path().into());
        let catalog = reader.discover(0, 10, "User named").unwrap();
        assert!(catalog.diagnostics.is_empty());
        assert_eq!(catalog.candidates.len(), 1);
        let candidate = &catalog.candidates[0];
        assert_eq!(candidate.title.as_deref(), Some("User named conversation"));
        assert_eq!(
            candidate.fallback_title.as_deref(),
            Some("Original question")
        );
        assert!(candidate.title_is_source_name);
        let document = reader
            .read_candidate(&candidate.candidate_id, ExternalSessionImportMode::Full)
            .unwrap();
        assert_eq!(document.candidate.title, candidate.title);
        assert_eq!(document.turns[0].user_text, "Original question");
        assert_eq!(
            reader.discover_all().unwrap().candidates[0].title,
            candidate.title
        );
    }

    #[test]
    fn name_index_supports_older_state_schemas_and_refreshes_without_reading_rollouts() {
        use std::io::Write;
        let dir = fixture(vec![
            json!({"type":"session_meta","payload":{"id":"one","cwd":"/project"}}),
            msg("user", "Original question"),
        ]);
        fs::create_dir(dir.path().join("sqlite")).unwrap();
        let connection =
            rusqlite::Connection::open(dir.path().join("sqlite/state_4.sqlite")).unwrap();
        connection
            .execute_batch(
                "CREATE TABLE threads (id TEXT, title TEXT);
            INSERT INTO threads VALUES ('one', 'Old database title');",
            )
            .unwrap();
        let index = dir.path().join("session_index.jsonl");
        fs::write(
            &index,
            "{\"id\":\"one\",\"thread_name\":\"Initial name\"}\n",
        )
        .unwrap();
        let reader = CodexSessionReader::new(dir.path().into());
        let first = reader.discover_all().unwrap().candidates.remove(0);
        assert_eq!(first.title.as_deref(), Some("Initial name"));
        reader.discover_all().unwrap();
        assert_eq!(reader.titles.lock().unwrap().reads, 1);
        let mut writer = fs::OpenOptions::new().append(true).open(index).unwrap();
        writeln!(
            writer,
            "{}",
            json!({"id":"one","thread_name":"Renamed source conversation"})
        )
        .unwrap();
        let renamed = reader.discover_all().unwrap().candidates.remove(0);
        assert_eq!(
            renamed.title.as_deref(),
            Some("Renamed source conversation")
        );
        assert_eq!(
            reader
                .header_reads
                .load(std::sync::atomic::Ordering::Relaxed),
            1
        );
        assert_eq!(reader.titles.lock().unwrap().reads, 2);
    }

    #[test]
    fn source_rename_in_wal_invalidates_only_the_name_snapshot() {
        let dir = fixture(vec![
            json!({"type":"session_meta","payload":{"id":"one","cwd":"/project"}}),
            msg("user", "Original question"),
        ]);
        let database = dir.path().join("state_5.sqlite");
        let connection = rusqlite::Connection::open(&database).unwrap();
        connection
            .execute_batch(
                "PRAGMA journal_mode = WAL; PRAGMA wal_autocheckpoint = 0;
            CREATE TABLE threads (id TEXT, title TEXT, name TEXT);
            INSERT INTO threads VALUES ('one', 'Original question', 'Saved name');",
            )
            .unwrap();
        let reader = CodexSessionReader::new(dir.path().into());
        assert_eq!(
            reader.discover_all().unwrap().candidates[0]
                .title
                .as_deref(),
            Some("Saved name")
        );
        let main_database = fs::read(&database).unwrap();
        connection
            .execute(
                "UPDATE threads SET name = ?1 WHERE id = 'one'",
                ["Renamed while source is open"],
            )
            .unwrap();
        let catalog = reader.discover_all().unwrap();
        assert_eq!(
            catalog.candidates[0].title.as_deref(),
            Some("Renamed while source is open")
        );
        assert!(catalog.diagnostics.is_empty());
        assert_eq!(fs::read(database).unwrap(), main_database);
        assert_eq!(
            reader
                .header_reads
                .load(std::sync::atomic::Ordering::Relaxed),
            1
        );
    }

    #[test]
    fn unavailable_optional_title_store_preserves_candidates_and_reports_a_warning() {
        let dir = fixture(vec![
            json!({"type":"session_meta","payload":{"id":"one","cwd":"/project"}}),
            msg("user", "Original question"),
        ]);
        fs::write(dir.path().join("state_5.sqlite"), b"Not a SQLite database").unwrap();
        fs::write(
            dir.path().join("session_index.jsonl"),
            "{\"id\":\"one\",\"thread_name\":\"Saved fallback name\"}\n",
        )
        .unwrap();
        let catalog = CodexSessionReader::new(dir.path().into())
            .discover_all()
            .unwrap();
        assert_eq!(
            catalog.candidates[0].title.as_deref(),
            Some("Saved fallback name")
        );
        assert!(!catalog.candidates[0].title_is_source_name);
        assert!(catalog
            .diagnostics
            .iter()
            .any(|warning| warning.code == "source_titles_unreadable"));
    }

    #[test]
    fn unnamed_rollouts_use_the_human_request_without_context_envelopes() {
        let context = "<recommended_plugins>Available plugins</recommended_plugins>";
        let dir = fixture(vec![
            json!({"type":"session_meta","payload":{"id":"one","cwd":"/project"}}),
            msg("user", context),
            msg("user", "# Files mentioned by the user:\n\nphoto.png\n\n## My request:\nExplain this screenshot"),
        ]);
        let catalog = CodexSessionReader::new(dir.path().into())
            .discover_all()
            .unwrap();
        assert_eq!(
            catalog.candidates[0].title.as_deref(),
            Some("Explain this screenshot")
        );
        assert_eq!(
            catalog.candidates[0].fallback_title.as_deref(),
            Some(context)
        );
        assert!(!catalog.candidates[0].title_is_source_name);
    }

    #[test]
    #[ignore = "Reads installed Codex title metadata and rollout headers without printing conversation content"]
    fn inspect_installed_codex_session_titles() {
        let reader = CodexSessionReader::default();
        let catalog = reader.discover_all().unwrap();
        assert!(!catalog.candidates.is_empty());
        assert!(
            catalog.diagnostics.is_empty(),
            "{} source metadata warnings",
            catalog.diagnostics.len()
        );
        let named = catalog
            .candidates
            .iter()
            .filter(|candidate| candidate.title_is_source_name)
            .count();
        assert!(named > 0);
        println!(
            "Codex name inspection: {} candidates, {} saved source names, {} title-store reads",
            catalog.candidates.len(),
            named,
            reader.titles.lock().unwrap().reads
        );
    }

    #[test]
    fn automatic_discovery_includes_sessions_after_the_ui_page_limit() {
        let dir = tempfile::tempdir().unwrap();
        fs::create_dir(dir.path().join("sessions")).unwrap();
        for index in 0..57 {
            fs::write(dir.path().join(format!("sessions/rollout-{index}.jsonl")), format!("{}\n{}\n",
                json!({"type":"session_meta","payload":{"id":index.to_string(),"cwd":"/project"}}),
                msg("user", "Saved question"))).unwrap();
        }
        let reader = CodexSessionReader::new(dir.path().into());
        assert_eq!(reader.discover(0, 100, "").unwrap().candidates.len(), 50);
        let all = reader.discover_all().unwrap();
        assert_eq!(all.candidates.len(), 57);
        assert!(all.next_cursor.is_none());
        assert_eq!(
            reader
                .header_reads
                .load(std::sync::atomic::Ordering::Relaxed),
            57
        );
        reader.discover_all().unwrap();
        assert_eq!(
            reader
                .header_reads
                .load(std::sync::atomic::Ordering::Relaxed),
            57,
            "Refreshing unchanged source files must not read their headers again"
        );
    }

    #[test]
    fn opening_a_discovered_session_does_not_rescan_unrelated_directories() {
        let dir = fixture(vec![
            json!({"type":"session_meta","payload":{"id":"one","cwd":"/project"}}),
            msg("user", "First question"),
            msg("assistant", "Saved answer"),
        ]);
        let reader = CodexSessionReader::new(dir.path().into());
        let candidate = reader.discover_all().unwrap().candidates.remove(0);
        // An unrelated excessive directory tree would fail a full rescan.
        let mut nested = dir.path().join("sessions");
        for _ in 0..10 {
            nested = nested.join("nested");
        }
        fs::create_dir_all(nested).unwrap();
        assert!(reader.paths().is_err());
        let document = reader
            .read_candidate(&candidate.candidate_id, ExternalSessionImportMode::Full)
            .unwrap();
        assert_eq!(document.turns[0].user_text, "First question");
    }

    #[test]
    fn changed_source_headers_invalidate_cached_metadata() {
        let dir = fixture(vec![
            json!({"type":"session_meta","payload":{"id":"one","cwd":"/project"}}),
            msg("user", "First question"),
        ]);
        let reader = CodexSessionReader::new(dir.path().into());
        let path = reader.paths().unwrap().remove(0);
        let before = reader.inspect_path(&path).unwrap();
        fs::write(
            &path,
            format!(
                "{}\n{}\n",
                json!({"type":"session_meta","payload":{"id":"one","cwd":"/project"}}),
                msg("user", "Changed and longer question")
            ),
        )
        .unwrap();
        let after = reader.inspect_path(&path).unwrap();
        assert_eq!(after.title.as_deref(), Some("Changed and longer question"));
        assert_ne!(before.fingerprint, after.fingerprint);
        assert_eq!(
            reader
                .header_reads
                .load(std::sync::atomic::Ordering::Relaxed),
            2
        );
    }

    fn fixture(records: Vec<Value>) -> tempfile::TempDir {
        let dir = tempfile::tempdir().unwrap();
        fs::create_dir(dir.path().join("sessions")).unwrap();
        let mut lines = vec![json!({"type":"session_meta","payload":{"id":"s1","cwd":"/repo","timestamp":"2026-10-01T00:00:00Z"}}).to_string()];
        lines.extend(records.iter().map(Value::to_string));
        fs::write(
            dir.path().join("sessions/rollout-test.jsonl"),
            lines.join("\n") + "\n",
        )
        .unwrap();
        dir
    }
    fn msg(role: &str, text: &str) -> Value {
        json!({"type":"response_item","payload":{"type":"message","role":role,"content":[{"type":"input_text","text":text}]}})
    }
    #[test]
    fn deduplicates_mirrors_pairs_tools_and_preserves_turn_order() {
        let dir = fixture(vec![
            msg("user", "first"),
            json!({"type":"event_msg","payload":{"type":"user_message","message":"first"}}),
            json!({"type":"response_item","payload":{"type":"function_call","call_id":"c1","name":"exec_command","arguments":"{\"cmd\":\"test\"}"}}),
            json!({"type":"response_item","payload":{"type":"function_call_output","call_id":"c1","output":"ok"}}),
            msg("assistant", "done"),
            msg("user", "second"),
            msg("assistant", "next"),
        ]);
        let reader = CodexSessionReader::new(dir.path().into());
        let list = reader.discover(0, 50, "").unwrap();
        assert_eq!(list.candidates.len(), 1);
        assert_eq!(list.candidates[0].turn_count, None);
        let doc = reader
            .read_candidate(
                &list.candidates[0].candidate_id,
                ExternalSessionImportMode::Full,
            )
            .unwrap();
        assert_eq!(doc.turns.len(), 2);
        assert_eq!(doc.turns[0].items.len(), 2);
        assert!(
            matches!(&doc.turns[0].items[0], ExternalSessionItem::Tool { input, result: Some(_), .. } if input["cmd"] == "test")
        );
    }
    #[test]
    fn compaction_replaces_context_and_rollback_removes_suffix() {
        let dir = fixture(vec![
            msg("user", "old"),
            msg("assistant", "old reply"),
            json!({"type":"compacted","payload":{"replacement_history":[{"type":"message","role":"user","content":"summary"}]}}),
            msg("user", "discard"),
            json!({"type":"event_msg","payload":{"type":"thread_rolled_back","num_turns":1}}),
            msg("user", "keep"),
        ]);
        let reader = CodexSessionReader::new(dir.path().into());
        let list = reader.discover(0, 50, "").unwrap();
        let doc = reader
            .read_candidate(
                &list.candidates[0].candidate_id,
                ExternalSessionImportMode::LatestCompacted,
            )
            .unwrap();
        assert_eq!(
            doc.turns
                .iter()
                .map(|t| t.user_text.as_str())
                .collect::<Vec<_>>(),
            vec!["summary", "keep"]
        );
    }
    #[test]
    fn encrypted_compaction_requires_full_history_fallback() {
        let dir = fixture(vec![
            msg("user", "before"),
            msg("assistant", "answer"),
            json!({"type":"response_item","payload":{"type":"compaction","id":"compact-1"}}),
            msg("user", "after"),
            msg("assistant", "done"),
        ]);
        let reader = CodexSessionReader::new(dir.path().into());
        let list = reader.discover(0, 50, "").unwrap();
        let id = &list.candidates[0].candidate_id;
        let error = match reader.read_candidate(id, ExternalSessionImportMode::LatestCompacted) {
            Ok(_) => panic!("latest compacted history should require a readable fallback"),
            Err(error) => error,
        };
        assert!(error.contains("encrypted context summary"));
        let document = reader
            .read_candidate(id, ExternalSessionImportMode::Full)
            .unwrap();
        assert_eq!(document.turns.len(), 2);
        assert!(document
            .warnings
            .iter()
            .any(|warning| warning.code == "compaction_present"));
    }
    #[test]
    fn corrupt_middle_fails_and_torn_tail_is_disclosed() {
        let dir = fixture(vec![msg("user", "hello")]);
        let p = dir.path().join("sessions/rollout-test.jsonl");
        let reader = CodexSessionReader::new(dir.path().into());
        let mut bytes = fs::read(&p).unwrap();
        bytes.extend_from_slice(b"{broken");
        fs::write(&p, &bytes).unwrap();
        let doc = reader
            .read_path(&p, ExternalSessionImportMode::Full)
            .unwrap();
        assert!(doc.warnings.iter().any(|w| w.code == "torn_tail"));
        bytes.extend_from_slice(b"\n");
        fs::write(&p, bytes).unwrap();
        assert!(reader
            .read_path(&p, ExternalSessionImportMode::Full)
            .is_err());
    }
}
