//! Read-only, mode/workspace-scoped MCP choices for chat composers.

use crate::agentic::agents::get_agent_registry;
use crate::agentic::tools::framework::ToolUseContext;
use crate::agentic::tools::registry::{get_global_tool_registry, ToolRef};
use crate::agentic::tools::tool_context_runtime::build_tool_description_context;
use crate::agentic::WorkspaceBinding;
#[cfg(feature = "remote-workspace")]
use crate::service::remote_ssh::workspace_state::lookup_remote_connection;
use serde::{Deserialize, Serialize};
use std::collections::{HashMap, HashSet};
use std::path::PathBuf;

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ChatMcpCatalogRequest {
    pub mode_id: String,
    #[serde(default)]
    pub workspace_path: Option<String>,
    #[serde(default)]
    pub remote_connection_id: Option<String>,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ChatMcpTool {
    pub name: String,
    pub server_id: String,
    pub server_name: String,
    pub tool_name: String,
    pub description: String,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ChatMcpCatalog {
    pub tools: Vec<ChatMcpTool>,
    pub mode_restricted: bool,
}

pub async fn build_chat_mcp_catalog(
    request: ChatMcpCatalogRequest,
) -> Result<ChatMcpCatalog, String> {
    // Never interpret a remote POSIX path on the controller. Remote workspace
    // MCP discovery needs a target-owned catalog before this entry can support it.
    if request
        .remote_connection_id
        .as_deref()
        .is_some_and(|id| !id.trim().is_empty())
    {
        return Err("MCP chat discovery is unsupported for remote workspaces".into());
    }
    let workspace_path = request
        .workspace_path
        .as_deref()
        .map(str::trim)
        .filter(|path| !path.is_empty());
    if let Some(path) = workspace_path {
        #[cfg(feature = "remote-workspace")]
        if lookup_remote_connection(path).await.is_some() {
            return Err("MCP chat discovery is unsupported for remote workspaces".into());
        }
        if !std::path::Path::new(path).is_absolute() {
            return Err("MCP chat discovery requires an absolute workspace path".into());
        }
    }
    let workspace = workspace_path.map(|path| WorkspaceBinding::new(None, PathBuf::from(path)));
    let mode_id = request.mode_id.trim();
    let registry = get_agent_registry();
    let root = workspace.as_ref().map(WorkspaceBinding::root_path);
    if registry.get_agent(mode_id, root).is_none() {
        return Err(format!("Agent mode is unavailable: {mode_id}"));
    }
    let policy = registry.get_agent_tool_policy(mode_id, root).await;
    let context = build_tool_description_context(
        mode_id,
        workspace.as_ref(),
        None,
        None,
        None,
        None,
        None,
        &HashMap::new(),
        &Default::default(),
    );
    let tools = get_global_tool_registry().read().await.get_all_tools();
    project_chat_mcp_catalog(&tools, &policy.allowed_tools, &context).await
}

async fn project_chat_mcp_catalog(
    snapshot: &[ToolRef],
    allowed_tools: &[String],
    context: &ToolUseContext,
) -> Result<ChatMcpCatalog, String> {
    let allowed: HashSet<&str> = allowed_tools.iter().map(String::as_str).collect();
    let mut tools = Vec::new();
    let mut mode_restricted = false;
    for tool in snapshot {
        let Some(mcp) = tool.dynamic_tool_info().and_then(|info| info.mcp) else {
            continue;
        };
        if !tool.is_enabled().await || !tool.is_available_in_context(Some(context)).await {
            continue;
        }
        if !allowed.contains(tool.name())
            || !context
                .runtime_tool_restrictions
                .is_tool_allowed(tool.name())
        {
            mode_restricted = true;
            continue;
        }
        tools.push(ChatMcpTool {
            name: tool.name().to_string(),
            server_id: mcp.server_id,
            server_name: mcp.server_name,
            tool_name: mcp.tool_name,
            description: tool
                .description()
                .await
                .map_err(|error| error.to_string())?,
        });
    }
    tools.sort_by(|a, b| a.server_name.cmp(&b.server_name).then(a.name.cmp(&b.name)));
    Ok(ChatMcpCatalog {
        mode_restricted: mode_restricted && tools.is_empty(),
        tools,
    })
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::agentic::agents::AgentRegistry;
    use crate::agentic::tools::framework::{
        DynamicMcpToolInfo, DynamicToolInfo, Tool, ToolExposure, ToolResult,
    };
    use crate::util::errors::OpenBitFunResult;
    use serde_json::{json, Value};
    use std::sync::Arc;

    struct CatalogTool {
        name: &'static str,
        available: bool,
    }

    #[async_trait::async_trait]
    impl Tool for CatalogTool {
        fn name(&self) -> &str {
            self.name
        }
        async fn description(&self) -> OpenBitFunResult<String> {
            Ok("Search documents".into())
        }
        fn short_description(&self) -> String {
            "Search documents".into()
        }
        fn input_schema(&self) -> Value {
            json!({"type": "object", "properties": {"query": {"type": "string"}}})
        }
        fn default_exposure(&self) -> ToolExposure {
            ToolExposure::Deferred
        }
        fn dynamic_tool_info(&self) -> Option<DynamicToolInfo> {
            Some(DynamicToolInfo {
                provider_id: "docs".into(),
                provider_kind: Some("mcp".into()),
                mcp: Some(DynamicMcpToolInfo {
                    server_id: "docs".into(),
                    server_name: "Docs".into(),
                    tool_name: "search".into(),
                }),
            })
        }
        async fn is_available_in_context(&self, _context: Option<&ToolUseContext>) -> bool {
            self.available
        }
        async fn call_impl(
            &self,
            _input: &Value,
            _context: &ToolUseContext,
        ) -> OpenBitFunResult<Vec<ToolResult>> {
            panic!("catalog must never execute a tool")
        }
    }

    fn context(mode: &str) -> ToolUseContext {
        build_tool_description_context(
            mode,
            None,
            None,
            None,
            None,
            None,
            None,
            &HashMap::new(),
            &Default::default(),
        )
    }

    #[tokio::test]
    async fn chat_catalog_matches_the_models_deferred_mcp_inventory() {
        let snapshot: Vec<ToolRef> = vec![Arc::new(CatalogTool {
            name: "mcp__docs__search",
            available: true,
        })];
        let allowed = vec!["mcp__docs__search".to_string()];
        let context = context("Standard");
        let catalog = project_chat_mcp_catalog(&snapshot, &allowed, &context)
            .await
            .unwrap();
        let manifest = openbitfun_agent_tools::resolve_contextual_tool_manifest(
            &snapshot,
            &allowed,
            &Default::default(),
            &context,
            "GetToolSpec",
        )
        .await;
        assert_eq!(
            catalog
                .tools
                .iter()
                .map(|tool| tool.name.clone())
                .collect::<Vec<_>>(),
            manifest.deferred_tool_names
        );
        assert!(!catalog.mode_restricted);
        let wire = serde_json::to_value(&catalog).unwrap();
        assert_eq!(wire["tools"][0]["serverName"], "Docs");
        assert_eq!(wire["tools"][0]["description"], "Search documents");
        assert!(wire["tools"][0].get("inputSchema").is_none());
    }

    #[tokio::test]
    async fn unavailable_workspace_tools_and_empty_catalog_are_not_mode_restrictions() {
        let snapshot: Vec<ToolRef> = vec![Arc::new(CatalogTool {
            name: "mcp__other_workspace__search",
            available: false,
        })];
        for snapshot in [&snapshot[..], &[][..]] {
            let catalog = project_chat_mcp_catalog(snapshot, &[], &context("Standard"))
                .await
                .unwrap();
            assert!(catalog.tools.is_empty());
            assert!(!catalog.mode_restricted);
        }
    }

    #[tokio::test]
    async fn minimal_keeps_its_mcp_policy_and_the_picker_explains_the_exclusion() {
        let registry = AgentRegistry::new();
        let minimal = registry.get_agent("Minimal", None).unwrap();
        assert!(!minimal.include_dynamic_mcp_tools());
        assert!(registry
            .get_agent("Standard", None)
            .unwrap()
            .include_dynamic_mcp_tools());
        let snapshot: Vec<ToolRef> = vec![Arc::new(CatalogTool {
            name: "mcp__docs__search",
            available: true,
        })];
        let catalog =
            project_chat_mcp_catalog(&snapshot, &minimal.default_tools(), &context("Minimal"))
                .await
                .unwrap();
        assert!(catalog.tools.is_empty());
        assert!(catalog.mode_restricted);
    }

    #[tokio::test]
    async fn remote_requests_are_rejected_before_reading_local_registries() {
        let request: ChatMcpCatalogRequest = serde_json::from_value(json!({
            "modeId": "Standard", "workspacePath": "/srv/project", "remoteConnectionId": "ssh-peer",
        }))
        .unwrap();
        assert!(build_chat_mcp_catalog(request)
            .await
            .unwrap_err()
            .contains("unsupported for remote workspaces"));
    }

    #[test]
    fn request_tolerates_optional_and_future_fields() {
        let request: ChatMcpCatalogRequest =
            serde_json::from_value(json!({"modeId": "Standard", "futureField": true})).unwrap();
        assert!(request.workspace_path.is_none());
        assert!(request.remote_connection_id.is_none());
    }
}
