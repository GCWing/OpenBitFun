//! Dependency-light compatibility surface for local workspace identity.
//!
//! The concrete SSH facade is compiled only by `remote-workspace`. Local Agent
//! Runtime code still shares the stable workspace/session identity helpers
//! owned by `openbitfun-services-core`.
//!
//! This build cannot execute against a remote workspace. Callers that hold a
//! remote marker must refuse instead of reading the controller filesystem;
//! see [`workspace_state::remote_workspace_support`].

/// Whether the running binary can execute workspace IO against a remote
/// SSH/Docker workspace.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum RemoteWorkspaceSupport {
    /// The `remote-workspace` feature is compiled in; remote paths route to
    /// the registered SSH/Docker provider.
    Available,
    /// The `remote-workspace` feature is not compiled in. A workspace or
    /// session that carries a remote marker must be refused with a typed
    /// error; it must never be served from the controller filesystem.
    NotCompiled,
}

pub mod workspace_state {
    use std::path::PathBuf;

    pub use super::RemoteWorkspaceSupport;

    pub use openbitfun_services_core::workspace_identity::{
        canonicalize_local_workspace_root, local_workspace_roots_equal,
        local_workspace_stable_storage_id, normalize_local_workspace_root_for_stable_id,
        normalize_remote_workspace_path, remote_root_to_mirror_subpath,
        remote_workspace_session_mirror_dir as remote_workspace_session_mirror_dir_at,
        remote_workspace_stable_id, sanitize_remote_mirror_path_component,
        sanitize_ssh_connection_id_for_local_dir, sanitize_ssh_hostname_for_mirror,
        unresolved_remote_session_storage_key, workspace_logical_key, workspace_session_identity,
        WorkspaceSessionIdentity, LOCAL_WORKSPACE_SSH_HOST,
    };

    pub async fn resolve_workspace_session_identity(
        workspace_path: &str,
        remote_connection_id: Option<&str>,
        remote_ssh_host: Option<&str>,
    ) -> Option<WorkspaceSessionIdentity> {
        workspace_session_identity(workspace_path, remote_connection_id, remote_ssh_host)
    }

    pub fn remote_workspace_runtime_root(ssh_host: &str, remote_root_norm: &str) -> PathBuf {
        crate::infrastructure::get_path_manager_arc()
            .remote_workspace_runtime_root(ssh_host, remote_root_norm)
    }

    pub fn remote_workspace_session_mirror_dir(ssh_host: &str, remote_root_norm: &str) -> PathBuf {
        crate::service::workspace_runtime::WorkspaceRuntimeService::new(
            crate::infrastructure::get_path_manager_arc(),
        )
        .context_for_remote_workspace(ssh_host, remote_root_norm)
        .sessions_dir
    }

    pub fn unresolved_remote_session_storage_dir(
        connection_id: &str,
        workspace_path_norm: &str,
    ) -> PathBuf {
        openbitfun_services_core::workspace_identity::unresolved_remote_session_storage_dir(
            crate::infrastructure::get_path_manager_arc().remote_ssh_mirror_root_dir(),
            connection_id,
            workspace_path_norm,
        )
    }

    /// Whether this binary can execute against remote SSH/Docker workspaces.
    ///
    /// Callers that hold a remote marker (a persisted `remote_connection_id`,
    /// an explicit remote scope, a remote session binding, or a workspace
    /// record of kind `Remote`) must consult this before touching the
    /// controller filesystem; this build always answers `NotCompiled`.
    pub fn remote_workspace_support() -> RemoteWorkspaceSupport {
        RemoteWorkspaceSupport::NotCompiled
    }

    /// Error for a remote-marked request in a build without remote workspace
    /// support. Shared wording so every refusal names the missing feature and
    /// states that no local fallback was attempted.
    pub fn remote_workspace_not_compiled_message(path: &str) -> String {
        format!(
            "Remote workspaces are not compiled into this OpenBitFun host (feature `remote-workspace`); refusing to read the local filesystem for a remote path: {path}"
        )
    }

    /// Root of the opened workspace record of kind `Remote` that owns `path`,
    /// if any. The persisted workspace record is the only remote marker a
    /// build without the SSH registry can consult.
    pub async fn persisted_remote_workspace_root(path: &str) -> Option<String> {
        use crate::service::workspace::manager::WorkspaceKind;

        let service = crate::service::workspace::get_global_workspace_service()?;
        let needle = normalize_remote_workspace_path(path);
        service
            .get_opened_workspaces()
            .await
            .into_iter()
            .filter(|workspace| workspace.workspace_kind == WorkspaceKind::Remote)
            .map(|workspace| {
                normalize_remote_workspace_path(&workspace.root_path.to_string_lossy())
            })
            .find(|root| remote_posix_path_is_under_root(&needle, root))
    }

    /// POSIX prefix check for remote workspace paths. Remote paths are POSIX on
    /// every client OS, so this never uses host `std::path` semantics.
    pub fn remote_posix_path_is_under_root(path: &str, root: &str) -> bool {
        if root == "/" {
            return path.starts_with('/');
        }
        path == root
            || path
                .strip_prefix(root)
                .is_some_and(|rest| rest.starts_with('/'))
    }

    /// Whether `path` belongs to a workspace this host knows to be remote.
    ///
    /// Without the `remote-workspace` feature there is no SSH registry, so the
    /// persisted workspace record is the only source of truth. A `true` answer
    /// means the caller must refuse: this build cannot serve the workspace and
    /// must not read the controller filesystem in its place.
    pub async fn is_remote_path(path: &str) -> bool {
        match persisted_remote_workspace_root(path).await {
            Some(root) => {
                log::warn!(
                    "Remote workspace support is not compiled into this host; a remote workspace path was refused instead of reading the local filesystem: path={}, remote_root={}",
                    path,
                    root
                );
                true
            }
            None => false,
        }
    }
}

pub use workspace_state::normalize_remote_workspace_path;
