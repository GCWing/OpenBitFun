//! MCP adapter helpers that do not depend on the OpenBitFun agent runtime.

mod context;
mod prompt;
mod resource;
mod tool;

pub use context::{MCPContextEnhancer, MCPContextEnhancerConfig};
pub use prompt::PromptAdapter;
pub use resource::ResourceAdapter;
pub use tool::{
    build_mcp_tool_descriptor, render_mcp_tool_result_for_assistant,
    render_unparsed_mcp_tool_result_for_assistant, MCPDynamicToolDefinition,
    MCPDynamicToolProvider, MCPToolCatalogClient, McpDynamicToolDescriptor,
};
