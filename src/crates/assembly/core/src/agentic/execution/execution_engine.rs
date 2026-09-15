//! Execution Engine
//!
//! Executes complete dialog turns, managing loops of multiple model rounds

use super::model_exchange_trace::{
    prepare_model_exchange_trace_for_workspace, ModelExchangeTraceOperation,
};
use super::round_executor::{ModelRoundLifecycle, RoundExecutor};
use super::types::{ExecutionContext, ExecutionResult, RoundContext, RoundResult};
use crate::agentic::agents::{
    build_prompt_context_for_workspace, get_agent_registry, get_embedded_prompt,
    is_swarm_planner_agent_type, render_direct_tool_listing_body, PrependedPromptReminders,
    PromptBuilder, PromptBuilderContext, RuntimeContextNeeds, ToolListingSections,
    UserContextPolicy, UserContextSection,
};
use crate::agentic::context_profile::{ContextProfilePolicy, ModelCapabilityProfile};
use crate::agentic::coordination::scheduler::agent_dialog_turn_image_contexts;
use crate::agentic::core::{
    render_system_reminder, InternalReminderKind, Message, MessageContent, MessageHelper,
    MessageRole, MessageSemanticKind, RequestReasoningTokenPolicy, Session,
};
use crate::agentic::events::{AgenticEvent, EventPriority, EventQueue};
#[cfg(feature = "agent-runtime")]
use crate::agentic::execution::conditional_instructions::{
    build_conditional_instruction_reminder, successful_workspace_read_paths,
};
use crate::agentic::execution::types::FinishReason;
use crate::agentic::image_analysis::image_processing::process_image_contexts_in_workspace;
use crate::agentic::image_analysis::{
    build_multimodal_message_with_images, ImageContextData, ImageLimits,
};
use crate::agentic::round_preempt::RoundInjectionKind;
use crate::agentic::session::{
    ContextCompressor, SessionManager, SystemPromptCacheIdentity, TokenAnchor, TokenAnchorInput,
    UserContextCacheIdentity, INTERRUPTED_TURN_MODEL_BINDING_FINGERPRINT_METADATA_KEY,
    INTERRUPTED_TURN_PERMISSION_MODE_METADATA_KEY,
    INTERRUPTED_TURN_REASONING_FINGERPRINT_METADATA_KEY,
    INTERRUPTED_TURN_REASONING_PRESET_METADATA_KEY,
    INTERRUPTED_TURN_REASONING_SELECTION_METADATA_KEY,
    INTERRUPTED_TURN_RESOLVED_MODEL_ID_METADATA_KEY,
};
use crate::agentic::skill_agent_snapshot::build_skill_agent_tool_listing_sections_from_snapshot;
use crate::agentic::tools::framework::ToolUseContext;
use crate::agentic::tools::implementations::{SkillTool, TaskTool};
use crate::agentic::tools::product_runtime::{
    collect_product_loaded_deferred_tool_specs, GetToolSpecTool,
};
use crate::agentic::tools::{
    resolve_tool_manifest, tool_context_runtime, ResolvedToolManifest, ToolRuntimeRestrictions,
};
use crate::agentic::WorkspaceBinding;
use crate::infrastructure::ai::get_global_ai_client_factory;
use crate::infrastructure::ai::reasoning_catalog::reasoning_preset_runtime_fingerprint;
use crate::native_hooks::{self, NativeHookSessionFacts};
use crate::service::config::get_global_config_service;
use crate::service::config::types::{
    automatic_max_output_tokens, model_runtime_binding_fingerprint, ModelCapability, ModelCategory,
};
use crate::service::instruction_context::{
    build_local_workspace_instruction_files_context_with_fs_detailed,
    build_workspace_instruction_files_context_detailed,
    build_workspace_instruction_files_context_with_fs, InstructionContextBuild,
};
use crate::util::errors::{OpenBitFunError, OpenBitFunResult};
use crate::util::token_counter::TokenCounter;
use crate::util::types::Message as AIMessage;
use crate::util::types::ToolDefinition;
use crate::util::{elapsed_ms_u64, truncate_at_char_boundary};
use dashmap::DashMap;
use log::{debug, error, info, trace, warn};
use openbitfun_agent_runtime::output_surface::TOOL_CONTEXT_INLINE_MARKDOWN_IMAGE_DISPLAY_KEY;
use openbitfun_agent_runtime::permission::PERMISSION_MODE_CONTEXT_KEY;
use openbitfun_agent_runtime::remote_file_delivery::TOOL_CONTEXT_REMOTE_FILE_DELIVERY_KEY;
use openbitfun_ai_adapters::ModelExchangeTraceConfig;
use openbitfun_core_types::{ModelRequestContext, SessionModelBindingPolicy};
use openbitfun_runtime_ports::{resolve_permission_mode, PermissionMode, PermissionModeLayers};
use sha2::{Digest, Sha256};
use std::collections::{HashMap, HashSet};
use std::sync::atomic::{AtomicU8, Ordering};
use std::sync::Arc;
use tokio_util::sync::CancellationToken;

fn execution_engine_owns_cancel_lifecycle(context: &HashMap<String, String>) -> bool {
    !super::types::coordinator_owns_cancel_lifecycle(context)
}

fn initial_round_index(context: &std::collections::HashMap<String, String>) -> usize {
    context
        .get("initial_round_index")
        .and_then(|value| value.parse::<usize>().ok())
        .unwrap_or(0)
}
use tool_runtime::context::PrimaryModelFacts;

fn skill_agent_listing_reminders(
    baseline_tool_sections: Option<&ToolListingSections>,
) -> (Option<String>, Option<String>) {
    (
        baseline_tool_sections.and_then(ToolListingSections::render_skill_listing_reminder),
        baseline_tool_sections.and_then(ToolListingSections::render_agent_listing_reminder),
    )
}

fn reached_fixed_model_round_limit(max_rounds: usize, completed_rounds: usize) -> bool {
    max_rounds > 0 && completed_rounds >= max_rounds
}

fn runtime_context_needs_for_manifest(manifest: &ResolvedToolManifest) -> RuntimeContextNeeds {
    RuntimeContextNeeds::from_tool_names(
        manifest
            .tool_definitions
            .iter()
            .map(|definition| definition.name.as_str()),
    )
}

fn apply_agent_temperature_override(
    agent: &dyn crate::agentic::agents::Agent,
    client: Arc<crate::infrastructure::ai::AIClient>,
) -> Arc<crate::infrastructure::ai::AIClient> {
    let Some(temperature) = agent.model_temperature_override() else {
        return client;
    };
    if client.config.temperature == Some(temperature) {
        return client;
    }
    let mut derived = client.as_ref().clone();
    derived.config.temperature = Some(temperature);
    Arc::new(derived)
}

fn resolve_round_permission_mode(
    active_turn_mode: Option<PermissionMode>,
    fixed_context_mode: Option<PermissionMode>,
    session_mode: Option<PermissionMode>,
    global_default: PermissionMode,
) -> PermissionMode {
    resolve_permission_mode(
        PermissionModeLayers::new(global_default)
            .with_session(session_mode)
            .with_turn(active_turn_mode.or(fixed_context_mode)),
    )
    .mode
}

pub(crate) fn restrict_recovered_permission_mode(
    original: PermissionMode,
    current: PermissionMode,
) -> PermissionMode {
    const fn rank(mode: PermissionMode) -> u8 {
        match mode {
            PermissionMode::Ask => 0,
            PermissionMode::AutoApprove => 1,
            PermissionMode::FullAccess => 2,
        }
    }

    if rank(current) < rank(original) {
        current
    } else {
        original
    }
}

/// Execution engine configuration
#[derive(Debug, Clone)]
pub struct ExecutionEngineConfig {
    pub max_rounds: usize,
    /// Max consecutive rounds with identical tool-call signatures before loop detection triggers.
    pub max_consecutive_same_tool: usize,
}

impl Default for ExecutionEngineConfig {
    fn default() -> Self {
        Self {
            max_rounds: crate::service::config::types::DEFAULT_MAX_ROUNDS,
            max_consecutive_same_tool: 3,
        }
    }
}

impl ExecutionEngineConfig {
    pub fn from_ai_config(ai_config: &crate::service::config::types::AIConfig) -> Self {
        Self {
            max_rounds: ai_config.max_rounds,
            ..Self::default()
        }
    }
}

#[derive(Debug, Clone)]
pub struct ContextCompactionOutcome {
    pub compression_id: String,
    pub compression_count: usize,
    pub tokens_before: usize,
    pub tokens_after: usize,
    pub compression_ratio: f64,
    pub duration_ms: u64,
    pub has_summary: bool,
    pub summary_source: String,
    pub applied: bool,
}

const MANUAL_COMPACTION_PLANNING: u8 = 0;
const MANUAL_COMPACTION_CANCELLED: u8 = 1;
const MANUAL_COMPACTION_COMMITTING: u8 = 2;

/// Arbitrates the only race that matters for manual compaction: cancellation
/// may win while the model is planning, but context commit must be atomic once
/// it begins.
#[derive(Debug)]
pub(crate) struct ManualCompactionCommitGate {
    state: AtomicU8,
}

impl ManualCompactionCommitGate {
    pub(crate) fn planning() -> Self {
        Self {
            state: AtomicU8::new(MANUAL_COMPACTION_PLANNING),
        }
    }

    pub(crate) fn try_cancel(&self) -> bool {
        self.state
            .compare_exchange(
                MANUAL_COMPACTION_PLANNING,
                MANUAL_COMPACTION_CANCELLED,
                Ordering::AcqRel,
                Ordering::Acquire,
            )
            .is_ok()
    }

    pub(crate) fn try_begin_commit(&self) -> bool {
        self.state
            .compare_exchange(
                MANUAL_COMPACTION_PLANNING,
                MANUAL_COMPACTION_COMMITTING,
                Ordering::AcqRel,
                Ordering::Acquire,
            )
            .is_ok()
    }

    pub(crate) fn commit_started(&self) -> bool {
        self.state.load(Ordering::Acquire) == MANUAL_COMPACTION_COMMITTING
    }
}

/// Cancel preparation as a unit, including provider retries and pre-compact hooks.
/// Recheck after completion because synchronous planning may observe cancellation
/// in the same poll that produces a result. Callers must commit outside this future.
pub(crate) async fn prepare_compression_cancellable<T>(
    cancellation_token: &CancellationToken,
    preparation: impl std::future::Future<Output = OpenBitFunResult<T>>,
) -> OpenBitFunResult<T> {
    let result = tokio::select! {
        biased;
        _ = cancellation_token.cancelled() => {
            return Err(OpenBitFunError::Cancelled("Context compaction cancelled".to_string()));
        }
        result = preparation => result,
    };
    if cancellation_token.is_cancelled() {
        return Err(OpenBitFunError::Cancelled(
            "Context compaction cancelled".to_string(),
        ));
    }
    result
}

fn compression_plan_error(error: OpenBitFunError, plan: usize) -> OpenBitFunError {
    match error {
        OpenBitFunError::AIProvider(mut error)
        | OpenBitFunError::RecoverableContextOverflow(mut error) => {
            error.message = format!(
                "Context compression failed on plan {plan}: {}",
                error.message
            );
            OpenBitFunError::AIProvider(error)
        }
        error => error,
    }
}

fn manual_compaction_terminal_error(error: OpenBitFunError) -> OpenBitFunError {
    match error {
        error @ OpenBitFunError::Cancelled(_) => error,
        error => OpenBitFunError::Session(error.to_string()),
    }
}

#[cfg(feature = "agent-runtime")]
async fn activate_conditional_instructions_after_round(
    session_manager: &SessionManager,
    context: &ExecutionContext,
    round_result: &RoundResult,
    messages: &mut Vec<Message>,
) {
    let Some(workspace) = context.workspace.as_ref() else {
        return;
    };
    let read_paths = successful_workspace_read_paths(&round_result.tool_result_messages, workspace);
    if read_paths.is_empty() {
        return;
    }

    let reminder_round_id = round_result
        .tool_result_messages
        .first()
        .and_then(|message| message.metadata.round_id.as_deref())
        .unwrap_or("conditional-instructions");
    let reminder = build_conditional_instruction_reminder(
        workspace,
        context.workspace_services.as_ref(),
        &read_paths,
        messages,
        &context.dialog_turn_id,
        reminder_round_id,
    )
    .await;
    let Some(reminder) = (match reminder {
        Ok(reminder) => reminder,
        Err(error) => {
            warn!(
                "Failed to load conditional instructions; retrying after a later matching read: {}",
                error
            );
            None
        }
    }) else {
        return;
    };

    messages.push(reminder.clone());
    if let Err(error) = session_manager
        .add_message(&context.session_id, reminder)
        .await
    {
        warn!(
            "Failed to persist conditional instruction reminder: {}",
            error
        );
    }
}

struct CompressionRuntimeScaffold {
    ai_client: Arc<crate::infrastructure::ai::AIClient>,
    model_request_context: ModelRequestContext,
    tool_definitions: Option<Vec<ToolDefinition>>,
    system_prompt_message: Message,
    prepended_prompt_reminders: PrependedPromptReminders,
    primary_supports_image_understanding: bool,
    compression_contract_limit: usize,
}

#[derive(Debug, Clone)]
struct TurnPromptScaffold {
    system_prompt_message: Message,
    prepended_prompt_reminders: PrependedPromptReminders,
}

#[derive(Debug, Clone)]
struct ContextHealthSnapshot {
    token_usage_ratio: f32,
    full_compression_count: usize,
    compression_failure_count: u32,
    repeated_tool_signature_count: usize,
    consecutive_failed_commands: usize,
}

impl ContextHealthSnapshot {
    fn from_runtime_observations(
        token_usage_ratio: f32,
        full_compression_count: usize,
        compression_failure_count: u32,
        recent_tool_signatures: &[String],
        messages: &[Message],
    ) -> Self {
        Self {
            token_usage_ratio,
            full_compression_count,
            compression_failure_count,
            repeated_tool_signature_count: Self::repeated_tool_signature_count(
                recent_tool_signatures,
            ),
            consecutive_failed_commands: Self::consecutive_failed_commands(messages),
        }
    }

    fn token_usage_ratio(current_tokens: usize, context_window: usize) -> f32 {
        if context_window == 0 {
            return 0.0;
        }
        current_tokens as f32 / context_window as f32
    }

    fn log(&self, session_id: &str, turn_id: &str, round_index: usize, stage: &str) {
        debug!(
            "Context health snapshot: session_id={}, turn_id={}, round_index={}, stage={}, token_usage={:.3}, full_compression_count={}, compression_failure_count={}, repeated_tool_signature_count={}, consecutive_failed_commands={}",
            session_id,
            turn_id,
            round_index,
            stage,
            self.token_usage_ratio,
            self.full_compression_count,
            self.compression_failure_count,
            self.repeated_tool_signature_count,
            self.consecutive_failed_commands
        );
    }

    fn log_policy_thresholds(
        &self,
        session_id: &str,
        turn_id: &str,
        round_index: usize,
        policy: &ContextProfilePolicy,
    ) {
        if policy.has_repeated_tool_loop(self.repeated_tool_signature_count) {
            debug!(
                "Context profile repeated-tool threshold reached: session_id={}, turn_id={}, round_index={}, profile={:?}, repeated_tool_signature_count={}, threshold={}",
                session_id,
                turn_id,
                round_index,
                policy.profile,
                self.repeated_tool_signature_count,
                policy.repeated_tool_signature_threshold
            );
        }

        if policy.has_consecutive_command_failure_loop(self.consecutive_failed_commands) {
            warn!(
                "Context profile command-failure threshold reached: session_id={}, turn_id={}, round_index={}, profile={:?}, consecutive_failed_commands={}, threshold={}",
                session_id,
                turn_id,
                round_index,
                policy.profile,
                self.consecutive_failed_commands,
                policy.consecutive_failed_command_threshold
            );
        }
    }

    fn repeated_tool_signature_count(recent_tool_signatures: &[String]) -> usize {
        let Some(last_signature) = recent_tool_signatures.last() else {
            return 0;
        };

        let repeated_count = recent_tool_signatures
            .iter()
            .rev()
            .take_while(|signature| *signature == last_signature)
            .count();

        if repeated_count >= 2 {
            repeated_count
        } else {
            0
        }
    }

    fn consecutive_failed_commands(messages: &[Message]) -> usize {
        let mut failures = 0;
        for message in messages.iter().rev() {
            let Some(failed) = Self::command_result_failed(message) else {
                continue;
            };

            if failed {
                failures += 1;
            } else {
                break;
            }
        }
        failures
    }

    fn command_result_failed(message: &Message) -> Option<bool> {
        let MessageContent::ToolResult {
            tool_name,
            result,
            is_error,
            ..
        } = &message.content
        else {
            return None;
        };

        if tool_name != "ExecCommand" {
            return None;
        }

        Some(Self::tool_result_failed(result, *is_error))
    }

    fn tool_result_failed(result: &serde_json::Value, is_error: bool) -> bool {
        is_error
            || Self::bool_field(result, "timed_out") == Some(true)
            || Self::bool_field(result, "interrupted") == Some(true)
            || Self::bool_field(result, "success") == Some(false)
            || Self::numeric_field(result, "exit_code").is_some_and(|code| code != 0)
    }

    fn bool_field(value: &serde_json::Value, key: &str) -> Option<bool> {
        value.get(key).and_then(|field| field.as_bool())
    }

    fn numeric_field(value: &serde_json::Value, key: &str) -> Option<i64> {
        value.get(key).and_then(|field| field.as_i64())
    }
}

#[derive(Debug, Clone)]
struct TokenAnchorPressureDetails {
    anchor_id: String,
    prefix_message_count: usize,
    input_tokens: usize,
    adjusted_anchor_tokens: usize,
    system_tokens_at_anchor: usize,
    current_system_tokens: usize,
    system_delta: isize,
    tool_tokens_at_anchor: usize,
    current_tool_tokens: usize,
    tool_delta: isize,
    prepended_reminder_tokens_at_anchor: usize,
    current_prepended_reminder_tokens: usize,
    prepended_reminder_delta: isize,
    tail_tokens: usize,
}

#[derive(Debug, Clone, Copy)]
struct TokenPressureSnapshot {
    total_tokens: usize,
    system_tokens: usize,
    tool_tokens: usize,
    prepended_reminder_tokens: usize,
    conversation_tokens: usize,
    context_window: usize,
    input_limit: usize,
    output_reserve_tokens: usize,
    safety_reserve_tokens: usize,
    usage_ratio: f32,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
struct CompressionTriggerBudget {
    input_limit: usize,
    output_reserve_tokens: usize,
    safety_reserve_tokens: usize,
}

// Fields are declared in reverse parameter order so dropping an unconsumed
// input preserves the previous function-parameter drop order. Call sites keep
// struct literal fields in the original evaluation order.
struct TurnPromptScaffoldInput<'a> {
    stage: &'a str,
    runtime_context_needs: RuntimeContextNeeds,
    tool_listing_sections: ToolListingSections,
    supports_image_understanding: bool,
    model_name: &'a str,
    current_agent: &'a dyn crate::agentic::agents::Agent,
    context: &'a ExecutionContext,
}

struct FinalizeRoundInput<'a> {
    permission_constraints: openbitfun_runtime_ports::PermissionConstraintLayer,
    context_window: usize,
    tool_definitions: Option<Vec<ToolDefinition>>,
    reminder_text: &'a str,
    messages: &'a [Message],
    prepended_reminders: &'a [&'a str],
    primary_model_facts: &'a PrimaryModelFacts,
    model_request_context: &'a ModelRequestContext,
    execution_context_vars: &'a HashMap<String, String>,
    round_group_id: Option<String>,
    round_number: usize,
    agent_type: String,
    context: &'a ExecutionContext,
    ai_client: Arc<crate::infrastructure::ai::AIClient>,
}

#[path = "compression_job.rs"]
mod compression_job;
#[path = "compression_lifecycle.rs"]
mod compression_lifecycle;

use compression_job::{CompressionJob, PrefetchedCompression};

struct CompressionModelSummaryInput<'a> {
    trace_config: Option<ModelExchangeTraceConfig>,
    model_request_context: &'a ModelRequestContext,
    primary_supports_image_understanding: bool,
    prepended_prompt_reminders: &'a PrependedPromptReminders,
    tool_definitions: &'a Option<Vec<ToolDefinition>>,
    workspace: Option<&'a WorkspaceBinding>,
    workspace_services: Option<&'a crate::agentic::workspace::WorkspaceServices>,
    dialog_turn_id: &'a str,
    runtime_messages: &'a [Message],
    ai_client: Arc<crate::infrastructure::ai::AIClient>,
}

/// Execution engine
pub struct ExecutionEngine {
    round_executor: Arc<RoundExecutor>,
    event_queue: Arc<EventQueue>,
    session_manager: Arc<SessionManager>,
    context_compressor: Arc<ContextCompressor>,
    config: ExecutionEngineConfig,
    generation_messages: DashMap<(String, String), Vec<Message>>,
}

impl ExecutionEngine {
    const AUTO_COMPRESSION_SAFETY_RESERVE_TOKENS: usize = 10_000;
    const MAX_COMPRESSION_OVERFLOW_ATTEMPTS: usize = 4;
    const MAX_MAIN_CONTEXT_OVERFLOW_RECOVERIES: usize = 2;
    const FINALIZE_AFTER_REPEATED_TOOL_FAILURES_REMINDER: &'static str = "This turn must end now because repeated tool failures have prevented further progress. Ignore any unfinished work. Your task now is to give the user a final answer. Do not call any more tools; any tool call will fail. Respond in plain text only. Summarize what was completed, what failed, the evidence available from the tool results, and the single best next step for the user.";
    const FINALIZE_AFTER_MAX_ROUNDS_REMINDER: &'static str = "This turn must end now because it has reached the round limit. Ignore any unfinished work. Your task now is to give the user a final answer. Do not call any more tools; any tool call will fail. Respond in plain text only. Summarize the most useful completed work and evidence collected so far, and clearly distinguish resolved items from anything still unresolved.";
    const FINALIZE_TOOL_DENIED_MESSAGE: &'static str =
        "Tool use is disabled for finalize. Respond with plain text only.";
    const FINALIZE_USER_FOLLOWUP: &'static str =
        "Provide a final answer. You MUST not call any tools.";

    fn model_request_context(
        prompt_cache_lineage_id: &str,
        context: &HashMap<String, String>,
    ) -> ModelRequestContext {
        ModelRequestContext {
            prompt_cache_route_key: Some(prompt_cache_lineage_id.to_string()),
            output_schema: context
                .get(openbitfun_runtime_ports::OUTPUT_SCHEMA_CONTEXT_KEY)
                .and_then(|schema| serde_json::from_str(schema).ok()),
        }
    }

    async fn context_vars_for_round(
        &self,
        base: &HashMap<String, String>,
        session_id: &str,
        turn_id: &str,
    ) -> HashMap<String, String> {
        let mut context_vars = base.clone();
        let fixed_context_mode = base
            .get(PERMISSION_MODE_CONTEXT_KEY)
            .map(|value| PermissionMode::parse(value).unwrap_or(PermissionMode::Ask));
        let active_turn_mode = self
            .session_manager
            .active_turn_permission_mode(session_id, turn_id);
        let global_default = match get_global_config_service().await {
            Ok(service) => service
                .get_config(None)
                .await
                .map(|config: crate::service::config::types::GlobalConfig| {
                    PermissionMode::from_config(&config.tool_permissions)
                })
                .unwrap_or(PermissionMode::Ask),
            Err(_) => PermissionMode::Ask,
        };
        let current = resolve_round_permission_mode(
            active_turn_mode,
            fixed_context_mode,
            self.session_manager.session_permission_mode(session_id),
            global_default,
        );
        let resolved = base
            .get(INTERRUPTED_TURN_PERMISSION_MODE_METADATA_KEY)
            .and_then(|value| PermissionMode::parse(value))
            .map(|original| restrict_recovered_permission_mode(original, current))
            .unwrap_or(current);
        context_vars.insert(
            PERMISSION_MODE_CONTEXT_KEY.to_string(),
            resolved.as_str().to_string(),
        );
        context_vars
    }

    pub fn new(
        round_executor: Arc<RoundExecutor>,
        event_queue: Arc<EventQueue>,
        session_manager: Arc<SessionManager>,
        context_compressor: Arc<ContextCompressor>,
        config: ExecutionEngineConfig,
    ) -> Self {
        Self {
            round_executor,
            event_queue,
            session_manager,
            context_compressor,
            config,
            generation_messages: DashMap::new(),
        }
    }

    fn remember_generation_message(&self, session_id: &str, turn_id: &str, message: &Message) {
        self.generation_messages
            .entry((session_id.to_string(), turn_id.to_string()))
            .or_default()
            .push(message.clone());
    }

    pub(crate) fn take_generation_messages(&self, session_id: &str, turn_id: &str) -> Vec<Message> {
        self.generation_messages
            .remove(&(session_id.to_string(), turn_id.to_string()))
            .map(|(_, messages)| messages)
            .unwrap_or_default()
    }

    fn estimate_request_tokens_internal(
        messages: &[Message],
        tools: Option<&[ToolDefinition]>,
    ) -> usize {
        MessageHelper::estimate_request_tokens(
            messages,
            tools,
            RequestReasoningTokenPolicy::LatestTurnOnly,
        )
    }

    /// Estimate request pressure for compression decisions.
    ///
    /// `total_tokens` tracks the whole provider request input. The snapshot also
    /// keeps the mutable conversation portion and fixed scaffold overhead
    /// available for diagnostics, while the trigger decision reserves output and
    /// safety budget from the full context window.
    fn estimate_auto_compression_pressure(
        messages: &[Message],
        tools: Option<&[ToolDefinition]>,
        context_window: usize,
        trigger_budget: CompressionTriggerBudget,
        prepended_reminder_tokens: usize,
    ) -> TokenPressureSnapshot {
        let total_tokens = Self::estimate_request_tokens_internal(messages, tools)
            .saturating_add(prepended_reminder_tokens);
        Self::token_pressure_snapshot_from_total(
            total_tokens,
            messages,
            tools,
            context_window,
            trigger_budget,
            prepended_reminder_tokens,
        )
    }

    fn estimate_auto_compression_pressure_with_anchor(
        messages: &[Message],
        tools: Option<&[ToolDefinition]>,
        context_window: usize,
        trigger_budget: CompressionTriggerBudget,
        anchor: Option<&TokenAnchor>,
        prepended_reminder_tokens: usize,
    ) -> (TokenPressureSnapshot, Option<TokenAnchorPressureDetails>) {
        let Some(anchor) = anchor else {
            let snapshot = Self::estimate_auto_compression_pressure(
                messages,
                tools,
                context_window,
                trigger_budget,
                prepended_reminder_tokens,
            );
            return (snapshot, None);
        };

        let current_system_tokens = Self::system_tokens_for_pressure(messages);
        let current_tool_tokens = tools
            .map(TokenCounter::estimate_tool_definitions_tokens)
            .unwrap_or(0);
        let adjusted_anchor_tokens = Self::apply_token_delta(
            anchor.input_tokens,
            anchor.system_tokens_at_anchor,
            current_system_tokens,
        );
        let adjusted_anchor_tokens = Self::apply_token_delta(
            adjusted_anchor_tokens,
            anchor.tool_tokens_at_anchor,
            current_tool_tokens,
        );
        let adjusted_anchor_tokens = Self::apply_token_delta(
            adjusted_anchor_tokens,
            anchor.prepended_reminder_tokens_at_anchor,
            prepended_reminder_tokens,
        );
        let tail_tokens = Self::estimate_tail_tokens(&messages[anchor.prefix_message_count..]);
        let total_tokens = adjusted_anchor_tokens.saturating_add(tail_tokens);

        let snapshot = Self::token_pressure_snapshot_from_total(
            total_tokens,
            messages,
            tools,
            context_window,
            trigger_budget,
            prepended_reminder_tokens,
        );
        (
            snapshot,
            Some(TokenAnchorPressureDetails {
                anchor_id: anchor.anchor_id.clone(),
                prefix_message_count: anchor.prefix_message_count,
                input_tokens: anchor.input_tokens,
                adjusted_anchor_tokens,
                system_tokens_at_anchor: anchor.system_tokens_at_anchor,
                current_system_tokens,
                system_delta: current_system_tokens as isize
                    - anchor.system_tokens_at_anchor as isize,
                tool_tokens_at_anchor: anchor.tool_tokens_at_anchor,
                current_tool_tokens,
                tool_delta: current_tool_tokens as isize - anchor.tool_tokens_at_anchor as isize,
                prepended_reminder_tokens_at_anchor: anchor.prepended_reminder_tokens_at_anchor,
                current_prepended_reminder_tokens: prepended_reminder_tokens,
                prepended_reminder_delta: prepended_reminder_tokens as isize
                    - anchor.prepended_reminder_tokens_at_anchor as isize,
                tail_tokens,
            }),
        )
    }

    fn token_pressure_snapshot_from_total(
        total_tokens: usize,
        messages: &[Message],
        tools: Option<&[ToolDefinition]>,
        context_window: usize,
        trigger_budget: CompressionTriggerBudget,
        prepended_reminder_tokens: usize,
    ) -> TokenPressureSnapshot {
        let system_tokens = messages
            .first()
            .filter(|message| message.role == MessageRole::System)
            .map(|message| message.estimate_tokens_with_reasoning(false))
            .unwrap_or(0);
        let tool_tokens = tools
            .map(TokenCounter::estimate_tool_definitions_tokens)
            .unwrap_or(0);
        let reserved_overhead = system_tokens
            .saturating_add(tool_tokens)
            .saturating_add(prepended_reminder_tokens);
        let conversation_tokens = total_tokens.saturating_sub(reserved_overhead);
        let usage_ratio = ContextHealthSnapshot::token_usage_ratio(total_tokens, context_window);
        TokenPressureSnapshot {
            total_tokens,
            system_tokens,
            tool_tokens,
            prepended_reminder_tokens,
            conversation_tokens,
            context_window,
            input_limit: trigger_budget.input_limit,
            output_reserve_tokens: trigger_budget.output_reserve_tokens,
            safety_reserve_tokens: trigger_budget.safety_reserve_tokens,
            usage_ratio,
        }
    }

    fn compression_trigger_budget(
        context_window: usize,
        configured_max_tokens: Option<u32>,
    ) -> CompressionTriggerBudget {
        let output_reserve_tokens = configured_max_tokens
            .map(|value| value as usize)
            .unwrap_or_else(|| automatic_max_output_tokens(context_window as u32) as usize);
        let safety_reserve_tokens = Self::AUTO_COMPRESSION_SAFETY_RESERVE_TOKENS;
        let input_limit =
            context_window.saturating_sub(output_reserve_tokens + safety_reserve_tokens);

        CompressionTriggerBudget {
            input_limit,
            output_reserve_tokens,
            safety_reserve_tokens,
        }
    }

    fn prepended_reminder_tokens_for_pressure(prepended_reminders: &[&str]) -> usize {
        prepended_reminders
            .iter()
            .map(|reminder| reminder.trim())
            .filter(|reminder| !reminder.is_empty())
            .map(|reminder| {
                Message::user(render_system_reminder(reminder))
                    .estimate_tokens_with_reasoning(false)
            })
            .sum()
    }

    fn system_tokens_for_pressure(messages: &[Message]) -> usize {
        messages
            .first()
            .filter(|message| message.role == MessageRole::System)
            .map(|message| message.estimate_tokens_with_reasoning(false))
            .unwrap_or(0)
    }

    fn estimate_tail_tokens(messages: &[Message]) -> usize {
        messages
            .iter()
            .map(|message| message.estimate_tokens_with_reasoning(true))
            .sum()
    }

    fn apply_token_delta(base: usize, old: usize, new: usize) -> usize {
        if new >= old {
            base.saturating_add(new - old)
        } else {
            base.saturating_sub(old - new)
        }
    }

    fn tool_signature_args_summary(args_str: &str) -> String {
        if args_str.len() <= 128 {
            return args_str.to_string();
        }

        let args_hash = hex::encode(Sha256::digest(args_str.as_bytes()));
        format!(
            "{}..#{}:sha256={}",
            truncate_at_char_boundary(args_str, 64),
            args_str.len(),
            args_hash
        )
    }

    fn tool_call_signature(tool_calls: &[crate::agentic::core::ToolCall]) -> Option<String> {
        if tool_calls.is_empty() {
            return None;
        }

        let mut signatures: Vec<String> = tool_calls
            .iter()
            .map(|tool_call| {
                let arguments = tool_call.arguments.to_string();
                let arguments_summary = Self::tool_signature_args_summary(&arguments);
                format!("{}:{}", tool_call.tool_name, arguments_summary)
            })
            .collect();
        signatures.sort();
        Some(signatures.join("|"))
    }

    fn failed_tool_round_signature(
        tool_calls: &[crate::agentic::core::ToolCall],
        tool_result_messages: &[Message],
    ) -> Option<String> {
        if tool_result_messages.is_empty()
            || !tool_result_messages.iter().all(|message| {
                let MessageContent::ToolResult {
                    result, is_error, ..
                } = &message.content
                else {
                    return false;
                };
                ContextHealthSnapshot::tool_result_failed(result, *is_error)
            })
        {
            return None;
        }

        Self::tool_call_signature(tool_calls)
    }

    /// Whether a partial stream recovery should trigger a continuation round
    /// instead of treating truncated assistant text as the final answer.
    ///
    /// User-initiated cancellation is excluded; all other partial recoveries
    /// (idle timeout, watchdog timeout, mid-stream errors) may continue.
    fn should_continue_after_partial_response(reason: &str) -> bool {
        let lower = reason.to_ascii_lowercase();
        !lower.contains("cancelled")
    }

    /// Detect periodic tool-signature loops in the trailing window.
    ///
    /// Returns `true` when the last `2 * threshold` rounds contain at most
    /// `threshold` distinct signatures AND every signature in that window
    /// appeared at least twice. Such windows have no new exploration and
    /// represent the model toggling between a small fixed set of calls
    /// (e.g. `A-B-A-B-A-B`, `A-B-C-A-B-C`).
    ///
    /// The window length is `2 * threshold` (rather than `threshold`) so the
    /// strict consecutive check (`windows(2).all(eq)`) keeps owning the
    /// `A-A-A` case at threshold rounds, and this detector only fires once
    /// the alternating pattern has had room to repeat.
    fn is_periodic_tool_signature_loop(recent_signatures: &[String], threshold: usize) -> bool {
        let threshold = threshold.max(1);
        let window_size = threshold.saturating_mul(2);
        if window_size == 0 || recent_signatures.len() < window_size {
            return false;
        }

        let tail = &recent_signatures[recent_signatures.len() - window_size..];
        let mut counts: HashMap<&str, usize> = HashMap::new();
        for sig in tail {
            *counts.entry(sig.as_str()).or_insert(0) += 1;
        }

        if counts.len() > threshold {
            return false;
        }

        counts.values().all(|&count| count >= 2)
    }

    fn assistant_has_tool_calls(message: &Message) -> bool {
        matches!(
            &message.content,
            MessageContent::Mixed { tool_calls, .. } if !tool_calls.is_empty()
        )
    }

    fn finalize_tool_names(tool_definitions: Option<&[ToolDefinition]>) -> Vec<String> {
        tool_definitions
            .unwrap_or(&[])
            .iter()
            .map(|tool| tool.name.clone())
            .collect()
    }

    fn finalize_runtime_tool_restrictions(
        context: &ExecutionContext,
        tool_names: &[String],
    ) -> ToolRuntimeRestrictions {
        let mut restrictions = context.runtime_tool_restrictions.clone();
        for tool_name in tool_names {
            restrictions.denied_tool_names.insert(tool_name.clone());
            restrictions
                .denied_tool_messages
                .entry(tool_name.clone())
                .or_insert_with(|| Self::FINALIZE_TOOL_DENIED_MESSAGE.to_string());
        }
        restrictions
    }

    fn build_local_final_response_message(reason: &str) -> String {
        match reason {
            "repeated_tool_failures" => {
                "I'm stopping here because repeated tool failures prevented further progress in this turn.".to_string()
            }
            "max_rounds" => {
                "I'm stopping here because this turn reached its round limit before I could complete a final response.".to_string()
            }
            _ => "I'm stopping here because this turn could not be completed successfully.".to_string(),
        }
    }

    fn should_mark_has_final_response(
        has_assistant_message: bool,
        used_local_final_response_synthesis: bool,
    ) -> bool {
        has_assistant_message && !used_local_final_response_synthesis
    }

    fn build_finalize_cache_anchor_messages(turn_id: &str, reminder_text: &str) -> Vec<Message> {
        vec![
            Message::internal_reminder(
                InternalReminderKind::FinalizeCacheAnchor,
                reminder_text.to_string(),
            )
            .with_turn_id(turn_id.to_string()),
            Message::user(Self::FINALIZE_USER_FOLLOWUP.to_string())
                .with_semantic_kind(MessageSemanticKind::InternalReminder)
                .with_internal_reminder_kind(InternalReminderKind::FinalizeCacheAnchor)
                .with_turn_id(turn_id.to_string()),
        ]
    }

    /// Emergency truncation: drop oldest API rounds (assistant+tool pairs)
    /// from the front of the message list until estimated tokens fit within
    /// `context_window`.  System messages and the first user message are
    /// always preserved.
    fn emergency_truncate_messages(
        messages: Vec<Message>,
        context_window: usize,
        tools: Option<&[ToolDefinition]>,
        prepended_reminder_tokens: usize,
    ) -> Vec<Message> {
        use crate::agentic::core::MessageRole;

        // Separate preserved head (system + first user) from droppable body.
        let mut preserved: Vec<Message> = Vec::new();
        let mut droppable: Vec<Message> = Vec::new();
        let mut seen_first_user = false;

        for msg in messages {
            if !seen_first_user {
                let is_user = msg.role == MessageRole::User;
                preserved.push(msg);
                if is_user {
                    seen_first_user = true;
                }
            } else {
                droppable.push(msg);
            }
        }

        if droppable.is_empty() {
            return preserved;
        }

        // Group droppable messages into API rounds.
        // An API round starts with an Assistant message and includes all
        // following Tool messages until the next Assistant or User message.
        let mut rounds: Vec<Vec<Message>> = Vec::new();
        for msg in droppable {
            match msg.role {
                MessageRole::Assistant => {
                    rounds.push(vec![msg]);
                }
                MessageRole::Tool => {
                    if let Some(last_round) = rounds.last_mut() {
                        last_round.push(msg);
                    } else {
                        rounds.push(vec![msg]);
                    }
                }
                _ => {
                    rounds.push(vec![msg]);
                }
            }
        }

        // Drop rounds from the front until we fit.
        let tool_tokens = tools
            .map(TokenCounter::estimate_tool_definitions_tokens)
            .unwrap_or(0);
        let preserved_tokens: usize = preserved
            .iter()
            .map(|m| m.estimate_tokens_with_reasoning(true))
            .sum::<usize>()
            + tool_tokens
            + prepended_reminder_tokens
            + 3;

        let mut kept_start = 0;
        let mut total_tokens = preserved_tokens
            + rounds
                .iter()
                .flat_map(|r| r.iter())
                .map(|m| m.estimate_tokens_with_reasoning(true))
                .sum::<usize>();

        while total_tokens > context_window && kept_start < rounds.len() {
            let round_tokens: usize = rounds[kept_start]
                .iter()
                .map(|m| m.estimate_tokens_with_reasoning(true))
                .sum();
            total_tokens -= round_tokens;
            kept_start += 1;
        }

        if kept_start > 0 {
            warn!(
                "Emergency truncation dropped {} API round(s) from context head",
                kept_start
            );
        }

        let mut result = preserved;
        for round in rounds.into_iter().skip(kept_start) {
            result.extend(round);
        }
        result
    }

    fn is_redacted_image_context(image: &ImageContextData) -> bool {
        let missing_path = image
            .image_path
            .as_ref()
            .map(|s| s.trim().is_empty())
            .unwrap_or(true);
        let missing_data_url = image
            .data_url
            .as_ref()
            .map(|s| s.trim().is_empty())
            .unwrap_or(true);
        let has_redaction_hint = image
            .metadata
            .as_ref()
            .and_then(|m| m.get("has_data_url"))
            .and_then(|v| v.as_bool())
            .unwrap_or(false);

        missing_path && missing_data_url && has_redaction_hint
    }

    fn is_recoverable_historical_image_error(err: &OpenBitFunError) -> bool {
        match err {
            OpenBitFunError::Io(_) | OpenBitFunError::Deserialization(_) => true,
            OpenBitFunError::Validation(msg) => {
                msg.starts_with("Failed to decode image data")
                    || msg.starts_with("Unsupported or unrecognized image format")
                    || msg.starts_with("Invalid data URL format")
                    || msg.starts_with("Data URL format error")
            }
            _ => false,
        }
    }

    fn can_fallback_to_text_only(
        images: &[ImageContextData],
        err: &OpenBitFunError,
        is_current_turn_message: bool,
    ) -> bool {
        let is_redacted_payload_error = matches!(
            err,
            OpenBitFunError::Validation(msg) if msg.starts_with("Image context missing image_path/data_url")
        ) && !images.is_empty()
            && images.iter().all(Self::is_redacted_image_context);

        if is_redacted_payload_error {
            return true;
        }

        if is_current_turn_message {
            return false;
        }

        Self::is_recoverable_historical_image_error(err)
    }

    fn resolve_configured_model_id(
        ai_config: &crate::service::config::types::AIConfig,
        model_id: &str,
    ) -> String {
        let trimmed = model_id.trim();
        let selector = if trimmed.is_empty() || trimmed == "default" {
            "primary"
        } else {
            trimmed
        };
        ai_config
            .resolve_model_selection(selector)
            .or_else(|| ai_config.resolve_model_selection("primary"))
            .unwrap_or_else(|| selector.to_string())
    }

    fn resolve_model_id_for_turn_selection(
        ai_config: &crate::service::config::types::AIConfig,
        configured_model_id: &str,
        frozen_model_id: Option<&str>,
    ) -> OpenBitFunResult<String> {
        if let Some(frozen_model_id) = frozen_model_id
            .map(str::trim)
            .filter(|model_id| !model_id.is_empty())
        {
            return ai_config
                .resolve_model_reference(frozen_model_id)
                .ok_or_else(|| {
                    OpenBitFunError::Validation(format!(
                        "Frozen dialog turn model contract is unavailable: {frozen_model_id}"
                    ))
                });
        }

        let configured_model_id = configured_model_id.trim();
        let selector = if configured_model_id.is_empty() || configured_model_id == "default" {
            "primary"
        } else {
            configured_model_id
        };
        ai_config
            .resolve_model_selection(selector)
            .or_else(|| ai_config.resolve_model_selection("primary"))
            .ok_or_else(|| {
                OpenBitFunError::AIClient(
                    "Dialog turn model could not resolve a concrete primary model".to_string(),
                )
            })
    }

    fn validate_frozen_reasoning_contract(
        context: &ExecutionContext,
        ai_client: &crate::infrastructure::ai::AIClient,
    ) -> OpenBitFunResult<()> {
        let Some(expected_value) = context
            .context
            .get(INTERRUPTED_TURN_REASONING_PRESET_METADATA_KEY)
        else {
            return Ok(());
        };
        let expected = serde_json::from_str::<Option<String>>(expected_value).map_err(|error| {
            OpenBitFunError::Validation(format!(
                "Frozen dialog turn reasoning contract is malformed: {error}"
            ))
        })?;
        let actual_descriptor = ai_client
            .selected_reasoning_preset()
            .or_else(|| ai_client.model_reasoning_preset());
        let actual = actual_descriptor.map(|preset| preset.id.as_str());
        if actual != expected.as_deref() {
            return Err(OpenBitFunError::Validation(format!(
                "Frozen dialog turn reasoning contract changed before execution: expected={:?}, actual={actual:?}",
                expected.as_deref(),
            )));
        }
        let expected_fingerprint = context
            .context
            .get(INTERRUPTED_TURN_REASONING_FINGERPRINT_METADATA_KEY)
            .ok_or_else(|| {
                OpenBitFunError::Validation(
                    "Frozen dialog turn reasoning contract has no runtime fingerprint".to_string(),
                )
            })?;
        if reasoning_preset_runtime_fingerprint(actual_descriptor) != expected_fingerprint.as_str()
        {
            return Err(OpenBitFunError::Validation(
                "Frozen dialog turn reasoning contract changed before execution: runtime fingerprint mismatch"
                    .to_string(),
            ));
        }
        Ok(())
    }

    async fn resolve_reasoning_selection_for_turn(
        &self,
        session_id: &str,
        context: &ExecutionContext,
    ) -> OpenBitFunResult<Option<String>> {
        if let Some(frozen_selection) = context
            .context
            .get(INTERRUPTED_TURN_REASONING_SELECTION_METADATA_KEY)
        {
            return serde_json::from_str::<Option<String>>(frozen_selection).map_err(|error| {
                OpenBitFunError::Validation(format!(
                    "Frozen dialog turn reasoning selection is malformed: {error}"
                ))
            });
        }

        self.session_manager
            .reconcile_session_reasoning_preset_for_turn(session_id, "turn_resolution")
            .await
    }

    pub(crate) fn is_frozen_reasoning_contract_error(error: &OpenBitFunError) -> bool {
        matches!(error, OpenBitFunError::Validation(message) if message.starts_with("Frozen dialog turn reasoning contract changed before execution:"))
    }

    async fn validate_frozen_model_contract(context: &ExecutionContext) -> OpenBitFunResult<()> {
        let Some(expected_model_id) = context
            .context
            .get(INTERRUPTED_TURN_RESOLVED_MODEL_ID_METADATA_KEY)
        else {
            return Ok(());
        };
        let expected_fingerprint = context
            .context
            .get(INTERRUPTED_TURN_MODEL_BINDING_FINGERPRINT_METADATA_KEY)
            .ok_or_else(|| {
                OpenBitFunError::Validation(
                    "Frozen dialog turn model contract has no binding fingerprint".to_string(),
                )
            })?;
        let ai_config = SessionManager::load_ai_config_for_model_resolution()
            .await
            .ok_or_else(|| {
                OpenBitFunError::Validation(
                    "Frozen dialog turn model contract cannot be validated because AI configuration is unavailable"
                        .to_string(),
                )
            })?;
        let canonical_model_id = ai_config
            .resolve_model_reference(expected_model_id)
            .ok_or_else(|| {
                OpenBitFunError::Validation(format!(
                    "Frozen dialog turn model contract is unavailable: {expected_model_id}"
                ))
            })?;
        let model = ai_config
            .models
            .iter()
            .find(|model| model.enabled && model.id == canonical_model_id)
            .ok_or_else(|| {
                OpenBitFunError::Validation(format!(
                    "Frozen dialog turn model contract is unavailable: {expected_model_id}"
                ))
            })?;
        let actual_fingerprint = model_runtime_binding_fingerprint(model);
        if actual_fingerprint != expected_fingerprint.as_str() {
            return Err(OpenBitFunError::Validation(format!(
                "Frozen dialog turn model contract changed before execution: model_id={expected_model_id}"
            )));
        }
        Ok(())
    }

    pub(crate) fn is_frozen_model_contract_error(error: &OpenBitFunError) -> bool {
        matches!(error, OpenBitFunError::Validation(message) if message.starts_with("Frozen dialog turn model contract"))
    }

    async fn resolve_primary_model_context(
        model_id: &str,
        model_binding_policy: SessionModelBindingPolicy,
        ai_client_model: &str,
        ai_client_api_format: &str,
        unavailable_log_message: &str,
    ) -> PrimaryModelFacts {
        let config_service = get_global_config_service().await.ok();
        if let Some(service) = config_service {
            let ai_config: crate::service::config::types::AIConfig =
                service.get_config(Some("ai")).await.unwrap_or_default();

            let resolved_id = if matches!(
                model_binding_policy,
                SessionModelBindingPolicy::ApprovedImmutable
            ) {
                ai_config
                    .resolve_model_reference(model_id)
                    .unwrap_or_else(|| model_id.to_string())
            } else {
                Self::resolve_configured_model_id(&ai_config, model_id)
            };
            let model_cfg = ai_config.models.iter().find(|m| m.id == resolved_id);

            let supports = model_cfg.is_some_and(|m| {
                m.capabilities
                    .iter()
                    .any(|cap| matches!(cap, ModelCapability::ImageUnderstanding))
                    || matches!(m.category, ModelCategory::Multimodal)
            });

            PrimaryModelFacts::new(resolved_id, ai_client_model, ai_client_api_format, supports)
        } else {
            warn!("{}", unavailable_log_message);
            PrimaryModelFacts::new(model_id, ai_client_model, ai_client_api_format, false)
        }
    }

    async fn build_tool_listing_sections(
        manifest: &ResolvedToolManifest,
        tool_context: &crate::agentic::tools::framework::ToolUseContext,
    ) -> ToolListingSections {
        let has_tool_definition = |tool_name: &str| {
            manifest
                .tool_definitions
                .iter()
                .any(|definition| definition.name == tool_name)
        };

        ToolListingSections {
            skill_listing: if has_tool_definition("Skill") {
                SkillTool::build_available_skills_context_section(Some(tool_context)).await
            } else {
                None
            },
            agent_listing: if has_tool_definition("Task") || has_tool_definition("AgentSpawn") {
                TaskTool::build_available_agents_context_section(Some(tool_context)).await
            } else {
                None
            },
            direct_tool_listing: (!manifest.deferred_tool_names.is_empty()).then(|| {
                render_direct_tool_listing_body(
                    manifest
                        .tool_definitions
                        .iter()
                        .map(|definition| definition.name.as_str()),
                )
            }),
            deferred_tool_listing: if has_tool_definition("GetToolSpec") {
                GetToolSpecTool::build_deferred_tools_context_section(
                    &manifest.deferred_tool_summaries,
                )
            } else {
                None
            },
        }
    }

    async fn build_prompt_context(
        context: &ExecutionContext,
        model_name: &str,
        supports_image_understanding: bool,
        tool_listing_sections: ToolListingSections,
        runtime_context_needs: RuntimeContextNeeds,
    ) -> Option<PromptBuilderContext> {
        let workspace = context.workspace.as_ref()?;
        let remote_file_delivery_channel = context
            .context
            .get(TOOL_CONTEXT_REMOTE_FILE_DELIVERY_KEY)
            .and_then(|value| value.parse::<bool>().ok())
            .unwrap_or(false);
        let inline_markdown_image_display = context
            .context
            .get(TOOL_CONTEXT_INLINE_MARKDOWN_IMAGE_DISPLAY_KEY)
            .and_then(|value| value.parse::<bool>().ok())
            .unwrap_or(false);

        build_prompt_context_for_workspace(
            workspace,
            workspace.workspace_id.as_deref(),
            &context.session_id,
            Some(model_name.to_string()),
            Some(supports_image_understanding),
            tool_listing_sections,
            runtime_context_needs,
        )
        .await
        .map(|prompt_context| {
            prompt_context
                .with_remote_file_delivery_channel(remote_file_delivery_channel)
                .with_inline_markdown_image_display(inline_markdown_image_display)
        })
    }

    async fn build_user_context_for_cache_miss(
        workspace: Option<&WorkspaceBinding>,
        workspace_services: Option<&crate::agentic::workspace::WorkspaceServices>,
        mut prompt_context: PromptBuilderContext,
        policy: &UserContextPolicy,
    ) -> (Option<String>, bool) {
        let mut cacheable = true;
        if policy.includes(UserContextSection::WorkspaceInstructions) {
            let instruction_context: OpenBitFunResult<InstructionContextBuild> =
                if let Some(workspace) = workspace {
                    if workspace.is_remote() {
                        if let Some(services) = workspace_services {
                            build_workspace_instruction_files_context_with_fs(
                                services.fs.as_ref(),
                                &workspace.root_path_string(),
                            )
                            .await
                            .map(|content| InstructionContextBuild {
                                content,
                                cacheable: true,
                            })
                        } else {
                            Ok(InstructionContextBuild {
                                content: None,
                                cacheable: false,
                            })
                        }
                    } else {
                        if let Some(services) = workspace_services {
                            build_local_workspace_instruction_files_context_with_fs_detailed(
                                workspace.root_path(),
                                services.fs.as_ref(),
                                &workspace.root_path_string(),
                            )
                            .await
                        } else {
                            build_workspace_instruction_files_context_detailed(
                                workspace.root_path(),
                            )
                            .await
                        }
                    }
                } else {
                    Ok(InstructionContextBuild {
                        content: None,
                        cacheable: true,
                    })
                };
            let instruction_context = match instruction_context {
                Ok(instruction_context) => {
                    cacheable &= instruction_context.cacheable;
                    instruction_context.content
                }
                Err(error) => {
                    cacheable = false;
                    warn!(
                        "Failed to build workspace instruction context: path={} error={}",
                        workspace
                            .map(WorkspaceBinding::root_path_string)
                            .unwrap_or_else(|| "<none>".to_string()),
                        error
                    );
                    None
                }
            };
            prompt_context =
                prompt_context.with_workspace_instruction_files_context(instruction_context);
        }

        let user_context = PromptBuilder::new(prompt_context)
            .build_user_context_reminder(policy)
            .await;
        (user_context, cacheable)
    }

    async fn build_cached_prepended_prompt_reminders(
        &self,
        execution_context: &ExecutionContext,
        current_agent: &dyn crate::agentic::agents::Agent,
        prompt_context: Option<&PromptBuilderContext>,
    ) -> PrependedPromptReminders {
        let Some(prompt_context) = prompt_context.cloned() else {
            return PrependedPromptReminders::default();
        };
        let session_id = &execution_context.session_id;

        // Extract remote execution info before prompt_context is moved into PromptBuilder.
        let remote_connection_for_cache = prompt_context
            .remote_execution
            .as_ref()
            .map(|remote| remote.connection_display_name.replace('|', "/"));

        let prompt_builder = PromptBuilder::new(prompt_context.clone());
        let baseline_tool_sections = if let Some(snapshot) = self
            .session_manager
            .skill_agent_baseline_override_snapshot(session_id)
            .await
        {
            Some(snapshot)
        } else {
            self.session_manager
                .turn_skill_agent_snapshot(session_id, 0)
                .await
        };
        let baseline_tool_sections = baseline_tool_sections
            .map(|snapshot| build_skill_agent_tool_listing_sections_from_snapshot(&snapshot));
        if baseline_tool_sections.is_none() {
            warn!(
                "Listing reminder baseline snapshot unavailable while building prepended reminders: session_id={}",
                session_id
            );
        }
        let user_context_identity = {
            let base_identity = current_agent.user_context_cache_identity();
            // Append the remote connection to the cache scope so a failed overlay
            // (cached without remote hints) does not persist across reconnects.
            if let Some(connection) = &remote_connection_for_cache {
                UserContextCacheIdentity::new(format!(
                    "{}|remote:{}",
                    base_identity.scope_key, connection
                ))
            } else {
                base_identity
            }
        };
        let user_context = if let Some(cached_user_context) = self
            .session_manager
            .cached_user_context(session_id, &user_context_identity)
            .await
        {
            debug!(
                "User context cache hit: session_id={}, scope_key={}",
                session_id, user_context_identity.scope_key
            );
            Some(cached_user_context)
        } else {
            debug!(
                "User context cache miss: session_id={}, scope_key={}",
                session_id, user_context_identity.scope_key
            );
            let cache_generation = self
                .session_manager
                .user_context_cache_generation(session_id)
                .await;
            let user_context_policy = current_agent.user_context_policy();
            let (built_user_context, cacheable) = Self::build_user_context_for_cache_miss(
                execution_context.workspace.as_ref(),
                execution_context.workspace_services.as_ref(),
                prompt_context,
                &user_context_policy,
            )
            .await;
            if cacheable {
                if let Some(ref user_context) = built_user_context {
                    let cached = self
                        .session_manager
                        .remember_user_context_if_generation(
                            session_id,
                            cache_generation,
                            user_context_identity.clone(),
                            user_context.clone(),
                        )
                        .await;
                    if !cached {
                        debug!(
                            "Skipped stale user context cache write after invalidation: session_id={}, scope_key={}",
                            session_id, user_context_identity.scope_key
                        );
                    }
                }
            } else {
                debug!(
                    "User context was not cached after workspace instruction resolution failed: session_id={}, scope_key={}",
                    session_id, user_context_identity.scope_key
                );
            }
            built_user_context
        };
        let runtime_context = prompt_builder.build_runtime_context_reminder().await;
        let (skill_listing, mut agent_listing) =
            skill_agent_listing_reminders(baseline_tool_sections.as_ref());
        if is_swarm_planner_agent_type(current_agent.id()) {
            agent_listing = None;
        }

        PrependedPromptReminders {
            deferred_tool_listing: prompt_builder.build_deferred_tool_listing_reminder(),
            skill_listing,
            agent_listing,
            runtime_context,
            user_context,
        }
    }

    async fn resolve_cached_system_prompt(
        &self,
        session_id: &str,
        current_agent: &dyn crate::agentic::agents::Agent,
        prompt_context: Option<&PromptBuilderContext>,
        prompt_policy_id: Option<&str>,
    ) -> OpenBitFunResult<String> {
        let identity = match prompt_policy_id {
            Some(policy_id) => SystemPromptCacheIdentity::new(format!("harness:{policy_id}")),
            None => prompt_context
                .map(|context| {
                    current_agent.system_prompt_cache_identity(context.model_name.as_deref())
                })
                .unwrap_or_else(|| current_agent.system_prompt_cache_identity(None)),
        };

        if let Some(cached_system_prompt) = self
            .session_manager
            .cached_system_prompt(session_id, &identity)
            .await
        {
            debug!(
                "System prompt cache hit: session_id={}, scope_key={}",
                session_id, identity.scope_key
            );
            return Ok(cached_system_prompt);
        }

        debug!(
            "System prompt cache miss: session_id={}, scope_key={}",
            session_id, identity.scope_key
        );
        let system_prompt = if let Some(policy_id) = prompt_policy_id {
            let context = prompt_context.ok_or_else(|| {
                OpenBitFunError::Agent("Prompt build context is required".to_string())
            })?;
            let template = get_embedded_prompt(policy_id).ok_or_else(|| {
                OpenBitFunError::Agent(format!("{policy_id} not found in embedded files"))
            })?;
            PromptBuilder::new(context.clone())
                .build_prompt_from_template(template)
                .await?
        } else {
            current_agent.get_system_prompt(prompt_context).await?
        };
        self.session_manager
            .remember_system_prompt(session_id, identity, system_prompt.clone())
            .await;
        Ok(system_prompt)
    }

    async fn resolve_turn_prompt_scaffold(
        &self,
        input: TurnPromptScaffoldInput<'_>,
    ) -> OpenBitFunResult<TurnPromptScaffold> {
        debug!(
            "Resolving turn prompt scaffold: session_id={}, turn_id={}, stage={}, agent={}, model={}",
            input.context.session_id,
            input.context.dialog_turn_id,
            input.stage,
            input.current_agent.name(),
            input.model_name
        );

        let prompt_context = Self::build_prompt_context(
            input.context,
            input.model_name,
            input.supports_image_understanding,
            input.tool_listing_sections,
            input.runtime_context_needs,
        )
        .await;
        let prepended_prompt_reminders = self
            .build_cached_prepended_prompt_reminders(
                input.context,
                input.current_agent,
                prompt_context.as_ref(),
            )
            .await;
        let system_prompt = self
            .resolve_cached_system_prompt(
                &input.context.session_id,
                input.current_agent,
                prompt_context.as_ref(),
                None,
            )
            .await?;

        Self::log_turn_prompt_scaffold(
            &input.context.session_id,
            &input.context.dialog_turn_id,
            input.stage,
            system_prompt.len(),
            &prepended_prompt_reminders,
        );

        Ok(TurnPromptScaffold {
            system_prompt_message: Message::system(system_prompt),
            prepended_prompt_reminders,
        })
    }

    fn log_turn_prompt_scaffold(
        session_id: &str,
        turn_id: &str,
        stage: &str,
        system_prompt_len: usize,
        prepended_prompt_reminders: &PrependedPromptReminders,
    ) {
        debug!(
            "Turn prompt scaffold resolved: session_id={}, turn_id={}, stage={}, system_prompt_len={} bytes, skill_listing_len={}, agent_listing_len={}, deferred_tool_listing_len={}, user_context_len={}, runtime_context_len={}",
            session_id,
            turn_id,
            stage,
            system_prompt_len,
            prepended_prompt_reminders
                .skill_listing
                .as_ref()
                .map(|text| text.len())
                .unwrap_or(0),
            prepended_prompt_reminders
                .agent_listing
                .as_ref()
                .map(|text| text.len())
                .unwrap_or(0),
            prepended_prompt_reminders
                .deferred_tool_listing
                .as_ref()
                .map(|text| text.len())
                .unwrap_or(0),
            prepended_prompt_reminders
                .user_context
                .as_ref()
                .map(|text| text.len())
                .unwrap_or(0),
            prepended_prompt_reminders
                .runtime_context
                .as_ref()
                .map(|text| text.len())
                .unwrap_or(0)
        );
    }

    fn apply_turn_prompt_scaffold_to_messages(
        messages: &mut Vec<Message>,
        scaffold: &TurnPromptScaffold,
    ) {
        match messages.first_mut() {
            Some(first_message) if first_message.role == MessageRole::System => {
                *first_message = scaffold.system_prompt_message.clone();
            }
            _ => messages.insert(0, scaffold.system_prompt_message.clone()),
        }
    }

    pub(crate) async fn resolve_model_id_for_turn(
        &self,
        session: &Session,
        agent_type: &str,
        workspace: Option<&WorkspaceBinding>,
        turn_index: usize,
        frozen_model_id: Option<&str>,
        frozen_model_binding_fingerprint: Option<&str>,
    ) -> OpenBitFunResult<(String, String)> {
        let ai_config = SessionManager::load_ai_config_for_model_resolution()
            .await
            .ok_or_else(|| {
                OpenBitFunError::AIClient(
                    "Failed to get config service for model resolution".to_string(),
                )
            })?;
        if matches!(
            session.config.model_binding_policy,
            SessionModelBindingPolicy::ApprovedImmutable
        ) {
            let model_id = session
                .config
                .model_id
                .as_deref()
                .map(str::trim)
                .filter(|model_id| !model_id.is_empty())
                .ok_or_else(|| {
                    OpenBitFunError::AIClient(
                        "Approved immutable session has no concrete model id".to_string(),
                    )
                })?;
            let expected_fingerprint = session
                .config
                .model_binding_fingerprint
                .as_deref()
                .ok_or_else(|| {
                    OpenBitFunError::AIClient(
                        "Approved immutable session has no model binding fingerprint".to_string(),
                    )
                })?;
            let mut matches = ai_config
                .models
                .iter()
                .filter(|model| model.enabled && model.id == model_id);
            let model = matches.next().ok_or_else(|| {
                OpenBitFunError::AIClient(format!(
                    "Approved model configuration is unavailable: {}",
                    model_id
                ))
            })?;
            if matches.next().is_some()
                || model_runtime_binding_fingerprint(model) != expected_fingerprint
            {
                return Err(OpenBitFunError::AIClient(format!(
                    "Approved model binding changed before execution: {}",
                    model_id
                )));
            }
            return Ok((model_id.to_string(), expected_fingerprint.to_string()));
        }

        let agent_registry = get_agent_registry();
        let fallback_model_id = agent_registry
            .get_model_id_for_agent(agent_type, workspace.map(|binding| binding.root_path()))
            .await
            .map_err(|e| OpenBitFunError::AIClient(format!("Failed to get model ID: {}", e)))?;
        let configured_model_id = session
            .config
            .model_id
            .as_ref()
            .map(|model_id| model_id.trim())
            .filter(|model_id| !model_id.is_empty())
            .map(str::to_string)
            .unwrap_or(fallback_model_id.clone());
        let model_id = Self::resolve_model_id_for_turn_selection(
            &ai_config,
            &configured_model_id,
            frozen_model_id,
        )?;
        let model = ai_config
            .models
            .iter()
            .find(|model| model.enabled && model.id == model_id)
            .ok_or_else(|| {
                if frozen_model_id.is_some() {
                    OpenBitFunError::Validation(format!(
                        "Frozen dialog turn model contract is unavailable: {model_id}"
                    ))
                } else {
                    OpenBitFunError::AIClient(format!(
                        "Dialog turn model configuration is unavailable: {model_id}"
                    ))
                }
            })?;
        let model_binding_fingerprint = model_runtime_binding_fingerprint(model);
        if frozen_model_binding_fingerprint
            .is_some_and(|expected| expected != model_binding_fingerprint)
        {
            return Err(OpenBitFunError::Validation(format!(
                "Frozen dialog turn model contract changed before execution: model_id={model_id}"
            )));
        }
        if frozen_model_id.is_some() {
            info!(
                "Using frozen dialog turn model: session_id={}, turn_index={}, resolved_model_id={}",
                session.session_id, turn_index, model_id
            );
        }

        Ok((model_id, model_binding_fingerprint))
    }

    /// Omit from model request: UI-only verification frames and legacy auto desktop snapshots.
    fn skip_message_for_model_send(msg: &Message) -> bool {
        matches!(
            msg.metadata.semantic_kind.as_ref(),
            Some(MessageSemanticKind::ComputerUseVerificationScreenshot)
                | Some(MessageSemanticKind::ComputerUsePostActionSnapshot)
        )
    }

    fn is_stale_interrupted_continue(msg: &Message, current_turn_id: &str) -> bool {
        msg.internal_reminder_kind() == Some(InternalReminderKind::InterruptedContinue)
            && msg.metadata.turn_id.as_deref() != Some(current_turn_id)
    }

    /// True if this message would contribute at least one image to the model (before pruning).
    fn message_bears_images(msg: &Message) -> bool {
        if Self::skip_message_for_model_send(msg) {
            return false;
        }
        match &msg.content {
            MessageContent::Multimodal { images, .. } => !images.is_empty(),
            MessageContent::ToolResult {
                image_attachments, ..
            } => image_attachments.as_ref().is_some_and(|a| !a.is_empty()),
            _ => false,
        }
    }

    /// Indices of the last image-bearing messages that should keep image payloads.
    fn image_bearing_indices_to_keep(
        messages: &[Message],
        max_image_messages: usize,
    ) -> HashSet<usize> {
        let with_images: Vec<usize> = messages
            .iter()
            .enumerate()
            .filter(|(_, m)| Self::message_bears_images(m))
            .map(|(i, _)| i)
            .collect();
        let n = with_images.len();
        if n <= max_image_messages {
            return with_images.into_iter().collect();
        }
        with_images[n - max_image_messages..]
            .iter()
            .copied()
            .collect()
    }

    async fn run_finalize_round(
        &self,
        input: FinalizeRoundInput<'_>,
    ) -> OpenBitFunResult<RoundResult> {
        // Keep the original tool definitions attached to the finalize request
        // even though finalize forbids tool execution at runtime. Dropping the
        // tools here would change the provider request shape, which breaks
        // prompt/prefix cache reuse and turns the finalize round into a cache
        // miss for providers that key caching on the full request schema.
        let finalize_tool_names = Self::finalize_tool_names(input.tool_definitions.as_deref());
        let finalize_runtime_tool_restrictions =
            Self::finalize_runtime_tool_restrictions(input.context, &finalize_tool_names);
        let mut final_ai_messages = Self::build_ai_messages_for_send(
            input.messages,
            &input.ai_client.config.format,
            input.context.workspace.as_ref(),
            input.context.workspace_services.as_ref(),
            &input.context.dialog_turn_id,
            input.primary_model_facts.supports_image_inputs,
            input.prepended_reminders,
        )
        .await?;
        final_ai_messages.push(AIMessage::user(render_system_reminder(input.reminder_text)));
        final_ai_messages.push(AIMessage::user(Self::FINALIZE_USER_FOLLOWUP.to_string()));

        let model_exchange_trace_dir = self
            .session_manager
            .persistent_model_exchange_trace_dir(&input.context.session_id)
            .await;
        let round_context_vars = self
            .context_vars_for_round(
                input.execution_context_vars,
                &input.context.session_id,
                &input.context.dialog_turn_id,
            )
            .await;
        let round_context = RoundContext {
            session_id: input.context.session_id.clone(),
            subagent_parent_info: input.context.subagent_parent_info.clone(),
            permission_delegation: input.context.permission_delegation.clone(),
            dialog_turn_id: input.context.dialog_turn_id.clone(),
            turn_index: input.context.turn_index,
            round_number: input.round_number,
            round_group_id: input.round_group_id,
            workspace: input.context.workspace.clone(),
            model_exchange_trace_dir,
            available_tools: finalize_tool_names,
            deferred_tools: Vec::new(),
            loaded_deferred_tool_specs: Vec::new(),
            model_config_id: input.primary_model_facts.model_id.clone(),
            effective_model_name: input.ai_client.config.model.clone(),
            model_request_context: input.model_request_context.clone(),
            primary_model_facts: input.primary_model_facts.clone(),
            agent_type: input.agent_type,
            context_vars: round_context_vars,
            permission_constraints: input.permission_constraints,
            permission_runtime_ceiling: input.context.permission_runtime_ceiling.clone(),
            delegation_policy: input.context.delegation_policy,
            runtime_tool_restrictions: finalize_runtime_tool_restrictions,
            steering_interrupt: None,
            cancellation_token: CancellationToken::new(),
            workspace_services: input.context.workspace_services.clone(),
            terminal_port: input.context.terminal_port.clone(),
            remote_exec_port: input.context.remote_exec_port.clone(),
            recover_partial_on_cancel: input.context.recover_partial_on_cancel,
        };

        self.round_executor
            .execute_round(
                input.ai_client,
                round_context,
                final_ai_messages,
                input.tool_definitions,
                Some(input.context_window),
            )
            .await
    }

    async fn build_ai_messages_for_send(
        messages: &[Message],
        provider: &str,
        workspace: Option<&WorkspaceBinding>,
        workspace_services: Option<&crate::agentic::workspace::WorkspaceServices>,
        current_turn_id: &str,
        attach_images: bool,
        prepended_reminders: &[&str],
    ) -> OpenBitFunResult<Vec<AIMessage>> {
        /// Only the last this many **messages** that contain images keep their images for the API.
        const MAX_IMAGE_BEARING_MESSAGE_ROUNDS: usize = 2;

        let limits = ImageLimits::for_provider(provider);
        let image_context =
            ToolUseContext::for_tool_listing(workspace.cloned(), workspace_services.cloned());

        let trimmed_reminders = prepended_reminders
            .iter()
            .map(|text| text.trim())
            .filter(|text| !text.is_empty())
            .collect::<Vec<_>>();
        let mut result = Vec::with_capacity(messages.len() + trimmed_reminders.len());
        let mut attached_image_count = 0usize;
        let first_non_system_index = messages
            .iter()
            .position(|msg| msg.role != crate::agentic::core::MessageRole::System)
            .unwrap_or(messages.len());
        let mut prepended_reminders_injected = false;

        let keep_image_messages = if attach_images {
            Self::image_bearing_indices_to_keep(messages, MAX_IMAGE_BEARING_MESSAGE_ROUNDS)
        } else {
            HashSet::new()
        };

        for (msg_idx, msg) in messages.iter().enumerate() {
            if !prepended_reminders_injected && msg_idx == first_non_system_index {
                for reminder in &trimmed_reminders {
                    result.push(AIMessage::user(render_system_reminder(reminder)));
                }
                prepended_reminders_injected = true;
            }

            if Self::skip_message_for_model_send(msg)
                || Self::is_stale_interrupted_continue(msg, current_turn_id)
            {
                continue;
            }
            let keep_this_message_images = attach_images && keep_image_messages.contains(&msg_idx);
            match &msg.content {
                MessageContent::Multimodal { text, images } => {
                    if !attach_images {
                        // Primary model is text-only (or images are disabled). Convert to text-only
                        // placeholder so providers that don't support image inputs won't error.
                        let mut text_message = msg.clone();
                        text_message.content =
                            MessageContent::Text(Self::render_multimodal_as_text(text, images));
                        result.push(AIMessage::from(&text_message));
                        continue;
                    }

                    let (filtered_images, dropped_count): (Vec<ImageContextData>, usize) =
                        if images.is_empty() {
                            (Vec::new(), 0)
                        } else if keep_this_message_images {
                            (images.clone(), 0)
                        } else {
                            (Vec::new(), images.len())
                        };

                    let prompt = if text.trim().is_empty() {
                        "(image attached)".to_string()
                    } else {
                        text.clone()
                    };
                    let prompt = if dropped_count > 0 {
                        format!(
                            "{}\n\n[{} image(s) from this message omitted: only the latest {} message(s) in the conversation that contain images are sent to the model.]",
                            prompt.trim_end(),
                            dropped_count,
                            MAX_IMAGE_BEARING_MESSAGE_ROUNDS
                        )
                    } else {
                        prompt
                    };

                    match process_image_contexts_in_workspace(
                        &filtered_images,
                        provider,
                        &image_context,
                    )
                    .await
                    {
                        Ok(processed) => {
                            let next_count = attached_image_count + processed.len();
                            if next_count > limits.max_images_per_request {
                                return Err(OpenBitFunError::validation(format!(
                                    "Too many images in one request: {} > {}",
                                    next_count, limits.max_images_per_request
                                )));
                            }
                            attached_image_count = next_count;

                            let multimodal = build_multimodal_message_with_images(
                                &prompt, &processed, provider,
                            )?;
                            result.extend(multimodal);
                        }
                        Err(err) => {
                            if matches!(&err, OpenBitFunError::Validation(msg) if msg.starts_with("Too many images in one request"))
                            {
                                return Err(err);
                            }
                            let is_current_turn_message =
                                msg.metadata.turn_id.as_deref() == Some(current_turn_id);
                            if Self::can_fallback_to_text_only(
                                images,
                                &err,
                                is_current_turn_message,
                            ) {
                                warn!(
                                    "Failed to rebuild multimodal payload, falling back to text-only message: message_id={}, provider={}, turn_id={:?}, current_turn_id={}, error={}",
                                    msg.id, provider, msg.metadata.turn_id, current_turn_id, err
                                );
                                let mut unavailable = msg.clone();
                                unavailable.content = MessageContent::Text(format!(
                                    "{text}\n\n[Image pixels from this older message are unavailable. Ask for a new attachment if the current task requires inspecting them.]"
                                ));
                                result.push(AIMessage::from(&unavailable));
                            } else {
                                return Err(err);
                            }
                        }
                    }
                }
                MessageContent::ToolResult { .. } => {
                    if !attach_images {
                        result.push(AIMessage::from(msg));
                        continue;
                    }
                    let mut ai = AIMessage::from(msg.clone());
                    if let Some(atts) = ai.tool_image_attachments.take() {
                        if !atts.is_empty() {
                            if keep_this_message_images {
                                let next_count = attached_image_count + atts.len();
                                if next_count > limits.max_images_per_request {
                                    return Err(OpenBitFunError::validation(format!(
                                        "Too many images in one request: {} > {}",
                                        next_count, limits.max_images_per_request
                                    )));
                                }
                                attached_image_count = next_count;
                                ai.tool_image_attachments = Some(atts);
                            } else {
                                let dropped = atts.len();
                                let content_str = ai.content.as_deref().unwrap_or("");
                                ai.content = Some(format!(
                                    "{}\n\n[{} image(s) from this tool result omitted: only the latest {} message(s) in the conversation that contain images are sent to the model.]",
                                    content_str.trim_end(),
                                    dropped,
                                    MAX_IMAGE_BEARING_MESSAGE_ROUNDS
                                ));
                                ai.tool_image_attachments = None;
                            }
                        }
                    }
                    result.push(ai);
                }
                _ => result.push(AIMessage::from(msg)),
            }
        }

        if !prepended_reminders_injected {
            for reminder in trimmed_reminders {
                result.push(AIMessage::user(render_system_reminder(reminder)));
            }
        }

        Ok(result)
    }

    fn render_multimodal_as_text(text: &str, images: &[ImageContextData]) -> String {
        let mut content = text.to_string();

        if images.is_empty() {
            return content;
        }

        content.push_str("\n\n[Attached image(s):\n");
        for image in images {
            let name = image
                .metadata
                .as_ref()
                .and_then(|m| m.get("name"))
                .and_then(|v| v.as_str())
                .filter(|s| !s.is_empty())
                .map(str::to_string)
                .unwrap_or_else(|| image.id.clone());

            let path = image.image_path.as_deref().filter(|s| !s.trim().is_empty());

            if let Some(path) = path {
                content.push_str(&format!(
                    "- {} ({}, image_id={}, path={})\n",
                    name, image.mime_type, image.id, path
                ));
            } else {
                content.push_str(&format!(
                    "- {} ({}, image_id={})\n",
                    name, image.mime_type, image.id
                ));
            }
        }
        content.push_str("]\n");

        if images.iter().any(|image| image.image_path.is_some()) {
            content.push_str("The primary model cannot inspect image pixels directly. Use analyze_image with the exact attached path and the user's question before answering about image content. The configured image understanding model reads the pixels; do not ask the user to describe an attached image instead.\n");
        } else {
            content.push_str("Image pixels from this older message are unavailable. If the task requires them, ask the user to attach the image again.\n");
        }

        content
    }

    async fn resolve_compression_runtime_scaffold(
        &self,
        session: &Session,
        context: &ExecutionContext,
    ) -> OpenBitFunResult<CompressionRuntimeScaffold> {
        let agent_registry = get_agent_registry();
        agent_registry
            .load_custom_agents(
                context
                    .workspace
                    .as_ref()
                    .map(|workspace| workspace.root_path()),
            )
            .await;

        let current_agent = agent_registry
            .get_agent(
                &context.agent_type,
                context
                    .workspace
                    .as_ref()
                    .map(|workspace| workspace.root_path()),
            )
            .ok_or_else(|| {
                OpenBitFunError::NotFound(format!("Agent not found: {}", context.agent_type))
            })?;

        let (model_id, _) = self
            .resolve_model_id_for_turn(
                session,
                &context.agent_type,
                context.workspace.as_ref(),
                context.turn_index,
                context
                    .context
                    .get(INTERRUPTED_TURN_RESOLVED_MODEL_ID_METADATA_KEY)
                    .map(String::as_str),
                context
                    .context
                    .get(INTERRUPTED_TURN_MODEL_BINDING_FINGERPRINT_METADATA_KEY)
                    .map(String::as_str),
            )
            .await?;

        let ai_client_factory = get_global_ai_client_factory().await.map_err(|e| {
            OpenBitFunError::AIClient(format!("Failed to get AI client factory: {}", e))
        })?;
        let reasoning_preset = match self
            .resolve_reasoning_selection_for_turn(&session.session_id, context)
            .await
        {
            Ok(reasoning_preset) => reasoning_preset,
            Err(error) => {
                warn!(
                    "Failed to persist reasoning preset fallback; using Auto for this turn: session_id={}, error={}",
                    session.session_id, error
                );
                None
            }
        };
        let ai_client_result = if matches!(
            session.config.model_binding_policy,
            SessionModelBindingPolicy::ApprovedImmutable
        ) {
            ai_client_factory
                .get_client_by_approved_binding_with_reasoning_preset(
                    &model_id,
                    session
                        .config
                        .model_binding_fingerprint
                        .as_deref()
                        .unwrap_or_default(),
                    reasoning_preset.as_deref(),
                )
                .await
        } else {
            ai_client_factory
                .get_client_resolved_with_reasoning_preset(&model_id, reasoning_preset.as_deref())
                .await
        };
        let ai_client = match ai_client_result {
            Ok(ai_client) => ai_client,
            Err(error) => {
                if context
                    .context
                    .contains_key(INTERRUPTED_TURN_MODEL_BINDING_FINGERPRINT_METADATA_KEY)
                {
                    // Re-check the frozen binding after a factory failure so a
                    // config race is classified as recoverable contract drift,
                    // while credentials/provider/client construction failures
                    // remain ordinary execution failures.
                    Self::validate_frozen_model_contract(context).await?;
                }
                return Err(OpenBitFunError::AIClient(format!(
                    "Failed to get AI client (model_id={}): {}",
                    model_id, error
                )));
            }
        };
        let ai_client = apply_agent_temperature_override(current_agent.as_ref(), ai_client);
        Self::validate_frozen_model_contract(context).await?;
        Self::validate_frozen_reasoning_contract(context, ai_client.as_ref())?;
        let model_request_context = Self::model_request_context(
            session.effective_prompt_cache_lineage_id(),
            &context.context,
        );

        let primary_model_facts = Self::resolve_primary_model_context(
            &model_id,
            session.config.model_binding_policy,
            &ai_client.config.model,
            &ai_client.config.format,
            "Config service unavailable, assuming compression model is text-only for image input gating",
        )
        .await;
        let resolved_primary_model_id = primary_model_facts.model_id.clone();
        let primary_supports_image_understanding = primary_model_facts.supports_image_inputs;

        let model_capability_profile = ModelCapabilityProfile::from_resolved_model(
            &resolved_primary_model_id,
            &ai_client.config.model,
        );
        let is_review_subagent = agent_registry
            .get_subagent_is_review(&context.agent_type)
            .unwrap_or(false);
        let context_profile_policy = ContextProfilePolicy::for_agent_context(
            &context.agent_type,
            is_review_subagent,
            model_capability_profile,
        );

        let tool_policy = agent_registry
            .get_agent_tool_policy(
                &context.agent_type,
                context
                    .workspace
                    .as_ref()
                    .map(|workspace| workspace.root_path()),
            )
            .await;
        let allowed_tools = tool_policy.allowed_tools.clone();
        let enable_tools = context
            .context
            .get("enable_tools")
            .and_then(|value| value.parse::<bool>().ok())
            .unwrap_or(true);
        let tool_manifest_context_vars = context.context.clone();

        let tool_description_context = tool_context_runtime::build_tool_description_context(
            &context.agent_type,
            context.workspace.as_ref(),
            context.workspace_services.as_ref(),
            Some(&context.session_id),
            context.terminal_port.as_ref(),
            context.remote_exec_port.as_ref(),
            Some(&primary_model_facts),
            &tool_manifest_context_vars,
            &context.runtime_tool_restrictions,
        );
        let tool_manifest = if enable_tools {
            let manifest = resolve_tool_manifest(
                &allowed_tools,
                &tool_policy.exposure_overrides,
                &tool_description_context,
            )
            .await;
            Some(manifest)
        } else {
            None
        };
        let tool_listing_sections = if let Some(manifest) = tool_manifest.as_ref() {
            Self::build_tool_listing_sections(manifest, &tool_description_context).await
        } else {
            ToolListingSections::default()
        };
        let runtime_context_needs = tool_manifest
            .as_ref()
            .map(|manifest| {
                RuntimeContextNeeds::from_tool_names(manifest.allowed_tool_names.iter())
            })
            .unwrap_or_default();
        // Snapshot prompt-visible tool definitions once for this turn. Do not
        // re-resolve or rewrite them after GetToolSpec loads a deferred tool spec:
        // the loaded detail travels in tool results, while mutating the tool
        // definitions would change the request prefix and trigger provider
        // prefix/KV cache misses on subsequent rounds.
        let tool_definitions = tool_manifest.map(|manifest| manifest.tool_definitions);

        let turn_prompt_scaffold = self
            .resolve_turn_prompt_scaffold(TurnPromptScaffoldInput {
                context,
                current_agent: current_agent.as_ref(),
                model_name: &ai_client.config.model,
                supports_image_understanding: primary_supports_image_understanding,
                tool_listing_sections,
                runtime_context_needs,
                stage: "compression_scaffold",
            })
            .await?;

        Ok(CompressionRuntimeScaffold {
            ai_client,
            model_request_context,
            tool_definitions,
            system_prompt_message: turn_prompt_scaffold.system_prompt_message,
            prepended_prompt_reminders: turn_prompt_scaffold.prepended_prompt_reminders,
            primary_supports_image_understanding,
            compression_contract_limit: context_profile_policy.compression_contract_limit,
        })
    }

    /// Plain assistant text of a message, when it has any.
    fn assistant_message_text(message: &Message) -> Option<&str> {
        match &message.content {
            MessageContent::Text(text) => Some(text.as_str()),
            MessageContent::Multimodal { text, .. } => Some(text.as_str()),
            _ => None,
        }
        .map(str::trim)
        .filter(|text| !text.is_empty())
    }

    /// Native hook session facts for a compaction or turn-lifecycle dispatch.
    fn native_hook_facts<'a>(
        session_id: &'a str,
        dialog_turn_id: &'a str,
        workspace: Option<&'a WorkspaceBinding>,
        model: &'a str,
    ) -> NativeHookSessionFacts<'a> {
        NativeHookSessionFacts {
            session_id,
            turn_id: Some(dialog_turn_id),
            workspace_root: workspace.map(|workspace| workspace.root_path()),
            is_remote_workspace: workspace.is_some_and(|workspace| workspace.is_remote()),
            model,
            bypass_permissions: false,
        }
    }

    /// Compact the current session context outside the normal dialog execution loop.
    /// Always emits compression started/completed/failed events for the provided turn.
    #[allow(clippy::too_many_arguments)]
    pub(crate) async fn compact_session_context(
        &self,
        session_id: String,
        dialog_turn_id: String,
        compression_id: String,
        context: ExecutionContext,
        messages: Vec<Message>,
        trigger: &str,
        cancellation_token: CancellationToken,
        commit_gate: Arc<ManualCompactionCommitGate>,
    ) -> OpenBitFunResult<ContextCompactionOutcome> {
        let mut session = self
            .session_manager
            .get_session(&session_id)
            .ok_or_else(|| {
                OpenBitFunError::NotFound(format!("Session not found: {}", session_id))
            })?;
        let start_time = std::time::Instant::now();
        let preparation = prepare_compression_cancellable(&cancellation_token, async {
            let scaffold = self
                .resolve_compression_runtime_scaffold(&session, &context)
                .await?;
            native_hooks::dispatch_pre_compact(
                Self::native_hook_facts(
                    &session_id,
                    &dialog_turn_id,
                    context.workspace.as_ref(),
                    &scaffold.ai_client.config.model,
                ),
                trigger,
            )
            .await;
            let context_window = (scaffold.ai_client.config.context_window as usize)
                .min(session.config.max_context_tokens);
            let prepended_reminders = scaffold.prepended_prompt_reminders.ordered_reminders();
            let prepended_reminder_tokens =
                Self::prepended_reminder_tokens_for_pressure(&prepended_reminders);
            let compression_trigger_budget = Self::compression_trigger_budget(
                context_window,
                scaffold.ai_client.config.max_tokens,
            );
            let mut runtime_messages = vec![scaffold.system_prompt_message.clone()];
            runtime_messages.extend(messages.clone());
            let before_pressure = Self::estimate_auto_compression_pressure(
                &runtime_messages,
                scaffold.tool_definitions.as_deref(),
                context_window,
                compression_trigger_budget,
                prepended_reminder_tokens,
            );

            self.emit_event(
                AgenticEvent::ContextCompressionStarted {
                    session_id: session_id.to_string(),
                    turn_id: dialog_turn_id.to_string(),
                    compression_id: compression_id.clone(),
                    trigger: trigger.to_string(),
                    tokens_before: before_pressure.total_tokens,
                    context_window,
                },
                EventPriority::Normal,
            )
            .await;

            let compression_contract = self
                .session_manager
                .compression_contract_for_session(&session_id, scaffold.compression_contract_limit);
            let model_exchange_trace_dir = self
                .session_manager
                .persistent_model_exchange_trace_dir(&session_id)
                .await;
            let trace_config = prepare_model_exchange_trace_for_workspace(
                &session_id,
                &dialog_turn_id,
                context.workspace.as_ref(),
                model_exchange_trace_dir.as_deref(),
                ModelExchangeTraceOperation {
                    kind: "context_compression",
                    id: &compression_id,
                    trigger: Some(trigger),
                },
                scaffold.ai_client.as_ref(),
            )
            .await;
            let mut planned_result = self
                .build_planned_compression_result(
                    &session_id,
                    &dialog_turn_id,
                    &runtime_messages,
                    context_window,
                    compression_contract,
                    scaffold.ai_client.clone(),
                    &scaffold.model_request_context,
                    &scaffold.tool_definitions,
                    &scaffold.prepended_prompt_reminders,
                    scaffold.primary_supports_image_understanding,
                    context.workspace.as_ref(),
                    context.workspace_services.as_ref(),
                    trace_config,
                )
                .await?;
            if let Some(compression_result) = planned_result.as_mut() {
                let boundary_turn_index = self
                    .session_manager
                    .get_turn_count(&session_id)
                    .saturating_sub(1);
                match self
                    .session_manager
                    .create_compression_transcript_reference(
                        &session_id,
                        boundary_turn_index,
                        &compression_id,
                        trigger,
                    )
                    .await
                {
                    Ok(Some(reference)) => {
                        self.context_compressor.append_transcript_reference(
                            compression_result,
                            &reference.uri,
                            &reference.index_range,
                        );
                    }
                    Ok(None) => {}
                    Err(error) => warn!(
                        "Failed to create manual compression transcript; continuing without reference: session_id={}, turn_id={}, error={}",
                        session_id, dialog_turn_id, error
                    ),
                }
            }
            Ok((scaffold, before_pressure, planned_result))
        })
        .await;
        let (scaffold, before_pressure, planned_result) = match preparation {
            Ok(result) => result,
            Err(err) => {
                self.emit_event(
                    AgenticEvent::ContextCompressionFailed {
                        session_id: session_id.clone(),
                        turn_id: dialog_turn_id.clone(),
                        compression_id: compression_id.clone(),
                        error: err.to_string(),
                    },
                    EventPriority::High,
                )
                .await;
                return Err(manual_compaction_terminal_error(err));
            }
        };
        let context_window = before_pressure.context_window;
        let compression_trigger_budget =
            Self::compression_trigger_budget(context_window, scaffold.ai_client.config.max_tokens);
        let prepended_reminders = scaffold.prepended_prompt_reminders.ordered_reminders();
        let prepended_reminder_tokens =
            Self::prepended_reminder_tokens_for_pressure(&prepended_reminders);
        let planned_result = if commit_gate.try_begin_commit() {
            Ok(planned_result)
        } else {
            Err(OpenBitFunError::Cancelled(
                "Manual context compaction cancelled".to_string(),
            ))
        };
        match planned_result {
            Ok(Some(compression_result)) => {
                let compressed_messages = compression_result.messages;
                self.session_manager
                    .replace_context_messages(&session_id, compressed_messages.clone())
                    .await;
                if self
                    .session_manager
                    .rebuild_skill_agent_listing_baseline_to_latest(&session_id)
                    .await
                {
                    debug!(
                        "Rebuilt skill-agent listing baseline after manual compaction: session_id={}",
                        session_id
                    );
                }
                self.session_manager
                    .invalidate_prompt_cache(
                        &session_id,
                        crate::agentic::session::PromptCacheScope::All,
                        "manual_context_compaction_applied",
                    )
                    .await;

                session.compression_state.increment_compression_count();
                let compression_count = session.compression_state.compression_count;
                let _ = self
                    .session_manager
                    .update_compression_state(&session_id, session.compression_state.clone())
                    .await;

                let duration_ms = elapsed_ms_u64(start_time);
                let mut compressed_runtime_messages = vec![scaffold.system_prompt_message.clone()];
                compressed_runtime_messages.extend(compressed_messages.clone());
                let after_pressure = Self::estimate_auto_compression_pressure(
                    &compressed_runtime_messages,
                    scaffold.tool_definitions.as_deref(),
                    context_window,
                    compression_trigger_budget,
                    prepended_reminder_tokens,
                );
                let tokens_after = after_pressure.total_tokens;
                let compression_ratio = if before_pressure.total_tokens == 0 {
                    1.0
                } else {
                    (tokens_after as f64) / (before_pressure.total_tokens as f64)
                };
                info!(
                    "Manual compression completed: session_id={}, turn_id={}, total_tokens {} -> {}, system_tokens {} -> {}, tool_tokens {} -> {}, prepended_reminder_tokens {} -> {}, conversation_tokens {} -> {}, context_window={}, input_limit={}, output_reserve={}, safety_reserve={}, usage {:.3} -> {:.3}, compression_count={}, duration_ms={}, summary_source={}",
                    session_id,
                    dialog_turn_id,
                    before_pressure.total_tokens,
                    after_pressure.total_tokens,
                    before_pressure.system_tokens,
                    after_pressure.system_tokens,
                    before_pressure.tool_tokens,
                    after_pressure.tool_tokens,
                    before_pressure.prepended_reminder_tokens,
                    after_pressure.prepended_reminder_tokens,
                    before_pressure.conversation_tokens,
                    after_pressure.conversation_tokens,
                    before_pressure.context_window,
                    before_pressure.input_limit,
                    before_pressure.output_reserve_tokens,
                    before_pressure.safety_reserve_tokens,
                    before_pressure.usage_ratio,
                    after_pressure.usage_ratio,
                    compression_count,
                    duration_ms,
                    "model"
                );

                self.emit_event(
                    AgenticEvent::ContextCompressionCompleted {
                        session_id: session_id.to_string(),
                        turn_id: dialog_turn_id.to_string(),
                        compression_id: compression_id.clone(),
                        compression_count,
                        tokens_before: before_pressure.total_tokens,
                        tokens_after,
                        compression_ratio,
                        duration_ms,
                        has_summary: true,
                        summary_source: "model".to_string(),
                        applied: true,
                    },
                    EventPriority::Normal,
                )
                .await;

                native_hooks::dispatch_post_compact(
                    Self::native_hook_facts(
                        &session_id,
                        &dialog_turn_id,
                        context.workspace.as_ref(),
                        &scaffold.ai_client.config.model,
                    ),
                    trigger,
                )
                .await;

                Ok(ContextCompactionOutcome {
                    compression_id,
                    compression_count,
                    tokens_before: before_pressure.total_tokens,
                    tokens_after,
                    compression_ratio,
                    duration_ms,
                    has_summary: true,
                    summary_source: "model".to_string(),
                    applied: true,
                })
            }
            Ok(None) => {
                let duration_ms = elapsed_ms_u64(start_time);
                let tokens_after = before_pressure.total_tokens;
                let compression_ratio = if before_pressure.total_tokens == 0 {
                    1.0
                } else {
                    (tokens_after as f64) / (before_pressure.total_tokens as f64)
                };
                info!(
                    "Manual compression skipped: session_id={}, turn_id={}, reason=no_eligible_prefix, total_tokens={}, duration_ms={}",
                    session_id, dialog_turn_id, before_pressure.total_tokens, duration_ms
                );
                self.emit_event(
                    AgenticEvent::ContextCompressionCompleted {
                        session_id: session_id.to_string(),
                        turn_id: dialog_turn_id.to_string(),
                        compression_id: compression_id.clone(),
                        compression_count: session.compression_state.compression_count,
                        tokens_before: before_pressure.total_tokens,
                        tokens_after,
                        compression_ratio,
                        duration_ms,
                        has_summary: false,
                        summary_source: "none".to_string(),
                        applied: false,
                    },
                    EventPriority::Normal,
                )
                .await;
                Ok(ContextCompactionOutcome {
                    compression_id,
                    compression_count: session.compression_state.compression_count,
                    tokens_before: before_pressure.total_tokens,
                    tokens_after,
                    compression_ratio,
                    duration_ms,
                    has_summary: false,
                    summary_source: "none".to_string(),
                    applied: false,
                })
            }
            Err(err) => {
                self.emit_event(
                    AgenticEvent::ContextCompressionFailed {
                        session_id: session_id.to_string(),
                        turn_id: dialog_turn_id.to_string(),
                        compression_id: compression_id.clone(),
                        error: err.to_string(),
                    },
                    EventPriority::High,
                )
                .await;

                Err(manual_compaction_terminal_error(err))
            }
        }
    }

    /// Execute a complete dialog turn (may contain multiple model rounds)
    /// Returns ExecutionResult containing the final response and all newly generated messages
    pub async fn execute_dialog_turn(
        &self,
        agent_type: String,
        initial_messages: Vec<Message>,
        context: ExecutionContext,
    ) -> OpenBitFunResult<ExecutionResult> {
        let start_time = std::time::Instant::now();
        let dialog_turn_id = context.dialog_turn_id.clone();
        self.generation_messages
            .remove(&(context.session_id.clone(), dialog_turn_id.clone()));

        info!("Starting dialog turn: dialog_turn_id={}", dialog_turn_id);

        // Execute actual logic
        let result = self
            .execute_dialog_turn_impl(agent_type, initial_messages, context, start_time)
            .await;

        // Cleanup cancellation token
        self.round_executor
            .cleanup_dialog_turn(&dialog_turn_id)
            .await;
        debug!(
            "Cleaned up cancel token (final cleanup): dialog_turn_id={}",
            dialog_turn_id
        );

        result
    }

    /// Internal implementation of dialog turn execution
    async fn execute_dialog_turn_impl(
        &self,
        agent_type: String,
        initial_messages: Vec<Message>,
        context: ExecutionContext,
        start_time: std::time::Instant,
    ) -> OpenBitFunResult<ExecutionResult> {
        let dialog_turn_id = context.dialog_turn_id.clone();
        let initial_count = initial_messages.len();

        debug!(
            "Executing dialog turn implementation: dialog_turn_id={}",
            dialog_turn_id
        );

        // Things that remain constant in a dialog turn: 1.agent, 2.system prompt, 3.tools, 4.ai client
        // 1. Get current agent
        let agent_registry = get_agent_registry();
        agent_registry
            .load_custom_agents(
                context
                    .workspace
                    .as_ref()
                    .map(|workspace| workspace.root_path()),
            )
            .await;
        let current_agent = agent_registry
            .get_agent(
                &agent_type,
                context
                    .workspace
                    .as_ref()
                    .map(|workspace| workspace.root_path()),
            )
            .ok_or_else(|| OpenBitFunError::NotFound(format!("Agent not found: {}", agent_type)))?;
        info!(
            "Current Agent: {} ({})",
            current_agent.name(),
            current_agent.id()
        );

        let session = self
            .session_manager
            .get_session(&context.session_id)
            .ok_or_else(|| {
                OpenBitFunError::Session(format!("Session not found: {}", context.session_id))
            })?;

        // 2. Get AI client
        let original_user_input = context
            .context
            .get("original_user_input")
            .cloned()
            .unwrap_or_default();

        // Edit constraint guard: process each distinct user instruction once.
        // The fast extractor receives the active state so explicit additions
        // and revocations form an auditable session-persistent state machine.
        if !original_user_input.trim().is_empty() {
            let revocation_authorized = context
                .context
                .get("edit_constraint_revocation_authorized")
                .is_some_and(|value| value == "true");
            let message_sha256 = crate::agentic::execution::edit_constraint_guard::message_sha256(
                &original_user_input,
            );
            let already_processed = self
                .session_manager
                .edit_constraint_state(&context.session_id)
                .is_some_and(|state| {
                    state.message_processed(&context.dialog_turn_id, &message_sha256)
                });
            if !already_processed {
                let active_constraints = self
                    .session_manager
                    .edit_constraints(&context.session_id)
                    .unwrap_or_default();
                let mut extraction = crate::agentic::execution::edit_constraint_guard::extract_constraints_with_active_and_revocation_authorization(
                    &original_user_input,
                    &active_constraints,
                    revocation_authorized,
                )
                .await;
                extraction.dialog_turn_id = Some(context.dialog_turn_id.clone());
                if crate::agentic::execution::edit_constraint_guard::extraction_requires_session_state(
                    &extraction,
                ) {
                    self.session_manager
                        .remember_edit_constraint_extraction(&context.session_id, extraction)
                        .await;
                }
            }
        }

        let (model_id, _) = self
            .resolve_model_id_for_turn(
                &session,
                &agent_type,
                context.workspace.as_ref(),
                context.turn_index,
                context
                    .context
                    .get(INTERRUPTED_TURN_RESOLVED_MODEL_ID_METADATA_KEY)
                    .map(String::as_str),
                context
                    .context
                    .get(INTERRUPTED_TURN_MODEL_BINDING_FINGERPRINT_METADATA_KEY)
                    .map(String::as_str),
            )
            .await?;
        info!(
            "Agent using model: agent={}, resolved_model_id={}",
            current_agent.name(),
            model_id
        );

        let ai_client_factory = get_global_ai_client_factory().await.map_err(|e| {
            OpenBitFunError::AIClient(format!("Failed to get AI client factory: {}", e))
        })?;

        // Get AI client by model ID
        let reasoning_preset = match self
            .resolve_reasoning_selection_for_turn(&session.session_id, &context)
            .await
        {
            Ok(reasoning_preset) => reasoning_preset,
            Err(error) => {
                warn!(
                    "Failed to persist reasoning preset fallback; using Auto for this turn: session_id={}, error={}",
                    session.session_id, error
                );
                None
            }
        };
        let ai_client_result = if matches!(
            session.config.model_binding_policy,
            SessionModelBindingPolicy::ApprovedImmutable
        ) {
            ai_client_factory
                .get_client_by_approved_binding_with_reasoning_preset(
                    &model_id,
                    session
                        .config
                        .model_binding_fingerprint
                        .as_deref()
                        .unwrap_or_default(),
                    reasoning_preset.as_deref(),
                )
                .await
        } else {
            ai_client_factory
                .get_client_resolved_with_reasoning_preset(&model_id, reasoning_preset.as_deref())
                .await
        };
        let ai_client = match ai_client_result {
            Ok(ai_client) => ai_client,
            Err(error) => {
                if context
                    .context
                    .contains_key(INTERRUPTED_TURN_MODEL_BINDING_FINGERPRINT_METADATA_KEY)
                {
                    Self::validate_frozen_model_contract(&context).await?;
                }
                return Err(OpenBitFunError::AIClient(format!(
                    "Failed to get AI client (model_id={}): {}",
                    model_id, error
                )));
            }
        };
        let ai_client = apply_agent_temperature_override(current_agent.as_ref(), ai_client);
        Self::validate_frozen_model_contract(&context).await?;
        Self::validate_frozen_reasoning_contract(&context, ai_client.as_ref())?;
        let model_request_context = Self::model_request_context(
            session.effective_prompt_cache_lineage_id(),
            &context.context,
        );

        // Primary model vision capability (tools + system prompt appendix; also used below for API message stripping).
        let primary_model_facts = Self::resolve_primary_model_context(
            &model_id,
            session.config.model_binding_policy,
            &ai_client.config.model,
            &ai_client.config.format,
            "Config service unavailable, assuming primary model is text-only for image input gating",
        )
        .await;
        let resolved_primary_model_id = primary_model_facts.model_id.clone();
        let primary_supports_image_understanding = primary_model_facts.supports_image_inputs;

        let model_context_window = ai_client.config.context_window as usize;
        let session_max_tokens = session.config.max_context_tokens;
        let context_window = model_context_window.min(session_max_tokens);
        if model_context_window != session_max_tokens {
            debug!(
                "Context window: model={}, session_config={}, effective={}",
                model_context_window, session_max_tokens, context_window
            );
        }

        let model_capability_profile = ModelCapabilityProfile::from_resolved_model(
            &resolved_primary_model_id,
            &ai_client.config.model,
        );
        let is_review_subagent = agent_registry
            .get_subagent_is_review(&agent_type)
            .unwrap_or(false);
        let context_profile_policy = ContextProfilePolicy::for_agent_context(
            &agent_type,
            is_review_subagent,
            model_capability_profile,
        );
        debug!(
            "Context profile policy selected: session_id={}, agent_type={}, profile={:?}, model_capability={:?}, compression_contract_limit={}, subagent_concurrency_cap={}, repeated_tool_signature_threshold={}, consecutive_failed_command_threshold={}",
            context.session_id,
            agent_type,
            context_profile_policy.profile,
            model_capability_profile,
            context_profile_policy.compression_contract_limit,
            context_profile_policy.subagent_concurrency_cap,
            context_profile_policy.repeated_tool_signature_threshold,
            context_profile_policy.consecutive_failed_command_threshold
        );

        // 3. Get available tools list (read tool configuration for current mode from global config)
        let tool_policy = agent_registry
            .get_agent_tool_policy(
                &agent_type,
                context
                    .workspace
                    .as_ref()
                    .map(|workspace| workspace.root_path()),
            )
            .await;
        let allowed_tools = tool_policy.allowed_tools.clone();
        let enable_tools = context
            .context
            .get("enable_tools")
            .and_then(|v| v.parse::<bool>().ok())
            .unwrap_or(true);
        let deferred_tool_loading_enabled = match get_global_config_service().await {
            Ok(service) => service
                .get_config::<bool>(Some("ai.enable_deferred_tool_loading"))
                .await
                .unwrap_or(true),
            Err(_) => true,
        };
        let mut execution_context_vars = context.context.clone();
        execution_context_vars.insert(
            "enable_deferred_tool_loading".to_string(),
            deferred_tool_loading_enabled.to_string(),
        );
        execution_context_vars.insert("turn_index".to_string(), context.turn_index.to_string());
        let tool_manifest_context_vars = execution_context_vars.clone();

        let tool_description_context = tool_context_runtime::build_tool_description_context(
            &agent_type,
            context.workspace.as_ref(),
            context.workspace_services.as_ref(),
            Some(&context.session_id),
            context.terminal_port.as_ref(),
            context.remote_exec_port.as_ref(),
            Some(&primary_model_facts),
            &tool_manifest_context_vars,
            &context.runtime_tool_restrictions,
        );

        let tool_manifest = if enable_tools {
            debug!(
                "Agent tools: agent={}, tool_count={}",
                agent_type,
                allowed_tools.len()
            );
            let manifest = resolve_tool_manifest(
                &allowed_tools,
                &tool_policy.exposure_overrides,
                &tool_description_context,
            )
            .await;
            Some(manifest)
        } else {
            None
        };
        let deferred_tools = tool_manifest
            .as_ref()
            .map(|manifest| manifest.deferred_tool_names.clone())
            .unwrap_or_default();
        let tool_listing_sections = if let Some(manifest) = tool_manifest.as_ref() {
            Self::build_tool_listing_sections(manifest, &tool_description_context).await
        } else {
            ToolListingSections::default()
        };
        let runtime_context_needs = tool_manifest
            .as_ref()
            .map(runtime_context_needs_for_manifest)
            .unwrap_or_default();
        // We do not currently keep a session-level cache of resolved tool
        // definitions; each turn re-resolves them from the current manifest.
        // Expected changes therefore come from user-driven configuration or
        // product-version changes, such as:
        // - agent_type / mode changes
        // - the user editing the enabled tool set for the current agent
        // - MCP tool enablement / settings changes
        // - a newer product build changing built-in tool definitions
        //
        // Outside those cases, tool definitions should remain byte-stable
        // across the session. Avoid introducing extra turn-to-turn variation:
        // it changes the request prefix and causes provider prefix/KV cache
        // misses.
        let (available_tools, tool_definitions) = if let Some(manifest) = tool_manifest {
            (manifest.allowed_tool_names, Some(manifest.tool_definitions))
        } else {
            (vec![], None)
        };
        let final_tool_names = Self::finalize_tool_names(tool_definitions.as_deref());
        debug!(
            "Primary model and tool manifest resolved: session_id={}, turn_id={}, resolved_primary_model_id={}, primary_model_api_format={}, primary_model_supports_image_inputs={}, final_tool_count={}, final_tool_names={:?}, deferred_tool_names={:?}",
            context.session_id,
            context.dialog_turn_id,
            primary_model_facts.model_id,
            primary_model_facts.api_format,
            primary_model_facts.supports_image_inputs,
            final_tool_names.len(),
            final_tool_names,
            deferred_tools,
        );

        // 4. Resolve the prompt scaffold used by model requests in this turn.
        // It is refreshed after successful context compression so the first
        // post-compaction request builds the new provider-side prefix cache.
        let mut turn_prompt_scaffold = self
            .resolve_turn_prompt_scaffold(TurnPromptScaffoldInput {
                context: &context,
                current_agent: current_agent.as_ref(),
                model_name: &ai_client.config.model,
                supports_image_understanding: primary_supports_image_understanding,
                tool_listing_sections: tool_listing_sections.clone(),
                runtime_context_needs,
                stage: "turn_start",
            })
            .await?;

        // Add System Prompt to the beginning of message list (only for this execution, not persisted)
        let mut messages = vec![turn_prompt_scaffold.system_prompt_message.clone()];
        messages.extend(initial_messages);
        // Keep this generation's append-only transcript separate from the
        // mutable request history. Context compression may replace `messages`
        // wholesale, but durable recovered-Turn completion must still append
        // every assistant/tool/injection message produced by this generation.

        let mut round_index = initial_round_index(&context.context);
        let mut completed_rounds = 0usize;
        let mut total_tools = 0;
        let mut last_partial_recovery_reason: Option<String> = None;
        let mut finalization_reason: Option<&'static str> = None;
        let mut main_context_overflow_recoveries = 0usize;
        let mut active_round_lifecycle: Option<ModelRoundLifecycle> = None;

        // Track tool-call patterns for context health, but only use rounds with
        // actual failed tool results for no-progress recovery decisions.
        let mut recent_tool_signatures: Vec<String> = Vec::new();
        let mut recent_failed_tool_signatures: Vec<String> = Vec::new();
        let mut failed_tool_recovery_attempts: usize = 0;
        const MAX_FAILED_TOOL_RECOVERY_ATTEMPTS: usize = 3;
        const MAX_PARTIAL_CONTINUATION_ATTEMPTS: usize = 3;
        let mut full_compression_count = 0usize;
        let compression_failure_count = 0u32;

        // Save the last token usage statistics
        let mut last_usage: Option<crate::util::types::ai::GeminiUsage> = None;

        // Track thinking-only rescue reminders for observability. This counter
        // is not a stop condition.
        let mut thinking_only_rescue_attempts: usize = 0;
        let mut partial_continuation_attempts: usize = 0;
        // Bounds how often Stop hooks may reopen a finished turn.
        let mut stop_hook_continuations: usize = 0;
        const MAX_STOP_HOOK_CONTINUATIONS: usize = 3;

        // Add detailed logging showing the execution context messages.
        debug!(
            "Executing dialog turn: dialog_turn_id={}, mode={}, agent={}, initial_messages={}, messages_len={}",
            dialog_turn_id,
            current_agent.name(),
            context.agent_type,
            initial_count,
            messages.len()
        );
        trace!(
            "Context message details: dialog_turn_id={}, session_id={}, roles={:?}",
            dialog_turn_id,
            context.session_id,
            messages
                .iter()
                .map(|m| format!("{:?}", m.role))
                .collect::<Vec<_>>()
        );

        let enable_context_compression = session.config.enable_context_compression;
        let prefetch_enabled = match get_global_config_service().await {
            Ok(service) => service
                .get_config::<bool>(Some("ai.enable_context_compression_prefetch"))
                .await
                .unwrap_or(true),
            Err(_) => true,
        };
        // Execution-local ownership deliberately prevents cross-turn reuse. Drop
        // cancels both pending IO and backoff on every exit path.
        let mut compression_prefetch: Option<PrefetchedCompression> = None;
        let compression_trigger_budget =
            Self::compression_trigger_budget(context_window, ai_client.config.max_tokens);

        // Project images at the provider boundary on every round. Keep the
        // canonical pixels and paths so steering, retries, and model switches
        // retain the same attachments.

        let attachment_context = ToolUseContext::for_tool_listing(
            context.workspace.clone(),
            context.workspace_services.clone(),
        );
        // Older turn metadata may still hold inline pixels even when its context
        // snapshot predates durable attachments. Inline pixels also supersede
        // old temporary/controller paths, which may no longer exist. Recover
        // them without changing the record shape or requiring manual migration.
        for message in &mut messages {
            if let MessageContent::Multimodal { images, .. } = &mut message.content {
                if !images.iter().any(|image| image.data_url.is_some()) {
                    continue;
                }
                if let Err(error) =
                    crate::agentic::image_analysis::attachments::prepare_inline_image_attachments(
                        images,
                        &attachment_context,
                    )
                    .await
                {
                    if message.metadata.turn_id.as_deref() == Some(context.dialog_turn_id.as_str())
                    {
                        return Err(error);
                    }
                    warn!(
                        "Unable to recover historical image attachment: message_id={}, error={}",
                        message.id, error
                    );
                }
            }
        }

        // Loop to execute model rounds
        loop {
            if self
                .round_executor
                .is_dialog_turn_cancelled(&dialog_turn_id)
            {
                return Err(OpenBitFunError::Cancelled("Dialog cancelled".to_string()));
            }
            if reached_fixed_model_round_limit(self.config.max_rounds, completed_rounds) {
                warn!(
                    "Reached max rounds limit: {}, stopping execution",
                    self.config.max_rounds
                );
                finalization_reason = Some("max_rounds");
                break;
            }

            // Check and compress before sending AI request
            //
            // NOTE: There used to be a "microcompact" pre-pass here that
            // silently rewrote older tool-result contents into a placeholder.
            // It has been removed: it mutated already-sent message prefixes —
            // killing provider KV-cache hits on every round — and stripped the
            // model of memory of what it had already done, which directly
            // drove repetitive tool-call loops in long exploratory subagents
            // (see deep-review subagent loop incident, 2026-05-12).
            //
            // The remaining context-pressure layers are:
            //   - L1: AI-summary based full compression (preserves semantics).
            //   - L2: Emergency truncation (only if tokens still exceed the
            //         provider context window after L1).
            let pressure_prepended_reminders = turn_prompt_scaffold
                .prepended_prompt_reminders
                .ordered_reminders();
            let pressure_prepended_reminder_tokens =
                Self::prepended_reminder_tokens_for_pressure(&pressure_prepended_reminders);
            let token_anchor_selection = self
                .session_manager
                .select_latest_matching_token_anchor(&context.session_id, &messages)
                .await;
            let (token_pressure, anchor_details) =
                Self::estimate_auto_compression_pressure_with_anchor(
                    &messages,
                    tool_definitions.as_deref(),
                    context_window,
                    compression_trigger_budget,
                    token_anchor_selection.selected.as_ref(),
                    pressure_prepended_reminder_tokens,
                );
            if let Some(details) = anchor_details.as_ref() {
                debug!(
                    "Token pressure estimate: session_id={}, turn_id={}, round_index={}, source=provider_anchor, anchor_id={}, prefix_messages={}, input_tokens={}, adjusted_anchor_tokens={}, tail_tokens={}, system_tokens_at_anchor={}, current_system_tokens={}, system_delta={}, tool_tokens_at_anchor={}, current_tool_tokens={}, tool_delta={}, prepended_reminder_tokens_at_anchor={}, current_prepended_reminder_tokens={}, prepended_reminder_delta={}, total_tokens={}, system_tokens={}, tool_tokens={}, prepended_reminder_tokens={}, conversation_tokens={}, context_window={}, input_limit={}, output_reserve={}, safety_reserve={}, usage={:.3}",
                    context.session_id,
                    context.dialog_turn_id,
                    round_index,
                    details.anchor_id,
                    details.prefix_message_count,
                    details.input_tokens,
                    details.adjusted_anchor_tokens,
                    details.tail_tokens,
                    details.system_tokens_at_anchor,
                    details.current_system_tokens,
                    details.system_delta,
                    details.tool_tokens_at_anchor,
                    details.current_tool_tokens,
                    details.tool_delta,
                    details.prepended_reminder_tokens_at_anchor,
                    details.current_prepended_reminder_tokens,
                    details.prepended_reminder_delta,
                    token_pressure.total_tokens,
                    token_pressure.system_tokens,
                    token_pressure.tool_tokens,
                    token_pressure.prepended_reminder_tokens,
                    token_pressure.conversation_tokens,
                    token_pressure.context_window,
                    token_pressure.input_limit,
                    token_pressure.output_reserve_tokens,
                    token_pressure.safety_reserve_tokens,
                    token_pressure.usage_ratio
                );
                if !token_anchor_selection.skipped.is_empty() {
                    trace!(
                        "Token anchor selection skipped newer anchors before match: session_id={}, turn_id={}, round_index={}, selected_anchor_id={}, skipped={:?}",
                        context.session_id,
                        context.dialog_turn_id,
                        round_index,
                        details.anchor_id,
                        token_anchor_selection.skipped
                    );
                }
            } else {
                debug!(
                    "Token pressure estimate: session_id={}, turn_id={}, round_index={}, source=full_estimate, total_tokens={}, system_tokens={}, tool_tokens={}, prepended_reminder_tokens={}, conversation_tokens={}, context_window={}, input_limit={}, output_reserve={}, safety_reserve={}, usage={:.3}, fallback_reasons={:?}",
                    context.session_id,
                    context.dialog_turn_id,
                    round_index,
                    token_pressure.total_tokens,
                    token_pressure.system_tokens,
                    token_pressure.tool_tokens,
                    token_pressure.prepended_reminder_tokens,
                    token_pressure.conversation_tokens,
                    token_pressure.context_window,
                    token_pressure.input_limit,
                    token_pressure.output_reserve_tokens,
                    token_pressure.safety_reserve_tokens,
                    token_pressure.usage_ratio,
                    token_anchor_selection.skipped
                );
            }
            debug!(
                "Round {} token usage before send: total={} / {}, conversation={} / {}, usage={:.1}%, input_limit={}, output_reserve={}, safety_reserve={}",
                round_index,
                token_pressure.total_tokens,
                token_pressure.context_window,
                token_pressure.conversation_tokens,
                token_pressure.context_window,
                token_pressure.usage_ratio * 100.0,
                token_pressure.input_limit,
                token_pressure.output_reserve_tokens,
                token_pressure.safety_reserve_tokens
            );

            let should_compress = enable_context_compression
                && token_pressure.total_tokens >= token_pressure.input_limit;
            let mut send_pressure_reusable = true;

            if !should_compress {
                if enable_context_compression
                    && prefetch_enabled
                    && compression_prefetch.is_none()
                    && openbitfun_agent_runtime::compression_prefetch::in_prefetch_window(
                        token_pressure.total_tokens,
                        token_pressure.input_limit,
                    )
                {
                    let prefetch_id = format!("prefetch_{}", uuid::Uuid::new_v4());
                    info!(
                        "Compression prefetch admitted: session_id={}, turn_id={}, round_index={}, total_tokens={}, prefetch_limit={}, input_limit={}, context_window={}",
                        context.session_id, context.dialog_turn_id, round_index,
                        token_pressure.total_tokens,
                        token_pressure.input_limit.saturating_sub(openbitfun_agent_runtime::compression_prefetch::PREFETCH_LEAD_TOKENS),
                        token_pressure.input_limit, context_window
                    );
                    let trace_dir = self
                        .session_manager
                        .persistent_model_exchange_trace_dir(&context.session_id)
                        .await;
                    let trace_config = prepare_model_exchange_trace_for_workspace(
                        &context.session_id,
                        &context.dialog_turn_id,
                        context.workspace.as_ref(),
                        trace_dir.as_deref(),
                        ModelExchangeTraceOperation {
                            kind: "context_compression_prefetch",
                            id: &prefetch_id,
                            trigger: Some("prefetch"),
                        },
                        ai_client.as_ref(),
                    )
                    .await;
                    let job = CompressionJob::new(
                        self.context_compressor.clone(),
                        &context.session_id,
                        context_window,
                        0,
                        CompressionModelSummaryInput {
                            ai_client: ai_client.clone(),
                            model_request_context: &model_request_context,
                            runtime_messages: &messages,
                            dialog_turn_id: &context.dialog_turn_id,
                            workspace: context.workspace.as_ref(),
                            workspace_services: context.workspace_services.as_ref(),
                            tool_definitions: &tool_definitions,
                            prepended_prompt_reminders: &turn_prompt_scaffold
                                .prepended_prompt_reminders,
                            primary_supports_image_understanding,
                            trace_config,
                        },
                    );
                    compression_prefetch = Some(
                        job.spawn_prefetch(
                            &self
                                .round_executor
                                .ensure_cancel_token(&context.dialog_turn_id),
                        ),
                    );
                }
                debug!(
                    "No compression needed: session={}, total_tokens={}, input_limit={}, context_window={}, output_reserve={}, safety_reserve={}, usage={:.1}%",
                    context.session_id,
                    token_pressure.total_tokens,
                    token_pressure.input_limit,
                    token_pressure.context_window,
                    token_pressure.output_reserve_tokens,
                    token_pressure.safety_reserve_tokens,
                    token_pressure.usage_ratio * 100.0
                );
            } else {
                info!(
                    "Triggering context compression: session={}, total_tokens={}, input_limit={}, context_window={}, output_reserve={}, safety_reserve={}, usage={:.1}%",
                    context.session_id,
                    token_pressure.total_tokens,
                    token_pressure.input_limit,
                    token_pressure.context_window,
                    token_pressure.output_reserve_tokens,
                    token_pressure.safety_reserve_tokens,
                    token_pressure.usage_ratio * 100.0
                );

                match self
                    .compress_messages(
                        &context.session_id,
                        &context.dialog_turn_id,
                        "auto",
                        messages.clone(),
                        token_pressure,
                        context_window,
                        ai_client.clone(),
                        &model_request_context,
                        &tool_definitions,
                        turn_prompt_scaffold.system_prompt_message.clone(),
                        &turn_prompt_scaffold.prepended_prompt_reminders,
                        primary_supports_image_understanding,
                        context_profile_policy.compression_contract_limit,
                        context.workspace.as_ref(),
                        context.workspace_services.as_ref(),
                        compression_prefetch.take(),
                    )
                    .await
                {
                    Ok(Some((compressed_tokens, compressed_messages))) => {
                        info!(
                            "Round {} compression completed: messages {} -> {}, tokens {} -> {}",
                            round_index,
                            messages.len(),
                            compressed_messages.len(),
                            token_pressure.total_tokens,
                            compressed_tokens,
                        );

                        if self
                            .round_executor
                            .is_dialog_turn_cancelled(&dialog_turn_id)
                        {
                            return Err(OpenBitFunError::Cancelled("Dialog cancelled".to_string()));
                        }
                        messages = compressed_messages;
                        turn_prompt_scaffold = self
                            .resolve_turn_prompt_scaffold(TurnPromptScaffoldInput {
                                context: &context,
                                current_agent: current_agent.as_ref(),
                                model_name: &ai_client.config.model,
                                supports_image_understanding: primary_supports_image_understanding,
                                tool_listing_sections: tool_listing_sections.clone(),
                                runtime_context_needs,
                                stage: "after_context_compression",
                            })
                            .await?;
                        Self::apply_turn_prompt_scaffold_to_messages(
                            &mut messages,
                            &turn_prompt_scaffold,
                        );
                        full_compression_count += 1;
                        send_pressure_reusable = false;
                    }
                    Ok(None) => {
                        return Err(OpenBitFunError::AIClient(
                            "Context compression has no eligible plan".to_string(),
                        ));
                    }
                    Err(err @ OpenBitFunError::Cancelled(_)) => return Err(err),
                    Err(e) => return Err(e),
                }
            }

            // L2: Emergency truncation — if tokens still exceed context_window
            // after all compression layers, drop oldest API rounds until we fit.
            let send_prepended_reminders = turn_prompt_scaffold
                .prepended_prompt_reminders
                .ordered_reminders();
            let send_prepended_reminder_tokens =
                Self::prepended_reminder_tokens_for_pressure(&send_prepended_reminders);
            let mut send_pressure = if send_pressure_reusable
                && token_pressure.prepended_reminder_tokens == send_prepended_reminder_tokens
            {
                token_pressure
            } else {
                Self::estimate_auto_compression_pressure(
                    &messages,
                    tool_definitions.as_deref(),
                    context_window,
                    compression_trigger_budget,
                    send_prepended_reminder_tokens,
                )
            };
            if send_pressure.total_tokens > context_window {
                warn!(
                    "Round {} tokens ({}) still exceed context_window ({}) after compression, performing emergency truncation",
                    round_index, send_pressure.total_tokens, context_window
                );
                let before_truncate_tokens = send_pressure.total_tokens;
                messages = Self::emergency_truncate_messages(
                    messages,
                    context_window,
                    tool_definitions.as_deref(),
                    send_prepended_reminder_tokens,
                );
                self.session_manager
                    .prune_token_anchors_to_messages(&context.session_id, &messages)
                    .await;
                send_pressure = Self::estimate_auto_compression_pressure(
                    &messages,
                    tool_definitions.as_deref(),
                    context_window,
                    compression_trigger_budget,
                    send_prepended_reminder_tokens,
                );
                info!(
                    "Emergency truncation complete: tokens {} -> {}",
                    before_truncate_tokens, send_pressure.total_tokens
                );
            }

            ContextHealthSnapshot::from_runtime_observations(
                send_pressure.usage_ratio,
                full_compression_count,
                compression_failure_count,
                &recent_tool_signatures,
                &messages,
            )
            .log(
                &context.session_id,
                &context.dialog_turn_id,
                round_index,
                "before_send",
            );

            // Create round context
            let round_context_vars = self
                .context_vars_for_round(
                    &execution_context_vars,
                    &context.session_id,
                    &context.dialog_turn_id,
                )
                .await;
            let loaded_deferred_tool_specs =
                collect_product_loaded_deferred_tool_specs(&messages, &deferred_tools);

            let model_exchange_trace_dir = self
                .session_manager
                .persistent_model_exchange_trace_dir(&context.session_id)
                .await;
            let round_context = RoundContext {
                session_id: context.session_id.clone(),
                subagent_parent_info: context.subagent_parent_info.clone(),
                permission_delegation: context.permission_delegation.clone(),
                dialog_turn_id: context.dialog_turn_id.clone(),
                turn_index: context.turn_index,
                round_number: round_index,
                round_group_id: None,
                workspace: context.workspace.clone(),
                model_exchange_trace_dir,
                available_tools: available_tools.clone(),
                deferred_tools: deferred_tools.clone(),
                loaded_deferred_tool_specs,
                model_config_id: model_id.clone(),
                effective_model_name: ai_client.config.model.clone(),
                model_request_context: model_request_context.clone(),
                primary_model_facts: primary_model_facts.clone(),
                agent_type: agent_type.clone(),
                context_vars: round_context_vars,
                permission_constraints: tool_policy.permission_constraints.clone(),
                permission_runtime_ceiling: context.permission_runtime_ceiling.clone(),
                delegation_policy: context.delegation_policy,
                runtime_tool_restrictions: context.runtime_tool_restrictions.clone(),
                steering_interrupt: context.round_injection.as_ref().map(|source| {
                    crate::agentic::round_preempt::DialogRoundInjectionInterrupt::new(
                        context.session_id.clone(),
                        context.dialog_turn_id.clone(),
                        Arc::clone(source),
                    )
                }),
                cancellation_token: CancellationToken::new(),
                workspace_services: context.workspace_services.clone(),
                terminal_port: context.terminal_port.clone(),
                remote_exec_port: context.remote_exec_port.clone(),
                recover_partial_on_cancel: context.recover_partial_on_cancel,
            };

            // Execute single model round
            debug!(
                "Starting model round: round_index={}, messages={}",
                round_index,
                messages.len()
            );

            if !primary_supports_image_understanding
                && messages.iter().any(|message| {
                    message.metadata.turn_id.as_deref() == Some(context.dialog_turn_id.as_str())
                        && matches!(&message.content, MessageContent::Multimodal { images, .. } if !images.is_empty())
                })
            {
                if !available_tools.iter().any(|name| name == "analyze_image") {
                    return Err(OpenBitFunError::validation(
                        "This agent cannot analyze image attachments with the selected text-only model. Enable analyze_image for this agent or select a multimodal model.",
                    ));
                }
                // Includes images accepted as steering after the turn began.
                crate::agentic::image_analysis::resolve_vision_model_from_global_config().await?;
            }

            let ai_messages = Self::build_ai_messages_for_send(
                &messages,
                &ai_client.config.format,
                context.workspace.as_ref(),
                context.workspace_services.as_ref(),
                &context.dialog_turn_id,
                primary_supports_image_understanding,
                &send_prepended_reminders,
            )
            .await?;

            let round_lifecycle =
                active_round_lifecycle.get_or_insert_with(ModelRoundLifecycle::new);
            let round_result = match self
                .round_executor
                .execute_round_with_lifecycle(
                    ai_client.clone(),
                    round_context,
                    ai_messages,
                    tool_definitions.clone(),
                    Some(context_window),
                    round_lifecycle,
                    Some(self.session_manager.as_ref()),
                )
                .await
            {
                Ok(result) => result,
                Err(err)
                    if enable_context_compression
                        && err.is_recoverable_context_overflow()
                        && main_context_overflow_recoveries
                            < Self::MAX_MAIN_CONTEXT_OVERFLOW_RECOVERIES =>
                {
                    main_context_overflow_recoveries += 1;
                    warn!(
                        "Main model request exceeded provider context; starting recovery compression: session_id={}, turn_id={}, round_index={}, recovery={}/{}, error={}",
                        context.session_id,
                        context.dialog_turn_id,
                        round_index,
                        main_context_overflow_recoveries,
                        Self::MAX_MAIN_CONTEXT_OVERFLOW_RECOVERIES,
                        err
                    );
                    match self
                        .compress_messages(
                            &context.session_id,
                            &context.dialog_turn_id,
                            "context_overflow_recovery",
                            messages.clone(),
                            send_pressure,
                            context_window,
                            ai_client.clone(),
                            &model_request_context,
                            &tool_definitions,
                            turn_prompt_scaffold.system_prompt_message.clone(),
                            &turn_prompt_scaffold.prepended_prompt_reminders,
                            primary_supports_image_understanding,
                            context_profile_policy.compression_contract_limit,
                            context.workspace.as_ref(),
                            context.workspace_services.as_ref(),
                            compression_prefetch.take(),
                        )
                        .await
                    {
                        Ok(Some((compressed_tokens, compressed_messages))) => {
                            info!(
                                "Context-overflow recovery compression completed: session_id={}, turn_id={}, round_index={}, recovery={}, messages {} -> {}, tokens {} -> {}",
                                context.session_id,
                                context.dialog_turn_id,
                                round_index,
                                main_context_overflow_recoveries,
                                messages.len(),
                                compressed_messages.len(),
                                send_pressure.total_tokens,
                                compressed_tokens
                            );
                            if self
                                .round_executor
                                .is_dialog_turn_cancelled(&dialog_turn_id)
                            {
                                return Err(OpenBitFunError::Cancelled(
                                    "Dialog cancelled".to_string(),
                                ));
                            }
                            messages = compressed_messages;
                            turn_prompt_scaffold = self
                                .resolve_turn_prompt_scaffold(TurnPromptScaffoldInput {
                                    context: &context,
                                    current_agent: current_agent.as_ref(),
                                    model_name: &ai_client.config.model,
                                    supports_image_understanding:
                                        primary_supports_image_understanding,
                                    tool_listing_sections: tool_listing_sections.clone(),
                                    runtime_context_needs,
                                    stage: "after_context_overflow_recovery",
                                })
                                .await?;
                            Self::apply_turn_prompt_scaffold_to_messages(
                                &mut messages,
                                &turn_prompt_scaffold,
                            );
                            self.round_executor
                                .record_context_overflow_recovery(
                                    &context.session_id,
                                    &context.dialog_turn_id,
                                    round_lifecycle,
                                    err.to_string(),
                                )
                                .await;
                            full_compression_count += 1;
                            continue;
                        }
                        Ok(None) => {
                            warn!(
                                "Context-overflow recovery found no compressible context: session_id={}, turn_id={}, round_index={}",
                                context.session_id, context.dialog_turn_id, round_index
                            );
                            return Err(err);
                        }
                        Err(err @ OpenBitFunError::Cancelled(_)) => return Err(err),
                        Err(compression_error) => {
                            error!(
                                "Context-overflow recovery compression failed: session_id={}, turn_id={}, round_index={}, error={}",
                                context.session_id,
                                context.dialog_turn_id,
                                round_index,
                                compression_error
                            );
                            return Err(compression_error);
                        }
                    }
                }
                Err(err) => return Err(err),
            };
            active_round_lifecycle = None;

            debug!(
                "Model round completed: round_index={}, has_more_rounds={}, tool_calls={}",
                round_index,
                round_result.has_more_rounds,
                round_result.tool_calls.len()
            );
            completed_rounds += 1;

            // Save the last token usage statistics (update each time, keep the last one)
            if let Some(ref usage) = round_result.usage {
                last_usage = Some(usage.clone());
                let round_id = round_result
                    .assistant_message
                    .metadata
                    .round_id
                    .clone()
                    .unwrap_or_else(|| format!("round_{}", round_index));
                let system_tokens_at_anchor = Self::system_tokens_for_pressure(&messages);
                let tool_tokens_at_anchor = tool_definitions
                    .as_deref()
                    .map(TokenCounter::estimate_tool_definitions_tokens)
                    .unwrap_or(0);
                let anchor = TokenAnchor::from_request_prefix(
                    TokenAnchorInput {
                        session_id: context.session_id.clone(),
                        turn_id: context.dialog_turn_id.clone(),
                        round_id,
                        model_id: ai_client.config.model.clone(),
                        input_tokens: usage.prompt_token_count as usize,
                        system_tokens_at_anchor,
                        tool_tokens_at_anchor,
                        prepended_reminder_tokens_at_anchor: send_prepended_reminder_tokens,
                    },
                    &messages,
                );
                self.session_manager.remember_token_anchor(anchor).await;
            }

            // Add assistant message to history
            messages.push(round_result.assistant_message.clone());
            self.remember_generation_message(
                &context.session_id,
                &context.dialog_turn_id,
                &round_result.assistant_message,
            );

            if !round_result.assistant_message_committed {
                // Update the in-memory message caches immediately so subsequent rounds see it.
                if let Err(e) = self
                    .session_manager
                    .add_message(&context.session_id, round_result.assistant_message.clone())
                    .await
                {
                    warn!("Failed to update assistant message in memory: {}", e);
                }
            }

            // Add tool result messages to history
            for tool_result_msg in round_result.tool_result_messages.iter() {
                messages.push(tool_result_msg.clone());
                self.remember_generation_message(
                    &context.session_id,
                    &context.dialog_turn_id,
                    tool_result_msg,
                );

                // Update the in-memory message caches immediately so subsequent rounds see it.
                if let Err(e) = self
                    .session_manager
                    .add_message(&context.session_id, tool_result_msg.clone())
                    .await
                {
                    warn!("Failed to update tool result message in memory: {}", e);
                }
            }

            #[cfg(feature = "agent-runtime")]
            {
                let previous_message_count = messages.len();
                activate_conditional_instructions_after_round(
                    self.session_manager.as_ref(),
                    &context,
                    &round_result,
                    &mut messages,
                )
                .await;
                for message in &messages[previous_message_count..] {
                    self.remember_generation_message(
                        &context.session_id,
                        &context.dialog_turn_id,
                        message,
                    );
                }
            }

            debug!(
                "Updated round messages in memory: round_index={}, assistant + {} tool results",
                round_index,
                round_result.tool_result_messages.len()
            );

            total_tools += round_result.tool_calls.len();

            // Track partial recovery reason from the last round
            if round_result.partial_recovery_reason.is_some() {
                last_partial_recovery_reason = round_result.partial_recovery_reason.clone();
            }

            if let Some(round_signature) = Self::tool_call_signature(&round_result.tool_calls) {
                recent_tool_signatures.push(round_signature.clone());
                if Self::failed_tool_round_signature(
                    &round_result.tool_calls,
                    &round_result.tool_result_messages,
                )
                .is_some()
                {
                    recent_failed_tool_signatures.push(round_signature);
                } else {
                    recent_failed_tool_signatures.clear();
                    failed_tool_recovery_attempts = 0;
                }
            } else {
                recent_tool_signatures.clear();
                recent_failed_tool_signatures.clear();
                failed_tool_recovery_attempts = 0;
            }

            let after_round_pressure = Self::estimate_auto_compression_pressure(
                &messages,
                tool_definitions.as_deref(),
                context_window,
                compression_trigger_budget,
                send_prepended_reminder_tokens,
            );
            let after_round_health = ContextHealthSnapshot::from_runtime_observations(
                after_round_pressure.usage_ratio,
                full_compression_count,
                compression_failure_count,
                &recent_tool_signatures,
                &messages,
            );
            after_round_health.log(
                &context.session_id,
                &context.dialog_turn_id,
                round_index,
                "after_round",
            );
            after_round_health.log_policy_thresholds(
                &context.session_id,
                &context.dialog_turn_id,
                round_index,
                &context_profile_policy,
            );

            let max_consec = context_profile_policy
                .effective_loop_threshold(self.config.max_consecutive_same_tool);
            if recent_failed_tool_signatures.len() >= max_consec {
                let tail = &recent_failed_tool_signatures
                    [recent_failed_tool_signatures.len() - max_consec..];
                if tail.windows(2).all(|w| w[0] == w[1]) {
                    if failed_tool_recovery_attempts < MAX_FAILED_TOOL_RECOVERY_ATTEMPTS {
                        failed_tool_recovery_attempts += 1;
                        warn!(
                            "Repeated tool failure detected: {} consecutive rounds with identical tool signatures, injecting recovery prompt #{}",
                            max_consec, failed_tool_recovery_attempts
                        );
                        let reminder = format!(
                            "<system_reminder>Repeated tool failure detected: the same tool call with identical arguments has failed {} times in a row. \
                            The current approach is not making progress. You MUST now change your strategy: \
                            (1) if the tool keeps failing, try a completely different approach or tool; \
                            (2) if you are stuck, step back and reason about the root cause before acting; \
                            (3) if the task is genuinely impossible with the available tools, provide a clear explanation to the user. \
                            Do NOT repeat the same tool call again.</system_reminder>",
                            max_consec
                        );
                        let user_msg = Message::internal_reminder(
                            InternalReminderKind::LoopRecovery,
                            reminder,
                        )
                        .with_turn_id(context.dialog_turn_id.clone());
                        messages.push(user_msg.clone());
                        self.remember_generation_message(
                            &context.session_id,
                            &context.dialog_turn_id,
                            &user_msg,
                        );
                        if let Err(e) = self
                            .session_manager
                            .add_message(&context.session_id, user_msg)
                            .await
                        {
                            warn!("Failed to persist failed-tool recovery reminder: {}", e);
                        }
                        recent_failed_tool_signatures.clear();
                    } else {
                        warn!(
                            "Repeated tool failure detected: {} consecutive rounds with identical tool signatures, max recovery attempts ({}) exhausted, finalizing without tools",
                            max_consec, MAX_FAILED_TOOL_RECOVERY_ATTEMPTS
                        );
                        finalization_reason = Some("repeated_tool_failures");
                        break;
                    }
                }
            }

            // Periodic-pattern loop detection.
            //
            // The strict consecutive check above only fires on `A-A-A` patterns.
            // Real-world subagent loops often alternate between a small set of
            // signatures (e.g. `A-B-A-B-A-B` when the model toggles a single
            // argument such as the regex pattern, while every other call is
            // identical). Such rounds never collapse to a single signature, so
            // the model can stay stuck for hundreds of rounds without tripping
            // the strict check.
            //
            // The periodic detector inspects the last `2 * max_consec` rounds:
            // if at most `max_consec` distinct signatures appear AND every one
            // of those signatures appears at least twice, the window contains
            // no genuine new exploration and we treat it as a loop.
            if Self::is_periodic_tool_signature_loop(&recent_failed_tool_signatures, max_consec) {
                let window_size = max_consec.max(1).saturating_mul(2);
                if failed_tool_recovery_attempts < MAX_FAILED_TOOL_RECOVERY_ATTEMPTS {
                    failed_tool_recovery_attempts += 1;
                    warn!(
                        "Repeated tool failure detected: last {} failed rounds form a periodic tool-call pattern (<= {} distinct signatures, each repeated), injecting recovery prompt #{}",
                        window_size, max_consec, failed_tool_recovery_attempts
                    );
                    let reminder = format!(
                        "<system_reminder>Repeated tool failure detected: your last {} failed tool calls form a repeating pattern with no new progress. \
                        You are cycling between failing actions without advancing the task. You MUST now change your strategy: \
                        (1) try a completely different approach or tool; \
                        (2) step back and reason about the root cause before acting; \
                        (3) if the task is genuinely impossible with the available tools, provide a clear explanation to the user. \
                        Do NOT repeat the same pattern of tool calls.</system_reminder>",
                        window_size
                    );
                    let user_msg = Message::internal_reminder(
                        InternalReminderKind::PeriodicLoopRecovery,
                        reminder,
                    )
                    .with_turn_id(context.dialog_turn_id.clone());
                    messages.push(user_msg.clone());
                    self.remember_generation_message(
                        &context.session_id,
                        &context.dialog_turn_id,
                        &user_msg,
                    );
                    if let Err(e) = self
                        .session_manager
                        .add_message(&context.session_id, user_msg)
                        .await
                    {
                        warn!("Failed to persist periodic loop recovery reminder: {}", e);
                    }
                    recent_failed_tool_signatures.clear();
                } else {
                    warn!(
                            "Repeated tool failure detected: last {} failed rounds form a periodic tool-call pattern, max recovery attempts ({}) exhausted, finalizing without tools",
                            window_size, MAX_FAILED_TOOL_RECOVERY_ATTEMPTS
                    );
                    finalization_reason = Some("repeated_tool_failures");
                    break;
                }
            }

            // User-steering messages submitted while this turn is running: drain and inject
            // them as user messages into the working history before starting the next round
            // (Codex-style mid-turn injection). This does NOT end the current turn: if the
            // model wanted to finish but the user steered, we keep the turn running so the
            // steering message gets a response.
            let mut injection_applied = false;
            if let Some(source) = context.round_injection.as_ref() {
                let pending = source.take_pending(&context.session_id, &context.dialog_turn_id);
                if !pending.is_empty() {
                    info!(
                        "Injecting {} round message(s) at round boundary: session_id={}, dialog_turn_id={}, round_index={}",
                        pending.len(),
                        context.session_id,
                        context.dialog_turn_id,
                        round_index
                    );
                    for injection in pending {
                        let injection_id = injection.id.clone();
                        let injection_kind = injection.kind;
                        let wrapped = match injection.kind {
                            RoundInjectionKind::UserSteering => format!(
                                "<system_reminder>\nThe user sent a new message while this turn was running. You have just finished the previous atomic action; handle this new user message now as the current direction, while preserving the existing conversation and task context. Do not ignore it or wait for a separate future turn.\n\nNew user message:\n{}\n</system_reminder>",
                                // A steering message carries whatever the
                                // composer carries, so an image-only message is
                                // legitimate: name the attachment instead of
                                // injecting empty text.
                                if injection.content.trim().is_empty()
                                    && !injection.attachments.is_empty()
                                {
                                    "(image attached)"
                                } else {
                                    injection.content.as_str()
                                }
                            ),
                            RoundInjectionKind::BackgroundResult => format!(
                                "<system_reminder>\nA background task has finished and returned new information while this turn was running. Incorporate it into your current work immediately when relevant. Do not wait for a separate future turn.\n\nBackground result:\n{}\n</system_reminder>",
                                injection.content
                            ),
                            RoundInjectionKind::ThreadGoalObjectiveUpdated => {
                                injection.content.clone()
                            }
                        };
                        let reminder_kind = match injection.kind {
                            RoundInjectionKind::UserSteering => InternalReminderKind::UserSteering,
                            RoundInjectionKind::BackgroundResult => {
                                InternalReminderKind::BackgroundResult
                            }
                            RoundInjectionKind::ThreadGoalObjectiveUpdated => {
                                InternalReminderKind::GoalObjectiveUpdated
                            }
                        };
                        // Use the same durable input path as turn-boundary messages.
                        // A malformed image must not silently become a text-only turn.
                        let mut images = agent_dialog_turn_image_contexts(&injection.attachments)
                            .map_err(|error| OpenBitFunError::validation(error.to_string()))?
                            .unwrap_or_default();
                        crate::agentic::image_analysis::attachments::prepare_inline_image_attachments(
                            &mut images, &attachment_context,
                        ).await?;
                        let user_msg = if images.is_empty() {
                            Message::internal_reminder(reminder_kind, wrapped)
                        } else {
                            Message::internal_reminder_multimodal(reminder_kind, wrapped, images)
                        }
                        .with_turn_id(context.dialog_turn_id.clone());
                        messages.push(user_msg.clone());
                        self.remember_generation_message(
                            &context.session_id,
                            &context.dialog_turn_id,
                            &user_msg,
                        );
                        if let Err(e) = self
                            .session_manager
                            .add_message(&context.session_id, user_msg)
                            .await
                        {
                            warn!("Failed to persist user steering message in memory: {}", e);
                        }

                        self.emit_event(
                            AgenticEvent::UserSteeringInjected {
                                session_id: context.session_id.clone(),
                                turn_id: context.dialog_turn_id.clone(),
                                round_index,
                                steering_id: injection.id,
                                content: injection.content,
                                display_content: injection.display_content,
                            },
                            EventPriority::Normal,
                        )
                        .await;
                        source.acknowledge_consumed(
                            &context.session_id,
                            &context.dialog_turn_id,
                            &injection_id,
                            injection_kind,
                        );
                        injection_applied = true;
                    }
                }
            }

            // P0-1: Decide whether to end the turn here.
            //
            // If the user just injected a steering message we always continue so the
            // model can respond to it.
            //
            // Otherwise, if the round produced any tool_call, we already continue via
            // `has_more_rounds = true`. The interesting case is `has_more_rounds == false`:
            //
            // - Model emitted user-visible text  -> final answer, end the turn, unless
            //   the stream was partially recovered (timeout / interruption) in which
            //   case inject a continuation reminder and keep going.
            // - Model emitted thinking only      -> stalled mid-reasoning. Inject a
            //   system_reminder asking it to either act (call a tool) or finish
            //   (write the answer), and continue.
            // - Model emitted nothing at all     -> partial recovery / truncation.
            //   Retrying without new context will not help, so end the turn.
            if injection_applied {
                // fall through to next round so the model can respond to the steering
            } else if !round_result.has_more_rounds {
                if round_result.had_assistant_text {
                    if let Some(ref reason) = round_result.partial_recovery_reason {
                        if Self::should_continue_after_partial_response(reason) {
                            partial_continuation_attempts += 1;
                            if partial_continuation_attempts <= MAX_PARTIAL_CONTINUATION_ATTEMPTS {
                                let reminder = format!(
                                    "<system_reminder>Your previous assistant response was interrupted mid-stream ({reason}). Continue writing from exactly where you stopped. Do not repeat content that was already delivered; pick up seamlessly and complete the answer.</system_reminder>"
                                );
                                let user_msg = Message::internal_reminder(
                                    InternalReminderKind::InterruptedContinue,
                                    reminder.clone(),
                                )
                                .with_turn_id(context.dialog_turn_id.clone());
                                messages.push(user_msg.clone());
                                self.remember_generation_message(
                                    &context.session_id,
                                    &context.dialog_turn_id,
                                    &user_msg,
                                );
                                if let Err(e) = self
                                    .session_manager
                                    .add_message(&context.session_id, user_msg)
                                    .await
                                {
                                    warn!("Failed to persist partial continuation reminder: {}", e);
                                }
                                warn!(
                                    "Partial stream recovery with assistant text; injecting continuation reminder #{}/{}: turn={}, round={}, reason={}",
                                    partial_continuation_attempts,
                                    MAX_PARTIAL_CONTINUATION_ATTEMPTS,
                                    context.dialog_turn_id,
                                    round_index,
                                    reason
                                );
                                // Continue into the next round so the model can finish.
                            } else {
                                warn!(
                                    "Partial stream continuation attempts exhausted; accepting truncated answer: turn={}, round={}, reason={}",
                                    context.dialog_turn_id, round_index, reason
                                );
                                finalization_reason = Some("partial_truncated");
                                break;
                            }
                        } else {
                            debug!(
                                "Model round {} ended with partial answer after cancellation, reason: {:?}",
                                round_index, round_result.finish_reason
                            );
                            break;
                        }
                    } else {
                        debug!(
                            "Model round {} ended with final answer, reason: {:?}",
                            round_index, round_result.finish_reason
                        );
                        // Stop hooks may block the natural end of the turn and
                        // ask the agent to keep working. `stop_hook_active`
                        // tells the hook it is already running inside such a
                        // continuation so it can avoid an endless loop, and the
                        // engine caps continuations regardless.
                        // Subagent turns run through this same loop; their
                        // completion is reported by SubagentStop instead, so
                        // Stop stays a top-level-turn event as in Codex.
                        let stop_block_reason = if context.subagent_parent_info.is_none()
                            && stop_hook_continuations < MAX_STOP_HOOK_CONTINUATIONS
                        {
                            native_hooks::dispatch_stop(
                                Self::native_hook_facts(
                                    &context.session_id,
                                    &context.dialog_turn_id,
                                    context.workspace.as_ref(),
                                    &ai_client.config.model,
                                ),
                                stop_hook_continuations > 0,
                                Self::assistant_message_text(&round_result.assistant_message),
                            )
                            .await
                        } else {
                            None
                        };
                        if let Some(reason) = stop_block_reason {
                            stop_hook_continuations += 1;
                            let reminder = format!(
                                "<system_reminder>A Stop hook blocked the end of this turn: {reason}\nAddress this before finishing, then produce your final answer.</system_reminder>"
                            );
                            let user_msg = Message::internal_reminder(
                                InternalReminderKind::StopHookBlock,
                                reminder,
                            )
                            .with_turn_id(context.dialog_turn_id.clone());
                            messages.push(user_msg.clone());
                            self.remember_generation_message(
                                &context.session_id,
                                &context.dialog_turn_id,
                                &user_msg,
                            );
                            if let Err(e) = self
                                .session_manager
                                .add_message(&context.session_id, user_msg)
                                .await
                            {
                                warn!("Failed to persist Stop hook reminder: {}", e);
                            }
                            info!(
                                "Stop hook blocked turn completion; continuing turn #{}/{}: turn={}, round={}",
                                stop_hook_continuations,
                                MAX_STOP_HOOK_CONTINUATIONS,
                                context.dialog_turn_id,
                                round_index
                            );
                            // Continue into the next round so the agent can act
                            // on the hook feedback.
                        } else {
                            break;
                        }
                    }
                } else if round_result.had_thinking_content {
                    thinking_only_rescue_attempts += 1;
                    let reminder = "<system_reminder>The previous round produced internal reasoning only — no tool call and no user-visible response. You MUST now either: (1) call the single tool that best advances the user's task, or (2) write your final answer to the user. Do not produce another round of reasoning without taking action.</system_reminder>".to_string();
                    let user_msg = Message::internal_reminder(
                        InternalReminderKind::ThinkingOnlyRescue,
                        reminder.clone(),
                    )
                    .with_turn_id(context.dialog_turn_id.clone());
                    messages.push(user_msg.clone());
                    self.remember_generation_message(
                        &context.session_id,
                        &context.dialog_turn_id,
                        &user_msg,
                    );
                    if let Err(e) = self
                        .session_manager
                        .add_message(&context.session_id, user_msg)
                        .await
                    {
                        warn!("Failed to persist thinking-only rescue reminder: {}", e);
                    }
                    warn!(
                        "Thinking-only round detected; injecting rescue reminder #{}: turn={}, round={}",
                        thinking_only_rescue_attempts, context.dialog_turn_id, round_index
                    );
                    // Continue into the next round so the model gets a chance to act.
                } else {
                    warn!(
                        "Empty round (no text/thinking/tool_call); ending turn: turn={}, round={}",
                        context.dialog_turn_id, round_index
                    );
                    finalization_reason = Some("empty_round");
                    break;
                }
            }

            // Check if cancellation was requested after each round. Tokens stay
            // registered until final cleanup so early cancellation can be
            // observed by the first round.
            if self
                .round_executor
                .is_dialog_turn_cancelled(&dialog_turn_id)
            {
                debug!(
                    "Dialog turn cancelled, stopping execution: dialog_turn_id={}",
                    dialog_turn_id
                );

                if context.emit_lifecycle_events
                    && execution_engine_owns_cancel_lifecycle(&context.context)
                {
                    self.emit_event(
                        AgenticEvent::DialogTurnCancelled {
                            session_id: context.session_id.clone(),
                            turn_id: context.dialog_turn_id.clone(),
                        },
                        EventPriority::High,
                    )
                    .await;
                }

                // Note: Token will be cleaned up when outer function exits
                return Err(OpenBitFunError::cancelled("Dialog cancelled"));
            }

            // Continue to next round
            round_index += 1;

            debug!(
                "Model round {} completed, continuing to round {}",
                round_index - 1,
                round_index
            );
        }

        // P1-6: Track the actual termination reason for downstream reporting.
        // Defaults to "complete" (model produced a final answer naturally).
        let effective_finish_reason: &'static str = match finalization_reason {
            Some(r) => r,
            None => "complete",
        };
        let mut has_final_response = finalization_reason.is_none();
        let mut used_local_final_response_synthesis = false;

        if let Some(reason) = finalization_reason {
            let finalize_reminder = match reason {
                "repeated_tool_failures" => {
                    Some(Self::FINALIZE_AFTER_REPEATED_TOOL_FAILURES_REMINDER)
                }
                "max_rounds" => Some(Self::FINALIZE_AFTER_MAX_ROUNDS_REMINDER),
                _ => None,
            };

            if let Some(finalize_reminder) = finalize_reminder {
                let finalize_round_group_id = Some(format!(
                    "{}:finalize:{}",
                    context.dialog_turn_id, completed_rounds
                ));
                info!(
                    "Finalizing dialog turn: session_id={}, turn_id={}, reason={}",
                    context.session_id, context.dialog_turn_id, reason
                );

                let finalize_prepended_reminders = turn_prompt_scaffold
                    .prepended_prompt_reminders
                    .ordered_reminders();
                let final_round_result = self
                    .run_finalize_round(FinalizeRoundInput {
                        permission_constraints: tool_policy.permission_constraints.clone(),
                        ai_client: ai_client.clone(),
                        context: &context,
                        agent_type: agent_type.clone(),
                        round_number: completed_rounds,
                        round_group_id: finalize_round_group_id.clone(),
                        execution_context_vars: &execution_context_vars,
                        primary_model_facts: &primary_model_facts,
                        model_request_context: &model_request_context,
                        prepended_reminders: &finalize_prepended_reminders,
                        messages: &messages,
                        reminder_text: finalize_reminder,
                        tool_definitions: tool_definitions.clone(),
                        context_window,
                    })
                    .await?;

                let mut accepted = final_round_result.had_assistant_text
                    && !Self::assistant_has_tool_calls(&final_round_result.assistant_message);
                let chosen_assistant_message: Option<Message>;
                let mut chosen_usage: Option<crate::util::types::ai::GeminiUsage> =
                    final_round_result.usage.clone();

                if accepted {
                    chosen_assistant_message = Some(final_round_result.assistant_message.clone());
                } else {
                    warn!(
                        "Finalize round did not return usable assistant text; retrying once: session_id={}, turn_id={}",
                        context.session_id, context.dialog_turn_id
                    );
                    let retry_result = self
                        .run_finalize_round(FinalizeRoundInput {
                            permission_constraints: tool_policy.permission_constraints.clone(),
                            ai_client: ai_client.clone(),
                            context: &context,
                            agent_type: agent_type.clone(),
                            round_number: completed_rounds,
                            round_group_id: finalize_round_group_id.clone(),
                            execution_context_vars: &execution_context_vars,
                            primary_model_facts: &primary_model_facts,
                            model_request_context: &model_request_context,
                            prepended_reminders: &finalize_prepended_reminders,
                            messages: &messages,
                            reminder_text: finalize_reminder,
                            tool_definitions: tool_definitions.clone(),
                            context_window,
                        })
                        .await?;
                    if !retry_result.had_assistant_text
                        || Self::assistant_has_tool_calls(&retry_result.assistant_message)
                    {
                        warn!(
                            "Finalize retry did not return usable assistant text; synthesizing local final response: session_id={}, turn_id={}",
                            context.session_id, context.dialog_turn_id
                        );
                        accepted = true;
                        used_local_final_response_synthesis = true;
                        chosen_assistant_message = Some(
                            Message::assistant(Self::build_local_final_response_message(reason))
                                .with_turn_id(context.dialog_turn_id.clone()),
                        );
                    } else {
                        accepted = true;
                        chosen_usage = retry_result.usage.clone();
                        chosen_assistant_message = Some(retry_result.assistant_message);
                    }
                }

                has_final_response = Self::should_mark_has_final_response(
                    chosen_assistant_message.is_some(),
                    used_local_final_response_synthesis,
                );
                if let Some(msg) = chosen_assistant_message {
                    if accepted && !used_local_final_response_synthesis {
                        let finalize_cache_anchor_messages =
                            Self::build_finalize_cache_anchor_messages(
                                &context.dialog_turn_id,
                                finalize_reminder,
                            );
                        for anchor_message in finalize_cache_anchor_messages {
                            messages.push(anchor_message.clone());
                            self.remember_generation_message(
                                &context.session_id,
                                &context.dialog_turn_id,
                                &anchor_message,
                            );
                            if let Err(e) = self
                                .session_manager
                                .add_message(&context.session_id, anchor_message)
                                .await
                            {
                                warn!("Failed to persist finalize cache anchor message: {}", e);
                            }
                        }
                    }
                    completed_rounds += 1;
                    if let Some(usage) = chosen_usage {
                        last_usage = Some(usage);
                    }
                    messages.push(msg.clone());
                    self.remember_generation_message(
                        &context.session_id,
                        &context.dialog_turn_id,
                        &msg,
                    );
                    if let Err(e) = self
                        .session_manager
                        .add_message(&context.session_id, msg)
                        .await
                    {
                        warn!("Failed to update final assistant message in memory: {}", e);
                    }
                }
            } else if reason == "partial_truncated" {
                has_final_response = true;
            }
        }

        let duration_ms = elapsed_ms_u64(start_time);

        info!(
            "Dialog turn loop completed: turn={}, rounds={}, total_tools={}, reason={}",
            context.dialog_turn_id, completed_rounds, total_tools, effective_finish_reason
        );

        let finish_reason = FinishReason::Complete;
        // Some abnormal turn endings still go through the completed-event path
        // so the UI can explain the termination cause inline even when the turn
        // ended without a final assistant reply.
        let success = has_final_response
            || matches!(
                effective_finish_reason,
                "max_rounds" | "repeated_tool_failures"
            );

        // Post-processing hook: when a DeepResearch dialog turn finishes
        // successfully, renumber `cit_XXX` references in the final report
        // into consecutive `[N]` display IDs. Two gates apply (agent type +
        // dialog success) so other agents and failed turns are unaffected.
        #[cfg(feature = "deep-research")]
        {
            if openbitfun_agent_workflows::deep_research::should_post_process_research_report(
                &agent_type,
                success,
            ) {
                if let Some(workspace) = context.workspace.as_ref() {
                    if let Some(workspace_services) = context.workspace_services.as_ref() {
                        openbitfun_services_integrations::deep_research::run_for_session_workspace(
                            workspace_services.fs.as_ref(),
                            &workspace.root_path().to_string_lossy(),
                            &context.session_id,
                        )
                        .await;
                    } else {
                        warn!(
                            "citation_renumber: skipped because workspace filesystem services are unavailable: session_id={}, workspace={}",
                            context.session_id,
                            workspace.root_path().display()
                        );
                    }
                }
            }
        }

        if context.emit_lifecycle_events {
            debug!("Preparing to send DialogTurnCompleted event");

            let _ = self
                .event_queue
                .enqueue(
                    AgenticEvent::DialogTurnCompleted {
                        session_id: context.session_id.clone(),
                        turn_id: context.dialog_turn_id.clone(),
                        total_rounds: completed_rounds,
                        total_tools,
                        duration_ms,
                        partial_recovery_reason: last_partial_recovery_reason.clone(),
                        success: Some(success),
                        finish_reason: Some(effective_finish_reason.to_string()),
                        has_final_response: Some(has_final_response),
                    },
                    None,
                )
                .await;

            debug!("DialogTurnCompleted event sent");
        }

        // Print dialog turn token statistics (from model's last returned usage)
        if let Some(usage) = last_usage {
            info!(
                "Dialog turn completed - Token stats: turn_id={}, rounds={}, tools={}, duration={}ms, prompt_tokens={}, completion_tokens={}, total_tokens={}",
                context.dialog_turn_id,
                completed_rounds,
                total_tools,
                duration_ms,
                usage.prompt_token_count,
                usage.candidates_token_count,
                usage.total_token_count
            );
        } else {
            warn!("Dialog turn completed but token stats not available");
        }

        Ok(ExecutionResult {
            final_message: self
                .generation_messages
                .get(&(context.session_id.clone(), context.dialog_turn_id.clone()))
                .and_then(|generated| {
                    generated
                        .iter()
                        .rev()
                        .find(|message| message.role == MessageRole::Assistant)
                        .cloned()
                })
                .or_else(|| {
                    messages
                        .iter()
                        .rev()
                        .find(|message| message.role == MessageRole::Assistant)
                        .cloned()
                })
                .unwrap_or_else(|| Message::assistant(String::new())),
            total_rounds: completed_rounds,
            success,
            new_messages: self
                .take_generation_messages(&context.session_id, &context.dialog_turn_id),
            finish_reason,
            total_tools,
            duration_ms,
            partial_recovery_reason: last_partial_recovery_reason,
            effective_finish_reason: effective_finish_reason.to_string(),
            has_final_response,
        })
    }

    /// Cancel dialog turn execution
    pub async fn cancel_dialog_turn(&self, dialog_turn_id: &str) -> OpenBitFunResult<()> {
        debug!("Cancelling dialog turn: dialog_turn_id={}", dialog_turn_id);
        let result = self.round_executor.cancel_dialog_turn(dialog_turn_id).await;
        if result.is_ok() {
            debug!(
                "Dialog turn cancelled successfully: dialog_turn_id={}",
                dialog_turn_id
            );
        } else {
            error!(
                "Failed to cancel dialog turn: dialog_turn_id={}, error={:?}",
                dialog_turn_id, result
            );
        }
        result
    }

    /// Check if dialog turn is still active (used to detect cancellation)
    pub fn has_active_turn(&self, dialog_turn_id: &str) -> bool {
        self.round_executor.has_active_dialog_turn(dialog_turn_id)
    }

    /// Register cancellation token (for external control, e.g., execute_subagent)
    pub fn register_cancel_token(&self, dialog_turn_id: &str, token: CancellationToken) {
        self.round_executor
            .register_cancel_token(dialog_turn_id, token)
    }

    /// Return a clone of the cancellation token registered for a dialog turn.
    pub fn cancel_token_for_dialog_turn(&self, dialog_turn_id: &str) -> Option<CancellationToken> {
        self.round_executor
            .cancel_token_for_dialog_turn(dialog_turn_id)
    }

    /// Cleanup cancellation token (for external calls)
    pub async fn cleanup_cancel_token(&self, dialog_turn_id: &str) {
        self.round_executor
            .cleanup_dialog_turn(dialog_turn_id)
            .await
    }

    /// Emit event
    async fn emit_event(&self, event: AgenticEvent, priority: EventPriority) {
        let _ = self.event_queue.enqueue(event, Some(priority)).await;
    }
}

#[cfg(test)]
#[path = "compression_tests.rs"]
mod compression_tests;

#[cfg(test)]
mod tests {
    use super::{
        activate_conditional_instructions_after_round, manual_compaction_terminal_error,
        reached_fixed_model_round_limit, resolve_round_permission_mode,
        runtime_context_needs_for_manifest, skill_agent_listing_reminders, ContextHealthSnapshot,
        ExecutionEngine, ExecutionEngineConfig, RoundResult, TurnPromptScaffold,
    };
    use crate::agentic::agents::{
        PrependedPromptReminders, PromptBuilderContext, ToolListingSections, UserContextPolicy,
    };
    use crate::agentic::core::{InternalReminderKind, Message, MessageRole, ToolCall, ToolResult};
    use crate::agentic::persistence::PersistenceManager;
    use crate::agentic::session::{
        ContextCompressor, PromptCachePolicy, SessionContextStore, SessionManager,
        SessionManagerConfig, TokenAnchor, TokenAnchorInput,
    };
    use crate::agentic::tools::ResolvedToolManifest;
    use crate::agentic::tools::ToolRuntimeRestrictions;
    use crate::agentic::workspace::{local_workspace_services, WorkspaceBinding};
    use crate::infrastructure::PathManager;
    #[cfg(feature = "external-sources")]
    use crate::instruction_sources::test_support::{lock_environment, EnvironmentGuard};
    use crate::service::config::types::AIConfig;
    use crate::service::config::types::AIModelConfig;
    use crate::service::remote_ssh::workspace_state::workspace_session_identity;
    use crate::util::types::ToolDefinition;
    use openbitfun_runtime_ports::{
        PermissionMode, WorkspaceDirEntry, WorkspaceFileSystem, WorkspacePathKind,
    };
    use serde_json::json;
    use sha2::{Digest, Sha256};
    use std::collections::HashMap;
    use std::path::PathBuf;
    use std::sync::atomic::{AtomicBool, AtomicUsize, Ordering};
    use std::sync::Arc;
    use std::time::Duration;

    #[tokio::test]
    async fn image_inputs_keep_pixels_for_native_models_and_tool_paths_for_text_models() {
        let mut image = crate::agentic::image_analysis::attachments::test_image();
        image.image_path =
            Some("openbitfun://runtime/current/attachments/images/example.png".into());
        let messages = vec![
            Message::user_multimodal("Read this screenshot".into(), vec![image.clone()])
                .with_turn_id("turn".into()),
            Message::internal_reminder_multimodal(
                crate::agentic::core::InternalReminderKind::UserSteering,
                "Also check the second image",
                vec![image.clone()],
            )
            .with_turn_id("turn".into()),
        ];
        for provider in ["openai", "anthropic", "responses", "gemini"] {
            let native = ExecutionEngine::build_ai_messages_for_send(
                &messages,
                provider,
                None,
                None,
                "turn",
                true,
                &[],
            )
            .await
            .unwrap();
            assert_eq!(native.len(), 2);
            for message in native {
                let parts: serde_json::Value =
                    serde_json::from_str(message.content.as_deref().unwrap()).unwrap();
                assert!(
                    parts.as_array().unwrap().iter().any(|part| {
                        matches!(part["type"].as_str(), Some("image") | Some("image_url"))
                            || part.get("inline_data").is_some()
                    }),
                    "{provider}: {parts}"
                );
            }
        }
        let text_only = ExecutionEngine::build_ai_messages_for_send(
            &messages,
            "openai",
            None,
            None,
            "turn",
            false,
            &[],
        )
        .await
        .unwrap();
        assert_eq!(text_only.len(), 2);
        for message in text_only {
            let text = message.content.unwrap();
            assert!(text.contains("analyze_image"));
            assert!(text.contains(image.image_path.as_deref().unwrap()));
            assert!(!text.contains("base64"));
        }
        assert!(messages.iter().all(|message| matches!(&message.content, crate::agentic::core::MessageContent::Multimodal { images, .. } if images[0].data_url.is_some())));
    }

    #[tokio::test]
    async fn compression_cancellation_before_preparation_does_not_start_work() {
        let token = tokio_util::sync::CancellationToken::new();
        token.cancel();
        let result = super::prepare_compression_cancellable(&token, async {
            panic!("Cancelled preparation must not be polled");
            #[allow(unreachable_code)]
            Ok(())
        })
        .await;
        assert!(matches!(result, Err(crate::OpenBitFunError::Cancelled(_))));
    }

    #[tokio::test]
    async fn compression_cancellation_drops_pending_work_without_commit() {
        struct DropProbe(Arc<AtomicBool>);
        impl Drop for DropProbe {
            fn drop(&mut self) {
                self.0.store(true, Ordering::SeqCst);
            }
        }
        let token = tokio_util::sync::CancellationToken::new();
        let dropped = Arc::new(AtomicBool::new(false));
        let committed = Arc::new(AtomicBool::new(false));
        let (started_tx, started_rx) = tokio::sync::oneshot::channel();
        let work_token = token.clone();
        let work_dropped = dropped.clone();
        let work_committed = committed.clone();
        let task = tokio::spawn(async move {
            let result = super::prepare_compression_cancellable(&work_token, async {
                let _probe = DropProbe(work_dropped);
                started_tx.send(()).unwrap();
                std::future::pending::<()>().await;
                Ok(())
            })
            .await;
            if result.is_ok() {
                work_committed.store(true, Ordering::SeqCst);
            }
            result
        });
        started_rx.await.unwrap();
        token.cancel();
        let result = tokio::time::timeout(Duration::from_secs(1), task)
            .await
            .expect("Cancellation must not wait for pending work")
            .unwrap();
        assert!(matches!(result, Err(crate::OpenBitFunError::Cancelled(_))));
        assert!(dropped.load(Ordering::SeqCst));
        assert!(!committed.load(Ordering::SeqCst));
    }

    #[tokio::test]
    async fn compression_cancellation_in_completion_poll_rejects_result() {
        let token = tokio_util::sync::CancellationToken::new();
        let result = super::prepare_compression_cancellable(&token, async {
            token.cancel();
            Ok("summary that must not be committed")
        })
        .await;
        assert!(matches!(result, Err(crate::OpenBitFunError::Cancelled(_))));
    }

    #[tokio::test]
    async fn compression_preparation_preserves_success_and_failure() {
        let token = tokio_util::sync::CancellationToken::new();
        assert_eq!(
            super::prepare_compression_cancellable(&token, async { Ok(42) })
                .await
                .unwrap(),
            42
        );
        let result = super::prepare_compression_cancellable::<()>(&token, async {
            Err(crate::OpenBitFunError::Session(
                "preparation failed".to_string(),
            ))
        })
        .await;
        assert!(
            matches!(result, Err(crate::OpenBitFunError::Session(message)) if message == "preparation failed")
        );
    }

    fn resolved_tool_manifest(
        allowed_tool_names: &[&str],
        tool_definition_names: &[&str],
    ) -> ResolvedToolManifest {
        ResolvedToolManifest {
            allowed_tool_names: allowed_tool_names
                .iter()
                .map(|name| (*name).to_string())
                .collect(),
            tool_definitions: tool_definition_names
                .iter()
                .map(|name| ToolDefinition {
                    name: (*name).to_string(),
                    description: format!("{name} description"),
                    parameters: json!({"type": "object"}),
                })
                .collect(),
            deferred_tool_names: Vec::new(),
            deferred_tool_summaries: Vec::new(),
            catalog_generation: 0,
        }
    }

    #[test]
    fn tool_manifest_listings_are_preserved() {
        let sections = ToolListingSections {
            skill_listing: Some("<available_skills>pdf</available_skills>".to_string()),
            agent_listing: Some("<available_agents>Explore</available_agents>".to_string()),
            direct_tool_listing: None,
            deferred_tool_listing: None,
        };

        let (skill_listing, agent_listing) = skill_agent_listing_reminders(Some(&sections));

        assert!(skill_listing
            .as_deref()
            .is_some_and(|listing| listing.contains("# Skill Listing")));
        assert!(agent_listing
            .as_deref()
            .is_some_and(|listing| listing.contains("# Agent Listing")));
    }

    #[test]
    fn runtime_context_tracks_model_visible_command_controls() {
        let base = resolved_tool_manifest(
            &[
                "Read",
                "Edit",
                "Write",
                "ExecCommand",
                "WriteStdin",
                "ExecControl",
            ],
            &["Read", "Write", "Edit", "ExecCommand"],
        );
        let active = resolved_tool_manifest(
            &[
                "Read",
                "Edit",
                "Write",
                "ExecCommand",
                "WriteStdin",
                "ExecControl",
            ],
            &[
                "Read",
                "Write",
                "Edit",
                "ExecCommand",
                "WriteStdin",
                "ExecControl",
            ],
        );

        assert!(!runtime_context_needs_for_manifest(&base).exec_control);
        assert!(runtime_context_needs_for_manifest(&active).exec_control);
    }

    #[test]
    fn zero_max_rounds_disables_the_fixed_round_limit() {
        assert!(!reached_fixed_model_round_limit(0, 0));
        assert!(!reached_fixed_model_round_limit(0, 10_000));
    }

    #[test]
    fn positive_max_rounds_stops_at_the_configured_limit() {
        assert!(!reached_fixed_model_round_limit(200, 199));
        assert!(reached_fixed_model_round_limit(200, 200));
        assert!(reached_fixed_model_round_limit(200, 201));
    }

    #[test]
    fn max_rounds_execution_config_projects_the_global_ai_limit() {
        let mut ai_config = AIConfig::default();
        ai_config.max_rounds = 37;

        assert_eq!(
            ExecutionEngineConfig::from_ai_config(&ai_config).max_rounds,
            37
        );
    }

    #[test]
    fn recovered_execution_starts_after_existing_model_rounds() {
        let mut context = std::collections::HashMap::new();
        context.insert("initial_round_index".to_string(), "3".to_string());

        assert_eq!(super::initial_round_index(&context), 3);
        assert_eq!(
            super::initial_round_index(&std::collections::HashMap::new()),
            0
        );
    }

    #[test]
    fn interrupted_continue_reminder_is_visible_only_to_its_own_turn() {
        let reminder = Message::internal_reminder(
            InternalReminderKind::InterruptedContinue,
            "continue the interrupted work".to_string(),
        )
        .with_turn_id("turn-interrupted".to_string());

        assert!(!ExecutionEngine::is_stale_interrupted_continue(
            &reminder,
            "turn-interrupted"
        ));
        assert!(ExecutionEngine::is_stale_interrupted_continue(
            &reminder, "turn-new"
        ));
    }

    #[test]
    fn coordinator_owned_cancellation_suppresses_early_cancelled_event() {
        let mut context = std::collections::HashMap::new();
        assert!(super::execution_engine_owns_cancel_lifecycle(&context));
        context.insert(
            super::super::types::CANCEL_LIFECYCLE_OWNER_CONTEXT_KEY.to_string(),
            "coordinator".to_string(),
        );
        assert!(!super::execution_engine_owns_cancel_lifecycle(&context));
    }

    #[test]
    fn round_permission_mode_prefers_mutable_turn_then_fixed_child_then_session() {
        assert_eq!(
            resolve_round_permission_mode(
                Some(PermissionMode::Ask),
                Some(PermissionMode::FullAccess),
                Some(PermissionMode::AutoApprove),
                PermissionMode::FullAccess,
            ),
            PermissionMode::Ask,
        );
        assert_eq!(
            resolve_round_permission_mode(
                None,
                Some(PermissionMode::FullAccess),
                Some(PermissionMode::Ask),
                PermissionMode::AutoApprove,
            ),
            PermissionMode::FullAccess,
        );
        assert_eq!(
            resolve_round_permission_mode(
                None,
                None,
                Some(PermissionMode::AutoApprove),
                PermissionMode::Ask,
            ),
            PermissionMode::AutoApprove,
        );
    }

    #[test]
    fn manual_compaction_preserves_cancellation_as_a_terminal_cancellation() {
        let error = manual_compaction_terminal_error(crate::OpenBitFunError::Cancelled(
            "cancelled by user".to_string(),
        ));

        assert!(matches!(error, crate::OpenBitFunError::Cancelled(_)));
    }

    #[derive(Clone)]
    struct InstructionWorkspaceFs {
        operation_count: Arc<AtomicUsize>,
        fail_next_probe: Arc<AtomicBool>,
    }

    impl InstructionWorkspaceFs {
        fn recovering() -> Self {
            Self {
                operation_count: Arc::new(AtomicUsize::new(0)),
                fail_next_probe: Arc::new(AtomicBool::new(true)),
            }
        }

        fn stable() -> Self {
            Self {
                operation_count: Arc::new(AtomicUsize::new(0)),
                fail_next_probe: Arc::new(AtomicBool::new(false)),
            }
        }

        fn record(&self) {
            self.operation_count.fetch_add(1, Ordering::SeqCst);
        }

        fn operation_count(&self) -> usize {
            self.operation_count.load(Ordering::SeqCst)
        }
    }

    #[async_trait::async_trait]
    impl WorkspaceFileSystem for InstructionWorkspaceFs {
        async fn read_file(&self, path: &str) -> anyhow::Result<Vec<u8>> {
            Ok(self.read_file_text(path).await?.into_bytes())
        }

        async fn read_file_text(&self, path: &str) -> anyhow::Result<String> {
            self.record();
            Ok(if path.ends_with("AGENTS.md") {
                "Recovered workspace instructions.".to_string()
            } else {
                String::new()
            })
        }

        async fn write_file(&self, _path: &str, _contents: &[u8]) -> anyhow::Result<()> {
            anyhow::bail!("writes are not supported")
        }

        async fn exists(&self, path: &str) -> anyhow::Result<bool> {
            self.is_file(path).await
        }

        async fn is_file(&self, path: &str) -> anyhow::Result<bool> {
            self.record();
            if path.ends_with("AGENTS.override.md")
                && self.fail_next_probe.swap(false, Ordering::SeqCst)
            {
                anyhow::bail!("temporary workspace connection failure")
            }
            Ok(path.ends_with("AGENTS.md") && !path.ends_with("AGENTS.override.md"))
        }

        async fn is_dir(&self, _path: &str) -> anyhow::Result<bool> {
            Ok(false)
        }

        async fn path_kind_no_follow(
            &self,
            path: &str,
        ) -> anyhow::Result<Option<WorkspacePathKind>> {
            self.record();
            if path.ends_with("AGENTS.override.md")
                && self.fail_next_probe.swap(false, Ordering::SeqCst)
            {
                anyhow::bail!("temporary workspace connection failure")
            }
            Ok(
                (path.ends_with("AGENTS.md") && !path.ends_with("AGENTS.override.md"))
                    .then_some(WorkspacePathKind::File),
            )
        }

        async fn read_dir(&self, _path: &str) -> anyhow::Result<Vec<WorkspaceDirEntry>> {
            Ok(Vec::new())
        }
    }

    fn workspace_with_fs(
        fs: Arc<dyn WorkspaceFileSystem>,
    ) -> (
        WorkspaceBinding,
        crate::agentic::workspace::WorkspaceServices,
    ) {
        let workspace_root = PathBuf::from("/workspace");
        let mut workspace_services =
            local_workspace_services(workspace_root.to_string_lossy().to_string());
        workspace_services.fs = fs;
        let identity =
            workspace_session_identity("/workspace", Some("instruction-test"), Some("remote-host"))
                .expect("remote test identity");
        (
            WorkspaceBinding::new_remote(
                None,
                workspace_root,
                "instruction-test".to_string(),
                "Instruction test".to_string(),
                identity,
            ),
            workspace_services,
        )
    }

    fn build_model(id: &str, name: &str, model_name: &str) -> AIModelConfig {
        AIModelConfig {
            id: id.to_string(),
            name: name.to_string(),
            model_name: model_name.to_string(),
            provider: "anthropic".to_string(),
            enabled: true,
            ..Default::default()
        }
    }

    fn message_text(message: &Message) -> Option<&str> {
        match &message.content {
            crate::agentic::core::MessageContent::Text(text) => Some(text.as_str()),
            _ => None,
        }
    }

    #[tokio::test]
    async fn user_context_without_instruction_policy_does_not_read_instruction_files() {
        let fs = InstructionWorkspaceFs::recovering();
        let (workspace, workspace_services) = workspace_with_fs(Arc::new(fs.clone()));
        let prompt_context = PromptBuilderContext::new(
            "/workspace".to_string(),
            Some("session".to_string()),
            Some("model".to_string()),
        );
        let (_, cacheable) = ExecutionEngine::build_user_context_for_cache_miss(
            Some(&workspace),
            Some(&workspace_services),
            prompt_context,
            &UserContextPolicy::empty().with_workspace_context(),
        )
        .await;

        assert!(cacheable);
        assert_eq!(fs.operation_count(), 0);
    }

    #[tokio::test]
    async fn workspace_instruction_read_failure_is_not_cacheable_and_can_recover() {
        let fs = InstructionWorkspaceFs::recovering();
        let (workspace, workspace_services) = workspace_with_fs(Arc::new(fs));
        let prompt_context = PromptBuilderContext::new(
            "/workspace".to_string(),
            Some("session".to_string()),
            Some("model".to_string()),
        );
        let policy = UserContextPolicy::empty()
            .with_workspace_context()
            .with_workspace_instructions();

        let (degraded_context, degraded_cacheable) =
            ExecutionEngine::build_user_context_for_cache_miss(
                Some(&workspace),
                Some(&workspace_services),
                prompt_context.clone(),
                &policy,
            )
            .await;
        assert!(!degraded_cacheable);
        assert!(!degraded_context
            .as_deref()
            .unwrap_or_default()
            .contains("Recovered workspace instructions."));

        let (recovered_context, recovered_cacheable) =
            ExecutionEngine::build_user_context_for_cache_miss(
                Some(&workspace),
                Some(&workspace_services),
                prompt_context,
                &policy,
            )
            .await;
        assert!(recovered_cacheable);
        assert!(recovered_context
            .as_deref()
            .unwrap_or_default()
            .contains("Recovered workspace instructions."));
    }

    #[cfg(feature = "external-sources")]
    #[tokio::test]
    async fn local_workspace_services_still_include_local_user_instruction_sources() {
        let _environment = lock_environment();
        let temp = tempfile::tempdir().expect("tempdir");
        let workspace_root = temp.path().join("workspace");
        let xdg = temp.path().join("xdg");
        let codex = temp.path().join("codex");
        let claude = temp.path().join("claude");
        std::fs::create_dir_all(xdg.join("opencode")).expect("OpenCode config directory");
        std::fs::create_dir_all(&codex).expect("Codex config directory");
        std::fs::create_dir_all(&claude).expect("Claude config directory");
        std::fs::create_dir_all(&workspace_root).expect("workspace directory");
        std::fs::write(xdg.join("opencode/AGENTS.md"), "Local engine user\n")
            .expect("OpenCode instructions");
        std::fs::write(workspace_root.join("AGENTS.md"), "Local engine project\n")
            .expect("workspace instructions");
        let _guard = EnvironmentGuard::set(&[
            ("XDG_CONFIG_HOME", &xdg),
            ("CODEX_HOME", &codex),
            ("CLAUDE_CONFIG_DIR", &claude),
        ]);
        let workspace = WorkspaceBinding::new(None, workspace_root.clone());
        let workspace_services =
            local_workspace_services(workspace_root.to_string_lossy().to_string());
        let policy = UserContextPolicy::empty().with_workspace_instructions();

        let (context, cacheable) = ExecutionEngine::build_user_context_for_cache_miss(
            Some(&workspace),
            Some(&workspace_services),
            PromptBuilderContext::new(
                workspace_root.to_string_lossy().to_string(),
                Some("session".to_string()),
                Some("model".to_string()),
            ),
            &policy,
        )
        .await;
        let context = context.expect("user context");

        assert!(cacheable);
        assert!(context.contains("Local engine user"));
        assert!(context.contains("Local engine project"));
    }

    #[cfg(feature = "external-sources")]
    #[tokio::test]
    async fn local_workspace_services_remain_the_project_instruction_io_owner() {
        let _environment = lock_environment();
        let temp = tempfile::tempdir().expect("tempdir");
        let workspace_root = temp.path().join("workspace");
        let xdg = temp.path().join("xdg");
        let codex = temp.path().join("codex");
        let claude = temp.path().join("claude");
        std::fs::create_dir_all(xdg.join("opencode")).expect("OpenCode config directory");
        std::fs::create_dir_all(&codex).expect("Codex config directory");
        std::fs::create_dir_all(&claude).expect("Claude config directory");
        std::fs::create_dir_all(&workspace_root).expect("workspace directory");
        std::fs::write(xdg.join("opencode/AGENTS.md"), "Local user source\n")
            .expect("OpenCode instructions");
        std::fs::write(workspace_root.join("AGENTS.md"), "Disk project source\n")
            .expect("disk instructions");
        let _guard = EnvironmentGuard::set(&[
            ("XDG_CONFIG_HOME", &xdg),
            ("CODEX_HOME", &codex),
            ("CLAUDE_CONFIG_DIR", &claude),
        ]);
        let workspace = WorkspaceBinding::new(None, workspace_root.clone());
        let mut workspace_services =
            local_workspace_services(workspace_root.to_string_lossy().to_string());
        workspace_services.fs = Arc::new(InstructionWorkspaceFs::stable());
        let policy = UserContextPolicy::empty().with_workspace_instructions();

        let (context, cacheable) = ExecutionEngine::build_user_context_for_cache_miss(
            Some(&workspace),
            Some(&workspace_services),
            PromptBuilderContext::new(
                workspace_root.to_string_lossy().to_string(),
                Some("session".to_string()),
                Some("model".to_string()),
            ),
            &policy,
        )
        .await;
        let context = context.expect("user context");

        assert!(cacheable);
        assert!(context.contains("Local user source"));
        assert!(context.contains("Recovered workspace instructions."));
        assert!(!context.contains("Disk project source"));
    }

    #[cfg(feature = "external-sources")]
    #[tokio::test]
    async fn conditional_rules_persist_once_and_reload_after_compaction() {
        let _environment = lock_environment();
        let temp = tempfile::tempdir().expect("tempdir");
        let workspace_root = temp.path().join("workspace");
        let claude = temp.path().join("claude");
        let xdg = temp.path().join("xdg");
        let codex = temp.path().join("codex");
        std::fs::create_dir_all(workspace_root.join(".claude/rules")).expect("workspace rules");
        std::fs::create_dir_all(&claude).expect("Claude config");
        std::fs::create_dir_all(xdg.join("opencode")).expect("OpenCode config");
        std::fs::create_dir_all(&codex).expect("Codex config");
        let rule_path = workspace_root.join(".claude/rules/rust.md");
        std::fs::write(&rule_path, "---\npaths:\n  - src/**/*.rs\n---\nOld rule\n")
            .expect("old rule");
        let _guard = EnvironmentGuard::set(&[
            ("XDG_CONFIG_HOME", &xdg),
            ("CODEX_HOME", &codex),
            ("CLAUDE_CONFIG_DIR", &claude),
        ]);

        let session_manager = SessionManager::new(
            Arc::new(SessionContextStore::new()),
            Arc::new(
                PersistenceManager::new(Arc::new(PathManager::with_user_root_for_tests(
                    temp.path().join("user-root"),
                )))
                .expect("persistence manager"),
            ),
            SessionManagerConfig {
                max_active_sessions: 4,
                session_idle_timeout: Duration::from_secs(3600),
                auto_save_interval: Duration::from_secs(300),
                enable_persistence: false,
                prompt_cache_policy: PromptCachePolicy::default(),
            },
        );
        let workspace = WorkspaceBinding::new(None, workspace_root.clone());
        let context = crate::agentic::execution::types::ExecutionContext {
            session_id: "session".to_string(),
            dialog_turn_id: "turn".to_string(),
            turn_index: 0,
            agent_type: "Standard".to_string(),
            workspace: Some(workspace),
            context: HashMap::new(),
            subagent_parent_info: None,
            permission_delegation: None,
            permission_runtime_ceiling: None,
            delegation_policy: openbitfun_runtime_ports::DelegationPolicy::top_level(),
            runtime_tool_restrictions: ToolRuntimeRestrictions::default(),
            workspace_services: Some(local_workspace_services(
                workspace_root.to_string_lossy().to_string(),
            )),
            terminal_port: None,
            remote_exec_port: None,
            round_injection: None,
            emit_lifecycle_events: false,
            recover_partial_on_cancel: false,
        };
        let mut messages = vec![
            Message::system("system".to_string()),
            Message::user("older request".repeat(200)),
        ];
        for message in messages.iter().cloned() {
            session_manager
                .add_message(&context.session_id, message)
                .await
                .expect("seed context");
        }

        let first_round = conditional_read_round(&workspace_root, "round-1");
        append_round_messages(
            &session_manager,
            &context.session_id,
            &first_round,
            &mut messages,
        )
        .await;
        activate_conditional_instructions_after_round(
            &session_manager,
            &context,
            &first_round,
            &mut messages,
        )
        .await;
        activate_conditional_instructions_after_round(
            &session_manager,
            &context,
            &first_round,
            &mut messages,
        )
        .await;

        assert_eq!(conditional_reminders(&messages).len(), 1);
        let persisted = session_manager
            .get_context_messages(&context.session_id)
            .await
            .expect("persisted context");
        assert_eq!(conditional_reminders(&persisted).len(), 1);
        assert!(conditional_reminders(&persisted)[0]
            .content
            .to_string()
            .contains("Old rule"));

        let compressor = ContextCompressor::new();
        let plan = compressor
            .plan_compression(&context.session_id, &persisted, 128_000, 100)
            .expect("compression plan")
            .expect("compressible context");
        let compressed = compressor
            .compress_plan_with_contract(&context.session_id, plan, None, "summary".to_string())
            .expect("compression result")
            .messages;
        session_manager
            .replace_context_messages(&context.session_id, compressed.clone())
            .await;
        assert!(conditional_reminders(&compressed).is_empty());
        assert!(conditional_reminders(
            &session_manager
                .get_context_messages(&context.session_id)
                .await
                .expect("compacted context")
        )
        .is_empty());

        std::fs::write(&rule_path, "---\npaths:\n  - src/**/*.rs\n---\nNew rule\n")
            .expect("new rule");
        messages = compressed;
        let second_round = conditional_read_round(&workspace_root, "round-2");
        append_round_messages(
            &session_manager,
            &context.session_id,
            &second_round,
            &mut messages,
        )
        .await;
        activate_conditional_instructions_after_round(
            &session_manager,
            &context,
            &second_round,
            &mut messages,
        )
        .await;

        let reloaded = conditional_reminders(&messages);
        assert_eq!(reloaded.len(), 1);
        assert!(reloaded[0].content.to_string().contains("New rule"));
        assert!(!reloaded[0].content.to_string().contains("Old rule"));
    }

    fn conditional_read_round(workspace_root: &std::path::Path, round_id: &str) -> RoundResult {
        let assistant = Message::assistant("Reading source".to_string())
            .with_turn_id("turn".to_string())
            .with_round_id(round_id.to_string());
        let tool_result = Message::tool_result(ToolResult {
            tool_id: format!("{round_id}-read"),
            tool_name: openbitfun_agent_tools::CALL_DEFERRED_TOOL_NAME.to_string(),
            effective_tool_name: Some("Read".to_string()),
            result: json!({ "file_path": workspace_root.join("src/lib.rs") }),
            result_for_assistant: Some("source".to_string()),
            is_error: false,
            duration_ms: Some(1),
            image_attachments: None,
        })
        .with_turn_id("turn".to_string())
        .with_round_id(round_id.to_string());
        RoundResult {
            assistant_message: assistant,
            assistant_message_committed: false,
            tool_calls: Vec::new(),
            tool_result_messages: vec![tool_result],
            has_more_rounds: true,
            finish_reason: crate::agentic::execution::types::FinishReason::Complete,
            usage: None,
            provider_metadata: None,
            partial_recovery_reason: None,
            had_assistant_text: false,
            had_thinking_content: false,
        }
    }

    async fn append_round_messages(
        session_manager: &SessionManager,
        session_id: &str,
        round: &RoundResult,
        messages: &mut Vec<Message>,
    ) {
        for message in std::iter::once(&round.assistant_message)
            .chain(round.tool_result_messages.iter())
            .cloned()
        {
            messages.push(message.clone());
            session_manager
                .add_message(session_id, message)
                .await
                .expect("persist round message");
        }
    }

    fn conditional_reminders(messages: &[Message]) -> Vec<&Message> {
        messages
            .iter()
            .filter(|message| {
                message.internal_reminder_kind()
                    == Some(InternalReminderKind::ConditionalInstructions)
            })
            .collect()
    }

    #[tokio::test]
    async fn remote_workspace_without_services_is_not_cacheable() {
        let identity = workspace_session_identity(
            "/remote/workspace",
            Some("connection-1"),
            Some("remote-host"),
        )
        .expect("remote identity");
        let workspace = WorkspaceBinding::new_remote(
            None,
            PathBuf::from("/remote/workspace"),
            "connection-1".to_string(),
            "Remote".to_string(),
            identity,
        );
        let policy = UserContextPolicy::empty()
            .with_workspace_context()
            .with_workspace_instructions();

        let (_, cacheable) = ExecutionEngine::build_user_context_for_cache_miss(
            Some(&workspace),
            None,
            PromptBuilderContext::new(
                "/remote/workspace".to_string(),
                Some("session".to_string()),
                Some("model".to_string()),
            ),
            &policy,
        )
        .await;

        assert!(!cacheable);
    }

    #[test]
    fn resolve_configured_fast_model_falls_back_to_primary_when_fast_is_stale() {
        let mut ai_config = AIConfig {
            models: vec![build_model("model-primary", "Primary", "claude-sonnet-4.5")],
            ..Default::default()
        };
        ai_config.default_models.primary = Some("model-primary".to_string());
        ai_config.default_models.fast = Some("deleted-fast-model".to_string());

        assert_eq!(
            ExecutionEngine::resolve_configured_model_id(&ai_config, "fast"),
            "model-primary"
        );
    }

    #[test]
    fn frozen_turn_model_wins_when_the_primary_default_changes() {
        let mut ai_config = AIConfig {
            models: vec![
                build_model("model-original", "Original", "claude-sonnet-4.5"),
                build_model("model-new-default", "New default", "gpt-5.4"),
            ],
            ..Default::default()
        };
        ai_config.default_models.primary = Some("model-new-default".to_string());

        assert_eq!(
            ExecutionEngine::resolve_model_id_for_turn_selection(
                &ai_config,
                "primary",
                Some("model-original"),
            )
            .expect("the original resolved model remains available"),
            "model-original"
        );
    }

    #[test]
    fn primary_turn_model_must_resolve_to_a_concrete_model_before_persistence() {
        let ai_config = AIConfig::default();

        let error =
            ExecutionEngine::resolve_model_id_for_turn_selection(&ai_config, "primary", None)
                .expect_err("a symbolic selector cannot become the frozen Turn model");

        assert!(error.to_string().contains("primary model"), "{error}");
    }

    #[test]
    fn frozen_turn_model_must_still_be_available_for_recovery() {
        let mut model = build_model("model-original", "Original", "claude-sonnet-4.5");
        model.enabled = false;
        let ai_config = AIConfig {
            models: vec![model],
            ..Default::default()
        };

        let error = ExecutionEngine::resolve_model_id_for_turn_selection(
            &ai_config,
            "primary",
            Some("model-original"),
        )
        .expect_err("a disabled frozen model cannot execute another generation");

        assert!(error.to_string().contains("unavailable"), "{error}");
    }

    #[test]
    fn auto_compression_pressure_tracks_total_and_conversation_tokens() {
        let messages = vec![
            Message::system("system prompt".repeat(10_000)),
            Message::user("hello".to_string()),
        ];
        let tools = vec![ToolDefinition {
            name: "Read".to_string(),
            description: "Read files".repeat(5_000),
            parameters: json!({"type": "object"}),
        }];
        let prepended_reminders = ["prepended reminder".repeat(5_000)];
        let prepended_reminder_refs = prepended_reminders
            .iter()
            .map(String::as_str)
            .collect::<Vec<_>>();
        let prepended_reminder_tokens =
            ExecutionEngine::prepended_reminder_tokens_for_pressure(&prepended_reminder_refs);

        let snapshot = ExecutionEngine::estimate_auto_compression_pressure(
            &messages,
            Some(&tools),
            128_000,
            ExecutionEngine::compression_trigger_budget(128_000, None),
            prepended_reminder_tokens,
        );

        assert!(snapshot.total_tokens > snapshot.conversation_tokens);
        assert!(snapshot.system_tokens > 0);
        assert!(snapshot.tool_tokens > 0);
        assert_eq!(
            snapshot.prepended_reminder_tokens,
            prepended_reminder_tokens
        );
        assert!(
            (snapshot.usage_ratio - snapshot.total_tokens as f32 / 128_000_f32).abs()
                < f32::EPSILON
        );
        assert_eq!(messages[1].role, MessageRole::User);
    }

    #[test]
    fn compression_trigger_budget_reserves_output_and_safety_tokens() {
        let budget = ExecutionEngine::compression_trigger_budget(128_000, Some(32_000));

        assert_eq!(budget.output_reserve_tokens, 32_000);
        assert_eq!(budget.safety_reserve_tokens, 10_000);
        assert_eq!(budget.input_limit, 86_000);
    }

    #[test]
    fn compression_trigger_budget_uses_the_automatic_output_tier_when_max_tokens_is_unset() {
        let budget = ExecutionEngine::compression_trigger_budget(128_000, None);

        assert_eq!(budget.output_reserve_tokens, 32_000);
        assert_eq!(budget.safety_reserve_tokens, 10_000);
        assert_eq!(budget.input_limit, 86_000);
    }

    #[test]
    fn auto_compression_pressure_uses_provider_input_anchor_plus_tail_estimate() {
        let prefix = vec![
            Message::system("system prompt".to_string()),
            Message::user("hello".to_string()),
        ];
        let system_tokens = ExecutionEngine::system_tokens_for_pressure(&prefix);
        let anchor = TokenAnchor::from_request_prefix(
            TokenAnchorInput {
                session_id: "session".to_string(),
                turn_id: "turn".to_string(),
                round_id: "round".to_string(),
                model_id: "model".to_string(),
                input_tokens: 100,
                system_tokens_at_anchor: system_tokens,
                tool_tokens_at_anchor: 0,
                prepended_reminder_tokens_at_anchor: 0,
            },
            &prefix,
        );
        let mut messages = prefix;
        messages.push(Message::assistant("assistant tail".repeat(10)));
        let tail_tokens =
            ExecutionEngine::estimate_tail_tokens(&messages[anchor.prefix_message_count..]);

        let (snapshot, details) = ExecutionEngine::estimate_auto_compression_pressure_with_anchor(
            &messages,
            None,
            1_000,
            ExecutionEngine::compression_trigger_budget(1_000, None),
            Some(&anchor),
            0,
        );

        assert_eq!(snapshot.total_tokens, 100 + tail_tokens);
        assert_eq!(details.expect("anchor details").tail_tokens, tail_tokens);
    }

    #[test]
    fn auto_compression_pressure_applies_tool_definition_delta_to_anchor() {
        let messages = vec![
            Message::system("system prompt".to_string()),
            Message::user("hello".to_string()),
        ];
        let old_tools = vec![ToolDefinition {
            name: "Read".to_string(),
            description: "read files".to_string(),
            parameters: json!({"type": "object"}),
        }];
        let new_tools = vec![ToolDefinition {
            name: "Read".to_string(),
            description: "read files with a longer provider-visible description".repeat(10),
            parameters: json!({"type": "object"}),
        }];
        let old_tool_tokens =
            crate::util::TokenCounter::estimate_tool_definitions_tokens(&old_tools);
        let new_tool_tokens =
            crate::util::TokenCounter::estimate_tool_definitions_tokens(&new_tools);
        let anchor = TokenAnchor::from_request_prefix(
            TokenAnchorInput {
                session_id: "session".to_string(),
                turn_id: "turn".to_string(),
                round_id: "round".to_string(),
                model_id: "model".to_string(),
                input_tokens: 100,
                system_tokens_at_anchor: ExecutionEngine::system_tokens_for_pressure(&messages),
                tool_tokens_at_anchor: old_tool_tokens,
                prepended_reminder_tokens_at_anchor: 0,
            },
            &messages,
        );

        let (snapshot, details) = ExecutionEngine::estimate_auto_compression_pressure_with_anchor(
            &messages,
            Some(&new_tools),
            1_000,
            ExecutionEngine::compression_trigger_budget(1_000, None),
            Some(&anchor),
            0,
        );

        assert_eq!(
            snapshot.total_tokens,
            100 + (new_tool_tokens - old_tool_tokens)
        );
        assert_eq!(snapshot.tool_tokens, new_tool_tokens);
        assert_eq!(
            details.expect("anchor details").tool_delta,
            (new_tool_tokens - old_tool_tokens) as isize
        );
    }

    #[test]
    fn auto_compression_pressure_applies_prepended_reminder_delta_to_anchor() {
        let messages = vec![
            Message::system("system prompt".to_string()),
            Message::user("hello".to_string()),
        ];
        let old_reminders = ["short reminder".to_string()];
        let new_reminders = ["longer reminder ".repeat(20)];
        let old_reminder_refs = old_reminders.iter().map(String::as_str).collect::<Vec<_>>();
        let new_reminder_refs = new_reminders.iter().map(String::as_str).collect::<Vec<_>>();
        let old_reminder_tokens =
            ExecutionEngine::prepended_reminder_tokens_for_pressure(&old_reminder_refs);
        let new_reminder_tokens =
            ExecutionEngine::prepended_reminder_tokens_for_pressure(&new_reminder_refs);
        let anchor = TokenAnchor::from_request_prefix(
            TokenAnchorInput {
                session_id: "session".to_string(),
                turn_id: "turn".to_string(),
                round_id: "round".to_string(),
                model_id: "model".to_string(),
                input_tokens: 100,
                system_tokens_at_anchor: ExecutionEngine::system_tokens_for_pressure(&messages),
                tool_tokens_at_anchor: 0,
                prepended_reminder_tokens_at_anchor: old_reminder_tokens,
            },
            &messages,
        );

        let (snapshot, details) = ExecutionEngine::estimate_auto_compression_pressure_with_anchor(
            &messages,
            None,
            1_000,
            ExecutionEngine::compression_trigger_budget(1_000, None),
            Some(&anchor),
            new_reminder_tokens,
        );
        let details = details.expect("anchor details");

        assert_eq!(
            snapshot.total_tokens,
            100 + (new_reminder_tokens - old_reminder_tokens)
        );
        assert_eq!(
            snapshot.conversation_tokens,
            snapshot.total_tokens
                - ExecutionEngine::system_tokens_for_pressure(&messages)
                - new_reminder_tokens
        );
        assert_eq!(snapshot.prepended_reminder_tokens, new_reminder_tokens);
        assert_eq!(
            details.prepended_reminder_delta,
            (new_reminder_tokens - old_reminder_tokens) as isize
        );
    }

    #[test]
    fn refreshed_turn_prompt_scaffold_replaces_existing_system_message() {
        let scaffold = TurnPromptScaffold {
            system_prompt_message: Message::system("new system prompt".to_string()),
            prepended_prompt_reminders: PrependedPromptReminders::default(),
        };
        let mut messages = vec![
            Message::system("old system prompt".to_string()),
            Message::user("hello".to_string()),
        ];

        ExecutionEngine::apply_turn_prompt_scaffold_to_messages(&mut messages, &scaffold);

        assert_eq!(messages.len(), 2);
        assert_eq!(messages[0].role, MessageRole::System);
        assert_eq!(message_text(&messages[0]), Some("new system prompt"));
        assert_eq!(messages[1].role, MessageRole::User);
    }

    #[test]
    fn refreshed_turn_prompt_scaffold_inserts_system_message_when_missing() {
        let scaffold = TurnPromptScaffold {
            system_prompt_message: Message::system("new system prompt".to_string()),
            prepended_prompt_reminders: PrependedPromptReminders::default(),
        };
        let mut messages = vec![Message::user("hello".to_string())];

        ExecutionEngine::apply_turn_prompt_scaffold_to_messages(&mut messages, &scaffold);

        assert_eq!(messages.len(), 2);
        assert_eq!(messages[0].role, MessageRole::System);
        assert_eq!(message_text(&messages[0]), Some("new system prompt"));
        assert_eq!(messages[1].role, MessageRole::User);
    }

    #[test]
    fn tool_signature_args_summary_truncates_on_utf8_boundary() {
        let args = format!("{}{}", "a".repeat(62), "案".repeat(30));
        let args_hash = hex::encode(Sha256::digest(args.as_bytes()));

        let summary = ExecutionEngine::tool_signature_args_summary(&args);

        assert_eq!(
            summary,
            format!("{}..#{}:sha256={}", "a".repeat(62), args.len(), args_hash)
        );
    }

    #[test]
    fn tool_signature_args_summary_keeps_short_arguments() {
        let args = r#"{"content":"short"}"#;

        let summary = ExecutionEngine::tool_signature_args_summary(args);

        assert_eq!(summary, args);
    }

    #[test]
    fn partial_continuation_allowed_for_stream_stall_reasons() {
        assert!(ExecutionEngine::should_continue_after_partial_response(
            "Stream processor watchdog timeout (no data received for 45 seconds)"
        ));
        assert!(ExecutionEngine::should_continue_after_partial_response(
            "Stream processing error: SSE stream error"
        ));
    }

    #[test]
    fn partial_continuation_skipped_for_user_cancellation() {
        assert!(!ExecutionEngine::should_continue_after_partial_response(
            "Stream processing cancelled after partial output"
        ));
        assert!(!ExecutionEngine::should_continue_after_partial_response(
            "Stream processing cancelled"
        ));
    }

    #[test]
    fn finalize_tool_names_match_tool_definitions() {
        let tools = vec![
            ToolDefinition {
                name: "Read".to_string(),
                description: String::new(),
                parameters: json!({}),
            },
            ToolDefinition {
                name: "ExecCommand".to_string(),
                description: String::new(),
                parameters: json!({}),
            },
        ];

        assert_eq!(
            ExecutionEngine::finalize_tool_names(Some(&tools)),
            vec!["Read".to_string(), "ExecCommand".to_string()]
        );
    }

    #[test]
    fn finalize_runtime_tool_restrictions_deny_all_finalize_tools() {
        let context = crate::agentic::execution::types::ExecutionContext {
            session_id: "session".to_string(),
            dialog_turn_id: "turn".to_string(),
            turn_index: 0,
            agent_type: "Standard".to_string(),
            workspace: None,
            context: HashMap::new(),
            subagent_parent_info: None,
            permission_delegation: None,
            permission_runtime_ceiling: None,
            delegation_policy: openbitfun_runtime_ports::DelegationPolicy::top_level(),
            runtime_tool_restrictions: ToolRuntimeRestrictions::default(),
            workspace_services: None,
            terminal_port: None,
            remote_exec_port: None,
            round_injection: None,
            emit_lifecycle_events: true,
            recover_partial_on_cancel: false,
        };

        let restrictions = ExecutionEngine::finalize_runtime_tool_restrictions(
            &context,
            &["Read".to_string(), "ExecCommand".to_string()],
        );

        assert!(restrictions.denied_tool_names.contains("Read"));
        assert!(restrictions.denied_tool_names.contains("ExecCommand"));
        assert_eq!(
            restrictions.denied_tool_messages.get("Read"),
            Some(&ExecutionEngine::FINALIZE_TOOL_DENIED_MESSAGE.to_string())
        );
    }

    #[test]
    fn local_final_response_message_mentions_reason() {
        assert!(
            ExecutionEngine::build_local_final_response_message("repeated_tool_failures")
                .contains("repeated tool failures")
        );
        assert!(
            ExecutionEngine::build_local_final_response_message("max_rounds")
                .contains("round limit")
        );
        assert!(
            !ExecutionEngine::build_local_final_response_message("max_rounds")
                .contains("finalize mode")
        );
    }

    #[test]
    fn local_fallback_response_does_not_count_as_agent_final_response() {
        assert!(ExecutionEngine::should_mark_has_final_response(true, false));
        assert!(!ExecutionEngine::should_mark_has_final_response(true, true));
        assert!(!ExecutionEngine::should_mark_has_final_response(
            false, false
        ));
    }

    #[test]
    fn finalize_cache_anchor_messages_are_internal_and_not_actual_user_input() {
        let messages = ExecutionEngine::build_finalize_cache_anchor_messages(
            "turn-1",
            ExecutionEngine::FINALIZE_AFTER_MAX_ROUNDS_REMINDER,
        );

        assert_eq!(messages.len(), 2);
        assert_eq!(
            messages[0].internal_reminder_kind(),
            Some(InternalReminderKind::FinalizeCacheAnchor)
        );
        assert_eq!(
            messages[1].internal_reminder_kind(),
            Some(InternalReminderKind::FinalizeCacheAnchor)
        );
        assert!(!messages[0].is_actual_user_message());
        assert!(!messages[1].is_actual_user_message());
    }

    #[test]
    fn tool_signature_args_summary_distinguishes_same_prefix_and_length() {
        let first = format!("{}{}", "x".repeat(64), "a".repeat(80));
        let second = format!("{}{}", "x".repeat(64), "b".repeat(80));

        let first_summary = ExecutionEngine::tool_signature_args_summary(&first);
        let second_summary = ExecutionEngine::tool_signature_args_summary(&second);

        assert_eq!(first.len(), second.len());
        assert_ne!(first, second);
        assert_ne!(first_summary, second_summary);
    }

    #[test]
    fn failed_tool_round_signature_ignores_successful_repeated_calls() {
        let tool_calls = vec![ToolCall {
            tool_id: "tool-1".to_string(),
            tool_name: "PollStatus".to_string(),
            arguments: json!({ "job_id": "job-1" }),
            raw_arguments: None,
            is_error: false,
            parse_error: None,
            recovered_from_truncation: false,
            repair_kind: Default::default(),
        }];
        let results = vec![Message::tool_result(ToolResult {
            tool_id: "tool-1".to_string(),
            tool_name: "PollStatus".to_string(),
            effective_tool_name: None,
            result: json!({ "status": "pending", "success": true }),
            result_for_assistant: Some("The job is still pending.".to_string()),
            is_error: false,
            duration_ms: Some(1),
            image_attachments: None,
        })];

        assert!(
            ExecutionEngine::failed_tool_round_signature(&tool_calls, &results).is_none(),
            "successful polling must not be treated as a failed loop"
        );
    }

    #[test]
    fn failed_tool_round_signature_requires_actual_failure_evidence() {
        let tool_calls = vec![ToolCall {
            tool_id: "tool-1".to_string(),
            tool_name: "Read".to_string(),
            arguments: json!({ "path": "missing.txt" }),
            raw_arguments: None,
            is_error: false,
            parse_error: None,
            recovered_from_truncation: false,
            repair_kind: Default::default(),
        }];
        let results = vec![Message::tool_result(ToolResult {
            tool_id: "tool-1".to_string(),
            tool_name: "Read".to_string(),
            effective_tool_name: None,
            result: json!({ "success": false, "error": "not found" }),
            result_for_assistant: Some("File not found.".to_string()),
            is_error: true,
            duration_ms: Some(1),
            image_attachments: None,
        })];

        assert_eq!(
            ExecutionEngine::failed_tool_round_signature(&tool_calls, &results).as_deref(),
            Some(r#"Read:{"path":"missing.txt"}"#)
        );
    }

    #[test]
    fn periodic_loop_detector_ignores_short_windows() {
        let signatures: Vec<String> = vec!["A".to_string(), "B".to_string(), "A".to_string()];
        assert!(!ExecutionEngine::is_periodic_tool_signature_loop(
            &signatures,
            3
        ));
    }

    #[test]
    fn periodic_loop_detector_catches_consecutive_identical_window() {
        let signatures: Vec<String> = std::iter::repeat_n("A".to_string(), 6).collect();
        assert!(ExecutionEngine::is_periodic_tool_signature_loop(
            &signatures,
            3
        ));
    }

    #[test]
    fn periodic_loop_detector_catches_alternating_pattern() {
        // A-B-A-B-A-B is a stable period-2 loop with 3 distinct rounds per
        // signature. The strict consecutive check cannot see this because no
        // two adjacent rounds share the same signature.
        let signatures: Vec<String> = ["A", "B", "A", "B", "A", "B"]
            .iter()
            .map(|s| (*s).to_string())
            .collect();
        assert!(ExecutionEngine::is_periodic_tool_signature_loop(
            &signatures,
            3
        ));
    }

    #[test]
    fn periodic_loop_detector_catches_three_signature_cycle() {
        // A-B-C-A-B-C: window size 6, three distinct signatures, each twice.
        let signatures: Vec<String> = ["A", "B", "C", "A", "B", "C"]
            .iter()
            .map(|s| (*s).to_string())
            .collect();
        assert!(ExecutionEngine::is_periodic_tool_signature_loop(
            &signatures,
            3
        ));
    }

    #[test]
    fn periodic_loop_detector_skips_genuine_progress() {
        // Six distinct signatures means each tool call is a new exploration
        // step - not a loop, even if the same tool name keeps appearing.
        let signatures: Vec<String> = ["A", "B", "C", "D", "E", "F"]
            .iter()
            .map(|s| (*s).to_string())
            .collect();
        assert!(!ExecutionEngine::is_periodic_tool_signature_loop(
            &signatures,
            3
        ));
    }

    #[test]
    fn periodic_loop_detector_skips_when_a_signature_appears_only_once() {
        // A-B-A-B-A-C: trailing window has 3 distinct signatures, but C
        // appeared exactly once - the model is still introducing new work.
        let signatures: Vec<String> = ["A", "B", "A", "B", "A", "C"]
            .iter()
            .map(|s| (*s).to_string())
            .collect();
        assert!(!ExecutionEngine::is_periodic_tool_signature_loop(
            &signatures,
            3
        ));
    }

    #[test]
    fn periodic_loop_detector_only_inspects_trailing_window() {
        // The first 4 rounds were genuine exploration, but the last 6 are a
        // stable A-B alternation. We should still flag the loop.
        let signatures: Vec<String> = ["X1", "X2", "X3", "X4", "A", "B", "A", "B", "A", "B"]
            .iter()
            .map(|s| (*s).to_string())
            .collect();
        assert!(ExecutionEngine::is_periodic_tool_signature_loop(
            &signatures,
            3
        ));
    }

    #[test]
    fn periodic_loop_detector_treats_threshold_zero_like_one() {
        let signatures: Vec<String> = ["A", "A"].iter().map(|s| (*s).to_string()).collect();
        // A two-round window of identical signatures with threshold 0 should
        // still register as a loop (threshold is clamped to 1, window = 2).
        assert!(ExecutionEngine::is_periodic_tool_signature_loop(
            &signatures,
            0
        ));
    }

    #[test]
    fn context_health_snapshot_scores_repeated_tool_signatures() {
        let signatures = vec![
            r#"ExecCommand:{"cmd":"cargo test"}"#.to_string(),
            r#"ExecCommand:{"cmd":"cargo test"}"#.to_string(),
            r#"ExecCommand:{"cmd":"cargo test"}"#.to_string(),
        ];

        let snapshot =
            ContextHealthSnapshot::from_runtime_observations(0.82, 1, 0, &signatures, &[]);

        assert!((snapshot.token_usage_ratio - 0.82).abs() < f32::EPSILON);
        assert_eq!(snapshot.full_compression_count, 1);
        assert_eq!(snapshot.compression_failure_count, 0);
        assert_eq!(snapshot.repeated_tool_signature_count, 3);
        assert_eq!(snapshot.consecutive_failed_commands, 0);
    }

    #[test]
    fn context_health_snapshot_counts_consecutive_failed_commands() {
        let messages = vec![
            command_result("ExecCommand", true, Some(0)),
            command_result("ExecCommand", false, Some(1)),
            command_result("ExecCommand", false, Some(128)),
        ];

        let snapshot = ContextHealthSnapshot::from_runtime_observations(0.44, 0, 2, &[], &messages);

        assert_eq!(snapshot.repeated_tool_signature_count, 0);
        assert_eq!(snapshot.consecutive_failed_commands, 2);
        assert_eq!(snapshot.compression_failure_count, 2);
    }

    #[test]
    fn provider_prompt_cache_route_key_depends_only_on_lineage() {
        let context = HashMap::new();
        let first = ExecutionEngine::model_request_context("session-1", &context);
        let same_lineage = ExecutionEngine::model_request_context("session-1", &context);
        let changed_lineage = ExecutionEngine::model_request_context("session-2", &context);

        assert_eq!(first.prompt_cache_route_key.as_deref(), Some("session-1"));
        assert_eq!(
            first.prompt_cache_route_key,
            same_lineage.prompt_cache_route_key
        );
        assert_ne!(
            first.prompt_cache_route_key,
            changed_lineage.prompt_cache_route_key
        );
    }

    #[test]
    fn model_request_context_reads_one_turn_output_schema() {
        let schema = json!({
            "type": "object",
            "properties": { "summary": { "type": "string" } }
        });
        let mut context = HashMap::new();
        context.insert(
            openbitfun_runtime_ports::OUTPUT_SCHEMA_CONTEXT_KEY.to_string(),
            schema.to_string(),
        );

        let request_context = ExecutionEngine::model_request_context("session-1", &context);

        assert_eq!(request_context.output_schema, Some(schema));
    }

    fn command_result(tool_name: &str, success: bool, exit_code: Option<i32>) -> Message {
        Message::tool_result(ToolResult {
            tool_id: format!("{}-tool", tool_name),
            tool_name: tool_name.to_string(),
            effective_tool_name: None,
            result: json!({
                "success": success,
                "exit_code": exit_code,
                "command": format!("{} command", tool_name),
            }),
            result_for_assistant: None,
            is_error: !success,
            duration_ms: Some(1),
            image_attachments: None,
        })
    }
}
