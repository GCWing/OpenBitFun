#[cfg(feature = "mcp-bridge")]
use openbitfun_agent_tools::validate_mcp_tool_bridge_input;
#[cfg(feature = "acp-bridge")]
use openbitfun_agent_tools::{
    acp_external_agent_tool_input_schema, build_acp_external_agent_tool_definition,
    build_acp_external_agent_tool_name, build_acp_external_agent_tool_result,
    normalize_name_for_acp_tool_part, render_acp_external_agent_rejected_message,
    render_acp_external_agent_result_for_assistant, render_acp_external_agent_result_message,
    render_acp_external_agent_use_message, validate_acp_external_agent_tool_input,
    AcpExternalAgentToolDefinitionInput, ACP_TOOL_PREFIX, ACP_TOOL_SUFFIX,
};
use openbitfun_agent_tools::{
    build_get_tool_spec_assistant_detail, build_get_tool_spec_detail_result,
    build_get_tool_spec_duplicate_load_hint, build_get_tool_spec_duplicate_load_result,
    build_openbitfun_runtime_uri, build_prompt_visible_tool_manifest_definitions,
    build_tool_execution_timeout_presentation, build_tool_path_policy_denial_message,
    build_tool_runtime_artifact_reference, build_tool_session_runtime_artifact_reference,
    call_deferred_tool_description, call_deferred_tool_input_schema,
    collect_loaded_deferred_tool_specs, effective_tool_invocation, get_tool_spec_input_schema,
    get_tool_spec_is_concurrency_safe, get_tool_spec_is_readonly, get_tool_spec_short_description,
    is_openbitfun_runtime_uri, is_remote_posix_path_within_root,
    is_tool_path_allowed_by_resolved_roots, normalize_host_path, normalize_runtime_relative_path,
    parse_openbitfun_current_session_uri, parse_openbitfun_runtime_uri,
    posix_resolve_path_with_workspace, posix_style_path_is_absolute,
    render_get_tool_spec_tool_use_message, resolve_contextual_tool_manifest,
    resolve_contextual_tool_manifest_from_provider, resolve_get_tool_spec_detail,
    resolve_get_tool_spec_detail_from_provider,
    resolve_get_tool_spec_execution_result_from_provider, resolve_host_path_with_workspace,
    resolve_readonly_enabled_tools, resolve_tool_manifest_policy, resolve_tool_path_with_context,
    resolve_tool_path_with_context_roots, resolve_workspace_tool_path,
    sort_tool_manifest_definitions, summarize_get_tool_spec_deferred_tools,
    tool_path_is_effectively_absolute, tool_restrictions_for_delegation_policy,
    validate_deferred_tool_usage, validate_get_tool_spec_input, validate_tool_allowed_by_list,
    validate_tool_execution_admission, CallDeferredToolInputError, DynamicMcpToolInfo,
    DynamicToolInfo, GetToolSpecDeferredToolSummary, GetToolSpecExecutionError,
    GetToolSpecExecutionPlan, GetToolSpecLoadObservation, GetToolSpecRuntime, InputValidator,
    LoadedDeferredToolSpec, PromptVisibleToolManifestItem, ResolvedToolInvocation,
    ToolContextFacts, ToolExecutionAdmissionRejection, ToolExecutionAdmissionRequest, ToolExposure,
    ToolImageAttachment, ToolManifestDefinition, ToolManifestPolicyTool, ToolPathBackend,
    ToolPathOperation, ToolPathResolution, ToolRenderOptions, ToolResult, ToolRuntimeRestrictions,
    ToolWorkspaceKind, ValidationResult, CALL_DEFERRED_TOOL_NAME, GET_TOOL_SPEC_TOOL_NAME,
};
use openbitfun_agent_tools::{
    build_invalid_tool_call_error_message, build_normal_tool_json_repair_notice,
    build_permission_denied_tool_presentation, build_tool_execution_error_presentation,
    build_user_rejected_tool_presentation, build_user_rejected_tool_presentation_with_instruction,
    build_user_steering_interrupted_presentation, is_write_like_tool_name,
    render_tool_result_for_assistant, truncate_raw_tool_arguments_preview_to,
    TOOL_ERROR_ARGUMENTS_PREVIEW_BYTES, USER_REJECTED_TOOL_MESSAGE,
    USER_STEERING_INTERRUPTED_MESSAGE,
};
#[cfg(feature = "mcp-bridge")]
use openbitfun_agent_tools::{
    build_mcp_tool_bridge_definition, build_mcp_tool_bridge_name, build_mcp_tool_bridge_result,
    mcp_tool_bridge_dynamic_tool_info, mcp_tool_bridge_short_description, normalize_name_for_mcp,
    render_mcp_tool_bridge_rejected_message, render_mcp_tool_bridge_result_message,
    render_mcp_tool_bridge_use_message, McpToolBridgeBehaviorHints, McpToolBridgeDefinitionInput,
    MCP_TOOL_DELIMITER, MCP_TOOL_PREFIX,
};
use openbitfun_agent_tools::{
    build_persisted_tool_output_message, count_tool_result_lines, file_tool_guidance_message,
    generate_tool_result_preview, is_file_tool_guidance_message,
    sanitize_tool_result_file_component, select_tool_result_indices_for_persistence,
    tool_result_is_persisted_output, PersistedToolOutput, ToolResultPersistenceCandidate,
    FILE_TOOL_GUIDANCE_PREFIX, PERSISTED_OUTPUT_TAG, TOOL_RESULT_PREVIEW_CHARS,
};
use openbitfun_agent_tools::{
    materialize_static_tool_provider_groups, ContextualToolManifestItem, DynamicToolDescriptor,
    DynamicToolProvider, GetToolSpecCatalogProvider, PortResult, PortableToolContextProvider,
    StaticToolMaterializationError, StaticToolProvider, StaticToolProviderFactory,
    StaticToolProviderGroup, StaticToolProviderPlan, ToolCallSnapshotGuard, ToolCatalogRuntime,
    ToolCatalogSnapshotProvider, ToolDecorator, ToolDecoratorRef, ToolEffectFactsSource,
    ToolEffectFilter, ToolRegistry, ToolRegistryItem, ToolRuntimeAssembly, ToolSnapshotCallError,
};
use serde_json::json;
use std::path::PathBuf;
use std::sync::Arc;

struct TestProviderPlan {
    provider_id: &'static str,
    tool_names: &'static [&'static str],
}

impl StaticToolProviderPlan for TestProviderPlan {
    fn provider_id(&self) -> &'static str {
        self.provider_id
    }

    fn tool_names(&self) -> &'static [&'static str] {
        self.tool_names
    }
}

#[test]
fn call_deferred_tool_contract_uses_nested_object_arguments() {
    let schema = call_deferred_tool_input_schema();

    assert!(call_deferred_tool_description()
        .contains("The order is important. ALWAYS output tool_name first, then args."));
    assert!(call_deferred_tool_description()
        .contains("If compaction or truncation removed it, reload it with GetToolSpec first"));
    assert_eq!(schema["additionalProperties"], false);
    assert_eq!(schema["required"], json!(["tool_name", "args"]));
    assert_eq!(schema["properties"]["args"]["type"], "object");
    assert_eq!(schema["properties"]["args"]["additionalProperties"], true);

    let invocation = ResolvedToolInvocation::from_wire_call(
        CALL_DEFERRED_TOOL_NAME,
        json!({
            "tool_name": "get_weather",
            "args": { "city": "Shanghai" }
        }),
    )
    .expect("valid deferred tool invocation");

    assert!(invocation.is_deferred());
    assert_eq!(invocation.wire_tool_name, CALL_DEFERRED_TOOL_NAME);
    assert_eq!(invocation.effective_tool_name, "get_weather");
    assert_eq!(
        invocation.effective_arguments,
        json!({ "city": "Shanghai" })
    );
}

#[test]
fn effective_tool_invocation_borrows_deferred_identity_from_wire_call() {
    let arguments = json!({
        "tool_name": "get_weather",
        "args": { "city": "Shanghai" }
    });

    let (tool_name, effective_arguments) =
        effective_tool_invocation(CALL_DEFERRED_TOOL_NAME, &arguments);

    assert_eq!(tool_name, "get_weather");
    assert_eq!(effective_arguments, &json!({ "city": "Shanghai" }));
}

#[test]
fn call_deferred_tool_contract_normalizes_overflow_and_missing_args() {
    let overflow = ResolvedToolInvocation::from_wire_call(
        CALL_DEFERRED_TOOL_NAME,
        json!({
            "tool_name": "get_weather",
            "args": {
                "city": "Shanghai",
                "unit": "celsius"
            },
            "city": "Beijing",
            "language": "zh-CN"
        }),
    )
    .expect("overflow target arguments should be normalized");
    assert_eq!(
        overflow.effective_arguments,
        json!({
            "city": "Shanghai",
            "unit": "celsius",
            "language": "zh-CN"
        })
    );
    assert_eq!(
        overflow.wire_arguments,
        json!({
            "tool_name": "get_weather",
            "args": {
                "city": "Shanghai",
                "unit": "celsius",
                "language": "zh-CN"
            }
        })
    );

    let missing_args = ResolvedToolInvocation::from_wire_call(
        CALL_DEFERRED_TOOL_NAME,
        json!({
            "tool_name": "get_weather",
            "city": "Shanghai"
        }),
    )
    .expect("missing args should be treated as an empty object");
    assert_eq!(
        missing_args.effective_arguments,
        json!({ "city": "Shanghai" })
    );
}

#[test]
fn call_deferred_tool_contract_rejects_non_object_arguments() {
    let encoded = ResolvedToolInvocation::from_wire_call(
        CALL_DEFERRED_TOOL_NAME,
        json!({
            "tool_name": "get_weather",
            "args": "{\"city\":\"Shanghai\"}"
        }),
    )
    .expect_err("JSON-encoded string arguments must be rejected");
    assert_eq!(encoded, CallDeferredToolInputError::ArgsMustBeObject);
}

#[test]
fn call_deferred_tool_input_serializes_canonical_wire_shape() {
    let parsed = openbitfun_agent_tools::parse_call_deferred_tool_input(&json!({
        "tool_name": "CreatePlan",
        "overview": "outside",
        "args": {
            "overview": "inside",
            "plan": "# Plan"
        }
    }))
    .expect("overflow arguments should normalize");

    assert_eq!(
        parsed.canonical_wire_arguments(),
        json!({
            "tool_name": "CreatePlan",
            "args": {
                "overview": "inside",
                "plan": "# Plan"
            }
        })
    );
    assert_eq!(
        parsed.canonical_wire_json().expect("canonical JSON"),
        r##"{"tool_name":"CreatePlan","args":{"overview":"inside","plan":"# Plan"}}"##
    );
}

#[test]
fn resolved_tool_invocation_updates_effective_arguments_without_losing_wire_identity() {
    let mut invocation = ResolvedToolInvocation::from_wire_call(
        CALL_DEFERRED_TOOL_NAME,
        json!({
            "tool_name": "get_weather",
            "args": { "city": "Shanghai" }
        }),
    )
    .expect("valid deferred tool invocation");

    invocation.replace_effective_arguments(json!({ "city": "Beijing" }));

    assert_eq!(invocation.wire_tool_name, CALL_DEFERRED_TOOL_NAME);
    assert_eq!(invocation.effective_tool_name, "get_weather");
    assert_eq!(invocation.effective_arguments, json!({ "city": "Beijing" }));
    assert_eq!(
        invocation.wire_arguments,
        json!({
            "tool_name": "get_weather",
            "args": { "city": "Beijing" }
        })
    );
}

#[test]
#[cfg(feature = "mcp-bridge")]
fn mcp_tool_bridge_preserves_prompt_visible_name_and_descriptor_contract() {
    assert_eq!(MCP_TOOL_PREFIX, "mcp__");
    assert_eq!(MCP_TOOL_DELIMITER, "__");
    assert_eq!(
        normalize_name_for_mcp("Acme Search / Primary"),
        "Acme_Search___Primary"
    );
    assert_eq!(
        build_mcp_tool_bridge_name("Claude Code", "search repos"),
        "mcp__Claude_Code__search_repos"
    );

    let definition = build_mcp_tool_bridge_definition(McpToolBridgeDefinitionInput {
        server_id: "github",
        server_name: "GitHub",
        tool_name: "search",
        title: "Search Docs",
        description: Some("Find docs"),
        behavior_hints: McpToolBridgeBehaviorHints {
            read_only: true,
            destructive: false,
            open_world: true,
        },
    });

    assert_eq!(definition.full_name, "mcp__github__search");
    assert_eq!(definition.user_facing_name, "Search Docs (GitHub)");
    assert_eq!(
        definition.description,
        "Tool 'Search Docs' from MCP server 'GitHub': Find docs [Hints: read-only, open-world]"
    );
    assert_eq!(definition.provider_id, "github");
    assert_eq!(definition.provider_kind, "mcp");
    assert!(definition.read_only);
    assert_eq!(
        serde_json::to_value(definition.tool_info.clone()).unwrap(),
        json!({
            "server_id": "github",
            "server_name": "GitHub",
            "tool_name": "search"
        })
    );

    assert_eq!(
        mcp_tool_bridge_short_description(Some("Find docs"), "GitHub"),
        "Find docs (GitHub)"
    );
    assert_eq!(
        mcp_tool_bridge_short_description(Some("   "), "GitHub"),
        "MCP tool (GitHub)"
    );
}

#[test]
#[cfg(feature = "mcp-bridge")]
fn mcp_tool_bridge_preserves_dynamic_info_validation_and_rendering_contract() {
    let definition = build_mcp_tool_bridge_definition(McpToolBridgeDefinitionInput {
        server_id: "github",
        server_name: "GitHub",
        tool_name: "search",
        title: "Search Docs",
        description: Some("Find docs"),
        behavior_hints: McpToolBridgeBehaviorHints {
            read_only: false,
            destructive: true,
            open_world: false,
        },
    });

    assert_eq!(
        mcp_tool_bridge_dynamic_tool_info(&definition),
        DynamicToolInfo {
            provider_id: "github".to_string(),
            provider_kind: Some("mcp".to_string()),
            mcp: Some(DynamicMcpToolInfo {
                server_id: "github".to_string(),
                server_name: "GitHub".to_string(),
                tool_name: "search".to_string(),
            }),
        }
    );

    assert!(validate_mcp_tool_bridge_input(&json!({ "q": "rust" }), "GitHub", false).result);
    let non_object = validate_mcp_tool_bridge_input(&json!("rust"), "GitHub", false);
    assert!(!non_object.result);
    assert_eq!(non_object.error_code, Some(400));
    assert_eq!(
        non_object.message.as_deref(),
        Some("Input must be an object")
    );

    let remote_blocked = validate_mcp_tool_bridge_input(&json!({}), "GitHub", true);
    assert!(!remote_blocked.result);
    assert_eq!(
        remote_blocked.message.as_deref(),
        Some("MCP server 'GitHub' runs locally and is unavailable in remote workspace sessions")
    );

    assert_eq!(
        render_mcp_tool_bridge_use_message("Search Docs", "GitHub", &json!({ "q": "rust" })),
        "Using MCP tool 'Search Docs' from 'GitHub' with input: {\"q\":\"rust\"}"
    );
    assert_eq!(
        render_mcp_tool_bridge_rejected_message("Search Docs", "GitHub"),
        "MCP tool 'Search Docs' from 'GitHub' was rejected by user"
    );
    assert_eq!(
        render_mcp_tool_bridge_result_message("Search Docs", "done"),
        "MCP tool 'Search Docs' completed. Result: done"
    );

    let ToolResult::Result {
        data,
        result_for_assistant,
        image_attachments,
    } = build_mcp_tool_bridge_result(json!({ "ok": true }), "done".to_string())
    else {
        panic!("MCP bridge result must use standard result shape");
    };
    assert_eq!(data, json!({ "ok": true }));
    assert_eq!(result_for_assistant.as_deref(), Some("done"));
    assert!(image_attachments.is_none());
}

#[test]
#[cfg(feature = "acp-bridge")]
fn acp_external_agent_bridge_preserves_tool_contract() {
    assert_eq!(ACP_TOOL_PREFIX, "acp__");
    assert_eq!(ACP_TOOL_SUFFIX, "__prompt");
    assert_eq!(
        normalize_name_for_acp_tool_part("Claude Code"),
        "Claude_Code"
    );
    assert_eq!(
        build_acp_external_agent_tool_name("Claude Code"),
        "acp__Claude_Code__prompt"
    );

    let definition =
        build_acp_external_agent_tool_definition(AcpExternalAgentToolDefinitionInput {
            client_id: "codex",
            display_name: Some("Codex"),
            subagent_description: None,
            best_for: None,
            read_only: false,
        });

    assert_eq!(definition.tool_name, "acp__codex__prompt");
    assert_eq!(definition.display_name, "Codex");
    assert_eq!(definition.user_facing_name, "Codex (ACP)");
    assert_eq!(
        definition.description,
        "Send a prompt to the external ACP agent 'Codex'. Use this when another local ACP-compatible agent is better suited for a delegated task."
    );
    assert_eq!(
        definition.short_description,
        "Delegate a task to the external ACP agent 'Codex'."
    );
    assert!(!definition.read_only);

    let profiled_definition =
        build_acp_external_agent_tool_definition(AcpExternalAgentToolDefinitionInput {
            client_id: "codex",
            display_name: Some("Codex"),
            subagent_description: Some("Implements complex code changes"),
            best_for: Some("Cross-file refactors and difficult debugging"),
            read_only: false,
        });
    assert!(profiled_definition
        .description
        .contains("Role: Implements complex code changes."));
    assert!(profiled_definition
        .description
        .contains("Best suited for: Cross-file refactors and difficult debugging."));

    assert_eq!(
        acp_external_agent_tool_input_schema(),
        json!({
            "type": "object",
            "properties": {
                "prompt": {
                    "type": "string",
                    "description": "The task or question to send to the external ACP agent."
                },
                "workspace_path": {
                    "type": "string",
                    "description": "Optional absolute workspace path. Defaults to the current OpenBitFun workspace."
                },
                "timeout_seconds": {
                    "type": "integer",
                    "minimum": 0,
                    "description": "Optional timeout in seconds. Use 0 or omit it to wait without a fixed timeout."
                }
            },
            "required": ["prompt"],
            "additionalProperties": false
        })
    );

    let missing_prompt = validate_acp_external_agent_tool_input(&json!({}));
    assert!(!missing_prompt.result);
    assert_eq!(missing_prompt.error_code, Some(400));
    assert_eq!(
        missing_prompt.message.as_deref(),
        Some("prompt is required")
    );

    let empty_prompt = validate_acp_external_agent_tool_input(&json!({ "prompt": "  " }));
    assert!(!empty_prompt.result);
    assert_eq!(
        empty_prompt.message.as_deref(),
        Some("prompt cannot be empty")
    );
    assert!(validate_acp_external_agent_tool_input(&json!({ "prompt": "hello" })).result);

    let long_prompt = "a".repeat(161);
    assert_eq!(
        render_acp_external_agent_use_message("Codex", &json!({ "prompt": long_prompt })),
        format!("Sending ACP prompt to 'Codex': {}...", "a".repeat(160))
    );
    assert_eq!(
        render_acp_external_agent_rejected_message("Codex"),
        "ACP prompt to 'Codex' was rejected"
    );
    assert_eq!(
        render_acp_external_agent_result_message("Codex", &json!({ "response": "done" })),
        "ACP agent 'Codex' responded:\ndone"
    );
    assert_eq!(
        render_acp_external_agent_result_message("Codex", &json!({})),
        "ACP agent 'Codex' completed"
    );
    assert_eq!(
        render_acp_external_agent_result_for_assistant(&json!({})),
        "ACP agent completed without text output"
    );

    let ToolResult::Result {
        data,
        result_for_assistant,
        image_attachments,
    } = build_acp_external_agent_tool_result("codex", "done")
    else {
        panic!("ACP bridge result must use standard result shape");
    };
    assert_eq!(data, json!({ "client_id": "codex", "response": "done" }));
    assert_eq!(result_for_assistant.as_deref(), Some("done"));
    assert!(image_attachments.is_none());
}

#[test]
fn validation_result_default_preserves_success_contract() {
    assert!(ValidationResult::default().result);
    assert_eq!(ValidationResult::default().message, None);
}

#[test]
fn input_validator_preserves_required_field_error() {
    let result = InputValidator::new(&json!({}))
        .validate_required("path")
        .finish();

    assert!(!result.result);
    assert_eq!(result.message.as_deref(), Some("path is required"));
    assert_eq!(result.error_code, Some(400));
}

#[test]
fn tool_result_ok_keeps_result_shape() {
    let result = ToolResult::ok(json!({"ok": true}), Some("done".to_string()));
    let value = serde_json::to_value(result).expect("serialize tool result");

    assert_eq!(value["type"], "result");
    assert_eq!(value["data"]["ok"], true);
    assert_eq!(value["result_for_assistant"], "done");
}

#[test]
fn tool_result_assistant_fallback_prefers_pretty_json_and_non_empty_fallback() {
    let rendered = render_tool_result_for_assistant("Read", &json!({"path": "src/main.rs"}));
    assert_eq!(rendered, "{\n  \"path\": \"src/main.rs\"\n}");

    let rendered = render_tool_result_for_assistant("Empty", &json!(null));
    assert_eq!(rendered, "null");
}

#[test]
fn tool_error_preview_truncates_at_utf8_boundary_with_current_marker() {
    assert_eq!(TOOL_ERROR_ARGUMENTS_PREVIEW_BYTES, 1024);

    let raw = "ab😀cd";
    let preview = truncate_raw_tool_arguments_preview_to(raw, 5);

    assert_eq!(preview, "ab…[truncated, total 8 bytes]");
}

#[test]
fn tool_error_presentation_preserves_unparseable_raw_arguments() {
    let raw_arguments = "{\"path\":\"src/main.rs\"".to_string();
    let presentation = build_tool_execution_error_presentation(
        "Write",
        "invalid_arguments",
        "path is required",
        Some(raw_arguments.clone()),
    );

    assert_eq!(presentation.result_json["category"], "invalid_arguments");
    assert_eq!(presentation.result_json["tool_name"], "Write");
    assert_eq!(
        presentation.result_json["provided_arguments"],
        raw_arguments
    );
    assert_eq!(
        presentation.result_for_assistant,
        "Tool 'Write' failed (invalid_arguments): path is required\nProvided arguments: {\"path\":\"src/main.rs\""
    );
}

#[test]
fn tool_error_presentation_omits_arguments_for_execution_failures() {
    let presentation = build_tool_execution_error_presentation(
        "Write",
        "execution_error",
        "disk is unavailable",
        Some(r#"{\"path\":\"src/main.rs\"}"#.to_string()),
    );

    assert!(presentation.result_json["provided_arguments"].is_null());
    assert_eq!(
        presentation.result_for_assistant,
        "Tool 'Write' failed (execution_error): disk is unavailable"
    );
}

#[test]
fn steering_interrupted_presentation_preserves_current_contract() {
    let presentation = build_user_steering_interrupted_presentation("Read");

    assert_eq!(presentation.result_json["status"], "skipped");
    assert_eq!(
        presentation.result_json["category"],
        "user_steering_interrupted"
    );
    assert_eq!(presentation.result_json["tool_name"], "Read");
    assert_eq!(
        presentation.result_for_assistant,
        USER_STEERING_INTERRUPTED_MESSAGE
    );
}

#[test]
fn tool_execution_timeout_presentation_includes_timeout_seconds() {
    let presentation = build_tool_execution_timeout_presentation("ExecCommand", Some(120));

    assert_eq!(presentation.result_json["status"], "timeout");
    assert_eq!(presentation.result_json["category"], "execution_timeout");
    assert_eq!(presentation.result_json["tool_name"], "ExecCommand");
    assert_eq!(presentation.result_json["timeout_seconds"], 120);
    assert!(presentation.result_for_assistant.contains(
        "This tool call was cancelled because the global tool execution time limit (120 seconds)"
    ));
    assert!(!presentation
        .result_for_assistant
        .contains("Provided arguments"));
    assert!(!presentation.result_for_assistant.contains("failed"));
}

#[test]
fn user_rejected_tool_presentation_is_not_an_argument_error() {
    let presentation = build_user_rejected_tool_presentation("ExecCommand");

    assert_eq!(presentation.result_json["status"], "rejected");
    assert_eq!(presentation.result_json["category"], "user_rejected");
    assert_eq!(presentation.result_json["tool_name"], "ExecCommand");
    assert_eq!(
        presentation.result_json["message"],
        USER_REJECTED_TOOL_MESSAGE
    );
    assert!(presentation.result_json["provided_arguments"].is_null());
    assert_eq!(
        presentation.result_for_assistant,
        USER_REJECTED_TOOL_MESSAGE
    );
    assert!(!presentation
        .result_for_assistant
        .contains("invalid_arguments"));
    assert!(!presentation.result_for_assistant.contains("failed"));
    assert!(!presentation
        .result_for_assistant
        .contains("Provided arguments"));

    let presentation = build_user_rejected_tool_presentation_with_instruction(
        "ExecCommand",
        Some("Use the built-in status view instead."),
    );
    assert_eq!(
        presentation.result_json["instruction"],
        "Use the built-in status view instead."
    );
    assert!(presentation.result_json["provided_arguments"].is_null());
    assert_eq!(
        presentation.result_for_assistant,
        "The user rejected this tool call with the following instruction: \"Use the built-in status view instead.\". Do not retry it unless the user explicitly asks you to. If you cannot complete the task without running this tool call, stop and ask the user how to proceed."
    );
}

#[test]
fn permission_denied_tool_presentation_is_not_a_user_rejection() {
    let presentation = build_permission_denied_tool_presentation(
        "ExecCommand",
        "Global permission policy denies bash commands.",
    );

    assert_eq!(presentation.result_json["status"], "rejected");
    assert_eq!(presentation.result_json["category"], "permission_denied");
    assert_eq!(presentation.result_json["tool_name"], "ExecCommand");
    assert_eq!(
        presentation.result_json["reason"],
        "Global permission policy denies bash commands."
    );
    assert_eq!(
        presentation.result_for_assistant,
        "This tool call was blocked by the current permission policy: \"Global permission policy denies bash commands.\". Do not retry it. If you cannot complete the task without running this tool call, stop and ask the user how to proceed."
    );
    assert!(!presentation.result_for_assistant.contains("user rejected"));
}

#[test]
fn invalid_tool_call_error_message_preserves_current_contract() {
    let message =
        build_invalid_tool_call_error_message("", true, false, Some("{\"path\"".to_string()));
    assert_eq!(
        message,
        "Missing valid tool name and arguments are invalid JSON."
    );

    let message = build_invalid_tool_call_error_message("", false, false, None);
    assert_eq!(message, "Missing valid tool name.");

    let message = build_invalid_tool_call_error_message("Write", false, true, None);
    assert_eq!(
        message,
        "Tool arguments were truncated by the model (likely hit max_tokens). Refusing to execute a partial 'Write' call. Increase max_tokens, split the work into smaller calls, or retry."
    );

    let message = build_invalid_tool_call_error_message("Write", true, false, None);
    assert_eq!(message, "Arguments are invalid JSON.");
}

#[test]
fn write_tail_closure_notice_preserves_write_like_guidance() {
    assert!(is_write_like_tool_name("Write"));
    assert!(is_write_like_tool_name("file_write"));
    assert!(is_write_like_tool_name("write_notebook"));
    assert!(!is_write_like_tool_name("Read"));

    let notice = openbitfun_agent_tools::build_write_tail_closure_notice("Write");

    assert!(notice.contains("latest Read result"));
    assert!(notice.contains("use Edit to add only the missing continuation"));
    assert!(notice.contains("stop tool-calling and tell the user"));
    assert!(!notice.contains("max_tokens"));
    assert!(!notice.contains("`mode`"));
    assert!(notice.ends_with("Original tool result follows.\n\n"));
}

#[test]
fn normal_tool_json_repair_notice_identifies_the_opt_in_repair_policy() {
    let notice = build_normal_tool_json_repair_notice("AskUserQuestion");

    assert!(notice.contains("provider completed tool use normally"));
    assert!(notice.contains("issue a fresh complete AskUserQuestion call"));
    assert!(!notice.contains("max_tokens"));
    assert!(!notice.contains("ONE Edit call"));
}

#[test]
fn tool_image_attachment_keeps_wire_shape_without_ai_adapter_dependency() {
    let attachment = ToolImageAttachment {
        mime_type: "image/png".to_string(),
        data_base64: "aW1hZ2U=".to_string(),
    };
    let result = ToolResult::ok_with_images(
        json!({"ok": true}),
        Some("captured screenshot".to_string()),
        vec![attachment],
    );

    let value = serde_json::to_value(&result).expect("serialize image tool result");
    assert_eq!(value["type"], "result");
    assert_eq!(value["image_attachments"][0]["mime_type"], "image/png");
    assert_eq!(value["image_attachments"][0]["data_base64"], "aW1hZ2U=");

    let round_trip: ToolResult = serde_json::from_value(value).expect("deserialize tool result");
    match round_trip {
        ToolResult::Result {
            image_attachments: Some(images),
            ..
        } => {
            assert_eq!(images.len(), 1);
            assert_eq!(images[0].mime_type, "image/png");
            assert_eq!(images[0].data_base64, "aW1hZ2U=");
        }
        other => panic!("expected image result, got {other:?}"),
    }
}

#[test]
fn dynamic_tool_info_keeps_provider_and_mcp_metadata_without_core_dependency() {
    let info = DynamicToolInfo {
        provider_id: "github-server-id".to_string(),
        provider_kind: Some("mcp".to_string()),
        mcp: Some(DynamicMcpToolInfo {
            server_id: "github-server-id".to_string(),
            server_name: "GitHub".to_string(),
            tool_name: "search_repos".to_string(),
        }),
    };

    let value = serde_json::to_value(&info).expect("serialize dynamic info");

    assert_eq!(value["providerId"], "github-server-id");
    assert_eq!(value["providerKind"], "mcp");
    assert_eq!(value["mcp"]["serverId"], "github-server-id");
    assert_eq!(value["mcp"]["serverName"], "GitHub");
    assert_eq!(value["mcp"]["toolName"], "search_repos");

    let round_trip: DynamicToolInfo =
        serde_json::from_value(value).expect("deserialize dynamic info");
    assert_eq!(round_trip.provider_id, "github-server-id");
    assert_eq!(round_trip.provider_kind.as_deref(), Some("mcp"));
    assert_eq!(
        round_trip.mcp.as_ref().map(|mcp| mcp.tool_name.as_str()),
        Some("search_repos")
    );
}

#[test]
fn tool_render_options_stays_a_lightweight_contract() {
    let options = ToolRenderOptions { verbose: true };

    assert!(options.verbose);
}

#[test]
fn runtime_restrictions_keep_allow_deny_semantics_without_core_dependency() {
    let restrictions = ToolRuntimeRestrictions {
        allowed_tool_names: ["Read", "Write"].into_iter().map(str::to_string).collect(),
        denied_tool_names: ["Write"].into_iter().map(str::to_string).collect(),
        denied_tool_messages: Default::default(),
        path_policy: Default::default(),
        miniapp_context_scope: None,
    };

    assert!(restrictions.is_tool_allowed("Read"));
    assert!(!restrictions.is_tool_allowed("Write"));
    assert!(!restrictions.is_tool_allowed("Bash"));

    let denied = restrictions
        .ensure_tool_allowed("Write")
        .expect_err("deny list must override allow list");
    assert_eq!(
        denied.to_string(),
        "Tool 'Write' is denied by runtime restrictions"
    );

    let not_allowed = restrictions
        .ensure_tool_allowed("Bash")
        .expect_err("non-empty allow list must reject missing tools");
    assert_eq!(
        not_allowed.to_string(),
        "Tool 'Bash' is not allowed by runtime restrictions"
    );
}

#[test]
fn runtime_restrictions_surface_custom_deny_messages() {
    let restrictions = ToolRuntimeRestrictions {
        denied_tool_names: ["Task"].into_iter().map(str::to_string).collect(),
        denied_tool_messages: [(
            "Task".to_string(),
            "Recursive subagent delegation is blocked. Use direct tools instead.".to_string(),
        )]
        .into_iter()
        .collect(),
        ..Default::default()
    };

    let denied = restrictions
        .ensure_tool_allowed("Task")
        .expect_err("deny message should be returned");
    assert_eq!(
        denied.to_string(),
        "Recursive subagent delegation is blocked. Use direct tools instead."
    );
}

#[test]
fn delegation_restrictions_cover_all_agent_spawn_surfaces() {
    let restrictions = tool_restrictions_for_delegation_policy(
        openbitfun_runtime_ports::DelegationPolicy::top_level().spawn_child(),
    );

    for tool_name in ["Task", "AgentSpawn"] {
        let denied = restrictions
            .ensure_tool_allowed(tool_name)
            .expect_err("agent spawning should be denied for child delegation");
        assert_eq!(
            denied.to_string(),
            "Recursive subagent delegation is blocked. Use direct tools instead."
        );
    }
}

#[test]
fn tool_context_facts_keep_portable_wire_shape_without_runtime_handles() {
    let facts = ToolContextFacts {
        tool_call_id: Some("call-1".to_string()),
        agent_type: Some("Standard".to_string()),
        session_id: Some("session-1".to_string()),
        dialog_turn_id: Some("turn-1".to_string()),
        workspace_kind: Some(ToolWorkspaceKind::Remote),
        workspace_root: Some("/remote/workspace".to_string()),
        runtime_tool_restrictions: ToolRuntimeRestrictions::default(),
    };

    let value = serde_json::to_value(&facts).expect("serialize context facts");

    assert_eq!(value["toolCallId"], "call-1");
    assert_eq!(value["agentType"], "Standard");
    assert_eq!(value["sessionId"], "session-1");
    assert_eq!(value["dialogTurnId"], "turn-1");
    assert_eq!(value["workspaceKind"], "remote");
    assert_eq!(value["workspaceRoot"], "/remote/workspace");
    assert!(value.get("unlockedCollapsedTools").is_none());
    assert!(value.get("computer_use_host").is_none());
    assert!(value.get("workspace_services").is_none());
    assert!(value.get("cancellation_token").is_none());

    let round_trip: ToolContextFacts =
        serde_json::from_value(value).expect("deserialize context facts");
    assert_eq!(round_trip.workspace_kind, Some(ToolWorkspaceKind::Remote));
}

#[test]
fn portable_tool_context_provider_exposes_facts_only() {
    struct FactsOnlyProvider {
        facts: ToolContextFacts,
    }

    impl PortableToolContextProvider for FactsOnlyProvider {
        fn tool_context_facts(&self) -> ToolContextFacts {
            self.facts.clone()
        }
    }

    let provider = FactsOnlyProvider {
        facts: ToolContextFacts {
            tool_call_id: Some("call-2".to_string()),
            agent_type: Some("Standard".to_string()),
            session_id: Some("session-2".to_string()),
            dialog_turn_id: None,
            workspace_kind: Some(ToolWorkspaceKind::Local),
            workspace_root: Some("/repo/project".to_string()),
            runtime_tool_restrictions: ToolRuntimeRestrictions::default(),
        },
    };

    let value =
        serde_json::to_value(provider.tool_context_facts()).expect("serialize context facts");

    assert_eq!(value["toolCallId"], "call-2");
    assert_eq!(value["workspaceKind"], "local");
    assert!(value.get("workspace_services").is_none());
    assert!(value.get("unlockedCollapsedTools").is_none());
}

#[test]
fn file_tool_guidance_marker_is_provider_neutral() {
    let message = file_tool_guidance_message("Read the file first");

    assert_eq!(FILE_TOOL_GUIDANCE_PREFIX, "[guidance] ");
    assert_eq!(message, "[guidance] Read the file first");
    assert!(is_file_tool_guidance_message(&message));
    assert!(!is_file_tool_guidance_message("Read the file first"));
}

#[test]
fn persisted_tool_output_message_keeps_reference_preview_and_metadata_shape() {
    let rendered = build_persisted_tool_output_message(
        &PersistedToolOutput {
            reference: "openbitfun-runtime://session/session-1/tool-results/bash_1.txt".to_string(),
            original_chars: 12_345,
            line_count: 7,
            preview: "first lines".to_string(),
            has_more: true,
            metadata: vec![
                ("exit_code".to_string(), "1".to_string()),
                ("working_directory".to_string(), "/repo".to_string()),
            ],
        },
        TOOL_RESULT_PREVIEW_CHARS,
    );

    assert!(rendered.starts_with(PERSISTED_OUTPUT_TAG));
    assert!(rendered.contains("Output too large (12345 chars). Full output saved to:"));
    assert!(rendered.contains("Line count: 7"));
    assert!(rendered.contains("Preview (first 2000 chars):\nfirst lines"));
    assert!(rendered.contains("- exit_code: 1"));
    assert!(rendered.contains("- working_directory: /repo"));
    assert!(tool_result_is_persisted_output(&rendered));
}

#[test]
fn tool_result_preview_prefers_line_boundary_when_possible() {
    let content = "first line\nsecond line\nthird line";

    let (preview, has_more) = generate_tool_result_preview(content, 23);

    assert!(has_more);
    assert_eq!(preview, "first line\nsecond line");
}

#[test]
fn round_budget_candidate_selection_is_descending_and_stable_for_ties() {
    let candidates = vec![
        ToolResultPersistenceCandidate {
            index: 9,
            visible_chars: 50_000,
        },
        ToolResultPersistenceCandidate {
            index: 7,
            visible_chars: 100_000,
        },
        ToolResultPersistenceCandidate {
            index: 3,
            visible_chars: 100_000,
        },
    ];

    let selected = select_tool_result_indices_for_persistence(&candidates, 250_000, 50_000);

    assert_eq!(selected, vec![7, 3]);
}

#[test]
fn tool_result_storage_helpers_keep_stable_file_and_line_contracts() {
    assert_eq!(
        sanitize_tool_result_file_component("tool/one", "fallback"),
        "tool_one"
    );
    assert_eq!(
        sanitize_tool_result_file_component("", "fallback"),
        "fallback"
    );
    assert_eq!(count_tool_result_lines(""), 0);
    assert_eq!(count_tool_result_lines("a\nb\n"), 2);
    assert!(!tool_result_is_persisted_output("plain output"));
}

#[test]
fn runtime_restrictions_keep_current_snake_case_wire_shape() {
    let value = json!({
        "allowed_tool_names": ["Read"],
        "denied_tool_names": ["Write"],
        "path_policy": {
            "read_roots": ["context"],
            "write_roots": ["src"],
            "edit_roots": ["docs"],
            "delete_roots": ["target/generated"]
        }
    });

    let restrictions: ToolRuntimeRestrictions =
        serde_json::from_value(value.clone()).expect("deserialize restrictions");
    assert!(restrictions.is_tool_allowed("Read"));
    assert!(!restrictions.is_tool_allowed("Write"));
    assert_eq!(restrictions.path_policy.read_roots, vec!["context"]);
    assert_eq!(restrictions.path_policy.write_roots, vec!["src"]);
    assert_eq!(restrictions.path_policy.edit_roots, vec!["docs"]);
    assert_eq!(
        restrictions.path_policy.delete_roots,
        vec!["target/generated"]
    );

    let round_trip = serde_json::to_value(&restrictions).expect("serialize restrictions");
    assert_eq!(round_trip, value);
}

#[test]
fn runtime_restrictions_accept_legacy_path_policy_without_read_roots() {
    let legacy = json!({
        "allowed_tool_names": ["Read"],
        "denied_tool_names": [],
        "path_policy": {
            "write_roots": ["src"],
            "edit_roots": [],
            "delete_roots": []
        }
    });
    let restrictions: ToolRuntimeRestrictions =
        serde_json::from_value(legacy).expect("legacy restrictions should deserialize");
    assert!(restrictions.path_policy.read_roots.is_empty());
    assert!(restrictions.miniapp_context_scope.is_none());
    let round_trip = serde_json::to_value(restrictions).expect("serialize restrictions");
    assert!(round_trip["path_policy"].get("read_roots").is_none());
    assert!(round_trip.get("miniapp_context_scope").is_none());
}

#[test]
fn path_resolution_contract_keeps_backend_and_runtime_helpers() {
    let remote = ToolPathResolution {
        requested_path: "src/lib.rs".to_string(),
        logical_path: "/workspace/src/lib.rs".to_string(),
        resolved_path: "/workspace/src/lib.rs".to_string(),
        backend: ToolPathBackend::RemoteWorkspace,
        runtime_scope: None,
        runtime_root: None,
    };
    assert!(remote.uses_remote_workspace_backend());
    assert!(!remote.is_runtime_artifact());

    let runtime_root = PathBuf::from("/runtime/workspace");
    let runtime = ToolPathResolution {
        requested_path: "openbitfun://runtime/workspace-1/logs/tool.txt".to_string(),
        logical_path: "openbitfun://runtime/workspace-1/logs/tool.txt".to_string(),
        resolved_path: runtime_root
            .join("logs")
            .join("tool.txt")
            .display()
            .to_string(),
        backend: ToolPathBackend::Local,
        runtime_scope: Some("workspace-1".to_string()),
        runtime_root: Some(runtime_root.clone()),
    };

    assert!(!runtime.uses_remote_workspace_backend());
    assert!(runtime.is_runtime_artifact());
    assert_eq!(
        runtime.logical_child_path(&runtime_root.join("logs").join("tool.txt")),
        Some("openbitfun://runtime/workspace-1/logs/tool.txt".to_string())
    );
    assert_eq!(
        runtime.logical_child_path(&PathBuf::from("/outside/tool.txt")),
        None
    );
}

#[test]
fn tool_path_policy_owner_matches_resolved_roots_by_backend() {
    let target = ToolPathResolution {
        requested_path: "src/lib.rs".to_string(),
        logical_path: "/workspace/src/lib.rs".to_string(),
        resolved_path: "/workspace/src/lib.rs".to_string(),
        backend: ToolPathBackend::RemoteWorkspace,
        runtime_scope: None,
        runtime_root: None,
    };
    let local_root = ToolPathResolution {
        requested_path: "src".to_string(),
        logical_path: "/workspace/src".to_string(),
        resolved_path: "/workspace/src".to_string(),
        backend: ToolPathBackend::Local,
        runtime_scope: None,
        runtime_root: None,
    };
    let remote_root = ToolPathResolution {
        requested_path: "src".to_string(),
        logical_path: "/workspace/src".to_string(),
        resolved_path: "/workspace/src".to_string(),
        backend: ToolPathBackend::RemoteWorkspace,
        runtime_scope: None,
        runtime_root: None,
    };

    let allowed = is_tool_path_allowed_by_resolved_roots(
        &target,
        &[local_root, remote_root],
        |resolution, root| -> Result<bool, ()> {
            Ok(is_remote_posix_path_within_root(
                &resolution.resolved_path,
                &root.resolved_path,
            ))
        },
    )
    .expect("containment callback should succeed");

    assert!(allowed);
}

#[test]
fn tool_path_policy_owner_ignores_mismatched_backend_roots() {
    let target = ToolPathResolution {
        requested_path: "src/lib.rs".to_string(),
        logical_path: "/workspace/src/lib.rs".to_string(),
        resolved_path: "/workspace/src/lib.rs".to_string(),
        backend: ToolPathBackend::RemoteWorkspace,
        runtime_scope: None,
        runtime_root: None,
    };
    let local_root = ToolPathResolution {
        requested_path: "src".to_string(),
        logical_path: "/workspace/src".to_string(),
        resolved_path: "/workspace/src".to_string(),
        backend: ToolPathBackend::Local,
        runtime_scope: None,
        runtime_root: None,
    };

    let allowed = is_tool_path_allowed_by_resolved_roots(
        &target,
        &[local_root],
        |_, _| -> Result<bool, ()> {
            panic!("mismatched backend roots must not call the containment callback");
        },
    )
    .expect("backend mismatch should not invoke containment");

    assert!(!allowed);
}

#[test]
fn tool_path_policy_owner_preserves_denial_message() {
    let message = build_tool_path_policy_denial_message(
        "/workspace/blocked/file.txt",
        ToolPathOperation::Write,
        &["/workspace/allowed".to_string()],
    );

    assert_eq!(
        message,
        "Path '/workspace/blocked/file.txt' is not allowed for write. Allowed roots: /workspace/allowed"
    );
}

#[test]
fn tool_path_resolution_owner_preserves_runtime_uri_scope_and_backend() {
    let runtime_root = PathBuf::from("/runtime/workspace");

    let resolution = resolve_tool_path_with_context(
        "openbitfun://runtime/workspace-123/plans/demo.plan.md",
        Some("/home/project"),
        true,
        Some("workspace-123"),
        Some(runtime_root.clone()),
    )
    .expect("runtime URI should resolve through the provider-neutral owner");

    assert_eq!(
        resolution.requested_path,
        "openbitfun://runtime/workspace-123/plans/demo.plan.md"
    );
    assert_eq!(
        resolution.logical_path,
        "openbitfun://runtime/workspace-123/plans/demo.plan.md"
    );
    assert_eq!(
        PathBuf::from(&resolution.resolved_path),
        runtime_root.join("plans").join("demo.plan.md")
    );
    assert_eq!(resolution.backend, ToolPathBackend::Local);
    assert_eq!(resolution.runtime_scope.as_deref(), Some("workspace-123"));
    assert_eq!(
        resolution.runtime_root.as_deref(),
        Some(runtime_root.as_path())
    );
}

#[test]
fn tool_path_resolution_owner_resolves_current_session_uri() {
    let session_root = PathBuf::from("/runtime/workspace/sessions/session-123");
    let resolution = resolve_tool_path_with_context_roots(
        "openbitfun://current-session/artifacts/compression-transcripts/12-a3f9.txt",
        Some("/home/project"),
        true,
        Some("workspace-123"),
        Some(PathBuf::from("/runtime/workspace")),
        Some(session_root.clone()),
    )
    .expect("current-session URI should resolve locally");

    assert_eq!(
        PathBuf::from(&resolution.resolved_path),
        session_root
            .join("artifacts")
            .join("compression-transcripts")
            .join("12-a3f9.txt")
    );
    assert_eq!(resolution.backend, ToolPathBackend::Local);
    assert!(resolution.is_runtime_artifact());
    assert_eq!(
        resolution.logical_child_path(
            &session_root
                .join("artifacts")
                .join("compression-transcripts")
                .join("child.txt")
        ),
        Some(
            "openbitfun://current-session/artifacts/compression-transcripts/child.txt".to_string()
        )
    );
}

#[test]
fn current_session_uri_contract_rejects_missing_context_escape_and_unknown_authority() {
    let missing = resolve_tool_path_with_context_roots(
        "openbitfun://current-session/artifacts/file.txt",
        None,
        false,
        None,
        None,
        None,
    )
    .expect_err("session context is required");
    assert_eq!(
        missing.to_string(),
        "A current session is required to resolve session artifacts"
    );

    let escape = parse_openbitfun_current_session_uri(
        "openbitfun://current-session/artifacts/../secret.txt",
    )
    .expect_err("parent escape should be rejected");
    assert_eq!(
        escape.to_string(),
        "Runtime artifact path cannot escape its root"
    );

    let unknown = resolve_tool_path_with_context_roots(
        "openbitfun://other/artifacts/file.txt",
        Some("/repo"),
        false,
        None,
        None,
        Some(PathBuf::from("/session")),
    )
    .expect_err("unknown authority should not become a workspace path");
    assert!(unknown.to_string().contains("Unsupported runtime URI"));
}

#[test]
fn tool_path_resolution_owner_rejects_mismatched_runtime_scope() {
    let err = resolve_tool_path_with_context(
        "openbitfun://runtime/workspace-456/plans/demo.plan.md",
        Some("/home/project"),
        true,
        Some("workspace-123"),
        Some(PathBuf::from("/runtime/workspace")),
    )
    .expect_err("runtime artifact scopes must match the active workspace");

    assert_eq!(
        err.to_string(),
        "Runtime URI scope 'workspace-456' does not match the current workspace"
    );
}

#[test]
fn tool_path_resolution_owner_selects_workspace_backend_semantics() {
    let local =
        resolve_tool_path_with_context("src/lib.rs", Some("/repo/project"), false, None, None)
            .expect("local path should resolve through host semantics");
    assert_eq!(local.backend, ToolPathBackend::Local);
    assert_eq!(
        PathBuf::from(local.resolved_path),
        PathBuf::from("/repo/project").join("src").join("lib.rs")
    );

    let remote =
        resolve_tool_path_with_context(r"src\lib.rs", Some("/home/project"), true, None, None)
            .expect("remote path should resolve through POSIX workspace semantics");
    assert_eq!(remote.backend, ToolPathBackend::RemoteWorkspace);
    assert_eq!(remote.resolved_path, "/home/project/src/lib.rs");
    assert_eq!(remote.logical_path, "/home/project/src/lib.rs");
}

#[test]
fn tool_path_absolute_contract_keeps_remote_posix_and_runtime_uri_semantics() {
    assert!(tool_path_is_effectively_absolute(
        "openbitfun://runtime/current/logs/tool.txt",
        false
    ));
    assert!(tool_path_is_effectively_absolute(
        r"\home\workspace\src\lib.rs",
        true
    ));
    assert!(!tool_path_is_effectively_absolute("src/lib.rs", true));
    assert_eq!(
        tool_path_is_effectively_absolute("src/lib.rs", false),
        PathBuf::from("src/lib.rs").is_absolute()
    );
}

#[test]
fn runtime_uri_contract_is_provider_neutral_and_normalized() {
    let uri = build_openbitfun_runtime_uri("workspace-123", r"plans\demo.plan.md")
        .expect("runtime URI should build");

    assert_eq!(uri, "openbitfun://runtime/workspace-123/plans/demo.plan.md");
    assert!(is_openbitfun_runtime_uri(&uri));

    let parsed = parse_openbitfun_runtime_uri(&uri).expect("runtime URI should parse");
    assert_eq!(parsed.workspace_scope, "workspace-123");
    assert_eq!(parsed.relative_path, "plans/demo.plan.md");
    assert_eq!(
        normalize_runtime_relative_path("/sessions/turn-1/result.json")
            .expect("relative path should normalize"),
        "sessions/turn-1/result.json"
    );
}

#[test]
fn runtime_uri_contract_rejects_escape_and_invalid_scope() {
    let escape = build_openbitfun_runtime_uri("workspace-123", "../secret.txt")
        .expect_err("runtime URI should reject parent directory escape");
    assert_eq!(
        escape.to_string(),
        "Runtime artifact path cannot escape its root"
    );

    let empty_scope =
        build_openbitfun_runtime_uri("  ", "logs/tool.txt").expect_err("scope should be required");
    assert_eq!(
        empty_scope.to_string(),
        "Runtime URI workspace scope cannot be empty"
    );

    let unsupported =
        parse_openbitfun_runtime_uri("/tmp/result.txt").expect_err("non-runtime URI should fail");
    assert_eq!(
        unsupported.to_string(),
        "Unsupported runtime URI: /tmp/result.txt"
    );
}

#[test]
fn runtime_artifact_reference_owner_preserves_remote_uri_shape() {
    let reference = build_tool_runtime_artifact_reference(
        r"plans\demo.plan.md",
        None,
        Some("workspace-123"),
        true,
    )
    .expect("remote artifact reference should build as runtime URI");

    assert_eq!(
        reference,
        "openbitfun://runtime/workspace-123/plans/demo.plan.md"
    );
}

#[test]
fn runtime_artifact_reference_owner_preserves_local_path_shape() {
    let runtime_root = PathBuf::from("/runtime/workspace");

    let reference = build_tool_runtime_artifact_reference(
        r"sessions\session-1\tool-results\result.json",
        Some(runtime_root.as_path()),
        None,
        false,
    )
    .expect("local artifact reference should build as host path");

    assert_eq!(
        PathBuf::from(reference),
        runtime_root
            .join("sessions")
            .join("session-1")
            .join("tool-results")
            .join("result.json")
    );
}

#[test]
fn runtime_artifact_reference_owner_preserves_session_prefix_and_rejects_escape() {
    let session_reference = build_tool_session_runtime_artifact_reference(
        "session-1",
        "tool-results/result.json",
        None,
        Some("workspace-123"),
        true,
    )
    .expect("session artifact reference should build");

    assert_eq!(
        session_reference,
        "openbitfun://runtime/workspace-123/sessions/session-1/tool-results/result.json"
    );

    let runtime_root = PathBuf::from("/runtime/workspace");
    let escape = build_tool_runtime_artifact_reference(
        "../secret.txt",
        Some(runtime_root.as_path()),
        None,
        false,
    )
    .expect_err("artifact references must not escape the runtime root");

    assert_eq!(
        escape.to_string(),
        "Runtime artifact path cannot escape its root"
    );
}

#[test]
fn deferred_tool_usage_gate_preserves_get_tool_spec_unlock_contract() {
    let deferred_tools = vec!["WebFetch".to_string()];
    let loaded_deferred_tool_specs = Vec::new();

    let err = validate_deferred_tool_usage(
        "WebFetch",
        &deferred_tools,
        &loaded_deferred_tool_specs,
        0,
        GET_TOOL_SPEC_TOOL_NAME,
    )
    .expect_err("deferred tool should require GetToolSpec unlock");
    assert_eq!(
        err.to_string(),
        "Tool 'WebFetch' has no loaded definition in the current context. Call GetToolSpec with {\"tool_name\":\"WebFetch\"} to read its full usage instructions and input schema before invoking it. If compaction removed an earlier definition, reload it even if the summary says it was loaded."
    );

    let loaded_deferred_tool_specs = vec![LoadedDeferredToolSpec {
        tool_name: "WebFetch".to_string(),
        catalog_generation: 0,
    }];
    validate_deferred_tool_usage(
        "WebFetch",
        &deferred_tools,
        &loaded_deferred_tool_specs,
        0,
        GET_TOOL_SPEC_TOOL_NAME,
    )
    .expect("loaded deferred tool should be executable");

    let stale = validate_deferred_tool_usage(
        "WebFetch",
        &deferred_tools,
        &[LoadedDeferredToolSpec {
            tool_name: "WebFetch".to_string(),
            catalog_generation: 41,
        }],
        42,
        GET_TOOL_SPEC_TOOL_NAME,
    )
    .expect_err("stale deferred spec should require a reload");
    assert!(stale
        .to_string()
        .contains("loaded catalog generation 41, current generation 42"));

    validate_deferred_tool_usage(
        GET_TOOL_SPEC_TOOL_NAME,
        &deferred_tools,
        &[],
        0,
        GET_TOOL_SPEC_TOOL_NAME,
    )
    .expect("GetToolSpec itself is the unlock path");
}

#[test]
fn tool_allowed_list_gate_preserves_pipeline_rejection_contract() {
    validate_tool_allowed_by_list("Read", &[])
        .expect("empty allowed-list should preserve allow-all behavior");

    let allowed_tools = vec!["Read".to_string(), "GetToolSpec".to_string()];
    validate_tool_allowed_by_list("Read", &allowed_tools).expect("listed tool should be allowed");

    let err = validate_tool_allowed_by_list("Bash", &allowed_tools)
        .expect_err("unlisted tool should be rejected");
    assert_eq!(
        err.to_string(),
        "Tool 'Bash' is not in the allowed list: [\"Read\", \"GetToolSpec\"]"
    );
}

#[test]
fn tool_execution_admission_gate_preserves_pipeline_rejection_order() {
    let mut restrictions = ToolRuntimeRestrictions::default();
    restrictions
        .denied_tool_names
        .insert("WebFetch".to_string());

    let request = ToolExecutionAdmissionRequest {
        tool_name: "WebFetch",
        allowed_tools: &["Read".to_string()],
        runtime_tool_restrictions: &restrictions,
        deferred_tools: &["WebFetch".to_string()],
        loaded_deferred_tool_specs: &[],
        current_catalog_generation: 0,
        get_tool_spec_tool_name: GET_TOOL_SPEC_TOOL_NAME,
    };

    let err = validate_tool_execution_admission(request)
        .expect_err("allowed-list should be evaluated before runtime restrictions");

    assert!(matches!(
        err,
        ToolExecutionAdmissionRejection::AllowedList(_)
    ));
    assert_eq!(
        err.to_string(),
        "Tool 'WebFetch' is not in the allowed list: [\"Read\"]"
    );

    let request = ToolExecutionAdmissionRequest {
        tool_name: "WebFetch",
        allowed_tools: &["WebFetch".to_string()],
        runtime_tool_restrictions: &restrictions,
        deferred_tools: &["WebFetch".to_string()],
        loaded_deferred_tool_specs: &[],
        current_catalog_generation: 0,
        get_tool_spec_tool_name: GET_TOOL_SPEC_TOOL_NAME,
    };

    let err = validate_tool_execution_admission(request)
        .expect_err("runtime restrictions should run before collapsed unlock");

    assert!(matches!(
        err,
        ToolExecutionAdmissionRejection::RuntimeRestriction(_)
    ));
    assert_eq!(
        err.to_string(),
        "Tool 'WebFetch' is denied by runtime restrictions"
    );

    let request = ToolExecutionAdmissionRequest {
        tool_name: "WebFetch",
        allowed_tools: &["WebFetch".to_string()],
        runtime_tool_restrictions: &ToolRuntimeRestrictions::default(),
        deferred_tools: &["WebFetch".to_string()],
        loaded_deferred_tool_specs: &[],
        current_catalog_generation: 0,
        get_tool_spec_tool_name: GET_TOOL_SPEC_TOOL_NAME,
    };

    let err = validate_tool_execution_admission(request)
        .expect_err("deferred tool should require GetToolSpec after access gates pass");

    assert!(matches!(err, ToolExecutionAdmissionRejection::Deferred(_)));
    assert!(err
        .to_string()
        .contains("Call GetToolSpec first with {\"tool_name\":\"WebFetch\"}"));
}

#[test]
fn remote_posix_path_contract_keeps_workspace_containment_semantics() {
    assert!(posix_style_path_is_absolute(r"\home\workspace"));
    assert_eq!(
        posix_resolve_path_with_workspace(r"src\lib.rs", Some("/home/project"))
            .expect("relative remote path should resolve"),
        "/home/project/src/lib.rs"
    );
    assert!(is_remote_posix_path_within_root(
        "/home/project/src/lib.rs",
        "/home/project"
    ));
    assert!(!is_remote_posix_path_within_root(
        "/home/project2/src/lib.rs",
        "/home/project"
    ));
}

#[test]
fn host_path_contract_keeps_local_workspace_resolution_semantics() {
    let normalized = normalize_host_path("repo/./src/../README.md");
    assert_eq!(
        PathBuf::from(normalized),
        PathBuf::from("repo").join("README.md")
    );

    let workspace = PathBuf::from("/repo/project");
    let resolved = resolve_host_path_with_workspace("src/main.rs", Some(workspace.as_path()))
        .expect("relative local path should resolve from workspace");
    assert_eq!(
        PathBuf::from(resolved),
        workspace.join("src").join("main.rs")
    );

    let missing = resolve_host_path_with_workspace("src/main.rs", None)
        .expect_err("relative local path should require a workspace");
    assert_eq!(
        missing.to_string(),
        "A workspace path is required to resolve relative path: src/main.rs"
    );
}

#[cfg(windows)]
#[test]
fn host_path_contract_normalizes_posix_prefixed_windows_drive_paths() {
    let workspace = PathBuf::from(r"E:\workspace");

    for (malformed, expected) in [
        (
            "/E:/workspace/project/example.txt",
            r"E:\workspace\project\example.txt",
        ),
        (
            "/e:/workspace/project/example.txt",
            r"e:\workspace\project\example.txt",
        ),
        (
            r"/E:\workspace\project\example.txt",
            r"E:\workspace\project\example.txt",
        ),
    ] {
        let resolved = resolve_host_path_with_workspace(malformed, Some(workspace.as_path()))
            .expect("mixed POSIX and Windows drive syntax should be normalized");

        assert_eq!(PathBuf::from(resolved), PathBuf::from(expected));
    }

    let valid = resolve_host_path_with_workspace(
        "E:/workspace/project/example.txt",
        Some(workspace.as_path()),
    )
    .expect("native Windows drive syntax must remain valid");
    assert_eq!(
        PathBuf::from(valid),
        PathBuf::from(r"E:\workspace\project\example.txt")
    );

    let remote = resolve_workspace_tool_path(
        "/E:/workspace/project/example.txt",
        Some("/workspace"),
        true,
    )
    .expect("remote workspaces keep POSIX path semantics");
    assert_eq!(remote, "/E:/workspace/project/example.txt");
}

#[test]
fn unified_tool_path_contract_selects_host_or_remote_semantics() {
    let local = resolve_workspace_tool_path("src/lib.rs", Some("/repo/project"), false)
        .expect("local path should resolve");
    assert_eq!(
        PathBuf::from(local),
        PathBuf::from("/repo/project/src/lib.rs")
    );

    let remote = resolve_workspace_tool_path("src/lib.rs", Some("/home/project"), true)
        .expect("remote path should resolve");
    assert_eq!(remote, "/home/project/src/lib.rs");
}

#[test]
fn dynamic_tool_provider_contract_is_available_from_agent_tools_boundary() {
    fn assert_provider_contract<T: DynamicToolProvider>() {}
    fn assert_decorator_contract<T: ToolDecorator<String>>() {}

    struct MarkerProvider;
    #[async_trait::async_trait]
    impl DynamicToolProvider for MarkerProvider {
        async fn list_dynamic_tools(&self) -> PortResult<Vec<DynamicToolDescriptor>> {
            Ok(Vec::new())
        }
    }

    struct MarkerDecorator;
    impl ToolDecorator<String> for MarkerDecorator {
        fn decorate(&self, tool: String) -> String {
            tool
        }
    }

    assert_provider_contract::<MarkerProvider>();
    assert_decorator_contract::<MarkerDecorator>();
}

#[test]
fn tool_exposure_contract_keeps_lightweight_wire_shape() {
    let collapsed = ToolExposure::Deferred;
    let value = serde_json::to_value(collapsed).expect("serialize exposure");

    assert_eq!(value, json!("Deferred"));
    assert_eq!(
        serde_json::from_value::<ToolExposure>(value).expect("deserialize exposure"),
        ToolExposure::Deferred
    );
}

#[test]
fn tool_manifest_definition_keeps_lightweight_wire_shape() {
    let definition = ToolManifestDefinition::new(
        "Read",
        "Read a file",
        json!({
            "type": "object",
            "properties": {
                "file_path": { "type": "string" }
            },
            "required": ["file_path"]
        }),
    );

    let value = serde_json::to_value(&definition).expect("serialize definition");

    assert_eq!(value["name"], json!("Read"));
    assert_eq!(value["description"], json!("Read a file"));
    assert_eq!(value["parameters"]["required"], json!(["file_path"]));
    assert_eq!(
        serde_json::from_value::<ToolManifestDefinition>(value).expect("deserialize definition"),
        definition
    );
}

#[test]
fn tool_manifest_policy_keeps_get_tool_spec_insertion_and_registry_order() {
    let tools = vec![
        ToolManifestPolicyTool {
            name: "Read".to_string(),
            default_exposure: ToolExposure::Direct,
            available: true,
        },
        ToolManifestPolicyTool {
            name: "WebSearch".to_string(),
            default_exposure: ToolExposure::Deferred,
            available: true,
        },
        ToolManifestPolicyTool {
            name: "WebFetch".to_string(),
            default_exposure: ToolExposure::Deferred,
            available: true,
        },
        ToolManifestPolicyTool {
            name: GET_TOOL_SPEC_TOOL_NAME.to_string(),
            default_exposure: ToolExposure::Direct,
            available: true,
        },
        ToolManifestPolicyTool {
            name: "HiddenUnavailable".to_string(),
            default_exposure: ToolExposure::Direct,
            available: false,
        },
    ];
    let allowed_tools = vec![
        "WebFetch".to_string(),
        "Read".to_string(),
        "WebSearch".to_string(),
        "HiddenUnavailable".to_string(),
    ];
    let overrides = Default::default();

    let policy =
        resolve_tool_manifest_policy(&tools, &allowed_tools, &overrides, GET_TOOL_SPEC_TOOL_NAME);

    assert_eq!(
        policy.allowed_tool_names,
        vec![
            "WebFetch",
            "Read",
            "WebSearch",
            "HiddenUnavailable",
            GET_TOOL_SPEC_TOOL_NAME,
            CALL_DEFERRED_TOOL_NAME,
        ]
    );
    assert_eq!(
        policy.direct_tool_names,
        vec!["Read", GET_TOOL_SPEC_TOOL_NAME]
    );
    assert_eq!(policy.deferred_tool_names, vec!["WebSearch", "WebFetch"]);
}

#[test]
fn tool_manifest_policy_preserves_explicit_get_tool_spec_duplicate_runtime_contract() {
    let tools = vec![
        ToolManifestPolicyTool {
            name: GET_TOOL_SPEC_TOOL_NAME.to_string(),
            default_exposure: ToolExposure::Direct,
            available: true,
        },
        ToolManifestPolicyTool {
            name: "WebFetch".to_string(),
            default_exposure: ToolExposure::Deferred,
            available: true,
        },
    ];
    let allowed_tools = vec![GET_TOOL_SPEC_TOOL_NAME.to_string(), "WebFetch".to_string()];
    let overrides = Default::default();

    let policy =
        resolve_tool_manifest_policy(&tools, &allowed_tools, &overrides, GET_TOOL_SPEC_TOOL_NAME);

    assert_eq!(
        policy.allowed_tool_names,
        vec![GET_TOOL_SPEC_TOOL_NAME, "WebFetch", CALL_DEFERRED_TOOL_NAME]
    );
    assert_eq!(
        policy.direct_tool_names,
        vec![GET_TOOL_SPEC_TOOL_NAME],
        "explicit GetToolSpec must not be duplicated when deferred tools exist"
    );
    assert_eq!(policy.deferred_tool_names, vec!["WebFetch"]);
}

#[test]
fn get_tool_spec_load_collector_preserves_collapsed_runtime_contract() {
    let deferred_tools = vec!["WebFetch".to_string(), "GetFileDiff".to_string()];
    let observations = vec![
        GetToolSpecLoadObservation {
            tool_name: GET_TOOL_SPEC_TOOL_NAME,
            loaded_tool_name: Some("WebFetch"),
            catalog_generation: Some(42),
            is_error: false,
        },
        GetToolSpecLoadObservation {
            tool_name: GET_TOOL_SPEC_TOOL_NAME,
            loaded_tool_name: Some("Read"),
            catalog_generation: Some(42),
            is_error: false,
        },
        GetToolSpecLoadObservation {
            tool_name: GET_TOOL_SPEC_TOOL_NAME,
            loaded_tool_name: Some("GetFileDiff"),
            catalog_generation: Some(42),
            is_error: true,
        },
        GetToolSpecLoadObservation {
            tool_name: "Read",
            loaded_tool_name: Some("WebFetch"),
            catalog_generation: Some(42),
            is_error: false,
        },
        GetToolSpecLoadObservation {
            tool_name: GET_TOOL_SPEC_TOOL_NAME,
            loaded_tool_name: Some("WebFetch"),
            catalog_generation: Some(42),
            is_error: false,
        },
    ];

    let loaded =
        collect_loaded_deferred_tool_specs(&observations, &deferred_tools, GET_TOOL_SPEC_TOOL_NAME);

    assert_eq!(
        loaded,
        vec![LoadedDeferredToolSpec {
            tool_name: "WebFetch".to_string(),
            catalog_generation: 42,
        }]
    );
}

#[test]
fn tool_manifest_sorting_preserves_prompt_visible_order() {
    let mut definitions = vec![
        ToolManifestDefinition::new("ControlHub", "control", json!({ "type": "object" })),
        ToolManifestDefinition::new("Read", "read", json!({ "type": "object" })),
        ToolManifestDefinition::new("ExternalTool", "external", json!({ "type": "object" })),
        ToolManifestDefinition::new("GetToolSpec", "spec", json!({ "type": "object" })),
        ToolManifestDefinition::new("Task", "task", json!({ "type": "object" })),
    ];

    sort_tool_manifest_definitions(&mut definitions);

    assert_eq!(
        definitions
            .iter()
            .map(|definition| definition.name.as_str())
            .collect::<Vec<_>>(),
        vec!["Task", "Read", "GetToolSpec", "ControlHub", "ExternalTool"]
    );
}

#[test]
fn prompt_visible_manifest_builder_omits_deferred_tools_from_provider_manifest() {
    let definitions = build_prompt_visible_tool_manifest_definitions(&[
        PromptVisibleToolManifestItem::Direct(ToolManifestDefinition::new(
            "Read",
            "Read files from the workspace.",
            json!({ "type": "object", "properties": { "path": { "type": "string" } } }),
        )),
        PromptVisibleToolManifestItem::Direct(ToolManifestDefinition::new(
            "ExecCommand",
            "Run shell commands.",
            json!({ "type": "object", "properties": { "cmd": { "type": "string" } } }),
        )),
    ]);

    assert_eq!(
        definitions
            .iter()
            .map(|definition| definition.name.as_str())
            .collect::<Vec<_>>(),
        vec!["ExecCommand", "Read"]
    );
    assert_eq!(definitions[0].description, "Run shell commands.");
    assert_eq!(
        definitions[0].parameters["properties"]["cmd"]["type"],
        json!("string")
    );
}

#[test]
fn get_tool_spec_contract_preserves_input_schema_and_validation() {
    let schema = get_tool_spec_input_schema();

    assert_eq!(schema["type"], "object");
    assert_eq!(schema["additionalProperties"], false);
    assert_eq!(schema["required"], json!(["tool_name"]));
    assert_eq!(schema["properties"]["tool_name"]["type"], "string");
    assert!(schema["properties"]["tool_name"]["description"]
        .as_str()
        .unwrap_or_default()
        .contains("canonical casing"));

    let missing = validate_get_tool_spec_input(&json!({}));
    assert!(!missing.result);
    assert_eq!(
        missing.message.as_deref(),
        Some("tool_name is required and cannot be empty")
    );
    assert_eq!(missing.error_code, Some(400));

    let empty = validate_get_tool_spec_input(&json!({ "tool_name": "" }));
    assert!(!empty.result);
    assert_eq!(
        empty.message.as_deref(),
        Some("tool_name is required and cannot be empty")
    );
    assert_eq!(empty.error_code, Some(400));

    assert!(validate_get_tool_spec_input(&json!({ "tool_name": "Git" })).result);
}

#[test]
fn get_tool_spec_contract_preserves_static_metadata_and_use_message() {
    assert_eq!(
        get_tool_spec_short_description(),
        "Discover deferred tools and read their detailed definitions."
    );
    assert!(get_tool_spec_is_readonly());
    assert!(get_tool_spec_is_concurrency_safe(Some(&json!({
        "tool_name": "WebFetch"
    }))));
    assert_eq!(
        render_get_tool_spec_tool_use_message(&json!({ "tool_name": "Git" })),
        "Reading tool spec for 'Git'."
    );
    assert_eq!(
        render_get_tool_spec_tool_use_message(&json!({})),
        "Reading tool spec for '?'."
    );
}

#[test]
fn get_tool_spec_contract_escapes_assistant_detail_for_xml_sections() {
    let detail = build_get_tool_spec_assistant_detail(
        "Git",
        "Use <danger> & keep output valid.",
        &json!({
            "type": "object",
            "properties": {
                "query": {
                    "description": "Match <tag> & symbols"
                }
            }
        }),
    );

    assert!(detail.contains("<description>\nUse &lt;danger&gt; &amp; keep output valid."));
    assert!(
        detail.contains("<calling>\nCall `CallDeferredTool` with arguments matching this schema:")
    );
    assert!(detail.contains("\"required\": [\"tool_name\", \"args\"]"));
    assert!(detail.contains("\"tool_name\": {\n      \"const\": \"Git\"\n    }"));
    assert!(detail.contains("\"args\": {"));
    assert!(detail.contains("\"description\": \"Match &lt;tag&gt; &amp; symbols\""));
    assert!(!detail.contains("<input_schema>"));
    assert!(!detail.contains("<execution>"));
    assert!(!detail.contains("Use <danger> & keep output valid."));
}

#[test]
fn get_tool_spec_contract_preserves_duplicate_load_hint() {
    assert_eq!(
        build_get_tool_spec_duplicate_load_hint("WebFetch"),
        "Tool 'WebFetch' is already loaded in the current context. Use CallDeferredTool with tool_name 'WebFetch' and put the tool arguments inside args. Reload with GetToolSpec only if its full definition leaves the context or the runtime reports it stale."
    );
}

#[test]
fn get_tool_spec_contract_builds_duplicate_load_result() {
    let result = build_get_tool_spec_duplicate_load_result("WebFetch");

    let ToolResult::Result {
        data,
        result_for_assistant,
        image_attachments,
    } = result
    else {
        panic!("expected normal tool result");
    };

    assert_eq!(data["tool_name"], "WebFetch");
    assert_eq!(data["already_loaded"], true);
    assert_eq!(
        result_for_assistant.as_deref(),
        Some(
            "Tool 'WebFetch' is already loaded in the current context. Use CallDeferredTool with tool_name 'WebFetch' and put the tool arguments inside args. Reload with GetToolSpec only if its full definition leaves the context or the runtime reports it stale."
        )
    );
    assert_eq!(image_attachments, None);
}

#[test]
fn get_tool_spec_contract_builds_detail_result() {
    let result = build_get_tool_spec_detail_result(&openbitfun_agent_tools::GetToolSpecDetail {
        tool_name: "Git".to_string(),
        description: "Use <repo> & inspect changes.".to_string(),
        input_schema: json!({
            "type": "object",
            "properties": {
                "command": {
                    "type": "string",
                    "description": "Run <safe> git commands"
                }
            }
        }),
        catalog_generation: 42,
    });

    let ToolResult::Result {
        data,
        result_for_assistant,
        image_attachments,
    } = result
    else {
        panic!("expected normal tool result");
    };

    assert_eq!(data["tool_name"], "Git");
    assert_eq!(data["description"], "Use <repo> & inspect changes.");
    assert_eq!(
        data["input_schema"]["properties"]["command"]["type"],
        "string"
    );
    let assistant = result_for_assistant.expect("assistant detail");
    assert!(assistant.contains("Use &lt;repo&gt; &amp; inspect changes."));
    assert!(assistant.contains("Run &lt;safe&gt; git commands"));
    assert!(assistant.contains("\"tool_name\": {\n      \"const\": \"Git\"\n    }"));
    assert!(assistant.contains("\"args\": {"));
    assert!(!assistant.contains("<input_schema>"));
    assert!(!assistant.contains("<execution>"));
    assert_eq!(image_attachments, None);
}

#[test]
fn get_tool_spec_contract_plans_duplicate_load_without_core_context() {
    let input = json!({ "tool_name": "WebFetch" });
    let plan = openbitfun_agent_tools::resolve_get_tool_spec_execution_plan(
        &input,
        &["WebFetch".to_string()],
    )
    .expect("duplicate load should be planned");

    let GetToolSpecExecutionPlan::DuplicateLoad(result) = plan else {
        panic!("expected duplicate-load plan");
    };

    let ToolResult::Result {
        data,
        result_for_assistant,
        image_attachments,
    } = result
    else {
        panic!("expected normal tool result");
    };

    assert_eq!(data["tool_name"], "WebFetch");
    assert_eq!(data["already_loaded"], true);
    assert!(result_for_assistant
        .as_deref()
        .unwrap_or_default()
        .contains("already loaded in the current context"));
    assert_eq!(image_attachments, None);
}

#[test]
fn get_tool_spec_contract_plans_detail_load_without_resolving_product_detail() {
    let input = json!({ "tool_name": "Git" });
    let plan = openbitfun_agent_tools::resolve_get_tool_spec_execution_plan(
        &input,
        &["WebFetch".to_string()],
    )
    .expect("detail load should be planned");

    let GetToolSpecExecutionPlan::LoadDetail { tool_name } = plan else {
        panic!("expected detail-load plan");
    };

    assert_eq!(tool_name, "Git");
}

#[test]
fn get_tool_spec_contract_rejects_missing_tool_name_in_execution_plan() {
    let err = openbitfun_agent_tools::resolve_get_tool_spec_execution_plan(&json!({}), &[])
        .expect_err("missing tool name should be rejected");

    assert_eq!(err, GetToolSpecExecutionError::MissingToolName);
    assert_eq!(err.to_string(), "tool_name is required");
}

#[derive(Clone)]
struct RegistryMarkerTool {
    name: String,
    provider_id: Option<String>,
    exposure: ToolExposure,
    readonly: bool,
    enabled: bool,
}

struct StaticToolWithFailingDescription;

struct InputSensitiveEffectTool;

#[async_trait::async_trait]
impl ToolRegistryItem for RegistryMarkerTool {
    fn name(&self) -> &str {
        &self.name
    }

    async fn description(&self) -> Result<String, String> {
        Ok("marker tool".to_string())
    }

    fn input_schema(&self) -> serde_json::Value {
        json!({ "type": "object" })
    }

    fn default_exposure(&self) -> ToolExposure {
        self.exposure
    }

    fn is_readonly(&self) -> bool {
        self.readonly
    }

    async fn is_enabled(&self) -> bool {
        self.enabled
    }

    async fn input_schema_for_model(&self) -> serde_json::Value {
        self.input_schema()
    }

    fn dynamic_tool_info(&self) -> Option<DynamicToolInfo> {
        self.provider_id
            .as_ref()
            .map(|provider_id| DynamicToolInfo {
                provider_id: provider_id.clone(),
                provider_kind: None,
                mcp: None,
            })
    }
}

#[async_trait::async_trait]
impl ToolRegistryItem for StaticToolWithFailingDescription {
    fn name(&self) -> &str {
        "static_failing_description"
    }

    async fn description(&self) -> Result<String, String> {
        Err("static description should not be materialized".to_string())
    }

    fn input_schema(&self) -> serde_json::Value {
        json!({ "type": "object" })
    }
}

#[async_trait::async_trait]
impl ToolRegistryItem for InputSensitiveEffectTool {
    fn name(&self) -> &str {
        "input_sensitive"
    }

    async fn description(&self) -> Result<String, String> {
        Ok("input-sensitive effect tool".to_string())
    }

    fn input_schema(&self) -> serde_json::Value {
        json!({
            "type": "object",
            "properties": {
                "action": {
                    "type": "string"
                }
            }
        })
    }

    fn is_readonly(&self) -> bool {
        false
    }

    fn is_concurrency_safe(&self, input: Option<&serde_json::Value>) -> bool {
        matches!(
            input
                .and_then(|value| value.get("action"))
                .and_then(serde_json::Value::as_str),
            Some("status")
        )
    }
}

#[derive(Debug, Clone, Copy)]
struct ManifestTestContext {
    agent: &'static str,
}

#[derive(Clone)]
struct ContextualManifestTool {
    name: String,
    exposure: ToolExposure,
    available_for_agent: Option<&'static str>,
}

#[async_trait::async_trait]
impl ToolRegistryItem for ContextualManifestTool {
    fn name(&self) -> &str {
        &self.name
    }

    async fn description(&self) -> Result<String, String> {
        Ok(format!("{} default description", self.name))
    }

    fn short_description(&self) -> String {
        format!("{} short description", self.name)
    }

    fn input_schema(&self) -> serde_json::Value {
        json!({ "type": "object" })
    }

    fn default_exposure(&self) -> ToolExposure {
        self.exposure
    }
}

#[async_trait::async_trait]
impl ContextualToolManifestItem<ManifestTestContext> for ContextualManifestTool {
    async fn is_available_in_context(&self, context: &ManifestTestContext) -> bool {
        self.available_for_agent
            .is_none_or(|agent| agent == context.agent)
    }

    async fn description_with_context(
        &self,
        context: &ManifestTestContext,
    ) -> Result<String, String> {
        Ok(format!("{} description for {}", self.name, context.agent))
    }

    async fn input_schema_for_model_with_context(
        &self,
        context: &ManifestTestContext,
    ) -> serde_json::Value {
        json!({
            "type": "object",
            "properties": {
                "agent": {
                    "const": context.agent
                }
            }
        })
    }
}

fn registry_marker_tool(name: &str, provider_id: Option<&str>) -> Arc<RegistryMarkerTool> {
    registry_marker_tool_with_exposure(name, provider_id, ToolExposure::Direct)
}

fn registry_marker_tool_with_exposure(
    name: &str,
    provider_id: Option<&str>,
    exposure: ToolExposure,
) -> Arc<RegistryMarkerTool> {
    registry_marker_tool_with_access(name, provider_id, exposure, false, true)
}

fn registry_marker_tool_with_access(
    name: &str,
    provider_id: Option<&str>,
    exposure: ToolExposure,
    readonly: bool,
    enabled: bool,
) -> Arc<RegistryMarkerTool> {
    Arc::new(RegistryMarkerTool {
        name: name.to_string(),
        provider_id: provider_id.map(str::to_string),
        exposure,
        readonly,
        enabled,
    })
}

fn contextual_manifest_tool(
    name: &str,
    exposure: ToolExposure,
    available_for_agent: Option<&'static str>,
) -> Arc<ContextualManifestTool> {
    Arc::new(ContextualManifestTool {
        name: name.to_string(),
        exposure,
        available_for_agent,
    })
}

struct ContextualManifestSnapshotProvider {
    tools: Vec<Arc<ContextualManifestTool>>,
}

struct RegistryMarkerSnapshotProvider {
    tools: Vec<Arc<RegistryMarkerTool>>,
}

struct ErroringGetToolSpecProvider;

#[async_trait::async_trait]
impl ToolCatalogSnapshotProvider<ContextualManifestTool> for ContextualManifestSnapshotProvider {
    async fn tool_snapshot(&self) -> Vec<Arc<ContextualManifestTool>> {
        self.tools.clone()
    }
}

#[async_trait::async_trait]
impl ToolCatalogSnapshotProvider<RegistryMarkerTool> for RegistryMarkerSnapshotProvider {
    async fn tool_snapshot(&self) -> Vec<Arc<RegistryMarkerTool>> {
        self.tools.clone()
    }
}

#[async_trait::async_trait]
impl GetToolSpecCatalogProvider<ContextualManifestTool, ManifestTestContext>
    for ContextualManifestSnapshotProvider
{
    async fn deferred_tools_for_get_tool_spec(
        &self,
        context: Option<&ManifestTestContext>,
    ) -> Result<Vec<Arc<ContextualManifestTool>>, String> {
        let tools = match context {
            Some(context) => {
                let mut tools = Vec::new();
                for tool in &self.tools {
                    if tool.default_exposure() == ToolExposure::Deferred
                        && tool.is_available_in_context(context).await
                    {
                        tools.push(tool.clone());
                    }
                }
                tools
            }
            None => self
                .tools
                .iter()
                .filter(|tool| tool.default_exposure() == ToolExposure::Deferred)
                .cloned()
                .collect(),
        };

        Ok(tools)
    }

    async fn available_tools_for_get_tool_spec(
        &self,
        context: Option<&ManifestTestContext>,
    ) -> Result<Vec<Arc<ContextualManifestTool>>, String> {
        let tools = match context {
            Some(context) => {
                let mut tools = Vec::new();
                for tool in &self.tools {
                    if tool.is_available_in_context(context).await {
                        tools.push(tool.clone());
                    }
                }
                tools
            }
            None => self.tools.clone(),
        };

        Ok(tools)
    }
}

#[async_trait::async_trait]
impl GetToolSpecCatalogProvider<ContextualManifestTool, ManifestTestContext>
    for ErroringGetToolSpecProvider
{
    async fn deferred_tools_for_get_tool_spec(
        &self,
        _context: Option<&ManifestTestContext>,
    ) -> Result<Vec<Arc<ContextualManifestTool>>, String> {
        Err("provider should not be called for duplicate-load execution".to_string())
    }
}

struct RegistryMarkerProvider {
    provider_id: &'static str,
    tools: Vec<Arc<RegistryMarkerTool>>,
}

impl StaticToolProvider<RegistryMarkerTool> for RegistryMarkerProvider {
    fn provider_id(&self) -> &'static str {
        self.provider_id
    }

    fn tools(&self) -> Vec<Arc<RegistryMarkerTool>> {
        self.tools.clone()
    }
}

#[test]
fn static_tool_provider_group_preserves_provider_id_and_tool_order() {
    let provider = StaticToolProviderGroup::new(
        "core-basic",
        vec![
            registry_marker_tool("Read", None),
            registry_marker_tool("Write", None),
        ],
    );

    assert_eq!(provider.provider_id(), "core-basic");
    assert_eq!(
        provider
            .tools()
            .iter()
            .map(|tool| tool.name())
            .collect::<Vec<_>>(),
        vec!["Read", "Write"]
    );
}

struct RegistryMarkerToolFactory;

impl StaticToolProviderFactory<RegistryMarkerTool> for RegistryMarkerToolFactory {
    fn materialize_tool(&self, tool_name: &str) -> Option<Arc<RegistryMarkerTool>> {
        match tool_name {
            "Read" | "Write" | "WebFetch" => Some(registry_marker_tool(tool_name, None)),
            _ => None,
        }
    }
}

#[test]
fn static_tool_materializer_preserves_provider_and_tool_order() {
    let plans = [
        TestProviderPlan {
            provider_id: "core.basic",
            tool_names: &["Read", "Write"],
        },
        TestProviderPlan {
            provider_id: "core.integration",
            tool_names: &["WebFetch"],
        },
    ];

    let providers = materialize_static_tool_provider_groups(&plans, &RegistryMarkerToolFactory)
        .expect("static tools should materialize");

    assert_eq!(providers[0].provider_id(), "core.basic");
    assert_eq!(
        providers[0]
            .tools()
            .iter()
            .map(|tool| tool.name())
            .collect::<Vec<_>>(),
        vec!["Read", "Write"]
    );
    assert_eq!(providers[1].provider_id(), "core.integration");
    assert_eq!(
        providers[1]
            .tools()
            .iter()
            .map(|tool| tool.name())
            .collect::<Vec<_>>(),
        vec!["WebFetch"]
    );
}

#[test]
fn static_tool_materializer_rejects_unknown_tools() {
    let plans = [TestProviderPlan {
        provider_id: "core.basic",
        tool_names: &["Read", "Missing"],
    }];

    let error = materialize_static_tool_provider_groups(&plans, &RegistryMarkerToolFactory)
        .expect_err("unknown tool names must not be silently skipped");

    assert_eq!(
        error,
        StaticToolMaterializationError::UnknownTool {
            provider_id: "core.basic",
            tool_name: "Missing",
        }
    );
}

struct RegistryMarkerDecorator;

impl ToolDecorator<Arc<RegistryMarkerTool>> for RegistryMarkerDecorator {
    fn decorate(&self, tool: Arc<RegistryMarkerTool>) -> Arc<RegistryMarkerTool> {
        Arc::new(RegistryMarkerTool {
            name: format!("decorated_{}", tool.name),
            provider_id: tool.provider_id.clone(),
            exposure: tool.exposure,
            readonly: tool.readonly,
            enabled: tool.enabled,
        })
    }
}

struct RegistryMarkerSnapshotWrapper;

impl openbitfun_agent_tools::SnapshotToolWrapper<RegistryMarkerTool>
    for RegistryMarkerSnapshotWrapper
{
    fn wrap_for_snapshot_tracking(&self, tool: Arc<RegistryMarkerTool>) -> Arc<RegistryMarkerTool> {
        Arc::new(RegistryMarkerTool {
            name: format!("snapshot_{}", tool.name),
            provider_id: tool.provider_id.clone(),
            exposure: tool.exposure,
            readonly: tool.readonly,
            enabled: tool.enabled,
        })
    }
}

#[test]
fn generic_tool_registry_installs_static_provider_in_order() {
    let mut registry = ToolRegistry::new();
    let provider = RegistryMarkerProvider {
        provider_id: "core-basic",
        tools: vec![
            registry_marker_tool("Read", None),
            registry_marker_tool("Write", None),
        ],
    };

    registry.install_static_provider(&provider);

    assert_eq!(provider.provider_id(), "core-basic");
    assert_eq!(
        registry.get_tool_names(),
        vec!["Read".to_string(), "Write".to_string()]
    );
}

#[test]
fn generic_tool_registry_applies_decorator_to_static_provider_tools() {
    let mut registry = ToolRegistry::with_tool_decorator(Arc::new(RegistryMarkerDecorator));
    let provider = RegistryMarkerProvider {
        provider_id: "decorated-provider",
        tools: vec![registry_marker_tool("Read", None)],
    };

    registry.install_static_provider(&provider);

    assert_eq!(
        registry.get_tool_names(),
        vec!["decorated_Read".to_string()]
    );
}

#[test]
fn generic_snapshot_tool_decorator_delegates_to_snapshot_wrapper_port() {
    let decorator: ToolDecoratorRef<RegistryMarkerTool> = Arc::new(
        openbitfun_agent_tools::SnapshotToolDecorator::new(Arc::new(RegistryMarkerSnapshotWrapper)),
    );
    let providers = vec![StaticToolProviderGroup::new(
        "core-basic",
        vec![registry_marker_tool("Write", None)],
    )];

    let registry = ToolRuntimeAssembly::with_tool_decorator(decorator)
        .create_registry_from_static_providers(&providers);

    assert_eq!(
        registry.get_tool_names(),
        vec!["snapshot_Write".to_string()],
        "snapshot decorator must delegate wrapping through the portable wrapper port"
    );
}

#[test]
fn generic_tool_runtime_assembly_installs_static_providers_with_decorator() {
    let decorator: ToolDecoratorRef<RegistryMarkerTool> = Arc::new(RegistryMarkerDecorator);
    let providers = vec![
        StaticToolProviderGroup::new("core-basic", vec![registry_marker_tool("Read", None)]),
        StaticToolProviderGroup::new(
            "core-integration",
            vec![registry_marker_tool_with_exposure(
                "WebFetch",
                None,
                ToolExposure::Deferred,
            )],
        ),
    ];

    let registry = ToolRuntimeAssembly::with_tool_decorator(decorator)
        .create_registry_from_static_providers(&providers);

    assert_eq!(
        registry.get_tool_names(),
        vec![
            "decorated_Read".to_string(),
            "decorated_WebFetch".to_string()
        ],
        "runtime assembly must preserve static provider order while applying the decorator"
    );
    assert_eq!(
        registry.get_deferred_tool_names(),
        vec!["decorated_WebFetch".to_string()],
        "runtime assembly must preserve deferred exposure after decoration"
    );
}

#[test]
fn generic_tool_runtime_assembly_materializes_plans_before_registry_install() {
    let decorator: ToolDecoratorRef<RegistryMarkerTool> = Arc::new(RegistryMarkerDecorator);
    let plans = [
        TestProviderPlan {
            provider_id: "core.basic",
            tool_names: &["Read", "Write"],
        },
        TestProviderPlan {
            provider_id: "core.integration",
            tool_names: &["WebFetch"],
        },
    ];

    let registry = ToolRuntimeAssembly::with_tool_decorator(decorator)
        .create_registry_from_static_provider_plans(&plans, &RegistryMarkerToolFactory)
        .expect("plans should materialize into a registry");

    assert_eq!(
        registry.get_tool_names(),
        vec![
            "decorated_Read".to_string(),
            "decorated_Write".to_string(),
            "decorated_WebFetch".to_string()
        ],
        "assembly must own generic plan materialization plus registry installation"
    );
    assert_eq!(
        registry.get_deferred_tool_names(),
        Vec::<String>::new(),
        "decorator-based plan materialization must not change exposure"
    );
}

#[test]
fn generic_tool_registry_preserves_exposure_catalog_contract() {
    let mut registry = ToolRegistry::new();
    registry.register_tool(registry_marker_tool("Read", None));
    registry.register_tool(registry_marker_tool_with_exposure(
        "WebFetch",
        None,
        ToolExposure::Deferred,
    ));
    registry.register_tool(registry_marker_tool_with_exposure(
        "Git",
        None,
        ToolExposure::Deferred,
    ));

    assert!(!registry.is_tool_deferred("Read"));
    assert!(registry.is_tool_deferred("WebFetch"));
    assert_eq!(
        registry.get_deferred_tool_names(),
        vec!["WebFetch".to_string(), "Git".to_string()]
    );
}

#[tokio::test]
async fn generic_readonly_enabled_filter_preserves_registry_order() {
    let tools = vec![
        registry_marker_tool_with_access("Read", None, ToolExposure::Direct, true, true),
        registry_marker_tool_with_access("Write", None, ToolExposure::Direct, false, true),
        registry_marker_tool_with_access(
            "DisabledReadonly",
            None,
            ToolExposure::Direct,
            true,
            false,
        ),
        registry_marker_tool_with_access("WebFetch", None, ToolExposure::Deferred, true, true),
    ];

    let readonly_names = resolve_readonly_enabled_tools(&tools)
        .await
        .iter()
        .map(|tool| tool.name().to_string())
        .collect::<Vec<_>>();

    assert_eq!(
        readonly_names,
        vec!["Read".to_string(), "WebFetch".to_string()],
        "readonly filtering must keep registry order and skip disabled or mutating tools"
    );
}

#[test]
fn manifest_policy_tools_from_registry_snapshot_preserve_exposure_and_availability() {
    let tools = vec![
        registry_marker_tool("Read", None),
        registry_marker_tool_with_exposure("WebFetch", None, ToolExposure::Deferred),
        registry_marker_tool_with_exposure("Git", None, ToolExposure::Deferred),
    ];
    let available_tool_names = ["Read".to_string(), "Git".to_string()]
        .into_iter()
        .collect();

    let policy_tools =
        openbitfun_agent_tools::build_tool_manifest_policy_tools(&tools, &available_tool_names);

    assert_eq!(
        policy_tools,
        vec![
            ToolManifestPolicyTool {
                name: "Read".to_string(),
                default_exposure: ToolExposure::Direct,
                available: true,
            },
            ToolManifestPolicyTool {
                name: "WebFetch".to_string(),
                default_exposure: ToolExposure::Deferred,
                available: false,
            },
            ToolManifestPolicyTool {
                name: "Git".to_string(),
                default_exposure: ToolExposure::Deferred,
                available: true,
            },
        ]
    );
}

#[tokio::test]
async fn contextual_manifest_resolver_preserves_runtime_visible_manifest_contract() {
    let tools = vec![
        contextual_manifest_tool("Read", ToolExposure::Direct, None),
        contextual_manifest_tool("WebFetch", ToolExposure::Deferred, None),
        contextual_manifest_tool("Git", ToolExposure::Deferred, Some("other-agent")),
        contextual_manifest_tool(GET_TOOL_SPEC_TOOL_NAME, ToolExposure::Direct, None),
    ];

    let manifest = resolve_contextual_tool_manifest(
        &tools,
        &[
            "Read".to_string(),
            "WebFetch".to_string(),
            "Git".to_string(),
        ],
        &Default::default(),
        &ManifestTestContext { agent: "Standard" },
        GET_TOOL_SPEC_TOOL_NAME,
    )
    .await;

    assert_eq!(
        manifest.allowed_tool_names,
        vec![
            "Read".to_string(),
            "WebFetch".to_string(),
            "Git".to_string(),
            GET_TOOL_SPEC_TOOL_NAME.to_string(),
            CALL_DEFERRED_TOOL_NAME.to_string(),
        ],
        "GetToolSpec insertion must preserve the runtime allowed-list contract"
    );
    assert_eq!(
        manifest.deferred_tool_names,
        vec!["WebFetch".to_string()],
        "unavailable deferred tools must not leak into the prompt-visible unlock catalog"
    );
    assert_eq!(
        manifest
            .direct_tools
            .iter()
            .map(|tool| tool.name.as_str())
            .collect::<Vec<_>>(),
        vec!["Read", GET_TOOL_SPEC_TOOL_NAME],
        "direct tool handles must follow the resolved runtime policy"
    );
    assert_eq!(
        manifest
            .deferred_tools
            .iter()
            .map(|tool| tool.name.as_str())
            .collect::<Vec<_>>(),
        vec!["WebFetch"],
        "deferred tool handles must follow the resolved runtime policy"
    );
    assert_eq!(
        manifest
            .tool_definitions
            .iter()
            .map(|tool| tool.name.as_str())
            .collect::<Vec<_>>(),
        vec!["Read", GET_TOOL_SPEC_TOOL_NAME],
        "prompt-visible manifest ordering must stay stable when the owner moves"
    );

    let read = manifest
        .tool_definitions
        .iter()
        .find(|tool| tool.name == "Read")
        .expect("expanded Read manifest");
    assert_eq!(read.description, "Read description for agentic");
    assert_eq!(read.parameters["properties"]["agent"]["const"], "Standard");

    assert!(!manifest
        .tool_definitions
        .iter()
        .any(|tool| tool.name == "WebFetch"));
}

#[tokio::test]
async fn contextual_manifest_resolver_accepts_snapshot_provider_boundary() {
    let provider = ContextualManifestSnapshotProvider {
        tools: vec![
            contextual_manifest_tool("Read", ToolExposure::Direct, None),
            contextual_manifest_tool("WebFetch", ToolExposure::Deferred, None),
            contextual_manifest_tool("Git", ToolExposure::Deferred, Some("other-agent")),
            contextual_manifest_tool(GET_TOOL_SPEC_TOOL_NAME, ToolExposure::Direct, None),
        ],
    };

    let manifest = resolve_contextual_tool_manifest_from_provider(
        &provider,
        &[
            "Read".to_string(),
            "WebFetch".to_string(),
            "Git".to_string(),
        ],
        &Default::default(),
        &ManifestTestContext { agent: "Standard" },
        GET_TOOL_SPEC_TOOL_NAME,
    )
    .await;

    assert_eq!(
        manifest.allowed_tool_names,
        vec![
            "Read".to_string(),
            "WebFetch".to_string(),
            "Git".to_string(),
            GET_TOOL_SPEC_TOOL_NAME.to_string(),
            CALL_DEFERRED_TOOL_NAME.to_string(),
        ],
        "provider-backed resolution must preserve allowed-list semantics"
    );
    assert_eq!(
        manifest
            .tool_definitions
            .iter()
            .map(|tool| tool.name.as_str())
            .collect::<Vec<_>>(),
        vec!["Read", GET_TOOL_SPEC_TOOL_NAME],
        "provider-backed resolution must preserve prompt-visible manifest ordering"
    );
    assert_eq!(
        manifest.deferred_tool_names,
        vec!["WebFetch".to_string()],
        "provider-backed resolution must preserve context-aware availability filtering"
    );
}

#[tokio::test]
async fn tool_catalog_runtime_facade_owns_manifest_and_readonly_paths() {
    let manifest_provider = ContextualManifestSnapshotProvider {
        tools: vec![
            contextual_manifest_tool("Read", ToolExposure::Direct, None),
            contextual_manifest_tool("WebFetch", ToolExposure::Deferred, None),
            contextual_manifest_tool("Git", ToolExposure::Deferred, Some("other-agent")),
            contextual_manifest_tool(GET_TOOL_SPEC_TOOL_NAME, ToolExposure::Direct, None),
        ],
    };
    let runtime = ToolCatalogRuntime::<ContextualManifestTool, ManifestTestContext, _>::new(
        &manifest_provider,
        GET_TOOL_SPEC_TOOL_NAME,
    );

    let visible_tools = runtime
        .visible_tools(
            &[
                "Read".to_string(),
                "WebFetch".to_string(),
                "Git".to_string(),
            ],
            &Default::default(),
            &ManifestTestContext { agent: "Standard" },
        )
        .await;
    assert_eq!(
        visible_tools.allowed_tool_names,
        vec![
            "Read".to_string(),
            "WebFetch".to_string(),
            "Git".to_string(),
            GET_TOOL_SPEC_TOOL_NAME.to_string(),
            CALL_DEFERRED_TOOL_NAME.to_string(),
        ],
        "runtime facade must preserve allowed-list insertion"
    );
    assert_eq!(
        visible_tools
            .direct_tools
            .iter()
            .map(|tool| tool.name.as_str())
            .collect::<Vec<_>>(),
        vec!["Read", GET_TOOL_SPEC_TOOL_NAME],
        "runtime facade must preserve direct handle order"
    );
    assert_eq!(
        visible_tools.deferred_tool_names,
        vec!["WebFetch".to_string()],
        "runtime facade must preserve context-aware collapsed filtering"
    );

    let manifest = runtime
        .tool_manifest(
            &[
                "Read".to_string(),
                "WebFetch".to_string(),
                "Git".to_string(),
            ],
            &Default::default(),
            &ManifestTestContext { agent: "Standard" },
        )
        .await;
    assert_eq!(
        manifest
            .tool_definitions
            .iter()
            .map(|tool| tool.name.as_str())
            .collect::<Vec<_>>(),
        vec!["Read", GET_TOOL_SPEC_TOOL_NAME],
        "runtime facade must preserve prompt-visible manifest order"
    );

    let readonly_provider = RegistryMarkerSnapshotProvider {
        tools: vec![
            registry_marker_tool_with_access("Read", None, ToolExposure::Direct, true, true),
            registry_marker_tool_with_access("Write", None, ToolExposure::Direct, false, true),
            registry_marker_tool_with_access("Disabled", None, ToolExposure::Direct, true, false),
            registry_marker_tool_with_access("WebFetch", None, ToolExposure::Deferred, true, true),
        ],
    };
    let readonly_runtime = ToolCatalogRuntime::<RegistryMarkerTool, ManifestTestContext, _>::new(
        &readonly_provider,
        GET_TOOL_SPEC_TOOL_NAME,
    );
    let readonly_names = readonly_runtime
        .readonly_enabled_tools()
        .await
        .into_iter()
        .map(|tool| tool.name().to_string())
        .collect::<Vec<_>>();

    assert_eq!(
        readonly_names,
        vec!["Read".to_string(), "WebFetch".to_string()],
        "runtime facade must preserve readonly enabled filtering order"
    );
}

#[tokio::test]
async fn get_tool_spec_detail_resolver_preserves_contextual_detail_contract() {
    let deferred_tools = vec![
        contextual_manifest_tool("WebFetch", ToolExposure::Deferred, None),
        contextual_manifest_tool(GET_TOOL_SPEC_TOOL_NAME, ToolExposure::Deferred, None),
    ];
    let context = ManifestTestContext { agent: "Standard" };

    let summaries = summarize_get_tool_spec_deferred_tools(&deferred_tools);
    assert_eq!(
        summaries,
        vec![
            GetToolSpecDeferredToolSummary {
                name: "WebFetch".to_string(),
                short_description: Some("WebFetch short description".to_string()),
            },
            GetToolSpecDeferredToolSummary {
                name: GET_TOOL_SPEC_TOOL_NAME.to_string(),
                short_description: Some("GetToolSpec short description".to_string()),
            },
        ],
        "catalog summaries must preserve deferred tool order and short descriptions"
    );

    let detail = resolve_get_tool_spec_detail(
        &deferred_tools,
        "WebFetch",
        &context,
        GET_TOOL_SPEC_TOOL_NAME,
    )
    .await
    .expect("collapsed WebFetch detail");

    assert_eq!(detail.tool_name, "WebFetch");
    assert_eq!(detail.description, "WebFetch description for Standard");
    assert_eq!(
        detail.input_schema["properties"]["agent"]["const"],
        "Standard"
    );
    assert_eq!(
        detail.to_value(),
        json!({
            "tool_name": "WebFetch",
            "description": "WebFetch description for Standard",
            "input_schema": {
                "type": "object",
                "properties": {
                    "agent": {
                        "const": "Standard"
                    }
                }
            },
            "catalog_generation": 0
        }),
        "detail JSON shape must stay compatible with GetToolSpec execution output"
    );

    let missing =
        resolve_get_tool_spec_detail(&deferred_tools, "Git", &context, GET_TOOL_SPEC_TOOL_NAME)
            .await
            .expect_err("missing tool should stay a validation-style error");
    assert_eq!(missing, "'Git' is not available in the current context");

    let self_inspection = resolve_get_tool_spec_detail(
        &deferred_tools,
        GET_TOOL_SPEC_TOOL_NAME,
        &context,
        GET_TOOL_SPEC_TOOL_NAME,
    )
    .await
    .expect_err("GetToolSpec should not inspect itself");
    assert_eq!(self_inspection, "Tool 'GetToolSpec' cannot inspect itself");
}

#[tokio::test]
async fn get_tool_spec_catalog_provider_preserves_runtime_catalog_contract() {
    let provider = ContextualManifestSnapshotProvider {
        tools: vec![
            contextual_manifest_tool("WebFetch", ToolExposure::Deferred, None),
            contextual_manifest_tool("Git", ToolExposure::Deferred, Some("other-agent")),
            contextual_manifest_tool("Read", ToolExposure::Direct, None),
        ],
    };
    let context = ManifestTestContext { agent: "Standard" };

    let detail = resolve_get_tool_spec_detail_from_provider(
        &provider,
        "WebFetch",
        &context,
        GET_TOOL_SPEC_TOOL_NAME,
    )
    .await
    .expect("provider-backed detail");
    assert_eq!(detail.tool_name, "WebFetch");
    assert_eq!(detail.description, "WebFetch description for Standard");
}

#[tokio::test]
async fn get_tool_spec_provider_execution_returns_duplicate_result_without_detail_lookup() {
    let context = ManifestTestContext { agent: "Standard" };
    let input = json!({ "tool_name": "WebFetch" });

    let result = resolve_get_tool_spec_execution_result_from_provider(
        &ErroringGetToolSpecProvider,
        &input,
        &[LoadedDeferredToolSpec {
            tool_name: "WebFetch".to_string(),
            catalog_generation: 0,
        }],
        &context,
        GET_TOOL_SPEC_TOOL_NAME,
    )
    .await
    .expect("duplicate load should not call provider detail lookup");

    let ToolResult::Result {
        data,
        result_for_assistant,
        image_attachments,
    } = result
    else {
        panic!("expected normal tool result");
    };

    assert_eq!(data["tool_name"], "WebFetch");
    assert_eq!(data["already_loaded"], true);
    assert!(result_for_assistant
        .as_deref()
        .unwrap_or_default()
        .contains("already loaded in the current context"));
    assert_eq!(image_attachments, None);
}

#[tokio::test]
async fn get_tool_spec_provider_execution_returns_detail_result_from_provider() {
    let provider = ContextualManifestSnapshotProvider {
        tools: vec![contextual_manifest_tool(
            "WebFetch",
            ToolExposure::Deferred,
            None,
        )],
    };
    let context = ManifestTestContext { agent: "Standard" };
    let input = json!({ "tool_name": "WebFetch" });

    let result = resolve_get_tool_spec_execution_result_from_provider(
        &provider,
        &input,
        &[],
        &context,
        GET_TOOL_SPEC_TOOL_NAME,
    )
    .await
    .expect("detail result should come from provider");

    let ToolResult::Result {
        data,
        result_for_assistant,
        image_attachments,
    } = result
    else {
        panic!("expected normal tool result");
    };

    assert_eq!(data["tool_name"], "WebFetch");
    assert_eq!(data["description"], "WebFetch description for Standard");
    assert_eq!(
        data["input_schema"]["properties"]["agent"]["const"],
        "Standard"
    );
    let assistant = result_for_assistant.expect("assistant detail");
    assert!(assistant.contains("<description>\nWebFetch description for Standard"));
    assert!(assistant.contains("\"agent\""));
    assert!(assistant.contains("\"Standard\""));
    assert_eq!(image_attachments, None);
}

#[tokio::test]
async fn get_tool_spec_provider_execution_returns_already_available_result_for_expanded_tool() {
    let provider = ContextualManifestSnapshotProvider {
        tools: vec![
            contextual_manifest_tool("WebFetch", ToolExposure::Deferred, None),
            contextual_manifest_tool("Read", ToolExposure::Direct, None),
        ],
    };
    let context = ManifestTestContext { agent: "Standard" };
    let input = json!({ "tool_name": "Read" });

    let result = resolve_get_tool_spec_execution_result_from_provider(
        &provider,
        &input,
        &[],
        &context,
        GET_TOOL_SPEC_TOOL_NAME,
    )
    .await
    .expect("expanded available tool should return a normal assistant hint");

    let ToolResult::Result {
        data,
        result_for_assistant,
        image_attachments,
    } = result
    else {
        panic!("expected normal tool result");
    };

    assert_eq!(data["tool_name"], "Read");
    assert_eq!(data["already_available"], true);
    assert_eq!(
        result_for_assistant.as_deref(),
        Some(
            "Tool 'Read' is already fully defined in the available tool list. Use 'Read' directly."
        )
    );
    assert_eq!(image_attachments, None);
}

#[tokio::test]
async fn get_tool_spec_runtime_facade_owns_execution_path() {
    let provider = ContextualManifestSnapshotProvider {
        tools: vec![contextual_manifest_tool(
            "WebFetch",
            ToolExposure::Deferred,
            None,
        )],
    };
    let context = ManifestTestContext { agent: "Standard" };
    let input = json!({ "tool_name": "WebFetch" });
    let runtime = GetToolSpecRuntime::<ContextualManifestTool, ManifestTestContext, _>::new(
        &provider,
        GET_TOOL_SPEC_TOOL_NAME,
    );

    let result = runtime
        .execute(&input, &[], &context)
        .await
        .expect("deferred tool detail should resolve through runtime facade");

    let ToolResult::Result { data, .. } = result else {
        panic!("expected normal tool result");
    };
    assert_eq!(data["tool_name"], "WebFetch");
    assert_eq!(data["description"], "WebFetch description for Standard");
    assert_eq!(
        data["input_schema"]["properties"]["agent"]["const"],
        "Standard"
    );
}

#[tokio::test]
async fn get_tool_spec_runtime_facade_owns_tool_result_vector_adapter_shape() {
    let provider = ContextualManifestSnapshotProvider {
        tools: vec![contextual_manifest_tool(
            "WebFetch",
            ToolExposure::Deferred,
            None,
        )],
    };
    let context = ManifestTestContext { agent: "Standard" };
    let runtime = GetToolSpecRuntime::<ContextualManifestTool, ManifestTestContext, _>::new(
        &provider,
        GET_TOOL_SPEC_TOOL_NAME,
    );

    let mut results = runtime
        .call_results(&json!({ "tool_name": "WebFetch" }), &[], &context)
        .await
        .expect("runtime facade should produce the Tool impl result vector shape");

    assert_eq!(results.len(), 1);
    let ToolResult::Result {
        data,
        result_for_assistant,
        image_attachments,
    } = results.remove(0)
    else {
        panic!("expected normal detail result");
    };
    assert_eq!(data["tool_name"], "WebFetch");
    assert!(result_for_assistant
        .expect("assistant detail")
        .contains("<description>\nWebFetch description for Standard"));
    assert_eq!(image_attachments, None);

    let duplicate_runtime =
        GetToolSpecRuntime::<ContextualManifestTool, ManifestTestContext, _>::new(
            &ErroringGetToolSpecProvider,
            GET_TOOL_SPEC_TOOL_NAME,
        );
    let duplicate_results = duplicate_runtime
        .call_results(
            &json!({ "tool_name": "WebFetch" }),
            &[LoadedDeferredToolSpec {
                tool_name: "WebFetch".to_string(),
                catalog_generation: 0,
            }],
            &context,
        )
        .await
        .expect("duplicate-load path should not consult provider detail");

    assert_eq!(duplicate_results.len(), 1);
    let ToolResult::Result {
        data,
        result_for_assistant,
        image_attachments,
    } = &duplicate_results[0]
    else {
        panic!("expected duplicate-load result");
    };
    assert_eq!(data["tool_name"], "WebFetch");
    assert_eq!(
        result_for_assistant.as_deref(),
        Some(
            "Tool 'WebFetch' is already loaded in the current context. Use CallDeferredTool with tool_name 'WebFetch' and put the tool arguments inside args. Reload with GetToolSpec only if its full definition leaves the context or the runtime reports it stale."
        )
    );
    assert!(image_attachments.is_none());
}

#[test]
fn get_tool_spec_runtime_facade_owns_static_tool_surface() {
    let provider = ContextualManifestSnapshotProvider { tools: Vec::new() };
    let runtime = GetToolSpecRuntime::<ContextualManifestTool, ManifestTestContext, _>::new(
        &provider,
        GET_TOOL_SPEC_TOOL_NAME,
    );

    assert_eq!(runtime.name(), GET_TOOL_SPEC_TOOL_NAME);
    assert_eq!(
        runtime.short_description(),
        get_tool_spec_short_description()
    );
    assert_eq!(runtime.input_schema(), get_tool_spec_input_schema());
    assert!(runtime.is_readonly());
    assert!(runtime.is_concurrency_safe(None));
    assert_eq!(
        runtime.render_tool_use_message(&json!({ "tool_name": "WebFetch" })),
        "Reading tool spec for 'WebFetch'."
    );
    assert!(
        runtime
            .validate_input(&json!({ "tool_name": "WebFetch" }))
            .result
    );
    assert!(!runtime.validate_input(&json!({})).result);
}

#[tokio::test]
async fn get_tool_spec_provider_execution_returns_unavailable_result_for_unknown_tool() {
    let provider = ContextualManifestSnapshotProvider {
        tools: vec![contextual_manifest_tool(
            "WebFetch",
            ToolExposure::Deferred,
            None,
        )],
    };
    let context = ManifestTestContext { agent: "Standard" };
    let input = json!({ "tool_name": "Git" });

    let result = resolve_get_tool_spec_execution_result_from_provider(
        &provider,
        &input,
        &[],
        &context,
        GET_TOOL_SPEC_TOOL_NAME,
    )
    .await
    .expect("unknown tool should return a normal assistant hint");

    let ToolResult::Result {
        data,
        result_for_assistant,
        image_attachments,
    } = result
    else {
        panic!("expected normal tool result");
    };

    assert_eq!(data["tool_name"], "Git");
    assert_eq!(data["available_deferred_tool"], false);
    assert_eq!(
        result_for_assistant.as_deref(),
        Some("'Git' is not available in the current context")
    );
    assert_eq!(image_attachments, None);
}

#[tokio::test]
async fn generic_tool_registry_preserves_dynamic_descriptor_contract() {
    let mut registry = ToolRegistry::new();
    registry.register_tool(registry_marker_tool("external_search", Some("provider-a")));
    registry.register_tool(registry_marker_tool("local_docs", Some("provider-b")));
    registry.register_tool(registry_marker_tool("static_tool", None));

    assert_eq!(
        registry.get_tool_names(),
        vec!["external_search", "local_docs", "static_tool"]
    );
    assert_eq!(
        registry
            .get_dynamic_tool_info("external_search")
            .expect("dynamic metadata")
            .provider_id,
        "provider-a"
    );

    let descriptors = registry
        .list_dynamic_tools()
        .await
        .expect("list dynamic tools");
    assert_eq!(
        descriptors
            .iter()
            .map(|descriptor| (descriptor.name.as_str(), descriptor.provider_id.as_deref()))
            .collect::<Vec<_>>(),
        vec![
            ("external_search", Some("provider-a")),
            ("local_docs", Some("provider-b")),
        ]
    );
    assert_eq!(descriptors[0].description, "marker tool");
    assert_eq!(descriptors[0].input_schema, json!({ "type": "object" }));
}

#[tokio::test]
async fn generic_tool_registry_dynamic_listing_does_not_materialize_static_tools() {
    let mut registry: ToolRegistry<dyn ToolRegistryItem> = ToolRegistry::new();
    registry.register_tool(registry_marker_tool("external_search", Some("provider-a")));
    registry.register_tool(Arc::new(StaticToolWithFailingDescription));

    let descriptors = registry
        .list_dynamic_tools()
        .await
        .expect("list dynamic tools");

    assert_eq!(descriptors.len(), 1);
    assert_eq!(descriptors[0].name, "external_search");
}

#[tokio::test]
async fn generic_tool_registry_materializes_provider_effect_and_stale_call_contract() {
    let mut registry = ToolRegistry::new();
    registry.register_tool(registry_marker_tool_with_access(
        "external_search",
        Some("provider-a"),
        ToolExposure::Deferred,
        true,
        true,
    ));
    registry.register_tool(registry_marker_tool_with_access(
        "write_file",
        None,
        ToolExposure::Direct,
        false,
        true,
    ));

    let snapshot = registry
        .materialized_tool_snapshot()
        .await
        .expect("materialize registry snapshot");

    assert_eq!(snapshot.generation, registry.current_snapshot_generation());
    assert_eq!(
        snapshot
            .tool("external_search")
            .expect("external tool")
            .provider
            .provider_id
            .as_deref(),
        Some("provider-a")
    );
    assert_eq!(
        snapshot
            .tool("external_search")
            .expect("external tool")
            .exposure,
        ToolExposure::Deferred
    );
    assert!(
        snapshot
            .tool("external_search")
            .expect("external tool")
            .effects
            .readonly_by_default
    );
    assert!(
        !snapshot
            .tool("write_file")
            .expect("write tool")
            .effects
            .readonly_by_default
    );

    let readonly_names = snapshot
        .filter_tools_by_default_effects(ToolEffectFilter::readonly_only())
        .into_iter()
        .map(|tool| tool.name.as_str())
        .collect::<Vec<_>>();
    assert_eq!(readonly_names, vec!["external_search"]);

    let guard = ToolCallSnapshotGuard::new("external_search", snapshot.generation);
    assert!(snapshot.validate_call(&guard).is_ok());

    registry.unregister_tools_by_prefix("external_");
    let current_snapshot = registry
        .materialized_tool_snapshot()
        .await
        .expect("materialize current snapshot");
    assert_eq!(
        current_snapshot.validate_call(&guard),
        Err(ToolSnapshotCallError::StaleSnapshot {
            tool_name: "external_search".to_string(),
            expected_generation: current_snapshot.generation,
            actual_generation: snapshot.generation,
        })
    );
}

#[tokio::test]
async fn generic_tool_registry_snapshot_preserves_static_provider_identity_after_decoration() {
    let mut registry = ToolRegistry::with_tool_decorator(Arc::new(RegistryMarkerDecorator));
    let provider = RegistryMarkerProvider {
        provider_id: "core.basic",
        tools: vec![registry_marker_tool("Read", None)],
    };

    registry.install_static_provider(&provider);

    let snapshot = registry
        .materialized_tool_snapshot()
        .await
        .expect("materialize registry snapshot");
    let tool = snapshot.tool("decorated_Read").expect("decorated tool");

    assert_eq!(tool.provider.provider_id.as_deref(), Some("core.basic"));
    assert_eq!(tool.provider.provider_kind.as_deref(), Some("static"));
    assert!(tool.provider.is_static());
    assert!(snapshot.dynamic_tools().is_empty());
}

#[tokio::test]
async fn generic_tool_registry_snapshot_labels_execution_effects_as_no_input_defaults() {
    let mut registry: ToolRegistry<dyn ToolRegistryItem> = ToolRegistry::new();
    let tool = Arc::new(InputSensitiveEffectTool);
    assert!(tool.is_concurrency_safe(Some(&json!({ "action": "status" }))));

    registry.register_tool(tool);

    let snapshot = registry
        .materialized_tool_snapshot()
        .await
        .expect("materialize registry snapshot");
    let tool = snapshot
        .tool("input_sensitive")
        .expect("input-sensitive tool");

    assert_eq!(tool.effects.source, ToolEffectFactsSource::NoInputDefault);
    assert!(!tool.effects.readonly_by_default);
    assert!(!tool.effects.concurrency_safe_by_default);
}

#[tokio::test]
async fn generic_tool_registry_snapshot_treats_blank_provider_id_as_builtin() {
    let mut registry = ToolRegistry::new();
    registry.register_tool(registry_marker_tool("blank_provider", Some(" ")));

    let snapshot = registry
        .materialized_tool_snapshot()
        .await
        .expect("materialize registry snapshot");
    let tool = snapshot
        .tool("blank_provider")
        .expect("blank provider tool");

    assert_eq!(tool.provider.provider_id, None);
    assert_eq!(tool.provider.provider_kind.as_deref(), Some("builtin"));
    assert_eq!(tool.dynamic_info, None);
    assert!(snapshot.dynamic_tools().is_empty());
    assert!(registry
        .list_dynamic_tools()
        .await
        .expect("list dynamic tools")
        .is_empty());
}

#[tokio::test]
async fn generic_tool_registry_clears_stale_dynamic_metadata_on_overwrite() {
    let mut registry = ToolRegistry::new();
    registry.register_tool(registry_marker_tool("external_search", Some("provider-a")));

    registry.register_tool(registry_marker_tool("external_search", None));

    assert!(registry.get_dynamic_tool_info("external_search").is_none());
    let descriptors = registry
        .list_dynamic_tools()
        .await
        .expect("list dynamic tools");
    assert!(descriptors.is_empty());
}
