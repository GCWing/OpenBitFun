//! Codex keeps display names outside its rollout files. Read one small,
//! cached metadata snapshot per discovery, including committed WAL records.
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
    let mut query = connection
        .prepare(&format!(
            "SELECT id, {name}, {title}, {rollout_path} FROM threads ORDER BY id LIMIT ?1",
        ))
        .map_err(read_error)?;
    let rows = query
        .query_map([MAX_FILES as i64 + 1], |row| {
            Ok((
                row.get::<_, String>(0)?,
                row.get::<_, Option<String>>(1)?,
                row.get::<_, Option<String>>(2)?,
                row.get::<_, Option<String>>(3)?,
            ))
        })
        .map_err(read_error)?;
    for (index, row) in rows.enumerate() {
        if index >= MAX_FILES {
            return Err("Codex title catalog exceeds the discovery limit".into());
        }
        let (id, name, title, rollout_path) = row.map_err(read_error)?;
        if let Some(path) = rollout_path.filter(|path| !path.trim().is_empty()) {
            snapshot.rollout_paths.entry(id.clone()).or_insert(path);
        }
        if let Some(name) = name.filter(|name| !name.trim().is_empty()) {
            snapshot.names.entry(id.clone()).or_insert(name);
        }
        if let Some(title) = title.filter(|title| !title.trim().is_empty()) {
            snapshot.titles.entry(id).or_insert(title);
        }
    }
    Ok(())
}
