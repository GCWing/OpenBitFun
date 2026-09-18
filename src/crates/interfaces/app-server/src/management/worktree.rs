//! App Server Worktree management operations.

use openbitfun_app_server_protocol::worktree::*;
use openbitfun_core::service::git::GitService;
use openbitfun_core::service::worktree::{WorktreeService, WorktreeSessionBindingRequest};
use openbitfun_runtime_ports::{AgentSessionWorkspaceBinding, WorktreeError, WorktreeErrorCode};

use super::{AppManagementError, AppManagementResult};

pub(crate) async fn repository_status(
    request: WorktreeRepositoryStatusRequest,
) -> AppManagementResult<WorktreeRepositoryStatusResponse> {
    if request.is_remote() {
        return Err(worktree_error(WorktreeOperationError {
            code: WorktreeErrorCode::RemoteUnsupported,
            message: "Repository status is not supported for remote workspaces".to_string(),
            recovery_path: None,
            operation_id: None,
        }));
    }

    let repository = match GitService::resolve_worktree_repository(&request.workspace_path).await {
        Ok(repository) => GitService::get_repository_basic(repository.query_path).await,
        Err(error) => Err(error),
    };
    match repository {
        Ok(repository) => Ok(WorktreeRepositoryStatusResponse {
            is_repository: true,
            current_branch: Some(repository.current_branch),
        }),
        Err(_) => Ok(WorktreeRepositoryStatusResponse {
            is_repository: false,
            current_branch: None,
        }),
    }
}

pub(crate) async fn bind_session(
    request: WorktreeBindSessionRequest,
) -> AppManagementResult<WorktreeBindingResponse> {
    transition(
        request.is_remote(),
        request.operation_id,
        request.session_id,
        request.project_workspace_id,
        request.project_workspace_path,
        true,
    )
    .await
}

pub(crate) async fn release_session(
    request: WorktreeReleaseSessionRequest,
) -> AppManagementResult<WorktreeBindingResponse> {
    transition(
        request.is_remote(),
        request.operation_id,
        request.session_id,
        request.project_workspace_id,
        request.project_workspace_path,
        false,
    )
    .await
}

async fn transition(
    remote: bool,
    operation_id: String,
    session_id: String,
    project_workspace_id: Option<String>,
    project_workspace_path: Option<String>,
    enabled: bool,
) -> AppManagementResult<WorktreeBindingResponse> {
    validate_operation_id(&operation_id)?;
    if remote {
        return Err(worktree_error(WorktreeOperationError {
            code: WorktreeErrorCode::RemoteUnsupported,
            message: "Managed worktrees are not supported for remote workspaces".to_string(),
            recovery_path: None,
            operation_id: Some(operation_id),
        }));
    }

    let result = WorktreeService::bind_session(WorktreeSessionBindingRequest {
        request_id: operation_id.clone(),
        session_id,
        project_workspace_id,
        project_workspace_path,
        enabled,
    })
    .await
    .map_err(|error| worktree_error(project_error(error, Some(operation_id.clone()))))?;
    let execution_target = result.execution_target.clone();
    Ok(WorktreeBindingResponse {
        workspace_binding: AgentSessionWorkspaceBinding {
            workspace_kind: Some(openbitfun_core::service::workspace::WorkspaceKind::Normal),
            project_workspace_id: result.project_workspace_id,
            workspace_id: result.workspace_id,
            workspace_path: result.workspace_path,
            project_workspace_path: Some(result.project_workspace_path),
            execution_target: Some(execution_target),
            remote_connection_id: None,
            remote_ssh_host: None,
        },
        retained_worktree_path: result.retained_worktree_path,
    })
}

fn validate_operation_id(operation_id: &str) -> AppManagementResult<()> {
    if !operation_id.trim().is_empty()
        && operation_id.len() <= 160
        && operation_id
            .bytes()
            .all(|byte| byte.is_ascii_alphanumeric() || matches!(byte, b'-' | b'_' | b'.'))
    {
        Ok(())
    } else {
        Err(AppManagementError::invalid_request(
            "Worktree operation ID is invalid",
        ))
    }
}

fn project_error(error: WorktreeError, operation_id: Option<String>) -> WorktreeOperationError {
    WorktreeOperationError {
        code: error.code,
        message: error.message,
        recovery_path: error.recovery_path,
        operation_id,
    }
}

fn worktree_error(error: WorktreeOperationError) -> AppManagementError {
    AppManagementError::internal(error.encode())
}
