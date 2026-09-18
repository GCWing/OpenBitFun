use crate::agentic::tools::file_permissions::file_permission_intents_allowing_managed_plan_edits;
use crate::agentic::tools::file_tool_guidance::file_tool_guidance_message;
use crate::agentic::tools::framework::{
    PermissionIntent, Tool, ToolPathResolution, ToolResult, ToolUseContext, ValidationResult,
};
use crate::agentic::tools::ToolPathOperation;
use crate::util::errors::{OpenBitFunError, OpenBitFunResult};
use async_trait::async_trait;
use serde_json::{json, Value};
use tool_runtime::fs::edit_file::{apply_edit_to_content, edit_success_message, EditContentError};

pub struct FileEditTool;

const EDIT_TOOL_PROMPT: &str = r#"Performs exact string replacements in files.

Usage:
- You must read the current file contents before editing.
- The `file_path` parameter must be a workspace-relative path, an absolute path inside the current workspace, or an exact `openbitfun://...` URI returned by another tool.
- When editing text from Read tool output, ensure you preserve the exact indentation (tabs/spaces) as it appears AFTER the line number prefix. The line number prefix format is: spaces + line number + tab. Everything after that is the actual file content to match. Never include any part of the line number prefix in the old_string or new_string.
- Copy `old_string` verbatim from your latest Read of this file. Do not reformat HTML/CSS/JS, do not normalize indentation, and do not reconstruct the block from memory.
- Use the smallest `old_string` that is clearly unique — usually 2-4 adjacent lines with stable surrounding context is sufficient.
- If Read output was truncated or used start_line/limit, re-read until the full target block is visible before editing.
- ALWAYS prefer editing existing files in the codebase. NEVER write new files unless explicitly required.
- Only use emojis if the user explicitly requests it. Avoid adding emojis to files unless asked.
- The edit will FAIL if `old_string` is not unique in the file. Either provide a larger string with more surrounding context to make it unique or use `replace_all` to change every instance of `old_string`.
- Use `replace_all` for replacing and renaming strings across the file. This parameter is useful if you want to rename a variable for instance.
- If an edit fails because the text was not found, call Read again on the target lines and retry with a freshly copied `old_string`."#;

impl Default for FileEditTool {
    fn default() -> Self {
        Self::new()
    }
}

impl FileEditTool {
    pub fn new() -> Self {
        Self
    }

    fn content_failure(error: EditContentError) -> ValidationResult {
        let detail = error.detail();
        ValidationResult {
            result: false,
            message: Some(if detail.is_some() {
                file_tool_guidance_message(error.to_string())
            } else {
                error.to_string()
            }),
            error_code: Some(400),
            meta: detail
                .map(|detail| json!({ "failure_kind": "guidance", "error_detail": detail })),
        }
    }

    async fn read_current_file_content(
        context: &ToolUseContext,
        resolved: &ToolPathResolution,
    ) -> OpenBitFunResult<String> {
        context
            .file_system_for_path(resolved)?
            .read_file_text(&resolved.resolved_path)
            .await
            .map_err(|error| {
                OpenBitFunError::tool(format!(
                    "Failed to read file {}: {:#}",
                    resolved.logical_path, error
                ))
            })
    }
}

#[async_trait]
impl Tool for FileEditTool {
    fn name(&self) -> &str {
        "Edit"
    }

    async fn description(&self) -> OpenBitFunResult<String> {
        Ok(EDIT_TOOL_PROMPT.to_string())
    }

    fn short_description(&self) -> String {
        "A tool for editing files".to_string()
    }

    fn input_schema(&self) -> Value {
        json!({
            "type": "object",
            "properties": {
                "file_path": {
                    "type": "string",
                    "description": "The path to the file to modify"
                },
                "old_string": {
                    "type": "string",
                    "description": "Exact text to replace, copied verbatim from your latest Read of this file (content after the line-number tab only). Preserve indentation; do not reformat."
                },
                "new_string": {
                    "type": "string",
                    "description": "Replacement text with the same indentation style as old_string (must be different from old_string)"
                },
                "replace_all": {
                    "type": "boolean",
                    "default": false,
                    "description": "Replace all occurrences of old_string (default false)"
                }
            },
            "required": ["file_path", "old_string", "new_string"],
            "additionalProperties": false
        })
    }

    fn is_readonly(&self) -> bool {
        false
    }

    fn is_concurrency_safe(&self, _input: Option<&Value>) -> bool {
        false
    }

    fn permission_intents(
        &self,
        input: &Value,
        context: &ToolUseContext,
    ) -> OpenBitFunResult<Vec<PermissionIntent>> {
        let file_path = input
            .get("file_path")
            .and_then(Value::as_str)
            .ok_or_else(|| OpenBitFunError::validation("file_path is required".to_string()))?;
        file_permission_intents_allowing_managed_plan_edits("edit", [file_path], context)
    }

    async fn validate_input(
        &self,
        input: &Value,
        context: Option<&ToolUseContext>,
    ) -> ValidationResult {
        let file_path = match input.get("file_path").and_then(|v| v.as_str()) {
            Some(path) if !path.is_empty() => path,
            _ => {
                return ValidationResult {
                    result: false,
                    message: Some("file_path is required and cannot be empty".to_string()),
                    error_code: Some(400),
                    meta: None,
                };
            }
        };

        let rewrite_invariant = self.validate_input_rewrite_invariants(input, context).await;
        if !rewrite_invariant.result {
            return rewrite_invariant;
        }

        if input.get("old_string").is_none() {
            return ValidationResult {
                result: false,
                message: Some("old_string is required".to_string()),
                error_code: Some(400),
                meta: None,
            };
        }

        if input.get("new_string").is_none() {
            return ValidationResult {
                result: false,
                message: Some("new_string is required".to_string()),
                error_code: Some(400),
                meta: None,
            };
        }

        let old_string = input
            .get("old_string")
            .and_then(|v| v.as_str())
            .unwrap_or("");
        let new_string = input
            .get("new_string")
            .and_then(|v| v.as_str())
            .unwrap_or("");
        let replace_all = input
            .get("replace_all")
            .and_then(|v| v.as_bool())
            .unwrap_or(false);

        if old_string.is_empty() {
            return ValidationResult {
                result: false,
                message: Some("old_string cannot be empty".to_string()),
                error_code: Some(400),
                meta: None,
            };
        }
        if old_string == new_string {
            return Self::content_failure(EditContentError::no_change());
        }

        if let Some(ctx) = context {
            let resolved = match ctx.resolve_tool_path(file_path) {
                Ok(resolved) => resolved,
                Err(err) => {
                    return ValidationResult {
                        result: false,
                        message: Some(err.to_string()),
                        error_code: Some(400),
                        meta: None,
                    };
                }
            };

            if let Err(err) = ctx.enforce_path_operation(ToolPathOperation::Edit, &resolved) {
                return ValidationResult {
                    result: false,
                    message: Some(err.to_string()),
                    error_code: Some(400),
                    meta: None,
                };
            }

            let file_content = match Self::read_current_file_content(ctx, &resolved).await {
                Ok(content) => content,
                Err(error) => {
                    return ValidationResult {
                        result: false,
                        message: Some(format!(
                            "Failed to read file {}: {}",
                            resolved.logical_path, error
                        )),
                        error_code: Some(400),
                        meta: None,
                    };
                }
            };

            if let Err(error) =
                apply_edit_to_content(&file_content, old_string, new_string, replace_all)
            {
                return Self::content_failure(error);
            }
        }

        ValidationResult::default()
    }

    async fn validate_input_rewrite_invariants(
        &self,
        input: &Value,
        context: Option<&ToolUseContext>,
    ) -> ValidationResult {
        let Some(file_path) = input
            .get("file_path")
            .and_then(Value::as_str)
            .filter(|path| !path.is_empty())
        else {
            return ValidationResult::default();
        };
        let force_requested = input.get("force").and_then(Value::as_bool).unwrap_or(false);
        crate::agentic::execution::edit_constraint_guard::check_edit(
            context,
            "Edit",
            "edit",
            file_path,
            force_requested,
        )
        .await
        .unwrap_or_default()
    }

    async fn call_impl(
        &self,
        input: &Value,
        context: &ToolUseContext,
    ) -> OpenBitFunResult<Vec<ToolResult>> {
        let file_path = input
            .get("file_path")
            .and_then(|v| v.as_str())
            .ok_or_else(|| OpenBitFunError::tool("file_path is required".to_string()))?;

        let new_string = input
            .get("new_string")
            .and_then(|v| v.as_str())
            .ok_or_else(|| OpenBitFunError::tool("new_string is required".to_string()))?;

        let old_string = input
            .get("old_string")
            .and_then(|v| v.as_str())
            .ok_or_else(|| OpenBitFunError::tool("old_string is required".to_string()))?;

        let replace_all = input
            .get("replace_all")
            .and_then(|v| v.as_bool())
            .unwrap_or(false);

        let resolved = context.resolve_tool_path(file_path)?;
        context.enforce_path_operation(ToolPathOperation::Edit, &resolved)?;
        context
            .record_light_checkpoint(
                "Edit",
                &resolved.logical_path,
                vec![resolved.logical_path.clone()],
            )
            .await?;

        let file_system = context.file_system_for_path(&resolved)?;
        let content = Self::read_current_file_content(context, &resolved).await?;
        let edit_result = apply_edit_to_content(&content, old_string, new_string, replace_all)
            .map_err(|error| {
                if let Some(detail) = error.detail() {
                    OpenBitFunError::ClassifiedTool {
                        message: file_tool_guidance_message(error.to_string()),
                        detail,
                    }
                } else {
                    OpenBitFunError::tool(error.to_string())
                }
            })?;
        file_system
            .write_file(&resolved.resolved_path, edit_result.new_content.as_bytes())
            .await
            .map_err(|error| {
                OpenBitFunError::tool(format!(
                    "Failed to write file {}: {:#}",
                    resolved.logical_path, error
                ))
            })?;

        crate::agentic::execution::edit_constraint_guard::record_mutation_applied(
            context,
            "Edit",
            "edit",
            &resolved.logical_path,
        )
        .await;

        let result = ToolResult::Result {
            data: json!({
                "file_path": resolved.logical_path,
                "old_string": old_string,
                "new_string": new_string,
                "success": true,
                "match_count": edit_result.match_count,
                "start_line": edit_result.edit_result.start_line,
                "old_end_line": edit_result.edit_result.old_end_line,
                "new_end_line": edit_result.edit_result.new_end_line,
            }),
            result_for_assistant: Some(edit_success_message(&resolved.logical_path)),
            image_attachments: None,
        };

        Ok(vec![result])
    }
}

#[cfg(test)]
mod tests {
    use super::{FileEditTool, EDIT_TOOL_PROMPT};
    use crate::agentic::tools::framework::Tool;
    use serde_json::{json, Value};

    #[tokio::test]
    async fn equal_strings_are_guidance_but_missing_inputs_remain_errors() {
        let tool = FileEditTool::new();
        let result = tool
            .validate_input(
                &json!({"file_path":"a.txt", "old_string":"same", "new_string":"same"}),
                None,
            )
            .await;
        assert!(!result.result);
        assert_eq!(
            result.meta.unwrap()["error_detail"]["code"],
            "edit_no_change"
        );
        assert!(result.message.unwrap().starts_with("[guidance] "));
        let result = tool
            .validate_input(&json!({"file_path":"a.txt", "old_string":"same"}), None)
            .await;
        assert!(!result.result);
        assert!(result.meta.is_none());
    }

    #[test]
    fn edit_tool_schema_describes_exact_copy_from_read() {
        let schema = FileEditTool::new().input_schema();
        let properties = schema
            .get("properties")
            .and_then(Value::as_object)
            .expect("properties");

        assert_eq!(
            properties
                .get("file_path")
                .and_then(|value| value.get("description"))
                .and_then(Value::as_str),
            Some("The path to the file to modify")
        );
        assert!(properties
            .get("old_string")
            .and_then(|value| value.get("description"))
            .and_then(Value::as_str)
            .unwrap_or_default()
            .contains("latest Read"));
        assert!(properties
            .get("new_string")
            .and_then(|value| value.get("description"))
            .and_then(Value::as_str)
            .unwrap_or_default()
            .contains("indentation"));
        assert_eq!(
            properties
                .get("replace_all")
                .and_then(|value| value.get("description"))
                .and_then(Value::as_str),
            Some("Replace all occurrences of old_string (default false)")
        );
        assert!(properties
            .get("old_string")
            .and_then(|value| value.get("minLength"))
            .is_none());
        assert!(properties.get("force").is_none());
    }

    #[test]
    fn edit_tool_short_description_matches_claude_summary() {
        assert_eq!(
            FileEditTool::new().short_description(),
            "A tool for editing files"
        );
    }

    #[tokio::test]
    async fn non_relaxable_edit_invariant_precedes_repairable_schema_errors() {
        let validation = crate::agentic::execution::edit_constraint_guard::TEST_ENABLED
            .scope(true, async {
                FileEditTool::new()
                    .validate_input(
                        &json!({
                            "file_path": "tests/a.rs",
                            "old_string": "x",
                            "force": true
                        }),
                        None,
                    )
                    .await
            })
            .await;

        assert_eq!(validation.error_code, Some(403));
        assert!(validation.blocks_input_rewrite());
        assert!(!validation
            .message
            .as_deref()
            .unwrap_or_default()
            .contains("new_string is required"));
    }
}
