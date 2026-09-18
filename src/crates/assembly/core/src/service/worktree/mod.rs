//! Product-owned managed Git worktree lifecycle.
//!
//! Concrete Git and filesystem operations remain in `services-integrations`.
//! This module owns registry reconciliation, idempotency, lifecycle policy,
//! session association, and safe-removal decisions.

use crate::infrastructure::events::{emit_global_event, BackendEvent};
use crate::infrastructure::{get_path_manager_arc, PathManager};
use crate::service::config::GlobalConfigManager;
use crate::service::git::{GitError, GitService, GitWorktreeInfo};
use crate::service::workspace::{
    get_global_workspace_service, WorkspaceActivityMode, WorkspaceCreateOptions, WorkspaceKind,
};
use crate::service::workspace_runtime::get_workspace_runtime_service_arc;
use openbitfun_core_types::{
    product_identity::hidden_data_directory, SessionExecutionTarget, SessionExecutionTargetKind,
    WorktreeError, WorktreeErrorCode, WorktreeLifecycle, WorktreeSessionSummary, WorktreeSettings,
    WorktreeSummary,
};
use openbitfun_services_core::json_store::JsonFileStore;
use openbitfun_services_core::session::{SessionMetadata, SessionMetadataStore, SessionStatus};
use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};
use std::collections::{HashMap, HashSet};
use std::path::{Path, PathBuf};
use std::sync::{Arc, Mutex, OnceLock};
use tokio::sync::Mutex as AsyncMutex;
use uuid::Uuid;

const WORKTREE_REGISTRY_VERSION: u32 = 1;
const REGISTRY_FILE_NAME: &str = "worktrees.json";
const WORKTREE_DIRECTORY_SUFFIX_LENGTH: usize = 8;
const WORKTREE_PROJECT_LABEL_MAX_CHARS: usize = 48;
const AUTO_DELETE_MIN_AGE_MS: u64 = 24 * 60 * 60 * 1_000;

mod session_binding;

pub use session_binding::{WorktreeSessionBindingRequest, WorktreeSessionBindingResult};

static REPOSITORY_LOCKS: OnceLock<Mutex<HashMap<PathBuf, Arc<AsyncMutex<()>>>>> = OnceLock::new();

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct WorktreeListRequest {
    /// Owning project workspace ID. Hosts resolve the local project path from
    /// this ID; `project_workspace_path` is the legacy/IO projection.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub project_workspace_id: Option<String>,
    pub project_workspace_path: String,
}

#[derive(Debug, Clone, Default, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct WorktreeProjectListRequest {}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct WorktreeProjectSummary {
    /// Workspace ID of the open workspace whose root is this project's main
    /// worktree. `None` when the main worktree is not itself an open
    /// workspace and only linked worktrees of it are open.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub project_workspace_id: Option<String>,
    pub project_workspace_path: String,
    pub worktrees: Vec<WorktreeSummary>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct WorktreeCreateRequest {
    pub request_id: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub project_workspace_id: Option<String>,
    pub project_workspace_path: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub source_workspace_path: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub base_ref: Option<String>,
    #[serde(default)]
    pub copy_local_changes: bool,
    /// Marks the new worktree as owned by a caller that must release it later,
    /// exempting it from automatic cleanup until then.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub claimed_by: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct WorktreeCreateResult {
    pub worktree: WorktreeSummary,
    pub execution_target: SessionExecutionTarget,
    pub created: bool,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct WorktreeCreateBranchRequest {
    pub request_id: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub project_workspace_id: Option<String>,
    pub project_workspace_path: String,
    pub worktree_id: String,
    pub branch: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct WorktreePromoteRequest {
    pub request_id: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub project_workspace_id: Option<String>,
    pub project_workspace_path: String,
    pub worktree_id: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct WorktreeRemoveRequest {
    pub request_id: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub project_workspace_id: Option<String>,
    pub project_workspace_path: String,
    pub worktree_id: String,
    #[serde(default)]
    pub force: bool,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct WorktreeRecreateRequest {
    pub request_id: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub project_workspace_id: Option<String>,
    pub project_workspace_path: String,
    pub worktree_id: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct WorktreeMutationResult {
    pub worktree: WorktreeSummary,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct WorktreeRemoveResult {
    pub worktree_id: String,
    pub removed: bool,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
struct WorktreeRegistry {
    version: u32,
    project_workspace_path: String,
    #[serde(default)]
    worktrees: Vec<RegisteredWorktree>,
    #[serde(default)]
    receipts: HashMap<String, WorktreeOperationReceipt>,
}

impl WorktreeRegistry {
    fn new(project_workspace_path: &Path) -> Self {
        Self {
            version: WORKTREE_REGISTRY_VERSION,
            project_workspace_path: path_string(project_workspace_path),
            worktrees: Vec::new(),
            receipts: HashMap::new(),
        }
    }
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
struct RegisteredWorktree {
    #[serde(default, skip_serializing_if = "Option::is_none")]
    workspace_id: Option<String>,
    worktree_id: String,
    path: String,
    base_ref: Option<String>,
    base_commit: String,
    branch: Option<String>,
    lifecycle: WorktreeLifecycle,
    created_at_ms: u64,
    /// Owner that still needs this worktree, e.g. `dispatch:<jobId>`.
    ///
    /// A claim only suppresses automatic cleanup. It is not a lifecycle: the
    /// worktree stays `Managed` and stays manually removable. The claim exists
    /// because a claimed worktree can be indistinguishable from an abandoned
    /// one — a dispatch baseline has no local session and stays clean until its
    /// remote result is synced back, so none of the ordinary safety vetoes
    /// (dirty, unpublished commits, associated sessions) would protect it.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    claimed_by: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(tag = "operation", rename_all = "snake_case")]
enum WorktreeOperationReceipt {
    Create {
        worktree_id: String,
        source_workspace_path: String,
        base_ref: String,
        copy_local_changes: bool,
        #[serde(default, skip_serializing_if = "Option::is_none")]
        claimed_by: Option<String>,
    },
    CreateBranch {
        worktree_id: String,
        branch: String,
    },
    Promote {
        worktree_id: String,
    },
    Remove {
        worktree_id: String,
        #[serde(default)]
        force: bool,
    },
    Recreate {
        worktree_id: String,
    },
}

impl WorktreeOperationReceipt {
    fn worktree_id(&self) -> &str {
        match self {
            Self::Create { worktree_id, .. }
            | Self::CreateBranch { worktree_id, .. }
            | Self::Promote { worktree_id }
            | Self::Remove { worktree_id, .. }
            | Self::Recreate { worktree_id } => worktree_id,
        }
    }
}

struct RepositoryContext {
    project_workspace_path: PathBuf,
    common_git_dir: PathBuf,
    registry_path: PathBuf,
    settings: WorktreeSettings,
}

pub struct WorktreeService;

impl WorktreeService {
    /// Resolve any checkout (including a linked worktree) to the stable main
    /// project path that owns this repository's managed-worktree registry.
    ///
    /// Dispatch persists this before it creates a claimed baseline so crash
    /// recovery never depends on the short-lived checkout that initiated it.
    pub async fn resolve_project_workspace_path(
        workspace_path: &str,
    ) -> Result<String, WorktreeError> {
        let context = Self::repository_context(Path::new(workspace_path)).await?;
        Ok(path_string(&context.project_workspace_path))
    }

    /// Stable session identity for an idempotent worktree-session request.
    pub fn session_id_for_request(request_id: &str) -> Result<String, WorktreeError> {
        validate_request_id(request_id)?;
        Ok(format!("worktree-session-{}", short_hash(request_id)))
    }

    /// Compensates a just-created worktree when atomic session creation fails.
    /// This is intentionally not exposed through Tauri or Agent tools.
    pub async fn rollback_created(
        project_workspace_path: &str,
        worktree_id: &str,
    ) -> Result<(), WorktreeError> {
        let context = Self::repository_context(Path::new(project_workspace_path)).await?;
        let lock = repository_lock(&context.common_git_dir);
        let _guard = lock.lock().await;
        let _process_guard = Self::acquire_repository_process_lock(&context).await?;
        let mut registry = Self::load_registry(&context).await?;
        let record = registry
            .worktrees
            .iter()
            .find(|record| record.worktree_id == worktree_id)
            .cloned()
            .ok_or_else(|| {
                error(
                    WorktreeErrorCode::WorktreeNotFound,
                    "Managed worktree was not found during rollback",
                )
            })?;
        if Path::new(&record.path).exists() {
            GitService::remove_worktree(&context.project_workspace_path, &record.path, true)
                .await
                .map_err(map_git_error)?;
        } else {
            GitService::prune_worktrees(&context.project_workspace_path)
                .await
                .map_err(map_git_error)?;
        }
        let mut cleanup_issues = Vec::new();
        if let Some(workspace_service) = get_global_workspace_service() {
            if let Some(workspace_id) = record.workspace_id.as_deref() {
                if let Err(remove_error) = workspace_service.remove_workspace(workspace_id).await {
                    cleanup_issues.push(format!(
                        "workspace registration could not be removed: {remove_error}"
                    ));
                }
            }
        }
        registry
            .worktrees
            .retain(|registered| registered.worktree_id != worktree_id);
        registry
            .receipts
            .retain(|_, receipt| receipt.worktree_id() != worktree_id);
        if let Err(registry_error) = Self::save_registry(&context, &registry).await {
            cleanup_issues.push(format!("registry could not be updated: {registry_error}"));
        }
        notify_changed(&context.project_workspace_path).await;
        if cleanup_issues.is_empty() {
            Ok(())
        } else {
            Err(WorktreeError {
                code: WorktreeErrorCode::RollbackIncomplete,
                message: cleanup_issues.join("; "),
                recovery_path: Some(record.path),
            })
        }
    }

    /// User-level worktree defaults (root directory, branch prefix, copy policy).
    pub async fn settings() -> WorktreeSettings {
        load_settings().await
    }

    pub async fn list(request: WorktreeListRequest) -> Result<Vec<WorktreeSummary>, WorktreeError> {
        Self::list_scoped(request, None).await
    }

    async fn list_scoped(
        request: WorktreeListRequest,
        managed_root: Option<&Path>,
    ) -> Result<Vec<WorktreeSummary>, WorktreeError> {
        let context = Self::repository_context(Path::new(&request.project_workspace_path)).await?;
        let lock = repository_lock(&context.common_git_dir);
        let _guard = lock.lock().await;
        let _process_guard = Self::acquire_repository_process_lock(&context).await?;
        let mut registry = Self::load_registry(&context).await?;
        let (summaries, changed) =
            Self::reconcile_scoped(&context, &mut registry, managed_root).await?;
        if changed {
            Self::save_registry(&context, &registry).await?;
        }
        Ok(summaries)
    }

    /// Lists local Git projects known to the workspace service together with
    /// worktrees beneath the configured OpenBitFun worktree root. Invalid and
    /// non-Git workspace records are ignored so one stale project cannot hide
    /// the rest of the catalog.
    pub async fn list_projects(
        _request: WorktreeProjectListRequest,
    ) -> Result<Vec<WorktreeProjectSummary>, WorktreeError> {
        let settings = load_settings().await;
        let path_manager = get_path_manager_arc();
        let managed_root = resolve_managed_root(&settings, path_manager.as_ref())?;
        let project_paths = known_project_workspace_paths().await;
        let mut projects = Vec::new();

        for (project_path, project_workspace_id) in project_paths {
            match Self::list_scoped(
                WorktreeListRequest {
                    project_workspace_id: project_workspace_id.clone(),
                    project_workspace_path: path_string(&project_path),
                },
                Some(&managed_root),
            )
            .await
            {
                Ok(worktrees) => {
                    let worktrees = worktrees
                        .into_iter()
                        .filter(|worktree| !worktree.is_main)
                        .collect::<Vec<_>>();
                    if worktrees.is_empty() {
                        continue;
                    }
                    projects.push(WorktreeProjectSummary {
                        project_workspace_id,
                        project_workspace_path: path_string(&project_path),
                        worktrees,
                    });
                }
                Err(list_error) => {
                    log::warn!(
                        "Failed to list worktrees for project {}: {}",
                        project_path.display(),
                        list_error
                    );
                }
            }
        }

        projects.sort_by(|left, right| {
            left.project_workspace_path
                .cmp(&right.project_workspace_path)
        });
        Ok(projects)
    }

    pub async fn create(
        request: WorktreeCreateRequest,
    ) -> Result<WorktreeCreateResult, WorktreeError> {
        validate_request_id(&request.request_id)?;
        let context = Self::repository_context(Path::new(&request.project_workspace_path)).await?;
        let lock = repository_lock(&context.common_git_dir);
        let _guard = lock.lock().await;
        let _process_guard = Self::acquire_repository_process_lock(&context).await?;
        let mut registry = Self::load_registry(&context).await?;
        let source_path = request
            .source_workspace_path
            .as_deref()
            .map(PathBuf::from)
            .unwrap_or_else(|| context.project_workspace_path.clone());
        let source_workspace_path = normalized_lookup_path(&source_path);
        let base_ref = request.base_ref.as_deref().unwrap_or("HEAD").trim();
        let claimed_by = request
            .claimed_by
            .as_deref()
            .map(str::trim)
            .filter(|claim| !claim.is_empty())
            .map(ToOwned::to_owned);

        if let Some(receipt) = registry.receipts.get(&request.request_id).cloned() {
            return match receipt {
                WorktreeOperationReceipt::Create {
                    worktree_id,
                    source_workspace_path: receipt_source,
                    base_ref: receipt_base_ref,
                    copy_local_changes,
                    claimed_by: receipt_claimed_by,
                } if receipt_source == source_workspace_path
                    && receipt_base_ref == base_ref
                    && copy_local_changes == request.copy_local_changes
                    && receipt_claimed_by.as_deref() == claimed_by.as_deref() =>
                {
                    let claim_restored = Self::restore_create_receipt_claim(
                        &mut registry,
                        &worktree_id,
                        claimed_by.as_deref(),
                    )?;
                    if claim_restored {
                        Self::save_registry(&context, &registry).await?;
                    }
                    let result =
                        Self::create_result_for_id(&context, &mut registry, &worktree_id, false)
                            .await;
                    if result.is_err()
                        && claim_restored
                        && Self::clear_matching_claim(
                            &mut registry,
                            &worktree_id,
                            claimed_by.as_deref(),
                        )
                    {
                        // This invocation reacquired the claim, so it also owns
                        // rolling that mutation back when result reconciliation
                        // fails. A pre-existing claim may belong to an in-flight
                        // or durable dispatch and is never cleared here.
                        if let Err(cleanup_error) = Self::save_registry(&context, &registry).await {
                            log::warn!(
                                "Failed to roll back a restored worktree claim after create reconciliation failed: worktree_id={} error={}",
                                worktree_id,
                                cleanup_error
                            );
                        }
                    }
                    result
                }
                _ => Err(error(
                    WorktreeErrorCode::RequestConflict,
                    "The requestId was already used with different worktree creation parameters",
                )),
            };
        }

        let source_repository = GitService::resolve_worktree_repository(&source_path)
            .await
            .map_err(map_git_error)?;
        if source_repository.common_git_dir != context.common_git_dir {
            return Err(error(
                WorktreeErrorCode::InvalidPath,
                "The source workspace does not belong to the selected project repository",
            ));
        }

        let base_commit = GitService::resolve_revision(&source_path, base_ref)
            .await
            .map_err(|git_error| map_base_ref_error(git_error, base_ref))?;
        if request.copy_local_changes {
            let source_head = GitService::resolve_revision(&source_path, "HEAD")
                .await
                .map_err(map_git_error)?;
            if source_head != base_commit {
                return Err(error(
                    WorktreeErrorCode::CopyConflict,
                    "Local changes can only be copied when the selected base resolves to source HEAD",
                ));
            }
        }

        let worktree_id = Uuid::new_v4().simple().to_string();
        let repository_id = repository_id(&context.common_git_dir);
        let target_path = managed_target_path(
            &context.settings,
            &repository_id,
            &context.project_workspace_path,
            &worktree_id,
        )
        .await?;

        GitService::add_detached_worktree(
            &context.project_workspace_path,
            &target_path,
            &base_commit,
        )
        .await
        .map_err(map_git_error)?;

        if request.copy_local_changes {
            if let Err(copy_error) =
                GitService::copy_local_changes(&source_path, &target_path).await
            {
                return Err(Self::rollback_new_worktree(
                    &context,
                    &target_path,
                    map_copy_error(copy_error),
                )
                .await);
            }
        }

        let tracked_workspace_id = if let Some(workspace_service) = get_global_workspace_service() {
            match workspace_service
                .track_workspace_activity(
                    target_path.clone(),
                    WorkspaceCreateOptions::default(),
                    WorkspaceActivityMode::RefreshMetadata,
                )
                .await
            {
                Ok(workspace) => Some(workspace.id),
                Err(track_error) => {
                    return Err(Self::rollback_new_worktree(
                        &context,
                        &target_path,
                        error(
                            WorktreeErrorCode::IoFailed,
                            format!("Failed to register the worktree workspace: {track_error}"),
                        ),
                    )
                    .await);
                }
            }
        } else {
            None
        };

        let created_claim = claimed_by.clone();
        registry.worktrees.push(RegisteredWorktree {
            workspace_id: tracked_workspace_id.clone(),
            worktree_id: worktree_id.clone(),
            path: path_string(&target_path),
            base_ref: Some(base_ref.to_string()),
            base_commit: base_commit.clone(),
            branch: None,
            lifecycle: WorktreeLifecycle::Managed,
            created_at_ms: current_unix_ms(),
            claimed_by: claimed_by.clone(),
        });
        registry.receipts.insert(
            request.request_id,
            WorktreeOperationReceipt::Create {
                worktree_id: worktree_id.clone(),
                source_workspace_path,
                base_ref: base_ref.to_string(),
                copy_local_changes: request.copy_local_changes,
                claimed_by,
            },
        );
        if let Err(registry_error) = Self::save_registry(&context, &registry).await {
            return Err(Self::rollback_new_worktree_with_workspace(
                &context,
                &target_path,
                tracked_workspace_id.as_deref(),
                registry_error,
            )
            .await);
        }

        if let Err(cleanup_error) =
            Self::auto_delete_old_worktrees(&context, &mut registry, &worktree_id).await
        {
            log::warn!(
                "Failed to auto-delete old worktrees for project {}: {}",
                context.project_workspace_path.display(),
                cleanup_error
            );
        }

        let result = match Self::create_result_for_id(&context, &mut registry, &worktree_id, true)
            .await
        {
            Ok(result) => result,
            Err(result_error) => {
                if Self::clear_matching_claim(&mut registry, &worktree_id, created_claim.as_deref())
                {
                    // The worktree and its idempotency receipt remain usable,
                    // but this failed call must not leave an ownerless retention
                    // claim behind. A later retry can reacquire the receipt's
                    // exact claim through `restore_create_receipt_claim`.
                    if let Err(cleanup_error) = Self::save_registry(&context, &registry).await {
                        log::warn!(
                            "Failed to roll back a new worktree claim after create reconciliation failed: worktree_id={} error={}",
                            worktree_id,
                            cleanup_error
                        );
                    }
                }
                return Err(result_error);
            }
        };
        notify_changed(&context.project_workspace_path).await;
        Ok(result)
    }

    pub async fn create_branch(
        request: WorktreeCreateBranchRequest,
    ) -> Result<WorktreeMutationResult, WorktreeError> {
        validate_request_id(&request.request_id)?;
        let branch = request.branch.trim().to_string();
        if branch.is_empty() {
            return Err(error(
                WorktreeErrorCode::InvalidPath,
                "Branch name cannot be empty",
            ));
        }
        let context = Self::repository_context(Path::new(&request.project_workspace_path)).await?;
        let lock = repository_lock(&context.common_git_dir);
        let _guard = lock.lock().await;
        let _process_guard = Self::acquire_repository_process_lock(&context).await?;
        let mut registry = Self::load_registry(&context).await?;

        if let Some(receipt) = registry.receipts.get(&request.request_id).cloned() {
            return match receipt {
                WorktreeOperationReceipt::CreateBranch {
                    worktree_id,
                    branch: receipt_branch,
                } if worktree_id == request.worktree_id && receipt_branch == branch => {
                    Self::mutation_result_for_id(&context, &mut registry, &worktree_id).await
                }
                _ => Err(error(
                    WorktreeErrorCode::RequestConflict,
                    "The requestId was already used with different branch parameters",
                )),
            };
        }

        let record = registry
            .worktrees
            .iter_mut()
            .find(|record| record.worktree_id == request.worktree_id)
            .ok_or_else(|| {
                error(
                    WorktreeErrorCode::WorktreeNotFound,
                    "Managed worktree was not found",
                )
            })?;
        if !Path::new(&record.path).is_dir() {
            return Err(error(
                WorktreeErrorCode::WorktreeNotFound,
                "Worktree directory is missing; recreate it before creating a branch",
            ));
        }
        let info = GitService::create_worktree_branch(&record.path, &branch)
            .await
            .map_err(map_branch_error)?;
        record.branch = info.branch;
        registry.receipts.insert(
            request.request_id,
            WorktreeOperationReceipt::CreateBranch {
                worktree_id: request.worktree_id.clone(),
                branch,
            },
        );
        Self::save_registry(&context, &registry).await?;
        let result =
            Self::mutation_result_for_id(&context, &mut registry, &request.worktree_id).await?;
        notify_changed(&context.project_workspace_path).await;
        Ok(result)
    }

    pub async fn promote(
        request: WorktreePromoteRequest,
    ) -> Result<WorktreeMutationResult, WorktreeError> {
        validate_request_id(&request.request_id)?;
        let context = Self::repository_context(Path::new(&request.project_workspace_path)).await?;
        let lock = repository_lock(&context.common_git_dir);
        let _guard = lock.lock().await;
        let _process_guard = Self::acquire_repository_process_lock(&context).await?;
        let mut registry = Self::load_registry(&context).await?;
        if let Some(receipt) = registry.receipts.get(&request.request_id).cloned() {
            return match receipt {
                WorktreeOperationReceipt::Promote { worktree_id }
                    if worktree_id == request.worktree_id =>
                {
                    Self::mutation_result_for_id(&context, &mut registry, &worktree_id).await
                }
                _ => Err(error(
                    WorktreeErrorCode::RequestConflict,
                    "The requestId was already used with different promote parameters",
                )),
            };
        }
        let record = registry
            .worktrees
            .iter_mut()
            .find(|record| record.worktree_id == request.worktree_id)
            .ok_or_else(|| {
                error(
                    WorktreeErrorCode::WorktreeNotFound,
                    "Managed worktree was not found",
                )
            })?;
        if record.lifecycle != WorktreeLifecycle::Managed {
            return Err(error(
                WorktreeErrorCode::InvalidPath,
                "Only managed worktrees can be kept as permanent worktrees",
            ));
        }
        record.lifecycle = WorktreeLifecycle::Permanent;
        registry.receipts.insert(
            request.request_id,
            WorktreeOperationReceipt::Promote {
                worktree_id: request.worktree_id.clone(),
            },
        );
        Self::save_registry(&context, &registry).await?;
        let result =
            Self::mutation_result_for_id(&context, &mut registry, &request.worktree_id).await?;
        notify_changed(&context.project_workspace_path).await;
        Ok(result)
    }

    /// Drop a retention claim so the worktree can be cleaned up normally again.
    ///
    /// Idempotent by construction rather than by receipt: releasing an absent
    /// claim, an already-released one, or a worktree that has since been removed
    /// all report `false` instead of failing. Callers run this from cleanup
    /// paths where an error would strand the claim forever.
    pub async fn release_claim(
        project_workspace_path: &str,
        claimed_by: &str,
    ) -> Result<bool, WorktreeError> {
        Self::release_claim_matching(project_workspace_path, None, claimed_by).await
    }

    /// Release one exact worktree's claim without affecting another record
    /// that may use the same logical owner string.
    pub async fn release_claim_for_worktree(
        project_workspace_path: &str,
        worktree_id: &str,
        claimed_by: &str,
    ) -> Result<bool, WorktreeError> {
        let worktree_id = worktree_id.trim();
        if worktree_id.is_empty() {
            return Ok(false);
        }
        Self::release_claim_matching(project_workspace_path, Some(worktree_id), claimed_by).await
    }

    async fn release_claim_matching(
        project_workspace_path: &str,
        worktree_id: Option<&str>,
        claimed_by: &str,
    ) -> Result<bool, WorktreeError> {
        let claim = claimed_by.trim();
        if claim.is_empty() {
            return Ok(false);
        }
        let context = Self::repository_context(Path::new(project_workspace_path)).await?;
        let lock = repository_lock(&context.common_git_dir);
        let _guard = lock.lock().await;
        let _process_guard = Self::acquire_repository_process_lock(&context).await?;
        let mut registry = Self::load_registry(&context).await?;
        let mut released = false;
        for record in &mut registry.worktrees {
            if worktree_id.is_none_or(|expected| record.worktree_id == expected)
                && record.claimed_by.as_deref() == Some(claim)
            {
                record.claimed_by = None;
                released = true;
            }
        }
        if released {
            Self::save_registry(&context, &registry).await?;
        }
        Ok(released)
    }

    pub async fn remove(
        request: WorktreeRemoveRequest,
    ) -> Result<WorktreeRemoveResult, WorktreeError> {
        validate_request_id(&request.request_id)?;
        let context = Self::repository_context(Path::new(&request.project_workspace_path)).await?;
        let lock = repository_lock(&context.common_git_dir);
        let _guard = lock.lock().await;
        let _process_guard = Self::acquire_repository_process_lock(&context).await?;
        let mut registry = Self::load_registry(&context).await?;
        if let Some(receipt) = registry.receipts.get(&request.request_id) {
            return match receipt {
                WorktreeOperationReceipt::Remove { worktree_id, force }
                    if worktree_id == &request.worktree_id && *force == request.force =>
                {
                    Ok(WorktreeRemoveResult {
                        worktree_id: worktree_id.clone(),
                        removed: true,
                    })
                }
                _ => Err(error(
                    WorktreeErrorCode::RequestConflict,
                    "The requestId was already used with different remove parameters",
                )),
            };
        }

        let (summaries, _) = Self::reconcile(&context, &mut registry).await?;
        let summary = summaries
            .iter()
            .find(|summary| summary.worktree_id == request.worktree_id)
            .ok_or_else(|| {
                error(
                    WorktreeErrorCode::WorktreeNotFound,
                    "Managed worktree was not found",
                )
            })?;
        validate_removal(summary, request.force)?;

        GitService::remove_worktree(
            &context.project_workspace_path,
            &summary.path,
            request.force,
        )
        .await
        .map_err(map_git_error)?;
        let mut cleanup_issues = Vec::new();
        if let Some(workspace_service) = get_global_workspace_service() {
            if let Some(workspace_id) = summary.workspace_id.as_deref() {
                if let Err(remove_error) = workspace_service.remove_workspace(workspace_id).await {
                    cleanup_issues.push(format!(
                        "workspace registration could not be removed: {remove_error}"
                    ));
                }
            }
        }
        registry
            .worktrees
            .retain(|record| record.worktree_id != request.worktree_id);
        registry.receipts.insert(
            request.request_id,
            WorktreeOperationReceipt::Remove {
                worktree_id: request.worktree_id.clone(),
                force: request.force,
            },
        );
        if let Err(registry_error) = Self::save_registry(&context, &registry).await {
            cleanup_issues.push(format!("registry could not be updated: {registry_error}"));
        }
        notify_changed(&context.project_workspace_path).await;
        if !cleanup_issues.is_empty() {
            return Err(WorktreeError {
                code: WorktreeErrorCode::RollbackIncomplete,
                message: format!(
                    "Worktree was removed, but cleanup did not complete: {}",
                    cleanup_issues.join("; ")
                ),
                recovery_path: Some(summary.path.clone()),
            });
        }
        Ok(WorktreeRemoveResult {
            worktree_id: request.worktree_id,
            removed: true,
        })
    }

    pub async fn recreate(
        request: WorktreeRecreateRequest,
    ) -> Result<WorktreeMutationResult, WorktreeError> {
        validate_request_id(&request.request_id)?;
        let context = Self::repository_context(Path::new(&request.project_workspace_path)).await?;
        let lock = repository_lock(&context.common_git_dir);
        let _guard = lock.lock().await;
        let _process_guard = Self::acquire_repository_process_lock(&context).await?;
        let mut registry = Self::load_registry(&context).await?;
        if let Some(receipt) = registry.receipts.get(&request.request_id).cloned() {
            return match receipt {
                WorktreeOperationReceipt::Recreate { worktree_id }
                    if worktree_id == request.worktree_id =>
                {
                    Self::mutation_result_for_id(&context, &mut registry, &worktree_id).await
                }
                _ => Err(error(
                    WorktreeErrorCode::RequestConflict,
                    "The requestId was already used with different recreate parameters",
                )),
            };
        }

        let record = registry
            .worktrees
            .iter()
            .find(|record| record.worktree_id == request.worktree_id)
            .cloned()
            .ok_or_else(|| {
                error(
                    WorktreeErrorCode::WorktreeNotFound,
                    "Managed worktree was not found",
                )
            })?;
        if Path::new(&record.path).exists() {
            return Err(error(
                WorktreeErrorCode::InvalidPath,
                "Worktree directory already exists",
            ));
        }
        GitService::prune_worktrees(&context.project_workspace_path)
            .await
            .map_err(map_git_error)?;
        GitService::add_detached_worktree(
            &context.project_workspace_path,
            &record.path,
            &record.base_commit,
        )
        .await
        .map_err(map_git_error)?;
        if let Some(branch) = record.branch.as_deref() {
            if let Err(branch_error) =
                GitService::attach_worktree_branch(&record.path, branch).await
            {
                return Err(Self::rollback_new_worktree(
                    &context,
                    Path::new(&record.path),
                    map_branch_error(branch_error),
                )
                .await);
            }
        }
        registry.receipts.insert(
            request.request_id,
            WorktreeOperationReceipt::Recreate {
                worktree_id: request.worktree_id.clone(),
            },
        );
        Self::save_registry(&context, &registry).await?;
        let result =
            Self::mutation_result_for_id(&context, &mut registry, &request.worktree_id).await?;
        notify_changed(&context.project_workspace_path).await;
        Ok(result)
    }

    async fn repository_context(project_path: &Path) -> Result<RepositoryContext, WorktreeError> {
        if !project_path.is_dir() {
            return Err(error(
                WorktreeErrorCode::InvalidPath,
                "Project workspace path does not exist",
            ));
        }
        let repository_info = GitService::resolve_worktree_repository(project_path)
            .await
            .map_err(map_git_error)?;
        let worktrees = GitService::list_worktrees(project_path)
            .await
            .map_err(map_git_error)?;
        let project_workspace_path = worktrees
            .iter()
            .find(|worktree| worktree.is_main)
            .map(|worktree| PathBuf::from(&worktree.path))
            .unwrap_or_else(|| repository_info.query_path.clone());
        let project_workspace_path =
            std::fs::canonicalize(&project_workspace_path).unwrap_or(project_workspace_path);
        let runtime = get_workspace_runtime_service_arc()
            .ensure_local_workspace_runtime(&project_workspace_path)
            .await
            .map_err(|runtime_error| {
                error(
                    WorktreeErrorCode::IoFailed,
                    format!("Failed to initialize project runtime: {runtime_error}"),
                )
            })?;
        Ok(RepositoryContext {
            project_workspace_path,
            common_git_dir: repository_info.common_git_dir,
            registry_path: runtime.context.config_dir.join(REGISTRY_FILE_NAME),
            settings: load_settings().await,
        })
    }

    async fn load_registry(context: &RepositoryContext) -> Result<WorktreeRegistry, WorktreeError> {
        let registry = JsonFileStore
            .read_optional(&context.registry_path)
            .await
            .map_err(|store_error| {
                error(
                    WorktreeErrorCode::IoFailed,
                    format!("Failed to read worktree registry: {store_error}"),
                )
            })?
            .unwrap_or_else(|| WorktreeRegistry::new(&context.project_workspace_path));
        if registry.version != WORKTREE_REGISTRY_VERSION {
            return Err(error(
                WorktreeErrorCode::IoFailed,
                format!(
                    "Unsupported worktree registry version: {}",
                    registry.version
                ),
            ));
        }
        Ok(registry)
    }

    async fn acquire_repository_process_lock(
        context: &RepositoryContext,
    ) -> Result<openbitfun_services_core::json_store::JsonFileCrossProcessLock, WorktreeError> {
        JsonFileStore
            .acquire_cross_process_lock(&context.registry_path)
            .await
            .map_err(|lock_error| {
                error(
                    WorktreeErrorCode::IoFailed,
                    format!("Failed to lock the worktree registry: {lock_error}"),
                )
            })
    }

    async fn save_registry(
        context: &RepositoryContext,
        registry: &WorktreeRegistry,
    ) -> Result<(), WorktreeError> {
        JsonFileStore
            .write_atomic_strict(&context.registry_path, registry)
            .await
            .map_err(|store_error| {
                error(
                    WorktreeErrorCode::IoFailed,
                    format!("Failed to persist worktree registry: {store_error}"),
                )
            })
    }

    async fn reconcile(
        context: &RepositoryContext,
        registry: &mut WorktreeRegistry,
    ) -> Result<(Vec<WorktreeSummary>, bool), WorktreeError> {
        Self::reconcile_scoped(context, registry, None).await
    }

    async fn reconcile_scoped(
        context: &RepositoryContext,
        registry: &mut WorktreeRegistry,
        managed_root: Option<&Path>,
    ) -> Result<(Vec<WorktreeSummary>, bool), WorktreeError> {
        let git_worktrees = GitService::list_worktrees(&context.project_workspace_path)
            .await
            .map_err(map_git_error)?;
        let sessions = load_project_sessions(&context.project_workspace_path).await?;
        let registered_by_path = registry
            .worktrees
            .iter()
            .map(|record| {
                (
                    normalized_lookup_path(Path::new(&record.path)),
                    record.clone(),
                )
            })
            .collect::<HashMap<_, _>>();
        let mut seen_registered_ids = HashSet::new();
        let mut summaries = Vec::new();
        let mut changed = false;

        for git_worktree in git_worktrees {
            if managed_root.is_some_and(|root| {
                git_worktree.is_main || !path_is_within_root(Path::new(&git_worktree.path), root)
            }) {
                continue;
            }
            let lookup_path = normalized_lookup_path(Path::new(&git_worktree.path));
            let missing = git_worktree.is_prunable || !Path::new(&git_worktree.path).is_dir();
            let registered = registered_by_path.get(&lookup_path);
            if let Some(record) = registered {
                seen_registered_ids.insert(record.worktree_id.clone());
            }
            let worktree_id = if git_worktree.is_main {
                "main".to_string()
            } else if let Some(record) = registered {
                record.worktree_id.clone()
            } else {
                let worktree_id = format!(
                    "external-{}",
                    short_hash(&format!(
                        "{}:{lookup_path}",
                        path_string(&context.common_git_dir)
                    ))
                );
                registry.worktrees.push(RegisteredWorktree {
                    workspace_id: None,
                    worktree_id: worktree_id.clone(),
                    path: git_worktree.path.clone(),
                    base_ref: git_worktree.branch.clone(),
                    base_commit: git_worktree.head.clone(),
                    branch: git_worktree.branch.clone(),
                    lifecycle: WorktreeLifecycle::External,
                    created_at_ms: current_unix_ms(),
                    claimed_by: None,
                });
                seen_registered_ids.insert(worktree_id.clone());
                changed = true;
                worktree_id
            };
            let lifecycle = registered
                .map(|record| record.lifecycle)
                .unwrap_or(WorktreeLifecycle::External);
            summaries.push(
                build_summary(
                    context,
                    &worktree_id,
                    lifecycle,
                    git_worktree,
                    missing,
                    &sessions,
                )
                .await?,
            );
        }

        for record in registry.worktrees.iter() {
            if seen_registered_ids.contains(&record.worktree_id) {
                continue;
            }
            if managed_root.is_some_and(|root| !path_is_within_root(Path::new(&record.path), root))
            {
                continue;
            }
            let missing_info = GitWorktreeInfo {
                path: record.path.clone(),
                branch: record.branch.clone(),
                head: record.base_commit.clone(),
                is_main: false,
                is_locked: false,
                is_prunable: true,
            };
            summaries.push(
                build_summary(
                    context,
                    &record.worktree_id,
                    record.lifecycle,
                    missing_info,
                    true,
                    &sessions,
                )
                .await?,
            );
        }

        summaries.sort_by(|left, right| {
            right
                .is_main
                .cmp(&left.is_main)
                .then_with(|| left.path.cmp(&right.path))
        });
        if let Some(workspace_service) = get_global_workspace_service() {
            for summary in &mut summaries {
                let record = registry
                    .worktrees
                    .iter_mut()
                    .find(|record| record.worktree_id == summary.worktree_id);
                if let Some(record) = record.as_ref() {
                    summary.workspace_id = record.workspace_id.clone();
                }
                if summary.workspace_id.is_some()
                    || summary.is_main
                    || summary.missing
                    || summary.lifecycle == WorktreeLifecycle::External
                {
                    continue;
                }
                // Upgrade-only: old worktree registry rows have no workspace ID.
                let workspace = match workspace_service
                    .resolve_legacy_workspace_reference(None, &summary.path, None, None)
                    .await
                    .map_err(|error_| error(WorktreeErrorCode::IoFailed, error_.to_string()))?
                {
                    Some(workspace) if workspace.workspace_kind != WorkspaceKind::Remote => {
                        workspace
                    }
                    Some(_) => {
                        return Err(error(
                            WorktreeErrorCode::RemoteUnsupported,
                            "Managed local worktree cannot reference a remote workspace",
                        ))
                    }
                    None => workspace_service
                        .track_workspace_activity(
                            PathBuf::from(&summary.path),
                            WorkspaceCreateOptions::default(),
                            WorkspaceActivityMode::RefreshMetadata,
                        )
                        .await
                        .map_err(|error_| error(WorktreeErrorCode::IoFailed, error_.to_string()))?,
                };
                summary.workspace_id = Some(workspace.id.clone());
                if let Some(record) = record {
                    record.workspace_id = Some(workspace.id);
                    changed = true;
                }
            }
        }
        Ok((summaries, changed))
    }

    async fn create_result_for_id(
        context: &RepositoryContext,
        registry: &mut WorktreeRegistry,
        worktree_id: &str,
        created: bool,
    ) -> Result<WorktreeCreateResult, WorktreeError> {
        let record = registry
            .worktrees
            .iter()
            .find(|record| record.worktree_id == worktree_id)
            .cloned()
            .ok_or_else(|| {
                error(
                    WorktreeErrorCode::WorktreeNotFound,
                    "Idempotent worktree result no longer exists",
                )
            })?;
        let (summaries, changed) = Self::reconcile(context, registry).await?;
        if changed {
            Self::save_registry(context, registry).await?;
        }
        let worktree = summaries
            .into_iter()
            .find(|summary| summary.worktree_id == worktree_id)
            .ok_or_else(|| {
                error(
                    WorktreeErrorCode::WorktreeNotFound,
                    "Created worktree could not be reconciled",
                )
            })?;
        Ok(WorktreeCreateResult {
            execution_target: SessionExecutionTarget {
                kind: SessionExecutionTargetKind::ManagedWorktree,
                worktree_id: Some(record.worktree_id),
                root_path: record.path,
                base_ref: record.base_ref,
                base_commit: Some(record.base_commit),
                branch: record.branch,
                lifecycle: Some(record.lifecycle),
            },
            worktree,
            created,
        })
    }

    /// Re-establish the claim recorded by an idempotent create receipt.
    ///
    /// Cleanup may release a claim before a submit retry reaches this path. A
    /// retry is allowed to reacquire only the exact claim bound to its original
    /// receipt; it must never adopt an older unclaimed create receipt or steal
    /// a worktree that is now held by another owner.
    fn restore_create_receipt_claim(
        registry: &mut WorktreeRegistry,
        worktree_id: &str,
        claimed_by: Option<&str>,
    ) -> Result<bool, WorktreeError> {
        let record = registry
            .worktrees
            .iter_mut()
            .find(|record| record.worktree_id == worktree_id)
            .ok_or_else(|| {
                error(
                    WorktreeErrorCode::WorktreeNotFound,
                    "Idempotent worktree result no longer exists",
                )
            })?;

        match (record.claimed_by.as_deref(), claimed_by) {
            (None, Some(claim)) => {
                record.claimed_by = Some(claim.to_string());
                Ok(true)
            }
            (None, None) => Ok(false),
            (Some(existing), Some(claim)) if existing == claim => Ok(false),
            _ => Err(error(
                WorktreeErrorCode::RequestConflict,
                "The idempotent worktree claim no longer matches its creation receipt",
            )),
        }
    }

    /// Clear only the claim introduced by the current create attempt.
    fn clear_matching_claim(
        registry: &mut WorktreeRegistry,
        worktree_id: &str,
        claimed_by: Option<&str>,
    ) -> bool {
        let Some(claim) = claimed_by else {
            return false;
        };
        let Some(record) = registry
            .worktrees
            .iter_mut()
            .find(|record| record.worktree_id == worktree_id)
        else {
            return false;
        };
        if record.claimed_by.as_deref() != Some(claim) {
            return false;
        }
        record.claimed_by = None;
        true
    }

    async fn mutation_result_for_id(
        context: &RepositoryContext,
        registry: &mut WorktreeRegistry,
        worktree_id: &str,
    ) -> Result<WorktreeMutationResult, WorktreeError> {
        let (summaries, changed) = Self::reconcile(context, registry).await?;
        if changed {
            Self::save_registry(context, registry).await?;
        }
        let worktree = summaries
            .into_iter()
            .find(|summary| summary.worktree_id == worktree_id)
            .ok_or_else(|| {
                error(
                    WorktreeErrorCode::WorktreeNotFound,
                    "Worktree could not be reconciled",
                )
            })?;
        Ok(WorktreeMutationResult { worktree })
    }

    async fn rollback_new_worktree(
        context: &RepositoryContext,
        target_path: &Path,
        original_error: WorktreeError,
    ) -> WorktreeError {
        match GitService::remove_worktree(
            &context.project_workspace_path,
            &path_string(target_path),
            true,
        )
        .await
        {
            Ok(_) => original_error,
            Err(rollback_error) => WorktreeError {
                code: WorktreeErrorCode::RollbackIncomplete,
                message: format!(
                    "{}; automatic rollback also failed: {}",
                    original_error.message, rollback_error
                ),
                recovery_path: Some(path_string(target_path)),
            },
        }
    }

    async fn rollback_new_worktree_with_workspace(
        context: &RepositoryContext,
        target_path: &Path,
        workspace_id: Option<&str>,
        original_error: WorktreeError,
    ) -> WorktreeError {
        let mut rollback_issues = Vec::new();
        if let (Some(workspace_service), Some(workspace_id)) =
            (get_global_workspace_service(), workspace_id)
        {
            if let Err(remove_error) = workspace_service.remove_workspace(workspace_id).await {
                rollback_issues.push(format!(
                    "workspace registration could not be removed: {remove_error}"
                ));
            }
        }
        let git_rollback =
            Self::rollback_new_worktree(context, target_path, original_error.clone()).await;
        if git_rollback.code == WorktreeErrorCode::RollbackIncomplete {
            rollback_issues.push(git_rollback.message);
        }
        if rollback_issues.is_empty() {
            original_error
        } else {
            WorktreeError {
                code: WorktreeErrorCode::RollbackIncomplete,
                message: format!(
                    "{}; automatic rollback did not complete: {}",
                    original_error.message,
                    rollback_issues.join("; ")
                ),
                recovery_path: Some(path_string(target_path)),
            }
        }
    }

    async fn auto_delete_old_worktrees(
        context: &RepositoryContext,
        registry: &mut WorktreeRegistry,
        protected_worktree_id: &str,
    ) -> Result<usize, WorktreeError> {
        if !context.settings.auto_delete_enabled {
            return Ok(0);
        }

        let candidate_ids = automatic_delete_candidate_ids(
            registry,
            context.settings.auto_delete_limit.max(1),
            protected_worktree_id,
            current_unix_ms(),
        );
        if candidate_ids.is_empty() {
            return Ok(0);
        }

        let (summaries, reconciled) = Self::reconcile(context, registry).await?;
        let summaries_by_id = summaries
            .into_iter()
            .map(|summary| (summary.worktree_id.clone(), summary))
            .collect::<HashMap<_, _>>();
        let mut changed = reconciled;
        let mut removed_count = 0;

        for candidate_id in candidate_ids {
            let Some(summary) = summaries_by_id.get(&candidate_id) else {
                continue;
            };
            if let Err(protected_reason) = validate_automatic_removal(summary) {
                log::debug!(
                    "Skipping automatic worktree deletion for {}: {}",
                    summary.path,
                    protected_reason
                );
                continue;
            }

            if let Err(remove_error) =
                GitService::remove_worktree(&context.project_workspace_path, &summary.path, false)
                    .await
            {
                log::warn!(
                    "Failed to automatically remove worktree {}: {}",
                    summary.path,
                    remove_error
                );
                continue;
            }

            if let Some(workspace_service) = get_global_workspace_service() {
                if let Some(workspace_id) = summary.workspace_id.as_deref() {
                    if let Err(workspace_error) =
                        workspace_service.remove_workspace(workspace_id).await
                    {
                        log::warn!(
                            "Automatically removed worktree {}, but its workspace registration could not be removed: {}",
                            summary.path,
                            workspace_error
                        );
                    }
                }
            }

            registry
                .worktrees
                .retain(|record| record.worktree_id != candidate_id);
            registry
                .receipts
                .retain(|_, receipt| receipt.worktree_id() != candidate_id);
            removed_count += 1;
            changed = true;
        }

        if changed {
            Self::save_registry(context, registry).await?;
        }
        Ok(removed_count)
    }
}

/// Known local Git projects, keyed by main worktree path, paired with the ID
/// of the open workspace whose root is that main worktree when one exists.
async fn known_project_workspace_paths() -> Vec<(PathBuf, Option<String>)> {
    let Some(workspace_service) = get_global_workspace_service() else {
        return Vec::new();
    };
    let workspaces = workspace_service.list_workspaces().await;
    let mut projects = HashMap::<String, (PathBuf, Option<String>)>::new();

    for workspace in workspaces {
        if workspace.workspace_kind != WorkspaceKind::Normal || !workspace.root_path.is_dir() {
            continue;
        }
        let Ok(worktrees) = GitService::list_worktrees(&workspace.root_path).await else {
            continue;
        };
        let Some(main_worktree) = worktrees.into_iter().find(|worktree| worktree.is_main) else {
            continue;
        };
        let main_path = PathBuf::from(main_worktree.path);
        let main_key = normalized_lookup_path(&main_path);
        let owns_main = normalized_lookup_path(&workspace.root_path) == main_key;
        let entry = projects
            .entry(main_key)
            .or_insert_with(|| (main_path, None));
        if owns_main && entry.1.is_none() {
            entry.1 = Some(workspace.id.clone());
        }
    }

    let mut paths = projects.into_values().collect::<Vec<_>>();
    paths.sort_by_key(|(path, _)| path_string(path));
    paths
}

fn automatic_delete_candidate_ids(
    registry: &WorktreeRegistry,
    limit: usize,
    protected_worktree_id: &str,
    now_ms: u64,
) -> Vec<String> {
    let mut managed = registry
        .worktrees
        .iter()
        .filter(|record| record.lifecycle == WorktreeLifecycle::Managed)
        .collect::<Vec<_>>();
    managed.sort_by(|left, right| {
        right
            .created_at_ms
            .cmp(&left.created_at_ms)
            .then_with(|| right.worktree_id.cmp(&left.worktree_id))
    });

    managed
        .into_iter()
        .skip(limit.max(1))
        .filter(|record| record.worktree_id != protected_worktree_id)
        .filter(|record| record.claimed_by.is_none())
        .filter(|record| now_ms.saturating_sub(record.created_at_ms) >= AUTO_DELETE_MIN_AGE_MS)
        .map(|record| record.worktree_id.clone())
        .collect()
}

async fn notify_changed(project_workspace_path: &Path) {
    if let Some(workspace_service) = get_global_workspace_service() {
        workspace_service
            .invalidate_worktree_topology(project_workspace_path)
            .await;
    }
    if let Err(event_error) = emit_global_event(BackendEvent::Custom {
        event_name: "worktree://changed".to_string(),
        payload: serde_json::json!({
            "projectWorkspacePath": path_string(project_workspace_path),
        }),
    })
    .await
    {
        log::warn!("Failed to emit worktree change event: {event_error}");
    }
}

async fn build_summary(
    context: &RepositoryContext,
    worktree_id: &str,
    lifecycle: WorktreeLifecycle,
    git_worktree: GitWorktreeInfo,
    missing: bool,
    sessions: &[SessionMetadata],
) -> Result<WorktreeSummary, WorktreeError> {
    let associated = sessions
        .iter()
        .filter(|metadata| {
            metadata
                .execution_target
                .as_ref()
                .and_then(|target| target.worktree_id.as_deref())
                == Some(worktree_id)
                || metadata.workspace_path.as_deref() == Some(git_worktree.path.as_str())
        })
        .collect::<Vec<_>>();
    let session_summaries = associated
        .iter()
        .map(|metadata| WorktreeSessionSummary {
            workspace_id: metadata
                .project_workspace_id
                .clone()
                .or_else(|| metadata.workspace_id.clone()),
            session_id: metadata.session_id.clone(),
            session_name: metadata.session_name.clone(),
            status: session_status_name(&metadata.status).to_string(),
            archived: matches!(metadata.status, SessionStatus::Archived),
        })
        .collect::<Vec<_>>();
    let running_session_count = associated
        .iter()
        .filter(|metadata| !matches!(metadata.status, SessionStatus::Archived))
        .count();
    let (dirty, unpublished) = if missing {
        (false, false)
    } else {
        (
            GitService::worktree_is_dirty(&git_worktree.path)
                .await
                .map_err(map_git_error)?,
            if git_worktree.branch.is_none() {
                GitService::worktree_has_unpublished_commits(&git_worktree.path)
                    .await
                    .map_err(map_git_error)?
            } else {
                false
            },
        )
    };
    Ok(WorktreeSummary {
        workspace_id: None,
        worktree_id: worktree_id.to_string(),
        project_workspace_path: path_string(&context.project_workspace_path),
        path: git_worktree.path,
        head: git_worktree.head,
        branch: git_worktree.branch,
        lifecycle,
        is_main: git_worktree.is_main,
        dirty,
        locked: git_worktree.is_locked,
        missing,
        has_unpublished_commits: unpublished,
        associated_session_count: session_summaries.len(),
        running_session_count,
        sessions: session_summaries,
    })
}

async fn load_project_sessions(
    project_workspace_path: &Path,
) -> Result<Vec<SessionMetadata>, WorktreeError> {
    let context =
        get_workspace_runtime_service_arc().context_for_local_workspace(project_workspace_path);
    SessionMetadataStore::new(context.sessions_dir)
        .list_metadata_including_internal()
        .await
        .map_err(|session_error| {
            error(
                WorktreeErrorCode::IoFailed,
                format!("Failed to read project sessions: {session_error}"),
            )
        })
}

async fn load_settings() -> WorktreeSettings {
    match GlobalConfigManager::get_service().await {
        Ok(config_service) => config_service
            .get_config::<WorktreeSettings>(Some("app.worktrees"))
            .await
            .unwrap_or_default(),
        Err(_) => WorktreeSettings::default(),
    }
}

fn resolve_managed_root(
    settings: &WorktreeSettings,
    path_manager: &PathManager,
) -> Result<PathBuf, WorktreeError> {
    let configured = settings.root_path.trim();
    let portable_configured = configured.replace('\\', "/");
    let default_root = format!("~/{}/worktrees", hidden_data_directory());
    if portable_configured.is_empty() || portable_configured == default_root {
        return Ok(path_manager.worktrees_root());
    }
    if portable_configured == "~" {
        return dirs::home_dir().ok_or_else(|| {
            error(
                WorktreeErrorCode::InvalidPath,
                "Unable to resolve the configured home directory",
            )
        });
    }
    if let Some(suffix) = portable_configured.strip_prefix("~/") {
        return dirs::home_dir()
            .map(|home| home.join(suffix))
            .ok_or_else(|| {
                error(
                    WorktreeErrorCode::InvalidPath,
                    "Unable to resolve the configured home directory",
                )
            });
    }
    let path = PathBuf::from(configured);
    if !path.is_absolute() {
        return Err(error(
            WorktreeErrorCode::InvalidPath,
            "Worktree root must be an absolute path or start with ~/ (or ~\\ on Windows)",
        ));
    }
    Ok(path)
}

async fn managed_target_path(
    settings: &WorktreeSettings,
    repository_id: &str,
    project_workspace_path: &Path,
    worktree_id: &str,
) -> Result<PathBuf, WorktreeError> {
    let configured_root = resolve_managed_root(settings, get_path_manager_arc().as_ref())?;
    tokio::fs::create_dir_all(&configured_root)
        .await
        .map_err(|io_error| {
            error(
                WorktreeErrorCode::IoFailed,
                format!("Failed to create the managed worktree root: {io_error}"),
            )
        })?;
    let canonical_root = tokio::fs::canonicalize(&configured_root)
        .await
        .map_err(|io_error| {
            error(
                WorktreeErrorCode::IoFailed,
                format!("Failed to resolve the managed worktree root: {io_error}"),
            )
        })?;
    // `std::fs::canonicalize` (and Tokio's wrapper) returns a verbatim
    // `\\?\C:\...` path on Windows. Git for Windows does not accept that form
    // as a `worktree add` target after the Git adapter normalizes separators,
    // because it becomes `//?/C:/...`. Keep the resolved path used for the
    // containment checks, but prefer the ordinary drive-letter representation
    // whenever it can address the same path.
    let canonical_root = dunce::simplified(&canonical_root).to_path_buf();
    let repository_root = canonical_root.join(repository_id);
    match tokio::fs::symlink_metadata(&repository_root).await {
        Ok(metadata) if metadata.file_type().is_symlink() || !metadata.is_dir() => {
            return Err(error(
                WorktreeErrorCode::InvalidPath,
                "Managed repository worktree root must be a regular directory",
            ));
        }
        Ok(_) => {}
        Err(io_error) if io_error.kind() == std::io::ErrorKind::NotFound => {
            tokio::fs::create_dir(&repository_root)
                .await
                .map_err(|create_error| {
                    error(
                        WorktreeErrorCode::IoFailed,
                        format!("Failed to create the repository worktree root: {create_error}"),
                    )
                })?;
        }
        Err(io_error) => {
            return Err(error(
                WorktreeErrorCode::IoFailed,
                format!("Failed to inspect the repository worktree root: {io_error}"),
            ));
        }
    }
    let canonical_repository_root =
        tokio::fs::canonicalize(&repository_root)
            .await
            .map_err(|io_error| {
                error(
                    WorktreeErrorCode::IoFailed,
                    format!("Failed to resolve the repository worktree root: {io_error}"),
                )
            })?;
    let canonical_repository_root = dunce::simplified(&canonical_repository_root).to_path_buf();
    if !canonical_repository_root.starts_with(&canonical_root) {
        return Err(error(
            WorktreeErrorCode::InvalidPath,
            "Managed repository worktree root escapes the configured root",
        ));
    }
    let target_path = canonical_repository_root.join(managed_worktree_directory_name(
        project_workspace_path,
        worktree_id,
    ));
    match tokio::fs::symlink_metadata(&target_path).await {
        Ok(_) => Err(error(
            WorktreeErrorCode::InvalidPath,
            "Managed worktree target already exists",
        )),
        Err(io_error) if io_error.kind() == std::io::ErrorKind::NotFound => Ok(target_path),
        Err(io_error) => Err(error(
            WorktreeErrorCode::IoFailed,
            format!("Failed to inspect the managed worktree target: {io_error}"),
        )),
    }
}

fn managed_worktree_directory_name(project_workspace_path: &Path, worktree_id: &str) -> String {
    let project_name = project_workspace_path
        .file_name()
        .map(|name| name.to_string_lossy())
        .filter(|name| !name.is_empty())
        .unwrap_or_else(|| "workspace".into());
    let project_label = sanitize_worktree_project_label(&project_name);
    let direct_suffix = worktree_id
        .chars()
        .take(WORKTREE_DIRECTORY_SUFFIX_LENGTH)
        .collect::<String>();
    let suffix = if direct_suffix.chars().count() == WORKTREE_DIRECTORY_SUFFIX_LENGTH
        && direct_suffix
            .chars()
            .all(|character| character.is_ascii_alphanumeric())
    {
        direct_suffix.to_ascii_lowercase()
    } else {
        short_hash(worktree_id)
            .chars()
            .take(WORKTREE_DIRECTORY_SUFFIX_LENGTH)
            .collect()
    };
    format!("{project_label}-{suffix}")
}

fn sanitize_worktree_project_label(project_name: &str) -> String {
    let mut sanitized = String::new();
    let mut previous_was_separator = false;
    for character in project_name.trim().chars() {
        let invalid = character.is_control()
            || matches!(
                character,
                '<' | '>' | '"' | ':' | '/' | '\\' | '|' | '?' | '*'
            );
        if invalid {
            if !sanitized.is_empty() && !previous_was_separator {
                sanitized.push('-');
            }
            previous_was_separator = true;
        } else {
            sanitized.push(character);
            previous_was_separator = false;
        }
    }

    let truncated = sanitized
        .chars()
        .take(WORKTREE_PROJECT_LABEL_MAX_CHARS)
        .collect::<String>();
    let mut label = truncated
        .trim_matches(|character| matches!(character, ' ' | '.' | '-'))
        .to_string();
    if label.is_empty() {
        label = "workspace".to_string();
    }
    if is_windows_reserved_path_component(&label) {
        label.insert(0, '_');
    }
    label
}

fn is_windows_reserved_path_component(component: &str) -> bool {
    let stem = component
        .split('.')
        .next()
        .unwrap_or_default()
        .to_ascii_uppercase();
    matches!(
        stem.as_str(),
        "CON"
            | "PRN"
            | "AUX"
            | "NUL"
            | "COM1"
            | "COM2"
            | "COM3"
            | "COM4"
            | "COM5"
            | "COM6"
            | "COM7"
            | "COM8"
            | "COM9"
            | "LPT1"
            | "LPT2"
            | "LPT3"
            | "LPT4"
            | "LPT5"
            | "LPT6"
            | "LPT7"
            | "LPT8"
            | "LPT9"
    )
}

fn repository_lock(common_git_dir: &Path) -> Arc<AsyncMutex<()>> {
    let locks = REPOSITORY_LOCKS.get_or_init(|| Mutex::new(HashMap::new()));
    let mut locks = locks.lock().expect("worktree repository lock map poisoned");
    locks
        .entry(common_git_dir.to_path_buf())
        .or_insert_with(|| Arc::new(AsyncMutex::new(())))
        .clone()
}

fn repository_id(common_git_dir: &Path) -> String {
    short_hash(&path_string(common_git_dir))
}

fn short_hash(value: &str) -> String {
    let digest = Sha256::digest(value.as_bytes());
    hex::encode(digest)[..16].to_string()
}

fn normalized_lookup_path(path: &Path) -> String {
    let path = std::fs::canonicalize(path).unwrap_or_else(|_| path.to_path_buf());
    path_string(&path)
}

fn path_is_within_root(path: &Path, root: &Path) -> bool {
    let normalized_path = std::fs::canonicalize(path).unwrap_or_else(|_| path.to_path_buf());
    let normalized_root = std::fs::canonicalize(root).unwrap_or_else(|_| root.to_path_buf());
    normalized_path != normalized_root && normalized_path.starts_with(normalized_root)
}

fn path_string(path: &Path) -> String {
    path.to_string_lossy().replace('\\', "/")
}

fn current_unix_ms() -> u64 {
    std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .unwrap_or_default()
        .as_millis() as u64
}

fn session_status_name(status: &SessionStatus) -> &'static str {
    match status {
        SessionStatus::Active => "active",
        SessionStatus::Archived => "archived",
        SessionStatus::Completed => "completed",
    }
}

fn validate_request_id(request_id: &str) -> Result<(), WorktreeError> {
    if request_id.trim().is_empty() || request_id.len() > 200 {
        return Err(error(
            WorktreeErrorCode::RequestConflict,
            "requestId must be between 1 and 200 bytes",
        ));
    }
    Ok(())
}

fn error(code: WorktreeErrorCode, message: impl Into<String>) -> WorktreeError {
    WorktreeError {
        code,
        message: message.into(),
        recovery_path: None,
    }
}

fn validate_removal(summary: &WorktreeSummary, force: bool) -> Result<(), WorktreeError> {
    if summary.is_main {
        return Err(error(
            WorktreeErrorCode::InvalidPath,
            "The main worktree cannot be removed",
        ));
    }
    if summary.locked {
        return Err(error(
            WorktreeErrorCode::WorktreeLocked,
            "The worktree is locked by Git",
        ));
    }
    if !force && summary.dirty {
        return Err(error(
            WorktreeErrorCode::DirtyWorktree,
            "The worktree contains local changes",
        ));
    }
    if !force && summary.has_unpublished_commits {
        return Err(error(
            WorktreeErrorCode::UnpublishedCommits,
            "Detached HEAD contains commits that are not reachable from any ref",
        ));
    }
    if summary.missing {
        return Err(error(
            WorktreeErrorCode::WorktreeNotFound,
            "The worktree directory is missing; recreate it or remove the stale Git record manually",
        ));
    }
    Ok(())
}

fn validate_automatic_removal(summary: &WorktreeSummary) -> Result<(), WorktreeError> {
    if summary.associated_session_count > 0 {
        return Err(error(
            WorktreeErrorCode::WorktreeBusy,
            "The worktree has associated sessions",
        ));
    }
    validate_removal(summary, false)
}

fn map_base_ref_error(git_error: GitError, base_ref: &str) -> WorktreeError {
    // A walled repository fails revision resolution the same way a typo does,
    // and blaming the base ref sends the user hunting for a branch that is
    // perfectly fine.
    if matches!(git_error, GitError::RepositoryUntrusted { .. }) {
        return map_git_error(git_error);
    }

    let text = git_error.to_string();
    if text.to_ascii_lowercase().contains("unborn")
        || text.contains("reference 'HEAD' not found")
        || text.contains("needed a single revision")
    {
        error(
            WorktreeErrorCode::UnbornRepo,
            "The repository has no initial commit",
        )
    } else {
        error(
            WorktreeErrorCode::InvalidBaseRef,
            format!("Failed to resolve base ref '{base_ref}': {text}"),
        )
    }
}

fn map_branch_error(git_error: GitError) -> WorktreeError {
    let text = git_error.to_string();
    if text.contains("already exists") {
        error(WorktreeErrorCode::BranchExists, text)
    } else {
        map_git_error(git_error)
    }
}

fn map_copy_error(git_error: GitError) -> WorktreeError {
    error(WorktreeErrorCode::CopyConflict, git_error.to_string())
}

fn map_git_error(git_error: GitError) -> WorktreeError {
    match git_error {
        GitError::RepositoryNotFound(message) => {
            error(WorktreeErrorCode::NotGitRepository, message)
        }
        // An ownership rejection is the one Git failure the user can clear
        // themselves, so it must not disappear into `GitFailed`: a session bound
        // to a managed worktree would report "Git command failed" for a
        // repository that is present, intact, and one command away from working.
        GitError::RepositoryUntrusted {
            repository_path, ..
        } => {
            let remedy = crate::service::git::trust::manual_trust_command(&repository_path);
            error(
                WorktreeErrorCode::RepositoryUntrusted,
                format!(
                    "Git refuses '{repository_path}': the repository is owned by another user. \
                     Run `{remedy}` and try again"
                ),
            )
        }
        GitError::InvalidPath(message) => error(WorktreeErrorCode::InvalidPath, message),
        GitError::IoError(io_error) => error(WorktreeErrorCode::IoFailed, io_error.to_string()),
        other => {
            let message = other.to_string();
            if message.to_ascii_lowercase().contains("unborn") || message.contains("initial commit")
            {
                error(WorktreeErrorCode::UnbornRepo, message)
            } else {
                error(WorktreeErrorCode::GitFailed, message)
            }
        }
    }
}

#[cfg(test)]
mod tests {
    use super::{
        automatic_delete_candidate_ids, managed_target_path, managed_worktree_directory_name,
        map_base_ref_error, map_branch_error, map_git_error, path_is_within_root, repository_id,
        resolve_managed_root, sanitize_worktree_project_label, validate_automatic_removal,
        validate_removal, RegisteredWorktree, RepositoryContext, WorktreeOperationReceipt,
        WorktreeRegistry, WorktreeService, AUTO_DELETE_MIN_AGE_MS,
    };
    use crate::infrastructure::PathManager;
    use crate::service::git::GitError;
    use openbitfun_core_types::{
        WorktreeErrorCode, WorktreeLifecycle, WorktreeSettings, WorktreeSummary,
    };
    use std::path::Path;

    fn removable_summary() -> WorktreeSummary {
        WorktreeSummary {
            workspace_id: None,
            worktree_id: "wt-1".to_string(),
            project_workspace_path: "/repo".to_string(),
            path: "/worktrees/wt-1".to_string(),
            head: "0123456789abcdef".to_string(),
            branch: None,
            lifecycle: WorktreeLifecycle::Managed,
            is_main: false,
            dirty: false,
            locked: false,
            missing: false,
            has_unpublished_commits: false,
            associated_session_count: 0,
            running_session_count: 0,
            sessions: Vec::new(),
        }
    }

    /// A worktree is how a Review session gets its own checkout, so this is the
    /// first place the ownership wall is met on that path. Folded into
    /// `GitFailed` it reads as "Git command failed" — a dead end for a
    /// repository the user can trust in one command.
    #[test]
    fn an_ownership_rejection_keeps_its_own_code_and_the_command_that_clears_it() {
        let mapped = map_git_error(GitError::RepositoryUntrusted {
            repository_path: "/srv/shared/repo".to_string(),
            detail: "detected dubious ownership".to_string(),
        });
        assert_eq!(mapped.code, WorktreeErrorCode::RepositoryUntrusted);
        assert!(
            mapped
                .message
                .contains("git config --global --add safe.directory /srv/shared/repo"),
            "the remedy has to travel with the refusal: {}",
            mapped.message
        );

        // Branch creation and base-ref resolution reach the same wall through
        // their own mappers. `InvalidBaseRef` would be an accusation against a
        // branch that is fine.
        let branch = map_branch_error(GitError::RepositoryUntrusted {
            repository_path: "/srv/shared/repo".to_string(),
            detail: "detected dubious ownership".to_string(),
        });
        assert_eq!(branch.code, WorktreeErrorCode::RepositoryUntrusted);

        let base_ref = map_base_ref_error(
            GitError::RepositoryUntrusted {
                repository_path: "/srv/shared/repo".to_string(),
                detail: "detected dubious ownership".to_string(),
            },
            "main",
        );
        assert_eq!(base_ref.code, WorktreeErrorCode::RepositoryUntrusted);
    }

    #[test]
    fn repository_ids_are_stable_and_path_sensitive() {
        assert_eq!(repository_id(Path::new("/repo/.git")).len(), 16);
        assert_eq!(
            repository_id(Path::new("/repo/.git")),
            repository_id(Path::new("/repo/.git"))
        );
        assert_ne!(
            repository_id(Path::new("/repo/.git")),
            repository_id(Path::new("/other/.git"))
        );
    }

    #[test]
    fn managed_directory_name_includes_project_name_and_short_worktree_id() {
        let project = Path::new("projects").join("OpenBitFun");

        assert_eq!(
            managed_worktree_directory_name(&project, "48e8b457e87649aebf801b408698f46c"),
            "OpenBitFun-48e8b457"
        );
    }

    #[test]
    fn managed_directory_names_are_distinct_for_different_worktrees() {
        let project = Path::new("projects").join("OpenBitFun");

        assert_ne!(
            managed_worktree_directory_name(&project, "48e8b457e87649aebf801b408698f46c"),
            managed_worktree_directory_name(&project, "59e9a2e3c01248d9bb187d295a2c4f35")
        );
    }

    #[tokio::test]
    async fn managed_target_path_uses_readable_leaf_and_rejects_collisions() {
        let root = tempfile::tempdir().expect("temp root");
        let worktree_root = root.path().join("managed-worktrees");
        let project = root.path().join("projects").join("OpenBitFun");
        let settings = WorktreeSettings {
            root_path: worktree_root.to_string_lossy().to_string(),
            ..WorktreeSettings::default()
        };
        let worktree_id = "48e8b457e87649aebf801b408698f46c";

        let target = managed_target_path(&settings, "repository-id", &project, worktree_id)
            .await
            .expect("managed target path");
        assert_eq!(
            target.file_name().and_then(|name| name.to_str()),
            Some("OpenBitFun-48e8b457")
        );
        assert_eq!(
            target
                .parent()
                .and_then(Path::file_name)
                .and_then(|name| name.to_str()),
            Some("repository-id")
        );

        std::fs::create_dir(&target).expect("occupy managed target");
        let collision = managed_target_path(&settings, "repository-id", &project, worktree_id)
            .await
            .expect_err("existing target must be rejected");
        assert_eq!(collision.code, WorktreeErrorCode::InvalidPath);
    }

    #[cfg(windows)]
    #[tokio::test]
    async fn managed_target_path_is_compatible_with_git_for_windows() {
        let root = tempfile::tempdir().expect("temp root");
        let settings = WorktreeSettings {
            root_path: root.path().join("managed-worktrees").display().to_string(),
            ..WorktreeSettings::default()
        };

        let target = managed_target_path(
            &settings,
            "repository-id",
            &root.path().join("projects/OpenBitFun"),
            "48e8b457e87649aebf801b408698f46c",
        )
        .await
        .expect("managed target path");
        let git_argument = target.to_string_lossy().replace('\\', "/");

        assert!(
            !git_argument.starts_with("//?/"),
            "managed worktree targets passed to Git must not use a Windows verbatim path: {}",
            target.display()
        );
    }

    #[test]
    fn managed_directory_name_falls_back_for_paths_without_a_project_name() {
        assert!(managed_worktree_directory_name(
            Path::new("/"),
            "48e8b457e87649aebf801b408698f46c"
        )
        .starts_with("workspace-"));
    }

    #[test]
    fn worktree_project_labels_are_portable_across_supported_platforms() {
        assert_eq!(
            sanitize_worktree_project_label("  project: alpha?*  "),
            "project- alpha"
        );
        assert_eq!(sanitize_worktree_project_label("CON.txt"), "_CON.txt");
        assert_eq!(
            sanitize_worktree_project_label("项目 workspace"),
            "项目 workspace"
        );
        assert_eq!(sanitize_worktree_project_label("..."), "workspace");
    }

    #[test]
    fn worktree_project_labels_have_a_bounded_component_length() {
        let label = sanitize_worktree_project_label(&"项目".repeat(64));

        assert_eq!(label.chars().count(), 48);
    }

    #[test]
    fn relative_custom_roots_are_rejected() {
        let path_manager = PathManager::new().expect("path manager");
        let settings = WorktreeSettings {
            root_path: "relative/worktrees".to_string(),
            ..WorktreeSettings::default()
        };
        assert!(resolve_managed_root(&settings, &path_manager).is_err());
    }

    #[test]
    fn windows_style_default_root_uses_the_managed_path_contract() {
        let user_root = std::env::temp_dir().join("openbitfun-worktree-root-test");
        let path_manager = PathManager::with_user_root_for_tests(user_root);
        let settings = WorktreeSettings {
            root_path: r"~\.openbitfun\worktrees".to_string(),
            ..WorktreeSettings::default()
        };

        assert_eq!(
            resolve_managed_root(&settings, &path_manager).unwrap(),
            path_manager.worktrees_root()
        );
    }

    #[test]
    fn request_ids_map_to_stable_session_ids() {
        let first = WorktreeService::session_id_for_request("request-123").unwrap();
        let replay = WorktreeService::session_id_for_request("request-123").unwrap();
        let other = WorktreeService::session_id_for_request("request-456").unwrap();
        assert_eq!(first, replay);
        assert_ne!(first, other);
        assert!(first.starts_with("worktree-session-"));
    }

    #[test]
    fn catalog_scope_only_accepts_descendants_of_the_configured_root() {
        let root = tempfile::tempdir().expect("worktree root");
        let managed = root.path().join("repository-id").join("worktree-id");
        std::fs::create_dir_all(&managed).expect("managed worktree");
        let sibling = root
            .path()
            .parent()
            .expect("temporary root parent")
            .join("other-worktrees")
            .join("worktree-id");

        assert!(path_is_within_root(&managed, root.path()));
        assert!(!path_is_within_root(root.path(), root.path()));
        assert!(!path_is_within_root(&sibling, root.path()));
    }

    #[test]
    fn safe_removal_rejects_every_protected_state() {
        let mut summary = removable_summary();
        summary.is_main = true;
        assert_eq!(
            validate_removal(&summary, false).unwrap_err().code,
            WorktreeErrorCode::InvalidPath
        );

        let mut summary = removable_summary();
        summary.locked = true;
        assert_eq!(
            validate_removal(&summary, true).unwrap_err().code,
            WorktreeErrorCode::WorktreeLocked
        );

        let mut summary = removable_summary();
        summary.dirty = true;
        assert_eq!(
            validate_removal(&summary, false).unwrap_err().code,
            WorktreeErrorCode::DirtyWorktree
        );

        let mut summary = removable_summary();
        summary.has_unpublished_commits = true;
        assert_eq!(
            validate_removal(&summary, false).unwrap_err().code,
            WorktreeErrorCode::UnpublishedCommits
        );

        let mut summary = removable_summary();
        summary.missing = true;
        assert_eq!(
            validate_removal(&summary, true).unwrap_err().code,
            WorktreeErrorCode::WorktreeNotFound
        );
    }

    #[test]
    fn force_only_bypasses_discardable_local_work() {
        let mut summary = removable_summary();
        summary.dirty = true;
        summary.has_unpublished_commits = true;
        assert!(validate_removal(&summary, true).is_ok());
    }

    #[test]
    fn manual_removal_allows_associated_sessions_but_automatic_cleanup_does_not() {
        let mut summary = removable_summary();
        summary.associated_session_count = 1;

        assert!(validate_removal(&summary, false).is_ok());
        assert_eq!(
            validate_automatic_removal(&summary).unwrap_err().code,
            WorktreeErrorCode::WorktreeBusy
        );
    }

    #[test]
    fn automatic_cleanup_only_selects_managed_worktrees_older_than_the_limit() {
        let project = Path::new("/repo");
        let mut registry = WorktreeRegistry::new(project);
        for (worktree_id, lifecycle, created_at_ms) in [
            ("oldest", WorktreeLifecycle::Managed, 10),
            ("older", WorktreeLifecycle::Managed, 20),
            ("newer", WorktreeLifecycle::Managed, 30),
            ("newest", WorktreeLifecycle::Managed, 40),
            ("permanent", WorktreeLifecycle::Permanent, 1),
            ("external", WorktreeLifecycle::External, 2),
        ] {
            registry.worktrees.push(RegisteredWorktree {
                workspace_id: None,
                worktree_id: worktree_id.to_string(),
                path: format!("/worktrees/{worktree_id}"),
                base_ref: Some("main".to_string()),
                base_commit: "0123456789abcdef".to_string(),
                branch: None,
                lifecycle,
                created_at_ms,
                claimed_by: None,
            });
        }

        assert_eq!(
            automatic_delete_candidate_ids(&registry, 2, "newest", AUTO_DELETE_MIN_AGE_MS + 100,),
            vec!["older".to_string(), "oldest".to_string()]
        );
    }

    #[test]
    fn automatic_cleanup_never_selects_a_claimed_worktree() {
        let project = Path::new("/repo");
        let mut registry = WorktreeRegistry::new(project);
        for (worktree_id, created_at_ms, claimed_by) in [
            ("newest", 30, None),
            ("unclaimed", 20, None),
            ("claimed", 10, Some("dispatch:job-1")),
        ] {
            registry.worktrees.push(RegisteredWorktree {
                workspace_id: None,
                worktree_id: worktree_id.to_string(),
                path: format!("/worktrees/{worktree_id}"),
                base_ref: Some("main".to_string()),
                base_commit: "0123456789abcdef".to_string(),
                branch: None,
                lifecycle: WorktreeLifecycle::Managed,
                created_at_ms,
                claimed_by: claimed_by.map(ToOwned::to_owned),
            });
        }

        // A dispatch baseline is clean, session-less, and older than the grace
        // period, so only the claim keeps it alive.
        assert_eq!(
            automatic_delete_candidate_ids(&registry, 1, "newest", AUTO_DELETE_MIN_AGE_MS + 100,),
            vec!["unclaimed".to_string()]
        );
    }

    #[test]
    fn automatic_cleanup_never_selects_the_newly_created_worktree() {
        let project = Path::new("/repo");
        let mut registry = WorktreeRegistry::new(project);
        for worktree_id in ["new", "old"] {
            registry.worktrees.push(RegisteredWorktree {
                workspace_id: None,
                worktree_id: worktree_id.to_string(),
                path: format!("/worktrees/{worktree_id}"),
                base_ref: Some("main".to_string()),
                base_commit: "0123456789abcdef".to_string(),
                branch: None,
                lifecycle: WorktreeLifecycle::Managed,
                created_at_ms: 10,
                claimed_by: None,
            });
        }

        assert_eq!(
            automatic_delete_candidate_ids(&registry, 1, "new", AUTO_DELETE_MIN_AGE_MS + 100,),
            Vec::<String>::new()
        );
    }

    #[test]
    fn automatic_cleanup_gives_new_worktrees_a_binding_grace_period() {
        let project = Path::new("/repo");
        let mut registry = WorktreeRegistry::new(project);
        for (worktree_id, created_at_ms) in [("newest", 100), ("recent", 90)] {
            registry.worktrees.push(RegisteredWorktree {
                workspace_id: None,
                worktree_id: worktree_id.to_string(),
                path: format!("/worktrees/{worktree_id}"),
                base_ref: Some("main".to_string()),
                base_commit: "0123456789abcdef".to_string(),
                branch: None,
                lifecycle: WorktreeLifecycle::Managed,
                created_at_ms,
                claimed_by: None,
            });
        }

        assert!(
            automatic_delete_candidate_ids(&registry, 1, "newest", AUTO_DELETE_MIN_AGE_MS,)
                .is_empty()
        );
    }

    #[tokio::test]
    async fn registry_round_trip_restores_binding_and_idempotency_receipt() {
        let root = tempfile::tempdir().expect("temp root");
        let project = root.path().join("repo");
        let common_git_dir = project.join(".git");
        std::fs::create_dir_all(&common_git_dir).expect("repository dirs");
        let context = RepositoryContext {
            project_workspace_path: project.clone(),
            common_git_dir,
            registry_path: root.path().join("runtime/worktrees.json"),
            settings: WorktreeSettings::default(),
        };
        let mut registry = WorktreeRegistry::new(&project);
        registry.worktrees.push(RegisteredWorktree {
            workspace_id: None,
            worktree_id: "wt-restored".to_string(),
            path: "/managed/wt-restored".to_string(),
            base_ref: Some("main".to_string()),
            base_commit: "0123456789abcdef".to_string(),
            branch: None,
            lifecycle: WorktreeLifecycle::Managed,
            created_at_ms: 123,
            claimed_by: Some("dispatch:job-restored".to_string()),
        });
        registry.receipts.insert(
            "request-restored".to_string(),
            WorktreeOperationReceipt::Create {
                worktree_id: "wt-restored".to_string(),
                source_workspace_path: project.to_string_lossy().to_string(),
                base_ref: "main".to_string(),
                copy_local_changes: false,
                claimed_by: Some("dispatch:job-restored".to_string()),
            },
        );

        WorktreeService::save_registry(&context, &registry)
            .await
            .expect("save registry");
        let restored = WorktreeService::load_registry(&context)
            .await
            .expect("load registry");

        assert_eq!(restored.worktrees.len(), 1);
        assert_eq!(restored.worktrees[0].worktree_id, "wt-restored");
        assert_eq!(
            restored.worktrees[0].claimed_by.as_deref(),
            Some("dispatch:job-restored")
        );
        assert_eq!(
            restored
                .receipts
                .get("request-restored")
                .expect("receipt")
                .worktree_id(),
            "wt-restored"
        );
        match restored.receipts.get("request-restored").expect("receipt") {
            WorktreeOperationReceipt::Create { claimed_by, .. } => assert_eq!(
                claimed_by.as_deref(),
                Some("dispatch:job-restored"),
                "the receipt must retain the claim needed by an idempotent retry"
            ),
            receipt => panic!("unexpected receipt: {receipt:?}"),
        }
    }

    #[test]
    fn create_receipt_reacquires_only_its_recorded_claim() {
        let project = Path::new("/repo");
        let mut registry = WorktreeRegistry::new(project);
        registry.worktrees.push(RegisteredWorktree {
            workspace_id: None,
            worktree_id: "wt-claimed".to_string(),
            path: "/managed/wt-claimed".to_string(),
            base_ref: Some("main".to_string()),
            base_commit: "0123456789abcdef".to_string(),
            branch: None,
            lifecycle: WorktreeLifecycle::Managed,
            created_at_ms: 123,
            claimed_by: None,
        });

        assert!(WorktreeService::restore_create_receipt_claim(
            &mut registry,
            "wt-claimed",
            Some("dispatch:job-1"),
        )
        .expect("reacquire released claim"));
        assert_eq!(
            registry.worktrees[0].claimed_by.as_deref(),
            Some("dispatch:job-1")
        );
        assert!(!WorktreeService::restore_create_receipt_claim(
            &mut registry,
            "wt-claimed",
            Some("dispatch:job-1"),
        )
        .expect("same claim is idempotent"));

        let conflict = WorktreeService::restore_create_receipt_claim(
            &mut registry,
            "wt-claimed",
            Some("dispatch:job-2"),
        )
        .expect_err("a retry must not steal another claim");
        assert_eq!(conflict.code, WorktreeErrorCode::RequestConflict);
        assert_eq!(
            registry.worktrees[0].claimed_by.as_deref(),
            Some("dispatch:job-1")
        );
    }

    #[test]
    fn failed_create_cleanup_clears_only_the_exact_attempt_claim() {
        let project = Path::new("/repo");
        let mut registry = WorktreeRegistry::new(project);
        for (worktree_id, claimed_by) in [
            ("wt-current", Some("dispatch:job-1")),
            ("wt-other", Some("dispatch:job-2")),
        ] {
            registry.worktrees.push(RegisteredWorktree {
                workspace_id: None,
                worktree_id: worktree_id.to_string(),
                path: format!("/managed/{worktree_id}"),
                base_ref: Some("main".to_string()),
                base_commit: "0123456789abcdef".to_string(),
                branch: None,
                lifecycle: WorktreeLifecycle::Managed,
                created_at_ms: 123,
                claimed_by: claimed_by.map(ToOwned::to_owned),
            });
        }

        assert!(!WorktreeService::clear_matching_claim(
            &mut registry,
            "wt-current",
            Some("dispatch:job-2")
        ));
        assert!(!WorktreeService::clear_matching_claim(
            &mut registry,
            "missing",
            Some("dispatch:job-1")
        ));
        assert!(WorktreeService::clear_matching_claim(
            &mut registry,
            "wt-current",
            Some("dispatch:job-1")
        ));
        assert_eq!(registry.worktrees[0].claimed_by, None);
        assert_eq!(
            registry.worktrees[1].claimed_by.as_deref(),
            Some("dispatch:job-2"),
            "cleanup must not release another worktree's claim"
        );
    }

    #[test]
    fn legacy_create_receipt_defaults_to_unclaimed() {
        let receipt: WorktreeOperationReceipt = serde_json::from_value(serde_json::json!({
            "operation": "create",
            "worktree_id": "wt-legacy",
            "source_workspace_path": "/repo",
            "base_ref": "main",
            "copy_local_changes": false
        }))
        .expect("legacy receipt");

        match receipt {
            WorktreeOperationReceipt::Create { claimed_by, .. } => {
                assert_eq!(claimed_by, None);
            }
            receipt => panic!("unexpected receipt: {receipt:?}"),
        }
    }
}
