//! Session persistence API

use crate::api::app_state::AppState;
use crate::runtime::{
    DesktopRuntimeContext, DesktopSessionApplicationError, DesktopSessionScopeRequest,
    UiSessionMetadataField,
};
use crate::startup_trace::DesktopStartupTrace;
use openbitfun_agent_runtime::sdk::AgentSessionLineageSnapshot;
use openbitfun_core::agentic::coordination::get_global_scheduler;
use openbitfun_core::agentic::persistence::{SessionBranchResult, SessionMetadataPage};
use openbitfun_core::service::remote_ssh::normalize_remote_workspace_path;
use openbitfun_core::service::session::{
    DialogTurnData, SessionKind, SessionMetadata, SessionStatus, SessionTranscriptExport,
    SessionTranscriptExportOptions,
};
use openbitfun_core::service::session_usage::SessionUsageReport;
use openbitfun_core::service::workspace::WorkspaceKind;
use openbitfun_product_domains::product_search::{
    SessionContentSearchRequest, SessionContentSearchResponse,
};
use serde::{Deserialize, Serialize};
use std::time::Instant;
use tauri::State;

fn desktop_session_scope(
    workspace_id: Option<String>,
    workspace_path: String,
    remote_connection_id: Option<String>,
    remote_ssh_host: Option<String>,
) -> DesktopSessionScopeRequest {
    DesktopSessionScopeRequest {
        workspace_id,
        workspace_path,
        remote_connection_id,
        remote_ssh_host,
    }
}

fn desktop_session_error(error: DesktopSessionApplicationError) -> String {
    error.to_string()
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct ListPersistedSessionsRequest {
    #[serde(default)]
    pub workspace_id: Option<String>,
    #[serde(default)]
    pub workspace_path: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub remote_connection_id: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub remote_ssh_host: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct ListPersistedSessionsPageRequest {
    #[serde(default)]
    pub workspace_id: Option<String>,
    #[serde(default)]
    pub workspace_path: String,
    pub limit: usize,
    /// Optional compact status batch; omitted by older clients.
    #[serde(default, alias = "sessionIds")]
    pub session_ids: Option<Vec<String>>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub cursor: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub remote_connection_id: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub remote_ssh_host: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct GetSessionLineageRequest {
    pub session_id: String,
    #[serde(default)]
    pub workspace_id: Option<String>,
    #[serde(default)]
    pub workspace_path: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub remote_connection_id: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub remote_ssh_host: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct LoadSessionTurnsRequest {
    pub session_id: String,
    #[serde(default)]
    pub workspace_id: Option<String>,
    #[serde(default)]
    pub workspace_path: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub remote_connection_id: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub remote_ssh_host: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub limit: Option<usize>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct SaveSessionTurnRequest {
    pub turn_data: DialogTurnData,
    #[serde(default)]
    pub workspace_id: Option<String>,
    #[serde(default)]
    pub workspace_path: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub remote_connection_id: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub remote_ssh_host: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct SaveSessionMetadataRequest {
    pub metadata: SessionMetadata,
    pub fields: Vec<UiSessionMetadataField>,
    #[serde(default)]
    pub workspace_id: Option<String>,
    #[serde(default)]
    pub workspace_path: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub remote_connection_id: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub remote_ssh_host: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct ExportSessionTranscriptRequest {
    pub session_id: String,
    #[serde(default)]
    pub workspace_id: Option<String>,
    #[serde(default)]
    pub workspace_path: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub remote_connection_id: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub remote_ssh_host: Option<String>,
    #[serde(default = "default_tools")]
    pub tools: bool,
    #[serde(default)]
    pub tool_inputs: bool,
    #[serde(default)]
    pub thinking: bool,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub turns: Option<Vec<String>>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct SearchReferenceableSessionsRequest {
    pub query: String,
    #[serde(default = "default_session_reference_search_limit")]
    pub limit: usize,
}

fn default_session_reference_search_limit() -> usize {
    30
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SessionReferenceCandidate {
    pub session_id: String,
    pub session_name: String,
    /// Owning workspace ID; the reference identity the composer sends back.
    pub workspace_id: String,
    /// Display/IO projection of the owning workspace root.
    pub workspace_path: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub remote_connection_id: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub remote_ssh_host: Option<String>,
    pub workspace_label: String,
    pub last_activity_at: u64,
}

fn default_tools() -> bool {
    false
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct DeletePersistedSessionRequest {
    pub session_id: String,
    #[serde(default)]
    pub workspace_id: Option<String>,
    #[serde(default)]
    pub workspace_path: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub remote_connection_id: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub remote_ssh_host: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct TouchSessionActivityRequest {
    pub session_id: String,
    #[serde(default)]
    pub workspace_id: Option<String>,
    #[serde(default)]
    pub workspace_path: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub remote_connection_id: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub remote_ssh_host: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct LoadPersistedSessionMetadataRequest {
    pub session_id: String,
    #[serde(default)]
    pub workspace_id: Option<String>,
    #[serde(default)]
    pub workspace_path: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub remote_connection_id: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub remote_ssh_host: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct GetSessionUsageReportRequest {
    pub session_id: String,
    #[serde(default)]
    pub workspace_id: Option<String>,
    #[serde(default)]
    pub workspace_path: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub remote_connection_id: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub remote_ssh_host: Option<String>,
    #[serde(default = "default_include_hidden_subagents")]
    pub include_hidden_subagents: bool,
}

fn default_include_hidden_subagents() -> bool {
    true
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct ForkSessionRequest {
    pub source_session_id: String,
    pub source_turn_id: String,
    #[serde(default)]
    pub workspace_id: Option<String>,
    #[serde(default)]
    pub workspace_path: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub remote_connection_id: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub remote_ssh_host: Option<String>,
}

pub type ForkSessionResponse = SessionBranchResult;

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct ArchiveSessionRequest {
    pub session_id: String,
    #[serde(default)]
    pub workspace_id: Option<String>,
    #[serde(default)]
    pub workspace_path: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub remote_connection_id: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub remote_ssh_host: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct UnarchiveSessionRequest {
    pub session_id: String,
    #[serde(default)]
    pub workspace_id: Option<String>,
    #[serde(default)]
    pub workspace_path: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub remote_connection_id: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub remote_ssh_host: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct ArchiveAllSessionsRequest {
    #[serde(default)]
    pub workspace_id: Option<String>,
    #[serde(default)]
    pub workspace_path: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub remote_connection_id: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub remote_ssh_host: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct DeleteAllArchivedSessionsRequest {
    #[serde(default)]
    pub workspace_id: Option<String>,
    #[serde(default)]
    pub workspace_path: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub remote_connection_id: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub remote_ssh_host: Option<String>,
}

#[tauri::command]
pub async fn list_persisted_sessions(
    request: ListPersistedSessionsRequest,
    runtime: State<'_, DesktopRuntimeContext>,
) -> Result<Vec<SessionMetadata>, String> {
    runtime
        .session_application()
        .list_persisted_sessions(desktop_session_scope(
            request.workspace_id,
            request.workspace_path,
            request.remote_connection_id,
            request.remote_ssh_host,
        ))
        .await
        .map_err(|error| {
            format!(
                "Failed to list persisted sessions: {}",
                desktop_session_error(error)
            )
        })
}

#[tauri::command]
pub async fn search_session_content(
    request: SessionContentSearchRequest,
    runtime: State<'_, DesktopRuntimeContext>,
) -> Result<SessionContentSearchResponse, String> {
    let limit = request.normalized_limit();
    runtime
        .session_application()
        .search_session_content(
            desktop_session_scope(
                request.workspace_id,
                request.workspace_path,
                request.remote_connection_id,
                request.remote_ssh_host,
            ),
            &request.query,
            limit,
            request.include_archived,
        )
        .await
        .map_err(|error| {
            format!(
                "Failed to search persisted session content: {}",
                desktop_session_error(error)
            )
        })
}

/// Search lightweight persisted metadata across open local and SSH
/// workspaces. This deliberately never loads dialog turns or generates a
/// transcript; that work happens only when the selected message is dispatched.
#[tauri::command]
pub async fn search_referenceable_sessions(
    request: SearchReferenceableSessionsRequest,
    runtime: State<'_, DesktopRuntimeContext>,
    app_state: State<'_, AppState>,
) -> Result<Vec<SessionReferenceCandidate>, String> {
    let query = request.query.trim().to_lowercase();
    if query.is_empty() {
        return Ok(Vec::new());
    }
    let limit = request.limit.clamp(1, 30);
    let scheduler = get_global_scheduler();
    let mut workspaces = app_state.workspace_service.get_opened_workspaces().await;
    workspaces.sort_by_key(|workspace| std::cmp::Reverse(workspace.last_accessed));

    let mut candidates = Vec::new();
    for workspace in workspaces {
        let remote_connection_id = workspace.remote_ssh_connection_id().map(ToOwned::to_owned);
        let remote_ssh_host = workspace
            .metadata
            .get("sshHost")
            .and_then(|value| value.as_str())
            .map(str::trim)
            .filter(|value| !value.is_empty())
            .map(str::to_string);
        let workspace_path = if workspace.workspace_kind == WorkspaceKind::Remote {
            normalize_remote_workspace_path(&workspace.root_path.to_string_lossy())
        } else {
            workspace.root_path.to_string_lossy().to_string()
        };
        let metadata = runtime
            .session_application()
            .list_persisted_sessions(desktop_session_scope(
                Some(workspace.id.clone()),
                workspace_path.clone(),
                remote_connection_id.clone(),
                remote_ssh_host.clone(),
            ))
            .await
            .map_err(|error| {
                format!(
                    "Failed to list sessions for workspace {}: {}",
                    workspace.name,
                    desktop_session_error(error)
                )
            })?;

        for session in metadata {
            if session.status == SessionStatus::Archived
                || !matches!(session.session_kind, SessionKind::Standard)
                || scheduler.as_ref().is_some_and(|scheduler| {
                    scheduler.is_session_busy_or_queued(&session.session_id)
                })
                || !session.session_name.to_lowercase().contains(&query)
            {
                continue;
            }
            candidates.push(SessionReferenceCandidate {
                session_id: session.session_id,
                session_name: session.session_name,
                workspace_id: workspace.id.clone(),
                workspace_path: workspace_path.clone(),
                remote_connection_id: remote_connection_id.clone(),
                remote_ssh_host: remote_ssh_host.clone(),
                workspace_label: workspace.name.clone(),
                last_activity_at: session.last_active_at,
            });
        }
    }

    candidates.sort_by(|left, right| right.last_activity_at.cmp(&left.last_activity_at));
    candidates.truncate(limit);
    Ok(candidates)
}

#[tauri::command]
pub async fn list_persisted_sessions_page(
    request: ListPersistedSessionsPageRequest,
    runtime: State<'_, DesktopRuntimeContext>,
    startup_trace: State<'_, DesktopStartupTrace>,
) -> Result<SessionMetadataPage, String> {
    let trace_started = Instant::now();
    let result = runtime
        .session_application()
        .list_persisted_sessions_page(
            desktop_session_scope(
                request.workspace_id,
                request.workspace_path,
                request.remote_connection_id,
                request.remote_ssh_host,
            ),
            request.cursor.as_deref(),
            request.limit,
            request.session_ids.as_deref(),
        )
        .await
        .map_err(|error| {
            format!(
                "Failed to list persisted session page: {}",
                desktop_session_error(error)
            )
        });
    startup_trace.record_tauri_command_elapsed("list_persisted_sessions_page", None, trace_started);
    result
}

#[tauri::command]
pub async fn get_session_lineage(
    request: GetSessionLineageRequest,
    runtime: State<'_, DesktopRuntimeContext>,
) -> Result<Option<AgentSessionLineageSnapshot>, String> {
    runtime
        .session_application()
        .get_session_lineage(
            desktop_session_scope(
                request.workspace_id,
                request.workspace_path,
                request.remote_connection_id,
                request.remote_ssh_host,
            ),
            &request.session_id,
        )
        .await
        .map_err(|error| {
            format!(
                "Failed to load session lineage: {}",
                desktop_session_error(error)
            )
        })
}

#[tauri::command]
pub async fn load_session_turns(
    request: LoadSessionTurnsRequest,
    runtime: State<'_, DesktopRuntimeContext>,
    startup_trace: State<'_, DesktopStartupTrace>,
) -> Result<Vec<DialogTurnData>, String> {
    let trace_started = Instant::now();
    let trace_target = if request.limit.is_some() {
        "recent"
    } else {
        "full"
    };
    let result = runtime
        .session_application()
        .load_session_turns(
            desktop_session_scope(
                request.workspace_id,
                request.workspace_path,
                request.remote_connection_id,
                request.remote_ssh_host,
            ),
            &request.session_id,
            request.limit,
        )
        .await
        .map_err(|error| {
            format!(
                "Failed to load session turns: {}",
                desktop_session_error(error)
            )
        });
    startup_trace.record_tauri_command_elapsed(
        "load_session_turns",
        Some(trace_target),
        trace_started,
    );
    result
}

#[tauri::command]
pub async fn get_session_usage_report(
    request: GetSessionUsageReportRequest,
    runtime: State<'_, DesktopRuntimeContext>,
) -> Result<SessionUsageReport, String> {
    runtime
        .session_application()
        .generate_usage_report(
            desktop_session_scope(
                request.workspace_id,
                request.workspace_path,
                request.remote_connection_id,
                request.remote_ssh_host,
            ),
            request.session_id,
            request.include_hidden_subagents,
        )
        .await
        .map_err(|error| {
            format!(
                "Failed to generate session usage report: {}",
                desktop_session_error(error)
            )
        })
}

#[tauri::command]
pub async fn save_session_turn(
    request: SaveSessionTurnRequest,
    runtime: State<'_, DesktopRuntimeContext>,
) -> Result<(), String> {
    runtime
        .session_application()
        .save_session_turn(
            desktop_session_scope(
                request.workspace_id.clone(),
                request.workspace_path.clone(),
                request.remote_connection_id,
                request.remote_ssh_host,
            ),
            &request.turn_data,
        )
        .await
        .map_err(|error| format!("Failed to save session turn: {error}"))?;

    // Notify the auto-sync background task (debounced upload to relay)

    Ok(())
}

#[tauri::command]
pub async fn save_session_metadata(
    request: SaveSessionMetadataRequest,
    runtime: State<'_, DesktopRuntimeContext>,
) -> Result<(), String> {
    runtime
        .session_application()
        .save_ui_metadata(
            desktop_session_scope(
                request.workspace_id,
                request.workspace_path,
                request.remote_connection_id,
                request.remote_ssh_host,
            ),
            request.metadata,
            request.fields,
        )
        .await
        .map_err(|error| match error {
            DesktopSessionApplicationError::Validation(message) => message,
            error => format!(
                "Failed to save session metadata: {}",
                desktop_session_error(error)
            ),
        })
}

#[tauri::command]
pub async fn export_session_transcript(
    request: ExportSessionTranscriptRequest,
    runtime: State<'_, DesktopRuntimeContext>,
) -> Result<SessionTranscriptExport, String> {
    runtime
        .session_application()
        .export_session_transcript(
            desktop_session_scope(
                request.workspace_id,
                request.workspace_path,
                request.remote_connection_id,
                request.remote_ssh_host,
            ),
            &request.session_id,
            &SessionTranscriptExportOptions {
                tools: request.tools,
                tool_inputs: request.tool_inputs,
                thinking: request.thinking,
                turns: request.turns,
            },
        )
        .await
        .map_err(|error| {
            format!(
                "Failed to export session transcript: {}",
                desktop_session_error(error)
            )
        })
}

#[tauri::command]
pub async fn delete_persisted_session(
    request: DeletePersistedSessionRequest,
    runtime: State<'_, DesktopRuntimeContext>,
) -> Result<(), String> {
    runtime
        .session_application()
        .delete_session(
            desktop_session_scope(
                request.workspace_id,
                request.workspace_path,
                request.remote_connection_id,
                request.remote_ssh_host,
            ),
            request.session_id,
        )
        .await
        .map_err(|error| {
            format!(
                "Failed to delete persisted session: {}",
                desktop_session_error(error)
            )
        })
}

#[tauri::command]
pub async fn touch_session_activity(
    request: TouchSessionActivityRequest,
    runtime: State<'_, DesktopRuntimeContext>,
    startup_trace: State<'_, DesktopStartupTrace>,
) -> Result<(), String> {
    let trace_started = Instant::now();
    let result = runtime
        .session_application()
        .touch_session(
            desktop_session_scope(
                request.workspace_id,
                request.workspace_path,
                request.remote_connection_id,
                request.remote_ssh_host,
            ),
            &request.session_id,
        )
        .await
        .map_err(|error| {
            format!(
                "Failed to update session activity: {}",
                desktop_session_error(error)
            )
        });
    startup_trace.record_tauri_command_elapsed("touch_session_activity", None, trace_started);
    result
}

#[tauri::command]
pub async fn load_persisted_session_metadata(
    request: LoadPersistedSessionMetadataRequest,
    runtime: State<'_, DesktopRuntimeContext>,
    startup_trace: State<'_, DesktopStartupTrace>,
) -> Result<Option<SessionMetadata>, String> {
    let trace_started = Instant::now();
    // Direct metadata lookups are used by persistence flows that must be able
    // to read hidden subagent sessions without list-level visibility filtering.
    let result = runtime
        .session_application()
        .load_session_metadata(
            desktop_session_scope(
                request.workspace_id,
                request.workspace_path,
                request.remote_connection_id,
                request.remote_ssh_host,
            ),
            &request.session_id,
        )
        .await
        .map_err(|error| {
            format!(
                "Failed to load persisted session metadata: {}",
                desktop_session_error(error)
            )
        });
    startup_trace.record_tauri_command_elapsed(
        "load_persisted_session_metadata",
        None,
        trace_started,
    );
    result
}

#[tauri::command]
pub async fn fork_session(
    request: ForkSessionRequest,
    runtime: State<'_, DesktopRuntimeContext>,
) -> Result<ForkSessionResponse, String> {
    runtime
        .session_application()
        .fork_session(
            desktop_session_scope(
                request.workspace_id,
                request.workspace_path,
                request.remote_connection_id,
                request.remote_ssh_host,
            ),
            request.source_session_id,
            request.source_turn_id,
        )
        .await
        .map_err(|error| format!("Failed to fork session: {}", desktop_session_error(error)))
}

#[tauri::command]
pub async fn archive_session(
    request: ArchiveSessionRequest,
    runtime: State<'_, DesktopRuntimeContext>,
) -> Result<(), String> {
    runtime
        .session_application()
        .set_session_archived(
            desktop_session_scope(
                request.workspace_id,
                request.workspace_path,
                request.remote_connection_id,
                request.remote_ssh_host,
            ),
            request.session_id,
            true,
        )
        .await
        .map_err(|error| {
            format!(
                "Failed to save session metadata: {}",
                desktop_session_error(error)
            )
        })
}

#[tauri::command]
pub async fn unarchive_session(
    request: UnarchiveSessionRequest,
    runtime: State<'_, DesktopRuntimeContext>,
) -> Result<(), String> {
    runtime
        .session_application()
        .set_session_archived(
            desktop_session_scope(
                request.workspace_id,
                request.workspace_path,
                request.remote_connection_id,
                request.remote_ssh_host,
            ),
            request.session_id,
            false,
        )
        .await
        .map_err(|error| {
            format!(
                "Failed to save session metadata: {}",
                desktop_session_error(error)
            )
        })
}

#[tauri::command]
pub async fn archive_all_sessions(
    request: ArchiveAllSessionsRequest,
    runtime: State<'_, DesktopRuntimeContext>,
) -> Result<u32, String> {
    let scope = desktop_session_scope(
        request.workspace_id,
        request.workspace_path,
        request.remote_connection_id,
        request.remote_ssh_host,
    );
    let sessions = runtime
        .session_application()
        .list_persisted_sessions(scope.clone())
        .await
        .map_err(|error| format!("Failed to list sessions: {}", desktop_session_error(error)))?;

    let mut archived_count: u32 = 0;

    for metadata in sessions {
        if metadata.status != SessionStatus::Archived
            && metadata.session_kind == SessionKind::Standard
        {
            runtime
                .session_application()
                .set_session_archived(scope.clone(), metadata.session_id, true)
                .await
                .map_err(|error| {
                    format!(
                        "Failed to save session metadata: {}",
                        desktop_session_error(error)
                    )
                })?;
            archived_count += 1;
        }
    }

    Ok(archived_count)
}

#[tauri::command]
pub async fn list_archived_sessions(
    request: ListPersistedSessionsRequest,
    runtime: State<'_, DesktopRuntimeContext>,
) -> Result<Vec<SessionMetadata>, String> {
    runtime
        .session_application()
        .list_archived_sessions(desktop_session_scope(
            request.workspace_id,
            request.workspace_path,
            request.remote_connection_id,
            request.remote_ssh_host,
        ))
        .await
        .map_err(|error| format!("Failed to list sessions: {}", desktop_session_error(error)))
}

#[tauri::command]
pub async fn delete_all_archived_sessions(
    request: DeleteAllArchivedSessionsRequest,
    runtime: State<'_, DesktopRuntimeContext>,
) -> Result<u32, String> {
    let scope = desktop_session_scope(
        request.workspace_id,
        request.workspace_path,
        request.remote_connection_id,
        request.remote_ssh_host,
    );
    let sessions = runtime
        .session_application()
        .list_archived_sessions(scope.clone())
        .await
        .map_err(|error| format!("Failed to list sessions: {}", desktop_session_error(error)))?;

    let mut deleted_count: u32 = 0;

    for metadata in sessions {
        runtime
            .session_application()
            .delete_session(scope.clone(), metadata.session_id)
            .await
            .map_err(|error| {
                format!("Failed to delete session: {}", desktop_session_error(error))
            })?;
        deleted_count += 1;
    }

    Ok(deleted_count)
}
