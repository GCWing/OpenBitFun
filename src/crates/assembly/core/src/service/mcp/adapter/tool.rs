//! MCP tool adapter
//!
//! Wraps MCP tools as implementations of OpenBitFun's `Tool` trait.

use crate::agentic::tools::framework::{
    DynamicToolInfo, PermissionIntent, Tool, ToolExposure, ToolRenderOptions, ToolResult,
    ToolUseContext, ValidationResult,
};
use crate::service::mcp::protocol::{MCPTool, MCPToolResult};
use crate::service::mcp::server::MCPConnection;
use crate::util::errors::OpenBitFunResult;
use async_trait::async_trait;
use log::{debug, error, info, warn};
use openbitfun_agent_tools::{
    build_mcp_tool_bridge_result, mcp_tool_bridge_dynamic_tool_info,
    mcp_tool_bridge_short_description, render_mcp_tool_bridge_rejected_message,
    render_mcp_tool_bridge_result_message, render_mcp_tool_bridge_use_message,
    validate_mcp_tool_bridge_input,
};
use openbitfun_services_integrations::mcp::adapter::{
    render_mcp_tool_result_for_assistant, MCPDynamicToolProvider, McpDynamicToolDescriptor,
};
use serde_json::Value;
use std::collections::{BTreeSet, HashMap};
use std::sync::Arc;
use std::sync::RwLock;

const MCP_TOOL_DEFAULT_EXPOSURE: ToolExposure = ToolExposure::Deferred;

fn dynamic_mcp_permission_intent(full_name: &str) -> PermissionIntent {
    PermissionIntent::new("mcp", vec![full_name.to_string()])
}

#[derive(Debug, Clone, Default, PartialEq, Eq)]
pub(crate) struct MCPWorkspaceToolRoute {
    pub active_external_server_ids: BTreeSet<String>,
    pub suppressed_native_server_ids: BTreeSet<String>,
}

#[derive(Debug, Default)]
pub(crate) struct MCPToolContextPolicy {
    routes: RwLock<HashMap<String, MCPWorkspaceToolRoute>>,
}

impl MCPToolContextPolicy {
    pub(crate) fn replace_route(&self, workspace_key: String, route: MCPWorkspaceToolRoute) {
        let mut routes = self.routes.write().expect("MCP route lock poisoned");
        if route == MCPWorkspaceToolRoute::default() {
            routes.remove(&workspace_key);
        } else {
            routes.insert(workspace_key, route);
        }
    }

    pub(crate) fn server_available_for_route(
        &self,
        server_id: &str,
        external_workspace_scope: Option<&str>,
        workspace_key: Option<&str>,
        remote: bool,
    ) -> bool {
        if let Some(expected_workspace) = external_workspace_scope {
            if remote || workspace_key != Some(expected_workspace) {
                return false;
            }
            return self
                .routes
                .read()
                .expect("MCP route lock poisoned")
                .get(expected_workspace)
                .is_some_and(|route| route.active_external_server_ids.contains(server_id));
        }
        if remote {
            return true;
        }
        let Some(workspace_key) = workspace_key else {
            return true;
        };
        !self
            .routes
            .read()
            .expect("MCP route lock poisoned")
            .get(workspace_key)
            .is_some_and(|route| route.suppressed_native_server_ids.contains(server_id))
    }
}

/// MCP tool wrapper that adapts an MCP tool to OpenBitFun's `Tool`.
struct MCPToolWrapper {
    server_id: String,
    external_workspace_scope: Option<String>,
    context_policy: Arc<MCPToolContextPolicy>,
    mcp_tool: MCPTool,
    connection: Arc<MCPConnection>,
    descriptor: McpDynamicToolDescriptor,
}

impl MCPToolWrapper {
    fn from_descriptor(
        server_id: String,
        external_workspace_scope: Option<String>,
        context_policy: Arc<MCPToolContextPolicy>,
        mcp_tool: MCPTool,
        connection: Arc<MCPConnection>,
        descriptor: McpDynamicToolDescriptor,
    ) -> Self {
        Self {
            server_id,
            external_workspace_scope,
            context_policy,
            mcp_tool,
            connection,
            descriptor,
        }
    }

    fn tool_title(&self) -> String {
        self.descriptor.title.clone()
    }

    fn is_blocked_in_context(&self, context: Option<&ToolUseContext>) -> bool {
        let workspace_key = crate::agentic::workspace::workspace_route_key(
            context.and_then(ToolUseContext::workspace_id),
        );
        !self.context_policy.server_available_for_route(
            &self.server_id,
            self.external_workspace_scope.as_deref(),
            Some(&workspace_key),
            context.is_some_and(ToolUseContext::is_remote),
        )
    }

    // Do not pre-truncate MCP output here. The shared tool-result storage policy
    // owns the model-visible budget and persists oversized results with a preview.
    fn render_mcp_result_for_assistant(tool_name: &str, result: &MCPToolResult) -> String {
        render_mcp_tool_result_for_assistant(tool_name, result, usize::MAX)
    }
}

#[async_trait]
impl Tool for MCPToolWrapper {
    fn name(&self) -> &str {
        // Use server_id as a prefix to avoid naming conflicts.
        // Example: mcp__github__search_repos
        &self.descriptor.full_name
    }

    async fn description(&self) -> OpenBitFunResult<String> {
        Ok(self.descriptor.description.clone())
    }

    fn short_description(&self) -> String {
        mcp_tool_bridge_short_description(
            self.mcp_tool.description.as_deref(),
            &self.descriptor.tool_info.server_name,
        )
    }

    fn default_exposure(&self) -> ToolExposure {
        MCP_TOOL_DEFAULT_EXPOSURE
    }

    fn input_schema(&self) -> Value {
        self.mcp_tool.input_schema.clone()
    }

    fn ui_resource_uri(&self) -> Option<String> {
        self.mcp_tool
            .meta
            .as_ref()
            .and_then(|m| m.ui.as_ref())
            .and_then(|u| u.resource_uri.clone())
    }

    fn dynamic_provider_id(&self) -> Option<&str> {
        Some(&self.descriptor.provider_id)
    }

    fn user_facing_name(&self) -> String {
        self.descriptor.user_facing_name.clone()
    }

    fn dynamic_tool_info(&self) -> Option<DynamicToolInfo> {
        Some(mcp_tool_bridge_dynamic_tool_info(&self.descriptor))
    }

    async fn is_enabled(&self) -> bool {
        true
    }

    async fn is_available_in_context(&self, context: Option<&ToolUseContext>) -> bool {
        !self.is_blocked_in_context(context)
    }

    fn is_readonly(&self) -> bool {
        self.descriptor.read_only
    }

    fn is_concurrency_safe(&self, _input: Option<&Value>) -> bool {
        self.is_readonly()
    }

    fn permission_intents(
        &self,
        _input: &Value,
        _context: &ToolUseContext,
    ) -> OpenBitFunResult<Vec<PermissionIntent>> {
        Ok(vec![dynamic_mcp_permission_intent(
            &self.descriptor.full_name,
        )])
    }

    async fn validate_input(
        &self,
        input: &Value,
        context: Option<&ToolUseContext>,
    ) -> ValidationResult {
        validate_mcp_tool_bridge_input(
            input,
            &self.descriptor.tool_info.server_name,
            self.is_blocked_in_context(context),
        )
    }

    fn render_result_for_assistant(&self, output: &Value) -> String {
        if let Ok(result) = serde_json::from_value::<MCPToolResult>(output.clone()) {
            return Self::render_mcp_result_for_assistant(&self.mcp_tool.name, &result);
        }

        "MCP tool execution completed".to_string()
    }

    fn render_tool_use_message(&self, input: &Value, _options: &ToolRenderOptions) -> String {
        render_mcp_tool_bridge_use_message(
            &self.descriptor.title,
            &self.descriptor.tool_info.server_name,
            input,
        )
    }

    fn render_tool_use_rejected_message(&self) -> String {
        render_mcp_tool_bridge_rejected_message(
            &self.descriptor.title,
            &self.descriptor.tool_info.server_name,
        )
    }

    fn render_tool_result_message(&self, output: &Value) -> String {
        render_mcp_tool_bridge_result_message(
            &self.descriptor.title,
            &self.render_result_for_assistant(output),
        )
    }

    async fn call_impl(
        &self,
        input: &Value,
        context: &ToolUseContext,
    ) -> OpenBitFunResult<Vec<ToolResult>> {
        if self.is_blocked_in_context(Some(context)) {
            return Err(crate::util::errors::OpenBitFunError::tool(format!(
                "MCP server '{}' is unavailable in the current workspace",
                self.descriptor.tool_info.server_name
            )));
        }

        info!(
            "Calling MCP tool: {} from server: {}",
            self.tool_title(),
            self.descriptor.tool_info.server_name
        );
        debug!(
            "Input: {}",
            serde_json::to_string_pretty(input).unwrap_or_else(|_| "invalid json".to_string())
        );

        let start = std::time::Instant::now();

        let result = self
            .connection
            .call_tool(&self.mcp_tool.name, Some(input.clone()))
            .await?;

        let elapsed = start.elapsed();
        debug!("MCP tool returned after {:?}", elapsed);

        let result_value = serde_json::to_value(&result)?;

        let result_for_assistant = self.render_result_for_assistant(&result_value);
        Ok(vec![build_mcp_tool_bridge_result(
            result_value,
            result_for_assistant,
        )])
    }
}

/// MCP tool adapter that manages multiple MCP tool wrappers.
pub struct MCPToolAdapter {
    tools: Vec<Arc<dyn Tool>>,
}

impl MCPToolAdapter {
    /// Creates a new tool adapter.
    pub fn new() -> Self {
        Self { tools: Vec::new() }
    }

    /// Loads tools from an MCP server.
    pub(crate) async fn load_tools_from_server(
        &mut self,
        server_id: &str,
        server_name: &str,
        connection: Arc<MCPConnection>,
        external_workspace_scope: Option<String>,
        context_policy: Arc<MCPToolContextPolicy>,
    ) -> OpenBitFunResult<()> {
        info!(
            "Loading tools from MCP server: {} (id={})",
            server_name, server_id
        );

        let provider = MCPDynamicToolProvider::new(server_id, server_name);
        let definitions = provider
            .load_tool_definitions(connection.as_ref())
            .await
            .map_err(|e| {
                error!("list_tools call failed: {}", e);
                crate::util::errors::OpenBitFunError::from(e)
            })?;

        info!(
            "Found {} MCP tool(s) from server {}",
            definitions.len(),
            server_name
        );

        if definitions.is_empty() {
            warn!("Server {} provided no tools", server_name);
            return Ok(());
        }

        for definition in definitions.into_iter() {
            let wrapper = Arc::new(MCPToolWrapper::from_descriptor(
                server_id.to_string(),
                external_workspace_scope.clone(),
                Arc::clone(&context_policy),
                definition.mcp_tool,
                connection.clone(),
                definition.descriptor,
            ));
            self.tools.push(wrapper);
        }

        info!(
            "Tool loading complete, adapter now has {} tool(s)",
            self.tools.len()
        );
        Ok(())
    }

    /// Returns all tools.
    pub fn get_tools(&self) -> &[Arc<dyn Tool>] {
        &self.tools
    }

    /// Clears all tools.
    pub fn clear(&mut self) {
        self.tools.clear();
    }
}

impl Default for MCPToolAdapter {
    fn default() -> Self {
        Self::new()
    }
}

#[cfg(test)]
mod tests {
    use super::{
        dynamic_mcp_permission_intent, MCPToolContextPolicy, MCPWorkspaceToolRoute, ToolExposure,
        MCP_TOOL_DEFAULT_EXPOSURE,
    };

    #[test]
    fn external_mcp_routes_are_workspace_scoped_and_remote_fail_closed() {
        let policy = MCPToolContextPolicy::default();
        policy.replace_route(
            "workspace-a".to_string(),
            MCPWorkspaceToolRoute {
                active_external_server_ids: ["external-a".to_string()].into_iter().collect(),
                suppressed_native_server_ids: ["native".to_string()].into_iter().collect(),
            },
        );

        assert!(policy.server_available_for_route(
            "external-a",
            Some("workspace-a"),
            Some("workspace-a"),
            false,
        ));
        assert!(!policy.server_available_for_route(
            "external-a",
            Some("workspace-a"),
            Some("workspace-b"),
            false,
        ));
        assert!(!policy.server_available_for_route("external-a", Some("workspace-a"), None, false,));
        assert!(!policy.server_available_for_route(
            "external-a",
            Some("workspace-a"),
            Some("workspace-a"),
            true,
        ));
        assert!(!policy.server_available_for_route("native", None, Some("workspace-a"), false,));
        assert!(policy.server_available_for_route("native", None, Some("workspace-b"), false,));
        assert!(policy.server_available_for_route("native", None, Some("workspace-a"), true,));
    }

    #[test]
    fn mcp_tool_wrapper_defaults_to_deferred_exposure() {
        assert_eq!(MCP_TOOL_DEFAULT_EXPOSURE, ToolExposure::Deferred);
    }

    #[test]
    fn dynamic_mcp_tools_use_the_full_server_tool_identity() {
        let intent = dynamic_mcp_permission_intent("mcp__github__search_repositories");

        assert_eq!(intent.action, "mcp");
        assert_eq!(
            intent.resources,
            ["mcp__github__search_repositories".to_string()]
        );
    }
}
