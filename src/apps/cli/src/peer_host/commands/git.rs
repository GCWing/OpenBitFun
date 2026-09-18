//! Git HostInvoke handlers for CLI Peer Host.

use serde_json::{json, Value};

use openbitfun_core::service::git::GitService;

use crate::peer_host::args::{optional_string, request_value};

async fn repository_path_for_workspace(request: &Value) -> Result<String, String> {
    let service = openbitfun_core::service::workspace::get_global_workspace_service()
        .ok_or("Workspace service is unavailable")?;
    let path = optional_string(request, "repositoryPath").unwrap_or_default();
    let workspace = match optional_string(request, "workspaceId") {
        Some(id) => service
            .require_workspace(&id)
            .await
            .map_err(|e| e.to_string())?,
        None => service
            .resolve_legacy_workspace_reference(None, &path, None, None)
            .await
            .map_err(|e| e.to_string())?
            .ok_or("Legacy Git workspace cannot be resolved; select a workspace by ID")?,
    };
    if workspace.workspace_kind == openbitfun_core::service::workspace::WorkspaceKind::Remote {
        return Err("CLI peer Git inspection does not support remote workspaces".into());
    }
    Ok(
        if optional_string(request, "workspaceId").is_some() || path.is_empty() {
            workspace.root_path.to_string_lossy().into_owned()
        } else {
            path
        },
    )
}

pub(crate) async fn git_is_repository(args: &Value) -> Result<Value, String> {
    let request = request_value(args);
    let repository_path = repository_path_for_workspace(request).await?;
    let is_repo = GitService::is_repository(&repository_path)
        .await
        .map_err(|e| {
            tracing::error!("Failed to check Git repository: path={repository_path}, error={e}");
            format!("Failed to check Git repository: {e}")
        })?;
    Ok(json!(is_repo))
}

/// Read-only ownership-trust probe.
///
/// Granting trust writes to the host user's global Git configuration, so that
/// decision stays on surfaces where the user is at the machine; a controller
/// only gets the diagnosis and the manual command.
pub(crate) async fn git_get_repository_trust(args: &Value) -> Result<Value, String> {
    let request = request_value(args);
    let repository_path = repository_path_for_workspace(request).await?;
    let report = GitService::inspect_trust(&repository_path)
        .await
        .map_err(|e| {
            tracing::error!(
                "Failed to inspect Git repository trust: path={repository_path}, error={e}"
            );
            format!("Failed to inspect Git repository trust: {e}")
        })?;
    serde_json::to_value(report).map_err(|e| format!("Failed to serialize trust report: {e}"))
}
