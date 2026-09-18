//! Unified path management module
//!
//! Provides unified management for all app storage paths, supporting user, project, and temporary levels

use crate::util::errors::*;
use log::{debug, error};
use openbitfun_services_core::product_identity::{data_namespace, hidden_data_directory};
use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};
use std::collections::HashMap;
use std::env;
use std::path::{Path, PathBuf};
use std::sync::{Arc, Mutex};

/// Storage level
#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash, Serialize, Deserialize)]
pub enum StorageLevel {
    /// User: global configuration and data
    User,
    /// Project: configuration for a specific project
    Project,
    /// Session: temporary data for the current session
    Session,
    /// Temporary: cache that can be cleaned
    Temporary,
}

/// Path manager
///
/// Manages all app storage paths consistently across platforms
#[derive(Debug, Clone)]
pub struct PathManager {
    /// User config root directory
    user_root: PathBuf,
    /// Optional override for the product home directory, used by tests to avoid
    /// touching the real user home.
    product_home_override: Option<PathBuf>,
    /// Cache of runtime slugs keyed by the original and canonical workspace paths.
    project_runtime_slug_cache: Arc<Mutex<HashMap<PathBuf, String>>>,
}

impl PathManager {
    /// Create a new path manager
    pub fn new() -> OpenBitFunResult<Self> {
        Self::validate_e2e_storage_guard()?;
        let user_root = Self::get_user_config_root()?;
        let product_home_override = Self::get_product_home_override();

        Ok(Self {
            user_root,
            product_home_override,
            project_runtime_slug_cache: Arc::new(Mutex::new(HashMap::new())),
        })
    }

    fn env_path(name: &str) -> Option<PathBuf> {
        env::var_os(name)
            .map(PathBuf::from)
            .filter(|path| !path.as_os_str().is_empty())
    }

    fn env_flag_enabled(name: &str) -> bool {
        matches!(
            env::var(name).ok().as_deref(),
            Some("1") | Some("true") | Some("TRUE")
        )
    }

    fn validate_e2e_storage_guard() -> OpenBitFunResult<()> {
        if !Self::env_flag_enabled("OPENBITFUN_E2E_STORAGE_GUARD") {
            return Ok(());
        }

        let has_user_root = Self::env_path("OPENBITFUN_USER_ROOT").is_some()
            || Self::env_path("OPENBITFUN_E2E_USER_ROOT").is_some();
        let has_home_root = Self::env_path("OPENBITFUN_HOME").is_some()
            || Self::env_path("OPENBITFUN_E2E_HOME").is_some();

        if has_user_root && has_home_root {
            return Ok(());
        }

        Err(OpenBitFunError::config(
            "OPENBITFUN_E2E_STORAGE_GUARD requires isolated OPENBITFUN_E2E_USER_ROOT and OPENBITFUN_E2E_HOME storage roots",
        ))
    }

    /// Get user config root directory
    ///
    /// - Windows: %APPDATA%\openbitfun\
    /// - macOS: ~/Library/Application Support/openbitfun/
    /// - Linux: ~/.config/openbitfun/
    fn get_user_config_root() -> OpenBitFunResult<PathBuf> {
        if let Some(path) = Self::env_path("OPENBITFUN_USER_ROOT")
            .or_else(|| Self::env_path("OPENBITFUN_E2E_USER_ROOT"))
        {
            return Ok(path);
        }

        let config_dir = dirs::config_dir()
            .ok_or_else(|| OpenBitFunError::config("Failed to get config directory".to_string()))?;

        Ok(config_dir.join(data_namespace()))
    }

    fn get_product_home_override() -> Option<PathBuf> {
        Self::env_path("OPENBITFUN_HOME").or_else(|| Self::env_path("OPENBITFUN_E2E_HOME"))
    }

    /// Get assistant home root directory: ~/.openbitfun/
    pub fn product_home_dir(&self) -> PathBuf {
        if let Some(path) = &self.product_home_override {
            return path.clone();
        }
        dirs::home_dir()
            .unwrap_or_else(|| self.user_root.clone())
            .join(hidden_data_directory())
    }

    /// Get assistant workspace base directory: ~/.openbitfun/personal_assistant/
    ///
    /// `override_root` is reserved for future user customization.
    pub fn assistant_workspace_base_dir(&self, override_root: Option<&Path>) -> PathBuf {
        override_root
            .map(Path::to_path_buf)
            .unwrap_or_else(|| self.product_home_dir())
            .join("personal_assistant")
    }

    /// Get the default assistant workspace directory: ~/.openbitfun/personal_assistant/workspace
    pub fn default_assistant_workspace_dir(&self, override_root: Option<&Path>) -> PathBuf {
        self.assistant_workspace_base_dir(override_root)
            .join("workspace")
    }

    /// Get a named assistant workspace directory: ~/.openbitfun/personal_assistant/workspace-<id>
    pub fn assistant_workspace_dir(
        &self,
        assistant_id: &str,
        override_root: Option<&Path>,
    ) -> PathBuf {
        self.assistant_workspace_base_dir(override_root)
            .join(format!("workspace-{}", assistant_id))
    }

    /// Resolve assistant workspace directory for default or named assistant.
    pub fn resolve_assistant_workspace_dir(
        &self,
        assistant_id: Option<&str>,
        override_root: Option<&Path>,
    ) -> PathBuf {
        match assistant_id {
            Some(id) if !id.trim().is_empty() => self.assistant_workspace_dir(id, override_root),
            _ => self.default_assistant_workspace_dir(override_root),
        }
    }

    /// True if `path` is this machine's OpenBitFun **assistant** workspace directory.
    ///
    /// Used so remote-workspace registry (especially roots like `/`) does not
    /// mis-classify client paths such as `/Users/.../.openbitfun/personal_assistant/workspace-*`
    /// as SSH remote paths.
    pub fn is_local_assistant_workspace_path(&self, path: &str) -> bool {
        let p = Path::new(path);
        if !p.is_absolute() {
            return false;
        }
        p.starts_with(self.assistant_workspace_base_dir(None))
    }

    /// Get the root directory for user-scoped OpenBitFun storage.
    pub fn user_root_dir(&self) -> &Path {
        &self.user_root
    }

    /// Get user config directory: ~/.config/openbitfun/config/
    pub fn user_config_dir(&self) -> PathBuf {
        self.user_root.join("config")
    }

    /// Get app config file path: ~/.config/openbitfun/config/app.json
    pub fn app_config_file(&self) -> PathBuf {
        self.user_config_dir().join("app.json")
    }

    /// Get user agent hooks file: ~/.config/openbitfun/config/hooks.json
    pub fn user_hooks_file(&self) -> PathBuf {
        self.user_config_dir().join("hooks.json")
    }

    /// Get user agent directory: ~/.config/openbitfun/agents/
    pub fn user_agents_dir(&self) -> PathBuf {
        self.user_root.join("agents")
    }

    /// Get user skills directory:
    /// - Windows: C:\Users\xxx\AppData\Roaming\openbitfun\skills\
    /// - macOS: ~/Library/Application Support/openbitfun/skills/
    /// - Linux: ~/.local/share/openbitfun/skills/
    pub fn user_skills_dir(&self) -> PathBuf {
        if cfg!(target_os = "windows") {
            dirs::data_dir()
                .unwrap_or_else(|| PathBuf::from("C:\\ProgramData"))
                .join(data_namespace())
                .join("skills")
        } else if cfg!(target_os = "macos") {
            dirs::home_dir()
                .unwrap_or_else(|| PathBuf::from("/tmp"))
                .join("Library")
                .join("Application Support")
                .join(data_namespace())
                .join("skills")
        } else {
            dirs::data_local_dir()
                .unwrap_or_else(|| PathBuf::from("/tmp"))
                .join(data_namespace())
                .join("skills")
        }
    }

    /// Get OpenBitFun-managed built-in skills directory under the user skills root.
    pub fn builtin_skills_dir(&self) -> PathBuf {
        self.user_skills_dir().join(".system")
    }

    /// Get cache root directory: ~/.config/openbitfun/cache/
    pub fn cache_root(&self) -> PathBuf {
        self.user_root.join("cache")
    }

    /// Get managed runtimes root directory: ~/.config/openbitfun/runtimes/
    ///
    /// OpenBitFun-managed runtime components (e.g. node/python/office) are stored here.
    pub fn managed_runtimes_dir(&self) -> PathBuf {
        self.user_root.join("runtimes")
    }

    /// Get user data directory: ~/.config/openbitfun/data/
    pub fn user_data_dir(&self) -> PathBuf {
        self.user_root.join("data")
    }

    /// User-level managed model resources shared across workspaces.
    pub fn user_models_dir(&self) -> PathBuf {
        self.user_data_dir().join("models")
    }

    /// User-level speech recognition model resources shared across workspaces.
    pub fn speech_models_dir(&self) -> PathBuf {
        self.user_models_dir().join("speech")
    }

    /// Versioned speech model resource directory.
    pub fn speech_model_dir(&self, model_id: &str, version: &str) -> PathBuf {
        self.speech_models_dir().join(model_id).join(version)
    }

    /// Temporary download workspace for managed speech model resources.
    pub fn speech_model_downloads_dir(&self) -> PathBuf {
        self.cache_root().join("model-downloads").join("speech")
    }

    /// Temporary audio chunks for local voice input sessions.
    pub fn speech_input_temp_dir(&self) -> PathBuf {
        self.temp_dir().join("speech-input")
    }

    /// Get user memory database file: ~/.config/openbitfun/data/memories/memories.sqlite
    pub fn memories_database_file(&self) -> PathBuf {
        self.user_data_dir()
            .join("memories")
            .join("memories.sqlite")
    }

    /// Get the durable agent coordination database file.
    pub fn agent_coordination_database_file(&self) -> PathBuf {
        self.user_data_dir()
            .join("agent-runtime")
            .join("coordination.sqlite")
    }

    /// Process-level ownership locks for local Agent Runtime deployments.
    pub fn agent_runtime_ownership_dir(&self) -> PathBuf {
        self.user_data_dir().join("agent-runtime").join("ownership")
    }

    /// Get user memory workspace root directory: ~/.openbitfun/memories/
    pub fn memories_root_dir(&self) -> PathBuf {
        self.product_home_dir().join("memories")
    }

    /// Root for per-host, per-remote-path workspace mirrors: `~/.openbitfun/remote_ssh/`.
    ///
    /// Session/chat persistence for SSH workspaces lives under
    /// `{this}/{sanitized_host}/{remote_path_segments}/sessions/`.
    pub fn remote_ssh_mirror_root_dir(&self) -> PathBuf {
        self.product_home_dir().join("remote_ssh")
    }

    /// Root for per-host, per-remote-path workspace mirrors using the default
    /// process path manager.
    pub fn remote_ssh_mirror_root() -> PathBuf {
        Self::new()
            .map(|pm| pm.remote_ssh_mirror_root_dir())
            .unwrap_or_else(|_| {
                dirs::home_dir()
                    .unwrap_or_else(|| PathBuf::from("."))
                    .join(hidden_data_directory())
                    .join("remote_ssh")
            })
    }

    /// Get scheduled jobs directory: ~/.config/openbitfun/data/cron/
    pub fn user_cron_dir(&self) -> PathBuf {
        self.user_data_dir().join("cron")
    }

    /// Get scheduled jobs persistence file: ~/.config/openbitfun/data/cron/jobs.json
    pub fn cron_jobs_file(&self) -> PathBuf {
        self.user_cron_dir().join("jobs.json")
    }

    /// Get miniapps root directory: ~/.config/openbitfun/data/miniapps/
    pub fn miniapps_dir(&self) -> PathBuf {
        self.user_data_dir().join("miniapps")
    }

    /// Get directory for a specific miniapp: ~/.config/openbitfun/data/miniapps/{app_id}/
    pub fn miniapp_dir(&self, app_id: &str) -> PathBuf {
        self.miniapps_dir().join(app_id)
    }

    /// Get user-level rules directory: ~/.config/openbitfun/data/rules/
    pub fn user_rules_dir(&self) -> PathBuf {
        self.user_data_dir().join("rules")
    }

    /// Get user-installed product plugin packages directory.
    pub fn user_plugins_dir(&self) -> PathBuf {
        self.user_data_dir().join("plugins")
    }

    /// Get logs directory: ~/.config/openbitfun/logs/
    pub fn logs_dir(&self) -> PathBuf {
        self.user_root.join("logs")
    }

    /// Get temp directory: ~/.config/openbitfun/temp/
    pub fn temp_dir(&self) -> PathBuf {
        self.user_root.join("temp")
    }

    /// Get project config root directory: {project}/.openbitfun/
    pub fn project_root(&self, workspace_path: &Path) -> PathBuf {
        workspace_path.join(hidden_data_directory())
    }

    /// Get the shared runtime projects root directory: ~/.openbitfun/projects/
    pub fn projects_root(&self) -> PathBuf {
        self.product_home_dir().join("projects")
    }

    /// Default root for opt-in managed Git worktrees.
    pub fn worktrees_root(&self) -> PathBuf {
        self.product_home_dir().join("worktrees")
    }

    /// Get the runtime root for a workspace: ~/.openbitfun/projects/<workspace-slug>/
    pub fn project_runtime_root(&self, workspace_path: &Path) -> PathBuf {
        self.projects_root()
            .join(self.project_runtime_slug(workspace_path))
    }

    /// Get project internal config directory: {project}/.openbitfun/config/
    pub fn project_internal_config_dir(&self, workspace_path: &Path) -> PathBuf {
        self.project_root(workspace_path).join("config")
    }

    /// Get project agent profiles file: {project}/.openbitfun/config/agent_profiles.json
    pub fn project_agent_profiles_file(&self, workspace_path: &Path) -> PathBuf {
        self.project_internal_config_dir(workspace_path)
            .join("agent_profiles.json")
    }

    /// Get project tool permission rules file: {project}/.openbitfun/config/tool_permissions.json
    pub fn project_permission_file(&self, workspace_path: &Path) -> PathBuf {
        self.project_internal_config_dir(workspace_path)
            .join("tool_permissions.json")
    }

    /// Get project mode skills file: {project}/.openbitfun/config/mode_skills.json
    pub fn project_mode_skills_file(&self, workspace_path: &Path) -> PathBuf {
        self.project_internal_config_dir(workspace_path)
            .join("mode_skills.json")
    }

    /// Get project subagent overrides file: {project}/.openbitfun/config/agent_subagents.json
    pub fn project_agent_subagents_file(&self, workspace_path: &Path) -> PathBuf {
        self.project_internal_config_dir(workspace_path)
            .join("agent_subagents.json")
    }

    /// Get project agent hooks file: {project}/.openbitfun/config/hooks.json
    pub fn project_hooks_file(&self, workspace_path: &Path) -> PathBuf {
        self.project_internal_config_dir(workspace_path)
            .join("hooks.json")
    }

    /// Get project agent directory: {project}/.openbitfun/agents/
    pub fn project_agents_dir(&self, workspace_path: &Path) -> PathBuf {
        self.project_root(workspace_path).join("agents")
    }

    /// Get project-level rules directory: {project}/.openbitfun/rules/
    pub fn project_rules_dir(&self, workspace_path: &Path) -> PathBuf {
        self.project_root(workspace_path).join("rules")
    }

    /// Get project-owned product plugin packages directory.
    pub fn project_plugins_dir(&self, workspace_path: &Path) -> PathBuf {
        self.project_root(workspace_path).join("plugins")
    }

    /// Get project snapshots directory: ~/.openbitfun/projects/<workspace-slug>/snapshots/
    pub fn project_snapshots_dir(&self, workspace_path: &Path) -> PathBuf {
        self.project_runtime_root(workspace_path).join("snapshots")
    }

    /// Get project sessions directory: ~/.openbitfun/projects/<workspace-slug>/sessions/
    pub fn project_sessions_dir(&self, workspace_path: &Path) -> PathBuf {
        self.project_runtime_root(workspace_path).join("sessions")
    }

    /// Get project plans directory: ~/.openbitfun/projects/<workspace-slug>/plans/
    pub fn project_plans_dir(&self, workspace_path: &Path) -> PathBuf {
        self.project_runtime_root(workspace_path).join("plans")
    }

    /// Get the user-owned trust store for a workspace's product plugins.
    pub fn project_plugin_trust_file(&self, workspace_path: &Path) -> PathBuf {
        let canonical =
            dunce::canonicalize(workspace_path).unwrap_or_else(|_| workspace_path.to_path_buf());
        self.project_runtime_root(workspace_path)
            .join("plugin-runtime")
            .join(Self::native_path_digest(&canonical))
            .join("trust.json")
    }

    fn project_runtime_slug(&self, workspace_path: &Path) -> String {
        let requested_path = workspace_path.to_path_buf();
        if let Some(slug) = self.cached_project_runtime_slug(&requested_path) {
            return slug;
        }

        let canonical_path =
            dunce::canonicalize(workspace_path).unwrap_or_else(|_| requested_path.clone());
        if canonical_path != requested_path {
            if let Some(slug) = self.cached_project_runtime_slug(&canonical_path) {
                self.store_project_runtime_slug(&requested_path, &slug);
                return slug;
            }
        }

        let canonical = canonical_path.to_string_lossy().to_string();
        let slug = Self::build_project_runtime_slug(&canonical);

        self.store_project_runtime_slug(&canonical_path, &slug);
        if canonical_path != requested_path {
            self.store_project_runtime_slug(&requested_path, &slug);
        }

        slug
    }

    fn cached_project_runtime_slug(&self, workspace_path: &Path) -> Option<String> {
        self.project_runtime_slug_cache
            .lock()
            .expect("project runtime slug cache poisoned")
            .get(workspace_path)
            .cloned()
    }

    fn store_project_runtime_slug(&self, workspace_path: &Path, slug: &str) {
        self.project_runtime_slug_cache
            .lock()
            .expect("project runtime slug cache poisoned")
            .insert(workspace_path.to_path_buf(), slug.to_string());
    }

    pub(crate) fn build_project_runtime_slug(canonical: &str) -> String {
        openbitfun_services_core::workspace_identity::build_project_runtime_slug(canonical)
    }

    #[cfg(unix)]
    pub(crate) fn native_path_digest(path: &Path) -> String {
        use std::os::unix::ffi::OsStrExt;

        hex::encode(Sha256::digest(path.as_os_str().as_bytes()))
    }

    #[cfg(windows)]
    pub(crate) fn native_path_digest(path: &Path) -> String {
        use std::os::windows::ffi::OsStrExt;

        let mut hasher = Sha256::new();
        for unit in path.as_os_str().encode_wide() {
            hasher.update(unit.to_le_bytes());
        }
        hex::encode(hasher.finalize())
    }

    #[cfg(not(any(unix, windows)))]
    pub(crate) fn native_path_digest(path: &Path) -> String {
        hex::encode(Sha256::digest(path.to_string_lossy().as_bytes()))
    }

    /// Ensure directory exists
    pub async fn ensure_dir(&self, path: &Path) -> OpenBitFunResult<()> {
        if !path.exists() {
            tokio::fs::create_dir_all(path).await.map_err(|e| {
                OpenBitFunError::service(format!("Failed to create directory {:?}: {}", path, e))
            })?;
        }
        Ok(())
    }

    /// Initialize user-level directory structure
    pub async fn initialize_user_directories(&self) -> OpenBitFunResult<()> {
        let dirs = vec![
            self.product_home_dir(),
            self.projects_root(),
            self.assistant_workspace_base_dir(None),
            self.user_config_dir(),
            self.user_agents_dir(),
            self.cache_root(),
            self.user_data_dir(),
            self.user_models_dir(),
            self.speech_models_dir(),
            self.speech_model_downloads_dir(),
            self.user_cron_dir(),
            self.user_rules_dir(),
            self.miniapps_dir(),
            self.logs_dir(),
            self.temp_dir(),
            self.speech_input_temp_dir(),
        ];

        for dir in dirs {
            self.ensure_dir(&dir).await?;
        }

        debug!("User-level directories initialized");
        Ok(())
    }
}

impl Default for PathManager {
    fn default() -> Self {
        match Self::new() {
            Ok(manager) => manager,
            Err(e) => {
                error!(
                    "Failed to create PathManager from system config directory, using temp fallback: {}",
                    e
                );
                Self {
                    user_root: std::env::temp_dir().join("openbitfun"),
                    product_home_override: Self::get_product_home_override(),
                    project_runtime_slug_cache: Arc::new(Mutex::new(HashMap::new())),
                }
            }
        }
    }
}

#[cfg(any(test, feature = "test-support"))]
impl PathManager {
    pub(crate) fn with_user_root_for_tests(user_root: PathBuf) -> Self {
        let base = user_root
            .parent()
            .map(Path::to_path_buf)
            .unwrap_or_else(|| user_root.clone());
        Self {
            user_root,
            product_home_override: Some(base.join("home").join(".openbitfun")),
            project_runtime_slug_cache: Arc::new(Mutex::new(HashMap::new())),
        }
    }
}

use std::sync::OnceLock;

/// Global PathManager instance
static GLOBAL_PATH_MANAGER: OnceLock<GlobalPathManagerState> = OnceLock::new();

struct GlobalPathManagerState {
    manager: Arc<PathManager>,
    initialization_error: Option<String>,
}

impl GlobalPathManagerState {
    fn ready(manager: Arc<PathManager>) -> Self {
        Self {
            manager,
            initialization_error: None,
        }
    }

    fn fallback(manager: Arc<PathManager>, error: impl Into<String>) -> Self {
        Self {
            manager,
            initialization_error: Some(error.into()),
        }
    }

    fn strict_manager(&self) -> OpenBitFunResult<Arc<PathManager>> {
        if let Some(error) = &self.initialization_error {
            return Err(OpenBitFunError::config(format!(
                "global path manager is using a temporary fallback after initialization failed: {error}"
            )));
        }
        Ok(Arc::clone(&self.manager))
    }
}

fn init_global_path_manager() -> OpenBitFunResult<Arc<PathManager>> {
    PathManager::new().map(Arc::new)
}

/// Get the global PathManager instance (Arc)
///
/// Return a shared Arc to the global PathManager instance
pub fn get_path_manager_arc() -> Arc<PathManager> {
    GLOBAL_PATH_MANAGER
        .get_or_init(|| match init_global_path_manager() {
            Ok(manager) => GlobalPathManagerState::ready(manager),
            Err(e) => {
                error!(
                    "Failed to create global PathManager from config directory, using fallback: {}",
                    e
                );
                GlobalPathManagerState::fallback(Arc::new(PathManager::default()), e.to_string())
            }
        })
        .manager
        .clone()
}

/// Try to get the global PathManager instance (Arc)
pub fn try_get_path_manager_arc() -> OpenBitFunResult<Arc<PathManager>> {
    if let Some(manager) = GLOBAL_PATH_MANAGER.get() {
        return manager.strict_manager();
    }

    let manager = init_global_path_manager()?;
    match GLOBAL_PATH_MANAGER.set(GlobalPathManagerState::ready(Arc::clone(&manager))) {
        Ok(()) => Ok(manager),
        Err(_) => GLOBAL_PATH_MANAGER
            .get()
            .expect("GLOBAL_PATH_MANAGER should be initialized after set failure")
            .strict_manager(),
    }
}

#[cfg(test)]
mod tests {
    use super::{GlobalPathManagerState, PathManager};
    use std::ffi::OsString;
    use std::path::Path;
    use std::sync::{Arc, Mutex};

    static ENV_LOCK: Mutex<()> = Mutex::new(());

    #[test]
    fn runtime_ownership_lives_under_the_agent_runtime_data_root() {
        let user_root = std::env::temp_dir().join("openbitfun-runtime-ownership-path-test");
        let path_manager = PathManager::with_user_root_for_tests(user_root);

        assert_eq!(
            path_manager.agent_runtime_ownership_dir(),
            path_manager
                .user_data_dir()
                .join("agent-runtime")
                .join("ownership")
        );
    }

    #[test]
    fn strict_path_access_rejects_a_cached_temporary_fallback() {
        let state = GlobalPathManagerState::fallback(
            Arc::new(PathManager::with_user_root_for_tests(
                std::env::temp_dir().join("openbitfun-fallback-test"),
            )),
            "injected initialization failure",
        );

        let error = state
            .strict_manager()
            .expect_err("strict access must reject fallback state");

        assert!(error.to_string().contains("temporary fallback"));
        assert!(error
            .to_string()
            .contains("injected initialization failure"));
    }

    #[test]
    fn assistant_workspace_paths_use_personal_assistant_subdir() {
        let path_manager = PathManager::default();
        let base_dir = path_manager.assistant_workspace_base_dir(None);

        assert_eq!(
            base_dir,
            path_manager.product_home_dir().join("personal_assistant")
        );
        assert_eq!(
            path_manager.default_assistant_workspace_dir(None),
            base_dir.join("workspace")
        );
        assert_eq!(
            path_manager.assistant_workspace_dir("demo", None),
            base_dir.join("workspace-demo")
        );
        assert_eq!(
            path_manager.resolve_assistant_workspace_dir(None, None),
            base_dir.join("workspace")
        );
        assert_eq!(
            path_manager.resolve_assistant_workspace_dir(Some("demo"), None),
            base_dir.join("workspace-demo")
        );
    }

    #[test]
    fn plugin_package_and_trust_paths_separate_package_scope_from_user_trust() {
        let pm = PathManager::default();
        let workspace = Path::new("workspace");

        assert_eq!(pm.user_plugins_dir(), pm.user_data_dir().join("plugins"));
        assert_eq!(
            pm.project_plugins_dir(workspace),
            workspace.join(".openbitfun").join("plugins")
        );
        assert_eq!(
            pm.project_plugin_trust_file(workspace),
            pm.project_runtime_root(workspace)
                .join("plugin-runtime")
                .join(PathManager::native_path_digest(workspace))
                .join("trust.json")
        );
    }

    #[test]
    fn is_local_assistant_workspace_path_detects_only_current_assistant_root() {
        let pm = PathManager::default();
        let base = pm.assistant_workspace_base_dir(None);
        let named = pm.assistant_workspace_dir("abc", None);
        assert!(pm.is_local_assistant_workspace_path(&named.to_string_lossy()));
        assert!(pm.is_local_assistant_workspace_path(&base.join("workspace").to_string_lossy()));
        assert!(!pm.is_local_assistant_workspace_path(
            &pm.product_home_dir()
                .join("workspace-xyz")
                .to_string_lossy()
        ));
        assert!(!pm.is_local_assistant_workspace_path("/tmp/not-openbitfun"));
    }

    #[test]
    fn project_runtime_root_uses_human_readable_workspace_slug() {
        let pm = PathManager::default();
        let runtime_root = pm.project_runtime_root(Path::new(r"E:\Projects\OpenBitFun\Source"));
        let slug = runtime_root
            .file_name()
            .and_then(|value| value.to_str())
            .expect("runtime root should have terminal component");

        assert!(slug.starts_with("e--projects-openbitfun-source"));
        assert_eq!(runtime_root.parent(), Some(pm.projects_root().as_path()));
    }

    #[cfg(windows)]
    #[test]
    fn plugin_trust_path_distinguishes_lossy_utf16_paths() {
        use std::os::windows::ffi::OsStringExt;

        let pm = PathManager::default();
        let first = std::path::PathBuf::from(OsString::from_wide(&[
            b'C' as u16,
            b':' as u16,
            b'\\' as u16,
            0xd800,
        ]));
        let second = std::path::PathBuf::from(OsString::from_wide(&[
            b'C' as u16,
            b':' as u16,
            b'\\' as u16,
            0xd801,
        ]));

        assert_eq!(first.to_string_lossy(), second.to_string_lossy());
        assert_ne!(
            pm.project_plugin_trust_file(&first),
            pm.project_plugin_trust_file(&second)
        );
    }

    #[test]
    fn plugin_trust_path_distinguishes_workspace_slug_collisions() {
        let pm = PathManager::default();
        let first = Path::new("workspace-a");
        let second = Path::new("workspace_a");

        assert_eq!(
            pm.project_runtime_root(first),
            pm.project_runtime_root(second)
        );
        assert_ne!(
            pm.project_plugin_trust_file(first),
            pm.project_plugin_trust_file(second)
        );
    }

    #[test]
    fn env_overrides_keep_e2e_storage_out_of_real_user_profile() {
        let _guard = ENV_LOCK.lock().expect("env lock poisoned");
        let _env_guard = EnvVarGuard::capture([
            "OPENBITFUN_USER_ROOT",
            "OPENBITFUN_E2E_USER_ROOT",
            "OPENBITFUN_HOME",
            "OPENBITFUN_E2E_HOME",
            "OPENBITFUN_E2E_STORAGE_GUARD",
        ]);
        let temp_root = std::env::temp_dir().join("openbitfun-e2e-path-manager-test");
        let user_root = temp_root.join("user-root");
        let home_root = temp_root.join("home");

        std::env::remove_var("OPENBITFUN_USER_ROOT");
        std::env::set_var("OPENBITFUN_E2E_USER_ROOT", &user_root);
        std::env::remove_var("OPENBITFUN_HOME");
        std::env::set_var("OPENBITFUN_E2E_HOME", &home_root);

        let pm = PathManager::new().expect("path manager should use env overrides");
        assert_eq!(pm.user_config_dir(), user_root.join("config"));
        assert_eq!(pm.user_data_dir(), user_root.join("data"));
        assert_eq!(pm.logs_dir(), user_root.join("logs"));
        assert_eq!(pm.product_home_dir(), home_root);
    }

    #[test]
    fn e2e_storage_guard_rejects_missing_isolated_roots() {
        let _guard = ENV_LOCK.lock().expect("env lock poisoned");
        let _env_guard = EnvVarGuard::capture([
            "OPENBITFUN_USER_ROOT",
            "OPENBITFUN_E2E_USER_ROOT",
            "OPENBITFUN_HOME",
            "OPENBITFUN_E2E_HOME",
            "OPENBITFUN_E2E_STORAGE_GUARD",
        ]);

        std::env::remove_var("OPENBITFUN_USER_ROOT");
        std::env::remove_var("OPENBITFUN_E2E_USER_ROOT");
        std::env::remove_var("OPENBITFUN_HOME");
        std::env::remove_var("OPENBITFUN_E2E_HOME");
        std::env::set_var("OPENBITFUN_E2E_STORAGE_GUARD", "1");

        let error = PathManager::new().expect_err("guard should reject real-profile storage");
        let message = error.to_string();
        assert!(message.contains("OPENBITFUN_E2E_STORAGE_GUARD"));
        assert!(message.contains("OPENBITFUN_E2E_USER_ROOT"));
    }

    struct EnvVarGuard {
        values: Vec<(&'static str, Option<OsString>)>,
    }

    impl EnvVarGuard {
        fn capture(names: impl IntoIterator<Item = &'static str>) -> Self {
            Self {
                values: names
                    .into_iter()
                    .map(|name| (name, std::env::var_os(name)))
                    .collect(),
            }
        }
    }

    impl Drop for EnvVarGuard {
        fn drop(&mut self) {
            for (name, value) in self.values.drain(..) {
                restore_env(name, value);
            }
        }
    }

    fn restore_env(name: &str, value: Option<OsString>) {
        if let Some(value) = value {
            std::env::set_var(name, value);
        } else {
            std::env::remove_var(name);
        }
    }
}
