#![allow(non_snake_case)]
#![recursion_limit = "256"]
//! Compatibility facade and full product runtime assembly.
//!
//! New implementation code should live in owner crates under `src/crates/*`.
//! This crate re-exports legacy paths and wires the full OpenBitFun product runtime.

#[cfg(feature = "agent-runtime")]
pub mod agentic; // Agent system, tool system, and product runtime orchestration
#[cfg(feature = "external-sources")]
pub mod external_hook_import;
#[cfg(feature = "external-sources")]
pub mod external_hooks;
#[cfg(all(test, feature = "external-sources"))]
mod external_hooks_tests;
#[cfg(feature = "external-sources")]
mod external_mcp;
#[cfg(feature = "external-sources")]
pub mod external_mcp_import;
#[cfg(all(test, feature = "external-sources"))]
mod external_mcp_tests;
#[cfg(feature = "external-sources")]
pub mod external_session_import;
#[cfg(feature = "external-sources")]
pub mod external_sources;
#[cfg(feature = "external-sources")]
mod external_subagents;
#[cfg(feature = "external-sources")]
mod external_tools;
#[cfg(feature = "function-agents")]
pub mod function_agents; // Function-based agents
pub mod infrastructure; // AI clients, storage, logging, events
#[cfg(feature = "external-sources")]
mod instruction_sources;
#[cfg(feature = "legacy-migration")]
pub mod legacy_migration;
#[cfg(feature = "tools-miniapp")]
pub mod miniapp; // AI-generated instant apps (Zero-Dialect Runtime)
#[cfg(feature = "agent-runtime")]
pub mod native_hooks;
#[cfg(all(test, feature = "agent-runtime"))]
mod native_hooks_tests;
#[cfg(feature = "opencode-plugin-host")]
mod plugin_capability_publication;
#[cfg(feature = "opencode-plugin-host")]
mod plugin_hook_bridge;
#[cfg(feature = "opencode-plugin-host")]
pub mod plugin_host;
#[cfg(feature = "opencode-plugin-host")]
mod plugin_host_http;
#[cfg(feature = "opencode-plugin-host")]
mod plugin_host_http_routes;
#[cfg(feature = "plugin-runtime")]
pub mod plugin_runtime;
#[cfg(feature = "plugin-source")]
pub mod plugin_source;
#[cfg(feature = "agent-runtime")]
pub mod product_assembly;
#[cfg(all(test, feature = "product-full"))]
mod product_assembly_tests;
#[cfg(any(feature = "function-agents", feature = "tools-miniapp"))]
pub(crate) mod product_domain_runtime;
#[cfg(feature = "agent-runtime")]
pub mod product_runtime;
#[cfg(feature = "agent-runtime")]
pub mod runtime_ownership;
#[cfg(all(test, feature = "agent-runtime"))]
mod runtime_ownership_tests;
pub mod service; // Workspace, Config, FileSystem, Terminal, Git
#[cfg(feature = "agent-runtime")]
pub(crate) mod service_agent_runtime;
pub mod util; // General types, errors, helper functions

#[cfg(feature = "remote-connect")]
pub use openbitfun_services_integrations::remote_connect::{
    LocalModelsDevCatalogs, RemoteModelCatalog as AIModelCatalog,
};

#[cfg(feature = "agent-runtime")]
pub fn get_builtin_ai_provider_catalog() -> openbitfun_core_types::ProviderCatalog {
    infrastructure::ai::provider_catalog::resolve_builtin_provider_catalog(
        None,
        "openbitfun-builtin".to_string(),
        openbitfun_core_types::ProviderCatalogSource::OpenBitFun,
    )
}

/// Model catalog for an in-process local reader.
///
/// This machine's own models.dev projections are included: TUI/app-server
/// projections and the plugin host render them from the same process. A catalog
/// that crosses a machine boundary must use [`get_remote_model_catalog`]
/// instead, or a peer would ship a multi-MiB copy of the public catalog.
#[cfg(feature = "remote-connect")]
pub async fn get_ai_model_catalog() -> Result<AIModelCatalog, String> {
    service_agent_runtime::CoreServiceAgentRuntime::load_local_model_catalog(None).await
}

/// Model catalog for a caller on another machine: configured models, defaults
/// and the session selection, with the models.dev bodies left out.
///
/// Every host keeps its own refreshed models.dev snapshot, so a controller
/// enriches its own Model Settings surface locally through
/// [`get_local_models_dev_catalogs`] instead of pulling the peer's copy.
#[cfg(feature = "remote-connect")]
pub async fn get_remote_model_catalog() -> Result<AIModelCatalog, String> {
    service_agent_runtime::CoreServiceAgentRuntime::load_remote_model_catalog(None).await
}

/// This machine's own models.dev projections, for a controller that renders
/// Model Settings while a peer is selected.
#[cfg(feature = "remote-connect")]
pub async fn get_local_models_dev_catalogs() -> Result<LocalModelsDevCatalogs, String> {
    service_agent_runtime::CoreServiceAgentRuntime::load_local_models_dev_catalogs().await
}

#[cfg(feature = "model-catalog")]
pub async fn project_ai_model_reasoning_catalog(
    request: openbitfun_core_types::ReasoningCatalogProjectionRequest,
) -> openbitfun_core_types::ReasoningCatalogProjection {
    infrastructure::ai::reasoning_catalog::project_reasoning_catalog_request(request).await
}

#[cfg(feature = "model-catalog")]
pub async fn get_models_dev_catalog_status() -> openbitfun_core_types::ModelsDevCatalogStatus {
    infrastructure::ai::reasoning_catalog::get_models_dev_catalog_status().await
}

#[cfg(feature = "model-catalog")]
pub async fn refresh_models_dev_catalog_now(
) -> Result<openbitfun_core_types::ModelsDevRefreshResult, String> {
    infrastructure::ai::reasoning_catalog::refresh_models_dev_catalog_now().await
}

// Export main types
pub use openbitfun_runtime_ports as runtime_ports;
pub use util::errors::*;
pub use util::types::*;

// Export service layer components
pub use service::config::{ConfigManager, ConfigService};
#[cfg(feature = "workspace-runtime")]
pub use service::workspace::{WorkspaceManager, WorkspaceProvider, WorkspaceService};

// Export infrastructure components
#[cfg(feature = "ai-adapter-runtime")]
pub use infrastructure::ai::AIClient;
#[cfg(feature = "runtime-services")]
pub use infrastructure::events::BackendEventManager;

// Export Agentic service core types
#[cfg(feature = "agent-runtime")]
pub use agentic::{
    core::{Message, Session},
    // NOTE: agentic::core::DialogTurn / ModelRound used to be re-exported here
    // but were dead code (never persisted, never read). On-disk shape lives in
    // service::session::{DialogTurnData, ModelRoundData}; lifecycle state is
    // tracked through SessionState + TurnStatus.
    events::{AgenticEvent, EventQueue, EventRouter},
    execution::{ExecutionEngine, StreamProcessor},
    tools::{Tool, ToolPipeline},
};

// Export ToolRegistry separately.
#[cfg(feature = "agent-runtime")]
pub use agentic::tools::registry::ToolRegistry;

// Version information
pub const VERSION: &str = env!("CARGO_PKG_VERSION");
pub const CORE_NAME: &str = "OpenBitFun Core";
