//! Remote SSH Service Module
//!
//! Provides SSH connection management and SFTP-based remote file operations.
//! This allows OpenBitFun to work with files on remote servers via SSH,
//! similar to VSCode's Remote SSH extension.

#[cfg(feature = "ssh-remote")]
pub mod manager;
#[cfg(feature = "ssh-remote")]
pub mod remote_fs;
#[cfg(feature = "ssh-remote")]
pub mod remote_terminal;
pub mod types;
pub mod workspace_state;

#[cfg(feature = "ssh-remote")]
pub use openbitfun_services_integrations::remote_ssh::dispatch_ssh;
pub use openbitfun_services_integrations::remote_ssh::{
    build_remote_git_command, search_remote_file_names, shell_quote_posix, RemoteFileNameSearch,
};
#[cfg(not(feature = "ssh-remote"))]
pub use openbitfun_services_integrations::remote_ssh::{
    get_global_remote_exec_process_manager, global_port_forward_manager,
    list_remote_listening_ports, KnownHostEntry, PTYSession, PortForwardManager,
    RemoteExecCommandRequest, RemoteExecCommandResponse, RemoteExecControlAction,
    RemoteExecControlOrigin, RemoteExecControlRequest, RemoteExecError,
    RemoteExecProcessLifecycleEvent, RemoteExecProcessLifecycleStatus, RemoteExecProcessManager,
    RemoteExecResult, RemoteExecSessionCompletion, RemoteExecSessionCompletionSource,
    RemoteExecSessionCompletionStatus, RemoteFileService, RemoteSendStdinRequest,
    RemoteTerminalManager, RemoteTerminalSession, RemoteWriteStdinRequest, SSHConnectionManager,
    SessionStatus,
};
#[cfg(feature = "ssh-remote")]
pub use openbitfun_services_integrations::remote_ssh::{
    get_global_remote_exec_process_manager, RemoteExecCommandRequest, RemoteExecCommandResponse,
    RemoteExecControlAction, RemoteExecControlOrigin, RemoteExecControlRequest, RemoteExecError,
    RemoteExecProcessLifecycleEvent, RemoteExecProcessLifecycleStatus, RemoteExecProcessManager,
    RemoteExecResult, RemoteExecSessionCompletion, RemoteExecSessionCompletionSource,
    RemoteExecSessionCompletionStatus, RemoteSendStdinRequest, RemoteWriteStdinRequest,
};
#[cfg(feature = "ssh-remote")]
pub use openbitfun_services_integrations::remote_ssh::{
    global_port_forward_manager, list_remote_listening_ports, KnownHostEntry, PTYSession,
    PortForwardManager, SSHConnectionManager,
};
#[cfg(feature = "ssh-remote")]
pub use remote_fs::RemoteFileService;
#[cfg(feature = "ssh-remote")]
pub use remote_terminal::{RemoteTerminalManager, RemoteTerminalSession, SessionStatus};
pub use types::*;
pub use workspace_state::{
    canonicalize_local_workspace_root, get_remote_workspace_manager, init_remote_workspace_manager,
    is_remote_path, local_workspace_roots_equal, local_workspace_stable_storage_id,
    lookup_remote_connection, lookup_remote_connection_with_hint,
    normalize_local_workspace_root_for_stable_id, normalize_remote_workspace_path,
    remote_workspace_stable_id, workspace_logical_key, RemoteWorkspaceEntry, RemoteWorkspaceState,
    RemoteWorkspaceStateManager, LOCAL_WORKSPACE_SSH_HOST,
};
