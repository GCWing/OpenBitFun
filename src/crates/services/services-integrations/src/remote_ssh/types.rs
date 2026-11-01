//! Type definitions for Remote SSH service

use serde::{Deserialize, Deserializer, Serialize};
use tokio_util::sync::CancellationToken;

/// Workspace backend type
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(tag = "type", content = "data")]
pub enum WorkspaceBackend {
    /// Local workspace (default)
    Local,
    /// Remote SSH workspace
    Remote(RemoteWorkspaceInfo),
}

/// Remote workspace information
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct RemoteWorkspaceInfo {
    /// SSH connection ID
    pub connection_id: String,
    /// Connection name (display name)
    pub connection_name: String,
    /// Remote path on the server
    pub remote_path: String,
}

/// SSH connection configuration
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SSHConnectionConfig {
    /// Unique identifier for this connection
    pub id: String,
    /// Display name for the connection
    pub name: String,
    /// Remote host address (hostname or IP)
    pub host: String,
    /// SSH port (default: 22)
    pub port: u16,
    /// SSH username
    pub username: String,
    /// Authentication method
    #[serde(deserialize_with = "deserialize_ssh_auth_method")]
    pub auth: SSHAuthMethod,
    /// Default remote working directory
    #[serde(rename = "defaultWorkspace")]
    pub default_workspace: Option<String>,
    /// OpenSSH-compatible comma-separated jump host chain.
    ///
    /// Each entry may be an alias from `~/.ssh/config` or
    /// `[user@]host[:port]`. Jump authentication is resolved from the matching
    /// SSH config entry, so every hop may use a different user and identity.
    #[serde(default)]
    pub proxy_jump: Option<String>,
    /// Optional Docker container that becomes the effective workspace target.
    #[serde(default)]
    pub container: Option<ContainerWorkspaceConfig>,
    /// A Linux distribution owned by the Windows host running OpenBitFun.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub wsl: Option<WslWorkspaceConfig>,
    /// Connection and authentication timeout/retry policy.
    #[serde(default)]
    pub options: SSHConnectionOptions,
}

impl SSHConnectionConfig {
    /// Compare the connection parameters that affect the underlying SSH session
    /// (host, port, username, auth type). Used to detect config drift between
    /// an active connection and the latest saved config so that a reconnect
    /// can be triggered when the user changes the port or other params.
    pub fn connection_params_equal(&self, other: &Self) -> bool {
        self.host == other.host
            && self.port == other.port
            && self.username == other.username
            && self.auth.connection_params_equal(&other.auth)
            && self.proxy_jump == other.proxy_jump
            && self.container == other.container
            && self.wsl == other.wsl
            && self.options == other.options
    }

    pub fn uses_local_docker(&self) -> bool {
        self.container
            .as_ref()
            .is_some_and(|container| container.local)
    }

    pub fn uses_local_process(&self) -> bool {
        self.wsl.is_some() || self.uses_local_docker()
    }

    pub fn uses_shell_filesystem(&self) -> bool {
        self.wsl.is_some() || self.uses_docker_exec()
    }

    pub fn uses_docker_exec(&self) -> bool {
        self.container.as_ref().is_some_and(|container| {
            matches!(
                container.access,
                ContainerAccess::DockerExec | ContainerAccess::Auto
            )
        })
    }
}

impl SSHAuthMethod {
    fn connection_params_equal(&self, other: &Self) -> bool {
        match (self, other) {
            (Self::Password { .. }, Self::Password { .. })
            | (Self::KeyboardInteractive { .. }, Self::KeyboardInteractive { .. })
            | (Self::None, Self::None) => true,
            (
                Self::PrivateKey {
                    key_path,
                    certificate_path,
                    ..
                },
                Self::PrivateKey {
                    key_path: other_key_path,
                    certificate_path: other_certificate_path,
                    ..
                },
            ) => key_path == other_key_path && certificate_path == other_certificate_path,
            (
                Self::Agent {
                    key_fingerprint,
                    fallback_key_path,
                },
                Self::Agent {
                    key_fingerprint: other_key_fingerprint,
                    fallback_key_path: other_fallback_key_path,
                },
            ) => {
                key_fingerprint == other_key_fingerprint
                    && fallback_key_path == other_fallback_key_path
            }
            _ => false,
        }
    }
}

fn default_connect_timeout_secs() -> u64 {
    30
}

fn default_auth_timeout_secs() -> u64 {
    60
}

fn default_auth_attempts() -> u8 {
    3
}

fn default_connect_attempts() -> u8 {
    1
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct SSHConnectionOptions {
    #[serde(default = "default_connect_timeout_secs")]
    pub connect_timeout_secs: u64,
    #[serde(default = "default_auth_timeout_secs")]
    pub auth_timeout_secs: u64,
    #[serde(default = "default_auth_attempts")]
    pub auth_attempts: u8,
    #[serde(default = "default_connect_attempts")]
    pub connect_attempts: u8,
}

impl Default for SSHConnectionOptions {
    fn default() -> Self {
        Self {
            connect_timeout_secs: default_connect_timeout_secs(),
            auth_timeout_secs: default_auth_timeout_secs(),
            auth_attempts: default_auth_attempts(),
            connect_attempts: default_connect_attempts(),
        }
    }
}

fn default_docker_path() -> String {
    "docker".to_string()
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct WslWorkspaceConfig {
    pub distribution: String,
    /// Omitted means the distribution's configured default Linux user.
    #[serde(default)]
    pub user: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct WslDistributions {
    /// Describes the executing host, never the controller's operating system.
    pub supported: bool,
    pub distributions: Vec<String>,
}

fn default_container_shell() -> String {
    "/bin/sh".to_string()
}

fn default_true() -> bool {
    true
}

/// How OpenBitFun enters a configured container workspace.
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "kebab-case")]
pub enum ContainerAccess {
    /// The top-level SSH host/port/user fields point at sshd in the container.
    Sshd,
    /// Execute every workspace operation through `docker exec`.
    DockerExec,
    /// Probe the container's published sshd endpoint and fall back to
    /// `docker exec` when the SSH handshake or authentication is unavailable.
    Auto,
}

/// Docker container workspace configuration.
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct ContainerWorkspaceConfig {
    /// Container name or ID.
    pub name: String,
    pub access: ContainerAccess,
    /// Run Docker on the local OpenBitFun machine instead of an SSH host.
    #[serde(default)]
    pub local: bool,
    /// Docker CLI path on the machine that owns the container.
    #[serde(default = "default_docker_path")]
    pub docker_path: String,
    /// Shell inside the container.
    #[serde(default = "default_container_shell")]
    pub shell: String,
    /// Optional container user passed to `docker exec --user`.
    #[serde(default)]
    pub user: Option<String>,
    /// Keep stdin open with `docker exec -i`.
    #[serde(default = "default_true")]
    pub interactive: bool,
}

/// SSH authentication method
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(tag = "type")]
pub enum SSHAuthMethod {
    /// Password authentication
    Password { password: String },
    /// Private key authentication
    PrivateKey {
        /// Path to private key file on local machine
        #[serde(rename = "keyPath")]
        key_path: String,
        /// Optional passphrase for encrypted private key
        passphrase: Option<String>,
        /// Optional OpenSSH user certificate paired with the private key.
        #[serde(default, rename = "certificatePath")]
        certificate_path: Option<String>,
    },
    /// Use identities exposed by the platform OpenSSH agent.
    Agent {
        /// Optional public-key fingerprint used to select one agent identity.
        #[serde(default, rename = "keyFingerprint")]
        key_fingerprint: Option<String>,
        /// Optional compatibility fallback when an agent is unavailable.
        #[serde(default, rename = "fallbackKeyPath")]
        fallback_key_path: Option<String>,
    },
    /// Keyboard-interactive authentication (password/OTP/challenge response).
    ///
    /// Responses are runtime-only and are never copied into `SavedConnection`.
    KeyboardInteractive {
        #[serde(default)]
        responses: Vec<String>,
    },
    /// Accept the server without sending credentials (`none` method).
    ///
    /// Needed for endpoints whose transport is already authenticated and that
    /// therefore advertise only `none`: Coder workspace agents are the motivating
    /// case, because `coder ssh --stdio` authenticates the tunnel with the CLI
    /// token and the agent disconnects clients that attempt public key or password
    /// authentication.
    None,
}

fn deserialize_ssh_auth_method<'de, D>(deserializer: D) -> Result<SSHAuthMethod, D::Error>
where
    D: Deserializer<'de>,
{
    #[derive(Deserialize)]
    #[serde(tag = "type")]
    enum Helper {
        Password {
            password: String,
        },
        PrivateKey {
            #[serde(rename = "keyPath")]
            key_path: String,
            passphrase: Option<String>,
            #[serde(default, rename = "certificatePath")]
            certificate_path: Option<String>,
        },
        Agent {
            #[serde(default, rename = "keyFingerprint")]
            key_fingerprint: Option<String>,
            #[serde(default, rename = "fallbackKeyPath")]
            fallback_key_path: Option<String>,
        },
        KeyboardInteractive {
            #[serde(default)]
            responses: Vec<String>,
        },
        None,
    }
    match Helper::deserialize(deserializer)? {
        Helper::Password { password } => Ok(SSHAuthMethod::Password { password }),
        Helper::PrivateKey {
            key_path,
            passphrase,
            certificate_path,
        } => Ok(SSHAuthMethod::PrivateKey {
            key_path,
            passphrase,
            certificate_path,
        }),
        Helper::Agent {
            key_fingerprint,
            fallback_key_path,
        } => Ok(SSHAuthMethod::Agent {
            key_fingerprint,
            fallback_key_path: fallback_key_path.or_else(|| Some("~/.ssh/id_rsa".to_string())),
        }),
        Helper::KeyboardInteractive { responses } => {
            Ok(SSHAuthMethod::KeyboardInteractive { responses })
        }
        Helper::None => Ok(SSHAuthMethod::None),
    }
}

/// Connection state
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
pub enum ConnectionState {
    /// Not connected
    Disconnected,
    /// Connection in progress
    Connecting,
    /// Successfully connected
    Connected,
    /// Connection failed with error
    Failed { error: String },
}

/// Saved connection (without sensitive data like passwords)
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SavedConnection {
    pub id: String,
    pub name: String,
    pub host: String,
    pub port: u16,
    pub username: String,
    #[serde(rename = "authType", deserialize_with = "deserialize_saved_auth_type")]
    pub auth_type: SavedAuthType,
    #[serde(rename = "defaultWorkspace")]
    pub default_workspace: Option<String>,
    #[serde(rename = "lastConnected")]
    pub last_connected: Option<u64>,
    #[serde(default)]
    pub proxy_jump: Option<String>,
    #[serde(default)]
    pub container: Option<ContainerWorkspaceConfig>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub wsl: Option<WslWorkspaceConfig>,
    #[serde(default)]
    pub options: SSHConnectionOptions,
}

/// Saved auth type (excludes sensitive credentials; password ciphertext is in `ssh_password_vault.json`)
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(tag = "type")]
pub enum SavedAuthType {
    Password,
    PrivateKey {
        #[serde(rename = "keyPath")]
        key_path: String,
        #[serde(default, rename = "certificatePath")]
        certificate_path: Option<String>,
    },
    Agent {
        #[serde(default, rename = "keyFingerprint")]
        key_fingerprint: Option<String>,
        #[serde(default, rename = "fallbackKeyPath")]
        fallback_key_path: Option<String>,
    },
    KeyboardInteractive,
    /// Server accepts the connection without credentials (see `SSHAuthMethod::None`).
    None,
}

fn deserialize_saved_auth_type<'de, D>(deserializer: D) -> Result<SavedAuthType, D::Error>
where
    D: Deserializer<'de>,
{
    #[derive(Deserialize)]
    #[serde(tag = "type")]
    enum Helper {
        Password,
        PrivateKey {
            #[serde(rename = "keyPath")]
            key_path: String,
            #[serde(default, rename = "certificatePath")]
            certificate_path: Option<String>,
        },
        Agent {
            #[serde(default, rename = "keyFingerprint")]
            key_fingerprint: Option<String>,
            #[serde(default, rename = "fallbackKeyPath")]
            fallback_key_path: Option<String>,
        },
        KeyboardInteractive,
        None,
    }
    match Helper::deserialize(deserializer)? {
        Helper::Password => Ok(SavedAuthType::Password),
        Helper::PrivateKey {
            key_path,
            certificate_path,
        } => Ok(SavedAuthType::PrivateKey {
            key_path,
            certificate_path,
        }),
        Helper::Agent {
            key_fingerprint,
            fallback_key_path,
        } => Ok(SavedAuthType::Agent {
            key_fingerprint,
            fallback_key_path: fallback_key_path.or_else(|| Some("~/.ssh/id_rsa".to_string())),
        }),
        Helper::KeyboardInteractive => Ok(SavedAuthType::KeyboardInteractive),
        Helper::None => Ok(SavedAuthType::None),
    }
}

/// Remote file entry information
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct RemoteFileEntry {
    pub name: String,
    pub path: String,
    #[serde(rename = "isDir")]
    pub is_dir: bool,
    #[serde(rename = "isFile")]
    pub is_file: bool,
    #[serde(rename = "isSymlink")]
    pub is_symlink: bool,
    pub size: Option<u64>,
    pub modified: Option<u64>,
    pub permissions: Option<String>,
}

/// Remote file tree node
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct RemoteTreeNode {
    pub name: String,
    pub path: String,
    #[serde(rename = "isDir")]
    pub is_dir: bool,
    pub children: Option<Vec<RemoteTreeNode>>,
}

/// Remote directory entry (for read_dir operations)
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct RemoteDirEntry {
    pub name: String,
    pub path: String,
    #[serde(rename = "isDir")]
    pub is_dir: bool,
    #[serde(rename = "isFile")]
    pub is_file: bool,
    #[serde(rename = "isSymlink")]
    pub is_symlink: bool,
    pub size: Option<u64>,
    pub modified: Option<u64>,
    pub permissions: Option<String>,
}

/// Result of SSH connection attempt
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SSHConnectionResult {
    pub success: bool,
    #[serde(rename = "connectionId")]
    pub connection_id: Option<String>,
    pub error: Option<String>,
    #[serde(rename = "serverInfo")]
    pub server_info: Option<ServerInfo>,
}

/// Options for executing a remote SSH command.
#[derive(Debug, Clone, Default)]
pub struct SSHCommandOptions {
    pub timeout_ms: Option<u64>,
    pub cancellation_token: Option<CancellationToken>,
}

/// Result of executing a remote SSH command.
#[derive(Debug, Clone)]
pub struct SSHCommandResult {
    pub stdout: String,
    pub stderr: String,
    pub exit_code: i32,
    pub interrupted: bool,
    pub timed_out: bool,
}

/// Remote server information
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ServerInfo {
    #[serde(rename = "osType")]
    pub os_type: String,
    pub hostname: String,
    #[serde(rename = "homeDir")]
    pub home_dir: String,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct DockerContainerInfo {
    pub id: String,
    pub name: String,
    pub image: String,
    pub status: String,
    pub state: String,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct ConnectionTestStage {
    pub id: String,
    pub label: String,
    pub success: bool,
    pub error: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ConnectionTestReport {
    pub success: bool,
    pub stages: Vec<ConnectionTestStage>,
    pub server_info: Option<ServerInfo>,
    pub resolved_container_access: Option<ContainerAccess>,
}

/// Result of remote file operation
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct RemoteFileResult {
    pub success: bool,
    pub error: Option<String>,
}

/// Result of remote directory listing
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct RemoteListResult {
    pub entries: Vec<RemoteFileEntry>,
    pub error: Option<String>,
}

/// Request to open a remote workspace
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct RemoteWorkspaceRequest {
    #[serde(rename = "connectionId")]
    pub connection_id: String,
    #[serde(rename = "remotePath")]
    pub remote_path: String,
}

/// Remote workspace info (persisted in `remote_workspace.json`).
/// `#[serde(default)]` keeps older files loadable if a field was absent.
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct RemoteWorkspace {
    #[serde(default)]
    pub connection_id: String,
    #[serde(default)]
    pub remote_path: String,
    #[serde(default)]
    pub connection_name: String,
    /// SSH config `host`; used for `~/.openbitfun/remote_ssh/{host}/...` session storage.
    #[serde(default)]
    pub ssh_host: String,
}

/// SSH config entry parsed from ~/.ssh/config
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SSHConfigEntry {
    /// Host name (alias from SSH config)
    pub host: String,
    /// Actual hostname or IP
    pub hostname: Option<String>,
    /// SSH port
    pub port: Option<u16>,
    /// Username
    pub user: Option<String>,
    /// Path to identity file (private key)
    pub identity_file: Option<String>,
    /// Whether to use SSH agent
    pub agent: Option<bool>,
    /// Optional OpenSSH user certificate path.
    #[serde(default)]
    pub certificate_file: Option<String>,
    /// OpenSSH ProxyJump chain, preserving aliases and order.
    #[serde(default)]
    pub proxy_jump: Option<String>,
}

/// Result of looking up SSH config for a host
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SSHConfigLookupResult {
    /// Whether a config entry was found
    pub found: bool,
    /// Config entry if found
    pub config: Option<SSHConfigEntry>,
}

/// Direction of an SSH port forward.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub enum PortForwardDirection {
    /// `ssh -L`: a listener on this machine whose connections are carried to
    /// the remote end.
    Local,
    /// `ssh -R`: a listener on the remote whose connections are carried back
    /// to this machine.
    Remote,
    /// `ssh -D`: a local SOCKS proxy.
    Dynamic,
}

/// A user-requested local port forward.
///
/// Only the remote port is required. Everything else has a default that suits
/// the common case: a dev server bound to the remote's loopback interface,
/// reachable from this machine on the same port number when it happens to be
/// free.
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct PortForwardRequest {
    /// SSH connection that carries the forward.
    pub connection_id: String,
    /// Port the service listens on, as seen from the remote host.
    pub remote_port: u16,
    /// Address used by the remote sshd to reach the service. Defaults to
    /// loopback, which is what a server bound to `localhost` needs.
    #[serde(default)]
    pub remote_host: Option<String>,
    /// Port to bind on this machine. `None` or `0` allocates a free one.
    #[serde(default)]
    pub local_port: Option<u16>,
    /// Bind every interface instead of loopback only.
    ///
    /// This republishes the remote service to the local network, so it stays
    /// opt-in and is never implied by any other field.
    #[serde(default)]
    pub expose_on_lan: bool,
    /// Optional user-facing name for the mapping.
    #[serde(default)]
    pub label: Option<String>,
}

impl PortForwardRequest {
    /// Address the remote sshd should dial, defaulting to loopback.
    pub fn effective_remote_host(&self) -> &str {
        match self.remote_host.as_deref().map(str::trim) {
            Some(host) if !host.is_empty() => host,
            _ => "127.0.0.1",
        }
    }

    /// Interface to bind on this machine.
    pub fn effective_local_host(&self) -> &'static str {
        if self.expose_on_lan {
            "0.0.0.0"
        } else {
            "127.0.0.1"
        }
    }

    /// Requested local port, with `0` normalized to "allocate one for me".
    pub fn preferred_local_port(&self) -> Option<u16> {
        self.local_port.filter(|port| *port != 0)
    }

    /// Trimmed label, dropping a blank one.
    pub fn normalized_label(&self) -> Option<String> {
        self.label
            .as_deref()
            .map(str::trim)
            .filter(|label| !label.is_empty())
            .map(str::to_string)
    }
}

/// A live port forward as reported to the UI.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct PortForward {
    pub id: String,
    pub connection_id: String,
    pub direction: PortForwardDirection,
    pub label: Option<String>,
    /// Interface the listener is bound to on this machine.
    pub local_host: String,
    /// Port actually bound, which is not always the port that was asked for.
    pub local_port: u16,
    /// Set only when the requested port was unavailable and a different one was
    /// bound instead. The UI needs this to explain the mismatch rather than
    /// silently handing back an address the user did not ask for.
    pub requested_local_port: Option<u16>,
    pub remote_host: String,
    pub remote_port: u16,
    /// Connections currently being carried.
    pub active_connections: u32,
    /// Connections accepted since the forward started.
    pub total_connections: u64,
    /// Most recent per-connection failure. Kept as the forward's health signal:
    /// a forward stays listening even when the remote service is not up yet.
    pub last_error: Option<String>,
}

impl PortForward {
    /// Address to hand a browser, in `host:port` form.
    ///
    /// A wildcard bind is displayed as loopback because that is the address
    /// that actually works on this machine.
    pub fn local_address(&self) -> String {
        let host = match self.local_host.as_str() {
            "0.0.0.0" => "127.0.0.1",
            "::" => "[::1]",
            other => other,
        };
        format!("{}:{}", host, self.local_port)
    }
}

/// A listening TCP port discovered on the remote host.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct RemoteListeningPort {
    pub port: u16,
    /// Address the remote service is bound to, as reported by the remote.
    pub bind_address: String,
    /// Owning process name when the remote tool exposed it.
    pub process: Option<String>,
    /// Owning process id when the remote tool exposed it.
    pub pid: Option<u32>,
}
