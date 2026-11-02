//! MCP (Model Context Protocol) service module
//!
//! Provides standardized MCP protocol support for connecting external context providers and
//! services.
//!
//! ## Module structure
//! - `protocol`: MCP protocol layer (JSON-RPC 2.0 communication)
//! - `server`: MCP server management (processes, connections, registry)
//! - `adapter`: Adapter layer (Resource/Prompt/Tool adapters)
//! - `config`: MCP configuration management

pub mod adapter;
pub mod auth;
pub mod config;
pub mod control;
pub mod protocol;
pub mod server;
mod tool_info;
mod tool_name;

use std::sync::Arc;
use std::sync::OnceLock;

// Stable public surface for the MCP service.
pub use protocol::{
    MCPCapability, MCPMessage, MCPNotification, MCPProtocolVersion, MCPRequest, MCPResponse,
    MCPServerInfo,
};

pub use server::{
    MCPConnection, MCPConnectionPool, MCPServerConfig, MCPServerManager, MCPServerStatus,
    MCPServerTimeouts, MCPServerTransport, MCPServerType,
};

pub use adapter::{
    ContextEnhancer, MCPContextProvider, MCPToolAdapter, PromptAdapter, ResourceAdapter,
};

pub use config::{ConfigLocation, MCPConfigService};
pub use tool_info::McpToolInfo;
pub use tool_name::{
    build_mcp_tool_name, normalize_name_for_mcp, MCP_TOOL_DELIMITER, MCP_TOOL_PREFIX,
};

/// MCP service interface.
pub struct MCPService {
    server_manager: Arc<MCPServerManager>,
    config_service: Arc<MCPConfigService>,
    context_provider: Arc<MCPContextProvider>,
    configuration_mutation: tokio::sync::Mutex<()>,
}

impl MCPService {
    /// Creates a new MCP service instance.
    pub fn new(
        config_service: Arc<crate::service::config::ConfigService>,
    ) -> crate::util::errors::OpenBitFunResult<Self> {
        let mcp_config_service = Arc::new(MCPConfigService::new(config_service)?);
        // Keep service startup compatible when strict path initialization is
        // unavailable; OAuth operations retain the existing lazy error path.
        let oauth_data_dir = crate::infrastructure::try_get_path_manager_arc()
            .ok()
            .map(|manager| manager.user_data_dir());
        let server_manager = Arc::new(MCPServerManager::assemble(
            mcp_config_service.clone(),
            oauth_data_dir,
        ));
        let context_provider = Arc::new(MCPContextProvider::new(server_manager.clone()));

        Ok(Self {
            server_manager,
            config_service: mcp_config_service,
            context_provider,
            configuration_mutation: tokio::sync::Mutex::new(()),
        })
    }

    /// Returns the server manager.
    pub fn server_manager(&self) -> Arc<MCPServerManager> {
        self.server_manager.clone()
    }

    /// Returns the context provider.
    pub fn context_provider(&self) -> Arc<MCPContextProvider> {
        self.context_provider.clone()
    }

    /// Returns the configuration service.
    pub fn config_service(&self) -> Arc<MCPConfigService> {
        self.config_service.clone()
    }
}

static GLOBAL_MCP_SERVICE: OnceLock<Arc<MCPService>> = OnceLock::new();

/// Stores the global MCP service for code paths that cannot receive it via DI yet.
pub fn set_global_mcp_service(service: Arc<MCPService>) {
    let _ = GLOBAL_MCP_SERVICE.set(service);
}

/// Returns the global MCP service if it has been initialized.
pub fn get_global_mcp_service() -> Option<Arc<MCPService>> {
    GLOBAL_MCP_SERVICE.get().cloned()
}
