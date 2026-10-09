use crate::agentic::coordination::get_global_coordinator;
use crate::agentic::tools::framework::{
    PermissionIntent, Tool, ToolRenderOptions, ToolResult, ToolUseContext, ValidationResult,
};
use crate::util::errors::{OpenBitFunError, OpenBitFunResult};
use async_trait::async_trait;
use serde_json::{json, Value};
use std::collections::HashSet;

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum AgentControlAction {
    Interrupt,
    Delete,
}

impl AgentControlAction {
    fn parse(input: &Value) -> OpenBitFunResult<Self> {
        let action = input
            .get("action")
            .and_then(Value::as_str)
            .map(str::trim)
            .filter(|action| !action.is_empty())
            .ok_or_else(|| {
                OpenBitFunError::tool("action is required for AgentControl".to_string())
            })?;
        match action {
            "interrupt" => Ok(Self::Interrupt),
            "delete" => Ok(Self::Delete),
            other => Err(OpenBitFunError::tool(format!(
                "action must be one of: interrupt, delete; got '{other}'"
            ))),
        }
    }

    fn as_str(self) -> &'static str {
        match self {
            Self::Interrupt => "interrupt",
            Self::Delete => "delete",
        }
    }
}

pub struct AgentControlTool;

impl Default for AgentControlTool {
    fn default() -> Self {
        Self::new()
    }
}

impl AgentControlTool {
    pub fn new() -> Self {
        Self
    }

    fn parse_agent_ids(input: &Value) -> OpenBitFunResult<Vec<String>> {
        let object = input.as_object().ok_or_else(|| {
            OpenBitFunError::tool("AgentControl input must be an object".to_string())
        })?;
        if let Some(field) = object
            .keys()
            .find(|field| !matches!(field.as_str(), "action" | "agent_ids"))
        {
            return Err(OpenBitFunError::tool(format!(
                "AgentControl does not accept field '{field}'"
            )));
        }

        let values = match object.get("agent_ids") {
            Some(value @ Value::String(_)) => vec![value],
            Some(Value::Array(values)) => values.iter().collect(),
            Some(_) => {
                return Err(OpenBitFunError::tool(
                    "agent_ids must be an array of strings".to_string(),
                ));
            }
            None => {
                return Err(OpenBitFunError::tool(
                    "agent_ids is required for AgentControl".to_string(),
                ));
            }
        };

        let mut seen = HashSet::new();
        let mut agent_ids = Vec::new();
        for value in values {
            let agent_id = value
                .as_str()
                .map(str::trim)
                .filter(|agent_id| !agent_id.is_empty())
                .ok_or_else(|| {
                    OpenBitFunError::tool(
                        "agent_ids must contain only non-empty strings".to_string(),
                    )
                })?;
            if seen.insert(agent_id.to_string()) {
                agent_ids.push(agent_id.to_string());
            }
        }
        if agent_ids.is_empty() {
            return Err(OpenBitFunError::tool(
                "agent_ids must contain at least one agent ID".to_string(),
            ));
        }
        Ok(agent_ids)
    }

    fn parse_input(input: &Value) -> OpenBitFunResult<(AgentControlAction, Vec<String>)> {
        let action = AgentControlAction::parse(input)?;
        let agent_ids = Self::parse_agent_ids(input)?;
        Ok((action, agent_ids))
    }

    fn ensure_context_allowed(context: &ToolUseContext) -> OpenBitFunResult<()> {
        context.agent_type.as_deref().ok_or_else(|| {
            OpenBitFunError::tool("agent_type is required in context".to_string())
        })?;
        Ok(())
    }

    fn input_schema() -> Value {
        json!({
            "type": "object",
            "properties": {
                "action": {
                    "type": "string",
                    "enum": ["interrupt", "delete"],
                    "description": "The lifecycle action to apply to the selected agent subtrees. Both actions apply recursively to descendants."
                },
                "agent_ids": {
                    "type": "array",
                    "items": { "type": "string" },
                    "description": "Direct child agent IDs to interrupt or delete, including their descendant subtrees."
                }
            },
            "required": ["action", "agent_ids"],
            "additionalProperties": false
        })
    }
}

#[async_trait]
impl Tool for AgentControlTool {
    fn name(&self) -> &str {
        "AgentControl"
    }

    fn manages_own_execution_timeout(&self) -> bool {
        true
    }

    async fn description(&self) -> OpenBitFunResult<String> {
        Ok("Interrupt or permanently delete one or more direct child agents and their entire descendant subtrees. Both actions use cascading semantics; deletion cancels active work before removing sessions and pending results.".to_string())
    }

    fn short_description(&self) -> String {
        "Interrupt or delete agent subtrees recursively.".to_string()
    }

    fn input_schema(&self) -> Value {
        Self::input_schema()
    }

    fn is_readonly(&self) -> bool {
        false
    }

    fn permission_intents(
        &self,
        input: &Value,
        _context: &ToolUseContext,
    ) -> OpenBitFunResult<Vec<PermissionIntent>> {
        let (action, agent_ids) = Self::parse_input(input)?;
        let resources = agent_ids
            .into_iter()
            .map(|agent_id| format!("{}:{agent_id}", action.as_str()))
            .collect();
        Ok(vec![PermissionIntent::new("task", resources)])
    }

    fn render_tool_use_message(&self, input: &Value, _options: &ToolRenderOptions) -> String {
        match Self::parse_input(input) {
            Ok((AgentControlAction::Interrupt, agent_ids)) => {
                format!("Interrupting agent subtrees: {}", agent_ids.join(", "))
            }
            Ok((AgentControlAction::Delete, agent_ids)) => {
                format!("Deleting agent subtrees: {}", agent_ids.join(", "))
            }
            Err(_) => "Controlling agent subtrees".to_string(),
        }
    }

    async fn validate_input(
        &self,
        input: &Value,
        context: Option<&ToolUseContext>,
    ) -> ValidationResult {
        let result = Self::parse_input(input).and_then(|_| {
            if let Some(context) = context {
                Self::ensure_context_allowed(context)?;
            }
            Ok(())
        });
        match result {
            Ok(()) => ValidationResult::default(),
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
        Self::ensure_context_allowed(context)?;
        let (action, agent_ids) = Self::parse_input(input)?;
        let session_id = context.session_id.as_deref().ok_or_else(|| {
            OpenBitFunError::tool("session_id is required in context".to_string())
        })?;
        let coordinator = get_global_coordinator()
            .ok_or_else(|| OpenBitFunError::tool("coordinator not initialized".to_string()))?;

        match action {
            AgentControlAction::Interrupt => {
                let mut interrupted_background_tasks = 0usize;
                for agent_id in &agent_ids {
                    let target_session_id =
                        coordinator.resolve_agent_id(session_id, agent_id).await?;
                    interrupted_background_tasks += coordinator
                        .cancel_background_subagents_for_parent(
                            session_id,
                            &target_session_id,
                            true,
                        )
                        .await?;
                }
                Ok(vec![ToolResult::Result {
                    data: json!({
                        "action": "interrupt",
                        "status": "interrupted",
                        "agent_ids": agent_ids,
                        "cascade": true,
                        "interrupted_background_tasks": interrupted_background_tasks,
                    }),
                    result_for_assistant: Some(format!(
                        "Interrupted {interrupted_background_tasks} active background run(s) for agent subtrees: {}.",
                        agent_ids.join(", ")
                    )),
                    image_attachments: None,
                }])
            }
            AgentControlAction::Delete => {
                let deleted_agents = coordinator
                    .delete_direct_child_agents(session_id, &agent_ids)
                    .await?;
                Ok(vec![ToolResult::Result {
                    data: json!({
                        "action": "delete",
                        "status": "deleted",
                        "agent_ids": agent_ids,
                        "cascade": true,
                        "deleted_agents": deleted_agents,
                    }),
                    result_for_assistant: Some(format!(
                        "Permanently deleted the selected agent subtrees ({}) containing {deleted_agents} agent session(s).",
                        agent_ids.join(", ")
                    )),
                    image_attachments: None,
                }])
            }
        }
    }
}

#[cfg(test)]
mod tests {
    use super::AgentControlTool;
    use crate::agentic::tools::framework::{Tool, ToolUseContext};
    use crate::agentic::tools::ToolRuntimeRestrictions;
    use std::collections::HashMap;

    fn context(agent_type: &str) -> ToolUseContext {
        ToolUseContext {
            tool_call_id: Some("tool-call".to_string()),
            agent_type: Some(agent_type.to_string()),
            session_id: Some("session".to_string()),
            dialog_turn_id: Some("turn".to_string()),
            workspace: None,
            loaded_deferred_tool_specs: Vec::new(),
            primary_model_facts: tool_runtime::context::PrimaryModelFacts::default(),
            custom_data: HashMap::new(),
            computer_use_host: None,
            runtime_tool_restrictions: ToolRuntimeRestrictions::default(),
            runtime_handles: openbitfun_runtime_ports::ToolRuntimeHandles::default(),
        }
    }

    #[test]
    fn schema_uses_action_and_agent_ids_without_cascade_input() {
        let schema = AgentControlTool::new().input_schema();
        assert_eq!(
            schema["required"],
            serde_json::json!(["action", "agent_ids"])
        );
        assert!(schema["properties"].get("cascade").is_none());
    }

    #[test]
    fn permission_is_scoped_to_action_and_all_agents() {
        let intents = AgentControlTool::new()
            .permission_intents(
                &serde_json::json!({
                    "action": "delete",
                    "agent_ids": ["a2", "a3"]
                }),
                &context("Ultimate"),
            )
            .expect("permission intent");
        assert_eq!(intents.len(), 1);
        assert_eq!(intents[0].action, "task");
        assert_eq!(intents[0].resources, ["delete:a2", "delete:a3"]);
    }

    #[test]
    fn parser_tolerates_a_string_and_deduplicates_arrays() {
        assert_eq!(
            AgentControlTool::parse_agent_ids(&serde_json::json!({
                "action": "interrupt",
                "agent_ids": " a2 "
            }))
            .expect("single string"),
            ["a2"]
        );
        assert_eq!(
            AgentControlTool::parse_agent_ids(&serde_json::json!({
                "action": "delete",
                "agent_ids": ["a2", " a2 ", "a3"]
            }))
            .expect("deduplicated array"),
            ["a2", "a3"]
        );
    }

    #[tokio::test]
    async fn validation_accepts_non_planner_contexts() {
        let validation = AgentControlTool::new()
            .validate_input(
                &serde_json::json!({
                    "action": "delete",
                    "agent_ids": ["a1"]
                }),
                Some(&context("Standard")),
            )
            .await;
        assert!(validation.result);
    }
}
