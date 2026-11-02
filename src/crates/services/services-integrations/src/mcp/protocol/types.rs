//! MCP protocol type definitions
//!
//! Core data structures that follow the Model Context Protocol specification.

use serde::{Deserialize, Serialize};
use serde_json::Value;
use std::collections::HashMap;

/// MCP protocol version (string format, follows the MCP spec).
///
/// Aligned with VSCode: "2025-11-25"
/// Reference: https://spec.modelcontextprotocol.io/
pub type MCPProtocolVersion = String;

/// Returns the default MCP protocol version.
pub fn default_protocol_version() -> MCPProtocolVersion {
    "2025-11-25".to_string()
}

/// MCP resources capability.
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Default)]
#[serde(rename_all = "camelCase")]
pub struct ResourcesCapability {
    #[serde(default)]
    pub subscribe: bool,
    #[serde(default)]
    pub list_changed: bool,
}

/// MCP prompts capability.
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Default)]
#[serde(rename_all = "camelCase")]
pub struct PromptsCapability {
    #[serde(default)]
    pub list_changed: bool,
}

/// MCP tools capability.
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Default)]
#[serde(rename_all = "camelCase")]
pub struct ToolsCapability {
    #[serde(default)]
    pub list_changed: bool,
}

/// MCP capability declaration (follows the latest MCP spec).
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct MCPCapability {
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub resources: Option<ResourcesCapability>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub prompts: Option<PromptsCapability>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub tools: Option<ToolsCapability>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub logging: Option<Value>,
}

impl Default for MCPCapability {
    fn default() -> Self {
        Self {
            resources: Some(ResourcesCapability::default()),
            prompts: Some(PromptsCapability::default()),
            tools: Some(ToolsCapability::default()),
            logging: None,
        }
    }
}

/// MCP server info.
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct MCPServerInfo {
    pub name: String,
    pub version: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub description: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub vendor: Option<String>,
}

/// Icon for display in UIs (2025-11-25 spec). sizes may be string or string[] for compatibility.
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct MCPResourceIcon {
    pub src: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub mime_type: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub sizes: Option<Value>, // string or ["48x48"] per spec
}

/// Annotations for resources/templates (2025-11-25 spec).
#[derive(Debug, Clone, Serialize, Deserialize, Default)]
#[serde(rename_all = "camelCase")]
pub struct MCPAnnotations {
    #[serde(skip_serializing_if = "Option::is_none")]
    pub audience: Option<Vec<String>>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub priority: Option<f64>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub last_modified: Option<String>,
}

/// MCP resource definition (2025-11-25 spec).
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct MCPResource {
    pub uri: String,
    pub name: String,
    /// Human-readable title for display (2025-11-25).
    #[serde(skip_serializing_if = "Option::is_none")]
    pub title: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub description: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub mime_type: Option<String>,
    /// Icons for UI display (2025-11-25).
    #[serde(skip_serializing_if = "Option::is_none")]
    pub icons: Option<Vec<MCPResourceIcon>>,
    /// Size in bytes, if known (2025-11-25).
    #[serde(skip_serializing_if = "Option::is_none")]
    pub size: Option<u64>,
    /// Annotations: audience, priority, lastModified (2025-11-25).
    #[serde(skip_serializing_if = "Option::is_none")]
    pub annotations: Option<MCPAnnotations>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub metadata: Option<HashMap<String, Value>>,
}

/// Content Security Policy configuration for MCP App UI (aligned with VSCode/MCP Apps spec).
#[derive(Debug, Clone, Serialize, Deserialize, Default)]
#[serde(rename_all = "camelCase")]
pub struct McpUiResourceCsp {
    /// Origins for network requests (fetch/XHR/WebSocket).
    #[serde(skip_serializing_if = "Option::is_none")]
    pub connect_domains: Option<Vec<String>>,
    /// Origins for static resources (scripts, images, styles, fonts).
    #[serde(skip_serializing_if = "Option::is_none")]
    pub resource_domains: Option<Vec<String>>,
    /// Origins for nested iframes (frame-src directive).
    #[serde(skip_serializing_if = "Option::is_none")]
    pub frame_domains: Option<Vec<String>>,
    /// Allowed base URIs for the document (base-uri directive).
    #[serde(skip_serializing_if = "Option::is_none")]
    pub base_uri_domains: Option<Vec<String>>,
}

/// Sandbox permissions requested by the UI resource (aligned with VSCode/MCP Apps spec).
#[derive(Debug, Clone, Serialize, Deserialize, Default)]
#[serde(rename_all = "camelCase")]
pub struct McpUiResourcePermissions {
    /// Request camera access.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub camera: Option<serde_json::Value>,
    /// Request microphone access.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub microphone: Option<serde_json::Value>,
    /// Request geolocation access.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub geolocation: Option<serde_json::Value>,
    /// Request clipboard write access.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub clipboard_write: Option<serde_json::Value>,
}

/// UI metadata within _meta (MCP Apps spec: _meta.ui.csp, _meta.ui.permissions).
#[derive(Debug, Clone, Serialize, Deserialize, Default)]
#[serde(rename_all = "camelCase")]
pub struct McpUiMeta {
    /// Content Security Policy configuration.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub csp: Option<McpUiResourceCsp>,
    /// Sandbox permissions.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub permissions: Option<McpUiResourcePermissions>,
}

/// Resource content _meta field (MCP Apps spec).
#[derive(Debug, Clone, Serialize, Deserialize, Default)]
#[serde(rename_all = "camelCase")]
pub struct MCPResourceContentMeta {
    /// UI metadata containing CSP and permissions.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub ui: Option<McpUiMeta>,
}

/// MCP resource content.
/// MCP spec uses `text` for text content and `blob` for base64 binary; both are optional but at least one must be present.
/// Serialization uses `text` per spec; we accept both `text` and `content` when deserializing for compatibility.
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct MCPResourceContent {
    pub uri: String,
    /// Text or HTML content. Serialized as `text` per MCP spec; accepts `text` or `content` when deserializing.
    #[serde(
        default,
        alias = "text",
        rename = "text",
        skip_serializing_if = "Option::is_none"
    )]
    pub content: Option<String>,
    /// Base64-encoded binary content (MCP spec). Used for video, images, etc.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub blob: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub mime_type: Option<String>,
    /// Annotations for embedded resources (2025-11-25).
    #[serde(skip_serializing_if = "Option::is_none")]
    pub annotations: Option<MCPAnnotations>,
    /// Resource metadata (MCP Apps: contains ui.csp and ui.permissions).
    #[serde(skip_serializing_if = "Option::is_none", rename = "_meta")]
    pub meta: Option<MCPResourceContentMeta>,
}

/// MCP prompt definition (2025-11-25 spec).
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct MCPPrompt {
    pub name: String,
    /// Human-readable title for display (2025-11-25).
    #[serde(skip_serializing_if = "Option::is_none")]
    pub title: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub description: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub arguments: Option<Vec<MCPPromptArgument>>,
    /// Icons for UI display (2025-11-25).
    #[serde(skip_serializing_if = "Option::is_none")]
    pub icons: Option<Vec<MCPResourceIcon>>,
}

/// MCP prompt argument.
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct MCPPromptArgument {
    pub name: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub title: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub description: Option<String>,
    #[serde(default)]
    pub required: bool,
}

/// MCP prompt content.
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct MCPPromptContent {
    pub name: String,
    pub messages: Vec<MCPPromptMessage>,
}

/// Content block in prompt message (2025-11-25 spec). Deserializes from plain string (legacy) or structured block.
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(untagged)]
pub enum MCPPromptMessageContent {
    /// Legacy: plain string content from older servers.
    Plain(String),
    /// Structured content block.
    Block(Box<MCPPromptMessageContentBlock>),
}

/// Structured content block types for prompt messages.
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", tag = "type")]
pub enum MCPPromptMessageContentBlock {
    #[serde(rename = "text")]
    Text { text: String },
    #[serde(rename = "image")]
    Image { data: String, mime_type: String },
    #[serde(rename = "audio")]
    Audio { data: String, mime_type: String },
    #[serde(rename = "resource_link")]
    ResourceLink {
        uri: String,
        #[serde(skip_serializing_if = "Option::is_none")]
        name: Option<String>,
        #[serde(skip_serializing_if = "Option::is_none")]
        description: Option<String>,
        #[serde(skip_serializing_if = "Option::is_none")]
        mime_type: Option<String>,
    },
    #[serde(rename = "resource")]
    Resource { resource: Box<MCPResourceContent> },
}

impl MCPPromptMessageContent {
    /// Extracts displayable text. For non-text types returns a placeholder.
    pub fn text_or_placeholder(&self) -> String {
        match self {
            MCPPromptMessageContent::Plain(s) => s.clone(),
            MCPPromptMessageContent::Block(block) => match block.as_ref() {
                MCPPromptMessageContentBlock::Text { text } => text.clone(),
                MCPPromptMessageContentBlock::Image { mime_type, .. } => {
                    format!("[Image: {}]", mime_type)
                }
                MCPPromptMessageContentBlock::Audio { mime_type, .. } => {
                    format!("[Audio: {}]", mime_type)
                }
                MCPPromptMessageContentBlock::ResourceLink { uri, name, .. } => {
                    name.as_ref().map_or_else(
                        || format!("[Resource Link: {}]", uri),
                        |n| format!("[Resource Link: {} ({})]", n, uri),
                    )
                }
                MCPPromptMessageContentBlock::Resource { resource } => {
                    format!("[Resource: {}]", resource.uri)
                }
            },
        }
    }

    /// Substitutes placeholders like {{key}} with values. Only applies to text content.
    pub fn substitute_placeholders(&mut self, arguments: &HashMap<String, String>) {
        match self {
            MCPPromptMessageContent::Plain(s) => {
                for (key, value) in arguments {
                    let placeholder = format!("{{{{{}}}}}", key);
                    *s = s.replace(&placeholder, value);
                }
            }
            MCPPromptMessageContent::Block(block) => {
                if let MCPPromptMessageContentBlock::Text { text } = block.as_mut() {
                    for (key, value) in arguments {
                        let placeholder = format!("{{{{{}}}}}", key);
                        *text = text.replace(&placeholder, value);
                    }
                }
            }
        }
    }
}

/// MCP prompt message (2025-11-25 spec).
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct MCPPromptMessage {
    pub role: String,
    pub content: MCPPromptMessageContent,
}

/// MCP Apps UI metadata (tool declares interactive UI via _meta.ui.resourceUri).
/// resourceUri is optional: some tools use _meta.ui only for visibility/csp/permissions.
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct MCPToolUIMeta {
    /// URI pointing to UI resource, e.g. "ui://my-server/widget". Optional per MCP Apps spec.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub resource_uri: Option<String>,
}

/// MCP tool metadata (MCP Apps extension).
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct MCPToolMeta {
    #[serde(skip_serializing_if = "Option::is_none")]
    pub ui: Option<MCPToolUIMeta>,
}

/// Tool annotations (2025-11-25 spec). Clients MUST treat as untrusted unless from trusted servers.
#[derive(Debug, Clone, Serialize, Deserialize, Default)]
#[serde(rename_all = "camelCase")]
pub struct MCPToolAnnotations {
    #[serde(skip_serializing_if = "Option::is_none")]
    pub title: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub read_only_hint: Option<bool>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub destructive_hint: Option<bool>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub idempotent_hint: Option<bool>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub open_world_hint: Option<bool>,
}

/// MCP tool definition (2025-11-25 spec).
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct MCPTool {
    pub name: String,
    /// Human-readable title for display (2025-11-25).
    #[serde(skip_serializing_if = "Option::is_none")]
    pub title: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub description: Option<String>,
    pub input_schema: Value,
    /// Optional output schema for structured results (2025-11-25).
    #[serde(skip_serializing_if = "Option::is_none")]
    pub output_schema: Option<Value>,
    /// Icons for UI display (2025-11-25).
    #[serde(skip_serializing_if = "Option::is_none")]
    pub icons: Option<Vec<MCPResourceIcon>>,
    /// Tool behavior hints (2025-11-25). Treat as untrusted.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub annotations: Option<MCPToolAnnotations>,
    /// MCP Apps extension: tool metadata including UI resource URI
    #[serde(skip_serializing_if = "Option::is_none", rename = "_meta")]
    pub meta: Option<MCPToolMeta>,
}

/// MCP tool call result.
///
/// MCP Apps extension: `structuredContent` is UI-optimized data and not preferred
/// model context. The assistant renderer only falls back to it when `content`
/// carries no usable text, so a completed call or a failed one still reaches the
/// model with a payload instead of an empty message.
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct MCPToolResult {
    #[serde(skip_serializing_if = "Option::is_none")]
    pub content: Option<Vec<MCPToolResultContent>>,
    #[serde(default)]
    pub is_error: bool,
    /// Structured data for MCP App UI (ext-apps ontoolresult expects this).
    #[serde(skip_serializing_if = "Option::is_none")]
    pub structured_content: Option<Value>,
    /// Optional protocol-level metadata returned by the server.
    #[serde(skip_serializing_if = "Option::is_none", rename = "_meta")]
    pub meta: Option<Value>,
}

/// MCP tool result content (2025-11-25 spec).
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", tag = "type")]
pub enum MCPToolResultContent {
    #[serde(rename = "text")]
    Text { text: String },
    #[serde(rename = "image")]
    Image {
        data: String,
        #[serde(rename = "mimeType", alias = "mime_type")]
        mime_type: String,
    },
    #[serde(rename = "audio")]
    Audio {
        data: String,
        #[serde(rename = "mimeType", alias = "mime_type")]
        mime_type: String,
    },
    /// Link to resource (client may fetch via resources/read).
    #[serde(rename = "resource_link")]
    ResourceLink {
        uri: String,
        #[serde(skip_serializing_if = "Option::is_none")]
        name: Option<String>,
        #[serde(skip_serializing_if = "Option::is_none")]
        description: Option<String>,
        #[serde(skip_serializing_if = "Option::is_none")]
        mime_type: Option<String>,
    },
    /// Embedded resource content.
    #[serde(rename = "resource")]
    Resource { resource: Box<MCPResourceContent> },
}

/// MCP message type (based on JSON-RPC 2.0).
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(untagged)]
pub enum MCPMessage {
    Request(MCPRequest),
    Response(MCPResponse),
    Notification(MCPNotification),
}

/// MCP request message.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct MCPRequest {
    pub jsonrpc: String,
    pub id: Value,
    pub method: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub params: Option<Value>,
}

impl MCPRequest {
    pub fn new(id: Value, method: String, params: Option<Value>) -> Self {
        Self {
            jsonrpc: "2.0".to_string(),
            id,
            method,
            params,
        }
    }
}

/// MCP response message.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct MCPResponse {
    pub jsonrpc: String,
    pub id: Value,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub result: Option<Value>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub error: Option<MCPError>,
}

impl MCPResponse {
    pub fn success(id: Value, result: Value) -> Self {
        Self {
            jsonrpc: "2.0".to_string(),
            id,
            result: Some(result),
            error: None,
        }
    }

    pub fn error(id: Value, error: MCPError) -> Self {
        Self {
            jsonrpc: "2.0".to_string(),
            id,
            result: None,
            error: Some(error),
        }
    }
}

/// MCP notification message (no response required).
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct MCPNotification {
    pub jsonrpc: String,
    pub method: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub params: Option<Value>,
}

impl MCPNotification {
    pub fn new(method: String, params: Option<Value>) -> Self {
        Self {
            jsonrpc: "2.0".to_string(),
            method,
            params,
        }
    }
}

/// MCP error definition.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct MCPError {
    pub code: i32,
    pub message: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub data: Option<Value>,
}

impl MCPError {
    /// Standard JSON-RPC error codes.
    pub const PARSE_ERROR: i32 = -32700;
    pub const INVALID_REQUEST: i32 = -32600;
    pub const METHOD_NOT_FOUND: i32 = -32601;
    pub const INVALID_PARAMS: i32 = -32602;
    pub const INTERNAL_ERROR: i32 = -32603;
    /// Resource not found (2025-11-25 spec).
    pub const RESOURCE_NOT_FOUND: i32 = -32002;

    pub fn parse_error(message: impl Into<String>) -> Self {
        Self {
            code: Self::PARSE_ERROR,
            message: message.into(),
            data: None,
        }
    }

    pub fn invalid_request(message: impl Into<String>) -> Self {
        Self {
            code: Self::INVALID_REQUEST,
            message: message.into(),
            data: None,
        }
    }

    pub fn method_not_found(method: impl Into<String>) -> Self {
        Self {
            code: Self::METHOD_NOT_FOUND,
            message: format!("Method not found: {}", method.into()),
            data: None,
        }
    }

    pub fn invalid_params(message: impl Into<String>) -> Self {
        Self {
            code: Self::INVALID_PARAMS,
            message: message.into(),
            data: None,
        }
    }

    pub fn internal_error(message: impl Into<String>) -> Self {
        Self {
            code: Self::INTERNAL_ERROR,
            message: message.into(),
            data: None,
        }
    }
}

/// Initialize request parameters.
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct InitializeParams {
    pub protocol_version: MCPProtocolVersion,
    pub capabilities: MCPCapability,
    pub client_info: MCPServerInfo,
}

/// Initialize response result.
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct InitializeResult {
    pub protocol_version: MCPProtocolVersion,
    pub capabilities: MCPCapability,
    pub server_info: MCPServerInfo,
}

/// Resources/List request parameters.
#[derive(Debug, Clone, Serialize, Deserialize, Default)]
#[serde(rename_all = "camelCase")]
pub struct ResourcesListParams {
    #[serde(skip_serializing_if = "Option::is_none")]
    pub cursor: Option<String>,
}

/// Resources/List response result.
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ResourcesListResult {
    pub resources: Vec<MCPResource>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub next_cursor: Option<String>,
}

/// Resources/Read request parameters.
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ResourcesReadParams {
    pub uri: String,
}

/// Resources/Read response result.
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ResourcesReadResult {
    pub contents: Vec<MCPResourceContent>,
}

/// Prompts/List request parameters.
#[derive(Debug, Clone, Serialize, Deserialize, Default)]
#[serde(rename_all = "camelCase")]
pub struct PromptsListParams {
    #[serde(skip_serializing_if = "Option::is_none")]
    pub cursor: Option<String>,
}

/// Prompts/List response result.
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct PromptsListResult {
    pub prompts: Vec<MCPPrompt>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub next_cursor: Option<String>,
}

/// Prompts/Get request parameters.
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct PromptsGetParams {
    pub name: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub arguments: Option<HashMap<String, String>>,
}

/// Prompts/Get response result (2025-11-25 spec).
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct PromptsGetResult {
    #[serde(skip_serializing_if = "Option::is_none")]
    pub description: Option<String>,
    pub messages: Vec<MCPPromptMessage>,
}

/// Tools/List request parameters.
#[derive(Debug, Clone, Serialize, Deserialize, Default)]
#[serde(rename_all = "camelCase")]
pub struct ToolsListParams {
    #[serde(skip_serializing_if = "Option::is_none")]
    pub cursor: Option<String>,
}

/// Tools/List response result.
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ToolsListResult {
    pub tools: Vec<MCPTool>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub next_cursor: Option<String>,
}

/// Tools/Call request parameters.
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ToolsCallParams {
    pub name: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub arguments: Option<Value>,
}

/// Ping request (heartbeat).
#[derive(Debug, Clone, Serialize, Deserialize, Default)]
pub struct PingParams {}

/// Ping response.
#[derive(Debug, Clone, Serialize, Deserialize, Default)]
pub struct PingResult {}
