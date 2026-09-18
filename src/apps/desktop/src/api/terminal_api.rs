//! Terminal API

use log::{error, warn};
use serde::{Deserialize, Serialize};
use std::path::PathBuf;
use std::sync::Arc;
use tauri::{AppHandle, Emitter, State};
use tokio::sync::Mutex;

use openbitfun_core::infrastructure::try_get_path_manager_arc;
use openbitfun_core::service::remote_ssh::workspace_state::{
    get_remote_workspace_manager, init_remote_workspace_manager,
};
use openbitfun_core::service::runtime::RuntimeManager;
use openbitfun_core::service::terminal::TerminalEvent;
use openbitfun_core::service::terminal::{
    AcknowledgeRequest as CoreAcknowledgeRequest, CloseSessionRequest as CoreCloseSessionRequest,
    CommandCompletionReason as CoreCommandCompletionReason,
    CreateSessionRequest as CoreCreateSessionRequest,
    ExecuteCommandRequest as CoreExecuteCommandRequest,
    ExecuteCommandResponse as CoreExecuteCommandResponse,
    GetHistoryResponse as CoreGetHistoryResponse, ResizeRequest as CoreResizeRequest,
    SendCommandRequest as CoreSendCommandRequest, SessionResponse as CoreSessionResponse,
    SessionSource as CoreSessionSource, ShellInfo as CoreShellInfo, ShellType,
    SignalRequest as CoreSignalRequest, TerminalApi, TerminalConfig,
    WriteRequest as CoreWriteRequest,
};

use super::app_state::AppState;

pub struct TerminalState {
    api: Arc<Mutex<Option<TerminalApi>>>,
    initialized: Arc<Mutex<bool>>,
}

impl TerminalState {
    pub fn new() -> Self {
        Self {
            api: Arc::new(Mutex::new(None)),
            initialized: Arc::new(Mutex::new(false)),
        }
    }

    pub async fn get_or_init_api(&self) -> Result<TerminalApi, String> {
        let mut initialized = self.initialized.lock().await;
        let mut api_guard = self.api.lock().await;

        if !*initialized {
            let mut config = TerminalConfig::default();

            // Set scripts directory to app data dir: {config_dir}/openbitfun/temp/scripts
            let scripts_dir = Self::get_scripts_dir();
            config.shell_integration.scripts_dir = Some(scripts_dir);

            match try_get_path_manager_arc() {
                Ok(path_manager) => {
                    config.transcript.root_dir =
                        Some(path_manager.user_data_dir().join("terminals"));
                }
                Err(error) => {
                    warn!(
                        "Failed to configure terminal transcript storage; recording is disabled: {}",
                        error
                    );
                }
            }

            // Prepend OpenBitFun-managed runtime dirs to PATH so Bash/Skill commands can
            // run on machines without preinstalled dev tools.
            if let Ok(runtime_manager) = RuntimeManager::new() {
                let current_path = std::env::var("PATH").ok();
                if let Some(merged_path) = runtime_manager.merged_path_env(current_path.as_deref())
                {
                    config.env.insert("PATH".to_string(), merged_path.clone());
                    #[cfg(windows)]
                    {
                        config.env.insert("Path".to_string(), merged_path);
                    }
                }
            }

            let api = TerminalApi::new(config).await;
            *api_guard = Some(api);
            *initialized = true;
        }

        TerminalApi::from_singleton().map_err(|e| format!("Terminal API not initialized: {}", e))
    }

    /// Get the scripts directory path for shell integration
    /// Uses the same path structure as PathManager
    fn get_scripts_dir() -> PathBuf {
        dirs::config_dir()
            .unwrap_or_else(|| PathBuf::from("."))
            .join(openbitfun_core_types::product_identity::data_namespace())
            .join("temp")
            .join("scripts")
    }
}

impl Default for TerminalState {
    fn default() -> Self {
        Self::new()
    }
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct CreateSessionRequest {
    #[serde(default)]
    pub workspace_id: Option<String>,
    pub session_id: Option<String>,
    pub name: Option<String>,
    pub shell_type: Option<String>,
    pub shell_id: Option<String>,
    pub working_directory: Option<String>,
    /// When set, open a remote PTY on this SSH connection without requiring a
    /// registered remote workspace (used by Relay Deploy wizard).
    pub connection_id: Option<String>,
    pub env: Option<std::collections::HashMap<String, String>>,
    pub cols: Option<u16>,
    pub rows: Option<u16>,
    pub source: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SessionResponse {
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub workspace_id: Option<String>,
    pub id: String,
    pub name: String,
    pub shell_type: String,
    pub cwd: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub initial_cwd: Option<String>,
    pub pid: Option<u32>,
    pub status: String,
    pub cols: u16,
    pub rows: u16,
    /// For remote terminals: the SSH connection ID that owns this session.
    /// None/null for local terminals.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub connection_id: Option<String>,
    pub source: String,
}

impl From<CoreSessionResponse> for SessionResponse {
    fn from(resp: CoreSessionResponse) -> Self {
        Self {
            workspace_id: resp.workspace_id,
            id: resp.id,
            name: resp.name,
            shell_type: format!("{:?}", resp.shell_type),
            cwd: resp.cwd,
            initial_cwd: resp.initial_cwd,
            pid: resp.pid,
            status: resp.status,
            cols: resp.cols,
            rows: resp.rows,
            connection_id: None,
            source: format_session_source(&resp.source),
        }
    }
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ShellInfo {
    pub shell_type: String,
    pub name: String,
    pub path: String,
    pub version: Option<String>,
    pub available: bool,
}

impl From<CoreShellInfo> for ShellInfo {
    fn from(info: CoreShellInfo) -> Self {
        Self {
            shell_type: format!("{:?}", info.shell_type),
            name: info.name,
            path: info.path,
            version: info.version,
            available: info.available,
        }
    }
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct WriteRequest {
    pub session_id: String,
    pub data: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ResizeRequest {
    pub session_id: String,
    pub cols: u16,
    pub rows: u16,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct CloseSessionRequest {
    pub session_id: String,
    pub immediate: Option<bool>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SignalRequest {
    pub session_id: String,
    pub signal: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct AcknowledgeRequest {
    pub session_id: String,
    pub char_count: usize,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ExecuteCommandRequest {
    pub session_id: String,
    pub command: String,
    pub timeout_ms: Option<u64>,
    pub prevent_history: Option<bool>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ExecuteCommandResponse {
    pub command: String,
    pub command_id: String,
    pub output: String,
    pub exit_code: Option<i32>,
    pub completion_reason: String,
}

impl From<CoreExecuteCommandResponse> for ExecuteCommandResponse {
    fn from(resp: CoreExecuteCommandResponse) -> Self {
        Self {
            command: resp.command,
            command_id: resp.command_id,
            output: resp.output,
            exit_code: resp.exit_code,
            completion_reason: match resp.completion_reason {
                CoreCommandCompletionReason::Completed => "completed".to_string(),
                CoreCommandCompletionReason::TimedOut => "timedOut".to_string(),
            },
        }
    }
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SendCommandRequest {
    pub session_id: String,
    pub command: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct GetHistoryRequest {
    pub session_id: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct GetHistoryResponse {
    pub session_id: String,
    pub data: String,
    pub history_size: usize,
    pub next_offset: u64,
    pub cursor: u64,
    pub truncated: bool,
    /// PTY column count at the time history was captured.
    pub cols: u16,
    /// PTY row count at the time history was captured.
    pub rows: u16,
}

impl From<CoreGetHistoryResponse> for GetHistoryResponse {
    fn from(resp: CoreGetHistoryResponse) -> Self {
        Self {
            session_id: resp.session_id,
            data: resp.data,
            history_size: resp.history_size,
            next_offset: resp.history_size as u64,
            cursor: resp.history_size as u64,
            truncated: false,
            cols: resp.cols,
            rows: resp.rows,
        }
    }
}

fn parse_shell_type(s: &str) -> Option<ShellType> {
    match s.to_lowercase().as_str() {
        "powershell" => Some(ShellType::PowerShell),
        "powershellcore" | "pwsh" => Some(ShellType::PowerShellCore),
        "cmd" => Some(ShellType::Cmd),
        "bash" => Some(ShellType::Bash),
        "zsh" => Some(ShellType::Zsh),
        "fish" => Some(ShellType::Fish),
        "sh" => Some(ShellType::Sh),
        "ksh" => Some(ShellType::Ksh),
        "csh" | "tcsh" => Some(ShellType::Csh),
        _ => None,
    }
}

fn parse_session_source(source: &str) -> Option<CoreSessionSource> {
    match source.to_lowercase().as_str() {
        "manual" => Some(CoreSessionSource::Manual),
        "agent" => Some(CoreSessionSource::Agent),
        _ => None,
    }
}

fn format_session_source(source: &CoreSessionSource) -> String {
    match source {
        CoreSessionSource::Manual => "manual".to_string(),
        CoreSessionSource::Agent => "agent".to_string(),
    }
}

#[tauri::command]
pub async fn terminal_get_shells(
    state: State<'_, TerminalState>,
) -> Result<Vec<ShellInfo>, String> {
    let api = state.get_or_init_api().await?;
    let shells = api.get_available_shells();

    Ok(shells.into_iter().map(ShellInfo::from).collect())
}

/// Try to find session in remote terminal manager. Returns true if found.
async fn is_remote_session(session_id: &str) -> bool {
    if let Some(manager) = get_remote_workspace_manager() {
        if let Some(terminal_manager) = manager.get_terminal_manager().await {
            return terminal_manager.get_session(session_id).await.is_some();
        }
    }
    false
}

/// Coalesce PTY notifications; terminal bytes remain in the owning replay buffer.
fn notify_terminal_replay(session_id: &str) {
    use std::{
        collections::HashSet,
        sync::{Mutex as StdMutex, OnceLock},
    };
    static PENDING: OnceLock<(StdMutex<HashSet<String>>, tokio::sync::Notify)> = OnceLock::new();
    let pending =
        PENDING.get_or_init(|| (StdMutex::new(HashSet::new()), tokio::sync::Notify::new()));
    static WORKER: std::sync::Once = std::sync::Once::new();
    WORKER.call_once(|| {
        tokio::spawn(async {
            loop {
                let pending = PENDING
                    .get()
                    .expect("Terminal notification state initialized");
                pending.1.notified().await;
                tokio::time::sleep(std::time::Duration::from_millis(75)).await;
                let ids: Vec<_> = pending
                    .0
                    .lock()
                    .unwrap_or_else(|e| e.into_inner())
                    .drain()
                    .collect();
                let Some(hub) = super::remote_connect_api::host_stream_hub().await else {
                    continue;
                };
                for id in ids {
                    let mut cursor = None;
                    if let Some(state) = get_remote_workspace_manager() {
                        if let Some(manager) = state.get_terminal_manager().await {
                            cursor = manager.replay_cursor(&id).await;
                        }
                    }
                    if cursor.is_none() {
                        if let Ok(api) = TerminalApi::from_singleton() {
                            cursor = api.session_manager().replay_cursor(&id).await;
                        }
                    }
                    if let Err(error) = hub
                        .append(
                            format!("terminal-{id}"),
                            "terminal-output".into(),
                            serde_json::json!({"terminal_id":id,"cursor":cursor}),
                        )
                        .await
                    {
                        warn!("Failed to publish terminal stream notification: {}", error);
                    }
                }
            }
        });
    });
    pending
        .0
        .lock()
        .unwrap_or_else(|e| e.into_inner())
        .insert(session_id.to_string());
    pending.1.notify_one();
}

async fn register_terminal_stream(id: &str) -> Result<(), String> {
    if let Some(hub) = super::remote_connect_api::host_stream_hub().await {
        hub.append(
            format!("terminal-{id}"),
            "terminal-created".into(),
            serde_json::json!({"terminal_id":id}),
        )
        .await
        .map_err(|e| e.to_string())?;
    }
    Ok(())
}

fn emit_terminal_event(app_handle: &AppHandle, event: &TerminalEvent) -> bool {
    if let TerminalEvent::Data { session_id, .. } | TerminalEvent::Exit { session_id, .. } = event {
        notify_terminal_replay(session_id);
    }
    let event_name = "terminal_event";
    let local_emit_succeeded = match app_handle.emit(event_name, event) {
        Ok(()) => true,
        Err(error) => {
            warn!("Failed to emit terminal event: {}", error);
            false
        }
    };
    // Only serialize the event for peer fanout when it will actually be sent.
    if super::remote_connect_api::peer_ui_event_fanout_active(event_name) {
        if let Ok(payload) = serde_json::to_value(event) {
            super::remote_connect_api::maybe_fanout_peer_ui_event(event_name, payload);
        }
    }
    local_emit_succeeded
}

fn remote_terminal_signal_bytes(signal: &str) -> Option<&'static [u8]> {
    match signal.trim().to_ascii_uppercase().as_str() {
        "SIGINT" | "INT" => Some(&[0x03]),
        "SIGTSTP" | "TSTP" => Some(&[0x1a]),
        _ => None,
    }
}

async fn spawn_remote_pty_session(
    app: &AppHandle,
    terminal_manager: &openbitfun_core::service::remote_ssh::RemoteTerminalManager,
    connection_id: &str,
    request: &CreateSessionRequest,
    initial_cwd: Option<&str>,
) -> Result<SessionResponse, String> {
    let result = terminal_manager
        .create_session(
            request.session_id.clone(),
            request.name.clone(),
            connection_id,
            request.cols.unwrap_or(80),
            request.rows.unwrap_or(24),
            initial_cwd,
            request.source.as_deref().and_then(parse_session_source),
        )
        .await
        .map_err(|e| format!("Failed to create remote session: {}", e))?;

    let mut session = result.session;
    terminal_manager
        .set_workspace_id(&session.id, request.workspace_id.clone())
        .await;
    session.workspace_id = request.workspace_id.clone();
    let mut rx = result.output_rx;
    let session_id = session.id.clone();

    let response = SessionResponse {
        workspace_id: session.workspace_id,
        id: session.id,
        name: session.name,
        shell_type: "Remote".to_string(),
        cwd: session.cwd.clone(),
        initial_cwd: Some(session.cwd.clone()),
        pid: session.pid,
        status: format!("{:?}", session.status),
        cols: session.cols,
        rows: session.rows,
        connection_id: Some(connection_id.to_string()),
        source: format_session_source(&session.source),
    };

    let app_handle = app.clone();
    let sid = session_id.clone();
    tokio::spawn(async move {
        emit_terminal_event(
            &app_handle,
            &TerminalEvent::Ready {
                session_id: sid.clone(),
                pid: 0,
                cwd: String::new(),
            },
        );

        loop {
            match rx.recv().await {
                Ok(data) => {
                    let text = String::from_utf8_lossy(&data).to_string();
                    if !emit_terminal_event(
                        &app_handle,
                        &TerminalEvent::Data {
                            session_id: sid.clone(),
                            data: text,
                        },
                    ) {
                        break;
                    }
                }
                Err(tokio::sync::broadcast::error::RecvError::Lagged(n)) => {
                    warn!(
                        "Remote terminal output lagged, skipped {} messages: session_id={}",
                        n, sid
                    );
                    continue;
                }
                Err(tokio::sync::broadcast::error::RecvError::Closed) => {
                    break;
                }
            }
        }

        emit_terminal_event(
            &app_handle,
            &TerminalEvent::Exit {
                session_id: sid,
                exit_code: Some(0),
            },
        );
    });

    register_terminal_stream(&session_id).await?;
    Ok(response)
}

#[tauri::command]
pub async fn terminal_create(
    _app: AppHandle,
    mut request: CreateSessionRequest,
    state: State<'_, TerminalState>,
    app_state: State<'_, AppState>,
) -> Result<SessionResponse, String> {
    if let Some(id) = request.workspace_id.as_deref() {
        let service = openbitfun_core::service::workspace::get_global_workspace_service()
            .ok_or("Workspace service is unavailable")?;
        let workspace = service
            .require_workspace(id)
            .await
            .map_err(|e| e.to_string())?;
        request.connection_id = match workspace.workspace_kind {
            openbitfun_core::service::workspace::WorkspaceKind::Remote => Some(
                workspace
                    .remote_ssh_connection_id()
                    .ok_or("Remote workspace is missing its saved SSH connection ID")?
                    .to_owned(),
            ),
            _ => Some(String::new()),
        };
        request
            .working_directory
            .get_or_insert_with(|| workspace.root_path.to_string_lossy().into_owned());
    } else if request.connection_id.is_none() {
        // Upgrade-only pre-ID terminal payload. Never infer a target from cwd.
        let service = openbitfun_core::service::workspace::get_global_workspace_service()
            .ok_or("Workspace service is unavailable")?;
        let workspace = service
            .resolve_legacy_workspace_reference(
                None,
                request.working_directory.as_deref().unwrap_or_default(),
                None,
                None,
            )
            .await
            .map_err(|e| e.to_string())?
            .ok_or("Terminal workspace ID is unavailable")?;
        request.workspace_id = Some(workspace.id.clone());
        request.connection_id = match workspace.workspace_kind {
            openbitfun_core::service::workspace::WorkspaceKind::Remote => Some(
                workspace
                    .remote_ssh_connection_id()
                    .ok_or("Remote workspace is missing its saved SSH connection ID")?
                    .to_owned(),
            ),
            _ => Some(String::new()),
        };
    }
    // Explicit SSH connection (Relay Deploy wizard) — no remote workspace required.
    // Register AppState's RemoteTerminalManager onto the global workspace manager so
    // subsequent terminal_get/write/resize/close look up the same session store.
    if let Some(connection_id) = request
        .connection_id
        .as_deref()
        .map(str::trim)
        .filter(|s| !s.is_empty())
    {
        let ssh = app_state.get_ssh_manager_async().await?;
        if !ssh
            .get_saved_connections()
            .await
            .iter()
            .any(|profile| profile.id == connection_id)
        {
            return Err("Remote terminal requires a connection saved on this host".into());
        }
        let terminal_manager = app_state
            .get_remote_terminal_manager_async()
            .await
            .map_err(|e| e.to_string())?;
        let workspace_manager = init_remote_workspace_manager();
        if let Ok(ssh) = app_state.get_ssh_manager_async().await {
            terminal_manager.set_ssh_manager(ssh.clone()).await;
            workspace_manager.set_ssh_manager(ssh).await;
        }
        workspace_manager
            .set_terminal_manager(terminal_manager.clone())
            .await;
        let initial_cwd = request.working_directory.as_deref();
        return spawn_remote_pty_session(
            &_app,
            &terminal_manager,
            connection_id,
            &request,
            initial_cwd,
        )
        .await;
    }

    let api = state.get_or_init_api().await?;

    let parsed_shell_type = request.shell_type.and_then(|s| parse_shell_type(&s));
    let core_request = CoreCreateSessionRequest {
        session_id: request.session_id,
        name: request.name,
        shell_type: parsed_shell_type,
        shell_id: request.shell_id,
        working_directory: request.working_directory,
        env: request.env,
        cols: request.cols,
        rows: request.rows,
        remote_connection_id: None,
        source: request.source.as_deref().and_then(parse_session_source),
    };

    let session = api
        .create_session(core_request)
        .await
        .map_err(|e| format!("Failed to create session: {}", e))?;

    let mut session = session;
    if let Some(workspace_id) = request.workspace_id {
        api.session_manager()
            .set_owner(
                &session.id,
                openbitfun_core::service::terminal::session::SessionOwner {
                    id: workspace_id.clone(),
                    owner_type: openbitfun_core::service::terminal::session::OwnerType::Workspace,
                },
            )
            .await
            .map_err(|e| e.to_string())?;
        session.workspace_id = Some(workspace_id);
    }
    register_terminal_stream(&session.id).await?;
    Ok(SessionResponse::from(session))
}

#[tauri::command]
pub async fn terminal_get(
    session_id: String,
    state: State<'_, TerminalState>,
) -> Result<SessionResponse, String> {
    // Try remote first (by session_id lookup, not global flag)
    if let Some(remote_manager) = get_remote_workspace_manager() {
        if let Some(terminal_manager) = remote_manager.get_terminal_manager().await {
            if let Some(session) = terminal_manager.get_session(&session_id).await {
                return Ok(SessionResponse {
                    workspace_id: session.workspace_id,
                    id: session.id,
                    name: session.name,
                    shell_type: "Remote".to_string(),
                    initial_cwd: Some(session.cwd.clone()),
                    cwd: session.cwd,
                    pid: session.pid,
                    status: format!("{:?}", session.status),
                    cols: session.cols,
                    rows: session.rows,
                    connection_id: Some(session.connection_id),
                    source: format_session_source(&session.source),
                });
            }
        }
    }

    let api = state.get_or_init_api().await?;

    let session = api
        .get_session(&session_id)
        .await
        .map_err(|e| format!("Failed to get session: {}", e))?;

    Ok(SessionResponse::from(session))
}

#[tauri::command]
pub async fn terminal_list(
    state: State<'_, TerminalState>,
) -> Result<Vec<SessionResponse>, String> {
    let mut all_sessions: Vec<SessionResponse> = Vec::new();

    // Collect remote sessions
    if let Some(remote_manager) = get_remote_workspace_manager() {
        if let Some(terminal_manager) = remote_manager.get_terminal_manager().await {
            let remote_sessions = terminal_manager.list_sessions().await;
            all_sessions.extend(remote_sessions.into_iter().map(|s| SessionResponse {
                workspace_id: s.workspace_id,
                id: s.id,
                name: s.name,
                shell_type: "Remote".to_string(),
                initial_cwd: Some(s.cwd.clone()),
                cwd: s.cwd,
                pid: s.pid,
                status: format!("{:?}", s.status),
                cols: s.cols,
                rows: s.rows,
                connection_id: Some(s.connection_id),
                source: format_session_source(&s.source),
            }));
        }
    }

    // Collect local sessions
    let api = state.get_or_init_api().await?;
    let local_sessions = api
        .list_sessions()
        .await
        .map_err(|e| format!("Failed to list sessions: {}", e))?;
    all_sessions.extend(local_sessions.into_iter().map(SessionResponse::from));

    Ok(all_sessions)
}

#[tauri::command]
pub async fn terminal_close(
    request: CloseSessionRequest,
    state: State<'_, TerminalState>,
) -> Result<(), String> {
    if is_remote_session(&request.session_id).await {
        if let Some(remote_manager) = get_remote_workspace_manager() {
            let terminal_manager = remote_manager
                .get_terminal_manager()
                .await
                .ok_or("Remote terminal manager not available")?;

            terminal_manager
                .close_session(&request.session_id)
                .await
                .map_err(|e| format!("Failed to close session: {}", e))?;

            return Ok(());
        }
    }

    let api = state.get_or_init_api().await?;

    let core_request = CoreCloseSessionRequest {
        session_id: request.session_id.clone(),
        immediate: request.immediate,
    };

    api.close_session(core_request)
        .await
        .map_err(|e| format!("Failed to close session: {}", e))?;

    Ok(())
}

#[tauri::command]
pub async fn terminal_write(
    request: WriteRequest,
    state: State<'_, TerminalState>,
) -> Result<(), String> {
    if is_remote_session(&request.session_id).await {
        if let Some(remote_manager) = get_remote_workspace_manager() {
            let terminal_manager = remote_manager
                .get_terminal_manager()
                .await
                .ok_or("Remote terminal manager not available")?;

            terminal_manager
                .write(&request.session_id, request.data.as_bytes())
                .await
                .map_err(|e| format!("Failed to write: {}", e))?;

            return Ok(());
        }
    }

    let api = state.get_or_init_api().await?;

    let core_request = CoreWriteRequest {
        session_id: request.session_id,
        data: request.data,
    };

    api.write(core_request)
        .await
        .map_err(|e| format!("Failed to write: {}", e))?;

    Ok(())
}

#[tauri::command]
pub async fn terminal_resize(
    request: ResizeRequest,
    state: State<'_, TerminalState>,
) -> Result<(), String> {
    if is_remote_session(&request.session_id).await {
        if let Some(remote_manager) = get_remote_workspace_manager() {
            let terminal_manager = remote_manager
                .get_terminal_manager()
                .await
                .ok_or("Remote terminal manager not available")?;

            terminal_manager
                .resize(&request.session_id, request.cols, request.rows)
                .await
                .map_err(|e| format!("Failed to resize: {}", e))?;

            return Ok(());
        }
    }

    let api = state.get_or_init_api().await?;

    let core_request = CoreResizeRequest {
        session_id: request.session_id,
        cols: request.cols,
        rows: request.rows,
    };

    api.resize(core_request)
        .await
        .map_err(|e| format!("Failed to resize: {}", e))?;

    Ok(())
}

#[tauri::command]
pub async fn terminal_signal(
    request: SignalRequest,
    state: State<'_, TerminalState>,
) -> Result<(), String> {
    if is_remote_session(&request.session_id).await {
        let signal_data = remote_terminal_signal_bytes(&request.signal).ok_or_else(|| {
            format!(
                "Unsupported remote terminal signal: {}",
                request.signal.trim()
            )
        })?;
        let remote_manager =
            get_remote_workspace_manager().ok_or("Remote workspace manager not available")?;
        let terminal_manager = remote_manager
            .get_terminal_manager()
            .await
            .ok_or("Remote terminal manager not available")?;
        terminal_manager
            .write(&request.session_id, signal_data)
            .await
            .map_err(|e| format!("Failed to send remote terminal signal: {}", e))?;
        return Ok(());
    }

    let api = state.get_or_init_api().await?;

    let core_request = CoreSignalRequest {
        session_id: request.session_id,
        signal: request.signal,
    };

    api.signal(core_request)
        .await
        .map_err(|e| format!("Failed to send signal: {}", e))?;

    Ok(())
}

#[tauri::command]
pub async fn terminal_ack(
    request: AcknowledgeRequest,
    state: State<'_, TerminalState>,
) -> Result<(), String> {
    if is_remote_session(&request.session_id).await {
        // Remote terminals don't use flow control ack
        return Ok(());
    }

    let api = state.get_or_init_api().await?;

    let core_request = CoreAcknowledgeRequest {
        session_id: request.session_id,
        char_count: request.char_count,
    };

    api.acknowledge_data(core_request)
        .await
        .map_err(|e| format!("Failed to acknowledge data: {}", e))?;

    Ok(())
}

#[tauri::command]
pub async fn terminal_execute(
    request: ExecuteCommandRequest,
    state: State<'_, TerminalState>,
) -> Result<ExecuteCommandResponse, String> {
    if is_remote_session(&request.session_id).await {
        if let Some(remote_manager) = get_remote_workspace_manager() {
            let terminal_manager = remote_manager
                .get_terminal_manager()
                .await
                .ok_or("Remote terminal manager not available")?;
            let result = terminal_manager
                .execute(&request.session_id, &request.command, request.timeout_ms)
                .await
                .map_err(|e| e.to_string())?;
            return Ok(ExecuteCommandResponse::from(result));
        }
    }

    let api = state.get_or_init_api().await?;

    let core_request = CoreExecuteCommandRequest {
        session_id: request.session_id,
        command: request.command,
        timeout_ms: request.timeout_ms,
        prevent_history: request.prevent_history,
    };

    let result = api
        .execute_command(core_request)
        .await
        .map_err(|e| format!("Failed to execute command: {}", e))?;

    Ok(ExecuteCommandResponse::from(result))
}

#[tauri::command]
pub async fn terminal_send_command(
    request: SendCommandRequest,
    state: State<'_, TerminalState>,
) -> Result<(), String> {
    if is_remote_session(&request.session_id).await {
        if let Some(remote_manager) = get_remote_workspace_manager() {
            let terminal_manager = remote_manager
                .get_terminal_manager()
                .await
                .ok_or("Remote terminal manager not available")?;

            terminal_manager
                .write(
                    &request.session_id,
                    format!("{}\n", request.command).as_bytes(),
                )
                .await
                .map_err(|e| format!("Failed to send command: {}", e))?;

            return Ok(());
        }
    }

    let api = state.get_or_init_api().await?;

    let core_request = CoreSendCommandRequest {
        session_id: request.session_id,
        command: request.command,
    };

    api.send_command(core_request)
        .await
        .map_err(|e| format!("Failed to send command: {}", e))?;

    Ok(())
}

#[tauri::command]
pub async fn terminal_has_shell_integration(
    session_id: String,
    state: State<'_, TerminalState>,
) -> Result<bool, String> {
    if is_remote_session(&session_id).await {
        return Ok(false);
    }

    let api = state.get_or_init_api().await?;
    Ok(api.has_shell_integration(&session_id).await)
}

/// Shuts down every PTY this desktop owns, on the controller and on any connected SSH host.
///
/// Remote sessions live in the remote terminal manager, so stopping only the local API would leave
/// shells running on the host after the caller was told everything was shut down.
#[tauri::command]
pub async fn terminal_shutdown_all(state: State<'_, TerminalState>) -> Result<(), String> {
    if let Some(remote_manager) = get_remote_workspace_manager() {
        if let Some(terminal_manager) = remote_manager.get_terminal_manager().await {
            for session in terminal_manager.list_sessions().await {
                if let Err(error) = terminal_manager.close_session(&session.id).await {
                    warn!(
                        "Failed to close remote terminal session during shutdown_all: session_id={}, error={}",
                        session.id, error
                    );
                }
            }
        }
    }

    let api = state.get_or_init_api().await?;
    api.shutdown_all().await;

    Ok(())
}

#[tauri::command]
pub async fn terminal_get_history(
    session_id: String,
    after_offset: Option<u64>,
    state: State<'_, TerminalState>,
) -> Result<GetHistoryResponse, String> {
    let after = after_offset.unwrap_or(0);
    let limit = if after_offset.is_some() {
        64 * 1024
    } else {
        usize::MAX
    };
    let mut page = None;
    if let Some(manager) = get_remote_workspace_manager() {
        if let Some(remote) = manager.get_terminal_manager().await {
            page = remote.replay_page(&session_id, after, limit).await;
        }
    }
    let page = if let Some(page) = page {
        page
    } else {
        state
            .get_or_init_api()
            .await?
            .session_manager()
            .replay_page(&session_id, after, limit)
            .await
            .ok_or("Terminal session is unavailable")?
    };
    Ok(GetHistoryResponse {
        session_id,
        data: page.data,
        history_size: page.history_size,
        next_offset: page.next_offset,
        cursor: page.cursor,
        truncated: page.truncated,
        cols: page.cols,
        rows: page.rows,
    })
}

pub fn start_terminal_event_loop(terminal_state: TerminalState, app_handle: AppHandle) {
    tokio::spawn(async move {
        let api = match terminal_state.get_or_init_api().await {
            Ok(api) => api,
            Err(e) => {
                error!("Failed to start terminal event loop: {}", e);
                return;
            }
        };

        let mut rx = api.subscribe_events();

        while let Some(event) = rx.recv().await {
            emit_terminal_event(&app_handle, &event);
        }
    });
}

#[cfg(test)]
mod tests {
    use super::remote_terminal_signal_bytes;

    #[test]
    fn maps_supported_remote_terminal_signals_to_control_bytes() {
        assert_eq!(remote_terminal_signal_bytes("SIGINT"), Some(&[0x03][..]));
        assert_eq!(remote_terminal_signal_bytes("int"), Some(&[0x03][..]));
        assert_eq!(remote_terminal_signal_bytes("SIGTSTP"), Some(&[0x1a][..]));
        assert_eq!(remote_terminal_signal_bytes("tstp"), Some(&[0x1a][..]));
        assert_eq!(remote_terminal_signal_bytes("SIGTERM"), None);
    }
}
