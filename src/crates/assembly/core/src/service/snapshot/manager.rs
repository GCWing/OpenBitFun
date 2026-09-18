use crate::agentic::tools::framework::{
    DynamicToolInfo, Tool, ToolExposure, ToolResult, ToolUseContext,
};
use crate::agentic::tools::registry::ToolRegistry;
use crate::service::snapshot::service::SnapshotService;
use crate::service::snapshot::snapshot_core::SessionStats;
use crate::service::snapshot::types::{
    OperationType, SnapshotConfig, SnapshotError, SnapshotResult,
};
use crate::service::workspace_runtime::{
    get_workspace_runtime_service_arc, WorkspaceRuntimeContext, WorkspaceRuntimeTarget,
};
use async_trait::async_trait;
use log::{debug, info, warn};
use openbitfun_runtime_ports::{WorkspaceFileSystem, WorkspacePathKind};
use openbitfun_services_core::workspace_identity::WorkspaceSessionIdentity;
use serde_json::Value;
use sha2::{Digest, Sha256};
use std::collections::HashMap;
use std::path::{Path, PathBuf};
use std::sync::{Arc, OnceLock, RwLock as StdRwLock};
use std::time::Instant;
use tokio::sync::{Mutex as AsyncMutex, RwLock};

#[cfg(test)]
use std::sync::atomic::{AtomicU64, AtomicUsize, Ordering};
#[cfg(test)]
use std::time::Duration;

/// Snapshot manager
///
/// Manages all components of the snapshot system.
pub struct SnapshotManager {
    snapshot_service: Arc<RwLock<SnapshotService>>,
}

impl SnapshotManager {
    /// Creates a new snapshot manager.
    async fn new(workspace_dir: PathBuf, config: Option<SnapshotConfig>) -> SnapshotResult<Self> {
        #[cfg(test)]
        record_snapshot_manager_new_for_test(&workspace_dir).await;

        info!(
            "Creating snapshot manager: workspace={}",
            workspace_dir.display()
        );

        let runtime_service = get_workspace_runtime_service_arc();
        let runtime_context = runtime_service
            .ensure_local_workspace_runtime(&workspace_dir)
            .await
            .map_err(|e| SnapshotError::ConfigError(e.to_string()))?
            .context;

        let mut snapshot_service = SnapshotService::new(workspace_dir, runtime_context, config);
        snapshot_service.initialize().await?;
        let snapshot_service = Arc::new(RwLock::new(snapshot_service));
        Ok(Self { snapshot_service })
    }

    /// Records a file change.
    pub async fn record_file_change(
        &self,
        session_id: &str,
        turn_index: usize,
        file_path: PathBuf,
        operation_type: OperationType,
        tool_name: String,
    ) -> SnapshotResult<String> {
        let snapshot_service = self.snapshot_service.read().await;
        snapshot_service
            .record_file_change(session_id, turn_index, file_path, operation_type, tool_name)
            .await
    }

    /// Rolls back a session.
    pub async fn rollback_session(&self, session_id: &str) -> SnapshotResult<Vec<PathBuf>> {
        let snapshot_service = self.snapshot_service.read().await;
        snapshot_service.rollback_session(session_id).await
    }

    /// Rolls back to a specific turn.
    pub async fn rollback_workspace_files_to_boundary(
        &self,
        session_id: &str,
        turn_index: usize,
    ) -> SnapshotResult<Vec<PathBuf>> {
        let snapshot_service = self.snapshot_service.read().await;
        snapshot_service
            .rollback_workspace_files_to_boundary(session_id, turn_index)
            .await
    }

    pub(crate) async fn prepare_workspace_revert(
        &self,
        session_id: &str,
        state: &mut crate::agentic::session::revert::SessionRevertState,
    ) -> SnapshotResult<()> {
        self.snapshot_service
            .read()
            .await
            .prepare_workspace_revert(session_id, state)
            .await
    }

    pub(crate) async fn apply_workspace_revert(
        &self,
        session_id: &str,
        state: &crate::agentic::session::revert::SessionRevertState,
    ) -> SnapshotResult<Vec<PathBuf>> {
        self.snapshot_service
            .read()
            .await
            .apply_workspace_revert(session_id, state)
            .await
    }

    pub(crate) async fn commit_workspace_revert(
        &self,
        session_id: &str,
        state: &crate::agentic::session::revert::SessionRevertState,
    ) -> SnapshotResult<()> {
        self.snapshot_service
            .read()
            .await
            .commit_workspace_revert(session_id, state)
            .await
    }

    pub(crate) async fn delete_workspace_revert_checkpoint(
        &self,
        state: &crate::agentic::session::revert::SessionRevertState,
    ) -> SnapshotResult<()> {
        self.snapshot_service
            .read()
            .await
            .delete_workspace_revert_checkpoint(state)
            .await
    }

    /// Accepts all changes in a session.
    pub async fn accept_session(&self, session_id: &str) -> SnapshotResult<()> {
        let snapshot_service = self.snapshot_service.read().await;
        snapshot_service.accept_session(session_id).await
    }

    /// Accepts changes for a single file.
    pub async fn accept_file(&self, session_id: &str, file_path: &str) -> SnapshotResult<()> {
        let snapshot_service = self.snapshot_service.read().await;
        let file_path = std::path::Path::new(file_path);
        snapshot_service.accept_file(session_id, file_path).await
    }

    /// Rejects changes for a single file by restoring its pre-session state.
    pub async fn reject_file(
        &self,
        session_id: &str,
        file_path: &str,
    ) -> SnapshotResult<Vec<PathBuf>> {
        let snapshot_service = self.snapshot_service.read().await;
        let file_path = std::path::Path::new(file_path);
        snapshot_service.reject_file(session_id, file_path).await
    }

    /// Returns the list of files affected by a session.
    pub async fn get_session_files(&self, session_id: &str) -> SnapshotResult<Vec<PathBuf>> {
        self.get_session_files_before(session_id, None).await
    }

    pub async fn get_session_files_before(
        &self,
        session_id: &str,
        max_turn_exclusive: Option<usize>,
    ) -> SnapshotResult<Vec<PathBuf>> {
        let snapshot_service = self.snapshot_service.read().await;
        snapshot_service
            .get_session_files_before(session_id, max_turn_exclusive)
            .await
    }

    /// Returns the list of turns for a session.
    pub async fn get_session_turns(&self, session_id: &str) -> SnapshotResult<Vec<usize>> {
        self.get_session_turns_before(session_id, None).await
    }

    pub async fn get_session_turns_before(
        &self,
        session_id: &str,
        max_turn_exclusive: Option<usize>,
    ) -> SnapshotResult<Vec<usize>> {
        let snapshot_service = self.snapshot_service.read().await;
        snapshot_service
            .get_session_turns_before(session_id, max_turn_exclusive)
            .await
    }

    /// Returns the list of files modified in a turn.
    pub async fn get_turn_files(
        &self,
        session_id: &str,
        turn_index: usize,
    ) -> SnapshotResult<Vec<PathBuf>> {
        self.get_turn_files_before(session_id, turn_index, None)
            .await
    }

    pub async fn get_turn_files_before(
        &self,
        session_id: &str,
        turn_index: usize,
        max_turn_exclusive: Option<usize>,
    ) -> SnapshotResult<Vec<PathBuf>> {
        let snapshot_service = self.snapshot_service.read().await;
        snapshot_service
            .get_turn_files_before(session_id, turn_index, max_turn_exclusive)
            .await
    }

    /// Returns the diff content for a file.
    pub async fn get_file_diff(
        &self,
        session_id: &str,
        file_path: &str,
        anchor_operation_id: Option<&str>,
    ) -> SnapshotResult<serde_json::Value> {
        self.get_file_diff_before(session_id, file_path, anchor_operation_id, None)
            .await
    }

    pub async fn get_file_diff_before(
        &self,
        session_id: &str,
        file_path: &str,
        anchor_operation_id: Option<&str>,
        max_turn_exclusive: Option<usize>,
    ) -> SnapshotResult<serde_json::Value> {
        let snapshot_service = self.snapshot_service.read().await;
        let file_path = std::path::Path::new(file_path);
        let (original, modified, anchor_line) = snapshot_service
            .get_file_diff_with_anchor_before(
                session_id,
                file_path,
                anchor_operation_id,
                max_turn_exclusive,
            )
            .await?;

        Ok(serde_json::json!({
            "file_path": file_path.to_string_lossy(),
            "original_content": original,
            "modified_content": modified,
            "anchor_line": anchor_line,
        }))
    }

    pub async fn get_operation_diff_before(
        &self,
        session_id: &str,
        file_path: &str,
        operation_id: &str,
        max_turn_exclusive: Option<usize>,
    ) -> SnapshotResult<serde_json::Value> {
        let (original, modified, anchor_line) = self
            .snapshot_service
            .read()
            .await
            .get_operation_diff_before(
                session_id,
                Path::new(file_path),
                operation_id,
                max_turn_exclusive,
            )
            .await?;
        Ok(serde_json::json!({
            "file_path": file_path,
            "original_content": original,
            "modified_content": modified,
            "anchor_line": anchor_line,
        }))
    }

    pub async fn get_session_file_diff_stats(
        &self,
        session_id: &str,
        file_path: &str,
    ) -> SnapshotResult<crate::service::snapshot::types::SessionFileDiffStats> {
        self.get_session_file_diff_stats_before(session_id, file_path, None)
            .await
    }

    pub async fn get_session_file_diff_stats_before(
        &self,
        session_id: &str,
        file_path: &str,
        max_turn_exclusive: Option<usize>,
    ) -> SnapshotResult<crate::service::snapshot::types::SessionFileDiffStats> {
        let snapshot_service = self.snapshot_service.read().await;
        let file_path = std::path::Path::new(file_path);
        snapshot_service
            .get_session_file_diff_stats_before(session_id, file_path, max_turn_exclusive)
            .await
    }

    pub async fn get_operation_summary(
        &self,
        session_id: &str,
        operation_id: &str,
    ) -> SnapshotResult<serde_json::Value> {
        self.get_operation_summary_before(session_id, operation_id, None)
            .await
    }

    pub async fn get_operation_summary_before(
        &self,
        session_id: &str,
        operation_id: &str,
        max_turn_exclusive: Option<usize>,
    ) -> SnapshotResult<serde_json::Value> {
        let snapshot_service = self.snapshot_service.read().await;
        let op = snapshot_service
            .get_operation_summary_before(session_id, operation_id, max_turn_exclusive)
            .await?;
        Ok(serde_json::json!({
            "operation_id": op.operation_id,
            "session_id": op.session_id,
            "turn_index": op.turn_index,
            "seq_in_turn": op.seq_in_turn,
            "file_path": op.file_path.to_string_lossy(),
            "operation_type": format!("{:?}", op.operation_type),
            "tool_name": op.tool_context.tool_name,
            "lines_added": op.diff_summary.lines_added,
            "lines_removed": op.diff_summary.lines_removed,
        }))
    }

    pub async fn get_session(
        &self,
        session_id: &str,
    ) -> SnapshotResult<crate::service::snapshot::types::SessionInfo> {
        self.get_session_before(session_id, None).await
    }

    pub async fn get_session_before(
        &self,
        session_id: &str,
        max_turn_exclusive: Option<usize>,
    ) -> SnapshotResult<crate::service::snapshot::types::SessionInfo> {
        let snapshot_service = self.snapshot_service.read().await;
        snapshot_service
            .get_session_before(session_id, max_turn_exclusive)
            .await
    }

    /// Returns session statistics.
    pub async fn get_session_stats(&self, session_id: &str) -> SnapshotResult<serde_json::Value> {
        self.get_session_stats_before(session_id, None).await
    }

    pub async fn get_session_stats_before(
        &self,
        session_id: &str,
        max_turn_exclusive: Option<usize>,
    ) -> SnapshotResult<serde_json::Value> {
        let stats = self
            .get_session_stats_fact_before(session_id, max_turn_exclusive)
            .await?;

        serde_json::to_value(stats).map_err(|e| {
            SnapshotError::ConfigError(format!("Failed to serialize statistics: {}", e))
        })
    }

    pub(crate) async fn get_session_stats_fact_before(
        &self,
        session_id: &str,
        max_turn_exclusive: Option<usize>,
    ) -> SnapshotResult<SessionStats> {
        let snapshot_service = self.snapshot_service.read().await;
        snapshot_service
            .get_session_stats_before(session_id, max_turn_exclusive)
            .await
    }

    /// Returns system statistics.
    pub async fn get_system_stats(&self) -> SnapshotResult<serde_json::Value> {
        let snapshot_service = self.snapshot_service.read().await;
        let stats = snapshot_service.get_system_stats().await?;

        serde_json::to_value(stats).map_err(|e| {
            SnapshotError::ConfigError(format!("Failed to serialize system statistics: {}", e))
        })
    }

    pub async fn list_sessions(&self) -> SnapshotResult<Vec<String>> {
        let snapshot_service = self.snapshot_service.read().await;
        snapshot_service.list_sessions().await
    }

    /// Tries to acquire a file lock.
    pub async fn try_acquire_file_lock(
        &self,
        session_id: &str,
        file_path: &str,
        tool_name: &str,
    ) -> SnapshotResult<bool> {
        let snapshot_service = self.snapshot_service.read().await;
        let file_path = std::path::Path::new(file_path);
        snapshot_service
            .try_acquire_file_lock(session_id, file_path, tool_name)
            .await
    }

    /// Releases a file lock.
    pub async fn release_file_lock(&self, session_id: &str, file_path: &str) -> SnapshotResult<()> {
        let snapshot_service = self.snapshot_service.read().await;
        let file_path = std::path::Path::new(file_path);
        snapshot_service
            .release_file_lock(session_id, file_path)
            .await
    }

    /// Returns file lock status.
    pub async fn get_file_lock_status(&self, file_path: &str) -> SnapshotResult<serde_json::Value> {
        let snapshot_service = self.snapshot_service.read().await;
        let file_path = std::path::Path::new(file_path);

        let lock_status = snapshot_service.get_file_lock_status(file_path).await?;
        Ok(serde_json::json!({
            "locked": lock_status.is_some(),
            "lock_info": lock_status
        }))
    }

    /// Detects file conflicts.
    pub async fn detect_file_conflict(
        &self,
        session_id: &str,
        file_path: &str,
        tool_name: &str,
    ) -> SnapshotResult<serde_json::Value> {
        let snapshot_service = self.snapshot_service.read().await;
        let file_path = std::path::Path::new(file_path);

        let conflict = snapshot_service
            .detect_file_conflict(session_id, file_path, tool_name)
            .await?;

        Ok(serde_json::json!({
            "has_conflict": conflict.is_some(),
            "conflict_info": conflict
        }))
    }

    /// Checks Git isolation status.
    pub async fn check_git_isolation(&self) -> SnapshotResult<bool> {
        let snapshot_service = self.snapshot_service.read().await;
        snapshot_service.check_git_isolation().await
    }

    /// Returns the change history for a file.
    pub async fn get_file_change_history(
        &self,
        file_path: &std::path::Path,
    ) -> SnapshotResult<Vec<crate::service::snapshot::snapshot_core::FileChangeEntry>> {
        let snapshot_service = self.snapshot_service.read().await;
        snapshot_service.get_file_change_history(file_path).await
    }

    /// Returns the list of all modified files.
    pub async fn get_all_modified_files(&self) -> SnapshotResult<Vec<PathBuf>> {
        let snapshot_service = self.snapshot_service.read().await;
        snapshot_service.get_all_modified_files().await
    }

    /// Returns a reference to the snapshot service (for advanced operations).
    pub fn get_snapshot_service(&self) -> Arc<RwLock<SnapshotService>> {
        self.snapshot_service.clone()
    }
}

fn snapshot_managers() -> &'static StdRwLock<HashMap<String, Arc<SnapshotManager>>> {
    static SNAPSHOT_MANAGERS: OnceLock<StdRwLock<HashMap<String, Arc<SnapshotManager>>>> =
        OnceLock::new();
    SNAPSHOT_MANAGERS.get_or_init(|| StdRwLock::new(HashMap::new()))
}

/// Read-only view managers, cached separately from writers. Loading the
/// snapshot index is expensive (it reads every persisted metadata file), so a
/// view is built once per workspace and reused until a writer supersedes it.
/// Views never see writes anyway: in-process writers register in
/// `snapshot_managers` (checked first), and that registration evicts the view.
fn snapshot_view_managers() -> &'static StdRwLock<HashMap<String, Arc<SnapshotManager>>> {
    static SNAPSHOT_VIEW_MANAGERS: OnceLock<StdRwLock<HashMap<String, Arc<SnapshotManager>>>> =
        OnceLock::new();
    SNAPSHOT_VIEW_MANAGERS.get_or_init(|| StdRwLock::new(HashMap::new()))
}

fn snapshot_manager_init_locks() -> &'static AsyncMutex<HashMap<String, Arc<AsyncMutex<()>>>> {
    static SNAPSHOT_MANAGER_INIT_LOCKS: OnceLock<AsyncMutex<HashMap<String, Arc<AsyncMutex<()>>>>> =
        OnceLock::new();
    SNAPSHOT_MANAGER_INIT_LOCKS.get_or_init(|| AsyncMutex::new(HashMap::new()))
}

async fn snapshot_manager_init_lock(workspace_id: &str) -> Arc<AsyncMutex<()>> {
    let workspace_key = workspace_id.to_owned();
    let mut locks = snapshot_manager_init_locks().lock().await;
    locks
        .entry(workspace_key)
        .or_insert_with(|| Arc::new(AsyncMutex::new(())))
        .clone()
}

fn canonical_snapshot_io_path(workspace_dir: &Path) -> PathBuf {
    dunce::canonicalize(workspace_dir).unwrap_or_else(|_| workspace_dir.to_path_buf())
}

/// The logical path alone is not an identity: two SSH profiles may point at
/// the same path and host while accessing different users or containers.
#[derive(Clone, Debug, PartialEq, Eq, Hash)]
struct BoundSnapshotKey {
    workspace_id: String,
}

#[derive(Default)]
struct BoundSnapshotManagers {
    writers: HashMap<BoundSnapshotKey, Arc<SnapshotManager>>,
    views: HashMap<BoundSnapshotKey, (Arc<SnapshotManager>, bool)>,
}

fn bound_snapshot_managers() -> &'static AsyncMutex<BoundSnapshotManagers> {
    static MANAGERS: OnceLock<AsyncMutex<BoundSnapshotManagers>> = OnceLock::new();
    MANAGERS.get_or_init(|| AsyncMutex::new(BoundSnapshotManagers::default()))
}

fn bound_snapshot_init_locks() -> &'static AsyncMutex<HashMap<BoundSnapshotKey, Arc<AsyncMutex<()>>>>
{
    static LOCKS: OnceLock<AsyncMutex<HashMap<BoundSnapshotKey, Arc<AsyncMutex<()>>>>> =
        OnceLock::new();
    LOCKS.get_or_init(|| AsyncMutex::new(HashMap::new()))
}

fn bound_snapshot_context(
    identity: &WorkspaceSessionIdentity,
    mut context: WorkspaceRuntimeContext,
) -> SnapshotResult<WorkspaceRuntimeContext> {
    match &context.target {
        WorkspaceRuntimeTarget::LocalWorkspace { workspace_root } => {
            if identity.is_remote()
                || identity.hostname
                    != openbitfun_services_core::workspace_identity::LOCAL_WORKSPACE_SSH_HOST
                || canonical_snapshot_io_path(workspace_root)
                    != canonical_snapshot_io_path(Path::new(&identity.logical_workspace_path))
            {
                return Err(SnapshotError::ConfigError(
                    "Snapshot workspace identity does not match its local runtime context".into(),
                ));
            }
        }
        WorkspaceRuntimeTarget::RemoteWorkspaceMirror {
            ssh_host,
            remote_root,
        } => {
            if identity.hostname != *ssh_host
                || identity.logical_workspace_path != *remote_root
                || identity.hostname.trim().is_empty()
                || identity
                    .remote_connection_id
                    .as_deref()
                    .is_none_or(|id| id.trim().is_empty())
                || !remote_root.starts_with('/')
                || remote_root.contains('\0')
                || remote_root
                    .split('/')
                    .any(|component| matches!(component, "." | ".."))
            {
                return Err(SnapshotError::ConfigError(
                    "Snapshot workspace identity does not match its remote runtime context".into(),
                ));
            }
            // Existing mirrors are shared by host+path and cannot prove which
            // SSH profile wrote legacy snapshots. Keep those files untouched;
            // all new remote snapshots have a connection-scoped local owner.
            let encoded_identity = serde_json::to_vec(&(
                &identity.hostname,
                &identity.logical_workspace_path,
                &identity.remote_connection_id,
            ))?;
            let scope = format!("{:x}", Sha256::digest(encoded_identity));
            context.snapshots_dir = context
                .snapshots_dir
                .join("workspace-identities")
                .join(&scope);
            context.snapshot_by_hash_dir = context.snapshots_dir.join("by_hash");
            context.snapshot_metadata_dir = context.snapshots_dir.join("metadata");
            context.snapshot_baselines_dir = context.snapshots_dir.join("baselines");
            context.snapshot_operations_dir = context.snapshots_dir.join("operations");
            context.locks_dir = context.locks_dir.join("snapshot-identities").join(scope);
        }
    }
    Ok(context)
}

/// Bind the verified workspace identity and its filesystem at assembly time.
/// The caller must resolve both from the same WorkspaceBinding; this function
/// never selects a transport by looking up a path on the controller.
pub async fn get_or_create_snapshot_manager_with_workspace(
    workspace_id: &str,
    workspace_fs: Arc<dyn WorkspaceFileSystem>,
    runtime_context: WorkspaceRuntimeContext,
    config: Option<SnapshotConfig>,
) -> SnapshotResult<Arc<SnapshotManager>> {
    open_bound_snapshot_manager(
        workspace_id,
        Some(workspace_fs),
        runtime_context,
        config,
        false,
    )
    .await
}

/// Open connection-scoped persisted facts without creating any runtime state.
pub async fn open_snapshot_manager_for_workspace_view(
    workspace_id: &str,
    workspace_fs: Option<Arc<dyn WorkspaceFileSystem>>,
    runtime_context: WorkspaceRuntimeContext,
) -> SnapshotResult<Arc<SnapshotManager>> {
    open_bound_snapshot_manager(workspace_id, workspace_fs, runtime_context, None, true).await
}

/// Read recorded operation history from controller storage. This does not
/// connect to SSH, create runtime directories or infer a connection from paths.
pub async fn open_snapshot_history_for_workspace(
    workspace_id: &str,
) -> SnapshotResult<Arc<SnapshotManager>> {
    let binding = crate::agentic::WorkspaceBinding::resolve(workspace_id)
        .await
        .map_err(|error| SnapshotError::ConfigError(error.to_string()))?;
    let identity = &binding.session_identity;
    let runtime_service = get_workspace_runtime_service_arc();
    let context = if identity.is_remote() {
        runtime_service
            .context_for_remote_workspace(&identity.hostname, &identity.logical_workspace_path)
    } else {
        runtime_service.context_for_local_workspace(Path::new(&identity.logical_workspace_path))
    };
    open_snapshot_manager_for_workspace_view(workspace_id, None, context).await
}

async fn open_bound_snapshot_manager(
    workspace_id: &str,
    workspace_fs: Option<Arc<dyn WorkspaceFileSystem>>,
    runtime_context: WorkspaceRuntimeContext,
    config: Option<SnapshotConfig>,
    read_only: bool,
) -> SnapshotResult<Arc<SnapshotManager>> {
    let binding = crate::agentic::WorkspaceBinding::resolve(workspace_id)
        .await
        .map_err(|error| SnapshotError::ConfigError(error.to_string()))?;
    let identity = &binding.session_identity;
    let runtime_context = bound_snapshot_context(identity, runtime_context)?;
    if matches!(
        runtime_context.target,
        WorkspaceRuntimeTarget::LocalWorkspace { .. }
    ) {
        return if read_only {
            open_snapshot_manager_for_view(workspace_id).await
        } else {
            get_or_create_snapshot_manager(workspace_id, config).await
        };
    }
    let key = BoundSnapshotKey {
        workspace_id: workspace_id.to_owned(),
    };
    let init_lock = bound_snapshot_init_locks()
        .lock()
        .await
        .entry(key.clone())
        .or_insert_with(|| Arc::new(AsyncMutex::new(())))
        .clone();
    let _guard = init_lock.lock().await;
    {
        let managers = bound_snapshot_managers().lock().await;
        if let Some(existing) = managers.writers.get(&key) {
            return Ok(existing.clone());
        }
        if read_only {
            if let Some((existing, has_filesystem)) = managers.views.get(&key) {
                if *has_filesystem || workspace_fs.is_none() {
                    return Ok(existing.clone());
                }
            }
        }
    }
    if !read_only {
        for directory in [
            &runtime_context.snapshots_dir,
            &runtime_context.snapshot_by_hash_dir,
            &runtime_context.snapshot_metadata_dir,
            &runtime_context.snapshot_baselines_dir,
            &runtime_context.snapshot_operations_dir,
            &runtime_context.locks_dir,
        ] {
            tokio::fs::create_dir_all(directory).await?;
        }
    }
    let has_filesystem = workspace_fs.is_some();
    let mut service = match workspace_fs {
        Some(fs) => SnapshotService::with_workspace_fs(
            PathBuf::from(&identity.logical_workspace_path),
            runtime_context,
            config,
            fs,
        ),
        None => SnapshotService::new(
            PathBuf::from(&identity.logical_workspace_path),
            runtime_context,
            config,
        ),
    };
    if read_only {
        service.initialize_for_view().await?;
    } else {
        service.initialize().await?;
    }
    let manager = Arc::new(SnapshotManager {
        snapshot_service: Arc::new(RwLock::new(service)),
    });
    let mut managers = bound_snapshot_managers().lock().await;
    if read_only {
        managers
            .views
            .insert(key, (manager.clone(), has_filesystem));
    } else {
        managers.views.remove(&key);
        managers.writers.insert(key, manager.clone());
    }
    Ok(manager)
}

#[cfg(test)]
pub(super) async fn clear_bound_snapshot_manager_for_test(workspace_id: &str) {
    let key = BoundSnapshotKey {
        workspace_id: workspace_id.to_owned(),
    };
    let mut managers = bound_snapshot_managers().lock().await;
    managers.writers.remove(&key);
    managers.views.remove(&key);
}

#[cfg(test)]
static SNAPSHOT_MANAGER_NEW_COUNT_FOR_TEST: AtomicUsize = AtomicUsize::new(0);
#[cfg(test)]
static SNAPSHOT_MANAGER_NEW_DELAY_MS_FOR_TEST: AtomicU64 = AtomicU64::new(0);

#[cfg(test)]
fn snapshot_manager_observed_workspace_for_test() -> &'static StdRwLock<Option<PathBuf>> {
    static WORKSPACE: OnceLock<StdRwLock<Option<PathBuf>>> = OnceLock::new();
    WORKSPACE.get_or_init(|| StdRwLock::new(None))
}

#[cfg(test)]
fn snapshot_manager_test_serial_lock() -> &'static AsyncMutex<()> {
    static LOCK: OnceLock<AsyncMutex<()>> = OnceLock::new();
    LOCK.get_or_init(|| AsyncMutex::new(()))
}

#[cfg(test)]
async fn record_snapshot_manager_new_for_test(workspace_dir: &Path) {
    let observed_workspace = snapshot_manager_observed_workspace_for_test()
        .read()
        .ok()
        .and_then(|workspace| workspace.clone());
    if observed_workspace.as_deref() != Some(workspace_dir) {
        return;
    }
    SNAPSHOT_MANAGER_NEW_COUNT_FOR_TEST.fetch_add(1, Ordering::SeqCst);
    let delay_ms = SNAPSHOT_MANAGER_NEW_DELAY_MS_FOR_TEST.load(Ordering::SeqCst);
    if delay_ms > 0 {
        tokio::time::sleep(Duration::from_millis(delay_ms)).await;
    }
}

#[cfg(test)]
fn observe_snapshot_manager_new_for_test(workspace_dir: &Path) {
    if let Ok(mut observed_workspace) = snapshot_manager_observed_workspace_for_test().write() {
        *observed_workspace = Some(canonical_snapshot_io_path(workspace_dir));
    }
    SNAPSHOT_MANAGER_NEW_COUNT_FOR_TEST.store(0, Ordering::SeqCst);
}

#[cfg(test)]
fn snapshot_manager_new_count_for_test() -> usize {
    SNAPSHOT_MANAGER_NEW_COUNT_FOR_TEST.load(Ordering::SeqCst)
}

#[cfg(test)]
fn set_snapshot_manager_new_delay_for_test(delay: Duration) {
    SNAPSHOT_MANAGER_NEW_DELAY_MS_FOR_TEST.store(delay.as_millis() as u64, Ordering::SeqCst);
}

#[cfg(test)]
pub(crate) fn clear_snapshot_manager_for_test(workspace_id: &str) {
    if let Ok(mut managers) = snapshot_managers().write() {
        managers.remove(workspace_id);
    }
    if let Ok(mut views) = snapshot_view_managers().write() {
        views.remove(workspace_id);
    }
}

/// Ensures the registry always exposes the same tool implementation that will be
/// executed at runtime. File-modifying tools are wrapped once at registration time
/// so tool definitions, permission checks, and execution all share one source of truth.
pub fn wrap_tool_for_snapshot_tracking(tool: Arc<dyn Tool>) -> Arc<dyn Tool> {
    if WrappedTool::is_file_modification_tool_name(tool.name()) {
        Arc::new(WrappedTool::new(tool))
    } else {
        tool
    }
}

/// Compatibility helper that returns a fresh snapshot-aware tool list.
pub fn get_snapshot_wrapped_tools() -> Vec<Arc<dyn Tool>> {
    ToolRegistry::new().get_all_tools()
}

/// Wrapped tool
///
/// Wraps file-modification tools with snapshot functionality.
struct WrappedTool {
    original_tool: Arc<dyn Tool>,
}

/// Prepared tracking state, held across the single underlying tool invocation.
struct PreparedFileModification {
    snapshot_service: tokio::sync::OwnedRwLockReadGuard<SnapshotService>,
    session_id: String,
    operation_id: String,
    file_path: PathBuf,
    intercept_ms: u64,
}

impl WrappedTool {
    fn new(original_tool: Arc<dyn Tool>) -> Self {
        Self { original_tool }
    }

    fn is_file_modification_tool_name(tool_name: &str) -> bool {
        [
            "Write",
            "Edit",
            "Delete",
            "write_file",
            "edit_file",
            "create_file",
            "delete_file",
            "rename_file",
            "move_file",
            "search_replace",
        ]
        .contains(&tool_name)
    }
}

#[async_trait]
impl Tool for WrappedTool {
    fn name(&self) -> &str {
        self.original_tool.name()
    }

    async fn description(&self) -> crate::util::errors::OpenBitFunResult<String> {
        Ok(self.original_tool.description().await?)
    }

    async fn description_with_context(
        &self,
        context: Option<&ToolUseContext>,
    ) -> crate::util::errors::OpenBitFunResult<String> {
        self.original_tool.description_with_context(context).await
    }

    fn short_description(&self) -> String {
        self.original_tool.short_description()
    }

    fn default_exposure(&self) -> ToolExposure {
        self.original_tool.default_exposure()
    }

    fn input_schema(&self) -> Value {
        self.original_tool.input_schema()
    }

    async fn input_schema_for_model(&self) -> Value {
        self.original_tool.input_schema_for_model().await
    }

    async fn input_schema_for_model_with_context(
        &self,
        context: Option<&crate::agentic::tools::framework::ToolUseContext>,
    ) -> Value {
        self.original_tool
            .input_schema_for_model_with_context(context)
            .await
    }

    fn input_json_schema(&self) -> Option<Value> {
        self.original_tool.input_json_schema()
    }

    fn dynamic_provider_id(&self) -> Option<&str> {
        self.original_tool.dynamic_provider_id()
    }

    fn dynamic_tool_info(&self) -> Option<DynamicToolInfo> {
        self.original_tool.dynamic_tool_info()
    }

    fn user_facing_name(&self) -> String {
        self.original_tool.user_facing_name().to_string()
    }

    async fn is_enabled(&self) -> bool {
        self.original_tool.is_enabled().await
    }

    async fn is_available_in_context(&self, context: Option<&ToolUseContext>) -> bool {
        self.original_tool.is_available_in_context(context).await
    }

    fn is_readonly(&self) -> bool {
        self.original_tool.is_readonly()
    }

    fn is_concurrency_safe(&self, input: Option<&Value>) -> bool {
        self.original_tool.is_concurrency_safe(input)
    }

    fn permission_intents(
        &self,
        input: &Value,
        context: &ToolUseContext,
    ) -> crate::util::errors::OpenBitFunResult<Vec<openbitfun_agent_tools::PermissionIntent>> {
        self.original_tool.permission_intents(input, context)
    }

    async fn validate_input(
        &self,
        input: &Value,
        context: Option<&ToolUseContext>,
    ) -> crate::agentic::tools::framework::ValidationResult {
        let original_validation = self.original_tool.validate_input(input, context).await;

        if !original_validation.result {
            return original_validation;
        }

        original_validation
    }

    fn render_result_for_assistant(&self, output: &Value) -> String {
        let rendered = self.original_tool.render_result_for_assistant(output);
        if output.get("snapshot_recorded").and_then(Value::as_bool) == Some(true) {
            format!("{rendered}\nOperation recorded by the snapshot system.")
        } else {
            rendered
        }
    }

    fn render_tool_use_message(
        &self,
        input: &Value,
        options: &crate::agentic::tools::framework::ToolRenderOptions,
    ) -> String {
        let original_message = self.original_tool.render_tool_use_message(input, options);
        original_message.to_string()
    }

    fn render_tool_use_rejected_message(&self) -> String {
        self.original_tool
            .render_tool_use_rejected_message()
            .to_string()
    }

    fn render_tool_result_message(&self, output: &Value) -> String {
        self.original_tool.render_tool_result_message(output)
    }

    async fn call_impl(
        &self,
        input: &Value,
        context: &ToolUseContext,
    ) -> crate::util::errors::OpenBitFunResult<Vec<ToolResult>> {
        let mut snapshot_warning = None;
        let prepared = if Self::is_file_modification_tool_name(self.name()) {
            debug!(
                "Intercepting file modification tool: tool_name={}",
                self.name()
            );

            self.ensure_delete_snapshot_target_supported(input, context)
                .await?;

            match self.prepare_file_modification(input, context).await {
                Ok(prepared) => prepared,
                Err(error) => {
                    warn!(
                        "Snapshot preparation failed; executing tool without tracking: tool_name={} error={}",
                        self.name(), error
                    );
                    snapshot_warning = Some(format!(
                        "Snapshot tracking could not start: {}. Snapshot review and rollback may be unavailable for this modification. Do not repeat the tool call to repair snapshot tracking.",
                        error
                    ));
                    None
                }
            }
        } else {
            None
        };

        // A tool error can follow a partial mutation. Neither it nor a tracking
        // error permits invoking the tool again.
        let start_time = Instant::now();
        let mut results = self.original_tool.call(input, context).await?;
        let tool_call_ms = crate::util::elapsed_ms_u64(start_time);

        if let Some(prepared) = prepared {
            let complete_started_at = Instant::now();
            if let Err(error) = prepared
                .snapshot_service
                .complete_file_modification(
                    &prepared.session_id,
                    &prepared.operation_id,
                    tool_call_ms,
                )
                .await
            {
                warn!(
                    "Snapshot completion failed after tool execution; preserving tool result: tool_name={} operation_id={} error={}",
                    self.name(), prepared.operation_id, error
                );
                snapshot_warning = Some(format!(
                    "The tool completed, but snapshot tracking could not finish: {}. Snapshot review and rollback may be unavailable for this modification. The tool was not repeated; do not repeat it to repair snapshot tracking.",
                    error
                ));
            } else {
                if let Some(ToolResult::Result {
                    data: Value::Object(data),
                    ..
                }) = results.last_mut()
                {
                    // Additive evidence for consumers of persisted tool results;
                    // legacy, skipped and failed tracking never receive it.
                    data.insert("snapshot_recorded".into(), Value::Bool(true));
                }
                let complete_ms = crate::util::elapsed_ms_u64(complete_started_at);
                let total_ms = prepared
                    .intercept_ms
                    .saturating_add(tool_call_ms)
                    .saturating_add(complete_ms);
                debug!(
                    "File modification tool completed: tool_name={}, operation_id={}, total_ms={}, intercept_ms={}, tool_call_ms={}, complete_ms={}, file_path={}",
                    self.name(), prepared.operation_id, total_ms, prepared.intercept_ms,
                    tool_call_ms, complete_ms, prepared.file_path.display()
                );
            }
        }

        if let Some(warning) = snapshot_warning {
            self.append_snapshot_warning(&mut results, &warning);
        }
        Ok(results)
    }
}

impl WrappedTool {
    /// Snapshot storage currently preserves file bytes, not link objects. A
    /// tracked Delete must therefore stop before removing a link instead of
    /// falling back to an operation that cannot be rolled back faithfully.
    async fn ensure_delete_snapshot_target_supported(
        &self,
        input: &Value,
        context: &ToolUseContext,
    ) -> crate::util::errors::OpenBitFunResult<()> {
        if !matches!(self.name(), "Delete" | "delete_file") {
            return Ok(());
        }

        let raw_path = self
            .extract_file_path(input, context)
            .map_err(|error| crate::util::errors::OpenBitFunError::Tool(error.to_string()))?;
        let resolved = context.resolve_tool_path(raw_path.to_string_lossy().as_ref())?;
        if resolved.is_runtime_artifact() {
            return Ok(());
        }
        let workspace_fs = context.file_system_for_path(&resolved)?;
        match workspace_fs.metadata(&resolved.resolved_path, false).await {
            Ok(Some(metadata)) if matches!(metadata.kind, WorkspacePathKind::Symlink | WorkspacePathKind::Other) => {
                Err(crate::util::errors::OpenBitFunError::Tool(format!(
                    "Snapshot-tracked Delete cannot remove a symbolic link or reparse point because rollback cannot restore the link object: {}. The delete was not performed",
                    resolved.logical_path
                )))
            }
            Ok(_) => Ok(()),
            Err(error) => Err(crate::util::errors::OpenBitFunError::Tool(format!(
                "Failed to inspect Delete target for Snapshot safety: path={} error={}",
                resolved.logical_path, error
            ))),
        }
    }

    /// Prepare tracking without invoking the underlying tool. Only failures in
    /// this stage may safely degrade to execution without a snapshot.
    async fn prepare_file_modification(
        &self,
        input: &Value,
        context: &ToolUseContext,
    ) -> crate::util::errors::OpenBitFunResult<Option<PreparedFileModification>> {
        let session_id = context.session_id.clone().ok_or_else(|| {
            crate::util::errors::OpenBitFunError::Tool(
                "session_id is required in ToolUseContext".to_string(),
            )
        })?;

        let raw_path = match self.extract_file_path(input, context) {
            Ok(path) => path,
            Err(e) => return Err(crate::util::errors::OpenBitFunError::Tool(e.to_string())),
        };

        let resolved = context.resolve_tool_path(raw_path.to_string_lossy().as_ref())?;
        if resolved.is_runtime_artifact() {
            // Artifacts belong to controller storage, not workspace history.
            return Ok(None);
        }
        let binding = context.workspace.as_ref().ok_or_else(|| {
            crate::util::errors::OpenBitFunError::Tool(
                "workspace is required in ToolUseContext for snapshot tracking".into(),
            )
        })?;
        let workspace_fs = context.file_system_for_path(&resolved)?;
        let runtime_context = context.ensure_current_workspace_runtime().await?;
        let snapshot_manager = get_or_create_snapshot_manager_with_workspace(
            binding.workspace_id.as_deref().ok_or_else(|| {
                crate::OpenBitFunError::service("Workspace ID is required for snapshot tracking")
            })?,
            workspace_fs.clone(),
            runtime_context,
            None,
        )
        .await
        .map_err(|error| crate::util::errors::OpenBitFunError::Tool(error.to_string()))?;
        let file_path = PathBuf::from(&resolved.resolved_path);
        let file_existed_before = workspace_fs
            .metadata(&resolved.resolved_path, true)
            .await
            .map_err(|error| crate::util::errors::OpenBitFunError::Tool(error.to_string()))?
            .is_some();
        let is_create_tool = matches!(self.name(), "Write" | "write_file" | "create_file");
        if !file_existed_before && !is_create_tool {
            return Err(crate::util::errors::OpenBitFunError::Tool(format!(
                "File not found: {}",
                resolved.logical_path
            )));
        }
        let operation_type = self.get_operation_type_internal(file_existed_before);
        let turn_index = self.extract_turn_index(context);

        let snapshot_service = snapshot_manager.get_snapshot_service();
        let snapshot_service = snapshot_service.read_owned().await;
        let intercept_started_at = std::time::Instant::now();
        let operation_id = snapshot_service
            .intercept_file_modification(
                &session_id,
                turn_index,
                self.name(),
                input.clone(),
                &file_path,
                operation_type,
                context.tool_call_id.clone(),
            )
            .await
            .map_err(|e| crate::util::errors::OpenBitFunError::Tool(e.to_string()))?;
        let intercept_ms = crate::util::elapsed_ms_u64(intercept_started_at);

        debug!(
            "Recorded file modification operation: operation_id={}",
            operation_id
        );

        Ok(Some(PreparedFileModification {
            snapshot_service,
            session_id,
            operation_id,
            file_path,
            intercept_ms,
        }))
    }

    fn append_snapshot_warning(&self, results: &mut Vec<ToolResult>, warning: &str) {
        // The pipeline consumes the last result and exposes its entire data
        // when no assistant text was supplied. Keep both contracts intact.
        if let Some(ToolResult::Result {
            data,
            result_for_assistant,
            ..
        }) = results.last_mut()
        {
            let message = result_for_assistant.get_or_insert_with(|| data.to_string());
            message.push_str("\n\nWarning: ");
            message.push_str(warning);
        } else if let Some(data) = results.last().map(ToolResult::content) {
            let message = format!("{}\n\nWarning: {}", data, warning);
            results.push(ToolResult::ok(data, Some(message)));
        }
    }

    /// Extracts the turn index.
    fn extract_turn_index(&self, context: &ToolUseContext) -> usize {
        context
            .custom_data
            .get("turn_index")
            .and_then(|v| v.as_u64())
            .map(|v| v as usize)
            .unwrap_or(0)
    }

    /// Extracts the concrete input object used by legacy file tools, falling
    /// back to the owner-resolved permission resource for payload-based tools.
    fn extract_file_path(
        &self,
        input: &Value,
        context: &ToolUseContext,
    ) -> SnapshotResult<PathBuf> {
        let possible_fields = ["file_path", "path", "target_file", "filename"];

        for field in &possible_fields {
            if let Some(path_value) = input.get(field) {
                if let Some(path_str) = path_value.as_str() {
                    return Ok(PathBuf::from(path_str));
                }
            }
        }

        let permission_intents = self
            .original_tool
            .permission_intents(input, context)
            .map_err(|error| SnapshotError::ConfigError(error.to_string()))?;
        if let Some(resource) = permission_intents
            .iter()
            .find(|intent| intent.action == "edit")
            .and_then(|intent| intent.resources.first())
        {
            return Ok(PathBuf::from(resource));
        }

        Err(SnapshotError::ConfigError(
            "Failed to extract file path from tool input".to_string(),
        ))
    }

    /// Returns the operation type.
    fn get_operation_type_internal(&self, file_existed_before: bool) -> OperationType {
        match self.name() {
            "Write" | "write_file" => {
                if file_existed_before {
                    OperationType::Modify
                } else {
                    OperationType::Create
                }
            }
            "create_file" => OperationType::Create,
            "delete_file" | "Delete" => OperationType::Delete,
            "rename_file" | "move_file" => OperationType::Rename,
            _ => OperationType::Modify,
        }
    }
}

async fn local_snapshot_io_root(workspace_id: &str) -> SnapshotResult<PathBuf> {
    let service = crate::service::workspace::get_global_workspace_service()
        .ok_or_else(|| SnapshotError::ConfigError("Workspace service is unavailable".into()))?;
    let record = service
        .require_workspace(workspace_id)
        .await
        .map_err(|error| SnapshotError::ConfigError(error.to_string()))?;
    if record.workspace_kind == crate::service::workspace::WorkspaceKind::Remote {
        return Err(SnapshotError::ConfigError(
            "Local snapshot manager requires a local workspace ID".into(),
        ));
    }
    Ok(record.root_path)
}

pub async fn get_or_create_snapshot_manager(
    workspace_id: &str,
    config: Option<SnapshotConfig>,
) -> SnapshotResult<Arc<SnapshotManager>> {
    let workspace_key = workspace_id.to_owned();
    let workspace_dir = local_snapshot_io_root(workspace_id).await?;
    if let Some(existing) = get_snapshot_manager_for_workspace(&workspace_key) {
        return Ok(existing);
    }

    let init_lock = snapshot_manager_init_lock(&workspace_key).await;
    let _init_guard = init_lock.lock().await;

    if let Some(existing) = get_snapshot_manager_for_workspace(&workspace_key) {
        debug!(
            "Snapshot manager initialized by concurrent request: workspace={}",
            workspace_dir.display()
        );
        return Ok(existing);
    }

    let started_at = Instant::now();
    info!(
        "Snapshot manager cold initialization started: workspace={}",
        workspace_dir.display()
    );
    let manager = Arc::new(SnapshotManager::new(workspace_dir.clone(), config).await?);
    {
        let mut managers = snapshot_managers().write().map_err(|_| {
            SnapshotError::ConfigError("Snapshot manager store lock poisoned".to_string())
        })?;
        if let Some(existing) = managers.get(&workspace_key) {
            return Ok(existing.clone());
        }
        managers.insert(workspace_key.clone(), manager.clone());
    }
    // The writer now owns live state for this workspace; a cached read-only
    // view would keep serving the pre-writer index, so drop it.
    if let Ok(mut views) = snapshot_view_managers().write() {
        views.remove(&workspace_key);
    }
    info!(
        "Snapshot manager cold initialization completed: duration_ms={}",
        started_at.elapsed().as_millis()
    );

    Ok(manager)
}

pub fn get_snapshot_manager_for_workspace(workspace_id: &str) -> Option<Arc<SnapshotManager>> {
    let workspace_key = workspace_id.to_owned();
    snapshot_managers()
        .read()
        .ok()
        .and_then(|managers| managers.get(&workspace_key).cloned())
}

/// Opens persisted Snapshot facts for queries without registering a writer or
/// creating workspace runtime state.
pub async fn open_snapshot_manager_for_view(
    workspace_id: &str,
) -> SnapshotResult<Arc<SnapshotManager>> {
    let workspace_dir = local_snapshot_io_root(workspace_id).await?;
    let workspace_key = workspace_id.to_owned();
    if let Some(manager) = get_snapshot_manager_for_workspace(&workspace_key) {
        return Ok(manager);
    }
    if let Some(view) = get_snapshot_view_manager_for_workspace(&workspace_key) {
        return Ok(view);
    }

    let init_lock = snapshot_manager_init_lock(&workspace_key).await;
    let _init_guard = init_lock.lock().await;
    if let Some(manager) = get_snapshot_manager_for_workspace(&workspace_key) {
        return Ok(manager);
    }
    if let Some(view) = get_snapshot_view_manager_for_workspace(&workspace_key) {
        return Ok(view);
    }

    let started_at = Instant::now();
    let runtime_context =
        get_workspace_runtime_service_arc().context_for_local_workspace(&workspace_dir);
    let mut snapshot_service = SnapshotService::new(workspace_dir.clone(), runtime_context, None);
    snapshot_service.initialize_for_view().await?;
    let view = Arc::new(SnapshotManager {
        snapshot_service: Arc::new(RwLock::new(snapshot_service)),
    });
    if let Ok(mut views) = snapshot_view_managers().write() {
        views.insert(workspace_key, view.clone());
    }
    info!(
        "Snapshot view initialized and cached: workspace={} duration_ms={}",
        workspace_dir.display(),
        started_at.elapsed().as_millis()
    );
    Ok(view)
}

fn get_snapshot_view_manager_for_workspace(workspace_key: &str) -> Option<Arc<SnapshotManager>> {
    snapshot_view_managers()
        .read()
        .ok()
        .and_then(|views| views.get(workspace_key).cloned())
}

pub fn ensure_snapshot_manager_for_workspace(
    workspace_id: &str,
) -> SnapshotResult<Arc<SnapshotManager>> {
    get_snapshot_manager_for_workspace(workspace_id).ok_or_else(|| {
        SnapshotError::ConfigError(format!(
            "Snapshot manager not initialized for workspace: {}",
            workspace_id
        ))
    })
}

/// Initializes a snapshot manager for the provided workspace.
pub async fn initialize_snapshot_manager_for_workspace(
    workspace_id: &str,
    config: Option<SnapshotConfig>,
) -> SnapshotResult<()> {
    get_or_create_snapshot_manager(workspace_id, config).await?;
    debug!("Snapshot manager initialized for workspace");
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::{
        clear_snapshot_manager_for_test, get_or_create_snapshot_manager,
        get_snapshot_manager_for_workspace, observe_snapshot_manager_new_for_test,
        open_snapshot_manager_for_view, set_snapshot_manager_new_delay_for_test,
        snapshot_manager_new_count_for_test, snapshot_manager_test_serial_lock,
        wrap_tool_for_snapshot_tracking,
    };
    use crate::agentic::tools::framework::{Tool, ToolResult, ToolUseContext};
    use crate::agentic::tools::implementations::delete_file_tool::DeleteFileTool;
    use crate::agentic::tools::implementations::file_write_tool::FileWriteTool;
    use crate::agentic::tools::ToolRuntimeRestrictions;
    use crate::agentic::WorkspaceBinding;
    use crate::infrastructure::PathManager;
    use crate::service::snapshot::types::OperationType;
    use crate::service::workspace_runtime::{
        set_workspace_runtime_service_for_current_test, WorkspaceRuntimeService,
    };
    use std::collections::HashMap;
    use std::io::Write;
    use std::path::{Path, PathBuf};
    use std::sync::atomic::{AtomicUsize, Ordering};
    use std::sync::Arc;
    use std::time::Duration;
    use uuid::Uuid;

    struct TestWorkspace {
        id: String,
        path: PathBuf,
    }

    impl TestWorkspace {
        async fn new() -> Self {
            let path = std::env::temp_dir().join(format!(
                "openbitfun-snapshot-manager-test-{}",
                Uuid::new_v4()
            ));
            std::fs::create_dir_all(&path).expect("test workspace should be created");
            let record =
                crate::service::workspace::legacy_compat::register_local_fixture(&path, None).await;
            Self {
                path,
                id: record.id,
            }
        }

        fn path(&self) -> &Path {
            &self.path
        }
    }

    impl Drop for TestWorkspace {
        fn drop(&mut self) {
            clear_snapshot_manager_for_test(&self.id);
            let _ = std::fs::remove_dir_all(&self.path);
        }
    }

    async fn tool_context(workspace: PathBuf, session_id: &str) -> ToolUseContext {
        let record =
            crate::service::workspace::legacy_compat::register_local_fixture(&workspace, None)
                .await;
        ToolUseContext {
            tool_call_id: Some("snapshot-write-call".to_string()),
            agent_type: None,
            session_id: Some(session_id.to_string()),
            dialog_turn_id: None,
            workspace: Some(WorkspaceBinding::new(Some(record.id.clone()), workspace)),
            loaded_deferred_tool_specs: Vec::new(),
            primary_model_facts: tool_runtime::context::PrimaryModelFacts::default(),
            custom_data: HashMap::new(),
            computer_use_host: None,
            runtime_tool_restrictions: ToolRuntimeRestrictions::default(),
            runtime_handles: openbitfun_runtime_ports::ToolRuntimeHandles::default(),
        }
    }

    struct CountingMutationTool {
        file_path: PathBuf,
        calls: Arc<AtomicUsize>,
        block_metadata_after_mutation: Option<PathBuf>,
        fail_after_mutation: bool,
    }

    #[async_trait::async_trait]
    impl Tool for CountingMutationTool {
        fn name(&self) -> &str {
            "Write"
        }

        async fn description(&self) -> crate::util::errors::OpenBitFunResult<String> {
            Ok(self.short_description())
        }

        fn short_description(&self) -> String {
            "Count and append a mutation".to_string()
        }

        fn input_schema(&self) -> serde_json::Value {
            serde_json::json!({ "type": "object" })
        }

        async fn call_impl(
            &self,
            _input: &serde_json::Value,
            _context: &ToolUseContext,
        ) -> crate::util::errors::OpenBitFunResult<Vec<ToolResult>> {
            self.calls.fetch_add(1, Ordering::SeqCst);
            let mut file = std::fs::OpenOptions::new()
                .create(true)
                .append(true)
                .open(&self.file_path)
                .expect("mutation target");
            writeln!(file, "mutation").expect("append mutation");
            if let Some(metadata_dir) = &self.block_metadata_after_mutation {
                block_metadata_storage(metadata_dir);
            }
            if self.fail_after_mutation {
                return Err(crate::util::errors::OpenBitFunError::Tool(
                    "original tool error after mutation".to_string(),
                ));
            }
            Ok(vec![ToolResult::ok(
                serde_json::json!({ "success": true, "mutated": true }),
                Some("Mutation applied".to_string()),
            )])
        }
    }

    fn block_metadata_storage(metadata_dir: &Path) {
        if metadata_dir.is_dir() {
            std::fs::rename(metadata_dir, metadata_dir.with_extension("saved"))
                .expect("preserve metadata fixtures");
            std::fs::write(metadata_dir, "blocked metadata storage")
                .expect("block metadata storage");
        }
    }

    fn assert_single_mutation(file: &Path, calls: &AtomicUsize, expected: &str) {
        assert_eq!(
            calls.load(Ordering::SeqCst),
            1,
            "tool must execute exactly once"
        );
        assert_eq!(std::fs::read_to_string(file).unwrap(), expected);
    }

    fn assert_success_with_snapshot_warning(results: &[ToolResult], expected_warning: &str) {
        let [ToolResult::Result {
            data,
            result_for_assistant,
            ..
        }] = results
        else {
            panic!("original result envelope must be preserved: {results:?}");
        };
        assert_eq!(
            data,
            &serde_json::json!({ "success": true, "mutated": true })
        );
        let message = result_for_assistant.as_deref().expect("assistant result");
        assert!(
            message.starts_with("Mutation applied\n\nWarning: "),
            "{message}"
        );
        assert!(message.contains(expected_warning), "{message}");
        assert!(
            message.contains("Do not repeat") || message.contains("do not repeat"),
            "{message}"
        );
        assert!(!message.contains("recorded to snapshot"), "{message}");
    }

    #[tokio::test]
    async fn wrapped_mutation_executes_once_and_records_snapshot() {
        let workspace = TestWorkspace::new().await;
        let _runtime_guard = set_workspace_runtime_service_for_current_test(Arc::new(
            WorkspaceRuntimeService::new(Arc::new(PathManager::with_user_root_for_tests(
                workspace.path().join("user-root"),
            ))),
        ));
        let file = workspace.path().join("mutation.txt");
        let calls = Arc::new(AtomicUsize::new(0));
        let original: Arc<dyn Tool> = Arc::new(CountingMutationTool {
            file_path: file.clone(),
            calls: calls.clone(),
            block_metadata_after_mutation: None,
            fail_after_mutation: false,
        });
        let tool = wrap_tool_for_snapshot_tracking(original.clone());
        let input = serde_json::json!({ "file_path": "mutation.txt" });
        let context = tool_context(workspace.path().to_path_buf(), "single-mutation").await;

        let results = tool
            .call(&input, &context)
            .await
            .expect("mutation succeeds");

        assert_single_mutation(&file, &calls, "mutation\n");
        let ToolResult::Result {
            data,
            result_for_assistant,
            ..
        } = &results[0]
        else {
            panic!("result")
        };
        assert_eq!(
            data.get("snapshot_recorded"),
            Some(&serde_json::Value::Bool(true))
        );
        assert_eq!(result_for_assistant.as_deref(), Some("Mutation applied"));
        assert_eq!(
            tool.render_result_for_assistant(&input),
            original.render_result_for_assistant(&input)
        );
        assert_eq!(
            tool.render_tool_result_message(&input),
            original.render_tool_result_message(&input)
        );
        let manager = get_snapshot_manager_for_workspace(&workspace.id).expect("snapshot manager");
        assert_eq!(
            manager.get_session_files("single-mutation").await.unwrap(),
            vec![file.clone()]
        );
        manager
            .rollback_session("single-mutation")
            .await
            .expect("rollback recorded mutation");
        assert!(!file.exists());
    }

    #[tokio::test]
    async fn wrapped_mutation_executes_once_when_snapshot_start_fails() {
        let workspace = TestWorkspace::new().await;
        let runtime = Arc::new(WorkspaceRuntimeService::new(Arc::new(
            PathManager::with_user_root_for_tests(workspace.path().join("user-root")),
        )));
        let _runtime_guard = set_workspace_runtime_service_for_current_test(runtime.clone());
        let runtime_context = runtime
            .ensure_local_workspace_runtime(workspace.path())
            .await
            .unwrap()
            .context;
        get_or_create_snapshot_manager(&workspace.id, None)
            .await
            .unwrap();
        block_metadata_storage(&runtime_context.snapshot_metadata_dir);
        let file = workspace.path().join("mutation.txt");
        std::fs::write(&file, "before\n").unwrap();
        let calls = Arc::new(AtomicUsize::new(0));
        let tool = wrap_tool_for_snapshot_tracking(Arc::new(CountingMutationTool {
            file_path: file.clone(),
            calls: calls.clone(),
            block_metadata_after_mutation: None,
            fail_after_mutation: false,
        }));

        let results = tool
            .call(
                &serde_json::json!({ "file_path": "mutation.txt" }),
                &tool_context(workspace.path().to_path_buf(), "failed-start").await,
            )
            .await
            .expect("snapshot start failure must preserve tool success");

        assert_single_mutation(&file, &calls, "before\nmutation\n");
        assert_success_with_snapshot_warning(&results, "Snapshot tracking could not start");
    }

    #[tokio::test]
    async fn wrapped_mutation_does_not_repeat_when_snapshot_completion_fails() {
        let workspace = TestWorkspace::new().await;
        let runtime = Arc::new(WorkspaceRuntimeService::new(Arc::new(
            PathManager::with_user_root_for_tests(workspace.path().join("user-root")),
        )));
        let _runtime_guard = set_workspace_runtime_service_for_current_test(runtime.clone());
        let runtime_context = runtime
            .ensure_local_workspace_runtime(workspace.path())
            .await
            .unwrap()
            .context;
        let file = workspace.path().join("mutation.txt");
        let calls = Arc::new(AtomicUsize::new(0));
        let tool = wrap_tool_for_snapshot_tracking(Arc::new(CountingMutationTool {
            file_path: file.clone(),
            calls: calls.clone(),
            block_metadata_after_mutation: Some(runtime_context.snapshot_metadata_dir),
            fail_after_mutation: false,
        }));

        let results = tool
            .call(
                &serde_json::json!({ "file_path": "mutation.txt" }),
                &tool_context(workspace.path().to_path_buf(), "failed-completion").await,
            )
            .await
            .expect("snapshot completion failure must preserve tool success");

        assert_single_mutation(&file, &calls, "mutation\n");
        assert_success_with_snapshot_warning(&results, "snapshot tracking could not finish");
    }

    #[tokio::test]
    async fn wrapped_mutation_preserves_tool_error_without_repeating() {
        let workspace = TestWorkspace::new().await;
        let _runtime_guard = set_workspace_runtime_service_for_current_test(Arc::new(
            WorkspaceRuntimeService::new(Arc::new(PathManager::with_user_root_for_tests(
                workspace.path().join("user-root"),
            ))),
        ));
        let file = workspace.path().join("mutation.txt");
        let calls = Arc::new(AtomicUsize::new(0));
        let tool = wrap_tool_for_snapshot_tracking(Arc::new(CountingMutationTool {
            file_path: file.clone(),
            calls: calls.clone(),
            block_metadata_after_mutation: None,
            fail_after_mutation: true,
        }));

        let error = tool
            .call(
                &serde_json::json!({ "file_path": "mutation.txt" }),
                &tool_context(workspace.path().to_path_buf(), "failed-tool").await,
            )
            .await
            .expect_err("original tool error must propagate");

        assert!(
            error
                .to_string()
                .contains("original tool error after mutation"),
            "{error}"
        );
        assert_single_mutation(&file, &calls, "mutation\n");
    }

    #[cfg(feature = "remote-workspace")]
    #[tokio::test]
    async fn wrapped_remote_mutation_preserves_tool_error_without_repeating() {
        let workspace = TestWorkspace::new().await;
        let remote_root = format!("/openbitfun-tests/snapshot-single-call/{}", Uuid::new_v4());
        let connection_id = format!("snapshot-test-{}", Uuid::new_v4());
        let mut context = tool_context(workspace.path().to_path_buf(), "failed-remote-tool").await;
        let record = crate::service::workspace::legacy_compat::register_remote_fixture(
            &remote_root,
            &connection_id,
            "test-host",
        )
        .await;
        context.workspace = Some(WorkspaceBinding::new_remote(
            Some(record.id.clone()),
            PathBuf::from(&remote_root),
            connection_id.clone(),
            "test".into(),
            openbitfun_services_core::workspace_identity::WorkspaceSessionIdentity {
                workspace_kind: openbitfun_core_types::WorkspaceKind::Remote,
                hostname: "test-host".into(),
                logical_workspace_path: remote_root.clone(),
                remote_connection_id: Some(connection_id),
            },
        ));
        let file = workspace.path().join("mutation.txt");
        let calls = Arc::new(AtomicUsize::new(0));
        let tool = wrap_tool_for_snapshot_tracking(Arc::new(CountingMutationTool {
            file_path: file.clone(),
            calls: calls.clone(),
            block_metadata_after_mutation: None,
            fail_after_mutation: true,
        }));

        let result = tool
            .call(
                &serde_json::json!({ "file_path": "mutation.txt" }),
                &context,
            )
            .await;

        let error = result.expect_err("remote tool error must propagate");
        assert!(
            error
                .to_string()
                .contains("original tool error after mutation"),
            "{error}"
        );
        assert_single_mutation(&file, &calls, "mutation\n");
        assert!(get_snapshot_manager_for_workspace(&record.id).is_none());
    }

    #[tokio::test]
    async fn delete_keeps_its_input_path_instead_of_canonical_permission_resource() {
        let workspace = TestWorkspace::new().await;
        let context = tool_context(workspace.path().to_path_buf(), "delete-session").await;
        let tool = super::WrappedTool::new(Arc::new(DeleteFileTool::new()));

        assert_eq!(
            tool.extract_file_path(&serde_json::json!({ "path": "link.txt" }), &context)
                .expect("Delete path"),
            PathBuf::from("link.txt")
        );
    }

    #[tokio::test]
    async fn wrapped_delete_rejects_symlink_before_mutation() {
        let workspace = TestWorkspace::new().await;
        let _runtime_guard = set_workspace_runtime_service_for_current_test(Arc::new(
            WorkspaceRuntimeService::new(Arc::new(PathManager::with_user_root_for_tests(
                workspace.path().join("user-root"),
            ))),
        ));
        let target = workspace.path().join("target.txt");
        let link = workspace.path().join("link.txt");
        std::fs::write(&target, "target").expect("target file");
        #[cfg(unix)]
        std::os::unix::fs::symlink(&target, &link).expect("file symlink");
        #[cfg(windows)]
        if std::os::windows::fs::symlink_file(&target, &link).is_err() {
            return;
        }
        let context = tool_context(workspace.path().to_path_buf(), "delete-link-session").await;
        let tool = wrap_tool_for_snapshot_tracking(Arc::new(DeleteFileTool::new()));

        let error = tool
            .call(&serde_json::json!({ "path": "link.txt" }), &context)
            .await
            .expect_err("Snapshot-tracked Delete must reject a symlink");

        assert!(error.to_string().contains("symbolic link"));
        assert!(std::fs::symlink_metadata(&link)
            .expect("link must remain")
            .file_type()
            .is_symlink());
        assert_eq!(std::fs::read_to_string(target).unwrap(), "target");
    }

    #[tokio::test]
    async fn wrapped_write_payload_records_and_rolls_back_created_file() {
        let workspace = TestWorkspace::new().await;
        let _runtime_guard = set_workspace_runtime_service_for_current_test(Arc::new(
            WorkspaceRuntimeService::new(Arc::new(PathManager::with_user_root_for_tests(
                workspace.path().join("user-root"),
            ))),
        ));
        let alias_anchor = workspace.path().join("alias-anchor");
        std::fs::create_dir_all(&alias_anchor).expect("alias anchor");
        let workspace_alias = alias_anchor.join("..");
        let context = tool_context(workspace_alias, "write-session").await;
        let tool = wrap_tool_for_snapshot_tracking(Arc::new(FileWriteTool::new()));
        let file = workspace.path().join("new/deep/file.txt");

        tool.call(
            &serde_json::json!({ "payload": "+++ new/deep/file.txt\ncreated" }),
            &context,
        )
        .await
        .expect("wrapped Write should succeed");

        let manager = get_snapshot_manager_for_workspace(&workspace.id)
            .expect("Write should initialize snapshot manager");
        assert_eq!(
            manager
                .get_session_files("write-session")
                .await
                .expect("recorded files"),
            vec![dunce::canonicalize(&file).expect("canonical written file")]
        );

        manager
            .rollback_session("write-session")
            .await
            .expect("rollback created file");
        assert!(!file.exists());
    }

    #[tokio::test(flavor = "multi_thread", worker_threads = 2)]
    async fn concurrent_get_or_create_initializes_snapshot_manager_once_per_workspace() {
        let _test_guard = snapshot_manager_test_serial_lock().lock().await;
        let workspace = TestWorkspace::new().await;
        let _runtime_guard = set_workspace_runtime_service_for_current_test(Arc::new(
            WorkspaceRuntimeService::new(Arc::new(PathManager::with_user_root_for_tests(
                workspace.path().join("user-root"),
            ))),
        ));
        clear_snapshot_manager_for_test(&workspace.id);
        observe_snapshot_manager_new_for_test(workspace.path());
        set_snapshot_manager_new_delay_for_test(Duration::from_millis(80));

        let first = get_or_create_snapshot_manager(&workspace.id, None);
        let second = get_or_create_snapshot_manager(&workspace.id, None);
        let (first, second) = tokio::join!(first, second);

        set_snapshot_manager_new_delay_for_test(Duration::ZERO);

        let first = first.expect("first snapshot manager should initialize");
        let second = second.expect("second snapshot manager should initialize");

        assert!(Arc::ptr_eq(&first, &second));
        assert_eq!(snapshot_manager_new_count_for_test(), 1);
    }

    #[tokio::test]
    async fn read_only_view_reloads_persisted_history_without_becoming_a_writer() {
        let workspace = TestWorkspace::new().await;
        let _runtime_guard = set_workspace_runtime_service_for_current_test(Arc::new(
            WorkspaceRuntimeService::new(Arc::new(PathManager::with_user_root_for_tests(
                workspace.path().join("user-root"),
            ))),
        ));
        let file = workspace.path().join("tracked.txt");
        tokio::fs::write(&file, "before").await.expect("seed file");
        let writer = get_or_create_snapshot_manager(&workspace.id, None)
            .await
            .expect("writer manager");
        let operation_id = writer
            .record_file_change(
                "session-1",
                1,
                file.clone(),
                OperationType::Modify,
                "test".to_string(),
            )
            .await
            .expect("start operation");
        tokio::fs::write(&file, "after").await.expect("change file");
        writer
            .get_snapshot_service()
            .read()
            .await
            .complete_file_modification("session-1", &operation_id, 1)
            .await
            .expect("complete operation");
        clear_snapshot_manager_for_test(&workspace.id);

        let view = open_snapshot_manager_for_view(&workspace.id)
            .await
            .expect("read-only view");

        assert_eq!(
            view.get_session_files("session-1").await.unwrap(),
            vec![file]
        );
        assert!(get_snapshot_manager_for_workspace(&workspace.id).is_none());
        let error = view
            .record_file_change(
                "session-2",
                1,
                workspace.path().join("blocked.txt"),
                OperationType::Create,
                "test".to_string(),
            )
            .await
            .expect_err("read-only view must reject mutations");
        assert!(error.to_string().contains("read-only"), "{error}");
    }

    #[tokio::test]
    async fn view_manager_is_cached_and_superseded_by_a_later_writer() {
        let workspace = TestWorkspace::new().await;
        let _runtime_guard = set_workspace_runtime_service_for_current_test(Arc::new(
            WorkspaceRuntimeService::new(Arc::new(PathManager::with_user_root_for_tests(
                workspace.path().join("user-root"),
            ))),
        ));
        clear_snapshot_manager_for_test(&workspace.id);

        let first_view = open_snapshot_manager_for_view(&workspace.id)
            .await
            .expect("first view");
        let second_view = open_snapshot_manager_for_view(&workspace.id)
            .await
            .expect("second view");
        assert!(
            Arc::ptr_eq(&first_view, &second_view),
            "repeated view opens must reuse the cached view instead of reloading the index"
        );

        let writer = get_or_create_snapshot_manager(&workspace.id, None)
            .await
            .expect("writer manager");
        let view_after_writer = open_snapshot_manager_for_view(&workspace.id)
            .await
            .expect("view after writer");
        assert!(
            Arc::ptr_eq(&view_after_writer, &writer),
            "a registered writer must supersede the cached read-only view"
        );
        assert!(
            !Arc::ptr_eq(&view_after_writer, &first_view),
            "the stale pre-writer view must not be served once a writer owns live state"
        );
    }

    #[tokio::test(flavor = "multi_thread", worker_threads = 2)]
    async fn read_only_view_waits_for_an_in_flight_writer_initialization() {
        let _test_guard = snapshot_manager_test_serial_lock().lock().await;
        let workspace = TestWorkspace::new().await;
        let _runtime_guard = set_workspace_runtime_service_for_current_test(Arc::new(
            WorkspaceRuntimeService::new(Arc::new(PathManager::with_user_root_for_tests(
                workspace.path().join("user-root"),
            ))),
        ));
        clear_snapshot_manager_for_test(&workspace.id);
        observe_snapshot_manager_new_for_test(workspace.path());
        set_snapshot_manager_new_delay_for_test(Duration::from_millis(80));

        let workspace_id = workspace.id.clone();
        let writer_task = tokio::spawn(async move {
            get_or_create_snapshot_manager(&workspace_id, None)
                .await
                .expect("writer manager")
        });
        while snapshot_manager_new_count_for_test() == 0 {
            tokio::task::yield_now().await;
        }
        let alias_anchor = workspace.path().join("alias-anchor");
        std::fs::create_dir_all(&alias_anchor).expect("alias anchor");
        let workspace_alias = alias_anchor.join("..");
        let alias_record = crate::service::workspace::legacy_compat::register_local_fixture(
            &workspace_alias,
            None,
        )
        .await;
        assert_eq!(alias_record.id, workspace.id);
        let view = open_snapshot_manager_for_view(&alias_record.id)
            .await
            .expect("aliased view waits for writer");
        let writer = writer_task.await.expect("writer task");
        set_snapshot_manager_new_delay_for_test(Duration::ZERO);

        assert!(Arc::ptr_eq(&view, &writer));
    }
}
