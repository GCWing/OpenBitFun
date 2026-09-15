//! Agentic system assembly shared by CLI, ACP, and other hosts.

use std::sync::Arc;
use std::time::Duration;

use anyhow::Result;
use log::info;

use crate::agentic::coordination;
use crate::agentic::events;
use crate::agentic::execution;
use crate::agentic::goal_mode::ThreadGoalTokenSubscriber;
use crate::agentic::persistence;
use crate::agentic::session;
use crate::agentic::tools;
use crate::infrastructure::ai::AIClientFactory;
use crate::infrastructure::try_get_path_manager_arc;
use crate::runtime_ownership::CoreRuntimeOwnership;
use crate::service::token_usage::{
    set_global_token_usage_service, TokenUsageService, TokenUsageSubscriber,
};
pub use openbitfun_product_capabilities::DeliveryProfile;

fn session_manager_config_for_profile(
    delivery_profile: DeliveryProfile,
) -> session::SessionManagerConfig {
    let mut config = session::SessionManagerConfig::default();
    if delivery_profile == DeliveryProfile::Sdk {
        config.session_idle_timeout = Duration::MAX;
    }
    config
}

/// Agentic runtime state shared by host adapters.
#[derive(Clone)]
pub struct AgenticSystem {
    pub coordinator: Arc<coordination::ConversationCoordinator>,
    pub event_queue: Arc<events::EventQueue>,
    pub token_usage_service: Arc<TokenUsageService>,
}

/// Initialize the full compatibility Agent Runtime and register the global
/// coordinator.
///
/// Narrow product hosts must use `init_agentic_system_for_profile` so their
/// explicit assembly plan remains the only capability authority.
#[cfg(feature = "product-full")]
pub async fn init_agentic_system() -> Result<AgenticSystem> {
    init_agentic_system_for_profile(DeliveryProfile::ProductFull).await
}

/// Select the process-wide Agent delivery profile before any service reads the
/// global tool registry.
///
/// Product composition roots call this before configuration canonicalization;
/// later initialization verifies the same profile and rejects replacement.
pub fn select_agentic_system_profile(delivery_profile: DeliveryProfile) -> Result<()> {
    crate::agentic::agents::initialize_global_agent_registry_for_profile(delivery_profile)
        .map_err(anyhow::Error::msg)?;
    tools::registry::initialize_global_tool_registry_for_profile(delivery_profile)
        .map(|_| ())
        .map_err(anyhow::Error::msg)
}

/// Initialize the single process-wide agentic runtime for one product profile.
pub async fn init_agentic_system_for_profile(
    delivery_profile: DeliveryProfile,
) -> Result<AgenticSystem> {
    let path_manager = try_get_path_manager_arc()?;
    let runtime_ownership = Arc::new(CoreRuntimeOwnership::embedded(
        path_manager.as_ref(),
        "embedded-host",
    ));
    init_agentic_system_for_profile_with_runtime_ownership(delivery_profile, runtime_ownership)
        .await
}

/// Initializes one product runtime with an explicitly selected ownership
/// deployment. First-party fixed-workspace hosts use this before protocol/UI
/// readiness; public Agent Runtime contracts remain unchanged.
pub async fn init_agentic_system_for_profile_with_runtime_ownership(
    delivery_profile: DeliveryProfile,
    runtime_ownership: Arc<CoreRuntimeOwnership>,
) -> Result<AgenticSystem> {
    info!("Initializing agentic system for profile {delivery_profile}");

    select_agentic_system_profile(delivery_profile)?;

    let _ai_client_factory = AIClientFactory::get_global().await?;

    let event_queue = Arc::new(events::EventQueue::new(Default::default()));
    let event_router = Arc::new(events::EventRouter::new());

    let path_manager = try_get_path_manager_arc()?;
    let persistence_manager = Arc::new(persistence::PersistenceManager::new(path_manager.clone())?);
    let token_usage_service = Arc::new(TokenUsageService::new(path_manager.clone()).await?);
    set_global_token_usage_service(token_usage_service.clone());

    let context_store = Arc::new(session::SessionContextStore::new());
    let context_compressor = Arc::new(session::ContextCompressor::new());

    let session_manager = Arc::new(session::SessionManager::new(
        context_store,
        persistence_manager,
        session_manager_config_for_profile(delivery_profile),
    ));

    event_router.subscribe_internal(
        "token_usage".to_string(),
        Arc::new(TokenUsageSubscriber::new(token_usage_service.clone())),
    );
    event_router.subscribe_internal(
        "session_context_usage".to_string(),
        Arc::new(session::SessionContextUsageSubscriber::new(
            session_manager.clone(),
        )),
    );
    event_router.subscribe_internal(
        "thread_goal_tokens".to_string(),
        Arc::new(ThreadGoalTokenSubscriber),
    );

    let tool_registry = tools::registry::get_global_tool_registry();
    let tool_state_manager = Arc::new(tools::pipeline::ToolStateManager::new(event_queue.clone()));
    let permission_request_manager =
        crate::product_runtime::core_permission_request_manager().map_err(anyhow::Error::msg)?;
    let tool_pipeline = Arc::new(
        tools::pipeline::ToolPipeline::new(tool_registry, tool_state_manager, None)
            .with_permission_request_manager(permission_request_manager),
    );

    let stream_processor = Arc::new(execution::StreamProcessor::new(event_queue.clone()));
    let round_executor = Arc::new(execution::RoundExecutor::new(
        stream_processor,
        event_queue.clone(),
        tool_pipeline.clone(),
    ));

    let execution_config = execution::execution_engine_config_from_global_config().await;
    let execution_engine = Arc::new(execution::ExecutionEngine::new(
        round_executor,
        event_queue.clone(),
        session_manager.clone(),
        context_compressor,
        execution_config,
    ));

    let coordinator = Arc::new(coordination::ConversationCoordinator::new(
        session_manager,
        execution_engine,
        tool_pipeline,
        event_queue.clone(),
        event_router.clone(),
        runtime_ownership,
    ));

    coordination::ConversationCoordinator::set_global(coordinator.clone());

    let mut internal_event_rx = event_queue.subscribe();
    let internal_event_router = event_router.clone();
    tokio::spawn(async move {
        loop {
            match internal_event_rx.recv().await {
                Ok(envelope) => {
                    if let Err(error) = internal_event_router.route(envelope).await {
                        log::warn!("Internal agentic event routing failed: {}", error);
                    }
                }
                Err(tokio::sync::broadcast::error::RecvError::Lagged(skipped)) => {
                    log::warn!("Internal agentic event router lagged by {} events", skipped);
                }
                Err(tokio::sync::broadcast::error::RecvError::Closed) => break,
            }
        }
    });

    info!("Agentic system initialization complete");

    Ok(AgenticSystem {
        coordinator,
        event_queue,
        token_usage_service,
    })
}

#[cfg(test)]
mod tests {
    use super::{session_manager_config_for_profile, DeliveryProfile};
    use std::time::Duration;

    #[test]
    fn sdk_profile_keeps_attached_sessions_loaded_until_the_host_releases_them() {
        assert_eq!(
            session_manager_config_for_profile(DeliveryProfile::Sdk).session_idle_timeout,
            Duration::MAX
        );
        assert_eq!(
            session_manager_config_for_profile(DeliveryProfile::ProductFull).session_idle_timeout,
            Duration::from_secs(3600)
        );
    }
}
