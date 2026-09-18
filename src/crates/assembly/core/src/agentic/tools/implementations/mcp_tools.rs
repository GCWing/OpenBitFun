//! Built-in MCP resource/prompt tools.

use crate::agentic::tools::framework::{
    PermissionIntent, Tool, ToolExposure, ToolRenderOptions, ToolResult, ToolUseContext,
    ValidationResult,
};
use crate::service::mcp::adapter::PromptAdapter;
use crate::service::mcp::get_global_mcp_service;
use crate::service::mcp::protocol::{MCPPrompt, MCPResource, MCPResourceContent};
use crate::service::mcp::MCPServerManager;
use crate::util::errors::{OpenBitFunError, OpenBitFunResult};
use async_trait::async_trait;
use serde_json::{json, Value};
use std::collections::{HashMap, HashSet};
use std::sync::Arc;

const DEFAULT_RENDER_CHAR_LIMIT: usize = 32_000;

fn tool_error(message: impl Into<String>) -> OpenBitFunError {
    OpenBitFunError::tool(message.into())
}

fn truncate_text(text: &str, max_chars: usize) -> (String, bool) {
    let truncated = text.chars().count() > max_chars;
    let rendered = if truncated {
        text.chars().take(max_chars).collect()
    } else {
        text.to_string()
    };
    (rendered, truncated)
}

async fn get_mcp_server_manager() -> OpenBitFunResult<Arc<MCPServerManager>> {
    get_global_mcp_service()
        .map(|service| service.server_manager())
        .ok_or_else(|| tool_error("MCP service is not initialized"))
}

async fn list_resources_for_server(
    manager: &Arc<MCPServerManager>,
    server_id: &str,
    refresh: bool,
) -> OpenBitFunResult<Vec<MCPResource>> {
    let mut resources = manager.get_cached_resources(server_id).await;
    if refresh || resources.is_empty() {
        manager.refresh_server_resource_catalog(server_id).await?;
        resources = manager.get_cached_resources(server_id).await;
    }
    Ok(resources)
}

async fn list_prompts_for_server(
    manager: &Arc<MCPServerManager>,
    server_id: &str,
    refresh: bool,
) -> OpenBitFunResult<Vec<MCPPrompt>> {
    let mut prompts = manager.get_cached_prompts(server_id).await;
    if refresh || prompts.is_empty() {
        manager.refresh_server_prompt_catalog(server_id).await?;
        prompts = manager.get_cached_prompts(server_id).await;
    }
    Ok(prompts)
}

async fn ensure_mcp_server_available_for_context(
    manager: &Arc<MCPServerManager>,
    server_id: &str,
    context: &ToolUseContext,
) -> OpenBitFunResult<()> {
    if !manager
        .server_available_for_context(server_id, context.workspace_id(), context.is_remote())
        .await
    {
        return Err(tool_error(format!(
            "MCP server is unavailable in the current workspace: {}",
            server_id
        )));
    }
    manager
        .get_connection(server_id)
        .await
        .ok_or_else(|| tool_error(format!("MCP server not connected: {}", server_id)))?;

    Ok(())
}

fn validate_required_string(input: &Value, field_name: &str) -> ValidationResult {
    match input.get(field_name).and_then(|value| value.as_str()) {
        Some(value) if !value.trim().is_empty() => ValidationResult::default(),
        Some(_) => ValidationResult {
            result: false,
            message: Some(format!("{} cannot be empty", field_name)),
            error_code: Some(400),
            meta: None,
        },
        None => ValidationResult {
            result: false,
            message: Some(format!("{} is required", field_name)),
            error_code: Some(400),
            meta: None,
        },
    }
}

fn mcp_input_string<'a>(input: &'a Value, field_name: &str) -> &'a str {
    input
        .get(field_name)
        .and_then(Value::as_str)
        .map(str::trim)
        .filter(|value| !value.is_empty())
        .unwrap_or("unknown")
}

fn mcp_permission_intent(resource: String) -> Vec<PermissionIntent> {
    vec![PermissionIntent::new("mcp", vec![resource])]
}

fn render_resource_catalog(resources: &[MCPResource]) -> String {
    if resources.is_empty() {
        return "No MCP resources available.".to_string();
    }

    resources
        .iter()
        .map(|resource| {
            let mut lines = vec![format!(
                "- {} ({})",
                resource.title.as_deref().unwrap_or(&resource.name),
                resource.uri
            )];
            if resource.title.as_deref() != Some(resource.name.as_str()) {
                lines.push(format!("  Name: {}", resource.name));
            }
            if let Some(description) = &resource.description {
                lines.push(format!("  Description: {}", description));
            }
            if let Some(mime_type) = &resource.mime_type {
                lines.push(format!("  MIME type: {}", mime_type));
            }
            if let Some(size) = resource.size {
                lines.push(format!("  Size: {} bytes", size));
            }
            lines.join("\n")
        })
        .collect::<Vec<_>>()
        .join("\n\n")
}

fn render_resource_contents(contents: &[MCPResourceContent], max_chars: usize) -> String {
    let mut rendered = String::new();
    let mut remaining = max_chars;
    let mut truncated_any = false;

    for (index, content) in contents.iter().enumerate() {
        if index > 0 {
            rendered.push_str("\n\n---\n\n");
        }

        rendered.push_str(&format!("Resource URI: {}", content.uri));
        if let Some(mime_type) = &content.mime_type {
            rendered.push_str(&format!("\nMIME type: {}", mime_type));
        }

        if let Some(text) = &content.content {
            let slice_limit = remaining.max(1);
            let (text_chunk, truncated) = truncate_text(text, slice_limit);
            rendered.push_str("\n\n");
            rendered.push_str(&text_chunk);
            truncated_any |= truncated;
            remaining = remaining.saturating_sub(text_chunk.chars().count());
        } else if content.blob.is_some() {
            rendered.push_str("\n\n[Binary resource content omitted]");
        } else {
            rendered.push_str("\n\n[Empty resource content]");
        }

        if remaining == 0 {
            truncated_any = true;
            break;
        }
    }

    if truncated_any {
        rendered
            .push_str("\n\n[Output truncated after reaching the MCP resource tool size limit.]");
    }

    rendered
}

fn render_prompt_catalog(prompts: &[MCPPrompt]) -> String {
    if prompts.is_empty() {
        return "No MCP prompts available.".to_string();
    }

    prompts
        .iter()
        .map(|prompt| {
            let mut lines = vec![format!(
                "- {}",
                prompt.title.as_deref().unwrap_or(&prompt.name)
            )];
            if prompt.title.as_deref() != Some(prompt.name.as_str()) {
                lines.push(format!("  Name: {}", prompt.name));
            }
            if let Some(description) = &prompt.description {
                lines.push(format!("  Description: {}", description));
            }
            if let Some(arguments) = &prompt.arguments {
                if !arguments.is_empty() {
                    let args = arguments
                        .iter()
                        .map(|argument| {
                            let required = if argument.required {
                                "required"
                            } else {
                                "optional"
                            };
                            match &argument.description {
                                Some(description) => {
                                    format!("{} ({}, {})", argument.name, required, description)
                                }
                                None => format!("{} ({})", argument.name, required),
                            }
                        })
                        .collect::<Vec<_>>()
                        .join(", ");
                    lines.push(format!("  Arguments: {}", args));
                }
            }
            lines.join("\n")
        })
        .collect::<Vec<_>>()
        .join("\n\n")
}

pub struct ListMCPResourcesTool;

impl Default for ListMCPResourcesTool {
    fn default() -> Self {
        Self::new()
    }
}

impl ListMCPResourcesTool {
    pub fn new() -> Self {
        Self
    }
}

#[async_trait]
impl Tool for ListMCPResourcesTool {
    fn name(&self) -> &str {
        "ListMCPResources"
    }

    async fn description(&self) -> OpenBitFunResult<String> {
        Ok("Lists MCP resources exposed by a connected MCP server. Use this before ReadMCPResource when you need to inspect available MCP-hosted files, docs, or structured context.".to_string())
    }

    fn short_description(&self) -> String {
        "List MCP resources exposed by a connected MCP server.".to_string()
    }

    fn default_exposure(&self) -> ToolExposure {
        ToolExposure::Deferred
    }

    fn input_schema(&self) -> Value {
        json!({
            "type": "object",
            "properties": {
                "server_id": {
                    "type": "string",
                    "description": "The MCP server ID to inspect."
                },
                "refresh": {
                    "type": "boolean",
                    "description": "When true, refresh the server catalog before returning resources.",
                    "default": false
                }
            },
            "required": ["server_id"],
            "additionalProperties": false
        })
    }

    fn is_readonly(&self) -> bool {
        true
    }

    fn is_concurrency_safe(&self, _input: Option<&Value>) -> bool {
        true
    }

    fn permission_intents(
        &self,
        input: &Value,
        _context: &ToolUseContext,
    ) -> OpenBitFunResult<Vec<PermissionIntent>> {
        Ok(mcp_permission_intent(format!(
            "{}:list_resources",
            mcp_input_string(input, "server_id")
        )))
    }

    async fn validate_input(
        &self,
        input: &Value,
        _context: Option<&ToolUseContext>,
    ) -> ValidationResult {
        validate_required_string(input, "server_id")
    }

    fn render_tool_use_message(&self, input: &Value, options: &ToolRenderOptions) -> String {
        let server_id = input
            .get("server_id")
            .and_then(|value| value.as_str())
            .unwrap_or("unknown");
        if options.verbose {
            format!("Listing MCP resources from server: {}", server_id)
        } else {
            format!("List MCP resources from {}", server_id)
        }
    }

    async fn call_impl(
        &self,
        input: &Value,
        context: &ToolUseContext,
    ) -> OpenBitFunResult<Vec<ToolResult>> {
        let server_id = input
            .get("server_id")
            .and_then(|value| value.as_str())
            .ok_or_else(|| tool_error("server_id is required"))?;
        let refresh = input
            .get("refresh")
            .and_then(|value| value.as_bool())
            .unwrap_or(false);

        let manager = get_mcp_server_manager().await?;
        ensure_mcp_server_available_for_context(&manager, server_id, context).await?;
        let resources = list_resources_for_server(&manager, server_id, refresh).await?;
        let count = resources.len();
        let rendered = render_resource_catalog(&resources);

        Ok(vec![ToolResult::ok(
            json!({
                "server_id": server_id,
                "resources": resources,
                "count": count,
            }),
            Some(rendered),
        )])
    }
}

pub struct ReadMCPResourceTool {
    max_render_chars: usize,
}

impl Default for ReadMCPResourceTool {
    fn default() -> Self {
        Self::new()
    }
}

impl ReadMCPResourceTool {
    pub fn new() -> Self {
        Self {
            max_render_chars: DEFAULT_RENDER_CHAR_LIMIT,
        }
    }
}

#[async_trait]
impl Tool for ReadMCPResourceTool {
    fn name(&self) -> &str {
        "ReadMCPResource"
    }

    async fn description(&self) -> OpenBitFunResult<String> {
        Ok("Reads a specific MCP resource by URI from a connected MCP server. Use ListMCPResources first if you do not already know the resource URI.".to_string())
    }

    fn short_description(&self) -> String {
        "Read a specific MCP resource by URI from a connected MCP server.".to_string()
    }

    fn default_exposure(&self) -> ToolExposure {
        ToolExposure::Deferred
    }

    fn input_schema(&self) -> Value {
        json!({
            "type": "object",
            "properties": {
                "server_id": {
                    "type": "string",
                    "description": "The MCP server ID that owns the resource."
                },
                "uri": {
                    "type": "string",
                    "description": "The full MCP resource URI to read."
                }
            },
            "required": ["server_id", "uri"],
            "additionalProperties": false
        })
    }

    fn is_readonly(&self) -> bool {
        true
    }

    fn is_concurrency_safe(&self, _input: Option<&Value>) -> bool {
        true
    }

    fn permission_intents(
        &self,
        input: &Value,
        _context: &ToolUseContext,
    ) -> OpenBitFunResult<Vec<PermissionIntent>> {
        Ok(mcp_permission_intent(format!(
            "{}:{}",
            mcp_input_string(input, "server_id"),
            mcp_input_string(input, "uri")
        )))
    }

    async fn validate_input(
        &self,
        input: &Value,
        _context: Option<&ToolUseContext>,
    ) -> ValidationResult {
        let server_validation = validate_required_string(input, "server_id");
        if !server_validation.result {
            return server_validation;
        }
        validate_required_string(input, "uri")
    }

    fn render_tool_use_message(&self, input: &Value, options: &ToolRenderOptions) -> String {
        let uri = input
            .get("uri")
            .and_then(|value| value.as_str())
            .unwrap_or("unknown");
        if options.verbose {
            format!("Reading MCP resource: {}", uri)
        } else {
            format!("Read MCP resource {}", uri)
        }
    }

    async fn call_impl(
        &self,
        input: &Value,
        context: &ToolUseContext,
    ) -> OpenBitFunResult<Vec<ToolResult>> {
        let server_id = input
            .get("server_id")
            .and_then(|value| value.as_str())
            .ok_or_else(|| tool_error("server_id is required"))?;
        let uri = input
            .get("uri")
            .and_then(|value| value.as_str())
            .ok_or_else(|| tool_error("uri is required"))?;

        let manager = get_mcp_server_manager().await?;
        ensure_mcp_server_available_for_context(&manager, server_id, context).await?;
        let connection = manager
            .get_connection(server_id)
            .await
            .ok_or_else(|| tool_error(format!("MCP server not connected: {}", server_id)))?;
        let result = connection.read_resource(uri).await?;
        let content_count = result.contents.len();
        let rendered = render_resource_contents(&result.contents, self.max_render_chars);

        Ok(vec![ToolResult::ok(
            json!({
                "server_id": server_id,
                "uri": uri,
                "contents": result.contents,
                "content_count": content_count,
            }),
            Some(rendered),
        )])
    }
}

pub struct ListMCPPromptsTool;

impl Default for ListMCPPromptsTool {
    fn default() -> Self {
        Self::new()
    }
}

impl ListMCPPromptsTool {
    pub fn new() -> Self {
        Self
    }
}

#[async_trait]
impl Tool for ListMCPPromptsTool {
    fn name(&self) -> &str {
        "ListMCPPrompts"
    }

    async fn description(&self) -> OpenBitFunResult<String> {
        Ok("Lists MCP prompts exposed by a connected MCP server. Use this before GetMCPPrompt when you need reusable server-provided prompt templates.".to_string())
    }

    fn short_description(&self) -> String {
        "List MCP prompts exposed by a connected MCP server.".to_string()
    }

    fn default_exposure(&self) -> ToolExposure {
        ToolExposure::Deferred
    }

    fn input_schema(&self) -> Value {
        json!({
            "type": "object",
            "properties": {
                "server_id": {
                    "type": "string",
                    "description": "The MCP server ID to inspect."
                },
                "refresh": {
                    "type": "boolean",
                    "description": "When true, refresh the server catalog before returning prompts.",
                    "default": false
                }
            },
            "required": ["server_id"],
            "additionalProperties": false
        })
    }

    fn is_readonly(&self) -> bool {
        true
    }

    fn is_concurrency_safe(&self, _input: Option<&Value>) -> bool {
        true
    }

    fn permission_intents(
        &self,
        input: &Value,
        _context: &ToolUseContext,
    ) -> OpenBitFunResult<Vec<PermissionIntent>> {
        Ok(mcp_permission_intent(format!(
            "{}:list_prompts",
            mcp_input_string(input, "server_id")
        )))
    }

    async fn validate_input(
        &self,
        input: &Value,
        _context: Option<&ToolUseContext>,
    ) -> ValidationResult {
        validate_required_string(input, "server_id")
    }

    fn render_tool_use_message(&self, input: &Value, options: &ToolRenderOptions) -> String {
        let server_id = input
            .get("server_id")
            .and_then(|value| value.as_str())
            .unwrap_or("unknown");
        if options.verbose {
            format!("Listing MCP prompts from server: {}", server_id)
        } else {
            format!("List MCP prompts from {}", server_id)
        }
    }

    async fn call_impl(
        &self,
        input: &Value,
        context: &ToolUseContext,
    ) -> OpenBitFunResult<Vec<ToolResult>> {
        let server_id = input
            .get("server_id")
            .and_then(|value| value.as_str())
            .ok_or_else(|| tool_error("server_id is required"))?;
        let refresh = input
            .get("refresh")
            .and_then(|value| value.as_bool())
            .unwrap_or(false);

        let manager = get_mcp_server_manager().await?;
        ensure_mcp_server_available_for_context(&manager, server_id, context).await?;
        let prompts = list_prompts_for_server(&manager, server_id, refresh).await?;
        let count = prompts.len();
        let rendered = render_prompt_catalog(&prompts);

        Ok(vec![ToolResult::ok(
            json!({
                "server_id": server_id,
                "prompts": prompts,
                "count": count,
            }),
            Some(rendered),
        )])
    }
}

pub struct GetMCPPromptTool {
    max_render_chars: usize,
}

impl Default for GetMCPPromptTool {
    fn default() -> Self {
        Self::new()
    }
}

impl GetMCPPromptTool {
    pub fn new() -> Self {
        Self {
            max_render_chars: DEFAULT_RENDER_CHAR_LIMIT,
        }
    }
}

#[async_trait]
impl Tool for GetMCPPromptTool {
    fn name(&self) -> &str {
        "GetMCPPrompt"
    }

    async fn description(&self) -> OpenBitFunResult<String> {
        Ok("Fetches a named MCP prompt template from a connected MCP server and renders it into plain text for the model. Pass prompt arguments when the server requires them.".to_string())
    }

    fn short_description(&self) -> String {
        "Fetch and render a named MCP prompt template from a connected MCP server.".to_string()
    }

    fn default_exposure(&self) -> ToolExposure {
        ToolExposure::Deferred
    }

    fn input_schema(&self) -> Value {
        json!({
            "type": "object",
            "properties": {
                "server_id": {
                    "type": "string",
                    "description": "The MCP server ID that owns the prompt."
                },
                "name": {
                    "type": "string",
                    "description": "The MCP prompt name."
                },
                "arguments": {
                    "type": "object",
                    "description": "Optional string arguments for the prompt template.",
                    "additionalProperties": {
                        "type": "string"
                    }
                }
            },
            "required": ["server_id", "name"],
            "additionalProperties": false
        })
    }

    fn is_readonly(&self) -> bool {
        true
    }

    fn is_concurrency_safe(&self, _input: Option<&Value>) -> bool {
        true
    }

    fn permission_intents(
        &self,
        input: &Value,
        _context: &ToolUseContext,
    ) -> OpenBitFunResult<Vec<PermissionIntent>> {
        Ok(mcp_permission_intent(format!(
            "{}:prompt:{}",
            mcp_input_string(input, "server_id"),
            mcp_input_string(input, "name")
        )))
    }

    async fn validate_input(
        &self,
        input: &Value,
        _context: Option<&ToolUseContext>,
    ) -> ValidationResult {
        let server_validation = validate_required_string(input, "server_id");
        if !server_validation.result {
            return server_validation;
        }

        let name_validation = validate_required_string(input, "name");
        if !name_validation.result {
            return name_validation;
        }

        if let Some(arguments) = input.get("arguments") {
            let Some(object) = arguments.as_object() else {
                return ValidationResult {
                    result: false,
                    message: Some("arguments must be an object".to_string()),
                    error_code: Some(400),
                    meta: None,
                };
            };

            let invalid_keys = object
                .iter()
                .filter_map(|(key, value)| (!value.is_string()).then_some(key.clone()))
                .collect::<HashSet<_>>();
            if !invalid_keys.is_empty() {
                return ValidationResult {
                    result: false,
                    message: Some(format!(
                        "arguments values must be strings: {}",
                        invalid_keys.into_iter().collect::<Vec<_>>().join(", ")
                    )),
                    error_code: Some(400),
                    meta: None,
                };
            }
        }

        ValidationResult::default()
    }

    fn render_tool_use_message(&self, input: &Value, options: &ToolRenderOptions) -> String {
        let name = input
            .get("name")
            .and_then(|value| value.as_str())
            .unwrap_or("unknown");
        if options.verbose {
            format!("Fetching MCP prompt: {}", name)
        } else {
            format!("Get MCP prompt {}", name)
        }
    }

    async fn call_impl(
        &self,
        input: &Value,
        context: &ToolUseContext,
    ) -> OpenBitFunResult<Vec<ToolResult>> {
        let server_id = input
            .get("server_id")
            .and_then(|value| value.as_str())
            .ok_or_else(|| tool_error("server_id is required"))?;
        let name = input
            .get("name")
            .and_then(|value| value.as_str())
            .ok_or_else(|| tool_error("name is required"))?;

        let arguments = input.get("arguments").and_then(|value| {
            value.as_object().map(|object| {
                object
                    .iter()
                    .filter_map(|(key, value)| {
                        value
                            .as_str()
                            .map(|string| (key.clone(), string.to_string()))
                    })
                    .collect::<HashMap<String, String>>()
            })
        });

        let manager = get_mcp_server_manager().await?;
        ensure_mcp_server_available_for_context(&manager, server_id, context).await?;
        let connection = manager
            .get_connection(server_id)
            .await
            .ok_or_else(|| tool_error(format!("MCP server not connected: {}", server_id)))?;
        let result = connection.get_prompt(name, arguments.clone()).await?;
        let prompt_text =
            PromptAdapter::to_system_prompt(&crate::service::mcp::protocol::MCPPromptContent {
                name: name.to_string(),
                messages: result.messages.clone(),
            });
        let (rendered_text, truncated) = truncate_text(&prompt_text, self.max_render_chars);
        let mut rendered = rendered_text;
        if truncated {
            rendered
                .push_str("\n\n[Output truncated after reaching the MCP prompt tool size limit.]");
        }

        Ok(vec![ToolResult::ok(
            json!({
                "server_id": server_id,
                "name": name,
                "arguments": arguments,
                "description": result.description,
                "messages": result.messages,
                "prompt_text": prompt_text,
            }),
            Some(rendered),
        )])
    }
}

#[cfg(test)]
mod tests {
    use super::{GetMCPPromptTool, ListMCPPromptsTool, ListMCPResourcesTool, ReadMCPResourceTool};
    use crate::agentic::tools::framework::{Tool, ToolUseContext};
    use serde_json::json;

    #[test]
    fn builtin_mcp_tools_emit_server_scoped_v2_resources() {
        let context = ToolUseContext::for_tool_listing(None, None);
        let list_resources = ListMCPResourcesTool::new();
        let read_resource = ReadMCPResourceTool::new();
        let list_prompts = ListMCPPromptsTool::new();
        let get_prompt = GetMCPPromptTool::new();
        let cases: Vec<(&dyn Tool, serde_json::Value, &str)> = vec![
            (
                &list_resources,
                json!({ "server_id": "docs" }),
                "docs:list_resources",
            ),
            (
                &read_resource,
                json!({ "server_id": "docs", "uri": "docs://permission/v2" }),
                "docs:docs://permission/v2",
            ),
            (
                &list_prompts,
                json!({ "server_id": "docs" }),
                "docs:list_prompts",
            ),
            (
                &get_prompt,
                json!({ "server_id": "docs", "name": "review" }),
                "docs:prompt:review",
            ),
        ];

        for (tool, input, expected_resource) in cases {
            let intents = tool
                .permission_intents(&input, &context)
                .expect("permission intent");
            assert_eq!(intents.len(), 1, "{}", tool.name());
            assert_eq!(intents[0].action, "mcp", "{}", tool.name());
            assert_eq!(
                intents[0].resources,
                [expected_resource.to_string()],
                "{}",
                tool.name()
            );
        }
    }
}
