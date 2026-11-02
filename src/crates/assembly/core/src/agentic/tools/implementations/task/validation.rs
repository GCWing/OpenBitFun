use super::*;

impl AgentExecutionTool {
    pub(super) fn context_mode_from_input(input: &Value) -> OpenBitFunResult<SubagentContextMode> {
        match input.get("fork_context") {
            None | Some(Value::Null) => Ok(SubagentContextMode::Fresh),
            Some(value) => {
                let fork_context = value.as_bool().ok_or_else(|| {
                    OpenBitFunError::tool("fork_context must be a boolean".to_string())
                })?;
                Ok(if fork_context {
                    SubagentContextMode::Fork
                } else {
                    SubagentContextMode::Fresh
                })
            }
        }
    }

    pub(super) fn invalid_input(message: impl Into<String>) -> ValidationResult {
        ValidationResult {
            result: false,
            message: Some(message.into()),
            error_code: None,
            meta: None,
        }
    }

    pub(super) fn validate_prompt_size(input: &Value) -> Option<ValidationResult> {
        Self::validate_prompt_size_for_tool(input, "AgentSpawn")
    }

    pub(super) fn validate_prompt_size_for_tool(
        input: &Value,
        tool_name: &str,
    ) -> Option<ValidationResult> {
        let prompt = input.get("prompt").and_then(Value::as_str)?;
        let line_count = prompt.lines().count();
        let byte_count = prompt.len();
        if line_count <= LARGE_TASK_PROMPT_SOFT_LINE_LIMIT
            && byte_count <= LARGE_TASK_PROMPT_SOFT_BYTE_LIMIT
        {
            return None;
        }

        let message = if tool_name == "AgentSpawn" {
            format!(
                "Large AgentSpawn prompt: {} lines, {} bytes. This is allowed when necessary, but prefer staged delegation: split large work into multiple AgentSpawn calls with clear ownership, and pass file paths, symbols, constraints, and exact questions instead of large pasted context.",
                line_count, byte_count
            )
        } else {
            format!(
                "Large {tool_name} prompt: {} lines, {} bytes. This is allowed when necessary, but prefer staged delegation: split large work into smaller agent turns with clear ownership, and pass file paths, symbols, constraints, and exact questions instead of large pasted context.",
                line_count, byte_count
            )
        };

        Some(ValidationResult {
            result: true,
            message: Some(message),
            error_code: None,
            meta: Some(json!({
                "large_task_prompt": true,
                "line_count": line_count,
                "byte_count": byte_count,
                "soft_line_limit": LARGE_TASK_PROMPT_SOFT_LINE_LIMIT,
                "soft_byte_limit": LARGE_TASK_PROMPT_SOFT_BYTE_LIMIT
            })),
        })
    }

    pub(super) fn is_deep_review_context(context: Option<&ToolUseContext>) -> bool {
        let Some(context) = context else {
            return false;
        };
        match context.agent_type.as_deref().map(str::trim) {
            Some(DEEP_REVIEW_AGENT_TYPE) => true,
            Some("CodeReview") => context
                .custom_data
                .get("deep_review_run_manifest")
                .is_some_and(is_adaptive_review_manifest),
            _ => false,
        }
    }

    pub(super) fn has_deep_review_retry_fields(input: &Value) -> bool {
        input.get("retry").is_some()
            || input.get("auto_retry").is_some()
            || input.get("retry_coverage").is_some()
    }

    pub(super) fn ensure_delegation_allowed(context: &ToolUseContext) -> OpenBitFunResult<()> {
        let delegation_policy = context.delegation_policy();
        if delegation_policy.allow_subagent_spawn {
            return Ok(());
        }

        Err(OpenBitFunError::tool(
            "Recursive subagent delegation is blocked. Use direct tools instead.".to_string(),
        ))
    }
}
