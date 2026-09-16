//! Portable contracts for user-question tool handlers.

use log::{debug, info, warn};
use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
use std::collections::HashMap;
use std::sync::{Arc, LazyLock, Mutex, MutexGuard, Weak};
use std::time::{SystemTime, UNIX_EPOCH};
use tokio::sync::{oneshot, watch};

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
pub struct QuestionOption {
    pub label: String,
    pub description: String,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
pub struct Question {
    pub question: String,
    pub header: String,
    pub options: Vec<QuestionOption>,
    #[serde(rename = "multiSelect", default)]
    pub multi_select: bool,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
pub struct AskUserQuestionInput {
    pub questions: Vec<Question>,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct UserQuestionToolResult {
    pub data: Value,
    pub result_for_assistant: String,
}

#[derive(Debug, Clone)]
pub struct UserInputResponse {
    pub answers: Value,
}

/// One blocking user-question interaction owned by the running Agent Runtime.
///
/// This is process-local live state, not persisted Session history. Product
/// surfaces use it to re-attach after an event gap without restarting or
/// cancelling the Dialog Turn that is waiting for the answer.
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct PendingUserQuestion {
    pub tool_id: String,
    pub session_id: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub dialog_turn_id: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub model_round_id: Option<String>,
    pub questions: Value,
    pub registered_at_ms: u64,
    #[serde(default, skip_serializing_if = "std::ops::Not::not")]
    pub interaction_started: bool,
}

impl PendingUserQuestion {
    pub fn new(
        tool_id: impl Into<String>,
        session_id: impl Into<String>,
        dialog_turn_id: Option<String>,
        model_round_id: Option<String>,
        questions: Value,
    ) -> Self {
        Self {
            tool_id: tool_id.into(),
            session_id: session_id.into(),
            dialog_turn_id,
            model_round_id,
            questions,
            interaction_started: false,
            registered_at_ms: SystemTime::now()
                .duration_since(UNIX_EPOCH)
                .unwrap_or_default()
                .as_millis()
                .min(u64::MAX as u128) as u64,
        }
    }
}

/// A coherent, monotonic view of the user-question mailbox for one Session.
#[derive(Debug, Clone, Default, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct PendingUserQuestionSnapshot {
    pub revision: u64,
    #[serde(default)]
    pub questions: Vec<PendingUserQuestion>,
}

#[derive(Debug, Clone, PartialEq, Eq, thiserror::Error)]
pub enum UserInputSendError {
    #[error("Waiting channel not found: {tool_id}")]
    MissingChannel { tool_id: String },
    #[error("Channel closed, cannot send answer: {tool_id}")]
    ChannelClosed { tool_id: String },
}

pub const USER_INPUT_PARENT_CONTEXT_KEY: &str = "user_input_parent_controller";

/// Trusted execution lineage, not model-supplied question parameters.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct UserQuestionController {
    pub session_id: String,
    pub dialog_turn_id: Option<String>,
}

struct PendingUserInput {
    sender: oneshot::Sender<UserInputResponse>,
    question: Option<PendingUserQuestion>,
    controllers: Vec<UserQuestionController>,
    registration_sequence: u64,
    interaction_started: watch::Sender<bool>,
}

impl PendingUserInput {
    fn controlled_by(&self, session_id: &str) -> bool {
        self.question
            .as_ref()
            .is_some_and(|question| question.session_id == session_id)
            || self
                .controllers
                .iter()
                .any(|controller| controller.session_id == session_id)
    }
}

struct UserInputState {
    pending: HashMap<String, PendingUserInput>,
    next_registration_sequence: u64,
    revision: u64,
    changes: watch::Sender<u64>,
}

impl Default for UserInputState {
    fn default() -> Self {
        Self {
            pending: HashMap::new(),
            next_registration_sequence: 0,
            revision: 0,
            changes: watch::channel(0).0,
        }
    }
}
impl UserInputState {
    fn bump_revision(&mut self) {
        self.revision = self.revision.saturating_add(1);
        self.changes.send_replace(self.revision);
    }
}

/// Drop guard tying a pending mailbox record to the Tool future that waits on
/// it. Cancelling a Dialog Turn drops the future and therefore removes the
/// request instead of leaving an unanswerable stale interaction behind.
#[must_use = "keep the registration alive while awaiting the user response"]
pub struct UserInputRegistration {
    state: Weak<Mutex<UserInputState>>,
    tool_id: String,
    registration_sequence: u64,
    interaction_started: watch::Receiver<bool>,
}

impl UserInputRegistration {
    /// Atomically arbitrate timeout against the first interaction or answer.
    fn expire_if_unstarted(&self) -> bool {
        let Some(state) = self.state.upgrade() else {
            return false;
        };
        let mut state = lock_user_input_state(&state);
        let can_expire = state.pending.get(&self.tool_id).is_some_and(|pending| {
            pending.registration_sequence == self.registration_sequence
                && !*pending.interaction_started.borrow()
        });
        if can_expire {
            state.pending.remove(&self.tool_id);
            state.bump_revision();
        }
        can_expire
    }
}

pub enum UserQuestionWaitOutcome {
    Answered(UserInputResponse),
    Cancelled,
    TimedOut,
}

/// The deadline only applies while unattended. Interaction permanently removes
/// the deadline for this question; submitting and cancelling keep their meaning.
pub async fn wait_for_user_question_response(
    registration: &UserInputRegistration,
    response: oneshot::Receiver<UserInputResponse>,
    unattended_timeout: impl Into<Option<std::time::Duration>>,
) -> UserQuestionWaitOutcome {
    let deadline = unattended_timeout
        .into()
        .map(|timeout| tokio::time::Instant::now() + timeout);
    wait_for_user_question_response_until(registration, response, deadline).await
}

/// Uses the deadline captured when the question was registered, including event delivery time.
pub async fn wait_for_user_question_response_until(
    registration: &UserInputRegistration,
    mut response: oneshot::Receiver<UserInputResponse>,
    deadline: Option<tokio::time::Instant>,
) -> UserQuestionWaitOutcome {
    let mut activity = registration.interaction_started.clone();
    let result = tokio::select! {
        biased;
        result = &mut response => result,
        _ = async { let _ = activity.wait_for(|started| *started).await; } => response.await,
        _ = async { match deadline { Some(deadline) => tokio::time::sleep_until(deadline).await, None => std::future::pending::<()>().await } } => {
            if registration.expire_if_unstarted() {
                return UserQuestionWaitOutcome::TimedOut;
            }
            response.await
        }
    };
    match result {
        Ok(answer) => UserQuestionWaitOutcome::Answered(answer),
        Err(_) => UserQuestionWaitOutcome::Cancelled,
    }
}

impl Drop for UserInputRegistration {
    fn drop(&mut self) {
        let Some(state) = self.state.upgrade() else {
            return;
        };
        let mut state = lock_user_input_state(&state);
        let belongs_to_registration = state
            .pending
            .get(&self.tool_id)
            .is_some_and(|pending| pending.registration_sequence == self.registration_sequence);
        if belongs_to_registration {
            state.pending.remove(&self.tool_id);
            state.bump_revision();
            debug!(
                "Removed dropped user-input registration: tool_id={}",
                self.tool_id
            );
        }
    }
}

#[derive(Clone)]
pub struct UserInputManager {
    state: Arc<Mutex<UserInputState>>,
}

impl Default for UserInputManager {
    fn default() -> Self {
        Self::new()
    }
}

impl UserInputManager {
    pub fn new() -> Self {
        Self {
            state: Arc::new(Mutex::new(UserInputState::default())),
        }
    }

    /// Coalesced invalidation of the live question mailbox. Consumers read
    /// pending_question_counts plus their previous session set to also publish
    /// removals; no tool payload or bounded queue sits on the execution path.
    pub fn subscribe_changes(&self) -> watch::Receiver<u64> {
        lock_user_input_state(&self.state).changes.subscribe()
    }

    pub fn register_channel(&self, tool_id: String, sender: oneshot::Sender<UserInputResponse>) {
        debug!("Registered waiting channel: tool_id={}", tool_id);
        self.insert_pending(tool_id, sender, None, Vec::new());
    }

    /// Register a replayable user question and return the lifetime guard for
    /// the Tool future that owns it.
    pub fn register_question(
        &self,
        question: PendingUserQuestion,
        sender: oneshot::Sender<UserInputResponse>,
    ) -> UserInputRegistration {
        self.register_question_with_controllers(question, sender, Vec::new())
    }

    pub fn register_question_with_controllers(
        &self,
        question: PendingUserQuestion,
        sender: oneshot::Sender<UserInputResponse>,
        controllers: Vec<UserQuestionController>,
    ) -> UserInputRegistration {
        let tool_id = question.tool_id.clone();
        debug!(
            "Registered pending user question: tool_id={}, session_id={}",
            tool_id, question.session_id
        );
        let (registration_sequence, interaction_started) =
            self.insert_pending(tool_id.clone(), sender, Some(question), controllers);
        UserInputRegistration {
            state: Arc::downgrade(&self.state),
            tool_id,
            registration_sequence,
            interaction_started,
        }
    }

    fn insert_pending(
        &self,
        tool_id: String,
        sender: oneshot::Sender<UserInputResponse>,
        question: Option<PendingUserQuestion>,
        controllers: Vec<UserQuestionController>,
    ) -> (u64, watch::Receiver<bool>) {
        let (interaction_started, activity) = watch::channel(false);
        let mut state = lock_user_input_state(&self.state);
        let registration_sequence = state.next_registration_sequence;
        state.next_registration_sequence = state.next_registration_sequence.saturating_add(1);
        state.pending.insert(
            tool_id,
            PendingUserInput {
                sender,
                question,
                controllers,
                registration_sequence,
                interaction_started,
            },
        );
        state.bump_revision();
        (registration_sequence, activity)
    }

    /// Session-scoped, idempotent acknowledgement; never consumes an answer.
    pub fn start_interaction(
        &self,
        session_id: &str,
        tool_id: &str,
    ) -> Result<(), UserInputSendError> {
        let mut state = lock_user_input_state(&self.state);
        let pending = state
            .pending
            .get_mut(tool_id)
            .filter(|pending| pending.controlled_by(session_id))
            .ok_or_else(|| UserInputSendError::MissingChannel {
                tool_id: tool_id.to_string(),
            })?;
        if !*pending.interaction_started.borrow() {
            pending.interaction_started.send_replace(true);
            if let Some(question) = pending.question.as_mut() {
                question.interaction_started = true;
                if let Some(payload) = question.questions.as_object_mut() {
                    payload.insert("responseDeadlineMs".into(), Value::Null);
                }
            }
            state.bump_revision();
        }
        Ok(())
    }

    pub fn send_answer(&self, tool_id: &str, answers: Value) -> Result<(), UserInputSendError> {
        info!("Sending user answer: tool_id={}", tool_id);

        let pending = {
            let mut state = lock_user_input_state(&self.state);
            let pending = state.pending.remove(tool_id);
            if pending.is_some() {
                state.bump_revision();
            }
            pending
        };
        if let Some(pending) = pending {
            let response = UserInputResponse { answers };
            pending
                .sender
                .send(response)
                .map_err(|_| UserInputSendError::ChannelClosed {
                    tool_id: tool_id.to_string(),
                })?;
            debug!("Answer sent: tool_id={}", tool_id);
            Ok(())
        } else {
            let error = UserInputSendError::MissingChannel {
                tool_id: tool_id.to_string(),
            };
            warn!("{}", error);
            Err(error)
        }
    }

    pub fn cancel_for_session(
        &self,
        session_id: &str,
        tool_id: &str,
    ) -> Result<(), UserInputSendError> {
        let mut state = lock_user_input_state(&self.state);
        if !state
            .pending
            .get(tool_id)
            .is_some_and(|pending| pending.controlled_by(session_id))
        {
            return Err(UserInputSendError::MissingChannel {
                tool_id: tool_id.to_string(),
            });
        }
        state.pending.remove(tool_id);
        state.bump_revision();
        Ok(())
    }

    pub fn cancel(&self, tool_id: &str) -> bool {
        let removed = {
            let mut state = lock_user_input_state(&self.state);
            let removed = state.pending.remove(tool_id).is_some();
            if removed {
                state.bump_revision();
            }
            removed
        };
        if removed {
            debug!("Cancelled waiting: tool_id={}", tool_id);
            true
        } else {
            false
        }
    }

    pub fn has_pending(&self, tool_id: &str) -> bool {
        lock_user_input_state(&self.state)
            .pending
            .contains_key(tool_id)
    }

    pub fn pending_tool_ids(&self) -> Vec<String> {
        let state = lock_user_input_state(&self.state);
        let mut pending = state
            .pending
            .iter()
            .map(|(tool_id, entry)| (entry.registration_sequence, tool_id.clone()))
            .collect::<Vec<_>>();
        pending.sort_by_key(|(sequence, _)| *sequence);
        pending.into_iter().map(|(_, tool_id)| tool_id).collect()
    }

    /// Compact batch read for navigation; do not clone question/tool payloads.
    pub fn pending_question_counts(&self) -> HashMap<String, usize> {
        let state = lock_user_input_state(&self.state);
        let mut counts = HashMap::new();
        for pending in state.pending.values() {
            if let Some(question) = &pending.question {
                let mut sessions = std::collections::HashSet::from([question.session_id.clone()]);
                sessions.extend(
                    pending
                        .controllers
                        .iter()
                        .map(|controller| controller.session_id.clone()),
                );
                for session_id in sessions {
                    *counts.entry(session_id).or_default() += 1;
                }
            }
        }
        counts
    }

    pub fn pending_question_snapshot(&self, session_id: &str) -> PendingUserQuestionSnapshot {
        let state = lock_user_input_state(&self.state);
        let mut questions = state
            .pending
            .values()
            .filter_map(|pending| {
                if !pending.controlled_by(session_id) {
                    return None;
                }
                pending.question.clone().map(|mut question| {
                    if question.questions.get("responseDeadlineMs").is_some() {
                        question.questions["responseHostNowMs"] = json!(SystemTime::now()
                            .duration_since(UNIX_EPOCH)
                            .unwrap_or_default()
                            .as_millis()
                            as u64);
                    }
                    if question.session_id != session_id {
                        if let Some(controller) = pending
                            .controllers
                            .iter()
                            .find(|controller| controller.session_id == session_id)
                        {
                            question.session_id = controller.session_id.clone();
                            question.dialog_turn_id = controller.dialog_turn_id.clone();
                            question.model_round_id = None;
                        }
                    }
                    (pending.registration_sequence, question)
                })
            })
            .collect::<Vec<_>>();
        questions.sort_by_key(|(sequence, _)| *sequence);
        PendingUserQuestionSnapshot {
            revision: state.revision,
            questions: questions
                .into_iter()
                .map(|(_, question)| question)
                .collect(),
        }
    }
}

fn lock_user_input_state(state: &Mutex<UserInputState>) -> MutexGuard<'_, UserInputState> {
    state
        .lock()
        .unwrap_or_else(|poisoned| poisoned.into_inner())
}

pub static USER_INPUT_MANAGER: LazyLock<UserInputManager> = LazyLock::new(|| {
    debug!("Initializing global user input manager");
    UserInputManager::new()
});

pub fn get_user_input_manager() -> &'static UserInputManager {
    &USER_INPUT_MANAGER
}

pub const USER_INPUT_AVAILABLE_CONTEXT_KEY: &str = "user_input_available";
/// Internal ToolUseContext key carrying the model round that owns a question.
pub const USER_INPUT_MODEL_ROUND_CONTEXT_KEY: &str = "user_input_model_round_id";

pub fn ask_user_question_available_for_acp_transport(acp_transport: Option<&Value>) -> bool {
    !acp_transport.is_some_and(|value| value == "true" || value == &json!(true))
}

pub fn ask_user_question_available_in_context(
    acp_transport: Option<&Value>,
    user_input_available: Option<&Value>,
) -> bool {
    ask_user_question_available_for_acp_transport(acp_transport)
        && !user_input_available.is_some_and(|value| value == "false" || value == &json!(false))
}

pub fn validate_ask_user_question_input(input: &AskUserQuestionInput) -> Result<(), String> {
    if input.questions.is_empty() {
        return Err("At least one question is required".to_string());
    }
    if input.questions.len() > 4 {
        return Err("Maximum 4 questions allowed".to_string());
    }

    for (q_idx, question) in input.questions.iter().enumerate() {
        let q_num = q_idx + 1;

        if question.question.trim().is_empty() {
            return Err(format!("Question {} text is required", q_num));
        }

        if question.header.trim().is_empty() {
            return Err(format!("Question {} header is required", q_num));
        }
        if question.header.chars().count() > 20 {
            return Err(format!(
                "Question {} header must be less than 20 characters",
                q_num
            ));
        }

        if question.options.len() < 2 || question.options.len() > 10 {
            return Err(format!("Question {} must have 2-10 options", q_num));
        }

        for (opt_idx, opt) in question.options.iter().enumerate() {
            if opt.label.trim().is_empty() {
                return Err(format!(
                    "Question {} option {} label is required",
                    q_num,
                    opt_idx + 1
                ));
            }
            if opt.description.trim().is_empty() {
                return Err(format!(
                    "Question {} option {} description is required",
                    q_num,
                    opt_idx + 1
                ));
            }
        }
    }

    Ok(())
}

pub fn build_answered_user_question_result(
    input: &AskUserQuestionInput,
    answers: Value,
) -> UserQuestionToolResult {
    let result_for_assistant = format_result_for_assistant(&input.questions, &answers);
    let questions_summary: Vec<Value> = input
        .questions
        .iter()
        .map(|question| {
            json!({
                "question": question.question,
                "header": question.header
            })
        })
        .collect();

    UserQuestionToolResult {
        data: json!({
            "questions": questions_summary,
            "answers": answers,
            "status": "answered"
        }),
        result_for_assistant,
    }
}

pub fn build_cancelled_user_question_result(
    input: &AskUserQuestionInput,
) -> UserQuestionToolResult {
    UserQuestionToolResult {
        data: json!({
            "questions_count": input.questions.len(),
            "status": "cancelled"
        }),
        result_for_assistant: "User input request was cancelled.".to_string(),
    }
}

pub fn build_timed_out_user_question_result(
    input: &AskUserQuestionInput,
) -> UserQuestionToolResult {
    UserQuestionToolResult {
        data: json!({
            "questions_count": input.questions.len(),
            "status": "timeout"
        }),
        result_for_assistant: "The user did not respond before the timeout. Skip the questions and continue execution.".to_string(),
    }
}

fn format_result_for_assistant(questions: &[Question], answers: &Value) -> String {
    let answers_obj = answers
        .as_object()
        .or_else(|| answers.get("answers").and_then(|v| v.as_object()));

    if let Some(answers_map) = answers_obj {
        let mut result_lines = vec!["User has answered your questions:".to_string()];

        for (idx, question) in questions.iter().enumerate() {
            let idx_str = idx.to_string();
            let answer_text = if let Some(answer_value) = answers_map.get(&idx_str) {
                if let Some(arr) = answer_value.as_array() {
                    arr.iter()
                        .filter_map(|v| v.as_str())
                        .collect::<Vec<_>>()
                        .join(", ")
                } else if let Some(s) = answer_value.as_str() {
                    s.to_string()
                } else {
                    "N/A".to_string()
                }
            } else {
                "N/A".to_string()
            };

            result_lines.push(format!(
                "- {} ({}): \"{}\"",
                question.question, question.header, answer_text
            ));
        }

        result_lines.push("\nYou can now continue with the user's answers in mind.".to_string());
        result_lines.join("\n")
    } else {
        "User has answered your questions (no valid answers received).".to_string()
    }
}

#[cfg(test)]
mod tests {
    use super::{PendingUserQuestion, UserInputManager, UserInputResponse, UserInputSendError};
    use serde_json::json;

    #[tokio::test]
    async fn mailbox_watch_coalesces_without_losing_sessions_and_notifies_removal() {
        let manager = UserInputManager::new();
        let mut changes = manager.subscribe_changes();
        let (sender_a, receiver_a) = tokio::sync::oneshot::channel();
        let (sender_b, _receiver_b) = tokio::sync::oneshot::channel();
        let a = manager.register_question(
            PendingUserQuestion::new("a", "session-a", None, None, json!({"questions":[]})),
            sender_a,
        );
        let b = manager.register_question(
            PendingUserQuestion::new("b", "session-b", None, None, json!({"questions":[]})),
            sender_b,
        );
        changes.changed().await.unwrap();
        let revision = *changes.borrow_and_update();
        let sessions = manager.pending_question_counts();
        assert_eq!(sessions.len(), 2);
        assert_eq!(sessions.get("session-a"), Some(&1));
        assert_eq!(sessions.get("session-b"), Some(&1));
        manager.send_answer("a", json!({"0":"yes"})).unwrap();
        assert_eq!(receiver_a.await.unwrap().answers, json!({"0":"yes"}));
        drop(b);
        changes.changed().await.unwrap();
        assert!(*changes.borrow_and_update() > revision);
        assert!(manager.pending_question_counts().is_empty());
        drop(a);
    }

    #[tokio::test]
    async fn user_input_manager_delivers_answer_and_clears_channel() {
        let manager = UserInputManager::new();
        let (sender, receiver) = tokio::sync::oneshot::channel::<UserInputResponse>();

        manager.register_channel("tool-1".to_string(), sender);
        assert!(manager.has_pending("tool-1"));
        manager
            .send_answer("tool-1", json!({ "0": "yes" }))
            .expect("answer should be sent");

        let response = receiver.await.expect("receiver should get answer");
        assert_eq!(response.answers, json!({ "0": "yes" }));
        assert!(!manager.has_pending("tool-1"));
    }

    #[tokio::test]
    async fn user_input_manager_cancel_closes_receiver() {
        let manager = UserInputManager::new();
        let (sender, receiver) = tokio::sync::oneshot::channel::<UserInputResponse>();

        manager.register_channel("tool-1".to_string(), sender);

        assert!(manager.cancel("tool-1"));
        assert!(receiver.await.is_err());
        assert!(!manager.cancel("tool-1"));
    }

    #[tokio::test]
    async fn user_input_manager_distinguishes_missing_and_closed_channels() {
        let manager = UserInputManager::new();
        let missing = manager
            .send_answer("missing-tool", json!({ "0": "yes" }))
            .expect_err("missing channel");
        assert_eq!(
            missing,
            UserInputSendError::MissingChannel {
                tool_id: "missing-tool".to_string(),
            }
        );

        let (sender, receiver) = tokio::sync::oneshot::channel::<UserInputResponse>();
        manager.register_channel("closed-tool".to_string(), sender);
        drop(receiver);
        let closed = manager
            .send_answer("closed-tool", json!({ "0": "yes" }))
            .expect_err("closed channel");
        assert_eq!(
            closed,
            UserInputSendError::ChannelClosed {
                tool_id: "closed-tool".to_string(),
            }
        );
    }

    #[test]
    fn user_input_manager_reports_pending_tool_ids() {
        let manager = UserInputManager::new();
        let (sender, _receiver) = tokio::sync::oneshot::channel::<UserInputResponse>();

        manager.register_channel("tool-1".to_string(), sender);

        assert_eq!(manager.pending_tool_ids(), vec!["tool-1".to_string()]);
    }

    #[tokio::test]
    async fn pending_question_snapshot_survives_event_gaps_until_answered() {
        let manager = UserInputManager::new();
        let (sender, receiver) = tokio::sync::oneshot::channel::<UserInputResponse>();
        let question = PendingUserQuestion::new(
            "tool-1",
            "session-1",
            Some("turn-1".to_string()),
            Some("round-1".to_string()),
            json!({"questions": [{"question": "Continue?"}]}),
        );
        let registration = manager.register_question(question.clone(), sender);

        let pending = manager.pending_question_snapshot("session-1");
        assert_eq!(pending.questions, vec![question]);
        assert!(pending.revision > 0);
        assert_eq!(manager.pending_question_counts().get("session-1"), Some(&1));

        manager
            .send_answer("tool-1", json!({"0": "yes"}))
            .expect("answer should be sent");
        assert_eq!(
            receiver.await.expect("receiver should get answer").answers,
            json!({"0": "yes"})
        );
        assert!(manager
            .pending_question_snapshot("session-1")
            .questions
            .is_empty());
        assert!(manager.pending_question_counts().is_empty());
        drop(registration);
    }

    #[test]
    fn dropping_question_registration_cleans_up_cancelled_turn_state() {
        let manager = UserInputManager::new();
        let (sender, _receiver) = tokio::sync::oneshot::channel::<UserInputResponse>();
        let registration = manager.register_question(
            PendingUserQuestion::new(
                "tool-1",
                "session-1",
                Some("turn-1".to_string()),
                Some("round-1".to_string()),
                json!({"questions": []}),
            ),
            sender,
        );
        let registered_revision = manager.pending_question_snapshot("session-1").revision;

        drop(registration);

        let after_drop = manager.pending_question_snapshot("session-1");
        assert!(after_drop.questions.is_empty());
        assert!(after_drop.revision > registered_revision);
    }
    fn unattended_question(
        manager: &UserInputManager,
    ) -> (
        super::UserInputRegistration,
        tokio::sync::oneshot::Receiver<UserInputResponse>,
    ) {
        let (sender, receiver) = tokio::sync::oneshot::channel();
        let registration = manager.register_question(
            PendingUserQuestion::new("tool", "session", None, None, json!({"questions": []})),
            sender,
        );
        (registration, receiver)
    }

    #[tokio::test]
    async fn unlimited_wait_accepts_answer_without_interaction() {
        let manager = UserInputManager::new();
        let (registration, receiver) = unattended_question(&manager);
        let wait = super::wait_for_user_question_response(&registration, receiver, None);
        tokio::pin!(wait);
        assert!(
            tokio::time::timeout(std::time::Duration::from_millis(20), &mut wait)
                .await
                .is_err()
        );
        manager.send_answer("tool", json!({"0":"yes"})).unwrap();
        assert!(matches!(
            wait.await,
            super::UserQuestionWaitOutcome::Answered(_)
        ));
    }

    #[tokio::test]
    async fn elapsed_delivery_time_does_not_restart_the_timeout() {
        let manager = UserInputManager::new();
        let (registration, receiver) = unattended_question(&manager);
        let deadline = tokio::time::Instant::now() - std::time::Duration::from_secs(1);
        let result = tokio::time::timeout(
            std::time::Duration::from_millis(100),
            super::wait_for_user_question_response_until(&registration, receiver, Some(deadline)),
        )
        .await
        .expect("an elapsed deadline must expire immediately");
        assert!(matches!(result, super::UserQuestionWaitOutcome::TimedOut));
        assert!(!manager.has_pending("tool"));
    }

    #[tokio::test]
    async fn first_interaction_removes_timeout_and_remains_replayable_until_answered() {
        let manager = UserInputManager::new();
        let (registration, receiver) = unattended_question(&manager);
        let wait = super::wait_for_user_question_response(
            &registration,
            receiver,
            std::time::Duration::from_millis(10),
        );
        tokio::pin!(wait);
        // Poll the wait before activity, so both the timer and activity receiver are live.
        std::future::poll_fn(|cx| {
            assert!(std::future::Future::poll(wait.as_mut(), cx).is_pending());
            std::task::Poll::Ready(())
        })
        .await;
        manager.start_interaction("session", "tool").unwrap();
        let active = manager.pending_question_snapshot("session");
        assert!(active.questions[0].interaction_started);
        manager.start_interaction("session", "tool").unwrap();
        assert_eq!(
            manager.pending_question_snapshot("session").revision,
            active.revision
        );
        assert!(
            tokio::time::timeout(std::time::Duration::from_millis(30), &mut wait)
                .await
                .is_err()
        );
        assert!(manager.has_pending("tool"));
        manager.send_answer("tool", json!({"0":"yes"})).unwrap();
        assert!(matches!(
            wait.await,
            super::UserQuestionWaitOutcome::Answered(_)
        ));
    }

    #[tokio::test]
    async fn no_interaction_expires_and_late_or_cross_session_activity_cannot_revive_it() {
        let manager = UserInputManager::new();
        let (registration, receiver) = unattended_question(&manager);
        assert!(manager.start_interaction("other-session", "tool").is_err());
        let outcome = super::wait_for_user_question_response(
            &registration,
            receiver,
            std::time::Duration::from_millis(1),
        )
        .await;
        assert!(matches!(outcome, super::UserQuestionWaitOutcome::TimedOut));
        assert!(!manager.has_pending("tool"));
        assert!(manager.start_interaction("session", "tool").is_err());
    }

    #[tokio::test]
    async fn delegated_question_controllers_share_activity_and_project_replay_to_their_turn() {
        let manager = UserInputManager::new();
        let (sender, receiver) = tokio::sync::oneshot::channel();
        let registration = manager.register_question_with_controllers(
            PendingUserQuestion::new(
                "delegated-tool",
                "child",
                Some("child-turn".into()),
                Some("child-round".into()),
                json!({}),
            ),
            sender,
            vec![super::UserQuestionController {
                session_id: "root".into(),
                dialog_turn_id: Some("root-turn".into()),
            }],
        );
        assert!(manager
            .start_interaction("unrelated", "delegated-tool")
            .is_err());
        manager.start_interaction("root", "delegated-tool").unwrap();
        let root = manager.pending_question_snapshot("root");
        assert_eq!(root.questions[0].session_id, "root");
        assert_eq!(
            root.questions[0].dialog_turn_id.as_deref(),
            Some("root-turn")
        );
        assert!(root.questions[0].model_round_id.is_none());
        assert!(root.questions[0].interaction_started);
        let child = manager.pending_question_snapshot("child");
        assert_eq!(
            child.questions[0].model_round_id.as_deref(),
            Some("child-round")
        );
        assert!(child.questions[0].interaction_started);
        assert!(manager
            .pending_question_snapshot("unrelated")
            .questions
            .is_empty());
        assert_eq!(manager.pending_question_counts().get("root"), Some(&1));
        assert!(manager
            .cancel_for_session("unrelated", "delegated-tool")
            .is_err());
        manager
            .cancel_for_session("root", "delegated-tool")
            .unwrap();
        assert!(matches!(
            super::wait_for_user_question_response(
                &registration,
                receiver,
                std::time::Duration::from_secs(30)
            )
            .await,
            super::UserQuestionWaitOutcome::Cancelled
        ));
        assert!(manager
            .pending_question_snapshot("child")
            .questions
            .is_empty());
    }

    #[tokio::test]
    async fn scoped_cancellation_rejects_other_sessions_and_settles_after_interaction() {
        let manager = UserInputManager::new();
        let (registration, receiver) = unattended_question(&manager);
        manager.start_interaction("session", "tool").unwrap();
        assert!(manager.cancel_for_session("other", "tool").is_err());
        assert!(manager.has_pending("tool"));
        manager.cancel_for_session("session", "tool").unwrap();
        assert!(matches!(
            super::wait_for_user_question_response(
                &registration,
                receiver,
                std::time::Duration::from_secs(30)
            )
            .await,
            super::UserQuestionWaitOutcome::Cancelled
        ));
        assert!(!manager.has_pending("tool"));
    }

    #[tokio::test]
    async fn cancellation_still_settles_an_interacted_question() {
        let manager = UserInputManager::new();
        let (registration, receiver) = unattended_question(&manager);
        manager.start_interaction("session", "tool").unwrap();
        manager.cancel("tool");
        assert!(matches!(
            super::wait_for_user_question_response(
                &registration,
                receiver,
                std::time::Duration::from_secs(30)
            )
            .await,
            super::UserQuestionWaitOutcome::Cancelled
        ));
    }

    #[test]
    fn timeout_and_activity_are_atomically_arbitrated_and_legacy_snapshots_default_to_unstarted() {
        let manager = UserInputManager::new();
        let (registration, _receiver) = unattended_question(&manager);
        manager.start_interaction("session", "tool").unwrap();
        assert!(!registration.expire_if_unstarted());
        let mut value =
            serde_json::to_value(&manager.pending_question_snapshot("session").questions[0])
                .unwrap();
        value.as_object_mut().unwrap().remove("interactionStarted");
        let legacy: PendingUserQuestion = serde_json::from_value(value.clone()).unwrap();
        assert!(!legacy.interaction_started);
        assert_eq!(serde_json::to_value(legacy).unwrap(), value);
    }
}
