//! Upgrade-only adapter for session commands from pre-ID clients.
//! Normal callers use SessionStorePort::resolve_workspace_storage(workspace_id).
//! Remove with the pre-ID protocol; never use execution paths as storage fallbacks.
use crate::api::app_state::AppState;
use openbitfun_core::agentic::coordination::ConversationCoordinator;
use openbitfun_runtime_ports::SessionStorePort;

/// ID-first session storage resolution that also takes runtime ownership of
/// the owning workspace. `workspace_path` and the SSH fields are consulted
/// only when the caller is a pre-ID client that sent no `workspace_id`.
pub async fn desktop_session_storage_root(
    coordinator: &ConversationCoordinator,
    workspace_id: Option<&str>,
    workspace_path: Option<&str>,
    remote_connection_id: Option<&str>,
    remote_ssh_host: Option<&str>,
) -> Result<std::path::PathBuf, String> {
    let workspace_id = workspace_id.map(str::trim).filter(|id| !id.is_empty());
    let workspace_path = workspace_path
        .map(str::trim)
        .filter(|path| !path.is_empty());
    if workspace_id.is_none() && workspace_path.is_none() {
        return Err("workspace_id is required when the session is not loaded".to_string());
    }
    coordinator
        .session_storage_for_reference(
            workspace_id,
            workspace_path.unwrap_or(""),
            remote_connection_id,
            remote_ssh_host,
        )
        .await
        .map_err(|error| error.to_string())
}

pub async fn desktop_effective_session_storage_path(
    app_state: &AppState,
    workspace_path: &str,
    remote_connection_id: Option<&str>,
    remote_ssh_host: Option<&str>,
) -> Result<std::path::PathBuf, String> {
    let workspace = app_state
        .workspace_service
        .resolve_legacy_workspace_reference(
            None,
            workspace_path,
            remote_connection_id,
            remote_ssh_host,
        )
        .await
        .map_err(|error| error.to_string())?
        .ok_or_else(|| "Workspace ID is unavailable".to_string())?;
    openbitfun_core::agentic::session::CoreSessionStorePort::default()
        .resolve_workspace_storage(&workspace.id)
        .await
        .map(|resolution| resolution.effective_storage_path)
        .map_err(|error| error.to_string())
}
