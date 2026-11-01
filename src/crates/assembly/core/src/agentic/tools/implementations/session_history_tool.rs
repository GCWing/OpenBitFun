use crate::agentic::tools::framework::{
    Tool, ToolExposure, ToolRenderOptions, ToolResult, ToolUseContext, ValidationResult,
};
use crate::service::session::SessionTranscriptExportOptions;
use crate::service_agent_runtime::CoreServiceAgentRuntime;
use crate::util::errors::{OpenBitFunError, OpenBitFunResult};
use async_trait::async_trait;
use serde::Deserialize;
use serde_json::{json, Value};

/// SessionHistory tool - export a grep-friendly transcript file for a session.
pub struct SessionHistoryTool;

impl Default for SessionHistoryTool {
    fn default() -> Self {
        Self::new()
    }
}

impl SessionHistoryTool {
    pub fn new() -> Self {
        Self
    }

    fn validate_session_id(session_id: &str) -> Result<(), String> {
        openbitfun_core_types::validate_session_id(session_id)
    }

    fn resolve_session_id(&self, session_id: &str) -> OpenBitFunResult<String> {
        let session_id = session_id.trim().to_string();
        Self::validate_session_id(&session_id).map_err(OpenBitFunError::tool)?;
        Ok(session_id)
    }
}

#[derive(Debug, Clone, Deserialize)]
struct SessionHistoryInput {
    session_id: String,
    #[serde(default)]
    tools: Option<bool>,
    #[serde(default)]
    tool_inputs: Option<bool>,
    #[serde(default)]
    thinking: Option<bool>,
    #[serde(default)]
    turns: Option<Vec<String>>,
}

#[async_trait]
impl Tool for SessionHistoryTool {
    fn name(&self) -> &str {
        "SessionHistory"
    }

    async fn description(&self) -> OpenBitFunResult<String> {
        Ok(
            r#"Use this tool when you need the history of an agent session.

This tool does not return full details directly. Instead, it exports a transcript file. The result includes the transcript file path together with index location hints.

The transcript file starts with a compact index. Each index entry includes the turn number, a short preview, and line ranges you can use for targeted reads.

Recommended workflow:
1. Call this tool.
2. Read only the index line range from the returned transcript path first.
3. Inspect the on-file index header to find the turn you want.
4. Read only the matching `range`.

Typical usage:
- To review session history across a workspace, first use `SessionControl` to list the sessions in that workspace, then call this tool for the sessions you want to inspect.
- To inspect the latest state of a specific session, call this tool with `turns=["-1:"]` to export only the last turn.

Minimal transcript example:
<example>
## Index
- turn=0 range=4-7 preview="Fix failing login test"

## Turn 0
[user]
Fix failing login test
[/user]
</example>
In the example above, read lines `1-2` first, then jump directly to `range=4-7`.

`turns` parameter:
- Optional list of turn selectors.
- Supports selectors such as `":1"`, `"-20:"`, `":1" + "-5:"`, and `"10:30"`.
- When omitted, exports all turns.

Examples:
1. Export the full transcript: leave `turns` empty
2. Export the first turn only: `turns=[":1"]`
3. Export the last 3 turns: `turns=["-3:"]`
4. Export the first turn and the last 3 turns: `turns=[":1", "-3:"]`
5. Export a middle range: `turns=["2:5"]`"#
                .to_string(),
        )
    }

    fn short_description(&self) -> String {
        "Export an agent session transcript with an index for targeted history reads. Use this tool when you need the history of an agent session."
            .to_string()
    }

    fn default_exposure(&self) -> ToolExposure {
        ToolExposure::Deferred
    }

    fn input_schema(&self) -> Value {
        json!({
            "type": "object",
            "properties": {
                "session_id": {
                    "type": "string",
                    "description": "Required session ID to export."
                },
                "tools": {
                    "type": "boolean",
                    "description": "Whether to include tool sections. Defaults to false."
                },
                "tool_inputs": {
                    "type": "boolean",
                    "description": "Whether to include tool input parameters in tool sections. Defaults to false. Only applies when tools is true."
                },
                "thinking": {
                    "type": "boolean",
                    "description": "Whether to include thinking sections. Defaults to false."
                },
                "turns": {
                    "type": "array",
                    "items": {
                        "type": "string"
                    },
                    "description": "Optional list of turn selectors. Supports index and start:end forms such as \":1\", \"-20:\", \"10:30\", or \"15\"."
                }
            },
            "required": ["session_id"],
            "additionalProperties": false
        })
    }

    fn output_schema(&self) -> Value {
        json!({
            "type": "object",
            "properties": {
                "success": {"type": "boolean"},
                "workspace": {"type": "string"},
                "transcript": {
                    "type": "object",
                    "properties": {
                        "transcript_path": {"type": "string"},
                        "index_range": {
                            "type": "object",
                            "properties": {
                                "start_line": {"type": "integer"},
                                "end_line": {"type": "integer"}
                            },
                            "required": ["start_line", "end_line"],
                            "additionalProperties": false
                        }
                    },
                    "required": ["transcript_path", "index_range"],
                    "additionalProperties": true
                }
            },
            "required": ["success", "workspace", "transcript"],
            "additionalProperties": false
        })
    }

    fn is_readonly(&self) -> bool {
        true
    }

    async fn validate_input(
        &self,
        input: &Value,
        _context: Option<&ToolUseContext>,
    ) -> ValidationResult {
        let parsed: SessionHistoryInput = match serde_json::from_value(input.clone()) {
            Ok(value) => value,
            Err(err) => {
                return ValidationResult {
                    result: false,
                    message: Some(format!("Invalid input: {}", err)),
                    error_code: Some(400),
                    meta: None,
                };
            }
        };

        if parsed.session_id.trim().is_empty() {
            return ValidationResult {
                result: false,
                message: Some("session_id cannot be empty".to_string()),
                error_code: Some(400),
                meta: None,
            };
        }

        if let Err(message) = Self::validate_session_id(parsed.session_id.trim()) {
            return ValidationResult {
                result: false,
                message: Some(message),
                error_code: Some(400),
                meta: None,
            };
        }

        if parsed
            .turns
            .as_ref()
            .is_some_and(|selectors| selectors.is_empty())
        {
            return ValidationResult {
                result: false,
                message: Some("turns cannot be an empty array".to_string()),
                error_code: Some(400),
                meta: None,
            };
        }

        if parsed
            .turns
            .as_ref()
            .is_some_and(|selectors| selectors.iter().any(|selector| selector.trim().is_empty()))
        {
            return ValidationResult {
                result: false,
                message: Some("turns cannot contain empty selectors".to_string()),
                error_code: Some(400),
                meta: None,
            };
        }

        ValidationResult::default()
    }

    fn render_tool_use_message(&self, input: &Value, _options: &ToolRenderOptions) -> String {
        let session_id = input
            .get("session_id")
            .and_then(|value| value.as_str())
            .unwrap_or("unknown session");
        format!("Export transcript for {}", session_id)
    }

    async fn call_impl(
        &self,
        input: &Value,
        _context: &ToolUseContext,
    ) -> OpenBitFunResult<Vec<ToolResult>> {
        let params: SessionHistoryInput = serde_json::from_value(input.clone())
            .map_err(|e| OpenBitFunError::tool(format!("Invalid input: {}", e)))?;

        let session_id = self.resolve_session_id(&params.session_id)?;
        let (display_workspace, session_storage_dir) =
            CoreServiceAgentRuntime::resolve_session_workspace_paths(&session_id)
                .await
                .ok_or_else(|| {
                    OpenBitFunError::NotFound(format!(
                        "Workspace for session '{}' could not be resolved",
                        session_id
                    ))
                })?;
        let display_workspace = display_workspace.to_string_lossy().into_owned();
        let coordinator =
            crate::agentic::coordination::get_global_coordinator().ok_or_else(|| {
                OpenBitFunError::service(
                    "Core coordinator is unavailable for SessionHistory export",
                )
            })?;
        let transcript = coordinator
            .export_visible_persisted_session_transcript(
                &session_storage_dir,
                &session_id,
                &SessionTranscriptExportOptions {
                    tools: params.tools.unwrap_or(false),
                    tool_inputs: params.tool_inputs.unwrap_or(false),
                    thinking: params.thinking.unwrap_or(false),
                    turns: params.turns,
                },
            )
            .await?;

        Ok(vec![ToolResult::Result {
            data: json!({
                "success": true,
                "workspace": display_workspace,
                "transcript": transcript,
            }),
            result_for_assistant: Some(format!(
                "Transcript exported to '{}'. The index is on lines {}-{}. Read that range first, then use Grep or Read on that path for targeted navigation.",
                transcript.transcript_path,
                transcript.index_range.start_line,
                transcript.index_range.end_line
            )),
            image_attachments: None,
        }])
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    #[tokio::test]
    async fn validate_allows_missing_workspace_when_session_id_present() {
        let tool = SessionHistoryTool::new();

        let validation = tool
            .validate_input(
                &json!({
                    "session_id": "worker_1",
                }),
                None,
            )
            .await;

        assert!(validation.result, "{:?}", validation.message);
    }
}
