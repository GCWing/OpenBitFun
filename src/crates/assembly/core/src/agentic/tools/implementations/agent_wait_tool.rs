use crate::agentic::coordination::{
    get_global_coordinator, BackgroundSubagentOutcome, BackgroundSubagentWaitMode,
    BackgroundSubagentWaitResult, BackgroundSubagentWaitStatus,
};
use crate::agentic::tools::framework::{
    PermissionIntent, Tool, ToolRenderOptions, ToolResult, ToolUseContext, ValidationResult,
};
use crate::util::errors::{OpenBitFunError, OpenBitFunResult};
use async_trait::async_trait;
use serde_json::{json, Value};
use std::collections::HashSet;
use tokio::time::Duration;

const MIN_TIMEOUT_SECONDS: u64 = 30 * 60;
const DEFAULT_TIMEOUT_SECONDS: u64 = MIN_TIMEOUT_SECONDS;
const MAX_TIMEOUT_SECONDS: u64 = 60 * 60;

pub struct AgentWaitTool;

#[derive(Debug, PartialEq, Eq)]
struct AgentWaitRequest {
    bg_task_ids: Vec<String>,
    invalid_bg_task_inputs: Vec<Value>,
    select_all: bool,
    timeout_seconds: u64,
}

impl Default for AgentWaitTool {
    fn default() -> Self {
        Self::new()
    }
}

impl AgentWaitTool {
    pub fn new() -> Self {
        Self
    }

    fn parse_request(input: &Value) -> OpenBitFunResult<AgentWaitRequest> {
        let object = input.as_object().ok_or_else(|| {
            OpenBitFunError::tool("AgentWait input must be an object".to_string())
        })?;

        let task_ids = object
            .get("bg_task_ids")
            .or_else(|| object.get("background_task_ids"));
        let (values, select_all) = match task_ids {
            None => (Vec::new(), true),
            Some(value @ Value::String(_)) => (vec![value], false),
            Some(Value::Array(values)) if values.is_empty() => (Vec::new(), true),
            Some(Value::Array(values)) => (values.iter().collect::<Vec<_>>(), false),
            Some(value) => (vec![value], false),
        };

        let mut seen = HashSet::new();
        let mut bg_task_ids = Vec::new();
        let mut invalid_bg_task_inputs = Vec::new();
        for value in values {
            let Some(task_id) = value.as_str().map(str::trim) else {
                invalid_bg_task_inputs.push(value.clone());
                continue;
            };
            if task_id.is_empty() {
                invalid_bg_task_inputs.push(value.clone());
            } else if seen.insert(task_id.to_string()) {
                bg_task_ids.push(task_id.to_string());
            }
        }

        Ok(AgentWaitRequest {
            bg_task_ids,
            invalid_bg_task_inputs,
            select_all,
            timeout_seconds: Self::parse_timeout_seconds(object.get("timeout_seconds")),
        })
    }

    fn parse_timeout_seconds(timeout_seconds: Option<&Value>) -> u64 {
        timeout_seconds
            .and_then(Value::as_u64)
            .unwrap_or(DEFAULT_TIMEOUT_SECONDS)
            .clamp(MIN_TIMEOUT_SECONDS, MAX_TIMEOUT_SECONDS)
    }

    fn outcome_json(outcome: &BackgroundSubagentOutcome) -> Value {
        json!({
            "bg_task_id": outcome.model_bg_task_id(),
            "agent_id": outcome.model_agent_id(),
            "outcome": outcome.status.as_str(),
            "content": outcome.content,
            "error": outcome.error,
        })
    }

    fn assistant_result(
        result: &BackgroundSubagentWaitResult,
        invalid_bg_task_inputs: &[Value],
    ) -> String {
        let finished = if result.status == BackgroundSubagentWaitStatus::Steered {
            "AgentWait ended early because user steering arrived. Background agents continue running."
                .to_string()
        } else {
            format!("AgentWait finished with status {}.", result.status.as_str())
        };
        let mut message = finished;
        for outcome in &result.outcomes {
            message.push_str(&format!(
                "\n<result bg_task_id=\"{}\" agent_id=\"{}\" status=\"{}\">",
                outcome.model_bg_task_id(),
                outcome.model_agent_id(),
                outcome.status.as_str(),
            ));
            if let Some(content) = &outcome.content {
                message.push_str(content);
            }
            if let Some(error) = &outcome.error {
                message.push_str("\nError: ");
                message.push_str(error);
            }
            message.push_str("</result>");
        }
        if !result.pending_bg_task_ids.is_empty() {
            message.push_str(&format!(
                "\nPending background task IDs: {}.",
                result.pending_bg_task_ids.join(", ")
            ));
        }
        if !result.already_delivered_bg_task_ids.is_empty() {
            message.push_str(&format!(
                "\nAlready delivered background task IDs: {}.",
                result.already_delivered_bg_task_ids.join(", ")
            ));
        }
        if !result.missing_bg_task_ids.is_empty() {
            message.push_str(&format!(
                "\nBackground task IDs not found: {}.",
                result.missing_bg_task_ids.join(", ")
            ));
        }
        if !invalid_bg_task_inputs.is_empty() {
            let inputs = invalid_bg_task_inputs
                .iter()
                .map(Value::to_string)
                .collect::<Vec<_>>()
                .join(", ");
            message.push_str(&format!("\nIgnored invalid bg_task_ids inputs: {inputs}."));
        }
        message
    }
}

#[async_trait]
impl Tool for AgentWaitTool {
    fn name(&self) -> &str {
        "AgentWait"
    }

    fn manages_own_execution_timeout(&self) -> bool {
        true
    }

    fn round_injection_yieldable(&self) -> bool {
        true
    }

    async fn description(&self) -> OpenBitFunResult<String> {
        Ok("Wait for selected background agent results. The tool also returns when `timeout_seconds` has elapsed.".to_string())
    }

    fn short_description(&self) -> String {
        "Wait for selected background agent results.".to_string()
    }

    fn input_schema(&self) -> Value {
        json!({
            "type": "object",
            "properties": {
                "bg_task_ids": {
                    "type": "array",
                    "items": { "type": "string" },
                    "description": "Background task IDs whose results should be collected."
                },
                "timeout_seconds": {
                    "type": "integer",
                    "description": "Maximum time to wait in seconds, with a minimum of 30 minutes (default) and a maximum of 1 hour."
                }
            },
            "additionalProperties": false
        })
    }

    fn output_schema(&self) -> Value {
        json!({
            "type": "object",
            "properties": {
                "status": {"type": "string"},
                "results": {
                    "type": "array",
                    "items": {
                        "type": "object",
                        "properties": {
                            "bg_task_id": {"type": "string"},
                            "agent_id": {"type": "string"},
                            "outcome": {"type": "string"},
                            "content": {},
                            "error": {}
                        },
                        "required": ["bg_task_id", "agent_id", "outcome"],
                        "additionalProperties": false
                    }
                },
                "pending_bg_task_ids": {"type": "array", "items": {"type": "string"}},
                "already_delivered_bg_task_ids": {"type": "array", "items": {"type": "string"}},
                "missing_bg_task_ids": {"type": "array", "items": {"type": "string"}},
                "invalid_bg_task_inputs": {"type": "array", "items": {}}
            },
            "required": ["status", "results", "pending_bg_task_ids", "already_delivered_bg_task_ids", "missing_bg_task_ids", "invalid_bg_task_inputs"],
            "additionalProperties": false
        })
    }

    fn is_readonly(&self) -> bool {
        false
    }

    fn permission_intents(
        &self,
        _input: &Value,
        _context: &ToolUseContext,
    ) -> OpenBitFunResult<Vec<PermissionIntent>> {
        Ok(Vec::new())
    }

    fn render_tool_use_message(&self, _input: &Value, options: &ToolRenderOptions) -> String {
        if options.verbose {
            "Waiting for background subagent results".to_string()
        } else {
            "Waiting for background tasks".to_string()
        }
    }

    async fn validate_input(
        &self,
        input: &Value,
        _context: Option<&ToolUseContext>,
    ) -> ValidationResult {
        match Self::parse_request(input) {
            Ok(_) => ValidationResult {
                result: true,
                message: None,
                error_code: None,
                meta: None,
            },
            Err(error) => ValidationResult {
                result: false,
                message: Some(error.to_string()),
                error_code: None,
                meta: None,
            },
        }
    }

    async fn call_impl(
        &self,
        input: &Value,
        context: &ToolUseContext,
    ) -> OpenBitFunResult<Vec<ToolResult>> {
        let request = Self::parse_request(input)?;
        let session_id = context.session_id.as_deref().ok_or_else(|| {
            OpenBitFunError::tool("session_id is required in context".to_string())
        })?;
        let dialog_turn_id = context.dialog_turn_id.as_deref().ok_or_else(|| {
            OpenBitFunError::tool("dialog_turn_id is required in context".to_string())
        })?;
        let coordinator = get_global_coordinator()
            .ok_or_else(|| OpenBitFunError::tool("coordinator not initialized".to_string()))?;
        let result = coordinator
            .wait_for_background_subagent_outcomes_with_selection(
                session_id,
                &request.bg_task_ids,
                request.select_all,
                BackgroundSubagentWaitMode::All,
                Duration::from_secs(request.timeout_seconds),
                dialog_turn_id,
                context.cancellation_token(),
                context.round_injection_preemption_token(),
            )
            .await?;
        let assistant_text = Self::assistant_result(&result, &request.invalid_bg_task_inputs);
        let data = json!({
            "status": result.status.as_str(),
            "results": result.outcomes.iter().map(Self::outcome_json).collect::<Vec<_>>(),
            "pending_bg_task_ids": result.pending_bg_task_ids,
            "already_delivered_bg_task_ids": result.already_delivered_bg_task_ids,
            "missing_bg_task_ids": result.missing_bg_task_ids,
            "invalid_bg_task_inputs": request.invalid_bg_task_inputs,
        });
        Ok(vec![ToolResult::Result {
            data,
            result_for_assistant: Some(assistant_text),
            image_attachments: None,
        }])
    }
}

#[cfg(test)]
mod tests {
    use super::{AgentWaitTool, DEFAULT_TIMEOUT_SECONDS, MAX_TIMEOUT_SECONDS, MIN_TIMEOUT_SECONDS};
    use crate::agentic::coordination::{
        BackgroundSubagentWaitResult, BackgroundSubagentWaitStatus,
    };
    use crate::agentic::tools::framework::Tool;

    #[test]
    fn agent_wait_owns_timeout_and_yields_to_round_injection() {
        let tool = AgentWaitTool::new();
        assert!(tool.manages_own_execution_timeout());
        assert!(tool.round_injection_yieldable());
    }

    #[test]
    fn assistant_result_omits_empty_pending_task_list() {
        let result = BackgroundSubagentWaitResult {
            status: BackgroundSubagentWaitStatus::Completed,
            outcomes: Vec::new(),
            pending_bg_task_ids: Vec::new(),
            missing_bg_task_ids: Vec::new(),
            already_delivered_bg_task_ids: Vec::new(),
        };

        assert_eq!(
            AgentWaitTool::assistant_result(&result, &[]),
            "AgentWait finished with status completed."
        );
    }

    #[test]
    fn assistant_result_renders_diagnostics_in_contract_order() {
        let result = BackgroundSubagentWaitResult {
            status: BackgroundSubagentWaitStatus::Completed,
            outcomes: Vec::new(),
            pending_bg_task_ids: vec!["bg-pending".to_string()],
            already_delivered_bg_task_ids: vec!["bg-delivered".to_string()],
            missing_bg_task_ids: vec!["bg-missing".to_string()],
        };

        assert_eq!(
            AgentWaitTool::assistant_result(
                &result,
                &[serde_json::json!(123), serde_json::json!(null)]
            ),
            concat!(
                "AgentWait finished with status completed.",
                "\nPending background task IDs: bg-pending.",
                "\nAlready delivered background task IDs: bg-delivered.",
                "\nBackground task IDs not found: bg-missing.",
                "\nIgnored invalid bg_task_ids inputs: 123, null."
            )
        );
    }

    #[test]
    fn missing_or_empty_task_ids_are_tolerated_by_the_parser() {
        let request = AgentWaitTool::parse_request(&serde_json::json!({})).expect("valid request");
        assert!(request.bg_task_ids.is_empty());
        assert!(request.select_all);
        assert_eq!(request.timeout_seconds, DEFAULT_TIMEOUT_SECONDS);

        let empty = AgentWaitTool::parse_request(&serde_json::json!({
            "bg_task_ids": []
        }))
        .expect("an empty selector must be valid");
        assert!(empty.bg_task_ids.is_empty());
        assert!(empty.select_all);
    }

    #[test]
    fn input_schema_keeps_string_items_and_allows_omitting_ids() {
        let schema = AgentWaitTool::new().input_schema();

        assert!(schema.get("required").is_none());
        assert_eq!(
            schema["properties"]["bg_task_ids"]["items"],
            serde_json::json!({ "type": "string" })
        );
    }

    #[test]
    fn a_single_task_id_string_is_accepted() {
        let request = AgentWaitTool::parse_request(&serde_json::json!({
            "bg_task_ids": " bg1 "
        }))
        .expect("a single task ID string must be accepted");
        assert_eq!(request.bg_task_ids, ["bg1"]);
        assert!(!request.select_all);
    }

    #[test]
    fn legacy_background_task_ids_are_tolerated_without_schema_exposure() {
        let request = AgentWaitTool::parse_request(&serde_json::json!({
            "background_task_ids": ["bg1"]
        }))
        .expect("legacy task IDs must remain unambiguous at runtime");
        assert_eq!(request.bg_task_ids, ["bg1"]);
        assert!(request.invalid_bg_task_inputs.is_empty());
    }

    #[test]
    fn task_ids_trim_deduplicate_and_report_invalid_values() {
        let request = AgentWaitTool::parse_request(&serde_json::json!({
            "bg_task_ids": [" bg1 ", "", null, 1, "bg1", "bg2", "   "]
        }))
        .expect("valid task IDs must be retained");
        assert_eq!(request.bg_task_ids, ["bg1", "bg2"]);
        assert_eq!(
            request.invalid_bg_task_inputs,
            vec![
                serde_json::json!(""),
                serde_json::json!(null),
                serde_json::json!(1),
                serde_json::json!("   ")
            ]
        );
    }

    #[test]
    fn invalid_task_id_inputs_are_tolerated_and_do_not_select_all() {
        let request = AgentWaitTool::parse_request(&serde_json::json!({
            "bg_task_ids": ["", null, 1, {"x": true}, false]
        }))
        .expect("invalid selectors should be tolerated");
        assert!(request.bg_task_ids.is_empty());
        assert!(!request.select_all);
        assert_eq!(
            request.invalid_bg_task_inputs,
            vec![
                serde_json::json!(""),
                serde_json::json!(null),
                serde_json::json!(1),
                serde_json::json!({"x": true}),
                serde_json::json!(false)
            ]
        );
    }

    #[test]
    fn timeout_uses_seconds_and_is_clamped_to_supported_bounds() {
        let defaulted = AgentWaitTool::parse_request(&serde_json::json!({
            "timeout_seconds": "invalid",
            "unused": true
        }))
        .expect("invalid timeout and unknown parameters must be tolerated");
        assert_eq!(defaulted.timeout_seconds, DEFAULT_TIMEOUT_SECONDS);

        let capped = AgentWaitTool::parse_request(&serde_json::json!({
            "timeout_seconds": MAX_TIMEOUT_SECONDS + 1
        }))
        .expect("large timeout must be capped");
        assert_eq!(capped.timeout_seconds, MAX_TIMEOUT_SECONDS);

        let raised = AgentWaitTool::parse_request(&serde_json::json!({
            "timeout_seconds": MIN_TIMEOUT_SECONDS - 1
        }))
        .expect("short timeout must be raised to the minimum");
        assert_eq!(raised.timeout_seconds, MIN_TIMEOUT_SECONDS);
    }
}
