//! Server bootstrap - initializes all core services.
//!
//! Mirrors the Desktop app's init sequence without any Tauri dependency.

use openbitfun_core::agentic::{agents, coordination, system, tools};
use openbitfun_core::infrastructure::ai::AIClientFactory;
use openbitfun_core::infrastructure::try_get_path_manager_arc;
use openbitfun_core::product_runtime::{
    ensure_product_dialog_scheduler, CoreProductEventQueueOwner, CoreRuntimeServicesProvider,
};
use openbitfun_core::runtime_ownership::CoreRuntimeOwnership;
use openbitfun_core::service::{config, filesystem, mcp, token_usage, workspace};
use std::sync::Arc;
use tokio::sync::RwLock;

/// Shared application state for the server (mirrors Desktop's AppState).
///
/// Several fields are stored to keep the corresponding services alive (they
/// register global singletons during `initialize`), not because they are read
/// again after initialization.
#[allow(dead_code)]
pub(crate) struct ServerAppState {
    pub ai_client_factory: Arc<AIClientFactory>,
    pub workspace_service: Arc<workspace::WorkspaceService>,
    /// Workspace record this Host activated at startup (opened from
    /// `--workspace` or restored). Identity is the record ID; `root_path` is
    /// only an IO operand.
    pub initial_workspace: Option<workspace::WorkspaceInfo>,
    pub workspace_id: Arc<RwLock<Option<String>>>,
    pub config_service: Arc<config::ConfigService>,
    pub filesystem_service: Arc<filesystem::FileSystemService>,
    pub agent_registry: Arc<agents::AgentRegistry>,
    pub mcp_service: Option<Arc<mcp::MCPService>>,
    pub token_usage_service: Arc<token_usage::TokenUsageService>,
    pub coordinator: Arc<coordination::ConversationCoordinator>,
    pub scheduler: Arc<coordination::DialogScheduler>,
    pub agent_event_queue_owner: CoreProductEventQueueOwner,
    pub tool_registry_snapshot: Arc<Vec<Arc<dyn tools::framework::Tool>>>,
    pub start_time: std::time::Instant,
}

/// Initialize all core services and return the shared server state.
///
/// The optional `workspace` path, when provided, is opened automatically.
pub(crate) async fn initialize(workspace: Option<String>) -> anyhow::Result<Arc<ServerAppState>> {
    log::info!("Initializing OpenBitFun server core services");

    system::select_agentic_system_profile(system::DeliveryProfile::ProductFull)?;

    // 1. Global config
    config::initialize_global_config().await?;
    let config_service = config::get_global_config_service().await?;

    // Initialize the global I18nService so server-mode bot/remote-connect
    // consumers observe the same runtime locale lifecycle as Desktop.
    if let Err(e) =
        openbitfun_core::service::i18n::initialize_global_i18n_service(Some(config_service.clone()))
            .await
    {
        log::warn!(
            "Failed to initialize global I18nService in server mode: {}",
            e
        );
    }

    // 2. AI client factory
    AIClientFactory::initialize_global().await?;
    let ai_client_factory = AIClientFactory::get_global().await?;

    // 3. Agentic system
    let path_manager = try_get_path_manager_arc()?;
    let runtime_ownership = Arc::new(CoreRuntimeOwnership::embedded(
        path_manager.as_ref(),
        "server",
    ));
    let agentic_system = system::init_agentic_system_for_profile_with_runtime_ownership(
        system::DeliveryProfile::ProductFull,
        runtime_ownership,
    )
    .await?;
    agentic_system
        .coordinator
        .set_terminal_port(CoreRuntimeServicesProvider::terminal_port());
    agentic_system
        .coordinator
        .set_remote_exec_port(CoreRuntimeServicesProvider::remote_exec_port());

    let scheduler = ensure_product_dialog_scheduler(&agentic_system);
    let coordinator = agentic_system.coordinator.clone();
    let event_queue = agentic_system.event_queue.clone();
    let agent_event_queue_owner = CoreProductEventQueueOwner::new(event_queue);
    let token_usage_service = agentic_system.token_usage_service.clone();

    // Cron service
    let cron_service = openbitfun_core::service::cron::CronService::new(
        path_manager.clone(),
        coordinator.clone(),
        scheduler.clone(),
    )
    .await?;
    openbitfun_core::service::cron::set_global_cron_service(cron_service.clone());
    coordinator.subscribe_internal(
        "cron_jobs".to_string(),
        openbitfun_core::service::cron::CronEventSubscriber::new(cron_service.clone()),
    );
    cron_service.start();

    // Function agents
    let _ = openbitfun_core::function_agents::git_func_agent::GitFunctionAgent::new(
        ai_client_factory.clone(),
    );
    // 4. Services
    let workspace_service = Arc::new(workspace::WorkspaceService::new().await?);
    workspace::set_global_workspace_service(workspace_service.clone());
    let filesystem_service = Arc::new(filesystem::FileSystemServiceFactory::create_default());

    let agent_registry = agents::get_agent_registry();
    let tool_registry = tools::registry::get_global_tool_registry();

    let mcp_service = match mcp::MCPService::new(config_service.clone()) {
        Ok(service) => {
            let service = Arc::new(service);
            mcp::set_global_mcp_service(service.clone());
            Some(service)
        }
        Err(e) => {
            log::warn!("Failed to initialize MCP service: {}", e);
            None
        }
    };

    // Tool registry snapshot
    let tool_registry_snapshot = {
        let lock = tool_registry.read().await;
        Arc::new(lock.get_all_tools())
    };

    // 5. Open workspace if specified
    let initial_workspace = if let Some(ws_path) = workspace {
        let path = std::path::PathBuf::from(&ws_path);
        let info = coordinator
            .create_local_workspace_with_runtime_ownership(workspace_service.as_ref(), path)
            .await
            .map_err(|error| {
                anyhow::anyhow!("Failed to open workspace '{}': {}", ws_path, error)
            })?;
        log::info!(
            "Workspace opened: name={}, path={}",
            info.name,
            info.root_path.display()
        );
        Some(info)
    } else {
        // Try to restore last workspace
        workspace_service.get_current_workspace().await
    };

    if let Err(error) = openbitfun_core::plugin_host::initialize_configured_plugin_host(
        openbitfun_core::plugin_host::PluginHostLaunchPolicy::Enabled,
    )
    .await
    {
        openbitfun_core::plugin_host::report_configured_plugin_activation_failure(
            "server startup",
            initial_workspace.as_ref().map(|record| record.id.as_str()),
            error,
        )
        .await;
    }
    if let Some(workspace) = initial_workspace.as_ref() {
        if let Err(error) = openbitfun_core::plugin_host::ensure_configured_plugin_instance(
            openbitfun_core::plugin_host::PluginHostLaunchPolicy::Enabled,
            &workspace.id,
        )
        .await
        {
            openbitfun_core::plugin_host::report_configured_plugin_activation_failure(
                "server workspace activation",
                Some(workspace.id.as_str()),
                error,
            )
            .await;
        }
    }
    let initial_workspace_id = initial_workspace
        .as_ref()
        .map(|workspace| workspace.id.clone());

    let state = Arc::new(ServerAppState {
        ai_client_factory,
        workspace_service,
        initial_workspace,
        workspace_id: Arc::new(RwLock::new(initial_workspace_id)),
        config_service,
        filesystem_service,
        agent_registry,
        mcp_service,
        token_usage_service,
        coordinator,
        scheduler,
        agent_event_queue_owner,
        tool_registry_snapshot,
        start_time: std::time::Instant::now(),
    });

    log::info!("OpenBitFun server core services initialized");
    Ok(state)
}
