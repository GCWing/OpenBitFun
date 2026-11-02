//! Execution Engine Type Definitions

use crate::agentic::core::Message;
use crate::agentic::round_preempt::{DialogRoundInjectionInterrupt, DialogRoundInjectionSource};
use crate::agentic::tools::pipeline::SubagentParentInfo;
use crate::agentic::tools::ToolRuntimeRestrictions;
use crate::agentic::workspace::WorkspaceServices;
use crate::agentic::WorkspaceBinding;
pub use openbitfun_agent_runtime::events::FinishReason;
use openbitfun_agent_tools::LoadedDeferredToolSpec;
use openbitfun_core_types::ModelRequestContext;
use openbitfun_runtime_ports::{
    DelegationPolicy, PermissionConstraintLayer, PermissionDelegationContext,
    PermissionRuntimeCeiling, RemoteExecPort, TerminalPort,
};
use serde_json::Value;
use std::collections::HashMap;
use std::path::PathBuf;
use std::sync::Arc;
use tokio_util::sync::CancellationToken;
use tool_runtime::context::PrimaryModelFacts;

/// Execution context
#[derive(Clone)]
pub struct ExecutionContext {
    pub session_id: String,
    pub dialog_turn_id: String,
    pub turn_index: usize,
    pub agent_type: String,
    pub workspace: Option<WorkspaceBinding>,
    pub context: HashMap<String, String>,
    pub subagent_parent_info: Option<SubagentParentInfo>,
    /// Permission routing context. This can survive a partially persisted
    /// subagent lineage even when the historical parent turn is unavailable.
    pub permission_delegation: Option<PermissionDelegationContext>,
    /// Parent runtime restrictions inherited only by delegated child agents.
    pub permission_runtime_ceiling: Option<PermissionRuntimeCeiling>,
    pub(crate) delegation_policy: DelegationPolicy,
    pub runtime_tool_restrictions: ToolRuntimeRestrictions,
    /// Workspace I/O services (filesystem + shell) injected into tools
    pub workspace_services: Option<WorkspaceServices>,
    /// Terminal execution provider injected by product assembly.
    pub terminal_port: Option<Arc<dyn TerminalPort>>,
    /// Remote execution provider injected by product assembly.
    pub remote_exec_port: Option<Arc<dyn RemoteExecPort>>,
    /// At round boundaries, yield to a queued user turn when requested; other
    /// pending runtime injections remain within this execution.
    pub round_injection: Option<Arc<dyn DialogRoundInjectionSource>>,
    /// When false, the execution loop suppresses user-facing turn lifecycle events.
    pub emit_lifecycle_events: bool,
    /// When true, stream cancellation may be converted into a partial assistant
    /// result if text/tool output has already been produced.
    pub recover_partial_on_cancel: bool,
}

/// Round context
#[derive(Debug, Clone)]
pub struct RoundContext {
    pub context_composition: Option<openbitfun_core_types::UsageContextBreakdown>,
    pub session_id: String,
    pub subagent_parent_info: Option<SubagentParentInfo>,
    pub permission_delegation: Option<PermissionDelegationContext>,
    pub dialog_turn_id: String,
    pub turn_index: usize,
    pub round_number: usize,
    pub round_group_id: Option<String>,
    pub workspace: Option<WorkspaceBinding>,
    pub model_exchange_trace_dir: Option<PathBuf>,
    pub available_tools: Vec<String>,
    pub deferred_tools: Vec<String>,
    pub loaded_deferred_tool_specs: Vec<LoadedDeferredToolSpec>,
    /// Resolved `AIModelConfig.id` used to construct the client for this round.
    pub model_config_id: String,
    /// Provider model name sent in the request.
    pub effective_model_name: String,
    /// Provider-neutral request-scoped facts resolved by the runtime owner.
    pub model_request_context: ModelRequestContext,
    /// Exact account resolution injected by the executing host's model factory.
    pub(crate) account_client_source:
        Option<Arc<dyn crate::infrastructure::ai::account_client_source::AccountClientSource>>,
    pub(crate) channel_client_source:
        Option<Arc<crate::infrastructure::ai::channel_client_source::ChannelClientSource>>,
    /// Initial factory selection, consumed once instead of resolving it again.
    pub(crate) prepared_model:
        Option<crate::infrastructure::ai::channel_client_source::PreparedChannel>,
    pub primary_model_facts: PrimaryModelFacts,
    pub agent_type: String,
    pub context_vars: HashMap<String, String>,
    pub permission_constraints: PermissionConstraintLayer,
    pub permission_runtime_ceiling: Option<PermissionRuntimeCeiling>,
    pub(crate) delegation_policy: DelegationPolicy,
    pub runtime_tool_restrictions: ToolRuntimeRestrictions,
    /// Cooperative interrupt checked by tool execution so round injections can be
    /// applied after the currently running atomic tool/batch finishes.
    pub steering_interrupt: Option<DialogRoundInjectionInterrupt>,
    pub cancellation_token: CancellationToken,
    pub workspace_services: Option<WorkspaceServices>,
    pub terminal_port: Option<Arc<dyn TerminalPort>>,
    pub remote_exec_port: Option<Arc<dyn RemoteExecPort>>,
    pub recover_partial_on_cancel: bool,
}

/// Round result
#[derive(Debug, Clone)]
pub struct RoundResult {
    pub assistant_message: Message,
    /// Complete tool-call response already committed before tool execution.
    pub assistant_message_committed: bool,
    pub tool_calls: Vec<crate::agentic::core::ToolCall>,
    pub tool_result_messages: Vec<Message>,
    pub has_more_rounds: bool,
    pub finish_reason: FinishReason,
    /// Token usage statistics (from model response)
    pub usage: Option<crate::util::types::ai::GeminiUsage>,
    /// Provider-specific metadata returned by the model.
    pub provider_metadata: Option<Value>,
    /// When set, this round's stream was partially recovered (aborted mid-way
    /// but some output was already received). Contains a human-readable reason.
    pub partial_recovery_reason: Option<String>,
    /// True when the model emitted any non-empty assistant text in this round.
    /// Used by the execution engine to distinguish "model gave a final answer"
    /// (text-only round, end the turn) from "model stalled with thinking-only"
    /// (no text, no tool_call — needs rescue).
    pub had_assistant_text: bool,
    /// True when the model emitted any non-empty thinking / reasoning content
    /// in this round.
    pub had_thinking_content: bool,
}

/// Execution result
#[derive(Debug, Clone)]
pub struct ExecutionResult {
    /// Last assistant message
    pub final_message: Message,
    pub total_rounds: usize,
    pub success: bool,
    /// All new messages generated by this execution (including AI responses and tool results)
    pub new_messages: Vec<Message>,
    /// Why the execution finished
    pub finish_reason: FinishReason,
    pub total_tools: usize,
    pub duration_ms: u64,
    pub partial_recovery_reason: Option<String>,
    pub effective_finish_reason: String,
    pub has_final_response: bool,
}

pub(crate) const CANCEL_LIFECYCLE_OWNER_CONTEXT_KEY: &str = "cancel_lifecycle_owner";

pub(crate) fn coordinator_owns_cancel_lifecycle(context: &HashMap<String, String>) -> bool {
    context
        .get(CANCEL_LIFECYCLE_OWNER_CONTEXT_KEY)
        .map(String::as_str)
        == Some("coordinator")
}
