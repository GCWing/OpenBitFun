//! Compatibility facade for review-platform operations.
//!
//! Provider detection, provider DTO mapping, token persistence, and HTTP/Git
//! integration logic live in `openbitfun-services-integrations::review_platform`.
//! Core only preserves the legacy static API, injects OpenBitFun storage paths, and
//! connects the product remote-workspace classifier.

use crate::infrastructure::try_get_path_manager_arc;
use std::sync::Arc;

pub use openbitfun_services_integrations::review_platform::{
    classify_git_command_failure, untrusted_repository_error_message, ReviewAuthSource,
    ReviewAuthState, ReviewChecks, ReviewDecision, ReviewEvidenceCompleteness, ReviewFileStatus,
    ReviewItemState, ReviewPlatformAccount, ReviewPlatformActionResult,
    ReviewPlatformApprovalRequest, ReviewPlatformAuthChallenge, ReviewPlatformAuthChallengeState,
    ReviewPlatformCapabilities, ReviewPlatformCiItem, ReviewPlatformCiLog, ReviewPlatformCommit,
    ReviewPlatformCreatePullRequestRequest, ReviewPlatformDetailSection, ReviewPlatformError,
    ReviewPlatformFile, ReviewPlatformIssueComment, ReviewPlatformIssueEvidence,
    ReviewPlatformKind, ReviewPlatformListState, ReviewPlatformPullRequest,
    ReviewPlatformPullRequestDetail, ReviewPlatformPullRequestDetailPage,
    ReviewPlatformPullRequestFileDiff, ReviewPlatformPullRequestReviewTarget, ReviewPlatformRemote,
    ReviewPlatformReplyToThreadRequest, ReviewPlatformRepositoryRef,
    ReviewPlatformRequestChangesRequest, ReviewPlatformResolveThreadRequest,
    ReviewPlatformSubmitReviewRequest, ReviewPlatformThread, ReviewPlatformThreadKind,
    ReviewPlatformWorkspaceSnapshot, ReviewRepositoryLocator, ReviewSubmitEvent,
};

use crate::service::workspace::{WorkspaceInfo, WorkspaceKind};
use openbitfun_services_integrations::review_platform::{
    ReviewGitExecution, ReviewPlatformService as ReviewPlatformOwnerService,
    ReviewPlatformWorkspaceClassifier, ReviewRemoteGitTarget, REVIEW_PLATFORM_TOKEN_FILE_NAME,
};

pub struct ReviewPlatformService;

struct CoreReviewPlatformWorkspaceClassifier;

/// Resolves the workspace record that owns a review repository locator.
///
/// An explicit `workspace_id` is authoritative. A legacy path-only locator is
/// only accepted through the workspace legacy-compat boundary, which fails on
/// ambiguous paths instead of guessing a connection.
async fn resolve_review_workspace(
    repository: &ReviewRepositoryLocator,
) -> Result<Option<WorkspaceInfo>, ReviewPlatformError> {
    let Some(service) = crate::service::workspace::get_global_workspace_service() else {
        if repository.workspace_id.is_some() {
            return Err(ReviewPlatformError::InvalidRepository(
                "Workspace service is not initialized; cannot resolve the review workspace"
                    .to_string(),
            ));
        }
        return Ok(None);
    };
    match repository.workspace_id.as_deref() {
        Some(workspace_id) => service
            .require_workspace(workspace_id)
            .await
            .map(Some)
            .map_err(|error| ReviewPlatformError::InvalidRepository(error.to_string())),
        None => service
            .resolve_legacy_workspace_reference(None, &repository.repository_path, None, None)
            .await
            .map_err(|error| ReviewPlatformError::InvalidRepository(error.to_string())),
    }
}

fn remote_git_target(
    workspace: &WorkspaceInfo,
) -> Result<ReviewRemoteGitTarget, ReviewPlatformError> {
    let connection_id = workspace
        .remote_ssh_connection_id()
        .filter(|id| !id.is_empty())
        .ok_or_else(|| {
            ReviewPlatformError::InvalidRepository(format!(
                "Remote workspace {} has no SSH connection bound to it",
                workspace.id
            ))
        })?;
    Ok(ReviewRemoteGitTarget {
        workspace_id: workspace.id.clone(),
        connection_id: connection_id.to_string(),
    })
}

#[async_trait::async_trait]
impl ReviewPlatformWorkspaceClassifier for CoreReviewPlatformWorkspaceClassifier {
    /// Classification is keyed by the owning workspace record: `workspace_kind`
    /// decides local vs. remote and the record's SSH connection carries remote
    /// Git probes. A legacy path that is not bound to any open workspace runs
    /// locally only when no remote registry claims it; a remote path without a
    /// workspace record is rejected instead of guessing a connection.
    async fn classify_repository(
        &self,
        repository: &ReviewRepositoryLocator,
    ) -> Result<ReviewGitExecution, ReviewPlatformError> {
        if let Some(workspace) = resolve_review_workspace(repository).await? {
            return if workspace.workspace_kind == WorkspaceKind::Remote {
                remote_git_target(&workspace).map(ReviewGitExecution::Remote)
            } else {
                Ok(ReviewGitExecution::Local)
            };
        }

        #[cfg(any(feature = "remote-workspace", feature = "agent-runtime"))]
        {
            if crate::service::remote_ssh::workspace_state::is_remote_path(
                &repository.repository_path,
            )
            .await
            {
                return Err(ReviewPlatformError::InvalidRepository(format!(
                    "Remote repository path {} is not bound to an open workspace; select the workspace by its ID",
                    repository.repository_path
                )));
            }
        }
        Ok(ReviewGitExecution::Local)
    }

    async fn execute_remote_git_command(
        &self,
        target: &ReviewRemoteGitTarget,
        current_dir: &str,
        args: &[&str],
    ) -> Result<String, ReviewPlatformError> {
        #[cfg(feature = "remote-workspace")]
        {
            use crate::service::remote_ssh::workspace_state::get_remote_workspace_manager;
            use openbitfun_services_integrations::remote_ssh::{
                build_remote_git_command, normalize_remote_workspace_path,
            };

            let manager = match get_remote_workspace_manager() {
                Some(state) => state.get_ssh_manager().await,
                None => None,
            }
            .ok_or_else(|| {
                ReviewPlatformError::InvalidRepository(
                    "SSH connection manager is not initialized for remote workspaces".to_string(),
                )
            })?;

            let command =
                build_remote_git_command(&normalize_remote_workspace_path(current_dir), args);
            let (stdout, stderr, exit_code) = manager
                .execute_command(&target.connection_id, &command)
                .await
                .map_err(|error| {
                    ReviewPlatformError::InvalidRepository(format!(
                        "Failed to execute git command on remote workspace {}: {error}",
                        target.workspace_id
                    ))
                })?;

            if exit_code == 0 {
                return Ok(stdout);
            }
            let message = if stderr.trim().is_empty() {
                stdout
            } else {
                stderr
            };
            return Err(classify_git_command_failure(
                current_dir,
                message.trim().to_string(),
            ));
        }
        #[cfg(not(feature = "remote-workspace"))]
        {
            let _ = (current_dir, args);
            Err(ReviewPlatformError::InvalidRepository(format!(
                "Remote workspaces are not compiled into this OpenBitFun host (feature `remote-workspace`); refusing to run Git against the local filesystem for remote workspace {}",
                target.workspace_id
            )))
        }
    }
}

fn owner_service() -> Result<ReviewPlatformOwnerService, ReviewPlatformError> {
    let path_manager =
        try_get_path_manager_arc().map_err(|error| ReviewPlatformError::Api(error.to_string()))?;
    Ok(ReviewPlatformOwnerService::new(
        path_manager
            .user_data_dir()
            .join(REVIEW_PLATFORM_TOKEN_FILE_NAME),
        Arc::new(CoreReviewPlatformWorkspaceClassifier),
    ))
}

impl ReviewPlatformService {
    pub async fn discover_remotes(
        repository: &ReviewRepositoryLocator,
    ) -> Result<Vec<ReviewPlatformRemote>, ReviewPlatformError> {
        owner_service()?.discover_remotes(repository).await
    }

    pub async fn workspace_snapshot(
        repository: &ReviewRepositoryLocator,
        remote_id: Option<&str>,
        page: Option<u32>,
        per_page: Option<u32>,
    ) -> Result<ReviewPlatformWorkspaceSnapshot, ReviewPlatformError> {
        owner_service()?
            .workspace_snapshot(repository, remote_id, page, per_page)
            .await
    }

    pub async fn workspace_context(
        repository: &ReviewRepositoryLocator,
        remote_id: Option<&str>,
    ) -> Result<ReviewPlatformWorkspaceSnapshot, ReviewPlatformError> {
        owner_service()?
            .workspace_context(repository, remote_id)
            .await
    }

    pub async fn workspace_snapshot_with_state(
        repository: &ReviewRepositoryLocator,
        remote_id: Option<&str>,
        page: Option<u32>,
        per_page: Option<u32>,
        state: ReviewPlatformListState,
    ) -> Result<ReviewPlatformWorkspaceSnapshot, ReviewPlatformError> {
        owner_service()?
            .workspace_snapshot_with_state(repository, remote_id, page, per_page, state)
            .await
    }

    pub async fn pull_request_detail(
        repository: &ReviewRepositoryLocator,
        remote_id: &str,
        pull_request_id: &str,
    ) -> Result<ReviewPlatformPullRequestDetail, ReviewPlatformError> {
        owner_service()?
            .pull_request_detail(repository, remote_id, pull_request_id)
            .await
    }

    pub async fn pull_request_review_target(
        repository: &ReviewRepositoryLocator,
        remote_id: &str,
        pull_request_id: &str,
    ) -> Result<ReviewPlatformPullRequestReviewTarget, ReviewPlatformError> {
        owner_service()?
            .pull_request_review_target(repository, remote_id, pull_request_id)
            .await
    }

    pub async fn issue(
        platform: ReviewPlatformKind,
        host: &str,
        project_path: &str,
        issue_id: &str,
        page: Option<u32>,
        per_page: Option<u32>,
        repository: Option<&ReviewRepositoryLocator>,
    ) -> Result<ReviewPlatformIssueEvidence, ReviewPlatformError> {
        owner_service()?
            .issue(
                platform,
                host,
                project_path,
                issue_id,
                page,
                per_page,
                repository,
            )
            .await
    }

    pub async fn pull_request_review_target_by_identity(
        platform: ReviewPlatformKind,
        host: &str,
        project_path: &str,
        pull_request_id: &str,
        repository: Option<&ReviewRepositoryLocator>,
    ) -> Result<ReviewPlatformPullRequestReviewTarget, ReviewPlatformError> {
        owner_service()?
            .pull_request_review_target_by_identity(
                platform,
                host,
                project_path,
                pull_request_id,
                repository,
            )
            .await
    }

    #[allow(clippy::too_many_arguments)]
    pub async fn pull_request_file_diff_by_identity(
        platform: ReviewPlatformKind,
        host: &str,
        project_path: &str,
        pull_request_id: &str,
        expected_base_revision: &str,
        expected_head_revision: &str,
        file_path: &str,
        file_page_hint: Option<u32>,
        repository: Option<&ReviewRepositoryLocator>,
    ) -> Result<ReviewPlatformPullRequestFileDiff, ReviewPlatformError> {
        owner_service()?
            .pull_request_file_diff_by_identity(
                platform,
                host,
                project_path,
                pull_request_id,
                expected_base_revision,
                expected_head_revision,
                file_path,
                file_page_hint,
                repository,
            )
            .await
    }

    pub async fn pull_request_file_diff(
        repository: &ReviewRepositoryLocator,
        remote_id: &str,
        pull_request_id: &str,
        expected_base_revision: &str,
        expected_head_revision: &str,
        file_path: &str,
        file_page_hint: Option<u32>,
    ) -> Result<ReviewPlatformPullRequestFileDiff, ReviewPlatformError> {
        owner_service()?
            .pull_request_file_diff(
                repository,
                remote_id,
                pull_request_id,
                expected_base_revision,
                expected_head_revision,
                file_path,
                file_page_hint,
            )
            .await
    }

    pub async fn pull_request_detail_page(
        repository: &ReviewRepositoryLocator,
        remote_id: &str,
        pull_request_id: &str,
        section: ReviewPlatformDetailSection,
        page: Option<u32>,
        per_page: Option<u32>,
    ) -> Result<ReviewPlatformPullRequestDetailPage, ReviewPlatformError> {
        owner_service()?
            .pull_request_detail_page(
                repository,
                remote_id,
                pull_request_id,
                section,
                page,
                per_page,
            )
            .await
    }

    pub async fn pull_request_ci_log(
        repository: &ReviewRepositoryLocator,
        remote_id: &str,
        pull_request_id: &str,
        ci_item_id: &str,
        ci_item_name: &str,
    ) -> Result<ReviewPlatformCiLog, ReviewPlatformError> {
        owner_service()?
            .pull_request_ci_log(
                repository,
                remote_id,
                pull_request_id,
                ci_item_id,
                ci_item_name,
            )
            .await
    }

    pub async fn create_pull_request(
        request: ReviewPlatformCreatePullRequestRequest,
    ) -> Result<ReviewPlatformActionResult, ReviewPlatformError> {
        owner_service()?.create_pull_request(request).await
    }

    pub async fn reply_to_thread(
        request: ReviewPlatformReplyToThreadRequest,
    ) -> Result<ReviewPlatformActionResult, ReviewPlatformError> {
        owner_service()?.reply_to_thread(request).await
    }

    pub async fn submit_review(
        request: ReviewPlatformSubmitReviewRequest,
    ) -> Result<ReviewPlatformActionResult, ReviewPlatformError> {
        owner_service()?.submit_review(request).await
    }

    pub async fn resolve_thread(
        request: ReviewPlatformResolveThreadRequest,
    ) -> Result<ReviewPlatformActionResult, ReviewPlatformError> {
        owner_service()?.resolve_thread(request).await
    }

    pub async fn approve_pull_request(
        request: ReviewPlatformApprovalRequest,
    ) -> Result<ReviewPlatformActionResult, ReviewPlatformError> {
        owner_service()?.approve_pull_request(request).await
    }

    pub async fn revoke_approval(
        request: ReviewPlatformApprovalRequest,
    ) -> Result<ReviewPlatformActionResult, ReviewPlatformError> {
        owner_service()?.revoke_approval(request).await
    }

    pub async fn request_changes(
        request: ReviewPlatformRequestChangesRequest,
    ) -> Result<ReviewPlatformActionResult, ReviewPlatformError> {
        owner_service()?.request_changes(request).await
    }

    pub async fn update_auth_token(
        platform: ReviewPlatformKind,
        host: &str,
        token: &str,
    ) -> Result<(), ReviewPlatformError> {
        owner_service()?
            .update_auth_token(platform, host, token)
            .await
    }

    pub async fn clear_auth_token(
        platform: ReviewPlatformKind,
        host: &str,
    ) -> Result<(), ReviewPlatformError> {
        owner_service()?.clear_auth_token(platform, host).await
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[cfg(feature = "remote-workspace")]
    #[tokio::test]
    async fn remote_git_execution_fails_loudly_without_ssh_manager() {
        let classifier = CoreReviewPlatformWorkspaceClassifier;

        let error = classifier
            .execute_remote_git_command(
                &ReviewRemoteGitTarget {
                    workspace_id: "ws-unregistered".to_string(),
                    connection_id: "conn-unregistered".to_string(),
                },
                "/openbitfun-tests/unregistered-remote-workspace",
                &["remote", "-v"],
            )
            .await
            .expect_err("unregistered remote workspaces must not silently succeed");

        let message = error.to_string();
        assert!(
            message.contains("SSH connection manager is not initialized")
                || message.contains("Failed to execute git command on remote workspace"),
            "unexpected error message: {message}"
        );
    }

    #[cfg(not(feature = "remote-workspace"))]
    #[tokio::test]
    async fn remote_git_execution_fails_loudly_without_remote_workspace_capability() {
        let classifier = CoreReviewPlatformWorkspaceClassifier;

        let error = classifier
            .execute_remote_git_command(
                &ReviewRemoteGitTarget {
                    workspace_id: "ws-remote".to_string(),
                    connection_id: "conn".to_string(),
                },
                "/remote/project",
                &["status"],
            )
            .await
            .expect_err("a narrow review-platform build must reject remote execution");

        assert!(error
            .to_string()
            .contains("Remote workspaces are not compiled into this OpenBitFun host"));
    }

    #[tokio::test]
    async fn unknown_workspace_id_is_rejected_instead_of_falling_back_to_path() {
        let classifier = CoreReviewPlatformWorkspaceClassifier;
        let result = classifier
            .classify_repository(&ReviewRepositoryLocator::new(
                Some("ws-does-not-exist".to_string()),
                "/tmp/some-local-repo",
            ))
            .await;
        assert!(
            result.is_err(),
            "an explicit but unknown workspace ID must not degrade to path classification"
        );
    }
}
