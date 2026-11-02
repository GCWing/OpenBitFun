//! MCP dynamic tool metadata and result rendering helpers.

use crate::mcp::protocol::{MCPTool, MCPToolResult, MCPToolResultContent};
use crate::mcp::MCPRuntimeResult;
use async_trait::async_trait;
use openbitfun_agent_tools::{
    build_mcp_tool_bridge_definition, McpToolBridgeBehaviorHints, McpToolBridgeDefinition,
    McpToolBridgeDefinitionInput,
};
use serde_json::Value;

pub type McpDynamicToolDescriptor = McpToolBridgeDefinition;

#[derive(Debug, Clone)]
pub struct MCPDynamicToolDefinition {
    pub mcp_tool: MCPTool,
    pub descriptor: McpDynamicToolDescriptor,
}

#[async_trait]
pub trait MCPToolCatalogClient: Send + Sync {
    async fn list_mcp_tools(&self) -> MCPRuntimeResult<Vec<MCPTool>>;
}

#[derive(Debug, Clone)]
pub struct MCPDynamicToolProvider {
    server_id: String,
    server_name: String,
}

impl MCPDynamicToolProvider {
    pub fn new(server_id: impl Into<String>, server_name: impl Into<String>) -> Self {
        Self {
            server_id: server_id.into(),
            server_name: server_name.into(),
        }
    }

    pub async fn load_tool_definitions(
        &self,
        client: &dyn MCPToolCatalogClient,
    ) -> MCPRuntimeResult<Vec<MCPDynamicToolDefinition>> {
        Ok(client
            .list_mcp_tools()
            .await?
            .into_iter()
            .map(|mcp_tool| {
                let descriptor =
                    build_mcp_tool_descriptor(&self.server_id, &self.server_name, &mcp_tool);
                MCPDynamicToolDefinition {
                    mcp_tool,
                    descriptor,
                }
            })
            .collect())
    }
}

fn tool_title(tool: &MCPTool) -> String {
    tool.annotations
        .as_ref()
        .and_then(|annotations| annotations.title.clone())
        .or_else(|| tool.title.clone())
        .unwrap_or_else(|| tool.name.clone())
}

pub fn build_mcp_tool_descriptor(
    server_id: &str,
    server_name: &str,
    tool: &MCPTool,
) -> McpDynamicToolDescriptor {
    let title = tool_title(tool);
    let annotations = tool.annotations.as_ref();
    build_mcp_tool_bridge_definition(McpToolBridgeDefinitionInput {
        server_id,
        server_name,
        tool_name: &tool.name,
        title: &title,
        description: tool.description.as_deref(),
        behavior_hints: McpToolBridgeBehaviorHints {
            read_only: annotations
                .and_then(|annotations| annotations.read_only_hint)
                .unwrap_or(false),
            destructive: annotations
                .and_then(|annotations| annotations.destructive_hint)
                .unwrap_or(false),
            open_world: annotations
                .and_then(|annotations| annotations.open_world_hint)
                .unwrap_or(false),
        },
    })
}

fn truncate_for_assistant(text: String, max_result_text_chars: usize) -> String {
    let char_count = text.chars().count();
    if char_count <= max_result_text_chars {
        return text;
    }

    let truncated: String = text.chars().take(max_result_text_chars).collect();
    format!(
        "{}\n[Result truncated: {} of {} characters shown]",
        truncated, max_result_text_chars, char_count
    )
}

pub fn render_mcp_tool_result_for_assistant(
    tool_name: &str,
    result: &MCPToolResult,
    max_result_text_chars: usize,
) -> String {
    let rendered_content = result.content.as_ref().map(|contents| {
        contents
            .iter()
            .map(|c| match c {
                MCPToolResultContent::Text { text } => text.clone(),
                MCPToolResultContent::Image { mime_type, .. } => {
                    format!("[Image: {}]", mime_type)
                }
                MCPToolResultContent::Audio { mime_type, .. } => {
                    format!("[Audio: {}]", mime_type)
                }
                MCPToolResultContent::ResourceLink { uri, name, .. } => name
                    .as_ref()
                    .map_or_else(|| uri.clone(), |n| format!("[Resource: {} ({})]", n, uri)),
                MCPToolResultContent::Resource { resource } => {
                    format!("[Resource: {}]", resource.uri)
                }
            })
            .collect::<Vec<_>>()
            .join("\n")
    });

    if result.is_error {
        let error_message = format!("Error executing MCP tool '{}'", tool_name);
        let details = rendered_content
            .filter(|content| !content.trim().is_empty())
            .or_else(|| result.structured_content.as_ref().map(ToString::to_string));
        return match details {
            Some(details) => truncate_for_assistant(
                format!("{}\n{}", error_message, details),
                max_result_text_chars,
            ),
            None => error_message,
        };
    }

    if let Some(rendered) = rendered_content {
        return truncate_for_assistant(rendered, max_result_text_chars);
    }

    if let Some(structured_content) = result.structured_content.as_ref() {
        return truncate_for_assistant(structured_content.to_string(), max_result_text_chars);
    }

    "MCP tool execution completed".to_string()
}

/// Render a result payload that does not match [`MCPToolResult`].
///
/// Unknown content block types from a newer server are the usual cause. Such a
/// payload must not be reported as a completed call, because the tool pipeline
/// reads the same `isError` flag to decide the result status; a failed call keeps
/// the server's own payload visible instead. The private `_meta` extension is
/// never part of what the model sees.
pub fn render_unparsed_mcp_tool_result_for_assistant(
    raw: &Value,
    max_result_text_chars: usize,
) -> String {
    if raw.get("isError").and_then(Value::as_bool) != Some(true) {
        return "MCP tool execution completed".to_string();
    }

    let mut payload = raw.clone();
    if let Some(object) = payload.as_object_mut() {
        object.remove("_meta");
    }

    truncate_for_assistant(
        format!("MCP tool execution failed: {payload}"),
        max_result_text_chars,
    )
}

#[cfg(test)]
mod tests {
    use super::{render_mcp_tool_result_for_assistant, MCPToolResult, MCPToolResultContent};

    #[test]
    fn mcp_tool_result_rendering_does_not_pretruncate_before_storage_policy() {
        let text = "x".repeat(12_001);
        let result = MCPToolResult {
            content: Some(vec![MCPToolResultContent::Text { text: text.clone() }]),
            is_error: false,
            structured_content: None,
            meta: None,
        };

        let rendered = render_mcp_tool_result_for_assistant("large_output", &result, usize::MAX);

        assert_eq!(rendered, text);
        assert!(!rendered.contains("[Result truncated:"));
    }
}
