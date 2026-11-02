//! Virtual RunCode entrypoint for PTC tool presentation.
//!
//! The pipeline owns the actual execution because nested calls must re-enter
//! the complete permission and tool execution path.  This Tool implementation
//! supplies the manifest schema and a fail-closed fallback for callers that
//! invoke it outside that pipeline.

use crate::agentic::tools::framework::{Tool, ToolResult, ToolUseContext, ValidationResult};
use crate::util::errors::{OpenBitFunError, OpenBitFunResult};
use async_trait::async_trait;
use openbitfun_agent_tools::{
    ptc_run_code_description, ptc_run_code_input_schema, PTC_RUN_CODE_TOOL_NAME,
};
use serde_json::Value;

pub struct PtcRunCodeTool;

impl PtcRunCodeTool {
    pub fn new() -> Self {
        Self
    }
}

impl Default for PtcRunCodeTool {
    fn default() -> Self {
        Self::new()
    }
}

#[async_trait]
impl Tool for PtcRunCodeTool {
    fn name(&self) -> &str {
        PTC_RUN_CODE_TOOL_NAME
    }

    async fn description(&self) -> OpenBitFunResult<String> {
        Ok(ptc_run_code_description())
    }

    fn short_description(&self) -> String {
        "Execute a TypeScript program with available tools".to_string()
    }

    fn input_schema(&self) -> Value {
        ptc_run_code_input_schema()
    }

    fn output_schema(&self) -> Value {
        serde_json::json!({
            "anyOf": [
                {"type": "null"},
                {"type": "boolean"},
                {"type": "number"},
                {"type": "string"},
                {"type": "array", "items": {}},
                {"type": "object", "additionalProperties": true},
                {
                    "type": "object",
                    "properties": {
                        "value": {},
                        "logs": {"type": "array", "items": {"type": "string"}}
                    },
                    "required": ["value", "logs"],
                    "additionalProperties": false
                }
            ]
        })
    }

    fn is_concurrency_safe(&self, _input: Option<&Value>) -> bool {
        false
    }

    fn permission_intents(
        &self,
        _input: &Value,
        _context: &ToolUseContext,
    ) -> OpenBitFunResult<Vec<crate::agentic::tools::framework::PermissionIntent>> {
        // The outer program has no independent resource target. Every nested
        // tool call re-enters the normal permission pipeline and prompts for
        // its own concrete resources.
        Ok(Vec::new())
    }

    async fn validate_input(
        &self,
        input: &Value,
        _context: Option<&ToolUseContext>,
    ) -> ValidationResult {
        if input
            .get("code")
            .and_then(Value::as_str)
            .is_some_and(|code| !code.trim().is_empty())
        {
            return ValidationResult::default();
        }
        ValidationResult {
            result: false,
            message: Some("RunCode requires a non-empty code string".to_string()),
            error_code: Some(400),
            meta: None,
        }
    }

    async fn call_impl(
        &self,
        _input: &Value,
        _context: &ToolUseContext,
    ) -> OpenBitFunResult<Vec<ToolResult>> {
        Err(OpenBitFunError::NotImplemented(
            "RunCode must be executed by the PTC tool pipeline".to_string(),
        ))
    }
}
