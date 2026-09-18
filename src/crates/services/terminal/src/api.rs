//! API module - Public interface for terminal operations
//!
//! This module provides the public API for external consumers (Tauri, WebSocket, etc.)
//! It defines request/response types and the main service interface.

use std::collections::HashMap;
use std::sync::Arc;

use serde::{Deserialize, Serialize};

use std::time::Duration;

use crate::config::TerminalConfig;
use crate::events::TerminalEvent;
use crate::session::{
    get_session_manager, init_session_manager, is_session_manager_initialized,
    CommandCompletionReason, CommandExecuteResult, ExecuteOptions, SessionManager, SessionSource,
    TerminalReplayEvent, TerminalSession,
};
use crate::shell::{ShellDetector, ShellType};
use crate::{TerminalError, TerminalResult};

// Re-export streaming types for external use
pub use crate::session::{CommandStream, CommandStreamEvent};

// ============================================================================
// Request/Response Types
// ============================================================================

/// Request to create a terminal session
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct CreateSessionRequest {
    /// Optional session ID (if not provided, a UUID will be generated)
    #[serde(rename = "sessionId")]
    pub session_id: Option<String>,
    /// Optional session name
    pub name: Option<String>,
    /// Optional shell type
    #[serde(rename = "shellType")]
    pub shell_type: Option<ShellType>,
    /// Optional stable ID of a discovered shell executable.
    #[serde(rename = "shellId", skip_serializing_if = "Option::is_none")]
    pub shell_id: Option<String>,
    /// Optional working directory
    #[serde(rename = "workingDirectory")]
    pub working_directory: Option<String>,
    /// Optional custom environment variables
    pub env: Option<HashMap<String, String>>,
    /// Optional terminal dimensions
    pub cols: Option<u16>,
    pub rows: Option<u16>,
    /// Optional remote connection ID (for remote workspace sessions)
    #[serde(rename = "remoteConnectionId", skip_serializing_if = "Option::is_none")]
    pub remote_connection_id: Option<String>,
    /// Optional session creation source
    #[serde(skip_serializing_if = "Option::is_none")]
    pub source: Option<SessionSource>,
}

/// Response for session creation
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct SessionResponse {
    #[serde(
        default,
        rename = "workspaceId",
        skip_serializing_if = "Option::is_none"
    )]
    pub workspace_id: Option<String>,
    /// Session ID
    pub id: String,
    /// Session name
    pub name: String,
    /// Shell type
    #[serde(rename = "shellType")]
    pub shell_type: ShellType,
    /// Current working directory
    pub cwd: String,
    /// Immutable creation directory, used to associate the terminal with a workspace.
    #[serde(
        default,
        rename = "initialCwd",
        skip_serializing_if = "Option::is_none"
    )]
    pub initial_cwd: Option<String>,
    /// Process ID (if running)
    pub pid: Option<u32>,
    /// Session status
    pub status: String,
    /// Terminal dimensions
    pub cols: u16,
    pub rows: u16,
    /// Session creation source
    pub source: SessionSource,
}

impl From<TerminalSession> for SessionResponse {
    fn from(session: TerminalSession) -> Self {
        Self {
            workspace_id: session
                .metadata
                .owner
                .as_ref()
                .filter(|owner| owner.owner_type == crate::session::OwnerType::Workspace)
                .map(|owner| owner.id.clone()),
            id: session.id,
            name: session.name,
            shell_type: session.shell_type,
            cwd: session.cwd,
            initial_cwd: Some(session.initial_cwd),
            pid: session.pid,
            status: format!("{:?}", session.status),
            cols: session.cols,
            rows: session.rows,
            source: session.source,
        }
    }
}

#[cfg(test)]
mod workspace_origin_contract_tests {
    use super::SessionResponse;
    use serde_json::json;

    #[test]
    fn old_terminal_payload_round_trips_without_requiring_initial_cwd() {
        let legacy = json!({
            "id": "existing-terminal", "name": "Development", "shellType": "Bash",
            "cwd": "/repo/src", "pid": null, "status": "Running", "cols": 80,
            "rows": 24, "source": "manual"
        });
        let response: SessionResponse = serde_json::from_value(legacy.clone()).unwrap();
        assert!(response.initial_cwd.is_none());
        assert_eq!(serde_json::to_value(response).unwrap(), legacy);
    }

    #[test]
    fn workspace_identity_survives_directory_changes_and_round_trip() {
        let mut response: SessionResponse = serde_json::from_value(json!({
            "id": "terminal", "workspaceId": "workspace-remote", "name": "Development",
            "shellType": "Bash", "cwd": "/repo", "pid": null,
            "status": "Running", "cols": 80, "rows": 24, "source": "manual"
        }))
        .unwrap();
        response.cwd = "/another-project".to_owned();
        let json = serde_json::to_value(response).unwrap();
        assert_eq!(json["workspaceId"], "workspace-remote");
        assert_eq!(json["cwd"], "/another-project");
        let restored: SessionResponse = serde_json::from_value(json).unwrap();
        assert_eq!(restored.workspace_id.as_deref(), Some("workspace-remote"));
    }

    #[test]
    fn initial_directory_survives_current_directory_changes_and_serialization() {
        let mut response: SessionResponse = serde_json::from_value(json!({
            "id": "terminal", "name": "Development", "shellType": "Bash",
            "cwd": "/repo", "initialCwd": "/repo", "pid": null, "status": "Running",
            "cols": 80, "rows": 24, "source": "agent"
        }))
        .unwrap();
        response.cwd = "/another-project".into();
        let restored: SessionResponse =
            serde_json::from_value(serde_json::to_value(response).unwrap()).unwrap();
        assert_eq!(restored.initial_cwd.as_deref(), Some("/repo"));
        assert_eq!(restored.cwd, "/another-project");
    }
}

/// Request to write data to terminal
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct WriteRequest {
    /// Session ID
    #[serde(rename = "sessionId")]
    pub session_id: String,
    /// Data to write
    pub data: String,
}

/// Request to resize terminal
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct ResizeRequest {
    /// Session ID
    #[serde(rename = "sessionId")]
    pub session_id: String,
    /// New column count
    pub cols: u16,
    /// New row count
    pub rows: u16,
}

/// Request to close a session
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct CloseSessionRequest {
    /// Session ID
    #[serde(rename = "sessionId")]
    pub session_id: String,
    /// Whether to force immediate close
    pub immediate: Option<bool>,
}

/// Request to send a signal
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct SignalRequest {
    /// Session ID
    #[serde(rename = "sessionId")]
    pub session_id: String,
    /// Signal name (e.g., "SIGINT")
    pub signal: String,
}

/// Request to acknowledge data
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct AcknowledgeRequest {
    /// Session ID
    #[serde(rename = "sessionId")]
    pub session_id: String,
    /// Number of characters acknowledged
    #[serde(rename = "charCount")]
    pub char_count: usize,
}

/// Request to get session output history
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct GetHistoryRequest {
    /// Session ID
    #[serde(rename = "sessionId")]
    pub session_id: String,
}

/// Response for session history
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct GetHistoryResponse {
    /// Session ID
    #[serde(rename = "sessionId")]
    pub session_id: String,
    /// Ordered resize/data replay events.
    #[serde(default)]
    pub events: Vec<TerminalReplayEvent>,
    /// Output history data
    pub data: String,
    /// Current history size in bytes
    #[serde(rename = "historySize")]
    pub history_size: usize,
    /// Terminal column count when history was recorded (PTY current size)
    pub cols: u16,
    /// Terminal row count when history was recorded (PTY current size)
    pub rows: u16,
}

/// Shell information response
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct ShellInfo {
    /// Stable ID for selecting this exact executable.
    pub id: String,
    /// Shell type
    #[serde(rename = "shellType")]
    pub shell_type: ShellType,
    /// Display name
    pub name: String,
    /// Path to executable
    pub path: String,
    /// Shell version (if detected)
    pub version: Option<String>,
    /// How the executable was discovered.
    #[serde(rename = "discoverySource")]
    pub discovery_source: crate::shell::ShellDiscoverySource,
    /// Whether the shell is available
    pub available: bool,
}

/// Request to execute a command
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct ExecuteCommandRequest {
    /// Session ID
    #[serde(rename = "sessionId")]
    pub session_id: String,
    /// Command to execute
    pub command: String,
    /// Timeout in milliseconds (default: 30000)
    #[serde(rename = "timeoutMs")]
    pub timeout_ms: Option<u64>,
    /// Whether to prevent the command from being added to shell history
    #[serde(rename = "preventHistory")]
    pub prevent_history: Option<bool>,
}

/// Response for command execution
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct ExecuteCommandResponse {
    /// The command that was executed
    pub command: String,
    /// Unique command ID
    #[serde(rename = "commandId")]
    pub command_id: String,
    /// Command output
    pub output: String,
    /// Exit code (if available)
    #[serde(rename = "exitCode")]
    pub exit_code: Option<i32>,
    /// Why command execution stopped.
    #[serde(rename = "completionReason")]
    pub completion_reason: CommandCompletionReason,
}

impl From<CommandExecuteResult> for ExecuteCommandResponse {
    fn from(result: CommandExecuteResult) -> Self {
        Self {
            command: result.command,
            command_id: result.command_id,
            output: result.output,
            exit_code: result.exit_code,
            completion_reason: result.completion_reason,
        }
    }
}

/// Request to send a command without waiting for completion
///
/// Unlike ExecuteCommandRequest, this does NOT require shell integration
/// and does NOT wait for command completion or capture output.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct SendCommandRequest {
    /// Session ID
    #[serde(rename = "sessionId")]
    pub session_id: String,
    /// Command to send
    pub command: String,
}

// ============================================================================
// Terminal API Service
// ============================================================================

/// Terminal API service - main interface for external consumers
pub struct TerminalApi {
    /// Session manager (uses singleton)
    session_manager: Arc<SessionManager>,
}

impl TerminalApi {
    /// Create a new Terminal API instance
    ///
    /// This will initialize the global SessionManager singleton if not already initialized.
    /// If the singleton is already initialized, it will use the existing instance.
    pub async fn new(config: TerminalConfig) -> Self {
        let session_manager = if is_session_manager_initialized() {
            match get_session_manager() {
                Some(manager) => manager,
                None => panic!("SessionManager should be initialized"),
            }
        } else {
            match init_session_manager(config).await {
                Ok(manager) => manager,
                Err(_) => panic!("Failed to initialize SessionManager"),
            }
        };

        Self { session_manager }
    }

    /// Create a Terminal API instance from an existing SessionManager
    pub fn from_manager(session_manager: Arc<SessionManager>) -> Self {
        Self { session_manager }
    }

    /// Create a Terminal API instance using the global singleton
    ///
    /// Returns an error if the singleton has not been initialized.
    pub fn from_singleton() -> TerminalResult<Self> {
        let session_manager = get_session_manager()
            .ok_or_else(|| TerminalError::Session("SessionManager not initialized".to_string()))?;

        Ok(Self { session_manager })
    }

    /// Get available shells
    pub fn get_available_shells(&self) -> Vec<ShellInfo> {
        ShellDetector::detect_available_shells()
            .into_iter()
            .map(|shell| ShellInfo {
                id: shell.id,
                shell_type: shell.shell_type,
                name: shell.display_name,
                path: shell.path.to_string_lossy().to_string(),
                version: shell.version,
                discovery_source: shell.discovery_source,
                available: true,
            })
            .collect()
    }

    /// Create a new terminal session
    pub async fn create_session(
        &self,
        request: CreateSessionRequest,
    ) -> TerminalResult<SessionResponse> {
        let session = self
            .session_manager
            .create_session_with_shell_id(
                request.session_id,
                request.name,
                request.shell_type,
                request.shell_id,
                request.working_directory,
                request.env,
                request.cols,
                request.rows,
                request.source,
            )
            .await?;

        Ok(SessionResponse::from(session))
    }

    /// Get a session by ID
    pub async fn get_session(&self, session_id: &str) -> TerminalResult<SessionResponse> {
        let session = self
            .session_manager
            .get_session(session_id)
            .await
            .ok_or_else(|| TerminalError::SessionNotFound(session_id.to_string()))?;

        Ok(SessionResponse::from(session))
    }

    /// List all sessions
    pub async fn list_sessions(&self) -> TerminalResult<Vec<SessionResponse>> {
        let sessions = self.session_manager.list_sessions().await;

        Ok(sessions.into_iter().map(SessionResponse::from).collect())
    }

    /// Write data to a terminal session
    pub async fn write(&self, request: WriteRequest) -> TerminalResult<()> {
        self.session_manager
            .write(&request.session_id, request.data.as_bytes())
            .await
    }

    /// Resize a terminal session
    pub async fn resize(&self, request: ResizeRequest) -> TerminalResult<()> {
        self.session_manager
            .resize(&request.session_id, request.cols, request.rows)
            .await
    }

    /// Send a signal to a terminal session
    pub async fn signal(&self, request: SignalRequest) -> TerminalResult<()> {
        self.session_manager
            .signal(&request.session_id, &request.signal)
            .await
    }

    /// Close a terminal session
    pub async fn close_session(&self, request: CloseSessionRequest) -> TerminalResult<()> {
        self.session_manager
            .close_session(&request.session_id, request.immediate.unwrap_or(false))
            .await
    }

    /// Acknowledge data received by frontend
    pub async fn acknowledge_data(&self, request: AcknowledgeRequest) -> TerminalResult<()> {
        self.session_manager
            .acknowledge_data(&request.session_id, request.char_count)
            .await
    }

    /// Get output history for a session
    ///
    /// This returns the historical output data that was buffered on the backend.
    /// Useful for recovering terminal state when reconnecting.
    pub async fn get_history(
        &self,
        request: GetHistoryRequest,
    ) -> TerminalResult<GetHistoryResponse> {
        let session = self
            .session_manager
            .get_session(&request.session_id)
            .await
            .ok_or_else(|| TerminalError::SessionNotFound(request.session_id.to_string()))?;

        let data = session.get_history();
        let events = session.get_replay_events();
        let history_size = session.history_size();

        Ok(GetHistoryResponse {
            session_id: request.session_id,
            events,
            data,
            history_size,
            cols: session.cols,
            rows: session.rows,
        })
    }

    /// Execute a command in a session and wait for completion
    ///
    /// This function sends a command to the terminal, waits for it to complete
    /// using shell integration, and returns the output and exit code.
    pub async fn execute_command(
        &self,
        request: ExecuteCommandRequest,
    ) -> TerminalResult<ExecuteCommandResponse> {
        let options = ExecuteOptions {
            timeout: request.timeout_ms.map(Duration::from_millis),
            prevent_history: request.prevent_history.unwrap_or(true),
        };

        let result = self
            .session_manager
            .execute_command_with_options(&request.session_id, &request.command, options)
            .await?;

        Ok(ExecuteCommandResponse::from(result))
    }

    /// Check if a session has shell integration enabled
    pub async fn has_shell_integration(&self, session_id: &str) -> bool {
        self.session_manager.has_shell_integration(session_id).await
    }

    /// Execute a command and return a stream of events for real-time output
    ///
    /// This function provides streaming command execution, allowing callers
    /// to receive output as it arrives rather than waiting for completion.
    pub fn execute_command_stream(&self, request: ExecuteCommandRequest) -> CommandStream {
        let options = ExecuteOptions {
            timeout: request.timeout_ms.map(Duration::from_millis),
            prevent_history: request.prevent_history.unwrap_or(true),
        };

        self.session_manager.execute_command_stream_with_options(
            request.session_id,
            request.command,
            options,
        )
    }

    /// Send a command to a session without waiting for completion
    ///
    /// This function waits for the session to be active, then sends a command
    /// to the terminal. Unlike `execute_command`, it does NOT require shell
    /// integration and does NOT wait for command completion or capture output.
    ///
    /// This is useful for:
    /// - Shells that don't support shell integration (e.g., cmd)
    /// - Startup commands where you don't need the result
    /// - Fire-and-forget command execution
    pub async fn send_command(&self, request: SendCommandRequest) -> TerminalResult<()> {
        self.session_manager
            .send_command(&request.session_id, &request.command)
            .await
    }

    /// Subscribe to raw PTY output of a specific session.
    ///
    /// Returns a receiver that yields raw output strings as they arrive.
    /// The channel closes when the session is destroyed.
    pub fn subscribe_session_output(
        &self,
        session_id: &str,
    ) -> tokio::sync::mpsc::Receiver<std::sync::Arc<str>> {
        self.session_manager.subscribe_session_output(session_id)
    }

    /// Subscribe to terminal events
    pub fn subscribe_events(&self) -> tokio::sync::mpsc::Receiver<TerminalEvent> {
        let (tx, rx) = tokio::sync::mpsc::channel(1024);

        let emitter = self.session_manager.event_emitter();

        // Forward events
        tokio::spawn(async move {
            loop {
                if let Some(event) = emitter.recv().await {
                    if tx.send(event).await.is_err() {
                        break;
                    }
                }
            }
        });

        rx
    }

    /// Shutdown all sessions
    pub async fn shutdown_all(&self) {
        self.session_manager.shutdown_all().await;
    }

    /// Get the underlying session manager
    pub fn session_manager(&self) -> Arc<SessionManager> {
        self.session_manager.clone()
    }
}

// ============================================================================
// Tauri-compatible commands (when used with Tauri)
// ============================================================================

// Module for Tauri command integration
// #[cfg(feature = "tauri")]
// pub mod tauri_commands {
//     use super::*;

//     // Tauri commands would be defined here
//     // They would wrap the TerminalApi methods with #[tauri::command] attribute
// }

// ============================================================================
// WebSocket message types (for WebSocket adapter)
// ============================================================================

/// WebSocket message from client to server
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(tag = "action")]
pub enum WsRequest {
    /// Create session
    CreateSession(CreateSessionRequest),
    /// Write to session
    Write(WriteRequest),
    /// Resize session
    Resize(ResizeRequest),
    /// Send signal
    Signal(SignalRequest),
    /// Close session
    CloseSession(CloseSessionRequest),
    /// Acknowledge data
    Acknowledge(AcknowledgeRequest),
    /// List sessions
    ListSessions,
    /// Get available shells
    GetShells,
}

/// WebSocket message from server to client
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(tag = "type")]
pub enum WsResponse {
    /// Success response
    Success {
        #[serde(skip_serializing_if = "Option::is_none")]
        data: Option<serde_json::Value>,
    },
    /// Error response
    Error {
        message: String,
        #[serde(skip_serializing_if = "Option::is_none")]
        code: Option<String>,
    },
    /// Terminal event
    Event(TerminalEvent),
}

impl WsResponse {
    /// Create a success response
    pub fn success<T: Serialize>(data: T) -> Self {
        WsResponse::Success {
            data: Some(serde_json::to_value(data).unwrap_or(serde_json::Value::Null)),
        }
    }

    /// Create an empty success response
    pub fn ok() -> Self {
        WsResponse::Success { data: None }
    }

    /// Create an error response
    pub fn error(message: impl Into<String>) -> Self {
        WsResponse::Error {
            message: message.into(),
            code: None,
        }
    }

    /// Create an error response with code
    pub fn error_with_code(message: impl Into<String>, code: impl Into<String>) -> Self {
        WsResponse::Error {
            message: message.into(),
            code: Some(code.into()),
        }
    }
}
