use crate::agentic::coordination::get_global_coordinator;
use crate::agentic::tools::framework::{
    PermissionIntent, Tool, ToolRenderOptions, ToolResult, ToolUseContext, ValidationResult,
};
use crate::util::errors::{OpenBitFunError, OpenBitFunResult};
use async_trait::async_trait;
use serde_json::{json, Value};

pub struct AgentListTool;

impl Default for AgentListTool {
    fn default() -> Self {
        Self::new()
    }
}

impl AgentListTool {
    pub fn new() -> Self {
        Self
    }

    async fn list_agents(
        coordinator: &crate::agentic::coordination::ConversationCoordinator,
        session_id: &str,
        include_reserved: bool,
    ) -> OpenBitFunResult<Vec<ToolResult>> {
        let agents = coordinator.direct_child_agents(session_id).await?;
        let mut assistant_text = format!("Found {} direct child agent(s).", agents.len());
        for agent in &agents {
            assistant_text.push_str(&format!(
                "\n- {}: {}",
                agent.agent_id,
                agent.status.as_str()
            ));
        }
        let agents = agents
            .into_iter()
            .map(|agent| {
                json!({
                    "agent_id": agent.agent_id,
                    "status": agent.status.as_str(),
                })
            })
            .collect::<Vec<_>>();
        let mut data = json!({ "agents": agents });
        if include_reserved {
            let reserved_ids = coordinator.reserved_agent_ids(session_id).await?;
            assistant_text.push_str(&format!(
                "\n\nReserved IDs without active agents ({}):",
                reserved_ids.len()
            ));
            for agent_id in &reserved_ids {
                assistant_text.push_str(&format!("\n- {agent_id}"));
            }
            assistant_text
                .push_str("\n\nAll reserved IDs listed above are unavailable for AgentSpawn.");
            data["reserved_agent_ids"] = json!(reserved_ids);
        }
        Ok(vec![ToolResult::Result {
            data,
            result_for_assistant: Some(assistant_text),
            image_attachments: None,
        }])
    }

    fn validate_request(input: &Value, context: Option<&ToolUseContext>) -> OpenBitFunResult<bool> {
        let object = input.as_object().ok_or_else(|| {
            OpenBitFunError::tool("AgentList input must be an object".to_string())
        })?;
        if let Some(field) = object
            .keys()
            .find(|field| field.as_str() != "include_reserved")
        {
            return Err(OpenBitFunError::tool(format!(
                "AgentList does not accept field '{field}'"
            )));
        }
        let _ = context;
        match object.get("include_reserved") {
            None => Ok(false),
            Some(Value::Bool(include_reserved)) => Ok(*include_reserved),
            Some(_) => Err(OpenBitFunError::tool(
                "include_reserved must be a boolean".to_string(),
            )),
        }
    }
}

#[async_trait]
impl Tool for AgentListTool {
    fn name(&self) -> &str {
        "AgentList"
    }

    async fn description(&self) -> OpenBitFunResult<String> {
        Ok("List direct child agents and their latest status.".to_string())
    }

    fn short_description(&self) -> String {
        "List direct child agents and their status.".to_string()
    }

    fn input_schema(&self) -> Value {
        json!({
            "type": "object",
            "properties": {
                "include_reserved": {
                    "type": "boolean",
                    "description": "Defaults to false. Set to true to also return reserved historical IDs (which cannot be reused for AgentSpawn)."
                }
            },
            "additionalProperties": false
        })
    }

    fn output_schema(&self) -> Value {
        json!({
            "type": "object",
            "properties": {
                "agents": {
                    "type": "array",
                    "items": {
                        "type": "object",
                        "properties": {
                            "agent_id": {"type": "string"},
                            "status": {"type": "string"}
                        },
                        "required": ["agent_id", "status"],
                        "additionalProperties": false
                    }
                },
                "reserved_agent_ids": {"type": "array", "items": {"type": "string"}}
            },
            "required": ["agents"],
            "additionalProperties": false
        })
    }

    fn is_readonly(&self) -> bool {
        true
    }

    fn permission_intents(
        &self,
        _input: &Value,
        _context: &ToolUseContext,
    ) -> OpenBitFunResult<Vec<PermissionIntent>> {
        Ok(Vec::new())
    }

    fn render_tool_use_message(&self, _input: &Value, _options: &ToolRenderOptions) -> String {
        "Listing child agents".to_string()
    }

    async fn validate_input(
        &self,
        input: &Value,
        context: Option<&ToolUseContext>,
    ) -> ValidationResult {
        match Self::validate_request(input, context) {
            Ok(_) => ValidationResult::default(),
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
        let include_reserved = Self::validate_request(input, Some(context))?;
        let session_id = context.session_id.as_deref().ok_or_else(|| {
            OpenBitFunError::tool("session_id is required in context".to_string())
        })?;
        let coordinator = get_global_coordinator()
            .ok_or_else(|| OpenBitFunError::tool("coordinator not initialized".to_string()))?;
        Self::list_agents(&coordinator, session_id, include_reserved).await
    }
}

#[cfg(test)]
mod tests {
    use super::AgentListTool;
    use crate::agentic::tools::framework::{Tool, ToolResult, ToolUseContext};
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

    #[tokio::test]
    async fn agent_list_model_output_contains_child_ids_and_statuses() {
        use crate::agentic::coordination::coordinator::tests::{
            agent_lifecycle_child, test_coordinator,
        };
        let workspace = tempfile::tempdir().unwrap();
        crate::service::workspace::legacy_compat::register_local_fixture_blocking(workspace.path());
        let (coordinator, _) = test_coordinator();
        for _ in 0..2 {
            agent_lifecycle_child(&coordinator, workspace.path(), "parent", Default::default())
                .await;
        }
        for parent in ["parent", "empty-parent"] {
            let result = AgentListTool::list_agents(&coordinator, parent, false)
                .await
                .unwrap()
                .remove(0);
            let ToolResult::Result {
                data,
                result_for_assistant,
                ..
            } = result
            else {
                panic!("expected list result");
            };
            let model_text = result_for_assistant.expect("AgentList must render model-facing text");
            let agents = data["agents"].as_array().unwrap();
            assert!(data.get("reserved_agent_ids").is_none());
            assert_eq!(agents.len(), if parent == "parent" { 2 } else { 0 });
            assert!(model_text.contains(&format!("Found {} direct child agent(s).", agents.len())));
            assert!(
                !model_text.trim_start().starts_with('{'),
                "model output must be readable text, not raw JSON"
            );
            for agent in agents {
                let agent_id = agent["agent_id"].as_str().unwrap();
                let status = agent["status"].as_str().unwrap();
                assert!(
                    model_text
                        .lines()
                        .skip(1)
                        .any(|line| line.contains(agent_id) && line.contains(status)),
                    "model output must identify each agent and its status: {model_text}"
                );
            }
        }
    }

    #[tokio::test]
    async fn include_reserved_is_optional_and_rejects_invalid_inputs() {
        let tool = AgentListTool::new();
        let schema = tool.input_schema();
        assert_eq!(schema["properties"]["include_reserved"]["type"], "boolean");
        assert_eq!(schema["additionalProperties"], false);
        assert!(schema.get("required").is_none());
        for (input, expected) in [
            (serde_json::json!({}), false),
            (serde_json::json!({"include_reserved": false}), false),
            (serde_json::json!({"include_reserved": true}), true),
        ] {
            assert_eq!(
                AgentListTool::validate_request(&input, None).unwrap(),
                expected
            );
            assert!(
                tool.validate_input(&input, Some(&context("Standard")))
                    .await
                    .result
            );
        }
        for input in [
            serde_json::json!({"include_reserved": null}),
            serde_json::json!({"include_reserved": "true"}),
            serde_json::json!({"include_reserved": 1}),
            serde_json::json!({"include_reserved": true, "other": false}),
            serde_json::json!([]),
        ] {
            assert!(!tool.validate_input(&input, None).await.result);
        }
    }

    #[tokio::test]
    async fn include_reserved_lists_deleted_ids_separately_without_restoring_sessions() {
        use crate::agentic::coordination::coordinator::tests::{
            agent_lifecycle_child, test_coordinator,
        };
        use crate::agentic::core::SessionConfig;
        let workspace = tempfile::tempdir().unwrap();
        crate::service::workspace::legacy_compat::register_local_fixture_blocking(workspace.path());
        let (coordinator, manager) = test_coordinator();
        let parent = manager
            .create_session(
                "Parent".into(),
                "Standard".into(),
                SessionConfig {
                    tool_presentation_mode: Default::default(),
                    workspace_path: Some(workspace.path().to_string_lossy().into_owned()),
                    ..Default::default()
                },
            )
            .await
            .unwrap();
        let child = agent_lifecycle_child(
            &coordinator,
            workspace.path(),
            &parent.session_id,
            Default::default(),
        )
        .await;
        let deleted_id = coordinator
            .existing_agent_id_for_subagent_session(&parent.session_id, &child.session_id)
            .await
            .unwrap()
            .unwrap();
        coordinator
            .delete_direct_child_agents(&parent.session_id, &[deleted_id.clone()])
            .await
            .unwrap();
        let active = agent_lifecycle_child(
            &coordinator,
            workspace.path(),
            &parent.session_id,
            Default::default(),
        )
        .await;
        let active_id = coordinator
            .existing_agent_id_for_subagent_session(&parent.session_id, &active.session_id)
            .await
            .unwrap()
            .unwrap();
        for include_reserved in [false, true] {
            let result =
                AgentListTool::list_agents(&coordinator, &parent.session_id, include_reserved)
                    .await
                    .unwrap()
                    .remove(0);
            let ToolResult::Result {
                data,
                result_for_assistant,
                ..
            } = result
            else {
                panic!("expected list result")
            };
            assert_eq!(
                data["agents"],
                serde_json::json!([{"agent_id": active_id, "status": "completed"}])
            );
            let text = result_for_assistant.unwrap();
            assert!(text.contains(&active_id));
            if include_reserved {
                assert_eq!(data["reserved_agent_ids"], serde_json::json!([deleted_id]));
                assert!(text.contains("Reserved IDs without active agents (1):"));
                assert!(text.contains(&deleted_id));
                assert!(
                    text.contains("All reserved IDs listed above are unavailable for AgentSpawn.")
                );
            } else {
                assert!(data.get("reserved_agent_ids").is_none());
                assert!(!text.contains(&deleted_id));
            }
            assert!(manager.get_session(&child.session_id).is_none());
        }
        let result = AgentListTool::list_agents(&coordinator, "empty-parent", true)
            .await
            .unwrap()
            .remove(0);
        let ToolResult::Result {
            data,
            result_for_assistant,
            ..
        } = result
        else {
            panic!("expected list result")
        };
        assert_eq!(
            data,
            serde_json::json!({"agents": [], "reserved_agent_ids": []})
        );
        assert!(result_for_assistant
            .unwrap()
            .contains("Reserved IDs without active agents (0):"));
    }
}
