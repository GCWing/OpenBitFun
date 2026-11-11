//! Telegram bot integration for Remote Connect.
//!
//! Users create their own bot via @BotFather, obtain a token, and enter it
//! in OpenBitFun settings.  The desktop polls for updates via the Telegram Bot
//! API (long polling) and routes messages through the shared command router.

use anyhow::{anyhow, Result};
use log::{error, info, warn};
use openbitfun_services_integrations::remote_connect::bot::telegram::{
    TelegramBotApi, TelegramIncomingMessage,
};
pub use openbitfun_services_integrations::remote_connect::bot::telegram::{
    TelegramConfig, MAX_TELEGRAM_FILE_BYTES,
};
use std::collections::HashMap;
use std::sync::Arc;
use tokio::sync::RwLock;

use super::command_router::{
    complete_im_bot_pairing, current_bot_language, execute_forwarded_turn, handle_command,
    parse_command, BotAction, BotChatState, BotInteractionHandler, BotInteractiveRequest,
    BotMessageSender, HandleResult,
};
use super::pairing_gate::{PairingGate, UnpairedDecision};
use super::{
    load_bot_persistence, BotConfig, BotRuntimeFence, SavedBotConnection, WorkspaceFileContent,
};
use crate::service::remote_connect::remote_server::ImageAttachment;

/// Telegram Bot API calls this adapter makes. The provider client is the
/// production implementation; unit tests substitute a scripted fake.
#[async_trait::async_trait]
pub(crate) trait TelegramPlatform: Send + Sync {
    fn bot_token(&self) -> &str;
    async fn send_message(&self, chat_id: i64, text: &str) -> Result<()>;
    async fn send_message_with_keyboard(
        &self,
        chat_id: i64,
        text: &str,
        actions: &[BotAction],
    ) -> Result<()>;
    async fn send_artifact(&self, chat_id: i64, content: WorkspaceFileContent) -> Result<()>;
    async fn set_bot_commands(&self) -> Result<()>;
    async fn poll_updates(
        &self,
        last_update_id: i64,
    ) -> Result<(i64, Vec<TelegramIncomingMessage>)>;
}

#[async_trait::async_trait]
impl TelegramPlatform for TelegramBotApi {
    fn bot_token(&self) -> &str {
        &self.config().bot_token
    }

    async fn send_message(&self, chat_id: i64, text: &str) -> Result<()> {
        TelegramBotApi::send_message(self, chat_id, text).await
    }

    async fn send_message_with_keyboard(
        &self,
        chat_id: i64,
        text: &str,
        actions: &[BotAction],
    ) -> Result<()> {
        TelegramBotApi::send_message_with_keyboard(self, chat_id, text, actions).await
    }

    async fn send_artifact(&self, chat_id: i64, content: WorkspaceFileContent) -> Result<()> {
        TelegramBotApi::send_artifact(self, chat_id, content).await
    }

    async fn set_bot_commands(&self) -> Result<()> {
        TelegramBotApi::set_bot_commands(self).await
    }

    async fn poll_updates(
        &self,
        last_update_id: i64,
    ) -> Result<(i64, Vec<TelegramIncomingMessage>)> {
        TelegramBotApi::poll_updates(self, last_update_id).await
    }
}

pub struct TelegramBot {
    api: Arc<dyn TelegramPlatform>,
    pairing_gate: PairingGate,
    last_update_id: Arc<RwLock<i64>>,
    chat_states: Arc<RwLock<HashMap<i64, BotChatState>>>,
    runtime_fence: BotRuntimeFence,
}

impl TelegramBot {
    #[cfg(test)]
    pub fn new(config: TelegramConfig) -> Self {
        Self::new_fenced(config, BotRuntimeFence::standalone())
    }

    pub(crate) fn new_fenced(config: TelegramConfig, runtime_fence: BotRuntimeFence) -> Self {
        Self::with_platform(Arc::new(TelegramBotApi::new(config)), runtime_fence)
    }

    fn with_platform(api: Arc<dyn TelegramPlatform>, runtime_fence: BotRuntimeFence) -> Self {
        Self {
            api,
            pairing_gate: PairingGate::new(),
            last_update_id: Arc::new(RwLock::new(0)),
            chat_states: Arc::new(RwLock::new(HashMap::new())),
            runtime_fence,
        }
    }

    /// Restore a previously paired chat so the bot skips the pairing step.
    pub async fn restore_chat_state(&self, chat_id: i64, mut state: BotChatState) {
        state.prepare_for_restore();
        let mut states = self.chat_states.write().await;
        self.runtime_fence.reconcile_states(&mut states);
        states.insert(chat_id, state);
        let restored = states
            .get(&chat_id)
            .cloned()
            .expect("restored Telegram state should exist");
        drop(states);
        self.persist_chat_state(chat_id, &restored).await;
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
                    .map(|(chat_id, state)| (*chat_id, state.clone()))
                    .collect();
                drop(states);
                for (chat_id, state) in snapshots {
                    self.persist_chat_state(chat_id, &state).await;
                }
            }
            Err(_) => {
                warn!("Telegram account identity clear deferred behind an in-flight command");
            }
        }
    }

    pub async fn send_message(&self, chat_id: i64, text: &str) -> Result<()> {
        self.api.send_message(chat_id, text).await
    }

    /// Send a message with Telegram inline keyboard buttons.
    ///
    /// Each `BotAction` becomes one button row.  The `callback_data` carries
    /// the full command string so the bot receives it as a synthetic message
    /// when the user taps the button.
    ///
    /// Telegram limits `callback_data` to 64 bytes.  All commands used here
    /// (including `/cancel_task turn_<uuid>`) fit within that limit.
    async fn send_message_with_keyboard(
        &self,
        chat_id: i64,
        text: &str,
        actions: &[BotAction],
    ) -> Result<()> {
        self.api
            .send_message_with_keyboard(chat_id, text, actions)
            .await
    }

    /// Scan `text` for downloadable file references and push every matching
    /// file directly to the Telegram chat as an attachment.  Files exceeding
    /// `MAX_TELEGRAM_FILE_BYTES` are skipped with a brief notice; per-file
    /// upload failures are reported as plain-text replies.
    async fn notify_files_ready(
        &self,
        chat_id: i64,
        session_id: &str,
        remote_target: Option<&super::command_router::RemoteBotTarget>,
        text: &str,
        identity_epoch: u64,
    ) {
        let language = current_bot_language().await;
        for reference in super::extract_output_file_references(text) {
            if !self.runtime_fence.is_lifecycle_current()
                || self.runtime_fence.identity_epoch() != identity_epoch
                || !super::chat_is_paired(&self.chat_states, &chat_id).await
            {
                return;
            }
            let content = super::read_output_file(
                session_id,
                remote_target,
                &reference,
                MAX_TELEGRAM_FILE_BYTES,
                &|| {
                    self.runtime_fence.is_lifecycle_current()
                        && self.runtime_fence.identity_epoch() == identity_epoch
                },
            )
            .await;
            if !self.runtime_fence.is_lifecycle_current()
                || self.runtime_fence.identity_epoch() != identity_epoch
                || !super::chat_is_paired(&self.chat_states, &chat_id).await
            {
                return;
            }
            let result = match content {
                Ok(content) => self
                    .api
                    .send_artifact(chat_id, content)
                    .await
                    .map_err(|error| error.to_string()),
                Err(error) => Err(error),
            };
            if let Err(error) = result {
                warn!("Telegram output file delivery failed: {error}");
                let notice = super::auto_push_failed_message(language, &reference, &error);
                if self.runtime_fence.is_lifecycle_current()
                    && self.runtime_fence.identity_epoch() == identity_epoch
                {
                    let _ = self.send_message(chat_id, &notice).await;
                }
            }
        }
    }

    /// Send a `HandleResult`, using an inline keyboard when actions are present.
    ///
    /// For the "Processing your message…" reply the cancel command line in the
    /// text is replaced with a friendlier prompt, and a Cancel Task button is
    /// added via the inline keyboard.
    async fn send_handle_result(&self, chat_id: i64, result: &HandleResult) {
        if !self.runtime_fence.is_lifecycle_current()
            || !super::chat_is_paired(&self.chat_states, &chat_id).await
        {
            return;
        }
        let text = if result.menu.items.is_empty() && result.menu.title.is_empty() {
            result.reply.clone()
        } else {
            result.menu.render_text_block()
        };
        // Empty replies (e.g. the silent "forward only" result returned by
        // `handle_chat`) must not be sent — Telegram rejects empty bodies
        // and a lone whitespace message is just noise to the user.
        if text.trim().is_empty() {
            return;
        }
        if result.actions.is_empty() {
            if let Err(e) = self.send_message(chat_id, &text).await {
                warn!("Failed to send Telegram message to {chat_id}: {e}");
            }
        } else if let Err(e) = self
            .send_message_with_keyboard(chat_id, &text, &result.actions)
            .await
        {
            warn!("Failed to send Telegram keyboard message: {e}; falling back to plain text");
            if let Err(e2) = self.send_message(chat_id, &result.reply).await {
                warn!("Telegram fallback plain send to {chat_id} also failed: {e2}");
            }
        }
    }

    /// Register the bot command menu visible in Telegram's "/" menu.
    pub async fn set_bot_commands(&self) -> Result<()> {
        self.api.set_bot_commands().await
    }

    /// Only a valid code can replace the chat that owns this connection.
    /// Keep admission serialized with commands, and never create state for a refusal.
    async fn handle_pairing_message(&self, chat_id: i64, text: &str) -> bool {
        let epoch = self.runtime_fence.identity_epoch();
        let mut states = self.chat_states.write().await;
        if !self.runtime_fence.is_lifecycle_current() {
            return false;
        }
        self.runtime_fence.reconcile_states(&mut states);
        if states.get(&chat_id).is_some_and(|state| state.paired) {
            return true;
        }
        let connected_elsewhere = states.values().any(|state| state.paired);
        match self
            .pairing_gate
            .evaluate(&chat_id.to_string(), text, connected_elsewhere)
        {
            UnpairedDecision::Pair => {
                let mut state = BotChatState::new(chat_id.to_string());
                let result = complete_im_bot_pairing(&mut state).await;
                if !self.runtime_fence.is_lifecycle_current()
                    || self.runtime_fence.identity_epoch() != epoch
                {
                    return false;
                }
                states.clear();
                states.insert(chat_id, state.clone());
                self.persist_chat_state(chat_id, &state).await;
                drop(states);
                self.send_handle_result(chat_id, &result).await;
                self.set_bot_commands().await.ok();
                true
            }
            UnpairedDecision::Reply(reply) => {
                drop(states);
                let language = current_bot_language().await;
                if self.runtime_fence.is_lifecycle_current()
                    && self.runtime_fence.identity_epoch() == epoch
                {
                    let _ = self.send_message(chat_id, &reply.text(language)).await;
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

    /// Returns `(chat_id, text, images)` tuples for each incoming message.
    pub async fn poll_updates(&self) -> Result<Vec<(i64, String, Vec<ImageAttachment>)>> {
        let last_update_id = *self.last_update_id.read().await;
        let (new_last_update_id, messages) = self.api.poll_updates(last_update_id).await?;
        if new_last_update_id > last_update_id {
            *self.last_update_id.write().await = new_last_update_id;
        }
        Ok(messages
            .into_iter()
            .map(|message| (message.chat_id, message.text, message.images))
            .collect())
    }

    /// Start a polling loop that checks for pairing codes.
    /// Returns the chat_id when a valid pairing code is received.
    pub async fn wait_for_pairing(
        &self,
        stop_rx: &mut tokio::sync::watch::Receiver<bool>,
    ) -> Result<i64> {
        info!("Telegram bot waiting for pairing code...");
        loop {
            if *stop_rx.borrow() {
                return Err(anyhow!("bot stop requested"));
            }
            let poll_result = tokio::select! {
                result = self.poll_updates() => result,
                _ = stop_rx.changed() => {
                    info!("Telegram wait_for_pairing stopped by signal");
                    return Err(anyhow!("bot stop requested"));
                }
            };
            match poll_result {
                Ok(messages) => {
                    for (chat_id, text, _images) in messages {
                        if *stop_rx.borrow() || !self.runtime_fence.is_lifecycle_current() {
                            return Err(anyhow!("bot lifecycle replaced during pairing"));
                        }
                        if self.handle_pairing_message(chat_id, &text).await {
                            return Ok(chat_id);
                        }
                    }
                }
                Err(e) => {
                    error!("Telegram poll error: {e}");
                    tokio::time::sleep(std::time::Duration::from_secs(5)).await;
                }
            }
        }
    }

    /// Main message loop that runs after pairing is complete.
    /// Continuously polls for messages and routes them through the command router.
    pub async fn run_message_loop(self: Arc<Self>, stop_rx: tokio::sync::watch::Receiver<bool>) {
        info!("Telegram bot message loop started");
        let mut stop = stop_rx;

        loop {
            if *stop.borrow() {
                info!("Telegram bot message loop stopped by signal");
                break;
            }

            let poll_result = tokio::select! {
                result = self.poll_updates() => result,
                _ = stop.changed() => {
                    info!("Telegram bot message loop stopped by signal");
                    break;
                }
            };

            match poll_result {
                Ok(messages) => {
                    for (chat_id, text, images) in messages {
                        let bot = self.clone();
                        tokio::spawn(async move {
                            bot.handle_incoming_message(chat_id, &text, images).await;
                        });
                    }
                }
                Err(e) => {
                    error!("Telegram poll error in message loop: {e}");
                    tokio::time::sleep(std::time::Duration::from_secs(5)).await;
                }
            }
        }
    }

    async fn handle_incoming_message(
        self: &Arc<Self>,
        chat_id: i64,
        text: &str,
        images: Vec<ImageAttachment>,
    ) {
        if !self.runtime_fence.is_lifecycle_current() {
            return;
        }
        let mut states = self.chat_states.write().await;
        let command_identity_epoch = self.runtime_fence.identity_epoch();
        self.runtime_fence.reconcile_states(&mut states);
        if !states.get(&chat_id).is_some_and(|state| state.paired) {
            drop(states);
            self.handle_pairing_message(chat_id, text).await;
            return;
        }
        let state = states.get_mut(&chat_id).expect("paired chat exists");

        if self.runtime_fence.identity_epoch() != command_identity_epoch {
            return;
        }
        let cmd = parse_command(text);
        let result = handle_command(state, cmd, images).await;

        self.runtime_fence.reconcile_states(&mut states);
        if let Some(state) = states.get(&chat_id) {
            self.persist_chat_state(chat_id, state).await;
        }
        drop(states);

        if !self.runtime_fence.is_lifecycle_current()
            || self.runtime_fence.identity_epoch() != command_identity_epoch
        {
            return;
        }

        self.send_handle_result(chat_id, &result).await;

        if let Some(forward) = result.forward_to_session {
            let output_session_id = forward.session_id.clone();
            let output_remote_target = forward.remote_target.clone();
            let output_identity_epoch = command_identity_epoch;
            let bot = self.clone();
            tokio::spawn(async move {
                let interaction_bot = bot.clone();
                let handler: BotInteractionHandler =
                    std::sync::Arc::new(move |interaction: BotInteractiveRequest| {
                        let interaction_bot = interaction_bot.clone();
                        Box::pin(async move {
                            interaction_bot
                                .deliver_interaction(chat_id, interaction, output_identity_epoch)
                                .await;
                        })
                    });
                let msg_bot = bot.clone();
                let sender: BotMessageSender = std::sync::Arc::new(move |text: String| {
                    let msg_bot = msg_bot.clone();
                    Box::pin(async move {
                        if !msg_bot.runtime_fence.is_lifecycle_current()
                            || msg_bot.runtime_fence.identity_epoch() != output_identity_epoch
                            || !super::chat_is_paired(&msg_bot.chat_states, &chat_id).await
                        {
                            return;
                        }
                        msg_bot.send_message(chat_id, &text).await.ok();
                    })
                });
                let verbose_mode = load_bot_persistence().verbose_mode;
                let result = execute_forwarded_turn(
                    forward,
                    Some(handler),
                    Some(sender),
                    verbose_mode,
                    &bot.runtime_fence,
                    output_identity_epoch,
                )
                .await;
                if !bot.runtime_fence.is_lifecycle_current()
                    || bot.runtime_fence.identity_epoch() != output_identity_epoch
                    || !super::chat_is_paired(&bot.chat_states, &chat_id).await
                {
                    return;
                }
                if let Some(next) = super::retire_remote_interactions(
                    &bot.chat_states,
                    &chat_id,
                    output_remote_target.as_ref(),
                    &result.completed_remote_tools,
                    &bot.runtime_fence,
                    output_identity_epoch,
                )
                .await
                {
                    bot.deliver_interaction(chat_id, next, output_identity_epoch)
                        .await;
                }
                if !result.display_text.is_empty() {
                    bot.send_message(chat_id, &result.display_text).await.ok();
                }
                bot.notify_files_ready(
                    chat_id,
                    &output_session_id,
                    output_remote_target.as_ref(),
                    &result.full_text,
                    output_identity_epoch,
                )
                .await;
            });
        }
    }

    async fn deliver_interaction(
        &self,
        chat_id: i64,
        interaction: BotInteractiveRequest,
        identity_epoch: u64,
    ) {
        if !self.runtime_fence.is_lifecycle_current() {
            return;
        }
        let mut states = self.chat_states.write().await;
        self.runtime_fence.reconcile_states(&mut states);
        let Some(state) = states.get_mut(&chat_id).filter(|state| state.paired) else {
            return;
        };
        if self.runtime_fence.identity_epoch() != identity_epoch {
            return;
        }
        if !super::command_router::apply_interactive_request(state, &interaction) {
            return;
        }
        self.persist_chat_state(chat_id, state).await;
        drop(states);

        let result = HandleResult {
            reply: interaction.reply,
            actions: interaction.actions,
            forward_to_session: None,
            menu: interaction.menu,
        };
        self.send_handle_result(chat_id, &result).await;
    }

    async fn persist_chat_state(&self, chat_id: i64, state: &BotChatState) {
        let snapshot = self.runtime_fence.persistence_snapshot(state);
        let connection = SavedBotConnection {
            account_user_id: self.runtime_fence.account_user_id(),
            bot_type: "telegram".to_string(),
            chat_id: chat_id.to_string(),
            config: BotConfig::Telegram {
                bot_token: self.api.bot_token().to_string(),
            },
            chat_state: snapshot,
            connected_at: chrono::Utc::now().timestamp(),
        };
        self.runtime_fence.persist_connection(connection);
    }
}

#[cfg(test)]
mod tests {
    use super::super::test_support::{
        legacy_saved_connection, paired_state, question, PAIRING_CODE,
    };
    use super::*;
    use std::collections::VecDeque;
    use std::sync::Mutex as StdMutex;
    use std::time::Duration;

    const OWNER: i64 = 1001;
    const STRANGER: i64 = 2002;

    #[derive(Debug, Clone, PartialEq, Eq)]
    enum Sent {
        Text { chat_id: i64, text: String },
        Keyboard { chat_id: i64 },
        Artifact { chat_id: i64 },
    }

    impl Sent {
        fn chat_id(&self) -> i64 {
            match self {
                Self::Text { chat_id, .. }
                | Self::Keyboard { chat_id }
                | Self::Artifact { chat_id } => *chat_id,
            }
        }
    }

    /// Records every outbound call and replays scripted update batches.
    #[derive(Default)]
    struct FakeTelegram {
        sent: StdMutex<Vec<Sent>>,
        updates: StdMutex<VecDeque<Vec<TelegramIncomingMessage>>>,
    }

    impl FakeTelegram {
        fn record(&self, sent: Sent) {
            self.sent.lock().unwrap().push(sent);
        }

        fn sent_to(&self, chat_id: i64) -> Vec<Sent> {
            self.sent
                .lock()
                .unwrap()
                .iter()
                .filter(|sent| sent.chat_id() == chat_id)
                .cloned()
                .collect()
        }

        fn script(&self, batch: Vec<(i64, &str)>) {
            self.updates.lock().unwrap().push_back(
                batch
                    .into_iter()
                    .map(|(chat_id, text)| TelegramIncomingMessage {
                        chat_id,
                        text: text.to_string(),
                        images: Vec::new(),
                    })
                    .collect(),
            );
        }
    }

    #[async_trait::async_trait]
    impl TelegramPlatform for FakeTelegram {
        fn bot_token(&self) -> &str {
            "fixture-token"
        }

        async fn send_message(&self, chat_id: i64, text: &str) -> Result<()> {
            self.record(Sent::Text {
                chat_id,
                text: text.to_string(),
            });
            Ok(())
        }

        async fn send_message_with_keyboard(
            &self,
            chat_id: i64,
            _text: &str,
            _actions: &[BotAction],
        ) -> Result<()> {
            self.record(Sent::Keyboard { chat_id });
            Ok(())
        }

        async fn send_artifact(&self, chat_id: i64, _content: WorkspaceFileContent) -> Result<()> {
            self.record(Sent::Artifact { chat_id });
            Ok(())
        }

        async fn set_bot_commands(&self) -> Result<()> {
            Ok(())
        }

        async fn poll_updates(
            &self,
            last_update_id: i64,
        ) -> Result<(i64, Vec<TelegramIncomingMessage>)> {
            let next = self.updates.lock().unwrap().pop_front();
            match next {
                Some(batch) => Ok((last_update_id + 1, batch)),
                None => std::future::pending().await,
            }
        }
    }

    fn fake_bot() -> (Arc<FakeTelegram>, Arc<TelegramBot>) {
        let fake = Arc::new(FakeTelegram::default());
        let bot = Arc::new(TelegramBot::with_platform(
            fake.clone(),
            BotRuntimeFence::standalone(),
        ));
        (fake, bot)
    }

    /// A bot whose first pairing already completed with `OWNER`.
    async fn connected_bot() -> (Arc<FakeTelegram>, Arc<TelegramBot>) {
        let (fake, bot) = fake_bot();
        bot.restore_chat_state(OWNER, paired_state(&OWNER.to_string()))
            .await;
        (fake, bot)
    }

    fn saved_chat_id(bot: &TelegramBot) -> Option<String> {
        bot.runtime_fence
            .saved_connection("telegram")
            .map(|saved| saved.chat_id)
    }

    async fn pair_through_updates(bot: &TelegramBot) -> i64 {
        let (_stop_tx, mut stop_rx) = tokio::sync::watch::channel(false);
        tokio::time::timeout(Duration::from_secs(5), bot.wait_for_pairing(&mut stop_rx))
            .await
            .expect("pairing must finish with the scripted updates")
            .expect("pairing must succeed")
    }

    #[tokio::test]
    async fn unknown_chat_after_first_pairing_is_refused_and_cannot_run_a_command() {
        let (fake, bot) = connected_bot().await;

        bot.handle_incoming_message(STRANGER, "/help", vec![]).await;

        assert!(
            !bot.chat_states.read().await.contains_key(&STRANGER),
            "a chat that never paired must not gain state"
        );
        let replies = fake.sent_to(STRANGER);
        assert_eq!(replies.len(), 1, "one explanatory reply: {replies:?}");
        assert!(
            matches!(replies[0], Sent::Text { .. }),
            "an unpaired chat must not receive a command menu: {replies:?}"
        );
        assert_eq!(saved_chat_id(&bot), Some(OWNER.to_string()));

        bot.handle_incoming_message(OWNER, "/help", vec![]).await;
        assert!(
            fake.sent_to(OWNER)
                .iter()
                .any(|sent| matches!(sent, Sent::Keyboard { .. })),
            "the paired chat keeps its commands"
        );
    }

    #[tokio::test]
    async fn outbound_paths_never_create_state_or_reach_an_unpaired_chat() {
        let (fake, bot) = connected_bot().await;
        let epoch = bot.runtime_fence.identity_epoch();

        bot.deliver_interaction(STRANGER, question("tool-1"), epoch)
            .await;
        bot.notify_files_ready(
            STRANGER,
            "missing-session",
            None,
            "[report](computer://report.pdf)",
            epoch,
        )
        .await;

        assert!(!bot.chat_states.read().await.contains_key(&STRANGER));
        assert_eq!(fake.sent_to(STRANGER), Vec::<Sent>::new());
        assert_eq!(saved_chat_id(&bot), Some(OWNER.to_string()));

        // A chat that is known but never completed pairing is treated the same.
        bot.chat_states
            .write()
            .await
            .insert(STRANGER, BotChatState::new(STRANGER.to_string()));
        bot.deliver_interaction(STRANGER, question("tool-2"), epoch)
            .await;
        assert_eq!(fake.sent_to(STRANGER), Vec::<Sent>::new());
        let states = bot.chat_states.read().await;
        let stranger = states.get(&STRANGER).expect("state was inserted above");
        assert!(!stranger.paired);
        assert!(stranger.pending_action.is_none());
        drop(states);

        // The paired chat still receives its interaction.
        bot.deliver_interaction(OWNER, question("tool-3"), epoch)
            .await;
        assert_eq!(fake.sent_to(OWNER).len(), 1);
    }

    #[tokio::test]
    async fn wrong_codes_are_limited_per_chat_without_locking_the_owner_or_burning_the_code() {
        let (fake, bot) = fake_bot();
        bot.register_pairing(PAIRING_CODE).await.unwrap();
        let mut batch = vec![(STRANGER, "000000"); 5];
        // The right code no longer helps a chat that used up its attempts.
        batch.push((STRANGER, PAIRING_CODE));
        batch.push((OWNER, "111111"));
        batch.push((OWNER, PAIRING_CODE));
        fake.script(batch);

        assert_eq!(pair_through_updates(&bot).await, OWNER);

        let states = bot.chat_states.read().await;
        assert!(states.get(&OWNER).is_some_and(|state| state.paired));
        assert!(!states.contains_key(&STRANGER));
        drop(states);
        // Four "wrong code" replies, then one lockout notice, then silence.
        assert_eq!(fake.sent_to(STRANGER).len(), 5);
        assert_eq!(saved_chat_id(&bot), Some(OWNER.to_string()));
    }

    #[tokio::test]
    async fn repeated_messages_from_an_unpaired_chat_get_a_bounded_number_of_replies() {
        // While the first pairing is still pending.
        let (fake, bot) = fake_bot();
        bot.register_pairing(PAIRING_CODE).await.unwrap();
        let mut batch = vec![(STRANGER, "hello"); 20];
        batch.push((OWNER, PAIRING_CODE));
        fake.script(batch);
        assert_eq!(pair_through_updates(&bot).await, OWNER);
        let replies = fake.sent_to(STRANGER).len();
        assert!(
            (1..=3).contains(&replies),
            "replies while pairing: {replies}"
        );

        // After pairing, in the message loop.
        for index in 0..20 {
            bot.handle_incoming_message(STRANGER, &format!("hello again {index}"), vec![])
                .await;
        }
        let replies = fake.sent_to(STRANGER).len() - replies;
        assert!(
            (1..=3).contains(&replies),
            "replies when connected: {replies}"
        );
        assert!(!bot.chat_states.read().await.contains_key(&STRANGER));
    }

    #[tokio::test]
    async fn code_issued_for_a_connected_bot_moves_the_connection_to_the_chat_that_presents_it() {
        let (fake, bot) = connected_bot().await;
        bot.register_pairing(PAIRING_CODE).await.unwrap();

        bot.handle_incoming_message(STRANGER, "111111", vec![])
            .await;
        assert!(!bot.chat_states.read().await.contains_key(&STRANGER));
        assert_eq!(saved_chat_id(&bot), Some(OWNER.to_string()));

        bot.handle_incoming_message(STRANGER, PAIRING_CODE, vec![])
            .await;
        let states = bot.chat_states.read().await;
        assert!(states.get(&STRANGER).is_some_and(|state| state.paired));
        assert!(
            !states.contains_key(&OWNER),
            "one connection has one chat: the previous chat is no longer paired"
        );
        drop(states);
        assert_eq!(saved_chat_id(&bot), Some(STRANGER.to_string()));
        assert!(
            !bot.verify_pairing_code(PAIRING_CODE).await,
            "the pairing code is single use"
        );
        assert!(!fake.sent_to(STRANGER).is_empty());
    }

    #[tokio::test]
    async fn legacy_persisted_paired_chat_is_restored_without_pairing_again() {
        let saved = legacy_saved_connection(
            "telegram",
            &OWNER.to_string(),
            serde_json::json!({ "bot_type": "telegram", "bot_token": "fixture-token" }),
        );
        let (fake, bot) = fake_bot();

        bot.restore_chat_state(OWNER, saved.chat_state.clone())
            .await;
        bot.handle_incoming_message(OWNER, "/help", vec![]).await;

        assert_eq!(
            fake.sent_to(OWNER)
                .iter()
                .filter(|sent| matches!(sent, Sent::Keyboard { .. }))
                .count(),
            1,
            "the restored chat reaches the command router without a pairing prompt"
        );
        let resaved = bot
            .runtime_fence
            .saved_connection("telegram")
            .expect("restored connection is saved");
        assert_eq!(resaved.chat_id, OWNER.to_string());
        assert!(resaved.chat_state.paired);
        // The stored shape is unchanged: an older build reads it back.
        let stored = serde_json::to_value(&resaved.chat_state).unwrap();
        let legacy = serde_json::to_value(&saved.chat_state).unwrap();
        assert_eq!(stored, legacy);
        assert_eq!(stored["paired"], serde_json::json!(true));
    }

    #[tokio::test]
    async fn retired_or_reidentified_bot_neither_answers_nor_delivers() {
        let (fake, bot) = connected_bot().await;
        let epoch = bot.runtime_fence.identity_epoch();

        // An account change invalidates deliveries that started before it.
        bot.runtime_fence
            .account_identity_epoch
            .fetch_add(1, std::sync::atomic::Ordering::AcqRel);
        bot.deliver_interaction(OWNER, question("tool-1"), epoch)
            .await;
        bot.notify_files_ready(
            OWNER,
            "missing-session",
            None,
            "[report](computer://report.pdf)",
            epoch,
        )
        .await;
        assert_eq!(fake.sent_to(OWNER), Vec::<Sent>::new());

        // A replaced instance stays silent for paired and unpaired chats alike.
        bot.runtime_fence.slot.advance();
        bot.handle_incoming_message(OWNER, "/help", vec![]).await;
        bot.handle_incoming_message(STRANGER, "/help", vec![]).await;
        bot.deliver_interaction(
            OWNER,
            question("tool-2"),
            bot.runtime_fence.identity_epoch(),
        )
        .await;
        assert_eq!(fake.sent.lock().unwrap().len(), 0);
        assert!(!bot.chat_states.read().await.contains_key(&STRANGER));
        assert_eq!(saved_chat_id(&bot), Some(OWNER.to_string()));
    }

    #[tokio::test]
    async fn account_clear_is_bounded_by_epoch_when_a_command_holds_state_lock() {
        let bot = TelegramBot::new(TelegramConfig {
            bot_token: "test-token".to_string(),
        });
        let _in_flight_command = bot.chat_states.write().await;

        tokio::time::timeout(
            std::time::Duration::from_millis(500),
            bot.clear_delegated_identities(),
        )
        .await
        .expect("account replacement must not wait indefinitely for bot network work");
    }
}
