//! Review platform Tauri commands.

use crate::api::app_state::AppState;
use log::error;
use openbitfun_core::service::review_platform::{
    untrusted_repository_error_message, ReviewPlatformCiLog, ReviewPlatformDetailSection,
    ReviewPlatformError, ReviewPlatformIssueEvidence, ReviewPlatformKind, ReviewPlatformListState,
    ReviewPlatformPullRequestDetail, ReviewPlatformPullRequestDetailPage,
    ReviewPlatformPullRequestReviewTarget, ReviewPlatformService, ReviewPlatformWorkspaceSnapshot,
    ReviewRepositoryLocator,
};
use serde::Deserialize;
use tauri::State;

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ReviewPlatformWorkspaceSnapshotRequest {
    /// Owning workspace ID; authoritative for local/remote Git routing.
    #[serde(default)]
    pub workspace_id: Option<String>,
    pub repository_path: String,
    pub remote_id: Option<String>,
    pub page: Option<u32>,
    pub per_page: Option<u32>,
    #[serde(default)]
    pub state: ReviewPlatformListState,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ReviewPlatformWorkspaceContextRequest {
    #[serde(default)]
    pub workspace_id: Option<String>,
    pub repository_path: String,
    pub remote_id: Option<String>,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ReviewPlatformPullRequestDetailRequest {
    #[serde(default)]
    pub workspace_id: Option<String>,
    pub repository_path: String,
    pub remote_id: String,
    pub pull_request_id: String,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ReviewPlatformPullRequestDetailPageRequest {
    #[serde(default)]
    pub workspace_id: Option<String>,
    pub repository_path: String,
    pub remote_id: String,
    pub pull_request_id: String,
    pub section: ReviewPlatformDetailSection,
    pub page: Option<u32>,
    pub per_page: Option<u32>,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ReviewPlatformPullRequestCiLogRequest {
    #[serde(default)]
    pub workspace_id: Option<String>,
    pub repository_path: String,
    pub remote_id: String,
    pub pull_request_id: String,
    pub ci_item_id: String,
    pub ci_item_name: String,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ReviewPlatformUpdateAuthTokenRequest {
    pub platform: ReviewPlatformKind,
    pub host: String,
    pub token: String,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ReviewPlatformClearAuthTokenRequest {
    pub platform: ReviewPlatformKind,
    pub host: String,
}

fn review_repository(
    workspace_id: &Option<String>,
    repository_path: &str,
) -> ReviewRepositoryLocator {
    ReviewRepositoryLocator::new(workspace_id.clone(), repository_path)
}

fn optional_review_repository(
    workspace_id: &Option<String>,
    repository_path: Option<&str>,
) -> Option<ReviewRepositoryLocator> {
    repository_path.map(|path| ReviewRepositoryLocator::new(workspace_id.clone(), path))
}

#[tauri::command]
pub async fn review_platform_get_workspace_snapshot(
    _state: State<'_, AppState>,
    request: ReviewPlatformWorkspaceSnapshotRequest,
) -> Result<ReviewPlatformWorkspaceSnapshot, String> {
    ReviewPlatformService::workspace_snapshot_with_state(
        &review_repository(&request.workspace_id, &request.repository_path),
        request.remote_id.as_deref(),
        request.page,
        request.per_page,
        request.state,
    )
    .await
    .map_err(|error| {
        error!(
            "Failed to get review platform workspace snapshot: path={}, remote_id={:?}, error={}",
            request.repository_path, request.remote_id, error
        );
        review_platform_command_error("Failed to get review platform workspace snapshot", &error)
    })
}

#[tauri::command]
pub async fn review_platform_get_workspace_context(
    _state: State<'_, AppState>,
    request: ReviewPlatformWorkspaceContextRequest,
) -> Result<ReviewPlatformWorkspaceSnapshot, String> {
    ReviewPlatformService::workspace_context(
        &review_repository(&request.workspace_id, &request.repository_path),
        request.remote_id.as_deref(),
    )
    .await
    .map_err(|error| {
        error!(
            "Failed to get review platform workspace context: path={}, remote_id={:?}, error={}",
            request.repository_path, request.remote_id, error
        );
        review_platform_command_error("Failed to get review platform workspace context", &error)
    })
}

#[tauri::command]
pub async fn review_platform_get_pull_request_detail(
    _state: State<'_, AppState>,
    request: ReviewPlatformPullRequestDetailRequest,
) -> Result<ReviewPlatformPullRequestDetail, String> {
    ReviewPlatformService::pull_request_detail(
        &review_repository(&request.workspace_id, &request.repository_path),
        &request.remote_id,
        &request.pull_request_id,
    )
    .await
    .map_err(|error| {
        error!(
            "Failed to get review platform pull request detail: path={}, remote_id={}, pull_request_id={}, error={}",
            request.repository_path,
            request.remote_id,
            request.pull_request_id,
            error
        );
        review_platform_command_error(
            "Failed to get review platform pull request detail",
            &error,
        )
    })
}

#[tauri::command]
pub async fn review_platform_get_pull_request_review_target(
    _state: State<'_, AppState>,
    request: ReviewPlatformPullRequestDetailRequest,
) -> Result<ReviewPlatformPullRequestReviewTarget, String> {
    ReviewPlatformService::pull_request_review_target(
        &review_repository(&request.workspace_id, &request.repository_path),
        &request.remote_id,
        &request.pull_request_id,
    )
    .await
    .map_err(|error| {
        error!(
            "Failed to prepare review platform pull request target: path={}, remote_id={}, pull_request_id={}, error={}",
            request.repository_path,
            request.remote_id,
            request.pull_request_id,
            error
        );
        review_platform_command_error("Failed to prepare pull request Review target", &error)
    })
}

#[tauri::command]
pub async fn review_platform_get_issue(
    _state: State<'_, AppState>,
    request: ReviewPlatformIssueRequest,
) -> Result<ReviewPlatformIssueEvidence, String> {
    ReviewPlatformService::issue(
        request.platform,
        &request.host,
        &request.project_path,
        &request.issue_id,
        request.page,
        request.per_page,
        optional_review_repository(&request.workspace_id, request.repository_path.as_deref())
            .as_ref(),
    )
    .await
    .map_err(|error| {
        let safe_error = safe_review_platform_error(&error);
        error!(
            "Failed to get review platform Issue: platform={:?}, host={}, project_path={}, issue_id={}, error={}",
            request.platform,
            request.host,
            request.project_path,
            request.issue_id,
            safe_error
        );
        safe_review_platform_command_error("Failed to get provider Issue evidence", &error)
    })
}

#[tauri::command]
pub async fn review_platform_get_pull_request_review_target_by_identity(
    _state: State<'_, AppState>,
    request: ReviewPlatformPullRequestIdentityRequest,
) -> Result<ReviewPlatformPullRequestReviewTarget, String> {
    ReviewPlatformService::pull_request_review_target_by_identity(
        request.platform,
        &request.host,
        &request.project_path,
        &request.pull_request_id,
        optional_review_repository(&request.workspace_id, request.repository_path.as_deref())
            .as_ref(),
    )
    .await
    .map_err(|error| {
        let safe_error = safe_review_platform_error(&error);
        error!(
            "Failed to prepare review platform pull request target by identity: platform={:?}, host={}, project_path={}, pull_request_id={}, error={}",
            request.platform,
            request.host,
            request.project_path,
            request.pull_request_id,
            safe_error
        );
        safe_review_platform_command_error("Failed to prepare pull request Review target", &error)
    })
}

fn review_platform_command_error(context: &str, error: &ReviewPlatformError) -> String {
    if let Some(repository_path) = error.untrusted_repository_path() {
        return untrusted_repository_error_message(repository_path);
    }

    format!("{context}: {error}")
}

fn safe_review_platform_command_error(context: &str, error: &ReviewPlatformError) -> String {
    if let Some(repository_path) = error.untrusted_repository_path() {
        return untrusted_repository_error_message(repository_path);
    }

    format!("{context}: {}", safe_review_platform_error(error))
}

fn safe_review_platform_error(error: &ReviewPlatformError) -> String {
    match error {
        ReviewPlatformError::Http { status, .. } => format!("provider returned HTTP {status}"),
        ReviewPlatformError::Network(_) => "provider network request failed".to_string(),
        ReviewPlatformError::Parse(_) => "provider response could not be parsed".to_string(),
        ReviewPlatformError::StaleTarget(_) => {
            "provider target changed during evidence acquisition".to_string()
        }
        ReviewPlatformError::EvidenceTooLarge { .. } => {
            "provider evidence exceeded the allowed size".to_string()
        }
        ReviewPlatformError::TargetIsPullRequest { .. } => {
            "requested Issue is a pull request".to_string()
        }
        ReviewPlatformError::InvalidRepository(_) => "invalid repository".to_string(),
        ReviewPlatformError::RepositoryUntrusted { .. } => {
            "repository ownership is not trusted".to_string()
        }
        ReviewPlatformError::RemoteNotFound(_) => "provider remote was not found".to_string(),
        ReviewPlatformError::UnsupportedPlatform(_) => "unsupported provider".to_string(),
        ReviewPlatformError::Api(_) => "provider request was rejected".to_string(),
    }
}

#[tauri::command]
pub async fn review_platform_get_pull_request_detail_page(
    _state: State<'_, AppState>,
    request: ReviewPlatformPullRequestDetailPageRequest,
) -> Result<ReviewPlatformPullRequestDetailPage, String> {
    ReviewPlatformService::pull_request_detail_page(
        &review_repository(&request.workspace_id, &request.repository_path),
        &request.remote_id,
        &request.pull_request_id,
        request.section,
        request.page,
        request.per_page,
    )
    .await
    .map_err(|error| {
        error!(
            "Failed to get review platform pull request detail page: path={}, remote_id={}, pull_request_id={}, section={:?}, page={:?}, per_page={:?}, error={}",
            request.repository_path,
            request.remote_id,
            request.pull_request_id,
            request.section,
            request.page,
            request.per_page,
            error
        );
        review_platform_command_error(
            "Failed to get review platform pull request detail page",
            &error,
        )
    })
}

#[tauri::command]
pub async fn review_platform_get_pull_request_ci_log(
    _state: State<'_, AppState>,
    request: ReviewPlatformPullRequestCiLogRequest,
) -> Result<ReviewPlatformCiLog, String> {
    ReviewPlatformService::pull_request_ci_log(
        &review_repository(&request.workspace_id, &request.repository_path),
        &request.remote_id,
        &request.pull_request_id,
        &request.ci_item_id,
        &request.ci_item_name,
    )
    .await
    .map_err(|error| {
        error!(
            "Failed to get review platform CI log: path={}, remote_id={}, pull_request_id={}, ci_item_id={}, error={}",
            request.repository_path,
            request.remote_id,
            request.pull_request_id,
            request.ci_item_id,
            error
        );
        review_platform_command_error("Failed to get review platform CI log", &error)
    })
}

#[tauri::command]
pub async fn review_platform_update_auth_token(
    _state: State<'_, AppState>,
    request: ReviewPlatformUpdateAuthTokenRequest,
) -> Result<(), String> {
    ReviewPlatformService::update_auth_token(request.platform, &request.host, &request.token)
        .await
        .map_err(|error| {
            error!(
                "Failed to update review platform auth token: platform={:?}, host={}, error={}",
                request.platform, request.host, error
            );
            format!("Failed to update review platform auth token: {}", error)
        })
}

#[tauri::command]
pub async fn review_platform_clear_auth_token(
    _state: State<'_, AppState>,
    request: ReviewPlatformClearAuthTokenRequest,
) -> Result<(), String> {
    ReviewPlatformService::clear_auth_token(request.platform, &request.host)
        .await
        .map_err(|error| {
            error!(
                "Failed to clear review platform auth token: platform={:?}, host={}, error={}",
                request.platform, request.host, error
            );
            format!("Failed to clear review platform auth token: {}", error)
        })
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ReviewPlatformIssueRequest {
    pub platform: ReviewPlatformKind,
    pub host: String,
    pub project_path: String,
    pub issue_id: String,
    pub page: Option<u32>,
    pub per_page: Option<u32>,
    #[serde(default)]
    pub workspace_id: Option<String>,
    pub repository_path: Option<String>,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ReviewPlatformPullRequestIdentityRequest {
    pub platform: ReviewPlatformKind,
    pub host: String,
    pub project_path: String,
    pub pull_request_id: String,
    #[serde(default)]
    pub workspace_id: Option<String>,
    pub repository_path: Option<String>,
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    #[test]
    fn review_platform_command_errors_preserve_the_repository_trust_code() {
        let error = ReviewPlatformError::RepositoryUntrusted {
            repository_path: "/srv/shared/repo".to_string(),
            detail: "fatal: detected dubious ownership".to_string(),
        };

        assert_eq!(
            review_platform_command_error("Failed to load review platform", &error),
            "git_repository_untrusted: /srv/shared/repo"
        );
        assert_eq!(
            safe_review_platform_command_error("Failed to load review platform", &error),
            "git_repository_untrusted: /srv/shared/repo"
        );
    }

    #[test]
    fn review_platform_command_errors_keep_context_for_other_failures() {
        let error = ReviewPlatformError::RemoteNotFound("origin".to_string());

        assert_eq!(
            review_platform_command_error("Failed to load review platform", &error),
            "Failed to load review platform: Remote not found: origin"
        );
        assert_eq!(
            safe_review_platform_command_error("Failed to load review platform", &error),
            "Failed to load review platform: provider remote was not found"
        );
    }

    #[test]
    fn review_platform_request_wire_deserializes_issue_identity_fields() {
        let request: ReviewPlatformIssueRequest = serde_json::from_value(json!({
            "platform": "github",
            "host": "github.com",
            "projectPath": "example/repo",
            "issueId": "42",
            "repositoryPath": "D:/workspace/example",
            "page": 2,
            "perPage": 100
        }))
        .expect("Issue request wire should deserialize");

        assert_eq!(request.platform, ReviewPlatformKind::Github);
        assert_eq!(request.host, "github.com");
        assert_eq!(request.project_path, "example/repo");
        assert_eq!(request.issue_id, "42");
        assert_eq!(
            request.repository_path.as_deref(),
            Some("D:/workspace/example")
        );
        assert_eq!(request.page, Some(2));
        assert_eq!(request.per_page, Some(100));
    }

    #[test]
    fn review_platform_request_wire_deserializes_pull_request_identity_fields() {
        let request: ReviewPlatformPullRequestIdentityRequest = serde_json::from_value(json!({
            "platform": "gitlab",
            "host": "gitlab.com",
            "projectPath": "example/group/repo",
            "pullRequestId": "7",
            "repositoryPath": "D:/workspace/example"
        }))
        .expect("pull request identity wire should deserialize");

        assert_eq!(request.platform, ReviewPlatformKind::Gitlab);
        assert_eq!(request.host, "gitlab.com");
        assert_eq!(request.project_path, "example/group/repo");
        assert_eq!(request.pull_request_id, "7");
        assert_eq!(
            request.repository_path.as_deref(),
            Some("D:/workspace/example")
        );
    }
}
