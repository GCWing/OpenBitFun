//! Remote Workspace Global State
//!
//! Provides a **registry** of remote SSH workspaces so that multiple remote
//! workspaces can coexist. Each registration is uniquely identified by
//! **`(connection_id, remote_root_path)`** — *not* by remote path alone, so two
//! different servers opened at the same path (e.g. `/`) do not overwrite each other.

use crate::infrastructure::get_path_manager_arc;
use crate::service::remote_ssh::{RemoteFileService, RemoteTerminalManager, SSHConnectionManager};
use crate::service::workspace_runtime::WorkspaceRuntimeService;
pub use openbitfun_services_integrations::remote_ssh::{
    local_workspace_stable_storage_id, normalize_remote_workspace_path,
    remote_root_to_mirror_subpath, remote_workspace_stable_id,
    sanitize_remote_mirror_path_component, sanitize_ssh_connection_id_for_local_dir,
    sanitize_ssh_hostname_for_mirror, unresolved_remote_session_storage_key, workspace_logical_key,
    workspace_session_identity, RemoteWorkspaceEntry, RemoteWorkspaceRegistry,
    RemoteWorkspaceState, WorkspaceSessionIdentity, LOCAL_WORKSPACE_SSH_HOST,
};
use std::path::{Path, PathBuf};
use std::sync::Arc;
use tokio::sync::RwLock;

/// Resolve a session identity while tolerating temporarily unresolved remote hosts.
/// If the remote host is unknown, fall back to the dedicated unresolved session tree.
pub async fn resolve_workspace_session_identity(
    workspace_path: &str,
    remote_connection_id: Option<&str>,
    remote_ssh_host: Option<&str>,
) -> Option<WorkspaceSessionIdentity> {
    let remote_connection_id = remote_connection_id
        .map(str::trim)
        .filter(|s| !s.is_empty());

    if let Some(connection_id) = remote_connection_id {
        if let Some(host) = remote_ssh_host.map(str::trim).filter(|s| !s.is_empty()) {
            return workspace_session_identity(workspace_path, Some(connection_id), Some(host));
        }

        if let Some(entry) =
            lookup_remote_connection_with_hint(workspace_path, Some(connection_id)).await
        {
            return Some(WorkspaceSessionIdentity {
                workspace_kind: openbitfun_core_types::WorkspaceKind::Remote,
                hostname: entry.ssh_host,
                logical_workspace_path: entry.remote_root,
                remote_connection_id: Some(entry.connection_id),
            });
        }

        return Some(WorkspaceSessionIdentity {
            workspace_kind: openbitfun_core_types::WorkspaceKind::Remote,
            hostname: "_unresolved".to_string(),
            logical_workspace_path: normalize_remote_workspace_path(workspace_path),
            remote_connection_id: Some(connection_id.to_string()),
        });
    }

    if let Some(identity) = workspace_session_identity(workspace_path, None, None) {
        return Some(identity);
    }

    // The path cannot be resolved as a local workspace root (remote workspace
    // paths do not exist on the local filesystem). Callers such as dialog-turn
    // submission may legitimately lose the remote connection id, so fall back
    // to the remote workspace registry before failing: a registered remote
    // workspace must never be misclassified as an invalid local path.
    if let Some(entry) = lookup_remote_connection_with_hint(workspace_path, None).await {
        return Some(WorkspaceSessionIdentity {
            workspace_kind: openbitfun_core_types::WorkspaceKind::Remote,
            hostname: entry.ssh_host,
            logical_workspace_path: entry.remote_root,
            remote_connection_id: Some(entry.connection_id),
        });
    }

    None
}
/// Local directory where persisted sessions for this remote workspace root are stored.
pub fn remote_workspace_runtime_root(ssh_host: &str, remote_root_norm: &str) -> PathBuf {
    openbitfun_services_integrations::remote_ssh::remote_workspace_runtime_root(
        get_path_manager_arc().remote_ssh_mirror_root_dir(),
        ssh_host,
        remote_root_norm,
    )
}

/// Local directory where persisted sessions for this remote workspace root are stored.
pub fn remote_workspace_session_mirror_dir(ssh_host: &str, remote_root_norm: &str) -> PathBuf {
    openbitfun_services_integrations::remote_ssh::remote_workspace_session_mirror_dir(
        get_path_manager_arc().remote_ssh_mirror_root_dir(),
        ssh_host,
        remote_root_norm,
    )
}

/// Canonical local root [`PathBuf`] plus normalized string form (single `canonicalize` call).
pub fn canonicalize_local_workspace_root(path: &Path) -> Result<(PathBuf, String), String> {
    openbitfun_services_integrations::remote_ssh::canonicalize_local_workspace_root(path)
}

/// Canonical absolute local path as a stable UTF-8 string (forward slashes, dunce-simplified).
pub fn normalize_local_workspace_root_for_stable_id(path: &Path) -> Result<String, String> {
    openbitfun_services_integrations::remote_ssh::normalize_local_workspace_root_for_stable_id(path)
}

/// Whether two local paths refer to the same workspace root (canonical comparison when possible).
pub fn local_workspace_roots_equal(a: &Path, b: &Path) -> bool {
    openbitfun_services_integrations::remote_ssh::local_workspace_roots_equal(a, b)
}

/// When a remote scope has `connection_id` but no resolvable SSH host, we must not read/write the
/// legacy per-connection tree (it is not the same layout as `remote_ssh/{host}/.../sessions`).
/// This returns a dedicated stub under `~/.openbitfun/remote_ssh/_unresolved/.../sessions` that is
/// usually absent, so session listing is empty until host can be resolved.
pub fn unresolved_remote_session_storage_dir(
    connection_id: &str,
    workspace_path_norm: &str,
) -> PathBuf {
    openbitfun_services_integrations::remote_ssh::unresolved_remote_session_storage_dir(
        get_path_manager_arc().remote_ssh_mirror_root_dir(),
        connection_id,
        workspace_path_norm,
    )
}

/// Global remote workspace state manager.
///
/// Registrations are keyed logically by **`(connection_id, remote_root)`** so the same
/// POSIX path on different SSH hosts never collides.
pub struct RemoteWorkspaceStateManager {
    registry: RemoteWorkspaceRegistry,
    /// SSH connection manager (shared across all workspaces).
    ssh_manager: Arc<RwLock<Option<SSHConnectionManager>>>,
    /// Remote file service (shared).
    file_service: Arc<RwLock<Option<RemoteFileService>>>,
    /// Remote terminal manager (shared).
    terminal_manager: Arc<RwLock<Option<RemoteTerminalManager>>>,
}

impl Default for RemoteWorkspaceStateManager {
    fn default() -> Self {
        Self::new()
    }
}

impl RemoteWorkspaceStateManager {
    pub fn new() -> Self {
        Self {
            registry: RemoteWorkspaceRegistry::new(),
            ssh_manager: Arc::new(RwLock::new(None)),
            file_service: Arc::new(RwLock::new(None)),
            terminal_manager: Arc::new(RwLock::new(None)),
        }
    }

    // ── Service setters (shared across all workspaces) ─────────────

    pub async fn set_ssh_manager(&self, manager: SSHConnectionManager) {
        *self.ssh_manager.write().await = Some(manager);
    }

    pub async fn set_file_service(&self, service: RemoteFileService) {
        *self.file_service.write().await = Some(service);
    }

    pub async fn set_terminal_manager(&self, manager: RemoteTerminalManager) {
        *self.terminal_manager.write().await = Some(manager);
    }

    /// Prefer this SSH `connection_id` when resolving an ambiguous remote path.
    pub async fn set_active_connection_hint(&self, connection_id: Option<String>) {
        self.registry
            .set_active_connection_hint(connection_id)
            .await;
    }

    // ── Registry API ───────────────────────────────────────────────

    /// Register (or replace) a remote workspace for **`(connection_id, remote_path)`**.
    pub async fn register_remote_workspace(
        &self,
        remote_path: String,
        connection_id: String,
        connection_name: String,
        ssh_host: String,
    ) {
        self.registry
            .register_remote_workspace(remote_path, connection_id, connection_name, ssh_host)
            .await;
    }

    /// Remove the registration for this **exact** SSH connection + remote root.
    pub async fn unregister_remote_workspace(&self, connection_id: &str, remote_path: &str) {
        self.registry
            .unregister_remote_workspace(connection_id, remote_path)
            .await;
    }

    /// Look up the connection info for a given remote path.
    ///
    /// `preferred_connection_id` should be supplied when known (e.g. from session metadata).
    /// If omitted and multiple registrations share the same longest matching root,
    /// [`Self::active_connection_hint`] is used when it matches one of them.
    pub async fn lookup_connection(
        &self,
        path: &str,
        preferred_connection_id: Option<&str>,
    ) -> Option<RemoteWorkspaceEntry> {
        // Assistant sessions use client-local paths under ~/.openbitfun/personal_assistant.
        // A registered remote root of `/` matches every absolute path; without an explicit
        // `remote_connection_id`, those paths must not be treated as SSH workspaces.
        let is_local_assistant_path =
            get_path_manager_arc().is_local_assistant_workspace_path(path);
        if is_local_assistant_path {
            let preferred_connection_id = preferred_connection_id?;
            return self
                .registry
                .lookup_by_connection_id(preferred_connection_id)
                .await;
        }

        self.registry
            .lookup_connection(path, preferred_connection_id)
            .await
    }

    /// Resolve an exact `(connection_id, path)` workspace scope without
    /// selecting a different connection through legacy hint behavior.
    pub async fn lookup_scoped_connection(
        &self,
        path: &str,
        connection_id: &str,
    ) -> Option<RemoteWorkspaceEntry> {
        self.registry
            .lookup_scoped_connection(path, connection_id)
            .await
    }

    /// True if `path` could belong to **any** registered remote root (before disambiguation).
    pub async fn is_remote_path(&self, path: &str) -> bool {
        if get_path_manager_arc().is_local_assistant_workspace_path(path) {
            return false;
        }
        self.registry.is_remote_path(path).await
    }

    /// Returns `true` if at least one remote workspace is registered.
    pub async fn has_any(&self) -> bool {
        self.registry.has_any().await
    }

    // ── Legacy compat ──────────────────────────────────────────────

    /// **Compat** — old code calls `activate_remote_workspace`.  Now just
    /// delegates to `register_remote_workspace`.
    pub async fn activate_remote_workspace(
        &self,
        connection_id: String,
        remote_path: String,
        connection_name: String,
    ) {
        self.register_remote_workspace(remote_path, connection_id, connection_name, String::new())
            .await;
    }

    /// **Compat** — old code calls `deactivate_remote_workspace`.
    /// Clears all registrations and the active hint (use sparingly).
    pub async fn deactivate_remote_workspace(&self) {
        self.registry.clear().await;
    }

    /// **Compat** — returns a snapshot shaped like the old single-workspace
    /// state.  Picks the *first* registered workspace.
    pub async fn get_state(&self) -> RemoteWorkspaceState {
        self.registry.get_state().await
    }

    /// **Compat** — returns true if any workspace is registered.
    pub async fn is_active(&self) -> bool {
        self.has_any().await
    }

    // ── Service getters ────────────────────────────────────────────

    pub async fn get_ssh_manager(&self) -> Option<SSHConnectionManager> {
        self.ssh_manager.read().await.clone()
    }

    pub async fn get_file_service(&self) -> Option<RemoteFileService> {
        self.file_service.read().await.clone()
    }

    pub async fn get_terminal_manager(&self) -> Option<RemoteTerminalManager> {
        self.terminal_manager.read().await.clone()
    }

    // ── Session storage ────────────────────────────────────────────

    /// Local mirror directory for persisted sessions (`~/.openbitfun/remote_ssh/.../sessions`).
    pub fn get_remote_session_mirror_path(
        &self,
        ssh_host: &str,
        remote_root_norm: &str,
    ) -> PathBuf {
        remote_workspace_session_mirror_dir(ssh_host, remote_root_norm)
    }

    /// Map a workspace path to the final on-disk sessions directory.
    /// Local roots map to `~/.openbitfun/projects/<workspace-slug>/sessions`;
    /// remote roots map to the local SSH mirror sessions dir.
    pub async fn get_effective_session_path(
        &self,
        workspace_path: &str,
        remote_connection_id: Option<&str>,
        remote_ssh_host: Option<&str>,
    ) -> PathBuf {
        let runtime_service = WorkspaceRuntimeService::new(get_path_manager_arc());
        let remote_id = remote_connection_id
            .map(str::trim)
            .filter(|s| !s.is_empty());
        if remote_id.is_none() {
            return runtime_service
                .context_for_local_workspace(Path::new(workspace_path))
                .sessions_dir;
        }
        let path_norm = normalize_remote_workspace_path(workspace_path);
        if let Some(host) = remote_ssh_host.map(str::trim).filter(|s| !s.is_empty()) {
            return runtime_service
                .context_for_remote_workspace(host, &path_norm)
                .sessions_dir;
        }
        if let Some(entry) = self.lookup_connection(workspace_path, remote_id).await {
            if !entry.ssh_host.trim().is_empty() {
                return runtime_service
                    .context_for_remote_workspace(&entry.ssh_host, &entry.remote_root)
                    .sessions_dir;
            }
            return unresolved_remote_session_storage_dir(remote_id.unwrap(), &path_norm);
        }
        unresolved_remote_session_storage_dir(remote_id.unwrap(), &path_norm)
    }
}

// ── Global singleton ────────────────────────────────────────────────

static REMOTE_WORKSPACE_MANAGER: std::sync::OnceLock<Arc<RemoteWorkspaceStateManager>> =
    std::sync::OnceLock::new();

pub fn init_remote_workspace_manager() -> Arc<RemoteWorkspaceStateManager> {
    if let Some(existing) = REMOTE_WORKSPACE_MANAGER.get() {
        return existing.clone();
    }
    let manager = Arc::new(RemoteWorkspaceStateManager::new());
    match REMOTE_WORKSPACE_MANAGER.set(manager.clone()) {
        Ok(()) => manager,
        Err(_) => REMOTE_WORKSPACE_MANAGER.get().cloned().unwrap_or(manager),
    }
}

pub fn get_remote_workspace_manager() -> Option<Arc<RemoteWorkspaceStateManager>> {
    REMOTE_WORKSPACE_MANAGER.get().cloned()
}

// ── Free-standing helpers (convenience) ─────────────────────────────

/// Resolve persisted session directory for a workspace path.
pub async fn get_effective_session_path(
    workspace_path: &str,
    remote_connection_id: Option<&str>,
    remote_ssh_host: Option<&str>,
) -> std::path::PathBuf {
    let runtime_service = WorkspaceRuntimeService::new(get_path_manager_arc());
    if let Some(identity) =
        resolve_workspace_session_identity(workspace_path, remote_connection_id, remote_ssh_host)
            .await
    {
        if identity.hostname == "_unresolved" {
            if let Some(connection_id) = identity.remote_connection_id.as_deref() {
                return unresolved_remote_session_storage_dir(
                    connection_id,
                    identity.logical_workspace_path(),
                );
            }
        }
        if !identity.is_remote() {
            return runtime_service
                .context_for_local_workspace(Path::new(identity.logical_workspace_path()))
                .sessions_dir;
        }
        return runtime_service
            .context_for_remote_workspace(&identity.hostname, identity.logical_workspace_path())
            .sessions_dir;
    }

    runtime_service
        .context_for_local_workspace(Path::new(workspace_path))
        .sessions_dir
}

/// Whether the running binary can execute workspace IO against a remote
/// SSH/Docker workspace. This build compiles the SSH facade, so remote paths
/// route to the registered provider; the `remote-workspace`-less build answers
/// `NotCompiled` and must refuse remote-marked requests instead.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum RemoteWorkspaceSupport {
    Available,
    NotCompiled,
}

/// See [`RemoteWorkspaceSupport`]; always `Available` in this build.
pub fn remote_workspace_support() -> RemoteWorkspaceSupport {
    RemoteWorkspaceSupport::Available
}

/// Shared refusal wording for a remote-marked request the host cannot serve.
/// Mirrors the `remote-workspace`-less compat module so callers can use one
/// message regardless of build; unreachable through
/// [`remote_workspace_support`] here.
pub fn remote_workspace_not_compiled_message(path: &str) -> String {
    format!(
        "Remote workspaces are not compiled into this OpenBitFun host (feature `remote-workspace`); refusing to read the local filesystem for a remote path: {path}"
    )
}

/// Check if a specific path belongs to any registered remote workspace.
pub async fn is_remote_path(path: &str) -> bool {
    if let Some(manager) = get_remote_workspace_manager() {
        manager.is_remote_path(path).await
    } else {
        false
    }
}

/// Look up the connection entry for a given path (optional explicit `connection_id`).
pub async fn lookup_remote_connection_with_hint(
    path: &str,
    preferred_connection_id: Option<&str>,
) -> Option<RemoteWorkspaceEntry> {
    let manager = get_remote_workspace_manager()?;
    manager
        .lookup_connection(path, preferred_connection_id)
        .await
}

/// Look up an exact `(connection_id, path)` remote workspace scope.
pub async fn lookup_remote_connection_scoped(
    path: &str,
    connection_id: &str,
) -> Option<RemoteWorkspaceEntry> {
    let manager = get_remote_workspace_manager()?;
    manager.lookup_scoped_connection(path, connection_id).await
}

/// Look up using path only (uses active hint when ambiguous).
pub async fn lookup_remote_connection(path: &str) -> Option<RemoteWorkspaceEntry> {
    lookup_remote_connection_with_hint(path, None).await
}

#[cfg(test)]
mod tests {
    use super::remote_workspace_session_mirror_dir;
    use crate::infrastructure::PathManager;

    #[tokio::test]
    async fn local_assistant_path_not_remote_without_connection_id() {
        let pm = PathManager::default();
        let assistant_path = pm
            .assistant_workspace_dir("d3726520", None)
            .to_string_lossy()
            .to_string();
        let m = super::RemoteWorkspaceStateManager::new();
        m.register_remote_workspace(
            "/".to_string(),
            "conn".to_string(),
            "S".to_string(),
            "h1".to_string(),
        )
        .await;
        assert!(
            m.lookup_connection(&assistant_path, None).await.is_none(),
            "assistant workspace must not bind to SSH when remote_connection_id is omitted"
        );
        assert!(
            m.lookup_connection(&assistant_path, Some("conn"))
                .await
                .is_some(),
            "explicit remote_connection_id should still resolve for edge cases"
        );
    }

    #[tokio::test]
    async fn two_servers_same_root_both_registered() {
        let m = super::RemoteWorkspaceStateManager::new();
        m.register_remote_workspace(
            "/".to_string(),
            "conn-a".to_string(),
            "Server A".to_string(),
            "host-a".to_string(),
        )
        .await;
        m.register_remote_workspace(
            "/".to_string(),
            "conn-b".to_string(),
            "Server B".to_string(),
            "host-b".to_string(),
        )
        .await;
        m.set_active_connection_hint(Some("conn-a".to_string()))
            .await;
        let a = m.lookup_connection("/tmp", None).await.unwrap();
        assert_eq!(a.connection_id, "conn-a");
        m.set_active_connection_hint(Some("conn-b".to_string()))
            .await;
        let b = m.lookup_connection("/tmp", None).await.unwrap();
        assert_eq!(b.connection_id, "conn-b");
    }

    #[tokio::test]
    async fn preferred_connection_wins_over_hint() {
        let m = super::RemoteWorkspaceStateManager::new();
        m.register_remote_workspace(
            "/".to_string(),
            "c1".to_string(),
            "A".to_string(),
            "h1".to_string(),
        )
        .await;
        m.register_remote_workspace(
            "/".to_string(),
            "c2".to_string(),
            "B".to_string(),
            "h1".to_string(),
        )
        .await;
        m.set_active_connection_hint(Some("c1".to_string())).await;
        let x = m.lookup_connection("/x", Some("c2")).await.unwrap();
        assert_eq!(x.connection_id, "c2");
    }

    #[tokio::test]
    async fn identity_falls_back_to_registry_when_connection_id_is_missing() {
        let manager = super::init_remote_workspace_manager();
        manager
            .register_remote_workspace(
                "/openbitfun-tests/identity-fallback/repo".to_string(),
                "conn-identity-fallback".to_string(),
                "Fallback Server".to_string(),
                "fallback-host".to_string(),
            )
            .await;

        let identity = super::resolve_workspace_session_identity(
            "/openbitfun-tests/identity-fallback/repo",
            None,
            None,
        )
        .await
        .expect("registered remote workspace must resolve without an explicit connection id");

        assert_eq!(identity.hostname, "fallback-host");
        assert_eq!(
            identity.remote_connection_id.as_deref(),
            Some("conn-identity-fallback")
        );
        assert_eq!(
            identity.logical_workspace_path(),
            "/openbitfun-tests/identity-fallback/repo"
        );

        manager
            .unregister_remote_workspace(
                "conn-identity-fallback",
                "/openbitfun-tests/identity-fallback/repo",
            )
            .await;

        assert!(
            super::resolve_workspace_session_identity(
                "/openbitfun-tests/identity-fallback/repo",
                None,
                None,
            )
            .await
            .is_none(),
            "unregistered non-local paths must still fail to resolve"
        );
    }

    #[tokio::test]
    async fn effective_session_path_returns_local_sessions_dir() {
        let workspace_root = std::env::temp_dir().join(format!(
            "openbitfun-local-session-path-test-{}",
            uuid::Uuid::new_v4()
        ));
        std::fs::create_dir_all(&workspace_root).expect("workspace root should exist");

        let expected =
            crate::infrastructure::get_path_manager_arc().project_sessions_dir(&workspace_root);
        let actual =
            super::get_effective_session_path(&workspace_root.to_string_lossy(), None, None).await;

        assert_eq!(actual, expected);

        let _ = std::fs::remove_dir_all(workspace_root);
    }

    #[tokio::test]
    async fn effective_session_path_returns_remote_sessions_dir() {
        let actual = super::get_effective_session_path(
            "/home/wsp/projects/test",
            Some("conn-1"),
            Some("example-host"),
        )
        .await;

        assert_eq!(
            actual,
            remote_workspace_session_mirror_dir("example-host", "/home/wsp/projects/test")
        );
    }

    #[tokio::test]
    async fn manager_effective_session_path_returns_local_sessions_dir() {
        let workspace_root = std::env::temp_dir().join(format!(
            "openbitfun-manager-local-session-path-test-{}",
            uuid::Uuid::new_v4()
        ));
        std::fs::create_dir_all(&workspace_root).expect("workspace root should exist");

        let manager = super::RemoteWorkspaceStateManager::new();
        let expected =
            crate::infrastructure::get_path_manager_arc().project_sessions_dir(&workspace_root);
        let actual = manager
            .get_effective_session_path(&workspace_root.to_string_lossy(), None, None)
            .await;

        assert_eq!(actual, expected);

        let _ = std::fs::remove_dir_all(workspace_root);
    }
}

/// Initialize the same saved-profile providers for headless hosts. Existing
/// graphical-host providers are reused, never replaced during a live session.
#[cfg(feature = "ssh-remote")]
pub async fn ensure_saved_connection_services() -> Result<Arc<RemoteWorkspaceStateManager>, String>
{
    static INITIALIZED: tokio::sync::OnceCell<()> = tokio::sync::OnceCell::const_new();
    let state = init_remote_workspace_manager();
    if state.get_ssh_manager().await.is_some() && state.get_file_service().await.is_some() {
        return Ok(state);
    }
    INITIALIZED
        .get_or_try_init(|| async {
            let data_dir = if std::env::var_os("OPENBITFUN_HOME").is_some() {
                crate::infrastructure::try_get_path_manager_arc()
                    .map_err(|e| e.to_string())?
                    .user_data_dir()
                    .join("ssh")
            } else {
                dirs::data_local_dir()
                    .ok_or("Application data directory is unavailable")?
                    .join("OpenBitFun")
                    .join("ssh")
            };
            let ssh = SSHConnectionManager::new(data_dir);
            ssh.load_saved_connections()
                .await
                .map_err(|e| e.to_string())?;
            ssh.load_known_hosts().await.map_err(|e| e.to_string())?;
            state
                .set_file_service(RemoteFileService::new(Arc::new(RwLock::new(Some(
                    ssh.clone(),
                )))))
                .await;
            state
                .set_terminal_manager(RemoteTerminalManager::new(ssh.clone()))
                .await;
            state.set_ssh_manager(ssh).await;
            Ok::<(), String>(())
        })
        .await?;
    Ok(state)
}
