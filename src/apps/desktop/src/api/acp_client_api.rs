//! ACP client API

use crate::api::app_state::AppState;
use crate::startup_trace::DesktopStartupTrace;
use openbitfun_acp::client::{
    AcpAvailableCommand, AcpClientInfo, AcpClientPermissionResponse, AcpClientRequirementProbe,
    AcpClientStreamEvent, AcpSessionOptions, CreateAcpFlowSessionRecordResponse,
    SetAcpSessionConfigOptionRequest, SetAcpSessionModelRequest,
    SubmitAcpPermissionResponseRequest,
};
use openbitfun_core::service::workspace::WorkspaceInfo;
use openbitfun_runtime_ports::SessionStorePort;
use serde::{Deserialize, Serialize};
use std::path::PathBuf;
use std::time::Instant;
use tauri::{AppHandle, Emitter, State};

/// Workspace facts an ACP session command executes against, derived from the
/// authoritative workspace record rather than from caller-supplied paths.
struct AcpWorkspaceScope {
    workspace_id: String,
    /// Execution root handed to the ACP client as its cwd (IO operand).
    workspace_path: String,
    remote_connection_id: Option<String>,
    remote_ssh_host: Option<String>,
    session_storage_path: PathBuf,
}

impl AcpWorkspaceScope {
    async fn from_workspace(workspace: WorkspaceInfo) -> Result<Self, String> {
        let session_storage_path =
            openbitfun_core::agentic::session::CoreSessionStorePort::default()
                .resolve_workspace_storage(&workspace.id)
                .await
                .map(|resolution| resolution.effective_storage_path)
                .map_err(|error| error.to_string())?;
        let remote_ssh_host = workspace
            .metadata
            .get("sshHost")
            .and_then(|host| host.as_str())
            .map(str::to_string);
        Ok(Self {
            remote_connection_id: workspace.remote_ssh_connection_id().map(str::to_string),
            remote_ssh_host,
            workspace_path: workspace.root_path.to_string_lossy().into_owned(),
            workspace_id: workspace.id,
            session_storage_path,
        })
    }
}

/// Resolve the workspace an ACP request targets. `workspace_id` is
/// authoritative; the path and SSH fields are consulted only for pre-ID
/// clients and are resolved through the workspace legacy-compat boundary.
async fn resolve_acp_workspace_scope(
    app_state: &AppState,
    workspace_id: Option<&str>,
    workspace_path: Option<&str>,
    remote_connection_id: Option<&str>,
    remote_ssh_host: Option<&str>,
) -> Result<AcpWorkspaceScope, String> {
    let workspace_id = workspace_id.map(str::trim).filter(|id| !id.is_empty());
    let workspace = match workspace_id {
        Some(id) => app_state
            .workspace_service
            .require_workspace(id)
            .await
            .map_err(|error| error.to_string())?,
        None => {
            let path = workspace_path
                .map(str::trim)
                .filter(|path| !path.is_empty())
                .ok_or_else(|| "workspace_id is required for ACP session commands".to_string())?;
            app_state
                .workspace_service
                .resolve_legacy_workspace_reference(
                    None,
                    path,
                    remote_connection_id,
                    remote_ssh_host,
                )
                .await
                .map_err(|error| error.to_string())?
                .ok_or_else(|| "Workspace ID is unavailable".to_string())?
        }
    };
    AcpWorkspaceScope::from_workspace(workspace).await
}

/// Optional variant for session commands whose pre-ID clients may omit every
/// workspace field; those requests keep the ACP service's in-memory session.
async fn resolve_optional_acp_workspace_scope(
    app_state: &AppState,
    workspace_id: Option<&str>,
    workspace_path: Option<&str>,
    remote_connection_id: Option<&str>,
    remote_ssh_host: Option<&str>,
) -> Result<Option<AcpWorkspaceScope>, String> {
    let has_id = workspace_id.map(str::trim).is_some_and(|id| !id.is_empty());
    let has_path = workspace_path
        .map(str::trim)
        .is_some_and(|path| !path.is_empty());
    if !has_id && !has_path {
        return Ok(None);
    }
    resolve_acp_workspace_scope(
        app_state,
        workspace_id,
        workspace_path,
        remote_connection_id,
        remote_ssh_host,
    )
    .await
    .map(Some)
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct AcpClientIdRequest {
    pub client_id: String,
    #[serde(default)]
    pub remote_connection_id: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct CreateAcpFlowSessionRequest {
    pub client_id: String,
    #[serde(default)]
    pub session_name: Option<String>,
    /// Workspace identity; authoritative when present.
    #[serde(default)]
    pub workspace_id: Option<String>,
    /// Legacy execution root for pre-ID clients; the record's root is used otherwise.
    #[serde(default)]
    pub workspace_path: String,
    #[serde(default)]
    pub remote_connection_id: Option<String>,
    #[serde(default)]
    pub remote_ssh_host: Option<String>,
}

pub type CreateAcpFlowSessionResponse = CreateAcpFlowSessionRecordResponse;

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct StartAcpDialogTurnRequest {
    pub session_id: String,
    pub client_id: String,
    pub user_input: String,
    #[serde(default)]
    pub original_user_input: Option<String>,
    pub turn_id: String,
    /// Workspace identity; authoritative when present.
    #[serde(default)]
    pub workspace_id: Option<String>,
    #[serde(default)]
    pub workspace_path: Option<String>,
    #[serde(default)]
    pub remote_connection_id: Option<String>,
    #[serde(default)]
    pub remote_ssh_host: Option<String>,
    #[serde(default)]
    pub timeout_seconds: Option<u64>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct CancelAcpDialogTurnRequest {
    pub session_id: String,
    pub client_id: String,
    /// Workspace identity; authoritative when present.
    #[serde(default)]
    pub workspace_id: Option<String>,
    #[serde(default)]
    pub workspace_path: Option<String>,
    #[serde(default)]
    pub remote_connection_id: Option<String>,
    #[serde(default)]
    pub remote_ssh_host: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct GetAcpSessionOptionsRequest {
    pub session_id: String,
    pub client_id: String,
    /// Workspace identity; authoritative when present.
    #[serde(default)]
    pub workspace_id: Option<String>,
    #[serde(default)]
    pub workspace_path: Option<String>,
    #[serde(default)]
    pub remote_connection_id: Option<String>,
    #[serde(default)]
    pub remote_ssh_host: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize, Default)]
#[serde(rename_all = "camelCase")]
pub struct ProbeAcpClientRequirementsRequest {
    #[serde(default)]
    pub remote_connection_id: Option<String>,
    #[serde(default)]
    pub force_refresh: bool,
}

fn emit_acp_model_round_completed(
    app_handle: &AppHandle,
    session_id: &str,
    turn_id: &str,
    round_id: String,
    has_tool_calls: bool,
) -> Result<(), openbitfun_core::util::errors::OpenBitFunError> {
    app_handle
        .emit(
            "agentic://model-round-completed",
            serde_json::json!({
                "sessionId": session_id,
                "turnId": turn_id,
                "roundId": round_id,
                "hasToolCalls": has_tool_calls,
            }),
        )
        .map_err(|e| openbitfun_core::util::errors::OpenBitFunError::service(e.to_string()))
}

#[tauri::command]
pub async fn initialize_acp_clients(
    state: State<'_, AppState>,
    startup_trace: State<'_, DesktopStartupTrace>,
) -> Result<(), String> {
    let trace_started = Instant::now();
    let result = async {
        let service = state
            .acp_client_service
            .as_ref()
            .ok_or_else(|| "ACP client service not initialized".to_string())?;
        service.initialize_all().await.map_err(|e| e.to_string())
    }
    .await;
    startup_trace.record_tauri_command_elapsed("initialize_acp_clients", None, trace_started);
    result
}

#[tauri::command]
pub async fn get_acp_clients(state: State<'_, AppState>) -> Result<Vec<AcpClientInfo>, String> {
    let service = state
        .acp_client_service
        .as_ref()
        .ok_or_else(|| "ACP client service not initialized".to_string())?;
    service.list_clients().await.map_err(|e| e.to_string())
}

#[tauri::command]
pub async fn probe_acp_client_requirements(
    state: State<'_, AppState>,
    startup_trace: State<'_, DesktopStartupTrace>,
    request: ProbeAcpClientRequirementsRequest,
) -> Result<Vec<AcpClientRequirementProbe>, String> {
    let trace_started = Instant::now();
    let result = async {
        let service = state
            .acp_client_service
            .as_ref()
            .ok_or_else(|| "ACP client service not initialized".to_string())?;
        service
            .probe_client_requirements(
                request.remote_connection_id.as_deref(),
                request.force_refresh,
            )
            .await
            .map_err(|e| e.to_string())
    }
    .await;
    startup_trace.record_tauri_command_elapsed(
        "probe_acp_client_requirements",
        None,
        trace_started,
    );
    result
}

#[tauri::command]
pub async fn predownload_acp_client_adapter(
    state: State<'_, AppState>,
    request: AcpClientIdRequest,
) -> Result<(), String> {
    let service = state
        .acp_client_service
        .as_ref()
        .ok_or_else(|| "ACP client service not initialized".to_string())?;
    service
        .predownload_client_adapter(&request.client_id)
        .await
        .map_err(|e| e.to_string())
}

#[tauri::command]
pub async fn install_acp_client_cli(
    state: State<'_, AppState>,
    request: AcpClientIdRequest,
) -> Result<(), String> {
    let service = state
        .acp_client_service
        .as_ref()
        .ok_or_else(|| "ACP client service not initialized".to_string())?;
    service
        .install_client_cli(&request.client_id, request.remote_connection_id.as_deref())
        .await
        .map_err(|e| e.to_string())
}

#[tauri::command]
pub async fn create_acp_flow_session(
    state: State<'_, AppState>,
    app_handle: AppHandle,
    request: CreateAcpFlowSessionRequest,
) -> Result<CreateAcpFlowSessionResponse, String> {
    let service = state
        .acp_client_service
        .as_ref()
        .ok_or_else(|| "ACP client service not initialized".to_string())?;

    let scope = resolve_acp_workspace_scope(
        &state,
        request.workspace_id.as_deref(),
        Some(&request.workspace_path),
        request.remote_connection_id.as_deref(),
        request.remote_ssh_host.as_deref(),
    )
    .await?;
    let response = service
        .create_flow_session_record(
            &scope.session_storage_path,
            &scope.workspace_id,
            &scope.workspace_path,
            &request.client_id,
            request.session_name,
        )
        .await
        .map_err(|e| e.to_string())?;
    if let Err(error) = service
        .start_client_for_session(
            &request.client_id,
            &response.session_id,
            Some(&scope.workspace_path),
            scope.remote_connection_id.as_deref(),
        )
        .await
    {
        if let Err(cleanup_error) = service
            .delete_flow_session_record(&scope.session_storage_path, &response.session_id)
            .await
        {
            log::warn!(
                "Failed to delete ACP session record after client start failure: session_id={}, error={}",
                response.session_id,
                cleanup_error
            );
        }
        return Err(error.to_string());
    }

    let _ = app_handle.emit(
        "agentic://session-created",
        serde_json::json!({
            "sessionId": response.session_id.clone(),
            "sessionName": response.session_name.clone(),
            "agentType": response.agent_type.clone(),
            "workspaceId": scope.workspace_id,
            "workspacePath": scope.workspace_path,
            "remoteConnectionId": scope.remote_connection_id,
            "remoteSshHost": scope.remote_ssh_host,
        }),
    );

    Ok(response)
}

#[tauri::command]
pub async fn start_acp_dialog_turn(
    state: State<'_, AppState>,
    app_handle: AppHandle,
    request: StartAcpDialogTurnRequest,
) -> Result<(), String> {
    let service = state
        .acp_client_service
        .as_ref()
        .ok_or_else(|| "ACP client service not initialized".to_string())?
        .clone();

    let session_id = request.session_id.clone();
    let turn_id = request.turn_id.clone();
    let user_input = request.user_input.clone();
    let original_user_input = request
        .original_user_input
        .clone()
        .unwrap_or_else(|| request.user_input.clone());
    let scope = resolve_optional_acp_workspace_scope(
        &state,
        request.workspace_id.as_deref(),
        request.workspace_path.as_deref(),
        request.remote_connection_id.as_deref(),
        request.remote_ssh_host.as_deref(),
    )
    .await?;
    let (workspace_path, remote_connection_id, session_storage_path) = match scope {
        Some(scope) => (
            Some(scope.workspace_path),
            scope.remote_connection_id,
            Some(scope.session_storage_path),
        ),
        None => (None, None, None),
    };

    app_handle
        .emit(
            "agentic://dialog-turn-started",
            serde_json::json!({
                "sessionId": session_id,
                "turnId": turn_id,
                "turnIndex": null,
                "userInput": user_input,
                "originalUserInput": original_user_input,
                "userMessageMetadata": null,
                "subagentParentInfo": null,
            }),
        )
        .map_err(|e| e.to_string())?;
    tokio::spawn(async move {
        let mut current_round_id: Option<String> = None;
        let mut current_round_has_tool_calls = false;
        let result = service
            .prompt_agent_stream(
                &request.client_id,
                request.user_input,
                workspace_path,
                remote_connection_id,
                request.session_id.clone(),
                session_storage_path,
                request.timeout_seconds,
                |event| {
                    match event {
                        AcpClientStreamEvent::ModelRoundStarted {
                            round_id,
                            round_index,
                            disable_explore_grouping,
                        } => {
                            if let Some(previous_round_id) = current_round_id.take() {
                                emit_acp_model_round_completed(
                                    &app_handle,
                                    &request.session_id,
                                    &request.turn_id,
                                    previous_round_id,
                                    current_round_has_tool_calls,
                                )?;
                            }
                            current_round_id = Some(round_id.clone());
                            current_round_has_tool_calls = false;
                            app_handle
                                .emit(
                                    "agentic://model-round-started",
                                    serde_json::json!({
                                        "sessionId": request.session_id,
                                        "turnId": request.turn_id,
                                        "roundId": round_id,
                                        "roundIndex": round_index,
                                        "renderHints": {
                                            "disableExploreGrouping": disable_explore_grouping,
                                        },
                                        "subagentParentInfo": null,
                                    }),
                                )
                                .map_err(|e| {
                                    openbitfun_core::util::errors::OpenBitFunError::service(
                                        e.to_string(),
                                    )
                                })?;
                        }
                        AcpClientStreamEvent::AgentText(text) => {
                            let round_id = current_round_id.clone().ok_or_else(|| {
                                openbitfun_core::util::errors::OpenBitFunError::service(
                                    "ACP text arrived before model round start".to_string(),
                                )
                            })?;
                            app_handle
                                .emit(
                                    "agentic://text-chunk",
                                    serde_json::json!({
                                        "sessionId": request.session_id,
                                        "turnId": request.turn_id,
                                        "roundId": round_id,
                                        "text": text,
                                        "subagentParentInfo": null,
                                    }),
                                )
                                .map_err(|e| {
                                    openbitfun_core::util::errors::OpenBitFunError::service(
                                        e.to_string(),
                                    )
                                })?;
                        }
                        AcpClientStreamEvent::AgentThought(text) => {
                            let round_id = current_round_id.clone().ok_or_else(|| {
                                openbitfun_core::util::errors::OpenBitFunError::service(
                                    "ACP thought arrived before model round start".to_string(),
                                )
                            })?;
                            app_handle
                                .emit(
                                    "agentic://text-chunk",
                                    serde_json::json!({
                                        "sessionId": request.session_id,
                                        "turnId": request.turn_id,
                                        "roundId": round_id,
                                        "text": text,
                                        "contentType": "thinking",
                                        "isThinkingEnd": false,
                                        "subagentParentInfo": null,
                                    }),
                                )
                                .map_err(|e| {
                                    openbitfun_core::util::errors::OpenBitFunError::service(
                                        e.to_string(),
                                    )
                                })?;
                        }
                        AcpClientStreamEvent::ToolEvent(tool_event) => {
                            let round_id = current_round_id.clone().ok_or_else(|| {
                                openbitfun_core::util::errors::OpenBitFunError::service(
                                    "ACP tool event arrived before model round start".to_string(),
                                )
                            })?;
                            current_round_has_tool_calls = true;
                            app_handle
                                .emit(
                                    "agentic://tool-event",
                                    serde_json::json!({
                                        "sessionId": request.session_id,
                                        "turnId": request.turn_id,
                                        "roundId": round_id,
                                        "toolEvent": tool_event,
                                        "subagentParentInfo": null,
                                    }),
                                )
                                .map_err(|e| {
                                    openbitfun_core::util::errors::OpenBitFunError::service(
                                        e.to_string(),
                                    )
                                })?;
                        }
                        AcpClientStreamEvent::ContextUsageUpdated(usage) => {
                            app_handle
                                .emit(
                                    "agentic://acp-context-usage-updated",
                                    serde_json::json!({
                                        "sessionId": request.session_id,
                                        "turnId": request.turn_id,
                                        "clientId": request.client_id,
                                        "used": usage.used,
                                        "size": usage.size,
                                        "cost": usage.cost,
                                        "subagentParentInfo": null,
                                    }),
                                )
                                .map_err(|e| {
                                    openbitfun_core::util::errors::OpenBitFunError::service(
                                        e.to_string(),
                                    )
                                })?;
                        }
                        AcpClientStreamEvent::AvailableCommandsUpdated(commands) => {
                            app_handle
                                .emit(
                                    "agentic://acp-available-commands-updated",
                                    serde_json::json!({
                                        "sessionId": request.session_id,
                                        "clientId": request.client_id,
                                        "commands": commands,
                                    }),
                                )
                                .map_err(|e| {
                                    openbitfun_core::util::errors::OpenBitFunError::service(
                                        e.to_string(),
                                    )
                                })?;
                        }
                        AcpClientStreamEvent::PlanUpdated(entries) => {
                            app_handle
                                .emit(
                                    "agentic://acp-plan-updated",
                                    serde_json::json!({
                                        "sessionId": request.session_id,
                                        "turnId": request.turn_id,
                                        "clientId": request.client_id,
                                        "entries": entries,
                                    }),
                                )
                                .map_err(|e| {
                                    openbitfun_core::util::errors::OpenBitFunError::service(
                                        e.to_string(),
                                    )
                                })?;
                        }
                        AcpClientStreamEvent::ConfigOptionsUpdated(_) => {
                            app_handle
                                .emit(
                                    "agentic://acp-session-options-changed",
                                    serde_json::json!({
                                        "sessionId": request.session_id,
                                        "clientId": request.client_id,
                                    }),
                                )
                                .map_err(|e| {
                                    openbitfun_core::util::errors::OpenBitFunError::service(
                                        e.to_string(),
                                    )
                                })?;
                        }
                        AcpClientStreamEvent::Completed => {
                            if let Some(round_id) = current_round_id.take() {
                                emit_acp_model_round_completed(
                                    &app_handle,
                                    &request.session_id,
                                    &request.turn_id,
                                    round_id,
                                    current_round_has_tool_calls,
                                )?;
                            }
                            app_handle
                                .emit(
                                    "agentic://dialog-turn-completed",
                                    serde_json::json!({
                                        "sessionId": request.session_id,
                                        "turnId": request.turn_id,
                                        "subagentParentInfo": null,
                                        "partialRecoveryReason": null,
                                    }),
                                )
                                .map_err(|e| {
                                    openbitfun_core::util::errors::OpenBitFunError::service(
                                        e.to_string(),
                                    )
                                })?;
                        }
                        AcpClientStreamEvent::Cancelled => {
                            if let Some(round_id) = current_round_id.take() {
                                emit_acp_model_round_completed(
                                    &app_handle,
                                    &request.session_id,
                                    &request.turn_id,
                                    round_id,
                                    current_round_has_tool_calls,
                                )?;
                            }
                            app_handle
                                .emit(
                                    "agentic://dialog-turn-cancelled",
                                    serde_json::json!({
                                        "sessionId": request.session_id,
                                        "turnId": request.turn_id,
                                        "subagentParentInfo": null,
                                    }),
                                )
                                .map_err(|e| {
                                    openbitfun_core::util::errors::OpenBitFunError::service(
                                        e.to_string(),
                                    )
                                })?;
                        }
                    }
                    Ok(())
                },
            )
            .await;

        if let Err(error) = result {
            let _ = app_handle.emit(
                "agentic://dialog-turn-failed",
                serde_json::json!({
                    "sessionId": request.session_id,
                    "turnId": request.turn_id,
                    "error": error.to_string(),
                    "errorCategory": null,
                    "errorDetail": null,
                    "subagentParentInfo": null,
                }),
            );
        }
    });

    Ok(())
}

#[tauri::command]
pub async fn cancel_acp_dialog_turn(
    state: State<'_, AppState>,
    request: CancelAcpDialogTurnRequest,
) -> Result<(), String> {
    let service = state
        .acp_client_service
        .as_ref()
        .ok_or_else(|| "ACP client service not initialized".to_string())?;
    let scope = resolve_optional_acp_workspace_scope(
        &state,
        request.workspace_id.as_deref(),
        request.workspace_path.as_deref(),
        request.remote_connection_id.as_deref(),
        request.remote_ssh_host.as_deref(),
    )
    .await?;
    service
        .cancel_agent_session(
            &request.client_id,
            scope.map(|scope| scope.workspace_path),
            request.session_id,
        )
        .await
        .map_err(|e| e.to_string())
}

#[tauri::command]
pub async fn get_acp_session_options(
    state: State<'_, AppState>,
    request: GetAcpSessionOptionsRequest,
) -> Result<AcpSessionOptions, String> {
    let service = state
        .acp_client_service
        .as_ref()
        .ok_or_else(|| "ACP client service not initialized".to_string())?;
    let scope = resolve_optional_acp_workspace_scope(
        &state,
        request.workspace_id.as_deref(),
        request.workspace_path.as_deref(),
        request.remote_connection_id.as_deref(),
        request.remote_ssh_host.as_deref(),
    )
    .await?;
    let (workspace_path, remote_connection_id, session_storage_path) = match scope {
        Some(scope) => (
            Some(scope.workspace_path),
            scope.remote_connection_id,
            Some(scope.session_storage_path),
        ),
        None => (None, None, None),
    };
    service
        .get_session_options(
            &request.client_id,
            workspace_path,
            remote_connection_id,
            session_storage_path,
            request.session_id,
        )
        .await
        .map_err(|e| e.to_string())
}

#[tauri::command]
pub async fn get_acp_session_commands(
    state: State<'_, AppState>,
    request: GetAcpSessionOptionsRequest,
) -> Result<Vec<AcpAvailableCommand>, String> {
    let service = state
        .acp_client_service
        .as_ref()
        .ok_or_else(|| "ACP client service not initialized".to_string())?;
    let scope = resolve_optional_acp_workspace_scope(
        &state,
        request.workspace_id.as_deref(),
        request.workspace_path.as_deref(),
        request.remote_connection_id.as_deref(),
        request.remote_ssh_host.as_deref(),
    )
    .await?;
    let (workspace_path, remote_connection_id, session_storage_path) = match scope {
        Some(scope) => (
            Some(scope.workspace_path),
            scope.remote_connection_id,
            Some(scope.session_storage_path),
        ),
        None => (None, None, None),
    };
    service
        .get_session_commands(
            &request.client_id,
            workspace_path,
            remote_connection_id,
            session_storage_path,
            request.session_id,
        )
        .await
        .map_err(|e| e.to_string())
}

#[tauri::command]
pub async fn set_acp_session_model(
    state: State<'_, AppState>,
    request: SetAcpSessionModelRequest,
) -> Result<AcpSessionOptions, String> {
    let service = state
        .acp_client_service
        .as_ref()
        .ok_or_else(|| "ACP client service not initialized".to_string())?;
    let scope = resolve_optional_acp_workspace_scope(
        &state,
        request.workspace_id.as_deref(),
        request.workspace_path.as_deref(),
        request.remote_connection_id.as_deref(),
        request.remote_ssh_host.as_deref(),
    )
    .await?;
    let mut request = request;
    let session_storage_path = scope.map(|scope| {
        request.workspace_path = Some(scope.workspace_path);
        request.remote_connection_id = scope.remote_connection_id;
        scope.session_storage_path
    });
    service
        .set_session_model(request, session_storage_path)
        .await
        .map_err(|e| e.to_string())
}

#[tauri::command]
pub async fn set_acp_session_config_option(
    state: State<'_, AppState>,
    request: SetAcpSessionConfigOptionRequest,
) -> Result<AcpSessionOptions, String> {
    let service = state
        .acp_client_service
        .as_ref()
        .ok_or_else(|| "ACP client service not initialized".to_string())?;
    let scope = resolve_optional_acp_workspace_scope(
        &state,
        request.workspace_id.as_deref(),
        request.workspace_path.as_deref(),
        request.remote_connection_id.as_deref(),
        request.remote_ssh_host.as_deref(),
    )
    .await?;
    let mut request = request;
    let session_storage_path = scope.map(|scope| {
        request.workspace_path = Some(scope.workspace_path);
        request.remote_connection_id = scope.remote_connection_id;
        scope.session_storage_path
    });
    service
        .set_session_config_option(request, session_storage_path)
        .await
        .map_err(|e| e.to_string())
}

#[tauri::command]
pub async fn stop_acp_client(
    state: State<'_, AppState>,
    request: AcpClientIdRequest,
) -> Result<(), String> {
    let service = state
        .acp_client_service
        .as_ref()
        .ok_or_else(|| "ACP client service not initialized".to_string())?;
    service
        .stop_client(&request.client_id)
        .await
        .map_err(|e| e.to_string())
}

#[tauri::command]
pub async fn load_acp_json_config(state: State<'_, AppState>) -> Result<String, String> {
    let service = state
        .acp_client_service
        .as_ref()
        .ok_or_else(|| "ACP client service not initialized".to_string())?;
    service.load_json_config().await.map_err(|e| e.to_string())
}

#[tauri::command]
pub async fn save_acp_json_config(
    state: State<'_, AppState>,
    json_config: String,
) -> Result<(), String> {
    let service = state
        .acp_client_service
        .as_ref()
        .ok_or_else(|| "ACP client service not initialized".to_string())?;
    service
        .save_json_config(&json_config)
        .await
        .map_err(|e| e.to_string())
}

#[tauri::command]
pub async fn submit_acp_permission_response(
    state: State<'_, AppState>,
    request: SubmitAcpPermissionResponseRequest,
) -> Result<AcpClientPermissionResponse, String> {
    let service = state
        .acp_client_service
        .as_ref()
        .ok_or_else(|| "ACP client service not initialized".to_string())?;
    service
        .submit_permission_response(request)
        .await
        .map_err(|e| e.to_string())
}
