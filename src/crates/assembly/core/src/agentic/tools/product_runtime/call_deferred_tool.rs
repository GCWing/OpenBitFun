//! Product Tool Runtime owned CallDeferredTool gateway definition.

use crate::agentic::tools::framework::{Tool, ToolRenderOptions, ToolResult, ValidationResult};
use crate::agentic::tools::tool_context_runtime::ToolUseContext;
use crate::util::errors::{OpenBitFunError, OpenBitFunResult};
use async_trait::async_trait;
use openbitfun_agent_tools::{
    call_deferred_tool_description, call_deferred_tool_input_schema,
    call_deferred_tool_short_description, parse_call_deferred_tool_input, CALL_DEFERRED_TOOL_NAME,
};
use serde_json::Value;

pub struct CallDeferredTool;

impl CallDeferredTool {
    pub fn new() -> Self {
        Self
    }
}

impl Default for CallDeferredTool {
    fn default() -> Self {
        Self::new()
    }
}

#[async_trait]
impl Tool for CallDeferredTool {
    fn name(&self) -> &str {
        CALL_DEFERRED_TOOL_NAME
    }

    async fn description(&self) -> OpenBitFunResult<String> {
        Ok(call_deferred_tool_description())
    }

    fn short_description(&self) -> String {
        call_deferred_tool_short_description()
    }

    fn input_schema(&self) -> Value {
        call_deferred_tool_input_schema()
    }

    fn output_schema(&self) -> Value {
        serde_json::json!({
            "anyOf": [
                {"type": "null"},
                {"type": "boolean"},
                {"type": "number"},
                {"type": "string"},
                {"type": "array", "items": {}},
                {"type": "object", "additionalProperties": true}
            ]
        })
    }

    fn is_readonly(&self) -> bool {
        false
    }

    fn render_tool_use_message(&self, input: &Value, _options: &ToolRenderOptions) -> String {
        let target = input
            .get("tool_name")
            .and_then(Value::as_str)
            .unwrap_or("?");
        format!("Calling deferred tool '{}'.", target)
    }

    async fn validate_input(
        &self,
        input: &Value,
        _context: Option<&ToolUseContext>,
    ) -> ValidationResult {
        match parse_call_deferred_tool_input(input) {
            Ok(_) => ValidationResult::default(),
            Err(error) => ValidationResult {
                result: false,
                message: Some(error.to_string()),
                error_code: Some(400),
                meta: None,
            },
        }
    }

    async fn call_impl(
        &self,
        _input: &Value,
        _context: &ToolUseContext,
    ) -> OpenBitFunResult<Vec<ToolResult>> {
        Err(OpenBitFunError::Validation(
            "CallDeferredTool must be resolved by the tool pipeline".to_string(),
        ))
    }
}
