use openbitfun_agent_runtime::native_hooks::RuntimeHookCommitToken;
use openbitfun_opencode_plugin_host::{
    BackendDiagnostic, BackendDiagnosticError, BackendDiagnosticEvent, BackendDiagnosticSeverity,
    PluginDeclaration, PluginHost, PluginHostConfig, PluginHostShutdownPolicy,
    PluginHostShutdownReport, PluginPrepareRequest, GENERATION_FENCING_V1,
};
use openbitfun_runtime_ports::{
    HookFunctionDisposeRequest, HookFunctionGeneration, HookFunctionPluginDeclaration,
    HookFunctionRegistrationBatch, HookFunctionRegistrationSink, HookFunctionRuntime,
    HookFunctionStartRequest, PortError, PortErrorKind, PortResult,
};
use serde_json::Value;
use sha2::{Digest, Sha256};
use std::collections::HashMap;
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicBool, AtomicU64, Ordering};
use std::sync::Arc;
// Product-assembly bridge for the managed OpenCode Plugin Host.
//
// `PluginHost` itself remains the adapter-owned process/IPC resource. Core
// keeps only the product-level lifecycle assembly and logical instance/PTy
// ownership needed to bind adapter callbacks to OpenBitFun owners; these maps do
// not supervise a physical process tree or make trust/configuration policy.

use terminal_core::{CloseSessionRequest, TerminalApi};
use tokio::sync::{Mutex, Notify, OnceCell};

#[derive(Default)]
struct CapturedPluginGeneration {
    batch: std::sync::Mutex<Option<HookFunctionRegistrationBatch>>,
}

#[async_trait::async_trait]
impl HookFunctionRegistrationSink for CapturedPluginGeneration {
    async fn publish_generation(&self, batch: HookFunctionRegistrationBatch) -> PortResult<()> {
        let mut slot = self.batch.lock().expect("plugin generation lock poisoned");
        if slot.is_some() {
            return Err(PortError::new(
                PortErrorKind::Backend,
                "plugin runtime published more than one registration batch for a generation",
            ));
        }
        *slot = Some(batch);
        Ok(())
    }
}

impl CapturedPluginGeneration {
    fn take(&self) -> crate::OpenBitFunResult<HookFunctionRegistrationBatch> {
        self.batch
            .lock()
            .expect("plugin generation lock poisoned")
            .take()
            .ok_or_else(|| {
                crate::OpenBitFunError::ProcessError(
                    "Plugin runtime started without publishing its registration batch".to_string(),
                )
            })
    }
}

const BUN_HOST_ENTRY_ENV: &str = "OPENBITFUN_OPENCODE_BUN_HOST_ENTRY";
const BUN_COMMAND_ENV: &str = "OPENBITFUN_BUN_COMMAND";
const OPENCODE_PLUGIN_ECOSYSTEM: &str = "opencode";
const OPENCODE_PLUGIN_RUNTIME_NAMESPACE: &str = "opencode-plugin";
const OPENCODE_PLUGIN_ROUTE_OWNER: &str = "opencode-plugin-config";

fn opencode_plugin_publication_identity(
) -> crate::plugin_capability_publication::PluginPublicationIdentity {
    crate::plugin_capability_publication::PluginPublicationIdentity::new(
        OPENCODE_PLUGIN_ECOSYSTEM,
        OPENCODE_PLUGIN_RUNTIME_NAMESPACE,
        OPENCODE_PLUGIN_ROUTE_OWNER,
    )
}

pub(crate) fn is_opencode_plugin_agent_runtime_key(runtime_agent_key: &str) -> bool {
    crate::plugin_capability_publication::is_agent_runtime_key_for_namespace(
        runtime_agent_key,
        OPENCODE_PLUGIN_RUNTIME_NAMESPACE,
    )
}

static PLUGIN_HOST: OnceCell<Mutex<Option<PluginHost>>> = OnceCell::const_new();
static PLUGIN_HOST_LIFECYCLE_LOCK: OnceCell<Mutex<()>> = OnceCell::const_new();
static PLUGIN_HOST_SHUTDOWN_REPORT: OnceCell<Mutex<Option<PluginHostShutdownReport>>> =
    OnceCell::const_new();
static PLUGIN_HOST_SHUTDOWN_NOTIFY: OnceCell<Notify> = OnceCell::const_new();
static PLUGIN_HOST_ACTIVE_ENSURE_NOTIFY: OnceCell<Notify> = OnceCell::const_new();
static PLUGIN_HOST_SHUTDOWN_STARTED: AtomicBool = AtomicBool::new(false);
static PLUGIN_HOST_SHUTDOWN_COMPLETE: AtomicBool = AtomicBool::new(false);
static PLUGIN_HOST_ACTIVE_ENSURES: AtomicU64 = AtomicU64::new(0);
static PLUGIN_HOST_INSTANCES: OnceCell<Mutex<HashMap<String, PluginHostInstance>>> =
    OnceCell::const_new();
static PLUGIN_HOST_ENSURE_LOCKS: OnceCell<Mutex<HashMap<String, Arc<Mutex<()>>>>> =
    OnceCell::const_new();
static PLUGIN_HOST_PTY_OWNERS: OnceCell<Mutex<HashMap<String, String>>> = OnceCell::const_new();
static PLUGIN_ACTIVATION_FAILURES: std::sync::OnceLock<std::sync::RwLock<HashMap<String, String>>> =
    std::sync::OnceLock::new();
static NEXT_INSTANCE_SEQUENCE: AtomicU64 = AtomicU64::new(1);
const MAX_PLUGIN_HOST_DIAGNOSTICS: usize = 100;

struct PluginHostEnsureLease;

impl Drop for PluginHostEnsureLease {
    fn drop(&mut self) {
        if PLUGIN_HOST_ACTIVE_ENSURES.fetch_sub(1, Ordering::AcqRel) == 1 {
            if let Some(notify) = PLUGIN_HOST_ACTIVE_ENSURE_NOTIFY.get() {
                notify.notify_waiters();
            }
        }
    }
}

async fn acquire_plugin_host_ensure_lease() -> crate::OpenBitFunResult<PluginHostEnsureLease> {
    let lifecycle_lock = PLUGIN_HOST_LIFECYCLE_LOCK
        .get_or_init(|| async { Mutex::new(()) })
        .await;
    let _guard = lifecycle_lock.lock().await;
    if PLUGIN_HOST_SHUTDOWN_STARTED.load(Ordering::Acquire) {
        return Err(crate::OpenBitFunError::ProcessError(
            "Plugin host is shutting down".to_string(),
        ));
    }
    PLUGIN_HOST_ACTIVE_ENSURES.fetch_add(1, Ordering::AcqRel);
    Ok(PluginHostEnsureLease)
}

async fn wait_for_plugin_host_ensure_leases() {
    let notify = PLUGIN_HOST_ACTIVE_ENSURE_NOTIFY
        .get_or_init(|| async { Notify::new() })
        .await;
    loop {
        let notified = notify.notified();
        if PLUGIN_HOST_ACTIVE_ENSURES.load(Ordering::Acquire) == 0 {
            return;
        }
        notified.await;
    }
}

async fn plugin_host_workspace_lock(scope: &str) -> Arc<Mutex<()>> {
    let locks = PLUGIN_HOST_ENSURE_LOCKS
        .get_or_init(|| async { Mutex::new(HashMap::new()) })
        .await;
    let mut locks = locks.lock().await;
    locks
        .entry(scope.to_string())
        .or_insert_with(|| Arc::new(Mutex::new(())))
        .clone()
}

#[derive(Debug, Clone)]
pub(crate) struct PluginHostInstance {
    pub(crate) workspace_id: String,
    pub(crate) canonical_directory: String,
    pub(crate) directory: PathBuf,
    pub(crate) worktree: PathBuf,
    pub(crate) project_id: String,
    pub(crate) created_at_ms: i64,
    pub(crate) instance_id: String,
    pub(crate) host_generation: u64,
    pub(crate) generation_key: String,
    pub(crate) revision: String,
    pub(crate) registration_batch: Option<HookFunctionRegistrationBatch>,
    pub(crate) ready: bool,
    pub(crate) hook_commit_token: Option<RuntimeHookCommitToken>,
    pub(crate) transformed_config_health_snapshot: Option<Value>,
    pub(crate) diagnostic_health_snapshot: Vec<Value>,
    pub(crate) tool_names: Vec<String>,
    pub(crate) agent_runtime_keys: Vec<String>,
    pub(crate) retirement_scheduled: bool,
}

impl PluginHostInstance {
    pub(crate) fn is_ready(&self) -> bool {
        self.ready
    }

    fn generation(&self) -> HookFunctionGeneration {
        HookFunctionGeneration {
            instance_id: self.instance_id.clone(),
            generation_key: self.generation_key.clone(),
            revision: self.revision.clone(),
        }
    }
}

#[derive(Debug, Clone, Copy)]
struct PluginHostLaunchSpec {
    runtime_name: &'static str,
    default_command: &'static str,
    command_env: &'static str,
    entry_env: &'static str,
    entry_filename: &'static str,
}

impl PluginHostLaunchSpec {
    fn bun() -> Self {
        Self {
            runtime_name: "Bun",
            default_command: "bun",
            command_env: BUN_COMMAND_ENV,
            entry_env: BUN_HOST_ENTRY_ENV,
            entry_filename: "extension-host.js",
        }
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum PluginHostStartup {
    Disabled,
    Started,
    AlreadyStarted,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum PluginHostLaunchPolicy {
    Enabled,
    Disabled,
}

pub async fn configured_plugins_present() -> crate::OpenBitFunResult<bool> {
    use crate::service::config::{get_global_config_service, GlobalConfig};

    let config_service = get_global_config_service().await?;
    let config: GlobalConfig = config_service.get_config(None).await?;
    Ok(config.has_configured_plugins())
}

pub async fn initialize_configured_plugin_host(
    launch_policy: PluginHostLaunchPolicy,
) -> crate::OpenBitFunResult<PluginHostStartup> {
    initialize_configured_plugin_host_with_log_file(launch_policy, None).await
}

pub async fn initialize_configured_plugin_host_with_log_file(
    launch_policy: PluginHostLaunchPolicy,
    log_file: Option<PathBuf>,
) -> crate::OpenBitFunResult<PluginHostStartup> {
    use crate::service::config::{get_global_config_service, GlobalConfig};

    if launch_policy == PluginHostLaunchPolicy::Disabled {
        return Ok(PluginHostStartup::Disabled);
    }
    let config_service = get_global_config_service().await?;
    let config: GlobalConfig = config_service.get_config(None).await?;
    let startup =
        initialize_configured_plugin_host_from_config(launch_policy, log_file, &config).await?;
    clear_configured_plugin_activation_failure(None);
    Ok(startup)
}

async fn initialize_configured_plugin_host_from_config(
    launch_policy: PluginHostLaunchPolicy,
    log_file: Option<PathBuf>,
    config: &crate::service::config::GlobalConfig,
) -> crate::OpenBitFunResult<PluginHostStartup> {
    if launch_policy == PluginHostLaunchPolicy::Disabled {
        return Ok(PluginHostStartup::Disabled);
    }
    if !config.has_configured_plugins() {
        return Ok(PluginHostStartup::Disabled);
    }
    let lifecycle_lock = PLUGIN_HOST_LIFECYCLE_LOCK
        .get_or_init(|| async { Mutex::new(()) })
        .await;
    let _lifecycle_guard = lifecycle_lock.lock().await;
    if PLUGIN_HOST_SHUTDOWN_STARTED.load(Ordering::Acquire) {
        return Err(crate::OpenBitFunError::ProcessError(
            "Plugin host is shutting down".to_string(),
        ));
    }
    let launch_spec = PluginHostLaunchSpec::bun();

    let host_state = PLUGIN_HOST.get_or_init(|| async { Mutex::new(None) }).await;
    let stale_host = {
        let mut host_state = host_state.lock().await;
        if PLUGIN_HOST_SHUTDOWN_STARTED.load(Ordering::Acquire) {
            return Err(crate::OpenBitFunError::ProcessError(
                "Plugin host is shutting down".to_string(),
            ));
        }
        if let Some(host) = host_state.as_mut() {
            if host
                .is_connected()
                .map_err(|error| crate::OpenBitFunError::ProcessError(error.to_string()))?
            {
                return Ok(PluginHostStartup::AlreadyStarted);
            }
            log::warn!("Configured plugin host slot contained a disconnected host; retiring it before restart");
            host_state.take()
        } else {
            None
        }
    };
    if let Some(stale) = stale_host {
        let _ = stale.shutdown(PluginHostShutdownPolicy::default()).await;
    }
    let path_manager = crate::infrastructure::try_get_path_manager_arc()?;
    let log_file = log_file.unwrap_or_else(|| path_manager.logs_dir().join("plugin-host.log"));
    let entry = resolve_host_entry(launch_spec)?;
    let working_directory = entry.parent().ok_or_else(|| {
        crate::OpenBitFunError::config(format!(
            "{} plugin host entry has no parent directory: {}",
            launch_spec.runtime_name,
            entry.display()
        ))
    })?;
    let host = PluginHost::start(PluginHostConfig {
        runtime_command: std::env::var_os(launch_spec.command_env)
            .map(PathBuf::from)
            .unwrap_or_else(|| PathBuf::from(launch_spec.default_command)),
        entry: entry.clone(),
        working_directory: working_directory.to_path_buf(),
        cache_directory: path_manager.cache_root().join("opencode-plugin-host"),
        log_file,
        log_level: config.app.logging.level.trim().to_lowercase(),
    })
    .await
    .map_err(|error| {
        crate::OpenBitFunError::ProcessError(format!(
            "Failed to initialize {} plugin host from {}: {error}",
            launch_spec.runtime_name,
            entry.display()
        ))
    })?;
    let client = host.client();
    crate::plugin_host_http::register_plugin_host_backend_handlers(client.clone()).await?;
    *host_state.lock().await = Some(host);
    start_plugin_host_health_monitor(client.clone());
    // Do not prepare or import configured packages during Host startup. The
    // workspace-specific ensure path owns package resolution and generation
    // publication. Configured plugin declarations are currently treated as
    // trusted local executable input; follow-up hardening is tracked in the
    // OpenCode compatibility design rather than represented by a non-enforcing
    // approval API.
    Ok(PluginHostStartup::Started)
}

pub async fn set_configured_plugin_host_log_level(level: &str) -> crate::OpenBitFunResult<()> {
    let host_state = PLUGIN_HOST.get_or_init(|| async { Mutex::new(None) }).await;
    let client = host_state.lock().await.as_ref().map(PluginHost::client);
    let Some(client) = client else {
        return Ok(());
    };
    client.set_log_level(level).await.map_err(|error| {
        crate::OpenBitFunError::ProcessError(format!(
            "Failed to update plugin host log level to {}: {}",
            level, error
        ))
    })
}

/// Fault the current Host connection and reap its complete process tree. This
/// is used after a side-effecting invocation whose cancellation could not be
/// confirmed; closing the RPC socket alone is not a stop guarantee.
pub(crate) async fn fault_configured_plugin_host_generation(
    expected_generation: u64,
    reason: &str,
) -> bool {
    let lifecycle_lock = PLUGIN_HOST_LIFECYCLE_LOCK
        .get_or_init(|| async { Mutex::new(()) })
        .await;
    let _lifecycle_guard = lifecycle_lock.lock().await;
    let host = {
        let Some(state) = PLUGIN_HOST.get() else {
            return false;
        };
        let mut state = state.lock().await;
        if state
            .as_ref()
            .is_some_and(|host| host.client().generation() != expected_generation)
        {
            return false;
        }
        state.take()
    };
    let Some(host) = host else {
        return false;
    };
    log::error!(
        "Faulting configured plugin host and terminating its process tree: generation={}, reason={}",
        host.client().generation(),
        reason
    );
    let report = host.shutdown(PluginHostShutdownPolicy::default()).await;
    log::error!(
        "Configured plugin host fault cleanup completed: generation={}, disposition={:?}, exit_code={:?}",
        report.generation,
        report.disposition,
        report.exit_code
    );
    true
}

pub async fn ensure_configured_plugin_instance(
    launch_policy: PluginHostLaunchPolicy,
    workspace_id: &str,
) -> crate::OpenBitFunResult<()> {
    use crate::service::config::{get_global_config_service, GlobalConfig};

    let service = crate::service::workspace::get_global_workspace_service().ok_or_else(|| {
        crate::OpenBitFunError::Validation("Workspace service is unavailable".into())
    })?;
    let workspace = service.require_workspace(workspace_id).await?;
    if workspace.workspace_kind == crate::service::workspace::WorkspaceKind::Remote {
        return Err(crate::OpenBitFunError::NotImplemented(
            "Plugin Host is unavailable for remote workspaces".into(),
        ));
    }
    let directory = workspace.root_path;
    let worktree = directory.clone();
    let project_id = workspace.id.clone();

    if launch_policy == PluginHostLaunchPolicy::Disabled {
        withdraw_configured_plugin_workspace(workspace_id).await;
        clear_configured_plugin_activation_failure(Some(workspace_id));
        return Ok(());
    }
    if directory.as_os_str().is_empty() || !directory.is_dir() {
        return Err(crate::OpenBitFunError::Validation(format!(
            "Plugin host instance directory does not exist: {}",
            directory.display()
        )));
    }
    let canonical_directory = dunce::canonicalize(&directory).map_err(|error| {
        crate::OpenBitFunError::Io(std::io::Error::other(format!(
            "Failed to canonicalize plugin host instance directory {}: {error}",
            directory.display()
        )))
    })?;
    let canonical_directory_string = canonical_directory.to_string_lossy().into_owned();
    let comparable_directory = workspace_id.to_owned();
    // All ensure/withdraw operations for a workspace use this same lock. The
    // workspace snapshot, generation replacement, and publication therefore
    // form one serialized transition for this directory.
    let workspace_lock = plugin_host_workspace_lock(&comparable_directory).await;
    let _workspace_guard = workspace_lock.lock().await;

    // Capture one immutable product configuration snapshot inside the
    // workspace transition. Host initialization, package preparation, and the
    // generation fingerprint must all describe this same declaration set.
    let config_service = get_global_config_service().await?;
    let global_config: GlobalConfig = config_service.get_config(None).await?;
    if !global_config.has_configured_plugins() {
        withdraw_configured_plugin_workspace_locked(&comparable_directory).await;
        clear_configured_plugin_activation_failure(Some(workspace_id));
        return Ok(());
    }
    initialize_configured_plugin_host_from_config(launch_policy, None, &global_config).await?;
    clear_configured_plugin_activation_failure(None);
    // Shutdown sets its gate before waiting for active ensure leases. Holding
    // this lease through prepare/open/register/publish prevents teardown from
    // clearing the instance table while a generation is still being published.
    let _ensure_lease = acquire_plugin_host_ensure_lease().await?;

    let config = serde_json::to_value(
        crate::plugin_runtime::opencode_config_snapshot(&canonical_directory).map_err(|error| {
            crate::OpenBitFunError::Validation(format!(
                "Failed to load OpenCode config for plugin activation: {error}"
            ))
        })?,
    )
    .and_then(|value| match value {
        Value::Object(config) => Ok(config),
        _ => unreachable!("OpenCodeConfigSnapshot must serialize as an object"),
    })
    .map_err(|error| {
        crate::OpenBitFunError::Validation(format!(
            "Failed to serialize OpenCode plugin config snapshot: {error}"
        ))
    })?;
    let initial_config = config.clone();
    let config_fingerprint = plugin_config_fingerprint(&global_config)?;
    let (client, runtime) = {
        let host_state = PLUGIN_HOST.get_or_init(|| async { Mutex::new(None) }).await;
        host_state
            .lock()
            .await
            .as_ref()
            .map(|host| (host.client(), host.runtime()))
            .ok_or_else(|| {
                crate::OpenBitFunError::ProcessError(
                    "Configured plugin host is not running".to_string(),
                )
            })?
    };
    if !client.capabilities().supports(GENERATION_FENCING_V1) {
        return Err(crate::OpenBitFunError::ProcessError(
            "Configured plugin host does not support generation-fencing-v1".to_string(),
        ));
    }
    let instances = PLUGIN_HOST_INSTANCES
        .get_or_init(|| async { Mutex::new(HashMap::new()) })
        .await;
    let declarations = global_config
        .plugin
        .iter()
        .filter_map(plugin_declaration)
        .collect::<Vec<_>>();
    // Resolve the configured declarations directly. Plugin activation is an
    // explicit OpenBitFun configuration choice; no separate external-integration
    // policy, safe-mode switch, or activation approval is required before the
    // host can load the configured plugins.
    let prepared = client
        .prepare_plugins(
            PluginPrepareRequest {
                plugins: declarations.clone(),
                configuration_fingerprint: Some(config_fingerprint.clone()),
                default_base_directory: Some(canonical_directory_string.clone()),
                allow_install: Some(true),
            },
            std::time::Duration::from_secs(30),
        )
        .await
        .map_err(|error| {
            crate::OpenBitFunError::ProcessError(format!(
                "Failed to prepare plugins for workspace {}: {error}",
                canonical_directory.display()
            ))
        })?;
    let prepared_count = prepared.prepared_count;
    let failed_count = prepared.failed_count;
    let reviewed_count = prepared.reviewed_count;
    if failed_count != 0 || prepared_count != reviewed_count {
        return Err(crate::OpenBitFunError::Validation(format!(
            "Configured OpenCode plugin preparation did not resolve the complete plugin graph: prepared={prepared_count}, failed={failed_count}, reviewed={reviewed_count}"
        )));
    }
    // Use the adapter's stable digest for generation identity. Cache state and
    // diagnostic prose are operational details and must not churn a generation.
    let prepared_fingerprint = prepared.review_digest;
    let expected_content_digests = prepared.content_digests;

    let workspace_config_fingerprint = serde_json::to_vec(&initial_config)
        .map(|bytes| hex::encode(Sha256::digest(bytes)))
        .map_err(|error| {
            crate::OpenBitFunError::Validation(format!(
                "Failed to fingerprint workspace plugin config: {error}"
            ))
        })?;
    let instance_key = format!(
        "{comparable_directory}\n{project_id}\n{config_fingerprint}\n{workspace_config_fingerprint}\n{prepared_fingerprint}"
    );
    let reusable_instance = {
        let mut state = instances.lock().await;
        state
            .get_mut(&instance_key)
            .filter(|instance| instance.ready && instance.host_generation == client.generation())
            .map(|instance| {
                instance.retirement_scheduled = false;
                instance.clone()
            })
    };
    if let Some(instance) = reusable_instance {
        if crate::plugin_capability_publication::active_generation_key(
            workspace_id,
            OPENCODE_PLUGIN_ROUTE_OWNER,
        )
        .as_deref()
            != Some(instance.generation_key.as_str())
        {
            let registration_batch = instance.registration_batch.as_ref().ok_or_else(|| {
                crate::OpenBitFunError::ProcessError(
                    "Reusable plugin instance is missing its typed registration batch".to_string(),
                )
            })?;
            let projection = openbitfun_opencode_adapter::project_plugin_config(
                &canonical_directory,
                &initial_config,
                registration_batch,
            )
            .map_err(|error| crate::OpenBitFunError::Validation(error.to_string()))?;
            let publication = crate::plugin_capability_publication::prepare(
                workspace_id,
                &instance.generation_key,
                opencode_plugin_publication_identity(),
                projection,
            )?;
            crate::plugin_hook_bridge::commit_plugin_generation(
                &crate::native_hooks::plugin_hook_registry(&comparable_directory),
                &comparable_directory,
                instance.hook_commit_token.as_ref(),
            );
            publication.commit();
        }
        log::debug!(
            "Configured plugin host instance reused: generation={}, instance_id={}",
            client.generation(),
            instance.instance_id
        );
        if !retire_superseded_plugin_instances(
            &client,
            runtime.clone(),
            instances,
            &instance_key,
            &comparable_directory,
        )
        .await
        {
            return Err(crate::OpenBitFunError::ProcessError(
                "Configured plugin Host faulted while retiring a superseded generation".to_string(),
            ));
        }
        clear_configured_plugin_activation_failure(Some(workspace_id));
        return Ok(());
    }

    // The extension host owns one canonical directory at a time. Stop and
    // remove the old logical generation before opening the replacement so the
    // host cannot reject the new instance with directory_exists or run old and
    // new plugin code concurrently.
    if !retire_workspace_instances_before_open(
        &client,
        runtime.clone(),
        instances,
        &comparable_directory,
    )
    .await
    {
        return Err(crate::OpenBitFunError::ProcessError(
            "Configured plugin host could not confirm closure of the previous workspace generation"
                .to_string(),
        ));
    }

    let sequence = NEXT_INSTANCE_SEQUENCE.fetch_add(1, Ordering::Relaxed);
    let instance_id = format!("openbitfun:host:{}:{sequence}", client.generation());
    let revision = format!("revision-{sequence}");
    let generation_material =
        format!("{config_fingerprint}\n{workspace_config_fingerprint}\n{prepared_fingerprint}");
    let generation_key = format!(
        "host-{}:instance-{sequence}:sha256-{}",
        client.generation(),
        hex::encode(Sha256::digest(generation_material.as_bytes()))
    );
    let now_ms = chrono::Utc::now().timestamp_millis();
    let opening_context = PluginHostInstance {
        workspace_id: workspace_id.to_owned(),
        canonical_directory: canonical_directory_string.clone(),
        directory: canonical_directory.clone(),
        worktree: worktree.clone(),
        project_id: project_id.clone(),
        created_at_ms: now_ms,
        instance_id: instance_id.clone(),
        host_generation: client.generation(),
        generation_key: generation_key.clone(),
        revision: revision.clone(),
        registration_batch: None,
        ready: false,
        hook_commit_token: None,
        transformed_config_health_snapshot: None,
        diagnostic_health_snapshot: Vec::new(),
        tool_names: Vec::new(),
        agent_runtime_keys: Vec::new(),
        retirement_scheduled: false,
    };
    instances
        .lock()
        .await
        .insert(instance_key.clone(), opening_context);
    let generation = HookFunctionGeneration {
        instance_id: instance_id.clone(),
        generation_key: generation_key.clone(),
        revision: revision.clone(),
    };
    let registrations = Arc::new(CapturedPluginGeneration::default());
    let started = runtime
        .start(
            HookFunctionStartRequest {
                generation: generation.clone(),
                project_id: project_id.clone(),
                project_worktree: canonical_directory_string.clone(),
                project_created_at_ms: u64::try_from(now_ms).unwrap_or_default(),
                config,
                directory: canonical_directory.to_string_lossy().into_owned(),
                worktree: worktree.to_string_lossy().into_owned(),
                plugins: declarations
                    .into_iter()
                    .map(|plugin| HookFunctionPluginDeclaration {
                        spec: plugin.spec,
                        options: plugin.options,
                        base_directory: plugin.base_directory,
                    })
                    .collect(),
                configuration_fingerprint: Some(config_fingerprint.clone()),
                expected_content_digests,
                expected_review_digest: Some(prepared_fingerprint.clone()),
            },
            registrations.clone(),
            crate::agentic::tools::plugin_host_tool::reverse_sink(),
            std::time::Duration::from_secs(30),
        )
        .await;
    match started {
        Ok(started) if started == generation => {}
        Ok(_) => {
            discard_opening_plugin_instance(
                &client,
                runtime.clone(),
                instances,
                &instance_key,
                &generation,
            )
            .await;
            return Err(crate::OpenBitFunError::ProcessError(
                "Plugin runtime returned a different generation from the requested lease"
                    .to_string(),
            ));
        }
        Err(error) => {
            discard_opening_plugin_instance(
                &client,
                runtime.clone(),
                instances,
                &instance_key,
                &generation,
            )
            .await;
            return Err(crate::OpenBitFunError::ProcessError(format!(
                "Failed to activate plugins for workspace {}: {error}",
                canonical_directory.display()
            )));
        }
    }
    let registration_batch = match registrations.take() {
        Ok(batch) => batch,
        Err(error) => {
            discard_opening_plugin_instance(
                &client,
                runtime.clone(),
                instances,
                &instance_key,
                &generation,
            )
            .await;
            return Err(error);
        }
    };
    let projected_config = openbitfun_opencode_adapter::project_plugin_config(
        &canonical_directory,
        &initial_config,
        &registration_batch,
    )
    .map_err(|error| crate::OpenBitFunError::Validation(error.to_string()));
    let config_publication = match projected_config.and_then(|projection| {
        crate::plugin_capability_publication::prepare(
            workspace_id,
            &generation_key,
            opencode_plugin_publication_identity(),
            projection,
        )
    }) {
        Ok(publication) => publication,
        Err(error) => {
            discard_opening_plugin_instance(
                &client,
                runtime.clone(),
                instances,
                &instance_key,
                &generation,
            )
            .await;
            return Err(error);
        }
    };
    let plugin_agent_runtime_keys = config_publication.agent_runtime_keys();
    log::info!(
        "Configured plugin host instance prepared: generation={}, instance_id={}, plugin_count={}",
        client.generation(),
        instance_id,
        global_config.plugin.len()
    );
    let hook_commit_token = match crate::plugin_hook_bridge::register_plugin_hooks_with_runtime(
        &crate::native_hooks::plugin_hook_registry(&comparable_directory),
        &comparable_directory,
        runtime.clone(),
        &instance_id,
        &generation_key,
        &revision,
        &crate::plugin_hook_bridge::hook_names(&registration_batch),
    ) {
        Ok(token) => token,
        Err(error) => {
            discard_opening_plugin_instance(
                &client,
                runtime.clone(),
                instances,
                &instance_key,
                &generation,
            )
            .await;
            return Err(crate::OpenBitFunError::ProcessError(format!(
                "Failed to register plugin hooks for workspace {}: {error}",
                canonical_directory.display()
            )));
        }
    };
    let tool_names = match register_plugin_tools(
        runtime.clone(),
        client.generation(),
        &instance_id,
        &comparable_directory,
        workspace_id,
        &generation_key,
        &revision,
        &config_fingerprint,
        &registration_batch,
        &config_publication,
    )
    .await
    {
        Ok(names) => names,
        Err(error) => {
            if let Some(token) = hook_commit_token.clone() {
                crate::plugin_hook_bridge::unregister_plugin_hooks(
                    &crate::native_hooks::plugin_hook_registry(&comparable_directory),
                    &comparable_directory,
                    token,
                );
            }
            discard_opening_plugin_instance(
                &client,
                runtime.clone(),
                instances,
                &instance_key,
                &generation,
            )
            .await;
            return Err(error);
        }
    };
    // Publish readiness, Hooks, and Config routes while holding the instance
    // table lock. Hook dispatch cannot observe ready=true before its Registry
    // generation is active, and Agent routing is published last, after the
    // instance identity is available to generation-fenced dispatch.
    {
        let mut state = instances.lock().await;
        if !state.contains_key(&instance_key) {
            drop(state);
            if let Some(token) = hook_commit_token.clone() {
                crate::plugin_hook_bridge::unregister_plugin_hooks(
                    &crate::native_hooks::plugin_hook_registry(&comparable_directory),
                    &comparable_directory,
                    token,
                );
            }
            crate::agentic::tools::plugin_host_tool::unregister_workspace_tools(
                &comparable_directory,
                workspace_id,
                &tool_names,
                &generation_key,
            )
            .await;
            discard_opening_plugin_instance(
                &client,
                runtime.clone(),
                instances,
                &instance_key,
                &generation,
            )
            .await;
            return Err(crate::OpenBitFunError::ProcessError(
                "Plugin instance disappeared before generation publication".to_string(),
            ));
        }
        let instance = state
            .get_mut(&instance_key)
            .expect("plugin instance existence checked while holding instance table lock");
        instance.registration_batch = Some(registration_batch.clone());
        instance.ready = true;
        instance.hook_commit_token = hook_commit_token.clone();
        instance.transformed_config_health_snapshot =
            Some(Value::Object(registration_batch.config.clone()));
        instance.tool_names = tool_names;
        instance.agent_runtime_keys = plugin_agent_runtime_keys.into_iter().collect();
        crate::plugin_hook_bridge::commit_plugin_generation(
            &crate::native_hooks::plugin_hook_registry(&comparable_directory),
            &comparable_directory,
            hook_commit_token.as_ref(),
        );
        config_publication.commit();
    }
    if !retire_superseded_plugin_instances(
        &client,
        runtime,
        instances,
        &instance_key,
        &comparable_directory,
    )
    .await
    {
        return Err(crate::OpenBitFunError::ProcessError(
            "Configured plugin Host faulted while retiring a superseded generation".to_string(),
        ));
    }
    clear_configured_plugin_activation_failure(Some(workspace_id));
    Ok(())
}

async fn discard_opening_plugin_instance(
    client: &openbitfun_opencode_plugin_host::PluginHostClient,
    runtime: Arc<dyn HookFunctionRuntime>,
    instances: &Mutex<HashMap<String, PluginHostInstance>>,
    instance_key: &str,
    generation: &HookFunctionGeneration,
) {
    if !dispose_plugin_generation(client, runtime, generation, "failed plugin prepare").await {
        log::debug!(
            "Plugin instance cleanup after failed prepare faulted the Host: instance_id={}",
            generation.instance_id
        );
    }
    close_plugin_host_ptys(&generation.instance_id).await;
    let mut state = instances.lock().await;
    if state
        .get(instance_key)
        .is_some_and(|current| current.instance_id == generation.instance_id)
    {
        state.remove(instance_key);
    }
}

async fn retire_workspace_instances_before_open(
    client: &openbitfun_opencode_plugin_host::PluginHostClient,
    runtime: Arc<dyn HookFunctionRuntime>,
    instances: &Mutex<HashMap<String, PluginHostInstance>>,
    workspace_scope: &str,
) -> bool {
    let stale = {
        let state = instances.lock().await;
        let keys = state
            .iter()
            .filter(|(_, instance)| instance.workspace_id == workspace_scope)
            .map(|(key, instance)| (key.clone(), instance.instance_id.clone()))
            .collect::<Vec<_>>();
        keys.into_iter()
            .filter_map(|(key, instance_id)| {
                state
                    .get(&key)
                    .filter(|current| current.instance_id == instance_id)
                    .cloned()
                    .map(|instance| (key, instance))
            })
            .collect::<Vec<_>>()
    };
    let mut all_closed = true;
    for (key, instance) in stale {
        if retire_plugin_instance(client, runtime.clone(), instance.clone(), workspace_scope).await
        {
            let mut state = instances.lock().await;
            if state
                .get(&key)
                .is_some_and(|current| current.instance_id == instance.instance_id)
            {
                state.remove(&key);
            }
        } else if let Some(current) = instances.lock().await.get_mut(&key) {
            if current.instance_id == instance.instance_id {
                current.ready = false;
            }
            all_closed = false;
        }
    }
    all_closed
}

async fn withdraw_configured_plugin_workspace(workspace_scope: &str) {
    let workspace_lock = plugin_host_workspace_lock(&workspace_scope).await;
    let _workspace_guard = workspace_lock.lock().await;
    withdraw_configured_plugin_workspace_locked(&workspace_scope).await;
}

async fn withdraw_configured_plugin_workspace_locked(workspace_scope: &str) {
    let registry = crate::native_hooks::plugin_hook_registry(&workspace_scope);
    crate::plugin_hook_bridge::withdraw_plugin_workspace(&registry, &workspace_scope);
    crate::plugin_capability_publication::release_workspace(
        workspace_scope,
        OPENCODE_PLUGIN_ROUTE_OWNER,
    );
    let Some(instances) = PLUGIN_HOST_INSTANCES.get() else {
        crate::native_hooks::clear_plugin_hook_workspace(&workspace_scope);
        return;
    };
    let owned = instances
        .lock()
        .await
        .iter()
        .filter(|(_, instance)| instance.workspace_id == workspace_scope)
        .map(|(key, instance)| (key.clone(), instance.clone()))
        .collect::<Vec<_>>();
    let host_runtime = if let Some(state) = PLUGIN_HOST.get() {
        state
            .lock()
            .await
            .as_ref()
            .map(|host| (host.client(), host.runtime()))
    } else {
        None
    };
    for (key, instance) in owned {
        if let Some(token) = instance.hook_commit_token.clone() {
            crate::plugin_hook_bridge::unregister_plugin_hooks(&registry, &workspace_scope, token);
        }
        crate::agentic::tools::plugin_host_tool::unregister_workspace_tools(
            &workspace_scope,
            &instance.workspace_id,
            &instance.tool_names,
            &instance.generation_key,
        )
        .await;
        if let Some(bridge) = crate::plugin_host_http::plugin_host_backend_bridge() {
            bridge.cancel_instance_streams(&instance.instance_id).await;
        }
        let close_result = if let Some((client, runtime)) = host_runtime.as_ref() {
            dispose_plugin_generation(
                client,
                runtime.clone(),
                &instance.generation(),
                "workspace withdrawal",
            )
            .await
            .then_some(())
            .ok_or_else(|| "plugin Host faulted during workspace withdrawal".to_string())
        } else {
            Err("plugin host is unavailable during workspace withdrawal".to_string())
        };
        close_plugin_host_ptys(&instance.instance_id).await;
        let mut state = instances.lock().await;
        if let Some(current) = state.get_mut(&key) {
            if current.instance_id != instance.instance_id {
                continue;
            }
            if let Err(error) = close_result {
                current.ready = false;
                log::error!(
                    "Plugin instance withdrawal could not confirm Host close; retaining fault state: instance_id={}, error={}",
                    current.instance_id,
                    error
                );
            } else {
                state.remove(&key);
            }
        }
    }
    crate::native_hooks::clear_plugin_hook_workspace(&workspace_scope);
}

async fn withdraw_faulted_plugin_host_generation(workspace_scope: &str, expected_generation: u64) {
    let workspace_lock = plugin_host_workspace_lock(&workspace_scope).await;
    let _workspace_guard = workspace_lock.lock().await;
    let Some(instances) = PLUGIN_HOST_INSTANCES.get() else {
        return;
    };
    let owned = instances
        .lock()
        .await
        .iter()
        .filter(|(_, instance)| {
            instance.workspace_id == workspace_scope
                && instance.host_generation == expected_generation
        })
        .map(|(key, instance)| (key.clone(), instance.clone()))
        .collect::<Vec<_>>();
    let registry = crate::native_hooks::plugin_hook_registry(&workspace_scope);
    for (key, instance) in owned {
        if let Some(token) = instance.hook_commit_token.clone() {
            crate::plugin_hook_bridge::unregister_plugin_hooks(&registry, &workspace_scope, token);
        }
        crate::agentic::tools::plugin_host_tool::unregister_workspace_tools(
            &workspace_scope,
            &instance.workspace_id,
            &instance.tool_names,
            &instance.generation_key,
        )
        .await;
        if crate::plugin_capability_publication::active_generation_key(
            &instance.workspace_id,
            OPENCODE_PLUGIN_ROUTE_OWNER,
        )
        .as_deref()
            == Some(instance.generation_key.as_str())
        {
            crate::plugin_capability_publication::release_workspace(
                &instance.workspace_id,
                OPENCODE_PLUGIN_ROUTE_OWNER,
            );
        }
        if let Some(bridge) = crate::plugin_host_http::plugin_host_backend_bridge() {
            bridge.cancel_instance_streams(&instance.instance_id).await;
        }
        close_plugin_host_ptys(&instance.instance_id).await;
        let mut state = instances.lock().await;
        if state.get(&key).is_some_and(|current| {
            current.instance_id == instance.instance_id
                && current.host_generation == expected_generation
        }) {
            state.remove(&key);
        }
    }
    let has_replacement = instances.lock().await.values().any(|instance| {
        instance.workspace_id == workspace_scope && instance.host_generation != expected_generation
    });
    if !has_replacement {
        crate::plugin_hook_bridge::withdraw_plugin_workspace(&registry, &workspace_scope);
        crate::plugin_capability_publication::release_workspace(
            workspace_scope,
            OPENCODE_PLUGIN_ROUTE_OWNER,
        );
        crate::native_hooks::clear_plugin_hook_workspace(&workspace_scope);
    }
}

fn start_plugin_host_health_monitor(client: openbitfun_opencode_plugin_host::PluginHostClient) {
    tokio::spawn(async move {
        loop {
            tokio::time::sleep(std::time::Duration::from_millis(500)).await;
            let (connected, owns_host_slot) = {
                let Some(host_state) = PLUGIN_HOST.get() else {
                    return;
                };
                let mut host_state = host_state.lock().await;
                match host_state.as_mut() {
                    Some(host) if host.client().generation() != client.generation() => {
                        (false, false)
                    }
                    Some(host) => match host.is_connected() {
                        Ok(connected) => (connected, true),
                        Err(error) => {
                            log::error!(
                                "Configured plugin host health check failed: generation={}, error={}",
                                client.generation(),
                                error
                            );
                            (false, true)
                        }
                    },
                    None => (false, false),
                }
            };
            if connected && !client.is_closed() {
                continue;
            }
            log::error!(
                "Configured plugin host process or connection closed; withdrawing all plugin contributions: generation={}",
                client.generation()
            );
            // Another outcome-unknown path may already have reaped this
            // physical Host. Local routes still belong to this dead generation
            // and must be withdrawn; the cleanup below is generation-scoped
            // and therefore cannot remove a replacement Host's contributions.
            if owns_host_slot {
                fault_configured_plugin_host_generation(
                    client.generation(),
                    "host connection or process lost",
                )
                .await;
            }
            let workspaces = PLUGIN_HOST_INSTANCES.get().map(|instances| async {
                instances
                    .lock()
                    .await
                    .values()
                    .filter(|instance| instance.host_generation == client.generation())
                    .map(|instance| instance.workspace_id.clone())
                    .collect::<std::collections::BTreeSet<_>>()
            });
            let Some(workspaces) = workspaces else { return };
            let workspaces = workspaces.await;
            for workspace in workspaces {
                withdraw_faulted_plugin_host_generation(&workspace, client.generation()).await;
            }
            return;
        }
    });
}

async fn retire_superseded_plugin_instances(
    client: &openbitfun_opencode_plugin_host::PluginHostClient,
    runtime: Arc<dyn HookFunctionRuntime>,
    instances: &Mutex<HashMap<String, PluginHostInstance>>,
    active_key: &str,
    workspace_scope: &str,
) -> bool {
    let stale = instances
        .lock()
        .await
        .iter()
        .filter(|(key, instance)| {
            key.as_str() != active_key && instance.workspace_id == workspace_scope
        })
        .map(|(key, instance)| (key.clone(), instance.clone()))
        .collect::<Vec<_>>();
    for (key, instance) in stale {
        if instance.agent_runtime_keys.iter().any(|runtime_key| {
            crate::agentic::agents::get_agent_registry().check_agent_exists(runtime_key)
        }) {
            let should_schedule = {
                let mut state = instances.lock().await;
                state.get_mut(&key).is_some_and(|current| {
                    if current.retirement_scheduled {
                        false
                    } else {
                        current.retirement_scheduled = true;
                        true
                    }
                })
            };
            if should_schedule {
                schedule_plugin_instance_retirement(client.clone(), runtime.clone(), key.clone());
            }
            continue;
        }
        let removed = {
            let mut state = instances.lock().await;
            state
                .get(&key)
                .filter(|current| current.instance_id == instance.instance_id)
                .is_some()
                .then(|| state.remove(&key))
                .flatten()
        };
        if let Some(removed) = removed {
            if !retire_plugin_instance(client, runtime.clone(), removed, workspace_scope).await {
                return false;
            }
        }
    }
    true
}

fn schedule_plugin_instance_retirement(
    client: openbitfun_opencode_plugin_host::PluginHostClient,
    runtime: Arc<dyn HookFunctionRuntime>,
    instance_key: String,
) {
    tokio::spawn(async move {
        loop {
            tokio::time::sleep(std::time::Duration::from_millis(250)).await;
            let Some(instances) = PLUGIN_HOST_INSTANCES.get() else {
                return;
            };
            let snapshot = {
                let state = instances.lock().await;
                let Some(instance) = state.get(&instance_key) else {
                    return;
                };
                if !instance.retirement_scheduled {
                    return;
                }
                instance.clone()
            };
            if crate::plugin_capability_publication::active_generation_key(
                &snapshot.workspace_id,
                OPENCODE_PLUGIN_ROUTE_OWNER,
            )
            .as_deref()
                == Some(snapshot.generation_key.as_str())
            {
                if let Some(instance) = instances.lock().await.get_mut(&instance_key) {
                    instance.retirement_scheduled = false;
                }
                return;
            }
            if snapshot.agent_runtime_keys.iter().any(|runtime_key| {
                crate::agentic::agents::get_agent_registry().check_agent_exists(runtime_key)
            }) {
                continue;
            }
            let removed = {
                let mut state = instances.lock().await;
                let matches = state.get(&instance_key).is_some_and(|current| {
                    current.retirement_scheduled
                        && current.instance_id == snapshot.instance_id
                        && current.generation_key == snapshot.generation_key
                });
                matches.then(|| state.remove(&instance_key)).flatten()
            };
            if let Some(instance) = removed {
                let workspace_scope = instance.workspace_id.clone();
                let _ =
                    retire_plugin_instance(&client, runtime.clone(), instance, &workspace_scope)
                        .await;
            }
            return;
        }
    });
}

async fn retire_plugin_instance(
    client: &openbitfun_opencode_plugin_host::PluginHostClient,
    runtime: Arc<dyn HookFunctionRuntime>,
    instance: PluginHostInstance,
    workspace_scope: &str,
) -> bool {
    if let Some(token) = instance.hook_commit_token.clone() {
        crate::plugin_hook_bridge::unregister_plugin_hooks(
            &crate::native_hooks::plugin_hook_registry(workspace_scope),
            workspace_scope,
            token,
        );
    }
    crate::agentic::tools::plugin_host_tool::unregister_workspace_tools(
        workspace_scope,
        &instance.workspace_id,
        &instance.tool_names,
        &instance.generation_key,
    )
    .await;
    if let Some(bridge) = crate::plugin_host_http::plugin_host_backend_bridge() {
        bridge.cancel_instance_streams(&instance.instance_id).await;
    }
    let closed = if instance.host_generation != client.generation() {
        // A connection-generation change fences every instance owned by the
        // dead Host. There is no valid RPC target left to close; treating this
        // as closed allows the next Host generation to recover the workspace.
        true
    } else {
        dispose_plugin_generation(
            client,
            runtime,
            &instance.generation(),
            "superseded generation retirement",
        )
        .await
    };
    close_plugin_host_ptys(&instance.instance_id).await;
    if closed {
        crate::plugin_capability_publication::release_workspace_generation(
            &instance.workspace_id,
            OPENCODE_PLUGIN_ROUTE_OWNER,
            &instance.generation_key,
        );
    }
    closed
}

async fn dispose_plugin_generation(
    client: &openbitfun_opencode_plugin_host::PluginHostClient,
    runtime: Arc<dyn HookFunctionRuntime>,
    generation: &HookFunctionGeneration,
    reason: &str,
) -> bool {
    match runtime
        .dispose(
            HookFunctionDisposeRequest {
                generation: generation.clone(),
            },
            std::time::Duration::from_secs(10),
        )
        .await
    {
        Ok(result) if result.closed => true,
        Ok(_) => {
            log::error!(
                "Plugin runtime did not confirm generation disposal: instance_id={}, reason={}",
                generation.instance_id,
                reason
            );
            fault_configured_plugin_host_generation(client.generation(), reason).await;
            false
        }
        Err(error) => {
            log::error!(
                "Plugin runtime generation disposal failed: instance_id={}, reason={}, error={}",
                generation.instance_id,
                reason,
                error
            );
            fault_configured_plugin_host_generation(client.generation(), reason).await;
            false
        }
    }
}

pub(crate) async fn plugin_host_instance_by_id(instance_id: &str) -> Option<PluginHostInstance> {
    let instances = PLUGIN_HOST_INSTANCES.get()?;
    instances
        .lock()
        .await
        .values()
        .find(|instance| instance.instance_id == instance_id)
        .cloned()
}

pub(crate) async fn plugin_hook_generation_for_agent(
    workspace_scope: &str,
    runtime_agent_key: &str,
) -> Option<openbitfun_agent_runtime::native_hooks::PluginHookGenerationIdentity> {
    let instances = PLUGIN_HOST_INSTANCES.get()?;
    instances
        .lock()
        .await
        .values()
        .find(|instance| {
            instance.ready
                && instance.workspace_id == workspace_scope
                && instance
                    .agent_runtime_keys
                    .iter()
                    .any(|key| key == runtime_agent_key)
        })
        .map(
            |instance| openbitfun_agent_runtime::native_hooks::PluginHookGenerationIdentity {
                instance_id: instance.instance_id.clone(),
                generation_key: instance.generation_key.clone(),
                revision: instance.revision.clone(),
            },
        )
}

pub(crate) async fn publish_plugin_host_diagnostic(
    event: BackendDiagnosticEvent,
) -> Result<(), BackendDiagnosticError> {
    let diagnostic = serde_json::json!({
        "severity": event.diagnostic.severity.as_str(),
        "code": event.diagnostic.code,
        "message": event.diagnostic.message,
        "plugin": event.diagnostic.plugin,
        "method": event.diagnostic.method,
        "data": event.diagnostic.data,
    });
    if let Some(instance_id) = event.instance_id.as_deref() {
        let instances = PLUGIN_HOST_INSTANCES.get().ok_or_else(|| {
            BackendDiagnosticError::Unavailable("plugin instance is unavailable".to_string())
        })?;
        let mut instances = instances.lock().await;
        let instance = instances
            .values_mut()
            .find(|instance| instance.instance_id == instance_id)
            .ok_or_else(|| {
                BackendDiagnosticError::Unavailable("plugin instance is unavailable".to_string())
            })?;
        push_plugin_host_diagnostic(&mut instance.diagnostic_health_snapshot, diagnostic.clone());
    }
    crate::infrastructure::events::emit_global_event(
        crate::infrastructure::events::BackendEvent::Custom {
            event_name: "plugin-host-diagnostic".to_string(),
            payload: serde_json::json!({
                "instance_id": event.instance_id,
                "diagnostic": diagnostic,
                "timestamp": chrono::Utc::now().timestamp_millis(),
            }),
        },
    )
    .await
    .map_err(|error| {
        BackendDiagnosticError::Backend(format!(
            "failed to publish plugin host diagnostic: {error}"
        ))
    })?;
    Ok(())
}

fn plugin_activation_diagnostic(
    operation: &str,
    workspace: Option<&str>,
    error: &str,
) -> BackendDiagnosticEvent {
    BackendDiagnosticEvent {
        instance_id: None,
        diagnostic: BackendDiagnostic {
            severity: BackendDiagnosticSeverity::Warning,
            code: "plugin.activation_failed".to_string(),
            message: error.to_string(),
            plugin: None,
            method: Some(operation.to_string()),
            data: workspace.map(|workspace| serde_json::json!({"workspaceId": workspace})),
        },
    }
}

/// Report an optional configured-plugin activation failure without changing
/// the outcome of the native session operation that triggered it.
pub async fn report_configured_plugin_activation_failure(
    operation: &str,
    workspace: Option<&str>,
    error: impl std::fmt::Display,
) {
    let error = error.to_string();
    record_configured_plugin_activation_failure(operation, workspace, &error);
    log::warn!(
        "Configured plugin activation failed; continuing with native capabilities: operation={}, workspace={}, error={}",
        operation,
        workspace
            .map(str::to_owned)
            .unwrap_or_else(|| "<none>".to_string()),
        error
    );
    if let Err(publish_error) =
        publish_plugin_host_diagnostic(plugin_activation_diagnostic(operation, workspace, &error))
            .await
    {
        log::debug!(
            "Configured plugin activation diagnostic could not be published: {:?}",
            publish_error
        );
    }
}

fn plugin_activation_workspace_key(workspace: Option<&str>) -> String {
    crate::agentic::workspace::workspace_route_key(workspace)
}

fn activation_failure_store() -> &'static std::sync::RwLock<HashMap<String, String>> {
    PLUGIN_ACTIVATION_FAILURES.get_or_init(|| std::sync::RwLock::new(HashMap::new()))
}

fn record_configured_plugin_activation_failure(
    operation: &str,
    workspace: Option<&str>,
    error: &str,
) {
    let mut message = format!("Configured plugin activation failed during {operation}: {error}");
    if message.len() > 2048 {
        let boundary = message
            .char_indices()
            .map(|(index, _)| index)
            .take_while(|index| *index <= 2045)
            .last()
            .unwrap_or(0);
        message.truncate(boundary);
        message.push_str("...");
    }
    activation_failure_store()
        .write()
        .expect("plugin activation failure lock poisoned")
        .insert(plugin_activation_workspace_key(workspace), message);
}

fn clear_configured_plugin_activation_failure(workspace: Option<&str>) {
    activation_failure_store()
        .write()
        .expect("plugin activation failure lock poisoned")
        .remove(&plugin_activation_workspace_key(workspace));
}

pub(crate) fn configured_plugin_activation_failures(workspace: Option<&str>) -> Vec<String> {
    let failures = activation_failure_store()
        .read()
        .expect("plugin activation failure lock poisoned");
    let mut result = Vec::new();
    if let Some(global) = failures.get("<global>") {
        result.push(global.clone());
    }
    let workspace_key = plugin_activation_workspace_key(workspace);
    if workspace_key != "<global>" {
        if let Some(workspace) = failures.get(&workspace_key) {
            result.push(workspace.clone());
        }
    }
    result
}

fn push_plugin_host_diagnostic(snapshot: &mut Vec<Value>, diagnostic: Value) {
    snapshot.push(diagnostic);
    let overflow = snapshot.len().saturating_sub(MAX_PLUGIN_HOST_DIAGNOSTICS);
    if overflow > 0 {
        snapshot.drain(..overflow);
    }
}

pub(crate) async fn register_plugin_host_pty(pty_id: &str, instance_id: &str) {
    let owners = PLUGIN_HOST_PTY_OWNERS
        .get_or_init(|| async { Mutex::new(HashMap::new()) })
        .await;
    owners
        .lock()
        .await
        .insert(pty_id.to_string(), instance_id.to_string());
}

pub(crate) async fn plugin_host_pty_owned_by(pty_id: &str, instance_id: &str) -> bool {
    let Some(owners) = PLUGIN_HOST_PTY_OWNERS.get() else {
        return false;
    };
    owners
        .lock()
        .await
        .get(pty_id)
        .is_some_and(|owner| owner == instance_id)
}

pub(crate) async fn unregister_plugin_host_pty(pty_id: &str, instance_id: &str) -> bool {
    let Some(owners) = PLUGIN_HOST_PTY_OWNERS.get() else {
        return false;
    };
    let mut owners = owners.lock().await;
    if owners.get(pty_id).is_some_and(|owner| owner == instance_id) {
        owners.remove(pty_id);
        true
    } else {
        false
    }
}

pub(crate) async fn prune_plugin_host_pty(pty_id: &str, instance_id: &str) {
    if unregister_plugin_host_pty(pty_id, instance_id).await {
        log::debug!(
            "Removed stale plugin host PTY ownership: instance_id={}, pty_id={}",
            instance_id,
            pty_id
        );
    }
}

pub(crate) async fn plugin_host_pty_ids_for_instance(instance_id: &str) -> Vec<String> {
    let Some(owners) = PLUGIN_HOST_PTY_OWNERS.get() else {
        return Vec::new();
    };
    owners
        .lock()
        .await
        .iter()
        .filter_map(|(pty_id, owner)| (owner == instance_id).then_some(pty_id.clone()))
        .collect()
}

async fn close_plugin_host_ptys(instance_id: &str) {
    let pty_ids = plugin_host_pty_ids_for_instance(instance_id).await;
    if pty_ids.is_empty() {
        return;
    }
    let api = match TerminalApi::from_singleton() {
        Ok(api) => Some(api),
        Err(error) => {
            log::warn!(
                "Plugin host PTYs could not be closed because the terminal owner is unavailable: instance_id={}, pty_count={}, error={}",
                instance_id,
                pty_ids.len(),
                error
            );
            None
        }
    };
    for pty_id in &pty_ids {
        if let Some(api) = api.as_ref() {
            if let Err(error) = api
                .close_session(CloseSessionRequest {
                    session_id: pty_id.clone(),
                    immediate: Some(false),
                })
                .await
            {
                log::warn!(
                    "Plugin host PTY close failed: instance_id={}, pty_id={}, error={}",
                    instance_id,
                    pty_id,
                    error
                );
            }
        }
        unregister_plugin_host_pty(pty_id, instance_id).await;
    }
    log::info!(
        "Plugin host PTY cleanup completed: instance_id={}, pty_count={}",
        instance_id,
        pty_ids.len()
    );
}

async fn close_all_plugin_host_ptys() {
    let instance_ids = if let Some(owners) = PLUGIN_HOST_PTY_OWNERS.get() {
        let mut instance_ids = owners.lock().await.values().cloned().collect::<Vec<_>>();
        instance_ids.sort();
        instance_ids.dedup();
        instance_ids
    } else {
        Vec::new()
    };
    for instance_id in instance_ids {
        close_plugin_host_ptys(&instance_id).await;
    }
}

pub(crate) fn instance_directories_equal(requested: &str, expected: &Path) -> bool {
    let Ok(expected) = dunce::canonicalize(expected) else {
        return false;
    };
    let expected = comparable_instance_directory(&expected.to_string_lossy());
    let matches = |candidate: &str| {
        dunce::canonicalize(candidate)
            .map(|path| comparable_instance_directory(&path.to_string_lossy()) == expected)
            .unwrap_or(false)
    };
    matches(requested)
        || urlencoding::decode(requested)
            .ok()
            .is_some_and(|decoded| decoded.as_ref() != requested && matches(decoded.as_ref()))
}

pub async fn shutdown_configured_plugin_host(
) -> crate::OpenBitFunResult<Option<PluginHostShutdownReport>> {
    let shutdown_report = PLUGIN_HOST_SHUTDOWN_REPORT
        .get_or_init(|| async { Mutex::new(None) })
        .await;
    let shutdown_notify = PLUGIN_HOST_SHUTDOWN_NOTIFY
        .get_or_init(|| async { Notify::new() })
        .await;

    if PLUGIN_HOST_SHUTDOWN_STARTED.swap(true, Ordering::AcqRel) {
        loop {
            let notified = shutdown_notify.notified();
            if PLUGIN_HOST_SHUTDOWN_COMPLETE.load(Ordering::Acquire) {
                return Ok(shutdown_report.lock().await.clone());
            }
            notified.await;
        }
    }

    let lifecycle_lock = PLUGIN_HOST_LIFECYCLE_LOCK
        .get_or_init(|| async { Mutex::new(()) })
        .await;
    // Cross the lifecycle mutex once after closing the gate so an ensure can
    // no longer pass its final shutdown check and acquire a publication lease.
    {
        let _lifecycle_barrier = lifecycle_lock.lock().await;
    }
    wait_for_plugin_host_ensure_leases().await;
    let _lifecycle_guard = lifecycle_lock.lock().await;

    if let Some(bridge) = crate::plugin_host_http::plugin_host_backend_bridge() {
        if !bridge.begin_draining().await {
            log::error!(
                "Plugin Host backend requests did not stop before shutdown teardown; no replacement generation will be started"
            );
        }
    }
    let host_state = PLUGIN_HOST.get_or_init(|| async { Mutex::new(None) }).await;
    let host = host_state.lock().await.take();
    if let Some(instances) = PLUGIN_HOST_INSTANCES.get() {
        let mut instances = instances.lock().await;
        for instance in instances.values() {
            if let Some(token) = instance.hook_commit_token.clone() {
                crate::plugin_hook_bridge::unregister_plugin_hooks(
                    &crate::native_hooks::plugin_hook_registry(&instance.workspace_id),
                    &instance.workspace_id,
                    token,
                );
            }
            crate::agentic::tools::plugin_host_tool::unregister_workspace_tools(
                &instance.workspace_id,
                &instance.workspace_id,
                &instance.tool_names,
                &instance.generation_key,
            )
            .await;
            crate::plugin_capability_publication::release_workspace(
                &instance.workspace_id,
                OPENCODE_PLUGIN_ROUTE_OWNER,
            );
        }
        let workspaces = instances
            .values()
            .map(|instance| instance.workspace_id.clone())
            .collect::<std::collections::BTreeSet<_>>();
        for workspace in workspaces {
            let registry = crate::native_hooks::plugin_hook_registry(&workspace);
            crate::plugin_hook_bridge::withdraw_plugin_workspace(&registry, &workspace);
            crate::native_hooks::clear_plugin_hook_workspace(&workspace);
        }
        instances.clear();
    }
    let report = match host {
        Some(host) => {
            log::info!("Starting configured plugin host graceful shutdown");
            Some(host.shutdown(PluginHostShutdownPolicy::default()).await)
        }
        None => {
            log::debug!("Configured plugin host graceful shutdown skipped: host not started");
            None
        }
    };
    close_all_plugin_host_ptys().await;
    if let Some(owners) = PLUGIN_HOST_PTY_OWNERS.get() {
        owners.lock().await.clear();
    }
    *shutdown_report.lock().await = report.clone();
    PLUGIN_HOST_SHUTDOWN_COMPLETE.store(true, Ordering::Release);
    shutdown_notify.notify_waiters();
    Ok(report)
}

async fn register_plugin_tools(
    runtime: Arc<dyn HookFunctionRuntime>,
    host_generation: u64,
    instance_id: &str,
    workspace_scope: &str,
    workspace_id: &str,
    generation_key: &str,
    revision: &str,
    config_fingerprint: &str,
    registration_batch: &HookFunctionRegistrationBatch,
    projection: &crate::plugin_capability_publication::PluginCapabilityPublicationPlan,
) -> crate::OpenBitFunResult<Vec<String>> {
    let tools = &registration_batch.tools;
    if tools.is_empty() {
        log::debug!(
            "Plugin tool registration completed with no tools: workspace={}, instance_id={}",
            workspace_scope,
            instance_id
        );
        return Ok(Vec::new());
    }
    log::debug!(
        "Plugin tool registration preparing: workspace={}, instance_id={}, tool_count={}",
        workspace_scope,
        instance_id,
        tools.len()
    );
    let mut prepared = Vec::new();
    let mut seen_ids = std::collections::BTreeSet::new();
    for tool in tools {
        let tool_ref = openbitfun_opencode_adapter::project_plugin_tool_ref(tool)
            .map_err(|error| crate::OpenBitFunError::Validation(error.to_string()))?;
        let allowed_runtime_agent_keys = projection.allowed_runtime_agent_keys_for_tool(&tool_ref);
        if !seen_ids.insert(tool.id.clone()) {
            return Err(crate::OpenBitFunError::Validation(format!(
                "Plugin tool id is duplicated in the registration batch: {}",
                tool.id
            )));
        }
        prepared.push((
            tool.registration_id.clone(),
            tool.id.clone(),
            tool.description.clone(),
            tool.parameters.clone(),
            allowed_runtime_agent_keys,
        ));
    }

    // Validate the complete generation before mutating the Tool mux. Once
    // registration starts, all remaining operations are infallible local
    // publication steps, so a malformed later entry cannot leave a partial
    // generation installed.
    let mut names = Vec::with_capacity(prepared.len());
    for (registration_id, id, description, parameters, allowed_runtime_agent_keys) in prepared {
        crate::agentic::tools::plugin_host_tool::register_workspace_tool(
            workspace_scope,
            workspace_id,
            runtime.clone(),
            host_generation,
            instance_id,
            generation_key,
            revision,
            &registration_id,
            &id,
            &description,
            parameters,
            config_fingerprint,
            allowed_runtime_agent_keys,
        )
        .await;
        log::debug!(
            "Plugin tool registration committed to Rust registry: workspace={}, instance_id={}, tool_id={}, registration_id={}",
            workspace_scope,
            instance_id,
            id,
            registration_id
        );
        names.push(id);
    }
    log::info!(
        "Plugin tool registration completed: workspace={}, instance_id={}, tool_count={}",
        workspace_scope,
        instance_id,
        names.len()
    );
    Ok(names)
}

fn resolve_host_entry(spec: PluginHostLaunchSpec) -> crate::OpenBitFunResult<PathBuf> {
    if let Some(entry) = std::env::var_os(spec.entry_env) {
        return absolutize_existing_entry(PathBuf::from(entry), spec);
    }
    let executable = std::env::current_exe().map_err(crate::OpenBitFunError::Io)?;
    let executable_directory = executable.parent().ok_or_else(|| {
        crate::OpenBitFunError::config(format!(
            "OpenBitFun executable has no parent directory: {}",
            executable.display()
        ))
    })?;
    let bundled_entries = bundled_host_entry_candidates(&executable, spec);
    if let Some(entry) = bundled_entries.iter().find(|entry| entry.is_file()) {
        return Ok(entry.clone());
    }
    let development_entry = development_host_entry(spec);
    if let Some(entry) = development_entry.filter(|entry| entry.is_file()) {
        return Ok(entry);
    }
    Err(crate::OpenBitFunError::NotFound(format!(
        "{} plugin host entry does not exist at {}. Set {} in development.",
        spec.runtime_name,
        bundled_entries
            .first()
            .map(|entry| entry.display().to_string())
            .unwrap_or_else(|| executable_directory.display().to_string()),
        spec.entry_env
    )))
}

fn bundled_host_entry_candidates(executable: &Path, spec: PluginHostLaunchSpec) -> Vec<PathBuf> {
    let Some(executable_directory) = executable.parent() else {
        return Vec::new();
    };
    let relative_entry = Path::new("resources")
        .join("ext-host")
        .join(spec.entry_filename);
    let mut candidates = vec![executable_directory.join(&relative_entry)];
    if let Some(parent) = executable_directory.parent() {
        candidates.push(parent.join("Resources").join(&relative_entry));
        if let Some(binary_name) = executable.file_name() {
            candidates.push(parent.join("lib").join(binary_name).join(&relative_entry));
            candidates.push(parent.join("share").join(binary_name).join(&relative_entry));
        }
    }
    candidates
}

fn development_host_entry(spec: PluginHostLaunchSpec) -> Option<PathBuf> {
    Path::new(env!("CARGO_MANIFEST_DIR"))
        .ancestors()
        .nth(4)
        .map(|repository_root| {
            repository_root
                .join("src")
                .join("apps")
                .join("extension-host")
                .join("dist")
                .join(spec.entry_filename)
        })
}

fn plugin_declaration(
    declaration: &crate::service::config::PluginDeclarationConfig,
) -> Option<PluginDeclaration> {
    use crate::service::config::PluginDeclarationConfig;

    let declaration = match declaration {
        PluginDeclarationConfig::Spec(spec) => PluginDeclaration {
            spec: spec.clone(),
            options: None,
            base_directory: None,
        },
        PluginDeclarationConfig::Detailed(details) => PluginDeclaration {
            spec: details.spec.clone(),
            options: details.options.clone(),
            base_directory: details.base_directory.clone(),
        },
    };
    if declaration.spec.trim().is_empty() {
        None
    } else {
        Some(declaration)
    }
}

fn plugin_config_fingerprint(
    config: &crate::service::config::GlobalConfig,
) -> crate::OpenBitFunResult<String> {
    let declarations = config
        .plugin
        .iter()
        .filter_map(plugin_declaration)
        .collect::<Vec<_>>();
    let bytes = serde_json::to_vec(&declarations)?;
    Ok(hex::encode(Sha256::digest(bytes)))
}

fn comparable_instance_directory(directory: &str) -> String {
    let comparable = directory.replace('\\', "/");
    #[cfg(windows)]
    let comparable = comparable.to_ascii_lowercase();
    comparable
}

fn absolutize_existing_entry(
    entry: PathBuf,
    spec: PluginHostLaunchSpec,
) -> crate::OpenBitFunResult<PathBuf> {
    let entry = if entry.is_absolute() {
        entry
    } else {
        std::env::current_dir()
            .map_err(crate::OpenBitFunError::Io)?
            .join(entry)
    };
    if !entry.is_file() {
        return Err(crate::OpenBitFunError::NotFound(format!(
            "{} plugin host entry does not exist: {}. Set {} in development.",
            spec.runtime_name,
            entry.display(),
            spec.entry_env
        )));
    }
    Ok(entry)
}

#[cfg(test)]
mod tests {
    use super::{
        bundled_host_entry_candidates, development_host_entry, initialize_configured_plugin_host,
        instance_directories_equal, plugin_activation_diagnostic, plugin_host_pty_ids_for_instance,
        plugin_host_pty_owned_by, push_plugin_host_diagnostic, register_plugin_host_pty,
        unregister_plugin_host_pty, PluginHostLaunchPolicy, PluginHostLaunchSpec,
        PluginHostStartup, MAX_PLUGIN_HOST_DIAGNOSTICS,
    };
    use std::path::Path;

    #[test]
    fn bun_runtime_selects_bun_command_and_entry() {
        let spec = PluginHostLaunchSpec::bun();

        assert_eq!(spec.default_command, "bun");
        assert_eq!(spec.entry_filename, "extension-host.js");
        assert_eq!(spec.command_env, "OPENBITFUN_BUN_COMMAND");
        assert_eq!(spec.entry_env, "OPENBITFUN_OPENCODE_BUN_HOST_ENTRY");
    }

    #[test]
    fn development_host_entry_is_owned_by_the_openbitfun_repository() {
        let spec = PluginHostLaunchSpec::bun();
        let entry = development_host_entry(spec).expect("OpenBitFun repository root");

        assert!(entry.ends_with(
            Path::new("src")
                .join("apps")
                .join("extension-host")
                .join("dist")
                .join("extension-host.js")
        ));
    }

    #[test]
    fn bundled_host_entry_supports_desktop_platform_layouts() {
        let entries = bundled_host_entry_candidates(
            Path::new("product/bin/openbitfun-desktop"),
            PluginHostLaunchSpec::bun(),
        );

        assert!(entries
            .iter()
            .any(|entry| entry.ends_with(Path::new("bin/resources/ext-host/extension-host.js"))));
        assert!(entries.iter().any(|entry| entry.ends_with(Path::new(
            "product/Resources/resources/ext-host/extension-host.js"
        ))));
    }

    #[tokio::test]
    async fn disabled_launch_policy_skips_host_initialization() {
        let status = initialize_configured_plugin_host(PluginHostLaunchPolicy::Disabled)
            .await
            .expect("disabled policy");

        assert_eq!(status, PluginHostStartup::Disabled);
    }

    #[test]
    fn instance_directory_matching_accepts_encoded_paths_and_rejects_siblings() {
        let directory = tempfile::tempdir().expect("temporary workspace");
        let workspace = directory.path().join("workspace with space");
        let sibling = directory.path().join("workspace with space-sibling");
        std::fs::create_dir_all(&workspace).expect("workspace directory");
        std::fs::create_dir_all(&sibling).expect("sibling directory");
        let encoded = urlencoding::encode(&workspace.to_string_lossy()).into_owned();

        assert!(instance_directories_equal(&encoded, &workspace));
        assert!(!instance_directories_equal(
            &sibling.to_string_lossy(),
            &workspace
        ));
    }

    #[tokio::test]
    async fn plugin_host_pty_ownership_is_instance_scoped() {
        let pty_id = format!("pty-test-{}", std::process::id());
        let first = format!("instance-first-{}", std::process::id());
        let second = format!("instance-second-{}", std::process::id());

        register_plugin_host_pty(&pty_id, &first).await;
        assert!(plugin_host_pty_owned_by(&pty_id, &first).await);
        assert!(!plugin_host_pty_owned_by(&pty_id, &second).await);
        assert_eq!(
            plugin_host_pty_ids_for_instance(&first).await,
            vec![pty_id.clone()]
        );
        assert!(unregister_plugin_host_pty(&pty_id, &first).await);
    }

    #[test]
    fn diagnostic_health_snapshot_retains_the_newest_entries() {
        let mut snapshot = Vec::new();
        for index in 0..=MAX_PLUGIN_HOST_DIAGNOSTICS {
            push_plugin_host_diagnostic(&mut snapshot, serde_json::json!({"index": index}));
        }

        assert_eq!(snapshot.len(), MAX_PLUGIN_HOST_DIAGNOSTICS);
        assert_eq!(snapshot.first().unwrap()["index"], 1);
        assert_eq!(
            snapshot.last().unwrap()["index"],
            MAX_PLUGIN_HOST_DIAGNOSTICS
        );
    }

    #[test]
    fn activation_failure_diagnostic_is_stable_and_workspace_scoped() {
        let event = plugin_activation_diagnostic(
            "session creation",
            Some("workspace-project"),
            "Bun executable was not found",
        );

        assert_eq!(event.diagnostic.code, "plugin.activation_failed");
        assert_eq!(event.diagnostic.severity.as_str(), "warning");
        assert_eq!(event.diagnostic.method.as_deref(), Some("session creation"));
        assert_eq!(
            event.diagnostic.data.as_ref().unwrap()["workspaceId"],
            "workspace-project"
        );
    }

    #[test]
    fn activation_failure_status_is_workspace_scoped_and_clearable() {
        let first = uuid::Uuid::new_v4().to_string();
        let second = uuid::Uuid::new_v4().to_string();
        super::record_configured_plugin_activation_failure(
            "session creation",
            Some(first.as_str()),
            "Bun executable was not found",
        );

        let first_status = super::configured_plugin_activation_failures(Some(first.as_str()));
        assert_eq!(first_status.len(), 1);
        assert!(first_status[0].contains("session creation"));
        assert!(super::configured_plugin_activation_failures(Some(second.as_str())).is_empty());

        super::clear_configured_plugin_activation_failure(Some(first.as_str()));
        assert!(super::configured_plugin_activation_failures(Some(first.as_str())).is_empty());
    }
}
