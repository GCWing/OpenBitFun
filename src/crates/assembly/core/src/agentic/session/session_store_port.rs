use std::path::{Component, Path, PathBuf};
use std::sync::Arc;

use openbitfun_runtime_ports::{
    PortError, PortErrorKind, PortResult, RuntimeServiceCapability, RuntimeServicePort,
    SessionStorageKind, SessionStoragePathRequest, SessionStoragePathResolution, SessionStorePort,
};

use crate::agentic::core::SessionConfig;
use crate::infrastructure::{get_path_manager_arc, PathManager};
use crate::service::WorkspaceRuntimeService;
use openbitfun_services_core::workspace_identity::{
    unresolved_remote_session_storage_dir, WorkspaceSessionIdentity,
};

async fn resolve_workspace_session_identity(
    workspace_path: &str,
    remote_connection_id: Option<&str>,
    remote_ssh_host: Option<&str>,
) -> Option<WorkspaceSessionIdentity> {
    let mut config = SessionConfig {
        workspace_path: Some(workspace_path.to_owned()),
        remote_connection_id: remote_connection_id.map(str::to_owned),
        remote_ssh_host: remote_ssh_host.map(str::to_owned),
        ..Default::default()
    };
    crate::agentic::workspace::normalize_session_workspace(&mut config)
        .await
        .ok()?;
    openbitfun_services_core::workspace_identity::workspace_session_identity(
        workspace_path,
        config.remote_connection_id.as_deref(),
        config.remote_ssh_host.as_deref(),
    )
}

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

    fn is_confined_to_managed_root(root: &Path, path: &Path) -> bool {
        if Self::has_parent_traversal(path) || !path.starts_with(root) {
            return false;
        }

        if !root.exists() {
            return true;
        }

        let Ok(canonical_root) = dunce::canonicalize(root) else {
            return false;
        };
        let Some(existing_ancestor) = Self::nearest_existing_ancestor(path) else {
            return false;
        };
        let Ok(canonical_ancestor) = dunce::canonicalize(existing_ancestor) else {
            return false;
        };

        canonical_ancestor == canonical_root || canonical_ancestor.starts_with(canonical_root)
    }

    fn looks_like_resolved_sessions_dir(path_manager: &PathManager, path: &Path) -> bool {
        if path.file_name().and_then(|value| value.to_str()) != Some("sessions") {
            return false;
        }

        if path.starts_with(path_manager.remote_ssh_mirror_root_dir()) {
            return true;
        }

        let projects_root = path_manager.projects_root();
        path.parent()
            .and_then(Path::parent)
            .is_some_and(|candidate| candidate == projects_root)
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

        let projects_root = path_manager.projects_root();
        let has_local_shape = path
            .parent()
            .and_then(|runtime_root| runtime_root.parent())
            .is_some_and(|candidate| candidate == projects_root.as_path());
        (has_local_shape && Self::is_confined_to_managed_root(&projects_root, path))
            .then_some(SessionStorageKind::Local)
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
        let identity = resolve_workspace_session_identity(
            &workspace_path,
            request.remote_connection_id.as_deref(),
            request.remote_ssh_host.as_deref(),
        )
        .await
        .ok_or_else(|| {
            PortError::new(
                PortErrorKind::InvalidRequest,
                format!(
                    "Session workspace_path does not resolve to a local workspace or a \
                     registered remote workspace: {workspace_path}"
                ),
            )
        })?;

        let requested_workspace_path = request.workspace_path;
        let runtime_service = WorkspaceRuntimeService::new(path_manager.clone());
        let (effective_storage_path, storage_kind, remote_ssh_host) = if !identity.is_remote() {
            (
                runtime_service
                    .context_for_local_workspace(Path::new(identity.logical_workspace_path()))
                    .sessions_dir,
                SessionStorageKind::Local,
                None,
            )
        } else if identity.hostname == "_unresolved" {
            (
                unresolved_remote_session_storage_dir(
                    path_manager.remote_ssh_mirror_root_dir(),
                    identity.remote_connection_id.as_deref().unwrap_or_default(),
                    identity.logical_workspace_path(),
                ),
                SessionStorageKind::UnresolvedRemote,
                None,
            )
        } else {
            (
                runtime_service
                    .context_for_remote_workspace(
                        &identity.hostname,
                        identity.logical_workspace_path(),
                    )
                    .sessions_dir,
                SessionStorageKind::Remote,
                Some(identity.hostname.clone()),
            )
        };

        Ok(SessionStoragePathResolution::new(
            requested_workspace_path,
            effective_storage_path,
            storage_kind,
            identity.remote_connection_id,
            remote_ssh_host,
        ))
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
