//! Tool framework - Tool interface definition and execution context
pub use crate::agentic::tools::tool_context_runtime::ToolUseContext;
use crate::util::errors::OpenBitFunResult;
use async_trait::async_trait;
pub use openbitfun_agent_tools::{
    build_tool_path_policy_denial_message, build_tool_runtime_artifact_reference,
    build_tool_session_runtime_artifact_reference, is_tool_path_allowed_by_resolved_roots,
    resolve_tool_path_with_context, resolve_tool_path_with_context_roots,
    tool_path_is_effectively_absolute, DynamicMcpToolInfo, DynamicToolInfo, PermissionIntent,
    PortableToolContextProvider, ToolContextFacts, ToolExposure, ToolPathBackend,
    ToolPathResolution, ToolRenderOptions, ToolResult, ToolWorkspaceKind, ValidationResult,
};
use serde_json::Value;

/// Tool trait
#[async_trait]
pub trait Tool: Send + Sync {
    /// Tool name
    fn name(&self) -> &str;

    /// Tool description
    async fn description(&self) -> OpenBitFunResult<String>;

    /// Tool description with execution context.
    async fn description_with_context(
        &self,
        _context: Option<&ToolUseContext>,
    ) -> OpenBitFunResult<String> {
        self.description().await
    }

    /// Short description used in condensed tool listings such as GetToolSpec.
    fn short_description(&self) -> String;

    /// Default exposure level when building the model tool manifest.
    ///
    /// This is tool-owned metadata: registries and agent manifests may use it
    /// as the baseline before applying any higher-level overrides.
    fn default_exposure(&self) -> ToolExposure {
        ToolExposure::Direct
    }

    /// Input mode definition - using JSON Schema
    fn input_schema(&self) -> Value;

    /// JSON Schema sent to the model (may depend on app language or other runtime config).
    /// Default: same as [`input_schema`].
    async fn input_schema_for_model(&self) -> Value {
        self.input_schema()
    }

    /// JSON Schema for the model when tool listing has a [`ToolUseContext`] (e.g. primary model vision capability).
    /// Default: ignores context and delegates to [`input_schema_for_model`].
    async fn input_schema_for_model_with_context(&self, context: Option<&ToolUseContext>) -> Value {
        let _ = context;
        self.input_schema_for_model().await
    }

    /// Input JSON Schema - optional extra schema
    fn input_json_schema(&self) -> Option<Value> {
        None
    }

    /// MCP Apps: URI of UI resource (ui://) declared in tool metadata. Used when tool result
    /// does not contain a resource - the host fetches from this pre-declared URI.
    fn ui_resource_uri(&self) -> Option<String> {
        None
    }

    /// Dynamic tool provider identity used by boundary adapters.
    ///
    /// Keep this as explicit metadata instead of deriving ownership from tool
    /// names so future tool registries can change naming without breaking
    /// provider routing.
    fn dynamic_provider_id(&self) -> Option<&str> {
        None
    }

    /// Rich metadata for dynamic tools. Prefer this over encoding dynamic ownership in tool names.
    fn dynamic_tool_info(&self) -> Option<DynamicToolInfo> {
        self.dynamic_provider_id()
            .map(|provider_id| DynamicToolInfo {
                provider_id: provider_id.to_string(),
                provider_kind: None,
                mcp: None,
            })
    }

    /// User friendly name
    fn user_facing_name(&self) -> String {
        self.name().to_string()
    }

    /// Whether to enable
    async fn is_enabled(&self) -> bool {
        true
    }

    /// Whether this tool is available for a specific execution context.
    async fn is_available_in_context(&self, _context: Option<&ToolUseContext>) -> bool {
        self.is_enabled().await
    }

    /// Whether to be readonly
    fn is_readonly(&self) -> bool {
        false
    }

    /// Whether to be concurrency safe
    fn is_concurrency_safe(&self, _input: Option<&Value>) -> bool {
        self.is_readonly()
    }

    /// Subsequent calls must be preflighted after this tool finishes because
    /// it can change session execution policy (for example, activate hooks).
    fn invalidates_tool_preflight(&self) -> bool {
        false
    }

    /// Describe permission actions and resources without performing side effects.
    fn permission_intents(
        &self,
        _input: &Value,
        _context: &ToolUseContext,
    ) -> OpenBitFunResult<Vec<PermissionIntent>> {
        if self.is_readonly() {
            Ok(Vec::new())
        } else {
            Ok(vec![PermissionIntent::new(
                "custom_tool",
                vec![self.name().to_string()],
            )])
        }
    }

    /// Whether this tool manages its own execution timeout (for example via the
    /// subagent timeout handle) and should not be wrapped by the global tool
    /// pipeline timeout.
    fn manages_own_execution_timeout(&self) -> bool {
        false
    }

    /// Whether a pending round injection may end this tool normally so the
    /// current turn can advance without cancelling the underlying work.
    fn round_injection_yieldable(&self) -> bool {
        false
    }

    /// Whether to support streaming output
    fn supports_streaming(&self) -> bool {
        false
    }

    /// Validate input
    async fn validate_input(
        &self,
        _input: &Value,
        _context: Option<&ToolUseContext>,
    ) -> ValidationResult {
        ValidationResult {
            result: true,
            message: None,
            error_code: None,
            meta: None,
        }
    }

    /// Validate invariants on the original input that a Hook rewrite must not
    /// relax. The default preserves existing tool behavior while discarding
    /// ordinary repairable validation failures.
    ///
    /// Tools whose full [`validate_input`] can return a repairable error before
    /// reaching an invariant must override this method and inspect every
    /// independently recognizable protected field in the partial input.
    async fn validate_input_rewrite_invariants(
        &self,
        input: &Value,
        context: Option<&ToolUseContext>,
    ) -> ValidationResult {
        let validation = self.validate_input(input, context).await;
        if validation.blocks_input_rewrite() {
            validation
        } else {
            ValidationResult::default()
        }
    }

    /// Render result for assistant
    fn render_result_for_assistant(&self, _output: &Value) -> String {
        "Tool result".to_string()
    }

    /// Render tool use message
    fn render_tool_use_message(&self, input: &Value, _options: &ToolRenderOptions) -> String {
        format!("Using {}: {}", self.name(), input)
    }

    /// Render tool use rejected message
    fn render_tool_use_rejected_message(&self) -> String {
        format!("{} tool use was rejected", self.name())
    }

    /// Render tool result message
    fn render_tool_result_message(&self, _output: &Value) -> String {
        format!("{} completed", self.name())
    }

    /// Execute the tool's concrete business logic.
    /// Implementors should put the actual tool behavior here and assume
    /// [`call`] will wrap it with cross-cutting concerns such as cancellation.
    async fn call_impl(
        &self,
        input: &Value,
        context: &ToolUseContext,
    ) -> OpenBitFunResult<Vec<ToolResult>>;

    /// Unified tool entry point.
    /// This method owns shared framework behavior and delegates the actual
    /// execution to [`call_impl`], so most tools should override `call_impl`
    /// instead of overriding this method directly.
    async fn call(
        &self,
        input: &Value,
        context: &ToolUseContext,
    ) -> OpenBitFunResult<Vec<ToolResult>> {
        crate::agentic::tools::tool_context_runtime::call_tool_with_runtime_hooks(
            self, input, context,
        )
        .await
    }
}
