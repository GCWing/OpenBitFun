//! Weixin iLink bot orchestration for Remote Connect.
//!
//! Provider HTTP/CDN/QR/message parsing lives in `openbitfun-services-integrations`.
//! This module keeps product pairing, command routing, persistence, and agent
//! turn orchestration.

use anyhow::{anyhow, Result};
use base64::{engine::general_purpose::STANDARD as B64, Engine as _};
use log::{debug, error, info, warn};
use openbitfun_services_integrations::remote_connect::bot::weixin as weixin_provider;
use openbitfun_services_integrations::remote_connect::bot::weixin::WeixinProviderClient;
pub use openbitfun_services_integrations::remote_connect::bot::weixin::{
    WeixinConfig, WeixinQrPollResponse, WeixinQrPollStatus, WeixinQrStartResponse,
    MAX_INBOUND_IMAGES, MAX_WEIXIN_FILE_BYTES, WEIXIN_SESSION_EXPIRED_ERRCODE,
};
use serde_json::Value;
use std::collections::{HashMap, VecDeque};
use std::sync::{Arc, Weak};
use std::time::Duration;
use tokio::sync::{Mutex, Notify, RwLock};

use super::command_router::{
    complete_im_bot_pairing, current_bot_language, execute_forwarded_turn_with_submission,
    handle_command, parse_command, BotChatState, BotInteractionHandler, BotInteractiveRequest,
    BotMessageSender, HandleResult,
};
use super::pairing_gate::{PairingGate, UnpairedDecision};
use super::{load_bot_persistence, BotConfig, BotRuntimeFence, SavedBotConnection};
use crate::agentic::coordination::get_global_coordinator;
use crate::agentic::events::{AgenticEvent, EventSubscriber};
use crate::service::remote_connect::remote_server::ImageAttachment;
use openbitfun_agent_runtime::event_bus::EventSubscriberResult;

const LONG_POLL_TIMEOUT_SECS: u64 = 36;

fn inbound_file_rejection(
    state: &BotChatState,
    strings: &'static super::locale::BotStrings,
) -> Option<&'static str> {
    if state.pending_action.is_some() {
        Some(strings.inbound_file_pending)
    } else {
        None
    }
}

/// Maximum proactive messages held for one peer before they are merged into a
/// single reply. Older entries are dropped so a peer that never comes back
/// cannot grow the backlog without bound.
const MAX_PENDING_OUTBOUND_PER_PEER: usize = 20;

/// Bound retries to one channel activation window. This is a best-effort,
/// in-memory backlog, not a durable delivery receipt.
const PENDING_OUTBOUND_TTL_SECS: i64 = 24 * 60 * 60;

/// Separator between merged turn outputs, so one reply built from several
/// answers still reads as several answers.
const PENDING_SEPARATOR: &str = "\n\n---\n\n";

/// How often the outbound worker retries a backlog that no new event woke it
/// for, so a token refreshed by an inbound message is picked up even if the
/// wakeup notification races the enqueue.
const OUTBOUND_RETRY_INTERVAL_SECS: u64 = 5;

/// Bound on the remembered bot-owned turn ids. The set only needs to cover
/// turns that can still complete, so a small window is enough.
const MAX_TRACKED_OWN_TURNS: usize = 256;

/// Largest payload one proactive push may merge into. One channel reply is the
/// unit the quota counts, so capping the merge at a single part avoids spending
/// several replies on one scheduled result. The provider enforces its quota.
const MAX_PROACTIVE_PUSH_BYTES: usize = weixin_provider::MAX_TEXT_CHUNK;

/// One piece of assistant output waiting for a deliverable context_token.
#[derive(Debug, Clone)]
struct PendingOutbound {
    id: String,
    session_id: String,
    text: String,
    queued_at: i64,
}

/// One peer's proactive backlog.
#[derive(Debug, Default)]
struct PendingPeer {
    queue: VecDeque<PendingOutbound>,
    /// Reason the last delivery attempt held the backlog back, so a peer that
    /// stays blocked logs once per distinct reason instead of on every retry.
    deferred_reason: Option<&'static str>,
}

fn pending_matches_binding(state: &BotChatState, item: &PendingOutbound) -> bool {
    state.paired
        && !state.account_remote_context
        && state.active_remote_device.is_none()
        && state.current_session_id.as_deref() == Some(item.session_id.as_str())
}

fn append_remote_push_notice(result: &mut HandleResult, language: super::BotLanguage) {
    let notice = openbitfun_services_integrations::remote_connect::bot::strings_for(language)
        .weixin_remote_push_unsupported;
    result.reply.push_str("\n\n");
    result.reply.push_str(notice);
    let footer = result.menu.footer_hint.get_or_insert_with(String::new);
    if !footer.is_empty() {
        footer.push_str("\n\n");
    }
    footer.push_str(notice);
}

/// Drops entries older than [`PENDING_OUTBOUND_TTL_SECS`].
///
/// Entries are appended in time order, so expired ones are always at the
/// front; returns how many were dropped so the caller can report them outside
/// the lock.
fn drop_expired_pending(queue: &mut VecDeque<PendingOutbound>, now: i64) -> usize {
    let mut dropped = 0;
    while let Some(front) = queue.front() {
        if now.saturating_sub(front.queued_at) <= PENDING_OUTBOUND_TTL_SECS {
            break;
        }
        queue.pop_front();
        dropped += 1;
    }
    dropped
}

/// Queues one proactive message, enforcing the retention window and the count
/// cap. Returns how many entries were dropped for logging.
fn push_pending(queue: &mut VecDeque<PendingOutbound>, item: PendingOutbound, now: i64) -> usize {
    let mut dropped = drop_expired_pending(queue, now);
    while queue.len() >= MAX_PENDING_OUTBOUND_PER_PEER {
        queue.pop_front();
        dropped += 1;
    }
    queue.push_back(item);
    dropped
}

fn push_tracked_turn(turns: &mut VecDeque<String>, turn_id: &str) {
    while turns.len() >= MAX_TRACKED_OWN_TURNS {
        turns.pop_front();
    }
    turns.push_back(turn_id.to_string());
}

/// Only the persistence fence identifies a completed answer that is safe to
/// read. The earlier DialogTurnCompleted event may precede the final write.
fn settled_session_turn(event: &AgenticEvent) -> Option<(&str, &str)> {
    match event {
        AgenticEvent::SessionHistoryChanged {
            session_id,
            settled_turn_id: Some(turn_id),
        } => Some((session_id, turn_id)),
        _ => None,
    }
}

fn settled_turn_text(mut poll: Value, turn_id: &str) -> Option<String> {
    // A newly created tracker can seed an empty active turn, or still contain
    // a partial overlay until its own subscriber sees the persistence fence.
    // Prefer the persisted record regardless of subscriber execution order.
    poll["active_turn"] = Value::Null;
    let turn = openbitfun_services_integrations::remote_connect::bot::remote_turn::observe_turn(
        &poll, turn_id,
    )?;
    if let Some(delivery) = turn.background_delivery.as_ref() {
        if matches!(turn.status.as_str(), "failed" | "error" | "interrupted")
            || turn.error.is_some()
        {
            return Some(
                turn.error
                    .unwrap_or_else(|| "Background task execution failed.".to_owned()),
            );
        }
        if delivery.suppresses_report() {
            return None;
        }
        if delivery.reason == "recovery_completed" && turn.text.trim().is_empty() {
            return Some("Background task execution recovered and completed.".to_owned());
        }
    }
    (matches!(turn.status.as_str(), "done" | "completed") && turn.error.is_none())
        .then_some(turn.text)
}

fn bounded_proactive_text(text: &str) -> String {
    let text = text.trim();
    if text.len() <= MAX_PROACTIVE_PUSH_BYTES {
        return text.to_string();
    }
    const TRUNCATED: &str = "\n…";
    format!(
        "{}{TRUNCATED}",
        crate::util::truncate_at_char_boundary(text, MAX_PROACTIVE_PUSH_BYTES - TRUNCATED.len())
    )
}

/// Joins a peer's backlog into the single reply that carries all of it.
///
/// The quota counts replies, so a backlog must not be delivered one reply per
/// turn. The merged payload is capped at [`MAX_PROACTIVE_PUSH_BYTES`]: the
/// oldest outputs are dropped first, and when the newest output alone exceeds
/// the cap its head is sent, because the newest answer is the one the user is
/// waiting for.
fn merge_pending(pending: &[PendingOutbound]) -> String {
    let mut kept: Vec<&str> = Vec::new();
    let mut bytes = 0usize;
    // Walk newest first so the byte cap drops the oldest output.
    for item in pending.iter().rev() {
        let text = item.text.trim();
        if text.is_empty() {
            continue;
        }
        let separator = if kept.is_empty() {
            0
        } else {
            PENDING_SEPARATOR.len()
        };
        if bytes + separator + text.len() > MAX_PROACTIVE_PUSH_BYTES {
            break;
        }
        bytes += separator + text.len();
        kept.push(text);
    }
    if kept.is_empty() {
        return pending
            .iter()
            .rev()
            .map(|item| item.text.trim())
            .find(|text| !text.is_empty())
            .map(bounded_proactive_text)
            .unwrap_or_default();
    }
    kept.reverse();
    kept.join(PENDING_SEPARATOR)
}

pub struct WeixinBot {
    api: Arc<WeixinProviderClient>,
    pairing_gate: PairingGate,
    chat_states: Arc<RwLock<HashMap<String, BotChatState>>>,
    context_tokens: Arc<RwLock<HashMap<String, String>>>,
    runtime_fence: BotRuntimeFence,
    /// Turn ids this bot started from an inbound message. The inbound path
    /// already answers those turns, so the proactive channel must skip them or
    /// every inbound message would be delivered twice.
    own_turns: Arc<Mutex<VecDeque<String>>>,
    /// Proactive output per peer that has no deliverable context_token yet,
    /// oldest first.
    pending_outbound: Arc<Mutex<HashMap<String, PendingPeer>>>,
    outbound_wakeup: Arc<Notify>,
    /// Identity of this instance's proactive session-output subscription, so a
    /// replaced bot retires its own hook instead of the replacement's.
    session_output_hook_id: String,
}

pub async fn weixin_qr_start(base_url_override: Option<String>) -> Result<WeixinQrStartResponse> {
    weixin_provider::weixin_qr_start(base_url_override, None, None).await
}

pub async fn weixin_qr_start_with_existing(
    base_url_override: Option<String>,
    existing_ilink_token: Option<String>,
    existing_bot_account_id: Option<String>,
) -> Result<WeixinQrStartResponse> {
    weixin_provider::weixin_qr_start(
        base_url_override,
        existing_ilink_token,
        existing_bot_account_id,
    )
    .await
}

pub async fn weixin_qr_poll(
    session_key: &str,
    base_url_override: Option<String>,
    verify_code: Option<String>,
) -> Result<WeixinQrPollResponse> {
    weixin_provider::weixin_qr_poll(session_key, base_url_override, verify_code).await
}

impl WeixinBot {
    #[cfg(test)]
    pub fn new(config: WeixinConfig) -> Self {
        Self::new_fenced(config, BotRuntimeFence::standalone())
    }

    pub(crate) fn new_fenced(config: WeixinConfig, runtime_fence: BotRuntimeFence) -> Self {
        let context_tokens = weixin_provider::load_context_tokens(&config.bot_account_id);
        Self {
            api: Arc::new(WeixinProviderClient::new(config)),
            pairing_gate: PairingGate::new(),
            chat_states: Arc::new(RwLock::new(HashMap::new())),
            context_tokens: Arc::new(RwLock::new(context_tokens)),
            runtime_fence,
            own_turns: Arc::new(Mutex::new(VecDeque::new())),
            pending_outbound: Arc::new(Mutex::new(HashMap::new())),
            outbound_wakeup: Arc::new(Notify::new()),
            session_output_hook_id: format!("weixin_session_output_{}", uuid::Uuid::new_v4()),
        }
    }

    pub async fn restore_chat_state(&self, peer_id: &str, mut state: BotChatState) {
        state.prepare_for_restore();
        let mut states = self.chat_states.write().await;
        self.runtime_fence.reconcile_states(&mut states);
        states.insert(peer_id.to_string(), state);
        let restored = states
            .get(peer_id)
            .cloned()
            .expect("restored Weixin state should exist");
        drop(states);
        self.persist_chat_state(peer_id, &restored).await;
    }

    pub async fn clear_delegated_identities(&self) {
        match tokio::time::timeout(
            std::time::Duration::from_millis(100),
            self.chat_states.write(),
        )
        .await
        {
            Ok(mut states) => {
                self.runtime_fence.clear_states(&mut states);
                let snapshots: Vec<_> = states
                    .iter()
                    .map(|(peer_id, state)| (peer_id.clone(), state.clone()))
                    .collect();
                drop(states);
                for (peer_id, state) in snapshots {
                    self.persist_chat_state(&peer_id, &state).await;
                }
            }
            Err(_) => {
                warn!("Weixin account identity clear deferred behind an in-flight command");
            }
        }
    }

    /// Only a valid code can replace the chat that owns this connection.
    /// Keep admission serialized with commands, and never create state for a refusal.
    async fn handle_pairing_message(&self, peer_id: &str, text: &str) -> bool {
        let epoch = self.runtime_fence.identity_epoch();
        let mut states = self.chat_states.write().await;
        if !self.runtime_fence.is_lifecycle_current() {
            return false;
        }
        self.runtime_fence.reconcile_states(&mut states);
        if states.get(peer_id).is_some_and(|state| state.paired) {
            return true;
        }
        let connected_elsewhere = states.values().any(|state| state.paired);
        match self
            .pairing_gate
            .evaluate(peer_id, text, connected_elsewhere)
        {
            UnpairedDecision::Pair => {
                let mut state = BotChatState::new(peer_id.to_string());
                let result = complete_im_bot_pairing(&mut state).await;
                if !self.runtime_fence.is_lifecycle_current()
                    || self.runtime_fence.identity_epoch() != epoch
                {
                    return false;
                }
                states.clear();
                states.insert(peer_id.to_string(), state.clone());
                self.persist_chat_state(peer_id, &state).await;
                drop(states);
                self.send_handle_result(peer_id, &result).await;
                true
            }
            UnpairedDecision::Reply(reply) => {
                drop(states);
                let language = current_bot_language().await;
                if self.runtime_fence.is_lifecycle_current()
                    && self.runtime_fence.identity_epoch() == epoch
                {
                    self.try_send_text(peer_id, &reply.text(language), "pairing-prompt")
                        .await;
                }
                false
            }
            UnpairedDecision::Silent => false,
        }
    }

    pub async fn register_pairing(&self, pairing_code: &str) -> Result<()> {
        self.pairing_gate.register(pairing_code);
        Ok(())
    }

    pub async fn verify_pairing_code(&self, code: &str) -> bool {
        self.pairing_gate.consume(code)
    }

    pub async fn send_text(&self, peer_id: &str, text: &str) -> Result<()> {
        let token = self.context_token_for_peer(peer_id).await?;
        if let Err(err) = self.api.send_text_chunks(peer_id, &token, text).await {
            if WeixinProviderClient::is_context_token_error(&err) {
                let mut tokens = self.context_tokens.write().await;
                if tokens
                    .get(peer_id)
                    .map(|cached| cached == &token)
                    .unwrap_or(false)
                {
                    tokens.remove(peer_id);
                    weixin_provider::save_context_tokens(
                        &self.api.config().bot_account_id,
                        &tokens,
                    );
                    warn!(
                        "weixin: dropped stale context_token for peer {peer_id} after send error: {err}"
                    );
                }
            }
            return Err(err);
        }
        Ok(())
    }

    async fn remember_context_token(&self, peer_id: &str, token: String) {
        if !self.runtime_fence.is_lifecycle_current() {
            return;
        }
        let mut tokens = self.context_tokens.write().await;
        tokens.insert(peer_id.to_string(), token);
        weixin_provider::save_context_tokens(&self.api.config().bot_account_id, &tokens);
        drop(tokens);
        // A fresh token is the only thing that makes a stalled proactive
        // backlog deliverable, so retry it as soon as one arrives.
        self.outbound_wakeup.notify_one();
    }

    /// Registers the proactive session-output hook for this bot instance.
    ///
    /// Turns started outside the inbound path — a scheduled job, the desktop
    /// window, another controller — produce assistant output that the reply
    /// path never sees. The hook forwards that output to the peer bound to the
    /// turn's session instead of dropping it.
    pub fn subscribe_session_output(self: &Arc<Self>) {
        let Some(coordinator) = get_global_coordinator() else {
            warn!("weixin: session output hook unavailable; proactive push disabled");
            return;
        };
        coordinator.subscribe_internal(
            self.session_output_hook_id.clone(),
            WeixinSessionOutputSubscriber {
                bot: Arc::downgrade(self),
            },
        );
    }

    /// Retires this instance's proactive session-output hook.
    pub fn unsubscribe_session_output(&self) {
        if let Some(coordinator) = get_global_coordinator() {
            coordinator.unsubscribe_internal(&self.session_output_hook_id);
        }
    }

    /// Starts the single worker that drains proactive backlogs.
    ///
    /// One worker per bot preserves order and keeps two triggers from
    /// delivering the same queued message.
    fn spawn_outbound_worker(self: &Arc<Self>, mut stop: tokio::sync::watch::Receiver<bool>) {
        let bot = self.clone();
        let wakeup = self.outbound_wakeup.clone();
        tokio::spawn(async move {
            loop {
                if *stop.borrow() || !bot.runtime_fence.is_lifecycle_current() {
                    break;
                }
                tokio::select! {
                    _ = stop.changed() => break,
                    _ = wakeup.notified() => {}
                    _ = tokio::time::sleep(Duration::from_secs(OUTBOUND_RETRY_INTERVAL_SECS)) => {}
                }
                bot.flush_pending_outbound().await;
            }
        });
    }

    /// Delivers assistant output produced by a turn this bot did not start.
    ///
    /// This is the explicit entry point behind the session-output hook, so the
    /// proactive path can also be driven directly when no coordinator event is
    /// available.
    pub async fn notify_session_output(&self, session_id: &str, text: &str) {
        if !self.runtime_fence.is_lifecycle_current() {
            return;
        }
        for peer_id in self.peers_for_session(session_id).await {
            self.queue_proactive(&peer_id, session_id, text, &format!("session {session_id}"))
                .await;
        }
    }

    async fn handle_session_turn_settled(&self, session_id: String, turn_id: String) {
        if !self.runtime_fence.is_lifecycle_current() {
            return;
        }
        if self.is_own_turn(&turn_id).await {
            return;
        }
        let peers = self.peers_for_session(&session_id).await;
        if peers.is_empty() {
            return;
        }
        let text = self.read_turn_text(&session_id, &turn_id).await;
        // The session read is an await point: a bot replaced meanwhile must not
        // push, even though the turn itself is worth delivering.
        if !self.runtime_fence.is_lifecycle_current() {
            return;
        }
        for peer_id in peers {
            self.queue_proactive(&peer_id, &session_id, &text, &format!("turn {turn_id}"))
                .await;
        }
    }

    async fn queue_proactive(&self, peer_id: &str, session_id: &str, text: &str, source: &str) {
        if text.trim().is_empty() {
            debug!("weixin: proactive push skipped for peer {peer_id}: {source} has no text");
            return;
        }
        info!("weixin: queueing proactive push for peer {peer_id} from {source}");
        self.enqueue_outbound(peer_id, session_id, text).await;
        self.outbound_wakeup.notify_one();
    }

    /// The peers whose bot chats are bound to `session_id`, if this bot owns it.
    ///
    /// A chat routed to another device executes the turn elsewhere, so its text
    /// is unreadable here and must not be pushed from this host.
    async fn peers_for_session(&self, session_id: &str) -> Vec<String> {
        let states = self.chat_states.read().await;
        states
            .iter()
            .filter(|(_, state)| {
                state.paired
                    && !state.account_remote_context
                    && state.active_remote_device.is_none()
                    && state.current_session_id.as_deref() == Some(session_id)
            })
            .map(|(peer_id, _)| peer_id.clone())
            .collect()
    }

    /// Reads the assistant text of `turn_id` through the replay-safe turn
    /// projection the inbound reply path already relies on.
    async fn read_turn_text(&self, session_id: &str, turn_id: &str) -> String {
        use openbitfun_services_integrations::remote_connect::{
            handle_remote_poll_command, RemoteCommand,
        };

        let dispatcher =
            crate::service::remote_connect::remote_server::get_or_init_global_dispatcher();
        let poll_host =
            crate::service_agent_runtime::CoreServiceAgentRuntime::remote_poll_host(&dispatcher);
        let poll = handle_remote_poll_command(
            &poll_host,
            &RemoteCommand::PollSession {
                session_id: session_id.to_string(),
                since_version: 0,
                known_msg_count: 0,
                known_model_catalog_version: None,
            },
        )
        .await;
        serde_json::to_value(poll)
            .ok()
            .and_then(|poll| settled_turn_text(poll, turn_id))
            .unwrap_or_default()
    }

    async fn mark_own_turn(&self, turn_id: &str) {
        let mut turns = self.own_turns.lock().await;
        push_tracked_turn(&mut turns, turn_id);
    }

    async fn is_own_turn(&self, turn_id: &str) -> bool {
        let turns = self.own_turns.lock().await;
        turns.iter().any(|tracked| tracked == turn_id)
    }

    async fn enqueue_outbound(&self, peer_id: &str, session_id: &str, text: &str) {
        let now = chrono::Utc::now().timestamp();
        let dropped = {
            let mut pending = self.pending_outbound.lock().await;
            let peer = pending.entry(peer_id.to_string()).or_default();
            push_pending(
                &mut peer.queue,
                PendingOutbound {
                    id: uuid::Uuid::new_v4().to_string(),
                    session_id: session_id.to_string(),
                    text: bounded_proactive_text(text),
                    queued_at: now,
                },
                now,
            )
        };
        if dropped > 0 {
            warn!(
                "weixin: proactive push backlog for peer {peer_id} exceeded its limit or retention window; dropped {dropped} oldest message(s)"
            );
        }
    }

    async fn flush_pending_outbound(&self) {
        let peers: Vec<String> = {
            let pending = self.pending_outbound.lock().await;
            pending.keys().cloned().collect()
        };
        for peer_id in peers {
            self.flush_pending_for_peer(&peer_id).await;
        }
    }

    /// Delivers one peer's backlog as a single reply.
    ///
    /// The channel counts every reply against a 24 hour quota that also answers
    /// the user's own messages, so the merged backlog is capped at a single part. No additional daily quota is imposed.
    async fn flush_pending_for_peer(&self, peer_id: &str) {
        if !self.runtime_fence.is_lifecycle_current() {
            return;
        }
        let expired = self.expire_pending(peer_id).await;
        if expired > 0 {
            warn!(
                "weixin: dropped {expired} proactive message(s) for peer {peer_id} past the {PENDING_OUTBOUND_TTL_SECS}s retention window"
            );
        }
        let pending = self.pending_snapshot(peer_id).await;
        if pending.is_empty() {
            return;
        }
        let merged = merge_pending(&pending);
        if merged.trim().is_empty() {
            // Nothing deliverable in the backlog, so it is not worth a reply.
            self.confirm_pending_sent(peer_id, &pending).await;
            return;
        }
        // A command can switch sessions or devices while output is queued.
        // Never deliver an old selection's backlog into the new context.
        if !self.runtime_fence.is_lifecycle_current()
            || !self.pending_binding_is_current(peer_id, &pending).await
        {
            self.confirm_pending_sent(peer_id, &pending).await;
            return;
        }
        if let Err(err) = self.send_text(peer_id, &merged).await {
            // Keep the backlog. A stale token is replaced by the next inbound
            // message and `send_text` has already dropped it, so the retry has a
            // chance to succeed; the retention window bounds it.
            if self.mark_deferred(peer_id, "send_failed").await {
                warn!(
                    "weixin: proactive push to peer {peer_id} deferred; waiting for a retry or fresh context_token: {err}"
                );
            }
            return;
        }
        info!(
            "weixin: proactive push delivered to peer {peer_id} (one reply for {} queued message(s))",
            pending.len()
        );
        self.confirm_pending_sent(peer_id, &pending).await;
    }

    /// Drops queued entries past the retention window and returns how many.
    async fn expire_pending(&self, peer_id: &str) -> usize {
        let now = chrono::Utc::now().timestamp();
        let mut pending = self.pending_outbound.lock().await;
        let (dropped, now_empty) = match pending.get_mut(peer_id) {
            Some(peer) => {
                let dropped = drop_expired_pending(&mut peer.queue, now);
                (dropped, peer.queue.is_empty())
            }
            None => (0, false),
        };
        if now_empty {
            pending.remove(peer_id);
        }
        dropped
    }

    /// Clones a peer's backlog so the send below runs without holding the lock.
    async fn pending_snapshot(&self, peer_id: &str) -> Vec<PendingOutbound> {
        let states = self.chat_states.read().await;
        let state = states.get(peer_id);
        let mut pending = self.pending_outbound.lock().await;
        let Some(peer) = pending.get_mut(peer_id) else {
            return Vec::new();
        };
        peer.queue
            .retain(|item| state.is_some_and(|state| pending_matches_binding(state, item)));
        peer.queue.iter().cloned().collect()
    }

    /// Removes the entries a successful send covered and clears the blocker
    /// flag. Anything enqueued while the send was in flight stays queued.
    async fn confirm_pending_sent(&self, peer_id: &str, sent: &[PendingOutbound]) {
        let mut pending = self.pending_outbound.lock().await;
        let now_empty = match pending.get_mut(peer_id) {
            Some(peer) => {
                peer.queue
                    .retain(|item| !sent.iter().any(|sent| sent.id == item.id));
                peer.deferred_reason = None;
                peer.queue.is_empty()
            }
            None => false,
        };
        if now_empty {
            pending.remove(peer_id);
        }
    }

    /// Flags the backlog's current blocker. Returns whether this is the first
    /// attempt blocked for that reason, so the caller logs once instead of on
    /// every retry.
    async fn mark_deferred(&self, peer_id: &str, reason: &'static str) -> bool {
        let mut pending = self.pending_outbound.lock().await;
        match pending.get_mut(peer_id) {
            Some(peer) if peer.deferred_reason != Some(reason) => {
                peer.deferred_reason = Some(reason);
                true
            }
            _ => false,
        }
    }

    async fn pending_binding_is_current(&self, peer_id: &str, pending: &[PendingOutbound]) -> bool {
        let states = self.chat_states.read().await;
        states.get(peer_id).is_some_and(|state| {
            pending
                .iter()
                .all(|item| pending_matches_binding(state, item))
        })
    }

    pub async fn notify_start(&self) -> Result<()> {
        self.api.notify_start().await
    }

    pub fn requires_login(&self) -> bool {
        self.api.requires_login()
    }

    pub async fn notify_stop(&self) -> Result<()> {
        self.api.notify_stop().await
    }

    async fn context_token_for_peer(&self, peer_id: &str) -> Result<String> {
        self.context_tokens
            .read()
            .await
            .get(peer_id)
            .cloned()
            .ok_or_else(|| {
                anyhow!(
                    "context_token unavailable for peer {peer_id} (waiting for next inbound message)"
                )
            })
    }

    async fn try_send_text(&self, peer_id: &str, text: &str, ctx: &str) {
        if let Err(err) = self.send_text(peer_id, text).await {
            warn!("weixin: {ctx} send to peer {peer_id} failed: {err}");
        }
    }

    async fn send_handle_result(&self, peer_id: &str, result: &HandleResult) {
        if !self.runtime_fence.is_lifecycle_current()
            || !super::chat_is_paired(&self.chat_states, peer_id).await
        {
            return;
        }
        let language = current_bot_language().await;
        let text = if result.menu.items.is_empty() && result.menu.title.is_empty() {
            result.reply.clone()
        } else {
            result.menu.render_plain_text(language)
        };
        if text.trim().is_empty() {
            return;
        }
        if let Err(err) = self.send_text(peer_id, &text).await {
            warn!("weixin send_handle_result: {err}");
        }
    }

    async fn inbound_image_attachments_from_message(
        &self,
        msg: &Value,
    ) -> Result<(Vec<ImageAttachment>, usize)> {
        const MAX_BYTES: usize = 1024 * 1024;

        let (raw_images, skipped) = self.api.download_inbound_images(msg).await?;
        let mut attachments = Vec::with_capacity(raw_images.len());
        for raw in raw_images {
            let data_url = if raw.bytes.len() <= MAX_BYTES {
                let b64 = B64.encode(&raw.bytes);
                format!("data:{};base64,{b64}", raw.mime_type)
            } else {
                match crate::agentic::image_analysis::optimize_image_with_size_limit(
                    raw.bytes.clone(),
                    "openai",
                    Some(raw.mime_type),
                    Some(MAX_BYTES),
                ) {
                    Ok(processed) => {
                        let b64 = B64.encode(&processed.data);
                        format!("data:{};base64,{}", processed.mime_type, b64)
                    }
                    Err(err) => {
                        warn!("Weixin image compression failed: {err}");
                        let b64 = B64.encode(&raw.bytes);
                        format!("data:{};base64,{b64}", raw.mime_type)
                    }
                }
            };
            attachments.push(ImageAttachment {
                name: raw.name,
                data_url,
            });
        }
        Ok((attachments, skipped))
    }

    async fn notify_files_ready(
        &self,
        peer_id: &str,
        session_id: &str,
        remote_target: Option<&super::command_router::RemoteBotTarget>,
        text: &str,
        identity_epoch: u64,
    ) {
        let language = current_bot_language().await;
        for reference in super::extract_output_file_references(text) {
            if !self.runtime_fence.is_lifecycle_current()
                || self.runtime_fence.identity_epoch() != identity_epoch
                || !super::chat_is_paired(&self.chat_states, peer_id).await
            {
                return;
            }
            let content = super::read_output_file(
                session_id,
                remote_target,
                &reference,
                MAX_WEIXIN_FILE_BYTES,
                &|| {
                    self.runtime_fence.is_lifecycle_current()
                        && self.runtime_fence.identity_epoch() == identity_epoch
                },
            )
            .await;
            if !self.runtime_fence.is_lifecycle_current()
                || self.runtime_fence.identity_epoch() != identity_epoch
                || !super::chat_is_paired(&self.chat_states, peer_id).await
            {
                return;
            }
            let result = match content {
                Ok(content) => match self.context_token_for_peer(peer_id).await {
                    Ok(token) => {
                        self.api
                            .send_file_content_to_peer(peer_id, &token, content)
                            .await
                    }
                    Err(error) => Err(error),
                }
                .map_err(|error| error.to_string()),
                Err(error) => Err(error),
            };
            if let Err(error) = result {
                warn!("Weixin output file delivery failed: {error}");
                let notice = super::auto_push_failed_message(language, &reference, &error);
                if self.runtime_fence.is_lifecycle_current()
                    && self.runtime_fence.identity_epoch() == identity_epoch
                {
                    let _ = self.send_text(peer_id, &notice).await;
                }
            }
        }
    }

    async fn persist_chat_state(&self, peer_id: &str, state: &BotChatState) {
        let config = self.api.config().clone();
        let snapshot = self.runtime_fence.persistence_snapshot(state);
        let connection = SavedBotConnection {
            account_user_id: self.runtime_fence.account_user_id(),
            bot_type: "weixin".to_string(),
            chat_id: peer_id.to_string(),
            config: BotConfig::Weixin {
                ilink_token: config.ilink_token.clone(),
                base_url: config.base_url.clone(),
                bot_account_id: config.bot_account_id.clone(),
            },
            chat_state: snapshot,
            connected_at: chrono::Utc::now().timestamp(),
        };
        self.runtime_fence.persist_connection(connection);
    }

    pub async fn wait_for_pairing(
        &self,
        stop_rx: &mut tokio::sync::watch::Receiver<bool>,
    ) -> Result<String> {
        info!("Weixin bot waiting for pairing code (getupdates)...");
        let mut buf = weixin_provider::load_sync_buf(&self.api.config().bot_account_id);
        let mut long_poll_timeout = Duration::from_secs(LONG_POLL_TIMEOUT_SECS);

        loop {
            if *stop_rx.borrow() {
                return Err(anyhow!("bot stop requested"));
            }

            let poll = tokio::select! {
                _ = stop_rx.changed() => {
                    return Err(anyhow!("bot stop requested"));
                }
                result = self.api.get_updates_once(
                    &buf,
                    long_poll_timeout,
                ) => result,
            };

            let resp = match poll {
                Ok(value) => value,
                Err(err) => {
                    error!("weixin getupdates: {err}");
                    tokio::time::sleep(Duration::from_secs(5)).await;
                    continue;
                }
            };
            long_poll_timeout =
                weixin_provider::suggested_long_poll_timeout(&resp, long_poll_timeout);

            let ret = resp["ret"].as_i64().unwrap_or(0);
            let errcode = resp["errcode"].as_i64().unwrap_or(0);
            if weixin_provider::updates_failed(&resp) {
                if errcode == WEIXIN_SESSION_EXPIRED_ERRCODE
                    || ret == WEIXIN_SESSION_EXPIRED_ERRCODE
                {
                    tokio::time::sleep(Duration::from_secs(5)).await;
                    continue;
                }
                warn!("weixin getupdates ret={ret} errcode={errcode}");
                tokio::time::sleep(Duration::from_secs(2)).await;
                continue;
            }

            if let Some(new_buf) = resp["get_updates_buf"]
                .as_str()
                .filter(|buf| !buf.is_empty())
            {
                buf = new_buf.to_string();
                weixin_provider::save_sync_buf(&self.api.config().bot_account_id, &buf);
            }

            if let Some(msgs) = resp["msgs"].as_array() {
                for msg in msgs {
                    if !weixin_provider::is_user_message(msg) {
                        continue;
                    }
                    let Some(peer) = weixin_provider::peer_id(msg) else {
                        continue;
                    };
                    if let Some(token) = weixin_provider::context_token(msg) {
                        self.remember_context_token(&peer, token).await;
                    }
                    let text = weixin_provider::body_from_message(msg).trim().to_string();
                    if *stop_rx.borrow() || !self.runtime_fence.is_lifecycle_current() {
                        return Err(anyhow!("bot lifecycle replaced during pairing"));
                    }
                    if self.handle_pairing_message(&peer, &text).await {
                        return Ok(peer);
                    }
                }
            }
        }
    }

    pub async fn run_message_loop(self: Arc<Self>, stop_rx: tokio::sync::watch::Receiver<bool>) {
        info!("Weixin message loop started");
        self.subscribe_session_output();
        self.spawn_outbound_worker(stop_rx.clone());
        let mut stop = stop_rx;
        // Bounded ingress keeps media downloads and turn admission FIFO per peer.
        // Workers release each message after submission, before waiting for output.
        let mut inbound_senders: HashMap<String, tokio::sync::mpsc::Sender<(Value, u64)>> =
            HashMap::new();
        let mut buf = weixin_provider::load_sync_buf(&self.api.config().bot_account_id);
        let mut long_poll_timeout = Duration::from_secs(LONG_POLL_TIMEOUT_SECS);

        loop {
            if *stop.borrow() {
                break;
            }

            let poll_identity_epoch = self.runtime_fence.identity_epoch();
            let poll = tokio::select! {
                _ = stop.changed() => break,
                result = self.api.get_updates_once(
                    &buf,
                    long_poll_timeout,
                ) => result,
            };

            let resp = match poll {
                Ok(value) => value,
                Err(err) => {
                    error!("weixin getupdates (loop): {err}");
                    tokio::time::sleep(Duration::from_secs(5)).await;
                    continue;
                }
            };
            long_poll_timeout =
                weixin_provider::suggested_long_poll_timeout(&resp, long_poll_timeout);

            let ret = resp["ret"].as_i64().unwrap_or(0);
            let errcode = resp["errcode"].as_i64().unwrap_or(0);
            if weixin_provider::updates_failed(&resp) {
                if errcode == WEIXIN_SESSION_EXPIRED_ERRCODE
                    || ret == WEIXIN_SESSION_EXPIRED_ERRCODE
                {
                    tokio::time::sleep(Duration::from_secs(5)).await;
                    continue;
                }
                tokio::time::sleep(Duration::from_secs(2)).await;
                continue;
            }

            if let Some(new_buf) = resp["get_updates_buf"]
                .as_str()
                .filter(|buf| !buf.is_empty())
            {
                buf = new_buf.to_string();
                weixin_provider::save_sync_buf(&self.api.config().bot_account_id, &buf);
            }

            let Some(msgs) = resp["msgs"].as_array() else {
                continue;
            };

            for msg in msgs {
                if !weixin_provider::is_user_message(msg) {
                    continue;
                }
                let Some(peer) = weixin_provider::peer_id(msg) else {
                    continue;
                };
                if let Some(token) = weixin_provider::context_token(msg) {
                    self.remember_context_token(&peer, token).await;
                }
                inbound_senders.retain(|_, sender| !sender.is_closed());
                let sender = inbound_senders
                    .entry(peer.clone())
                    .or_insert_with(|| self.spawn_inbound_peer(peer.clone(), stop.clone()));
                tokio::select! {
                    _ = stop.changed() => break,
                    sent = sender.send((msg.clone(), poll_identity_epoch)) => {
                        if sent.is_err() { warn!("Weixin inbound worker stopped before message admission"); }
                    }
                }
            }
        }
        self.unsubscribe_session_output();
        info!("Weixin message loop stopped");
    }

    fn spawn_inbound_peer(
        self: &Arc<Self>,
        peer: String,
        mut stop: tokio::sync::watch::Receiver<bool>,
    ) -> tokio::sync::mpsc::Sender<(Value, u64)> {
        let (sender, mut receiver) = tokio::sync::mpsc::channel::<(Value, u64)>(32);
        let bot = self.clone();
        tokio::spawn(async move {
            loop {
                let incoming = tokio::select! {
                    _ = stop.changed() => break,
                    incoming = receiver.recv() => incoming,
                };
                let Some((message, identity_epoch)) = incoming else {
                    break;
                };
                if *stop.borrow() || !bot.runtime_fence.is_lifecycle_current() {
                    break;
                }
                bot.process_provider_message(peer.clone(), message, identity_epoch)
                    .await;
            }
        });
        sender
    }

    async fn process_provider_message(
        self: &Arc<Self>,
        peer: String,
        message: Value,
        identity_epoch: u64,
    ) {
        if !self.runtime_fence.is_lifecycle_current()
            || self.runtime_fence.identity_epoch() != identity_epoch
        {
            return;
        }
        if !super::chat_is_paired(&self.chat_states, peer.as_str()).await {
            self.handle_pairing_message(&peer, &weixin_provider::body_from_message(&message))
                .await;
            return;
        }
        let language = current_bot_language().await;
        if weixin_provider::has_unsupported_media_items(&message) {
            self.try_send_text(
                &peer,
                super::locale::strings_for(language).inbound_media_unsupported,
                "media-unsupported",
            )
            .await;
            return;
        }
        let downloaded = self.inbound_image_attachments_from_message(&message).await;
        if !self.runtime_fence.is_lifecycle_current()
            || self.runtime_fence.identity_epoch() != identity_epoch
        {
            return;
        }
        let (images, skipped_images) = match downloaded {
            Ok(images) => images,
            Err(error) => {
                self.try_send_text(
                    &peer,
                    &format!(
                        "{}{error}",
                        super::locale::strings_for(language).inbound_image_failed_prefix
                    ),
                    "image-receive-failed",
                )
                .await;
                return;
            }
        };
        if skipped_images > 0 {
            let note = if language.is_chinese() {
                format!(
                                "\u{4ec5}\u{4f1a}\u{5904}\u{7406}\u{524d} {} \u{5f20}\u{56fe}\u{7247}\u{ff0c}\u{5176}\u{4f59} {} \u{5f20}\u{5df2}\u{4e22}\u{5f03}\u{3002}",
                                MAX_INBOUND_IMAGES, skipped_images
                            )
            } else {
                format!(
                    "Only the first {} images will be processed; the remaining {} were discarded.",
                    MAX_INBOUND_IMAGES, skipped_images
                )
            };
            self.try_send_text(&peer, &note, "image-truncation-notice")
                .await;
        }
        let body = weixin_provider::body_from_message(&message);
        let text = if body.trim().is_empty() && weixin_provider::has_inbound_file_items(&message) {
            super::locale::strings_for(language)
                .inbound_file_message
                .to_string()
        } else if body.trim().is_empty() && !images.is_empty() {
            if language.is_chinese() {
                "[\u{7528}\u{6237}\u{53d1}\u{9001}\u{4e86}\u{4e00}\u{5f20}\u{56fe}\u{7247}]"
                    .to_string()
            } else {
                "[User sent an image]".to_string()
            }
        } else {
            body
        };
        if text.trim().is_empty() {
            self.try_send_text(
                &peer,
                super::locale::strings_for(language).inbound_media_unsupported,
                "empty-message",
            )
            .await;
            return;
        }
        if self.runtime_fence.is_lifecycle_current()
            && self.runtime_fence.identity_epoch() == identity_epoch
        {
            self.handle_incoming_message(peer, &text, images, &message, identity_epoch)
                .await;
        }
    }

    async fn prepare_inbound_files(
        &self,
        forward: &mut super::command_router::ForwardRequest,
        message: &Value,
        identity_epoch: u64,
    ) -> Result<()> {
        use openbitfun_services_integrations::remote_connect::bot::inbound_files::{
            attachment_prompt, save_inbound_file,
        };
        // Resolve against the immutable routed session, not current UI/workspace state.
        let target = if let Some(remote) = &forward.remote_target {
            remote
                .require_session_attachments()
                .await
                .map_err(anyhow::Error::msg)?;
            None
        } else {
            Some(
                crate::service_agent_runtime::CoreServiceAgentRuntime::remote_file_target(
                    ".",
                    Some(&forward.session_id),
                )
                .await
                .map_err(anyhow::Error::msg)?,
            )
        };
        if !self.runtime_fence.is_lifecycle_current()
            || self.runtime_fence.identity_epoch() != identity_epoch
        {
            return Err(anyhow!("Bot identity changed before file download"));
        }
        let files = self.api.download_inbound_files(message).await?;
        let mut content = forward.content.clone();
        for file in files {
            if !self.runtime_fence.is_lifecycle_current()
                || self.runtime_fence.identity_epoch() != identity_epoch
            {
                return Err(anyhow!("Bot identity changed during file download"));
            }
            let path = if let Some(remote) = &forward.remote_target {
                remote
                    .store_attachment(&file)
                    .await
                    .map_err(anyhow::Error::msg)?
            } else {
                save_inbound_file(
                    target
                        .as_ref()
                        .ok_or_else(|| anyhow!("Attachment workspace is unavailable"))?,
                    &file,
                )
                .await?
            };
            content.push_str(&attachment_prompt(&file.name, &path, file.bytes.len()));
        }
        forward.content = content;
        Ok(())
    }

    async fn handle_incoming_message(
        self: &Arc<Self>,
        peer_id: String,
        text: &str,
        images: Vec<ImageAttachment>,
        message: &Value,
        command_identity_epoch: u64,
    ) {
        if !self.runtime_fence.is_lifecycle_current()
            || self.runtime_fence.identity_epoch() != command_identity_epoch
        {
            return;
        }
        let mut states = self.chat_states.write().await;
        self.runtime_fence.reconcile_states(&mut states);
        if !states.get(&peer_id).is_some_and(|state| state.paired) {
            drop(states);
            self.handle_pairing_message(&peer_id, text).await;
            return;
        }
        let state = states.get_mut(&peer_id).expect("paired chat exists");
        let language = current_bot_language().await;

        if self.runtime_fence.identity_epoch() != command_identity_epoch {
            return;
        }
        let has_files = weixin_provider::has_inbound_file_items(message);
        let strings = super::locale::strings_for(language);
        if has_files {
            if let Some(reason) = inbound_file_rejection(state, strings) {
                drop(states);
                self.try_send_text(&peer_id, reason, "file-rejected").await;
                return;
            }
        }
        let was_remote = state.account_remote_context || state.active_remote_device.is_some();
        let command = if has_files {
            // A caption is file input, never a menu selection or approval answer.
            super::command_router::BotCommand::ChatMessage(text.to_owned())
        } else {
            parse_command(text)
        };
        let mut result = handle_command(state, command, images).await;
        if !was_remote && (state.account_remote_context || state.active_remote_device.is_some()) {
            append_remote_push_notice(&mut result, language);
        }
        self.runtime_fence.reconcile_states(&mut states);
        if let Some(state) = states.get(&peer_id) {
            self.persist_chat_state(&peer_id, state).await;
        }
        drop(states);

        if !self.runtime_fence.is_lifecycle_current()
            || self.runtime_fence.identity_epoch() != command_identity_epoch
        {
            return;
        }

        if has_files {
            if let Some(forward) = result.forward_to_session.as_mut() {
                let prepared = self
                    .prepare_inbound_files(forward, message, command_identity_epoch)
                    .await;
                if !self.runtime_fence.is_lifecycle_current()
                    || self.runtime_fence.identity_epoch() != command_identity_epoch
                {
                    return;
                }
                if let Err(error) = prepared {
                    warn!("Weixin inbound file preparation failed: {error}");
                    self.try_send_text(
                        &peer_id,
                        &format!("{}{error}", strings.inbound_file_failed_prefix),
                        "file-receive-failed",
                    )
                    .await;
                    return;
                }
            }
        }
        self.send_handle_result(&peer_id, &result).await;

        if let Some(forward) = result.forward_to_session {
            // The inbound path answers this turn itself; keep the proactive
            // hook from delivering the same answer a second time.
            self.mark_own_turn(&forward.turn_id).await;
            let output_session_id = forward.session_id.clone();
            let output_remote_target = forward.remote_target.clone();
            let output_identity_epoch = command_identity_epoch;
            let bot = self.clone();
            let peer = peer_id.clone();
            let typing_token = self.context_tokens.read().await.get(&peer_id).cloned();
            let typing_for_turn = self.api.start_typing(peer_id.clone(), typing_token);
            let (submission_finished, admission) = tokio::sync::oneshot::channel();
            tokio::spawn(async move {
                let interaction_bot = bot.clone();
                let peer_c = peer.clone();
                let handler: BotInteractionHandler =
                    Arc::new(move |interaction: BotInteractiveRequest| {
                        let interaction_bot = interaction_bot.clone();
                        let peer_i = peer_c.clone();
                        Box::pin(async move {
                            interaction_bot
                                .deliver_interaction(peer_i, interaction, output_identity_epoch)
                                .await;
                        })
                    });
                let msg_bot = bot.clone();
                let peer_m = peer.clone();
                let sender: BotMessageSender = Arc::new(move |text: String| {
                    let msg_bot = msg_bot.clone();
                    let peer_s = peer_m.clone();
                    Box::pin(async move {
                        if !msg_bot.runtime_fence.is_lifecycle_current()
                            || msg_bot.runtime_fence.identity_epoch() != output_identity_epoch
                            || !super::chat_is_paired(&msg_bot.chat_states, peer_s.as_str()).await
                        {
                            return;
                        }
                        if let Err(err) = msg_bot.send_text(&peer_s, &text).await {
                            warn!(
                                "weixin: send intermediate message to peer {peer_s} failed: {err}"
                            );
                        }
                    })
                });
                let verbose_mode = load_bot_persistence().verbose_mode;
                let turn_result = execute_forwarded_turn_with_submission(
                    forward,
                    Some(handler),
                    Some(sender),
                    verbose_mode,
                    &bot.runtime_fence,
                    output_identity_epoch,
                    Some(submission_finished),
                )
                .await;
                if !bot.runtime_fence.is_lifecycle_current()
                    || bot.runtime_fence.identity_epoch() != output_identity_epoch
                    || !super::chat_is_paired(&bot.chat_states, peer.as_str()).await
                {
                    return;
                }
                if let Some(next) = super::retire_remote_interactions(
                    &bot.chat_states,
                    &peer,
                    output_remote_target.as_ref(),
                    &turn_result.completed_remote_tools,
                    &bot.runtime_fence,
                    output_identity_epoch,
                )
                .await
                {
                    bot.deliver_interaction(peer.clone(), next, output_identity_epoch)
                        .await;
                }
                if !turn_result.display_text.is_empty() {
                    if let Err(err) = bot.send_text(&peer, &turn_result.display_text).await {
                        warn!("weixin: send final reply to peer {peer} failed: {err}");
                    }
                }
                bot.notify_files_ready(
                    &peer,
                    &output_session_id,
                    output_remote_target.as_ref(),
                    &turn_result.full_text,
                    output_identity_epoch,
                )
                .await;
                typing_for_turn.stop().await;
            });
            let _ = admission.await;
        }
    }

    async fn deliver_interaction(
        &self,
        peer_id: String,
        interaction: BotInteractiveRequest,
        identity_epoch: u64,
    ) {
        if !self.runtime_fence.is_lifecycle_current() {
            return;
        }
        let mut states = self.chat_states.write().await;
        self.runtime_fence.reconcile_states(&mut states);
        let Some(state) = states.get_mut(&peer_id).filter(|state| state.paired) else {
            return;
        };
        if self.runtime_fence.identity_epoch() != identity_epoch {
            return;
        }
        if !super::command_router::apply_interactive_request(state, &interaction) {
            return;
        }
        self.persist_chat_state(&peer_id, state).await;
        drop(states);

        let result = HandleResult {
            reply: interaction.reply,
            actions: interaction.actions,
            forward_to_session: None,
            menu: interaction.menu,
        };
        self.send_handle_result(&peer_id, &result).await;
    }
}

/// Forwards completed turns that the inbound reply path does not own.
///
/// The bot is held weakly so a retired instance cannot keep pushing after its
/// lifecycle slot was replaced.
struct WeixinSessionOutputSubscriber {
    bot: Weak<WeixinBot>,
}

#[async_trait::async_trait]
impl EventSubscriber for WeixinSessionOutputSubscriber {
    async fn on_event(&self, event: &AgenticEvent) -> EventSubscriberResult {
        let Some((session_id, turn_id)) = settled_session_turn(event) else {
            return Ok(());
        };
        let Some(bot) = self.bot.upgrade() else {
            return Ok(());
        };
        let session_id = session_id.to_string();
        let turn_id = turn_id.to_string();
        // The router awaits every subscriber inline while this path reads the
        // session and sends over the network, so the work must not run here.
        tokio::spawn(async move {
            bot.handle_session_turn_settled(session_id, turn_id).await;
        });
        Ok(())
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    #[test]
    fn inbound_files_preserve_pending_answers_on_local_and_remote_devices() {
        use super::super::command_router::PendingAction;
        use super::super::locale::{strings_for, BotLanguage};
        for language in [BotLanguage::ZhCN, BotLanguage::ZhTW, BotLanguage::EnUS] {
            let strings = strings_for(language);
            let mut state = BotChatState::new("peer".into());
            assert!(inbound_file_rejection(&state, strings).is_none());
            state.set_pending(PendingAction::SelectDevice { options: vec![] });
            assert_eq!(
                inbound_file_rejection(&state, strings),
                Some(strings.inbound_file_pending)
            );
            assert!(state.pending_action.is_some());
            state.account_remote_context = true;
            assert_eq!(
                inbound_file_rejection(&state, strings),
                Some(strings.inbound_file_pending)
            );
        }
    }

    #[test]
    fn context_token_error_heuristic_uses_provider_contract() {
        let app_err = anyhow!(
            "ilink ilink/bot/sendmessage application error ret=0 errcode=12345 errmsg=context_token expired"
        );
        assert!(WeixinProviderClient::is_context_token_error(&app_err));

        let net_err = anyhow!("error sending request: connection refused");
        assert!(!WeixinProviderClient::is_context_token_error(&net_err));
    }

    #[test]
    fn body_from_message_plain_text_uses_provider_parser() {
        let msg = json!({
            "item_list": [{ "type": 1, "text_item": { "text": "hi" } }]
        });
        assert_eq!(weixin_provider::body_from_message(&msg), "hi");
    }

    #[test]
    fn body_from_message_quoted_text_uses_provider_parser() {
        let msg = json!({
            "item_list": [{
                "type": 1,
                "text_item": { "text": "reply" },
                "ref_msg": { "title": " earlier ", "message_item": { "type": 1, "text_item": { "text": "orig" } } }
            }]
        });
        let body = weixin_provider::body_from_message(&msg);
        assert!(body.contains("[\u{5f15}\u{7528}:"));
        assert!(body.contains("reply"));
    }

    fn pending(text: &str, queued_at: i64) -> PendingOutbound {
        PendingOutbound {
            id: uuid::Uuid::new_v4().to_string(),
            session_id: "session".to_string(),
            text: text.to_string(),
            queued_at,
        }
    }

    fn backlog(texts: &[&str]) -> Vec<PendingOutbound> {
        texts
            .iter()
            .enumerate()
            .map(|(index, text)| pending(*text, 1_000 + index as i64))
            .collect()
    }

    #[test]
    fn proactive_push_waits_for_durable_completion_and_ignores_history_edits() {
        let early = AgenticEvent::DialogTurnCompleted {
            session_id: "session".into(),
            turn_id: "turn".into(),
            total_rounds: 1,
            total_tools: 0,
            duration_ms: 10,
            partial_recovery_reason: None,
            success: Some(true),
            finish_reason: Some("complete".into()),
            has_final_response: Some(true),
            background_delivery: None,
        };
        assert!(settled_session_turn(&early).is_none());
        assert!(settled_session_turn(&AgenticEvent::SessionHistoryChanged {
            session_id: "session".into(),
            settled_turn_id: None,
        })
        .is_none());
        assert_eq!(
            settled_session_turn(&AgenticEvent::SessionHistoryChanged {
                session_id: "session".into(),
                settled_turn_id: Some("turn".into()),
            }),
            Some(("session", "turn"))
        );
    }

    #[test]
    fn settled_projection_ignores_empty_or_partial_active_overlay() {
        for text in ["", "partial answer"] {
            let poll = json!({
                "active_turn": {"turn_id":"turn", "status":"active", "text":text},
                "new_messages": [{"turn_id":"turn", "role":"assistant", "status":"done", "content":"final scheduled result"}]
            });
            assert_eq!(
                settled_turn_text(poll, "turn").as_deref(),
                Some("final scheduled result")
            );
        }
        let poll = json!({
            "active_turn": {"turn_id":"next", "status":"active", "text":"another turn"},
            "message_snapshot": [{"id":"turn_assistant", "role":"assistant", "status":"done", "content":"legacy final result"}]
        });
        assert_eq!(
            settled_turn_text(poll, "turn").as_deref(),
            Some("legacy final result")
        );
    }

    #[test]
    fn background_delivery_suppresses_quiet_but_preserves_failure_and_old_host_output() {
        use openbitfun_core_types::background_delivery::{
            BackgroundDelivery, BackgroundReportDisposition, BackgroundReportPolicy,
        };
        let mut delivery = BackgroundDelivery::pending(
            "generic".into(),
            "turn".into(),
            BackgroundReportPolicy::Conditional,
        );
        delivery.disposition = BackgroundReportDisposition::Quiet;
        delivery.resolved_at_ms = Some(1);
        let mut poll = json!({"new_messages":[{"turn_id":"turn","role":"assistant","status":"completed","content":"No change; remaining quiet.","metadata":{"backgroundDelivery":delivery}}]});
        assert!(settled_turn_text(poll.clone(), "turn").is_none());
        poll["new_messages"][0]["status"] = json!("failed");
        poll["new_messages"][0]["error"] = json!("Model provider disconnected");
        assert_eq!(
            settled_turn_text(poll.clone(), "turn").as_deref(),
            Some("Model provider disconnected")
        );
        poll["new_messages"][0]["status"] = json!("completed");
        poll["new_messages"][0]["error"] = Value::Null;
        poll["new_messages"][0]["metadata"]["backgroundDelivery"]["schemaVersion"] = json!(2);
        assert_eq!(
            settled_turn_text(poll, "turn").as_deref(),
            Some("No change; remaining quiet.")
        );
    }

    #[test]
    fn settled_projection_skips_failed_cancelled_and_unrelated_turns() {
        for status in ["active", "failed", "cancelled"] {
            let poll = json!({"new_messages": [{"turn_id":"turn", "role":"assistant", "status":status, "content":"partial"}]});
            assert!(settled_turn_text(poll, "turn").is_none());
        }
        let poll = json!({"new_messages": [{"turn_id":"other", "role":"assistant", "status":"done", "content":"another answer"}]});
        assert!(settled_turn_text(poll, "turn").is_none());
    }

    #[tokio::test]
    async fn bot_owned_settled_turn_keeps_the_original_reply_path() {
        let bot = test_bot("http://127.0.0.1:1/".into()).await;
        bot.mark_own_turn("inbound-turn").await;
        bot.handle_session_turn_settled("session".into(), "inbound-turn".into())
            .await;
        assert!(bot.pending_outbound.lock().await.is_empty());
    }

    #[test]
    fn tracked_bot_turns_stay_within_the_window() {
        let mut turns = VecDeque::new();
        for index in 0..(MAX_TRACKED_OWN_TURNS + 5) {
            push_tracked_turn(&mut turns, &format!("turn_{index}"));
        }
        assert_eq!(turns.len(), MAX_TRACKED_OWN_TURNS);
        let newest = format!("turn_{}", MAX_TRACKED_OWN_TURNS + 4);
        assert!(turns.iter().any(|id| id == &newest));
        assert!(!turns.iter().any(|id| id == "turn_0"));
    }

    #[test]
    fn pending_backlog_drops_the_oldest_past_the_pre_merge_cap() {
        // The count cap bounds what is held before merging; the merged payload
        // has its own byte cap.
        let mut queue = VecDeque::new();
        let now = 1_000_000;
        let mut dropped = 0;
        for index in 0..(MAX_PENDING_OUTBOUND_PER_PEER + 3) {
            dropped += push_pending(&mut queue, pending(&format!("m{index}"), now), now);
        }
        assert_eq!(queue.len(), MAX_PENDING_OUTBOUND_PER_PEER);
        assert_eq!(dropped, 3);
        assert_eq!(queue.front().map(|item| item.text.as_str()), Some("m3"));
        assert_eq!(queue.back().map(|item| item.text.as_str()), Some("m22"));
    }

    #[test]
    fn pending_backlog_expires_entries_past_the_retention_window() {
        let mut queue = VecDeque::new();
        let now = 1_000_000;
        push_pending(
            &mut queue,
            pending("stale", now - PENDING_OUTBOUND_TTL_SECS - 1),
            now,
        );
        push_pending(&mut queue, pending("fresh", now), now);
        assert_eq!(queue.len(), 1);
        assert_eq!(queue.front().map(|item| item.text.as_str()), Some("fresh"));
        assert_eq!(drop_expired_pending(&mut queue, now), 0);
    }

    #[test]
    fn merged_backlog_becomes_one_reply_in_time_order() {
        let merged = merge_pending(&backlog(&["first", "second", "third"]));
        assert_eq!(
            merged,
            format!("first{PENDING_SEPARATOR}second{PENDING_SEPARATOR}third")
        );
        // However many turns the backlog carries, it spends one reply.
        assert_eq!(weixin_provider::weixin_reply_count(&merged), 1);
    }

    #[test]
    fn merged_backlog_skips_entries_with_no_text() {
        let merged = merge_pending(&backlog(&["first", "   ", "", "second"]));
        assert_eq!(merged, format!("first{PENDING_SEPARATOR}second"));
    }

    #[test]
    fn merged_backlog_drops_the_oldest_to_fit_one_reply() {
        // The two answers cannot share one reply, so the newest is kept.
        let oldest = "o".repeat(MAX_PROACTIVE_PUSH_BYTES - 100);
        let newest = "n".repeat(200);
        let merged = merge_pending(&backlog(&[oldest.as_str(), newest.as_str()]));
        assert_eq!(merged, newest);
        assert_eq!(weixin_provider::weixin_reply_count(&merged), 1);
    }

    #[test]
    fn merged_backlog_truncates_a_single_oversized_answer() {
        // The newest answer alone exceeds the cap, so its head is sent instead
        // of nothing at all.
        let huge = "a".repeat(MAX_PROACTIVE_PUSH_BYTES + 100);
        let merged = merge_pending(&backlog(&[huge.as_str()]));
        assert_eq!(merged.len(), MAX_PROACTIVE_PUSH_BYTES);
        assert!(merged.ends_with("\n…"));
        assert_eq!(weixin_provider::weixin_reply_count(&merged), 1);
    }

    #[test]
    fn merged_backlog_never_splits_a_character() {
        // The byte cap lands mid-character, so the head must stay valid UTF-8
        // and still fit inside one reply.
        let huge = "\u{5b57}".repeat(MAX_PROACTIVE_PUSH_BYTES);
        let merged = merge_pending(&backlog(&[huge.as_str()]));
        assert!(merged.len() <= MAX_PROACTIVE_PUSH_BYTES);
        assert_eq!(weixin_provider::weixin_reply_count(&merged), 1);
    }

    async fn test_bot(base_url: String) -> Arc<WeixinBot> {
        let bot = Arc::new(WeixinBot::new(WeixinConfig {
            ilink_token: "fixture-token".into(),
            base_url,
            bot_account_id: format!("proactive-test-{}", uuid::Uuid::new_v4()),
        }));
        let mut state = BotChatState::new("peer".into());
        state.paired = true;
        state.current_session_id = Some("session".into());
        bot.chat_states.write().await.insert("peer".into(), state);
        bot.context_tokens
            .write()
            .await
            .insert("peer".into(), "context".into());
        bot
    }

    // A loopback provider with an explicit response gate exercises enqueueing
    // while the real async HTTP send is in flight, without timing assumptions.
    async fn mock_outbound(
        responses: Vec<&'static str>,
        first_response: Option<tokio::sync::oneshot::Receiver<()>>,
    ) -> (
        String,
        tokio::sync::mpsc::UnboundedReceiver<Value>,
        tokio::task::JoinHandle<()>,
    ) {
        use tokio::io::{AsyncReadExt, AsyncWriteExt};
        let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
        let base = format!("http://{}/", listener.local_addr().unwrap());
        let (tx, rx) = tokio::sync::mpsc::unbounded_channel();
        let task = tokio::spawn(async move {
            let mut first_response = first_response;
            for response in responses {
                let (mut stream, _) = listener.accept().await.unwrap();
                let mut request = Vec::new();
                let mut chunk = [0; 4096];
                loop {
                    let count = stream.read(&mut chunk).await.unwrap();
                    assert!(count > 0, "request ended before the body");
                    request.extend_from_slice(&chunk[..count]);
                    if let Some(end) = request.windows(4).position(|w| w == b"\r\n\r\n") {
                        let headers = String::from_utf8_lossy(&request[..end]);
                        let length: usize = headers
                            .lines()
                            .find_map(|line| {
                                let (name, value) = line.split_once(':')?;
                                name.eq_ignore_ascii_case("content-length")
                                    .then(|| value.trim().parse().unwrap())
                            })
                            .unwrap();
                        if request.len() >= end + 4 + length {
                            tx.send(
                                serde_json::from_slice(&request[end + 4..end + 4 + length])
                                    .unwrap(),
                            )
                            .unwrap();
                            break;
                        }
                    }
                }
                if let Some(gate) = first_response.take() {
                    gate.await.unwrap();
                }
                stream.write_all(format!(
                    "HTTP/1.1 200 OK\r\nContent-Type: application/json\r\nContent-Length: {}\r\nConnection: close\r\n\r\n{}",
                    response.len(), response
                ).as_bytes()).await.unwrap();
            }
        });
        (base, rx, task)
    }

    #[tokio::test]
    async fn unsupported_media_and_empty_input_never_route_partial_or_empty_turns() {
        let (base, mut requests, server) = mock_outbound(vec!["{}"; 3], None).await;
        let bot = test_bot(base).await;
        let original = serde_json::to_value(&*bot.chat_states.read().await).unwrap();
        let epoch = bot.runtime_fence.identity_epoch();
        for message in [
            json!({"item_list":[{"type":3,"voice_item":{}},{"type":1,"text_item":{"text":"transcribe this voice"}}]}),
            json!({"item_list":[{"type":3,"voice_item":{}}]}),
            json!({"item_list":[{"type":1,"text_item":{"text":"   "}}]}),
        ] {
            bot.process_provider_message("peer".into(), message, epoch)
                .await;
            let reply = requests.recv().await.unwrap();
            assert!(reply["msg"]["item_list"][0]["text_item"]["text"]
                .as_str()
                .unwrap()
                .contains("Agent"));
            assert_eq!(
                serde_json::to_value(&*bot.chat_states.read().await).unwrap(),
                original
            );
        }
        server.await.unwrap();
        assert!(!weixin_provider::has_unsupported_media_items(
            &json!({"item_list":[{"type":3,"voice_item":{"text":"transcribed voice"}}]})
        ));
    }

    #[tokio::test]
    async fn inbound_peer_waits_for_media_failure_before_routing_next_message() {
        let (release, gate) = tokio::sync::oneshot::channel();
        let (base, mut requests, server) = mock_outbound(vec!["{}", "{}"], Some(gate)).await;
        let bot = test_bot(base).await;
        let (stop, stopped) = tokio::sync::watch::channel(false);
        let sender = bot.spawn_inbound_peer("peer".into(), stopped);
        let epoch = bot.runtime_fence.identity_epoch();
        sender
            .send((json!({"item_list":[{"type":2}]}), epoch))
            .await
            .unwrap();
        let first = tokio::time::timeout(Duration::from_secs(5), requests.recv())
            .await
            .unwrap()
            .unwrap();
        assert!(first["msg"]["item_list"][0]["text_item"]["text"]
            .as_str()
            .unwrap()
            .contains("Agent"));
        sender
            .send((
                json!({"item_list":[{"type":1,"text_item":{"text":"/help"}}]}),
                epoch,
            ))
            .await
            .unwrap();
        // The failed media reply is still in flight. The subsequent text must
        // not route or answer until that first input finishes.
        assert!(
            tokio::time::timeout(Duration::from_millis(30), requests.recv())
                .await
                .is_err()
        );
        release.send(()).unwrap();
        tokio::time::timeout(Duration::from_secs(5), requests.recv())
            .await
            .unwrap()
            .unwrap();
        assert!(bot.chat_states.read().await.contains_key("peer"));
        bot.process_provider_message(
            "stale-peer".into(),
            json!({"item_list":[{"type":1,"text_item":{"text":"hello"}}]}),
            epoch + 1,
        )
        .await;
        assert!(!bot.chat_states.read().await.contains_key("stale-peer"));
        stop.send(true).unwrap();
        tokio::time::timeout(Duration::from_secs(5), sender.closed())
            .await
            .unwrap();
        server.await.unwrap();
    }

    #[tokio::test]
    async fn proactive_send_ack_preserves_new_output_when_queue_overflows() {
        let (release, gate) = tokio::sync::oneshot::channel();
        let (base, mut requests, server) = mock_outbound(vec!["{}", "{}"], Some(gate)).await;
        let bot = test_bot(base).await;
        for i in 0..MAX_PENDING_OUTBOUND_PER_PEER {
            bot.notify_session_output("session", &format!("old-{i}"))
                .await;
        }
        let sender = bot.clone();
        let sending = tokio::spawn(async move { sender.flush_pending_outbound().await });
        let first = tokio::time::timeout(Duration::from_secs(5), requests.recv())
            .await
            .unwrap()
            .unwrap();
        assert!(first["msg"]["item_list"][0]["text_item"]["text"]
            .as_str()
            .unwrap()
            .contains("old-19"));
        bot.notify_session_output("session", "new-unsent").await;
        release.send(()).unwrap();
        sending.await.unwrap();
        let remaining = bot.pending_snapshot("peer").await;
        assert_eq!(remaining.len(), 1);
        assert_eq!(remaining[0].text, "new-unsent");
        bot.flush_pending_outbound().await;
        let second = requests.recv().await.unwrap();
        assert_eq!(
            second["msg"]["item_list"][0]["text_item"]["text"],
            "new-unsent"
        );
        assert!(bot.pending_snapshot("peer").await.is_empty());
        server.await.unwrap();
    }

    #[tokio::test]
    async fn proactive_send_waits_for_context_and_retries_provider_failure() {
        let (base, mut requests, server) = mock_outbound(
            vec![r#"{"ret":-1,"errmsg":"temporary failure"}"#, "{}"],
            None,
        )
        .await;
        let bot = test_bot(base).await;
        bot.context_tokens.write().await.clear();
        bot.notify_session_output("session", "scheduled result")
            .await;
        bot.flush_pending_outbound().await;
        assert!(requests.try_recv().is_err());
        assert_eq!(bot.pending_snapshot("peer").await.len(), 1);
        bot.context_tokens
            .write()
            .await
            .insert("peer".into(), "fresh-context".into());
        bot.flush_pending_outbound().await;
        assert_eq!(bot.pending_snapshot("peer").await.len(), 1);
        bot.flush_pending_outbound().await;
        assert!(bot.pending_snapshot("peer").await.is_empty());
        for _ in 0..2 {
            let request = requests.recv().await.unwrap();
            assert_eq!(request["msg"]["context_token"], "fresh-context");
            assert_eq!(
                request["msg"]["item_list"][0]["text_item"]["text"],
                "scheduled result"
            );
        }
        server.await.unwrap();
    }

    #[tokio::test]
    async fn fourth_scheduled_result_is_not_blocked_by_an_artificial_daily_quota() {
        let (base, mut requests, server) = mock_outbound(vec!["{}"; 4], None).await;
        let bot = test_bot(base).await;
        for i in 0..4 {
            bot.notify_session_output("session", &format!("result-{i}"))
                .await;
            bot.flush_pending_outbound().await;
            let request = requests.recv().await.unwrap();
            assert_eq!(
                request["msg"]["item_list"][0]["text_item"]["text"],
                format!("result-{i}")
            );
        }
        server.await.unwrap();
    }

    #[tokio::test]
    async fn switching_session_discards_old_backlog_without_discarding_new_output() {
        let bot = test_bot("http://127.0.0.1:1/".into()).await;
        bot.notify_session_output("session", "old-session-output")
            .await;
        bot.chat_states
            .write()
            .await
            .get_mut("peer")
            .unwrap()
            .current_session_id = Some("next".into());
        bot.notify_session_output("next", "new-session-output")
            .await;
        let pending = bot.pending_snapshot("peer").await;
        assert_eq!(pending.len(), 1);
        assert_eq!(pending[0].text, "new-session-output");
        bot.chat_states
            .write()
            .await
            .get_mut("peer")
            .unwrap()
            .account_remote_context = true;
        assert!(bot.pending_snapshot("peer").await.is_empty());
        bot.notify_session_output("next", "must-not-fall-back-to-local")
            .await;
        assert!(bot.pending_snapshot("peer").await.is_empty());
    }

    #[tokio::test]
    async fn pending_output_is_byte_bounded_and_survives_more_than_one_hour() {
        let bot = test_bot("http://127.0.0.1:1/".into()).await;
        bot.notify_session_output("session", &"\u{5b57}".repeat(10000))
            .await;
        let pending = bot.pending_snapshot("peer").await;
        assert!(pending[0].text.len() <= MAX_PROACTIVE_PUSH_BYTES);
        let mut queue = VecDeque::from(pending);
        let queued_at = queue[0].queued_at;
        assert_eq!(drop_expired_pending(&mut queue, queued_at + 3601), 0);
        assert_eq!(
            drop_expired_pending(&mut queue, queued_at + PENDING_OUTBOUND_TTL_SECS + 1),
            1
        );
    }

    #[test]
    fn remote_push_limitation_is_visible_in_both_reply_renderers() {
        for language in [
            super::super::BotLanguage::EnUS,
            super::super::BotLanguage::ZhCN,
            super::super::BotLanguage::ZhTW,
        ] {
            let mut result = HandleResult {
                reply: "Device selected".into(),
                actions: Vec::new(),
                forward_to_session: None,
                menu: super::super::MenuView::plain("Device selected"),
            };
            append_remote_push_notice(&mut result, language);
            let notice =
                openbitfun_services_integrations::remote_connect::bot::strings_for(language)
                    .weixin_remote_push_unsupported;
            assert!(result.reply.contains(notice));
            assert!(result.menu.render_plain_text(language).contains(notice));
        }
    }
    #[tokio::test]
    async fn retired_bot_does_not_enqueue_or_send_pending_output() {
        let bot = test_bot("http://127.0.0.1:1/".into()).await;
        bot.notify_session_output("session", "pending-before-retirement")
            .await;
        bot.runtime_fence.slot.advance();
        bot.notify_session_output("session", "must-not-enqueue")
            .await;
        bot.flush_pending_outbound().await;
        let pending = bot.pending_outbound.lock().await;
        let peer = pending.get("peer").unwrap();
        assert_eq!(peer.queue.len(), 1);
        // A send attempt to the closed endpoint would have deferred this queue.
        assert!(peer.deferred_reason.is_none());
    }

    #[tokio::test]
    async fn every_peer_bound_to_the_completed_session_gets_queued_output() {
        let bot = test_bot("http://127.0.0.1:1/".into()).await;
        let mut state = BotChatState::new("second-peer".into());
        state.paired = true;
        state.current_session_id = Some("session".into());
        bot.chat_states
            .write()
            .await
            .insert("second-peer".into(), state);
        bot.notify_session_output("session", "scheduled result")
            .await;
        assert_eq!(
            bot.pending_snapshot("peer").await[0].text,
            "scheduled result"
        );
        assert_eq!(
            bot.pending_snapshot("second-peer").await[0].text,
            "scheduled result"
        );
    }

    const OWNER: &str = "owner-peer";
    const STRANGER: &str = "stranger-peer";

    /// A loopback provider that answers every call until the test ends.
    /// `getupdates` polls replay `update_batches` and then stay open, like a
    /// long poll with no traffic; every other call succeeds and is recorded.
    async fn mock_provider(
        update_batches: Vec<Value>,
    ) -> (
        String,
        tokio::sync::mpsc::UnboundedReceiver<Value>,
        tokio::task::JoinHandle<()>,
    ) {
        use tokio::io::{AsyncReadExt, AsyncWriteExt};
        let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
        let base = format!("http://{}/", listener.local_addr().unwrap());
        let (tx, rx) = tokio::sync::mpsc::unbounded_channel();
        let updates = Arc::new(std::sync::Mutex::new(VecDeque::from(update_batches)));
        let task = tokio::spawn(async move {
            loop {
                let (mut stream, _) = listener.accept().await.unwrap();
                let tx = tx.clone();
                let updates = updates.clone();
                tokio::spawn(async move {
                    let mut request = Vec::new();
                    let mut chunk = [0; 4096];
                    let body: Value = loop {
                        let count = stream.read(&mut chunk).await.unwrap_or(0);
                        if count == 0 {
                            return;
                        }
                        request.extend_from_slice(&chunk[..count]);
                        let Some(end) = request.windows(4).position(|w| w == b"\r\n\r\n") else {
                            continue;
                        };
                        let headers = String::from_utf8_lossy(&request[..end]);
                        let length: usize = headers
                            .lines()
                            .find_map(|line| {
                                let (name, value) = line.split_once(':')?;
                                name.eq_ignore_ascii_case("content-length")
                                    .then(|| value.trim().parse().unwrap())
                            })
                            .unwrap_or(0);
                        if request.len() >= end + 4 + length {
                            break serde_json::from_slice(&request[end + 4..end + 4 + length])
                                .unwrap();
                        }
                    };
                    let response = if body.get("get_updates_buf").is_some() {
                        let next = updates.lock().unwrap().pop_front();
                        match next {
                            Some(batch) => batch.to_string(),
                            None => std::future::pending().await,
                        }
                    } else {
                        let _ = tx.send(body);
                        "{}".to_string()
                    };
                    let _ = stream
                        .write_all(
                            format!(
                                "HTTP/1.1 200 OK\r\nContent-Type: application/json\r\nContent-Length: {}\r\nConnection: close\r\n\r\n{}",
                                response.len(),
                                response
                            )
                            .as_bytes(),
                        )
                        .await;
                });
            }
        });
        (base, rx, task)
    }

    /// A bot that can answer `OWNER` and `STRANGER`, with no chat paired yet.
    async fn gate_bot(base_url: String) -> Arc<WeixinBot> {
        let bot = Arc::new(WeixinBot::new(WeixinConfig {
            ilink_token: "fixture-token".into(),
            base_url,
            bot_account_id: format!("gate-test-{}", uuid::Uuid::new_v4()),
        }));
        let mut tokens = bot.context_tokens.write().await;
        tokens.insert(OWNER.into(), "owner-context".into());
        tokens.insert(STRANGER.into(), "stranger-context".into());
        drop(tokens);
        bot
    }

    /// A bot whose first pairing already completed with `OWNER`.
    async fn connected_bot(base_url: String) -> Arc<WeixinBot> {
        let bot = gate_bot(base_url).await;
        bot.restore_chat_state(OWNER, super::super::test_support::paired_state(OWNER))
            .await;
        bot
    }

    fn text_message(text: &str) -> Value {
        json!({"item_list":[{"type":1,"text_item":{"text":text}}]})
    }

    fn update(peer: &str, text: &str) -> Value {
        let mut message = text_message(text);
        message["message_type"] = json!(1);
        message["from_user_id"] = json!(peer);
        message
    }

    fn updates(messages: Vec<Value>) -> Value {
        json!({ "ret": 0, "msgs": messages })
    }

    /// The texts sent to `peer` since the previous call.
    fn replies_to(
        requests: &mut tokio::sync::mpsc::UnboundedReceiver<Value>,
        peer: &str,
    ) -> Vec<String> {
        let mut replies = Vec::new();
        while let Ok(request) = requests.try_recv() {
            if request["msg"]["to_user_id"] == peer {
                replies.push(
                    request["msg"]["item_list"][0]["text_item"]["text"]
                        .as_str()
                        .unwrap_or_default()
                        .to_string(),
                );
            }
        }
        replies
    }

    fn saved_chat_id(bot: &WeixinBot) -> Option<String> {
        bot.runtime_fence
            .saved_connection("weixin")
            .map(|saved| saved.chat_id)
    }

    async fn pair_through_updates(bot: &WeixinBot) -> String {
        let (_stop_tx, mut stop_rx) = tokio::sync::watch::channel(false);
        tokio::time::timeout(Duration::from_secs(10), bot.wait_for_pairing(&mut stop_rx))
            .await
            .expect("pairing must finish with the scripted updates")
            .expect("pairing must succeed")
    }

    #[tokio::test]
    async fn unknown_peer_after_first_pairing_is_refused_and_cannot_run_a_command() {
        let (base, mut requests, server) = mock_provider(vec![]).await;
        let bot = connected_bot(base).await;
        let epoch = bot.runtime_fence.identity_epoch();

        bot.process_provider_message(STRANGER.into(), text_message("/help"), epoch)
            .await;

        assert!(
            !bot.chat_states.read().await.contains_key(STRANGER),
            "a peer that never paired must not gain state"
        );
        assert_eq!(replies_to(&mut requests, STRANGER).len(), 1);
        assert_eq!(saved_chat_id(&bot).as_deref(), Some(OWNER));

        bot.process_provider_message(OWNER.into(), text_message("/help"), epoch)
            .await;
        assert!(
            !bot.chat_states.read().await[OWNER]
                .last_menu_commands
                .is_empty(),
            "the paired peer keeps its commands"
        );
        server.abort();
    }

    #[tokio::test]
    async fn outbound_paths_never_create_state_or_reach_an_unpaired_peer() {
        let (base, mut requests, server) = mock_provider(vec![]).await;
        let bot = connected_bot(base).await;
        let epoch = bot.runtime_fence.identity_epoch();

        bot.deliver_interaction(
            STRANGER.into(),
            super::super::test_support::question("tool-1"),
            epoch,
        )
        .await;
        bot.notify_files_ready(
            STRANGER,
            "missing-session",
            None,
            "[report](computer://report.pdf)",
            epoch,
        )
        .await;
        assert!(!bot.chat_states.read().await.contains_key(STRANGER));
        assert_eq!(replies_to(&mut requests, STRANGER), Vec::<String>::new());
        assert_eq!(saved_chat_id(&bot).as_deref(), Some(OWNER));

        // A peer that is known but never completed pairing is treated the
        // same, including by the proactive session-output channel.
        let mut unpaired = BotChatState::new(STRANGER.into());
        unpaired.current_session_id = Some("session".into());
        bot.chat_states
            .write()
            .await
            .insert(STRANGER.into(), unpaired);
        bot.deliver_interaction(
            STRANGER.into(),
            super::super::test_support::question("tool-2"),
            epoch,
        )
        .await;
        bot.notify_session_output("session", "scheduled result")
            .await;
        bot.flush_pending_outbound().await;
        assert_eq!(replies_to(&mut requests, STRANGER), Vec::<String>::new());
        assert!(bot.pending_snapshot(STRANGER).await.is_empty());
        let states = bot.chat_states.read().await;
        assert!(!states[STRANGER].paired);
        assert!(states[STRANGER].pending_action.is_none());
        drop(states);

        // The paired peer still receives its interaction.
        bot.deliver_interaction(
            OWNER.into(),
            super::super::test_support::question("tool-3"),
            epoch,
        )
        .await;
        assert_eq!(replies_to(&mut requests, OWNER).len(), 1);
        server.abort();
    }

    #[tokio::test]
    async fn wrong_codes_are_limited_per_peer_without_locking_the_owner_or_burning_the_code() {
        use super::super::test_support::PAIRING_CODE;
        let mut messages = vec![update(STRANGER, "000000"); 5];
        // The right code no longer helps a peer that used up its attempts.
        messages.push(update(STRANGER, PAIRING_CODE));
        messages.push(update(OWNER, "111111"));
        messages.push(update(OWNER, PAIRING_CODE));
        let (base, mut requests, server) = mock_provider(vec![updates(messages)]).await;
        let bot = gate_bot(base).await;
        bot.register_pairing(PAIRING_CODE).await.unwrap();

        assert_eq!(pair_through_updates(&bot).await, OWNER);

        let states = bot.chat_states.read().await;
        assert!(states.get(OWNER).is_some_and(|state| state.paired));
        assert!(!states.contains_key(STRANGER));
        drop(states);
        // Four "wrong code" replies, then one lockout notice, then silence.
        assert_eq!(replies_to(&mut requests, STRANGER).len(), 5);
        assert_eq!(saved_chat_id(&bot).as_deref(), Some(OWNER));
        server.abort();
    }

    #[tokio::test]
    async fn repeated_messages_from_an_unpaired_peer_get_a_bounded_number_of_replies() {
        use super::super::test_support::PAIRING_CODE;
        // While the first pairing is still pending.
        let mut messages = vec![update(STRANGER, "hello"); 20];
        messages.push(update(OWNER, PAIRING_CODE));
        let (base, mut requests, server) = mock_provider(vec![updates(messages)]).await;
        let bot = gate_bot(base).await;
        bot.register_pairing(PAIRING_CODE).await.unwrap();
        assert_eq!(pair_through_updates(&bot).await, OWNER);
        let replies = replies_to(&mut requests, STRANGER).len();
        assert!(
            (1..=3).contains(&replies),
            "replies while pairing: {replies}"
        );

        // After pairing, in the message loop: text, raw voice and empty input.
        let epoch = bot.runtime_fence.identity_epoch();
        for index in 0..20 {
            let message = match index % 3 {
                0 => text_message("hello again"),
                1 => json!({"item_list":[{"type":3,"voice_item":{}}]}),
                _ => text_message("   "),
            };
            bot.process_provider_message(STRANGER.into(), message, epoch)
                .await;
        }
        let replies = replies_to(&mut requests, STRANGER).len();
        assert!(
            (1..=3).contains(&replies),
            "replies when connected: {replies}"
        );
        assert!(!bot.chat_states.read().await.contains_key(STRANGER));
        server.abort();
    }

    #[tokio::test]
    async fn code_issued_for_a_connected_bot_moves_the_connection_to_the_peer_that_presents_it() {
        use super::super::test_support::PAIRING_CODE;
        let (base, mut requests, server) = mock_provider(vec![]).await;
        let bot = connected_bot(base).await;
        let epoch = bot.runtime_fence.identity_epoch();
        bot.register_pairing(PAIRING_CODE).await.unwrap();

        bot.process_provider_message(STRANGER.into(), text_message("111111"), epoch)
            .await;
        assert!(!bot.chat_states.read().await.contains_key(STRANGER));
        assert_eq!(saved_chat_id(&bot).as_deref(), Some(OWNER));

        bot.process_provider_message(STRANGER.into(), text_message(PAIRING_CODE), epoch)
            .await;
        let states = bot.chat_states.read().await;
        assert!(states.get(STRANGER).is_some_and(|state| state.paired));
        assert!(
            !states.contains_key(OWNER),
            "one connection has one chat: the previous peer is no longer paired"
        );
        drop(states);
        assert_eq!(saved_chat_id(&bot).as_deref(), Some(STRANGER));
        assert!(
            !bot.verify_pairing_code(PAIRING_CODE).await,
            "the pairing code is single use"
        );
        assert!(!replies_to(&mut requests, STRANGER).is_empty());
        server.abort();
    }

    #[tokio::test]
    async fn legacy_persisted_paired_peer_is_restored_without_pairing_again() {
        let saved = super::super::test_support::legacy_saved_connection(
            "weixin",
            OWNER,
            json!({
                "bot_type": "weixin",
                "ilink_token": "fixture-token",
                "base_url": "https://ilinkai.weixin.qq.com",
                "bot_account_id": "fixture-bot"
            }),
        );
        let (base, mut requests, server) = mock_provider(vec![]).await;
        let bot = gate_bot(base).await;
        let epoch = bot.runtime_fence.identity_epoch();

        bot.restore_chat_state(OWNER, saved.chat_state.clone())
            .await;
        bot.process_provider_message(OWNER.into(), text_message("/help"), epoch)
            .await;

        assert_eq!(replies_to(&mut requests, OWNER).len(), 1);
        assert!(
            !bot.chat_states.read().await[OWNER]
                .last_menu_commands
                .is_empty(),
            "the restored peer reaches the command router without a pairing prompt"
        );
        let resaved = bot
            .runtime_fence
            .saved_connection("weixin")
            .expect("restored connection is saved");
        assert_eq!(resaved.chat_id, OWNER);
        assert!(resaved.chat_state.paired);
        // The stored shape is unchanged: an older build reads it back.
        let stored = serde_json::to_value(&resaved.chat_state).unwrap();
        let legacy = serde_json::to_value(&saved.chat_state).unwrap();
        assert_eq!(stored, legacy);
        assert_eq!(stored["paired"], json!(true));
        server.abort();
    }

    #[tokio::test]
    async fn retired_or_reidentified_bot_neither_answers_nor_delivers() {
        let (base, mut requests, server) = mock_provider(vec![]).await;
        let bot = connected_bot(base).await;
        let epoch = bot.runtime_fence.identity_epoch();

        // An account change invalidates work that started before it.
        bot.runtime_fence
            .account_identity_epoch
            .fetch_add(1, std::sync::atomic::Ordering::AcqRel);
        bot.process_provider_message(OWNER.into(), text_message("/help"), epoch)
            .await;
        bot.process_provider_message(STRANGER.into(), text_message("/help"), epoch)
            .await;
        bot.deliver_interaction(
            OWNER.into(),
            super::super::test_support::question("tool-1"),
            epoch,
        )
        .await;
        bot.notify_files_ready(
            OWNER,
            "missing-session",
            None,
            "[report](computer://report.pdf)",
            epoch,
        )
        .await;

        // A replaced instance stays silent for paired and unpaired peers alike.
        let epoch = bot.runtime_fence.identity_epoch();
        bot.runtime_fence.slot.advance();
        bot.process_provider_message(OWNER.into(), text_message("/help"), epoch)
            .await;
        bot.process_provider_message(STRANGER.into(), text_message("/help"), epoch)
            .await;
        bot.deliver_interaction(
            OWNER.into(),
            super::super::test_support::question("tool-2"),
            epoch,
        )
        .await;

        assert!(requests.try_recv().is_err());
        assert!(!bot.chat_states.read().await.contains_key(STRANGER));
        assert_eq!(saved_chat_id(&bot).as_deref(), Some(OWNER));
        server.abort();
    }
}
