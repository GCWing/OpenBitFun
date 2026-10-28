//! Remote SSH service contracts.
//!
//! `openbitfun-core::service::remote_ssh` remains as the compatibility facade for
//! the legacy public path.

mod file_name_search;
pub mod paths;
mod product_paths;
pub mod remote_git;
#[cfg(feature = "remote-ssh-concrete")]
mod sftp_file;
mod shell;
#[cfg(feature = "remote-ssh-concrete")]
mod transport;
pub mod types;
pub mod workspace_registry;
#[cfg(feature = "workspace-search")]
pub mod workspace_search;
mod workspace_services;
#[cfg(feature = "remote-ssh-concrete")]
pub mod wsl;

#[cfg(not(feature = "remote-ssh-concrete"))]
mod disabled;
#[cfg(feature = "remote-ssh-concrete")]
pub mod dispatch_ssh;
#[cfg(feature = "remote-ssh-concrete")]
pub mod manager;
#[cfg(feature = "remote-ssh-concrete")]
mod password_vault;
#[cfg(feature = "remote-ssh-concrete")]
mod port_forward;
#[cfg(feature = "remote-ssh-concrete")]
mod proxy_command;
#[cfg(feature = "remote-ssh-concrete")]
#[cfg(feature = "remote-ssh-concrete")]
mod release_verify;
#[cfg(feature = "remote-ssh-concrete")]
mod remote_exec;
#[cfg(feature = "remote-ssh-concrete")]
mod remote_exec_runtime_port;
#[cfg(feature = "remote-ssh-concrete")]
pub mod remote_fs;
#[cfg(feature = "remote-ssh-concrete")]
pub mod remote_terminal;
#[cfg(all(feature = "remote-ssh-concrete", feature = "ssh_config"))]
mod ssh_config_loader;

pub use file_name_search::{search_remote_file_names, RemoteFileNameSearch};
pub use paths::*;
pub use remote_git::{build_remote_git_command, shell_quote_posix};
#[cfg(feature = "remote-ssh-concrete")]
pub use transport::{
    WorkspaceProcessCompletion, WorkspaceProcessControl, WorkspaceProcessExit,
    WorkspaceProcessSignal, WorkspaceReader, WorkspaceStdio, WorkspaceWriter,
};
pub use types::*;
pub use workspace_registry::*;
pub use workspace_services::{remote_workspace_services, RemoteWorkspaceFs, RemoteWorkspaceShell};

#[cfg(not(feature = "remote-ssh-concrete"))]
pub use disabled::{
    dispatch_ssh, get_global_remote_exec_process_manager, global_port_forward_manager,
    list_remote_listening_ports, KnownHostEntry, PTYSession, PortForwardManager,
    RemoteExecCommandRequest, RemoteExecCommandResponse, RemoteExecControlAction,
    RemoteExecControlOrigin, RemoteExecControlRequest, RemoteExecError,
    RemoteExecProcessLifecycleEvent, RemoteExecProcessLifecycleStatus, RemoteExecProcessManager,
    RemoteExecResult, RemoteExecSessionCompletion, RemoteExecSessionCompletionSource,
    RemoteExecSessionCompletionStatus, RemoteFileService, RemoteSendStdinRequest,
    RemoteTerminalManager, RemoteTerminalSession, RemoteWriteStdinRequest, SSHConnectionManager,
    SessionStatus,
};
#[cfg(feature = "remote-ssh-concrete")]
pub use manager::{KnownHostEntry, PTYSession, SSHConnectionManager};
#[cfg(feature = "remote-ssh-concrete")]
pub use port_forward::{
    global_port_forward_manager, list_remote_listening_ports, PortForwardManager,
};
#[cfg(feature = "remote-ssh-concrete")]
pub use remote_exec::{
    get_global_remote_exec_process_manager, RemoteExecCommandRequest, RemoteExecCommandResponse,
    RemoteExecControlAction, RemoteExecControlOrigin, RemoteExecControlRequest, RemoteExecError,
    RemoteExecProcessLifecycleEvent, RemoteExecProcessLifecycleStatus, RemoteExecProcessManager,
    RemoteExecResult, RemoteExecSessionCompletion, RemoteExecSessionCompletionSource,
    RemoteExecSessionCompletionStatus, RemoteSendStdinRequest, RemoteWriteStdinRequest,
};
#[cfg(feature = "remote-ssh-concrete")]
pub use remote_exec_runtime_port::{RemoteExecRuntimePort, RemoteExecSshManagerProvider};
#[cfg(feature = "remote-ssh-concrete")]
pub use remote_fs::RemoteFileService;
#[cfg(feature = "remote-ssh-concrete")]
pub use remote_terminal::{RemoteTerminalManager, RemoteTerminalSession, SessionStatus};
