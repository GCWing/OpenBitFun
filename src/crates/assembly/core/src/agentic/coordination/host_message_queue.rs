//! User queue receipts and management. Execution stays in DialogScheduler.
use super::*;
use openbitfun_runtime_ports::{
    DialogQueueAction, DialogQueueItem, DialogQueueMessage, DialogQueueRequest,
    DialogQueueSnapshot, DialogQueueStatus,
};
use sha2::{Digest, Sha256};
use std::collections::BTreeMap;

// Compact receipts must not be silently evicted: that would allow a delayed
// duplicate to execute twice. At the budget boundary fail admission explicitly.
const RECEIPT_LIMIT: usize = 16_384;
const PREVIEW_CHARS: usize = 2_000;

#[derive(Default)]
pub(super) struct HostQueueState {
    sessions: BTreeMap<String, QueueSession>,
}
struct QueueSession {
    epoch: String,
    revision: u64,
    active_turn_id: Option<String>,
    entries: BTreeMap<String, Entry>,
    order: Vec<String>,
    operations: BTreeMap<String, (String, String)>,
}
struct Entry {
    fingerprint: String,
    view: DialogQueueItem,
    held: Option<QueuedTurn>,
    // User work accepted after this turn settled must outlive its delayed
    // outcome cleanup. This is host-local admission bookkeeping, not wire data.
    after_terminal_turn: Option<String>,
}
impl Default for QueueSession {
    fn default() -> Self {
        Self {
            epoch: Uuid::new_v4().to_string(),
            revision: 0,
            active_turn_id: None,
            entries: BTreeMap::new(),
            order: Vec::new(),
            operations: BTreeMap::new(),
        }
    }
}
fn error(message: impl Into<String>) -> PortError {
    PortError::new(PortErrorKind::InvalidRequest, message)
}
fn fingerprint(value: &impl serde::Serialize) -> PortResult<String> {
    let bytes = serde_json::to_vec(value).map_err(|e| error(e.to_string()))?;
    Ok(format!("{:x}", Sha256::digest(bytes)))
}
impl HostQueueState {
    pub(super) fn pending_steering_ids(
        &self,
        session: &str,
        target: &str,
    ) -> std::collections::HashSet<String> {
        self.sessions
            .get(session)
            .into_iter()
            .flat_map(|queue| queue.entries.values())
            .filter(|entry| {
                entry.view.status == DialogQueueStatus::SteeringPending
                    && entry.view.target_turn_id.as_deref() == Some(target)
            })
            .filter_map(|entry| entry.view.steering_id.clone())
            .collect()
    }
    pub(super) fn contains(&self, session: &str, turn: &str) -> bool {
        self.sessions
            .get(session)
            .is_some_and(|s| s.entries.contains_key(turn))
    }
    pub(super) fn mark_after_terminal_turn(&mut self, session: &str, turn: &str, previous: String) {
        if let Some(e) = self
            .sessions
            .get_mut(session)
            .and_then(|s| s.entries.get_mut(turn))
        {
            e.after_terminal_turn = Some(previous);
        }
    }
    pub(super) fn admitted_after(
        &self,
        session: &str,
        previous: &str,
    ) -> std::collections::HashSet<String> {
        self.sessions
            .get(session)
            .map(|s| {
                s.entries
                    .iter()
                    .filter(|(_, e)| e.after_terminal_turn.as_deref() == Some(previous))
                    .map(|(id, _)| id.clone())
                    .collect()
            })
            .unwrap_or_default()
    }
    pub(super) fn pending_held(&self, session: &str) -> usize {
        self.sessions.get(session).map_or(0, |s| {
            s.entries
                .values()
                .filter(|e| e.held.is_some() && e.view.status.is_pending())
                .count()
        })
    }
    pub(super) fn admission_valid(&self, session: &str, turn: &str) -> bool {
        self.sessions
            .get(session)
            .and_then(|s| s.entries.get(turn))
            .is_none_or(|e| e.view.status == DialogQueueStatus::Queued)
    }
    pub(super) fn retire(&mut self, session: &str) -> Vec<QueuedTurn> {
        let Some(s) = self.sessions.get_mut(session) else {
            return Vec::new();
        };
        s.epoch = Uuid::new_v4().to_string();
        s.revision += 1;
        let mut held = Vec::new();
        for e in s.entries.values_mut() {
            if e.view.status.is_pending() {
                e.view.status = DialogQueueStatus::Cancelled;
                if let Some(turn) = e.held.take() {
                    held.push(turn);
                }
            }
        }
        held
    }
    pub(super) fn cancelled(&mut self, session: &str, turn: &str) {
        if let Some(s) = self.sessions.get_mut(session) {
            if let Some(e) = s.entries.get_mut(turn) {
                e.view.status = DialogQueueStatus::Cancelled;
                e.view.reason = None;
                e.held = None;
                s.revision += 1;
            }
        }
    }
    pub(super) fn started(&mut self, session: &str, turn: &str) {
        if let Some(s) = self.sessions.get_mut(session) {
            if let Some(e) = s.entries.get_mut(turn) {
                e.view.status = DialogQueueStatus::Started;
                e.view.reason = None;
                e.held = None;
                s.revision += 1;
            }
        }
    }
    pub(super) fn hold(&mut self, session: &str, turn: &QueuedTurn, reason: &str) -> bool {
        let Some(s) = self.sessions.get_mut(session) else {
            return false;
        };
        let Some(e) = turn.turn_id.as_ref().and_then(|id| s.entries.get_mut(id)) else {
            return false;
        };
        e.view.status = DialogQueueStatus::Blocked;
        e.view.reason = Some(reason.to_string());
        e.held = Some(turn.clone());
        s.revision += 1;
        true
    }
    pub(super) fn consumed(&mut self, session: &str, target: &str, injection: &str) {
        let Some(s) = self.sessions.get_mut(session) else {
            return;
        };
        for e in s.entries.values_mut() {
            if e.view.status == DialogQueueStatus::SteeringPending
                && e.view.target_turn_id.as_deref() == Some(target)
                && e.view.steering_id.as_deref() == Some(injection)
            {
                e.view.status = DialogQueueStatus::Steered;
                e.held = None;
                s.revision += 1;
                break;
            }
        }
    }
    pub(super) fn outcome(
        &mut self,
        session: &str,
        turn: &str,
        status: TurnOutcomeStatus,
    ) -> Vec<String> {
        let Some(s) = self.sessions.get_mut(session) else {
            return Vec::new();
        };
        let mut retired_injections = Vec::new();
        for (id, e) in &mut s.entries {
            if id == turn
                && matches!(
                    e.view.status,
                    DialogQueueStatus::Started | DialogQueueStatus::Interrupted
                )
            {
                e.view.status = match status {
                    TurnOutcomeStatus::Completed => DialogQueueStatus::Completed,
                    TurnOutcomeStatus::Cancelled => DialogQueueStatus::Cancelled,
                    TurnOutcomeStatus::Interrupted => DialogQueueStatus::Interrupted,
                    _ => DialogQueueStatus::Failed,
                };
                s.revision += 1;
            }
            if e.view.status == DialogQueueStatus::SteeringPending
                && e.view.target_turn_id.as_deref() == Some(turn)
            {
                // Outcome is emitted after the execution future has retired;
                // no outstanding consumer can inject this entry afterwards.
                if let Some(id) = &e.view.steering_id {
                    retired_injections.push(id.clone());
                }
                e.view.status = DialogQueueStatus::Blocked;
                e.view.reason =
                    Some("Steering was not consumed before the target turn ended".into());
                s.revision += 1;
            }
        }
        retired_injections
    }
}
impl DialogScheduler {
    /// Transfer accepted inputs in acceptance order, preserving their original
    /// turn IDs, images, metadata, routing and exactly-once queue receipts.
    pub(super) fn release_steering_turns(&self, session: &str, target: &str) -> bool {
        let managed = self.queue_state().pending_steering_ids(session, target);
        let injections =
            self.round_injection_buffer
                .drain_matching_for_turn(session, target, |message| managed.contains(&message.id));
        let mut turns = Vec::new();
        {
            let mut state = self.queue_state();
            if let Some(s) = state.sessions.get_mut(session) {
                for injection in injections {
                    let entry = s.entries.values_mut().find(|entry| {
                        entry.view.status == DialogQueueStatus::SteeringPending
                            && entry.view.target_turn_id.as_deref() == Some(target)
                            && entry.view.steering_id.as_deref() == Some(&injection.id)
                    });
                    if let Some(entry) = entry {
                        if let Some(turn) = entry.held.take() {
                            entry.view.status = DialogQueueStatus::Queued;
                            entry.view.target_turn_id = None;
                            entry.view.steering_id = None;
                            entry.view.reason = None;
                            s.revision += 1;
                            turns.push(turn);
                        }
                    }
                }
            }
        }
        let released = !turns.is_empty();
        for turn in turns.into_iter().rev() {
            self.requeue_front(session, turn);
        }
        released
    }
    pub(super) fn has_queued_host_message(&self, session: &str) -> bool {
        self.queue_state()
            .sessions
            .get(session)
            .is_some_and(|queue| {
                queue
                    .entries
                    .values()
                    .any(|entry| entry.view.status == DialogQueueStatus::Queued)
            })
    }

    pub(super) fn hold_managed_queue(&self, session: &str, reason: &str) {
        self.hold_managed_queue_for_outcome(session, reason, None);
    }
    pub(super) fn hold_managed_queue_for_outcome(
        &self,
        session: &str,
        reason: &str,
        previous: Option<&str>,
    ) {
        let ids: Vec<String> = self
            .queue_state()
            .sessions
            .get(session)
            .map(|s| {
                s.entries
                    .iter()
                    .filter(|(_, e)| {
                        e.view.status == DialogQueueStatus::Queued
                            && previous
                                .is_none_or(|id| e.after_terminal_turn.as_deref() != Some(id))
                    })
                    .map(|(id, _)| id.clone())
                    .collect()
            })
            .unwrap_or_default();
        for id in ids {
            if let Some(turn) = remove_queued_turn_by_id(&self.queues, session, &id) {
                self.queue_state().hold(session, &turn, reason);
            }
        }
    }
    fn queue_state(&self) -> std::sync::MutexGuard<'_, HostQueueState> {
        self.host_queue.lock().unwrap_or_else(|e| e.into_inner())
    }
    fn queue_snapshot(&self, session: &str, receipt_id: Option<&str>) -> DialogQueueSnapshot {
        let mut state = self.queue_state();
        let s = state.sessions.entry(session.to_string()).or_default();
        let active_turn_id = self
            .session_manager
            .get_session(session)
            .and_then(|session| match &session.state {
                SessionState::Processing {
                    current_turn_id, ..
                } => Some(current_turn_id.clone()),
                _ => None,
            });
        if s.active_turn_id != active_turn_id {
            s.active_turn_id = active_turn_id.clone();
            s.revision += 1;
        }
        let items = s
            .order
            .iter()
            .filter_map(|id| s.entries.get(id))
            .filter(|e| e.view.status.is_pending())
            .map(|e| e.view.clone())
            .collect();
        let held = s
            .entries
            .values()
            .filter(|e| e.held.is_some() && e.view.status.is_pending())
            .count();
        DialogQueueSnapshot {
            session_id: session.to_string(),
            queue_epoch: s.epoch.clone(),
            revision: s.revision,
            active_turn_id,
            items,
            capacity: self.queues.max_depth(),
            used: self.queues.depth(session) + held,
            receipt: receipt_id
                .and_then(|id| s.entries.get(id))
                .map(|e| e.view.clone()),
        }
    }
    pub(super) async fn manage_host_queue(
        &self,
        request: DialogQueueRequest,
    ) -> PortResult<DialogQueueSnapshot> {
        // Once sent to the host, a mutation must outlive a disconnected RPC.
        let scheduler = self
            .self_ref
            .upgrade()
            .ok_or_else(|| error("Queue owner unavailable"))?;
        tokio::spawn(async move { scheduler.execute_queue_request(request).await })
            .await
            .map_err(|e| PortError::new(PortErrorKind::Backend, e.to_string()))?
    }
    pub(super) async fn execute_queue_request(
        &self,
        request: DialogQueueRequest,
    ) -> PortResult<DialogQueueSnapshot> {
        let session = &request.session_id;
        openbitfun_core_types::validate_session_id(session).map_err(error)?;
        let _admission = self.host_queue_locks.lock(session).await;
        if self.session_manager.get_session(session).is_none() {
            return Err(PortError::new(
                PortErrorKind::NotFound,
                "Session is not loaded on the execution host",
            ));
        }
        let snapshot = self.queue_snapshot(session, None);
        if !matches!(request.action, DialogQueueAction::List)
            && request.queue_epoch.as_deref() != Some(snapshot.queue_epoch.as_str())
        {
            return Err(error(
                "queue_scope_expired: refresh the host queue; do not automatically resend",
            ));
        }
        match request.action {
            DialogQueueAction::List => {
                let _guard = self.lock_session_operation(session).await;
                Ok(self.queue_snapshot(session, None))
            }
            DialogQueueAction::Get { turn_id } => {
                let _guard = self.lock_session_operation(session).await;
                Ok(self.queue_snapshot(session, Some(&turn_id)))
            }
            DialogQueueAction::Submit { message } => {
                self.submit_host_message(session, message).await
            }
            action => self.mutate_host_queue(session, action).await,
        }
    }
    async fn submit_host_message(
        &self,
        session: &str,
        message: DialogQueueMessage,
    ) -> PortResult<DialogQueueSnapshot> {
        if message.turn_id.trim().is_empty()
            || message.turn_id.len() > 200
            || (message.content.trim().is_empty() && message.attachments.is_empty())
        {
            return Err(error(
                "A stable turn ID and message content or attachments are required",
            ));
        }
        let digest = fingerprint(&message)?;
        {
            let mut state = self.queue_state();
            let s = state.sessions.get_mut(session).expect("queue initialized");
            if let Some(e) = s.entries.get(&message.turn_id) {
                if e.fingerprint != digest {
                    return Err(error("idempotency_conflict: message payload changed"));
                }
                drop(state);
                return Ok(self.queue_snapshot(session, Some(&message.turn_id)));
            }
            // Accepted duplicates remain readable/idempotent. A new message
            // must be rejected before creating a durable queue receipt.
            let binding = self
                .session_manager
                .get_session(session)
                .ok_or_else(|| error("Session was removed"))?;
            ensure_session_accepts_conversation(&binding)
                .map_err(|failure| error(failure.to_string()))?;
            if s.entries.len() + s.operations.len() >= RECEIPT_LIMIT {
                return Err(error("Queue receipt budget exhausted; start a new session"));
            }
            if self.queues.depth(session) + s.entries.values().filter(|e| e.held.is_some()).count()
                >= self.queues.max_depth()
            {
                return Err(error("Message queue is full"));
            }
            let display = message
                .display_content
                .as_deref()
                .unwrap_or(&message.content);
            let view = DialogQueueItem {
                turn_id: message.turn_id.clone(),
                display_content: display.chars().take(PREVIEW_CHARS).collect(),
                preview_truncated: display.chars().count() > PREVIEW_CHARS,
                attachment_count: message.attachments.len(),
                agent_type: message.agent_type.clone(),
                created_at_ms: SystemTime::now()
                    .duration_since(SystemTime::UNIX_EPOCH)
                    .unwrap_or_default()
                    .as_millis() as u64,
                status: DialogQueueStatus::Queued,
                reason: None,
                target_turn_id: None,
                steering_id: None,
            };
            s.entries.insert(
                message.turn_id.clone(),
                Entry {
                    fingerprint: digest,
                    view,
                    held: None,
                    after_terminal_turn: None,
                },
            );
            s.order.push(message.turn_id.clone());
        }
        let binding = self
            .session_manager
            .get_session(session)
            .ok_or_else(|| error("Session was removed"))?;
        let mut metadata = message.metadata;
        for key in [
            "acp_transport",
            "backgroundTaskId",
            "parentSessionId",
            "parentDialogTurnId",
            "subagentSessionId",
            "subagentDialogTurnId",
            "require_tool_confirmation",
        ] {
            metadata.remove(key);
        }
        let request = AgentDialogTurnRequest {
            session_id: session.to_string(),
            message: message.content,
            original_message: message.display_content,
            turn_id: Some(message.turn_id.clone()),
            agent_type: message.agent_type,
            workspace_path: binding.config.workspace_path.clone(),
            workspace_id: None,
            remote_connection_id: binding.config.remote_connection_id.clone(),
            remote_ssh_host: binding.config.remote_ssh_host.clone(),
            policy: DialogSubmissionPolicy::for_source(DialogTriggerSource::DesktopUi),
            execution: Default::default(),
            output_schema: None,
            reply_route: None,
            prepended_reminders: Vec::new(),
            attachments: message.attachments,
            metadata,
        };
        let result = AgentDialogTurnPort::submit_dialog_turn(self, request).await;
        let mut state = self.queue_state();
        let s = state.sessions.get_mut(session).expect("queue initialized");
        if let Err(err) = result {
            s.entries.remove(&message.turn_id);
            s.order.retain(|id| id != &message.turn_id);
            return Err(err);
        }
        s.revision += 1;
        drop(state);
        Ok(self.queue_snapshot(session, Some(&message.turn_id)))
    }
    async fn mutate_host_queue(
        &self,
        session: &str,
        action: DialogQueueAction,
    ) -> PortResult<DialogQueueSnapshot> {
        let digest = fingerprint(&action)?;
        let (id, operation) = match &action {
            DialogQueueAction::Cancel {
                turn_id,
                operation_id,
            }
            | DialogQueueAction::Promote {
                turn_id,
                operation_id,
                ..
            } => (turn_id.clone(), operation_id.clone()),
            _ => return Err(error("Invalid queue operation")),
        };
        if operation.trim().is_empty() || operation.len() > 200 {
            return Err(error("A stable operation ID is required"));
        }
        let _guard = self.lock_session_operation(session).await;
        {
            let state = self.queue_state();
            let s = state.sessions.get(session).expect("queue initialized");
            if let Some((previous, previous_id)) = s.operations.get(&operation) {
                if previous != &digest {
                    return Err(error("idempotency_conflict: operation changed"));
                }
                let previous_id = previous_id.clone();
                drop(state);
                return Ok(self.queue_snapshot(session, Some(&previous_id)));
            }
            if s.entries.len() + s.operations.len() >= RECEIPT_LIMIT {
                return Err(error("Queue receipt budget exhausted"));
            }
            let entry = s
                .entries
                .get(&id)
                .ok_or_else(|| error("Queue entry not found"))?;
            if !matches!(
                entry.view.status,
                DialogQueueStatus::Queued | DialogQueueStatus::Blocked
            ) {
                return Err(error(
                    "too_late: message is no longer available for this queue operation",
                ));
            }
        }
        let mut interrupted_turn_to_abandon = None;
        if let DialogQueueAction::Promote {
            expected_active_turn_id,
            ..
        } = &action
        {
            let actual = self.queue_snapshot(session, None).active_turn_id;
            if &actual != expected_active_turn_id {
                return Err(error("queue_conflict: active turn changed"));
            }
            if expected_active_turn_id
                .as_deref()
                .is_some_and(|target| !self.active_turns.matches_turn(session, target))
            {
                return Err(error("queue_conflict: target is no longer active"));
            }
            if expected_active_turn_id.is_none() && self.active_turns.contains(session) {
                return Err(error("queue_conflict: previous turn is still retiring"));
            }
            if expected_active_turn_id.is_none()
                && self
                    .session_manager
                    .latest_dialog_turn_holds_dispatch(session)
                    .await
                    .map_err(|e| error(e.to_string()))?
            {
                interrupted_turn_to_abandon = self
                    .session_manager
                    .get_session(session)
                    .and_then(|s| s.dialog_turn_ids.last().cloned());
                self.hold_managed_queue(session, "Turn interrupted; retry this message explicitly");
            }
        }
        let held = {
            let mut state = self.queue_state();
            state
                .sessions
                .get_mut(session)
                .and_then(|s| s.entries.get_mut(&id))
                .and_then(|e| e.held.take())
        };
        let turn = held
            .or_else(|| remove_queued_turn_by_id(&self.queues, session, &id))
            .ok_or_else(|| error("too_late: message has already started"))?;
        match &action {
            DialogQueueAction::Cancel { .. } => {
                self.finish_removed_queued_turn(session, turn).await;
                self.queue_state()
                    .sessions
                    .get_mut(session)
                    .unwrap()
                    .entries
                    .get_mut(&id)
                    .unwrap()
                    .view
                    .status = DialogQueueStatus::Cancelled;
            }
            DialogQueueAction::Promote {
                expected_active_turn_id: Some(target),
                ..
            } => {
                let attachments = turn
                    .image_contexts
                    .clone()
                    .unwrap_or_default()
                    .into_iter()
                    .map(|image| {
                        AgentInputAttachment::image_context(
                            image.id,
                            image.image_path,
                            image.data_url,
                            image.mime_type,
                            image.metadata,
                        )
                    })
                    .collect();
                let steering_id = Uuid::new_v4().to_string();
                let metadata = turn
                    .user_message_metadata
                    .as_ref()
                    .and_then(|v| v.as_object())
                    .cloned()
                    .unwrap_or_default();
                let decision = resolve_dialog_steering_action(
                    Some(target),
                    session,
                    target,
                    turn.user_input.clone(),
                    turn.original_user_input.clone(),
                    attachments,
                    metadata,
                    steering_id.clone(),
                    SystemTime::now(),
                );
                if let DialogSteeringAction::Buffer { injection, .. } = decision {
                    {
                        let mut state = self.queue_state();
                        let e = state
                            .sessions
                            .get_mut(session)
                            .unwrap()
                            .entries
                            .get_mut(&id)
                            .unwrap();
                        e.view.status = DialogQueueStatus::SteeringPending;
                        e.view.reason = None;
                        e.view.target_turn_id = Some(target.clone());
                        e.view.steering_id = Some(steering_id);
                        e.held = Some(turn);
                    }
                    self.round_injection_buffer.push(session, injection);
                } else {
                    self.queue_state()
                        .hold(session, &turn, "Unable to steer queued message");
                    return Err(error("Unable to steer queued message"));
                }
            }
            DialogQueueAction::Promote {
                expected_active_turn_id: None,
                ..
            } => match self.start_turn(session, &turn).await {
                Err(e) => {
                    self.queue_state().hold(session, &turn, &e.to_string());
                }
                Ok(_) => {
                    if let Err(e) = self
                        .abandon_superseded_interrupted_turn(
                            session,
                            interrupted_turn_to_abandon.as_deref(),
                        )
                        .await
                    {
                        warn!("Failed to retire interrupted recovery after explicit queue promotion: session_id={}, error={}", session, e);
                    }
                }
            },
            _ => unreachable!(),
        }
        {
            let mut state = self.queue_state();
            let s = state.sessions.get_mut(session).unwrap();
            s.operations.insert(operation, (digest, id.clone()));
            s.revision += 1;
        }
        if matches!(action, DialogQueueAction::Cancel { .. }) {
            // Removing the final held message releases otherwise healthy work.
            let _ = self.try_start_next_queued_locked(session).await;
        }
        Ok(self.queue_snapshot(session, Some(&id)))
    }
}
