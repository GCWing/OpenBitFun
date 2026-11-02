//! Built-in model tool handlers for persisted session thread goals.

use crate::agentic::coordination::get_global_coordinator;
use crate::agentic::goal_mode::user_facing_thread_goal_error;
use crate::agentic::tools::framework::{Tool, ToolResult, ToolUseContext};
use crate::service_agent_runtime::CoreServiceAgentRuntime;
use crate::util::errors::{OpenBitFunError, OpenBitFunResult};
use async_trait::async_trait;
use openbitfun_agent_runtime::sdk::RuntimeError;
use openbitfun_agent_runtime::thread_goal_tools::{
    build_goal_tool_result, parse_create_goal_args, parse_update_goal_args,
    parse_update_goal_status, CREATE_GOAL_TOOL_NAME, GET_GOAL_TOOL_NAME, UPDATE_GOAL_TOOL_NAME,
};
use openbitfun_runtime_ports::{
    AgentThreadGoalCreateRequest, AgentThreadGoalGetRequest, AgentThreadGoalUpdateStatusRequest,
    PortError, PortErrorKind, ThreadGoalStatus,
};
use serde_json::{json, Value};

fn require_agent_runtime() -> OpenBitFunResult<openbitfun_agent_runtime::sdk::AgentRuntime> {
    let coordinator = get_global_coordinator()
        .ok_or_else(|| OpenBitFunError::Validation("coordinator is unavailable".to_string()))?;
    CoreServiceAgentRuntime::agent_runtime(coordinator).map_err(OpenBitFunError::tool)
}

fn require_session_context(
    context: &ToolUseContext,
) -> OpenBitFunResult<(String, std::path::PathBuf)> {
    let session_id = context
        .session_id
        .clone()
        .ok_or_else(|| OpenBitFunError::Validation("session_id is unavailable".to_string()))?;
    let workspace_path = context
        .workspace_root()
        .ok_or_else(|| OpenBitFunError::Validation("workspace_path is unavailable".to_string()))?
        .to_path_buf();
    Ok((session_id, workspace_path))
}

fn thread_goal_runtime_error(error: RuntimeError) -> OpenBitFunError {
    match error {
        RuntimeError::Port(port_error) => thread_goal_port_error(port_error),
        other => user_facing_thread_goal_error(OpenBitFunError::Tool(
            CoreServiceAgentRuntime::runtime_error_message(other),
        )),
    }
}

fn thread_goal_output_schema() -> Value {
    json!({
        "type": "object",
        "properties": {
            "goal": {
                "anyOf": [
                    {"type": "null"},
                    {"type": "object", "properties": {"status": {"type": "string"}}, "required": ["status"], "additionalProperties": false}
                ]
            }
        },
        "additionalProperties": false
    })
}

fn thread_goal_port_error(port_error: PortError) -> OpenBitFunError {
    match port_error.kind {
        PortErrorKind::InvalidRequest => OpenBitFunError::Validation(port_error.message),
        PortErrorKind::NotFound => OpenBitFunError::NotFound(port_error.message),
        PortErrorKind::Cancelled => {
            user_facing_thread_goal_error(OpenBitFunError::Cancelled(port_error.message))
        }
        PortErrorKind::Timeout => {
            user_facing_thread_goal_error(OpenBitFunError::Timeout(port_error.message))
        }
        PortErrorKind::NotAvailable => {
            user_facing_thread_goal_error(OpenBitFunError::NotImplemented(port_error.message))
        }
        PortErrorKind::OutcomeUnknown => {
            user_facing_thread_goal_error(OpenBitFunError::OutcomeUnknown(port_error.message))
        }
        PortErrorKind::PermissionDenied
        | PortErrorKind::SessionInUse
        | PortErrorKind::CleanupRequired
        | PortErrorKind::Backend => {
            user_facing_thread_goal_error(OpenBitFunError::Tool(port_error.message))
        }
    }
}

pub struct GetGoalTool;

impl GetGoalTool {
    pub fn new() -> Self {
        Self
    }
}

impl Default for GetGoalTool {
    fn default() -> Self {
        Self::new()
    }
}

#[async_trait]
impl Tool for GetGoalTool {
    fn name(&self) -> &str {
        GET_GOAL_TOOL_NAME
    }

    async fn description(&self) -> OpenBitFunResult<String> {
        Ok("Get the current goal for this session, including status, budgets, token and elapsed-time usage, and remaining token budget.".to_string())
    }

    fn short_description(&self) -> String {
        "Read the active session thread goal.".to_string()
    }

    fn input_schema(&self) -> Value {
        json!({
            "type": "object",
            "additionalProperties": false,
            "properties": {}
        })
    }

    fn output_schema(&self) -> Value {
        thread_goal_output_schema()
    }

    fn is_readonly(&self) -> bool {
        true
    }

    async fn call_impl(
        &self,
        _input: &Value,
        context: &ToolUseContext,
    ) -> OpenBitFunResult<Vec<ToolResult>> {
        let runtime = require_agent_runtime()?;
        let (session_id, workspace_path) = require_session_context(context)?;
        let remote_connection_id = context
            .workspace
            .as_ref()
            .and_then(|workspace| workspace.connection_id())
            .map(ToOwned::to_owned);
        let remote_ssh_host = context.workspace.as_ref().and_then(|workspace| {
            workspace
                .is_remote()
                .then(|| workspace.session_identity.hostname.trim().to_string())
                .filter(|host| !host.is_empty() && host != "_unresolved")
        });
        let goal = runtime
            .get_thread_goal(AgentThreadGoalGetRequest {
                session_id,
                workspace_path: workspace_path.to_string_lossy().into_owned(),
                remote_connection_id,
                remote_ssh_host,
            })
            .await
            .map_err(thread_goal_runtime_error)?;
        let result = build_goal_tool_result(goal, false)
            .map_err(|error| OpenBitFunError::Validation(error.to_string()))?;
        Ok(vec![ToolResult::Result {
            data: result.data,
            result_for_assistant: Some(result.result_for_assistant),
            image_attachments: None,
        }])
    }
}

pub struct CreateGoalTool;

impl CreateGoalTool {
    pub fn new() -> Self {
        Self
    }
}

impl Default for CreateGoalTool {
    fn default() -> Self {
        Self::new()
    }
}

#[async_trait]
impl Tool for CreateGoalTool {
    fn name(&self) -> &str {
        CREATE_GOAL_TOOL_NAME
    }

    async fn description(&self) -> OpenBitFunResult<String> {
        Ok(format!(
            "Create a goal only when explicitly requested by the user or system/developer instructions; do not infer goals from ordinary tasks. \
Set token_budget only when an explicit token budget is requested. Fails if a goal exists; use {UPDATE_GOAL_TOOL_NAME} only for status."
        ))
    }

    fn short_description(&self) -> String {
        "Start a new active session thread goal.".to_string()
    }

    fn input_schema(&self) -> Value {
        json!({
            "type": "object",
            "additionalProperties": false,
            "required": ["objective"],
            "properties": {
                "objective": {
                    "type": "string",
                    "description": "Required. The concrete objective to start pursuing. This starts a new active goal only when no goal is currently defined; if a goal already exists, this tool fails."
                },
                "token_budget": {
                    "type": "integer",
                    "description": "Positive token budget for the new goal. Omit unless explicitly requested."
                }
            }
        })
    }

    fn output_schema(&self) -> Value {
        thread_goal_output_schema()
    }

    async fn call_impl(
        &self,
        input: &Value,
        context: &ToolUseContext,
    ) -> OpenBitFunResult<Vec<ToolResult>> {
        let parsed = parse_create_goal_args(input.clone())
            .map_err(|error| OpenBitFunError::Validation(error.to_string()))?;
        let runtime = require_agent_runtime()?;
        let (session_id, workspace_path) = require_session_context(context)?;
        let goal = runtime
            .create_thread_goal(AgentThreadGoalCreateRequest {
                session_id,
                workspace_path: workspace_path.to_string_lossy().into_owned(),
                objective: parsed.objective,
                token_budget: parsed.token_budget,
            })
            .await
            .map_err(thread_goal_runtime_error)?;
        let result = build_goal_tool_result(Some(goal), false)
            .map_err(|error| OpenBitFunError::Validation(error.to_string()))?;
        Ok(vec![ToolResult::Result {
            data: result.data,
            result_for_assistant: Some(result.result_for_assistant),
            image_attachments: None,
        }])
    }
}

pub struct UpdateGoalTool;

impl UpdateGoalTool {
    pub fn new() -> Self {
        Self
    }
}

impl Default for UpdateGoalTool {
    fn default() -> Self {
        Self::new()
    }
}

#[async_trait]
impl Tool for UpdateGoalTool {
    fn name(&self) -> &str {
        UPDATE_GOAL_TOOL_NAME
    }

    async fn description(&self) -> OpenBitFunResult<String> {
        Ok(
            "Update the existing goal. Use only to mark the goal achieved or genuinely blocked. \
Set status to complete only when current evidence verifies the full objective, subsequent user requirements, and requested delivery; no required work may remain. \
Set status to blocked only when the same blocking condition has repeated for at least three consecutive goal turns and the agent cannot make meaningful progress without user input or an external-state change. \
After an explicit resume, begin a fresh blocked audit. Do not repeat failed side effects merely to count turns. You cannot use this tool to pause, resume, budget-limit, or usage-limit a goal."
                .to_string(),
        )
    }

    fn short_description(&self) -> String {
        "Mark the session thread goal complete or blocked.".to_string()
    }

    fn input_schema(&self) -> Value {
        json!({
            "type": "object",
            "additionalProperties": false,
            "required": ["status"],
            "properties": {
                "status": {
                    "type": "string",
                    "enum": ["complete", "blocked"],
                    "description": "Required. Set to complete only when the objective is achieved. Set to blocked only after the strict blocked audit is satisfied."
                }
            }
        })
    }

    fn output_schema(&self) -> Value {
        thread_goal_output_schema()
    }

    async fn call_impl(
        &self,
        input: &Value,
        context: &ToolUseContext,
    ) -> OpenBitFunResult<Vec<ToolResult>> {
        let parsed = parse_update_goal_args(input.clone())
            .map_err(|error| OpenBitFunError::Validation(error.to_string()))?;
        let status = parse_update_goal_status(&parsed.status)
            .map_err(|error| OpenBitFunError::Validation(error.to_string()))?;
        let runtime = require_agent_runtime()?;
        let (session_id, workspace_path) = require_session_context(context)?;
        let goal = runtime
            .update_thread_goal_status(AgentThreadGoalUpdateStatusRequest {
                session_id,
                workspace_path: workspace_path.to_string_lossy().into_owned(),
                status,
                turn_id: context.dialog_turn_id.clone(),
            })
            .await
            .map_err(thread_goal_runtime_error)?;
        let include_report = status == ThreadGoalStatus::Complete;
        let result = build_goal_tool_result(Some(goal), include_report)
            .map_err(|error| OpenBitFunError::Validation(error.to_string()))?;
        Ok(vec![ToolResult::Result {
            data: result.data,
            result_for_assistant: Some(result.result_for_assistant),
            image_attachments: None,
        }])
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn thread_goal_port_error_preserves_user_facing_policy() {
        let invalid = thread_goal_port_error(PortError::new(
            PortErrorKind::InvalidRequest,
            "missing objective",
        ));
        let not_found = thread_goal_port_error(PortError::new(
            PortErrorKind::NotFound,
            "thread goal not found",
        ));
        let timeout = thread_goal_port_error(PortError::new(PortErrorKind::Timeout, "store lag"));

        assert!(matches!(
            invalid,
            OpenBitFunError::Validation(message) if message == "missing objective"
        ));
        assert!(matches!(
            not_found,
            OpenBitFunError::NotFound(message) if message == "thread goal not found"
        ));
        assert!(matches!(
            timeout,
            OpenBitFunError::Validation(message)
                if message == "Thread goal operation failed. Check session state and try again."
        ));
    }
}
