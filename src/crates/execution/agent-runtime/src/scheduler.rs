//! Scheduler owner decisions.

/// Portable result delivery decisions share the background scheduler owner.
#[path = "background_delivery.rs"]
pub mod result_delivery;

use crate::events::turn_outcome_kind;
use crate::thread_goal::{build_objective_updated_plan, build_thread_goal_continuation_plan};
use openbitfun_runtime_ports::{
    should_skip_agent_session_reply, should_suppress_agent_session_cancelled_reply,
    AgentInputAttachment, AgentSessionReplyRoute, DialogQueuePriority, DialogRoundInjectionSource,
    DialogSessionStateFact, DialogSteerOutcome, DialogSubmissionPolicy, DialogTriggerSource,
    RoundInjection, RoundInjectionKind, RoundInjectionTarget, RoundInjectionToolPreemption,
    ThreadGoal,
};
use std::collections::VecDeque;
use std::fmt;
use std::sync::Arc;
use std::time::SystemTime;

pub const DEFAULT_MAX_DIALOG_QUEUE_DEPTH: usize = 20;

#[derive(Debug, Clone)]
pub struct ActiveDialogTurn {
    turn_id: String,
    workspace_path: Option<String>,
    remote_connection_id: Option<String>,
    remote_ssh_host: Option<String>,
    agent_type: String,
    user_input: String,
    user_message_metadata: Option<serde_json::Value>,
    policy: DialogSubmissionPolicy,
    reply_route: Option<AgentSessionReplyRoute>,
}

impl ActiveDialogTurn {
    pub fn new(
        turn_id: String,
        workspace_path: Option<String>,
        remote_connection_id: Option<String>,
        remote_ssh_host: Option<String>,
        agent_type: String,
        user_input: String,
        user_message_metadata: Option<serde_json::Value>,
        policy: DialogSubmissionPolicy,
        reply_route: Option<AgentSessionReplyRoute>,
    ) -> Self {
        Self {
            turn_id,
            workspace_path,
            remote_connection_id,
            remote_ssh_host,
            agent_type,
            user_input,
            user_message_metadata,
            policy,
            reply_route,
        }
    }

    pub fn turn_id(&self) -> &str {
        &self.turn_id
    }

    pub fn workspace_path(&self) -> Option<&str> {
        self.workspace_path.as_deref()
    }

    pub fn workspace_path_owned(&self) -> Option<String> {
        self.workspace_path.clone()
    }

    pub fn remote_connection_id(&self) -> Option<&str> {
        self.remote_connection_id.as_deref()
    }

    pub fn remote_connection_id_owned(&self) -> Option<String> {
        self.remote_connection_id.clone()
    }

    pub fn remote_ssh_host(&self) -> Option<&str> {
        self.remote_ssh_host.as_deref()
    }

    pub fn remote_ssh_host_owned(&self) -> Option<String> {
        self.remote_ssh_host.clone()
    }

    pub fn agent_type(&self) -> &str {
        &self.agent_type
    }

    pub fn agent_type_owned(&self) -> String {
        self.agent_type.clone()
    }

    pub fn user_input(&self) -> &str {
        &self.user_input
    }

    pub fn user_message_metadata(&self) -> Option<&serde_json::Value> {
        self.user_message_metadata.as_ref()
    }

    pub fn reply_route(&self) -> Option<&AgentSessionReplyRoute> {
        self.reply_route.as_ref()
    }

    pub fn is_agent_session_request(&self) -> bool {
        self.policy.trigger_source == DialogTriggerSource::AgentSession
            && self.reply_route.is_some()
    }

    pub fn should_suppress_cancelled_reply_for_requester(
        &self,
        requester_session_id: &str,
    ) -> bool {
        should_suppress_agent_session_cancelled_reply(
            &self.policy,
            self.reply_route
                .as_ref()
                .map(|reply_route| reply_route.source_session_id.as_str()),
            requester_session_id,
        )
    }
}

#[derive(Debug, Default)]
pub struct ActiveDialogTurnStore {
    inner: dashmap::DashMap<String, ActiveDialogTurn>,
}

#[derive(Debug)]
pub enum ActiveDialogTurnTakeResult {
    Matched(ActiveDialogTurn),
    Absent,
    DifferentTurn,
}

impl ActiveDialogTurnStore {
    pub fn insert(&self, session_id: &str, turn: ActiveDialogTurn) {
        self.inner.insert(session_id.to_string(), turn);
    }

    pub fn remove(&self, session_id: &str) -> Option<ActiveDialogTurn> {
        self.inner.remove(session_id).map(|(_, turn)| turn)
    }

    /// Atomically take the active metadata only when it belongs to the
    /// outcome's turn generation.
    pub fn take_for_outcome(&self, session_id: &str, turn_id: &str) -> ActiveDialogTurnTakeResult {
        match self.inner.entry(session_id.to_string()) {
            dashmap::mapref::entry::Entry::Occupied(entry) if entry.get().turn_id() == turn_id => {
                ActiveDialogTurnTakeResult::Matched(entry.remove())
            }
            dashmap::mapref::entry::Entry::Occupied(_) => ActiveDialogTurnTakeResult::DifferentTurn,
            dashmap::mapref::entry::Entry::Vacant(_) => ActiveDialogTurnTakeResult::Absent,
        }
    }

    pub fn contains(&self, session_id: &str) -> bool {
        self.inner.contains_key(session_id)
    }

    pub fn matches_turn(&self, session_id: &str, turn_id: &str) -> bool {
        self.inner
            .get(session_id)
            .is_some_and(|turn| turn.turn_id() == turn_id)
    }

    pub fn matches_agent_session_request(&self, session_id: &str, turn_id: &str) -> bool {
        self.inner
            .get(session_id)
            .is_some_and(|turn| turn.turn_id() == turn_id && turn.is_agent_session_request())
    }

    pub fn suppression_key_for_requester(
        &self,
        target_session_id: &str,
        requester_session_id: &str,
    ) -> Option<(String, String)> {
        self.inner.get(target_session_id).and_then(|active_turn| {
            active_turn
                .should_suppress_cancelled_reply_for_requester(requester_session_id)
                .then(|| {
                    (
                        target_session_id.to_string(),
                        active_turn.turn_id().to_string(),
                    )
                })
        })
    }
}

#[derive(Debug, Default)]
pub struct DialogReplySuppressionSet {
    inner: dashmap::DashMap<(String, String), ()>,
}

impl DialogReplySuppressionSet {
    pub fn mark(&self, session_id: &str, turn_id: &str) {
        self.inner
            .insert((session_id.to_string(), turn_id.to_string()), ());
    }

    pub fn clear(&self, session_id: &str, turn_id: &str) {
        self.inner
            .remove(&(session_id.to_string(), turn_id.to_string()));
    }

    pub fn take(&self, session_id: &str, turn_id: &str) -> bool {
        self.inner
            .remove(&(session_id.to_string(), turn_id.to_string()))
            .is_some()
    }
}

#[derive(Debug, Default)]
pub struct SessionAbortFlags {
    inner: dashmap::DashMap<String, ()>,
}

impl SessionAbortFlags {
    pub fn mark(&self, session_id: &str) {
        self.inner.insert(session_id.to_string(), ());
    }

    pub fn clear(&self, session_id: &str) {
        self.inner.remove(session_id);
    }

    pub fn contains(&self, session_id: &str) -> bool {
        self.inner.contains_key(session_id)
    }
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub enum DialogTurnQueueError {
    Full {
        session_id: String,
        max_depth: usize,
    },
}

impl fmt::Display for DialogTurnQueueError {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        match self {
            Self::Full {
                session_id,
                max_depth,
            } => write!(
                f,
                "Message queue full for session {session_id} (max {max_depth} messages)"
            ),
        }
    }
}

impl std::error::Error for DialogTurnQueueError {}

#[derive(Debug, Clone)]
struct QueuedDialogTurn<T> {
    priority: DialogQueuePriority,
    turn: T,
}

/// Per-session dialog-turn queue with product scheduler priority semantics.
#[derive(Debug)]
pub struct DialogTurnQueue<T> {
    max_depth: usize,
    inner: dashmap::DashMap<String, VecDeque<QueuedDialogTurn<T>>>,
}

impl<T> Default for DialogTurnQueue<T> {
    fn default() -> Self {
        Self::with_max_depth(DEFAULT_MAX_DIALOG_QUEUE_DEPTH)
    }
}

impl<T> DialogTurnQueue<T> {
    pub fn with_max_depth(max_depth: usize) -> Self {
        Self {
            max_depth,
            inner: dashmap::DashMap::new(),
        }
    }

    pub const fn max_depth(&self) -> usize {
        self.max_depth
    }

    pub fn depth(&self, session_id: &str) -> usize {
        self.inner.get(session_id).map(|q| q.len()).unwrap_or(0)
    }

    pub fn has_items(&self, session_id: &str) -> bool {
        self.depth(session_id) > 0
    }

    pub fn enqueue(
        &self,
        session_id: &str,
        turn: T,
        priority: DialogQueuePriority,
    ) -> Result<usize, DialogTurnQueueError> {
        let mut queue = self.inner.entry(session_id.to_string()).or_default();
        if queue.len() >= self.max_depth {
            return Err(DialogTurnQueueError::Full {
                session_id: session_id.to_string(),
                max_depth: self.max_depth,
            });
        }

        let queued = QueuedDialogTurn { priority, turn };
        let insert_at = queue
            .iter()
            .position(|existing| existing.priority < queued.priority);
        if let Some(index) = insert_at {
            queue.insert(index, queued);
        } else {
            queue.push_back(queued);
        }

        Ok(queue.len())
    }

    pub fn clear(&self, session_id: &str) -> Vec<T> {
        self.inner
            .remove(session_id)
            .map(|(_, queue)| queue.into_iter().map(|item| item.turn).collect())
            .unwrap_or_default()
    }

    pub fn dequeue_next(&self, session_id: &str) -> Option<T> {
        let turn = self
            .inner
            .get_mut(session_id)
            .and_then(|mut queue| queue.pop_front().map(|item| item.turn));
        self.inner
            .remove_if(session_id, |_, queue| queue.is_empty());
        turn
    }

    pub fn remove_first_matching<F>(&self, session_id: &str, mut predicate: F) -> Option<T>
    where
        F: FnMut(&T) -> bool,
    {
        let turn = self.inner.get_mut(session_id).and_then(|mut q| {
            q.iter()
                .position(|item| predicate(&item.turn))
                .and_then(|index| q.remove(index).map(|item| item.turn))
        });
        self.inner
            .remove_if(session_id, |_, queue| queue.is_empty());
        turn
    }

    pub fn requeue_front(&self, session_id: &str, turn: T, priority: DialogQueuePriority) {
        self.inner
            .entry(session_id.to_string())
            .or_default()
            .push_front(QueuedDialogTurn { priority, turn });
    }
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct AgentSessionReplyPlan {
    pub target_session_id: String,
    pub target_workspace_path: String,
    pub target_remote_connection_id: Option<String>,
    pub target_remote_ssh_host: Option<String>,
    pub user_input: String,
    pub reminder_text: String,
    pub user_message_metadata: Option<serde_json::Value>,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub enum AgentSessionReplyAction {
    NoReply,
    SkipSuppressedCancelledReply,
    Forward(AgentSessionReplyPlan),
}

#[derive(Debug, Clone, PartialEq)]
pub enum DialogSteeringAction {
    Reject {
        error: String,
    },
    Buffer {
        injection: RoundInjection,
        outcome: DialogSteerOutcome,
    },
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct BackgroundDeliveryFacts {
    pub session_state: DialogSessionStateFact,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum BackgroundDeliveryAction {
    InjectIntoRunningTurn,
    SubmitAgentSessionFollowUp { queue_priority: DialogQueuePriority },
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum BackgroundInjectionKind {
    ThreadGoalObjectiveUpdated,
    BackgroundResult,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum ThreadGoalDeliveryReminderKind {
    GoalContinuation,
    GoalObjectiveUpdated,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct ThreadGoalDeliveryReminder {
    pub kind: ThreadGoalDeliveryReminderKind,
    pub content: String,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct ThreadGoalDeliveryPlan {
    pub injection_prompt: String,
    pub injection_display: String,
    pub display_message: String,
    pub follow_up_user_input: String,
    pub follow_up_original_user_input: Option<String>,
    pub user_message_metadata: serde_json::Value,
    pub prepended_reminders: Vec<ThreadGoalDeliveryReminder>,
}

impl BackgroundDeliveryAction {
    pub const fn follow_up_submission_policy(self) -> Option<DialogSubmissionPolicy> {
        match self {
            Self::InjectIntoRunningTurn => None,
            Self::SubmitAgentSessionFollowUp { queue_priority } => Some(
                DialogSubmissionPolicy::new(DialogTriggerSource::AgentSession, queue_priority),
            ),
        }
    }
}

pub fn build_thread_goal_resumed_delivery_plan(goal: &ThreadGoal) -> ThreadGoalDeliveryPlan {
    let plan = build_thread_goal_continuation_plan(goal);
    let injection_prompt = plan
        .prepended_reminders
        .first()
        .cloned()
        .unwrap_or_default();
    let display_message = plan.display_message;
    ThreadGoalDeliveryPlan {
        injection_prompt,
        injection_display: display_message.clone(),
        display_message: display_message.clone(),
        follow_up_user_input: "Resume working toward the active thread goal.".to_string(),
        follow_up_original_user_input: Some(display_message),
        user_message_metadata: plan.user_message_metadata,
        prepended_reminders: plan
            .prepended_reminders
            .into_iter()
            .map(|content| ThreadGoalDeliveryReminder {
                kind: ThreadGoalDeliveryReminderKind::GoalContinuation,
                content,
            })
            .collect(),
    }
}

pub fn build_thread_goal_objective_updated_delivery_plan(
    goal: &ThreadGoal,
) -> ThreadGoalDeliveryPlan {
    let plan = build_objective_updated_plan(goal);
    let injection_prompt = plan
        .prepended_reminders
        .first()
        .cloned()
        .unwrap_or_default();
    let display_message = plan.display_message;
    ThreadGoalDeliveryPlan {
        injection_prompt,
        injection_display: display_message.clone(),
        display_message: display_message.clone(),
        follow_up_user_input: "Adjust work to match the updated thread goal.".to_string(),
        follow_up_original_user_input: Some(display_message),
        user_message_metadata: plan.user_message_metadata,
        prepended_reminders: plan
            .prepended_reminders
            .into_iter()
            .map(|content| ThreadGoalDeliveryReminder {
                kind: ThreadGoalDeliveryReminderKind::GoalObjectiveUpdated,
                content,
            })
            .collect(),
    }
}

/// Used when no scheduler is wired (e.g. tests, isolated execution).
pub struct NoopDialogRoundInjectionSource;

impl DialogRoundInjectionSource for NoopDialogRoundInjectionSource {
    fn has_pending(&self, _session_id: &str, _turn_id: &str) -> bool {
        false
    }

    fn pending_tool_preemption(
        &self,
        _session_id: &str,
        _turn_id: &str,
    ) -> RoundInjectionToolPreemption {
        RoundInjectionToolPreemption::None
    }

    fn take_pending(&self, _session_id: &str, _turn_id: &str) -> Vec<RoundInjection> {
        Vec::new()
    }
}

#[derive(Clone)]
pub struct DialogRoundInjectionInterrupt {
    session_id: String,
    turn_id: String,
    source: Arc<dyn DialogRoundInjectionSource>,
}

impl std::fmt::Debug for DialogRoundInjectionInterrupt {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.debug_struct("DialogRoundInjectionInterrupt")
            .field("session_id", &self.session_id)
            .field("turn_id", &self.turn_id)
            .finish_non_exhaustive()
    }
}

impl DialogRoundInjectionInterrupt {
    pub fn new(
        session_id: String,
        turn_id: String,
        source: Arc<dyn DialogRoundInjectionSource>,
    ) -> Self {
        Self {
            session_id,
            turn_id,
            source,
        }
    }

    pub fn pending_tool_preemption(&self) -> RoundInjectionToolPreemption {
        self.source
            .pending_tool_preemption(&self.session_id, &self.turn_id)
    }

    pub fn should_interrupt_after_current_atomic_unit(&self) -> bool {
        self.pending_tool_preemption()
            .should_interrupt_after_current_atomic_unit()
    }

    pub fn should_cancel_running_tools(&self) -> bool {
        self.pending_tool_preemption().should_cancel_running_tools()
    }

    pub fn should_interrupt(&self) -> bool {
        self.should_interrupt_after_current_atomic_unit()
    }
}

/// Per-session FIFO buffer of round injections keyed by `session_id`.
#[derive(Debug, Default)]
pub struct SessionRoundInjectionBuffer {
    inner: dashmap::DashMap<String, Vec<RoundInjection>>,
}

impl SessionRoundInjectionBuffer {
    pub fn push(&self, session_id: &str, message: RoundInjection) {
        self.inner
            .entry(session_id.to_string())
            .or_default()
            .push(message);
    }

    /// Drain all messages eligible for the currently running turn. Exact-turn
    /// injections that target a different turn are retained until the targeted
    /// turn consumes them or the session is cleared.
    pub fn drain_for_turn(&self, session_id: &str, turn_id: &str) -> Vec<RoundInjection> {
        self.drain_matching_for_turn(session_id, turn_id, |_| true)
    }

    pub fn drain_matching_for_turn(
        &self,
        session_id: &str,
        turn_id: &str,
        matches: impl Fn(&RoundInjection) -> bool,
    ) -> Vec<RoundInjection> {
        let Some(mut entry) = self.inner.get_mut(session_id) else {
            return Vec::new();
        };
        let mut taken = Vec::new();
        let mut keep = Vec::new();
        for msg in entry.drain(..) {
            if !matches(&msg) {
                keep.push(msg);
                continue;
            }
            match &msg.target {
                RoundInjectionTarget::ExactTurn(target_turn_id) if target_turn_id == turn_id => {
                    taken.push(msg);
                }
                RoundInjectionTarget::CurrentRunningTurn => taken.push(msg),
                RoundInjectionTarget::ExactTurn(_) => keep.push(msg),
            }
        }
        *entry = keep;
        taken
    }

    /// Drop injections whose target was only "whatever turn is currently
    /// running" while retaining messages explicitly bound to a Turn. An
    /// interrupted Turn may resume later, but an unscoped injection must not
    /// leak into a different Turn if the user abandons it.
    pub fn discard_current_running(&self, session_id: &str) {
        let Some(mut entry) = self.inner.get_mut(session_id) else {
            return;
        };
        entry.retain(|message| matches!(message.target, RoundInjectionTarget::ExactTurn(_)));
    }

    pub fn remove_by_id(&self, session_id: &str, injection_id: &str) -> Option<RoundInjection> {
        let mut entry = self.inner.get_mut(session_id)?;
        let index = entry
            .iter()
            .position(|message| message.id == injection_id)?;
        Some(entry.remove(index))
    }

    pub fn has_pending_for_turn(&self, session_id: &str, turn_id: &str) -> bool {
        self.inner
            .get(session_id)
            .map(|entry| {
                entry.iter().any(|msg| match &msg.target {
                    RoundInjectionTarget::ExactTurn(target_turn_id) => target_turn_id == turn_id,
                    RoundInjectionTarget::CurrentRunningTurn => true,
                })
            })
            .unwrap_or(false)
    }

    pub fn pending_tool_preemption_for_turn(
        &self,
        session_id: &str,
        turn_id: &str,
    ) -> RoundInjectionToolPreemption {
        self.inner
            .get(session_id)
            .map(|entry| {
                entry
                    .iter()
                    .filter(|msg| match &msg.target {
                        RoundInjectionTarget::ExactTurn(target_turn_id) => {
                            target_turn_id == turn_id
                        }
                        RoundInjectionTarget::CurrentRunningTurn => true,
                    })
                    .map(|msg| msg.execution_policy.tool_preemption)
                    .max()
                    .unwrap_or(RoundInjectionToolPreemption::None)
            })
            .unwrap_or(RoundInjectionToolPreemption::None)
    }

    /// Drop all messages for a session (e.g. session deleted or unrecoverable error).
    pub fn clear(&self, session_id: &str) {
        self.inner.remove(session_id);
    }

    pub fn pending_count(&self, session_id: &str) -> usize {
        self.inner.get(session_id).map(|v| v.len()).unwrap_or(0)
    }
}

impl DialogRoundInjectionSource for SessionRoundInjectionBuffer {
    fn has_pending(&self, session_id: &str, turn_id: &str) -> bool {
        self.has_pending_for_turn(session_id, turn_id)
    }

    fn pending_tool_preemption(
        &self,
        session_id: &str,
        turn_id: &str,
    ) -> RoundInjectionToolPreemption {
        self.pending_tool_preemption_for_turn(session_id, turn_id)
    }

    fn take_pending(&self, session_id: &str, turn_id: &str) -> Vec<RoundInjection> {
        self.drain_for_turn(session_id, turn_id)
    }
}

pub const fn resolve_background_delivery_action(
    facts: BackgroundDeliveryFacts,
) -> BackgroundDeliveryAction {
    match facts.session_state {
        DialogSessionStateFact::Processing => BackgroundDeliveryAction::InjectIntoRunningTurn,
        DialogSessionStateFact::Missing
        | DialogSessionStateFact::Idle
        | DialogSessionStateFact::Error => {
            let policy = DialogSubmissionPolicy::for_source(DialogTriggerSource::AgentSession);
            BackgroundDeliveryAction::SubmitAgentSessionFollowUp {
                queue_priority: policy.queue_priority,
            }
        }
    }
}

pub fn resolve_background_delivery_injection(
    kind: BackgroundInjectionKind,
    injection_id: String,
    content: String,
    display_content: Option<String>,
    created_at: SystemTime,
) -> RoundInjection {
    let display_content = display_content.unwrap_or_else(|| content.clone());
    let kind = match kind {
        BackgroundInjectionKind::ThreadGoalObjectiveUpdated => {
            RoundInjectionKind::ThreadGoalObjectiveUpdated
        }
        BackgroundInjectionKind::BackgroundResult => RoundInjectionKind::BackgroundResult,
    };
    RoundInjection {
        id: injection_id,
        kind,
        execution_policy: kind.default_execution_policy(),
        target: RoundInjectionTarget::CurrentRunningTurn,
        content,
        display_content,
        attachments: Vec::new(),
        metadata: serde_json::Map::new(),
        created_at,
    }
}

pub fn target_background_delivery_injection_to_turn(
    mut injection: RoundInjection,
    turn_id: String,
) -> RoundInjection {
    injection.target = RoundInjectionTarget::ExactTurn(turn_id);
    injection
}

pub fn resolve_background_delivery_injection_for_turn(
    kind: BackgroundInjectionKind,
    injection_id: String,
    content: String,
    display_content: Option<String>,
    created_at: SystemTime,
    turn_id: String,
) -> RoundInjection {
    target_background_delivery_injection_to_turn(
        resolve_background_delivery_injection(
            kind,
            injection_id,
            content,
            display_content,
            created_at,
        ),
        turn_id,
    )
}

pub fn is_background_result_injection(kind: RoundInjectionKind) -> bool {
    kind == RoundInjectionKind::BackgroundResult
}

/// Outcome of a completed dialog turn, used to notify the concrete scheduler.
#[derive(Debug, Clone)]
pub enum TurnOutcome {
    /// Turn completed normally.
    Completed {
        turn_id: String,
        final_response: String,
    },
    /// Turn was cancelled by user.
    Cancelled { turn_id: String },
    /// Turn was intentionally interrupted and may be recovered in place.
    Interrupted {
        turn_id: String,
        execution_generation: u32,
    },
    /// Turn failed with an error.
    Failed { turn_id: String, error: String },
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum TurnOutcomeQueueAction {
    DispatchNext,
    HoldQueue,
    ClearQueue,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum TurnOutcomeStatus {
    Completed,
    Cancelled,
    Interrupted,
    Failed,
}

impl TurnOutcomeStatus {
    pub const fn as_str(self) -> &'static str {
        match self {
            Self::Completed => "completed",
            Self::Cancelled => "cancelled",
            Self::Interrupted => "interrupted",
            Self::Failed => "failed",
        }
    }
}

impl fmt::Display for TurnOutcomeStatus {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        f.write_str(self.as_str())
    }
}

impl TurnOutcome {
    pub fn turn_id(&self) -> &str {
        match self {
            Self::Completed { turn_id, .. }
            | Self::Cancelled { turn_id }
            | Self::Interrupted { turn_id, .. }
            | Self::Failed { turn_id, .. } => turn_id,
        }
    }

    pub fn status(&self) -> TurnOutcomeStatus {
        match self {
            Self::Completed { .. } => TurnOutcomeStatus::Completed,
            Self::Cancelled { .. } => TurnOutcomeStatus::Cancelled,
            Self::Interrupted { .. } => TurnOutcomeStatus::Interrupted,
            Self::Failed { .. } => TurnOutcomeStatus::Failed,
        }
    }

    pub fn status_str(&self) -> &'static str {
        self.status().as_str()
    }

    pub fn reply_text(&self) -> String {
        match self {
            Self::Completed { final_response, .. } => {
                if final_response.trim().is_empty() {
                    "(no final text response)".to_string()
                } else {
                    final_response.clone()
                }
            }
            Self::Cancelled { .. } => {
                "The target session cancelled this request before producing a final answer."
                    .to_string()
            }
            Self::Interrupted { .. } => {
                "The target session interrupted this request before producing a final answer."
                    .to_string()
            }
            Self::Failed { error, .. } => {
                format!("The target session failed to complete this request.\nError: {error}")
            }
        }
    }

    pub fn queue_action(&self) -> TurnOutcomeQueueAction {
        match self {
            Self::Completed { .. } | Self::Cancelled { .. } => TurnOutcomeQueueAction::DispatchNext,
            Self::Interrupted { .. } => TurnOutcomeQueueAction::HoldQueue,
            Self::Failed { .. } => TurnOutcomeQueueAction::ClearQueue,
        }
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum GoalContinuationAfterTurnAction {
    SkipNoActiveTurn,
    AbortForCancelled,
    AbortForInterrupted,
    Evaluate { turn_completed: bool },
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct TurnOutcomeLifecyclePlan {
    pub status: TurnOutcomeStatus,
    pub queue_action: TurnOutcomeQueueAction,
    pub drain_finished_turn_injections: bool,
    pub goal_continuation: GoalContinuationAfterTurnAction,
}

impl TurnOutcomeLifecyclePlan {
    pub const fn dispatch_next(self) -> bool {
        matches!(self.queue_action, TurnOutcomeQueueAction::DispatchNext)
    }

    pub const fn clear_queue(self) -> bool {
        matches!(self.queue_action, TurnOutcomeQueueAction::ClearQueue)
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct DialogStartRouteFacts {
    pub has_image_contexts: bool,
    pub has_prepended_messages: bool,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum DialogStartRoute {
    Plain,
    WithPrependedMessages,
    WithImageContexts,
    WithImageContextsAndPrependedMessages,
}

pub const fn resolve_dialog_start_route(facts: DialogStartRouteFacts) -> DialogStartRoute {
    match (facts.has_image_contexts, facts.has_prepended_messages) {
        (false, false) => DialogStartRoute::Plain,
        (false, true) => DialogStartRoute::WithPrependedMessages,
        (true, false) => DialogStartRoute::WithImageContexts,
        (true, true) => DialogStartRoute::WithImageContextsAndPrependedMessages,
    }
}

pub fn resolve_turn_outcome_lifecycle_plan(
    outcome: &TurnOutcome,
    has_active_turn: bool,
) -> TurnOutcomeLifecyclePlan {
    let status = outcome.status();
    let goal_continuation = if !has_active_turn {
        GoalContinuationAfterTurnAction::SkipNoActiveTurn
    } else {
        match status {
            TurnOutcomeStatus::Cancelled => GoalContinuationAfterTurnAction::AbortForCancelled,
            TurnOutcomeStatus::Interrupted => GoalContinuationAfterTurnAction::AbortForInterrupted,
            TurnOutcomeStatus::Completed => GoalContinuationAfterTurnAction::Evaluate {
                turn_completed: true,
            },
            TurnOutcomeStatus::Failed => GoalContinuationAfterTurnAction::Evaluate {
                turn_completed: false,
            },
        }
    };

    TurnOutcomeLifecyclePlan {
        status,
        queue_action: outcome.queue_action(),
        // Interrupted is a resumable generation of the same Turn. Steering
        // and background results already accepted for that Turn remain valid
        // until the user either resumes it or explicitly abandons it.
        drain_finished_turn_injections: status != TurnOutcomeStatus::Interrupted,
        goal_continuation,
    }
}

pub fn resolve_agent_session_reply_action(
    responder_session_id: &str,
    active_turn: &ActiveDialogTurn,
    outcome: &TurnOutcome,
    suppressed_cancelled_reply: bool,
) -> AgentSessionReplyAction {
    if !active_turn.is_agent_session_request() {
        return AgentSessionReplyAction::NoReply;
    }

    if should_skip_agent_session_reply(turn_outcome_kind(outcome), suppressed_cancelled_reply) {
        return AgentSessionReplyAction::SkipSuppressedCancelledReply;
    }

    let Some(reply_route) = active_turn.reply_route() else {
        return AgentSessionReplyAction::NoReply;
    };

    let responder_workspace = active_turn
        .workspace_path()
        .unwrap_or("<unknown workspace>");
    let status = outcome.status();
    AgentSessionReplyAction::Forward(AgentSessionReplyPlan {
        target_session_id: reply_route.source_session_id.clone(),
        target_workspace_path: reply_route.source_workspace_path.clone(),
        target_remote_connection_id: reply_route.source_remote_connection_id.clone(),
        target_remote_ssh_host: reply_route.source_remote_ssh_host.clone(),
        user_input: outcome.reply_text(),
        reminder_text: format!(
            "This message is an automated reply to a previous SessionMessage call, not a human user message.\n\
From session: {responder_session_id}\n\
From workspace: {responder_workspace}\n\
Status: {status}"
        ),
        user_message_metadata: active_turn.user_message_metadata().cloned(),
    })
}

pub fn resolve_dialog_steering_action(
    active_turn_id: Option<&str>,
    session_id: &str,
    turn_id: &str,
    content: String,
    display_content: Option<String>,
    attachments: Vec<AgentInputAttachment>,
    metadata: serde_json::Map<String, serde_json::Value>,
    steering_id: String,
    created_at: SystemTime,
) -> DialogSteeringAction {
    if active_turn_id != Some(turn_id) {
        return DialogSteeringAction::Reject {
            error: format!(
                "Dialog turn is no longer running and cannot be steered: session_id={session_id}, turn_id={turn_id}"
            ),
        };
    }

    let display = display_content.unwrap_or_else(|| content.clone());
    DialogSteeringAction::Buffer {
        injection: RoundInjection {
            id: steering_id.clone(),
            kind: RoundInjectionKind::UserSteering,
            execution_policy: RoundInjectionKind::UserSteering.default_execution_policy(),
            target: RoundInjectionTarget::ExactTurn(turn_id.to_string()),
            content,
            display_content: display,
            attachments,
            metadata,
            created_at,
        },
        outcome: DialogSteerOutcome::Buffered {
            session_id: session_id.to_string(),
            turn_id: turn_id.to_string(),
            steering_id,
        },
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn active_turn(turn_id: &str) -> ActiveDialogTurn {
        ActiveDialogTurn::new(
            turn_id.to_string(),
            None,
            None,
            None,
            "Standard".to_string(),
            "input".to_string(),
            None,
            DialogSubmissionPolicy::for_source(DialogTriggerSource::Cli),
            None,
        )
    }

    #[test]
    fn active_turn_store_ignores_an_outcome_from_an_older_turn_generation() {
        let store = ActiveDialogTurnStore::default();
        store.insert("session-1", active_turn("turn-new"));

        assert!(matches!(
            store.take_for_outcome("session-1", "turn-old"),
            ActiveDialogTurnTakeResult::DifferentTurn
        ));
        let ActiveDialogTurnTakeResult::Matched(turn) =
            store.take_for_outcome("session-1", "turn-new")
        else {
            panic!("current turn should be removed");
        };
        assert_eq!(turn.turn_id(), "turn-new");
        assert!(matches!(
            store.take_for_outcome("session-1", "turn-new"),
            ActiveDialogTurnTakeResult::Absent
        ));
    }

    #[test]
    fn dialog_turn_queue_reclaims_empty_session_entries() {
        let queue = DialogTurnQueue::with_max_depth(4);
        queue
            .enqueue("dequeue", 1, DialogQueuePriority::Normal)
            .expect("enqueue");
        queue
            .enqueue("remove", 2, DialogQueuePriority::Normal)
            .expect("enqueue");

        assert_eq!(queue.dequeue_next("dequeue"), Some(1));
        assert_eq!(
            queue.remove_first_matching("remove", |turn| *turn == 2),
            Some(2)
        );
        assert!(queue.inner.is_empty());
    }

    #[test]
    fn outcome_lifecycle_dispatches_completed_turn_and_verifies_goal() {
        let outcome = TurnOutcome::Completed {
            turn_id: "turn_1".to_string(),
            final_response: "done".to_string(),
        };

        let plan = resolve_turn_outcome_lifecycle_plan(&outcome, true);

        assert_eq!(plan.status, TurnOutcomeStatus::Completed);
        assert_eq!(plan.queue_action, TurnOutcomeQueueAction::DispatchNext);
        assert!(plan.drain_finished_turn_injections);
        assert_eq!(
            plan.goal_continuation,
            GoalContinuationAfterTurnAction::Evaluate {
                turn_completed: true
            }
        );
        assert!(plan.dispatch_next());
        assert!(!plan.clear_queue());
    }

    #[test]
    fn outcome_lifecycle_aborts_goal_continuation_for_cancelled_turn() {
        let outcome = TurnOutcome::Cancelled {
            turn_id: "turn_1".to_string(),
        };

        let plan = resolve_turn_outcome_lifecycle_plan(&outcome, true);

        assert_eq!(plan.status, TurnOutcomeStatus::Cancelled);
        assert_eq!(plan.queue_action, TurnOutcomeQueueAction::DispatchNext);
        assert_eq!(
            plan.goal_continuation,
            GoalContinuationAfterTurnAction::AbortForCancelled
        );
        assert!(plan.dispatch_next());
        assert!(!plan.clear_queue());
    }

    #[test]
    fn outcome_lifecycle_holds_queue_for_interrupted_turn() {
        let outcome = TurnOutcome::Interrupted {
            turn_id: "turn_1".to_string(),
            execution_generation: 1,
        };

        let plan = resolve_turn_outcome_lifecycle_plan(&outcome, true);

        assert_eq!(plan.status, TurnOutcomeStatus::Interrupted);
        assert_eq!(plan.queue_action, TurnOutcomeQueueAction::HoldQueue);
        assert!(
            !plan.drain_finished_turn_injections,
            "same-turn injections must survive until recovery or explicit abandonment"
        );
        assert_eq!(
            plan.goal_continuation,
            GoalContinuationAfterTurnAction::AbortForInterrupted
        );
        assert!(!plan.dispatch_next());
        assert!(!plan.clear_queue());
    }

    #[test]
    fn interrupted_turn_discards_only_unscoped_current_turn_injections() {
        let buffer = SessionRoundInjectionBuffer::default();
        buffer.push(
            "session-1",
            resolve_background_delivery_injection(
                BackgroundInjectionKind::ThreadGoalObjectiveUpdated,
                "current".to_string(),
                "current-only".to_string(),
                None,
                SystemTime::now(),
            ),
        );
        buffer.push(
            "session-1",
            target_background_delivery_injection_to_turn(
                resolve_background_delivery_injection(
                    BackgroundInjectionKind::BackgroundResult,
                    "exact".to_string(),
                    "resume-me".to_string(),
                    None,
                    SystemTime::now(),
                ),
                "turn-1".to_string(),
            ),
        );

        buffer.discard_current_running("session-1");

        assert!(buffer.has_pending_for_turn("session-1", "turn-1"));
        assert!(!buffer.has_pending_for_turn("session-1", "turn-2"));
        assert_eq!(buffer.pending_count("session-1"), 1);
    }

    #[test]
    fn outcome_lifecycle_clears_queue_for_failed_turn_and_verifies_goal() {
        let outcome = TurnOutcome::Failed {
            turn_id: "turn_1".to_string(),
            error: "boom".to_string(),
        };

        let plan = resolve_turn_outcome_lifecycle_plan(&outcome, true);

        assert_eq!(plan.status, TurnOutcomeStatus::Failed);
        assert_eq!(plan.queue_action, TurnOutcomeQueueAction::ClearQueue);
        assert_eq!(
            plan.goal_continuation,
            GoalContinuationAfterTurnAction::Evaluate {
                turn_completed: false
            }
        );
        assert!(!plan.dispatch_next());
        assert!(plan.clear_queue());
    }

    #[test]
    fn outcome_lifecycle_skips_goal_when_no_active_turn_exists() {
        let outcome = TurnOutcome::Completed {
            turn_id: "turn_1".to_string(),
            final_response: "done".to_string(),
        };

        let plan = resolve_turn_outcome_lifecycle_plan(&outcome, false);

        assert_eq!(
            plan.goal_continuation,
            GoalContinuationAfterTurnAction::SkipNoActiveTurn
        );
        assert!(plan.dispatch_next());
    }
}
