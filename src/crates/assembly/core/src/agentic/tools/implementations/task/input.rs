use super::*;

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub(super) enum TaskAction {
    Spawn,
    SendInput,
    Cancel,
}

impl TaskAction {
    pub(super) fn parse(value: &Value) -> OpenBitFunResult<Self> {
        let action = match value
            .get("action")
            .and_then(Value::as_str)
            .map(str::trim)
            .filter(|action| !action.is_empty())
        {
            Some(action) => action,
            None => {
                return Self::infer_from_input(value)
                    .ok_or_else(|| OpenBitFunError::tool("action is required".to_string()))
            }
        };

        match action {
            "spawn" => Ok(Self::Spawn),
            "send_input" => Ok(Self::SendInput),
            "cancel" => Ok(Self::Cancel),
            other => Err(OpenBitFunError::tool(format!(
                "action must be one of: spawn, send_input, cancel; got '{}'",
                other
            ))),
        }
    }

    fn infer_from_input(value: &Value) -> Option<Self> {
        let has_prompt = value.get("prompt").is_some();
        if !has_prompt {
            return None;
        }

        let has_agent_id = value
            .get("agent_id")
            .and_then(Value::as_str)
            .is_some_and(|agent_id| !agent_id.trim().is_empty());
        let has_subagent_type = value
            .get("subagent_type")
            .and_then(Value::as_str)
            .is_some_and(|subagent_type| !subagent_type.trim().is_empty());
        let has_fork_context = value
            .get("fork_context")
            .and_then(Value::as_bool)
            .unwrap_or(false);

        if has_agent_id && (has_subagent_type || has_fork_context) {
            return Some(Self::Spawn);
        }
        if has_agent_id && !has_subagent_type && !has_fork_context {
            return Some(Self::SendInput);
        }

        None
    }

    pub(super) fn as_str(self) -> &'static str {
        match self {
            Self::Spawn => "spawn",
            Self::SendInput => "send_input",
            Self::Cancel => "cancel",
        }
    }
}

#[derive(Debug, Clone)]
pub(super) struct TaskInvocation {
    pub(super) action: TaskAction,
    pub(super) requested_agent_id: Option<String>,
    pub(super) description: Option<String>,
    pub(super) prompt: Option<String>,
    pub(super) context_mode: SubagentContextMode,
    pub(super) target_agent_id: Option<String>,
    pub(super) subagent_type: Option<String>,
    pub(super) model_id: Option<String>,
    pub(super) inherit_parent_model: bool,
    pub(super) timeout_seconds: Option<u64>,
    pub(super) run_in_background: bool,
    pub(super) is_retry: bool,
    pub(super) requested_auto_retry: bool,
    pub(super) cancel_descendants: bool,
}

impl AgentExecutionTool {
    pub(super) fn parse_invocation(
        input: &Value,
        is_deep_review_parent: bool,
    ) -> OpenBitFunResult<TaskInvocation> {
        if input.get("workspace_path").is_some() {
            return Err(OpenBitFunError::tool(
                "workspace_path is no longer supported; subagents inherit the current workspace. Put any non-current target path in the prompt."
                    .to_string(),
            ));
        }

        if is_deep_review_parent {
            if input.get("action").is_some() {
                return Err(OpenBitFunError::tool(
                    "action is not supported for DeepReview AgentSpawn calls".to_string(),
                ));
            }
            for field in ["fork_context", "agent_id", "run_in_background"] {
                if input.get(field).is_some() {
                    return Err(OpenBitFunError::tool(format!(
                        "{field} is not allowed for DeepReview AgentSpawn calls"
                    )));
                }
            }

            let (model_id, inherit_parent_model) = Self::optional_model_id(input)?;

            return Ok(TaskInvocation {
                action: TaskAction::Spawn,
                requested_agent_id: None,
                description: Self::string_field(
                    input,
                    "description",
                    "DeepReview AgentSpawn calls",
                )?,
                prompt: Self::string_field(input, "prompt", "DeepReview AgentSpawn calls")?,
                context_mode: SubagentContextMode::Fresh,
                target_agent_id: None,
                subagent_type: Self::string_field(
                    input,
                    "subagent_type",
                    "DeepReview AgentSpawn calls",
                )?,
                model_id,
                inherit_parent_model,
                timeout_seconds: Self::optional_timeout_seconds(input)?,
                run_in_background: false,
                is_retry: input.get("retry").and_then(Value::as_bool).unwrap_or(false),
                requested_auto_retry: input
                    .get("auto_retry")
                    .and_then(Value::as_bool)
                    .unwrap_or(false),
                cancel_descendants: false,
            });
        }

        let action = TaskAction::parse(input)?;
        if input.get("description").is_some() {
            return Err(OpenBitFunError::tool(
                "description is not supported; put the complete task instruction in prompt"
                    .to_string(),
            ));
        }
        if input.get("requested_agent_id").is_some() {
            return Err(OpenBitFunError::tool(
                "requested_agent_id is not supported; use agent_id".to_string(),
            ));
        }
        if Self::has_deep_review_retry_fields(input) {
            return Err(OpenBitFunError::tool(
                "DeepReview retry fields are only allowed for DeepReview AgentSpawn calls"
                    .to_string(),
            ));
        }
        if input.get("timeout_seconds").is_some() {
            return Err(OpenBitFunError::tool(
                "timeout_seconds is only allowed for DeepReview AgentSpawn calls".to_string(),
            ));
        }
        let run_in_background = Self::optional_bool(input, "run_in_background")?.unwrap_or(false);

        match action {
            TaskAction::Spawn => {
                let requested_agent_id = Self::required_agent_id_for_action(input, action)?;
                let prompt = Self::required_string_for_action(input, "prompt", action)?;
                let subagent_type = Self::optional_trimmed_string(input, "subagent_type")?;
                let context_mode = Self::context_mode_from_input(input)?;
                match context_mode {
                    SubagentContextMode::Fresh => {
                        if subagent_type.is_none() {
                            return Err(OpenBitFunError::tool(
                                "subagent_type is required when action is spawn and fork_context is false or omitted"
                                    .to_string(),
                            ));
                        }
                    }
                    SubagentContextMode::Fork => {
                        if subagent_type.is_some() {
                            return Err(OpenBitFunError::tool(
                                "subagent_type cannot be combined with fork_context=true when action is spawn; use either subagent_type for a fresh subagent or fork_context=true to inherit the current context."
                                    .to_string(),
                            ));
                        }
                        Self::ensure_fields_absent(
                            input,
                            &["retry", "auto_retry", "retry_coverage"],
                            action,
                        )?;
                    }
                }

                let (model_id, inherit_parent_model) = Self::optional_model_id(input)?;

                Ok(TaskInvocation {
                    action,
                    requested_agent_id: Some(requested_agent_id),
                    description: None,
                    prompt: Some(prompt),
                    context_mode,
                    target_agent_id: None,
                    subagent_type,
                    model_id,
                    inherit_parent_model,
                    timeout_seconds: None,
                    run_in_background,
                    is_retry: false,
                    requested_auto_retry: false,
                    cancel_descendants: false,
                })
            }
            TaskAction::SendInput => {
                let target_agent_id = Self::required_agent_id_for_action(input, action)?;
                let prompt = Self::required_string_for_action(input, "prompt", action)?;
                Self::ensure_fields_absent(
                    input,
                    &[
                        "fork_context",
                        "subagent_type",
                        "retry",
                        "auto_retry",
                        "retry_coverage",
                    ],
                    action,
                )?;

                let (model_id, inherit_parent_model) = Self::optional_model_id(input)?;

                Ok(TaskInvocation {
                    action,
                    requested_agent_id: None,
                    description: None,
                    prompt: Some(prompt),
                    context_mode: SubagentContextMode::Fresh,
                    target_agent_id: Some(target_agent_id),
                    subagent_type: None,
                    model_id,
                    inherit_parent_model,
                    timeout_seconds: None,
                    run_in_background,
                    is_retry: false,
                    requested_auto_retry: false,
                    cancel_descendants: false,
                })
            }
            TaskAction::Cancel => {
                let target_agent_id = Self::required_agent_id_for_action(input, action)?;
                let cancel_descendants =
                    Self::optional_bool(input, "cancel_descendants")?.unwrap_or(true);
                Self::ensure_fields_absent(
                    input,
                    &[
                        "prompt",
                        "fork_context",
                        "subagent_type",
                        "model_id",
                        "run_in_background",
                        "retry",
                        "auto_retry",
                        "retry_coverage",
                    ],
                    action,
                )?;

                Ok(TaskInvocation {
                    action,
                    requested_agent_id: None,
                    description: None,
                    prompt: None,
                    context_mode: SubagentContextMode::Fresh,
                    target_agent_id: Some(target_agent_id),
                    subagent_type: None,
                    model_id: None,
                    inherit_parent_model: false,
                    timeout_seconds: None,
                    run_in_background: false,
                    is_retry: false,
                    requested_auto_retry: false,
                    cancel_descendants,
                })
            }
        }
    }

    pub(super) async fn validate_invocation_input(
        input: &Value,
        is_deep_review_parent: bool,
        workspace_root: Option<&std::path::Path>,
    ) -> ValidationResult {
        let invocation = match Self::parse_invocation(input, is_deep_review_parent) {
            Ok(invocation) => invocation,
            Err(error) => return Self::invalid_input(error.to_string()),
        };
        let _ = workspace_root;
        if invocation.action != TaskAction::Cancel {
            if let Some(result) = Self::validate_prompt_size(input) {
                return result;
            }
        }

        ValidationResult {
            result: true,
            message: None,
            error_code: None,
            meta: None,
        }
    }

    fn required_string_for_action(
        input: &Value,
        field: &str,
        action: TaskAction,
    ) -> OpenBitFunResult<String> {
        let value = Self::string_field(
            input,
            field,
            format!("action is {}", action.as_str()).as_str(),
        )?;
        value.ok_or_else(|| {
            OpenBitFunError::tool(format!(
                "{field} is required when action is {}",
                action.as_str()
            ))
        })
    }

    fn required_agent_id_for_action(input: &Value, action: TaskAction) -> OpenBitFunResult<String> {
        let agent_id = Self::required_string_for_action(input, "agent_id", action)?;
        let raw_agent_id = input
            .get("agent_id")
            .and_then(Value::as_str)
            .expect("required_string_for_action already verified agent_id is a string");
        crate::agentic::coordination::validate_agent_id(raw_agent_id)?;
        Ok(agent_id)
    }

    fn string_field(input: &Value, field: &str, context: &str) -> OpenBitFunResult<Option<String>> {
        match input.get(field) {
            None => Ok(None),
            Some(value) => {
                let value = value
                    .as_str()
                    .ok_or_else(|| OpenBitFunError::tool(format!("{field} must be a string")))?;
                let value = value.trim();
                if value.is_empty() {
                    return Err(OpenBitFunError::tool(format!(
                        "{field} is required for {context}"
                    )));
                }
                Ok(Some(value.to_string()))
            }
        }
    }

    fn optional_trimmed_string(input: &Value, field: &str) -> OpenBitFunResult<Option<String>> {
        match input.get(field) {
            None | Some(Value::Null) => Ok(None),
            Some(value) => {
                let value = value
                    .as_str()
                    .ok_or_else(|| OpenBitFunError::tool(format!("{field} must be a string")))?;
                let value = value.trim();
                Ok((!value.is_empty()).then(|| value.to_string()))
            }
        }
    }

    fn optional_model_id(input: &Value) -> OpenBitFunResult<(Option<String>, bool)> {
        match Self::optional_trimmed_string(input, "model_id")? {
            Some(model_id) if model_id == "inherit" => Ok((None, true)),
            model_id => Ok((model_id, false)),
        }
    }

    fn optional_bool(input: &Value, field: &str) -> OpenBitFunResult<Option<bool>> {
        match input.get(field) {
            None | Some(Value::Null) => Ok(None),
            Some(value) => value
                .as_bool()
                .map(Some)
                .ok_or_else(|| OpenBitFunError::tool(format!("{field} must be a boolean"))),
        }
    }

    fn optional_timeout_seconds(input: &Value) -> OpenBitFunResult<Option<u64>> {
        match input.get("timeout_seconds") {
            None => Ok(None),
            Some(value) => {
                let parsed = value.as_u64().ok_or_else(|| {
                    OpenBitFunError::tool(
                        "timeout_seconds must be a non-negative integer".to_string(),
                    )
                })?;
                Ok((parsed > 0).then_some(parsed))
            }
        }
    }

    fn ensure_fields_absent(
        input: &Value,
        fields: &[&str],
        action: TaskAction,
    ) -> OpenBitFunResult<()> {
        for field in fields {
            if Self::has_effective_value(input, field) {
                return Err(OpenBitFunError::tool(format!(
                    "{field} is not allowed when action is {}",
                    action.as_str()
                )));
            }
        }
        Ok(())
    }

    fn has_effective_value(input: &Value, field: &str) -> bool {
        // Some models serialize unused fields from this action-union schema as
        // null, an empty string, or false. Those values carry no action intent.
        match input.get(field) {
            None | Some(Value::Null) => false,
            Some(Value::String(value)) => !value.trim().is_empty(),
            Some(Value::Bool(value)) => *value,
            Some(_) => true,
        }
    }
}
