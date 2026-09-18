//! Thin desktop adapter for product-owned managed worktrees.
//!
//! The owning project workspace is identified by its workspace ID. The
//! adapter resolves that ID to the authoritative workspace record, rejects
//! remote workspaces from `workspace_kind`, and only then hands the record's
//! local root path to the worktree service as a Git IO operand. A path-only
//! request is a legacy shape and is resolved through the workspace
//! legacy-compat boundary.

use openbitfun_core::service::workspace::{get_global_workspace_service, WorkspaceKind};
use openbitfun_core::service::worktree::{
    WorktreeCreateBranchRequest, WorktreeCreateRequest, WorktreeCreateResult, WorktreeListRequest,
    WorktreeMutationResult, WorktreeProjectListRequest, WorktreeProjectSummary,
    WorktreePromoteRequest, WorktreeRecreateRequest, WorktreeRemoveRequest, WorktreeRemoveResult,
    WorktreeService, WorktreeSessionBindingRequest, WorktreeSessionBindingResult,
};
use openbitfun_core_types::{WorktreeError, WorktreeErrorCode, WorktreeSummary};

fn remote_unsupported() -> WorktreeError {
    WorktreeError {
        code: WorktreeErrorCode::RemoteUnsupported,
        message: "Managed worktrees are not supported for remote SSH workspaces yet".to_string(),
        recovery_path: None,
    }
}

fn invalid_project(message: impl Into<String>) -> WorktreeError {
    WorktreeError {
        code: WorktreeErrorCode::InvalidPath,
        message: message.into(),
        recovery_path: None,
    }
}

/// Resolve the local project root that owns a managed-worktree request.
///
/// Returns the authoritative root path from the workspace record when an ID is
/// supplied. Without an ID the legacy path is accepted only if it does not
/// resolve to a remote workspace record; an ambiguous legacy path fails loudly.
async fn resolve_local_project(
    project_workspace_id: Option<&str>,
    project_workspace_path: &str,
) -> Result<String, WorktreeError> {
    let project_workspace_id = project_workspace_id
        .map(str::trim)
        .filter(|id| !id.is_empty());
    let Some(service) = get_global_workspace_service() else {
        if project_workspace_id.is_some() {
            return Err(invalid_project(
                "Workspace service is not initialized; cannot resolve the project workspace",
            ));
        }
        return Ok(project_workspace_path.to_string());
    };
    match project_workspace_id {
        Some(id) => {
            let workspace = service
                .require_workspace(id)
                .await
                .map_err(|error| invalid_project(error.to_string()))?;
            if workspace.workspace_kind == WorkspaceKind::Remote {
                return Err(remote_unsupported());
            }
            Ok(workspace.root_path.to_string_lossy().into_owned())
        }
        None => {
            let trimmed = project_workspace_path.trim();
            if trimmed.is_empty() {
                return Err(invalid_project(
                    "A project workspace ID is required for managed worktrees",
                ));
            }
            match service
                .resolve_legacy_workspace_reference(None, trimmed, None, None)
                .await
                .map_err(|error| invalid_project(error.to_string()))?
            {
                Some(workspace) if workspace.workspace_kind == WorkspaceKind::Remote => {
                    Err(remote_unsupported())
                }
                Some(workspace) => Ok(workspace.root_path.to_string_lossy().into_owned()),
                // Not an open workspace: a plain local repository path handed
                // in by a pre-ID client. Remote paths always have a record.
                None => Ok(trimmed.to_string()),
            }
        }
    }
}

#[tauri::command]
pub async fn worktree_list(
    mut request: WorktreeListRequest,
) -> Result<Vec<WorktreeSummary>, WorktreeError> {
    request.project_workspace_path = resolve_local_project(
        request.project_workspace_id.as_deref(),
        &request.project_workspace_path,
    )
    .await?;
    WorktreeService::list(request).await
}

#[tauri::command]
pub async fn worktree_list_projects(
    request: WorktreeProjectListRequest,
) -> Result<Vec<WorktreeProjectSummary>, WorktreeError> {
    WorktreeService::list_projects(request).await
}

#[tauri::command]
pub async fn worktree_create(
    mut request: WorktreeCreateRequest,
) -> Result<WorktreeCreateResult, WorktreeError> {
    request.project_workspace_path = resolve_local_project(
        request.project_workspace_id.as_deref(),
        &request.project_workspace_path,
    )
    .await?;
    WorktreeService::create(request).await
}

#[tauri::command]
pub async fn worktree_create_branch(
    mut request: WorktreeCreateBranchRequest,
) -> Result<WorktreeMutationResult, WorktreeError> {
    request.project_workspace_path = resolve_local_project(
        request.project_workspace_id.as_deref(),
        &request.project_workspace_path,
    )
    .await?;
    WorktreeService::create_branch(request).await
}

#[tauri::command]
pub async fn worktree_promote(
    mut request: WorktreePromoteRequest,
) -> Result<WorktreeMutationResult, WorktreeError> {
    request.project_workspace_path = resolve_local_project(
        request.project_workspace_id.as_deref(),
        &request.project_workspace_path,
    )
    .await?;
    WorktreeService::promote(request).await
}

#[tauri::command]
pub async fn worktree_remove(
    mut request: WorktreeRemoveRequest,
) -> Result<WorktreeRemoveResult, WorktreeError> {
    request.project_workspace_path = resolve_local_project(
        request.project_workspace_id.as_deref(),
        &request.project_workspace_path,
    )
    .await?;
    WorktreeService::remove(request).await
}

/// Toggle worktree isolation for a single session. The optional project
/// workspace ID lets the product layer locate view-only persisted sessions;
/// remote checks and repository resolution remain in that shared layer.
#[tauri::command]
pub async fn worktree_bind_session(
    request: WorktreeSessionBindingRequest,
) -> Result<WorktreeSessionBindingResult, WorktreeError> {
    WorktreeService::bind_session(request).await
}

#[tauri::command]
pub async fn worktree_recreate(
    mut request: WorktreeRecreateRequest,
) -> Result<WorktreeMutationResult, WorktreeError> {
    request.project_workspace_path = resolve_local_project(
        request.project_workspace_id.as_deref(),
        &request.project_workspace_path,
    )
    .await?;
    WorktreeService::recreate(request).await
}
