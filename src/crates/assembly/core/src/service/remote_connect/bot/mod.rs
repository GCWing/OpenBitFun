//! Bot integration compatibility facade for Remote Connect.
//!
//! Provider-neutral bot DTOs, menu and locale rendering, persistence, and file
//! delivery helpers live in `openbitfun-services-integrations`. Core keeps the
//! command router and platform bot adapters because they still call concrete
//! session, coordinator, image, and runtime services.

pub mod command_router;
pub mod feishu;
pub mod locale;
pub mod menu;
pub(crate) mod pairing_gate;
pub mod telegram;
pub mod weixin;

pub use command_router::{
    set_delegated_identity_provider, BotChatState, ForwardRequest, ForwardedTurnResult,
    HandleResult,
};
pub use openbitfun_services_integrations::remote_connect::bot::{
    auto_push_failed_message, auto_push_intro, auto_push_skip_too_large_message,
    collect_auto_push_files, detect_mime_type, extract_computer_file_paths,
    extract_downloadable_file_paths, extract_output_file_references, format_file_size,
    get_file_metadata, load_bot_persistence, read_bot_credentials_file, read_workspace_file,
    resolve_workspace_path, save_bot_persistence, try_load_bot_persistence,
    try_update_bot_persistence, update_bot_persistence, AutoPushFile, BotConfig, BotLanguage,
    BotListenerLease, BotPairingInfo, BotPersistenceData, MenuItem, MenuItemStyle, MenuView,
    RemoteConnectFormState, RemoteDeviceTarget, SavedBotConnection, WorkspaceFileContent,
};

use std::borrow::Borrow;
use std::collections::HashMap;
use std::hash::Hash;
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::{Arc, Mutex as StdMutex};

/// Authorization is never implied by missing state: a chat counts as paired
/// only when its own state exists and says so. The check never creates state,
/// so every outbound path can ask it about a chat it is about to address.
pub(crate) async fn chat_is_paired<K, Q>(
    states: &tokio::sync::RwLock<HashMap<K, BotChatState>>,
    chat_id: &Q,
) -> bool
where
    K: Eq + Hash + Borrow<Q>,
    Q: Eq + Hash + ?Sized,
{
    states
        .read()
        .await
        .get(chat_id)
        .is_some_and(|state| state.paired)
}

/// Serializes persistence commits with lifecycle generation changes for one
/// bot platform. A retired polling task can finish later, but it can no longer
/// overwrite the replacement instance's persisted state.
#[derive(Default)]
pub(crate) struct BotSlotFence {
    generation: StdMutex<u64>,
}

impl BotSlotFence {
    pub(crate) fn advance(&self) -> u64 {
        let mut generation = self
            .generation
            .lock()
            .unwrap_or_else(|poisoned| poisoned.into_inner());
        *generation = generation.wrapping_add(1);
        if *generation == 0 {
            *generation = 1;
        }
        *generation
    }

    pub(crate) fn is_current(&self, expected_generation: u64) -> bool {
        *self
            .generation
            .lock()
            .unwrap_or_else(|poisoned| poisoned.into_inner())
            == expected_generation
    }

    fn commit_if_current<R>(
        &self,
        expected_generation: u64,
        commit: impl FnOnce() -> R,
    ) -> Option<R> {
        let generation = self
            .generation
            .lock()
            .unwrap_or_else(|poisoned| poisoned.into_inner());
        if *generation != expected_generation {
            return None;
        }
        Some(commit())
    }
}

/// Where a bot instance commits its saved connection. A standalone test fence
/// keeps the document in memory, so a unit test can never replace a saved
/// connection in the product home.
enum BotConnectionStore {
    Product,
    #[cfg(test)]
    Memory(StdMutex<BotPersistenceData>),
}

/// Shared account-identity epoch plus a per-platform lifecycle owner. Network
/// work is not awaited during account replacement; instead every state commit
/// is fenced and sanitized if it started under an older account epoch.
pub(crate) struct BotRuntimeFence {
    account_user_id: String,
    account_identity_epoch: Arc<AtomicU64>,
    observed_identity_epoch: AtomicU64,
    slot: Arc<BotSlotFence>,
    lifecycle_generation: u64,
    connection_store: BotConnectionStore,
}

impl BotRuntimeFence {
    pub(crate) fn new(
        account_identity_epoch: Arc<AtomicU64>,
        slot: Arc<BotSlotFence>,
        lifecycle_generation: u64,
    ) -> Self {
        let observed_identity_epoch = account_identity_epoch.load(Ordering::Acquire);
        Self {
            account_identity_epoch,
            observed_identity_epoch: AtomicU64::new(observed_identity_epoch),
            account_user_id: String::new(),
            slot,
            lifecycle_generation,
            connection_store: BotConnectionStore::Product,
        }
    }

    pub(crate) fn with_account(mut self, user_id: String) -> Self {
        self.account_user_id = user_id;
        self
    }

    pub(crate) fn account_user_id(&self) -> String {
        self.account_user_id.clone()
    }

    #[cfg(test)]
    pub(crate) fn standalone() -> Self {
        let account_identity_epoch = Arc::new(AtomicU64::new(0));
        let slot = Arc::new(BotSlotFence::default());
        let lifecycle_generation = slot.advance();
        let mut fence = Self::new(account_identity_epoch, slot, lifecycle_generation);
        fence.connection_store = BotConnectionStore::Memory(StdMutex::default());
        fence
    }

    /// The connection a standalone fence saved for `bot_type`.
    #[cfg(test)]
    pub(crate) fn saved_connection(&self, bot_type: &str) -> Option<SavedBotConnection> {
        match &self.connection_store {
            BotConnectionStore::Product => None,
            BotConnectionStore::Memory(data) => data
                .lock()
                .unwrap_or_else(|poisoned| poisoned.into_inner())
                .get(bot_type)
                .cloned(),
        }
    }

    /// Saves `connection` as the single connection of its bot type, unless
    /// this instance's lifecycle slot was replaced.
    pub(crate) fn persist_connection(&self, connection: SavedBotConnection) {
        self.commit_if_current(|| match &self.connection_store {
            BotConnectionStore::Product => {
                update_bot_persistence(|data| data.upsert(connection));
            }
            #[cfg(test)]
            BotConnectionStore::Memory(data) => data
                .lock()
                .unwrap_or_else(|poisoned| poisoned.into_inner())
                .upsert(connection),
        });
    }

    pub(crate) fn identity_epoch(&self) -> u64 {
        self.account_identity_epoch.load(Ordering::Acquire)
    }

    pub(crate) fn is_lifecycle_current(&self) -> bool {
        self.slot.is_current(self.lifecycle_generation)
    }

    pub(crate) fn reconcile_states<K>(&self, states: &mut HashMap<K, BotChatState>) -> bool
    where
        K: Eq + Hash,
    {
        let current = self.identity_epoch();
        if self.observed_identity_epoch.load(Ordering::Acquire) == current {
            return false;
        }
        for state in states.values_mut() {
            state.clear_delegated_identity();
        }
        self.observed_identity_epoch
            .store(current, Ordering::Release);
        true
    }

    pub(crate) fn clear_states<K>(&self, states: &mut HashMap<K, BotChatState>)
    where
        K: Eq + Hash,
    {
        let current = self.identity_epoch();
        for state in states.values_mut() {
            state.clear_delegated_identity();
        }
        self.observed_identity_epoch
            .store(current, Ordering::Release);
    }

    #[cfg(test)]
    pub(crate) fn sanitize_after_epoch(&self, started_epoch: u64, state: &mut BotChatState) {
        if started_epoch != self.identity_epoch() {
            state.clear_delegated_identity();
        }
    }

    pub(crate) fn persistence_snapshot(&self, state: &BotChatState) -> BotChatState {
        let mut snapshot = state.clone();
        if self.observed_identity_epoch.load(Ordering::Acquire) != self.identity_epoch() {
            snapshot.clear_delegated_identity();
        }
        snapshot
    }

    pub(crate) fn commit_if_current<R>(&self, commit: impl FnOnce() -> R) -> Option<R> {
        self.slot
            .commit_if_current(self.lifecycle_generation, commit)
    }
}

/// Fixtures shared by the platform adapter tests.
#[cfg(test)]
pub(crate) mod test_support {
    use super::command_router::{BotInteractiveRequest, PendingAction};
    use super::{BotChatState, BotPersistenceData, MenuView, SavedBotConnection};

    /// A pairing code no test fixture guesses by accident.
    pub(crate) const PAIRING_CODE: &str = "482913";

    pub(crate) fn paired_state(chat_id: &str) -> BotChatState {
        let mut state = BotChatState::new(chat_id.to_string());
        state.paired = true;
        state
    }

    /// A question a running turn asks the chat that started it.
    pub(crate) fn question(tool_id: &str) -> BotInteractiveRequest {
        BotInteractiveRequest {
            remote_target: None,
            reply: "Pick one".into(),
            actions: Vec::new(),
            menu: MenuView::plain("Pick one"),
            pending_action: PendingAction::AskUserQuestion {
                tool_id: tool_id.into(),
                questions: Vec::new(),
                current_index: 0,
                answers: Vec::new(),
                awaiting_custom_text: false,
                pending_answer: None,
            },
        }
    }

    /// The persistence document as a release before the pairing gate fix
    /// wrote it: no optional fields, a bare workspace path, `paired: true`.
    pub(crate) fn legacy_saved_connection(
        bot_type: &str,
        chat_id: &str,
        config: serde_json::Value,
    ) -> SavedBotConnection {
        let document = serde_json::json!({
            "connections": [{
                "account_user_id": "account",
                "bot_type": bot_type,
                "chat_id": chat_id,
                "config": config,
                "chat_state": {
                    "chat_id": chat_id,
                    "paired": true,
                    "current_workspace": "/legacy/workspace",
                    "current_assistant": null,
                    "current_session_id": "legacy-session",
                    "display_mode": "pro"
                },
                "connected_at": 1
            }],
            "form_state": {},
            "verbose_mode": false
        });
        let data: BotPersistenceData =
            serde_json::from_value(document).expect("legacy bot persistence must deserialize");
        data.get(bot_type)
            .cloned()
            .expect("legacy connection must be present")
    }
}

#[cfg(test)]
mod lifecycle_tests {
    use super::*;

    #[test]
    fn account_epoch_sanitizes_a_late_state_commit() {
        let account_epoch = Arc::new(AtomicU64::new(3));
        let slot = Arc::new(BotSlotFence::default());
        let generation = slot.advance();
        let fence = BotRuntimeFence::new(account_epoch.clone(), slot, generation);
        let mut states = HashMap::from([("chat", {
            let mut state = BotChatState::new("chat".into());
            state.relay_url = Some("https://relay-a.example".into());
            state.set_delegated_identity("token-a".into(), vec![1; 32]);
            state
        })]);

        account_epoch.fetch_add(1, Ordering::AcqRel);

        assert!(fence.reconcile_states(&mut states));
        let state = states.get("chat").expect("chat state should remain");
        assert!(state.relay_url.is_none());
        assert!(!state.has_delegated_identity());
    }

    #[test]
    fn account_epoch_rejects_identity_returned_by_late_pairing() {
        let account_epoch = Arc::new(AtomicU64::new(11));
        let slot = Arc::new(BotSlotFence::default());
        let generation = slot.advance();
        let fence = BotRuntimeFence::new(account_epoch.clone(), slot, generation);
        let started_epoch = fence.identity_epoch();
        let mut late_state = BotChatState::new("late-chat".into());
        late_state.relay_url = Some("https://relay-a.example".into());
        late_state.set_delegated_identity("token-a".into(), vec![2; 32]);

        account_epoch.fetch_add(1, Ordering::AcqRel);
        fence.sanitize_after_epoch(started_epoch, &mut late_state);

        assert!(late_state.relay_url.is_none());
        assert!(!late_state.has_delegated_identity());
    }

    #[test]
    fn retired_slot_cannot_commit_after_replacement() {
        let account_epoch = Arc::new(AtomicU64::new(0));
        let slot = Arc::new(BotSlotFence::default());
        let old_generation = slot.advance();
        let old = BotRuntimeFence::new(account_epoch.clone(), slot.clone(), old_generation);
        let new_generation = slot.advance();
        let replacement = BotRuntimeFence::new(account_epoch, slot, new_generation);
        let committed = AtomicU64::new(0);

        assert!(old
            .commit_if_current(|| committed.store(1, Ordering::Release))
            .is_none());
        assert!(replacement
            .commit_if_current(|| committed.store(2, Ordering::Release))
            .is_some());
        assert_eq!(committed.load(Ordering::Acquire), 2);
    }
}

/// Reads from the output's session, never from mutable bot menu selection.
pub(crate) async fn read_output_file(
    session_id: &str,
    remote_target: Option<&command_router::RemoteBotTarget>,
    reference: &str,
    max_bytes: u64,
    is_current: &(dyn Fn() -> bool + Sync),
) -> Result<WorkspaceFileContent, String> {
    if let Some(target) = remote_target {
        if target.session_id != session_id {
            return Err("Output session changed".into());
        }
        return target.read_file(reference, max_bytes, is_current).await;
    }
    let content = crate::service_agent_runtime::CoreServiceAgentRuntime::remote_file_target(
        reference,
        Some(session_id),
    )
    .await?
    .read(max_bytes)
    .await?;
    Ok(WorkspaceFileContent {
        name: content.name,
        bytes: content.bytes,
        mime_type: content.mime_type,
        size: content.size,
    })
}

/// Retire only the interactions actually observed in a completed turn
/// (`target` is its device, `None` for a turn on this host). Another
/// turn/device may still have a pending or queued question in this chat.
pub(crate) async fn retire_remote_interactions<K: Eq + Hash>(
    states: &tokio::sync::RwLock<HashMap<K, BotChatState>>,
    chat_id: &K,
    target: Option<&command_router::RemoteBotTarget>,
    tool_ids: &[String],
    fence: &BotRuntimeFence,
    epoch: u64,
) -> Option<command_router::BotInteractiveRequest> {
    if tool_ids.is_empty() {
        return None;
    }
    let mut states = states.write().await;
    if !fence.is_lifecycle_current() || fence.identity_epoch() != epoch {
        return None;
    }
    // A chat that is no longer paired has no prompt left to show or retire.
    let state = states.get_mut(chat_id).filter(|state| state.paired)?;
    command_router::retire_completed_remote_tools(state, target, tool_ids)
}

pub(crate) use openbitfun_services_integrations::remote_connect::bot::delivery::HeldReplies;

/// Deliver a turn's final reply. The provider client already retried each
/// part; whatever is still undelivered is held for the chat's next inbound
/// message, and the chat is told (best effort) that the reply was not
/// delivered and how to get it.
pub(crate) async fn deliver_final_reply<K, F, Fut>(
    held: &HeldReplies<K>,
    chat: &K,
    text: &str,
    send: F,
) where
    K: Eq + Hash + Clone,
    F: Fn(String) -> Fut,
    Fut: std::future::Future<Output = anyhow::Result<()>>,
{
    use openbitfun_services_integrations::remote_connect::bot::delivery::undelivered_remainder;
    if text.trim().is_empty() {
        return;
    }
    let Err(error) = send(text.to_string()).await else {
        return;
    };
    log::warn!("Bot final reply was not delivered; holding it for the next message: {error}");
    let dropped = held.hold(chat, undelivered_remainder(&error, text));
    if dropped > 0 {
        log::warn!("Bot held-reply backlog exceeded its bound; dropped {dropped} older reply(s)");
    }
    let notice = locale::strings_for(locale::current_bot_language().await).reply_undelivered;
    if let Err(error) = send(notice.to_string()).await {
        log::debug!("Bot undelivered-reply notice also failed: {error}");
    }
}

/// Resend replies held for `chat`, oldest first. A reply that still fails is
/// kept (from its undelivered part) together with every later one.
pub(crate) async fn resend_held_replies<K, F, Fut>(held: &HeldReplies<K>, chat: &K, send: F)
where
    K: Eq + Hash + Clone,
    F: Fn(String) -> Fut,
    Fut: std::future::Future<Output = anyhow::Result<()>>,
{
    use openbitfun_services_integrations::remote_connect::bot::delivery::undelivered_remainder;
    if held.is_empty(chat) {
        return;
    }
    let header = locale::strings_for(locale::current_bot_language().await).held_reply_resent;
    let replies = held.take(chat);
    for (index, reply) in replies.iter().enumerate() {
        let message = format!("{header}\n\n{reply}");
        if let Err(error) = send(message.clone()).await {
            let remainder = undelivered_remainder(&error, &message);
            let first = if remainder == message {
                reply.clone()
            } else {
                remainder
            };
            let mut keep = vec![first];
            keep.extend(replies[index + 1..].iter().cloned());
            held.restore(chat, keep);
            log::warn!("Bot held reply still could not be delivered: {error}");
            return;
        }
    }
    log::info!("Bot resent {} held reply(s)", replies.len());
}

#[cfg(test)]
mod delivery_tests {
    use super::*;
    use openbitfun_services_integrations::remote_connect::bot::delivery::UndeliveredText;
    use std::sync::Mutex as TestMutex;

    #[tokio::test]
    async fn undelivered_final_reply_is_held_and_resent_from_the_failed_part() {
        let held = HeldReplies::<String>::default();
        let chat = "chat".to_string();
        let sent = TestMutex::new(Vec::<String>::new());
        let fail = TestMutex::new(true);
        let send = |text: String| {
            let failing = *fail.lock().unwrap();
            let outcome = if failing && text.starts_with("part one") {
                sent.lock().unwrap().push("part one ".into());
                Err(anyhow::Error::new(UndeliveredText {
                    delivered_chunks: 1,
                    remaining: vec!["part two".into()],
                    cause: "HTTP 502".into(),
                }))
            } else if failing {
                Err(anyhow::anyhow!("offline"))
            } else {
                sent.lock().unwrap().push(text);
                Ok(())
            };
            async move { outcome }
        };

        deliver_final_reply(&held, &chat, "part one part two", &send).await;
        assert!(!held.is_empty(&chat));
        assert_eq!(*sent.lock().unwrap(), vec!["part one "]);

        // Still offline: the reply stays held, unchanged.
        resend_held_replies(&held, &chat, &send).await;
        assert!(!held.is_empty(&chat));

        *fail.lock().unwrap() = false;
        resend_held_replies(&held, &chat, &send).await;
        assert!(held.is_empty(&chat));
        let sent = sent.lock().unwrap();
        assert_eq!(sent.len(), 2);
        assert!(sent[1].ends_with("part two"));
        assert!(!sent[1].contains("part one"));
    }
}
