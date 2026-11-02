//! PID-file based liveness tracking for the CLI daemon.
//!
//! The daemon records its pid in `~/.openbitfun/cli_daemon.pid` so interactive
//! CLI processes can detect a running daemon and yield device routing to it
//! (same-machine processes share one `device_id`; last AuthConnect wins).

use std::path::{Path, PathBuf};

use anyhow::{anyhow, Context, Result};

fn default_pid_file_path() -> Result<PathBuf> {
    let paths = openbitfun_core::infrastructure::PathManager::new()
        .map_err(|error| anyhow!("resolve daemon storage: {error}"))?;
    Ok(paths.product_home_dir().join("cli_daemon.pid"))
}

fn write_pid_file_to(path: &Path, pid: u32) -> Result<()> {
    if let Some(parent) = path.parent() {
        std::fs::create_dir_all(parent)
            .with_context(|| format!("create pid file directory {}", parent.display()))?;
    }
    std::fs::write(path, pid.to_string())
        .with_context(|| format!("write pid file {}", path.display()))
}

fn read_pid_file_from(path: &Path) -> Option<u32> {
    std::fs::read_to_string(path).ok()?.trim().parse().ok()
}

fn remove_pid_file_at(path: &Path) {
    if let Err(error) = std::fs::remove_file(path) {
        if error.kind() != std::io::ErrorKind::NotFound {
            tracing::warn!(
                "Failed to remove daemon pid file {}: {error}",
                path.display()
            );
        }
    }
}

/// Write the current process id to the daemon pid file.
pub(crate) fn write_pid_file() -> Result<()> {
    write_pid_file_to(&default_pid_file_path()?, std::process::id())
}

/// Remove the daemon pid file. Called on daemon shutdown.
pub(crate) fn remove_pid_file() {
    if let Ok(path) = default_pid_file_path() {
        remove_pid_file_at(&path);
    }
}

/// Whether a daemon process recorded in the pid file is alive right now.
pub(crate) fn is_daemon_running() -> bool {
    if super::control::owner_is_running() {
        return true;
    }
    default_pid_file_path()
        .ok()
        .and_then(|path| read_pid_file_from(&path))
        .is_some_and(process_alive)
}

/// Ask a running daemon (if any) to shut down. Returns true when a live
/// daemon was signalled.
#[cfg(unix)]
pub(crate) fn request_daemon_shutdown() -> bool {
    if super::control::request_shutdown() {
        return true;
    }
    let Some(pid) = default_pid_file_path()
        .ok()
        .and_then(|path| read_pid_file_from(&path))
    else {
        return false;
    };
    if !process_alive(pid) {
        return false;
    }
    // SAFETY: signalling a recorded pid; no memory involved.
    unsafe { libc::kill(pid as libc::pid_t, libc::SIGTERM) == 0 }
}

#[cfg(not(unix))]
pub(crate) fn request_daemon_shutdown() -> bool {
    super::control::request_shutdown()
}

/// Whether the given pid refers to a live process.
#[cfg(unix)]
pub(crate) fn process_alive(pid: u32) -> bool {
    // kill(pid, 0) performs error checking without sending a signal.
    // EPERM means the process exists but is owned by another user.
    // SAFETY: signal 0 delivers nothing; no memory involved.
    if unsafe { libc::kill(pid as libc::pid_t, 0) } == 0 {
        return true;
    }
    matches!(
        std::io::Error::last_os_error().raw_os_error(),
        Some(libc::EPERM)
    )
}

#[cfg(not(unix))]
pub(crate) fn process_alive(_pid: u32) -> bool {
    false
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn pid_file_roundtrip() {
        let dir = tempfile::tempdir().expect("tempdir");
        let path = dir.path().join("cli_daemon.pid");

        write_pid_file_to(&path, 12345).expect("write pid file");
        assert_eq!(read_pid_file_from(&path), Some(12345));

        remove_pid_file_at(&path);
        assert_eq!(read_pid_file_from(&path), None);
    }

    #[test]
    fn read_pid_file_rejects_garbage() {
        let dir = tempfile::tempdir().expect("tempdir");
        let path = dir.path().join("cli_daemon.pid");
        std::fs::write(&path, "not-a-pid").expect("write garbage");
        assert_eq!(read_pid_file_from(&path), None);
    }

    #[cfg(unix)]
    #[test]
    fn process_alive_detects_self_and_missing() {
        assert!(process_alive(std::process::id()));
        // 2^30 is far beyond any realistic pid on Linux/macOS.
        assert!(!process_alive(1 << 30));
    }
}
