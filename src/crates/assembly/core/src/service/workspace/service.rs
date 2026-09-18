//! Workspace service - advanced workspace management API
//!
//! Provides comprehensive workspace management functionality.

use super::manager::{
    PrimaryAssistantKey, RelatedPath, ScanOptions, WorkspaceIdentity, WorkspaceInfo, WorkspaceKind,
    WorkspaceManager, WorkspaceManagerConfig, WorkspaceManagerStatistics, WorkspaceOpenOptions,
    WorkspaceStatus, WorkspaceSummary, WorkspaceType, WorkspaceWorktreeInfo,
};
use super::manager::{WorkspaceIdentityRuntimeExt, WorkspaceInfoRuntimeExt};
use super::persistence::{
    unsupported_workspace_persistence, validate_workspace_persistence_data,
    WorkspacePersistenceData, WORKSPACE_PERSISTENCE_FORMAT_VERSION,
};
use super::WorktreeTopologyFreshness;
use crate::infrastructure::storage::{PersistenceService, StorageOptions};
use crate::infrastructure::{try_get_path_manager_arc, PathManager};
use crate::service::bootstrap::{
    ensure_workspace_gitignore_ignores_openbitfun, initialize_workspace_persona_files,
};
#[cfg(feature = "git")]
use crate::service::git::{GitError, GitWorktreeInfo};
#[cfg(feature = "remote-workspace")]
use crate::service::remote_ssh::workspace_state::{
    get_remote_workspace_manager, init_remote_workspace_manager,
};
use crate::service::workspace_runtime::{
    try_get_workspace_runtime_service_arc, WorkspaceRuntimeService,
};
use crate::util::errors::*;
use log::{info, warn};
use openbitfun_core_types::product_identity::product_id;
use openbitfun_services_core::workspace_identity::{
    canonicalize_local_workspace_root, local_workspace_roots_equal,
    normalize_remote_workspace_path, remote_workspace_stable_id,
};

use serde::{Deserialize, Serialize};
use std::collections::HashSet;
use std::path::{Path, PathBuf};
use std::sync::Arc;
use tokio::fs;
use tokio::sync::RwLock;

const MAX_WORKSPACE_NAME_CHARS: usize = 80;

/// Workspace service.
pub struct WorkspaceService {
    manager: Arc<RwLock<WorkspaceManager>>,
    #[allow(dead_code)]
    config: WorkspaceManagerConfig,
    persistence: Arc<PersistenceService>,
    path_manager: Arc<PathManager>,
    runtime_service: Arc<WorkspaceRuntimeService>,
}

/// Workspace creation options.
#[derive(Debug, Clone)]
pub struct WorkspaceCreateOptions {
    pub scan_options: ScanOptions,
    pub auto_set_current: bool,
    pub add_to_recent: bool,
    pub workspace_kind: WorkspaceKind,
    pub assistant_id: Option<String>,
    pub display_name: Option<String>,
    pub description: Option<String>,
    pub tags: Vec<String>,
    /// See [`crate::service::workspace::manager::WorkspaceOpenOptions::remote_connection_id`].
    pub remote_connection_id: Option<String>,
    /// SSH `host` from connection config; used for `~/.openbitfun/remote_ssh/...` and stable remote ids.
    pub remote_ssh_host: Option<String>,
    /// Deterministic id for [`WorkspaceKind::Remote`] (host + remote path hash).
    pub stable_workspace_id: Option<String>,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum WorkspaceActivityMode {
    TouchOnly,
    RefreshMetadata,
}

impl Default for WorkspaceCreateOptions {
    fn default() -> Self {
        Self {
            scan_options: ScanOptions::default(),
            auto_set_current: true,
            add_to_recent: true,
            workspace_kind: WorkspaceKind::Normal,
            assistant_id: None,
            display_name: None,
            description: None,
            tags: Vec::new(),
            remote_connection_id: None,
            remote_ssh_host: None,
            stable_workspace_id: None,
        }
    }
}

/// Batch import result.
#[derive(Debug, Serialize, Deserialize)]
pub struct BatchImportResult {
    pub successful: Vec<String>,
    pub failed: Vec<(String, String)>, // (path, error_message)
    pub total_processed: usize,
    pub skipped: Vec<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct WorkspaceIdentityChangedEvent {
    pub workspace_id: String,
    pub workspace_path: String,
    pub name: String,
    pub identity: Option<WorkspaceIdentity>,
    pub changed_fields: Vec<String>,
}

#[derive(Debug, Clone)]
struct AssistantWorkspaceDescriptor {
    path: PathBuf,
    assistant_id: Option<String>,
    display_name: String,
}

impl WorkspaceService {
    fn normalize_workspace_name(name: String) -> OpenBitFunResult<String> {
        let name = name.trim();

        if name.is_empty() {
            return Err(OpenBitFunError::service("Workspace name cannot be empty"));
        }

        if name.chars().any(char::is_control) {
            return Err(OpenBitFunError::service(
                "Workspace name cannot contain control characters",
            ));
        }

        if name.chars().count() > MAX_WORKSPACE_NAME_CHARS {
            return Err(OpenBitFunError::service(format!(
                "Workspace name cannot exceed {MAX_WORKSPACE_NAME_CHARS} characters"
            )));
        }

        Ok(name.to_string())
    }

    fn collect_startup_restored_workspaces(manager: &WorkspaceManager) -> Vec<WorkspaceInfo> {
        let mut targets = Vec::new();
        let mut seen_workspace_ids = HashSet::new();

        if let Some(workspace) = manager.get_current_workspace() {
            Self::push_startup_restored_workspace(&mut targets, &mut seen_workspace_ids, workspace);
        }

        for workspace in manager.get_opened_workspace_infos() {
            Self::push_startup_restored_workspace(&mut targets, &mut seen_workspace_ids, workspace);
        }

        targets
    }

    fn push_startup_restored_workspace(
        targets: &mut Vec<WorkspaceInfo>,
        seen_workspace_ids: &mut HashSet<String>,
        workspace: &WorkspaceInfo,
    ) {
        if seen_workspace_ids.insert(workspace.id.clone()) {
            targets.push(workspace.clone());
        }
    }

    async fn prepare_startup_restored_workspaces(&self, workspaces: Vec<WorkspaceInfo>) {
        for workspace in workspaces {
            self.ensure_workspace_gitignore_best_effort(&workspace, "restored")
                .await;
            self.ensure_workspace_runtime_best_effort(&workspace, "restored")
                .await;
        }
    }

    async fn ensure_workspace_gitignore_best_effort(
        &self,
        workspace: &WorkspaceInfo,
        trigger: &str,
    ) {
        if workspace.workspace_kind == WorkspaceKind::Remote || !workspace.root_path.exists() {
            return;
        }

        if let Err(e) = ensure_workspace_gitignore_ignores_openbitfun(&workspace.root_path).await {
            warn!(
                "Failed to ensure workspace .gitignore ignores {}: workspace_path={} trigger={} error={}",
                openbitfun_core_types::product_identity::hidden_data_directory(),
                workspace.root_path.display(),
                trigger,
                e
            );
        }
    }

    async fn ensure_workspace_runtime_best_effort(&self, workspace: &WorkspaceInfo, trigger: &str) {
        let result = match workspace.workspace_kind {
            WorkspaceKind::Remote => {
                let Some(ssh_host) = workspace
                    .metadata
                    .get("sshHost")
                    .and_then(|value| value.as_str())
                    .map(str::trim)
                    .filter(|value| !value.is_empty())
                else {
                    warn!(
                        "Skipping remote runtime ensure due to missing sshHost: workspace_id={} trigger={}",
                        workspace.id,
                        trigger
                    );
                    return;
                };

                self.runtime_service
                    .ensure_remote_workspace_runtime(
                        ssh_host,
                        &workspace.root_path.to_string_lossy(),
                    )
                    .await
            }
            _ => {
                if !workspace.root_path.exists() {
                    return;
                }

                self.runtime_service
                    .ensure_local_workspace_runtime(&workspace.root_path)
                    .await
            }
        };

        if let Err(e) = result {
            warn!(
                "Failed to initialize workspace runtime: workspace_path={} trigger={} error={}",
                workspace.root_path.display(),
                trigger,
                e
            );
        }
    }

    /// Creates a new workspace service.
    pub async fn new() -> OpenBitFunResult<Self> {
        let config = WorkspaceManagerConfig::default();
        Self::with_config(config).await
    }

    /// Creates a workspace service with a custom configuration.
    pub async fn with_config(config: WorkspaceManagerConfig) -> OpenBitFunResult<Self> {
        let path_manager = try_get_path_manager_arc()?;
        let runtime_service = try_get_workspace_runtime_service_arc()?;

        path_manager.initialize_user_directories().await?;

        let persistence = Arc::new(
            PersistenceService::new_user_level(path_manager.clone())
                .await
                .map_err(|e| {
                    OpenBitFunError::service(format!("Failed to create persistence service: {}", e))
                })?,
        );

        let manager = WorkspaceManager::new(config.clone());

        let service = Self {
            manager: Arc::new(RwLock::new(manager)),
            config,
            persistence,
            path_manager,
            runtime_service,
        };

        service.load_workspace_history_only().await?;

        if let Err(e) = service.ensure_assistant_workspaces().await {
            warn!("Failed to ensure assistant workspaces on startup: {}", e);
        }

        Ok(service)
    }

    /// Builds a workspace service whose catalog, persistence, and runtime
    /// state live under `user_root` instead of the real user data directory.
    ///
    /// In-process tests in downstream crates (CLI, ACP, server hosts) that
    /// exercise code paths creating workspace records must install this as the
    /// global workspace service before the first record is created. Otherwise
    /// the fixtures' temporary folders leak into the developer's real
    /// `workspace_data.json` as opened, current workspaces and the desktop
    /// fails to start a session in a folder that no longer exists.
    #[cfg(any(test, feature = "test-support"))]
    pub async fn new_isolated_for_tests(user_root: PathBuf) -> Self {
        Self::new_for_test_path_manager(Arc::new(PathManager::with_user_root_for_tests(user_root)))
            .await
    }

    #[cfg(any(test, feature = "test-support"))]
    pub(crate) async fn new_for_test_path_manager(path_manager: Arc<PathManager>) -> Self {
        path_manager
            .initialize_user_directories()
            .await
            .expect("test user directories should initialize");
        let config = WorkspaceManagerConfig::default();
        let persistence = Arc::new(
            PersistenceService::new_user_level(path_manager.clone())
                .await
                .expect("test persistence should initialize"),
        );
        let runtime_service = Arc::new(WorkspaceRuntimeService::new(path_manager.clone()));
        Self {
            manager: Arc::new(RwLock::new(WorkspaceManager::new(config.clone()))),
            config,
            persistence,
            path_manager,
            runtime_service,
        }
    }

    /// Returns the path manager.
    pub fn path_manager(&self) -> &Arc<PathManager> {
        &self.path_manager
    }

    /// Returns the persistence service.
    pub fn persistence(&self) -> &Arc<PersistenceService> {
        &self.persistence
    }

    pub fn runtime_service(&self) -> &Arc<WorkspaceRuntimeService> {
        &self.runtime_service
    }

    /// Opens a workspace.
    pub async fn open_workspace(&self, path: PathBuf) -> OpenBitFunResult<WorkspaceInfo> {
        self.open_workspace_with_options(path, WorkspaceCreateOptions::default())
            .await
    }

    /// Resolves the stable workspace record for a local directory operand
    /// without changing what the user sees as open.
    ///
    /// `open_workspace` is the explicit "open this folder" action: it marks the
    /// record opened, pushes it into the recent list, and makes it the current
    /// workspace of the shared catalog. Hosts that merely receive a directory
    /// as an operand (CLI commands run in a cwd, ACP `cwd`, headless helpers)
    /// must not do that, because the same catalog drives the desktop sidebar
    /// and the desktop's startup workspace. This registers (or touches) the
    /// record so sessions and runtime ownership can be addressed by ID, and
    /// leaves opened/recent/current state untouched.
    pub async fn register_local_workspace_record(
        &self,
        path: PathBuf,
    ) -> OpenBitFunResult<WorkspaceInfo> {
        self.track_workspace_activity(
            path,
            WorkspaceCreateOptions {
                add_to_recent: false,
                auto_set_current: false,
                ..Default::default()
            },
            WorkspaceActivityMode::TouchOnly,
        )
        .await
    }

    async fn register_worktree_project(
        &self,
        mut tree: Option<WorkspaceWorktreeInfo>,
    ) -> OpenBitFunResult<Option<WorkspaceWorktreeInfo>> {
        if let Some(tree) = tree.as_mut().filter(|tree| !tree.is_main) {
            let parent = self
                .manager
                .write()
                .await
                .track_workspace_with_options(
                    PathBuf::from(&tree.main_repo_path),
                    WorkspaceOpenOptions {
                        auto_set_current: false,
                        add_to_recent: false,
                        ..Default::default()
                    },
                    None,
                )
                .await?;
            tree.main_workspace_id = Some(parent.id);
        }
        Ok(tree)
    }

    /// Opens a workspace with explicit workspace metadata.
    pub async fn open_workspace_with_options(
        &self,
        path: PathBuf,
        options: WorkspaceCreateOptions,
    ) -> OpenBitFunResult<WorkspaceInfo> {
        let options = self.normalize_workspace_options_for_path(&path, options);
        #[cfg(not(feature = "remote-workspace"))]
        if options.workspace_kind == WorkspaceKind::Remote {
            return Err(OpenBitFunError::service(
                "Remote workspace support is not compiled into this product profile",
            ));
        }
        let worktree = if options.workspace_kind == WorkspaceKind::Remote {
            None
        } else {
            WorkspaceInfo::resolve_worktree_info(&path, WorktreeTopologyFreshness::Cached).await
        };
        let worktree = self.register_worktree_project(worktree).await?;
        let result = {
            let mut manager = self.manager.write().await;
            manager
                .open_workspace_with_resolved_worktree(
                    path,
                    Self::to_manager_open_options(&options),
                    worktree,
                )
                .await
        };

        if let Ok(workspace) = result.as_ref() {
            self.ensure_workspace_gitignore_best_effort(workspace, "opened")
                .await;
            self.ensure_workspace_runtime_best_effort(workspace, "opened")
                .await;
            #[cfg(feature = "remote-workspace")]
            if workspace.workspace_kind == WorkspaceKind::Remote {
                self.register_remote_workspace_runtime(workspace).await;
            }
        }

        if result.is_ok() {
            if let Err(e) = self.save_workspace_data().await {
                warn!("Failed to save workspace data after opening: {}", e);
            }
        }

        result
    }

    /// Validate a new remote folder against its explicitly selected saved connection.
    /// No existing workspace is selected through the folder path.
    pub(crate) async fn prepare_remote_workspace(
        &self,
        path: &str,
        connection_id: &str,
        ssh_host: Option<&str>,
    ) -> OpenBitFunResult<WorkspaceInfo> {
        #[cfg(feature = "ssh-remote")]
        {
            if !path.starts_with('/') || path.contains('\0') {
                return Err(OpenBitFunError::service(
                    "Remote workspace path must be an absolute POSIX path",
                ));
            }
            let manager =
                crate::service::remote_ssh::workspace_state::ensure_saved_connection_services()
                    .await
                    .map_err(OpenBitFunError::service)?;
            let ssh = manager
                .get_ssh_manager()
                .await
                .ok_or_else(|| OpenBitFunError::service("SSH connection manager is unavailable"))?;
            if !ssh
                .get_saved_connections()
                .await
                .iter()
                .any(|profile| profile.id == connection_id)
            {
                return Err(OpenBitFunError::service(
                    "Remote workspace connection is not saved on this host",
                ));
            }
            ssh.ensure_connected(connection_id)
                .await
                .map_err(|e| OpenBitFunError::service(e.to_string()))?;
            let config = ssh
                .get_connection_config(connection_id)
                .await
                .ok_or_else(|| OpenBitFunError::service("SSH connection is unavailable"))?;
            let host = ssh
                .get_saved_host_for_connection_id(connection_id)
                .await
                .unwrap_or(config.host);
            if ssh_host.is_some_and(|requested| requested != host) {
                return Err(OpenBitFunError::service(
                    "SSH host identity does not match the selected connection",
                ));
            }
            let fs = manager
                .get_file_service()
                .await
                .ok_or_else(|| OpenBitFunError::service("Remote file service is unavailable"))?;
            let path = normalize_remote_workspace_path(path);
            if !fs
                .is_dir(connection_id, &path)
                .await
                .map_err(|e| OpenBitFunError::service(e.to_string()))?
            {
                return Err(OpenBitFunError::service(
                    "Remote workspace path is not a directory",
                ));
            }
            let options = WorkspaceOpenOptions {
                workspace_kind: WorkspaceKind::Remote,
                remote_connection_id: Some(connection_id.to_string()),
                remote_ssh_host: Some(host.clone()),
                stable_workspace_id: Some(remote_workspace_stable_id(&host, &path)),
                ..Default::default()
            };
            return WorkspaceInfo::new_without_worktree(PathBuf::from(path), options).await;
        }
        #[cfg(not(feature = "ssh-remote"))]
        {
            let _ = (path, connection_id, ssh_host);
            Err(OpenBitFunError::service(
                "Opening a new remote workspace requires SSH support on this host",
            ))
        }
    }

    pub(crate) async fn open_known_remote_workspace(
        &self,
        known: &WorkspaceInfo,
    ) -> OpenBitFunResult<WorkspaceInfo> {
        let connection_id = known.remote_ssh_connection_id().ok_or_else(|| {
            OpenBitFunError::service(format!(
                "Remote workspace is missing connectionId metadata: {}",
                known.id
            ))
        })?;
        let ssh_host = known
            .metadata
            .get("sshHost")
            .and_then(|value| value.as_str())
            .map(str::trim)
            .filter(|value| !value.is_empty())
            .ok_or_else(|| {
                OpenBitFunError::service(format!(
                    "Remote workspace is missing sshHost metadata: {}",
                    known.id
                ))
            })?;

        let remote_path = normalize_remote_workspace_path(&known.root_path.to_string_lossy());
        let options = WorkspaceCreateOptions {
            workspace_kind: WorkspaceKind::Remote,
            display_name: Some(known.name.clone()),
            remote_connection_id: Some(connection_id.to_string()),
            remote_ssh_host: Some(ssh_host.to_string()),
            stable_workspace_id: Some(known.id.clone()),
            ..Default::default()
        };

        let mut opened = self
            .open_workspace_with_options(PathBuf::from(&remote_path), options)
            .await?;

        // Preserve desktop-authored metadata keys (connectionName, etc.) that are
        // not reconstructed from open options alone.
        {
            let mut manager = self.manager.write().await;
            if let Some(workspace) = manager.get_workspaces_mut().get_mut(&opened.id) {
                for (key, value) in &known.metadata {
                    workspace
                        .metadata
                        .entry(key.clone())
                        .or_insert(value.clone());
                }
                opened.metadata = workspace.metadata.clone();
            }
        }

        Ok(opened)
    }

    #[cfg(feature = "remote-workspace")]
    async fn register_remote_workspace_runtime(&self, workspace: &WorkspaceInfo) {
        let Some(connection_id) = workspace.remote_ssh_connection_id() else {
            warn!(
                "Skipping remote workspace registry update: missing connectionId for {}",
                workspace.id
            );
            return;
        };
        let Some(ssh_host) = workspace
            .metadata
            .get("sshHost")
            .and_then(|value| value.as_str())
            .map(str::trim)
            .filter(|value| !value.is_empty())
        else {
            warn!(
                "Skipping remote workspace registry update: missing sshHost for {}",
                workspace.id
            );
            return;
        };
        let connection_name = workspace
            .metadata
            .get("connectionName")
            .and_then(|value| value.as_str())
            .map(str::trim)
            .filter(|value| !value.is_empty())
            .unwrap_or(ssh_host)
            .to_string();
        let remote_path = normalize_remote_workspace_path(&workspace.root_path.to_string_lossy());

        let state_manager = init_remote_workspace_manager();
        state_manager
            .register_remote_workspace(
                remote_path,
                connection_id.to_string(),
                connection_name,
                ssh_host.to_string(),
            )
            .await;
        state_manager
            .set_active_connection_hint(Some(connection_id.to_string()))
            .await;
    }

    /// Refreshes activity for a workspace selected by ID without opening it.
    /// The record decides local vs. remote; nothing is created or re-keyed.
    pub async fn track_workspace_activity_by_id(
        &self,
        workspace_id: &str,
        mode: WorkspaceActivityMode,
    ) -> OpenBitFunResult<WorkspaceInfo> {
        let workspace = self.require_workspace(workspace_id).await?;
        let refresh_worktree = match mode {
            WorkspaceActivityMode::TouchOnly => None,
            WorkspaceActivityMode::RefreshMetadata => {
                Some(if workspace.workspace_kind == WorkspaceKind::Remote {
                    None
                } else {
                    WorkspaceInfo::resolve_worktree_info(
                        &workspace.root_path,
                        WorktreeTopologyFreshness::Cached,
                    )
                    .await
                })
            }
        };
        let refresh_worktree = match refresh_worktree {
            Some(tree) => Some(self.register_worktree_project(tree).await?),
            None => None,
        };
        let result = self
            .manager
            .write()
            .await
            .touch_workspace_by_id(&workspace.id, true, refresh_worktree)
            .await;
        if let Ok(workspace) = result.as_ref() {
            self.ensure_workspace_runtime_best_effort(workspace, "tracked")
                .await;
        }
        if result.is_ok() {
            if let Err(e) = self.save_workspace_data().await {
                warn!(
                    "Failed to save workspace data after tracking activity: {}",
                    e
                );
            }
        }
        result
    }

    /// Registers or refreshes workspace activity without marking it as opened in the UI.
    pub async fn track_workspace_activity(
        &self,
        path: PathBuf,
        options: WorkspaceCreateOptions,
        mode: WorkspaceActivityMode,
    ) -> OpenBitFunResult<WorkspaceInfo> {
        let mut options = self.normalize_workspace_options_for_path(&path, options);
        options.auto_set_current = false;
        let refresh_worktree = match mode {
            WorkspaceActivityMode::TouchOnly => None,
            WorkspaceActivityMode::RefreshMetadata => {
                Some(if options.workspace_kind == WorkspaceKind::Remote {
                    None
                } else {
                    WorkspaceInfo::resolve_worktree_info(&path, WorktreeTopologyFreshness::Cached)
                        .await
                })
            }
        };
        let refresh_worktree = match refresh_worktree {
            Some(tree) => Some(self.register_worktree_project(tree).await?),
            None => None,
        };
        let result = {
            let mut manager = self.manager.write().await;
            manager
                .track_workspace_with_options(
                    path,
                    Self::to_manager_open_options(&options),
                    refresh_worktree,
                )
                .await
        };

        let result = match result {
            Ok(mut workspace)
                if workspace
                    .worktree
                    .as_ref()
                    .is_some_and(|tree| !tree.is_main && tree.main_workspace_id.is_none()) =>
            {
                workspace.worktree = self.register_worktree_project(workspace.worktree).await?;
                self.manager
                    .write()
                    .await
                    .get_workspaces_mut()
                    .insert(workspace.id.clone(), workspace.clone());
                Ok(workspace)
            }
            other => other,
        };
        if let Ok(workspace) = result.as_ref() {
            self.ensure_workspace_runtime_best_effort(workspace, "tracked")
                .await;
        }

        if result.is_ok() {
            if let Err(e) = self.save_workspace_data().await {
                warn!(
                    "Failed to save workspace data after tracking activity: {}",
                    e
                );
            }
        }

        result
    }

    #[cfg(feature = "git")]
    pub async fn list_worktrees(
        &self,
        path: &Path,
        freshness: WorktreeTopologyFreshness,
    ) -> Result<Vec<GitWorktreeInfo>, GitError> {
        super::worktree_topology::global_worktree_topology_service()
            .list_worktrees(path, freshness)
            .await
    }

    #[cfg(feature = "git")]
    pub async fn is_live_worktree_root_in_same_repository(
        &self,
        registered_path: &Path,
        candidate: &Path,
    ) -> Result<bool, GitError> {
        super::worktree_topology::global_worktree_topology_service()
            .is_live_worktree_root_in_same_repository(registered_path, candidate)
            .await
    }

    #[cfg(feature = "git")]
    pub async fn invalidate_worktree_topology(&self, path: &Path) {
        super::worktree_topology::global_worktree_topology_service()
            .invalidate(path)
            .await;
    }

    /// Quickly opens a workspace (using default options).
    pub async fn quick_open(&self, path: &str) -> OpenBitFunResult<WorkspaceInfo> {
        let path_buf = PathBuf::from(path);
        self.open_workspace(path_buf).await
    }

    /// Creates a workspace (for a new project).
    pub async fn create_workspace(
        &self,
        path: PathBuf,
        options: WorkspaceCreateOptions,
    ) -> OpenBitFunResult<WorkspaceInfo> {
        if !path.exists() {
            tokio::fs::create_dir_all(&path).await.map_err(|e| {
                OpenBitFunError::service(format!("Failed to create workspace directory: {}", e))
            })?;
        }

        let mut workspace = self
            .open_workspace_with_options(path, options.clone())
            .await?;

        if let Some(description) = options.description {
            workspace.description = Some(description);
        }

        workspace.tags = options.tags;

        {
            let mut manager = self.manager.write().await;
            manager
                .get_workspaces_mut()
                .insert(workspace.id.clone(), workspace.clone());
        }

        self.save_workspace_data().await?;

        Ok(workspace)
    }

    /// Creates and opens a new assistant workspace, then sets it as current.
    pub async fn create_assistant_workspace(
        &self,
        assistant_id: Option<String>,
    ) -> OpenBitFunResult<WorkspaceInfo> {
        let assistant_id = match assistant_id {
            Some(id) if !id.trim().is_empty() => id.trim().to_string(),
            _ => self.generate_assistant_workspace_id().await?,
        };
        let display_name = Self::assistant_display_name(Some(&assistant_id));
        let path = self
            .path_manager
            .assistant_workspace_dir(&assistant_id, None);
        let options = WorkspaceCreateOptions {
            auto_set_current: true,
            add_to_recent: false,
            workspace_kind: WorkspaceKind::Assistant,
            assistant_id: Some(assistant_id),
            display_name: Some(display_name),
            ..Default::default()
        };

        if !path.exists() {
            fs::create_dir_all(&path).await.map_err(|e| {
                OpenBitFunError::service(format!(
                    "Failed to create assistant workspace directory '{}': {}",
                    path.display(),
                    e
                ))
            })?;
        }

        // New assistant dirs get persona files at creation; coordinator also fills missing files when opening.
        initialize_workspace_persona_files(&path).await?;

        let workspace = self.create_workspace(path, options).await?;
        let selection_changed = {
            let mut manager = self.manager.write().await;
            manager.ensure_primary_assistant_selection()
        };
        if selection_changed {
            self.save_workspace_data().await?;
        }

        Ok(workspace)
    }

    /// Closes the current workspace.
    pub async fn close_current_workspace(&self) -> OpenBitFunResult<()> {
        let result = {
            let mut manager = self.manager.write().await;
            manager.close_current_workspace()
        };

        if result.is_ok() {
            if let Err(e) = self.save_workspace_data().await {
                warn!("Failed to save workspace data after closing: {}", e);
            }
        }

        result
    }

    /// Closes the specified workspace.
    pub async fn close_workspace(&self, workspace_id: &str) -> OpenBitFunResult<()> {
        let result = {
            let mut manager = self.manager.write().await;
            manager.close_workspace(workspace_id)
        };

        if result.is_ok() {
            if let Err(e) = self.save_workspace_data().await {
                warn!("Failed to save workspace data after closing: {}", e);
            }
        }

        result
    }

    /// Sets the active workspace from the opened workspace list.
    pub async fn set_active_workspace(&self, workspace_id: &str) -> OpenBitFunResult<()> {
        let result = {
            let mut manager = self.manager.write().await;
            manager.set_active_workspace(workspace_id)
        };

        if result.is_ok() {
            if let Err(e) = self.save_workspace_data().await {
                warn!(
                    "Failed to save workspace data after switching active workspace: {}",
                    e
                );
            }
        }

        if result.is_ok() {
            if let Some(workspace) = self.get_workspace(workspace_id).await {
                self.ensure_workspace_runtime_best_effort(&workspace, "activated")
                    .await;
            }
        }

        result
    }

    /// Reorders the opened workspaces without changing active or recent state.
    pub async fn reorder_opened_workspaces(
        &self,
        workspace_ids: Vec<String>,
    ) -> OpenBitFunResult<()> {
        let current_ids = {
            let manager = self.manager.read().await;
            manager.get_opened_workspace_ids().clone()
        };

        if workspace_ids.len() != current_ids.len() {
            return Err(OpenBitFunError::service(format!(
                "Opened workspace count mismatch: expected {}, got {}",
                current_ids.len(),
                workspace_ids.len()
            )));
        }

        let requested_ids = workspace_ids.iter().cloned().collect::<HashSet<_>>();
        if requested_ids.len() != workspace_ids.len() {
            return Err(OpenBitFunError::service(
                "Opened workspace order contains duplicate ids".to_string(),
            ));
        }

        let current_id_set = current_ids.iter().cloned().collect::<HashSet<_>>();
        if requested_ids != current_id_set {
            return Err(OpenBitFunError::service(
                "Opened workspace order must contain exactly the currently opened workspace ids"
                    .to_string(),
            ));
        }

        {
            let mut manager = self.manager.write().await;
            manager.set_opened_workspace_ids(workspace_ids.clone());
        }

        if let Err(error) = self.save_workspace_data().await {
            let mut manager = self.manager.write().await;
            manager.set_opened_workspace_ids(current_ids);
            return Err(error);
        }

        Ok(())
    }

    /// Switches to the specified workspace.
    pub async fn switch_to_workspace(&self, workspace_id: &str) -> OpenBitFunResult<()> {
        self.set_active_workspace(workspace_id).await
    }

    /// Returns the current workspace.
    pub async fn get_current_workspace(&self) -> Option<WorkspaceInfo> {
        let manager = self.manager.read().await;
        manager.get_current_workspace().cloned()
    }

    /// Best-effort synchronous read for contexts that cannot `await`.
    pub fn try_get_current_workspace_path(&self) -> Option<PathBuf> {
        self.manager.try_read().ok().and_then(|manager| {
            manager
                .get_current_workspace()
                .map(|workspace| workspace.root_path.clone())
        })
    }

    /// Reopen/select a persisted workspace without re-identifying it by path.
    pub async fn open_workspace_by_id(
        &self,
        workspace_id: &str,
    ) -> OpenBitFunResult<WorkspaceInfo> {
        let workspace = self.require_workspace(workspace_id).await?;
        #[cfg(not(feature = "remote-workspace"))]
        if workspace.workspace_kind == WorkspaceKind::Remote {
            return Err(OpenBitFunError::service(
                "Remote workspace support is not compiled into this product profile",
            ));
        }
        if workspace.workspace_kind != WorkspaceKind::Remote && !workspace.root_path.is_dir() {
            return Err(OpenBitFunError::service(
                "The selected local workspace directory is unavailable",
            ));
        }
        self.manager
            .write()
            .await
            .set_current_workspace(workspace.id.clone())?;
        self.save_workspace_data().await?;
        self.ensure_workspace_runtime_best_effort(&workspace, "opened by ID")
            .await;
        #[cfg(feature = "remote-workspace")]
        if workspace.workspace_kind == WorkspaceKind::Remote {
            self.register_remote_workspace_runtime(&workspace).await;
        }
        self.require_workspace(workspace_id).await
    }

    /// Returns workspace details.
    pub async fn get_workspace(&self, workspace_id: &str) -> Option<WorkspaceInfo> {
        let manager = self.manager.read().await;
        manager.get_workspace(workspace_id).cloned()
    }

    /// Resolve an identity on this host. Paths and SSH hints cannot redirect it.
    pub async fn require_workspace(&self, workspace_id: &str) -> OpenBitFunResult<WorkspaceInfo> {
        if workspace_id.trim().is_empty() {
            return Err(OpenBitFunError::service("Workspace ID is required"));
        }
        self.get_workspace(workspace_id).await.ok_or_else(|| {
            OpenBitFunError::service(format!(
                "Workspace ID is unavailable on this host: {workspace_id}"
            ))
        })
    }

    /// Returns all currently opened workspaces.
    pub async fn get_opened_workspaces(&self) -> Vec<WorkspaceInfo> {
        let manager = self.manager.read().await;
        manager
            .get_opened_workspace_infos()
            .into_iter()
            .cloned()
            .collect()
    }

    /// All tracked workspaces with full metadata (insights, maintenance, etc.).
    pub async fn list_workspace_infos(&self) -> Vec<WorkspaceInfo> {
        let manager = self.manager.read().await;
        manager.get_workspaces().values().cloned().collect()
    }

    /// Returns all tracked assistant workspaces, including inactive ones.
    pub async fn get_assistant_workspaces(&self) -> Vec<WorkspaceInfo> {
        let manager = self.manager.read().await;
        manager
            .get_workspaces()
            .values()
            .filter(|workspace| workspace.workspace_kind == WorkspaceKind::Assistant)
            .cloned()
            .collect()
    }

    /// Returns the assistant workspace currently assigned the primary role.
    pub async fn get_primary_assistant_workspace(&self) -> Option<WorkspaceInfo> {
        let manager = self.manager.read().await;
        manager.get_primary_assistant_workspace().cloned()
    }

    /// Assigns the primary role to an existing assistant workspace.
    pub async fn set_primary_assistant_workspace(
        &self,
        workspace_id: &str,
    ) -> OpenBitFunResult<WorkspaceInfo> {
        let (workspace, previous_key) = {
            let mut manager = self.manager.write().await;
            let workspace = manager
                .get_workspace(workspace_id)
                .cloned()
                .ok_or_else(|| {
                    OpenBitFunError::service(format!("Workspace not found: {}", workspace_id))
                })?;
            let previous_key = manager.set_primary_assistant_workspace(workspace_id)?;
            (workspace, previous_key)
        };

        if let Err(error) = self.save_workspace_data().await {
            let mut manager = self.manager.write().await;
            manager.set_primary_assistant_key(previous_key);
            return Err(error);
        }

        Ok(workspace)
    }

    /// Returns whether the workspace currently owns the primary assistant role.
    pub async fn is_primary_assistant_workspace(&self, workspace_id: &str) -> bool {
        self.get_primary_assistant_workspace()
            .await
            .is_some_and(|workspace| workspace.id == workspace_id)
    }

    /// Lists all workspaces.
    pub async fn list_workspaces(&self) -> Vec<WorkspaceSummary> {
        let manager = self.manager.read().await;
        manager.list_workspaces()
    }

    /// Lists workspaces by type.
    pub async fn list_workspaces_by_type(
        &self,
        workspace_type: WorkspaceType,
    ) -> Vec<WorkspaceSummary> {
        let manager = self.manager.read().await;
        manager
            .list_workspaces()
            .into_iter()
            .filter(|ws| ws.workspace_type == workspace_type)
            .collect()
    }

    /// Lists workspaces by status.
    pub async fn list_workspaces_by_status(
        &self,
        status: WorkspaceStatus,
    ) -> Vec<WorkspaceSummary> {
        let manager = self.manager.read().await;
        manager
            .list_workspaces()
            .into_iter()
            .filter(|ws| ws.status == status)
            .collect()
    }

    /// Returns recently accessed workspaces.
    pub async fn get_recent_workspaces(&self) -> Vec<WorkspaceInfo> {
        let manager = self.manager.read().await;
        let recent_ids = manager.get_recent_workspaces();
        let mut recent_workspaces = Vec::new();

        for workspace_id in recent_ids {
            if let Some(workspace) = manager.get_workspaces().get(workspace_id) {
                recent_workspaces.push(workspace.clone());
            }
        }

        recent_workspaces
    }

    /// Returns recently accessed assistant workspaces.
    pub async fn get_recent_assistant_workspaces(&self) -> Vec<WorkspaceInfo> {
        let manager = self.manager.read().await;
        let recent_ids = manager.get_recent_assistant_workspaces();
        let mut recent_workspaces = Vec::new();

        for workspace_id in recent_ids {
            if let Some(workspace) = manager.get_workspaces().get(workspace_id) {
                recent_workspaces.push(workspace.clone());
            }
        }

        recent_workspaces
    }

    /// Drops a workspace from recent lists only (workspace record and open state unchanged).
    pub async fn remove_workspace_from_recent(&self, workspace_id: &str) -> OpenBitFunResult<()> {
        let changed = {
            let mut manager = self.manager.write().await;
            manager.remove_from_recent_workspaces_only(workspace_id)
        };
        if changed {
            self.save_workspace_data().await?;
        }
        Ok(())
    }

    /// Searches workspaces.
    pub async fn search_workspaces(&self, query: &str) -> Vec<WorkspaceSummary> {
        let manager = self.manager.read().await;
        manager.search_workspaces(query)
    }

    /// Removes a workspace.
    pub async fn remove_workspace(&self, workspace_id: &str) -> OpenBitFunResult<()> {
        let (_removed_workspace, result) = {
            let mut manager = self.manager.write().await;
            let workspace = manager.get_workspace(workspace_id).cloned();
            let result = manager.remove_workspace(workspace_id);
            (workspace, result)
        };

        if result.is_ok() {
            #[cfg(feature = "workspace-search")]
            if let Some(workspace) = _removed_workspace {
                if workspace.workspace_kind != WorkspaceKind::Remote {
                    if let Some(search_service) =
                        crate::service::search::get_global_workspace_search_service()
                    {
                        search_service
                            .remove_workspace_index(&workspace.root_path)
                            .await;
                    }
                }
            }
            if let Err(e) = self.save_workspace_data().await {
                warn!("Failed to save workspace data after removal: {}", e);
            }
        }

        result
    }

    /// Removes workspaces in batch.
    pub async fn batch_remove_workspaces(
        &self,
        workspace_ids: Vec<String>,
    ) -> OpenBitFunResult<BatchRemoveResult> {
        let mut result = BatchRemoveResult {
            successful: Vec::new(),
            failed: Vec::new(),
            total_processed: workspace_ids.len(),
        };

        for workspace_id in workspace_ids {
            match self.remove_workspace(&workspace_id).await {
                Ok(_) => result.successful.push(workspace_id),
                Err(e) => result.failed.push((workspace_id, e.to_string())),
            }
        }

        Ok(result)
    }

    /// Rescans a workspace.
    pub async fn rescan_workspace(&self, workspace_id: &str) -> OpenBitFunResult<WorkspaceInfo> {
        let workspace_path = {
            let manager = self.manager.read().await;
            if let Some(workspace) = manager.get_workspace(workspace_id) {
                workspace.root_path.clone()
            } else {
                return Err(OpenBitFunError::service(format!(
                    "Workspace not found: {}",
                    workspace_id
                )));
            }
        };

        let existing_workspace = {
            let manager = self.manager.read().await;
            manager.get_workspace(workspace_id).cloned()
        };
        let Some(existing_workspace) = existing_workspace else {
            return Err(OpenBitFunError::service(format!(
                "Workspace not found: {}",
                workspace_id
            )));
        };
        let worktree = if existing_workspace.workspace_kind == WorkspaceKind::Remote {
            None
        } else {
            let tree = WorkspaceInfo::resolve_worktree_info(
                &workspace_path,
                WorktreeTopologyFreshness::ForceRefresh,
            )
            .await;
            self.register_worktree_project(tree).await?
        };
        let new_workspace = WorkspaceInfo::new_without_worktree(
            workspace_path,
            WorkspaceOpenOptions {
                scan_options: ScanOptions::default(),
                auto_set_current: existing_workspace.status == WorkspaceStatus::Active,
                add_to_recent: false,
                workspace_kind: existing_workspace.workspace_kind.clone(),
                assistant_id: existing_workspace.assistant_id.clone(),
                display_name: Some(existing_workspace.name.clone()),
                remote_connection_id: existing_workspace
                    .remote_ssh_connection_id()
                    .map(str::to_string),
                remote_ssh_host: existing_workspace
                    .metadata
                    .get("sshHost")
                    .and_then(|v| v.as_str())
                    .filter(|s| !s.is_empty())
                    .map(|s| s.to_string()),
                stable_workspace_id: None,
            },
        )
        .await?;
        let mut new_workspace = new_workspace;
        new_workspace.worktree = worktree;
        new_workspace.id = existing_workspace.id.clone();
        new_workspace.opened_at = existing_workspace.opened_at;
        new_workspace.description = existing_workspace.description.clone();
        new_workspace.tags = existing_workspace.tags.clone();
        new_workspace.metadata = existing_workspace.metadata.clone();

        {
            let mut manager = self.manager.write().await;
            manager
                .get_workspaces_mut()
                .insert(workspace_id.to_string(), new_workspace.clone());
        }

        if let Err(e) = self.save_workspace_data().await {
            warn!("Failed to save workspace data after rescan: {}", e);
        }

        Ok(new_workspace)
    }

    /// Refreshes the parsed `IDENTITY.md` content for an assistant workspace.
    pub async fn refresh_workspace_identity(
        &self,
        workspace_id: &str,
    ) -> OpenBitFunResult<Option<WorkspaceIdentityChangedEvent>> {
        let workspace = {
            let manager = self.manager.read().await;
            manager.get_workspace(workspace_id).cloned()
        }
        .ok_or_else(|| {
            OpenBitFunError::service(format!("Workspace not found: {}", workspace_id))
        })?;

        if workspace.workspace_kind != WorkspaceKind::Assistant {
            return Ok(None);
        }

        let updated_identity =
            match WorkspaceIdentity::load_from_workspace_root(&workspace.root_path).await {
                Ok(identity) => identity,
                Err(error) => {
                    warn!(
                        "Failed to refresh workspace identity: workspace_id={} path={} error={}",
                        workspace_id,
                        workspace.root_path.display(),
                        error
                    );
                    return Ok(None);
                }
            };

        let changed_fields = WorkspaceIdentity::collect_changed_fields(
            workspace.identity.as_ref(),
            updated_identity.as_ref(),
        );
        let fallback_name = Self::assistant_display_name(workspace.assistant_id.as_deref());
        let updated_name = updated_identity
            .as_ref()
            .and_then(|identity| identity.name.clone())
            .unwrap_or(fallback_name);

        if changed_fields.is_empty() && workspace.name == updated_name {
            return Ok(None);
        }

        {
            let mut manager = self.manager.write().await;
            let workspace = manager
                .get_workspaces_mut()
                .get_mut(workspace_id)
                .ok_or_else(|| {
                    OpenBitFunError::service(format!("Workspace not found: {}", workspace_id))
                })?;

            workspace.identity = updated_identity.clone();
            workspace.name = updated_name.clone();
        }

        if let Err(e) = self.save_workspace_data().await {
            warn!(
                "Failed to save workspace data after identity refresh: workspace_id={} error={}",
                workspace_id, e
            );
        }

        Ok(Some(WorkspaceIdentityChangedEvent {
            workspace_id: workspace.id,
            workspace_path: workspace.root_path.to_string_lossy().to_string(),
            name: updated_name,
            identity: updated_identity,
            changed_fields,
        }))
    }

    /// Updates workspace information.
    pub async fn update_workspace_info(
        &self,
        workspace_id: &str,
        updates: WorkspaceInfoUpdates,
    ) -> OpenBitFunResult<WorkspaceInfo> {
        let WorkspaceInfoUpdates {
            name,
            description,
            tags,
            related_paths,
        } = updates;

        let normalized_name = match name {
            Some(name) => Some(Self::normalize_workspace_name(name)?),
            None => None,
        };

        let existing_workspace = {
            let manager = self.manager.read().await;
            manager
                .get_workspaces()
                .get(workspace_id)
                .cloned()
                .ok_or_else(|| {
                    OpenBitFunError::service(format!("Workspace not found: {}", workspace_id))
                })?
        };

        let normalized_related_paths = match related_paths {
            Some(related_paths) => Some(
                self.normalize_related_paths_for_workspace(&existing_workspace, related_paths)
                    .await?,
            ),
            None => None,
        };

        let updated_workspace = {
            let mut manager = self.manager.write().await;
            let workspace = manager
                .get_workspaces_mut()
                .get_mut(workspace_id)
                .ok_or_else(|| {
                    OpenBitFunError::service(format!("Workspace not found: {}", workspace_id))
                })?;

            if let Some(name) = normalized_name {
                workspace.name = name;
            }

            if let Some(description) = description {
                workspace.description = Some(description);
            }

            if let Some(tags) = tags {
                workspace.tags = tags;
            }

            if let Some(related_paths) = normalized_related_paths {
                workspace.related_paths = related_paths;
            }

            workspace.last_accessed = chrono::Utc::now();
            workspace.clone()
        };

        self.save_workspace_data().await?;

        Ok(updated_workspace)
    }

    async fn normalize_related_paths_for_workspace(
        &self,
        workspace: &WorkspaceInfo,
        related_paths: Vec<RelatedPath>,
    ) -> OpenBitFunResult<Vec<RelatedPath>> {
        let mut normalized = Vec::with_capacity(related_paths.len());
        let mut seen_paths = HashSet::new();

        match workspace.workspace_kind {
            #[cfg(feature = "remote-workspace")]
            WorkspaceKind::Remote => {
                let connection_id = workspace
                    .remote_ssh_connection_id()
                    .ok_or_else(|| {
                        OpenBitFunError::service(format!(
                            "Remote workspace is missing connectionId metadata: {}",
                            workspace.id
                        ))
                    })?
                    .to_string();
                let remote_manager = get_remote_workspace_manager().ok_or_else(|| {
                    OpenBitFunError::service(
                        "Remote workspace manager is unavailable for related path validation"
                            .to_string(),
                    )
                })?;
                let file_service = remote_manager.get_file_service().await.ok_or_else(|| {
                    OpenBitFunError::service(
                        "Remote file service is unavailable for related path validation"
                            .to_string(),
                    )
                })?;

                for related_path in related_paths {
                    let description =
                        Self::normalize_related_path_description(related_path.description);
                    let path = normalize_remote_workspace_path(related_path.path.trim());
                    if path.is_empty() {
                        return Err(OpenBitFunError::service(
                            "Related directory path cannot be empty".to_string(),
                        ));
                    }
                    if !seen_paths.insert(path.clone()) {
                        continue;
                    }

                    if !file_service
                        .exists(&connection_id, &path)
                        .await
                        .map_err(|error| {
                            OpenBitFunError::service(format!(
                                "Failed to validate remote related directory '{}': {}",
                                path, error
                            ))
                        })?
                    {
                        return Err(OpenBitFunError::service(format!(
                            "Remote related directory does not exist: {}",
                            path
                        )));
                    }

                    if !file_service
                        .is_dir(&connection_id, &path)
                        .await
                        .map_err(|error| {
                            OpenBitFunError::service(format!(
                                "Failed to inspect remote related directory '{}': {}",
                                path, error
                            ))
                        })?
                    {
                        return Err(OpenBitFunError::service(format!(
                            "Remote related path is not a directory: {}",
                            path
                        )));
                    }

                    normalized.push(RelatedPath { path, description });
                }
            }
            #[cfg(not(feature = "remote-workspace"))]
            WorkspaceKind::Remote => {
                return Err(OpenBitFunError::service(
                    "Remote workspace related paths require the remote-workspace feature",
                ));
            }
            _ => {
                for related_path in related_paths {
                    let description =
                        Self::normalize_related_path_description(related_path.description);
                    let raw_path = related_path.path.trim();
                    if raw_path.is_empty() {
                        return Err(OpenBitFunError::service(
                            "Related directory path cannot be empty".to_string(),
                        ));
                    }

                    let path_buf = PathBuf::from(raw_path);
                    let (canonical_path, normalized_key) =
                        canonicalize_local_workspace_root(&path_buf)
                            .map_err(OpenBitFunError::service)?;

                    let metadata = tokio::fs::metadata(&canonical_path)
                        .await
                        .map_err(|error| {
                            OpenBitFunError::service(format!(
                                "Failed to inspect related directory '{}': {}",
                                canonical_path.display(),
                                error
                            ))
                        })?;

                    if !metadata.is_dir() {
                        return Err(OpenBitFunError::service(format!(
                            "Related path is not a directory: {}",
                            canonical_path.display()
                        )));
                    }

                    if !seen_paths.insert(normalized_key) {
                        continue;
                    }

                    normalized.push(RelatedPath {
                        path: canonical_path.to_string_lossy().to_string(),
                        description,
                    });
                }
            }
        }

        Ok(normalized)
    }

    fn normalize_related_path_description(description: Option<String>) -> Option<String> {
        description.and_then(|value| {
            let trimmed = value.trim();
            if trimmed.is_empty() {
                None
            } else {
                Some(trimmed.to_string())
            }
        })
    }

    /// Imports workspaces in batch.
    pub async fn batch_import_workspaces(
        &self,
        paths: Vec<String>,
    ) -> OpenBitFunResult<BatchImportResult> {
        let mut result = BatchImportResult {
            successful: Vec::new(),
            failed: Vec::new(),
            total_processed: paths.len(),
            skipped: Vec::new(),
        };

        for path_str in paths {
            let path = PathBuf::from(&path_str);

            if !path.exists() {
                result
                    .failed
                    .push((path_str, "Path does not exist".to_string()));
                continue;
            }

            if !path.is_dir() {
                result
                    .failed
                    .push((path_str, "Path is not a directory".to_string()));
                continue;
            }

            {
                let manager = self.manager.read().await;
                if manager.get_workspaces().values().any(|w| {
                    if w.workspace_kind == WorkspaceKind::Remote {
                        w.root_path == path
                    } else {
                        local_workspace_roots_equal(&w.root_path, &path)
                    }
                }) {
                    result.skipped.push(path_str);
                    continue;
                }
            }

            match self.open_workspace(path).await {
                Ok(workspace) => {
                    result.successful.push(workspace.id);
                }
                Err(e) => {
                    result.failed.push((path_str, e.to_string()));
                }
            }
        }

        Ok(result)
    }

    /// Cleans up invalid workspaces.
    pub async fn cleanup_invalid_workspaces(&self) -> OpenBitFunResult<usize> {
        let removed_count = {
            let mut manager = self.manager.write().await;
            manager.cleanup_invalid_workspaces().await
        }?;

        if removed_count > 0 {
            self.ensure_assistant_workspaces().await?;
        } else if let Err(e) = self.save_workspace_data().await {
            warn!("Failed to save workspace data after cleanup: {}", e);
        }

        Ok(removed_count)
    }

    /// Returns statistics.
    pub async fn get_statistics(&self) -> WorkspaceManagerStatistics {
        let manager = self.manager.read().await;
        manager.get_statistics()
    }

    /// Returns the workspace count.
    pub async fn get_workspace_count(&self) -> usize {
        let manager = self.manager.read().await;
        manager.get_workspace_count()
    }

    /// Runs a health check.
    pub async fn health_check(&self) -> OpenBitFunResult<WorkspaceHealthStatus> {
        let stats = self.get_statistics().await;

        let mut warnings = Vec::new();
        let mut issues = Vec::new();

        if stats.total_workspaces == 0 {
            warnings.push("No workspaces found".to_string());
        }

        if stats.active_workspaces == 0 {
            warnings.push("No active workspaces".to_string());
        }

        if stats.inactive_workspaces > stats.active_workspaces * 3 {
            issues.push("Too many inactive workspaces, consider cleanup".to_string());
        }

        let current_workspace_valid = match self.get_current_workspace().await {
            Some(current) => current.is_valid().await,
            None => true,
        };

        if !current_workspace_valid {
            issues.push("Current workspace path is invalid".to_string());
        }

        let healthy = issues.is_empty() && current_workspace_valid;

        Ok(WorkspaceHealthStatus {
            healthy,
            total_workspaces: stats.total_workspaces,
            active_workspaces: stats.active_workspaces,
            current_workspace_valid,
            total_files: stats.total_files,
            total_size_mb: stats.total_size_bytes / (1024 * 1024),
            warnings,
            issues: issues.clone(),
            message: if healthy {
                "Workspace system is healthy".to_string()
            } else {
                format!("{} issues detected", issues.len())
            },
        })
    }

    /// Exports workspace configuration.
    pub async fn export_workspaces(&self) -> OpenBitFunResult<WorkspaceExport> {
        let manager = self.manager.read().await;
        let workspaces: Vec<WorkspaceInfo> = manager.get_workspaces().values().cloned().collect();
        let current_workspace_id = manager.get_current_workspace().map(|w| w.id.clone());
        let _recent_workspaces = manager.get_recent_workspaces().clone();

        Ok(WorkspaceExport {
            workspaces,
            current_workspace_id,
            primary_assistant_key: manager.get_primary_assistant_key().cloned(),
            recent_workspaces: manager
                .get_recent_workspace_infos()
                .iter()
                .map(|w| w.id.clone())
                .collect(),
            recent_assistant_workspaces: manager
                .get_recent_assistant_workspace_infos()
                .iter()
                .map(|w| w.id.clone())
                .collect(),
            export_timestamp: chrono::Utc::now().to_rfc3339(),
            version: env!("CARGO_PKG_VERSION").to_string(),
        })
    }

    /// Imports workspace configuration.
    pub async fn import_workspaces(
        &self,
        export: WorkspaceExport,
        overwrite: bool,
    ) -> OpenBitFunResult<WorkspaceImportResult> {
        let imported_primary_key = export.primary_assistant_key.clone();
        let mut result = WorkspaceImportResult {
            imported_workspaces: 0,
            skipped_workspaces: 0,
            errors: Vec::new(),
            warnings: Vec::new(),
        };

        let mut manager = self.manager.write().await;

        for workspace in export.workspaces {
            if !workspace.is_valid().await {
                result.warnings.push(format!(
                    "Workspace is currently unavailable; preserving imported record: {} ({:?})",
                    workspace.id, workspace.root_path
                ));
            }

            if !overwrite && manager.get_workspaces().contains_key(&workspace.id) {
                result.skipped_workspaces += 1;
                continue;
            }

            manager
                .get_workspaces_mut()
                .insert(workspace.id.clone(), workspace);
            result.imported_workspaces += 1;
        }

        super::legacy_compat::upgrade_legacy_worktree_references(
            manager.get_workspaces_mut(),
            &self.path_manager,
        )
        .await;

        manager.set_recent_workspaces(export.recent_workspaces.clone());
        manager.set_recent_assistant_workspaces(export.recent_assistant_workspaces.clone());
        manager.set_primary_assistant_key(imported_primary_key);
        manager.ensure_primary_assistant_selection();

        if let Some(current_id) = export.current_workspace_id {
            if manager.get_workspaces().contains_key(&current_id) {
                if let Err(e) = manager.set_current_workspace(current_id) {
                    result
                        .warnings
                        .push(format!("Failed to restore current workspace: {}", e));
                }
            } else {
                result
                    .warnings
                    .push("Current workspace not found in import".to_string());
            }
        }

        drop(manager);

        self.save_workspace_data().await?;

        Ok(result)
    }

    /// Returns a quick summary.
    pub async fn get_quick_summary(&self) -> WorkspaceQuickSummary {
        let stats = self.get_statistics().await;
        let current_workspace = self.get_current_workspace().await;
        let recent_workspaces = self.get_recent_workspaces().await;
        let recent_assistant_workspaces = self.get_recent_assistant_workspaces().await;

        WorkspaceQuickSummary {
            total_workspaces: stats.total_workspaces,
            active_workspaces: stats.active_workspaces,
            current_workspace: current_workspace.map(|w| w.get_summary()),
            recent_workspaces: recent_workspaces
                .into_iter()
                .take(5)
                .map(|w| w.get_summary())
                .collect(),
            recent_assistant_workspaces: recent_assistant_workspaces
                .into_iter()
                .take(5)
                .map(|w| w.get_summary())
                .collect(),
            workspace_types: stats.workspaces_by_type,
        }
    }

    /// Saves workspace data locally.
    pub fn subscribe_catalog_changes() -> tokio::sync::watch::Receiver<u64> {
        workspace_catalog_revision().subscribe()
    }

    async fn save_workspace_data(&self) -> OpenBitFunResult<()> {
        let manager = self.manager.read().await;

        let workspace_data = WorkspacePersistenceData {
            format_version: WORKSPACE_PERSISTENCE_FORMAT_VERSION,
            product_id: product_id().to_string(),
            workspaces: manager.get_workspaces().clone(),
            opened_workspace_ids: manager.get_opened_workspace_ids().clone(),
            current_workspace_id: manager.get_current_workspace().map(|w| w.id.clone()),
            recent_workspaces: manager.get_recent_workspaces().clone(),
            recent_assistant_workspaces: manager.get_recent_assistant_workspaces().clone(),
            primary_assistant_key: manager.get_primary_assistant_key().cloned(),
            saved_at: chrono::Utc::now(),
        };

        self.persistence
            .save_json("workspace_data", &workspace_data, StorageOptions::default())
            .await
            .map_err(|e| {
                OpenBitFunError::service(format!("Failed to save workspace data: {}", e))
            })?;
        workspace_catalog_revision().send_modify(|revision| *revision = revision.wrapping_add(1));
        Ok(())
    }

    /// Loads workspace history only without restoring the current workspace (used on startup).
    async fn load_workspace_history_only(&self) -> OpenBitFunResult<()> {
        let workspace_data: Option<WorkspacePersistenceData> = self
            .persistence
            .load_json("workspace_data")
            .await
            .map_err(|e| {
                OpenBitFunError::service(format!("Failed to load workspace data: {}", e))
            })?;

        if let Some(mut data) = workspace_data {
            super::legacy_compat::upgrade_legacy_worktree_references(
                &mut data.workspaces,
                &self.path_manager,
            )
            .await;
            validate_workspace_persistence_data(&data, &self.path_manager.miniapps_dir())?;

            let mut manager = self.manager.write().await;
            *manager.get_workspaces_mut() = data.workspaces;
            manager.set_opened_workspace_ids(data.opened_workspace_ids);
            manager.set_recent_workspaces(data.recent_workspaces);
            manager.set_recent_assistant_workspaces(data.recent_assistant_workspaces);
            manager.set_primary_assistant_key(data.primary_assistant_key);

            if let Some(current_id) = data.current_workspace_id {
                if let Err(e) = manager.set_current_workspace(current_id) {
                    return Err(unsupported_workspace_persistence(format!(
                        "current workspace could not be restored: {e}"
                    )));
                }
            }

            let workspaces_to_restore = Self::collect_startup_restored_workspaces(&manager);
            drop(manager);
            self.save_workspace_data().await?;
            self.prepare_startup_restored_workspaces(workspaces_to_restore)
                .await;
        } else {
            info!("No saved workspace data found, starting fresh");
        }

        Ok(())
    }

    fn to_manager_open_options(options: &WorkspaceCreateOptions) -> WorkspaceOpenOptions {
        WorkspaceOpenOptions {
            scan_options: options.scan_options.clone(),
            auto_set_current: options.auto_set_current,
            add_to_recent: options.add_to_recent,
            workspace_kind: options.workspace_kind.clone(),
            assistant_id: options.assistant_id.clone(),
            display_name: options.display_name.clone(),
            remote_connection_id: options.remote_connection_id.clone(),
            remote_ssh_host: options.remote_ssh_host.clone(),
            stable_workspace_id: options.stable_workspace_id.clone(),
        }
    }

    fn assistant_display_name(assistant_id: Option<&str>) -> String {
        match assistant_id {
            Some(id) if !id.trim().is_empty() => format!("Claw {}", id.trim()),
            _ => "Claw".to_string(),
        }
    }

    async fn generate_assistant_workspace_id(&self) -> OpenBitFunResult<String> {
        for _ in 0..32 {
            let assistant_id = uuid::Uuid::new_v4()
                .simple()
                .to_string()
                .chars()
                .take(8)
                .collect::<String>();
            let path = self
                .path_manager
                .assistant_workspace_dir(&assistant_id, None);

            if fs::try_exists(&path).await.map_err(|e| {
                OpenBitFunError::service(format!(
                    "Failed to check assistant workspace path '{}': {}",
                    path.display(),
                    e
                ))
            })? {
                continue;
            }

            if !self
                .get_assistant_workspaces()
                .await
                .iter()
                .any(|workspace| workspace.assistant_id.as_deref() == Some(&assistant_id))
            {
                return Ok(assistant_id);
            }
        }

        Err(OpenBitFunError::service(
            "Failed to allocate a unique assistant workspace id".to_string(),
        ))
    }

    fn assistant_descriptor_from_path(&self, path: &Path) -> Option<AssistantWorkspaceDescriptor> {
        let default_workspace = self.path_manager.default_assistant_workspace_dir(None);
        if path == default_workspace {
            return Some(AssistantWorkspaceDescriptor {
                path: path.to_path_buf(),
                assistant_id: None,
                display_name: Self::assistant_display_name(None),
            });
        }

        let assistant_root = self.path_manager.assistant_workspace_base_dir(None);
        if path.parent()? != assistant_root {
            return None;
        }

        let file_name = path.file_name()?.to_string_lossy();
        let assistant_id = file_name.strip_prefix("workspace-")?;
        if assistant_id.trim().is_empty() {
            return None;
        }

        Some(AssistantWorkspaceDescriptor {
            path: path.to_path_buf(),
            assistant_id: Some(assistant_id.to_string()),
            display_name: Self::assistant_display_name(Some(assistant_id)),
        })
    }

    fn normalize_workspace_options_for_path(
        &self,
        path: &Path,
        mut options: WorkspaceCreateOptions,
    ) -> WorkspaceCreateOptions {
        if options.workspace_kind == WorkspaceKind::Remote {
            if options.stable_workspace_id.is_none() {
                if let Some(ssh_host) = options
                    .remote_ssh_host
                    .as_deref()
                    .map(str::trim)
                    .filter(|value| !value.is_empty())
                {
                    options.stable_workspace_id = Some(remote_workspace_stable_id(
                        ssh_host,
                        &normalize_remote_workspace_path(&path.to_string_lossy()),
                    ));
                }
            }
            return options;
        }

        if options.workspace_kind == WorkspaceKind::Assistant {
            if options.display_name.is_none() {
                options.display_name = Some(Self::assistant_display_name(
                    options.assistant_id.as_deref(),
                ));
            }
            return options;
        }

        if let Some(descriptor) = self.assistant_descriptor_from_path(path) {
            options.workspace_kind = WorkspaceKind::Assistant;
            if options.assistant_id.is_none() {
                options.assistant_id = descriptor.assistant_id;
            }
            if options.display_name.is_none() {
                options.display_name = Some(descriptor.display_name);
            }
        }

        if self.is_miniapp_owned_path(path) {
            options.add_to_recent = false;
        }

        options
    }

    /// MiniApp agent runs and customization drafts work inside directories the
    /// MiniApp owns under `<userRoot>/data/miniapps/`. They are app storage, not
    /// user projects, so they must stay out of recent workspace history.
    fn is_miniapp_owned_path(&self, path: &Path) -> bool {
        path.starts_with(self.path_manager.miniapps_dir())
    }

    async fn discover_assistant_workspaces(
        &self,
    ) -> OpenBitFunResult<Vec<AssistantWorkspaceDescriptor>> {
        let assistant_root = self.path_manager.assistant_workspace_base_dir(None);
        fs::create_dir_all(&assistant_root).await.map_err(|e| {
            OpenBitFunError::service(format!(
                "Failed to create assistant workspace root '{}': {}",
                assistant_root.display(),
                e
            ))
        })?;

        let default_workspace = self.path_manager.default_assistant_workspace_dir(None);
        let mut descriptors = Vec::new();
        if fs::try_exists(&default_workspace).await.map_err(|e| {
            OpenBitFunError::service(format!(
                "Failed to inspect default assistant workspace '{}': {}",
                default_workspace.display(),
                e
            ))
        })? {
            descriptors.push(AssistantWorkspaceDescriptor {
                path: default_workspace.clone(),
                assistant_id: None,
                display_name: Self::assistant_display_name(None),
            });
        }

        let mut entries = fs::read_dir(&assistant_root).await.map_err(|e| {
            OpenBitFunError::service(format!(
                "Failed to read assistant workspace root '{}': {}",
                assistant_root.display(),
                e
            ))
        })?;

        while let Some(entry) = entries.next_entry().await.map_err(|e| {
            OpenBitFunError::service(format!(
                "Failed to iterate assistant workspace root '{}': {}",
                assistant_root.display(),
                e
            ))
        })? {
            let file_type = entry.file_type().await.map_err(|e| {
                OpenBitFunError::service(format!(
                    "Failed to inspect assistant workspace entry '{}': {}",
                    entry.path().display(),
                    e
                ))
            })?;
            if !file_type.is_dir() {
                continue;
            }

            let file_name = entry.file_name().to_string_lossy().to_string();
            let Some(assistant_id) = file_name.strip_prefix("workspace-") else {
                continue;
            };
            if assistant_id.trim().is_empty() {
                continue;
            }

            descriptors.push(AssistantWorkspaceDescriptor {
                path: entry.path(),
                assistant_id: Some(assistant_id.to_string()),
                display_name: Self::assistant_display_name(Some(assistant_id)),
            });
        }

        // A fresh installation still gets the built-in assistant. Once the
        // primary role has moved to a named assistant, deleting the built-in
        // workspace must not cause it to reappear on the next launch.
        if descriptors.is_empty() {
            fs::create_dir_all(&default_workspace).await.map_err(|e| {
                OpenBitFunError::service(format!(
                    "Failed to create default assistant workspace '{}': {}",
                    default_workspace.display(),
                    e
                ))
            })?;
            descriptors.push(AssistantWorkspaceDescriptor {
                path: default_workspace,
                assistant_id: None,
                display_name: Self::assistant_display_name(None),
            });
        }

        descriptors.sort_by(|left, right| {
            match (left.assistant_id.is_some(), right.assistant_id.is_some()) {
                (false, true) => std::cmp::Ordering::Less,
                (true, false) => std::cmp::Ordering::Greater,
                _ => left.path.cmp(&right.path),
            }
        });

        Ok(descriptors)
    }

    async fn ensure_assistant_workspaces(&self) -> OpenBitFunResult<()> {
        let descriptors = self.discover_assistant_workspaces().await?;
        let has_current_workspace = self.get_current_workspace().await.is_some();
        let has_opened_remote = {
            let manager = self.manager.read().await;
            manager
                .get_opened_workspace_infos()
                .iter()
                .any(|w| w.workspace_kind == WorkspaceKind::Remote)
        };

        let persisted_primary = {
            let manager = self.manager.read().await;
            manager.get_primary_assistant_key().cloned()
        };
        let activation_index = persisted_primary
            .as_ref()
            .and_then(|key| {
                descriptors.iter().position(|descriptor| match key {
                    PrimaryAssistantKey::BuiltIn => descriptor.assistant_id.is_none(),
                    PrimaryAssistantKey::Named { assistant_id } => {
                        descriptor.assistant_id.as_deref() == Some(assistant_id.as_str())
                    }
                })
            })
            .unwrap_or(0);

        for (index, descriptor) in descriptors.into_iter().enumerate() {
            // If a remote workspace tab exists but nothing is current yet (e.g. pending SSH
            // reconnect), do not auto-activate the default assistant workspace — that would look
            // like a spurious new local workspace.
            let should_activate =
                !has_current_workspace && !has_opened_remote && index == activation_index;
            let options = WorkspaceCreateOptions {
                auto_set_current: should_activate,
                add_to_recent: false,
                workspace_kind: WorkspaceKind::Assistant,
                assistant_id: descriptor.assistant_id.clone(),
                display_name: Some(descriptor.display_name.clone()),
                ..Default::default()
            };

            self.open_workspace_with_options(descriptor.path, options)
                .await?;
        }

        {
            let mut manager = self.manager.write().await;
            manager.ensure_primary_assistant_selection();
        }

        self.save_workspace_data().await
    }

    /// Saves workspace data manually (public API).
    pub async fn manual_save(&self) -> OpenBitFunResult<()> {
        self.save_workspace_data().await
    }

    /// Returns whether a path is a managed assistant workspace.
    pub fn is_assistant_workspace_path(&self, path: &Path) -> bool {
        self.assistant_descriptor_from_path(path).is_some()
    }

    /// Clears all persisted data.
    pub async fn clear_persistent_data(&self) -> OpenBitFunResult<()> {
        self.persistence
            .delete("workspace_data")
            .await
            .map_err(|e| {
                OpenBitFunError::service(format!("Failed to clear workspace data: {}", e))
            })?;

        Ok(())
    }

    /// Returns the underlying `WorkspaceManager` handle.
    /// Used to share workspace state with other services (e.g. Agent).
    pub fn get_manager(&self) -> Arc<RwLock<WorkspaceManager>> {
        self.manager.clone()
    }
}

/// Workspace info updates.
#[derive(Debug, Clone)]
pub struct WorkspaceInfoUpdates {
    pub name: Option<String>,
    pub description: Option<String>,
    pub tags: Option<Vec<String>>,
    pub related_paths: Option<Vec<RelatedPath>>,
}

/// Batch remove result.
#[derive(Debug, Serialize, Deserialize)]
pub struct BatchRemoveResult {
    pub successful: Vec<String>,
    pub failed: Vec<(String, String)>,
    pub total_processed: usize,
}

/// Workspace health status.
#[derive(Debug, Serialize, Deserialize)]
pub struct WorkspaceHealthStatus {
    pub healthy: bool,
    pub total_workspaces: usize,
    pub active_workspaces: usize,
    pub current_workspace_valid: bool,
    pub total_files: usize,
    pub total_size_mb: u64,
    pub warnings: Vec<String>,
    pub issues: Vec<String>,
    pub message: String,
}

/// Workspace export format.
#[derive(Debug, Serialize, Deserialize)]
pub struct WorkspaceExport {
    pub workspaces: Vec<WorkspaceInfo>,
    pub current_workspace_id: Option<String>,
    #[serde(default)]
    pub primary_assistant_key: Option<PrimaryAssistantKey>,
    pub recent_workspaces: Vec<String>,
    #[serde(default)]
    pub recent_assistant_workspaces: Vec<String>,
    pub export_timestamp: String,
    pub version: String,
}

/// Workspace import result.
#[derive(Debug, Serialize, Deserialize)]
pub struct WorkspaceImportResult {
    pub imported_workspaces: usize,
    pub skipped_workspaces: usize,
    pub errors: Vec<String>,
    pub warnings: Vec<String>,
}

/// Workspace quick summary.
#[derive(Debug, Serialize, Deserialize)]
pub struct WorkspaceQuickSummary {
    pub total_workspaces: usize,
    pub active_workspaces: usize,
    pub current_workspace: Option<WorkspaceSummary>,
    pub recent_workspaces: Vec<WorkspaceSummary>,
    #[serde(default)]
    pub recent_assistant_workspaces: Vec<WorkspaceSummary>,
    pub workspace_types: std::collections::HashMap<WorkspaceType, usize>,
}

// ── Global workspace service singleton ──────────────────────────────

static GLOBAL_WORKSPACE_SERVICE: std::sync::OnceLock<Arc<WorkspaceService>> =
    std::sync::OnceLock::new();

pub fn set_global_workspace_service(service: Arc<WorkspaceService>) {
    match GLOBAL_WORKSPACE_SERVICE.set(service) {
        Ok(_) => info!("Global workspace service set"),
        Err(_) => info!("Global workspace service already exists, skipping set"),
    }
}

pub fn get_global_workspace_service() -> Option<Arc<WorkspaceService>> {
    GLOBAL_WORKSPACE_SERVICE.get().cloned()
}

#[cfg(all(test, feature = "agent-runtime"))]
mod tests {
    use super::*;
    use crate::infrastructure::storage::StorageOptions;
    use crate::service::workspace::WorkspaceWorktreeInfo;
    use std::collections::HashMap;
    use uuid::Uuid;

    struct TestEnvironment {
        root: PathBuf,
        path_manager: Arc<PathManager>,
    }

    impl TestEnvironment {
        fn new() -> Self {
            let root = std::env::temp_dir().join(format!(
                "openbitfun-workspace-service-test-{}",
                Uuid::new_v4()
            ));
            std::fs::create_dir_all(&root).expect("test root should be created");

            let path_manager = Arc::new(PathManager::with_user_root_for_tests(
                root.join("user-root"),
            ));

            Self { root, path_manager }
        }

        fn create_workspace_dir(&self, name: &str) -> PathBuf {
            let path = self.root.join(name);
            std::fs::create_dir_all(&path).expect("workspace directory should be created");
            path
        }
    }

    impl Drop for TestEnvironment {
        fn drop(&mut self) {
            let _ = std::fs::remove_dir_all(&self.root);
        }
    }

    async fn build_test_workspace_service(path_manager: Arc<PathManager>) -> WorkspaceService {
        WorkspaceService::new_for_test_path_manager(path_manager).await
    }

    #[tokio::test]
    async fn ensure_workspace_gitignore_best_effort_skips_remote_workspaces() {
        let env = TestEnvironment::new();
        let service = build_test_workspace_service(env.path_manager.clone()).await;
        let remote_workspace_root = PathBuf::from("/srv/openbitfun/remote-workspace-shadow");

        let remote_workspace = WorkspaceInfo::new(
            remote_workspace_root.clone(),
            WorkspaceOpenOptions {
                workspace_kind: WorkspaceKind::Remote,
                remote_ssh_host: Some("example-host".to_string()),
                remote_connection_id: Some("conn-1".to_string()),
                ..Default::default()
            },
        )
        .await
        .expect("remote workspace should initialize");

        service
            .ensure_workspace_gitignore_best_effort(&remote_workspace, "test")
            .await;
    }

    /// Directory operands handed to CLI/ACP hosts resolve to a stable record
    /// without hijacking the desktop's opened, recent, or current workspace.
    #[tokio::test]
    async fn register_local_workspace_record_keeps_desktop_selection_untouched() {
        let env = TestEnvironment::new();
        let service = build_test_workspace_service(env.path_manager.clone()).await;
        let opened_project = env.create_workspace_dir("opened-project");
        let cli_cwd = env.create_workspace_dir("cli-cwd");

        let opened = service
            .open_workspace(opened_project)
            .await
            .expect("explicit open should succeed");

        let hidden = service
            .register_local_workspace_record(cli_cwd.clone())
            .await
            .expect("hidden registration should succeed");
        assert_eq!(hidden.workspace_kind, WorkspaceKind::Normal);
        assert_ne!(hidden.id, opened.id);

        let current = service.get_current_workspace().await;
        assert_eq!(current.map(|w| w.id), Some(opened.id.clone()));
        let opened_ids: Vec<String> = service
            .get_opened_workspaces()
            .await
            .into_iter()
            .map(|w| w.id)
            .collect();
        assert_eq!(opened_ids, vec![opened.id.clone()]);
        assert!(
            !service
                .get_recent_workspaces()
                .await
                .iter()
                .any(|w| w.id == hidden.id),
            "hidden record must not enter the recent list"
        );

        // Registering again resolves the same stable ID, and an explicit open
        // later surfaces that record instead of creating a second identity.
        let again = service
            .register_local_workspace_record(cli_cwd.clone())
            .await
            .expect("re-registration should succeed");
        assert_eq!(again.id, hidden.id);
        let explicit = service
            .open_workspace(cli_cwd)
            .await
            .expect("explicit open should succeed");
        assert_eq!(explicit.id, hidden.id);
        assert_eq!(
            service.get_current_workspace().await.map(|w| w.id),
            Some(hidden.id)
        );
    }

    #[tokio::test]
    async fn primary_assistant_role_can_move_to_a_named_workspace() {
        let env = TestEnvironment::new();
        let service = build_test_workspace_service(env.path_manager.clone()).await;

        service
            .ensure_assistant_workspaces()
            .await
            .expect("built-in assistant should initialize");
        let built_in = service
            .get_primary_assistant_workspace()
            .await
            .expect("built-in assistant should be primary by default");
        assert!(built_in.assistant_id.is_none());

        let named = service
            .create_assistant_workspace(Some("named-primary".to_string()))
            .await
            .expect("named assistant should initialize");
        service
            .set_primary_assistant_workspace(&named.id)
            .await
            .expect("primary assistant role should move");

        let primary = service
            .get_primary_assistant_workspace()
            .await
            .expect("named assistant should resolve as primary");
        assert_eq!(primary.id, named.id);
        assert!(service.is_primary_assistant_workspace(&named.id).await);
        assert!(!service.is_primary_assistant_workspace(&built_in.id).await);
    }

    #[tokio::test]
    async fn deleted_built_in_assistant_is_not_recreated_when_named_assistant_exists() {
        let env = TestEnvironment::new();
        let service = build_test_workspace_service(env.path_manager.clone()).await;

        service
            .ensure_assistant_workspaces()
            .await
            .expect("built-in assistant should initialize");
        let built_in = service
            .get_primary_assistant_workspace()
            .await
            .expect("built-in assistant should be primary by default");
        let named = service
            .create_assistant_workspace(Some("surviving-primary".to_string()))
            .await
            .expect("named assistant should initialize");
        service
            .set_primary_assistant_workspace(&named.id)
            .await
            .expect("primary assistant role should move");

        std::fs::remove_dir_all(&built_in.root_path)
            .expect("built-in assistant directory should be removed");
        service
            .remove_workspace(&built_in.id)
            .await
            .expect("built-in assistant record should be removed");
        service
            .ensure_assistant_workspaces()
            .await
            .expect("remaining assistant should initialize");

        let assistants = service.get_assistant_workspaces().await;
        assert_eq!(assistants.len(), 1);
        assert_eq!(assistants[0].id, named.id);
        assert!(assistants[0].assistant_id.is_some());
    }

    #[tokio::test]
    async fn load_workspace_history_only_ensures_all_opened_local_workspaces() {
        let env = TestEnvironment::new();
        let service = build_test_workspace_service(env.path_manager.clone()).await;

        let first_workspace_root = env.create_workspace_dir("workspace-one");
        let second_workspace_root = env.create_workspace_dir("workspace-two");

        let first_workspace = WorkspaceInfo::new(
            first_workspace_root.clone(),
            WorkspaceOpenOptions {
                auto_set_current: false,
                ..Default::default()
            },
        )
        .await
        .expect("first workspace should initialize");
        let second_workspace = WorkspaceInfo::new(
            second_workspace_root.clone(),
            WorkspaceOpenOptions {
                auto_set_current: false,
                ..Default::default()
            },
        )
        .await
        .expect("second workspace should initialize");

        let first_runtime = service
            .runtime_service
            .context_for_local_workspace(&first_workspace_root);
        let second_runtime = service
            .runtime_service
            .context_for_local_workspace(&second_workspace_root);
        assert!(
            !first_runtime.runtime_root.exists(),
            "startup should begin without a runtime root for the first workspace"
        );
        assert!(
            !second_runtime.runtime_root.exists(),
            "startup should begin without a runtime root for the second workspace"
        );

        let workspace_data = WorkspacePersistenceData {
            format_version: WORKSPACE_PERSISTENCE_FORMAT_VERSION,
            product_id: product_id().to_string(),
            workspaces: HashMap::from([
                (first_workspace.id.clone(), first_workspace.clone()),
                (second_workspace.id.clone(), second_workspace.clone()),
            ]),
            opened_workspace_ids: vec![first_workspace.id.clone(), second_workspace.id.clone()],
            current_workspace_id: Some(first_workspace.id.clone()),
            recent_workspaces: vec![first_workspace.id.clone(), second_workspace.id.clone()],
            recent_assistant_workspaces: Vec::new(),
            primary_assistant_key: None,
            saved_at: chrono::Utc::now(),
        };

        service
            .persistence
            .save_json("workspace_data", &workspace_data, StorageOptions::default())
            .await
            .expect("workspace data should save");

        service
            .load_workspace_history_only()
            .await
            .expect("workspace history should restore");

        let restored_current = service
            .get_current_workspace()
            .await
            .expect("current workspace should be restored");
        assert_eq!(restored_current.id, first_workspace.id);
        assert!(
            first_runtime.runtime_root.exists(),
            "active workspace runtime should be ensured on startup"
        );
        assert!(
            second_runtime.runtime_root.exists(),
            "non-active opened workspace runtime should also be ensured on startup"
        );
    }

    #[tokio::test]
    async fn load_workspace_history_preserves_opaque_local_id() {
        let env = TestEnvironment::new();
        let service = build_test_workspace_service(env.path_manager.clone()).await;
        let workspace_root = env.create_workspace_dir("noncanonical-workspace-id");
        let mut workspace = WorkspaceInfo::new(
            workspace_root,
            WorkspaceOpenOptions {
                auto_set_current: false,
                ..Default::default()
            },
        )
        .await
        .expect("workspace should initialize");
        let noncanonical_id = Uuid::new_v4().to_string();
        workspace.id = noncanonical_id.clone();

        let workspace_data = WorkspacePersistenceData {
            format_version: WORKSPACE_PERSISTENCE_FORMAT_VERSION,
            product_id: product_id().to_string(),
            workspaces: HashMap::from([(noncanonical_id.clone(), workspace)]),
            opened_workspace_ids: vec![noncanonical_id.clone()],
            current_workspace_id: Some(noncanonical_id.clone()),
            recent_workspaces: vec![noncanonical_id.clone()],
            recent_assistant_workspaces: Vec::new(),
            primary_assistant_key: None,
            saved_at: chrono::Utc::now(),
        };
        service
            .persistence
            .save_json("workspace_data", &workspace_data, StorageOptions::default())
            .await
            .expect("noncanonical workspace fixture should save");
        let persistence_path = service.persistence.base_dir().join("workspace_data.json");
        service
            .load_workspace_history_only()
            .await
            .expect("opaque IDs are preserved");
        let restored = service.require_workspace(&noncanonical_id).await.unwrap();
        assert_eq!(restored.id, noncanonical_id);
        let saved: WorkspacePersistenceData =
            serde_json::from_slice(&std::fs::read(&persistence_path).unwrap()).unwrap();
        assert!(saved.workspaces.contains_key(&noncanonical_id));
        assert_eq!(
            saved.current_workspace_id.as_deref(),
            Some(noncanonical_id.as_str())
        );
    }

    #[tokio::test]
    async fn load_workspace_history_retains_canonical_missing_local_workspace() {
        let env = TestEnvironment::new();
        let service = build_test_workspace_service(env.path_manager.clone()).await;
        let workspace_root = env.create_workspace_dir("temporarily-missing-workspace");
        let workspace = WorkspaceInfo::new(
            workspace_root.clone(),
            WorkspaceOpenOptions {
                auto_set_current: false,
                ..Default::default()
            },
        )
        .await
        .expect("workspace should initialize");
        std::fs::remove_dir_all(&workspace_root).expect("workspace root should be removed");

        let workspace_data = WorkspacePersistenceData {
            format_version: WORKSPACE_PERSISTENCE_FORMAT_VERSION,
            product_id: product_id().to_string(),
            workspaces: HashMap::from([(workspace.id.clone(), workspace.clone())]),
            opened_workspace_ids: Vec::new(),
            current_workspace_id: None,
            recent_workspaces: vec![workspace.id.clone()],
            recent_assistant_workspaces: Vec::new(),
            primary_assistant_key: None,
            saved_at: chrono::Utc::now(),
        };
        service
            .persistence
            .save_json("workspace_data", &workspace_data, StorageOptions::default())
            .await
            .expect("workspace history should save");

        service
            .load_workspace_history_only()
            .await
            .expect("missing current-format workspace history should remain readable");

        assert_eq!(
            service
                .get_workspace(&workspace.id)
                .await
                .expect("missing workspace metadata should be retained")
                .root_path,
            workspace.root_path
        );
    }

    #[tokio::test]
    async fn remote_workspace_rejects_noncanonical_supplied_id() {
        let error = WorkspaceInfo::new(
            PathBuf::from("/srv/openbitfun/project"),
            WorkspaceOpenOptions {
                workspace_kind: WorkspaceKind::Remote,
                remote_ssh_host: Some("example-host".to_string()),
                remote_connection_id: Some("conn-1".to_string()),
                stable_workspace_id: Some("remote_noncanonical".to_string()),
                ..Default::default()
            },
        )
        .await
        .expect_err("remote workspace must use its host-and-path stable id");

        assert!(error
            .to_string()
            .contains("does not match its sshHost and root path"));
    }

    #[tokio::test]
    async fn track_workspace_activity_registers_without_opening_workspace() {
        let env = TestEnvironment::new();
        let service = build_test_workspace_service(env.path_manager.clone()).await;
        let workspace_root = env.create_workspace_dir("tracked-workspace");

        let tracked = service
            .track_workspace_activity(
                workspace_root.clone(),
                WorkspaceCreateOptions::default(),
                WorkspaceActivityMode::RefreshMetadata,
            )
            .await
            .expect("workspace tracking should succeed");

        let tracked_by_id = service
            .get_workspace(&tracked.id)
            .await
            .expect("tracked workspace should be queryable by ID");
        assert_eq!(tracked_by_id.id, tracked.id);

        let recent = service.get_recent_workspaces().await;
        assert_eq!(recent.len(), 1);
        assert_eq!(recent[0].id, tracked.id);

        assert!(
            service.get_opened_workspaces().await.is_empty(),
            "tracked workspace activity should not add the workspace to the opened UI list"
        );
        assert!(
            service.get_current_workspace().await.is_none(),
            "tracked workspace activity should not change the current workspace"
        );
    }

    #[tokio::test]
    async fn track_workspace_activity_keeps_miniapp_workspaces_out_of_recent_history() {
        let env = TestEnvironment::new();
        let service = build_test_workspace_service(env.path_manager.clone()).await;
        let miniapp_workspace_root = env
            .path_manager
            .miniapp_dir("builtin-ppt-live")
            .join("decks")
            .join("deck-1785130332234");
        std::fs::create_dir_all(&miniapp_workspace_root)
            .expect("MiniApp workspace directory should be created");

        let tracked = service
            .track_workspace_activity(
                miniapp_workspace_root.clone(),
                WorkspaceCreateOptions::default(),
                WorkspaceActivityMode::RefreshMetadata,
            )
            .await
            .expect("MiniApp workspace tracking should succeed");

        assert_eq!(
            service
                .get_workspace(&tracked.id)
                .await
                .map(|workspace| workspace.id),
            Some(tracked.id),
            "MiniApp workspace should still be registered so its agent session can resolve it"
        );
        assert!(
            service.get_recent_workspaces().await.is_empty(),
            "MiniApp-owned workspaces should never enter recent workspace history"
        );
    }

    #[tokio::test]
    async fn touch_only_workspace_activity_preserves_worktree_metadata() {
        let env = TestEnvironment::new();
        let service = build_test_workspace_service(env.path_manager.clone()).await;
        let workspace_root = env.create_workspace_dir("touch-only-workspace");

        let tracked = service
            .track_workspace_activity(
                workspace_root.clone(),
                WorkspaceCreateOptions::default(),
                WorkspaceActivityMode::RefreshMetadata,
            )
            .await
            .expect("workspace tracking should succeed");
        let expected_worktree = WorkspaceWorktreeInfo {
            main_workspace_id: None,
            path: workspace_root.to_string_lossy().replace('\\', "/"),
            branch: Some("cached-branch".to_string()),
            main_repo_path: workspace_root.to_string_lossy().replace('\\', "/"),
            is_main: true,
        };
        {
            let mut manager = service.manager.write().await;
            manager
                .get_workspaces_mut()
                .get_mut(&tracked.id)
                .expect("tracked workspace should exist")
                .worktree = Some(expected_worktree.clone());
        }

        let touched = service
            .track_workspace_activity(
                workspace_root,
                WorkspaceCreateOptions::default(),
                WorkspaceActivityMode::TouchOnly,
            )
            .await
            .expect("touch-only tracking should succeed");

        assert_eq!(touched.worktree, Some(expected_worktree));
    }

    #[tokio::test]
    async fn track_workspace_activity_assigns_stable_remote_workspace_id() {
        let env = TestEnvironment::new();
        let service = build_test_workspace_service(env.path_manager.clone()).await;
        let remote_workspace_root = PathBuf::from("/srv/openbitfun/project");

        let tracked = service
            .track_workspace_activity(
                remote_workspace_root.clone(),
                WorkspaceCreateOptions {
                    workspace_kind: WorkspaceKind::Remote,
                    remote_connection_id: Some("conn-1".to_string()),
                    remote_ssh_host: Some("example-host".to_string()),
                    ..Default::default()
                },
                WorkspaceActivityMode::RefreshMetadata,
            )
            .await
            .expect("remote workspace tracking should succeed");

        assert_eq!(
            tracked.id,
            remote_workspace_stable_id("example-host", "/srv/openbitfun/project")
        );
        assert_eq!(tracked.root_path, remote_workspace_root);
        assert!(service.get_opened_workspaces().await.is_empty());
    }

    #[cfg(feature = "remote-workspace")]
    #[tokio::test]
    async fn legacy_workspace_open_keeps_assistant_id_and_kind() {
        let env = TestEnvironment::new();
        let service = build_test_workspace_service(env.path_manager.clone()).await;
        let root = env
            .path_manager
            .user_data_dir()
            .join("legacy-assistant-workspace");
        std::fs::create_dir_all(&root).unwrap();
        let original = service
            .open_workspace_with_options(
                root.clone(),
                WorkspaceCreateOptions {
                    workspace_kind: WorkspaceKind::Assistant,
                    assistant_id: Some("assistant-1".to_owned()),
                    ..Default::default()
                },
            )
            .await
            .unwrap();
        let reopened = service
            .upgrade_legacy_workspace_open(root, None, None)
            .await
            .unwrap();
        assert_eq!(reopened.id, original.id);
        assert_eq!(reopened.workspace_kind, WorkspaceKind::Assistant);
        assert_eq!(reopened.assistant_id, original.assistant_id);
    }

    #[tokio::test]
    async fn explicit_local_folder_creation_does_not_select_same_path_remote_record() {
        let env = TestEnvironment::new();
        let service = build_test_workspace_service(env.path_manager.clone()).await;
        let folder = tempfile::tempdir().unwrap();
        let remote = service
            .track_workspace_activity(
                folder.path().to_path_buf(),
                WorkspaceCreateOptions {
                    workspace_kind: WorkspaceKind::Remote,
                    remote_connection_id: Some("other-machine".into()),
                    remote_ssh_host: Some("other.example".into()),
                    ..Default::default()
                },
                WorkspaceActivityMode::RefreshMetadata,
            )
            .await
            .unwrap();
        let local = service
            .open_workspace(folder.path().to_path_buf())
            .await
            .unwrap();
        assert_eq!(local.workspace_kind, WorkspaceKind::Normal);
        assert_ne!(local.id, remote.id);
        assert_eq!(
            service
                .require_workspace(&remote.id)
                .await
                .unwrap()
                .workspace_kind,
            WorkspaceKind::Remote
        );
    }

    #[cfg(feature = "remote-workspace")]
    #[tokio::test]
    async fn upgrade_legacy_workspace_open_reopens_remote_without_local_exists() {
        let env = TestEnvironment::new();
        let service = build_test_workspace_service(env.path_manager.clone()).await;
        let remote_path = PathBuf::from("/root/repos");

        service
            .track_workspace_activity(
                remote_path.clone(),
                WorkspaceCreateOptions {
                    workspace_kind: WorkspaceKind::Remote,
                    remote_connection_id: Some("conn-remote-open".to_string()),
                    remote_ssh_host: Some("remote-host".to_string()),
                    display_name: Some("repos".to_string()),
                    ..Default::default()
                },
                WorkspaceActivityMode::RefreshMetadata,
            )
            .await
            .expect("remote workspace should be remembered");

        let opened = service
            .upgrade_legacy_workspace_open(remote_path.clone(), None, None)
            .await
            .expect("known remote workspace must open without a local path");

        assert_eq!(opened.workspace_kind, WorkspaceKind::Remote);
        assert_eq!(opened.root_path, remote_path);
        assert_eq!(opened.remote_ssh_connection_id(), Some("conn-remote-open"));
        assert_eq!(
            opened
                .metadata
                .get("sshHost")
                .and_then(|value| value.as_str()),
            Some("remote-host")
        );

        let entry = get_remote_workspace_manager()
            .expect("remote workspace manager should exist")
            .lookup_connection("/root/repos", Some("conn-remote-open"))
            .await
            .expect("opened remote workspace must be registered");
        assert_eq!(entry.connection_id, "conn-remote-open");
        assert_eq!(entry.ssh_host, "remote-host");
    }

    #[tokio::test]
    async fn explicit_remote_identity_does_not_select_another_host_at_same_path() {
        let env = TestEnvironment::new();
        let service = build_test_workspace_service(env.path_manager.clone()).await;
        let root = PathBuf::from("/tests/identity-selection");
        service
            .track_workspace_activity(
                root.clone(),
                WorkspaceCreateOptions {
                    workspace_kind: WorkspaceKind::Remote,
                    remote_connection_id: Some("saved-alpha".into()),
                    remote_ssh_host: Some("alpha.example".into()),
                    ..Default::default()
                },
                WorkspaceActivityMode::RefreshMetadata,
            )
            .await
            .unwrap();
        assert!(service
            .resolve_legacy_workspace_reference(
                None,
                root.to_str().unwrap(),
                Some("saved-beta"),
                None
            )
            .await
            .unwrap()
            .is_none());
        assert!(service
            .resolve_legacy_workspace_reference(
                None,
                root.to_str().unwrap(),
                Some("saved-alpha"),
                Some("beta.example")
            )
            .await
            .unwrap()
            .is_none());
        assert!(service
            .resolve_legacy_workspace_reference(
                None,
                root.to_str().unwrap(),
                Some("saved-alpha"),
                Some("alpha.example")
            )
            .await
            .unwrap()
            .is_some());
    }

    #[tokio::test]
    async fn upgrade_legacy_workspace_open_reports_unknown_remote_paths_clearly() {
        let env = TestEnvironment::new();
        let service = build_test_workspace_service(env.path_manager.clone()).await;

        let error = service
            .upgrade_legacy_workspace_open(
                PathBuf::from("/openbitfun-tests/unknown-remote-path"),
                None,
                None,
            )
            .await
            .expect_err("unknown remote paths must fail with a clear message");

        assert!(
            error
                .to_string()
                .contains("not a known remote SSH workspace"),
            "unexpected error: {error}"
        );
    }

    #[tokio::test]
    async fn update_workspace_info_normalizes_and_validates_project_name() {
        let env = TestEnvironment::new();
        let service = build_test_workspace_service(env.path_manager.clone()).await;
        let workspace_root = env.create_workspace_dir("rename-project");
        let workspace = service
            .open_workspace(workspace_root)
            .await
            .expect("workspace should open");

        let renamed = service
            .update_workspace_info(
                &workspace.id,
                WorkspaceInfoUpdates {
                    name: Some("  Renamed project  ".to_string()),
                    description: None,
                    tags: None,
                    related_paths: None,
                },
            )
            .await
            .expect("valid project name should be accepted");
        assert_eq!(renamed.name, "Renamed project");
        assert_eq!(
            service
                .get_workspace(&workspace.id)
                .await
                .expect("renamed workspace should remain available")
                .name,
            "Renamed project"
        );

        for invalid_name in [
            "   ".to_string(),
            "Project\nName".to_string(),
            "x".repeat(MAX_WORKSPACE_NAME_CHARS + 1),
        ] {
            let error = service
                .update_workspace_info(
                    &workspace.id,
                    WorkspaceInfoUpdates {
                        name: Some(invalid_name),
                        description: None,
                        tags: None,
                        related_paths: None,
                    },
                )
                .await
                .expect_err("invalid project name should be rejected");
            assert!(error.to_string().contains("Workspace name"));
        }
    }

    #[test]
    fn normalize_related_path_description_treats_blank_as_none() {
        assert_eq!(
            WorkspaceService::normalize_related_path_description(None),
            None
        );
        assert_eq!(
            WorkspaceService::normalize_related_path_description(Some("".to_string())),
            None
        );
        assert_eq!(
            WorkspaceService::normalize_related_path_description(Some("   ".to_string())),
            None
        );
        assert_eq!(
            WorkspaceService::normalize_related_path_description(Some(
                " Legacy TypeScript implementation ".to_string()
            )),
            Some("Legacy TypeScript implementation".to_string())
        );
    }
}

fn workspace_catalog_revision() -> &'static tokio::sync::watch::Sender<u64> {
    static REVISION: std::sync::OnceLock<tokio::sync::watch::Sender<u64>> =
        std::sync::OnceLock::new();
    REVISION.get_or_init(|| tokio::sync::watch::channel(0).0)
}
