use super::completion::{exec_command_local_completion, exec_command_remote_completion};
use super::progress::ExecOutputProgressBridge;
use crate::agentic::tools::framework::{Tool, ToolResult, ToolUseContext, ValidationResult};
use crate::util::errors::{OpenBitFunError, OpenBitFunResult};
use async_trait::async_trait;
use openbitfun_runtime_ports::{PortErrorKind, RemoteWriteStdinRequest, TerminalWriteStdinRequest};
use serde_json::{json, Value};
use tool_runtime::exec_command::{
    render_write_stdin_response_for_assistant, write_stdin_input_from_input,
    write_stdin_input_validation_message, write_stdin_result_value,
    write_stdin_session_not_found_result, ExecCommandResultFields,
};

pub struct WriteStdinTool;

impl Default for WriteStdinTool {
    fn default() -> Self {
        Self::new()
    }
}

impl WriteStdinTool {
    pub fn new() -> Self {
        Self
    }

    fn response_for_assistant(data: &Value) -> String {
        render_write_stdin_response_for_assistant(data)
    }

    fn session_not_found_result(session_id: i32, remote: bool) -> Vec<ToolResult> {
        let result = write_stdin_session_not_found_result(session_id, remote);

        vec![ToolResult::Result {
            data: result.data,
            result_for_assistant: Some(result.assistant_message),
            image_attachments: None,
        }]
    }

    async fn call_remote_pipe(
        &self,
        input: &Value,
        context: &ToolUseContext,
    ) -> OpenBitFunResult<Vec<ToolResult>> {
        let parsed_input = write_stdin_input_from_input(input).ok_or_else(|| {
            OpenBitFunError::tool("session_id is required for WriteStdin".to_string())
        })?;
        let session_id = parsed_input.session_id;
        let request = RemoteWriteStdinRequest {
            session_id,
            chars: parsed_input.chars,
            append_enter: parsed_input.append_enter,
            yield_time_ms: Some(parsed_input.yield_time_ms),
            max_output_chars: None,
        };
        let remote_exec_port = context.remote_exec_port().ok_or_else(|| {
            OpenBitFunError::tool(
                "remote exec runtime service is required for WriteStdin".to_string(),
            )
        })?;
        let progress_bridge = ExecOutputProgressBridge::start(context, self.name());
        let response_result = if let Some(bridge) = progress_bridge.as_ref() {
            remote_exec_port
                .write_stdin_streaming(request, bridge.sender())
                .await
        } else {
            remote_exec_port.write_stdin(request).await
        };
        if let Some(bridge) = progress_bridge {
            bridge.finish().await;
        }
        let response = match response_result {
            Ok(response) => response,
            Err(error) if error.kind == PortErrorKind::NotFound => {
                return Ok(Self::session_not_found_result(session_id, true));
            }
            Err(error) => {
                return Err(OpenBitFunError::tool(format!(
                    "WriteStdin failed: {}",
                    error.message
                )));
            }
        };

        let data = write_stdin_result_value(ExecCommandResultFields {
            chunk_id: response.chunk_id,
            wall_time_seconds: response.wall_time_seconds,
            output: response.output,
            session_id: response.session_id,
            exit_code: response.exit_code,
            original_output_chars: response.original_output_chars,
            completion: response.completion.map(exec_command_remote_completion),
            remote: true,
        });
        let result_for_assistant = Self::response_for_assistant(&data);

        Ok(vec![ToolResult::Result {
            data,
            result_for_assistant: Some(result_for_assistant),
            image_attachments: None,
        }])
    }
}

#[async_trait]
impl Tool for WriteStdinTool {
    fn name(&self) -> &str {
        "WriteStdin"
    }

    async fn description(&self) -> OpenBitFunResult<String> {
        Ok(r#"Writes stdin to, or polls, a running ExecCommand session.

Pass the session_id returned by ExecCommand. Leave chars empty or omit it to poll for new output.
chars is sent only to sessions started with tty=true. For tty=false sessions, this tool only polls.
Use append_enter=true to submit a line after chars. Use this for line-oriented interactive prompts instead of trying to encode \\r or \\n manually.
Output is only what was produced during this tool call's wait window."#
            .to_string())
    }

    fn short_description(&self) -> String {
        "Write to or poll a running ExecCommand session.".to_string()
    }

    fn input_schema(&self) -> Value {
        json!({
            "type": "object",
            "properties": {
                "session_id": {
                    "type": "number",
                    "description": "session_id returned by ExecCommand while a process is still running."
                },
                "chars": {
                    "type": "string",
                    "description": "Characters to write to stdin. Empty or omitted means poll for new output."
                },
                "append_enter": {
                    "type": "boolean",
                    "description": "When true, append an Enter key after chars."
                },
                "yield_time_ms": {
                    "type": "number",
                    "description": "How long to wait for output before yielding. Defaults to 30000 ms."
                }
            },
            "required": ["session_id"],
            "additionalProperties": false
        })
    }

    fn is_readonly(&self) -> bool {
        false
    }

    fn is_concurrency_safe(&self, _input: Option<&Value>) -> bool {
        false
    }

    fn manages_own_execution_timeout(&self) -> bool {
        true
    }

    async fn validate_input(
        &self,
        input: &Value,
        context: Option<&ToolUseContext>,
    ) -> ValidationResult {
        if let Some(message) = write_stdin_input_validation_message(input) {
            return ValidationResult {
                result: false,
                message: Some(message.to_string()),
                error_code: Some(400),
                meta: None,
            };
        }
        if let (Some(context), Some(chars)) = (context, input.get("chars").and_then(Value::as_str))
        {
            if let Some(rejection) =
                crate::agentic::execution::edit_constraint_guard::check_bash_command(context, chars)
                    .await
            {
                return rejection;
            }
        }
        ValidationResult {
            result: true,
            message: None,
            error_code: None,
            meta: None,
        }
    }

    async fn validate_input_rewrite_invariants(
        &self,
        input: &Value,
        context: Option<&ToolUseContext>,
    ) -> ValidationResult {
        let Some((context, chars)) = context.zip(input.get("chars").and_then(Value::as_str)) else {
            return ValidationResult::default();
        };
        crate::agentic::execution::edit_constraint_guard::check_bash_command(context, chars)
            .await
            .unwrap_or_default()
    }

    async fn call_impl(
        &self,
        input: &Value,
        context: &ToolUseContext,
    ) -> OpenBitFunResult<Vec<ToolResult>> {
        if context.is_remote() {
            return self.call_remote_pipe(input, context).await;
        }

        let parsed_input = write_stdin_input_from_input(input).ok_or_else(|| {
            OpenBitFunError::tool("session_id is required for WriteStdin".to_string())
        })?;
        let session_id = parsed_input.session_id;
        let request = TerminalWriteStdinRequest {
            session_id,
            chars: parsed_input.chars,
            append_enter: parsed_input.append_enter,
            yield_time_ms: Some(parsed_input.yield_time_ms),
            max_output_chars: None,
        };
        let terminal_port = context.terminal_port().ok_or_else(|| {
            OpenBitFunError::tool("terminal runtime service is required for WriteStdin".to_string())
        })?;
        let progress_bridge = ExecOutputProgressBridge::start(context, self.name());
        let response_result = if let Some(bridge) = progress_bridge.as_ref() {
            terminal_port
                .write_stdin_streaming(request, bridge.sender())
                .await
        } else {
            terminal_port.write_stdin(request).await
        };
        if let Some(bridge) = progress_bridge {
            bridge.finish().await;
        }
        let response = match response_result {
            Ok(response) => response,
            Err(error) if error.kind == PortErrorKind::NotFound => {
                return Ok(Self::session_not_found_result(session_id, false));
            }
            Err(error) => {
                return Err(OpenBitFunError::tool(format!(
                    "WriteStdin failed: {}",
                    error.message
                )));
            }
        };

        let data = write_stdin_result_value(ExecCommandResultFields {
            chunk_id: response.chunk_id,
            wall_time_seconds: response.wall_time_seconds,
            output: response.output,
            session_id: response.session_id,
            exit_code: response.exit_code,
            original_output_chars: response.original_output_chars,
            completion: response.completion.map(exec_command_local_completion),
            remote: false,
        });
        let result_for_assistant = Self::response_for_assistant(&data);

        Ok(vec![ToolResult::Result {
            data,
            result_for_assistant: Some(result_for_assistant),
            image_attachments: None,
        }])
    }
}

#[cfg(test)]
mod tests {
    use super::WriteStdinTool;
    use crate::agentic::tools::framework::ToolResult;

    #[test]
    fn session_not_found_result_uses_plain_assistant_message() {
        let results = WriteStdinTool::session_not_found_result(123, false);
        let ToolResult::Result {
            data,
            result_for_assistant,
            ..
        } = &results[0]
        else {
            panic!("expected result");
        };

        assert_eq!(
            data.get("status").and_then(|value| value.as_str()),
            Some("session_not_found")
        );
        assert_eq!(
            data.get("requested_session_id")
                .and_then(|value| value.as_i64()),
            Some(123)
        );
        let assistant = result_for_assistant.as_deref().expect("assistant text");
        assert!(assistant.contains("ExecCommand session 123 was not found"));
        assert!(!assistant.contains("<wall_time>"));
        assert!(!assistant.contains("<output>"));
    }
}
