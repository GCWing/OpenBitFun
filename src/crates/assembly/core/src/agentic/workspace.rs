use crate::agentic::core::SessionConfig;
use crate::service::workspace_runtime::WorkspaceRuntimeService;
use openbitfun_core_types::SessionExecutionTarget;
pub use openbitfun_runtime_ports::{
    WorkspaceCommandOptions, WorkspaceCommandResult, WorkspaceDirEntry, WorkspaceFileSystem,
    WorkspaceServices, WorkspaceShell,
};
pub use openbitfun_services_core::workspace::{
    local_workspace_services, LocalWorkspaceFs, LocalWorkspaceShell,
};
use openbitfun_services_core::workspace_identity::{
    WorkspaceSessionIdentity, LOCAL_WORKSPACE_SSH_HOST,
};
#[cfg(feature = "remote-workspace")]
pub use openbitfun_services_integrations::remote_ssh::{
    remote_workspace_services, RemoteWorkspaceFs, RemoteWorkspaceShell,
};
use std::path::{Path, PathBuf};

/// Workspace routing identity. Filesystem projections must never enter this key.
#[cfg(any(feature = "external-sources", feature = "mcp-runtime"))]
pub(crate) fn workspace_route_key(workspace_id: Option<&str>) -> String {
    workspace_id
        .map(|id| format!("workspace:{id}"))
        .unwrap_or_else(|| "<global>".to_string())
}

/// Describes whether the workspace is local or remote via SSH.
#[derive(Debug, Clone, PartialEq, Eq, Hash)]
pub enum WorkspaceBackend {
    Local,
    Remote {
        connection_id: String,
        connection_name: String,
    },
}

/// Session-bound workspace information used during agent execution.
#[derive(Debug, Clone, PartialEq, Eq, Hash)]
pub struct WorkspaceBinding {
    pub project_workspace_id: Option<String>,
    pub workspace_id: Option<String>,
    /// For local workspaces this is a local path; for remote workspaces it is
    /// the path on the remote server (e.g. `/root/project`).
    pub root_path: PathBuf,
    /// Main project root used for persistence and product-level orchestration.
    /// It equals `root_path` for legacy, local, and remote sessions.
    pub project_root_path: PathBuf,
    /// Resolved execution target persisted with the session.
    pub execution_target: Option<SessionExecutionTarget>,
    pub backend: WorkspaceBackend,
    /// Resolved persistence projection. Workspace kind selects the backend;
    /// hostname and paths describe IO locations, never workspace identity.
    pub session_identity: WorkspaceSessionIdentity,
}

impl WorkspaceBinding {
    /// Construct an execution binding from the owning host's authoritative record.
    pub async fn resolve(workspace_id: &str) -> crate::OpenBitFunResult<Self> {
        let service = crate::service::workspace::get_global_workspace_service()
            .ok_or_else(|| crate::OpenBitFunError::service("Workspace service is unavailable"))?;
        let record = service.require_workspace(workspace_id).await?;
        let mut config = SessionConfig::default();
        apply_workspace_record(&mut config, &record)?;
        normalize_session_workspace(&mut config).await?;
        if config.is_remote_workspace() {
            let connection_id = config
                .remote_connection_id
                .expect("validated remote record");
            let host = config.remote_ssh_host.expect("validated remote record");
            let identity = WorkspaceSessionIdentity {
                workspace_kind: record.workspace_kind,
                hostname: host.clone(),
                logical_workspace_path: record.root_path.to_string_lossy().into_owned(),
                remote_connection_id: Some(connection_id.clone()),
            };
            Ok(Self::new_remote(
                Some(record.id),
                record.root_path,
                connection_id,
                host,
                identity,
            ))
        } else {
            let project_id = config.project_workspace_id.ok_or_else(|| {
                crate::OpenBitFunError::service("Project workspace ID is required")
            })?;
            let project = service.require_workspace(&project_id).await?;
            let mut binding = Self::new(Some(record.id), record.root_path)
                .with_project_root_path(project.root_path);
            binding.project_workspace_id = Some(project_id);
            binding.session_identity.workspace_kind = record.workspace_kind;
            Ok(binding)
        }
    }

    pub fn new(workspace_id: Option<String>, root_path: PathBuf) -> Self {
        let logical_workspace_path = root_path.to_string_lossy().to_string();
        let session_identity = WorkspaceSessionIdentity {
            workspace_kind: openbitfun_core_types::WorkspaceKind::Normal,
            hostname: LOCAL_WORKSPACE_SSH_HOST.to_string(),
            logical_workspace_path,
            remote_connection_id: None,
        };
        Self {
            project_workspace_id: workspace_id.clone(),
            workspace_id,
            project_root_path: root_path.clone(),
            execution_target: None,
            root_path,
            backend: WorkspaceBackend::Local,
            session_identity,
        }
    }

    pub fn new_remote(
        workspace_id: Option<String>,
        root_path: PathBuf,
        connection_id: String,
        connection_name: String,
        session_identity: WorkspaceSessionIdentity,
    ) -> Self {
        Self {
            project_workspace_id: workspace_id.clone(),
            workspace_id,
            project_root_path: root_path.clone(),
            execution_target: None,
            root_path,
            backend: WorkspaceBackend::Remote {
                connection_id,
                connection_name,
            },
            session_identity,
        }
    }

    pub fn root_path(&self) -> &Path {
        &self.root_path
    }

    pub fn root_path_string(&self) -> String {
        self.root_path.to_string_lossy().to_string()
    }

    pub fn project_root_path(&self) -> &Path {
        &self.project_root_path
    }

    pub fn project_root_path_string(&self) -> String {
        self.project_root_path.to_string_lossy().to_string()
    }

    /// Binds a local execution root to the main project that owns its session
    /// data. Remote workspaces intentionally keep a single root.
    pub fn with_project_root_path(mut self, project_root_path: PathBuf) -> Self {
        if !self.is_remote() {
            self.project_root_path = project_root_path;
        }
        self
    }

    pub fn with_execution_target(
        mut self,
        execution_target: Option<SessionExecutionTarget>,
    ) -> Self {
        self.execution_target = execution_target;
        self
    }

    /// Logical workspace root used by tools, display, and workspace-bound IO.
    ///
    /// For local workspaces this is the local project root. For remote SSH
    /// workspaces this is the root path on the remote host.
    pub fn logical_workspace_path(&self) -> &Path {
        &self.root_path
    }

    pub fn logical_workspace_path_string(&self) -> String {
        self.logical_workspace_path().to_string_lossy().to_string()
    }

    pub fn is_remote(&self) -> bool {
        matches!(self.backend, WorkspaceBackend::Remote { .. })
    }

    pub fn connection_id(&self) -> Option<&str> {
        match &self.backend {
            WorkspaceBackend::Remote { connection_id, .. } => Some(connection_id),
            WorkspaceBackend::Local => None,
        }
    }

    /// Final on-disk sessions directory for this workspace binding.
    pub fn session_storage_dir(&self) -> PathBuf {
        let runtime_service =
            WorkspaceRuntimeService::new(crate::infrastructure::get_path_manager_arc());
        if self.is_remote() {
            if self.session_identity.hostname == "_unresolved" {
                if let Some(connection_id) = self.session_identity.remote_connection_id.as_deref() {
                    return openbitfun_services_core::workspace_identity::unresolved_remote_session_storage_dir(
                        crate::infrastructure::get_path_manager_arc().remote_ssh_mirror_root_dir(),
                        connection_id,
                        self.session_identity.logical_workspace_path(),
                    );
                }
            }
            return runtime_service
                .context_for_remote_workspace(
                    &self.session_identity.hostname,
                    self.session_identity.logical_workspace_path(),
                )
                .sessions_dir;
        }

        runtime_service
            .context_for_local_workspace(self.project_root_path())
            .sessions_dir
    }
}

#[cfg(test)]
mod tests {
    use super::{WorkspaceBackend, WorkspaceBinding};
    use crate::service::workspace_runtime::WorkspaceRuntimeService;
    use openbitfun_core_types::{
        SessionExecutionTarget, SessionExecutionTargetKind, WorktreeLifecycle,
    };
    use openbitfun_services_core::workspace_identity::{
        remote_workspace_session_mirror_dir, workspace_session_identity,
    };
    use std::path::PathBuf;

    #[test]
    fn remote_workspace_binding_uses_session_identity_storage_dir() {
        let session_identity = workspace_session_identity(
            "/home/wsp/projects/test",
            Some("conn-1"),
            Some("127.0.0.1"),
        )
        .expect("remote identity should resolve");
        let binding = WorkspaceBinding::new_remote(
            Some("workspace-1".to_string()),
            PathBuf::from("/home/wsp/projects/test"),
            "conn-1".to_string(),
            "Localhost".to_string(),
            session_identity,
        );

        assert!(matches!(binding.backend, WorkspaceBackend::Remote { .. }));
        assert_eq!(
            binding.session_storage_dir(),
            remote_workspace_session_mirror_dir(
                crate::infrastructure::get_path_manager_arc().remote_ssh_mirror_root_dir(),
                "127.0.0.1",
                "/home/wsp/projects/test"
            )
        );
    }

    #[test]
    fn worktree_binding_executes_in_worktree_but_persists_in_project() {
        let project_root = PathBuf::from("/tmp/openbitfun-project");
        let worktree_root = PathBuf::from("/tmp/openbitfun-worktrees/wt-1");
        let execution_target = SessionExecutionTarget {
            kind: SessionExecutionTargetKind::ManagedWorktree,
            worktree_id: Some("wt-1".to_string()),
            root_path: worktree_root.to_string_lossy().to_string(),
            base_ref: Some("HEAD".to_string()),
            base_commit: Some("0123456789abcdef".to_string()),
            branch: None,
            lifecycle: Some(WorktreeLifecycle::Managed),
        };
        let binding = WorkspaceBinding::new(None, worktree_root.clone())
            .with_project_root_path(project_root.clone())
            .with_execution_target(Some(execution_target.clone()));
        let runtime = WorkspaceRuntimeService::new(crate::infrastructure::get_path_manager_arc());

        assert_eq!(binding.root_path(), worktree_root);
        assert_eq!(binding.project_root_path(), project_root);
        assert_eq!(binding.execution_target, Some(execution_target));
        assert_eq!(
            binding.session_storage_dir(),
            runtime
                .context_for_local_workspace(&project_root)
                .sessions_dir
        );
    }
}

// Workspace-level I/O contracts are owned by openbitfun-runtime-ports and the
// concrete providers are re-exported from their service owner crates above.

/// Resolve old and new session configs against the owning host's workspace
/// registry before routing, ownership checks, extension discovery or persistence.
pub(crate) async fn normalize_session_workspace(
    config: &mut SessionConfig,
) -> crate::OpenBitFunResult<()> {
    use crate::service::workspace::{get_global_workspace_service, WorkspaceKind};
    if config.workspace_id.is_none()
        && config.workspace_path.is_none()
        && config.project_workspace_path.is_none()
    {
        return Ok(());
    }
    let service = get_global_workspace_service()
        .ok_or_else(|| crate::OpenBitFunError::service("Workspace service is unavailable"))?;
    if config.workspace_id.is_none() || config.project_workspace_id.is_none() {
        crate::service::workspace::legacy_compat::upgrade_session_workspace_reference(
            config, &service,
        )
        .await?;
    }
    let record = service
        .require_workspace(config.workspace_id.as_deref().expect("workspace resolved"))
        .await?;
    let project_id = record
        .project_workspace_id()
        .map_err(crate::OpenBitFunError::service)?;
    if config
        .project_workspace_id
        .as_deref()
        .is_some_and(|id| id != project_id)
    {
        return Err(crate::OpenBitFunError::service(
            "Session project workspace ID differs from its workspace object",
        ));
    }
    let project = service.require_workspace(project_id).await?;
    if (record.workspace_kind == WorkspaceKind::Remote
        || project.workspace_kind == WorkspaceKind::Remote)
        && record.id != project.id
    {
        return Err(crate::OpenBitFunError::service(
            "Remote workspace cannot be bound to a different project workspace",
        ));
    }
    apply_workspace_record(config, &record)?;
    config.project_workspace_path = Some(project.root_path.to_string_lossy().into_owned());
    if !config.is_remote_workspace() {
        let manager = crate::infrastructure::get_path_manager_arc();
        for path in [
            config.workspace_path.as_deref(),
            config.project_workspace_path.as_deref(),
        ]
        .into_iter()
        .flatten()
        {
            reject_session_storage_root(
                Path::new(path),
                &manager.projects_root(),
                &manager.remote_ssh_mirror_root_dir(),
            )?;
        }
    }
    Ok(())
}

pub(crate) fn apply_workspace_record(
    config: &mut SessionConfig,
    record: &crate::service::workspace::WorkspaceInfo,
) -> crate::OpenBitFunResult<()> {
    use crate::service::workspace::WorkspaceKind;
    let (connection_id, host) = if record.workspace_kind == WorkspaceKind::Remote {
        let id = record
            .remote_ssh_connection_id()
            .map(str::trim)
            .filter(|id| !id.is_empty())
            .ok_or_else(|| {
                crate::OpenBitFunError::service(
                    "Remote workspace record is missing its saved SSH connection ID",
                )
            })?;
        let host = record
            .metadata
            .get("sshHost")
            .and_then(|v| v.as_str())
            .map(str::trim)
            .filter(|host| !host.is_empty())
            .ok_or_else(|| {
                crate::OpenBitFunError::service("Remote workspace record is missing its SSH host")
            })?;
        (Some(id.to_owned()), Some(host.to_owned()))
    } else {
        (None, None)
    };
    let root = record.root_path.to_string_lossy().into_owned();
    config.project_workspace_id = Some(
        record
            .project_workspace_id()
            .map_err(crate::OpenBitFunError::service)?
            .to_owned(),
    );
    config.project_workspace_path =
        if config.project_workspace_id.as_deref() == Some(record.id.as_str()) {
            Some(root.clone())
        } else {
            None
        };
    config.workspace_path = Some(root.clone());
    if let Some(target) = config.execution_target.as_mut() {
        target.root_path = root;
    }
    config.workspace_kind = Some(record.workspace_kind.clone());
    config.workspace_id = Some(record.id.clone());
    config.remote_connection_id = connection_id;
    config.remote_ssh_host = host;
    Ok(())
}

/// Persistence roots never become execution roots, even if they exist locally.
pub(crate) fn reject_session_storage_root(
    path: &Path,
    projects_root: &Path,
    ssh_mirror_root: &Path,
) -> crate::OpenBitFunResult<()> {
    if [projects_root, ssh_mirror_root].iter().any(|root| {
        path.starts_with(root) || dunce::canonicalize(path).is_ok_and(|path| path.starts_with(root))
    }) {
        return Err(crate::OpenBitFunError::service(
            "Session storage directories cannot be used as workspace execution roots",
        ));
    }
    Ok(())
}
