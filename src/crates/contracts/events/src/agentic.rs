//! Agentic Events Definition
pub use openbitfun_core_types::errors::{AiErrorDetail, ErrorCategory};
use openbitfun_core_types::{ReasoningContentKind, SessionExecutionTarget, ToolImageAttachment};
use serde::{Deserialize, Deserializer, Serialize};
use std::time::SystemTime;

fn context_compression_applied_by_default() -> bool {
    true
}

fn deserialize_session_model_fallback_id<'de, D>(deserializer: D) -> Result<String, D::Error>
where
    D: Deserializer<'de>,
{
    let model_id = String::deserialize(deserializer)?;
    if matches!(model_id.trim(), "auto" | "default") {
        Ok("primary".to_string())
    } else {
        Ok(model_id)
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, PartialOrd, Ord, Serialize, Deserialize)]
pub enum AgenticEventPriority {
    Critical = 0, // Immediately send (error, cancellation)
    High = 1,
    Normal = 2,
    Low = 3,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct SubagentParentInfo {
    #[serde(rename = "toolCallId")]
    pub tool_call_id: String,
    #[serde(rename = "sessionId")]
    pub session_id: String,
    #[serde(rename = "dialogTurnId")]
    pub dialog_turn_id: String,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum DeepReviewQueueStatus {
    QueuedForCapacity,
    PausedByUser,
    Running,
    CapacitySkipped,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum DeepReviewQueueReason {
    ProviderRateLimit,
    ProviderConcurrencyLimit,
    RetryAfter,
    LocalConcurrencyCap,
    LaunchBatchBlocked,
    TemporaryOverload,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct DeepReviewQueueState {
    pub tool_id: String,
    pub subagent_type: String,
    pub status: DeepReviewQueueStatus,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub reason: Option<DeepReviewQueueReason>,
    pub queued_reviewer_count: usize,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub active_reviewer_count: Option<usize>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub effective_parallel_instances: Option<usize>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub optional_reviewer_count: Option<usize>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub queue_elapsed_ms: Option<u64>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub run_elapsed_ms: Option<u64>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub max_queue_wait_seconds: Option<u64>,
    #[serde(default)]
    pub session_concurrency_high: bool,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(tag = "type")]
pub enum AgenticEvent {
    SessionCreated {
        session_id: String,
        session_name: String,
        agent_type: String,
        /// Workspace path this session belongs to. None for locally-created sessions.
        #[serde(skip_serializing_if = "Option::is_none")]
        workspace_path: Option<String>,
        /// Main project root that owns persistence for this session.
        #[serde(default, skip_serializing_if = "Option::is_none")]
        project_workspace_path: Option<String>,
        /// Resolved local/worktree execution target.
        #[serde(default, skip_serializing_if = "Option::is_none")]
        execution_target: Option<SessionExecutionTarget>,
        /// Stable workspace registration associated with the execution root.
        #[serde(default, skip_serializing_if = "Option::is_none")]
        workspace_id: Option<String>,
        /// Remote SSH connection identity for sessions bound to remote workspaces.
        #[serde(skip_serializing_if = "Option::is_none")]
        remote_connection_id: Option<String>,
        /// Remote SSH host for sessions bound to remote workspaces.
        #[serde(skip_serializing_if = "Option::is_none")]
        remote_ssh_host: Option<String>,
    },

    SessionStateChanged {
        session_id: String,
        new_state: String,
    },

    /// The authoritative visible history for a session changed outside the
    /// append-only turn lifecycle (for example, after restoring a checkpoint).
    /// Consumers should invalidate cached transcript projections for this
    /// session and reload them from the owning runtime.
    SessionHistoryChanged {
        session_id: String,
        /// Present when this event is the per-Turn durable fence emitted after
        /// a settled Turn's terminal record was committed. Consumers may then
        /// repair only the settled tail instead of dropping a live projection
        /// of a newer executing Turn. Absent for out-of-lifecycle history
        /// edits such as undo/redo, which still require full invalidation.
        /// Optional so payloads from older hosts keep deserializing.
        #[serde(default, skip_serializing_if = "Option::is_none")]
        settled_turn_id: Option<String>,
    },

    SessionDeleted {
        session_id: String,
    },

    SessionTitleGenerated {
        session_id: String,
        title: String,
        method: String,
    },
    ImageAnalysisStarted {
        session_id: String,
        image_count: usize,
        user_input: String,
        /// Image metadata JSON for UI rendering (same as DialogTurnStarted)
        image_metadata: Option<serde_json::Value>,
    },

    ImageAnalysisCompleted {
        session_id: String,
        success: bool,
        duration_ms: u64,
    },

    DialogTurnStarted {
        session_id: String,
        turn_id: String,
        turn_index: usize,
        user_input: String,
        /// Original user input before vision enhancement (for display on all clients)
        original_user_input: Option<String>,
        /// Image metadata JSON for UI rendering (id, name, data_url, mime_type, image_path)
        user_message_metadata: Option<serde_json::Value>,
    },

    /// Low-frequency linking event that associates a hidden subagent session
    /// with the parent tool call that launched it.
    SubagentSessionLinked {
        session_id: String,
        subagent_dialog_turn_id: String,
        parent_session_id: String,
        parent_dialog_turn_id: String,
        parent_tool_call_id: String,
        #[serde(skip_serializing_if = "Option::is_none")]
        agent_type: Option<String>,
        /// Resolved model selector stored on the child session.
        #[serde(skip_serializing_if = "Option::is_none")]
        model_id: Option<String>,
        /// Runtime-admitted public label for a focused Review child.
        #[serde(skip_serializing_if = "Option::is_none")]
        focused_review_display_label: Option<String>,
    },

    DialogTurnCompleted {
        session_id: String,
        turn_id: String,
        total_rounds: usize,
        total_tools: usize,
        duration_ms: u64,
        /// When set, the turn finished but the last model round was a partial
        /// recovery (stream aborted mid-way). Contains a human-readable reason.
        #[serde(skip_serializing_if = "Option::is_none")]
        partial_recovery_reason: Option<String>,
        /// Whether the turn completed successfully.
        #[serde(skip_serializing_if = "Option::is_none")]
        success: Option<bool>,
        /// Why the turn finished.
        #[serde(skip_serializing_if = "Option::is_none")]
        finish_reason: Option<String>,
        /// Whether the turn produced a user-visible final response.
        #[serde(skip_serializing_if = "Option::is_none")]
        has_final_response: Option<bool>,
    },

    DialogTurnCancelled {
        session_id: String,
        turn_id: String,
    },

    DialogTurnInterrupted {
        session_id: String,
        turn_id: String,
        execution_generation: u32,
        model_id: Option<String>,
    },

    DialogTurnRecovered {
        session_id: String,
        turn_id: String,
        execution_generation: u32,
    },

    DialogTurnFailed {
        session_id: String,
        turn_id: String,
        error: String,
        #[serde(skip_serializing_if = "Option::is_none")]
        error_category: Option<ErrorCategory>,
        #[serde(skip_serializing_if = "Option::is_none")]
        error_detail: Option<AiErrorDetail>,
    },

    TokenUsageUpdated {
        session_id: String,
        turn_id: String,
        /// Resolved `AIModelConfig.id` used for this request.
        model_config_id: String,
        /// Provider model name sent on the request.
        effective_model_name: String,
        input_tokens: usize,
        output_tokens: Option<usize>,
        total_tokens: usize,
        max_context_tokens: Option<usize>,
        is_subagent: bool,
        #[serde(default, skip_serializing_if = "Option::is_none")]
        cached_tokens: Option<usize>,
        #[serde(default, skip_serializing_if = "Option::is_none")]
        token_details: Option<serde_json::Value>,
    },

    ContextCompressionStarted {
        session_id: String,
        turn_id: String,
        compression_id: String,
        trigger: String,
        tokens_before: usize,
        context_window: usize,
    },

    ContextCompressionCompleted {
        session_id: String,
        turn_id: String,
        compression_id: String,
        compression_count: usize,
        tokens_before: usize,
        tokens_after: usize,
        compression_ratio: f64,
        duration_ms: u64,
        has_summary: bool,
        summary_source: String,
        #[serde(default = "context_compression_applied_by_default")]
        applied: bool,
    },

    ContextCompressionFailed {
        session_id: String,
        turn_id: String,
        compression_id: String,
        error: String,
    },

    /// Emitted when a persisted session thread goal is created or updated.
    ThreadGoalUpdated {
        session_id: String,
        #[serde(default, skip_serializing_if = "Option::is_none")]
        goal: Option<serde_json::Value>,
    },

    ModelRoundStarted {
        session_id: String,
        turn_id: String,
        round_id: String,
        #[serde(default, skip_serializing_if = "Option::is_none")]
        round_group_id: Option<String>,
        round_index: usize,
        /// Resolved `AIModelConfig.id` used for this round.
        model_config_id: String,
        /// Provider model name sent on the request.
        effective_model_name: String,
    },

    /// Emitted as soon as an automatic retry supersedes one model attempt.
    ModelRoundAttemptSuperseded {
        session_id: String,
        turn_id: String,
        round_id: String,
        diagnostic: ModelRoundAttemptDiagnostic,
    },

    ModelRoundCompleted {
        session_id: String,
        turn_id: String,
        round_id: String,
        has_tool_calls: bool,
        #[serde(default, skip_serializing_if = "Option::is_none")]
        duration_ms: Option<u64>,
        #[serde(default, skip_serializing_if = "Option::is_none")]
        provider_id: Option<String>,
        /// Resolved `AIModelConfig.id` used for this round.
        model_config_id: String,
        /// Provider model name sent on the request.
        effective_model_name: String,
        #[serde(default, skip_serializing_if = "Option::is_none")]
        first_chunk_ms: Option<u64>,
        #[serde(default, skip_serializing_if = "Option::is_none")]
        first_visible_output_ms: Option<u64>,
        #[serde(default, skip_serializing_if = "Option::is_none")]
        stream_duration_ms: Option<u64>,
        #[serde(default, skip_serializing_if = "Option::is_none")]
        attempt_count: Option<u32>,
        #[serde(default, skip_serializing_if = "Option::is_none")]
        failure_category: Option<String>,
        #[serde(default, skip_serializing_if = "Option::is_none")]
        token_details: Option<serde_json::Value>,
    },

    TextChunk {
        session_id: String,
        turn_id: String,
        round_id: String,
        #[serde(default, skip_serializing_if = "Option::is_none")]
        attempt_id: Option<String>,
        #[serde(default, skip_serializing_if = "Option::is_none")]
        attempt_index: Option<u32>,
        text: String,
    },

    ThinkingChunk {
        session_id: String,
        turn_id: String,
        round_id: String,
        #[serde(default, skip_serializing_if = "Option::is_none")]
        attempt_id: Option<String>,
        #[serde(default, skip_serializing_if = "Option::is_none")]
        attempt_index: Option<u32>,
        content: String,
        #[serde(default, skip_serializing_if = "Option::is_none")]
        reasoning_kind: Option<ReasoningContentKind>,
        #[serde(default)]
        is_end: bool,
    },

    ToolEvent {
        session_id: String,
        turn_id: String,
        round_id: String,
        #[serde(default, skip_serializing_if = "Option::is_none")]
        attempt_id: Option<String>,
        #[serde(default, skip_serializing_if = "Option::is_none")]
        attempt_index: Option<u32>,
        tool_event: ToolEventData,
    },

    DeepReviewQueueStateChanged {
        session_id: String,
        turn_id: String,
        queue_state: DeepReviewQueueState,
    },

    SystemError {
        session_id: Option<String>,
        error: String,
        recoverable: bool,
    },

    /// User "steering" message injected into a running dialog turn at a model
    /// round boundary (Codex-style mid-turn injection). The frontend renders
    /// this as a synthetic record inside the current turn so the user can see
    /// the message they just steered with.
    UserSteeringInjected {
        session_id: String,
        turn_id: String,
        round_index: usize,
        steering_id: String,
        content: String,
        display_content: String,
    },

    /// A mutable session's bound model fell back because the previous model
    /// became unavailable (disabled or deleted).
    /// The frontend should refresh its model selector for the session and
    /// surface a non-blocking notice so the user knows what happened.
    #[serde(alias = "SessionModelAutoMigrated")]
    SessionModelFallbackApplied {
        session_id: String,
        /// The model id the session was using before the fallback.
        previous_model_id: String,
        /// The model id or selector the session is now bound to. This is what
        /// `SessionConfig.model_id` was rewritten to.
        #[serde(deserialize_with = "deserialize_session_model_fallback_id")]
        new_model_id: String,
        /// Why the fallback happened, e.g. `"model_disabled"` or
        /// `"model_deleted"`.
        reason: String,
    },

    /// A persisted reasoning preset became unavailable for the session's
    /// concrete model and was canonically cleared to Auto.
    SessionReasoningPresetAutoCleared {
        session_id: String,
        previous_preset_id: String,
        reason: String,
    },
}

/// Diagnostic evidence collected for an attempt that was superseded by an
/// automatic retry. Raw provider/transport text is intentionally preserved so
/// the desktop surface can expose it on demand without changing retry policy.
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ModelRoundAttemptDiagnostic {
    pub attempt_id: String,
    pub attempt_index: u32,
    pub category: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub raw_error: Option<String>,
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub tool_calls: Vec<ModelRoundAttemptToolDiagnostic>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ModelRoundAttemptToolDiagnostic {
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub tool_id: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub tool_name: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub raw_arguments: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub validation_error: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
pub struct ToolEventIdentity {
    pub tool_id: String,
    /// Provider-facing name. Deferred calls remain `CallDeferredTool`.
    pub tool_name: String,
    /// Runtime target when it differs from the provider-facing name.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub effective_tool_name: Option<String>,
}

impl ToolEventIdentity {
    pub fn direct(tool_id: impl Into<String>, tool_name: impl Into<String>) -> Self {
        Self {
            tool_id: tool_id.into(),
            tool_name: tool_name.into(),
            effective_tool_name: None,
        }
    }

    pub fn resolved(
        tool_id: impl Into<String>,
        tool_name: impl Into<String>,
        effective_tool_name: impl Into<String>,
    ) -> Self {
        let tool_name = tool_name.into();
        let effective_tool_name = effective_tool_name.into();
        Self {
            tool_id: tool_id.into(),
            effective_tool_name: (tool_name != effective_tool_name).then_some(effective_tool_name),
            tool_name,
        }
    }

    pub fn effective_name(&self) -> &str {
        self.effective_tool_name
            .as_deref()
            .unwrap_or(&self.tool_name)
    }
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(tag = "event_type")]
pub enum ToolEventData {
    EarlyDetected {
        #[serde(flatten)]
        identity: ToolEventIdentity,
    },
    ParamsPartial {
        #[serde(flatten)]
        identity: ToolEventIdentity,
        params: String,
    },
    Queued {
        #[serde(flatten)]
        identity: ToolEventIdentity,
        position: usize,
    },
    Waiting {
        #[serde(flatten)]
        identity: ToolEventIdentity,
        dependencies: Vec<String>,
    },
    Started {
        #[serde(flatten)]
        identity: ToolEventIdentity,
        /// Complete provider-facing input. Effective input is derived by consumers.
        params: serde_json::Value,
        #[serde(skip_serializing_if = "Option::is_none")]
        timeout_seconds: Option<u64>,
    },
    Progress {
        #[serde(flatten)]
        identity: ToolEventIdentity,
        message: String,
        percentage: f32,
    },
    Streaming {
        #[serde(flatten)]
        identity: ToolEventIdentity,
        chunks_received: usize,
    },
    StreamChunk {
        #[serde(flatten)]
        identity: ToolEventIdentity,
        data: serde_json::Value,
    },
    ConfirmationNeeded {
        #[serde(flatten)]
        identity: ToolEventIdentity,
        /// Complete provider-facing input. Effective input is derived by consumers.
        params: serde_json::Value,
        #[serde(skip_serializing_if = "Option::is_none")]
        timeout_at: Option<u64>,
    },
    Confirmed {
        #[serde(flatten)]
        identity: ToolEventIdentity,
    },
    Rejected {
        #[serde(flatten)]
        identity: ToolEventIdentity,
    },
    Completed {
        #[serde(flatten)]
        identity: ToolEventIdentity,
        /// Tool input snapshot so late projections (task timelines) can show
        /// what the tool operated on without replaying the whole turn.
        #[serde(default, skip_serializing_if = "Option::is_none")]
        params: Option<serde_json::Value>,
        result: serde_json::Value,
        #[serde(skip_serializing_if = "Option::is_none")]
        result_for_assistant: Option<String>,
        #[serde(default, skip_serializing_if = "Option::is_none")]
        image_attachments: Option<Vec<ToolImageAttachment>>,
        duration_ms: u64,
        #[serde(default, skip_serializing_if = "Option::is_none")]
        queue_wait_ms: Option<u64>,
        #[serde(default, skip_serializing_if = "Option::is_none")]
        preflight_ms: Option<u64>,
        #[serde(default, skip_serializing_if = "Option::is_none")]
        confirmation_wait_ms: Option<u64>,
        #[serde(default, skip_serializing_if = "Option::is_none")]
        execution_ms: Option<u64>,
    },
    Failed {
        #[serde(flatten)]
        identity: ToolEventIdentity,
        #[serde(default, skip_serializing_if = "Option::is_none")]
        params: Option<serde_json::Value>,
        error: String,
        #[serde(default, skip_serializing_if = "Option::is_none")]
        duration_ms: Option<u64>,
        #[serde(default, skip_serializing_if = "Option::is_none")]
        queue_wait_ms: Option<u64>,
        #[serde(default, skip_serializing_if = "Option::is_none")]
        preflight_ms: Option<u64>,
        #[serde(default, skip_serializing_if = "Option::is_none")]
        confirmation_wait_ms: Option<u64>,
        #[serde(default, skip_serializing_if = "Option::is_none")]
        execution_ms: Option<u64>,
    },
    Cancelled {
        #[serde(flatten)]
        identity: ToolEventIdentity,
        #[serde(default, skip_serializing_if = "Option::is_none")]
        params: Option<serde_json::Value>,
        reason: String,
        #[serde(default, skip_serializing_if = "Option::is_none")]
        duration_ms: Option<u64>,
        #[serde(default, skip_serializing_if = "Option::is_none")]
        queue_wait_ms: Option<u64>,
        #[serde(default, skip_serializing_if = "Option::is_none")]
        preflight_ms: Option<u64>,
        #[serde(default, skip_serializing_if = "Option::is_none")]
        confirmation_wait_ms: Option<u64>,
        #[serde(default, skip_serializing_if = "Option::is_none")]
        execution_ms: Option<u64>,
    },
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct AgenticEventEnvelope {
    pub id: String,
    pub event: AgenticEvent,
    pub priority: AgenticEventPriority,
    pub timestamp: SystemTime,
}

impl PartialEq for AgenticEventEnvelope {
    fn eq(&self, other: &Self) -> bool {
        self.id == other.id
    }
}

impl Eq for AgenticEventEnvelope {}

impl PartialOrd for AgenticEventEnvelope {
    fn partial_cmp(&self, other: &Self) -> Option<std::cmp::Ordering> {
        Some(self.cmp(other))
    }
}

impl Ord for AgenticEventEnvelope {
    fn cmp(&self, other: &Self) -> std::cmp::Ordering {
        match self.priority.cmp(&other.priority) {
            std::cmp::Ordering::Equal => self.timestamp.cmp(&other.timestamp),
            other => other,
        }
    }
}

impl AgenticEventEnvelope {
    pub fn new(event: AgenticEvent, priority: AgenticEventPriority) -> Self {
        Self {
            id: uuid::Uuid::new_v4().to_string(),
            event,
            priority,
            timestamp: SystemTime::now(),
        }
    }
}

impl AgenticEvent {
    /// Get the session ID of the event
    pub fn session_id(&self) -> Option<&str> {
        match self {
            Self::SessionCreated { session_id, .. }
            | Self::SessionStateChanged { session_id, .. }
            | Self::SessionHistoryChanged { session_id, .. }
            | Self::SessionDeleted { session_id }
            | Self::SessionTitleGenerated { session_id, .. }
            | Self::ImageAnalysisStarted { session_id, .. }
            | Self::ImageAnalysisCompleted { session_id, .. }
            | Self::DialogTurnStarted { session_id, .. }
            | Self::SubagentSessionLinked { session_id, .. }
            | Self::DialogTurnCompleted { session_id, .. }
            | Self::TokenUsageUpdated { session_id, .. }
            | Self::ContextCompressionStarted { session_id, .. }
            | Self::ContextCompressionCompleted { session_id, .. }
            | Self::ContextCompressionFailed { session_id, .. }
            | Self::ThreadGoalUpdated { session_id, .. }
            | Self::DialogTurnCancelled { session_id, .. }
            | Self::DialogTurnInterrupted { session_id, .. }
            | Self::DialogTurnRecovered { session_id, .. }
            | Self::DialogTurnFailed { session_id, .. }
            | Self::ModelRoundStarted { session_id, .. }
            | Self::ModelRoundAttemptSuperseded { session_id, .. }
            | Self::TextChunk { session_id, .. }
            | Self::ThinkingChunk { session_id, .. }
            | Self::ModelRoundCompleted { session_id, .. }
            | Self::ToolEvent { session_id, .. }
            | Self::UserSteeringInjected { session_id, .. }
            | Self::DeepReviewQueueStateChanged { session_id, .. }
            | Self::SessionModelFallbackApplied { session_id, .. }
            | Self::SessionReasoningPresetAutoCleared { session_id, .. } => Some(session_id),
            Self::SystemError { session_id, .. } => session_id.as_deref(),
        }
    }

    /// Get the dialog Turn identity carried by a Turn-scoped event.
    pub fn turn_id(&self) -> Option<&str> {
        match self {
            Self::DialogTurnStarted { turn_id, .. }
            | Self::DialogTurnCompleted { turn_id, .. }
            | Self::DialogTurnCancelled { turn_id, .. }
            | Self::DialogTurnInterrupted { turn_id, .. }
            | Self::DialogTurnRecovered { turn_id, .. }
            | Self::DialogTurnFailed { turn_id, .. }
            | Self::TokenUsageUpdated { turn_id, .. }
            | Self::ContextCompressionStarted { turn_id, .. }
            | Self::ContextCompressionCompleted { turn_id, .. }
            | Self::ContextCompressionFailed { turn_id, .. }
            | Self::ModelRoundStarted { turn_id, .. }
            | Self::ModelRoundAttemptSuperseded { turn_id, .. }
            | Self::ModelRoundCompleted { turn_id, .. }
            | Self::TextChunk { turn_id, .. }
            | Self::ThinkingChunk { turn_id, .. }
            | Self::ToolEvent { turn_id, .. }
            | Self::DeepReviewQueueStateChanged { turn_id, .. }
            | Self::UserSteeringInjected { turn_id, .. } => Some(turn_id),
            _ => None,
        }
    }

    /// Get the default priority
    pub fn default_priority(&self) -> AgenticEventPriority {
        match self {
            Self::SystemError { .. }
            | Self::DialogTurnFailed { .. }
            | Self::DialogTurnCancelled { .. } => AgenticEventPriority::Critical,

            Self::DialogTurnInterrupted { .. } | Self::DialogTurnRecovered { .. } => {
                AgenticEventPriority::Critical
            }

            Self::SessionStateChanged { .. }
            | Self::SessionHistoryChanged { .. }
            | Self::SessionTitleGenerated { .. }
            | Self::SessionModelFallbackApplied { .. }
            | Self::SessionReasoningPresetAutoCleared { .. }
            | Self::SubagentSessionLinked { .. }
            | Self::DeepReviewQueueStateChanged { .. }
            | Self::ContextCompressionFailed { .. } => AgenticEventPriority::High,

            Self::ImageAnalysisStarted { .. }
            | Self::ImageAnalysisCompleted { .. }
            | Self::TextChunk { .. }
            | Self::ThinkingChunk { .. }
            | Self::ModelRoundStarted { .. }
            | Self::ModelRoundAttemptSuperseded { .. }
            | Self::ModelRoundCompleted { .. }
            | Self::TokenUsageUpdated { .. }
            | Self::DialogTurnCompleted { .. }
            | Self::ContextCompressionStarted { .. }
            | Self::ThreadGoalUpdated { .. }
            | Self::UserSteeringInjected { .. }
            | Self::ContextCompressionCompleted { .. } => AgenticEventPriority::Normal,

            Self::ToolEvent { tool_event, .. } => tool_event.default_priority(),

            _ => AgenticEventPriority::Low,
        }
    }
}

impl ToolEventData {
    pub fn identity(&self) -> &ToolEventIdentity {
        match self {
            Self::EarlyDetected { identity }
            | Self::ParamsPartial { identity, .. }
            | Self::Queued { identity, .. }
            | Self::Waiting { identity, .. }
            | Self::Started { identity, .. }
            | Self::Progress { identity, .. }
            | Self::Streaming { identity, .. }
            | Self::StreamChunk { identity, .. }
            | Self::ConfirmationNeeded { identity, .. }
            | Self::Confirmed { identity }
            | Self::Rejected { identity }
            | Self::Completed { identity, .. }
            | Self::Failed { identity, .. }
            | Self::Cancelled { identity, .. } => identity,
        }
    }

    pub fn tool_id(&self) -> &str {
        &self.identity().tool_id
    }

    pub fn wire_tool_name(&self) -> &str {
        &self.identity().tool_name
    }

    pub fn effective_tool_name(&self) -> &str {
        self.identity().effective_name()
    }

    /// Get the default priority for a specific tool event variant.
    pub fn default_priority(&self) -> AgenticEventPriority {
        match self {
            Self::Cancelled { .. } => AgenticEventPriority::Critical,

            Self::Started { .. }
            | Self::Completed { .. }
            | Self::Failed { .. }
            | Self::ConfirmationNeeded { .. } => AgenticEventPriority::High,

            Self::EarlyDetected { .. }
            | Self::ParamsPartial { .. }
            | Self::Queued { .. }
            | Self::Waiting { .. }
            | Self::Progress { .. }
            | Self::Streaming { .. }
            | Self::StreamChunk { .. }
            | Self::Confirmed { .. }
            | Self::Rejected { .. } => AgenticEventPriority::Normal,
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    #[test]
    fn model_round_completed_serializes_optional_timing_fields() {
        let event = AgenticEvent::ModelRoundCompleted {
            session_id: "session-1".to_string(),
            turn_id: "turn-1".to_string(),
            round_id: "round-1".to_string(),
            has_tool_calls: false,
            duration_ms: Some(123),
            provider_id: Some("provider".to_string()),
            model_config_id: "model-config".to_string(),
            effective_model_name: "provider-model".to_string(),
            first_chunk_ms: Some(10),
            first_visible_output_ms: Some(12),
            stream_duration_ms: Some(100),
            attempt_count: Some(1),
            failure_category: None,
            token_details: Some(serde_json::json!({ "reasoningTokens": 7 })),
        };

        let json = serde_json::to_value(&event).expect("serialize event");

        assert_eq!(json["duration_ms"], 123);
        assert_eq!(json["model_config_id"], "model-config");
        assert_eq!(json["effective_model_name"], "provider-model");
        assert_eq!(json["first_chunk_ms"], 10);
        assert_eq!(json["token_details"]["reasoningTokens"], 7);
    }

    #[test]
    fn model_round_completed_deserializes_required_identity_without_timing_fields() {
        let json = serde_json::json!({
            "type": "ModelRoundCompleted",
            "session_id": "session-1",
            "turn_id": "turn-1",
            "round_id": "round-1",
            "has_tool_calls": false,
            "model_config_id": "model-config",
            "effective_model_name": "provider-model"
        });

        let event: AgenticEvent = serde_json::from_value(json).expect("event");

        match event {
            AgenticEvent::ModelRoundCompleted { duration_ms, .. } => {
                assert_eq!(duration_ms, None);
            }
            _ => panic!("unexpected event"),
        }
    }

    #[test]
    fn legacy_context_compression_completion_defaults_to_applied() {
        let event: AgenticEvent = serde_json::from_value(json!({
            "type": "ContextCompressionCompleted",
            "session_id": "session-1",
            "turn_id": "turn-1",
            "compression_id": "compression-1",
            "compression_count": 1,
            "tokens_before": 100,
            "tokens_after": 20,
            "compression_ratio": 0.2,
            "duration_ms": 5,
            "has_summary": true,
            "summary_source": "model"
        }))
        .expect("legacy completion event");

        assert!(matches!(
            event,
            AgenticEvent::ContextCompressionCompleted { applied: true, .. }
        ));
    }

    #[test]
    fn legacy_model_auto_migration_event_reads_as_canonical_fallback_event() {
        let event: AgenticEvent = serde_json::from_value(json!({
            "type": "SessionModelAutoMigrated",
            "session_id": "session-1",
            "previous_model_id": "removed-model",
            "new_model_id": "auto",
            "reason": "model_deleted"
        }))
        .expect("legacy model migration event");

        assert!(matches!(
            event,
            AgenticEvent::SessionModelFallbackApplied {
                ref session_id,
                ref previous_model_id,
                ref new_model_id,
                ..
            } if session_id == "session-1"
                && previous_model_id == "removed-model"
                && new_model_id == "primary"
        ));
        assert_eq!(
            serde_json::to_value(&event).expect("canonical event")["type"],
            "SessionModelFallbackApplied"
        );
    }

    #[test]
    fn token_usage_updated_serializes_optional_cache_and_detail_fields() {
        let event = AgenticEvent::TokenUsageUpdated {
            session_id: "session-1".to_string(),
            turn_id: "turn-1".to_string(),
            model_config_id: "model-config".to_string(),
            effective_model_name: "provider-model".to_string(),
            input_tokens: 10,
            output_tokens: Some(5),
            total_tokens: 15,
            max_context_tokens: Some(100),
            is_subagent: false,
            cached_tokens: Some(3),
            token_details: Some(serde_json::json!({ "cachedSource": "provider" })),
        };

        let json = serde_json::to_value(&event).expect("serialize event");

        assert_eq!(json["cached_tokens"], 3);
        assert_eq!(json["token_details"]["cachedSource"], "provider");
    }

    #[test]
    fn completed_tool_reports_total_and_execution_duration() {
        let event = ToolEventData::Completed {
            params: None,
            identity: ToolEventIdentity::direct("tool-1", "write_file"),
            result: serde_json::json!({ "ok": true }),
            result_for_assistant: None,
            image_attachments: None,
            duration_ms: 120,
            queue_wait_ms: Some(10),
            preflight_ms: Some(20),
            confirmation_wait_ms: Some(0),
            execution_ms: Some(90),
        };

        let json = serde_json::to_value(&event).expect("serialize tool event");

        assert_eq!(json["duration_ms"], 120);
        assert_eq!(json["execution_ms"], 90);
    }

    #[test]
    fn deferred_started_event_preserves_wire_invocation_and_effective_name() {
        let params = serde_json::json!({
            "tool_name": "CreatePlan",
            "args": { "name": "Plan" }
        });
        let event = ToolEventData::Started {
            identity: ToolEventIdentity::resolved("tool-1", "CallDeferredTool", "CreatePlan"),
            params: params.clone(),
            timeout_seconds: None,
        };

        let json = serde_json::to_value(&event).expect("serialize deferred event");
        assert_eq!(json["tool_id"], "tool-1");
        assert_eq!(json["tool_name"], "CallDeferredTool");
        assert_eq!(json["effective_tool_name"], "CreatePlan");
        assert_eq!(json["params"], params);

        let decoded: ToolEventData =
            serde_json::from_value(json).expect("deserialize deferred event");
        assert_eq!(decoded.wire_tool_name(), "CallDeferredTool");
        assert_eq!(decoded.effective_tool_name(), "CreatePlan");
    }

    #[test]
    fn completed_tool_serializes_image_attachments() {
        let event = ToolEventData::Completed {
            params: None,
            identity: ToolEventIdentity::direct("tool-image-1", "view_image"),
            result: serde_json::json!({ "path": "preview.png" }),
            result_for_assistant: Some("Image attached".to_string()),
            image_attachments: Some(vec![openbitfun_core_types::ToolImageAttachment {
                mime_type: "image/png".to_string(),
                data_base64: "AAAA".to_string(),
            }]),
            duration_ms: 12,
            queue_wait_ms: None,
            preflight_ms: None,
            confirmation_wait_ms: None,
            execution_ms: Some(12),
        };

        let json = serde_json::to_value(&event).expect("serialize tool event");

        assert_eq!(json["image_attachments"][0]["mime_type"], "image/png");
        assert_eq!(json["image_attachments"][0]["data_base64"], "AAAA");
    }

    #[test]
    fn failed_tool_reports_best_effort_total_duration() {
        let event = ToolEventData::Failed {
            params: None,
            identity: ToolEventIdentity::direct("tool-1", "write_file"),
            error: "failed".to_string(),
            duration_ms: Some(120),
            queue_wait_ms: Some(10),
            preflight_ms: Some(20),
            confirmation_wait_ms: None,
            execution_ms: Some(90),
        };

        let json = serde_json::to_value(&event).expect("serialize tool event");

        assert_eq!(json["duration_ms"], 120);
        assert_eq!(json["execution_ms"], 90);
    }

    #[test]
    fn cancelled_tool_reports_best_effort_total_duration() {
        let event = ToolEventData::Cancelled {
            params: None,
            identity: ToolEventIdentity::direct("tool-1", "write_file"),
            reason: "cancelled".to_string(),
            duration_ms: Some(120),
            queue_wait_ms: Some(10),
            preflight_ms: Some(20),
            confirmation_wait_ms: None,
            execution_ms: Some(90),
        };

        let json = serde_json::to_value(&event).expect("serialize tool event");

        assert_eq!(json["duration_ms"], 120);
        assert_eq!(json["execution_ms"], 90);
    }

    #[test]
    fn deep_review_queue_state_event_serializes_stable_contract() {
        let event = AgenticEvent::DeepReviewQueueStateChanged {
            session_id: "review-session".to_string(),
            turn_id: "turn-1".to_string(),
            queue_state: DeepReviewQueueState {
                tool_id: "task-1".to_string(),
                subagent_type: "ReviewSecurity".to_string(),
                status: DeepReviewQueueStatus::QueuedForCapacity,
                reason: Some(DeepReviewQueueReason::ProviderConcurrencyLimit),
                queued_reviewer_count: 2,
                active_reviewer_count: Some(1),
                effective_parallel_instances: Some(2),
                optional_reviewer_count: Some(1),
                queue_elapsed_ms: Some(1200),
                run_elapsed_ms: None,
                max_queue_wait_seconds: Some(60),
                session_concurrency_high: true,
            },
        };

        assert_eq!(event.session_id(), Some("review-session"));
        assert_eq!(event.default_priority(), AgenticEventPriority::High);

        let serialized = serde_json::to_value(event).expect("serialize event");
        assert_eq!(serialized["type"], "DeepReviewQueueStateChanged");
        assert_eq!(serialized["queue_state"]["status"], "queued_for_capacity");
        assert_eq!(
            serialized["queue_state"]["reason"],
            json!("provider_concurrency_limit")
        );
        assert_eq!(serialized["queue_state"]["queue_elapsed_ms"], json!(1200));
        assert_eq!(
            serialized["queue_state"]["effective_parallel_instances"],
            json!(2)
        );
        assert_eq!(
            serialized["queue_state"]["run_elapsed_ms"],
            serde_json::Value::Null
        );
    }

    #[test]
    fn subagent_session_linked_serializes_stable_contract() {
        let event = AgenticEvent::SubagentSessionLinked {
            session_id: "child-session".to_string(),
            subagent_dialog_turn_id: "child-turn-1".to_string(),
            parent_session_id: "parent-session".to_string(),
            parent_dialog_turn_id: "turn-1".to_string(),
            parent_tool_call_id: "tool-1".to_string(),
            agent_type: Some("GeneralPurpose".to_string()),
            model_id: Some("fast".to_string()),
            focused_review_display_label: Some("Authentication boundary".to_string()),
        };

        assert_eq!(event.session_id(), Some("child-session"));
        assert_eq!(event.default_priority(), AgenticEventPriority::High);

        let serialized = serde_json::to_value(event).expect("serialize event");
        assert_eq!(serialized["type"], "SubagentSessionLinked");
        assert_eq!(serialized["session_id"], "child-session");
        assert_eq!(serialized["subagent_dialog_turn_id"], "child-turn-1");
        assert_eq!(serialized["parent_session_id"], "parent-session");
        assert_eq!(serialized["parent_dialog_turn_id"], "turn-1");
        assert_eq!(serialized["parent_tool_call_id"], "tool-1");
        assert_eq!(serialized["agent_type"], "GeneralPurpose");
        assert_eq!(serialized["model_id"], "fast");
        assert_eq!(
            serialized["focused_review_display_label"],
            "Authentication boundary"
        );
    }

    #[test]
    fn reasoning_preset_auto_clear_is_a_high_priority_session_event() {
        let event = AgenticEvent::SessionReasoningPresetAutoCleared {
            session_id: "session-1".to_string(),
            previous_preset_id: "high".to_string(),
            reason: "reasoning_catalog_updated".to_string(),
        };

        assert_eq!(event.session_id(), Some("session-1"));
        assert_eq!(event.default_priority(), AgenticEventPriority::High);
        let serialized = serde_json::to_value(event).expect("serialize event");
        assert_eq!(serialized["type"], "SessionReasoningPresetAutoCleared");
        assert_eq!(serialized["previous_preset_id"], "high");
    }
}
