//! Shared bot management used by Desktop commands and the CLI daemon.
//!
//! Hosts supply their authenticated account and the existing service instance.
//! Provider IO, chat routing and Agent execution remain in their existing owners.

use super::{bot, ConnectionMethod, ConnectionResult, RemoteConnectService};
use anyhow::{anyhow, Result};
use openbitfun_product_domains::remote_control::RemoteControlRequest;
use serde_json::{json, Value};
use std::collections::HashMap;
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::Arc;
use tokio::sync::{Mutex, RwLock};

pub type RemoteConnectServiceHolder = Arc<RwLock<Option<RemoteConnectService>>>;

struct Login {
    account: (String, u64),
    generation: u64,
    started: std::time::Instant,
    completed: Option<Value>,
}

pub struct RemoteBotControl {
    service: RemoteConnectServiceHolder,
    mutation: Mutex<()>,
    invitations: Mutex<HashMap<String, ConnectionResult>>,
    restore_errors: Mutex<HashMap<String, String>>,
    logins: Mutex<HashMap<String, Login>>,
    login_generation: AtomicU64,
}

impl RemoteBotControl {
    pub fn new(service: RemoteConnectServiceHolder) -> Self {
        Self {
            service,
            mutation: Mutex::new(()),
            invitations: Mutex::new(HashMap::new()),
            restore_errors: Mutex::new(HashMap::new()),
            logins: Mutex::new(HashMap::new()),
            login_generation: AtomicU64::new(0),
        }
    }

    async fn account_scope(&self) -> Result<(String, u64)> {
        self.service.read().await.as_ref()
            .ok_or_else(|| anyhow!("Remote Connect host is unavailable"))?
            .bot_account_scope().await
            .ok_or_else(|| anyhow!("account_required: Sign in to OpenBitFun on the executing host before starting a bot"))
    }

    pub async fn restore(&self, user_id: &str) -> Result<()> {
        let _mutation = self.mutation.lock().await;
        let data = bot::try_load_bot_persistence()?;
        let holder = self.service.read().await;
        let service = holder
            .as_ref()
            .ok_or_else(|| anyhow!("Remote Connect host is unavailable"))?;
        service.set_bot_account(Some(user_id.into())).await;
        for saved in &data.connections {
            if !restore_eligible(&data, saved, user_id) {
                continue;
            }
            if service.is_bot_running(&saved.bot_type).await {
                continue;
            }
            match service.restore_bot(saved).await {
                Ok(()) => {
                    self.restore_errors.lock().await.remove(&saved.bot_type);
                }
                Err(error) => {
                    // One unavailable channel must not prevent other channels or
                    // device routing from starting. Keep the saved connection.
                    log::warn!("Failed to restore {} bot: {error}", saved.bot_type);
                    self.restore_errors
                        .lock()
                        .await
                        .insert(saved.bot_type.clone(), error.to_string());
                }
            }
        }
        Ok(())
    }

    pub async fn status(&self) -> Result<Value> {
        let data = bot::try_load_bot_persistence()?;
        let holder = self.service.read().await;
        let service = holder.as_ref();
        let account = match service {
            Some(service) => service.bot_account_scope().await,
            None => None,
        };
        let mut channels = Vec::new();
        for bot_type in ["weixin", "telegram", "feishu"] {
            let saved = data.get(bot_type);
            let paired = saved.is_some_and(|saved| {
                saved.chat_state.paired
                    && configured_bot(&data, bot_type)
                        .as_ref()
                        .is_none_or(|config| same_config(config, &saved.config))
                    && account
                        .as_ref()
                        .is_some_and(|(id, _)| *id == saved.account_user_id)
            });
            let listener_running = match service {
                Some(service) => service.is_bot_running(bot_type).await,
                None => false,
            };
            let login_required = match service {
                Some(service) => service.bot_requires_login(bot_type).await,
                None => false,
            };
            let disabled = data.disabled_bots.iter().any(|id| id == bot_type);
            channels.push(json!({
                "method": bot_type,
                "configured": configured_bot(&data, bot_type).is_some() || paired,
                "paired": paired,
                "listenerRunning": listener_running,
                "loginRequired": login_required,
                "state": if login_required { "login_required" } else if listener_running { if paired { "listening" } else { "awaiting_pairing" } } else { "stopped" },
                "lastError": if login_required { Some("WeChat credentials expired; use weixin-login-start to sign in again") } else { None },
                "restoreOnRestart": paired && !disabled,
                "requiresPairing": configured_bot(&data, bot_type).is_some() && !paired,
                "lastRestoreError": self.restore_errors.lock().await.get(bot_type).cloned(),
            }));
        }
        Ok(json!({ "bots": channels, "botVerbose": data.verbose_mode,
            "listenerStatusMeaning": "listenerRunning reports a live host task, including network retries; it does not assert a verified message round trip" }))
    }

    pub async fn execute(&self, request: RemoteControlRequest) -> Result<Value> {
        match request {
            RemoteControlRequest::Status => self.status().await,
            RemoteControlRequest::Start { method, .. } => {
                let bot_type = method
                    .bot_type()
                    .ok_or_else(|| anyhow!("Mobile Web is managed by the host Relay adapter"))?;
                let _mutation = self.mutation.lock().await;
                self.start_locked(bot_type).await
            }
            RemoteControlRequest::Stop { method } => {
                let bot_type = method
                    .bot_type()
                    .ok_or_else(|| anyhow!("Mobile Web is managed by the host Relay adapter"))?;
                self.stop(bot_type).await?;
                self.status().await
            }
            RemoteControlRequest::ConfigureBot {
                method,
                credentials_file,
            } => {
                let bot_type = method
                    .bot_type()
                    .ok_or_else(|| anyhow!("configure-bot requires a bot method"))?;
                let scope = self.account_scope().await?;
                let config = bot::read_bot_credentials_file(credentials_file.into()).await?;
                anyhow::ensure!(
                    config.bot_type() == bot_type,
                    "Credential file does not match the requested bot method"
                );
                let _mutation = self.mutation.lock().await;
                anyhow::ensure!(
                    self.account_scope().await? == scope,
                    "Account changed while reading bot credentials"
                );
                if bot_type == "weixin" {
                    self.login_generation.fetch_add(1, Ordering::AcqRel);
                }
                self.configure_locked(config).await?;
                self.status().await
            }
            RemoteControlRequest::WeixinLoginStart => self.weixin_login_start().await,
            RemoteControlRequest::WeixinLoginPoll {
                session_key,
                verify_code,
            } => self.weixin_login_poll(&session_key, verify_code).await,
            RemoteControlRequest::SetBotVerbose { enabled } => {
                let _mutation = self.mutation.lock().await;
                bot::try_update_bot_persistence(|data| data.verbose_mode = enabled)?;
                self.status().await
            }
        }
    }

    /// Also used by the existing GUI secret-entry adapter. Credentials never
    /// enter ProductControl responses or discovery.
    pub async fn configure(&self, config: bot::BotConfig) -> Result<()> {
        let _mutation = self.mutation.lock().await;
        if config.bot_type() == "weixin" {
            self.login_generation.fetch_add(1, Ordering::AcqRel);
        }
        self.configure_locked(config).await
    }

    async fn configure_locked(&self, config: bot::BotConfig) -> Result<()> {
        config.validate()?;
        let bot_type = config.bot_type();
        let data = bot::try_load_bot_persistence()?;
        let unchanged = configured_bot(&data, bot_type)
            .as_ref()
            .is_some_and(|previous| {
                serde_json::to_value(previous).ok() == serde_json::to_value(&config).ok()
            });
        let _ownership = if !unchanged {
            if let Some(service) = self.service.read().await.as_ref() {
                service.stop_bot(bot_type).await?;
            }
            self.invitations.lock().await.remove(bot_type);
            Some(bot::BotListenerLease::acquire(bot_type)?)
        } else {
            None
        };
        bot::try_update_bot_persistence(|data| {
            store_config(data, &config);
            if !unchanged && !data.disabled_bots.iter().any(|id| id == bot_type) {
                data.disabled_bots.push(bot_type.into());
            }
        })?;
        self.service
            .write()
            .await
            .as_mut()
            .ok_or_else(|| anyhow!("Remote Connect host is unavailable"))?
            .update_bot_config(config);
        Ok(())
    }

    async fn start_locked(&self, bot_type: &str) -> Result<Value> {
        let scope = self.account_scope().await?;
        let data = bot::try_load_bot_persistence()?;
        {
            let holder = self.service.read().await;
            let service = holder
                .as_ref()
                .ok_or_else(|| anyhow!("Remote Connect host is unavailable"))?;
            if service.is_bot_running(bot_type).await {
                anyhow::ensure!(!service.bot_requires_login(bot_type).await,
                    "weixin_login_required: The provider rejected the saved credentials; use weixin-login-start to sign in again");
                let effective = self.status_without_holder(&data, bot_type, true, &scope.0);
                let connection = if effective["paired"] == true {
                    None
                } else {
                    self.invitations.lock().await.get(bot_type).cloned()
                };
                return Ok(
                    json!({ "alreadyRunning": true, "connection": connection, "effectiveState":effective }),
                );
            }
        }
        let config = configured_bot(&data, bot_type)
            .or_else(|| data.get(bot_type).filter(|saved| saved.account_user_id == scope.0).map(|saved| saved.config.clone()))
            .ok_or_else(|| anyhow!(if bot_type == "weixin" {
                "weixin_login_required: Use weixin-login-start, show its QR image, then weixin-login-poll to complete login and start listening"
            } else {
                "bot_credentials_required: Configure this bot through Remote Connect or configure-bot with a private credential file on the executing host"
            }))?;
        config.validate()?;
        {
            let mut holder = self.service.write().await;
            holder
                .as_mut()
                .ok_or_else(|| anyhow!("Remote Connect host is unavailable"))?
                .update_bot_config(config.clone());
        }
        let holder = self.service.read().await;
        let service = holder
            .as_ref()
            .ok_or_else(|| anyhow!("Remote Connect host is unavailable"))?;
        anyhow::ensure!(
            service.bot_account_scope().await.as_ref() == Some(&scope),
            "Account changed before bot start"
        );
        let saved = data.get(bot_type).filter(|saved| {
            saved.account_user_id == scope.0
                && saved.chat_state.paired
                && serde_json::to_value(&saved.config).ok() == serde_json::to_value(&config).ok()
        });
        let connection = if let Some(saved) = saved {
            service.restore_bot(saved).await?;
            None
        } else {
            let result = service.start(bot_method(bot_type)?).await?;
            self.invitations
                .lock()
                .await
                .insert(bot_type.into(), result.clone());
            Some(result)
        };
        if let Err(error) = bot::try_update_bot_persistence(|data| {
            data.disabled_bots.retain(|id| id != bot_type);
            store_config(data, &config);
        }) {
            service.stop_bot(bot_type).await?;
            return Err(error);
        }
        self.restore_errors.lock().await.remove(bot_type);
        anyhow::ensure!(service.is_bot_running(bot_type).await,
            "bot_listener_stopped: The provider listener exited during startup; inspect status before retrying");
        Ok(json!({ "started": true, "connection": connection,
            "effectiveState": self.status_without_holder(&data, bot_type, true, &scope.0),
            "nextStep": if connection.is_some() { "Send the returned 6-digit bot_pairing_code to the bot. The host is already listening; pairing then routes messages to the shared Claw runtime." } else { "The saved paired channel has resumed listening." } }))
    }

    fn status_without_holder(
        &self,
        data: &bot::BotPersistenceData,
        bot_type: &str,
        running: bool,
        account: &str,
    ) -> Value {
        json!({ "method": bot_type, "listenerRunning": running,
            "paired": data.get(bot_type).is_some_and(|saved| saved.chat_state.paired && saved.account_user_id == account
                && configured_bot(data, bot_type).as_ref().is_none_or(|config| same_config(config, &saved.config))) })
    }

    /// Preserve the legacy GUI response while sharing the lifecycle transaction.
    pub async fn start_connection(&self, bot_type: &str) -> Result<ConnectionResult> {
        let _mutation = self.mutation.lock().await;
        let result = self.start_locked(bot_type).await?;
        if let Some(connection) = result.get("connection").filter(|value| !value.is_null()) {
            return Ok(serde_json::from_value(connection.clone())?);
        }
        anyhow::ensure!(result.pointer("/effectiveState/paired").and_then(Value::as_bool) == Some(true),
            "Bot is listening but its pairing invitation is unavailable; stop and start this channel to pair again");
        Ok(ConnectionResult {
            method: bot_method(bot_type)?,
            qr_data: None,
            qr_svg: None,
            qr_url: None,
            bot_pairing_code: None,
            bot_link: None,
            pairing_state: super::PairingState::Connected,
        })
    }

    pub async fn stop(&self, bot_type: &str) -> Result<()> {
        bot_method(bot_type)?;
        let _mutation = self.mutation.lock().await;
        if bot_type == "weixin" {
            self.login_generation.fetch_add(1, Ordering::AcqRel);
        }
        if let Some(service) = self.service.read().await.as_ref() {
            service.stop_bot(bot_type).await?;
        }
        let _ownership = bot::BotListenerLease::acquire(bot_type)?;
        self.invitations.lock().await.remove(bot_type);
        bot::try_update_bot_persistence(|data| {
            if !data.disabled_bots.iter().any(|id| id == bot_type) {
                data.disabled_bots.push(bot_type.into());
            }
        })?;
        Ok(())
    }

    pub async fn weixin_login_start(&self) -> Result<Value> {
        let account = self.account_scope().await?;
        let generation = self.login_generation.fetch_add(1, Ordering::AcqRel) + 1;
        let data = bot::try_load_bot_persistence()?;
        let form = data.form_state;
        let response = bot::weixin::weixin_qr_start_with_existing(
            Some(form.weixin_base_url),
            Some(form.weixin_ilink_token),
            Some(form.weixin_bot_account_id),
        )
        .await?;
        anyhow::ensure!(
            self.account_scope().await? == account
                && self.login_generation.load(Ordering::Acquire) == generation,
            "WeChat login was replaced or the account changed"
        );
        let mut logins = self.logins.lock().await;
        logins.retain(|_, login| login.started.elapsed() < std::time::Duration::from_secs(300));
        logins.insert(
            response.session_key.clone(),
            Login {
                account,
                generation,
                started: std::time::Instant::now(),
                completed: None,
            },
        );
        let qr = super::QrGenerator::present_content(&response.qr_image_url)?;
        Ok(
            json!({ "sessionKey": response.session_key, "qrImageUrl": qr.image_url, "qrTerminal": qr.terminal,
            "loginStatus": "awaiting_scan", "message": response.message,
            "nextStep": "The CLI TUI displays qrTerminal in the tool card; ask the user to scan it without retyping the QR. Other terminal surfaces may show qrTerminal verbatim; graphical surfaces display qrImageUrl. Then call weixin-login-poll with sessionKey. QR confirmation saves credentials on this host and starts the bot listener; send the returned pairing code in WeChat." }),
        )
    }

    pub async fn weixin_login_poll(
        &self,
        session_key: &str,
        verify_code: Option<String>,
    ) -> Result<Value> {
        let scope = self.account_scope().await?;
        let generation = self.login_generation.load(Ordering::Acquire);
        {
            let logins = self.logins.lock().await;
            let login = logins.get(session_key).ok_or_else(|| {
                anyhow!("WeChat login is unavailable on this host; start login again")
            })?;
            anyhow::ensure!(
                login.account == scope && login.generation == generation,
                "WeChat login was cancelled or belongs to a previous account"
            );
            if let Some(result) = &login.completed {
                return Ok(result.clone());
            }
        }
        // Do not hold the management lock during the provider's long poll.
        // Stop/logout remains available, and the completion is checked again.
        let response = bot::weixin::weixin_qr_poll(session_key, None, verify_code).await?;
        let _mutation = self.mutation.lock().await;
        anyhow::ensure!(
            self.account_scope().await? == scope
                && self.login_generation.load(Ordering::Acquire) == generation,
            "WeChat login was cancelled or the account changed"
        );
        if let Some(result) = self
            .logins
            .lock()
            .await
            .get(session_key)
            .and_then(|login| login.completed.clone())
        {
            return Ok(result);
        }
        let mut result = json!({ "loginStatus": response.status, "message": response.message });
        if let Some(content) = response.qr_image_url.as_deref() {
            let qr = super::QrGenerator::present_content(content)?;
            result["qrImageUrl"] = json!(qr.image_url);
            result["qrTerminal"] = json!(qr.terminal);
        }
        if matches!(response.status, bot::weixin::WeixinQrPollStatus::Confirmed) {
            let config = bot::BotConfig::Weixin {
                ilink_token: response
                    .ilink_token
                    .ok_or_else(|| anyhow!("Confirmed WeChat login has no credential"))?,
                base_url: response
                    .base_url
                    .unwrap_or_else(|| "https://ilinkai.weixin.qq.com".into()),
                bot_account_id: response
                    .bot_account_id
                    .ok_or_else(|| anyhow!("Confirmed WeChat login has no account id"))?,
            };
            self.configure_locked(config).await?;
            result["listener"] = self.start_locked("weixin").await?;
            if let Some(login) = self.logins.lock().await.get_mut(session_key) {
                login.completed = Some(result.clone());
            }
        }
        Ok(result)
    }
}

pub fn bot_method(bot_type: &str) -> Result<ConnectionMethod> {
    match bot_type {
        "weixin" => Ok(ConnectionMethod::BotWeixin),
        "telegram" => Ok(ConnectionMethod::BotTelegram),
        "feishu" => Ok(ConnectionMethod::BotFeishu),
        _ => Err(anyhow!("Unknown bot type")),
    }
}

fn configured_bot(data: &bot::BotPersistenceData, bot_type: &str) -> Option<bot::BotConfig> {
    let form = &data.form_state;
    let config = match bot_type {
        "weixin" => bot::BotConfig::Weixin {
            ilink_token: form.weixin_ilink_token.clone(),
            base_url: form.weixin_base_url.clone(),
            bot_account_id: form.weixin_bot_account_id.clone(),
        },
        "telegram" => bot::BotConfig::Telegram {
            bot_token: form.telegram_bot_token.clone(),
        },
        "feishu" => bot::BotConfig::Feishu {
            app_id: form.feishu_app_id.clone(),
            app_secret: form.feishu_app_secret.clone(),
        },
        _ => return None,
    };
    config.validate().ok().map(|_| config)
}

fn store_config(data: &mut bot::BotPersistenceData, config: &bot::BotConfig) {
    let form = &mut data.form_state;
    match config {
        bot::BotConfig::Weixin {
            ilink_token,
            base_url,
            bot_account_id,
        } => {
            form.weixin_ilink_token = ilink_token.clone();
            form.weixin_base_url = base_url.clone();
            form.weixin_bot_account_id = bot_account_id.clone();
        }
        bot::BotConfig::Telegram { bot_token } => form.telegram_bot_token = bot_token.clone(),
        bot::BotConfig::Feishu { app_id, app_secret } => {
            form.feishu_app_id = app_id.clone();
            form.feishu_app_secret = app_secret.clone();
        }
    }
}

fn same_config(left: &bot::BotConfig, right: &bot::BotConfig) -> bool {
    serde_json::to_value(left).ok() == serde_json::to_value(right).ok()
}

fn restore_eligible(
    data: &bot::BotPersistenceData,
    saved: &bot::SavedBotConnection,
    user_id: &str,
) -> bool {
    saved.chat_state.paired
        && saved.account_user_id == user_id
        && !data.disabled_bots.contains(&saved.bot_type)
        && configured_bot(data, &saved.bot_type)
            .as_ref()
            .is_none_or(|config| same_config(config, &saved.config))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn restart_requires_enabled_pairing_for_current_account_and_credentials() {
        let saved: bot::SavedBotConnection = serde_json::from_value(json!({
            "account_user_id":"alice", "bot_type":"telegram", "chat_id":"chat",
            "config":{"bot_type":"telegram", "bot_token":"old-token"}, "connected_at":1,
            "chat_state":{"chat_id":"chat", "paired":true, "current_workspace":"/legacy/workspace", "current_assistant":null, "current_session_id":"session"}
        })).unwrap();
        let mut data = bot::BotPersistenceData::default();
        data.connections.push(saved.clone());
        assert!(restore_eligible(&data, &saved, "alice"));
        assert!(!restore_eligible(&data, &saved, "bob"));
        data.disabled_bots.push("telegram".into());
        assert!(!restore_eligible(&data, &saved, "alice"));
        data.disabled_bots.clear();
        data.form_state.telegram_bot_token = "replacement-token".into();
        assert!(!restore_eligible(&data, &saved, "alice"));
        data.form_state.telegram_bot_token = "old-token".into();
        assert!(restore_eligible(&data, &saved, "alice"));
        let mut unpaired = saved;
        unpaired.chat_state.paired = false;
        assert!(!restore_eligible(&data, &unpaired, "alice"));
    }
}
