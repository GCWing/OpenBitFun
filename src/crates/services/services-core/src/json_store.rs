//! Generic JSON file store with best-effort atomic writes.
//!
//! This module owns reusable local JSON file IO. Product/session code should
//! keep schema decisions outside this module and use it only for file-level
//! read/write behavior.

use fs2::FileExt;
use log::{debug, warn};
use serde::{de::DeserializeOwned, Serialize};
use std::collections::HashMap;
use std::fs::OpenOptions;
use std::io::ErrorKind;
use std::path::{Path, PathBuf};
use std::sync::{Arc, OnceLock, Weak};
use std::time::{Duration, Instant, SystemTime, UNIX_EPOCH};
use tokio::fs;
use tokio::sync::Mutex;

const JSON_WRITE_MAX_RETRIES: usize = 5;
const JSON_WRITE_RETRY_BASE_DELAY_MS: u64 = 30;

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum AtomicWritePolicy {
    BestEffortReplace,
    StrictReplace,
    CreateNew,
}

static JSON_FILE_WRITE_LOCKS: OnceLock<Mutex<HashMap<PathBuf, Weak<Mutex<()>>>>> = OnceLock::new();

#[derive(Debug, thiserror::Error)]
pub enum JsonFileStoreError {
    #[error("Target path has no parent directory: {path}")]
    NoParentDirectory { path: PathBuf },
    #[error("Failed to read JSON metadata {path}: {source}")]
    ReadMetadata {
        path: PathBuf,
        #[source]
        source: std::io::Error,
    },
    #[error("Failed to read JSON file {path}: {source}")]
    Read {
        path: PathBuf,
        #[source]
        source: std::io::Error,
    },
    #[error("Failed to deserialize JSON file {path}: {source}")]
    Deserialize {
        path: PathBuf,
        #[source]
        source: serde_json::Error,
    },
    #[error("Failed to create parent directory: {source}")]
    CreateParent {
        #[source]
        source: std::io::Error,
    },
    #[error("Failed to serialize JSON: {source}")]
    Serialize {
        #[source]
        source: serde_json::Error,
    },
    #[error("Failed to write temp JSON file: {source}")]
    WriteTemp {
        #[source]
        source: std::io::Error,
    },
    #[error("Failed fallback JSON overwrite {path}: {source}")]
    FallbackOverwrite {
        path: PathBuf,
        #[source]
        source: std::io::Error,
    },
    #[error("Failed to replace JSON file: {source}")]
    Replace {
        #[source]
        source: std::io::Error,
    },
    #[error("Failed to replace JSON file {path}: unknown error")]
    ReplaceUnknown { path: PathBuf },
    #[error("Failed to lock JSON file {path}: {source}")]
    CrossProcessLock {
        path: PathBuf,
        #[source]
        source: std::io::Error,
    },
    #[error("JSON file lock task failed: {source}")]
    CrossProcessLockTask {
        #[source]
        source: tokio::task::JoinError,
    },
}

impl JsonFileStoreError {
    pub fn is_deserialization(&self) -> bool {
        matches!(self, Self::Deserialize { .. })
    }

    pub fn is_serialization(&self) -> bool {
        matches!(self, Self::Serialize { .. })
    }

    pub fn is_already_exists(&self) -> bool {
        matches!(self, Self::Replace { source } if source.kind() == ErrorKind::AlreadyExists)
    }
}

#[derive(Debug, Default, Clone, Copy)]
pub struct JsonFileStore;

/// Filesystem revision for rebuildable index caches. Replacement creation time
/// and (on Unix) inode/change time also detect replacement with preserved mtime.
/// This is not a content identity for externally edited history bodies.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct JsonFileRevision {
    pub len: u64,
    modified: SystemTime,
    created: Option<SystemTime>,
    #[cfg(unix)]
    identity: (u64, u64, i64, i64),
}

impl JsonFileStore {
    pub async fn revision(
        &self,
        path: &Path,
    ) -> Result<Option<JsonFileRevision>, JsonFileStoreError> {
        let stat = match fs::metadata(path).await {
            Ok(stat) => stat,
            Err(error) if error.kind() == ErrorKind::NotFound => return Ok(None),
            Err(source) => {
                return Err(JsonFileStoreError::ReadMetadata {
                    path: path.to_owned(),
                    source,
                })
            }
        };
        let modified = stat
            .modified()
            .map_err(|source| JsonFileStoreError::ReadMetadata {
                path: path.to_owned(),
                source,
            })?;
        #[cfg(unix)]
        let identity = {
            use std::os::unix::fs::MetadataExt;
            (stat.dev(), stat.ino(), stat.ctime(), stat.ctime_nsec())
        };
        Ok(Some(JsonFileRevision {
            len: stat.len(),
            modified,
            created: stat.created().ok(),
            #[cfg(unix)]
            identity,
        }))
    }
}

/// Held OS advisory lock for a JSON-owned transaction.
///
/// Callers may use this guard when a read/modify/write transaction includes
/// additional side effects that cannot fit inside [`JsonFileStore::update_locked`].
pub struct JsonFileCrossProcessLock(std::fs::File);

impl Drop for JsonFileCrossProcessLock {
    fn drop(&mut self) {
        let _ = FileExt::unlock(&self.0);
    }
}

impl JsonFileStore {
    pub async fn read_locked_optional<T: DeserializeOwned>(
        &self,
        path: &Path,
    ) -> Result<Option<T>, JsonFileStoreError> {
        let _lock = self.acquire_cross_process_lock(path).await?;
        self.read_optional(path).await
    }

    pub async fn update_locked<T, R>(
        &self,
        path: &Path,
        default: T,
        update: impl FnOnce(&mut T) -> R,
    ) -> Result<(R, T), JsonFileStoreError>
    where
        T: DeserializeOwned + Serialize,
    {
        let _lock = self.acquire_cross_process_lock(path).await?;
        let mut value = self.read_optional(path).await?.unwrap_or(default);
        let result = update(&mut value);
        self.write_atomic_strict(path, &value).await?;
        Ok((result, value))
    }

    pub async fn read_optional<T: DeserializeOwned>(
        &self,
        path: &Path,
    ) -> Result<Option<T>, JsonFileStoreError> {
        let started_at = Instant::now();
        let metadata_started_at = Instant::now();
        let metadata = match fs::metadata(path).await {
            Ok(metadata) => metadata,
            Err(error) if error.kind() == ErrorKind::NotFound => return Ok(None),
            Err(error) => {
                return Err(JsonFileStoreError::ReadMetadata {
                    path: path.to_path_buf(),
                    source: error,
                });
            }
        };
        let metadata_duration = metadata_started_at.elapsed();

        let read_started_at = Instant::now();
        let content =
            fs::read_to_string(path)
                .await
                .map_err(|source| JsonFileStoreError::Read {
                    path: path.to_path_buf(),
                    source,
                })?;
        let read_duration = read_started_at.elapsed();

        let parse_started_at = Instant::now();
        let value = serde_json::from_str::<T>(&content).map_err(|source| {
            JsonFileStoreError::Deserialize {
                path: path.to_path_buf(),
                source,
            }
        })?;
        let parse_duration = parse_started_at.elapsed();
        let total_duration = started_at.elapsed();

        if total_duration >= Duration::from_millis(80) || metadata.len() >= 1024 * 1024 {
            debug!(
                "Read JSON file: path={} type={} size_bytes={} metadata_duration_ms={} read_duration_ms={} parse_duration_ms={} total_duration_ms={}",
                path.display(),
                std::any::type_name::<T>(),
                metadata.len(),
                metadata_duration.as_millis(),
                read_duration.as_millis(),
                parse_duration.as_millis(),
                total_duration.as_millis()
            );
        }

        Ok(Some(value))
    }

    pub async fn write_atomic<T: Serialize>(
        &self,
        path: &Path,
        value: &T,
    ) -> Result<(), JsonFileStoreError> {
        self.write_atomic_with_policy(path, value, AtomicWritePolicy::BestEffortReplace)
            .await
    }

    /// Writes JSON using a same-volume atomic replacement and never deletes or
    /// directly overwrites an existing target as a fallback.
    pub async fn write_atomic_strict<T: Serialize>(
        &self,
        path: &Path,
        value: &T,
    ) -> Result<(), JsonFileStoreError> {
        self.write_atomic_with_policy(path, value, AtomicWritePolicy::StrictReplace)
            .await
    }

    async fn write_atomic_with_policy<T: Serialize>(
        &self,
        path: &Path,
        value: &T,
        policy: AtomicWritePolicy,
    ) -> Result<(), JsonFileStoreError> {
        // Compact serialization: pretty output is 30-50% larger and hot files
        // (turn context snapshots) are rewritten on every message append.
        let json =
            serde_json::to_vec(value).map_err(|source| JsonFileStoreError::Serialize { source })?;
        self.write_bytes_atomic_with_policy(path, json, policy)
            .await
    }

    /// Atomically replace a plain UTF-8 text file using the same locking and
    /// retry policy as JSON persistence. Session transcript artifacts use this
    /// instead of open-coded `fs::write` so readers never observe a partial
    /// generated reference.
    pub async fn write_text_atomic(
        &self,
        path: &Path,
        text: &str,
    ) -> Result<(), JsonFileStoreError> {
        self.write_bytes_atomic_with_policy(
            path,
            text.as_bytes().to_vec(),
            AtomicWritePolicy::BestEffortReplace,
        )
        .await
    }

    /// Atomically replace a UTF-8 text file without falling back to a direct
    /// overwrite when another process temporarily blocks replacement.
    pub async fn write_text_atomic_strict(
        &self,
        path: &Path,
        text: &str,
    ) -> Result<(), JsonFileStoreError> {
        self.write_bytes_atomic_with_policy(
            path,
            text.as_bytes().to_vec(),
            AtomicWritePolicy::StrictReplace,
        )
        .await
    }

    /// Publish binary runtime artifacts with the same strict atomic replacement
    /// used by text artifacts. Readers must never observe a partial attachment.
    pub async fn write_bytes_atomic_strict(
        &self,
        path: &Path,
        bytes: Vec<u8>,
    ) -> Result<(), JsonFileStoreError> {
        self.write_bytes_atomic_with_policy(path, bytes, AtomicWritePolicy::StrictReplace)
            .await
    }

    /// Copy an existing file to a strictly atomically published destination
    /// without loading the file into the process heap.
    pub async fn copy_file_atomic_strict(
        &self,
        source: &Path,
        path: &Path,
    ) -> Result<(), JsonFileStoreError> {
        let parent = path
            .parent()
            .ok_or_else(|| JsonFileStoreError::NoParentDirectory {
                path: path.to_path_buf(),
            })?;
        fs::create_dir_all(parent)
            .await
            .map_err(|source| JsonFileStoreError::CreateParent { source })?;
        let lock = Self::get_file_write_lock(path).await;
        let _lock_guard = lock.lock().await;
        let tmp_path = Self::build_temp_json_path(path, 0)?;
        fs::copy(source, &tmp_path)
            .await
            .map_err(|source| JsonFileStoreError::WriteTemp { source })?;
        Self::replace_file_from_temp_strict(path, &tmp_path)
            .await
            .map_err(|source| JsonFileStoreError::Replace { source })
    }

    /// Atomically publish a new UTF-8 text file, failing without changing the
    /// target when another process creates it first.
    pub async fn write_text_atomic_create_new(
        &self,
        path: &Path,
        text: &str,
    ) -> Result<(), JsonFileStoreError> {
        self.write_bytes_atomic_with_policy(
            path,
            text.as_bytes().to_vec(),
            AtomicWritePolicy::CreateNew,
        )
        .await
    }

    async fn write_bytes_atomic_with_policy(
        &self,
        path: &Path,
        bytes: Vec<u8>,
        policy: AtomicWritePolicy,
    ) -> Result<(), JsonFileStoreError> {
        let parent = path
            .parent()
            .ok_or_else(|| JsonFileStoreError::NoParentDirectory {
                path: path.to_path_buf(),
            })?;

        fs::create_dir_all(parent)
            .await
            .map_err(|source| JsonFileStoreError::CreateParent { source })?;

        let lock = Self::get_file_write_lock(path).await;
        let _lock_guard = lock.lock().await;

        let mut last_replace_error: Option<std::io::Error> = None;

        for attempt in 0..=JSON_WRITE_MAX_RETRIES {
            let tmp_path = Self::build_temp_json_path(path, attempt)?;
            if let Err(source) = fs::write(&tmp_path, &bytes).await {
                return Err(JsonFileStoreError::WriteTemp { source });
            }

            let replacement = match policy {
                AtomicWritePolicy::BestEffortReplace => {
                    Self::replace_file_from_temp(path, &tmp_path).await
                }
                AtomicWritePolicy::StrictReplace => {
                    Self::replace_file_from_temp_strict(path, &tmp_path).await
                }
                AtomicWritePolicy::CreateNew => {
                    Self::publish_file_from_temp_new(path, &tmp_path).await
                }
            };
            match replacement {
                Ok(()) => return Ok(()),
                Err(error) => {
                    let should_retry = policy != AtomicWritePolicy::CreateNew
                        && Self::is_retryable_write_error(&error)
                        && attempt < JSON_WRITE_MAX_RETRIES;
                    last_replace_error = Some(error);
                    let _ = fs::remove_file(&tmp_path).await;

                    if should_retry {
                        tokio::time::sleep(Self::retry_delay(attempt)).await;
                        continue;
                    }

                    break;
                }
            }
        }

        if let Some(error) = last_replace_error {
            // On Windows, external scanners/file indexers may temporarily hold a
            // non-shareable handle, making delete/rename fail with
            // PermissionDenied. Fallback to direct write to avoid losing session
            // persistence while keeping best-effort atomic behavior.
            if policy == AtomicWritePolicy::BestEffortReplace
                && error.kind() == ErrorKind::PermissionDenied
            {
                warn!(
                    "Atomic JSON replace permission denied for {}, fallback to direct overwrite",
                    path.display()
                );
                fs::write(path, &bytes).await.map_err(|source| {
                    JsonFileStoreError::FallbackOverwrite {
                        path: path.to_path_buf(),
                        source,
                    }
                })?;
                return Ok(());
            }

            return Err(JsonFileStoreError::Replace { source: error });
        }

        Err(JsonFileStoreError::ReplaceUnknown {
            path: path.to_path_buf(),
        })
    }

    async fn get_file_write_lock(path: &Path) -> Arc<Mutex<()>> {
        let registry = JSON_FILE_WRITE_LOCKS.get_or_init(|| Mutex::new(HashMap::new()));
        let mut registry_guard = registry.lock().await;
        if let Some(existing) = registry_guard.get(path).and_then(Weak::upgrade) {
            return existing;
        }
        // Weak entries keep the map from growing without bound over the
        // process lifetime; drop dead entries before inserting a new one.
        registry_guard.retain(|_, weak| weak.strong_count() > 0);
        let lock = Arc::new(Mutex::new(()));
        registry_guard.insert(path.to_path_buf(), Arc::downgrade(&lock));
        lock
    }

    pub async fn acquire_cross_process_lock(
        &self,
        path: &Path,
    ) -> Result<JsonFileCrossProcessLock, JsonFileStoreError> {
        let parent = path
            .parent()
            .ok_or_else(|| JsonFileStoreError::NoParentDirectory {
                path: path.to_path_buf(),
            })?;
        fs::create_dir_all(parent)
            .await
            .map_err(|source| JsonFileStoreError::CreateParent { source })?;
        let file_name = path
            .file_name()
            .map(|name| name.to_string_lossy().to_string())
            .unwrap_or_else(|| "data.json".to_string());
        let lock_path = path.with_file_name(format!("{file_name}.lock"));
        tokio::task::spawn_blocking(move || {
            // The lock file carries no payload; it exists only to hold the
            // advisory `flock`. Never truncate it — another process may already
            // be holding the lock on this same inode.
            let file = OpenOptions::new()
                .create(true)
                .read(true)
                .write(true)
                .truncate(false)
                .open(&lock_path)
                .map_err(|source| JsonFileStoreError::CrossProcessLock {
                    path: lock_path.clone(),
                    source,
                })?;
            file.lock_exclusive()
                .map_err(|source| JsonFileStoreError::CrossProcessLock {
                    path: lock_path,
                    source,
                })?;
            Ok(JsonFileCrossProcessLock(file))
        })
        .await
        .map_err(|source| JsonFileStoreError::CrossProcessLockTask { source })?
    }

    fn build_temp_json_path(path: &Path, attempt: usize) -> Result<PathBuf, JsonFileStoreError> {
        let parent = path
            .parent()
            .ok_or_else(|| JsonFileStoreError::NoParentDirectory {
                path: path.to_path_buf(),
            })?;

        let file_name = path
            .file_name()
            .map(|name| name.to_string_lossy().to_string())
            .unwrap_or_else(|| "data.json".to_string());
        let nonce = SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .unwrap_or_default()
            .as_nanos();
        let temp_name = format!(
            ".{}.{}.{}.{}.tmp",
            file_name,
            std::process::id(),
            nonce,
            attempt
        );
        Ok(parent.join(temp_name))
    }

    async fn replace_file_from_temp(target_path: &Path, tmp_path: &Path) -> std::io::Result<()> {
        if let Ok(()) = fs::rename(tmp_path, target_path).await {
            return Ok(());
        }

        if target_path.exists() {
            match fs::remove_file(target_path).await {
                Ok(()) => {}
                Err(error) if error.kind() == ErrorKind::NotFound => {}
                Err(error) => return Err(error),
            }
        }

        fs::rename(tmp_path, target_path).await
    }

    async fn publish_file_from_temp_new(
        target_path: &Path,
        tmp_path: &Path,
    ) -> std::io::Result<()> {
        // A same-directory hard link publishes the fully written inode in one
        // step and fails with AlreadyExists instead of replacing a racing file.
        fs::hard_link(tmp_path, target_path).await?;
        if let Err(error) = fs::remove_file(tmp_path).await {
            warn!(
                "Published new file {} but could not remove temporary link {}: {}",
                target_path.display(),
                tmp_path.display(),
                error
            );
        }
        Ok(())
    }

    #[cfg(windows)]
    async fn replace_file_from_temp_strict(
        target_path: &Path,
        tmp_path: &Path,
    ) -> std::io::Result<()> {
        use windows::core::PCWSTR;
        use windows::Win32::Storage::FileSystem::{
            MoveFileExW, ReplaceFileW, MOVEFILE_WRITE_THROUGH, REPLACEFILE_WRITE_THROUGH,
        };

        let temp = Self::windows_extended_path(tmp_path)?;
        let target = Self::windows_extended_path(target_path)?;
        let result = unsafe {
            if target_path.exists() {
                ReplaceFileW(
                    PCWSTR(target.as_ptr()),
                    PCWSTR(temp.as_ptr()),
                    PCWSTR::null(),
                    REPLACEFILE_WRITE_THROUGH,
                    None,
                    None,
                )
            } else {
                MoveFileExW(
                    PCWSTR(temp.as_ptr()),
                    PCWSTR(target.as_ptr()),
                    MOVEFILE_WRITE_THROUGH,
                )
            }
        };
        result.map_err(|error| std::io::Error::other(error.to_string()))
    }

    #[cfg(windows)]
    fn windows_extended_path(path: &Path) -> std::io::Result<Vec<u16>> {
        use std::os::windows::ffi::OsStrExt;

        // `\\?\` disables Win32 normalization. Resolve separators plus dot
        // segments before adding the prefix so both new and existing targets
        // keep normal Path semantics at extended lengths.
        let absolute = std::path::absolute(path)?;
        let path = absolute.as_os_str().encode_wide().collect::<Vec<_>>();
        let slash = b'\\' as u16;
        let mut extended = if path.starts_with(&[slash, slash, b'?' as u16, slash])
            || path.starts_with(&[slash, slash, b'.' as u16, slash])
        {
            path
        } else if path.starts_with(&[slash, slash]) {
            r"\\?\UNC\"
                .encode_utf16()
                .chain(path.into_iter().skip(2))
                .collect()
        } else if path.len() >= 3 && path[1] == b':' as u16 && path[2] == slash {
            r"\\?\".encode_utf16().chain(path).collect()
        } else {
            path
        };
        extended.push(0);
        Ok(extended)
    }

    #[cfg(not(windows))]
    async fn replace_file_from_temp_strict(
        target_path: &Path,
        tmp_path: &Path,
    ) -> std::io::Result<()> {
        fs::rename(tmp_path, target_path).await
    }

    fn is_retryable_write_error(error: &std::io::Error) -> bool {
        matches!(
            error.kind(),
            ErrorKind::PermissionDenied
                | ErrorKind::WouldBlock
                | ErrorKind::Interrupted
                | ErrorKind::TimedOut
                | ErrorKind::AlreadyExists
                | ErrorKind::Other
        )
    }

    fn retry_delay(attempt: usize) -> Duration {
        let exp = attempt.min(6) as u32;
        Duration::from_millis(JSON_WRITE_RETRY_BASE_DELAY_MS * (1u64 << exp))
    }
}

#[cfg(test)]
mod tests {
    use super::JsonFileStore;

    #[tokio::test]
    async fn strict_replace_failure_preserves_the_existing_target() {
        let root = tempfile::tempdir().unwrap();
        let target = root.path().join("preferences.json");
        let missing_replacement = root.path().join("missing.tmp");
        tokio::fs::write(&target, b"old preferences").await.unwrap();

        JsonFileStore::replace_file_from_temp_strict(&target, &missing_replacement)
            .await
            .expect_err("missing replacement must fail");

        assert_eq!(tokio::fs::read(&target).await.unwrap(), b"old preferences");
    }

    #[tokio::test]
    async fn strict_text_write_creates_parents_and_replaces_complete_utf8() {
        let root = tempfile::tempdir().unwrap();
        let target = root.path().join("exports").join("session.md");
        let store = JsonFileStore;

        store
            .write_text_atomic_strict(&target, "first")
            .await
            .unwrap();
        store
            .write_text_atomic_strict(&target, "second 你好")
            .await
            .unwrap();

        assert_eq!(
            tokio::fs::read_to_string(target).await.unwrap(),
            "second 你好"
        );
    }

    #[tokio::test]
    async fn create_new_text_write_never_replaces_a_racing_target() {
        let root = tempfile::tempdir().unwrap();
        let target = root.path().join("exports").join("session.md");
        let store = JsonFileStore;

        store
            .write_text_atomic_create_new(&target, "first")
            .await
            .unwrap();
        let error = store
            .write_text_atomic_create_new(&target, "second")
            .await
            .unwrap_err();

        assert!(error.is_already_exists(), "{error}");
        assert_eq!(tokio::fs::read_to_string(target).await.unwrap(), "first");
    }
}
