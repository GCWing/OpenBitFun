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
use log::{debug, error, warn};
use openbitfun_agent_runtime::turn_cancellation::DialogTurnCancellationTokenStore;
use openbitfun_agent_tools::{parse_call_deferred_tool_input, CALL_DEFERRED_TOOL_NAME};
use openbitfun_ai_adapters::{
    ModelExchangeRequestTraceHandle, ModelExchangeResponseTrace, ModelExchangeTraceConfig,
};
use openbitfun_core_types::errors::{AiProviderError, ErrorCategory};
use openbitfun_core_types::ModelResponseReplay;
use openbitfun_runtime_ports::PermissionRule;
use std::sync::Arc;
use std::time::{Duration, Instant};
use tokio_util::sync::CancellationToken;

/// Round executor
pub struct RoundExecutor {
    stream_processor: Arc<StreamProcessor>,
    tool_pipeline: Option<Arc<ToolPipeline>>,
    event_queue: Arc<EventQueue>,
    cancellation_tokens: DialogTurnCancellationTokenStore,
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
}

impl ModelRoundLifecycle {
    pub(super) fn new() -> Self {
        Self {
            round_id: uuid::Uuid::new_v4().to_string(),
            started_at: Instant::now(),
            started_event_emitted: false,
            attempts_started: 0,
        }
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

    fn attempts_started(&self) -> u32 {
        self.attempts_started
    }
}

impl RoundExecutor {
    const MAX_STREAM_ATTEMPTS: usize = openbitfun_agent_stream::retry::MAX_MODEL_ATTEMPTS;

    fn should_retry_provider_error(category: &ErrorCategory) -> bool {
        openbitfun_agent_stream::retry::should_retry(category)
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

    fn model_response_replay(stream_result: &StreamResult) -> Option<ModelResponseReplay> {
        let capture = stream_result.model_response_replay.as_ref()?;
        Some(ModelResponseReplay {
            protocol: capture.protocol.clone(),
            items: capture.items.clone(),
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
        )
        .await
    }

    pub(super) async fn execute_round_with_lifecycle(
        &self,
        ai_client: Arc<AIClient>,
        context: RoundContext,
        ai_messages: Vec<AIMessage>,
        tool_definitions: Option<Vec<ToolDefinition>>,
        context_window: Option<usize>,
        lifecycle: &mut ModelRoundLifecycle,
        session_manager: Option<&SessionManager>,
    ) -> OpenBitFunResult<RoundResult> {
        let round_started_at = lifecycle.started_at;
        let subagent_parent_info = context.subagent_parent_info.clone();
        let is_subagent = subagent_parent_info.is_some();

        let round_id = lifecycle.round_id.clone();

        // Create or reuse cancellation token
        let cancel_token = self
            .cancellation_tokens
            .get_or_insert_new(&context.dialog_turn_id);

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

        let trace_config =
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
        let max_attempts = Self::MAX_STREAM_ATTEMPTS;
        let mut local_attempt_index = 0usize;
        let (stream_result, send_to_stream_ms, stream_processing_ms, final_trace_handle) = loop {
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
                    error!("AI request failed: {:#}", e);
                    let provider_error = e.downcast_ref::<AiProviderError>().cloned();
                    let err_msg = format!("{e:#}");
                    let error = Self::terminal_request_error(&e, lifecycle.attempts_started());
                    let retryable = Self::should_retry_provider_error(&error.error_category());
                    if retryable && local_attempt_index < max_attempts - 1 {
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
                        continue;
                    }
                    warn!(
                        "AI request stopped: session_id={}, round_id={}, attempts={}, reason={}, category={:?}, error={}",
                        context.session_id,
                        round_id,
                        lifecycle.attempts_started(),
                        if retryable { "retry_budget_exhausted" } else { "non_retryable_error" },
                        error.error_category(),
                        error
                    );
                    return Err(error);
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
                    let stream_processing_ms = elapsed_ms_u64(stream_started_at);
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
                        return Err(OpenBitFunError::AIClient(format!(
                            "Stream retry budget exhausted after {} attempts: {}",
                            max_attempts, err_msg
                        )));
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
                        return Err(OpenBitFunError::AIClient(format!(
                            "Stream retry budget exhausted after {} attempts: {}",
                            max_attempts, err_msg
                        )));
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
                        return Err(OpenBitFunError::AIClient(format!(
                            "Stream retry budget exhausted after {} attempts: {}",
                            max_attempts, err_msg
                        )));
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
                        trace_handle,
                    );
                }
                Err(stream_err) => {
                    if matches!(&stream_err.error, OpenBitFunError::Cancelled(_)) {
                        Self::complete_model_exchange_trace(
                            trace_config.as_ref(),
                            trace_handle.as_ref(),
                            Self::error_trace_response("cancelled", stream_err.error.to_string()),
                        )
                        .await;
                        return Err(stream_err.error);
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
                    if retryable && local_attempt_index < max_attempts - 1 {
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
                        continue;
                    }
                    warn!(
                        "Stream stopped: session_id={}, round_id={}, attempts={}, reason={}, effective_output={}, category={:?}, error={}",
                        context.session_id,
                        round_id,
                        lifecycle.attempts_started(),
                        if retryable { "retry_budget_exhausted" } else { "non_retryable_error" },
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
                    return Err(stream_err.error);
                }
            }
        };

        Self::complete_model_exchange_trace(
            trace_config.as_ref(),
            final_trace_handle.as_ref(),
            Self::final_trace_response(&stream_result),
        )
        .await;

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

        // If stream response contains usage info, record it before the
        // post-stream cancellation gate. A user can press stop after the
        // provider returned usage but before this round settles; dropping that
        // usage makes cancelled turns look unaccounted even though the provider
        // already supplied authoritative counts.
        if let Some(ref usage) = stream_result.usage {
            self.emit_token_usage_update(&context, usage, context_window, is_subagent)
                .await;
        }

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
            let model_response_replay = Self::model_response_replay(&stream_result);
            let (clean_text, _) = strip_openbitfun_memory_citations(&stream_result.full_text);
            let assistant_message =
                Message::assistant_with_reasoning(reasoning, clean_text, vec![])
                    .with_turn_id(context.dialog_turn_id.clone())
                    .with_round_id(round_id.clone())
                    .with_thinking_signature(stream_result.thinking_signature.clone())
                    .with_reasoning_content_kind(stream_result.reasoning_content_kind)
                    .with_memory_citation(parsed_memory_citation)
                    .with_model_response_replay(model_response_replay);

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
        let model_response_replay = Self::model_response_replay(&stream_result);
        let (clean_text, _) = strip_openbitfun_memory_citations(&stream_result.full_text);
        let assistant_message =
            Message::assistant_with_reasoning(reasoning, clean_text, tool_calls.clone())
                .with_turn_id(context.dialog_turn_id.clone())
                .with_round_id(round_id.clone())
                .with_thinking_signature(stream_result.thinking_signature.clone())
                .with_reasoning_content_kind(stream_result.reasoning_content_kind)
                .with_memory_citation(parsed_memory_citation)
                .with_model_response_replay(model_response_replay);

        // Commit the complete provider response before any tool can block on IO,
        // approval, or cancellation. Tool results remain separate semantic messages.
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
                            execution_time_ms: 0,
                        })
                        .collect()
                }
            };

            // Convert to ToolResult, then enforce the aggregate budget for this model round.
            let tool_results = execution_results
                .into_iter()
                .map(|mut execution_result| {
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
                Message::tool_result(result.clone())
                    .with_turn_id(dialog_turn_id.clone())
                    .with_round_id(round_id_clone.clone())
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
    ) {
        debug!(
            "Updating token stats from model response: input={}, output={}, total={}, is_subagent={}",
            usage.prompt_token_count,
            usage.candidates_token_count,
            usage.total_token_count,
            is_subagent
        );

        self.emit_event(
            AgenticEvent::TokenUsageUpdated {
                session_id: context.session_id.clone(),
                turn_id: context.dialog_turn_id.clone(),
                model_config_id: context.model_config_id.clone(),
                effective_model_name: context.effective_model_name.clone(),
                input_tokens: usage.prompt_token_count as usize,
                output_tokens: Some(usage.candidates_token_count as usize),
                total_tokens: usage.total_token_count as usize,
                max_context_tokens: context_window,
                is_subagent,
                cached_tokens: usage.cached_content_token_count.map(|v| v as usize),
                token_details: token_details_from_usage(usage),
            },
            EventPriority::Normal,
        )
        .await;
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
        stop: Arc<std::sync::atomic::AtomicBool>,
        thread: Option<std::thread::JoinHandle<()>>,
    }

    impl RetryTestServer {
        pub(in crate::agentic::execution) fn new(replies: Vec<(u16, String)>) -> Self {
            Self::with_open_stream(replies, false)
        }

        fn with_open_stream(replies: Vec<(u16, String)>, keep_open: bool) -> Self {
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
                    loop {
                        let mut line = String::new();
                        assert!(reader.read_line(&mut line).unwrap() > 0);
                        if line == "\r\n" {
                            break;
                        }
                        if let Some((name, value)) = line.split_once(':') {
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
                    drop(requests);
                    let (status, body) = &replies[index];
                    let content_type = if *status == 200 {
                        "text/event-stream"
                    } else {
                        "application/json"
                    };
                    write!(socket, "HTTP/1.1 {status} Fixture\r\nContent-Type: {content_type}\r\nContent-Length: {}\r\nConnection: close\r\n\r\n{body}", body.len() + usize::from(keep_open)).unwrap();
                    socket.flush().unwrap();
                    while keep_open && !stopped.load(Ordering::Relaxed) {
                        std::thread::sleep(Duration::from_millis(5));
                    }
                }
            });
            Self {
                url,
                requests,
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
        assert_semantic_tool_call_commit(false).await;
    }

    #[tokio::test]
    async fn semantic_tool_call_survives_cancellation_during_execution() {
        assert_semantic_tool_call_commit(true).await;
    }

    async fn assert_semantic_tool_call_commit(cancel: bool) {
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
            .emit_token_usage_update(&context, &usage, Some(128_000), false)
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
}
