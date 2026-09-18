//! Platform-neutral pull request review data service.
//!
//! This module owns provider detection, token handling, provider DTO mapping,
//! and provider-neutral review-platform response semantics. Concrete HTTP
//! transport lives in `review_platform_http`.

use crate::repository_trust::{
    is_untrusted_repository_message, normalize_trust_path, untrusted_repository_path_from_message,
};
use crate::review_platform_http::{
    send_json as send_review_json, send_json_response as send_review_json_response,
    send_json_response_bounded as send_review_json_response_bounded,
    send_text_bounded as send_review_text_bounded, ReviewHttpClient, ReviewHttpError,
    ReviewHttpHeaders, ReviewHttpRequest, ReviewJsonResponse, ReviewTextResponse,
};
use futures::{stream, StreamExt};
use openbitfun_services_core::process_manager;
use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
use sha2::{Digest, Sha256};
use std::collections::{HashMap, HashSet};
use std::path::{Path, PathBuf};
use std::sync::{Arc, Mutex as StdMutex, OnceLock, Weak};
use tokio::fs;
use tokio::io::AsyncWriteExt;
use tokio::sync::Mutex as AsyncMutex;

mod gitee;

pub const REVIEW_PLATFORM_TOKEN_FILE_NAME: &str = "review-platform-tokens.json";
const REVIEW_PLATFORM_TOKEN_SCHEMA_VERSION: u16 = 1;

const USER_AGENT_VALUE: &str = "ReviewPlatform";
const ACCEPT_HEADER: &str = "accept";
const AUTHORIZATION_HEADER: &str = "authorization";
const USER_AGENT_HEADER: &str = "user-agent";
const DEFAULT_PR_PAGE: u32 = 1;
const DEFAULT_PR_PAGE_SIZE: u32 = 10;
const MAX_PR_PAGE_SIZE: u32 = 50;
const PROVIDER_ENRICH_CONCURRENCY: usize = 4;
const MAX_CI_LOG_CHARS: usize = 80_000;
const MAX_GITLAB_CI_TRACE_BYTES: usize = 512 * 1024;
const MAX_REVIEW_TARGET_PAGES: usize = 10;
const MAX_REVIEW_TARGET_LIST_ITEMS: usize = MAX_REVIEW_TARGET_PAGES * 100;
const MAX_REVIEW_TARGET_RESPONSE_BYTES: usize = 4 * 1024 * 1024;
const MAX_REVIEW_FILE_DIFF_CHARS: usize = 80_000;
// GitCode truncates `GET /pulls/{number}/files` at 3,000 entries without a
// total-count header. The line-count headers are truncated with the body.
const GITCODE_PULL_REQUEST_FILES_RESPONSE_LIMIT: usize = 3_000;
// The whole file list, diffs included, arrives in that one response, so it needs
// a larger budget than a single pull request detail payload.
const GITCODE_PULL_REQUEST_FILES_RESPONSE_BYTES: usize = 16 * 1024 * 1024;
const DEFAULT_ISSUE_PAGE: u32 = 1;
const DEFAULT_ISSUE_PAGE_SIZE: u32 = 100;
const MAX_ISSUE_PAGE_SIZE: u32 = 100;
const MAX_ISSUE_RESPONSE_BYTES: usize = 2 * 1024 * 1024;
const MAX_ISSUE_COMMENTS_RESPONSE_BYTES: usize = 8 * 1024 * 1024;
const MAX_ISSUE_BODY_CHARS: usize = 128_000;
const MAX_ISSUE_COMMENT_BODY_CHARS: usize = 32_000;
const MAX_ISSUE_COMMENTS_AGGREGATE_CHARS: usize = 512_000;
const DEFAULT_GH_OUTPUT_MAX_BYTES: usize = 16 * 1024 * 1024;
const GH_ERROR_OUTPUT_MAX_CHARS: usize = 8 * 1024;

static TOKEN_STORE_LOCKS: OnceLock<StdMutex<HashMap<PathBuf, Weak<AsyncMutex<()>>>>> =
    OnceLock::new();
static TOKEN_STORE_TEMP_NONCE: std::sync::atomic::AtomicU64 = std::sync::atomic::AtomicU64::new(0);

#[derive(Debug, thiserror::Error)]
pub enum ReviewPlatformError {
    #[error("Invalid repository path: {0}")]
    InvalidRepository(String),
    #[error("Repository ownership is not trusted: {repository_path}")]
    RepositoryUntrusted {
        repository_path: String,
        detail: String,
    },
    #[error("Remote not found: {0}")]
    RemoteNotFound(String),
    #[error("Unsupported review platform: {0}")]
    UnsupportedPlatform(String),
    #[error("Provider API failed: {0}")]
    Api(String),
    #[error("Provider API failed: HTTP {status}{message}")]
    Http { status: u16, message: String },
    #[error("Network error: {0}")]
    Network(String),
    #[error("Parse error: {0}")]
    Parse(String),
    #[error("Pull request target changed: {0}")]
    StaleTarget(String),
    #[error("Provider evidence resource {resource} exceeded the {limit} limit")]
    EvidenceTooLarge { resource: String, limit: usize },
    #[error("Requested Issue {issue_id} is a pull request")]
    TargetIsPullRequest { issue_id: String },
}

impl ReviewPlatformError {
    pub fn untrusted_repository_path(&self) -> Option<&str> {
        match self {
            Self::RepositoryUntrusted {
                repository_path, ..
            } => Some(repository_path),
            _ => None,
        }
    }
}

/// Stable boundary error for a repository ownership rejection.
pub fn untrusted_repository_error_message(repository_path: &str) -> String {
    crate::repository_trust::untrusted_repository_error_message(repository_path)
}

/// Classifies a failed Git probe without making Review Platform depend on the
/// full Git capability feature.
pub fn classify_git_command_failure(repository_path: &str, message: String) -> ReviewPlatformError {
    if is_untrusted_repository_message(&message) {
        let repository_path = untrusted_repository_path_from_message(&message)
            .or_else(|| normalize_trust_path(repository_path))
            .unwrap_or_else(|| repository_path.to_string());
        return ReviewPlatformError::RepositoryUntrusted {
            repository_path,
            detail: message,
        };
    }

    ReviewPlatformError::InvalidRepository(message)
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum ReviewPlatformKind {
    Github,
    Gitlab,
    Gitcode,
    Gitee,
    Unknown,
}

impl ReviewPlatformKind {
    fn as_str(self) -> &'static str {
        match self {
            Self::Github => "github",
            Self::Gitlab => "gitlab",
            Self::Gitcode => "gitcode",
            Self::Gitee => "gitee",
            Self::Unknown => "unknown",
        }
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum ReviewAuthState {
    NotConnected,
    NotRequired,
    Connected,
    Expired,
    Error,
    Unsupported,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum ReviewAuthSource {
    GhCli,
    Env,
    Stored,
    None,
    Unsupported,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum ReviewItemState {
    Open,
    Merged,
    Closed,
    Draft,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum ReviewDecision {
    Approved,
    ChangesRequested,
    Commented,
    Pending,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum ReviewFileStatus {
    Added,
    Modified,
    Deleted,
    Renamed,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ReviewPlatformAccount {
    pub id: String,
    pub platform: ReviewPlatformKind,
    pub label: String,
    pub username: Option<String>,
    pub host: String,
    pub auth_state: ReviewAuthState,
    pub auth_source: ReviewAuthSource,
    pub scopes: Vec<String>,
    pub message: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ReviewPlatformRepositoryRef {
    pub provider_id: String,
    pub platform: ReviewPlatformKind,
    pub host: String,
    pub owner: String,
    pub name: String,
    pub project_path: String,
    pub default_branch: String,
    pub workspace_path: Option<String>,
    pub web_url: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ReviewPlatformRemote {
    pub id: String,
    pub name: String,
    pub url: String,
    pub platform: ReviewPlatformKind,
    pub host: String,
    pub owner: String,
    pub repository_name: String,
    pub project_path: String,
    pub web_url: String,
    pub supported: bool,
    pub auth_state: ReviewAuthState,
    pub auth_source: ReviewAuthSource,
    pub message: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ReviewChecks {
    pub total: i32,
    pub passed: i32,
    pub failed: i32,
    pub pending: i32,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ReviewPlatformCiItem {
    pub id: String,
    pub name: String,
    pub status: String,
    pub conclusion: Option<String>,
    pub detail: Option<String>,
    pub stage: Option<String>,
    pub web_url: Option<String>,
    pub log: Option<String>,
    pub log_truncated: bool,
    pub started_at: Option<String>,
    pub finished_at: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ReviewPlatformPullRequest {
    pub id: String,
    /// Remote binding for aggregated lists, not the provider's internal PR ID.
    pub provider_id: Option<String>,
    pub number: i64,
    pub title: String,
    pub state: ReviewItemState,
    pub author: String,
    pub source_branch: String,
    pub target_branch: String,
    pub base_revision: Option<String>,
    pub head_revision: Option<String>,
    pub updated_at: String,
    pub web_url: String,
    pub additions: i32,
    pub deletions: i32,
    /// Whether line totals are complete and safe to present, including zero.
    /// None preserves the behavior of providers and payloads predating this field.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub line_stats_known: Option<bool>,
    pub changed_files: i32,
    /// Whether `changed_files` is safe to present as an actual count.
    /// Older payloads predate the unknown state and are treated as known.
    #[serde(default = "default_changed_file_count_known")]
    pub changed_file_count_known: bool,
    pub comments: i32,
    pub review_decision: ReviewDecision,
    pub checks: ReviewChecks,
}

fn default_changed_file_count_known() -> bool {
    true
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ReviewPlatformFile {
    pub path: String,
    pub old_path: Option<String>,
    pub status: ReviewFileStatus,
    pub additions: i32,
    pub deletions: i32,
    pub patch: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ReviewPlatformReviewTargetFile {
    pub path: String,
    pub old_path: Option<String>,
    pub status: ReviewFileStatus,
    pub additions: i32,
    pub deletions: i32,
    pub diff_available: bool,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ReviewPlatformPullRequestReviewTarget {
    pub pull_request: ReviewPlatformPullRequest,
    pub files: Vec<ReviewPlatformReviewTargetFile>,
    pub omitted_file_count: usize,
    pub limitations: Vec<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ReviewPlatformPullRequestFileDiff {
    pub path: String,
    pub old_path: Option<String>,
    pub status: ReviewFileStatus,
    pub base_revision: String,
    pub head_revision: String,
    pub diff: String,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum ReviewEvidenceCompleteness {
    Complete,
    Partial,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ReviewPlatformIssueComment {
    pub id: String,
    pub web_url: Option<String>,
    pub author: Option<String>,
    pub body: String,
    pub created_at: Option<String>,
    pub updated_at: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ReviewPlatformIssueEvidence {
    pub platform: ReviewPlatformKind,
    pub host: String,
    pub project_path: String,
    pub issue_id: String,
    pub web_url: String,
    pub title: String,
    pub body: String,
    pub state: String,
    pub author: Option<String>,
    pub labels: Vec<String>,
    pub created_at: Option<String>,
    pub updated_at: Option<String>,
    pub comments: Vec<ReviewPlatformIssueComment>,
    pub fingerprint: String,
    pub completeness: ReviewEvidenceCompleteness,
    pub limitations: Vec<String>,
    pub has_more_comments: bool,
    pub next_cursor: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ReviewPlatformCommit {
    pub hash: String,
    pub short_hash: String,
    pub title: String,
    pub author: String,
    pub committed_at: String,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum ReviewPlatformThreadKind {
    Review,
    Comment,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ReviewPlatformThread {
    pub id: String,
    pub provider_thread_id: Option<String>,
    pub provider_comment_id: Option<String>,
    pub kind: ReviewPlatformThreadKind,
    pub reply_to_provider_comment_id: Option<String>,
    pub file_path: Option<String>,
    pub line: Option<i64>,
    pub resolved: bool,
    pub author: String,
    pub body: String,
    pub updated_at: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ReviewPlatformPullRequestDetail {
    #[serde(flatten)]
    pub pull_request: ReviewPlatformPullRequest,
    pub body: String,
    pub ci: Vec<ReviewPlatformCiItem>,
    pub files: Vec<ReviewPlatformFile>,
    pub commits: Vec<ReviewPlatformCommit>,
    pub threads: Vec<ReviewPlatformThread>,
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub limitations: Vec<String>,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum ReviewPlatformDetailSection {
    Overview,
    Ci,
    Files,
    Commits,
    Reviews,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ReviewPlatformPullRequestDetailPage {
    #[serde(flatten)]
    pub pull_request: ReviewPlatformPullRequest,
    pub body: String,
    pub ci: Vec<ReviewPlatformCiItem>,
    pub files: Vec<ReviewPlatformFile>,
    pub commits: Vec<ReviewPlatformCommit>,
    pub threads: Vec<ReviewPlatformThread>,
    pub section: ReviewPlatformDetailSection,
    pub pagination: ReviewPlatformPagination,
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub limitations: Vec<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ReviewPlatformCiLog {
    pub ci_item_id: String,
    pub log: Option<String>,
    pub truncated: bool,
    pub message: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ReviewPlatformCapabilities {
    pub can_create_review: bool,
    pub can_create_pull_request: bool,
    pub can_reply_to_thread: bool,
    pub can_resolve_thread: bool,
    pub can_approve: bool,
    pub can_revoke_approval: bool,
    pub can_request_changes: bool,
    pub can_merge: bool,
    pub supports_draft_review: bool,
    /// Repository-wide list filters supported by this host/provider. An absent
    /// field on an older host must not be treated as server-side filtering.
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub supported_pull_request_states: Vec<ReviewPlatformListState>,
}

#[derive(Debug, Default, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum ReviewPlatformListState {
    #[default]
    All,
    Open,
    Draft,
    Merged,
    Closed,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum ReviewSubmitEvent {
    Comment,
    Approve,
    RequestChanges,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ReviewPlatformCreatePullRequestRequest {
    /// Owning workspace ID; authoritative for local/remote routing when present.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub workspace_id: Option<String>,
    pub repository_path: String,
    pub remote_id: Option<String>,
    pub title: String,
    pub source_branch: String,
    pub target_branch: String,
    pub body: Option<String>,
    pub draft: Option<bool>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ReviewPlatformReplyToThreadRequest {
    /// Owning workspace ID; authoritative for local/remote routing when present.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub workspace_id: Option<String>,
    pub repository_path: String,
    pub remote_id: String,
    pub pull_request_id: String,
    pub thread_id: String,
    pub body: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ReviewPlatformSubmitReviewRequest {
    /// Owning workspace ID; authoritative for local/remote routing when present.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub workspace_id: Option<String>,
    pub repository_path: String,
    pub remote_id: String,
    pub pull_request_id: String,
    pub event: ReviewSubmitEvent,
    pub body: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ReviewPlatformResolveThreadRequest {
    /// Owning workspace ID; authoritative for local/remote routing when present.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub workspace_id: Option<String>,
    pub repository_path: String,
    pub remote_id: String,
    pub pull_request_id: String,
    pub thread_id: String,
    pub resolved: bool,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ReviewPlatformApprovalRequest {
    /// Owning workspace ID; authoritative for local/remote routing when present.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub workspace_id: Option<String>,
    pub repository_path: String,
    pub remote_id: String,
    pub pull_request_id: String,
    pub body: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ReviewPlatformRequestChangesRequest {
    /// Owning workspace ID; authoritative for local/remote routing when present.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub workspace_id: Option<String>,
    pub repository_path: String,
    pub remote_id: String,
    pub pull_request_id: String,
    pub body: String,
}

impl ReviewPlatformCreatePullRequestRequest {
    pub fn repository(&self) -> ReviewRepositoryLocator {
        ReviewRepositoryLocator::new(self.workspace_id.clone(), self.repository_path.clone())
    }
}

impl ReviewPlatformReplyToThreadRequest {
    pub fn repository(&self) -> ReviewRepositoryLocator {
        ReviewRepositoryLocator::new(self.workspace_id.clone(), self.repository_path.clone())
    }
}

impl ReviewPlatformSubmitReviewRequest {
    pub fn repository(&self) -> ReviewRepositoryLocator {
        ReviewRepositoryLocator::new(self.workspace_id.clone(), self.repository_path.clone())
    }
}

impl ReviewPlatformResolveThreadRequest {
    pub fn repository(&self) -> ReviewRepositoryLocator {
        ReviewRepositoryLocator::new(self.workspace_id.clone(), self.repository_path.clone())
    }
}

impl ReviewPlatformApprovalRequest {
    pub fn repository(&self) -> ReviewRepositoryLocator {
        ReviewRepositoryLocator::new(self.workspace_id.clone(), self.repository_path.clone())
    }
}

impl ReviewPlatformRequestChangesRequest {
    pub fn repository(&self) -> ReviewRepositoryLocator {
        ReviewRepositoryLocator::new(self.workspace_id.clone(), self.repository_path.clone())
    }
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ReviewPlatformActionResult {
    pub success: bool,
    pub message: String,
    pub web_url: Option<String>,
    pub pull_request: Option<ReviewPlatformPullRequest>,
    pub thread: Option<ReviewPlatformThread>,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum ReviewPlatformAuthChallengeState {
    Missing,
    Invalid,
    InsufficientScope,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ReviewPlatformAuthChallenge {
    pub platform: ReviewPlatformKind,
    pub host: String,
    pub remote_id: String,
    pub project_path: String,
    pub state: ReviewPlatformAuthChallengeState,
    pub message: String,
    pub required_scopes: Vec<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ReviewPlatformWorkspaceSnapshot {
    pub remotes: Vec<ReviewPlatformRemote>,
    pub selected_remote_id: Option<String>,
    pub accounts: Vec<ReviewPlatformAccount>,
    pub repository: Option<ReviewPlatformRepositoryRef>,
    pub pull_requests: Vec<ReviewPlatformPullRequest>,
    pub pagination: ReviewPlatformPagination,
    pub capabilities: ReviewPlatformCapabilities,
    pub message: Option<String>,
    pub auth_challenge: Option<ReviewPlatformAuthChallenge>,
}

/// Product-level workspace runtime access for review-platform Git probing.
///
/// Review-platform only touches the workspace for repository discovery
/// (`git rev-parse --show-toplevel`, `git remote -v`); provider data itself is
/// fetched over HTTP from the host running OpenBitFun. Remote SSH workspaces are
/// therefore fully supported as long as the product runtime can execute those
/// Git probes on the remote host, which is what this port injects.
/// Identifies the repository a review-platform operation runs against.
///
/// `workspace_id` is the authoritative identity: it decides whether Git probes
/// run locally or on a remote host, and which connection carries them.
/// `repository_path` is only the IO operand (the directory the probes run in);
/// it never selects a workspace on its own once an ID is present.
#[derive(Debug, Clone, PartialEq, Eq, Default, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ReviewRepositoryLocator {
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub workspace_id: Option<String>,
    pub repository_path: String,
}

impl ReviewRepositoryLocator {
    pub fn new(workspace_id: Option<String>, repository_path: impl Into<String>) -> Self {
        Self {
            workspace_id: workspace_id.filter(|id| !id.trim().is_empty()),
            repository_path: repository_path.into(),
        }
    }

    /// Legacy locator for callers that predate workspace IDs. The host
    /// classifier must resolve the path through its legacy-compat boundary.
    pub fn legacy_path(repository_path: impl Into<String>) -> Self {
        Self::new(None, repository_path)
    }
}

/// Remote execution target resolved from a workspace ID.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct ReviewRemoteGitTarget {
    pub workspace_id: String,
    pub connection_id: String,
}

/// How Git probes for one repository locator must execute.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum ReviewGitExecution {
    Local,
    Remote(ReviewRemoteGitTarget),
}

#[async_trait::async_trait]
pub trait ReviewPlatformWorkspaceClassifier: Send + Sync {
    /// Resolves whether the repository lives on the local filesystem or inside
    /// a remote workspace, keyed by the owning workspace ID. Hosts may accept
    /// a legacy path-only locator through their legacy-compat boundary, but
    /// must never pick a remote connection from an ambiguous path.
    async fn classify_repository(
        &self,
        repository: &ReviewRepositoryLocator,
    ) -> Result<ReviewGitExecution, ReviewPlatformError>;

    /// Executes a Git command inside a remote workspace and returns stdout.
    ///
    /// Only called for locators that [`Self::classify_repository`] resolved to
    /// [`ReviewGitExecution::Remote`]. `current_dir` is the remote directory
    /// the Git command must run in (it may differ from the locator path once
    /// the repository root has been resolved).
    ///
    /// The default implementation fails loudly so hosts that classify
    /// repositories as remote without wiring remote Git execution surface a
    /// clear error instead of silently degrading.
    async fn execute_remote_git_command(
        &self,
        target: &ReviewRemoteGitTarget,
        current_dir: &str,
        args: &[&str],
    ) -> Result<String, ReviewPlatformError> {
        let _ = (current_dir, args);
        Err(ReviewPlatformError::InvalidRepository(format!(
            "Remote workspace Git execution is not wired for workspace {}",
            target.workspace_id
        )))
    }
}

#[derive(Clone)]
pub struct ReviewPlatformService {
    token_store_path: PathBuf,
    token_store_lock: Arc<AsyncMutex<()>>,
    workspace_classifier: Arc<dyn ReviewPlatformWorkspaceClassifier>,
}

/// Resolved Git execution scope for one repository locator.
#[derive(Debug, Clone)]
struct WorkspaceGitScope {
    /// Git repository root the probes must run in.
    repository_root: String,
    /// Local process or remote execution keyed by the owning workspace ID.
    execution: ReviewGitExecution,
}

/// Test-only classifier that treats every path as local. Production hosts
/// must inject a remote-aware classifier; a classifier that answers `false`
/// for a remote workspace would run Git probes against the controller
/// filesystem, which is the silent local fallback the remote scenarios forbid.
#[cfg(test)]
struct LocalOnlyReviewPlatformWorkspaceClassifier;

#[cfg(test)]
#[async_trait::async_trait]
impl ReviewPlatformWorkspaceClassifier for LocalOnlyReviewPlatformWorkspaceClassifier {
    async fn classify_repository(
        &self,
        _repository: &ReviewRepositoryLocator,
    ) -> Result<ReviewGitExecution, ReviewPlatformError> {
        Ok(ReviewGitExecution::Local)
    }
}

#[derive(Debug, Clone, Copy)]
struct PullRequestPagination {
    page: u32,
    per_page: u32,
}

impl PullRequestPagination {
    fn new(page: Option<u32>, per_page: Option<u32>) -> Self {
        Self {
            page: page.unwrap_or(DEFAULT_PR_PAGE).max(1),
            per_page: per_page
                .unwrap_or(DEFAULT_PR_PAGE_SIZE)
                .clamp(1, MAX_PR_PAGE_SIZE),
        }
    }
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ReviewPlatformPagination {
    pub page: u32,
    pub per_page: u32,
    pub total: Option<u64>,
    pub has_next: bool,
}

#[derive(Debug, Clone)]
struct ReviewPlatformPullRequestPage {
    items: Vec<ReviewPlatformPullRequest>,
    pagination: ReviewPlatformPagination,
}

#[derive(Debug, Clone)]
struct ProviderContext {
    remote: ReviewPlatformRemote,
    api_base_url: String,
    token: Option<String>,
}

#[derive(Debug, Clone)]
struct ProviderIssueIdentity {
    platform: ReviewPlatformKind,
    host: String,
    project_path: String,
    issue_id: String,
}

impl ProviderIssueIdentity {
    fn new(
        platform: ReviewPlatformKind,
        host: &str,
        project_path: &str,
        issue_id: &str,
    ) -> Result<Self, ReviewPlatformError> {
        Ok(Self {
            platform,
            host: normalize_provider_host(host)?,
            project_path: normalize_project_path(platform, project_path)?,
            issue_id: if platform == ReviewPlatformKind::Gitee {
                gitee::normalize_issue_number(issue_id)?
            } else {
                normalize_provider_item_id(issue_id, "Issue")?
            },
        })
    }
}

#[derive(Debug, Clone, Copy)]
struct IssuePagination {
    page: u32,
    per_page: u32,
}

impl IssuePagination {
    fn new(page: Option<u32>, per_page: Option<u32>) -> Self {
        Self {
            page: page.unwrap_or(DEFAULT_ISSUE_PAGE).max(1),
            per_page: per_page
                .unwrap_or(DEFAULT_ISSUE_PAGE_SIZE)
                .clamp(1, MAX_ISSUE_PAGE_SIZE),
        }
    }
}

#[derive(Debug, Clone)]
struct IssueRequestPlan {
    issue_url: String,
    comments_url: String,
    comments_query: Vec<(String, String)>,
    pagination: IssuePagination,
}

#[derive(Debug, Clone)]
#[cfg(test)]
struct PullRequestIdentityPlan {
    context: ProviderContext,
    pull_request_id: String,
}

#[derive(Debug, Clone, Default)]
struct ReviewPlatformAuthTokens {
    tokens: HashMap<String, String>,
}

impl ReviewPlatformAuthTokens {
    fn get(&self, platform: ReviewPlatformKind, host: &str) -> Option<&str> {
        token_key(platform, host).and_then(|key| self.tokens.get(&key).map(String::as_str))
    }

    fn registered_platform_for_host(&self, host: &str) -> Option<ReviewPlatformKind> {
        let host = normalize_provider_host(host).ok()?;
        let mut platforms = [ReviewPlatformKind::Gitlab, ReviewPlatformKind::Gitcode]
            .into_iter()
            .filter(|platform| self.get(*platform, &host).is_some());
        let platform = platforms.next()?;
        platforms.next().is_none().then_some(platform)
    }
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct StoredReviewPlatformTokens {
    schema_version: u16,
    #[serde(default)]
    tokens: HashMap<String, StoredReviewPlatformToken>,
}

impl Default for StoredReviewPlatformTokens {
    fn default() -> Self {
        Self {
            schema_version: REVIEW_PLATFORM_TOKEN_SCHEMA_VERSION,
            tokens: HashMap::new(),
        }
    }
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct StoredReviewPlatformToken {
    token: String,
    updated_at: String,
}

impl ReviewPlatformService {
    /// Creates a review-platform owner with an explicit workspace classifier.
    /// Product assembly should inject remote-aware classification here.
    pub fn new(
        token_store_path: PathBuf,
        workspace_classifier: Arc<dyn ReviewPlatformWorkspaceClassifier>,
    ) -> Self {
        let token_store_path = absolute_token_store_path(&token_store_path);
        let lock_key = normalize_token_store_lock_key(&token_store_path);
        let token_store_lock = shared_token_store_lock(&lock_key);
        Self {
            token_store_path,
            token_store_lock,
            workspace_classifier,
        }
    }

    /// Creates a local-only owner for services tests. Production hosts must
    /// use [`Self::new`] with a remote-aware classifier.
    #[cfg(test)]
    pub(crate) fn new_local_only(token_store_path: PathBuf) -> Self {
        Self::new(
            token_store_path,
            Arc::new(LocalOnlyReviewPlatformWorkspaceClassifier),
        )
    }

    pub fn token_store_path(&self) -> &Path {
        &self.token_store_path
    }

    /// Resolves how Git probes must run for `repository` (local process vs.
    /// remote execution through the injected workspace runtime).
    async fn workspace_git_scope(
        &self,
        repository: &ReviewRepositoryLocator,
    ) -> Result<WorkspaceGitScope, ReviewPlatformError> {
        let execution = self
            .workspace_classifier
            .classify_repository(repository)
            .await?;
        match execution {
            ReviewGitExecution::Remote(target) => {
                let output = self
                    .workspace_classifier
                    .execute_remote_git_command(
                        &target,
                        &repository.repository_path,
                        &["rev-parse", "--show-toplevel"],
                    )
                    .await?;
                // Remote roots are POSIX paths on the remote host; never apply
                // local (Windows) path normalization to them.
                let root = parse_repository_root_output(&output)?;
                Ok(WorkspaceGitScope {
                    repository_root: root,
                    execution: ReviewGitExecution::Remote(target),
                })
            }
            ReviewGitExecution::Local => {
                let root = get_repository_root(&repository.repository_path).await?;
                Ok(WorkspaceGitScope {
                    repository_root: root,
                    execution: ReviewGitExecution::Local,
                })
            }
        }
    }

    async fn execute_scope_git_command(
        &self,
        scope: &WorkspaceGitScope,
        args: &[&str],
    ) -> Result<String, ReviewPlatformError> {
        match &scope.execution {
            ReviewGitExecution::Remote(target) => {
                self.workspace_classifier
                    .execute_remote_git_command(target, &scope.repository_root, args)
                    .await
            }
            ReviewGitExecution::Local => execute_git_command(&scope.repository_root, args).await,
        }
    }

    pub async fn discover_remotes(
        &self,
        repository: &ReviewRepositoryLocator,
    ) -> Result<Vec<ReviewPlatformRemote>, ReviewPlatformError> {
        let auth_tokens = self.load_stored_tokens().await?;
        let scope = self.workspace_git_scope(repository).await?;
        self.discover_remotes_in_scope(&scope, &auth_tokens).await
    }

    async fn discover_remotes_in_scope(
        &self,
        scope: &WorkspaceGitScope,
        auth_tokens: &ReviewPlatformAuthTokens,
    ) -> Result<Vec<ReviewPlatformRemote>, ReviewPlatformError> {
        let output = self
            .execute_scope_git_command(scope, &["remote", "-v"])
            .await?;

        let mut seen = HashSet::new();
        let mut remotes = Vec::new();
        let mut gh_auth_by_host: HashMap<String, GhAuthStatus> = HashMap::new();

        for line in output.lines() {
            let parts: Vec<&str> = line.split_whitespace().collect();
            if parts.len() < 2 {
                continue;
            }
            if parts.get(2).is_some_and(|kind| *kind != "(fetch)") {
                continue;
            }
            let remote_name = parts[0];
            let remote_url = parts[1];
            let key = format!("{}|{}", remote_name, remote_url);
            if !seen.insert(key) {
                continue;
            }
            if let Some(mut remote) = parse_remote(remote_name, remote_url, auth_tokens) {
                if matches!(
                    remote.platform,
                    ReviewPlatformKind::Github | ReviewPlatformKind::Unknown
                ) {
                    let status = if let Some(status) = gh_auth_by_host.get(&remote.host) {
                        status.clone()
                    } else {
                        let status = gh_auth_status(&remote.host).await;
                        gh_auth_by_host.insert(remote.host.clone(), status.clone());
                        status
                    };
                    hydrate_github_remote_auth(&mut remote, status);
                }
                remotes.push(remote);
            }
        }

        Ok(remotes)
    }

    pub async fn workspace_snapshot(
        &self,
        repository: &ReviewRepositoryLocator,
        remote_id: Option<&str>,
        page: Option<u32>,
        per_page: Option<u32>,
    ) -> Result<ReviewPlatformWorkspaceSnapshot, ReviewPlatformError> {
        self.workspace_snapshot_with_state(
            repository,
            remote_id,
            page,
            per_page,
            ReviewPlatformListState::All,
        )
        .await
    }

    pub async fn workspace_snapshot_with_state(
        &self,
        repository: &ReviewRepositoryLocator,
        remote_id: Option<&str>,
        page: Option<u32>,
        per_page: Option<u32>,
        state: ReviewPlatformListState,
    ) -> Result<ReviewPlatformWorkspaceSnapshot, ReviewPlatformError> {
        self.workspace_snapshot_internal(repository, remote_id, page, per_page, true, state)
            .await
    }

    pub async fn workspace_context(
        &self,
        repository: &ReviewRepositoryLocator,
        remote_id: Option<&str>,
    ) -> Result<ReviewPlatformWorkspaceSnapshot, ReviewPlatformError> {
        self.workspace_snapshot_internal(
            repository,
            remote_id,
            None,
            None,
            false,
            ReviewPlatformListState::All,
        )
        .await
    }

    async fn workspace_snapshot_internal(
        &self,
        repository: &ReviewRepositoryLocator,
        remote_id: Option<&str>,
        page: Option<u32>,
        per_page: Option<u32>,
        include_pull_requests: bool,
        state: ReviewPlatformListState,
    ) -> Result<ReviewPlatformWorkspaceSnapshot, ReviewPlatformError> {
        let pagination_request = PullRequestPagination::new(page, per_page);
        let auth_tokens = self.load_stored_tokens().await?;
        let scope = self.workspace_git_scope(repository).await?;
        let root = scope.repository_root.clone();
        let remotes = self.discover_remotes_in_scope(&scope, &auth_tokens).await?;
        let selected_remote = select_remote(&remotes, remote_id).cloned();

        let Some(remote) = selected_remote else {
            return Ok(empty_snapshot(
                remotes,
                None,
                None,
                "No Git remotes were found",
            ));
        };

        if !remote.supported {
            return Ok(empty_snapshot(
                remotes,
                Some(remote.id.clone()),
                Some(account_for_remote(&remote)),
                remote
                    .message
                    .as_deref()
                    .unwrap_or("Unsupported remote provider"),
            ));
        }

        if state != ReviewPlatformListState::All
            && !capabilities_for_remote(&remote)
                .supported_pull_request_states
                .contains(&state)
        {
            return Err(ReviewPlatformError::UnsupportedPlatform(format!(
                "{} does not support repository-wide pull request state filtering on this host",
                platform_label(remote.platform)
            )));
        }

        if remote.platform == ReviewPlatformKind::Gitcode
            && token_for_remote(&remote, &auth_tokens).is_none()
        {
            return Ok(empty_snapshot(
                remotes,
                Some(remote.id.clone()),
                Some(account_for_remote(&remote)),
                "GitCode pull request APIs require a Personal Access Token. Add a token for this remote and refresh.",
            ));
        }

        if remote.platform == ReviewPlatformKind::Github
            && remote.auth_state != ReviewAuthState::Connected
        {
            let challenge = github_cli_auth_challenge(&remote);
            let repository = Some(repository_ref(&remote, Some(root)));
            let account = account_for_remote(&remote);
            let capabilities = capabilities_for_remote(&remote);
            return Ok(auth_required_snapshot(
                remotes,
                remote,
                repository,
                account,
                capabilities,
                challenge,
            ));
        }

        if include_pull_requests
            && remote_id.is_none()
            && remote.platform == ReviewPlatformKind::Github
        {
            let page = github_current_user_open_pull_requests_for_remotes(
                &remotes,
                &auth_tokens,
                pagination_request,
            )
            .await?;
            let selected_remote_id = page
                .items
                .first()
                .and_then(|pull_request| pull_request.provider_id.clone())
                .unwrap_or_else(|| remote.id.clone());
            let selected_remote = remotes
                .iter()
                .find(|candidate| candidate.id == selected_remote_id)
                .cloned()
                .unwrap_or_else(|| remote.clone());
            return Ok(ReviewPlatformWorkspaceSnapshot {
                remotes,
                selected_remote_id: Some(selected_remote.id.clone()),
                accounts: vec![account_for_remote(&selected_remote)],
                repository: Some(repository_ref(&selected_remote, Some(root))),
                pull_requests: page.items,
                pagination: page.pagination,
                capabilities: capabilities_for_remote(&selected_remote),
                message: None,
                auth_challenge: None,
            });
        }

        let ctx = provider_context(remote.clone(), &auth_tokens)?;
        let provider = provider_for(ctx.remote.platform);
        let repository = Some(repository_ref(&ctx.remote, Some(root)));
        let account = account_for_remote(&ctx.remote);
        let capabilities = capabilities_for_remote(&remote);
        if !include_pull_requests {
            return Ok(ReviewPlatformWorkspaceSnapshot {
                remotes,
                selected_remote_id: Some(remote.id.clone()),
                accounts: vec![account],
                repository,
                pull_requests: Vec::new(),
                pagination: ReviewPlatformPagination {
                    page: DEFAULT_PR_PAGE,
                    per_page: DEFAULT_PR_PAGE_SIZE,
                    total: Some(0),
                    has_next: false,
                },
                capabilities,
                message: None,
                auth_challenge: None,
            });
        }
        match provider
            .list_pull_requests_with_state(&ctx, pagination_request, state)
            .await
        {
            Ok(page) => Ok(ReviewPlatformWorkspaceSnapshot {
                remotes,
                selected_remote_id: Some(remote.id.clone()),
                accounts: vec![account],
                repository,
                pull_requests: page.items,
                pagination: page.pagination,
                capabilities,
                message: None,
                auth_challenge: None,
            }),
            Err(error) if is_auth_http_error(&error) => {
                let challenge = auth_challenge_for_remote(
                    &remote,
                    &error,
                    token_for_remote(&remote, &auth_tokens).is_some(),
                );
                let mut account = account;
                account.auth_state = auth_state_for_challenge(challenge.state);
                account.auth_source =
                    if matches!(challenge.state, ReviewPlatformAuthChallengeState::Missing) {
                        ReviewAuthSource::None
                    } else {
                        account.auth_source
                    };
                account.message = Some(challenge.message.clone());
                Ok(auth_required_snapshot(
                    remotes,
                    remote,
                    repository,
                    account,
                    capabilities,
                    challenge,
                ))
            }
            Err(error) => Err(error),
        }
    }

    pub async fn pull_request_detail(
        &self,
        repository: &ReviewRepositoryLocator,
        remote_id: &str,
        pull_request_id: &str,
    ) -> Result<ReviewPlatformPullRequestDetail, ReviewPlatformError> {
        let auth_tokens = self.load_stored_tokens().await?;
        let scope = self.workspace_git_scope(repository).await?;
        let remotes = self.discover_remotes_in_scope(&scope, &auth_tokens).await?;
        let remote = remotes
            .into_iter()
            .find(|remote| remote.id == remote_id)
            .ok_or_else(|| ReviewPlatformError::RemoteNotFound(remote_id.to_string()))?;
        if !remote.supported {
            return Err(ReviewPlatformError::UnsupportedPlatform(remote.host));
        }
        let ctx = provider_context(remote, &auth_tokens)?;
        provider_for(ctx.remote.platform)
            .pull_request_detail(&ctx, pull_request_id)
            .await
    }

    pub async fn pull_request_review_target(
        &self,
        repository: &ReviewRepositoryLocator,
        remote_id: &str,
        pull_request_id: &str,
    ) -> Result<ReviewPlatformPullRequestReviewTarget, ReviewPlatformError> {
        let ctx = self
            .provider_context_for_repository(repository, Some(remote_id))
            .await?;
        provider_for(ctx.remote.platform)
            .pull_request_review_target(&ctx, pull_request_id)
            .await
    }

    pub async fn issue(
        &self,
        platform: ReviewPlatformKind,
        host: &str,
        project_path: &str,
        issue_id: &str,
        page: Option<u32>,
        per_page: Option<u32>,
        repository: Option<&ReviewRepositoryLocator>,
    ) -> Result<ReviewPlatformIssueEvidence, ReviewPlatformError> {
        let auth_tokens = self.load_stored_tokens().await?;
        let identity = ProviderIssueIdentity::new(platform, host, project_path, issue_id)?;
        let context = self
            .provider_context_for_identity_request(
                identity.platform,
                &identity.host,
                &identity.project_path,
                repository,
                &auth_tokens,
            )
            .await?;
        acquire_issue_evidence(&context, &identity, IssuePagination::new(page, per_page)).await
    }

    pub async fn pull_request_review_target_by_identity(
        &self,
        platform: ReviewPlatformKind,
        host: &str,
        project_path: &str,
        pull_request_id: &str,
        repository: Option<&ReviewRepositoryLocator>,
    ) -> Result<ReviewPlatformPullRequestReviewTarget, ReviewPlatformError> {
        let auth_tokens = self.load_stored_tokens().await?;
        let pull_request_id = normalize_provider_item_id(pull_request_id, "Pull request")?;
        let context = self
            .provider_context_for_identity_request(
                platform,
                host,
                project_path,
                repository,
                &auth_tokens,
            )
            .await?;
        provider_for(context.remote.platform)
            .pull_request_review_target(&context, &pull_request_id)
            .await
    }

    #[allow(clippy::too_many_arguments)]
    pub async fn pull_request_file_diff_by_identity(
        &self,
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
        let pull_request_id = normalize_provider_item_id(pull_request_id, "Pull request")?;
        let auth_tokens = self.load_stored_tokens().await?;
        let context = self
            .provider_context_for_identity_request(
                platform,
                host,
                project_path,
                repository,
                &auth_tokens,
            )
            .await?;
        provider_for(context.remote.platform)
            .pull_request_file_diff(
                &context,
                &pull_request_id,
                expected_base_revision,
                expected_head_revision,
                file_path,
                file_page_hint,
            )
            .await
    }

    pub async fn pull_request_file_diff(
        &self,
        repository: &ReviewRepositoryLocator,
        remote_id: &str,
        pull_request_id: &str,
        expected_base_revision: &str,
        expected_head_revision: &str,
        file_path: &str,
        file_page_hint: Option<u32>,
    ) -> Result<ReviewPlatformPullRequestFileDiff, ReviewPlatformError> {
        let ctx = self
            .provider_context_for_repository(repository, Some(remote_id))
            .await?;
        provider_for(ctx.remote.platform)
            .pull_request_file_diff(
                &ctx,
                pull_request_id,
                expected_base_revision,
                expected_head_revision,
                file_path,
                file_page_hint,
            )
            .await
    }

    pub async fn pull_request_detail_page(
        &self,
        repository: &ReviewRepositoryLocator,
        remote_id: &str,
        pull_request_id: &str,
        section: ReviewPlatformDetailSection,
        page: Option<u32>,
        per_page: Option<u32>,
    ) -> Result<ReviewPlatformPullRequestDetailPage, ReviewPlatformError> {
        let ctx = self
            .provider_context_for_repository(repository, Some(remote_id))
            .await?;
        provider_for(ctx.remote.platform)
            .pull_request_detail_page(
                &ctx,
                pull_request_id,
                section,
                PullRequestPagination::new(page, per_page),
            )
            .await
    }

    pub async fn pull_request_ci_log(
        &self,
        repository: &ReviewRepositoryLocator,
        remote_id: &str,
        pull_request_id: &str,
        ci_item_id: &str,
        ci_item_name: &str,
    ) -> Result<ReviewPlatformCiLog, ReviewPlatformError> {
        let ctx = self
            .provider_context_for_repository(repository, Some(remote_id))
            .await?;
        provider_for(ctx.remote.platform)
            .pull_request_ci_log(&ctx, pull_request_id, ci_item_id, ci_item_name)
            .await
    }

    pub async fn create_pull_request(
        &self,
        request: ReviewPlatformCreatePullRequestRequest,
    ) -> Result<ReviewPlatformActionResult, ReviewPlatformError> {
        let ctx = self
            .provider_context_for_repository(&request.repository(), request.remote_id.as_deref())
            .await?;
        provider_for(ctx.remote.platform)
            .create_pull_request(&ctx, &request)
            .await
    }

    pub async fn reply_to_thread(
        &self,
        request: ReviewPlatformReplyToThreadRequest,
    ) -> Result<ReviewPlatformActionResult, ReviewPlatformError> {
        let ctx = self
            .provider_context_for_repository(
                &request.repository(),
                Some(request.remote_id.as_str()),
            )
            .await?;
        provider_for(ctx.remote.platform)
            .reply_to_thread(&ctx, &request)
            .await
    }

    pub async fn submit_review(
        &self,
        request: ReviewPlatformSubmitReviewRequest,
    ) -> Result<ReviewPlatformActionResult, ReviewPlatformError> {
        let ctx = self
            .provider_context_for_repository(
                &request.repository(),
                Some(request.remote_id.as_str()),
            )
            .await?;
        provider_for(ctx.remote.platform)
            .submit_review(&ctx, &request)
            .await
    }

    pub async fn resolve_thread(
        &self,
        request: ReviewPlatformResolveThreadRequest,
    ) -> Result<ReviewPlatformActionResult, ReviewPlatformError> {
        let ctx = self
            .provider_context_for_repository(
                &request.repository(),
                Some(request.remote_id.as_str()),
            )
            .await?;
        provider_for(ctx.remote.platform)
            .resolve_thread(&ctx, &request)
            .await
    }

    pub async fn approve_pull_request(
        &self,
        request: ReviewPlatformApprovalRequest,
    ) -> Result<ReviewPlatformActionResult, ReviewPlatformError> {
        let ctx = self
            .provider_context_for_repository(
                &request.repository(),
                Some(request.remote_id.as_str()),
            )
            .await?;
        provider_for(ctx.remote.platform)
            .approve_pull_request(&ctx, &request)
            .await
    }

    pub async fn revoke_approval(
        &self,
        request: ReviewPlatformApprovalRequest,
    ) -> Result<ReviewPlatformActionResult, ReviewPlatformError> {
        let ctx = self
            .provider_context_for_repository(
                &request.repository(),
                Some(request.remote_id.as_str()),
            )
            .await?;
        provider_for(ctx.remote.platform)
            .revoke_approval(&ctx, &request)
            .await
    }

    pub async fn request_changes(
        &self,
        request: ReviewPlatformRequestChangesRequest,
    ) -> Result<ReviewPlatformActionResult, ReviewPlatformError> {
        let ctx = self
            .provider_context_for_repository(
                &request.repository(),
                Some(request.remote_id.as_str()),
            )
            .await?;
        provider_for(ctx.remote.platform)
            .request_changes(&ctx, &request)
            .await
    }

    async fn provider_context_for_repository(
        &self,
        repository: &ReviewRepositoryLocator,
        remote_id: Option<&str>,
    ) -> Result<ProviderContext, ReviewPlatformError> {
        let auth_tokens = self.load_stored_tokens().await?;
        let scope = self.workspace_git_scope(repository).await?;
        let remotes = self.discover_remotes_in_scope(&scope, &auth_tokens).await?;
        let remote = select_remote_for_action(&remotes, remote_id)?.clone();
        if !remote.supported {
            return Err(ReviewPlatformError::UnsupportedPlatform(remote.host));
        }
        provider_context(remote, &auth_tokens)
    }

    async fn provider_context_for_identity_request(
        &self,
        platform: ReviewPlatformKind,
        host: &str,
        project_path: &str,
        repository: Option<&ReviewRepositoryLocator>,
        auth_tokens: &ReviewPlatformAuthTokens,
    ) -> Result<ProviderContext, ReviewPlatformError> {
        let host = normalize_provider_host(host)?;
        let project_path = normalize_project_path(platform, project_path)?;
        let trusted_remote = if auth_tokens.get(platform, &host).is_none() {
            match repository {
                Some(repository) => {
                    self.repository_trusts_provider_identity(
                        repository,
                        platform,
                        &host,
                        &project_path,
                    )
                    .await
                }
                None => false,
            }
        } else {
            false
        };
        provider_context_for_identity_with_trust(
            platform,
            &host,
            &project_path,
            auth_tokens,
            trusted_remote,
        )
    }

    async fn repository_trusts_provider_identity(
        &self,
        repository: &ReviewRepositoryLocator,
        platform: ReviewPlatformKind,
        host: &str,
        project_path: &str,
    ) -> bool {
        if !matches!(
            platform,
            ReviewPlatformKind::Github | ReviewPlatformKind::Gitlab | ReviewPlatformKind::Gitee
        ) {
            return false;
        }
        let Ok(scope) = self.workspace_git_scope(repository).await else {
            return false;
        };
        let Ok(output) = self
            .execute_scope_git_command(&scope, &["remote", "-v"])
            .await
        else {
            return false;
        };
        output.lines().any(|line| {
            let parts = line.split_whitespace().collect::<Vec<_>>();
            if parts.len() < 2 || parts.get(2).is_some_and(|kind| *kind != "(fetch)") {
                return false;
            }
            remote_url_matches_provider_identity(parts[1], platform, host, project_path)
        })
    }

    pub async fn update_auth_token(
        &self,
        platform: ReviewPlatformKind,
        host: &str,
        token: &str,
    ) -> Result<(), ReviewPlatformError> {
        if platform == ReviewPlatformKind::Github {
            return Err(ReviewPlatformError::Api(format!(
                "GitHub tokens are not stored by OpenBitFun. Authenticate the local GitHub CLI with `gh auth login --hostname {}`.",
                normalize_provider_host(host)?
            )));
        }
        let token = token.trim();
        if token.is_empty() {
            return Err(ReviewPlatformError::Api(
                "Token cannot be empty".to_string(),
            ));
        }
        let key = token_key(platform, host)
            .ok_or_else(|| ReviewPlatformError::UnsupportedPlatform(host.to_string()))?;
        let store = self.token_store_owner(platform, host)?;
        let _transaction = store.token_store_lock.lock().await;
        let mut stored = store.load_stored_token_file_unlocked().await?;
        stored.tokens.remove(&key);
        stored.tokens.insert(
            key,
            StoredReviewPlatformToken {
                token: token.to_string(),
                updated_at: chrono::Utc::now().to_rfc3339(),
            },
        );
        store.save_stored_token_file_unlocked(&stored).await
    }

    pub async fn clear_auth_token(
        &self,
        platform: ReviewPlatformKind,
        host: &str,
    ) -> Result<(), ReviewPlatformError> {
        if platform == ReviewPlatformKind::Github {
            return Err(ReviewPlatformError::Api(format!(
                "GitHub authentication is managed by the local GitHub CLI. Use `gh auth logout --hostname {}` if you want to sign out.",
                normalize_provider_host(host)?
            )));
        }
        let key = token_key(platform, host)
            .ok_or_else(|| ReviewPlatformError::UnsupportedPlatform(host.to_string()))?;
        let store = self.token_store_owner(platform, host)?;
        let _transaction = store.token_store_lock.lock().await;
        let mut stored = store.load_stored_token_file_unlocked().await?;
        stored.tokens.remove(&key);
        store.save_stored_token_file_unlocked(&stored).await
    }

    fn token_store_owner(
        &self,
        platform: ReviewPlatformKind,
        host: &str,
    ) -> Result<Self, ReviewPlatformError> {
        let path = if platform == ReviewPlatformKind::Gitee {
            if normalize_provider_host(host)? != "gitee.com" {
                return Err(ReviewPlatformError::UnsupportedPlatform(host.to_string()));
            }
            // Older hosts reject unknown authority keys in the shared v1 file.
            // Keep Gitee additive across upgrades and downgrades, using the same
            // atomic persistence and per-path locking as existing providers.
            self.token_store_path.with_extension("gitee.json")
        } else {
            self.token_store_path.clone()
        };
        Ok(Self::new(path, self.workspace_classifier.clone()))
    }
}

#[async_trait::async_trait]
trait ReviewProvider: Sync {
    async fn list_pull_requests(
        &self,
        ctx: &ProviderContext,
        pagination: PullRequestPagination,
    ) -> Result<ReviewPlatformPullRequestPage, ReviewPlatformError>;

    async fn list_pull_requests_with_state(
        &self,
        ctx: &ProviderContext,
        pagination: PullRequestPagination,
        state: ReviewPlatformListState,
    ) -> Result<ReviewPlatformPullRequestPage, ReviewPlatformError> {
        if state != ReviewPlatformListState::All {
            return Err(ReviewPlatformError::UnsupportedPlatform(format!(
                "{} pull request state filtering",
                platform_label(ctx.remote.platform)
            )));
        }
        self.list_pull_requests(ctx, pagination).await
    }

    async fn pull_request_detail(
        &self,
        ctx: &ProviderContext,
        pull_request_id: &str,
    ) -> Result<ReviewPlatformPullRequestDetail, ReviewPlatformError>;

    async fn pull_request_review_target(
        &self,
        ctx: &ProviderContext,
        pull_request_id: &str,
    ) -> Result<ReviewPlatformPullRequestReviewTarget, ReviewPlatformError> {
        let detail = self.pull_request_detail(ctx, pull_request_id).await?;
        Ok(review_target_from_parts(detail.pull_request, detail.files))
    }

    async fn pull_request_file_diff(
        &self,
        ctx: &ProviderContext,
        pull_request_id: &str,
        expected_base_revision: &str,
        expected_head_revision: &str,
        file_path: &str,
        _file_page_hint: Option<u32>,
    ) -> Result<ReviewPlatformPullRequestFileDiff, ReviewPlatformError> {
        let detail = self.pull_request_detail(ctx, pull_request_id).await?;
        file_diff_from_parts(
            detail.pull_request,
            detail.files,
            expected_base_revision,
            expected_head_revision,
            file_path,
        )
    }

    async fn pull_request_detail_page(
        &self,
        ctx: &ProviderContext,
        pull_request_id: &str,
        section: ReviewPlatformDetailSection,
        pagination: PullRequestPagination,
    ) -> Result<ReviewPlatformPullRequestDetailPage, ReviewPlatformError> {
        let detail = self.pull_request_detail(ctx, pull_request_id).await?;
        let ci_total = detail.ci.len();
        let file_total = detail.files.len();
        let commit_total = detail.commits.len();
        let thread_total = detail.threads.len();
        let (ci, files, commits, threads) = match section {
            ReviewPlatformDetailSection::Overview => {
                (Vec::new(), Vec::new(), Vec::new(), Vec::new())
            }
            ReviewPlatformDetailSection::Ci => (
                slice_page(detail.ci, pagination),
                Vec::new(),
                Vec::new(),
                Vec::new(),
            ),
            ReviewPlatformDetailSection::Files => (
                Vec::new(),
                slice_page(detail.files, pagination),
                Vec::new(),
                Vec::new(),
            ),
            ReviewPlatformDetailSection::Commits => (
                Vec::new(),
                Vec::new(),
                slice_page(detail.commits, pagination),
                Vec::new(),
            ),
            ReviewPlatformDetailSection::Reviews => (
                Vec::new(),
                Vec::new(),
                Vec::new(),
                slice_page(detail.threads, pagination),
            ),
        };
        let total = match section {
            ReviewPlatformDetailSection::Overview => 0,
            ReviewPlatformDetailSection::Ci => ci_total,
            ReviewPlatformDetailSection::Files => file_total,
            ReviewPlatformDetailSection::Commits => commit_total,
            ReviewPlatformDetailSection::Reviews => thread_total,
        };
        Ok(ReviewPlatformPullRequestDetailPage {
            limitations: detail.limitations,
            pull_request: detail.pull_request,
            body: detail.body,
            ci,
            files,
            commits,
            threads,
            section,
            pagination: pagination_from_total(pagination, total),
        })
    }

    async fn pull_request_ci_log(
        &self,
        ctx: &ProviderContext,
        _pull_request_id: &str,
        _ci_item_id: &str,
        _ci_item_name: &str,
    ) -> Result<ReviewPlatformCiLog, ReviewPlatformError> {
        Err(ReviewPlatformError::UnsupportedPlatform(format!(
            "{} CI logs",
            platform_label(ctx.remote.platform)
        )))
    }

    async fn create_pull_request(
        &self,
        ctx: &ProviderContext,
        _request: &ReviewPlatformCreatePullRequestRequest,
    ) -> Result<ReviewPlatformActionResult, ReviewPlatformError> {
        Err(ReviewPlatformError::UnsupportedPlatform(format!(
            "{} pull request creation",
            platform_label(ctx.remote.platform)
        )))
    }

    async fn reply_to_thread(
        &self,
        ctx: &ProviderContext,
        _request: &ReviewPlatformReplyToThreadRequest,
    ) -> Result<ReviewPlatformActionResult, ReviewPlatformError> {
        Err(ReviewPlatformError::UnsupportedPlatform(format!(
            "{} thread replies",
            platform_label(ctx.remote.platform)
        )))
    }

    async fn submit_review(
        &self,
        ctx: &ProviderContext,
        _request: &ReviewPlatformSubmitReviewRequest,
    ) -> Result<ReviewPlatformActionResult, ReviewPlatformError> {
        Err(ReviewPlatformError::UnsupportedPlatform(format!(
            "{} review submission",
            platform_label(ctx.remote.platform)
        )))
    }

    async fn resolve_thread(
        &self,
        ctx: &ProviderContext,
        _request: &ReviewPlatformResolveThreadRequest,
    ) -> Result<ReviewPlatformActionResult, ReviewPlatformError> {
        Err(ReviewPlatformError::UnsupportedPlatform(format!(
            "{} thread resolution",
            platform_label(ctx.remote.platform)
        )))
    }

    async fn approve_pull_request(
        &self,
        ctx: &ProviderContext,
        _request: &ReviewPlatformApprovalRequest,
    ) -> Result<ReviewPlatformActionResult, ReviewPlatformError> {
        Err(ReviewPlatformError::UnsupportedPlatform(format!(
            "{} pull request approval",
            platform_label(ctx.remote.platform)
        )))
    }

    async fn revoke_approval(
        &self,
        ctx: &ProviderContext,
        _request: &ReviewPlatformApprovalRequest,
    ) -> Result<ReviewPlatformActionResult, ReviewPlatformError> {
        Err(ReviewPlatformError::UnsupportedPlatform(format!(
            "{} approval revocation",
            platform_label(ctx.remote.platform)
        )))
    }

    async fn request_changes(
        &self,
        ctx: &ProviderContext,
        _request: &ReviewPlatformRequestChangesRequest,
    ) -> Result<ReviewPlatformActionResult, ReviewPlatformError> {
        Err(ReviewPlatformError::UnsupportedPlatform(format!(
            "{} native change requests",
            platform_label(ctx.remote.platform)
        )))
    }
}

struct GithubProvider;
struct GitlabProvider;
struct GitcodeProvider;
struct UnsupportedProvider;

fn provider_for(platform: ReviewPlatformKind) -> &'static dyn ReviewProvider {
    match platform {
        ReviewPlatformKind::Github => &GithubProvider,
        ReviewPlatformKind::Gitlab => &GitlabProvider,
        ReviewPlatformKind::Gitcode => &GitcodeProvider,
        ReviewPlatformKind::Gitee => &gitee::GiteeProvider,
        ReviewPlatformKind::Unknown => &UnsupportedProvider,
    }
}

fn ensure_pull_request_revisions_stable(
    initial: &ReviewPlatformPullRequest,
    confirmed: &ReviewPlatformPullRequest,
) -> Result<(), ReviewPlatformError> {
    if initial.id != confirmed.id
        || initial.base_revision != confirmed.base_revision
        || initial.head_revision != confirmed.head_revision
    {
        return Err(ReviewPlatformError::StaleTarget(
            "pull request revisions changed while preparing Review evidence".to_string(),
        ));
    }
    Ok(())
}

async fn github_review_target_parts(
    ctx: &ProviderContext,
    pull_request_id: &str,
) -> Result<(ReviewPlatformPullRequest, Vec<ReviewPlatformFile>), ReviewPlatformError> {
    let base = format!(
        "{}/repos/{}/{}/pulls/{}",
        ctx.api_base_url, ctx.remote.owner, ctx.remote.repository_name, pull_request_id
    );
    let initial_detail =
        github_api_get_json(ctx, &base, &[], MAX_REVIEW_TARGET_RESPONSE_BYTES).await?;
    let files_url = format!("{}/files", base);
    let files =
        fetch_bounded_github_paginated_array(ctx, &files_url, MAX_REVIEW_TARGET_LIST_ITEMS).await?;
    let confirmed_detail =
        github_api_get_json(ctx, &base, &[], MAX_REVIEW_TARGET_RESPONSE_BYTES).await?;
    let initial_pull_request = github_pull_request_from_value(&initial_detail);
    let confirmed_pull_request = github_pull_request_from_value(&confirmed_detail);
    ensure_pull_request_revisions_stable(&initial_pull_request, &confirmed_pull_request)?;
    Ok((
        confirmed_pull_request,
        array_items(&files)
            .iter()
            .map(github_file_from_value)
            .collect(),
    ))
}

async fn github_review_file_parts(
    ctx: &ProviderContext,
    pull_request_id: &str,
    file_path: &str,
    file_page_hint: Option<u32>,
) -> Result<(ReviewPlatformPullRequest, Vec<ReviewPlatformFile>), ReviewPlatformError> {
    let base = format!(
        "{}/repos/{}/{}/pulls/{}",
        ctx.api_base_url, ctx.remote.owner, ctx.remote.repository_name, pull_request_id
    );
    let initial_detail =
        github_api_get_json(ctx, &base, &[], MAX_REVIEW_TARGET_RESPONSE_BYTES).await?;
    let files_url = format!("{}/files", base);
    let file = fetch_bounded_github_file(
        ctx,
        &files_url,
        file_page_hint.unwrap_or(1),
        if file_page_hint.is_some() {
            100
        } else {
            MAX_REVIEW_TARGET_LIST_ITEMS
        },
        file_path,
    )
    .await?;
    let confirmed_detail =
        github_api_get_json(ctx, &base, &[], MAX_REVIEW_TARGET_RESPONSE_BYTES).await?;
    let initial_pull_request = github_pull_request_from_value(&initial_detail);
    let confirmed_pull_request = github_pull_request_from_value(&confirmed_detail);
    ensure_pull_request_revisions_stable(&initial_pull_request, &confirmed_pull_request)?;
    Ok((confirmed_pull_request, file.into_iter().collect()))
}

async fn gitlab_review_target_parts(
    ctx: &ProviderContext,
    pull_request_id: &str,
) -> Result<(ReviewPlatformPullRequest, Vec<ReviewPlatformFile>), ReviewPlatformError> {
    let client = http_client()?;
    let project = urlencoding::encode(&ctx.remote.project_path);
    let base = format!(
        "{}/projects/{}/merge_requests/{}",
        ctx.api_base_url, project, pull_request_id
    );
    let initial_detail =
        send_bounded_json(gitlab_request(client.clone(), &base, ctx.token.as_deref())).await?;
    let token = ctx.token.clone();
    let diffs_url = format!("{}/diffs", base);
    let diffs = fetch_bounded_paginated_array(
        |page| {
            let page = page.to_string();
            gitlab_request(client.clone(), &diffs_url, token.as_deref())
                .query(&[("per_page", "100"), ("page", &page)])
        },
        gitlab_next_page,
        MAX_REVIEW_TARGET_LIST_ITEMS,
    )
    .await?;
    let files = array_items(&diffs)
        .iter()
        .map(gitlab_file_from_value)
        .collect::<Vec<_>>();
    let confirmed_detail =
        send_bounded_json(gitlab_request(client, &base, ctx.token.as_deref())).await?;
    let initial_pull_request = gitlab_pull_request_from_value(&initial_detail);
    let confirmed_pull_request = gitlab_pull_request_from_value(&confirmed_detail);
    ensure_pull_request_revisions_stable(&initial_pull_request, &confirmed_pull_request)?;
    Ok((confirmed_pull_request, files))
}

async fn gitlab_review_file_parts(
    ctx: &ProviderContext,
    pull_request_id: &str,
    file_path: &str,
    file_page_hint: Option<u32>,
) -> Result<(ReviewPlatformPullRequest, Vec<ReviewPlatformFile>), ReviewPlatformError> {
    let client = http_client()?;
    let project = urlencoding::encode(&ctx.remote.project_path);
    let base = format!(
        "{}/projects/{}/merge_requests/{}",
        ctx.api_base_url, project, pull_request_id
    );
    let initial_detail =
        send_bounded_json(gitlab_request(client.clone(), &base, ctx.token.as_deref())).await?;
    let token = ctx.token.clone();
    let diffs_url = format!("{}/diffs", base);
    let file = fetch_bounded_paginated_file(
        |page| {
            let page = page.to_string();
            gitlab_request(client.clone(), &diffs_url, token.as_deref())
                .query(&[("per_page", "100"), ("page", &page)])
        },
        gitlab_next_page,
        file_page_hint.unwrap_or(1),
        if file_page_hint.is_some() {
            100
        } else {
            MAX_REVIEW_TARGET_LIST_ITEMS
        },
        file_path,
        gitlab_file_from_value,
    )
    .await?;
    let confirmed_detail =
        send_bounded_json(gitlab_request(client, &base, ctx.token.as_deref())).await?;
    let initial_pull_request = gitlab_pull_request_from_value(&initial_detail);
    let confirmed_pull_request = gitlab_pull_request_from_value(&confirmed_detail);
    ensure_pull_request_revisions_stable(&initial_pull_request, &confirmed_pull_request)?;
    Ok((confirmed_pull_request, file.into_iter().collect()))
}

async fn gitcode_review_target_parts(
    ctx: &ProviderContext,
    pull_request_id: &str,
) -> Result<(ReviewPlatformPullRequest, Vec<ReviewPlatformFile>), ReviewPlatformError> {
    let client = http_client()?;
    let base = format!(
        "{}/repos/{}/{}/pulls/{}",
        ctx.api_base_url, ctx.remote.owner, ctx.remote.repository_name, pull_request_id
    );
    let initial_detail =
        send_bounded_json(gitcode_request(client.clone(), &base, ctx.token.as_deref())).await?;
    let files_url = format!("{}/files", base);
    let files_response = send_bounded_gitcode_files_response(gitcode_request(
        client.clone(),
        &files_url,
        ctx.token.as_deref(),
    ))
    .await?;
    let files = files_response
        .value
        .as_array()
        .ok_or_else(|| {
            ReviewPlatformError::Parse(
                "GitCode pull request files response was not an array".to_string(),
            )
        })?
        .iter()
        .take(MAX_REVIEW_TARGET_LIST_ITEMS)
        .map(gitcode_file_from_value)
        .collect::<Vec<_>>();
    let confirmed_detail =
        send_bounded_json(gitcode_request(client, &base, ctx.token.as_deref())).await?;
    let initial_pull_request = gitcode_pull_request_from_value(&initial_detail);
    let mut confirmed_pull_request = gitcode_pull_request_from_value(&confirmed_detail);
    ensure_pull_request_revisions_stable(&initial_pull_request, &confirmed_pull_request)?;
    apply_gitcode_pull_request_change_stats(&mut confirmed_pull_request, &files_response);
    Ok((confirmed_pull_request, files))
}

// The page hint is unusable here: GitCode answers `/files` with the whole list
// regardless of the page parameters, so the file is searched in that response.
async fn gitcode_review_file_parts(
    ctx: &ProviderContext,
    pull_request_id: &str,
    file_path: &str,
    _file_page_hint: Option<u32>,
) -> Result<(ReviewPlatformPullRequest, Vec<ReviewPlatformFile>), ReviewPlatformError> {
    let client = http_client()?;
    let base = format!(
        "{}/repos/{}/{}/pulls/{}",
        ctx.api_base_url, ctx.remote.owner, ctx.remote.repository_name, pull_request_id
    );
    let files_url = format!("{}/files", base);
    let files = send_bounded_gitcode_files_response(gitcode_request(
        client.clone(),
        &files_url,
        ctx.token.as_deref(),
    ))
    .await?
    .value;
    let file = files
        .as_array()
        .ok_or_else(|| {
            ReviewPlatformError::Parse(
                "GitCode pull request files response was not an array".to_string(),
            )
        })?
        .iter()
        .map(gitcode_file_from_value)
        .find(|file| file.path == file_path || file.old_path.as_deref() == Some(file_path));
    let detail = send_bounded_json(gitcode_request(client, &base, ctx.token.as_deref())).await?;
    Ok((
        gitcode_pull_request_from_value(&detail),
        file.into_iter().collect(),
    ))
}

#[async_trait::async_trait]
impl ReviewProvider for GithubProvider {
    async fn list_pull_requests(
        &self,
        ctx: &ProviderContext,
        pagination: PullRequestPagination,
    ) -> Result<ReviewPlatformPullRequestPage, ReviewPlatformError> {
        github_current_user_open_pull_requests(ctx, pagination).await
    }

    async fn pull_request_detail(
        &self,
        ctx: &ProviderContext,
        pull_request_id: &str,
    ) -> Result<ReviewPlatformPullRequestDetail, ReviewPlatformError> {
        let base = format!(
            "{}/repos/{}/{}/pulls/{}",
            ctx.api_base_url, ctx.remote.owner, ctx.remote.repository_name, pull_request_id
        );
        let detail = github_api_get_json(ctx, &base, &[], DEFAULT_GH_OUTPUT_MAX_BYTES).await?;
        let files_url = format!("{}/files", base);
        let files = fetch_github_paginated_array(ctx, &files_url).await?;
        let commits_url = format!("{}/commits", base);
        let commits = fetch_github_paginated_array(ctx, &commits_url).await?;
        let reviews_url = format!("{}/reviews", base);
        let reviews = fetch_github_paginated_array(ctx, &reviews_url).await?;
        let review_comments_url = format!("{}/comments", base);
        let review_comments = fetch_github_paginated_array(ctx, &review_comments_url).await?;
        let issue_comments_url = format!(
            "{}/repos/{}/{}/issues/{}/comments",
            ctx.api_base_url, ctx.remote.owner, ctx.remote.repository_name, pull_request_id
        );
        let issue_comments = fetch_github_paginated_array(ctx, &issue_comments_url).await?;

        let mut pull_request = github_pull_request_from_value(&detail);
        pull_request.review_decision = github_review_decision(&reviews);
        let (checks, ci) = github_checks_and_ci(ctx, &detail).await;
        pull_request.checks = checks;

        Ok(ReviewPlatformPullRequestDetail {
            limitations: Vec::new(),
            body: value_string(&detail, "body"),
            pull_request,
            ci,
            files: array_items(&files)
                .iter()
                .map(github_file_from_value)
                .collect(),
            commits: array_items(&commits)
                .iter()
                .map(github_commit_from_value)
                .collect(),
            threads: github_threads(&reviews, &review_comments, &issue_comments),
        })
    }

    async fn pull_request_review_target(
        &self,
        ctx: &ProviderContext,
        pull_request_id: &str,
    ) -> Result<ReviewPlatformPullRequestReviewTarget, ReviewPlatformError> {
        let (pull_request, files) = github_review_target_parts(ctx, pull_request_id).await?;
        Ok(review_target_from_parts(pull_request, files))
    }

    async fn pull_request_file_diff(
        &self,
        ctx: &ProviderContext,
        pull_request_id: &str,
        expected_base_revision: &str,
        expected_head_revision: &str,
        file_path: &str,
        file_page_hint: Option<u32>,
    ) -> Result<ReviewPlatformPullRequestFileDiff, ReviewPlatformError> {
        let (pull_request, files) =
            github_review_file_parts(ctx, pull_request_id, file_path, file_page_hint).await?;
        file_diff_from_parts(
            pull_request,
            files,
            expected_base_revision,
            expected_head_revision,
            file_path,
        )
    }

    async fn pull_request_detail_page(
        &self,
        ctx: &ProviderContext,
        pull_request_id: &str,
        section: ReviewPlatformDetailSection,
        pagination: PullRequestPagination,
    ) -> Result<ReviewPlatformPullRequestDetailPage, ReviewPlatformError> {
        github_pull_request_detail_page(ctx, pull_request_id, section, pagination).await
    }

    async fn pull_request_ci_log(
        &self,
        ctx: &ProviderContext,
        pull_request_id: &str,
        ci_item_id: &str,
        ci_item_name: &str,
    ) -> Result<ReviewPlatformCiLog, ReviewPlatformError> {
        if ci_item_id.starts_with("status-") {
            return Ok(ReviewPlatformCiLog {
                ci_item_id: ci_item_id.to_string(),
                log: None,
                truncated: false,
                message: Some(
                    "GitHub commit statuses do not expose logs; use the linked target URL instead."
                        .to_string(),
                ),
            });
        }

        let base = format!(
            "{}/repos/{}/{}/pulls/{}",
            ctx.api_base_url, ctx.remote.owner, ctx.remote.repository_name, pull_request_id
        );
        let detail = github_api_get_json(ctx, &base, &[], DEFAULT_GH_OUTPUT_MAX_BYTES).await?;
        let sha = nested_string(&detail, &["head", "sha"]);
        if sha.trim().is_empty() {
            return Ok(ReviewPlatformCiLog {
                ci_item_id: ci_item_id.to_string(),
                log: None,
                truncated: false,
                message: Some("GitHub pull request head SHA was not available.".to_string()),
            });
        }

        let check_run_id = ci_item_id.strip_prefix("check-run-").unwrap_or(ci_item_id);
        github_actions_log_for_check_run_item(ctx, check_run_id, ci_item_name, &sha).await
    }

    async fn create_pull_request(
        &self,
        ctx: &ProviderContext,
        request: &ReviewPlatformCreatePullRequestRequest,
    ) -> Result<ReviewPlatformActionResult, ReviewPlatformError> {
        let url = format!(
            "{}/repos/{}/{}/pulls",
            ctx.api_base_url, ctx.remote.owner, ctx.remote.repository_name
        );
        let payload = json!({
            "title": request.title,
            "head": request.source_branch,
            "base": request.target_branch,
            "body": request.body.clone().unwrap_or_default(),
            "draft": request.draft.unwrap_or(false),
        });
        let value = github_api_post_json(ctx, &url, &payload).await?;
        let pull_request = github_pull_request_from_value(&value);
        let web_url = Some(pull_request.web_url.clone());
        Ok(ReviewPlatformActionResult {
            success: true,
            message: format!("Created pull request #{}", pull_request.number),
            web_url,
            pull_request: Some(pull_request),
            thread: None,
        })
    }

    async fn reply_to_thread(
        &self,
        ctx: &ProviderContext,
        request: &ReviewPlatformReplyToThreadRequest,
    ) -> Result<ReviewPlatformActionResult, ReviewPlatformError> {
        let comment_id = parse_provider_comment_id(&request.thread_id).ok_or_else(|| {
            ReviewPlatformError::Api(
                "GitHub replies require a review comment thread id such as comment-123".to_string(),
            )
        })?;
        let url = format!(
            "{}/repos/{}/{}/pulls/{}/comments/{}/replies",
            ctx.api_base_url,
            ctx.remote.owner,
            ctx.remote.repository_name,
            request.pull_request_id,
            comment_id
        );
        let value = github_api_post_json(ctx, &url, &json!({ "body": request.body })).await?;
        let thread = github_thread_from_review_comment(&value);
        Ok(ReviewPlatformActionResult {
            success: true,
            message: "Replied to pull request thread".to_string(),
            web_url: value
                .get("html_url")
                .and_then(Value::as_str)
                .map(str::to_string),
            pull_request: None,
            thread: Some(thread),
        })
    }

    async fn submit_review(
        &self,
        ctx: &ProviderContext,
        request: &ReviewPlatformSubmitReviewRequest,
    ) -> Result<ReviewPlatformActionResult, ReviewPlatformError> {
        let event = match request.event {
            ReviewSubmitEvent::Comment => "COMMENT",
            ReviewSubmitEvent::Approve => "APPROVE",
            ReviewSubmitEvent::RequestChanges => "REQUEST_CHANGES",
        };
        github_submit_review(ctx, &request.pull_request_id, event, &request.body).await
    }

    async fn approve_pull_request(
        &self,
        ctx: &ProviderContext,
        request: &ReviewPlatformApprovalRequest,
    ) -> Result<ReviewPlatformActionResult, ReviewPlatformError> {
        github_submit_review(
            ctx,
            &request.pull_request_id,
            "APPROVE",
            request.body.as_deref().unwrap_or(""),
        )
        .await
    }

    async fn request_changes(
        &self,
        ctx: &ProviderContext,
        request: &ReviewPlatformRequestChangesRequest,
    ) -> Result<ReviewPlatformActionResult, ReviewPlatformError> {
        github_submit_review(
            ctx,
            &request.pull_request_id,
            "REQUEST_CHANGES",
            &request.body,
        )
        .await
    }
}

async fn github_submit_review(
    ctx: &ProviderContext,
    pull_request_id: &str,
    event: &str,
    body: &str,
) -> Result<ReviewPlatformActionResult, ReviewPlatformError> {
    let url = format!(
        "{}/repos/{}/{}/pulls/{}/reviews",
        ctx.api_base_url, ctx.remote.owner, ctx.remote.repository_name, pull_request_id
    );
    let value = github_api_post_json(
        ctx,
        &url,
        &json!({
            "body": body,
            "event": event,
        }),
    )
    .await?;
    Ok(ReviewPlatformActionResult {
        success: true,
        message: format!("Submitted GitHub review with event {}", event),
        web_url: value
            .get("html_url")
            .and_then(Value::as_str)
            .map(str::to_string),
        pull_request: None,
        thread: None,
    })
}

async fn github_pull_request_detail_page(
    ctx: &ProviderContext,
    pull_request_id: &str,
    section: ReviewPlatformDetailSection,
    pagination: PullRequestPagination,
) -> Result<ReviewPlatformPullRequestDetailPage, ReviewPlatformError> {
    let base = format!(
        "{}/repos/{}/{}/pulls/{}",
        ctx.api_base_url, ctx.remote.owner, ctx.remote.repository_name, pull_request_id
    );
    let detail = github_api_get_json(ctx, &base, &[], DEFAULT_GH_OUTPUT_MAX_BYTES).await?;
    let mut pull_request = github_pull_request_from_value(&detail);
    let (checks, ci_all) = github_checks_and_ci(ctx, &detail).await;
    pull_request.checks = checks;

    let mut files = Vec::new();
    let mut commits = Vec::new();
    let mut threads = Vec::new();
    let mut ci = Vec::new();
    let mut section_pagination = empty_detail_pagination(section, pagination);

    match section {
        ReviewPlatformDetailSection::Overview => {}
        ReviewPlatformDetailSection::Ci => {
            section_pagination = pagination_from_total(pagination, ci_all.len());
            ci = slice_page(ci_all, pagination);
        }
        ReviewPlatformDetailSection::Files => {
            let (response, page_info) =
                github_api_array_page(ctx, &format!("{}/files", base), pagination, &[]).await?;
            section_pagination = page_info;
            files = array_items(&response)
                .iter()
                .map(github_file_from_value)
                .collect();
        }
        ReviewPlatformDetailSection::Commits => {
            let (response, page_info) =
                github_api_array_page(ctx, &format!("{}/commits", base), pagination, &[]).await?;
            section_pagination = page_info;
            commits = array_items(&response)
                .iter()
                .map(github_commit_from_value)
                .collect();
        }
        ReviewPlatformDetailSection::Reviews => {
            let reviews_url = format!("{}/reviews", base);
            let (reviews, reviews_page) =
                github_api_array_page(ctx, &reviews_url, pagination, &[]).await?;
            let (review_comments, review_comments_page) =
                github_api_array_page(ctx, &format!("{}/comments", base), pagination, &[]).await?;
            let (issue_comments, issue_comments_page) = github_api_array_page(
                ctx,
                &format!(
                    "{}/repos/{}/{}/issues/{}/comments",
                    ctx.api_base_url, ctx.remote.owner, ctx.remote.repository_name, pull_request_id
                ),
                pagination,
                &[],
            )
            .await?;
            pull_request.review_decision = github_review_decision(&reviews);
            section_pagination = combine_page_pagination(
                pagination,
                &[reviews_page, review_comments_page, issue_comments_page],
            );
            threads = github_threads(&reviews, &review_comments, &issue_comments);
        }
    }

    Ok(ReviewPlatformPullRequestDetailPage {
        limitations: Vec::new(),
        pull_request,
        body: value_string(&detail, "body"),
        ci,
        files,
        commits,
        threads,
        section,
        pagination: section_pagination,
    })
}

#[async_trait::async_trait]
impl ReviewProvider for GitlabProvider {
    async fn list_pull_requests(
        &self,
        ctx: &ProviderContext,
        pagination: PullRequestPagination,
    ) -> Result<ReviewPlatformPullRequestPage, ReviewPlatformError> {
        gitlab_list_pull_requests(ctx, pagination).await
    }

    async fn pull_request_detail(
        &self,
        ctx: &ProviderContext,
        pull_request_id: &str,
    ) -> Result<ReviewPlatformPullRequestDetail, ReviewPlatformError> {
        gitlab_pull_request_detail(ctx, pull_request_id).await
    }

    async fn pull_request_review_target(
        &self,
        ctx: &ProviderContext,
        pull_request_id: &str,
    ) -> Result<ReviewPlatformPullRequestReviewTarget, ReviewPlatformError> {
        let (pull_request, files) = gitlab_review_target_parts(ctx, pull_request_id).await?;
        Ok(review_target_from_parts(pull_request, files))
    }

    async fn pull_request_file_diff(
        &self,
        ctx: &ProviderContext,
        pull_request_id: &str,
        expected_base_revision: &str,
        expected_head_revision: &str,
        file_path: &str,
        file_page_hint: Option<u32>,
    ) -> Result<ReviewPlatformPullRequestFileDiff, ReviewPlatformError> {
        let (pull_request, files) =
            gitlab_review_file_parts(ctx, pull_request_id, file_path, file_page_hint).await?;
        file_diff_from_parts(
            pull_request,
            files,
            expected_base_revision,
            expected_head_revision,
            file_path,
        )
    }

    async fn pull_request_detail_page(
        &self,
        ctx: &ProviderContext,
        pull_request_id: &str,
        section: ReviewPlatformDetailSection,
        pagination: PullRequestPagination,
    ) -> Result<ReviewPlatformPullRequestDetailPage, ReviewPlatformError> {
        gitlab_pull_request_detail_page(ctx, pull_request_id, section, pagination).await
    }

    async fn pull_request_ci_log(
        &self,
        ctx: &ProviderContext,
        pull_request_id: &str,
        ci_item_id: &str,
        ci_item_name: &str,
    ) -> Result<ReviewPlatformCiLog, ReviewPlatformError> {
        gitlab_pull_request_ci_log(ctx, pull_request_id, ci_item_id, ci_item_name).await
    }

    async fn create_pull_request(
        &self,
        ctx: &ProviderContext,
        request: &ReviewPlatformCreatePullRequestRequest,
    ) -> Result<ReviewPlatformActionResult, ReviewPlatformError> {
        gitlab_create_pull_request(ctx, request, "merge request").await
    }

    async fn reply_to_thread(
        &self,
        ctx: &ProviderContext,
        request: &ReviewPlatformReplyToThreadRequest,
    ) -> Result<ReviewPlatformActionResult, ReviewPlatformError> {
        gitlab_reply_to_thread(ctx, request, "merge request").await
    }

    async fn submit_review(
        &self,
        ctx: &ProviderContext,
        request: &ReviewPlatformSubmitReviewRequest,
    ) -> Result<ReviewPlatformActionResult, ReviewPlatformError> {
        if request.event != ReviewSubmitEvent::Comment {
            return Err(ReviewPlatformError::UnsupportedPlatform(
                "GitLab submit_review supports comments only; use approve_pull_request for approvals"
                    .to_string(),
            ));
        }
        gitlab_add_merge_request_note(
            ctx,
            &request.pull_request_id,
            &request.body,
            "Added merge request comment",
        )
        .await
    }

    async fn resolve_thread(
        &self,
        ctx: &ProviderContext,
        request: &ReviewPlatformResolveThreadRequest,
    ) -> Result<ReviewPlatformActionResult, ReviewPlatformError> {
        gitlab_resolve_thread(ctx, request, "merge request").await
    }

    async fn approve_pull_request(
        &self,
        ctx: &ProviderContext,
        request: &ReviewPlatformApprovalRequest,
    ) -> Result<ReviewPlatformActionResult, ReviewPlatformError> {
        gitlab_approve_pull_request(ctx, request, "merge request").await
    }

    async fn revoke_approval(
        &self,
        ctx: &ProviderContext,
        request: &ReviewPlatformApprovalRequest,
    ) -> Result<ReviewPlatformActionResult, ReviewPlatformError> {
        gitlab_revoke_approval(ctx, request, "merge request").await
    }
}

async fn gitlab_list_pull_requests(
    ctx: &ProviderContext,
    pagination: PullRequestPagination,
) -> Result<ReviewPlatformPullRequestPage, ReviewPlatformError> {
    let project = urlencoding::encode(&ctx.remote.project_path);
    let url = format!("{}/projects/{}/merge_requests", ctx.api_base_url, project);
    let per_page = pagination.per_page.to_string();
    let page = pagination.page.to_string();
    let response = send_json_response(
        gitlab_request(http_client()?, &url, ctx.token.as_deref()).query(&[
            ("state", "all"),
            ("per_page", &per_page),
            ("page", &page),
        ]),
    )
    .await?;
    let items = response.value.as_array().ok_or_else(|| {
        ReviewPlatformError::Parse("GitLab merge request response was not an array".to_string())
    })?;
    let total = header_u64(&response.headers, "x-total");
    let has_next = header_string(&response.headers, "x-next-page")
        .is_some_and(|value| !value.trim().is_empty())
        || total
            .map(|total| u64::from(pagination.page) * u64::from(pagination.per_page) < total)
            .unwrap_or(false);

    let pull_requests = items
        .iter()
        .map(gitlab_pull_request_from_value)
        .collect::<Vec<_>>();
    let pull_requests = enrich_gitlab_pull_request_counts(ctx, pull_requests).await;

    Ok(ReviewPlatformPullRequestPage {
        items: pull_requests,
        pagination: ReviewPlatformPagination {
            page: pagination.page,
            per_page: pagination.per_page,
            total,
            has_next,
        },
    })
}

async fn gitlab_pull_request_detail(
    ctx: &ProviderContext,
    pull_request_id: &str,
) -> Result<ReviewPlatformPullRequestDetail, ReviewPlatformError> {
    let client = http_client()?;
    let project = urlencoding::encode(&ctx.remote.project_path);
    let base = format!(
        "{}/projects/{}/merge_requests/{}",
        ctx.api_base_url, project, pull_request_id
    );
    let detail = send_json(gitlab_request(client.clone(), &base, ctx.token.as_deref())).await?;
    let changes = send_json(gitlab_request(
        client.clone(),
        &format!("{}/changes", base),
        ctx.token.as_deref(),
    ))
    .await?;
    let token = ctx.token.clone();
    let commits_url = format!("{}/commits", base);
    let commits = fetch_paginated_array(
        |page| {
            let page = page.to_string();
            gitlab_request(client.clone(), &commits_url, token.as_deref())
                .query(&[("per_page", "100"), ("page", &page)])
        },
        gitlab_next_page,
    )
    .await?;
    let token = ctx.token.clone();
    let discussions_url = format!("{}/discussions", base);
    let discussions = fetch_paginated_array(
        |page| {
            let page = page.to_string();
            gitlab_request(client.clone(), &discussions_url, token.as_deref())
                .query(&[("per_page", "100"), ("page", &page)])
        },
        gitlab_next_page,
    )
    .await?;
    let token = ctx.token.clone();
    let notes_url = format!("{}/notes", base);
    let notes = fetch_paginated_array(
        |page| {
            let page = page.to_string();
            gitlab_request(client.clone(), &notes_url, token.as_deref())
                .query(&[("per_page", "100"), ("page", &page)])
        },
        gitlab_next_page,
    )
    .await?;

    let mut pull_request = gitlab_pull_request_from_value(&detail);
    let files = gitlab_files(&changes);
    apply_files_stats(&mut pull_request, &files);
    let ci = gitlab_pipeline_summary_item(&detail)
        .into_iter()
        .collect::<Vec<_>>();
    pull_request.checks = summarize_ci_items(&ci);

    Ok(ReviewPlatformPullRequestDetail {
        limitations: Vec::new(),
        body: value_string(&detail, "description"),
        pull_request,
        ci,
        files,
        commits: array_items(&commits)
            .iter()
            .map(gitlab_commit_from_value)
            .collect(),
        threads: gitlab_threads(&discussions, &notes),
    })
}

async fn gitlab_pull_request_detail_page(
    ctx: &ProviderContext,
    pull_request_id: &str,
    section: ReviewPlatformDetailSection,
    pagination: PullRequestPagination,
) -> Result<ReviewPlatformPullRequestDetailPage, ReviewPlatformError> {
    let client = http_client()?;
    let project = urlencoding::encode(&ctx.remote.project_path);
    let base = format!(
        "{}/projects/{}/merge_requests/{}",
        ctx.api_base_url, project, pull_request_id
    );
    let detail = send_json(gitlab_request(client.clone(), &base, ctx.token.as_deref())).await?;
    let mut pull_request = gitlab_pull_request_from_value(&detail);
    let changes = send_json(gitlab_request(
        client.clone(),
        &format!("{}/changes", base),
        ctx.token.as_deref(),
    ))
    .await?;
    let all_files = gitlab_files(&changes);
    apply_files_stats(&mut pull_request, &all_files);
    let mut ci = gitlab_pipeline_summary_item(&detail)
        .into_iter()
        .collect::<Vec<_>>();
    pull_request.checks = summarize_ci_items(&ci);
    let mut files = Vec::new();
    let mut commits = Vec::new();
    let mut threads = Vec::new();
    let mut section_pagination = empty_detail_pagination(section, pagination);

    match section {
        ReviewPlatformDetailSection::Overview => {}
        ReviewPlatformDetailSection::Ci => {
            if let Some(pipeline_id) = detail
                .get("head_pipeline")
                .and_then(|value| value.get("id"))
                .and_then(Value::as_i64)
                .map(|id| id.to_string())
                .or_else(|| {
                    detail
                        .get("head_pipeline")
                        .and_then(|value| value.get("id"))
                        .and_then(Value::as_str)
                        .map(str::to_string)
                })
            {
                let jobs = gitlab_pipeline_jobs(
                    ctx,
                    client.clone(),
                    &urlencoding::encode(&ctx.remote.project_path),
                    &pipeline_id,
                )
                .await;
                if !jobs.is_empty() {
                    ci = jobs;
                    pull_request.checks = summarize_ci_items(&ci);
                }
            }
            section_pagination = pagination_from_total(pagination, ci.len());
            ci = slice_page(ci, pagination);
        }
        ReviewPlatformDetailSection::Files => {
            section_pagination = pagination_from_total(pagination, all_files.len());
            files = slice_page(all_files, pagination);
        }
        ReviewPlatformDetailSection::Commits => {
            let response = fetch_array_page(
                gitlab_request(
                    client.clone(),
                    &format!("{}/commits", base),
                    ctx.token.as_deref(),
                ),
                pagination,
            )
            .await?;
            section_pagination = pagination_from_response(&response, pagination);
            commits = array_items(&response.value)
                .iter()
                .map(gitlab_commit_from_value)
                .collect();
        }
        ReviewPlatformDetailSection::Reviews => {
            let discussions = fetch_array_page(
                gitlab_request(
                    client.clone(),
                    &format!("{}/discussions", base),
                    ctx.token.as_deref(),
                ),
                pagination,
            )
            .await?;
            let notes = fetch_array_page(
                gitlab_request(
                    client.clone(),
                    &format!("{}/notes", base),
                    ctx.token.as_deref(),
                ),
                pagination,
            )
            .await?;
            section_pagination = combine_page_pagination(
                pagination,
                &[
                    pagination_from_response(&discussions, pagination),
                    pagination_from_response(&notes, pagination),
                ],
            );
            threads = gitlab_threads(&discussions.value, &notes.value);
        }
    }

    Ok(ReviewPlatformPullRequestDetailPage {
        limitations: Vec::new(),
        pull_request,
        body: value_string(&detail, "description"),
        ci,
        files,
        commits,
        threads,
        section,
        pagination: section_pagination,
    })
}

async fn gitlab_create_pull_request(
    ctx: &ProviderContext,
    request: &ReviewPlatformCreatePullRequestRequest,
    label: &str,
) -> Result<ReviewPlatformActionResult, ReviewPlatformError> {
    let token = require_write_token(ctx, &format!("Creating a {}", label))?;
    let project = urlencoding::encode(&ctx.remote.project_path);
    let url = format!("{}/projects/{}/merge_requests", ctx.api_base_url, project);
    let value = send_json(
        gitlab_post_request(http_client()?, &url, Some(token)).json(&json!({
            "title": request.title,
            "source_branch": request.source_branch,
            "target_branch": request.target_branch,
            "description": request.body.clone().unwrap_or_default(),
        })),
    )
    .await?;
    let pull_request = gitlab_pull_request_from_value(&value);
    let web_url = Some(pull_request.web_url.clone());
    Ok(ReviewPlatformActionResult {
        success: true,
        message: format!("Created {} !{}", label, pull_request.number),
        web_url,
        pull_request: Some(pull_request),
        thread: None,
    })
}

async fn gitlab_reply_to_thread(
    ctx: &ProviderContext,
    request: &ReviewPlatformReplyToThreadRequest,
    label: &str,
) -> Result<ReviewPlatformActionResult, ReviewPlatformError> {
    let token = require_write_token(ctx, &format!("Replying to a {} thread", label))?;
    let discussion_id = parse_provider_thread_id(&request.thread_id).ok_or_else(|| {
        ReviewPlatformError::Api(
            "Replies require a discussion thread id from pull request detail".to_string(),
        )
    })?;
    let project = urlencoding::encode(&ctx.remote.project_path);
    let url = format!(
        "{}/projects/{}/merge_requests/{}/discussions/{}/notes",
        ctx.api_base_url, project, request.pull_request_id, discussion_id
    );
    let value = send_json(
        gitlab_post_request(http_client()?, &url, Some(token))
            .json(&json!({ "body": request.body })),
    )
    .await?;
    let thread = gitlab_thread_from_note(
        &value,
        Some(discussion_id.to_string()),
        false,
        ReviewPlatformThreadKind::Comment,
        None,
    );
    Ok(ReviewPlatformActionResult {
        success: true,
        message: format!("Replied to {} discussion", label),
        web_url: None,
        pull_request: None,
        thread: Some(thread),
    })
}

async fn gitlab_add_merge_request_note(
    ctx: &ProviderContext,
    pull_request_id: &str,
    body: &str,
    message: &str,
) -> Result<ReviewPlatformActionResult, ReviewPlatformError> {
    let token = require_write_token(ctx, "Adding a merge request comment")?;
    let project = urlencoding::encode(&ctx.remote.project_path);
    let url = format!(
        "{}/projects/{}/merge_requests/{}/notes",
        ctx.api_base_url, project, pull_request_id
    );
    let value = send_json(
        gitlab_post_request(http_client()?, &url, Some(token)).json(&json!({ "body": body })),
    )
    .await?;
    let thread =
        gitlab_thread_from_note(&value, None, false, ReviewPlatformThreadKind::Comment, None);
    Ok(ReviewPlatformActionResult {
        success: true,
        message: message.to_string(),
        web_url: None,
        pull_request: None,
        thread: Some(thread),
    })
}

async fn gitlab_resolve_thread(
    ctx: &ProviderContext,
    request: &ReviewPlatformResolveThreadRequest,
    label: &str,
) -> Result<ReviewPlatformActionResult, ReviewPlatformError> {
    let token = require_write_token(ctx, &format!("Resolving a {} thread", label))?;
    let discussion_id = parse_provider_thread_id(&request.thread_id).ok_or_else(|| {
        ReviewPlatformError::Api(
            "Thread resolution requires a discussion thread id from pull request detail"
                .to_string(),
        )
    })?;
    let project = urlencoding::encode(&ctx.remote.project_path);
    let url = format!(
        "{}/projects/{}/merge_requests/{}/discussions/{}",
        ctx.api_base_url, project, request.pull_request_id, discussion_id
    );
    send_json(
        gitlab_put_request(http_client()?, &url, Some(token))
            .json(&json!({ "resolved": request.resolved })),
    )
    .await?;
    Ok(ReviewPlatformActionResult {
        success: true,
        message: if request.resolved {
            format!("Resolved {} discussion", label)
        } else {
            format!("Reopened {} discussion", label)
        },
        web_url: None,
        pull_request: None,
        thread: None,
    })
}

async fn gitlab_approve_pull_request(
    ctx: &ProviderContext,
    request: &ReviewPlatformApprovalRequest,
    label: &str,
) -> Result<ReviewPlatformActionResult, ReviewPlatformError> {
    let token = require_write_token(ctx, &format!("Approving a {}", label))?;
    let project = urlencoding::encode(&ctx.remote.project_path);
    let url = format!(
        "{}/projects/{}/merge_requests/{}/approve",
        ctx.api_base_url, project, request.pull_request_id
    );
    send_json(gitlab_post_request(http_client()?, &url, Some(token))).await?;
    if let Some(body) = request
        .body
        .as_deref()
        .filter(|value| !value.trim().is_empty())
    {
        let _ = gitlab_add_merge_request_note(
            ctx,
            &request.pull_request_id,
            body,
            "Added approval note",
        )
        .await;
    }
    Ok(ReviewPlatformActionResult {
        success: true,
        message: format!("Approved {}", label),
        web_url: None,
        pull_request: None,
        thread: None,
    })
}

async fn gitlab_revoke_approval(
    ctx: &ProviderContext,
    request: &ReviewPlatformApprovalRequest,
    label: &str,
) -> Result<ReviewPlatformActionResult, ReviewPlatformError> {
    let token = require_write_token(ctx, &format!("Revoking approval for a {}", label))?;
    let project = urlencoding::encode(&ctx.remote.project_path);
    let url = format!(
        "{}/projects/{}/merge_requests/{}/unapprove",
        ctx.api_base_url, project, request.pull_request_id
    );
    send_json(gitlab_post_request(http_client()?, &url, Some(token))).await?;
    Ok(ReviewPlatformActionResult {
        success: true,
        message: format!("Revoked approval for {}", label),
        web_url: None,
        pull_request: None,
        thread: None,
    })
}

async fn gitcode_add_pull_request_comment(
    ctx: &ProviderContext,
    pull_request_id: &str,
    body: &str,
) -> Result<ReviewPlatformActionResult, ReviewPlatformError> {
    let token = require_write_token(ctx, "Adding a GitCode pull request comment")?;
    let url = format!(
        "{}/repos/{}/{}/pulls/{}/comments",
        ctx.api_base_url, ctx.remote.owner, ctx.remote.repository_name, pull_request_id
    );
    let value = send_json(
        gitcode_post_request(http_client()?, &url, Some(token)).json(&json!({ "body": body })),
    )
    .await?;
    let thread = gitcode_threads(&Value::Array(vec![value]))
        .into_iter()
        .next();
    Ok(ReviewPlatformActionResult {
        success: true,
        message: "Added GitCode pull request comment".to_string(),
        web_url: None,
        pull_request: None,
        thread,
    })
}

async fn gitcode_pull_request_detail_page(
    ctx: &ProviderContext,
    pull_request_id: &str,
    section: ReviewPlatformDetailSection,
    pagination: PullRequestPagination,
) -> Result<ReviewPlatformPullRequestDetailPage, ReviewPlatformError> {
    let client = http_client()?;
    let base = format!(
        "{}/repos/{}/{}/pulls/{}",
        ctx.api_base_url, ctx.remote.owner, ctx.remote.repository_name, pull_request_id
    );
    let detail = send_json(gitcode_request(client.clone(), &base, ctx.token.as_deref())).await?;
    let mut ci = gitcode_ci_items(&detail);
    let mut pull_request = gitcode_pull_request_from_value(&detail);
    pull_request.checks = summarize_ci_items(&ci);
    let mut files = Vec::new();
    let mut commits = Vec::new();
    let mut threads = Vec::new();
    let mut section_pagination = empty_detail_pagination(section, pagination);

    match section {
        ReviewPlatformDetailSection::Overview => {
            if let Ok(response) = send_bounded_gitcode_files_response(gitcode_request(
                client.clone(),
                &format!("{}/files", base),
                ctx.token.as_deref(),
            ))
            .await
            {
                apply_gitcode_pull_request_change_stats(&mut pull_request, &response);
            }
        }
        ReviewPlatformDetailSection::Ci => {
            section_pagination = pagination_from_total(pagination, ci.len());
            ci = slice_page(ci, pagination);
        }
        ReviewPlatformDetailSection::Files => {
            if let Ok(response) = send_bounded_gitcode_files_response(gitcode_request(
                client.clone(),
                &format!("{}/files", base),
                ctx.token.as_deref(),
            ))
            .await
            {
                if let Some(values) = response.value.as_array() {
                    apply_gitcode_pull_request_change_stats(&mut pull_request, &response);
                    section_pagination = gitcode_files_pagination(pagination, values.len());
                    files = slice_page(
                        values.iter().map(gitcode_file_from_value).collect(),
                        pagination,
                    );
                }
            }
        }
        ReviewPlatformDetailSection::Commits => {
            if let Ok(response) = fetch_array_page(
                gitcode_request(
                    client.clone(),
                    &format!("{}/commits", base),
                    ctx.token.as_deref(),
                ),
                pagination,
            )
            .await
            {
                section_pagination = pagination_from_response(&response, pagination);
                commits = array_items(&response.value)
                    .iter()
                    .map(gitcode_commit_from_value)
                    .collect();
            }
        }
        ReviewPlatformDetailSection::Reviews => {
            if let Ok(response) = fetch_array_page(
                gitcode_request(
                    client.clone(),
                    &format!("{}/comments", base),
                    ctx.token.as_deref(),
                ),
                pagination,
            )
            .await
            {
                section_pagination = pagination_from_response(&response, pagination);
                threads = gitcode_threads(&response.value);
            }
        }
    }

    Ok(ReviewPlatformPullRequestDetailPage {
        limitations: Vec::new(),
        body: first_non_empty(&[
            value_string(&detail, "body"),
            value_string(&detail, "description"),
        ]),
        pull_request,
        ci,
        files,
        commits,
        threads,
        section,
        pagination: section_pagination,
    })
}

#[async_trait::async_trait]
impl ReviewProvider for GitcodeProvider {
    async fn list_pull_requests(
        &self,
        ctx: &ProviderContext,
        pagination: PullRequestPagination,
    ) -> Result<ReviewPlatformPullRequestPage, ReviewPlatformError> {
        let url = format!(
            "{}/repos/{}/{}/pulls",
            ctx.api_base_url, ctx.remote.owner, ctx.remote.repository_name
        );
        let per_page = pagination.per_page.to_string();
        let page = pagination.page.to_string();
        let response = send_json_response(
            gitcode_request(http_client()?, &url, ctx.token.as_deref()).query(&[
                ("state", "all"),
                ("per_page", &per_page),
                ("page", &page),
            ]),
        )
        .await?;
        let items = response.value.as_array().ok_or_else(|| {
            ReviewPlatformError::Parse("GitCode pull response was not an array".to_string())
        })?;
        let total = header_u64(&response.headers, "x-total").or_else(|| {
            link_header_last_page(&response.headers).map(|last_page| {
                if last_page == pagination.page {
                    (u64::from(last_page.saturating_sub(1)) * u64::from(pagination.per_page))
                        + items.len() as u64
                } else {
                    u64::from(last_page) * u64::from(pagination.per_page)
                }
            })
        });
        let has_next = link_header_has_rel(&response.headers, "next")
            || total
                .map(|total| u64::from(pagination.page) * u64::from(pagination.per_page) < total)
                .unwrap_or(items.len() == pagination.per_page as usize);

        let pull_requests = items
            .iter()
            .map(gitcode_pull_request_from_value)
            .collect::<Vec<_>>();
        let pull_requests = enrich_gitcode_pull_request_change_stats(ctx, pull_requests).await;

        Ok(ReviewPlatformPullRequestPage {
            items: pull_requests,
            pagination: ReviewPlatformPagination {
                page: pagination.page,
                per_page: pagination.per_page,
                total,
                has_next,
            },
        })
    }

    async fn pull_request_detail(
        &self,
        ctx: &ProviderContext,
        pull_request_id: &str,
    ) -> Result<ReviewPlatformPullRequestDetail, ReviewPlatformError> {
        let client = http_client()?;
        let base = format!(
            "{}/repos/{}/{}/pulls/{}",
            ctx.api_base_url, ctx.remote.owner, ctx.remote.repository_name, pull_request_id
        );
        let detail =
            send_json(gitcode_request(client.clone(), &base, ctx.token.as_deref())).await?;
        let files_url = format!("{}/files", base);
        let files_response = send_bounded_gitcode_files_response(gitcode_request(
            client.clone(),
            &files_url,
            ctx.token.as_deref(),
        ))
        .await
        .ok();
        let token = ctx.token.clone();
        let commits_url = format!("{}/commits", base);
        let commits = fetch_paginated_array(
            |page| {
                let page = page.to_string();
                gitcode_request(client.clone(), &commits_url, token.as_deref())
                    .query(&[("per_page", "100"), ("page", &page)])
            },
            github_next_page,
        )
        .await
        .unwrap_or(Value::Array(Vec::new()));
        let token = ctx.token.clone();
        let comments_url = format!("{}/comments", base);
        let comments = fetch_paginated_array(
            |page| {
                let page = page.to_string();
                gitcode_request(client.clone(), &comments_url, token.as_deref())
                    .query(&[("per_page", "100"), ("page", &page)])
            },
            github_next_page,
        )
        .await
        .unwrap_or(Value::Array(Vec::new()));
        let ci = gitcode_ci_items(&detail);
        let mut pull_request = gitcode_pull_request_from_value(&detail);
        pull_request.checks = summarize_ci_items(&ci);
        let files = files_response
            .as_ref()
            .and_then(|response| response.value.as_array())
            .map(|values| {
                values
                    .iter()
                    .map(gitcode_file_from_value)
                    .collect::<Vec<_>>()
            })
            .unwrap_or_default();
        if let Some(response) = files_response.as_ref() {
            apply_gitcode_pull_request_change_stats(&mut pull_request, response);
        }

        Ok(ReviewPlatformPullRequestDetail {
            limitations: Vec::new(),
            body: first_non_empty(&[
                value_string(&detail, "body"),
                value_string(&detail, "description"),
            ]),
            pull_request,
            ci,
            files,
            commits: array_items(&commits)
                .iter()
                .map(gitcode_commit_from_value)
                .collect(),
            threads: gitcode_threads(&comments),
        })
    }

    async fn pull_request_review_target(
        &self,
        ctx: &ProviderContext,
        pull_request_id: &str,
    ) -> Result<ReviewPlatformPullRequestReviewTarget, ReviewPlatformError> {
        let (pull_request, files) = gitcode_review_target_parts(ctx, pull_request_id).await?;
        Ok(review_target_from_parts(pull_request, files))
    }

    async fn pull_request_file_diff(
        &self,
        ctx: &ProviderContext,
        pull_request_id: &str,
        expected_base_revision: &str,
        expected_head_revision: &str,
        file_path: &str,
        file_page_hint: Option<u32>,
    ) -> Result<ReviewPlatformPullRequestFileDiff, ReviewPlatformError> {
        let (pull_request, files) =
            gitcode_review_file_parts(ctx, pull_request_id, file_path, file_page_hint).await?;
        file_diff_from_parts(
            pull_request,
            files,
            expected_base_revision,
            expected_head_revision,
            file_path,
        )
    }

    async fn pull_request_detail_page(
        &self,
        ctx: &ProviderContext,
        pull_request_id: &str,
        section: ReviewPlatformDetailSection,
        pagination: PullRequestPagination,
    ) -> Result<ReviewPlatformPullRequestDetailPage, ReviewPlatformError> {
        gitcode_pull_request_detail_page(ctx, pull_request_id, section, pagination).await
    }

    async fn pull_request_ci_log(
        &self,
        _ctx: &ProviderContext,
        _pull_request_id: &str,
        ci_item_id: &str,
        _ci_item_name: &str,
    ) -> Result<ReviewPlatformCiLog, ReviewPlatformError> {
        Ok(ReviewPlatformCiLog {
            ci_item_id: ci_item_id.to_string(),
            log: None,
            truncated: false,
            message: Some(
                "GitCode CI log retrieval is not available through a documented API.".to_string(),
            ),
        })
    }

    async fn create_pull_request(
        &self,
        ctx: &ProviderContext,
        request: &ReviewPlatformCreatePullRequestRequest,
    ) -> Result<ReviewPlatformActionResult, ReviewPlatformError> {
        let token = require_write_token(ctx, "Creating a GitCode pull request")?;
        let url = format!(
            "{}/repos/{}/{}/pulls",
            ctx.api_base_url, ctx.remote.owner, ctx.remote.repository_name
        );
        let value = send_json(
            gitcode_post_request(http_client()?, &url, Some(token)).json(&json!({
                "title": request.title,
                "head": request.source_branch,
                "base": request.target_branch,
                "body": request.body.clone().unwrap_or_default(),
                "draft": request.draft.unwrap_or(false),
            })),
        )
        .await?;
        let pull_request = gitcode_pull_request_from_value(&value);
        let web_url = Some(pull_request.web_url.clone());
        Ok(ReviewPlatformActionResult {
            success: true,
            message: format!("Created GitCode pull request #{}", pull_request.number),
            web_url,
            pull_request: Some(pull_request),
            thread: None,
        })
    }

    async fn submit_review(
        &self,
        ctx: &ProviderContext,
        request: &ReviewPlatformSubmitReviewRequest,
    ) -> Result<ReviewPlatformActionResult, ReviewPlatformError> {
        if request.event != ReviewSubmitEvent::Comment {
            return Err(ReviewPlatformError::UnsupportedPlatform(
                "GitCode submit_review supports comments only; use approve_pull_request for review processing"
                    .to_string(),
            ));
        }
        gitcode_add_pull_request_comment(ctx, &request.pull_request_id, &request.body).await
    }

    async fn approve_pull_request(
        &self,
        ctx: &ProviderContext,
        request: &ReviewPlatformApprovalRequest,
    ) -> Result<ReviewPlatformActionResult, ReviewPlatformError> {
        let token = require_write_token(ctx, "Approving a GitCode pull request")?;
        let url = format!(
            "{}/repos/{}/{}/pulls/{}/review",
            ctx.api_base_url, ctx.remote.owner, ctx.remote.repository_name, request.pull_request_id
        );
        send_json(
            gitcode_post_request(http_client()?, &url, Some(token))
                .json(&json!({ "force": false })),
        )
        .await?;
        if let Some(body) = request
            .body
            .as_deref()
            .filter(|value| !value.trim().is_empty())
        {
            let _ = gitcode_add_pull_request_comment(ctx, &request.pull_request_id, body).await;
        }
        Ok(ReviewPlatformActionResult {
            success: true,
            message: "Approved GitCode pull request".to_string(),
            web_url: None,
            pull_request: None,
            thread: None,
        })
    }
}

#[async_trait::async_trait]
impl ReviewProvider for UnsupportedProvider {
    async fn list_pull_requests(
        &self,
        ctx: &ProviderContext,
        _pagination: PullRequestPagination,
    ) -> Result<ReviewPlatformPullRequestPage, ReviewPlatformError> {
        Err(ReviewPlatformError::UnsupportedPlatform(
            ctx.remote.host.clone(),
        ))
    }

    async fn pull_request_detail(
        &self,
        ctx: &ProviderContext,
        _pull_request_id: &str,
    ) -> Result<ReviewPlatformPullRequestDetail, ReviewPlatformError> {
        Err(ReviewPlatformError::UnsupportedPlatform(
            ctx.remote.host.clone(),
        ))
    }
}

fn http_client() -> Result<ReviewHttpClient, ReviewPlatformError> {
    ReviewHttpClient::new_review_platform().map_err(review_http_error)
}

type JsonResponse = ReviewJsonResponse;

fn review_http_error(error: ReviewHttpError) -> ReviewPlatformError {
    match error {
        ReviewHttpError::BuildClient(message) | ReviewHttpError::Network(message) => {
            ReviewPlatformError::Network(message)
        }
        ReviewHttpError::Http { status, message } => ReviewPlatformError::Http { status, message },
        ReviewHttpError::Parse(message) => ReviewPlatformError::Parse(message),
        ReviewHttpError::ResponseTooLarge { limit_bytes } => ReviewPlatformError::Parse(format!(
            "Provider response exceeded the {limit_bytes} byte Review limit"
        )),
    }
}

fn gitcode_files_http_error(error: ReviewHttpError) -> ReviewPlatformError {
    match error {
        ReviewHttpError::ResponseTooLarge { limit_bytes } => ReviewPlatformError::Api(format!(
            "GitCode pull request files response exceeded the {limit_bytes}-byte limit"
        )),
        error => review_http_error(error),
    }
}

async fn send_json(request: ReviewHttpRequest) -> Result<Value, ReviewPlatformError> {
    send_review_json(request).await.map_err(review_http_error)
}

async fn send_json_response(
    request: ReviewHttpRequest,
) -> Result<JsonResponse, ReviewPlatformError> {
    send_review_json_response(request)
        .await
        .map_err(review_http_error)
}

async fn send_bounded_json(request: ReviewHttpRequest) -> Result<Value, ReviewPlatformError> {
    send_review_json_response_bounded(request, MAX_REVIEW_TARGET_RESPONSE_BYTES)
        .await
        .map(|response| response.value)
        .map_err(review_http_error)
}

async fn send_bounded_json_response(
    request: ReviewHttpRequest,
) -> Result<JsonResponse, ReviewPlatformError> {
    send_review_json_response_bounded(request, MAX_REVIEW_TARGET_RESPONSE_BYTES)
        .await
        .map_err(review_http_error)
}

async fn send_bounded_gitcode_files_response(
    request: ReviewHttpRequest,
) -> Result<JsonResponse, ReviewPlatformError> {
    send_review_json_response_bounded(request, GITCODE_PULL_REQUEST_FILES_RESPONSE_BYTES)
        .await
        .map_err(gitcode_files_http_error)
}

async fn send_bounded_text(
    request: ReviewHttpRequest,
    max_bytes: usize,
) -> Result<ReviewTextResponse, ReviewPlatformError> {
    send_review_text_bounded(request, max_bytes)
        .await
        .map_err(review_http_error)
}

async fn fetch_paginated_array<F>(
    mut build_request: F,
    next_page: fn(&ReviewHttpHeaders, u32) -> Option<u32>,
) -> Result<Value, ReviewPlatformError>
where
    F: FnMut(u32) -> ReviewHttpRequest,
{
    let mut page = 1;
    let mut values = Vec::new();

    loop {
        let response = send_json_response(build_request(page)).await?;
        let items = response.value.as_array().ok_or_else(|| {
            ReviewPlatformError::Parse("Provider paginated response was not an array".to_string())
        })?;
        values.extend(items.iter().cloned());

        let Some(next) = next_page(&response.headers, page).filter(|next| *next > page) else {
            break;
        };
        page = next;
    }

    Ok(Value::Array(values))
}

async fn fetch_array_page(
    request: ReviewHttpRequest,
    pagination: PullRequestPagination,
) -> Result<JsonResponse, ReviewPlatformError> {
    let page = pagination.page.to_string();
    let per_page = pagination.per_page.to_string();
    let response =
        send_json_response(request.query(&[("per_page", &per_page), ("page", &page)])).await?;
    response.value.as_array().ok_or_else(|| {
        ReviewPlatformError::Parse("Provider paginated response was not an array".to_string())
    })?;
    Ok(response)
}

fn pagination_from_response(
    response: &JsonResponse,
    pagination: PullRequestPagination,
) -> ReviewPlatformPagination {
    let item_count = response.value.as_array().map(Vec::len).unwrap_or(0);
    let total = header_u64(&response.headers, "x-total")
        .or_else(|| pagination_total_from_links(&response.headers, pagination, item_count));
    ReviewPlatformPagination {
        page: pagination.page,
        per_page: pagination.per_page,
        total,
        has_next: link_header_has_rel(&response.headers, "next")
            || header_string(&response.headers, "x-next-page")
                .is_some_and(|value| !value.trim().is_empty())
            || total
                .map(|total| u64::from(pagination.page) * u64::from(pagination.per_page) < total)
                .unwrap_or(false),
    }
}

fn combine_page_pagination(
    pagination: PullRequestPagination,
    pages: &[ReviewPlatformPagination],
) -> ReviewPlatformPagination {
    let totals = if pages.iter().any(|page| page.has_next) {
        None
    } else {
        pages
            .iter()
            .map(|page| page.total)
            .collect::<Option<Vec<_>>>()
            .map(|values| values.into_iter().sum())
    };
    ReviewPlatformPagination {
        page: pagination.page,
        per_page: pagination.per_page,
        total: totals,
        has_next: pages.iter().any(|page| page.has_next),
    }
}

fn header_string(headers: &ReviewHttpHeaders, name: &str) -> Option<String> {
    headers.get(name).map(str::to_string)
}

fn header_u64(headers: &ReviewHttpHeaders, name: &str) -> Option<u64> {
    header_string(headers, name).and_then(|value| value.parse::<u64>().ok())
}

fn link_header_has_rel(headers: &ReviewHttpHeaders, rel: &str) -> bool {
    header_string(headers, "link")
        .as_deref()
        .is_some_and(|value| {
            value
                .split(',')
                .any(|part| part.contains(&format!("rel=\"{}\"", rel)))
        })
}

fn link_header_last_page(headers: &ReviewHttpHeaders) -> Option<u32> {
    let link = header_string(headers, "link")?;
    for part in link.split(',') {
        if !part.contains("rel=\"last\"") {
            continue;
        }
        let url = part
            .split(';')
            .next()?
            .trim()
            .trim_start_matches('<')
            .trim_end_matches('>');
        return query_param_u32(url, "page");
    }
    None
}

fn pagination_total_from_links(
    headers: &ReviewHttpHeaders,
    pagination: PullRequestPagination,
    item_count: usize,
) -> Option<u64> {
    if let Some(last_page) = link_header_last_page(headers) {
        if pagination.per_page == 1 {
            return Some(u64::from(last_page));
        }
        if last_page == pagination.page {
            return Some(
                u64::from(pagination.page.saturating_sub(1)) * u64::from(pagination.per_page)
                    + item_count as u64,
            );
        }
        return None;
    }

    Some(
        u64::from(pagination.page.saturating_sub(1)) * u64::from(pagination.per_page)
            + item_count as u64,
    )
}

fn pagination_from_total(
    pagination: PullRequestPagination,
    total: usize,
) -> ReviewPlatformPagination {
    ReviewPlatformPagination {
        page: pagination.page,
        per_page: pagination.per_page,
        total: Some(total as u64),
        has_next: usize::try_from(pagination.page)
            .ok()
            .is_some_and(|page| page * (pagination.per_page as usize) < total),
    }
}

fn gitcode_files_pagination(
    pagination: PullRequestPagination,
    available_files: usize,
) -> ReviewPlatformPagination {
    let mut result = pagination_from_total(pagination, available_files);
    if available_files >= GITCODE_PULL_REQUEST_FILES_RESPONSE_LIMIT {
        result.total = None;
    }
    result
}

fn slice_page<T>(items: Vec<T>, pagination: PullRequestPagination) -> Vec<T> {
    let start = pagination
        .page
        .saturating_sub(1)
        .saturating_mul(pagination.per_page) as usize;
    items
        .into_iter()
        .skip(start)
        .take(pagination.per_page as usize)
        .collect()
}

fn empty_detail_pagination(
    section: ReviewPlatformDetailSection,
    pagination: PullRequestPagination,
) -> ReviewPlatformPagination {
    ReviewPlatformPagination {
        page: pagination.page,
        per_page: pagination.per_page,
        total: if section == ReviewPlatformDetailSection::Overview {
            Some(0)
        } else {
            None
        },
        has_next: false,
    }
}

fn github_next_page(headers: &ReviewHttpHeaders, current_page: u32) -> Option<u32> {
    if link_header_has_rel(headers, "next") {
        Some(current_page.saturating_add(1))
    } else {
        None
    }
}

fn gitlab_next_page(headers: &ReviewHttpHeaders, _current_page: u32) -> Option<u32> {
    header_string(headers, "x-next-page").and_then(|value| {
        let trimmed = value.trim();
        if trimmed.is_empty() {
            None
        } else {
            trimmed.parse::<u32>().ok()
        }
    })
}

fn query_param_u32(url: &str, name: &str) -> Option<u32> {
    let query = url.split_once('?')?.1;
    for pair in query.split('&') {
        if let Some((key, value)) = pair.split_once('=') {
            if key == name {
                return value.parse::<u32>().ok();
            }
        }
    }
    None
}

async fn enrich_gitlab_pull_request_counts(
    ctx: &ProviderContext,
    pull_requests: Vec<ReviewPlatformPullRequest>,
) -> Vec<ReviewPlatformPullRequest> {
    let Ok(client) = http_client() else {
        return pull_requests;
    };
    let project = urlencoding::encode(&ctx.remote.project_path).to_string();
    let futures = pull_requests.into_iter().map(|mut pull_request| {
        let client = client.clone();
        let url = format!(
            "{}/projects/{}/merge_requests/{}/changes",
            ctx.api_base_url, project, pull_request.id
        );
        let token = ctx.token.clone();
        async move {
            if let Ok(value) = send_json(gitlab_request(client, &url, token.as_deref())).await {
                let files = gitlab_files(&value);
                apply_files_stats(&mut pull_request, &files);
            }
            pull_request
        }
    });
    stream::iter(futures)
        .buffered(PROVIDER_ENRICH_CONCURRENCY)
        .collect()
        .await
}

async fn enrich_gitcode_pull_request_change_stats(
    ctx: &ProviderContext,
    pull_requests: Vec<ReviewPlatformPullRequest>,
) -> Vec<ReviewPlatformPullRequest> {
    let Ok(client) = http_client() else {
        return pull_requests;
    };
    let futures = pull_requests.into_iter().map(|mut pull_request| {
        let client = client.clone();
        let url = format!(
            "{}/repos/{}/{}/pulls/{}/files",
            ctx.api_base_url, ctx.remote.owner, ctx.remote.repository_name, pull_request.id
        );
        let token = ctx.token.clone();
        async move {
            if let Ok(response) =
                send_bounded_gitcode_files_response(gitcode_request(client, &url, token.as_deref()))
                    .await
            {
                apply_gitcode_pull_request_change_stats(&mut pull_request, &response);
            }
            pull_request
        }
    });
    stream::iter(futures)
        .buffered(PROVIDER_ENRICH_CONCURRENCY)
        .collect()
        .await
}

fn apply_gitcode_pull_request_change_stats(
    pull_request: &mut ReviewPlatformPullRequest,
    response: &JsonResponse,
) {
    let Some(values) = response.value.as_array() else {
        return;
    };
    let file_count = i32::try_from(values.len()).unwrap_or(i32::MAX);
    if values.len() >= GITCODE_PULL_REQUEST_FILES_RESPONSE_LIMIT {
        if !pull_request.changed_file_count_known || pull_request.changed_files < file_count {
            pull_request.changed_files = file_count;
            pull_request.changed_file_count_known = false;
        }
        return;
    }
    let files = values
        .iter()
        .map(gitcode_file_from_value)
        .collect::<Vec<_>>();
    apply_files_stats(pull_request, &files);
    pull_request.changed_files = file_count;
    pull_request.changed_file_count_known = true;
    if let Some(total) = header_u64(&response.headers, "total_added_lines") {
        pull_request.additions = i32::try_from(total).unwrap_or(i32::MAX);
    }
    if let Some(total) = header_u64(&response.headers, "total_removed_lines") {
        pull_request.deletions = i32::try_from(total).unwrap_or(i32::MAX);
    }
}

fn gitlab_request(client: ReviewHttpClient, url: &str, token: Option<&str>) -> ReviewHttpRequest {
    let mut request = client
        .get(url)
        .header(USER_AGENT_HEADER, USER_AGENT_VALUE)
        .header(ACCEPT_HEADER, "application/json");
    if let Some(token) = token {
        request = request.header("PRIVATE-TOKEN", token);
    }
    request
}

fn gitlab_post_request(
    client: ReviewHttpClient,
    url: &str,
    token: Option<&str>,
) -> ReviewHttpRequest {
    let mut request = client
        .post(url)
        .header(USER_AGENT_HEADER, USER_AGENT_VALUE)
        .header(ACCEPT_HEADER, "application/json");
    if let Some(token) = token {
        request = request.header("PRIVATE-TOKEN", token);
    }
    request
}

fn gitlab_put_request(
    client: ReviewHttpClient,
    url: &str,
    token: Option<&str>,
) -> ReviewHttpRequest {
    let mut request = client
        .put(url)
        .header(USER_AGENT_HEADER, USER_AGENT_VALUE)
        .header(ACCEPT_HEADER, "application/json");
    if let Some(token) = token {
        request = request.header("PRIVATE-TOKEN", token);
    }
    request
}

fn gitcode_request(client: ReviewHttpClient, url: &str, token: Option<&str>) -> ReviewHttpRequest {
    let mut request = client
        .get(url)
        .header(USER_AGENT_HEADER, USER_AGENT_VALUE)
        .header(ACCEPT_HEADER, "application/json");
    if let Some(token) = token {
        request = request
            .header("PRIVATE-TOKEN", token)
            .header(AUTHORIZATION_HEADER, format!("Bearer {}", token))
            .query(&[("access_token", token)]);
    }
    request
}

fn gitcode_post_request(
    client: ReviewHttpClient,
    url: &str,
    token: Option<&str>,
) -> ReviewHttpRequest {
    let mut request = client
        .post(url)
        .header(USER_AGENT_HEADER, USER_AGENT_VALUE)
        .header(ACCEPT_HEADER, "application/json");
    if let Some(token) = token {
        request = request
            .header("PRIVATE-TOKEN", token)
            .header(AUTHORIZATION_HEADER, format!("Bearer {}", token))
            .query(&[("access_token", token)]);
    }
    request
}

fn require_write_token<'a>(
    ctx: &'a ProviderContext,
    action: &str,
) -> Result<&'a str, ReviewPlatformError> {
    ctx.token.as_deref().ok_or_else(|| {
        ReviewPlatformError::Api(format!(
            "{} requires a {} token for {}",
            action,
            platform_label(ctx.remote.platform),
            ctx.remote.host
        ))
    })
}

fn normalize_provider_host(host: &str) -> Result<String, ReviewPlatformError> {
    let host = host.trim().trim_end_matches('.').to_ascii_lowercase();
    if host.is_empty()
        || host.contains("://")
        || host.contains(['/', '\\', '@', '?', '#'])
        || host.chars().any(char::is_whitespace)
        || host.chars().any(char::is_control)
        || host.len() > 253
    {
        return Err(ReviewPlatformError::Api(
            "Provider host must be a plain DNS host name".to_string(),
        ));
    }
    if host.split('.').any(|label| {
        label.is_empty()
            || label.len() > 63
            || label.starts_with('-')
            || label.ends_with('-')
            || !label
                .chars()
                .all(|character| character.is_ascii_alphanumeric() || character == '-')
    }) {
        return Err(ReviewPlatformError::Api(
            "Provider host contains an invalid DNS label".to_string(),
        ));
    }
    Ok(host)
}

fn normalize_project_path(
    platform: ReviewPlatformKind,
    project_path: &str,
) -> Result<String, ReviewPlatformError> {
    let project_path = project_path.trim();
    if project_path.is_empty()
        || project_path.starts_with('/')
        || project_path.ends_with('/')
        || project_path.contains(['\\', '?', '#', '%'])
        || project_path.chars().any(char::is_control)
    {
        return Err(ReviewPlatformError::Api(
            "Provider project path is invalid".to_string(),
        ));
    }
    let mut segments = project_path
        .split('/')
        .map(str::to_string)
        .collect::<Vec<_>>();
    if let Some(repository) = segments.last_mut() {
        *repository = repository.trim_end_matches(".git").to_string();
    }
    let segment_is_invalid = |segment: &str| {
        segment.is_empty()
            || matches!(segment, "." | "..")
            || !segment.chars().all(|character| {
                character.is_ascii_alphanumeric() || matches!(character, '-' | '_' | '.')
            })
    };
    if segments.len() < 2
        || (matches!(
            platform,
            ReviewPlatformKind::Github | ReviewPlatformKind::Gitee
        ) && segments.len() != 2)
        || segments.iter().any(|segment| segment_is_invalid(segment))
    {
        return Err(ReviewPlatformError::Api(
            "Provider project path must identify an owner and repository".to_string(),
        ));
    }
    if !matches!(
        platform,
        ReviewPlatformKind::Github | ReviewPlatformKind::Gitlab | ReviewPlatformKind::Gitee
    ) {
        return Err(ReviewPlatformError::UnsupportedPlatform(
            platform_label(platform).to_string(),
        ));
    }
    Ok(segments.join("/"))
}

fn normalize_provider_item_id(
    item_id: &str,
    item_label: &str,
) -> Result<String, ReviewPlatformError> {
    let bytes = item_id.as_bytes();
    if !matches!(bytes.first(), Some(b'1'..=b'9'))
        || !bytes
            .iter()
            .skip(1)
            .all(|character| character.is_ascii_digit())
    {
        return Err(ReviewPlatformError::Api(format!(
            "{item_label} id must be a positive integer"
        )));
    }
    Ok(item_id.to_string())
}

#[cfg(test)]
fn provider_context_for_identity(
    platform: ReviewPlatformKind,
    host: &str,
    project_path: &str,
    auth_tokens: &ReviewPlatformAuthTokens,
) -> Result<ProviderContext, ReviewPlatformError> {
    provider_context_for_identity_with_trust(platform, host, project_path, auth_tokens, false)
}

fn provider_context_for_identity_with_trust(
    platform: ReviewPlatformKind,
    host: &str,
    project_path: &str,
    auth_tokens: &ReviewPlatformAuthTokens,
    trusted_remote: bool,
) -> Result<ProviderContext, ReviewPlatformError> {
    let host = normalize_provider_host(host)?;
    let project_path = normalize_project_path(platform, project_path)?;
    let stored_token = (platform != ReviewPlatformKind::Github)
        .then(|| auth_tokens.get(platform, &host).map(str::to_string))
        .flatten();
    let public_anonymous_host = matches!(
        (platform, host.as_str()),
        (ReviewPlatformKind::Github, "github.com")
            | (ReviewPlatformKind::Gitlab, "gitlab.com")
            | (ReviewPlatformKind::Gitee, "gitee.com")
    );
    if platform != ReviewPlatformKind::Github
        && !public_anonymous_host
        && stored_token.is_none()
        && !trusted_remote
    {
        return Err(ReviewPlatformError::Api(format!(
            "A stored {} token is required for non-public provider host {}",
            platform_label(platform),
            host
        )));
    }
    let token = stored_token.clone().or_else(|| {
        public_anonymous_host
            .then(|| env_token_for_platform(platform))
            .flatten()
    });
    let auth_source = if platform == ReviewPlatformKind::Github {
        ReviewAuthSource::GhCli
    } else if stored_token.is_some() {
        ReviewAuthSource::Stored
    } else if token.is_some() {
        ReviewAuthSource::Env
    } else {
        ReviewAuthSource::None
    };
    let auth_state = if platform == ReviewPlatformKind::Github || token.is_some() {
        ReviewAuthState::Connected
    } else {
        ReviewAuthState::NotRequired
    };
    let owner = project_path
        .split('/')
        .next()
        .unwrap_or_default()
        .to_string();
    let repository_name = project_path
        .rsplit('/')
        .next()
        .unwrap_or_default()
        .to_string();
    let web_url = format!("https://{host}/{project_path}");
    let api_base_url = match (platform, host.as_str()) {
        (ReviewPlatformKind::Github, "github.com") => "https://api.github.com".to_string(),
        (ReviewPlatformKind::Github, _) => format!("https://{host}/api/v3"),
        (ReviewPlatformKind::Gitlab, _) => format!("https://{host}/api/v4"),
        (ReviewPlatformKind::Gitee, "gitee.com") => "https://gitee.com/api/v5".to_string(),
        _ => return Err(ReviewPlatformError::UnsupportedPlatform(host)),
    };
    Ok(ProviderContext {
        remote: ReviewPlatformRemote {
            id: format!(
                "identity:{}:{}",
                platform.as_str(),
                project_path.replace('/', "__")
            ),
            name: "identity".to_string(),
            url: web_url.clone(),
            platform,
            host,
            owner,
            repository_name,
            project_path,
            web_url,
            supported: true,
            auth_state,
            auth_source,
            message: None,
        },
        api_base_url,
        token,
    })
}

#[cfg(test)]
fn pull_request_identity_plan(
    platform: ReviewPlatformKind,
    host: &str,
    project_path: &str,
    pull_request_id: &str,
    auth_tokens: &ReviewPlatformAuthTokens,
) -> Result<PullRequestIdentityPlan, ReviewPlatformError> {
    Ok(PullRequestIdentityPlan {
        context: provider_context_for_identity(platform, host, project_path, auth_tokens)?,
        pull_request_id: normalize_provider_item_id(pull_request_id, "Pull request")?,
    })
}

fn issue_request_plan(
    context: &ProviderContext,
    identity: &ProviderIssueIdentity,
    pagination: IssuePagination,
) -> Result<IssueRequestPlan, ReviewPlatformError> {
    if context.remote.platform != identity.platform
        || context.remote.host != identity.host
        || context.remote.project_path != identity.project_path
    {
        return Err(ReviewPlatformError::Api(
            "Provider Issue identity does not match its trusted provider context".to_string(),
        ));
    }
    let (issue_url, comments_url, comments_query) = match identity.platform {
        ReviewPlatformKind::Gitee => {
            let issue_url = format!(
                "{}/repos/{}/{}/issues/{}",
                context.api_base_url,
                urlencoding::encode(&context.remote.owner),
                urlencoding::encode(&context.remote.repository_name),
                identity.issue_id
            );
            (
                issue_url.clone(),
                format!("{issue_url}/comments"),
                Vec::new(),
            )
        }
        ReviewPlatformKind::Github => {
            let issue_url = format!(
                "{}/repos/{}/{}/issues/{}",
                context.api_base_url,
                context.remote.owner,
                context.remote.repository_name,
                identity.issue_id
            );
            let comments_url = format!("{issue_url}/comments");
            (issue_url, comments_url, Vec::new())
        }
        ReviewPlatformKind::Gitlab => {
            let project = urlencoding::encode(&identity.project_path);
            let issue_url = format!(
                "{}/projects/{}/issues/{}",
                context.api_base_url, project, identity.issue_id
            );
            let comments_url = format!("{issue_url}/notes");
            (
                issue_url,
                comments_url,
                vec![
                    ("order_by".to_string(), "created_at".to_string()),
                    ("sort".to_string(), "asc".to_string()),
                    ("activity_filter".to_string(), "only_comments".to_string()),
                ],
            )
        }
        _ => {
            return Err(ReviewPlatformError::UnsupportedPlatform(
                platform_label(identity.platform).to_string(),
            ));
        }
    };
    Ok(IssueRequestPlan {
        issue_url,
        comments_url,
        comments_query,
        pagination,
    })
}

async fn acquire_issue_evidence(
    context: &ProviderContext,
    identity: &ProviderIssueIdentity,
    pagination: IssuePagination,
) -> Result<ReviewPlatformIssueEvidence, ReviewPlatformError> {
    let plan = issue_request_plan(context, identity, pagination)?;
    let page = plan.pagination.page.to_string();
    let per_page = plan.pagination.per_page.to_string();
    match identity.platform {
        ReviewPlatformKind::Gitee => gitee::acquire_issue_evidence(context, identity, &plan).await,
        ReviewPlatformKind::Github => {
            let issue =
                github_api_get_json(context, &plan.issue_url, &[], MAX_ISSUE_RESPONSE_BYTES)
                    .await
                    .map_err(|error| review_evidence_error(error, "issue_response"))?;
            reject_pull_request_issue_target(identity, &issue)?;
            let comments = github_api_get_json(
                context,
                &plan.comments_url,
                &[
                    ("page".to_string(), page),
                    ("per_page".to_string(), per_page),
                ],
                MAX_ISSUE_COMMENTS_RESPONSE_BYTES,
            )
            .await
            .map_err(|error| review_evidence_error(error, "issue_comments_response"));
            match comments {
                Ok(comments) => {
                    let has_next = comments
                        .as_array()
                        .is_some_and(|items| items.len() == plan.pagination.per_page as usize);
                    map_github_issue(
                        identity,
                        &issue,
                        &comments,
                        plan.pagination,
                        has_next,
                        has_next.then(|| plan.pagination.page.saturating_add(1).to_string()),
                    )
                }
                Err(ReviewPlatformError::EvidenceTooLarge { .. }) => {
                    let mut evidence = map_github_issue(
                        identity,
                        &issue,
                        &Value::Array(Vec::new()),
                        plan.pagination,
                        false,
                        None,
                    )?;
                    evidence.completeness = ReviewEvidenceCompleteness::Partial;
                    evidence
                        .limitations
                        .push("issue_comments_response_too_large".to_string());
                    evidence.fingerprint = issue_fingerprint(&evidence, plan.pagination);
                    Ok(evidence)
                }
                Err(error) => Err(error),
            }
        }
        ReviewPlatformKind::Gitlab => {
            let client = http_client()?;
            let issue = send_review_json_response_bounded(
                gitlab_request(client.clone(), &plan.issue_url, context.token.as_deref()),
                MAX_ISSUE_RESPONSE_BYTES,
            )
            .await
            .map_err(|error| review_evidence_http_error(error, "issue_response"))?
            .value;
            let comments = send_review_json_response_bounded(
                gitlab_request(client, &plan.comments_url, context.token.as_deref())
                    .query(&plan.comments_query)
                    .query(&[("page", &page), ("per_page", &per_page)]),
                MAX_ISSUE_COMMENTS_RESPONSE_BYTES,
            )
            .await
            .map_err(|error| review_evidence_http_error(error, "issue_comments_response"));
            map_issue_comments_response(identity, &issue, plan.pagination, comments)
        }
        _ => Err(ReviewPlatformError::UnsupportedPlatform(
            platform_label(identity.platform).to_string(),
        )),
    }
}

fn review_evidence_http_error(error: ReviewHttpError, resource: &str) -> ReviewPlatformError {
    match error {
        ReviewHttpError::ResponseTooLarge { limit_bytes } => {
            ReviewPlatformError::EvidenceTooLarge {
                resource: resource.to_string(),
                limit: limit_bytes,
            }
        }
        error => review_http_error(error),
    }
}

fn map_issue_comments_response(
    identity: &ProviderIssueIdentity,
    issue: &Value,
    pagination: IssuePagination,
    comments: Result<JsonResponse, ReviewPlatformError>,
) -> Result<ReviewPlatformIssueEvidence, ReviewPlatformError> {
    let comments = match comments {
        Ok(comments) => comments,
        Err(ReviewPlatformError::EvidenceTooLarge { resource, limit: _ })
            if resource == "issue_comments_response" =>
        {
            let mut evidence = match identity.platform {
                ReviewPlatformKind::Github => map_github_issue(
                    identity,
                    issue,
                    &Value::Array(Vec::new()),
                    pagination,
                    false,
                    None,
                )?,
                ReviewPlatformKind::Gitlab => map_gitlab_issue(
                    identity,
                    issue,
                    &Value::Array(Vec::new()),
                    pagination,
                    false,
                    None,
                )?,
                _ => {
                    return Err(ReviewPlatformError::UnsupportedPlatform(
                        platform_label(identity.platform).to_string(),
                    ));
                }
            };
            evidence.completeness = ReviewEvidenceCompleteness::Partial;
            evidence
                .limitations
                .push("issue_comments_response_too_large".to_string());
            evidence.fingerprint = issue_fingerprint(&evidence, pagination);
            return Ok(evidence);
        }
        Err(error) => return Err(error),
    };
    let next_page = match identity.platform {
        ReviewPlatformKind::Github => github_next_page(&comments.headers, pagination.page),
        ReviewPlatformKind::Gitlab => gitlab_next_page(&comments.headers, pagination.page),
        _ => None,
    };
    match identity.platform {
        ReviewPlatformKind::Github => map_github_issue(
            identity,
            issue,
            &comments.value,
            pagination,
            next_page.is_some(),
            next_page.map(|page| page.to_string()),
        ),
        ReviewPlatformKind::Gitlab => map_gitlab_issue(
            identity,
            issue,
            &comments.value,
            pagination,
            next_page.is_some(),
            next_page.map(|page| page.to_string()),
        ),
        _ => Err(ReviewPlatformError::UnsupportedPlatform(
            platform_label(identity.platform).to_string(),
        )),
    }
}

fn provider_context(
    remote: ReviewPlatformRemote,
    auth_tokens: &ReviewPlatformAuthTokens,
) -> Result<ProviderContext, ReviewPlatformError> {
    let api_base_url = match (remote.platform, remote.host.as_str()) {
        (ReviewPlatformKind::Github, "github.com") => "https://api.github.com".to_string(),
        (ReviewPlatformKind::Github, host) => format!("https://{host}/api/v3"),
        (ReviewPlatformKind::Gitlab, host) => format!("https://{host}/api/v4"),
        (ReviewPlatformKind::Gitcode, _) => "https://api.gitcode.com/api/v5".to_string(),
        (ReviewPlatformKind::Gitee, "gitee.com") => "https://gitee.com/api/v5".to_string(),
        (ReviewPlatformKind::Gitee, _) => {
            return Err(ReviewPlatformError::UnsupportedPlatform(remote.host));
        }
        (ReviewPlatformKind::Unknown, _) => {
            return Err(ReviewPlatformError::UnsupportedPlatform(remote.host));
        }
    };
    let token = token_for_remote(&remote, auth_tokens);
    Ok(ProviderContext {
        remote,
        api_base_url,
        token,
    })
}

fn token_for_remote(
    remote: &ReviewPlatformRemote,
    auth_tokens: &ReviewPlatformAuthTokens,
) -> Option<String> {
    if remote.platform == ReviewPlatformKind::Github {
        return None;
    }
    auth_tokens
        .get(remote.platform, &remote.host)
        .map(str::to_string)
        .or_else(|| env_token_for_platform(remote.platform))
}

fn env_token_for_platform(platform: ReviewPlatformKind) -> Option<String> {
    let names: &[&str] = match platform {
        ReviewPlatformKind::Github => &[],
        ReviewPlatformKind::Gitlab => &["GITLAB_TOKEN", "GITLAB_PRIVATE_TOKEN"],
        ReviewPlatformKind::Gitcode => &["GITCODE_TOKEN"],
        ReviewPlatformKind::Gitee => &["GITEE_TOKEN"],
        ReviewPlatformKind::Unknown => &[],
    };
    names.iter().find_map(|name| {
        std::env::var(name)
            .ok()
            .map(|value| value.trim().to_string())
            .filter(|value| !value.is_empty())
    })
}

fn auth_for_platform_host(
    platform: ReviewPlatformKind,
    host: &str,
    auth_tokens: &ReviewPlatformAuthTokens,
) -> (ReviewAuthState, ReviewAuthSource) {
    if platform == ReviewPlatformKind::Unknown {
        return (ReviewAuthState::Unsupported, ReviewAuthSource::Unsupported);
    }
    if platform == ReviewPlatformKind::Github {
        return (ReviewAuthState::NotConnected, ReviewAuthSource::None);
    }
    if auth_tokens.get(platform, host).is_some() {
        return (ReviewAuthState::Connected, ReviewAuthSource::Stored);
    }
    if env_token_for_platform(platform).is_some() {
        return (ReviewAuthState::Connected, ReviewAuthSource::Env);
    }
    if platform == ReviewPlatformKind::Gitcode {
        (ReviewAuthState::NotConnected, ReviewAuthSource::None)
    } else {
        (ReviewAuthState::NotRequired, ReviewAuthSource::None)
    }
}

fn token_key(platform: ReviewPlatformKind, host: &str) -> Option<String> {
    if platform == ReviewPlatformKind::Unknown {
        return None;
    }
    let host = normalize_provider_host(host).ok()?;
    Some(format!("{}:{}", platform.as_str(), host))
}

fn normalize_stored_token_key(key: &str) -> Option<String> {
    let (platform, host) = key.split_once(':')?;
    let platform = match platform.trim().to_ascii_lowercase().as_str() {
        "github" => ReviewPlatformKind::Github,
        "gitlab" => ReviewPlatformKind::Gitlab,
        "gitcode" => ReviewPlatformKind::Gitcode,
        "gitee" => ReviewPlatformKind::Gitee,
        _ => return None,
    };
    token_key(platform, host)
}

fn absolute_token_store_path(path: &Path) -> PathBuf {
    let absolute = if path.is_absolute() {
        path.to_path_buf()
    } else {
        std::env::current_dir()
            .unwrap_or_else(|_| PathBuf::from("."))
            .join(path)
    };
    let mut normalized = PathBuf::new();
    for component in absolute.components() {
        match component {
            std::path::Component::CurDir => {}
            std::path::Component::ParentDir => {
                normalized.pop();
            }
            component => normalized.push(component.as_os_str()),
        }
    }
    normalized
}

fn normalize_token_store_lock_key(path: &Path) -> PathBuf {
    let path = absolute_token_store_path(path);
    #[cfg(windows)]
    {
        PathBuf::from(path.to_string_lossy().to_ascii_lowercase())
    }
    #[cfg(not(windows))]
    {
        path
    }
}

fn shared_token_store_lock(path: &Path) -> Arc<AsyncMutex<()>> {
    let registry = TOKEN_STORE_LOCKS.get_or_init(|| StdMutex::new(HashMap::new()));
    let mut registry = registry.lock().unwrap_or_else(|error| error.into_inner());
    registry.retain(|_, lock| lock.strong_count() > 0);
    if let Some(lock) = registry.get(path).and_then(Weak::upgrade) {
        return lock;
    }
    let lock = Arc::new(AsyncMutex::new(()));
    registry.insert(path.to_path_buf(), Arc::downgrade(&lock));
    lock
}

#[cfg(test)]
fn token_store_lock_registry_entries_for_test(marker: &str) -> usize {
    TOKEN_STORE_LOCKS
        .get_or_init(|| StdMutex::new(HashMap::new()))
        .lock()
        .unwrap_or_else(|error| error.into_inner())
        .keys()
        .filter(|path| path.to_string_lossy().contains(marker))
        .count()
}

fn validate_current_stored_tokens(
    stored: &StoredReviewPlatformTokens,
) -> Result<(), ReviewPlatformError> {
    if stored.schema_version != REVIEW_PLATFORM_TOKEN_SCHEMA_VERSION {
        return Err(ReviewPlatformError::Parse(format!(
            "Review platform token store schema {} is not supported by OpenBitFun 1.0.0; use the explicit data migration tool instead",
            stored.schema_version
        )));
    }

    for (raw_key, entry) in &stored.tokens {
        let canonical_key = normalize_stored_token_key(raw_key).ok_or_else(|| {
            ReviewPlatformError::Parse(format!(
                "Review platform token store contains invalid authority '{raw_key}'"
            ))
        })?;
        if canonical_key != *raw_key {
            return Err(ReviewPlatformError::Parse(format!(
                "Review platform token authority '{raw_key}' is not canonical OpenBitFun data; use the explicit data migration tool instead"
            )));
        }
        if canonical_key.starts_with("github:") {
            return Err(ReviewPlatformError::Parse(
                "The review platform token store contains a pre-OpenBitFun GitHub token; use the explicit data migration tool or authenticate with the GitHub CLI"
                    .to_string(),
            ));
        }
        if entry.token.is_empty() || entry.token.trim() != entry.token {
            return Err(ReviewPlatformError::Parse(format!(
                "Review platform token authority '{raw_key}' contains a non-canonical token value"
            )));
        }
        if entry.updated_at.trim().is_empty() {
            return Err(ReviewPlatformError::Parse(format!(
                "Review platform token authority '{raw_key}' is missing its update timestamp"
            )));
        }
    }

    Ok(())
}

async fn get_repository_root(repository_path: &str) -> Result<String, ReviewPlatformError> {
    let output = execute_git_command(repository_path, &["rev-parse", "--show-toplevel"]).await?;
    let root = parse_repository_root_output(&output)?;
    Ok(normalize_repository_root(&root))
}

fn parse_repository_root_output(output: &str) -> Result<String, ReviewPlatformError> {
    output
        .lines()
        .next()
        .map(str::trim)
        .filter(|value| !value.is_empty())
        .map(str::to_string)
        .ok_or_else(|| {
            ReviewPlatformError::InvalidRepository(
                "Git repository root was not returned".to_string(),
            )
        })
}

async fn execute_git_command(
    current_dir: &str,
    args: &[&str],
) -> Result<String, ReviewPlatformError> {
    let current_dir_path = Path::new(current_dir);
    let current_dir_path = if current_dir_path.is_file() {
        current_dir_path.parent().unwrap_or(current_dir_path)
    } else {
        current_dir_path
    };

    let output = process_manager::create_tokio_command("git")
        .current_dir(current_dir_path)
        .args(args)
        .output()
        .await
        .map_err(|error| {
            ReviewPlatformError::InvalidRepository(format!(
                "Failed to execute git command: {}",
                error
            ))
        })?;

    if output.status.success() {
        return Ok(String::from_utf8_lossy(&output.stdout).to_string());
    }

    let message = if output.stderr.is_empty() {
        String::from_utf8_lossy(&output.stdout).to_string()
    } else {
        String::from_utf8_lossy(&output.stderr).to_string()
    };
    Err(classify_git_command_failure(current_dir, message))
}

fn review_evidence_error(error: ReviewPlatformError, resource: &str) -> ReviewPlatformError {
    match error {
        ReviewPlatformError::EvidenceTooLarge { limit, .. } => {
            ReviewPlatformError::EvidenceTooLarge {
                resource: resource.to_string(),
                limit,
            }
        }
        error => error,
    }
}

fn github_api_endpoint(ctx: &ProviderContext, url: &str) -> Result<String, ReviewPlatformError> {
    url.strip_prefix(&ctx.api_base_url)
        .map(|endpoint| endpoint.trim_start_matches('/').to_string())
        .filter(|endpoint| !endpoint.is_empty())
        .ok_or_else(|| {
            ReviewPlatformError::Api(
                "GitHub API endpoint does not match the selected GitHub host".to_string(),
            )
        })
}

async fn github_api_get_json(
    ctx: &ProviderContext,
    url: &str,
    query: &[(String, String)],
    max_output_bytes: usize,
) -> Result<Value, ReviewPlatformError> {
    let endpoint = github_api_endpoint(ctx, url)?;
    let mut args = vec![
        "api".to_string(),
        "--hostname".to_string(),
        ctx.remote.host.clone(),
        "--method".to_string(),
        "GET".to_string(),
        "--header".to_string(),
        "Accept: application/vnd.github+json".to_string(),
        endpoint,
    ];
    for (key, value) in query {
        args.push("--raw-field".to_string());
        args.push(format!("{key}={value}"));
    }
    let output = execute_gh(&args, None, max_output_bytes).await?;
    serde_json::from_slice(&output)
        .map_err(|error| ReviewPlatformError::Parse(format!("Invalid GitHub CLI JSON: {error}")))
}

async fn github_api_post_json(
    ctx: &ProviderContext,
    url: &str,
    body: &Value,
) -> Result<Value, ReviewPlatformError> {
    let endpoint = github_api_endpoint(ctx, url)?;
    let args = vec![
        "api".to_string(),
        "--hostname".to_string(),
        ctx.remote.host.clone(),
        "--method".to_string(),
        "POST".to_string(),
        "--header".to_string(),
        "Accept: application/vnd.github+json".to_string(),
        "--input".to_string(),
        "-".to_string(),
        endpoint,
    ];
    let input =
        serde_json::to_vec(body).map_err(|error| ReviewPlatformError::Parse(error.to_string()))?;
    let output = execute_gh(&args, Some(&input), DEFAULT_GH_OUTPUT_MAX_BYTES).await?;
    serde_json::from_slice(&output)
        .map_err(|error| ReviewPlatformError::Parse(format!("Invalid GitHub CLI JSON: {error}")))
}

async fn github_api_get_text(
    ctx: &ProviderContext,
    url: &str,
    max_output_bytes: usize,
) -> Result<ReviewTextResponse, ReviewPlatformError> {
    let endpoint = github_api_endpoint(ctx, url)?;
    let args = vec![
        "api".to_string(),
        "--hostname".to_string(),
        ctx.remote.host.clone(),
        "--method".to_string(),
        "GET".to_string(),
        endpoint,
    ];
    let output = execute_gh(&args, None, max_output_bytes).await?;
    Ok(ReviewTextResponse {
        text: String::from_utf8_lossy(&output).to_string(),
        truncated: false,
    })
}

async fn github_current_user_open_pull_requests(
    ctx: &ProviderContext,
    pagination: PullRequestPagination,
) -> Result<ReviewPlatformPullRequestPage, ReviewPlatformError> {
    let limit = github_pull_request_list_limit(pagination);
    let items = github_current_user_open_pull_request_values(ctx, limit).await?;
    Ok(paginate_github_pull_requests(items, pagination))
}

async fn github_current_user_open_pull_requests_for_remotes(
    remotes: &[ReviewPlatformRemote],
    auth_tokens: &ReviewPlatformAuthTokens,
    pagination: PullRequestPagination,
) -> Result<ReviewPlatformPullRequestPage, ReviewPlatformError> {
    let mut seen_repositories = HashSet::new();
    let contexts = remotes
        .iter()
        .filter(|remote| {
            remote.platform == ReviewPlatformKind::Github
                && remote.supported
                && remote.auth_state == ReviewAuthState::Connected
        })
        .filter(|remote| {
            seen_repositories.insert(format!("{}:{}", remote.host, remote.project_path))
        })
        .filter_map(|remote| provider_context(remote.clone(), auth_tokens).ok())
        .collect::<Vec<_>>();
    let limit = github_pull_request_list_limit(pagination);
    let results =
        stream::iter(contexts.into_iter().map(|ctx| async move {
            github_current_user_open_pull_request_values(&ctx, limit).await
        }))
        .buffered(PROVIDER_ENRICH_CONCURRENCY)
        .collect::<Vec<_>>()
        .await;

    let mut pull_requests = Vec::new();
    let mut first_error = None;
    let mut successful_repositories = 0usize;
    for result in results {
        match result {
            Ok(items) => {
                successful_repositories += 1;
                pull_requests.extend(items);
            }
            Err(error) => {
                first_error.get_or_insert(error);
            }
        }
    }
    if successful_repositories == 0 {
        if let Some(error) = first_error {
            return Err(error);
        }
    }

    Ok(aggregate_github_pull_requests(pull_requests, pagination))
}

fn aggregate_github_pull_requests(
    mut pull_requests: Vec<ReviewPlatformPullRequest>,
    pagination: PullRequestPagination,
) -> ReviewPlatformPullRequestPage {
    pull_requests.sort_by(|left, right| right.updated_at.cmp(&left.updated_at));
    let mut seen_pull_requests = HashSet::new();
    pull_requests.retain(|pull_request| seen_pull_requests.insert(pull_request.web_url.clone()));
    paginate_github_pull_requests(pull_requests, pagination)
}

fn github_pull_request_list_limit(pagination: PullRequestPagination) -> u32 {
    pagination
        .page
        .saturating_mul(pagination.per_page)
        .saturating_add(1)
        .min(1_000)
}

async fn github_current_user_open_pull_request_values(
    ctx: &ProviderContext,
    limit: u32,
) -> Result<Vec<ReviewPlatformPullRequest>, ReviewPlatformError> {
    let repository = format!(
        "{}/{}/{}",
        ctx.remote.host, ctx.remote.owner, ctx.remote.repository_name
    );
    let args = vec![
        "pr".to_string(),
        "list".to_string(),
        "--repo".to_string(),
        repository,
        "--author".to_string(),
        "@me".to_string(),
        "--state".to_string(),
        "open".to_string(),
        "--limit".to_string(),
        limit.to_string(),
        "--json".to_string(),
        [
            "number",
            "title",
            "state",
            "isDraft",
            "author",
            "headRefName",
            "headRefOid",
            "baseRefName",
            "baseRefOid",
            "updatedAt",
            "url",
            "additions",
            "deletions",
            "changedFiles",
            "comments",
            "reviewDecision",
            "statusCheckRollup",
        ]
        .join(","),
    ];
    let output = execute_gh(&args, None, DEFAULT_GH_OUTPUT_MAX_BYTES).await?;
    let value: Value = serde_json::from_slice(&output)
        .map_err(|error| ReviewPlatformError::Parse(format!("Invalid GitHub CLI JSON: {error}")))?;
    let items = value.as_array().ok_or_else(|| {
        ReviewPlatformError::Parse("GitHub CLI pull response was not an array".to_string())
    })?;
    Ok(items
        .iter()
        .map(|value| github_pull_request_from_gh_cli_value(value, Some(&ctx.remote.id)))
        .collect())
}

fn paginate_github_pull_requests(
    items: Vec<ReviewPlatformPullRequest>,
    pagination: PullRequestPagination,
) -> ReviewPlatformPullRequestPage {
    let start = pagination
        .page
        .saturating_sub(1)
        .saturating_mul(pagination.per_page) as usize;
    let end = start.saturating_add(pagination.per_page as usize);
    let has_next = items.len() > end;
    let total = (!has_next).then_some(items.len() as u64);
    let pull_requests = items
        .into_iter()
        .skip(start)
        .take(pagination.per_page as usize)
        .collect();

    ReviewPlatformPullRequestPage {
        items: pull_requests,
        pagination: ReviewPlatformPagination {
            page: pagination.page,
            per_page: pagination.per_page,
            total,
            has_next,
        },
    }
}

fn github_pull_request_from_gh_cli_value(
    value: &Value,
    provider_id: Option<&str>,
) -> ReviewPlatformPullRequest {
    let number = value_i64(value, "number");
    let state = if value_bool(value, "isDraft") {
        ReviewItemState::Draft
    } else {
        match value_string(value, "state").to_ascii_uppercase().as_str() {
            "MERGED" => ReviewItemState::Merged,
            "CLOSED" => ReviewItemState::Closed,
            _ => ReviewItemState::Open,
        }
    };
    let review_decision = match value_string(value, "reviewDecision").as_str() {
        "APPROVED" => ReviewDecision::Approved,
        "CHANGES_REQUESTED" => ReviewDecision::ChangesRequested,
        "COMMENTED" => ReviewDecision::Commented,
        _ => ReviewDecision::Pending,
    };

    ReviewPlatformPullRequest {
        id: number.to_string(),
        provider_id: provider_id.map(str::to_string),
        number,
        title: value_string(value, "title"),
        state,
        author: nested_string(value, &["author", "login"]),
        source_branch: value_string(value, "headRefName"),
        target_branch: value_string(value, "baseRefName"),
        base_revision: non_empty_option(value_string(value, "baseRefOid")),
        head_revision: non_empty_option(value_string(value, "headRefOid")),
        updated_at: value_string(value, "updatedAt"),
        web_url: value_string(value, "url"),
        additions: value_i64(value, "additions") as i32,
        deletions: value_i64(value, "deletions") as i32,
        changed_files: value_i64(value, "changedFiles") as i32,
        line_stats_known: None,
        changed_file_count_known: true,
        comments: value
            .get("comments")
            .and_then(Value::as_array)
            .map(Vec::len)
            .unwrap_or_default() as i32,
        review_decision,
        checks: github_checks_from_gh_cli_value(value),
    }
}

fn github_checks_from_gh_cli_value(value: &Value) -> ReviewChecks {
    let mut checks = empty_checks();
    for item in value
        .get("statusCheckRollup")
        .and_then(Value::as_array)
        .map(Vec::as_slice)
        .unwrap_or(&[])
    {
        let outcome = first_non_empty(&[
            value_string(item, "conclusion"),
            value_string(item, "state"),
            value_string(item, "status"),
        ])
        .to_ascii_lowercase();
        if matches!(outcome.as_str(), "success" | "neutral" | "skipped") {
            checks.passed += 1;
        } else if matches!(
            outcome.as_str(),
            "failure" | "failed" | "error" | "cancelled" | "timed_out" | "action_required"
        ) {
            checks.failed += 1;
        } else {
            checks.pending += 1;
        }
    }
    checks.total = checks.passed + checks.failed + checks.pending;
    checks
}

async fn github_api_array_page(
    ctx: &ProviderContext,
    url: &str,
    pagination: PullRequestPagination,
    extra_query: &[(String, String)],
) -> Result<(Value, ReviewPlatformPagination), ReviewPlatformError> {
    let mut query = extra_query.to_vec();
    query.push(("per_page".to_string(), pagination.per_page.to_string()));
    query.push(("page".to_string(), pagination.page.to_string()));
    let value = github_api_get_json(ctx, url, &query, DEFAULT_GH_OUTPUT_MAX_BYTES).await?;
    let item_count = value
        .as_array()
        .ok_or_else(|| {
            ReviewPlatformError::Parse("GitHub paginated response was not an array".to_string())
        })?
        .len();
    Ok((
        value,
        ReviewPlatformPagination {
            page: pagination.page,
            per_page: pagination.per_page,
            total: None,
            has_next: item_count == pagination.per_page as usize,
        },
    ))
}

async fn fetch_github_paginated_array(
    ctx: &ProviderContext,
    url: &str,
) -> Result<Value, ReviewPlatformError> {
    let mut page = 1u32;
    let mut values = Vec::new();
    loop {
        let query = vec![
            ("per_page".to_string(), "100".to_string()),
            ("page".to_string(), page.to_string()),
        ];
        let value = github_api_get_json(ctx, url, &query, DEFAULT_GH_OUTPUT_MAX_BYTES).await?;
        let items = value.as_array().ok_or_else(|| {
            ReviewPlatformError::Parse("GitHub paginated response was not an array".to_string())
        })?;
        let item_count = items.len();
        values.extend(items.iter().cloned());
        if item_count < 100 {
            break;
        }
        page = page.saturating_add(1);
    }
    Ok(Value::Array(values))
}

async fn fetch_bounded_github_paginated_array(
    ctx: &ProviderContext,
    url: &str,
    max_items: usize,
) -> Result<Value, ReviewPlatformError> {
    let mut page = 1u32;
    let mut values = Vec::new();
    while values.len() < max_items {
        let query = vec![
            ("per_page".to_string(), "100".to_string()),
            ("page".to_string(), page.to_string()),
        ];
        let value = github_api_get_json(ctx, url, &query, MAX_REVIEW_TARGET_RESPONSE_BYTES).await?;
        let items = value.as_array().ok_or_else(|| {
            ReviewPlatformError::Parse("GitHub paginated response was not an array".to_string())
        })?;
        let item_count = items.len();
        values.extend(items.iter().take(max_items - values.len()).cloned());
        if item_count < 100 || values.len() >= max_items {
            break;
        }
        if page as usize >= MAX_REVIEW_TARGET_PAGES {
            return Err(ReviewPlatformError::EvidenceTooLarge {
                resource: "GitHub pagination pages".to_string(),
                limit: MAX_REVIEW_TARGET_PAGES,
            });
        }
        page = page.saturating_add(1);
    }
    Ok(Value::Array(values))
}

async fn fetch_bounded_github_file(
    ctx: &ProviderContext,
    url: &str,
    start_page: u32,
    max_items: usize,
    file_path: &str,
) -> Result<Option<ReviewPlatformFile>, ReviewPlatformError> {
    let mut page = start_page.max(1);
    let mut visited = 0usize;
    let mut request_count = 0usize;
    while visited < max_items {
        let query = vec![
            ("per_page".to_string(), "100".to_string()),
            ("page".to_string(), page.to_string()),
        ];
        let value = github_api_get_json(ctx, url, &query, MAX_REVIEW_TARGET_RESPONSE_BYTES).await?;
        request_count += 1;
        let items = value.as_array().ok_or_else(|| {
            ReviewPlatformError::Parse("GitHub paginated response was not an array".to_string())
        })?;
        for item in items.iter().take(max_items - visited) {
            let file = github_file_from_value(item);
            if file.path == file_path || file.old_path.as_deref() == Some(file_path) {
                return Ok(Some(file));
            }
            visited += 1;
        }
        if items.len() < 100 || visited >= max_items {
            break;
        }
        if request_count >= MAX_REVIEW_TARGET_PAGES {
            return Err(ReviewPlatformError::EvidenceTooLarge {
                resource: "GitHub pagination pages".to_string(),
                limit: MAX_REVIEW_TARGET_PAGES,
            });
        }
        page = page.saturating_add(1);
    }
    Ok(None)
}

#[derive(Debug, Clone, Default)]
struct GhAuthStatus {
    installed: bool,
    connected: bool,
    username: Option<String>,
}

async fn execute_gh(
    args: &[String],
    stdin: Option<&[u8]>,
    max_output_bytes: usize,
) -> Result<Vec<u8>, ReviewPlatformError> {
    let mut command = process_manager::create_tokio_command("gh");
    command
        .args(args)
        .env_remove("GH_TOKEN")
        .env_remove("GITHUB_TOKEN")
        .env_remove("GH_ENTERPRISE_TOKEN")
        .env_remove("GITHUB_ENTERPRISE_TOKEN");
    if stdin.is_some() {
        command.stdin(std::process::Stdio::piped());
    }
    command
        .stdout(std::process::Stdio::piped())
        .stderr(std::process::Stdio::piped());
    let mut child = command.spawn().map_err(|error| {
        ReviewPlatformError::Api(format!(
            "GitHub CLI is required but could not be started: {error}. Install `gh` and run `gh auth login`."
        ))
    })?;
    if let Some(input) = stdin {
        let mut child_stdin = child.stdin.take().ok_or_else(|| {
            ReviewPlatformError::Api("Failed to open GitHub CLI input".to_string())
        })?;
        child_stdin.write_all(input).await.map_err(|error| {
            ReviewPlatformError::Api(format!("Failed to send a request to GitHub CLI: {error}"))
        })?;
    }
    let output = child.wait_with_output().await.map_err(|error| {
        ReviewPlatformError::Api(format!("Failed to wait for GitHub CLI: {error}"))
    })?;
    if output.stdout.len() > max_output_bytes {
        return Err(ReviewPlatformError::EvidenceTooLarge {
            resource: "GitHub CLI response".to_string(),
            limit: max_output_bytes,
        });
    }
    if output.status.success() {
        return Ok(output.stdout);
    }

    let raw_message = if output.stderr.is_empty() {
        String::from_utf8_lossy(&output.stdout).to_string()
    } else {
        String::from_utf8_lossy(&output.stderr).to_string()
    };
    let message = sanitize_gh_error(&raw_message);
    if let Some(status) = gh_http_status(&message) {
        return Err(ReviewPlatformError::Http {
            status,
            message: format!(": {message}"),
        });
    }
    Err(ReviewPlatformError::Api(message))
}

fn sanitize_gh_error(message: &str) -> String {
    let message = message.trim();
    let truncated = message
        .chars()
        .take(GH_ERROR_OUTPUT_MAX_CHARS)
        .collect::<String>();
    if truncated.is_empty() {
        "GitHub CLI command failed".to_string()
    } else {
        truncated
    }
}

fn gh_http_status(message: &str) -> Option<u16> {
    let marker = "HTTP ";
    let start = message.find(marker)? + marker.len();
    message.get(start..start + 3)?.parse().ok()
}

fn parse_gh_auth_status(host: &str, value: &Value) -> GhAuthStatus {
    let accounts = value
        .get("hosts")
        .and_then(|hosts| hosts.get(host))
        .and_then(Value::as_array);
    let active = accounts.and_then(|accounts| {
        accounts.iter().find(|account| {
            account.get("active").and_then(Value::as_bool) == Some(true)
                && account.get("state").and_then(Value::as_str) == Some("success")
        })
    });
    GhAuthStatus {
        installed: true,
        connected: active.is_some(),
        username: active
            .and_then(|account| account.get("login"))
            .and_then(Value::as_str)
            .map(str::to_string),
    }
}

async fn gh_auth_status(host: &str) -> GhAuthStatus {
    let args = vec![
        "auth".to_string(),
        "status".to_string(),
        "--active".to_string(),
        "--hostname".to_string(),
        host.to_string(),
        "--json".to_string(),
        "hosts".to_string(),
    ];
    match execute_gh(&args, None, 256 * 1024).await {
        Ok(output) => match serde_json::from_slice::<Value>(&output) {
            Ok(value) => parse_gh_auth_status(host, &value),
            Err(_error) => GhAuthStatus {
                installed: true,
                ..GhAuthStatus::default()
            },
        },
        Err(error) => GhAuthStatus {
            installed: !error.to_string().contains("could not be started"),
            ..GhAuthStatus::default()
        },
    }
}

fn hydrate_github_remote_auth(remote: &mut ReviewPlatformRemote, status: GhAuthStatus) {
    if remote.platform == ReviewPlatformKind::Unknown && !status.connected {
        return;
    }
    if remote.platform == ReviewPlatformKind::Unknown {
        remote.platform = ReviewPlatformKind::Github;
        remote.id = format!(
            "{}:{}:{}",
            remote.name,
            remote.platform.as_str(),
            remote.project_path.replace('/', "__")
        );
        remote.supported = true;
    }
    remote.auth_state = if status.connected {
        ReviewAuthState::Connected
    } else {
        ReviewAuthState::NotConnected
    };
    remote.auth_source = if status.connected {
        ReviewAuthSource::GhCli
    } else {
        ReviewAuthSource::None
    };
    remote.message = if status.connected {
        status
            .username
            .map(|username| format!("Authenticated via GitHub CLI as {username}."))
    } else if status.installed {
        Some(format!(
            "Run `gh auth login --hostname {}` to connect this GitHub host.",
            remote.host
        ))
    } else {
        Some("Install GitHub CLI, then run `gh auth login` to connect GitHub.".to_string())
    };
}

fn normalize_repository_root(root: &str) -> String {
    let root = root.trim();
    #[cfg(windows)]
    {
        root.replace('/', "\\")
    }
    #[cfg(not(windows))]
    {
        root.to_string()
    }
}

impl ReviewPlatformService {
    async fn load_stored_tokens(&self) -> Result<ReviewPlatformAuthTokens, ReviewPlatformError> {
        let mut stored = {
            let _transaction = self.token_store_lock.lock().await;
            self.load_stored_token_file_unlocked().await?
        };
        let gitee_store = self.token_store_owner(ReviewPlatformKind::Gitee, "gitee.com")?;
        let gitee_tokens = {
            let _transaction = gitee_store.token_store_lock.lock().await;
            gitee_store.load_stored_token_file_unlocked().await?
        };
        if gitee_tokens
            .tokens
            .keys()
            .any(|key| key != "gitee:gitee.com")
        {
            return Err(ReviewPlatformError::Parse(
                "Gitee token store contains an unexpected provider authority".to_string(),
            ));
        }
        stored.tokens.extend(gitee_tokens.tokens);
        Ok(ReviewPlatformAuthTokens {
            tokens: stored
                .tokens
                .into_iter()
                .map(|(key, entry)| (key, entry.token))
                .collect(),
        })
    }

    async fn load_stored_token_file_unlocked(
        &self,
    ) -> Result<StoredReviewPlatformTokens, ReviewPlatformError> {
        let path = self.token_store_path();
        match fs::read_to_string(path).await {
            Ok(content) => {
                let value = serde_json::from_str::<Value>(&content)
                    .map_err(|error| ReviewPlatformError::Parse(error.to_string()))?;
                let schema_version = value
                    .get("schemaVersion")
                    .and_then(Value::as_u64)
                    .and_then(|version| u16::try_from(version).ok());
                if schema_version != Some(REVIEW_PLATFORM_TOKEN_SCHEMA_VERSION) {
                    return Err(ReviewPlatformError::Parse(
                        "Review platform token store is not in the OpenBitFun 1.0.0 format; use the explicit data migration tool instead"
                            .to_string(),
                    ));
                }
                let stored = serde_json::from_value::<StoredReviewPlatformTokens>(value)
                    .map_err(|error| ReviewPlatformError::Parse(error.to_string()))?;
                validate_current_stored_tokens(&stored)?;
                Ok(stored)
            }
            Err(error) if error.kind() == std::io::ErrorKind::NotFound => {
                Ok(StoredReviewPlatformTokens::default())
            }
            Err(error) => Err(ReviewPlatformError::Api(format!(
                "Failed to read review platform token store: {}",
                error
            ))),
        }
    }

    async fn save_stored_token_file_unlocked(
        &self,
        stored: &StoredReviewPlatformTokens,
    ) -> Result<(), ReviewPlatformError> {
        let path = self.token_store_path();
        if let Some(parent) = path.parent() {
            fs::create_dir_all(parent).await.map_err(|error| {
                ReviewPlatformError::Api(format!(
                    "Failed to create review platform token store directory: {}",
                    error
                ))
            })?;
        }
        let content = serde_json::to_string_pretty(stored)
            .map_err(|error| ReviewPlatformError::Parse(error.to_string()))?;
        let temp_path = token_store_temp_path(path);
        let result = async {
            let mut file = fs::OpenOptions::new()
                .create_new(true)
                .write(true)
                .open(&temp_path)
                .await?;
            file.write_all(content.as_bytes()).await?;
            file.sync_all().await?;
            drop(file);
            replace_token_store_file_atomically(&temp_path, path)?;
            Ok::<(), std::io::Error>(())
        }
        .await;
        if let Err(error) = result {
            let _ = fs::remove_file(&temp_path).await;
            return Err(ReviewPlatformError::Api(format!(
                "Failed to replace review platform token store: {error}"
            )));
        }
        Ok(())
    }
}

fn token_store_temp_path(path: &Path) -> PathBuf {
    let nonce = TOKEN_STORE_TEMP_NONCE.fetch_add(1, std::sync::atomic::Ordering::Relaxed);
    let timestamp = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .unwrap_or_default()
        .as_nanos();
    let file_name = path
        .file_name()
        .map(|value| value.to_string_lossy().into_owned())
        .unwrap_or_else(|| REVIEW_PLATFORM_TOKEN_FILE_NAME.to_string());
    path.with_file_name(format!(
        ".{file_name}.{}.{}.{}.tmp",
        std::process::id(),
        timestamp,
        nonce
    ))
}

#[cfg(windows)]
fn replace_token_store_file_atomically(
    temp_path: &Path,
    target_path: &Path,
) -> std::io::Result<()> {
    use std::os::windows::ffi::OsStrExt;
    use windows::core::PCWSTR;
    use windows::Win32::Storage::FileSystem::{
        MoveFileExW, ReplaceFileW, MOVEFILE_WRITE_THROUGH, REPLACEFILE_WRITE_THROUGH,
    };

    let temp = temp_path
        .as_os_str()
        .encode_wide()
        .chain(std::iter::once(0))
        .collect::<Vec<_>>();
    let target = target_path
        .as_os_str()
        .encode_wide()
        .chain(std::iter::once(0))
        .collect::<Vec<_>>();
    let result = unsafe {
        if target_path.exists() {
            ReplaceFileW(
                PCWSTR(target.as_ptr()),
                PCWSTR(temp.as_ptr()),
                PCWSTR::null(),
                REPLACEFILE_WRITE_THROUGH,
                None,
                None,
            )
        } else {
            MoveFileExW(
                PCWSTR(temp.as_ptr()),
                PCWSTR(target.as_ptr()),
                MOVEFILE_WRITE_THROUGH,
            )
        }
    };
    result.map_err(|error| std::io::Error::other(error.to_string()))
}

#[cfg(not(windows))]
fn replace_token_store_file_atomically(
    temp_path: &Path,
    target_path: &Path,
) -> std::io::Result<()> {
    std::fs::rename(temp_path, target_path)
}

fn select_remote<'a>(
    remotes: &'a [ReviewPlatformRemote],
    remote_id: Option<&str>,
) -> Option<&'a ReviewPlatformRemote> {
    if let Some(remote_id) = remote_id {
        if let Some(remote) = remotes.iter().find(|remote| remote.id == remote_id) {
            return Some(remote);
        }
    }
    remotes
        .iter()
        .find(|remote| {
            remote.supported
                && remote.platform == ReviewPlatformKind::Github
                && remote.auth_state == ReviewAuthState::Connected
        })
        .or_else(|| {
            remotes
                .iter()
                .find(|remote| remote.supported && remote.platform == ReviewPlatformKind::Github)
        })
        .or_else(|| remotes.iter().find(|remote| remote.supported))
        .or_else(|| remotes.first())
}

fn select_remote_for_action<'a>(
    remotes: &'a [ReviewPlatformRemote],
    remote_id: Option<&str>,
) -> Result<&'a ReviewPlatformRemote, ReviewPlatformError> {
    if let Some(remote_id) = remote_id {
        return remotes
            .iter()
            .find(|remote| remote.id == remote_id)
            .ok_or_else(|| ReviewPlatformError::RemoteNotFound(remote_id.to_string()));
    }

    let supported = remotes
        .iter()
        .filter(|remote| remote.supported)
        .collect::<Vec<_>>();
    match supported.as_slice() {
        [] => remotes
            .first()
            .ok_or_else(|| ReviewPlatformError::RemoteNotFound("default".to_string())),
        [remote] => Ok(remote),
        _ => Err(ReviewPlatformError::Api(format!(
            "Multiple supported review platform remotes were found. Provide remote_id explicitly. Candidate remotes:\n{}",
            supported
                .iter()
                .map(|remote| format!(
                    "- remote_id: {} | name: {} | platform: {:?} | project: {} | url: {}",
                    remote.id, remote.name, remote.platform, remote.project_path, remote.web_url
                ))
                .collect::<Vec<_>>()
                .join("\n")
        ))),
    }
}

fn empty_snapshot(
    remotes: Vec<ReviewPlatformRemote>,
    selected_remote_id: Option<String>,
    account: Option<ReviewPlatformAccount>,
    message: &str,
) -> ReviewPlatformWorkspaceSnapshot {
    let mut accounts = account.into_iter().collect::<Vec<_>>();
    if let Some(account) = accounts.first_mut() {
        if account.message.is_none() && !message.trim().is_empty() {
            account.message = Some(message.to_string());
        }
    }

    ReviewPlatformWorkspaceSnapshot {
        remotes,
        selected_remote_id,
        accounts,
        repository: None,
        pull_requests: Vec::new(),
        pagination: ReviewPlatformPagination {
            page: DEFAULT_PR_PAGE,
            per_page: DEFAULT_PR_PAGE_SIZE,
            total: Some(0),
            has_next: false,
        },
        capabilities: ReviewPlatformCapabilities {
            can_create_review: false,
            can_create_pull_request: false,
            can_reply_to_thread: false,
            can_resolve_thread: false,
            can_approve: false,
            can_revoke_approval: false,
            can_request_changes: false,
            can_merge: false,
            supports_draft_review: false,
            supported_pull_request_states: Vec::new(),
        },
        message: if message.trim().is_empty() {
            None
        } else {
            Some(message.to_string())
        },
        auth_challenge: None,
    }
}

fn auth_required_snapshot(
    remotes: Vec<ReviewPlatformRemote>,
    remote: ReviewPlatformRemote,
    repository: Option<ReviewPlatformRepositoryRef>,
    account: ReviewPlatformAccount,
    capabilities: ReviewPlatformCapabilities,
    challenge: ReviewPlatformAuthChallenge,
) -> ReviewPlatformWorkspaceSnapshot {
    ReviewPlatformWorkspaceSnapshot {
        remotes,
        selected_remote_id: Some(remote.id),
        accounts: vec![account],
        repository,
        pull_requests: Vec::new(),
        pagination: ReviewPlatformPagination {
            page: DEFAULT_PR_PAGE,
            per_page: DEFAULT_PR_PAGE_SIZE,
            total: Some(0),
            has_next: false,
        },
        capabilities,
        message: Some(challenge.message.clone()),
        auth_challenge: Some(challenge),
    }
}

fn repository_ref(
    remote: &ReviewPlatformRemote,
    workspace_path: Option<String>,
) -> ReviewPlatformRepositoryRef {
    ReviewPlatformRepositoryRef {
        provider_id: remote.id.clone(),
        platform: remote.platform,
        host: remote.host.clone(),
        owner: remote.owner.clone(),
        name: remote.repository_name.clone(),
        project_path: remote.project_path.clone(),
        default_branch: "main".to_string(),
        workspace_path,
        web_url: remote.web_url.clone(),
    }
}

fn account_for_remote(remote: &ReviewPlatformRemote) -> ReviewPlatformAccount {
    ReviewPlatformAccount {
        id: remote.id.clone(),
        platform: remote.platform,
        label: format!("{} ({})", platform_label(remote.platform), remote.host),
        username: remote
            .message
            .as_deref()
            .and_then(|message| message.strip_prefix("Authenticated via GitHub CLI as "))
            .and_then(|message| message.strip_suffix('.'))
            .map(str::to_string),
        host: remote.host.clone(),
        auth_state: remote.auth_state,
        auth_source: remote.auth_source,
        scopes: if matches!(
            remote.auth_source,
            ReviewAuthSource::GhCli | ReviewAuthSource::Env | ReviewAuthSource::Stored
        ) {
            vec!["pull_request:read".to_string()]
        } else {
            Vec::new()
        },
        message: remote.message.clone(),
    }
}

fn capabilities_for_remote(_remote: &ReviewPlatformRemote) -> ReviewPlatformCapabilities {
    let platform = _remote.platform;
    ReviewPlatformCapabilities {
        can_create_review: matches!(
            platform,
            ReviewPlatformKind::Github
                | ReviewPlatformKind::Gitlab
                | ReviewPlatformKind::Gitcode
                | ReviewPlatformKind::Gitee
        ),
        can_create_pull_request: matches!(
            platform,
            ReviewPlatformKind::Github
                | ReviewPlatformKind::Gitlab
                | ReviewPlatformKind::Gitcode
                | ReviewPlatformKind::Gitee
        ),
        can_reply_to_thread: matches!(
            platform,
            ReviewPlatformKind::Github | ReviewPlatformKind::Gitlab
        ),
        can_resolve_thread: matches!(platform, ReviewPlatformKind::Gitlab),
        can_approve: matches!(
            platform,
            ReviewPlatformKind::Github
                | ReviewPlatformKind::Gitlab
                | ReviewPlatformKind::Gitcode
                | ReviewPlatformKind::Gitee
        ),
        can_revoke_approval: matches!(
            platform,
            ReviewPlatformKind::Gitlab | ReviewPlatformKind::Gitee
        ),
        can_request_changes: matches!(platform, ReviewPlatformKind::Github),
        can_merge: false,
        supports_draft_review: matches!(platform, ReviewPlatformKind::Github),
        supported_pull_request_states: if platform == ReviewPlatformKind::Gitee {
            vec![
                ReviewPlatformListState::All,
                ReviewPlatformListState::Open,
                ReviewPlatformListState::Draft,
                ReviewPlatformListState::Merged,
                ReviewPlatformListState::Closed,
            ]
        } else {
            Vec::new()
        },
    }
}

fn platform_label(platform: ReviewPlatformKind) -> &'static str {
    match platform {
        ReviewPlatformKind::Github => "GitHub",
        ReviewPlatformKind::Gitlab => "GitLab",
        ReviewPlatformKind::Gitcode => "GitCode",
        ReviewPlatformKind::Gitee => "Gitee",
        ReviewPlatformKind::Unknown => "Git",
    }
}

fn required_scopes_for_platform(platform: ReviewPlatformKind) -> Vec<String> {
    match platform {
        ReviewPlatformKind::Github => vec!["repo".to_string(), "workflow".to_string()],
        ReviewPlatformKind::Gitlab => {
            vec!["read_api".to_string(), "api for write actions".to_string()]
        }
        ReviewPlatformKind::Gitcode => vec!["pull_request".to_string()],
        ReviewPlatformKind::Gitee => vec!["pull_requests".to_string(), "projects".to_string()],
        ReviewPlatformKind::Unknown => Vec::new(),
    }
}

fn auth_state_for_challenge(state: ReviewPlatformAuthChallengeState) -> ReviewAuthState {
    match state {
        ReviewPlatformAuthChallengeState::Missing => ReviewAuthState::NotConnected,
        ReviewPlatformAuthChallengeState::Invalid => ReviewAuthState::Expired,
        ReviewPlatformAuthChallengeState::InsufficientScope => ReviewAuthState::Error,
    }
}

fn is_auth_http_error(error: &ReviewPlatformError) -> bool {
    matches!(
        error,
        ReviewPlatformError::Http {
            status: 401 | 403,
            ..
        }
    )
}

fn auth_challenge_for_remote(
    remote: &ReviewPlatformRemote,
    error: &ReviewPlatformError,
    has_token: bool,
) -> ReviewPlatformAuthChallenge {
    if remote.platform == ReviewPlatformKind::Github {
        return github_cli_auth_challenge(remote);
    }
    let status = match error {
        ReviewPlatformError::Http { status, .. } => *status,
        _ => 0,
    };
    let state = if !has_token {
        ReviewPlatformAuthChallengeState::Missing
    } else if status == 403 {
        ReviewPlatformAuthChallengeState::InsufficientScope
    } else {
        ReviewPlatformAuthChallengeState::Invalid
    };
    let action = match state {
        ReviewPlatformAuthChallengeState::Missing => "Add",
        ReviewPlatformAuthChallengeState::Invalid => "Update",
        ReviewPlatformAuthChallengeState::InsufficientScope => "Update",
    };
    let reason = match state {
        ReviewPlatformAuthChallengeState::Missing => {
            "a token is required to access this repository"
        }
        ReviewPlatformAuthChallengeState::Invalid => "the saved or environment token was rejected",
        ReviewPlatformAuthChallengeState::InsufficientScope => {
            "the token does not have enough permissions"
        }
    };
    ReviewPlatformAuthChallenge {
        platform: remote.platform,
        host: remote.host.clone(),
        remote_id: remote.id.clone(),
        project_path: remote.project_path.clone(),
        state,
        message: format!(
            "{} {} token for {}: {}.",
            action,
            platform_label(remote.platform),
            remote.host,
            reason
        ),
        required_scopes: required_scopes_for_platform(remote.platform),
    }
}

fn github_cli_auth_challenge(remote: &ReviewPlatformRemote) -> ReviewPlatformAuthChallenge {
    ReviewPlatformAuthChallenge {
        platform: ReviewPlatformKind::Github,
        host: remote.host.clone(),
        remote_id: remote.id.clone(),
        project_path: remote.project_path.clone(),
        state: ReviewPlatformAuthChallengeState::Missing,
        message: format!(
            "Authenticate GitHub with the local CLI, then retry: `gh auth login --hostname {}`.",
            remote.host
        ),
        required_scopes: required_scopes_for_platform(ReviewPlatformKind::Github),
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum CiOutcome {
    Passed,
    Failed,
    Pending,
}

fn summarize_ci_items(items: &[ReviewPlatformCiItem]) -> ReviewChecks {
    let mut checks = empty_checks();
    for item in items {
        match ci_item_outcome(item) {
            CiOutcome::Passed => checks.passed += 1,
            CiOutcome::Failed => checks.failed += 1,
            CiOutcome::Pending => checks.pending += 1,
        }
    }
    checks.total = checks.passed + checks.failed + checks.pending;
    checks
}

fn ci_item_outcome(item: &ReviewPlatformCiItem) -> CiOutcome {
    let status = item.status.trim().to_ascii_lowercase();
    let conclusion = item
        .conclusion
        .as_deref()
        .unwrap_or("")
        .trim()
        .to_ascii_lowercase();

    if conclusion.is_empty() {
        return ci_status_outcome(&status);
    }

    match conclusion.as_str() {
        "success" | "neutral" | "skipped" | "passed" => CiOutcome::Passed,
        "failure" | "timed_out" | "timed-out" | "cancelled" | "canceled" | "action_required"
        | "error" => CiOutcome::Failed,
        "queued"
        | "pending"
        | "running"
        | "in_progress"
        | "in progress"
        | "created"
        | "manual"
        | "scheduled"
        | "waiting_for_resource"
        | "preparing"
        | "requested" => CiOutcome::Pending,
        _ => ci_status_outcome(&status),
    }
}

fn ci_status_outcome(status: &str) -> CiOutcome {
    match status.trim().to_ascii_lowercase().as_str() {
        "success" | "passed" | "pass" | "skipped" | "ok" | "available" | "can_be_merged"
        | "mergeable" | "true" | "enabled" | "active" => CiOutcome::Passed,
        "failure" | "failed" | "fail" | "error" | "cancelled" | "canceled" | "cannot_be_merged"
        | "conflict" | "blocked" | "false" | "disabled" | "inactive" => CiOutcome::Failed,
        "pending"
        | "queued"
        | "running"
        | "in_progress"
        | "in progress"
        | "created"
        | "manual"
        | "scheduled"
        | "waiting_for_resource"
        | "preparing"
        | "requested"
        | "checking"
        | "unchecked"
        | "completed" => CiOutcome::Pending,
        _ => CiOutcome::Pending,
    }
}

fn ci_log_value(text: String) -> (Option<String>, bool) {
    let extracted = ci_error_excerpt(&text);
    let Some(excerpt) = extracted else {
        return (None, false);
    };
    let char_count = excerpt.chars().count();
    if char_count <= MAX_CI_LOG_CHARS {
        return (Some(excerpt), false);
    }

    (
        Some(format!(
            "[Error excerpt truncated: showing first {} of {} chars]\n{}",
            MAX_CI_LOG_CHARS,
            char_count,
            excerpt.chars().take(MAX_CI_LOG_CHARS).collect::<String>()
        )),
        true,
    )
}

fn ci_log_value_from_response(response: ReviewTextResponse) -> (Option<String>, bool) {
    let (log, excerpt_truncated) = ci_log_value(response.text);
    (log, response.truncated || excerpt_truncated)
}

fn ci_error_excerpt(text: &str) -> Option<String> {
    let lines: Vec<&str> = text.lines().collect();
    if lines.is_empty() {
        return None;
    }

    let mut ranges: Vec<(usize, usize)> = Vec::new();
    for (index, line) in lines.iter().enumerate() {
        if !is_ci_error_line(line) {
            continue;
        }

        let start = index.saturating_sub(2);
        let mut end = (index + 6).min(lines.len());
        while end < lines.len() && lines[end].trim().is_empty() {
            end += 1;
        }
        ranges.push((start, end));
    }

    if ranges.is_empty() {
        return None;
    }

    ranges.sort_unstable_by_key(|range| range.0);
    let mut merged: Vec<(usize, usize)> = Vec::new();
    for (start, end) in ranges {
        if let Some(last) = merged.last_mut() {
            if start <= last.1.saturating_add(1) {
                last.1 = last.1.max(end);
                continue;
            }
        }
        merged.push((start, end));
    }

    let mut output = String::new();
    for (index, (start, end)) in merged.iter().enumerate() {
        if index > 0 {
            output.push_str("\n...\n");
        }
        for line in &lines[*start..*end] {
            output.push_str(line);
            output.push('\n');
        }
    }

    let output = output.trim_end_matches('\n').trim().to_string();
    if output.is_empty() {
        None
    } else {
        Some(output)
    }
}

fn is_ci_error_line(line: &str) -> bool {
    let lower = line.to_ascii_lowercase();
    lower.contains("##[error]")
        || lower.contains("error:")
        || lower.contains(" failed")
        || lower.contains("failure")
        || lower.contains("fatal")
        || lower.contains("exception")
        || lower.contains("traceback")
        || lower.contains("panic")
        || lower.contains("assertion failed")
        || lower.contains("command failed")
        || lower.contains("exited with code")
        || lower.contains("return code")
        || lower.contains("build failed")
        || lower.contains("test failed")
}

async fn github_checks_and_ci(
    ctx: &ProviderContext,
    pull_detail: &Value,
) -> (ReviewChecks, Vec<ReviewPlatformCiItem>) {
    let sha = nested_string(pull_detail, &["head", "sha"]);
    if sha.trim().is_empty() {
        return (empty_checks(), Vec::new());
    }

    let mut ci_items = Vec::new();
    let status_url = format!(
        "{}/repos/{}/{}/commits/{}/status",
        ctx.api_base_url, ctx.remote.owner, ctx.remote.repository_name, sha
    );
    if let Ok(status) =
        github_api_get_json(ctx, &status_url, &[], DEFAULT_GH_OUTPUT_MAX_BYTES).await
    {
        let statuses = status
            .get("statuses")
            .and_then(Value::as_array)
            .map(|items| items.as_slice())
            .unwrap_or(&[]);
        for (index, item) in statuses.iter().enumerate() {
            ci_items.push(ReviewPlatformCiItem {
                id: format!(
                    "status-{}",
                    first_non_empty(&[value_string(item, "id"), index.to_string()])
                ),
                name: first_non_empty(&[
                    value_string(item, "context"),
                    value_string(item, "description"),
                    "Status".to_string(),
                ]),
                status: value_string(item, "state"),
                conclusion: None,
                detail: optional_string(item, "description"),
                stage: None,
                web_url: optional_string(item, "target_url"),
                log: None,
                log_truncated: false,
                started_at: None,
                finished_at: None,
            });
        }
    }

    let check_runs_url = format!(
        "{}/repos/{}/{}/commits/{}/check-runs",
        ctx.api_base_url, ctx.remote.owner, ctx.remote.repository_name, sha
    );
    if let Ok(check_runs) = github_api_get_json(
        ctx,
        &check_runs_url,
        &[("per_page".to_string(), "100".to_string())],
        DEFAULT_GH_OUTPUT_MAX_BYTES,
    )
    .await
    {
        for (index, item) in check_runs
            .get("check_runs")
            .and_then(Value::as_array)
            .map(|items| items.as_slice())
            .unwrap_or(&[])
            .iter()
            .enumerate()
        {
            ci_items.push(ReviewPlatformCiItem {
                id: format!(
                    "check-run-{}",
                    first_non_empty(&[value_string(item, "id"), index.to_string()])
                ),
                name: first_non_empty(&[value_string(item, "name"), "Check run".to_string()]),
                status: value_string(item, "status"),
                conclusion: optional_string(item, "conclusion"),
                detail: nested_optional_string(item, &["output", "summary"])
                    .or_else(|| nested_optional_string(item, &["output", "text"]))
                    .or_else(|| optional_string(item, "details_url")),
                stage: None,
                web_url: optional_string(item, "html_url")
                    .or_else(|| optional_string(item, "details_url")),
                log: None,
                log_truncated: false,
                started_at: optional_string(item, "started_at"),
                finished_at: optional_string(item, "completed_at"),
            });
        }
    }

    let checks = summarize_ci_items(&ci_items);
    (checks, ci_items)
}

async fn github_actions_jobs_for_head_sha(ctx: &ProviderContext, sha: &str) -> Vec<Value> {
    let runs_url = format!(
        "{}/repos/{}/{}/actions/runs",
        ctx.api_base_url, ctx.remote.owner, ctx.remote.repository_name
    );
    let runs = match github_api_get_json(
        ctx,
        &runs_url,
        &[
            ("head_sha".to_string(), sha.to_string()),
            ("per_page".to_string(), "100".to_string()),
        ],
        DEFAULT_GH_OUTPUT_MAX_BYTES,
    )
    .await
    {
        Ok(value) => value,
        Err(_) => return Vec::new(),
    };

    let mut jobs = Vec::new();
    for run in runs
        .get("workflow_runs")
        .and_then(Value::as_array)
        .map(|items| items.as_slice())
        .unwrap_or(&[])
    {
        let run_id = value_string(run, "id");
        if run_id.trim().is_empty() {
            continue;
        }
        let jobs_url = format!(
            "{}/repos/{}/{}/actions/runs/{}/jobs",
            ctx.api_base_url, ctx.remote.owner, ctx.remote.repository_name, run_id
        );
        if let Ok(value) = github_api_get_json(
            ctx,
            &jobs_url,
            &[("per_page".to_string(), "100".to_string())],
            DEFAULT_GH_OUTPUT_MAX_BYTES,
        )
        .await
        {
            jobs.extend(
                value
                    .get("jobs")
                    .and_then(Value::as_array)
                    .map(|items| items.as_slice())
                    .unwrap_or(&[])
                    .iter()
                    .cloned(),
            );
        }
    }

    jobs
}

async fn github_actions_log_for_check_run_item(
    ctx: &ProviderContext,
    check_run_id: &str,
    check_run_name: &str,
    head_sha: &str,
) -> Result<ReviewPlatformCiLog, ReviewPlatformError> {
    let action_jobs = github_actions_jobs_for_head_sha(ctx, head_sha).await;
    let check_run = action_jobs
        .iter()
        .find(|job| {
            let check_run_url = value_string(job, "check_run_url");
            check_run_url.ends_with(&format!("/check-runs/{}", check_run_id))
                || value_string(job, "name") == check_run_name
        })
        .cloned();

    let Some(job) = check_run else {
        return Ok(ReviewPlatformCiLog {
            ci_item_id: format!("check-run-{}", check_run_id),
            log: None,
            truncated: false,
            message: Some(
                "No matching GitHub Actions job was found for this check run.".to_string(),
            ),
        });
    };

    let job_id = value_string(&job, "id");
    if job_id.trim().is_empty() {
        return Ok(ReviewPlatformCiLog {
            ci_item_id: format!("check-run-{}", check_run_id),
            log: None,
            truncated: false,
            message: Some("The matching GitHub Actions job does not expose a job id.".to_string()),
        });
    }

    let logs_url = format!(
        "{}/repos/{}/{}/actions/jobs/{}/logs",
        ctx.api_base_url, ctx.remote.owner, ctx.remote.repository_name, job_id
    );
    let response = github_api_get_text(ctx, &logs_url, 1024 * 1024).await?;
    let (log, truncated) = ci_log_value_from_response(response);
    let message = if truncated {
        Some("GitHub Actions job log evidence was truncated to the Review budget.".to_string())
    } else {
        log.as_ref()
            .is_none()
            .then_some("No error lines were detected in the GitHub Actions job log.".to_string())
    };
    Ok(ReviewPlatformCiLog {
        ci_item_id: format!("check-run-{}", check_run_id),
        log,
        truncated,
        message,
    })
}

fn gitlab_pipeline_summary_item(detail: &Value) -> Option<ReviewPlatformCiItem> {
    let pipeline = detail.get("head_pipeline")?;
    let status = value_string(pipeline, "status");
    if status.trim().is_empty() {
        return None;
    }
    Some(ReviewPlatformCiItem {
        id: first_non_empty(&[
            value_string(pipeline, "id"),
            value_string(pipeline, "iid"),
            "head-pipeline".to_string(),
        ]),
        name: "Pipeline".to_string(),
        status,
        conclusion: None,
        detail: nested_optional_string(pipeline, &["detailed_status", "text"])
            .or_else(|| nested_optional_string(pipeline, &["detailed_status", "label"])),
        stage: None,
        web_url: optional_string(pipeline, "web_url"),
        log: None,
        log_truncated: false,
        started_at: optional_string(pipeline, "started_at"),
        finished_at: optional_string(pipeline, "finished_at"),
    })
}

async fn gitlab_pipeline_jobs(
    ctx: &ProviderContext,
    client: ReviewHttpClient,
    project: &str,
    pipeline_id: &str,
) -> Vec<ReviewPlatformCiItem> {
    let jobs_url = format!(
        "{}/projects/{}/pipelines/{}/jobs",
        ctx.api_base_url, project, pipeline_id
    );
    if let Ok(response) = fetch_paginated_array(
        |page| {
            let page = page.to_string();
            gitlab_request(client.clone(), &jobs_url, ctx.token.as_deref())
                .query(&[("per_page", "100"), ("page", &page)])
        },
        gitlab_next_page,
    )
    .await
    {
        let mut jobs = Vec::new();
        for (index, job) in array_items(&response).iter().enumerate() {
            let provider_id = value_string(job, "id");
            let id = first_non_empty(&[provider_id.clone(), index.to_string()]);
            jobs.push(ReviewPlatformCiItem {
                id,
                name: first_non_empty(&[value_string(job, "name"), "Job".to_string()]),
                status: value_string(job, "status"),
                conclusion: None,
                detail: optional_string(job, "failure_reason"),
                stage: optional_string(job, "stage"),
                web_url: optional_string(job, "web_url"),
                log: None,
                log_truncated: false,
                started_at: optional_string(job, "started_at"),
                finished_at: optional_string(job, "finished_at"),
            });
        }
        return jobs;
    }
    Vec::new()
}

async fn gitlab_job_trace(
    ctx: &ProviderContext,
    client: ReviewHttpClient,
    project: &str,
    job_id: &str,
) -> Result<(Option<String>, bool), ReviewPlatformError> {
    if job_id.trim().is_empty() {
        return Err(ReviewPlatformError::Api(
            "GitLab job id is required".to_string(),
        ));
    }
    let trace_url = format!(
        "{}/projects/{}/jobs/{}/trace",
        ctx.api_base_url, project, job_id
    );
    let response = send_bounded_text(
        gitlab_request(client, &trace_url, ctx.token.as_deref()),
        MAX_GITLAB_CI_TRACE_BYTES,
    )
    .await?;
    Ok(ci_log_value_from_response(response))
}

async fn gitlab_pull_request_ci_log(
    ctx: &ProviderContext,
    _pull_request_id: &str,
    ci_item_id: &str,
    _ci_item_name: &str,
) -> Result<ReviewPlatformCiLog, ReviewPlatformError> {
    if ci_item_id == "head-pipeline" || ci_item_id == "pipeline" {
        return Ok(ReviewPlatformCiLog {
            ci_item_id: ci_item_id.to_string(),
            log: None,
            truncated: false,
            message: Some("Pipeline summaries do not expose a separate job trace.".to_string()),
        });
    }

    let client = http_client()?;
    let project = urlencoding::encode(&ctx.remote.project_path).to_string();
    let (log, truncated) = gitlab_job_trace(ctx, client, &project, ci_item_id).await?;
    let message = if truncated {
        Some("GitLab job trace evidence was truncated to the Review budget.".to_string())
    } else {
        log.as_ref()
            .is_none()
            .then_some("No error lines were detected in the job trace.".to_string())
    };
    Ok(ReviewPlatformCiLog {
        ci_item_id: ci_item_id.to_string(),
        log,
        truncated,
        message,
    })
}

fn gitcode_ci_items(detail: &Value) -> Vec<ReviewPlatformCiItem> {
    let mut items = Vec::new();
    let pipeline_status = first_non_empty(&[
        value_string(detail, "pipeline_status"),
        value_string(detail, "pipeline_status_with_code_quality"),
    ]);
    if !pipeline_status.trim().is_empty() {
        items.push(ReviewPlatformCiItem {
            id: first_non_empty(&[
                value_string(detail, "head_pipeline_id"),
                "pipeline".to_string(),
            ]),
            name: "Pipeline".to_string(),
            status: pipeline_status,
            conclusion: None,
            detail: optional_string(detail, "pipeline_status_with_code_quality"),
            stage: None,
            web_url: optional_string(detail, "web_url")
                .or_else(|| optional_string(detail, "html_url")),
            log: None,
            log_truncated: false,
            started_at: None,
            finished_at: None,
        });
    }

    let codequality_status = value_string(detail, "codequality_status");
    if !codequality_status.trim().is_empty() {
        items.push(ReviewPlatformCiItem {
            id: first_non_empty(&[
                format!("{}-codequality", value_string(detail, "head_pipeline_id")),
                "codequality".to_string(),
            ]),
            name: "Code quality".to_string(),
            status: codequality_status,
            conclusion: None,
            detail: None,
            stage: None,
            web_url: optional_string(detail, "web_url")
                .or_else(|| optional_string(detail, "html_url")),
            log: None,
            log_truncated: false,
            started_at: None,
            finished_at: None,
        });
    }

    items
}

fn parse_remote(
    remote_name: &str,
    remote_url: &str,
    auth_tokens: &ReviewPlatformAuthTokens,
) -> Option<ReviewPlatformRemote> {
    let parsed = parse_remote_url(remote_url)?;
    let host = normalize_provider_host(&parsed.host).ok()?;
    let platform = match host.as_str() {
        "github.com" => ReviewPlatformKind::Github,
        "gitlab.com" => ReviewPlatformKind::Gitlab,
        "gitcode.com" => ReviewPlatformKind::Gitcode,
        "gitee.com" => ReviewPlatformKind::Gitee,
        _ => auth_tokens
            .registered_platform_for_host(&host)
            .unwrap_or(ReviewPlatformKind::Unknown),
    };

    let segments: Vec<&str> = parsed
        .path
        .trim_matches('/')
        .split('/')
        .filter(|segment| !segment.is_empty())
        .collect();
    if segments.len() < 2 {
        return None;
    }
    let owner = segments.first()?.to_string();
    let repository_name = segments.last()?.trim_end_matches(".git").to_string();
    let project_path = segments
        .iter()
        .map(|segment| segment.trim_end_matches(".git"))
        .collect::<Vec<_>>()
        .join("/");

    let supported = platform != ReviewPlatformKind::Unknown;
    let (auth_state, auth_source) = auth_for_platform_host(platform, &host, auth_tokens);
    let web_url = format!("{}://{}/{}", parsed.scheme, host, project_path);

    Some(ReviewPlatformRemote {
        id: format!(
            "{}:{}:{}",
            remote_name,
            platform.as_str(),
            project_path.replace('/', "__")
        ),
        name: remote_name.to_string(),
        url: sanitize_remote_url(remote_url),
        platform,
        host,
        owner,
        repository_name,
        project_path,
        web_url,
        supported,
        auth_state,
        auth_source,
        message: if !supported {
            Some("This remote is detected, but no provider adapter is available yet.".to_string())
        } else if platform == ReviewPlatformKind::Gitcode
            && auth_state == ReviewAuthState::NotConnected
        {
            Some("Add a GitCode token to load pull requests.".to_string())
        } else {
            None
        },
    })
}

#[derive(Debug)]
struct ParsedRemoteUrl {
    scheme: String,
    host: String,
    path: String,
}

fn parse_remote_url(remote_url: &str) -> Option<ParsedRemoteUrl> {
    if let Some(scheme_end) = remote_url.find("://") {
        let scheme = &remote_url[..scheme_end];
        let rest = &remote_url[scheme_end + 3..];
        let slash = rest.find('/')?;
        let authority = &rest[..slash];
        let host_part = authority.rsplit('@').next().unwrap_or(authority);
        let host = host_part.split(':').next().unwrap_or(host_part);
        let path = rest[slash + 1..].trim_end_matches(".git").to_string();
        return Some(ParsedRemoteUrl {
            scheme: if scheme == "ssh" { "https" } else { scheme }.to_string(),
            host: host.to_string(),
            path,
        });
    }

    if let Some((user_host, path)) = remote_url.split_once(':') {
        if user_host.contains('@') && !path.contains('\\') {
            let host = user_host.rsplit('@').next()?.to_string();
            return Some(ParsedRemoteUrl {
                scheme: "https".to_string(),
                host,
                path: path.trim_end_matches(".git").to_string(),
            });
        }
    }

    None
}

fn remote_url_matches_provider_identity(
    remote_url: &str,
    platform: ReviewPlatformKind,
    host: &str,
    project_path: &str,
) -> bool {
    let Some(remote) = parse_remote_url(remote_url) else {
        return false;
    };
    normalize_provider_host(&remote.host).ok().as_deref() == Some(host)
        && normalize_project_path(platform, &remote.path)
            .ok()
            .as_deref()
            == Some(project_path)
}

fn sanitize_remote_url(remote_url: &str) -> String {
    if let Some(scheme_end) = remote_url.find("://") {
        let scheme = &remote_url[..scheme_end];
        let rest = &remote_url[scheme_end + 3..];
        if let Some(slash) = rest.find('/') {
            let authority = &rest[..slash];
            if authority.contains('@') {
                let host = authority.rsplit('@').next().unwrap_or(authority);
                return format!("{}://{}/{}", scheme, host, &rest[slash + 1..]);
            }
        }
    }
    remote_url.to_string()
}

fn map_github_issue(
    identity: &ProviderIssueIdentity,
    issue: &Value,
    comments: &Value,
    pagination: IssuePagination,
    provider_has_more: bool,
    provider_next_cursor: Option<String>,
) -> Result<ReviewPlatformIssueEvidence, ReviewPlatformError> {
    if identity.platform != ReviewPlatformKind::Github {
        return Err(ReviewPlatformError::UnsupportedPlatform(
            platform_label(identity.platform).to_string(),
        ));
    }
    reject_pull_request_issue_target(identity, issue)?;
    ensure_provider_item_identity(identity, issue, "number")?;
    let comment_values = comments.as_array().ok_or_else(|| {
        ReviewPlatformError::Parse("GitHub Issue comments response was not an array".to_string())
    })?;
    let labels = array_items(issue.get("labels").unwrap_or(&Value::Null))
        .iter()
        .filter_map(|label| {
            label
                .as_str()
                .map(str::to_string)
                .or_else(|| optional_string(label, "name"))
        })
        .collect::<Vec<_>>();
    let comments = comment_values
        .iter()
        .map(|comment| ReviewPlatformIssueComment {
            id: value_string(comment, "id"),
            web_url: optional_string(comment, "html_url"),
            author: nested_optional_string(comment, &["user", "login"]),
            body: value_string(comment, "body"),
            created_at: optional_string(comment, "created_at"),
            updated_at: optional_string(comment, "updated_at"),
        })
        .collect::<Vec<_>>();
    finalize_issue_mapping(
        identity,
        first_non_empty(&[
            value_string(issue, "html_url"),
            format!(
                "https://{}/{}/issues/{}",
                identity.host, identity.project_path, identity.issue_id
            ),
        ]),
        value_string(issue, "title"),
        bounded_issue_body(issue, "body")?,
        value_string(issue, "state"),
        nested_optional_string(issue, &["user", "login"]),
        labels,
        optional_string(issue, "created_at"),
        optional_string(issue, "updated_at"),
        comments,
        pagination,
        provider_has_more,
        provider_next_cursor,
    )
}

fn reject_pull_request_issue_target(
    identity: &ProviderIssueIdentity,
    issue: &Value,
) -> Result<(), ReviewPlatformError> {
    if identity.platform == ReviewPlatformKind::Github && issue.get("pull_request").is_some() {
        return Err(ReviewPlatformError::TargetIsPullRequest {
            issue_id: identity.issue_id.clone(),
        });
    }
    Ok(())
}

fn map_gitlab_issue(
    identity: &ProviderIssueIdentity,
    issue: &Value,
    comments: &Value,
    pagination: IssuePagination,
    provider_has_more: bool,
    provider_next_cursor: Option<String>,
) -> Result<ReviewPlatformIssueEvidence, ReviewPlatformError> {
    if identity.platform != ReviewPlatformKind::Gitlab {
        return Err(ReviewPlatformError::UnsupportedPlatform(
            platform_label(identity.platform).to_string(),
        ));
    }
    ensure_provider_item_identity(identity, issue, "iid")?;
    let comment_values = comments.as_array().ok_or_else(|| {
        ReviewPlatformError::Parse("GitLab Issue notes response was not an array".to_string())
    })?;
    let labels = array_items(issue.get("labels").unwrap_or(&Value::Null))
        .iter()
        .filter_map(Value::as_str)
        .map(str::to_string)
        .collect::<Vec<_>>();
    let comments = comment_values
        .iter()
        .filter(|comment| !value_bool(comment, "system"))
        .map(|comment| ReviewPlatformIssueComment {
            id: value_string(comment, "id"),
            web_url: optional_string(comment, "web_url"),
            author: nested_optional_string(comment, &["author", "username"]),
            body: value_string(comment, "body"),
            created_at: optional_string(comment, "created_at"),
            updated_at: optional_string(comment, "updated_at"),
        })
        .collect::<Vec<_>>();
    finalize_issue_mapping(
        identity,
        first_non_empty(&[
            value_string(issue, "web_url"),
            format!(
                "https://{}/{}/-/issues/{}",
                identity.host, identity.project_path, identity.issue_id
            ),
        ]),
        value_string(issue, "title"),
        bounded_issue_body(issue, "description")?,
        value_string(issue, "state"),
        nested_optional_string(issue, &["author", "username"]),
        labels,
        optional_string(issue, "created_at"),
        optional_string(issue, "updated_at"),
        comments,
        pagination,
        provider_has_more,
        provider_next_cursor,
    )
}

#[allow(clippy::too_many_arguments)]
fn finalize_issue_mapping(
    identity: &ProviderIssueIdentity,
    web_url: String,
    title: String,
    body: String,
    state: String,
    author: Option<String>,
    mut labels: Vec<String>,
    created_at: Option<String>,
    updated_at: Option<String>,
    mut comments: Vec<ReviewPlatformIssueComment>,
    pagination: IssuePagination,
    provider_has_more: bool,
    provider_next_cursor: Option<String>,
) -> Result<ReviewPlatformIssueEvidence, ReviewPlatformError> {
    labels.sort_unstable();
    labels.dedup();
    comments.sort_by(|left, right| {
        left.created_at
            .as_deref()
            .unwrap_or_default()
            .cmp(right.created_at.as_deref().unwrap_or_default())
            .then_with(|| left.id.cmp(&right.id))
    });
    let page_was_bounded = comments.len() > pagination.per_page as usize;
    let mut comments = comments
        .into_iter()
        .take(pagination.per_page as usize)
        .collect::<Vec<_>>();
    let mut comment_body_truncated = false;
    for comment in &mut comments {
        if comment.body.chars().count() > MAX_ISSUE_COMMENT_BODY_CHARS {
            comment.body = comment
                .body
                .chars()
                .take(MAX_ISSUE_COMMENT_BODY_CHARS)
                .collect();
            comment_body_truncated = true;
        }
    }
    let mut aggregate_chars = 0usize;
    let mut aggregate_truncated = false;
    let mut bounded_comments = Vec::with_capacity(comments.len());
    for mut comment in comments {
        let body_chars = comment.body.chars().count();
        let remaining = MAX_ISSUE_COMMENTS_AGGREGATE_CHARS.saturating_sub(aggregate_chars);
        if remaining == 0 {
            aggregate_truncated = true;
            break;
        }
        if body_chars > remaining {
            comment.body = comment.body.chars().take(remaining).collect();
            bounded_comments.push(comment);
            aggregate_truncated = true;
            break;
        }
        aggregate_chars = aggregate_chars.saturating_add(body_chars);
        bounded_comments.push(comment);
    }
    let comments = bounded_comments;
    let has_more_comments = provider_has_more || page_was_bounded;
    let next_cursor = provider_next_cursor
        .filter(|cursor| !cursor.trim().is_empty())
        .or_else(|| has_more_comments.then(|| pagination.page.saturating_add(1).to_string()));
    let mut limitations = Vec::new();
    if provider_has_more {
        limitations.push("issue_comments_paginated".to_string());
    }
    if page_was_bounded {
        limitations.push("issue_comments_page_bounded".to_string());
    }
    if comment_body_truncated {
        limitations.push("issue_comment_body_truncated".to_string());
    }
    if aggregate_truncated {
        limitations.push("issue_comments_aggregate_truncated".to_string());
    }
    if pagination.page > 1 {
        limitations.push("issue_comments_previous_pages_omitted".to_string());
    }
    let completeness = if has_more_comments
        || pagination.page > 1
        || comment_body_truncated
        || aggregate_truncated
    {
        ReviewEvidenceCompleteness::Partial
    } else {
        ReviewEvidenceCompleteness::Complete
    };
    let mut evidence = ReviewPlatformIssueEvidence {
        platform: identity.platform,
        host: identity.host.clone(),
        project_path: identity.project_path.clone(),
        issue_id: identity.issue_id.clone(),
        web_url,
        title,
        body,
        state,
        author,
        labels,
        created_at,
        updated_at,
        comments,
        fingerprint: String::new(),
        completeness,
        limitations,
        has_more_comments,
        next_cursor,
    };
    evidence.fingerprint = issue_fingerprint(&evidence, pagination);
    Ok(evidence)
}

fn bounded_issue_body(value: &Value, key: &str) -> Result<String, ReviewPlatformError> {
    let body = value_string(value, key);
    if body.chars().count() > MAX_ISSUE_BODY_CHARS {
        return Err(ReviewPlatformError::EvidenceTooLarge {
            resource: "issue_body".to_string(),
            limit: MAX_ISSUE_BODY_CHARS,
        });
    }
    Ok(body)
}

fn ensure_provider_item_identity(
    identity: &ProviderIssueIdentity,
    value: &Value,
    provider_id_field: &str,
) -> Result<(), ReviewPlatformError> {
    let provider_id = value_string(value, provider_id_field);
    if !provider_id.is_empty() && provider_id != identity.issue_id {
        return Err(ReviewPlatformError::Parse(format!(
            "Provider returned Issue {provider_id} for requested Issue {}",
            identity.issue_id
        )));
    }
    Ok(())
}

fn issue_fingerprint(
    evidence: &ReviewPlatformIssueEvidence,
    pagination: IssuePagination,
) -> String {
    fn hash_field(hasher: &mut Sha256, value: &str) {
        hasher.update((value.len() as u64).to_le_bytes());
        hasher.update(value.as_bytes());
    }

    let mut hasher = Sha256::new();
    hash_field(&mut hasher, "review-platform-issue-v1");
    for value in [
        evidence.platform.as_str(),
        &evidence.host,
        &evidence.project_path,
        &evidence.issue_id,
        &evidence.web_url,
        &evidence.title,
        &evidence.body,
        &evidence.state,
        evidence.author.as_deref().unwrap_or_default(),
        evidence.created_at.as_deref().unwrap_or_default(),
        evidence.updated_at.as_deref().unwrap_or_default(),
    ] {
        hash_field(&mut hasher, value);
    }
    hash_field(&mut hasher, &evidence.labels.len().to_string());
    for label in &evidence.labels {
        hash_field(&mut hasher, label);
    }
    hash_field(&mut hasher, &evidence.comments.len().to_string());
    for comment in &evidence.comments {
        for value in [
            comment.id.as_str(),
            comment.web_url.as_deref().unwrap_or_default(),
            comment.author.as_deref().unwrap_or_default(),
            comment.body.as_str(),
            comment.created_at.as_deref().unwrap_or_default(),
            comment.updated_at.as_deref().unwrap_or_default(),
        ] {
            hash_field(&mut hasher, value);
        }
    }
    hash_field(&mut hasher, &pagination.page.to_string());
    hash_field(&mut hasher, &pagination.per_page.to_string());
    hash_field(
        &mut hasher,
        match evidence.completeness {
            ReviewEvidenceCompleteness::Complete => "complete",
            ReviewEvidenceCompleteness::Partial => "partial",
        },
    );
    hash_field(&mut hasher, &evidence.limitations.len().to_string());
    for limitation in &evidence.limitations {
        hash_field(&mut hasher, limitation);
    }
    hash_field(
        &mut hasher,
        if evidence.has_more_comments {
            "has_more"
        } else {
            "no_more"
        },
    );
    hash_field(
        &mut hasher,
        evidence.next_cursor.as_deref().unwrap_or_default(),
    );
    let digest = hasher.finalize();
    let hex = digest
        .iter()
        .map(|byte| format!("{byte:02x}"))
        .collect::<String>();
    format!("sha256:{hex}")
}

fn github_pull_request_from_value(value: &Value) -> ReviewPlatformPullRequest {
    let number = value_i64(value, "number");
    let state = if value_bool(value, "draft") {
        ReviewItemState::Draft
    } else if !value_string(value, "merged_at").is_empty() {
        ReviewItemState::Merged
    } else {
        match value_string(value, "state").as_str() {
            "closed" => ReviewItemState::Closed,
            _ => ReviewItemState::Open,
        }
    };

    ReviewPlatformPullRequest {
        id: number.to_string(),
        provider_id: None,
        number,
        title: value_string(value, "title"),
        state,
        author: nested_string(value, &["user", "login"]),
        source_branch: nested_string(value, &["head", "ref"]),
        target_branch: nested_string(value, &["base", "ref"]),
        base_revision: non_empty_option(nested_string(value, &["base", "sha"])),
        head_revision: non_empty_option(nested_string(value, &["head", "sha"])),
        updated_at: value_string(value, "updated_at"),
        web_url: value_string(value, "html_url"),
        additions: value_i64(value, "additions") as i32,
        deletions: value_i64(value, "deletions") as i32,
        changed_files: value_i64(value, "changed_files") as i32,
        line_stats_known: None,
        changed_file_count_known: true,
        comments: (value_i64(value, "comments") + value_i64(value, "review_comments")) as i32,
        review_decision: ReviewDecision::Pending,
        checks: empty_checks(),
    }
}

fn gitlab_pull_request_from_value(value: &Value) -> ReviewPlatformPullRequest {
    let number = value_i64(value, "iid");
    let state = if value_bool(value, "draft") || value_bool(value, "work_in_progress") {
        ReviewItemState::Draft
    } else {
        match value_string(value, "state").as_str() {
            "merged" => ReviewItemState::Merged,
            "closed" => ReviewItemState::Closed,
            _ => ReviewItemState::Open,
        }
    };
    let changed_files = value_string(value, "changes_count")
        .trim_end_matches('+')
        .parse::<i32>()
        .unwrap_or(0);

    ReviewPlatformPullRequest {
        id: number.to_string(),
        provider_id: None,
        number,
        title: value_string(value, "title"),
        state,
        author: first_non_empty(&[
            nested_string(value, &["author", "username"]),
            nested_string(value, &["author", "name"]),
        ]),
        source_branch: value_string(value, "source_branch"),
        target_branch: value_string(value, "target_branch"),
        base_revision: non_empty_option(first_non_empty(&[
            nested_string(value, &["diff_refs", "base_sha"]),
            value_string(value, "base_sha"),
        ])),
        head_revision: non_empty_option(first_non_empty(&[
            nested_string(value, &["diff_refs", "head_sha"]),
            value_string(value, "sha"),
            value_string(value, "head_sha"),
        ])),
        updated_at: value_string(value, "updated_at"),
        web_url: value_string(value, "web_url"),
        additions: 0,
        deletions: 0,
        line_stats_known: None,
        changed_files,
        changed_file_count_known: true,
        comments: value_i64(value, "user_notes_count") as i32,
        review_decision: ReviewDecision::Pending,
        checks: empty_checks(),
    }
}

fn gitcode_pull_request_from_value(value: &Value) -> ReviewPlatformPullRequest {
    let number = first_non_zero(&[value_i64(value, "number"), value_i64(value, "id")]);
    let state = match value_string(value, "state").as_str() {
        "merged" => ReviewItemState::Merged,
        "closed" => ReviewItemState::Closed,
        _ => ReviewItemState::Open,
    };
    let changes_count = value_string(value, "changes_count");
    let changes_count = changes_count.trim();
    let changes_count_is_approximate = changes_count.ends_with('+');
    let changed_files_from_changes_count = changes_count.trim_end_matches('+').parse::<i32>().ok();
    let changed_files_from_legacy_field = value.get("changed_files").and_then(|count| {
        count
            .as_i64()
            .or_else(|| count.as_str()?.parse::<i64>().ok())
            .and_then(|count| i32::try_from(count).ok())
    });
    let changed_files = changed_files_from_changes_count.or(changed_files_from_legacy_field);
    let changed_file_count_known = changed_files.is_some()
        && !(changed_files_from_changes_count.is_some() && changes_count_is_approximate);
    ReviewPlatformPullRequest {
        id: number.to_string(),
        provider_id: None,
        number,
        title: value_string(value, "title"),
        state,
        author: first_non_empty(&[
            nested_string(value, &["user", "login"]),
            nested_string(value, &["user", "name"]),
            nested_string(value, &["author", "login"]),
        ]),
        source_branch: first_non_empty(&[
            nested_string(value, &["head", "ref"]),
            value_string(value, "head_branch"),
        ]),
        target_branch: first_non_empty(&[
            nested_string(value, &["base", "ref"]),
            value_string(value, "base_branch"),
        ]),
        base_revision: non_empty_option(first_non_empty(&[
            nested_string(value, &["base", "sha"]),
            value_string(value, "base_sha"),
        ])),
        head_revision: non_empty_option(first_non_empty(&[
            nested_string(value, &["head", "sha"]),
            value_string(value, "head_sha"),
            value_string(value, "sha"),
        ])),
        updated_at: value_string(value, "updated_at"),
        web_url: first_non_empty(&[
            value_string(value, "html_url"),
            value_string(value, "web_url"),
        ]),
        additions: gitcode_pull_request_line_count(value, "added_lines", "additions"),
        deletions: gitcode_pull_request_line_count(value, "removed_lines", "deletions"),
        line_stats_known: None,
        changed_files: changed_files.unwrap_or(0),
        changed_file_count_known,
        comments: value_i64(value, "comments") as i32,
        review_decision: ReviewDecision::Pending,
        checks: empty_checks(),
    }
}

fn gitcode_pull_request_line_count(
    value: &Value,
    documented_field: &str,
    legacy_field: &str,
) -> i32 {
    if value.get(documented_field).is_some() {
        value_i64(value, documented_field) as i32
    } else {
        value_i64(value, legacy_field) as i32
    }
}

fn github_file_from_value(value: &Value) -> ReviewPlatformFile {
    ReviewPlatformFile {
        path: value_string(value, "filename"),
        old_path: value
            .get("previous_filename")
            .and_then(Value::as_str)
            .map(str::to_string),
        status: file_status(&value_string(value, "status")),
        additions: value_i64(value, "additions") as i32,
        deletions: value_i64(value, "deletions") as i32,
        patch: optional_string(value, "patch"),
    }
}

fn gitcode_file_from_value(value: &Value) -> ReviewPlatformFile {
    ReviewPlatformFile {
        path: first_non_empty(&[
            value_string(value, "filename"),
            value_string(value, "new_path"),
        ]),
        old_path: optional_string(value, "old_path")
            .or_else(|| optional_string(value, "previous_filename")),
        status: gitcode_file_status(value),
        additions: value_i64(value, "additions") as i32,
        deletions: value_i64(value, "deletions") as i32,
        patch: gitcode_patch_from_value(value),
    }
}

fn gitcode_file_status(value: &Value) -> ReviewFileStatus {
    if value_bool(value, "new_file") {
        ReviewFileStatus::Added
    } else if value_bool(value, "deleted_file") {
        ReviewFileStatus::Deleted
    } else if value_bool(value, "renamed_file") {
        ReviewFileStatus::Renamed
    } else {
        file_status(&value_string(value, "status"))
    }
}

fn gitcode_patch_from_value(value: &Value) -> Option<String> {
    optional_string(value, "patch")
        .or_else(|| {
            value
                .get("patch")
                .and_then(|patch| optional_string(patch, "diff"))
        })
        .or_else(|| optional_string(value, "diff"))
}

fn gitlab_files(value: &Value) -> Vec<ReviewPlatformFile> {
    value
        .get("changes")
        .and_then(Value::as_array)
        .unwrap_or(&Vec::new())
        .iter()
        .map(gitlab_file_from_value)
        .collect()
}

fn gitlab_file_from_value(change: &Value) -> ReviewPlatformFile {
    let diff = value_string(change, "diff");
    let (additions, deletions) = count_diff_lines(&diff);
    let status = if value_bool(change, "new_file") {
        ReviewFileStatus::Added
    } else if value_bool(change, "deleted_file") {
        ReviewFileStatus::Deleted
    } else if value_bool(change, "renamed_file") {
        ReviewFileStatus::Renamed
    } else {
        ReviewFileStatus::Modified
    };
    let diff_available = !diff.trim().is_empty()
        && !value_bool(change, "collapsed")
        && !value_bool(change, "too_large");
    ReviewPlatformFile {
        path: value_string(change, "new_path"),
        old_path: change
            .get("old_path")
            .and_then(Value::as_str)
            .map(str::to_string),
        status,
        additions,
        deletions,
        patch: diff_available.then_some(diff),
    }
}

fn github_commit_from_value(value: &Value) -> ReviewPlatformCommit {
    let hash = value_string(value, "sha");
    ReviewPlatformCommit {
        short_hash: short_hash(&hash),
        hash,
        title: first_line(&nested_string(value, &["commit", "message"])),
        author: first_non_empty(&[
            nested_string(value, &["author", "login"]),
            nested_string(value, &["commit", "author", "name"]),
        ]),
        committed_at: nested_string(value, &["commit", "author", "date"]),
    }
}

fn gitlab_commit_from_value(value: &Value) -> ReviewPlatformCommit {
    let hash = value_string(value, "id");
    ReviewPlatformCommit {
        short_hash: first_non_empty(&[value_string(value, "short_id"), short_hash(&hash)]),
        hash,
        title: first_non_empty(&[
            value_string(value, "title"),
            first_line(&value_string(value, "message")),
        ]),
        author: value_string(value, "author_name"),
        committed_at: first_non_empty(&[
            value_string(value, "committed_date"),
            value_string(value, "created_at"),
        ]),
    }
}

fn gitcode_commit_from_value(value: &Value) -> ReviewPlatformCommit {
    let hash = first_non_empty(&[value_string(value, "sha"), value_string(value, "id")]);
    ReviewPlatformCommit {
        short_hash: short_hash(&hash),
        hash,
        title: first_non_empty(&[
            nested_string(value, &["commit", "message"])
                .lines()
                .next()
                .unwrap_or_default()
                .to_string(),
            value_string(value, "message"),
        ]),
        author: first_non_empty(&[
            nested_string(value, &["author", "login"]),
            nested_string(value, &["commit", "author", "name"]),
        ]),
        committed_at: first_non_empty(&[
            nested_string(value, &["commit", "author", "date"]),
            value_string(value, "created_at"),
        ]),
    }
}

fn github_review_decision(reviews: &Value) -> ReviewDecision {
    let mut latest_by_author: HashMap<String, String> = HashMap::new();
    let mut anonymous_states = Vec::new();
    for review in array_items(reviews) {
        let state = value_string(review, "state");
        if state == "DISMISSED" || state.trim().is_empty() {
            continue;
        }
        let author = nested_string(review, &["user", "login"]);
        if author.trim().is_empty() {
            anonymous_states.push(state);
        } else {
            latest_by_author.insert(author, state);
        }
    }

    let states = latest_by_author
        .values()
        .chain(anonymous_states.iter())
        .map(String::as_str)
        .collect::<Vec<_>>();

    if states.contains(&"CHANGES_REQUESTED") {
        return ReviewDecision::ChangesRequested;
    }
    if states.contains(&"APPROVED") {
        return ReviewDecision::Approved;
    }
    if states.contains(&"COMMENTED") {
        return ReviewDecision::Commented;
    }
    ReviewDecision::Pending
}

fn github_threads(
    reviews: &Value,
    review_comments: &Value,
    issue_comments: &Value,
) -> Vec<ReviewPlatformThread> {
    let mut threads = Vec::new();
    for review in array_items(reviews) {
        let body = github_review_body(review);
        threads.push(ReviewPlatformThread {
            id: format!("review-{}", value_i64(review, "id")),
            provider_thread_id: None,
            provider_comment_id: value_i64(review, "id")
                .checked_abs()
                .map(|id| id.to_string()),
            kind: ReviewPlatformThreadKind::Review,
            reply_to_provider_comment_id: None,
            file_path: None,
            line: None,
            resolved: false,
            author: nested_string(review, &["user", "login"]),
            body,
            updated_at: first_non_empty(&[
                value_string(review, "submitted_at"),
                value_string(review, "updated_at"),
            ]),
        });
    }
    for comment in array_items(review_comments) {
        threads.push(github_thread_from_review_comment(comment));
    }
    for comment in array_items(issue_comments) {
        threads.push(github_thread_from_issue_comment(comment));
    }
    threads
}

fn github_review_body(review: &Value) -> String {
    let body = value_string(review, "body");
    if !body.trim().is_empty() {
        return body;
    }
    match value_string(review, "state").as_str() {
        "APPROVED" => "Approved this pull request.".to_string(),
        "CHANGES_REQUESTED" => "Requested changes.".to_string(),
        "COMMENTED" => "Submitted a pull request review.".to_string(),
        state if !state.trim().is_empty() => format!("Submitted a {} review.", state),
        _ => "Submitted a pull request review.".to_string(),
    }
}

fn github_thread_from_review_comment(comment: &Value) -> ReviewPlatformThread {
    let comment_id = first_non_empty(&[
        value_string(comment, "id"),
        value_i64(comment, "id").to_string(),
    ]);
    ReviewPlatformThread {
        id: format!("comment-{}", comment_id),
        provider_thread_id: None,
        provider_comment_id: Some(comment_id),
        kind: ReviewPlatformThreadKind::Comment,
        reply_to_provider_comment_id: value_i64(comment, "in_reply_to_id")
            .checked_abs()
            .map(|id| id.to_string())
            .or_else(|| {
                comment
                    .get("in_reply_to_id")
                    .and_then(Value::as_str)
                    .map(str::to_string)
            }),
        file_path: comment
            .get("path")
            .and_then(Value::as_str)
            .map(str::to_string),
        line: comment
            .get("line")
            .and_then(Value::as_i64)
            .or_else(|| comment.get("original_line").and_then(Value::as_i64)),
        resolved: false,
        author: nested_string(comment, &["user", "login"]),
        body: value_string(comment, "body"),
        updated_at: value_string(comment, "updated_at"),
    }
}

fn github_thread_from_issue_comment(comment: &Value) -> ReviewPlatformThread {
    let comment_id = first_non_empty(&[
        value_string(comment, "id"),
        value_i64(comment, "id").to_string(),
    ]);
    ReviewPlatformThread {
        id: format!("issue-comment-{}", comment_id),
        provider_thread_id: None,
        provider_comment_id: Some(comment_id),
        kind: ReviewPlatformThreadKind::Comment,
        reply_to_provider_comment_id: None,
        file_path: None,
        line: None,
        resolved: false,
        author: nested_string(comment, &["user", "login"]),
        body: value_string(comment, "body"),
        updated_at: value_string(comment, "updated_at"),
    }
}

fn gitlab_threads(discussions: &Value, notes: &Value) -> Vec<ReviewPlatformThread> {
    let mut threads = Vec::new();
    let mut seen_comment_ids = HashSet::new();
    for discussion in array_items(discussions) {
        let discussion_id = value_string(discussion, "id");
        let resolved = value_bool(discussion, "resolved");
        let discussion_notes = discussion
            .get("notes")
            .and_then(Value::as_array)
            .map(|notes| notes.as_slice())
            .unwrap_or(&[]);
        let mut root_comment_id: Option<String> = None;
        for (index, note) in discussion_notes.iter().enumerate() {
            let kind = if index == 0 {
                ReviewPlatformThreadKind::Review
            } else {
                ReviewPlatformThreadKind::Comment
            };
            let reply_to = if index == 0 {
                None
            } else {
                root_comment_id.clone()
            };
            let thread = gitlab_thread_from_note(
                note,
                Some(discussion_id.clone()),
                resolved,
                kind,
                reply_to,
            );
            if root_comment_id.is_none() {
                root_comment_id = thread.provider_comment_id.clone();
            }
            if let Some(comment_id) = thread.provider_comment_id.clone() {
                seen_comment_ids.insert(comment_id);
            }
            threads.push(thread);
        }
    }
    for note in array_items(notes) {
        let thread =
            gitlab_thread_from_note(note, None, false, ReviewPlatformThreadKind::Comment, None);
        if let Some(comment_id) = thread.provider_comment_id.as_ref() {
            if seen_comment_ids.contains(comment_id) {
                continue;
            }
            seen_comment_ids.insert(comment_id.clone());
        }
        threads.push(thread);
    }
    threads
}

fn gitlab_thread_from_note(
    note: &Value,
    discussion_id: Option<String>,
    discussion_resolved: bool,
    kind: ReviewPlatformThreadKind,
    reply_to_provider_comment_id: Option<String>,
) -> ReviewPlatformThread {
    let note_id = value_string(note, "id");
    let id = match discussion_id.as_deref() {
        Some(discussion_id) if !discussion_id.trim().is_empty() => {
            format!("discussion-{}:note-{}", discussion_id, note_id)
        }
        _ => format!("note-{}", note_id),
    };

    ReviewPlatformThread {
        id,
        provider_thread_id: discussion_id,
        provider_comment_id: Some(note_id),
        kind,
        reply_to_provider_comment_id,
        file_path: nested_optional_string(note, &["position", "new_path"])
            .or_else(|| nested_optional_string(note, &["position", "old_path"])),
        line: note
            .pointer("/position/new_line")
            .and_then(Value::as_i64)
            .or_else(|| note.pointer("/position/old_line").and_then(Value::as_i64)),
        resolved: discussion_resolved || value_bool(note, "resolved"),
        author: first_non_empty(&[
            nested_string(note, &["author", "username"]),
            nested_string(note, &["author", "name"]),
        ]),
        body: value_string(note, "body"),
        updated_at: first_non_empty(&[
            value_string(note, "updated_at"),
            value_string(note, "created_at"),
        ]),
    }
}

fn parse_provider_comment_id(thread_id: &str) -> Option<&str> {
    let trimmed = thread_id.trim();
    trimmed
        .strip_prefix("comment-")
        .or_else(|| trimmed.strip_prefix("note-"))
        .or_else(|| trimmed.split_once(":note-").map(|(_, note_id)| note_id))
        .or_else(|| {
            if trimmed.chars().all(|ch| ch.is_ascii_digit()) {
                Some(trimmed)
            } else {
                None
            }
        })
        .filter(|value| !value.trim().is_empty())
}

fn parse_provider_thread_id(thread_id: &str) -> Option<&str> {
    let trimmed = thread_id.trim();
    trimmed
        .strip_prefix("discussion-")
        .map(|value| {
            value
                .split_once(":note-")
                .map(|(id, _)| id)
                .unwrap_or(value)
        })
        .or_else(|| {
            if trimmed
                .chars()
                .all(|ch| ch.is_ascii_alphanumeric() || ch == '_')
            {
                Some(trimmed)
            } else {
                None
            }
        })
        .filter(|value| !value.trim().is_empty())
}

fn gitcode_threads(value: &Value) -> Vec<ReviewPlatformThread> {
    array_items(value)
        .iter()
        .map(|comment| ReviewPlatformThread {
            id: value_string(comment, "id"),
            provider_thread_id: None,
            provider_comment_id: Some(value_string(comment, "id")),
            kind: ReviewPlatformThreadKind::Comment,
            reply_to_provider_comment_id: comment
                .get("in_reply_to_id")
                .and_then(Value::as_str)
                .map(str::to_string)
                .or_else(|| {
                    comment
                        .get("in_reply_to_id")
                        .and_then(Value::as_i64)
                        .map(|id| id.to_string())
                }),
            file_path: comment
                .get("path")
                .and_then(Value::as_str)
                .map(str::to_string),
            line: comment.get("line").and_then(Value::as_i64),
            resolved: false,
            author: first_non_empty(&[
                nested_string(comment, &["user", "login"]),
                nested_string(comment, &["user", "name"]),
            ]),
            body: value_string(comment, "body"),
            updated_at: first_non_empty(&[
                value_string(comment, "updated_at"),
                value_string(comment, "created_at"),
            ]),
        })
        .collect()
}

fn empty_checks() -> ReviewChecks {
    ReviewChecks {
        total: 0,
        passed: 0,
        failed: 0,
        pending: 0,
    }
}

fn file_status(status: &str) -> ReviewFileStatus {
    match status {
        "added" | "new" => ReviewFileStatus::Added,
        "removed" | "deleted" => ReviewFileStatus::Deleted,
        "renamed" => ReviewFileStatus::Renamed,
        _ => ReviewFileStatus::Modified,
    }
}

fn count_diff_lines(diff: &str) -> (i32, i32) {
    let mut additions = 0;
    let mut deletions = 0;
    for line in diff.lines() {
        if line.starts_with("+++") || line.starts_with("---") {
            continue;
        }
        if line.starts_with('+') {
            additions += 1;
        } else if line.starts_with('-') {
            deletions += 1;
        }
    }
    (additions, deletions)
}

fn file_has_complete_patch(file: &ReviewPlatformFile) -> bool {
    let Some(patch) = file
        .patch
        .as_deref()
        .filter(|patch| !patch.trim().is_empty())
    else {
        return false;
    };
    if patch.chars().count() > MAX_REVIEW_FILE_DIFF_CHARS {
        return false;
    }
    let (patch_additions, patch_deletions) = count_diff_lines(patch);
    patch_additions == file.additions
        && patch_deletions == file.deletions
        && (patch_additions > 0 || patch_deletions > 0)
}

fn apply_files_stats(pull_request: &mut ReviewPlatformPullRequest, files: &[ReviewPlatformFile]) {
    if pull_request.changed_files <= 0 {
        pull_request.changed_files = files.len() as i32;
    }
    let (additions, deletions) = files.iter().fold((0, 0), |acc, file| {
        (acc.0 + file.additions, acc.1 + file.deletions)
    });
    pull_request.additions = additions;
    pull_request.deletions = deletions;
}

async fn fetch_bounded_paginated_array<F>(
    mut build_request: F,
    next_page: fn(&ReviewHttpHeaders, u32) -> Option<u32>,
    max_items: usize,
) -> Result<Value, ReviewPlatformError>
where
    F: FnMut(u32) -> ReviewHttpRequest,
{
    let mut page = 1;
    let mut values = Vec::new();
    let mut request_count = 0usize;
    while values.len() < max_items {
        let response = send_bounded_json_response(build_request(page)).await?;
        request_count += 1;
        let items = response.value.as_array().ok_or_else(|| {
            ReviewPlatformError::Parse("Provider paginated response was not an array".to_string())
        })?;
        values.extend(items.iter().take(max_items - values.len()).cloned());
        if values.len() >= max_items {
            break;
        }
        let Some(next) = next_page(&response.headers, page).filter(|next| *next > page) else {
            break;
        };
        if request_count >= MAX_REVIEW_TARGET_PAGES {
            break;
        }
        page = next;
    }
    Ok(Value::Array(values))
}

async fn fetch_bounded_paginated_file<F, M>(
    mut build_request: F,
    next_page: fn(&ReviewHttpHeaders, u32) -> Option<u32>,
    start_page: u32,
    max_items: usize,
    file_path: &str,
    map_file: M,
) -> Result<Option<ReviewPlatformFile>, ReviewPlatformError>
where
    F: FnMut(u32) -> ReviewHttpRequest,
    M: Fn(&Value) -> ReviewPlatformFile,
{
    let mut page = start_page.max(1);
    let mut visited = 0usize;
    let mut request_count = 0usize;
    while visited < max_items {
        let response = send_bounded_json_response(build_request(page)).await?;
        request_count += 1;
        let items = response.value.as_array().ok_or_else(|| {
            ReviewPlatformError::Parse("Provider paginated response was not an array".to_string())
        })?;
        for item in items.iter().take(max_items - visited) {
            let file = map_file(item);
            if file.path == file_path || file.old_path.as_deref() == Some(file_path) {
                return Ok(Some(file));
            }
            visited += 1;
        }
        if visited >= max_items {
            break;
        }
        let Some(next) = next_page(&response.headers, page).filter(|next| *next > page) else {
            break;
        };
        if request_count >= MAX_REVIEW_TARGET_PAGES {
            break;
        }
        page = next;
    }
    Ok(None)
}

fn review_target_from_parts(
    pull_request: ReviewPlatformPullRequest,
    files: Vec<ReviewPlatformFile>,
) -> ReviewPlatformPullRequestReviewTarget {
    let provider_file_count =
        usize::try_from(pull_request.changed_files.max(0)).unwrap_or_default();
    let known_file_count = provider_file_count.max(files.len());
    let collection_budget_exhausted = files.len() >= MAX_REVIEW_TARGET_LIST_ITEMS;
    let omitted_file_count = known_file_count
        .saturating_sub(files.len())
        .max(usize::from(collection_budget_exhausted));
    let mut limitations = Vec::new();
    if provider_file_count > files.len() || collection_budget_exhausted {
        limitations.push("provider_file_list_incomplete".to_string());
    }
    let files = files
        .into_iter()
        .map(|file| {
            let diff_available = file_has_complete_patch(&file);
            ReviewPlatformReviewTargetFile {
                path: file.path,
                old_path: file.old_path,
                status: file.status,
                additions: file.additions,
                deletions: file.deletions,
                diff_available,
            }
        })
        .collect::<Vec<_>>();
    if files.iter().any(|file| !file.diff_available) {
        limitations.push("provider_file_diff_unavailable".to_string());
    }

    ReviewPlatformPullRequestReviewTarget {
        pull_request,
        files,
        omitted_file_count,
        limitations,
    }
}

fn file_diff_from_parts(
    pull_request: ReviewPlatformPullRequest,
    files: Vec<ReviewPlatformFile>,
    expected_base_revision: &str,
    expected_head_revision: &str,
    file_path: &str,
) -> Result<ReviewPlatformPullRequestFileDiff, ReviewPlatformError> {
    let base_revision = pull_request.base_revision.as_deref().unwrap_or_default();
    let head_revision = pull_request.head_revision.as_deref().unwrap_or_default();
    if base_revision != expected_base_revision || head_revision != expected_head_revision {
        return Err(ReviewPlatformError::StaleTarget(format!(
            "expected {expected_base_revision}..{expected_head_revision}, provider returned {base_revision}..{head_revision}"
        )));
    }
    let file = files
        .into_iter()
        .find(|file| file.path == file_path || file.old_path.as_deref() == Some(file_path))
        .ok_or_else(|| {
            ReviewPlatformError::Api(format!(
                "Pull request file is not available from the provider: {file_path}"
            ))
        })?;
    if file.path.contains(['\n', '\r'])
        || file
            .old_path
            .as_deref()
            .is_some_and(|path| path.contains(['\n', '\r']))
    {
        return Err(ReviewPlatformError::Parse(
            "Provider returned an invalid pull request file path".to_string(),
        ));
    }
    if !file_has_complete_patch(&file) {
        return Err(ReviewPlatformError::Api(format!(
            "Exact provider diff is unavailable for pull request file: {}",
            file.path
        )));
    }
    let patch = file.patch.as_deref().ok_or_else(|| {
        ReviewPlatformError::Api(format!(
            "Exact provider diff is unavailable for pull request file: {}",
            file.path
        ))
    })?;
    let old_path = file.old_path.as_deref().unwrap_or(&file.path);
    let diff = if patch.starts_with("diff --git ") {
        patch.to_string()
    } else {
        let old_marker = if file.status == ReviewFileStatus::Added {
            "/dev/null".to_string()
        } else {
            format!("a/{old_path}")
        };
        let new_marker = if file.status == ReviewFileStatus::Deleted {
            "/dev/null".to_string()
        } else {
            format!("b/{}", file.path)
        };
        format!(
            "diff --git a/{old_path} b/{}\n--- {old_marker}\n+++ {new_marker}\n{patch}",
            file.path
        )
    };

    Ok(ReviewPlatformPullRequestFileDiff {
        path: file.path,
        old_path: file.old_path,
        status: file.status,
        base_revision: base_revision.to_string(),
        head_revision: head_revision.to_string(),
        diff,
    })
}

fn array_items(value: &Value) -> &[Value] {
    value
        .as_array()
        .map(|items| items.as_slice())
        .unwrap_or(&[])
}

fn value_string(value: &Value, key: &str) -> String {
    match value.get(key) {
        Some(Value::String(text)) => text.clone(),
        Some(Value::Number(number)) => number.to_string(),
        Some(Value::Bool(flag)) => flag.to_string(),
        _ => String::new(),
    }
}

fn optional_string(value: &Value, key: &str) -> Option<String> {
    value
        .get(key)
        .and_then(Value::as_str)
        .map(str::to_string)
        .filter(|value| !value.trim().is_empty())
}

fn non_empty_option(value: String) -> Option<String> {
    (!value.trim().is_empty()).then_some(value)
}

fn nested_string(value: &Value, path: &[&str]) -> String {
    nested_optional_string(value, path).unwrap_or_default()
}

fn nested_optional_string(value: &Value, path: &[&str]) -> Option<String> {
    let mut current = value;
    for key in path {
        current = current.get(*key)?;
    }
    match current {
        Value::String(text) => Some(text.clone()),
        Value::Number(number) => Some(number.to_string()),
        Value::Bool(flag) => Some(flag.to_string()),
        _ => None,
    }
}

fn value_i64(value: &Value, key: &str) -> i64 {
    value
        .get(key)
        .and_then(|value| {
            value
                .as_i64()
                .or_else(|| value.as_str()?.parse::<i64>().ok())
        })
        .unwrap_or(0)
}

fn value_bool(value: &Value, key: &str) -> bool {
    value
        .get(key)
        .and_then(|value| {
            value
                .as_bool()
                .or_else(|| value.as_str().map(|text| text.eq_ignore_ascii_case("true")))
        })
        .unwrap_or(false)
}

fn first_non_empty(values: &[String]) -> String {
    values
        .iter()
        .find(|value| !value.trim().is_empty())
        .cloned()
        .unwrap_or_default()
}

fn first_non_zero(values: &[i64]) -> i64 {
    values
        .iter()
        .copied()
        .find(|value| *value != 0)
        .unwrap_or(0)
}

fn first_line(value: &str) -> String {
    value.lines().next().unwrap_or_default().to_string()
}

fn short_hash(hash: &str) -> String {
    hash.chars().take(7).collect()
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;
    use std::{
        io::{Read, Write},
        net::TcpListener,
        path::PathBuf,
        sync::{mpsc, Arc},
        thread,
        time::{Duration, Instant},
        time::{SystemTime, UNIX_EPOCH},
    };
    use tokio::fs;

    #[test]
    fn git_ownership_rejection_keeps_a_stable_repository_trust_contract() {
        let detail = concat!(
            "fatal: detected dubious ownership in repository at '/srv/shared/repo'\n",
            "To add an exception for this directory, call:\n",
            "git config --global --add safe.directory /srv/shared/repo",
        );

        let error = classify_git_command_failure("/srv/controller/path", detail.to_string());

        assert!(matches!(
            error,
            ReviewPlatformError::RepositoryUntrusted {
                ref repository_path,
                detail: ref captured_detail,
            } if repository_path == "/srv/shared/repo" && captured_detail == detail
        ));
        assert_eq!(error.untrusted_repository_path(), Some("/srv/shared/repo"));
        assert_eq!(
            untrusted_repository_error_message("/srv/shared/repo"),
            "git_repository_untrusted: /srv/shared/repo"
        );
    }

    #[test]
    fn ordinary_git_failure_remains_an_invalid_repository_error() {
        let error =
            classify_git_command_failure("/srv/project", "fatal: not a git repository".to_string());

        assert!(matches!(
            error,
            ReviewPlatformError::InvalidRepository(ref detail)
                if detail == "fatal: not a git repository"
        ));
    }

    struct AlwaysRemoteWorkspace;

    #[async_trait::async_trait]
    impl ReviewPlatformWorkspaceClassifier for AlwaysRemoteWorkspace {
        async fn classify_repository(
            &self,
            repository: &ReviewRepositoryLocator,
        ) -> Result<ReviewGitExecution, ReviewPlatformError> {
            Ok(ReviewGitExecution::Remote(ReviewRemoteGitTarget {
                workspace_id: repository
                    .workspace_id
                    .clone()
                    .unwrap_or_else(|| "remote-workspace".to_string()),
                connection_id: "conn-1".to_string(),
            }))
        }
    }

    /// Remote workspace runtime stub that records routed git commands and
    /// answers repository probes for a GitLab-hosted remote repository.
    #[derive(Default)]
    struct RecordingRemoteGitRuntime {
        commands: std::sync::Mutex<Vec<(String, String, Vec<String>)>>,
    }

    #[async_trait::async_trait]
    impl ReviewPlatformWorkspaceClassifier for RecordingRemoteGitRuntime {
        async fn classify_repository(
            &self,
            repository: &ReviewRepositoryLocator,
        ) -> Result<ReviewGitExecution, ReviewPlatformError> {
            Ok(ReviewGitExecution::Remote(ReviewRemoteGitTarget {
                workspace_id: repository
                    .workspace_id
                    .clone()
                    .unwrap_or_else(|| "remote-workspace".to_string()),
                connection_id: "conn-1".to_string(),
            }))
        }

        async fn execute_remote_git_command(
            &self,
            target: &ReviewRemoteGitTarget,
            current_dir: &str,
            args: &[&str],
        ) -> Result<String, ReviewPlatformError> {
            self.commands.lock().expect("commands lock").push((
                target.workspace_id.clone(),
                current_dir.to_string(),
                args.iter().map(|arg| arg.to_string()).collect(),
            ));
            match args {
                ["rev-parse", "--show-toplevel"] => Ok("/srv/projects\n".to_string()),
                ["remote", "-v"] => Ok(concat!(
                    "origin\thttps://gitlab.com/example/repo.git (fetch)\n",
                    "origin\thttps://gitlab.com/example/repo.git (push)\n",
                )
                .to_string()),
                _ => Err(ReviewPlatformError::InvalidRepository(format!(
                    "unexpected remote git command: {args:?}"
                ))),
            }
        }
    }

    fn temp_token_store_path(name: &str) -> PathBuf {
        let id = SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .expect("system clock should be after unix epoch")
            .as_nanos();
        std::env::temp_dir().join(format!(
            "openbitfun-review-platform-{name}-{}-{id}.json",
            std::process::id()
        ))
    }

    fn spawn_single_review_response(response: Vec<u8>) -> String {
        let listener = TcpListener::bind("127.0.0.1:0").expect("mock provider should bind");
        let address = listener.local_addr().expect("mock provider address");
        thread::spawn(move || {
            let (mut stream, _) = listener.accept().expect("mock provider should accept");
            let mut request = [0u8; 4096];
            let _ = stream.read(&mut request);
            stream
                .write_all(&response)
                .expect("mock provider response should write");
        });
        format!("http://{address}")
    }

    fn spawn_review_request_probe() -> (String, mpsc::Receiver<bool>) {
        let listener = TcpListener::bind("127.0.0.1:0").expect("mock provider should bind");
        listener
            .set_nonblocking(true)
            .expect("mock provider should allow non-blocking accept");
        let address = listener.local_addr().expect("mock provider address");
        let (sender, receiver) = mpsc::channel();
        thread::spawn(move || {
            let deadline = Instant::now() + Duration::from_millis(300);
            loop {
                match listener.accept() {
                    Ok(_) => {
                        let _ = sender.send(true);
                        return;
                    }
                    Err(error) if error.kind() == std::io::ErrorKind::WouldBlock => {
                        if Instant::now() >= deadline {
                            let _ = sender.send(false);
                            return;
                        }
                        thread::sleep(Duration::from_millis(10));
                    }
                    Err(error) => panic!("mock provider probe should accept: {error}"),
                }
            }
        });
        (format!("http://{address}"), receiver)
    }

    fn spawn_empty_paginated_responses() -> (String, mpsc::Receiver<usize>) {
        let listener = TcpListener::bind("127.0.0.1:0").expect("mock provider should bind");
        listener
            .set_nonblocking(true)
            .expect("mock provider should allow non-blocking accept");
        let address = listener.local_addr().expect("mock provider address");
        let (sender, receiver) = mpsc::channel();
        thread::spawn(move || {
            let mut request_count = 0usize;
            let mut idle_deadline = Instant::now() + Duration::from_secs(2);
            loop {
                match listener.accept() {
                    Ok((mut stream, _)) => {
                        let mut request = [0u8; 4096];
                        let _ = stream.read(&mut request);
                        request_count += 1;
                        let next_page = request_count + 1;
                        let response = format!(
                            "HTTP/1.1 200 OK\r\nContent-Type: application/json\r\nX-Next-Page: {next_page}\r\nContent-Length: 2\r\nConnection: close\r\n\r\n[]"
                        );
                        stream
                            .write_all(response.as_bytes())
                            .expect("mock provider response should write");
                        idle_deadline = Instant::now() + Duration::from_millis(300);
                    }
                    Err(error) if error.kind() == std::io::ErrorKind::WouldBlock => {
                        if Instant::now() >= idle_deadline {
                            let _ = sender.send(request_count);
                            return;
                        }
                        thread::sleep(Duration::from_millis(5));
                    }
                    Err(error) => panic!("mock provider pagination should accept: {error}"),
                }
            }
        });
        (format!("http://{address}"), receiver)
    }

    fn gitlab_trace_context(api_base_url: String) -> ProviderContext {
        let mut tokens = ReviewPlatformAuthTokens::default();
        tokens.tokens.insert(
            token_key(ReviewPlatformKind::Gitlab, "gitlab.com")
                .expect("GitLab token key should normalize"),
            "never-expose-trace-token".to_string(),
        );
        let mut context = provider_context_for_identity(
            ReviewPlatformKind::Gitlab,
            "gitlab.com",
            "example/repo",
            &tokens,
        )
        .expect("GitLab trace context should be valid");
        context.api_base_url = api_base_url;
        context
    }

    #[tokio::test]
    async fn bounded_pagination_stops_empty_pages_with_next_links() {
        let (base_url, request_count) = spawn_empty_paginated_responses();
        let client = http_client().expect("review client should build");
        let result = tokio::time::timeout(
            Duration::from_secs(2),
            fetch_bounded_paginated_array(
                |page| {
                    let page = page.to_string();
                    client
                        .get(&format!("{base_url}/items"))
                        .query(&[("page", &page)])
                },
                gitlab_next_page,
                MAX_REVIEW_TARGET_LIST_ITEMS,
            ),
        )
        .await
        .expect("bounded pagination must terminate independently of item progress");

        assert_eq!(
            result.expect("page budget should return partial evidence"),
            json!([])
        );
        assert!(
            request_count
                .recv_timeout(Duration::from_secs(3))
                .expect("mock provider should report request count")
                <= 32,
            "pagination request cap must remain small"
        );
    }

    #[tokio::test]
    async fn token_store_uses_injected_path() {
        let path = temp_token_store_path("token-store");
        let service = ReviewPlatformService::new_local_only(path.clone());

        service
            .update_auth_token(ReviewPlatformKind::Gitlab, "GitLab.com", " secret-token ")
            .await
            .expect("token update should write injected store");

        let tokens = service
            .load_stored_tokens()
            .await
            .expect("stored token file should be readable");
        assert_eq!(
            tokens.get(ReviewPlatformKind::Gitlab, "gitlab.com"),
            Some("secret-token")
        );
        assert!(path.exists());

        let _ = fs::remove_file(path).await;
    }

    #[tokio::test]
    async fn github_token_actions_are_rejected() {
        let path = temp_token_store_path("github-token-rejected");
        let service = ReviewPlatformService::new_local_only(path.clone());

        let update = service
            .update_auth_token(ReviewPlatformKind::Github, "github.com", "secret-token")
            .await;
        let clear = service
            .clear_auth_token(ReviewPlatformKind::Github, "github.com")
            .await;

        assert!(
            matches!(update, Err(ReviewPlatformError::Api(message)) if message.contains("gh auth login"))
        );
        assert!(
            matches!(clear, Err(ReviewPlatformError::Api(message)) if message.contains("gh auth logout"))
        );
        assert!(!path.exists());
    }

    #[tokio::test]
    async fn pre_openbitfun_github_token_is_rejected_without_modifying_store() {
        let path = temp_token_store_path("pre-openbitfun-github-token");
        let original = serde_json::to_vec(&json!({
            "schemaVersion": 1,
            "tokens": {
                "github:github.com": {
                    "token": "pre-openbitfun-github-token",
                    "updatedAt": "2026-07-14T00:00:00Z"
                },
                "gitlab:gitlab.com": {
                    "token": "gitlab-token",
                    "updatedAt": "2026-07-14T00:00:00Z"
                }
            }
        }))
        .expect("token fixture should serialize");
        fs::write(&path, &original)
            .await
            .expect("token fixture should be written");
        let service = ReviewPlatformService::new_local_only(path.clone());

        let error = service
            .load_stored_tokens()
            .await
            .expect_err("pre-OpenBitFun GitHub token must require explicit migration");

        assert!(error.to_string().contains("pre-OpenBitFun"), "{error}");
        assert!(error.to_string().contains("migration tool"), "{error}");
        assert_eq!(
            fs::read(&path).await.expect("read unchanged store"),
            original
        );
        let _ = fs::remove_file(path).await;
    }

    #[test]
    fn gh_auth_status_uses_only_the_active_successful_account() {
        let status = parse_gh_auth_status(
            "github.com",
            &json!({
                "hosts": {
                    "github.com": [
                        { "state": "failure", "active": false, "login": "old" },
                        { "state": "success", "active": true, "login": "octocat" }
                    ]
                }
            }),
        );

        assert!(status.installed);
        assert!(status.connected);
        assert_eq!(status.username.as_deref(), Some("octocat"));
    }

    #[tokio::test]
    async fn token_store_preserves_io_path_case_and_only_normalizes_lock_identity() {
        let base = temp_token_store_path("mixed-case-path");
        let mixed_path = base.with_file_name("MiXeD-Review-Token-Store.JSON");
        let service = ReviewPlatformService::new_local_only(mixed_path.clone());

        assert_eq!(service.token_store_path(), mixed_path.as_path());
        service
            .update_auth_token(ReviewPlatformKind::Gitlab, "gitlab.com", "case-token")
            .await
            .expect("mixed-case token path should be writable");
        let created_names = std::fs::read_dir(
            mixed_path
                .parent()
                .expect("mixed-case token path should have a parent"),
        )
        .expect("mixed-case token directory should be readable")
        .filter_map(Result::ok)
        .map(|entry| entry.file_name())
        .collect::<Vec<_>>();
        assert!(created_names.iter().any(|name| {
            name == mixed_path
                .file_name()
                .expect("mixed-case token path should have a file name")
        }));

        let case_variant = PathBuf::from(mixed_path.to_string_lossy().to_ascii_uppercase());
        let variant_service = ReviewPlatformService::new_local_only(case_variant);
        #[cfg(windows)]
        assert!(Arc::ptr_eq(
            &service.token_store_lock,
            &variant_service.token_store_lock
        ));
        #[cfg(not(windows))]
        assert!(!Arc::ptr_eq(
            &service.token_store_lock,
            &variant_service.token_store_lock
        ));

        let _ = fs::remove_file(mixed_path).await;
    }

    #[tokio::test]
    async fn token_authority_normalization_is_shared_by_save_get_and_clear() {
        let path = temp_token_store_path("token-authority-normalization");
        let service = ReviewPlatformService::new_local_only(path.clone());

        service
            .update_auth_token(ReviewPlatformKind::Gitlab, " GitLab.COM. ", "secret-token")
            .await
            .expect("normalized token should save");
        let tokens = service
            .load_stored_tokens()
            .await
            .expect("normalized token should load");
        assert_eq!(
            tokens.get(ReviewPlatformKind::Gitlab, "gitlab.com."),
            Some("secret-token")
        );

        service
            .clear_auth_token(ReviewPlatformKind::Gitlab, "GITLAB.COM.")
            .await
            .expect("normalized token should clear");
        let tokens = service
            .load_stored_tokens()
            .await
            .expect("cleared token store should load");
        assert_eq!(tokens.get(ReviewPlatformKind::Gitlab, "gitlab.com"), None);
        let _ = fs::remove_file(path).await;
    }

    #[tokio::test]
    async fn noncanonical_stored_token_authority_is_rejected_without_modification() {
        let path = temp_token_store_path("noncanonical-token-authority");
        let original = serde_json::to_vec(&json!({
            "schemaVersion": 1,
            "tokens": {
                "gitlab:GitLab.COM.": {
                    "token": "noncanonical-token",
                    "updatedAt": "2026-07-11T00:00:00Z"
                }
            }
        }))
        .expect("noncanonical token fixture should serialize");
        fs::write(&path, &original)
            .await
            .expect("noncanonical token fixture should be written");
        let service = ReviewPlatformService::new_local_only(path.clone());

        let error = service
            .load_stored_tokens()
            .await
            .expect_err("noncanonical token authority must require explicit migration");

        assert!(error.to_string().contains("not canonical"), "{error}");
        assert!(error.to_string().contains("migration tool"), "{error}");
        assert_eq!(
            fs::read(&path).await.expect("read unchanged store"),
            original
        );
        let _ = fs::remove_file(path).await;
    }

    #[tokio::test]
    async fn canonical_and_noncanonical_token_conflict_is_not_rewritten() {
        let path = temp_token_store_path("noncanonical-token-conflict");
        let original = serde_json::to_vec(&json!({
            "schemaVersion": 1,
            "tokens": {
                "gitlab:GitLab.COM.": {
                    "token": "noncanonical-token",
                    "updatedAt": "2026-07-12T00:00:00Z"
                },
                "gitlab:gitlab.com": {
                    "token": "canonical-token",
                    "updatedAt": "2026-07-11T00:00:00Z"
                }
            }
        }))
        .expect("conflicting token fixture should serialize");
        fs::write(&path, &original)
            .await
            .expect("conflicting token fixture should be written");
        let service = ReviewPlatformService::new_local_only(path.clone());

        let load_error = service
            .load_stored_tokens()
            .await
            .expect_err("conflicting token store must not be normalized on load");
        assert!(load_error.to_string().contains("not canonical"));

        let update_error = service
            .update_auth_token(ReviewPlatformKind::Gitlab, "GITLAB.COM.", "new-token")
            .await
            .expect_err("write operations must not repair a noncanonical store");
        assert!(update_error.to_string().contains("not canonical"));
        assert_eq!(
            fs::read(&path).await.expect("read unchanged store"),
            original
        );
        let _ = fs::remove_file(path).await;
    }

    #[tokio::test]
    async fn independent_owners_concurrently_update_without_losing_hosts() {
        let path = temp_token_store_path("concurrent-token-updates");
        let first = ReviewPlatformService::new_local_only(path.clone());
        let second = ReviewPlatformService::new_local_only(path.clone());

        let (gitcode, gitlab) = tokio::join!(
            first.update_auth_token(ReviewPlatformKind::Gitcode, "gitcode.com", "gitcode-token"),
            second.update_auth_token(ReviewPlatformKind::Gitlab, "gitlab.com", "gitlab-token")
        );
        gitcode.expect("GitCode token update should succeed");
        gitlab.expect("GitLab token update should succeed");

        let stored = first
            .load_stored_tokens()
            .await
            .expect("concurrent token store should load");
        assert_eq!(
            stored.get(ReviewPlatformKind::Gitcode, "gitcode.com"),
            Some("gitcode-token")
        );
        assert_eq!(
            stored.get(ReviewPlatformKind::Gitlab, "gitlab.com"),
            Some("gitlab-token")
        );
        let _ = fs::remove_file(path).await;
    }

    #[tokio::test]
    async fn independent_owners_concurrently_update_and_clear_without_lost_mutations() {
        let path = temp_token_store_path("concurrent-token-update-clear");
        let first = ReviewPlatformService::new_local_only(path.clone());
        let second = ReviewPlatformService::new_local_only(path.clone());
        first
            .update_auth_token(ReviewPlatformKind::Gitcode, "gitcode.com", "old-gitcode")
            .await
            .expect("GitCode fixture token should save");
        first
            .update_auth_token(ReviewPlatformKind::Gitlab, "gitlab.com", "old-gitlab")
            .await
            .expect("GitLab fixture token should save");

        let (update, clear) = tokio::join!(
            first.update_auth_token(ReviewPlatformKind::Gitcode, "gitcode.com", "new-gitcode"),
            second.clear_auth_token(ReviewPlatformKind::Gitlab, "gitlab.com")
        );
        update.expect("GitCode token update should succeed");
        clear.expect("GitLab token clear should succeed");

        let stored = second
            .load_stored_tokens()
            .await
            .expect("updated token store should load");
        assert_eq!(
            stored.get(ReviewPlatformKind::Gitcode, "gitcode.com"),
            Some("new-gitcode")
        );
        assert_eq!(stored.get(ReviewPlatformKind::Gitlab, "gitlab.com"), None);
        let temp_prefix = format!(
            ".{}.",
            path.file_name()
                .expect("token path should have a file name")
                .to_string_lossy()
        );
        let mut entries = fs::read_dir(
            path.parent()
                .expect("temporary token path should have a parent"),
        )
        .await
        .expect("temporary token directory should be readable");
        while let Some(entry) = entries
            .next_entry()
            .await
            .expect("temporary token entry should be readable")
        {
            assert!(!entry
                .file_name()
                .to_string_lossy()
                .starts_with(&temp_prefix));
        }
        let _ = fs::remove_file(path).await;
    }

    #[test]
    fn token_store_lock_registry_reclaims_dead_paths() {
        let marker = format!(
            "registry-reclaim-{}-{}",
            std::process::id(),
            SystemTime::now()
                .duration_since(UNIX_EPOCH)
                .expect("system clock should be after unix epoch")
                .as_nanos()
        );
        for index in 0..64 {
            let path = std::env::temp_dir().join(format!("{marker}-{index}.json"));
            drop(ReviewPlatformService::new_local_only(path));
        }
        let survivor_path = std::env::temp_dir().join(format!("{marker}-survivor.json"));
        let _survivor = ReviewPlatformService::new_local_only(survivor_path);

        assert_eq!(token_store_lock_registry_entries_for_test(&marker), 1);
    }

    #[tokio::test]
    async fn workspace_snapshot_fails_loudly_when_remote_git_execution_is_not_wired() {
        let path = temp_token_store_path("remote-classifier");
        let service = ReviewPlatformService::new(path, Arc::new(AlwaysRemoteWorkspace));

        let error = service
            .workspace_snapshot(
                &ReviewRepositoryLocator::new(
                    Some("ws-remote".to_string()),
                    "not-a-git-repository",
                ),
                None,
                None,
                None,
            )
            .await
            .expect_err("remote workspace without remote git wiring must fail loudly");

        assert!(
            error
                .to_string()
                .contains("Remote workspace Git execution is not wired"),
            "unexpected error: {error}"
        );
    }

    #[tokio::test]
    async fn workspace_context_routes_git_probes_through_remote_runtime() {
        let path = temp_token_store_path("remote-git-routing");
        let runtime = Arc::new(RecordingRemoteGitRuntime::default());
        let service = ReviewPlatformService::new(path, runtime.clone());

        let snapshot = service
            .workspace_context(
                &ReviewRepositoryLocator::new(
                    Some("ws-remote".to_string()),
                    "/srv/projects/openbitfun",
                ),
                None,
            )
            .await
            .expect("remote workspace context should resolve through remote git");

        assert_eq!(
            snapshot
                .repository
                .as_ref()
                .map(|repository| repository.project_path.as_str()),
            Some("example/repo")
        );
        assert_eq!(
            snapshot
                .repository
                .as_ref()
                .and_then(|repository| repository.workspace_path.as_deref()),
            Some("/srv/projects")
        );

        let commands = runtime.commands.lock().expect("commands lock").clone();
        assert_eq!(
            commands,
            vec![
                (
                    "ws-remote".to_string(),
                    "/srv/projects/openbitfun".to_string(),
                    vec!["rev-parse".to_string(), "--show-toplevel".to_string()],
                ),
                (
                    "ws-remote".to_string(),
                    "/srv/projects".to_string(),
                    vec!["remote".to_string(), "-v".to_string()],
                ),
            ],
            "git probes must run through the remote runtime, keyed by the workspace ID"
        );
    }

    #[tokio::test]
    async fn repository_trusts_provider_identity_uses_remote_runtime() {
        let path = temp_token_store_path("remote-trust");
        let runtime = Arc::new(RecordingRemoteGitRuntime::default());
        let service = ReviewPlatformService::new(path, runtime);

        assert!(
            service
                .repository_trusts_provider_identity(
                    &ReviewRepositoryLocator::new(
                        Some("ws-remote".to_string()),
                        "/srv/projects/openbitfun",
                    ),
                    ReviewPlatformKind::Gitlab,
                    "gitlab.com",
                    "example/repo",
                )
                .await,
            "remote workspace remotes must participate in provider identity trust"
        );
    }

    #[tokio::test]
    async fn workspace_context_discovers_repository_without_listing_pull_requests() {
        let repository = tempfile::tempdir().expect("temporary repository should be created");
        let repository_path = repository
            .path()
            .to_str()
            .expect("repository path should be UTF-8");
        execute_git_command(repository_path, &["init"])
            .await
            .expect("temporary repository should initialize");
        execute_git_command(
            repository_path,
            &[
                "remote",
                "add",
                "origin",
                "https://gitlab.com/example/repo.git",
            ],
        )
        .await
        .expect("GitLab remote should be added");
        let path = temp_token_store_path("workspace-context");
        let service = ReviewPlatformService::new_local_only(path.clone());

        let snapshot = service
            .workspace_context(&ReviewRepositoryLocator::legacy_path(repository_path), None)
            .await
            .expect("workspace context should not call the provider list API");

        assert!(snapshot.pull_requests.is_empty());
        assert_eq!(snapshot.pagination.total, Some(0));
        assert_eq!(
            snapshot
                .repository
                .as_ref()
                .map(|repository| repository.project_path.as_str()),
            Some("example/repo")
        );
        let _ = fs::remove_file(path).await;
    }

    #[tokio::test]
    async fn repository_root_accepts_nested_and_file_paths() {
        let root = std::env::temp_dir().join(format!(
            "openbitfun-review-platform-git-root-{}-{}",
            std::process::id(),
            SystemTime::now()
                .duration_since(UNIX_EPOCH)
                .expect("system clock should be after unix epoch")
                .as_nanos()
        ));
        let nested = root.join("nested").join("dir");
        let file = nested.join("tracked.txt");
        fs::create_dir_all(&nested)
            .await
            .expect("temporary nested directory should be created");
        fs::write(&file, "content")
            .await
            .expect("temporary file should be created");
        // `git rev-parse --show-toplevel` reports the canonical path (for
        // example `/private/var/...` instead of `/var/...` on macOS).
        let root = root
            .canonicalize()
            .expect("temporary repository root should canonicalize");
        let nested = nested
            .canonicalize()
            .expect("nested directory should canonicalize");
        let file = nested.join("tracked.txt");

        execute_git_command(
            root.to_str()
                .expect("temporary repository path should be valid UTF-8"),
            &["init"],
        )
        .await
        .expect("git init should succeed for repository root test");

        let root_text = root
            .to_str()
            .expect("temporary repository path should be valid UTF-8");
        // Git for Windows reports a normal drive path, while
        // std::fs::canonicalize uses the equivalent verbatim path form.
        #[cfg(windows)]
        let root_text = root_text.strip_prefix(r"\\?\").unwrap_or(root_text);
        let expected = normalize_repository_root(root_text);
        let nested_root = get_repository_root(
            nested
                .to_str()
                .expect("nested repository path should be valid UTF-8"),
        )
        .await
        .expect("nested directory should resolve repository root");
        let file_root = get_repository_root(
            file.to_str()
                .expect("file repository path should be valid UTF-8"),
        )
        .await
        .expect("file path should resolve repository root");

        assert_eq!(nested_root, expected);
        assert_eq!(file_root, expected);

        let _ = fs::remove_dir_all(root).await;
    }

    #[test]
    fn github_review_decision_uses_latest_review_per_author() {
        let reviews = json!([
            {
                "id": 1,
                "state": "CHANGES_REQUESTED",
                "user": { "login": "alice" }
            },
            {
                "id": 2,
                "state": "APPROVED",
                "user": { "login": "alice" }
            }
        ]);

        assert_eq!(github_review_decision(&reviews), ReviewDecision::Approved);
    }

    #[test]
    fn github_pull_request_keeps_immutable_revisions() {
        let pull_request = github_pull_request_from_value(&json!({
            "number": 42,
            "title": "Review target",
            "state": "open",
            "user": { "login": "alice" },
            "head": { "ref": "feature", "sha": "2222222222222222222222222222222222222222" },
            "base": { "ref": "main", "sha": "1111111111111111111111111111111111111111" },
            "updated_at": "2026-07-11T00:00:00Z",
            "html_url": "https://github.com/example/repo/pull/42",
            "changed_files": 1
        }));

        assert_eq!(
            pull_request.base_revision.as_deref(),
            Some("1111111111111111111111111111111111111111")
        );
        assert_eq!(
            pull_request.head_revision.as_deref(),
            Some("2222222222222222222222222222222222222222")
        );
    }

    #[test]
    fn gitcode_pull_request_maps_documented_change_counts() {
        let pull_request = gitcode_pull_request_from_value(&json!({
            "number": 5,
            "title": "fix bugs",
            "state": "open",
            "added_lines": 133,
            "removed_lines": 22,
            "changes_count": "7",
            "additions": 99,
            "deletions": 99,
            "changed_files": 99
        }));

        assert_eq!(pull_request.additions, 133);
        assert_eq!(pull_request.deletions, 22);
        assert_eq!(pull_request.changed_files, 7);
        assert!(pull_request.changed_file_count_known);
    }

    #[test]
    fn gitcode_pull_request_marks_approximate_change_count_unknown() {
        let pull_request = gitcode_pull_request_from_value(&json!({
            "number": 5,
            "title": "large change",
            "state": "open",
            "changes_count": "3000+"
        }));

        assert_eq!(pull_request.changed_files, 3_000);
        assert!(!pull_request.changed_file_count_known);
    }

    #[test]
    fn gitcode_pull_request_marks_missing_file_count_unknown() {
        let pull_request = gitcode_pull_request_from_value(&json!({
            "number": 5,
            "title": "fix bugs",
            "state": "open",
            "added_lines": 133,
            "removed_lines": 22
        }));

        assert_eq!(pull_request.changed_files, 0);
        assert!(!pull_request.changed_file_count_known);
        assert_eq!(pull_request.additions, 133);
        assert_eq!(pull_request.deletions, 22);
    }

    #[test]
    fn gitcode_file_maps_nested_patch_and_change_flags() {
        let file = gitcode_file_from_value(&json!({
            "filename": "src/new.rs",
            "old_path": "src/old.rs",
            "status": null,
            "new_file": false,
            "renamed_file": true,
            "deleted_file": false,
            "additions": 1,
            "deletions": 1,
            "patch": { "diff": "@@ -1 +1 @@\n-old\n+new" }
        }));

        assert_eq!(file.path, "src/new.rs");
        assert_eq!(file.old_path.as_deref(), Some("src/old.rs"));
        assert_eq!(file.status, ReviewFileStatus::Renamed);
        assert_eq!(file.patch.as_deref(), Some("@@ -1 +1 @@\n-old\n+new"));
        assert!(file_has_complete_patch(&file));
    }

    #[test]
    fn gitcode_capped_files_pagination_does_not_claim_exact_total() {
        let pagination = gitcode_files_pagination(
            PullRequestPagination {
                page: 60,
                per_page: 50,
            },
            GITCODE_PULL_REQUEST_FILES_RESPONSE_LIMIT,
        );

        assert_eq!(pagination.total, None);
        assert!(!pagination.has_next);
    }

    #[test]
    fn gitcode_review_target_reports_the_files_the_budget_left_out() {
        let mut pull_request = gitcode_pull_request_from_value(&json!({
            "number": 5,
            "title": "large change",
            "state": "open",
            "added_lines": 9_999,
            "removed_lines": 8_888,
            "changes_count": "2500"
        }));
        let response = JsonResponse {
            value: Value::Array(
                (0..2_500)
                    .map(|index| {
                        json!({
                            "filename": format!("src/file-{index}.rs"),
                            "additions": "1",
                            "deletions": "2"
                        })
                    })
                    .collect(),
            ),
            headers: ReviewHttpHeaders::default(),
        };
        let files = array_items(&response.value)
            .iter()
            .take(MAX_REVIEW_TARGET_LIST_ITEMS)
            .map(gitcode_file_from_value)
            .collect::<Vec<_>>();

        apply_gitcode_pull_request_change_stats(&mut pull_request, &response);
        let target = review_target_from_parts(pull_request, files);

        assert_eq!(target.pull_request.changed_files, 2_500);
        assert!(target.pull_request.changed_file_count_known);
        assert_eq!(target.pull_request.additions, 2_500);
        assert_eq!(target.pull_request.deletions, 5_000);
        assert_eq!(target.files.len(), MAX_REVIEW_TARGET_LIST_ITEMS);
        assert_eq!(target.omitted_file_count, 1_500);
        assert!(target
            .limitations
            .contains(&"provider_file_list_incomplete".to_string()));
    }

    #[test]
    fn gitcode_files_response_too_large_reports_explicit_reason() {
        let error = gitcode_files_http_error(ReviewHttpError::ResponseTooLarge {
            limit_bytes: GITCODE_PULL_REQUEST_FILES_RESPONSE_BYTES,
        });

        assert_eq!(
            error.to_string(),
            "Provider API failed: GitCode pull request files response exceeded the 16777216-byte limit"
        );
    }

    #[test]
    fn gitcode_file_response_overrides_incomplete_list_stats() {
        let mut pull_request = gitcode_pull_request_from_value(&json!({
            "number": 5,
            "title": "fix bugs",
            "state": "open",
            "added_lines": 133,
            "removed_lines": 22
        }));
        let response = JsonResponse {
            value: json!([
                { "filename": "src/a.rs", "additions": "5", "deletions": "2" },
                { "filename": "src/b.rs", "additions": "8", "deletions": "3" }
            ]),
            headers: ReviewHttpHeaders::default(),
        };

        apply_gitcode_pull_request_change_stats(&mut pull_request, &response);

        assert_eq!(pull_request.changed_files, 2);
        assert!(pull_request.changed_file_count_known);
        assert_eq!(pull_request.additions, 13);
        assert_eq!(pull_request.deletions, 5);
    }

    #[test]
    fn gitcode_empty_file_response_confirms_zero_files() {
        let mut pull_request = gitcode_pull_request_from_value(&json!({
            "number": 5,
            "title": "no changes",
            "state": "open"
        }));
        let response = JsonResponse {
            value: json!([]),
            headers: ReviewHttpHeaders::default(),
        };

        apply_gitcode_pull_request_change_stats(&mut pull_request, &response);

        assert_eq!(pull_request.changed_files, 0);
        assert!(pull_request.changed_file_count_known);
    }

    #[test]
    fn gitcode_non_array_file_response_does_not_fake_zero_files() {
        let mut pull_request = gitcode_pull_request_from_value(&json!({
            "number": 5,
            "title": "fix bugs",
            "state": "open",
            "added_lines": 133,
            "removed_lines": 22
        }));
        let response = JsonResponse {
            value: json!({ "message": "temporarily unavailable" }),
            headers: ReviewHttpHeaders::default(),
        };

        apply_gitcode_pull_request_change_stats(&mut pull_request, &response);

        assert_eq!(pull_request.changed_files, 0);
        assert!(!pull_request.changed_file_count_known);
        assert_eq!(pull_request.additions, 133);
        assert_eq!(pull_request.deletions, 22);
    }

    #[test]
    fn pull_request_payload_without_known_flag_remains_backward_compatible() {
        let pull_request = gitcode_pull_request_from_value(&json!({
            "number": 5,
            "title": "legacy payload",
            "state": "open",
            "changes_count": "0"
        }));
        let mut value = serde_json::to_value(pull_request).expect("serialize pull request");
        value
            .as_object_mut()
            .expect("pull request object")
            .remove("changedFileCountKnown");

        let decoded: ReviewPlatformPullRequest =
            serde_json::from_value(value).expect("deserialize legacy pull request");

        assert!(decoded.changed_file_count_known);
        assert_eq!(decoded.changed_files, 0);
    }

    #[test]
    fn gitcode_file_response_prefers_total_line_headers() {
        let mut pull_request = gitcode_pull_request_from_value(&json!({
            "number": 5,
            "title": "fix bugs",
            "state": "open"
        }));
        let response = JsonResponse {
            value: json!([
                { "filename": "src/a.rs", "additions": "5", "deletions": "2" },
                { "filename": "src/b.rs", "additions": "8", "deletions": "3" }
            ]),
            headers: ReviewHttpHeaders::from_pairs(&[
                ("total_added_lines", "133"),
                ("total_removed_lines", "22"),
            ]),
        };

        apply_gitcode_pull_request_change_stats(&mut pull_request, &response);

        assert_eq!(pull_request.changed_files, 2);
        assert!(pull_request.changed_file_count_known);
        assert_eq!(pull_request.additions, 133);
        assert_eq!(pull_request.deletions, 22);
    }

    #[test]
    fn gitcode_capped_file_response_does_not_claim_truncated_stats() {
        let response = JsonResponse {
            value: Value::Array(
                (0..GITCODE_PULL_REQUEST_FILES_RESPONSE_LIMIT)
                    .map(|index| {
                        json!({
                            "filename": format!("src/{index}.rs"),
                            "additions": "1",
                            "deletions": "1"
                        })
                    })
                    .collect(),
            ),
            headers: ReviewHttpHeaders::from_pairs(&[
                ("total_added_lines", "1910"),
                ("total_removed_lines", "116799"),
            ]),
        };
        let mut unknown_count = gitcode_pull_request_from_value(&json!({
            "number": 5,
            "title": "large change",
            "state": "open",
            "added_lines": 133,
            "removed_lines": 22
        }));

        apply_gitcode_pull_request_change_stats(&mut unknown_count, &response);

        assert_eq!(unknown_count.changed_files, 3_000);
        assert!(!unknown_count.changed_file_count_known);
        assert_eq!(unknown_count.additions, 133);
        assert_eq!(unknown_count.deletions, 22);

        let mut provider_count = gitcode_pull_request_from_value(&json!({
            "number": 5,
            "title": "large change",
            "state": "open",
            "added_lines": 401011,
            "removed_lines": 5219754,
            "changes_count": "32202"
        }));

        apply_gitcode_pull_request_change_stats(&mut provider_count, &response);

        assert_eq!(provider_count.changed_files, 32_202);
        assert!(provider_count.changed_file_count_known);
        assert_eq!(provider_count.additions, 401_011);
        assert_eq!(provider_count.deletions, 5_219_754);
    }

    #[test]
    fn github_cli_pull_request_maps_open_user_list_fields() {
        let pull_request = github_pull_request_from_gh_cli_value(
            &json!({
                "number": 42,
                "title": "Current user pull request",
                "state": "OPEN",
                "isDraft": false,
                "author": { "login": "octocat" },
                "headRefName": "feature",
                "headRefOid": "2222222222222222222222222222222222222222",
                "baseRefName": "main",
                "baseRefOid": "1111111111111111111111111111111111111111",
                "updatedAt": "2026-07-14T00:00:00Z",
                "url": "https://github.com/example/repo/pull/42",
                "additions": 12,
                "deletions": 3,
                "changedFiles": 2,
                "comments": [{ "id": "one" }, { "id": "two" }],
                "reviewDecision": "CHANGES_REQUESTED",
                "statusCheckRollup": [
                    { "conclusion": "SUCCESS", "status": "COMPLETED" },
                    { "conclusion": "FAILURE", "status": "COMPLETED" },
                    { "conclusion": "", "status": "IN_PROGRESS" }
                ]
            }),
            Some("origin:github:example__repo"),
        );

        assert_eq!(pull_request.number, 42);
        assert_eq!(
            pull_request.provider_id.as_deref(),
            Some("origin:github:example__repo")
        );
        assert_eq!(pull_request.author, "octocat");
        assert_eq!(pull_request.state, ReviewItemState::Open);
        assert_eq!(
            pull_request.review_decision,
            ReviewDecision::ChangesRequested
        );
        assert_eq!(pull_request.comments, 2);
        assert_eq!(pull_request.checks.total, 3);
        assert_eq!(pull_request.checks.passed, 1);
        assert_eq!(pull_request.checks.failed, 1);
        assert_eq!(pull_request.checks.pending, 1);
    }

    #[test]
    fn github_workspace_pull_requests_deduplicate_urls_not_numbers() {
        let make_pull_request = |provider_id: &str, url: &str, updated_at: &str| {
            github_pull_request_from_gh_cli_value(
                &json!({
                    "number": 42,
                    "title": provider_id,
                    "state": "OPEN",
                    "isDraft": false,
                    "author": { "login": "octocat" },
                    "headRefName": "feature",
                    "baseRefName": "main",
                    "updatedAt": updated_at,
                    "url": url,
                    "comments": [],
                    "statusCheckRollup": []
                }),
                Some(provider_id),
            )
        };
        let page = aggregate_github_pull_requests(
            vec![
                make_pull_request(
                    "fork",
                    "https://github.com/example/fork/pull/42",
                    "2026-07-14T01:00:00Z",
                ),
                make_pull_request(
                    "upstream",
                    "https://github.com/example/upstream/pull/42",
                    "2026-07-14T02:00:00Z",
                ),
                make_pull_request(
                    "duplicate-upstream",
                    "https://github.com/example/upstream/pull/42",
                    "2026-07-14T00:00:00Z",
                ),
            ],
            PullRequestPagination::new(Some(1), Some(10)),
        );

        assert_eq!(page.items.len(), 2);
        assert_eq!(page.items[0].provider_id.as_deref(), Some("upstream"));
        assert_eq!(page.items[1].provider_id.as_deref(), Some("fork"));
    }

    #[test]
    fn review_target_reports_unavailable_provider_diffs_without_embedding_them() {
        let mut pull_request = github_pull_request_from_value(&json!({
            "number": 42,
            "title": "Review target",
            "state": "open",
            "head": { "ref": "feature", "sha": "2222222222222222222222222222222222222222" },
            "base": { "ref": "main", "sha": "1111111111111111111111111111111111111111" },
            "changed_files": 2
        }));
        pull_request.changed_files = 2;
        let target = review_target_from_parts(
            pull_request,
            vec![
                ReviewPlatformFile {
                    path: "src/lib.rs".to_string(),
                    old_path: None,
                    status: ReviewFileStatus::Modified,
                    additions: 1,
                    deletions: 1,
                    patch: Some("@@ -1 +1 @@\n-old\n+new".to_string()),
                },
                ReviewPlatformFile {
                    path: "assets/image.png".to_string(),
                    old_path: None,
                    status: ReviewFileStatus::Modified,
                    additions: 0,
                    deletions: 0,
                    patch: None,
                },
            ],
        );

        assert_eq!(target.files.len(), 2);
        assert!(target.files[0].diff_available);
        assert!(!target.files[1].diff_available);
        assert!(target
            .limitations
            .contains(&"provider_file_diff_unavailable".to_string()));
    }

    #[test]
    fn review_target_keeps_more_than_five_hundred_provider_files() {
        let mut pull_request = github_pull_request_from_value(&json!({
            "number": 42,
            "title": "Large review target",
            "state": "open",
            "head": { "ref": "feature", "sha": "2222222222222222222222222222222222222222" },
            "base": { "ref": "main", "sha": "1111111111111111111111111111111111111111" },
            "changed_files": 501
        }));
        pull_request.changed_files = 501;
        let files = (0..501)
            .map(|index| ReviewPlatformFile {
                path: format!("src/file-{index}.rs"),
                old_path: None,
                status: ReviewFileStatus::Modified,
                additions: 1,
                deletions: 1,
                patch: Some("@@ -1 +1 @@\n-old\n+new".to_string()),
            })
            .collect();

        let target = review_target_from_parts(pull_request, files);

        assert_eq!(target.files.len(), 501);
        assert_eq!(target.omitted_file_count, 0);
        assert!(!target
            .limitations
            .contains(&"review_target_file_limit_exceeded".to_string()));
    }

    #[test]
    fn review_target_marks_collection_budget_as_partial() {
        let mut pull_request = github_pull_request_from_value(&json!({
            "number": 42,
            "title": "Budget-sized review target",
            "state": "open",
            "head": { "ref": "feature", "sha": "2222222222222222222222222222222222222222" },
            "base": { "ref": "main", "sha": "1111111111111111111111111111111111111111" },
            "changed_files": 1000
        }));
        pull_request.changed_files = 1000;
        let files = (0..MAX_REVIEW_TARGET_LIST_ITEMS)
            .map(|index| ReviewPlatformFile {
                path: format!("src/file-{index}.rs"),
                old_path: None,
                status: ReviewFileStatus::Modified,
                additions: 1,
                deletions: 1,
                patch: Some("@@ -1 +1 @@\n-old\n+new".to_string()),
            })
            .collect();

        let target = review_target_from_parts(pull_request, files);

        assert_eq!(target.files.len(), MAX_REVIEW_TARGET_LIST_ITEMS);
        assert_eq!(target.omitted_file_count, 1);
        assert!(target
            .limitations
            .contains(&"provider_file_list_incomplete".to_string()));
    }

    #[test]
    fn review_target_rejects_a_non_empty_but_truncated_provider_patch() {
        let mut pull_request = github_pull_request_from_value(&json!({
            "number": 42,
            "title": "Review target",
            "state": "open",
            "head": { "ref": "feature", "sha": "2222222222222222222222222222222222222222" },
            "base": { "ref": "main", "sha": "1111111111111111111111111111111111111111" },
            "changed_files": 1
        }));
        pull_request.changed_files = 1;

        let target = review_target_from_parts(
            pull_request,
            vec![ReviewPlatformFile {
                path: "src/lib.rs".to_string(),
                old_path: None,
                status: ReviewFileStatus::Modified,
                additions: 10,
                deletions: 10,
                patch: Some("@@ -1 +1 @@\n-old\n+new".to_string()),
            }],
        );

        assert!(!target.files[0].diff_available);
        assert!(target
            .limitations
            .contains(&"provider_file_diff_unavailable".to_string()));
    }

    #[test]
    fn pull_request_file_diff_rejects_changed_head() {
        let pull_request = github_pull_request_from_value(&json!({
            "number": 42,
            "title": "Review target",
            "state": "open",
            "head": { "ref": "feature", "sha": "2222222222222222222222222222222222222222" },
            "base": { "ref": "main", "sha": "1111111111111111111111111111111111111111" }
        }));
        let result = file_diff_from_parts(
            pull_request,
            Vec::new(),
            "1111111111111111111111111111111111111111",
            "3333333333333333333333333333333333333333",
            "src/lib.rs",
        );

        assert!(matches!(result, Err(ReviewPlatformError::StaleTarget(_))));
    }

    #[test]
    fn identity_file_diff_preserves_exact_expected_revisions() {
        let pull_request = github_pull_request_from_value(&json!({
            "number": 42,
            "title": "Review target",
            "state": "open",
            "head": { "sha": "2222222222222222222222222222222222222222" },
            "base": { "sha": "1111111111111111111111111111111111111111" }
        }));
        let diff = file_diff_from_parts(
            pull_request,
            vec![ReviewPlatformFile {
                path: "src/lib.rs".to_string(),
                old_path: None,
                status: ReviewFileStatus::Modified,
                additions: 1,
                deletions: 1,
                patch: Some("@@ -1 +1 @@\n-old\n+new".to_string()),
            }],
            "1111111111111111111111111111111111111111",
            "2222222222222222222222222222222222222222",
            "src/lib.rs",
        )
        .expect("identity diff should preserve exact revisions");

        assert_eq!(
            diff.base_revision,
            "1111111111111111111111111111111111111111"
        );
        assert_eq!(
            diff.head_revision,
            "2222222222222222222222222222222222222222"
        );
        assert!(diff.diff.contains("-old\n+new"));
    }

    #[test]
    fn identity_file_diff_rejects_missing_or_unavailable_patch() {
        let pull_request = github_pull_request_from_value(&json!({
            "number": 42,
            "title": "Review target",
            "state": "open",
            "head": { "sha": "2222222222222222222222222222222222222222" },
            "base": { "sha": "1111111111111111111111111111111111111111" }
        }));
        let result = file_diff_from_parts(
            pull_request,
            vec![ReviewPlatformFile {
                path: "assets/image.png".to_string(),
                old_path: None,
                status: ReviewFileStatus::Modified,
                additions: 0,
                deletions: 0,
                patch: None,
            }],
            "1111111111111111111111111111111111111111",
            "2222222222222222222222222222222222222222",
            "assets/image.png",
        );

        assert!(matches!(result, Err(ReviewPlatformError::Api(_))));
    }

    #[tokio::test]
    async fn identity_file_diff_service_rejects_invalid_provider_id_before_network() {
        let service =
            ReviewPlatformService::new_local_only(temp_token_store_path("identity-file-diff"));

        let result = service
            .pull_request_file_diff_by_identity(
                ReviewPlatformKind::Github,
                "github.com",
                "openai/example",
                "01",
                "1111111111111111111111111111111111111111",
                "2222222222222222222222222222222222222222",
                "src/lib.rs",
                None,
                None,
            )
            .await;

        assert!(matches!(result, Err(ReviewPlatformError::Api(_))));
    }

    #[test]
    fn review_target_rejects_revisions_that_change_during_preparation() {
        let initial = github_pull_request_from_value(&json!({
            "number": 42,
            "title": "Review target",
            "state": "open",
            "head": { "sha": "2222222222222222222222222222222222222222" },
            "base": { "sha": "1111111111111111111111111111111111111111" }
        }));
        let confirmed = github_pull_request_from_value(&json!({
            "number": 42,
            "title": "Review target",
            "state": "open",
            "head": { "sha": "3333333333333333333333333333333333333333" },
            "base": { "sha": "1111111111111111111111111111111111111111" }
        }));

        assert!(matches!(
            ensure_pull_request_revisions_stable(&initial, &confirmed),
            Err(ReviewPlatformError::StaleTarget(_))
        ));
    }

    #[test]
    fn github_review_decision_preserves_state_precedence() {
        let cases = [
            (
                "changes requested beats approved and commented",
                ["APPROVED", "COMMENTED", "CHANGES_REQUESTED"].as_slice(),
                ReviewDecision::ChangesRequested,
            ),
            (
                "approved beats commented",
                ["COMMENTED", "APPROVED"].as_slice(),
                ReviewDecision::Approved,
            ),
            (
                "commented beats unmatched pending state",
                ["PENDING", "COMMENTED"].as_slice(),
                ReviewDecision::Commented,
            ),
            (
                "unmatched state stays pending",
                ["PENDING"].as_slice(),
                ReviewDecision::Pending,
            ),
            (
                "no reviews stays pending",
                [].as_slice(),
                ReviewDecision::Pending,
            ),
        ];

        for (label, states, expected) in cases {
            let reviews = Value::Array(
                states
                    .iter()
                    .enumerate()
                    .map(|(index, state)| {
                        json!({
                            "id": index,
                            "state": state,
                            "user": { "login": format!("reviewer-{index}") }
                        })
                    })
                    .collect(),
            );

            assert_eq!(github_review_decision(&reviews), expected, "{label}");
        }
    }

    #[test]
    fn github_threads_include_issue_comments_and_review_comments() {
        let reviews = json!([]);
        let review_comments = json!([
            {
                "id": 10,
                "path": "src/lib.rs",
                "line": 8,
                "user": { "login": "alice" },
                "body": "Inline comment",
                "updated_at": "2026-05-18T01:00:00Z"
            }
        ]);
        let issue_comments = json!([
            {
                "id": 20,
                "user": { "login": "bob" },
                "body": "Conversation comment",
                "updated_at": "2026-05-18T02:00:00Z"
            }
        ]);

        let threads = github_threads(&reviews, &review_comments, &issue_comments);

        assert_eq!(threads.len(), 2);
        assert_eq!(threads[0].id, "comment-10");
        assert_eq!(threads[0].file_path.as_deref(), Some("src/lib.rs"));
        assert_eq!(threads[1].id, "issue-comment-20");
        assert_eq!(threads[1].file_path, None);
        assert_eq!(threads[1].body, "Conversation comment");
    }

    #[test]
    fn github_threads_keep_empty_body_reviews_visible() {
        let reviews = json!([
            {
                "id": 30,
                "state": "APPROVED",
                "user": { "login": "alice" },
                "body": "",
                "submitted_at": "2026-05-18T03:00:00Z"
            }
        ]);

        let threads = github_threads(&reviews, &json!([]), &json!([]));

        assert_eq!(threads.len(), 1);
        assert_eq!(threads[0].id, "review-30");
        assert_eq!(threads[0].body, "Approved this pull request.");
    }

    #[test]
    fn github_review_comment_replies_track_parent_comment() {
        let threads = github_threads(
            &json!([]),
            &json!([
                {
                    "id": 40,
                    "in_reply_to_id": 10,
                    "user": { "login": "alice" },
                    "body": "Reply",
                    "updated_at": "2026-05-18T04:30:00Z"
                }
            ]),
            &json!([]),
        );

        assert_eq!(threads.len(), 1);
        assert_eq!(threads[0].kind, ReviewPlatformThreadKind::Comment);
        assert_eq!(
            threads[0].reply_to_provider_comment_id.as_deref(),
            Some("10")
        );
    }

    #[test]
    fn gitlab_threads_include_top_level_notes_without_duplication() {
        let discussions = json!([
            {
                "id": "discussion-1",
                "resolved": false,
                "notes": [
                    {
                        "id": "100",
                        "author": { "username": "alice" },
                        "body": "Inline note",
                        "updated_at": "2026-05-18T04:00:00Z",
                        "position": { "new_path": "src/lib.rs", "new_line": 12 }
                    }
                ]
            }
        ]);
        let notes = json!([
            {
                "id": "100",
                "author": { "username": "alice" },
                "body": "Inline note",
                "updated_at": "2026-05-18T04:00:00Z",
                "position": { "new_path": "src/lib.rs", "new_line": 12 }
            },
            {
                "id": "200",
                "author": { "username": "bob" },
                "body": "Top-level note",
                "updated_at": "2026-05-18T05:00:00Z"
            }
        ]);

        let threads = gitlab_threads(&discussions, &notes);

        assert_eq!(threads.len(), 2);
        assert_eq!(threads[0].id, "discussion-discussion-1:note-100");
        assert_eq!(threads[1].id, "note-200");
        assert_eq!(threads[1].file_path, None);
        assert_eq!(threads[1].body, "Top-level note");
    }

    #[test]
    fn gitlab_discussion_threads_mark_root_as_review_and_replies_as_comments() {
        let discussions = json!([
            {
                "id": "discussion-2",
                "resolved": false,
                "notes": [
                    {
                        "id": "300",
                        "author": { "username": "alice" },
                        "body": "Root note",
                        "updated_at": "2026-05-18T06:00:00Z"
                    },
                    {
                        "id": "301",
                        "author": { "username": "bob" },
                        "body": "Reply note",
                        "updated_at": "2026-05-18T06:05:00Z"
                    }
                ]
            }
        ]);

        let threads = gitlab_threads(&discussions, &json!([]));

        assert_eq!(threads.len(), 2);
        assert_eq!(threads[0].kind, ReviewPlatformThreadKind::Review);
        assert_eq!(threads[0].reply_to_provider_comment_id, None);
        assert_eq!(threads[1].kind, ReviewPlatformThreadKind::Comment);
        assert_eq!(
            threads[1].reply_to_provider_comment_id.as_deref(),
            Some("300")
        );
    }

    #[test]
    fn summarize_ci_items_counts_provider_outcomes() {
        let items = vec![
            ReviewPlatformCiItem {
                id: "build".to_string(),
                name: "Build".to_string(),
                status: "completed".to_string(),
                conclusion: Some("success".to_string()),
                detail: None,
                stage: Some("build".to_string()),
                web_url: None,
                log: None,
                log_truncated: false,
                started_at: None,
                finished_at: None,
            },
            ReviewPlatformCiItem {
                id: "test".to_string(),
                name: "Test".to_string(),
                status: "failed".to_string(),
                conclusion: None,
                detail: None,
                stage: Some("test".to_string()),
                web_url: None,
                log: None,
                log_truncated: false,
                started_at: None,
                finished_at: None,
            },
            ReviewPlatformCiItem {
                id: "deploy".to_string(),
                name: "Deploy".to_string(),
                status: "running".to_string(),
                conclusion: None,
                detail: None,
                stage: Some("deploy".to_string()),
                web_url: None,
                log: None,
                log_truncated: false,
                started_at: None,
                finished_at: None,
            },
        ];

        let checks = summarize_ci_items(&items);

        assert_eq!(checks.total, 3);
        assert_eq!(checks.passed, 1);
        assert_eq!(checks.failed, 1);
        assert_eq!(checks.pending, 1);
    }

    #[test]
    fn ci_log_value_extracts_error_excerpt_only() {
        let text = [
            "running setup",
            "downloading dependencies",
            "cargo test failed with exit code 101",
            "thread 'main' panicked at src/lib.rs:4",
            "uploading artifacts",
        ]
        .join("\n");

        let (log, truncated) = ci_log_value(text);

        let log = log.expect("log should be present");
        assert!(!truncated);
        assert!(log.contains("cargo test failed"));
        assert!(log.contains("panicked at src/lib.rs"));
    }

    #[test]
    fn ci_log_value_reports_when_no_error_lines_match() {
        let (log, truncated) = ci_log_value("all checks passed".to_string());

        assert!(!truncated);
        assert!(log.is_none());
    }

    #[test]
    fn ci_trace_transport_truncation_is_preserved_as_partial_log_state() {
        let (log, truncated) = ci_log_value_from_response(ReviewTextResponse {
            text: "error: failed before provider trace budget".to_string(),
            truncated: true,
        });

        assert_eq!(
            log.as_deref(),
            Some("error: failed before provider trace budget")
        );
        assert!(truncated);
    }

    #[tokio::test]
    async fn gitlab_trace_http_failures_propagate_without_provider_body() {
        for status in [401u16, 500u16] {
            let body = "provider-secret-error-body";
            let api_base_url = spawn_single_review_response(
                format!(
                    "HTTP/1.1 {status} Failure\r\nContent-Length: {}\r\nConnection: close\r\n\r\n{body}",
                    body.len()
                )
                .into_bytes(),
            );
            let context = gitlab_trace_context(api_base_url);

            let result = gitlab_pull_request_ci_log(&context, "7", "123", "job").await;

            assert!(matches!(
                result,
                Err(ReviewPlatformError::Http {
                    status: actual,
                    ref message,
                }) if actual == status && message.is_empty()
            ));
        }
    }

    #[tokio::test]
    async fn gitlab_trace_rejects_blank_job_id_without_provider_call() {
        let (api_base_url, provider_called) = spawn_review_request_probe();
        let context = gitlab_trace_context(api_base_url);

        let result = gitlab_pull_request_ci_log(&context, "7", "   ", "job").await;

        assert!(matches!(
            result,
            Err(ReviewPlatformError::Api(ref message))
                if message == "GitLab job id is required"
        ));
        assert!(!provider_called
            .recv_timeout(Duration::from_secs(1))
            .expect("provider request probe should finish"));
    }

    #[tokio::test]
    async fn gitlab_trace_successful_empty_body_remains_empty_evidence() {
        let api_base_url = spawn_single_review_response(
            b"HTTP/1.1 200 OK\r\nContent-Length: 0\r\nConnection: close\r\n\r\n".to_vec(),
        );
        let context = gitlab_trace_context(api_base_url);

        let result = gitlab_pull_request_ci_log(&context, "7", "123", "job")
            .await
            .expect("successful empty trace should remain available");

        assert!(result.log.is_none());
        assert!(!result.truncated);
        assert_eq!(
            result.message.as_deref(),
            Some("No error lines were detected in the job trace.")
        );
    }

    #[tokio::test]
    async fn gitlab_trace_interrupted_chunked_response_propagates_network_failure() {
        let api_base_url = spawn_single_review_response(
            b"HTTP/1.1 200 OK\r\nTransfer-Encoding: chunked\r\nConnection: close\r\n\r\n20\r\nerror"
                .to_vec(),
        );
        let context = gitlab_trace_context(api_base_url);

        let result = gitlab_pull_request_ci_log(&context, "7", "123", "job").await;

        assert!(matches!(result, Err(ReviewPlatformError::Network(_))));
    }

    fn github_issue_fixture() -> Value {
        json!({
            "number": 42,
            "html_url": "https://github.com/example/repo/issues/42",
            "title": "Provider Issue evidence",
            "body": "Keep the complete Issue body.",
            "state": "open",
            "user": { "login": "alice" },
            "labels": [
                { "name": "review" },
                { "name": "bug" }
            ],
            "created_at": "2026-07-11T00:00:00Z",
            "updated_at": "2026-07-11T01:00:00Z"
        })
    }

    fn github_issue_comments_fixture() -> Value {
        json!([{
            "id": 7,
            "html_url": "https://github.com/example/repo/issues/42#issuecomment-7",
            "user": { "login": "bob" },
            "body": "The first comment.",
            "created_at": "2026-07-11T02:00:00Z",
            "updated_at": "2026-07-11T02:30:00Z"
        }])
    }

    fn github_issue_identity() -> ProviderIssueIdentity {
        ProviderIssueIdentity::new(
            ReviewPlatformKind::Github,
            "github.com",
            "example/repo",
            "42",
        )
        .expect("GitHub identity fixture should be valid")
    }

    #[test]
    fn github_issue_mapping_preserves_body_labels_and_comment_pagination() {
        let evidence = map_github_issue(
            &github_issue_identity(),
            &github_issue_fixture(),
            &github_issue_comments_fixture(),
            IssuePagination::new(Some(1), Some(100)),
            true,
            Some("2".to_string()),
        )
        .expect("GitHub fixture should map");

        assert_eq!(evidence.issue_id, "42");
        assert_eq!(evidence.body, "Keep the complete Issue body.");
        assert_eq!(evidence.labels, vec!["bug", "review"]);
        assert_eq!(evidence.comments.len(), 1);
        assert!(evidence.has_more_comments);
        assert_eq!(evidence.next_cursor.as_deref(), Some("2"));
        assert_eq!(evidence.completeness, ReviewEvidenceCompleteness::Partial);
        assert_eq!(
            evidence.limitations,
            vec!["issue_comments_paginated".to_string()]
        );
    }

    #[test]
    fn gitlab_issue_mapping_preserves_description_labels_and_note_identity() {
        let identity = ProviderIssueIdentity::new(
            ReviewPlatformKind::Gitlab,
            "gitlab.com",
            "example/group/repo",
            "42",
        )
        .expect("GitLab identity fixture should be valid");
        let evidence = map_gitlab_issue(
            &identity,
            &json!({
                "iid": 42,
                "web_url": "https://gitlab.com/example/group/repo/-/issues/42",
                "title": "GitLab Issue evidence",
                "description": "Keep the complete GitLab description.",
                "state": "opened",
                "author": { "username": "alice" },
                "labels": ["review", "bug"],
                "created_at": "2026-07-11T00:00:00Z",
                "updated_at": "2026-07-11T01:00:00Z"
            }),
            &json!([{
                "id": 9,
                "author": { "username": "bob" },
                "body": "The first note.",
                "created_at": "2026-07-11T02:00:00Z",
                "updated_at": "2026-07-11T02:30:00Z",
                "system": false
            }]),
            IssuePagination::new(Some(1), Some(100)),
            false,
            None,
        )
        .expect("GitLab fixture should map");

        assert_eq!(evidence.issue_id, "42");
        assert_eq!(evidence.body, "Keep the complete GitLab description.");
        assert_eq!(evidence.labels, vec!["bug", "review"]);
        assert_eq!(evidence.comments[0].id, "9");
        assert_eq!(evidence.comments[0].author.as_deref(), Some("bob"));
        assert_eq!(evidence.completeness, ReviewEvidenceCompleteness::Complete);
        assert!(evidence.limitations.is_empty());
        assert!(!evidence.has_more_comments);
        assert!(evidence.next_cursor.is_none());
    }

    #[test]
    fn issue_mapping_bounds_one_comment_page_to_one_hundred() {
        let comments = Value::Array(
            (0..101)
                .map(|id| {
                    json!({
                        "id": id,
                        "user": { "login": "reviewer" },
                        "body": format!("comment {id}")
                    })
                })
                .collect(),
        );
        let evidence = map_github_issue(
            &github_issue_identity(),
            &github_issue_fixture(),
            &comments,
            IssuePagination::new(Some(1), Some(250)),
            false,
            None,
        )
        .expect("oversized fixture should be bounded");

        assert_eq!(evidence.comments.len(), 100);
        assert!(evidence.has_more_comments);
        assert_eq!(evidence.next_cursor.as_deref(), Some("2"));
        assert_eq!(evidence.completeness, ReviewEvidenceCompleteness::Partial);
        assert!(evidence
            .limitations
            .contains(&"issue_comments_page_bounded".to_string()));
    }

    #[test]
    fn issue_mapping_later_page_reports_omitted_previous_comments() {
        let evidence = map_github_issue(
            &github_issue_identity(),
            &github_issue_fixture(),
            &github_issue_comments_fixture(),
            IssuePagination::new(Some(2), Some(100)),
            false,
            None,
        )
        .expect("later page fixture should map");

        assert_eq!(evidence.completeness, ReviewEvidenceCompleteness::Partial);
        assert!(evidence
            .limitations
            .contains(&"issue_comments_previous_pages_omitted".to_string()));
        assert!(!evidence.has_more_comments);
        assert!(evidence.next_cursor.is_none());
    }

    #[test]
    fn issue_mapping_rejects_github_pull_request_payloads_with_typed_error() {
        let mut issue = github_issue_fixture();
        issue["pull_request"] = json!({
            "url": "https://api.github.com/repos/example/repo/pulls/42"
        });

        let result = map_github_issue(
            &github_issue_identity(),
            &issue,
            &github_issue_comments_fixture(),
            IssuePagination::new(None, None),
            false,
            None,
        );

        assert!(matches!(
            result,
            Err(ReviewPlatformError::TargetIsPullRequest { .. })
        ));
    }

    #[test]
    fn issue_mapping_rejects_issue_body_over_unicode_scalar_budget() {
        let mut issue = github_issue_fixture();
        issue["body"] = json!("界".repeat(MAX_ISSUE_BODY_CHARS + 1));

        let result = map_github_issue(
            &github_issue_identity(),
            &issue,
            &json!([]),
            IssuePagination::new(None, None),
            false,
            None,
        );

        assert!(matches!(
            result,
            Err(ReviewPlatformError::EvidenceTooLarge { ref resource, .. })
                if resource == "issue_body"
        ));
    }

    #[test]
    fn issue_mapping_truncates_oversized_comment_bodies_as_partial_evidence() {
        let comments = json!([{
            "id": 7,
            "user": { "login": "bob" },
            "body": "界".repeat(MAX_ISSUE_COMMENT_BODY_CHARS + 1),
            "created_at": "2026-07-11T02:00:00Z"
        }]);

        let evidence = map_github_issue(
            &github_issue_identity(),
            &github_issue_fixture(),
            &comments,
            IssuePagination::new(None, None),
            false,
            None,
        )
        .expect("oversized comment should degrade structurally");

        assert_eq!(
            evidence.comments[0].body.chars().count(),
            MAX_ISSUE_COMMENT_BODY_CHARS
        );
        assert_eq!(evidence.completeness, ReviewEvidenceCompleteness::Partial);
        assert!(evidence
            .limitations
            .contains(&"issue_comment_body_truncated".to_string()));
    }

    #[test]
    fn issue_mapping_bounds_aggregate_comment_unicode_scalars() {
        let comments = Value::Array(
            (1..=17)
                .map(|id| {
                    json!({
                        "id": id,
                        "user": { "login": "reviewer" },
                        "body": "界".repeat(MAX_ISSUE_COMMENT_BODY_CHARS),
                        "created_at": format!("2026-07-11T{id:02}:00:00Z")
                    })
                })
                .collect(),
        );

        let evidence = map_github_issue(
            &github_issue_identity(),
            &github_issue_fixture(),
            &comments,
            IssuePagination::new(None, None),
            false,
            None,
        )
        .expect("aggregate overflow should degrade structurally");
        let aggregate_chars = evidence
            .comments
            .iter()
            .map(|comment| comment.body.chars().count())
            .sum::<usize>();

        assert!(aggregate_chars <= MAX_ISSUE_COMMENTS_AGGREGATE_CHARS);
        assert_eq!(evidence.completeness, ReviewEvidenceCompleteness::Partial);
        assert!(evidence
            .limitations
            .contains(&"issue_comments_aggregate_truncated".to_string()));
    }

    #[test]
    fn gitlab_issue_mapping_filters_system_notes_and_orders_comments_ascending() {
        let identity = ProviderIssueIdentity::new(
            ReviewPlatformKind::Gitlab,
            "gitlab.com",
            "example/repo",
            "42",
        )
        .expect("GitLab identity should be valid");
        let issue = json!({
            "iid": 42,
            "title": "Issue",
            "description": "Body",
            "state": "opened"
        });
        let notes = json!([
            { "id": 2, "body": "later", "created_at": "2026-07-11T03:00:00Z", "system": false },
            { "id": 99, "body": "system", "created_at": "2026-07-11T02:30:00Z", "system": true },
            { "id": 1, "body": "earlier", "created_at": "2026-07-11T02:00:00Z", "system": false }
        ]);

        let evidence = map_gitlab_issue(
            &identity,
            &issue,
            &notes,
            IssuePagination::new(None, None),
            false,
            None,
        )
        .expect("GitLab notes should map");

        assert_eq!(
            evidence
                .comments
                .iter()
                .map(|comment| comment.id.as_str())
                .collect::<Vec<_>>(),
            vec!["1", "2"]
        );
    }

    #[test]
    fn issue_mapping_fingerprint_is_deterministic_and_content_sensitive() {
        let first = map_github_issue(
            &github_issue_identity(),
            &github_issue_fixture(),
            &github_issue_comments_fixture(),
            IssuePagination::new(None, None),
            false,
            None,
        )
        .expect("first fixture should map");
        let reordered = map_github_issue(
            &github_issue_identity(),
            &json!({
                "updated_at": "2026-07-11T01:00:00Z",
                "labels": [{ "name": "bug" }, { "name": "review" }],
                "state": "open",
                "title": "Provider Issue evidence",
                "number": 42,
                "body": "Keep the complete Issue body.",
                "html_url": "https://github.com/example/repo/issues/42",
                "created_at": "2026-07-11T00:00:00Z",
                "user": { "login": "alice" }
            }),
            &github_issue_comments_fixture(),
            IssuePagination::new(None, None),
            false,
            None,
        )
        .expect("reordered fixture should map");
        let changed = map_github_issue(
            &github_issue_identity(),
            &github_issue_fixture(),
            &json!([{
                "id": 7,
                "html_url": "https://github.com/example/repo/issues/42#issuecomment-7",
                "user": { "login": "bob" },
                "body": "Changed comment content.",
                "created_at": "2026-07-11T02:00:00Z",
                "updated_at": "2026-07-11T02:30:00Z"
            }]),
            IssuePagination::new(None, None),
            false,
            None,
        )
        .expect("changed fixture should map");

        assert_eq!(first.fingerprint, reordered.fingerprint);
        assert_ne!(first.fingerprint, changed.fingerprint);
        assert!(first.fingerprint.starts_with("sha256:"));
    }

    #[test]
    fn issue_mapping_fingerprint_canonicalizes_comment_order() {
        let comments = json!([
            {
                "id": 8,
                "user": { "login": "carol" },
                "body": "Later comment.",
                "created_at": "2026-07-11T03:00:00Z"
            },
            {
                "id": 7,
                "user": { "login": "bob" },
                "body": "Earlier comment.",
                "created_at": "2026-07-11T02:00:00Z"
            }
        ]);
        let reversed = Value::Array(
            comments
                .as_array()
                .expect("fixture should be an array")
                .iter()
                .rev()
                .cloned()
                .collect(),
        );
        let first = map_github_issue(
            &github_issue_identity(),
            &github_issue_fixture(),
            &comments,
            IssuePagination::new(None, None),
            false,
            None,
        )
        .expect("first order should map");
        let second = map_github_issue(
            &github_issue_identity(),
            &github_issue_fixture(),
            &reversed,
            IssuePagination::new(None, None),
            false,
            None,
        )
        .expect("reversed order should map");

        assert_eq!(first.fingerprint, second.fingerprint);
        assert_eq!(first.comments[0].id, "7");
        assert_eq!(second.comments[0].id, "7");
    }

    #[test]
    fn issue_mapping_fingerprint_includes_page_and_evidence_state() {
        let complete = map_github_issue(
            &github_issue_identity(),
            &github_issue_fixture(),
            &github_issue_comments_fixture(),
            IssuePagination::new(Some(1), Some(100)),
            false,
            None,
        )
        .expect("complete page should map");
        let has_more = map_github_issue(
            &github_issue_identity(),
            &github_issue_fixture(),
            &github_issue_comments_fixture(),
            IssuePagination::new(Some(1), Some(100)),
            true,
            Some("2".to_string()),
        )
        .expect("partial page should map");
        let later_page = map_github_issue(
            &github_issue_identity(),
            &github_issue_fixture(),
            &github_issue_comments_fixture(),
            IssuePagination::new(Some(2), Some(100)),
            false,
            None,
        )
        .expect("later page should map");

        assert_ne!(complete.fingerprint, has_more.fingerprint);
        assert_ne!(complete.fingerprint, later_page.fingerprint);
        assert_ne!(has_more.fingerprint, later_page.fingerprint);
    }

    #[test]
    fn issue_mapping_rejects_non_array_comment_payloads() {
        let result = map_github_issue(
            &github_issue_identity(),
            &github_issue_fixture(),
            &json!({ "message": "not an array" }),
            IssuePagination::new(None, None),
            false,
            None,
        );

        assert!(matches!(result, Err(ReviewPlatformError::Parse(_))));
    }

    #[test]
    fn issue_mapping_identity_plan_normalizes_public_hosts_and_rejects_unsafe_input() {
        let tokens = ReviewPlatformAuthTokens::default();
        let public = provider_context_for_identity(
            ReviewPlatformKind::Github,
            " GitHub.COM. ",
            "example/repo.git",
            &tokens,
        )
        .expect("official GitHub should allow anonymous evidence reads");

        assert_eq!(public.remote.host, "github.com");
        assert_eq!(public.remote.project_path, "example/repo");
        assert_eq!(public.api_base_url, "https://api.github.com");
        assert!(public.token.is_none());

        assert!(provider_context_for_identity(
            ReviewPlatformKind::Github,
            "https://github.com",
            "example/repo",
            &tokens,
        )
        .is_err());
        assert!(provider_context_for_identity(
            ReviewPlatformKind::Github,
            "github.com",
            "example/../repo",
            &tokens,
        )
        .is_err());
    }

    #[test]
    fn issue_mapping_identity_rejects_zero_and_leading_zero_ids() {
        for invalid in ["0", "00", "042", "-1", "+1", " 1"] {
            assert!(
                ProviderIssueIdentity::new(
                    ReviewPlatformKind::Github,
                    "github.com",
                    "example/repo",
                    invalid,
                )
                .is_err(),
                "{invalid:?} must be rejected"
            );
        }
        assert!(ProviderIssueIdentity::new(
            ReviewPlatformKind::Github,
            "github.com",
            "example/repo",
            "42",
        )
        .is_ok());
    }

    #[test]
    fn issue_mapping_identity_plan_requires_stored_token_for_non_public_hosts() {
        let mut tokens = ReviewPlatformAuthTokens::default();
        assert!(provider_context_for_identity(
            ReviewPlatformKind::Gitlab,
            "gitlab.example.internal",
            "group/repo",
            &tokens,
        )
        .is_err());

        tokens.tokens.insert(
            token_key(ReviewPlatformKind::Gitlab, "gitlab.example.internal")
                .expect("token key should be valid"),
            "stored-token".to_string(),
        );
        let trusted = provider_context_for_identity(
            ReviewPlatformKind::Gitlab,
            "gitlab.example.internal",
            "group/repo",
            &tokens,
        )
        .expect("stored token should authorize an existing self-hosted provider context");

        assert_eq!(
            trusted.api_base_url,
            "https://gitlab.example.internal/api/v4"
        );
        assert_eq!(trusted.token.as_deref(), Some("stored-token"));
    }

    #[test]
    fn existing_self_hosted_github_remote_ignores_stored_tokens() {
        let host = "github.example.internal";
        let mut tokens = ReviewPlatformAuthTokens::default();
        tokens.tokens.insert(
            token_key(ReviewPlatformKind::Github, host).expect("token key should be valid"),
            "stored-token".to_string(),
        );
        let identity_context = provider_context_for_identity(
            ReviewPlatformKind::Github,
            host,
            "example/repo",
            &tokens,
        )
        .expect("GitHub CLI should authorize a self-hosted GitHub context");

        let existing_remote_context = provider_context(identity_context.remote, &tokens)
            .expect("existing remote context should remain valid");

        assert_eq!(
            existing_remote_context.api_base_url,
            "https://github.example.internal/api/v3"
        );
        assert_eq!(existing_remote_context.token, None);
        assert_eq!(
            existing_remote_context.remote.auth_source,
            ReviewAuthSource::GhCli
        );
    }

    #[test]
    fn remote_detection_rejects_brand_substring_attacker_hosts() {
        let remote = parse_remote(
            "origin",
            "https://github.com.attacker/example/repo.git",
            &ReviewPlatformAuthTokens::default(),
        )
        .expect("syntactically valid Git remote should be represented");

        assert_eq!(remote.platform, ReviewPlatformKind::Unknown);
        assert!(!remote.supported);
    }

    #[test]
    fn workspace_remote_identity_matcher_requires_exact_host_and_project() {
        assert!(remote_url_matches_provider_identity(
            "https://code.company.internal/group/repo.git",
            ReviewPlatformKind::Gitlab,
            "code.company.internal",
            "group/repo",
        ));
        assert!(!remote_url_matches_provider_identity(
            "https://other.company.internal/group/repo.git",
            ReviewPlatformKind::Gitlab,
            "code.company.internal",
            "group/repo",
        ));
        assert!(!remote_url_matches_provider_identity(
            "https://code.company.internal/other/repo.git",
            ReviewPlatformKind::Gitlab,
            "code.company.internal",
            "group/repo",
        ));
        assert!(!remote_url_matches_provider_identity(
            "https://github.com.attacker/example/repo.git",
            ReviewPlatformKind::Github,
            "github.com",
            "example/repo",
        ));
        assert!(remote_url_matches_provider_identity(
            "https://github.com.attacker/example/repo.git",
            ReviewPlatformKind::Github,
            "github.com.attacker",
            "example/repo",
        ));
    }

    #[tokio::test]
    async fn remote_detection_uses_exact_token_authority_for_internal_provider_kind() {
        let repository = tempfile::tempdir().expect("temporary repository should be created");
        let repository_path = repository
            .path()
            .to_str()
            .expect("repository path should be UTF-8");
        execute_git_command(repository_path, &["init"])
            .await
            .expect("temporary repository should initialize");
        execute_git_command(
            repository_path,
            &[
                "remote",
                "add",
                "origin",
                "https://code.company.internal/group/repo.git",
            ],
        )
        .await
        .expect("internal remote should be added");
        let token_path = temp_token_store_path("internal-provider-authority");
        let service = ReviewPlatformService::new_local_only(token_path.clone());
        service
            .update_auth_token(
                ReviewPlatformKind::Gitlab,
                "code.company.internal",
                "internal-token",
            )
            .await
            .expect("exact GitLab authority should be stored");

        let remotes = service
            .discover_remotes(&ReviewRepositoryLocator::legacy_path(repository_path))
            .await
            .expect("registered internal remote should be discovered");

        assert_eq!(remotes.len(), 1);
        assert_eq!(remotes[0].platform, ReviewPlatformKind::Gitlab);
        assert_eq!(remotes[0].host, "code.company.internal");
        assert!(remotes[0].supported);
        let _ = fs::remove_file(token_path).await;
    }

    #[tokio::test]
    async fn identity_trust_accepts_exact_discovered_self_hosted_remote_without_token() {
        let repository = tempfile::tempdir().expect("temporary repository should be created");
        execute_git_command(
            repository
                .path()
                .to_str()
                .expect("repository path should be UTF-8"),
            &["init"],
        )
        .await
        .expect("temporary repository should initialize");
        execute_git_command(
            repository
                .path()
                .to_str()
                .expect("repository path should be UTF-8"),
            &[
                "remote",
                "add",
                "origin",
                "https://gitlab.example.internal/group/repo.git",
            ],
        )
        .await
        .expect("trusted remote should be added");
        let service = ReviewPlatformService::new_local_only(temp_token_store_path("trust"));
        let tokens = ReviewPlatformAuthTokens::default();

        let context = service
            .provider_context_for_identity_request(
                ReviewPlatformKind::Gitlab,
                "gitlab.example.internal",
                "group/repo",
                Some(&ReviewRepositoryLocator::legacy_path(
                    repository
                        .path()
                        .to_str()
                        .expect("repository path should be UTF-8"),
                )),
                &tokens,
            )
            .await
            .expect("exact discovered remote should establish anonymous trust");

        assert!(context.token.is_none());
        assert_eq!(context.remote.project_path, "group/repo");
    }

    #[tokio::test]
    async fn identity_trust_rejects_unrelated_workspace_remote_without_token() {
        let repository = tempfile::tempdir().expect("temporary repository should be created");
        execute_git_command(
            repository
                .path()
                .to_str()
                .expect("repository path should be UTF-8"),
            &["init"],
        )
        .await
        .expect("temporary repository should initialize");
        execute_git_command(
            repository
                .path()
                .to_str()
                .expect("repository path should be UTF-8"),
            &[
                "remote",
                "add",
                "origin",
                "https://gitlab.example.internal/other/repo.git",
            ],
        )
        .await
        .expect("unrelated remote should be added");
        let service = ReviewPlatformService::new_local_only(temp_token_store_path("untrusted"));
        let tokens = ReviewPlatformAuthTokens::default();

        let result = service
            .provider_context_for_identity_request(
                ReviewPlatformKind::Gitlab,
                "gitlab.example.internal",
                "group/repo",
                Some(&ReviewRepositoryLocator::legacy_path(
                    repository
                        .path()
                        .to_str()
                        .expect("repository path should be UTF-8"),
                )),
                &tokens,
            )
            .await;

        assert!(matches!(result, Err(ReviewPlatformError::Api(_))));
    }

    #[tokio::test]
    async fn identity_trust_accepts_stored_token_without_workspace_path() {
        let service = ReviewPlatformService::new_local_only(temp_token_store_path("token-trust"));
        let mut tokens = ReviewPlatformAuthTokens::default();
        tokens.tokens.insert(
            token_key(ReviewPlatformKind::Gitlab, "gitlab.example.internal")
                .expect("token key should normalize"),
            "stored-token".to_string(),
        );

        let context = service
            .provider_context_for_identity_request(
                ReviewPlatformKind::Gitlab,
                "gitlab.example.internal",
                "group/repo",
                None,
                &tokens,
            )
            .await
            .expect("stored token should authorize without workspace trust");

        assert_eq!(context.token.as_deref(), Some("stored-token"));
    }

    #[test]
    fn issue_acquisition_request_plans_use_exact_github_and_gitlab_endpoints() {
        assert_eq!(MAX_ISSUE_RESPONSE_BYTES, 2 * 1024 * 1024);
        assert_eq!(MAX_ISSUE_COMMENTS_RESPONSE_BYTES, 8 * 1024 * 1024);
        let tokens = ReviewPlatformAuthTokens::default();
        let github_identity = github_issue_identity();
        let github_context = provider_context_for_identity(
            github_identity.platform,
            &github_identity.host,
            &github_identity.project_path,
            &tokens,
        )
        .expect("GitHub context should be valid");
        let github = issue_request_plan(
            &github_context,
            &github_identity,
            IssuePagination::new(Some(2), Some(250)),
        )
        .expect("GitHub request plan should be valid");
        assert_eq!(
            github.issue_url,
            "https://api.github.com/repos/example/repo/issues/42"
        );
        assert_eq!(
            github.comments_url,
            "https://api.github.com/repos/example/repo/issues/42/comments"
        );
        assert_eq!(github.pagination.page, 2);
        assert_eq!(github.pagination.per_page, 100);

        let gitlab_identity = ProviderIssueIdentity::new(
            ReviewPlatformKind::Gitlab,
            "gitlab.com",
            "example/group/repo",
            "42",
        )
        .expect("GitLab identity should be valid");
        let gitlab_context = provider_context_for_identity(
            gitlab_identity.platform,
            &gitlab_identity.host,
            &gitlab_identity.project_path,
            &tokens,
        )
        .expect("GitLab context should be valid");
        let gitlab = issue_request_plan(
            &gitlab_context,
            &gitlab_identity,
            IssuePagination::new(None, None),
        )
        .expect("GitLab request plan should be valid");
        assert_eq!(
            gitlab.issue_url,
            "https://gitlab.com/api/v4/projects/example%2Fgroup%2Frepo/issues/42"
        );
        assert_eq!(
            gitlab.comments_url,
            "https://gitlab.com/api/v4/projects/example%2Fgroup%2Frepo/issues/42/notes"
        );
        assert_eq!(
            gitlab.comments_query,
            vec![
                ("order_by".to_string(), "created_at".to_string()),
                ("sort".to_string(), "asc".to_string()),
                ("activity_filter".to_string(), "only_comments".to_string()),
            ]
        );
    }

    #[test]
    fn issue_acquisition_maps_oversized_detail_to_typed_unavailable_error() {
        let error = review_evidence_http_error(
            ReviewHttpError::ResponseTooLarge {
                limit_bytes: MAX_ISSUE_RESPONSE_BYTES,
            },
            "issue_response",
        );

        assert!(matches!(
            error,
            ReviewPlatformError::EvidenceTooLarge { ref resource, limit }
                if resource == "issue_response" && limit == MAX_ISSUE_RESPONSE_BYTES
        ));
    }

    #[test]
    fn issue_acquisition_maps_oversized_comments_to_structured_partial_evidence() {
        let evidence = map_issue_comments_response(
            &github_issue_identity(),
            &github_issue_fixture(),
            IssuePagination::new(None, None),
            Err(ReviewPlatformError::EvidenceTooLarge {
                resource: "issue_comments_response".to_string(),
                limit: MAX_ISSUE_COMMENTS_RESPONSE_BYTES,
            }),
        )
        .expect("oversized comments should degrade structurally");

        assert!(evidence.comments.is_empty());
        assert_eq!(evidence.completeness, ReviewEvidenceCompleteness::Partial);
        assert!(evidence
            .limitations
            .contains(&"issue_comments_response_too_large".to_string()));
        assert!(!evidence.has_more_comments);
        assert!(evidence.next_cursor.is_none());
    }

    #[test]
    fn issue_acquisition_rejects_github_pull_request_payload() {
        let identity = github_issue_identity();
        let result = reject_pull_request_issue_target(
            &identity,
            &json!({
                "number": 42,
                "pull_request": {
                    "url": "https://api.github.com/repos/example/repo/pulls/42"
                }
            }),
        );

        assert!(matches!(
            result,
            Err(ReviewPlatformError::TargetIsPullRequest { .. })
        ));
    }

    #[test]
    fn identity_pr_target_plan_reuses_existing_provider_dispatch_without_workspace_git() {
        let tokens = ReviewPlatformAuthTokens::default();
        let identity = pull_request_identity_plan(
            ReviewPlatformKind::Github,
            "github.com",
            "example/repo",
            "42",
            &tokens,
        )
        .expect("public GitHub identity should not require a workspace remote");
        let existing_remote_context = provider_context(identity.context.remote.clone(), &tokens)
            .expect("existing remote context should be valid");

        assert_eq!(identity.pull_request_id, "42");
        assert_eq!(identity.context.remote.project_path, "example/repo");
        assert!(std::ptr::eq(
            provider_for(identity.context.remote.platform),
            provider_for(existing_remote_context.remote.platform),
        ));
    }
}
