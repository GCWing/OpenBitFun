//! Disabled Remote SSH runtime stubs for lightweight feature builds.
//!
//! The shared workspace identity and wire types remain available without the
//! `ssh-remote` feature. Concrete SSH, SFTP, PTY, and port-forward operations
//! stay behind `ssh-remote` and return explicit unsupported errors here.

use crate::remote_ssh::types::{
    PortForward, PortForwardRequest, RemoteDirEntry, RemoteFileEntry, RemoteListeningPort,
    RemoteTreeNode, SSHCommandOptions, SSHCommandResult, SSHConfigEntry, SSHConfigLookupResult,
    SSHConnectionConfig, SSHConnectionResult, SavedConnection, ServerInfo,
};
use std::path::PathBuf;
use std::sync::{Arc, OnceLock};
use terminal_core::SessionSource;

fn unsupported() -> anyhow::Error {
    anyhow::anyhow!("Remote SSH support is disabled; enable the `ssh-remote` feature")
}

/// Disabled mirror of the concrete SSH dispatch transport.
///
/// Keeping the DTOs and function signatures available lets lightweight builds
/// compile shared command adapters while every runtime operation still fails
/// explicitly.
pub mod dispatch_ssh {
    use super::{unsupported, SSHConnectionManager};
    use serde::{Deserialize, Serialize};
    use serde_json::Value;

    #[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
    #[serde(rename_all = "camelCase")]
    pub struct DispatchCliRelease {
        pub version: String,
        pub target: String,
        pub url: String,
        pub sha256: String,
    }

    #[derive(Debug, Clone, Serialize, Deserialize)]
    #[serde(rename_all = "camelCase")]
    pub struct DispatchSshProbe {
        pub cli_installed: bool,
        pub cli_path: Option<String>,
        pub os: String,
        pub arch: String,
        pub install_supported: bool,
        pub install_error: Option<String>,
        pub protocol_error: Option<String>,
        pub release: Option<DispatchCliRelease>,
        pub protocol: Option<Value>,
    }

    #[derive(Debug, Clone, Serialize, Deserialize)]
    #[serde(rename_all = "camelCase")]
    pub struct DispatchInstallStart {
        pub script_path: String,
        pub version: String,
        pub target: String,
        pub url: String,
        pub sha256: String,
    }

    #[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
    #[serde(rename_all = "snake_case")]
    pub enum DispatchInstallStatus {
        Running,
        Succeeded,
        Failed,
    }

    #[derive(Debug, Clone, Serialize, Deserialize)]
    #[serde(rename_all = "camelCase")]
    pub struct DispatchInstallPoll {
        pub cursor: u64,
        pub output: String,
        pub status: DispatchInstallStatus,
    }

    pub async fn probe(
        _manager: &SSHConnectionManager,
        _connection_id: &str,
        _workspace_path: Option<&str>,
    ) -> anyhow::Result<DispatchSshProbe> {
        Err(unsupported())
    }

    pub async fn install_cli_start(
        _manager: &SSHConnectionManager,
        _connection_id: &str,
        _expected_release: &DispatchCliRelease,
    ) -> anyhow::Result<DispatchInstallStart> {
        Err(unsupported())
    }

    pub async fn install_cli_poll(
        _manager: &SSHConnectionManager,
        _connection_id: &str,
        _cursor: u64,
    ) -> anyhow::Result<DispatchInstallPoll> {
        Err(unsupported())
    }

    pub async fn install_cli_cancel(
        _manager: &SSHConnectionManager,
        _connection_id: &str,
    ) -> anyhow::Result<()> {
        Err(unsupported())
    }

    pub async fn submit(
        _manager: &SSHConnectionManager,
        _connection_id: &str,
        _request: &Value,
    ) -> anyhow::Result<Value> {
        Err(unsupported())
    }

    pub async fn status(
        _manager: &SSHConnectionManager,
        _connection_id: &str,
        _request: &Value,
    ) -> anyhow::Result<Value> {
        Err(unsupported())
    }

    pub async fn cancel(
        _manager: &SSHConnectionManager,
        _connection_id: &str,
        _request: &Value,
    ) -> anyhow::Result<Value> {
        Err(unsupported())
    }

    pub async fn list(
        _manager: &SSHConnectionManager,
        _connection_id: &str,
        _request: &Value,
    ) -> anyhow::Result<Value> {
        Err(unsupported())
    }
}

static GLOBAL_REMOTE_EXEC_MANAGER: OnceLock<Arc<RemoteExecProcessManager>> = OnceLock::new();

pub fn get_global_remote_exec_process_manager() -> Arc<RemoteExecProcessManager> {
    GLOBAL_REMOTE_EXEC_MANAGER
        .get_or_init(|| Arc::new(RemoteExecProcessManager))
        .clone()
}

#[derive(Debug, Clone)]
pub struct RemoteExecCommandRequest {
    pub ssh_manager: SSHConnectionManager,
    pub connection_id: String,
    pub command: String,
    pub tty: bool,
    pub yield_time_ms: Option<u64>,
    pub max_output_chars: Option<usize>,
    pub lifecycle_tx: Option<tokio::sync::mpsc::UnboundedSender<RemoteExecProcessLifecycleEvent>>,
    pub output_capture_tx: Option<tokio::sync::mpsc::UnboundedSender<String>>,
}

#[derive(Debug, Clone)]
pub struct RemoteWriteStdinRequest {
    pub session_id: i32,
    pub chars: String,
    pub append_enter: bool,
    pub yield_time_ms: Option<u64>,
    pub max_output_chars: Option<usize>,
}

#[derive(Debug, Clone)]
pub struct RemoteSendStdinRequest {
    pub session_id: i32,
    pub chars: String,
    pub append_enter: bool,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum RemoteExecControlAction {
    Interrupt,
    Kill,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum RemoteExecControlOrigin {
    ModelTool,
    OutOfBand,
}

#[derive(Debug, Clone)]
pub struct RemoteExecControlRequest {
    pub session_id: i32,
    pub action: RemoteExecControlAction,
    pub origin: RemoteExecControlOrigin,
    pub yield_time_ms: Option<u64>,
    pub max_output_chars: Option<usize>,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum RemoteExecSessionCompletionStatus {
    Exited,
    Interrupted,
    Killed,
    Pruned,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum RemoteExecSessionCompletionSource {
    Process,
    OutOfBandControl,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct RemoteExecSessionCompletion {
    pub status: RemoteExecSessionCompletionStatus,
    pub source: RemoteExecSessionCompletionSource,
}

#[derive(Debug, Clone)]
pub struct RemoteExecCommandResponse {
    pub chunk_id: String,
    pub wall_time_seconds: f64,
    pub output: String,
    pub session_id: Option<i32>,
    pub exit_code: Option<i32>,
    pub original_output_chars: usize,
    pub completion: Option<RemoteExecSessionCompletion>,
}

pub type RemoteExecResult<T> = std::result::Result<T, RemoteExecError>;

#[derive(Debug, thiserror::Error)]
pub enum RemoteExecError {
    #[error("session not found: {0}")]
    SessionNotFound(i32),

    #[error(transparent)]
    Other(#[from] anyhow::Error),
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum RemoteExecProcessLifecycleStatus {
    Running,
    Exited,
    Interrupted,
    Killed,
    Pruned,
}

#[derive(Debug, Clone)]
pub struct RemoteExecProcessLifecycleEvent {
    pub session_id: i32,
    pub status: RemoteExecProcessLifecycleStatus,
    pub exit_code: Option<i32>,
}

pub struct RemoteExecProcessManager;

impl RemoteExecProcessManager {
    pub async fn is_session_active(&self, _session_id: i32) -> bool {
        false
    }

    pub async fn exec_command(
        &self,
        _request: RemoteExecCommandRequest,
    ) -> RemoteExecResult<RemoteExecCommandResponse> {
        Err(unsupported().into())
    }

    pub async fn exec_command_streaming(
        &self,
        _request: RemoteExecCommandRequest,
        _output_tx: tokio::sync::mpsc::Sender<String>,
    ) -> RemoteExecResult<RemoteExecCommandResponse> {
        Err(unsupported().into())
    }

    pub async fn write_stdin(
        &self,
        _request: RemoteWriteStdinRequest,
    ) -> RemoteExecResult<RemoteExecCommandResponse> {
        Err(unsupported().into())
    }

    pub async fn write_stdin_streaming(
        &self,
        _request: RemoteWriteStdinRequest,
        _output_tx: tokio::sync::mpsc::Sender<String>,
    ) -> RemoteExecResult<RemoteExecCommandResponse> {
        Err(unsupported().into())
    }

    pub async fn send_stdin(&self, _request: RemoteSendStdinRequest) -> RemoteExecResult<()> {
        Err(unsupported().into())
    }

    pub async fn control_session(
        &self,
        _request: RemoteExecControlRequest,
    ) -> RemoteExecResult<RemoteExecCommandResponse> {
        Err(unsupported().into())
    }
}

#[derive(Debug, Clone, serde::Serialize, serde::Deserialize)]
pub struct KnownHostEntry {
    pub host: String,
    pub port: u16,
    pub key_type: String,
    pub fingerprint: String,
    pub public_key: String,
}

#[derive(Debug, Clone)]
pub struct SSHConnectionManager {
    data_dir: PathBuf,
}

impl SSHConnectionManager {
    pub fn new(data_dir: PathBuf) -> Self {
        Self { data_dir }
    }

    pub async fn load_known_hosts(&self) -> anyhow::Result<()> {
        Err(unsupported())
    }

    pub async fn add_known_host(
        &self,
        _host: String,
        _port: u16,
        _key_type: String,
        _fingerprint: String,
        _public_key: String,
    ) -> anyhow::Result<()> {
        Err(unsupported())
    }

    pub async fn is_known_host(&self, _host: &str, _port: u16) -> bool {
        false
    }

    pub async fn get_known_host(&self, _host: &str, _port: u16) -> Option<KnownHostEntry> {
        None
    }

    pub async fn remove_known_host(&self, _host: &str, _port: u16) -> anyhow::Result<()> {
        Err(unsupported())
    }

    pub async fn list_known_hosts(&self) -> Vec<KnownHostEntry> {
        Vec::new()
    }

    pub async fn load_remote_workspace(&self) -> anyhow::Result<()> {
        Ok(())
    }

    pub async fn set_remote_workspace(
        &self,
        _workspace: crate::remote_ssh::types::RemoteWorkspace,
    ) -> anyhow::Result<()> {
        Err(unsupported())
    }

    pub async fn get_remote_workspaces(&self) -> Vec<crate::remote_ssh::types::RemoteWorkspace> {
        Vec::new()
    }

    pub async fn prune_remote_workspaces_without_saved_connections(
        &self,
    ) -> anyhow::Result<Vec<String>> {
        Ok(Vec::new())
    }

    pub async fn get_remote_workspace(
        &self,
        _connection_id: &str,
    ) -> Option<crate::remote_ssh::types::RemoteWorkspace> {
        None
    }

    pub async fn remove_remote_workspace(&self, _connection_id: &str) -> anyhow::Result<()> {
        Err(unsupported())
    }

    pub async fn clear_remote_workspace(&self) -> anyhow::Result<()> {
        Err(unsupported())
    }

    pub async fn get_ssh_config(&self, _host: &str) -> SSHConfigLookupResult {
        SSHConfigLookupResult {
            found: false,
            config: None,
        }
    }

    pub async fn list_ssh_config_hosts(&self) -> Vec<SSHConfigEntry> {
        Vec::new()
    }

    pub async fn load_saved_connections(&self) -> anyhow::Result<()> {
        Ok(())
    }

    pub async fn get_saved_connections(&self) -> Vec<SavedConnection> {
        Vec::new()
    }

    pub async fn prune_saved_connections_without_credentials(&self) -> anyhow::Result<Vec<String>> {
        Ok(Vec::new())
    }

    pub async fn get_saved_host_for_connection_id(&self, _connection_id: &str) -> Option<String> {
        None
    }

    pub async fn save_connection(&self, _config: &SSHConnectionConfig) -> anyhow::Result<()> {
        Err(unsupported())
    }

    pub async fn load_stored_password(
        &self,
        _connection_id: &str,
    ) -> anyhow::Result<Option<String>> {
        Err(unsupported())
    }

    pub async fn has_stored_password(&self, _connection_id: &str) -> bool {
        false
    }

    pub async fn delete_saved_connection(&self, _connection_id: &str) -> anyhow::Result<()> {
        Err(unsupported())
    }

    pub async fn connect(
        &self,
        config: SSHConnectionConfig,
    ) -> anyhow::Result<SSHConnectionResult> {
        self.connect_with_timeout(config, None).await
    }

    pub async fn connect_with_timeout(
        &self,
        _config: SSHConnectionConfig,
        _timeout_ms: Option<u64>,
    ) -> anyhow::Result<SSHConnectionResult> {
        Err(unsupported())
    }

    pub async fn disconnect(&self, _connection_id: &str) -> anyhow::Result<()> {
        Err(unsupported())
    }

    pub async fn disconnect_all(&self) {}

    pub async fn is_connected(&self, _connection_id: &str) -> bool {
        false
    }

    pub async fn ensure_connected(&self, _connection_id: &str) -> anyhow::Result<()> {
        Err(unsupported())
    }

    pub async fn execute_command(
        &self,
        _connection_id: &str,
        _command: &str,
    ) -> anyhow::Result<(String, String, i32)> {
        Err(unsupported())
    }

    pub async fn execute_command_with_options(
        &self,
        _connection_id: &str,
        _command: &str,
        _options: SSHCommandOptions,
    ) -> anyhow::Result<SSHCommandResult> {
        Err(unsupported())
    }

    pub async fn get_server_info(&self, _connection_id: &str) -> Option<ServerInfo> {
        None
    }

    pub async fn resolve_remote_home_if_missing(&self, _connection_id: &str) -> Option<ServerInfo> {
        None
    }

    pub async fn get_connection_config(&self, _connection_id: &str) -> Option<SSHConnectionConfig> {
        None
    }

    pub async fn resolve_sftp_path(
        &self,
        _connection_id: &str,
        _path: &str,
    ) -> anyhow::Result<String> {
        Err(unsupported())
    }

    pub async fn sftp_read(&self, _connection_id: &str, _path: &str) -> anyhow::Result<Vec<u8>> {
        Err(unsupported())
    }

    pub async fn sftp_write(
        &self,
        _connection_id: &str,
        _path: &str,
        _content: &[u8],
    ) -> anyhow::Result<()> {
        Err(unsupported())
    }

    pub async fn sftp_write_from_file(
        &self,
        _connection_id: &str,
        _path: &str,
        _local_path: &std::path::Path,
        _max_bytes: u64,
    ) -> anyhow::Result<u64> {
        Err(unsupported())
    }

    pub async fn sftp_mkdir(&self, _connection_id: &str, _path: &str) -> anyhow::Result<()> {
        Err(unsupported())
    }

    pub async fn sftp_mkdir_all(&self, _connection_id: &str, _path: &str) -> anyhow::Result<()> {
        Err(unsupported())
    }

    pub async fn sftp_remove(&self, _connection_id: &str, _path: &str) -> anyhow::Result<()> {
        Err(unsupported())
    }

    pub async fn sftp_rmdir(&self, _connection_id: &str, _path: &str) -> anyhow::Result<()> {
        Err(unsupported())
    }

    pub async fn sftp_rename(
        &self,
        _connection_id: &str,
        _old_path: &str,
        _new_path: &str,
    ) -> anyhow::Result<()> {
        Err(unsupported())
    }

    pub async fn sftp_exists(&self, _connection_id: &str, _path: &str) -> anyhow::Result<bool> {
        Err(unsupported())
    }

    pub async fn open_pty(
        &self,
        _connection_id: &str,
        _cols: u32,
        _rows: u32,
    ) -> anyhow::Result<PTYSession> {
        Err(unsupported())
    }

    pub async fn get_server_key_fingerprint(&self, _connection_id: &str) -> anyhow::Result<String> {
        Err(unsupported())
    }

    pub fn data_dir(&self) -> &PathBuf {
        &self.data_dir
    }
}

#[derive(Debug, Clone)]
pub struct PTYSession {
    connection_id: String,
}

impl PTYSession {
    pub async fn write(&self, _data: &[u8]) -> anyhow::Result<()> {
        Err(unsupported())
    }

    pub async fn resize(&self, _cols: u32, _rows: u32) -> anyhow::Result<()> {
        Err(unsupported())
    }

    pub async fn read(&self) -> anyhow::Result<Option<Vec<u8>>> {
        Err(unsupported())
    }

    pub async fn close(self) -> anyhow::Result<()> {
        Err(unsupported())
    }

    pub fn connection_id(&self) -> &str {
        &self.connection_id
    }
}

#[derive(Clone, Default)]
pub struct PortForwardManager;

impl PortForwardManager {
    pub fn new() -> Self {
        Self
    }

    pub fn with_ssh_manager(_ssh_manager: SSHConnectionManager) -> Self {
        Self
    }

    pub async fn set_ssh_manager(&self, _manager: SSHConnectionManager) {}

    pub async fn start_local_forward(
        &self,
        _request: &PortForwardRequest,
    ) -> anyhow::Result<PortForward> {
        Err(unsupported())
    }

    pub async fn start_remote_forward(
        &self,
        _connection_id: &str,
        _remote_port: u16,
        _local_host: &str,
        _local_port: u16,
    ) -> anyhow::Result<String> {
        Err(unsupported())
    }

    pub async fn stop_forward(&self, _forward_id: &str) -> anyhow::Result<()> {
        Err(unsupported())
    }

    pub async fn stop_for_connection(&self, _connection_id: &str) -> usize {
        0
    }

    pub async fn stop_all(&self) {}

    pub async fn list_forwards(&self) -> Vec<PortForward> {
        Vec::new()
    }

    pub async fn list_forwards_for_connection(&self, _connection_id: &str) -> Vec<PortForward> {
        Vec::new()
    }

    pub async fn find_forward(
        &self,
        _connection_id: &str,
        _remote_host: &str,
        _remote_port: u16,
    ) -> Option<PortForward> {
        None
    }

    pub async fn is_port_forwarded(&self, _port: u16) -> bool {
        false
    }
}

pub fn global_port_forward_manager() -> PortForwardManager {
    PortForwardManager
}

pub async fn list_remote_listening_ports(
    _manager: &SSHConnectionManager,
    _connection_id: &str,
) -> anyhow::Result<Vec<RemoteListeningPort>> {
    Err(unsupported())
}

#[derive(Debug, Clone)]
pub struct RemoteFileService;

impl RemoteFileService {
    pub fn new(
        _manager: std::sync::Arc<tokio::sync::RwLock<Option<SSHConnectionManager>>>,
    ) -> Self {
        Self
    }

    pub async fn read_file(&self, _connection_id: &str, _path: &str) -> anyhow::Result<Vec<u8>> {
        Err(unsupported())
    }

    pub async fn read_file_with_progress(
        &self,
        _connection_id: &str,
        _path: &str,
        _on_progress: &mut impl FnMut(u64, u64) -> bool,
    ) -> anyhow::Result<Vec<u8>> {
        Err(unsupported())
    }

    pub async fn write_file(
        &self,
        _connection_id: &str,
        _path: &str,
        _content: &[u8],
    ) -> anyhow::Result<()> {
        Err(unsupported())
    }

    pub async fn write_file_with_progress(
        &self,
        _connection_id: &str,
        _path: &str,
        _content: &[u8],
        _on_progress: &mut impl FnMut(u64, u64) -> bool,
    ) -> anyhow::Result<()> {
        Err(unsupported())
    }

    pub async fn exists(&self, _connection_id: &str, _path: &str) -> anyhow::Result<bool> {
        Err(unsupported())
    }

    pub async fn is_file(&self, _connection_id: &str, _path: &str) -> anyhow::Result<bool> {
        Err(unsupported())
    }

    pub async fn is_dir(&self, _connection_id: &str, _path: &str) -> anyhow::Result<bool> {
        Err(unsupported())
    }

    pub async fn read_dir(
        &self,
        _connection_id: &str,
        _path: &str,
    ) -> anyhow::Result<Vec<RemoteDirEntry>> {
        Err(unsupported())
    }

    pub async fn read_dir_bounded(
        &self,
        _connection_id: &str,
        _path: &str,
        _max_entries: usize,
    ) -> anyhow::Result<Vec<RemoteDirEntry>> {
        Err(unsupported())
    }

    pub async fn symlink_stat(
        &self,
        _connection_id: &str,
        _path: &str,
    ) -> anyhow::Result<Option<RemoteFileEntry>> {
        Err(unsupported())
    }

    pub async fn build_tree(
        &self,
        _connection_id: &str,
        _path: &str,
        _max_depth: Option<u32>,
    ) -> anyhow::Result<RemoteTreeNode> {
        Err(unsupported())
    }

    pub async fn build_shallow_tree_for_layout_preview(
        &self,
        _connection_id: &str,
        _path: &str,
    ) -> anyhow::Result<RemoteTreeNode> {
        Err(unsupported())
    }

    pub async fn create_dir(&self, _connection_id: &str, _path: &str) -> anyhow::Result<()> {
        Err(unsupported())
    }

    pub async fn create_dir_all(&self, _connection_id: &str, _path: &str) -> anyhow::Result<()> {
        Err(unsupported())
    }

    pub async fn remove_file(&self, _connection_id: &str, _path: &str) -> anyhow::Result<()> {
        Err(unsupported())
    }

    pub async fn remove_dir_all(&self, _connection_id: &str, _path: &str) -> anyhow::Result<()> {
        Err(unsupported())
    }

    pub async fn remove_dir(&self, _connection_id: &str, _path: &str) -> anyhow::Result<()> {
        Err(unsupported())
    }

    pub async fn rename(
        &self,
        _connection_id: &str,
        _old_path: &str,
        _new_path: &str,
    ) -> anyhow::Result<()> {
        Err(unsupported())
    }

    pub async fn stat(
        &self,
        _connection_id: &str,
        _path: &str,
    ) -> anyhow::Result<Option<RemoteFileEntry>> {
        Err(unsupported())
    }
}

#[derive(Debug, Clone)]
pub struct RemoteTerminalSession {
    pub workspace_id: Option<String>,
    pub id: String,
    pub name: String,
    pub connection_id: String,
    pub cwd: String,
    pub pid: Option<u32>,
    pub status: SessionStatus,
    pub cols: u16,
    pub rows: u16,
    pub source: SessionSource,
}

pub struct CreateSessionResult {
    pub session: RemoteTerminalSession,
    pub output_rx: tokio::sync::broadcast::Receiver<Vec<u8>>,
}

#[derive(Debug, Clone, PartialEq)]
pub enum SessionStatus {
    Active,
    Inactive,
    Closed,
}

#[derive(Clone, Default)]
pub struct RemoteTerminalManager;

impl RemoteTerminalManager {
    pub fn new(_ssh_manager: SSHConnectionManager) -> Self {
        Self
    }

    pub async fn set_ssh_manager(&self, _manager: SSHConnectionManager) {}

    #[allow(clippy::too_many_arguments)]
    pub async fn create_session(
        &self,
        _session_id: Option<String>,
        _name: Option<String>,
        _connection_id: &str,
        _cols: u16,
        _rows: u16,
        _initial_cwd: Option<&str>,
        _source: Option<SessionSource>,
    ) -> anyhow::Result<CreateSessionResult> {
        Err(unsupported())
    }

    pub async fn set_workspace_id(&self, _session_id: &str, _workspace_id: Option<String>) {}

    pub async fn get_session(&self, _session_id: &str) -> Option<RemoteTerminalSession> {
        None
    }

    pub async fn list_sessions(&self) -> Vec<RemoteTerminalSession> {
        Vec::new()
    }

    pub async fn write(&self, _session_id: &str, _data: &[u8]) -> anyhow::Result<()> {
        Err(unsupported())
    }

    pub async fn resize(&self, _session_id: &str, _cols: u16, _rows: u16) -> anyhow::Result<()> {
        Err(unsupported())
    }

    pub async fn close_session(&self, _session_id: &str) -> anyhow::Result<()> {
        Err(unsupported())
    }

    pub async fn is_pty_active(&self, _session_id: &str) -> bool {
        false
    }

    pub async fn subscribe_output(
        &self,
        _session_id: &str,
    ) -> anyhow::Result<tokio::sync::broadcast::Receiver<Vec<u8>>> {
        Err(unsupported())
    }
}
