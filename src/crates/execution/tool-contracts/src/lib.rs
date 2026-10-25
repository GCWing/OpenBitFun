//! Agent tool contracts.
//!
//! Pure tool DTOs and helpers live here before the concrete tool framework and
//! tool packs are moved out of the core facade.

#[cfg(feature = "acp-bridge")]
pub mod acp_tool_bridge;
#[cfg(feature = "computer-use-contract")]
pub mod computer_use;
#[cfg(feature = "computer-use-contract")]
pub mod computer_use_control;
#[cfg(feature = "computer-use-contract")]
pub mod computer_use_geometry;
#[cfg(feature = "computer-use-contract")]
pub mod computer_use_permissions;
pub mod deferred_tool;
#[cfg(feature = "element-token")]
pub mod element_token;
pub mod execution_gate;
pub mod file_guidance;
pub mod framework;
pub mod input_validator;
#[cfg(feature = "mcp-bridge")]
pub mod mcp_tool_bridge;
pub mod permission_intent;
pub mod ptc;
pub mod tool_execution_presentation;
pub mod tool_result_storage;
pub mod tool_snapshot;

#[cfg(feature = "acp-bridge")]
pub use acp_tool_bridge::{
    acp_external_agent_tool_input_schema, build_acp_external_agent_tool_definition,
    build_acp_external_agent_tool_name, build_acp_external_agent_tool_result,
    normalize_name_for_acp_tool_part, render_acp_external_agent_rejected_message,
    render_acp_external_agent_result_for_assistant, render_acp_external_agent_result_message,
    render_acp_external_agent_use_message, validate_acp_external_agent_tool_input,
    AcpExternalAgentToolDefinition, AcpExternalAgentToolDefinitionInput, ACP_TOOL_PREFIX,
    ACP_TOOL_SUFFIX,
};
pub use deferred_tool::{
    call_deferred_tool_description, call_deferred_tool_input_schema,
    call_deferred_tool_short_description, effective_tool_invocation,
    parse_call_deferred_tool_input, CallDeferredToolInput, CallDeferredToolInputError,
    ResolvedToolInvocation, ToolInvocationKind, CALL_DEFERRED_TOOL_NAME,
};
pub use execution_gate::{
    validate_tool_execution_admission, ToolExecutionAdmissionRejection,
    ToolExecutionAdmissionRequest,
};
pub use file_guidance::{
    file_tool_guidance_message, is_file_tool_guidance_message, FILE_TOOL_GUIDANCE_PREFIX,
};
pub use framework::{
    build_get_tool_spec_assistant_detail, build_get_tool_spec_catalog_description,
    build_get_tool_spec_catalog_description_from_provider, build_get_tool_spec_description,
    build_get_tool_spec_detail_result, build_get_tool_spec_duplicate_load_hint,
    build_get_tool_spec_duplicate_load_result, build_openbitfun_current_session_uri,
    build_openbitfun_runtime_uri, build_prompt_visible_tool_manifest_definitions,
    build_tool_manifest_policy_tools, build_tool_path_policy_denial_message,
    build_tool_runtime_artifact_reference, build_tool_session_runtime_artifact_reference,
    collect_loaded_deferred_tool_specs, get_tool_spec_input_schema,
    get_tool_spec_is_concurrency_safe, get_tool_spec_is_readonly, get_tool_spec_short_description,
    is_miniapp_headless_agent_run, is_miniapp_market_strict_agent_run,
    is_openbitfun_current_session_uri, is_openbitfun_runtime_uri, is_openbitfun_tool_uri,
    is_remote_posix_path_within_root, is_tool_path_allowed_by_resolved_roots,
    materialize_static_tool_provider_groups, miniapp_agent_run_tool_restrictions,
    miniapp_headless_agent_tool_restrictions, miniapp_market_strict_agent_tool_restrictions,
    normalize_absolute_posix_path, normalize_host_path, normalize_runtime_relative_path,
    parse_openbitfun_current_session_uri, parse_openbitfun_runtime_uri,
    posix_resolve_path_with_workspace, posix_style_path_is_absolute,
    render_get_tool_spec_deferred_tool_entry, render_get_tool_spec_tool_use_message,
    resolve_contextual_tool_manifest, resolve_contextual_tool_manifest_from_provider,
    resolve_contextual_visible_tools, resolve_contextual_visible_tools_from_provider,
    resolve_get_tool_spec_detail, resolve_get_tool_spec_detail_from_provider,
    resolve_get_tool_spec_execution_plan, resolve_get_tool_spec_execution_result_from_provider,
    resolve_host_path, resolve_host_path_with_workspace, resolve_readonly_enabled_tools,
    resolve_tool_manifest_policy, resolve_tool_path_with_context,
    resolve_tool_path_with_context_roots, resolve_workspace_tool_path,
    sort_tool_manifest_definitions, strip_invalid_windows_drive_path_prefix,
    summarize_get_tool_spec_deferred_tools, tool_manifest_sort_rank,
    tool_path_is_effectively_absolute, tool_restrictions_for_delegation_policy,
    validate_deferred_tool_usage, validate_get_tool_spec_input, validate_tool_allowed_by_list,
    ContextualToolManifest, ContextualToolManifestItem, ContextualVisibleTools,
    DeferredToolUsageError, DynamicMcpToolInfo, DynamicToolInfo, GetToolSpecCatalogProvider,
    GetToolSpecDeferredToolSummary, GetToolSpecDetail, GetToolSpecExecutionError,
    GetToolSpecExecutionPlan, GetToolSpecLoadObservation, GetToolSpecRuntime,
    LoadedDeferredToolSpec, ParsedOpenBitFunCurrentSessionUri, ParsedOpenBitFunRuntimeUri,
    PortableToolContextProvider, PromptVisibleToolManifestItem, SnapshotToolDecorator,
    SnapshotToolWrapper, SnapshotToolWrapperRef, StaticToolMaterializationError,
    StaticToolProvider, StaticToolProviderFactory, StaticToolProviderGroup, StaticToolProviderPlan,
    ToolCatalogRuntime, ToolCatalogSnapshotProvider, ToolContextFacts, ToolDecoratorRef,
    ToolExecutionAccessError, ToolExposure, ToolManifestDefinition, ToolManifestPolicyResolution,
    ToolManifestPolicyTool, ToolPathBackend, ToolPathContractError, ToolPathOperation,
    ToolPathPolicy, ToolPathResolution, ToolRef, ToolRegistry, ToolRegistryItem, ToolRenderOptions,
    ToolRestrictionError, ToolResult, ToolRuntimeAssembly, ToolRuntimeRestrictions,
    ToolWorkspaceKind, ValidationResult, GET_TOOL_SPEC_TOOL_NAME,
    OPENBITFUN_CURRENT_SESSION_URI_PREFIX, OPENBITFUN_RUNTIME_URI_PREFIX,
};
pub use input_validator::InputValidator;
#[cfg(feature = "mcp-bridge")]
pub use mcp_tool_bridge::{
    build_mcp_tool_bridge_definition, build_mcp_tool_bridge_name, build_mcp_tool_bridge_result,
    mcp_tool_bridge_dynamic_tool_info, mcp_tool_bridge_short_description, normalize_name_for_mcp,
    render_mcp_tool_bridge_rejected_message, render_mcp_tool_bridge_result_message,
    render_mcp_tool_bridge_use_message, validate_mcp_tool_bridge_input, McpToolBridgeBehaviorHints,
    McpToolBridgeDefinition, McpToolBridgeDefinitionInput, McpToolBridgeToolInfo,
    MCP_TOOL_DELIMITER, MCP_TOOL_PREFIX,
};
pub use openbitfun_core_types::ToolImageAttachment;
pub use openbitfun_runtime_ports::{
    DynamicToolDescriptor, DynamicToolProvider, PortError, PortErrorKind, PortResult, ToolDecorator,
};
pub use permission_intent::PermissionIntent;
pub use ptc::{
    json_schema_to_typescript, ptc_run_code_description, ptc_run_code_input_schema,
    render_ptc_loaded_tool_typescript_sdk, render_ptc_tool_calling_guide,
    render_ptc_tool_calling_guide_with_options, render_ptc_typescript_sdk,
    render_ptc_typescript_sdk_with_options, PtcToolCallError, PtcToolContract,
    PTC_NESTED_ALLOWED_TOOLS_CONTEXT_KEY, PTC_RUN_CODE_TOOL_NAME,
    PTC_TOOL_PRESENTATION_CONTEXT_KEY, PTC_TOOL_PRESENTATION_MODE,
};
pub use tool_execution_presentation::{
    build_invalid_tool_call_error_message, build_normal_tool_json_repair_notice,
    build_permission_denied_tool_presentation, build_tool_call_truncation_recovery_notice,
    build_tool_execution_error_presentation, build_tool_execution_timeout_presentation,
    build_user_rejected_tool_presentation, build_user_rejected_tool_presentation_with_instruction,
    build_user_steering_interrupted_presentation, build_write_tail_closure_notice,
    is_write_like_tool_name, render_tool_result_for_assistant, truncate_raw_tool_arguments_preview,
    truncate_raw_tool_arguments_preview_to, truncate_tool_arguments_preview,
    ToolExecutionErrorPresentation, TOOL_ERROR_ARGUMENTS_PREVIEW_BYTES, USER_REJECTED_TOOL_MESSAGE,
    USER_STEERING_INTERRUPTED_MESSAGE,
};
pub use tool_result_storage::{
    build_persisted_tool_output_message, count_tool_result_lines, generate_tool_result_preview,
    sanitize_tool_result_file_component, select_tool_result_indices_for_persistence,
    tool_result_is_persisted_output, PersistedToolOutput, ToolResultPersistenceCandidate,
    ToolResultStoragePolicy, DEFAULT_MAX_TOOL_RESULT_CHARS, MAX_TOOL_RESULTS_PER_ROUND_CHARS,
    PERSISTED_OUTPUT_CLOSING_TAG, PERSISTED_OUTPUT_TAG, TOOL_RESULT_PREVIEW_CHARS,
};
pub use tool_snapshot::{
    materialize_tool_snapshot, MaterializedToolSnapshot, ToolCallSnapshotGuard,
    ToolCancellationContract, ToolEffectFacts, ToolEffectFactsSource, ToolEffectFilter,
    ToolProviderIdentity, ToolSnapshotCallError, ToolSnapshotItem,
};
