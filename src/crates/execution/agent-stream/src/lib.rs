//! Stream Processor
//!
//! Processes AI streaming responses, supports tool pre-detection and parameter streaming

mod hidden_text;
pub mod retry;
pub mod tool_call_accumulator;
mod unified;

pub use tool_call_accumulator::{ToolArgumentRepairKind, ToolCallCompletion};

use crate::tool_call_accumulator::{
    FinalizedToolCall, PendingToolCalls, ToolCallBoundary, ToolCallFinalizeOptions,
    ToolCallStreamKey,
};
use futures::{Stream, StreamExt};
pub use hidden_text::{HiddenTextBlock, HiddenTextStreamParser, HiddenTextTag};
use log::{debug, error, trace};
use openbitfun_core_types::{errors::AiProviderError, ReasoningContentKind};
use openbitfun_events::{AgenticEvent, AgenticEventPriority as EventPriority, ToolEventData};
use serde::{Deserialize, Serialize};
use serde_json::Value;
use std::collections::{HashSet, VecDeque};
use std::fmt;
use std::sync::Arc;
use std::time::Instant;
use tokio::sync::mpsc;
pub use unified::{
    ModelResponseReplayCapture, UnifiedResponse, UnifiedTokenUsage, UnifiedToolCall,
};

/// Minimal tool-call value emitted by the stream processor.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct ToolCall {
    pub tool_id: String,
    pub tool_name: String,
    pub arguments: serde_json::Value,
    /// Original provider-emitted argument JSON, preserved for replay stability when available.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub raw_arguments: Option<String>,
    /// Record whether tool parameters are valid.
    pub is_error: bool,
    /// Original JSON parser error when the provider emitted invalid arguments.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub parse_error: Option<String>,
    /// True when truncated raw JSON arguments were repaired into a partial tool call.
    #[serde(default, skip_serializing_if = "std::ops::Not::not")]
    pub recovered_from_truncation: bool,
    /// How malformed raw JSON was repaired before ordinary tool validation.
    #[serde(default, skip_serializing_if = "ToolArgumentRepairKind::is_none")]
    pub repair_kind: ToolArgumentRepairKind,
}

impl ToolCall {
    pub fn is_valid(&self) -> bool {
        !self.tool_id.is_empty() && !self.tool_name.is_empty() && !self.is_error
    }
}

/// Stream-processor specific error that avoids depending on core runtime errors.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum StreamProcessorError {
    AiClient(String),
    AiProvider(AiProviderError),
    Cancelled(String),
}

impl fmt::Display for StreamProcessorError {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        match self {
            Self::AiClient(msg) => write!(f, "AI client error: {}", msg),
            Self::AiProvider(error) => write!(f, "AI provider error: {}", error),
            Self::Cancelled(msg) => write!(f, "Operation cancelled: {}", msg),
        }
    }
}

impl std::error::Error for StreamProcessorError {}

/// Event sink abstraction used by stream processing. Product crates can adapt
/// their own queue implementation without making this crate depend on core.
#[async_trait::async_trait]
pub trait StreamEventSink: Send + Sync {
    async fn enqueue(&self, event: AgenticEvent, priority: Option<EventPriority>);
}

/// Whether a provider finish_reason means the response was cut by the model's
/// output token limit rather than completed naturally.
/// Covers OpenAI-compatible "length", Anthropic "max_tokens", Gemini
/// "MAX_TOKENS", and the Responses API's `incomplete:max_output_tokens`.
fn is_token_limit_finish_reason(reason: &str) -> bool {
    let normalized = reason.trim().to_ascii_lowercase();
    matches!(
        normalized.as_str(),
        "length"
            | "max_tokens"
            | "max_output_tokens"
            | "incomplete:max_tokens"
            | "incomplete:max_output_tokens"
    )
}

fn elapsed_ms_u64(started_at: Instant) -> u64 {
    started_at
        .elapsed()
        .as_millis()
        .try_into()
        .unwrap_or(u64::MAX)
}

//==============================================================================
// SSE Log Collector - Outputs raw SSE data on error
//==============================================================================

/// SSE log collector configuration
#[derive(Debug, Clone)]
pub struct SseLogConfig {
    /// Maximum number of retained SSE data entries to output on error, None means unlimited.
    pub max_output: Option<usize>,
    /// Maximum retained raw SSE bytes for diagnostics.
    pub max_retained_bytes: usize,
}

impl Default for SseLogConfig {
    fn default() -> Self {
        Self {
            max_output: Some(256),
            max_retained_bytes: 1024 * 1024,
        }
    }
}

/// SSE log collector - Collects raw SSE data, outputs only on error
pub struct SseLogCollector {
    buffer: VecDeque<String>,
    retained_bytes: usize,
    dropped_events: usize,
    dropped_bytes: usize,
    config: SseLogConfig,
}

impl SseLogCollector {
    pub fn new(config: SseLogConfig) -> Self {
        Self {
            buffer: VecDeque::new(),
            retained_bytes: 0,
            dropped_events: 0,
            dropped_bytes: 0,
            config,
        }
    }

    /// Push one SSE data entry
    pub fn push(&mut self, data: String) {
        self.retained_bytes = self.retained_bytes.saturating_add(data.len());
        self.buffer.push_back(data);

        while self.retained_bytes > self.config.max_retained_bytes {
            let Some(dropped) = self.buffer.pop_front() else {
                self.retained_bytes = 0;
                break;
            };
            self.retained_bytes = self.retained_bytes.saturating_sub(dropped.len());
            self.dropped_events = self.dropped_events.saturating_add(1);
            self.dropped_bytes = self.dropped_bytes.saturating_add(dropped.len());
        }
    }

    /// Get number of collected data entries
    pub fn len(&self) -> usize {
        self.buffer.len()
    }

    /// Check if empty
    pub fn is_empty(&self) -> bool {
        self.buffer.is_empty()
    }

    /// Flush all SSE data to log on error
    pub fn flush_on_error(&self, error_context: &str) {
        let Some(sse_msg) = self.format_history_message() else {
            error!("SSE Error: {} (no SSE data collected)", error_context);
            return;
        };

        error!("SSE Error: {}", error_context);
        error!("{}", sse_msg);
    }

    fn format_history_message(&self) -> Option<String> {
        if self.buffer.is_empty() && self.dropped_events == 0 {
            return None;
        }

        let total_events = self.dropped_events + self.buffer.len();
        let mut sse_msg = if self.dropped_events == 0 {
            format!("SSE history ({} events):\n", self.buffer.len())
        } else {
            format!(
                "SSE history ({} retained of {} events, {} bytes omitted):\n",
                self.buffer.len(),
                total_events,
                self.dropped_bytes
            )
        };
        let retained_start_index = self.dropped_events;

        match self.config.max_output {
            None => {
                // No limit, output all
                for (i, data) in self.buffer.iter().enumerate() {
                    sse_msg.push_str(&format!("{:>6}: {}\n", retained_start_index + i, data));
                }
            }
            Some(max) if self.buffer.len() <= max => {
                // Within limit, output all
                for (i, data) in self.buffer.iter().enumerate() {
                    sse_msg.push_str(&format!("{:>6}: {}\n", retained_start_index + i, data));
                }
            }
            Some(max) => {
                // Exceeds limit, smart truncation: output beginning + end
                let head = 50.min(max / 2);
                let tail = max - head;
                let total = self.buffer.len();

                for (i, data) in self.buffer.iter().take(head).enumerate() {
                    sse_msg.push_str(&format!("{:>6}: {}\n", retained_start_index + i, data));
                }
                sse_msg.push_str(&format!("... ({} events omitted) ...\n", total - max));
                for (i, data) in self.buffer.iter().skip(total - tail).enumerate() {
                    sse_msg.push_str(&format!(
                        "{:>6}: {}\n",
                        retained_start_index + total - tail + i,
                        data
                    ));
                }
            }
        }

        Some(sse_msg)
    }
}

/// Placeholder name for tool calls whose name was not received before the stream terminated.
const UNKNOWN_TOOL_PLACEHOLDER: &str = "unknown_tool";

/// Stream processing result
#[derive(Debug, Clone)]
pub struct StreamResult {
    pub full_thinking: String,
    /// Source semantics of `full_thinking`; summaries are preferred when both
    /// provider reasoning text and a displayable summary were emitted.
    pub reasoning_content_kind: Option<ReasoningContentKind>,
    /// Whether the provider emitted a reasoning/thinking field even if its content was empty.
    pub reasoning_content_present: bool,
    /// Signature of Anthropic extended thinking (passed back in multi-turn conversations)
    pub thinking_signature: Option<String>,
    /// User-visible assistant text after stream-only hidden markup has been removed.
    pub full_text: String,
    /// Hidden text blocks extracted from assistant text while streaming.
    pub hidden_text_blocks: Vec<HiddenTextBlock>,
    pub tool_calls: Vec<ToolCall>,
    /// Token usage statistics (from model response)
    pub usage: Option<UnifiedTokenUsage>,
    /// Provider-specific metadata captured from the stream tail.
    pub provider_metadata: Option<Value>,
    /// Complete provider response layout and opaque state eligible for replay.
    pub model_response_replay: Option<ModelResponseReplayCapture>,
    /// Whether this stream produced any user-visible output (text/thinking/tool events)
    pub has_effective_output: bool,
    /// Milliseconds from stream processing start to the first upstream response item.
    pub first_chunk_ms: Option<u64>,
    /// Milliseconds from stream processing start to the first event visible to the UI.
    pub first_visible_output_ms: Option<u64>,
    /// When set, the stream terminated abnormally but was recovered with partial output.
    /// Contains a human-readable reason (e.g. "Stream processing error: ..." or
    /// "Stream processor watchdog timeout ...").
    pub partial_recovery_reason: Option<String>,
}

/// Stream processing error with output diagnostics.
#[derive(Debug)]
pub struct StreamProcessError {
    pub error: StreamProcessorError,
    pub has_effective_output: bool,
}

impl StreamProcessError {
    fn new(error: StreamProcessorError, has_effective_output: bool) -> Self {
        Self {
            error,
            has_effective_output,
        }
    }
}

#[derive(Debug, Clone, Default)]
pub struct StreamProcessOptions {
    pub recover_partial_on_cancel: bool,
    /// Suppress the stream-owned terminal cancellation event when a higher
    /// layer owns the authoritative cancellation lifecycle.
    pub suppress_cancel_lifecycle_event: bool,
    /// Allow broad JSON repair for non-Write tools, but only after a provider
    /// confirms a normal tool-use completion.
    pub allow_normal_tool_json_repair: bool,
    pub hidden_text_tags: Vec<HiddenTextTag>,
}

/// Stream processing context, encapsulates state during stream processing
struct StreamContext {
    session_id: String,
    dialog_turn_id: String,
    round_id: String,
    attempt_id: String,
    attempt_index: u32,

    // Accumulated results
    full_thinking: String,
    full_reasoning_text: String,
    full_reasoning_summary: String,
    reasoning_content_present: bool,
    /// Signature of Anthropic extended thinking (passed back in multi-turn conversations)
    thinking_signature: Option<String>,
    full_text: String,
    hidden_text_blocks: Vec<HiddenTextBlock>,
    hidden_text_parser: HiddenTextStreamParser,
    tool_calls: Vec<ToolCall>,
    usage: Option<UnifiedTokenUsage>,
    provider_metadata: Option<Value>,
    model_response_replay: Option<ModelResponseReplayCapture>,

    // Current tool call state
    pending_tool_calls: PendingToolCalls,
    finalized_tool_call_ids: HashSet<String>,

    // Counters and flags
    stream_started_at: Instant,
    first_chunk_ms: Option<u64>,
    first_visible_output_ms: Option<u64>,
    text_chunks_count: usize,
    thinking_chunks_count: usize,
    thinking_streams: Vec<Option<ReasoningContentKind>>,
    completed_thinking_streams: HashSet<Option<ReasoningContentKind>>,
    has_effective_output: bool,
    partial_recovery_reason: Option<String>,
    /// Provider finish_reason indicating the response was cut by the model's
    /// output token limit (e.g. "length", "max_tokens", "MAX_TOKENS").
    token_limit_finish_reason: Option<String>,
    allow_normal_tool_json_repair: bool,
    suppress_cancel_lifecycle_event: bool,
}

impl StreamContext {
    fn new(
        session_id: String,
        dialog_turn_id: String,
        round_id: String,
        attempt_id: String,
        attempt_index: u32,
        options: &StreamProcessOptions,
    ) -> Self {
        Self {
            session_id,
            dialog_turn_id,
            round_id,
            attempt_id,
            attempt_index,
            full_thinking: String::new(),
            full_reasoning_text: String::new(),
            full_reasoning_summary: String::new(),
            reasoning_content_present: false,
            thinking_signature: None,
            full_text: String::new(),
            hidden_text_blocks: Vec::new(),
            hidden_text_parser: HiddenTextStreamParser::new(options.hidden_text_tags.clone()),
            tool_calls: Vec::new(),
            usage: None,
            provider_metadata: None,
            model_response_replay: None,
            pending_tool_calls: PendingToolCalls::new(),
            finalized_tool_call_ids: HashSet::new(),
            stream_started_at: Instant::now(),
            first_chunk_ms: None,
            first_visible_output_ms: None,
            text_chunks_count: 0,
            thinking_chunks_count: 0,
            thinking_streams: Vec::new(),
            completed_thinking_streams: HashSet::new(),
            has_effective_output: false,
            partial_recovery_reason: None,
            token_limit_finish_reason: None,
            allow_normal_tool_json_repair: options.allow_normal_tool_json_repair,
            suppress_cancel_lifecycle_event: options.suppress_cancel_lifecycle_event,
        }
    }

    fn into_result(self) -> StreamResult {
        let (full_thinking, reasoning_content_kind) = if !self.full_reasoning_summary.is_empty() {
            (
                self.full_reasoning_summary,
                Some(ReasoningContentKind::Summary),
            )
        } else if !self.full_reasoning_text.is_empty() {
            (
                self.full_reasoning_text,
                Some(ReasoningContentKind::Reasoning),
            )
        } else {
            (self.full_thinking, None)
        };
        StreamResult {
            full_thinking,
            reasoning_content_kind,
            reasoning_content_present: self.reasoning_content_present,
            thinking_signature: self.thinking_signature,
            full_text: self.full_text,
            hidden_text_blocks: self.hidden_text_blocks,
            tool_calls: self.tool_calls,
            usage: self.usage,
            provider_metadata: self.provider_metadata,
            model_response_replay: self.model_response_replay,
            has_effective_output: self.has_effective_output,
            first_chunk_ms: self.first_chunk_ms,
            first_visible_output_ms: self.first_visible_output_ms,
            partial_recovery_reason: self.partial_recovery_reason,
        }
    }

    fn preferred_thinking(&self) -> &str {
        if !self.full_reasoning_summary.is_empty() {
            &self.full_reasoning_summary
        } else if !self.full_reasoning_text.is_empty() {
            &self.full_reasoning_text
        } else {
            &self.full_thinking
        }
    }

    fn mark_first_stream_chunk(&mut self) {
        if self.first_chunk_ms.is_none() {
            self.first_chunk_ms = Some(elapsed_ms_u64(self.stream_started_at));
        }
    }

    fn mark_first_visible_output(&mut self) {
        if self.first_visible_output_ms.is_none() {
            self.first_visible_output_ms = Some(elapsed_ms_u64(self.stream_started_at));
        }
    }

    fn can_recover_as_partial_result(&self) -> bool {
        self.has_effective_output
    }

    fn record_finalized_tool_call(&mut self, finalized: &FinalizedToolCall) {
        let tool_name = if finalized.tool_name.is_empty() {
            UNKNOWN_TOOL_PLACEHOLDER.to_string()
        } else {
            finalized.tool_name.clone()
        };
        let tool_id = if finalized.tool_id.is_empty() {
            uuid::Uuid::new_v4().to_string()
        } else {
            finalized.tool_id.clone()
        };
        if !self.finalized_tool_call_ids.insert(tool_id.clone()) {
            debug!(
                "Skipping duplicate finalized tool call in stream: tool_id={}, tool_name={}",
                tool_id, tool_name
            );
            return;
        }
        self.tool_calls.push(ToolCall {
            tool_id,
            tool_name,
            arguments: finalized.arguments.clone(),
            raw_arguments: (!finalized.raw_arguments.is_empty())
                .then_some(finalized.raw_arguments.clone()),
            is_error: finalized.is_error,
            parse_error: finalized.parse_error.clone(),
            recovered_from_truncation: finalized.recovered_from_truncation,
            repair_kind: finalized.repair_kind,
        });
    }

    fn finalize_all_pending_tool_calls(
        &mut self,
        boundary: ToolCallBoundary,
        completion: ToolCallCompletion,
    ) -> Vec<FinalizedToolCall> {
        let finalized = self.pending_tool_calls.finalize_all_with_options(
            boundary,
            ToolCallFinalizeOptions {
                completion,
                allow_normal_tool_json_repair: self.allow_normal_tool_json_repair,
            },
        );
        for tool_call in &finalized {
            self.record_finalized_tool_call(tool_call);
        }
        finalized
    }

    /// Force finish pending tool calls, used when the stream is shutting down before a natural tool boundary.
    fn force_finish_pending_tool_calls(&mut self) {
        for finalized in self.finalize_all_pending_tool_calls(
            ToolCallBoundary::GracefulShutdown,
            ToolCallCompletion::Interrupted,
        ) {
            error!(
                "force finish pending tool call: tool_id={}, tool_name={}, raw_len={}, is_error={}",
                finalized.tool_id,
                finalized.tool_name,
                finalized.raw_arguments.len(),
                finalized.is_error
            );
        }
    }
}

enum TimedStreamItem<T> {
    Item(T),
    End,
    TimedOut,
}

async fn next_stream_item<S>(
    stream: &mut S,
    watchdog_timeout: Option<std::time::Duration>,
) -> TimedStreamItem<S::Item>
where
    S: Stream + Unpin,
{
    match watchdog_timeout {
        Some(timeout) => match tokio::time::timeout(timeout, stream.next()).await {
            Ok(Some(item)) => TimedStreamItem::Item(item),
            Ok(None) => TimedStreamItem::End,
            Err(_) => TimedStreamItem::TimedOut,
        },
        None => match stream.next().await {
            Some(item) => TimedStreamItem::Item(item),
            None => TimedStreamItem::End,
        },
    }
}

/// Stream processor
pub struct StreamProcessor {
    event_sink: Arc<dyn StreamEventSink>,
}

struct GracefulShutdownInput {
    session_id: String,
    turn_id: String,
    round_id: String,
    attempt_id: String,
    attempt_index: u32,
    tool_calls: Vec<ToolCall>,
    reason: String,
    suppress_cancel_lifecycle_event: bool,
}

impl StreamProcessor {
    const WATCHDOG_GRACE_SECS: u64 = 2;

    pub fn new<E>(event_sink: Arc<E>) -> Self
    where
        E: StreamEventSink + 'static,
    {
        Self { event_sink }
    }

    pub fn derive_watchdog_timeout(
        stream_idle_timeout: Option<std::time::Duration>,
    ) -> Option<std::time::Duration> {
        stream_idle_timeout.map(|timeout| {
            timeout
                .checked_add(std::time::Duration::from_secs(Self::WATCHDOG_GRACE_SECS))
                .unwrap_or(std::time::Duration::MAX)
        })
    }

    fn merge_json_value(target: &mut Value, overlay: Value) {
        match (target, overlay) {
            (Value::Object(target_map), Value::Object(overlay_map)) => {
                for (key, value) in overlay_map {
                    let entry = target_map.entry(key).or_insert(Value::Null);
                    Self::merge_json_value(entry, value);
                }
            }
            (target_slot, overlay_value) => {
                *target_slot = overlay_value;
            }
        }
    }

    // ==================== Helper Methods ====================

    /// Send thinking end event (if needed)
    async fn send_thinking_end_if_needed(&self, ctx: &mut StreamContext) {
        for reasoning_kind in ctx.thinking_streams.clone() {
            if !ctx.completed_thinking_streams.insert(reasoning_kind) {
                continue;
            }
            debug!("Thinking process ended, sending ThinkingChunk end event");
            let _ = self
                .event_sink
                .enqueue(
                    AgenticEvent::ThinkingChunk {
                        session_id: ctx.session_id.clone(),
                        turn_id: ctx.dialog_turn_id.clone(),
                        round_id: ctx.round_id.clone(),
                        attempt_id: Some(ctx.attempt_id.clone()),
                        attempt_index: Some(ctx.attempt_index),
                        content: String::new(),
                        reasoning_kind,
                        is_end: true,
                    },
                    Some(EventPriority::Normal),
                )
                .await;
        }
    }

    /// Check cancellation and execute graceful shutdown, returns Some(Err) if processing needs to be interrupted
    async fn check_cancellation(
        &self,
        ctx: &mut StreamContext,
        cancellation_token: &tokio_util::sync::CancellationToken,
        location: &str,
    ) -> Option<Result<StreamResult, StreamProcessError>> {
        if cancellation_token.is_cancelled() {
            debug!(
                "Cancellation detected at {}: location={}",
                location, location
            );
            self.graceful_shutdown_from_ctx(ctx, "User cancelled stream processing".to_string())
                .await;
            Some(Err(StreamProcessError::new(
                StreamProcessorError::Cancelled("Stream processing cancelled".to_string()),
                ctx.has_effective_output,
            )))
        } else {
            None
        }
    }

    /// Execute graceful shutdown from context
    async fn graceful_shutdown_from_ctx(&self, ctx: &mut StreamContext, reason: String) {
        ctx.force_finish_pending_tool_calls();
        self.graceful_shutdown(GracefulShutdownInput {
            session_id: ctx.session_id.clone(),
            turn_id: ctx.dialog_turn_id.clone(),
            round_id: ctx.round_id.clone(),
            attempt_id: ctx.attempt_id.clone(),
            attempt_index: ctx.attempt_index,
            tool_calls: ctx.tool_calls.clone(),
            reason,
            suppress_cancel_lifecycle_event: ctx.suppress_cancel_lifecycle_event,
        })
        .await;
    }

    /// Graceful shutdown: cleanup all unfinished tool states and notify frontend
    async fn graceful_shutdown(&self, input: GracefulShutdownInput) {
        let GracefulShutdownInput {
            session_id,
            turn_id,
            round_id,
            attempt_id,
            attempt_index,
            tool_calls,
            reason,
            suppress_cancel_lifecycle_event,
        } = input;
        debug!(
            "Starting graceful shutdown: session_id={}, reason={}",
            session_id, reason
        );

        let is_user_cancellation = reason.contains("cancelled") || reason.contains("cancelled");
        let tool_call_count = tool_calls.len();

        // 1. Cleanup all tool calls
        for tool_call in tool_calls {
            trace!(
                "Cleaning up tool: {} ({})",
                tool_call.tool_name,
                tool_call.tool_id
            );

            let identity = openbitfun_events::ToolEventIdentity::direct(
                tool_call.tool_id,
                tool_call.tool_name,
            );
            let tool_event = if is_user_cancellation {
                ToolEventData::Cancelled {
                    identity,
                    reason: reason.clone(),
                    duration_ms: None,
                    queue_wait_ms: None,
                    preflight_ms: None,
                    confirmation_wait_ms: None,
                    execution_ms: None,
                }
            } else {
                ToolEventData::Failed {
                    identity,
                    error_detail: None,
                    error: reason.clone(),
                    duration_ms: None,
                    queue_wait_ms: None,
                    preflight_ms: None,
                    confirmation_wait_ms: None,
                    execution_ms: None,
                }
            };

            let _ = self
                .event_sink
                .enqueue(
                    AgenticEvent::ToolEvent {
                        session_id: session_id.clone(),
                        turn_id: turn_id.clone(),
                        round_id: round_id.clone(),
                        attempt_id: Some(attempt_id.clone()),
                        attempt_index: Some(attempt_index),
                        tool_event,
                    },
                    Some(EventPriority::High),
                )
                .await;
        }

        // 2. Send dialog turn status update (if tools were cleaned up)
        if tool_call_count > 0 && !(is_user_cancellation && suppress_cancel_lifecycle_event) {
            let event = if is_user_cancellation {
                AgenticEvent::DialogTurnCancelled {
                    session_id: session_id.clone(),
                    turn_id: turn_id.clone(),
                }
            } else {
                AgenticEvent::DialogTurnFailed {
                    session_id: session_id.clone(),
                    turn_id: turn_id.clone(),
                    error: reason,
                    error_category: None,
                    error_detail: None,
                }
            };
            let _ = self
                .event_sink
                .enqueue(event, Some(EventPriority::Critical))
                .await;
        }

        debug!(
            "Graceful shutdown completed: cleaned up {} tools",
            tool_call_count
        );
    }

    /// Handle usage statistics
    fn handle_usage(&self, ctx: &mut StreamContext, response_usage: &UnifiedTokenUsage) {
        ctx.usage = Some(response_usage.clone());
        debug!(
            "Received token usage stats: input={}, output={}, total={}",
            response_usage.prompt_token_count,
            response_usage.candidates_token_count,
            response_usage.total_token_count
        );
    }

    /// Handle tool call chunk
    async fn handle_tool_call_chunk(&self, ctx: &mut StreamContext, tool_call: UnifiedToolCall) {
        let UnifiedToolCall {
            tool_call_index,
            id,
            name,
            arguments,
            arguments_is_snapshot,
        } = tool_call;
        let outcome = ctx.pending_tool_calls.apply_delta(
            ToolCallStreamKey::from(tool_call_index),
            id,
            name,
            arguments,
            arguments_is_snapshot,
        );

        if let Some(finalized) = outcome.finalized_previous {
            ctx.record_finalized_tool_call(&finalized);
        }

        if let Some(early_detected) = outcome.early_detected {
            ctx.has_effective_output = true;
            ctx.mark_first_visible_output();
            debug!("Tool detected: {}", early_detected.tool_name);
            let _ = self
                .event_sink
                .enqueue(
                    AgenticEvent::ToolEvent {
                        session_id: ctx.session_id.clone(),
                        turn_id: ctx.dialog_turn_id.clone(),
                        round_id: ctx.round_id.clone(),
                        attempt_id: Some(ctx.attempt_id.clone()),
                        attempt_index: Some(ctx.attempt_index),
                        tool_event: ToolEventData::EarlyDetected {
                            identity: openbitfun_events::ToolEventIdentity::direct(
                                early_detected.tool_id,
                                early_detected.tool_name,
                            ),
                        },
                    },
                    None,
                )
                .await;
        }

        if let Some(params_partial) = outcome.params_partial {
            ctx.has_effective_output = true;
            ctx.mark_first_visible_output();
            let _ = self
                .event_sink
                .enqueue(
                    AgenticEvent::ToolEvent {
                        session_id: ctx.session_id.clone(),
                        turn_id: ctx.dialog_turn_id.clone(),
                        round_id: ctx.round_id.clone(),
                        attempt_id: Some(ctx.attempt_id.clone()),
                        attempt_index: Some(ctx.attempt_index),
                        tool_event: ToolEventData::ParamsPartial {
                            identity: openbitfun_events::ToolEventIdentity::direct(
                                params_partial.tool_id,
                                params_partial.tool_name,
                            ),
                            params: params_partial.params_chunk,
                        },
                    },
                    None,
                )
                .await;
        }
    }

    /// Handle text chunk
    async fn handle_text_chunk(&self, ctx: &mut StreamContext, text: String) {
        let parsed = ctx.hidden_text_parser.push_str(&text);
        ctx.hidden_text_blocks.extend(parsed.hidden_blocks);
        let text = parsed.visible_text;
        if text.is_empty() {
            return;
        }

        if !text.trim().is_empty() {
            ctx.has_effective_output = true;
            ctx.mark_first_visible_output();
        }
        ctx.full_text.push_str(&text);
        ctx.text_chunks_count += 1;

        // Send streaming text event
        let _ = self
            .event_sink
            .enqueue(
                AgenticEvent::TextChunk {
                    session_id: ctx.session_id.clone(),
                    turn_id: ctx.dialog_turn_id.clone(),
                    round_id: ctx.round_id.clone(),
                    attempt_id: Some(ctx.attempt_id.clone()),
                    attempt_index: Some(ctx.attempt_index),
                    text,
                },
                None,
            )
            .await;
    }

    async fn flush_hidden_text_tail(&self, ctx: &mut StreamContext) {
        let parsed = ctx.hidden_text_parser.finish();
        ctx.hidden_text_blocks.extend(parsed.hidden_blocks);
        let text = parsed.visible_text;
        if text.is_empty() {
            return;
        }

        if !text.trim().is_empty() {
            ctx.has_effective_output = true;
            ctx.mark_first_visible_output();
        }
        ctx.full_text.push_str(&text);
        ctx.text_chunks_count += 1;

        let _ = self
            .event_sink
            .enqueue(
                AgenticEvent::TextChunk {
                    session_id: ctx.session_id.clone(),
                    turn_id: ctx.dialog_turn_id.clone(),
                    round_id: ctx.round_id.clone(),
                    attempt_id: Some(ctx.attempt_id.clone()),
                    attempt_index: Some(ctx.attempt_index),
                    text,
                },
                None,
            )
            .await;
    }

    /// Handle thinking chunk
    async fn handle_thinking_chunk(
        &self,
        ctx: &mut StreamContext,
        thinking_content: String,
        reasoning_kind: Option<ReasoningContentKind>,
    ) {
        // Thinking-only output does NOT count as "effective" for retry purposes:
        // if the stream fails after producing only thinking (no text/tool calls),
        // it is safe to retry because the model will re-think from scratch.
        match reasoning_kind {
            Some(ReasoningContentKind::Reasoning) => {
                ctx.full_reasoning_text.push_str(&thinking_content)
            }
            Some(ReasoningContentKind::Summary) => {
                ctx.full_reasoning_summary.push_str(&thinking_content)
            }
            None => ctx.full_thinking.push_str(&thinking_content),
        }
        if !ctx.thinking_streams.contains(&reasoning_kind) {
            ctx.thinking_streams.push(reasoning_kind);
        }
        ctx.mark_first_visible_output();
        ctx.thinking_chunks_count += 1;

        // Send thinking chunk event
        let _ = self
            .event_sink
            .enqueue(
                AgenticEvent::ThinkingChunk {
                    session_id: ctx.session_id.clone(),
                    turn_id: ctx.dialog_turn_id.clone(),
                    round_id: ctx.round_id.clone(),
                    attempt_id: Some(ctx.attempt_id.clone()),
                    attempt_index: Some(ctx.attempt_index),
                    content: thinking_content,
                    reasoning_kind,
                    is_end: false,
                },
                None,
            )
            .await;
    }

    /// Print stream processing end log
    fn log_stream_result(&self, ctx: &StreamContext) {
        debug!(
            "Stream loop ended: text_chunks={}, thinking_chunks={}, tool_calls({}), first_chunk_ms={:?}, first_visible_output_ms={:?}: {}",
            ctx.text_chunks_count,
            ctx.thinking_chunks_count,
            ctx.tool_calls.len(),
            ctx.first_chunk_ms,
            ctx.first_visible_output_ms,
            ctx.tool_calls
                .iter()
                .map(|tc| tc.tool_name.as_str())
                .collect::<Vec<_>>()
                .join(", ")
        );

        if log::log_enabled!(log::Level::Debug) {
            let preferred_thinking = ctx.preferred_thinking();
            if !preferred_thinking.is_empty() {
                debug!(target: "ai::stream_processor", "Full thinking content: \n{}", preferred_thinking);
            }
            if !ctx.full_text.is_empty() {
                debug!(target: "ai::stream_processor", "Full text content: \n{}", ctx.full_text);
            }
            if !ctx.tool_calls.is_empty() {
                let log_str: String = ctx
                    .tool_calls
                    .iter()
                    .map(|tc| {
                        format!(
                            "Tool name: {}, arguments: {}\n",
                            tc.tool_name,
                            serde_json::to_string(&tc.arguments)
                                .unwrap_or_else(|_| "Serialization failed".to_string())
                        )
                    })
                    .collect();
                debug!(target: "ai::stream_processor", "Tool call details: \n{}", log_str);
            }
        }

        trace!(
            "Returning StreamResult: thinking_len={}, text_len={}, tool_calls={}, has_usage={}, has_effective_output={}",
            ctx.preferred_thinking().len(),
            ctx.full_text.len(),
            ctx.tool_calls.len(),
            ctx.usage.is_some(),
            ctx.has_effective_output
        );
    }

    // ==================== Main Processing Methods ====================

    /// Process AI streaming response
    ///
    /// # Arguments
    /// * `stream` - Parsed response stream
    /// * `raw_sse_rx` - Optional raw SSE data receiver (for collecting raw data during error diagnosis)
    /// * `session_id` - Session ID
    /// * `dialog_turn_id` - Dialog turn ID
    /// * `round_id` - Model round ID
    /// * `cancellation_token` - Cancellation token
    #[allow(clippy::too_many_arguments)]
    pub async fn process_stream(
        &self,
        stream: futures::stream::BoxStream<'static, Result<UnifiedResponse, anyhow::Error>>,
        watchdog_timeout: Option<std::time::Duration>,
        raw_sse_rx: Option<mpsc::UnboundedReceiver<String>>,
        session_id: String,
        dialog_turn_id: String,
        round_id: String,
        attempt_id: String,
        attempt_index: u32,
        cancellation_token: &tokio_util::sync::CancellationToken,
    ) -> Result<StreamResult, StreamProcessError> {
        self.process_stream_with_options(
            stream,
            watchdog_timeout,
            raw_sse_rx,
            session_id,
            dialog_turn_id,
            round_id,
            attempt_id,
            attempt_index,
            cancellation_token,
            StreamProcessOptions::default(),
        )
        .await
    }

    #[allow(clippy::too_many_arguments)]
    pub async fn process_stream_with_options(
        &self,
        mut stream: futures::stream::BoxStream<'static, Result<UnifiedResponse, anyhow::Error>>,
        watchdog_timeout: Option<std::time::Duration>,
        raw_sse_rx: Option<mpsc::UnboundedReceiver<String>>,
        session_id: String,
        dialog_turn_id: String,
        round_id: String,
        attempt_id: String,
        attempt_index: u32,
        cancellation_token: &tokio_util::sync::CancellationToken,
        options: StreamProcessOptions,
    ) -> Result<StreamResult, StreamProcessError> {
        let mut ctx = StreamContext::new(
            session_id,
            dialog_turn_id,
            round_id,
            attempt_id,
            attempt_index,
            &options,
        );
        // Start SSE log collector (if raw_sse_rx is provided)
        let sse_collector = if let Some(mut rx) = raw_sse_rx {
            let collector = Arc::new(tokio::sync::Mutex::new(SseLogCollector::new(
                SseLogConfig::default(),
            )));
            let collector_clone = collector.clone();

            // Start background task to collect SSE data
            tokio::spawn(async move {
                while let Some(data) = rx.recv().await {
                    collector_clone.lock().await.push(data);
                }
            });

            Some(collector)
        } else {
            None
        };

        // Define a helper closure to flush SSE logs on error
        let flush_sse_on_error = |collector: &Option<Arc<tokio::sync::Mutex<SseLogCollector>>>,
                                  error_context: &str| {
            let collector = collector.clone();
            let error_context = error_context.to_string();
            async move {
                if let Some(c) = collector {
                    // Wait a short time for background task to finish collecting data
                    tokio::time::sleep(std::time::Duration::from_millis(100)).await;
                    c.lock().await.flush_on_error(&error_context);
                }
            }
        };

        loop {
            tokio::select! {
                // Check cancellation token
                _ = cancellation_token.cancelled() => {
                    debug!("Cancel token detected, stopping stream processing: session_id={}", ctx.session_id);
                    if options.recover_partial_on_cancel && ctx.can_recover_as_partial_result() {
                        self.send_thinking_end_if_needed(&mut ctx).await;
                        ctx.force_finish_pending_tool_calls();
                        ctx.partial_recovery_reason =
                            Some("Stream processing cancelled after partial output".to_string());
                        self.log_stream_result(&ctx);
                        break;
                    }
                    self.graceful_shutdown_from_ctx(&mut ctx, "User cancelled stream processing".to_string()).await;
                    return Err(StreamProcessError::new(
                        StreamProcessorError::Cancelled("Stream processing cancelled".to_string()),
                        ctx.has_effective_output,
                    ));
                }

                // Watch the adapter -> processor stream only when the upstream stream idle timeout is configured.
                next_result = next_stream_item(&mut stream, watchdog_timeout) => {
                    let response = match next_result {
                        TimedStreamItem::Item(Ok(response)) => response,
                        TimedStreamItem::End => {
                            debug!("Stream ended normally (no more data)");
                            break;
                        }
                        TimedStreamItem::Item(Err(e)) => {
                            let provider_error = e.downcast_ref::<AiProviderError>().cloned();
                            let error_msg = format!("Stream processing error: {}", e);
                            error!("{}", error_msg);
                            let non_recoverable_stream_error =
                                error_msg.contains("SSE Parsing Error");
                            if !non_recoverable_stream_error && ctx.can_recover_as_partial_result()
                            {
                                flush_sse_on_error(&sse_collector, &error_msg).await;
                                self.send_thinking_end_if_needed(&mut ctx).await;
                                ctx.force_finish_pending_tool_calls();
                                ctx.partial_recovery_reason = Some(error_msg.clone());
                                self.log_stream_result(&ctx);
                                break;
                            }
                            // log SSE for network errors
                            flush_sse_on_error(&sse_collector, &error_msg).await;
                            self.graceful_shutdown_from_ctx(&mut ctx, error_msg.clone()).await;
                            return Err(StreamProcessError::new(
                                provider_error
                                    .map(StreamProcessorError::AiProvider)
                                    .unwrap_or(StreamProcessorError::AiClient(error_msg)),
                                ctx.has_effective_output,
                            ));
                        }
                        TimedStreamItem::TimedOut => {
                            let timeout_secs =
                                watchdog_timeout.map(|timeout| timeout.as_secs()).unwrap_or(0);
                            let error_msg = format!(
                                "Stream processor watchdog timeout (no data received for {} seconds)",
                                timeout_secs
                            );
                            error!(
                                "Stream processor watchdog timeout ({} seconds), forcing termination",
                                timeout_secs
                            );
                            // log SSE for timeout errors
                            flush_sse_on_error(&sse_collector, &error_msg).await;
                            if ctx.can_recover_as_partial_result() {
                                self.send_thinking_end_if_needed(&mut ctx).await;
                                ctx.force_finish_pending_tool_calls();
                                ctx.partial_recovery_reason = Some(error_msg.clone());
                                self.log_stream_result(&ctx);
                                break;
                            }
                            self.graceful_shutdown_from_ctx(&mut ctx, error_msg.clone()).await;
                            return Err(StreamProcessError::new(
                                StreamProcessorError::AiClient(error_msg),
                                ctx.has_effective_output,
                            ));
                        }
                    };

                    let UnifiedResponse {
                        text,
                        reasoning_content,
                        reasoning_content_kind,
                        thinking_signature,
                        tool_call,
                        usage,
                        tool_call_completion,
                        finish_reason,
                        provider_metadata,
                        model_response_replay,
                    } = response;
                    ctx.mark_first_stream_chunk();

                    // Handle thinking_signature
                    if let Some(signature) = thinking_signature {
                        if !signature.is_empty() {
                            ctx.reasoning_content_present = true;
                            ctx.thinking_signature = Some(signature);
                            trace!("Received thinking_signature");
                        }
                    }

                    // Handle different types of response content
                    // Normalize empty strings to None
                    //  (some models send empty text alongside reasoning content)
                    let text = text.filter(|t| !t.is_empty());

                    if let Some(thinking_content) = reasoning_content {
                        ctx.reasoning_content_present = true;
                        if !thinking_content.is_empty() {
                            self.handle_thinking_chunk(
                                &mut ctx,
                                thinking_content,
                                reasoning_content_kind,
                            )
                            .await;
                            if let Some(err) = self.check_cancellation(&mut ctx, cancellation_token, "processing thinking chunk").await {
                                return err;
                            }
                        }
                    }

                    if let Some(text) = text {
                        self.send_thinking_end_if_needed(&mut ctx).await;
                        self.handle_text_chunk(&mut ctx, text).await;
                        if let Some(err) = self.check_cancellation(&mut ctx, cancellation_token, "processing text chunk").await {
                            return err;
                        }
                    }

                    if let Some(tool_call) = tool_call {
                        self.send_thinking_end_if_needed(&mut ctx).await;
                        self.handle_tool_call_chunk(&mut ctx, tool_call).await;
                        if let Some(err) = self.check_cancellation(&mut ctx, cancellation_token, "processing tool call").await {
                            return err;
                        }
                    }

                    if let Some(ref response_usage) = usage {
                        self.handle_usage(&mut ctx, response_usage);
                    }

                    if let Some(provider_metadata) = provider_metadata {
                        match ctx.provider_metadata.as_mut() {
                            Some(existing) => Self::merge_json_value(existing, provider_metadata),
                            None => ctx.provider_metadata = Some(provider_metadata),
                        }
                    }

                    if let Some(model_response_replay) = model_response_replay {
                        ctx.model_response_replay = Some(model_response_replay);
                    }

                    if let Some(reason) = finish_reason {
                        let completion = tool_call_completion.unwrap_or(ToolCallCompletion::Unknown);
                        let _ = ctx.finalize_all_pending_tool_calls(
                            ToolCallBoundary::FinishReason,
                            completion,
                        );
                        if is_token_limit_finish_reason(&reason) {
                            ctx.token_limit_finish_reason = Some(reason);
                        }
                    }
                }
            }
        }

        // Ensure thinking end marker is sent
        self.send_thinking_end_if_needed(&mut ctx).await;
        self.flush_hidden_text_tail(&mut ctx).await;

        let _ = ctx.finalize_all_pending_tool_calls(
            ToolCallBoundary::StreamEnd,
            ToolCallCompletion::Unknown,
        );

        // A token-limit finish_reason means the provider ended the stream
        // gracefully but the answer is silently truncated. Surface it as a
        // partial recovery so downstream execution can continue the answer in
        // a follow-up round instead of accepting cut-off output as final.
        // Tool-call rounds are excluded: they already continue via the normal
        // round loop, and truncated tool arguments have their own repair path.
        if ctx.partial_recovery_reason.is_none()
            && ctx.tool_calls.is_empty()
            && !ctx.full_text.is_empty()
        {
            if let Some(reason) = ctx.token_limit_finish_reason.take() {
                ctx.partial_recovery_reason = Some(format!(
                    "response truncated by model output token limit (finish_reason={})",
                    reason
                ));
            }
        }

        // Invalid tool payloads that survive to finalization still need detailed SSE logs for diagnosis.
        if ctx.tool_calls.iter().any(|tc| !tc.is_valid()) {
            flush_sse_on_error(&sse_collector, "Has invalid tool calls").await;
        }

        self.log_stream_result(&ctx);

        Ok(ctx.into_result())
    }
}

#[cfg(test)]
mod tests {
    use super::{
        is_token_limit_finish_reason, GracefulShutdownInput, HiddenTextTag,
        ModelResponseReplayCapture, SseLogCollector, SseLogConfig, StreamEventSink,
        StreamProcessOptions, StreamProcessor, StreamProcessorError, ToolArgumentRepairKind,
        ToolCall, ToolCallCompletion,
    };
    use super::{UnifiedResponse, UnifiedTokenUsage, UnifiedToolCall};
    use futures::StreamExt;
    use openbitfun_core_types::errors::{AiProviderError, ErrorCategory};
    use openbitfun_core_types::{ModelResponseReplayItem, ReasoningContentKind};
    use openbitfun_events::{AgenticEvent, AgenticEventPriority as EventPriority, ToolEventData};
    use serde_json::json;
    use std::sync::Arc;
    use std::time::Duration;
    use tokio_stream::iter;
    use tokio_util::sync::CancellationToken;

    struct NoopEventSink;

    #[async_trait::async_trait]
    impl StreamEventSink for NoopEventSink {
        async fn enqueue(&self, _event: AgenticEvent, _priority: Option<EventPriority>) {}
    }

    #[derive(Default)]
    struct RecordingEventSink {
        events: tokio::sync::Mutex<Vec<AgenticEvent>>,
    }

    #[async_trait::async_trait]
    impl StreamEventSink for RecordingEventSink {
        async fn enqueue(&self, event: AgenticEvent, _priority: Option<EventPriority>) {
            self.events.lock().await.push(event);
        }
    }

    fn build_processor() -> StreamProcessor {
        StreamProcessor::new(Arc::new(NoopEventSink))
    }

    #[tokio::test]
    async fn preserves_structured_provider_error_from_adapter_stream() {
        let processor = build_processor();
        let provider_error = AiProviderError::from_parts(
            "Request failed".to_string(),
            Some("openai".to_string()),
            Some("context_length_exceeded".to_string()),
            None,
        );
        let stream = iter(vec![Err::<UnifiedResponse, _>(anyhow::Error::new(
            provider_error,
        ))])
        .boxed();

        let result = processor
            .process_stream(
                stream,
                None,
                None,
                "session_1".to_string(),
                "turn_1".to_string(),
                "round_1".to_string(),
                "round_1:attempt:1".to_string(),
                1,
                &CancellationToken::new(),
            )
            .await
            .expect_err("provider error should fail the stream");

        match result.error {
            StreamProcessorError::AiProvider(error) => {
                assert_eq!(error.category, ErrorCategory::ContextOverflow);
                assert_eq!(
                    error.provider_code.as_deref(),
                    Some("context_length_exceeded")
                );
            }
            error => panic!("unexpected stream error: {error:?}"),
        }
    }

    #[tokio::test]
    async fn graceful_shutdown_emits_tool_cleanup_before_turn_cancellation() {
        let sink = Arc::new(RecordingEventSink::default());
        let processor = StreamProcessor::new(sink.clone());

        processor
            .graceful_shutdown(GracefulShutdownInput {
                session_id: "session_1".to_string(),
                turn_id: "turn_1".to_string(),
                round_id: "round_1".to_string(),
                attempt_id: "attempt_1".to_string(),
                attempt_index: 1,
                tool_calls: vec![ToolCall {
                    tool_id: "tool_1".to_string(),
                    tool_name: "Read".to_string(),
                    arguments: json!({}),
                    raw_arguments: None,
                    is_error: false,
                    parse_error: None,
                    recovered_from_truncation: false,
                    repair_kind: Default::default(),
                }],
                reason: "User cancelled stream processing".to_string(),
                suppress_cancel_lifecycle_event: false,
            })
            .await;

        let events = sink.events.lock().await;
        assert_eq!(events.len(), 2);
        assert!(matches!(
            &events[0],
            AgenticEvent::ToolEvent {
                tool_event: ToolEventData::Cancelled { identity, .. },
                ..
            } if identity.tool_id == "tool_1"
        ));
        assert!(matches!(
            &events[1],
            AgenticEvent::DialogTurnCancelled { session_id, turn_id }
                if session_id == "session_1" && turn_id == "turn_1"
        ));
    }

    #[tokio::test]
    async fn graceful_shutdown_suppresses_turn_cancellation_for_coordinator_owned_lifecycle() {
        let sink = Arc::new(RecordingEventSink::default());
        let processor = StreamProcessor::new(sink.clone());

        processor
            .graceful_shutdown(GracefulShutdownInput {
                session_id: "session_1".to_string(),
                turn_id: "turn_1".to_string(),
                round_id: "round_1".to_string(),
                attempt_id: "attempt_1".to_string(),
                attempt_index: 1,
                tool_calls: vec![ToolCall {
                    tool_id: "tool_1".to_string(),
                    tool_name: "Read".to_string(),
                    arguments: json!({}),
                    raw_arguments: None,
                    is_error: false,
                    parse_error: None,
                    recovered_from_truncation: false,
                    repair_kind: Default::default(),
                }],
                reason: "User cancelled stream processing".to_string(),
                suppress_cancel_lifecycle_event: true,
            })
            .await;

        let events = sink.events.lock().await;
        assert_eq!(events.len(), 1);
        assert!(matches!(
            &events[0],
            AgenticEvent::ToolEvent {
                tool_event: ToolEventData::Cancelled { identity, .. },
                ..
            } if identity.tool_id == "tool_1"
        ));
    }

    #[test]
    fn derives_watchdog_timeout_from_stream_idle_timeout() {
        assert_eq!(StreamProcessor::derive_watchdog_timeout(None), None);
        assert_eq!(
            StreamProcessor::derive_watchdog_timeout(Some(Duration::from_secs(10))),
            Some(Duration::from_secs(12))
        );
    }

    #[test]
    fn recognizes_responses_api_output_limit_finish_reasons() {
        assert!(is_token_limit_finish_reason("incomplete:max_output_tokens"));
        assert!(is_token_limit_finish_reason("incomplete:max_tokens"));
        assert!(!is_token_limit_finish_reason("incomplete:content_filter"));
    }

    #[test]
    fn sse_log_collector_retains_tail_with_byte_limit() {
        let mut collector = SseLogCollector::new(SseLogConfig {
            max_output: None,
            max_retained_bytes: 6,
        });

        collector.push("abcd".to_string());
        collector.push("ef".to_string());
        collector.push("ghi".to_string());

        assert_eq!(collector.len(), 2);
        assert_eq!(collector.dropped_events, 1);
        assert_eq!(collector.dropped_bytes, 4);
        assert_eq!(
            collector.buffer.iter().cloned().collect::<Vec<_>>(),
            vec!["ef".to_string(), "ghi".to_string()]
        );
    }

    #[test]
    fn sse_log_collector_tracks_fully_omitted_events() {
        let mut collector = SseLogCollector::new(SseLogConfig {
            max_output: None,
            max_retained_bytes: 3,
        });

        collector.push("abcd".to_string());

        assert!(collector.is_empty());
        assert_eq!(collector.dropped_events, 1);
        assert_eq!(collector.dropped_bytes, 4);
        assert_eq!(
            collector.format_history_message().as_deref(),
            Some("SSE history (0 retained of 1 events, 4 bytes omitted):\n")
        );
    }

    fn sample_usage(total_tokens: u32) -> UnifiedTokenUsage {
        UnifiedTokenUsage {
            prompt_token_count: 1,
            candidates_token_count: total_tokens.saturating_sub(1),
            total_token_count: total_tokens,
            reasoning_token_count: None,
            cached_content_token_count: None,
            cache_creation_token_count: None,
        }
    }

    fn memory_hidden_tag() -> HiddenTextTag {
        HiddenTextTag::new(
            "memory_citation",
            "<openbitfun-mem-citation>",
            "</openbitfun-mem-citation>",
        )
    }

    #[tokio::test]
    async fn strips_hidden_text_tags_across_stream_chunks() {
        let sink = Arc::new(RecordingEventSink::default());
        let processor = StreamProcessor::new(sink.clone());
        let stream = iter(vec![
            Ok(UnifiedResponse {
                text: Some("hello <openbitfun-mem-".to_string()),
                ..Default::default()
            }),
            Ok(UnifiedResponse {
                text: Some(
                    "citation><citation_entries>\nMEMORY.md:1-2|note=[x]\n</citation_entries></openbitfun-mem-citation> world"
                        .to_string(),
                ),
                ..Default::default()
            }),
        ])
        .boxed();

        let result = processor
            .process_stream_with_options(
                stream,
                None,
                None,
                "session_1".to_string(),
                "turn_1".to_string(),
                "round_1".to_string(),
                "round_1:attempt:1".to_string(),
                1,
                &CancellationToken::new(),
                StreamProcessOptions {
                    hidden_text_tags: vec![memory_hidden_tag()],
                    ..Default::default()
                },
            )
            .await
            .expect("stream result");

        assert_eq!(result.full_text, "hello  world");
        assert_eq!(result.hidden_text_blocks.len(), 1);
        assert_eq!(result.hidden_text_blocks[0].name, "memory_citation");
        assert!(result.hidden_text_blocks[0]
            .payload
            .contains("MEMORY.md:1-2"));

        let events = sink.events.lock().await;
        let text_chunks = events
            .iter()
            .filter_map(|event| match event {
                AgenticEvent::TextChunk { text, .. } => Some(text.as_str()),
                _ => None,
            })
            .collect::<Vec<_>>();
        assert_eq!(text_chunks, vec!["hello ", " world"]);
        assert!(!text_chunks
            .iter()
            .any(|text| text.contains("<openbitfun-mem-citation>")));
    }

    #[tokio::test]
    async fn auto_closes_unterminated_hidden_text_tag_on_stream_end() {
        let processor = build_processor();
        let stream = iter(vec![Ok(UnifiedResponse {
            text: Some("hello<openbitfun-mem-citation>payload".to_string()),
            ..Default::default()
        })])
        .boxed();

        let result = processor
            .process_stream_with_options(
                stream,
                None,
                None,
                "session_1".to_string(),
                "turn_1".to_string(),
                "round_1".to_string(),
                "round_1:attempt:1".to_string(),
                1,
                &CancellationToken::new(),
                StreamProcessOptions {
                    hidden_text_tags: vec![memory_hidden_tag()],
                    ..Default::default()
                },
            )
            .await
            .expect("stream result");

        assert_eq!(result.full_text, "hello");
        assert_eq!(result.hidden_text_blocks[0].payload, "payload");
    }

    #[tokio::test]
    async fn recovers_partial_text_when_cancellation_allows_partial_recovery() {
        let processor = build_processor();
        let (tx, rx) = tokio::sync::mpsc::unbounded_channel();
        tx.send(Ok(UnifiedResponse {
            text: Some("Partial reviewer evidence.".to_string()),
            ..Default::default()
        }))
        .expect("send partial chunk");
        let _keep_stream_open = tx;
        let cancellation_token = CancellationToken::new();
        let cancel_clone = cancellation_token.clone();
        tokio::spawn(async move {
            tokio::time::sleep(Duration::from_millis(10)).await;
            cancel_clone.cancel();
        });

        let result = processor
            .process_stream_with_options(
                tokio_stream::wrappers::UnboundedReceiverStream::new(rx).boxed(),
                None,
                None,
                "session_1".to_string(),
                "turn_1".to_string(),
                "round_1".to_string(),
                "round_1:attempt:1".to_string(),
                1,
                &cancellation_token,
                StreamProcessOptions {
                    recover_partial_on_cancel: true,
                    ..Default::default()
                },
            )
            .await
            .expect("partial stream result");

        assert_eq!(result.full_text, "Partial reviewer evidence.");
        assert!(result
            .partial_recovery_reason
            .as_deref()
            .is_some_and(|reason| reason.contains("cancelled")));
    }

    #[tokio::test]
    async fn keeps_collecting_tool_args_across_usage_chunks() {
        let processor = build_processor();
        let stream = iter(vec![
            Ok(UnifiedResponse {
                tool_call: Some(UnifiedToolCall {
                    tool_call_index: None,
                    id: Some("call_1".to_string()),
                    name: Some("tool_a".to_string()),
                    arguments: Some("{\"a\":".to_string()),
                    arguments_is_snapshot: false,
                }),
                usage: Some(sample_usage(5)),
                ..Default::default()
            }),
            Ok(UnifiedResponse {
                tool_call: Some(UnifiedToolCall {
                    tool_call_index: None,
                    id: None,
                    name: None,
                    arguments: Some("1}".to_string()),
                    arguments_is_snapshot: false,
                }),
                usage: Some(sample_usage(7)),
                ..Default::default()
            }),
        ])
        .boxed();

        let result = processor
            .process_stream(
                stream,
                None,
                None,
                "session_1".to_string(),
                "turn_1".to_string(),
                "round_1".to_string(),
                "round_1:attempt:1".to_string(),
                1,
                &CancellationToken::new(),
            )
            .await
            .expect("stream result");

        assert_eq!(result.tool_calls.len(), 1);
        assert_eq!(result.tool_calls[0].tool_id, "call_1");
        assert_eq!(result.tool_calls[0].tool_name, "tool_a");
        assert_eq!(result.tool_calls[0].arguments, json!({"a": 1}));
        assert_eq!(
            result.tool_calls[0].raw_arguments.as_deref(),
            Some("{\"a\":1}")
        );
        assert!(!result.tool_calls[0].is_error);
        assert_eq!(result.usage.as_ref().map(|u| u.total_token_count), Some(7));
    }

    #[tokio::test]
    async fn marks_token_limit_truncated_text_as_partial_recovery() {
        let processor = build_processor();
        let stream = iter(vec![
            Ok(UnifiedResponse {
                text: Some("{\"slides\": [{\"title\": \"cut off".to_string()),
                ..Default::default()
            }),
            Ok(UnifiedResponse {
                finish_reason: Some("length".to_string()),
                ..Default::default()
            }),
        ])
        .boxed();

        let result = processor
            .process_stream(
                stream,
                None,
                None,
                "session_1".to_string(),
                "turn_1".to_string(),
                "round_1".to_string(),
                "round_1:attempt:1".to_string(),
                1,
                &CancellationToken::new(),
            )
            .await
            .expect("stream result");

        assert!(result
            .partial_recovery_reason
            .as_deref()
            .is_some_and(|reason| reason.contains("output token limit")));
    }

    #[tokio::test]
    async fn natural_stop_finish_reason_is_not_partial_recovery() {
        let processor = build_processor();
        let stream = iter(vec![
            Ok(UnifiedResponse {
                text: Some("complete answer".to_string()),
                ..Default::default()
            }),
            Ok(UnifiedResponse {
                finish_reason: Some("stop".to_string()),
                ..Default::default()
            }),
        ])
        .boxed();

        let result = processor
            .process_stream(
                stream,
                None,
                None,
                "session_1".to_string(),
                "turn_1".to_string(),
                "round_1".to_string(),
                "round_1:attempt:1".to_string(),
                1,
                &CancellationToken::new(),
            )
            .await
            .expect("stream result");

        assert!(result.partial_recovery_reason.is_none());
    }

    #[tokio::test]
    async fn token_limit_with_tool_calls_is_not_partial_recovery() {
        let processor = build_processor();
        let stream = iter(vec![
            Ok(UnifiedResponse {
                tool_call: Some(UnifiedToolCall {
                    tool_call_index: None,
                    id: Some("call_1".to_string()),
                    name: Some("tool_a".to_string()),
                    arguments: Some("{\"a\":1}".to_string()),
                    arguments_is_snapshot: false,
                }),
                ..Default::default()
            }),
            Ok(UnifiedResponse {
                finish_reason: Some("MAX_TOKENS".to_string()),
                ..Default::default()
            }),
        ])
        .boxed();

        let result = processor
            .process_stream(
                stream,
                None,
                None,
                "session_1".to_string(),
                "turn_1".to_string(),
                "round_1".to_string(),
                "round_1:attempt:1".to_string(),
                1,
                &CancellationToken::new(),
            )
            .await
            .expect("stream result");

        // Tool-call rounds continue through the normal round loop.
        assert!(result.partial_recovery_reason.is_none());
    }

    #[tokio::test]
    async fn whitespace_only_text_is_not_effective_output() {
        let processor = build_processor();
        let stream = iter(vec![Ok(UnifiedResponse {
            text: Some("\n\n ".to_string()),
            ..Default::default()
        })])
        .boxed();

        let result = processor
            .process_stream(
                stream,
                None,
                None,
                "session_1".to_string(),
                "turn_1".to_string(),
                "round_1".to_string(),
                "round_1:attempt:1".to_string(),
                1,
                &CancellationToken::new(),
            )
            .await
            .expect("stream result");

        assert_eq!(result.full_text, "\n\n ");
        assert!(!result.has_effective_output);
        assert_eq!(result.first_visible_output_ms, None);
    }

    #[tokio::test]
    async fn finalizes_tool_after_same_chunk_finish_reason() {
        let processor = build_processor();
        let stream = iter(vec![Ok(UnifiedResponse {
            tool_call: Some(UnifiedToolCall {
                tool_call_index: None,
                id: Some("call_1".to_string()),
                name: Some("tool_a".to_string()),
                arguments: Some("{\"a\":1}".to_string()),
                arguments_is_snapshot: false,
            }),
            usage: Some(sample_usage(9)),
            finish_reason: Some("tool_calls".to_string()),
            ..Default::default()
        })])
        .boxed();

        let result = processor
            .process_stream(
                stream,
                None,
                None,
                "session_1".to_string(),
                "turn_1".to_string(),
                "round_1".to_string(),
                "round_1:attempt:1".to_string(),
                1,
                &CancellationToken::new(),
            )
            .await
            .expect("stream result");

        assert_eq!(result.tool_calls.len(), 1);
        assert_eq!(result.tool_calls[0].arguments, json!({"a": 1}));
        assert_eq!(result.usage.as_ref().map(|u| u.total_token_count), Some(9));
    }

    #[tokio::test]
    async fn skips_duplicate_finalized_tool_call_id_from_tail_chunks() {
        let processor = build_processor();
        let stream = iter(vec![
            Ok(UnifiedResponse {
                tool_call: Some(UnifiedToolCall {
                    tool_call_index: None,
                    id: Some("call_1".to_string()),
                    name: Some("tool_a".to_string()),
                    arguments: Some("{\"a\":1}".to_string()),
                    arguments_is_snapshot: false,
                }),
                finish_reason: Some("tool_calls".to_string()),
                ..Default::default()
            }),
            Ok(UnifiedResponse {
                tool_call: Some(UnifiedToolCall {
                    tool_call_index: None,
                    id: Some("call_1".to_string()),
                    name: Some("tool_a".to_string()),
                    arguments: Some("{\"a\":1}".to_string()),
                    arguments_is_snapshot: false,
                }),
                ..Default::default()
            }),
        ])
        .boxed();

        let result = processor
            .process_stream(
                stream,
                None,
                None,
                "session_1".to_string(),
                "turn_1".to_string(),
                "round_1".to_string(),
                "round_1:attempt:1".to_string(),
                1,
                &CancellationToken::new(),
            )
            .await
            .expect("stream result");

        assert_eq!(result.tool_calls.len(), 1);
        assert_eq!(result.tool_calls[0].tool_id, "call_1");
        assert_eq!(result.tool_calls[0].arguments, json!({"a": 1}));
    }

    #[tokio::test]
    async fn does_not_repair_tool_args_with_one_extra_trailing_right_brace() {
        let processor = build_processor();
        let stream = iter(vec![Ok(UnifiedResponse {
            tool_call: Some(UnifiedToolCall {
                tool_call_index: None,
                id: Some("call_1".to_string()),
                name: Some("tool_a".to_string()),
                arguments: Some("{\"a\":1}}".to_string()),
                arguments_is_snapshot: false,
            }),
            finish_reason: Some("tool_calls".to_string()),
            ..Default::default()
        })])
        .boxed();

        let result = processor
            .process_stream(
                stream,
                None,
                None,
                "session_1".to_string(),
                "turn_1".to_string(),
                "round_1".to_string(),
                "round_1:attempt:1".to_string(),
                1,
                &CancellationToken::new(),
            )
            .await
            .expect("stream result");

        assert_eq!(result.tool_calls.len(), 1);
        assert_eq!(result.tool_calls[0].tool_id, "call_1");
        assert_eq!(result.tool_calls[0].tool_name, "tool_a");
        assert_eq!(result.tool_calls[0].arguments, json!({}));
        assert_eq!(
            result.tool_calls[0].raw_arguments.as_deref(),
            Some("{\"a\":1}}")
        );
        assert!(result.tool_calls[0].is_error);
    }

    #[tokio::test]
    async fn repairs_non_write_arguments_only_for_typed_normal_tool_use_completion() {
        let processor = build_processor();
        let stream = iter(vec![Ok(UnifiedResponse {
            tool_call: Some(UnifiedToolCall {
                tool_call_index: None,
                id: Some("call_1".to_string()),
                name: Some("Read".to_string()),
                arguments: Some(r#"{"path":"src/main.rs" "line_end":4}"#.to_string()),
                arguments_is_snapshot: false,
            }),
            tool_call_completion: Some(ToolCallCompletion::NormalToolUse),
            finish_reason: Some("tool_calls".to_string()),
            ..Default::default()
        })])
        .boxed();

        let result = processor
            .process_stream_with_options(
                stream,
                None,
                None,
                "session_1".to_string(),
                "turn_1".to_string(),
                "round_1".to_string(),
                "round_1:attempt:1".to_string(),
                1,
                &CancellationToken::new(),
                StreamProcessOptions {
                    allow_normal_tool_json_repair: true,
                    ..Default::default()
                },
            )
            .await
            .expect("stream result");

        assert_eq!(result.tool_calls.len(), 1);
        assert!(!result.tool_calls[0].is_error);
        assert_eq!(
            result.tool_calls[0].repair_kind,
            ToolArgumentRepairKind::PermissiveNormalToolJsonRepair
        );
        assert_eq!(
            result.tool_calls[0].arguments,
            json!({"path": "src/main.rs", "line_end": 4})
        );
    }

    #[tokio::test]
    async fn does_not_repair_non_write_arguments_after_output_limit() {
        let processor = build_processor();
        let stream = iter(vec![Ok(UnifiedResponse {
            tool_call: Some(UnifiedToolCall {
                tool_call_index: None,
                id: Some("call_1".to_string()),
                name: Some("Read".to_string()),
                arguments: Some(r#"{"path":"src/main.rs" "line_end":4}"#.to_string()),
                arguments_is_snapshot: false,
            }),
            tool_call_completion: Some(ToolCallCompletion::OutputLimit),
            finish_reason: Some("length".to_string()),
            ..Default::default()
        })])
        .boxed();

        let result = processor
            .process_stream_with_options(
                stream,
                None,
                None,
                "session_1".to_string(),
                "turn_1".to_string(),
                "round_1".to_string(),
                "round_1:attempt:1".to_string(),
                1,
                &CancellationToken::new(),
                StreamProcessOptions {
                    allow_normal_tool_json_repair: true,
                    ..Default::default()
                },
            )
            .await
            .expect("stream result");

        assert_eq!(result.tool_calls.len(), 1);
        assert!(result.tool_calls[0].is_error);
        assert_eq!(
            result.tool_calls[0].repair_kind,
            ToolArgumentRepairKind::None
        );
    }

    #[tokio::test]
    async fn replaces_tool_args_when_snapshot_chunk_arrives() {
        let processor = build_processor();
        let stream = iter(vec![
            Ok(UnifiedResponse {
                tool_call: Some(UnifiedToolCall {
                    tool_call_index: None,
                    id: Some("call_1".to_string()),
                    name: Some("tool_a".to_string()),
                    arguments: Some("{\"city\":\"Bei".to_string()),
                    arguments_is_snapshot: false,
                }),
                ..Default::default()
            }),
            Ok(UnifiedResponse {
                tool_call: Some(UnifiedToolCall {
                    tool_call_index: None,
                    id: None,
                    name: None,
                    arguments: Some("{\"city\":\"Beijing\"}".to_string()),
                    arguments_is_snapshot: true,
                }),
                finish_reason: Some("tool_calls".to_string()),
                ..Default::default()
            }),
        ])
        .boxed();

        let result = processor
            .process_stream(
                stream,
                None,
                None,
                "session_1".to_string(),
                "turn_1".to_string(),
                "round_1".to_string(),
                "round_1:attempt:1".to_string(),
                1,
                &CancellationToken::new(),
            )
            .await
            .expect("stream result");

        assert_eq!(result.tool_calls.len(), 1);
        assert_eq!(result.tool_calls[0].tool_id, "call_1");
        assert_eq!(result.tool_calls[0].tool_name, "tool_a");
        assert_eq!(result.tool_calls[0].arguments, json!({"city": "Beijing"}));
        assert_eq!(
            result.tool_calls[0].raw_arguments.as_deref(),
            Some("{\"city\":\"Beijing\"}")
        );
        assert!(!result.tool_calls[0].is_error);
    }

    #[tokio::test]
    async fn keeps_interleaved_indexed_tool_calls_separate() {
        let processor = build_processor();
        let stream = iter(vec![
            Ok(UnifiedResponse {
                tool_call: Some(UnifiedToolCall {
                    tool_call_index: Some(0),
                    id: Some("call_0".to_string()),
                    name: Some("tool_a".to_string()),
                    arguments: None,
                    arguments_is_snapshot: false,
                }),
                ..Default::default()
            }),
            Ok(UnifiedResponse {
                tool_call: Some(UnifiedToolCall {
                    tool_call_index: Some(1),
                    id: Some("call_1".to_string()),
                    name: Some("tool_b".to_string()),
                    arguments: None,
                    arguments_is_snapshot: false,
                }),
                ..Default::default()
            }),
            Ok(UnifiedResponse {
                tool_call: Some(UnifiedToolCall {
                    tool_call_index: Some(0),
                    id: None,
                    name: None,
                    arguments: Some("{\"a\":1}".to_string()),
                    arguments_is_snapshot: false,
                }),
                ..Default::default()
            }),
            Ok(UnifiedResponse {
                tool_call: Some(UnifiedToolCall {
                    tool_call_index: Some(1),
                    id: None,
                    name: None,
                    arguments: Some("{\"b\":2}".to_string()),
                    arguments_is_snapshot: false,
                }),
                finish_reason: Some("tool_calls".to_string()),
                ..Default::default()
            }),
        ])
        .boxed();

        let result = processor
            .process_stream(
                stream,
                None,
                None,
                "session_1".to_string(),
                "turn_1".to_string(),
                "round_1".to_string(),
                "round_1:attempt:1".to_string(),
                1,
                &CancellationToken::new(),
            )
            .await
            .expect("stream result");

        assert_eq!(result.tool_calls.len(), 2);
        assert_eq!(result.tool_calls[0].tool_id, "call_0");
        assert_eq!(result.tool_calls[0].tool_name, "tool_a");
        assert_eq!(result.tool_calls[0].arguments, json!({"a": 1}));
        assert_eq!(result.tool_calls[1].tool_id, "call_1");
        assert_eq!(result.tool_calls[1].tool_name, "tool_b");
        assert_eq!(result.tool_calls[1].arguments, json!({"b": 2}));
    }

    #[tokio::test]
    async fn preserves_empty_reasoning_presence_for_replay() {
        let processor = build_processor();
        let stream = iter(vec![Ok(UnifiedResponse {
            reasoning_content: Some(String::new()),
            finish_reason: Some("stop".to_string()),
            ..Default::default()
        })])
        .boxed();

        let result = processor
            .process_stream(
                stream,
                None,
                None,
                "session_1".to_string(),
                "turn_1".to_string(),
                "round_1".to_string(),
                "round_1:attempt:1".to_string(),
                1,
                &CancellationToken::new(),
            )
            .await
            .expect("stream result");

        assert!(result.reasoning_content_present);
        assert!(result.full_thinking.is_empty());
        assert!(!result.has_effective_output);
    }

    #[tokio::test]
    async fn keeps_reasoning_and_summary_streams_separate_and_prefers_summary() {
        let sink = Arc::new(RecordingEventSink::default());
        let processor = StreamProcessor::new(sink.clone());
        let stream = iter(vec![
            Ok(UnifiedResponse {
                reasoning_content: Some("private ".to_string()),
                reasoning_content_kind: Some(ReasoningContentKind::Reasoning),
                ..Default::default()
            }),
            Ok(UnifiedResponse {
                reasoning_content: Some("chain".to_string()),
                reasoning_content_kind: Some(ReasoningContentKind::Reasoning),
                ..Default::default()
            }),
            Ok(UnifiedResponse {
                reasoning_content: Some("display ".to_string()),
                reasoning_content_kind: Some(ReasoningContentKind::Summary),
                ..Default::default()
            }),
            Ok(UnifiedResponse {
                reasoning_content: Some("summary".to_string()),
                reasoning_content_kind: Some(ReasoningContentKind::Summary),
                finish_reason: Some("stop".to_string()),
                ..Default::default()
            }),
        ])
        .boxed();

        let result = processor
            .process_stream(
                stream,
                None,
                None,
                "session_1".to_string(),
                "turn_1".to_string(),
                "round_1".to_string(),
                "round_1:attempt:1".to_string(),
                1,
                &CancellationToken::new(),
            )
            .await
            .expect("stream result");

        assert_eq!(result.full_thinking, "display summary");
        assert_eq!(
            result.reasoning_content_kind,
            Some(ReasoningContentKind::Summary)
        );

        let events = sink.events.lock().await;
        let thinking_events = events
            .iter()
            .filter(|event| matches!(event, AgenticEvent::ThinkingChunk { .. }))
            .collect::<Vec<_>>();
        assert!(thinking_events.iter().any(|event| matches!(
            event,
            AgenticEvent::ThinkingChunk {
                reasoning_kind: Some(ReasoningContentKind::Reasoning),
                ..
            }
        )));
        assert!(thinking_events.iter().any(|event| matches!(
            event,
            AgenticEvent::ThinkingChunk {
                reasoning_kind: Some(ReasoningContentKind::Summary),
                ..
            }
        )));
        assert_eq!(
            thinking_events
                .iter()
                .filter(|event| matches!(event, AgenticEvent::ThinkingChunk { is_end: true, .. }))
                .count(),
            2
        );
    }

    #[tokio::test]
    async fn carries_complete_model_response_replay_to_stream_result() {
        let processor = build_processor();
        let stream = iter(vec![
            Ok(UnifiedResponse {
                text: Some("done".to_string()),
                ..Default::default()
            }),
            Ok(UnifiedResponse {
                model_response_replay: Some(ModelResponseReplayCapture {
                    protocol: "openai_responses".to_string(),
                    items: vec![
                        ModelResponseReplayItem::OpaqueReasoning {
                            item_id: Some("rs_1".to_string()),
                            summary: vec![],
                            opaque_state: "opaque".to_string(),
                        },
                        ModelResponseReplayItem::AssistantMessage,
                    ],
                }),
                finish_reason: Some("stop".to_string()),
                ..Default::default()
            }),
        ])
        .boxed();

        let result = processor
            .process_stream(
                stream,
                None,
                None,
                "session_1".to_string(),
                "turn_1".to_string(),
                "round_1".to_string(),
                "round_1:attempt:1".to_string(),
                1,
                &CancellationToken::new(),
            )
            .await
            .expect("stream result");

        let replay = result.model_response_replay.expect("replay capture");
        assert_eq!(replay.protocol, "openai_responses");
        assert_eq!(replay.items.len(), 2);
    }
}
