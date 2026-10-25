//! GetTime tool implementation.

use crate::agentic::tools::framework::{Tool, ToolRenderOptions, ToolResult, ToolUseContext};
use crate::util::errors::OpenBitFunResult;
use async_trait::async_trait;
use chrono::{Datelike, Local, SecondsFormat, Utc};
use serde_json::{json, Value};

/// GetTime tool - returns current local and UTC time facts.
pub struct GetTimeTool;

impl Default for GetTimeTool {
    fn default() -> Self {
        Self::new()
    }
}

impl GetTimeTool {
    pub fn new() -> Self {
        Self
    }
}

#[async_trait]
impl Tool for GetTimeTool {
    fn name(&self) -> &str {
        "GetTime"
    }

    async fn description(&self) -> OpenBitFunResult<String> {
        Ok(r#"Return the current time, weekday, and Unix timestamp.

Use this tool when you need reliable current date/time facts for planning, timestamping, report names, or date-sensitive reasoning. It returns local time, UTC time, weekday, and Unix timestamps in seconds and milliseconds.

This tool takes no parameters."#
            .to_string())
    }

    fn short_description(&self) -> String {
        "Return the current time, weekday, and Unix timestamp.".to_string()
    }

    fn input_schema(&self) -> Value {
        json!({
            "type": "object",
            "properties": {},
            "additionalProperties": false
        })
    }

    fn output_schema(&self) -> Value {
        json!({
            "type": "object",
            "properties": {
                "success": {"type": "boolean"},
                "local_time": {"type": "string"},
                "weekday": {"type": "string"},
                "unix_timestamp_seconds": {"type": "integer"}
            },
            "required": ["success", "local_time", "weekday", "unix_timestamp_seconds"],
            "additionalProperties": false
        })
    }

    fn is_readonly(&self) -> bool {
        true
    }

    fn is_concurrency_safe(&self, _input: Option<&Value>) -> bool {
        true
    }

    fn render_tool_use_message(&self, _input: &Value, _options: &ToolRenderOptions) -> String {
        "Get current time".to_string()
    }

    fn render_tool_result_message(&self, output: &Value) -> String {
        output
            .get("local_time")
            .and_then(Value::as_str)
            .map(|local_time| format!("Current time: {local_time}"))
            .unwrap_or_else(|| "Current time returned".to_string())
    }

    async fn call_impl(
        &self,
        _input: &Value,
        _context: &ToolUseContext,
    ) -> OpenBitFunResult<Vec<ToolResult>> {
        let now = Local::now();
        let utc = now.with_timezone(&Utc);
        let local_time = now.to_rfc3339_opts(SecondsFormat::Secs, false);
        let utc_time = utc.to_rfc3339_opts(SecondsFormat::Secs, true);
        let weekday = now.format("%A").to_string();
        let unix_timestamp_seconds = now.timestamp();
        let unix_timestamp_millis = now.timestamp_millis();
        let timezone_offset = now.format("%:z").to_string();

        let data = json!({
            "success": true,
            "local_time": local_time,
            "utc_time": utc_time,
            "weekday": weekday,
            "weekday_number_from_monday": now.weekday().number_from_monday(),
            "unix_timestamp_seconds": unix_timestamp_seconds,
            "unix_timestamp_millis": unix_timestamp_millis,
            "timezone_offset": timezone_offset,
        });
        let result_for_assistant = format!(
            "Current local time: {} ({}); Unix timestamp: {}.",
            data["local_time"].as_str().unwrap_or_default(),
            data["weekday"].as_str().unwrap_or_default(),
            unix_timestamp_seconds
        );

        Ok(vec![ToolResult::Result {
            data,
            result_for_assistant: Some(result_for_assistant),
            image_attachments: None,
        }])
    }
}

#[cfg(test)]
mod tests {
    use super::GetTimeTool;
    use crate::agentic::tools::framework::{Tool, ToolResult, ToolUseContext};
    use std::collections::HashMap;

    fn test_context() -> ToolUseContext {
        ToolUseContext {
            tool_call_id: None,
            agent_type: None,
            session_id: None,
            dialog_turn_id: None,
            workspace: None,
            loaded_deferred_tool_specs: Vec::new(),
            primary_model_facts: tool_runtime::context::PrimaryModelFacts::default(),
            custom_data: HashMap::new(),
            computer_use_host: None,
            runtime_tool_restrictions: Default::default(),
            runtime_handles: openbitfun_runtime_ports::ToolRuntimeHandles::default(),
        }
    }

    #[tokio::test]
    async fn get_time_returns_current_time_facts() {
        let tool = GetTimeTool::new();
        let result = tool
            .call_impl(&serde_json::json!({}), &test_context())
            .await
            .expect("GetTime should return time facts");

        let ToolResult::Result {
            data,
            result_for_assistant,
            ..
        } = &result[0]
        else {
            panic!("GetTime should return a structured result");
        };

        assert_eq!(data["success"], true);
        assert!(data["local_time"]
            .as_str()
            .is_some_and(|value| !value.is_empty()));
        assert!(data["utc_time"]
            .as_str()
            .is_some_and(|value| !value.is_empty()));
        assert!(data["weekday"]
            .as_str()
            .is_some_and(|value| !value.is_empty()));
        assert!(data["unix_timestamp_seconds"].as_i64().is_some());
        assert!(data["unix_timestamp_millis"].as_i64().is_some());
        assert!(data.get("timestamp").is_none());
        assert!(data.get("date").is_none());
        assert!(data.get("time").is_none());
        assert!(result_for_assistant
            .as_ref()
            .is_some_and(|value| value.contains("Current local time")));
    }
}
