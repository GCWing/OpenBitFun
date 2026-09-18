//! Workspace and config HostInvoke handlers.

use std::path::PathBuf;

use openbitfun_runtime_ports::SessionStoragePathRequest;
use serde_json::{json, Value};

use crate::peer_host::args::{get_string, request_value};
use crate::peer_host::state::PeerHostState;
use crate::peer_host::workspace_dto::{workspace_info_to_json, workspace_list_to_json};

pub(crate) async fn initialize_workspace_startup_state(
    state: &PeerHostState,
) -> Result<Value, String> {
    let cleanup_removed_count = state
        .workspace_service
        .cleanup_invalid_workspaces()
        .await
        .map_err(|e| format!("Failed to cleanup invalid workspaces: {e}"))?;

    let current_workspace = state.workspace_service.get_current_workspace().await;
    let recent_workspaces = state.workspace_service.get_recent_workspaces().await;
    let opened_workspaces = state.workspace_service.get_opened_workspaces().await;

    Ok(json!({
        "cleanupRemovedCount": cleanup_removed_count,
        "currentWorkspace": current_workspace.as_ref().map(workspace_info_to_json),
        "recentWorkspaces": workspace_list_to_json(&recent_workspaces),
        "openedWorkspaces": workspace_list_to_json(&opened_workspaces),
        "legacyRemoteWorkspace": Value::Null,
    }))
}

pub(crate) async fn get_opened_workspaces(state: &PeerHostState) -> Result<Value, String> {
    let list = state.workspace_service.get_opened_workspaces().await;
    Ok(workspace_list_to_json(&list))
}

pub(crate) async fn get_recent_workspaces(state: &PeerHostState) -> Result<Value, String> {
    let list = state.workspace_service.get_recent_workspaces().await;
    Ok(workspace_list_to_json(&list))
}

pub(crate) async fn get_current_workspace(state: &PeerHostState) -> Result<Value, String> {
    let ws = state.workspace_service.get_current_workspace().await;
    Ok(ws
        .as_ref()
        .map(workspace_info_to_json)
        .unwrap_or(Value::Null))
}

pub(crate) async fn set_active_workspace(
    state: &PeerHostState,
    args: &Value,
) -> Result<Value, String> {
    let workspace_id = get_string(request_value(args), "workspaceId")?;
    state
        .workspace_service
        .set_active_workspace(&workspace_id)
        .await
        .map_err(|error| format!("Failed to activate workspace: {error}"))?;
    let workspace = state
        .workspace_service
        .get_current_workspace()
        .await
        .ok_or_else(|| "Active workspace not found after switching".to_string())?;
    Ok(workspace_info_to_json(&workspace))
}

pub(crate) async fn open_workspace(state: &PeerHostState, args: &Value) -> Result<Value, String> {
    let request = request_value(args);
    if let Some(id) = crate::peer_host::args::optional_string(request, "workspaceId") {
        let coordinator = openbitfun_core::agentic::coordination::get_global_coordinator()
            .ok_or("Conversation coordinator is unavailable")?;
        let info = coordinator
            .select_workspace_with_runtime_ownership(&state.workspace_service, &id)
            .await
            .map_err(|error| error.to_string())?;
        return Ok(workspace_info_to_json(&info));
    }
    // Explicit new-folder/old-protocol ingress. Existing-workspace selection uses ID.
    let path = get_string(request, "path")?;
    state
        .compatibility
        .ensure_workspace_runtime_ownership(&SessionStoragePathRequest {
            workspace_path: PathBuf::from(&path),
            remote_connection_id: None,
            remote_ssh_host: None,
        })
        .map_err(|error| format!("Agent Runtime ownership is unavailable: {error}"))?;
    let info = state
        .workspace_service
        .open_workspace(PathBuf::from(path))
        .await
        .map_err(|e| format!("Failed to open workspace: {e}"))?;

    // Best-effort snapshot init for agent tools (mirrors server bootstrap).
    if let Err(error) = state
        .local_workspace_snapshot
        .prepare_local_workspace(info.id.clone())
        .await
    {
        tracing::warn!("Failed to initialize snapshot system: {}", error.message);
    }

    Ok(workspace_info_to_json(&info))
}

pub(crate) async fn open_remote_workspace(
    state: &PeerHostState,
    args: &Value,
) -> Result<Value, String> {
    let request = request_value(args);
    let path = get_string(request, "remotePath")?;
    let connection_id = get_string(request, "connectionId")?;
    let host = crate::peer_host::args::optional_string(request, "sshHost");
    let coordinator = openbitfun_core::agentic::coordination::get_global_coordinator()
        .ok_or("Conversation coordinator is unavailable")?;
    let info = coordinator
        .create_remote_workspace_with_runtime_ownership(
            &state.workspace_service,
            &path,
            &connection_id,
            host.as_deref(),
        )
        .await
        .map_err(|e| e.to_string())?;
    Ok(workspace_info_to_json(&info))
}

pub(crate) async fn reload_config() -> Result<Value, String> {
    openbitfun_core::service::config::reload_global_config()
        .await
        .map_err(|e| format!("Failed to reload config: {e}"))?;
    Ok(json!("Configuration reloaded successfully"))
}

pub(crate) async fn cleanup_invalid_workspaces(state: &PeerHostState) -> Result<Value, String> {
    let removed = state
        .workspace_service
        .cleanup_invalid_workspaces()
        .await
        .map_err(|e| format!("Failed to cleanup invalid workspaces: {e}"))?;
    Ok(json!(removed))
}

pub(crate) async fn ssh_list_saved_connections() -> Result<Value, String> {
    let state =
        openbitfun_core::service::remote_ssh::workspace_state::ensure_saved_connection_services()
            .await?;
    let ssh = state
        .get_ssh_manager()
        .await
        .ok_or("SSH manager is unavailable")?;
    serde_json::to_value(ssh.get_saved_connections().await).map_err(|e| e.to_string())
}
