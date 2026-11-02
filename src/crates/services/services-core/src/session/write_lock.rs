use crate::file_lock::{is_lock_contention, FileLock, FileLockError, FileLockMode};
use sha2::{Digest, Sha256};
use std::collections::HashMap;
use std::fmt::Write as _;
use std::path::{Path, PathBuf};
use std::sync::{Arc, Mutex, OnceLock, Weak};

/// Keeps one persisted Session writable by only one local process at a time.
///
/// The file may remain after this guard is dropped; ownership is represented
/// by the OS lock, not by file existence.
pub struct SessionWriteLock {
    inner: Arc<SessionWriteLockInner>,
}

struct SessionWriteLockInner {
    lock: Option<FileLock>,
    lock_path: PathBuf,
}

impl SessionWriteLock {
    pub fn try_acquire(
        session_storage_root: &Path,
        session_id: &str,
    ) -> Result<Self, SessionWriteLockError> {
        Self::acquire(session_storage_root, session_id, false)
    }

    /// Reuses a lock already held by this process for one persistence operation.
    /// A new process-level writer still fails through [`Self::try_acquire`].
    #[doc(hidden)]
    pub fn try_acquire_for_operation(
        session_storage_root: &Path,
        session_id: &str,
    ) -> Result<Self, SessionWriteLockError> {
        Self::acquire(session_storage_root, session_id, true)
    }

    fn acquire(
        session_storage_root: &Path,
        session_id: &str,
        reuse_process_writer: bool,
    ) -> Result<Self, SessionWriteLockError> {
        openbitfun_core_types::validate_session_id(session_id)
            .map_err(|_| SessionWriteLockError::InvalidSessionId)?;
        std::fs::create_dir_all(session_storage_root).map_err(|source| {
            SessionWriteLockError::CreateStorageDirectory {
                path: session_storage_root.to_path_buf(),
                source,
            }
        })?;
        let canonical_storage_root =
            std::fs::canonicalize(session_storage_root).map_err(|source| {
                SessionWriteLockError::CanonicalizeStorage {
                    path: session_storage_root.to_path_buf(),
                    source,
                }
            })?;
        let lock_root = session_lock_root(&canonical_storage_root)?;
        std::fs::create_dir_all(&lock_root).map_err(|source| {
            SessionWriteLockError::CreateLockDirectory {
                path: lock_root.clone(),
                source,
            }
        })?;
        let canonical_lock_root = std::fs::canonicalize(&lock_root).map_err(|source| {
            SessionWriteLockError::CreateLockDirectory {
                path: lock_root.clone(),
                source,
            }
        })?;
        let lock_path = canonical_lock_root.join(format!(
            "{}.lock",
            lock_key(&canonical_storage_root, session_id)
        ));
        let mut process_locks = process_locks()
            .lock()
            .expect("Session write lock registry poisoned");
        if let Some(existing) = process_locks.get(&lock_path).and_then(Weak::upgrade) {
            if reuse_process_writer {
                return Ok(Self { inner: existing });
            }
            return Err(SessionWriteLockError::InUse);
        }
        let lock =
            FileLock::try_acquire(&lock_path, FileLockMode::Exclusive).map_err(
                |error| match error {
                    FileLockError::Open(source) => SessionWriteLockError::OpenLockFile {
                        path: lock_path.clone(),
                        source,
                    },
                    FileLockError::Unavailable(source) if is_lock_contention(&source) => {
                        SessionWriteLockError::InUse
                    }
                    FileLockError::Unavailable(source) => {
                        SessionWriteLockError::LockFailed { source }
                    }
                },
            )?;
        let inner = Arc::new(SessionWriteLockInner {
            lock: Some(lock),
            lock_path: lock_path.clone(),
        });
        process_locks.insert(lock_path, Arc::downgrade(&inner));
        Ok(Self { inner })
    }
}

impl Clone for SessionWriteLock {
    fn clone(&self) -> Self {
        Self {
            inner: self.inner.clone(),
        }
    }
}

impl Drop for SessionWriteLockInner {
    fn drop(&mut self) {
        if let Ok(mut process_locks) = process_locks().lock() {
            // Keep the in-process registry authoritative until the OS lock is
            // released so an immediate reacquire cannot observe a false gap.
            drop(self.lock.take());
            process_locks.remove(&self.lock_path);
        }
    }
}

impl std::fmt::Debug for SessionWriteLock {
    fn fmt(&self, formatter: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        formatter
            .debug_struct("SessionWriteLock")
            .field("strong_count", &Arc::strong_count(&self.inner))
            .finish_non_exhaustive()
    }
}

fn process_locks() -> &'static Mutex<HashMap<PathBuf, Weak<SessionWriteLockInner>>> {
    static PROCESS_LOCKS: OnceLock<Mutex<HashMap<PathBuf, Weak<SessionWriteLockInner>>>> =
        OnceLock::new();
    PROCESS_LOCKS.get_or_init(|| Mutex::new(HashMap::new()))
}

#[derive(Debug, thiserror::Error)]
pub enum SessionWriteLockError {
    #[error("session ID is invalid")]
    InvalidSessionId,
    #[error("failed to resolve Session storage path {path}")]
    CanonicalizeStorage {
        path: PathBuf,
        #[source]
        source: std::io::Error,
    },
    #[error("Session storage path cannot be a filesystem root: {path}")]
    InvalidStorageRoot { path: PathBuf },
    #[error("failed to create Session storage directory {path}")]
    CreateStorageDirectory {
        path: PathBuf,
        #[source]
        source: std::io::Error,
    },
    #[error("failed to create Session lock directory {path}")]
    CreateLockDirectory {
        path: PathBuf,
        #[source]
        source: std::io::Error,
    },
    #[error("failed to open Session lock file {path}")]
    OpenLockFile {
        path: PathBuf,
        #[source]
        source: std::io::Error,
    },
    #[error("session is already open for writing")]
    InUse,
    #[error("failed to lock Session for writing")]
    LockFailed {
        #[source]
        source: std::io::Error,
    },
}

impl SessionWriteLockError {
    pub fn code(&self) -> &'static str {
        match self {
            Self::InvalidSessionId => "invalid_session_id",
            Self::CanonicalizeStorage { .. } => "session_storage_resolve_failed",
            Self::InvalidStorageRoot { .. } => "session_storage_root_invalid",
            Self::CreateStorageDirectory { .. } => "session_storage_create_failed",
            Self::CreateLockDirectory { .. } => "session_lock_root_create_failed",
            Self::OpenLockFile { .. } => "session_lock_open_failed",
            Self::InUse => "session_in_use",
            Self::LockFailed { .. } => "session_lock_failed",
        }
    }
}

fn session_lock_root(canonical_storage_root: &Path) -> Result<PathBuf, SessionWriteLockError> {
    canonical_storage_root
        .parent()
        .map(|parent| parent.join(".session-write-locks"))
        .ok_or_else(|| SessionWriteLockError::InvalidStorageRoot {
            path: canonical_storage_root.to_path_buf(),
        })
}

fn lock_key(canonical_storage_root: &Path, session_id: &str) -> String {
    let mut hasher = Sha256::new();
    hasher.update(b"openbitfun-session-write-v1\0");
    hash_path(&mut hasher, canonical_storage_root);
    hasher.update(b"\0");
    hasher.update(session_id.as_bytes());
    let digest = hasher.finalize();
    let mut encoded = String::with_capacity(digest.len() * 2);
    for byte in digest {
        write!(&mut encoded, "{byte:02x}").expect("writing to String cannot fail");
    }
    encoded
}

fn hash_path(hasher: &mut Sha256, path: &Path) {
    #[cfg(unix)]
    {
        use std::os::unix::ffi::OsStrExt;
        hasher.update(path.as_os_str().as_bytes());
    }
    #[cfg(windows)]
    {
        use std::os::windows::ffi::OsStrExt;
        for unit in path.as_os_str().encode_wide() {
            hasher.update(unit.to_le_bytes());
        }
    }
}

#[cfg(test)]
mod tests {
    use super::{session_lock_root, SessionWriteLockError};
    use std::path::Path;

    #[test]
    fn filesystem_root_is_rejected_without_panicking() {
        #[cfg(unix)]
        let root = Path::new("/");
        #[cfg(windows)]
        let root = Path::new(r"C:\");

        let error = session_lock_root(root).expect_err("filesystem root must be rejected");
        assert!(matches!(
            error,
            SessionWriteLockError::InvalidStorageRoot { .. }
        ));
        assert_eq!(error.code(), "session_storage_root_invalid");
    }
}
