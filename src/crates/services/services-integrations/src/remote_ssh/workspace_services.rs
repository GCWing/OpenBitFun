//! SSH-backed workspace runtime services.
//!
//! This module adapts the remote SSH file and command services to the
//! workspace runtime ports. Product crates select when these providers are
//! used; this crate owns the concrete SSH-backed implementation.

use async_trait::async_trait;
use openbitfun_runtime_ports::{
    WorkspaceCommandOptions, WorkspaceCommandResult, WorkspaceDirEntry, WorkspaceFileSystem,
    WorkspacePathKind, WorkspaceServices, WorkspaceShell,
};
use std::collections::BTreeMap;
use std::sync::Arc;
#[cfg(feature = "remote-ssh-concrete")]
use std::time::SystemTime;
use std::time::{Duration, UNIX_EPOCH};
#[cfg(feature = "remote-ssh-concrete")]
use tokio::io::{AsyncReadExt, AsyncWriteExt};

use super::{
    RemoteFileEntry, RemoteFileService, SSHCommandOptions, SSHCommandResult, SSHConnectionManager,
};
use crate::remote_ssh::shell;

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
enum BoundedReadPreflight {
    Transfer,
    TooLarge,
}

fn bounded_read_preflight(
    path: &str,
    entry: Option<&RemoteFileEntry>,
    max_bytes: usize,
) -> anyhow::Result<BoundedReadPreflight> {
    let Some(entry) = entry else {
        // Let the actual transfer report a precise missing-file or transport error.
        return Ok(BoundedReadPreflight::Transfer);
    };
    if entry.is_symlink {
        // SFTP stat follows the final symlink while container metadata does not. The transfer
        // follows it in both backends, and the progress callback still enforces the byte limit.
        return Ok(BoundedReadPreflight::Transfer);
    }
    if !entry.is_file {
        anyhow::bail!("Remote path is not a file: {path}");
    }
    if entry.size.is_some_and(|size| size > max_bytes as u64) {
        return Ok(BoundedReadPreflight::TooLarge);
    }
    Ok(BoundedReadPreflight::Transfer)
}

/// SSH-backed filesystem implementation of [`WorkspaceFileSystem`].
pub struct RemoteWorkspaceFs {
    connection_id: String,
    file_service: RemoteFileService,
}

impl RemoteWorkspaceFs {
    pub fn new(connection_id: String, file_service: RemoteFileService) -> Self {
        Self {
            connection_id,
            file_service,
        }
    }

    async fn transfer_file_bounded(
        &self,
        path: &str,
        max_bytes: usize,
    ) -> anyhow::Result<Option<Vec<u8>>> {
        let mut exceeded = false;
        let bytes = match self
            .file_service
            .read_file_with_progress(&self.connection_id, path, &mut |bytes_read, total_size| {
                let over_limit = bytes_read > max_bytes as u64 || total_size > max_bytes as u64;
                exceeded |= over_limit;
                !over_limit
            })
            .await
        {
            Ok(bytes) => bytes,
            Err(_) if exceeded => return Ok(None),
            Err(error) => return Err(error),
        };
        Ok((bytes.len() <= max_bytes).then_some(bytes))
    }
}

fn join_posix_path(root: &str, components: &[&str]) -> String {
    let mut path = root.trim_end_matches('/').to_string();
    if path.is_empty() && root.starts_with('/') {
        path.push('/');
    }
    for component in components {
        if !path.is_empty() && !path.ends_with('/') {
            path.push('/');
        }
        path.push_str(component.trim_matches('/'));
    }
    path
}

#[async_trait]
impl WorkspaceFileSystem for RemoteWorkspaceFs {
    #[cfg(feature = "remote-ssh-concrete")]
    async fn open_write_new(
        &self,
        path: &str,
    ) -> anyhow::Result<openbitfun_runtime_ports::WorkspaceWriter> {
        self.file_service
            .open_write_new(&self.connection_id, path)
            .await
    }
    #[cfg(feature = "remote-ssh-concrete")]
    async fn atomic_replace(&self, from: &str, to: &str) -> anyhow::Result<()> {
        self.file_service
            .atomic_replace(&self.connection_id, from, to)
            .await
    }

    #[cfg(feature = "remote-ssh-concrete")]
    async fn open_read(
        &self,
        path: &str,
    ) -> anyhow::Result<openbitfun_runtime_ports::WorkspaceReader> {
        self.file_service.open_read(&self.connection_id, path).await
    }

    #[cfg(feature = "remote-ssh-concrete")]
    async fn metadata(
        &self,
        path: &str,
        follow_symlinks: bool,
    ) -> anyhow::Result<Option<openbitfun_runtime_ports::WorkspaceMetadata>> {
        self.file_service
            .workspace_metadata(&self.connection_id, path, follow_symlinks)
            .await
    }

    fn join_path(&self, root: &str, components: &[&str]) -> String {
        join_posix_path(root, components)
    }

    async fn read_file(&self, path: &str) -> anyhow::Result<Vec<u8>> {
        self.file_service.read_file(&self.connection_id, path).await
    }

    async fn read_file_bounded(
        &self,
        path: &str,
        max_bytes: usize,
    ) -> anyhow::Result<Option<Vec<u8>>> {
        let entry = self.file_service.stat(&self.connection_id, path).await?;
        if bounded_read_preflight(path, entry.as_ref(), max_bytes)?
            == BoundedReadPreflight::TooLarge
        {
            return Ok(None);
        }
        self.transfer_file_bounded(path, max_bytes).await
    }

    async fn read_file_text(&self, path: &str) -> anyhow::Result<String> {
        let bytes = self.read_file(path).await?;
        Ok(String::from_utf8(bytes)?)
    }

    async fn read_file_text_bounded(
        &self,
        path: &str,
        max_bytes: usize,
    ) -> anyhow::Result<Option<String>> {
        let Some(entry) = self
            .file_service
            .symlink_stat(&self.connection_id, path)
            .await?
        else {
            return Ok(None);
        };
        if !entry.is_file || entry.size.is_some_and(|size| size > max_bytes as u64) {
            return Ok(None);
        }
        Ok(self
            .transfer_file_bounded(path, max_bytes)
            .await?
            .map(|bytes| String::from_utf8_lossy(&bytes).to_string()))
    }

    async fn write_file(&self, path: &str, contents: &[u8]) -> anyhow::Result<()> {
        if let Some((parent, _)) = path
            .rsplit_once('/')
            .filter(|(parent, _)| !parent.is_empty())
        {
            self.file_service
                .create_dir_all(&self.connection_id, parent)
                .await?;
        }
        #[cfg(feature = "remote-ssh-concrete")]
        {
            self.file_service
                .write_workspace_file(&self.connection_id, path, contents)
                .await
        }
        #[cfg(not(feature = "remote-ssh-concrete"))]
        {
            self.file_service
                .write_file(&self.connection_id, path, contents)
                .await
        }
    }

    async fn remove_file(&self, path: &str) -> anyhow::Result<()> {
        self.file_service
            .remove_file(&self.connection_id, path)
            .await
    }

    async fn remove_dir(&self, path: &str, recursive: bool) -> anyhow::Result<()> {
        if recursive {
            self.file_service
                .remove_dir_all(&self.connection_id, path)
                .await
        } else {
            self.file_service
                .remove_dir(&self.connection_id, path)
                .await
        }
    }

    async fn create_dir_all(&self, path: &str) -> anyhow::Result<()> {
        self.file_service
            .create_dir_all(&self.connection_id, path)
            .await
    }

    #[cfg(feature = "remote-ssh-concrete")]
    async fn set_permissions(&self, path: &str, permissions: u32) -> anyhow::Result<()> {
        self.file_service
            .set_permissions(&self.connection_id, path, permissions)
            .await
    }

    #[cfg(feature = "remote-ssh-concrete")]
    async fn set_modified(&self, path: &str, modified: SystemTime) -> anyhow::Result<()> {
        self.file_service
            .set_modified(&self.connection_id, path, modified)
            .await
    }

    async fn rename(&self, from: &str, to: &str) -> anyhow::Result<()> {
        self.file_service
            .rename(&self.connection_id, from, to)
            .await
    }

    async fn exists(&self, path: &str) -> anyhow::Result<bool> {
        Ok(self.metadata(path, true).await?.is_some())
    }

    async fn is_file(&self, path: &str) -> anyhow::Result<bool> {
        Ok(self
            .metadata(path, true)
            .await?
            .is_some_and(|metadata| metadata.kind == WorkspacePathKind::File))
    }

    async fn is_dir(&self, path: &str) -> anyhow::Result<bool> {
        Ok(self
            .metadata(path, true)
            .await?
            .is_some_and(|metadata| metadata.kind == WorkspacePathKind::Directory))
    }

    async fn path_kind_no_follow(&self, path: &str) -> anyhow::Result<Option<WorkspacePathKind>> {
        Ok(self
            .metadata(path, false)
            .await?
            .map(|metadata| metadata.kind))
    }

    async fn read_dir(&self, path: &str) -> anyhow::Result<Vec<WorkspaceDirEntry>> {
        let entries = self
            .file_service
            .read_dir(&self.connection_id, path)
            .await?;
        Ok(entries
            .into_iter()
            .map(|entry| WorkspaceDirEntry {
                name: entry.name,
                path: entry.path,
                is_dir: entry.is_dir,
                is_symlink: entry.is_symlink,
                modified: entry.modified.and_then(|milliseconds| {
                    UNIX_EPOCH.checked_add(Duration::from_millis(milliseconds))
                }),
            })
            .collect())
    }

    async fn read_dir_bounded(
        &self,
        path: &str,
        max_entries: usize,
    ) -> anyhow::Result<Vec<WorkspaceDirEntry>> {
        let entries = self
            .file_service
            .read_dir_bounded(&self.connection_id, path, max_entries)
            .await?;
        Ok(entries
            .into_iter()
            .map(|entry| WorkspaceDirEntry {
                name: entry.name,
                path: entry.path,
                is_dir: entry.is_dir,
                is_symlink: entry.is_symlink,
                modified: entry.modified.and_then(|milliseconds| {
                    UNIX_EPOCH.checked_add(Duration::from_millis(milliseconds))
                }),
            })
            .collect())
    }
}

#[cfg(test)]
mod bounded_read_tests {
    use super::*;

    fn entry(is_file: bool, is_symlink: bool, size: Option<u64>) -> RemoteFileEntry {
        RemoteFileEntry {
            name: "document.docx".to_string(),
            path: "/workspace/document.docx".to_string(),
            is_dir: !is_file && !is_symlink,
            is_file,
            is_symlink,
            size,
            modified: None,
            permissions: None,
        }
    }

    #[test]
    fn remote_workspace_paths_keep_posix_syntax_for_absolute_home_and_relative_roots() {
        for (root, expected) in [
            ("/", "/.openbitfun/report.md"),
            ("~", "~/.openbitfun/report.md"),
            ("~/repo", "~/repo/.openbitfun/report.md"),
            ("repo", "repo/.openbitfun/report.md"),
            (".", "./.openbitfun/report.md"),
        ] {
            assert_eq!(
                join_posix_path(root, &[".openbitfun", "report.md"]),
                expected
            );
        }
    }

    #[test]
    fn bounded_binary_preflight_preserves_errors_and_follows_document_symlinks() {
        assert_eq!(
            bounded_read_preflight("missing.docx", None, 64).unwrap(),
            BoundedReadPreflight::Transfer
        );
        assert_eq!(
            bounded_read_preflight("linked.docx", Some(&entry(false, true, Some(4))), 64).unwrap(),
            BoundedReadPreflight::Transfer
        );
        assert_eq!(
            bounded_read_preflight("large.docx", Some(&entry(true, false, Some(65))), 64).unwrap(),
            BoundedReadPreflight::TooLarge
        );
        assert!(
            bounded_read_preflight("folder.docx", Some(&entry(false, false, None)), 64).is_err()
        );
    }
}

/// SSH-backed shell implementation of [`WorkspaceShell`].
pub struct RemoteWorkspaceShell {
    ssh_manager: SSHConnectionManager,
    connection_id: String,
    workspace_root: String,
}

impl RemoteWorkspaceShell {
    pub fn new(
        connection_id: String,
        ssh_manager: SSHConnectionManager,
        workspace_root: String,
    ) -> Self {
        Self {
            connection_id,
            ssh_manager,
            workspace_root,
        }
    }
}

#[async_trait]
impl WorkspaceShell for RemoteWorkspaceShell {
    async fn exec_with_options(
        &self,
        command: &str,
        options: WorkspaceCommandOptions,
    ) -> anyhow::Result<WorkspaceCommandResult> {
        let wrapped = remote_workspace_command(&self.workspace_root, command);
        let result = self
            .ssh_manager
            .execute_command_with_options(
                &self.connection_id,
                &wrapped,
                SSHCommandOptions {
                    timeout_ms: options.timeout_ms,
                    cancellation_token: options.cancellation_token,
                },
            )
            .await?;

        Ok(workspace_result_from_ssh(result))
    }

    async fn exec_with_stdin(
        &self,
        command: &str,
        stdin_payload: &[u8],
        environment: &BTreeMap<String, String>,
        options: WorkspaceCommandOptions,
    ) -> anyhow::Result<WorkspaceCommandResult> {
        #[cfg(not(feature = "remote-ssh-concrete"))]
        {
            let _ = (command, stdin_payload, environment, options);
            anyhow::bail!("remote workspace stdin execution is unavailable without SSH support")
        }
        #[cfg(feature = "remote-ssh-concrete")]
        {
            let command = remote_workspace_command(
                &self.workspace_root,
                &remote_hook_command(command, environment),
            );
            let stdio = if let Some(timeout_ms) = options.timeout_ms {
                match tokio::time::timeout(
                    Duration::from_millis(timeout_ms),
                    self.ssh_manager
                        .open_workspace_stdio(&self.connection_id, &command),
                )
                .await
                {
                    Ok(result) => result?,
                    Err(_) => {
                        return Ok(WorkspaceCommandResult {
                            stdout: String::new(),
                            stderr: String::new(),
                            exit_code: 124,
                            interrupted: false,
                            timed_out: true,
                        });
                    }
                }
            } else {
                self.ssh_manager
                    .open_workspace_stdio(&self.connection_id, &command)
                    .await?
            };
            let (mut stdin, mut stdout, mut stderr, control, completion) = stdio.into_parts();
            let payload = stdin_payload.to_vec();
            let interaction = async move {
                stdin.write_all(&payload).await?;
                stdin.shutdown().await?;
                let (stdout, stderr, completion) = tokio::join!(
                    async {
                        let mut bytes = Vec::new();
                        stdout.read_to_end(&mut bytes).await.map(|_| bytes)
                    },
                    async {
                        let mut bytes = Vec::new();
                        stderr.read_to_end(&mut bytes).await.map(|_| bytes)
                    },
                    completion.wait(),
                );
                Ok::<_, anyhow::Error>((stdout?, stderr?, completion.exit_code))
            };
            let result = if let Some(timeout_ms) = options.timeout_ms {
                match tokio::time::timeout(Duration::from_millis(timeout_ms), interaction).await {
                    Ok(result) => result?,
                    Err(_) => {
                        let _ = control.kill().await;
                        return Ok(WorkspaceCommandResult {
                            stdout: String::new(),
                            stderr: String::new(),
                            exit_code: 124,
                            interrupted: false,
                            timed_out: true,
                        });
                    }
                }
            } else {
                interaction.await?
            };
            Ok(WorkspaceCommandResult {
                stdout: bounded_hook_output(result.0),
                stderr: bounded_hook_output(result.1),
                exit_code: result.2.unwrap_or(-1),
                interrupted: false,
                timed_out: false,
            })
        }
    }
}

/// Build [`WorkspaceServices`] backed by SSH for a remote workspace.
pub fn remote_workspace_services(
    connection_id: String,
    file_service: RemoteFileService,
    ssh_manager: SSHConnectionManager,
    workspace_root: String,
) -> WorkspaceServices {
    WorkspaceServices {
        fs: Arc::new(RemoteWorkspaceFs::new(connection_id.clone(), file_service)),
        shell: Arc::new(RemoteWorkspaceShell::new(
            connection_id,
            ssh_manager,
            workspace_root,
        )),
    }
}

fn remote_workspace_command(workspace_root: &str, command: &str) -> String {
    shell::cd_and(workspace_root, command)
}

#[cfg(feature = "remote-ssh-concrete")]
fn remote_hook_command(command: &str, environment: &BTreeMap<String, String>) -> String {
    if environment.is_empty() {
        return command.to_string();
    }
    let mut prefix = String::new();
    for (key, value) in environment {
        if key.is_empty()
            || !key.chars().enumerate().all(|(index, ch)| {
                ch == '_' || ch.is_ascii_alphanumeric() && (index > 0 || ch.is_ascii_alphabetic())
            })
        {
            continue;
        }
        prefix.push_str("export ");
        prefix.push_str(key);
        prefix.push('=');
        prefix.push_str(&shell::quote_arg(value));
        prefix.push_str("; ");
    }
    format!("{prefix}{command}")
}

#[cfg(feature = "remote-ssh-concrete")]
fn bounded_hook_output(bytes: Vec<u8>) -> String {
    const MAX_CAPTURED_OUTPUT_BYTES: usize = 1024 * 1024;
    let bytes = if bytes.len() > MAX_CAPTURED_OUTPUT_BYTES {
        &bytes[..MAX_CAPTURED_OUTPUT_BYTES]
    } else {
        &bytes
    };
    String::from_utf8_lossy(bytes).into_owned()
}

fn workspace_result_from_ssh(result: SSHCommandResult) -> WorkspaceCommandResult {
    WorkspaceCommandResult {
        stdout: result.stdout,
        stderr: result.stderr,
        exit_code: result.exit_code,
        interrupted: result.interrupted,
        timed_out: result.timed_out,
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn remote_workspace_command_preserves_legacy_cd_wrapping_and_escaping() {
        assert_eq!(
            remote_workspace_command("/tmp/has space/it's", "pwd"),
            "cd '/tmp/has space/it'\\''s' && pwd"
        );
    }

    #[test]
    fn workspace_result_from_ssh_preserves_structured_status() {
        let result = workspace_result_from_ssh(SSHCommandResult {
            stdout: "out".to_string(),
            stderr: "err".to_string(),
            exit_code: 124,
            interrupted: false,
            timed_out: true,
        });

        assert_eq!(result.stdout, "out");
        assert_eq!(result.stderr, "err");
        assert_eq!(result.exit_code, 124);
        assert!(!result.interrupted);
        assert!(result.timed_out);
    }
}
