//! Commands API - Core Application Commands

use crate::api::app_state::AppState;
use crate::api::dto::WorkspaceInfoDto;
use crate::api::path_target::{
    create_directory as create_desktop_directory, create_empty_file,
    delete_directory as delete_desktop_directory, delete_file as delete_desktop_file,
    get_path_metadata, path_exists, read_text_file, rename_path, resolve_desktop_path_target,
    DesktopPathTarget,
};
use crate::api::search_api::{
    build_content_search_request, group_search_results, prepare_content_search_runner,
    remote_content_search_refusal, remote_content_search_refusal_message,
    search_file_contents_via_workspace_search, search_metadata_from_content_result,
    should_use_workspace_search, SearchMetadataResponse,
};
use crate::api::workspace_activation::spawn_workspace_background_warmup;
use crate::startup_trace::DesktopStartupTrace;
use log::{debug, error, info, warn};
use openbitfun_core::infrastructure::{
    BatchedFileSearchProgressSink, FileSearchResult, FileSearchResultGroup, FileTreeNode,
    SearchMatchType,
};
use openbitfun_core::service::file_watch;
use openbitfun_core::service::remote_ssh::get_remote_workspace_manager;
use openbitfun_core::service::remote_ssh::{
    search_remote_file_names, shell_quote_posix, RemoteFileNameSearch,
};
use openbitfun_core::service::workspace::{ScanOptions, WorkspaceInfo, WorkspaceKind};
use openbitfun_core_types::product_identity::hidden_data_directory;
use serde::{Deserialize, Serialize};
use std::io::{Read, Write};
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, Mutex, MutexGuard};
use std::time::{Duration, Instant, SystemTime, UNIX_EPOCH};
use tauri::{AppHandle, Emitter, State};

struct WorkspaceStateSnapshot {
    current_workspace: Option<WorkspaceInfoDto>,
    recent_workspaces: Vec<WorkspaceInfoDto>,
    opened_workspaces: Vec<WorkspaceInfoDto>,
    primary_assistant_workspace_id: Option<String>,
    legacy_remote_workspace: Option<crate::api::RemoteWorkspace>,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct WorkspaceStartupStateSnapshotDto {
    pub cleanup_removed_count: usize,
    pub current_workspace: Option<WorkspaceInfoDto>,
    pub recent_workspaces: Vec<WorkspaceInfoDto>,
    pub opened_workspaces: Vec<WorkspaceInfoDto>,
    pub primary_assistant_workspace_id: Option<String>,
    pub legacy_remote_workspace: Option<crate::api::RemoteWorkspace>,
}

fn remote_workspace_from_info(info: &WorkspaceInfo) -> Option<crate::api::RemoteWorkspace> {
    if info.workspace_kind != WorkspaceKind::Remote {
        return None;
    }
    let cid = info.metadata.get("connectionId")?.as_str()?.to_string();
    let name = info
        .metadata
        .get("connectionName")
        .and_then(|v| v.as_str())
        .unwrap_or(&cid)
        .to_string();
    let rp = openbitfun_core::service::remote_ssh::normalize_remote_workspace_path(
        &info.root_path.to_string_lossy(),
    );
    let ssh_host = info
        .metadata
        .get("sshHost")
        .and_then(|v| v.as_str())
        .unwrap_or("")
        .to_string();
    Some(crate::api::RemoteWorkspace {
        connection_id: cid,
        remote_path: rp,
        connection_name: name,
        ssh_host,
    })
}

fn lock_active_searches<'a>(
    state: &'a State<'_, AppState>,
) -> MutexGuard<'a, std::collections::HashMap<String, Arc<AtomicBool>>> {
    match state.active_searches.lock() {
        Ok(guard) => guard,
        Err(poisoned) => {
            warn!("Active search registry mutex was poisoned, recovering lock");
            poisoned.into_inner()
        }
    }
}

fn register_search(
    state: &State<'_, AppState>,
    search_id: Option<&str>,
) -> Option<Arc<AtomicBool>> {
    let search_id = search_id.filter(|value| !value.is_empty())?;

    let cancel_flag = Arc::new(AtomicBool::new(false));
    let mut active_searches = lock_active_searches(state);
    if let Some(previous_flag) = active_searches.insert(search_id.to_string(), cancel_flag.clone())
    {
        previous_flag.store(true, Ordering::Relaxed);
    }

    Some(cancel_flag)
}

fn unregister_search(state: &State<'_, AppState>, search_id: Option<&str>) {
    let Some(search_id) = search_id.filter(|value| !value.is_empty()) else {
        return;
    };

    lock_active_searches(state).remove(search_id);
}

fn unregister_search_registry(
    active_searches: &Arc<Mutex<std::collections::HashMap<String, Arc<AtomicBool>>>>,
    search_id: Option<&str>,
) {
    let Some(search_id) = search_id.filter(|value| !value.is_empty()) else {
        return;
    };

    match active_searches.lock() {
        Ok(mut guard) => {
            guard.remove(search_id);
        }
        Err(poisoned) => {
            warn!("Active search registry mutex was poisoned, recovering lock");
            poisoned.into_inner().remove(search_id);
        }
    }
}

fn serialize_search_result(result: &FileSearchResult) -> serde_json::Value {
    serde_json::json!({
        "path": result.path,
        "name": result.name,
        "isDirectory": result.is_directory,
        "matchType": match result.match_type {
            SearchMatchType::FileName => "fileName",
            SearchMatchType::Content => "content",
        },
        "lineNumber": result.line_number,
        "matchedContent": result.matched_content,
        "previewBefore": result.preview_before,
        "previewInside": result.preview_inside,
        "previewAfter": result.preview_after,
    })
}

fn serialize_search_results(results: Vec<FileSearchResult>) -> Vec<serde_json::Value> {
    results
        .into_iter()
        .map(|result| serialize_search_result(&result))
        .collect::<Vec<_>>()
}

fn serialize_search_result_group(result: &FileSearchResultGroup) -> serde_json::Value {
    serde_json::json!({
        "path": result.path,
        "name": result.name,
        "isDirectory": result.is_directory,
        "fileNameMatch": result.file_name_match.as_ref().map(serialize_search_result),
        "contentMatches": result.content_matches.iter().map(serialize_search_result).collect::<Vec<_>>(),
    })
}

fn serialize_search_result_groups(results: Vec<FileSearchResultGroup>) -> Vec<serde_json::Value> {
    results
        .iter()
        .map(serialize_search_result_group)
        .collect::<Vec<_>>()
}

fn count_search_result_groups(results: &[FileSearchResult]) -> usize {
    let mut paths = std::collections::HashSet::new();
    for result in results {
        paths.insert(result.path.as_str());
    }
    paths.len()
}

const FILE_SEARCH_PROGRESS_EVENT: &str = "file-search://progress";
const FILE_SEARCH_COMPLETE_EVENT: &str = "file-search://complete";
const FILE_SEARCH_ERROR_EVENT: &str = "file-search://error";
const FILE_SEARCH_BATCH_SIZE: usize = 32;
const FILE_SEARCH_FLUSH_INTERVAL_MS: u64 = 40;

#[derive(Debug, Clone, Copy)]
enum SearchStreamKind {
    Filenames,
    Content,
}

impl SearchStreamKind {
    fn as_str(self) -> &'static str {
        match self {
            Self::Filenames => "filenames",
            Self::Content => "content",
        }
    }
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
struct SearchStreamStartResponse {
    search_id: String,
    limit: usize,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
struct SearchProgressEvent {
    search_id: String,
    search_kind: &'static str,
    results: Vec<serde_json::Value>,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
struct SearchCompleteEvent {
    search_id: String,
    search_kind: &'static str,
    limit: usize,
    truncated: bool,
    total_results: usize,
    #[serde(skip_serializing_if = "Option::is_none")]
    search_metadata: Option<SearchMetadataResponse>,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
struct SearchErrorEvent {
    search_id: String,
    search_kind: &'static str,
    error: String,
}

fn generate_search_id(prefix: &str) -> String {
    let millis = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .unwrap_or_default()
        .as_millis();
    format!("{}-{}", prefix, millis)
}

fn ensure_search_id(search_id: Option<String>, prefix: &str) -> String {
    search_id
        .filter(|value| !value.is_empty())
        .unwrap_or_else(|| generate_search_id(prefix))
}

fn emit_search_progress(
    app_handle: &AppHandle,
    search_id: &str,
    search_kind: SearchStreamKind,
    results: Vec<FileSearchResultGroup>,
) {
    if results.is_empty() {
        return;
    }

    if let Err(error) = app_handle.emit(
        FILE_SEARCH_PROGRESS_EVENT,
        SearchProgressEvent {
            search_id: search_id.to_string(),
            search_kind: search_kind.as_str(),
            results: serialize_search_result_groups(results),
        },
    ) {
        warn!(
            "Failed to emit search progress event: search_id={}, search_kind={}, error={}",
            search_id,
            search_kind.as_str(),
            error
        );
    }
}

fn emit_search_complete(
    app_handle: &AppHandle,
    search_id: &str,
    search_kind: SearchStreamKind,
    limit: usize,
    truncated: bool,
    total_results: usize,
    search_metadata: Option<SearchMetadataResponse>,
) {
    if let Err(error) = app_handle.emit(
        FILE_SEARCH_COMPLETE_EVENT,
        SearchCompleteEvent {
            search_id: search_id.to_string(),
            search_kind: search_kind.as_str(),
            limit,
            truncated,
            total_results,
            search_metadata,
        },
    ) {
        warn!(
            "Failed to emit search completion event: search_id={}, search_kind={}, error={}",
            search_id,
            search_kind.as_str(),
            error
        );
    }
}

fn emit_search_error(
    app_handle: &AppHandle,
    search_id: &str,
    search_kind: SearchStreamKind,
    error_message: &str,
) {
    if let Err(error) = app_handle.emit(
        FILE_SEARCH_ERROR_EVENT,
        SearchErrorEvent {
            search_id: search_id.to_string(),
            search_kind: search_kind.as_str(),
            error: error_message.to_string(),
        },
    ) {
        warn!(
            "Failed to emit search error event: search_id={}, search_kind={}, error={}",
            search_id,
            search_kind.as_str(),
            error
        );
    }
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
struct SearchCommandResponse {
    results: Vec<serde_json::Value>,
    limit: usize,
    truncated: bool,
    #[serde(skip_serializing_if = "Option::is_none")]
    search_metadata: Option<SearchMetadataResponse>,
}

fn serialize_search_response(
    outcome: openbitfun_core::infrastructure::FileSearchOutcome,
    limit: usize,
    search_metadata: Option<SearchMetadataResponse>,
) -> serde_json::Value {
    serde_json::to_value(SearchCommandResponse {
        results: serialize_search_results(outcome.results),
        limit,
        truncated: outcome.truncated,
        search_metadata,
    })
    .unwrap_or_else(|_| {
        serde_json::json!({ "results": [], "limit": limit, "truncated": false, "searchMetadata": null })
    })
}

#[derive(Debug, Deserialize)]
pub struct OpenWorkspaceRequest {
    /// Explicit folder creation; never resolve its environment through a path.
    #[serde(default, rename = "createLocal")]
    pub create_local: bool,
    #[serde(default, rename = "workspaceId")]
    pub workspace_id: Option<String>,
    /// New-folder creation or upgrade-only payload from a pre-ID client.
    #[serde(default)]
    pub path: String,
    /// Optional SSH connection scope for a remote root that is already known to OpenBitFun. Path-only
    /// callers may omit it; the workspace service then resolves the connection from history.
    #[serde(default, rename = "remoteConnectionId")]
    pub remote_connection_id: Option<String>,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct OpenRemoteWorkspaceRequest {
    pub remote_path: String,
    pub connection_id: String,
    pub connection_name: String,
    /// SSH config `host` (DNS or alias). When set, used for session mirror paths even if not connected.
    #[serde(default)]
    pub ssh_host: Option<String>,
}

#[derive(Debug, Deserialize, Default)]
pub struct CreateAssistantWorkspaceRequest {}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ScanWorkspaceInfoRequest {
    #[serde(default)]
    pub workspace_id: Option<String>,
    /// Upgrade-only: removed after pre-ID clients are no longer supported.
    #[serde(default)]
    pub workspace_path: String,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct CloseWorkspaceRequest {
    pub workspace_id: String,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SetActiveWorkspaceRequest {
    pub workspace_id: String,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct DeleteAssistantWorkspaceRequest {
    pub workspace_id: String,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SetPrimaryAssistantWorkspaceRequest {
    pub workspace_id: String,
}

#[derive(Debug, Deserialize, Default)]
pub struct GetPrimaryAssistantWorkspaceRequest {}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ResetAssistantWorkspaceRequest {
    pub workspace_id: String,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct RemoveRecentWorkspaceRequest {
    pub workspace_id: String,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ReorderOpenedWorkspacesRequest {
    pub workspace_ids: Vec<String>,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct UpdateWorkspaceInfoRequest {
    pub workspace_id: String,
    pub name: Option<String>,
    pub description: Option<String>,
    pub tags: Option<Vec<String>>,
    #[serde(default)]
    pub related_paths: Option<Vec<openbitfun_core::service::workspace::RelatedPath>>,
}

#[derive(Debug, Deserialize)]
pub struct TestAIConfigConnectionRequest {
    pub config: openbitfun_core::service::config::types::AIModelConfig,
}

#[derive(Debug, Deserialize)]
pub struct ListAIModelsByConfigRequest {
    pub config: openbitfun_core::service::config::types::AIModelConfig,
}

#[derive(Debug, Deserialize)]
pub struct UpdateAppStatusRequest {
    pub status: String,
    pub message: Option<String>,
}

#[derive(Debug, Deserialize)]
pub struct ReadFileContentRequest {
    #[serde(default, rename = "workspaceId", alias = "workspace_id")]
    pub workspace_id: Option<String>,
    #[serde(rename = "filePath")]
    pub file_path: String,
    pub encoding: Option<String>,
    #[serde(default, rename = "remoteConnectionId")]
    pub remote_connection_id: Option<String>,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ImportAgentCompanionPetPackageRequest {
    pub path: String,
    #[serde(default)]
    pub expected_fingerprint: Option<String>,
    #[serde(default)]
    pub builtin_id: Option<String>,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct DeleteAgentCompanionPetPackageRequest {
    pub package_path: String,
}

pub use openbitfun_services_core::pet_packages::PetPackage as AgentCompanionPetPackageDto;

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ListAgentCompanionPetsRequest {
    #[serde(default)]
    pub include_external: bool,
    #[serde(default)]
    pub builtin_import_version: Option<u32>,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ListAgentCompanionPetsResponse {
    pub pets: Vec<AgentCompanionPetPackageDto>,
    pub import_operations_version: u32,
    pub builtin_import_version: u32,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub external: Option<openbitfun_services_core::pet_packages::PetCatalog>,
}

#[derive(Debug, Deserialize)]
pub struct WriteFileContentRequest {
    #[serde(default, rename = "workspaceId", alias = "workspace_id")]
    pub workspace_id: Option<String>,
    /// Temporary legacy wire field; current clients select by ID.
    #[serde(default, rename = "workspacePath")]
    pub workspace_path: String,
    #[serde(rename = "filePath")]
    pub file_path: String,
    pub content: String,
    #[serde(default, rename = "remoteConnectionId")]
    pub remote_connection_id: Option<String>,
    #[serde(default, rename = "expectedHash")]
    pub expected_hash: Option<String>,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ResetWorkspacePersonaFilesRequest {
    /// Owning assistant workspace ID; authoritative when present.
    #[serde(default)]
    pub workspace_id: Option<String>,
    /// Legacy path reference for pre-ID clients; the root is only an IO operand.
    #[serde(default)]
    pub workspace_path: Option<String>,
}

#[derive(Debug, Deserialize)]
pub struct CheckPathExistsRequest {
    #[serde(default, rename = "workspaceId", alias = "workspace_id")]
    pub workspace_id: Option<String>,
    pub path: String,
    #[serde(default, rename = "remoteConnectionId")]
    pub remote_connection_id: Option<String>,
}

#[derive(Debug, Deserialize)]
pub struct GetFileMetadataRequest {
    #[serde(default, rename = "workspaceId", alias = "workspace_id")]
    pub workspace_id: Option<String>,
    pub path: String,
    #[serde(default, rename = "remoteConnectionId")]
    pub remote_connection_id: Option<String>,
}

#[derive(Debug, Deserialize)]
pub struct GetFileTreeRequest {
    #[serde(default, rename = "workspaceId", alias = "workspace_id")]
    pub workspace_id: Option<String>,
    pub path: String,
    pub max_depth: Option<usize>,
    #[serde(default, rename = "remoteConnectionId")]
    pub remote_connection_id: Option<String>,
}

#[derive(Debug, Deserialize)]
pub struct GetDirectoryChildrenRequest {
    #[serde(default, rename = "workspaceId", alias = "workspace_id")]
    pub workspace_id: Option<String>,
    pub path: String,
    #[serde(default, rename = "remoteConnectionId")]
    pub remote_connection_id: Option<String>,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct GetDirectoryChildrenPaginatedRequest {
    #[serde(default, rename = "workspaceId", alias = "workspace_id")]
    pub workspace_id: Option<String>,
    pub path: String,
    pub offset: Option<usize>,
    pub limit: Option<usize>,
    #[serde(default)]
    pub remote_connection_id: Option<String>,
    #[serde(default)]
    pub sort_by: Option<String>,
    #[serde(default)]
    pub sort_order: Option<String>,
}

pub type ExplorerGetFileTreeRequest = GetFileTreeRequest;
pub type ExplorerGetChildrenRequest = GetDirectoryChildrenRequest;
pub type ExplorerGetChildrenPaginatedRequest = GetDirectoryChildrenPaginatedRequest;

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SearchFilesRequest {
    #[serde(default)]
    pub workspace_id: Option<String>,
    /// Upgrade-only input. Current callers send workspaceId.
    #[serde(default)]
    pub root_path: String,
    pub pattern: String,
    pub search_content: bool,
    #[serde(default)]
    pub remote_connection_id: Option<String>,
    #[serde(default)]
    pub search_id: Option<String>,
    #[serde(default)]
    pub case_sensitive: bool,
    #[serde(default)]
    pub use_regex: bool,
    #[serde(default)]
    pub whole_word: bool,
    #[serde(default)]
    pub max_results: Option<usize>,
    #[serde(default = "default_include_directories")]
    pub include_directories: bool,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SearchFilenamesRequest {
    #[serde(default)]
    pub workspace_id: Option<String>,
    /// Upgrade-only input. Current callers send workspaceId.
    #[serde(default)]
    pub root_path: String,
    pub pattern: String,
    #[serde(default)]
    pub remote_connection_id: Option<String>,
    #[serde(default)]
    pub search_id: Option<String>,
    #[serde(default)]
    pub case_sensitive: bool,
    #[serde(default)]
    pub use_regex: bool,
    #[serde(default)]
    pub whole_word: bool,
    #[serde(default)]
    pub max_results: Option<usize>,
    #[serde(default = "default_include_directories")]
    pub include_directories: bool,
}

#[cfg(test)]
mod search_filenames_request_tests {
    use super::SearchFilenamesRequest;

    #[test]
    fn legacy_payload_without_remote_scope_remains_readable() {
        let request: SearchFilenamesRequest = serde_json::from_value(serde_json::json!({
            "rootPath": "/workspace",
            "pattern": "src"
        }))
        .expect("deserialize legacy filename search request");

        assert_eq!(request.remote_connection_id, None);
        assert!(request.include_directories);
    }

    #[test]
    fn remote_scope_is_deserialized_when_supplied() {
        let request: SearchFilenamesRequest = serde_json::from_value(serde_json::json!({
            "rootPath": "/workspace",
            "pattern": "src",
            "remoteConnectionId": "remote-connection-1"
        }))
        .expect("deserialize scoped filename search request");

        assert_eq!(
            request.remote_connection_id.as_deref(),
            Some("remote-connection-1")
        );
    }
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SearchFileContentsRequest {
    #[serde(default)]
    pub workspace_id: Option<String>,
    /// Upgrade-only input. Current callers send workspaceId.
    #[serde(default)]
    pub root_path: String,
    pub pattern: String,
    #[serde(default)]
    pub search_id: Option<String>,
    #[serde(default)]
    pub case_sensitive: bool,
    #[serde(default)]
    pub use_regex: bool,
    #[serde(default)]
    pub whole_word: bool,
    #[serde(default)]
    pub max_results: Option<usize>,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct CancelSearchRequest {
    pub search_id: String,
}

const DEFAULT_FILENAME_SEARCH_RESULTS: usize = 512;
const DEFAULT_CONTENT_SEARCH_RESULTS: usize = 1_000;
const HARD_MAX_SEARCH_RESULTS: usize = 2_000;

fn default_include_directories() -> bool {
    true
}

fn resolve_search_limit(requested: Option<usize>, fallback: usize) -> usize {
    requested
        .unwrap_or(fallback)
        .clamp(1, HARD_MAX_SEARCH_RESULTS)
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct RenameFileRequest {
    #[serde(default, rename = "workspaceId", alias = "workspace_id")]
    pub workspace_id: Option<String>,
    pub old_path: String,
    pub new_path: String,
    #[serde(default)]
    pub remote_connection_id: Option<String>,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ExportLocalFileRequest {
    #[serde(default)]
    pub controller_local: bool,
    #[serde(default)]
    pub workspace_id: Option<String>,
    pub source_path: String,
    pub destination_path: String,
}

#[derive(Debug, Deserialize)]
pub struct DeleteFileRequest {
    #[serde(default, rename = "workspaceId", alias = "workspace_id")]
    pub workspace_id: Option<String>,
    pub path: String,
    #[serde(default, rename = "remoteConnectionId")]
    pub remote_connection_id: Option<String>,
}

#[derive(Debug, Deserialize)]
pub struct DeleteDirectoryRequest {
    #[serde(default, rename = "workspaceId", alias = "workspace_id")]
    pub workspace_id: Option<String>,
    pub path: String,
    pub recursive: Option<bool>,
    #[serde(default, rename = "remoteConnectionId")]
    pub remote_connection_id: Option<String>,
}

#[derive(Debug, Deserialize)]
pub struct CreateFileRequest {
    #[serde(default, rename = "workspaceId", alias = "workspace_id")]
    pub workspace_id: Option<String>,
    pub path: String,
    #[serde(default, rename = "remoteConnectionId")]
    pub remote_connection_id: Option<String>,
}

#[derive(Debug, Deserialize)]
pub struct CreateDirectoryRequest {
    #[serde(default, rename = "workspaceId", alias = "workspace_id")]
    pub workspace_id: Option<String>,
    pub path: String,
    #[serde(default, rename = "remoteConnectionId")]
    pub remote_connection_id: Option<String>,
}

#[derive(Debug, Deserialize)]
pub struct RevealInExplorerRequest {
    #[serde(default, rename = "workspaceId", alias = "workspace_id")]
    pub workspace_id: Option<String>,
    pub path: String,
}

async fn clear_active_workspace_context(
    state: &State<'_, AppState>,
    app: &AppHandle,
    startup_trace: Option<&DesktopStartupTrace>,
) {
    #[cfg(not(target_os = "macos"))]
    let _ = app;

    let step_started = Instant::now();
    let previous_workspace_id = state.workspace_id.write().await.take();
    if let Some(trace) = startup_trace {
        trace.record_elapsed_step(
            "tauri_command",
            "initialize_global_state.clear_active_workspace_path",
            step_started,
        );
    }

    if let Some(previous_workspace_id) = previous_workspace_id {
        let step_started = Instant::now();
        if let Some(previous) = state
            .workspace_service
            .get_workspace(&previous_workspace_id)
            .await
        {
            if previous.workspace_kind != WorkspaceKind::Remote {
                state
                    .workspace_search_service
                    .schedule_repo_release(previous.root_path);
            }
        }
        if let Some(trace) = startup_trace {
            trace.record_elapsed_step(
                "tauri_command",
                "initialize_global_state.release_previous_workspace_search",
                step_started,
            );
        }
    }

    if let Some(ref pool) = state.js_worker_pool {
        let step_started = Instant::now();
        pool.stop_all().await;
        if let Some(trace) = startup_trace {
            trace.record_elapsed_step(
                "tauri_command",
                "initialize_global_state.stop_js_worker_pool",
                step_started,
            );
        }
    }

    let step_started = Instant::now();
    state.agent_registry.clear_custom_subagents();
    if let Some(trace) = startup_trace {
        trace.record_elapsed_step(
            "tauri_command",
            "initialize_global_state.clear_custom_subagents",
            step_started,
        );
    }

    #[cfg(target_os = "macos")]
    {
        let step_started = Instant::now();
        let language = state
            .config_service
            .get_config::<String>(Some("app.language"))
            .await
            .unwrap_or_else(|_| "zh-CN".to_string());
        let edit_mode = *state.macos_edit_menu_mode.read().await;
        let _ = crate::macos_menubar::set_macos_menubar_with_mode(
            app,
            &language,
            crate::macos_menubar::MenubarMode::Startup,
            edit_mode,
        );
        if let Some(trace) = startup_trace {
            trace.record_elapsed_step(
                "tauri_command",
                "initialize_global_state.set_macos_startup_menubar",
                step_started,
            );
        }
    }
}

async fn apply_active_workspace_context(
    state: &State<'_, AppState>,
    app: &AppHandle,
    workspace_info: &openbitfun_core::service::workspace::manager::WorkspaceInfo,
    startup_trace: Option<&DesktopStartupTrace>,
) {
    #[cfg(not(target_os = "macos"))]
    let _ = app;

    let step_started = Instant::now();
    clear_active_workspace_context(state, app, startup_trace).await;
    if let Some(trace) = startup_trace {
        trace.record_elapsed_step(
            "tauri_command",
            "initialize_global_state.clear_active_workspace_context",
            step_started,
        );
    }

    let step_started = Instant::now();
    *state.workspace_id.write().await = Some(workspace_info.id.clone());
    if let Some(trace) = startup_trace {
        trace.record_elapsed_step(
            "tauri_command",
            "initialize_global_state.set_active_workspace_path",
            step_started,
        );
    }

    let step_started = Instant::now();
    spawn_workspace_background_warmup(state, workspace_info.clone());
    if let Some(trace) = startup_trace {
        trace.record_elapsed_step(
            "tauri_command",
            "initialize_global_state.spawn_workspace_background_warmup",
            step_started,
        );
    }

    #[cfg(target_os = "macos")]
    {
        let step_started = Instant::now();
        let language = state
            .config_service
            .get_config::<String>(Some("app.language"))
            .await
            .unwrap_or_else(|_| "zh-CN".to_string());
        let edit_mode = *state.macos_edit_menu_mode.read().await;
        let _ = crate::macos_menubar::set_macos_menubar_with_mode(
            app,
            &language,
            crate::macos_menubar::MenubarMode::Workspace,
            edit_mode,
        );
        if let Some(trace) = startup_trace {
            trace.record_elapsed_step(
                "tauri_command",
                "initialize_global_state.set_macos_workspace_menubar",
                step_started,
            );
        }
    }

    // Keep global SSH registry + active connection hint aligned with the **foreground** workspace
    // so two servers opened at the same remote path (e.g. `/`) stay distinct.
    let step_started = Instant::now();
    if workspace_info.workspace_kind == WorkspaceKind::Remote {
        if let Some(rw) = remote_workspace_from_info(workspace_info) {
            if let Err(e) = state.set_remote_workspace(rw).await {
                warn!(
                    "Failed to sync remote workspace registry for active workspace: {}",
                    e
                );
            }
        }
    } else {
        *state.remote_workspace.write().await = None;
        if let Some(m) = get_remote_workspace_manager() {
            m.set_active_connection_hint(None).await;
        }
    }
    if let Some(trace) = startup_trace {
        trace.record_elapsed_step(
            "tauri_command",
            "initialize_global_state.sync_remote_workspace_context",
            step_started,
        );
    }
}

async fn initialize_global_state_impl(
    state: &State<'_, AppState>,
    app: &tauri::AppHandle,
    trace: &DesktopStartupTrace,
) {
    let total_started = Instant::now();
    let step_started = Instant::now();
    let current_workspace = state.workspace_service.get_current_workspace().await;
    trace.record_elapsed_step(
        "tauri_command",
        "initialize_global_state.get_current_workspace",
        step_started,
    );

    if let Some(workspace_info) = current_workspace {
        let step_started = Instant::now();
        apply_active_workspace_context(state, app, &workspace_info, Some(trace)).await;
        trace.record_elapsed_step(
            "tauri_command",
            "initialize_global_state.apply_active_workspace_context",
            step_started,
        );

        info!(
            "Global state initialized with active workspace: workspace_id={}, path={}",
            workspace_info.id,
            workspace_info.root_path.display()
        );
    } else {
        let step_started = Instant::now();
        clear_active_workspace_context(state, app, Some(trace)).await;
        trace.record_elapsed_step(
            "tauri_command",
            "initialize_global_state.clear_active_workspace_context",
            step_started,
        );
        info!("Global state initialized without active workspace");
    }

    trace.record_elapsed_step(
        "tauri_command",
        "initialize_global_state.total",
        total_started,
    );
}

#[tauri::command]
pub async fn get_available_tools(state: State<'_, AppState>) -> Result<Vec<String>, String> {
    Ok(state.get_tool_names())
}

#[tauri::command]
pub async fn get_health_status(
    state: State<'_, AppState>,
) -> Result<crate::api::HealthStatus, String> {
    Ok(state.get_health_status().await)
}

#[tauri::command]
pub async fn get_statistics(
    state: State<'_, AppState>,
) -> Result<crate::api::AppStatistics, String> {
    Ok(state.get_statistics().await)
}

#[tauri::command]
pub async fn test_ai_connection(state: State<'_, AppState>) -> Result<bool, String> {
    let ai_client = state.ai_client.read().await;
    Ok(ai_client.is_some())
}

#[tauri::command]
pub async fn initialize_ai(state: State<'_, AppState>) -> Result<String, String> {
    let config_service = &state.config_service;
    let global_config: openbitfun_core::service::config::GlobalConfig = config_service
        .get_config(None)
        .await
        .map_err(|e| format!("Failed to get configuration: {}", e))?;
    let primary_model_id = global_config
        .ai
        .default_models
        .primary
        .clone()
        .ok_or_else(|| {
            "Primary model not configured, please configure it in settings".to_string()
        })?;
    let model_config = global_config
        .ai
        .models
        .iter()
        .find(|m| m.id == primary_model_id)
        .ok_or_else(|| format!("Primary model '{}' does not exist", primary_model_id))?;
    let ai_client = create_transient_ai_client_for_config(&state, model_config.clone()).await?;

    {
        let mut ai_client_guard = state.ai_client.write().await;
        *ai_client_guard = Some(ai_client);
    }

    info!("AI client initialized: model={}", model_config.name);
    Ok(format!(
        "AI client initialized successfully: {}",
        model_config.name
    ))
}

async fn create_transient_ai_client_for_config(
    state: &State<'_, AppState>,
    model_config: openbitfun_core::service::config::types::AIModelConfig,
) -> Result<openbitfun_core::infrastructure::ai::AIClient, String> {
    let auth = model_config.auth.clone();

    let global_config: openbitfun_core::service::config::GlobalConfig = state
        .config_service
        .get_config(None)
        .await
        .map_err(|e| format!("Failed to get configuration: {}", e))?;
    let stream_options = openbitfun_core::infrastructure::ai::build_stream_options_for_model(
        &global_config.ai,
        Some(&model_config),
    );

    let mut ai_config: openbitfun_core::util::types::AIConfig = model_config
        .try_into()
        .map_err(|e| format!("Failed to convert configuration: {}", e))?;
    let skip_ssl_verify = ai_config.skip_ssl_verify;

    let proxy_config = if global_config.ai.proxy.enabled {
        Some(global_config.ai.proxy.clone())
    } else {
        None
    };
    let subscription_options =
        openbitfun_core::infrastructure::subscription_auth::SubscriptionHttpOptions::new(
            proxy_config.clone(),
            skip_ssl_verify,
        );

    openbitfun_core::infrastructure::ai::client_factory::apply_subscription_auth_with_options(
        &auth,
        &mut ai_config,
        &subscription_options,
    )
    .await
    .map_err(|e| format!("Failed to resolve subscription auth: {}", e))?;

    Ok(
        openbitfun_core::infrastructure::ai::client_factory::apply_subscription_request_profile(
            &auth,
            openbitfun_core::infrastructure::ai::AIClient::new_with_runtime_options(
                ai_config,
                proxy_config,
                stream_options,
            ),
        ),
    )
}

#[tauri::command]
pub async fn test_ai_config_connection(
    state: State<'_, AppState>,
    request: TestAIConfigConnectionRequest,
) -> Result<openbitfun_core::util::types::ConnectionTestResult, String> {
    let model_name = request.config.name.clone();
    let supports_image_input = request.config.capabilities.iter().any(|cap| {
        matches!(
            cap,
            openbitfun_core::service::config::types::ModelCapability::ImageUnderstanding
        )
    }) || matches!(
        request.config.category,
        openbitfun_core::service::config::types::ModelCategory::Multimodal
    );

    let ai_client = create_transient_ai_client_for_config(&state, request.config)
        .await
        .map_err(|e| {
            error!("Failed to create AI client during test: {}", e);
            e
        })?;

    match ai_client.test_connection().await {
        Ok(result) => {
            if !result.success {
                info!(
                    "AI config connection test completed: model={}, success={}, response_time={}ms",
                    model_name, result.success, result.response_time_ms
                );
                return Ok(result);
            }

            if supports_image_input {
                match ai_client.test_image_input_connection().await {
                    Ok(image_result) => {
                        let response_time_ms =
                            result.response_time_ms + image_result.response_time_ms;

                        if !image_result.success {
                            let merged = openbitfun_core::util::types::ConnectionTestResult {
                                success: false,
                                response_time_ms,
                                model_response: image_result
                                    .model_response
                                    .or(result.model_response),
                                message_code: image_result.message_code,
                                error_details: image_result.error_details,
                            };
                            info!(
                                "AI config connection test completed: model={}, success={}, response_time={}ms",
                                model_name, merged.success, merged.response_time_ms
                            );
                            return Ok(merged);
                        }

                        let merged = openbitfun_core::util::types::ConnectionTestResult {
                            success: true,
                            response_time_ms,
                            model_response: image_result.model_response.or(result.model_response),
                            message_code: result.message_code,
                            error_details: result.error_details,
                        };
                        info!(
                            "AI config connection test completed: model={}, success={}, response_time={}ms",
                            model_name, merged.success, merged.response_time_ms
                        );
                        return Ok(merged);
                    }
                    Err(e) => {
                        error!(
                            "AI config multimodal image input test failed unexpectedly: model={}, error={}",
                            model_name, e
                        );
                        return Err(format!("Connection test failed: {}", e));
                    }
                }
            }

            info!(
                "AI config connection test completed: model={}, success={}, response_time={}ms",
                model_name, result.success, result.response_time_ms
            );
            Ok(result)
        }
        Err(e) => {
            error!(
                "AI config connection test failed: model={}, error={}",
                model_name, e
            );
            Err(format!("Connection test failed: {}", e))
        }
    }
}

#[tauri::command]
pub async fn list_ai_models_by_config(
    state: State<'_, AppState>,
    request: ListAIModelsByConfigRequest,
) -> Result<Vec<openbitfun_core::util::types::RemoteModelInfo>, String> {
    let config_name = request.config.name.clone();
    let ai_client = create_transient_ai_client_for_config(&state, request.config).await?;

    ai_client.list_models().await.map_err(|e| {
        error!(
            "Failed to list models for config: name={}, error={}",
            config_name, e
        );
        format!("Failed to list models: {}", e)
    })
}

#[tauri::command]
pub async fn refresh_model_client(
    state: State<'_, AppState>,
    model_id: String,
) -> Result<String, String> {
    state.ai_client_factory.invalidate_model(&model_id);

    Ok(format!("Model '{}' has been refreshed", model_id))
}

#[tauri::command]
pub async fn get_app_state(state: State<'_, AppState>) -> Result<serde_json::Value, String> {
    let health = state.get_health_status().await;
    let stats = state.get_statistics().await;

    let app_state = serde_json::json!({
        "status": if health.status == "healthy" { "Running" } else { "Error" },
        "message": health.message,
        "uptime_seconds": health.uptime_seconds,
        "sessions_created": stats.sessions_created,
        "messages_processed": stats.messages_processed,
        "tools_executed": stats.tools_executed,
        "services": health.services,
        "tool_count": state.get_tool_names().len(),
    });

    Ok(app_state)
}

#[tauri::command]
pub async fn update_app_status(
    _state: State<'_, AppState>,
    _request: UpdateAppStatusRequest,
) -> Result<(), String> {
    Ok(())
}

#[tauri::command]
pub async fn open_workspace(
    state: State<'_, AppState>,
    app: tauri::AppHandle,
    request: OpenWorkspaceRequest,
) -> Result<WorkspaceInfoDto, String> {
    let result = if let Some(id) = request.workspace_id.as_deref() {
        state.workspace_service.open_workspace_by_id(id).await
    } else if request.create_local {
        state
            .workspace_service
            .open_workspace(request.path.into())
            .await
    } else {
        // Upgrade-only request adapter; normal selection always supplies ID.
        state
            .workspace_service
            .upgrade_legacy_workspace_open(
                request.path.into(),
                request.remote_connection_id.as_deref(),
                None,
            )
            .await
    };
    match result {
        Ok(workspace_info) => {
            apply_active_workspace_context(&state, &app, &workspace_info, None).await;

            if let Err(e) = state
                .workspace_identity_watch_service
                .sync_watched_workspaces()
                .await
            {
                warn!(
                    "Failed to sync workspace identity watchers after open: {}",
                    e
                );
            }

            info!(
                "Workspace opened: name={}, path={}",
                workspace_info.name,
                workspace_info.root_path.display()
            );
            Ok(WorkspaceInfoDto::from_workspace_info(&workspace_info))
        }
        Err(e) => {
            error!("Failed to open workspace: {}", e);
            Err(format!("Failed to open workspace: {}", e))
        }
    }
}

#[tauri::command]
pub async fn open_remote_workspace(
    state: State<'_, AppState>,
    app: tauri::AppHandle,
    request: OpenRemoteWorkspaceRequest,
) -> Result<WorkspaceInfoDto, String> {
    use openbitfun_core::service::remote_ssh::normalize_remote_workspace_path;
    use openbitfun_core::service::remote_ssh::workspace_state::remote_workspace_stable_id;
    use openbitfun_core::service::workspace::WorkspaceCreateOptions;

    let ssh = state.get_ssh_manager_async().await?;
    let saved = ssh
        .get_saved_connections()
        .await
        .into_iter()
        .find(|profile| profile.id == request.connection_id)
        .ok_or("Remote workspace requires a connection saved on this host")?;
    if request
        .ssh_host
        .as_deref()
        .is_some_and(|host| !host.trim().is_empty() && host.trim() != saved.host)
    {
        return Err("SSH host identity does not match the saved connection".into());
    }
    if !request.remote_path.starts_with('/') || request.remote_path.contains('\0') {
        return Err("Remote workspace path must be an absolute POSIX path".into());
    }
    ssh.ensure_connected(&request.connection_id)
        .await
        .map_err(|e| e.to_string())?;
    let files = state.get_remote_file_service_async().await?;
    if !files
        .is_dir(&request.connection_id, &request.remote_path)
        .await
        .map_err(|e| e.to_string())?
    {
        return Err("Remote workspace path is not a directory".into());
    }

    let remote_path = normalize_remote_workspace_path(&request.remote_path);

    let mut ssh_host = request
        .ssh_host
        .as_deref()
        .map(str::trim)
        .filter(|s| !s.is_empty())
        .map(|s| s.to_string());

    if ssh_host.is_none() {
        if let Ok(mgr) = state.get_ssh_manager_async().await {
            ssh_host = mgr
                .get_saved_host_for_connection_id(&request.connection_id)
                .await;
        }
    }
    if ssh_host.is_none() {
        if let Ok(mgr) = state.get_ssh_manager_async().await {
            ssh_host = mgr
                .get_connection_config(&request.connection_id)
                .await
                .map(|c| c.host)
                .map(|h| h.trim().to_string())
                .filter(|s| !s.is_empty());
        }
    }
    let ssh_host = ssh_host.unwrap_or_else(|| {
        warn!(
            "open_remote_workspace: no ssh host from request, saved profile, or active connection; using connection_name (may not match session mirror): connection_id={}",
            request.connection_id
        );
        request.connection_name.clone()
    });

    let stable_workspace_id = remote_workspace_stable_id(&ssh_host, &remote_path);

    let display_name = remote_path
        .split('/')
        .rfind(|s| !s.is_empty())
        .unwrap_or(remote_path.as_str())
        .to_string();

    let options = WorkspaceCreateOptions {
        scan_options: ScanOptions {
            calculate_statistics: false,
            ..ScanOptions::default()
        },
        auto_set_current: true,
        add_to_recent: true,
        workspace_kind: WorkspaceKind::Remote,
        assistant_id: None,
        display_name: Some(display_name),
        description: None,
        tags: Vec::new(),
        remote_connection_id: Some(request.connection_id.clone()),
        remote_ssh_host: Some(ssh_host.clone()),
        stable_workspace_id: Some(stable_workspace_id),
    };

    match state
        .workspace_service
        .open_workspace_with_options(remote_path.clone().into(), options)
        .await
    {
        Ok(mut workspace_info) => {
            workspace_info.metadata.insert(
                "connectionId".to_string(),
                serde_json::Value::String(request.connection_id.clone()),
            );
            workspace_info.metadata.insert(
                "connectionName".to_string(),
                serde_json::Value::String(request.connection_name.clone()),
            );
            workspace_info.metadata.insert(
                "sshHost".to_string(),
                serde_json::Value::String(ssh_host.clone()),
            );

            {
                let manager = state.workspace_service.get_manager();
                let mut manager = manager.write().await;
                if let Some(ws) = manager.get_workspaces_mut().get_mut(&workspace_info.id) {
                    ws.metadata = workspace_info.metadata.clone();
                }
            }
            if let Err(e) = state.workspace_service.manual_save().await {
                warn!(
                    "Failed to save workspace data after opening remote workspace: {}",
                    e
                );
            }

            // Register the remote mapping before applying workspace context so session storage path
            // resolution (`get_effective_session_path`) and related setup see this connection.
            let remote_workspace = crate::api::RemoteWorkspace {
                connection_id: request.connection_id.clone(),
                connection_name: request.connection_name.clone(),
                remote_path: remote_path.clone(),
                ssh_host: ssh_host.clone(),
            };
            if let Err(e) = state.set_remote_workspace(remote_workspace).await {
                warn!("Failed to set remote workspace state: {}", e);
            }

            apply_active_workspace_context(&state, &app, &workspace_info, None).await;

            info!(
                "Remote workspace opened: name={}, remote_path={}, connection_id={}",
                workspace_info.name,
                workspace_info.root_path.display(),
                request.connection_id
            );
            Ok(WorkspaceInfoDto::from_workspace_info(&workspace_info))
        }
        Err(e) => {
            error!("Failed to open remote workspace: {}", e);
            Err(format!("Failed to open remote workspace: {}", e))
        }
    }
}

#[tauri::command]
pub async fn create_assistant_workspace(
    state: State<'_, AppState>,
    app: tauri::AppHandle,
    _request: CreateAssistantWorkspaceRequest,
) -> Result<WorkspaceInfoDto, String> {
    match state
        .workspace_service
        .create_assistant_workspace(None)
        .await
    {
        Ok(workspace_info) => {
            apply_active_workspace_context(&state, &app, &workspace_info, None).await;

            if let Err(e) = state
                .workspace_identity_watch_service
                .sync_watched_workspaces()
                .await
            {
                warn!(
                    "Failed to sync workspace identity watchers after assistant workspace creation: {}",
                    e
                );
            }

            info!(
                "Assistant workspace created: workspace_id={}, path={}",
                workspace_info.id,
                workspace_info.root_path.display()
            );
            Ok(WorkspaceInfoDto::from_workspace_info(&workspace_info))
        }
        Err(e) => {
            error!("Failed to create assistant workspace: {}", e);
            Err(format!("Failed to create assistant workspace: {}", e))
        }
    }
}

#[tauri::command]
pub async fn get_primary_assistant_workspace(
    state: State<'_, AppState>,
    _request: GetPrimaryAssistantWorkspaceRequest,
) -> Result<Option<WorkspaceInfoDto>, String> {
    Ok(state
        .workspace_service
        .get_primary_assistant_workspace()
        .await
        .map(|workspace| WorkspaceInfoDto::from_workspace_info(&workspace)))
}

#[tauri::command]
pub async fn set_primary_assistant_workspace(
    state: State<'_, AppState>,
    request: SetPrimaryAssistantWorkspaceRequest,
) -> Result<WorkspaceInfoDto, String> {
    let workspace = state
        .workspace_service
        .set_primary_assistant_workspace(&request.workspace_id)
        .await
        .map_err(|error| format!("Failed to set primary assistant workspace: {}", error))?;

    info!(
        "Primary assistant workspace changed: workspace_id={}, assistant_id={:?}",
        workspace.id, workspace.assistant_id
    );

    Ok(WorkspaceInfoDto::from_workspace_info(&workspace))
}

#[tauri::command]
pub async fn delete_assistant_workspace(
    state: State<'_, AppState>,
    app: tauri::AppHandle,
    request: DeleteAssistantWorkspaceRequest,
) -> Result<(), String> {
    let workspace_info = state
        .workspace_service
        .get_workspace(&request.workspace_id)
        .await
        .ok_or_else(|| format!("Assistant workspace not found: {}", request.workspace_id))?;

    if workspace_info.workspace_kind != WorkspaceKind::Assistant {
        return Err(format!(
            "Workspace is not an assistant workspace: {}",
            request.workspace_id
        ));
    }

    if state
        .workspace_service
        .is_primary_assistant_workspace(&request.workspace_id)
        .await
    {
        return Err("Primary assistant workspace cannot be deleted".to_string());
    }

    if !state
        .workspace_service
        .is_assistant_workspace_path(&workspace_info.root_path)
    {
        return Err(format!(
            "Workspace path is not a managed assistant workspace: {}",
            workspace_info.root_path.display()
        ));
    }

    let is_active_workspace = state
        .workspace_service
        .get_current_workspace()
        .await
        .map(|workspace| workspace.id == request.workspace_id)
        .unwrap_or(false);

    if is_active_workspace {
        state
            .workspace_service
            .close_workspace(&request.workspace_id)
            .await
            .map_err(|e| format!("Failed to close assistant workspace before deletion: {}", e))?;
    }

    let workspace_path = workspace_info.root_path.to_string_lossy().to_string();

    state
        .filesystem_service
        .delete_directory(&workspace_path, true)
        .await
        .map_err(|e| format!("Failed to delete assistant workspace files: {}", e))?;

    state
        .workspace_service
        .remove_workspace(&request.workspace_id)
        .await
        .map_err(|e| format!("Failed to remove assistant workspace state: {}", e))?;

    if let Some(current_workspace) = state.workspace_service.get_current_workspace().await {
        apply_active_workspace_context(&state, &app, &current_workspace, None).await;
    } else {
        clear_active_workspace_context(&state, &app, None).await;
    }

    if let Err(e) = state
        .workspace_identity_watch_service
        .sync_watched_workspaces()
        .await
    {
        warn!(
            "Failed to sync workspace identity watchers after assistant workspace deletion: {}",
            e
        );
    }

    info!(
        "Assistant workspace deleted: workspace_id={}, assistant_id={:?}, path={}",
        request.workspace_id,
        workspace_info.assistant_id,
        workspace_info.root_path.display()
    );

    Ok(())
}

async fn clear_directory_contents(directory: &Path) -> Result<(), String> {
    tokio::fs::create_dir_all(directory).await.map_err(|e| {
        format!(
            "Failed to create workspace directory '{}': {}",
            directory.display(),
            e
        )
    })?;

    let mut entries = tokio::fs::read_dir(directory).await.map_err(|e| {
        format!(
            "Failed to read workspace directory '{}': {}",
            directory.display(),
            e
        )
    })?;

    while let Some(entry) = entries.next_entry().await.map_err(|e| {
        format!(
            "Failed to iterate workspace directory '{}': {}",
            directory.display(),
            e
        )
    })? {
        let entry_path = entry.path();
        let file_type = entry.file_type().await.map_err(|e| {
            format!(
                "Failed to inspect workspace entry '{}': {}",
                entry_path.display(),
                e
            )
        })?;

        if file_type.is_dir() {
            tokio::fs::remove_dir_all(&entry_path).await.map_err(|e| {
                format!(
                    "Failed to remove workspace directory '{}': {}",
                    entry_path.display(),
                    e
                )
            })?;
        } else {
            tokio::fs::remove_file(&entry_path).await.map_err(|e| {
                format!(
                    "Failed to remove workspace file '{}': {}",
                    entry_path.display(),
                    e
                )
            })?;
        }
    }

    Ok(())
}

#[tauri::command]
pub async fn reset_assistant_workspace(
    state: State<'_, AppState>,
    app: tauri::AppHandle,
    request: ResetAssistantWorkspaceRequest,
) -> Result<WorkspaceInfoDto, String> {
    let workspace_info = state
        .workspace_service
        .get_workspace(&request.workspace_id)
        .await
        .ok_or_else(|| format!("Assistant workspace not found: {}", request.workspace_id))?;

    if workspace_info.workspace_kind != WorkspaceKind::Assistant {
        return Err(format!(
            "Workspace is not an assistant workspace: {}",
            request.workspace_id
        ));
    }

    if !state
        .workspace_service
        .is_assistant_workspace_path(&workspace_info.root_path)
    {
        return Err(format!(
            "Workspace path is not a managed assistant workspace: {}",
            workspace_info.root_path.display()
        ));
    }

    clear_directory_contents(&workspace_info.root_path).await?;

    openbitfun_core::service::reset_workspace_persona_files_to_default(&workspace_info.root_path)
        .await
        .map_err(|e| format!("Failed to restore assistant workspace persona files: {}", e))?;

    let updated_workspace = state
        .workspace_service
        .rescan_workspace(&request.workspace_id)
        .await
        .map_err(|e| format!("Failed to rescan assistant workspace after reset: {}", e))?;

    if state
        .workspace_service
        .get_current_workspace()
        .await
        .map(|workspace| workspace.id == request.workspace_id)
        .unwrap_or(false)
    {
        apply_active_workspace_context(&state, &app, &updated_workspace, None).await;
    }

    info!(
        "Assistant workspace reset: workspace_id={}, assistant_id={:?}, path={}",
        request.workspace_id,
        workspace_info.assistant_id,
        workspace_info.root_path.display()
    );

    Ok(WorkspaceInfoDto::from_workspace_info(&updated_workspace))
}

#[tauri::command]
pub async fn close_workspace(
    state: State<'_, AppState>,
    app: tauri::AppHandle,
    request: CloseWorkspaceRequest,
) -> Result<(), String> {
    let closing = state
        .workspace_service
        .get_workspace(&request.workspace_id)
        .await;

    match state
        .workspace_service
        .close_workspace(&request.workspace_id)
        .await
    {
        Ok(_) => {
            if let Some(ref ws) = closing {
                if ws.workspace_kind == WorkspaceKind::Remote {
                    if let Some(rw) = remote_workspace_from_info(ws) {
                        state
                            .unregister_remote_workspace_entry(&rw.connection_id, &rw.remote_path)
                            .await;
                    }
                }
            }

            if let Some(workspace_info) = state.workspace_service.get_current_workspace().await {
                apply_active_workspace_context(&state, &app, &workspace_info, None).await;
            } else {
                clear_active_workspace_context(&state, &app, None).await;
            }

            info!("Workspace closed: workspace_id={}", request.workspace_id);
            Ok(())
        }
        Err(e) => {
            error!("Failed to close workspace: {}", e);
            Err(format!("Failed to close workspace: {}", e))
        }
    }
}

#[tauri::command]
pub async fn set_active_workspace(
    state: State<'_, AppState>,
    app: tauri::AppHandle,
    request: SetActiveWorkspaceRequest,
) -> Result<WorkspaceInfoDto, String> {
    match state
        .workspace_service
        .set_active_workspace(&request.workspace_id)
        .await
    {
        Ok(_) => {
            let workspace_info = state
                .workspace_service
                .get_current_workspace()
                .await
                .ok_or_else(|| "Active workspace not found after switching".to_string())?;

            apply_active_workspace_context(&state, &app, &workspace_info, None).await;

            info!(
                "Active workspace changed: workspace_id={}, path={}",
                workspace_info.id,
                workspace_info.root_path.display()
            );

            Ok(WorkspaceInfoDto::from_workspace_info(&workspace_info))
        }
        Err(e) => {
            error!("Failed to set active workspace: {}", e);
            Err(format!("Failed to set active workspace: {}", e))
        }
    }
}

#[tauri::command]
pub async fn reorder_opened_workspaces(
    state: State<'_, AppState>,
    request: ReorderOpenedWorkspacesRequest,
) -> Result<(), String> {
    match state
        .workspace_service
        .reorder_opened_workspaces(request.workspace_ids.clone())
        .await
    {
        Ok(_) => {
            info!(
                "Opened workspaces reordered: count={}",
                request.workspace_ids.len()
            );
            Ok(())
        }
        Err(e) => {
            error!("Failed to reorder opened workspaces: {}", e);
            Err(format!("Failed to reorder opened workspaces: {}", e))
        }
    }
}

#[tauri::command]
pub async fn update_workspace_info(
    state: State<'_, AppState>,
    app: tauri::AppHandle,
    request: UpdateWorkspaceInfoRequest,
) -> Result<WorkspaceInfoDto, String> {
    let updates = openbitfun_core::service::workspace::WorkspaceInfoUpdates {
        name: request.name,
        description: request.description,
        tags: request.tags,
        related_paths: request.related_paths,
    };

    match state
        .workspace_service
        .update_workspace_info(&request.workspace_id, updates)
        .await
    {
        Ok(workspace_info) => {
            let is_active_workspace = state
                .workspace_service
                .get_current_workspace()
                .await
                .map(|workspace| workspace.id == workspace_info.id)
                .unwrap_or(false);

            if is_active_workspace {
                apply_active_workspace_context(&state, &app, &workspace_info, None).await;
            }

            info!(
                "Workspace info updated: workspace_id={}, path={}",
                workspace_info.id,
                workspace_info.root_path.display()
            );

            Ok(WorkspaceInfoDto::from_workspace_info(&workspace_info))
        }
        Err(error) => {
            error!("Failed to update workspace info: {}", error);
            Err(format!("Failed to update workspace info: {}", error))
        }
    }
}

#[tauri::command]
pub async fn get_current_workspace(
    state: State<'_, AppState>,
    startup_trace: State<'_, DesktopStartupTrace>,
) -> Result<Option<WorkspaceInfoDto>, String> {
    let trace_started = Instant::now();
    let workspace_service = &state.workspace_service;
    let result = Ok(workspace_service
        .get_current_workspace()
        .await
        .map(|info| WorkspaceInfoDto::from_workspace_info(&info)));
    startup_trace.record_tauri_command_elapsed("get_current_workspace", None, trace_started);
    result
}

#[tauri::command]
pub async fn get_recent_workspaces(
    state: State<'_, AppState>,
    startup_trace: State<'_, DesktopStartupTrace>,
) -> Result<Vec<WorkspaceInfoDto>, String> {
    let trace_started = Instant::now();
    let workspace_service = &state.workspace_service;
    let result = Ok(workspace_service
        .get_recent_workspaces()
        .await
        .into_iter()
        .map(|info| WorkspaceInfoDto::from_workspace_info(&info))
        .collect());
    startup_trace.record_tauri_command_elapsed("get_recent_workspaces", None, trace_started);
    result
}

async fn collect_workspace_state_snapshot(state: &State<'_, AppState>) -> WorkspaceStateSnapshot {
    let workspace_service = &state.workspace_service;
    let current_workspace = workspace_service
        .get_current_workspace()
        .await
        .map(|info| WorkspaceInfoDto::from_workspace_info(&info));
    let recent_workspaces = workspace_service
        .get_recent_workspaces()
        .await
        .into_iter()
        .map(|info| WorkspaceInfoDto::from_workspace_info(&info))
        .collect();
    let opened_workspaces = workspace_service
        .get_opened_workspaces()
        .await
        .into_iter()
        .map(|info| WorkspaceInfoDto::from_workspace_info(&info))
        .collect();
    let primary_assistant_workspace_id = workspace_service
        .get_primary_assistant_workspace()
        .await
        .map(|workspace| workspace.id);
    let legacy_remote_workspace = state.get_remote_workspace_async().await;

    WorkspaceStateSnapshot {
        current_workspace,
        recent_workspaces,
        opened_workspaces,
        primary_assistant_workspace_id,
        legacy_remote_workspace,
    }
}

#[tauri::command]
pub async fn remove_recent_workspace(
    state: State<'_, AppState>,
    request: RemoveRecentWorkspaceRequest,
) -> Result<(), String> {
    state
        .workspace_service
        .remove_workspace_from_recent(&request.workspace_id)
        .await
        .map_err(|e| format!("Failed to remove workspace from recent: {}", e))
}

#[tauri::command]
pub async fn cleanup_invalid_workspaces(
    state: State<'_, AppState>,
    app: tauri::AppHandle,
    startup_trace: State<'_, DesktopStartupTrace>,
) -> Result<usize, String> {
    let trace_started = Instant::now();
    cleanup_invalid_workspaces_impl(
        &state,
        &app,
        &startup_trace,
        "cleanup_invalid_workspaces",
        Some("cleanup_invalid_workspaces"),
        trace_started,
    )
    .await
}

#[tauri::command]
pub async fn initialize_workspace_startup_state(
    state: State<'_, AppState>,
    app: tauri::AppHandle,
    startup_trace: State<'_, DesktopStartupTrace>,
) -> Result<WorkspaceStartupStateSnapshotDto, String> {
    let command_started = Instant::now();
    let result =
        initialize_workspace_startup_state_impl(&state, &app, &startup_trace, command_started)
            .await;
    startup_trace.record_tauri_command_elapsed(
        "initialize_workspace_startup_state",
        None,
        command_started,
    );
    result
}

pub async fn prepare_workspace_startup_bootstrap_snapshot(
    state: &State<'_, AppState>,
    app: &tauri::AppHandle,
    startup_trace: &State<'_, DesktopStartupTrace>,
) -> Option<WorkspaceStartupStateSnapshotDto> {
    let started = Instant::now();
    let snapshot =
        initialize_workspace_startup_state_impl(state, app, startup_trace, started).await;
    startup_trace.record_elapsed_step(
        "native_setup",
        "prepare_workspace_startup_bootstrap_snapshot",
        started,
    );
    match snapshot {
        Ok(snapshot) => Some(snapshot),
        Err(error) => {
            warn!(
                "Failed to prepare workspace startup bootstrap snapshot, frontend will fall back to startup command: {}",
                error
            );
            None
        }
    }
}

async fn initialize_workspace_startup_state_impl(
    state: &State<'_, AppState>,
    app: &tauri::AppHandle,
    startup_trace: &State<'_, DesktopStartupTrace>,
    command_started: Instant,
) -> Result<WorkspaceStartupStateSnapshotDto, String> {
    let trace = startup_trace.inner();

    initialize_global_state_impl(state, app, trace).await;

    let cleanup_removed_count = match cleanup_invalid_workspaces_impl(
        state,
        app,
        startup_trace,
        "initialize_workspace_startup_state.cleanup_invalid_workspaces",
        None,
        command_started,
    )
    .await
    {
        Ok(removed_count) => removed_count,
        Err(error) => {
            return Err(error);
        }
    };

    let snapshot_started = Instant::now();
    let snapshot = collect_workspace_state_snapshot(state).await;
    startup_trace.record_elapsed_step(
        "tauri_command",
        "initialize_workspace_startup_state.collect_workspace_state_snapshot",
        snapshot_started,
    );

    Ok(WorkspaceStartupStateSnapshotDto {
        cleanup_removed_count,
        current_workspace: snapshot.current_workspace,
        recent_workspaces: snapshot.recent_workspaces,
        opened_workspaces: snapshot.opened_workspaces,
        primary_assistant_workspace_id: snapshot.primary_assistant_workspace_id,
        legacy_remote_workspace: snapshot.legacy_remote_workspace,
    })
}

async fn cleanup_invalid_workspaces_impl(
    state: &State<'_, AppState>,
    app: &tauri::AppHandle,
    startup_trace: &State<'_, DesktopStartupTrace>,
    trace_step_prefix: &str,
    command_name: Option<&str>,
    command_started: Instant,
) -> Result<usize, String> {
    let cleanup_started = Instant::now();
    match state.workspace_service.cleanup_invalid_workspaces().await {
        Ok(local_removed_count) => {
            startup_trace.record_elapsed_step(
                "tauri_command",
                format!("{trace_step_prefix}.local_workspace_cleanup"),
                cleanup_started,
            );
            // Missing SSH profiles are recoverable upgrade/offline states.
            // Preserve workspace IDs and sessions until explicit user removal.
            let removed_count = local_removed_count;

            let apply_context_started = Instant::now();
            if let Some(workspace_info) = state.workspace_service.get_current_workspace().await {
                apply_active_workspace_context(state, app, &workspace_info, None).await;
            } else {
                clear_active_workspace_context(state, app, None).await;
            }
            startup_trace.record_elapsed_step(
                "tauri_command",
                format!("{trace_step_prefix}.apply_active_workspace_context"),
                apply_context_started,
            );

            let sync_watchers_started = Instant::now();
            if let Err(e) = state
                .workspace_identity_watch_service
                .sync_watched_workspaces()
                .await
            {
                warn!(
                    "Failed to sync workspace identity watchers after workspace cleanup: {}",
                    e
                );
            }
            startup_trace.record_elapsed_step(
                "tauri_command",
                format!("{trace_step_prefix}.sync_identity_watchers"),
                sync_watchers_started,
            );

            info!(
                "Invalid workspaces cleaned up: removed_count={}",
                removed_count
            );
            if let Some(command_name) = command_name {
                startup_trace.record_tauri_command_elapsed(command_name, None, command_started);
            }
            Ok(removed_count)
        }
        Err(e) => {
            error!("Failed to cleanup invalid workspaces: {}", e);
            if let Some(command_name) = command_name {
                startup_trace.record_tauri_command_elapsed(command_name, None, command_started);
            }
            Err(format!("Failed to cleanup invalid workspaces: {}", e))
        }
    }
}

#[tauri::command]
pub async fn get_opened_workspaces(
    state: State<'_, AppState>,
    startup_trace: State<'_, DesktopStartupTrace>,
) -> Result<Vec<WorkspaceInfoDto>, String> {
    let trace_started = Instant::now();
    let workspace_service = &state.workspace_service;
    let result = Ok(workspace_service
        .get_opened_workspaces()
        .await
        .into_iter()
        .map(|info| WorkspaceInfoDto::from_workspace_info(&info))
        .collect());
    startup_trace.record_tauri_command_elapsed("get_opened_workspaces", None, trace_started);
    result
}

#[tauri::command]
pub async fn scan_workspace_info(
    state: State<'_, AppState>,
    request: ScanWorkspaceInfoRequest,
) -> Result<Option<WorkspaceInfoDto>, String> {
    let service = &state.workspace_service;
    let record = if let Some(id) = request.workspace_id.as_deref() {
        service.require_workspace(id).await
    } else {
        service
            .resolve_legacy_workspace_reference(None, &request.workspace_path, None, None)
            .await
            .and_then(|record| {
                record.ok_or_else(|| {
                    openbitfun_core::OpenBitFunError::service(
                        "Workspace ID is required for scanning",
                    )
                })
            })
    }
    .map_err(|error| error.to_string())?;
    service
        .rescan_workspace(&record.id)
        .await
        .map(|workspace| Some(WorkspaceInfoDto::from_workspace_info(&workspace)))
        .map_err(|error| error.to_string())
}

async fn ensure_directory_request_path(
    path: &str,
    remote_connection_id: Option<&str>,
) -> Result<(), String> {
    use std::path::Path;

    if let Some(id) = remote_connection_id.filter(|id| !id.trim().is_empty()) {
        openbitfun_core::service::filesystem::path_operations::resolve_explicit_path_connection(
            path,
            id.trim(),
        )
        .await?;
        return Ok(());
    }

    let path_buf = Path::new(path);
    if !path_buf.exists() {
        return Err("Directory does not exist".to_string());
    }
    if !path_buf.is_dir() {
        return Err("Path is not a directory".to_string());
    }

    Ok(())
}

fn file_tree_node_to_json(node: FileTreeNode) -> serde_json::Value {
    let mut json = serde_json::json!({
        "path": node.path,
        "name": node.name,
        "isDirectory": node.is_directory,
        "size": node.size,
        "extension": node.extension,
        "lastModified": node.last_modified
    });

    if let Some(children) = node.children {
        json["children"] =
            serde_json::Value::Array(children.into_iter().map(file_tree_node_to_json).collect());
    }

    json
}

fn directory_nodes_to_json(nodes: Vec<FileTreeNode>) -> Vec<serde_json::Value> {
    nodes
        .into_iter()
        .map(|node| {
            serde_json::json!({
                "path": node.path,
                "name": node.name,
                "isDirectory": node.is_directory,
                "size": node.size,
                "extension": node.extension,
                "lastModified": node.last_modified
            })
        })
        .collect()
}

async fn directory_connection(
    state: &State<'_, AppState>,
    workspace_id: Option<&str>,
    path: &str,
    legacy_connection: Option<&str>,
) -> Result<Option<String>, String> {
    if let Some(id) = workspace_id {
        let record = state
            .workspace_service
            .require_workspace(id)
            .await
            .map_err(|e| e.to_string())?;
        return record
            .filesystem_connection_id()
            .map(|id| id.map(str::to_owned));
    }
    state
        .workspace_service
        .upgrade_legacy_file_connection(path, None, legacy_connection)
        .await
        .map_err(|e| e.to_string())
}

async fn get_file_tree_response(
    state: &State<'_, AppState>,
    request: &GetFileTreeRequest,
) -> Result<serde_json::Value, String> {
    use std::path::Path;

    let connection = directory_connection(
        state,
        request.workspace_id.as_deref(),
        &request.path,
        request.remote_connection_id.as_deref(),
    )
    .await?;
    let preferred = connection.as_deref();
    ensure_directory_request_path(&request.path, preferred).await?;
    let filesystem_service = &state.filesystem_service;
    match filesystem_service
        .build_file_tree_on_connection(&request.path, preferred)
        .await
    {
        Ok(nodes) => {
            let root_name = Path::new(&request.path)
                .file_name()
                .and_then(|n| n.to_str())
                .unwrap_or(&request.path);

            let root_node = serde_json::json!({
                "path": request.path,
                "name": root_name,
                "isDirectory": true,
                "size": null,
                "extension": null,
                "lastModified": null,
                "children": nodes.into_iter().map(file_tree_node_to_json).collect::<Vec<_>>()
            });

            Ok(serde_json::json!([root_node]))
        }
        Err(e) => {
            error!("Failed to build file tree: {}", e);
            Err(format!("Failed to build file tree: {}", e))
        }
    }
}

async fn get_directory_children_response(
    state: &State<'_, AppState>,
    request: &GetDirectoryChildrenRequest,
) -> Result<serde_json::Value, String> {
    let connection = directory_connection(
        state,
        request.workspace_id.as_deref(),
        &request.path,
        request.remote_connection_id.as_deref(),
    )
    .await?;
    let preferred = connection.as_deref();
    ensure_directory_request_path(&request.path, preferred).await?;
    let filesystem_service = &state.filesystem_service;
    match filesystem_service
        .get_directory_contents_on_connection(&request.path, preferred)
        .await
    {
        Ok(nodes) => Ok(serde_json::json!(directory_nodes_to_json(nodes))),
        Err(e) => {
            error!("Failed to get directory children: {}", e);
            Err(format!("Failed to get directory children: {}", e))
        }
    }
}

async fn get_directory_children_paginated_response(
    state: &State<'_, AppState>,
    request: &GetDirectoryChildrenPaginatedRequest,
) -> Result<serde_json::Value, String> {
    let offset = request.offset.unwrap_or(0);
    let limit = request.limit.unwrap_or(100);

    let connection = directory_connection(
        state,
        request.workspace_id.as_deref(),
        &request.path,
        request.remote_connection_id.as_deref(),
    )
    .await?;
    let preferred = connection.as_deref();
    ensure_directory_request_path(&request.path, preferred).await?;
    let filesystem_service = &state.filesystem_service;
    match filesystem_service
        .get_directory_contents_on_connection(&request.path, preferred)
        .await
    {
        Ok(mut nodes) => {
            openbitfun_core::service::filesystem::sort_directory_nodes(
                &mut nodes,
                request.sort_by.as_deref(),
                request.sort_order.as_deref(),
            )?;
            let total = nodes.len();
            debug!(
                "Directory page read: explicit_local={}, remote_scope={}, offset={}, limit={}, total={}",
                preferred == Some(""),
                preferred.is_some_and(|value| !value.is_empty()),
                offset,
                limit,
                total
            );
            let has_more = total > offset.saturating_add(limit);
            let page_nodes: Vec<_> = nodes.into_iter().skip(offset).take(limit).collect();

            Ok(serde_json::json!({
                "children": directory_nodes_to_json(page_nodes),
                "total": total,
                "hasMore": has_more,
                "offset": offset,
                "limit": limit
            }))
        }
        Err(e) => {
            error!("Failed to get paginated directory children: {}", e);
            Err(format!("Failed to get paginated directory children: {}", e))
        }
    }
}

#[tauri::command]
pub async fn get_file_tree(
    state: State<'_, AppState>,
    request: GetFileTreeRequest,
) -> Result<serde_json::Value, String> {
    get_file_tree_response(&state, &request).await
}

#[tauri::command]
pub async fn explorer_get_file_tree(
    state: State<'_, AppState>,
    request: ExplorerGetFileTreeRequest,
) -> Result<serde_json::Value, String> {
    get_file_tree_response(&state, &request).await
}

#[tauri::command]
pub async fn get_directory_children(
    state: State<'_, AppState>,
    request: GetDirectoryChildrenRequest,
) -> Result<serde_json::Value, String> {
    get_directory_children_response(&state, &request).await
}

#[tauri::command]
pub async fn explorer_get_children(
    state: State<'_, AppState>,
    request: ExplorerGetChildrenRequest,
) -> Result<serde_json::Value, String> {
    get_directory_children_response(&state, &request).await
}

#[tauri::command]
pub async fn get_directory_children_paginated(
    state: State<'_, AppState>,
    request: GetDirectoryChildrenPaginatedRequest,
) -> Result<serde_json::Value, String> {
    get_directory_children_paginated_response(&state, &request).await
}

#[tauri::command]
pub async fn explorer_get_children_paginated(
    state: State<'_, AppState>,
    request: ExplorerGetChildrenPaginatedRequest,
) -> Result<serde_json::Value, String> {
    get_directory_children_paginated_response(&state, &request).await
}

#[tauri::command]
pub async fn read_file_content(
    state: State<'_, AppState>,
    request: ReadFileContentRequest,
) -> Result<String, String> {
    read_text_file(
        &state,
        &request.file_path,
        request.encoding.as_deref(),
        request.remote_connection_id.as_deref(),
        request.workspace_id.as_deref(),
    )
    .await
}

fn sanitize_pet_id(id: &str) -> String {
    let sanitized: String = id
        .chars()
        .map(|ch| {
            if ch.is_ascii_alphanumeric() || ch == '-' || ch == '_' {
                ch.to_ascii_lowercase()
            } else {
                '-'
            }
        })
        .collect();
    let trimmed = sanitized.trim_matches('-');
    if trimmed.is_empty() {
        "custom-pet".to_string()
    } else {
        trimmed.to_string()
    }
}

fn spritesheet_mime_type(file_name: &str) -> &'static str {
    match Path::new(file_name)
        .extension()
        .and_then(|ext| ext.to_str())
        .unwrap_or_default()
        .to_ascii_lowercase()
        .as_str()
    {
        "png" => "image/png",
        "jpg" | "jpeg" => "image/jpeg",
        "gif" => "image/gif",
        _ => "image/webp",
    }
}

fn load_pet_manifest_from_bytes(bytes: &[u8]) -> Result<(serde_json::Value, PathBuf), String> {
    let manifest: serde_json::Value =
        serde_json::from_slice(bytes).map_err(|e| format!("Failed to parse pet.json: {}", e))?;
    pet_sprite_version(&manifest)?;
    let spritesheet_path = manifest
        .get("spritesheetPath")
        .and_then(|value| value.as_str())
        .filter(|value| !value.trim().is_empty())
        .ok_or_else(|| "pet.json is missing spritesheetPath".to_string())?
        .to_string();
    Ok((manifest, PathBuf::from(spritesheet_path)))
}

fn pet_sprite_version(manifest: &serde_json::Value) -> Result<u32, String> {
    match manifest.get("spriteVersionNumber") {
        None => Ok(1),
        Some(value) => match value.as_u64() {
            Some(1) => Ok(1),
            Some(2) => Ok(2),
            _ => Err(format!("Unsupported pet spriteVersionNumber: {value}")),
        },
    }
}

#[cfg(test)]
mod pet_package_tests {
    use super::*;

    #[test]
    fn legacy_pet_requests_keep_optional_review_fields() {
        let old: ImportAgentCompanionPetPackageRequest =
            serde_json::from_value(serde_json::json!({"path": "legacy-pet"})).unwrap();
        assert!(old.expected_fingerprint.is_none());
        assert!(old.builtin_id.is_none());
        let request: ListAgentCompanionPetsRequest =
            serde_json::from_value(serde_json::json!({})).unwrap();
        assert!(!request.include_external);
        assert!(request.builtin_import_version.is_none());
    }

    #[test]
    fn bundled_pet_request_requires_review() {
        let temp = tempfile::tempdir().unwrap();
        let request =
            serde_json::from_value(serde_json::json!({"path":"app.asar", "builtinId":"codex"}))
                .unwrap();
        assert!(import_pet_request(temp.path(), request)
            .unwrap_err()
            .contains("reviewed fingerprint"));
    }

    #[test]
    #[ignore = "Imports installed Codex pets into an isolated temporary directory"]
    fn installed_builtin_pets_can_be_previewed_and_imported() {
        let temp = tempfile::tempdir().unwrap();
        let sources =
            openbitfun_core::external_sources::external_builtin_pet_sources("codex", None);
        assert!(sources.diagnostics.is_empty(), "{:?}", sources.diagnostics);
        assert!(!sources.pets.is_empty());
        for source in sources.pets {
            let identity = format!("codex:builtin:{}", source.id);
            let candidate = openbitfun_services_core::pet_packages::candidate_from_bytes(
                temp.path(),
                &identity,
                &source.archive_path,
                &source.manifest,
                source.image,
            )
            .unwrap();
            assert!(candidate
                .preview_data_url
                .starts_with("data:image/png;base64,"));
            let request = serde_json::from_value(serde_json::json!({
                "path": source.archive_path, "builtinId":source.id, "expectedFingerprint":candidate.fingerprint,
            })).unwrap();
            let imported = import_pet_request(temp.path(), request).unwrap();
            assert!(Path::new(&imported.spritesheet_path).is_file());
            assert_eq!(
                imported.sprite_version_number,
                candidate.pet.sprite_version_number
            );
            println!("Validated bundled pet: {}", imported.display_name);
        }
    }
    #[test]
    fn pet_manifest_versions_are_validated_and_exported() {
        for version in [None, Some(1), Some(2)] {
            let dir = tempfile::tempdir().unwrap();
            let mut manifest = serde_json::json!({
                "id": "sample", "displayName": "Sample", "spritesheetPath": "spritesheet.webp"
            });
            if let Some(version) = version {
                manifest["spriteVersionNumber"] = serde_json::json!(version);
            }
            std::fs::write(
                dir.path().join("pet.json"),
                serde_json::to_vec(&manifest).unwrap(),
            )
            .unwrap();
            std::fs::write(dir.path().join("spritesheet.webp"), []).unwrap();
            let dto = pet_package_dto_from_dir(dir.path(), "user").unwrap();
            assert_eq!(dto.sprite_version_number, version.unwrap_or(1));
            assert_eq!(
                serde_json::to_value(dto).unwrap()["spriteVersionNumber"],
                version.unwrap_or(1)
            );
        }
        for version in [
            serde_json::json!(0),
            serde_json::json!(3),
            serde_json::json!("2"),
            serde_json::Value::Null,
        ] {
            let manifest = serde_json::json!({"spritesheetPath": "spritesheet.webp", "spriteVersionNumber": version});
            assert!(load_pet_manifest_from_bytes(&serde_json::to_vec(&manifest).unwrap()).is_err());
        }
    }
}

fn companion_user_packages_dir(state: &AppState) -> PathBuf {
    state
        .workspace_service
        .path_manager()
        .user_data_dir()
        .join("agent-companions")
}

fn pet_package_dto_from_dir(
    dir: &Path,
    source: &str,
) -> Result<AgentCompanionPetPackageDto, String> {
    let pet_json_path = dir.join("pet.json");
    let pet_json = std::fs::read(&pet_json_path)
        .map_err(|e| format!("Failed to read {}: {}", pet_json_path.display(), e))?;
    let (manifest, spritesheet_rel_path) = load_pet_manifest_from_bytes(&pet_json)?;
    let raw_id = manifest
        .get("id")
        .and_then(|value| value.as_str())
        .unwrap_or_else(|| {
            dir.file_name()
                .and_then(|name| name.to_str())
                .unwrap_or("pet")
        });
    let display_name = manifest
        .get("displayName")
        .and_then(|value| value.as_str())
        .filter(|value| !value.trim().is_empty())
        .unwrap_or(raw_id)
        .trim()
        .to_string();
    let description = manifest
        .get("description")
        .and_then(|value| value.as_str())
        .map(|value| value.trim().to_string())
        .filter(|value| !value.is_empty());
    let spritesheet_path = dir.join(&spritesheet_rel_path);
    if !spritesheet_path.is_file() {
        return Err(format!(
            "Spritesheet not found: {}",
            spritesheet_path.display()
        ));
    }
    let spritesheet_file_name = spritesheet_rel_path
        .file_name()
        .and_then(|name| name.to_str())
        .unwrap_or("spritesheet.webp");

    Ok(AgentCompanionPetPackageDto {
        id: sanitize_pet_id(raw_id),
        display_name,
        description,
        source: source.to_string(),
        package_path: dir.to_string_lossy().to_string(),
        spritesheet_path: spritesheet_path.to_string_lossy().to_string(),
        spritesheet_mime_type: spritesheet_mime_type(spritesheet_file_name).to_string(),
        sprite_version_number: pet_sprite_version(&manifest)?,
    })
}

fn scan_pet_package_dirs(root: &Path, source: &str) -> Vec<AgentCompanionPetPackageDto> {
    let Ok(entries) = std::fs::read_dir(root) else {
        return Vec::new();
    };
    let mut pets = Vec::new();
    for entry in entries.flatten() {
        let path = entry.path();
        if entry.file_name().to_string_lossy().starts_with('.')
            || !entry.file_type().is_ok_and(|kind| kind.is_dir())
            || !path.join("pet.json").is_file()
        {
            continue;
        }
        match pet_package_dto_from_dir(&path, source) {
            Ok(dto) => pets.push(dto),
            Err(err) => warn!("Skipping invalid Agent companion pet package: {}", err),
        }
    }
    pets.sort_by(|a, b| {
        a.display_name
            .to_lowercase()
            .cmp(&b.display_name.to_lowercase())
    });
    pets
}

#[tauri::command]
pub async fn list_agent_companion_pets(
    state: State<'_, AppState>,
    request: Option<ListAgentCompanionPetsRequest>,
) -> Result<ListAgentCompanionPetsResponse, String> {
    let include_builtins = request
        .as_ref()
        .is_some_and(|r| r.builtin_import_version == Some(1));
    let mut response = list_agent_companion_pets_impl(&state).await?;
    if request.is_some_and(|r| r.include_external) {
        let source_root = openbitfun_core::external_sources::external_pet_source_root("codex")
            .ok_or("Pet source is unavailable")?;
        let installed_root = companion_user_packages_dir(&state);
        response.external = Some(
            tokio::task::spawn_blocking(move || {
                let mut catalog =
                    openbitfun_services_core::pet_packages::catalog(&source_root, &installed_root);
                if !include_builtins {
                    return catalog;
                }
                let bundled =
                    openbitfun_core::external_sources::external_builtin_pet_sources("codex", None);
                catalog.diagnostics.extend(bundled.diagnostics);
                for source in bundled.pets {
                    let identity = format!("codex:builtin:{}", source.id);
                    match openbitfun_services_core::pet_packages::candidate_from_bytes(
                        &installed_root,
                        &identity,
                        &source.archive_path,
                        &source.manifest,
                        source.image,
                    ) {
                        Ok(mut candidate) => {
                            candidate.builtin_id = Some(source.id);
                            catalog.candidates.push(candidate);
                        }
                        Err(error) => catalog
                            .diagnostics
                            .push(format!("Codex built-in pet {}: {error}", source.id)),
                    }
                }
                catalog
            })
            .await
            .map_err(|e| e.to_string())?,
        );
    }
    Ok(response)
}

pub(crate) async fn list_agent_companion_pets_impl(
    state: &AppState,
) -> Result<ListAgentCompanionPetsResponse, String> {
    let pets = scan_pet_package_dirs(&companion_user_packages_dir(&state), "user");
    Ok(ListAgentCompanionPetsResponse {
        pets,
        import_operations_version: 1,
        builtin_import_version: 1,
        external: None,
    })
}

#[tauri::command]
pub async fn import_agent_companion_pet_package(
    state: State<'_, AppState>,
    request: ImportAgentCompanionPetPackageRequest,
) -> Result<AgentCompanionPetPackageDto, String> {
    let root = companion_user_packages_dir(&state);
    tokio::task::spawn_blocking(move || import_pet_request(&root, request))
        .await
        .map_err(|e| e.to_string())?
}

fn import_pet_request(
    root: &Path,
    request: ImportAgentCompanionPetPackageRequest,
) -> Result<AgentCompanionPetPackageDto, String> {
    if let Some(id) = request.builtin_id {
        let expected = request
            .expected_fingerprint
            .as_deref()
            .ok_or("Built-in pet import requires a reviewed fingerprint")?;
        let mut catalog =
            openbitfun_core::external_sources::external_builtin_pet_sources("codex", Some(&id));
        let source = catalog.pets.pop().ok_or_else(|| {
            if catalog.diagnostics.is_empty() {
                "Built-in pet is unavailable".to_string()
            } else {
                catalog.diagnostics.join("; ")
            }
        })?;
        return openbitfun_services_core::pet_packages::import_bytes(
            &root,
            &format!("codex:builtin:{id}"),
            &source.manifest,
            source.image,
            expected,
        );
    }
    openbitfun_services_core::pet_packages::import(
        &root,
        Path::new(&request.path),
        request.expected_fingerprint.as_deref(),
    )
}

pub(crate) async fn import_agent_companion_pet_package_impl(
    state: &AppState,
    source_path: &str,
) -> Result<AgentCompanionPetPackageDto, String> {
    let root = companion_user_packages_dir(state);
    let source_path = source_path.to_string();
    tokio::task::spawn_blocking(move || {
        openbitfun_services_core::pet_packages::import(&root, Path::new(&source_path), None)
    })
    .await
    .map_err(|e| e.to_string())?
}

#[tauri::command]
pub async fn delete_agent_companion_pet_package(
    state: State<'_, AppState>,
    request: DeleteAgentCompanionPetPackageRequest,
) -> Result<(), String> {
    delete_agent_companion_pet_package_impl(&state, &request.package_path).await
}

pub(crate) async fn delete_agent_companion_pet_package_impl(
    state: &AppState,
    package_path: &str,
) -> Result<(), String> {
    let root = companion_user_packages_dir(&state);
    if !root.exists() {
        return Err("Agent companion packages directory does not exist".to_string());
    }
    let root = root
        .canonicalize()
        .map_err(|e| format!("Failed to resolve Agent companion packages root: {}", e))?;

    let candidate = PathBuf::from(package_path);
    let resolved = candidate
        .canonicalize()
        .map_err(|e| format!("Pet package path not found: {}", e))?;

    if resolved.parent() != Some(root.as_path()) {
        return Err(
            "Refusing to delete path outside imported Agent companion packages".to_string(),
        );
    }
    if !resolved.is_dir() {
        return Err("Pet package is not a directory".to_string());
    }

    std::fs::remove_dir_all(&resolved)
        .map_err(|e| format!("Failed to delete pet package: {}", e))?;

    info!(
        "Deleted Agent companion pet package at {}",
        resolved.display()
    );
    Ok(())
}

#[tauri::command]
pub async fn write_file_content(
    state: State<'_, AppState>,
    request: WriteFileContentRequest,
) -> Result<(), String> {
    let target = resolve_desktop_path_target(
        &state,
        &request.file_path,
        request.remote_connection_id.as_deref(),
        request.workspace_id.as_deref(),
    )
    .await?;
    use openbitfun_core::service::filesystem::path_operations::{
        write_local_text_checked, write_text_checked,
    };
    match target {
        DesktopPathTarget::Local { resolved_path, .. } => {
            write_local_text_checked(
                &state.filesystem_service,
                &resolved_path.to_string_lossy(),
                &request.content,
                request.expected_hash.as_deref(),
            )
            .await
        }
        DesktopPathTarget::Remote {
            requested_path,
            entry,
        } => {
            write_text_checked(
                &state.filesystem_service,
                &requested_path,
                &request.content,
                Some(&entry.connection_id),
                request.expected_hash.as_deref(),
            )
            .await
        }
    }
}

#[tauri::command]
pub async fn reset_workspace_persona_files(
    state: State<'_, AppState>,
    request: ResetWorkspacePersonaFilesRequest,
) -> Result<(), String> {
    let service = &state.workspace_service;
    let workspace_id = request
        .workspace_id
        .as_deref()
        .map(str::trim)
        .filter(|id| !id.is_empty());
    let legacy_path = request
        .workspace_path
        .as_deref()
        .map(str::trim)
        .filter(|path| !path.is_empty());
    let workspace = match (workspace_id, legacy_path) {
        (Some(id), _) => service
            .require_workspace(id)
            .await
            .map_err(|error| error.to_string())?,
        (None, Some(path)) => service
            .resolve_legacy_workspace_reference(None, path, None, None)
            .await
            .map_err(|error| error.to_string())?
            .ok_or_else(|| {
                format!(
                    "Workspace path {} is not an open workspace; select the assistant by its ID",
                    path
                )
            })?,
        (None, None) => {
            return Err("A workspace ID is required to reset persona files".to_string());
        }
    };

    if workspace.workspace_kind != WorkspaceKind::Assistant
        || !service.is_assistant_workspace_path(&workspace.root_path)
    {
        return Err(format!(
            "Workspace {} is not a managed assistant workspace",
            workspace.id
        ));
    }

    openbitfun_core::service::reset_workspace_persona_files_to_default(&workspace.root_path)
        .await
        .map_err(|e| {
            error!(
                "Failed to reset workspace persona files: workspace_id={} error={}",
                workspace.id, e
            );
            format!("Failed to reset workspace persona files: {}", e)
        })?;

    info!(
        "Workspace persona files reset to defaults: workspace_id={}",
        workspace.id
    );

    Ok(())
}

#[tauri::command]
pub async fn check_path_exists(
    state: State<'_, AppState>,
    request: CheckPathExistsRequest,
) -> Result<bool, String> {
    path_exists(
        &state,
        &request.path,
        request.remote_connection_id.as_deref(),
        request.workspace_id.as_deref(),
    )
    .await
}

#[tauri::command]
pub async fn get_file_metadata(
    state: State<'_, AppState>,
    request: GetFileMetadataRequest,
) -> Result<serde_json::Value, String> {
    get_path_metadata(
        &state,
        &request.path,
        request.remote_connection_id.as_deref(),
        request.workspace_id.as_deref(),
    )
    .await
}

/// Returns SHA-256 hex (lowercase) of file bytes after the same normalization as the web editor
/// external-sync check, so the UI can compare with a local hash without transferring file contents.
#[tauri::command]
pub async fn get_file_editor_sync_hash(
    state: State<'_, AppState>,
    request: GetFileMetadataRequest,
) -> Result<serde_json::Value, String> {
    match resolve_desktop_path_target(
        &state,
        &request.path,
        request.remote_connection_id.as_deref(),
        request.workspace_id.as_deref(),
    )
    .await?
    {
        DesktopPathTarget::Remote {
            requested_path,
            entry,
        } => {
            let remote_fs = state
                .get_remote_file_service_async()
                .await
                .map_err(|e| format!("Remote file service not available: {}", e))?;
            let bytes = remote_fs
                .read_file(&entry.connection_id, &requested_path)
                .await
                .map_err(|e| format!("Failed to read remote file: {}", e))?;
            let hash = state
                .filesystem_service
                .editor_sync_sha256_hex_from_raw_bytes(&bytes);
            Ok(serde_json::json!({
                "path": requested_path,
                "hash": hash,
                "is_remote": true
            }))
        }
        DesktopPathTarget::Local { resolved_path, .. } => {
            let hash = state
                .filesystem_service
                .editor_sync_content_sha256_hex(&resolved_path.to_string_lossy())
                .await
                .map_err(|e| e.to_string())?;

            Ok(serde_json::json!({
                "path": request.path,
                "hash": hash
            }))
        }
    }
}

#[tauri::command]
pub async fn rename_file(
    state: State<'_, AppState>,
    request: RenameFileRequest,
) -> Result<(), String> {
    rename_path(
        &state,
        &request.old_path,
        &request.new_path,
        request.remote_connection_id.as_deref(),
        request.workspace_id.as_deref(),
    )
    .await
}

/// Copy a local file or directory to another local path (binary-safe).
///
/// Both endpoints are controller-side: there is no remote copy primitive behind this command, so a
/// remote workspace path is refused rather than served from a same-looking controller path.
#[tauri::command]
pub async fn export_local_file_to_path(request: ExportLocalFileRequest) -> Result<(), String> {
    for (role, path) in [
        ("source", request.source_path.as_str()),
        ("destination", request.destination_path.as_str()),
    ] {
        if openbitfun_core::service::workspace::remote_io_for_legacy_or_id(
            request.workspace_id.as_deref(),
            request.controller_local,
            path.trim(),
        )
        .await
        .map_err(|e| e.to_string())?
        {
            return Err(format!(
                "export_local_file_to_path cannot use remote workspace path '{}' as {}: this command only copies between controller-local paths; local filesystem fallback was not attempted",
                path, role
            ));
        }
    }

    let src = request.source_path;
    let dst = request.destination_path;
    tokio::task::spawn_blocking(move || {
        let dst_path = Path::new(&dst);
        if let Some(parent) = dst_path.parent() {
            if !parent.as_os_str().is_empty() {
                std::fs::create_dir_all(parent).map_err(|e| e.to_string())?;
            }
        }
        let src_path = Path::new(&src);
        let src_metadata = std::fs::metadata(src_path).map_err(|e| {
            format!(
                "Failed to inspect export source '{}': {e}",
                src_path.display()
            )
        })?;
        if src_metadata.is_dir() {
            let canonical_source = std::fs::canonicalize(src_path).map_err(|e| {
                format!(
                    "Failed to resolve export source '{}': {e}",
                    src_path.display()
                )
            })?;
            let destination_parent = dst_path
                .parent()
                .filter(|parent| !parent.as_os_str().is_empty())
                .unwrap_or_else(|| Path::new("."));
            let canonical_parent = std::fs::canonicalize(destination_parent).map_err(|e| {
                format!(
                    "Failed to resolve export destination '{}': {e}",
                    destination_parent.display()
                )
            })?;
            let resolved_destination = if dst_path.exists() {
                std::fs::canonicalize(dst_path).map_err(|e| {
                    format!(
                        "Failed to resolve existing export destination '{}': {e}",
                        dst_path.display()
                    )
                })?
            } else {
                canonical_parent.join(
                    dst_path
                        .file_name()
                        .ok_or_else(|| "Export destination has no directory name".to_string())?,
                )
            };
            if resolved_destination == canonical_source
                || resolved_destination.starts_with(&canonical_source)
            {
                return Err("Cannot export a directory into itself".to_string());
            }
            super::clipboard_file_api::copy_directory_recursive(src_path, dst_path)?;
        } else {
            std::fs::copy(src_path, dst_path)
                .map_err(|e| format!("Failed to copy export file: {e}"))?;
        }
        Ok::<(), String>(())
    })
    .await
    .map_err(|e| e.to_string())?
}

#[tauri::command]
pub async fn delete_file(
    state: State<'_, AppState>,
    request: DeleteFileRequest,
) -> Result<(), String> {
    delete_desktop_file(
        &state,
        &request.path,
        request.remote_connection_id.as_deref(),
        request.workspace_id.as_deref(),
    )
    .await
}

#[tauri::command]
pub async fn delete_directory(
    state: State<'_, AppState>,
    request: DeleteDirectoryRequest,
) -> Result<(), String> {
    let recursive = request.recursive.unwrap_or(false);
    delete_desktop_directory(
        &state,
        &request.path,
        recursive,
        request.remote_connection_id.as_deref(),
        request.workspace_id.as_deref(),
    )
    .await
}

#[tauri::command]
pub async fn create_file(
    state: State<'_, AppState>,
    request: CreateFileRequest,
) -> Result<(), String> {
    create_empty_file(
        &state,
        &request.path,
        request.remote_connection_id.as_deref(),
        request.workspace_id.as_deref(),
    )
    .await
}

#[tauri::command]
pub async fn create_directory(
    state: State<'_, AppState>,
    request: CreateDirectoryRequest,
) -> Result<(), String> {
    create_desktop_directory(
        &state,
        &request.path,
        request.remote_connection_id.as_deref(),
        request.workspace_id.as_deref(),
    )
    .await
}

// === Compress / Decompress ===

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct CompressPathRequest {
    pub path: String,
    #[serde(default)]
    pub remote_connection_id: Option<String>,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct DecompressPathRequest {
    pub path: String,
    #[serde(default)]
    pub remote_connection_id: Option<String>,
}

/// Compress a local file or directory into a `.zip` archive placed in the same
/// parent directory. For remote workspaces, delegates to SSH command execution
/// (tries `zip`, falls back to `tar`).
#[tauri::command]
pub async fn compress_path(
    state: State<'_, AppState>,
    request: CompressPathRequest,
) -> Result<String, String> {
    let src = request.path;
    let remote_cid = request.remote_connection_id;

    // Remote: execute compress command via SSH.
    if let Some(cid) = &remote_cid {
        let manager = state.get_ssh_manager_async().await?;
        let (parent, base_name) = split_remote_archive_path(&src)?;

        // Run from the source's parent directory so an absolute remote path is
        // never serialized as archive member directories. Directory archives
        // contain the selected directory's contents at their root; extraction
        // therefore does not create `<name>/<name>/...`.
        let zip_out = join_remote_path(&parent, &format!("{}.zip", base_name));
        let zip_cmd = build_remote_compress_command(
            &parent,
            &base_name,
            &format!("{}.zip", base_name),
            RemoteArchiveFormat::Zip,
        );

        let (stdout, stderr, code) = manager
            .execute_command(cid, &zip_cmd)
            .await
            .map_err(|e| e.to_string())?;

        if code == 0 {
            return Ok(zip_out);
        }

        // zip not available or failed — try tar.
        let tar_out = join_remote_path(&parent, &format!("{}.tar.gz", base_name));
        let tar_cmd = build_remote_compress_command(
            &parent,
            &base_name,
            &format!("{}.tar.gz", base_name),
            RemoteArchiveFormat::TarGz,
        );

        let (stdout2, stderr2, code2) = manager
            .execute_command(cid, &tar_cmd)
            .await
            .map_err(|e| e.to_string())?;

        if code2 == 0 {
            return Ok(tar_out);
        }

        let zip_err = if stderr.is_empty() { stdout } else { stderr };
        let tar_err = if stderr2.is_empty() { stdout2 } else { stderr2 };
        let zip_not_found = remote_tool_missing(&zip_err, "zip");
        let tar_not_found = remote_tool_missing(&tar_err, "tar");
        if zip_not_found && tar_not_found {
            return Err("Remote server has neither 'zip' nor 'tar' installed. \
                 Please install at least one of them."
                .to_string());
        }
        return Err(format!(
            "Compression failed on the remote server.\nzip: {}\ntar: {}",
            zip_err.trim(),
            tar_err.trim()
        ));
    }

    // Local: use the `zip` crate to create a .zip archive.
    let src_path = PathBuf::from(&src);
    let parent = src_path
        .parent()
        .ok_or_else(|| format!("Cannot determine parent directory of '{}'", src))?;
    let parent = if parent.as_os_str().is_empty() {
        Path::new(".")
    } else {
        parent
    };
    let file_name = src_path
        .file_name()
        .and_then(|n| n.to_str())
        .ok_or_else(|| format!("Cannot determine file name of '{}'", src))?
        .to_string();
    let zip_path = parent.join(format!("{}.zip", file_name));

    let zip_path_clone = zip_path.clone();
    let src_path_clone = src_path.clone();
    let file_name_clone = file_name.clone();
    tokio::task::spawn_blocking(move || {
        create_local_zip_archive(&src_path_clone, &zip_path_clone, &file_name_clone)
    })
    .await
    .map_err(|e| e.to_string())??;

    Ok(zip_path.to_string_lossy().to_string())
}

#[derive(Clone, Copy)]
enum RemoteArchiveFormat {
    Zip,
    TarGz,
}

fn split_remote_archive_path(path: &str) -> Result<(String, String), String> {
    let trimmed = path.trim_end_matches('/');
    if trimmed.is_empty() {
        return Err(format!("Cannot determine file name of '{}'", path));
    }

    let (parent, base_name) = match trimmed.rsplit_once('/') {
        Some(("", name)) => ("/".to_string(), name.to_string()),
        Some((parent, name)) => (parent.to_string(), name.to_string()),
        None => (".".to_string(), trimmed.to_string()),
    };

    if base_name.is_empty() || matches!(base_name.as_str(), "." | "..") {
        return Err(format!("Cannot determine file name of '{}'", path));
    }

    // The parent is `cd`-ed into before the archive command runs, so traversal
    // has to be rejected here too, not only in the file name.
    //
    // Only `..`. A `.` component is not traversal and `./name` has always been
    // accepted — the resolved parent for a bare `name` is literally "." — so
    // rejecting it would break paths that work today for no security gain.
    //
    // Checked against the input rather than the resolved parent, which is
    // synthesized for relative paths.
    if trimmed
        .split('/')
        .rev()
        .skip(1)
        .any(|component| component == "..")
    {
        return Err(format!(
            "Remote path '{}' must not contain '..' components",
            path
        ));
    }

    Ok((parent, base_name))
}

fn join_remote_path(parent: &str, name: &str) -> String {
    match parent {
        "/" => format!("/{}", name),
        "." => name.to_string(),
        _ => format!("{}/{}", parent.trim_end_matches('/'), name),
    }
}

/// Whether a remote command failed because the tool itself is absent.
///
/// Only shell-level phrasing counts. A tool that ran and then complained is not
/// a missing tool: `tar: link: Not found in archive` mentions both "tar" and
/// "not found", and treating that as absence tells the user to install
/// something they already have while hiding the real cause — a corrupt archive.
fn remote_tool_missing(message: &str, tool: &str) -> bool {
    let lower = message.to_lowercase();
    let tool = tool.to_lowercase();
    // POSIX shells: `sh: 1: tar: not found`, `bash: tar: command not found`,
    // `zsh: command not found: tar`, busybox `tar: applet not found`.
    lower.contains("command not found")
        || lower.contains("not installed")
        || lower.contains("applet not found")
        || lower.contains(&format!("{tool}: not found"))
        || lower.contains(&format!("{tool}: no such file or directory"))
}

fn build_remote_compress_command(
    parent: &str,
    base_name: &str,
    archive_name: &str,
    format: RemoteArchiveFormat,
) -> String {
    let parent = shell_quote_posix(parent);
    let source = shell_quote_posix(&format!("./{}", base_name));
    let archive = shell_quote_posix(&format!("./{}", archive_name));
    let archive_from_source = shell_quote_posix(&format!("../{}", archive_name));

    let compress = match format {
        RemoteArchiveFormat::Zip => format!(
            "if [ -d {source} ]; then \
                 (cd -- {source} && zip -r -q {archive_from_source} .); \
             else \
                 zip -q {archive} {source}; \
             fi"
        ),
        RemoteArchiveFormat::TarGz => format!(
            "if [ -d {source} ]; then \
                 (cd -- {source} && tar -czf {archive_from_source} .); \
             else \
                 tar -czf {archive} {source}; \
             fi"
        ),
    };

    format!(
        "cd -- {parent} || exit 1; \
         rm -f {archive}; \
         {compress}; \
         status=$?; \
         if [ \"$status\" -ne 0 ]; then rm -f {archive}; fi; \
         exit \"$status\""
    )
}

fn create_local_zip_archive(
    source_path: &Path,
    zip_path: &Path,
    source_name: &str,
) -> Result<(), String> {
    let result = (|| {
        let file = std::fs::File::create(zip_path)
            .map_err(|e| format!("Failed to create '{}': {}", zip_path.display(), e))?;
        let mut zip_writer = zip::ZipWriter::new(file);
        let options = zip::write::SimpleFileOptions::default()
            .compression_method(zip::CompressionMethod::Deflated);

        if source_path.is_dir() {
            // The destination folder created by extraction already carries the
            // archive stem, so archive only the directory's children.
            add_dir_contents_to_zip(&mut zip_writer, source_path, "", options)?;
        } else {
            add_file_to_zip(&mut zip_writer, source_path, source_name, options)?;
        }

        zip_writer
            .finish()
            .map_err(|e| format!("Failed to finalize zip archive: {}", e))?;
        Ok(())
    })();

    if result.is_err() {
        let _ = std::fs::remove_file(zip_path);
    }
    result
}

/// Recursively add a directory's children to a zip archive.
fn add_dir_contents_to_zip(
    zip: &mut zip::ZipWriter<std::fs::File>,
    dir: &Path,
    archive_prefix: &str,
    options: zip::write::SimpleFileOptions,
) -> Result<(), String> {
    for entry in std::fs::read_dir(dir)
        .map_err(|e| format!("Failed to read directory '{}': {}", dir.display(), e))?
    {
        let entry = entry.map_err(|e| format!("Failed to read directory entry: {}", e))?;
        let path = entry.path();
        let name = entry.file_name().to_string_lossy().to_string();
        let archive_path = if archive_prefix.is_empty() {
            name
        } else {
            format!("{}/{}", archive_prefix, name)
        };

        if path.is_dir() {
            zip.add_directory(format!("{}/", archive_path.replace('\\', "/")), options)
                .map_err(|e| format!("Failed to add directory '{}' to zip: {}", archive_path, e))?;
            add_dir_contents_to_zip(zip, &path, &archive_path, options)?;
        } else if path.is_file() {
            add_file_to_zip(zip, &path, &archive_path, options)?;
        }
    }
    Ok(())
}

/// Add a single file to a zip archive.
fn add_file_to_zip(
    zip: &mut zip::ZipWriter<std::fs::File>,
    source_path: &Path,
    archive_path: &str,
    options: zip::write::SimpleFileOptions,
) -> Result<(), String> {
    let mut file = std::fs::File::open(source_path)
        .map_err(|e| format!("Failed to open '{}': {}", source_path.display(), e))?;
    zip.start_file(archive_path.replace('\\', "/"), options)
        .map_err(|e| format!("Failed to add '{}' to zip: {}", archive_path, e))?;
    let mut buffer = [0u8; 16 * 1024];
    loop {
        let n = file
            .read(&mut buffer)
            .map_err(|e| format!("Failed to read '{}': {}", source_path.display(), e))?;
        if n == 0 {
            break;
        }
        zip.write_all(&buffer[..n])
            .map_err(|e| format!("Failed to write to zip: {}", e))?;
    }
    Ok(())
}

/// Decompress an archive into a new folder named after the archive (without
/// extension) in the same parent directory.
///
/// Supported formats: `.zip`, `.tar.gz`/`.tgz`, `.tar.bz2`/`.tbz2`,
/// `.tar.xz`/`.txz`, `.tar.zst`/`.tzst`, `.tar`.
/// For remote workspaces, delegates to SSH.
#[tauri::command]
pub async fn decompress_path(
    state: State<'_, AppState>,
    request: DecompressPathRequest,
) -> Result<String, String> {
    let src = request.path;
    let remote_cid = request.remote_connection_id;

    // Remote: execute decompress command via SSH.
    if let Some(cid) = &remote_cid {
        let manager = state.get_ssh_manager_async().await?;
        let (remote_parent, remote_file_name) = split_remote_archive_path(&src)?;
        let remote_dest_dir_name = archive_destination_name(&remote_file_name)?;

        let lower = remote_file_name.to_lowercase();
        let (extract_command, required_tool, label, legacy_wrapper_relative) =
            if lower.ends_with(".zip") {
                (
                    format!(
                        "unzip -o -q {} -d \"$stage\"",
                        shell_quote_posix(&format!("./{}", remote_file_name))
                    ),
                    "unzip",
                    "zip",
                    legacy_remote_zip_wrapper_path(&remote_parent, &remote_dest_dir_name),
                )
            } else if lower.ends_with(".tar.gz") || lower.ends_with(".tgz") {
                (
                    format!(
                        "tar -xzf {} -C \"$stage\"",
                        shell_quote_posix(&format!("./{}", remote_file_name))
                    ),
                    "tar",
                    "tar.gz",
                    None,
                )
            } else if lower.ends_with(".tar.bz2") || lower.ends_with(".tbz2") {
                (
                    format!(
                        "tar -xjf {} -C \"$stage\"",
                        shell_quote_posix(&format!("./{}", remote_file_name))
                    ),
                    "tar",
                    "tar.bz2",
                    None,
                )
            } else if lower.ends_with(".tar.xz") || lower.ends_with(".txz") {
                (
                    format!(
                        "tar -xJf {} -C \"$stage\"",
                        shell_quote_posix(&format!("./{}", remote_file_name))
                    ),
                    "tar",
                    "tar.xz",
                    None,
                )
            } else if lower.ends_with(".tar.zst") || lower.ends_with(".tzst") {
                (
                    format!(
                        "tar --zstd -xf {} -C \"$stage\"",
                        shell_quote_posix(&format!("./{}", remote_file_name))
                    ),
                    "tar",
                    "tar.zst",
                    None,
                )
            } else if lower.ends_with(".tar") {
                (
                    format!(
                        "tar -xf {} -C \"$stage\"",
                        shell_quote_posix(&format!("./{}", remote_file_name))
                    ),
                    "tar",
                    "tar",
                    None,
                )
            } else {
                return Err(format!(
                    "Unsupported archive format: '{}'",
                    remote_file_name
                ));
            };

        let cmd = build_remote_extract_command(
            &remote_parent,
            &remote_dest_dir_name,
            &extract_command,
            legacy_wrapper_relative.as_deref(),
        );
        let (stdout, stderr, code) = manager
            .execute_command(cid, &cmd)
            .await
            .map_err(|e| e.to_string())?;
        if code != 0 {
            let err = if stderr.is_empty() { stdout } else { stderr };
            let trimmed = err.trim();
            if remote_tool_missing(trimmed, required_tool) {
                return Err(format!(
                    "Remote server does not have '{}' installed, which is required for {} files.",
                    required_tool, label
                ));
            }
            return Err(format!("Extraction failed: {}", trimmed));
        }

        return Ok(join_remote_path(&remote_parent, &remote_dest_dir_name));
    }

    // Local decompression.
    let src_path = PathBuf::from(&src);
    let parent = src_path
        .parent()
        .ok_or_else(|| format!("Cannot determine parent directory of '{}'", src))?;
    let parent = if parent.as_os_str().is_empty() {
        Path::new(".")
    } else {
        parent
    };
    let file_name = src_path
        .file_name()
        .and_then(|n| n.to_str())
        .ok_or_else(|| format!("Cannot determine file name of '{}'", src))?
        .to_string();
    let dest_dir = parent.join(archive_destination_name(&file_name)?);

    let dest_dir_clone = dest_dir.clone();
    let src_clone = src_path;
    let file_name_clone = file_name.clone();
    tokio::task::spawn_blocking(move || {
        extract_local_archive(&src_clone, &dest_dir_clone, &file_name_clone)
    })
    .await
    .map_err(|e| e.to_string())??;

    Ok(dest_dir.to_string_lossy().to_string())
}

fn build_remote_extract_command(
    parent: &str,
    dest_dir_name: &str,
    extract_command: &str,
    legacy_wrapper_relative: Option<&str>,
) -> String {
    let parent = shell_quote_posix(parent);
    let dest_path = shell_quote_posix(&format!("./{}", dest_dir_name));
    let legacy_wrapper_relative = shell_quote_posix(legacy_wrapper_relative.unwrap_or(""));
    let staging_template =
        shell_quote_posix(&format!("./{}-extract.XXXXXXXX", hidden_data_directory()));

    format!(
        r#"cd -- {parent} || exit 1
dest_path={dest_path}
legacy_wrapper_rel={legacy_wrapper_relative}
if [ -L "$dest_path" ] || {{ [ -e "$dest_path" ] && [ ! -d "$dest_path" ]; }}; then
    echo "Extraction destination is not a directory: $dest_path" >&2
    exit 1
fi
stage=$(mktemp -d {staging_template}) || exit 1
{extract_command}
status=$?
if [ "$status" -ne 0 ]; then
    rm -rf "$stage"
    exit "$status"
fi
source_root=$stage
if [ -n "$legacy_wrapper_rel" ]; then
    cursor=$stage
    relative_chain=
    while :; do
        count=0
        only=
        for child in "$cursor"/.[!.]* "$cursor"/..?* "$cursor"/*; do
            if [ -e "$child" ] || [ -L "$child" ]; then
                count=$((count + 1))
                only=$child
                if [ "$count" -gt 1 ]; then
                    break
                fi
            fi
        done
        if [ "$count" -ne 1 ] || [ ! -d "$only" ] || [ -L "$only" ]; then
            break
        fi
        cursor=$only
        component=${{only##*/}}
        if [ -n "$relative_chain" ]; then
            relative_chain="$relative_chain/$component"
        else
            relative_chain=$component
        fi
        if [ "$relative_chain" = "$legacy_wrapper_rel" ]; then
            source_root=$cursor
            break
        fi
        case "$legacy_wrapper_rel/" in
            "$relative_chain/"*) ;;
            *)
                break
                ;;
        esac
    done
fi
if [ ! -e "$dest_path" ]; then
    mv "$source_root" "$dest_path"
    status=$?
else
    mkdir -p "$dest_path"
    status=$?
    if [ "$status" -eq 0 ]; then
        cp -a "$source_root"/. "$dest_path"/
        status=$?
    fi
fi
rm -rf "$stage"
exit "$status""#
    )
}

fn legacy_remote_zip_wrapper_path(parent: &str, dest_dir_name: &str) -> Option<String> {
    let relative_parent = parent.strip_prefix('/')?.trim_matches('/');
    if relative_parent.is_empty() {
        return None;
    }

    let components = relative_parent
        .split('/')
        .filter(|component| !component.is_empty())
        .collect::<Vec<_>>();
    if components
        .iter()
        .any(|component| matches!(*component, "." | ".."))
    {
        return None;
    }

    Some(format!("{}/{}", components.join("/"), dest_dir_name))
}

struct ExtractionStagingDirectory {
    path: PathBuf,
}

impl ExtractionStagingDirectory {
    fn create(parent: &Path) -> Result<Self, String> {
        let path = parent.join(format!(
            "{}-extract-{}",
            hidden_data_directory(),
            uuid::Uuid::new_v4().simple()
        ));
        std::fs::create_dir(&path)
            .map_err(|e| format!("Failed to create extraction staging directory: {}", e))?;
        Ok(Self { path })
    }
}

impl Drop for ExtractionStagingDirectory {
    fn drop(&mut self) {
        let _ = std::fs::remove_dir_all(&self.path);
    }
}

fn extract_local_archive(
    source_path: &Path,
    dest_dir: &Path,
    file_name: &str,
) -> Result<(), String> {
    let parent = dest_dir
        .parent()
        .filter(|path| !path.as_os_str().is_empty())
        .unwrap_or_else(|| Path::new("."));
    let staging = ExtractionStagingDirectory::create(parent)?;
    let lower = file_name.to_lowercase();

    if lower.ends_with(".zip") {
        extract_zip_to_staging(source_path, &staging.path)?;
    } else if lower.ends_with(".tar.gz") || lower.ends_with(".tgz") {
        let file = std::fs::File::open(source_path)
            .map_err(|e| format!("Failed to open '{}': {}", source_path.display(), e))?;
        unpack_tar_to_staging(
            flate2::read::GzDecoder::new(file),
            &staging.path,
            source_path,
            "tar.gz",
        )?;
    } else if lower.ends_with(".tar.bz2") || lower.ends_with(".tbz2") {
        let file = std::fs::File::open(source_path)
            .map_err(|e| format!("Failed to open '{}': {}", source_path.display(), e))?;
        unpack_tar_to_staging(
            bzip2::read::BzDecoder::new(file),
            &staging.path,
            source_path,
            "tar.bz2",
        )?;
    } else if lower.ends_with(".tar.xz") || lower.ends_with(".txz") {
        let file = std::fs::File::open(source_path)
            .map_err(|e| format!("Failed to open '{}': {}", source_path.display(), e))?;
        unpack_tar_to_staging(
            xz2::read::XzDecoder::new(file),
            &staging.path,
            source_path,
            "tar.xz",
        )?;
    } else if lower.ends_with(".tar.zst") || lower.ends_with(".tzst") {
        let file = std::fs::File::open(source_path)
            .map_err(|e| format!("Failed to open '{}': {}", source_path.display(), e))?;
        let zst = zstd::Decoder::new(file).map_err(|e| {
            format!(
                "Failed to init zstd decoder for '{}': {}",
                source_path.display(),
                e
            )
        })?;
        unpack_tar_to_staging(zst, &staging.path, source_path, "tar.zst")?;
    } else if lower.ends_with(".tar") {
        let file = std::fs::File::open(source_path)
            .map_err(|e| format!("Failed to open '{}': {}", source_path.display(), e))?;
        unpack_tar_to_staging(file, &staging.path, source_path, "tar")?;
    } else {
        return Err(format!("Unsupported archive format: '{}'", file_name));
    }

    archive_destination_name(file_name)?;
    merge_extracted_directory(&staging.path, dest_dir)
}

fn extract_zip_to_staging(source_path: &Path, staging_path: &Path) -> Result<(), String> {
    let file = std::fs::File::open(source_path)
        .map_err(|e| format!("Failed to open '{}': {}", source_path.display(), e))?;
    let mut archive = zip::ZipArchive::new(file)
        .map_err(|e| format!("Failed to read zip '{}': {}", source_path.display(), e))?;

    for i in 0..archive.len() {
        let mut entry = archive
            .by_index(i)
            .map_err(|e| format!("Failed to read zip entry {}: {}", i, e))?;
        let entry_name = entry.name().to_string();
        let Some(enclosed_name) = entry.enclosed_name() else {
            warn!("Skipping unsafe zip entry path: {}", entry_name);
            continue;
        };
        let out_path = staging_path.join(enclosed_name);

        if entry.is_dir() {
            std::fs::create_dir_all(&out_path)
                .map_err(|e| format!("Failed to create dir '{}': {}", out_path.display(), e))?;
        } else {
            if let Some(parent) = out_path.parent() {
                std::fs::create_dir_all(parent)
                    .map_err(|e| format!("Failed to create parent dir: {}", e))?;
            }
            let mut out_file = std::fs::File::create(&out_path)
                .map_err(|e| format!("Failed to create '{}': {}", out_path.display(), e))?;
            std::io::copy(&mut entry, &mut out_file)
                .map_err(|e| format!("Failed to extract '{}': {}", entry_name, e))?;
        }
    }

    Ok(())
}

fn unpack_tar_to_staging<R: Read>(
    reader: R,
    staging_path: &Path,
    source_path: &Path,
    format_label: &str,
) -> Result<(), String> {
    let mut archive = tar::Archive::new(reader);
    archive.set_overwrite(true);
    archive.unpack(staging_path).map_err(|e| {
        format!(
            "Failed to extract {} '{}': {}",
            format_label,
            source_path.display(),
            e
        )
    })
}

fn merge_extracted_directory(source_dir: &Path, dest_dir: &Path) -> Result<(), String> {
    match std::fs::symlink_metadata(dest_dir) {
        Ok(metadata) => {
            if !metadata.file_type().is_dir() || metadata.file_type().is_symlink() {
                return Err(format!(
                    "Extraction destination is not a directory: '{}'",
                    dest_dir.display()
                ));
            }
        }
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => {
            return std::fs::rename(source_dir, dest_dir).map_err(|e| {
                format!(
                    "Failed to move extracted content to '{}': {}",
                    dest_dir.display(),
                    e
                )
            });
        }
        Err(error) => {
            return Err(format!(
                "Failed to inspect extraction destination '{}': {}",
                dest_dir.display(),
                error
            ));
        }
    }

    for entry in std::fs::read_dir(source_dir)
        .map_err(|e| format!("Failed to read extracted content: {}", e))?
    {
        let entry = entry.map_err(|e| format!("Failed to read extracted entry: {}", e))?;
        let source_path = entry.path();
        let target_path = dest_dir.join(entry.file_name());
        let source_type = entry
            .file_type()
            .map_err(|e| format!("Failed to inspect extracted entry: {}", e))?;

        if source_type.is_dir() && !source_type.is_symlink() {
            match std::fs::symlink_metadata(&target_path) {
                Ok(target_metadata)
                    if target_metadata.file_type().is_dir()
                        && !target_metadata.file_type().is_symlink() =>
                {
                    merge_extracted_directory(&source_path, &target_path)?;
                    std::fs::remove_dir(&source_path).map_err(|e| {
                        format!(
                            "Failed to remove extraction staging directory '{}': {}",
                            source_path.display(),
                            e
                        )
                    })?;
                }
                Ok(_) => {
                    remove_existing_extraction_target(&target_path)?;
                    std::fs::rename(&source_path, &target_path).map_err(|e| {
                        format!(
                            "Failed to move extracted directory to '{}': {}",
                            target_path.display(),
                            e
                        )
                    })?;
                }
                Err(error) if error.kind() == std::io::ErrorKind::NotFound => {
                    std::fs::rename(&source_path, &target_path).map_err(|e| {
                        format!(
                            "Failed to move extracted directory to '{}': {}",
                            target_path.display(),
                            e
                        )
                    })?;
                }
                Err(error) => {
                    return Err(format!(
                        "Failed to inspect extraction target '{}': {}",
                        target_path.display(),
                        error
                    ));
                }
            }
        } else {
            if std::fs::symlink_metadata(&target_path).is_ok() {
                remove_existing_extraction_target(&target_path)?;
            }
            std::fs::rename(&source_path, &target_path).map_err(|e| {
                format!(
                    "Failed to move extracted file to '{}': {}",
                    target_path.display(),
                    e
                )
            })?;
        }
    }

    Ok(())
}

fn remove_existing_extraction_target(path: &Path) -> Result<(), String> {
    let metadata = std::fs::symlink_metadata(path).map_err(|e| {
        format!(
            "Failed to inspect existing path '{}': {}",
            path.display(),
            e
        )
    })?;
    if metadata.file_type().is_dir() && !metadata.file_type().is_symlink() {
        std::fs::remove_dir_all(path)
            .map_err(|e| format!("Failed to replace directory '{}': {}", path.display(), e))
    } else {
        std::fs::remove_file(path)
            .map_err(|e| format!("Failed to replace file '{}': {}", path.display(), e))
    }
}

/// Determine the stem of an archive file name by stripping known extensions.
fn archive_stem(file_name: &str) -> String {
    let lower = file_name.to_lowercase();
    // Double extensions (7 chars for .tar.gz / .tar.xz / etc., 6 for .tar.zst).
    if lower.ends_with(".tar.gz") || lower.ends_with(".tar.xz") {
        file_name[..file_name.len() - 7].to_string()
    } else if lower.ends_with(".tar.bz2") || lower.ends_with(".tar.zst") {
        file_name[..file_name.len() - 8].to_string()
    // Short aliases (5 chars for .tbz2 / .txz, 5 for .tzst).
    } else if lower.ends_with(".tgz") || lower.ends_with(".txz") {
        file_name[..file_name.len() - 4].to_string()
    } else if lower.ends_with(".tbz2") || lower.ends_with(".tzst") {
        file_name[..file_name.len() - 5].to_string()
    // Single extensions (4 chars).
    } else if lower.ends_with(".tar") || lower.ends_with(".zip") {
        file_name[..file_name.len() - 4].to_string()
    } else {
        // Unknown extension — strip the last extension if present.
        match file_name.rfind('.') {
            Some(pos) if pos > 0 => file_name[..pos].to_string(),
            _ => file_name.to_string(),
        }
    }
}

fn archive_destination_name(file_name: &str) -> Result<String, String> {
    let stem = archive_stem(file_name);
    if stem.is_empty() || matches!(stem.as_str(), "." | "..") {
        Err(format!(
            "Cannot determine extraction folder name from '{}'",
            file_name
        ))
    } else {
        Ok(stem)
    }
}

#[cfg(test)]
mod archive_tests {
    use super::*;

    fn write_test_zip(path: &Path, entries: &[(&str, &str)]) {
        let file = std::fs::File::create(path).expect("create test zip");
        let mut writer = zip::ZipWriter::new(file);
        let options = zip::write::SimpleFileOptions::default()
            .compression_method(zip::CompressionMethod::Deflated);
        for (name, content) in entries {
            writer.start_file(*name, options).expect("start zip entry");
            writer
                .write_all(content.as_bytes())
                .expect("write zip entry");
        }
        writer.finish().expect("finish test zip");
    }

    #[test]
    fn directory_zip_stores_children_at_archive_root() {
        let temp = tempfile::tempdir().expect("create temp dir");
        let source = temp.path().join("project");
        std::fs::create_dir_all(source.join("src/empty")).expect("create source directories");
        std::fs::write(source.join("README.md"), "readme").expect("write README");
        std::fs::write(source.join("src/main.rs"), "fn main() {}").expect("write source file");
        let archive_path = temp.path().join("project.zip");

        create_local_zip_archive(&source, &archive_path, "project").expect("create local archive");

        let file = std::fs::File::open(&archive_path).expect("open archive");
        let mut archive = zip::ZipArchive::new(file).expect("read archive");
        let mut names = (0..archive.len())
            .map(|index| {
                archive
                    .by_index(index)
                    .expect("read archive entry")
                    .name()
                    .to_string()
            })
            .collect::<Vec<_>>();
        names.sort();

        assert!(names.contains(&"README.md".to_string()));
        assert!(names.contains(&"src/main.rs".to_string()));
        assert!(names.contains(&"src/empty/".to_string()));
        assert!(
            names.iter().all(|name| !name.starts_with("project/")),
            "archive unexpectedly contains a duplicate root: {names:?}"
        );
    }

    #[test]
    fn local_zip_round_trip_does_not_create_duplicate_root() {
        let temp = tempfile::tempdir().expect("create temp dir");
        let source = temp.path().join("project");
        std::fs::create_dir_all(source.join("src")).expect("create source directories");
        std::fs::write(source.join("src/main.rs"), "fn main() {}").expect("write source file");
        let archive_path = temp.path().join("project.zip");

        create_local_zip_archive(&source, &archive_path, "project").expect("create local archive");
        std::fs::remove_dir_all(&source).expect("remove source before extraction");
        extract_local_archive(&archive_path, &source, "project.zip")
            .expect("extract local archive");

        assert_eq!(
            std::fs::read_to_string(source.join("src/main.rs")).expect("read extracted file"),
            "fn main() {}"
        );
        assert!(!source.join("project").exists());
    }

    #[test]
    fn local_zip_round_trip_preserves_a_real_same_name_child_directory() {
        let temp = tempfile::tempdir().expect("create temp dir");
        let source = temp.path().join("project");
        std::fs::create_dir_all(source.join("project/src"))
            .expect("create same-name child directory");
        std::fs::write(source.join("project/src/main.rs"), "nested")
            .expect("write nested source file");
        let archive_path = temp.path().join("project.zip");

        create_local_zip_archive(&source, &archive_path, "project").expect("create local archive");
        std::fs::remove_dir_all(&source).expect("remove source before extraction");
        extract_local_archive(&archive_path, &source, "project.zip")
            .expect("extract local archive");

        assert_eq!(
            std::fs::read_to_string(source.join("project/src/main.rs"))
                .expect("read nested source file"),
            "nested"
        );
        assert!(!source.join("src/main.rs").exists());
    }

    #[test]
    fn local_extraction_preserves_unproven_absolute_style_paths() {
        let temp = tempfile::tempdir().expect("create temp dir");
        let archive_path = temp.path().join("project.zip");
        write_test_zip(
            &archive_path,
            &[("home/developer/work/project/src/main.rs", "legacy")],
        );
        let destination = temp.path().join("project");

        extract_local_archive(&archive_path, &destination, "project.zip")
            .expect("extract legacy archive");

        assert_eq!(
            std::fs::read_to_string(destination.join("home/developer/work/project/src/main.rs"))
                .expect("read preserved file"),
            "legacy"
        );
        assert!(!destination.join("src/main.rs").exists());
    }

    #[test]
    fn zip_extraction_skips_parent_traversal_entries() {
        let temp = tempfile::tempdir().expect("create temp dir");
        let archive_path = temp.path().join("safe.zip");
        write_test_zip(
            &archive_path,
            &[("../escaped.txt", "unsafe"), ("inside.txt", "safe")],
        );
        let destination = temp.path().join("safe");

        extract_local_archive(&archive_path, &destination, "safe.zip")
            .expect("extract safe entries");

        assert!(!temp.path().join("escaped.txt").exists());
        assert_eq!(
            std::fs::read_to_string(destination.join("inside.txt")).expect("read safe entry"),
            "safe"
        );
    }

    #[test]
    fn remote_paths_are_split_with_posix_semantics() {
        assert_eq!(
            split_remote_archive_path("/home/developer/project/").expect("split absolute path"),
            ("/home/developer".to_string(), "project".to_string())
        );
        assert_eq!(
            split_remote_archive_path("project.zip").expect("split relative path"),
            (".".to_string(), "project.zip".to_string())
        );
        assert_eq!(
            join_remote_path("/home/developer", "project.zip"),
            "/home/developer/project.zip"
        );
        assert!(
            split_remote_archive_path("/home/../etc/project.zip").is_err(),
            "traversal in a parent component must be rejected, not just in the file name"
        );
        // `.` is not traversal, and these forms worked before the guard existed.
        assert_eq!(
            split_remote_archive_path("./project.zip").expect("dot-relative path"),
            (".".to_string(), "project.zip".to_string())
        );
        assert_eq!(
            split_remote_archive_path("/home/./project.zip").expect("dot component"),
            ("/home/.".to_string(), "project.zip".to_string())
        );
    }

    #[test]
    fn tool_output_mentioning_not_found_is_not_a_missing_tool() {
        assert!(remote_tool_missing("sh: 1: tar: not found", "tar"));
        assert!(remote_tool_missing("bash: tar: command not found", "tar"));
        assert!(remote_tool_missing("tar: applet not found", "tar"));
        assert!(remote_tool_missing("zsh: command not found: zip", "zip"));
        // tar ran fine; the archive is what is broken.
        assert!(!remote_tool_missing(
            "tar: link: Not found in archive",
            "tar"
        ));
        assert!(!remote_tool_missing(
            "unzip: cannot find zipfile directory in one of project.zip, not found",
            "zip"
        ));
    }

    #[test]
    fn remote_compression_runs_inside_the_selected_directory() {
        let command = build_remote_compress_command(
            "/home/developer/work tree",
            "project",
            "project.zip",
            RemoteArchiveFormat::Zip,
        );

        assert!(command.contains("cd -- '/home/developer/work tree'"));
        assert!(command.contains("cd -- ./project"));
        assert!(command.contains("zip -r -q ../project.zip ."));
        assert!(
            !command.contains("/home/developer/work tree/project"),
            "absolute source path must not become an archive member path"
        );
    }

    #[test]
    fn remote_extraction_uses_staging_and_normalizes_legacy_wrappers() {
        let legacy_wrapper =
            legacy_remote_zip_wrapper_path("/home/developer", "project").expect("legacy wrapper");
        let command = build_remote_extract_command(
            "/home/developer",
            "project",
            "unzip -o -q ./project.zip -d \"$stage\"",
            Some(&legacy_wrapper),
        );

        let staging_template =
            shell_quote_posix(&format!("./{}-extract.XXXXXXXX", hidden_data_directory()));
        assert!(command.contains(&format!("mktemp -d {}", staging_template)));
        assert!(command.contains("legacy_wrapper_rel=home/developer/project"));
        assert!(command.contains(r#"if [ "$relative_chain" = "$legacy_wrapper_rel" ]"#));
        assert!(command.contains(r#"cp -a "$source_root"/. "$dest_path"/"#));
    }

    #[cfg(unix)]
    #[test]
    fn generated_remote_shell_commands_have_valid_syntax() {
        let commands = [
            build_remote_compress_command(
                "/home/developer/work tree",
                "project",
                "project.zip",
                RemoteArchiveFormat::Zip,
            ),
            build_remote_compress_command(
                "/home/developer/work tree",
                "project",
                "project.tar.gz",
                RemoteArchiveFormat::TarGz,
            ),
            build_remote_extract_command(
                "/home/developer/work tree",
                "project",
                "unzip -o -q ./project.zip -d \"$stage\"",
                Some("home/developer/work tree/project"),
            ),
        ];

        for command in commands {
            let status = std::process::Command::new("sh")
                .args(["-n", "-c", &command])
                .status()
                .expect("validate shell syntax");
            assert!(status.success(), "invalid shell command: {command}");
        }
    }

    #[cfg(unix)]
    #[test]
    fn remote_tar_shell_round_trip_preserves_flat_root_contents() {
        let temp = tempfile::tempdir().expect("create temp dir");
        let parent = temp.path().join("remote work tree");
        let source = parent.join("project");
        std::fs::create_dir_all(source.join("src")).expect("create remote-style source");
        std::fs::write(source.join("src/main.rs"), "round-trip")
            .expect("write remote-style source");
        let parent_text = parent.to_string_lossy();

        let compress = build_remote_compress_command(
            &parent_text,
            "project",
            "project.tar.gz",
            RemoteArchiveFormat::TarGz,
        );
        let status = std::process::Command::new("sh")
            .args(["-c", &compress])
            .status()
            .expect("run remote-style tar compression");
        assert!(status.success(), "remote-style compression failed");

        std::fs::remove_dir_all(&source).expect("remove source before extraction");
        let extract = build_remote_extract_command(
            &parent_text,
            "project",
            "tar -xzf ./project.tar.gz -C \"$stage\"",
            None,
        );
        let status = std::process::Command::new("sh")
            .args(["-c", &extract])
            .status()
            .expect("run remote-style tar extraction");
        assert!(status.success(), "remote-style extraction failed");
        assert_eq!(
            std::fs::read_to_string(source.join("src/main.rs")).expect("read round-trip file"),
            "round-trip"
        );
        assert!(!source.join("project").exists());
    }

    #[cfg(unix)]
    #[test]
    fn remote_shell_only_flattens_the_exact_legacy_absolute_zip_wrapper() {
        let temp = tempfile::tempdir().expect("create temp dir");
        let parent = temp.path().join("remote work tree");
        std::fs::create_dir_all(&parent).expect("create remote-style parent");
        let parent_text = parent.to_string_lossy();
        let legacy_wrapper =
            legacy_remote_zip_wrapper_path(&parent_text, "project").expect("derive legacy wrapper");
        let legacy_extract = build_remote_extract_command(
            &parent_text,
            "project",
            "mkdir -p \"$stage/$legacy_wrapper_rel/src\" && \
             printf legacy > \"$stage/$legacy_wrapper_rel/src/legacy.rs\"",
            Some(&legacy_wrapper),
        );
        let status = std::process::Command::new("sh")
            .args(["-c", &legacy_extract])
            .status()
            .expect("simulate legacy remote zip extraction");
        assert!(status.success(), "legacy remote extraction failed");
        assert_eq!(
            std::fs::read_to_string(parent.join("project/src/legacy.rs"))
                .expect("read legacy file"),
            "legacy"
        );

        std::fs::remove_dir_all(parent.join("project")).expect("remove legacy destination");
        let unproven_extract = build_remote_extract_command(
            &parent_text,
            "project",
            "mkdir -p \"$stage/project/src\" && \
             printf nested > \"$stage/project/src/nested.rs\"",
            None,
        );
        let status = std::process::Command::new("sh")
            .args(["-c", &unproven_extract])
            .status()
            .expect("extract unproven same-name directory");
        assert!(status.success(), "unproven extraction failed");
        assert_eq!(
            std::fs::read_to_string(parent.join("project/project/src/nested.rs"))
                .expect("read preserved same-name directory"),
            "nested"
        );
    }

    #[test]
    fn extraction_rejects_archive_names_without_a_folder_stem() {
        assert!(archive_destination_name(".zip").is_err());
        assert_eq!(
            archive_destination_name("project.tar.gz").expect("archive destination"),
            "project"
        );
    }
}

#[derive(Debug, Deserialize)]
pub struct ListDirectoryFilesRequest {
    #[serde(default, rename = "workspaceId", alias = "workspace_id")]
    pub workspace_id: Option<String>,
    pub path: String,
    pub extensions: Option<Vec<String>>,
}

#[tauri::command]
pub async fn list_directory_files(
    state: State<'_, AppState>,
    request: ListDirectoryFilesRequest,
) -> Result<Vec<String>, String> {
    use std::path::Path;

    match resolve_desktop_path_target(&state, &request.path, None, request.workspace_id.as_deref())
        .await?
    {
        DesktopPathTarget::Remote {
            requested_path,
            entry,
        } => {
            let remote_fs = state
                .get_remote_file_service_async()
                .await
                .map_err(|e| format!("Remote file service not available: {}", e))?;
            let entries = remote_fs
                .read_dir(&entry.connection_id, &requested_path)
                .await
                .map_err(|e| format!("Failed to read remote directory: {}", e))?;
            let mut files: Vec<String> = entries
                .into_iter()
                .filter(|e| !e.is_dir)
                .filter(|e| {
                    if let Some(ref extensions) = request.extensions {
                        if let Some(ext) = Path::new(&e.name).extension().and_then(|x| x.to_str()) {
                            extensions.iter().any(|x| x.eq_ignore_ascii_case(ext))
                        } else {
                            false
                        }
                    } else {
                        true
                    }
                })
                .map(|e| e.name)
                .collect();
            files.sort();
            Ok(files)
        }
        DesktopPathTarget::Local { resolved_path, .. } => {
            let dir_path = resolved_path.as_path();
            if !dir_path.exists() {
                return Ok(Vec::new());
            }

            if !dir_path.is_dir() {
                return Err("Path is not a directory".to_string());
            }

            let mut files = Vec::new();
            let entries = std::fs::read_dir(dir_path)
                .map_err(|e| format!("Failed to read directory: {}", e))?;

            for entry in entries {
                let entry = entry.map_err(|e| format!("Failed to read entry: {}", e))?;
                let path = entry.path();

                if path.is_file() {
                    if let Some(file_name) = path.file_name().and_then(|n| n.to_str()) {
                        if let Some(ref extensions) = request.extensions {
                            if let Some(ext) = path.extension().and_then(|e| e.to_str()) {
                                if extensions.iter().any(|e| e.eq_ignore_ascii_case(ext)) {
                                    files.push(file_name.to_string());
                                }
                            }
                        } else {
                            files.push(file_name.to_string());
                        }
                    }
                }
            }

            files.sort();
            Ok(files)
        }
    }
}

#[tauri::command]
pub async fn reveal_in_explorer(
    state: State<'_, AppState>,
    request: RevealInExplorerRequest,
) -> Result<(), String> {
    let target =
        resolve_desktop_path_target(&state, &request.path, None, request.workspace_id.as_deref())
            .await?;
    let path = match target.as_local_path() {
        Some(path) => path,
        None => {
            return Err(format!(
                "Cannot reveal remote path in local file explorer: {}",
                request.path
            ))
        }
    };
    reveal_local_path_in_explorer(path, &request.path)
}

pub(crate) fn reveal_local_path_in_explorer(
    path: &std::path::Path,
    display_path: &str,
) -> Result<(), String> {
    if !path.exists() {
        return Err(format!("Path does not exist: {display_path}"));
    }
    let is_directory = path.is_dir();
    let path_str = path.to_string_lossy().to_string();

    #[cfg(target_os = "windows")]
    {
        if is_directory {
            let normalized_path = path_str.replace("/", "\\");
            openbitfun_core::util::process_manager::create_command("explorer")
                .arg(&normalized_path)
                .spawn()
                .map_err(|e| format!("Failed to open explorer: {}", e))?;
        } else {
            // Explorer does not use standard argv quoting for /select: Command
            // quotes the entire switch + path when a filename contains spaces.
            // Use Shell item IDs instead so the path is never a command line.
            tauri_plugin_opener::reveal_item_in_dir(path)
                .map_err(|e| format!("Failed to reveal file in explorer: {}", e))?;
        }
    }

    #[cfg(target_os = "macos")]
    {
        if is_directory {
            openbitfun_core::util::process_manager::create_command("open")
                .arg(&path_str)
                .spawn()
                .map_err(|e| format!("Failed to open finder: {}", e))?;
        } else {
            openbitfun_core::util::process_manager::create_command("open")
                .args(["-R", &path_str])
                .spawn()
                .map_err(|e| format!("Failed to open finder: {}", e))?;
        }
    }

    #[cfg(target_os = "linux")]
    {
        if is_directory {
            openbitfun_core::util::process_manager::create_command("xdg-open")
                .arg(&path_str)
                .spawn()
                .map_err(|e| format!("Failed to open file manager: {}", e))?;
        } else {
            // On Linux there is no cross-desktop standard to select a specific
            // file in the file manager. Try the freedesktop FileManager1 D-Bus
            // interface (supported by Nautilus, Dolphin, Nemo) to highlight the
            // file; fall back to opening the parent directory with xdg-open.
            // Encode each path segment so spaces and other special characters
            // do not break the dbus-send array:string: syntax (which splits on
            // spaces) and produce a valid file:// URI.
            let encoded_path: String = path
                .to_string_lossy()
                .split('/')
                .map(|s| urlencoding::encode(s).to_string())
                .collect::<Vec<_>>()
                .join("/");
            let file_uri = format!("file://{}", encoded_path);
            let dbus_ok = match openbitfun_core::util::process_manager::create_command("dbus-send")
                .args([
                    "--session",
                    "--print-reply",
                    "--dest=org.freedesktop.FileManager1",
                    "/org/freedesktop/FileManager1",
                    "org.freedesktop.FileManager1.ShowItems",
                    &format!("array:string:{}", file_uri),
                    "string:",
                ])
                .spawn()
            {
                Ok(mut child) => child.wait().map(|s| s.success()).unwrap_or(false),
                Err(_) => false,
            };

            if !dbus_ok {
                let parent = path
                    .parent()
                    .ok_or_else(|| "Failed to get parent directory".to_string())?;
                openbitfun_core::util::process_manager::create_command("xdg-open")
                    .arg(parent)
                    .spawn()
                    .map_err(|e| format!("Failed to open file manager: {}", e))?;
            }
        }
    }

    Ok(())
}

#[tauri::command]
pub async fn search_files(
    state: State<'_, AppState>,
    mut request: SearchFilesRequest,
) -> Result<serde_json::Value, String> {
    use openbitfun_core::service::filesystem::FileSearchOptions;
    let workspace = crate::api::search_api::resolve_search_workspace(
        &state,
        request.workspace_id.as_deref(),
        &request.root_path,
        request.remote_connection_id.as_deref(),
    )
    .await?;
    request.root_path = workspace.root_path.to_string_lossy().into_owned();
    request.remote_connection_id = Some(
        workspace
            .filesystem_connection_id()?
            .unwrap_or("")
            .to_owned(),
    );

    let search_id = request.search_id.clone();
    let cancel_flag = register_search(&state, search_id.as_deref());
    let max_results = resolve_search_limit(
        request.max_results,
        if request.search_content {
            DEFAULT_CONTENT_SEARCH_RESULTS
        } else {
            DEFAULT_FILENAME_SEARCH_RESULTS
        },
    );
    let options = FileSearchOptions {
        include_content: request.search_content,
        case_sensitive: request.case_sensitive,
        use_regex: request.use_regex,
        whole_word: request.whole_word,
        max_results: Some(max_results),
        file_extensions: None,
        include_directories: request.include_directories,
    };

    let use_workspace_search =
        request.search_content && should_use_workspace_search(&state, &workspace).await;
    let result = if request.search_content {
        if workspace.workspace_kind == WorkspaceKind::Remote {
            if !use_workspace_search {
                Err(
                    remote_content_search_refusal(&state, "search_files", &workspace)
                        .await
                        .unwrap_or_else(|| {
                            remote_content_search_refusal_message(
                                "search_files",
                                &request.root_path,
                                "remote workspace search is unavailable",
                            )
                        }),
                )
            } else {
                search_file_contents_via_workspace_search(
                    &state,
                    &workspace,
                    &request.pattern,
                    request.case_sensitive,
                    request.use_regex,
                    request.whole_word,
                    max_results,
                )
                .await
                .map(|result| result.outcome.results)
            }
        } else {
            let filename_outcome = state
                .filesystem_service
                .search_file_names(
                    &request.root_path,
                    &request.pattern,
                    FileSearchOptions {
                        include_content: false,
                        include_directories: request.include_directories,
                        ..options.clone()
                    },
                    cancel_flag.clone(),
                )
                .await?;
            let mut filename_results = filename_outcome.results;

            if filename_results.len() >= max_results {
                Ok(filename_results)
            } else {
                let remaining = max_results - filename_results.len();
                let mut content_outcome = if use_workspace_search {
                    search_file_contents_via_workspace_search(
                        &state,
                        &workspace,
                        &request.pattern,
                        request.case_sensitive,
                        request.use_regex,
                        request.whole_word,
                        remaining,
                    )
                    .await
                    .map(|result| result.outcome)?
                } else {
                    state
                        .filesystem_service
                        .search_file_contents(
                            &request.root_path,
                            &request.pattern,
                            FileSearchOptions {
                                include_content: true,
                                include_directories: false,
                                max_results: Some(remaining),
                                ..options
                            },
                            cancel_flag,
                        )
                        .await?
                };
                if filename_outcome.truncated || content_outcome.truncated {
                    debug!(
                        "Legacy search truncated: root_path={}, pattern={}, search_content={}, limit={}",
                        request.root_path,
                        request.pattern,
                        request.search_content,
                        max_results
                    );
                }
                filename_results.append(&mut content_outcome.results);
                Ok(filename_results)
            }
        }
    } else {
        match crate::api::path_target::resolve_desktop_workspace_target(&state, &workspace.id)
        .await
        {
            Ok(DesktopPathTarget::Remote {
                requested_path,
                entry,
            }) => match state.get_remote_file_service_async().await {
                Ok(remote_fs) => search_remote_file_names(RemoteFileNameSearch {
                    remote_fs,
                    workspace: entry,
                    root_path: requested_path,
                    pattern: request.pattern.clone(),
                    case_sensitive: request.case_sensitive,
                    use_regex: request.use_regex,
                    whole_word: request.whole_word,
                    include_directories: request.include_directories,
                    limit: max_results,
                    cancel_flag,
                    progress_sink: None,
                })
                .await
                .map(|outcome| outcome.results),
                Err(error) => Err(format!(
                    "search_files cannot list remote workspace path '{}': remote file service is unavailable ({}); local filesystem fallback was not attempted",
                    request.root_path, error
                )),
            },
            Ok(DesktopPathTarget::Local { .. }) => state
                .filesystem_service
                .search_file_names(&request.root_path, &request.pattern, options, cancel_flag)
                .await
                .map(|outcome| outcome.results)
                .map_err(|error| format!("Failed to search filenames: {}", error)),
            Err(error) => Err(error),
        }
    };
    unregister_search(&state, search_id.as_deref());

    match result {
        Ok(results) => {
            info!(
                "Legacy search completed: root_path={}, pattern={}, search_content={}, results_count={}",
                request.root_path,
                request.pattern,
                request.search_content,
                results.len()
            );
            Ok(serde_json::json!(serialize_search_results(results)))
        }
        Err(e) => {
            error!(
                "Failed to execute legacy search: root_path={}, pattern={}, search_content={}, error={}",
                request.root_path, request.pattern, request.search_content, e
            );
            Err(format!("Failed to execute legacy search: {}", e))
        }
    }
}

#[tauri::command]
pub async fn search_filenames(
    state: State<'_, AppState>,
    mut request: SearchFilenamesRequest,
) -> Result<serde_json::Value, String> {
    use openbitfun_core::service::filesystem::FileSearchOptions;
    let workspace = crate::api::search_api::resolve_search_workspace(
        &state,
        request.workspace_id.as_deref(),
        &request.root_path,
        request.remote_connection_id.as_deref(),
    )
    .await?;
    request.root_path = workspace.root_path.to_string_lossy().into_owned();
    request.remote_connection_id = Some(
        workspace
            .filesystem_connection_id()?
            .unwrap_or("")
            .to_owned(),
    );

    let search_id = request.search_id.clone();
    let cancel_flag = register_search(&state, search_id.as_deref());
    let limit = resolve_search_limit(request.max_results, DEFAULT_FILENAME_SEARCH_RESULTS);
    let options = FileSearchOptions {
        include_content: false,
        case_sensitive: request.case_sensitive,
        use_regex: request.use_regex,
        whole_word: request.whole_word,
        max_results: Some(limit),
        file_extensions: None,
        include_directories: request.include_directories,
    };

    let result = match crate::api::path_target::resolve_desktop_workspace_target(
        &state,
        &workspace.id,
    )
    .await
    {
        Ok(DesktopPathTarget::Remote {
            requested_path,
            entry,
        }) => match state.get_remote_file_service_async().await {
            Ok(remote_fs) => search_remote_file_names(RemoteFileNameSearch {
                remote_fs,
                workspace: entry,
                root_path: requested_path,
                pattern: request.pattern.clone(),
                case_sensitive: request.case_sensitive,
                use_regex: request.use_regex,
                whole_word: request.whole_word,
                include_directories: request.include_directories,
                limit,
                cancel_flag,
                progress_sink: None,
            })
            .await
            .map_err(openbitfun_core::util::errors::OpenBitFunError::service),
            Err(error) => Err(openbitfun_core::util::errors::OpenBitFunError::service(
                format!("Remote file service not available: {}", error),
            )),
        },
        Ok(DesktopPathTarget::Local { .. }) => {
            state
                .filesystem_service
                .search_file_names(&request.root_path, &request.pattern, options, cancel_flag)
                .await
        }
        Err(error) => Err(openbitfun_core::util::errors::OpenBitFunError::service(
            error,
        )),
    };
    unregister_search(&state, search_id.as_deref());

    match result {
        Ok(outcome) => {
            info!(
                "Filename search completed: root_path={}, pattern={}, results_count={}, limit={}, truncated={}",
                request.root_path,
                request.pattern,
                outcome.results.len(),
                limit,
                outcome.truncated
            );
            Ok(serialize_search_response(outcome, limit, None))
        }
        Err(error) => {
            error!(
                "Failed to search filenames: root_path={}, pattern={}, error={}",
                request.root_path, request.pattern, error
            );
            Err(format!("Failed to search filenames: {}", error))
        }
    }
}

#[tauri::command]
pub async fn search_file_contents(
    state: State<'_, AppState>,
    mut request: SearchFileContentsRequest,
) -> Result<serde_json::Value, String> {
    use openbitfun_core::service::filesystem::FileSearchOptions;
    let workspace = crate::api::search_api::resolve_search_workspace(
        &state,
        request.workspace_id.as_deref(),
        &request.root_path,
        None,
    )
    .await?;
    request.root_path = workspace.root_path.to_string_lossy().into_owned();

    if let Some(message) =
        remote_content_search_refusal(&state, "search_file_contents", &workspace).await
    {
        error!("Content search refused: {}", message);
        return Err(message);
    }

    let search_id = request.search_id.clone();
    let cancel_flag = register_search(&state, search_id.as_deref());
    let limit = resolve_search_limit(request.max_results, DEFAULT_CONTENT_SEARCH_RESULTS);
    let options = FileSearchOptions {
        include_content: true,
        case_sensitive: request.case_sensitive,
        use_regex: request.use_regex,
        whole_word: request.whole_word,
        max_results: Some(limit),
        file_extensions: None,
        include_directories: false,
    };

    let result = if should_use_workspace_search(&state, &workspace).await {
        search_file_contents_via_workspace_search(
            &state,
            &workspace,
            &request.pattern,
            request.case_sensitive,
            request.use_regex,
            request.whole_word,
            limit,
        )
        .await
        .map(|result| {
            let search_metadata = search_metadata_from_content_result(&result);
            (result.outcome, Some(search_metadata))
        })
    } else {
        state
            .filesystem_service
            .search_file_contents(&request.root_path, &request.pattern, options, cancel_flag)
            .await
            .map(|outcome| (outcome, None))
            .map_err(|error| format!("Failed to search file contents: {}", error))
    };
    unregister_search(&state, search_id.as_deref());

    match result {
        Ok((outcome, search_metadata)) => {
            info!(
                "Content search completed: root_path={}, pattern={}, results_count={}, limit={}, truncated={}",
                request.root_path,
                request.pattern,
                outcome.results.len(),
                limit,
                outcome.truncated
            );
            Ok(serialize_search_response(outcome, limit, search_metadata))
        }
        Err(error) => {
            error!(
                "Failed to search file contents: root_path={}, pattern={}, error={}",
                request.root_path, request.pattern, error
            );
            Err(format!("Failed to search file contents: {}", error))
        }
    }
}

#[tauri::command]
pub async fn start_search_filenames_stream(
    app_handle: AppHandle,
    state: State<'_, AppState>,
    mut request: SearchFilenamesRequest,
) -> Result<serde_json::Value, String> {
    use openbitfun_core::service::filesystem::FileSearchOptions;
    let workspace = crate::api::search_api::resolve_search_workspace(
        &state,
        request.workspace_id.as_deref(),
        &request.root_path,
        request.remote_connection_id.as_deref(),
    )
    .await?;
    request.root_path = workspace.root_path.to_string_lossy().into_owned();
    request.remote_connection_id = Some(
        workspace
            .filesystem_connection_id()?
            .unwrap_or("")
            .to_owned(),
    );

    let search_id = ensure_search_id(request.search_id.clone(), "filenames-stream");
    let cancel_flag = register_search(&state, Some(&search_id));
    let limit = resolve_search_limit(request.max_results, DEFAULT_FILENAME_SEARCH_RESULTS);
    let options = FileSearchOptions {
        include_content: false,
        case_sensitive: request.case_sensitive,
        use_regex: request.use_regex,
        whole_word: request.whole_word,
        max_results: Some(limit),
        file_extensions: None,
        include_directories: request.include_directories,
    };

    let remote_search_target = match crate::api::path_target::resolve_desktop_workspace_target(
        &state,
        &workspace.id,
    )
    .await
    {
        Ok(DesktopPathTarget::Remote {
            requested_path,
            entry,
        }) => {
            let remote_fs = match state.get_remote_file_service_async().await {
                Ok(remote_fs) => remote_fs,
                Err(error) => {
                    unregister_search(&state, Some(&search_id));
                    return Err(format!("Remote file service not available: {}", error));
                }
            };
            Some((remote_fs, entry, requested_path))
        }
        Ok(DesktopPathTarget::Local { .. }) => None,
        Err(error) => {
            unregister_search(&state, Some(&search_id));
            return Err(error);
        }
    };

    let filesystem_service = state.filesystem_service.clone();
    let active_searches = state.active_searches.clone();
    let root_path = request.root_path.clone();
    let pattern = request.pattern.clone();
    let case_sensitive = request.case_sensitive;
    let use_regex = request.use_regex;
    let whole_word = request.whole_word;
    let include_directories = request.include_directories;
    let response_search_id = search_id.clone();
    let progress_search_id = search_id.clone();
    let progress_app_handle = app_handle.clone();
    let progress_sink = Arc::new(BatchedFileSearchProgressSink::new(
        FILE_SEARCH_BATCH_SIZE,
        Duration::from_millis(FILE_SEARCH_FLUSH_INTERVAL_MS),
        move |results| {
            emit_search_progress(
                &progress_app_handle,
                &progress_search_id,
                SearchStreamKind::Filenames,
                results,
            );
        },
    ));

    tokio::spawn(async move {
        let result = if let Some((remote_fs, entry, requested_path)) = remote_search_target {
            search_remote_file_names(RemoteFileNameSearch {
                remote_fs,
                workspace: entry,
                root_path: requested_path,
                pattern: pattern.clone(),
                case_sensitive,
                use_regex,
                whole_word,
                include_directories,
                limit,
                cancel_flag: cancel_flag.clone(),
                progress_sink: Some(progress_sink),
            })
            .await
            .map_err(openbitfun_core::util::errors::OpenBitFunError::service)
        } else {
            filesystem_service
                .search_file_names_with_progress(
                    &root_path,
                    &pattern,
                    options,
                    cancel_flag,
                    Some(progress_sink),
                )
                .await
        };

        unregister_search_registry(&active_searches, Some(&search_id));

        match result {
            Ok(outcome) => {
                info!(
                    "Filename search stream completed: root_path={}, pattern={}, results_count={}, limit={}, truncated={}",
                    root_path,
                    pattern,
                    outcome.results.len(),
                    limit,
                    outcome.truncated
                );
                emit_search_complete(
                    &app_handle,
                    &search_id,
                    SearchStreamKind::Filenames,
                    limit,
                    outcome.truncated,
                    count_search_result_groups(&outcome.results),
                    None,
                );
            }
            Err(error) => {
                let message = format!("Failed to search filenames: {}", error);
                error!(
                    "Filename search stream failed: root_path={}, pattern={}, error={}",
                    root_path, pattern, error
                );
                emit_search_error(
                    &app_handle,
                    &search_id,
                    SearchStreamKind::Filenames,
                    &message,
                );
            }
        }
    });

    Ok(serde_json::to_value(SearchStreamStartResponse {
        search_id: response_search_id,
        limit,
    })
    .unwrap_or_else(|_| serde_json::json!({ "searchId": "", "limit": limit })))
}

#[tauri::command]
pub async fn start_search_file_contents_stream(
    app_handle: AppHandle,
    state: State<'_, AppState>,
    mut request: SearchFileContentsRequest,
) -> Result<serde_json::Value, String> {
    use openbitfun_core::service::filesystem::FileSearchOptions;
    let workspace = crate::api::search_api::resolve_search_workspace(
        &state,
        request.workspace_id.as_deref(),
        &request.root_path,
        None,
    )
    .await?;
    request.root_path = workspace.root_path.to_string_lossy().into_owned();

    if let Some(message) =
        remote_content_search_refusal(&state, "start_search_file_contents_stream", &workspace).await
    {
        error!("Content search stream refused: {}", message);
        return Err(message);
    }

    let search_id = ensure_search_id(request.search_id.clone(), "content-stream");
    let cancel_flag = register_search(&state, Some(&search_id));
    let limit = resolve_search_limit(request.max_results, DEFAULT_CONTENT_SEARCH_RESULTS);
    let options = FileSearchOptions {
        include_content: true,
        case_sensitive: request.case_sensitive,
        use_regex: request.use_regex,
        whole_word: request.whole_word,
        max_results: Some(limit),
        file_extensions: None,
        include_directories: false,
    };

    let filesystem_service = state.filesystem_service.clone();
    let active_searches = state.active_searches.clone();
    let root_path = request.root_path.clone();
    let pattern = request.pattern.clone();
    let case_sensitive = request.case_sensitive;
    let use_regex = request.use_regex;
    let whole_word = request.whole_word;
    let use_workspace_search = should_use_workspace_search(&state, &workspace).await;
    let workspace_search_runner = if use_workspace_search {
        Some(
            prepare_content_search_runner(&state, &workspace)
                .await
                .map_err(|error| format!("Failed to prepare workspace search: {}", error))?,
        )
    } else {
        None
    };
    let response_search_id = search_id.clone();
    let progress_search_id = search_id.clone();
    let progress_app_handle = app_handle.clone();
    let progress_sink = Arc::new(BatchedFileSearchProgressSink::new(
        FILE_SEARCH_BATCH_SIZE,
        Duration::from_millis(FILE_SEARCH_FLUSH_INTERVAL_MS),
        move |results| {
            emit_search_progress(
                &progress_app_handle,
                &progress_search_id,
                SearchStreamKind::Content,
                results,
            );
        },
    ));

    tokio::spawn(async move {
        let result = if use_workspace_search {
            let result = workspace_search_runner
                .as_ref()
                .expect("workspace search runner should exist when enabled")
                .search_content(build_content_search_request(
                    &root_path,
                    &pattern,
                    case_sensitive,
                    use_regex,
                    whole_word,
                    limit,
                ))
                .await
                .map(|result| {
                    let search_metadata = search_metadata_from_content_result(&result);
                    (result.outcome, Some(search_metadata))
                });

            if let Ok((outcome, _)) = &result {
                if !cancel_flag
                    .as_ref()
                    .is_some_and(|flag| flag.load(Ordering::Relaxed))
                {
                    for group in group_search_results(outcome.results.clone()) {
                        openbitfun_core::infrastructure::FileSearchProgressSink::report(
                            progress_sink.as_ref(),
                            group,
                        );
                    }
                    openbitfun_core::infrastructure::FileSearchProgressSink::flush(
                        progress_sink.as_ref(),
                    );
                }
            }
            result.map_err(|error| {
                openbitfun_core::util::errors::OpenBitFunError::service(format!(
                    "Failed to search file contents via workspace search: {}",
                    error
                ))
            })
        } else {
            filesystem_service
                .search_file_contents_with_progress(
                    &root_path,
                    &pattern,
                    options,
                    cancel_flag.clone(),
                    Some(progress_sink),
                )
                .await
                .map(|outcome| (outcome, None))
        };

        unregister_search_registry(&active_searches, Some(&search_id));

        if cancel_flag
            .as_ref()
            .is_some_and(|flag| flag.load(Ordering::Relaxed))
        {
            return;
        }

        match result {
            Ok((outcome, search_metadata)) => {
                info!(
                    "Content search stream completed: root_path={}, pattern={}, results_count={}, limit={}, truncated={}",
                    root_path,
                    pattern,
                    outcome.results.len(),
                    limit,
                    outcome.truncated
                );
                emit_search_complete(
                    &app_handle,
                    &search_id,
                    SearchStreamKind::Content,
                    limit,
                    outcome.truncated,
                    count_search_result_groups(&outcome.results),
                    search_metadata,
                );
            }
            Err(error) => {
                let message = format!("Failed to search file contents: {}", error);
                error!(
                    "Content search stream failed: root_path={}, pattern={}, error={}",
                    root_path, pattern, error
                );
                emit_search_error(&app_handle, &search_id, SearchStreamKind::Content, &message);
            }
        }
    });

    Ok(serde_json::to_value(SearchStreamStartResponse {
        search_id: response_search_id,
        limit,
    })
    .unwrap_or_else(|_| serde_json::json!({ "searchId": "", "limit": limit })))
}

#[tauri::command]
pub async fn cancel_search(
    state: State<'_, AppState>,
    request: CancelSearchRequest,
) -> Result<(), String> {
    let mut active_searches = lock_active_searches(&state);
    if let Some(cancel_flag) = active_searches.remove(&request.search_id) {
        cancel_flag.store(true, Ordering::Relaxed);
    }

    Ok(())
}

#[tauri::command]
pub async fn get_global_config_status() -> Result<bool, String> {
    Ok(openbitfun_core::service::config::GlobalConfigManager::is_initialized())
}

#[tauri::command]
pub async fn get_model_configs(
    state: State<'_, AppState>,
) -> Result<Vec<serde_json::Value>, String> {
    let config_service = &state.config_service;

    match config_service.get_ai_models().await {
        Ok(models) => {
            let model_configs: Vec<serde_json::Value> = models
                .into_iter()
                .map(|model| serde_json::to_value(model).unwrap_or_default())
                .collect();

            Ok(model_configs)
        }
        Err(e) => {
            error!("Failed to get AI model configs: {}", e);
            Err(format!("Failed to get model configurations: {}", e))
        }
    }
}

#[tauri::command]
pub async fn get_ai_model_catalog() -> Result<openbitfun_core::AIModelCatalog, String> {
    openbitfun_core::get_ai_model_catalog().await
}

#[tauri::command]
pub async fn project_ai_model_reasoning_catalog(
    request: openbitfun_core_types::ReasoningCatalogProjectionRequest,
) -> openbitfun_core_types::ReasoningCatalogProjection {
    openbitfun_core::project_ai_model_reasoning_catalog(request).await
}

#[tauri::command]
pub async fn get_models_dev_catalog_status() -> openbitfun_core_types::ModelsDevCatalogStatus {
    openbitfun_core::get_models_dev_catalog_status().await
}

#[tauri::command]
pub async fn refresh_models_dev_catalog_now(
) -> Result<openbitfun_core_types::ModelsDevRefreshResult, String> {
    openbitfun_core::refresh_models_dev_catalog_now().await
}

#[tauri::command]
pub async fn reveal_models_dev_cache_directory() -> Result<(), String> {
    let status = openbitfun_core::get_models_dev_catalog_status().await;
    let cache_path = std::path::PathBuf::from(&status.cache_path);
    let directory = cache_path
        .parent()
        .ok_or_else(|| "Models.dev cache directory is unavailable".to_string())?;
    std::fs::create_dir_all(directory)
        .map_err(|error| format!("Failed to create models.dev cache directory: {error}"))?;
    reveal_local_path_in_explorer(directory, &directory.to_string_lossy())
}

#[derive(Debug, Deserialize)]
pub struct IdeControlResultRequest {
    pub request_id: String,
    pub success: bool,
    pub message: Option<String>,
    pub error: Option<String>,
    pub timestamp: i64,
}

#[tauri::command]
pub async fn report_ide_control_result(request: IdeControlResultRequest) -> Result<(), String> {
    if !request.success {
        if let Some(error) = &request.error {
            error!(
                "IDE Control operation failed: request_id={}, error={}",
                request.request_id, error
            );
        }
    }

    Ok(())
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct WorkspaceFileWatchRequest {
    pub workspace_id: String,
    pub path: String,
    pub recursive: Option<bool>,
}

fn ensure_workspace_watch_supported(kind: WorkspaceKind) -> Result<(), String> {
    if kind == WorkspaceKind::Remote {
        return Err("Filesystem watching is not available for remote workspaces".into());
    }
    Ok(())
}

async fn file_watch_target(
    state: &State<'_, AppState>,
    request: Option<WorkspaceFileWatchRequest>,
    legacy_path: Option<String>,
) -> Result<(String, Option<bool>), String> {
    if let Some(request) = request {
        let record = state
            .workspace_service
            .require_workspace(&request.workspace_id)
            .await
            .map_err(|e| e.to_string())?;
        ensure_workspace_watch_supported(record.workspace_kind)?;
        return Ok((request.path, request.recursive));
    }
    // Temporary 1.0.0 wire ingress; current callers must send the structured ID request.
    let path = legacy_path.ok_or("Workspace ID is required for filesystem watching")?;
    if state
        .workspace_service
        .upgrade_legacy_file_connection(&path, None, None)
        .await
        .map_err(|e| e.to_string())?
        .is_some()
    {
        return Err("Filesystem watching is not available for remote workspaces".into());
    }
    Ok((path, None))
}

#[tauri::command]
pub async fn start_file_watch(
    state: State<'_, AppState>,
    request: Option<WorkspaceFileWatchRequest>,
    path: Option<String>,
    recursive: Option<bool>,
) -> Result<(), String> {
    let (path, scoped_recursive) = file_watch_target(&state, request, path).await?;
    file_watch::start_file_watch(path, scoped_recursive.or(recursive)).await
}

#[tauri::command]
pub async fn stop_file_watch(
    state: State<'_, AppState>,
    request: Option<WorkspaceFileWatchRequest>,
    path: Option<String>,
) -> Result<(), String> {
    let (path, _) = file_watch_target(&state, request, path).await?;
    file_watch::stop_file_watch(path).await
}

#[tauri::command]
pub async fn get_watched_paths() -> Result<Vec<String>, String> {
    file_watch::get_watched_paths().await
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SubscriptionProviderRequest {
    pub provider: openbitfun_core::infrastructure::subscription_auth::SubscriptionProvider,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SubscriptionLoginRequest {
    pub provider: openbitfun_core::infrastructure::subscription_auth::SubscriptionProvider,
    pub session_id: String,
    #[serde(default)]
    pub method: Option<openbitfun_core::infrastructure::subscription_auth::SubscriptionLoginMethod>,
}

async fn configured_ai_proxy(
    state: &State<'_, AppState>,
) -> Result<Option<openbitfun_core::service::config::types::ProxyConfig>, String> {
    let global_config: openbitfun_core::service::config::GlobalConfig = state
        .config_service
        .get_config(None)
        .await
        .map_err(|e| format!("Failed to get configuration: {}", e))?;

    Ok(global_config
        .ai
        .proxy
        .enabled
        .then_some(global_config.ai.proxy))
}

#[tauri::command]
pub async fn list_subscription_accounts(
) -> Result<Vec<openbitfun_core::infrastructure::subscription_auth::SubscriptionAccount>, String> {
    Ok(openbitfun_core::infrastructure::subscription_auth::list_accounts().await)
}

#[tauri::command]
pub async fn start_subscription_login(
    state: State<'_, AppState>,
    request: SubscriptionLoginRequest,
) -> Result<openbitfun_core::infrastructure::subscription_auth::LoginStartResult, String> {
    let proxy_config = configured_ai_proxy(&state).await?;
    let options = openbitfun_core::infrastructure::subscription_auth::SubscriptionHttpOptions::new(
        proxy_config,
        false,
    );
    openbitfun_core::infrastructure::subscription_auth::start_login_with_method_and_options(
        request.provider,
        request.session_id,
        request.method,
        options,
    )
    .await
    .map_err(|e| format!("Failed to start subscription login: {e:#}"))
}

#[tauri::command]
pub async fn get_subscription_login_status(
    request: SubscriptionLoginRequest,
) -> Result<openbitfun_core::infrastructure::subscription_auth::LoginSessionSnapshot, String> {
    openbitfun_core::infrastructure::subscription_auth::login_status(
        request.provider,
        &request.session_id,
    )
    .await
    .map_err(|e| format!("Failed to get subscription login status: {e:#}"))
}

#[tauri::command]
pub async fn cancel_subscription_login(request: SubscriptionLoginRequest) -> Result<(), String> {
    openbitfun_core::infrastructure::subscription_auth::cancel_login(
        request.provider,
        &request.session_id,
    )
    .await
    .map_err(|e| format!("Failed to cancel subscription login: {e:#}"))
}

#[tauri::command]
pub async fn logout_subscription_account(
    request: SubscriptionProviderRequest,
) -> Result<openbitfun_core::infrastructure::subscription_auth::SubscriptionLogoutResult, String> {
    openbitfun_core::infrastructure::subscription_auth::logout(request.provider)
        .await
        .map_err(|e| format!("Failed to logout subscription account: {e:#}"))
}

#[tauri::command]
pub async fn refresh_subscription_account(
    state: State<'_, AppState>,
    request: SubscriptionProviderRequest,
) -> Result<openbitfun_core::infrastructure::subscription_auth::SubscriptionAccount, String> {
    let proxy_config = configured_ai_proxy(&state).await?;
    let options = openbitfun_core::infrastructure::subscription_auth::SubscriptionHttpOptions::new(
        proxy_config,
        false,
    );
    openbitfun_core::infrastructure::subscription_auth::refresh_account_with_options(
        request.provider,
        &options,
    )
    .await
    .map_err(|e| format!("Failed to refresh subscription account: {e:#}"))
}

#[cfg(test)]
mod remote_guard_tests {
    use super::{
        ensure_workspace_watch_supported, export_local_file_to_path, CheckPathExistsRequest,
        ExportLocalFileRequest, GetFileMetadataRequest, OpenWorkspaceRequest, SearchFilesRequest,
    };
    use openbitfun_core::service::remote_ssh::workspace_state::init_remote_workspace_manager;

    /// Registers a uniquely named remote root in the process-wide registry so the guards under
    /// test see a real remote workspace, and removes it again when the guard returns.
    struct RemoteRootFixture {
        remote_root: String,
        connection_id: String,
    }

    impl RemoteRootFixture {
        async fn register(name: &str) -> Self {
            let remote_root = format!("/remote-audit-{name}");
            let connection_id = format!("remote-audit-{name}-connection");
            init_remote_workspace_manager()
                .register_remote_workspace(
                    remote_root.clone(),
                    connection_id.clone(),
                    format!("remote-audit-{name}"),
                    format!("remote-audit-{name}.invalid"),
                )
                .await;
            Self {
                remote_root,
                connection_id,
            }
        }

        fn child(&self, name: &str) -> String {
            format!("{}/{}", self.remote_root, name)
        }

        async fn unregister(self) {
            init_remote_workspace_manager()
                .unregister_remote_workspace(&self.connection_id, &self.remote_root)
                .await;
        }
    }

    fn controller_sentinel(name: &str) -> std::path::PathBuf {
        let path = std::env::temp_dir().join(format!("openbitfun-remote-audit-{name}"));
        let _ = std::fs::remove_file(&path);
        let _ = std::fs::remove_dir_all(&path);
        path
    }

    #[tokio::test]
    async fn export_local_file_to_path_refuses_remote_source_and_leaves_controller_untouched() {
        let fixture = RemoteRootFixture::register("export-source").await;
        let destination = controller_sentinel("export-source-destination.txt");

        let error = export_local_file_to_path(ExportLocalFileRequest {
            controller_local: false,
            workspace_id: None,
            source_path: fixture.child("main.rs"),
            destination_path: destination.to_string_lossy().to_string(),
        })
        .await
        .expect_err("remote export source must be refused");

        assert!(error.starts_with("export_local_file_to_path cannot use remote workspace path"));
        assert!(error.contains("local filesystem fallback was not attempted"));
        assert!(
            !destination.exists(),
            "controller destination must not be written"
        );

        fixture.unregister().await;
    }

    #[tokio::test]
    async fn export_local_file_to_path_refuses_remote_destination() {
        let fixture = RemoteRootFixture::register("export-destination").await;
        let source = controller_sentinel("export-destination-source.txt");
        std::fs::write(&source, b"local bytes").expect("write controller source");

        let error = export_local_file_to_path(ExportLocalFileRequest {
            controller_local: false,
            workspace_id: None,
            source_path: source.to_string_lossy().to_string(),
            destination_path: fixture.child("copy.txt"),
        })
        .await
        .expect_err("remote export destination must be refused");

        assert!(error.contains("as destination"));
        assert!(error.contains("local filesystem fallback was not attempted"));

        let _ = std::fs::remove_file(&source);
        fixture.unregister().await;
    }

    #[test]
    fn file_watch_routing_uses_record_kind() {
        ensure_workspace_watch_supported(super::WorkspaceKind::Normal).unwrap();
        let error = ensure_workspace_watch_supported(super::WorkspaceKind::Remote).unwrap_err();
        assert!(error.contains("not available for remote workspaces"));
    }

    #[test]
    fn legacy_search_files_payload_without_remote_scope_remains_readable() {
        let request: SearchFilesRequest = serde_json::from_value(serde_json::json!({
            "rootPath": "/workspace",
            "pattern": "todo",
            "searchContent": false
        }))
        .expect("deserialize legacy search request");

        assert!(request.remote_connection_id.is_none());
        assert!(request.include_directories);
    }

    #[test]
    fn search_files_payload_accepts_remote_scope() {
        let request: SearchFilesRequest = serde_json::from_value(serde_json::json!({
            "rootPath": "/workspace",
            "pattern": "todo",
            "searchContent": false,
            "remoteConnectionId": "connection-1"
        }))
        .expect("deserialize scoped search request");

        assert_eq!(
            request.remote_connection_id.as_deref(),
            Some("connection-1")
        );
    }

    #[test]
    fn legacy_open_workspace_payload_without_remote_scope_remains_readable() {
        let legacy: OpenWorkspaceRequest = serde_json::from_value(serde_json::json!({
            "path": "/workspace"
        }))
        .expect("deserialize legacy open workspace request");
        assert!(legacy.remote_connection_id.is_none());

        let scoped: OpenWorkspaceRequest = serde_json::from_value(serde_json::json!({
            "path": "/workspace",
            "remoteConnectionId": "connection-1"
        }))
        .expect("deserialize scoped open workspace request");
        assert_eq!(scoped.remote_connection_id.as_deref(), Some("connection-1"));
    }

    #[test]
    fn path_probe_payloads_accept_optional_remote_scope() {
        let exists: CheckPathExistsRequest = serde_json::from_value(serde_json::json!({
            "path": "/workspace/main.rs",
            "remoteConnectionId": "connection-1"
        }))
        .expect("deserialize scoped exists request");
        assert_eq!(exists.remote_connection_id.as_deref(), Some("connection-1"));

        let legacy: GetFileMetadataRequest = serde_json::from_value(serde_json::json!({
            "path": "/workspace/main.rs"
        }))
        .expect("deserialize legacy metadata request");
        assert!(legacy.remote_connection_id.is_none());
    }
}

#[tauri::command]
pub async fn workspace_file_upload(
    request: openbitfun_core::service::filesystem::upload::WorkspaceUploadRequest,
) -> Result<serde_json::Value, String> {
    let account = crate::api::remote_connect_api::account_status()
        .await?
        .user_id
        .ok_or("Sign in to use workspace transfers")?;
    let status =
        openbitfun_core::service::filesystem::upload::workspace_file_upload(account, request)
            .await?;
    serde_json::to_value(status).map_err(|error| error.to_string())
}

#[cfg(test)]
mod file_workspace_id_contract_tests {
    #[test]
    fn file_requests_accept_ids_and_preserve_pre_id_wire_inputs() {
        let write: super::WriteFileContentRequest = serde_json::from_value(serde_json::json!({
            "workspaceId":"workspace-1", "filePath":"/srv/file.txt", "content":"text"
        }))
        .unwrap();
        assert_eq!(write.workspace_id.as_deref(), Some("workspace-1"));
        assert!(write.workspace_path.is_empty());
        let read: super::ReadFileContentRequest = serde_json::from_value(serde_json::json!({
            "workspaceId":"workspace-1", "filePath":"openbitfun-runtime://current/plans/plan.md"
        }))
        .unwrap();
        assert_eq!(read.workspace_id.as_deref(), Some("workspace-1"));
        let legacy: super::WriteFileContentRequest = serde_json::from_value(serde_json::json!({
            "workspacePath":"/legacy/project", "filePath":"/legacy/project/file.txt", "content":"old", "remoteConnectionId":"ssh-old"
        })).unwrap();
        assert!(legacy.workspace_id.is_none());
        assert_eq!(legacy.workspace_path, "/legacy/project");
        assert_eq!(legacy.remote_connection_id.as_deref(), Some("ssh-old"));
    }
}
