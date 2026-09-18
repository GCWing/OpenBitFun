use super::*;
use std::path::PathBuf;
use std::sync::Arc;
use std::time::SystemTime;
use tokio_util::sync::CancellationToken;

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SessionStoragePathRequest {
    pub workspace_path: PathBuf,
    pub remote_connection_id: Option<String>,
    pub remote_ssh_host: Option<String>,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum SessionStorageKind {
    Local,
    Remote,
    UnresolvedRemote,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SessionStoragePathResolution {
    pub requested_workspace_path: PathBuf,
    pub effective_storage_path: PathBuf,
    pub storage_kind: SessionStorageKind,
    pub remote_connection_id: Option<String>,
    pub remote_ssh_host: Option<String>,
}

impl SessionStoragePathResolution {
    pub fn new(
        requested_workspace_path: PathBuf,
        effective_storage_path: PathBuf,
        storage_kind: SessionStorageKind,
        remote_connection_id: Option<String>,
        remote_ssh_host: Option<String>,
    ) -> Self {
        Self {
            requested_workspace_path,
            effective_storage_path,
            storage_kind,
            remote_connection_id,
            remote_ssh_host,
        }
    }

    pub fn is_remote_storage(&self) -> bool {
        matches!(
            self.storage_kind,
            SessionStorageKind::Remote | SessionStorageKind::UnresolvedRemote
        )
    }
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SessionViewRestoreRequest {
    pub workspace_path: PathBuf,
    pub session_id: String,
    pub include_internal: bool,
    pub tail_turn_count: Option<usize>,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SessionTurnLoadRequest {
    pub workspace_path: PathBuf,
    pub session_id: String,
    pub tail_turn_count: Option<usize>,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SessionTurnWindowRequest {
    pub workspace_path: PathBuf,
    pub session_id: String,
    pub include_internal: bool,
    pub target_storage_turn_index: usize,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub expected_turn_id: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub expected_catalog_revision: Option<String>,
    pub before: usize,
    pub after: usize,
}

#[derive(Debug, Clone, Default, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SessionTurnLoadTiming {
    pub requested_tail_turn_count: Option<usize>,
    pub loaded_turn_count: usize,
    pub total_turn_count: usize,
    pub turn_file_count: usize,
    pub missing_turn_file_count: usize,
    pub fast_path: bool,
    pub metadata_duration_ms: u64,
    pub state_duration_ms: u64,
    pub scan_duration_ms: u64,
    pub read_duration_ms: u64,
    pub max_turn_read_duration_ms: u64,
    pub build_session_duration_ms: u64,
    pub total_duration_ms: u64,
}

#[derive(Debug, Clone, Default, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SessionViewRestoreTiming {
    pub resolve_storage_path_duration_ms: u64,
    pub visibility_metadata_duration_ms: u64,
    pub load_session_with_turns_duration_ms: u64,
    pub normalize_turn_ids_duration_ms: u64,
    #[serde(default)]
    pub turn_catalog_duration_ms: u64,
    pub total_duration_ms: u64,
    pub turn_load: SessionTurnLoadTiming,
}

#[async_trait::async_trait]
pub trait SessionStorePort: RuntimeServicePort {
    /// Resolve storage from an owning-host workspace ID. An execution path is
    /// never accepted as an identity or as an already-resolved storage directory.
    async fn resolve_workspace_storage(
        &self,
        _workspace_id: &str,
    ) -> PortResult<SessionStoragePathResolution> {
        Err(PortError::new(
            PortErrorKind::InvalidRequest,
            "Workspace ID storage lookup is not supported",
        ))
    }

    /// Legacy upgrade ingress. New product callers must use workspace IDs.
    async fn resolve_session_storage_path(
        &self,
        request: SessionStoragePathRequest,
    ) -> PortResult<SessionStoragePathResolution>;
}

/// One row from [`WorkspaceFileSystem::read_dir`] (POSIX paths when the backend is remote SSH).
#[derive(Debug, Clone)]
pub struct WorkspaceDirEntry {
    pub name: String,
    pub path: String,
    pub is_dir: bool,
    pub is_symlink: bool,
    pub modified: Option<SystemTime>,
}

/// File type for one exact path without following its final symbolic link.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum WorkspacePathKind {
    File,
    Directory,
    Symlink,
    Other,
}

/// Metadata for workspace content, independent of the controller's OS.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct WorkspaceMetadata {
    pub kind: WorkspacePathKind,
    pub size: Option<u64>,
    pub modified: Option<SystemTime>,
    /// POSIX permission bits when supplied by the provider.
    pub permissions: Option<u32>,
}

/// An opened byte stream. Providers without random access return
/// `io::ErrorKind::Unsupported` from seek, while sequential reads remain usable.
pub trait WorkspaceReadHandle: tokio::io::AsyncRead + tokio::io::AsyncSeek + Unpin + Send {}

impl<T> WorkspaceReadHandle for T where T: tokio::io::AsyncRead + tokio::io::AsyncSeek + Unpin + Send
{}

pub type WorkspaceReader = Box<dyn WorkspaceReadHandle>;

pub trait WorkspaceWriteHandle: tokio::io::AsyncWrite + Unpin + Send {}
impl<T> WorkspaceWriteHandle for T where T: tokio::io::AsyncWrite + Unpin + Send {}
pub type WorkspaceWriter = Box<dyn WorkspaceWriteHandle>;

/// Unified file system operations that work for both local and remote workspaces.
#[async_trait::async_trait]
pub trait WorkspaceFileSystem: Send + Sync {
    /// Create a new stream exclusively. Existing paths must never be truncated.
    async fn open_write_new(&self, _path: &str) -> anyhow::Result<WorkspaceWriter> {
        anyhow::bail!("streaming writes are not supported by this workspace filesystem")
    }
    /// Atomically publish a same-directory staged file, replacing a regular target.
    async fn atomic_replace(&self, _from: &str, _to: &str) -> anyhow::Result<()> {
        anyhow::bail!("atomic replacement is not supported by this workspace filesystem")
    }

    /// Open a stream without downloading the entire file before returning.
    async fn open_read(&self, _path: &str) -> anyhow::Result<WorkspaceReader> {
        anyhow::bail!("streaming reads are not supported by this workspace filesystem")
    }

    /// Missing paths return None. Permission, transport and malformed-metadata
    /// errors must remain errors. `follow_symlinks` applies to the final path.
    async fn metadata(
        &self,
        _path: &str,
        _follow_symlinks: bool,
    ) -> anyhow::Result<Option<WorkspaceMetadata>> {
        anyhow::bail!("metadata is not supported by this workspace filesystem")
    }

    /// Join path components using the syntax understood by this provider.
    ///
    /// Local providers inherit the host path syntax. Remote providers must
    /// override this when their filesystem uses a different syntax than the
    /// host process.
    fn join_path(&self, root: &str, components: &[&str]) -> String {
        let mut path = PathBuf::from(root);
        path.extend(components);
        path.to_string_lossy().into_owned()
    }

    async fn read_file(&self, path: &str) -> anyhow::Result<Vec<u8>>;
    /// Read binary content up to `max_bytes`.
    ///
    /// `Ok(None)` means the file exceeded the bound; missing paths, non-files, and transport
    /// failures remain errors. Production providers should enforce the bound before or while
    /// transferring the file.
    async fn read_file_bounded(
        &self,
        path: &str,
        max_bytes: usize,
    ) -> anyhow::Result<Option<Vec<u8>>> {
        let bytes = self.read_file(path).await?;
        Ok((bytes.len() <= max_bytes).then_some(bytes))
    }
    async fn read_file_text(&self, path: &str) -> anyhow::Result<String>;
    /// Read UTF-8 text up to `max_bytes`. Production filesystem providers
    /// should enforce the bound before or while transferring the file.
    async fn read_file_text_bounded(
        &self,
        path: &str,
        max_bytes: usize,
    ) -> anyhow::Result<Option<String>> {
        let content = self.read_file_text(path).await?;
        Ok((content.len() <= max_bytes).then_some(content))
    }
    async fn write_file(&self, path: &str, contents: &[u8]) -> anyhow::Result<()>;
    async fn remove_file(&self, _path: &str) -> anyhow::Result<()> {
        anyhow::bail!("file removal is not supported by this workspace filesystem")
    }
    async fn remove_dir(&self, _path: &str, _recursive: bool) -> anyhow::Result<()> {
        anyhow::bail!("directory removal is not supported by this workspace filesystem")
    }
    async fn create_dir_all(&self, _path: &str) -> anyhow::Result<()> {
        anyhow::bail!("directory creation is not supported by this workspace filesystem")
    }
    async fn set_permissions(&self, _path: &str, _permissions: u32) -> anyhow::Result<()> {
        anyhow::bail!("POSIX permissions are not supported by this workspace filesystem")
    }
    async fn set_modified(&self, _path: &str, _modified: SystemTime) -> anyhow::Result<()> {
        anyhow::bail!("modification times are not supported by this workspace filesystem")
    }
    /// Move a path using provider-native rename semantics. This is not a
    /// compare-and-swap or a guarantee of cross-filesystem atomicity.
    async fn rename(&self, _from: &str, _to: &str) -> anyhow::Result<()> {
        anyhow::bail!("rename is not supported by this workspace filesystem")
    }
    async fn exists(&self, path: &str) -> anyhow::Result<bool>;
    async fn is_file(&self, path: &str) -> anyhow::Result<bool>;
    async fn is_dir(&self, path: &str) -> anyhow::Result<bool>;
    /// Inspect one exact path without following its final symbolic link.
    /// Providers that cannot guarantee no-follow semantics must return an
    /// error instead of falling back to link-following metadata.
    async fn path_kind_no_follow(&self, _path: &str) -> anyhow::Result<Option<WorkspacePathKind>> {
        Err(anyhow::anyhow!(
            "exact no-follow path metadata is not supported by this workspace filesystem"
        ))
    }
    /// List immediate children (non-recursive). Symlinks may be included; callers often skip them.
    async fn read_dir(&self, path: &str) -> anyhow::Result<Vec<WorkspaceDirEntry>>;
    /// List at most `max_entries` immediate children. Production providers
    /// should stop local iteration or remote directory-batch requests once the
    /// bound is met.
    async fn read_dir_bounded(
        &self,
        path: &str,
        max_entries: usize,
    ) -> anyhow::Result<Vec<WorkspaceDirEntry>> {
        let mut entries = self.read_dir(path).await?;
        entries.truncate(max_entries);
        Ok(entries)
    }
}

/// Unified shell execution options for local and remote workspaces.
#[derive(Clone, Default)]
pub struct WorkspaceCommandOptions {
    pub timeout_ms: Option<u64>,
    pub cancellation_token: Option<CancellationToken>,
}

impl std::fmt::Debug for WorkspaceCommandOptions {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.debug_struct("WorkspaceCommandOptions")
            .field("timeout_ms", &self.timeout_ms)
            .field(
                "cancellation_token",
                &self
                    .cancellation_token
                    .as_ref()
                    .map(|_| "<CancellationToken>"),
            )
            .finish()
    }
}

#[derive(Debug, Clone)]
pub struct WorkspaceCommandResult {
    pub stdout: String,
    pub stderr: String,
    pub exit_code: i32,
    pub interrupted: bool,
    pub timed_out: bool,
}

impl WorkspaceCommandResult {
    pub fn combined_output(&self) -> String {
        if self.stderr.is_empty() {
            self.stdout.clone()
        } else if self.stdout.is_empty() {
            self.stderr.clone()
        } else {
            format!("{}\n{}", self.stdout, self.stderr)
        }
    }
}

/// Unified shell execution for both local and remote workspaces.
#[async_trait::async_trait]
pub trait WorkspaceShell: Send + Sync {
    /// Execute a command and return a structured result.
    async fn exec_with_options(
        &self,
        command: &str,
        options: WorkspaceCommandOptions,
    ) -> anyhow::Result<WorkspaceCommandResult>;

    /// Execute a command and return (stdout, stderr, exit_code).
    async fn exec(
        &self,
        command: &str,
        timeout_ms: Option<u64>,
    ) -> anyhow::Result<(String, String, i32)> {
        let result = self
            .exec_with_options(
                command,
                WorkspaceCommandOptions {
                    timeout_ms,
                    ..Default::default()
                },
            )
            .await?;

        if result.timed_out {
            anyhow::bail!(
                "Command timed out after {}ms",
                timeout_ms.unwrap_or_default()
            );
        }
        if result.interrupted {
            anyhow::bail!("Command was cancelled");
        }

        Ok((result.stdout, result.stderr, result.exit_code))
    }
}

/// Bundle of workspace I/O services injected into tool runtime context.
pub struct WorkspaceServices {
    pub fs: Arc<dyn WorkspaceFileSystem>,
    pub shell: Arc<dyn WorkspaceShell>,
}

impl Clone for WorkspaceServices {
    fn clone(&self) -> Self {
        Self {
            fs: Arc::clone(&self.fs),
            shell: Arc::clone(&self.shell),
        }
    }
}

impl std::fmt::Debug for WorkspaceServices {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.debug_struct("WorkspaceServices")
            .field("fs", &"<dyn WorkspaceFileSystem>")
            .field("shell", &"<dyn WorkspaceShell>")
            .finish()
    }
}

#[cfg(test)]
pub(crate) mod tests {
    use super::*;

    #[derive(Debug)]
    struct FakeWorkspaceFileSystem;

    #[async_trait::async_trait]
    impl WorkspaceFileSystem for FakeWorkspaceFileSystem {
        async fn read_file(&self, _path: &str) -> anyhow::Result<Vec<u8>> {
            Ok(b"hello".to_vec())
        }

        async fn read_file_text(&self, _path: &str) -> anyhow::Result<String> {
            Ok("hello".to_string())
        }

        async fn write_file(&self, _path: &str, _contents: &[u8]) -> anyhow::Result<()> {
            Ok(())
        }

        async fn exists(&self, _path: &str) -> anyhow::Result<bool> {
            Ok(true)
        }

        async fn is_file(&self, _path: &str) -> anyhow::Result<bool> {
            Ok(true)
        }

        async fn is_dir(&self, _path: &str) -> anyhow::Result<bool> {
            Ok(false)
        }

        async fn read_dir(&self, _path: &str) -> anyhow::Result<Vec<WorkspaceDirEntry>> {
            Ok(vec![WorkspaceDirEntry {
                name: "file.txt".to_string(),
                path: "/workspace/file.txt".to_string(),
                is_dir: false,
                is_symlink: false,
                modified: None,
            }])
        }
    }

    #[derive(Debug)]
    struct FakeWorkspaceShell;

    #[async_trait::async_trait]
    impl WorkspaceShell for FakeWorkspaceShell {
        async fn exec_with_options(
            &self,
            _command: &str,
            options: WorkspaceCommandOptions,
        ) -> anyhow::Result<WorkspaceCommandResult> {
            assert_eq!(options.timeout_ms, Some(100));
            assert!(options.cancellation_token.is_none());
            Ok(WorkspaceCommandResult {
                stdout: "ok".to_string(),
                stderr: String::new(),
                exit_code: 0,
                interrupted: false,
                timed_out: false,
            })
        }
    }

    pub(crate) fn fake_workspace_services() -> WorkspaceServices {
        WorkspaceServices {
            fs: Arc::new(FakeWorkspaceFileSystem),
            shell: Arc::new(FakeWorkspaceShell),
        }
    }

    #[test]
    fn workspace_services_contract_is_runtime_port_owned() {
        let services = fake_workspace_services();

        let cloned = services.clone();
        assert!(Arc::ptr_eq(&services.fs, &cloned.fs));
        assert!(Arc::ptr_eq(&services.shell, &cloned.shell));
        assert_eq!(
            format!("{:?}", services),
            "WorkspaceServices { fs: \"<dyn WorkspaceFileSystem>\", shell: \"<dyn WorkspaceShell>\" }"
        );
    }
}
