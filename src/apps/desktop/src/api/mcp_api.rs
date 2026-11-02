//! MCP API

use crate::api::app_state::AppState;
use crate::startup_trace::DesktopStartupTrace;
use openbitfun_core::service::mcp::auth::MCPRemoteOAuthSessionSnapshot;
use openbitfun_core::service::mcp::config::MCPConfigService;
use openbitfun_core::service::mcp::protocol::{
    MCPPrompt, MCPResource, PromptsGetResult, ResourcesReadResult,
};
use openbitfun_core::service::mcp::MCPServerType;
use openbitfun_core::service::runtime::{RuntimeManager, RuntimeSource};
use serde::{Deserialize, Serialize};
use std::collections::HashMap;
use std::time::Instant;
use tauri::State;

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct MCPServerInfo {
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub import_origin: Option<openbitfun_core::service::mcp::server::MCPImportOrigin>,
    pub id: String,
    pub name: String,
    pub status: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub status_message: Option<String>,
    pub server_type: String,
    pub transport: String,
    pub enabled: bool,
    pub auto_start: bool,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub url: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub auth_configured: Option<bool>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub auth_source: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub oauth_enabled: Option<bool>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub xaa_enabled: Option<bool>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub command: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub command_available: Option<bool>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub command_source: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub command_resolved_path: Option<String>,
    pub start_supported: bool,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub start_disabled_reason: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ListMCPResourcesRequest {
    pub server_id: String,
    #[serde(default)]
    pub refresh: bool,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ReadMCPResourceRequest {
    pub server_id: String,
    pub resource_uri: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ListMCPPromptsRequest {
    pub server_id: String,
    #[serde(default)]
    pub refresh: bool,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct GetMCPPromptRequest {
    pub server_id: String,
    pub prompt_name: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub arguments: Option<HashMap<String, String>>,
}

async fn load_mcp_resources(
    mcp_service: &openbitfun_core::service::mcp::MCPService,
    server_id: &str,
    refresh: bool,
) -> Result<Vec<MCPResource>, String> {
    let manager = mcp_service.server_manager();
    ensure_unscoped_host_mcp_access(&manager, server_id).await?;
    let mut resources = manager.get_cached_resources(server_id).await;

    if refresh || resources.is_empty() {
        manager
            .refresh_server_resource_catalog(server_id)
            .await
            .map_err(|e| e.to_string())?;
        resources = manager.get_cached_resources(server_id).await;
    }

    Ok(resources)
}

async fn load_mcp_prompts(
    mcp_service: &openbitfun_core::service::mcp::MCPService,
    server_id: &str,
    refresh: bool,
) -> Result<Vec<MCPPrompt>, String> {
    let manager = mcp_service.server_manager();
    ensure_unscoped_host_mcp_access(&manager, server_id).await?;
    let mut prompts = manager.get_cached_prompts(server_id).await;

    if refresh || prompts.is_empty() {
        manager
            .refresh_server_prompt_catalog(server_id)
            .await
            .map_err(|e| e.to_string())?;
        prompts = manager.get_cached_prompts(server_id).await;
    }

    Ok(prompts)
}

async fn ensure_unscoped_host_mcp_access(
    manager: &openbitfun_core::service::mcp::MCPServerManager,
    server_id: &str,
) -> Result<(), String> {
    manager
        .server_available_for_context(server_id, None, false)
        .await
        .then_some(())
        .ok_or_else(|| "MCP server is unavailable in this product surface".to_string())
}

#[tauri::command]
pub async fn initialize_mcp_servers(
    state: State<'_, AppState>,
    startup_trace: State<'_, DesktopStartupTrace>,
) -> Result<(), String> {
    let trace_started = Instant::now();
    let result = async {
        let mcp_service = state
            .mcp_service
            .as_ref()
            .ok_or_else(|| "MCP service not initialized".to_string())?;

        mcp_service
            .server_manager()
            .initialize_all()
            .await
            .map_err(|e| e.to_string())?;

        Ok(())
    }
    .await;
    startup_trace.record_tauri_command_elapsed("initialize_mcp_servers", None, trace_started);
    result
}

#[tauri::command]
pub async fn initialize_mcp_servers_non_destructive(
    state: State<'_, AppState>,
    startup_trace: State<'_, DesktopStartupTrace>,
) -> Result<(), String> {
    let trace_started = Instant::now();
    let result = async {
        let mcp_service = state
            .mcp_service
            .as_ref()
            .ok_or_else(|| "MCP service not initialized".to_string())?;

        mcp_service
            .server_manager()
            .initialize_non_destructive()
            .await
            .map_err(|e| e.to_string())?;

        Ok(())
    }
    .await;
    startup_trace.record_tauri_command_elapsed(
        "initialize_mcp_servers_non_destructive",
        None,
        trace_started,
    );
    result
}

#[tauri::command]
pub async fn get_mcp_servers(state: State<'_, AppState>) -> Result<Vec<MCPServerInfo>, String> {
    let mcp_service = state
        .mcp_service
        .as_ref()
        .ok_or_else(|| "MCP service not initialized".to_string())?;

    let configs = mcp_service
        .config_service()
        .load_all_configs()
        .await
        .map_err(|e| e.to_string())?;

    let mut infos = Vec::new();
    let runtime_manager = RuntimeManager::new().ok();
    let mcp_server_manager = mcp_service.server_manager();

    for config in configs {
        let transport = config.resolved_transport();
        let static_auth_configured = if matches!(config.server_type, MCPServerType::Remote) {
            MCPConfigService::has_remote_authorization(&config)
        } else {
            false
        };
        let oauth_enabled =
            matches!(config.server_type, MCPServerType::Remote) && config.remote_oauth_enabled();
        let oauth_auth_configured = if oauth_enabled {
            mcp_server_manager
                .has_remote_oauth_credentials(&config.id)
                .await
                .unwrap_or(false)
        } else {
            false
        };

        let (command, command_available, command_source, command_resolved_path) =
            if transport == openbitfun_core::service::mcp::MCPServerTransport::Stdio {
                if let Some(command) = config.command.clone() {
                    let capability = runtime_manager
                        .as_ref()
                        .map(|manager| manager.get_command_capability(&command));
                    let available = capability.as_ref().map(|c| c.available);
                    let source = capability.and_then(|c| {
                        c.source.map(|source| match source {
                            RuntimeSource::System => "system".to_string(),
                            RuntimeSource::Managed => "managed".to_string(),
                        })
                    });
                    let resolved_path = runtime_manager
                        .as_ref()
                        .and_then(|manager| manager.resolve_command(&command))
                        .and_then(|resolved| resolved.resolved_path);
                    (Some(command), available, source, resolved_path)
                } else {
                    (None, None, None, None)
                }
            } else {
                (None, None, None, None)
            };

        let (start_supported, start_disabled_reason) = match config.server_type {
            MCPServerType::Remote if transport.as_str() == "sse" => (
                false,
                Some("Remote MCP SSE transport is not yet supported".to_string()),
            ),
            _ => (true, None),
        };

        let (status, status_message) = match mcp_service
            .server_manager()
            .get_server_status(&config.id)
            .await
        {
            Ok(s) => {
                let status_message = mcp_service
                    .server_manager()
                    .get_server_status_message(&config.id)
                    .await
                    .ok()
                    .flatten();
                (format!("{:?}", s), status_message)
            }
            Err(_) => {
                if !config.enabled {
                    ("Stopped".to_string(), None)
                } else if config.auto_start {
                    ("Starting".to_string(), None)
                } else {
                    ("Uninitialized".to_string(), None)
                }
            }
        };

        infos.push(MCPServerInfo {
            import_origin: config
                .settings
                .get("_openbitfunImport")
                .cloned()
                .and_then(|value| serde_json::from_value::<openbitfun_core::service::mcp::server::MCPImportOrigin>(value).ok())
                .map(|mut origin| {
                    if origin.source_id.is_none() {
                        origin.source_id = openbitfun_core::external_sources::ecosystem_for_imported_mcp_candidate(&origin.source_candidate_id);
                    }
                    origin
                }),
            id: config.id.clone(),
            name: config.name.clone(),
            status,
            status_message,
            server_type: format!("{:?}", config.server_type),
            transport: transport.as_str().to_string(),
            enabled: config.enabled,
            auto_start: config.auto_start,
            url: config.url.clone(),
            auth_configured: if matches!(config.server_type, MCPServerType::Remote) {
                Some(static_auth_configured || oauth_auth_configured)
            } else {
                None
            },
            auth_source: if matches!(config.server_type, MCPServerType::Remote) {
                if static_auth_configured {
                    MCPConfigService::get_remote_authorization_source(&config)
                        .map(|source| source.to_string())
                } else if oauth_auth_configured {
                    Some("oauth".to_string())
                } else {
                    None
                }
            } else {
                None
            },
            oauth_enabled: if matches!(config.server_type, MCPServerType::Remote) {
                Some(oauth_enabled)
            } else {
                None
            },
            xaa_enabled: if matches!(config.server_type, MCPServerType::Remote) {
                Some(MCPConfigService::has_remote_xaa(&config))
            } else {
                None
            },
            command,
            command_available,
            command_source,
            command_resolved_path,
            start_supported,
            start_disabled_reason,
        });
    }

    Ok(infos)
}

#[tauri::command]
pub async fn list_mcp_resources(
    state: State<'_, AppState>,
    request: ListMCPResourcesRequest,
) -> Result<Vec<MCPResource>, String> {
    let mcp_service = state
        .mcp_service
        .as_ref()
        .ok_or_else(|| "MCP service not initialized".to_string())?;

    load_mcp_resources(mcp_service.as_ref(), &request.server_id, request.refresh).await
}

#[tauri::command]
pub async fn read_mcp_resource(
    state: State<'_, AppState>,
    request: ReadMCPResourceRequest,
) -> Result<ResourcesReadResult, String> {
    let mcp_service = state
        .mcp_service
        .as_ref()
        .ok_or_else(|| "MCP service not initialized".to_string())?;

    let manager = mcp_service.server_manager();
    ensure_unscoped_host_mcp_access(&manager, &request.server_id).await?;
    let connection = manager
        .get_connection(&request.server_id)
        .await
        .ok_or_else(|| format!("MCP server not connected: {}", request.server_id))?;

    connection
        .read_resource(&request.resource_uri)
        .await
        .map_err(|e| e.to_string())
}

#[tauri::command]
pub async fn list_mcp_prompts(
    state: State<'_, AppState>,
    request: ListMCPPromptsRequest,
) -> Result<Vec<MCPPrompt>, String> {
    let mcp_service = state
        .mcp_service
        .as_ref()
        .ok_or_else(|| "MCP service not initialized".to_string())?;

    load_mcp_prompts(mcp_service.as_ref(), &request.server_id, request.refresh).await
}

#[tauri::command]
pub async fn get_mcp_prompt(
    state: State<'_, AppState>,
    request: GetMCPPromptRequest,
) -> Result<PromptsGetResult, String> {
    let mcp_service = state
        .mcp_service
        .as_ref()
        .ok_or_else(|| "MCP service not initialized".to_string())?;

    let manager = mcp_service.server_manager();
    ensure_unscoped_host_mcp_access(&manager, &request.server_id).await?;
    let connection = manager
        .get_connection(&request.server_id)
        .await
        .ok_or_else(|| format!("MCP server not connected: {}", request.server_id))?;

    connection
        .get_prompt(&request.prompt_name, request.arguments)
        .await
        .map_err(|e| e.to_string())
}

#[tauri::command]
pub async fn start_mcp_server(state: State<'_, AppState>, server_id: String) -> Result<(), String> {
    let mcp_service = state
        .mcp_service
        .as_ref()
        .ok_or_else(|| "MCP service not initialized".to_string())?;

    let manager = mcp_service.server_manager();
    ensure_unscoped_host_mcp_access(&manager, &server_id).await?;
    manager
        .start_server(&server_id)
        .await
        .map_err(|e| e.to_string())?;

    Ok(())
}

#[tauri::command]
pub async fn stop_mcp_server(state: State<'_, AppState>, server_id: String) -> Result<(), String> {
    let mcp_service = state
        .mcp_service
        .as_ref()
        .ok_or_else(|| "MCP service not initialized".to_string())?;

    let manager = mcp_service.server_manager();
    ensure_unscoped_host_mcp_access(&manager, &server_id).await?;
    manager
        .stop_server(&server_id)
        .await
        .map_err(|e| e.to_string())?;

    Ok(())
}

#[tauri::command]
pub async fn restart_mcp_server(
    state: State<'_, AppState>,
    server_id: String,
) -> Result<(), String> {
    let mcp_service = state
        .mcp_service
        .as_ref()
        .ok_or_else(|| "MCP service not initialized".to_string())?;

    let manager = mcp_service.server_manager();
    ensure_unscoped_host_mcp_access(&manager, &server_id).await?;
    manager
        .restart_server(&server_id)
        .await
        .map_err(|e| e.to_string())?;

    Ok(())
}

#[tauri::command]
pub async fn get_mcp_server_status(
    state: State<'_, AppState>,
    server_id: String,
) -> Result<String, String> {
    let mcp_service = state
        .mcp_service
        .as_ref()
        .ok_or_else(|| "MCP service not initialized".to_string())?;

    let manager = mcp_service.server_manager();
    ensure_unscoped_host_mcp_access(&manager, &server_id).await?;
    let status = manager
        .get_server_status(&server_id)
        .await
        .map_err(|e| e.to_string())?;

    Ok(format!("{:?}", status))
}

#[tauri::command]
pub async fn load_mcp_json_config(
    state: State<'_, AppState>,
) -> Result<openbitfun_core::service::mcp::config::MCPJsonConfigSnapshot, String> {
    let mcp_service = state
        .mcp_service
        .as_ref()
        .ok_or_else(|| "MCP service not initialized".to_string())?;

    mcp_service
        .config_service()
        .load_mcp_json_config()
        .await
        .map_err(|e| e.to_string())
}

#[tauri::command]
pub async fn save_mcp_json_config(
    state: State<'_, AppState>,
    json_config: String,
    expected_fingerprint: String,
) -> Result<(), String> {
    let mcp_service = state
        .mcp_service
        .as_ref()
        .ok_or_else(|| "MCP service not initialized".to_string())?;

    mcp_service
        .save_json_config_and_reconcile(&json_config, &expected_fingerprint)
        .await
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

/// Request to fetch MCP App UI resource (ui:// scheme).
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct FetchMCPAppResourceRequest {
    /// Authoritative MCP server ID for the tool/app.
    pub server_id: String,
    /// Full resource URI, e.g. "ui://my-server/widget"
    pub resource_uri: String,
}

/// Response containing MCP App UI resource content.
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct FetchMCPAppResourceResponse {
    pub contents: Vec<MCPAppResourceContent>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct MCPAppResourceContent {
    pub uri: String,
    /// Text content (for HTML, etc.). Omitted when resource has blob only.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub content: Option<String>,
    /// Base64-encoded binary content (MCP spec). Used for video, images, etc.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub blob: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub mime_type: Option<String>,
    /// Content Security Policy configuration for MCP App UI.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub csp: Option<McpUiResourceCsp>,
    /// Sandbox permissions requested by the UI resource.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub permissions: Option<McpUiResourcePermissions>,
}

#[tauri::command]
pub async fn get_mcp_tool_ui_uri(
    _state: State<'_, AppState>,
    tool_name: String,
) -> Result<Option<String>, String> {
    let registry = openbitfun_core::agentic::tools::registry::get_global_tool_registry();
    let guard = registry.read().await;
    let is_mcp_tool = guard
        .get_dynamic_tool_info(&tool_name)
        .is_some_and(|info| info.mcp.is_some());
    let tool = guard.get_tool(&tool_name);
    drop(guard);
    if !is_mcp_tool {
        return Ok(None);
    }
    Ok(tool.and_then(|t| t.ui_resource_uri()))
}

#[tauri::command]
pub async fn fetch_mcp_app_resource(
    state: State<'_, AppState>,
    request: FetchMCPAppResourceRequest,
) -> Result<FetchMCPAppResourceResponse, String> {
    let mcp_service = state
        .mcp_service
        .as_ref()
        .ok_or_else(|| "MCP service not initialized".to_string())?;

    if !request.resource_uri.starts_with("ui://") {
        return Err("Resource URI must use ui:// scheme".to_string());
    }

    let manager = mcp_service.server_manager();
    ensure_unscoped_host_mcp_access(&manager, &request.server_id).await?;
    let connection = manager
        .get_connection(&request.server_id)
        .await
        .ok_or_else(|| format!("MCP server not connected: {}", request.server_id))?;

    let result = connection
        .read_resource(&request.resource_uri)
        .await
        .map_err(|e| e.to_string())?;

    let contents = result
        .contents
        .into_iter()
        .map(|c| {
            // Extract CSP and permissions from _meta.ui (MCP Apps spec path)
            let (csp, permissions) = c
                .meta
                .as_ref()
                .and_then(|meta| meta.ui.as_ref())
                .map(|ui| {
                    let csp = ui.csp.as_ref().map(|core_csp| McpUiResourceCsp {
                        connect_domains: core_csp.connect_domains.clone(),
                        resource_domains: core_csp.resource_domains.clone(),
                        frame_domains: core_csp.frame_domains.clone(),
                        base_uri_domains: core_csp.base_uri_domains.clone(),
                    });
                    let permissions =
                        ui.permissions
                            .as_ref()
                            .map(|core_perm| McpUiResourcePermissions {
                                camera: core_perm.camera.clone(),
                                microphone: core_perm.microphone.clone(),
                                geolocation: core_perm.geolocation.clone(),
                                clipboard_write: core_perm.clipboard_write.clone(),
                            });
                    (csp, permissions)
                })
                .unwrap_or((None, None));
            MCPAppResourceContent {
                uri: c.uri,
                content: c.content,
                blob: c.blob,
                mime_type: c.mime_type,
                csp,
                permissions,
            }
        })
        .collect();

    Ok(FetchMCPAppResourceResponse { contents })
}

/// JSON-RPC message from MCP App iframe (guest) to be forwarded to MCP server or handled by host.
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SendMCPAppMessageRequest {
    pub server_id: String,
    /// JSON-RPC 2.0 request: { "jsonrpc": "2.0", "method": "...", "params": {...}, "id": ... }
    #[serde(flatten)]
    pub message: serde_json::Value,
}

/// Response is the JSON-RPC response to send back to the iframe (result or error).
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SendMCPAppMessageResponse {
    /// Full JSON-RPC 2.0 response object to postMessage back to iframe.
    #[serde(flatten)]
    pub response: serde_json::Value,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SubmitMCPInteractionError {
    #[serde(skip_serializing_if = "Option::is_none")]
    pub code: Option<i32>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub message: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub data: Option<serde_json::Value>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SubmitMCPInteractionResponseRequest {
    pub interaction_id: String,
    pub approve: bool,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub result: Option<serde_json::Value>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub error: Option<SubmitMCPInteractionError>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct UpdateMCPRemoteAuthRequest {
    pub server_id: String,
    pub authorization_value: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ClearMCPRemoteAuthRequest {
    pub server_id: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct DeleteMCPServerRequest {
    pub server_id: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct StartMCPRemoteOAuthRequest {
    pub server_id: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct GetMCPRemoteOAuthSessionRequest {
    pub server_id: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct CancelMCPRemoteOAuthRequest {
    pub server_id: String,
}

#[tauri::command]
pub async fn send_mcp_app_message(
    state: State<'_, AppState>,
    request: SendMCPAppMessageRequest,
) -> Result<SendMCPAppMessageResponse, String> {
    let mcp_service = state
        .mcp_service
        .as_ref()
        .ok_or_else(|| "MCP service not initialized".to_string())?;

    let manager = mcp_service.server_manager();
    ensure_unscoped_host_mcp_access(&manager, &request.server_id).await?;
    let connection = manager
        .get_connection(&request.server_id)
        .await
        .ok_or_else(|| format!("MCP server not connected: {}", request.server_id))?;

    let msg = &request.message;
    let method = msg
        .get("method")
        .and_then(|m| m.as_str())
        .ok_or_else(|| "Missing method".to_string())?;
    let id = msg.get("id").cloned();
    let params = msg
        .get("params")
        .cloned()
        .unwrap_or(serde_json::Value::Null);

    let result_value: serde_json::Value = match method {
        "tools/call" => {
            let name = params
                .get("name")
                .and_then(|n| n.as_str())
                .ok_or_else(|| "tools/call: missing name".to_string())?;
            let arguments = params.get("arguments").cloned();
            let result = connection
                .call_tool(name, arguments)
                .await
                .map_err(|e| e.to_string())?;
            serde_json::to_value(result).map_err(|e| e.to_string())?
        }
        "resources/read" => {
            let uri = params
                .get("uri")
                .and_then(|u| u.as_str())
                .ok_or_else(|| "resources/read: missing uri".to_string())?;
            let result = connection
                .read_resource(uri)
                .await
                .map_err(|e| e.to_string())?;
            serde_json::to_value(result).map_err(|e| e.to_string())?
        }
        "ping" => {
            connection.ping().await.map_err(|e| e.to_string())?;
            serde_json::json!({})
        }
        _ => {
            let code = -32601;
            let error_msg = format!("Method not found: {}", method);
            let response = serde_json::json!({
                "jsonrpc": "2.0",
                "id": id,
                "error": { "code": code, "message": error_msg }
            });
            return Ok(SendMCPAppMessageResponse { response });
        }
    };

    let response = serde_json::json!({
        "jsonrpc": "2.0",
        "id": id,
        "result": result_value
    });
    Ok(SendMCPAppMessageResponse { response })
}

#[tauri::command]
pub async fn submit_mcp_interaction_response(
    state: State<'_, AppState>,
    request: SubmitMCPInteractionResponseRequest,
) -> Result<(), String> {
    let mcp_service = state
        .mcp_service
        .as_ref()
        .ok_or_else(|| "MCP service not initialized".to_string())?;

    let error_message = request.error.as_ref().and_then(|e| e.message.clone());
    let error_code = request.error.as_ref().and_then(|e| e.code);
    let error_data = request.error.as_ref().and_then(|e| e.data.clone());

    mcp_service
        .server_manager()
        .submit_interaction_response(
            &request.interaction_id,
            request.approve,
            request.result,
            error_message,
            error_code,
            error_data,
        )
        .await
        .map_err(|e| e.to_string())?;

    Ok(())
}

#[tauri::command]
pub async fn update_mcp_remote_auth(
    state: State<'_, AppState>,
    request: UpdateMCPRemoteAuthRequest,
) -> Result<(), String> {
    let mcp_service = state
        .mcp_service
        .as_ref()
        .ok_or_else(|| "MCP service not initialized".to_string())?;

    let manager = mcp_service.server_manager();
    ensure_unscoped_host_mcp_access(&manager, &request.server_id).await?;
    manager
        .reauthenticate_remote_server(&request.server_id, &request.authorization_value)
        .await
        .map_err(|e| e.to_string())?;

    Ok(())
}

#[tauri::command]
pub async fn clear_mcp_remote_auth(
    state: State<'_, AppState>,
    request: ClearMCPRemoteAuthRequest,
) -> Result<(), String> {
    let mcp_service = state
        .mcp_service
        .as_ref()
        .ok_or_else(|| "MCP service not initialized".to_string())?;

    let manager = mcp_service.server_manager();
    ensure_unscoped_host_mcp_access(&manager, &request.server_id).await?;
    manager
        .clear_remote_server_auth(&request.server_id)
        .await
        .map_err(|e| e.to_string())?;

    Ok(())
}

#[tauri::command]
pub async fn delete_mcp_server(
    state: State<'_, AppState>,
    request: DeleteMCPServerRequest,
) -> Result<(), String> {
    let mcp_service = state
        .mcp_service
        .as_ref()
        .ok_or_else(|| "MCP service not initialized".to_string())?;

    let manager = mcp_service.server_manager();
    ensure_unscoped_host_mcp_access(&manager, &request.server_id).await?;
    manager
        .remove_server(&request.server_id)
        .await
        .map_err(|e| e.to_string())?;

    Ok(())
}

#[tauri::command]
pub async fn start_mcp_remote_oauth(
    state: State<'_, AppState>,
    request: StartMCPRemoteOAuthRequest,
) -> Result<MCPRemoteOAuthSessionSnapshot, String> {
    let mcp_service = state
        .mcp_service
        .as_ref()
        .ok_or_else(|| "MCP service not initialized".to_string())?;

    let manager = mcp_service.server_manager();
    ensure_unscoped_host_mcp_access(&manager, &request.server_id).await?;
    manager
        .start_remote_oauth_authorization(&request.server_id)
        .await
        .map_err(|e| e.to_string())
}

#[tauri::command]
pub async fn get_mcp_remote_oauth_session(
    state: State<'_, AppState>,
    request: GetMCPRemoteOAuthSessionRequest,
) -> Result<Option<MCPRemoteOAuthSessionSnapshot>, String> {
    let mcp_service = state
        .mcp_service
        .as_ref()
        .ok_or_else(|| "MCP service not initialized".to_string())?;

    let manager = mcp_service.server_manager();
    ensure_unscoped_host_mcp_access(&manager, &request.server_id).await?;
    Ok(manager.get_remote_oauth_session(&request.server_id).await)
}

#[tauri::command]
pub async fn cancel_mcp_remote_oauth(
    state: State<'_, AppState>,
    request: CancelMCPRemoteOAuthRequest,
) -> Result<(), String> {
    let mcp_service = state
        .mcp_service
        .as_ref()
        .ok_or_else(|| "MCP service not initialized".to_string())?;

    let manager = mcp_service.server_manager();
    ensure_unscoped_host_mcp_access(&manager, &request.server_id).await?;
    manager
        .cancel_remote_oauth_authorization(&request.server_id)
        .await
        .map_err(|e| e.to_string())
}
