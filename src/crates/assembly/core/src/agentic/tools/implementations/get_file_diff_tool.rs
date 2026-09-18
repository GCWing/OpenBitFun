use crate::agentic::tools::framework::{
    Tool, ToolExposure, ToolRenderOptions, ToolResult, ToolUseContext, ValidationResult,
};
use crate::agentic::tools::workspace_paths::is_openbitfun_tool_uri;
use crate::service::git::git_service::GitService;
use crate::service::git::git_types::GitDiffParams;
use crate::service::git::git_utils::get_repository_root;
use crate::service::review_platform::{
    ReviewPlatformError, ReviewPlatformKind, ReviewPlatformPullRequestFileDiff,
    ReviewPlatformService, ReviewRepositoryLocator,
};
use crate::service::snapshot::manager::get_snapshot_manager_for_workspace;
use crate::util::errors::{OpenBitFunError, OpenBitFunResult};
use async_trait::async_trait;
use log::{debug, warn};
use openbitfun_agent_runtime::deep_review::{
    admit_review_provider_diff_acquisition, record_review_diff_limitation, record_review_diff_page,
    record_review_target_stale, review_diff_budget_exhausted, review_diff_page_was_returned,
    ReviewDiffBudgetAdmission, ReviewTargetEvidence, ReviewTargetEvidenceSource,
};
use serde_json::{json, Value};
use sha2::{Digest, Sha256};
use similar::ChangeTag;
use similar::TextDiff;
use std::fs;
use std::path::Path;

/// Get file diff tool
///
/// Priority order:
/// 1. Baseline snapshot diff (if exists)
/// 2. Git HEAD diff (if git repository)
/// 3. Return full file content
pub struct GetFileDiffTool;

type ExactReviewTarget = (String, String, Vec<String>, Option<String>);

struct ExactReviewDiffRequest<'a> {
    workspace_root: &'a Path,
    logical_path: &'a str,
    base_revision: &'a str,
    head_revision: &'a str,
    paths: &'a [String],
    fingerprint: Option<&'a str>,
    diff_offset: usize,
    cursor_binding: &'a str,
}

#[derive(Debug, Clone, PartialEq, Eq)]
enum ProviderFileDiffRoute {
    Identity {
        platform: ReviewPlatformKind,
        host: String,
        project_path: String,
        pull_request_id: String,
        base_revision: String,
        head_revision: String,
        file_path: String,
        file_page_hint: Option<u32>,
        repository: Option<ReviewRepositoryLocator>,
    },
    WorkspaceRemote {
        repository: ReviewRepositoryLocator,
        remote_id: String,
        pull_request_id: String,
        base_revision: String,
        head_revision: String,
        file_path: String,
        file_page_hint: Option<u32>,
    },
    Unavailable,
}

#[async_trait]
trait ProviderFileDiffService: Sync {
    async fn acquire(
        &self,
        route: &ProviderFileDiffRoute,
    ) -> Result<ReviewPlatformPullRequestFileDiff, ReviewPlatformError>;
}

struct CoreProviderFileDiffService;

#[async_trait]
impl ProviderFileDiffService for CoreProviderFileDiffService {
    async fn acquire(
        &self,
        route: &ProviderFileDiffRoute,
    ) -> Result<ReviewPlatformPullRequestFileDiff, ReviewPlatformError> {
        match route {
            ProviderFileDiffRoute::Identity {
                platform,
                host,
                project_path,
                pull_request_id,
                base_revision,
                head_revision,
                file_path,
                file_page_hint,
                repository,
            } => {
                ReviewPlatformService::pull_request_file_diff_by_identity(
                    *platform,
                    host,
                    project_path,
                    pull_request_id,
                    base_revision,
                    head_revision,
                    file_path,
                    *file_page_hint,
                    repository.as_ref(),
                )
                .await
            }
            ProviderFileDiffRoute::WorkspaceRemote {
                repository,
                remote_id,
                pull_request_id,
                base_revision,
                head_revision,
                file_path,
                file_page_hint,
            } => {
                ReviewPlatformService::pull_request_file_diff(
                    repository,
                    remote_id,
                    pull_request_id,
                    base_revision,
                    head_revision,
                    file_path,
                    *file_page_hint,
                )
                .await
            }
            ProviderFileDiffRoute::Unavailable => Err(ReviewPlatformError::Api(
                "Prepared provider diff route is unavailable".to_string(),
            )),
        }
    }
}
const REVIEW_NEW_FILE_CONTENT_LIMIT: u64 = 16 * 1024;
// Keep prepared pages below the shared 50k-character persistence threshold so
// every page remains directly visible even when live repository reads are
// intentionally unavailable.
const PREPARED_REVIEW_DIFF_PAGE_CHARS: usize = 40_000;
const PREPARED_REVIEW_DIFF_TOTAL_CHARS: usize = 80_000;

impl Default for GetFileDiffTool {
    fn default() -> Self {
        Self::new()
    }
}

impl GetFileDiffTool {
    fn review_budget_identity(context: &ToolUseContext) -> Option<(&str, &str)> {
        let parent_turn_id = context
            .custom_data
            .get("deep_review_parent_dialog_turn_id")
            .and_then(Value::as_str)
            .or(context.dialog_turn_id.as_deref())
            .or(context.session_id.as_deref())?;
        let reviewer_id = context
            .custom_data
            .get("deep_review_parent_tool_call_id")
            .and_then(Value::as_str)
            .or(context.session_id.as_deref())
            .or_else(|| {
                context
                    .custom_data
                    .get("deep_review_subagent_type")
                    .and_then(Value::as_str)
            })
            .or(context.agent_type.as_deref())
            .unwrap_or("CodeReview");
        Some((parent_turn_id, reviewer_id))
    }

    pub fn new() -> Self {
        Self
    }

    fn target_evidence(context: &ToolUseContext) -> OpenBitFunResult<Option<ReviewTargetEvidence>> {
        let Some(manifest) = context.custom_data.get("deep_review_run_manifest") else {
            return Ok(None);
        };
        ReviewTargetEvidence::from_context_value(manifest).map_err(|error| {
            OpenBitFunError::tool(format!("Invalid prepared Review target evidence: {error}"))
        })
    }

    fn pull_request_file_diff_route(
        context: &ToolUseContext,
        evidence: &ReviewTargetEvidence,
        logical_path: &str,
    ) -> OpenBitFunResult<ProviderFileDiffRoute> {
        let pull_request = evidence.pull_request().ok_or_else(|| {
            OpenBitFunError::tool(
                "Prepared pull request Review identity is unavailable".to_string(),
            )
        })?;
        let platform = match pull_request.platform() {
            "github" => Some(ReviewPlatformKind::Github),
            "gitlab" => Some(ReviewPlatformKind::Gitlab),
            "gitee" => Some(ReviewPlatformKind::Gitee),
            "gitcode" => None,
            value => {
                return Err(OpenBitFunError::tool(format!(
                    "Prepared pull request provider is unsupported: {value}"
                )))
            }
        };
        let base_revision = evidence.base_revision().ok_or_else(|| {
            OpenBitFunError::tool("Prepared pull request base revision is unavailable".to_string())
        })?;
        let head_revision = evidence.head_revision().ok_or_else(|| {
            OpenBitFunError::tool("Prepared pull request head revision is unavailable".to_string())
        })?;
        let file_page_hint = evidence.file_page_hint_for_path(logical_path, 100);
        if let Some(platform) = platform {
            return Ok(ProviderFileDiffRoute::Identity {
                platform,
                host: pull_request.host().to_string(),
                project_path: pull_request.project_path().to_string(),
                pull_request_id: pull_request.pull_request_id().to_string(),
                base_revision: base_revision.to_string(),
                head_revision: head_revision.to_string(),
                file_path: logical_path.to_string(),
                file_page_hint,
                repository: context.workspace_root().map(|path| {
                    ReviewRepositoryLocator::new(
                        context.workspace_id().map(str::to_string),
                        path.to_string_lossy().into_owned(),
                    )
                }),
            });
        }
        let Some(repository_path) = context.workspace_root() else {
            return Ok(ProviderFileDiffRoute::Unavailable);
        };
        if pull_request.remote_id().trim().is_empty() {
            return Ok(ProviderFileDiffRoute::Unavailable);
        }
        Ok(ProviderFileDiffRoute::WorkspaceRemote {
            repository: ReviewRepositoryLocator::new(
                context.workspace_id().map(str::to_string),
                repository_path.to_string_lossy().into_owned(),
            ),
            remote_id: pull_request.remote_id().to_string(),
            pull_request_id: pull_request.pull_request_id().to_string(),
            base_revision: base_revision.to_string(),
            head_revision: head_revision.to_string(),
            file_path: logical_path.to_string(),
            file_page_hint,
        })
    }

    fn workspace_relative_path(file_path: &Path, context: &ToolUseContext) -> Option<String> {
        let workspace_root = context.workspace_root()?;
        file_path.strip_prefix(workspace_root).ok().map(|path| {
            Self::normalize_workspace_relative_path_text(
                path.to_string_lossy().as_ref(),
                cfg!(windows),
            )
        })
    }

    fn normalize_workspace_relative_path_text(path: &str, windows: bool) -> String {
        if windows {
            path.replace('\\', "/")
        } else {
            path.to_string()
        }
    }

    fn is_symlink_or_reparse_point(metadata: &fs::Metadata) -> bool {
        if metadata.file_type().is_symlink() {
            return true;
        }
        #[cfg(windows)]
        {
            use std::os::windows::fs::MetadataExt;
            const FILE_ATTRIBUTE_REPARSE_POINT: u32 = 0x0400;
            metadata.file_attributes() & FILE_ATTRIBUTE_REPARSE_POINT != 0
        }
        #[cfg(not(windows))]
        false
    }

    fn ensure_prepared_target_path(
        relative_path: Option<&str>,
        context: &ToolUseContext,
    ) -> OpenBitFunResult<()> {
        if relative_path.is_none() && Self::target_evidence(context)?.is_some() {
            return Err(OpenBitFunError::tool(
                "Prepared Review targets only allow workspace-relative target paths".to_string(),
            ));
        }
        Ok(())
    }

    fn exact_review_target(
        relative_path: &str,
        context: &ToolUseContext,
    ) -> OpenBitFunResult<Option<ExactReviewTarget>> {
        let Some(evidence) = Self::target_evidence(context)? else {
            return Ok(None);
        };
        if !evidence.contains_file(relative_path) {
            return Err(OpenBitFunError::tool(
                "Requested file is outside the prepared Review target evidence".to_string(),
            ));
        }
        let Some((base, head)) = evidence.diff_revisions_for_path(relative_path) else {
            if evidence.source()
                != openbitfun_agent_runtime::deep_review::ReviewTargetEvidenceSource::Workspace
            {
                return Err(OpenBitFunError::tool(
                    "Prepared Review target does not provide a consumable exact diff for this file; preserve limited coverage"
                        .to_string(),
                ));
            }
            return Ok(None);
        };
        let paths = evidence.diff_paths_for_path(relative_path);
        Ok(Some((
            base.to_string(),
            head.to_string(),
            paths,
            Some(evidence.fingerprint().to_string()),
        )))
    }

    async fn exact_review_diff(
        &self,
        request: ExactReviewDiffRequest<'_>,
    ) -> OpenBitFunResult<Value> {
        let ExactReviewDiffRequest {
            workspace_root,
            logical_path,
            base_revision,
            head_revision,
            paths,
            fingerprint,
            diff_offset,
            cursor_binding,
        } = request;
        let diff_content =
            GitService::get_review_diff(workspace_root, base_revision, head_revision, paths)
                .await
                .map_err(|error| {
                    OpenBitFunError::tool(format!(
                        "Failed to read prepared Review target diff: {error}"
                    ))
                })?;
        let mut additions = 0usize;
        let mut deletions = 0usize;
        for line in diff_content.lines() {
            if line.starts_with('+') && !line.starts_with("+++") {
                additions += 1;
            } else if line.starts_with('-') && !line.starts_with("---") {
                deletions += 1;
            }
        }
        Self::paginate_prepared_diff(
            json!({
                "file_path": logical_path,
                "diff_type": "review_target",
                "diff_format": "unified",
                "diff_content": diff_content,
                "original_content": "",
                "modified_content": "",
                "base_revision": base_revision,
                "head_revision": head_revision,
                "target_fingerprint": fingerprint,
                "stats": {
                    "additions": additions,
                    "deletions": deletions
                },
                "message": "Diff from prepared Review target revisions"
            }),
            diff_offset,
            cursor_binding,
            logical_path,
        )
    }

    async fn pull_request_review_diff(
        &self,
        context: &ToolUseContext,
        evidence: &ReviewTargetEvidence,
        logical_path: &str,
        diff_offset: usize,
    ) -> OpenBitFunResult<Option<Value>> {
        self.pull_request_review_diff_with_service(
            context,
            evidence,
            logical_path,
            diff_offset,
            &CoreProviderFileDiffService,
        )
        .await
    }

    async fn pull_request_review_diff_with_service(
        &self,
        context: &ToolUseContext,
        evidence: &ReviewTargetEvidence,
        logical_path: &str,
        diff_offset: usize,
        service: &dyn ProviderFileDiffService,
    ) -> OpenBitFunResult<Option<Value>> {
        if evidence.source() != ReviewTargetEvidenceSource::PullRequest {
            return Ok(None);
        }
        if !evidence.contains_file(logical_path) {
            return Err(OpenBitFunError::tool(
                "Requested file is outside the prepared Review target evidence".to_string(),
            ));
        }
        if evidence.file_completeness_for_path(logical_path) != Some("complete") {
            if let Some((parent_turn_id, _)) = Self::review_budget_identity(context) {
                record_review_diff_limitation(parent_turn_id);
            }
            return Ok(Some(Self::limited_review_diff_data(
                logical_path,
                "limited",
                "provider_file_diff_unavailable",
                "Exact provider diff is unavailable for this prepared pull request file",
            )));
        }
        let route = Self::pull_request_file_diff_route(context, evidence, logical_path)?;
        if route == ProviderFileDiffRoute::Unavailable {
            if let Some((parent_turn_id, _)) = Self::review_budget_identity(context) {
                record_review_diff_limitation(parent_turn_id);
            }
            return Ok(Some(Self::limited_review_diff_data(
                logical_path,
                "limited",
                "provider_file_diff_unavailable",
                "Exact provider diff requires the prepared workspace remote binding",
            )));
        }
        let Some((parent_turn_id, _)) = Self::review_budget_identity(context) else {
            return Ok(Some(Self::limited_review_diff_data(
                logical_path,
                "limited",
                "review_provider_acquisition_budget_unavailable",
                "Provider diff acquisition allowance cannot be tracked for this Review turn",
            )));
        };
        if !admit_review_provider_diff_acquisition(parent_turn_id) {
            return Ok(Some(Self::limited_review_diff_data(
                logical_path,
                "limited",
                "review_provider_acquisition_budget_exhausted",
                "Provider diff acquisition allowance exhausted for this Review turn",
            )));
        }
        let diff = match service.acquire(&route).await {
            Ok(diff) => diff,
            Err(ReviewPlatformError::StaleTarget(_)) => {
                if let Some((parent_turn_id, _)) = Self::review_budget_identity(context) {
                    record_review_target_stale(parent_turn_id);
                }
                return Ok(Some(Self::limited_review_diff_data(
                    logical_path,
                    "stale",
                    "pull_request_head_changed",
                    "Pull request head changed after Review target preparation",
                )));
            }
            Err(error) => {
                if let Some((parent_turn_id, _)) = Self::review_budget_identity(context) {
                    record_review_diff_limitation(parent_turn_id);
                }
                let limitation = match error {
                    ReviewPlatformError::Http {
                        status: 401 | 403, ..
                    } => "pull_request_auth_unavailable",
                    ReviewPlatformError::Network(_) | ReviewPlatformError::Http { .. } => {
                        "pull_request_provider_unavailable"
                    }
                    _ => "provider_file_diff_unavailable",
                };
                return Ok(Some(Self::limited_review_diff_data(
                    logical_path,
                    "limited",
                    limitation,
                    "Prepared pull request diff could not be read from the provider",
                )));
            }
        };
        let mut additions = 0usize;
        let mut deletions = 0usize;
        for line in diff.diff.lines() {
            if line.starts_with('+') && !line.starts_with("+++") {
                additions += 1;
            } else if line.starts_with('-') && !line.starts_with("---") {
                deletions += 1;
            }
        }
        Ok(Some(Self::paginate_prepared_diff(
            json!({
                "file_path": logical_path,
                "diff_type": "review_target",
                "diff_format": "unified",
                "diff_content": diff.diff,
                "original_content": "",
                "modified_content": "",
                "base_revision": diff.base_revision,
                "head_revision": diff.head_revision,
                "target_fingerprint": evidence.fingerprint(),
                "stats": {
                    "additions": additions,
                    "deletions": deletions
                },
                "message": "Diff from prepared pull request target"
            }),
            diff_offset,
            evidence.fingerprint(),
            logical_path,
        )?))
    }

    fn review_cursor(binding: &str, path: &str, offset: usize) -> String {
        let digest = Sha256::digest(format!("{binding}\0{path}\0{offset}").as_bytes());
        format!("review-v1:{offset}:{}", hex::encode(&digest[..8]))
    }

    fn review_cursor_offset(
        cursor: Option<&str>,
        binding: &str,
        path: &str,
    ) -> OpenBitFunResult<usize> {
        let Some(cursor) = cursor else {
            return Ok(0);
        };
        let mut parts = cursor.split(':');
        let version = parts.next();
        let offset = parts.next().and_then(|value| value.parse::<usize>().ok());
        let signature = parts.next();
        if version != Some("review-v1") || parts.next().is_some() {
            return Err(OpenBitFunError::tool(
                "Invalid prepared Review continuation cursor".to_string(),
            ));
        }
        let Some(offset) = offset else {
            return Err(OpenBitFunError::tool(
                "Invalid prepared Review continuation cursor".to_string(),
            ));
        };
        let expected = Self::review_cursor(binding, path, offset);
        if signature.is_none() || expected != cursor {
            return Err(OpenBitFunError::tool(
                "Prepared Review continuation cursor does not match this target file".to_string(),
            ));
        }
        Ok(offset)
    }

    fn paginate_prepared_diff(
        mut data: Value,
        diff_offset: usize,
        cursor_binding: &str,
        logical_path: &str,
    ) -> OpenBitFunResult<Value> {
        let diff = data
            .get("diff_content")
            .and_then(Value::as_str)
            .unwrap_or_default();
        let chars = diff.chars().collect::<Vec<_>>();
        let total_chars = chars.len();
        let consumable_chars = total_chars.min(PREPARED_REVIEW_DIFF_TOTAL_CHARS);
        if diff_offset > consumable_chars {
            return Err(OpenBitFunError::tool(format!(
                "diff_offset {} exceeds prepared Review diff budget {}",
                diff_offset, consumable_chars
            )));
        }

        let end = diff_offset
            .saturating_add(PREPARED_REVIEW_DIFF_PAGE_CHARS)
            .min(consumable_chars);
        let page = chars[diff_offset..end].iter().collect::<String>();
        let has_more = end < consumable_chars;
        let budget_truncated = total_chars > consumable_chars;

        data["diff_content"] = Value::String(page);
        // Prepared results never need to duplicate source bodies. Keeping
        // these fields empty also prevents the structured payload from
        // bypassing the model-facing page budget.
        data["original_content"] = Value::String(String::new());
        data["modified_content"] = Value::String(String::new());
        data["cursor"] = if diff_offset == 0 {
            Value::Null
        } else {
            json!(Self::review_cursor(
                cursor_binding,
                logical_path,
                diff_offset
            ))
        };
        data["returned_chars"] = json!(end.saturating_sub(diff_offset));
        data["total_diff_chars"] = json!(total_chars);
        data["has_more"] = json!(has_more);
        data["next_cursor"] = if has_more {
            json!(Self::review_cursor(cursor_binding, logical_path, end))
        } else {
            Value::Null
        };
        data["diff_budget_truncated"] = json!(budget_truncated);
        data["omitted_diff_chars"] = json!(total_chars.saturating_sub(consumable_chars));
        Ok(data)
    }

    /// Generate unified diff format
    fn generate_unified_diff(&self, old: &str, new: &str) -> String {
        let diff = TextDiff::from_lines(old, new);
        diff.unified_diff().to_string()
    }

    /// Calculate diff statistics
    fn calculate_diff_stats(&self, old: &str, new: &str) -> (usize, usize) {
        let diff = TextDiff::from_lines(old, new);
        let mut additions = 0;
        let mut deletions = 0;

        for change in diff.iter_all_changes() {
            match change.tag() {
                ChangeTag::Delete => deletions += 1,
                ChangeTag::Insert => additions += 1,
                ChangeTag::Equal => {}
            }
        }

        (additions, deletions)
    }

    fn diff_for_assistant(data: &Value) -> String {
        if data
            .get("review_budget_repeated_page")
            .and_then(Value::as_bool)
            == Some(true)
        {
            let continuation = data
                .get("next_cursor")
                .and_then(Value::as_str)
                .map(|cursor| format!(" Continue with next_cursor={cursor} if needed."))
                .unwrap_or_default();
            return format!(
                "This prepared Review diff page was already returned. Reuse the prior page instead of reading it again.{continuation}"
            );
        }
        if data.get("evidence_limited").and_then(Value::as_bool) == Some(true) {
            let message = data
                .get("message")
                .and_then(Value::as_str)
                .unwrap_or("Prepared Review evidence is limited");
            return format!(
                "{message}. Preserve the uncovered scope as limited evidence and do not retry this page."
            );
        }
        let mut text = data
            .get("diff_content")
            .and_then(Value::as_str)
            .filter(|diff| !diff.is_empty())
            .unwrap_or("Prepared Review target has no textual diff for this file.")
            .to_string();
        if data.get("has_more").and_then(Value::as_bool) == Some(true) {
            let next_cursor = data
                .get("next_cursor")
                .and_then(Value::as_str)
                .unwrap_or_default();
            text.push_str(&format!(
                "\n\n[Prepared Review diff continues. If this file still needs validation within the remaining Review budget, call GetFileDiff again with cursor={next_cursor}.]"
            ));
        } else if data.get("diff_budget_truncated").and_then(Value::as_bool) == Some(true) {
            let omitted = data
                .get("omitted_diff_chars")
                .and_then(Value::as_u64)
                .unwrap_or_default();
            text.push_str(&format!(
                "\n\n[Prepared Review diff budget exhausted; {omitted} characters were omitted. Preserve reduced coverage.]"
            ));
        }
        text
    }

    fn apply_review_diff_budget(
        mut data: Value,
        context: &ToolUseContext,
        binding: &str,
        path: &str,
        diff_offset: usize,
    ) -> Value {
        let Some((parent_turn_id, reviewer_id)) = Self::review_budget_identity(context) else {
            return Self::limited_review_diff_data(
                path,
                "limited",
                "review_budget_tracking_unavailable",
                "Prepared Review diff budget cannot be tracked for this turn",
            );
        };
        if data.get("diff_budget_truncated").and_then(Value::as_bool) == Some(true) {
            record_review_diff_limitation(parent_turn_id);
        }
        let page_key = Self::review_cursor(binding, path, diff_offset);
        let returned_chars = data
            .get("returned_chars")
            .and_then(Value::as_u64)
            .and_then(|value| usize::try_from(value).ok())
            .unwrap_or_default();
        match record_review_diff_page(
            parent_turn_id,
            reviewer_id,
            &format!("{binding}:{path}:{page_key}"),
            returned_chars,
        ) {
            ReviewDiffBudgetAdmission::Accepted { repeated_page } => {
                data["review_budget_repeated_page"] = json!(repeated_page);
                if repeated_page {
                    data["diff_content"] = Value::String(String::new());
                    data["original_content"] = Value::String(String::new());
                    data["modified_content"] = Value::String(String::new());
                    data["returned_chars"] = json!(0);
                }
                data
            }
            ReviewDiffBudgetAdmission::Exhausted => json!({
                "file_path": path,
                "diff_type": "review_target",
                "diff_format": "unified",
                "diff_content": "",
                "original_content": "",
                "modified_content": "",
                "has_more": false,
                "next_cursor": null,
                "returned_chars": 0,
                "evidence_limited": true,
                "limitation": "review_diff_budget_exhausted",
                "message": "Prepared Review diff allowance exhausted"
            }),
        }
    }

    fn repeated_review_diff_data(
        context: &ToolUseContext,
        binding: &str,
        path: &str,
        diff_offset: usize,
    ) -> Option<Value> {
        let (parent_turn_id, reviewer_id) = Self::review_budget_identity(context)?;
        let cursor = Self::review_cursor(binding, path, diff_offset);
        let page_key = format!("{binding}:{path}:{cursor}");
        review_diff_page_was_returned(parent_turn_id, reviewer_id, &page_key).then(|| {
            json!({
                "file_path": path,
                "diff_type": "review_target",
                "diff_format": "unified",
                "diff_content": "",
                "original_content": "",
                "modified_content": "",
                "has_more": false,
                "next_cursor": null,
                "returned_chars": 0,
                "review_budget_repeated_page": true
            })
        })
    }

    fn limited_review_diff_data(
        path: &str,
        evidence_status: &str,
        limitation: &str,
        message: &str,
    ) -> Value {
        json!({
            "file_path": path,
            "diff_type": "review_target",
            "diff_format": "unified",
            "diff_content": "",
            "original_content": "",
            "modified_content": "",
            "has_more": false,
            "next_cursor": null,
            "returned_chars": 0,
            "evidence_limited": true,
            "evidence_status": evidence_status,
            "limitation": limitation,
            "message": message
        })
    }

    async fn workspace_binding_limitation(
        context: &ToolUseContext,
        evidence: &ReviewTargetEvidence,
        path: &str,
    ) -> Option<Value> {
        if evidence.source() != ReviewTargetEvidenceSource::Workspace {
            return None;
        }
        let base_revision = match evidence.base_revision() {
            Some(revision) => revision,
            None => {
                return Some(Self::limited_review_diff_data(
                    path,
                    "limited",
                    "workspace_base_revision_unavailable",
                    "Prepared Review workspace base revision is unavailable",
                ))
            }
        };
        let workspace_root = match context.workspace_root() {
            Some(root) => root,
            None => {
                return Some(Self::limited_review_diff_data(
                    path,
                    "limited",
                    "workspace_root_unavailable",
                    "Prepared Review workspace root is unavailable",
                ))
            }
        };
        let repository_root = match get_repository_root(workspace_root) {
            Ok(root) => root,
            Err(_) => {
                return Some(Self::limited_review_diff_data(
                    path,
                    "limited",
                    "workspace_repository_unavailable",
                    "Prepared Review Git repository is unavailable",
                ))
            }
        };
        let current_head = match GitService::resolve_revision(&repository_root, "HEAD").await {
            Ok(revision) => revision,
            Err(_) => {
                return Some(Self::limited_review_diff_data(
                    path,
                    "limited",
                    "workspace_head_unavailable",
                    "Prepared Review workspace HEAD could not be verified",
                ))
            }
        };
        if current_head != base_revision {
            return Some(Self::limited_review_diff_data(
                path,
                "stale",
                "workspace_head_changed",
                "Prepared Review workspace HEAD changed after target preparation",
            ));
        }
        None
    }

    /// Try to get diff from baseline
    async fn try_baseline_diff(
        &self,
        file_path: &Path,
        workspace_id: Option<&str>,
    ) -> Option<OpenBitFunResult<Value>> {
        let snapshot_manager = workspace_id.and_then(get_snapshot_manager_for_workspace)?;

        // Get snapshot service
        let snapshot_service = snapshot_manager.get_snapshot_service();
        let snapshot_service = snapshot_service.read().await;

        // Get baseline snapshot ID
        let baseline_id = snapshot_service.get_baseline_snapshot_id(file_path).await;

        if let Some(id) = baseline_id {
            debug!("GetFileDiff tool found baseline snapshot: {}", id);

            // Read current file content
            let current_content = fs::read_to_string(file_path).ok()?;

            // Read baseline content
            let baseline_content = match snapshot_service.get_snapshot_content(&id).await {
                Ok(content) => content,
                Err(e) => {
                    warn!("GetFileDiff tool failed to read baseline content: {}", e);
                    return None;
                }
            };

            // Generate diff
            let diff_content = self.generate_unified_diff(&baseline_content, &current_content);

            // Calculate statistics
            let (additions, deletions) =
                self.calculate_diff_stats(&baseline_content, &current_content);

            return Some(Ok(json!({
                "file_path": file_path,
                "diff_type": "baseline",
                "diff_format": "unified",
                "diff_content": diff_content,
                "original_content": baseline_content,
                "modified_content": current_content,
                "stats": {
                    "additions": additions,
                    "deletions": deletions
                },
                "message": format!("Diff from baseline snapshot (ID: {})", id)
            })));
        }

        None
    }

    /// Try to get diff from git
    async fn try_git_diff(
        &self,
        file_path: &Path,
        review_safe: bool,
        review_status: Option<&str>,
        review_paths: Option<&[String]>,
        review_workspace_root: Option<&Path>,
    ) -> Option<OpenBitFunResult<Value>> {
        // Get directory containing the file
        let file_dir = file_path.parent()?;
        let prepared_workspace_root = if review_safe {
            match review_workspace_root {
                Some(root) => Some(root),
                None => {
                    return Some(Err(OpenBitFunError::tool(
                        "Workspace root is required for prepared Review diff".to_string(),
                    )))
                }
            }
        } else {
            None
        };

        // Preserve the legacy repository probe exactly. Prepared Review uses
        // repository discovery so nested target files remain consumable.
        if !review_safe {
            let is_repo = match GitService::is_repository(file_dir).await {
                Ok(repo) => repo,
                Err(e) => {
                    debug!("GetFileDiff tool git check failed: {}", e);
                    return None;
                }
            };
            if !is_repo {
                debug!("GetFileDiff tool path is not a git repository");
                return None;
            }
        }

        debug!("GetFileDiff tool detected git repository");

        let current_content = if review_safe {
            String::new()
        } else {
            // A deleted target has no current content; other read failures
            // preserve the legacy behavior outside prepared Review.
            match fs::read_to_string(file_path) {
                Ok(content) => content,
                Err(error) if error.kind() == std::io::ErrorKind::NotFound => String::new(),
                Err(e) => {
                    warn!("GetFileDiff tool failed to read current file: {}", e);
                    return None;
                }
            }
        };

        // Calculate file's relative path to repository root
        let repository_discovery_root = prepared_workspace_root.unwrap_or(file_dir);
        let repo_root = match get_repository_root(repository_discovery_root) {
            Ok(root) => root,
            Err(e) => {
                if review_safe {
                    return Some(Err(OpenBitFunError::tool(format!(
                        "Prepared Review Git repository is unavailable: {e}"
                    ))));
                }
                warn!("GetFileDiff tool failed to get repository root: {}", e);
                return None;
            }
        };

        let repo_root_path = Path::new(&repo_root);
        let relative_path = match file_path.strip_prefix(repo_root_path) {
            Ok(path) => path,
            Err(e) => {
                warn!("GetFileDiff tool failed to calculate relative path: {}", e);
                return None;
            }
        };

        let relative_path_str = Self::normalize_workspace_relative_path_text(
            relative_path.to_string_lossy().as_ref(),
            cfg!(windows),
        );
        debug!("GetFileDiff tool file relative path: {}", relative_path_str);

        // Try to get git diff (working tree vs HEAD)
        // Note: git diff HEAD -- <file> shows differences between working tree and HEAD (including unstaged changes)
        let files = if review_safe {
            let workspace_root = prepared_workspace_root.expect("prepared root checked above");
            let paths = review_paths
                .filter(|paths| !paths.is_empty())
                .unwrap_or(&[]);
            if paths.is_empty() {
                vec![relative_path_str.clone()]
            } else {
                let mut repo_paths = Vec::with_capacity(paths.len());
                for path in paths {
                    let absolute = workspace_root.join(path);
                    let repo_relative = match absolute.strip_prefix(repo_root_path) {
                        Ok(path) => path,
                        Err(_) => {
                            return Some(Err(OpenBitFunError::tool(
                                "Prepared Review path is outside the discovered Git repository"
                                    .to_string(),
                            )))
                        }
                    };
                    repo_paths.push(Self::normalize_workspace_relative_path_text(
                        repo_relative.to_string_lossy().as_ref(),
                        cfg!(windows),
                    ));
                }
                repo_paths
            }
        } else {
            vec![relative_path_str.clone()]
        };
        let git_diff_params = GitDiffParams {
            source: Some("HEAD".to_string()),
            files: Some(files),
            review_safe: Some(review_safe),
            ..Default::default()
        };

        let git_cwd = if review_safe {
            repo_root_path
        } else {
            file_dir
        };
        let diff_output = match GitService::get_diff(git_cwd, &git_diff_params).await {
            Ok(diff) => diff,
            Err(e) => {
                if review_safe {
                    return Some(Err(OpenBitFunError::tool(format!(
                        "Prepared Review Git diff is unavailable within the safety boundary: {e}"
                    ))));
                }
                warn!(
                    "GetFileDiff tool git diff failed: {}, attempting to get HEAD content",
                    e
                );
                // Try to get HEAD file content, then generate diff
                let head_content = match GitService::get_file_content(
                    file_dir,
                    &relative_path_str,
                    Some("HEAD"),
                )
                .await
                {
                    Ok(content) => content,
                    Err(e) => {
                        debug!("GetFileDiff tool failed to get HEAD file content: {}, file may be new or untracked", e);
                        // New file or untracked file, use empty string as original content
                        String::new()
                    }
                };

                // Generate diff
                let diff_content = self.generate_unified_diff(&head_content, &current_content);

                // Calculate statistics
                let (additions, deletions) =
                    self.calculate_diff_stats(&head_content, &current_content);

                return Some(Ok(json!({
                    "file_path": file_path,
                    "diff_type": "git",
                    "diff_format": "unified",
                    "diff_content": diff_content,
                    "original_content": head_content,
                    "modified_content": current_content,
                    "git_ref": "HEAD",
                    "stats": {
                        "additions": additions,
                        "deletions": deletions
                    },
                    "message": "Diff from Git HEAD (calculated, new or untracked file)"
                })));
            }
        };

        // Parse git diff output, extract statistics
        let mut additions = 0;
        let mut deletions = 0;
        for line in diff_output.lines() {
            if line.starts_with('+') && !line.starts_with("++") {
                additions += 1;
            } else if line.starts_with('-') && !line.starts_with("--") {
                deletions += 1;
            }
        }

        if review_safe {
            let (diff_content, modified_content, additions, deletions) =
                if diff_output.is_empty() && review_status == Some("added") {
                    let metadata = fs::symlink_metadata(file_path).map_err(|error| {
                        OpenBitFunError::tool(format!(
                            "Failed to inspect prepared Review new file: {error}"
                        ))
                    });
                    let metadata = match metadata {
                        Ok(metadata) => metadata,
                        Err(error) => return Some(Err(error)),
                    };
                    if Self::is_symlink_or_reparse_point(&metadata) {
                        return Some(Err(OpenBitFunError::tool(
                        "Prepared Review does not read untracked symlink or reparse-point targets"
                            .to_string(),
                    )));
                    }
                    let size = metadata.len();
                    if size > REVIEW_NEW_FILE_CONTENT_LIMIT {
                        return Some(Err(OpenBitFunError::tool(format!(
                            "Prepared Review new file exceeds the {} byte safety limit",
                            REVIEW_NEW_FILE_CONTENT_LIMIT
                        ))));
                    }
                    let content = match fs::read_to_string(file_path) {
                        Ok(content) => content,
                        Err(error) => {
                            return Some(Err(OpenBitFunError::tool(format!(
                                "Failed to read prepared Review new file: {error}"
                            ))))
                        }
                    };
                    let diff = self.generate_unified_diff("", &content);
                    let (additions, deletions) = self.calculate_diff_stats("", &content);
                    (diff, content, additions, deletions)
                } else {
                    (diff_output, String::new(), additions, deletions)
                };
            return Some(Ok(json!({
                "file_path": file_path,
                "diff_type": "git",
                "diff_format": "unified",
                "diff_content": diff_content,
                "original_content": "",
                "modified_content": modified_content,
                "git_ref": "HEAD",
                "stats": {
                    "additions": additions,
                    "deletions": deletions
                },
                "message": "Diff from prepared Review workspace target"
            })));
        }

        // Get HEAD file content to maintain consistent return structure
        let original_content =
            match GitService::get_file_content(file_dir, &relative_path_str, Some("HEAD")).await {
                Ok(content) => content,
                Err(e) => {
                    warn!("GetFileDiff tool failed to get HEAD file content: {}", e);
                    // If fetch fails, use empty string
                    String::new()
                }
            };

        let diff_output =
            if diff_output.is_empty() && original_content.is_empty() && !current_content.is_empty()
            {
                self.generate_unified_diff("", &current_content)
            } else {
                diff_output
            };
        if additions == 0 && deletions == 0 && !diff_output.is_empty() {
            (additions, deletions) = self.calculate_diff_stats(&original_content, &current_content);
        }

        Some(Ok(json!({
            "file_path": file_path,
            "diff_type": "git",
            "diff_format": "unified",
            "diff_content": diff_output,
            "original_content": original_content,
            "modified_content": current_content,
            "git_ref": "HEAD",
            "stats": {
                "additions": additions,
                "deletions": deletions
            },
            "message": "Diff from Git HEAD"
        })))
    }

    /// Return full file content
    fn return_full_content(&self, file_path: &Path) -> OpenBitFunResult<Value> {
        let content = fs::read_to_string(file_path)
            .map_err(|e| OpenBitFunError::tool(format!("Failed to read file: {}", e)))?;

        let total_lines = content.lines().count();

        Ok(json!({
            "file_path": file_path,
            "diff_type": "full",
            "diff_format": "unified",
            "diff_content": content.clone(),
            "original_content": "",
            "modified_content": content,
            "stats": {
                "additions": 0,
                "deletions": 0,
                "total_lines": total_lines
            },
            "message": "File full content (no baseline or git found)"
        }))
    }
}

#[async_trait]
impl Tool for GetFileDiffTool {
    fn name(&self) -> &str {
        "GetFileDiff"
    }

    async fn description(&self) -> OpenBitFunResult<String> {
        Ok(
            r#"Gets the diff for a file, showing changes from its baseline or Git HEAD.

This tool compares the current file content against:
1. Baseline snapshot (if available) - the state before AI modifications
2. Git HEAD (if in a git repository) - the last committed version
3. Full file content (if neither baseline nor git is available)

Usage:
- The file_path parameter must be workspace-relative, an absolute path inside the current workspace, or an exact `openbitfun://...` URI returned by another tool.
- The diff is returned in unified diff format, showing additions (+) and deletions (-).
- The response includes diff_type indicating the source: "baseline", "git", or "full".
- The response includes stats for additions and deletions.
- This tool is read-only and safe to use for code review and analysis.
"#
            .to_string(),
        )
    }

    async fn description_with_context(
        &self,
        context: Option<&ToolUseContext>,
    ) -> OpenBitFunResult<String> {
        let prepared = context
            .and_then(|context| Self::target_evidence(context).ok().flatten())
            .is_some();
        if !prepared {
            return self.description().await;
        }
        Ok(
            r#"Gets the target-bound diff for one file in a prepared Review.

The Review session binds immutable Git-range revisions or a fixed workspace file list and preparation-time base revision. Workspace content remains mutable, so the tool verifies HEAD before reading it. The tool never guesses refs, widens scope, falls back to another baseline, or returns unbounded full-file content.

Usage:
- Pass only a prepared workspace-relative target file.
- The response is unified diff data with additions/deletions and target metadata.
- Diff pages and total Review evidence are bounded. When has_more is true, pass next_cursor as cursor only if further validation is worth the remaining Review budget.
- Partial or budget-truncated evidence must remain visible as reduced coverage.
"#
            .to_string(),
        )
    }

    fn short_description(&self) -> String {
        "Show the diff for a file against its baseline snapshot or Git HEAD.".to_string()
    }

    fn default_exposure(&self) -> ToolExposure {
        ToolExposure::Deferred
    }

    fn input_schema(&self) -> Value {
        json!({
            "type": "object",
            "properties": {
                "file_path": {
                    "type": "string",
                    "description": "The file to get diff for. Use a workspace-relative path, an absolute path inside the current workspace, or an exact openbitfun:// URI returned by another tool."
                }
            },
            "required": ["file_path"],
            "additionalProperties": false
        })
    }

    async fn input_schema_for_model_with_context(&self, context: Option<&ToolUseContext>) -> Value {
        let mut schema = self.input_schema();
        let prepared = context
            .and_then(|context| Self::target_evidence(context).ok().flatten())
            .is_some();
        if prepared {
            schema["properties"]["cursor"] = json!({
                "type": "string",
                "description": "Opaque prepared Review continuation cursor. Omit for the first page and reuse only the next_cursor returned for this same file."
            });
        }
        schema
    }

    fn is_readonly(&self) -> bool {
        true
    }

    fn is_concurrency_safe(&self, _input: Option<&Value>) -> bool {
        true
    }

    async fn validate_input(
        &self,
        input: &Value,
        context: Option<&ToolUseContext>,
    ) -> ValidationResult {
        if let Some(file_path) = input.get("file_path").and_then(|v| v.as_str()) {
            if file_path.is_empty() {
                return ValidationResult {
                    result: false,
                    message: Some("file_path cannot be empty".to_string()),
                    error_code: Some(400),
                    meta: None,
                };
            }

            let resolved = match context.map(|ctx| ctx.resolve_tool_path(file_path)) {
                Some(Ok(value)) => value,
                Some(Err(err)) => {
                    return ValidationResult {
                        result: false,
                        message: Some(err.to_string()),
                        error_code: Some(400),
                        meta: None,
                    };
                }
                None => {
                    if is_openbitfun_tool_uri(file_path) {
                        return ValidationResult {
                            result: false,
                            message: Some(
                                "Tool context is required to resolve OpenBitFun URIs".to_string(),
                            ),
                            error_code: Some(400),
                            meta: None,
                        };
                    }
                    let path = Path::new(file_path);
                    if !path.is_absolute() {
                        return ValidationResult {
                            result: false,
                            message: Some("file_path must be absolute".to_string()),
                            error_code: Some(400),
                            meta: None,
                        };
                    }
                    if !path.exists() {
                        return ValidationResult {
                            result: false,
                            message: Some(format!("File does not exist: {}", file_path)),
                            error_code: Some(404),
                            meta: None,
                        };
                    }
                    if !path.is_file() {
                        return ValidationResult {
                            result: false,
                            message: Some(format!("Path is not a file: {}", file_path)),
                            error_code: Some(400),
                            meta: None,
                        };
                    }
                    return ValidationResult {
                        result: true,
                        message: None,
                        error_code: None,
                        meta: None,
                    };
                }
            };

            if input
                .get("cursor")
                .is_some_and(|value| value.as_str().is_none())
            {
                return ValidationResult {
                    result: false,
                    message: Some("cursor must be a string returned by GetFileDiff".to_string()),
                    error_code: Some(400),
                    meta: None,
                };
            }
            let relative_path = context.and_then(|ctx| {
                Self::workspace_relative_path(Path::new(&resolved.resolved_path), ctx)
            });
            if let Some(context) = context {
                if let Err(error) =
                    Self::ensure_prepared_target_path(relative_path.as_deref(), context)
                {
                    return ValidationResult {
                        result: false,
                        message: Some(error.to_string()),
                        error_code: Some(400),
                        meta: None,
                    };
                }
            }
            let (prepared_range_available, prepared_deleted_target) = if let Some(context) = context
            {
                match Self::target_evidence(context) {
                    Ok(Some(evidence)) => (
                        relative_path.as_deref().is_some_and(|path| {
                            evidence.source() == ReviewTargetEvidenceSource::PullRequest
                                || evidence.diff_revisions_for_path(path).is_some()
                        }),
                        relative_path.as_deref().is_some_and(|path| {
                            evidence.file_status_for_path(path) == Some("deleted")
                        }),
                    ),
                    Ok(None) => (false, false),
                    Err(error) => {
                        return ValidationResult {
                            result: false,
                            message: Some(error.to_string()),
                            error_code: Some(400),
                            meta: None,
                        };
                    }
                }
            } else {
                (false, false)
            };

            if !resolved.uses_remote_workspace_backend()
                && !prepared_range_available
                && !prepared_deleted_target
            {
                let path = Path::new(&resolved.resolved_path);
                if !path.exists() {
                    return ValidationResult {
                        result: false,
                        message: Some(format!("File does not exist: {}", resolved.logical_path)),
                        error_code: Some(404),
                        meta: None,
                    };
                }

                if !path.is_file() {
                    return ValidationResult {
                        result: false,
                        message: Some(format!("Path is not a file: {}", resolved.logical_path)),
                        error_code: Some(400),
                        meta: None,
                    };
                }
            }
        } else {
            return ValidationResult {
                result: false,
                message: Some("file_path is required".to_string()),
                error_code: Some(400),
                meta: None,
            };
        }

        ValidationResult {
            result: true,
            message: None,
            error_code: None,
            meta: None,
        }
    }

    fn render_tool_use_message(&self, input: &Value, options: &ToolRenderOptions) -> String {
        if let Some(file_path) = input.get("file_path").and_then(|v| v.as_str()) {
            if options.verbose {
                format!("Getting diff for file: {}", file_path)
            } else {
                format!("GetFileDiff {}", file_path)
            }
        } else {
            "Getting file diff".to_string()
        }
    }

    fn render_tool_result_message(&self, output: &Value) -> String {
        if let Some(diff_type) = output.get("diff_type").and_then(|v| v.as_str()) {
            if let Some(message) = output.get("message").and_then(|v| v.as_str()) {
                format!("{} ({})", message, diff_type)
            } else {
                diff_type.to_string()
            }
        } else {
            "File diff retrieved".to_string()
        }
    }

    async fn call_impl(
        &self,
        input: &Value,
        context: &ToolUseContext,
    ) -> OpenBitFunResult<Vec<ToolResult>> {
        let file_path = input
            .get("file_path")
            .and_then(|v| v.as_str())
            .ok_or_else(|| OpenBitFunError::tool("file_path is required".to_string()))?;

        let resolved = context.resolve_tool_path(file_path)?;
        debug!(
            "GetFileDiff tool starting diff retrieval for file: {:?}",
            resolved.logical_path
        );

        let relative_path =
            Self::workspace_relative_path(Path::new(&resolved.resolved_path), context);
        crate::agentic::deep_review::scope::ensure_focused_review_path_allowed(
            context,
            relative_path.as_deref().unwrap_or(file_path),
        )?;
        let prepared_evidence = Self::target_evidence(context)?;
        if let Some(evidence) = prepared_evidence.as_ref() {
            if resolved.uses_remote_workspace_backend() {
                let logical_path = relative_path.as_deref().unwrap_or(file_path);
                if !evidence.contains_file(logical_path) {
                    return Err(OpenBitFunError::tool(
                        "Requested file is outside the prepared Review target evidence".to_string(),
                    ));
                }
                let data = Self::limited_review_diff_data(
                    logical_path,
                    "limited",
                    "remote_prepared_diff_unavailable",
                    "Prepared Review exact diff is unavailable for this remote workspace",
                );
                let result_for_assistant = Self::diff_for_assistant(&data);
                return Ok(vec![ToolResult::Result {
                    data,
                    result_for_assistant: Some(result_for_assistant),
                    image_attachments: None,
                }]);
            }
        }
        Self::ensure_prepared_target_path(relative_path.as_deref(), context)?;
        let cursor = input.get("cursor").and_then(Value::as_str);
        let diff_offset = match (prepared_evidence.as_ref(), relative_path.as_deref()) {
            (Some(evidence), Some(path)) => {
                Self::review_cursor_offset(cursor, evidence.fingerprint(), path)?
            }
            (None, _) if cursor.is_some() => {
                return Err(OpenBitFunError::tool(
                    "cursor is only available for prepared Review diffs".to_string(),
                ))
            }
            _ => 0,
        };
        let logical_path = relative_path.as_deref().unwrap_or(file_path);
        if let Some(evidence) = prepared_evidence.as_ref() {
            if let Some(data) = Self::repeated_review_diff_data(
                context,
                evidence.fingerprint(),
                logical_path,
                diff_offset,
            ) {
                let result_for_assistant = Self::diff_for_assistant(&data);
                return Ok(vec![ToolResult::Result {
                    data,
                    result_for_assistant: Some(result_for_assistant),
                    image_attachments: None,
                }]);
            }
            if Self::review_budget_identity(context)
                .is_some_and(|(parent_turn_id, _)| review_diff_budget_exhausted(parent_turn_id))
            {
                let data = Self::limited_review_diff_data(
                    logical_path,
                    "limited",
                    "review_diff_budget_exhausted",
                    "Prepared Review diff allowance exhausted",
                );
                let result_for_assistant = Self::diff_for_assistant(&data);
                return Ok(vec![ToolResult::Result {
                    data,
                    result_for_assistant: Some(result_for_assistant),
                    image_attachments: None,
                }]);
            }
            if let Some(data) =
                Self::workspace_binding_limitation(context, evidence, logical_path).await
            {
                let result_for_assistant = Self::diff_for_assistant(&data);
                return Ok(vec![ToolResult::Result {
                    data,
                    result_for_assistant: Some(result_for_assistant),
                    image_attachments: None,
                }]);
            }
        }
        if let Some(evidence) = prepared_evidence.as_ref() {
            if let Some(data) = self
                .pull_request_review_diff(context, evidence, logical_path, diff_offset)
                .await?
            {
                let data = Self::apply_review_diff_budget(
                    data,
                    context,
                    evidence.fingerprint(),
                    logical_path,
                    diff_offset,
                );
                let result_for_assistant = Self::diff_for_assistant(&data);
                return Ok(vec![ToolResult::Result {
                    data,
                    result_for_assistant: Some(result_for_assistant),
                    image_attachments: None,
                }]);
            }
        }
        let exact_target = match relative_path.as_deref() {
            Some(relative_path) => Self::exact_review_target(relative_path, context)?,
            None => None,
        };

        if let Some((base_revision, head_revision, paths, fingerprint)) = exact_target {
            let workspace_root = context.workspace_root().ok_or_else(|| {
                OpenBitFunError::tool(
                    "Workspace root is required for Review target diff".to_string(),
                )
            })?;
            let data = self
                .exact_review_diff(ExactReviewDiffRequest {
                    workspace_root,
                    logical_path,
                    base_revision: &base_revision,
                    head_revision: &head_revision,
                    paths: &paths,
                    fingerprint: fingerprint.as_deref(),
                    diff_offset,
                    cursor_binding: prepared_evidence
                        .as_ref()
                        .map(ReviewTargetEvidence::fingerprint)
                        .unwrap_or_default(),
                })
                .await?;
            let data = Self::apply_review_diff_budget(
                data,
                context,
                prepared_evidence
                    .as_ref()
                    .map(ReviewTargetEvidence::fingerprint)
                    .unwrap_or_default(),
                logical_path,
                diff_offset,
            );
            // The model-facing text must contain the target diff. Oversized
            // results are handled by the shared tool-result persistence budget.
            let result_for_assistant = Self::diff_for_assistant(&data);
            return Ok(vec![ToolResult::Result {
                data,
                result_for_assistant: Some(result_for_assistant),
                image_attachments: None,
            }]);
        }

        if resolved.uses_remote_workspace_backend() {
            let ws_fs = context.ws_fs().ok_or_else(|| {
                OpenBitFunError::tool(
                    "Workspace file system not available for remote diff".to_string(),
                )
            })?;
            let content = ws_fs
                .read_file_text(&resolved.resolved_path)
                .await
                .map_err(|e| OpenBitFunError::tool(format!("Failed to read file: {}", e)))?;
            let total_lines = content.lines().count();
            let data = json!({
                "file_path": resolved.logical_path,
                "diff_type": "full",
                "diff_format": "unified",
                "diff_content": content.clone(),
                "original_content": "",
                "modified_content": content,
                "stats": {
                    "additions": 0,
                    "deletions": 0,
                    "total_lines": total_lines
                },
                "message": "File full content on remote workspace (baseline/git diff not available locally)"
            });
            let result_for_assistant = self.render_tool_result_message(&data);
            return Ok(vec![ToolResult::Result {
                data,
                result_for_assistant: Some(result_for_assistant),
                image_attachments: None,
            }]);
        }

        let prepared_review = prepared_evidence.is_some();
        let prepared_status = relative_path.as_deref().and_then(|path| {
            prepared_evidence
                .as_ref()
                .and_then(|evidence| evidence.file_status_for_path(path))
        });
        let prepared_paths = relative_path.as_deref().and_then(|path| {
            prepared_evidence
                .as_ref()
                .map(|evidence| evidence.diff_paths_for_path(path))
        });

        // Priority 1: Try baseline diff only for the legacy path. Prepared
        // workspace Review evidence is defined relative to HEAD.
        let path = Path::new(&resolved.resolved_path);
        if resolved.is_runtime_artifact() {
            let content = fs::read_to_string(path)
                .map_err(|e| OpenBitFunError::tool(format!("Failed to read file: {}", e)))?;
            let total_lines = content.lines().count();
            let data = json!({
                "file_path": resolved.logical_path,
                "diff_type": "full",
                "diff_format": "unified",
                "diff_content": content.clone(),
                "original_content": "",
                "modified_content": content,
                "stats": {
                    "additions": 0,
                    "deletions": 0,
                    "total_lines": total_lines
                },
                "message": "Runtime artifact full content (baseline/git diff not available)"
            });
            let result_for_assistant = self.render_tool_result_message(&data);
            return Ok(vec![ToolResult::Result {
                data,
                result_for_assistant: Some(result_for_assistant),
                image_attachments: None,
            }]);
        }

        if !prepared_review {
            if let Some(result) = self
                .try_baseline_diff(
                    path,
                    context
                        .workspace
                        .as_ref()
                        .and_then(|workspace| workspace.workspace_id.as_deref()),
                )
                .await
            {
                match result {
                    Ok(data) => {
                        debug!("GetFileDiff tool using baseline diff");
                        let result_for_assistant = self.render_tool_result_message(&data);
                        return Ok(vec![ToolResult::Result {
                            data,
                            result_for_assistant: Some(result_for_assistant),
                            image_attachments: None,
                        }]);
                    }
                    Err(e) => {
                        warn!(
                            "GetFileDiff tool baseline diff failed: {}, trying git diff",
                            e
                        );
                        // Continue trying git
                    }
                }
            }
        }

        // Priority 2: Try git diff
        if let Some(result) = self
            .try_git_diff(
                path,
                prepared_review,
                prepared_status,
                prepared_paths.as_deref(),
                context.workspace_root(),
            )
            .await
        {
            match result {
                Ok(data) => {
                    debug!("GetFileDiff tool using git diff");
                    let data = if prepared_review {
                        Self::paginate_prepared_diff(
                            data,
                            diff_offset,
                            prepared_evidence
                                .as_ref()
                                .map(ReviewTargetEvidence::fingerprint)
                                .unwrap_or_default(),
                            relative_path.as_deref().unwrap_or(file_path),
                        )?
                    } else {
                        data
                    };
                    let data = if prepared_review {
                        Self::apply_review_diff_budget(
                            data,
                            context,
                            prepared_evidence
                                .as_ref()
                                .map(ReviewTargetEvidence::fingerprint)
                                .unwrap_or_default(),
                            relative_path.as_deref().unwrap_or(file_path),
                            diff_offset,
                        )
                    } else {
                        data
                    };
                    let result_for_assistant = if prepared_review {
                        Self::diff_for_assistant(&data)
                    } else {
                        self.render_tool_result_message(&data)
                    };
                    return Ok(vec![ToolResult::Result {
                        data,
                        result_for_assistant: Some(result_for_assistant),
                        image_attachments: None,
                    }]);
                }
                Err(e) => {
                    if prepared_review {
                        return Err(e);
                    }
                    warn!(
                        "GetFileDiff tool git diff failed: {}, returning full content",
                        e
                    );
                    // Continue returning full content
                }
            }
        }

        if prepared_review {
            return Err(OpenBitFunError::tool(
                "Prepared Review diff is unavailable because the target file is not in a readable Git repository"
                    .to_string(),
            ));
        }

        // Priority 3: Return full file content
        debug!("GetFileDiff tool returning full file content");
        let data = self.return_full_content(path)?;
        let result_for_assistant = self.render_tool_result_message(&data);

        Ok(vec![ToolResult::Result {
            data,
            result_for_assistant: Some(result_for_assistant),
            image_attachments: None,
        }])
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::sync::Mutex;

    #[derive(Default)]
    struct RecordingProviderDiffService {
        requests: Mutex<Vec<ProviderFileDiffRoute>>,
    }

    #[async_trait]
    impl ProviderFileDiffService for RecordingProviderDiffService {
        async fn acquire(
            &self,
            route: &ProviderFileDiffRoute,
        ) -> Result<
            crate::service::review_platform::ReviewPlatformPullRequestFileDiff,
            ReviewPlatformError,
        > {
            self.requests
                .lock()
                .expect("recording service lock should be available")
                .push(route.clone());
            Ok(
                crate::service::review_platform::ReviewPlatformPullRequestFileDiff {
                    path: "src/lib.rs".to_string(),
                    old_path: None,
                    status: crate::service::review_platform::ReviewFileStatus::Modified,
                    base_revision: "1111111111111111111111111111111111111111".to_string(),
                    head_revision: "2222222222222222222222222222222222222222".to_string(),
                    diff: "@@ -1 +1 @@\n-old\n+new".to_string(),
                },
            )
        }
    }

    fn git(root: &Path, args: &[&str]) {
        let output = crate::util::create_test_command("git")
            .current_dir(root)
            .args(args)
            .output()
            .expect("git should be available for GetFileDiff tests");
        assert!(
            output.status.success(),
            "git {:?} failed: {}",
            args,
            String::from_utf8_lossy(&output.stderr)
        );
    }

    fn git_stdout(root: &Path, args: &[&str]) -> String {
        let output = crate::util::create_test_command("git")
            .current_dir(root)
            .args(args)
            .output()
            .expect("git should be available for GetFileDiff tests");
        assert!(
            output.status.success(),
            "git {:?} failed: {}",
            args,
            String::from_utf8_lossy(&output.stderr)
        );
        String::from_utf8(output.stdout)
            .expect("git output should be UTF-8")
            .trim()
            .to_string()
    }

    fn committed_repo() -> tempfile::TempDir {
        let directory = tempfile::tempdir().expect("temporary repository should be created");
        git(directory.path(), &["init"]);
        fs::write(directory.path().join("tracked.txt"), "before\n")
            .expect("tracked fixture should be written");
        git(directory.path(), &["add", "--", "tracked.txt"]);
        git(
            directory.path(),
            &[
                "-c",
                "user.name=OpenBitFun Tests",
                "-c",
                "user.email=tests@openbitfun.dev",
                "commit",
                "-m",
                "fixture",
            ],
        );
        directory
    }

    fn prepared_context() -> ToolUseContext {
        let mut context = ToolUseContext::for_tool_listing(None, None);
        attach_review_budget_identity(&mut context, "prepared-context");
        context.custom_data.insert(
            "deep_review_run_manifest".to_string(),
            json!({
                "evidencePack": {
                    "reviewTarget": {
                        "version": 1,
                        "source": "git_range",
                        "fingerprint": "target-fingerprint",
                        "baseRevision": "1111111111111111111111111111111111111111",
                        "headRevision": "2222222222222222222222222222222222222222",
                        "completeness": "complete",
                        "workspaceBinding": "matching_clean",
                        "files": [{
                            "path": "src/lib.rs",
                            "status": "modified",
                            "diffRef": "diff-1",
                            "completeness": "complete"
                        }],
                        "diffRefs": ["diff-1"],
                        "limitations": []
                    }
                }
            }),
        );
        context
    }

    fn attach_review_budget_identity(context: &mut ToolUseContext, identity: &str) {
        context.custom_data.insert(
            "deep_review_parent_dialog_turn_id".to_string(),
            json!(format!("turn-{identity}")),
        );
        context.custom_data.insert(
            "deep_review_parent_tool_call_id".to_string(),
            json!(format!("reviewer-{identity}")),
        );
    }

    #[test]
    fn invalid_prepared_target_does_not_fall_back_to_legacy_diff() {
        let mut context = prepared_context();
        context.custom_data.insert(
            "deep_review_run_manifest".to_string(),
            json!({ "evidencePack": { "reviewTarget": { "version": 99 } } }),
        );
        let result = GetFileDiffTool::exact_review_target("src/lib.rs", &context);

        assert!(result.is_err());
    }

    #[tokio::test]
    async fn unavailable_pull_request_file_returns_limited_without_provider_access() {
        let mut context = prepared_context();
        context.custom_data.insert(
            "deep_review_run_manifest".to_string(),
            json!({
                "evidencePack": {
                    "reviewTarget": {
                        "version": 1,
                        "source": "pull_request",
                        "fingerprint": "provider-target-fingerprint",
                        "baseRevision": "1111111111111111111111111111111111111111",
                        "headRevision": "2222222222222222222222222222222222222222",
                        "completeness": "partial",
                        "workspaceBinding": "unavailable",
                        "pullRequest": {
                            "remoteId": "origin",
                            "platform": "github",
                            "host": "github.com",
                            "projectPath": "example/repo",
                            "pullRequestId": "42",
                            "number": 42,
                            "webUrl": "https://github.com/example/repo/pull/42"
                        },
                        "files": [{
                            "path": "src/lib.rs",
                            "status": "modified",
                            "completeness": "unavailable"
                        }],
                        "limitations": ["provider_file_diff_unavailable"]
                    }
                }
            }),
        );
        let evidence = GetFileDiffTool::target_evidence(&context)
            .expect("evidence should parse")
            .expect("evidence should exist");

        let data = GetFileDiffTool::new()
            .pull_request_review_diff(&context, &evidence, "src/lib.rs", 0)
            .await
            .expect("unavailable provider diff should be structured")
            .expect("pull request evidence should be handled");

        assert_eq!(data["evidence_limited"], true);
        assert_eq!(data["limitation"], "provider_file_diff_unavailable");
    }

    #[test]
    fn pull_request_diff_route_uses_prepared_provider_identity_not_remote_id() {
        for (platform_name, platform, host) in [
            ("github", ReviewPlatformKind::Github, "github.com"),
            ("gitee", ReviewPlatformKind::Gitee, "gitee.com"),
        ] {
            let mut context = prepared_context();
            context.custom_data.insert(
                "deep_review_run_manifest".to_string(),
                json!({
                    "evidencePack": {
                        "reviewTarget": {
                            "version": 1,
                            "source": "pull_request",
                            "fingerprint": "provider-route-fingerprint",
                            "baseRevision": "1111111111111111111111111111111111111111",
                            "headRevision": "2222222222222222222222222222222222222222",
                            "completeness": "complete",
                            "workspaceBinding": "unavailable",
                            "pullRequest": {
                                "remoteId": "fabricated-remote-that-must-not-route",
                                "platform": platform_name,
                                "host": host,
                                "projectPath": "exact/project",
                                "pullRequestId": "42",
                                "number": 42,
                                "webUrl": format!("https://{host}/exact/project/pulls/42")
                            },
                            "files": [{
                                "path": "src/lib.rs",
                                "status": "modified",
                                "completeness": "complete"
                            }],
                            "limitations": []
                        }
                    }
                }),
            );
            let evidence = GetFileDiffTool::target_evidence(&context)
                .expect("evidence should parse")
                .expect("evidence should exist");

            let route =
                GetFileDiffTool::pull_request_file_diff_route(&context, &evidence, "src/lib.rs")
                    .expect("prepared provider route should be exact");

            assert_eq!(
                route,
                ProviderFileDiffRoute::Identity {
                    platform,
                    host: host.to_string(),
                    project_path: "exact/project".to_string(),
                    pull_request_id: "42".to_string(),
                    base_revision: "1111111111111111111111111111111111111111".to_string(),
                    head_revision: "2222222222222222222222222222222222222222".to_string(),
                    file_path: "src/lib.rs".to_string(),
                    file_page_hint: Some(1),
                    repository: None,
                }
            );
        }
    }

    #[tokio::test]
    async fn gitcode_prepared_diff_reaches_workspace_remote_service_boundary() {
        let directory = tempfile::tempdir().expect("temporary workspace should be created");
        let mut context = prepared_context();
        attach_review_budget_identity(&mut context, "gitcode-workspace-route");
        context.workspace = Some(crate::agentic::WorkspaceBinding::new(
            Some("ws-gitcode-route".to_string()),
            directory.path().to_path_buf(),
        ));
        context.custom_data.insert(
            "deep_review_run_manifest".to_string(),
            json!({
                "evidencePack": {
                    "reviewTarget": {
                        "version": 1,
                        "source": "pull_request",
                        "fingerprint": "gitcode-provider-route-fingerprint",
                        "baseRevision": "1111111111111111111111111111111111111111",
                        "headRevision": "2222222222222222222222222222222222222222",
                        "completeness": "complete",
                        "workspaceBinding": "unavailable",
                        "pullRequest": {
                            "remoteId": "origin:gitcode:example__repo",
                            "platform": "gitcode",
                            "host": "gitcode.com",
                            "projectPath": "example/repo",
                            "pullRequestId": "42",
                            "number": 42,
                            "webUrl": "https://gitcode.com/example/repo/pull/42"
                        },
                        "files": [{
                            "path": "src/lib.rs",
                            "status": "modified",
                            "completeness": "complete"
                        }],
                        "limitations": []
                    }
                }
            }),
        );
        let evidence = GetFileDiffTool::target_evidence(&context)
            .expect("GitCode evidence should parse")
            .expect("GitCode evidence should exist");
        let service = RecordingProviderDiffService::default();

        let data = GetFileDiffTool::new()
            .pull_request_review_diff_with_service(&context, &evidence, "src/lib.rs", 0, &service)
            .await
            .expect("GitCode provider diff should be structured")
            .expect("GitCode evidence should be handled");

        assert!(data["diff_content"]
            .as_str()
            .is_some_and(|diff| diff.contains("-old\n+new")));
        assert_eq!(
            service
                .requests
                .lock()
                .expect("recording service lock should be available")
                .as_slice(),
            &[ProviderFileDiffRoute::WorkspaceRemote {
                repository: ReviewRepositoryLocator::new(
                    Some("ws-gitcode-route".to_string()),
                    directory.path().to_string_lossy().into_owned(),
                ),
                remote_id: "origin:gitcode:example__repo".to_string(),
                pull_request_id: "42".to_string(),
                base_revision: "1111111111111111111111111111111111111111".to_string(),
                head_revision: "2222222222222222222222222222222222222222".to_string(),
                file_path: "src/lib.rs".to_string(),
                file_page_hint: Some(1),
            }]
        );
    }

    #[tokio::test]
    async fn gitcode_prepared_diff_without_workspace_binding_is_honestly_unavailable() {
        let mut context = prepared_context();
        attach_review_budget_identity(&mut context, "gitcode-missing-workspace-route");
        context.custom_data.insert(
            "deep_review_run_manifest".to_string(),
            json!({
                "evidencePack": {
                    "reviewTarget": {
                        "version": 1,
                        "source": "pull_request",
                        "fingerprint": "gitcode-missing-workspace-fingerprint",
                        "baseRevision": "1111111111111111111111111111111111111111",
                        "headRevision": "2222222222222222222222222222222222222222",
                        "completeness": "complete",
                        "workspaceBinding": "unavailable",
                        "pullRequest": {
                            "remoteId": "origin:gitcode:example__repo",
                            "platform": "gitcode",
                            "host": "gitcode.com",
                            "projectPath": "example/repo",
                            "pullRequestId": "42",
                            "number": 42,
                            "webUrl": "https://gitcode.com/example/repo/pull/42"
                        },
                        "files": [{
                            "path": "src/lib.rs",
                            "status": "modified",
                            "completeness": "complete"
                        }],
                        "limitations": []
                    }
                }
            }),
        );
        let evidence = GetFileDiffTool::target_evidence(&context)
            .expect("GitCode evidence should parse")
            .expect("GitCode evidence should exist");
        let service = RecordingProviderDiffService::default();

        let data = GetFileDiffTool::new()
            .pull_request_review_diff_with_service(&context, &evidence, "src/lib.rs", 0, &service)
            .await
            .expect("missing GitCode binding should be structured")
            .expect("GitCode evidence should be handled");

        assert_eq!(data["evidence_limited"], true);
        assert_eq!(data["limitation"], "provider_file_diff_unavailable");
        assert!(service
            .requests
            .lock()
            .expect("recording service lock should be available")
            .is_empty());
    }

    #[tokio::test]
    async fn provider_acquisition_budget_stops_pull_request_diff_before_provider_io() {
        let directory = tempfile::tempdir().expect("temporary workspace should be created");
        let mut context = prepared_context();
        attach_review_budget_identity(&mut context, "provider-request-cap");
        context.workspace = Some(crate::agentic::WorkspaceBinding::new(
            None,
            directory.path().to_path_buf(),
        ));
        context.custom_data.insert(
            "deep_review_run_manifest".to_string(),
            json!({
                "evidencePack": {
                    "reviewTarget": {
                        "version": 1,
                        "source": "pull_request",
                        "fingerprint": "provider-request-cap-fingerprint",
                        "baseRevision": "1111111111111111111111111111111111111111",
                        "headRevision": "2222222222222222222222222222222222222222",
                        "completeness": "complete",
                        "workspaceBinding": "unavailable",
                        "pullRequest": {
                            "remoteId": "origin",
                            "platform": "github",
                            "host": "github.com",
                            "projectPath": "example/repo",
                            "pullRequestId": "42",
                            "number": 42,
                            "webUrl": "https://github.com/example/repo/pull/42"
                        },
                        "files": [{
                            "path": "src/lib.rs",
                            "status": "modified",
                            "completeness": "complete"
                        }],
                        "limitations": []
                    }
                }
            }),
        );
        let (parent_turn_id, _) = GetFileDiffTool::review_budget_identity(&context)
            .expect("review budget identity should be available");
        for _ in
            0..openbitfun_agent_runtime::deep_review::REVIEW_PROVIDER_DIFF_MAX_ACQUISITIONS_PER_TURN
        {
            assert!(admit_review_provider_diff_acquisition(parent_turn_id));
        }
        let evidence = GetFileDiffTool::target_evidence(&context)
            .expect("evidence should parse")
            .expect("evidence should exist");

        let data = GetFileDiffTool::new()
            .pull_request_review_diff(&context, &evidence, "src/lib.rs", 0)
            .await
            .expect("request budget exhaustion should be structured")
            .expect("pull request evidence should be handled");

        assert_eq!(data["evidence_limited"], true);
        assert_eq!(
            data["limitation"],
            "review_provider_acquisition_budget_exhausted"
        );
    }

    #[test]
    fn prepared_target_rejects_implicit_out_of_scope_fallback() {
        let context = prepared_context();
        let result = GetFileDiffTool::exact_review_target("src/outside.rs", &context);

        assert!(result.is_err());
    }

    #[test]
    fn prepared_target_rejects_paths_that_cannot_be_bound_to_the_workspace() {
        let context = prepared_context();

        let result = GetFileDiffTool::ensure_prepared_target_path(None, &context);

        assert!(result.is_err());
        assert!(result
            .expect_err("prepared target path must fail closed")
            .to_string()
            .contains("workspace-relative target paths"));
    }

    #[test]
    fn exact_review_diff_is_visible_to_the_assistant() {
        let data = json!({
            "diff_content": "@@ -1 +1 @@\n-old\n+new"
        });

        assert_eq!(
            GetFileDiffTool::diff_for_assistant(&data),
            "@@ -1 +1 @@\n-old\n+new"
        );
    }

    #[test]
    fn repeated_prepared_page_returns_only_a_compact_notice() {
        let mut context = ToolUseContext::for_tool_listing(None, None);
        attach_review_budget_identity(&mut context, "repeat-page");
        let page = json!({
            "file_path": "src/lib.rs",
            "diff_type": "review_target",
            "diff_format": "unified",
            "diff_content": "@@ -1 +1 @@\n-old\n+new",
            "original_content": "old",
            "modified_content": "new",
            "has_more": true,
            "next_cursor": "next-page",
            "returned_chars": 22
        });

        let first = GetFileDiffTool::apply_review_diff_budget(
            page.clone(),
            &context,
            "binding",
            "src/lib.rs",
            0,
        );
        let repeated =
            GetFileDiffTool::apply_review_diff_budget(page, &context, "binding", "src/lib.rs", 0);
        let early_repeat =
            GetFileDiffTool::repeated_review_diff_data(&context, "binding", "src/lib.rs", 0)
                .expect("a repeated page should be rejected before Git IO");
        let assistant = GetFileDiffTool::diff_for_assistant(&repeated);

        assert!(!first["review_budget_repeated_page"].as_bool().unwrap());
        assert_eq!(repeated["diff_content"], "");
        assert_eq!(repeated["original_content"], "");
        assert_eq!(repeated["modified_content"], "");
        assert_eq!(repeated["returned_chars"], 0);
        assert_eq!(repeated["next_cursor"], "next-page");
        assert_eq!(early_repeat["review_budget_repeated_page"], true);
        assert_eq!(early_repeat["diff_content"], "");
        assert!(assistant.contains("already returned"));
        assert!(!assistant.contains("-old"));
    }

    #[tokio::test]
    async fn review_pagination_schema_is_hidden_from_ordinary_agents() {
        let tool = GetFileDiffTool::new();
        let ordinary = ToolUseContext::for_tool_listing(None, None);
        let ordinary_schema = tool
            .input_schema_for_model_with_context(Some(&ordinary))
            .await;
        let ordinary_description = tool
            .description_with_context(Some(&ordinary))
            .await
            .unwrap();
        let prepared = prepared_context();
        let prepared_schema = tool
            .input_schema_for_model_with_context(Some(&prepared))
            .await;
        let prepared_description = tool
            .description_with_context(Some(&prepared))
            .await
            .unwrap();

        assert!(ordinary_schema["properties"].get("cursor").is_none());
        assert!(!ordinary_description.contains("prepared Review"));
        assert!(prepared_schema["properties"].get("cursor").is_some());
        assert!(prepared_description.contains("prepared Review"));
    }

    #[test]
    fn prepared_diff_pages_stay_bounded_and_reconstruct_exactly() {
        let diff = (0..5_000)
            .map(|index| format!("+changed line {index:04} with enough content\n"))
            .collect::<String>();
        let first = GetFileDiffTool::paginate_prepared_diff(
            json!({
                "diff_content": diff,
                "original_content": "must be removed",
                "modified_content": "must be removed"
            }),
            0,
            "binding",
            "src/lib.rs",
        )
        .expect("first page should be available");
        let next_cursor = first["next_cursor"]
            .as_str()
            .expect("large diff should expose a continuation");
        let next =
            GetFileDiffTool::review_cursor_offset(Some(next_cursor), "binding", "src/lib.rs")
                .expect("cursor should be valid");
        let second = GetFileDiffTool::paginate_prepared_diff(
            json!({ "diff_content": diff }),
            next,
            "binding",
            "src/lib.rs",
        )
        .expect("second page should be available");

        assert!(
            first["diff_content"].as_str().unwrap().chars().count()
                <= PREPARED_REVIEW_DIFF_PAGE_CHARS
        );
        assert!(first["has_more"].as_bool().unwrap());
        assert_eq!(first["original_content"], "");
        assert_eq!(first["modified_content"], "");
        assert_eq!(second["cursor"], next_cursor);
    }

    #[test]
    fn workspace_relative_path_preserves_unix_literal_backslashes() {
        assert_eq!(
            GetFileDiffTool::normalize_workspace_relative_path_text(r"src/literal\name.rs", false,),
            r"src/literal\name.rs"
        );
        assert_eq!(
            GetFileDiffTool::normalize_workspace_relative_path_text(r"src\windows\name.rs", true,),
            "src/windows/name.rs"
        );
    }

    #[tokio::test]
    async fn prepared_workspace_untracked_file_returns_bounded_new_file_diff() {
        let directory = committed_repo();
        let path = directory.path().join("new.txt");
        fs::write(&path, "first\nsecond\n").expect("untracked fixture should be written");

        let data = GetFileDiffTool::new()
            .try_git_diff(&path, true, Some("added"), None, Some(directory.path()))
            .await
            .expect("temporary directory should be a repository")
            .expect("bounded untracked diff should succeed");

        let diff = data["diff_content"]
            .as_str()
            .expect("diff content should be present");
        assert!(diff.contains("+first"));
        assert!(diff.contains("+second"));
        assert_eq!(GetFileDiffTool::diff_for_assistant(&data), diff);
    }

    #[tokio::test]
    async fn prepared_workspace_deleted_file_returns_head_deletion_diff() {
        let directory = committed_repo();
        let path = directory.path().join("tracked.txt");
        fs::remove_file(&path).expect("tracked fixture should be deleted");

        let data = GetFileDiffTool::new()
            .try_git_diff(&path, true, Some("deleted"), None, Some(directory.path()))
            .await
            .expect("temporary directory should be a repository")
            .expect("bounded deletion diff should succeed");

        assert!(data["diff_content"]
            .as_str()
            .expect("diff content should be present")
            .contains("-before"));
    }

    #[tokio::test]
    async fn prepared_workspace_rename_uses_both_paths() {
        let directory = committed_repo();
        let original = (0..10)
            .map(|index| format!("stable line {index}\n"))
            .collect::<String>();
        fs::write(directory.path().join("tracked.txt"), &original)
            .expect("rename base fixture should be written");
        git(directory.path(), &["add", "--", "tracked.txt"]);
        git(
            directory.path(),
            &[
                "-c",
                "user.name=OpenBitFun Tests",
                "-c",
                "user.email=tests@openbitfun.dev",
                "commit",
                "-m",
                "rename base",
            ],
        );
        git(directory.path(), &["config", "diff.renames", "false"]);
        git(directory.path(), &["mv", "tracked.txt", "renamed.txt"]);
        fs::write(
            directory.path().join("renamed.txt"),
            original.replace("stable line 5", "edited line 5"),
        )
        .expect("renamed fixture should be edited");
        let mut context = ToolUseContext::for_tool_listing(None, None);
        attach_review_budget_identity(&mut context, "workspace-rename");
        context.workspace = Some(crate::agentic::WorkspaceBinding::new(
            None,
            directory.path().to_path_buf(),
        ));
        context.custom_data.insert(
            "deep_review_run_manifest".to_string(),
            json!({
                "reviewTargetEvidence": {
                    "version": 1,
                    "source": "workspace",
                    "fingerprint": "0123456789abcdef",
                    "baseRevision": git_stdout(directory.path(), &["rev-parse", "HEAD"]),
                    "headRevision": "worktree:0123456789abcdef",
                    "completeness": "complete",
                    "workspaceBinding": "matching_dirty",
                    "files": [{
                        "path": "renamed.txt",
                        "previousPath": "tracked.txt",
                        "status": "renamed",
                        "diffRef": "workspace:rename:1",
                        "completeness": "complete"
                    }],
                    "diffRefs": ["workspace:rename:1"],
                    "limitations": ["mutable_workspace_snapshot"]
                }
            }),
        );

        let results = GetFileDiffTool::new()
            .call_impl(&json!({ "file_path": "renamed.txt" }), &context)
            .await
            .expect("prepared rename diff should be available");
        let ToolResult::Result { data, .. } = &results[0] else {
            panic!("expected a structured tool result");
        };
        let diff = data["diff_content"].as_str().unwrap();
        assert!(diff.contains("rename from tracked.txt"));
        assert!(diff.contains("rename to renamed.txt"));
        assert!(!diff.contains("new file mode"));
    }

    #[tokio::test]
    async fn prepared_workspace_nested_file_uses_discovered_repository_root() {
        let directory = committed_repo();
        let nested_dir = directory.path().join("src").join("nested");
        fs::create_dir_all(&nested_dir).expect("nested fixture directory should be created");
        let path = nested_dir.join("file.rs");
        fs::write(&path, "before\n").expect("nested base fixture should be written");
        git(directory.path(), &["add", "--", "src/nested/file.rs"]);
        git(
            directory.path(),
            &[
                "-c",
                "user.name=OpenBitFun Tests",
                "-c",
                "user.email=tests@openbitfun.dev",
                "commit",
                "-m",
                "nested base",
            ],
        );
        fs::write(&path, "after\n").expect("nested fixture should be edited");
        let mut context = ToolUseContext::for_tool_listing(None, None);
        attach_review_budget_identity(&mut context, "workspace-nested");
        context.workspace = Some(crate::agentic::WorkspaceBinding::new(
            None,
            directory.path().to_path_buf(),
        ));
        context.custom_data.insert(
            "deep_review_run_manifest".to_string(),
            json!({
                "reviewTargetEvidence": {
                    "version": 1,
                    "source": "workspace",
                    "fingerprint": "0123456789abcdef",
                    "baseRevision": git_stdout(directory.path(), &["rev-parse", "HEAD"]),
                    "headRevision": "worktree:0123456789abcdef",
                    "completeness": "complete",
                    "workspaceBinding": "matching_dirty",
                    "files": [{
                        "path": "src/nested/file.rs",
                        "status": "modified",
                        "diffRef": "workspace:nested:1",
                        "completeness": "complete"
                    }],
                    "diffRefs": ["workspace:nested:1"],
                    "limitations": ["mutable_workspace_snapshot"]
                }
            }),
        );

        let results = GetFileDiffTool::new()
            .call_impl(&json!({ "file_path": "src/nested/file.rs" }), &context)
            .await
            .expect("nested prepared diff should be available");
        let ToolResult::Result { data, .. } = &results[0] else {
            panic!("expected a structured tool result");
        };
        let diff = data["diff_content"].as_str().unwrap();
        assert!(diff.contains("-before"));
        assert!(diff.contains("+after"));
    }

    #[tokio::test]
    async fn prepared_workspace_returns_stale_when_head_changes() {
        let directory = committed_repo();
        let prepared_head = git_stdout(directory.path(), &["rev-parse", "HEAD"]);
        fs::write(directory.path().join("tracked.txt"), "new head\n")
            .expect("new HEAD fixture should be written");
        git(directory.path(), &["add", "--", "tracked.txt"]);
        git(
            directory.path(),
            &[
                "-c",
                "user.name=OpenBitFun Tests",
                "-c",
                "user.email=tests@openbitfun.dev",
                "commit",
                "-m",
                "move head",
            ],
        );

        let mut context = ToolUseContext::for_tool_listing(None, None);
        context.workspace = Some(crate::agentic::WorkspaceBinding::new(
            None,
            directory.path().to_path_buf(),
        ));
        context.custom_data.insert(
            "deep_review_run_manifest".to_string(),
            json!({
                "reviewTargetEvidence": {
                    "version": 1,
                    "source": "workspace",
                    "fingerprint": "0123456789abcdef",
                    "baseRevision": prepared_head,
                    "headRevision": "worktree:0123456789abcdef",
                    "completeness": "complete",
                    "workspaceBinding": "matching_dirty",
                    "files": [{
                        "path": "tracked.txt",
                        "status": "modified",
                        "completeness": "complete"
                    }],
                    "diffRefs": [],
                    "limitations": ["mutable_workspace_evidence"]
                }
            }),
        );

        let results = GetFileDiffTool::new()
            .call_impl(&json!({ "file_path": "tracked.txt" }), &context)
            .await
            .expect("changed workspace HEAD should degrade structurally");
        let ToolResult::Result { data, .. } = &results[0] else {
            panic!("expected a structured tool result");
        };
        assert_eq!(data["evidence_status"], "stale");
        assert_eq!(data["limitation"], "workspace_head_changed");
        assert_eq!(data["diff_content"], "");
    }

    #[tokio::test]
    async fn prepared_remote_workspace_returns_a_structured_limitation() {
        let mut context = ToolUseContext::for_tool_listing(None, None);
        context.workspace = Some(crate::agentic::WorkspaceBinding::new_remote(
            None,
            std::path::PathBuf::from("/workspace"),
            "connection-id".to_string(),
            "Remote".to_string(),
            crate::service::remote_ssh::workspace_state::WorkspaceSessionIdentity {
                workspace_kind: openbitfun_core_types::WorkspaceKind::Remote,
                hostname: "example.test".to_string(),
                logical_workspace_path: "/workspace".to_string(),
                remote_connection_id: Some("connection-id".to_string()),
            },
        ));
        context.custom_data.insert(
            "deep_review_run_manifest".to_string(),
            json!({
                "reviewTargetEvidence": {
                    "version": 1,
                    "source": "workspace",
                    "fingerprint": "0123456789abcdef",
                    "baseRevision": "1111111111111111111111111111111111111111",
                    "headRevision": "worktree:0123456789abcdef",
                    "completeness": "partial",
                    "workspaceBinding": "matching_dirty",
                    "files": [{
                        "path": "src/lib.rs",
                        "status": "modified",
                        "completeness": "partial"
                    }],
                    "diffRefs": [],
                    "limitations": ["remote_prepared_diff_unavailable"]
                }
            }),
        );

        let results = GetFileDiffTool::new()
            .call_impl(&json!({ "file_path": "src/lib.rs" }), &context)
            .await
            .expect("prepared remote target should degrade structurally");
        let ToolResult::Result {
            data,
            result_for_assistant,
            ..
        } = &results[0]
        else {
            panic!("expected a structured tool result");
        };
        assert_eq!(data["evidence_status"], "limited");
        assert_eq!(data["limitation"], "remote_prepared_diff_unavailable");
        assert_eq!(data["diff_content"], "");
        assert!(result_for_assistant
            .as_deref()
            .unwrap()
            .contains("do not retry"));
    }

    #[tokio::test]
    async fn prepared_workspace_does_not_switch_to_a_nested_repository() {
        let directory = committed_repo();
        let nested = directory.path().join("nested");
        fs::create_dir_all(&nested).expect("nested repository directory should be created");
        git(&nested, &["init"]);
        fs::write(nested.join("file.rs"), "inner before\n")
            .expect("inner base fixture should be written");
        git(&nested, &["add", "--", "file.rs"]);
        git(
            &nested,
            &[
                "-c",
                "user.name=OpenBitFun Tests",
                "-c",
                "user.email=tests@openbitfun.dev",
                "commit",
                "-m",
                "inner base",
            ],
        );
        fs::write(nested.join("file.rs"), "inner changed\n")
            .expect("inner fixture should be edited");

        let mut context = ToolUseContext::for_tool_listing(None, None);
        attach_review_budget_identity(&mut context, "workspace-nested-repo");
        context.workspace = Some(crate::agentic::WorkspaceBinding::new(
            None,
            directory.path().to_path_buf(),
        ));
        context.custom_data.insert(
            "deep_review_run_manifest".to_string(),
            json!({
                "reviewTargetEvidence": {
                    "version": 1,
                    "source": "workspace",
                    "fingerprint": "0123456789abcdef",
                    "baseRevision": git_stdout(directory.path(), &["rev-parse", "HEAD"]),
                    "headRevision": "worktree:0123456789abcdef",
                    "completeness": "partial",
                    "workspaceBinding": "matching_dirty",
                    "files": [{
                        "path": "nested/file.rs",
                        "status": "unknown",
                        "completeness": "partial"
                    }],
                    "diffRefs": [],
                    "limitations": ["untracked_directory_content_unavailable"]
                }
            }),
        );

        let results = GetFileDiffTool::new()
            .call_impl(&json!({ "file_path": "nested/file.rs" }), &context)
            .await
            .expect("outer prepared repository should remain authoritative");
        let ToolResult::Result { data, .. } = &results[0] else {
            panic!("expected a structured tool result");
        };
        assert_eq!(data["diff_content"], "");
        assert!(!data.to_string().contains("inner changed"));
    }

    #[tokio::test]
    async fn ordinary_get_file_diff_keeps_the_legacy_short_assistant_result() {
        let directory = committed_repo();
        let path = directory.path().join("tracked.txt");
        fs::write(&path, "after\n").expect("legacy fixture should be edited");
        let mut context = ToolUseContext::for_tool_listing(None, None);
        attach_review_budget_identity(&mut context, "large-dirty-range");
        context.workspace = Some(crate::agentic::WorkspaceBinding::new(
            None,
            directory.path().to_path_buf(),
        ));

        let results = GetFileDiffTool::new()
            .call_impl(&json!({ "file_path": "tracked.txt" }), &context)
            .await
            .expect("legacy diff should be available");
        let ToolResult::Result {
            data,
            result_for_assistant,
            ..
        } = &results[0]
        else {
            panic!("expected a structured tool result");
        };
        assert!(data["diff_content"].as_str().unwrap().contains("+after"));
        assert_eq!(
            result_for_assistant.as_deref(),
            Some("Diff from Git HEAD (git)")
        );
    }

    #[cfg(unix)]
    #[tokio::test]
    async fn prepared_workspace_rejects_untracked_symlink_content() {
        use std::os::unix::fs::symlink;

        let directory = committed_repo();
        let outside = tempfile::NamedTempFile::new().expect("outside fixture should be created");
        fs::write(outside.path(), "outside secret\n").expect("outside fixture should be written");
        let path = directory.path().join("leak.txt");
        symlink(outside.path(), &path).expect("untracked symlink should be created");

        let error = GetFileDiffTool::new()
            .try_git_diff(&path, true, Some("added"), None, Some(directory.path()))
            .await
            .expect("repository should be detected")
            .expect_err("prepared symlink must fail closed");
        assert!(error.to_string().contains("symlink or reparse-point"));
    }

    #[tokio::test]
    async fn prepared_large_dirty_range_is_fully_consumable_by_pages() {
        let directory = tempfile::tempdir().expect("temporary repository should be created");
        git(directory.path(), &["init"]);
        let path = directory.path().join("large.txt");
        let before = (0..6_000)
            .map(|index| format!("old line {index:04} with stable context\n"))
            .collect::<String>();
        fs::write(&path, before).expect("base fixture should be written");
        git(directory.path(), &["add", "--", "large.txt"]);
        git(
            directory.path(),
            &[
                "-c",
                "user.name=OpenBitFun Tests",
                "-c",
                "user.email=tests@openbitfun.dev",
                "commit",
                "-m",
                "base",
            ],
        );
        let base = git_stdout(directory.path(), &["rev-parse", "HEAD"]);
        let after = (0..6_000)
            .map(|index| format!("new line {index:04} with changed context\n"))
            .collect::<String>();
        fs::write(&path, after).expect("head fixture should be written");
        git(directory.path(), &["add", "--", "large.txt"]);
        git(
            directory.path(),
            &[
                "-c",
                "user.name=OpenBitFun Tests",
                "-c",
                "user.email=tests@openbitfun.dev",
                "commit",
                "-m",
                "head",
            ],
        );
        let head = git_stdout(directory.path(), &["rev-parse", "HEAD"]);
        fs::write(directory.path().join("unrelated.txt"), "dirty\n")
            .expect("dirty binding fixture should be written");

        let expected =
            GitService::get_review_diff(directory.path(), &base, &head, &["large.txt".to_string()])
                .await
                .expect("full prepared diff should be generated");
        assert!(expected.chars().count() > 50_000);

        let mut context = ToolUseContext::for_tool_listing(None, None);
        context.workspace = Some(crate::agentic::WorkspaceBinding::new(
            None,
            directory.path().to_path_buf(),
        ));
        context.custom_data.insert(
            "deep_review_run_manifest".to_string(),
            json!({
                "reviewTargetEvidence": {
                    "version": 1,
                    "source": "git_range",
                    "fingerprint": "0123456789abcdef",
                    "baseRevision": base,
                    "headRevision": head,
                    "completeness": "partial",
                    "workspaceBinding": "matching_dirty",
                    "files": [{
                        "path": "large.txt",
                        "status": "modified",
                        "diffRef": "git-range:large:1",
                        "completeness": "complete"
                    }],
                    "diffRefs": ["git-range:large:1"],
                    "limitations": [
                        "workspace_has_local_changes",
                        "target_diff_requires_paging",
                        "target_diff_budget_exceeded"
                    ]
                }
            }),
        );

        let mut reconstructed = String::new();
        let mut cursor: Option<String> = None;
        for _ in 0..32 {
            let input = match cursor.as_deref() {
                Some(cursor) => json!({ "file_path": "large.txt", "cursor": cursor }),
                None => json!({ "file_path": "large.txt" }),
            };
            let results = GetFileDiffTool::new()
                .call_impl(&input, &context)
                .await
                .expect("prepared diff page should be available");
            let ToolResult::Result {
                data,
                result_for_assistant,
                ..
            } = &results[0]
            else {
                panic!("expected a structured tool result");
            };
            assert!(result_for_assistant.as_ref().unwrap().chars().count() < 50_000);
            reconstructed.push_str(data["diff_content"].as_str().unwrap());
            if data["has_more"] == false {
                break;
            }
            cursor = data["next_cursor"].as_str().map(str::to_string);
        }

        assert!(expected.starts_with(&reconstructed));
        assert!(reconstructed.chars().count() <= PREPARED_REVIEW_DIFF_TOTAL_CHARS);
        assert!(reconstructed.chars().count() < expected.chars().count());
    }

    #[tokio::test]
    async fn prepared_workspace_oversized_untracked_file_fails_without_full_content_fallback() {
        let directory = committed_repo();
        let path = directory.path().join("large.txt");
        fs::write(
            &path,
            vec![b'x'; REVIEW_NEW_FILE_CONTENT_LIMIT as usize + 1],
        )
        .expect("oversized fixture should be written");

        let result = GetFileDiffTool::new()
            .try_git_diff(&path, true, Some("added"), None, Some(directory.path()))
            .await
            .expect("temporary directory should be a repository");

        assert!(result.is_err());
    }

    #[tokio::test]
    async fn prepared_non_git_file_fails_without_full_content_fallback() {
        let directory = tempfile::tempdir().expect("temporary directory should be created");
        let path = directory.path().join("large.txt");
        fs::write(
            &path,
            vec![b'x'; REVIEW_NEW_FILE_CONTENT_LIMIT as usize + 1],
        )
        .expect("oversized fixture should be written");
        let mut context = ToolUseContext::for_tool_listing(None, None);
        context.workspace = Some(crate::agentic::WorkspaceBinding::new(
            None,
            directory.path().to_path_buf(),
        ));
        context.custom_data.insert(
            "deep_review_run_manifest".to_string(),
            json!({
                "reviewTargetEvidence": {
                    "version": 1,
                    "source": "workspace",
                    "fingerprint": "target-fingerprint",
                    "headRevision": "worktree:target-fingerprint",
                    "completeness": "partial",
                    "workspaceBinding": "matching_dirty",
                    "files": [{
                        "path": "large.txt",
                        "status": "modified",
                        "completeness": "partial"
                    }],
                    "diffRefs": [],
                    "limitations": ["workspace_diff_unavailable"]
                }
            }),
        );

        let results = GetFileDiffTool::new()
            .call_impl(&json!({ "file_path": "large.txt" }), &context)
            .await
            .expect("prepared non-Git targets should degrade structurally");

        let ToolResult::Result { data, .. } = &results[0] else {
            panic!("expected a structured tool result");
        };
        assert_eq!(data["evidence_status"], "limited");
        assert_eq!(data["limitation"], "workspace_base_revision_unavailable");
        assert_eq!(data["diff_content"], "");
    }
}
