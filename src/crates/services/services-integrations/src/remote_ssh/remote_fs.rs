//! Remote file system operations via SFTP
//!
//! This module provides remote file system operations using the SFTP protocol

use crate::remote_ssh::types::{RemoteDirEntry, RemoteFileEntry, RemoteTreeNode};
use anyhow::anyhow;
use openbitfun_services_core::product_identity::hidden_data_directory;
use std::sync::Arc;

/// Names skipped when listing workspace root for system-prompt preview (still lazy: no descent).
fn should_skip_dir_in_prompt_preview(name: &str) -> bool {
    matches!(
        name,
        "node_modules"
            | ".git"
            | "target"
            | ".cargo"
            | "__pycache__"
            | "dist"
            | "build"
            | ".venv"
            | "venv"
            | "vendor"
            | ".next"
            | ".cache"
            | ".nx"
            | ".gradle"
    )
}

/// Extract a basename using remote POSIX semantics on every client platform.
///
/// `std::path::Path` uses host semantics and would treat `\` as a separator on
/// Windows even though it is a valid character in a Unix remote filename.
fn remote_posix_basename(path: &str) -> String {
    let trimmed = path.trim_end_matches('/');
    trimmed
        .rsplit('/')
        .next()
        .filter(|name| !name.is_empty())
        .unwrap_or(path)
        .to_string()
}

/// Sibling staging path used to publish an upload without truncating the
/// current destination.
///
/// Remote paths are POSIX on every client platform, so the parent directory is
/// split without host `std::path` semantics.
fn staged_upload_path(destination: &str, token: &str) -> String {
    let name = format!("{}-upload-{}.tmp", hidden_data_directory(), token);
    match destination.rsplit_once('/') {
        None => name,
        Some(("", _)) => format!("/{name}"),
        Some((parent, _)) => format!("{parent}/{name}"),
    }
}

/// Best-effort removal of a staged upload that never replaced its destination.
///
/// The transfer already failed, so a failed cleanup only leaves one orphaned
/// temporary beside the destination and must not replace the real error.
async fn discard_staged_upload(
    manager: &crate::remote_ssh::manager::SSHConnectionManager,
    connection_id: &str,
    staging: &str,
) {
    if let Err(error) = manager.sftp_remove(connection_id, staging).await {
        log::warn!(
            "Failed to remove staged remote upload '{}': {}",
            staging,
            error
        );
    }
}

/// Remote file service using SFTP protocol
#[derive(Clone)]
pub struct RemoteFileService {
    manager: Arc<tokio::sync::RwLock<Option<crate::remote_ssh::manager::SSHConnectionManager>>>,
}

impl RemoteFileService {
    pub fn new(
        manager: Arc<tokio::sync::RwLock<Option<crate::remote_ssh::manager::SSHConnectionManager>>>,
    ) -> Self {
        Self { manager }
    }

    pub async fn open_write_new(
        &self,
        connection_id: &str,
        path: &str,
    ) -> anyhow::Result<openbitfun_runtime_ports::WorkspaceWriter> {
        self.get_manager(connection_id)
            .await?
            .open_workspace_file_write_new(connection_id, path)
            .await
    }

    pub async fn atomic_replace(
        &self,
        connection_id: &str,
        from: &str,
        to: &str,
    ) -> anyhow::Result<()> {
        self.get_manager(connection_id)
            .await?
            .atomic_replace_workspace_file(connection_id, from, to)
            .await
    }

    pub async fn open_read(
        &self,
        connection_id: &str,
        path: &str,
    ) -> anyhow::Result<openbitfun_runtime_ports::WorkspaceReader> {
        self.get_manager(connection_id)
            .await?
            .open_workspace_file_read(connection_id, path)
            .await
    }

    pub async fn workspace_metadata(
        &self,
        connection_id: &str,
        path: &str,
        follow_symlinks: bool,
    ) -> anyhow::Result<Option<openbitfun_runtime_ports::WorkspaceMetadata>> {
        let manager = self.get_manager(connection_id).await?;
        if manager.is_shell_workspace(connection_id).await {
            return manager
                .container_workspace_metadata(connection_id, path, follow_symlinks)
                .await;
        }
        let attrs = match if follow_symlinks {
            manager.sftp_stat(connection_id, path).await
        } else {
            manager.sftp_lstat(connection_id, path).await
        } {
            Ok(attrs) => attrs,
            Err(error) if is_sftp_not_found(&error) => return Ok(None),
            Err(error) => return Err(error),
        };
        use openbitfun_runtime_ports::{WorkspaceMetadata, WorkspacePathKind};
        let file_type = attrs.file_type();
        let kind = if file_type.is_symlink() {
            WorkspacePathKind::Symlink
        } else if file_type.is_dir() {
            WorkspacePathKind::Directory
        } else if file_type.is_file() {
            WorkspacePathKind::File
        } else {
            WorkspacePathKind::Other
        };
        Ok(Some(WorkspaceMetadata {
            kind,
            size: attrs.size,
            modified: attrs.mtime.map(|seconds| {
                std::time::UNIX_EPOCH + std::time::Duration::from_secs(seconds as u64)
            }),
            permissions: attrs.permissions,
        }))
    }

    pub async fn set_permissions(
        &self,
        connection_id: &str,
        path: &str,
        permissions: u32,
    ) -> anyhow::Result<()> {
        self.get_manager(connection_id)
            .await?
            .set_workspace_file_permissions(connection_id, path, permissions)
            .await
    }

    pub async fn set_modified(
        &self,
        connection_id: &str,
        path: &str,
        modified: std::time::SystemTime,
    ) -> anyhow::Result<()> {
        self.get_manager(connection_id)
            .await?
            .set_workspace_file_modified(connection_id, path, modified)
            .await
    }

    /// Get the SSH manager
    async fn get_manager(
        &self,
        _connection_id: &str,
    ) -> anyhow::Result<crate::remote_ssh::manager::SSHConnectionManager> {
        let guard = self.manager.read().await;
        guard
            .as_ref()
            .cloned()
            .ok_or_else(|| anyhow!("SSH manager not initialized"))
    }

    /// Read a file from the remote server via SFTP
    pub async fn read_file(&self, connection_id: &str, path: &str) -> anyhow::Result<Vec<u8>> {
        let manager = self.get_manager(connection_id).await?;
        if manager.is_shell_workspace(connection_id).await {
            return manager.container_read_file(connection_id, path).await;
        }
        manager.sftp_read(connection_id, path).await
    }

    /// Read a file from the remote server via SFTP with chunked progress
    /// reporting. `on_progress` is called with `(bytes_read, total_size)`
    /// after each chunk.
    pub async fn read_file_with_progress(
        &self,
        connection_id: &str,
        path: &str,
        on_progress: &mut impl FnMut(u64, u64) -> bool,
    ) -> anyhow::Result<Vec<u8>> {
        let manager = self.get_manager(connection_id).await?;
        if manager.is_shell_workspace(connection_id).await {
            return manager
                .container_read_file_with_progress(connection_id, path, on_progress)
                .await;
        }
        manager
            .sftp_read_with_progress(connection_id, path, 262_144, on_progress)
            .await
    }

    /// Write content to a remote file via SFTP
    pub async fn write_file(
        &self,
        connection_id: &str,
        path: &str,
        content: &[u8],
    ) -> anyhow::Result<()> {
        let manager = self.get_manager(connection_id).await?;
        if manager.is_shell_workspace(connection_id).await {
            return manager
                .container_write_file(connection_id, path, content)
                .await;
        }
        manager.sftp_write(connection_id, path, content).await
    }

    /// Workspace edits follow the existing target instead of replacing an
    /// upload destination. Keep generic upload semantics in `write_file`.
    pub async fn write_workspace_file(
        &self,
        connection_id: &str,
        path: &str,
        content: &[u8],
    ) -> anyhow::Result<()> {
        self.get_manager(connection_id)
            .await?
            .write_workspace_file(connection_id, path, content)
            .await
    }

    /// Write content to a remote file via SFTP with chunked progress
    /// reporting. `on_progress` is called with `(bytes_written, total_size)`
    /// after each chunk. Returns `false` from the callback to cancel.
    pub async fn write_file_with_progress(
        &self,
        connection_id: &str,
        path: &str,
        content: &[u8],
        on_progress: &mut impl FnMut(u64, u64) -> bool,
    ) -> anyhow::Result<()> {
        let manager = self.get_manager(connection_id).await?;
        if manager.is_shell_workspace(connection_id).await {
            return manager
                .container_write_file_with_progress(connection_id, path, content, on_progress)
                .await;
        }
        manager
            .sftp_write_with_progress(connection_id, path, content, 262_144, on_progress)
            .await
    }

    /// Stream a local file to a remote upload destination.
    ///
    /// The bytes land in a sibling temporary file and replace the destination
    /// only after the transfer completed, so a cancelled or failed upload never
    /// truncates a valid destination with partial content. The temporary name
    /// follows the same shape as the container upload staging, so both
    /// providers leave identically named temporaries beside the destination.
    ///
    /// Container workspaces run their own staging command, which verifies the
    /// received size and publishes the destination itself, so they stream
    /// straight into that command instead of through SFTP.
    pub async fn write_file_from_local_path_with_progress(
        &self,
        connection_id: &str,
        path: &str,
        local_path: &std::path::Path,
        on_progress: &mut impl FnMut(u64, u64) -> bool,
    ) -> anyhow::Result<u64> {
        let manager = self.get_manager(connection_id).await?;
        if manager.is_shell_workspace(connection_id).await {
            return manager
                .container_write_file_from_path_with_progress(
                    connection_id,
                    path,
                    local_path,
                    on_progress,
                )
                .await;
        }

        let staging = staged_upload_path(path, &uuid::Uuid::new_v4().to_string());
        let written = match manager
            .sftp_write_from_file_with_progress(
                connection_id,
                &staging,
                local_path,
                u64::MAX,
                on_progress,
            )
            .await
        {
            Ok(written) => written,
            Err(error) => {
                discard_staged_upload(&manager, connection_id, &staging).await;
                return Err(error);
            }
        };
        if let Err(error) = self.atomic_replace(connection_id, &staging, path).await {
            discard_staged_upload(&manager, connection_id, &staging).await;
            return Err(error);
        }
        Ok(written)
    }

    /// Check if a remote path exists
    pub async fn exists(&self, connection_id: &str, path: &str) -> anyhow::Result<bool> {
        let manager = self.get_manager(connection_id).await?;
        if manager.is_shell_workspace(connection_id).await {
            return manager.container_exists(connection_id, path).await;
        }
        manager.sftp_exists(connection_id, path).await
    }

    /// Check if a remote path is a regular file
    pub async fn is_file(&self, connection_id: &str, path: &str) -> anyhow::Result<bool> {
        match self.stat(connection_id, path).await? {
            Some(entry) => Ok(entry.is_file),
            None => Ok(false),
        }
    }

    /// Check if a remote path is a directory
    pub async fn is_dir(&self, connection_id: &str, path: &str) -> anyhow::Result<bool> {
        match self.stat(connection_id, path).await? {
            Some(entry) => Ok(entry.is_dir),
            None => Ok(false),
        }
    }

    /// Read directory contents via SFTP
    pub async fn read_dir(
        &self,
        connection_id: &str,
        path: &str,
    ) -> anyhow::Result<Vec<RemoteDirEntry>> {
        self.read_dir_with_limit(connection_id, path, None).await
    }

    pub async fn read_dir_bounded(
        &self,
        connection_id: &str,
        path: &str,
        max_entries: usize,
    ) -> anyhow::Result<Vec<RemoteDirEntry>> {
        self.read_dir_with_limit(connection_id, path, Some(max_entries))
            .await
    }

    async fn read_dir_with_limit(
        &self,
        connection_id: &str,
        path: &str,
        max_entries: Option<usize>,
    ) -> anyhow::Result<Vec<RemoteDirEntry>> {
        let manager = self.get_manager(connection_id).await?;
        if manager.is_shell_workspace(connection_id).await {
            return match max_entries {
                Some(max_entries) => {
                    manager
                        .container_read_dir_bounded(connection_id, path, max_entries)
                        .await
                }
                None => manager.container_read_dir(connection_id, path).await,
            };
        }
        let path_resolved = manager.resolve_sftp_path(connection_id, path).await?;
        match max_entries {
            Some(max_entries) => Ok(manager
                .sftp_read_dir_bounded(connection_id, path, max_entries)
                .await?
                .into_iter()
                .map(|entry| {
                    remote_dir_entry_from_metadata(&path_resolved, entry.filename, entry.attrs)
                })
                .collect()),
            None => Ok(manager
                .sftp_read_dir(connection_id, path)
                .await?
                .into_iter()
                .map(|entry| {
                    remote_dir_entry_from_metadata(&path_resolved, entry.filename, entry.attrs)
                })
                .collect()),
        }
    }

    /// Build a tree of remote directory structure (full walk; used by file explorer).
    pub async fn build_tree(
        &self,
        connection_id: &str,
        path: &str,
        max_depth: Option<u32>,
    ) -> anyhow::Result<RemoteTreeNode> {
        let max_depth = max_depth.unwrap_or(3);
        Box::pin(self.build_tree_impl(connection_id, path, 0, max_depth)).await
    }

    /// System prompt only: **one** SFTP `read_dir` at `path`, no recursion into subdirectories.
    /// Deep structure is left to list/glob tools (lazy expansion).
    pub async fn build_shallow_tree_for_layout_preview(
        &self,
        connection_id: &str,
        path: &str,
    ) -> anyhow::Result<RemoteTreeNode> {
        const MAX_ENTRIES: usize = 80;
        let name = remote_posix_basename(path);

        let mut entries = self.read_dir(connection_id, path).await?;
        entries.retain(|e| {
            if e.is_dir {
                !should_skip_dir_in_prompt_preview(&e.name)
            } else {
                true
            }
        });
        entries.sort_by(|a, b| match (a.is_dir, b.is_dir) {
            (true, false) => std::cmp::Ordering::Less,
            (false, true) => std::cmp::Ordering::Greater,
            _ => a.name.cmp(&b.name),
        });
        entries.truncate(MAX_ENTRIES);

        let children: Vec<RemoteTreeNode> = entries
            .into_iter()
            .map(|e| RemoteTreeNode {
                name: e.name,
                path: e.path,
                is_dir: e.is_dir,
                children: None,
            })
            .collect();

        Ok(RemoteTreeNode {
            name,
            path: path.to_string(),
            is_dir: true,
            children: Some(children),
        })
    }

    async fn build_tree_impl(
        &self,
        connection_id: &str,
        path: &str,
        current_depth: u32,
        max_depth: u32,
    ) -> anyhow::Result<RemoteTreeNode> {
        let name = remote_posix_basename(path);

        // Check if this is a directory
        let is_dir: bool = self.exists(connection_id, path).await.unwrap_or_default();

        // Check if it's a directory by trying to read it
        let is_dir = if is_dir {
            let entries = self.read_dir(connection_id, path).await;
            entries.is_ok()
        } else {
            false
        };

        if !is_dir || current_depth >= max_depth {
            return Ok(RemoteTreeNode {
                name,
                path: path.to_string(),
                is_dir,
                children: None,
            });
        }

        // Read directory contents
        let entries = match self.read_dir(connection_id, path).await {
            Ok(entries) => entries,
            Err(_) => {
                return Ok(RemoteTreeNode {
                    name,
                    path: path.to_string(),
                    is_dir: false,
                    children: None,
                });
            }
        };

        let mut children = Vec::new();

        for entry in entries {
            if entry.is_dir {
                match Box::pin(self.build_tree_impl(
                    connection_id,
                    &entry.path,
                    current_depth + 1,
                    max_depth,
                ))
                .await
                {
                    Ok(child) => children.push(child),
                    Err(_) => {
                        children.push(RemoteTreeNode {
                            name: entry.name,
                            path: entry.path,
                            is_dir: true,
                            children: None,
                        });
                    }
                }
            } else {
                children.push(RemoteTreeNode {
                    name: entry.name,
                    path: entry.path,
                    is_dir: false,
                    children: None,
                });
            }
        }

        Ok(RemoteTreeNode {
            name,
            path: path.to_string(),
            is_dir: true,
            children: Some(children),
        })
    }

    /// Create a directory on the remote server via SFTP
    pub async fn create_dir(&self, connection_id: &str, path: &str) -> anyhow::Result<()> {
        let manager = self.get_manager(connection_id).await?;
        if manager.is_shell_workspace(connection_id).await {
            return manager.container_mkdir(connection_id, path, false).await;
        }
        manager.sftp_mkdir(connection_id, path).await
    }

    /// Create directory and all parent directories via SFTP
    pub async fn create_dir_all(&self, connection_id: &str, path: &str) -> anyhow::Result<()> {
        let manager = self.get_manager(connection_id).await?;
        if manager.is_shell_workspace(connection_id).await {
            return manager.container_mkdir(connection_id, path, true).await;
        }
        manager.sftp_mkdir_all(connection_id, path).await
    }

    /// Remove a file from the remote server via SFTP
    pub async fn remove_file(&self, connection_id: &str, path: &str) -> anyhow::Result<()> {
        let manager = self.get_manager(connection_id).await?;
        if manager.is_shell_workspace(connection_id).await {
            return manager.container_remove(connection_id, path, false).await;
        }
        manager.sftp_remove(connection_id, path).await
    }

    /// Remove a directory and its contents recursively via SFTP
    pub async fn remove_dir_all(&self, connection_id: &str, path: &str) -> anyhow::Result<()> {
        // Match local remove_dir_all: unlink a final symlink without traversing
        // its target. Recheck at every recursive step, including the root.
        match self
            .workspace_metadata(connection_id, path, false)
            .await?
            .map(|metadata| metadata.kind)
        {
            Some(openbitfun_runtime_ports::WorkspacePathKind::Symlink) => {
                return self.remove_file(connection_id, path).await
            }
            Some(openbitfun_runtime_ports::WorkspacePathKind::Directory) => {}
            Some(_) => anyhow::bail!("Remote path is not a directory: {path}"),
            None => anyhow::bail!("Remote directory does not exist: {path}"),
        }
        // First, delete all contents
        {
            let entries = self.read_dir(connection_id, path).await?;
            for entry in entries {
                let entry_path = entry.path.clone();
                if entry.is_dir && !entry.is_symlink {
                    Box::pin(self.remove_dir_all(connection_id, &entry_path)).await?;
                } else {
                    let manager = self.get_manager(connection_id).await?;
                    if manager.is_shell_workspace(connection_id).await {
                        manager
                            .container_remove(connection_id, &entry_path, false)
                            .await?;
                    } else {
                        manager.sftp_remove(connection_id, &entry_path).await?;
                    }
                }
            }
        }

        // Then remove the directory itself
        let manager = self.get_manager(connection_id).await?;
        if manager.is_shell_workspace(connection_id).await {
            manager.container_remove(connection_id, path, true).await
        } else {
            manager.sftp_rmdir(connection_id, path).await
        }
    }

    /// Remove an empty directory via SFTP (non-recursive; fails if not empty)
    pub async fn remove_dir(&self, connection_id: &str, path: &str) -> anyhow::Result<()> {
        let manager = self.get_manager(connection_id).await?;
        if manager.is_shell_workspace(connection_id).await {
            manager.container_remove(connection_id, path, true).await
        } else {
            manager.sftp_rmdir(connection_id, path).await
        }
    }

    /// Rename/move a remote file or directory via SFTP
    pub async fn rename(
        &self,
        connection_id: &str,
        old_path: &str,
        new_path: &str,
    ) -> anyhow::Result<()> {
        let manager = self.get_manager(connection_id).await?;
        if manager.is_shell_workspace(connection_id).await {
            return manager
                .container_rename(connection_id, old_path, new_path)
                .await;
        }
        manager.sftp_rename(connection_id, old_path, new_path).await
    }

    /// Get file metadata via SFTP
    pub async fn stat(
        &self,
        connection_id: &str,
        path: &str,
    ) -> anyhow::Result<Option<RemoteFileEntry>> {
        let manager = self.get_manager(connection_id).await?;
        if manager.is_shell_workspace(connection_id).await {
            return manager.container_stat(connection_id, path).await;
        }

        remote_file_entry_from_stat_result(path, manager.sftp_stat(connection_id, path).await)
    }

    /// Get metadata for one exact path without following its final symlink.
    pub async fn symlink_stat(
        &self,
        connection_id: &str,
        path: &str,
    ) -> anyhow::Result<Option<RemoteFileEntry>> {
        let manager = self.get_manager(connection_id).await?;
        if manager.is_shell_workspace(connection_id).await {
            return manager.container_stat(connection_id, path).await;
        }
        remote_file_entry_from_stat_result(path, manager.sftp_lstat(connection_id, path).await)
    }
}

fn remote_file_entry_from_stat_result(
    path: &str,
    result: anyhow::Result<russh_sftp::client::fs::Metadata>,
) -> anyhow::Result<Option<RemoteFileEntry>> {
    match result {
        Ok(attrs) => Ok(Some(remote_file_entry_from_metadata(path, attrs))),
        Err(error) if is_sftp_not_found(&error) => Ok(None),
        Err(error) => Err(error),
    }
}

fn is_sftp_not_found(error: &anyhow::Error) -> bool {
    matches!(
        error.downcast_ref::<russh_sftp::client::error::Error>(),
        Some(russh_sftp::client::error::Error::Status(status))
            if status.status_code == russh_sftp::protocol::StatusCode::NoSuchFile
    )
}

fn remote_dir_entry_from_metadata(
    parent: &str,
    name: String,
    metadata: russh_sftp::client::fs::Metadata,
) -> RemoteDirEntry {
    let path = if parent.ends_with('/') {
        format!("{parent}{name}")
    } else {
        format!("{parent}/{name}")
    };
    let file_type = metadata.file_type();
    let is_dir = file_type.is_dir();
    RemoteDirEntry {
        name,
        path,
        is_dir,
        is_file: file_type.is_file(),
        is_symlink: file_type.is_symlink(),
        size: if is_dir { None } else { metadata.size },
        modified: metadata.mtime.map(|time| (time as u64) * 1000),
        permissions: Some(format_permissions(metadata.permissions)),
    }
}

fn remote_file_entry_from_metadata(
    path: &str,
    attrs: russh_sftp::client::fs::Metadata,
) -> RemoteFileEntry {
    let file_type = attrs.file_type();
    let is_dir = file_type.is_dir();
    let is_symlink = file_type.is_symlink();
    RemoteFileEntry {
        name: remote_posix_basename(path),
        path: path.to_string(),
        is_dir,
        is_file: file_type.is_file(),
        is_symlink,
        size: if is_dir { None } else { attrs.size },
        modified: attrs.mtime.map(|time| (time as u64) * 1000),
        permissions: Some(format_permissions(attrs.permissions)),
    }
}

/// Format file permissions as string (e.g., "rwxr-xr-x")
fn format_permissions(mode: Option<u32>) -> String {
    let mode = match mode {
        Some(m) => m,
        None => return "---------".to_string(),
    };

    let file_type = match mode & 0o170000 {
        0o040000 => 'd', // directory
        0o120000 => 'l', // symbolic link
        0o060000 => 'b', // block device
        0o020000 => 'c', // character device
        0o010000 => 'p', // FIFO
        0o140000 => 's', // socket
        _ => '-',        // regular file
    };

    let perms = [
        (mode & 0o400 != 0, 'r'),
        (mode & 0o200 != 0, 'w'),
        (mode & 0o100 != 0, 'x'),
        (mode & 0o040 != 0, 'r'),
        (mode & 0o020 != 0, 'w'),
        (mode & 0o010 != 0, 'x'),
        (mode & 0o004 != 0, 'r'),
        (mode & 0o002 != 0, 'w'),
        (mode & 0o001 != 0, 'x'),
    ];

    let perm_str: String = perms
        .iter()
        .map(|(set, c)| if *set { *c } else { '-' })
        .collect();

    format!("{}{}", file_type, perm_str)
}

#[cfg(test)]
mod tests {
    use super::{
        hidden_data_directory, remote_file_entry_from_metadata, remote_file_entry_from_stat_result,
        remote_posix_basename, staged_upload_path,
    };
    use russh_sftp::client::error::Error as SftpError;
    use russh_sftp::protocol::{Status, StatusCode};

    #[test]
    fn staged_upload_stays_beside_its_destination_directory() {
        let hidden = hidden_data_directory();
        assert_eq!(
            staged_upload_path("/workspace/目录/name.txt", "token"),
            format!("/workspace/目录/{hidden}-upload-token.tmp")
        );
        assert_eq!(
            staged_upload_path("relative/name.txt", "token"),
            format!("relative/{hidden}-upload-token.tmp")
        );
        // A workspace-root and a bare filename must not gain a parent the
        // destination never had, or the publish would move across directories.
        assert_eq!(
            staged_upload_path("/name.txt", "token"),
            format!("/{hidden}-upload-token.tmp")
        );
        assert_eq!(
            staged_upload_path("name.txt", "token"),
            format!("{hidden}-upload-token.tmp")
        );
    }

    #[test]
    fn remote_basename_never_uses_host_path_separators() {
        assert_eq!(
            remote_posix_basename("/workspace/目录/name\\with\\slashes.txt"),
            "name\\with\\slashes.txt"
        );
        assert_eq!(remote_posix_basename("/workspace/目录/"), "目录");
        assert_eq!(remote_posix_basename("/"), "/");
    }

    #[test]
    fn only_no_such_file_is_mapped_to_missing_metadata() {
        let error = |status_code| {
            anyhow::Error::new(SftpError::Status(Status {
                id: 1,
                status_code,
                error_message: String::new(),
                language_tag: String::new(),
            }))
            .context("Failed to inspect remote path")
        };

        assert!(remote_file_entry_from_stat_result(
            "/workspace/missing",
            Err(error(StatusCode::NoSuchFile))
        )
        .expect("missing path is not a transport error")
        .is_none());
        for status in [StatusCode::PermissionDenied, StatusCode::ConnectionLost] {
            let result = remote_file_entry_from_stat_result("/workspace/file", Err(error(status)))
                .expect_err("access and transport failures must remain errors");
            assert!(matches!(
                result.downcast_ref::<SftpError>(),
                Some(SftpError::Status(actual)) if actual.status_code == status
            ));
        }
        assert!(remote_file_entry_from_stat_result(
            "/workspace/file",
            Err(anyhow::anyhow!("SSH connection unavailable"))
        )
        .is_err());
    }

    #[test]
    fn sftp_special_files_are_not_reported_as_regular_files() {
        let mut attrs = russh_sftp::protocol::FileAttributes::default();
        attrs.permissions = Some(0o010644);

        let entry = remote_file_entry_from_metadata("/workspace/pipe", attrs);

        assert!(!entry.is_file);
        assert!(!entry.is_dir);
        assert!(!entry.is_symlink);
    }
}
