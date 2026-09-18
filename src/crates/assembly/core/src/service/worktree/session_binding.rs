//! Per-session worktree isolation.
//!
//! A session either executes in the project checkout or in a managed worktree
//! of the same repository. This module owns the transition between the two:
//! it creates or releases the worktree and rebinds the session in one step, so
//! callers never have to keep the two halves consistent themselves.
//!
//! Rebinding is only offered while a session is still empty. Once a transcript
//! exists it describes work done in a specific directory, and moving that
//! directory underneath it would silently invalidate the history.

use crate::agentic::coordination::get_global_coordinator;
use crate::agentic::keyed_lock::KeyedAsyncLock;
use crate::agentic::session::{SessionExecutionBindingError, SessionExecutionBindingUpdate};
use crate::service::worktree::{
    WorktreeCreateRequest, WorktreeListRequest, WorktreeRemoveRequest, WorktreeService,
};
use openbitfun_core_types::{
    SessionExecutionTarget, WorktreeError, WorktreeErrorCode, WorktreeLifecycle,
};
use serde::{Deserialize, Serialize};
use std::sync::LazyLock;

/// Serializes the complete Git-create/rebind/release transition for one session.
///
/// The SessionManager mutation lock closes the race with turn start, but it is
/// intentionally held only around the final session mutation. A separate lock
/// is needed here so concurrent adapters in one product runtime cannot both
/// preflight the same empty session, create different worktrees, and then
/// overwrite each other's binding.
static SESSION_BINDING_LOCKS: LazyLock<KeyedAsyncLock> = LazyLock::new(KeyedAsyncLock::default);

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct WorktreeSessionBindingRequest {
    pub request_id: String,
    pub session_id: String,
    /// Owning project workspace ID used to locate view-only or evicted
    /// persisted sessions. Authoritative when present.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub project_workspace_id: Option<String>,
    /// Legacy owner path for peers that predate workspace IDs.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub project_workspace_path: Option<String>,
    /// `true` moves the session into a managed worktree, `false` back to the project.
    pub enabled: bool,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct WorktreeSessionBindingResult {
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub project_workspace_id: Option<String>,
    pub session_id: String,
    pub workspace_path: String,
    pub project_workspace_path: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub workspace_id: Option<String>,
    pub execution_target: SessionExecutionTarget,
    /// Set when a released worktree was kept because it still held local work.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub retained_worktree_path: Option<String>,
}

/// Session facts the binding decision depends on.
struct SessionBindingContext {
    workspace_id: Option<String>,
    project_workspace_id: Option<String>,
    project_workspace_path: String,
    execution_target: SessionExecutionTarget,
    /// Why an actual transition is forbidden. An already-satisfied binding
    /// request remains a safe, read-only no-op even when this is set.
    transition_blocker: Option<WorktreeError>,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum SessionBindingAction {
    AlreadyBound,
    Enable,
    Disable,
}

fn error(code: WorktreeErrorCode, message: impl Into<String>) -> WorktreeError {
    WorktreeError {
        code,
        message: message.into(),
        recovery_path: None,
    }
}

async fn load_binding_context(
    request: &WorktreeSessionBindingRequest,
) -> Result<SessionBindingContext, WorktreeError> {
    let coordinator = get_global_coordinator().ok_or_else(|| {
        error(
            WorktreeErrorCode::IoFailed,
            "Session coordinator is not initialized",
        )
    })?;
    let session_manager = coordinator.get_session_manager();
    let session = session_manager.get_session(&request.session_id);

    let workspace_id;
    let project_workspace_id;
    let (workspace_path, project_workspace_path, execution_target, transition_blocker) =
        if let Some(mut session) = session {
            crate::agentic::workspace::normalize_session_workspace(&mut session.config)
                .await
                .map_err(|error_| error(WorktreeErrorCode::IoFailed, error_.to_string()))?;
            workspace_id = session.config.workspace_id.clone();
            project_workspace_id = session.config.project_workspace_id.clone();
            let transition_blocker = if !session.dialog_turn_ids.is_empty() {
                Some(error(
                    WorktreeErrorCode::WorktreeBusy,
                    "Worktree isolation can only be changed before the session's first message",
                ))
            } else if !matches!(session.state, crate::agentic::core::SessionState::Idle) {
                Some(error(
                    WorktreeErrorCode::WorktreeBusy,
                    "Worktree isolation cannot be changed while the session is processing",
                ))
            } else if session.config.is_remote_workspace() {
                Some(error(
                    WorktreeErrorCode::RemoteUnsupported,
                    "Managed worktrees are not supported for remote SSH workspaces yet",
                ))
            } else {
                None
            };

            let workspace_path = session.config.workspace_path.clone().ok_or_else(|| {
                error(
                    WorktreeErrorCode::InvalidPath,
                    "Session is not bound to a workspace",
                )
            })?;
            let project_workspace_path = session
                .config
                .project_workspace_path
                .clone()
                .unwrap_or_else(|| workspace_path.clone());
            let execution_target = session
                .config
                .execution_target
                .clone()
                .unwrap_or_else(|| SessionExecutionTarget::local(workspace_path.clone()));
            (
                workspace_path,
                project_workspace_path,
                execution_target,
                transition_blocker,
            )
        } else {
            let requested_project_workspace_id = request
                .project_workspace_id
                .as_deref()
                .map(str::trim)
                .filter(|id| !id.is_empty());
            let (project_workspace_path, session_storage_root) =
                match requested_project_workspace_id {
                    Some(requested_project_workspace_id) => {
                        use openbitfun_runtime_ports::SessionStorePort;
                        let workspace = crate::service::workspace::get_global_workspace_service()
                            .ok_or_else(|| {
                                error(
                                    WorktreeErrorCode::IoFailed,
                                    "Workspace service is not initialized",
                                )
                            })?
                            .require_workspace(requested_project_workspace_id)
                            .await
                            .map_err(|workspace_error| {
                                error(WorktreeErrorCode::InvalidPath, workspace_error.to_string())
                            })?;
                        let storage = crate::agentic::session::session_store_port::CoreSessionStorePort::default()
                        .resolve_workspace_storage(&workspace.id)
                        .await
                        .map_err(|storage_error| {
                            error(WorktreeErrorCode::IoFailed, storage_error.to_string())
                        })?;
                        (
                            workspace.root_path.to_string_lossy().into_owned(),
                            storage.effective_storage_path,
                        )
                    }
                    None => {
                        let path = request
                        .project_workspace_path
                        .as_deref()
                        .map(str::trim)
                        .filter(|path| !path.is_empty())
                        .ok_or_else(|| {
                            error(
                                WorktreeErrorCode::WorktreeNotFound,
                                format!(
                                    "Session not found: {}. The project workspace ID is required to restore historical sessions",
                                    request.session_id
                                ),
                            )
                        })?
                        .to_string();
                        (path.clone(), std::path::PathBuf::from(path))
                    }
                };
            let metadata = session_manager
                .load_session_metadata(&session_storage_root, &request.session_id)
                .await
                .map_err(|metadata_error| {
                    error(
                        WorktreeErrorCode::IoFailed,
                        format!("Failed to load session metadata: {metadata_error}"),
                    )
                })?
                .ok_or_else(|| {
                    error(
                        WorktreeErrorCode::WorktreeNotFound,
                        format!("Session not found: {}", request.session_id),
                    )
                })?;
            let mut config = crate::agentic::core::SessionConfig {
                workspace_id: metadata.workspace_id.clone(),
                project_workspace_id: metadata.project_workspace_id.clone(),
                workspace_path: metadata
                    .workspace_path
                    .clone()
                    .or_else(|| Some(project_workspace_path.clone())),
                project_workspace_path: metadata.project_workspace_path.clone(),
                remote_ssh_host: metadata.workspace_hostname.clone(),
                ..Default::default()
            };
            crate::agentic::workspace::normalize_session_workspace(&mut config)
                .await
                .map_err(|error_| error(WorktreeErrorCode::IoFailed, error_.to_string()))?;
            workspace_id = config.workspace_id.clone();
            project_workspace_id = config.project_workspace_id.clone();
            let transition_blocker = if metadata.turn_count > 0 {
                Some(error(
                    WorktreeErrorCode::WorktreeBusy,
                    "Worktree isolation can only be changed before the session's first message",
                ))
            } else if config.is_remote_workspace() {
                // The owning workspace record determines location after the
                // historical metadata has crossed the upgrade adapter.
                Some(error(
                    WorktreeErrorCode::RemoteUnsupported,
                    "Managed worktrees are not supported for remote SSH workspaces yet",
                ))
            } else {
                None
            };

            let workspace_path = metadata
                .workspace_path
                .clone()
                .unwrap_or_else(|| project_workspace_path.clone());
            let persisted_project_path = metadata
                .project_workspace_path
                .clone()
                .unwrap_or(project_workspace_path);
            let execution_target = metadata
                .execution_target
                .clone()
                .unwrap_or_else(|| SessionExecutionTarget::local(workspace_path.clone()));
            (
                workspace_path,
                persisted_project_path,
                execution_target,
                transition_blocker,
            )
        };

    if workspace_path.trim().is_empty() {
        return Err(error(
            WorktreeErrorCode::InvalidPath,
            "Session is not bound to a workspace",
        ));
    }

    Ok(SessionBindingContext {
        workspace_id,
        project_workspace_id,
        project_workspace_path,
        execution_target,
        transition_blocker,
    })
}

/// A persisted session names its workspace host; anything but the local host
/// marks the session as remote even when no SSH connection is registered.
fn binding_action(
    context: &SessionBindingContext,
    enabled: bool,
) -> Result<SessionBindingAction, WorktreeError> {
    let is_worktree = context.execution_target.worktree_id.is_some();
    if enabled == is_worktree {
        return Ok(SessionBindingAction::AlreadyBound);
    }

    if let Some(blocker) = context.transition_blocker.as_ref() {
        return Err(blocker.clone());
    }

    Ok(if enabled {
        SessionBindingAction::Enable
    } else {
        SessionBindingAction::Disable
    })
}

async fn rebind(
    session_id: &str,
    project_workspace_path: &str,
    execution_target: SessionExecutionTarget,
    workspace_id: Option<String>,
    project_workspace_id: Option<String>,
) -> Result<WorktreeSessionBindingResult, WorktreeError> {
    let coordinator = get_global_coordinator().ok_or_else(|| {
        error(
            WorktreeErrorCode::IoFailed,
            "Session coordinator is not initialized",
        )
    })?;
    let workspace_id = Some(workspace_id.ok_or_else(|| {
        error(
            WorktreeErrorCode::WorktreeNotFound,
            "Workspace ID is required for a session binding",
        )
    })?);

    coordinator
        .get_session_manager()
        .update_session_execution_binding(
            session_id,
            SessionExecutionBindingUpdate {
                workspace_path: execution_target.root_path.clone(),
                project_workspace_path: project_workspace_path.to_string(),
                workspace_id: workspace_id.clone(),
                execution_target: execution_target.clone(),
            },
        )
        .await
        .map_err(|session_error| match session_error {
            SessionExecutionBindingError::Busy(message) => {
                error(WorktreeErrorCode::WorktreeBusy, message)
            }
            SessionExecutionBindingError::NotFound(message) => {
                error(WorktreeErrorCode::WorktreeNotFound, message)
            }
            SessionExecutionBindingError::Internal(internal) => error(
                WorktreeErrorCode::IoFailed,
                format!("Failed to rebind session workspace: {internal}"),
            ),
        })?;

    Ok(WorktreeSessionBindingResult {
        project_workspace_id,
        session_id: session_id.to_string(),
        workspace_path: execution_target.root_path.clone(),
        project_workspace_path: project_workspace_path.to_string(),
        workspace_id,
        execution_target,
        retained_worktree_path: None,
    })
}

impl WorktreeService {
    /// Move a session into a fresh managed worktree, or back to the project checkout.
    ///
    /// Enabling is idempotent through `request_id`: a retried request replays the
    /// worktree that request already created instead of allocating another one.
    pub async fn bind_session(
        request: WorktreeSessionBindingRequest,
    ) -> Result<WorktreeSessionBindingResult, WorktreeError> {
        openbitfun_core_types::validate_session_id(&request.session_id)
            .map_err(|message| error(WorktreeErrorCode::InvalidPath, message))?;
        let _binding_guard = SESSION_BINDING_LOCKS.lock(&request.session_id).await;
        let context = load_binding_context(&request).await?;
        match binding_action(&context, request.enabled)? {
            SessionBindingAction::AlreadyBound => {
                // Already in the requested state; report it rather than churn Git.
                Ok(WorktreeSessionBindingResult {
                    project_workspace_id: context.project_workspace_id.clone(),
                    session_id: request.session_id,
                    workspace_path: context.execution_target.root_path.clone(),
                    project_workspace_path: context.project_workspace_path,
                    workspace_id: context.workspace_id.clone(),
                    execution_target: context.execution_target,
                    retained_worktree_path: None,
                })
            }
            SessionBindingAction::Enable => Self::enable_session_worktree(&request, &context).await,
            SessionBindingAction::Disable => {
                Self::disable_session_worktree(&request, &context).await
            }
        }
    }

    async fn enable_session_worktree(
        request: &WorktreeSessionBindingRequest,
        context: &SessionBindingContext,
    ) -> Result<WorktreeSessionBindingResult, WorktreeError> {
        let settings = Self::settings().await;
        let created = Self::create(WorktreeCreateRequest {
            request_id: request.request_id.clone(),
            project_workspace_id: None,
            project_workspace_path: context.project_workspace_path.clone(),
            source_workspace_path: Some(context.execution_target.root_path.clone()),
            base_ref: None,
            copy_local_changes: settings.copy_local_changes,
            // A bound session is the claim: it already blocks automatic removal.
            claimed_by: None,
        })
        .await?;

        let worktree_id = created.execution_target.worktree_id.clone();
        match rebind(
            &request.session_id,
            &created.worktree.project_workspace_path,
            created.execution_target,
            created.worktree.workspace_id.clone(),
            context.project_workspace_id.clone(),
        )
        .await
        {
            Ok(result) => Ok(result),
            Err(bind_error) => {
                // The worktree only exists to host this session; drop it again so a
                // failed toggle does not leave an orphan directory behind.
                if created.created {
                    if let Some(worktree_id) = worktree_id.as_deref() {
                        if let Err(rollback_error) =
                            Self::rollback_created(&context.project_workspace_path, worktree_id)
                                .await
                        {
                            log::warn!(
                                "Failed to roll back worktree {worktree_id} after a failed session rebind: {rollback_error}"
                            );
                        }
                    }
                }
                Err(bind_error)
            }
        }
    }

    async fn disable_session_worktree(
        request: &WorktreeSessionBindingRequest,
        context: &SessionBindingContext,
    ) -> Result<WorktreeSessionBindingResult, WorktreeError> {
        let worktree_id = context
            .execution_target
            .worktree_id
            .clone()
            .ok_or_else(|| {
                error(
                    WorktreeErrorCode::WorktreeNotFound,
                    "Session is not bound to a worktree",
                )
            })?;
        let worktree_path = context.execution_target.root_path.clone();

        // Detach first: removal safety checks count sessions still pointing here.
        let mut result = rebind(
            &request.session_id,
            &context.project_workspace_path,
            SessionExecutionTarget::local(context.project_workspace_path.clone()),
            context.project_workspace_id.clone(),
            context.project_workspace_id.clone(),
        )
        .await?;

        let removable = Self::list(WorktreeListRequest {
            project_workspace_id: None,
            project_workspace_path: context.project_workspace_path.clone(),
        })
        .await
        .ok()
        .and_then(|worktrees| {
            worktrees
                .into_iter()
                .find(|worktree| worktree.worktree_id == worktree_id)
        })
        .map(|worktree| {
            worktree.lifecycle == WorktreeLifecycle::Managed
                && !worktree.dirty
                && !worktree.has_unpublished_commits
                && !worktree.locked
                && !worktree.missing
                && worktree.associated_session_count == 0
        })
        .unwrap_or(false);

        if removable {
            match Self::remove(WorktreeRemoveRequest {
                request_id: request.request_id.clone(),
                project_workspace_id: None,
                project_workspace_path: context.project_workspace_path.clone(),
                worktree_id,
                force: false,
            })
            .await
            {
                Ok(_) => return Ok(result),
                Err(remove_error) => {
                    log::warn!("Released worktree could not be removed: {remove_error}");
                }
            }
        }

        result.retained_worktree_path = Some(worktree_path);
        Ok(result)
    }
}

#[cfg(test)]
mod tests {
    use super::{
        binding_action, error, SessionBindingAction, SessionBindingContext,
        WorktreeSessionBindingRequest, SESSION_BINDING_LOCKS,
    };
    use openbitfun_core_types::{SessionExecutionTarget, WorktreeErrorCode};
    use std::time::Duration;

    #[test]
    fn binding_request_keeps_legacy_callers_compatible() {
        let request: WorktreeSessionBindingRequest = serde_json::from_value(serde_json::json!({
            "requestId": "request-1",
            "sessionId": "session-1",
            "enabled": true
        }))
        .expect("legacy request should deserialize");

        assert_eq!(request.project_workspace_path, None);
    }

    #[test]
    fn binding_request_uses_a_cross_platform_project_locator() {
        let request: WorktreeSessionBindingRequest = serde_json::from_value(serde_json::json!({
            "requestId": "request-2",
            "sessionId": "session-2",
            "projectWorkspacePath": "D:\\workspace\\OpenBitFun",
            "enabled": false
        }))
        .expect("request should deserialize");

        assert_eq!(
            request.project_workspace_path.as_deref(),
            Some(r"D:\workspace\OpenBitFun")
        );
    }

    #[test]
    fn already_satisfied_binding_is_a_no_op_after_the_first_message() {
        let context = SessionBindingContext {
            workspace_id: Some("workspace".into()),
            project_workspace_id: Some("workspace".into()),
            project_workspace_path: "/repo".to_string(),
            execution_target: SessionExecutionTarget::local("/repo"),
            transition_blocker: Some(error(
                WorktreeErrorCode::WorktreeBusy,
                "Worktree isolation can only be changed before the session's first message",
            )),
        };

        assert_eq!(
            binding_action(&context, false),
            Ok(SessionBindingAction::AlreadyBound)
        );
        assert_eq!(
            binding_action(&context, true)
                .expect_err("an actual transition must stay blocked")
                .code,
            WorktreeErrorCode::WorktreeBusy
        );
    }

    #[tokio::test]
    async fn binding_transitions_for_the_same_session_are_serialized() {
        let session_id = format!("binding-lock-{}", uuid::Uuid::new_v4());
        let first = SESSION_BINDING_LOCKS.lock(&session_id).await;

        assert!(
            tokio::time::timeout(
                Duration::from_millis(20),
                SESSION_BINDING_LOCKS.lock(&session_id),
            )
            .await
            .is_err(),
            "a second transition must wait for the first"
        );

        drop(first);
        tokio::time::timeout(
            Duration::from_secs(1),
            SESSION_BINDING_LOCKS.lock(&session_id),
        )
        .await
        .expect("the next transition should proceed after release");
    }
}
