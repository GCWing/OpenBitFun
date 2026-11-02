use openbitfun_product_domains::session_import::*;
use openbitfun_services_core::bounded_fs::{
    collect_bounded_regular_files_with_prune, is_symlink_or_reparse, read_bounded_text,
    BoundedDirectoryWalkLimits, BoundedTextRead,
};
use serde_json::Value;
use sha2::{Digest, Sha256};
use std::collections::{BTreeMap, HashMap};
use std::fs::File;
use std::io::{BufRead, BufReader, Read};
use std::path::{Path, PathBuf};
use std::time::UNIX_EPOCH;

mod desktop;
mod store;
#[cfg(test)]
mod tests;
mod translate;

pub const SOURCE_REVISION: &str = "cursor-session-history-v2";
const MAX_RECORD_BYTES: usize = 8 * 1024 * 1024;
const MAX_FILE_BYTES: usize = 256 * 1024 * 1024;
const MAX_DOCUMENT_BYTES: usize = 128 * 1024 * 1024;
const MAX_SESSIONS: usize = 100_000;

#[derive(Clone)]
pub struct CursorSessionReader {
    config_dir: PathBuf,
    data_dir: PathBuf,
    user_data_dir: PathBuf,
}

impl Default for CursorSessionReader {
    fn default() -> Self {
        let home = dirs::home_dir().unwrap_or_default();
        let config_dir = environment_path("CURSOR_CONFIG_DIR")
            .or_else(|| environment_path("XDG_CONFIG_HOME").map(|root| root.join("cursor")))
            .unwrap_or_else(|| home.join(".cursor"));
        let data_dir = environment_path("CURSOR_DATA_DIR").unwrap_or_else(|| home.join(".cursor"));
        let desktop = environment_path("OPENBITFUN_CURSOR_USER_DATA_DIR").unwrap_or_else(|| {
            #[cfg(target_os = "macos")]
            {
                home.join("Library/Application Support/Cursor")
            }
            #[cfg(not(target_os = "macos"))]
            {
                dirs::config_dir().unwrap_or_default().join("Cursor")
            }
        });
        Self::new(config_dir, data_dir, desktop)
    }
}

fn environment_path(name: &str) -> Option<PathBuf> {
    std::env::var_os(name)
        .filter(|value| !value.is_empty())
        .map(PathBuf::from)
}

enum Location {
    Cli(PathBuf),
    Desktop(PathBuf),
    Transcript(PathBuf),
}

struct Source {
    candidate: ExternalSessionCandidate,
    location: Location,
    metadata: Value,
}

impl CursorSessionReader {
    pub fn new(config_dir: PathBuf, data_dir: PathBuf, user_data_dir: PathBuf) -> Self {
        Self {
            config_dir,
            data_dir,
            user_data_dir,
        }
    }

    fn sources(&self) -> Result<(Vec<Source>, Vec<ExternalSessionImportWarning>), String> {
        for path in [&self.config_dir, &self.data_dir, &self.user_data_dir] {
            if !path.is_absolute() {
                return Err("Cursor source roots must be absolute host paths".into());
            }
        }
        let mut warnings = Vec::new();
        let mut sources = HashMap::<String, Source>::new();
        for path in files(&self.config_dir.join("chats"), 3, |p| {
            p.file_name().is_some_and(|n| n == "store.db")
        })? {
            match store::inspect(&path) {
                Ok(Some(source)) => {
                    let id = source.candidate.source_session_id.clone();
                    if sources
                        .get(&id)
                        .is_none_or(|old| old.candidate.updated_at < source.candidate.updated_at)
                    {
                        sources.insert(id, source);
                    }
                }
                Ok(None) => {}
                Err(error) => diagnostic(&mut warnings, "source_unreadable", &error),
            }
        }
        for source in desktop::discover(&self.user_data_dir, &mut warnings)? {
            let id = source.candidate.source_session_id.clone();
            if sources
                .get(&id)
                .is_none_or(|old| old.candidate.updated_at < source.candidate.updated_at)
            {
                sources.insert(id, source);
            }
        }
        let mut workspaces = BTreeMap::<String, Option<String>>::new();
        for source in sources.values() {
            if let Some(cwd) = &source.candidate.cwd {
                let slug = workspace_slug(cwd);
                workspaces
                    .entry(slug)
                    .and_modify(|old| {
                        if old.as_ref() != Some(cwd) {
                            *old = None;
                        }
                    })
                    .or_insert_with(|| Some(cwd.clone()));
            }
        }
        let projects = self.data_dir.join("projects");
        for path in transcript_files(&projects)? {
            let id = path.file_stem().and_then(|s| s.to_str()).unwrap_or("");
            if sources.contains_key(id) {
                continue;
            }
            if path.extension().is_some_and(|extension| extension == "txt") {
                diagnostic(&mut warnings, "plaintext_transcript_unsupported", "Cursor plaintext-only transcripts are unsupported; a local database or JSONL transcript is required");
                continue;
            }
            match inspect_transcript(&path, &projects, &workspaces) {
                Ok(source) => {
                    sources.insert(id.to_owned(), source);
                }
                Err(error) => diagnostic(&mut warnings, "source_unreadable", &error),
            }
        }
        if sources.len() > MAX_SESSIONS {
            return Err("Cursor session catalog exceeds the discovery limit".into());
        }
        let mut sources: Vec<_> = sources.into_values().collect();
        for source in &sources {
            if source.candidate.cwd.is_none() {
                diagnostic(&mut warnings, "workspace_unresolved", &format!("Cursor session {} has no unambiguous local workspace path and cannot be matched to a workspace", source.candidate.source_session_id));
            }
        }
        sources.sort_by(|a, b| {
            b.candidate
                .updated_at
                .cmp(&a.candidate.updated_at)
                .then_with(|| a.candidate.candidate_id.cmp(&b.candidate.candidate_id))
        });
        Ok((sources, warnings))
    }

    pub fn discover_all(&self) -> Result<ExternalSessionCatalog, String> {
        self.catalog(0, usize::MAX, "")
    }

    pub fn discover(
        &self,
        cursor: usize,
        limit: usize,
        query: &str,
    ) -> Result<ExternalSessionCatalog, String> {
        self.catalog(cursor, limit.clamp(1, 50), query)
    }

    fn catalog(
        &self,
        cursor: usize,
        limit: usize,
        query: &str,
    ) -> Result<ExternalSessionCatalog, String> {
        let (sources, diagnostics) = self.sources()?;
        let query = query.trim().to_lowercase();
        let candidates: Vec<_> = sources
            .into_iter()
            .map(|s| s.candidate)
            .filter(|c| {
                query.is_empty()
                    || format!(
                        "{} {}",
                        c.title.as_deref().unwrap_or(""),
                        c.cwd.as_deref().unwrap_or("")
                    )
                    .to_lowercase()
                    .contains(&query)
            })
            .collect();
        let end = cursor.saturating_add(limit).min(candidates.len());
        Ok(ExternalSessionCatalog {
            schema_version: EXTERNAL_SESSION_IMPORT_SCHEMA_V1,
            ecosystem_id: "cursor".into(),
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
            return Err("Cursor supports full-history import only".into());
        }
        let id = candidate_id
            .strip_prefix("cursor:")
            .filter(|id| valid_id(id))
            .ok_or("Invalid Cursor session candidate ID")?;
        let source = self
            .sources()?
            .0
            .into_iter()
            .find(|s| s.candidate.source_session_id == id)
            .ok_or("Cursor session was removed, moved or is unreadable; refresh the list")?;
        match &source.location {
            Location::Cli(_) => store::read(source),
            Location::Desktop(_) => desktop::read(source),
            Location::Transcript(path) => {
                let text = bounded_text(path, MAX_FILE_BYTES)?;
                let mut builder = translate::Builder::new(source.candidate);
                for (index, line) in text
                    .lines()
                    .enumerate()
                    .filter(|(_, line)| !line.trim().is_empty())
                {
                    if line.len() > MAX_RECORD_BYTES {
                        return Err("Cursor transcript record exceeds the read limit".into());
                    }
                    let record: Value = serde_json::from_str(line)
                        .map_err(|_| format!("Invalid Cursor transcript record {}", index + 1))?;
                    builder.message(&record, &format!("line-{}", index + 1))?;
                }
                builder.warn("transcript_projection", "Cursor JSONL transcripts may omit tool result bodies, IDs and separate thinking blocks; the source was preserved");
                builder.finish(text.as_bytes())
            }
        }
    }
}

fn valid_id(id: &str) -> bool {
    !id.is_empty()
        && id.len() <= 256
        && id
            .bytes()
            .all(|b| b.is_ascii_alphanumeric() || matches!(b, b'-' | b'_'))
}

fn files(
    root: &Path,
    depth: usize,
    matches: impl FnMut(&Path) -> bool,
) -> Result<Vec<PathBuf>, String> {
    validate_root(root)?;
    collect_bounded_regular_files_with_prune(
        root,
        BoundedDirectoryWalkLimits {
            max_depth: depth,
            max_entries: 500_000,
            max_directories: 200_000,
            max_files: MAX_SESSIONS,
        },
        |path| {
            path.strip_prefix(root)
                .is_ok_and(|p| p.components().count() <= depth)
        },
        matches,
    )
    .map_err(|error| format!("Cursor session discovery failed: {error}"))
}

fn validate_root(root: &Path) -> Result<(), String> {
    match std::fs::symlink_metadata(root) {
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => Ok(()),
        Err(error) => Err(format!("Cursor source directory is unreadable: {error}")),
        Ok(metadata) if !metadata.is_dir() || is_symlink_or_reparse(&metadata) => {
            Err("Cursor source root must be a regular directory".into())
        }
        Ok(_) => Ok(()),
    }
}

fn transcript_files(root: &Path) -> Result<Vec<PathBuf>, String> {
    validate_root(root)?;
    let mut paths = collect_bounded_regular_files_with_prune(
        root,
        BoundedDirectoryWalkLimits {
            max_depth: 3,
            max_entries: 500_000,
            max_directories: 200_000,
            max_files: MAX_SESSIONS,
        },
        |path| {
            let parts: Vec<_> = path
                .strip_prefix(root)
                .unwrap_or(path)
                .components()
                .collect();
            parts.len() == 1
                || (parts
                    .get(1)
                    .is_some_and(|p| p.as_os_str() == "agent-transcripts")
                    && (parts.len() == 2
                        || (parts.len() == 3 && parts[2].as_os_str() != "subagents")))
        },
        |path| {
            path.extension().is_some_and(|e| e == "jsonl" || e == "txt")
                && path
                    .components()
                    .any(|p| p.as_os_str() == "agent-transcripts")
        },
    )
    .map_err(|error| format!("Cursor transcript discovery failed: {error}"))?;
    paths.sort_by_key(|path| path.extension().is_some_and(|extension| extension == "txt"));
    Ok(paths)
}

fn inspect_transcript(
    path: &Path,
    projects: &Path,
    workspaces: &BTreeMap<String, Option<String>>,
) -> Result<Source, String> {
    let id = path
        .file_stem()
        .and_then(|s| s.to_str())
        .filter(|id| valid_id(id))
        .ok_or("Invalid Cursor transcript filename")?;
    let metadata = std::fs::metadata(path).map_err(|e| e.to_string())?;
    let mut reader = BufReader::new(
        File::open(path)
            .map_err(|e| e.to_string())?
            .take(256 * 1024),
    );
    let mut line = String::new();
    let mut title = None;
    while reader.read_line(&mut line).map_err(|e| e.to_string())? > 0 {
        if let Ok(record) = serde_json::from_str::<Value>(&line) {
            if record["role"] == "user" {
                title = translate::message_text(&record);
                if title.is_some() {
                    break;
                }
            }
        }
        line.clear();
    }
    let slug = path
        .strip_prefix(projects)
        .ok()
        .and_then(|p| p.components().next())
        .map(|p| p.as_os_str().to_string_lossy());
    let cwd = slug
        .as_ref()
        .and_then(|slug| workspaces.get(slug.as_ref()))
        .cloned()
        .flatten();
    let mut candidate = candidate(id, path, "cursor-transcript-jsonl");
    candidate.title = title.map(|text| text.chars().take(120).collect());
    candidate.cwd = cwd;
    candidate.updated_at = metadata
        .modified()
        .ok()
        .and_then(|time| time.duration_since(UNIX_EPOCH).ok())
        .map(|time| time.as_millis() as u64);
    candidate.file_size_bytes = metadata.len();
    candidate.fingerprint = format!(
        "cursor-jsonl:{}:{}",
        metadata.len(),
        candidate.updated_at.unwrap_or(0)
    );
    Ok(Source {
        candidate,
        location: Location::Transcript(path.into()),
        metadata: Value::Null,
    })
}

fn workspace_slug(path: &str) -> String {
    path.split(|c: char| !c.is_ascii_alphanumeric())
        .filter(|part| !part.is_empty())
        .collect::<Vec<_>>()
        .join("-")
}

fn candidate(id: &str, path: &Path, format: &str) -> ExternalSessionCandidate {
    ExternalSessionCandidate {
        candidate_id: format!("cursor:{id}"),
        ecosystem_id: "cursor".into(),
        source_session_id: id.into(),
        title: None,
        fallback_title: None,
        title_is_source_name: false,
        cwd: None,
        created_at: None,
        updated_at: None,
        model_provider: None,
        model_name: None,
        turn_count: None,
        file_size_bytes: 0,
        format_version: Some(format.into()),
        status: ExternalSessionStatus::Complete,
        fingerprint: String::new(),
        source_location: Some(path.display().to_string()),
        target_workspace_id: None,
        target_workspace_name: None,
        imported_session_id: None,
    }
}

fn bounded_text(path: &Path, limit: usize) -> Result<String, String> {
    let metadata =
        std::fs::symlink_metadata(path).map_err(|e| format!("Cursor source is unreadable: {e}"))?;
    if !metadata.is_file() || is_symlink_or_reparse(&metadata) {
        return Err("Cursor source must be a regular non-link file".into());
    }
    match read_bounded_text(path, limit).map_err(|e| format!("Cursor source is unreadable: {e}"))? {
        BoundedTextRead::Content(text) => Ok(text),
        _ => Err("Cursor source exceeds the read limit or is not UTF-8".into()),
    }
}

fn diagnostic(warnings: &mut Vec<ExternalSessionImportWarning>, code: &str, detail: &str) {
    if warnings.len() < 20 {
        warnings.push(ExternalSessionImportWarning {
            code: code.into(),
            detail: detail.into(),
        });
    }
}

fn timestamp(value: &Value) -> Option<u64> {
    value.as_u64().or_else(|| {
        value
            .as_str()
            .and_then(|text| chrono::DateTime::parse_from_rfc3339(text).ok())
            .and_then(|time| u64::try_from(time.timestamp_millis()).ok())
    })
}

fn uri_path(value: &Value) -> Option<String> {
    if let Some(text) = value.as_str() {
        return url::Url::parse(text)
            .ok()
            .and_then(|uri| uri.to_file_path().ok())
            .map(|p| p.to_string_lossy().into_owned());
    }
    if value["scheme"] == "file" {
        let mut uri = url::Url::parse("file:///").ok()?;
        uri.set_path(value["path"].as_str()?);
        if let Some(authority) = value["authority"].as_str().filter(|s| !s.is_empty()) {
            uri.set_host(Some(authority)).ok()?;
        }
        return uri
            .to_file_path()
            .ok()
            .map(|p| p.to_string_lossy().into_owned());
    }
    None
}
