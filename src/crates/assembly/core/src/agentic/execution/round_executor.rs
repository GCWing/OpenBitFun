//! Round Executor
//!
//! Executes a single model round: calls AI, processes streaming responses, executes tools

use super::model_exchange_trace::prepare_model_exchange_trace;
use super::stream_processor::{StreamProcessOptions, StreamProcessor, StreamResult};
use super::types::{coordinator_owns_cancel_lifecycle, FinishReason, RoundContext, RoundResult};
use crate::agentic::core::{Message, ToolCall};
use crate::agentic::events::{
    AgenticEvent, EventPriority, EventQueue, ModelRoundAttemptDiagnostic,
    ModelRoundAttemptToolDiagnostic, ToolEventData,
};
use crate::agentic::memories::{
    parse_openbitfun_memory_citation, parse_openbitfun_memory_citation_payloads,
    strip_openbitfun_memory_citations,
};
use crate::agentic::permission_policy::{
    permission_mode_from_context, resolve_effective_permission_policy,
};
use crate::agentic::session::SessionManager;
use crate::agentic::tools::computer_use_host::ComputerUseHostRef;
use crate::agentic::tools::pipeline::{
    SubagentBatchExecutionPolicy as PipelineSubagentBatchExecutionPolicy, ToolExecutionContext,
    ToolExecutionOptions, ToolPipeline,
};
use crate::agentic::tools::tool_context_runtime;
use crate::agentic::tools::tool_result_storage;
use crate::agentic::MessageContent;
use crate::infrastructure::ai::AIClient;
use crate::service::config::project_permission_store::{
    load_project_permission_config_local, load_project_permission_config_remote,
};
use crate::service::config::types::AgentProfileConfig;
use crate::service::config::types::SubagentBatchExecutionPolicy as ConfigSubagentBatchExecutionPolicy;
use crate::service::config::GlobalConfigManager;
use crate::util::elapsed_ms_u64;
use crate::util::errors::{OpenBitFunError, OpenBitFunResult};
use crate::util::types::Message as AIMessage;
use crate::util::types::ToolDefinition;
use log::{debug, error, info, warn};
use openbitfun_agent_runtime::turn_cancellation::DialogTurnCancellationTokenStore;
use openbitfun_agent_tools::{parse_call_deferred_tool_input, CALL_DEFERRED_TOOL_NAME};
use openbitfun_ai_adapters::{
    ModelExchangeRequestTraceHandle, ModelExchangeResponseTrace, ModelExchangeTraceConfig,
};
use openbitfun_core_types::errors::{AiProviderError, ErrorCategory};
use openbitfun_core_types::ModelResponseReplay;
use openbitfun_runtime_ports::PermissionRule;
use std::collections::HashMap;
use std::sync::Arc;
use std::time::{Duration, Instant};
use tokio_util::sync::CancellationToken;

/// Round executor
pub struct RoundExecutor {
    stream_processor: Arc<StreamProcessor>,
    tool_pipeline: Option<Arc<ToolPipeline>>,
    event_queue: Arc<EventQueue>,
    cancellation_tokens: DialogTurnCancellationTokenStore,
    usage_service: Option<Arc<crate::service::token_usage::TokenUsageService>>,
}

/// The same observed failure facts drive HTTP and in-stream recovery. Account
/// recovery precedes other accounts, which precede explicitly allowed channels.
struct FailedModelAttempt<'a> {
    context: &'a RoundContext,
    source:
        Option<&'a Arc<dyn crate::infrastructure::ai::account_client_source::AccountClientSource>>,
    origin: Option<&'a openbitfun_core_types::ModelAccountOrigin>,
    credential_revision: Option<u64>,
    client: &'a AIClient,
    replay_origin: Option<&'a openbitfun_core_types::ModelAccountOrigin>,
    category: &'a ErrorCategory,
    retry_after_ms: Option<u64>,
    fallback_delay_ms: u64,
    effective_output: bool,
    nonportable_history: bool,
    remaining_attempts: usize,
}

fn normalize_deferred_tool_calls_for_replay(tool_calls: &mut [ToolCall]) {
    for tool_call in tool_calls {
        if tool_call.tool_name != CALL_DEFERRED_TOOL_NAME {
            continue;
        }

        let Ok(parsed) = parse_call_deferred_tool_input(&tool_call.arguments) else {
            continue;
        };
        let Ok(canonical_raw_arguments) = parsed.canonical_wire_json() else {
            continue;
        };

        tool_call.arguments = parsed.canonical_wire_arguments();
        tool_call.raw_arguments = Some(canonical_raw_arguments);
    }
}

/// Mutable lifecycle shared by all provider attempts that belong to one
/// logical model round, including attempts made after overflow recovery.
#[derive(Debug)]
pub(super) struct ModelRoundLifecycle {
    round_id: String,
    started_at: Instant,
    started_event_emitted: bool,
    attempts_started: u32,
    pub(super) safe_to_switch_model: bool,
    observed_effective_output: bool,
}

impl ModelRoundLifecycle {
    pub(super) fn new() -> Self {
        Self {
            round_id: uuid::Uuid::new_v4().to_string(),
            started_at: Instant::now(),
            started_event_emitted: false,
            attempts_started: 0,
            safe_to_switch_model: false,
            observed_effective_output: false,
        }
    }

    fn observe_output(&mut self, has_effective_output: bool) {
        self.observed_effective_output |= has_effective_output;
        self.safe_to_switch_model &= !self.observed_effective_output;
    }

    pub(super) fn allows_pool_failover(&self, error: &OpenBitFunError) -> bool {
        // Cancellation and local runtime failures also classify as Unknown.
        // Only failures from the model request may enter pool recovery.
        self.safe_to_switch_model
            && matches!(
                error,
                OpenBitFunError::AIProvider(_)
                    | OpenBitFunError::AIClient(_)
                    | OpenBitFunError::Timeout(_)
            )
    }

    fn take_started_event(&mut self) -> bool {
        if self.started_event_emitted {
            false
        } else {
            self.started_event_emitted = true;
            true
        }
    }

    fn begin_attempt(&mut self) -> u32 {
        self.attempts_started = self.attempts_started.saturating_add(1);
        self.attempts_started
    }

    pub(super) fn attempts_started(&self) -> u32 {
        self.attempts_started
    }
}

impl RoundExecutor {
    async fn candidate_after_failure(
        failure: FailedModelAttempt<'_>,
        authentication_recovery_attempted: &mut std::collections::HashSet<String>,
        excluded_accounts: &mut Vec<String>,
        excluded_channels: &mut Vec<String>,
        cancel: &CancellationToken,
    ) -> OpenBitFunResult<
        Option<(
            crate::infrastructure::ai::channel_client_source::PreparedChannel,
            &'static str,
        )>,
    > {
        if let Some(next) = Self::account_after_failure(
            failure.source,
            failure.origin,
            failure.credential_revision,
            failure.client,
            authentication_recovery_attempted,
            excluded_accounts,
            failure.replay_origin,
            failure.category,
            failure.retry_after_ms,
            failure.fallback_delay_ms,
            failure
                .context
                .model_request_context
                .prompt_cache_route_key
                .as_deref(),
            failure.effective_output,
            failure.remaining_attempts,
            cancel,
        )
        .await?
        {
            let diagnostic = if failure.origin == Some(&next.origin) {
                "authentication_recovery"
            } else {
                "account_switch"
            };
            return Ok(Some((
                crate::infrastructure::ai::channel_client_source::PreparedChannel {
                    model_id: failure.context.model_config_id.clone(),
                    client: next.client,
                    account_source: failure.source.cloned(),
                    origin: Some(next.origin),
                    credential_revision: Some(next.credential_revision),
                },
                diagnostic,
            )));
        }
        Ok(Self::channel_after_failure(
            failure.context,
            failure.category,
            failure.retry_after_ms,
            failure.fallback_delay_ms,
            failure.effective_output,
            failure.nonportable_history,
            failure.remaining_attempts,
            excluded_channels,
            cancel,
        )
        .await?
        .map(|next| (next, "channel_switch")))
    }

    async fn channel_after_failure(
        context: &RoundContext,
        category: &ErrorCategory,
        retry_after_ms: Option<u64>,
        fallback_delay_ms: u64,
        effective_output: bool,
        opaque_replay: bool,
        remaining_attempts: usize,
        excluded: &mut Vec<String>,
        cancel: &CancellationToken,
    ) -> OpenBitFunResult<Option<crate::infrastructure::ai::channel_client_source::PreparedChannel>>
    {
        let Some(source) = &context.channel_client_source else {
            return Ok(None);
        };
        if !source.automatic() {
            return Ok(None);
        }
        if !openbitfun_agent_runtime::channel_routing::may_switch_channel(
            category,
            remaining_attempts,
            effective_output,
            opaque_replay,
            cancel.is_cancelled(),
        ) {
            return Ok(None);
        }
        let until = openbitfun_agent_runtime::account_routing::cooldown_deadline(
            category,
            chrono::Utc::now().timestamp(),
            retry_after_ms,
            fallback_delay_ms,
        );
        tokio::select! {
            _ = cancel.cancelled() => return Err(OpenBitFunError::Cancelled("Execution cancelled".into())),
            _ = source.failed(&context.model_config_id, until) => {},
        }
        if !excluded.contains(&context.model_config_id) {
            excluded.push(context.model_config_id.clone());
        }
        tokio::select! {
            _ = cancel.cancelled() => Err(OpenBitFunError::Cancelled("Execution cancelled".into())),
            result = source.resolve(excluded, None, context.model_request_context.prompt_cache_route_key.as_deref(), None) => result.map_err(|error| OpenBitFunError::AIClient(error.to_string())),
        }
    }

    const MAX_STREAM_ATTEMPTS: usize = openbitfun_agent_stream::retry::MAX_MODEL_ATTEMPTS;

    fn should_retry_provider_error(category: &ErrorCategory) -> bool {
        openbitfun_agent_stream::retry::should_retry(category)
    }

    fn prefer_pool_alternative(
        category: &ErrorCategory,
        lifecycle: &ModelRoundLifecycle,
        pool_attempt: Option<&super::model_pool::PoolAttempt>,
    ) -> bool {
        lifecycle.safe_to_switch_model
            && matches!(
                category,
                ErrorCategory::Network
                    | ErrorCategory::Timeout
                    | ErrorCategory::RateLimit
                    | ErrorCategory::ProviderUnavailable
            )
            && pool_attempt.is_some_and(|attempt| attempt.has_available_alternative())
    }

    fn exhausted_response_error(
        message: String,
        attempts: usize,
        pool_selected: bool,
    ) -> OpenBitFunError {
        let message = format!("Stream retry budget exhausted after {attempts} attempts: {message}");
        if pool_selected {
            // Malformed model output is not an invalid user request. Allow the
            // outer pool to exclude this member without poisoning global health.
            OpenBitFunError::AIProvider(AiProviderError::classified(
                message,
                ErrorCategory::ModelError,
            ))
        } else {
            OpenBitFunError::AIClient(message)
        }
    }

    async fn account_after_failure(
        source: Option<
            &Arc<dyn crate::infrastructure::ai::account_client_source::AccountClientSource>,
        >,
        current: Option<&openbitfun_core_types::ModelAccountOrigin>,
        credential_revision: Option<u64>,
        rejected: &crate::infrastructure::ai::AIClient,
        authentication_recovery_attempted: &mut std::collections::HashSet<String>,
        excluded: &mut Vec<String>,
        replay_origin: Option<&openbitfun_core_types::ModelAccountOrigin>,
        category: &ErrorCategory,
        retry_after_ms: Option<u64>,
        fallback_delay_ms: u64,
        cache_lineage: Option<&str>,
        effective_output: bool,
        remaining_attempts: usize,
        cancel: &CancellationToken,
    ) -> OpenBitFunResult<Option<crate::infrastructure::ai::account_client_source::AccountClient>>
    {
        use openbitfun_agent_runtime::account_routing::{admit_account_switch, SwitchBoundary};
        let (Some(source), Some(current)) = (source, current) else {
            return Ok(None);
        };
        if !cancel.is_cancelled() {
            if let (Some(revision), Some(until)) = (
                credential_revision,
                openbitfun_agent_runtime::account_routing::cooldown_deadline(
                    category,
                    chrono::Utc::now().timestamp(),
                    retry_after_ms,
                    fallback_delay_ms,
                ),
            ) {
                tokio::select! {
                    _ = cancel.cancelled() => return Err(OpenBitFunError::Cancelled("Execution cancelled".into())),
                    result = source.failed(current,revision,until) => if let Err(error) = result {
                        warn!("Failed to persist subscription account cooldown: {error}");
                    },
                }
            }
        }
        if *category == ErrorCategory::Auth
            && !effective_output
            && remaining_attempts > 0
            && !cancel.is_cancelled()
            && authentication_recovery_attempted.insert(current.account_id.clone())
        {
            let recovered = tokio::select! {
                _ = cancel.cancelled() => return Err(OpenBitFunError::Cancelled("Execution cancelled".into())),
                result = source.recover_authentication(current, rejected) => result,
            };
            match recovered {
                Ok(Some(recovered)) if recovered.origin == *current => return Ok(Some(recovered)),
                Ok(Some(_)) => return Err(OpenBitFunError::AIClient("Authentication recovery changed the selected account identity".into())),
                Ok(None) => {},
                Err(_) => warn!("Subscription authentication recovery failed; checking the remaining declared account policy"),
            }
        }
        let boundary = SwitchBoundary {
            cancelled: cancel.is_cancelled(),
            remaining_attempts,
            effective_output,
            // Tool execution starts only after this attempt loop has settled.
            tool_side_effect_committed: false,
            // Opaque state has no cross-account reconstruction yet.
            replay_compatible: replay_origin.is_none(),
            authentication_recovery_exhausted: authentication_recovery_attempted
                .contains(&current.account_id),
        };
        if admit_account_switch(source.policy(), category, &boundary).is_err() {
            return Ok(None);
        }
        if !excluded.contains(&current.account_id) {
            excluded.push(current.account_id.clone());
        }
        tokio::select! {
            _ = cancel.cancelled() => Err(OpenBitFunError::Cancelled("Execution cancelled".into())),
            result = source.resolve_for_request(excluded, None, cache_lineage) => match result {
                Ok(selected) => Ok(selected),
                Err(error) if error.downcast_ref::<crate::infrastructure::ai::client_factory::AccountPoolUnavailable>().is_some()
                    || error.downcast_ref::<crate::infrastructure::ai::client_factory::AccountCredentialPreparationError>().is_some() => {
                    warn!("No alternate subscription account is ready; retaining the current account's existing retry policy: {error}");
                    Ok(None)
                }
                Err(error) => Err(OpenBitFunError::AIClient(error.to_string())),
            },
        }
    }

    /// Availability failures of a history-pinned candidate. Configuration
    /// drift and storage-contract errors are not availability and stay fatal.
    fn replay_producer_unavailable(error: &anyhow::Error) -> bool {
        error.downcast_ref::<crate::infrastructure::ai::channel_client_source::ChannelReplayRequirement>().is_some()
            || error.downcast_ref::<crate::infrastructure::ai::client_factory::AccountPoolUnavailable>().is_some()
            || error.downcast_ref::<crate::infrastructure::ai::client_factory::AccountCredentialPreparationError>().is_some()
    }

    fn account_resolution_error(error: anyhow::Error, replay_bound: bool) -> OpenBitFunError {
        let unavailable = error.downcast_ref::<crate::infrastructure::ai::client_factory::AccountPoolUnavailable>().is_some()
            || error.downcast_ref::<crate::infrastructure::ai::client_factory::AccountCredentialPreparationError>().is_some();
        let error = OpenBitFunError::AIClient(error.to_string());
        if replay_bound && unavailable {
            error.with_account_bound_replay()
        } else {
            error
        }
    }

    fn explain_replay_account_boundary(
        error: OpenBitFunError,
        ordered: bool,
        replay_pinned: bool,
        channel_pinned: bool,
    ) -> OpenBitFunError {
        if channel_pinned
            && openbitfun_agent_runtime::channel_routing::may_switch_channel(
                &error.error_category(),
                1,
                false,
                false,
                false,
            )
        {
            return error.with_channel_bound_replay();
        }
        if ordered
            && replay_pinned
            && matches!(
                error.error_category(),
                ErrorCategory::Auth
                    | ErrorCategory::RateLimit
                    | ErrorCategory::ProviderQuota
                    | ErrorCategory::ProviderBilling
                    | ErrorCategory::ProviderUnavailable
                    | ErrorCategory::Network
                    | ErrorCategory::Timeout
            )
        {
            return error.with_account_bound_replay();
        }
        error
    }

    fn terminal_request_error(error: &anyhow::Error, attempts: u32) -> OpenBitFunError {
        let mut provider_error = error
            .downcast_ref::<AiProviderError>()
            .cloned()
            .unwrap_or_else(|| AiProviderError::from_parts(format!("{error:#}"), None, None, None));
        provider_error.message = format!(
            "Model request failed after {attempts} attempts: {}",
            provider_error.message
        );
        if provider_error.category == ErrorCategory::ContextOverflow {
            OpenBitFunError::RecoverableContextOverflow(provider_error)
        } else {
            OpenBitFunError::AIProvider(provider_error)
        }
    }

    fn has_user_visible_assistant_text(text: &str) -> bool {
        !text.trim().is_empty()
    }

    fn retry_diagnostic(
        attempt_id: String,
        attempt_index: u32,
        category: &str,
        raw_error: Option<String>,
        tool_calls: &[ToolCall],
    ) -> ModelRoundAttemptDiagnostic {
        ModelRoundAttemptDiagnostic {
            attempt_id,
            attempt_index,
            category: category.to_string(),
            raw_error,
            tool_calls: tool_calls
                .iter()
                .filter(|tool_call| !tool_call.is_valid())
                .map(|tool_call| ModelRoundAttemptToolDiagnostic {
                    tool_id: (!tool_call.tool_id.is_empty()).then(|| tool_call.tool_id.clone()),
                    tool_name: (!tool_call.tool_name.is_empty())
                        .then(|| tool_call.tool_name.clone()),
                    raw_arguments: tool_call.raw_arguments.clone(),
                    validation_error: tool_call.parse_error.clone(),
                })
                .collect(),
        }
    }

    async fn record_retry_diagnostic(
        &self,
        context: &RoundContext,
        round_id: &str,
        attempt_id: String,
        attempt_index: u32,
        category: &str,
        raw_error: Option<String>,
        tool_calls: &[ToolCall],
    ) {
        let diagnostic =
            Self::retry_diagnostic(attempt_id, attempt_index, category, raw_error, tool_calls);
        self.emit_event(
            AgenticEvent::ModelRoundAttemptSuperseded {
                session_id: context.session_id.clone(),
                turn_id: context.dialog_turn_id.clone(),
                round_id: round_id.to_string(),
                diagnostic: diagnostic.clone(),
            },
            EventPriority::High,
        )
        .await;
    }

    pub(super) async fn record_context_overflow_recovery(
        &self,
        session_id: &str,
        turn_id: &str,
        lifecycle: &ModelRoundLifecycle,
        raw_error: String,
    ) {
        let attempt_number = lifecycle.attempts_started();
        if attempt_number == 0 {
            return;
        }
        self.emit_event(
            AgenticEvent::ModelRoundAttemptSuperseded {
                session_id: session_id.to_string(),
                turn_id: turn_id.to_string(),
                round_id: lifecycle.round_id.clone(),
                diagnostic: Self::retry_diagnostic(
                    format!("{}:attempt:{attempt_number}", lifecycle.round_id),
                    attempt_number,
                    "context_overflow",
                    Some(raw_error),
                    &[],
                ),
            },
            EventPriority::Normal,
        )
        .await;
    }

    pub(super) async fn record_pool_failover(
        &self,
        session_id: &str,
        turn_id: &str,
        lifecycle: &ModelRoundLifecycle,
        model_id: &str,
        category: &openbitfun_core_types::ErrorCategory,
    ) {
        let attempt_number = lifecycle.attempts_started();
        self.emit_event(AgenticEvent::ModelRoundAttemptSuperseded {
            session_id: session_id.into(), turn_id: turn_id.into(), round_id: lifecycle.round_id.clone(),
            diagnostic: Self::retry_diagnostic(format!("{}:attempt:{attempt_number}", lifecycle.round_id),
                attempt_number, "model_pool_failover", Some(format!("Model pool member {model_id} failed ({category:?}); selecting another compatible member")), &[]),
        }, EventPriority::Normal).await;
    }

    fn parsed_memory_citation_from_stream_result(
        stream_result: &StreamResult,
    ) -> Option<crate::agentic::core::message::MemoryCitation> {
        let payloads = stream_result
            .hidden_text_blocks
            .iter()
            .filter(|block| block.name == "memory_citation")
            .map(|block| block.payload.as_str())
            .collect::<Vec<_>>();

        parse_openbitfun_memory_citation_payloads(payloads)
            .or_else(|| parse_openbitfun_memory_citation(&stream_result.full_text))
            .map(Into::into)
    }

    fn model_response_replay(
        stream_result: &StreamResult,
        origin: Option<&openbitfun_core_types::ModelAccountOrigin>,
        channel: &str,
        protocol: &str,
        fingerprint: String,
    ) -> Option<ModelResponseReplay> {
        let capture = stream_result.model_response_replay.as_ref();
        if capture.is_none() && stream_result.thinking_signature.is_none() {
            return None;
        }
        Some(ModelResponseReplay {
            protocol: capture.map_or_else(|| protocol.into(), |capture| capture.protocol.clone()),
            channel_origin: Some(channel.into()),
            channel_fingerprint: Some(fingerprint),
            account_origin: origin.cloned(),
            items: capture
                .map(|capture| capture.items.clone())
                .unwrap_or_default(),
        })
    }

    fn map_subagent_batch_execution_policy(
        policy: ConfigSubagentBatchExecutionPolicy,
    ) -> PipelineSubagentBatchExecutionPolicy {
        match policy {
            ConfigSubagentBatchExecutionPolicy::SafeOnly => {
                PipelineSubagentBatchExecutionPolicy::SafeOnly
            }
            ConfigSubagentBatchExecutionPolicy::ForceParallel => {
                PipelineSubagentBatchExecutionPolicy::ForceParallel
            }
            ConfigSubagentBatchExecutionPolicy::Serial => {
                PipelineSubagentBatchExecutionPolicy::Serial
            }
        }
    }

    fn resolve_permission_policy(
        global: &crate::service::config::types::GlobalConfig,
        mode: openbitfun_runtime_ports::PermissionMode,
        project_rules: &[PermissionRule],
        agent_profile: Option<&AgentProfileConfig>,
        agent_definition_constraints: &openbitfun_runtime_ports::PermissionConstraintLayer,
        parent_runtime_ceiling: Option<&openbitfun_runtime_ports::PermissionRuntimeCeiling>,
    ) -> openbitfun_runtime_ports::ResolvedPermissionPolicy {
        resolve_effective_permission_policy(
            global,
            Some(mode),
            project_rules,
            agent_profile,
            Some(agent_definition_constraints),
            parent_runtime_ceiling,
            &[],
        )
    }

    /// The one place a running round learns its permission mode.
    ///
    /// Both the static preset and the interactive auto-answer preference are
    /// derived from this single value, so a round can never run with a preset
    /// from one mode and an approval behavior from another.
    fn resolve_permission_mode(
        global: &crate::service::config::types::GlobalConfig,
        context_vars: &std::collections::HashMap<String, String>,
    ) -> openbitfun_runtime_ports::PermissionMode {
        permission_mode_from_context(global, context_vars)
    }

    async fn sleep_with_cancellation(
        delay_ms: u64,
        cancel_token: &CancellationToken,
    ) -> OpenBitFunResult<()> {
        tokio::select! {
            _ = cancel_token.cancelled() => Err(OpenBitFunError::Cancelled("Execution cancelled".to_string())),
            _ = tokio::time::sleep(Duration::from_millis(delay_ms)) => Ok(()),
        }
    }

    pub fn new(
        stream_processor: Arc<StreamProcessor>,
        event_queue: Arc<EventQueue>,
        tool_pipeline: Arc<ToolPipeline>,
    ) -> Self {
        Self {
            stream_processor,
            tool_pipeline: Some(tool_pipeline),
            event_queue,
            cancellation_tokens: DialogTurnCancellationTokenStore::new(),
            usage_service: crate::service::token_usage::get_global_token_usage_service(),
        }
    }

    pub fn computer_use_host(&self) -> Option<ComputerUseHostRef> {
        self.tool_pipeline
            .as_ref()
            .and_then(|p| p.computer_use_host())
    }

    /// Execute a single model round
    pub async fn execute_round(
        &self,
        ai_client: Arc<AIClient>,
        context: RoundContext,
        ai_messages: Vec<AIMessage>,
        tool_definitions: Option<Vec<ToolDefinition>>,
        context_window: Option<usize>,
    ) -> OpenBitFunResult<RoundResult> {
        let mut lifecycle = ModelRoundLifecycle::new();
        self.execute_round_with_lifecycle(
            ai_client,
            context,
            ai_messages,
            tool_definitions,
            context_window,
            &mut lifecycle,
            None,
            None,
        )
        .await
    }

    // Keep the combined model/account routing future off the caller's task
    // stack. Tool execution and all retries still share the same lifecycle.
    pub(super) fn execute_round_with_lifecycle<'a>(
        &'a self,
        ai_client: Arc<AIClient>,
        context: RoundContext,
        ai_messages: Vec<AIMessage>,
        tool_definitions: Option<Vec<ToolDefinition>>,
        context_window: Option<usize>,
        lifecycle: &'a mut ModelRoundLifecycle,
        session_manager: Option<&'a SessionManager>,
        pool_attempt: Option<&'a super::model_pool::PoolAttempt>,
    ) -> std::pin::Pin<
        Box<dyn std::future::Future<Output = OpenBitFunResult<RoundResult>> + Send + 'a>,
    > {
        Box::pin(self.execute_round_with_lifecycle_inner(
            ai_client,
            context,
            ai_messages,
            tool_definitions,
            context_window,
            lifecycle,
            session_manager,
            pool_attempt,
        ))
    }

    async fn execute_round_with_lifecycle_inner(
        &self,
        mut ai_client: Arc<AIClient>,
        mut context: RoundContext,
        mut ai_messages: Vec<AIMessage>,
        tool_definitions: Option<Vec<ToolDefinition>>,
        context_window: Option<usize>,
        lifecycle: &mut ModelRoundLifecycle,
        session_manager: Option<&SessionManager>,
        pool_attempt: Option<&super::model_pool::PoolAttempt>,
    ) -> OpenBitFunResult<RoundResult> {
        lifecycle.safe_to_switch_model =
            pool_attempt.is_some() && !lifecycle.observed_effective_output;
        let round_started_at = lifecycle.started_at;
        let subagent_parent_info = context.subagent_parent_info.clone();
        let is_subagent = subagent_parent_info.is_some();

        let round_id = lifecycle.round_id.clone();

        // Create or reuse cancellation token
        let cancel_token = self
            .cancellation_tokens
            .get_or_insert_new(&context.dialog_turn_id);

        let channels = context.channel_client_source.clone();
        let lineage = context.model_request_context.prompt_cache_route_key.clone();
        let mut excluded_channels = Vec::new();
        let mut account_source = context.account_client_source.clone();
        let mut prepared = context.prepared_model.take();
        // Routed rounds may switch account or channel, so signed reasoning is
        // a cache preference, not a binding: keep the latest producer's state
        // and degrade it to portable history whenever that producer is not
        // available. Fixed rounds select the configured destination first;
        // all attempts project private replay state before sending.
        let routed = channels.is_some()
            || account_source.as_ref().is_some_and(|source| {
                matches!(
                    source.policy(),
                    openbitfun_agent_runtime::account_routing::AccountPolicy::Ordered(_)
                )
            });
        if routed {
            ai_messages = crate::infrastructure::ai::channel_client_source::ChannelClientSource::retain_latest_replay_origin(&ai_messages);
            // Unproven channel provenance cannot select a route member.
            if channels.is_some()
                && crate::infrastructure::ai::channel_client_source::ChannelClientSource::replay_channel(&ai_messages).is_err()
            {
                ai_messages = crate::infrastructure::ai::channel_client_source::ChannelClientSource::portable_history(&ai_messages);
            }
        }
        let mut replay_origin = if routed {
            crate::infrastructure::ai::account_client_source::opaque_replay_origin(&ai_messages)
        } else {
            // A manual model/account selection must not be pinned back to the
            // producer of old history. Its private state is projected below.
            Ok(None)
        };
        let mut has_opaque_replay = crate::infrastructure::ai::channel_client_source::ChannelClientSource::has_nonportable_history(&ai_messages);
        if let Some(channels) = &channels {
            tokio::select! {
                _ = cancel_token.cancelled() => return Err(OpenBitFunError::Cancelled("Execution cancelled".into())),
                result = channels.validate() => result,
            }.map_err(|error| OpenBitFunError::AIClient(error.to_string()))?;
            let required = crate::infrastructure::ai::channel_client_source::ChannelClientSource::replay_channel(&ai_messages).map_err(|error| OpenBitFunError::AIClient(error.to_string()).with_channel_bound_replay())?;
            let required_account = replay_origin
                .as_ref()
                .ok()
                .and_then(Option::as_ref)
                .cloned();
            // History may require a different original candidate. Otherwise
            // reuse the factory result; live authority is checked before HTTP.
            if prepared.as_ref().is_none_or(|prepared| {
                required.as_ref().is_some_and(|id| id != &prepared.model_id)
                    || required_account
                        .as_ref()
                        .is_some_and(|origin| prepared.origin.as_ref() != Some(origin))
            }) {
                let pinned = tokio::select! {
                    _ = cancel_token.cancelled() => return Err(OpenBitFunError::Cancelled("Execution cancelled".into())),
                    result = channels.resolve(&[], required.as_deref(), lineage.as_deref(), required_account.as_ref()) => result,
                };
                let pinned = match pinned {
                    Ok(Some(prepared)) => Ok(prepared),
                    Ok(None) => Err(None),
                    Err(error) if Self::replay_producer_unavailable(&error) => Err(None),
                    Err(error) => Err(Some(error)),
                };
                prepared = Some(match pinned {
                    Ok(prepared) => prepared,
                    Err(Some(error)) => return Err(OpenBitFunError::AIClient(error.to_string())),
                    Err(None) => {
                        // The producer of the signed history is unavailable:
                        // continue on any route member with portable history.
                        ai_messages = crate::infrastructure::ai::channel_client_source::ChannelClientSource::portable_history(&ai_messages);
                        replay_origin = Ok(None);
                        has_opaque_replay = false;
                        tokio::select! {
                            _ = cancel_token.cancelled() => return Err(OpenBitFunError::Cancelled("Execution cancelled".into())),
                            result = channels.resolve(&[], None, lineage.as_deref(), None) => result,
                        }.map_err(|error| OpenBitFunError::AIClient(error.to_string()))?
                            .ok_or_else(|| OpenBitFunError::AIClient("No eligible channel in the configured route".into()))?
                    }
                });
            }
        }
        let mut selected_origin = None;
        let mut selected_credential_revision = None;
        if let Some(prepared) = prepared {
            context.model_config_id = prepared.model_id;
            context.effective_model_name = prepared.client.config.model.clone();
            ai_client = prepared.client;
            account_source = prepared.account_source;
            selected_origin = prepared.origin;
            selected_credential_revision = prepared.credential_revision;
        }
        // Overflow recovery re-enters this executor with the same lifecycle.
        // The logical round starts once even though it may contain many attempts.
        if lifecycle.take_started_event() {
            self.emit_event(
                AgenticEvent::ModelRoundStarted {
                    session_id: context.session_id.clone(),
                    turn_id: context.dialog_turn_id.clone(),
                    round_id: round_id.clone(),
                    round_group_id: context.round_group_id.clone(),
                    round_index: context.round_number,
                    model_config_id: context.model_config_id.clone(),
                    effective_model_name: context.effective_model_name.clone(),
                },
                EventPriority::High,
            )
            .await;
        }

        let source = account_source.as_ref();
        let ordered = source.is_some_and(|source| {
            matches!(
                source.policy(),
                openbitfun_agent_runtime::account_routing::AccountPolicy::Ordered(_)
            )
        });
        if source.is_some() && ordered && replay_origin.is_err() {
            // Signed state without proven account provenance cannot pin a
            // pool member; continue with portable history instead.
            ai_messages = crate::infrastructure::ai::channel_client_source::ChannelClientSource::portable_history(&ai_messages);
            replay_origin = Ok(None);
            has_opaque_replay = false;
        }
        let mut replay_origin = replay_origin.ok().flatten();
        let cache_lineage = context
            .model_request_context
            .prompt_cache_route_key
            .as_deref();
        let mut excluded_accounts = Vec::new();
        let mut authentication_recovery_attempted = std::collections::HashSet::new();
        if let Some(source) = source.filter(|_| {
            selected_origin.is_none()
                || replay_origin
                    .as_ref()
                    .is_some_and(|origin| selected_origin.as_ref() != Some(origin))
        }) {
            let mut resolved = tokio::select! {
                _ = cancel_token.cancelled() => return Err(OpenBitFunError::Cancelled("Execution cancelled".into())),
                result = source.resolve_for_request(&excluded_accounts, replay_origin.as_ref(), cache_lineage) => result,
            };
            if ordered
                && replay_origin.is_some()
                && resolved
                    .as_ref()
                    .map_or_else(Self::replay_producer_unavailable, Option::is_none)
            {
                // The account that signed this history is cooling, disabled or
                // signed out: continue on the pool with portable history.
                ai_messages = crate::infrastructure::ai::channel_client_source::ChannelClientSource::portable_history(&ai_messages);
                replay_origin = None;
                has_opaque_replay = false;
                resolved = tokio::select! {
                    _ = cancel_token.cancelled() => return Err(OpenBitFunError::Cancelled("Execution cancelled".into())),
                    result = source.resolve_for_request(&excluded_accounts, None, cache_lineage) => result,
                };
            }
            let resolved = resolved
                .map_err(|error| {
                    Self::account_resolution_error(error, ordered && replay_origin.is_some())
                })?
                .ok_or_else(|| {
                    let error = OpenBitFunError::AIClient(
                        "No eligible subscription account for this model round".into(),
                    );
                    if ordered && replay_origin.is_some() {
                        error.with_account_bound_replay()
                    } else {
                        error
                    }
                })?;
            ai_client = resolved.client;
            selected_origin = Some(resolved.origin);
            selected_credential_revision = Some(resolved.credential_revision);
        }
        let mut trace_config =
            prepare_model_exchange_trace(&context, &round_id, ai_client.as_ref()).await;
        // Resolve this user policy once for the entire round, before the
        // stream begins. The stream crate receives only this immutable fact;
        // it never reads product configuration directly.
        let global_config: crate::service::config::types::GlobalConfig =
            match GlobalConfigManager::get_service().await {
                Ok(service) => service.get_config(None).await.unwrap_or_default(),
                Err(_) => Default::default(),
            };
        let allow_normal_tool_json_repair = global_config.ai.allow_tool_json_repair;
        // Every member retains the ordinary recovery budget. The outer pool
        // traversal owns member exclusion and never caps total requests at ten.
        let max_attempts = Self::MAX_STREAM_ATTEMPTS;
        let mut local_attempt_index = 0usize;
        let mut retry_reason = None;
        let (stream_result, send_to_stream_ms, stream_processing_ms, ttft_ms, final_trace_handle) = loop {
            let source = account_source.as_ref();
            let attempt_number = lifecycle.begin_attempt();
            let attempt_id = format!("{round_id}:attempt:{attempt_number}");
            // Check cancellation before opening a model stream. This catches
            // early cancellation registered before the first round starts.
            if cancel_token.is_cancelled() {
                debug!(
                    "Cancel token detected before AI request, stopping execution: session_id={}",
                    context.session_id
                );
                return Err(OpenBitFunError::Cancelled(
                    "Execution cancelled".to_string(),
                ));
            }

            // Re-check live authorization before reusing a credential on any
            // later attempt. Logout or a changed approved binding cannot be
            // bypassed by keeping a previously resolved Arc alive.
            if local_attempt_index > 0 {
                if let Some(channels) = &channels {
                    channels
                        .validate()
                        .await
                        .map_err(|error| OpenBitFunError::AIClient(error.to_string()))?;
                    if source.is_none() {
                        ai_client = tokio::select! {
                            _ = cancel_token.cancelled() => return Err(OpenBitFunError::Cancelled("Execution cancelled".into())),
                            result = channels.revalidate_plain_channel(&context.model_config_id, lineage.as_deref()) => result,
                        }.map_err(|error| OpenBitFunError::AIClient(error.to_string()))?;
                        trace_config =
                            prepare_model_exchange_trace(&context, &round_id, ai_client.as_ref())
                                .await;
                    }
                }
                if let (Some(source), Some(origin)) = (source, selected_origin.as_ref()) {
                    let resolved = tokio::select! {
                        _ = cancel_token.cancelled() => return Err(OpenBitFunError::Cancelled("Execution cancelled".into())),
                        result = source.revalidate_for_retry(origin) => result,
                    }.map_err(|error| Self::account_resolution_error(error, ordered && replay_origin.is_some()))?
                        .ok_or_else(|| {
                            let error = OpenBitFunError::AIClient("Selected subscription account is no longer eligible".into());
                            if ordered && replay_origin.is_some() { error.with_account_bound_replay() } else { error }
                        })?;
                    ai_client = resolved.client;
                    selected_origin = Some(resolved.origin);
                    selected_credential_revision = Some(resolved.credential_revision);
                    trace_config =
                        prepare_model_exchange_trace(&context, &round_id, ai_client.as_ref()).await;
                }
            }

            let account = selected_origin.clone().or_else(|| {
                ai_client
                    .subscription_provider_key()
                    .and_then(|provider| ai_client.subscription_account_origin(provider))
            });
            let stripped = crate::infrastructure::ai::channel_client_source::ChannelClientSource::project_replay_for_target(
                &mut ai_messages, &context.model_config_id, &ai_client, account.as_ref(),
            );
            if stripped > 0 {
                has_opaque_replay = crate::infrastructure::ai::channel_client_source::ChannelClientSource::has_nonportable_history(&ai_messages);
                replay_origin =
                    crate::infrastructure::ai::account_client_source::opaque_replay_origin(
                        &ai_messages,
                    )
                    .ok()
                    .flatten();
                info!("Projected incompatible model history: session_id={}, model_config_id={}, stripped_messages={}, reason=unproven_or_changed_replay_identity", context.session_id, context.model_config_id, stripped);
            }
            crate::infrastructure::ai::channel_client_source::ChannelClientSource::validate_replay_binding(&ai_messages, &context.model_config_id, &ai_client, channels.is_some())
                .map_err(|error| OpenBitFunError::AIClient(error.to_string()).with_channel_bound_replay())?;
            let mut usage_context =
                openbitfun_services_core::token_usage::types::ModelRequestUsageContext {
                    version: 1,
                    round_id: round_id.clone(),
                    attempt_id: attempt_id.clone(),
                    attempt_index: attempt_number,
                    started_at: chrono::Utc::now(),
                    authentication: if account.is_some()
                        || ai_client.subscription_provider_key().is_some()
                    {
                        openbitfun_services_core::token_usage::types::UsageAuthenticationKind::Subscription
                    } else {
                        openbitfun_services_core::token_usage::types::UsageAuthenticationKind::ApiKey
                    },
                    account,
                    channel: Some(
                        openbitfun_services_core::token_usage::types::ModelRequestChannel {
                            model_config_id: context.model_config_id.clone(),
                            name: ai_client.config.name.clone(),
                            protocol: ai_client.config.format.clone(),
                            // A channel groups its declared account candidates;
                            // replay identity separately includes the actual seat.
                            binding_fingerprint: channels
                                .as_ref()
                                .and_then(|channels| {
                                    channels.binding_fingerprint(&context.model_config_id)
                                })
                                .or_else(|| {
                                    source
                                        .and_then(|source| source.channel_binding_fingerprint())
                                        .map(str::to_owned)
                                })
                                .unwrap_or_else(|| ai_client.channel_replay_fingerprint()),
                        },
                    ),
                    policy_revision: source.and_then(|source| source.policy_revision()),
                    requested_model: ai_client.config.model.clone(),
                    response_model: None,
                    outcome:
                        openbitfun_services_core::token_usage::types::ModelRequestOutcome::Completed,
                    usage_known: false,
                    retry_reason: retry_reason.take(),
                    routing_warnings: source
                        .map(|source| source.take_routing_warnings())
                        .unwrap_or_default()
                        .into_iter()
                        .chain(
                            channels
                                .as_ref()
                                .map(|source| source.take_routing_warnings())
                                .unwrap_or_default(),
                        )
                        .collect(),
                };
            let request_started_at = Instant::now();
            debug!(
                "Sending request: model={}, messages={}, tools={}, round_attempt={}, local_retry={}/{}",
                context.effective_model_name,
                ai_messages.len(),
                tool_definitions.as_ref().map(|t| t.len()).unwrap_or(0),
                attempt_number,
                local_attempt_index + 1,
                max_attempts
            );
            // Use dynamically obtained client for call
            let request_trace_config = trace_config
                .clone()
                .map(|config| config.with_round_attempt(attempt_id.clone(), attempt_number));
            let send_future = ai_client.send_message_stream_once_with_request_context(
                ai_messages.clone(),
                tool_definitions.clone(),
                Some(context.model_request_context.clone()),
                request_trace_config,
            );
            let send_result = tokio::select! {
                _ = cancel_token.cancelled() => {
                    self.record_attempt_usage(&context, &usage_context, None, openbitfun_services_core::token_usage::types::ModelRequestOutcome::Cancelled, context_window, is_subagent).await;
                    return Err(OpenBitFunError::Cancelled("Execution cancelled".to_string()));
                }
                result = send_future => result,
            };
            let (stream_response, send_to_stream_ms) = match send_result {
                Ok(response) => {
                    let send_to_stream_ms = elapsed_ms_u64(request_started_at);
                    debug!(
                        "AI stream opened: session_id={}, round_id={}, round_attempt={}, local_retry={}/{}, send_to_stream_ms={}",
                        context.session_id,
                        round_id,
                        attempt_number,
                        local_attempt_index + 1,
                        max_attempts,
                        send_to_stream_ms
                    );
                    (response, send_to_stream_ms)
                }
                Err(e) => {
                    self.record_attempt_usage(
                        &context,
                        &usage_context,
                        None,
                        openbitfun_services_core::token_usage::types::ModelRequestOutcome::Failed,
                        context_window,
                        is_subagent,
                    )
                    .await;
                    error!("AI request failed: {:#}", e);
                    let provider_error = e.downcast_ref::<AiProviderError>().cloned();
                    let err_msg = format!("{e:#}");
                    let error = Self::terminal_request_error(&e, lifecycle.attempts_started());
                    let prefer_alternative = Self::prefer_pool_alternative(
                        &error.error_category(),
                        lifecycle,
                        pool_attempt,
                    );
                    let category = error.error_category();
                    let retryable = Self::should_retry_provider_error(&category);
                    if let Some((next, diagnostic)) = Self::candidate_after_failure(
                        FailedModelAttempt {
                            context: &context,
                            source,
                            origin: selected_origin.as_ref(),
                            credential_revision: selected_credential_revision,
                            client: ai_client.as_ref(),
                            replay_origin: replay_origin.as_ref().filter(|_| !routed),
                            category: &category,
                            retry_after_ms: provider_error
                                .as_ref()
                                .and_then(|error| error.retry_after_ms),
                            fallback_delay_ms: Self::retry_delay_ms_for_provider_error(
                                local_attempt_index,
                                &err_msg,
                                provider_error.as_ref(),
                            ),
                            effective_output: lifecycle.observed_effective_output,
                            nonportable_history: has_opaque_replay && !routed,
                            remaining_attempts: max_attempts
                                .saturating_sub(local_attempt_index + 1),
                        },
                        &mut authentication_recovery_attempted,
                        &mut excluded_accounts,
                        &mut excluded_channels,
                        &cancel_token,
                    )
                    .await?
                    {
                        self.record_retry_diagnostic(
                            &context,
                            &round_id,
                            attempt_id.clone(),
                            attempt_number,
                            diagnostic,
                            Some(err_msg.clone()),
                            &[],
                        )
                        .await;
                        if context.model_config_id != next.model_id {
                            excluded_accounts.clear();
                        }
                        if diagnostic != "authentication_recovery" && has_opaque_replay {
                            // Another credential cannot verify this signed
                            // state; the session keeps the original record.
                            ai_messages = crate::infrastructure::ai::channel_client_source::ChannelClientSource::portable_history(&ai_messages);
                            replay_origin = None;
                            has_opaque_replay = false;
                        }
                        context.model_config_id = next.model_id;
                        context.effective_model_name = next.client.config.model.clone();
                        ai_client = next.client;
                        account_source = next.account_source;
                        selected_origin = next.origin;
                        selected_credential_revision = next.credential_revision;
                        trace_config =
                            prepare_model_exchange_trace(&context, &round_id, ai_client.as_ref())
                                .await;
                        local_attempt_index += 1;
                        retry_reason = Some(category.clone());
                        continue;
                    }
                    if retryable && !prefer_alternative && local_attempt_index < max_attempts - 1 {
                        self.record_retry_diagnostic(
                            &context,
                            &round_id,
                            attempt_id.clone(),
                            attempt_number,
                            "request_error",
                            Some(err_msg.clone()),
                            &[],
                        )
                        .await;
                        let delay_ms = Self::retry_delay_ms_for_provider_error(
                            local_attempt_index,
                            &err_msg,
                            provider_error.as_ref(),
                        );
                        warn!(
                            "Retrying AI request after error: session_id={}, round_id={}, round_attempt={}, local_retry={}/{}, delay_ms={}, error={}",
                            context.session_id,
                            round_id,
                            attempt_number,
                            local_attempt_index + 1,
                            max_attempts,
                            delay_ms,
                            err_msg
                        );
                        Self::sleep_with_cancellation(delay_ms, &cancel_token).await?;
                        local_attempt_index += 1;
                        retry_reason = Some(error.error_category());
                        continue;
                    }
                    warn!(
                        "AI request stopped: session_id={}, round_id={}, attempts={}, reason={}, category={:?}, error={}",
                        context.session_id,
                        round_id,
                        lifecycle.attempts_started(),
                        if prefer_alternative { "model_pool_alternative" } else if retryable { "retry_budget_exhausted" } else { "non_retryable_error" },
                        error.error_category(),
                        error
                    );
                    return Err(Self::explain_replay_account_boundary(
                        error,
                        ordered,
                        replay_origin.is_some() && !routed,
                        channels.is_some() && has_opaque_replay && !routed,
                    ));
                }
            };

            // Destructure StreamResponse: get stream and raw SSE data receiver
            let ai_stream = stream_response.stream;
            let raw_sse_rx = stream_response.raw_sse_rx;
            let trace_handle = stream_response.trace_handle;

            // Check cancellation token before calling stream processing.
            if cancel_token.is_cancelled() {
                Self::complete_model_exchange_trace(
                    trace_config.as_ref(),
                    trace_handle.as_ref(),
                    Self::error_trace_response("cancelled", "Execution cancelled".to_string()),
                )
                .await;
                debug!(
                    "Cancel token detected after AI stream opened, stopping execution: session_id={}",
                    context.session_id
                );
                return Err(OpenBitFunError::Cancelled(
                    "Execution cancelled".to_string(),
                ));
            }

            debug!(
                "Starting AI stream processing: session={}, round={}, thread={:?}, round_attempt={}, local_retry={}/{}",
                context.session_id,
                round_id,
                std::thread::current().id(),
                attempt_number,
                local_attempt_index + 1,
                max_attempts
            );

            let stream_started_at = Instant::now();
            let request_to_stream_processing_ms = elapsed_ms_u64(request_started_at);
            match self
                .stream_processor
                .process_stream_with_options(
                    ai_stream,
                    StreamProcessor::derive_watchdog_timeout(ai_client.stream_idle_timeout()),
                    raw_sse_rx, // Pass raw SSE data receiver (for error diagnosis)
                    context.session_id.clone(),
                    context.dialog_turn_id.clone(),
                    round_id.clone(),
                    attempt_id.clone(),
                    attempt_number,
                    &cancel_token,
                    StreamProcessOptions {
                        recover_partial_on_cancel: context.recover_partial_on_cancel,
                        allow_normal_tool_json_repair,
                        suppress_cancel_lifecycle_event: coordinator_owns_cancel_lifecycle(
                            &context.context_vars,
                        ),
                        ..Default::default()
                    },
                )
                .await
            {
                Ok(result) => {
                    // Stop measuring before usage persistence or other post-stream work.
                    let stream_processing_ms = elapsed_ms_u64(stream_started_at);
                    let ttft_ms = result.first_visible_output_ms.map(|first_output_ms| {
                        request_to_stream_processing_ms.saturating_add(first_output_ms)
                    });
                    // Raw tool-argument fragments are not a usable tool call.
                    // Preserve the output latch across all retries and recovery.
                    lifecycle.observe_output(
                        !result.full_text.trim().is_empty()
                            || !result.full_thinking.is_empty()
                            || result.reasoning_content_present
                            || result.tool_calls.iter().any(|call| call.is_valid()),
                    );
                    usage_context.response_model = result.response_model.clone();
                    self.record_attempt_usage(&context, &usage_context, result.usage.as_ref(), if result.partial_recovery_reason.is_some() { openbitfun_services_core::token_usage::types::ModelRequestOutcome::Failed } else { openbitfun_services_core::token_usage::types::ModelRequestOutcome::Completed }, context_window, is_subagent).await;
                    let has_interrupted_invalid_tool_calls =
                        Self::has_interrupted_invalid_tool_calls(&result);
                    if let Some(partial_recovery_reason) = result.partial_recovery_reason.as_deref()
                    {
                        if local_attempt_index < max_attempts - 1 {
                            let diagnostic_category = if has_interrupted_invalid_tool_calls {
                                "interrupted_tool_arguments"
                            } else {
                                "partial_stream_error"
                            };
                            self.record_retry_diagnostic(
                                &context,
                                &round_id,
                                attempt_id.clone(),
                                attempt_number,
                                diagnostic_category,
                                Some(partial_recovery_reason.to_string()),
                                &result.tool_calls,
                            )
                            .await;
                            Self::complete_model_exchange_trace(
                                trace_config.as_ref(),
                                trace_handle.as_ref(),
                                Self::trace_response_from_stream_result("partial", &result),
                            )
                            .await;
                            let delay_ms = Self::retry_delay_ms_for_error(
                                local_attempt_index,
                                partial_recovery_reason,
                            );
                            warn!(
                                "Retrying stream after partial recovery error: session_id={}, round_id={}, round_attempt={}, local_retry={}/{}, delay_ms={}, effective_output={}, tool_calls={}, reason={}",
                                context.session_id,
                                round_id,
                                attempt_number,
                                local_attempt_index + 1,
                                max_attempts,
                                delay_ms,
                                result.has_effective_output,
                                result.tool_calls.len(),
                                partial_recovery_reason
                            );
                            Self::sleep_with_cancellation(delay_ms, &cancel_token).await?;
                            local_attempt_index += 1;
                            continue;
                        }
                    }

                    if has_interrupted_invalid_tool_calls {
                        let err_msg = result.partial_recovery_reason.clone().unwrap_or_else(|| {
                            "Interrupted while streaming tool arguments".to_string()
                        });

                        if Self::has_user_visible_assistant_text(&result.full_text) {
                            warn!(
                                "Dropping invalid partial tool calls after stream retry budget was exhausted; preserving assistant text: session_id={}, round_id={}, invalid_tool_calls={}, error={}",
                                context.session_id,
                                round_id,
                                result
                                    .tool_calls
                                    .iter()
                                    .filter(|tool_call| !tool_call.is_valid())
                                    .count(),
                                err_msg
                            );
                            self.emit_failed_partial_tool_calls(
                                &context,
                                &round_id,
                                &result.tool_calls,
                                &err_msg,
                            )
                            .await;
                            let mut recovered = result;
                            recovered
                                .tool_calls
                                .retain(|tool_call| tool_call.is_valid());
                            break (
                                recovered,
                                send_to_stream_ms,
                                stream_processing_ms,
                                ttft_ms,
                                trace_handle,
                            );
                        }

                        self.emit_failed_partial_tool_calls(
                            &context,
                            &round_id,
                            &result.tool_calls,
                            &err_msg,
                        )
                        .await;
                        Self::complete_model_exchange_trace(
                            trace_config.as_ref(),
                            trace_handle.as_ref(),
                            Self::error_trace_response_from_stream_result(
                                "error",
                                err_msg.clone(),
                                &result,
                            ),
                        )
                        .await;
                        return Err(Self::exhausted_response_error(
                            err_msg,
                            max_attempts,
                            pool_attempt.is_some(),
                        ));
                    }

                    let no_effective_output = !result.has_effective_output;
                    let is_partial_recovery = result.partial_recovery_reason.is_some();

                    if Self::is_invalid_tool_only_without_text(&result) {
                        let err_msg = "Provider returned only invalid tool arguments".to_string();
                        if local_attempt_index < max_attempts - 1 {
                            self.record_retry_diagnostic(
                                &context,
                                &round_id,
                                attempt_id.clone(),
                                attempt_number,
                                "invalid_tool_arguments",
                                None,
                                &result.tool_calls,
                            )
                            .await;
                            Self::complete_model_exchange_trace(
                                trace_config.as_ref(),
                                trace_handle.as_ref(),
                                Self::error_trace_response_from_stream_result(
                                    "error",
                                    err_msg.clone(),
                                    &result,
                                ),
                            )
                            .await;
                            let delay_ms = Self::retry_delay_ms(local_attempt_index);
                            warn!(
                                "Retrying stream because provider returned only invalid tool arguments: session_id={}, round_id={}, round_attempt={}, local_retry={}/{}, delay_ms={}, tool_calls={}",
                                context.session_id,
                                round_id,
                                attempt_number,
                                local_attempt_index + 1,
                                max_attempts,
                                delay_ms,
                                result.tool_calls.len()
                            );
                            Self::sleep_with_cancellation(delay_ms, &cancel_token).await?;
                            local_attempt_index += 1;
                            continue;
                        }

                        self.emit_failed_partial_tool_calls(
                            &context,
                            &round_id,
                            &result.tool_calls,
                            &err_msg,
                        )
                        .await;
                        Self::complete_model_exchange_trace(
                            trace_config.as_ref(),
                            trace_handle.as_ref(),
                            Self::error_trace_response_from_stream_result(
                                "error",
                                err_msg.clone(),
                                &result,
                            ),
                        )
                        .await;
                        return Err(Self::exhausted_response_error(
                            err_msg,
                            max_attempts,
                            pool_attempt.is_some(),
                        ));
                    }

                    if no_effective_output {
                        let err_msg = result
                            .partial_recovery_reason
                            .clone()
                            .unwrap_or_else(|| "No effective output received".to_string());
                        if local_attempt_index < max_attempts - 1 {
                            self.record_retry_diagnostic(
                                &context,
                                &round_id,
                                attempt_id.clone(),
                                attempt_number,
                                "no_effective_output",
                                Some(err_msg.clone()),
                                &result.tool_calls,
                            )
                            .await;
                            Self::complete_model_exchange_trace(
                                trace_config.as_ref(),
                                trace_handle.as_ref(),
                                Self::error_trace_response_from_stream_result(
                                    "error",
                                    err_msg.clone(),
                                    &result,
                                ),
                            )
                            .await;
                            let delay_ms =
                                Self::retry_delay_ms_for_error(local_attempt_index, &err_msg);
                            warn!(
                                "Retrying stream because no effective output was received: session_id={}, round_id={}, round_attempt={}, local_retry={}/{}, delay_ms={}, error={}",
                                context.session_id,
                                round_id,
                                attempt_number,
                                local_attempt_index + 1,
                                max_attempts,
                                delay_ms,
                                err_msg
                            );
                            Self::sleep_with_cancellation(delay_ms, &cancel_token).await?;
                            local_attempt_index += 1;
                            continue;
                        }

                        Self::complete_model_exchange_trace(
                            trace_config.as_ref(),
                            trace_handle.as_ref(),
                            Self::error_trace_response_from_stream_result(
                                "error",
                                err_msg.clone(),
                                &result,
                            ),
                        )
                        .await;
                        return Err(Self::exhausted_response_error(
                            err_msg,
                            max_attempts,
                            pool_attempt.is_some(),
                        ));
                    }

                    if is_partial_recovery {
                        warn!(
                            "Accepting useful partial stream output after retry budget was exhausted: session_id={}, round_id={}, round_attempt={}, local_retry={}/{}, reason={}",
                            context.session_id,
                            round_id,
                            attempt_number,
                            local_attempt_index + 1,
                            max_attempts,
                            result
                                .partial_recovery_reason
                                .as_deref()
                                .unwrap_or("unknown")
                        );
                    }

                    break (
                        result,
                        send_to_stream_ms,
                        stream_processing_ms,
                        ttft_ms,
                        trace_handle,
                    );
                }
                Err(stream_err) => {
                    lifecycle.observe_output(stream_err.has_effective_output);
                    usage_context.response_model = stream_err.response_model.clone();
                    self.record_attempt_usage(&context, &usage_context, stream_err.usage.as_ref(), if matches!(&stream_err.error, OpenBitFunError::Cancelled(_)) { openbitfun_services_core::token_usage::types::ModelRequestOutcome::Cancelled } else { openbitfun_services_core::token_usage::types::ModelRequestOutcome::Failed }, context_window, is_subagent).await;
                    if matches!(&stream_err.error, OpenBitFunError::Cancelled(_)) {
                        Self::complete_model_exchange_trace(
                            trace_config.as_ref(),
                            trace_handle.as_ref(),
                            Self::error_trace_response("cancelled", stream_err.error.to_string()),
                        )
                        .await;
                        return Err(Self::explain_replay_account_boundary(
                            stream_err.error,
                            ordered,
                            replay_origin.is_some() && !routed,
                            channels.is_some() && has_opaque_replay && !routed,
                        ));
                    }
                    let err_msg = stream_err.error.to_string();
                    let stream_error_category = stream_err.error.error_category();
                    let retryable = Self::should_retry_provider_error(&stream_error_category);
                    let provider_error = match &stream_err.error {
                        OpenBitFunError::AIProvider(error)
                        | OpenBitFunError::RecoverableContextOverflow(error) => Some(error),
                        _ => None,
                    };
                    Self::complete_model_exchange_trace(
                        trace_config.as_ref(),
                        trace_handle.as_ref(),
                        Self::error_trace_response("error", err_msg.clone()),
                    )
                    .await;
                    let prefer_alternative = Self::prefer_pool_alternative(
                        &stream_error_category,
                        lifecycle,
                        pool_attempt,
                    );
                    if let Some((next, diagnostic)) = Self::candidate_after_failure(
                        FailedModelAttempt {
                            context: &context,
                            source,
                            origin: selected_origin.as_ref(),
                            credential_revision: selected_credential_revision,
                            client: ai_client.as_ref(),
                            replay_origin: replay_origin.as_ref().filter(|_| !routed),
                            category: &stream_error_category,
                            retry_after_ms: provider_error.and_then(|error| error.retry_after_ms),
                            fallback_delay_ms: Self::retry_delay_ms_for_provider_error(
                                local_attempt_index,
                                &err_msg,
                                provider_error,
                            ),
                            effective_output: lifecycle.observed_effective_output,
                            nonportable_history: has_opaque_replay && !routed,
                            remaining_attempts: max_attempts
                                .saturating_sub(local_attempt_index + 1),
                        },
                        &mut authentication_recovery_attempted,
                        &mut excluded_accounts,
                        &mut excluded_channels,
                        &cancel_token,
                    )
                    .await?
                    {
                        self.record_retry_diagnostic(
                            &context,
                            &round_id,
                            attempt_id.clone(),
                            attempt_number,
                            diagnostic,
                            Some(err_msg.clone()),
                            &[],
                        )
                        .await;
                        if context.model_config_id != next.model_id {
                            excluded_accounts.clear();
                        }
                        if diagnostic != "authentication_recovery" && has_opaque_replay {
                            // Another credential cannot verify this signed
                            // state; the session keeps the original record.
                            ai_messages = crate::infrastructure::ai::channel_client_source::ChannelClientSource::portable_history(&ai_messages);
                            replay_origin = None;
                            has_opaque_replay = false;
                        }
                        context.model_config_id = next.model_id;
                        context.effective_model_name = next.client.config.model.clone();
                        ai_client = next.client;
                        account_source = next.account_source;
                        selected_origin = next.origin;
                        selected_credential_revision = next.credential_revision;
                        trace_config =
                            prepare_model_exchange_trace(&context, &round_id, ai_client.as_ref())
                                .await;
                        local_attempt_index += 1;
                        retry_reason = Some(stream_error_category.clone());
                        continue;
                    }
                    if retryable && !prefer_alternative && local_attempt_index < max_attempts - 1 {
                        self.record_retry_diagnostic(
                            &context,
                            &round_id,
                            attempt_id.clone(),
                            attempt_number,
                            "stream_error",
                            Some(err_msg.clone()),
                            &[],
                        )
                        .await;
                        let delay_ms = Self::retry_delay_ms_for_provider_error(
                            local_attempt_index,
                            &err_msg,
                            provider_error,
                        );
                        warn!(
                            "Retrying stream after error: session_id={}, round_id={}, round_attempt={}, local_retry={}/{}, delay_ms={}, effective_output={}, category={:?}, error={}",
                            context.session_id,
                            round_id,
                            attempt_number,
                            local_attempt_index + 1,
                            max_attempts,
                            delay_ms,
                            stream_err.has_effective_output,
                            stream_error_category,
                            err_msg
                        );
                        Self::sleep_with_cancellation(delay_ms, &cancel_token).await?;
                        local_attempt_index += 1;
                        retry_reason = Some(stream_error_category.clone());
                        continue;
                    }
                    warn!(
                        "Stream stopped: session_id={}, round_id={}, attempts={}, reason={}, effective_output={}, category={:?}, error={}",
                        context.session_id,
                        round_id,
                        lifecycle.attempts_started(),
                        if prefer_alternative { "model_pool_alternative" } else if retryable { "retry_budget_exhausted" } else { "non_retryable_error" },
                        stream_err.has_effective_output,
                        stream_error_category,
                        err_msg
                    );
                    if stream_error_category == ErrorCategory::ContextOverflow {
                        let provider_error = match stream_err.error {
                            OpenBitFunError::AIProvider(error)
                            | OpenBitFunError::RecoverableContextOverflow(error) => error,
                            _ => {
                                AiProviderError::classified(err_msg, ErrorCategory::ContextOverflow)
                            }
                        };
                        return Err(OpenBitFunError::RecoverableContextOverflow(provider_error));
                    }
                    return Err(Self::explain_replay_account_boundary(
                        stream_err.error,
                        ordered,
                        replay_origin.is_some() && !routed,
                        channels.is_some() && has_opaque_replay && !routed,
                    ));
                }
            }
        };

        if stream_result.partial_recovery_reason.is_none() && !cancel_token.is_cancelled() {
            if let (Some(origin), Some(revision), Some(source)) = (
                &selected_origin,
                selected_credential_revision,
                account_source.as_ref(),
            ) {
                tokio::select! {
                    _ = cancel_token.cancelled() => {},
                    result = source.completed(origin,revision,cache_lineage) => if let Err(error) = result {
                        warn!("Failed to persist subscription account affinity: {error}");
                    },
                }
            }
            if let Some(channels) = &channels {
                channels
                    .completed(&context.model_config_id, lineage.as_deref())
                    .await;
            }
        }

        Self::complete_model_exchange_trace(
            trace_config.as_ref(),
            final_trace_handle.as_ref(),
            Self::final_trace_response(&stream_result),
        )
        .await;

        // Accepted output and all following tool side effects are outside the
        // member retry/failover boundary.
        lifecycle.safe_to_switch_model = false;
        if let Some(attempt) = pool_attempt {
            let binding = attempt.accept().await?;
            if let Some(manager) = session_manager {
                // The response is already accepted. Persistence failure must not
                // replay it (and must not duplicate tool execution).
                if let Err(error) = manager
                    .remember_model_pool_binding(
                        &context.session_id,
                        attempt.selection_revision,
                        binding,
                    )
                    .await
                {
                    warn!(
                        "Model pool binding persistence failed: session_id={}, error={error}",
                        context.session_id
                    );
                }
            }
        }

        // Model returned successfully (output to AI log file)
        if let Some(ref reason) = stream_result.partial_recovery_reason {
            warn!(
                "Stream recovered with partial output: session_id={}, round_id={}, reason={}, text_len={}, tool_calls={}",
                context.session_id,
                round_id,
                reason,
                stream_result.full_text.len(),
                stream_result.tool_calls.len()
            );
        }

        let tool_names: Vec<&str> = stream_result
            .tool_calls
            .iter()
            .map(|tc| tc.tool_name.as_str())
            .collect();
        debug!(
            target: "ai::model_response",
            "Model response received: text_length={}, tool_calls={}, token_usage={:?}, send_to_stream_ms={}, stream_processing_ms={}, first_chunk_ms={:?}, first_visible_output_ms={:?}",
            stream_result.full_text.len(),
            if tool_names.is_empty() { "none".to_string() } else { tool_names.join(", ") },
            stream_result.usage.as_ref().map(|u| format!("input={}, output={}, total={}", u.prompt_token_count, u.candidates_token_count, u.total_token_count)).unwrap_or_else(|| "none".to_string()),
            send_to_stream_ms,
            stream_processing_ms,
            stream_result.first_chunk_ms,
            stream_result.first_visible_output_ms
        );

        // Attempts, including partial responses, have already been recorded.
        // The final response must not emit the same usage a second time.

        // Check cancellation token again after stream processing completes.
        if cancel_token.is_cancelled() {
            debug!(
                "Cancel token detected after stream processing, stopping execution: session_id={}",
                context.session_id
            );
            return Err(OpenBitFunError::Cancelled(
                "Execution cancelled".to_string(),
            ));
        }

        // Emit model round completed event
        debug!(
            "Preparing to send ModelRoundCompleted event: round={}, has_tools={}",
            round_id,
            !stream_result.tool_calls.is_empty()
        );

        self.emit_event(
            AgenticEvent::ModelRoundCompleted {
                session_id: context.session_id.clone(),
                turn_id: context.dialog_turn_id.clone(),
                round_id: round_id.clone(),
                has_tool_calls: !stream_result.tool_calls.is_empty(),
                duration_ms: Some(elapsed_ms_u64(round_started_at)),
                provider_id: None,
                model_config_id: context.model_config_id.clone(),
                effective_model_name: context.effective_model_name.clone(),
                first_chunk_ms: stream_result.first_chunk_ms,
                first_visible_output_ms: stream_result.first_visible_output_ms,
                stream_duration_ms: Some(stream_processing_ms),
                ttft_ms,
                attempt_count: Some(lifecycle.attempts_started()),
                failure_category: None,
                token_details: stream_result
                    .usage
                    .as_ref()
                    .and_then(token_details_from_usage),
            },
            EventPriority::High,
        )
        .await;

        debug!("ModelRoundCompleted event sent");

        // If no tool calls, this round ends
        if stream_result.tool_calls.is_empty() {
            debug!("No tool calls, round completed: round={}", round_id);

            // Create assistant message (includes thinking content, supports interleaved thinking mode)
            let reasoning = if stream_result.full_thinking.is_empty() {
                if stream_result.reasoning_content_present {
                    Some(String::new())
                } else {
                    None
                }
            } else {
                Some(stream_result.full_thinking.clone())
            };
            let parsed_memory_citation =
                Self::parsed_memory_citation_from_stream_result(&stream_result);
            let model_response_replay = Self::model_response_replay(
                &stream_result,
                selected_origin.as_ref(),
                &context.model_config_id,
                &ai_client.config.format,
                ai_client.channel_replay_fingerprint(),
            );
            let (clean_text, _) = strip_openbitfun_memory_citations(&stream_result.full_text);
            let assistant_message =
                Message::assistant_with_reasoning(reasoning, clean_text, vec![])
                    .with_turn_id(context.dialog_turn_id.clone())
                    .with_round_id(round_id.clone())
                    .with_thinking_signature(stream_result.thinking_signature.clone())
                    .with_reasoning_content_kind(stream_result.reasoning_content_kind)
                    .with_memory_citation(parsed_memory_citation)
                    .with_model_response_replay(model_response_replay)
                    .with_model_pool_replay_fingerprint(pool_attempt.map(|attempt| {
                        attempt
                            .reservation
                            .binding
                            .configuration_fingerprint
                            .clone()
                    }));

            debug!("Returning RoundResult: has_more_rounds=false");
            debug!(
                "Model round timing summary: session_id={}, turn_id={}, round_id={}, tool_calls=0, send_to_stream_ms={}, stream_processing_ms={}, first_chunk_ms={:?}, first_visible_output_ms={:?}, tool_phase_ms=0, round_total_ms={}, has_more_rounds=false",
                context.session_id,
                context.dialog_turn_id,
                round_id,
                send_to_stream_ms,
                stream_processing_ms,
                stream_result.first_chunk_ms,
                stream_result.first_visible_output_ms,
                elapsed_ms_u64(round_started_at)
            );

            // Note: Do not cleanup cancellation token here, as this is only the end of a single model round
            // Cancellation token will be cleaned up by ExecutionEngine when the entire dialog turn ends

            return Ok(RoundResult {
                assistant_message,
                assistant_message_committed: false,
                tool_calls: vec![],
                tool_result_messages: vec![],
                has_more_rounds: false,
                finish_reason: FinishReason::Complete,
                usage: stream_result.usage.clone(),
                provider_metadata: stream_result.provider_metadata.clone(),
                partial_recovery_reason: stream_result.partial_recovery_reason.clone(),
                had_assistant_text: Self::has_user_visible_assistant_text(&stream_result.full_text),
                had_thinking_content: !stream_result.full_thinking.is_empty(),
            });
        }

        let mut tool_calls = stream_result.tool_calls.clone();
        normalize_deferred_tool_calls_for_replay(&mut tool_calls);

        // Create assistant message (includes tool calls and thinking content, supports interleaved thinking mode)
        let reasoning = if stream_result.full_thinking.is_empty() {
            if stream_result.reasoning_content_present {
                Some(String::new())
            } else {
                None
            }
        } else {
            Some(stream_result.full_thinking.clone())
        };
        let parsed_memory_citation =
            Self::parsed_memory_citation_from_stream_result(&stream_result);
        let model_response_replay = Self::model_response_replay(
            &stream_result,
            selected_origin.as_ref(),
            &context.model_config_id,
            &ai_client.config.format,
            ai_client.channel_replay_fingerprint(),
        );
        let (clean_text, _) = strip_openbitfun_memory_citations(&stream_result.full_text);
        let assistant_message =
            Message::assistant_with_reasoning(reasoning, clean_text, tool_calls.clone())
                .with_turn_id(context.dialog_turn_id.clone())
                .with_round_id(round_id.clone())
                .with_thinking_signature(stream_result.thinking_signature.clone())
                .with_reasoning_content_kind(stream_result.reasoning_content_kind)
                .with_memory_citation(parsed_memory_citation)
                .with_model_response_replay(model_response_replay)
                .with_model_pool_replay_fingerprint(pool_attempt.map(|attempt| {
                    attempt
                        .reservation
                        .binding
                        .configuration_fingerprint
                        .clone()
                }));

        // Publish the semantic assistant response before tool execution so
        // readers can observe the active tool call while it is running. Fork
        // snapshots normalize this intentionally incomplete exchange before
        // sending it to a provider.
        let assistant_message_committed = if let Some(session_manager) = session_manager {
            session_manager
                .add_message(&context.session_id, assistant_message.clone())
                .await?;
            true
        } else {
            false
        };

        // Check cancellation token before executing tools
        if cancel_token.is_cancelled() {
            debug!(
                "Cancel token detected before tool execution, stopping execution: session_id={}",
                context.session_id
            );
            return Err(OpenBitFunError::Cancelled(
                "Execution cancelled".to_string(),
            ));
        }

        // Execute tool calls
        debug!(
            "Preparing to execute tool calls: count={}",
            tool_calls.len()
        );

        let tool_phase_started_at = Instant::now();
        let mut ptc_loaded_deferred_tool_specs_by_tool_id = HashMap::new();
        let tool_results = if let Some(tool_pipeline) = &self.tool_pipeline {
            // Create tool execution context
            let allowed_tools = context.available_tools.clone();
            let permission_delegation = context.permission_delegation.clone().or_else(|| {
                subagent_parent_info
                    .as_ref()
                    .map(|parent| parent.permission_delegation_context(&context.agent_type))
            });
            let tool_context = ToolExecutionContext {
                session_id: context.session_id.clone(),
                dialog_turn_id: context.dialog_turn_id.clone(),
                round_id: round_id.clone(),
                attempt_id: Some(format!(
                    "{round_id}:attempt:{}",
                    lifecycle.attempts_started()
                )),
                attempt_index: Some(lifecycle.attempts_started()),
                agent_type: context.agent_type.clone(),
                workspace: context.workspace.clone(),
                primary_model_facts: context.primary_model_facts.clone(),
                context_vars: context.context_vars.clone(),
                subagent_parent_info,
                permission_delegation,
                delegation_policy: context.delegation_policy,
                deferred_tools: context.deferred_tools.clone(),
                loaded_deferred_tool_specs: context.loaded_deferred_tool_specs.clone(),
                allowed_tools,
                runtime_tool_restrictions: context.runtime_tool_restrictions.clone(),
                steering_interrupt: context.steering_interrupt.clone(),
                workspace_services: context.workspace_services.clone(),
                terminal_port: context.terminal_port.clone(),
                remote_exec_port: context.remote_exec_port.clone(),
            };

            // Use the round-start configuration so stream repair and tool
            // execution policy stay stable throughout this model round.
            let tool_execution_timeout = global_config.ai.tool_execution_timeout_secs;
            let subagent_batch_execution_policy = Self::map_subagent_batch_execution_policy(
                global_config.ai.subagent_batch_execution_policy,
            );
            let permission_mode =
                Self::resolve_permission_mode(&global_config, &context.context_vars);
            let auto_approve_ask = permission_mode.auto_approve_ask();

            let project_rules = match context.workspace.as_ref() {
                Some(workspace) if workspace.is_remote() => {
                    match context.workspace_services.as_ref() {
                        Some(services) => {
                            load_project_permission_config_remote(
                                services.fs.as_ref(),
                                &workspace.root_path_string(),
                            )
                            .await?
                            .rules
                        }
                        None => Vec::new(),
                    }
                }
                Some(workspace) => {
                    load_project_permission_config_local(workspace.root_path())
                        .await?
                        .rules
                }
                None => Vec::new(),
            };

            let agent_profile_id =
                crate::agentic::agents::resolve_mode_config_profile_id(&context.agent_type);
            let agent_profile = global_config
                .ai
                .agent_profiles
                .get(agent_profile_id.as_ref());
            let permission_policy = Self::resolve_permission_policy(
                &global_config,
                permission_mode,
                &project_rules,
                agent_profile,
                &context.permission_constraints,
                context.permission_runtime_ceiling.as_ref(),
            );

            // Create tool execution options (use configured timeout values)
            let tool_options = ToolExecutionOptions {
                timeout_secs: tool_execution_timeout,
                subagent_batch_execution_policy,
                permission_policy,
                auto_approve_ask,
                ..ToolExecutionOptions::default()
            };

            let storage_context =
                tool_context_runtime::build_tool_use_context_for_execution_context(
                    &tool_context,
                    Some(format!("round-budget-{}", round_id)),
                    self.computer_use_host(),
                    CancellationToken::new(),
                    None,
                );

            // Execute tools — convert pipeline-level Err into per-tool error results
            // so the model always receives a tool_result for every tool_call.
            let execution_results = match tool_pipeline
                .execute_tools(tool_calls.clone(), tool_context, tool_options)
                .await
            {
                Ok(results) => results,
                Err(e) => {
                    error!(
                        "Tool pipeline execution failed, generating error results for all {} tool calls: {}",
                        tool_calls.len(),
                        e
                    );
                    tool_calls
                        .iter()
                        .map(|tc| crate::agentic::tools::pipeline::ToolExecutionResult {
                            tool_id: tc.tool_id.clone(),
                            tool_name: tc.tool_name.clone(),
                            effective_tool_name: tc.tool_name.clone(),
                            result: crate::agentic::core::ToolResult {
                                tool_id: tc.tool_id.clone(),
                                tool_name: tc.tool_name.clone(),
                                effective_tool_name: None,
                                result: serde_json::json!({
                                    "error": e.to_string(),
                                    "message": format!("Tool pipeline execution failed: {}", e)
                                }),
                                result_for_assistant: Some(format!("Tool execution failed: {}", e)),
                                is_error: true,
                                duration_ms: None,
                                image_attachments: None,
                            },
                            ptc_loaded_deferred_tool_specs: Vec::new(),
                            execution_time_ms: 0,
                        })
                        .collect()
                }
            };

            // Keep PTC's loaded-definition receipt alongside the model result. It is
            // projected onto the persisted outer RunCode message below, while the
            // assistant-facing result remains unchanged.
            // Convert to ToolResult, then enforce the aggregate budget for this model round.
            let tool_results = execution_results
                .into_iter()
                .map(|mut execution_result| {
                    if !execution_result.ptc_loaded_deferred_tool_specs.is_empty() {
                        ptc_loaded_deferred_tool_specs_by_tool_id.insert(
                            execution_result.tool_id.clone(),
                            execution_result.ptc_loaded_deferred_tool_specs.clone(),
                        );
                    }
                    execution_result.result.effective_tool_name = (execution_result.tool_name
                        != execution_result.effective_tool_name)
                        .then_some(execution_result.effective_tool_name);
                    execution_result.result
                })
                .collect();
            tool_result_storage::apply_round_tool_result_budget(tool_results, &storage_context)
                .await
        } else {
            vec![]
        };
        let tool_phase_ms = elapsed_ms_u64(tool_phase_started_at);

        debug!(
            "Tool execution completed, creating message: assistant_msg_len={}, tool_results={}",
            match &assistant_message.content {
                MessageContent::Text(t) => t.len(),
                MessageContent::Mixed { text, .. } => text.len(),
                _ => 0,
            },
            tool_results.len()
        );

        // Create tool result messages (also need to set turn_id and round_id)
        let dialog_turn_id = context.dialog_turn_id.clone();
        let round_id_clone = round_id.clone();
        let tool_result_messages: Vec<Message> = tool_results
            .iter()
            .map(|result| {
                let mut message = Message::tool_result(result.clone())
                    .with_turn_id(dialog_turn_id.clone())
                    .with_round_id(round_id_clone.clone());
                if let Some(loaded_specs) =
                    ptc_loaded_deferred_tool_specs_by_tool_id.get(&result.tool_id)
                {
                    message.metadata.ptc_loaded_deferred_tool_specs = loaded_specs.clone();
                }
                message
            })
            .collect();

        let has_more_rounds = !tool_result_messages.is_empty();

        debug!(
            "Returning RoundResult: has_more_rounds={}, tool_result_messages={}",
            has_more_rounds,
            tool_result_messages.len()
        );
        debug!(
            "Model round timing summary: session_id={}, turn_id={}, round_id={}, tool_calls={}, tool_results={}, send_to_stream_ms={}, stream_processing_ms={}, first_chunk_ms={:?}, first_visible_output_ms={:?}, tool_phase_ms={}, round_total_ms={}, has_more_rounds={}",
            context.session_id,
            context.dialog_turn_id,
            round_id,
            stream_result.tool_calls.len(),
            tool_result_messages.len(),
            send_to_stream_ms,
            stream_processing_ms,
            stream_result.first_chunk_ms,
            stream_result.first_visible_output_ms,
            tool_phase_ms,
            elapsed_ms_u64(round_started_at),
            has_more_rounds
        );

        // Note: Do not cleanup cancellation token here, as there may be subsequent model rounds
        // Cancellation token will be cleaned up by ExecutionEngine when the entire dialog turn ends

        Ok(RoundResult {
            assistant_message,
            assistant_message_committed,
            tool_calls,
            tool_result_messages,
            has_more_rounds,
            finish_reason: if has_more_rounds {
                FinishReason::ToolCalls
            } else {
                FinishReason::Complete
            },
            usage: stream_result.usage.clone(),
            provider_metadata: stream_result.provider_metadata.clone(),
            partial_recovery_reason: stream_result.partial_recovery_reason.clone(),
            had_assistant_text: Self::has_user_visible_assistant_text(&stream_result.full_text),
            had_thinking_content: !stream_result.full_thinking.is_empty(),
        })
    }

    /// Check if dialog turn is still active (used to detect cancellation)
    pub fn has_active_dialog_turn(&self, dialog_turn_id: &str) -> bool {
        self.cancellation_tokens.has_active(dialog_turn_id)
    }

    /// Check if dialog turn cancellation has been requested.
    pub fn is_dialog_turn_cancelled(&self, dialog_turn_id: &str) -> bool {
        self.cancellation_tokens.is_cancelled(dialog_turn_id)
    }

    /// Register cancellation token (for external control, e.g., execute_subagent)
    pub fn register_cancel_token(&self, dialog_turn_id: &str, token: CancellationToken) {
        self.cancellation_tokens.insert(dialog_turn_id, token);
    }

    /// Reuse an early registered token, including its already-cancelled state.
    pub(crate) fn ensure_cancel_token(&self, dialog_turn_id: &str) -> CancellationToken {
        self.cancellation_tokens.get_or_insert_new(dialog_turn_id)
    }

    /// Return a clone of the cancellation token registered for a dialog turn.
    pub fn cancel_token_for_dialog_turn(&self, dialog_turn_id: &str) -> Option<CancellationToken> {
        self.cancellation_tokens.token(dialog_turn_id)
    }

    /// Cancel dialog turn (using dialog_turn_id)
    pub async fn cancel_dialog_turn(&self, dialog_turn_id: &str) -> OpenBitFunResult<()> {
        debug!("Cancelling dialog turn: dialog_turn_id={}", dialog_turn_id);

        if self.cancellation_tokens.cancel(dialog_turn_id) {
            debug!("Found cancel token, triggering cancellation");
            debug!("Cancel token triggered");
        } else {
            debug!("Cancel token not found (dialog may have completed or not started)");
        }

        Ok(())
    }

    /// Cleanup dialog turn token (called on normal completion)
    pub async fn cleanup_dialog_turn(&self, dialog_turn_id: &str) {
        if self.cancellation_tokens.remove(dialog_turn_id) {
            debug!("Cleaned up cancel token: dialog_turn_id={}", dialog_turn_id);
        }
    }

    /// Emit event
    async fn emit_event(&self, event: AgenticEvent, priority: EventPriority) {
        let _ = self.event_queue.enqueue(event, Some(priority)).await;
    }

    async fn emit_token_usage_update(
        &self,
        context: &RoundContext,
        usage: &crate::util::types::ai::GeminiUsage,
        context_window: Option<usize>,
        is_subagent: bool,
        request: Option<&openbitfun_services_core::token_usage::types::ModelRequestUsageContext>,
    ) {
        debug!(
            "Updating token stats from model response: input={}, output={}, total={}, is_subagent={}",
            usage.prompt_token_count,
            usage.candidates_token_count,
            usage.total_token_count,
            is_subagent
        );

        let event = AgenticEvent::TokenUsageUpdated {
            session_id: context.session_id.clone(),
            turn_id: context.dialog_turn_id.clone(),
            model_config_id: context.model_config_id.clone(),
            effective_model_name: request
                .map(|request| request.requested_model.clone())
                .unwrap_or_else(|| context.effective_model_name.clone()),
            input_tokens: usage.prompt_token_count as usize,
            output_tokens: Some(usage.candidates_token_count as usize),
            total_tokens: usage.total_token_count as usize,
            max_context_tokens: context_window,
            is_subagent,
            cached_tokens: usage.cached_content_token_count.map(|v| v as usize),
            token_details: match request {
                Some(request) => {
                    openbitfun_services_core::token_usage::types::with_model_request_context(
                        token_details_from_usage(usage),
                        request,
                    )
                    .ok()
                }
                None => token_details_from_usage(usage),
            },
        };
        crate::agentic::goal_mode::record_thread_goal_token_usage(&event);
        self.emit_event(event, EventPriority::Normal).await;
    }

    async fn record_attempt_usage(
        &self,
        context: &RoundContext,
        request: &openbitfun_services_core::token_usage::types::ModelRequestUsageContext,
        usage: Option<&crate::util::types::ai::GeminiUsage>,
        outcome: openbitfun_services_core::token_usage::types::ModelRequestOutcome,
        context_window: Option<usize>,
        is_subagent: bool,
    ) {
        let mut request = request.clone();
        request.outcome = outcome;
        request.usage_known = usage.is_some();
        if let Some(service) = &self.usage_service {
            let details = openbitfun_services_core::token_usage::types::with_model_request_context(
                usage.and_then(token_details_from_usage),
                &request,
            );
            match details {
                Ok(details) => {
                    let cancel = self
                        .cancel_token_for_dialog_turn(&context.dialog_turn_id)
                        .unwrap_or_else(|| context.cancellation_token.clone());
                    tokio::select! {
                        // Poll the service first so even an already-cancelled
                        // caller submits the owned writer before dropping its wait.
                        biased;
                        result = service.record_usage(
                            context.model_config_id.clone(),
                            request.requested_model.clone(),
                            context.session_id.clone(),
                            context.dialog_turn_id.clone(),
                            usage.map_or(0, |usage| usage.prompt_token_count),
                            usage.map_or(0, |usage| usage.candidates_token_count),
                            usage.and_then(|usage| usage.cached_content_token_count),
                            Some(details),
                            is_subagent,
                        ) => if let Err(error) = result { warn!("Failed to persist model attempt usage: {error}"); },
                        _ = cancel.cancelled() => debug!("Model attempt usage writer continues after cancellation"),
                    }
                }
                Err(error) => warn!("Failed to prepare model attempt usage: {error}"),
            }
        }
        if let Some(usage) = usage {
            self.emit_token_usage_update(
                context,
                usage,
                context_window,
                is_subagent,
                Some(&request),
            )
            .await;
        }
    }

    async fn emit_failed_partial_tool_calls(
        &self,
        context: &RoundContext,
        round_id: &str,
        tool_calls: &[ToolCall],
        error: &str,
    ) {
        for tool_call in tool_calls {
            self.emit_event(
                AgenticEvent::ToolEvent {
                    session_id: context.session_id.clone(),
                    turn_id: context.dialog_turn_id.clone(),
                    round_id: round_id.to_string(),
                    attempt_id: None,
                    attempt_index: None,
                    tool_event: ToolEventData::Failed {
                        identity: openbitfun_events::ToolEventIdentity::direct(
                            tool_call.tool_id.clone(),
                            tool_call.tool_name.clone(),
                        ),
                        error_detail: None,
                        error: format!("Tool arguments stream interrupted: {}", error),
                        duration_ms: None,
                        queue_wait_ms: None,
                        preflight_ms: None,
                        confirmation_wait_ms: None,
                        execution_ms: None,
                    },
                },
                EventPriority::High,
            )
            .await;
        }
    }

    async fn complete_model_exchange_trace(
        trace_config: Option<&ModelExchangeTraceConfig>,
        trace_handle: Option<&ModelExchangeRequestTraceHandle>,
        response: ModelExchangeResponseTrace,
    ) {
        let (Some(trace_config), Some(trace_handle)) = (trace_config, trace_handle) else {
            return;
        };

        trace_config
            .sink
            .request_attempt_completed(trace_handle, &response)
            .await;
    }

    fn final_trace_response(result: &StreamResult) -> ModelExchangeResponseTrace {
        let kind = if result.partial_recovery_reason.is_some() {
            "partial"
        } else {
            "completed"
        };
        Self::trace_response(kind, Some(result), None)
    }

    fn trace_response_from_stream_result(
        kind: &str,
        result: &StreamResult,
    ) -> ModelExchangeResponseTrace {
        Self::trace_response(kind, Some(result), None)
    }

    fn error_trace_response_from_stream_result(
        kind: &str,
        error: String,
        result: &StreamResult,
    ) -> ModelExchangeResponseTrace {
        Self::trace_response(kind, Some(result), Some(error))
    }

    fn error_trace_response(kind: &str, error: String) -> ModelExchangeResponseTrace {
        Self::trace_response(kind, None, Some(error))
    }

    fn trace_response(
        kind: &str,
        result: Option<&StreamResult>,
        error: Option<String>,
    ) -> ModelExchangeResponseTrace {
        let (
            assistant_text,
            thinking,
            tool_calls,
            usage,
            provider_metadata,
            partial_recovery_reason,
        ) = if let Some(result) = result {
            (
                Some(result.full_text.clone()),
                Self::stream_result_reasoning(result),
                serde_json::to_value(&result.tool_calls).ok(),
                result
                    .usage
                    .as_ref()
                    .and_then(|usage| serde_json::to_value(usage).ok()),
                result.provider_metadata.clone(),
                result.partial_recovery_reason.clone(),
            )
        } else {
            (None, None, None, None, None, None)
        };

        ModelExchangeResponseTrace {
            kind: kind.to_string(),
            assistant_text,
            thinking,
            tool_calls,
            usage,
            provider_metadata,
            partial_recovery_reason,
            error,
        }
    }

    fn stream_result_reasoning(result: &StreamResult) -> Option<String> {
        if result.full_thinking.is_empty() {
            result.reasoning_content_present.then(String::new)
        } else {
            Some(result.full_thinking.clone())
        }
    }

    fn has_interrupted_invalid_tool_calls(result: &StreamResult) -> bool {
        result.partial_recovery_reason.is_some()
            && !result.tool_calls.is_empty()
            && result
                .tool_calls
                .iter()
                .any(|tool_call| !tool_call.is_valid())
    }

    fn is_invalid_tool_only_without_text(result: &StreamResult) -> bool {
        result.partial_recovery_reason.is_none()
            && !Self::has_user_visible_assistant_text(&result.full_text)
            && !result.tool_calls.is_empty()
            && result
                .tool_calls
                .iter()
                .all(|tool_call| !tool_call.is_valid())
    }

    fn retry_delay_ms(attempt_index: usize) -> u64 {
        Self::retry_delay_ms_for_error(attempt_index, "")
    }

    fn retry_delay_ms_for_error(attempt_index: usize, error_message: &str) -> u64 {
        Self::retry_delay_ms_for_provider_error(attempt_index, error_message, None)
    }

    fn retry_delay_ms_for_provider_error(
        attempt_index: usize,
        error_message: &str,
        provider_error: Option<&AiProviderError>,
    ) -> u64 {
        openbitfun_agent_stream::retry::delay_ms(attempt_index, error_message, provider_error)
    }
}

fn token_details_from_usage(
    usage: &crate::util::types::ai::GeminiUsage,
) -> Option<serde_json::Value> {
    let mut details = serde_json::Map::new();
    if let Some(reasoning_tokens) = usage.reasoning_token_count {
        details.insert(
            "reasoningTokenCount".to_string(),
            serde_json::json!(reasoning_tokens),
        );
    }
    if let Some(cached_tokens) = usage.cached_content_token_count {
        details.insert(
            "cachedContentTokenCount".to_string(),
            serde_json::json!(cached_tokens),
        );
    }
    // Cache writes (Anthropic only at the moment). Disjoint from reads.
    if let Some(creation_tokens) = usage.cache_creation_token_count {
        details.insert(
            "cacheCreationTokenCount".to_string(),
            serde_json::json!(creation_tokens),
        );
    }

    (!details.is_empty()).then_some(serde_json::Value::Object(details))
}

#[cfg(test)]
pub(super) mod tests {
    use super::{
        normalize_deferred_tool_calls_for_replay, ModelRoundLifecycle, RoundExecutor,
        StreamProcessor,
    };
    use crate::agentic::core::ToolCall;
    use crate::agentic::events::{AgenticEvent, EventQueue, EventQueueConfig};
    use crate::agentic::execution::stream_processor::StreamResult;
    use crate::agentic::execution::types::RoundContext;
    use crate::agentic::tools::ToolRuntimeRestrictions;
    use crate::service::config::types::{AgentProfileConfig, GlobalConfig};
    use crate::util::errors::OpenBitFunError;
    use crate::util::types::ai::GeminiUsage;
    use openbitfun_agent_runtime::permission::{
        AUTO_APPROVE_ASK_CONTEXT_KEY, PERMISSION_MODE_CONTEXT_KEY,
    };
    use openbitfun_agent_runtime::turn_cancellation::DialogTurnCancellationTokenStore;
    use openbitfun_core_types::errors::{AiProviderError, ErrorCategory};
    use openbitfun_runtime_ports::{
        DelegationPolicy, PermissionEffect, PermissionEvaluator, PermissionPolicyPreset,
        PermissionRule,
    };
    use serde_json::json;
    use std::collections::HashMap;
    use std::sync::Arc;
    use std::time::Duration;
    use tokio_util::sync::CancellationToken;

    pub(in crate::agentic::execution) fn test_round_executor() -> RoundExecutor {
        let event_queue = Arc::new(EventQueue::new(EventQueueConfig::default()));
        RoundExecutor {
            stream_processor: Arc::new(StreamProcessor::new(event_queue.clone())),
            tool_pipeline: None,
            event_queue,
            cancellation_tokens: DialogTurnCancellationTokenStore::new(),
            usage_service: None,
        }
    }

    #[test]
    fn model_round_lifecycle_reuses_identity_and_counts_recovery_attempts() {
        let mut lifecycle = ModelRoundLifecycle::new();
        let round_id = lifecycle.round_id.clone();

        assert!(lifecycle.take_started_event());
        assert!(!lifecycle.take_started_event());
        assert_eq!(lifecycle.begin_attempt(), 1);
        assert_eq!(lifecycle.begin_attempt(), 2);
        assert_eq!(lifecycle.attempts_started(), 2);
        assert_eq!(lifecycle.round_id, round_id);
    }

    #[test]
    fn pool_failover_rejects_cancellation_and_local_errors_before_output() {
        let mut lifecycle = ModelRoundLifecycle::new();
        lifecycle.safe_to_switch_model = true;
        for error in [
            OpenBitFunError::Cancelled("cancelled during retry backoff".into()),
            OpenBitFunError::service("runtime unavailable"),
            OpenBitFunError::validation("invalid runtime request"),
            OpenBitFunError::RecoverableContextOverflow(AiProviderError::classified(
                "needs compression".into(),
                ErrorCategory::ContextOverflow,
            )),
        ] {
            assert!(!lifecycle.allows_pool_failover(&error), "{error}");
        }
        let error = OpenBitFunError::AIProvider(AiProviderError::classified(
            "response recovery exhausted".into(),
            ErrorCategory::Unknown,
        ));
        assert!(lifecycle.allows_pool_failover(&error));
        lifecycle.observe_output(true);
        assert!(!lifecycle.allows_pool_failover(&error));
    }

    #[test]
    fn deferred_tool_replay_uses_canonical_gateway_arguments() {
        let mut tool_calls = vec![ToolCall {
            tool_id: "call-1".to_string(),
            tool_name: openbitfun_agent_tools::CALL_DEFERRED_TOOL_NAME.to_string(),
            arguments: json!({
                "tool_name": "CreatePlan",
                "overview": "outside",
                "args": {
                    "overview": "inside",
                    "plan": "# Plan"
                }
            }),
            raw_arguments: Some(
                r##"{"tool_name":"CreatePlan","overview":"outside","args":{"overview":"inside","plan":"# Plan"}}"##
                    .to_string(),
            ),
            is_error: false,
            parse_error: None,
            recovered_from_truncation: false,
            repair_kind: Default::default(),
        }];

        normalize_deferred_tool_calls_for_replay(&mut tool_calls);

        assert_eq!(
            tool_calls[0].arguments,
            json!({
                "tool_name": "CreatePlan",
                "args": {
                    "overview": "inside",
                    "plan": "# Plan"
                }
            })
        );
        assert_eq!(
            tool_calls[0].raw_arguments.as_deref(),
            Some(r##"{"tool_name":"CreatePlan","args":{"overview":"inside","plan":"# Plan"}}"##)
        );
    }

    #[tokio::test]
    async fn context_overflow_recovery_supersedes_the_current_attempt() {
        let executor = test_round_executor();
        let mut lifecycle = ModelRoundLifecycle::new();
        let round_id = lifecycle.round_id.clone();
        assert_eq!(lifecycle.begin_attempt(), 1);

        executor
            .record_context_overflow_recovery(
                "session-1",
                "turn-1",
                &lifecycle,
                "request exceeds context window".to_string(),
            )
            .await;

        let events = executor.event_queue.dequeue_batch(10).await;
        assert_eq!(events.len(), 1);
        match &events[0].event {
            AgenticEvent::ModelRoundAttemptSuperseded {
                session_id,
                turn_id,
                round_id: event_round_id,
                diagnostic,
            } => {
                assert_eq!(session_id, "session-1");
                assert_eq!(turn_id, "turn-1");
                assert_eq!(event_round_id, &round_id);
                assert_eq!(diagnostic.attempt_id, format!("{round_id}:attempt:1"));
                assert_eq!(diagnostic.attempt_index, 1);
                assert_eq!(diagnostic.category, "context_overflow");
            }
            event => panic!("unexpected event: {event:?}"),
        }
    }

    fn test_round_context() -> RoundContext {
        RoundContext {
            session_id: "session-1".to_string(),
            subagent_parent_info: None,
            permission_delegation: None,
            dialog_turn_id: "turn-1".to_string(),
            turn_index: 0,
            round_number: 0,
            round_group_id: None,
            workspace: None,
            model_exchange_trace_dir: None,
            available_tools: Vec::new(),
            deferred_tools: Vec::new(),
            loaded_deferred_tool_specs: Vec::new(),
            model_config_id: "model-1".to_string(),
            effective_model_name: "model-1".to_string(),
            model_request_context: Default::default(),
            account_client_source: None,
            channel_client_source: None,
            prepared_model: None,
            primary_model_facts: tool_runtime::context::PrimaryModelFacts::new(
                "model-1", "model-1", "openai", true,
            ),
            agent_type: "Standard".to_string(),
            context_vars: HashMap::new(),
            permission_constraints: Default::default(),
            permission_runtime_ceiling: None,
            delegation_policy: DelegationPolicy::top_level(),
            runtime_tool_restrictions: ToolRuntimeRestrictions::default(),
            steering_interrupt: None,
            cancellation_token: CancellationToken::new(),
            workspace_services: None,
            terminal_port: None,
            remote_exec_port: None,
            recover_partial_on_cancel: false,
        }
    }

    pub(in crate::agentic::execution) struct RetryTestServer {
        url: String,
        pub(in crate::agentic::execution) requests: Arc<std::sync::Mutex<Vec<serde_json::Value>>>,
        headers: Arc<std::sync::Mutex<Vec<HashMap<String, String>>>>,
        disconnected: Arc<std::sync::atomic::AtomicUsize>,
        opened_streams: Arc<std::sync::atomic::AtomicUsize>,
        stop: Arc<std::sync::atomic::AtomicBool>,
        thread: Option<std::thread::JoinHandle<()>>,
    }

    impl RetryTestServer {
        pub(in crate::agentic::execution) fn new(replies: Vec<(u16, String)>) -> Self {
            Self::with_open_stream(replies, false)
        }

        fn with_open_stream(replies: Vec<(u16, String)>, keep_open: bool) -> Self {
            Self::with_options(replies, keep_open, None)
        }

        fn with_retry_after(replies: Vec<(u16, String)>, seconds: u64) -> Self {
            Self::with_options(replies, false, Some(seconds))
        }

        fn with_options(
            replies: Vec<(u16, String)>,
            keep_open: bool,
            retry_after: Option<u64>,
        ) -> Self {
            Self::with_timing_options(replies, keep_open, retry_after, None)
        }

        fn with_timing_options(
            replies: Vec<(u16, String)>,
            keep_open: bool,
            retry_after: Option<u64>,
            timing_delays: Option<(Duration, Duration)>,
        ) -> Self {
            use std::io::{BufRead, Read, Write};
            use std::sync::atomic::{AtomicBool, Ordering};

            let listener = std::net::TcpListener::bind("127.0.0.1:0").unwrap();
            listener.set_nonblocking(true).unwrap();
            let url = format!(
                "http://{}/v1/chat/completions",
                listener.local_addr().unwrap()
            );
            let requests = Arc::new(std::sync::Mutex::new(Vec::new()));
            let captured = requests.clone();
            let headers = Arc::new(std::sync::Mutex::new(Vec::new()));
            let captured_headers = headers.clone();
            let disconnected = Arc::new(std::sync::atomic::AtomicUsize::new(0));
            let closed = disconnected.clone();
            let opened_streams = Arc::new(std::sync::atomic::AtomicUsize::new(0));
            let opened = opened_streams.clone();
            let stop = Arc::new(AtomicBool::new(false));
            let stopped = stop.clone();
            assert!(!replies.is_empty());
            let thread = std::thread::spawn(move || {
                while !stopped.load(Ordering::Relaxed) {
                    let mut socket = match listener.accept() {
                        Ok((socket, _)) => socket,
                        Err(error) if error.kind() == std::io::ErrorKind::WouldBlock => {
                            std::thread::sleep(Duration::from_millis(5));
                            continue;
                        }
                        Err(error) => panic!("accept retry fixture request: {error}"),
                    };
                    socket.set_nonblocking(false).unwrap();
                    socket
                        .set_read_timeout(Some(Duration::from_secs(5)))
                        .unwrap();
                    socket
                        .set_write_timeout(Some(Duration::from_secs(5)))
                        .unwrap();
                    let mut reader = std::io::BufReader::new(&mut socket);
                    let mut content_length = 0;
                    let mut request_headers = HashMap::new();
                    loop {
                        let mut line = String::new();
                        assert!(reader.read_line(&mut line).unwrap() > 0);
                        if line == "\r\n" {
                            break;
                        }
                        if let Some((name, value)) = line.split_once(':') {
                            request_headers
                                .insert(name.to_ascii_lowercase(), value.trim().to_string());
                            if name.eq_ignore_ascii_case("content-length") {
                                content_length = value.trim().parse::<usize>().unwrap();
                            }
                        }
                    }
                    let mut body = vec![0; content_length];
                    reader.read_exact(&mut body).unwrap();
                    let mut requests = captured.lock().unwrap();
                    let index = requests.len().min(replies.len() - 1);
                    requests.push(serde_json::from_slice(&body).unwrap());
                    captured_headers.lock().unwrap().push(request_headers);
                    drop(requests);
                    let (status, body) = &replies[index];
                    let content_type = if *status == 200 {
                        "text/event-stream"
                    } else {
                        "application/json"
                    };
                    let retry_header = retry_after
                        .map(|seconds| format!("Retry-After: {seconds}\r\n"))
                        .unwrap_or_default();
                    if let Some((before_headers, _)) = timing_delays {
                        std::thread::sleep(before_headers);
                    }
                    write!(socket, "HTTP/1.1 {status} Fixture\r\nContent-Type: {content_type}\r\nContent-Length: {}\r\n{retry_header}Connection: close\r\n\r\n", body.len() + usize::from(keep_open)).unwrap();
                    socket.flush().unwrap();
                    if let Some((_, between_events)) = timing_delays {
                        for event in body.split_inclusive("\n\n") {
                            socket.write_all(event.as_bytes()).unwrap();
                            socket.flush().unwrap();
                            std::thread::sleep(between_events);
                        }
                    } else {
                        socket.write_all(body.as_bytes()).unwrap();
                        socket.flush().unwrap();
                    }
                    if keep_open {
                        socket.set_nonblocking(true).unwrap();
                        opened.fetch_add(1, Ordering::SeqCst);
                    }
                    while keep_open && !stopped.load(Ordering::Relaxed) {
                        match socket.peek(&mut [0; 1]) {
                            Ok(0) => {
                                closed.fetch_add(1, Ordering::SeqCst);
                                break;
                            }
                            Err(error)
                                if matches!(
                                    error.kind(),
                                    std::io::ErrorKind::ConnectionReset
                                        | std::io::ErrorKind::ConnectionAborted
                                ) =>
                            {
                                closed.fetch_add(1, Ordering::SeqCst);
                                break;
                            }
                            Err(error) if error.kind() != std::io::ErrorKind::WouldBlock => {
                                panic!("observe fixture stream disconnect: {error}");
                            }
                            _ => {}
                        }
                        std::thread::sleep(Duration::from_millis(5));
                    }
                }
            });
            Self {
                url,
                requests,
                headers,
                disconnected,
                opened_streams,
                stop,
                thread: Some(thread),
            }
        }

        pub(in crate::agentic::execution) fn client(
            &self,
        ) -> Arc<crate::infrastructure::ai::AIClient> {
            Arc::new(crate::infrastructure::ai::AIClient::new(
                openbitfun_core_types::AIConfig {
                    name: "retry-test".to_string(),
                    base_url: self.url.clone(),
                    request_url: self.url.clone(),
                    api_key: "retry-test-key".to_string(),
                    model: "retry-test-model".to_string(),
                    format: "openai".to_string(),
                    context_window: 4096,
                    max_tokens: Some(128),
                    temperature: None,
                    top_p: None,
                    inline_think_in_text: false,
                    custom_headers: None,
                    custom_headers_mode: None,
                    skip_ssl_verify: false,
                    custom_request_body: None,
                    custom_request_body_mode: None,
                },
            ))
        }
    }

    impl Drop for RetryTestServer {
        fn drop(&mut self) {
            self.stop.store(true, std::sync::atomic::Ordering::Relaxed);
            if let Some(thread) = self.thread.take() {
                if let Err(error) = thread.join() {
                    if !std::thread::panicking() {
                        std::panic::resume_unwind(error);
                    }
                }
            }
        }
    }

    pub(in crate::agentic::execution) fn retry_test_success() -> (u16, String) {
        (
            200,
            format!(
                "data: {}\n\ndata: [DONE]\n\n",
                json!({
                    "id": "retry-test",
                    "object": "chat.completion.chunk",
                    "created": 1,
                    "model": "retry-test-model",
                    "choices": [{"index": 0, "delta": {"content": "Recovered"}, "finish_reason": "stop"}]
                })
            ),
        )
    }

    #[tokio::test]
    async fn model_round_timing_separates_request_ttft_from_output_stream() {
        let delay = Duration::from_millis(50);
        let metadata = json!({
            "id": "timing-test", "object": "chat.completion.chunk", "created": 1,
            "model": "retry-test-model", "choices": [],
            "usage": {"prompt_tokens": 10, "completion_tokens": 0, "total_tokens": 10}
        });
        let (_, answer) = retry_test_success();
        let server = RetryTestServer::with_timing_options(
            vec![(200, format!("data: {metadata}\n\n{answer}"))],
            false,
            None,
            Some((delay, delay)),
        );
        let executor = test_round_executor();
        executor
            .execute_round(
                server.client(),
                test_round_context(),
                vec![super::AIMessage::user("Measure timing".into())],
                None,
                None,
            )
            .await
            .unwrap();
        let events = executor.event_queue.dequeue_batch(100).await;
        let timing = events
            .iter()
            .find_map(|event| match &event.event {
                AgenticEvent::ModelRoundCompleted {
                    first_chunk_ms: Some(first_chunk),
                    first_visible_output_ms: Some(first_output),
                    stream_duration_ms: Some(stream_duration),
                    ttft_ms: Some(ttft),
                    ..
                } => Some((*first_chunk, *first_output, *stream_duration, *ttft)),
                _ => None,
            })
            .expect("completed round must carry host timing");
        let (first_chunk, first_output, stream_duration, ttft) = timing;
        // Metadata arrives before the first token, and HTTP setup precedes both.
        assert!(first_output >= first_chunk + 40, "{timing:?}");
        assert!(ttft >= first_output + 40, "{timing:?}");
        assert!(stream_duration >= first_output + 40, "{timing:?}");
    }

    #[tokio::test]
    async fn multi_channel_pool_preserves_history_protocol_credentials_and_actual_usage() {
        use crate::infrastructure::ai::client_factory::AIClientFactory;
        use crate::service::config::types::{model_runtime_binding_fingerprint, AIModelConfig};
        use crate::service::config::{ConfigManagerSettings, ConfigService};
        use crate::service::token_usage::{TimeRange, TokenUsageQuery, TokenUsageService};
        use openbitfun_config_contracts::channel_routing::ModelChannelRouting;
        for (format, manual, blocked, previous_attempts) in [
            ("openai", false, false, 0),
            ("anthropic", false, false, 0),
            ("gemini", false, false, 0),
            ("openai", true, false, 0),
            ("openai", false, true, 0),
            ("anthropic", false, true, 0),
            ("gemini", false, true, 0),
            (
                "openai",
                false,
                false,
                RoundExecutor::MAX_STREAM_ATTEMPTS as u32,
            ),
        ] {
            let dir = tempfile::tempdir().unwrap();
            let primary = RetryTestServer::new(vec![(
                402,
                json!({"error":{"message":"insufficient quota","code":"insufficient_quota"}})
                    .to_string(),
            )]);
            let success = match format {
                "anthropic" => (200, [
                    json!({"type":"message_start","message":{"id":"backup","type":"message","role":"assistant","model":"reported-backup","usage":{"input_tokens":20,"output_tokens":0}}}),
                    json!({"type":"content_block_start","index":0,"content_block":{"type":"text","text":""}}),
                    json!({"type":"content_block_delta","index":0,"delta":{"type":"text_delta","text":"Recovered"}}),
                    json!({"type":"content_block_stop","index":0}),
                    json!({"type":"message_delta","delta":{"stop_reason":"end_turn"},"usage":{"output_tokens":5}}),
                    json!({"type":"message_stop"}),
                ].iter().map(|event|format!("event: {}\ndata: {event}\n\n", event["type"].as_str().unwrap())).collect::<String>()),
                "gemini" => (200, format!("data: {}\n\n", json!({"candidates":[{"content":{"role":"model","parts":[{"text":"Recovered"}]},"finishReason":"STOP"}],"modelVersion":"reported-backup","usageMetadata":{"promptTokenCount":20,"candidatesTokenCount":5,"totalTokenCount":25}}))),
                _ => retry_test_success(),
            };
            let backup = RetryTestServer::new(vec![success]);
            let config = Arc::new(
                ConfigService::with_settings(ConfigManagerSettings {
                    path_manager: Some(Arc::new(
                        crate::infrastructure::PathManager::with_user_root_for_tests(
                            dir.path().join("host"),
                        ),
                    )),
                    auto_save: true,
                    backup_count: 0,
                })
                .await
                .unwrap(),
            );
            let model = |id: &str, server: &RetryTestServer, provider: &str| AIModelConfig {
                id: id.into(),
                name: id.into(),
                model_name: format!("{id}-model"),
                provider: provider.into(),
                enabled: true,
                base_url: server.url.clone(),
                request_url: Some(server.url.clone()),
                api_key: format!("synthetic-{id}-key"),
                context_window: Some(32000),
                ..Default::default()
            };
            let mut b = model("backup-channel", &backup, format);
            b.context_window = Some(64000);
            let mut a = model("primary-channel", &primary, "openai");
            a.channel_routing = Some(ModelChannelRouting {
                version: 1,
                fallback_model_ids: vec!["backup-channel".into()],
                manual_channel: manual.then(|| "backup-channel".into()),
            });
            config.set_config("ai.models", vec![a, b]).await.unwrap();
            let a = config
                .get_effective_ai_config()
                .await
                .unwrap()
                .models
                .into_iter()
                .find(|model| model.id == "primary-channel")
                .unwrap();
            let factory = Arc::new(AIClientFactory::new_for_test(config));
            let (prepared, channels) = factory
                .prepare_native_routed_model_client(
                    &a.id,
                    &model_runtime_binding_fingerprint(&a),
                    None,
                    Some("channel-history"),
                    None,
                )
                .await
                .unwrap();
            let client = prepared.client.clone();
            assert_eq!(
                client.config.context_window, 32000,
                "A larger initial backup cannot enlarge the primary input contract"
            );
            let ledger = Arc::new(
                TokenUsageService::new_in_base_dir(dir.path().join("ledger"))
                    .await
                    .unwrap(),
            );
            let mut executor = test_round_executor();
            executor.usage_service = Some(ledger.clone());
            let mut context = test_round_context();
            context.model_config_id = a.id.clone();
            context.model_request_context.prompt_cache_route_key = Some("channel-history".into());
            context.account_client_source = prepared.account_source.clone();
            context.channel_client_source = channels;
            context.prepared_model = Some(prepared);
            let mut previous =
                super::AIMessage::assistant_with_tools(vec![openbitfun_core_types::ToolCall {
                    id: "already-done".into(),
                    name: "write_file".into(),
                    arguments: json!({"path":"result.txt"}),
                    raw_arguments: None,
                }]);
            if blocked {
                previous.thinking_signature = Some("original-signed-state".into());
                previous.model_response_replay = Some(openbitfun_core_types::ModelResponseReplay {
                    protocol: "openai".into(),
                    channel_origin: Some(a.id.clone()),
                    channel_fingerprint: Some(client.channel_replay_fingerprint()),
                    account_origin: None,
                    items: vec![],
                });
            }
            let tool: super::AIMessage =
                crate::agentic::core::Message::tool_result(crate::agentic::core::ToolResult {
                    tool_id: "already-done".into(),
                    tool_name: "write_file".into(),
                    effective_tool_name: None,
                    result: json!({"saved":true,"checksum":"channel-fixture"}),
                    result_for_assistant: Some(
                        "Saved exactly once; checksum=channel-fixture".into(),
                    ),
                    is_error: false,
                    duration_ms: Some(1),
                    image_attachments: None,
                })
                .into();
            let history = vec![
                super::AIMessage::user("Save the file".into()),
                previous,
                tool,
                super::AIMessage::user("Continue from that result".into()),
            ];
            let before = serde_json::to_value(&history).unwrap();
            let mut lifecycle = ModelRoundLifecycle::new();
            for _ in 0..previous_attempts {
                lifecycle.begin_attempt();
            }
            let result = tokio::time::timeout(
                Duration::from_secs(12),
                executor.execute_round_with_lifecycle(client, context, history.clone(), None, None,
                    &mut lifecycle, None, None),
            )
            .await
            .unwrap_or_else(|_| panic!("Channel fixture did not settle: protocol={format}, manual={manual}, signed_history={blocked}, primary_requests={}, backup_requests={}", primary.requests.lock().unwrap().len(), backup.requests.lock().unwrap().len()));
            assert_eq!(serde_json::to_value(&history).unwrap(), before);
            let records = ledger
                .query_records(TokenUsageQuery {
                    model_id: None,
                    session_id: None,
                    time_range: TimeRange::All,
                    time_zone: None,
                    limit: None,
                    offset: None,
                    include_subagent: true,
                })
                .await
                .unwrap();
            {
                // Signed history reaches its own channel, then degrades to
                // portable history for the backup instead of blocking it.
                // The primary fixture is Chat Completions, which never sends a
                // signature; the signed backups must not receive it either.
                if blocked {
                    assert!(!backup.requests.lock().unwrap()[0]
                        .to_string()
                        .contains("original-signed-state"));
                }
                match result.unwrap().assistant_message.content {
                    crate::agentic::core::MessageContent::Mixed { text, .. }
                    | crate::agentic::core::MessageContent::Text(text) => {
                        assert_eq!(text, "Recovered")
                    }
                    other => panic!("Unexpected channel response: {other:?}"),
                }
                assert_eq!(primary.requests.lock().unwrap().len(), usize::from(!manual));
                assert_eq!(backup.requests.lock().unwrap().len(), 1);
                let body = backup.requests.lock().unwrap()[0].to_string();
                assert!(
                    body.contains("channel-fixture"),
                    "complete tool history must reach {format}: {body}"
                );
                assert_eq!(records.len(), if manual { 1 } else { 2 });
                let completed=records.iter().find(|record|record.request_context().is_some_and(|request|request.outcome==openbitfun_services_core::token_usage::types::ModelRequestOutcome::Completed)).unwrap();
                assert_eq!(completed.model_config_id, "backup-channel");
                assert_eq!(
                    completed.request_context().unwrap().requested_model,
                    "backup-channel-model"
                );
                assert!(
                    completed.request_context().unwrap().account.is_none(),
                    "API keys must not become fake subscription accounts"
                );
                assert_eq!(
                    completed.request_context().unwrap().attempt_index,
                    previous_attempts + if manual { 1 } else { 2 }
                );
                let headers = backup.headers.lock().unwrap();
                assert!(
                    headers[0]
                        .values()
                        .any(|value| value.contains("synthetic-backup-channel-key")),
                    "backup must use its own credential"
                );
                assert!(!headers[0]
                    .values()
                    .any(|value| value.contains("synthetic-primary-channel-key")));
            }
        }
    }

    #[cfg(feature = "subscription-auth")]
    #[tokio::test]
    async fn multi_channel_pool_exhausts_declared_accounts_then_independent_keys() {
        use crate::infrastructure::ai::client_factory::{
            AIClientFactory, SUBSCRIPTION_STORE_TEST_LOCK,
        };
        use crate::infrastructure::subscription_auth::{self, store, StoredCredential};
        use crate::service::config::types::{
            model_runtime_binding_fingerprint, AIModelConfig, AuthConfig, SubscriptionProvider,
        };
        use crate::service::config::{ConfigManagerSettings, ConfigService};
        use crate::service::token_usage::{TimeRange, TokenUsageQuery, TokenUsageService};
        use openbitfun_config_contracts::channel_routing::ModelChannelRouting;
        use openbitfun_services_core::token_usage::types::ModelRequestOutcome;

        let _guard = SUBSCRIPTION_STORE_TEST_LOCK.lock().await;
        for stream_failure in [false, true] {
            let dir = tempfile::tempdir().unwrap();
            subscription_auth::set_store_path_for_test(dir.path().join("subscription.json"));
            let second_account = format!("codex-account-{}", uuid::Uuid::new_v4());
            for (id, seat) in [("codex", "seat-one"), (second_account.as_str(), "seat-two")] {
                store::upsert(
                    id,
                    StoredCredential::Oauth {
                        access: format!("synthetic-{seat}"),
                        refresh: "synthetic-refresh".into(),
                        expires: chrono::Utc::now().timestamp_millis() + 3_600_000,
                        account_id: Some(seat.into()),
                        metadata: None,
                    },
                )
                .await
                .unwrap();
            }
            let quota_failure = if stream_failure {
                (
                    200,
                    format!(
                        "data: {}\n\n",
                        json!({"type":"response.failed","response":{"id":"rejected","error":{"code":"insufficient_quota","message":"Quota exhausted"}}})
                    ),
                )
            } else {
                account_quota_error()
            };
            let codex = RetryTestServer::new(vec![quota_failure.clone(), quota_failure]);
            let first_key = RetryTestServer::new(vec![account_quota_error()]);
            let success = [
                json!({"type":"message_start","message":{"id":"mixed-success","type":"message","role":"assistant","model":"reported-backup","usage":{"input_tokens":20,"output_tokens":0}}}),
                json!({"type":"content_block_start","index":0,"content_block":{"type":"text","text":""}}),
                json!({"type":"content_block_delta","index":0,"delta":{"type":"text_delta","text":"Recovered"}}),
                json!({"type":"content_block_stop","index":0}),
                json!({"type":"message_delta","delta":{"stop_reason":"end_turn"},"usage":{"output_tokens":5}}),
                json!({"type":"message_stop"}),
            ];
            let second_key = RetryTestServer::new(vec![(
                200,
                success
                    .iter()
                    .map(|event| {
                        format!(
                            "event: {}\ndata: {event}\n\n",
                            event["type"].as_str().unwrap()
                        )
                    })
                    .collect(),
            )]);
            let config = Arc::new(
                ConfigService::with_settings(ConfigManagerSettings {
                    path_manager: Some(Arc::new(
                        crate::infrastructure::PathManager::with_user_root_for_tests(
                            dir.path().join("host"),
                        ),
                    )),
                    auto_save: true,
                    backup_count: 0,
                })
                .await
                .unwrap(),
            );
            let subscription = AIModelConfig {
                id: "subscription-channel".into(),
                name: "Subscription channel".into(),
                provider: "responses".into(),
                model_name: "subscription-model".into(),
                enabled: true,
                context_window: Some(32000),
                auth: AuthConfig::SubscriptionPool {
                    provider: SubscriptionProvider::Codex,
                    accounts: vec!["codex".into(), second_account.clone()],
                    revision: 1,
                },
                channel_routing: Some(ModelChannelRouting {
                    version: 1,
                    fallback_model_ids: vec!["key-one".into(), "key-two".into()],
                    manual_channel: None,
                }),
                ..Default::default()
            };
            let key_model = |id: &str, server: &RetryTestServer| AIModelConfig {
                id: id.into(),
                name: id.into(),
                provider: "anthropic".into(),
                model_name: format!("{id}-model"),
                enabled: true,
                context_window: Some(32000),
                base_url: server.url.clone(),
                request_url: Some(server.url.clone()),
                api_key: format!("synthetic-{id}"),
                ..Default::default()
            };
            config
                .set_config(
                    "ai.models",
                    vec![
                        subscription,
                        key_model("key-one", &first_key),
                        key_model("key-two", &second_key),
                    ],
                )
                .await
                .unwrap();
            let subscription = config
                .get_effective_ai_config()
                .await
                .unwrap()
                .models
                .into_iter()
                .find(|model| model.id == "subscription-channel")
                .unwrap();
            let factory = Arc::new(AIClientFactory::new_for_test(config));
            for account in ["codex", second_account.as_str()] {
                factory.set_account_test_endpoint(account, &codex.url);
            }
            let (prepared, channels) = factory
                .prepare_native_routed_model_client(
                    &subscription.id,
                    &model_runtime_binding_fingerprint(&subscription),
                    None,
                    Some("mixed-lineage"),
                    None,
                )
                .await
                .unwrap();
            let client = prepared.client.clone();
            let ledger = Arc::new(
                TokenUsageService::new_in_base_dir(dir.path().join("ledger"))
                    .await
                    .unwrap(),
            );
            let mut executor = test_round_executor();
            executor.usage_service = Some(ledger.clone());
            let mut context = test_round_context();
            context.model_config_id = subscription.id.clone();
            context.account_client_source = prepared.account_source.clone();
            context.channel_client_source = channels;
            context.prepared_model = Some(prepared);
            context.model_request_context.prompt_cache_route_key = Some("mixed-lineage".into());
            let previous =
                super::AIMessage::assistant_with_tools(vec![openbitfun_core_types::ToolCall {
                    id: "already-written".into(),
                    name: "write_file".into(),
                    arguments: json!({"path":"result.txt"}),
                    raw_arguments: None,
                }]);
            let tool: super::AIMessage =
                crate::agentic::core::Message::tool_result(crate::agentic::core::ToolResult {
                    tool_id: "already-written".into(),
                    tool_name: "write_file".into(),
                    effective_tool_name: None,
                    result: json!({"checksum":"mixed-saved-once"}),
                    result_for_assistant: Some("Saved once: mixed-saved-once".into()),
                    is_error: false,
                    duration_ms: Some(1),
                    image_attachments: None,
                })
                .into();
            let history = vec![
                super::AIMessage::user("Save the file".into()),
                previous,
                tool,
                super::AIMessage::user("Continue".into()),
            ];
            let original = serde_json::to_value(&history).unwrap();
            let result = tokio::time::timeout(
                Duration::from_secs(12),
                executor.execute_round(client, context, history.clone(), None, None),
            )
            .await
            .expect("mixed pool should settle within one round budget")
            .unwrap();
            assert!(
                matches!(result.assistant_message.content, crate::agentic::core::MessageContent::Text(ref text) | crate::agentic::core::MessageContent::Mixed { ref text, .. } if text == "Recovered")
            );
            assert_eq!(serde_json::to_value(&history).unwrap(), original);
            assert_eq!(codex.requests.lock().unwrap().len(), 2);
            assert_eq!(first_key.requests.lock().unwrap().len(), 1);
            assert_eq!(second_key.requests.lock().unwrap().len(), 1);
            for server in [&codex, &first_key, &second_key] {
                for body in server.requests.lock().unwrap().iter() {
                    assert!(
                        body.to_string().contains("mixed-saved-once"),
                        "complete existing tool result must survive every candidate: {body}"
                    );
                }
            }
            let headers = codex.headers.lock().unwrap();
            for (index, seat) in ["seat-one", "seat-two"].iter().enumerate() {
                assert_eq!(
                    headers[index].get("authorization"),
                    Some(&format!("Bearer synthetic-{seat}"))
                );
                assert_eq!(
                    headers[index].get("chatgpt-account-id"),
                    Some(&seat.to_string())
                );
            }
            for (server, key) in [
                (&first_key, "synthetic-key-one"),
                (&second_key, "synthetic-key-two"),
            ] {
                let headers = server.headers.lock().unwrap();
                assert_eq!(headers[0].get("x-api-key").map(String::as_str), Some(key));
                assert!(!headers[0].contains_key("chatgpt-account-id"));
            }
            let mut records = ledger
                .query_records(TokenUsageQuery {
                    model_id: None,
                    session_id: None,
                    time_range: TimeRange::All,
                    time_zone: None,
                    limit: None,
                    offset: None,
                    include_subagent: true,
                })
                .await
                .unwrap();
            records.sort_by_key(|record| record.request_context().unwrap().attempt_index);
            assert_eq!(records.len(), 4);
            assert_eq!(
                records[0].request_context().unwrap().channel.as_ref().unwrap().binding_fingerprint,
                records[1].request_context().unwrap().channel.as_ref().unwrap().binding_fingerprint,
                "Changing the account within a declared channel must not split its usage distribution"
            );
            for (index, record) in records.iter().enumerate() {
                let request = record.request_context().unwrap();
                assert_eq!(request.attempt_index as usize, index + 1);
                assert_eq!(
                    request.outcome,
                    if index == 3 {
                        ModelRequestOutcome::Completed
                    } else {
                        ModelRequestOutcome::Failed
                    }
                );
                assert_eq!(
                    record.model_config_id,
                    [
                        "subscription-channel",
                        "subscription-channel",
                        "key-one",
                        "key-two"
                    ][index]
                );
                assert_eq!(
                    request.channel.as_ref().unwrap().model_config_id,
                    record.model_config_id
                );
                if index < 2 {
                    assert_eq!(
                        request.account.as_ref().unwrap().account_id,
                        ["codex", second_account.as_str()][index]
                    );
                } else {
                    assert!(
                        request.account.is_none(),
                        "API keys do not acquire fictitious account identities"
                    );
                }
            }
            assert_eq!(
                records
                    .iter()
                    .map(|record| u64::from(record.total_tokens))
                    .sum::<u64>(),
                25
            );
        }
    }

    /// Exercise the real factory, credentials and routing state with loopback
    /// HTTP. Auth cases may arrange one concurrent credential replacement.
    #[cfg(feature = "subscription-auth")]
    #[derive(Debug)]
    struct FactoryFixtureSource {
        inner: Arc<dyn crate::infrastructure::ai::account_client_source::AccountClientSource>,
        urls: HashMap<String, String>,
        /// Simulate a concurrent refresh exactly before production recovery.
        concurrent_refresh: Option<Arc<std::sync::atomic::AtomicUsize>>,
    }

    #[cfg(feature = "subscription-auth")]
    impl FactoryFixtureSource {
        fn redirect(
            &self,
            selected: Option<crate::infrastructure::ai::account_client_source::AccountClient>,
        ) -> Option<crate::infrastructure::ai::account_client_source::AccountClient> {
            selected.map(|mut selected| {
                let url = &self.urls[&selected.origin.account_id];
                assert!(url.starts_with("http://127.0.0.1:"));
                let mut client = (*selected.client).clone();
                client.config.base_url = url.clone();
                client.config.request_url = url.clone();
                selected.client = Arc::new(client);
                selected
            })
        }
    }

    #[cfg(feature = "subscription-auth")]
    impl crate::infrastructure::ai::account_client_source::AccountClientSource
        for FactoryFixtureSource
    {
        fn take_routing_warnings(&self) -> Vec<String> {
            self.inner.take_routing_warnings()
        }
        fn policy(&self) -> &openbitfun_agent_runtime::account_routing::AccountPolicy {
            self.inner.policy()
        }
        fn policy_revision(&self) -> Option<u64> {
            self.inner.policy_revision()
        }
        fn resolve<'a>(
            &'a self,
            excluded: &'a [String],
            required: Option<&'a openbitfun_core_types::ModelAccountOrigin>,
        ) -> crate::infrastructure::ai::account_client_source::AccountClientFuture<'a> {
            self.resolve_for_request(excluded, required, None)
        }
        fn resolve_for_request<'a>(
            &'a self,
            excluded: &'a [String],
            required: Option<&'a openbitfun_core_types::ModelAccountOrigin>,
            lineage: Option<&'a str>,
        ) -> crate::infrastructure::ai::account_client_source::AccountClientFuture<'a> {
            Box::pin(async move {
                self.inner
                    .resolve_for_request(excluded, required, lineage)
                    .await
                    .map(|selected| self.redirect(selected))
            })
        }
        fn revalidate_for_retry<'a>(
            &'a self,
            origin: &'a openbitfun_core_types::ModelAccountOrigin,
        ) -> crate::infrastructure::ai::account_client_source::AccountClientFuture<'a> {
            Box::pin(async move {
                self.inner
                    .revalidate_for_retry(origin)
                    .await
                    .map(|selected| self.redirect(selected))
            })
        }
        fn recover_authentication<'a>(
            &'a self,
            origin: &'a openbitfun_core_types::ModelAccountOrigin,
            rejected: &'a crate::infrastructure::ai::AIClient,
        ) -> crate::infrastructure::ai::account_client_source::AccountClientFuture<'a> {
            Box::pin(async move {
                use crate::infrastructure::subscription_auth::{store, StoredCredential};
                let calls = self.concurrent_refresh.as_ref().expect(
                    "Auth fixtures must arrange isolated recovery before contacting a provider",
                );
                assert_eq!(
                    calls.fetch_add(1, std::sync::atomic::Ordering::SeqCst),
                    0,
                    "one account may recover authentication only once per round"
                );
                store::upsert(
                    &origin.account_id,
                    StoredCredential::Oauth {
                        access: format!(
                            "synthetic-rotated-{}",
                            origin.upstream_account_id.as_deref().unwrap()
                        ),
                        refresh: "synthetic-refresh".into(),
                        expires: chrono::Utc::now().timestamp_millis() + 3_600_000,
                        account_id: origin.upstream_account_id.clone(),
                        metadata: None,
                    },
                )
                .await?;
                // The real factory/adapter must reuse this same-seat token
                // under its lease, without another OAuth network request.
                self.inner
                    .recover_authentication(origin, rejected)
                    .await
                    .map(|selected| self.redirect(selected))
            })
        }
        fn completed<'a>(
            &'a self,
            origin: &'a openbitfun_core_types::ModelAccountOrigin,
            revision: u64,
            lineage: Option<&'a str>,
        ) -> crate::infrastructure::ai::account_client_source::AccountRoutingEffect<'a> {
            self.inner.completed(origin, revision, lineage)
        }
        fn failed<'a>(
            &'a self,
            origin: &'a openbitfun_core_types::ModelAccountOrigin,
            revision: u64,
            until: i64,
        ) -> crate::infrastructure::ai::account_client_source::AccountRoutingEffect<'a> {
            self.inner.failed(origin, revision, until)
        }
    }

    #[cfg(feature = "subscription-auth")]
    #[tokio::test]
    async fn factory_backed_round_preserves_retry_budget_history_and_actual_account_ledger() {
        use crate::infrastructure::ai::client_factory::{
            AIClientFactory, SUBSCRIPTION_STORE_TEST_LOCK,
        };
        use crate::infrastructure::subscription_auth::{self, store, StoredCredential};
        use crate::service::config::types::{
            model_runtime_binding_fingerprint, AIModelConfig, AuthConfig, SubscriptionProvider,
        };
        use crate::service::config::{ConfigManagerSettings, ConfigService};
        use crate::service::token_usage::{TimeRange, TokenUsageQuery, TokenUsageService};
        let _guard = SUBSCRIPTION_STORE_TEST_LOCK.lock().await;
        let response = || {
            let events = [
                json!({"type":"response.output_text.delta", "delta":"Continued safely"}),
                json!({"type":"response.completed", "response":{"id":"fixture-factory", "model":"factory-served-snapshot", "output":[],
                    "usage":{"input_tokens":20,"output_tokens":5,"total_tokens":25}}}),
            ];
            (
                200,
                events
                    .iter()
                    .map(|event| format!("data: {event}\n\n"))
                    .collect::<String>(),
            )
        };
        for (fixed, unavailable_backup, stream_quota, opaque, corrupt_preferences) in [
            (true, false, false, false, false),
            (false, false, false, false, false),
            (false, true, false, false, false),
            (false, false, true, false, false),
            (false, false, false, true, false),
            (false, false, true, true, false),
            (false, false, false, false, true),
        ] {
            let retry_same = fixed || unavailable_backup;
            let dir = tempfile::tempdir().unwrap();
            subscription_auth::set_store_path_for_test(dir.path().join("subscription.json"));
            let backup_id = format!("codex-account-{}", uuid::Uuid::new_v4());
            for (id, seat) in [
                ("codex", "primary-seat"),
                (backup_id.as_str(), "backup-seat"),
            ] {
                store::upsert(
                    id,
                    StoredCredential::Oauth {
                        access: format!("synthetic-{seat}"),
                        refresh: "synthetic-refresh".into(),
                        expires: chrono::Utc::now().timestamp_millis() + 3_600_000,
                        account_id: Some(seat.into()),
                        metadata: None,
                    },
                )
                .await
                .unwrap();
            }
            if unavailable_backup {
                subscription_auth::set_account_instance_enabled(
                    subscription_auth::SubscriptionProvider::Codex,
                    &backup_id,
                    false,
                )
                .await
                .unwrap();
            }
            let config = Arc::new(
                ConfigService::with_settings(ConfigManagerSettings {
                    path_manager: Some(Arc::new(
                        crate::infrastructure::PathManager::with_user_root_for_tests(
                            dir.path().join("executing-host"),
                        ),
                    )),
                    auto_save: true,
                    backup_count: 0,
                })
                .await
                .unwrap(),
            );
            let model = AIModelConfig {
                id: "factory-round".into(),
                name: "Factory round fixture".into(),
                model_name: "fixture-model".into(),
                provider: "responses".into(),
                enabled: true,
                base_url: "https://saved-route.invalid".into(),
                auth: if fixed {
                    AuthConfig::Subscription {
                        provider: SubscriptionProvider::Codex,
                        plan: None,
                        account_id: Some("codex".into()),
                    }
                } else {
                    AuthConfig::SubscriptionPool {
                        provider: SubscriptionProvider::Codex,
                        accounts: vec!["codex".into(), backup_id.clone()],
                        revision: 1,
                    }
                },
                ..Default::default()
            };
            config
                .install_runtime_ai_model(model.clone())
                .await
                .unwrap();
            let factory = Arc::new(AIClientFactory::new_for_test(config.clone()));
            let fingerprint = model_runtime_binding_fingerprint(&model);
            let (prepared, route) = factory
                .prepare_native_model_client(
                    &model.id,
                    &fingerprint,
                    None,
                    Some("history-lineage"),
                    None,
                )
                .await
                .unwrap();
            let primary = RetryTestServer::new(if retry_same {
                vec![
                    (
                        503,
                        json!({"error":{"message":"Temporary provider outage"}}).to_string(),
                    ),
                    response(),
                ]
            } else if stream_quota {
                let events = [
                    json!({"type":"response.created", "response":{"id":"failed-fixture","model":"primary-reported-snapshot"}}),
                    json!({"type":"response.failed", "response":{"id":"failed-fixture", "model":"primary-reported-snapshot", "error":{"code":"insufficient_quota","message":"Quota exhausted"}}}),
                ];
                vec![(
                    200,
                    events
                        .iter()
                        .map(|event| format!("data: {event}\n\n"))
                        .collect(),
                )]
            } else {
                vec![account_quota_error()]
            });
            let backup = RetryTestServer::new(vec![response()]);
            let route = route.unwrap();
            let mut preserved_preferences = Vec::new();
            if corrupt_preferences {
                let selected = route
                    .resolve_for_request(&[], None, Some("history-lineage"))
                    .await
                    .unwrap()
                    .unwrap();
                route
                    .completed(
                        &selected.origin,
                        selected.credential_revision,
                        Some("history-lineage"),
                    )
                    .await
                    .unwrap();
                route
                    .failed(&selected.origin, selected.credential_revision, 0)
                    .await
                    .unwrap();
                let routing_dir = config.user_data_dir().await.join("subscription-routing");
                for kind in ["affinity", "cooldown"] {
                    let mut entries = tokio::fs::read_dir(routing_dir.join(kind)).await.unwrap();
                    let mut found = false;
                    while let Some(entry) = entries.next_entry().await.unwrap() {
                        if entry
                            .path()
                            .extension()
                            .is_some_and(|extension| extension == "json")
                        {
                            let raw = b"{unreadable-preference-record".to_vec();
                            tokio::fs::write(entry.path(), &raw).await.unwrap();
                            preserved_preferences.push((entry.path(), raw));
                            found = true;
                        }
                    }
                    assert!(
                        found,
                        "the fixture must corrupt an actual routing preference record"
                    );
                }
            }
            let source = Arc::new(FactoryFixtureSource {
                inner: route,
                concurrent_refresh: None,
                urls: HashMap::from([
                    ("codex".into(), primary.url.clone()),
                    (backup_id.clone(), backup.url.clone()),
                ]),
            });
            let ledger = Arc::new(
                TokenUsageService::new_in_base_dir(dir.path().join("ledger"))
                    .await
                    .unwrap(),
            );
            let mut executor = test_round_executor();
            executor.usage_service = Some(ledger.clone());
            let mut context = test_round_context();
            context.model_config_id = model.id.clone();
            context.effective_model_name = model.model_name.clone();
            context.model_request_context.prompt_cache_route_key = Some("history-lineage".into());
            context.account_client_source = Some(source.clone());
            let mut tool = super::AIMessage::user("File saved once; checksum=fixture".into());
            tool.role = "tool".into();
            tool.tool_call_id = Some("completed-tool".into());
            let mut previous =
                super::AIMessage::assistant_with_tools(vec![openbitfun_core_types::ToolCall {
                    id: "completed-tool".into(),
                    name: "write_file".into(),
                    arguments: json!({"path":"result.txt"}),
                    raw_arguments: None,
                }]);
            if opaque {
                previous.model_response_replay = Some(openbitfun_core_types::ModelResponseReplay {
                    protocol: "openai_responses".into(),
                    channel_origin: None,
                    channel_fingerprint: None,
                    account_origin: Some(openbitfun_core_types::ModelAccountOrigin {
                        provider: "codex".into(),
                        account_id: "codex".into(),
                        upstream_account_id: Some("primary-seat".into()),
                    }),
                    items: vec![
                        openbitfun_core_types::ModelResponseReplayItem::OpaqueReasoning {
                            item_id: Some("historical-reasoning".into()),
                            summary: vec![],
                            opaque_state: "synthetic-encrypted-state".into(),
                        },
                        openbitfun_core_types::ModelResponseReplayItem::FunctionCall {
                            call_id: "completed-tool".into(),
                        },
                    ],
                });
            }
            let history = vec![
                super::AIMessage::user("Save the file".into()),
                previous,
                tool,
                super::AIMessage::assistant("Saved".into()),
                super::AIMessage::user("Continue".into()),
            ];
            // Resume from persisted history, including the original opaque
            // state and completed tool exchange, rather than rebuilding it.
            let encoded = serde_json::to_value(&history).unwrap();
            let history = serde_json::from_value(encoded.clone()).unwrap();
            assert_eq!(serde_json::to_value(&history).unwrap(), encoded);
            let result = tokio::time::timeout(
                Duration::from_secs(15),
                executor.execute_round(prepared, context, history, None, None),
            )
            .await
            .unwrap();
            let records = ledger
                .query_records(TokenUsageQuery {
                    model_id: None,
                    session_id: None,
                    time_range: TimeRange::All,
                    time_zone: None,
                    limit: None,
                    offset: None,
                    include_subagent: true,
                })
                .await
                .unwrap();
            if opaque {
                // The signing account receives its own encrypted state; the
                // pool backup receives the same visible history without it.
                let sent = primary.requests.lock().unwrap();
                assert_eq!(sent.len(), 1);
                let input = sent[0]["input"].as_array().unwrap();
                assert!(input
                    .iter()
                    .any(|item| item["encrypted_content"] == "synthetic-encrypted-state"));
                let backup_sent = backup.requests.lock().unwrap();
                assert_eq!(backup_sent.len(), 1);
                let backup_input = backup_sent[0]["input"].as_array().unwrap();
                assert!(!backup_input
                    .iter()
                    .any(|item| item.get("encrypted_content").is_some()));
                for kind in ["function_call", "function_call_output"] {
                    assert_eq!(
                        backup_input
                            .iter()
                            .filter(|item| item["type"] == kind)
                            .count(),
                        1
                    );
                }
            }
            let result = result.unwrap();
            assert!(result.had_assistant_text);
            assert!(result.tool_result_messages.is_empty());
            assert_eq!(records.len(), 2);
            let completed = records.iter().find(|record| record.request_context().unwrap().outcome == openbitfun_services_core::token_usage::types::ModelRequestOutcome::Completed).unwrap();
            assert_eq!(
                completed
                    .request_context()
                    .unwrap()
                    .response_model
                    .as_deref(),
                Some("factory-served-snapshot")
            );
            assert_eq!(
                completed.request_context().unwrap().requested_model,
                "fixture-model"
            );
            let failed = records
                .iter()
                .find(|record| {
                    record.request_context().unwrap().outcome
                        == openbitfun_services_core::token_usage::types::ModelRequestOutcome::Failed
                })
                .unwrap();
            assert_eq!(
                failed.request_context().unwrap().response_model.as_deref(),
                stream_quota.then_some("primary-reported-snapshot")
            );
            if corrupt_preferences {
                assert_eq!(
                    failed.request_context().unwrap().routing_warnings,
                    ["affinity_unavailable", "cooldown_unavailable"]
                );
                assert_eq!(
                    completed.request_context().unwrap().routing_warnings,
                    ["affinity_unavailable"]
                );
                for (path, raw) in &preserved_preferences {
                    assert_eq!(tokio::fs::read(path).await.unwrap(), *raw);
                }
                let restored_ledger = TokenUsageService::new_in_base_dir(dir.path().join("ledger"))
                    .await
                    .unwrap();
                let restored = restored_ledger
                    .query_records(TokenUsageQuery {
                        model_id: None,
                        session_id: None,
                        time_range: TimeRange::All,
                        time_zone: None,
                        limit: None,
                        offset: None,
                        include_subagent: true,
                    })
                    .await
                    .unwrap();
                assert_eq!(restored.len(), 2);
                assert!(restored.iter().all(|record| !record
                    .request_context()
                    .unwrap()
                    .routing_warnings
                    .is_empty()));
            } else {
                assert!(records.iter().all(|record| record
                    .request_context()
                    .unwrap()
                    .routing_warnings
                    .is_empty()));
            }
            let actual = completed.request_context().unwrap().account.unwrap();
            assert_eq!(
                actual.account_id,
                if retry_same {
                    "codex"
                } else {
                    backup_id.as_str()
                }
            );
            assert_eq!(completed.total_tokens, 25);
            assert_eq!(
                records
                    .iter()
                    .filter(|record| !record.usage_is_known())
                    .count(),
                1
            );
            assert_eq!(
                records[0].request_context().unwrap().round_id,
                records[1].request_context().unwrap().round_id
            );
            assert_eq!(
                records
                    .iter()
                    .map(|record| record.request_context().unwrap().attempt_index)
                    .max(),
                Some(2)
            );
            let primary_sent = primary.requests.lock().unwrap();
            let next_sent = if retry_same {
                primary_sent[1].clone()
            } else {
                backup.requests.lock().unwrap()[0].clone()
            };
            assert_eq!(primary_sent.len(), if retry_same { 2 } else { 1 });
            let visible = |input: &serde_json::Value| {
                input
                    .as_array()
                    .unwrap()
                    .iter()
                    .filter(|item| retry_same || item["type"] != "reasoning")
                    .cloned()
                    .collect::<Vec<_>>()
            };
            assert_eq!(
                visible(&primary_sent[0]["input"]),
                visible(&next_sent["input"]),
                "the real factory retry/failover must retain completed tool history"
            );
            assert_eq!(
                backup.requests.lock().unwrap().len(),
                usize::from(!retry_same)
            );
            let first_headers = primary.headers.lock().unwrap();
            assert_eq!(
                first_headers[0]["authorization"],
                "Bearer synthetic-primary-seat"
            );
            assert_eq!(first_headers[0]["chatgpt-account-id"], "primary-seat");
            let last_headers = if retry_same {
                first_headers[1].clone()
            } else {
                backup.headers.lock().unwrap()[0].clone()
            };
            assert_eq!(
                last_headers["authorization"],
                if retry_same {
                    "Bearer synthetic-primary-seat"
                } else {
                    "Bearer synthetic-backup-seat"
                }
            );
            assert_eq!(
                last_headers["chatgpt-account-id"],
                actual.upstream_account_id.as_ref().unwrap().as_str()
            );
            assert!(!dir.path().join("subscription.capacity").exists());
            if !retry_same {
                let restarted = Arc::new(AIClientFactory::new_for_test(config));
                let (client, restored_route) = restarted
                    .prepare_native_model_client(
                        &model.id,
                        &fingerprint,
                        None,
                        Some("history-lineage"),
                        None,
                    )
                    .await
                    .unwrap();
                if corrupt_preferences {
                    let origin = client.subscription_account_origin("codex").unwrap();
                    assert_eq!(
                        origin.account_id, "codex",
                        "unreadable preferences must return to the declared order after restart"
                    );
                    assert_eq!(origin.upstream_account_id.as_deref(), Some("primary-seat"));
                    let warnings = restored_route.unwrap().take_routing_warnings();
                    assert!(warnings.contains(&"affinity_unavailable".into()));
                    assert!(warnings.contains(&"cooldown_unavailable".into()));
                } else {
                    assert_eq!(
                        client.subscription_account_origin(&backup_id).unwrap(),
                        actual
                    );
                }
            }
        }
    }

    #[cfg(feature = "subscription-auth")]
    #[tokio::test]
    async fn factory_backed_auth_recovery_reuses_rotated_credentials_before_switching() {
        use crate::infrastructure::ai::client_factory::{
            AIClientFactory, SUBSCRIPTION_STORE_TEST_LOCK,
        };
        use crate::infrastructure::subscription_auth::{self, store, StoredCredential};
        use crate::service::config::types::{
            model_runtime_binding_fingerprint, AIModelConfig, AuthConfig, SubscriptionProvider,
        };
        use crate::service::config::{ConfigManagerSettings, ConfigService};
        use crate::service::token_usage::{TimeRange, TokenUsageQuery, TokenUsageService};
        use openbitfun_services_core::token_usage::types::ModelRequestOutcome;
        use std::sync::atomic::{AtomicUsize, Ordering};
        let _guard = SUBSCRIPTION_STORE_TEST_LOCK.lock().await;
        for (in_stream, reject_rotated, fixed, partial) in [
            (false, false, false, false),
            (true, false, false, false),
            (false, true, false, false),
            (true, true, false, false),
            (false, true, true, false),
            (true, false, false, true),
        ] {
            let dir = tempfile::tempdir().unwrap();
            subscription_auth::set_store_path_for_test(dir.path().join("subscription.json"));
            let backup_id = format!("codex-account-{}", uuid::Uuid::new_v4());
            for (id, seat) in [
                ("codex", "primary-seat"),
                (backup_id.as_str(), "backup-seat"),
            ] {
                store::upsert(
                    id,
                    StoredCredential::Oauth {
                        access: format!("synthetic-{seat}"),
                        refresh: "synthetic-refresh".into(),
                        expires: chrono::Utc::now().timestamp_millis() + 3_600_000,
                        account_id: Some(seat.into()),
                        metadata: None,
                    },
                )
                .await
                .unwrap();
            }
            let config = Arc::new(
                ConfigService::with_settings(ConfigManagerSettings {
                    path_manager: Some(Arc::new(
                        crate::infrastructure::PathManager::with_user_root_for_tests(
                            dir.path().join("host"),
                        ),
                    )),
                    auto_save: true,
                    backup_count: 0,
                })
                .await
                .unwrap(),
            );
            let model = AIModelConfig {
                id: "auth-recovery-model".into(),
                model_name: "fixture-model".into(),
                provider: "responses".into(),
                enabled: true,
                base_url: "https://saved-route.invalid".into(),
                auth: if fixed {
                    AuthConfig::Subscription {
                        provider: SubscriptionProvider::Codex,
                        plan: None,
                        account_id: Some("codex".into()),
                    }
                } else {
                    AuthConfig::SubscriptionPool {
                        provider: SubscriptionProvider::Codex,
                        accounts: vec!["codex".into(), backup_id.clone()],
                        revision: 1,
                    }
                },
                ..Default::default()
            };
            config
                .install_runtime_ai_model(model.clone())
                .await
                .unwrap();
            let factory = Arc::new(AIClientFactory::new_for_test(config));
            let (client, route) = factory
                .prepare_native_model_client(
                    &model.id,
                    &model_runtime_binding_fingerprint(&model),
                    None,
                    Some("auth-lineage"),
                    None,
                )
                .await
                .unwrap();
            let success = || {
                (
                    200,
                    format!(
                        "data: {}\n\ndata: {}\n\n",
                        json!({"type":"response.output_text.delta","delta":"Recovered after refresh"}),
                        json!({"type":"response.completed","response":{"id":"auth-response","model":"auth-served-snapshot","output":[],"usage":{"input_tokens":20,"output_tokens":5,"total_tokens":25}}}),
                    ),
                )
            };
            let primary = RetryTestServer::new(if partial {
                vec![(
                    200,
                    format!(
                        "data: {}\n\n{}",
                        json!({"type":"response.output_text.delta","delta":"Partial answer"}),
                        account_auth_error(true).1
                    ),
                )]
            } else {
                vec![
                    account_auth_error(in_stream),
                    if reject_rotated {
                        account_auth_error(in_stream)
                    } else {
                        success()
                    },
                ]
            });
            let backup = RetryTestServer::new(vec![success()]);
            let recoveries = Arc::new(AtomicUsize::new(0));
            let source = Arc::new(FactoryFixtureSource {
                inner: route.unwrap(),
                concurrent_refresh: Some(recoveries.clone()),
                urls: HashMap::from([
                    ("codex".into(), primary.url.clone()),
                    (backup_id.clone(), backup.url.clone()),
                ]),
            });
            let ledger = Arc::new(
                TokenUsageService::new_in_base_dir(dir.path().join("ledger"))
                    .await
                    .unwrap(),
            );
            let mut executor = test_round_executor();
            executor.usage_service = Some(ledger.clone());
            let mut context = test_round_context();
            context.model_config_id = model.id.clone();
            context.effective_model_name = model.model_name.clone();
            context.model_request_context.prompt_cache_route_key = Some("auth-lineage".into());
            context.account_client_source = Some(source);
            let mut lifecycle = ModelRoundLifecycle::new();
            let result = tokio::time::timeout(
                Duration::from_secs(10),
                executor.execute_round_with_lifecycle(
                    client,
                    context,
                    vec![super::AIMessage::user(
                        "Keep the same account when its credential recovers".into(),
                    )],
                    None,
                    None,
                    &mut lifecycle,
                    None,
                None, ),
            )
            .await
            .unwrap_or_else(|_| panic!("Auth recovery did not settle: stream={in_stream}, reject_rotated={reject_rotated}, fixed={fixed}, partial={partial}, recoveries={}, primary_requests={}, backup_requests={}",
                recoveries.load(Ordering::SeqCst), primary.requests.lock().unwrap().len(), backup.requests.lock().unwrap().len()));
            let switched = reject_rotated && !fixed;
            let completed = !partial && !(reject_rotated && fixed);
            if partial || (reject_rotated && fixed) {
                assert_eq!(
                    result.unwrap_err().error_detail().category,
                    ErrorCategory::Auth
                );
            } else if !partial {
                let response: super::AIMessage = result.unwrap().assistant_message.into();
                assert_eq!(response.content.as_deref(), Some("Recovered after refresh"));
            }
            assert_eq!(recoveries.load(Ordering::SeqCst), usize::from(!partial));
            let primary_requests = primary.requests.lock().unwrap();
            let backup_requests = backup.requests.lock().unwrap();
            assert_eq!(primary_requests.len(), if partial { 1 } else { 2 });
            assert_eq!(backup_requests.len(), usize::from(switched));
            assert_eq!(
                lifecycle.attempts_started() as usize,
                primary_requests.len() + backup_requests.len()
            );
            if !partial {
                assert_eq!(primary_requests[0]["input"], primary_requests[1]["input"]);
                let headers = primary.headers.lock().unwrap();
                assert_eq!(headers[0]["authorization"], "Bearer synthetic-primary-seat");
                assert_eq!(
                    headers[1]["authorization"],
                    "Bearer synthetic-rotated-primary-seat"
                );
                assert!(headers
                    .iter()
                    .all(|headers| headers["chatgpt-account-id"] == "primary-seat"));
            }
            if switched {
                assert_eq!(primary_requests[0]["input"], backup_requests[0]["input"]);
                assert_eq!(
                    backup.headers.lock().unwrap()[0]["authorization"],
                    "Bearer synthetic-backup-seat"
                );
            }
            let mut records = ledger
                .query_records(TokenUsageQuery {
                    model_id: None,
                    session_id: None,
                    time_range: TimeRange::All,
                    time_zone: None,
                    limit: None,
                    offset: None,
                    include_subagent: true,
                })
                .await
                .unwrap();
            records.sort_by_key(|record| record.request_context().unwrap().attempt_index);
            assert_eq!(records.len(), lifecycle.attempts_started() as usize);
            for (index, record) in records.iter().enumerate() {
                let attempt = record.request_context().unwrap();
                assert_eq!(attempt.round_id, lifecycle.round_id);
                assert_eq!(attempt.attempt_index as usize, index + 1);
                assert_eq!(
                    attempt.retry_reason,
                    (index > 0).then_some(ErrorCategory::Auth)
                );
                let backup_attempt = switched && index == 2;
                assert_eq!(
                    attempt.account.unwrap().account_id,
                    if backup_attempt {
                        backup_id.as_str()
                    } else {
                        "codex"
                    }
                );
                let success = completed && index == records.len() - 1;
                assert_eq!(
                    attempt.outcome,
                    if success {
                        ModelRequestOutcome::Completed
                    } else {
                        ModelRequestOutcome::Failed
                    }
                );
                assert_eq!(record.usage_is_known(), success);
            }
            assert_eq!(
                records
                    .iter()
                    .filter(|record| record.usage_is_known())
                    .map(|record| record.total_tokens)
                    .sum::<u32>(),
                if completed { 25 } else { 0 }
            );
        }
    }

    #[cfg(feature = "subscription-auth")]
    #[tokio::test]
    async fn factory_backed_state_survives_three_independent_host_processes() {
        for opaque in [false, true] {
            let dir = tempfile::tempdir().unwrap();
            // Use an actual provider hint so fresh processes do not race the
            // ordinary one-second fallback cooldown near a wall-clock boundary.
            let primary = RetryTestServer::with_retry_after(vec![account_quota_error()], 60);
            let replies = (0..3).map(|index| {
                let mut output = Vec::new();
                if opaque {
                    output.push(json!({"type":"reasoning","id":format!("reasoning-{index}"),
                        "summary":[],"encrypted_content":format!("synthetic-state-{index}")}));
                }
                // Completed output must describe the complete layout, including
                // the assistant text already delivered by the delta event.
                output.push(json!({"type":"message","id":format!("message-{index}"),"role":"assistant",
                    "content":[{"type":"output_text","text":"Persisted backup answer"}]}));
                (200, format!(
                    "data: {}\n\ndata: {}\n\n",
                    json!({"type":"response.output_text.delta","delta":"Persisted backup answer"}),
                    json!({"type":"response.completed","response":{"id":format!("restart-response-{index}"),"model":"restart-served-snapshot","output":output,"usage":{"input_tokens":20,"output_tokens":5,"total_tokens":25}}}),
                ))
            }).collect();
            let backup = RetryTestServer::new(replies);
            let manifest = dir.path().join("restart-fixture.json");
            std::fs::write(
                &manifest,
                serde_json::to_vec(&json!({
                    "backupId":format!("codex-account-{}", uuid::Uuid::new_v4()),
                    "primaryUrl":primary.url,"backupUrl":backup.url,"opaque":opaque,
                }))
                .unwrap(),
            )
            .unwrap();
            let mut reports = Vec::new();
            for phase in ["seed", "resume", "replay"] {
                let mut command = openbitfun_services_core::process_manager::create_tokio_command(
                    std::env::current_exe().unwrap(),
                );
                command
                    .args([
                        "--ignored",
                        "--exact",
                        "agentic::execution::round_executor::tests::factory_restart_child",
                        "--nocapture",
                        "--test-threads=1",
                    ])
                    .env("OPENBITFUN_ACCOUNT_RESTART_FIXTURE", &manifest)
                    .env("OPENBITFUN_ACCOUNT_RESTART_PHASE", phase)
                    .env("OPENBITFUN_E2E_STORAGE_GUARD", "1")
                    .env("OPENBITFUN_E2E_USER_ROOT", dir.path().join("host"))
                    .env("OPENBITFUN_E2E_HOME", dir.path().join("home"))
                    .env_remove("OPENBITFUN_USER_ROOT")
                    .env_remove("OPENBITFUN_HOME")
                    .kill_on_drop(true);
                let output = tokio::time::timeout(Duration::from_secs(20), command.output())
                    .await
                    .expect("restart fixture child must terminate")
                    .unwrap();
                assert!(
                    output.status.success(),
                    "{phase} child failed:\n{}\n{}",
                    String::from_utf8_lossy(&output.stdout),
                    String::from_utf8_lossy(&output.stderr)
                );
                reports.push(
                    serde_json::from_slice::<serde_json::Value>(
                        &std::fs::read(dir.path().join(format!("report-{phase}.json"))).unwrap(),
                    )
                    .unwrap(),
                );
            }
            let pids: std::collections::HashSet<_> = reports
                .iter()
                .map(|report| report["pid"].as_u64().unwrap())
                .collect();
            assert_eq!(
                pids.len(),
                3,
                "each phase must have its own process globals and caches"
            );
            assert!(!pids.contains(&u64::from(std::process::id())));
            for report in &reports[1..] {
                assert_eq!(report["fingerprint"], reports[0]["fingerprint"]);
                assert_eq!(
                    report["credentialRevisions"],
                    reports[0]["credentialRevisions"]
                );
            }
            assert_eq!(reports[0]["records"], 2);
            assert_eq!(reports[1]["records"], 4);
            assert_eq!(reports[2]["records"], 4);
            assert_eq!(reports[2]["knownTokens"], 75);
            assert_eq!(reports[2]["unknownAttempts"], 1);
            assert_eq!(reports[1]["attemptIds"], reports[2]["attemptIds"]);
            assert_eq!(reports[0]["sessionModelId"], "restart-model");
            assert_eq!(reports[1]["sessionModelId"], reports[0]["sessionModelId"]);
            assert_eq!(reports[2]["sessionModelId"], reports[0]["sessionModelId"]);
            assert_eq!(reports[1]["workspaceId"], reports[0]["workspaceId"]);
            assert_eq!(reports[2]["workspaceId"], reports[0]["workspaceId"]);
            let initial_ids = reports[0]["nativeMessageIds"].as_array().unwrap();
            let resumed_ids = reports[1]["nativeMessageIds"].as_array().unwrap();
            assert_eq!(&resumed_ids[..initial_ids.len()], initial_ids);
            assert_eq!(
                reports[2]["nativeMessageIds"],
                reports[1]["nativeMessageIds"]
            );
            assert_eq!(reports[2]["nativeTurnIds"], reports[1]["nativeTurnIds"]);
            let a = primary.requests.lock().unwrap();
            let b = backup.requests.lock().unwrap();
            assert_eq!(
                a.len(),
                1,
                "A's cooldown must survive the first process exit"
            );
            assert_eq!(b.len(), 3);
            assert_eq!(a[0]["input"], b[0]["input"]);
            assert!(b[1]["input"]
                .as_array()
                .unwrap()
                .iter()
                .any(|item| item["role"] == "assistant"));
            assert!(
                b[2]["input"].as_array().unwrap().len() > b[1]["input"].as_array().unwrap().len()
            );
            assert_eq!(
                b[1]["input"]
                    .as_array()
                    .unwrap()
                    .iter()
                    .any(|item| item["encrypted_content"] == "synthetic-state-0"),
                opaque
            );
            assert_eq!(
                b[2]["input"]
                    .as_array()
                    .unwrap()
                    .iter()
                    .any(|item| item["encrypted_content"] == "synthetic-state-1"),
                opaque
            );
            assert!(backup
                .headers
                .lock()
                .unwrap()
                .iter()
                .all(
                    |headers| headers["authorization"] == "Bearer synthetic-restart-backup-seat"
                        && headers["chatgpt-account-id"] == "restart-backup-seat"
                ));
        }
    }

    /// Invoked by the parent acceptance test, never by an ordinary test run.
    #[cfg(feature = "subscription-auth")]
    #[tokio::test]
    #[ignore = "isolated subprocess fixture; run factory_backed_state_survives_three_independent_host_processes"]
    async fn factory_restart_child() {
        use crate::agentic::core::{SessionConfig, SessionState, TurnStats};
        use crate::agentic::persistence::PersistenceManager;
        use crate::agentic::session::{SessionContextStore, SessionManager, SessionManagerConfig};
        use crate::agentic::tools::pipeline::{ToolPipeline, ToolStateManager};
        use crate::agentic::tools::registry::ToolRegistry;
        use crate::infrastructure::ai::client_factory::AIClientFactory;
        use crate::infrastructure::subscription_auth::{self, store, StoredCredential};
        use crate::service::config::types::{
            model_runtime_binding_fingerprint, AIModelConfig, AuthConfig, SubscriptionProvider,
        };
        use crate::service::config::{ConfigManagerSettings, ConfigService};
        use crate::service::token_usage::{TimeRange, TokenUsageQuery, TokenUsageService};
        use openbitfun_services_core::token_usage::types::ModelRequestOutcome;
        let manifest_path = std::path::PathBuf::from(
            std::env::var_os("OPENBITFUN_ACCOUNT_RESTART_FIXTURE")
                .expect("only the restart parent may invoke this fixture"),
        );
        let root = manifest_path.parent().unwrap();
        let manifest: serde_json::Value =
            serde_json::from_slice(&std::fs::read(&manifest_path).unwrap()).unwrap();
        let phase = std::env::var("OPENBITFUN_ACCOUNT_RESTART_PHASE").unwrap();
        assert!(matches!(phase.as_str(), "seed" | "resume" | "replay"));
        let backup_id = manifest["backupId"].as_str().unwrap();
        let opaque = manifest["opaque"].as_bool().unwrap();
        store::set_store_path_and_file_vault_for_test(root.join("subscription.json"));
        if phase == "seed" {
            for (id, seat) in [
                ("codex", "restart-primary-seat"),
                (backup_id, "restart-backup-seat"),
            ] {
                store::upsert(
                    id,
                    StoredCredential::Oauth {
                        access: format!("synthetic-{seat}"),
                        refresh: "synthetic-refresh".into(),
                        expires: chrono::Utc::now().timestamp_millis() + 3_600_000,
                        account_id: Some(seat.into()),
                        metadata: None,
                    },
                )
                .await
                .unwrap();
            }
        }
        let accounts = subscription_auth::list_account_instances().await.unwrap();
        for (id, seat) in [
            ("codex", "restart-primary-seat"),
            (backup_id, "restart-backup-seat"),
        ] {
            let account = accounts
                .iter()
                .find(|account| account.account_id == id)
                .unwrap();
            assert!(account.account.connected && account.enabled);
            assert_eq!(account.upstream_account_id.as_deref(), Some(seat));
        }
        let revisions = [
            subscription_auth::account_credential_revision(
                subscription_auth::SubscriptionProvider::Codex,
                "codex",
            )
            .await
            .unwrap(),
            subscription_auth::account_credential_revision(
                subscription_auth::SubscriptionProvider::Codex,
                backup_id,
            )
            .await
            .unwrap(),
        ];
        let path_manager = Arc::new(
            crate::infrastructure::PathManager::with_user_root_for_tests(root.join("host")),
        );
        let config = Arc::new(
            ConfigService::with_settings(ConfigManagerSettings {
                path_manager: Some(path_manager.clone()),
                auto_save: true,
                backup_count: 0,
            })
            .await
            .unwrap(),
        );
        if phase == "seed" {
            config
                .set_config(
                    "ai.models",
                    vec![AIModelConfig {
                        id: "restart-model".into(),
                        name: "Restart mock".into(),
                        model_name: "restart-wire-model".into(),
                        provider: "responses".into(),
                        enabled: true,
                        base_url: "https://saved-route.invalid".into(),
                        auth: AuthConfig::SubscriptionPool {
                            provider: SubscriptionProvider::Codex,
                            accounts: vec!["codex".into(), backup_id.into()],
                            revision: 3,
                        },
                        ..Default::default()
                    }],
                )
                .await
                .unwrap();
            config
                .set_config("ai.default_models.primary", "restart-model")
                .await
                .unwrap();
        }
        let models: Vec<AIModelConfig> = config.get_config(Some("ai.models")).await.unwrap();
        let model = models
            .iter()
            .find(|model| model.id == "restart-model")
            .unwrap();
        assert_eq!(
            serde_json::to_value(&model.auth).unwrap(),
            json!({
                "type":"subscription_pool","provider":"codex","accounts":["codex",backup_id],"revision":3,
            })
        );
        assert_eq!(
            config
                .get_config::<String>(Some("ai.default_models.primary"))
                .await
                .unwrap(),
            model.id
        );
        let fingerprint = model_runtime_binding_fingerprint(model);
        crate::service::config::initialize_global_config()
            .await
            .unwrap();
        let global = crate::service::config::get_global_config_service()
            .await
            .unwrap();
        assert_eq!(global.user_data_dir().await, config.user_data_dir().await);
        let global_models: Vec<AIModelConfig> = global.get_config(Some("ai.models")).await.unwrap();
        assert_eq!(
            model_runtime_binding_fingerprint(
                global_models
                    .iter()
                    .find(|entry| entry.id == model.id)
                    .unwrap()
            ),
            fingerprint
        );
        let workspace = root.join("workspace");
        std::fs::create_dir_all(&workspace).unwrap();
        let workspace = dunce::canonicalize(workspace).unwrap();
        let workspaces = Arc::new(
            crate::service::workspace::WorkspaceService::new()
                .await
                .unwrap(),
        );
        crate::service::workspace::set_global_workspace_service(workspaces.clone());
        let workspace_record = if phase == "seed" {
            workspaces
                .register_local_workspace_record(workspace.clone())
                .await
                .unwrap()
        } else {
            workspaces
                .list_workspace_infos()
                .await
                .into_iter()
                .find(|record| record.root_path == workspace)
                .expect("restore the persisted workspace catalog")
        };
        let manager = SessionManager::new(
            Arc::new(SessionContextStore::new()),
            Arc::new(PersistenceManager::new(path_manager.clone()).unwrap()),
            SessionManagerConfig {
                enable_persistence: true,
                ..Default::default()
            },
        );
        let session = if phase == "seed" {
            manager
                .create_session_with_id(
                    Some("session-1".into()),
                    "Restart subscription session".into(),
                    "Standard".into(),
                    SessionConfig {
                        tool_presentation_mode: Default::default(),
                        workspace_path: Some(workspace.to_string_lossy().into_owned()),
                        workspace_id: Some(workspace_record.id.clone()),
                        model_id: Some(model.id.clone()),
                        prompt_cache_lineage_id: Some("persisted-lineage".into()),
                        ..Default::default()
                    },
                )
                .await
                .unwrap()
        } else {
            let (session, turns) = manager
                .restore_session_with_turns(&workspace, "session-1")
                .await
                .unwrap();
            assert_eq!(turns.len(), if phase == "resume" { 1 } else { 3 });
            assert!(turns
                .iter()
                .all(|turn| turn.has_final_response == Some(true)));
            session
        };
        assert_eq!(session.config.model_id.as_deref(), Some(model.id.as_str()));
        assert_eq!(
            session.config.workspace_id.as_deref(),
            Some(workspace_record.id.as_str())
        );
        assert_eq!(
            session.effective_prompt_cache_lineage_id(),
            "persisted-lineage"
        );
        let restored_messages = manager
            .get_context_messages(&session.session_id)
            .await
            .unwrap();
        assert_eq!(
            restored_messages.len(),
            match phase.as_str() {
                "seed" => 0,
                "resume" => 2,
                _ => 6,
            }
        );
        let replays: Vec<_> = restored_messages
            .iter()
            .filter_map(|message| message.metadata.model_response_replay.as_ref())
            .collect();
        assert_eq!(
            replays.len(),
            if opaque {
                restored_messages.len() / 2
            } else {
                0
            }
        );
        for (index, replay) in replays.into_iter().enumerate() {
            assert_eq!(
                replay.account_origin.as_ref().unwrap(),
                &openbitfun_core_types::ModelAccountOrigin {
                    provider: "codex".into(),
                    account_id: backup_id.into(),
                    upstream_account_id: Some("restart-backup-seat".into()),
                }
            );
            assert!(replay.items.iter().any(|item| matches!(item,
                openbitfun_core_types::ModelResponseReplayItem::OpaqueReasoning { opaque_state, .. }
                    if opaque_state == &format!("synthetic-state-{index}"))));
        }
        if phase != "seed" {
            let directory = config.user_data_dir().await.join("subscription-routing");
            let mut files = tokio::fs::read_dir(directory.join("affinity"))
                .await
                .unwrap();
            let mut restored_binding = false;
            while let Some(file) = files.next_entry().await.unwrap() {
                if file
                    .path()
                    .extension()
                    .is_some_and(|extension| extension == "json")
                {
                    let value: serde_json::Value =
                        serde_json::from_slice(&tokio::fs::read(file.path()).await.unwrap())
                            .unwrap();
                    restored_binding |= value["binding"]["resource_key"] == backup_id
                        && value["binding"]["revision"] == revisions[1];
                }
            }
            assert!(
                restored_binding,
                "a prior process must have persisted B's exact affinity"
            );
        }
        let ledger = Arc::new(TokenUsageService::new(path_manager).await.unwrap());
        crate::service::token_usage::set_global_token_usage_service(ledger.clone());
        let query = || TokenUsageQuery {
            model_id: None,
            session_id: None,
            time_range: TimeRange::All,
            time_zone: None,
            limit: None,
            offset: None,
            include_subagent: true,
        };
        let before = ledger.query_records(query()).await.unwrap();
        assert_eq!(
            before.len(),
            match phase.as_str() {
                "seed" => 0,
                "resume" => 2,
                _ => 4,
            }
        );
        if phase == "replay" {
            // A restarted event consumer delivers each persisted attempt again.
            // Frozen attempt identity must prevent recounting across processes.
            for record in &before {
                ledger
                    .record_usage(
                        record.model_config_id.clone(),
                        record.effective_model_name.clone(),
                        record.session_id.clone(),
                        record.turn_id.clone(),
                        record.input_tokens,
                        record.output_tokens,
                        record
                            .cached_tokens_available
                            .then_some(record.cached_tokens),
                        record.token_details.clone(),
                        record.is_subagent,
                    )
                    .await
                    .unwrap();
            }
        } else {
            let factory = Arc::new(AIClientFactory::new_for_test(config.clone()));
            let event_queue = Arc::new(EventQueue::new(EventQueueConfig::default()));
            let pipeline = Arc::new(ToolPipeline::new(
                Arc::new(tokio::sync::RwLock::new(ToolRegistry::new())),
                Arc::new(ToolStateManager::new(event_queue.clone())),
                None,
            ));
            // Use the production constructor and host-installed service, with
            // no test assignment to the executor's private ledger field.
            let executor = RoundExecutor::new(
                Arc::new(StreamProcessor::new(event_queue.clone())),
                event_queue,
                pipeline,
            );
            let lineages = if phase == "seed" {
                vec![session.effective_prompt_cache_lineage_id()]
            } else {
                vec![
                    session.effective_prompt_cache_lineage_id(),
                    "fresh-lineage-after-restart",
                ]
            };
            for (index, lineage) in lineages.into_iter().enumerate() {
                let (client, source) = factory
                    .prepare_native_model_client(&model.id, &fingerprint, None, Some(lineage), None)
                    .await
                    .unwrap();
                let selected = source
                    .as_ref()
                    .unwrap()
                    .resolve_for_request(&[], None, Some(lineage))
                    .await
                    .unwrap()
                    .unwrap();
                assert_eq!(
                    selected.origin.account_id,
                    if phase == "seed" { "codex" } else { backup_id }
                );
                let source = Arc::new(FactoryFixtureSource {
                    inner: source.unwrap(),
                    concurrent_refresh: None,
                    urls: HashMap::from([
                        (
                            "codex".into(),
                            manifest["primaryUrl"].as_str().unwrap().into(),
                        ),
                        (
                            backup_id.into(),
                            manifest["backupUrl"].as_str().unwrap().into(),
                        ),
                    ]),
                });
                let turn_id = manager
                    .start_dialog_turn(
                        &session.session_id,
                        "Standard".into(),
                        format!("Continue {phase}-{index}"),
                        Some(format!("turn-{phase}-{index}")),
                        None,
                        None,
                    )
                    .await
                    .unwrap();
                let history = manager
                    .get_context_messages(&session.session_id)
                    .await
                    .unwrap()
                    .iter()
                    .map(super::AIMessage::from)
                    .collect();
                let mut context = test_round_context();
                context.model_config_id = model.id.clone();
                context.effective_model_name = model.model_name.clone();
                context.dialog_turn_id = turn_id.clone();
                context.turn_index = manager
                    .get_session(&session.session_id)
                    .unwrap()
                    .dialog_turn_ids
                    .len()
                    - 1;
                context.model_request_context.prompt_cache_route_key = Some(lineage.into());
                context.account_client_source = Some(source);
                let mut lifecycle = ModelRoundLifecycle::new();
                let result = executor
                    .execute_round_with_lifecycle(
                        client,
                        context,
                        history,
                        None,
                        None,
                        &mut lifecycle,
                        Some(&manager),
                        None,
                    )
                    .await
                    .unwrap();
                assert!(result.tool_calls.is_empty());
                let message: super::AIMessage = result.assistant_message.clone().into();
                assert_eq!(message.content.as_deref(), Some("Persisted backup answer"));
                if !result.assistant_message_committed {
                    manager
                        .add_message(&session.session_id, result.assistant_message.clone())
                        .await
                        .unwrap();
                }
                let usage = result.usage.as_ref().unwrap();
                manager
                    .complete_dialog_turn(
                        &session.session_id,
                        &turn_id,
                        message.content.unwrap(),
                        &[result.assistant_message],
                        TurnStats {
                            total_rounds: 1,
                            total_tools: 0,
                            total_tokens: (usage.prompt_token_count + usage.candidates_token_count)
                                as usize,
                            duration_ms: 0,
                        },
                        Some("complete".into()),
                        Some(true),
                    )
                    .await
                    .unwrap();
                // History completion and processing-state settlement have
                // separate owners, just as in Scheduler's successful finish.
                assert!(manager
                    .update_session_state_for_turn_if_processing(
                        &session.session_id,
                        &turn_id,
                        SessionState::Idle,
                    )
                    .await
                    .unwrap());
            }
        }
        let native_history = manager
            .get_context_messages(&session.session_id)
            .await
            .unwrap();
        assert_eq!(native_history.len(), if phase == "seed" { 2 } else { 6 });
        let native_session = manager.get_session(&session.session_id).unwrap();
        assert!(matches!(native_session.state, SessionState::Idle));
        let (persisted_session, persisted_turns) = manager
            .persistence_manager()
            .load_session_with_turns(&workspace, &session.session_id)
            .await
            .unwrap();
        assert!(matches!(persisted_session.state, SessionState::Idle));
        assert_eq!(
            persisted_session.config.model_id,
            native_session.config.model_id
        );
        assert_eq!(
            persisted_session.config.workspace_id,
            native_session.config.workspace_id
        );
        assert_eq!(
            persisted_session.dialog_turn_ids,
            native_session.dialog_turn_ids
        );
        assert_eq!(persisted_turns.len(), if phase == "seed" { 1 } else { 3 });
        assert!(persisted_turns
            .iter()
            .all(|turn| turn.has_final_response == Some(true)
                && turn.model_rounds.len() == 1
                && turn.model_rounds[0].text_items.len() == 1
                && turn.model_rounds[0].text_items[0].content == "Persisted backup answer"));
        let records = ledger.query_records(query()).await.unwrap();
        let expected = if phase == "seed" { 2 } else { 4 };
        assert_eq!(records.len(), expected);
        assert_eq!(
            records
                .iter()
                .filter(|record| !record.usage_is_known())
                .count(),
            1
        );
        let mut attempt_ids: Vec<_> = records
            .iter()
            .map(|record| record.request_context().unwrap().attempt_id)
            .collect();
        attempt_ids.sort();
        assert_eq!(
            attempt_ids
                .iter()
                .collect::<std::collections::HashSet<_>>()
                .len(),
            expected
        );
        for record in &records {
            let attempt = record.request_context().unwrap();
            let failed = attempt.outcome == ModelRequestOutcome::Failed;
            assert_eq!(
                attempt.account.unwrap().account_id,
                if failed { "codex" } else { backup_id }
            );
            assert_eq!(record.usage_is_known(), !failed);
            assert_eq!(attempt.requested_model, "restart-wire-model");
            assert_eq!(attempt.policy_revision, Some(3));
        }
        std::fs::write(root.join(format!("report-{phase}.json")), serde_json::to_vec(&json!({
            "pid":std::process::id(),"fingerprint":fingerprint,"credentialRevisions":revisions,
            "nativeMessageIds":native_history.iter().map(|message| &message.id).collect::<Vec<_>>(),
            "nativeTurnIds":native_session.dialog_turn_ids,"sessionModelId":native_session.config.model_id,
            "workspaceId":workspace_record.id,
            "records":records.len(),"attemptIds":attempt_ids,
            "knownTokens":records.iter().filter(|record| record.usage_is_known()).map(|record| record.total_tokens).sum::<u32>(),
            "unknownAttempts":records.iter().filter(|record| !record.usage_is_known()).count(),
        })).unwrap()).unwrap();
    }

    #[cfg(feature = "subscription-auth")]
    #[tokio::test]
    async fn factory_backed_cancellation_releases_stream_without_cooldown_and_observes_revocation()
    {
        use crate::infrastructure::ai::client_factory::{
            AIClientFactory, SUBSCRIPTION_STORE_TEST_LOCK,
        };
        use crate::infrastructure::subscription_auth::{self, store, StoredCredential};
        use crate::service::config::types::{
            model_runtime_binding_fingerprint, AIModelConfig, AuthConfig, SubscriptionProvider,
        };
        use crate::service::config::{ConfigManagerSettings, ConfigService};
        use crate::service::token_usage::{TimeRange, TokenUsageQuery, TokenUsageService};
        use openbitfun_services_core::token_usage::types::ModelRequestOutcome;
        use std::sync::atomic::Ordering;

        let _guard = SUBSCRIPTION_STORE_TEST_LOCK.lock().await;
        for partial_output in [false, true] {
            for logout in [false, true] {
                let dir = tempfile::tempdir().unwrap();
                subscription_auth::set_store_path_for_test(dir.path().join("subscription.json"));
                let backup_id = format!("codex-account-{}", uuid::Uuid::new_v4());
                for (id, seat) in [("codex", "primary-seat"), (&backup_id, "backup-seat")] {
                    store::upsert(
                        id,
                        StoredCredential::Oauth {
                            access: format!("synthetic-{seat}"),
                            refresh: "synthetic-refresh".into(),
                            expires: chrono::Utc::now().timestamp_millis() + 3_600_000,
                            account_id: Some(seat.into()),
                            metadata: None,
                        },
                    )
                    .await
                    .unwrap();
                }
                let config = Arc::new(
                    ConfigService::with_settings(ConfigManagerSettings {
                        path_manager: Some(Arc::new(
                            crate::infrastructure::PathManager::with_user_root_for_tests(
                                dir.path().join("host"),
                            ),
                        )),
                        auto_save: true,
                        backup_count: 0,
                    })
                    .await
                    .unwrap(),
                );
                let model = AIModelConfig {
                    id: "cancellation-model".into(),
                    model_name: "fixture-model".into(),
                    provider: "responses".into(),
                    enabled: true,
                    base_url: "https://saved-route.invalid".into(),
                    auth: AuthConfig::SubscriptionPool {
                        provider: SubscriptionProvider::Codex,
                        accounts: vec!["codex".into(), backup_id.clone()],
                        revision: 1,
                    },
                    ..Default::default()
                };
                config
                    .install_runtime_ai_model(model.clone())
                    .await
                    .unwrap();
                let factory = Arc::new(AIClientFactory::new_for_test(config.clone()));
                let (client, source) = factory
                    .prepare_native_model_client(
                        &model.id,
                        &model_runtime_binding_fingerprint(&model),
                        None,
                        Some("cancel-lineage"),
                        None,
                    )
                    .await
                    .unwrap();
                let mut events = vec![
                    json!({"type":"response.created","response":{"id":"cancel-fixture","model":"primary-snapshot"}}),
                ];
                if partial_output {
                    events
                        .push(json!({"type":"response.output_text.delta","delta":"Partial text"}));
                }
                let primary = RetryTestServer::with_open_stream(
                    vec![(
                        200,
                        events
                            .iter()
                            .map(|event| format!("data: {event}\n\n"))
                            .collect(),
                    )],
                    true,
                );
                let backup = RetryTestServer::new(vec![(
                    200,
                    format!(
                        "data: {}\n\ndata: {}\n\n",
                        json!({"type":"response.output_text.delta","delta":"Backup finished"}),
                        json!({"type":"response.completed","response":{"id":"backup-fixture","model":"backup-snapshot","output":[],"usage":{"input_tokens":3,"output_tokens":2,"total_tokens":5}}}),
                    ),
                )]);
                let source = Arc::new(FactoryFixtureSource {
                    inner: source.unwrap(),
                    concurrent_refresh: None,
                    urls: HashMap::from([
                        ("codex".into(), primary.url.clone()),
                        (backup_id.clone(), backup.url.clone()),
                    ]),
                });
                let ledger_dir = dir.path().join("ledger");
                let ledger = Arc::new(
                    TokenUsageService::new_in_base_dir(ledger_dir.clone())
                        .await
                        .unwrap(),
                );
                let mut executor = test_round_executor();
                executor.usage_service = Some(ledger.clone());
                let cancel = CancellationToken::new();
                executor.register_cancel_token("turn-1", cancel.clone());
                let mut context = test_round_context();
                context.model_config_id = model.id.clone();
                context.effective_model_name = model.model_name.clone();
                context.model_request_context.prompt_cache_route_key =
                    Some("cancel-lineage".into());
                context.account_client_source = Some(source.clone());
                let mut lifecycle = ModelRoundLifecycle::new();
                let execution = executor.execute_round_with_lifecycle(
                    client.clone(),
                    context.clone(),
                    vec![super::AIMessage::user("Wait for cancellation".into())],
                    None,
                    None,
                    &mut lifecycle,
                    None,
                    None,
                );
                let observe = async {
                    let mut events = Vec::new();
                    loop {
                        events.extend(executor.event_queue.dequeue_batch(100).await);
                        let output = events
                            .iter()
                            .any(|event| matches!(event.event, AgenticEvent::TextChunk { .. }));
                        if (partial_output && output)
                            || (!partial_output
                                && primary.opened_streams.load(Ordering::SeqCst) == 1)
                        {
                            cancel.cancel();
                            break events;
                        }
                        tokio::time::sleep(Duration::from_millis(5)).await;
                    }
                };
                let (result, mut events) = tokio::time::timeout(Duration::from_secs(5), async {
                    tokio::join!(execution, observe)
                })
                .await
                .expect("cancellation must stop an open account stream");
                assert!(matches!(result, Err(OpenBitFunError::Cancelled(_))));
                assert_eq!(lifecycle.attempts_started(), 1);
                events.extend(executor.event_queue.dequeue_batch(100).await);
                assert!(!events.iter().any(|event| matches!(
                    event.event,
                    AgenticEvent::ModelRoundAttemptSuperseded { .. }
                        | AgenticEvent::TokenUsageUpdated { .. }
                )));
                assert!(backup.requests.lock().unwrap().is_empty());
                tokio::time::timeout(Duration::from_secs(5), async {
                    while primary.disconnected.load(Ordering::SeqCst) != 1 {
                        tokio::time::sleep(Duration::from_millis(5)).await;
                    }
                })
                .await
                .expect("cancelled HTTP stream must release its socket");
                let routing = config.user_data_dir().await.join("subscription-routing");
                for kind in ["affinity", "cooldown"] {
                    let mut files = match tokio::fs::read_dir(routing.join(kind)).await {
                        Ok(files) => files,
                        Err(error) if error.kind() == std::io::ErrorKind::NotFound => continue,
                        Err(error) => panic!("read fixture routing state: {error}"),
                    };
                    while let Some(file) = files.next_entry().await.unwrap() {
                        assert_ne!(
                            file.path()
                                .extension()
                                .and_then(|extension| extension.to_str()),
                            Some("json"),
                            "cancellation must not persist {kind}"
                        );
                    }
                }
                // Revoke after cancellation, then reuse the existing factory and
                // source: neither its prepared preference nor cache may revive A.
                if logout {
                    subscription_auth::logout_account(
                        subscription_auth::SubscriptionProvider::Codex,
                        "codex",
                    )
                    .await
                    .unwrap();
                } else {
                    subscription_auth::set_account_instance_enabled(
                        subscription_auth::SubscriptionProvider::Codex,
                        "codex",
                        false,
                    )
                    .await
                    .unwrap();
                }
                context.dialog_turn_id = "turn-2".into();
                let completed = tokio::time::timeout(
                    Duration::from_secs(5),
                    executor.execute_round(
                        client,
                        context,
                        vec![super::AIMessage::user("Start a fresh request".into())],
                        None,
                        None,
                    ),
                )
                .await
                .unwrap()
                .unwrap();
                let message: super::AIMessage = completed.assistant_message.into();
                assert_eq!(message.content.as_deref(), Some("Backup finished"));
                assert_eq!(primary.requests.lock().unwrap().len(), 1);
                assert_eq!(backup.requests.lock().unwrap().len(), 1);
                assert_eq!(
                    primary.headers.lock().unwrap()[0]["chatgpt-account-id"],
                    "primary-seat"
                );
                assert_eq!(
                    backup.headers.lock().unwrap()[0]["chatgpt-account-id"],
                    "backup-seat"
                );
                // Cancellation submits an owned ledger writer. Wait for its
                // commit, then reopen the authority to exclude cached evidence.
                let query = || TokenUsageQuery {
                    model_id: None,
                    session_id: None,
                    time_range: TimeRange::All,
                    time_zone: None,
                    limit: None,
                    offset: None,
                    include_subagent: true,
                };
                tokio::time::timeout(Duration::from_secs(5), async {
                    while ledger.query_records(query()).await.unwrap().len() != 2 {
                        tokio::time::sleep(Duration::from_millis(5)).await;
                    }
                })
                .await
                .unwrap();
                let reopened = TokenUsageService::new_in_base_dir(ledger_dir)
                    .await
                    .unwrap();
                let records = reopened.query_records(query()).await.unwrap();
                assert_eq!(records.len(), 2);
                let cancelled = records
                    .iter()
                    .find(|record| {
                        record.request_context().unwrap().outcome == ModelRequestOutcome::Cancelled
                    })
                    .unwrap();
                let attempt = cancelled.request_context().unwrap();
                assert_eq!(attempt.account.unwrap().account_id, "codex");
                assert_eq!(attempt.attempt_index, 1);
                assert!(attempt.retry_reason.is_none());
                assert!(!cancelled.usage_is_known());
                let success = records
                    .iter()
                    .find(|record| {
                        record.request_context().unwrap().outcome == ModelRequestOutcome::Completed
                    })
                    .unwrap();
                assert_eq!(
                    success
                        .request_context()
                        .unwrap()
                        .account
                        .unwrap()
                        .account_id,
                    backup_id
                );
                assert_eq!(success.total_tokens, 5);
                assert!(success.usage_is_known());
                assert_eq!(
                    records
                        .iter()
                        .map(|record| record.total_tokens)
                        .sum::<u32>(),
                    5
                );
            }
        }
    }

    #[cfg(feature = "subscription-auth")]
    #[tokio::test]
    async fn factory_backed_conversation_switches_once_commits_tool_once_and_resumes_with_recorded_accounts(
    ) {
        use crate::agentic::persistence::PersistenceManager;
        use crate::agentic::session::{SessionContextStore, SessionManager, SessionManagerConfig};
        use crate::agentic::tools::pipeline::{ToolPipeline, ToolStateManager};
        use crate::agentic::tools::registry::ToolRegistry;
        use crate::infrastructure::ai::client_factory::{
            AIClientFactory, SUBSCRIPTION_STORE_TEST_LOCK,
        };
        use crate::infrastructure::subscription_auth::{self, store, StoredCredential};
        use crate::service::config::types::{
            model_runtime_binding_fingerprint, AIModelConfig, AuthConfig, SubscriptionProvider,
        };
        use crate::service::config::{ConfigManagerSettings, ConfigService};
        use crate::service::token_usage::{TimeRange, TokenUsageQuery, TokenUsageService};
        use openbitfun_runtime_ports::PermissionMode;
        use std::sync::atomic::{AtomicUsize, Ordering};
        let _guard = SUBSCRIPTION_STORE_TEST_LOCK.lock().await;
        let dir = tempfile::tempdir().unwrap();
        subscription_auth::set_store_path_for_test(dir.path().join("subscription.json"));
        let backup_id = format!("codex-account-{}", uuid::Uuid::new_v4());
        for (id, seat) in [
            ("codex", "primary-seat"),
            (backup_id.as_str(), "backup-seat"),
        ] {
            store::upsert(
                id,
                StoredCredential::Oauth {
                    access: format!("synthetic-{seat}"),
                    refresh: "synthetic-refresh".into(),
                    expires: chrono::Utc::now().timestamp_millis() + 3_600_000,
                    account_id: Some(seat.into()),
                    metadata: None,
                },
            )
            .await
            .unwrap();
        }
        let path_manager = Arc::new(
            crate::infrastructure::PathManager::with_user_root_for_tests(dir.path().join("host")),
        );
        let settings = ConfigManagerSettings {
            path_manager: Some(path_manager.clone()),
            auto_save: true,
            backup_count: 0,
        };
        let config = Arc::new(
            ConfigService::with_settings(settings.clone())
                .await
                .unwrap(),
        );
        let model = AIModelConfig {
            id: "acceptance-model".into(),
            name: "Mock subscription acceptance".into(),
            model_name: "fixture-model".into(),
            provider: "responses".into(),
            enabled: true,
            base_url: "https://saved-route.invalid".into(),
            auth: AuthConfig::SubscriptionPool {
                provider: SubscriptionProvider::Codex,
                accounts: vec!["codex".into(), backup_id.clone()],
                revision: 1,
            },
            ..Default::default()
        };
        config
            .set_config("ai.models", vec![model.clone()])
            .await
            .unwrap();
        let saved: Vec<AIModelConfig> = config.get_config(Some("ai.models")).await.unwrap();
        let model = saved
            .into_iter()
            .find(|saved| saved.id == model.id)
            .unwrap();
        let fingerprint = model_runtime_binding_fingerprint(&model);
        let sse = |events: Vec<serde_json::Value>| {
            (
                200,
                events
                    .into_iter()
                    .map(|event| format!("data: {event}\n\n"))
                    .collect::<String>(),
            )
        };
        let tool_reply = |name: &str, call: &str, response_id: &str| {
            let item = json!({"type":"function_call","id":format!("item-{call}"),"call_id":call,"name":name,"arguments":"{}"});
            sse(vec![
                json!({"type":"response.output_item.added","output_index":0,"item":item}),
                json!({"type":"response.function_call_arguments.delta","output_index":0,"delta":"{}"}),
                json!({"type":"response.output_item.done","output_index":0,"item":item}),
                json!({"type":"response.completed","response":{"id":response_id,"model":"served-fixture-snapshot","output":[item],"usage":{"input_tokens":20,"output_tokens":8,"total_tokens":28}}}),
            ])
        };
        let text_reply = |text: &str, response_id: &str| {
            sse(vec![
                json!({"type":"response.output_text.delta","delta":text}),
                json!({"type":"response.completed","response":{"id":response_id,"model":"served-fixture-snapshot","output":[],"usage":{"input_tokens":20,"output_tokens":5,"total_tokens":25}}}),
            ])
        };
        let primary = RetryTestServer::new(vec![
            tool_reply("AcceptanceRead", "read-once", "read-response"),
            text_reply("Read completed; seed-value is available", "first-turn"),
            account_quota_error(),
        ]);
        let backup = RetryTestServer::new(vec![
            tool_reply("AcceptanceCommit", "commit-once", "commit-response"),
            text_reply("Committed fixture-checksum; commit count=1", "final-turn"),
        ]);
        let urls = HashMap::from([
            ("codex".into(), primary.url.clone()),
            (backup_id.clone(), backup.url.clone()),
        ]);
        let factory = Arc::new(AIClientFactory::new_for_test(config));
        let (client, source) = factory
            .prepare_native_model_client(
                &model.id,
                &fingerprint,
                None,
                Some("acceptance-lineage"),
                None,
            )
            .await
            .unwrap();
        let source = Arc::new(FactoryFixtureSource {
            inner: source.unwrap(),
            concurrent_refresh: None,
            urls: urls.clone(),
        });
        let context_store = Arc::new(SessionContextStore::new());
        let manager = SessionManager::new(
            context_store.clone(),
            Arc::new(PersistenceManager::new(path_manager).unwrap()),
            SessionManagerConfig {
                enable_persistence: false,
                ..Default::default()
            },
        );
        let ledger_dir = dir.path().join("ledger");
        let ledger = Arc::new(
            TokenUsageService::new_in_base_dir(ledger_dir.clone())
                .await
                .unwrap(),
        );
        let marker = dir.path().join("mutation-proof.txt");
        std::fs::write(&marker, b"seed-value\n").unwrap();
        let reads = Arc::new(AtomicUsize::new(0));
        let commits = Arc::new(AtomicUsize::new(0));
        let mut registry = ToolRegistry::new();
        for (mutates, calls, expected_account) in [
            (false, reads.clone(), "codex".to_string()),
            (true, commits.clone(), backup_id.clone()),
        ] {
            registry.register_tool(Arc::new(AcceptanceFixtureTool {
                mutates,
                path: marker.clone(),
                calls,
                context_store: context_store.clone(),
                expected_account,
                ledger: ledger.clone(),
            }));
        }
        let mut executor = test_round_executor();
        executor.usage_service = Some(ledger.clone());
        executor.tool_pipeline = Some(Arc::new(ToolPipeline::new(
            Arc::new(tokio::sync::RwLock::new(registry)),
            Arc::new(ToolStateManager::new(executor.event_queue.clone())),
            None,
        )));
        let tools = ["AcceptanceRead", "AcceptanceCommit"]
            .map(|name| openbitfun_core_types::ToolDefinition {
                name: name.into(),
                description: "Isolated fixture".into(),
                parameters: json!({"type":"object","properties":{},"additionalProperties":false}),
            })
            .to_vec();
        let mut context = test_round_context();
        context.model_config_id = model.id.clone();
        context.effective_model_name = model.model_name.clone();
        context.primary_model_facts = tool_runtime::context::PrimaryModelFacts::new(
            &model.id,
            &model.model_name,
            &model.provider,
            true,
        );
        context.model_request_context.prompt_cache_route_key = Some("acceptance-lineage".into());
        context.workspace = Some(crate::agentic::WorkspaceBinding::new(
            Some("acceptance-workspace".into()),
            dir.path().to_path_buf(),
        ));
        context.available_tools = tools.iter().map(|tool| tool.name.clone()).collect();
        context.context_vars.insert(
            PERMISSION_MODE_CONTEXT_KEY.into(),
            PermissionMode::FullAccess.as_str().into(),
        );
        context.account_client_source = Some(source);
        manager
            .add_message(
                "session-1",
                crate::agentic::core::Message::user("Read the fixture first".into()),
            )
            .await
            .unwrap();
        // The first turn executes one read tool on A and produces a completed
        // answer; the next turn fails over to B and executes one mutation.
        for stage in 0..3 {
            if stage == 2 {
                context.dialog_turn_id = "turn-2".into();
                context.turn_index = 1;
                context.round_number = 0;
                manager
                    .add_message(
                        "session-1",
                        crate::agentic::core::Message::user(
                            "Commit once using the completed read result".into(),
                        ),
                    )
                    .await
                    .unwrap();
            } else {
                context.round_number = stage;
            }
            let messages = context_store
                .get_context_messages("session-1")
                .iter()
                .map(super::AIMessage::from)
                .collect();
            let mut lifecycle = ModelRoundLifecycle::new();
            let result = tokio::time::timeout(
                Duration::from_secs(15),
                executor.execute_round_with_lifecycle(
                    client.clone(),
                    context.clone(),
                    messages,
                    Some(tools.clone()),
                    None,
                    &mut lifecycle,
                    Some(&manager),
                    None,
                ),
            )
            .await
            .unwrap()
            .unwrap();
            assert_eq!(result.assistant_message_committed, stage != 1);
            if !result.assistant_message_committed {
                // Mirror ExecutionEngine's normal text-only commit path.
                manager
                    .add_message("session-1", result.assistant_message.clone())
                    .await
                    .unwrap();
            }
            assert_eq!(lifecycle.attempts_started(), if stage == 2 { 2 } else { 1 });
            assert_eq!(result.tool_result_messages.len(), usize::from(stage != 1));
            for output in result.tool_result_messages {
                if let crate::agentic::core::message::MessageContent::ToolResult {
                    is_error,
                    result,
                    ..
                } = &output.content
                {
                    assert!(
                        !is_error,
                        "acceptance fixture tool failed at stage {stage}: {result}"
                    );
                }
                manager.add_message("session-1", output).await.unwrap();
            }
            if stage == 1 {
                assert_eq!(commits.load(Ordering::SeqCst), 0);
            }
        }
        assert_eq!(reads.load(Ordering::SeqCst), 1);
        assert_eq!(commits.load(Ordering::SeqCst), 1);
        assert_eq!(
            std::fs::read_to_string(&marker).unwrap(),
            "seed-value\ncommitted-once\n"
        );
        // Re-open saved model policy, routing preferences and usage authority.
        // Replay the full persisted message shape through the normal converter.
        let history_path = dir.path().join("history.json");
        std::fs::write(
            &history_path,
            serde_json::to_vec(&context_store.get_context_messages("session-1")).unwrap(),
        )
        .unwrap();
        let restored_messages: Vec<crate::agentic::core::Message> =
            serde_json::from_slice(&std::fs::read(&history_path).unwrap()).unwrap();
        let reloaded = Arc::new(ConfigService::with_settings(settings).await.unwrap());
        let restored_models: Vec<AIModelConfig> =
            reloaded.get_config(Some("ai.models")).await.unwrap();
        let restored_model = restored_models
            .iter()
            .find(|restored| restored.id == model.id)
            .unwrap();
        assert_eq!(
            serde_json::to_value(&restored_model.auth).unwrap(),
            serde_json::to_value(&model.auth).unwrap()
        );
        assert_eq!(
            model_runtime_binding_fingerprint(restored_model),
            fingerprint
        );
        let restarted = Arc::new(AIClientFactory::new_for_test(reloaded));
        let (client, source) = restarted
            .prepare_native_model_client(
                &model.id,
                &fingerprint,
                None,
                Some("acceptance-lineage"),
                None,
            )
            .await
            .unwrap();
        assert_eq!(
            client
                .subscription_account_origin(&backup_id)
                .unwrap()
                .account_id,
            backup_id
        );
        context.account_client_source = Some(Arc::new(FactoryFixtureSource {
            inner: source.unwrap(),
            concurrent_refresh: None,
            urls,
        }));
        context.round_number = 1;
        let restored_ledger = Arc::new(
            TokenUsageService::new_in_base_dir(ledger_dir)
                .await
                .unwrap(),
        );
        executor.usage_service = Some(restored_ledger.clone());
        let final_round = tokio::time::timeout(
            Duration::from_secs(15),
            executor.execute_round(
                client,
                context,
                restored_messages
                    .iter()
                    .map(super::AIMessage::from)
                    .collect(),
                Some(tools),
                None,
            ),
        )
        .await
        .unwrap()
        .unwrap();
        assert!(final_round.had_assistant_text && final_round.tool_calls.is_empty());
        let final_message: super::AIMessage = final_round.assistant_message.into();
        assert!(final_message.content.unwrap().contains("commit count=1"));
        assert_eq!(reads.load(Ordering::SeqCst), 1);
        assert_eq!(commits.load(Ordering::SeqCst), 1);
        assert_eq!(
            std::fs::read_to_string(&marker).unwrap(),
            "seed-value\ncommitted-once\n"
        );
        {
            let a_sent = primary.requests.lock().unwrap();
            let b_sent = backup.requests.lock().unwrap();
            assert_eq!(a_sent.len(), 3);
            assert_eq!(b_sent.len(), 2);
            assert_eq!(
                a_sent[2]["input"], b_sent[0]["input"],
                "fallback must preserve the completed first turn and read result"
            );
            let input = b_sent[1]["input"].as_array().unwrap();
            assert_eq!(
                input
                    .iter()
                    .filter(|item| item["type"] == "function_call")
                    .count(),
                2
            );
            assert_eq!(
                input
                    .iter()
                    .filter(|item| item["type"] == "function_call_output")
                    .count(),
                2
            );
            assert!(input.iter().any(|item| item["call_id"] == "commit-once"
                && item["output"]
                    .as_str()
                    .is_some_and(|output| output.contains("commit=fixture-checksum; count=1"))));
            let primary_headers = primary.headers.lock().unwrap();
            let backup_headers = backup.headers.lock().unwrap();
            assert!(primary_headers
                .iter()
                .all(
                    |headers| headers["authorization"] == "Bearer synthetic-primary-seat"
                        && headers["chatgpt-account-id"] == "primary-seat"
                ));
            assert!(backup_headers.iter().all(|headers| headers["authorization"]
                == "Bearer synthetic-backup-seat"
                && headers["chatgpt-account-id"] == "backup-seat"));
        }
        let events = executor.event_queue.dequeue_batch(1000).await;
        let usages: Vec<_> = events
            .iter()
            .filter_map(|event| match &event.event {
                AgenticEvent::TokenUsageUpdated { total_tokens, .. } => Some(*total_tokens),
                _ => None,
            })
            .collect();
        assert_eq!(
            usages.len(),
            4,
            "only the four known observations emit context usage"
        );
        assert_eq!(usages.iter().sum::<usize>(), 106);
        let records = restored_ledger
            .query_records(TokenUsageQuery {
                model_id: None,
                session_id: None,
                time_range: TimeRange::All,
                time_zone: None,
                limit: None,
                offset: None,
                include_subagent: true,
            })
            .await
            .unwrap();
        assert_eq!(records.len(), 5);
        assert_eq!(
            records
                .iter()
                .filter(|record| !record.usage_is_known())
                .count(),
            1
        );
        assert_eq!(
            records
                .iter()
                .filter(|record| record
                    .request_context()
                    .unwrap()
                    .account
                    .unwrap()
                    .account_id
                    == "codex")
                .count(),
            3
        );
        assert_eq!(
            records
                .iter()
                .filter(|record| record
                    .request_context()
                    .unwrap()
                    .account
                    .unwrap()
                    .account_id
                    == backup_id)
                .count(),
            2
        );
        assert_eq!(
            records
                .iter()
                .map(|record| u64::from(record.total_tokens))
                .sum::<u64>(),
            106
        );
        assert_eq!(
            records
                .iter()
                .filter(|record| record.request_context().unwrap().outcome
                    == openbitfun_services_core::token_usage::types::ModelRequestOutcome::Failed)
                .count(),
            1
        );
        assert!(records
            .iter()
            .all(|record| record.request_context().unwrap().requested_model == "fixture-model"));
    }

    struct TestAccountSource {
        policy: openbitfun_agent_runtime::account_routing::AccountPolicy,
        clients: Vec<(
            openbitfun_core_types::ModelAccountOrigin,
            Arc<crate::infrastructure::ai::AIClient>,
        )>,
        accepted: std::sync::Mutex<Vec<String>>,
        routing_failures: std::sync::Mutex<Vec<(String, u64, i64)>>,
        routing_completions: std::sync::Mutex<Vec<(String, u64, Option<String>)>>,
        request_lineages: std::sync::Mutex<Vec<Option<String>>>,
        recover_with: Option<Arc<crate::infrastructure::ai::AIClient>>,
        recovered_clients: std::sync::Mutex<
            std::collections::HashMap<String, Arc<crate::infrastructure::ai::AIClient>>,
        >,
        recoveries: std::sync::Mutex<Vec<String>>,
        recovery_gate: Option<(Arc<tokio::sync::Notify>, Arc<tokio::sync::Notify>)>,
    }

    impl std::fmt::Debug for TestAccountSource {
        fn fmt(&self, formatter: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
            formatter
                .debug_struct("TestAccountSource")
                .field("policy", &self.policy)
                .finish()
        }
    }

    impl crate::infrastructure::ai::account_client_source::AccountClientSource for TestAccountSource {
        fn policy_revision(&self) -> Option<u64> {
            matches!(
                self.policy,
                openbitfun_agent_runtime::account_routing::AccountPolicy::Ordered(_)
            )
            .then_some(7)
        }
        fn policy(&self) -> &openbitfun_agent_runtime::account_routing::AccountPolicy {
            &self.policy
        }
        fn resolve<'a>(
            &'a self,
            excluded: &'a [String],
            required: Option<&'a openbitfun_core_types::ModelAccountOrigin>,
        ) -> crate::infrastructure::ai::account_client_source::AccountClientFuture<'a> {
            Box::pin(async move {
                let members = match &self.policy {
                    openbitfun_agent_runtime::account_routing::AccountPolicy::Fixed(id) => vec![id],
                    openbitfun_agent_runtime::account_routing::AccountPolicy::Ordered(ids) => {
                        ids.iter().collect()
                    }
                };
                Ok(self
                    .clients
                    .iter()
                    .find(|(origin, _)| {
                        members.contains(&&origin.account_id)
                            && !excluded.contains(&origin.account_id)
                            && required.is_none_or(|required| required == origin)
                    })
                    .map(|(origin, client)| {
                        crate::infrastructure::ai::account_client_source::AccountClient {
                            credential_revision: 7,
                            origin: origin.clone(),
                            client: self
                                .recovered_clients
                                .lock()
                                .unwrap()
                                .get(&origin.account_id)
                                .cloned()
                                .unwrap_or_else(|| client.clone()),
                        }
                    }))
            })
        }
        fn recover_authentication<'a>(
            &'a self,
            origin: &'a openbitfun_core_types::ModelAccountOrigin,
            _rejected: &'a crate::infrastructure::ai::AIClient,
        ) -> crate::infrastructure::ai::account_client_source::AccountClientFuture<'a> {
            Box::pin(async move {
                self.recoveries
                    .lock()
                    .unwrap()
                    .push(origin.account_id.clone());
                if let Some((started, release)) = &self.recovery_gate {
                    started.notify_one();
                    release.notified().await;
                }
                let Some(client) = self.recover_with.as_ref() else {
                    return Err(anyhow::anyhow!("Synthetic credential recovery failure"));
                };
                self.recovered_clients
                    .lock()
                    .unwrap()
                    .insert(origin.account_id.clone(), client.clone());
                Ok(Some(
                    crate::infrastructure::ai::account_client_source::AccountClient {
                        credential_revision: 7,
                        origin: origin.clone(),
                        client: client.clone(),
                    },
                ))
            })
        }
        fn accepted(&self, origin: &openbitfun_core_types::ModelAccountOrigin) {
            self.accepted
                .lock()
                .unwrap()
                .push(origin.account_id.clone());
        }
        fn resolve_for_request<'a>(
            &'a self,
            excluded: &'a [String],
            required: Option<&'a openbitfun_core_types::ModelAccountOrigin>,
            lineage: Option<&'a str>,
        ) -> crate::infrastructure::ai::account_client_source::AccountClientFuture<'a> {
            Box::pin(async move {
                self.request_lineages
                    .lock()
                    .unwrap()
                    .push(lineage.map(str::to_string));
                self.resolve(excluded, required).await
            })
        }
        fn failed<'a>(
            &'a self,
            origin: &'a openbitfun_core_types::ModelAccountOrigin,
            revision: u64,
            until: i64,
        ) -> crate::infrastructure::ai::account_client_source::AccountRoutingEffect<'a> {
            Box::pin(async move {
                self.routing_failures.lock().unwrap().push((
                    origin.account_id.clone(),
                    revision,
                    until,
                ));
                Ok(())
            })
        }
        fn completed<'a>(
            &'a self,
            origin: &'a openbitfun_core_types::ModelAccountOrigin,
            revision: u64,
            lineage: Option<&'a str>,
        ) -> crate::infrastructure::ai::account_client_source::AccountRoutingEffect<'a> {
            Box::pin(async move {
                self.routing_completions.lock().unwrap().push((
                    origin.account_id.clone(),
                    revision,
                    lineage.map(str::to_string),
                ));
                self.accepted(origin);
                Ok(())
            })
        }
    }

    fn test_account_source(
        clients: Vec<Arc<crate::infrastructure::ai::AIClient>>,
        fixed: bool,
    ) -> Arc<TestAccountSource> {
        use openbitfun_agent_runtime::account_routing::AccountPolicy;
        let clients: Vec<_> = clients
            .into_iter()
            .enumerate()
            .map(|(index, client)| {
                (
                    openbitfun_core_types::ModelAccountOrigin {
                        provider: "codex".into(),
                        account_id: format!("account-{index}"),
                        upstream_account_id: Some(format!("seat-{index}")),
                    },
                    client,
                )
            })
            .collect();
        Arc::new(TestAccountSource {
            policy: if fixed {
                AccountPolicy::Fixed("account-0".into())
            } else {
                AccountPolicy::Ordered(
                    clients
                        .iter()
                        .map(|(origin, _)| origin.account_id.clone())
                        .collect(),
                )
            },
            clients,
            accepted: Default::default(),
            routing_failures: Default::default(),
            routing_completions: Default::default(),
            request_lineages: Default::default(),
            recover_with: None,
            recovered_clients: Default::default(),
            recoveries: Default::default(),
            recovery_gate: None,
        })
    }

    #[tokio::test]
    async fn prepared_account_identity_is_reused_without_selecting_again() {
        use crate::infrastructure::ai::account_client_source::AccountClientSource;
        let server = RetryTestServer::new(vec![retry_test_success()]);
        let source = test_account_source(vec![server.client()], false);
        let prepared = source
            .resolve_for_request(&[], None, Some("prepared-lineage"))
            .await
            .unwrap()
            .unwrap();
        let client = prepared.client.clone();
        let mut context = test_round_context();
        context.model_request_context.prompt_cache_route_key = Some("prepared-lineage".into());
        context.account_client_source = Some(source.clone());
        context.prepared_model = Some(
            crate::infrastructure::ai::channel_client_source::PreparedChannel {
                model_id: context.model_config_id.clone(),
                client: prepared.client,
                account_source: Some(source.clone()),
                origin: Some(prepared.origin),
                credential_revision: Some(prepared.credential_revision),
            },
        );
        test_round_executor()
            .execute_round(
                client,
                context,
                vec![super::AIMessage::user("Continue".into())],
                None,
                None,
            )
            .await
            .unwrap();
        assert_eq!(*source.request_lineages.lock().unwrap(), vec![Some("prepared-lineage".into())], "the round must consume the supplied selection instead of running candidate selection again");
        assert_eq!(server.requests.lock().unwrap().len(), 1);
    }

    fn account_quota_error() -> (u16, String) {
        (
            402,
            json!({"error":{"code":"insufficient_quota","message":"Quota exhausted"}}).to_string(),
        )
    }

    fn account_auth_error(in_stream: bool) -> (u16, String) {
        let body = json!({"error":{"code":"invalid_api_key", "message":"Credential rejected"}})
            .to_string();
        if in_stream {
            (200, format!("data: {body}\n\n"))
        } else {
            (401, body)
        }
    }

    #[tokio::test]
    async fn account_routing_feedback_keeps_lineage_and_request_epoch_for_http_and_stream_failures()
    {
        for (reply, eligible) in [
            (account_quota_error(), true),
            (
                (
                    200,
                    format!(
                        "data: {}\n\n",
                        json!({"error":{"code":"insufficient_quota","message":"Quota exhausted"}})
                    ),
                ),
                true,
            ),
            (
                (
                    400,
                    json!({"error":{"code":"invalid_request_error","message":"Invalid request"}})
                        .to_string(),
                ),
                false,
            ),
        ] {
            let primary = RetryTestServer::new(vec![reply]);
            let backup = RetryTestServer::new(vec![retry_test_success()]);
            let source = test_account_source(vec![primary.client(), backup.client()], false);
            let mut context = test_round_context();
            context.model_request_context.prompt_cache_route_key = Some("stable-lineage".into());
            context.account_client_source = Some(source.clone());
            let started = chrono::Utc::now().timestamp();
            let result = test_round_executor()
                .execute_round_with_lifecycle(
                    primary.client(),
                    context,
                    vec![super::AIMessage::user("Probe routing".into())],
                    None,
                    None,
                    &mut ModelRoundLifecycle::new(),
                    None,
                    None,
                )
                .await;
            assert_eq!(result.is_ok(), eligible);
            let failures = source.routing_failures.lock().unwrap();
            assert_eq!(failures.len(), usize::from(eligible));
            if eligible {
                assert_eq!(
                    (&failures[0].0, failures[0].1),
                    (&"account-0".to_string(), 7)
                );
                assert!(failures[0].2 >= started + 1);
                assert_eq!(
                    *source.routing_completions.lock().unwrap(),
                    vec![("account-1".into(), 7, Some("stable-lineage".into()))]
                );
            } else {
                assert!(source.routing_completions.lock().unwrap().is_empty());
            }
            assert!(!source.request_lineages.lock().unwrap().is_empty());
            assert!(source
                .request_lineages
                .lock()
                .unwrap()
                .iter()
                .all(|lineage| lineage.as_deref() == Some("stable-lineage")));
            assert_eq!(backup.requests.lock().unwrap().len(), usize::from(eligible));
        }
    }

    #[tokio::test]
    async fn account_authentication_recovery_retries_the_same_account_before_using_a_backup() {
        for fixed in [false, true] {
            for in_stream in [false, true] {
                let primary = RetryTestServer::new(vec![account_auth_error(in_stream)]);
                let renewed = RetryTestServer::new(vec![retry_test_success()]);
                let backup = RetryTestServer::new(vec![retry_test_success()]);
                let mut source =
                    test_account_source(vec![primary.client(), backup.client()], fixed);
                Arc::get_mut(&mut source).unwrap().recover_with = Some(renewed.client());
                let mut context = test_round_context();
                context.account_client_source = Some(source.clone());
                let executor = test_round_executor();
                let mut lifecycle = ModelRoundLifecycle::new();
                let result = executor
                    .execute_round_with_lifecycle(
                        primary.client(),
                        context,
                        vec![super::AIMessage::user("Recover this account".into())],
                        None,
                        None,
                        &mut lifecycle,
                        None,
                        None,
                    )
                    .await
                    .unwrap();
                assert!(result.had_assistant_text);
                assert_eq!(lifecycle.attempts_started(), 2);
                assert_eq!(primary.requests.lock().unwrap().len(), 1);
                assert_eq!(renewed.requests.lock().unwrap().len(), 1);
                assert!(backup.requests.lock().unwrap().is_empty());
                assert_eq!(*source.recoveries.lock().unwrap(), vec!["account-0"]);
                assert_eq!(*source.accepted.lock().unwrap(), vec!["account-0"]);
                let events = executor.event_queue.dequeue_batch(100).await;
                assert_eq!(events.iter().filter(|event| matches!(&event.event, AgenticEvent::ModelRoundAttemptSuperseded { diagnostic, .. } if diagnostic.category == "authentication_recovery")).count(), 1);
                assert!(!events.iter().any(|event| matches!(&event.event, AgenticEvent::ModelRoundAttemptSuperseded { diagnostic, .. } if diagnostic.category == "account_switch")));
            }
        }
    }

    #[tokio::test]
    async fn account_authentication_recovery_failure_respects_fixed_and_ordered_policy() {
        for fixed in [false, true] {
            let primary = RetryTestServer::new(vec![account_auth_error(false)]);
            let backup = RetryTestServer::new(vec![retry_test_success()]);
            let source = test_account_source(vec![primary.client(), backup.client()], fixed);
            let mut context = test_round_context();
            context.account_client_source = Some(source.clone());
            let result = test_round_executor()
                .execute_round(
                    primary.client(),
                    context,
                    vec![super::AIMessage::user("Recover or switch".into())],
                    None,
                    None,
                )
                .await;
            if fixed {
                assert_eq!(result.unwrap_err().error_category(), ErrorCategory::Auth);
            } else {
                assert!(result.unwrap().had_assistant_text);
            }
            assert_eq!(*source.recoveries.lock().unwrap(), vec!["account-0"]);
            assert_eq!(primary.requests.lock().unwrap().len(), 1);
            assert_eq!(backup.requests.lock().unwrap().len(), usize::from(!fixed));
        }
    }

    #[tokio::test]
    async fn account_authentication_recovery_then_rejection_uses_the_existing_attempt_budget() {
        let primary = RetryTestServer::new(vec![account_auth_error(false)]);
        let renewed = RetryTestServer::new(vec![account_auth_error(false)]);
        let backup = RetryTestServer::new(vec![retry_test_success()]);
        let mut source = test_account_source(vec![primary.client(), backup.client()], false);
        Arc::get_mut(&mut source).unwrap().recover_with = Some(renewed.client());
        let mut context = test_round_context();
        context.account_client_source = Some(source.clone());
        let mut lifecycle = ModelRoundLifecycle::new();
        let result = test_round_executor()
            .execute_round_with_lifecycle(
                primary.client(),
                context,
                vec![super::AIMessage::user("Use one budget".into())],
                None,
                None,
                &mut lifecycle,
                None,
                None,
            )
            .await
            .unwrap();
        assert!(result.had_assistant_text);
        assert_eq!(lifecycle.attempts_started(), 3);
        assert!(lifecycle.attempts_started() as usize <= RoundExecutor::MAX_STREAM_ATTEMPTS);
        assert_eq!(*source.recoveries.lock().unwrap(), vec!["account-0"]);
        assert_eq!(*source.accepted.lock().unwrap(), vec!["account-1"]);
        assert_eq!(primary.requests.lock().unwrap().len(), 1);
        assert_eq!(renewed.requests.lock().unwrap().len(), 1);
        assert_eq!(backup.requests.lock().unwrap().len(), 1);
    }

    #[tokio::test]
    async fn account_authentication_recovery_does_not_run_after_effective_stream_output() {
        let text = format!(
            "data: {}\n\n",
            json!({"id":"partial", "object":"chat.completion.chunk", "created":1, "model":"retry-test-model", "choices":[{"index":0,"delta":{"content":"Partial answer"},"finish_reason":null}]})
        );
        let primary = RetryTestServer::new(vec![
            (200, text + &account_auth_error(true).1),
            retry_test_success(),
        ]);
        let renewed = RetryTestServer::new(vec![retry_test_success()]);
        let backup = RetryTestServer::new(vec![retry_test_success()]);
        let mut source = test_account_source(vec![primary.client(), backup.client()], false);
        Arc::get_mut(&mut source).unwrap().recover_with = Some(renewed.client());
        let mut context = test_round_context();
        context.account_client_source = Some(source.clone());
        let _result = test_round_executor()
            .execute_round(
                primary.client(),
                context,
                vec![super::AIMessage::user("Keep the output boundary".into())],
                None,
                None,
            )
            .await;
        assert!(source.recoveries.lock().unwrap().is_empty());
        assert!(renewed.requests.lock().unwrap().is_empty());
        assert!(backup.requests.lock().unwrap().is_empty());
    }

    #[tokio::test]
    async fn account_recovery_stays_blocked_after_output_from_an_earlier_attempt() {
        for in_stream in [false, true] {
            let partial = format!(
                "data: {}\n\ndata: {}\n\n",
                json!({"id":"partial", "object":"chat.completion.chunk", "created":1,
                    "model":"retry-test-model", "choices":[{"index":0,"delta":{"content":"Visible output"},"finish_reason":null}]}),
                json!({"error":{"code":"server_error","message":"Stream interrupted"}})
            );
            let primary = RetryTestServer::new(vec![(200, partial), account_auth_error(in_stream)]);
            let backup = RetryTestServer::new(vec![retry_test_success()]);
            let source = test_account_source(vec![primary.client(), backup.client()], false);
            let mut context = test_round_context();
            context.account_client_source = Some(source.clone());
            let mut lifecycle = ModelRoundLifecycle::new();
            let error = test_round_executor()
                .execute_round_with_lifecycle(
                    primary.client(),
                    context,
                    vec![super::AIMessage::user(
                        "Preserve the output boundary".into(),
                    )],
                    None,
                    None,
                    &mut lifecycle,
                    None,
                    None,
                )
                .await
                .unwrap_err();
            assert_eq!(error.error_category(), ErrorCategory::Auth);
            assert!(lifecycle.observed_effective_output);
            assert_eq!(primary.requests.lock().unwrap().len(), 2);
            assert!(source.recoveries.lock().unwrap().is_empty());
            assert!(backup.requests.lock().unwrap().is_empty());
        }
    }

    #[tokio::test]
    async fn account_authentication_recovery_wait_is_cancellable_without_requesting_a_backup() {
        let primary = RetryTestServer::new(vec![account_auth_error(false)]);
        let backup = RetryTestServer::new(vec![retry_test_success()]);
        let mut source = test_account_source(vec![primary.client(), backup.client()], false);
        let started = Arc::new(tokio::sync::Notify::new());
        Arc::get_mut(&mut source).unwrap().recovery_gate =
            Some((started.clone(), Arc::new(tokio::sync::Notify::new())));
        let mut context = test_round_context();
        context.account_client_source = Some(source.clone());
        let token = CancellationToken::new();
        let executor = test_round_executor();
        executor.register_cancel_token("turn-1", token.clone());
        let execution = executor.execute_round(
            primary.client(),
            context,
            vec![super::AIMessage::user("Cancel while refreshing".into())],
            None,
            None,
        );
        let cancel = async {
            started.notified().await;
            token.cancel();
        };
        let (result, ()) = tokio::time::timeout(Duration::from_secs(5), async {
            tokio::join!(execution, cancel)
        })
        .await
        .unwrap();
        assert!(matches!(result, Err(OpenBitFunError::Cancelled(_))));
        assert_eq!(primary.requests.lock().unwrap().len(), 1);
        assert!(backup.requests.lock().unwrap().is_empty());
        assert_eq!(*source.recoveries.lock().unwrap(), vec!["account-0"]);
    }

    #[tokio::test]
    async fn account_authentication_recovery_never_starts_without_a_remaining_model_attempt() {
        let primary = RetryTestServer::new(vec![account_auth_error(false)]);
        let source = test_account_source(vec![primary.client()], false);
        let origin = source.clients[0].0.clone();
        let client = primary.client();
        let source_port: Arc<
            dyn crate::infrastructure::ai::account_client_source::AccountClientSource,
        > = source.clone();
        assert!(RoundExecutor::account_after_failure(
            Some(&source_port),
            Some(&origin),
            Some(7),
            client.as_ref(),
            &mut Default::default(),
            &mut Vec::new(),
            None,
            &ErrorCategory::Auth,
            None,
            500,
            None,
            false,
            0,
            &CancellationToken::new()
        )
        .await
        .unwrap()
        .is_none());
        assert!(source.recoveries.lock().unwrap().is_empty());
        assert!(primary.requests.lock().unwrap().is_empty());
    }

    #[tokio::test]
    async fn account_attempt_ledger_keeps_failed_usage_actual_accounts_and_idempotent_events() {
        use crate::service::token_usage::{
            TimeRange, TokenUsageQuery, TokenUsageService, TokenUsageSubscriber,
        };
        use openbitfun_services_core::token_usage::types::ModelRequestOutcome;
        for report_failed_usage in [false, true] {
            let dir = tempfile::tempdir().unwrap();
            let service = Arc::new(
                TokenUsageService::new_in_base_dir(dir.path().join("ledger"))
                    .await
                    .unwrap(),
            );
            let usage_chunk = format!(
                "data: {}\n\n",
                json!({"id":"usage", "object":"chat.completion.chunk", "created":1, "model":"reported-primary-snapshot", "choices":[], "usage":{"prompt_tokens":10,"completion_tokens":0,"total_tokens":10,"prompt_tokens_details":{"cached_tokens":2}}})
            );
            let failure = if report_failed_usage {
                (
                    200,
                    usage_chunk
                        + &format!(
                            "data: {}\n\n",
                            json!({"error":{"code":"insufficient_quota","message":"Quota exhausted"}})
                        ),
                )
            } else {
                account_quota_error()
            };
            let primary = RetryTestServer::new(vec![failure]);
            let success = retry_test_success().1.replace("data: [DONE]", &format!("data: {}\n\ndata: [DONE]", json!({"id":"usage", "object":"chat.completion.chunk", "created":1, "model":"reported-backup-snapshot", "choices":[], "usage":{"prompt_tokens":20,"completion_tokens":5,"total_tokens":25}})));
            let backup = RetryTestServer::new(vec![(200, success)]);
            let source = test_account_source(vec![primary.client(), backup.client()], false);
            let mut context = test_round_context();
            context.account_client_source = Some(source);
            let mut executor = test_round_executor();
            executor.usage_service = Some(service.clone());
            let result = executor
                .execute_round(
                    primary.client(),
                    context,
                    vec![super::AIMessage::user("Attribute every attempt".into())],
                    None,
                    None,
                )
                .await
                .unwrap();
            assert!(result.had_assistant_text);
            let query = || TokenUsageQuery {
                model_id: None,
                session_id: None,
                time_range: TimeRange::All,
                time_zone: None,
                limit: None,
                offset: None,
                include_subagent: true,
            };
            let records = service.query_records(query()).await.unwrap();
            assert_eq!(records.len(), 2);
            let failed = records
                .iter()
                .find(|record| record.request_context().unwrap().attempt_index == 1)
                .unwrap();
            let completed = records
                .iter()
                .find(|record| record.request_context().unwrap().attempt_index == 2)
                .unwrap();
            assert_eq!(
                failed.request_context().unwrap().outcome,
                ModelRequestOutcome::Failed
            );
            assert_eq!(
                failed
                    .request_context()
                    .unwrap()
                    .account
                    .unwrap()
                    .account_id,
                "account-0"
            );
            assert_eq!(failed.usage_is_known(), report_failed_usage);
            assert_eq!(
                failed.request_context().unwrap().response_model.as_deref(),
                report_failed_usage.then_some("reported-primary-snapshot")
            );
            assert_eq!(
                completed
                    .request_context()
                    .unwrap()
                    .response_model
                    .as_deref(),
                Some("reported-backup-snapshot")
            );
            assert_eq!(
                completed.request_context().unwrap().requested_model,
                "retry-test-model"
            );
            assert_eq!(
                failed.input_tokens,
                if report_failed_usage { 10 } else { 0 }
            );
            assert_eq!(
                completed
                    .request_context()
                    .unwrap()
                    .account
                    .unwrap()
                    .account_id,
                "account-1"
            );
            assert_eq!(
                completed.request_context().unwrap().policy_revision,
                Some(7)
            );
            assert_eq!(
                completed.request_context().unwrap().retry_reason,
                Some(ErrorCategory::ProviderQuota)
            );
            assert_eq!(completed.effective_model_name, "retry-test-model");
            assert_eq!(completed.total_tokens, 25);
            let events = executor.event_queue.dequeue_batch(200).await;
            let subscriber = TokenUsageSubscriber::new(service.clone());
            let usage_events: Vec<_> = events
                .iter()
                .filter(|event| matches!(event.event, AgenticEvent::TokenUsageUpdated { .. }))
                .collect();
            assert_eq!(usage_events.len(), 1 + usize::from(report_failed_usage));
            for event in &usage_events {
                crate::agentic::events::EventSubscriber::on_event(&subscriber, &event.event)
                    .await
                    .unwrap();
                crate::agentic::events::EventSubscriber::on_event(&subscriber, &event.event)
                    .await
                    .unwrap();
            }
            assert_eq!(service.query_records(query()).await.unwrap().len(), 2);
            assert_eq!(
                service
                    .get_model_stats("retry-test-model")
                    .await
                    .unwrap()
                    .request_count,
                2
            );
            let restarted = TokenUsageService::new_in_base_dir(dir.path().join("ledger"))
                .await
                .unwrap();
            assert_eq!(restarted.query_records(query()).await.unwrap().len(), 2);
            let bytes = std::fs::read_to_string(
                std::fs::read_dir(dir.path().join("ledger/records"))
                    .unwrap()
                    .filter_map(Result::ok)
                    .find(|entry| entry.path().extension().is_some_and(|ext| ext == "json"))
                    .unwrap()
                    .path(),
            )
            .unwrap();
            assert!(!bytes.contains("retry-test-key"));
        }
    }

    #[tokio::test]
    async fn account_attempt_ledger_does_not_block_cancellation_behind_a_host_file_lock() {
        use crate::service::token_usage::TokenUsageService;
        use openbitfun_services_core::token_usage::types::{
            ModelRequestOutcome, ModelRequestUsageContext,
        };
        let dir = tempfile::tempdir().unwrap();
        let service = Arc::new(
            TokenUsageService::new_in_base_dir(dir.path().join("ledger"))
                .await
                .unwrap(),
        );
        let path = service
            .base_dir()
            .join("records/model-attempts/2026-10-13.json");
        let guard = openbitfun_services_core::json_store::JsonFileStore
            .acquire_cross_process_lock(&path)
            .await
            .unwrap();
        let request: ModelRequestUsageContext = serde_json::from_value(json!({"version":1,"roundId":"locked-round","attemptId":"locked-attempt","attemptIndex":1,"startedAt":"2026-10-13T10:00:00Z","authentication":"api_key","requestedModel":"wire-model","outcome":"cancelled","usageKnown":false})).unwrap();
        let mut executor = test_round_executor();
        executor.usage_service = Some(service.clone());
        let cancel = CancellationToken::new();
        cancel.cancel();
        executor.register_cancel_token("turn-1", cancel);
        tokio::time::timeout(
            Duration::from_secs(5),
            executor.record_attempt_usage(
                &test_round_context(),
                &request,
                None,
                ModelRequestOutcome::Cancelled,
                None,
                false,
            ),
        )
        .await
        .unwrap();
        drop(guard);
        tokio::time::timeout(Duration::from_secs(5), async {
            while service.get_session_stats("session-1").await.is_none() {
                tokio::task::yield_now().await;
            }
        })
        .await
        .unwrap();
        assert_eq!(
            service
                .get_session_stats("session-1")
                .await
                .unwrap()
                .request_count,
            1
        );
        assert!(
            executor
                .event_queue
                .dequeue_batch(10)
                .await
                .iter()
                .all(|event| !matches!(event.event, AgenticEvent::TokenUsageUpdated { .. })),
            "unknown usage cannot reset the UI context counter to zero"
        );
    }

    #[tokio::test]
    async fn exhausted_primary_uses_backup_in_the_existing_round_attempt_loop() {
        let primary = RetryTestServer::new(vec![account_quota_error()]);
        let backup = RetryTestServer::new(vec![retry_test_success()]);
        let source = test_account_source(vec![primary.client(), backup.client()], false);
        let mut context = test_round_context();
        context.account_client_source = Some(source.clone());
        let executor = test_round_executor();
        let mut lifecycle = ModelRoundLifecycle::new();
        let result = executor
            .execute_round_with_lifecycle(
                primary.client(),
                context,
                vec![super::AIMessage::user("Use my backup".into())],
                None,
                None,
                &mut lifecycle,
                None,
                None,
            )
            .await
            .unwrap();
        assert!(result.had_assistant_text);
        assert_eq!(lifecycle.attempts_started(), 2);
        assert_eq!(*source.accepted.lock().unwrap(), vec!["account-1"]);
        assert_eq!(primary.requests.lock().unwrap().len(), 1);
        assert_eq!(backup.requests.lock().unwrap().len(), 1);
        assert_eq!(
            primary.requests.lock().unwrap()[0],
            backup.requests.lock().unwrap()[0]
        );
        let events = executor.event_queue.dequeue_batch(100).await;
        assert_eq!(events.iter().filter(|event| matches!(&event.event, AgenticEvent::ModelRoundAttemptSuperseded { diagnostic, .. } if diagnostic.category == "account_switch")).count(), 1);
    }

    #[tokio::test]
    async fn later_model_pool_members_keep_their_account_switch_budget() {
        for reply in [
            account_quota_error(),
            (
                200,
                format!(
                    "data: {}\n\n",
                    json!({"error":{"code":"insufficient_quota","message":"Quota exhausted"}})
                ),
            ),
        ] {
            let primary = RetryTestServer::new(vec![reply]);
            let backup = RetryTestServer::new(vec![retry_test_success()]);
            let source = test_account_source(vec![primary.client(), backup.client()], false);
            let mut context = test_round_context();
            context.account_client_source = Some(source.clone());
            let mut lifecycle = ModelRoundLifecycle::new();
            // An earlier outer-pool member exhausted its response recovery.
            // Attempt numbering/usage remain global; retry admission is local.
            for _ in 0..RoundExecutor::MAX_STREAM_ATTEMPTS {
                lifecycle.begin_attempt();
            }
            let result = test_round_executor()
                .execute_round_with_lifecycle(
                    primary.client(),
                    context,
                    vec![super::AIMessage::user("Try the next pool member".into())],
                    None,
                    None,
                    &mut lifecycle,
                    None,
                    None,
                )
                .await
                .unwrap();
            assert!(result.had_assistant_text);
            assert_eq!(
                lifecycle.attempts_started() as usize,
                RoundExecutor::MAX_STREAM_ATTEMPTS + 2
            );
            assert_eq!(primary.requests.lock().unwrap().len(), 1);
            assert_eq!(backup.requests.lock().unwrap().len(), 1);
            assert_eq!(source.accepted.lock().unwrap().len(), 1);
        }
    }

    #[tokio::test]
    async fn account_switches_share_one_attempt_budget() {
        let server = RetryTestServer::new(vec![
            account_quota_error();
            RoundExecutor::MAX_STREAM_ATTEMPTS + 2
        ]);
        let source = test_account_source(
            (0..RoundExecutor::MAX_STREAM_ATTEMPTS + 2)
                .map(|_| server.client())
                .collect(),
            false,
        );
        let mut context = test_round_context();
        context.account_client_source = Some(source.clone());
        let mut lifecycle = ModelRoundLifecycle::new();
        let error = test_round_executor()
            .execute_round_with_lifecycle(
                server.client(),
                context,
                vec![super::AIMessage::user("Bounded attempts".into())],
                None,
                None,
                &mut lifecycle,
                None,
                None,
            )
            .await
            .unwrap_err();
        assert_eq!(error.error_category(), ErrorCategory::ProviderQuota);
        assert_eq!(
            lifecycle.attempts_started() as usize,
            RoundExecutor::MAX_STREAM_ATTEMPTS
        );
        assert_eq!(
            server.requests.lock().unwrap().len(),
            RoundExecutor::MAX_STREAM_ATTEMPTS
        );
        assert!(source.accepted.lock().unwrap().is_empty());
    }

    #[tokio::test]
    async fn fixed_account_never_switches_on_quota_failure() {
        let primary = RetryTestServer::new(vec![account_quota_error()]);
        let backup = RetryTestServer::new(vec![retry_test_success()]);
        let source = test_account_source(vec![primary.client(), backup.client()], true);
        let mut context = test_round_context();
        context.account_client_source = Some(source);
        let error = test_round_executor()
            .execute_round(
                primary.client(),
                context,
                vec![super::AIMessage::user("Keep my fixed account".into())],
                None,
                None,
            )
            .await
            .unwrap_err();
        assert_eq!(error.error_category(), ErrorCategory::ProviderQuota);
        assert_eq!(primary.requests.lock().unwrap().len(), 1);
        assert!(backup.requests.lock().unwrap().is_empty());
    }

    #[tokio::test]
    async fn stream_quota_switches_only_before_effective_output() {
        for has_text in [false, true] {
            let mut body = String::new();
            if has_text {
                body.push_str(&format!("data: {}\n\n", json!({"id":"partial", "object":"chat.completion.chunk", "created":1, "model":"retry-test-model", "choices":[{"index":0,"delta":{"content":"Partial answer"},"finish_reason":null}]})));
            }
            body.push_str(&format!(
                "data: {}\n\n",
                json!({"error":{"code":"insufficient_quota","message":"Quota exhausted"}})
            ));
            let primary = RetryTestServer::new(vec![(200, body), retry_test_success()]);
            let backup = RetryTestServer::new(vec![retry_test_success()]);
            let source = test_account_source(vec![primary.client(), backup.client()], false);
            let mut context = test_round_context();
            context.account_client_source = Some(source);
            let executor = test_round_executor();
            let result = tokio::time::timeout(
                Duration::from_secs(5),
                executor.execute_round(
                    primary.client(),
                    context,
                    vec![super::AIMessage::user("Stream boundary".into())],
                    None,
                    None,
                ),
            )
            .await
            .expect("the stream boundary must settle within one recovery attempt");
            assert_eq!(
                backup.requests.lock().unwrap().len(),
                usize::from(!has_text)
            );
            if has_text {
                let error = result.unwrap_err().error_detail();
                assert_eq!(error.category, ErrorCategory::ProviderQuota);
                assert_eq!(error.provider_code.as_deref(), Some("insufficient_quota"));
            } else {
                assert!(result.unwrap().had_assistant_text);
            }
            assert_eq!(primary.requests.lock().unwrap().len(), 1);
        }
    }

    #[tokio::test]
    async fn manual_model_switch_projects_history_before_sending() {
        for format in ["responses", "anthropic", "gemini", "fixed-account"] {
            let events = match format {
                "anthropic" => vec![
                    json!({"type":"message_start","message":{"id":"continued","type":"message","role":"assistant","model":"target","usage":{"input_tokens":20,"output_tokens":0}}}),
                    json!({"type":"content_block_start","index":0,"content_block":{"type":"text","text":""}}),
                    json!({"type":"content_block_delta","index":0,"delta":{"type":"text_delta","text":"Continued"}}),
                    json!({"type":"content_block_stop","index":0}),
                    json!({"type":"message_delta","delta":{"stop_reason":"end_turn"},"usage":{"output_tokens":5}}),
                    json!({"type":"message_stop"}),
                ],
                "gemini" => vec![
                    json!({"candidates":[{"content":{"role":"model","parts":[{"text":"Continued"}]},"finishReason":"STOP"}]}),
                ],
                _ => vec![
                    json!({"type":"response.output_text.delta","delta":"Continued"}),
                    json!({"type":"response.completed","response":{"id":"continued","output":[]}}),
                ],
            };
            let reply = (
                200,
                events
                    .iter()
                    .map(|event| {
                        format!(
                            "event: {}\ndata: {event}\n\n",
                            event["type"].as_str().unwrap_or("message")
                        )
                    })
                    .collect::<String>(),
            );
            let server =
                RetryTestServer::new(vec![reply; if format == "responses" { 2 } else { 1 }]);
            let mut client = (*server.client()).clone();
            client.config.format = if format == "fixed-account" {
                "responses"
            } else {
                format
            }
            .into();
            client.config.model = if format == "gemini" {
                "gemini-3-pro"
            } else {
                "target-model"
            }
            .into();
            let client = Arc::new(client);
            let mut context = test_round_context();
            let mut original_client = (*client).clone();
            original_client.config.format = "responses".into();
            original_client.config.model = "original-model".into();
            let mut previous =
                super::AIMessage::assistant_with_tools(vec![openbitfun_core_types::ToolCall {
                    id: "already-executed".into(),
                    name: "write_file".into(),
                    arguments: json!({"path":"result.txt", "content":"saved once"}),
                    raw_arguments: None,
                }]);
            previous.content = Some("Saved the requested file".into());
            previous.reasoning_content = Some("Original private reasoning".into());
            previous.thinking_signature = Some("original-signature".into());
            previous.model_response_replay = Some(openbitfun_core_types::ModelResponseReplay {
                protocol: "openai_responses".into(),
                channel_origin: Some(context.model_config_id.clone()),
                channel_fingerprint: Some(original_client.channel_replay_fingerprint()),
                account_origin: None,
                items: vec![
                    openbitfun_core_types::ModelResponseReplayItem::OpaqueReasoning {
                        item_id: Some("original-reasoning".into()),
                        summary: vec![],
                        opaque_state: "original-encrypted-state".into(),
                    },
                    openbitfun_core_types::ModelResponseReplayItem::AssistantMessage,
                    openbitfun_core_types::ModelResponseReplayItem::FunctionCall {
                        call_id: "already-executed".into(),
                    },
                ],
            });
            if format == "fixed-account" {
                let source = test_account_source(vec![client.clone()], true);
                let mut old_account = source.clients[0].0.clone();
                old_account.account_id = "previous-account".into();
                old_account.upstream_account_id = Some("previous-seat".into());
                previous
                    .model_response_replay
                    .as_mut()
                    .unwrap()
                    .account_origin = Some(old_account);
                context.account_client_source = Some(source);
            }
            let mut result =
                super::AIMessage::user("Saved result.txt; checksum=manual-switch".into());
            result.role = "tool".into();
            result.name = Some("write_file".into());
            result.tool_call_id = Some("already-executed".into());
            let history = vec![
                super::AIMessage::user("Save the file".into()),
                previous,
                result,
                super::AIMessage::user("Continue".into()),
            ];
            // Exercise the persisted shape without changing the original record.
            let before = serde_json::to_value(&history).unwrap();
            let restored = serde_json::from_value(before.clone()).unwrap();
            let result = tokio::time::timeout(
                Duration::from_secs(5),
                test_round_executor().execute_round(client, context, restored, None, None),
            )
            .await
            .unwrap()
            .unwrap();
            assert!(result.had_assistant_text, "{format}");
            assert!(
                result.tool_result_messages.is_empty(),
                "completed tools must not execute again"
            );
            assert_eq!(serde_json::to_value(&history).unwrap(), before);
            let requests = server.requests.lock().unwrap();
            assert_eq!(requests.len(), 1, "{format}");
            let sent = requests[0].to_string();
            for secret in [
                "original-signature",
                "original-encrypted-state",
                "Original private reasoning",
            ] {
                assert!(!sent.contains(secret), "{format}: {secret}");
            }
            for retained in [
                "Saved the requested file",
                "write_file",
                "saved once",
                "checksum=manual-switch",
            ] {
                assert!(sent.contains(retained), "{format}: {retained}");
            }
            if format == "gemini" {
                assert!(sent.contains("skip_thought_signature_validator"));
            }
            drop(requests);
            if format == "responses" {
                // Switching back projects the original durable history again;
                // compatible encrypted reasoning must still reach its producer.
                let result = tokio::time::timeout(
                    Duration::from_secs(5),
                    test_round_executor().execute_round(
                        Arc::new(original_client),
                        test_round_context(),
                        history.clone(),
                        None,
                        None,
                    ),
                )
                .await
                .unwrap()
                .unwrap();
                assert!(result.had_assistant_text);
                let requests = server.requests.lock().unwrap();
                assert_eq!(requests.len(), 2);
                assert!(requests[1].to_string().contains("original-encrypted-state"));
                assert_eq!(serde_json::to_value(&history).unwrap(), before);
            }
        }
    }

    #[tokio::test]
    async fn routed_opaque_history_prefers_its_producer_and_degrades_on_switch() {
        for has_origin in [false, true] {
            let primary = RetryTestServer::new(vec![account_quota_error()]);
            let backup = RetryTestServer::new(vec![retry_test_success()]);
            let source = test_account_source(vec![primary.client(), backup.client()], false);
            let mut context = test_round_context();
            context.account_client_source = Some(source.clone());
            let mut previous = super::AIMessage::assistant("Previous answer".into());
            previous.model_response_replay = Some(openbitfun_core_types::ModelResponseReplay {
                protocol: "openai_responses".into(),
                channel_origin: None,
                channel_fingerprint: None,
                account_origin: has_origin.then(|| source.clients[0].0.clone()),
                items: vec![
                    openbitfun_core_types::ModelResponseReplayItem::OpaqueReasoning {
                        item_id: None,
                        summary: vec![],
                        opaque_state: "opaque-test-state".into(),
                    },
                ],
            });
            let result = test_round_executor()
                .execute_round(
                    primary.client(),
                    context,
                    vec![previous, super::AIMessage::user("Continue".into())],
                    None,
                    None,
                )
                .await;
            // A routed pool treats signed state as a preference: proven state
            // is replayed to its producer, unproven state is degraded, and a
            // switch always sends portable history to the next account.
            assert!(result.unwrap().had_assistant_text);
            let primary_sent = primary.requests.lock().unwrap();
            // Chat-format fixtures never serialize opaque state; the Responses
            // test below checks the producer still receives it.
            assert_eq!(primary_sent.len(), 1);
            let backup_sent = backup.requests.lock().unwrap();
            assert_eq!(backup_sent.len(), 1);
            assert!(!backup_sent[0].to_string().contains("opaque-test-state"));
        }
    }

    #[tokio::test]
    async fn completed_tool_history_is_preserved_on_failover_and_opaque_reasoning_is_degraded() {
        for opaque in [false, true] {
            let primary = RetryTestServer::new(vec![account_quota_error()]);
            let events = [
                json!({"type":"response.output_text.delta", "delta":"Continued from the completed tool result"}),
                json!({"type":"response.completed", "response":{"id":"continued", "output":[]}}),
            ];
            let backup = RetryTestServer::new(vec![(
                200,
                events
                    .iter()
                    .map(|event| format!("data: {event}\n\n"))
                    .collect(),
            )]);
            let responses_client = |server: &RetryTestServer| {
                let mut client = (*server.client()).clone();
                client.config.format = "responses".into();
                Arc::new(client)
            };
            let source = test_account_source(
                vec![responses_client(&primary), responses_client(&backup)],
                false,
            );
            let mut previous =
                super::AIMessage::assistant_with_tools(vec![openbitfun_core_types::ToolCall {
                    id: "already-executed".into(),
                    name: "write_file".into(),
                    arguments: json!({"path":"result.txt", "content":"saved once"}),
                    raw_arguments: None,
                }]);
            let mut replay_items = Vec::new();
            if opaque {
                replay_items.push(
                    openbitfun_core_types::ModelResponseReplayItem::OpaqueReasoning {
                        item_id: Some("reasoning-history".into()),
                        summary: vec![],
                        opaque_state: "account-a-encrypted-reasoning".into(),
                    },
                );
            }
            replay_items.push(
                openbitfun_core_types::ModelResponseReplayItem::FunctionCall {
                    call_id: "already-executed".into(),
                },
            );
            previous.model_response_replay = Some(openbitfun_core_types::ModelResponseReplay {
                protocol: "openai_responses".into(),
                channel_origin: None,
                channel_fingerprint: None,
                account_origin: Some(source.clients[0].0.clone()),
                items: replay_items,
            });
            let mut completed_tool =
                super::AIMessage::user("Saved result.txt; checksum=fixture".into());
            completed_tool.role = "tool".into();
            completed_tool.tool_call_id = Some("already-executed".into());
            // Include a prior completed conversation turn as well as a completed tool exchange.
            let history = vec![
                super::AIMessage::user("Save the file".into()),
                previous,
                completed_tool,
                super::AIMessage::assistant("The file has been saved".into()),
                super::AIMessage::user("Continue using that result".into()),
            ];
            let history: Vec<super::AIMessage> =
                serde_json::from_value(serde_json::to_value(history).unwrap()).unwrap();
            let mut context = test_round_context();
            context.account_client_source = Some(source.clone());
            let result = test_round_executor()
                .execute_round(responses_client(&primary), context, history, None, None)
                .await;
            let sent = primary.requests.lock().unwrap();
            assert_eq!(sent.len(), 1);
            let input = sent[0]["input"].as_array().unwrap();
            assert_eq!(
                input
                    .iter()
                    .filter(|item| item["type"] == "function_call")
                    .count(),
                1
            );
            assert_eq!(
                input
                    .iter()
                    .filter(|item| item["type"] == "function_call_output")
                    .count(),
                1
            );
            assert!(input
                .iter()
                .any(|item| item["output"] == "Saved result.txt; checksum=fixture"));
            let backup_sent = backup.requests.lock().unwrap();
            let result = result.unwrap();
            assert!(
                result.tool_result_messages.is_empty(),
                "completed history must not execute a tool again"
            );
            assert_eq!(backup_sent.len(), 1);
            assert_eq!(
                input
                    .iter()
                    .any(|item| item["encrypted_content"] == "account-a-encrypted-reasoning"),
                opaque,
                "the producing account still receives its own signed state"
            );
            let backup_input = backup_sent[0]["input"].as_array().unwrap();
            assert!(
                !backup_input
                    .iter()
                    .any(|item| item.get("encrypted_content").is_some()),
                "opaque state must never leak to another account"
            );
            let visible = |items: &[serde_json::Value]| {
                items
                    .iter()
                    .filter(|item| item["type"] != "reasoning")
                    .cloned()
                    .collect::<Vec<_>>()
            };
            assert_eq!(
                visible(input),
                visible(backup_input),
                "failover must preserve the complete visible history"
            );
        }
    }

    #[tokio::test]
    async fn successful_backup_replay_keeps_its_account_after_persistence() {
        let reasoning = json!({"id":"rs-1", "type":"reasoning", "encrypted_content":"opaque-backup-state", "summary":[]});
        let message = json!({"id":"msg-1", "type":"message", "role":"assistant", "content":[{"type":"output_text", "text":"Backup answer"}]});
        let events = [
            json!({"type":"response.output_item.done", "output_index":0, "item":reasoning.clone()}),
            json!({"type":"response.output_item.done", "output_index":1, "item":message.clone()}),
            json!({"type":"response.completed", "response":{"id":"resp-1", "status":"completed", "output":[reasoning, message]}}),
        ];
        let body = events
            .iter()
            .map(|event| format!("data: {event}\n\n"))
            .collect::<String>();
        let primary = RetryTestServer::new(vec![account_quota_error()]);
        let backup = RetryTestServer::new(vec![(200, body)]);
        let responses_client = |server: &RetryTestServer| {
            let mut client = (*server.client()).clone();
            client.config.format = "responses".into();
            Arc::new(client)
        };
        let source = test_account_source(
            vec![responses_client(&primary), responses_client(&backup)],
            false,
        );
        let mut context = test_round_context();
        context.account_client_source = Some(source.clone());
        let executor = test_round_executor();
        let result = tokio::time::timeout(
            Duration::from_secs(5),
            executor.execute_round(
                responses_client(&primary),
                context,
                vec![super::AIMessage::user("Remember the actual account".into())],
                None,
                None,
            ),
        )
        .await
        .unwrap()
        .unwrap();
        let restored: crate::agentic::core::Message =
            serde_json::from_value(serde_json::to_value(&result.assistant_message).unwrap())
                .unwrap();
        let replay = restored.metadata.model_response_replay.unwrap();
        assert_eq!(replay.account_origin.as_ref(), Some(&source.clients[1].0));
        assert!(replay.items.iter().any(|item| matches!(item, openbitfun_core_types::ModelResponseReplayItem::OpaqueReasoning { opaque_state, .. } if opaque_state == "opaque-backup-state")));
        let mut history = super::AIMessage::assistant("Backup answer".into());
        history.model_response_replay = Some(replay);
        assert_eq!(
            crate::infrastructure::ai::account_client_source::opaque_replay_origin(&[history])
                .unwrap(),
            Some(source.clients[1].0.clone())
        );
        assert_eq!(primary.requests.lock().unwrap().len(), 1);
        assert_eq!(backup.requests.lock().unwrap().len(), 1);
    }

    #[derive(Debug)]
    struct CancellingAccountSource {
        inner: Arc<TestAccountSource>,
        switching: Arc<tokio::sync::Notify>,
    }

    impl crate::infrastructure::ai::account_client_source::AccountClientSource
        for CancellingAccountSource
    {
        fn policy(&self) -> &openbitfun_agent_runtime::account_routing::AccountPolicy {
            &self.inner.policy
        }
        fn resolve<'a>(
            &'a self,
            excluded: &'a [String],
            required: Option<&'a openbitfun_core_types::ModelAccountOrigin>,
        ) -> crate::infrastructure::ai::account_client_source::AccountClientFuture<'a> {
            Box::pin(async move {
                if !excluded.is_empty() {
                    self.switching.notify_one();
                    std::future::pending::<()>().await;
                }
                crate::infrastructure::ai::account_client_source::AccountClientSource::resolve(
                    self.inner.as_ref(),
                    excluded,
                    required,
                )
                .await
            })
        }
    }

    #[tokio::test]
    async fn cancellation_interrupts_account_resolution_before_backup_request() {
        let primary = RetryTestServer::new(vec![account_quota_error()]);
        let backup = RetryTestServer::new(vec![retry_test_success()]);
        let switching = Arc::new(tokio::sync::Notify::new());
        let source = Arc::new(CancellingAccountSource {
            inner: test_account_source(vec![primary.client(), backup.client()], false),
            switching: switching.clone(),
        });
        let mut context = test_round_context();
        context.account_client_source = Some(source);
        let executor = test_round_executor();
        let cancellation = CancellationToken::new();
        executor.register_cancel_token("turn-1", cancellation.clone());
        let execution = executor.execute_round(
            primary.client(),
            context,
            vec![super::AIMessage::user("Cancel the switch".into())],
            None,
            None,
        );
        let cancel = async {
            switching.notified().await;
            cancellation.cancel();
        };
        let (result, ()) = tokio::time::timeout(Duration::from_secs(5), async {
            tokio::join!(execution, cancel)
        })
        .await
        .unwrap();
        assert!(matches!(result, Err(super::OpenBitFunError::Cancelled(_))));
        assert_eq!(primary.requests.lock().unwrap().len(), 1);
        assert!(backup.requests.lock().unwrap().is_empty());
    }

    #[cfg(feature = "subscription-auth")]
    struct AcceptanceFixtureTool {
        mutates: bool,
        path: std::path::PathBuf,
        calls: Arc<std::sync::atomic::AtomicUsize>,
        context_store: Arc<crate::agentic::session::SessionContextStore>,
        expected_account: String,
        ledger: Arc<crate::service::token_usage::TokenUsageService>,
    }

    #[cfg(feature = "subscription-auth")]
    #[async_trait::async_trait]
    impl crate::agentic::tools::framework::Tool for AcceptanceFixtureTool {
        fn name(&self) -> &str {
            if self.mutates {
                "AcceptanceCommit"
            } else {
                "AcceptanceRead"
            }
        }
        async fn description(&self) -> super::OpenBitFunResult<String> {
            Ok(self.short_description())
        }
        fn short_description(&self) -> String {
            "Isolated subscription acceptance fixture".into()
        }
        fn is_readonly(&self) -> bool {
            !self.mutates
        }
        fn input_schema(&self) -> serde_json::Value {
            json!({"type":"object","properties":{},"additionalProperties":false})
        }
        async fn validate_input(
            &self,
            input: &serde_json::Value,
            _: Option<&crate::agentic::tools::framework::ToolUseContext>,
        ) -> crate::agentic::tools::framework::ValidationResult {
            crate::agentic::tools::framework::ValidationResult {
                result: input.as_object().is_some_and(|object| object.is_empty()),
                message: None,
                error_code: None,
                meta: None,
            }
        }
        async fn call_impl(
            &self,
            _: &serde_json::Value,
            _: &crate::agentic::tools::framework::ToolUseContext,
        ) -> super::OpenBitFunResult<Vec<crate::agentic::tools::framework::ToolResult>> {
            use std::io::Write;
            // The real round/pipeline must commit the semantic response with
            // the actual producing account before a mutation becomes possible.
            let messages = self.context_store.get_context_messages("session-1");
            let committed = messages
                .last()
                .expect("semantic tool call must precede execution");
            let round_id = committed.metadata.round_id.as_deref().unwrap();
            let records = self
                .ledger
                .query_records(crate::service::token_usage::TokenUsageQuery {
                    model_id: None,
                    session_id: Some("session-1".into()),
                    time_range: crate::service::token_usage::TimeRange::All,
                    time_zone: None,
                    limit: None,
                    offset: None,
                    include_subagent: true,
                })
                .await
                .unwrap();
            let completed = records.iter().filter_map(|record| record.request_context()).find(|request| request.round_id == round_id
                && request.outcome == openbitfun_services_core::token_usage::types::ModelRequestOutcome::Completed).expect("the producing attempt must be recorded before a tool can mutate");
            assert_eq!(completed.account.unwrap().account_id, self.expected_account);
            let count = self.calls.fetch_add(1, std::sync::atomic::Ordering::SeqCst) + 1;
            let result = if self.mutates {
                let mut file = std::fs::OpenOptions::new().append(true).open(&self.path)?;
                file.write_all(b"committed-once\n")?;
                format!("commit=fixture-checksum; count={count}")
            } else {
                std::fs::read_to_string(&self.path)?
            };
            Ok(vec![crate::agentic::tools::framework::ToolResult::Result {
                data: json!({"result":result,"executions":count}),
                result_for_assistant: Some(result),
                image_attachments: None,
            }])
        }
    }

    struct SemanticCommitTestTool {
        entered: Arc<tokio::sync::Notify>,
        release: Arc<tokio::sync::Notify>,
    }

    #[async_trait::async_trait]
    impl crate::agentic::tools::framework::Tool for SemanticCommitTestTool {
        fn name(&self) -> &str {
            "SemanticCommitTest"
        }
        async fn description(&self) -> super::OpenBitFunResult<String> {
            Ok("semantic commit test".into())
        }
        fn short_description(&self) -> String {
            "semantic commit test".into()
        }
        fn is_readonly(&self) -> bool {
            true
        }
        fn input_schema(&self) -> serde_json::Value {
            json!({"type":"object"})
        }
        async fn validate_input(
            &self,
            _: &serde_json::Value,
            _: Option<&crate::agentic::tools::framework::ToolUseContext>,
        ) -> crate::agentic::tools::framework::ValidationResult {
            crate::agentic::tools::framework::ValidationResult {
                result: true,
                message: None,
                error_code: None,
                meta: None,
            }
        }
        async fn call_impl(
            &self,
            _: &serde_json::Value,
            _: &crate::agentic::tools::framework::ToolUseContext,
        ) -> super::OpenBitFunResult<Vec<crate::agentic::tools::framework::ToolResult>> {
            self.entered.notify_one();
            self.release.notified().await;
            Ok(vec![crate::agentic::tools::framework::ToolResult::Result {
                data: json!({"done":true}),
                result_for_assistant: Some("done".into()),
                image_attachments: None,
            }])
        }
    }

    #[tokio::test]
    async fn semantic_tool_call_is_readable_while_tool_is_running() {
        assert_semantic_tool_call_commit(false, false).await;
    }

    #[tokio::test]
    async fn semantic_tool_call_survives_cancellation_during_execution() {
        assert_semantic_tool_call_commit(true, false).await;
    }

    #[tokio::test]
    async fn backup_account_tool_call_commits_and_executes_once() {
        assert_semantic_tool_call_commit(false, true).await;
    }

    async fn assert_semantic_tool_call_commit(cancel: bool, switch_account: bool) {
        use crate::agentic::persistence::PersistenceManager;
        use crate::agentic::session::{SessionContextStore, SessionManager, SessionManagerConfig};
        use crate::agentic::tools::pipeline::{ToolPipeline, ToolStateManager};
        use crate::agentic::tools::registry::ToolRegistry;
        let temp = tempfile::tempdir().unwrap();
        let context_store = Arc::new(SessionContextStore::new());
        let manager = SessionManager::new(
            context_store.clone(),
            Arc::new(
                PersistenceManager::new(Arc::new(
                    crate::infrastructure::PathManager::with_user_root_for_tests(
                        temp.path().into(),
                    ),
                ))
                .unwrap(),
            ),
            SessionManagerConfig {
                enable_persistence: false,
                ..Default::default()
            },
        );
        let entered = Arc::new(tokio::sync::Notify::new());
        let release = Arc::new(tokio::sync::Notify::new());
        let mut registry = ToolRegistry::new();
        registry.register_tool(Arc::new(SemanticCommitTestTool {
            entered: entered.clone(),
            release: release.clone(),
        }));
        let mut executor = test_round_executor();
        executor.tool_pipeline = Some(Arc::new(ToolPipeline::new(
            Arc::new(tokio::sync::RwLock::new(registry)),
            Arc::new(ToolStateManager::new(executor.event_queue.clone())),
            None,
        )));
        let server = RetryTestServer::new(vec![(
            200,
            format!(
                "data: {}\n\ndata: [DONE]\n\n",
                json!({
                    "id":"semantic", "object":"chat.completion.chunk", "created":1, "model":"retry-test-model",
                    "choices":[{"index":0,"delta":{"content":"Checking now", "tool_calls":[{"index":0,"id":"call-semantic","type":"function","function":{"name":"SemanticCommitTest","arguments":"{}"}}]},"finish_reason":"tool_calls"}]
                })
            ),
        )]);
        let mut context = test_round_context();
        let primary = RetryTestServer::new(vec![account_quota_error()]);
        if switch_account {
            context.account_client_source = Some(test_account_source(
                vec![primary.client(), server.client()],
                false,
            ));
        }
        context.available_tools = vec!["SemanticCommitTest".into()];
        let cancellation = CancellationToken::new();
        executor.register_cancel_token("turn-1", cancellation.clone());
        let mut lifecycle = ModelRoundLifecycle::new();
        let execution = executor.execute_round_with_lifecycle(
            server.client(),
            context,
            vec![super::AIMessage::user("Run the tool".into())],
            None,
            None,
            &mut lifecycle,
            Some(&manager),
            None,
        );
        let observer = async {
            entered.notified().await;
            let messages = context_store.get_context_messages("session-1");
            assert_eq!(
                messages.len(),
                1,
                "semantic response must be committed before the slow tool starts"
            );
            let encoded = serde_json::to_value(&messages[0]).unwrap();
            assert!(encoded.to_string().contains("call-semantic"));
            assert!(encoded.to_string().contains("Checking now"));
            let id = messages[0].id.clone();
            if cancel {
                cancellation.cancel();
                executor
                    .tool_pipeline
                    .as_ref()
                    .unwrap()
                    .cancel_dialog_turn_tools("turn-1")
                    .await
                    .unwrap();
            } else {
                release.notify_one();
            }
            id
        };
        let (result, committed_id) = tokio::time::timeout(Duration::from_secs(10), async {
            tokio::join!(execution, observer)
        })
        .await
        .expect("tool must enter before its result completes");
        if cancel {
            let messages = context_store.get_context_messages("session-1");
            assert_eq!(messages.len(), 1);
            assert_eq!(messages[0].id, committed_id);
            return;
        }
        let result = result.unwrap();
        assert!(result.assistant_message_committed);
        assert_eq!(result.assistant_message.id, committed_id);
        assert_eq!(result.tool_result_messages.len(), 1);
        if switch_account {
            assert_eq!(primary.requests.lock().unwrap().len(), 1);
            assert_eq!(server.requests.lock().unwrap().len(), 1);
            assert_eq!(lifecycle.attempts_started(), 2);
        }
        assert_eq!(
            context_store.get_context_messages("session-1").len(),
            1,
            "completion must not create a second assistant message"
        );
    }

    #[tokio::test]
    async fn cancelling_live_stream_does_not_record_a_failed_retry() {
        let body = format!(
            "data: {}\n\n",
            json!({
                "id": "cancel-test", "object": "chat.completion.chunk", "created": 1,
                "model": "retry-test-model",
                "choices": [{"index": 0, "delta": {"content": "Before pause"}, "finish_reason": null}]
            })
        );
        let server = RetryTestServer::with_open_stream(vec![(200, body)], true);
        let executor = test_round_executor();
        let token = CancellationToken::new();
        executor.register_cancel_token("turn-1", token.clone());
        let execution = executor.execute_round(
            server.client(),
            test_round_context(),
            vec![super::AIMessage::user("Pause during output".to_string())],
            None,
            None,
        );
        let observe = async {
            let mut events = Vec::new();
            loop {
                events.extend(executor.event_queue.dequeue_batch(100).await);
                if events
                    .iter()
                    .any(|event| matches!(event.event, AgenticEvent::TextChunk { .. }))
                {
                    token.cancel();
                    break events;
                }
                tokio::time::sleep(Duration::from_millis(5)).await;
            }
        };
        let (result, mut events) = tokio::time::timeout(Duration::from_secs(5), async {
            tokio::join!(execution, observe)
        })
        .await
        .expect("live stream should be cancelled after its first output");
        assert!(matches!(result, Err(OpenBitFunError::Cancelled(_))));
        events.extend(executor.event_queue.dequeue_batch(100).await);
        assert!(!events.iter().any(|event| matches!(
            event.event,
            AgenticEvent::ModelRoundAttemptSuperseded { .. }
        )));
        assert_eq!(server.requests.lock().unwrap().len(), 1);
    }

    #[tokio::test]
    async fn provider_rejections_stop_after_one_request_for_http_and_stream_errors() {
        for (status, code, category) in [
            (401, "invalid_api_key", ErrorCategory::Auth),
            (403, "permission_error", ErrorCategory::Permission),
            (413, "invalid_request_error", ErrorCategory::InvalidRequest),
            (402, "insufficient_quota", ErrorCategory::ProviderQuota),
            (
                400,
                "context_length_exceeded",
                ErrorCategory::ContextOverflow,
            ),
        ] {
            for in_stream in [false, true] {
                let body =
                    json!({"error": {"code": code, "message": "Request rejected"}}).to_string();
                let reply = if in_stream {
                    (200, format!("data: {body}\n\n"))
                } else {
                    (status, body)
                };
                // A second request would succeed, making an accidental retry
                // fail this test immediately instead of waiting for the budget.
                let server = RetryTestServer::new(vec![reply, retry_test_success()]);
                let executor = test_round_executor();
                let error = tokio::time::timeout(
                    Duration::from_secs(5),
                    executor.execute_round(
                        server.client(),
                        test_round_context(),
                        vec![super::AIMessage::user("Original request".to_string())],
                        None,
                        None,
                    ),
                )
                .await
                .expect("deterministic error should return promptly")
                .expect_err("rejection must not retry");
                assert_eq!(
                    error.error_category(),
                    category,
                    "code={code}, in_stream={in_stream}"
                );
                assert_eq!(
                    error.is_recoverable_context_overflow(),
                    category == ErrorCategory::ContextOverflow
                );
                assert_eq!(server.requests.lock().unwrap().len(), 1);
                let events = executor.event_queue.dequeue_batch(100).await;
                assert!(!events.iter().any(|event| matches!(
                    event.event,
                    AgenticEvent::ModelRoundAttemptSuperseded { .. }
                )));
            }
        }
    }

    #[tokio::test]
    async fn transient_and_malformed_provider_responses_still_retry() {
        for reply in [
            (
                429,
                json!({"error": {"code": "rate_limit_exceeded", "message": "Try later"}})
                    .to_string(),
            ),
            (
                503,
                json!({"error": {"message": "Temporarily unavailable"}}).to_string(),
            ),
            (200, "data: not-json\n\n".to_string()),
            (
                200,
                format!(
                    "data: {}\n\n",
                    json!({"error": {"code": "unrecognized", "message": "Unclassified provider failure"}})
                ),
            ),
        ] {
            let server = RetryTestServer::new(vec![reply, retry_test_success()]);
            let result = tokio::time::timeout(
                Duration::from_secs(5),
                test_round_executor().execute_round(
                    server.client(),
                    test_round_context(),
                    vec![super::AIMessage::user("Retry safely".to_string())],
                    None,
                    None,
                ),
            )
            .await
            .expect("one retry should complete")
            .expect("recoverable response should retry");
            assert!(result.had_assistant_text);
            assert_eq!(server.requests.lock().unwrap().len(), 2);
        }
    }

    #[test]
    fn terminal_request_classification_preserves_full_error_chain() {
        let source = anyhow::anyhow!("invalid api key").context("Provider request failed");
        let error = RoundExecutor::terminal_request_error(&source, 1);
        assert_eq!(error.error_category(), ErrorCategory::Auth);
        assert!(!RoundExecutor::should_retry_provider_error(
            &error.error_category()
        ));
        assert!(error.to_string().contains("invalid api key"));
    }

    #[test]
    fn resolves_global_project_and_agent_permission_rules_before_execution() {
        let mut global = GlobalConfig::default();
        global.tool_permissions.policy.preset = PermissionPolicyPreset::FullAccess;
        global.tool_permissions.policy.rules =
            vec![PermissionRule::new("bash", "rm *", PermissionEffect::Ask)];
        let project_rules = vec![PermissionRule::new(
            "edit",
            "generated/*",
            PermissionEffect::Deny,
        )];
        let agent = AgentProfileConfig {
            tool_permission_rules: vec![PermissionRule::new(
                "edit",
                "generated/review.md",
                PermissionEffect::Allow,
            )],
            ..AgentProfileConfig::default()
        };

        let resolved = RoundExecutor::resolve_permission_policy(
            &global,
            openbitfun_runtime_ports::PermissionMode::Ask,
            &project_rules,
            Some(&agent),
            &Default::default(),
            None,
        );
        let evaluator = PermissionEvaluator::case_sensitive();

        assert_eq!(
            evaluator.evaluate_policy_resource("bash", "rm -rf target", &resolved),
            PermissionEffect::Ask
        );
        assert_eq!(
            evaluator.evaluate_policy_resource("edit", "generated/review.md", &resolved),
            PermissionEffect::Allow
        );
        assert_eq!(
            evaluator.evaluate_policy_resource("edit", "generated/api.rs", &resolved),
            PermissionEffect::Deny
        );
        assert_eq!(
            evaluator.evaluate_policy_resource("read", "src/main.rs", &resolved),
            PermissionEffect::Allow
        );
    }

    #[test]
    fn permission_mode_context_overrides_persisted_default_mode() {
        use openbitfun_runtime_ports::PermissionMode;

        let mut global = GlobalConfig::default();
        global.tool_permissions.policy.preset =
            openbitfun_runtime_ports::PermissionPolicyPreset::Ask;
        global.tool_permissions.interaction.auto_approve_ask = true;
        let mut context_vars = std::collections::HashMap::new();

        // No override: the stored configuration is the default mode.
        assert_eq!(
            RoundExecutor::resolve_permission_mode(&global, &context_vars),
            PermissionMode::AutoApprove
        );

        // The legacy flag still speaks for the auto-approval half.
        context_vars.insert(
            AUTO_APPROVE_ASK_CONTEXT_KEY.to_string(),
            "false".to_string(),
        );
        assert_eq!(
            RoundExecutor::resolve_permission_mode(&global, &context_vars),
            PermissionMode::Ask
        );
        context_vars.insert(AUTO_APPROVE_ASK_CONTEXT_KEY.to_string(), "true".to_string());
        assert_eq!(
            RoundExecutor::resolve_permission_mode(&global, &context_vars),
            PermissionMode::AutoApprove
        );
        context_vars.insert(
            AUTO_APPROVE_ASK_CONTEXT_KEY.to_string(),
            "invalid".to_string(),
        );
        assert_eq!(
            RoundExecutor::resolve_permission_mode(&global, &context_vars),
            PermissionMode::AutoApprove
        );

        // The resolved mode key outranks the legacy flag.
        context_vars.insert(
            PERMISSION_MODE_CONTEXT_KEY.to_string(),
            PermissionMode::FullAccess.as_str().to_string(),
        );
        context_vars.insert(
            AUTO_APPROVE_ASK_CONTEXT_KEY.to_string(),
            "false".to_string(),
        );
        assert_eq!(
            RoundExecutor::resolve_permission_mode(&global, &context_vars),
            PermissionMode::FullAccess
        );

        // An unparseable mode falls back instead of failing open.
        context_vars.insert(
            PERMISSION_MODE_CONTEXT_KEY.to_string(),
            "elevated".to_string(),
        );
        assert_eq!(
            RoundExecutor::resolve_permission_mode(&global, &context_vars),
            PermissionMode::Ask
        );
    }

    #[tokio::test]
    async fn cancel_token_for_dialog_turn_returns_registered_token() {
        let executor = test_round_executor();
        let token = CancellationToken::new();
        executor.register_cancel_token("turn-1", token.clone());

        assert!(executor.cancel_token_for_dialog_turn("turn-1").is_some());
        assert!(executor.cancel_token_for_dialog_turn("missing").is_none());
    }

    #[tokio::test]
    async fn compression_token_is_cancellable_before_first_round_and_keeps_early_cancel() {
        let executor = test_round_executor();
        let token = executor.ensure_cancel_token("turn-1");
        executor.cancel_dialog_turn("turn-1").await.unwrap();
        assert!(token.is_cancelled());
        assert!(executor.ensure_cancel_token("turn-1").is_cancelled());

        let early = CancellationToken::new();
        early.cancel();
        executor.register_cancel_token("turn-2", early);
        assert!(executor.ensure_cancel_token("turn-2").is_cancelled());
    }

    #[tokio::test]
    async fn cancel_keeps_token_registered_until_cleanup() {
        let executor = test_round_executor();
        let token = CancellationToken::new();
        executor.register_cancel_token("turn-1", token.clone());

        executor
            .cancel_dialog_turn("turn-1")
            .await
            .expect("cancel should succeed");

        assert!(token.is_cancelled());
        assert!(executor.has_active_dialog_turn("turn-1"));
        assert!(executor.is_dialog_turn_cancelled("turn-1"));

        executor.cleanup_dialog_turn("turn-1").await;
        assert!(!executor.has_active_dialog_turn("turn-1"));
        assert!(!executor.is_dialog_turn_cancelled("turn-1"));
    }

    #[tokio::test]
    async fn emits_token_usage_before_post_stream_cancel_stops_round() {
        let executor = test_round_executor();
        let context = test_round_context();
        let usage = GeminiUsage {
            prompt_token_count: 100,
            candidates_token_count: 20,
            total_token_count: 120,
            reasoning_token_count: None,
            cached_content_token_count: Some(30),
            cache_creation_token_count: None,
        };

        executor
            .emit_token_usage_update(&context, &usage, Some(128_000), false, None)
            .await;

        let events = executor.event_queue.dequeue_batch(10).await;
        assert!(events.iter().any(|envelope| matches!(
            &envelope.event,
            crate::agentic::events::AgenticEvent::TokenUsageUpdated {
                session_id,
                turn_id,
                model_config_id,
                effective_model_name,
                input_tokens: 100,
                output_tokens: Some(20),
                total_tokens: 120,
                max_context_tokens: Some(128_000),
                is_subagent: false,
                cached_tokens: Some(30),
                ..
            } if session_id == "session-1"
                && turn_id == "turn-1"
                && model_config_id == "model-1"
                && effective_model_name == "model-1"
        )));
    }

    #[tokio::test]
    async fn cancellable_sleep_returns_cancelled_when_token_fires() {
        let token = CancellationToken::new();
        let token_for_task = token.clone();

        let waiter = tokio::spawn(async move {
            RoundExecutor::sleep_with_cancellation(5_000, &token_for_task).await
        });

        tokio::time::sleep(Duration::from_millis(20)).await;
        token.cancel();

        let result = waiter.await.expect("sleep task should join");
        assert!(matches!(result, Err(OpenBitFunError::Cancelled(_))));
    }

    #[tokio::test]
    async fn cancellable_sleep_completes_normally_without_cancel() {
        let token = CancellationToken::new();

        let result = RoundExecutor::sleep_with_cancellation(10, &token).await;

        assert!(result.is_ok());
    }

    #[test]
    fn token_details_emits_both_cache_keys_when_present() {
        use crate::util::types::ai::GeminiUsage;
        let usage = GeminiUsage {
            prompt_token_count: 100,
            candidates_token_count: 20,
            total_token_count: 120,
            reasoning_token_count: None,
            cached_content_token_count: Some(30),
            cache_creation_token_count: Some(20),
        };
        let details = super::token_details_from_usage(&usage).expect("details");
        assert_eq!(
            details
                .get("cachedContentTokenCount")
                .and_then(|v| v.as_u64()),
            Some(30)
        );
        assert_eq!(
            details
                .get("cacheCreationTokenCount")
                .and_then(|v| v.as_u64()),
            Some(20)
        );
    }

    #[test]
    fn token_details_emits_only_read_when_creation_absent() {
        use crate::util::types::ai::GeminiUsage;
        let usage = GeminiUsage {
            prompt_token_count: 100,
            candidates_token_count: 20,
            total_token_count: 120,
            reasoning_token_count: None,
            cached_content_token_count: Some(30),
            cache_creation_token_count: None,
        };
        let details = super::token_details_from_usage(&usage).expect("details");
        assert_eq!(
            details
                .get("cachedContentTokenCount")
                .and_then(|v| v.as_u64()),
            Some(30)
        );
        assert!(details.get("cacheCreationTokenCount").is_none());
    }

    #[test]
    fn token_details_is_none_when_no_cache_info() {
        use crate::util::types::ai::GeminiUsage;
        let usage = GeminiUsage {
            prompt_token_count: 100,
            candidates_token_count: 20,
            total_token_count: 120,
            reasoning_token_count: None,
            cached_content_token_count: None,
            cache_creation_token_count: None,
        };
        assert!(super::token_details_from_usage(&usage).is_none());
    }

    #[test]
    fn error_trace_response_from_stream_result_preserves_structured_context() {
        let stream_result = StreamResult {
            full_thinking: "reasoning".to_string(),
            reasoning_content_kind: Some(openbitfun_core_types::ReasoningContentKind::Reasoning),
            reasoning_content_present: true,
            thinking_signature: Some("sig".to_string()),
            full_text: String::new(),
            hidden_text_blocks: Vec::new(),
            tool_calls: vec![ToolCall {
                tool_id: "tool-1".to_string(),
                tool_name: "ExecCommand".to_string(),
                arguments: json!({}),
                raw_arguments: Some("{\"command\":".to_string()),
                is_error: true,
                parse_error: Some("EOF while parsing an object".to_string()),
                recovered_from_truncation: false,
                repair_kind: Default::default(),
            }],
            usage: Some(GeminiUsage {
                prompt_token_count: 100,
                candidates_token_count: 20,
                total_token_count: 120,
                reasoning_token_count: Some(5),
                cached_content_token_count: Some(30),
                cache_creation_token_count: None,
            }),
            response_model: None,
            provider_metadata: Some(json!({ "finish_reason": "tool_calls" })),
            model_response_replay: None,
            has_effective_output: false,
            first_chunk_ms: Some(10),
            first_visible_output_ms: None,
            partial_recovery_reason: Some("tool arguments invalid".to_string()),
        };

        let trace = RoundExecutor::error_trace_response_from_stream_result(
            "error",
            "Provider returned only invalid tool arguments".to_string(),
            &stream_result,
        );

        assert_eq!(trace.kind, "error");
        assert_eq!(
            trace.error.as_deref(),
            Some("Provider returned only invalid tool arguments")
        );
        assert_eq!(trace.assistant_text.as_deref(), Some(""));
        assert_eq!(trace.thinking.as_deref(), Some("reasoning"));
        assert_eq!(
            trace.partial_recovery_reason.as_deref(),
            Some("tool arguments invalid")
        );
        assert_eq!(
            trace.provider_metadata,
            Some(json!({ "finish_reason": "tool_calls" }))
        );
        assert_eq!(
            trace.usage,
            Some(json!({
                "promptTokenCount": 100,
                "candidatesTokenCount": 20,
                "totalTokenCount": 120,
                "reasoningTokenCount": 5,
                "cachedContentTokenCount": 30
            }))
        );
        assert_eq!(
            trace.tool_calls,
            Some(json!([{
                "tool_id": "tool-1",
                "tool_name": "ExecCommand",
                "arguments": {},
                "raw_arguments": "{\"command\":",
                "is_error": true,
                "parse_error": "EOF while parsing an object"
            }]))
        );
    }

    #[test]
    fn retry_diagnostic_preserves_invalid_tool_arguments_and_parser_error() {
        let diagnostic = RoundExecutor::retry_diagnostic(
            "round-1:attempt:1".to_string(),
            1,
            "invalid_tool_arguments",
            None,
            &[ToolCall {
                tool_id: "tool-1".to_string(),
                tool_name: "ExecCommand".to_string(),
                arguments: json!({}),
                raw_arguments: Some("{\"command\":".to_string()),
                is_error: true,
                parse_error: Some("EOF while parsing an object".to_string()),
                recovered_from_truncation: false,
                repair_kind: Default::default(),
            }],
        );

        assert_eq!(diagnostic.category, "invalid_tool_arguments");
        assert_eq!(diagnostic.tool_calls.len(), 1);
        assert_eq!(
            diagnostic.tool_calls[0].raw_arguments.as_deref(),
            Some("{\"command\":")
        );
        assert_eq!(
            diagnostic.tool_calls[0].validation_error.as_deref(),
            Some("EOF while parsing an object")
        );
    }

    #[test]
    fn error_trace_response_without_stream_result_stays_empty() {
        let trace = RoundExecutor::error_trace_response("error", "request failed".to_string());

        assert_eq!(trace.kind, "error");
        assert!(trace.assistant_text.is_none());
        assert!(trace.thinking.is_none());
        assert!(trace.tool_calls.is_none());
        assert!(trace.usage.is_none());
        assert!(trace.provider_metadata.is_none());
        assert!(trace.partial_recovery_reason.is_none());
        assert_eq!(trace.error.as_deref(), Some("request failed"));
    }

    #[test]
    fn retry_delay_grows_beyond_previous_four_second_cap() {
        assert_eq!(RoundExecutor::retry_delay_ms(0), 500);
        assert_eq!(RoundExecutor::retry_delay_ms(3), 4_000);
        assert_eq!(RoundExecutor::retry_delay_ms(5), 16_000);
        assert_eq!(RoundExecutor::retry_delay_ms(6), 30_000);
        assert_eq!(RoundExecutor::retry_delay_ms(9), 30_000);
    }

    #[test]
    fn exhausted_request_preserves_timeout_cause_and_total_attempts() {
        let source = anyhow::anyhow!(
            "OpenAI Streaming API TTFT timeout after 30s waiting for first effective stream output"
        )
        .context("OpenAI Streaming API failed after 1 attempts");
        let error = RoundExecutor::terminal_request_error(&source, 10);
        assert_eq!(error.error_category(), ErrorCategory::Timeout);
        assert!(error
            .to_string()
            .contains("Model request failed after 10 attempts"));
        assert!(error.to_string().contains("TTFT timeout after 30s"));
    }

    #[test]
    fn exhausted_request_preserves_normalized_provider_facts_and_old_payload_shape() {
        let mut provider = AiProviderError::from_parts(
            "You've reached your concurrent request limit".to_string(),
            Some("OpenAI Streaming API".to_string()),
            Some("access_terminated_error".to_string()),
            Some(403),
        );
        provider.category = ErrorCategory::RateLimit;
        let source = anyhow::Error::new(provider);
        let error = RoundExecutor::terminal_request_error(&source, 10);
        let detail = error.error_detail();
        assert_eq!(detail.category, ErrorCategory::RateLimit);
        assert_eq!(detail.http_status, Some(403));
        assert_eq!(
            detail.provider_code.as_deref(),
            Some("access_terminated_error")
        );
        assert_eq!(detail.retryable, Some(true));
        assert!(detail
            .provider_message
            .unwrap()
            .contains("after 10 attempts"));
        let OpenBitFunError::AIProvider(provider) = error else {
            panic!("expected provider error")
        };
        let encoded = serde_json::to_value(&provider).unwrap();
        let decoded: AiProviderError = serde_json::from_value(encoded).unwrap();
        assert_eq!(provider, decoded);
        let legacy: AiProviderError = serde_json::from_value(serde_json::json!({
            "message": "legacy provider error", "category": "model_error"
        }))
        .unwrap();
        assert_eq!(legacy.category, ErrorCategory::ModelError);
    }

    #[test]
    fn exhausted_context_overflow_remains_recoverable() {
        let source = anyhow::Error::new(AiProviderError::from_parts(
            "Maximum context length exceeded".to_string(),
            None,
            Some("context_length_exceeded".to_string()),
            Some(400),
        ));
        assert!(matches!(
            RoundExecutor::terminal_request_error(&source, 10),
            OpenBitFunError::RecoverableContextOverflow(_)
        ));
    }

    #[test]
    fn rate_limit_retry_delay_uses_longer_ladder() {
        assert_eq!(
            RoundExecutor::retry_delay_ms_for_error(0, "error 429 Too Many Requests"),
            2_000
        );
        assert_eq!(
            RoundExecutor::retry_delay_ms_for_error(3, "rate limit exceeded"),
            16_000
        );
        assert_eq!(
            RoundExecutor::retry_delay_ms_for_error(5, "too many requests"),
            60_000
        );
        assert_eq!(RoundExecutor::retry_delay_ms_for_error(9, "429"), 60_000);
    }

    #[test]
    fn provider_retry_after_is_only_a_delay_hint() {
        let permission_error = openbitfun_core_types::errors::AiProviderError::from_parts(
            "permission denied".to_string(),
            Some("openai".to_string()),
            None,
            Some(403),
        )
        .with_retry_after_ms(Some(1_000));
        assert_eq!(
            RoundExecutor::retry_delay_ms_for_provider_error(
                5,
                &permission_error.message,
                Some(&permission_error),
            ),
            1_000
        );

        let rate_limit_error = openbitfun_core_types::errors::AiProviderError::from_parts(
            "too many requests".to_string(),
            Some("openai".to_string()),
            None,
            Some(429),
        )
        .with_retry_after_ms(Some(1_000));
        assert_eq!(
            RoundExecutor::retry_delay_ms_for_provider_error(
                3,
                &rate_limit_error.message,
                Some(&rate_limit_error),
            ),
            16_000
        );
    }
    #[tokio::test]
    async fn model_pool_failover_uses_one_round_and_one_request_per_member() {
        let failure = RetryTestServer::new(vec![(
            429,
            json!({"error":{"message":"Rate limit exceeded"}}).to_string(),
        )]);
        let success = RetryTestServer::new(vec![retry_test_success()]);
        let executor = test_round_executor();
        let router = Arc::new(std::sync::Mutex::new(
            openbitfun_agent_runtime::model_pool::ModelPoolRouter::default(),
        ));
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("pool-state.json");
        let first =
            crate::agentic::execution::model_pool::test_attempt(router.clone(), path.clone());
        assert_eq!(first.reservation.binding.model_id, "a");
        let mut lifecycle = ModelRoundLifecycle::new();
        let messages = vec![super::AIMessage::user("Test pool".into())];
        let failure = {
            let result = executor
                .execute_round_with_lifecycle(
                    failure.client(),
                    test_round_context(),
                    messages.clone(),
                    None,
                    None,
                    &mut lifecycle,
                    None,
                    Some(&first),
                )
                .await;
            assert_eq!(failure.requests.lock().unwrap().len(), 1);
            result.unwrap_err()
        };
        assert!(lifecycle.safe_to_switch_model);
        let provider = match failure {
            OpenBitFunError::AIProvider(error) => error,
            error => openbitfun_core_types::errors::AiProviderError::classified(
                error.to_string(),
                error.error_category(),
            ),
        };
        assert!(first.fail(&provider, 60_000).await);
        let second = crate::agentic::execution::model_pool::test_attempt(router.clone(), path);
        assert_eq!(second.reservation.binding.model_id, "b");
        executor
            .execute_round_with_lifecycle(
                success.client(),
                test_round_context(),
                messages,
                None,
                None,
                &mut lifecycle,
                None,
                Some(&second),
            )
            .await
            .unwrap();
        assert_eq!(success.requests.lock().unwrap().len(), 1);
        assert_eq!(lifecycle.attempts_started(), 2);
        assert_eq!(
            router
                .lock()
                .unwrap()
                .binding("session-1:0")
                .unwrap()
                .model_id,
            "b"
        );
        let events = executor.event_queue.dequeue_batch(100).await;
        assert_eq!(
            events
                .iter()
                .filter(|event| matches!(event.event, AgenticEvent::ModelRoundStarted { .. }))
                .count(),
            1
        );
    }

    #[tokio::test]
    async fn model_pool_bound_member_goes_offline_between_turns() {
        let original = RetryTestServer::new(vec![retry_test_success()]);
        let original_client = original.client();
        let fallback = RetryTestServer::new(vec![retry_test_success()]);
        let executor = test_round_executor();
        let router = Arc::new(std::sync::Mutex::new(
            openbitfun_agent_runtime::model_pool::ModelPoolRouter::default(),
        ));
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("pool-state.json");
        let messages = vec![super::AIMessage::user("Test pool".into())];
        let first =
            crate::agentic::execution::model_pool::test_attempt(router.clone(), path.clone());
        executor
            .execute_round_with_lifecycle(
                original_client.clone(),
                test_round_context(),
                messages.clone(),
                None,
                None,
                &mut ModelRoundLifecycle::new(),
                None,
                Some(&first),
            )
            .await
            .unwrap();
        assert_eq!(original.requests.lock().unwrap().len(), 1);
        assert_eq!(
            router
                .lock()
                .unwrap()
                .binding("session-1:0")
                .unwrap()
                .model_id,
            "a"
        );
        drop(first);
        // Stop listening, exactly like taking a mock provider offline after
        // the first successful turn. This is not a fabricated HTTP error.
        drop(original);

        let retry =
            crate::agentic::execution::model_pool::test_attempt(router.clone(), path.clone());
        assert_eq!(retry.reservation.binding.model_id, "a");
        let mut context = test_round_context();
        context.dialog_turn_id = "turn-2".into();
        context.turn_index = 1;
        let mut lifecycle = ModelRoundLifecycle::new();
        let error = executor
            .execute_round_with_lifecycle(
                original_client,
                context.clone(),
                messages.clone(),
                None,
                None,
                &mut lifecycle,
                None,
                Some(&retry),
            )
            .await
            .unwrap_err();
        assert_eq!(error.error_category(), ErrorCategory::Network);
        assert!(lifecycle.safe_to_switch_model);
        assert_eq!(lifecycle.attempts_started(), 1);
        let OpenBitFunError::AIProvider(provider) = error else {
            panic!("connection refusal must preserve the provider error");
        };
        assert!(retry.fail(&provider, 60_000).await);
        let next = crate::agentic::execution::model_pool::test_attempt(router.clone(), path);
        assert_eq!(next.reservation.binding.model_id, "b");
        executor
            .execute_round_with_lifecycle(
                fallback.client(),
                context,
                messages,
                None,
                None,
                &mut lifecycle,
                None,
                Some(&next),
            )
            .await
            .unwrap();
        assert_eq!(lifecycle.attempts_started(), 2);
        assert_eq!(fallback.requests.lock().unwrap().len(), 1);
        assert_eq!(
            router
                .lock()
                .unwrap()
                .binding("session-1:0")
                .unwrap()
                .model_id,
            "b"
        );
    }

    #[tokio::test]
    async fn model_pool_recovers_empty_and_malformed_output_on_the_same_member() {
        let invalid_tool = format!(
            "data: {}\n\ndata: [DONE]\n\n",
            json!({
                "id":"invalid", "object":"chat.completion.chunk", "created":1,
                "model":"retry-test-model", "choices":[{"index":0,
                "delta":{"tool_calls":[{"index":0,"id":"call-1","type":"function",
                "function":{"name":"Read","arguments":r#"{"value":+e1}"#}}]},"finish_reason":"tool_calls"}]
            })
        );
        for body in [
            "data: [DONE]\n\n".to_string(),
            "data: not-json\n\n".to_string(),
            invalid_tool,
        ] {
            let server = RetryTestServer::new(vec![(200, body.clone()), retry_test_success()]);
            let router = Arc::new(std::sync::Mutex::new(
                openbitfun_agent_runtime::model_pool::ModelPoolRouter::default(),
            ));
            let dir = tempfile::tempdir().unwrap();
            let attempt = crate::agentic::execution::model_pool::test_attempt(
                router.clone(),
                dir.path().join("state.json"),
            );
            assert!(attempt.has_available_alternative());
            let mut lifecycle = ModelRoundLifecycle::new();
            test_round_executor()
                .execute_round_with_lifecycle(
                    server.client(),
                    test_round_context(),
                    vec![super::AIMessage::user("Recover".into())],
                    None,
                    None,
                    &mut lifecycle,
                    None,
                    Some(&attempt),
                )
                .await
                .unwrap();
            assert_eq!(server.requests.lock().unwrap().len(), 2, "body={body}");
            assert_eq!(lifecycle.attempts_started(), 2);
            assert_eq!(
                router
                    .lock()
                    .unwrap()
                    .binding("session-1:0")
                    .unwrap()
                    .model_id,
                "a"
            );
        }
    }

    #[tokio::test]
    async fn model_pool_exhausts_ten_member_attempts_then_allows_fallback() {
        // An unclassified response failure must use the inner recovery budget.
        // Keep real HTTP requests; advance only the Retry-After backoff below.
        let server = RetryTestServer::with_options(
            vec![(
                418,
                json!({"error":{"code":"unrecognized","message":"Unclassified provider failure"}})
                    .to_string(),
            )],
            false,
            Some(1),
        );
        let fallback = RetryTestServer::new(vec![retry_test_success()]);
        let router = Arc::new(std::sync::Mutex::new(
            openbitfun_agent_runtime::model_pool::ModelPoolRouter::default(),
        ));
        let dir = tempfile::tempdir().unwrap();
        let first = crate::agentic::execution::model_pool::test_attempt(
            router.clone(),
            dir.path().join("state.json"),
        );
        let executor = test_round_executor();
        let mut lifecycle = ModelRoundLifecycle::new();
        let messages = vec![super::AIMessage::user("Recover".into())];
        let context = test_round_context();
        let mut retries = 0;
        let error = {
            let run = executor.execute_round_with_lifecycle(
                server.client(),
                context,
                messages,
                None,
                None,
                &mut lifecycle,
                None,
                Some(&first),
            );
            tokio::pin!(run);
            loop {
                tokio::select! {
                    result = &mut run => break result.unwrap_err(),
                    _ = tokio::time::sleep(Duration::from_millis(1)) => {
                        for event in executor.event_queue.dequeue_batch(100).await {
                            if let AgenticEvent::ModelRoundAttemptSuperseded { diagnostic, .. } = event.event {
                                retries += 1;
                                assert_eq!(diagnostic.attempt_index, retries);
                                // The request future has yielded to backoff. Resume time
                                // before polling it again so socket deadlines stay real.
                                tokio::time::pause();
                                tokio::time::advance(Duration::from_secs(1)).await;
                                tokio::time::resume();
                            }
                        }
                    }
                }
            }
        };
        assert_eq!(retries, 9);
        assert_eq!(server.requests.lock().unwrap().len(), 10);
        assert_eq!(lifecycle.attempts_started(), 10);
        assert!(lifecycle.safe_to_switch_model);
        let OpenBitFunError::AIProvider(provider) = error else {
            panic!("expected provider error");
        };
        assert_eq!(provider.category, ErrorCategory::ModelError);
        assert!(first.fail(&provider, 60_000).await);
        // Opaque output failures do not cool the member globally. The outer
        // traversal excludes it explicitly rather than relying on health.
        let candidates = ["a", "b"].map(|id| openbitfun_agent_runtime::model_pool::Candidate {
            model_id: id.into(),
            fingerprint: id.into(),
            eligible: true,
        });
        assert!(router.lock().unwrap().has_available_alternative(
            "b",
            &candidates,
            &Default::default(),
            0
        ));
        let next = crate::agentic::execution::model_pool::test_attempt_excluding(
            router.clone(),
            dir.path().join("next.json"),
            std::collections::BTreeSet::from(["a".into()]),
        );
        assert_eq!(next.reservation.binding.model_id, "b");
        executor
            .execute_round_with_lifecycle(
                fallback.client(),
                test_round_context(),
                vec![super::AIMessage::user("Recover".into())],
                None,
                None,
                &mut lifecycle,
                None,
                Some(&next),
            )
            .await
            .unwrap();
        assert_eq!(lifecycle.attempts_started(), 11);
        assert_eq!(
            router
                .lock()
                .unwrap()
                .binding("session-1:0")
                .unwrap()
                .model_id,
            "b"
        );
    }

    #[tokio::test]
    async fn model_pool_without_ready_alternative_retains_transient_retries() {
        let server = RetryTestServer::with_options(
            vec![
                (
                    429,
                    json!({"error":{"message":"Rate limit exceeded"}}).to_string(),
                ),
                retry_test_success(),
            ],
            false,
            Some(1),
        );
        let router = Arc::new(std::sync::Mutex::new(
            openbitfun_agent_runtime::model_pool::ModelPoolRouter::default(),
        ));
        {
            let mut locked = router.lock().unwrap();
            let b = locked
                .reserve(
                    "other",
                    "p",
                    openbitfun_core_types::model_pool::ModelPoolStrategy::Ordered,
                    &[openbitfun_agent_runtime::model_pool::Candidate {
                        model_id: "b".into(),
                        fingerprint: "b".into(),
                        eligible: true,
                    }],
                    &Default::default(),
                    0,
                    100,
                )
                .unwrap();
            locked.fail(
                &b,
                &AiProviderError::classified("auth".into(), ErrorCategory::Auth),
                0,
                100,
            );
        }
        let dir = tempfile::tempdir().unwrap();
        let attempt = crate::agentic::execution::model_pool::test_attempt(
            router,
            dir.path().join("state.json"),
        );
        assert!(!attempt.has_available_alternative());
        let mut lifecycle = ModelRoundLifecycle::new();
        test_round_executor()
            .execute_round_with_lifecycle(
                server.client(),
                test_round_context(),
                vec![super::AIMessage::user("Retry".into())],
                None,
                None,
                &mut lifecycle,
                None,
                Some(&attempt),
            )
            .await
            .unwrap();
        assert_eq!(server.requests.lock().unwrap().len(), 2);
    }

    #[tokio::test]
    async fn model_pool_output_from_an_earlier_attempt_blocks_later_failover() {
        let partial = format!(
            "data: {}\n\ndata: {}\n\n",
            json!({"id":"partial","object":"chat.completion.chunk","created":1,"model":"retry-test-model",
                "choices":[{"index":0,"delta":{"content":"Visible output"},"finish_reason":null}]}),
            json!({"error":{"code":"server_error","message":"Stream interrupted"}})
        );
        let server = RetryTestServer::with_options(
            vec![
                (200, partial),
                (
                    429,
                    json!({"error":{"message":"Rate limit exceeded"}}).to_string(),
                ),
                (
                    401,
                    json!({"error":{"message":"invalid api key"}}).to_string(),
                ),
            ],
            false,
            Some(1),
        );
        let router = Arc::new(std::sync::Mutex::new(
            openbitfun_agent_runtime::model_pool::ModelPoolRouter::default(),
        ));
        let dir = tempfile::tempdir().unwrap();
        let attempt = crate::agentic::execution::model_pool::test_attempt(
            router,
            dir.path().join("state.json"),
        );
        let mut lifecycle = ModelRoundLifecycle::new();
        let error = test_round_executor()
            .execute_round_with_lifecycle(
                server.client(),
                test_round_context(),
                vec![super::AIMessage::user("Partial output".into())],
                None,
                None,
                &mut lifecycle,
                None,
                Some(&attempt),
            )
            .await
            .unwrap_err();
        assert_eq!(error.error_category(), ErrorCategory::Auth);
        assert_eq!(server.requests.lock().unwrap().len(), 3);
        assert!(lifecycle.observed_effective_output);
        assert!(!lifecycle.safe_to_switch_model);
    }

    #[tokio::test]
    async fn model_pool_cancellation_after_output_never_switches_or_poisons_health() {
        let body = format!(
            "data: {}\n\n",
            json!({"id":"pool-cancel","object":"chat.completion.chunk","created":1,
            "model":"retry-test-model","choices":[{"index":0,"delta":{"content":"Committed"},"finish_reason":null}]})
        );
        let server = RetryTestServer::with_open_stream(vec![(200, body)], true);
        let executor = test_round_executor();
        let token = CancellationToken::new();
        executor.register_cancel_token("turn-1", token.clone());
        let router = Arc::new(std::sync::Mutex::new(
            openbitfun_agent_runtime::model_pool::ModelPoolRouter::default(),
        ));
        let dir = tempfile::tempdir().unwrap();
        let attempt = crate::agentic::execution::model_pool::test_attempt(
            router.clone(),
            dir.path().join("state.json"),
        );
        let mut lifecycle = ModelRoundLifecycle::new();
        let run = executor.execute_round_with_lifecycle(
            server.client(),
            test_round_context(),
            vec![super::AIMessage::user("Cancel after output".into())],
            None,
            None,
            &mut lifecycle,
            None,
            Some(&attempt),
        );
        let cancel = async {
            loop {
                if executor
                    .event_queue
                    .dequeue_batch(100)
                    .await
                    .iter()
                    .any(|event| matches!(event.event, AgenticEvent::TextChunk { .. }))
                {
                    token.cancel();
                    break;
                }
                tokio::time::sleep(Duration::from_millis(5)).await;
            }
        };
        let (result, _) =
            tokio::time::timeout(Duration::from_secs(5), async { tokio::join!(run, cancel) })
                .await
                .unwrap();
        assert!(matches!(result, Err(OpenBitFunError::Cancelled(_))));
        assert!(!lifecycle.safe_to_switch_model);
        assert_eq!(server.requests.lock().unwrap().len(), 1);
        drop(attempt);
        let next = crate::agentic::execution::model_pool::test_attempt(
            router,
            dir.path().join("state.json"),
        );
        assert_eq!(next.reservation.binding.model_id, "a");
    }
}
