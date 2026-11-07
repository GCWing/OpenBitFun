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
    complete_im_bot_pairing, current_bot_language, deliver_final_reply, execute_forwarded_turn,
    handle_command, parse_command, welcome_message, BotAction, BotChatState, BotInteractionHandler,
    BotInteractiveRequest, BotLanguage, BotMessageSender, HandleResult,
};
use super::{
    load_bot_persistence, update_bot_persistence, BotConfig, BotRuntimeFence, SavedBotConnection,
};
use crate::service::remote_connect::remote_server::ImageAttachment;

#[derive(Debug, Clone)]
struct PendingPairing {
    created_at: i64,
}

pub struct FeishuBot {
    api: FeishuBotApi,
    pending_pairings: Arc<RwLock<HashMap<String, PendingPairing>>>,
    chat_states: Arc<RwLock<HashMap<String, BotChatState>>>,
    runtime_fence: BotRuntimeFence,
}

impl FeishuBot {
    fn invalid_pairing_code_message(language: BotLanguage) -> &'static str {
        if language.is_chinese() {
            "\u{914d}\u{5bf9}\u{7801}\u{65e0}\u{6548}\u{6216}\u{5df2}\u{8fc7}\u{671f}\u{ff0c}\u{8bf7}\u{91cd}\u{8bd5}\u{3002}"
        } else {
            "Invalid or expired pairing code. Please try again."
        }
    }

    fn enter_pairing_code_message(language: BotLanguage) -> &'static str {
        if language.is_chinese() {
            "\u{8bf7}\u{8f93}\u{5165} OpenBitFun Desktop \u{4e2d}\u{663e}\u{793a}\u{7684} 6 \u{4f4d}\u{914d}\u{5bf9}\u{7801}\u{3002}"
        } else {
            "Please enter the 6-digit pairing code from OpenBitFun Desktop."
        }
    }

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
        Self {
            api: FeishuBotApi::new(config),
            pending_pairings: Arc::new(RwLock::new(HashMap::new())),
            chat_states: Arc::new(RwLock::new(HashMap::new())),
            runtime_fence,
        }
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

    pub async fn register_pairing(&self, pairing_code: &str) -> Result<()> {
        self.pending_pairings.write().await.insert(
            pairing_code.to_string(),
            PendingPairing {
                created_at: chrono::Utc::now().timestamp(),
            },
        );
        Ok(())
    }

    pub async fn verify_pairing_code(&self, code: &str) -> bool {
        let mut pairings = self.pending_pairings.write().await;
        if let Some(p) = pairings.remove(code) {
            let age = chrono::Utc::now().timestamp() - p.created_at;
            return age < 300;
        }
        false
    }

    async fn handle_pairing_event_payload(&self, payload: &[u8]) -> Option<String> {
        let event: serde_json::Value = serde_json::from_slice(payload).ok()?;

        if let Some(parsed) = feishu_provider::parse_message_event_full(&event) {
            let language = current_bot_language().await;
            let chat_id = parsed.chat_id;
            let msg_text = parsed.text;
            let trimmed = msg_text.trim();

            if trimmed == "/start" {
                self.send_message(&chat_id, welcome_message(language))
                    .await
                    .ok();
            } else if trimmed.len() == 6 && trimmed.chars().all(|c| c.is_ascii_digit()) {
                if self.verify_pairing_code(trimmed).await {
                    info!("Feishu pairing successful, chat_id={chat_id}");
                    let mut state = BotChatState::new(chat_id.clone());
                    let identity_epoch = self.runtime_fence.identity_epoch();
                    let result = complete_im_bot_pairing(&mut state).await;
                    if !self.runtime_fence.is_lifecycle_current() {
                        return None;
                    }
                    let mut states = self.chat_states.write().await;
                    self.runtime_fence.reconcile_states(&mut states);
                    self.runtime_fence
                        .sanitize_after_epoch(identity_epoch, &mut state);
                    states.insert(chat_id.clone(), state.clone());
                    drop(states);
                    self.persist_chat_state(&chat_id, &state).await;
                    self.send_handle_result(&chat_id, &result).await.ok();

                    return Some(chat_id);
                } else {
                    self.send_message(&chat_id, Self::invalid_pairing_code_message(language))
                        .await
                        .ok();
                }
            } else {
                self.send_message(&chat_id, Self::enter_pairing_code_message(language))
                    .await
                    .ok();
            }
        } else if let Some(chat_id) = feishu_provider::extract_message_chat_id(&event) {
            let language = current_bot_language().await;
            self.send_message(&chat_id, Self::enter_pairing_code_message(language))
                .await
                .ok();
        }
        None
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

        loop {
            tokio::select! {
                _ = stop_rx.changed() => {
                    info!("Feishu wait_for_pairing stopped by signal");
                    return Err(anyhow!("bot stop requested"));
                }
                msg = connection.next_event() => {
                    match msg {
                        Ok(Some(event)) => {
                            let _ = connection.ack_event(&event).await;
                            if let Some(chat_id) = self.handle_pairing_event_payload(event.payload()).await {
                                return Ok(chat_id);
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
                    let _ = connection.send_ping(service_id).await;
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

            loop {
                tokio::select! {
                    _ = stop.changed() => {
                        info!("Feishu bot message loop stopped by signal");
                        return;
                    }
                    msg = connection.next_event() => {
                        match msg {
                            Ok(Some(event)) => {
                                let _ = connection.ack_event(&event).await;
                                self.handle_event_payload(event.payload()).await;
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
                        let _ = connection.send_ping(service_id).await;
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

        if let Some(parsed) = feishu_provider::parse_message_event_full(&event) {
            let bot = self.clone();
            tokio::spawn(async move {
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
                    bot.download_images(&parsed.message_id, keys_to_use).await
                };
                if truncated {
                    let discarded = parsed.image_keys.len() - MAX_IMAGES;
                    let msg = Self::image_truncated_message(language, MAX_IMAGES, discarded);
                    bot.send_message(&parsed.chat_id, &msg).await.ok();
                }
                let text = if parsed.text.is_empty() && !images.is_empty() {
                    Self::image_placeholder_message(language)
                } else {
                    parsed.text
                };
                bot.handle_incoming_message(&parsed.chat_id, &text, images)
                    .await;
            });
        } else if let Some((chat_id, cmd)) = feishu_provider::parse_card_action_event(&event) {
            let bot = self.clone();
            tokio::spawn(async move {
                bot.handle_incoming_message(&chat_id, &cmd, vec![]).await;
            });
        } else if let Some(chat_id) = feishu_provider::extract_message_chat_id(&event) {
            let bot = self.clone();
            tokio::spawn(async move {
                let language = current_bot_language().await;
                bot.send_message(&chat_id, Self::unsupported_message_type_message(language))
                    .await
                    .ok();
            });
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
        let mut states = self.chat_states.write().await;
        let command_identity_epoch = self.runtime_fence.identity_epoch();
        self.runtime_fence.reconcile_states(&mut states);
        let state = states.entry(chat_id.to_string()).or_insert_with(|| {
            let mut s = BotChatState::new(chat_id.to_string());
            s.paired = true;
            s
        });
        let language = current_bot_language().await;

        if !state.paired {
            let trimmed = text.trim();
            if trimmed == "/start" {
                self.send_message(chat_id, welcome_message(language))
                    .await
                    .ok();
                return;
            }
            if trimmed.len() == 6 && trimmed.chars().all(|c| c.is_ascii_digit()) {
                if self.verify_pairing_code(trimmed).await {
                    let identity_epoch = self.runtime_fence.identity_epoch();
                    let result = complete_im_bot_pairing(state).await;
                    self.runtime_fence
                        .sanitize_after_epoch(identity_epoch, state);
                    if !self.runtime_fence.is_lifecycle_current() {
                        return;
                    }
                    self.send_handle_result(chat_id, &result).await.ok();
                    self.persist_chat_state(chat_id, state).await;
                    return;
                } else {
                    self.send_message(chat_id, Self::invalid_pairing_code_message(language))
                        .await
                        .ok();
                    return;
                }
            }
            self.send_message(chat_id, Self::enter_pairing_code_message(language))
                .await
                .ok();
            return;
        }

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
            let output_turn_id = forward.turn_id.clone();
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
                    if let Err(err) = deliver_final_reply(
                        &output_session_id,
                        &output_turn_id,
                        output_remote_target.as_ref(),
                        &result,
                        bot.send_message(&cid, &result.display_text),
                    )
                    .await
                    {
                        warn!("Failed to send Feishu final message to {cid}: {err}");
                    }
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
        let state = states.entry(chat_id.to_string()).or_insert_with(|| {
            let mut s = BotChatState::new(chat_id.to_string());
            s.paired = true;
            s
        });
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
        self.send_handle_result(chat_id, &result).await.ok();
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
        self.runtime_fence.commit_if_current(|| {
            update_bot_persistence(|data| data.upsert(connection));
        });
    }
}

#[cfg(test)]
mod tests {
    use super::feishu_provider;

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
