use crate::file_lock::{is_lock_contention, FileLock, FileLockError, FileLockMode};
use std::collections::HashMap;
use std::path::{Path, PathBuf};
use std::sync::{Arc, Mutex, OnceLock, Weak};

/// Holds one shared resource for a single process at a time.
///
/// Where `session::write_lock` guards one Session, this guards a resource that
/// an owning process keeps for its whole lifetime — a scheduler loop, a store
/// writer. Ownership is represented by the OS lock, not by file existence:
/// the lock file may remain on disk after the lease is released, and a stale
/// file never implies ownership.
pub struct ExclusiveFileLease {
    inner: Arc<ExclusiveFileLeaseInner>,
}

struct ExclusiveFileLeaseInner {
    lock: Option<FileLock>,
    lock_path: PathBuf,
}

impl ExclusiveFileLease {
    /// Acquires the lease without waiting so callers can degrade to a standby
    /// state instead of blocking startup on another process.
    ///
    /// The parent directory is created when missing, so the caller does not have
    /// to pre-create the lease location.
    pub fn try_acquire(lock_path: &Path) -> Result<Self, ExclusiveFileLeaseError> {
        if let Some(parent) = lock_path
            .parent()
            .filter(|parent| !parent.as_os_str().is_empty())
        {
            std::fs::create_dir_all(parent).map_err(|source| {
                ExclusiveFileLeaseError::CreateLeaseDirectory {
                    path: parent.to_path_buf(),
                    source,
                }
            })?;
        }
        let mut process_leases = process_leases()
            .lock()
            .expect("Exclusive file lease registry poisoned");
        if process_leases
            .get(lock_path)
            .and_then(Weak::upgrade)
            .is_some()
        {
            return Err(ExclusiveFileLeaseError::InUse);
        }
        let lock =
            FileLock::try_acquire(lock_path, FileLockMode::Exclusive).map_err(
                |error| match error {
                    FileLockError::Open(source) => ExclusiveFileLeaseError::OpenLeaseFile {
                        path: lock_path.to_path_buf(),
                        source,
                    },
                    FileLockError::Unavailable(source) if is_lock_contention(&source) => {
                        ExclusiveFileLeaseError::InUse
                    }
                    FileLockError::Unavailable(source) => {
                        ExclusiveFileLeaseError::LockFailed { source }
                    }
                },
            )?;
        let inner = Arc::new(ExclusiveFileLeaseInner {
            lock: Some(lock),
            lock_path: lock_path.to_path_buf(),
        });
        process_leases.insert(lock_path.to_path_buf(), Arc::downgrade(&inner));
        Ok(Self { inner })
    }

    /// The path whose OS lock represents ownership. Useful for diagnostics.
    pub fn lock_path(&self) -> &Path {
        &self.inner.lock_path
    }
}

impl Drop for ExclusiveFileLeaseInner {
    fn drop(&mut self) {
        if let Ok(mut process_leases) = process_leases().lock() {
            // Keep the in-process registry authoritative until the OS lock is
            // released so an immediate reacquire cannot observe a false gap.
            drop(self.lock.take());
            process_leases.remove(&self.lock_path);
        }
    }
}

impl std::fmt::Debug for ExclusiveFileLease {
    fn fmt(&self, formatter: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        formatter
            .debug_struct("ExclusiveFileLease")
            .field("lock_path", &self.inner.lock_path)
            .field("strong_count", &Arc::strong_count(&self.inner))
            .finish()
    }
}

fn process_leases() -> &'static Mutex<HashMap<PathBuf, Weak<ExclusiveFileLeaseInner>>> {
    static PROCESS_LEASES: OnceLock<Mutex<HashMap<PathBuf, Weak<ExclusiveFileLeaseInner>>>> =
        OnceLock::new();
    PROCESS_LEASES.get_or_init(|| Mutex::new(HashMap::new()))
}

#[derive(Debug, thiserror::Error)]
pub enum ExclusiveFileLeaseError {
    #[error("failed to create lease directory {path}")]
    CreateLeaseDirectory {
        path: PathBuf,
        #[source]
        source: std::io::Error,
    },
    #[error("failed to open lease file {path}")]
    OpenLeaseFile {
        path: PathBuf,
        #[source]
        source: std::io::Error,
    },
    #[error("resource is already leased by another owner")]
    InUse,
    #[error("failed to acquire lease")]
    LockFailed {
        #[source]
        source: std::io::Error,
    },
}

impl ExclusiveFileLeaseError {
    pub fn code(&self) -> &'static str {
        match self {
            Self::CreateLeaseDirectory { .. } => "lease_directory_create_failed",
            Self::OpenLeaseFile { .. } => "lease_open_failed",
            Self::InUse => "lease_in_use",
            Self::LockFailed { .. } => "lease_lock_failed",
        }
    }
}
