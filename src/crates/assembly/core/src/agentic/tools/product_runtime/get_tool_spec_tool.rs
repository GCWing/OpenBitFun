//! Product Tool Runtime owned GetToolSpec concrete adapter.

use super::{
    product_get_tool_spec_runtime, resolve_product_get_tool_spec_results,
    ProductGetToolSpecRuntime, ProductToolCatalogProvider,
};
use crate::agentic::tools::framework::{Tool, ToolRenderOptions, ToolResult, ValidationResult};
use crate::agentic::tools::tool_context_runtime::ToolUseContext;
use crate::util::errors::{OpenBitFunError, OpenBitFunResult};
use async_trait::async_trait;
use openbitfun_agent_tools::{
    build_get_tool_spec_catalog_description, build_get_tool_spec_description,
    GetToolSpecDeferredToolSummary, GetToolSpecExecutionError, GET_TOOL_SPEC_TOOL_NAME,
};
use serde_json::Value;

pub struct GetToolSpecTool;

impl GetToolSpecTool {
    pub fn new() -> Self {
        Self
    }

    pub(crate) fn build_deferred_tools_context_section(
        deferred_tools: &[GetToolSpecDeferredToolSummary],
    ) -> Option<String> {
        build_get_tool_spec_catalog_description(deferred_tools)
    }
}

impl Default for GetToolSpecTool {
    fn default() -> Self {
        Self::new()
    }
}

fn with_runtime<Result>(operation: impl FnOnce(ProductGetToolSpecRuntime<'_>) -> Result) -> Result {
    let provider = ProductToolCatalogProvider;
    operation(product_get_tool_spec_runtime(&provider))
}

#[async_trait]
impl Tool for GetToolSpecTool {
    fn name(&self) -> &str {
        GET_TOOL_SPEC_TOOL_NAME
    }

    async fn description(&self) -> OpenBitFunResult<String> {
        Ok(build_get_tool_spec_description())
    }

    fn short_description(&self) -> String {
        with_runtime(|runtime| runtime.short_description())
    }

    async fn description_with_context(
        &self,
        _context: Option<&ToolUseContext>,
    ) -> OpenBitFunResult<String> {
        Ok(build_get_tool_spec_description())
    }

    fn input_schema(&self) -> Value {
        with_runtime(|runtime| runtime.input_schema())
    }

    fn is_readonly(&self) -> bool {
        with_runtime(|runtime| runtime.is_readonly())
    }

    fn is_concurrency_safe(&self, input: Option<&Value>) -> bool {
        with_runtime(|runtime| runtime.is_concurrency_safe(input))
    }

    fn render_tool_use_message(&self, input: &Value, _options: &ToolRenderOptions) -> String {
        with_runtime(|runtime| runtime.render_tool_use_message(input))
    }

    async fn validate_input(
        &self,
        input: &Value,
        _context: Option<&ToolUseContext>,
    ) -> ValidationResult {
        with_runtime(|runtime| runtime.validate_input(input))
    }

    async fn call_impl(
        &self,
        input: &Value,
        context: &ToolUseContext,
    ) -> OpenBitFunResult<Vec<ToolResult>> {
        resolve_product_get_tool_spec_results(input, context, self.name())
            .await
            .map_err(map_get_tool_spec_execution_error)
    }
}

fn map_get_tool_spec_execution_error(error: GetToolSpecExecutionError) -> OpenBitFunError {
    match error {
        GetToolSpecExecutionError::MissingToolName => OpenBitFunError::tool(error.to_string()),
        GetToolSpecExecutionError::Detail(message) => OpenBitFunError::Validation(message),
    }
}

#[cfg(test)]
mod tests {
    use super::GetToolSpecTool;
    use crate::agentic::tools::framework::{Tool, ToolResult};
    use crate::agentic::tools::tool_context_runtime::ToolUseContext;
    use crate::agentic::tools::ToolRuntimeRestrictions;
    use serde_json::json;
    use std::collections::HashMap;

    #[test]
    fn deferred_tools_context_lists_names_without_short_descriptions() {
        let tool_name = format!("CatalogDescriptionTestTool_{}", uuid::Uuid::new_v4());
        let description = GetToolSpecTool::build_deferred_tools_context_section(&[
            openbitfun_agent_tools::GetToolSpecDeferredToolSummary {
                name: tool_name.clone(),
                short_description: None,
            },
        ])
        .expect("deferred tools section");

        assert!(description.contains(&format!("- {}", tool_name)));
        assert!(!description.contains("Concise catalog entry."));
    }

    #[tokio::test]
    async fn reloading_already_loaded_tool_returns_assistant_hint() {
        let tool = GetToolSpecTool::new();
        let registry = crate::agentic::tools::registry::get_global_tool_registry();
        let catalog_generation = registry.read().await.current_snapshot_generation();
        let context = ToolUseContext {
            tool_call_id: None,
            agent_type: None,
            session_id: None,
            dialog_turn_id: None,
            workspace: None,
            loaded_deferred_tool_specs: vec![openbitfun_agent_tools::LoadedDeferredToolSpec {
                tool_name: "WebFetch".to_string(),
                catalog_generation,
            }],
            primary_model_facts: tool_runtime::context::PrimaryModelFacts::default(),
            custom_data: HashMap::new(),
            computer_use_host: None,
            runtime_tool_restrictions: ToolRuntimeRestrictions::default(),
            runtime_handles: openbitfun_runtime_ports::ToolRuntimeHandles::default(),
        };

        let results = tool
            .call_impl(&json!({ "tool_name": "WebFetch" }), &context)
            .await;

        let results = results.expect("duplicate load should return a normal result");
        let ToolResult::Result {
            data,
            result_for_assistant,
            ..
        } = &results[0]
        else {
            panic!("expected regular tool result");
        };

        assert_eq!(data["tool_name"], "WebFetch");
        assert_eq!(data["already_loaded"], true);
        assert!(result_for_assistant
            .as_deref()
            .unwrap_or_default()
            .contains("already loaded in the current context"));
    }
}
