//! Session metadata file and index IO owner.
//!
//! Workspace-to-sessions-root resolution stays in product assembly. This module
//! owns the provider-neutral metadata file layout under an already resolved
//! sessions root.

use super::layout::SessionStorageLayout;
use super::metadata::{
    build_session_index_snapshot, remove_session_index_entry, upsert_session_index_entry,
};
use super::ordinal;
use super::page::{build_session_metadata_page, empty_session_metadata_page};
use super::types::{SessionMetadata, StoredSessionIndexFile, StoredSessionMetadataFile};
use super::SessionMetadataPage;
use crate::file_lock::{FileLock, FileLockError, FileLockMode};
use crate::json_store::{JsonFileStore, JsonFileStoreError};
use log::warn;
use openbitfun_core_types::validate_session_id;
use std::collections::HashMap;
use std::path::{Path, PathBuf};
use std::sync::{Arc, OnceLock};
use std::time::{SystemTime, UNIX_EPOCH};
use thiserror::Error;
use tokio::fs;
use tokio::sync::Mutex;

static SESSION_INDEX_LOCKS: OnceLock<Mutex<HashMap<PathBuf, Arc<Mutex<()>>>>> = OnceLock::new();

#[derive(Debug, Error)]
pub enum SessionMetadataStoreError {
    #[error(transparent)]
    Json(#[from] JsonFileStoreError),
    #[error("Failed to read sessions root: {source}")]
    ReadSessionsRoot {
        #[source]
        source: std::io::Error,
    },
    #[error("Failed to read session directory entry: {source}")]
    ReadSessionDirectoryEntry {
        #[source]
        source: std::io::Error,
    },
    #[error("Failed to get file type: {source}")]
    GetFileType {
        #[source]
        source: std::io::Error,
    },
    #[error("Failed to create session directory: {source}")]
    CreateSessionDir {
        #[source]
        source: std::io::Error,
    },
    #[error("Failed to lock Session index {path}: {source}")]
    LockSessionIndex {
        path: PathBuf,
        #[source]
        source: std::io::Error,
    },
    #[error("Failed to delete session directory: {source}")]
    DeleteSessionDir {
        #[source]
        source: std::io::Error,
    },
    #[error("Invalid session ID: {0}")]
    InvalidSessionId(String),
    #[error("Workspace session number capacity has been exhausted")]
    SessionNumberExhausted,
    #[error("Failed to resolve session storage path {path}: {source}")]
    ResolveSessionStoragePath {
        path: PathBuf,
        #[source]
        source: std::io::Error,
    },
    #[error("Session path escapes the sessions root: path={path}, root={root}")]
    UnsafeSessionStoragePath { path: PathBuf, root: PathBuf },
}

impl SessionMetadataStoreError {
    pub fn is_deserialization(&self) -> bool {
        matches!(self, Self::Json(error) if error.is_deserialization())
    }

    pub fn is_serialization(&self) -> bool {
        matches!(self, Self::Json(error) if error.is_serialization())
    }
}

#[derive(Debug, Clone)]
pub struct SessionMetadataStore {
    layout: SessionStorageLayout,
    json_store: JsonFileStore,
}

static SESSION_CATALOG_REVISION: OnceLock<tokio::sync::watch::Sender<u64>> = OnceLock::new();

impl SessionMetadataStore {
    /// Host-local invalidation only. Persisted metadata remains authoritative.
    pub fn subscribe_catalog_changes() -> tokio::sync::watch::Receiver<u64> {
        SESSION_CATALOG_REVISION
            .get_or_init(|| tokio::sync::watch::channel(0).0)
            .subscribe()
    }

    pub fn notify_catalog_changed() {
        SESSION_CATALOG_REVISION
            .get_or_init(|| tokio::sync::watch::channel(0).0)
            .send_modify(|revision| *revision = revision.wrapping_add(1));
    }

    pub fn new(sessions_root: impl Into<PathBuf>) -> Self {
        Self {
            layout: SessionStorageLayout::new(sessions_root),
            json_store: JsonFileStore,
        }
    }

    pub fn sessions_root(&self) -> &Path {
        self.layout.sessions_root()
    }

    fn index_path(&self) -> PathBuf {
        self.layout.index_path()
    }

    fn session_dir(&self, session_id: &str) -> PathBuf {
        self.layout.session_dir(session_id)
    }

    fn metadata_path(&self, session_id: &str) -> PathBuf {
        self.layout.metadata_path(session_id)
    }

    async fn get_index_lock(&self) -> Arc<Mutex<()>> {
        let index_path = self.index_path();
        let registry = SESSION_INDEX_LOCKS.get_or_init(|| Mutex::new(HashMap::new()));
        let mut registry_guard = registry.lock().await;
        registry_guard
            .entry(index_path)
            .or_insert_with(|| Arc::new(Mutex::new(())))
            .clone()
    }

    async fn lock_index_file(&self) -> Result<FileLock, SessionMetadataStoreError> {
        fs::create_dir_all(self.sessions_root())
            .await
            .map_err(|source| SessionMetadataStoreError::CreateSessionDir { source })?;
        let lock_path = self.sessions_root().join(".index.lock");
        let task_path = lock_path.clone();
        tokio::task::spawn_blocking(move || FileLock::acquire(&task_path, FileLockMode::Exclusive))
            .await
            .map_err(|error| SessionMetadataStoreError::LockSessionIndex {
                path: lock_path.clone(),
                source: std::io::Error::other(error),
            })?
            .map_err(|error| SessionMetadataStoreError::LockSessionIndex {
                path: lock_path,
                source: match error {
                    FileLockError::Open(source) | FileLockError::Unavailable(source) => source,
                },
            })
    }

    async fn read_json_optional<T: serde::de::DeserializeOwned>(
        &self,
        path: &Path,
    ) -> Result<Option<T>, SessionMetadataStoreError> {
        self.json_store
            .read_optional(path)
            .await
            .map_err(SessionMetadataStoreError::from)
    }

    async fn write_json_atomic<T: serde::Serialize>(
        &self,
        path: &Path,
        value: &T,
    ) -> Result<(), SessionMetadataStoreError> {
        self.json_store
            .write_atomic(path, value)
            .await
            .map_err(SessionMetadataStoreError::from)
    }

    async fn scan_metadata_dirs(&self) -> Result<Vec<SessionMetadata>, SessionMetadataStoreError> {
        if !self.sessions_root().exists() {
            return Ok(Vec::new());
        }

        let mut metadata_list = Vec::new();
        let mut entries = fs::read_dir(self.sessions_root())
            .await
            .map_err(|source| SessionMetadataStoreError::ReadSessionsRoot { source })?;

        while let Some(entry) = entries
            .next_entry()
            .await
            .map_err(|source| SessionMetadataStoreError::ReadSessionDirectoryEntry { source })?
        {
            let file_type = entry
                .file_type()
                .await
                .map_err(|source| SessionMetadataStoreError::GetFileType { source })?;
            if !file_type.is_dir() {
                continue;
            }

            let session_id = entry.file_name().to_string_lossy().to_string();
            match self.load_metadata(&session_id).await {
                Ok(Some(metadata)) => metadata_list.push(metadata),
                Ok(None) => {}
                Err(error) => {
                    warn!(
                        "Failed to rebuild session index entry: session_id={}, error={}",
                        session_id, error
                    );
                }
            }
        }

        metadata_list.sort_by_key(|metadata| std::cmp::Reverse(metadata.last_active_at));
        Ok(metadata_list)
    }

    async fn count_metadata_dirs(&self) -> Result<usize, SessionMetadataStoreError> {
        if !self.sessions_root().exists() {
            return Ok(0);
        }

        let mut count = 0;
        let mut entries = fs::read_dir(self.sessions_root())
            .await
            .map_err(|source| SessionMetadataStoreError::ReadSessionsRoot { source })?;

        while let Some(entry) = entries
            .next_entry()
            .await
            .map_err(|source| SessionMetadataStoreError::ReadSessionDirectoryEntry { source })?
        {
            let file_type = entry
                .file_type()
                .await
                .map_err(|source| SessionMetadataStoreError::GetFileType { source })?;
            if !file_type.is_dir() {
                continue;
            }

            let session_id = entry.file_name().to_string_lossy().to_string();
            if self.metadata_path(&session_id).exists() {
                count += 1;
            }
        }

        Ok(count)
    }

    async fn rebuild_index_snapshot_locked(
        &self,
    ) -> Result<(StoredSessionIndexFile, Vec<SessionMetadata>), SessionMetadataStoreError> {
        let metadata_list = self.scan_metadata_dirs().await?;
        let (index, visible_sessions) =
            build_session_index_snapshot(metadata_list, current_unix_ms());
        self.write_json_atomic(&self.index_path(), &index).await?;
        Ok((index, visible_sessions))
    }

    async fn rebuild_index_locked(
        &self,
    ) -> Result<Vec<SessionMetadata>, SessionMetadataStoreError> {
        self.rebuild_index_snapshot_locked()
            .await
            .map(|(_, visible_sessions)| visible_sessions)
    }

    /// Load the rebuildable Session index while the caller owns both index locks.
    ///
    /// Per-session `metadata.json` files are authoritative. Older OpenBitFun versions
    /// can leave `index.json` missing, empty, or truncated if the machine stops
    /// during the Windows direct-overwrite fallback. Treat only index
    /// deserialization failures as recoverable; real filesystem errors must still
    /// reach the caller.
    async fn read_or_rebuild_index_locked(
        &self,
    ) -> Result<(StoredSessionIndexFile, bool), SessionMetadataStoreError> {
        let index_path = self.index_path();
        match self
            .read_json_optional::<StoredSessionIndexFile>(&index_path)
            .await
        {
            Ok(Some(index)) => Ok((index, false)),
            Ok(None) => self
                .rebuild_index_snapshot_locked()
                .await
                .map(|(index, _)| (index, true)),
            Err(error) if error.is_deserialization() => {
                warn!(
                    "Session index is unreadable; rebuilding from per-session metadata: path={}, error={}",
                    index_path.display(),
                    error
                );
                self.rebuild_index_snapshot_locked()
                    .await
                    .map(|(index, _)| (index, true))
            }
            Err(error) => Err(error),
        }
    }

    async fn upsert_index_entry_locked(
        &self,
        metadata: &SessionMetadata,
        metadata_file_created: bool,
    ) -> Result<(), SessionMetadataStoreError> {
        let (existing_index, rebuilt) = self.read_or_rebuild_index_locked().await?;
        if rebuilt {
            return Ok(());
        }
        let index = upsert_session_index_entry(
            Some(existing_index),
            metadata,
            metadata_file_created,
            0,
            current_unix_ms(),
        );
        self.write_json_atomic(&self.index_path(), &index).await
    }

    async fn remove_index_entry_locked(
        &self,
        session_id: &str,
        metadata_file_count_delta: isize,
    ) -> Result<(), SessionMetadataStoreError> {
        let (existing_index, rebuilt) = self.read_or_rebuild_index_locked().await?;
        if rebuilt {
            return Ok(());
        }
        let Some(index) = remove_session_index_entry(
            Some(existing_index),
            session_id,
            metadata_file_count_delta,
            current_unix_ms(),
        ) else {
            return Ok(());
        };
        self.write_json_atomic(&self.index_path(), &index).await
    }

    pub async fn list_metadata(&self) -> Result<Vec<SessionMetadata>, SessionMetadataStoreError> {
        if !self.sessions_root().exists() {
            return Ok(Vec::new());
        }

        let lock = self.get_index_lock().await;
        let _guard = lock.lock().await;
        let _file_guard = self.lock_index_file().await?;
        let index_path = self.index_path();
        let (index, _) = self.read_or_rebuild_index_locked().await?;
        let has_stale_entry = index
            .sessions
            .iter()
            .any(|metadata| !self.metadata_path(&metadata.session_id).exists());
        if has_stale_entry {
            warn!(
                "Session index contains stale entries, rebuilding: {}",
                index_path.display()
            );
            return self
                .rebuild_index_locked()
                .await
                .map(compatible_metadata_list);
        }

        let disk_count = self.count_metadata_dirs().await?;
        if index.metadata_file_count != disk_count {
            warn!(
                "Session index incomplete (index: {}, disk: {}), rebuilding: {}",
                index.metadata_file_count,
                disk_count,
                index_path.display()
            );
            return self
                .rebuild_index_locked()
                .await
                .map(compatible_metadata_list);
        }

        Ok(compatible_metadata_list(index.sessions))
    }

    /// Read a bounded selection from the shared index without stat-ing every
    /// Session directory or opening any Turn/state files.
    pub async fn metadata_by_ids(
        &self,
        session_ids: &[String],
    ) -> Result<Vec<SessionMetadata>, SessionMetadataStoreError> {
        if !self.sessions_root().exists() || session_ids.is_empty() {
            return Ok(Vec::new());
        }
        let lock = self.get_index_lock().await;
        let _guard = lock.lock().await;
        let _file_guard = self.lock_index_file().await?;
        let (index, _) = self.read_or_rebuild_index_locked().await?;
        let selected: std::collections::HashSet<_> =
            session_ids.iter().map(String::as_str).collect();
        Ok(index
            .sessions
            .into_iter()
            .filter(|entry| selected.contains(entry.session_id.as_str()))
            .map(compatible_metadata)
            .collect())
    }

    pub async fn list_metadata_page(
        &self,
        cursor: Option<&str>,
        limit: usize,
    ) -> Result<SessionMetadataPage, SessionMetadataStoreError> {
        if !self.sessions_root().exists() {
            return Ok(empty_session_metadata_page());
        }

        let limit = limit.max(1);
        let lock = self.get_index_lock().await;
        let _guard = lock.lock().await;
        let _file_guard = self.lock_index_file().await?;
        let index_path = self.index_path();
        let (index, _) = self.read_or_rebuild_index_locked().await?;
        let indexed_sessions = if index.metadata_file_count < index.sessions.len() {
            warn!(
                "Session index has invalid metadata count before page read (index: {}, sessions: {}), rebuilding: {}",
                index.metadata_file_count,
                index.sessions.len(),
                index_path.display()
            );
            self.rebuild_index_locked().await?
        } else {
            index.sessions
        };

        let mut page = build_session_metadata_page(indexed_sessions, cursor, limit);
        let has_stale_page_entry = page
            .sessions
            .iter()
            .any(|metadata| !self.metadata_path(&metadata.session_id).exists());
        if !has_stale_page_entry {
            page.sessions = compatible_metadata_list(page.sessions);
            return Ok(page);
        }

        warn!(
            "Session index page contains stale entries, rebuilding before page read: {}",
            index_path.display()
        );
        let rebuilt_sessions = self.rebuild_index_locked().await?;
        let mut page = build_session_metadata_page(rebuilt_sessions, cursor, limit);
        page.sessions = compatible_metadata_list(page.sessions);
        Ok(page)
    }

    pub async fn list_metadata_including_internal(
        &self,
    ) -> Result<Vec<SessionMetadata>, SessionMetadataStoreError> {
        self.scan_metadata_dirs()
            .await
            .map(compatible_metadata_list)
    }

    pub async fn rebuild_index(&self) -> Result<Vec<SessionMetadata>, SessionMetadataStoreError> {
        let lock = self.get_index_lock().await;
        let _guard = lock.lock().await;
        let _file_guard = self.lock_index_file().await?;
        self.rebuild_index_locked().await
    }

    pub async fn save_metadata(
        &self,
        metadata: &SessionMetadata,
    ) -> Result<(), SessionMetadataStoreError> {
        validate_session_id(&metadata.session_id)
            .map_err(SessionMetadataStoreError::InvalidSessionId)?;
        self.ensure_session_dir(&metadata.session_id).await?;
        let metadata_path = self.metadata_path(&metadata.session_id);
        let lock = self.get_index_lock().await;
        let _guard = lock.lock().await;
        let _file_guard = self.lock_index_file().await?;
        let metadata_file_created = !metadata_path.exists();
        let mut metadata = metadata.clone();
        self.assign_workspace_session_number_locked(&mut metadata)
            .await?;
        let file = StoredSessionMetadataFile::new(metadata.clone());
        self.write_json_atomic(&metadata_path, &file).await?;
        if !metadata.should_hide_from_user_lists() {
            self.upsert_index_entry_locked(&metadata, metadata_file_created)
                .await
        } else {
            self.remove_index_entry_locked(
                &metadata.session_id,
                if metadata_file_created { 1 } else { 0 },
            )
            .await
        }?;
        Self::notify_catalog_changed();
        Ok(())
    }

    async fn assign_workspace_session_number_locked(
        &self,
        metadata: &mut SessionMetadata,
    ) -> Result<(), SessionMetadataStoreError> {
        if !ordinal::occupies_slot(metadata) {
            return Ok(());
        }
        let existing = self.load_metadata(&metadata.session_id).await?;
        let existing_number = existing
            .as_ref()
            .filter(|existing| {
                ordinal::occupies_slot(existing)
                    && ordinal::workspace_key(existing) == ordinal::workspace_key(metadata)
            })
            .and_then(ordinal::number);
        let number = if let Some(number) = existing_number {
            number
        } else {
            // Read authoritative metadata only when claiming a new slot. A
            // released title or deleted session immediately makes its number
            // reusable; surviving defaults keep their existing numbers.
            ordinal::next_available_number(metadata, &self.scan_metadata_dirs().await?)
                .ok_or(SessionMetadataStoreError::SessionNumberExhausted)?
        };
        metadata
            .custom_metadata
            .get_or_insert_with(|| serde_json::json!({}))
            .as_object_mut()
            .expect("default title descriptor requires an object")
            .insert(ordinal::METADATA_KEY.to_owned(), number.into());
        Ok(())
    }

    pub async fn load_metadata(
        &self,
        session_id: &str,
    ) -> Result<Option<SessionMetadata>, SessionMetadataStoreError> {
        validate_session_id(session_id).map_err(SessionMetadataStoreError::InvalidSessionId)?;
        let path = self.metadata_path(session_id);
        Ok(self
            .read_json_optional::<StoredSessionMetadataFile>(&path)
            .await?
            .map(|file| compatible_metadata(file.metadata)))
    }

    pub async fn delete_session_dir_and_index(
        &self,
        session_id: &str,
    ) -> Result<(), SessionMetadataStoreError> {
        validate_session_id(session_id).map_err(SessionMetadataStoreError::InvalidSessionId)?;
        let lock = self.get_index_lock().await;
        let _guard = lock.lock().await;
        let _file_guard = self.lock_index_file().await?;
        let dir = self.session_dir(session_id);
        let metadata_file_removed = self.metadata_path(session_id).exists();
        if dir.exists() {
            let root = fs::canonicalize(self.sessions_root())
                .await
                .map_err(
                    |source| SessionMetadataStoreError::ResolveSessionStoragePath {
                        path: self.sessions_root().to_path_buf(),
                        source,
                    },
                )?;
            let resolved_dir = fs::canonicalize(&dir).await.map_err(|source| {
                SessionMetadataStoreError::ResolveSessionStoragePath {
                    path: dir.clone(),
                    source,
                }
            })?;
            if resolved_dir == root || !resolved_dir.starts_with(&root) {
                return Err(SessionMetadataStoreError::UnsafeSessionStoragePath {
                    path: resolved_dir,
                    root,
                });
            }
            fs::remove_dir_all(&dir)
                .await
                .map_err(|source| SessionMetadataStoreError::DeleteSessionDir { source })?;
        }

        self.remove_index_entry_locked(session_id, if metadata_file_removed { -1 } else { 0 })
            .await?;
        Self::notify_catalog_changed();
        Ok(())
    }

    async fn ensure_session_dir(
        &self,
        session_id: &str,
    ) -> Result<PathBuf, SessionMetadataStoreError> {
        let dir = self.session_dir(session_id);
        fs::create_dir_all(&dir)
            .await
            .map_err(|source| SessionMetadataStoreError::CreateSessionDir { source })?;
        Ok(dir)
    }
}

fn compatible_metadata(mut metadata: SessionMetadata) -> SessionMetadata {
    metadata.normalize_legacy_model_selector();
    metadata
}

fn compatible_metadata_list(mut metadata: Vec<SessionMetadata>) -> Vec<SessionMetadata> {
    for entry in &mut metadata {
        entry.normalize_legacy_model_selector();
    }
    metadata
}

fn current_unix_ms() -> u64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .unwrap_or_default()
        .as_millis() as u64
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::session::{SessionStatus, StoredSessionIndexFile};

    #[tokio::test]
    async fn legacy_auto_metadata_reads_are_compatible_without_rewriting_files() {
        let root = tempfile::tempdir().unwrap();
        let store = SessionMetadataStore::new(root.path());
        for (id, agent, provider, selector, expected) in [
            ("legacy", "Standard", None, "auto", "primary"),
            ("acp-agent", "acp:codex", None, "auto", "auto"),
            ("acp-provider", "Standard", Some("acp"), "auto", "auto"),
            ("pinned", "Standard", None, "removed-model", "removed-model"),
            ("fast", "Standard", None, "fast", "fast"),
        ] {
            let mut record = metadata(id, 1);
            record.agent_type = agent.to_string();
            record.model_name = selector.to_string();
            record.custom_metadata = provider.map(|value| serde_json::json!({"provider": value}));
            store.save_metadata(&record).await.unwrap();
            let source = fs::read(store.metadata_path(id)).await.unwrap();
            let index = fs::read(store.index_path()).await.unwrap();
            assert_eq!(
                store.load_metadata(id).await.unwrap().unwrap().model_name,
                expected
            );
            for records in [
                store.list_metadata().await.unwrap(),
                store.list_metadata_page(None, 10).await.unwrap().sessions,
                store.metadata_by_ids(&[id.to_string()]).await.unwrap(),
                store.list_metadata_including_internal().await.unwrap(),
            ] {
                assert_eq!(
                    records
                        .iter()
                        .find(|entry| entry.session_id == id)
                        .unwrap()
                        .model_name,
                    expected
                );
            }
            assert_eq!(fs::read(store.metadata_path(id)).await.unwrap(), source);
            assert_eq!(fs::read(store.index_path()).await.unwrap(), index);
            let returned = store.load_metadata(id).await.unwrap().unwrap();
            let round_trip: StoredSessionMetadataFile = serde_json::from_slice(
                &serde_json::to_vec(&StoredSessionMetadataFile::new(returned)).unwrap(),
            )
            .unwrap();
            assert_eq!(round_trip.metadata.model_name, expected);
        }
    }

    #[tokio::test]
    async fn catalog_watch_tracks_committed_create_rename_and_delete() {
        let root = tempfile::tempdir().unwrap();
        let store = SessionMetadataStore::new(root.path());
        let mut changes = SessionMetadataStore::subscribe_catalog_changes();
        let mut record = metadata("catalog-watch", 1);
        let before = *changes.borrow_and_update();
        store.save_metadata(&record).await.unwrap();
        assert!(*changes.borrow_and_update() > before);
        let before = *changes.borrow_and_update();
        record.session_name = "Renamed catalog entry".into();
        store.save_metadata(&record).await.unwrap();
        assert!(*changes.borrow_and_update() > before);
        assert_eq!(
            store
                .load_metadata("catalog-watch")
                .await
                .unwrap()
                .unwrap()
                .session_name,
            "Renamed catalog entry"
        );
        let before = *changes.borrow_and_update();
        store
            .delete_session_dir_and_index("catalog-watch")
            .await
            .unwrap();
        assert!(*changes.borrow_and_update() > before);
        assert!(store
            .load_metadata("catalog-watch")
            .await
            .unwrap()
            .is_none());
    }

    fn default_title_metadata(id: &str, created_at: u64) -> SessionMetadata {
        let mut result = metadata(id, created_at);
        result.session_name = "New Session".into();
        result.workspace_path = Some("/project".into());
        result.custom_metadata = Some(serde_json::json!({
            "titleSource": "i18n", "titleKey": "flow-chat:session.new",
            "titleParams": { "defaultTitleText": "New Session" }
        }));
        result
    }

    #[tokio::test]
    async fn workspace_numbers_are_atomic_durable_and_independent_of_mode() {
        let dir = tempfile::tempdir().unwrap();
        let store = SessionMetadataStore::new(dir.path());
        let other_writer = SessionMetadataStore::new(dir.path());
        let a = default_title_metadata("number-a", 1);
        let mut unclaimed = a.clone();
        unclaimed.custom_metadata = None;
        store.save_metadata(&unclaimed).await.unwrap();
        assert_eq!(
            ordinal::number(&store.load_metadata(&a.session_id).await.unwrap().unwrap()),
            None
        );
        let mut b = default_title_metadata("number-b", 2);
        b.agent_type = "Cowork".into();
        let (left, right) = tokio::join!(store.save_metadata(&a), other_writer.save_metadata(&b));
        left.unwrap();
        right.unwrap();
        let a_number =
            ordinal::number(&store.load_metadata(&a.session_id).await.unwrap().unwrap()).unwrap();
        let b_number =
            ordinal::number(&store.load_metadata(&b.session_id).await.unwrap().unwrap()).unwrap();
        assert_ne!(a_number, b_number);
        assert_eq!(a_number + b_number, 3);

        store.save_metadata(&a).await.unwrap();
        assert_eq!(
            ordinal::number(&store.load_metadata(&a.session_id).await.unwrap().unwrap()),
            Some(a_number)
        );
        let reopened = SessionMetadataStore::new(dir.path());
        let mut c = default_title_metadata("number-c", 3);
        c.workspace_path = Some("/worktree".into());
        c.project_workspace_path = Some("/project".into());
        reopened.save_metadata(&c).await.unwrap();
        assert_eq!(
            ordinal::number(
                &reopened
                    .load_metadata(&c.session_id)
                    .await
                    .unwrap()
                    .unwrap()
            ),
            Some(3)
        );
        let mut d = default_title_metadata("number-d", 4);
        d.workspace_path = Some("/another-project".into());
        reopened.save_metadata(&d).await.unwrap();
        assert_eq!(
            ordinal::number(
                &reopened
                    .load_metadata(&d.session_id)
                    .await
                    .unwrap()
                    .unwrap()
            ),
            Some(1)
        );
    }

    #[tokio::test]
    async fn vacant_slots_are_reused_without_renumbering_survivors_after_restart() {
        let dir = tempfile::tempdir().unwrap();
        let store = SessionMetadataStore::new(dir.path());
        let a = default_title_metadata("slot-a", 1);
        let mut b = default_title_metadata("slot-b", 2);
        let mut c = default_title_metadata("slot-c", 3);
        for session in [&a, &b, &c] {
            store.save_metadata(session).await.unwrap();
        }
        store
            .delete_session_dir_and_index(&a.session_id)
            .await
            .unwrap();
        b.session_name = "Fix login".into();
        store.save_metadata(&b).await.unwrap();

        let reopened = SessionMetadataStore::new(dir.path());
        reopened.rebuild_index().await.unwrap();
        for (id, expected) in [("slot-d", 1), ("slot-e", 2)] {
            reopened
                .save_metadata(&default_title_metadata(id, 4))
                .await
                .unwrap();
            assert_eq!(
                ordinal::number(&reopened.load_metadata(id).await.unwrap().unwrap()),
                Some(expected)
            );
        }
        c.last_active_at = 99;
        c.custom_metadata.as_mut().unwrap()[ordinal::METADATA_KEY] = 99.into();
        reopened.save_metadata(&c).await.unwrap();
        assert_eq!(
            ordinal::number(
                &reopened
                    .load_metadata(&c.session_id)
                    .await
                    .unwrap()
                    .unwrap()
            ),
            Some(3)
        );
    }

    #[tokio::test]
    async fn leaving_the_default_title_releases_its_slot() {
        for transition in ["renamed", "started", "archived", "literal-default", "child"] {
            let dir = tempfile::tempdir().unwrap();
            let store = SessionMetadataStore::new(dir.path());
            let a = default_title_metadata("slot-a", 1);
            store.save_metadata(&a).await.unwrap();
            let mut saved = store.load_metadata(&a.session_id).await.unwrap().unwrap();
            match transition {
                "renamed" => saved.session_name = "Fix login".into(),
                "started" => saved.turn_count = 1,
                "archived" => saved.status = SessionStatus::Archived,
                "literal-default" => super::super::metadata::apply_session_title_metadata(
                    &mut saved,
                    &metadata("slot-a", 1),
                ),
                "child" => saved.session_kind = openbitfun_core_types::SessionKind::Subagent,
                _ => unreachable!(),
            }
            store.save_metadata(&saved).await.unwrap();
            store
                .save_metadata(&default_title_metadata("slot-b", 2))
                .await
                .unwrap();
            assert_eq!(
                ordinal::number(&store.load_metadata("slot-b").await.unwrap().unwrap()),
                Some(1),
                "{transition}"
            );
        }
    }

    #[tokio::test]
    async fn unarchiving_claims_a_free_slot_when_the_old_number_was_reused() {
        let dir = tempfile::tempdir().unwrap();
        let store = SessionMetadataStore::new(dir.path());
        store
            .save_metadata(&default_title_metadata("slot-a", 1))
            .await
            .unwrap();
        let mut a = store.load_metadata("slot-a").await.unwrap().unwrap();
        a.status = SessionStatus::Archived;
        store.save_metadata(&a).await.unwrap();
        store
            .save_metadata(&default_title_metadata("slot-b", 2))
            .await
            .unwrap();
        a.status = SessionStatus::Active;
        store.save_metadata(&a).await.unwrap();
        assert_eq!(
            ordinal::number(&store.load_metadata("slot-a").await.unwrap().unwrap()),
            Some(2)
        );
        assert_eq!(
            ordinal::number(&store.load_metadata("slot-b").await.unwrap().unwrap()),
            Some(1)
        );
    }

    #[tokio::test]
    async fn legacy_text_metadata_is_not_numbered_or_rewritten_as_a_default() {
        let dir = tempfile::tempdir().unwrap();
        let store = SessionMetadataStore::new(dir.path());
        let mut legacy = metadata("legacy-number", 1);
        legacy.session_name = "New Code Session 8".into();
        legacy.custom_metadata = Some(serde_json::json!({
            "titleSource": "i18n", "titleKey": "flow-chat:session.newCodeWithIndex", "titleParams": {"count": 8}
        }));
        store.ensure_session_dir(&legacy.session_id).await.unwrap();
        store
            .write_json_atomic(
                &store.metadata_path(&legacy.session_id),
                &StoredSessionMetadataFile::new(legacy.clone()),
            )
            .await
            .unwrap();
        store.save_metadata(&legacy).await.unwrap();
        let restored = store
            .load_metadata(&legacy.session_id)
            .await
            .unwrap()
            .unwrap();
        assert_eq!(restored.session_name, legacy.session_name);
        assert_eq!(restored.custom_metadata, legacy.custom_metadata);
        assert_eq!(ordinal::number(&restored), None);
    }

    #[tokio::test]
    async fn workspace_slots_normalize_local_roots_and_keep_remote_roots_case_sensitive() {
        let dir = tempfile::tempdir().unwrap();
        let store = SessionMetadataStore::new(dir.path());
        for (id, path, expected) in [
            ("win-a", "D:/Project", 1),
            ("win-b", "d:\\project\\", 2),
            ("posix-a", "/Project", 1),
            ("posix-b", "/project", 1),
        ] {
            let mut session = default_title_metadata(id, 1);
            session.workspace_path = Some(path.into());
            store.save_metadata(&session).await.unwrap();
            assert_eq!(
                ordinal::number(&store.load_metadata(id).await.unwrap().unwrap()),
                Some(expected)
            );
        }
    }
    use tempfile::tempdir;

    #[test]
    fn index_lock_child_holds_the_cross_process_guard() {
        if std::env::var_os("OPENBITFUN_SESSION_INDEX_LOCK_CHILD").is_none() {
            return;
        }
        let sessions_root = PathBuf::from(
            std::env::var_os("OPENBITFUN_SESSION_INDEX_ROOT").expect("index lock root"),
        );
        let ready_path = PathBuf::from(
            std::env::var_os("OPENBITFUN_SESSION_INDEX_READY").expect("index lock ready path"),
        );
        let release_path = PathBuf::from(
            std::env::var_os("OPENBITFUN_SESSION_INDEX_RELEASE").expect("index lock release path"),
        );
        std::fs::create_dir_all(&sessions_root).expect("sessions root");
        let _guard = FileLock::acquire(&sessions_root.join(".index.lock"), FileLockMode::Exclusive)
            .expect("child index lock");
        std::fs::write(&ready_path, b"ready").expect("publish child readiness");
        while !release_path.exists() {
            std::thread::sleep(std::time::Duration::from_millis(10));
        }
    }

    #[tokio::test]
    async fn metadata_save_waits_for_a_cross_process_index_writer() {
        use std::process::{Command, Stdio};
        use std::time::{Duration, Instant};

        let dir = tempdir().expect("tempdir");
        let ready_path = dir.path().join("child-ready");
        let release_path = dir.path().join("child-release");
        let mut command = Command::new(std::env::current_exe().expect("test executable"));
        #[cfg(windows)]
        {
            use std::os::windows::process::CommandExt;
            command.creation_flags(0x0800_0000);
        }
        let mut child = command
            .arg("--exact")
            .arg("session::metadata_store::tests::index_lock_child_holds_the_cross_process_guard")
            .arg("--nocapture")
            .env("OPENBITFUN_SESSION_INDEX_LOCK_CHILD", "1")
            .env("OPENBITFUN_SESSION_INDEX_ROOT", dir.path())
            .env("OPENBITFUN_SESSION_INDEX_READY", &ready_path)
            .env("OPENBITFUN_SESSION_INDEX_RELEASE", &release_path)
            .stdout(Stdio::null())
            .stderr(Stdio::null())
            .spawn()
            .expect("spawn index lock child");
        let deadline = Instant::now() + Duration::from_secs(5);
        while !ready_path.exists() && Instant::now() < deadline {
            std::thread::sleep(Duration::from_millis(10));
        }
        if !ready_path.exists() {
            let _ = child.kill();
            let _ = child.wait();
            panic!("index lock child did not become ready");
        }

        let store = SessionMetadataStore::new(dir.path());
        let mut save =
            tokio::spawn(async move { store.save_metadata(&metadata("session-a", 10)).await });
        let blocked = tokio::time::timeout(Duration::from_millis(50), &mut save)
            .await
            .is_err();

        std::fs::write(&release_path, b"release").expect("release child index lock");
        save.await.expect("save task").expect("metadata save");
        assert!(child.wait().expect("index lock child").success());
        assert!(
            blocked,
            "metadata save must wait while another process owns the index"
        );
    }

    fn metadata(session_id: &str, last_active_at: u64) -> SessionMetadata {
        let mut metadata = SessionMetadata::new(
            session_id.to_string(),
            format!("Session {session_id}"),
            "Standard".to_string(),
            "model".to_string(),
        );
        metadata.last_active_at = last_active_at;
        metadata
    }

    #[tokio::test]
    async fn metadata_store_saves_visible_metadata_and_updates_index() {
        let dir = tempdir().expect("tempdir");
        let store = SessionMetadataStore::new(dir.path());

        store
            .save_metadata(&metadata("session-a", 10))
            .await
            .expect("save metadata");

        let loaded = store
            .load_metadata("session-a")
            .await
            .expect("load metadata")
            .expect("metadata exists");
        assert_eq!(loaded.session_id, "session-a");

        let listed = store.list_metadata().await.expect("list metadata");
        assert_eq!(listed.len(), 1);
        assert_eq!(listed[0].session_id, "session-a");
    }

    #[tokio::test]
    async fn activity_selection_needs_only_metadata_and_leaves_transcripts_unloaded() {
        let dir = tempdir().unwrap();
        let store = SessionMetadataStore::new(dir.path());
        store
            .save_metadata(&metadata("session-a", 10))
            .await
            .unwrap();
        store
            .save_metadata(&metadata("session-b", 20))
            .await
            .unwrap();
        // No state sidecars or Turn files exist. A navigation read must work
        // solely from the index and keep unrelated sessions out of its reply.
        let selected = store
            .metadata_by_ids(&["session-a".to_string(), "missing".to_string()])
            .await
            .unwrap();
        assert_eq!(selected.len(), 1);
        assert_eq!(selected[0].session_id, "session-a");
        assert!(store.metadata_by_ids(&[]).await.unwrap().is_empty());
    }

    #[tokio::test]
    async fn metadata_store_recovers_empty_index_while_saving_new_metadata() {
        let dir = tempdir().expect("tempdir");
        let store = SessionMetadataStore::new(dir.path());
        store
            .save_metadata(&metadata("historical", 20))
            .await
            .expect("save historical metadata");
        let historical_turn = store
            .session_dir("historical")
            .join("turns")
            .join("turn-0000.json");
        fs::create_dir_all(historical_turn.parent().expect("turn parent"))
            .await
            .expect("create historical turns directory");
        fs::write(&historical_turn, b"historical turn payload")
            .await
            .expect("write historical turn sentinel");

        fs::write(store.index_path(), b"")
            .await
            .expect("simulate an empty index after an interrupted write");
        store
            .save_metadata(&metadata("new-session", 10))
            .await
            .expect("a corrupt derived index must not block a new session");

        let listed = store.list_metadata().await.expect("list rebuilt metadata");
        assert_eq!(
            listed
                .iter()
                .map(|value| value.session_id.as_str())
                .collect::<Vec<_>>(),
            vec!["historical", "new-session"]
        );
        assert_eq!(
            fs::read(&historical_turn)
                .await
                .expect("historical turn must remain readable"),
            b"historical turn payload"
        );
        let rebuilt = store
            .read_json_optional::<StoredSessionIndexFile>(&store.index_path())
            .await
            .expect("read rebuilt index")
            .expect("rebuilt index exists");
        assert_eq!(rebuilt.metadata_file_count, 2);
        assert_eq!(rebuilt.sessions.len(), 2);
    }

    #[tokio::test]
    async fn metadata_store_page_recovers_truncated_index() {
        let dir = tempdir().expect("tempdir");
        let store = SessionMetadataStore::new(dir.path());
        store
            .save_metadata(&metadata("older", 10))
            .await
            .expect("save older metadata");
        store
            .save_metadata(&metadata("newer", 20))
            .await
            .expect("save newer metadata");
        fs::write(store.index_path(), br#"{"schema_version":2,"updated_at":"#)
            .await
            .expect("simulate a truncated index");

        let page = store
            .list_metadata_page(None, 10)
            .await
            .expect("paged listing must rebuild a truncated index");

        assert_eq!(
            page.sessions
                .iter()
                .map(|value| value.session_id.as_str())
                .collect::<Vec<_>>(),
            vec!["newer", "older"]
        );
    }

    #[tokio::test]
    async fn metadata_store_delete_recovers_corrupt_index_and_preserves_other_sessions() {
        let dir = tempdir().expect("tempdir");
        let store = SessionMetadataStore::new(dir.path());
        store
            .save_metadata(&metadata("historical", 20))
            .await
            .expect("save historical metadata");
        store
            .save_metadata(&metadata("partial-create", 10))
            .await
            .expect("save partial create metadata");
        fs::write(store.index_path(), b"")
            .await
            .expect("simulate an empty index");

        store
            .delete_session_dir_and_index("partial-create")
            .await
            .expect("cleanup must rebuild the corrupt index");

        assert!(!store.session_dir("partial-create").exists());
        assert!(store.session_dir("historical").exists());
        let listed = store.list_metadata().await.expect("list surviving session");
        assert_eq!(listed.len(), 1);
        assert_eq!(listed[0].session_id, "historical");
    }

    #[tokio::test]
    async fn metadata_store_rebuilds_missing_index_before_save_without_hiding_history() {
        let dir = tempdir().expect("tempdir");
        let store = SessionMetadataStore::new(dir.path());
        store
            .save_metadata(&metadata("historical", 20))
            .await
            .expect("save historical metadata");
        fs::remove_file(store.index_path())
            .await
            .expect("simulate the replace gap left by an older version");

        store
            .save_metadata(&metadata("new-session", 10))
            .await
            .expect("save with a missing derived index");

        let listed = store.list_metadata().await.expect("list rebuilt metadata");
        assert_eq!(
            listed
                .iter()
                .map(|value| value.session_id.as_str())
                .collect::<Vec<_>>(),
            vec!["historical", "new-session"]
        );
    }

    #[tokio::test]
    async fn metadata_store_rebuilds_legacy_index_without_metadata_file_count() {
        let dir = tempdir().expect("tempdir");
        let store = SessionMetadataStore::new(dir.path());
        let historical = metadata("historical", 20);
        store
            .save_metadata(&historical)
            .await
            .expect("save historical metadata");
        let legacy_index = serde_json::json!({
            "schema_version": 2,
            "updated_at": 1,
            "sessions": [historical]
        });
        fs::write(
            store.index_path(),
            serde_json::to_vec(&legacy_index).expect("serialize legacy index"),
        )
        .await
        .expect("write legacy index");

        let listed = store
            .list_metadata()
            .await
            .expect("legacy index remains upgrade-compatible");

        assert_eq!(listed.len(), 1);
        assert_eq!(listed[0].session_id, "historical");
        let rebuilt = store
            .read_json_optional::<StoredSessionIndexFile>(&store.index_path())
            .await
            .expect("read upgraded index")
            .expect("upgraded index exists");
        assert_eq!(rebuilt.metadata_file_count, 1);
    }

    #[tokio::test]
    async fn metadata_store_does_not_treat_index_io_errors_as_corruption() {
        let dir = tempdir().expect("tempdir");
        let store = SessionMetadataStore::new(dir.path());
        store
            .save_metadata(&metadata("session-a", 10))
            .await
            .expect("save metadata");
        fs::remove_file(store.index_path())
            .await
            .expect("remove index file");
        fs::create_dir(store.index_path())
            .await
            .expect("replace index with an unreadable directory");

        let error = store
            .list_metadata()
            .await
            .expect_err("filesystem errors must not be swallowed as corrupt JSON");

        assert!(!error.is_deserialization());
        assert!(store.index_path().is_dir());
    }

    #[tokio::test]
    async fn metadata_store_rebuilds_stale_index_entries() {
        let dir = tempdir().expect("tempdir");
        let store = SessionMetadataStore::new(dir.path());
        store
            .save_metadata(&metadata("existing", 20))
            .await
            .expect("save metadata");

        let stale = StoredSessionIndexFile {
            schema_version: super::super::types::SESSION_STORAGE_SCHEMA_VERSION,
            metadata_file_count: 2,
            updated_at: 1,
            sessions: vec![metadata("missing", 30), metadata("existing", 20)],
        };
        store
            .write_json_atomic(&store.index_path(), &stale)
            .await
            .expect("write stale index");

        let listed = store.list_metadata().await.expect("list metadata");
        assert_eq!(
            listed
                .iter()
                .map(|value| value.session_id.as_str())
                .collect::<Vec<_>>(),
            vec!["existing"]
        );
    }

    #[tokio::test]
    async fn metadata_store_rebuild_index_counts_hidden_metadata_files() {
        let dir = tempdir().expect("tempdir");
        let store = SessionMetadataStore::new(dir.path());

        store
            .save_metadata(&metadata("visible-a", 20))
            .await
            .expect("save visible metadata");

        let mut hidden = metadata("hidden", 30);
        hidden.session_kind = openbitfun_core_types::SessionKind::Subagent;
        store
            .save_metadata(&hidden)
            .await
            .expect("save hidden metadata");

        let visible = store.rebuild_index().await.expect("rebuild index");
        assert_eq!(
            visible
                .iter()
                .map(|value| value.session_id.as_str())
                .collect::<Vec<_>>(),
            vec!["visible-a"]
        );

        let index = store
            .read_json_optional::<StoredSessionIndexFile>(&store.index_path())
            .await
            .expect("read index")
            .expect("index exists");
        assert_eq!(index.sessions.len(), 1);
        assert_eq!(index.metadata_file_count, 2);
    }

    #[tokio::test]
    async fn metadata_store_hides_internal_sessions_from_visible_index() {
        let dir = tempdir().expect("tempdir");
        let store = SessionMetadataStore::new(dir.path());
        let mut hidden = metadata("hidden", 30);
        hidden.session_kind = openbitfun_core_types::SessionKind::Subagent;
        hidden.status = SessionStatus::Active;
        hidden.relationship = Some(crate::session::SessionRelationship {
            kind: Some(crate::session::SessionRelationshipKind::Subagent),
            parent_session_id: Some("parent".to_string()),
            ..Default::default()
        });

        store
            .save_metadata(&hidden)
            .await
            .expect("save hidden metadata");

        assert!(store
            .list_metadata()
            .await
            .expect("visible list")
            .is_empty());
        assert_eq!(
            store
                .list_metadata_including_internal()
                .await
                .expect("all metadata")
                .len(),
            1
        );
    }

    #[tokio::test]
    async fn metadata_store_delete_session_updates_visible_index() {
        let dir = tempdir().expect("tempdir");
        let store = SessionMetadataStore::new(dir.path());
        store
            .save_metadata(&metadata("session-a", 10))
            .await
            .expect("save metadata");
        assert_eq!(
            store
                .list_metadata()
                .await
                .expect("list before delete")
                .len(),
            1
        );

        store
            .delete_session_dir_and_index("session-a")
            .await
            .expect("delete session");

        assert!(store
            .load_metadata("session-a")
            .await
            .expect("load")
            .is_none());
        assert!(store
            .list_metadata()
            .await
            .expect("list after delete")
            .is_empty());
    }

    #[cfg(not(windows))]
    #[tokio::test]
    async fn metadata_store_preserves_existing_non_traversing_component_ids() {
        let dir = tempdir().expect("tempdir");
        let store = SessionMetadataStore::new(dir.path());
        let session_id = "legacy:session:1";

        store
            .save_metadata(&metadata(session_id, 10))
            .await
            .expect("save legacy metadata");
        assert!(store
            .load_metadata(session_id)
            .await
            .expect("load legacy metadata")
            .is_some());
        store
            .delete_session_dir_and_index(session_id)
            .await
            .expect("delete legacy session");
        assert!(!dir.path().join(session_id).exists());
    }

    #[tokio::test]
    async fn metadata_store_rejects_session_delete_path_traversal() {
        let parent = tempdir().expect("parent tempdir");
        let sessions_root = parent.path().join("sessions");
        std::fs::create_dir_all(&sessions_root).expect("sessions root");
        let sentinel = parent.path().join("sentinel");
        std::fs::create_dir_all(&sentinel).expect("sentinel");
        std::fs::write(sentinel.join("keep.txt"), "keep").expect("sentinel file");
        let store = SessionMetadataStore::new(&sessions_root);

        for unsafe_id in ["..", "../sentinel", "C:\\sentinel"] {
            assert!(
                store.delete_session_dir_and_index(unsafe_id).await.is_err(),
                "unsafe session id must fail: {unsafe_id}"
            );
        }

        assert_eq!(
            std::fs::read_to_string(sentinel.join("keep.txt")).expect("sentinel remains"),
            "keep"
        );
    }

    #[tokio::test]
    async fn metadata_store_rejects_path_like_ids_for_reads_and_writes() {
        let dir = tempdir().expect("tempdir");
        let store = SessionMetadataStore::new(dir.path());

        assert!(store.load_metadata("../outside").await.is_err());
        assert!(store
            .save_metadata(&metadata("../outside", 10))
            .await
            .is_err());
        assert!(!dir
            .path()
            .parent()
            .expect("parent")
            .join("outside")
            .exists());
    }
}
