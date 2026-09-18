//! Session HostInvoke handlers for CLI Peer Host.

use std::path::PathBuf;
use std::time::{SystemTime, UNIX_EPOCH};

use serde_json::{json, Value};

use openbitfun_agent_runtime::sdk::{
    AgentSessionModelSelection, AgentSessionModelSelectionUpdateRequest,
    AgentSessionRestoreRequest, AgentSessionRestoreResult, PortErrorKind, RuntimeError,
    SessionEventBackfill, SessionEventProjectionSnapshot, SessionInteractionSnapshot,
};
use openbitfun_core::agentic::core::Session;
use openbitfun_core::agentic::get_agent_registry;
use openbitfun_core::util::errors::OpenBitFunError;
use openbitfun_events::{project_agentic_frontend_event, AgenticEvent};
use openbitfun_product_domains::product_search::SessionContentSearchRequest;
use openbitfun_runtime_ports::{
    AgentSessionArchiveRequest, AgentSessionCreateRequest, AgentSessionDeleteRequest,
    AgentSessionModeUpdateRequest, AgentSessionRenameRequest, AgentThreadGoalGetRequest,
    SessionStoragePathRequest, SessionTurnWindowRequest,
};

use crate::diagnostics::{OUTCOME_UNKNOWN_ERROR_CODE, SESSION_IN_USE_ERROR_CODE};
use crate::peer_host::args::{get_string, optional_bool, optional_string, request_value};
use crate::peer_host::state::PeerHostState;

use super::snapshot::{
    local_snapshot_session_stats, require_local_snapshot_workspace, resolve_snapshot_workspace,
};

async fn session_storage_request(
    state: &PeerHostState,
    request: &Value,
) -> Result<SessionStoragePathRequest, String> {
    if let Some(id) = optional_string(request, "workspaceId") {
        let workspace = state
            .workspace_service
            .require_workspace(&id)
            .await
            .map_err(|error| error.to_string())?;
        let remote =
            workspace.workspace_kind == openbitfun_core::service::workspace::WorkspaceKind::Remote;
        return Ok(SessionStoragePathRequest {
            workspace_path: workspace.root_path.clone(),
            remote_connection_id: if remote {
                Some(
                    workspace
                        .remote_ssh_connection_id()
                        .ok_or("Remote workspace is missing its saved SSH connection ID")?
                        .to_owned(),
                )
            } else {
                None
            },
            remote_ssh_host: if remote {
                workspace
                    .metadata
                    .get("sshHost")
                    .and_then(Value::as_str)
                    .map(str::to_owned)
            } else {
                None
            },
        });
    }
    let workspace_path = get_string(request, "workspacePath")?;
    let workspace_path = workspace_path.trim();
    if workspace_path.is_empty() {
        return Err("workspace_path is required".to_string());
    }
    Ok(SessionStoragePathRequest {
        workspace_path: PathBuf::from(workspace_path),
        remote_connection_id: optional_string(request, "remoteConnectionId"),
        remote_ssh_host: optional_string(request, "remoteSshHost"),
    })
}

fn frontend_events(events: Vec<AgenticEvent>) -> Vec<Value> {
    events
        .into_iter()
        .filter_map(project_agentic_frontend_event)
        .map(|event| {
            json!({
                "eventName": event.event_name,
                "payload": event.payload,
            })
        })
        .collect()
}

fn runtime_event_snapshot_to_json(snapshot: SessionEventProjectionSnapshot) -> Value {
    json!({
        "sessionId": snapshot.session_id,
        "streamId": snapshot.stream_id,
        "cursor": snapshot.cursor,
        "activeTurnId": snapshot.active_turn_id,
        "events": frontend_events(snapshot.events),
    })
}

/// Project the incremental catch-up answer in the same event shape the
/// snapshot uses, so a controller applies both through one path.
///
/// A Host with no journal cannot prove contiguity either, so it answers the
/// same way an aged-out cursor does: take a snapshot.
fn session_event_backfill_to_json(
    backfill: Option<SessionEventBackfill>,
    interaction_snapshot: SessionInteractionSnapshot,
) -> Value {
    match backfill {
        Some(SessionEventBackfill::Delta {
            stream_id,
            cursor,
            events,
        }) => json!({
            "kind": "delta",
            "streamId": stream_id,
            "cursor": cursor,
            "events": frontend_events(events),
            // Replaying events rebuilds the card; only the mailbox makes it
            // answerable. A catch-up that skipped this left a blocking
            // interaction on screen that no surface could resolve.
            "interactionSnapshot": interaction_snapshot,
        }),
        Some(SessionEventBackfill::SnapshotRequired) | None => json!({
            "kind": "snapshotRequired",
        }),
    }
}

/// Serve everything a controller missed after the cursor it already applied.
pub(crate) fn load_session_event_backfill(
    state: &PeerHostState,
    args: &Value,
) -> Result<Value, String> {
    let request = request_value(args);
    let session_id = validated_session_id(request)?;
    let stream_id = get_string(request, "streamId")?;
    let cursor = request.get("cursor").and_then(Value::as_u64).unwrap_or(0);
    Ok(session_event_backfill_to_json(
        state
            .agent_runtime
            .session_events_since(&session_id, &stream_id, cursor),
        state
            .agent_runtime
            .session_interaction_snapshot(&session_id),
    ))
}

pub(super) async fn ensure_session_workspace_runtime_ownership(
    state: &PeerHostState,
    request: &Value,
) -> Result<SessionStoragePathRequest, String> {
    let scope = session_storage_request(state, request).await?;
    if optional_string(request, "workspaceId").is_some() {
        let coordinator = openbitfun_core::agentic::coordination::get_global_coordinator()
            .ok_or("Conversation coordinator is unavailable")?;
        if let Some(connection) = scope.remote_connection_id.as_deref() {
            coordinator
                .ensure_verified_remote_workspace_runtime_ownership(
                    &scope.workspace_path,
                    connection,
                    scope.remote_ssh_host.as_deref(),
                )
                .map_err(|error| error.to_string())?;
        } else {
            coordinator
                .ensure_workspace_runtime_ownership(&scope.workspace_path, None, None)
                .map_err(|error| error.to_string())?;
        }
        return Ok(scope);
    }
    state
        .compatibility
        .ensure_workspace_runtime_ownership(&scope)
        .map_err(|error| format!("Agent Runtime ownership is unavailable: {error}"))?;
    Ok(scope)
}

pub(super) async fn resolved_session_storage_path(
    state: &PeerHostState,
    request: &Value,
) -> Result<PathBuf, String> {
    if let Some(id) = optional_string(request, "workspaceId") {
        use openbitfun_runtime_ports::SessionStorePort;
        return openbitfun_core::agentic::session::CoreSessionStorePort::default()
            .resolve_workspace_storage(&id)
            .await
            .map(|resolution| resolution.effective_storage_path)
            .map_err(|error| error.to_string());
    }
    resolved_session_storage_scope(state, session_storage_request(state, request).await?).await
}

pub(super) async fn resolved_session_storage_scope(
    state: &PeerHostState,
    scope: SessionStoragePathRequest,
) -> Result<PathBuf, String> {
    state
        .compatibility
        .resolve_persisted_session_storage_path(scope)
        .await
        .map_err(|error| format!("Failed to resolve session storage path: {error}"))
}

/// Whether the controller named the session's workspace, by ID or by the
/// legacy path projection. Only such requests can (re)load the session.
fn has_session_workspace_scope(request: &Value) -> bool {
    ["workspaceId", "workspacePath"].iter().any(|key| {
        request
            .get(key)
            .and_then(Value::as_str)
            .is_some_and(|value| !value.trim().is_empty())
    })
}

fn validated_session_id(request: &Value) -> Result<String, String> {
    let session_id = get_string(request, "sessionId")?;
    openbitfun_agent_runtime::session_control::validate_session_id(&session_id)?;
    Ok(session_id)
}

fn system_time_to_unix_secs(time: SystemTime) -> u64 {
    time.duration_since(UNIX_EPOCH)
        .map(|d| d.as_secs())
        .unwrap_or(0)
}

fn session_to_json(session: Session, turn_count: usize) -> Value {
    json!({
        "sessionId": session.session_id,
        "sessionName": session.session_name,
        "agentType": session.agent_type,
        "modelName": session.config.model_id,
        "reasoningPreset": session.config.reasoning_preset,
        "lastUserDialogAgentType": session.last_user_dialog_agent_type,
        "lastSubmittedAgentType": session.last_submitted_agent_type,
        "state": format!("{:?}", session.state),
        "turnCount": turn_count,
        "createdAt": system_time_to_unix_secs(session.created_at),
    })
}

fn overlay_live_session_state(restored: &mut Session, live: Option<Session>) {
    let Some(live) = live else {
        return;
    };
    if live.session_id == restored.session_id {
        restored.state = live.state;
    }
}

fn restored_session_to_json(restored: AgentSessionRestoreResult) -> Value {
    let session = restored.session;
    json!({
        "sessionId": session.session_id,
        "sessionName": session.session_name,
        "agentType": session.agent_type,
        "modelName": session.model_id,
        "reasoningPreset": session.reasoning_preset,
        "lastUserDialogAgentType": session.last_user_dialog_agent_type,
        "lastSubmittedAgentType": session.last_submitted_agent_type,
        "state": format!("{:?}", restored.state),
        "turnCount": session.turn_count,
        "createdAt": session.created_at_ms / 1000,
    })
}

fn peer_core_session_error(operation: &str, error: OpenBitFunError) -> String {
    match error {
        OpenBitFunError::SessionInUse { session_id } => format!(
            "{SESSION_IN_USE_ERROR_CODE}: Session is already open for writing: {session_id}"
        ),
        error => format!("{operation}: {error}"),
    }
}

fn peer_runtime_session_error(operation: &str, error: RuntimeError) -> String {
    match error {
        RuntimeError::Port(port_error) if port_error.kind == PortErrorKind::SessionInUse => {
            format!("{SESSION_IN_USE_ERROR_CODE}: {}", port_error.message)
        }
        RuntimeError::Port(port_error) if port_error.kind == PortErrorKind::OutcomeUnknown => {
            format!("{OUTCOME_UNKNOWN_ERROR_CODE}: {}", port_error.message)
        }
        error => format!("{operation}: {}", error.into_message()),
    }
}

pub(crate) async fn list_persisted_sessions(
    state: &PeerHostState,
    args: &Value,
) -> Result<Value, String> {
    let request = request_value(args);
    let workspace_path = resolved_session_storage_path(state, request).await?;
    let list = state
        .compatibility
        .list_persisted_sessions(&workspace_path)
        .await
        .map_err(|e| format!("Failed to list persisted sessions: {e}"))?;
    serde_json::to_value(list).map_err(|e| format!("serialize sessions: {e}"))
}

pub(crate) async fn list_persisted_sessions_page(
    state: &PeerHostState,
    args: &Value,
) -> Result<Value, String> {
    let request = request_value(args);
    let workspace_path = resolved_session_storage_path(state, request).await?;
    let limit = request.get("limit").and_then(|v| v.as_u64()).unwrap_or(50) as usize;
    let cursor = optional_string(request, "cursor");
    let session_ids = request
        .get("session_ids")
        .or_else(|| request.get("sessionIds"))
        .filter(|value| !value.is_null())
        .map(|value| serde_json::from_value::<Vec<String>>(value.clone()))
        .transpose()
        .map_err(|error| format!("Invalid session activity ids: {error}"))?;
    let page = state
        .compatibility
        .list_persisted_sessions_page_with_activity(
            &state.agent_runtime,
            &workspace_path,
            cursor.as_deref(),
            limit,
            session_ids.as_deref(),
        )
        .await
        .map_err(|e| format!("Failed to list persisted session page: {e}"))?;
    serde_json::to_value(page).map_err(|e| format!("serialize session page: {e}"))
}

pub(crate) async fn list_persisted_sessions_count(
    state: &PeerHostState,
    args: &Value,
) -> Result<Value, String> {
    let request = request_value(args);
    let workspace_path = resolved_session_storage_path(state, request).await?;
    let list = state
        .compatibility
        .list_persisted_sessions(&workspace_path)
        .await
        .map_err(|e| format!("Failed to count persisted sessions: {e}"))?;
    Ok(json!(list.len()))
}

/// CLI Peer observers can acknowledge results and persist title presentation
/// without projecting Session history back into the Runtime.
pub(crate) async fn save_session_metadata(
    state: &PeerHostState,
    args: &Value,
) -> Result<Value, String> {
    use openbitfun_core::service::session::{
        apply_session_title_metadata, apply_session_unread_completion, SessionMetadata,
    };
    let request = request_value(args);
    let fields: Vec<String> =
        serde_json::from_value(request.get("fields").cloned().unwrap_or(Value::Null))
            .map_err(|error| format!("Invalid session metadata fields: {error}"))?;
    if fields.iter().any(|field| {
        !matches!(
            field.as_str(),
            "unreadCompletion" | "needsUserAttention" | "titleMetadata"
        )
    }) {
        return Err(
            "CLI Peer Host supports only session notification and title metadata updates"
                .to_string(),
        );
    }
    let incoming: SessionMetadata =
        serde_json::from_value(request.get("metadata").cloned().unwrap_or(Value::Null))
            .map_err(|error| format!("Invalid session presentation metadata: {error}"))?;
    let workspace_path = resolved_session_storage_path(state, request).await?;
    state
        .compatibility
        .update_persisted_session_metadata(&workspace_path, &incoming.session_id, |current| {
            if fields.iter().any(|field| field == "unreadCompletion") {
                apply_session_unread_completion(current, &incoming);
            }
            if fields.iter().any(|field| field == "needsUserAttention") {
                current.needs_user_attention = incoming.needs_user_attention.clone();
            }
            if fields.iter().any(|field| field == "titleMetadata") {
                apply_session_title_metadata(current, &incoming);
            }
        })
        .await
        .map_err(|error| format!("Failed to update session presentation metadata: {error}"))?;
    Ok(Value::Null)
}

pub(crate) async fn search_session_content(
    state: &PeerHostState,
    args: &Value,
) -> Result<Value, String> {
    let request = request_value(args);
    let search_request: SessionContentSearchRequest = serde_json::from_value(request.clone())
        .map_err(|error| format!("Invalid session content search request: {error}"))?;
    let workspace_path = resolved_session_storage_path(state, request).await?;
    let response = state
        .compatibility
        .search_persisted_session_content(
            &workspace_path,
            &search_request.query,
            search_request.normalized_limit(),
            search_request.include_archived,
        )
        .await
        .map_err(|error| format!("Failed to search persisted session content: {error}"))?;
    serde_json::to_value(response).map_err(|error| format!("serialize search response: {error}"))
}

pub(crate) async fn load_session_turns(
    state: &PeerHostState,
    args: &Value,
) -> Result<Value, String> {
    let request = request_value(args);
    let session_id = validated_session_id(request)?;
    let workspace_path = resolved_session_storage_path(state, request).await?;
    let limit = request
        .get("limit")
        .and_then(|value| value.as_u64())
        .map(|value| value as usize);
    let turns = state
        .compatibility
        .load_persisted_session_turns(&workspace_path, &session_id, limit)
        .await
        .map_err(|e| format!("Failed to load session turns: {e}"))?;
    serde_json::to_value(turns).map_err(|e| format!("serialize turns: {e}"))
}

pub(crate) async fn load_session_turn_window(
    state: &PeerHostState,
    args: &Value,
) -> Result<Value, String> {
    let request = request_value(args);
    let session_id = validated_session_id(request)?;
    let workspace_path = resolved_session_storage_path(state, request).await?;
    let response = state
        .compatibility
        .load_session_turn_window_from_storage_path(
            &workspace_path,
            SessionTurnWindowRequest {
                workspace_path: workspace_path.clone(),
                session_id,
                include_internal: optional_bool(request, "includeInternal").unwrap_or(false),
                target_storage_turn_index: request
                    .get("targetStorageTurnIndex")
                    .and_then(Value::as_u64)
                    .ok_or_else(|| "targetStorageTurnIndex is required".to_string())?
                    as usize,
                expected_turn_id: optional_string(request, "expectedTurnId"),
                expected_catalog_revision: optional_string(request, "expectedCatalogRevision"),
                before: request.get("before").and_then(Value::as_u64).unwrap_or(4) as usize,
                after: request.get("after").and_then(Value::as_u64).unwrap_or(12) as usize,
            },
        )
        .await
        .map_err(|e| format!("Failed to load session Turn window: {e}"))?;
    serde_json::to_value(response).map_err(|e| format!("serialize Turn window: {e}"))
}

pub(crate) async fn restore_session_view(
    state: &PeerHostState,
    args: &Value,
) -> Result<Value, String> {
    let request = request_value(args);
    let session_id = validated_session_id(request)?;
    let storage_request = session_storage_request(state, request).await?;
    let include_internal = request
        .get("includeInternal")
        .and_then(|v| v.as_bool())
        .unwrap_or(false);
    let tail_turn_count = request
        .get("tailTurnCount")
        .and_then(|v| v.as_u64())
        .map(|n| n as usize)
        .filter(|n| *n > 0)
        .map(|n| n.min(16));

    let (mut session, turns, total_turn_count, turn_catalog, timings) = state
        .compatibility
        .restore_session_view_for_workspace(
            storage_request,
            &session_id,
            include_internal,
            tail_turn_count,
        )
        .await
        .map_err(|e| format!("Failed to restore session view: {e}"))?;
    let live_session = state
        .compatibility
        .loaded_session_snapshot(&session_id)
        .map_err(|e| format!("Failed to read live session state: {e}"))?;
    overlay_live_session_state(&mut session, live_session);
    // The Session is the account's, not one controller's. Every attached
    // surface of the same account resumes the same blocking interactions and
    // the same live Turn projection, including work this host started in its
    // own TUI — otherwise a controller renders a Turn it can watch but never
    // answer. The Runtime mailbox remains the arbiter for double answers.
    let interaction_snapshot = state
        .agent_runtime
        .session_interaction_snapshot(&session_id);
    let runtime_event_snapshot = state
        .agent_runtime
        .session_event_projection_snapshot(&session_id)
        .map(runtime_event_snapshot_to_json);

    let loaded_turn_count = turns.len();
    let is_partial = loaded_turn_count < total_turn_count;
    Ok(json!({
        "session": session_to_json(session, total_turn_count),
        "turns": turns,
        "interactionSnapshot": interaction_snapshot,
        "runtimeEventSnapshot": runtime_event_snapshot,
        "turnCatalog": turn_catalog,
        "contextRestoreState": "pending",
        "isPartial": is_partial,
        "loadedTurnCount": loaded_turn_count,
        "totalTurnCount": total_turn_count,
        "timings": timings,
    }))
}

pub(crate) async fn restore_session_with_turns(
    state: &PeerHostState,
    args: &Value,
) -> Result<Value, String> {
    let request = request_value(args);
    let session_id = validated_session_id(request)?;
    let storage_request = session_storage_request(state, request).await?;
    let include_internal = request
        .get("includeInternal")
        .and_then(|v| v.as_bool())
        .unwrap_or(false);

    let (session, turns) = state
        .compatibility
        .restore_session_with_turns_for_workspace(storage_request, &session_id, include_internal)
        .await
        .map_err(|error| peer_core_session_error("Failed to restore session with turns", error))?;

    let turn_count = turns.len();
    Ok(json!({
        "session": session_to_json(session, turn_count),
        "turns": turns,
    }))
}

pub(crate) async fn restore_session(state: &PeerHostState, args: &Value) -> Result<Value, String> {
    let request = request_value(args);
    let session_id = validated_session_id(request)?;
    let workspace = resolve_snapshot_workspace(state, request).await?;
    let include_internal = request
        .get("includeInternal")
        .and_then(|v| v.as_bool())
        .unwrap_or(false);

    let restored = state
        .agent_runtime
        .restore_session(AgentSessionRestoreRequest {
            workspace_id: Some(workspace.id),
            workspace_path: String::new(),
            session_id,
            include_internal,
            remote_connection_id: None,
            remote_ssh_host: None,
        })
        .await
        .map_err(|error| peer_runtime_session_error("Failed to restore session", error))?;

    Ok(restored_session_to_json(restored))
}

pub(crate) async fn create_session(state: &PeerHostState, args: &Value) -> Result<Value, String> {
    let request = request_value(args);
    let session_name = get_string(request, "sessionName")?;
    let agent_type = get_string(request, "agentType")?;
    let session_id = optional_string(request, "sessionId");
    let workspace_id = optional_string(request, "workspaceId")
        .map(|id| id.trim().to_string())
        .filter(|id| !id.is_empty());
    // The workspace ID selects the owning workspace; the path is only the
    // legacy projection a pre-ID controller sends, so it is required only when
    // no ID names the workspace.
    let workspace_path = match workspace_id.as_deref() {
        Some(_) => optional_string(request, "workspacePath"),
        None => Some(get_string(request, "workspacePath")?),
    };
    let remote_connection_id = optional_string(request, "remoteConnectionId");
    let remote_ssh_host = optional_string(request, "remoteSshHost");

    let model_id = request
        .get("config")
        .and_then(|c| {
            c.get("modelName")
                .or_else(|| c.get("model_name"))
                .or_else(|| c.get("modelId"))
                .or_else(|| c.get("model_id"))
        })
        .and_then(|v| v.as_str())
        .map(|s| s.trim().to_string())
        .filter(|s| !s.is_empty())
        .or_else(|| optional_string(request, "modelName"));

    let create_request = AgentSessionCreateRequest {
        session_name,
        agent_type,
        agent_route_key: None,
        workspace_path,
        project_workspace_path: None,
        execution_target: None,
        workspace_id,
        remote_connection_id,
        remote_ssh_host,
        model_id,
        metadata: serde_json::Map::new(),
    };
    let session = match session_id {
        Some(session_id) => {
            state
                .agent_runtime
                .create_session_with_id(session_id, create_request)
                .await
        }
        None => state.agent_runtime.create_session(create_request).await,
    }
    .map_err(|error| peer_runtime_session_error("Failed to create session", error))?;

    Ok(json!({
        "sessionId": session.session_id,
        "sessionName": session.session_name,
        "agentType": session.agent_type,
    }))
}

pub(crate) async fn delete_session(state: &PeerHostState, args: &Value) -> Result<Value, String> {
    let request = request_value(args);
    let session_id = validated_session_id(request)?;
    let workspace_path = optional_string(request, "workspacePath").unwrap_or_default();
    state
        .agent_runtime
        .delete_session(AgentSessionDeleteRequest {
            workspace_id: optional_string(request, "workspaceId"),
            workspace_path,
            session_id,
            remote_connection_id: optional_string(request, "remoteConnectionId"),
            remote_ssh_host: optional_string(request, "remoteSshHost"),
        })
        .await
        .map_err(|error| format!("Failed to delete session: {}", error.into_message()))?;
    Ok(Value::Null)
}

pub(crate) async fn rename_session(state: &PeerHostState, args: &Value) -> Result<Value, String> {
    let request = request_value(args);
    let session_id = validated_session_id(request)?;
    let storage_request = session_storage_request(state, request).await?;
    let title = get_string(request, "sessionName")
        .or_else(|_| get_string(request, "title"))
        .or_else(|_| get_string(request, "name"))?;
    state
        .agent_runtime
        .rename_session(AgentSessionRenameRequest {
            workspace_id: optional_string(request, "workspaceId"),
            workspace_path: storage_request.workspace_path.to_string_lossy().to_string(),
            session_id,
            session_name: title,
            remote_connection_id: storage_request.remote_connection_id,
            remote_ssh_host: storage_request.remote_ssh_host,
        })
        .await
        .map_err(|error| peer_runtime_session_error("Failed to rename session", error))?;
    Ok(Value::Null)
}

pub(crate) async fn archive_session(state: &PeerHostState, args: &Value) -> Result<Value, String> {
    let request = request_value(args);
    let session_id = validated_session_id(request)?;
    let storage_request = session_storage_request(state, request).await?;
    state
        .agent_runtime
        .archive_session(AgentSessionArchiveRequest {
            workspace_id: optional_string(request, "workspaceId"),
            workspace_path: storage_request.workspace_path.to_string_lossy().to_string(),
            session_id,
            remote_connection_id: storage_request.remote_connection_id,
            remote_ssh_host: storage_request.remote_ssh_host,
        })
        .await
        .map_err(|error| format!("Failed to archive session: {}", error.into_message()))?;
    Ok(Value::Null)
}

pub(crate) async fn touch_session_activity(
    state: &PeerHostState,
    args: &Value,
) -> Result<Value, String> {
    let request = request_value(args);
    let session_id = validated_session_id(request)?;
    ensure_session_workspace_runtime_ownership(state, request).await?;
    let workspace_path = resolved_session_storage_path(state, request).await?;
    let _mutation = state
        .compatibility
        .begin_persisted_session_mutation(&workspace_path, &session_id)
        .await
        .map_err(|error| format!("Failed to lock session activity update: {error}"))?;
    state
        .compatibility
        .touch_persisted_session(&workspace_path, &session_id)
        .await
        .map_err(|e| format!("Failed to update session activity: {e}"))?;
    Ok(Value::Null)
}

pub(crate) async fn get_session_thread_goal(
    state: &PeerHostState,
    args: &Value,
) -> Result<Value, String> {
    let request = request_value(args);
    let session_id = validated_session_id(request)?;
    let storage_request = if has_session_workspace_scope(request) {
        session_storage_request(state, request).await?
    } else {
        SessionStoragePathRequest {
            workspace_path: PathBuf::from("."),
            remote_connection_id: None,
            remote_ssh_host: None,
        }
    };
    let goal = state
        .agent_runtime
        .get_thread_goal(AgentThreadGoalGetRequest {
            session_id,
            workspace_path: storage_request
                .workspace_path
                .to_string_lossy()
                .into_owned(),
            remote_connection_id: storage_request.remote_connection_id,
            remote_ssh_host: storage_request.remote_ssh_host,
        })
        .await
        .map_err(|error| error.into_message())?;
    Ok(json!({ "goal": goal }))
}

pub(crate) async fn update_session_model(
    state: &PeerHostState,
    args: &Value,
) -> Result<Value, String> {
    let request = request_value(args);
    let session_id = validated_session_id(request)?;
    let model_name = get_string(request, "modelName")?;
    let reasoning_preset = optional_string(request, "reasoningPreset")
        .map(|preset| preset.trim().to_string())
        .filter(|preset| !preset.is_empty());
    if has_session_workspace_scope(request) {
        ensure_coordinator_session(state, args).await?;
    }
    state
        .agent_runtime
        .update_session_model_selection(AgentSessionModelSelectionUpdateRequest {
            session_id,
            selection: AgentSessionModelSelection {
                model_id: model_name,
                reasoning_preset,
            },
        })
        .await
        .map_err(|error| format!("Failed to update session model: {}", error.into_message()))?;
    Ok(Value::Null)
}

pub(crate) async fn update_session_mode(
    state: &PeerHostState,
    args: &Value,
) -> Result<Value, String> {
    let request = request_value(args);
    let session_id = validated_session_id(request)?;
    let mode_id = get_string(request, "modeId")?;
    if has_session_workspace_scope(request) {
        ensure_coordinator_session(state, args).await?;
    }
    state
        .agent_runtime
        .update_session_mode(AgentSessionModeUpdateRequest {
            session_id,
            mode_id,
            agent_route_key: None,
        })
        .await
        .map_err(|error| format!("Failed to update session mode: {}", error.into_message()))?;
    Ok(Value::Null)
}

pub(crate) async fn ensure_coordinator_session(
    state: &PeerHostState,
    args: &Value,
) -> Result<Value, String> {
    let request = request_value(args);
    let session_id = validated_session_id(request)?;
    ensure_session_workspace_runtime_ownership(state, request).await?;
    if state
        .compatibility
        .is_session_loaded_in_memory(&session_id)
        .map_err(|error| error.to_string())?
    {
        return Ok(Value::Null);
    }
    let storage = resolved_session_storage_path(state, request).await?;
    let include_internal = optional_bool(request, "includeInternal").unwrap_or(false);

    state
        .compatibility
        .ensure_session_loaded_from_storage_path(&storage, &session_id, include_internal)
        .await
        .map(|_| Value::Null)
        .map_err(|error| peer_core_session_error("Failed to ensure session", error))
}

pub(crate) async fn get_available_modes(
    state: &PeerHostState,
    args: &Value,
) -> Result<Value, String> {
    let request = request_value(args);
    let workspace_id = super::external_sources::workspace_id(state, request)
        .await
        .map_err(|error| error.encode())?;
    // Plugin and external-source snapshots are keyed by the workspace ID; the
    // record lookup only proves the ID names an open workspace on this host.
    if let Some(id) = workspace_id.as_deref() {
        state
            .workspace_service
            .require_workspace(id)
            .await
            .map_err(|error| error.to_string())?;
        if let Err(error) = openbitfun_core::plugin_host::ensure_configured_plugin_instance(
            crate::PLUGIN_HOST_LAUNCH_POLICY,
            id,
        )
        .await
        {
            openbitfun_core::plugin_host::report_configured_plugin_activation_failure(
                "CLI Peer mode catalog",
                workspace_id.as_deref(),
                error,
            )
            .await;
        }
        if let Err(error) =
            openbitfun_core::external_sources::ensure_external_source_workspace_snapshot(
                workspace_id.as_deref(),
            )
            .await
        {
            tracing::warn!(
                "Failed to initialize external agent sources for Peer mode catalog: {error}"
            );
        }
    }
    let mode_infos = get_agent_registry()
        .get_modes_info_for_workspace(workspace_id.as_deref(), workspace_id.is_some())
        .await;
    let dtos: Vec<Value> = mode_infos
        .into_iter()
        .map(|info| {
            let config_profile_id = info
                .config_profile_id
                .clone()
                .unwrap_or_else(|| info.id.clone());
            json!({
                "id": info.id,
                "name": info.name,
                "description": info.description,
                "isReadonly": info.is_readonly,
                "toolCount": info.tool_count,
                "defaultTools": info.default_tools,
                "promptCacheScopeKey": info.prompt_cache_scope_key,
                "configProfileId": config_profile_id,
                "configProfileLabel": info.config_profile_label,
                "configProfileMemberModeIds": info.config_profile_member_mode_ids,
                "source": info.source,
                "path": info.path,
                "model": info.model,
            })
        })
        .collect();
    Ok(Value::Array(dtos))
}

pub(crate) async fn get_session_stats(
    state: &PeerHostState,
    args: &Value,
) -> Result<Value, String> {
    let request = request_value(args);
    let session_id = get_string(request, "sessionId")?;
    let workspace = resolve_snapshot_workspace(state, request).await?;
    openbitfun_agent_runtime::session_control::validate_session_id(&session_id)
        .map_err(session_stats_validation_error)?;
    require_local_snapshot_workspace(&workspace)?;

    let scope = ensure_session_workspace_runtime_ownership(state, request).await?;
    let storage_path = resolved_session_storage_scope(state, scope).await?;
    let read = state
        .compatibility
        .begin_persisted_session_read(&storage_path, &session_id)
        .await
        .map_err(|error| format!("Failed to open a consistent snapshot view: {error}"))?;

    let stats = local_snapshot_session_stats(
        state.local_workspace_snapshot.as_ref(),
        workspace.id,
        session_id,
        read.visible_turn_end(),
    )
    .await?;

    Ok(json!({
        "session_id": stats.session_id,
        "total_files": stats.total_files,
        "total_turns": stats.total_turns,
        "total_changes": stats.total_changes
    }))
}

fn session_stats_validation_error(error: impl std::fmt::Display) -> String {
    format!("Failed to get session stats: Validation error: {error}")
}

pub(crate) async fn save_session_turn(
    state: &PeerHostState,
    args: &Value,
) -> Result<Value, String> {
    let request = request_value(args);
    ensure_session_workspace_runtime_ownership(state, request).await?;
    let workspace_path = resolved_session_storage_path(state, request).await?;
    let turn_data = request
        .get("turnData")
        .or_else(|| request.get("turn_data"))
        .cloned()
        .ok_or_else(|| "Missing 'turn_data' field".to_string())?;

    let turn: openbitfun_core::service::session::DialogTurnData =
        serde_json::from_value(turn_data).map_err(|e| format!("Invalid turn_data: {e}"))?;
    openbitfun_agent_runtime::session_control::validate_session_id(&turn.session_id)?;
    if let Some(request_session_id) = optional_string(request, "sessionId") {
        openbitfun_agent_runtime::session_control::validate_session_id(&request_session_id)?;
        if request_session_id != turn.session_id {
            return Err("turn_data session_id does not match request session_id".to_string());
        }
    }
    state
        .compatibility
        .ensure_session_loaded_from_storage_path(&workspace_path, &turn.session_id, false)
        .await
        .map_err(|error| format!("Failed to load session before saving a Turn: {error}"))?;
    let mutation = state
        .compatibility
        .begin_persisted_session_mutation(&workspace_path, &turn.session_id)
        .await
        .map_err(|error| format!("Failed to lock session turn save: {error}"))?;

    state
        .compatibility
        .save_persisted_dialog_turn(&mutation, &turn)
        .await
        .map_err(|e| format!("Failed to save session turn: {e}"))?;
    Ok(Value::Null)
}

#[cfg(test)]
mod tests {
    use super::{
        overlay_live_session_state, peer_core_session_error, peer_runtime_session_error,
        restored_session_to_json, runtime_event_snapshot_to_json, session_stats_validation_error,
    };
    use openbitfun_agent_runtime::sdk::{
        AgentSessionRestoreResult, AgentSessionSummary, PortError, PortErrorKind, RuntimeError,
        SessionEventProjectionSnapshot, SessionState,
    };
    use openbitfun_core::agentic::core::{
        ProcessingPhase, Session as CoreSession, SessionConfig, SessionState as CoreSessionState,
    };
    use openbitfun_core::util::errors::OpenBitFunError;
    use openbitfun_events::AgenticEvent;

    #[test]
    fn peer_writer_conflicts_keep_the_stable_transport_code() {
        let core_error = peer_core_session_error(
            "Failed to restore session with turns",
            OpenBitFunError::SessionInUse {
                session_id: "session-1".to_string(),
            },
        );
        let runtime_error = peer_runtime_session_error(
            "Failed to restore session",
            RuntimeError::Port(PortError::new(
                PortErrorKind::SessionInUse,
                "Session is already open for writing: session-1",
            )),
        );

        assert_eq!(
            core_error,
            "session_in_use: Session is already open for writing: session-1"
        );
        assert_eq!(runtime_error, core_error);
    }

    #[test]
    fn peer_restore_projects_runtime_events_with_the_cursor_fence() {
        let value = runtime_event_snapshot_to_json(SessionEventProjectionSnapshot {
            session_id: "session-1".to_string(),
            stream_id: "runtime-a".to_string(),
            cursor: 7,
            active_turn_id: Some("turn-1".to_string()),
            events: vec![AgenticEvent::TextChunk {
                session_id: "session-1".to_string(),
                turn_id: "turn-1".to_string(),
                round_id: "round-1".to_string(),
                attempt_id: None,
                attempt_index: None,
                text: "hello".to_string(),
            }],
        });

        assert_eq!(value["sessionId"], "session-1");
        assert_eq!(value["streamId"], "runtime-a");
        assert_eq!(value["cursor"], 7);
        assert_eq!(value["activeTurnId"], "turn-1");
        assert_eq!(value["events"][0]["eventName"], "agentic://text-chunk");
        assert_eq!(value["events"][0]["payload"]["text"], "hello");
    }

    #[test]
    fn peer_writer_errors_keep_operation_context_when_they_are_not_conflicts() {
        let error = peer_runtime_session_error(
            "Failed to restore session",
            RuntimeError::MissingSessionRestorePort,
        );

        assert_eq!(
            error,
            "Failed to restore session: agent session restore port is not registered"
        );
    }

    #[test]
    fn peer_rename_unknown_outcomes_keep_the_stable_transport_code() {
        let error = peer_runtime_session_error(
            "Failed to rename session",
            RuntimeError::Port(PortError::new(
                PortErrorKind::OutcomeUnknown,
                "inspect authoritative state",
            )),
        );

        assert_eq!(error, "outcome_unknown: inspect authoritative state");
    }

    #[test]
    fn peer_attach_and_raw_mutations_reuse_core_runtime_ownership() {
        let session_source = include_str!("session.rs");
        for mutation in [
            "pub(crate) async fn touch_session_activity",
            "pub(crate) async fn ensure_coordinator_session",
            "pub(crate) async fn save_session_turn",
        ] {
            let body = session_source
                .split_once(mutation)
                .unwrap_or_else(|| panic!("missing Peer mutation: {mutation}"))
                .1
                .split_once("pub(crate) async fn")
                .unwrap_or_else(|| panic!("missing Peer mutation boundary: {mutation}"))
                .0;
            assert!(body.contains("ensure_session_workspace_runtime_ownership"));
        }

        let workspace_source = include_str!("workspace.rs");
        let open = workspace_source
            .split_once("pub(crate) async fn open_workspace")
            .expect("Peer workspace open")
            .1
            .split_once("pub(crate) async fn reload_config")
            .expect("Peer workspace open boundary")
            .0;
        assert!(open.contains("ensure_workspace_runtime_ownership"));

        let snapshot_source = include_str!("snapshot.rs");
        let rollback = snapshot_source
            .split_once("pub(crate) async fn rollback_session_to_turn")
            .expect("Peer rollback")
            .1
            .split_once("#[cfg(test)]")
            .expect("Peer rollback boundary")
            .0;
        assert!(rollback.contains("ensure_session_workspace_runtime_ownership"));
    }

    #[test]
    fn peer_mode_catalog_activates_plugins_before_reading_the_registry() {
        let source = include_str!("session.rs").replace("\r\n", "\n");
        let command = source
            .split_once("pub(crate) async fn get_available_modes(")
            .expect("Peer mode catalog")
            .1
            .split_once("pub(crate) async fn get_session_stats(")
            .expect("Peer mode catalog boundary")
            .0;

        let activation = command
            .find("ensure_configured_plugin_instance(")
            .expect("configured plugin activation");
        let catalog_read = command
            .find(".get_modes_info_for_workspace(")
            .expect("registry mode catalog read");
        assert!(activation < catalog_read);
    }

    #[test]
    fn basic_restore_keeps_peer_host_session_shape() {
        let value = restored_session_to_json(AgentSessionRestoreResult {
            session: AgentSessionSummary {
                session_id: "session_1".to_string(),
                session_name: "Main".to_string(),
                agent_type: "Standard".to_string(),
                model_id: Some("provider/model".to_string()),
                reasoning_preset: Some("high".to_string()),
                last_user_dialog_agent_type: Some("plan".to_string()),
                last_submitted_agent_type: Some("Standard".to_string()),
                turn_count: 3,
                created_at_ms: 12_345,
                last_active_at_ms: 20_000,
            },
            state: SessionState::Idle,
        });

        assert_eq!(value["sessionId"], "session_1");
        assert_eq!(value["sessionName"], "Main");
        assert_eq!(value["agentType"], "Standard");
        assert_eq!(value["modelName"], "provider/model");
        assert_eq!(value["reasoningPreset"], "high");
        assert_eq!(value["lastUserDialogAgentType"], "plan");
        assert_eq!(value["lastSubmittedAgentType"], "Standard");
        assert_eq!(value["state"], "Idle");
        assert_eq!(value["turnCount"], 3);
        assert_eq!(value["createdAt"], 12);
        assert!(value.get("lastActiveAt").is_none());
    }

    #[test]
    fn session_stats_validation_keeps_compatibility_error_category() {
        assert_eq!(
            session_stats_validation_error("session_id cannot contain path separators"),
            "Failed to get session stats: Validation error: session_id cannot contain path separators"
        );
    }

    #[test]
    fn view_restore_uses_the_cli_hosts_live_processing_state() {
        let mut restored = CoreSession::new_with_id(
            "session_1".to_string(),
            "Main".to_string(),
            "Standard".to_string(),
            SessionConfig::default(),
        );
        let mut live = restored.clone();
        live.state = CoreSessionState::Processing {
            current_turn_id: "turn_1".to_string(),
            phase: ProcessingPhase::Streaming,
        };

        overlay_live_session_state(&mut restored, Some(live));

        assert!(matches!(
            restored.state,
            CoreSessionState::Processing {
                ref current_turn_id,
                ..
            } if current_turn_id == "turn_1"
        ));
    }
}

pub(crate) async fn ensure_control_conversation(
    state: &PeerHostState,
    _args: &Value,
) -> Result<Value, String> {
    let result = state
        .compatibility
        .ensure_control_conversation()
        .await
        .map_err(|error| error.to_string())?;
    serde_json::to_value(result).map_err(|error| error.to_string())
}

pub(crate) async fn record_voice_exchange(
    state: &PeerHostState,
    args: &Value,
) -> Result<Value, String> {
    let request = serde_json::from_value(args.get("request").unwrap_or(args).clone())
        .map_err(|error| error.to_string())?;
    state
        .compatibility
        .record_voice_exchange(request)
        .await
        .map_err(|error| error.to_string())?;
    Ok(Value::Null)
}

pub(crate) async fn create_control_conversation(
    state: &PeerHostState,
    args: &Value,
) -> Result<Value, String> {
    let request = serde_json::from_value(args.get("request").unwrap_or(args).clone())
        .map_err(|error| error.to_string())?;
    let result = state
        .compatibility
        .create_control_conversation(request)
        .await
        .map_err(|error| error.to_string())?;
    serde_json::to_value(result).map_err(|error| error.to_string())
}
