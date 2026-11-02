use fs2::FileExt;
use std::fs::{File, OpenOptions};
use std::path::Path;

pub(crate) enum FileLockMode {
    #[cfg(feature = "runtime-ownership")]
    Shared,
    Exclusive,
}

pub(crate) struct FileLock {
    file: File,
}

#[derive(Debug)]
pub(crate) enum FileLockError {
    Open(std::io::Error),
    Unavailable(std::io::Error),
}

impl FileLock {
    #[cfg(feature = "local-storage")]
    pub(crate) fn acquire(path: &Path, mode: FileLockMode) -> Result<Self, FileLockError> {
        let file = open_lock_file(path)?;
        match mode {
            #[cfg(feature = "runtime-ownership")]
            FileLockMode::Shared => FileExt::lock_shared(&file),
            FileLockMode::Exclusive => FileExt::lock_exclusive(&file),
        }
        .map_err(FileLockError::Unavailable)?;
        Ok(Self { file })
    }

    pub(crate) fn try_acquire(path: &Path, mode: FileLockMode) -> Result<Self, FileLockError> {
        let file = open_lock_file(path)?;
        match mode {
            #[cfg(feature = "runtime-ownership")]
            FileLockMode::Shared => FileExt::try_lock_shared(&file),
            FileLockMode::Exclusive => FileExt::try_lock_exclusive(&file),
        }
        .map_err(FileLockError::Unavailable)?;
        Ok(Self { file })
    }
}

/// Whether a failed lock attempt means "someone else holds it" rather than a
/// real filesystem failure. Callers map this to their own `InUse` error.
///
/// A contended `flock` reports `EAGAIN`/`EWOULDBLOCK`, which `std` already
/// surfaces as [`std::io::ErrorKind::WouldBlock`] on every supported platform,
/// so this stays free of platform crates.
pub(crate) fn is_lock_contention(error: &std::io::Error) -> bool {
    if error.kind() == std::io::ErrorKind::WouldBlock {
        return true;
    }
    #[cfg(windows)]
    {
        // ERROR_LOCK_VIOLATION: an exclusive lock is held by someone else.
        error.raw_os_error() == Some(33)
    }
    #[cfg(not(windows))]
    {
        false
    }
}

fn open_lock_file(path: &Path) -> Result<File, FileLockError> {
    OpenOptions::new()
        .create(true)
        .truncate(false)
        .read(true)
        .write(true)
        .open(path)
        .map_err(FileLockError::Open)
}

impl Drop for FileLock {
    fn drop(&mut self) {
        let _ = FileExt::unlock(&self.file);
    }
}
