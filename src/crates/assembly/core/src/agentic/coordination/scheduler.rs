//! Dialog scheduler
//!
//! Message queue manager that automatically dispatches queued messages
//! when the target session becomes idle.
//!
//! Acts as the primary entry point for all user-facing message submissions,
//! wrapping ConversationCoordinator with:
//! - Per-session priority queue (max 20 messages)
//! - Higher-priority messages dispatched before lower-priority ones
//! - FIFO ordering within the same priority level
//! - Queue cleared on unrecoverable failure

use super::coordinator::{
    session_storage_workspace_locator, ConversationCoordinator, DialogTriggerSource,
    DialogTurnStopDisposition, HiddenSubagentExecutionRequest, SubagentResult,
};
use super::turn_outcome::TurnOutcome;
use super::turn_settlement::TurnSettlementRegistration;
use crate::agentic::core::{InternalReminderKind, Message, SessionState};
use crate::agentic::events::AgenticEvent;
use crate::agentic::goal_mode::{
    goal_continuation_submit_retry_delay_ms, goal_internal_context_message,
    goal_objective_updated_message,
};
use crate::agentic::image_analysis::ImageContextData;
use crate::agentic::init_agents_md::build_init_agents_md_user_input;
use crate::agentic::keyed_lock::{KeyedAsyncLock, KeyedAsyncLockGuard};
use crate::agentic::round_preempt::{DialogRoundInjectionSource, SessionRoundInjectionBuffer};
use crate::agentic::session::session_store_port::CoreSessionStorePort;
use crate::agentic::session::SessionManager;
use crate::util::errors::{OpenBitFunError, OpenBitFunResult};
use log::{debug, info, warn};
use openbitfun_runtime_ports::{ThreadGoal, MAX_THREAD_GOAL_AUTO_CONTINUATIONS};
use std::collections::HashSet;
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicBool, Ordering as AtomicOrdering};
use std::sync::Arc;
use std::sync::OnceLock;
use std::time::{Duration, Instant, SystemTime};
use tokio::sync::mpsc;
use tokio::sync::oneshot;
use tokio::sync::Notify;
use tokio_util::sync::CancellationToken;
use uuid::Uuid;

use openbitfun_agent_runtime::scheduler::{
    build_thread_goal_objective_updated_delivery_plan, build_thread_goal_resumed_delivery_plan,
    resolve_agent_session_reply_action, resolve_background_delivery_action,
    resolve_background_delivery_injection, resolve_dialog_start_route,
    resolve_dialog_steering_action, resolve_turn_outcome_lifecycle_plan,
    target_background_delivery_injection_to_turn, ActiveDialogTurn, ActiveDialogTurnStore,
    ActiveDialogTurnTakeResult, AgentSessionReplyAction, AgentSessionReplyPlan,
    BackgroundDeliveryAction, BackgroundDeliveryFacts, BackgroundInjectionKind,
    DialogReplySuppressionSet, DialogStartRoute, DialogStartRouteFacts, DialogSteeringAction,
    DialogTurnQueue, GoalContinuationAfterTurnAction, SessionAbortFlags,
    ThreadGoalDeliveryReminder, ThreadGoalDeliveryReminderKind, TurnOutcomeQueueAction,
    TurnOutcomeStatus,
};
use openbitfun_runtime_ports::{
    resolve_dialog_submit_queue_action, AgentBackgroundResultRequest, AgentDialogPrependedReminder,
    AgentDialogSteerRequest, AgentDialogTurnExecution, AgentDialogTurnPort, AgentDialogTurnRequest,
    AgentInputAttachment, AgentLifecycleDeliveryPort, AgentSessionLineageInspection,
    AgentThreadGoalDeliveryKind, AgentThreadGoalDeliveryRequest, AgentTurnCancellationPort,
    AgentTurnCancellationRequest, AgentTurnCancellationResult, DialogSessionStateFact,
    DialogSubmitQueueAction, DialogSubmitQueueFacts, PortError, PortErrorKind, PortResult,
    RoundInjection, RoundInjectionKind, SessionStoragePathRequest, SessionStorePort,
    SessionTranscriptRequest,
};
pub use openbitfun_runtime_ports::{
    AgentSessionReplyRoute, DialogQueuePriority, DialogSteerOutcome, DialogSubmissionPolicy,
    DialogSubmitOutcome,
};

/// A message waiting to be dispatched to the coordinator
#[derive(Debug, Clone)]
pub struct QueuedTurn {
    pub user_input: String,
    pub original_user_input: Option<String>,
    pub prepended_messages: Vec<Message>,
    pub turn_id: Option<String>,
    pub agent_type: String,
    /// Execution root projection; storage selection prefers `workspace_id`.
    pub workspace_path: Option<String>,
    /// Owning workspace ID supplied by ID-aware callers to locate an unloaded session.
    pub workspace_id: Option<String>,
    pub remote_connection_id: Option<String>,
    pub remote_ssh_host: Option<String>,
    pub policy: DialogSubmissionPolicy,
    pub reply_route: Option<AgentSessionReplyRoute>,
    pub user_message_metadata: Option<serde_json::Value>,
    pub image_contexts: Option<Vec<ImageContextData>>,
    #[allow(dead_code)]
    pub enqueued_at: SystemTime,
    _settlement_registration: Option<TurnSettlementRegistration>,
    execution: QueuedTurnExecution,
}

impl QueuedTurn {
    fn accept_settlement(&self) {
        if let Some(registration) = self._settlement_registration.as_ref() {
            registration.accept();
        }
    }
}

#[derive(Debug, Clone, Default)]
pub(crate) enum QueuedTurnExecution {
    #[default]
    Standard,
    FreshExternalSubagent(ExternalSubagentDelegationQueuedExecution),
    HiddenSubagent(HiddenSubagentQueuedExecution),
}

#[derive(Debug, Clone)]
pub(crate) struct ExternalSubagentDelegationQueuedExecution {
    ecosystem_id: String,
    logical_id: String,
}

fn remove_queued_turn_by_id(
    queues: &DialogTurnQueue<QueuedTurn>,
    session_id: &str,
    turn_id: &str,
) -> Option<QueuedTurn> {
    queues.remove_first_matching(session_id, |turn| turn.turn_id.as_deref() == Some(turn_id))
}

#[derive(Debug)]
enum SchedulerSubmitError {
    Core(OpenBitFunError),
    Port(PortError),
    Message(String),
}

impl SchedulerSubmitError {
    fn into_port_error(self) -> PortError {
        match self {
            Self::Core(OpenBitFunError::Validation(message)) => {
                PortError::new(PortErrorKind::InvalidRequest, message)
            }
            Self::Core(OpenBitFunError::NotFound(message)) => {
                PortError::new(PortErrorKind::NotFound, message)
            }
            Self::Core(OpenBitFunError::Cancelled(message)) => {
                PortError::new(PortErrorKind::Cancelled, message)
            }
            Self::Core(OpenBitFunError::Timeout(message)) => {
                PortError::new(PortErrorKind::Timeout, message)
            }
            Self::Core(OpenBitFunError::SessionInUse { session_id }) => PortError::new(
                PortErrorKind::SessionInUse,
                format!("Session is already open for writing: {session_id}"),
            ),
            Self::Core(OpenBitFunError::OutcomeUnknown(message)) => {
                PortError::new(PortErrorKind::OutcomeUnknown, message)
            }
            Self::Core(OpenBitFunError::NotImplemented(message)) => {
                PortError::new(PortErrorKind::NotAvailable, message)
            }
            Self::Core(error) => PortError::new(PortErrorKind::Backend, error.to_string()),
            Self::Port(error) => error,
            Self::Message(message) => PortError::new(PortErrorKind::Backend, message),
        }
    }
}

impl std::fmt::Display for SchedulerSubmitError {
    fn fmt(&self, formatter: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        match self {
            Self::Core(error) => error.fmt(formatter),
            Self::Port(error) => error.fmt(formatter),
            Self::Message(message) => formatter.write_str(message),
        }
    }
}

impl From<OpenBitFunError> for SchedulerSubmitError {
    fn from(error: OpenBitFunError) -> Self {
        Self::Core(error)
    }
}

impl From<String> for SchedulerSubmitError {
    fn from(message: String) -> Self {
        Self::Message(message)
    }
}

impl From<PortError> for SchedulerSubmitError {
    fn from(error: PortError) -> Self {
        Self::Port(error)
    }
}

#[derive(Debug, Clone)]
pub(crate) struct HiddenSubagentQueuedExecution {
    request: HiddenSubagentExecutionRequest,
    timeout_seconds: Option<u64>,
    result_tx: SharedSubagentResultSender,
    cancellation: HiddenSubagentQueueCancellation,
}

#[derive(Debug, Clone, Default)]
pub(crate) struct SharedSubagentResultSender {
    inner: Arc<std::sync::Mutex<Option<oneshot::Sender<OpenBitFunResult<SubagentResult>>>>>,
}

impl SharedSubagentResultSender {
    fn new(sender: oneshot::Sender<OpenBitFunResult<SubagentResult>>) -> Self {
        Self {
            inner: Arc::new(std::sync::Mutex::new(Some(sender))),
        }
    }

    fn send(&self, result: OpenBitFunResult<SubagentResult>) {
        let Some(sender) = self.inner.lock().ok().and_then(|mut guard| guard.take()) else {
            return;
        };
        let _ = sender.send(result);
    }
}

#[derive(Debug, Clone)]
pub(crate) struct HiddenSubagentQueueCancellation {
    cancelled: Arc<AtomicBool>,
    token: CancellationToken,
}

impl Default for HiddenSubagentQueueCancellation {
    fn default() -> Self {
        Self {
            cancelled: Arc::new(AtomicBool::new(false)),
            token: CancellationToken::new(),
        }
    }
}

impl HiddenSubagentQueueCancellation {
    fn cancel(&self) {
        self.cancelled.store(true, AtomicOrdering::SeqCst);
        self.token.cancel();
    }

    fn is_cancelled(&self) -> bool {
        self.cancelled.load(AtomicOrdering::SeqCst)
    }

    fn child_token(&self) -> CancellationToken {
        self.token.child_token()
    }
}

#[derive(Debug)]
pub(crate) struct HiddenSubagentSubmitResult {
    pub receiver: oneshot::Receiver<OpenBitFunResult<SubagentResult>>,
    pub cancel_handle: HiddenSubagentQueueCancelHandle,
}

#[derive(Debug, Clone)]
pub(crate) struct HiddenSubagentQueueCancelHandle {
    session_id: String,
    turn_id: String,
    cancellation: HiddenSubagentQueueCancellation,
    result_tx: SharedSubagentResultSender,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum ActiveInternalTurn {
    HiddenSubagent,
}

#[derive(Clone)]
struct BackgroundResultDelivery {
    session_id: String,
    agent_type: String,
    workspace_path: Option<String>,
    remote_connection_id: Option<String>,
    remote_ssh_host: Option<String>,
    content: String,
    display_content: Option<String>,
    user_message_metadata: Option<serde_json::Value>,
}

struct SchedulerRoundInjectionSource {
    buffer: Arc<SessionRoundInjectionBuffer>,
}

impl DialogRoundInjectionSource for SchedulerRoundInjectionSource {
    fn has_pending(&self, session_id: &str, turn_id: &str) -> bool {
        self.buffer.has_pending_for_turn(session_id, turn_id)
    }

    fn pending_tool_preemption(
        &self,
        session_id: &str,
        turn_id: &str,
    ) -> openbitfun_runtime_ports::RoundInjectionToolPreemption {
        self.buffer
            .pending_tool_preemption_for_turn(session_id, turn_id)
    }

    fn take_pending(&self, session_id: &str, turn_id: &str) -> Vec<RoundInjection> {
        self.buffer.drain_for_turn(session_id, turn_id)
    }

    fn acknowledge_consumed(
        &self,
        _session_id: &str,
        _turn_id: &str,
        _injection_id: &str,
        _kind: RoundInjectionKind,
    ) {
    }
}

/// Message queue manager for dialog turns.
///
/// All user-facing callers (frontend Tauri commands, remote server, bot router)
/// should submit messages through this scheduler instead of calling
/// ConversationCoordinator directly.
pub struct DialogScheduler {
    coordinator: Arc<ConversationCoordinator>,
    session_manager: Arc<SessionManager>,
    /// Per-session priority message queues.
    queues: Arc<DialogTurnQueue<QueuedTurn>>,
    /// Serializes submit, dispatch, and targeted cancellation for one session.
    /// This closes the dequeue-to-start gap where cancellation could otherwise
    /// miss both the queue and the coordinator's active execution.
    session_operation_locks: KeyedAsyncLock,
    /// Currently active turn metadata keyed by target session ID
    active_turns: Arc<ActiveDialogTurnStore>,
    active_internal_turns: Arc<dashmap::DashMap<String, ActiveInternalTurn>>,
    /// Turns whose cancelled auto-reply should be suppressed because the source
    /// agent explicitly cancelled its own outstanding SessionMessage request.
    suppressed_cancelled_replies: Arc<DialogReplySuppressionSet>,
    /// Exact outcomes retired by destructive session maintenance. The outcome
    /// channel may receive them only after the maintenance permit releases its
    /// per-session operation lock; tombstoning prevents them from mutating a
    /// newly created session that reuses the same explicit ID.
    retired_maintenance_outcomes: Arc<DialogReplySuppressionSet>,
    /// Set when the user cancels an in-flight turn; aborts goal-continuation submit retries.
    goal_continuation_abort: Arc<SessionAbortFlags>,
    /// Wakes recovery admission after the previous execution generation has
    /// retired from the authoritative active-turn table.
    active_turn_retired: Arc<Notify>,
    /// Cloneable sender given to ConversationCoordinator for turn outcome notifications
    outcome_tx: mpsc::UnboundedSender<(String, TurnOutcome)>,
    /// Per-session FIFO buffer of round injections drained at round boundaries
    /// by the engine and injected into the running dialog turn.
    round_injection_buffer: Arc<SessionRoundInjectionBuffer>,
    round_injection_source: Arc<SchedulerRoundInjectionSource>,
    /// Child sessions already cancelled for a parent maintenance attempt but
    /// not yet observed as drained. Retain them across retryable timeouts even
    /// after their one-shot cancellation controls have been claimed.
    maintenance_background_sessions: Arc<dashmap::DashMap<String, HashSet<String>>>,
}

/// Holds the scheduler's exclusive session-operation boundary while a caller
/// performs maintenance that must not overlap turn dispatch.
pub(crate) struct SessionMaintenancePermit {
    _operation_guard: KeyedAsyncLockGuard,
    retired_turn_ids: Vec<String>,
}

impl SessionMaintenancePermit {
    pub(crate) fn retired_turn_ids(&self) -> &[String] {
        &self.retired_turn_ids
    }
}

fn take_active_turn_for_outcome(
    active_turns: &ActiveDialogTurnStore,
    retired_maintenance_outcomes: &DialogReplySuppressionSet,
    session_id: &str,
    turn_id: &str,
) -> Option<ActiveDialogTurnTakeResult> {
    if retired_maintenance_outcomes.take(session_id, turn_id) {
        None
    } else {
        Some(active_turns.take_for_outcome(session_id, turn_id))
    }
}

struct RecoveryActiveTurnAdmission {
    active_turns: Arc<ActiveDialogTurnStore>,
    active_turn_retired: Arc<Notify>,
    session_id: String,
    turn_id: String,
    armed: bool,
}

impl RecoveryActiveTurnAdmission {
    fn disarm(&mut self) {
        self.armed = false;
    }
}

impl Drop for RecoveryActiveTurnAdmission {
    fn drop(&mut self) {
        if !self.armed {
            return;
        }
        let _ = self
            .active_turns
            .take_for_outcome(&self.session_id, &self.turn_id);
        self.active_turn_retired.notify_waiters();
    }
}

fn queued_submission_outcome(
    session_id: String,
    resolved_turn_id: String,
    started_turn_id: Option<String>,
) -> DialogSubmitOutcome {
    match started_turn_id {
        Some(turn_id) if turn_id == resolved_turn_id => DialogSubmitOutcome::Started {
            session_id,
            turn_id,
        },
        _ => DialogSubmitOutcome::Queued {
            session_id,
            turn_id: resolved_turn_id,
        },
    }
}

impl DialogScheduler {
    /// Create a new DialogScheduler and start its background outcome handler.
    ///
    /// The returned `Arc<DialogScheduler>` should be stored globally.
    /// Call `coordinator.set_scheduler_notifier(scheduler.outcome_sender())`
    /// immediately after to wire up the notification channel.
    pub fn new(
        coordinator: Arc<ConversationCoordinator>,
        session_manager: Arc<SessionManager>,
    ) -> Arc<Self> {
        // Turn outcomes are lifecycle control messages, not bulk data. They
        // must never be dropped or back-pressured behind the interrupt RPC:
        // retirement of the active-turn owner depends on their delivery.
        let (outcome_tx, outcome_rx) = mpsc::unbounded_channel();
        let round_injection_buffer = Arc::new(SessionRoundInjectionBuffer::default());
        let round_injection_source = Arc::new(SchedulerRoundInjectionSource {
            buffer: round_injection_buffer.clone(),
        });

        let scheduler = Arc::new(Self {
            coordinator,
            session_manager,
            queues: Arc::new(DialogTurnQueue::default()),
            session_operation_locks: KeyedAsyncLock::default(),
            active_turns: Arc::new(ActiveDialogTurnStore::default()),
            active_internal_turns: Arc::new(dashmap::DashMap::new()),
            suppressed_cancelled_replies: Arc::new(DialogReplySuppressionSet::default()),
            retired_maintenance_outcomes: Arc::new(DialogReplySuppressionSet::default()),
            goal_continuation_abort: Arc::new(SessionAbortFlags::default()),
            active_turn_retired: Arc::new(Notify::new()),
            outcome_tx,
            round_injection_buffer,
            round_injection_source,
            maintenance_background_sessions: Arc::new(dashmap::DashMap::new()),
        });

        let scheduler_for_handler = Arc::clone(&scheduler);
        tokio::spawn(async move {
            scheduler_for_handler.run_outcome_handler(outcome_rx).await;
        });

        scheduler
    }

    /// Returns a sender to give to ConversationCoordinator for turn outcome notifications.
    pub fn outcome_sender(&self) -> mpsc::UnboundedSender<(String, TurnOutcome)> {
        self.outcome_tx.clone()
    }

    async fn lock_session_operation(&self, session_id: &str) -> KeyedAsyncLockGuard {
        self.session_operation_locks.lock(session_id).await
    }

    /// Pass to [`ConversationCoordinator::set_round_injection_source`](super::coordinator::ConversationCoordinator::set_round_injection_source).
    pub fn round_injection_monitor(&self) -> Arc<dyn DialogRoundInjectionSource> {
        self.round_injection_source.clone()
    }

    /// Submit a user "steering" message into the currently running dialog turn.
    ///
    /// Unlike [`Self::submit`], this never starts or queues a new turn — it only buffers
    /// the message so the [`ExecutionEngine`](super::super::execution::ExecutionEngine)
    /// can inject it at the next model-round boundary. Errors:
    ///
    /// - Session is not currently `Processing` the requested `turn_id` (the targeted turn
    ///   already finished or never existed). Callers must preserve the user's input so it
    ///   can be submitted explicitly after authoritative state is observed.
    async fn buffer_steering(
        &self,
        session_id: String,
        turn_id: String,
        content: String,
        display_content: Option<String>,
        mut attachments: Vec<AgentInputAttachment>,
        metadata: serde_json::Map<String, serde_json::Value>,
    ) -> Result<DialogSteerOutcome, String> {
        if content.trim().is_empty() && attachments.is_empty() {
            return Err("Steering content cannot be empty".to_string());
        }
        // Reject a malformed attachment here rather than at the round boundary:
        // the caller is still holding the user's message and can surface the
        // failure, whereas the injection consumer would have to drop it.
        let mut images = agent_dialog_turn_image_contexts(&attachments)
            .map_err(|error| error.to_string())?
            .unwrap_or_default();
        let _operation_guard = self.lock_session_operation(&session_id).await;
        let active_turn_id = match self
            .session_manager
            .get_session(&session_id)
            .map(|s| s.state.clone())
        {
            Some(SessionState::Processing {
                current_turn_id, ..
            }) if self
                .active_turns
                .matches_turn(&session_id, &current_turn_id) =>
            {
                Some(current_turn_id)
            }
            _ => None,
        };

        if active_turn_id.as_deref() == Some(turn_id.as_str()) && !images.is_empty() {
            self.coordinator
                .prepare_input_images(&session_id, &mut images)
                .await
                .map_err(|error| error.to_string())?;
            for (attachment, image) in attachments.iter_mut().zip(&images) {
                if let Some(path) = &image.image_path {
                    attachment
                        .metadata
                        .insert("imagePath".into(), serde_json::json!(path));
                }
                attachment
                    .metadata
                    .insert("mimeType".into(), serde_json::json!(image.mime_type));
            }
        }

        let steering_id = Uuid::new_v4().to_string();
        match resolve_dialog_steering_action(
            active_turn_id.as_deref(),
            &session_id,
            &turn_id,
            content,
            display_content,
            attachments,
            metadata,
            steering_id,
            SystemTime::now(),
        ) {
            DialogSteeringAction::Reject { error } => {
                warn!(
                    "Steering rejected: target turn is not running: session_id={}, turn_id={}",
                    session_id, turn_id
                );
                Err(error)
            }
            DialogSteeringAction::Buffer { injection, outcome } => {
                self.round_injection_buffer.push(&session_id, injection);
                let DialogSteerOutcome::Buffered { steering_id, .. } = &outcome;
                info!(
                    "Steering message buffered: session_id={}, turn_id={}, steering_id={}, pending={}",
                    session_id,
                    turn_id,
                    steering_id,
                    self.round_injection_buffer.pending_count(&session_id)
                );

                Ok(outcome)
            }
        }
    }

    /// Resume auto-continuation toward an active thread goal (after pause / blocked / usage limit).
    pub async fn deliver_thread_goal_resumed(
        &self,
        session_id: String,
        agent_type: String,
        workspace_path: Option<String>,
        remote_connection_id: Option<String>,
        remote_ssh_host: Option<String>,
        goal: ThreadGoal,
    ) -> Result<(), String> {
        let plan = build_thread_goal_resumed_delivery_plan(&goal);
        let operation_guard = self.lock_session_operation(&session_id).await;
        let state = self
            .session_manager
            .get_session(&session_id)
            .map(|s| s.state.clone());

        match resolve_background_delivery_action(BackgroundDeliveryFacts {
            session_state: Self::session_state_fact(state.as_ref()),
        }) {
            BackgroundDeliveryAction::InjectIntoRunningTurn => {
                let Some(current_turn_id) = state.as_ref().and_then(|state| match state {
                    SessionState::Processing {
                        current_turn_id, ..
                    } => Some(current_turn_id.clone()),
                    _ => None,
                }) else {
                    return Err(format!(
                        "Thread goal resume resolved to injection without an active turn: session_id={session_id}"
                    ));
                };
                self.round_injection_buffer.push(
                    &session_id,
                    target_background_delivery_injection_to_turn(
                        resolve_background_delivery_injection(
                            BackgroundInjectionKind::ThreadGoalObjectiveUpdated,
                            Uuid::new_v4().to_string(),
                            plan.injection_prompt,
                            Some(plan.injection_display),
                            SystemTime::now(),
                        ),
                        current_turn_id,
                    ),
                );
                Ok(())
            }
            BackgroundDeliveryAction::SubmitAgentSessionFollowUp { queue_priority } => {
                drop(operation_guard);
                let prepended = thread_goal_delivery_messages(plan.prepended_reminders);
                self.submit_with_prepended_messages(
                    session_id,
                    plan.follow_up_user_input,
                    plan.follow_up_original_user_input,
                    None,
                    agent_type,
                    workspace_path,
                    remote_connection_id,
                    remote_ssh_host,
                    DialogSubmissionPolicy::new(DialogTriggerSource::AgentSession, queue_priority),
                    None,
                    Some(plan.user_message_metadata),
                    prepended,
                    None,
                )
                .await
                .map(|_| ())
            }
        }
    }

    /// Inject objective-updated steering into the running turn, or start a follow-up turn when idle.
    pub async fn deliver_thread_goal_objective_updated(
        &self,
        session_id: String,
        agent_type: String,
        workspace_path: Option<String>,
        remote_connection_id: Option<String>,
        remote_ssh_host: Option<String>,
        goal: ThreadGoal,
    ) -> Result<(), String> {
        let plan = build_thread_goal_objective_updated_delivery_plan(&goal);
        let operation_guard = self.lock_session_operation(&session_id).await;
        let state = self
            .session_manager
            .get_session(&session_id)
            .map(|s| s.state.clone());

        match resolve_background_delivery_action(BackgroundDeliveryFacts {
            session_state: Self::session_state_fact(state.as_ref()),
        }) {
            BackgroundDeliveryAction::InjectIntoRunningTurn => {
                let Some(current_turn_id) = state.as_ref().and_then(|state| match state {
                    SessionState::Processing {
                        current_turn_id, ..
                    } => Some(current_turn_id.clone()),
                    _ => None,
                }) else {
                    return Err(format!(
                        "Thread goal update resolved to injection without an active turn: session_id={session_id}"
                    ));
                };
                self.round_injection_buffer.push(
                    &session_id,
                    target_background_delivery_injection_to_turn(
                        resolve_background_delivery_injection(
                            BackgroundInjectionKind::ThreadGoalObjectiveUpdated,
                            Uuid::new_v4().to_string(),
                            plan.injection_prompt,
                            Some(plan.injection_display),
                            SystemTime::now(),
                        ),
                        current_turn_id,
                    ),
                );
                Ok(())
            }
            BackgroundDeliveryAction::SubmitAgentSessionFollowUp { queue_priority } => {
                drop(operation_guard);
                let prepended = thread_goal_delivery_messages(plan.prepended_reminders);
                self.submit_with_prepended_messages(
                    session_id,
                    plan.follow_up_user_input,
                    plan.follow_up_original_user_input,
                    None,
                    agent_type,
                    workspace_path,
                    remote_connection_id,
                    remote_ssh_host,
                    DialogSubmissionPolicy::new(DialogTriggerSource::AgentSession, queue_priority),
                    None,
                    Some(plan.user_message_metadata),
                    prepended,
                    None,
                )
                .await
                .map(|_| ())
            }
        }
    }

    /// Deliver a completed background result back to the parent session.
    /// If the session is currently processing, inject the result into the
    /// running turn at the next model-round boundary. Otherwise, start a new
    /// turn immediately so the result is handled without waiting for an
    /// unrelated future message.
    pub async fn deliver_background_result(
        &self,
        session_id: String,
        agent_type: String,
        workspace_path: Option<String>,
        remote_connection_id: Option<String>,
        remote_ssh_host: Option<String>,
        content: String,
        display_content: Option<String>,
        user_message_metadata: Option<serde_json::Value>,
    ) -> Result<(), String> {
        let _operation_guard = self.lock_session_operation(&session_id).await;
        let session_agent_type = self
            .resolve_session_agent_type(
                &session_id,
                workspace_path.as_deref(),
                remote_connection_id.as_deref(),
                remote_ssh_host.as_deref(),
            )
            .await?;
        if session_agent_type != agent_type {
            debug!(
                "Background result delivery replaced execution agent key with Session logical route: session_id={}, execution_agent_type={}, session_agent_type={}",
                session_id, agent_type, session_agent_type
            );
        }
        let display = display_content.unwrap_or_else(|| content.clone());
        let delivery = BackgroundResultDelivery {
            session_id: session_id.clone(),
            agent_type: session_agent_type,
            workspace_path,
            remote_connection_id,
            remote_ssh_host,
            content,
            display_content: Some(display),
            user_message_metadata,
        };
        let state = self
            .session_manager
            .get_session(&session_id)
            .map(|s| s.state.clone());

        match resolve_background_delivery_action(BackgroundDeliveryFacts {
            session_state: background_result_delivery_state_fact(
                &session_id,
                state.as_ref(),
                delivery.user_message_metadata.as_ref(),
            ),
        }) {
            BackgroundDeliveryAction::InjectIntoRunningTurn => {
                let Some(current_turn_id) = state.as_ref().and_then(|state| match state {
                    SessionState::Processing {
                        current_turn_id, ..
                    } => Some(current_turn_id.clone()),
                    _ => None,
                }) else {
                    return Err(format!(
                        "Background result resolved to injection without an active turn: session_id={session_id}"
                    ));
                };
                let injection_id = Uuid::new_v4().to_string();
                let injection = target_background_delivery_injection_to_turn(
                    resolve_background_delivery_injection(
                        BackgroundInjectionKind::BackgroundResult,
                        injection_id.clone(),
                        delivery.content.clone(),
                        delivery.display_content.clone(),
                        SystemTime::now(),
                    ),
                    current_turn_id,
                );
                self.round_injection_buffer.push(&session_id, injection);
                Ok(())
            }
            BackgroundDeliveryAction::SubmitAgentSessionFollowUp { queue_priority } => {
                self.submit_background_result_follow_up_locked(delivery, queue_priority)
                    .await
            }
        }
    }

    async fn submit_background_result_follow_up_locked(
        &self,
        delivery: BackgroundResultDelivery,
        queue_priority: DialogQueuePriority,
    ) -> Result<(), String> {
        let resolved_turn_id = Uuid::new_v4().to_string();
        let queued_turn = QueuedTurn {
            user_input: delivery.content,
            original_user_input: delivery.display_content,
            prepended_messages: Vec::new(),
            turn_id: Some(resolved_turn_id.clone()),
            agent_type: delivery.agent_type,
            workspace_path: delivery.workspace_path,
            workspace_id: None,
            remote_connection_id: delivery.remote_connection_id,
            remote_ssh_host: delivery.remote_ssh_host,
            policy: DialogSubmissionPolicy::new(DialogTriggerSource::AgentSession, queue_priority),
            reply_route: None,
            user_message_metadata: delivery.user_message_metadata,
            image_contexts: None,
            enqueued_at: SystemTime::now(),
            _settlement_registration: None,
            execution: QueuedTurnExecution::Standard,
        };
        let result = self
            .submit_queued_turn_locked(
                delivery.session_id.clone(),
                resolved_turn_id.clone(),
                queued_turn,
                false,
            )
            .await;
        if result.is_err() {
            if let Some(removed_turn) =
                remove_queued_turn_by_id(&self.queues, &delivery.session_id, &resolved_turn_id)
            {
                self.finish_removed_queued_turn(&delivery.session_id, removed_turn)
                    .await;
            }
        }
        result.map(|_| ()).map_err(|error| error.to_string())
    }

    pub async fn submit_init_agents_md(
        &self,
        session_id: String,
        workspace_path: Option<String>,
        remote_connection_id: Option<String>,
        remote_ssh_host: Option<String>,
        policy: DialogSubmissionPolicy,
    ) -> Result<DialogSubmitOutcome, String> {
        let agent_type = self
            .resolve_session_agent_type(
                &session_id,
                workspace_path.as_deref(),
                remote_connection_id.as_deref(),
                remote_ssh_host.as_deref(),
            )
            .await?;
        let (user_input, prepended_messages) = build_init_agents_md_user_input()
            .await
            .map_err(|error| error.to_string())?;

        self.submit_with_prepended_messages(
            session_id,
            user_input.clone(),
            Some(user_input),
            None,
            agent_type,
            workspace_path,
            remote_connection_id,
            remote_ssh_host,
            policy,
            None,
            None,
            prepended_messages,
            None,
        )
        .await
    }

    fn session_state_fact(state: Option<&SessionState>) -> DialogSessionStateFact {
        match state {
            None => DialogSessionStateFact::Missing,
            Some(state) => state.dialog_state_fact(),
        }
    }

    /// Submit a user message for a session.
    ///
    /// - Session idle, queue empty → dispatched immediately.
    /// - Session idle, queue non-empty → enqueued then highest-priority queued message dispatched.
    /// - Session processing → queued up to the runtime-owned queue limit and dispatched after
    ///   the current turn completes.
    /// - Session error → queue cleared, dispatched immediately.
    ///
    /// Returns `Err(String)` if the queue is full or the coordinator returns an error.
    #[allow(clippy::too_many_arguments)]
    pub async fn submit(
        &self,
        session_id: String,
        user_input: String,
        original_user_input: Option<String>,
        turn_id: Option<String>,
        agent_type: String,
        workspace_path: Option<String>,
        remote_connection_id: Option<String>,
        remote_ssh_host: Option<String>,
        policy: DialogSubmissionPolicy,
        reply_route: Option<AgentSessionReplyRoute>,
        user_message_metadata: Option<serde_json::Value>,
        image_contexts: Option<Vec<ImageContextData>>,
    ) -> Result<DialogSubmitOutcome, String> {
        self.submit_with_prepended_messages(
            session_id,
            user_input,
            original_user_input,
            turn_id,
            agent_type,
            workspace_path,
            remote_connection_id,
            remote_ssh_host,
            policy,
            reply_route,
            user_message_metadata,
            Vec::new(),
            image_contexts,
        )
        .await
    }

    #[allow(clippy::too_many_arguments)]
    pub async fn submit_with_prepended_messages(
        &self,
        session_id: String,
        user_input: String,
        original_user_input: Option<String>,
        turn_id: Option<String>,
        agent_type: String,
        workspace_path: Option<String>,
        remote_connection_id: Option<String>,
        remote_ssh_host: Option<String>,
        policy: DialogSubmissionPolicy,
        reply_route: Option<AgentSessionReplyRoute>,
        user_message_metadata: Option<serde_json::Value>,
        prepended_messages: Vec<Message>,
        image_contexts: Option<Vec<ImageContextData>>,
    ) -> Result<DialogSubmitOutcome, String> {
        let resolved_turn_id = turn_id.unwrap_or_else(|| Uuid::new_v4().to_string());
        let queued_turn = QueuedTurn {
            user_input,
            original_user_input,
            prepended_messages,
            turn_id: Some(resolved_turn_id.clone()),
            agent_type,
            workspace_path,
            workspace_id: None,
            remote_connection_id,
            remote_ssh_host,
            policy,
            reply_route,
            user_message_metadata,
            image_contexts,
            enqueued_at: SystemTime::now(),
            _settlement_registration: None,
            execution: QueuedTurnExecution::Standard,
        };
        self.submit_queued_turn(session_id, resolved_turn_id, queued_turn, false)
            .await
            .map_err(|error| error.to_string())
    }

    pub(crate) async fn submit_hidden_subagent(
        &self,
        mut request: HiddenSubagentExecutionRequest,
        timeout_seconds: Option<u64>,
    ) -> Result<HiddenSubagentSubmitResult, String> {
        let session_id = request
            .target_session_id()
            .ok_or_else(|| {
                "prepared hidden subagent request is missing target_session_id".to_string()
            })?
            .to_string();
        let resolved_turn_id = request.ensure_dialog_turn_id();
        let agent_type = request.logical_agent_type().to_string();
        let user_input = request.user_input_text().to_string();
        let session = self
            .session_manager
            .get_session(&session_id)
            .ok_or_else(|| {
                format!(
                    "Subagent session not found before scheduler submit: {}",
                    session_id
                )
            })?;
        let (result_tx, result_rx) = oneshot::channel();
        let result_tx = SharedSubagentResultSender::new(result_tx);
        let cancellation = HiddenSubagentQueueCancellation::default();
        let queued_turn = QueuedTurn {
            user_input: user_input.clone(),
            original_user_input: Some(user_input),
            prepended_messages: Vec::new(),
            turn_id: Some(resolved_turn_id.clone()),
            agent_type,
            workspace_path: session.config.workspace_path.clone(),
            workspace_id: None,
            remote_connection_id: session.config.remote_connection_id.clone(),
            remote_ssh_host: session.config.remote_ssh_host.clone(),
            policy: DialogSubmissionPolicy::for_source(DialogTriggerSource::AgentSession),
            reply_route: None,
            user_message_metadata: None,
            image_contexts: None,
            enqueued_at: SystemTime::now(),
            _settlement_registration: None,
            execution: QueuedTurnExecution::HiddenSubagent(HiddenSubagentQueuedExecution {
                request,
                timeout_seconds,
                result_tx: result_tx.clone(),
                cancellation: cancellation.clone(),
            }),
        };

        self.submit_queued_turn(
            session_id.clone(),
            resolved_turn_id.clone(),
            queued_turn,
            false,
        )
        .await
        .map_err(|error| error.to_string())?;
        Ok(HiddenSubagentSubmitResult {
            receiver: result_rx,
            cancel_handle: HiddenSubagentQueueCancelHandle {
                session_id,
                turn_id: resolved_turn_id,
                cancellation,
                result_tx,
            },
        })
    }

    pub(crate) async fn request_hidden_subagent_cancellation(
        &self,
        handle: &HiddenSubagentQueueCancelHandle,
    ) {
        self.request_hidden_subagent_cancellation_with_descendant_policy(handle, true)
            .await;
    }

    pub(crate) async fn request_hidden_subagent_cancellation_with_descendant_policy(
        &self,
        handle: &HiddenSubagentQueueCancelHandle,
        cancel_descendants: bool,
    ) {
        handle.cancellation.cancel();
        if let Err(error) = self
            .cancel_queued_or_active_turn_with_descendant_policy(
                &handle.session_id,
                &handle.turn_id,
                cancel_descendants,
            )
            .await
        {
            debug!(
                "Hidden subagent turn cancellation request did not hit an active turn: session_id={}, turn_id={}, error={}",
                handle.session_id, handle.turn_id, error
            );
            handle.result_tx.send(Err(OpenBitFunError::Cancelled(
                "Subagent task has been cancelled".to_string(),
            )));
        }
    }

    async fn resolve_session_agent_type(
        &self,
        session_id: &str,
        workspace_path: Option<&str>,
        remote_connection_id: Option<&str>,
        remote_ssh_host: Option<&str>,
    ) -> Result<String, String> {
        let session = match self.session_manager.get_session(session_id) {
            Some(session) => session,
            None => {
                let workspace_path = workspace_path.ok_or_else(|| {
                    format!(
                        "workspace_path is required when restoring session: {}",
                        session_id
                    )
                })?;
                let restore_path = Self::resolve_session_restore_path(
                    workspace_path,
                    remote_connection_id,
                    remote_ssh_host,
                )
                .await
                .map_err(|error| error.to_string())?;
                self.coordinator
                    .restore_session_from_storage_path(&restore_path, session_id)
                    .await
                    .map_err(|error| error.to_string())?
            }
        };
        let agent_type = session.agent_type.trim();
        if agent_type.is_empty() {
            Ok("Standard".to_string())
        } else {
            Ok(agent_type.to_string())
        }
    }

    async fn resolve_session_restore_path(
        workspace_path: &str,
        remote_connection_id: Option<&str>,
        remote_ssh_host: Option<&str>,
    ) -> Result<PathBuf, SchedulerSubmitError> {
        let request = SessionStoragePathRequest {
            workspace_path: PathBuf::from(workspace_path),
            remote_connection_id: remote_connection_id.map(ToOwned::to_owned),
            remote_ssh_host: remote_ssh_host.map(ToOwned::to_owned),
        };

        CoreSessionStorePort::default()
            .resolve_session_storage_path(request)
            .await
            .map(|resolution| resolution.effective_storage_path)
            .map_err(SchedulerSubmitError::Port)
    }

    async fn restore_missing_session_before_admission(
        &self,
        session_id: &str,
        requested_storage_path: &Path,
    ) -> Result<Option<crate::agentic::core::Session>, SchedulerSubmitError> {
        if self.session_manager.get_session(session_id).is_some() {
            return Ok(None);
        }
        match self
            .coordinator
            .restore_session_from_storage_path(requested_storage_path, session_id)
            .await
        {
            Ok(session) => Ok(Some(session)),
            Err(OpenBitFunError::NotFound(_)) => {
                // A genuinely new Session has no persisted state to restore.
                Ok(None)
            }
            Err(error) => Err(SchedulerSubmitError::Core(error)),
        }
    }

    async fn submit_queued_turn(
        &self,
        session_id: String,
        resolved_turn_id: String,
        queued_turn: QueuedTurn,
        reject_if_busy: bool,
    ) -> Result<DialogSubmitOutcome, SchedulerSubmitError> {
        let _operation_guard = self.lock_session_operation(&session_id).await;
        self.submit_queued_turn_locked(session_id, resolved_turn_id, queued_turn, reject_if_busy)
            .await
    }

    async fn submit_queued_turn_locked(
        &self,
        session_id: String,
        resolved_turn_id: String,
        mut queued_turn: QueuedTurn,
        reject_if_busy: bool,
    ) -> Result<DialogSubmitOutcome, SchedulerSubmitError> {
        if let Some(session) = self.session_manager.get_session(&session_id) {
            queued_turn.workspace_path = session_storage_workspace_locator(
                queued_turn.workspace_path.as_deref(),
                session.config.workspace_path.as_deref(),
                session.config.project_workspace_path.as_deref(),
            );
        }
        let requested_workspace_id = queued_turn
            .workspace_id
            .as_deref()
            .map(str::trim)
            .filter(|id| !id.is_empty())
            .map(ToOwned::to_owned);
        let requested_storage_path = if let Some(workspace_id) = requested_workspace_id.as_deref() {
            // ID-aware callers locate the session by its owning workspace; the
            // path on the request is only an execution-root projection.
            Some(
                CoreSessionStorePort::default()
                    .resolve_workspace_storage(workspace_id)
                    .await
                    .map(|resolution| resolution.effective_storage_path)
                    .map_err(SchedulerSubmitError::Port)?,
            )
        } else if let Some(workspace_path) = queued_turn.workspace_path.as_deref() {
            Some(
                Self::resolve_session_restore_path(
                    workspace_path,
                    queued_turn.remote_connection_id.as_deref(),
                    queued_turn.remote_ssh_host.as_deref(),
                )
                .await?,
            )
        } else {
            None
        };
        if let Some(requested_storage_path) = requested_storage_path {
            if let Some(restored_session) = self
                .restore_missing_session_before_admission(&session_id, &requested_storage_path)
                .await?
            {
                queued_turn.workspace_path = session_storage_workspace_locator(
                    queued_turn.workspace_path.as_deref(),
                    restored_session.config.workspace_path.as_deref(),
                    restored_session.config.project_workspace_path.as_deref(),
                );
            }
            self.session_manager
                .validate_session_storage_path_binding(&session_id, &requested_storage_path)
                .map_err(SchedulerSubmitError::Core)?;
            if requested_workspace_id.is_some() {
                // The session is loaded and bound by ID; an omitted locator makes
                // the coordinator reuse that binding instead of re-resolving a path.
                queued_turn.workspace_path = None;
            }
        }
        let state = self
            .session_manager
            .get_session(&session_id)
            .map(|s| s.state.clone());
        let mut interrupted_hold = matches!(state, Some(SessionState::Idle))
            && self
                .session_manager
                .latest_dialog_turn_holds_dispatch(&session_id)
                .await
                .map_err(SchedulerSubmitError::Core)?;
        let interrupted_turn_to_abandon = if interrupted_hold
            && !matches!(
                queued_turn.policy.trigger_source,
                DialogTriggerSource::AgentSession | DialogTriggerSource::ScheduledJob
            ) {
            interrupted_hold = false;
            self.session_manager
                .get_session(&session_id)
                .and_then(|session| session.dialog_turn_ids.last().cloned())
        } else {
            None
        };
        let state_fact = if self.active_turns.contains(&session_id) || interrupted_hold {
            DialogSessionStateFact::Processing
        } else {
            Self::session_state_fact(state.as_ref())
        };

        let queue_has_items = self.queues.has_items(&session_id);
        if matches!(
            &queued_turn.execution,
            QueuedTurnExecution::FreshExternalSubagent(_)
        ) && (!matches!(&state_fact, DialogSessionStateFact::Idle) || queue_has_items)
        {
            return Err(SchedulerSubmitError::Core(OpenBitFunError::Validation(
                "External subagent delegation requires an idle session with an empty queue"
                    .to_string(),
            )));
        }
        let action = resolve_dialog_submit_queue_action(DialogSubmitQueueFacts {
            session_state: state_fact,
            queue_has_items,
            policy: queued_turn.policy,
        });

        if reject_if_busy
            && matches!(
                action,
                DialogSubmitQueueAction::EnqueueThenStartNext
                    | DialogSubmitQueueAction::EnqueueForActiveTurn
            )
        {
            return Err(SchedulerSubmitError::Message(
                "Session state does not allow starting new dialog: Processing".to_string(),
            ));
        }

        if let Some(images) = queued_turn.image_contexts.as_mut() {
            self.coordinator
                .prepare_input_images(&session_id, images)
                .await
                .map_err(SchedulerSubmitError::Core)?;
        }

        // OpenCode-compatible semantics: accepting a new prompt while history
        // is staged permanently discards the hidden suffix before the Turn starts.
        self.coordinator
            .commit_session_revert_before_submission(&session_id)
            .await
            .map_err(SchedulerSubmitError::Core)?;

        match action {
            DialogSubmitQueueAction::StartImmediately => {
                let tid = self.start_turn(&session_id, &queued_turn).await?;
                if let Err(error) = self
                    .abandon_superseded_interrupted_turn(
                        &session_id,
                        interrupted_turn_to_abandon.as_deref(),
                    )
                    .await
                {
                    warn!(
                        "Failed to clear superseded interrupted turn after starting new user work: session_id={}, error={}",
                        session_id, error
                    );
                }
                queued_turn.accept_settlement();
                self.record_last_submitted_agent_type(&session_id, &queued_turn.agent_type)
                    .await;
                Ok(DialogSubmitOutcome::Started {
                    session_id,
                    turn_id: tid,
                })
            }

            DialogSubmitQueueAction::ClearQueueAndStartImmediately => {
                let _ = self.clear_queue(&session_id).await;
                let tid = self.start_turn(&session_id, &queued_turn).await?;
                if let Err(error) = self
                    .abandon_superseded_interrupted_turn(
                        &session_id,
                        interrupted_turn_to_abandon.as_deref(),
                    )
                    .await
                {
                    warn!(
                        "Failed to clear superseded interrupted turn after starting new user work: session_id={}, error={}",
                        session_id, error
                    );
                }
                queued_turn.accept_settlement();
                self.record_last_submitted_agent_type(&session_id, &queued_turn.agent_type)
                    .await;
                Ok(DialogSubmitOutcome::Started {
                    session_id,
                    turn_id: tid,
                })
            }

            DialogSubmitQueueAction::EnqueueThenStartNext => {
                self.enqueue(&session_id, queued_turn.clone())?;
                self.abandon_interrupted_turn_after_enqueue(
                    &session_id,
                    &resolved_turn_id,
                    interrupted_turn_to_abandon.as_deref(),
                )
                .await?;
                queued_turn.accept_settlement();
                self.record_last_submitted_agent_type(&session_id, &queued_turn.agent_type)
                    .await;
                let started_tid = self.try_start_next_queued_locked(&session_id).await?;
                let outcome =
                    queued_submission_outcome(session_id.clone(), resolved_turn_id, started_tid);
                Ok(outcome)
            }

            DialogSubmitQueueAction::EnqueueForActiveTurn => {
                let accepted_agent_type = queued_turn.agent_type.clone();
                self.enqueue(&session_id, queued_turn.clone())?;
                self.abandon_interrupted_turn_after_enqueue(
                    &session_id,
                    &resolved_turn_id,
                    interrupted_turn_to_abandon.as_deref(),
                )
                .await?;
                queued_turn.accept_settlement();
                self.record_last_submitted_agent_type(&session_id, &accepted_agent_type)
                    .await;
                Ok(DialogSubmitOutcome::Queued {
                    session_id,
                    turn_id: resolved_turn_id,
                })
            }
        }
    }

    async fn abandon_superseded_interrupted_turn(
        &self,
        session_id: &str,
        interrupted_turn_id: Option<&str>,
    ) -> OpenBitFunResult<()> {
        let Some(interrupted_turn_id) = interrupted_turn_id else {
            return Ok(());
        };
        if let Some(abandoned_turn_id) = self
            .session_manager
            .abandon_interrupted_dialog_turn(session_id, Some(interrupted_turn_id))
            .await?
        {
            self.round_injection_buffer
                .drain_for_turn(session_id, &abandoned_turn_id);
        }
        Ok(())
    }

    async fn abandon_interrupted_turn_after_enqueue(
        &self,
        session_id: &str,
        queued_turn_id: &str,
        interrupted_turn_id: Option<&str>,
    ) -> Result<(), SchedulerSubmitError> {
        if let Err(error) = self
            .abandon_superseded_interrupted_turn(session_id, interrupted_turn_id)
            .await
        {
            if let Some(removed_turn) =
                remove_queued_turn_by_id(&self.queues, session_id, queued_turn_id)
            {
                self.finish_removed_queued_turn(session_id, removed_turn)
                    .await;
            }
            return Err(SchedulerSubmitError::Core(error));
        }
        Ok(())
    }

    async fn record_last_submitted_agent_type(&self, session_id: &str, agent_type: &str) {
        if let Err(error) = self
            .coordinator
            .update_last_submitted_agent_type(session_id, agent_type)
            .await
        {
            warn!(
                "Failed to record last submitted agent type: session_id={}, agent_type={}, error={}",
                session_id, agent_type, error
            );
        }
    }

    /// Number of messages currently queued for a session.
    pub fn queue_depth(&self, session_id: &str) -> usize {
        self.queues.depth(session_id)
    }

    /// Whether a session has a running or queued turn. This is intentionally a
    /// narrow observation API for features that need an idle target without
    /// depending on scheduler internals.
    pub fn is_session_busy_or_queued(&self, session_id: &str) -> bool {
        self.active_turns.contains(session_id)
            || self.queues.has_items(session_id)
            || self
                .session_manager
                .get_session_state(session_id)
                .is_some_and(|state| matches!(state, SessionState::Processing { .. }))
    }

    async fn finish_removed_queued_turn(&self, session_id: &str, removed_turn: QueuedTurn) {
        match removed_turn.execution {
            QueuedTurnExecution::Standard | QueuedTurnExecution::FreshExternalSubagent(_) => {
                if let Some(turn_id) = removed_turn.turn_id {
                    self.coordinator
                        .emit_event(AgenticEvent::DialogTurnCancelled {
                            session_id: session_id.to_string(),
                            turn_id,
                        })
                        .await;
                } else {
                    warn!("Removed queued dialog turn without a turn id: session_id={session_id}");
                }
            }
            QueuedTurnExecution::HiddenSubagent(execution) => {
                execution.cancellation.cancel();
                self.coordinator
                    .cleanup_prepared_hidden_subagent_session_if_unsubmitted(&execution.request)
                    .await;
                execution.result_tx.send(Err(OpenBitFunError::Cancelled(
                    "Subagent task has been cancelled".to_string(),
                )));
            }
        }
    }

    /// Cancel one queued or active turn without allowing it to cross the
    /// scheduler's dequeue-to-coordinator transition.
    ///
    /// Returns `true` when the turn was removed before it started. `false`
    /// means cancellation was delivered to the active coordinator execution.
    pub async fn cancel_queued_or_active_turn(
        &self,
        session_id: &str,
        turn_id: &str,
    ) -> Result<bool, String> {
        self.cancel_queued_or_active_turn_with_descendant_policy(session_id, turn_id, true)
            .await
    }

    async fn cancel_queued_or_active_turn_with_descendant_policy(
        &self,
        session_id: &str,
        turn_id: &str,
        cancel_descendants: bool,
    ) -> Result<bool, String> {
        let _operation_guard = self.lock_session_operation(session_id).await;
        let removed_turn = remove_queued_turn_by_id(&self.queues, session_id, turn_id);
        if let Some(removed_turn) = removed_turn {
            self.finish_removed_queued_turn(session_id, removed_turn)
                .await;
            debug!(
                "Removed queued turn after targeted cancellation: session_id={}, turn_id={}",
                session_id, turn_id
            );
            return Ok(true);
        }

        if !self.active_turns.matches_turn(session_id, turn_id) {
            if self
                .session_manager
                .abandon_interrupted_dialog_turn(session_id, Some(turn_id))
                .await
                .map_err(|error| error.to_string())?
                .is_some()
            {
                self.round_injection_buffer
                    .drain_for_turn(session_id, turn_id);
                self.coordinator
                    .emit_event(AgenticEvent::DialogTurnCancelled {
                        session_id: session_id.to_string(),
                        turn_id: turn_id.to_string(),
                    })
                    .await;
                if let Err(error) = self.try_start_next_queued_locked(session_id).await {
                    warn!(
                        "Failed to dispatch held queue after abandoning interrupted turn: session_id={}, turn_id={}, error={}",
                        session_id, turn_id, error
                    );
                }
            }
            debug!(
                "Ignoring cancellation for a turn that is not active in the requested session: session_id={}, turn_id={}",
                session_id, turn_id
            );
            return Ok(false);
        }

        self.coordinator
            .cancel_dialog_turn_with_descendant_policy(
                session_id,
                turn_id,
                cancel_descendants,
                Duration::from_millis(1500),
                DialogTurnStopDisposition::Cancelled,
            )
            .await?;
        // The coordinator may have committed an Interrupted recovery fact
        // while this hard-cancel request was waiting for the active execution
        // to drain. Always attempt the generation-aware abandon after the
        // drain so the result does not depend on whether the scheduler outcome
        // retired the active projection first. Ordinary Cancelled turns return
        // None, making this an idempotent no-op.
        if self
            .session_manager
            .abandon_interrupted_dialog_turn(session_id, Some(turn_id))
            .await
            .map_err(|error| error.to_string())?
            .is_some()
        {
            self.round_injection_buffer
                .drain_for_turn(session_id, turn_id);
            self.coordinator
                .emit_event(AgenticEvent::DialogTurnCancelled {
                    session_id: session_id.to_string(),
                    turn_id: turn_id.to_string(),
                })
                .await;
            if let Err(error) = self.try_start_next_queued_locked(session_id).await {
                warn!(
                    "Failed to dispatch held queue after hard cancellation abandoned interrupted recovery: session_id={}, turn_id={}, error={}",
                    session_id, turn_id, error
                );
            }
        }
        Ok(false)
    }

    /// Cancel the target session's active turn on behalf of a requester session.
    ///
    /// If the requester is the same source session that originally sent the
    /// in-flight SessionMessage request, the scheduler suppresses the automatic
    /// cancelled-reply bounce-back for that specific turn.
    pub async fn cancel_active_turn_for_session_from_requester(
        &self,
        target_session_id: &str,
        requester_session_id: &str,
        wait_timeout: Duration,
    ) -> crate::util::errors::OpenBitFunResult<Option<String>> {
        let _operation_guard = self.lock_session_operation(target_session_id).await;
        let suppression_key = self
            .active_turns
            .suppression_key_for_requester(target_session_id, requester_session_id);

        if let Some((session_id, turn_id)) = suppression_key.as_ref() {
            debug!(
                "Suppressing cancelled auto-reply for agent-session turn: target_session_id={}, turn_id={}, requester_session_id={}",
                session_id, turn_id, requester_session_id
            );
            self.suppressed_cancelled_replies.mark(session_id, turn_id);
        }

        abort_thread_goal_continuation_for_session(target_session_id);

        match self
            .coordinator
            .cancel_active_turn_for_session(target_session_id, wait_timeout)
            .await
        {
            Ok(cancelled_turn_id) => {
                if cancelled_turn_id.is_none() {
                    if let Some((session_id, turn_id)) = suppression_key {
                        self.suppressed_cancelled_replies
                            .clear(&session_id, &turn_id);
                    }
                }
                Ok(cancelled_turn_id)
            }
            Err(error) => {
                if let Some((session_id, turn_id)) = suppression_key {
                    self.suppressed_cancelled_replies
                        .clear(&session_id, &turn_id);
                }
                Err(error)
            }
        }
    }

    /// Cancel the current active turn without allowing submit or outcome
    /// dispatch to cross the cancellation boundary for this session.
    pub async fn cancel_active_turn_for_session(
        &self,
        session_id: &str,
        wait_timeout: Duration,
    ) -> OpenBitFunResult<Option<String>> {
        self.cancel_active_turn_for_session_with_descendant_policy(session_id, wait_timeout, true)
            .await
    }

    pub(crate) async fn inspect_loaded_lineage_session(
        &self,
        storage_path: &Path,
        request: SessionTranscriptRequest,
        required_settled_turn_ids: &[String],
    ) -> PortResult<Option<AgentSessionLineageInspection>> {
        let _operation_guard = self.lock_session_operation(&request.session_id).await;
        self.coordinator
            .inspect_loaded_lineage_session_in_storage(
                storage_path,
                request,
                required_settled_turn_ids,
            )
            .await
    }

    pub(crate) async fn cancel_lineage_session_in_storage(
        &self,
        storage_path: &Path,
        session_id: &str,
        expected_active_turn_id: Option<&str>,
        wait_timeout: Duration,
    ) -> OpenBitFunResult<Option<String>> {
        let deadline = Instant::now() + wait_timeout;
        let _operation_guard = tokio::time::timeout(
            wait_timeout,
            self.lock_session_operation(session_id),
        )
        .await
        .map_err(|_| {
            OpenBitFunError::Timeout(format!(
                "Timed out acquiring the Session operation lock before lineage cancellation: session_id={session_id}"
            ))
        })?;
        self.coordinator
            .cancel_loaded_lineage_session_in_storage(
                storage_path,
                session_id,
                expected_active_turn_id,
                deadline.saturating_duration_since(Instant::now()),
            )
            .await
    }

    async fn cancel_active_turn_for_session_with_descendant_policy(
        &self,
        session_id: &str,
        wait_timeout: Duration,
        cancel_descendants: bool,
    ) -> OpenBitFunResult<Option<String>> {
        let _operation_guard = self.lock_session_operation(session_id).await;
        abort_thread_goal_continuation_for_session(session_id);
        self.coordinator
            .cancel_active_turn_for_session_with_descendant_policy(
                session_id,
                wait_timeout,
                cancel_descendants,
            )
            .await
    }

    /// Quiesce one session for destructive maintenance. Queued turns receive an explicit
    /// cancelled lifecycle event before active execution is cancelled and
    /// drained, so no accepted turn disappears silently.
    pub(crate) async fn begin_session_maintenance(
        &self,
        session_id: &str,
        requested_storage_path: &std::path::Path,
        wait_timeout: Duration,
    ) -> OpenBitFunResult<SessionMaintenancePermit> {
        openbitfun_core_types::validate_session_id(session_id)
            .map_err(OpenBitFunError::Validation)?;
        let operation_guard = self.lock_session_operation(session_id).await;
        self.session_manager
            .validate_session_storage_path_binding(session_id, requested_storage_path)?;
        let mut retired_turn_ids = if self.queue_depth(session_id) > 0 {
            self.clear_queue(session_id).await
        } else {
            Vec::new()
        };
        abort_thread_goal_continuation_for_session(session_id);
        let deadline = Instant::now() + wait_timeout;
        let cancelled_before_parent = self
            .coordinator
            .cancel_background_subagents_for_parent_session(session_id)
            .await?;
        let mut subagent_session_ids = self
            .maintenance_background_sessions
            .get(session_id)
            .map(|sessions| sessions.clone())
            .unwrap_or_default();
        subagent_session_ids.extend(cancelled_before_parent);
        if !subagent_session_ids.is_empty() {
            self.maintenance_background_sessions
                .insert(session_id.to_string(), subagent_session_ids.clone());
        }
        let cancelled_turn_id = self
            .coordinator
            .cancel_active_turn_for_session(
                session_id,
                deadline.saturating_duration_since(Instant::now()),
            )
            .await?;
        let cancelled_during_parent = self
            .coordinator
            .cancel_background_subagents_for_parent_session(session_id)
            .await?;
        subagent_session_ids.extend(cancelled_during_parent);
        if !subagent_session_ids.is_empty() {
            self.maintenance_background_sessions
                .insert(session_id.to_string(), subagent_session_ids.clone());
        }
        for subagent_session_id in &subagent_session_ids {
            self.coordinator
                .ensure_session_execution_drained(
                    subagent_session_id,
                    deadline.saturating_duration_since(Instant::now()),
                )
                .await?;
        }
        self.coordinator
            .ensure_session_execution_drained(
                session_id,
                deadline.saturating_duration_since(Instant::now()),
            )
            .await?;
        self.maintenance_background_sessions.remove(session_id);
        let scheduler_turn_id = self.retire_active_turn_for_maintenance(session_id);
        for retired_turn_id in [cancelled_turn_id, scheduler_turn_id].into_iter().flatten() {
            if !retired_turn_ids.contains(&retired_turn_id) {
                retired_turn_ids.push(retired_turn_id);
            }
        }
        Ok(SessionMaintenancePermit {
            _operation_guard: operation_guard,
            retired_turn_ids,
        })
    }

    pub(crate) async fn begin_session_deletion(
        &self,
        session_id: &str,
        requested_storage_path: &std::path::Path,
        wait_timeout: Duration,
    ) -> OpenBitFunResult<SessionMaintenancePermit> {
        let permit = self
            .begin_session_maintenance(session_id, requested_storage_path, wait_timeout)
            .await?;
        self.round_injection_buffer.clear(session_id);
        Ok(permit)
    }

    fn retire_active_turn_for_maintenance(&self, session_id: &str) -> Option<String> {
        let Some(active_turn) = self.active_turns.remove(session_id) else {
            return None;
        };
        let turn_id = active_turn.turn_id().to_string();
        self.retired_maintenance_outcomes.mark(session_id, &turn_id);
        self.active_turn_retired.notify_waiters();
        self.active_internal_turns.remove(session_id);
        self.round_injection_buffer
            .drain_for_turn(session_id, &turn_id);
        self.take_suppressed_cancelled_reply(session_id, &turn_id);
        debug!(
            "Retired active turn before destructive session maintenance: session_id={}, turn_id={}",
            session_id, turn_id
        );
        Some(turn_id)
    }

    // ── Private helpers ──────────────────────────────────────────────────────

    fn enqueue(&self, session_id: &str, queued_turn: QueuedTurn) -> Result<(), String> {
        let priority = queued_turn.policy.queue_priority;
        let new_len = match self.queues.enqueue(session_id, queued_turn, priority) {
            Ok(new_len) => new_len,
            Err(error) => {
                let max_depth = self.queues.max_depth();
                warn!(
                    "Queue full, rejecting message: session_id={}, max={}",
                    session_id, max_depth
                );
                return Err(error.to_string());
            }
        };

        debug!(
            "Message queued: session_id={}, queue_depth={}, priority={:?}",
            session_id, new_len, priority
        );
        Ok(())
    }

    async fn clear_queue(&self, session_id: &str) -> Vec<String> {
        let cleared_turns = self.queues.clear(session_id);
        let count = cleared_turns.len();
        let mut retired_turn_ids = Vec::new();
        for queued_turn in cleared_turns {
            match queued_turn.execution {
                QueuedTurnExecution::Standard | QueuedTurnExecution::FreshExternalSubagent(_) => {
                    if let Some(turn_id) = queued_turn.turn_id {
                        retired_turn_ids.push(turn_id.clone());
                        self.coordinator
                            .emit_event(AgenticEvent::DialogTurnCancelled {
                                session_id: session_id.to_string(),
                                turn_id,
                            })
                            .await;
                    } else {
                        warn!(
                            "Cleared queued dialog turn without a turn id: session_id={session_id}"
                        );
                    }
                }
                QueuedTurnExecution::HiddenSubagent(execution) => {
                    let coordinator = self.coordinator.clone();
                    tokio::spawn(async move {
                        coordinator
                            .cleanup_prepared_hidden_subagent_session_if_unsubmitted(
                                &execution.request,
                            )
                            .await;
                        execution.result_tx.send(Err(OpenBitFunError::Cancelled(
                            "Subagent task was cancelled because a previous queued turn failed"
                                .to_string(),
                        )));
                    });
                }
            }
        }
        if count > 0 {
            info!(
                "Cleared {} queued messages: session_id={}",
                count, session_id
            );
        }
        retired_turn_ids
    }

    fn dequeue_next(&self, session_id: &str) -> Option<QueuedTurn> {
        self.queues.dequeue_next(session_id)
    }

    fn requeue_front(&self, session_id: &str, turn: QueuedTurn) {
        let priority = turn.policy.queue_priority;
        self.queues.requeue_front(session_id, turn, priority);
    }

    async fn try_start_next_queued(
        &self,
        session_id: &str,
    ) -> Result<Option<String>, SchedulerSubmitError> {
        let _operation_guard = self.lock_session_operation(session_id).await;
        self.try_start_next_queued_locked(session_id).await
    }

    async fn try_start_next_queued_locked(
        &self,
        session_id: &str,
    ) -> Result<Option<String>, SchedulerSubmitError> {
        let state = self
            .session_manager
            .get_session(session_id)
            .map(|s| s.state.clone());
        if matches!(state, Some(SessionState::Processing { .. })) {
            return Ok(None);
        }
        if self
            .session_manager
            .latest_dialog_turn_holds_dispatch(session_id)
            .await?
        {
            return Ok(None);
        }

        let Some(next_turn) = self.dequeue_next(session_id) else {
            return Ok(None);
        };

        let remaining = self.queues.depth(session_id);
        info!(
            "Dispatching queued message: session_id={}, priority={:?}, remaining_queue_depth={}",
            session_id, next_turn.policy.queue_priority, remaining
        );

        match self.start_turn(session_id, &next_turn).await {
            Ok(tid) => Ok(Some(tid)),
            Err(err) => {
                self.requeue_front(session_id, next_turn);
                Err(err)
            }
        }
    }

    async fn start_turn(
        &self,
        session_id: &str,
        queued_turn: &QueuedTurn,
    ) -> Result<String, SchedulerSubmitError> {
        match &queued_turn.execution {
            QueuedTurnExecution::HiddenSubagent(execution) => {
                return self
                    .start_hidden_subagent_turn(session_id, queued_turn, execution)
                    .await
                    .map_err(SchedulerSubmitError::Message);
            }
            QueuedTurnExecution::FreshExternalSubagent(execution) => {
                self.coordinator
                    .start_external_subagent_delegation_turn(
                        session_id.to_string(),
                        queued_turn.user_input.clone(),
                        queued_turn.original_user_input.clone(),
                        queued_turn.turn_id.clone(),
                        queued_turn.agent_type.clone(),
                        queued_turn.workspace_path.clone(),
                        queued_turn.policy,
                        queued_turn.user_message_metadata.clone(),
                        execution.ecosystem_id.clone(),
                        execution.logical_id.clone(),
                    )
                    .await
                    .map_err(SchedulerSubmitError::Core)?;

                let resolved = queued_turn.turn_id.clone().ok_or_else(|| {
                    format!(
                        "Scheduled external subagent delegation is missing turn_id: session_id={session_id}"
                    )
                })?;
                self.active_turns.insert(
                    session_id,
                    ActiveDialogTurn::new(
                        resolved.clone(),
                        queued_turn.workspace_path.clone(),
                        None,
                        None,
                        queued_turn.agent_type.clone(),
                        queued_turn
                            .original_user_input
                            .clone()
                            .unwrap_or_else(|| queued_turn.user_input.clone()),
                        queued_turn.user_message_metadata.clone(),
                        queued_turn.policy,
                        queued_turn.reply_route.clone(),
                    ),
                );
                return Ok(resolved);
            }
            QueuedTurnExecution::Standard => {}
        }

        let images = queued_turn
            .image_contexts
            .as_ref()
            .filter(|imgs| !imgs.is_empty());
        let route = resolve_dialog_start_route(DialogStartRouteFacts {
            has_image_contexts: images.is_some(),
            has_prepended_messages: !queued_turn.prepended_messages.is_empty(),
        });

        let res = match route {
            DialogStartRoute::Plain => {
                self.coordinator
                    .start_dialog_turn(
                        session_id.to_string(),
                        queued_turn.user_input.clone(),
                        queued_turn.original_user_input.clone(),
                        queued_turn.turn_id.clone(),
                        queued_turn.agent_type.clone(),
                        queued_turn.workspace_path.clone(),
                        queued_turn.remote_connection_id.clone(),
                        queued_turn.remote_ssh_host.clone(),
                        queued_turn.policy,
                        queued_turn.user_message_metadata.clone(),
                    )
                    .await
            }
            DialogStartRoute::WithPrependedMessages => {
                self.coordinator
                    .start_dialog_turn_with_prepended_messages(
                        session_id.to_string(),
                        queued_turn.user_input.clone(),
                        queued_turn.original_user_input.clone(),
                        queued_turn.turn_id.clone(),
                        queued_turn.agent_type.clone(),
                        queued_turn.workspace_path.clone(),
                        queued_turn.remote_connection_id.clone(),
                        queued_turn.remote_ssh_host.clone(),
                        queued_turn.policy,
                        queued_turn.user_message_metadata.clone(),
                        queued_turn.prepended_messages.clone(),
                    )
                    .await
            }
            DialogStartRoute::WithImageContexts => {
                self.coordinator
                    .start_dialog_turn_with_image_contexts(
                        session_id.to_string(),
                        queued_turn.user_input.clone(),
                        queued_turn.original_user_input.clone(),
                        images
                            .cloned()
                            .expect("image-context route requires image contexts"),
                        queued_turn.turn_id.clone(),
                        queued_turn.agent_type.clone(),
                        queued_turn.workspace_path.clone(),
                        queued_turn.remote_connection_id.clone(),
                        queued_turn.remote_ssh_host.clone(),
                        queued_turn.policy,
                        queued_turn.user_message_metadata.clone(),
                    )
                    .await
            }
            DialogStartRoute::WithImageContextsAndPrependedMessages => {
                self.coordinator
                    .start_dialog_turn_with_image_contexts_and_prepended_messages(
                        session_id.to_string(),
                        queued_turn.user_input.clone(),
                        queued_turn.original_user_input.clone(),
                        images
                            .cloned()
                            .expect("image-context route requires image contexts"),
                        queued_turn.turn_id.clone(),
                        queued_turn.agent_type.clone(),
                        queued_turn.workspace_path.clone(),
                        queued_turn.remote_connection_id.clone(),
                        queued_turn.remote_ssh_host.clone(),
                        queued_turn.policy,
                        queued_turn.user_message_metadata.clone(),
                        queued_turn.prepended_messages.clone(),
                    )
                    .await
            }
        };

        res.map_err(SchedulerSubmitError::Core)?;

        // Standard scheduler submissions resolve and persist their turn ID
        // before entering the coordinator. Reading SessionState here races a
        // very fast terminal transition and can incorrectly turn an accepted,
        // completed turn into a submit error.
        let resolved = queued_turn.turn_id.clone().ok_or_else(|| {
            format!("Scheduled dialog turn is missing turn_id: session_id={session_id}")
        })?;

        self.active_turns.insert(
            session_id,
            ActiveDialogTurn::new(
                resolved.clone(),
                queued_turn.workspace_path.clone(),
                queued_turn.remote_connection_id.clone(),
                queued_turn.remote_ssh_host.clone(),
                queued_turn.agent_type.clone(),
                queued_turn
                    .original_user_input
                    .clone()
                    .unwrap_or_else(|| queued_turn.user_input.clone()),
                queued_turn.user_message_metadata.clone(),
                queued_turn.policy,
                queued_turn.reply_route.clone(),
            ),
        );

        Ok(resolved)
    }

    async fn start_hidden_subagent_turn(
        &self,
        session_id: &str,
        queued_turn: &QueuedTurn,
        execution: &HiddenSubagentQueuedExecution,
    ) -> Result<String, String> {
        let turn_id = queued_turn
            .turn_id
            .clone()
            .ok_or_else(|| "hidden subagent queued turn is missing turn_id".to_string())?;
        let request = execution.request.clone();
        let parent_cancel_token = request.parent_dialog_turn_id().and_then(|turn_id| {
            self.coordinator
                .execution_cancel_token_for_dialog_turn(turn_id)
                .map(|token| token.child_token())
        });
        let timeout_seconds = execution.timeout_seconds;
        let result_tx = execution.result_tx.clone();
        let coordinator = self.coordinator.clone();
        let outcome_tx = self.outcome_tx.clone();
        let session_id_owned = session_id.to_string();
        let turn_id_for_task = turn_id.clone();

        if execution.cancellation.is_cancelled() {
            self.coordinator
                .cleanup_prepared_hidden_subagent_session_if_unsubmitted(&execution.request)
                .await;
            // This path can run while the caller holds the session operation
            // permit. The lifecycle channel is unbounded so retirement never
            // waits for the receiver to acquire that same permit.
            let _ = outcome_tx.send((
                session_id_owned,
                TurnOutcome::Cancelled {
                    turn_id: turn_id_for_task,
                },
            ));
            result_tx.send(Err(OpenBitFunError::Cancelled(
                "Subagent task has been cancelled".to_string(),
            )));
            return Ok(turn_id);
        }

        let queue_cancel_token = execution.cancellation.child_token();
        let execution_cancel_token = CancellationToken::new();
        let queue_cancel_token_for_bridge = queue_cancel_token.clone();
        let execution_cancel_token_for_bridge = execution_cancel_token.clone();
        let cancel_bridge_handle = match parent_cancel_token {
            Some(parent_cancel_token) => tokio::spawn(async move {
                tokio::select! {
                    _ = parent_cancel_token.cancelled() => {
                        execution_cancel_token_for_bridge.cancel();
                    }
                    _ = queue_cancel_token_for_bridge.cancelled() => {
                        execution_cancel_token_for_bridge.cancel();
                    }
                }
            }),
            None => tokio::spawn(async move {
                queue_cancel_token_for_bridge.cancelled().await;
                execution_cancel_token_for_bridge.cancel();
            }),
        };

        self.active_turns.insert(
            session_id,
            ActiveDialogTurn::new(
                turn_id.clone(),
                queued_turn.workspace_path.clone(),
                queued_turn.remote_connection_id.clone(),
                queued_turn.remote_ssh_host.clone(),
                queued_turn.agent_type.clone(),
                queued_turn
                    .original_user_input
                    .clone()
                    .unwrap_or_else(|| queued_turn.user_input.clone()),
                queued_turn.user_message_metadata.clone(),
                queued_turn.policy,
                queued_turn.reply_route.clone(),
            ),
        );
        self.active_internal_turns
            .insert(session_id.to_string(), ActiveInternalTurn::HiddenSubagent);

        tokio::spawn(async move {
            let outcome = coordinator
                .execute_prepared_hidden_subagent(
                    request,
                    Some(&execution_cancel_token),
                    timeout_seconds,
                )
                .await;
            match outcome {
                Ok(result) => {
                    let _ = outcome_tx.send((
                        session_id_owned.clone(),
                        TurnOutcome::Completed {
                            turn_id: turn_id_for_task.clone(),
                            final_response: result.text.clone(),
                        },
                    ));
                    result_tx.send(Ok(result));
                }
                Err(OpenBitFunError::Cancelled(error_text)) => {
                    let _ = outcome_tx.send((
                        session_id_owned.clone(),
                        TurnOutcome::Cancelled {
                            turn_id: turn_id_for_task.clone(),
                        },
                    ));
                    result_tx.send(Err(OpenBitFunError::Cancelled(error_text)));
                }
                Err(error) => {
                    let error_text = error.to_string();
                    let _ = outcome_tx.send((
                        session_id_owned.clone(),
                        TurnOutcome::Failed {
                            turn_id: turn_id_for_task.clone(),
                            error: error_text.clone(),
                        },
                    ));
                    result_tx.send(Err(error));
                }
            }
            cancel_bridge_handle.abort();
        });

        Ok(turn_id)
    }

    async fn forward_agent_session_reply(
        &self,
        responder_session_id: &str,
        plan: AgentSessionReplyPlan,
    ) {
        let reply_user_input = plan.user_input;
        let target_session_id = plan.target_session_id;
        let target_workspace_path = plan.target_workspace_path;
        let target_remote_connection_id = plan.target_remote_connection_id;
        let target_remote_ssh_host = plan.target_remote_ssh_host;
        let prepended_messages = vec![Message::internal_reminder(
            InternalReminderKind::SessionMessageReply,
            plan.reminder_text,
        )];
        let user_message_metadata = plan.user_message_metadata;

        if let Err(error) = self
            .submit_with_prepended_messages(
                target_session_id.clone(),
                reply_user_input.clone(),
                Some(reply_user_input),
                None,
                String::new(),
                Some(target_workspace_path),
                target_remote_connection_id,
                target_remote_ssh_host,
                DialogSubmissionPolicy::for_source(DialogTriggerSource::AgentSession),
                None,
                user_message_metadata,
                prepended_messages,
                None,
            )
            .await
        {
            warn!(
                "Failed to forward agent-session reply: responder_session_id={}, source_session_id={}, error={}",
                responder_session_id, target_session_id, error
            );
        }
    }

    fn take_suppressed_cancelled_reply(&self, session_id: &str, turn_id: &str) -> bool {
        self.suppressed_cancelled_replies.take(session_id, turn_id)
    }

    async fn dispatch_next_if_idle(&self, session_id: &str) -> Result<(), String> {
        let _ = self
            .try_start_next_queued(session_id)
            .await
            .map_err(|error| error.to_string())?;
        Ok(())
    }

    /// Background loop that receives turn outcome notifications from the coordinator.
    async fn run_outcome_handler(
        &self,
        mut outcome_rx: mpsc::UnboundedReceiver<(String, TurnOutcome)>,
    ) {
        while let Some((session_id, outcome)) = outcome_rx.recv().await {
            let (active_turn, active_internal_turn, lifecycle_plan) = {
                let _operation_guard = self.lock_session_operation(&session_id).await;
                let Some(active_turn_result) = take_active_turn_for_outcome(
                    &self.active_turns,
                    &self.retired_maintenance_outcomes,
                    &session_id,
                    outcome.turn_id(),
                ) else {
                    self.round_injection_buffer
                        .drain_for_turn(&session_id, outcome.turn_id());
                    self.take_suppressed_cancelled_reply(&session_id, outcome.turn_id());
                    debug!(
                        "Ignoring outcome retired by session deletion: session_id={}, turn_id={}",
                        session_id,
                        outcome.turn_id()
                    );
                    continue;
                };
                let active_turn = match active_turn_result {
                    ActiveDialogTurnTakeResult::Matched(turn) => {
                        self.active_turn_retired.notify_waiters();
                        Some(turn)
                    }
                    ActiveDialogTurnTakeResult::Absent => None,
                    ActiveDialogTurnTakeResult::DifferentTurn => {
                        self.round_injection_buffer
                            .drain_for_turn(&session_id, outcome.turn_id());
                        self.take_suppressed_cancelled_reply(&session_id, outcome.turn_id());
                        debug!(
                            "Ignoring stale turn outcome: session_id={}, turn_id={}",
                            session_id,
                            outcome.turn_id()
                        );
                        continue;
                    }
                };
                let active_internal_turn = active_turn.as_ref().and_then(|_| {
                    self.active_internal_turns
                        .remove(&session_id)
                        .map(|(_, turn)| turn)
                });
                let lifecycle_plan =
                    resolve_turn_outcome_lifecycle_plan(&outcome, active_turn.is_some());
                if lifecycle_plan.queue_action == TurnOutcomeQueueAction::ClearQueue {
                    debug!(
                        "Turn {}, clearing queue: session_id={}",
                        lifecycle_plan.status, session_id
                    );
                    let _ = self.clear_queue(&session_id).await;
                }
                (active_turn, active_internal_turn, lifecycle_plan)
            };
            let status = lifecycle_plan.status;
            let queue_action = lifecycle_plan.queue_action;
            // Only drop steering messages targeted at the *finished* turn. We
            // must NOT clear the entire session buffer here: a user might have
            // legitimately submitted steering against a brand-new follow-up
            // turn that the dispatcher will pick up immediately after this
            // outcome is processed (race window between turn finalize and the
            // next turn starting). Targeting by turn_id keeps those alive.
            if lifecycle_plan.drain_finished_turn_injections {
                self.round_injection_buffer
                    .drain_for_turn(&session_id, outcome.turn_id());
            } else if status == TurnOutcomeStatus::Interrupted {
                self.round_injection_buffer
                    .discard_current_running(&session_id);
            }
            let suppressed_cancelled_reply =
                self.take_suppressed_cancelled_reply(&session_id, outcome.turn_id());
            let is_internal_turn = active_internal_turn.is_some();
            if !is_internal_turn {
                if let Some(active_turn) = active_turn.as_ref() {
                    match resolve_agent_session_reply_action(
                        &session_id,
                        active_turn,
                        &outcome,
                        suppressed_cancelled_reply,
                    ) {
                        AgentSessionReplyAction::NoReply => {}
                        AgentSessionReplyAction::SkipSuppressedCancelledReply => {
                            debug!(
                            "Skipping cancelled auto-reply because the source session explicitly cancelled its own SessionMessage request: session_id={}, turn_id={}",
                            session_id,
                            outcome.turn_id()
                        );
                        }
                        AgentSessionReplyAction::Forward(plan) => {
                            self.forward_agent_session_reply(&session_id, plan).await;
                        }
                    }
                }
            }

            if !is_internal_turn {
                if let Some(active_turn) = active_turn.as_ref() {
                    match lifecycle_plan.goal_continuation {
                        GoalContinuationAfterTurnAction::SkipNoActiveTurn => {}
                        GoalContinuationAfterTurnAction::AbortForCancelled => {
                            self.goal_continuation_abort.mark(&session_id);
                            debug!(
                            "Skipping thread goal continuation after user-cancelled turn: session_id={}, turn_id={}",
                            session_id,
                            outcome.turn_id()
                        );
                        }
                        GoalContinuationAfterTurnAction::AbortForInterrupted => {
                            self.goal_continuation_abort.mark(&session_id);
                            debug!(
                                "Holding thread goal continuation after interrupted turn: session_id={}, turn_id={}",
                                session_id,
                                outcome.turn_id()
                            );
                        }
                        GoalContinuationAfterTurnAction::Evaluate { turn_completed } => {
                            self.goal_continuation_abort.clear(&session_id);
                            match self
                                .coordinator
                                .prepare_goal_continuation_after_turn(
                                    &session_id,
                                    outcome.turn_id(),
                                    active_turn.user_input(),
                                    active_turn.user_message_metadata(),
                                    turn_completed,
                                )
                                .await
                            {
                                Ok(Some(plan)) => {
                                    let prepended: Vec<Message> = plan
                                        .prepended_reminders
                                        .into_iter()
                                        .map(|text| {
                                            Message::internal_reminder(
                                                InternalReminderKind::GoalContinuation,
                                                text,
                                            )
                                        })
                                        .collect();
                                    let mut last_error = None;
                                    for attempt in 1..=MAX_THREAD_GOAL_AUTO_CONTINUATIONS {
                                        if self.goal_continuation_abort.contains(&session_id) {
                                            debug!(
                                        "Aborting goal continuation submit retries after user cancellation: session_id={}",
                                        session_id
                                    );
                                            break;
                                        }
                                        match self
                                            .submit_with_prepended_messages(
                                                session_id.clone(),
                                                "Continue working toward the active thread goal."
                                                    .to_string(),
                                                Some(plan.display_message.clone()),
                                                None,
                                                active_turn.agent_type_owned(),
                                                active_turn.workspace_path_owned(),
                                                active_turn.remote_connection_id_owned(),
                                                active_turn.remote_ssh_host_owned(),
                                                DialogSubmissionPolicy::for_source(
                                                    DialogTriggerSource::AgentSession,
                                                ),
                                                None,
                                                Some(plan.user_message_metadata.clone()),
                                                prepended.clone(),
                                                None,
                                            )
                                            .await
                                        {
                                            Ok(_) => {
                                                last_error = None;
                                                break;
                                            }
                                            Err(error) => {
                                                last_error = Some(error);
                                                if self
                                                    .goal_continuation_abort
                                                    .contains(&session_id)
                                                {
                                                    debug!(
                                                "Aborting goal continuation submit retries after user cancellation: session_id={}",
                                                session_id
                                            );
                                                    break;
                                                }
                                                if attempt < MAX_THREAD_GOAL_AUTO_CONTINUATIONS {
                                                    let delay_ms =
                                                        goal_continuation_submit_retry_delay_ms(
                                                            attempt,
                                                        );
                                                    warn!(
                                                "Goal continuation submit failed; retrying: session_id={}, attempt={}/{}, delay_ms={}, error={}",
                                                session_id,
                                                attempt,
                                                MAX_THREAD_GOAL_AUTO_CONTINUATIONS,
                                                delay_ms,
                                                last_error.as_ref().unwrap()
                                            );
                                                    tokio::time::sleep(
                                                        std::time::Duration::from_millis(delay_ms),
                                                    )
                                                    .await;
                                                }
                                            }
                                        }
                                    }
                                    if let Some(error) = last_error {
                                        if !self.goal_continuation_abort.contains(&session_id) {
                                            warn!(
                                        "Failed to submit goal continuation turn after retries: session_id={}, error={}",
                                        session_id, error
                                    );
                                        }
                                    }
                                }
                                Ok(None) => {}
                                Err(error) => {
                                    warn!(
                                "Goal verification failed after turn stopped: session_id={}, status={}, error={}",
                                session_id, status, error
                            );
                                }
                            }
                        }
                    }
                }
            }

            match queue_action {
                TurnOutcomeQueueAction::DispatchNext => {
                    if status == TurnOutcomeStatus::Cancelled {
                        debug!(
                            "Turn cancelled, dispatching next queued message if present: session_id={}",
                            session_id
                        );
                    }

                    if let Err(e) = self.dispatch_next_if_idle(&session_id).await {
                        warn!(
                            "Failed to dispatch next queued message after {}: session_id={}, error={}",
                            status, session_id, e
                        );
                    }
                }
                TurnOutcomeQueueAction::HoldQueue => {
                    match self
                        .session_manager
                        .latest_dialog_turn_holds_dispatch(&session_id)
                        .await
                    {
                        Ok(true) => debug!(
                            "Turn interrupted, holding queued messages until recovery or a new user turn: session_id={}",
                            session_id
                        ),
                        Ok(false) => {
                            // An explicit user submission can abandon recovery
                            // after the coordinator has settled Idle but before
                            // this outcome retires the previous active entry.
                            if let Err(error) = self.dispatch_next_if_idle(&session_id).await {
                                warn!(
                                    "Failed to dispatch queue after interrupted hold was released: session_id={}, error={}",
                                    session_id, error
                                );
                            }
                        }
                        Err(error) => warn!(
                            "Failed to verify interrupted queue hold; keeping queued work parked: session_id={}, error={}",
                            session_id, error
                        ),
                    }
                }
                TurnOutcomeQueueAction::ClearQueue => {}
            }
        }
    }
}

fn metadata_string(
    metadata: &serde_json::Map<String, serde_json::Value>,
    key: &str,
) -> Option<String> {
    metadata
        .get(key)
        .and_then(|value| value.as_str())
        .filter(|value| !value.is_empty())
        .map(ToOwned::to_owned)
}

fn mime_type_from_data_url(data_url: &str) -> Option<String> {
    data_url
        .split_once(',')
        .and_then(|(header, _)| {
            header
                .strip_prefix("data:")
                .and_then(|rest| rest.split(';').next())
        })
        .filter(|value| !value.is_empty())
        .map(ToOwned::to_owned)
}

fn image_context_metadata(attachment: &AgentInputAttachment) -> Option<serde_json::Value> {
    if let Some(metadata) = attachment.metadata.get("metadata").cloned() {
        return Some(metadata);
    }

    let mut metadata = serde_json::Map::new();
    if let Some(name) = metadata_string(&attachment.metadata, "name") {
        metadata.insert("name".to_string(), serde_json::Value::String(name));
    }
    if attachment.metadata.contains_key("dataUrl") {
        metadata.insert(
            "source".to_string(),
            serde_json::Value::String("remote".to_string()),
        );
    }

    if metadata.is_empty() {
        None
    } else {
        Some(serde_json::Value::Object(metadata))
    }
}

pub(crate) fn agent_dialog_turn_image_contexts(
    attachments: &[AgentInputAttachment],
) -> PortResult<Option<Vec<ImageContextData>>> {
    if attachments.is_empty() {
        return Ok(None);
    }

    let mut image_contexts = Vec::with_capacity(attachments.len());
    for attachment in attachments {
        if attachment.kind != "remote_image" {
            return Err(PortError::new(
                PortErrorKind::InvalidRequest,
                format!(
                    "unsupported agent dialog attachment kind: {}",
                    attachment.kind
                ),
            ));
        }

        let data_url = metadata_string(&attachment.metadata, "dataUrl");
        let image_path = metadata_string(&attachment.metadata, "imagePath");
        if data_url.is_none() && image_path.is_none() {
            return Err(PortError::new(
                PortErrorKind::InvalidRequest,
                "remote_image attachment requires dataUrl or imagePath",
            ));
        }

        let mime_type = metadata_string(&attachment.metadata, "mimeType")
            .or_else(|| data_url.as_deref().and_then(mime_type_from_data_url))
            .unwrap_or_else(|| "image/png".to_string());

        image_contexts.push(ImageContextData {
            id: attachment.id.clone(),
            image_path,
            data_url,
            mime_type,
            metadata: image_context_metadata(attachment),
        });
    }

    Ok(Some(image_contexts))
}

fn agent_dialog_turn_prepended_messages(
    reminders: &[AgentDialogPrependedReminder],
) -> PortResult<Vec<Message>> {
    reminders
        .iter()
        .map(|reminder| {
            let kind = match reminder.kind.as_str() {
                "session_message_request" => InternalReminderKind::SessionMessageRequest,
                "scheduled_job" => InternalReminderKind::ScheduledJob,
                other => {
                    return Err(PortError::new(
                        PortErrorKind::InvalidRequest,
                        format!("unsupported agent dialog prepended reminder kind: {other}"),
                    ));
                }
            };
            Ok(Message::internal_reminder(kind, reminder.text.clone()))
        })
        .collect()
}

fn agent_dialog_turn_metadata(
    mut metadata: serde_json::Map<String, serde_json::Value>,
    output_schema: Option<serde_json::Value>,
) -> PortResult<Option<serde_json::Value>> {
    metadata.remove(openbitfun_runtime_ports::OUTPUT_SCHEMA_CONTEXT_KEY);
    if let Some(output_schema) = output_schema {
        if !output_schema.is_object() {
            return Err(PortError::new(
                PortErrorKind::InvalidRequest,
                "Output schema must be a JSON object",
            ));
        }
        metadata.insert(
            openbitfun_runtime_ports::OUTPUT_SCHEMA_CONTEXT_KEY.to_string(),
            output_schema,
        );
    }

    Ok((!metadata.is_empty()).then_some(serde_json::Value::Object(metadata)))
}

impl DialogScheduler {
    pub(crate) async fn submit_agent_dialog_turn_reject_if_busy(
        &self,
        request: AgentDialogTurnRequest,
    ) -> PortResult<DialogSubmitOutcome> {
        self.submit_agent_dialog_turn_with_busy_policy(request, true)
            .await
    }

    async fn submit_agent_dialog_turn_with_busy_policy(
        &self,
        request: AgentDialogTurnRequest,
        reject_if_busy: bool,
    ) -> PortResult<DialogSubmitOutcome> {
        let (execution, reject_if_busy) = match &request.execution {
            AgentDialogTurnExecution::Standard => (QueuedTurnExecution::Standard, reject_if_busy),
            AgentDialogTurnExecution::FreshExternalSubagent {
                ecosystem_id,
                logical_id,
            } => {
                if ecosystem_id.trim().is_empty() || logical_id.trim().is_empty() {
                    return Err(PortError::new(
                        PortErrorKind::InvalidRequest,
                        "External subagent delegation requires non-empty ecosystem_id and logical_id",
                    ));
                }
                if !request.attachments.is_empty() || !request.prepended_reminders.is_empty() {
                    return Err(PortError::new(
                        PortErrorKind::InvalidRequest,
                        "External subagent delegation does not accept attachments or prepended reminders",
                    ));
                }
                if self
                    .coordinator
                    .get_session_manager()
                    .get_session(&request.session_id)
                    .is_some_and(|session| session.config.is_remote_workspace())
                {
                    return Err(PortError::new(
                        PortErrorKind::NotAvailable,
                        "External subagent delegation is unavailable for remote workspaces",
                    ));
                }
                (
                    QueuedTurnExecution::FreshExternalSubagent(
                        ExternalSubagentDelegationQueuedExecution {
                            ecosystem_id: ecosystem_id.trim().to_string(),
                            logical_id: logical_id.trim().to_string(),
                        },
                    ),
                    true,
                )
            }
        };
        let image_contexts = agent_dialog_turn_image_contexts(&request.attachments)?;
        let prepended_messages =
            agent_dialog_turn_prepended_messages(&request.prepended_reminders)?;
        let user_message_metadata =
            agent_dialog_turn_metadata(request.metadata, request.output_schema)?;
        let resolved_turn_id = request
            .turn_id
            .unwrap_or_else(|| uuid::Uuid::new_v4().to_string());
        let settlement_registration = self
            .coordinator
            .try_register_turn_settlement(&request.session_id, &resolved_turn_id)
            .ok_or_else(|| {
                PortError::new(
                    PortErrorKind::InvalidRequest,
                    format!(
                        "Dialog turn ID is already active or completed: session_id={}, turn_id={resolved_turn_id}",
                        request.session_id
                    ),
                )
            })?;
        let queued_turn = QueuedTurn {
            user_input: request.message,
            original_user_input: request.original_message,
            prepended_messages,
            turn_id: Some(resolved_turn_id.clone()),
            agent_type: request.agent_type,
            workspace_path: request.workspace_path,
            workspace_id: request.workspace_id,
            remote_connection_id: request.remote_connection_id,
            remote_ssh_host: request.remote_ssh_host,
            policy: request.policy,
            reply_route: request.reply_route,
            user_message_metadata,
            image_contexts,
            enqueued_at: SystemTime::now(),
            _settlement_registration: Some(settlement_registration),
            execution,
        };

        self.submit_queued_turn(
            request.session_id,
            resolved_turn_id,
            queued_turn,
            reject_if_busy,
        )
        .await
        .map_err(SchedulerSubmitError::into_port_error)
    }
}

#[async_trait::async_trait]
impl AgentDialogTurnPort for DialogScheduler {
    async fn submit_dialog_turn(
        &self,
        request: AgentDialogTurnRequest,
    ) -> PortResult<DialogSubmitOutcome> {
        self.submit_agent_dialog_turn_with_busy_policy(request, false)
            .await
    }

    async fn steer_dialog_turn(
        &self,
        request: AgentDialogSteerRequest,
    ) -> PortResult<DialogSteerOutcome> {
        // An empty-but-attachment-free message and a malformed attachment are
        // both bad requests; only a live-turn mismatch means "session in use".
        let invalid_request = request.content.trim().is_empty() && request.attachments.is_empty()
            || agent_dialog_turn_image_contexts(&request.attachments).is_err();
        DialogScheduler::buffer_steering(
            self,
            request.session_id,
            request.turn_id,
            request.content,
            request.display_content,
            request.attachments,
            request.metadata,
        )
        .await
        .map_err(|error| {
            PortError::new(
                if invalid_request {
                    PortErrorKind::InvalidRequest
                } else {
                    PortErrorKind::SessionInUse
                },
                error,
            )
        })
    }

    async fn recover_interrupted_turn(
        &self,
        request: openbitfun_runtime_ports::AgentDialogTurnRecoveryRequest,
    ) -> PortResult<openbitfun_runtime_ports::AgentDialogTurnRecoveryOutcome> {
        let deadline = Instant::now() + Duration::from_secs(30);
        loop {
            let mut retired = Box::pin(self.active_turn_retired.notified());
            retired.as_mut().enable();
            let operation_guard = self.lock_session_operation(&request.session_id).await;
            let session = self
                .session_manager
                .get_session(&request.session_id)
                .ok_or_else(|| {
                    PortError::new(
                        PortErrorKind::NotFound,
                        format!("Session not found: {}", request.session_id),
                    )
                })?;
            if !self.active_turns.contains(&request.session_id) {
                let active_turn = ActiveDialogTurn::new(
                    request.turn_id.clone(),
                    request
                        .workspace_path
                        .clone()
                        .or_else(|| session.config.workspace_path.clone())
                        .or_else(|| session.config.project_workspace_path.clone()),
                    request.remote_connection_id.clone(),
                    request.remote_ssh_host.clone(),
                    session.agent_type.clone(),
                    String::new(),
                    None,
                    DialogSubmissionPolicy::for_source(DialogTriggerSource::DesktopUi),
                    None,
                );
                self.active_turns.insert(&request.session_id, active_turn);
                let active_admission = RecoveryActiveTurnAdmission {
                    active_turns: self.active_turns.clone(),
                    active_turn_retired: self.active_turn_retired.clone(),
                    session_id: request.session_id.clone(),
                    turn_id: request.turn_id.clone(),
                    armed: true,
                };
                let coordinator = self.coordinator.clone();
                let (recovery_tx, recovery_rx) = oneshot::channel();
                tokio::spawn(async move {
                    let mut active_admission = active_admission;
                    let outcome = coordinator.recover_interrupted_dialog_turn(&request).await;
                    if outcome.is_ok() {
                        active_admission.disarm();
                    }
                    let _ = recovery_tx.send(outcome);
                    drop(operation_guard);
                });
                let outcome = recovery_rx
                    .await
                    .map_err(|_| {
                        PortError::new(
                            PortErrorKind::OutcomeUnknown,
                            "Interrupted turn recovery admission ended without an outcome",
                        )
                    })?
                    .map_err(|error| {
                        PortError::new(
                            match error {
                                OpenBitFunError::Validation(_) => PortErrorKind::InvalidRequest,
                                OpenBitFunError::NotFound(_) => PortErrorKind::NotFound,
                                OpenBitFunError::Timeout(_) => PortErrorKind::Timeout,
                                _ => PortErrorKind::Backend,
                            },
                            error.to_string(),
                        )
                    })?;
                return Ok(outcome);
            }
            if !self
                .active_turns
                .matches_turn(&request.session_id, &request.turn_id)
            {
                return Err(PortError::new(
                    PortErrorKind::SessionInUse,
                    format!(
                        "A different dialog turn is active: session_id={}, requested_turn_id={}",
                        request.session_id, request.turn_id
                    ),
                ));
            }
            if !matches!(session.state, SessionState::Idle) {
                return Err(PortError::new(
                    PortErrorKind::SessionInUse,
                    format!(
                        "Session is still executing a dialog turn: {}",
                        request.session_id
                    ),
                ));
            }
            drop(operation_guard);

            let remaining = deadline.saturating_duration_since(Instant::now());
            if remaining.is_zero() || tokio::time::timeout(remaining, retired).await.is_err() {
                return Err(PortError::new(
                    PortErrorKind::Timeout,
                    format!(
                        "Previous interrupted turn generation did not retire in time: session_id={}, turn_id={}",
                        request.session_id, request.turn_id
                    ),
                ));
            }
        }
    }
}

#[async_trait::async_trait]
impl AgentLifecycleDeliveryPort for DialogScheduler {
    async fn deliver_background_result(
        &self,
        request: AgentBackgroundResultRequest,
    ) -> PortResult<()> {
        let metadata = if request.metadata.is_empty() {
            None
        } else {
            Some(serde_json::Value::Object(request.metadata))
        };

        DialogScheduler::deliver_background_result(
            self,
            request.session_id,
            request.agent_type,
            request.workspace_path,
            request.remote_connection_id,
            request.remote_ssh_host,
            request.content,
            request.display_content,
            metadata,
        )
        .await
        .map_err(|error| PortError::new(PortErrorKind::Backend, error))
    }

    async fn deliver_thread_goal(&self, request: AgentThreadGoalDeliveryRequest) -> PortResult<()> {
        let result = match request.kind {
            AgentThreadGoalDeliveryKind::Resumed => {
                DialogScheduler::deliver_thread_goal_resumed(
                    self,
                    request.session_id,
                    request.agent_type,
                    request.workspace_path,
                    request.remote_connection_id,
                    request.remote_ssh_host,
                    request.goal,
                )
                .await
            }
            AgentThreadGoalDeliveryKind::ObjectiveUpdated => {
                DialogScheduler::deliver_thread_goal_objective_updated(
                    self,
                    request.session_id,
                    request.agent_type,
                    request.workspace_path,
                    request.remote_connection_id,
                    request.remote_ssh_host,
                    request.goal,
                )
                .await
            }
        };

        result.map_err(|error| PortError::new(PortErrorKind::Backend, error))
    }
}

#[async_trait::async_trait]
impl AgentTurnCancellationPort for DialogScheduler {
    async fn cancel_turn(
        &self,
        request: AgentTurnCancellationRequest,
    ) -> PortResult<AgentTurnCancellationResult> {
        let session_id = request.session_id;
        let wait_timeout = Duration::from_millis(request.wait_timeout_ms.unwrap_or(1500));

        let cancelled_turn_id = if let Some(turn_id) = request.turn_id {
            self.cancel_queued_or_active_turn(&session_id, &turn_id)
                .await
                .map_err(|error| PortError::new(PortErrorKind::Backend, error.to_string()))?;
            Some(turn_id)
        } else if let Some(requester_session_id) = request.requester_session_id {
            self.cancel_active_turn_for_session_from_requester(
                &session_id,
                &requester_session_id,
                wait_timeout,
            )
            .await
            .map_err(|error| PortError::new(PortErrorKind::Backend, error.to_string()))?
        } else {
            self.cancel_active_turn_for_session_with_descendant_policy(
                &session_id,
                wait_timeout,
                request.cancel_descendants,
            )
            .await
            .map_err(|error| PortError::new(PortErrorKind::Backend, error.to_string()))?
        };

        Ok(AgentTurnCancellationResult {
            session_id,
            requested: cancelled_turn_id.is_some(),
            turn_id: cancelled_turn_id,
        })
    }

    async fn interrupt_turn(
        &self,
        request: openbitfun_runtime_ports::AgentTurnInterruptionRequest,
    ) -> PortResult<openbitfun_runtime_ports::AgentTurnInterruptionResult> {
        // Serialize the route check with submit/start registration. Without
        // this guard an AgentSession turn could be spawned just before its
        // reply route becomes visible in `active_turns` and then be recovered
        // without the route required to settle its requester.
        let _operation_guard = self.lock_session_operation(&request.session_id).await;
        if self
            .active_turns
            .matches_agent_session_request(&request.session_id, &request.turn_id)
        {
            return Err(PortError::new(
                PortErrorKind::InvalidRequest,
                "Agent-session request turns cannot be recoverably interrupted; cancel them instead",
            ));
        }
        let wait_timeout = Duration::from_millis(request.wait_timeout_ms.unwrap_or(30_000));
        self.coordinator
            .interrupt_dialog_turn(&request.session_id, &request.turn_id, wait_timeout)
            .await
            .map_err(|error| {
                PortError::new(
                    match error {
                        OpenBitFunError::Validation(_) => PortErrorKind::InvalidRequest,
                        OpenBitFunError::NotFound(_) => PortErrorKind::NotFound,
                        OpenBitFunError::Timeout(_) => PortErrorKind::Timeout,
                        _ => PortErrorKind::Backend,
                    },
                    error.to_string(),
                )
            })?;
        Ok(openbitfun_runtime_ports::AgentTurnInterruptionResult {
            session_id: request.session_id,
            turn_id: request.turn_id,
            requested: true,
        })
    }
}

fn thread_goal_delivery_messages(reminders: Vec<ThreadGoalDeliveryReminder>) -> Vec<Message> {
    reminders
        .into_iter()
        .map(|reminder| match reminder.kind {
            ThreadGoalDeliveryReminderKind::GoalContinuation => {
                goal_internal_context_message(reminder.content)
            }
            ThreadGoalDeliveryReminderKind::GoalObjectiveUpdated => {
                goal_objective_updated_message(reminder.content)
            }
        })
        .collect()
}

fn background_result_delivery_state_fact(
    session_id: &str,
    state: Option<&SessionState>,
    metadata: Option<&serde_json::Value>,
) -> DialogSessionStateFact {
    let Some(SessionState::Processing {
        current_turn_id, ..
    }) = state
    else {
        return DialogScheduler::session_state_fact(state);
    };
    let Some(metadata) = metadata.and_then(serde_json::Value::as_object) else {
        return DialogSessionStateFact::Processing;
    };
    let has_exact_parent =
        metadata.contains_key("parentSessionId") || metadata.contains_key("parentDialogTurnId");
    if !has_exact_parent {
        return DialogSessionStateFact::Processing;
    }

    let exact_parent_matches = metadata
        .get("parentSessionId")
        .and_then(serde_json::Value::as_str)
        .zip(
            metadata
                .get("parentDialogTurnId")
                .and_then(serde_json::Value::as_str),
        )
        .is_some_and(|(parent_session_id, parent_turn_id)| {
            parent_session_id == session_id && parent_turn_id == current_turn_id
        });
    if exact_parent_matches {
        DialogSessionStateFact::Processing
    } else {
        // The session is busy, but this result does not belong to the running turn.
        // Resolve it as a follow-up; the normal submission path will queue it.
        DialogSessionStateFact::Idle
    }
}

// ── Global instance ──────────────────────────────────────────────────────────

static GLOBAL_SCHEDULER: OnceLock<Arc<DialogScheduler>> = OnceLock::new();

pub fn get_global_scheduler() -> Option<Arc<DialogScheduler>> {
    GLOBAL_SCHEDULER.get().cloned()
}

pub fn set_global_scheduler(scheduler: Arc<DialogScheduler>) {
    let _ = GLOBAL_SCHEDULER.set(scheduler);
}

/// Stop in-flight thread-goal continuation submit retries when the user cancels a turn.
pub fn abort_thread_goal_continuation_for_session(session_id: &str) {
    if let Some(scheduler) = get_global_scheduler() {
        scheduler.goal_continuation_abort.mark(session_id);
    }
}

/// Allow goal auto-continuation again after the user explicitly resumes a paused goal.
pub fn clear_thread_goal_continuation_abort(session_id: &str) {
    if let Some(scheduler) = get_global_scheduler() {
        scheduler.goal_continuation_abort.clear(session_id);
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::agentic::core::{ProcessingPhase, SessionConfig};
    use crate::agentic::events::{EventQueue, EventQueueConfig, EventRouter};
    use crate::agentic::execution::{
        ExecutionEngine, ExecutionEngineConfig, RoundExecutor, StreamProcessor,
    };
    use crate::agentic::persistence::PersistenceManager;
    use crate::agentic::session::{
        compression::ContextCompressor,
        revert::{SessionRevertPhase, SessionRevertState, SESSION_REVERT_SCHEMA_VERSION},
        PromptCachePolicy, SessionContextStore, SessionManagerConfig,
        TEST_MODEL_RESOLUTION_AI_CONFIG,
    };
    use crate::agentic::tools::registry::ToolRegistry;
    use crate::agentic::tools::{ToolPipeline, ToolStateManager};
    use crate::infrastructure::ai::reasoning_catalog::reasoning_preset_runtime_fingerprint;
    use crate::infrastructure::PathManager;
    use crate::service::config::types::{
        model_runtime_binding_fingerprint, AIConfig, AIModelConfig,
    };
    use openbitfun_runtime_ports::{
        AgentDialogPrependedReminder, AgentInputAttachment, PortErrorKind, ThreadGoalStatus,
    };
    use tokio::sync::RwLock as TokioRwLock;

    #[test]
    fn scheduler_preserves_session_writer_conflicts() {
        let error = SchedulerSubmitError::Core(OpenBitFunError::SessionInUse {
            session_id: "session-1".to_string(),
        })
        .into_port_error();

        assert_eq!(error.kind, PortErrorKind::SessionInUse);
    }

    #[test]
    fn output_schema_field_owns_reserved_metadata_key() {
        let mut metadata = serde_json::Map::new();
        metadata.insert(
            openbitfun_runtime_ports::OUTPUT_SCHEMA_CONTEXT_KEY.to_string(),
            serde_json::json!({ "type": "string" }),
        );

        assert_eq!(
            agent_dialog_turn_metadata(metadata.clone(), None).unwrap(),
            None
        );

        let schema = serde_json::json!({ "type": "object" });
        let merged = agent_dialog_turn_metadata(metadata, Some(schema.clone())).unwrap();
        assert_eq!(
            merged
                .and_then(|value| value.as_object().cloned())
                .and_then(|metadata| metadata
                    .get(openbitfun_runtime_ports::OUTPUT_SCHEMA_CONTEXT_KEY)
                    .cloned()),
            Some(schema)
        );
    }

    #[test]
    fn output_schema_requires_an_object_root() {
        let error = agent_dialog_turn_metadata(
            serde_json::Map::new(),
            Some(serde_json::json!(["not", "an", "object"])),
        )
        .expect_err("array schema root must be rejected");

        assert_eq!(error.kind, PortErrorKind::InvalidRequest);
    }

    /// Creates a fixture workspace directory and registers it as a local
    /// workspace record. Sessions only exist inside registered workspaces, so
    /// path-only session configs naming it resolve like a host-opened folder.
    fn fixture_workspace_dir(path: PathBuf) -> PathBuf {
        std::fs::create_dir_all(&path).expect("workspace");
        crate::service::workspace::legacy_compat::register_local_fixture_blocking(&path);
        path
    }

    fn test_scheduler() -> (
        Arc<DialogScheduler>,
        Arc<SessionManager>,
        Arc<EventQueue>,
        tempfile::TempDir,
    ) {
        test_scheduler_with_persistence(false)
    }

    fn test_scheduler_with_persistence(
        enable_persistence: bool,
    ) -> (
        Arc<DialogScheduler>,
        Arc<SessionManager>,
        Arc<EventQueue>,
        tempfile::TempDir,
    ) {
        let root = tempfile::tempdir().expect("test root");
        let event_queue = Arc::new(EventQueue::new(EventQueueConfig::default()));
        let session_manager = Arc::new(SessionManager::new(
            Arc::new(SessionContextStore::new()),
            Arc::new(
                PersistenceManager::new(Arc::new(PathManager::with_user_root_for_tests(
                    root.path().join("user-root"),
                )))
                .expect("persistence manager"),
            ),
            SessionManagerConfig {
                max_active_sessions: 100,
                session_idle_timeout: Duration::from_secs(3600),
                auto_save_interval: Duration::from_secs(300),
                enable_persistence,
                prompt_cache_policy: PromptCachePolicy::default(),
            },
        ));
        let tool_pipeline = Arc::new(ToolPipeline::new(
            Arc::new(TokioRwLock::new(ToolRegistry::new())),
            Arc::new(ToolStateManager::new(event_queue.clone())),
            None,
        ));
        let execution_engine = Arc::new(ExecutionEngine::new(
            Arc::new(RoundExecutor::new(
                Arc::new(StreamProcessor::new(event_queue.clone())),
                event_queue.clone(),
                tool_pipeline.clone(),
            )),
            event_queue.clone(),
            session_manager.clone(),
            Arc::new(ContextCompressor::new()),
            ExecutionEngineConfig::default(),
        ));
        let coordinator = Arc::new(ConversationCoordinator::new(
            session_manager.clone(),
            execution_engine,
            tool_pipeline,
            event_queue.clone(),
            Arc::new(EventRouter::new()),
            Arc::new(
                crate::runtime_ownership::CoreRuntimeOwnership::embedded_with_facts(
                    std::env::temp_dir().join(format!(
                        "openbitfun-scheduler-ownership-test-{}",
                        uuid::Uuid::new_v4()
                    )),
                    "openbitfun".to_string(),
                    "test",
                ),
            ),
        ));
        (
            DialogScheduler::new(coordinator, session_manager.clone()),
            session_manager,
            event_queue,
            root,
        )
    }

    #[test]
    fn queued_turn_execution_default_is_standard() {
        assert!(matches!(
            QueuedTurnExecution::default(),
            QueuedTurnExecution::Standard
        ));
    }

    #[tokio::test]
    async fn submission_preflight_commits_a_persisted_revert_marker() {
        let (scheduler, session_manager, _, root) = test_scheduler();
        let session_id = "reverted-session";
        let workspace = fixture_workspace_dir(root.path().join("workspace"));
        session_manager
            .create_session_with_id(
                Some(session_id.to_string()),
                "Reverted".to_string(),
                "Standard".to_string(),
                SessionConfig {
                    workspace_path: Some(workspace.to_string_lossy().into_owned()),
                    ..Default::default()
                },
            )
            .await
            .expect("create session");
        let storage_path = session_manager
            .effective_session_storage_path(session_id)
            .await
            .expect("storage path");
        session_manager
            .persistence_manager()
            .save_session_revert_state(
                &storage_path,
                session_id,
                &SessionRevertState {
                    schema_version: SESSION_REVERT_SCHEMA_VERSION,
                    boundary_turn: 0,
                    original_turn_end: 1,
                    phase: SessionRevertPhase::Staged,
                    workspace_checkpoint: Vec::new(),
                },
            )
            .await
            .expect("persist staged revert");

        scheduler
            .coordinator
            .commit_session_revert_before_submission(session_id)
            .await
            .expect("commit staged revert");

        assert!(session_manager
            .persistence_manager()
            .load_session_revert_state(&storage_path, session_id)
            .await
            .expect("load revert marker")
            .is_none());
        let source = include_str!("scheduler.rs");
        let submission = source
            .split_once("async fn submit_queued_turn_locked(")
            .expect("submission method")
            .1
            .split_once("async fn record_last_submitted_agent_type(")
            .expect("submission method boundary")
            .0;
        assert!(submission.contains("commit_session_revert_before_submission(&session_id)"));
    }

    #[tokio::test]
    async fn background_bash_result_injects_into_its_running_parent_turn() {
        let (scheduler, session_manager, _, root) = test_scheduler();
        let session_id = "parent-session";
        let turn_id = "parent-turn";
        let workspace = fixture_workspace_dir(root.path().join("workspace"));
        session_manager
            .create_session_with_id(
                Some(session_id.to_string()),
                "Parent".to_string(),
                "Standard".to_string(),
                SessionConfig {
                    workspace_path: Some(workspace.to_string_lossy().into_owned()),
                    ..Default::default()
                },
            )
            .await
            .expect("create parent session");
        session_manager
            .update_session_state(
                session_id,
                SessionState::Processing {
                    current_turn_id: turn_id.to_string(),
                    phase: ProcessingPhase::Thinking,
                },
            )
            .await
            .expect("mark parent turn active");

        scheduler
            .deliver_background_result(
                session_id.to_string(),
                "Standard".to_string(),
                None,
                None,
                None,
                "Background Bash command completed".to_string(),
                None,
                Some(serde_json::json!({
                    "kind": "background_result",
                    "sourceKind": "bash_command",
                    "parentSessionId": session_id,
                    "parentDialogTurnId": turn_id,
                })),
            )
            .await
            .expect("inject background Bash result");

        let unrelated = scheduler
            .round_injection_monitor()
            .take_pending(session_id, "different-turn");
        assert!(unrelated.is_empty());

        let pending = scheduler
            .round_injection_monitor()
            .take_pending(session_id, turn_id);
        assert_eq!(pending.len(), 1);
        assert_eq!(scheduler.queue_depth(session_id), 0);
    }

    #[tokio::test]
    async fn idle_background_result_uses_the_session_logical_agent_route() {
        let (scheduler, session_manager, _, root) = test_scheduler();
        let session_id = "external-parent-session";
        let workspace = fixture_workspace_dir(root.path().join("workspace"));
        session_manager
            .create_session_with_id(
                Some(session_id.to_string()),
                "External parent".to_string(),
                "Standard".to_string(),
                SessionConfig {
                    workspace_path: Some(workspace.to_string_lossy().into_owned()),
                    model_id: Some("model-original".to_string()),
                    ..Default::default()
                },
            )
            .await
            .expect("create parent session");

        TEST_MODEL_RESOLUTION_AI_CONFIG
            .scope(
                AIConfig {
                    models: vec![AIModelConfig {
                        id: "model-original".to_string(),
                        name: "model-original".to_string(),
                        model_name: "model-original".to_string(),
                        enabled: true,
                        ..Default::default()
                    }],
                    ..Default::default()
                },
                scheduler.deliver_background_result(
                    session_id.to_string(),
                    "external::opencode::agentic::generation-v1".to_string(),
                    None,
                    None,
                    None,
                    "Background Bash command completed".to_string(),
                    None,
                    None,
                ),
            )
            .await
            .expect("lifecycle delivery must follow the persisted logical session route");
    }

    #[tokio::test]
    async fn restored_interrupted_session_holds_agent_follow_up_queue() {
        let (scheduler, session_manager, _, root) = test_scheduler_with_persistence(true);
        let session_id = "evicted-interrupted-session";
        let turn_id = "interrupted-turn";
        let workspace = fixture_workspace_dir(root.path().join("workspace"));
        let model_binding_fingerprint = model_runtime_binding_fingerprint(&AIModelConfig {
            id: "model-original".to_string(),
            name: "model-original".to_string(),
            model_name: "model-original".to_string(),
            enabled: true,
            ..Default::default()
        });
        std::fs::create_dir_all(&workspace).expect("workspace");
        session_manager
            .create_session_with_id(
                Some(session_id.to_string()),
                "Interrupted".to_string(),
                "Standard".to_string(),
                SessionConfig {
                    workspace_path: Some(workspace.to_string_lossy().into_owned()),
                    ..Default::default()
                },
            )
            .await
            .expect("create session");
        session_manager
            .start_dialog_turn(
                session_id,
                "Standard".to_string(),
                "finish this".to_string(),
                Some(turn_id.to_string()),
                None,
                Some(serde_json::json!({
                    "resolved_permission_mode": "ask",
                    "runtime_resolved_model_id": "model-original",
                    "runtime_model_binding_fingerprint": model_binding_fingerprint,
                    "runtime_reasoning_preset": null,
                    "runtime_reasoning_selection": null,
                    "runtime_reasoning_fingerprint": reasoning_preset_runtime_fingerprint(None)
                })),
            )
            .await
            .expect("start turn");
        session_manager
            .mark_dialog_turn_interrupted(session_id, turn_id)
            .await
            .expect("interrupt turn");
        session_manager
            .update_session_state_for_turn_if_processing(session_id, turn_id, SessionState::Idle)
            .await
            .expect("settle session idle");
        let storage_path = session_manager
            .effective_session_storage_path(session_id)
            .await
            .expect("resolve persisted session storage path");
        session_manager.evict_loaded_session_for_test(session_id);

        scheduler
            .restore_missing_session_before_admission(session_id, &storage_path)
            .await
            .expect("restore persisted session before admission")
            .expect("persisted session should restore");
        let mut queued_turn = standard_queued_turn("follow-up-turn");
        queued_turn.policy = DialogSubmissionPolicy::for_source(DialogTriggerSource::AgentSession);
        queued_turn.workspace_path = None;
        let outcome = scheduler
            .submit_queued_turn(
                session_id.to_string(),
                "follow-up-turn".to_string(),
                queued_turn,
                false,
            )
            .await
            .expect("agent follow-up should be accepted behind the hold");

        assert!(matches!(outcome, DialogSubmitOutcome::Queued { .. }));
        assert_eq!(scheduler.queue_depth(session_id), 1);
        assert!(session_manager
            .latest_dialog_turn_holds_dispatch(session_id)
            .await
            .expect("hold should remain durable"));
    }

    #[tokio::test]
    async fn running_thread_goal_delivery_targets_the_concrete_turn() {
        let (scheduler, session_manager, _, root) = test_scheduler();
        let session_id = "goal-parent-session";
        let turn_id = "goal-parent-turn";
        let workspace = fixture_workspace_dir(root.path().join("workspace"));
        session_manager
            .create_session_with_id(
                Some(session_id.to_string()),
                "Goal parent".to_string(),
                "Standard".to_string(),
                SessionConfig {
                    workspace_path: Some(workspace.to_string_lossy().into_owned()),
                    ..Default::default()
                },
            )
            .await
            .expect("create parent session");
        session_manager
            .update_session_state(
                session_id,
                SessionState::Processing {
                    current_turn_id: turn_id.to_string(),
                    phase: ProcessingPhase::Thinking,
                },
            )
            .await
            .expect("mark goal turn active");

        scheduler
            .deliver_thread_goal_objective_updated(
                session_id.to_string(),
                "Standard".to_string(),
                None,
                None,
                None,
                ThreadGoal {
                    goal_id: "goal-1".to_string(),
                    session_id: session_id.to_string(),
                    objective: "Finish the task".to_string(),
                    status: ThreadGoalStatus::Active,
                    token_budget: None,
                    tokens_used: 0,
                    time_used_seconds: 0,
                    created_at: 1,
                    updated_at: 2,
                    auto_continuation_count: 0,
                },
            )
            .await
            .expect("inject goal update");

        assert!(scheduler
            .round_injection_monitor()
            .take_pending(session_id, "different-turn")
            .is_empty());
        let pending = scheduler
            .round_injection_monitor()
            .take_pending(session_id, turn_id);
        assert_eq!(pending.len(), 1);
    }

    fn standard_queued_turn(turn_id: &str) -> QueuedTurn {
        QueuedTurn {
            user_input: "queued".to_string(),
            original_user_input: None,
            prepended_messages: Vec::new(),
            turn_id: Some(turn_id.to_string()),
            agent_type: "Standard".to_string(),
            workspace_path: Some("/workspace".to_string()),
            workspace_id: None,
            remote_connection_id: None,
            remote_ssh_host: None,
            policy: DialogSubmissionPolicy::for_source(DialogTriggerSource::DesktopUi),
            reply_route: None,
            user_message_metadata: None,
            image_contexts: None,
            enqueued_at: SystemTime::now(),
            _settlement_registration: None,
            execution: QueuedTurnExecution::Standard,
        }
    }

    #[test]
    fn targeted_queue_removal_cancels_a_standard_turn_by_id() {
        let queues = DialogTurnQueue::default();
        let queued_turn = standard_queued_turn("turn-queued");
        queues
            .enqueue("session-1", queued_turn, DialogQueuePriority::Normal)
            .expect("standard turn should enqueue");

        let removed = remove_queued_turn_by_id(&queues, "session-1", "turn-queued")
            .expect("targeted cancellation should remove the queued turn");

        assert!(matches!(removed.execution, QueuedTurnExecution::Standard));
        assert_eq!(queues.depth("session-1"), 0);
    }

    #[tokio::test]
    async fn targeted_standard_queue_cancellation_emits_one_terminal_event() {
        let (scheduler, _, event_queue, _root) = test_scheduler();
        let mut events = event_queue.subscribe();
        scheduler
            .queues
            .enqueue(
                "session",
                standard_queued_turn("turn-queued"),
                DialogQueuePriority::Normal,
            )
            .expect("queue standard turn");

        assert!(scheduler
            .cancel_queued_or_active_turn("session", "turn-queued")
            .await
            .expect("cancel queued turn"));
        let event = tokio::time::timeout(Duration::from_secs(1), events.recv())
            .await
            .expect("terminal event timeout")
            .expect("terminal event");
        assert!(matches!(
            event.event,
            AgenticEvent::DialogTurnCancelled { session_id, turn_id }
                if session_id == "session" && turn_id == "turn-queued"
        ));
        assert!(
            tokio::time::timeout(Duration::from_millis(20), events.recv())
                .await
                .is_err()
        );
    }

    #[tokio::test]
    async fn interrupted_turn_persistently_holds_later_queued_work() {
        let (scheduler, session_manager, _, root) = test_scheduler_with_persistence(true);
        let session_id = "interrupted-queue-hold";
        let turn_id = "turn-interrupted";
        let workspace = fixture_workspace_dir(root.path().join("workspace-interrupted-hold"));
        session_manager
            .create_session_with_id(
                Some(session_id.to_string()),
                "Interrupted queue hold".to_string(),
                "Standard".to_string(),
                SessionConfig {
                    workspace_path: Some(workspace.to_string_lossy().into_owned()),
                    ..Default::default()
                },
            )
            .await
            .expect("create session");
        session_manager
            .start_dialog_turn(
                session_id,
                "Standard".to_string(),
                "original work".to_string(),
                Some(turn_id.to_string()),
                None,
                None,
            )
            .await
            .expect("start turn");
        session_manager
            .mark_dialog_turn_interrupted(session_id, turn_id)
            .await
            .expect("interrupt turn");
        session_manager
            .update_session_state_for_turn_if_processing(session_id, turn_id, SessionState::Idle)
            .await
            .expect("settle idle");
        scheduler
            .queues
            .enqueue(
                session_id,
                standard_queued_turn("late-background-result"),
                DialogQueuePriority::Low,
            )
            .expect("queue later work");

        let started = scheduler
            .try_start_next_queued(session_id)
            .await
            .expect("hold check should succeed");

        assert!(started.is_none());
        assert_eq!(scheduler.queue_depth(session_id), 1);
    }

    #[tokio::test]
    async fn maintenance_does_not_release_parent_while_background_child_is_still_running() {
        let (scheduler, session_manager, _, root) = test_scheduler();
        let parent_session_id = "parent-session";
        let child_session_id = "background-child-session";
        let workspace = fixture_workspace_dir(root.path().join("workspace"));
        session_manager
            .create_session_with_id(
                Some(parent_session_id.to_string()),
                "Parent".to_string(),
                "Standard".to_string(),
                SessionConfig {
                    workspace_path: Some(workspace.to_string_lossy().to_string()),
                    ..Default::default()
                },
            )
            .await
            .expect("create parent session");
        let storage_path = session_manager
            .storage_path_binding_for_test(parent_session_id)
            .expect("parent storage binding");
        scheduler
            .coordinator
            .register_background_subagent_task_for_test(1, parent_session_id, child_session_id);
        scheduler
            .coordinator
            .set_active_turn_count_for_test(child_session_id, 1);

        let result = scheduler
            .begin_session_maintenance(parent_session_id, &storage_path, Duration::from_millis(40))
            .await;
        let error = match result {
            Ok(_) => panic!("maintenance must not detach a parent with a running child"),
            Err(error) => error,
        };

        assert!(matches!(error, OpenBitFunError::Timeout(_)));
        assert!(error.to_string().contains(child_session_id));
        assert!(session_manager.get_session(parent_session_id).is_some());

        let retry_error = match scheduler
            .begin_session_maintenance(parent_session_id, &storage_path, Duration::from_millis(40))
            .await
        {
            Ok(_) => panic!("retry must retain ownership of the still-running child"),
            Err(error) => error,
        };
        assert!(matches!(retry_error, OpenBitFunError::Timeout(_)));
        assert!(retry_error.to_string().contains(child_session_id));

        scheduler
            .coordinator
            .set_active_turn_count_for_test(child_session_id, 0);
        let maintenance = scheduler
            .begin_session_maintenance(parent_session_id, &storage_path, Duration::from_millis(40))
            .await
            .expect("maintenance should succeed after the child drains");
        drop(maintenance);
        assert!(!scheduler
            .maintenance_background_sessions
            .contains_key(parent_session_id));
    }

    #[test]
    fn queued_submission_without_started_turn_reports_queued() {
        assert_eq!(
            queued_submission_outcome("session".to_string(), "turn-submitted".to_string(), None,),
            DialogSubmitOutcome::Queued {
                session_id: "session".to_string(),
                turn_id: "turn-submitted".to_string(),
            }
        );
    }

    #[tokio::test]
    async fn dialog_port_preserves_not_found_for_a_missing_session() {
        let (scheduler, _, _, root) = test_scheduler();
        let workspace = fixture_workspace_dir(root.path().join("workspace"));

        let error = scheduler
            .submit_dialog_turn(AgentDialogTurnRequest {
                session_id: "missing-session".to_string(),
                message: "hello".to_string(),
                output_schema: None,
                original_message: None,
                turn_id: Some("missing-turn".to_string()),
                execution: Default::default(),
                agent_type: "Standard".to_string(),
                workspace_path: Some(workspace.to_string_lossy().to_string()),
                workspace_id: None,
                remote_connection_id: None,
                remote_ssh_host: None,
                policy: DialogSubmissionPolicy::for_source(DialogTriggerSource::Cli),
                reply_route: None,
                prepended_reminders: Vec::new(),
                attachments: Vec::new(),
                metadata: serde_json::Map::new(),
            })
            .await
            .expect_err("a missing session must remain distinguishable");

        assert_eq!(error.kind, PortErrorKind::NotFound);
        assert!(error.message.contains("missing-session"), "{error}");
        assert!(matches!(
            scheduler
                .coordinator
                .wait_for_turn_settlement(
                    "missing-session",
                    "missing-turn",
                    Duration::from_millis(10),
                )
                .await,
            Err(OpenBitFunError::NotFound(_))
        ));
    }

    #[tokio::test]
    async fn dialog_port_tracks_settlement_from_queue_admission_through_cancellation() {
        let (scheduler, session_manager, _, root) = test_scheduler();
        let session_id = "queued-session";
        let turn_id = "queued-turn";
        let workspace = fixture_workspace_dir(root.path().join("workspace"));
        session_manager
            .create_session_with_id(
                Some(session_id.to_string()),
                "Queued".to_string(),
                "Standard".to_string(),
                SessionConfig {
                    workspace_path: Some(workspace.to_string_lossy().to_string()),
                    ..Default::default()
                },
            )
            .await
            .expect("create queued session");
        session_manager
            .update_session_state(
                session_id,
                SessionState::Processing {
                    current_turn_id: "active-turn".to_string(),
                    phase: ProcessingPhase::Thinking,
                },
            )
            .await
            .expect("mark another turn active");

        let outcome = scheduler
            .submit_dialog_turn(AgentDialogTurnRequest {
                session_id: session_id.to_string(),
                message: "queued prompt".to_string(),
                output_schema: None,
                original_message: None,
                turn_id: Some(turn_id.to_string()),
                execution: Default::default(),
                agent_type: "Standard".to_string(),
                workspace_path: None,
                workspace_id: None,
                remote_connection_id: None,
                remote_ssh_host: None,
                policy: DialogSubmissionPolicy::for_source(DialogTriggerSource::Cli),
                reply_route: None,
                prepended_reminders: Vec::new(),
                attachments: Vec::new(),
                metadata: serde_json::Map::new(),
            })
            .await
            .expect("queue the submitted turn");

        assert_eq!(
            outcome,
            DialogSubmitOutcome::Queued {
                session_id: session_id.to_string(),
                turn_id: turn_id.to_string(),
            }
        );
        assert!(matches!(
            scheduler
                .coordinator
                .wait_for_turn_settlement(session_id, turn_id, Duration::from_millis(10))
                .await,
            Err(OpenBitFunError::Timeout(_))
        ));

        assert!(scheduler
            .cancel_queued_or_active_turn(session_id, turn_id)
            .await
            .expect("cancel queued turn"));
        scheduler
            .coordinator
            .wait_for_turn_settlement(session_id, turn_id, Duration::from_millis(10))
            .await
            .expect("cancelled queued turn should settle");
    }

    #[tokio::test]
    async fn delegated_dialog_turn_rejects_instead_of_queueing_behind_an_active_turn() {
        let (scheduler, session_manager, _, root) = test_scheduler();
        let session_id = "delegated-busy-session";
        let workspace = fixture_workspace_dir(root.path().join("workspace"));
        session_manager
            .create_session_with_id(
                Some(session_id.to_string()),
                "Delegated".to_string(),
                "Standard".to_string(),
                SessionConfig {
                    workspace_path: Some(workspace.to_string_lossy().to_string()),
                    ..Default::default()
                },
            )
            .await
            .expect("create delegated session");
        session_manager
            .update_session_state(
                session_id,
                SessionState::Processing {
                    current_turn_id: "active-turn".to_string(),
                    phase: ProcessingPhase::Thinking,
                },
            )
            .await
            .expect("mark active turn");

        let error = scheduler
            .submit_dialog_turn(AgentDialogTurnRequest {
                session_id: session_id.to_string(),
                message: "expanded command prompt".to_string(),
                output_schema: None,
                original_message: Some("/review".to_string()),
                turn_id: Some("delegated-turn".to_string()),
                execution:
                    openbitfun_runtime_ports::AgentDialogTurnExecution::FreshExternalSubagent {
                        ecosystem_id: "opencode".to_string(),
                        logical_id: "reviewer".to_string(),
                    },
                agent_type: "Standard".to_string(),
                workspace_path: None,
                workspace_id: None,
                remote_connection_id: None,
                remote_ssh_host: None,
                policy: DialogSubmissionPolicy::for_source(DialogTriggerSource::Cli),
                reply_route: None,
                prepended_reminders: Vec::new(),
                attachments: Vec::new(),
                metadata: serde_json::Map::new(),
            })
            .await
            .expect_err("delegated commands must not queue behind another turn");

        assert_eq!(error.kind, PortErrorKind::InvalidRequest);
        assert!(error.message.contains("idle session"), "{error}");
        assert_eq!(scheduler.queue_depth(session_id), 0);
    }

    #[tokio::test]
    async fn delegated_dialog_turn_does_not_clear_a_queue_from_an_error_session() {
        let (scheduler, session_manager, _, root) = test_scheduler();
        let session_id = "delegated-error-session";
        let workspace = fixture_workspace_dir(root.path().join("workspace"));
        session_manager
            .create_session_with_id(
                Some(session_id.to_string()),
                "Delegated".to_string(),
                "Standard".to_string(),
                SessionConfig {
                    workspace_path: Some(workspace.to_string_lossy().to_string()),
                    ..Default::default()
                },
            )
            .await
            .expect("create delegated session");
        session_manager
            .update_session_state(
                session_id,
                SessionState::Processing {
                    current_turn_id: "active-turn".to_string(),
                    phase: ProcessingPhase::Thinking,
                },
            )
            .await
            .expect("mark active turn");

        scheduler
            .submit_dialog_turn(AgentDialogTurnRequest {
                session_id: session_id.to_string(),
                message: "queued prompt".to_string(),
                output_schema: None,
                original_message: None,
                turn_id: Some("queued-turn".to_string()),
                execution: Default::default(),
                agent_type: "Standard".to_string(),
                workspace_path: None,
                workspace_id: None,
                remote_connection_id: None,
                remote_ssh_host: None,
                policy: DialogSubmissionPolicy::for_source(DialogTriggerSource::Cli),
                reply_route: None,
                prepended_reminders: Vec::new(),
                attachments: Vec::new(),
                metadata: serde_json::Map::new(),
            })
            .await
            .expect("queue standard turn");
        session_manager
            .update_session_state(
                session_id,
                SessionState::Error {
                    error: "previous turn failed".to_string(),
                    recoverable: true,
                },
            )
            .await
            .expect("mark session recoverable error");

        let error = scheduler
            .submit_dialog_turn(AgentDialogTurnRequest {
                session_id: session_id.to_string(),
                message: "expanded command prompt".to_string(),
                output_schema: None,
                original_message: Some("/review".to_string()),
                turn_id: Some("delegated-turn".to_string()),
                execution:
                    openbitfun_runtime_ports::AgentDialogTurnExecution::FreshExternalSubagent {
                        ecosystem_id: "opencode".to_string(),
                        logical_id: "reviewer".to_string(),
                    },
                agent_type: "Standard".to_string(),
                workspace_path: None,
                workspace_id: None,
                remote_connection_id: None,
                remote_ssh_host: None,
                policy: DialogSubmissionPolicy::for_source(DialogTriggerSource::Cli),
                reply_route: None,
                prepended_reminders: Vec::new(),
                attachments: Vec::new(),
                metadata: serde_json::Map::new(),
            })
            .await
            .expect_err("delegated commands must not replace a queued turn after an error");

        assert_eq!(error.kind, PortErrorKind::InvalidRequest);
        assert!(error.message.contains("idle"), "{error}");
        assert_eq!(scheduler.queue_depth(session_id), 1);
        assert!(scheduler
            .cancel_queued_or_active_turn(session_id, "queued-turn")
            .await
            .expect("cancel preserved queued turn"));
    }

    #[tokio::test]
    async fn reject_busy_dialog_port_does_not_enqueue_or_replace_the_active_turn() {
        let (scheduler, session_manager, _, root) = test_scheduler();
        let session_id = "acp-session";
        let workspace = fixture_workspace_dir(root.path().join("workspace"));
        session_manager
            .create_session_with_id(
                Some(session_id.to_string()),
                "ACP".to_string(),
                "Standard".to_string(),
                SessionConfig {
                    workspace_path: Some(workspace.to_string_lossy().to_string()),
                    ..Default::default()
                },
            )
            .await
            .expect("create ACP session");
        session_manager
            .update_session_state(
                session_id,
                SessionState::Processing {
                    current_turn_id: "active-turn".to_string(),
                    phase: ProcessingPhase::Thinking,
                },
            )
            .await
            .expect("mark active turn");

        let error = scheduler
            .submit_agent_dialog_turn_reject_if_busy(AgentDialogTurnRequest {
                session_id: session_id.to_string(),
                message: "second prompt".to_string(),
                output_schema: None,
                original_message: None,
                turn_id: Some("rejected-turn".to_string()),
                execution: Default::default(),
                agent_type: "Standard".to_string(),
                workspace_path: None,
                workspace_id: None,
                remote_connection_id: None,
                remote_ssh_host: None,
                policy: DialogSubmissionPolicy::for_source(DialogTriggerSource::Cli),
                reply_route: None,
                prepended_reminders: Vec::new(),
                attachments: Vec::new(),
                metadata: serde_json::Map::new(),
            })
            .await
            .expect_err("busy ACP prompt must be rejected");

        assert_eq!(error.kind, PortErrorKind::Backend);
        assert!(error.message.contains("Processing"), "{error}");
        assert_eq!(scheduler.queue_depth(session_id), 0);
        assert!(matches!(
            session_manager
                .get_session(session_id)
                .expect("session")
                .state,
            SessionState::Processing { current_turn_id, .. } if current_turn_id == "active-turn"
        ));
        assert!(matches!(
            scheduler
                .coordinator
                .wait_for_turn_settlement(session_id, "rejected-turn", Duration::from_millis(10),)
                .await,
            Err(OpenBitFunError::NotFound(_))
        ));
    }

    #[tokio::test]
    async fn dialog_port_rejects_duplicate_active_turn_id() {
        let (scheduler, session_manager, _, root) = test_scheduler();
        let session_id = "duplicate-active-session";
        let turn_id = "duplicate-turn";
        let workspace = fixture_workspace_dir(root.path().join("workspace"));
        session_manager
            .create_session_with_id(
                Some(session_id.to_string()),
                "Duplicate".to_string(),
                "Standard".to_string(),
                SessionConfig {
                    workspace_path: Some(workspace.to_string_lossy().to_string()),
                    ..Default::default()
                },
            )
            .await
            .expect("create session");
        let _active_registration = scheduler
            .coordinator
            .register_turn_settlement(session_id, turn_id);
        session_manager
            .update_session_state(
                session_id,
                SessionState::Processing {
                    current_turn_id: turn_id.to_string(),
                    phase: ProcessingPhase::Thinking,
                },
            )
            .await
            .expect("mark active turn");

        let error = scheduler
            .submit_dialog_turn(AgentDialogTurnRequest {
                session_id: session_id.to_string(),
                message: "duplicate".to_string(),
                output_schema: None,
                original_message: None,
                turn_id: Some(turn_id.to_string()),
                execution: Default::default(),
                agent_type: "Standard".to_string(),
                workspace_path: None,
                workspace_id: None,
                remote_connection_id: None,
                remote_ssh_host: None,
                policy: DialogSubmissionPolicy::for_source(DialogTriggerSource::Cli),
                reply_route: None,
                prepended_reminders: Vec::new(),
                attachments: Vec::new(),
                metadata: serde_json::Map::new(),
            })
            .await
            .expect_err("duplicate active turn ID must be rejected");

        assert_eq!(error.kind, PortErrorKind::InvalidRequest);
    }

    #[tokio::test]
    async fn dialog_port_preserves_invalid_request_for_wrong_workspace() {
        let (scheduler, session_manager, _, root) = test_scheduler();
        let session_id = "workspace-bound-session";
        let turn_id = "wrong-workspace-turn";
        let workspace_a = fixture_workspace_dir(root.path().join("workspace-a"));
        let workspace_b = fixture_workspace_dir(root.path().join("workspace-b"));
        session_manager
            .create_session_with_id(
                Some(session_id.to_string()),
                "Workspace".to_string(),
                "Standard".to_string(),
                SessionConfig {
                    workspace_path: Some(workspace_a.to_string_lossy().to_string()),
                    ..Default::default()
                },
            )
            .await
            .expect("create session");
        let error = scheduler
            .submit_dialog_turn(AgentDialogTurnRequest {
                session_id: session_id.to_string(),
                message: "wrong workspace".to_string(),
                output_schema: None,
                original_message: None,
                turn_id: Some(turn_id.to_string()),
                execution: Default::default(),
                agent_type: "Standard".to_string(),
                workspace_path: Some(workspace_b.to_string_lossy().to_string()),
                workspace_id: None,
                remote_connection_id: None,
                remote_ssh_host: None,
                policy: DialogSubmissionPolicy::for_source(DialogTriggerSource::Cli),
                reply_route: None,
                prepended_reminders: Vec::new(),
                attachments: Vec::new(),
                metadata: serde_json::Map::new(),
            })
            .await
            .expect_err("wrong workspace must be rejected");

        assert_eq!(error.kind, PortErrorKind::InvalidRequest);
        assert!(matches!(
            scheduler
                .coordinator
                .wait_for_turn_settlement(session_id, turn_id, Duration::from_millis(10))
                .await,
            Err(OpenBitFunError::NotFound(_))
        ));
    }

    #[tokio::test]
    async fn dialog_port_treats_unknown_agent_as_invalid_request() {
        let (scheduler, session_manager, _, root) = test_scheduler();
        let session_id = "invalid-agent-session";
        let turn_id = "invalid-agent-turn";
        let workspace = fixture_workspace_dir(root.path().join("workspace"));
        session_manager
            .create_session_with_id(
                Some(session_id.to_string()),
                "Invalid agent".to_string(),
                "Standard".to_string(),
                SessionConfig {
                    workspace_path: Some(workspace.to_string_lossy().to_string()),
                    ..Default::default()
                },
            )
            .await
            .expect("create session");

        let error = scheduler
            .submit_dialog_turn(AgentDialogTurnRequest {
                session_id: session_id.to_string(),
                message: "invalid agent".to_string(),
                output_schema: None,
                original_message: None,
                turn_id: Some(turn_id.to_string()),
                execution: Default::default(),
                agent_type: "agent-that-does-not-exist".to_string(),
                workspace_path: None,
                workspace_id: None,
                remote_connection_id: None,
                remote_ssh_host: None,
                policy: DialogSubmissionPolicy::for_source(DialogTriggerSource::Cli),
                reply_route: None,
                prepended_reminders: Vec::new(),
                attachments: Vec::new(),
                metadata: serde_json::Map::new(),
            })
            .await
            .expect_err("unknown agent must be rejected");

        assert_eq!(error.kind, PortErrorKind::InvalidRequest);
    }

    #[tokio::test]
    async fn missing_settlement_evidence_for_known_turn_fails_closed() {
        let (scheduler, session_manager, _, root) = test_scheduler();
        let session_id = "known-turn-session";
        let turn_id = "known-turn";
        let workspace = fixture_workspace_dir(root.path().join("workspace"));
        session_manager
            .create_session_with_id(
                Some(session_id.to_string()),
                "Known turn".to_string(),
                "Standard".to_string(),
                SessionConfig {
                    workspace_path: Some(workspace.to_string_lossy().to_string()),
                    ..Default::default()
                },
            )
            .await
            .expect("create session");
        session_manager
            .start_dialog_turn(
                session_id,
                "Standard".to_string(),
                "hello".to_string(),
                Some(turn_id.to_string()),
                None,
                None,
            )
            .await
            .expect("record turn");
        session_manager
            .update_session_state(session_id, SessionState::Idle)
            .await
            .expect("mark idle");

        let error = scheduler
            .coordinator
            .wait_for_turn_settlement(session_id, turn_id, Duration::from_millis(10))
            .await
            .expect_err("missing settlement evidence must not be treated as success");

        assert!(
            matches!(
                &error,
                OpenBitFunError::OutcomeUnknown(message)
                    if message.contains(session_id) && message.contains(turn_id)
            ),
            "{error}"
        );
    }

    fn desktop_active_turn(turn_id: &str) -> ActiveDialogTurn {
        ActiveDialogTurn::new(
            turn_id.to_string(),
            Some("/workspace".to_string()),
            None,
            None,
            "Standard".to_string(),
            "hello".to_string(),
            None,
            DialogSubmissionPolicy::for_source(DialogTriggerSource::DesktopUi),
            None,
        )
    }

    async fn mark_session_processing(
        session_manager: &SessionManager,
        root: &tempfile::TempDir,
        session_id: &str,
        turn_id: &str,
    ) {
        let workspace = fixture_workspace_dir(root.path().join(format!("workspace-{session_id}")));
        session_manager
            .create_session_with_id(
                Some(session_id.to_string()),
                "Steering".to_string(),
                "Standard".to_string(),
                SessionConfig {
                    workspace_path: Some(workspace.to_string_lossy().into_owned()),
                    ..Default::default()
                },
            )
            .await
            .expect("create session");
        session_manager
            .update_session_state(
                session_id,
                SessionState::Processing {
                    current_turn_id: turn_id.to_string(),
                    phase: ProcessingPhase::Thinking,
                },
            )
            .await
            .expect("mark turn active");
    }

    #[tokio::test]
    async fn steering_rejects_stale_processing_state_without_authoritative_active_turn() {
        let (scheduler, session_manager, _, root) = test_scheduler();
        let session_id = "stale-steering-session";
        let turn_id = "stale-turn";
        mark_session_processing(&session_manager, &root, session_id, turn_id).await;

        let error = scheduler
            .buffer_steering(
                session_id.to_string(),
                turn_id.to_string(),
                "check tests".to_string(),
                None,
                Vec::new(),
                serde_json::Map::new(),
            )
            .await
            .expect_err("stale processing state must not accept steering");

        assert!(error.contains("no longer running"), "{error}");
        assert!(scheduler
            .round_injection_monitor()
            .take_pending(session_id, turn_id)
            .is_empty());
    }

    #[tokio::test]
    async fn steering_rejects_empty_content_as_an_invalid_request() {
        let (scheduler, _, _, _) = test_scheduler();

        let error = AgentDialogTurnPort::steer_dialog_turn(
            scheduler.as_ref(),
            AgentDialogSteerRequest {
                session_id: "session-1".to_string(),
                turn_id: "turn-1".to_string(),
                content: "  ".to_string(),
                display_content: None,
                attachments: Vec::new(),
                metadata: serde_json::Map::new(),
            },
        )
        .await
        .expect_err("empty steering must fail");

        assert_eq!(error.kind, PortErrorKind::InvalidRequest);
    }

    #[tokio::test]
    async fn steering_serializes_with_other_operations_for_the_same_session() {
        let (scheduler, session_manager, _, root) = test_scheduler();
        let session_id = "locked-steering-session";
        let turn_id = "active-turn";
        mark_session_processing(&session_manager, &root, session_id, turn_id).await;
        scheduler
            .active_turns
            .insert(session_id, desktop_active_turn(turn_id));

        let operation_guard = scheduler.lock_session_operation(session_id).await;
        let steering_scheduler = scheduler.clone();
        let steering = tokio::spawn(async move {
            steering_scheduler
                .buffer_steering(
                    session_id.to_string(),
                    turn_id.to_string(),
                    "check tests".to_string(),
                    None,
                    Vec::new(),
                    serde_json::Map::new(),
                )
                .await
        });
        tokio::task::yield_now().await;

        assert!(
            !steering.is_finished(),
            "steering must wait for the session operation lock"
        );
        drop(operation_guard);
        steering
            .await
            .expect("steering task")
            .expect("steering outcome");
    }

    #[tokio::test]
    async fn explicit_cancel_cannot_cross_session_by_reusing_a_turn_id() {
        let (scheduler, _, _, _root) = test_scheduler();
        scheduler
            .active_turns
            .insert("session-a", desktop_active_turn("shared-turn"));

        let removed = scheduler
            .cancel_queued_or_active_turn("session-b", "shared-turn")
            .await
            .expect("stale cancellation is idempotent");

        assert!(!removed);
        assert!(scheduler
            .active_turns
            .matches_turn("session-a", "shared-turn"));
    }

    #[tokio::test]
    async fn wrong_workspace_deletion_leaves_active_and_queued_turns_untouched() {
        let (scheduler, session_manager, _, root) = test_scheduler();
        let session_id = "session-bound-to-a";
        let storage_a = root.path().join("workspace-a-sessions");
        let storage_b = root.path().join("workspace-b-sessions");
        session_manager
            .ensure_session_storage_path(session_id, &storage_a)
            .expect("bind session storage");
        scheduler
            .queues
            .enqueue(
                session_id,
                standard_queued_turn("turn-queued"),
                DialogQueuePriority::Normal,
            )
            .expect("queue turn");
        scheduler
            .active_turns
            .insert(session_id, desktop_active_turn("turn-active"));

        let error = scheduler
            .begin_session_deletion(session_id, &storage_b, Duration::ZERO)
            .await
            .err()
            .expect("wrong workspace must be rejected before quiescence");

        assert!(matches!(error, OpenBitFunError::Validation(_)));
        assert_eq!(scheduler.queue_depth(session_id), 1);
        assert!(scheduler
            .active_turns
            .matches_turn(session_id, "turn-active"));
    }

    #[tokio::test]
    async fn session_deletion_clears_injections_retained_for_an_interrupted_turn() {
        let (scheduler, session_manager, _, root) = test_scheduler();
        let session_id = "session-delete-interrupted-injections";
        let storage = root.path().join("workspace-delete-interrupted-injections");
        session_manager
            .ensure_session_storage_path(session_id, &storage)
            .expect("bind session storage");
        scheduler.round_injection_buffer.push(
            session_id,
            target_background_delivery_injection_to_turn(
                resolve_background_delivery_injection(
                    BackgroundInjectionKind::BackgroundResult,
                    "injection-1".to_string(),
                    "retained result".to_string(),
                    None,
                    std::time::SystemTime::now(),
                ),
                "turn-interrupted".to_string(),
            ),
        );
        assert_eq!(
            scheduler.round_injection_buffer.pending_count(session_id),
            1
        );

        let _permit = scheduler
            .begin_session_deletion(session_id, &storage, Duration::ZERO)
            .await
            .expect("deletion maintenance should quiesce the idle session");

        assert_eq!(
            scheduler.round_injection_buffer.pending_count(session_id),
            0
        );
    }

    #[tokio::test]
    async fn maintenance_retires_scheduler_state_even_when_core_cancel_returns_a_turn_id() {
        let (scheduler, session_manager, _, root) = test_scheduler();
        let session_id = "session-maintenance-retire";
        let turn_id = "turn-active";
        let workspace = fixture_workspace_dir(root.path().join("workspace-maintenance-retire"));
        session_manager
            .create_session_with_id(
                Some(session_id.to_string()),
                "Maintenance retire".to_string(),
                "Standard".to_string(),
                SessionConfig {
                    workspace_path: Some(workspace.to_string_lossy().to_string()),
                    ..Default::default()
                },
            )
            .await
            .expect("create session");
        session_manager
            .update_session_state(
                session_id,
                SessionState::Processing {
                    current_turn_id: turn_id.to_string(),
                    phase: ProcessingPhase::ToolCalling,
                },
            )
            .await
            .expect("mark processing");
        scheduler
            .active_turns
            .insert(session_id, desktop_active_turn(turn_id));
        let storage_path = session_manager
            .storage_path_binding_for_test(session_id)
            .expect("storage binding");

        let maintenance = scheduler
            .begin_session_maintenance(session_id, &storage_path, Duration::from_secs(1))
            .await
            .expect("maintenance");

        assert_eq!(maintenance.retired_turn_ids(), &[turn_id.to_string()]);
        assert!(!scheduler.active_turns.matches_turn(session_id, turn_id));
        assert!(take_active_turn_for_outcome(
            &scheduler.active_turns,
            &scheduler.retired_maintenance_outcomes,
            session_id,
            turn_id,
        )
        .is_none());
    }

    #[test]
    fn retired_maintenance_outcome_cannot_mutate_a_recreated_session_generation() {
        let active_turns = ActiveDialogTurnStore::default();
        let retired = DialogReplySuppressionSet::default();
        let session_id = "reused-session";
        active_turns.insert(session_id, desktop_active_turn("turn-old"));
        let old = active_turns
            .remove(session_id)
            .expect("old active turn should be present");
        retired.mark(session_id, old.turn_id());
        active_turns.insert(session_id, desktop_active_turn("turn-new"));

        assert!(
            take_active_turn_for_outcome(&active_turns, &retired, session_id, "turn-old").is_none()
        );
        assert!(active_turns.matches_turn(session_id, "turn-new"));
        assert!(matches!(
            take_active_turn_for_outcome(&active_turns, &retired, session_id, "turn-new"),
            Some(ActiveDialogTurnTakeResult::Matched(_))
        ));
    }

    fn agent_session_active_turn(source_session_id: &str) -> ActiveDialogTurn {
        ActiveDialogTurn::new(
            "turn_1".to_string(),
            Some("/workspace".to_string()),
            None,
            None,
            "Standard".to_string(),
            "hello".to_string(),
            None,
            DialogSubmissionPolicy::for_source(DialogTriggerSource::AgentSession),
            Some(AgentSessionReplyRoute {
                source_session_id: source_session_id.to_string(),
                source_workspace_path: "/source".to_string(),
                source_remote_connection_id: None,
                source_remote_ssh_host: None,
            }),
        )
    }

    #[test]
    fn requester_matching_reply_route_suppresses_cancelled_reply() {
        let active_turn = agent_session_active_turn("session_a");
        assert!(active_turn.should_suppress_cancelled_reply_for_requester("session_a"));
        assert!(!active_turn.should_suppress_cancelled_reply_for_requester("session_c"));
    }

    #[test]
    fn cancelled_reply_is_skipped_only_when_suppressed() {
        let active_turn = agent_session_active_turn("session_a");
        let cancelled = TurnOutcome::Cancelled {
            turn_id: "turn_1".to_string(),
        };
        let completed = TurnOutcome::Completed {
            turn_id: "turn_1".to_string(),
            final_response: "done".to_string(),
        };

        assert_eq!(
            resolve_agent_session_reply_action("session_b", &active_turn, &cancelled, true),
            AgentSessionReplyAction::SkipSuppressedCancelledReply
        );
        assert!(matches!(
            resolve_agent_session_reply_action("session_b", &active_turn, &cancelled, false),
            AgentSessionReplyAction::Forward(_)
        ));
        assert!(matches!(
            resolve_agent_session_reply_action("session_b", &active_turn, &completed, true),
            AgentSessionReplyAction::Forward(_)
        ));
    }

    #[test]
    fn cancelled_hidden_subagent_outcome_dispatches_next_queued_turn() {
        let cancelled = TurnOutcome::Cancelled {
            turn_id: "subagent-turn-1".to_string(),
        };
        let failed = TurnOutcome::Failed {
            turn_id: "subagent-turn-1".to_string(),
            error: "provider error".to_string(),
        };

        let cancelled_plan = resolve_turn_outcome_lifecycle_plan(&cancelled, true);
        assert_eq!(
            cancelled_plan.queue_action,
            TurnOutcomeQueueAction::DispatchNext
        );

        let failed_plan = resolve_turn_outcome_lifecycle_plan(&failed, true);
        assert_eq!(failed_plan.queue_action, TurnOutcomeQueueAction::ClearQueue);
    }

    #[test]
    fn goal_verification_observation_covers_all_turn_outcomes() {
        let completed = TurnOutcome::Completed {
            turn_id: "turn_1".to_string(),
            final_response: "done".to_string(),
        };
        let cancelled = TurnOutcome::Cancelled {
            turn_id: "turn_2".to_string(),
        };
        let failed = TurnOutcome::Failed {
            turn_id: "turn_3".to_string(),
            error: "network offline".to_string(),
        };

        assert_eq!(completed.reply_text(), "done");
        assert!(cancelled.reply_text().contains("cancelled"));
        assert!(failed.reply_text().contains("network offline"));
    }

    #[test]
    fn remote_queue_policy_preserves_priority_boundary() {
        let remote = DialogSubmissionPolicy::for_source(DialogTriggerSource::RemoteRelay);
        assert_eq!(remote.queue_priority, DialogQueuePriority::Normal);

        let bot = DialogSubmissionPolicy::for_source(DialogTriggerSource::Bot);
        assert_eq!(bot.queue_priority, DialogQueuePriority::Normal);

        let agent_session = DialogSubmissionPolicy::for_source(DialogTriggerSource::AgentSession);
        assert_eq!(agent_session.queue_priority, DialogQueuePriority::Low);
    }

    #[test]
    fn agent_dialog_turn_attachments_preserve_remote_image_context() {
        let mut metadata = serde_json::Map::new();
        metadata.insert(
            "dataUrl".to_string(),
            serde_json::json!("data:image/jpeg;base64,abc"),
        );
        metadata.insert("mimeType".to_string(), serde_json::json!("image/jpeg"));
        metadata.insert(
            "metadata".to_string(),
            serde_json::json!({ "name": "clip.jpg", "source": "remote" }),
        );

        let contexts = agent_dialog_turn_image_contexts(&[AgentInputAttachment {
            kind: "remote_image".to_string(),
            id: "ctx-1".to_string(),
            metadata,
        }])
        .expect("remote image attachment should be supported")
        .expect("non-empty image contexts");

        assert_eq!(contexts.len(), 1);
        assert_eq!(contexts[0].id, "ctx-1");
        assert_eq!(
            contexts[0].data_url.as_deref(),
            Some("data:image/jpeg;base64,abc")
        );
        assert_eq!(contexts[0].mime_type, "image/jpeg");
        assert_eq!(
            contexts[0]
                .metadata
                .as_ref()
                .and_then(|value| value.get("name")),
            Some(&serde_json::json!("clip.jpg"))
        );
    }

    #[test]
    fn agent_dialog_turn_attachments_reject_unknown_kind() {
        let err = agent_dialog_turn_image_contexts(&[AgentInputAttachment {
            kind: "unknown".to_string(),
            id: "attachment-1".to_string(),
            metadata: serde_json::Map::new(),
        }])
        .expect_err("unsupported attachment kind must be explicit");

        assert_eq!(err.kind, PortErrorKind::InvalidRequest);
        assert!(err
            .message
            .contains("unsupported agent dialog attachment kind"));
    }

    #[test]
    fn agent_dialog_turn_prepended_reminders_preserve_session_message_kind() {
        let messages = agent_dialog_turn_prepended_messages(&[AgentDialogPrependedReminder {
            kind: "session_message_request".to_string(),
            text: "sent by another agent".to_string(),
        }])
        .expect("session message reminder should be supported");

        assert_eq!(messages.len(), 1);
        assert_eq!(
            messages[0].internal_reminder_kind(),
            Some(InternalReminderKind::SessionMessageRequest)
        );
    }

    #[test]
    fn agent_dialog_turn_prepended_reminders_preserve_scheduled_job_kind() {
        let messages = agent_dialog_turn_prepended_messages(&[AgentDialogPrependedReminder {
            kind: "scheduled_job".to_string(),
            text: "scheduled job trigger".to_string(),
        }])
        .expect("scheduled job reminder should be supported");

        assert_eq!(messages.len(), 1);
        assert_eq!(
            messages[0].internal_reminder_kind(),
            Some(InternalReminderKind::ScheduledJob)
        );
    }

    #[test]
    fn agent_dialog_turn_prepended_reminders_reject_unknown_kind() {
        let err = agent_dialog_turn_prepended_messages(&[AgentDialogPrependedReminder {
            kind: "unknown".to_string(),
            text: "unsupported".to_string(),
        }])
        .expect_err("unsupported reminder kind must be explicit");

        assert_eq!(err.kind, PortErrorKind::InvalidRequest);
        assert!(err
            .message
            .contains("unsupported agent dialog prepended reminder kind"));
    }
}
