use std::path::{Component, Path, PathBuf};
use std::sync::Arc;

use openbitfun_runtime_ports::{
    PortError, PortErrorKind, PortResult, RuntimeServiceCapability, RuntimeServicePort,
    SessionStorageKind, SessionStoragePathRequest, SessionStoragePathResolution, SessionStorePort,
};

use crate::agentic::core::SessionConfig;
use crate::infrastructure::{get_path_manager_arc, PathManager};
use crate::service::WorkspaceRuntimeService;

#[derive(Debug, Clone, Default)]
pub struct CoreSessionStorePort {
    path_manager: Option<Arc<PathManager>>,
}

impl CoreSessionStorePort {
    pub(crate) fn with_path_manager(path_manager: Arc<PathManager>) -> Self {
        Self {
            path_manager: Some(path_manager),
        }
    }

    #[cfg(test)]
    pub fn with_path_manager_for_tests(path_manager: Arc<PathManager>) -> Self {
        Self::with_path_manager(path_manager)
    }

    fn path_manager(&self) -> Arc<PathManager> {
        self.path_manager
            .clone()
            .unwrap_or_else(get_path_manager_arc)
    }

    pub async fn resolve_storage_path_for_config(
        config: &SessionConfig,
    ) -> Option<SessionStoragePathResolution> {
        if let Some(id) = config.workspace_id.as_deref() {
            return Self::default().resolve_workspace_storage(id).await.ok();
        }
        let workspace_path = config.workspace_path.as_ref()?;
        let request = SessionStoragePathRequest {
            workspace_path: PathBuf::from(workspace_path),
            remote_connection_id: config.remote_connection_id.clone(),
            remote_ssh_host: config.remote_ssh_host.clone(),
        };
        Self::default()
            .resolve_session_storage_path(request)
            .await
            .ok()
    }

    /// ID-first storage resolution for request DTOs that still carry a
    /// pre-ID `(path, connection, ssh)` selector. The ID is authoritative
    /// whenever present; the legacy selector is only consulted for producers
    /// that predate workspace IDs.
    pub(crate) async fn resolve_storage_for_reference(
        &self,
        workspace_id: Option<&str>,
        workspace_path: &str,
        remote_connection_id: Option<String>,
        remote_ssh_host: Option<String>,
    ) -> PortResult<SessionStoragePathResolution> {
        if let Some(id) = workspace_id.map(str::trim).filter(|id| !id.is_empty()) {
            return self.resolve_workspace_storage(id).await;
        }
        if workspace_path.trim().is_empty() {
            return Err(PortError::new(
                PortErrorKind::InvalidRequest,
                "Session request must carry a workspace_id or a legacy workspace_path",
            ));
        }
        self.resolve_session_storage_path(SessionStoragePathRequest {
            workspace_path: PathBuf::from(workspace_path),
            remote_connection_id,
            remote_ssh_host,
        })
        .await
    }

    fn has_parent_traversal(path: &Path) -> bool {
        path.components()
            .any(|component| matches!(component, Component::ParentDir))
    }

    fn nearest_existing_ancestor(path: &Path) -> Option<&Path> {
        let mut candidate = Some(path);
        while let Some(current) = candidate {
            if current.exists() {
                return Some(current);
            }
            candidate = current.parent();
        }
        None
    }

    fn canonical_storage_projection(path: &Path) -> Option<PathBuf> {
        if Self::has_parent_traversal(path) {
            return None;
        }
        let ancestor = Self::nearest_existing_ancestor(path)?;
        Some(
            dunce::canonicalize(ancestor)
                .ok()?
                .join(path.strip_prefix(ancestor).ok()?),
        )
    }

    fn is_confined_to_managed_root(root: &Path, path: &Path) -> bool {
        match (
            Self::canonical_storage_projection(root),
            Self::canonical_storage_projection(path),
        ) {
            (Some(root), Some(path)) => path.starts_with(root),
            _ => false,
        }
    }

    fn looks_like_resolved_sessions_dir(path_manager: &PathManager, path: &Path) -> bool {
        if path.file_name().and_then(|value| value.to_str()) != Some("sessions") {
            return false;
        }

        if path.starts_with(path_manager.remote_ssh_mirror_root_dir()) {
            return true;
        }

        let projects_root = path_manager.projects_root();
        let lexical_shape = path
            .parent()
            .and_then(Path::parent)
            .is_some_and(|candidate| candidate == projects_root);
        lexical_shape || Self::resolved_sessions_dir_kind(path_manager, path).is_some()
    }

    fn project_runtime_sessions_kind(
        path_manager: &PathManager,
        path: &Path,
    ) -> SessionStorageKind {
        let Some(runtime_root) = path.parent() else {
            return SessionStorageKind::Local;
        };
        let state_path = runtime_root
            .join("config")
            .join("runtime_layout_state.json");
        let Ok(bytes) = std::fs::read(state_path) else {
            return SessionStorageKind::Local;
        };
        let Ok(state) = serde_json::from_slice::<serde_json::Value>(&bytes) else {
            return SessionStorageKind::Local;
        };
        if state.get("target_kind").and_then(serde_json::Value::as_str)
            == Some("remote_workspace_mirror")
            && Self::is_confined_to_managed_root(&path_manager.projects_root(), path)
        {
            SessionStorageKind::Remote
        } else {
            SessionStorageKind::Local
        }
    }

    pub(crate) fn resolved_sessions_dir_kind(
        path_manager: &PathManager,
        path: &Path,
    ) -> Option<SessionStorageKind> {
        if Self::has_parent_traversal(path)
            || path.file_name().and_then(|value| value.to_str()) != Some("sessions")
        {
            return None;
        }

        // Committed bindings may be canonical (for example /private/var on
        // macOS) while PathManager retains an equivalent symlink spelling.
        // Compare physical projections, including not-yet-created suffixes,
        // so a sessions directory cannot be reinterpreted as a workspace root.
        let canonical_path = Self::canonical_storage_projection(path)?;
        let path = canonical_path.as_path();

        let remote_mirror_root = path_manager.remote_ssh_mirror_root_dir();
        if Self::is_confined_to_managed_root(&remote_mirror_root, path) {
            return Some(
                if path
                    .components()
                    .any(|component| component.as_os_str() == std::ffi::OsStr::new("_unresolved"))
                {
                    SessionStorageKind::UnresolvedRemote
                } else {
                    SessionStorageKind::Remote
                },
            );
        }

        let projects_root = Self::canonical_storage_projection(&path_manager.projects_root())?;
        let has_local_shape = path
            .parent()
            .and_then(|runtime_root| runtime_root.parent())
            .is_some_and(|candidate| candidate == projects_root.as_path());
        if has_local_shape && Self::is_confined_to_managed_root(&projects_root, path) {
            Some(Self::project_runtime_sessions_kind(path_manager, path))
        } else {
            None
        }
    }
}

impl RuntimeServicePort for CoreSessionStorePort {
    fn capability(&self) -> RuntimeServiceCapability {
        RuntimeServiceCapability::SessionStore
    }
}

#[async_trait::async_trait]
impl SessionStorePort for CoreSessionStorePort {
    async fn resolve_workspace_storage(
        &self,
        workspace_id: &str,
    ) -> PortResult<SessionStoragePathResolution> {
        use crate::service::workspace::{get_global_workspace_service, WorkspaceKind};
        let service = get_global_workspace_service().ok_or_else(|| {
            PortError::new(
                PortErrorKind::InvalidRequest,
                "Workspace service is unavailable",
            )
        })?;
        let workspace = service
            .require_workspace(workspace_id)
            .await
            .map_err(|error| PortError::new(PortErrorKind::InvalidRequest, error.to_string()))?;
        let project_id = workspace
            .project_workspace_id()
            .map_err(|error| PortError::new(PortErrorKind::InvalidRequest, error))?;
        let project = service
            .require_workspace(project_id)
            .await
            .map_err(|error| PortError::new(PortErrorKind::InvalidRequest, error.to_string()))?;
        let runtime = WorkspaceRuntimeService::new(self.path_manager());
        let (storage, kind, connection_id, host) = match workspace.workspace_kind {
            WorkspaceKind::Normal | WorkspaceKind::Assistant => (
                runtime
                    .context_for_local_workspace(&project.root_path)
                    .sessions_dir,
                SessionStorageKind::Local,
                None,
                None,
            ),
            WorkspaceKind::Remote => {
                let connection_id = workspace.remote_ssh_connection_id().ok_or_else(|| {
                    PortError::new(
                        PortErrorKind::InvalidRequest,
                        "Remote workspace record is missing its saved SSH connection ID",
                    )
                })?;
                let host = workspace
                    .metadata
                    .get("sshHost")
                    .and_then(|value| value.as_str())
                    .filter(|host| !host.trim().is_empty())
                    .ok_or_else(|| {
                        PortError::new(
                            PortErrorKind::InvalidRequest,
                            "Remote workspace record is missing its SSH host",
                        )
                    })?;
                (
                    runtime
                        .context_for_remote_workspace(host, &workspace.root_path.to_string_lossy())
                        .sessions_dir,
                    SessionStorageKind::Remote,
                    Some(connection_id.to_owned()),
                    Some(host.to_owned()),
                )
            }
        };
        Ok(SessionStoragePathResolution::new(
            workspace.root_path,
            storage,
            kind,
            connection_id,
            host,
        ))
    }

    async fn resolve_session_storage_path(
        &self,
        request: SessionStoragePathRequest,
    ) -> PortResult<SessionStoragePathResolution> {
        let path_manager = self.path_manager();
        if Self::has_parent_traversal(&request.workspace_path) {
            return Err(PortError::new(
                PortErrorKind::InvalidRequest,
                "Session workspace_path must not contain parent-directory traversal",
            ));
        }
        if let Some(storage_kind) =
            Self::resolved_sessions_dir_kind(&path_manager, &request.workspace_path)
        {
            return Ok(SessionStoragePathResolution::new(
                request.workspace_path.clone(),
                request.workspace_path,
                storage_kind,
                request.remote_connection_id,
                request.remote_ssh_host,
            ));
        }
        if Self::looks_like_resolved_sessions_dir(&path_manager, &request.workspace_path) {
            return Err(PortError::new(
                PortErrorKind::InvalidRequest,
                "Resolved session storage path is outside its managed root",
            ));
        }

        let workspace_path = request.workspace_path.to_string_lossy().to_string();
        let mut config = SessionConfig {
            workspace_path: Some(workspace_path.clone()),
            remote_connection_id: request.remote_connection_id,
            remote_ssh_host: request.remote_ssh_host,
            ..Default::default()
        };
        // Convert pre-ID input exactly once at this compatibility boundary.
        // Storage then follows the same catalog record as current ID requests;
        // do not re-infer local/SSH identity from filesystem existence.
        crate::agentic::workspace::normalize_session_workspace(&mut config)
            .await
            .map_err(|error| {
                PortError::new(
                    PortErrorKind::InvalidRequest,
                    format!(
                        "Session workspace_path does not resolve to a local workspace or a \
                     registered remote workspace: {workspace_path}: {error}"
                    ),
                )
            })?;
        let mut resolution = self
            .resolve_workspace_storage(config.workspace_id.as_deref().ok_or_else(|| {
                PortError::new(
                    PortErrorKind::InvalidRequest,
                    "Session workspace ID is unavailable",
                )
            })?)
            .await?;
        resolution.requested_workspace_path = request.workspace_path;
        Ok(resolution)
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use uuid::Uuid;

    fn test_port() -> (CoreSessionStorePort, PathBuf) {
        let test_root =
            std::env::temp_dir().join(format!("openbitfun-session-store-port-{}", Uuid::new_v4()));
        let path_manager = Arc::new(PathManager::with_user_root_for_tests(
            test_root.join("user"),
        ));
        (
            CoreSessionStorePort::with_path_manager_for_tests(path_manager),
            test_root,
        )
    }

    #[tokio::test]
    async fn resolved_sessions_path_rejects_parent_directory_traversal() {
        let (port, test_root) = test_port();
        let remote_root = port.path_manager().remote_ssh_mirror_root_dir();
        let path = remote_root
            .join("example-host")
            .join("repo")
            .join("..")
            .join("outside")
            .join("sessions");

        let result = port
            .resolve_session_storage_path(SessionStoragePathRequest {
                workspace_path: path,
                remote_connection_id: None,
                remote_ssh_host: None,
            })
            .await;

        assert!(result.is_err());
        let _ = std::fs::remove_dir_all(test_root);
    }

    #[cfg(unix)]
    #[tokio::test]
    async fn resolved_sessions_path_accepts_canonical_user_root_alias_without_relocating_history() {
        let root = tempfile::tempdir().unwrap();
        let physical = root.path().join("physical");
        let alias = root.path().join("alias");
        std::fs::create_dir_all(&physical).unwrap();
        std::os::unix::fs::symlink(&physical, &alias).unwrap();
        // Product home is derived from the user root's parent, so the user
        // root must sit below the alias for managed paths to use it.
        let user_root = alias.join("user");
        std::fs::create_dir_all(&user_root).unwrap();
        let path_manager = Arc::new(PathManager::with_user_root_for_tests(user_root));
        let port = CoreSessionStorePort::with_path_manager_for_tests(path_manager.clone());
        let projected = path_manager
            .projects_root()
            .join("project-key")
            .join("sessions");
        std::fs::create_dir_all(&projected).unwrap();
        let canonical = dunce::canonicalize(&projected).unwrap();
        assert_ne!(canonical, projected);
        for path in [projected, canonical.clone()] {
            let resolution = port
                .resolve_session_storage_path(SessionStoragePathRequest {
                    workspace_path: path.clone(),
                    remote_connection_id: None,
                    remote_ssh_host: None,
                })
                .await
                .unwrap();
            assert_eq!(resolution.effective_storage_path, path);
            assert_eq!(resolution.storage_kind, SessionStorageKind::Local);
        }
        std::fs::remove_dir(&canonical).unwrap();
        assert_eq!(
            CoreSessionStorePort::resolved_sessions_dir_kind(&path_manager, &canonical),
            Some(SessionStorageKind::Local)
        );
    }

    #[cfg(unix)]
    #[tokio::test]
    async fn resolved_sessions_path_rejects_symlink_escape() {
        use std::os::unix::fs::symlink;

        let (port, test_root) = test_port();
        let remote_root = port.path_manager().remote_ssh_mirror_root_dir();
        let outside = test_root.join("outside");
        std::fs::create_dir_all(outside.join("sessions")).expect("outside sessions directory");
        std::fs::create_dir_all(&remote_root).expect("remote root");
        symlink(&outside, remote_root.join("escape")).expect("escape symlink");

        let result = port
            .resolve_session_storage_path(SessionStoragePathRequest {
                workspace_path: remote_root.join("escape").join("sessions"),
                remote_connection_id: None,
                remote_ssh_host: None,
            })
            .await;

        assert!(result.is_err());
        let _ = std::fs::remove_dir_all(test_root);
    }
}
