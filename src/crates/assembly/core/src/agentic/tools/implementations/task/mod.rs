use crate::agentic::agents::{
    get_agent_registry, is_swarm_planner_agent_type, AgentInfo, SubagentListScope,
    SubagentQueryContext, SWARM_DELEGATE_AGENT_TYPES,
};
use crate::agentic::coordination::{get_global_coordinator, SubagentExecutionRequest};
use crate::agentic::deep_review::task_adapter::{
    self as deep_review_task_adapter, DeepReviewLaunchBatchInfo,
    DeepReviewProviderQueueWaitOutcome, DeepReviewQueueWaitOutcome, DeepReviewQueueWaitSkipReason,
};
use crate::agentic::deep_review_policy::{
    adaptive_review_max_focused_calls, deep_review_active_reviewer_count,
    deep_review_effective_parallel_instances, deep_review_has_judge_been_launched,
    deep_review_turn_elapsed_seconds, is_adaptive_review_manifest, is_review_worker_agent_type,
    load_default_deep_review_policy, record_deep_review_effective_concurrency_success,
    record_deep_review_runtime_auto_retry, record_deep_review_runtime_auto_retry_suppressed,
    record_deep_review_runtime_manual_retry, record_deep_review_task_budget_with_focus,
    DeepReviewActiveReviewerGuard, DeepReviewCapacityQueueReason, DeepReviewConcurrencyPolicy,
    DeepReviewExecutionPolicy, DeepReviewPolicyViolation, DeepReviewRunManifestGate,
    DeepReviewSubagentRole, FocusedReviewAssignment, FocusedReviewBudgetClaim,
    DEEP_REVIEW_AGENT_TYPE, REVIEW_WORKER_AGENT_TYPE,
};
use crate::agentic::events::DeepReviewQueueStatus;
use crate::agentic::tools::framework::{
    PermissionIntent, Tool, ToolRenderOptions, ToolResult, ToolUseContext, ValidationResult,
};
use crate::agentic::tools::pipeline::SubagentParentInfo;
use crate::service::config::global::GlobalConfigManager;
use crate::service::config::types::AIConfig;
use crate::util::errors::{OpenBitFunError, OpenBitFunResult};
use crate::util::timing::elapsed_ms_u64;
use async_trait::async_trait;
use input::{TaskAction, TaskInvocation};
use log::{debug, warn};
use openbitfun_runtime_ports::{PermissionRuntimeCeiling, SubagentContextMode};
use serde_json::{json, Map, Value};
use std::collections::HashMap;
use std::time::Instant;

mod agent_control;
mod background;
mod deep_review;
mod execution;
mod input;
mod launch_review_agent;
mod schema;
mod validation;

pub use launch_review_agent::LaunchReviewAgentTool;

pub struct TaskTool;
pub struct AgentSpawnTool;
pub struct AgentSendInputTool;
pub struct AgentInterruptTool;

const LARGE_TASK_PROMPT_SOFT_LINE_LIMIT: usize = 180;
const LARGE_TASK_PROMPT_SOFT_BYTE_LIMIT: usize = 16 * 1024;

impl Default for TaskTool {
    fn default() -> Self {
        Self::new()
    }
}

impl TaskTool {
    pub fn new() -> Self {
        Self
    }

    fn format_agent_descriptions(agents: &[AgentInfo]) -> String {
        if agents.is_empty() {
            return String::new();
        }
        let mut out = String::from("<available_agents>\n");
        for agent in agents {
            out.push_str(&format!(
                "<agent type=\"{}\">\n<description>\n{}\n</description>\n<tools>{}</tools>\n</agent>\n",
                agent.id,
                agent.description,
                agent.default_tools.join(", ")
            ));
        }
        out.push_str("</available_agents>");
        out
    }

    pub(crate) async fn build_available_agents_context_section(
        context: Option<&ToolUseContext>,
    ) -> Option<String> {
        if context
            .and_then(|context| context.agent_type.as_deref())
            .is_some_and(is_swarm_planner_agent_type)
        {
            return None;
        }
        let agents = Self::get_enabled_agents(context).await;
        let agent_descriptions = Self::format_agent_descriptions(&agents);
        if agent_descriptions.trim().is_empty() {
            None
        } else {
            Some(agent_descriptions)
        }
    }

    async fn get_enabled_agents(context: Option<&ToolUseContext>) -> Vec<AgentInfo> {
        let registry = get_agent_registry();
        let workspace_id = context.and_then(|ctx| ctx.workspace_id());
        let parent_agent_type = context.and_then(|ctx| ctx.agent_type.as_deref());
        registry.load_custom_agents(workspace_id).await;
        registry
            .get_subagents_for_query(&SubagentQueryContext {
                parent_agent_type,
                workspace_id,
                list_scope: SubagentListScope::TaskVisible,
                include_disabled: false,
                external_sources_supported: context.is_none_or(|ctx| !ctx.is_remote()),
            })
            .await
    }

    async fn get_agents_types(&self, context: Option<&ToolUseContext>) -> Vec<String> {
        if context
            .and_then(|context| context.agent_type.as_deref())
            .is_some_and(is_swarm_planner_agent_type)
        {
            return SWARM_DELEGATE_AGENT_TYPES
                .iter()
                .map(|agent_type| (*agent_type).to_string())
                .collect();
        }
        let mut agent_types: Vec<String> = Self::get_enabled_agents(context)
            .await
            .into_iter()
            .map(|agent| agent.id)
            .collect();
        // ReviewWorker stays hidden from ordinary CodeReview sessions. The
        // prepared adaptive manifest is the authority that admits the one
        // runtime worker reached through LaunchReviewAgent.
        if Self::is_deep_review_context(context)
            && !agent_types
                .iter()
                .any(|agent| agent == REVIEW_WORKER_AGENT_TYPE)
        {
            agent_types.push(REVIEW_WORKER_AGENT_TYPE.to_string());
        }
        agent_types
    }
}

#[async_trait]
impl Tool for TaskTool {
    fn name(&self) -> &str {
        "Task"
    }

    fn manages_own_execution_timeout(&self) -> bool {
        true
    }

    async fn description(&self) -> OpenBitFunResult<String> {
        Ok(self.render_description())
    }

    async fn is_available_in_context(&self, _context: Option<&ToolUseContext>) -> bool {
        // Keep Task prompt-visible even when no fresh subagents are currently
        // available. Hiding it based on transient subagent availability makes
        // the tool manifest drift across turns and causes provider prefix/KV
        // cache misses. Task also still supports `fork_context=true` in that
        // state, so removing it from the manifest would be behaviorally wrong.
        true
    }

    fn short_description(&self) -> String {
        "Delegate work to a subagent task and collect the result.".to_string()
    }

    async fn description_with_context(
        &self,
        _context: Option<&ToolUseContext>,
    ) -> OpenBitFunResult<String> {
        Ok(self.render_description())
    }

    fn input_schema(&self) -> Value {
        Self::regular_input_schema()
    }

    async fn input_schema_for_model_with_context(
        &self,
        _context: Option<&ToolUseContext>,
    ) -> Value {
        Self::regular_input_schema()
    }

    fn is_readonly(&self) -> bool {
        false
    }

    fn is_concurrency_safe(&self, input: Option<&Value>) -> bool {
        if input
            .and_then(|value| Self::context_mode_from_input(value).ok())
            .is_some_and(|mode| mode == SubagentContextMode::Fork)
        {
            return false;
        }
        let subagent_type = input
            .and_then(|v| v.get("subagent_type"))
            .and_then(|v| v.as_str());
        if subagent_type == Some("CodeReview") {
            return false;
        }
        match subagent_type {
            Some(id) => get_agent_registry()
                .get_subagent_is_readonly(id)
                .unwrap_or(false),
            None => false,
        }
    }

    fn permission_intents(
        &self,
        input: &Value,
        _context: &ToolUseContext,
    ) -> OpenBitFunResult<Vec<PermissionIntent>> {
        let action = TaskAction::parse(input)?;
        let resource = match action {
            TaskAction::Spawn => input
                .get("subagent_type")
                .and_then(Value::as_str)
                .map(str::trim)
                .filter(|subagent_type| !subagent_type.is_empty())
                .unwrap_or("fork_context")
                .to_string(),
            TaskAction::SendInput => input
                .get("agent_id")
                .and_then(Value::as_str)
                .map(str::trim)
                .filter(|agent_id| !agent_id.is_empty())
                .map(|agent_id| format!("send_input:{agent_id}"))
                .ok_or_else(|| OpenBitFunError::validation("agent_id is required".to_string()))?,
            TaskAction::Cancel => input
                .get("agent_id")
                .and_then(Value::as_str)
                .map(str::trim)
                .filter(|agent_id| !agent_id.is_empty())
                .map(|agent_id| format!("cancel:{agent_id}"))
                .ok_or_else(|| OpenBitFunError::validation("agent_id is required".to_string()))?,
        };
        Ok(vec![PermissionIntent::new("task", vec![resource])])
    }

    async fn validate_input(
        &self,
        input: &Value,
        context: Option<&ToolUseContext>,
    ) -> ValidationResult {
        Self::validate_invocation_input(
            input,
            false,
            context.and_then(ToolUseContext::workspace_root),
        )
        .await
    }

    fn render_tool_use_message(&self, input: &Value, options: &ToolRenderOptions) -> String {
        match TaskAction::parse(input).ok() {
            Some(TaskAction::Cancel) => input
                .get("agent_id")
                .and_then(Value::as_str)
                .map(|agent_id| format!("Cancelling background task: {}", agent_id))
                .unwrap_or_else(|| "Cancelling background task".to_string()),
            Some(TaskAction::SendInput) => input
                .get("agent_id")
                .and_then(Value::as_str)
                .map(|agent_id| {
                    if options.verbose {
                        format!("Sending input to task: {}", agent_id)
                    } else {
                        format!("Task input: {}", agent_id)
                    }
                })
                .unwrap_or_else(|| "Sending input to task".to_string()),
            Some(TaskAction::Spawn) | None => {
                if let Some(agent_id) = input.get("agent_id").and_then(|v| v.as_str()) {
                    if options.verbose {
                        format!("Creating task: {}", agent_id)
                    } else {
                        format!("Task: {}", agent_id)
                    }
                } else {
                    "Creating task".to_string()
                }
            }
        }
    }

    async fn call_impl(
        &self,
        input: &Value,
        context: &ToolUseContext,
    ) -> OpenBitFunResult<Vec<ToolResult>> {
        self.call_task_impl(input, context).await
    }
}

#[cfg(test)]
mod tests;
