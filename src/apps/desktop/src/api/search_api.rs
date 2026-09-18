use crate::api::app_state::AppState;
use openbitfun_core::infrastructure::{FileSearchResult, FileSearchResultGroup, SearchMatchType};
use openbitfun_core::service::search::{
    remote_workspace_search_service_for_workspace, workspace_search_daemon_available,
    workspace_search_feature_enabled, ContentSearchRequest, ContentSearchResult,
    RemoteWorkspaceSearchService, WorkspaceSearchBackend, WorkspaceSearchRepoPhase,
};
use openbitfun_core::service::workspace::{WorkspaceInfo, WorkspaceKind};
use serde::{Deserialize, Serialize};
use std::sync::Arc;
use tauri::State;

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SearchRepoIndexRequest {
    #[serde(default)]
    pub workspace_id: Option<String>,
    /// Upgrade-only input for pre-ID hosts/clients.
    #[serde(default)]
    pub root_path: String,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SearchMetadataResponse {
    pub backend: WorkspaceSearchBackend,
    pub repo_phase: WorkspaceSearchRepoPhase,
    pub base_advance_in_progress: bool,
    /// `true` when the daemon still owed a worktree reconcile at query time, so these results
    /// describe the worktree as of the last observation. No query path waits for that reconcile —
    /// stale-but-instant beats correct-but-blocked — so this is reported rather than waited out.
    pub workspace_probe_pending: bool,
    pub candidate_docs: usize,
    pub matched_lines: usize,
    pub matched_occurrences: usize,
}

#[derive(Clone)]
pub(crate) enum WorkspaceContentSearchRunner {
    Local(Arc<openbitfun_core::service::search::WorkspaceSearchService>),
    Remote(RemoteWorkspaceSearchService),
}

impl WorkspaceContentSearchRunner {
    pub(crate) async fn search_content(
        &self,
        request: ContentSearchRequest,
    ) -> Result<ContentSearchResult, String> {
        match self {
            Self::Local(service) => service.search_content(request).await.map_err(|error| {
                format!(
                    "Failed to search file contents via workspace search: {}",
                    error
                )
            }),
            Self::Remote(service) => service.search_content(request).await,
        }
    }
}

pub(crate) async fn resolve_search_workspace(
    state: &State<'_, AppState>,
    id: Option<&str>,
    legacy_root: &str,
    legacy_connection: Option<&str>,
) -> Result<WorkspaceInfo, String> {
    if let Some(id) = id {
        return state
            .workspace_service
            .require_workspace(id)
            .await
            .map_err(|e| e.to_string());
    }
    state
        .workspace_service
        .resolve_legacy_workspace_reference(None, legacy_root, legacy_connection, None)
        .await
        .map_err(|e| e.to_string())?
        .ok_or_else(|| "Legacy search workspace cannot be resolved; select its ID".into())
}

pub(crate) async fn remote_workspace_search_service(
    _state: &State<'_, AppState>,
    workspace: &WorkspaceInfo,
) -> Result<RemoteWorkspaceSearchService, String> {
    remote_workspace_search_service_for_workspace(&workspace.id).await
}

/// flashgrep refuses to open a directory that is not a Git worktree with a HEAD commit.
/// That is a property of the workspace, not a failure of the index, so it is normalized into a
/// stable OpenBitFun-owned sentence the UI can recognize instead of leaking the raw daemon error.
pub(crate) const NON_GIT_WORKSPACE_MESSAGE: &str =
    "Workspace search requires a Git worktree with a HEAD commit";

fn repo_status_error_message(error: impl std::fmt::Display) -> String {
    let message = error.to_string();
    if message.contains("requires a Git worktree with a HEAD commit") {
        return NON_GIT_WORKSPACE_MESSAGE.to_string();
    }
    format!("Failed to get search repository status: {message}")
}

async fn workspace_search_unavailable_message(
    _state: &State<'_, AppState>,
    workspace: &WorkspaceInfo,
) -> Option<String> {
    if workspace.workspace_kind == WorkspaceKind::Remote {
        return Some("Flashgrep is not supported for remote workspaces".to_string());
    }

    local_workspace_search_unavailable_message(&workspace.root_path.to_string_lossy()).await
}

async fn local_workspace_search_unavailable_message(root_path: &str) -> Option<String> {
    if !workspace_search_feature_enabled().await {
        return Some(
            "Workspace search is disabled. Enable it in Settings > Session Config to use accelerated workspace search.".to_string(),
        );
    }

    if !workspace_search_daemon_available() {
        return Some(
            "Workspace search daemon is unavailable. OpenBitFun will continue using legacy search."
                .to_string(),
        );
    }

    if !openbitfun_services_integrations::workspace_search::workspace_search_supports_local_root(
        root_path,
    )
    .await
    {
        return Some(NON_GIT_WORKSPACE_MESSAGE.to_string());
    }

    None
}

pub(crate) async fn should_use_workspace_search(
    state: &State<'_, AppState>,
    workspace: &WorkspaceInfo,
) -> bool {
    workspace_search_unavailable_message(state, workspace)
        .await
        .is_none()
}

/// Builds the refusal sentence used when a remote workspace cannot be searched over SSH.
///
/// The legacy content walker only sees the controller filesystem, so running it for a remote
/// root would answer a question about the wrong machine. Callers must surface this instead.
pub(crate) fn remote_content_search_refusal_message(
    command: &str,
    root_path: &str,
    reason: &str,
) -> String {
    format!(
        "{} cannot search remote workspace path '{}': {}; local filesystem fallback was not attempted",
        command, root_path, reason
    )
}

/// Returns a refusal message when `root_path` belongs to a remote workspace whose remote search
/// path is unavailable, and `None` when the path is local or remote search can serve the request.
pub(crate) async fn remote_content_search_refusal(
    state: &State<'_, AppState>,
    command: &str,
    workspace: &WorkspaceInfo,
) -> Option<String> {
    if workspace.workspace_kind != WorkspaceKind::Remote {
        return None;
    }

    let reason = workspace_search_unavailable_message(state, workspace).await?;
    Some(remote_content_search_refusal_message(
        command,
        &workspace.root_path.to_string_lossy(),
        &reason,
    ))
}

pub(crate) async fn prepare_content_search_runner(
    state: &State<'_, AppState>,
    workspace: &WorkspaceInfo,
) -> Result<WorkspaceContentSearchRunner, String> {
    if workspace.workspace_kind == WorkspaceKind::Remote {
        Ok(WorkspaceContentSearchRunner::Remote(
            remote_workspace_search_service(state, workspace).await?,
        ))
    } else {
        Ok(WorkspaceContentSearchRunner::Local(
            state.workspace_search_service.clone(),
        ))
    }
}

pub(crate) async fn search_file_contents_via_workspace_search(
    state: &State<'_, AppState>,
    workspace: &WorkspaceInfo,
    pattern: &str,
    case_sensitive: bool,
    use_regex: bool,
    whole_word: bool,
    max_results: usize,
) -> Result<openbitfun_core::service::search::ContentSearchResult, String> {
    search_content_request_via_workspace_search(
        state,
        workspace,
        build_content_search_request(
            &workspace.root_path.to_string_lossy(),
            pattern,
            case_sensitive,
            use_regex,
            whole_word,
            max_results,
        ),
    )
    .await
}

pub(crate) fn build_content_search_request(
    root_path: &str,
    pattern: &str,
    case_sensitive: bool,
    use_regex: bool,
    whole_word: bool,
    max_results: usize,
) -> ContentSearchRequest {
    ContentSearchRequest {
        repo_root: root_path.into(),
        search_path: None,
        pattern: pattern.to_string(),
        output_mode: openbitfun_core::service::search::ContentSearchOutputMode::Content,
        case_sensitive,
        use_regex,
        whole_word,
        multiline: false,
        max_results: Some(max_results),
        globs: Vec::new(),
        file_types: Vec::new(),
        exclude_file_types: Vec::new(),
    }
}

pub(crate) async fn search_content_request_via_workspace_search(
    state: &State<'_, AppState>,
    workspace: &WorkspaceInfo,
    request: ContentSearchRequest,
) -> Result<ContentSearchResult, String> {
    prepare_content_search_runner(state, workspace)
        .await?
        .search_content(request)
        .await
}

pub(crate) fn group_search_results(results: Vec<FileSearchResult>) -> Vec<FileSearchResultGroup> {
    let mut grouped = Vec::<FileSearchResultGroup>::new();
    let mut positions = std::collections::HashMap::<String, usize>::new();

    for result in results {
        let path = result.path.clone();
        let position = if let Some(position) = positions.get(&path).copied() {
            position
        } else {
            let position = grouped.len();
            positions.insert(path.clone(), position);
            grouped.push(FileSearchResultGroup {
                path,
                name: result.name.clone(),
                is_directory: result.is_directory,
                file_name_match: None,
                content_matches: Vec::new(),
            });
            position
        };
        let group = &mut grouped[position];

        match result.match_type {
            SearchMatchType::FileName => group.file_name_match = Some(result),
            SearchMatchType::Content => group.content_matches.push(result),
        }
    }

    grouped
}

pub(crate) fn search_metadata_from_content_result(
    result: &ContentSearchResult,
) -> SearchMetadataResponse {
    SearchMetadataResponse {
        backend: result.backend,
        repo_phase: result.repo_status.phase,
        base_advance_in_progress: result.repo_status.base_advance_in_progress,
        workspace_probe_pending: result.repo_status.workspace_probe_pending,
        candidate_docs: result.candidate_docs,
        matched_lines: result.matched_lines,
        matched_occurrences: result.matched_occurrences,
    }
}

async fn index_workspace_root(
    state: &State<'_, AppState>,
    request: &SearchRepoIndexRequest,
) -> Result<String, String> {
    let workspace = if let Some(id) = request.workspace_id.as_deref() {
        state
            .workspace_service
            .require_workspace(id)
            .await
            .map_err(|e| e.to_string())?
    } else {
        state
            .workspace_service
            .resolve_legacy_workspace_reference(None, &request.root_path, None, None)
            .await
            .map_err(|e| e.to_string())?
            .ok_or("Legacy search workspace cannot be resolved; select its ID")?
    };
    if workspace.workspace_kind == openbitfun_core::service::workspace::WorkspaceKind::Remote {
        return Err("Flashgrep is not supported for remote workspaces".into());
    }
    let root = workspace.root_path.to_string_lossy().into_owned();
    if let Some(message) = local_workspace_search_unavailable_message(&root).await {
        return Err(message);
    }
    Ok(root)
}

#[tauri::command]
pub async fn search_get_repo_status(
    state: State<'_, AppState>,
    request: SearchRepoIndexRequest,
) -> Result<serde_json::Value, String> {
    let root_path = index_workspace_root(&state, &request).await?;

    state
        .workspace_search_service
        .get_index_status(&root_path)
        .await
        .map(|status| serde_json::to_value(status).unwrap_or_else(|_| serde_json::json!({})))
        .map_err(repo_status_error_message)
}

#[tauri::command]
pub async fn search_build_index(
    state: State<'_, AppState>,
    request: SearchRepoIndexRequest,
) -> Result<serde_json::Value, String> {
    let root_path = index_workspace_root(&state, &request).await?;

    state
        .workspace_search_service
        .build_index(&root_path)
        .await
        .map(|task| serde_json::to_value(task).unwrap_or_else(|_| serde_json::json!({})))
        .map_err(|error| format!("Failed to build workspace index: {}", error))
}

#[tauri::command]
pub async fn search_rebuild_index(
    state: State<'_, AppState>,
    request: SearchRepoIndexRequest,
) -> Result<serde_json::Value, String> {
    let root_path = index_workspace_root(&state, &request).await?;

    state
        .workspace_search_service
        .rebuild_index(&root_path)
        .await
        .map(|task| serde_json::to_value(task).unwrap_or_else(|_| serde_json::json!({})))
        .map_err(|error| format!("Failed to rebuild workspace index: {}", error))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn non_git_workspace_error_is_normalized() {
        let raw = "protocol error: protocol error: indexed daemon workspace requires a Git worktree with a HEAD commit: /home";
        assert_eq!(repo_status_error_message(raw), NON_GIT_WORKSPACE_MESSAGE);
    }

    #[test]
    fn other_errors_keep_their_prefix() {
        let raw = "SSH handshake timed out after 30 seconds";
        assert_eq!(
            repo_status_error_message(raw),
            "Failed to get search repository status: SSH handshake timed out after 30 seconds"
        );
    }

    #[test]
    fn remote_content_search_refusal_names_command_and_denies_local_fallback() {
        let message = remote_content_search_refusal_message(
            "search_file_contents",
            "/home/dev/project",
            "Remote workspace search services are unavailable",
        );
        assert!(message.starts_with("search_file_contents cannot search remote workspace path"));
        assert!(message.contains("/home/dev/project"));
        assert!(message.contains("Remote workspace search services are unavailable"));
        assert!(message.contains("local filesystem fallback was not attempted"));
    }
}
