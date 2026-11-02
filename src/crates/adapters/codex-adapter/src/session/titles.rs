//! Read one cached state/index metadata snapshot, including committed WAL
//! records. Paginated threads have no rollout file to discover on disk.
use super::*;
use rusqlite::{Connection, OpenFlags};
use std::time::Duration;

const MAX_INDEX_BYTES: u64 = 32 * 1024 * 1024;

#[derive(Default)]
pub(super) struct TitleSnapshot {
    names: HashMap<String, String>,
    indexed_names: HashMap<String, String>,
    titles: HashMap<String, String>,
    rollout_paths: HashMap<String, String>,
    pub(super) paginated: HashMap<String, super::sqlite_history::Thread>,
    pub(super) diagnostics: Vec<ExternalSessionImportWarning>,
}

impl TitleSnapshot {
    pub(super) fn current_rollout(&self, source_id: &str) -> Option<&str> {
        self.rollout_paths.get(source_id).map(String::as_str)
    }

    pub(super) fn is_current_rollout(&self, source_id: &str, path: &Path) -> bool {
        self.rollout_paths.get(source_id).is_some_and(|current| {
            rollout_path_key(current) == rollout_path_key(&path.to_string_lossy())
        })
    }

    pub(super) fn apply(&self, candidate: &mut ExternalSessionCandidate) {
        if let Some(title) = self
            .names
            .get(&candidate.source_session_id)
            .or_else(|| self.indexed_names.get(&candidate.source_session_id))
            .or_else(|| self.titles.get(&candidate.source_session_id))
        {
            candidate.title = Some(title.clone());
            candidate.title_is_source_name = self.diagnostics.is_empty();
        }
    }
}

fn rollout_path_key(path: &str) -> String {
    let path = path.strip_prefix("\\\\?\\").unwrap_or(path);
    if cfg!(windows) {
        path.replace('\\', "/").to_lowercase()
    } else {
        path.to_owned()
    }
}

type Stamp = Vec<(PathBuf, Option<SystemTime>, u64)>;

#[derive(Default)]
pub(super) struct TitleCache {
    cached: Option<(Stamp, Arc<TitleSnapshot>)>,
    #[cfg(test)]
    pub(super) reads: usize,
}

impl TitleCache {
    pub(super) fn snapshot(&mut self, root: &Path) -> Arc<TitleSnapshot> {
        let mut snapshot = TitleSnapshot::default();
        let databases = match database_paths(root) {
            Ok(paths) => paths,
            Err(error) => {
                snapshot
                    .diagnostics
                    .push(warning("source_titles_unreadable", &error));
                Vec::new()
            }
        };
        let index = root.join("session_index.jsonl");
        let mut stamp_paths = vec![index.clone()];
        for path in &databases {
            stamp_paths.push(path.clone());
            stamp_paths.push(path.with_file_name(format!(
                "{}-wal",
                path.file_name().unwrap_or_default().to_string_lossy(),
            )));
        }
        let stamp = stamp_paths
            .into_iter()
            .map(|path| {
                let metadata = fs::metadata(&path).ok();
                let modified = metadata
                    .as_ref()
                    .and_then(|metadata| metadata.modified().ok());
                let size = metadata.map_or(0, |metadata| metadata.len());
                (path, modified, size)
            })
            .collect::<Vec<_>>();
        if snapshot.diagnostics.is_empty() {
            if let Some((previous, snapshot)) = &self.cached {
                if previous == &stamp {
                    return snapshot.clone();
                }
            }
        }
        #[cfg(test)]
        {
            self.reads += 1;
        }
        if let Err(error) = read_index(&index, &mut snapshot.indexed_names) {
            snapshot
                .diagnostics
                .push(warning("source_titles_unreadable", &error));
        }
        // Current Codex stores state at the home root. Older installations may
        // keep it under sqlite/; they only fill names absent from the root DB.
        for database in databases {
            if let Err(error) = read_database(&database, &mut snapshot) {
                snapshot
                    .diagnostics
                    .push(warning("source_titles_unreadable", &error));
            }
        }
        let snapshot = Arc::new(snapshot);
        if snapshot.diagnostics.is_empty() {
            self.cached = Some((stamp, snapshot.clone()));
        }
        snapshot
    }
}

fn database_paths(root: &Path) -> Result<Vec<PathBuf>, String> {
    let mut paths = Vec::new();
    for directory in [root.to_path_buf(), root.join("sqlite")] {
        let entries = match fs::read_dir(directory) {
            Ok(entries) => entries,
            Err(error) if error.kind() == std::io::ErrorKind::NotFound => continue,
            Err(error) => return Err(format!("Codex title store cannot be listed: {error}")),
        };
        let mut latest = None;
        for entry in entries {
            let entry = entry.map_err(|error| error.to_string())?;
            let filename = entry.file_name();
            let filename = filename.to_string_lossy();
            let Some(version) = filename
                .strip_prefix("state_")
                .and_then(|name| name.strip_suffix(".sqlite"))
                .and_then(|version| version.parse::<u32>().ok())
            else {
                continue;
            };
            if entry
                .file_type()
                .map_err(|error| error.to_string())?
                .is_file()
                && latest
                    .as_ref()
                    .is_none_or(|(previous, _)| version > *previous)
            {
                latest = Some((version, entry.path()));
            }
        }
        if let Some((_, path)) = latest {
            paths.push(path);
        }
    }
    Ok(paths)
}

fn read_index(path: &Path, names: &mut HashMap<String, String>) -> Result<(), String> {
    let file = match File::open(path) {
        Ok(file) => file,
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => return Ok(()),
        Err(error) => return Err(format!("Codex session name index cannot be read: {error}")),
    };
    if file.metadata().map_err(|error| error.to_string())?.len() > MAX_INDEX_BYTES {
        return Err("Codex session name index exceeds the 32 MiB read limit".into());
    }
    let mut malformed = false;
    for line in BufReader::new(file.take(MAX_INDEX_BYTES)).lines() {
        let line = line.map_err(|error| error.to_string())?;
        if line.trim().is_empty() {
            continue;
        }
        let value: Value = match serde_json::from_str(&line) {
            Ok(value) => value,
            Err(_) => {
                malformed = true;
                continue;
            }
        };
        if let (Some(id), Some(name)) = (
            value["id"].as_str(),
            value["thread_name"]
                .as_str()
                .filter(|name| !name.trim().is_empty()),
        ) {
            // The JSONL index is append-only; the last named entry wins.
            names.insert(id.to_string(), name.to_string());
        }
    }
    if malformed {
        return Err("Codex session name index contains unreadable entries".into());
    }
    Ok(())
}

fn read_database(path: &Path, snapshot: &mut TitleSnapshot) -> Result<(), String> {
    let read_error = |error| format!("Codex session title database cannot be read: {error}");
    let connection = Connection::open_with_flags(
        path,
        OpenFlags::SQLITE_OPEN_READ_ONLY | OpenFlags::SQLITE_OPEN_NO_MUTEX,
    )
    .map_err(read_error)?;
    connection
        .busy_timeout(Duration::from_secs(2))
        .map_err(read_error)?;
    // Do not set immutable=1: a running Codex can keep its latest name in WAL.
    connection
        .execute_batch("PRAGMA query_only = ON; BEGIN DEFERRED TRANSACTION;")
        .map_err(read_error)?;
    let columns = connection
        .prepare("PRAGMA table_info(threads)")
        .map_err(read_error)?
        .query_map([], |row| row.get::<_, String>(1))
        .map_err(read_error)?
        .collect::<Result<HashSet<_>, _>>()
        .map_err(read_error)?;
    if !columns.contains("id") || (!columns.contains("name") && !columns.contains("title")) {
        return Err("Unsupported Codex title metadata schema; using available name index and rollout headers".into());
    }
    let name = if columns.contains("name") {
        "name"
    } else {
        "NULL"
    };
    let title = if columns.contains("title") {
        "title"
    } else {
        "NULL"
    };
    let rollout_path = if columns.contains("rollout_path") {
        "rollout_path"
    } else {
        "NULL"
    };
    let optional = |name: &str| {
        if columns.contains(name) {
            name.to_owned()
        } else {
            "NULL".into()
        }
    };
    let millis = |name: &str| {
        let ms = format!("{name}_ms");
        if columns.contains(&ms) {
            format!(
                "COALESCE({ms}, {})",
                if columns.contains(name) {
                    format!("{name} * 1000")
                } else {
                    "NULL".into()
                }
            )
        } else if columns.contains(name) {
            format!("{name} * 1000")
        } else {
            "NULL".into()
        }
    };
    let metadata_columns = [
        optional("history_mode"),
        optional("cwd"),
        millis("created_at"),
        millis("updated_at"),
        optional("source"),
        optional("first_user_message"),
        optional("model_provider"),
        optional("model"),
        optional("cli_version"),
    ]
    .join(", ");
    let mut query = connection
        .prepare(&format!(
            "SELECT id, {name}, {title}, {rollout_path}, {metadata_columns} FROM threads ORDER BY id LIMIT ?1",
        ))
        .map_err(read_error)?;
    let rows = query
        .query_map([MAX_FILES as i64 + 1], |row| {
            Ok((
                row.get::<_, String>(0)?,
                row.get::<_, Option<String>>(1)?,
                row.get::<_, Option<String>>(2)?,
                row.get::<_, Option<String>>(3)?,
                row.get::<_, Option<String>>(4)?,
                row.get::<_, Option<String>>(5)?,
                row.get::<_, Option<i64>>(6)?,
                row.get::<_, Option<i64>>(7)?,
                row.get::<_, Option<String>>(8)?,
                row.get::<_, Option<String>>(9)?,
                row.get::<_, Option<String>>(10)?,
                row.get::<_, Option<String>>(11)?,
                row.get::<_, Option<String>>(12)?,
            ))
        })
        .map_err(read_error)?;
    for (index, row) in rows.enumerate() {
        if index >= MAX_FILES {
            return Err("Codex title catalog exceeds the discovery limit".into());
        }
        let (
            id,
            name,
            title,
            rollout_path,
            history_mode,
            cwd,
            created_at,
            updated_at,
            source,
            first_user_message,
            model_provider,
            model_name,
            format_version,
        ) = row.map_err(read_error)?;
        if let Some(path) = rollout_path.as_ref().filter(|path| !path.trim().is_empty()) {
            snapshot
                .rollout_paths
                .entry(id.clone())
                .or_insert_with(|| path.clone());
        }
        if let Some(name) = name.filter(|name| !name.trim().is_empty()) {
            snapshot.names.entry(id.clone()).or_insert(name);
        }
        if let Some(title) = title.filter(|title| !title.trim().is_empty()) {
            snapshot.titles.entry(id.clone()).or_insert(title);
        }
        if history_mode.as_deref() == Some("paginated") {
            let updated_at = updated_at.and_then(|time| u64::try_from(time).ok());
            let candidate = ExternalSessionCandidate {
                candidate_id: format!("codex:thread:{id}"),
                ecosystem_id: "codex".into(),
                source_session_id: id.clone(),
                title: first_user_message.as_deref().and_then(user_title_preview),
                fallback_title: first_user_message.as_deref().map(|text| preview(text, 120)),
                title_is_source_name: false,
                cwd,
                created_at: created_at.and_then(|time| u64::try_from(time).ok()),
                updated_at,
                model_provider,
                model_name,
                turn_count: None,
                file_size_bytes: 0,
                format_version,
                status: ExternalSessionStatus::Complete,
                fingerprint: format!("metadata:paginated:{}", updated_at.unwrap_or(0)),
                source_location: Some(format!("$CODEX_HOME/thread_history_1.sqlite#{id}")),
                target_workspace_id: None,
                target_workspace_name: None,
                imported_session_id: None,
            };
            let subagent = source
                .as_deref()
                .and_then(|source| serde_json::from_str::<Value>(source).ok())
                .is_some_and(|source| source.get("subagent").is_some());
            snapshot
                .paginated
                .entry(id)
                .or_insert(super::sqlite_history::Thread {
                    candidate,
                    rollout_path,
                    subagent,
                    directory: path.parent().unwrap_or_else(|| Path::new("")).to_path_buf(),
                });
        }
    }
    Ok(())
}
