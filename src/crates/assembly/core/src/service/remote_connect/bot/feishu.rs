//! Feishu (Lark) bot integration for Remote Connect.
//!
//! Users create their own Feishu bot on the Feishu Open Platform and provide
//! App ID + App Secret. The desktop receives messages via Feishu's WebSocket
//! long connection and routes them through the shared command router.

use anyhow::{anyhow, Result};
use log::{error, info, warn};
use openbitfun_services_integrations::remote_connect::bot::feishu::{
    self as feishu_provider, FeishuBotApi,
};
pub use openbitfun_services_integrations::remote_connect::bot::feishu::{
    FeishuConfig, MAX_FEISHU_FILE_BYTES,
};
use std::collections::HashMap;
use std::sync::Arc;
use tokio::sync::RwLock;

use super::command_router::{
    complete_im_bot_pairing, current_bot_language, execute_forwarded_turn, handle_command,
    parse_command, BotAction, BotChatState, BotInteractionHandler, BotInteractiveRequest,
    BotLanguage, BotMessageSender, HandleResult,
};
use super::pairing_gate::{PairingGate, UnpairedDecision};
use super::{
    load_bot_persistence, BotConfig, BotRuntimeFence, SavedBotConnection, WorkspaceFileContent,
};
use crate::service::remote_connect::remote_server::ImageAttachment;

/// Feishu Open Platform calls this adapter makes. The provider client is the
/// production implementation; unit tests substitute a recording fake.
#[async_trait::async_trait]
pub(crate) trait FeishuPlatform: Send + Sync {
    fn config(&self) -> &FeishuConfig;
    async fn send_message(&self, chat_id: &str, content: &str) -> Result<()>;
    async fn send_action_card(
        &self,
        chat_id: &str,
        language: BotLanguage,
        content: &str,
        actions: &[BotAction],
    ) -> Result<()>;
    async fn download_image_resource(
        &self,
        message_id: &str,
        file_key: &str,
    ) -> Result<feishu_provider::FeishuDownloadedImage>;
    async fn send_artifact_to_chat(
        &self,
        chat_id: &str,
        content: WorkspaceFileContent,
    ) -> Result<()>;
    async fn get_ws_endpoint(&self) -> Result<feishu_provider::FeishuWsEndpoint>;
    async fn connect_ws(&self, url: &str) -> Result<feishu_provider::FeishuWsConnection>;
}

#[async_trait::async_trait]
impl FeishuPlatform for FeishuBotApi {
    fn config(&self) -> &FeishuConfig {
        FeishuBotApi::config(self)
    }

    async fn send_message(&self, chat_id: &str, content: &str) -> Result<()> {
        FeishuBotApi::send_message(self, chat_id, content).await
    }

    async fn send_action_card(
        &self,
        chat_id: &str,
        language: BotLanguage,
        content: &str,
        actions: &[BotAction],
    ) -> Result<()> {
        FeishuBotApi::send_action_card(self, chat_id, language, content, actions).await
    }

    async fn download_image_resource(
        &self,
        message_id: &str,
        file_key: &str,
    ) -> Result<feishu_provider::FeishuDownloadedImage> {
        FeishuBotApi::download_image_resource(self, message_id, file_key).await
    }

    async fn send_artifact_to_chat(
        &self,
        chat_id: &str,
        content: WorkspaceFileContent,
    ) -> Result<()> {
        FeishuBotApi::send_artifact_to_chat(self, chat_id, content).await
    }

    async fn get_ws_endpoint(&self) -> Result<feishu_provider::FeishuWsEndpoint> {
        FeishuBotApi::get_ws_endpoint(self).await
    }

    async fn connect_ws(&self, url: &str) -> Result<feishu_provider::FeishuWsConnection> {
        FeishuBotApi::connect_ws(self, url).await
    }
}

pub struct FeishuBot {
    api: Arc<dyn FeishuPlatform>,
    pairing_gate: PairingGate,
    chat_states: Arc<RwLock<HashMap<String, BotChatState>>>,
    runtime_fence: BotRuntimeFence,
    /// Events already dispatched, so a redelivery does not run twice.
    event_deduper: feishu_provider::FeishuEventDeduper,
    /// Final replies that could not be delivered, resent with the chat's next
    /// message.
    held_replies: super::HeldReplies<String>,
}

/// Bound on one ping write. A half-open socket can accept writes for a while,
/// so the read-idle check below is what detects it; this only keeps a stuck
/// write from blocking the loop.
const FEISHU_PING_SEND_TIMEOUT: std::time::Duration = std::time::Duration::from_secs(10);

/// A socket that has produced nothing for this many ping intervals is treated
/// as half-open and replaced.
const FEISHU_IDLE_PING_INTERVALS: u32 = 2;

/// What a ping tick found about the connection.
fn feishu_connection_stale(
    idle_for: std::time::Duration,
    ping_interval: std::time::Duration,
) -> bool {
    idle_for > ping_interval.saturating_mul(FEISHU_IDLE_PING_INTERVALS)
}

/// Send one ping; an error means the connection must be replaced.
async fn feishu_ping(
    connection: &feishu_provider::FeishuWsConnection,
    service_id: i32,
    ping_interval: std::time::Duration,
) -> Result<()> {
    if feishu_connection_stale(connection.idle_for(), ping_interval) {
        return Err(anyhow!(
            "no frame received for {}s",
            connection.idle_for().as_secs()
        ));
    }
    match tokio::time::timeout(FEISHU_PING_SEND_TIMEOUT, connection.send_ping(service_id)).await {
        Ok(result) => result,
        Err(_) => Err(anyhow!("ping write timed out")),
    }
}

impl FeishuBot {
    fn unsupported_message_type_message(language: BotLanguage) -> &'static str {
        if language.is_chinese() {
            "\u{6682}\u{4e0d}\u{652f}\u{6301}\u{8fd9}\u{79cd}\u{6d88}\u{606f}\u{7c7b}\u{578b}\u{ff0c}\u{8bf7}\u{53d1}\u{9001}\u{6587}\u{672c}\u{6216}\u{56fe}\u{7247}\u{3002}"
        } else {
            "This message type is not supported. Please send text or images."
        }
    }

    fn image_truncated_message(
        language: BotLanguage,
        max_images: usize,
        discarded: usize,
    ) -> String {
        if language.is_chinese() {
            format!(
                "\u{4ec5}\u{4f1a}\u{5904}\u{7406}\u{524d} {max_images} \u{5f20}\u{56fe}\u{7247}\u{ff0c}\u{5176}\u{4f59} {discarded} \u{5f20}\u{5df2}\u{4e22}\u{5f03}\u{3002}"
            )
        } else {
            format!(
                "Only the first {max_images} images will be processed; the remaining {discarded} were discarded."
            )
        }
    }

    fn image_placeholder_message(language: BotLanguage) -> String {
        if language.is_chinese() {
            "[\u{7528}\u{6237}\u{53d1}\u{9001}\u{4e86}\u{4e00}\u{5f20}\u{56fe}\u{7247}]".to_string()
        } else {
            "[User sent an image]".to_string()
        }
    }

    #[cfg(test)]
    pub fn new(config: FeishuConfig) -> Self {
        Self::new_fenced(config, BotRuntimeFence::standalone())
    }

    pub(crate) fn new_fenced(config: FeishuConfig, runtime_fence: BotRuntimeFence) -> Self {
        Self::with_platform(Arc::new(FeishuBotApi::new(config)), runtime_fence)
    }

    fn with_platform(api: Arc<dyn FeishuPlatform>, runtime_fence: BotRuntimeFence) -> Self {
        Self {
            api,
            pairing_gate: PairingGate::new(),
            chat_states: Arc::new(RwLock::new(HashMap::new())),
            runtime_fence,
            event_deduper: Default::default(),
            held_replies: Default::default(),
        }
    }

    /// False when `event` was already dispatched (a redelivery). Events
    /// without an id are always dispatched.
    fn first_delivery(&self, event: &serde_json::Value) -> bool {
        let Some(key) = feishu_provider::event_dedup_key(event) else {
            return true;
        };
        let first = self.event_deduper.first_delivery(&key);
        if !first {
            info!("Feishu event redelivered; skipping duplicate {key}");
        }
        first
    }

    async fn deliver_final_reply(&self, chat_id: &str, text: &str) {
        let chat = chat_id.to_string();
        super::deliver_final_reply(&self.held_replies, &chat, text, |text| async move {
            if !super::chat_is_paired(&self.chat_states, chat_id).await {
                return Ok(());
            }
            self.api.send_message(chat_id, &text).await
        })
        .await;
    }

    async fn resend_held_replies(&self, chat_id: &str) {
        let chat = chat_id.to_string();
        super::resend_held_replies(&self.held_replies, &chat, |text| async move {
            self.api.send_message(chat_id, &text).await
        })
        .await;
    }

    pub async fn restore_chat_state(&self, chat_id: &str, mut state: BotChatState) {
        state.prepare_for_restore();
        let mut states = self.chat_states.write().await;
        self.runtime_fence.reconcile_states(&mut states);
        states.insert(chat_id.to_string(), state);
        let restored = states
            .get(chat_id)
            .cloned()
            .expect("restored Feishu state should exist");
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
                // Held replies belong to the previous account's sessions.
                self.held_replies.clear();
                let snapshots: Vec<_> = states
                    .iter()
                    .map(|(chat_id, state)| (chat_id.clone(), state.clone()))
                    .collect();
                drop(states);
                for (chat_id, state) in snapshots {
                    self.persist_chat_state(&chat_id, &state).await;
                }
            }
            Err(_) => {
                warn!("Feishu account identity clear deferred behind an in-flight command");
            }
        }
    }

    pub async fn send_message(&self, chat_id: &str, content: &str) -> Result<()> {
        self.api.send_message(chat_id, content).await
    }

    async fn download_image_as_data_url(&self, message_id: &str, file_key: &str) -> Result<String> {
        use base64::{engine::general_purpose::STANDARD as B64, Engine};

        let downloaded = self
            .api
            .download_image_resource(message_id, file_key)
            .await?;
        let content_type = downloaded.content_type;
        let raw_bytes = downloaded.bytes;

        const MAX_BYTES: usize = 1024 * 1024;
        if raw_bytes.len() <= MAX_BYTES {
            let b64 = B64.encode(&raw_bytes);
            return Ok(format!("data:{};base64,{}", content_type, b64));
        }

        log::info!(
            "Feishu image exceeds {}KB ({}KB), compressing",
            MAX_BYTES / 1024,
            raw_bytes.len() / 1024
        );
        match crate::agentic::image_analysis::optimize_image_with_size_limit(
            raw_bytes.clone(),
            "openai",
            Some(&content_type),
            Some(MAX_BYTES),
        ) {
            Ok(processed) => {
                let b64 = B64.encode(&processed.data);
                Ok(format!("data:{};base64,{}", processed.mime_type, b64))
            }
            Err(e) => {
                log::warn!("Feishu image compression failed, using original: {e}");
                let b64 = B64.encode(&raw_bytes);
                Ok(format!("data:{};base64,{}", content_type, b64))
            }
        }
    }

    async fn download_images(
        &self,
        message_id: &str,
        image_keys: &[String],
    ) -> Vec<ImageAttachment> {
        let mut attachments = Vec::new();
        for (i, key) in image_keys.iter().enumerate() {
            match self.download_image_as_data_url(message_id, key).await {
                Ok(data_url) => {
                    attachments.push(ImageAttachment {
                        name: format!("image_{}.png", i + 1),
                        data_url,
                    });
                }
                Err(e) => {
                    warn!("Failed to download Feishu image {key}: {e}");
                }
            }
        }
        attachments
    }

    pub async fn send_action_card(
        &self,
        chat_id: &str,
        language: BotLanguage,
        content: &str,
        actions: &[BotAction],
    ) -> Result<()> {
        self.api
            .send_action_card(chat_id, language, content, actions)
            .await
    }

    async fn send_handle_result(&self, chat_id: &str, result: &HandleResult) -> Result<()> {
        if !self.runtime_fence.is_lifecycle_current()
            || !super::chat_is_paired(&self.chat_states, chat_id).await
        {
            return Ok(());
        }
        let language = current_bot_language().await;
        let text = if result.menu.items.is_empty() && result.menu.title.is_empty() {
            result.reply.clone()
        } else {
            result.menu.render_text_block()
        };
        if text.trim().is_empty() {
            return Ok(());
        }
        if result.actions.is_empty() {
            self.send_message(chat_id, &text).await
        } else {
            self.send_action_card(chat_id, language, &text, &result.actions)
                .await
        }
    }

    async fn notify_files_ready(
        &self,
        chat_id: &str,
        session_id: &str,
        remote_target: Option<&super::command_router::RemoteBotTarget>,
        text: &str,
        identity_epoch: u64,
    ) {
        let language = current_bot_language().await;
        for reference in super::extract_output_file_references(text) {
            if !self.runtime_fence.is_lifecycle_current()
                || self.runtime_fence.identity_epoch() != identity_epoch
                || !super::chat_is_paired(&self.chat_states, chat_id).await
            {
                return;
            }
            let content = super::read_output_file(
                session_id,
                remote_target,
                &reference,
                MAX_FEISHU_FILE_BYTES,
                &|| {
                    self.runtime_fence.is_lifecycle_current()
                        && self.runtime_fence.identity_epoch() == identity_epoch
                },
            )
            .await;
            if !self.runtime_fence.is_lifecycle_current()
                || self.runtime_fence.identity_epoch() != identity_epoch
                || !super::chat_is_paired(&self.chat_states, chat_id).await
            {
                return;
            }
            let result = match content {
                Ok(content) => self
                    .api
                    .send_artifact_to_chat(chat_id, content)
                    .await
                    .map_err(|error| error.to_string()),
                Err(error) => Err(error),
            };
            if let Err(error) = result {
                warn!("Feishu output file delivery failed: {error}");
                let notice = super::auto_push_failed_message(language, &reference, &error);
                if self.runtime_fence.is_lifecycle_current()
                    && self.runtime_fence.identity_epoch() == identity_epoch
                {
                    let _ = self.send_message(chat_id, &notice).await;
                }
            }
        }
    }

    /// Only a valid code can replace the chat that owns this connection.
    /// Keep admission serialized with commands, and never create state for a refusal.
    async fn handle_pairing_message(&self, chat_id: &str, text: &str) -> bool {
        let epoch = self.runtime_fence.identity_epoch();
        let mut states = self.chat_states.write().await;
        if !self.runtime_fence.is_lifecycle_current() {
            return false;
        }
        self.runtime_fence.reconcile_states(&mut states);
        if states.get(chat_id).is_some_and(|state| state.paired) {
            return true;
        }
        let connected_elsewhere = states.values().any(|state| state.paired);
        match self
            .pairing_gate
            .evaluate(chat_id, text, connected_elsewhere)
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
                states.insert(chat_id.to_string(), state.clone());
                self.persist_chat_state(chat_id, &state).await;
                drop(states);
                self.send_handle_result(chat_id, &result).await.ok();
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

    async fn handle_pairing_event_payload(&self, payload: &[u8]) -> Option<String> {
        if !self.runtime_fence.is_lifecycle_current() {
            return None;
        }
        let event: serde_json::Value = serde_json::from_slice(payload).ok()?;
        if !self.first_delivery(&event) {
            return None;
        }
        let (chat_id, text) =
            if let Some(parsed) = feishu_provider::parse_message_event_full(&event) {
                (parsed.chat_id, parsed.text)
            } else {
                (
                    feishu_provider::extract_message_chat_id(&event)?,
                    String::new(),
                )
            };
        self.handle_pairing_message(&chat_id, &text)
            .await
            .then_some(chat_id)
    }

    pub async fn wait_for_pairing(
        &self,
        stop_rx: &mut tokio::sync::watch::Receiver<bool>,
    ) -> Result<String> {
        info!("Feishu bot waiting for pairing code via WebSocket...");

        if *stop_rx.borrow() {
            return Err(anyhow!("bot stop requested"));
        }

        let endpoint = self.api.get_ws_endpoint().await?;
        let mut connection = self.api.connect_ws(&endpoint.url).await?;
        info!("Feishu WebSocket connected (binary proto), waiting for pairing...");

        let service_id = feishu_provider::extract_service_id_from_url(&endpoint.url);
        let ping_interval = endpoint
            .client_config
            .get("PingInterval")
            .and_then(|v| v.as_u64())
            .unwrap_or(120);

        let mut ping_timer = tokio::time::interval(std::time::Duration::from_secs(ping_interval));
        let ping_interval = std::time::Duration::from_secs(ping_interval);

        loop {
            tokio::select! {
                _ = stop_rx.changed() => {
                    info!("Feishu wait_for_pairing stopped by signal");
                    return Err(anyhow!("bot stop requested"));
                }
                msg = connection.next_event() => {
                    match msg {
                        Ok(Some(event)) => {
                            let acked = connection.ack_event(&event).await;
                            if let Some(chat_id) = self.handle_pairing_event_payload(event.payload()).await {
                                return Ok(chat_id);
                            }
                            if let Err(e) = acked {
                                warn!("Feishu event ack failed during pairing; reconnecting: {e}");
                                return Err(e);
                            }
                        }
                        Ok(None) => {
                            return Err(anyhow!("feishu ws connection closed during pairing"));
                        }
                        Err(e) => {
                            error!("Feishu WebSocket error during pairing: {e}");
                            return Err(e);
                        }
                    }
                }
                _ = ping_timer.tick() => {
                    if let Err(e) = feishu_ping(&connection, service_id, ping_interval).await {
                        warn!("Feishu WebSocket unhealthy during pairing; reconnecting: {e}");
                        return Err(e);
                    }
                }
            }
        }
    }

    pub async fn run_message_loop(self: Arc<Self>, stop_rx: tokio::sync::watch::Receiver<bool>) {
        info!("Feishu bot message loop started");
        let mut stop = stop_rx;

        loop {
            if *stop.borrow() {
                info!("Feishu bot message loop stopped by signal");
                break;
            }

            let endpoint = match self.api.get_ws_endpoint().await {
                Ok(v) => v,
                Err(e) => {
                    error!("Failed to get Feishu WS endpoint: {e}");
                    tokio::time::sleep(std::time::Duration::from_secs(10)).await;
                    continue;
                }
            };

            let ping_interval = endpoint
                .client_config
                .get("PingInterval")
                .and_then(|v| v.as_u64())
                .unwrap_or(120);
            let service_id = feishu_provider::extract_service_id_from_url(&endpoint.url);

            let mut connection = match self.api.connect_ws(&endpoint.url).await {
                Ok(v) => v,
                Err(e) => {
                    error!("Feishu WS connect failed: {e}");
                    tokio::time::sleep(std::time::Duration::from_secs(10)).await;
                    continue;
                }
            };
            info!("Feishu WebSocket connected for message loop (binary proto)");

            let mut ping_timer =
                tokio::time::interval(std::time::Duration::from_secs(ping_interval));
            let ping_period = std::time::Duration::from_secs(ping_interval);

            loop {
                tokio::select! {
                    _ = stop.changed() => {
                        info!("Feishu bot message loop stopped by signal");
                        return;
                    }
                    msg = connection.next_event() => {
                        match msg {
                            Ok(Some(event)) => {
                                let acked = connection.ack_event(&event).await;
                                // Dispatch even when the ack failed: Feishu
                                // redelivers it and the dedup set drops the copy.
                                self.handle_event_payload(event.payload()).await;
                                if let Err(e) = acked {
                                    warn!("Feishu event ack failed; reconnecting: {e}");
                                    break;
                                }
                            }
                            Ok(None) => {
                                warn!("Feishu WS closed, reconnecting...");
                                break;
                            }
                            Err(e) => {
                                error!("Feishu WS error: {e}");
                                break;
                            }
                        }
                    }
                    _ = ping_timer.tick() => {
                        if let Err(e) = feishu_ping(&connection, service_id, ping_period).await {
                            warn!("Feishu WebSocket unhealthy; reconnecting: {e}");
                            break;
                        }
                    }
                }
            }

            let reconnect_interval = endpoint
                .client_config
                .get("ReconnectInterval")
                .and_then(|v| v.as_u64())
                .unwrap_or(3);
            tokio::time::sleep(std::time::Duration::from_secs(reconnect_interval)).await;
        }
    }

    async fn handle_event_payload(self: &Arc<Self>, payload: &[u8]) {
        let Ok(event) = serde_json::from_slice::<serde_json::Value>(payload) else {
            return;
        };
        if !self.first_delivery(&event) {
            return;
        }
        let bot = self.clone();
        tokio::spawn(async move {
            bot.dispatch_event(event).await;
        });
    }

    async fn dispatch_event(self: &Arc<Self>, event: serde_json::Value) {
        if !self.runtime_fence.is_lifecycle_current() {
            return;
        }
        if let Some(parsed) = feishu_provider::parse_message_event_full(&event) {
            if !super::chat_is_paired(&self.chat_states, parsed.chat_id.as_str()).await {
                self.handle_pairing_message(&parsed.chat_id, &parsed.text)
                    .await;
                return;
            }
            const MAX_IMAGES: usize = 5;
            let language = current_bot_language().await;
            let truncated = parsed.image_keys.len() > MAX_IMAGES;
            let keys_to_use = if truncated {
                &parsed.image_keys[..MAX_IMAGES]
            } else {
                &parsed.image_keys
            };
            let images = if keys_to_use.is_empty() {
                vec![]
            } else {
                self.download_images(&parsed.message_id, keys_to_use).await
            };
            if truncated {
                let discarded = parsed.image_keys.len() - MAX_IMAGES;
                let msg = Self::image_truncated_message(language, MAX_IMAGES, discarded);
                self.send_message(&parsed.chat_id, &msg).await.ok();
            }
            let text = if parsed.text.is_empty() && !images.is_empty() {
                Self::image_placeholder_message(language)
            } else {
                parsed.text
            };
            self.handle_incoming_message(&parsed.chat_id, &text, images)
                .await;
        } else if let Some((chat_id, cmd)) = feishu_provider::parse_card_action_event(&event) {
            self.handle_incoming_message(&chat_id, &cmd, vec![]).await;
        } else if let Some(chat_id) = feishu_provider::extract_message_chat_id(&event) {
            if !super::chat_is_paired(&self.chat_states, chat_id.as_str()).await {
                self.handle_pairing_message(&chat_id, "").await;
                return;
            }
            let language = current_bot_language().await;
            self.send_message(&chat_id, Self::unsupported_message_type_message(language))
                .await
                .ok();
        }
    }
    async fn handle_incoming_message(
        self: &Arc<Self>,
        chat_id: &str,
        text: &str,
        images: Vec<ImageAttachment>,
    ) {
        if !self.runtime_fence.is_lifecycle_current() {
            return;
        }
        if super::chat_is_paired(&self.chat_states, chat_id).await
            && !self.held_replies.is_empty(&chat_id.to_string())
        {
            // Resend in the background: a held reply under provider backoff
            // must not delay handling this message.
            let bot = self.clone();
            let chat = chat_id.to_string();
            let epoch = self.runtime_fence.identity_epoch();
            tokio::spawn(async move {
                if bot.runtime_fence.is_lifecycle_current()
                    && bot.runtime_fence.identity_epoch() == epoch
                {
                    bot.resend_held_replies(&chat).await;
                }
            });
        }
        let mut states = self.chat_states.write().await;
        let command_identity_epoch = self.runtime_fence.identity_epoch();
        self.runtime_fence.reconcile_states(&mut states);
        if !states.get(chat_id).is_some_and(|state| state.paired) {
            drop(states);
            self.handle_pairing_message(chat_id, text).await;
            return;
        }
        let state = states.get_mut(chat_id).expect("paired chat exists");

        if self.runtime_fence.identity_epoch() != command_identity_epoch {
            return;
        }
        let cmd = parse_command(text);
        let result = handle_command(state, cmd, images).await;

        self.runtime_fence.reconcile_states(&mut states);
        if let Some(state) = states.get(chat_id) {
            self.persist_chat_state(chat_id, state).await;
        }
        drop(states);

        if !self.runtime_fence.is_lifecycle_current()
            || self.runtime_fence.identity_epoch() != command_identity_epoch
        {
            return;
        }

        self.send_handle_result(chat_id, &result).await.ok();

        if let Some(forward) = result.forward_to_session {
            let output_session_id = forward.session_id.clone();
            let output_remote_target = forward.remote_target.clone();
            let output_identity_epoch = command_identity_epoch;
            let bot = self.clone();
            let cid = chat_id.to_string();
            tokio::spawn(async move {
                let interaction_bot = bot.clone();
                let interaction_chat_id = cid.clone();
                let handler: BotInteractionHandler =
                    std::sync::Arc::new(move |interaction: BotInteractiveRequest| {
                        let interaction_bot = interaction_bot.clone();
                        let interaction_chat_id = interaction_chat_id.clone();
                        Box::pin(async move {
                            interaction_bot
                                .deliver_interaction(
                                    &interaction_chat_id,
                                    interaction,
                                    output_identity_epoch,
                                )
                                .await;
                        })
                    });
                let msg_bot = bot.clone();
                let msg_cid = cid.clone();
                let sender: BotMessageSender = std::sync::Arc::new(move |text: String| {
                    let msg_bot = msg_bot.clone();
                    let msg_cid = msg_cid.clone();
                    Box::pin(async move {
                        if !msg_bot.runtime_fence.is_lifecycle_current()
                            || msg_bot.runtime_fence.identity_epoch() != output_identity_epoch
                            || !super::chat_is_paired(&msg_bot.chat_states, msg_cid.as_str()).await
                        {
                            return;
                        }
                        if let Err(err) = msg_bot.send_message(&msg_cid, &text).await {
                            warn!("Failed to send Feishu intermediate message to {msg_cid}: {err}");
                        }
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
                    || !super::chat_is_paired(&bot.chat_states, cid.as_str()).await
                {
                    return;
                }
                if let Some(next) = super::retire_remote_interactions(
                    &bot.chat_states,
                    &cid,
                    output_remote_target.as_ref(),
                    &result.completed_remote_tools,
                    &bot.runtime_fence,
                    output_identity_epoch,
                )
                .await
                {
                    bot.deliver_interaction(&cid, next, output_identity_epoch)
                        .await;
                }
                if !result.display_text.is_empty() {
                    bot.deliver_final_reply(&cid, &result.display_text).await;
                }
                bot.notify_files_ready(
                    &cid,
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
        chat_id: &str,
        interaction: BotInteractiveRequest,
        identity_epoch: u64,
    ) {
        if !self.runtime_fence.is_lifecycle_current() {
            return;
        }
        let mut states = self.chat_states.write().await;
        self.runtime_fence.reconcile_states(&mut states);
        let Some(state) = states.get_mut(chat_id).filter(|state| state.paired) else {
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
            reply: interaction.reply.clone(),
            actions: interaction.actions.clone(),
            forward_to_session: None,
            menu: interaction.menu.clone(),
        };
        if let Err(error) = self.send_handle_result(chat_id, &result).await {
            warn!("Feishu interaction prompt to {chat_id} failed: {error}");
            // Re-sent by the turn watcher's next re-presentation.
            if let Some(state) = self.chat_states.write().await.get_mut(chat_id) {
                super::command_router::mark_interaction_undelivered(state, &interaction);
            }
        }
    }

    async fn persist_chat_state(&self, chat_id: &str, state: &BotChatState) {
        let snapshot = self.runtime_fence.persistence_snapshot(state);
        let connection = SavedBotConnection {
            account_user_id: self.runtime_fence.account_user_id(),
            bot_type: "feishu".to_string(),
            chat_id: chat_id.to_string(),
            config: BotConfig::Feishu {
                app_id: self.api.config().app_id.clone(),
                app_secret: self.api.config().app_secret.clone(),
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
    use std::sync::atomic::{AtomicUsize, Ordering};
    use std::sync::Mutex as StdMutex;

    const OWNER: &str = "oc_owner";
    const STRANGER: &str = "oc_stranger";

    #[derive(Debug, Clone, PartialEq, Eq)]
    enum Sent {
        Text { chat_id: String, text: String },
        Card { chat_id: String },
        Artifact { chat_id: String },
    }

    impl Sent {
        fn chat_id(&self) -> &str {
            match self {
                Self::Text { chat_id, .. }
                | Self::Card { chat_id }
                | Self::Artifact { chat_id } => chat_id,
            }
        }
    }

    /// Records every outbound call; the event socket is driven by the tests.
    struct FakeFeishu {
        config: FeishuConfig,
        sent: StdMutex<Vec<Sent>>,
        image_downloads: AtomicUsize,
    }

    impl FakeFeishu {
        fn record(&self, sent: Sent) {
            self.sent.lock().unwrap().push(sent);
        }

        fn sent_to(&self, chat_id: &str) -> Vec<Sent> {
            self.sent
                .lock()
                .unwrap()
                .iter()
                .filter(|sent| sent.chat_id() == chat_id)
                .cloned()
                .collect()
        }
    }

    #[async_trait::async_trait]
    impl FeishuPlatform for FakeFeishu {
        fn config(&self) -> &FeishuConfig {
            &self.config
        }

        async fn send_message(&self, chat_id: &str, content: &str) -> Result<()> {
            self.record(Sent::Text {
                chat_id: chat_id.to_string(),
                text: content.to_string(),
            });
            Ok(())
        }

        async fn send_action_card(
            &self,
            chat_id: &str,
            _language: BotLanguage,
            _content: &str,
            _actions: &[BotAction],
        ) -> Result<()> {
            self.record(Sent::Card {
                chat_id: chat_id.to_string(),
            });
            Ok(())
        }

        async fn download_image_resource(
            &self,
            _message_id: &str,
            _file_key: &str,
        ) -> Result<feishu_provider::FeishuDownloadedImage> {
            self.image_downloads.fetch_add(1, Ordering::SeqCst);
            Ok(feishu_provider::FeishuDownloadedImage {
                content_type: "image/png".to_string(),
                bytes: vec![1, 2, 3],
            })
        }

        async fn send_artifact_to_chat(
            &self,
            chat_id: &str,
            _content: WorkspaceFileContent,
        ) -> Result<()> {
            self.record(Sent::Artifact {
                chat_id: chat_id.to_string(),
            });
            Ok(())
        }

        async fn get_ws_endpoint(&self) -> Result<feishu_provider::FeishuWsEndpoint> {
            Err(anyhow!("the fake has no event socket"))
        }

        async fn connect_ws(&self, _url: &str) -> Result<feishu_provider::FeishuWsConnection> {
            Err(anyhow!("the fake has no event socket"))
        }
    }

    fn fake_bot() -> (Arc<FakeFeishu>, Arc<FeishuBot>) {
        let fake = Arc::new(FakeFeishu {
            config: FeishuConfig {
                app_id: "fixture-app".to_string(),
                app_secret: "fixture-secret".to_string(),
            },
            sent: StdMutex::default(),
            image_downloads: AtomicUsize::new(0),
        });
        let bot = Arc::new(FeishuBot::with_platform(
            fake.clone(),
            BotRuntimeFence::standalone(),
        ));
        (fake, bot)
    }

    /// A bot whose first pairing already completed with `OWNER`.
    async fn connected_bot() -> (Arc<FakeFeishu>, Arc<FeishuBot>) {
        let (fake, bot) = fake_bot();
        bot.restore_chat_state(OWNER, paired_state(OWNER)).await;
        (fake, bot)
    }

    fn saved_chat_id(bot: &FeishuBot) -> Option<String> {
        bot.runtime_fence
            .saved_connection("feishu")
            .map(|saved| saved.chat_id)
    }

    fn message_event(chat_id: &str, message_type: &str, content: serde_json::Value) -> Vec<u8> {
        serde_json::to_vec(&serde_json::json!({
            "header": { "event_type": "im.message.receive_v1" },
            "event": {
                "message": {
                    "message_id": format!("om_{}", uuid::Uuid::new_v4()),
                    "message_type": message_type,
                    "chat_id": chat_id,
                    "content": content.to_string()
                }
            }
        }))
        .unwrap()
    }

    fn text_event(chat_id: &str, text: &str) -> Vec<u8> {
        message_event(chat_id, "text", serde_json::json!({ "text": text }))
    }

    fn image_event(chat_id: &str) -> Vec<u8> {
        message_event(
            chat_id,
            "image",
            serde_json::json!({ "image_key": "img_fixture" }),
        )
    }

    fn file_event(chat_id: &str) -> Vec<u8> {
        message_event(
            chat_id,
            "file",
            serde_json::json!({ "file_key": "file_fixture" }),
        )
    }

    async fn dispatch(bot: &Arc<FeishuBot>, payload: Vec<u8>) {
        bot.dispatch_event(serde_json::from_slice(&payload).unwrap())
            .await;
    }

    #[tokio::test]
    async fn redelivered_pairing_event_is_dispatched_once() {
        let (fake, bot) = fake_bot();
        bot.register_pairing(PAIRING_CODE).await.unwrap();
        let payload = text_event(OWNER, PAIRING_CODE);

        assert_eq!(
            bot.handle_pairing_event_payload(&payload).await.as_deref(),
            Some(OWNER)
        );
        let after_first = fake.sent_to(OWNER).len();
        assert!(bot.handle_pairing_event_payload(&payload).await.is_none());
        assert_eq!(fake.sent_to(OWNER).len(), after_first);

        // A distinct event from the same chat is still dispatched.
        let other = text_event(OWNER, PAIRING_CODE);
        assert_eq!(
            bot.handle_pairing_event_payload(&other).await.as_deref(),
            Some(OWNER)
        );
    }

    #[tokio::test]
    async fn unknown_chat_after_first_pairing_is_refused_and_cannot_run_a_command() {
        let (fake, bot) = connected_bot().await;

        dispatch(&bot, text_event(STRANGER, "/help")).await;

        assert!(
            !bot.chat_states.read().await.contains_key(STRANGER),
            "a chat that never paired must not gain state"
        );
        let replies = fake.sent_to(STRANGER);
        assert_eq!(replies.len(), 1, "one explanatory reply: {replies:?}");
        assert!(
            matches!(replies[0], Sent::Text { .. }),
            "an unpaired chat must not receive a command menu: {replies:?}"
        );
        assert_eq!(saved_chat_id(&bot).as_deref(), Some(OWNER));

        dispatch(&bot, text_event(OWNER, "/help")).await;
        assert!(
            fake.sent_to(OWNER)
                .iter()
                .any(|sent| matches!(sent, Sent::Card { .. })),
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

        assert!(!bot.chat_states.read().await.contains_key(STRANGER));
        assert_eq!(fake.sent_to(STRANGER), Vec::<Sent>::new());
        assert_eq!(saved_chat_id(&bot).as_deref(), Some(OWNER));

        // A chat that is known but never completed pairing is treated the same.
        bot.chat_states.write().await.insert(
            STRANGER.to_string(),
            BotChatState::new(STRANGER.to_string()),
        );
        bot.deliver_interaction(STRANGER, question("tool-2"), epoch)
            .await;
        assert_eq!(fake.sent_to(STRANGER), Vec::<Sent>::new());
        let states = bot.chat_states.read().await;
        let stranger = states.get(STRANGER).expect("state was inserted above");
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

        for _ in 0..5 {
            let paired = bot
                .handle_pairing_event_payload(&text_event(STRANGER, "000000"))
                .await;
            assert_eq!(paired, None);
        }
        // The right code no longer helps a chat that used up its attempts.
        let paired = bot
            .handle_pairing_event_payload(&text_event(STRANGER, PAIRING_CODE))
            .await;
        assert_eq!(paired, None);
        let paired = bot
            .handle_pairing_event_payload(&text_event(OWNER, "111111"))
            .await;
        assert_eq!(paired, None);
        let paired = bot
            .handle_pairing_event_payload(&text_event(OWNER, PAIRING_CODE))
            .await;
        assert_eq!(paired.as_deref(), Some(OWNER));

        let states = bot.chat_states.read().await;
        assert!(states.get(OWNER).is_some_and(|state| state.paired));
        assert!(!states.contains_key(STRANGER));
        drop(states);
        // Four "wrong code" replies, then one lockout notice, then silence.
        assert_eq!(fake.sent_to(STRANGER).len(), 5);
        assert_eq!(saved_chat_id(&bot).as_deref(), Some(OWNER));
    }

    #[tokio::test]
    async fn repeated_messages_from_an_unpaired_chat_get_a_bounded_number_of_replies() {
        // While the first pairing is still pending.
        let (fake, bot) = fake_bot();
        bot.register_pairing(PAIRING_CODE).await.unwrap();
        for index in 0..20 {
            let payload = match index % 3 {
                0 => text_event(STRANGER, "hello"),
                1 => image_event(STRANGER),
                _ => file_event(STRANGER),
            };
            assert_eq!(bot.handle_pairing_event_payload(&payload).await, None);
        }
        let paired = bot
            .handle_pairing_event_payload(&text_event(OWNER, PAIRING_CODE))
            .await;
        assert_eq!(paired.as_deref(), Some(OWNER));
        let replies = fake.sent_to(STRANGER).len();
        assert!(
            (1..=3).contains(&replies),
            "replies while pairing: {replies}"
        );

        // After pairing, in the message loop: text, images and other types.
        for index in 0..20 {
            let payload = match index % 3 {
                0 => text_event(STRANGER, "hello again"),
                1 => image_event(STRANGER),
                _ => file_event(STRANGER),
            };
            dispatch(&bot, payload).await;
        }
        let replies = fake.sent_to(STRANGER).len() - replies;
        assert!(
            (1..=3).contains(&replies),
            "replies when connected: {replies}"
        );
        assert!(!bot.chat_states.read().await.contains_key(STRANGER));
        assert_eq!(
            fake.image_downloads.load(Ordering::SeqCst),
            0,
            "an unpaired chat must not make the host download its images"
        );
    }

    #[tokio::test]
    async fn code_issued_for_a_connected_bot_moves_the_connection_to_the_chat_that_presents_it() {
        let (fake, bot) = connected_bot().await;
        bot.register_pairing(PAIRING_CODE).await.unwrap();

        dispatch(&bot, text_event(STRANGER, "111111")).await;
        assert!(!bot.chat_states.read().await.contains_key(STRANGER));
        assert_eq!(saved_chat_id(&bot).as_deref(), Some(OWNER));

        dispatch(&bot, text_event(STRANGER, PAIRING_CODE)).await;
        let states = bot.chat_states.read().await;
        assert!(states.get(STRANGER).is_some_and(|state| state.paired));
        assert!(
            !states.contains_key(OWNER),
            "one connection has one chat: the previous chat is no longer paired"
        );
        drop(states);
        assert_eq!(saved_chat_id(&bot).as_deref(), Some(STRANGER));
        assert!(
            !bot.verify_pairing_code(PAIRING_CODE).await,
            "the pairing code is single use"
        );
        assert!(!fake.sent_to(STRANGER).is_empty());
    }

    #[tokio::test]
    async fn legacy_persisted_paired_chat_is_restored_without_pairing_again() {
        let saved = legacy_saved_connection(
            "feishu",
            OWNER,
            serde_json::json!({
                "bot_type": "feishu",
                "app_id": "fixture-app",
                "app_secret": "fixture-secret"
            }),
        );
        let (fake, bot) = fake_bot();

        bot.restore_chat_state(OWNER, saved.chat_state.clone())
            .await;
        dispatch(&bot, text_event(OWNER, "/help")).await;

        assert_eq!(
            fake.sent_to(OWNER)
                .iter()
                .filter(|sent| matches!(sent, Sent::Card { .. }))
                .count(),
            1,
            "the restored chat reaches the command router without a pairing prompt"
        );
        let resaved = bot
            .runtime_fence
            .saved_connection("feishu")
            .expect("restored connection is saved");
        assert_eq!(resaved.chat_id, OWNER);
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
            .fetch_add(1, Ordering::AcqRel);
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
        dispatch(&bot, text_event(OWNER, "/help")).await;
        dispatch(&bot, text_event(STRANGER, "/help")).await;
        dispatch(&bot, file_event(STRANGER)).await;
        bot.deliver_interaction(
            OWNER,
            question("tool-2"),
            bot.runtime_fence.identity_epoch(),
        )
        .await;
        assert_eq!(fake.sent.lock().unwrap().len(), 0);
        assert!(!bot.chat_states.read().await.contains_key(STRANGER));
        assert_eq!(saved_chat_id(&bot).as_deref(), Some(OWNER));
    }

    #[test]
    fn parse_text_message_event() {
        let event = serde_json::json!({
            "header": { "event_type": "im.message.receive_v1" },
            "event": {
                "message": {
                    "message_type": "text",
                    "chat_id": "oc_test_chat",
                    "content": "{\"text\":\"/help\"}"
                }
            }
        });

        let parsed = feishu_provider::parse_message_event_full(&event).map(|p| (p.chat_id, p.text));
        assert_eq!(
            parsed,
            Some(("oc_test_chat".to_string(), "/help".to_string()))
        );
    }

    #[test]
    fn parse_card_action_event_uses_embedded_chat_id() {
        let event = serde_json::json!({
            "header": { "event_type": "card.action.trigger" },
            "event": {
                "context": {
                    "open_chat_id": "oc_fallback"
                },
                "action": {
                    "value": {
                        "chat_id": "oc_actual",
                        "command": "/switch_workspace"
                    }
                }
            }
        });

        let parsed = feishu_provider::parse_card_action_event(&event);
        assert_eq!(
            parsed,
            Some(("oc_actual".to_string(), "/switch_workspace".to_string()))
        );
    }
}
