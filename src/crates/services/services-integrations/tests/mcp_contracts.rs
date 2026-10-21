#![cfg(feature = "mcp")]

use async_trait::async_trait;
use openbitfun_services_integrations::mcp::auth::rmcp_compat::{
    AuthorizationManager, CredentialStore, StoredCredentials,
};
use openbitfun_services_integrations::mcp::auth::{
    MCPRemoteOAuthCredentialStore, MCPRemoteOAuthCredentialVault, MCPRemoteOAuthSessionSnapshot,
    MCPRemoteOAuthStatus,
};
use openbitfun_services_integrations::mcp::config::ConfigLocation;
use openbitfun_services_integrations::mcp::config::{
    config_to_cursor_format, format_mcp_json_config_value, get_mcp_remote_authorization_source,
    get_mcp_remote_authorization_value, has_mcp_remote_authorization, has_mcp_remote_oauth,
    has_mcp_remote_xaa, merge_mcp_server_config_sources, normalize_mcp_authorization_value,
    parse_cursor_format, remove_mcp_authorization_keys, validate_mcp_json_config, MCPConfigService,
    MCPConfigStore, MCPImportError, MCPImportServer, MCPImportTransport,
};
use openbitfun_services_integrations::mcp::protocol::{
    create_initialize_request, create_mcp_client_info, create_ping_request,
    create_tools_call_request, create_tools_list_request, default_protocol_version,
    map_rmcp_initialize_result, map_rmcp_prompt, map_rmcp_prompt_message, map_rmcp_resource,
    map_rmcp_tool, map_rmcp_tool_result, MCPCapability, MCPError, MCPPrompt, MCPPromptArgument,
    MCPPromptContent, MCPPromptMessage, MCPPromptMessageContent, MCPPromptMessageContentBlock,
    MCPRequest, MCPResource, MCPResourceContent, MCPTool, MCPToolAnnotations, MCPToolResult,
    MCPToolResultContent,
};
use openbitfun_services_integrations::mcp::server::{
    compute_mcp_backoff_delay, detect_mcp_list_changed_kind, is_mcp_auth_error_message,
    mcp_reconnect_runtime_decision, mcp_server_is_running, mcp_should_start_after_config_update,
    MCPCatalogCache, MCPConnectionPool, MCPListChangedKind, MCPProcessStartContext,
    MCPReconnectRuntimeDecision, MCPRuntimeErrorKind, MCPRuntimeResult, MCPServerConfig,
    MCPServerRuntimeState, MCPServerStatus, MCPServerTimeouts, MCPServerTransport, MCPServerType,
};
use openbitfun_services_integrations::mcp::{
    build_mcp_tool_descriptor, build_mcp_tool_name, normalize_name_for_mcp,
    render_mcp_tool_result_for_assistant, render_unparsed_mcp_tool_result_for_assistant,
    MCPContextEnhancer, MCPContextEnhancerConfig, MCPDynamicToolProvider, MCPToolCatalogClient,
    McpDynamicToolDescriptor, McpToolInfo, PromptAdapter, ResourceAdapter, MCP_TOOL_DELIMITER,
    MCP_TOOL_PREFIX,
};
use rmcp::model::{AnnotateAble, Annotations, Content, Icon, Meta, RawResource, ResourceContents};
use std::collections::HashMap;
use std::sync::Arc;
use std::time::{Duration, SystemTime, UNIX_EPOCH};

fn make_mcp_config(
    id: &str,
    location: ConfigLocation,
    server_type: MCPServerType,
    command: Option<&str>,
    url: Option<&str>,
) -> MCPServerConfig {
    MCPServerConfig {
        id: id.to_string(),
        name: id.to_string(),
        server_type,
        transport: None,
        command: command.map(str::to_string),
        args: Vec::new(),
        env: HashMap::new(),
        working_directory: None,
        inherit_parent_environment: None,
        headers: HashMap::new(),
        url: url.map(str::to_string),
        auto_start: true,
        enabled: true,
        location,
        capabilities: Vec::new(),
        settings: Default::default(),
        oauth: None,
        oauth_enabled: None,
        xaa: None,
        timeouts: MCPServerTimeouts::default(),
    }
}

fn make_resource(name: &str, description: Option<&str>, uri: &str) -> MCPResource {
    MCPResource {
        uri: uri.to_string(),
        name: name.to_string(),
        title: None,
        description: description.map(str::to_string),
        mime_type: Some("text/plain".to_string()),
        icons: None,
        size: Some(12),
        annotations: None,
        metadata: None,
    }
}

#[derive(Default)]
struct InMemoryMCPConfigStore {
    values: tokio::sync::Mutex<HashMap<String, serde_json::Value>>,
}

#[async_trait]
impl MCPConfigStore for InMemoryMCPConfigStore {
    async fn get_config_value(&self, key: &str) -> MCPRuntimeResult<Option<serde_json::Value>> {
        Ok(self.values.lock().await.get(key).cloned())
    }

    async fn set_config_value(&self, key: &str, value: serde_json::Value) -> MCPRuntimeResult<()> {
        self.values.lock().await.insert(key.to_string(), value);
        Ok(())
    }

    async fn compare_and_set_config_value(
        &self,
        key: &str,
        expected: Option<serde_json::Value>,
        replacement: serde_json::Value,
    ) -> MCPRuntimeResult<bool> {
        let mut values = self.values.lock().await;
        if values.get(key).cloned() != expected {
            return Ok(false);
        }
        values.insert(key.to_string(), replacement);
        Ok(true)
    }
}

struct FailingMCPConfigStore;

#[async_trait]
impl MCPConfigStore for FailingMCPConfigStore {
    async fn get_config_value(&self, key: &str) -> MCPRuntimeResult<Option<serde_json::Value>> {
        Err(
            openbitfun_services_integrations::mcp::MCPRuntimeError::configuration(format!(
                "backend unavailable for {key}"
            )),
        )
    }

    async fn set_config_value(&self, key: &str, _value: serde_json::Value) -> MCPRuntimeResult<()> {
        Err(
            openbitfun_services_integrations::mcp::MCPRuntimeError::configuration(format!(
                "backend unavailable for {key}"
            )),
        )
    }

    async fn compare_and_set_config_value(
        &self,
        key: &str,
        _expected: Option<serde_json::Value>,
        _replacement: serde_json::Value,
    ) -> MCPRuntimeResult<bool> {
        Err(
            openbitfun_services_integrations::mcp::MCPRuntimeError::configuration(format!(
                "backend unavailable for {key}"
            )),
        )
    }
}

struct FakeMCPToolCatalogClient {
    tools: Vec<MCPTool>,
}

#[async_trait]
impl MCPToolCatalogClient for FakeMCPToolCatalogClient {
    async fn list_mcp_tools(&self) -> MCPRuntimeResult<Vec<MCPTool>> {
        Ok(self.tools.clone())
    }
}

#[test]
fn mcp_tool_name_contract_matches_existing_wire_format() {
    assert_eq!(MCP_TOOL_PREFIX, "mcp__");
    assert_eq!(MCP_TOOL_DELIMITER, "__");
    assert_eq!(
        normalize_name_for_mcp("Acme Search / Primary"),
        "Acme_Search___Primary"
    );
    assert_eq!(
        build_mcp_tool_name("Claude Code", "search repos"),
        "mcp__Claude_Code__search_repos"
    );
}

#[test]
fn mcp_tool_info_preserves_json_shape() {
    let info = McpToolInfo {
        server_id: "server-1".to_string(),
        server_name: "Docs".to_string(),
        tool_name: "search".to_string(),
    };

    assert_eq!(
        serde_json::to_value(info).unwrap(),
        serde_json::json!({
            "server_id": "server-1",
            "server_name": "Docs",
            "tool_name": "search"
        })
    );
}

#[test]
fn mcp_protocol_capability_contract_matches_existing_default() {
    assert_eq!(default_protocol_version(), "2025-11-25");
    assert_eq!(
        serde_json::to_value(MCPCapability::default()).unwrap(),
        serde_json::json!({
            "resources": {
                "subscribe": false,
                "listChanged": false
            },
            "prompts": {
                "listChanged": false
            },
            "tools": {
                "listChanged": false
            }
        })
    );
}

#[test]
fn mcp_server_timeout_config_is_optional_positive_milliseconds() {
    let timeouts = MCPServerTimeouts {
        startup_ms: Some(250),
        catalog_ms: Some(1_000),
        execution_ms: Some(30_000),
    };
    timeouts.validate().expect("positive timeouts are valid");
    assert_eq!(
        serde_json::to_value(&timeouts).unwrap(),
        serde_json::json!({
            "startupMs": 250,
            "catalogMs": 1_000,
            "executionMs": 30_000,
        })
    );
    assert!(MCPServerTimeouts {
        execution_ms: Some(0),
        ..Default::default()
    }
    .validate()
    .is_err());
    assert!(MCPServerTimeouts {
        execution_ms: Some(9_007_199_254_740_991),
        ..Default::default()
    }
    .validate()
    .is_ok());
    assert!(MCPServerTimeouts {
        execution_ms: Some(9_007_199_254_740_992),
        ..Default::default()
    }
    .validate()
    .is_err());
}

#[test]
fn mcp_remote_client_info_declares_supported_client_capabilities() {
    let info = create_mcp_client_info("OpenBitFun", "1.0.0");

    assert_eq!(info.client_info.name, "OpenBitFun");
    assert_eq!(info.client_info.version, "1.0.0");
    assert!(info.capabilities.roots.is_some());
    assert!(info.capabilities.sampling.is_some());
    assert!(info.capabilities.elicitation.is_some());
    assert_eq!(
        serde_json::to_value(&info.capabilities.elicitation).unwrap(),
        serde_json::json!({})
    );
}

#[test]
fn mcp_rmcp_initialize_mapping_preserves_server_identity_and_capabilities() {
    let mut capabilities = rmcp::model::ServerCapabilities::default();
    capabilities.tools = Some(rmcp::model::ToolsCapability {
        list_changed: Some(true),
    });
    capabilities.resources = Some(rmcp::model::ResourcesCapability {
        subscribe: Some(true),
        list_changed: Some(false),
    });
    capabilities.prompts = Some(rmcp::model::PromptsCapability {
        list_changed: Some(true),
    });
    capabilities.logging = Some(rmcp::model::JsonObject::new());

    let server_info = rmcp::model::ServerInfo::new(capabilities)
        .with_protocol_version(rmcp::model::ProtocolVersion::LATEST)
        .with_server_info(
            rmcp::model::Implementation::new("docs-server", "2.0.0").with_title("Docs Server"),
        )
        .with_instructions("Fallback description");

    let mapped = map_rmcp_initialize_result(&server_info);

    assert_eq!(
        mapped.protocol_version,
        rmcp::model::ProtocolVersion::LATEST.to_string()
    );
    assert_eq!(mapped.server_info.name, "docs-server");
    assert_eq!(mapped.server_info.version, "2.0.0");
    assert_eq!(
        mapped.server_info.description.as_deref(),
        Some("Docs Server")
    );
    assert_eq!(
        mapped
            .capabilities
            .tools
            .as_ref()
            .map(|cap| cap.list_changed),
        Some(true)
    );
    assert_eq!(
        mapped
            .capabilities
            .resources
            .as_ref()
            .map(|cap| (cap.subscribe, cap.list_changed)),
        Some((true, false))
    );
    assert!(mapped.capabilities.logging.is_some());
}

#[test]
fn mcp_rmcp_mapping_preserves_remote_tool_resource_and_prompt_metadata() {
    let mut tool_meta = Meta::default();
    tool_meta.insert(
        "ui".to_string(),
        serde_json::json!({ "resourceUri": "ui://widget" }),
    );
    let mut tool = rmcp::model::Tool::new("search", "Find items", serde_json::Map::new());
    tool.title = Some("Search".to_string());
    tool.output_schema = Some(Arc::new(serde_json::Map::from_iter([(
        "type".to_string(),
        serde_json::json!("object"),
    )])));
    tool.annotations = Some(
        rmcp::model::ToolAnnotations::new()
            .read_only(true)
            .destructive(false)
            .idempotent(true)
            .open_world(true),
    );
    tool.icons = Some(vec![Icon::new("https://example.com/tool.png")
        .with_mime_type("image/png")
        .with_sizes(vec!["32x32".to_string()])]);
    tool.meta = Some(tool_meta);
    let mapped_tool = map_rmcp_tool(tool);
    assert_eq!(mapped_tool.title.as_deref(), Some("Search"));
    assert_eq!(
        mapped_tool.output_schema,
        Some(serde_json::json!({ "type": "object" }))
    );
    assert_eq!(
        mapped_tool
            .annotations
            .as_ref()
            .and_then(|annotations| annotations.read_only_hint),
        Some(true)
    );
    assert_eq!(
        mapped_tool
            .meta
            .as_ref()
            .and_then(|meta| meta.ui.as_ref())
            .and_then(|ui| ui.resource_uri.as_deref()),
        Some("ui://widget")
    );

    let mut resource_meta = Meta::default();
    resource_meta.insert("source".to_string(), serde_json::json!("catalog"));
    let resource = RawResource {
        uri: "file:///tmp/report.md".to_string(),
        name: "report".to_string(),
        title: Some("Quarterly Report".to_string()),
        description: Some("Report".to_string()),
        mime_type: Some("text/markdown".to_string()),
        size: Some(42),
        icons: Some(vec![Icon::new("https://example.com/resource.png")
            .with_mime_type("image/png")
            .with_sizes(vec!["64x64".to_string()])]),
        meta: Some(resource_meta),
    }
    .annotate({
        let mut annotations = Annotations::default();
        annotations.audience = Some(vec![rmcp::model::Role::User]);
        annotations.priority = Some(0.9);
        annotations
    });
    let mapped_resource = map_rmcp_resource(resource);
    assert_eq!(mapped_resource.title.as_deref(), Some("Quarterly Report"));
    assert_eq!(mapped_resource.size, Some(42));
    assert_eq!(
        mapped_resource
            .annotations
            .as_ref()
            .and_then(|annotations| annotations.audience.as_ref())
            .cloned(),
        Some(vec!["user".to_string()])
    );
    assert_eq!(
        mapped_resource
            .metadata
            .as_ref()
            .and_then(|meta| meta.get("source")),
        Some(&serde_json::json!("catalog"))
    );

    let prompt = rmcp::model::Prompt::new(
        "summarize",
        Some("Summarize content"),
        Some(vec![rmcp::model::PromptArgument::new("topic")
            .with_title("Topic")
            .with_description("Topic to summarize")
            .with_required(true)]),
    )
    .with_title("Summarize")
    .with_icons(vec![Icon::new("https://example.com/prompt.png")
        .with_mime_type("image/png")
        .with_sizes(vec!["16x16".to_string()])]);
    let mapped_prompt = map_rmcp_prompt(prompt);
    assert_eq!(mapped_prompt.title.as_deref(), Some("Summarize"));
    assert_eq!(
        mapped_prompt
            .arguments
            .as_ref()
            .and_then(|arguments| arguments.first())
            .and_then(|argument| argument.title.as_deref()),
        Some("Topic")
    );
    assert!(mapped_prompt.icons.is_some());
}

#[test]
fn mcp_rmcp_mapping_preserves_structured_results_and_resource_links() {
    let resource_link = RawResource {
        uri: "file:///tmp/output.json".to_string(),
        name: "output".to_string(),
        title: Some("Output".to_string()),
        description: Some("Generated output".to_string()),
        mime_type: Some("application/json".to_string()),
        size: Some(7),
        icons: None,
        meta: None,
    };
    let mut result_meta = Meta::default();
    result_meta.insert("traceId".to_string(), serde_json::json!("abc123"));
    let mut result = rmcp::model::CallToolResult::success(vec![
        Content::text("done"),
        Content::resource_link(resource_link),
        Content::image("aGVsbG8=", "image/png"),
    ]);
    result.structured_content = Some(serde_json::json!({ "ok": true }));
    result.meta = Some(result_meta);

    let mapped = map_rmcp_tool_result(result);

    assert_eq!(
        mapped.structured_content,
        Some(serde_json::json!({ "ok": true }))
    );
    assert_eq!(
        mapped.meta,
        Some(serde_json::json!({ "traceId": "abc123" }))
    );
    assert!(matches!(
        mapped.content.as_ref().and_then(|content| content.get(1)),
        Some(MCPToolResultContent::ResourceLink { uri, .. }) if uri == "file:///tmp/output.json"
    ));
    assert!(matches!(
        mapped.content.as_ref().and_then(|content| content.get(2)),
        Some(MCPToolResultContent::Image { mime_type, .. }) if mime_type == "image/png"
    ));
}

#[test]
fn mcp_rmcp_mapping_preserves_prompt_message_blocks() {
    let prompt_message =
        rmcp::model::PromptMessage::new_text(rmcp::model::PromptMessageRole::User, "hello");
    let mapped = map_rmcp_prompt_message(prompt_message);
    assert!(matches!(
        mapped.content,
        MCPPromptMessageContent::Block(ref block)
            if matches!(block.as_ref(), MCPPromptMessageContentBlock::Text { text } if text == "hello")
    ));

    let resource_link = RawResource {
        uri: "file:///tmp/input.md".to_string(),
        name: "input".to_string(),
        title: None,
        description: Some("input".to_string()),
        mime_type: Some("text/markdown".to_string()),
        size: None,
        icons: None,
        meta: None,
    }
    .no_annotation();
    let prompt_message = rmcp::model::PromptMessage::new(
        rmcp::model::PromptMessageRole::Assistant,
        rmcp::model::PromptMessageContent::resource_link(resource_link),
    );
    let mapped = map_rmcp_prompt_message(prompt_message);
    assert!(matches!(
        mapped.content,
        MCPPromptMessageContent::Block(ref block)
            if matches!(
                block.as_ref(),
                MCPPromptMessageContentBlock::ResourceLink { uri, .. }
                    if uri == "file:///tmp/input.md"
            )
    ));

    let embedded = rmcp::model::RawEmbeddedResource {
        meta: Some(Meta::default()),
        resource: ResourceContents::TextResourceContents {
            uri: "file:///tmp/embedded.txt".to_string(),
            mime_type: Some("text/plain".to_string()),
            text: "embedded".to_string(),
            meta: None,
        },
    }
    .no_annotation();
    let prompt_message = rmcp::model::PromptMessage::new(
        rmcp::model::PromptMessageRole::Assistant,
        rmcp::model::PromptMessageContent::Resource { resource: embedded },
    );
    let mapped = map_rmcp_prompt_message(prompt_message);
    assert!(matches!(
        mapped.content,
        MCPPromptMessageContent::Block(ref block)
            if matches!(
                block.as_ref(),
                MCPPromptMessageContentBlock::Resource { resource }
                    if resource.uri == "file:///tmp/embedded.txt"
            )
    ));
}

#[test]
fn mcp_protocol_jsonrpc_helpers_preserve_wire_shape() {
    let request = MCPRequest::new(
        serde_json::json!(7),
        "tools/list".to_string(),
        Some(serde_json::json!({ "cursor": "next" })),
    );

    assert_eq!(
        serde_json::to_value(request).unwrap(),
        serde_json::json!({
            "jsonrpc": "2.0",
            "id": 7,
            "method": "tools/list",
            "params": {
                "cursor": "next"
            }
        })
    );

    assert_eq!(
        serde_json::to_value(MCPError::method_not_found("tools/call")).unwrap(),
        serde_json::json!({
            "code": -32601,
            "message": "Method not found: tools/call"
        })
    );
}

#[test]
fn mcp_protocol_request_builders_preserve_wire_shape() {
    assert_eq!(
        serde_json::to_value(create_initialize_request(9, "OpenBitFun", "1.0.0")).unwrap(),
        serde_json::json!({
            "jsonrpc": "2.0",
            "id": 9,
            "method": "initialize",
            "params": {
                "protocolVersion": "2025-11-25",
                "capabilities": {
                    "resources": {
                        "subscribe": false,
                        "listChanged": false
                    },
                    "prompts": {
                        "listChanged": false
                    },
                    "tools": {
                        "listChanged": false
                    }
                },
                "clientInfo": {
                    "name": "OpenBitFun",
                    "version": "1.0.0",
                    "description": "OpenBitFun MCP Client",
                    "vendor": "OpenBitFun"
                }
            }
        })
    );

    assert_eq!(
        serde_json::to_value(create_tools_list_request(10, None)).unwrap(),
        serde_json::json!({
            "jsonrpc": "2.0",
            "id": 10,
            "method": "tools/list"
        })
    );

    assert_eq!(
        serde_json::to_value(create_tools_list_request(11, Some("cursor-1".to_string()))).unwrap(),
        serde_json::json!({
            "jsonrpc": "2.0",
            "id": 11,
            "method": "tools/list",
            "params": {
                "cursor": "cursor-1"
            }
        })
    );

    assert_eq!(
        serde_json::to_value(create_tools_call_request(
            12,
            "search",
            Some(serde_json::json!({ "query": "rust" }))
        ))
        .unwrap(),
        serde_json::json!({
            "jsonrpc": "2.0",
            "id": 12,
            "method": "tools/call",
            "params": {
                "name": "search",
                "arguments": {
                    "query": "rust"
                }
            }
        })
    );

    assert_eq!(
        serde_json::to_value(create_ping_request(13)).unwrap(),
        serde_json::json!({
            "jsonrpc": "2.0",
            "id": 13,
            "method": "ping",
            "params": {}
        })
    );
}

#[test]
fn mcp_protocol_prompt_content_helpers_preserve_legacy_text_behavior() {
    let mut content = MCPPromptMessageContent::Plain("Review {{target}}".to_string());
    content.substitute_placeholders(&std::collections::HashMap::from([(
        "target".to_string(),
        "src/main.rs".to_string(),
    )]));

    assert_eq!(content.text_or_placeholder(), "Review src/main.rs");

    let image = MCPPromptMessageContent::Block(Box::new(MCPPromptMessageContentBlock::Image {
        data: "base64".to_string(),
        mime_type: "image/png".to_string(),
    }));
    assert_eq!(image.text_or_placeholder(), "[Image: image/png]");
}

#[test]
fn mcp_resource_and_prompt_adapters_preserve_context_rendering_contract() {
    let resource = MCPResource {
        title: Some("Design Notes".to_string()),
        metadata: Some(HashMap::from([(
            "source".to_string(),
            serde_json::json!("fixture"),
        )])),
        ..make_resource("notes", Some("project notes"), "file:///workspace/notes.md")
    };
    let content = MCPResourceContent {
        uri: resource.uri.clone(),
        content: Some("alpha beta".to_string()),
        blob: None,
        mime_type: Some("text/markdown".to_string()),
        annotations: None,
        meta: None,
    };

    assert_eq!(
        ResourceAdapter::to_context_block(&resource, Some(&content)),
        serde_json::json!({
            "type": "resource",
            "uri": "file:///workspace/notes.md",
            "name": "notes",
            "title": "Design Notes",
            "displayName": "Design Notes",
            "description": "project notes",
            "mimeType": "text/plain",
            "size": 12,
            "content": "alpha beta",
            "metadata": {
                "source": "fixture"
            }
        })
    );
    assert_eq!(
        ResourceAdapter::to_text(&content),
        "Resource: file:///workspace/notes.md\n\nalpha beta\n"
    );

    let ranked = ResourceAdapter::filter_and_rank(
        vec![
            make_resource("readme", Some("install guide"), "file:///README.md"),
            make_resource("report", Some("quarterly guide"), "file:///report.md"),
            make_resource("other", Some("misc"), "file:///other.md"),
        ],
        "guide",
        0.3,
        2,
    );
    assert_eq!(
        ranked
            .iter()
            .map(|(resource, _)| resource.name.as_str())
            .collect::<Vec<_>>(),
        vec!["readme", "report"]
    );

    let prompt = MCPPrompt {
        name: "review".to_string(),
        title: None,
        description: None,
        arguments: Some(vec![MCPPromptArgument {
            name: "target".to_string(),
            title: None,
            description: None,
            required: true,
        }]),
        icons: None,
    };
    assert!(!PromptAdapter::is_applicable(&prompt, &HashMap::new()));
    assert!(PromptAdapter::is_applicable(
        &prompt,
        &HashMap::from([("target".to_string(), "src/lib.rs".to_string())])
    ));

    let messages = PromptAdapter::substitute_arguments(
        vec![MCPPromptMessage {
            role: "user".to_string(),
            content: MCPPromptMessageContent::Plain("Review {{target}}".to_string()),
        }],
        &HashMap::from([("target".to_string(), "src/lib.rs".to_string())]),
    );
    let prompt_text = PromptAdapter::to_system_prompt(&MCPPromptContent {
        name: "review".to_string(),
        messages,
    });
    assert_eq!(prompt_text, "User: Review src/lib.rs");
}

#[tokio::test]
async fn mcp_context_enhancer_preserves_resource_selection_contract() {
    let enhancer = MCPContextEnhancer::new(MCPContextEnhancerConfig {
        min_relevance: 0.1,
        max_resources: 1,
        max_total_size: 1024,
        enable_caching: true,
    });

    let context = enhancer
        .enhance(
            "rust mcp",
            vec![
                (
                    make_resource("Rust MCP Guide", Some("runtime docs"), "file://guide.md"),
                    MCPResourceContent {
                        uri: "file://guide.md".to_string(),
                        content: Some("A useful MCP runtime guide".to_string()),
                        blob: None,
                        mime_type: Some("text/plain".to_string()),
                        annotations: None,
                        meta: None,
                    },
                ),
                (
                    make_resource("Unrelated", None, "file://image.png"),
                    MCPResourceContent {
                        uri: "file://image.png".to_string(),
                        content: None,
                        blob: Some("base64".to_string()),
                        mime_type: Some("image/png".to_string()),
                        annotations: None,
                        meta: None,
                    },
                ),
            ],
        )
        .await
        .unwrap();

    assert_eq!(context["type"], "mcp_context");
    assert_eq!(context["query"], "rust mcp");
    assert_eq!(context["resources"].as_array().unwrap().len(), 1);
    assert_eq!(context["resources"][0]["name"], "Rust MCP Guide");
    assert!(context["resources"][0]["relevance_score"].as_f64().unwrap() > 0.0);
}

#[tokio::test]
async fn mcp_catalog_cache_preserves_resource_prompt_lifecycle_contract() {
    let cache = MCPCatalogCache::new();
    let resource = make_resource("readme", Some("docs"), "file:///README.md");
    let prompt = MCPPrompt {
        name: "summarize".to_string(),
        title: Some("Summarize".to_string()),
        description: None,
        arguments: None,
        icons: None,
    };

    cache
        .replace_resources("server-a", vec![resource.clone()])
        .await;
    cache
        .replace_prompts("server-a", vec![prompt.clone()])
        .await;

    assert_eq!(cache.get_resources("server-a").await[0].name, "readme");
    assert_eq!(cache.get_prompts("server-a").await[0].name, "summarize");
    assert!(cache.get_resources("missing").await.is_empty());

    cache.remove_server("server-a").await;
    assert!(cache.get_resources("server-a").await.is_empty());
    assert!(cache.get_prompts("server-a").await.is_empty());

    cache.replace_resources("server-b", vec![resource]).await;
    cache.replace_prompts("server-b", vec![prompt]).await;
    cache.clear().await;
    assert!(cache.get_resources("server-b").await.is_empty());
    assert!(cache.get_prompts("server-b").await.is_empty());
}

#[tokio::test]
async fn mcp_catalog_cache_replacement_invalidates_stale_entries() {
    let cache = MCPCatalogCache::new();
    let old_resource = make_resource("old", Some("stale"), "file:///old.md");
    let new_resource = make_resource("new", Some("fresh"), "file:///new.md");
    let old_prompt = MCPPrompt {
        name: "old-prompt".to_string(),
        title: None,
        description: Some("stale".to_string()),
        arguments: None,
        icons: None,
    };
    let new_prompt = MCPPrompt {
        name: "new-prompt".to_string(),
        title: None,
        description: Some("fresh".to_string()),
        arguments: None,
        icons: None,
    };

    cache
        .replace_resources("server-a", vec![old_resource])
        .await;
    cache.replace_prompts("server-a", vec![old_prompt]).await;
    cache
        .replace_resources("server-a", vec![new_resource])
        .await;
    cache.replace_prompts("server-a", vec![new_prompt]).await;

    let resources = cache.get_resources("server-a").await;
    let prompts = cache.get_prompts("server-a").await;
    assert_eq!(
        resources
            .iter()
            .map(|item| item.name.as_str())
            .collect::<Vec<_>>(),
        vec!["new"]
    );
    assert_eq!(
        prompts
            .iter()
            .map(|item| item.name.as_str())
            .collect::<Vec<_>>(),
        vec!["new-prompt"]
    );

    cache.replace_resources("server-a", Vec::new()).await;
    cache.replace_prompts("server-a", Vec::new()).await;
    assert!(cache.get_resources("server-a").await.is_empty());
    assert!(cache.get_prompts("server-a").await.is_empty());
}

#[test]
fn mcp_runtime_notification_and_backoff_helpers_preserve_manager_contract() {
    assert_eq!(
        detect_mcp_list_changed_kind("notifications/tools/list_changed"),
        Some(MCPListChangedKind::Tools)
    );
    assert_eq!(
        detect_mcp_list_changed_kind("notifications/prompts/listChanged"),
        Some(MCPListChangedKind::Prompts)
    );
    assert_eq!(
        detect_mcp_list_changed_kind("resources/list_changed"),
        Some(MCPListChangedKind::Resources)
    );
    assert_eq!(detect_mcp_list_changed_kind("notifications/other"), None);

    assert_eq!(
        compute_mcp_backoff_delay(Duration::from_secs(2), Duration::from_secs(60), 1),
        Duration::from_secs(2)
    );
    assert_eq!(
        compute_mcp_backoff_delay(Duration::from_secs(2), Duration::from_secs(60), 5),
        Duration::from_secs(32)
    );
    assert_eq!(
        compute_mcp_backoff_delay(Duration::from_secs(2), Duration::from_secs(60), 10),
        Duration::from_secs(60)
    );
}

#[test]
fn mcp_dynamic_tool_descriptor_and_result_rendering_preserve_tool_contract() {
    let tool = MCPTool {
        name: "search".to_string(),
        title: Some("Search".to_string()),
        description: Some("Find docs".to_string()),
        input_schema: serde_json::json!({ "type": "object" }),
        output_schema: None,
        icons: None,
        annotations: Some(MCPToolAnnotations {
            title: Some("Search Docs".to_string()),
            read_only_hint: Some(true),
            destructive_hint: Some(false),
            idempotent_hint: Some(true),
            open_world_hint: Some(true),
        }),
        meta: None,
    };

    let descriptor = build_mcp_tool_descriptor("github", "GitHub", &tool);
    assert_eq!(
        descriptor,
        McpDynamicToolDescriptor {
            full_name: "mcp__github__search".to_string(),
            title: "Search Docs".to_string(),
            user_facing_name: "Search Docs (GitHub)".to_string(),
            description: "Tool 'Search Docs' from MCP server 'GitHub': Find docs [Hints: read-only, open-world]".to_string(),
            provider_id: "github".to_string(),
            provider_kind: "mcp".to_string(),
            tool_info: McpToolInfo {
                server_id: "github".to_string(),
                server_name: "GitHub".to_string(),
                tool_name: "search".to_string(),
            },
            read_only: true,
        }
    );

    let rendered = render_mcp_tool_result_for_assistant(
        "search",
        &MCPToolResult {
            content: Some(vec![
                MCPToolResultContent::Text {
                    text: "done".to_string(),
                },
                MCPToolResultContent::Image {
                    data: "base64".to_string(),
                    mime_type: "image/png".to_string(),
                },
                MCPToolResultContent::ResourceLink {
                    uri: "file:///tmp/output.json".to_string(),
                    name: Some("output".to_string()),
                    description: None,
                    mime_type: Some("application/json".to_string()),
                },
            ]),
            is_error: false,
            structured_content: Some(serde_json::json!({ "ignored": "content wins" })),
            meta: None,
        },
        12_000,
    );
    assert_eq!(
        rendered,
        "done\n[Image: image/png]\n[Resource: output (file:///tmp/output.json)]"
    );

    assert_eq!(
        render_mcp_tool_result_for_assistant(
            "search",
            &MCPToolResult {
                content: None,
                is_error: true,
                structured_content: None,
                meta: None,
            },
            12_000,
        ),
        "Error executing MCP tool 'search'"
    );
}

#[test]
fn mcp_tool_error_rendering_preserves_server_details_and_excludes_metadata() {
    let result: rmcp::model::CallToolResult = serde_json::from_value(serde_json::json!({
        "isError": true,
        "content": [
            { "type": "text", "text": "The query must not be empty." },
            { "type": "text", "text": "Provide at least one search term." }
        ],
        "structuredContent": { "ignored": "content wins" },
        "_meta": { "private": "not for the model" }
    }))
    .unwrap();
    let result = map_rmcp_tool_result(result);

    assert!(result.is_error);

    assert_eq!(
        render_mcp_tool_result_for_assistant("search", &result, 12_000),
        "Error executing MCP tool 'search'\nThe query must not be empty.\nProvide at least one search term."
    );
}

#[test]
fn mcp_tool_error_rendering_uses_structured_details_when_content_is_empty() {
    for content in [
        None,
        Some(Vec::new()),
        Some(vec![MCPToolResultContent::Text {
            text: " \n\t".to_string(),
        }]),
    ] {
        let mut result = MCPToolResult {
            content,
            is_error: true,
            structured_content: Some(serde_json::json!({
                "message": "The requested document was not found."
            })),
            meta: Some(serde_json::json!({ "private": "not for the model" })),
        };

        assert_eq!(
            render_mcp_tool_result_for_assistant("search", &result, 12_000),
            "Error executing MCP tool 'search'\n{\"message\":\"The requested document was not found.\"}"
        );

        result.structured_content = None;
        assert_eq!(
            render_mcp_tool_result_for_assistant("search", &result, 12_000),
            "Error executing MCP tool 'search'"
        );
    }
}

#[test]
fn mcp_tool_result_rendering_preserves_success_without_an_error_flag() {
    for (payload, expected) in [
        (
            serde_json::json!({ "content": [{ "type": "text", "text": "done" }] }),
            "done",
        ),
        (
            serde_json::json!({ "structuredContent": { "ok": true } }),
            "{\"ok\":true}",
        ),
        (serde_json::json!({}), "MCP tool execution completed"),
    ] {
        let result: MCPToolResult = serde_json::from_value(payload).unwrap();
        assert_eq!(
            render_mcp_tool_result_for_assistant("search", &result, 12_000),
            expected
        );
    }
}

#[test]
fn mcp_unparsed_tool_error_payload_is_rendered_as_failure_without_private_metadata() {
    let raw = serde_json::json!({
        "isError": true,
        "content": [{ "type": "resource_extension_from_a_newer_server", "uri": "file:///x" }],
        "_meta": { "private": "not for the model" }
    });

    let rendered = render_unparsed_mcp_tool_result_for_assistant(&raw, usize::MAX);
    assert!(
        rendered.starts_with("MCP tool execution failed: "),
        "an unparsed failing payload must not read as a completed call: {rendered}"
    );
    assert!(rendered.contains("resource_extension_from_a_newer_server"));
    assert!(rendered.contains("\"isError\":true"));
    assert!(!rendered.contains("not for the model"));

    // Without the MCP error flag the pre-existing completed text stays.
    for payload in [
        serde_json::json!({ "unexpected": true }),
        serde_json::json!({ "isError": false }),
        serde_json::json!([1, 2, 3]),
    ] {
        assert_eq!(
            render_unparsed_mcp_tool_result_for_assistant(&payload, usize::MAX),
            "MCP tool execution completed"
        );
    }

    // The failed fallback shares the assistant character budget.
    let long = serde_json::json!({ "isError": true, "content": "x".repeat(200) });
    let truncated = render_unparsed_mcp_tool_result_for_assistant(&long, 40);
    assert!(truncated.starts_with("MCP tool execution failed: "));
    assert!(truncated.contains("[Result truncated: 40 of"));
}

#[test]
fn mcp_tool_error_rendering_uses_the_existing_character_limit() {
    let result = MCPToolResult {
        content: Some(vec![MCPToolResultContent::Text {
            text: "\u{03b1}\u{03b2}\u{03b3}".to_string(),
        }]),
        is_error: true,
        structured_content: None,
        meta: None,
    };

    assert_eq!(
        render_mcp_tool_result_for_assistant("search", &result, 37),
        "Error executing MCP tool 'search'\n\u{03b1}\u{03b2}\u{03b3}"
    );
    assert_eq!(
        render_mcp_tool_result_for_assistant("search", &result, 36),
        "Error executing MCP tool 'search'\n\u{03b1}\u{03b2}\n[Result truncated: 36 of 37 characters shown]"
    );

    let long_details = "x".repeat(12_001);
    let long_result = MCPToolResult {
        content: Some(vec![MCPToolResultContent::Text {
            text: long_details.clone(),
        }]),
        ..result
    };
    assert_eq!(
        render_mcp_tool_result_for_assistant("search", &long_result, usize::MAX),
        format!("Error executing MCP tool 'search'\n{}", long_details)
    );
}

#[tokio::test]
async fn mcp_config_service_orchestration_preserves_load_save_delete_contract() {
    let store = Arc::new(InMemoryMCPConfigStore::default());
    store.values.lock().await.insert(
        "mcp_servers".to_string(),
        serde_json::json!({
            "mcpServers": {
                "remote-docs": {
                    "type": "remote",
                    "url": "https://example.com/mcp",
                    "headers": {
                        "X-Existing": "kept"
                    },
                    "env": {
                        "Authorization": "process-env-token"
                    }
                }
            }
        }),
    );

    let service = MCPConfigService::new(store.clone());

    let loaded = service.load_all_configs().await.unwrap();
    assert_eq!(loaded.len(), 1);
    assert_eq!(loaded[0].id, "remote-docs");
    assert_eq!(loaded[0].location, ConfigLocation::User);

    let updated = service
        .set_remote_authorization("remote-docs", "plain-token")
        .await
        .unwrap();
    assert_eq!(
        updated.headers.get("Authorization").map(String::as_str),
        Some("Bearer plain-token")
    );

    let saved_value = store
        .values
        .lock()
        .await
        .get("mcp_servers")
        .cloned()
        .unwrap();
    assert_eq!(
        saved_value["mcpServers"]["remote-docs"]["headers"]["Authorization"],
        "Bearer plain-token"
    );
    assert_eq!(
        saved_value["mcpServers"]["remote-docs"]["headers"]["X-Existing"],
        "kept"
    );
    assert_eq!(
        saved_value["mcpServers"]["remote-docs"]["env"]["Authorization"],
        "process-env-token"
    );

    let cleared = service
        .clear_remote_authorization("remote-docs")
        .await
        .unwrap();
    assert!(!cleared.headers.contains_key("Authorization"));
    assert_eq!(
        cleared.env.get("Authorization").map(String::as_str),
        Some("process-env-token")
    );

    service.delete_server_config("remote-docs").await.unwrap();
    let deleted_value = store
        .values
        .lock()
        .await
        .get("mcp_servers")
        .cloned()
        .unwrap();
    assert!(deleted_value["mcpServers"]
        .as_object()
        .unwrap()
        .get("remote-docs")
        .is_none());
}

#[tokio::test]
async fn external_mcp_import_options_survive_load_save_and_legacy_round_trip() {
    let store = Arc::new(InMemoryMCPConfigStore::default());
    let service = MCPConfigService::new(store.clone());
    let directory = tempfile::tempdir().unwrap();
    let cwd = directory.path().to_string_lossy().into_owned();
    let timeouts = openbitfun_services_integrations::mcp::MCPServerTimeouts {
        startup_ms: Some(1250),
        catalog_ms: Some(2500),
        execution_ms: Some(60_000),
    };
    let snapshot = service.user_import_snapshot().await.unwrap();
    service
        .apply_user_import(
            &snapshot.fingerprint,
            vec![
                MCPImportServer {
                    environment: [("TOKEN".into(), "literal-secret".into())].into(),
                    headers: Default::default(),
                    source_id: Some("codex".into()),
                    native_id: "local".into(),
                    candidate_id: "deepseek-harness:mcp:local".into(),
                    behavior_version: "v1".into(),
                    display_name: "local".into(),
                    transport: MCPImportTransport::Local {
                        command: "node".into(),
                        args: vec!["./server.js".into()],
                    },
                    working_directory: Some(cwd.clone()),
                    timeouts,
                    oauth_enabled: None,
                },
                MCPImportServer {
                    environment: Default::default(),
                    headers: [("Authorization".into(), "Bearer header-secret".into())].into(),
                    source_id: Some("codex".into()),
                    native_id: "remote".into(),
                    candidate_id: "deepseek-harness:mcp:remote".into(),
                    behavior_version: "v1".into(),
                    display_name: "remote".into(),
                    transport: MCPImportTransport::Remote {
                        url: "https://example.test/mcp".into(),
                    },
                    working_directory: None,
                    timeouts,
                    oauth_enabled: Some(false),
                },
            ],
        )
        .await
        .unwrap();
    for id in ["local", "remote"] {
        let config = service.get_server_config(id).await.unwrap().unwrap();
        assert!(!config.enabled);
        assert!(!config.auto_start);
        assert_eq!(config.timeouts, timeouts);
        if id == "local" {
            assert_eq!(config.working_directory.as_deref(), Some(cwd.as_str()));
        } else {
            assert_eq!(config.oauth_enabled, Some(false));
            assert!(!config.remote_oauth_enabled());
        }
        service.save_server_config(&config).await.unwrap();
        let loaded = service.get_server_config(id).await.unwrap().unwrap();
        assert_eq!(loaded.timeouts, timeouts);
        assert_eq!(loaded.env, config.env);
        assert_eq!(loaded.headers, config.headers);
        assert_eq!(loaded.settings["_openbitfunImport"]["sourceId"], "codex");
        if id == "local" {
            assert_eq!(
                loaded.env.get("TOKEN").map(String::as_str),
                Some("literal-secret")
            );
        } else {
            assert_eq!(
                loaded.headers.get("Authorization").map(String::as_str),
                Some("Bearer header-secret")
            );
        }
        assert_eq!(loaded.working_directory, config.working_directory);
        assert_eq!(loaded.oauth_enabled, config.oauth_enabled);
    }
    let legacy = serde_json::json!({"mcpServers":{"legacy":{"command":"old-server"}}});
    let parsed = parse_cursor_format(&legacy);
    assert_eq!(parsed.len(), 1);
    assert!(parsed[0].timeouts.is_empty());
    assert!(parsed[0].working_directory.is_none());
    assert!(parsed[0].oauth_enabled.is_none());
    let round_trip =
        serde_json::json!({"mcpServers":{"legacy": config_to_cursor_format(&parsed[0])}});
    let reloaded = parse_cursor_format(&round_trip);
    assert_eq!(reloaded[0].command, parsed[0].command);
    assert!(reloaded[0].timeouts.is_empty());
}

#[test]
fn mcp_json_import_options_reject_malformed_values_before_saving() {
    for (key, value) in [
        ("timeouts", serde_json::json!({"executionMs": 0})),
        (
            "timeouts",
            serde_json::json!({"startupMs": 9_007_199_254_740_992u64}),
        ),
        ("timeouts", serde_json::json!({"executionMs": "60000"})),
        ("workingDirectory", serde_json::json!(false)),
        ("oauthEnabled", serde_json::json!("false")),
    ] {
        let mut config = serde_json::json!({"mcpServers":{"docs":{"command":"docs-server"}}});
        config["mcpServers"]["docs"][key] = value;
        assert!(
            validate_mcp_json_config(&config).is_err(),
            "accepted malformed {key}"
        );
    }
}

#[tokio::test]
async fn external_mcp_import_is_atomic_disabled_and_idempotence_visible() {
    let store = Arc::new(InMemoryMCPConfigStore::default());
    let service = MCPConfigService::new(store.clone());
    let snapshot = service.user_import_snapshot().await.unwrap();
    service
        .apply_user_import(
            &snapshot.fingerprint,
            vec![MCPImportServer {
                environment: Default::default(),
                headers: Default::default(),
                source_id: Some("codex".into()),
                working_directory: None,
                timeouts: Default::default(),
                oauth_enabled: None,
                native_id: "docs".to_string(),
                candidate_id: "opencode:mcp:docs".to_string(),
                behavior_version: "sha256:behavior-v1".to_string(),
                display_name: "Docs".to_string(),
                transport: MCPImportTransport::Local {
                    command: "docs-mcp".to_string(),
                    args: vec!["--stdio".to_string()],
                },
            }],
        )
        .await
        .unwrap();

    let stored = store.values.lock().await["mcp_servers"].clone();
    assert_eq!(stored["mcpServers"]["docs"]["enabled"], false);
    assert_eq!(stored["mcpServers"]["docs"]["autoStart"], false);
    assert_eq!(
        stored["mcpServers"]["docs"]["_openbitfunImport"]["sourceCandidateId"],
        "opencode:mcp:docs"
    );
    assert!(stored.get("_openbitfunImportJournal").is_none());

    let refreshed = service.user_import_snapshot().await.unwrap();
    assert_eq!(refreshed.imports.len(), 1);
    assert_eq!(refreshed.imports[0].native_id, "docs");
    let stale = service
        .apply_user_import(
            &snapshot.fingerprint,
            vec![MCPImportServer {
                environment: Default::default(),
                headers: Default::default(),
                source_id: Some("codex".into()),
                working_directory: None,
                timeouts: Default::default(),
                oauth_enabled: None,
                native_id: "other".to_string(),
                candidate_id: "opencode:mcp:other".to_string(),
                behavior_version: "sha256:behavior-v1".to_string(),
                display_name: "Other".to_string(),
                transport: MCPImportTransport::Remote {
                    url: "https://example.com/mcp".to_string(),
                },
            }],
        )
        .await
        .unwrap_err();
    assert!(matches!(stale, MCPImportError::StaleConfiguration));
}

#[tokio::test]
async fn stale_full_json_save_cannot_overwrite_a_concurrent_import() {
    let store = Arc::new(InMemoryMCPConfigStore::default());
    let service = MCPConfigService::new(store.clone());
    let editor_snapshot = service.user_json_config_snapshot().await.unwrap();
    let import_snapshot = service.user_import_snapshot().await.unwrap();

    service
        .apply_user_import(
            &import_snapshot.fingerprint,
            vec![MCPImportServer {
                environment: Default::default(),
                headers: Default::default(),
                source_id: Some("codex".into()),
                working_directory: None,
                timeouts: Default::default(),
                oauth_enabled: None,
                native_id: "docs".to_string(),
                candidate_id: "opencode:mcp:docs".to_string(),
                behavior_version: "sha256:behavior-v1".to_string(),
                display_name: "Docs".to_string(),
                transport: MCPImportTransport::Local {
                    command: "private-command".to_string(),
                    args: vec!["private-argument".to_string()],
                },
            }],
        )
        .await
        .unwrap();

    let replacement = serde_json::from_str(&editor_snapshot.json_config).unwrap();
    let error = service
        .replace_user_json_config(&editor_snapshot.fingerprint, replacement)
        .await
        .unwrap_err();
    assert!(matches!(error, MCPImportError::StaleConfiguration));
    assert!(store.values.lock().await["mcp_servers"]["mcpServers"]["docs"].is_object());
}

#[test]
fn import_debug_output_redacts_private_transport_values() {
    let import = MCPImportServer {
        environment: Default::default(),
        headers: Default::default(),
        source_id: Some("codex".into()),
        working_directory: None,
        timeouts: Default::default(),
        oauth_enabled: None,
        native_id: "docs".to_string(),
        candidate_id: "opencode:mcp:docs".to_string(),
        behavior_version: "sha256:behavior-v1".to_string(),
        display_name: "Docs".to_string(),
        transport: MCPImportTransport::Local {
            command: "private-command".to_string(),
            args: vec!["private-argument".to_string()],
        },
    };

    let rendered = format!("{import:?}");
    assert!(!rendered.contains("private-command"));
    assert!(!rendered.contains("private-argument"));
    assert!(rendered.contains("argument_count"));
}

#[tokio::test]
async fn mcp_config_service_keeps_load_failures_as_empty_baseline() {
    let service = MCPConfigService::new(Arc::new(FailingMCPConfigStore));

    let configs = service
        .load_all_configs()
        .await
        .expect("load failures are treated as empty config sources");
    assert!(configs.is_empty());

    let missing = service
        .get_server_config("missing")
        .await
        .expect("get_server_config also sees empty config sources");
    assert!(missing.is_none());

    let save_error = service
        .save_server_config(&make_mcp_config(
            "remote-docs",
            ConfigLocation::User,
            MCPServerType::Remote,
            None,
            Some("https://example.com/mcp"),
        ))
        .await
        .expect_err("writes must still surface config backend failures");
    assert_eq!(save_error.kind(), MCPRuntimeErrorKind::Configuration);
}

#[tokio::test]
async fn mcp_dynamic_tool_provider_preserves_manifest_contract() {
    let provider = MCPDynamicToolProvider::new("github", "GitHub");
    let definitions = provider
        .load_tool_definitions(&FakeMCPToolCatalogClient {
            tools: vec![MCPTool {
                name: "search".to_string(),
                title: Some("Search".to_string()),
                description: Some("Search repositories".to_string()),
                input_schema: serde_json::json!({
                    "type": "object",
                    "properties": {
                        "query": { "type": "string" }
                    }
                }),
                output_schema: None,
                icons: None,
                annotations: Some(MCPToolAnnotations {
                    title: Some("Search".to_string()),
                    read_only_hint: Some(true),
                    destructive_hint: Some(false),
                    idempotent_hint: Some(true),
                    open_world_hint: Some(false),
                }),
                meta: None,
            }],
        })
        .await
        .unwrap();

    assert_eq!(definitions.len(), 1);
    assert_eq!(definitions[0].mcp_tool.name, "search");
    assert_eq!(definitions[0].descriptor.full_name, "mcp__github__search");
    assert_eq!(definitions[0].descriptor.provider_id, "github");
    assert_eq!(definitions[0].descriptor.tool_info.server_name, "GitHub");
    assert!(definitions[0].descriptor.read_only);
}

#[tokio::test]
async fn mcp_dynamic_tool_provider_preserves_manifest_order_and_metadata_snapshot() {
    let provider = MCPDynamicToolProvider::new("docs-prod", "Docs Production");
    let definitions = provider
        .load_tool_definitions(&FakeMCPToolCatalogClient {
            tools: vec![
                MCPTool {
                    name: "lookup".to_string(),
                    title: None,
                    description: Some("Lookup docs".to_string()),
                    input_schema: serde_json::json!({ "type": "object" }),
                    output_schema: None,
                    icons: None,
                    annotations: Some(MCPToolAnnotations {
                        title: Some("Lookup".to_string()),
                        read_only_hint: Some(true),
                        destructive_hint: None,
                        idempotent_hint: Some(true),
                        open_world_hint: Some(false),
                    }),
                    meta: None,
                },
                MCPTool {
                    name: "write-note".to_string(),
                    title: Some("Write Note".to_string()),
                    description: None,
                    input_schema: serde_json::json!({ "type": "object" }),
                    output_schema: None,
                    icons: None,
                    annotations: Some(MCPToolAnnotations {
                        title: None,
                        read_only_hint: Some(false),
                        destructive_hint: Some(true),
                        idempotent_hint: Some(false),
                        open_world_hint: None,
                    }),
                    meta: None,
                },
            ],
        })
        .await
        .unwrap();

    let snapshot = definitions
        .iter()
        .map(|definition| {
            (
                definition.descriptor.full_name.as_str(),
                definition.descriptor.title.as_str(),
                definition.descriptor.provider_id.as_str(),
                definition.descriptor.provider_kind.as_str(),
                definition.descriptor.tool_info.tool_name.as_str(),
                definition.descriptor.read_only,
            )
        })
        .collect::<Vec<_>>();
    assert_eq!(
        snapshot,
        vec![
            (
                "mcp__docs-prod__lookup",
                "Lookup",
                "docs-prod",
                "mcp",
                "lookup",
                true
            ),
            (
                "mcp__docs-prod__write-note",
                "Write Note",
                "docs-prod",
                "mcp",
                "write-note",
                false,
            ),
        ]
    );
}

#[tokio::test]
async fn mcp_runtime_state_owner_preserves_unsupported_remote_transport_contract() {
    let mut config = make_mcp_config(
        "remote-sse",
        ConfigLocation::User,
        MCPServerType::Remote,
        None,
        Some("https://example.com/mcp"),
    );
    config.transport = Some(MCPServerTransport::Sse);

    let runtime = MCPServerRuntimeState::new();
    runtime.register(&config).await.expect("register process");
    assert_eq!(
        runtime
            .process_status("remote-sse")
            .await
            .expect("registered process status"),
        MCPServerStatus::Uninitialized
    );

    let error = runtime
        .start_process(
            &config,
            MCPProcessStartContext::Remote {
                data_dir: std::env::temp_dir(),
            },
        )
        .await
        .unwrap_err();
    assert_eq!(error.kind(), MCPRuntimeErrorKind::NotImplemented);
    assert!(error
        .to_string()
        .contains("Remote MCP transport 'sse' is not yet supported"));
    assert_eq!(
        runtime
            .process_status("remote-sse")
            .await
            .expect("registered process status"),
        MCPServerStatus::Uninitialized
    );
    assert!(runtime.process_connection("remote-sse").await.is_none());

    let pool = MCPConnectionPool::new();
    assert!(pool.get_all_server_ids().await.is_empty());
}

#[test]
fn mcp_config_location_preserves_kebab_case_wire_contract() {
    assert_eq!(
        serde_json::to_value(ConfigLocation::BuiltIn).unwrap(),
        serde_json::json!("built-in")
    );
    assert_eq!(
        serde_json::from_value::<ConfigLocation>(serde_json::json!("user")).unwrap(),
        ConfigLocation::User
    );
    assert_eq!(
        serde_json::from_value::<ConfigLocation>(serde_json::json!("project")).unwrap(),
        ConfigLocation::Project
    );
}

#[test]
fn mcp_json_config_helpers_preserve_load_format_and_save_validation_contract() {
    let legacy_array = serde_json::json!([
        {
            "id": "local",
            "name": "Local",
            "type": "local",
            "command": "npx"
        }
    ]);
    assert_eq!(
        serde_json::from_str::<serde_json::Value>(
            &format_mcp_json_config_value(Some(&legacy_array)).unwrap()
        )
        .unwrap(),
        serde_json::json!({
            "mcpServers": {
                "local": {
                    "id": "local",
                    "name": "Local",
                    "type": "local",
                    "command": "npx"
                }
            }
        })
    );
    assert_eq!(
        serde_json::from_str::<serde_json::Value>(&format_mcp_json_config_value(None).unwrap())
            .unwrap(),
        serde_json::json!({ "mcpServers": {} })
    );

    validate_mcp_json_config(&serde_json::json!({
        "mcpServers": {
            "remote": {
                "type": "sse",
                "url": "https://example.com/sse",
                "headers": {
                    "Authorization": "Bearer token"
                }
            }
        }
    }))
    .expect("valid remote SSE config");

    assert_eq!(
        validate_mcp_json_config(&serde_json::json!({}))
            .unwrap_err()
            .to_string(),
        "Config missing 'mcpServers' field"
    );
    assert_eq!(
        validate_mcp_json_config(&serde_json::json!({
            "mcpServers": {
                "bad": {
                    "type": "container",
                    "command": "docker"
                }
            }
        }))
        .unwrap_err()
        .to_string(),
        "Server 'bad' has unsupported 'type' value: 'container'"
    );
    assert_eq!(
        validate_mcp_json_config(&serde_json::json!({
            "mcpServers": {
                "bad": {
                    "source": "remote",
                    "command": "npx"
                }
            }
        }))
        .unwrap_err()
        .to_string(),
        "Server 'bad' source='remote' conflicts with command-based configuration"
    );
}

#[test]
fn mcp_config_merge_helpers_preserve_precedence_and_dedup_contract() {
    let merged = merge_mcp_server_config_sources([
        vec![make_mcp_config(
            "github-user",
            ConfigLocation::User,
            MCPServerType::Remote,
            None,
            Some("https://example.com/mcp"),
        )],
        vec![
            make_mcp_config(
                "github-user",
                ConfigLocation::Project,
                MCPServerType::Remote,
                None,
                Some("https://project.example.com/mcp"),
            ),
            make_mcp_config(
                "github-project",
                ConfigLocation::Project,
                MCPServerType::Remote,
                None,
                Some("https://example.com/mcp"),
            ),
        ],
    ]);

    assert_eq!(merged.len(), 2);
    assert_eq!(merged[0].id, "github-user");
    assert_eq!(merged[0].location, ConfigLocation::Project);
    assert_eq!(
        merged[0].url.as_deref(),
        Some("https://project.example.com/mcp")
    );
    assert_eq!(merged[1].id, "github-project");
    assert_eq!(merged[1].location, ConfigLocation::Project);

    let deduped = merge_mcp_server_config_sources([
        vec![make_mcp_config(
            "github-user",
            ConfigLocation::User,
            MCPServerType::Remote,
            None,
            Some("https://example.com/mcp"),
        )],
        vec![make_mcp_config(
            "github-project",
            ConfigLocation::Project,
            MCPServerType::Remote,
            None,
            Some("https://example.com/mcp"),
        )],
    ]);
    assert_eq!(deduped.len(), 1);
    assert_eq!(deduped[0].id, "github-project");
    assert_eq!(deduped[0].location, ConfigLocation::Project);
}

#[test]
fn mcp_config_authorization_helpers_use_only_canonical_headers() {
    let mut config = make_mcp_config(
        "remote-auth",
        ConfigLocation::User,
        MCPServerType::Remote,
        None,
        Some("https://example.com/mcp"),
    );
    config
        .env
        .insert("Authorization".to_string(), "process-env-token".to_string());
    config.headers.insert(
        "Authorization".to_string(),
        "Bearer header-token".to_string(),
    );

    assert_eq!(
        get_mcp_remote_authorization_value(&config).as_deref(),
        Some("Bearer header-token")
    );
    assert_eq!(
        get_mcp_remote_authorization_source(&config),
        Some("headers")
    );
    assert!(has_mcp_remote_authorization(&config));
    assert!(!has_mcp_remote_oauth(&config));
    assert!(!has_mcp_remote_xaa(&config));
    assert_eq!(
        normalize_mcp_authorization_value("plain-token").as_deref(),
        Some("Bearer plain-token")
    );
    assert_eq!(
        normalize_mcp_authorization_value("Bearer existing").as_deref(),
        Some("Bearer existing")
    );
    assert_eq!(normalize_mcp_authorization_value("   "), None);

    remove_mcp_authorization_keys(&mut config.headers);
    assert_eq!(get_mcp_remote_authorization_value(&config), None);
    assert_eq!(get_mcp_remote_authorization_source(&config), None);
    assert_eq!(
        config.env.get("Authorization").map(String::as_str),
        Some("process-env-token")
    );
}

#[test]
fn mcp_server_type_and_status_preserve_lowercase_wire_contract() {
    assert_eq!(
        serde_json::to_value(MCPServerType::Local).unwrap(),
        serde_json::json!("local")
    );
    assert_eq!(
        serde_json::from_value::<MCPServerType>(serde_json::json!("remote")).unwrap(),
        MCPServerType::Remote
    );
    assert_eq!(
        serde_json::to_value(MCPServerStatus::NeedsAuth).unwrap(),
        serde_json::json!("needsauth")
    );
    assert_eq!(
        serde_json::from_value::<MCPServerStatus>(serde_json::json!("reconnecting")).unwrap(),
        MCPServerStatus::Reconnecting
    );
}

#[tokio::test]
async fn mcp_runtime_state_owns_registry_runtime_config_and_reconnect_state() {
    let runtime = MCPServerRuntimeState::new();
    let mut config = make_mcp_config(
        "runtime-only",
        ConfigLocation::User,
        MCPServerType::Local,
        Some("node"),
        None,
    );
    config.auto_start = false;

    assert!(runtime.is_empty().await);
    let error = runtime
        .start_process(
            &config,
            MCPProcessStartContext::Remote {
                data_dir: std::env::temp_dir(),
            },
        )
        .await
        .expect_err("local config must reject remote start context");
    assert_eq!(error.kind(), MCPRuntimeErrorKind::Configuration);
    assert!(error
        .to_string()
        .contains("does not match server type 'local'"));
    assert!(runtime.is_empty().await);

    runtime
        .insert_runtime_config(config.clone())
        .await
        .expect("insert runtime config");
    runtime
        .register(&config)
        .await
        .expect("register runtime process");

    assert!(runtime.contains("runtime-only").await);
    assert_eq!(runtime.get_all_server_ids().await, vec!["runtime-only"]);
    assert_eq!(
        runtime
            .process_status("runtime-only")
            .await
            .expect("registered process status"),
        MCPServerStatus::Uninitialized
    );
    assert!(runtime.process_connection("runtime-only").await.is_none());
    assert_eq!(
        runtime.get_all_statuses().await,
        vec![("runtime-only".to_string(), MCPServerStatus::Uninitialized)]
    );
    assert_eq!(
        runtime
            .get_runtime_config("runtime-only")
            .await
            .expect("runtime config")
            .command
            .as_deref(),
        Some("node")
    );

    runtime.clear_reconnect_state("runtime-only").await;
    runtime.remove_catalog("runtime-only").await;
    runtime
        .unregister("runtime-only")
        .await
        .expect("unregister");
    runtime.remove_runtime_config("runtime-only").await;

    assert!(runtime.is_empty().await);
    assert!(runtime.get_runtime_config("runtime-only").await.is_none());
}

#[test]
fn mcp_runtime_policy_preserves_status_transition_contract() {
    let mut config = make_mcp_config(
        "local",
        ConfigLocation::User,
        MCPServerType::Local,
        Some("node"),
        None,
    );

    assert!(mcp_server_is_running(MCPServerStatus::Connected));
    assert!(mcp_server_is_running(MCPServerStatus::Healthy));
    assert!(!mcp_server_is_running(MCPServerStatus::Starting));

    assert!(mcp_should_start_after_config_update(
        &config,
        MCPServerStatus::Failed
    ));
    assert!(mcp_should_start_after_config_update(
        &config,
        MCPServerStatus::NeedsAuth
    ));
    assert!(!mcp_should_start_after_config_update(
        &config,
        MCPServerStatus::Connected
    ));

    assert_eq!(
        mcp_reconnect_runtime_decision(&config, MCPServerStatus::Failed),
        MCPReconnectRuntimeDecision::Retry
    );
    assert_eq!(
        mcp_reconnect_runtime_decision(&config, MCPServerStatus::NeedsAuth),
        MCPReconnectRuntimeDecision::Clear
    );
    assert_eq!(
        mcp_reconnect_runtime_decision(&config, MCPServerStatus::Starting),
        MCPReconnectRuntimeDecision::Clear
    );
    assert_eq!(
        mcp_reconnect_runtime_decision(&config, MCPServerStatus::Stopped),
        MCPReconnectRuntimeDecision::Skip
    );
    assert_eq!(
        mcp_reconnect_runtime_decision(&config, MCPServerStatus::Uninitialized),
        MCPReconnectRuntimeDecision::Skip
    );

    config.auto_start = false;
    assert_eq!(
        mcp_reconnect_runtime_decision(&config, MCPServerStatus::Failed),
        MCPReconnectRuntimeDecision::Clear
    );
    config.auto_start = true;
    config.enabled = false;
    assert_eq!(
        mcp_reconnect_runtime_decision(&config, MCPServerStatus::Failed),
        MCPReconnectRuntimeDecision::Clear
    );
}

#[test]
fn mcp_runtime_auth_error_classifier_preserves_process_status_contract() {
    assert!(is_mcp_auth_error_message(
        "Handshake failed: Unauthorized (401)"
    ));
    assert!(is_mcp_auth_error_message(
        "Ping failed: OAuth token refresh failed: no refresh token available"
    ));
    assert!(is_mcp_auth_error_message(
        "remote server returned status code: 403"
    ));
    assert!(!is_mcp_auth_error_message(
        "Handshake failed: connection reset"
    ));
}

#[test]
fn mcp_server_config_preserves_transport_defaults_and_validation_contract() {
    let local = MCPServerConfig {
        id: "local".to_string(),
        name: "Local".to_string(),
        server_type: MCPServerType::Local,
        transport: None,
        command: Some("npx".to_string()),
        args: vec!["server".to_string()],
        env: Default::default(),
        working_directory: None,
        inherit_parent_environment: None,
        headers: Default::default(),
        url: None,
        auto_start: true,
        enabled: true,
        location: ConfigLocation::User,
        capabilities: Vec::new(),
        settings: Default::default(),
        oauth: None,
        oauth_enabled: None,
        xaa: None,
        timeouts: MCPServerTimeouts::default(),
    };
    assert_eq!(local.resolved_transport(), MCPServerTransport::Stdio);
    local.validate().expect("local stdio config is valid");

    let mut remote = local.clone();
    remote.id = "remote".to_string();
    remote.name = "Remote".to_string();
    remote.server_type = MCPServerType::Remote;
    remote.command = None;
    remote.transport = None;
    assert_eq!(
        remote.validate().unwrap_err().to_string(),
        "Remote MCP server 'remote' must have a URL"
    );

    remote.url = Some("https://example.com/mcp".to_string());
    assert_eq!(
        remote.resolved_transport(),
        MCPServerTransport::StreamableHttp
    );
    remote
        .validate()
        .expect("remote streamable-http config is valid");
}

#[test]
fn mcp_server_config_preserves_an_optional_local_working_directory() {
    let config: MCPServerConfig = serde_json::from_value(serde_json::json!({
        "id": "external-local",
        "name": "External local",
        "type": "local",
        "command": "node",
        "args": ["server.js"],
        "workingDirectory": "C:/workspace/project",
        "autoStart": true,
        "enabled": true,
        "location": "built-in",
        "capabilities": [],
        "settings": {}
    }))
    .unwrap();

    assert_eq!(
        config.working_directory.as_deref(),
        Some("C:/workspace/project")
    );
    assert_eq!(
        serde_json::to_value(config).unwrap()["workingDirectory"],
        "C:/workspace/project"
    );
}

#[test]
fn remote_mcp_oauth_can_be_explicitly_disabled_without_changing_legacy_default() {
    let disabled: MCPServerConfig = serde_json::from_value(serde_json::json!({
        "id": "remote-static-auth",
        "name": "Remote static auth",
        "type": "remote",
        "transport": "streamable-http",
        "url": "https://example.test/mcp",
        "oauthEnabled": false,
        "location": "built-in"
    }))
    .unwrap();
    assert!(!disabled.remote_oauth_enabled());

    let legacy: MCPServerConfig = serde_json::from_value(serde_json::json!({
        "id": "remote-legacy",
        "name": "Remote legacy",
        "type": "remote",
        "transport": "streamable-http",
        "url": "https://example.test/mcp",
        "location": "user"
    }))
    .unwrap();
    assert!(legacy.remote_oauth_enabled());
}

#[test]
fn local_mcp_can_disable_parent_environment_inheritance_without_changing_legacy_default() {
    let restricted: MCPServerConfig = serde_json::from_value(serde_json::json!({
        "id": "external-local",
        "name": "External local",
        "type": "local",
        "command": "node",
        "args": [],
        "env": {"ALLOWED_TOKEN": "explicit"},
        "inheritParentEnvironment": false,
        "autoStart": true,
        "enabled": true,
        "location": "built-in"
    }))
    .unwrap();
    assert!(!restricted.inherits_parent_environment());

    let legacy = make_mcp_config(
        "legacy-local",
        ConfigLocation::User,
        MCPServerType::Local,
        Some("node"),
        None,
    );
    assert!(legacy.inherits_parent_environment());
}

#[test]
fn mcp_oauth_session_snapshot_preserves_camel_case_status_contract() {
    let snapshot = MCPRemoteOAuthSessionSnapshot::new(
        "remote-server",
        MCPRemoteOAuthStatus::AwaitingBrowser,
        Some("https://auth.example.com/start".to_string()),
        Some("http://127.0.0.1:49152/oauth/callback".to_string()),
        None,
    );

    assert_eq!(
        serde_json::to_value(&snapshot).unwrap(),
        serde_json::json!({
            "serverId": "remote-server",
            "status": "awaitingBrowser",
            "authorizationUrl": "https://auth.example.com/start",
            "redirectUri": "http://127.0.0.1:49152/oauth/callback"
        })
    );
}

#[test]
fn mcp_oauth_owner_exports_the_auth_primitives_needed_by_compatibility_facades() {
    fn assert_credential_store<T: CredentialStore>() {}

    assert_credential_store::<MCPRemoteOAuthCredentialStore>();
    let _: Option<AuthorizationManager> = None;
    let _: Option<StoredCredentials> = None;
}

#[tokio::test]
async fn mcp_oauth_credential_vault_uses_injected_data_dir_and_roundtrips_credentials() {
    let unique = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .unwrap()
        .as_nanos();
    let data_dir = std::env::temp_dir().join(format!(
        "openbitfun-mcp-oauth-vault-contract-{}-{}",
        std::process::id(),
        unique
    ));

    let vault = MCPRemoteOAuthCredentialVault::new(data_dir.clone());
    let credentials = StoredCredentials::new("client-123".to_string(), None, Vec::new(), None);

    vault
        .store("server-a", &credentials)
        .await
        .expect("store credentials");

    assert!(data_dir.join(".mcp_oauth_vault.key").exists());
    assert!(data_dir.join("mcp_oauth_vault.json").exists());

    let loaded = vault
        .load("server-a")
        .await
        .expect("load credentials")
        .expect("stored credentials");
    assert_eq!(loaded.client_id, "client-123");
    assert!(loaded.token_response.is_none());

    vault.clear("server-a").await.expect("clear credentials");
    assert!(vault
        .load("server-a")
        .await
        .expect("load after clear")
        .is_none());

    let _ = std::fs::remove_dir_all(data_dir);
}

#[test]
fn mcp_cursor_oauth_policy_survives_validation_and_roundtrip() {
    for (options, expected) in [
        (serde_json::json!({}), None),
        (serde_json::json!({ "oauth": false }), Some(false)),
        (serde_json::json!({ "oauth": true }), Some(true)),
        (serde_json::json!({ "oauthEnabled": false }), Some(false)),
        (serde_json::json!({ "oauth": { "scopes": ["read"] } }), None),
        (
            serde_json::json!({ "oauth": { "scopes": ["read"] }, "oauthEnabled": false }),
            Some(false),
        ),
    ] {
        let mut server = serde_json::json!({ "url": "https://example.test/mcp" });
        server
            .as_object_mut()
            .unwrap()
            .extend(options.as_object().unwrap().clone());
        let input = serde_json::json!({ "mcpServers": { "test": server } });
        validate_mcp_json_config(&input).unwrap();
        let parsed = parse_cursor_format(&input);
        assert_eq!(parsed.len(), 1);
        assert_eq!(parsed[0].oauth_enabled, expected);
        assert_eq!(parsed[0].remote_oauth_enabled(), expected.unwrap_or(true));

        let exported = config_to_cursor_format(&parsed[0]);
        if options.get("oauth") == Some(&serde_json::json!(false)) {
            assert_eq!(exported["oauth"], false);
        }
        let saved = serde_json::json!({ "mcpServers": { "test": exported } });
        validate_mcp_json_config(&saved).unwrap();
        let reparsed = parse_cursor_format(&saved);
        assert_eq!(reparsed[0].oauth_enabled, expected);
        assert_eq!(
            serde_json::to_value(&reparsed[0].oauth).unwrap(),
            serde_json::to_value(&parsed[0].oauth).unwrap()
        );
    }
}

#[test]
fn mcp_cursor_oauth_validation_rejects_invalid_or_conflicting_policy() {
    for options in [
        serde_json::json!({ "oauth": "false" }),
        serde_json::json!({ "oauth": [] }),
        serde_json::json!({ "oauthEnabled": "false" }),
        serde_json::json!({ "oauth": false, "oauthEnabled": true }),
        serde_json::json!({ "oauth": true, "oauthEnabled": false }),
    ] {
        let mut server = serde_json::json!({ "url": "https://example.test/mcp" });
        server
            .as_object_mut()
            .unwrap()
            .extend(options.as_object().unwrap().clone());
        assert!(
            validate_mcp_json_config(&serde_json::json!({ "mcpServers": { "test": server } }))
                .is_err()
        );
    }
}

#[test]
fn mcp_cursor_oauth_policy_is_part_of_config_identity() {
    let disabled = parse_cursor_format(&serde_json::json!({
        "mcpServers": { "disabled": { "url": "https://example.test/mcp", "oauth": false } }
    }));
    let legacy = parse_cursor_format(&serde_json::json!({
        "mcpServers": { "legacy": { "url": "https://example.test/mcp" } }
    }));
    let merged = merge_mcp_server_config_sources([disabled, legacy]);
    assert_eq!(merged.len(), 2);
    assert!(!merged[0].remote_oauth_enabled());
    assert!(merged[1].remote_oauth_enabled());
}

#[test]
fn mcp_cursor_format_helpers_preserve_cursor_compatibility_contract() {
    let remote = MCPServerConfig {
        id: "remote-sse".to_string(),
        name: "Remote SSE".to_string(),
        server_type: MCPServerType::Remote,
        transport: Some(MCPServerTransport::Sse),
        command: None,
        args: Vec::new(),
        env: Default::default(),
        working_directory: None,
        inherit_parent_environment: None,
        headers: std::collections::HashMap::from([(
            "Authorization".to_string(),
            "Bearer token".to_string(),
        )]),
        url: Some("https://example.com/sse".to_string()),
        auto_start: false,
        enabled: true,
        location: ConfigLocation::User,
        capabilities: Vec::new(),
        settings: Default::default(),
        oauth: None,
        oauth_enabled: None,
        xaa: None,
        timeouts: MCPServerTimeouts::default(),
    };

    assert_eq!(
        config_to_cursor_format(&remote),
        serde_json::json!({
            "type": "sse",
            "name": "Remote SSE",
            "enabled": true,
            "autoStart": false,
            "headers": {
                "Authorization": "Bearer token"
            },
            "url": "https://example.com/sse"
        })
    );

    let parsed = parse_cursor_format(&serde_json::json!({
        "mcpServers": {
            "remote-sse": {
                "type": "sse",
                "url": "https://example.com/sse"
            },
            "unsupported": {
                "type": "container",
                "command": "docker",
                "args": ["run", "--rm", "-i", "example/server"]
            }
        }
    }));

    assert_eq!(parsed.len(), 1);
    assert_eq!(parsed[0].id, "remote-sse");
    assert_eq!(parsed[0].server_type, MCPServerType::Remote);
    assert_eq!(parsed[0].transport, Some(MCPServerTransport::Sse));
    assert_eq!(parsed[0].location, ConfigLocation::User);
}

#[test]
fn mcp_config_accepts_camel_case_streamable_http_type() {
    // Cursor, Cline, and other MCP clients emit `type: "streamableHttp"`.
    // OpenBitFun must accept it (and other casings) as streamable HTTP.
    let config = serde_json::json!({
        "mcpServers": {
            "remote": {
                "type": "streamableHttp",
                "url": "https://example.com/mcp"
            }
        }
    });

    validate_mcp_json_config(&config).expect("camelCase streamableHttp type must validate");

    let parsed = parse_cursor_format(&config);
    assert_eq!(parsed.len(), 1);
    assert_eq!(parsed[0].server_type, MCPServerType::Remote);
    assert_eq!(
        parsed[0].transport,
        Some(MCPServerTransport::StreamableHttp)
    );

    for alias in [
        "streamable-http",
        "streamable_http",
        "streamablehttp",
        "HTTP",
    ] {
        validate_mcp_json_config(&serde_json::json!({
            "mcpServers": {
                "alias": { "type": alias, "url": "https://example.com/mcp" }
            }
        }))
        .unwrap_or_else(|error| panic!("type '{}' must validate: {}", alias, error));
    }
}

#[test]
fn mcp_config_normalizes_token_case_for_type_transport_and_source() {
    // The visual editor lowercases `type`, `transport`, and `source` before
    // matching. The core validator and parser must agree, otherwise a config
    // the form renders happily fails again when the document is saved.
    let cases = [
        (
            serde_json::json!({ "type": "StreamableHTTP", "url": "https://example.com/mcp" }),
            "streamable-http",
            MCPServerTransport::StreamableHttp,
        ),
        (
            serde_json::json!({
                "transport": "STREAMABLE-HTTP",
                "url": "https://example.com/mcp"
            }),
            "streamable-http",
            MCPServerTransport::StreamableHttp,
        ),
        (
            serde_json::json!({
                "source": "REMOTE",
                "transport": "SSE",
                "url": "https://example.com/sse"
            }),
            "sse",
            MCPServerTransport::Sse,
        ),
        (
            serde_json::json!({ "source": "Local", "command": "npx", "args": ["-y", "server"] }),
            "stdio",
            MCPServerTransport::Stdio,
        ),
    ];

    for (server, canonical_type, transport) in cases {
        let config = serde_json::json!({ "mcpServers": { "case": server.clone() } });

        validate_mcp_json_config(&config)
            .unwrap_or_else(|error| panic!("'{}' must validate: {}", server, error));

        let parsed = parse_cursor_format(&config);
        assert_eq!(
            parsed.len(),
            1,
            "'{}' must be parsed instead of silently dropped",
            server
        );
        assert_eq!(parsed[0].transport, Some(transport), "for '{}'", server);

        // Accepting a spelling must not change the canonical token we persist.
        let written = config_to_cursor_format(&parsed[0]);
        assert_eq!(
            written["type"].as_str(),
            Some(canonical_type),
            "'{}' must persist the canonical token",
            server
        );
    }
}
