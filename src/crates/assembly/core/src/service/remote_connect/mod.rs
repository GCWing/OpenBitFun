//! Remote Connect service module.
//!
//! Provides phone-to-desktop remote connection capabilities with E2E encryption.
//! Account-authenticated Relay connections over official or LAN URLs, plus IM bots.
//!
//! Bot connections (Telegram / Feishu / Weixin) run independently of relay connections
//! (LAN / OpenBitFun Server). Calling `stop()` only
//! tears down the relay side; bots keep running.  Use `stop_bot()` or
//! `stop_all()` to shut everything down.

pub mod account_runtime;
pub mod bot;
pub mod embedded_relay_host;
pub mod lan;
mod permission_publication;
pub mod remote_server;

pub mod device {
    pub use openbitfun_services_integrations::remote_connect::device::*;
}

pub mod encryption {
    pub use openbitfun_services_integrations::remote_connect::encryption::*;
}

pub mod pairing {
    pub use openbitfun_services_integrations::remote_connect::pairing::*;
}

pub mod qr_generator {
    pub use openbitfun_services_integrations::remote_connect::qr_generator::*;
}

pub mod relay_client {
    pub use openbitfun_services_integrations::remote_connect::relay_client::*;
}

pub mod account {
    pub use openbitfun_services_integrations::remote_connect::account::*;
}

pub mod host_stream {
    pub use openbitfun_services_integrations::remote_connect::host_stream::*;
}

pub mod host_stream_subscriber {
    pub use openbitfun_services_integrations::remote_connect::host_stream_subscriber::*;
}

pub mod session_records {
    pub use openbitfun_services_integrations::remote_connect::session_records::*;
}

pub mod session_store {
    pub use openbitfun_services_integrations::remote_connect::session_store::*;
}

pub use account::{validate_relay_base_url, AccountClient, AccountSession, DelegateToken};
pub use device::DeviceIdentity;
pub use encryption::{decrypt_from_base64, encrypt_to_base64, KeyPair};
pub use pairing::PairingState;
pub use qr_generator::QrGenerator;
pub use relay_client::ensure_rustls_crypto_provider;
pub use relay_client::RelayClient;
pub use remote_server::RemoteServer;

use anyhow::Result;
use embedded_relay_host::EmbeddedRelayHost;
use log::{info, warn};
use serde::{Deserialize, Serialize};
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::Arc;
use tokio::sync::{Mutex, RwLock};

/// Supported connection methods.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum ConnectionMethod {
    Lan {
        ip: Option<String>,
    },
    #[serde(rename = "openbitfun_server")]
    OpenBitFunServer,
    BotFeishu,
    BotTelegram,
    BotWeixin,
}

/// Configuration for Remote Connect.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct RemoteConnectConfig {
    pub lan_port: u16,
    pub openbitfun_server_url: String,
    pub bot_feishu: Option<bot::BotConfig>,
    pub bot_telegram: Option<bot::BotConfig>,
    pub bot_weixin: Option<bot::BotConfig>,
    pub mobile_web_dir: Option<String>,
}

impl Default for RemoteConnectConfig {
    fn default() -> Self {
        Self {
            lan_port: 9700,
            openbitfun_server_url: openbitfun_product_domains::account::DEFAULT_RELAY_URL
                .to_string(),
            bot_feishu: None,
            bot_telegram: None,
            bot_weixin: None,
            mobile_web_dir: None,
        }
    }
}

/// Result of starting a remote connection.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct ConnectionResult {
    pub method: ConnectionMethod,
    pub qr_data: Option<String>,
    pub qr_svg: Option<String>,
    pub qr_url: Option<String>,
    pub bot_pairing_code: Option<String>,
    pub bot_link: Option<String>,
    pub pairing_state: PairingState,
}

/// Handle to a running bot (Telegram, Feishu, or Weixin).
struct BotHandle {
    stop_tx: tokio::sync::watch::Sender<bool>,
}

impl BotHandle {
    fn stop(&self) {
        let _ = self.stop_tx.send(true);
    }
}

/// Unified Remote Connect service that orchestrates all connection methods.
pub struct RemoteConnectService {
    config: RemoteConnectConfig,
    device_identity: DeviceIdentity,
    active_method: Arc<RwLock<Option<ConnectionMethod>>>,
    embedded_relay_host: Arc<dyn EmbeddedRelayHost>,
    relay_lifecycle: Arc<Mutex<()>>,
    // Bot handles live independently of relay connections
    bot_lifecycle: Arc<Mutex<()>>,
    bot_account_identity_epoch: Arc<AtomicU64>,
    bot_account_user_id: RwLock<Option<String>>,
    bot_telegram_slot: Arc<bot::BotSlotFence>,
    bot_feishu_slot: Arc<bot::BotSlotFence>,
    bot_weixin_slot: Arc<bot::BotSlotFence>,
    bot_telegram_handle: Arc<RwLock<Option<BotHandle>>>,
    bot_feishu_handle: Arc<RwLock<Option<BotHandle>>>,
    bot_weixin_handle: Arc<RwLock<Option<BotHandle>>>,
    // Keep Arc references to bots for send_message etc.
    telegram_bot: Arc<RwLock<Option<Arc<bot::telegram::TelegramBot>>>>,
    feishu_bot: Arc<RwLock<Option<Arc<bot::feishu::FeishuBot>>>>,
    weixin_bot: Arc<RwLock<Option<Arc<bot::weixin::WeixinBot>>>>,
    /// Independent bot connection state.
    /// Stores the peer description (e.g. "Telegram(7096812005)") when a bot is active.
    bot_connected_info: Arc<RwLock<Option<String>>>,
    /// The single account-authenticated transport for every Relay endpoint.
    device_relay_client: Arc<RwLock<Option<Arc<RelayClient>>>>,
    host_stream_hub: Arc<RwLock<Option<Arc<host_stream::HostStreamHub>>>>,
    device_relay_lifecycle: Arc<Mutex<()>>,
    device_connection_generation: AtomicU64,
    active_device_connection_id: Arc<RwLock<Option<u64>>>,
    authenticated_device_id: Arc<RwLock<Option<String>>>,
    device_relay_url: Arc<RwLock<Option<String>>>,
    prepared_relay_url: Arc<RwLock<Option<String>>>,
    /// Latest online-device presence for the account (P2).
    online_devices: Arc<RwLock<Vec<relay_client::DevicePresenceEntry>>>,
}

impl RemoteConnectService {
    pub fn new(
        config: RemoteConnectConfig,
        embedded_relay_host: Arc<dyn EmbeddedRelayHost>,
    ) -> Result<Self> {
        let device_identity = DeviceIdentity::from_current_machine()?;

        Ok(Self {
            config,
            device_identity,
            active_method: Arc::new(RwLock::new(None)),
            embedded_relay_host,
            relay_lifecycle: Arc::new(Mutex::new(())),
            bot_lifecycle: Arc::new(Mutex::new(())),
            bot_account_identity_epoch: Arc::new(AtomicU64::new(0)),
            bot_account_user_id: RwLock::new(None),
            bot_telegram_slot: Arc::new(bot::BotSlotFence::default()),
            bot_feishu_slot: Arc::new(bot::BotSlotFence::default()),
            bot_weixin_slot: Arc::new(bot::BotSlotFence::default()),
            bot_telegram_handle: Arc::new(RwLock::new(None)),
            bot_feishu_handle: Arc::new(RwLock::new(None)),
            bot_weixin_handle: Arc::new(RwLock::new(None)),
            telegram_bot: Arc::new(RwLock::new(None)),
            feishu_bot: Arc::new(RwLock::new(None)),
            weixin_bot: Arc::new(RwLock::new(None)),
            bot_connected_info: Arc::new(RwLock::new(None)),
            device_relay_client: Arc::new(RwLock::new(None)),
            host_stream_hub: Arc::new(RwLock::new(None)),
            device_relay_lifecycle: Arc::new(Mutex::new(())),
            device_connection_generation: AtomicU64::new(0),
            active_device_connection_id: Arc::new(RwLock::new(None)),
            authenticated_device_id: Arc::new(RwLock::new(None)),
            device_relay_url: Arc::new(RwLock::new(None)),
            prepared_relay_url: Arc::new(RwLock::new(None)),
            online_devices: Arc::new(RwLock::new(Vec::new())),
        })
    }

    /// Account identity is supplied only by the authenticated host adapter.
    /// Replacing or removing it retires every IM channel before new work starts.
    pub async fn set_bot_account(&self, user_id: Option<String>) {
        let _lifecycle = self.bot_lifecycle.lock().await;
        if *self.bot_account_user_id.read().await == user_id {
            return;
        }
        self.bot_account_identity_epoch
            .fetch_add(1, Ordering::AcqRel);
        self.stop_bots_inner().await;
        *self.bot_account_user_id.write().await = user_id;
    }

    pub async fn clear_bot_delegated_identities(&self) {
        self.set_bot_account(None).await;
        openbitfun_services_integrations::remote_connect::bot::clear_persisted_bot_account_contexts(
        );
    }

    pub fn device_identity(&self) -> &DeviceIdentity {
        &self.device_identity
    }

    pub fn update_bot_config(&mut self, bot_config: bot::BotConfig) {
        match bot_config {
            bot::BotConfig::Feishu { app_id, app_secret } => {
                self.config.bot_feishu = Some(bot::BotConfig::Feishu { app_id, app_secret });
            }
            bot::BotConfig::Telegram { bot_token } => {
                self.config.bot_telegram = Some(bot::BotConfig::Telegram { bot_token });
            }
            bot::BotConfig::Weixin {
                ilink_token,
                base_url,
                bot_account_id,
            } => {
                self.config.bot_weixin = Some(bot::BotConfig::Weixin {
                    ilink_token,
                    base_url,
                    bot_account_id,
                });
            }
        }
    }

    pub async fn available_methods(&self) -> Vec<ConnectionMethod> {
        vec![
            ConnectionMethod::Lan { ip: None },
            ConnectionMethod::OpenBitFunServer,
            ConnectionMethod::BotFeishu,
            ConnectionMethod::BotTelegram,
            ConnectionMethod::BotWeixin,
        ]
    }

    /// Resolve the endpoint and start the local host only for LAN. Every
    /// endpoint subsequently uses account login and the same device transport.
    pub async fn prepare_relay(&self, method: &ConnectionMethod) -> Result<String> {
        let _lifecycle = self.relay_lifecycle.lock().await;
        if self.active_method.read().await.as_ref() == Some(method) {
            if let Some(url) = self.prepared_relay_url.read().await.clone() {
                return Ok(url);
            }
        }
        let url = match method {
            ConnectionMethod::Lan { ip } => match ip {
                Some(ip) => lan::build_lan_relay_url_with_ip(self.config.lan_port, ip)?,
                None => lan::build_lan_relay_url(self.config.lan_port)?,
            },
            ConnectionMethod::OpenBitFunServer => self.config.openbitfun_server_url.clone(),
            _ => anyhow::bail!("connection method does not use a relay"),
        };
        self.stop_relay_inner().await;
        if matches!(method, ConnectionMethod::Lan { .. }) {
            if let Err(error) = self
                .embedded_relay_host
                .start(self.config.lan_port, self.config.mobile_web_dir.clone())
                .await
            {
                self.embedded_relay_host.stop().await;
                return Err(error);
            }
        }
        *self.prepared_relay_url.write().await = Some(url.clone());
        *self.active_method.write().await = Some(method.clone());
        Ok(url)
    }

    /// Build an invitation for the authenticated route. URL selection is the
    /// only difference between official and locally hosted Relay connections.
    pub async fn start(&self, method: ConnectionMethod) -> Result<ConnectionResult> {
        if matches!(
            method,
            ConnectionMethod::BotFeishu
                | ConnectionMethod::BotTelegram
                | ConnectionMethod::BotWeixin
        ) {
            return self.start_bot_connection(&method).await;
        }
        let _lifecycle = self.device_relay_lifecycle.lock().await;
        let device_id = self
            .authenticated_device_id
            .read()
            .await
            .clone()
            .ok_or_else(|| {
                anyhow::anyhow!(
                    "Sign in with GitHub and connect this device before creating an invitation"
                )
            })?;
        let relay_url = self
            .device_relay_url
            .read()
            .await
            .clone()
            .ok_or_else(|| anyhow::anyhow!("No authenticated relay connection"))?;
        if self.prepared_relay_url.read().await.as_deref() != Some(relay_url.as_str())
            || self.active_method.read().await.as_ref() != Some(&method)
        {
            anyhow::bail!("Relay endpoint changed; start the connection again");
        }
        let qr_url = QrGenerator::build_device_url(&relay_url, &device_id)?;
        Ok(ConnectionResult {
            method,
            qr_data: Some(QrGenerator::generate_png_base64_from_url(&qr_url)?),
            qr_svg: Some(QrGenerator::generate_svg_from_url(&qr_url)?),
            qr_url: Some(qr_url),
            bot_pairing_code: None,
            bot_link: None,
            pairing_state: PairingState::WaitingForScan,
        })
    }

    async fn start_bot_connection(&self, method: &ConnectionMethod) -> Result<ConnectionResult> {
        let _lifecycle = self.bot_lifecycle.lock().await;
        let account_user_id = self
            .bot_account_user_id
            .read()
            .await
            .clone()
            .ok_or_else(|| anyhow::anyhow!("Sign in with GitHub before connecting a bot"))?;
        let pairing_code = pairing::generate_bot_pairing_code();

        let bot_link = match method {
            ConnectionMethod::BotTelegram => {
                match &self.config.bot_telegram {
                    Some(bot::BotConfig::Telegram { bot_token }) if !bot_token.is_empty() => {
                        // Stop any existing Telegram bot
                        let generation = self.bot_telegram_slot.advance();
                        if let Some(handle) = self.bot_telegram_handle.write().await.take() {
                            handle.stop();
                        }

                        let tg_bot = Arc::new(bot::telegram::TelegramBot::new_fenced(
                            bot::telegram::TelegramConfig {
                                bot_token: bot_token.clone(),
                            },
                            bot::BotRuntimeFence::new(
                                self.bot_account_identity_epoch.clone(),
                                self.bot_telegram_slot.clone(),
                                generation,
                            )
                            .with_account(account_user_id.clone()),
                        ));
                        tg_bot.register_pairing(&pairing_code).await?;

                        let (stop_tx, stop_rx) = tokio::sync::watch::channel(false);

                        let bot_connected_info = self.bot_connected_info.clone();
                        let bot_for_pair = tg_bot.clone();
                        let bot_for_loop = tg_bot.clone();
                        let tg_bot_ref = self.telegram_bot.clone();
                        let bot_lifecycle = self.bot_lifecycle.clone();
                        let bot_slot = self.bot_telegram_slot.clone();

                        *tg_bot_ref.write().await = Some(tg_bot.clone());

                        tokio::spawn(async move {
                            let mut stop_rx = stop_rx;
                            match bot_for_pair.wait_for_pairing(&mut stop_rx).await {
                                Ok(chat_id) => {
                                    let lifecycle = bot_lifecycle.lock().await;
                                    // Guard against the race where stop_bots() cleared
                                    // bot_connected_info between pairing completing and
                                    // this task running.
                                    if !*stop_rx.borrow() && bot_slot.is_current(generation) {
                                        *bot_connected_info.write().await =
                                            Some(format!("Telegram({chat_id})"));
                                        drop(lifecycle);
                                        info!("Telegram bot paired, starting message loop");
                                        bot_for_loop.run_message_loop(stop_rx).await;
                                    } else {
                                        info!("Telegram pairing completed but bot was stopped; discarding");
                                    }
                                }
                                Err(e) => {
                                    info!("Telegram pairing ended: {e}");
                                }
                            }
                        });

                        *self.bot_telegram_handle.write().await = Some(BotHandle { stop_tx });

                        "https://t.me/BotFather".to_string()
                    }
                    _ => {
                        return Err(anyhow::anyhow!(
                            "Telegram bot token not configured. Please set bot token first."
                        ));
                    }
                }
            }
            ConnectionMethod::BotFeishu => {
                match &self.config.bot_feishu {
                    Some(bot::BotConfig::Feishu { app_id, app_secret })
                        if !app_id.is_empty() && !app_secret.is_empty() =>
                    {
                        let generation = self.bot_feishu_slot.advance();
                        if let Some(handle) = self.bot_feishu_handle.write().await.take() {
                            handle.stop();
                        }

                        let fs_bot = Arc::new(bot::feishu::FeishuBot::new_fenced(
                            bot::feishu::FeishuConfig {
                                app_id: app_id.clone(),
                                app_secret: app_secret.clone(),
                            },
                            bot::BotRuntimeFence::new(
                                self.bot_account_identity_epoch.clone(),
                                self.bot_feishu_slot.clone(),
                                generation,
                            )
                            .with_account(account_user_id.clone()),
                        ));
                        fs_bot.register_pairing(&pairing_code).await?;

                        let (stop_tx, stop_rx) = tokio::sync::watch::channel(false);

                        let bot_connected_info = self.bot_connected_info.clone();
                        let bot_for_pair = fs_bot.clone();
                        let bot_for_loop = fs_bot.clone();
                        let fs_bot_ref = self.feishu_bot.clone();
                        let bot_lifecycle = self.bot_lifecycle.clone();
                        let bot_slot = self.bot_feishu_slot.clone();

                        *fs_bot_ref.write().await = Some(fs_bot.clone());

                        tokio::spawn(async move {
                            let mut stop_rx = stop_rx;
                            match bot_for_pair.wait_for_pairing(&mut stop_rx).await {
                                Ok(chat_id) => {
                                    let lifecycle = bot_lifecycle.lock().await;
                                    // Guard against the race where stop_bots() cleared
                                    // bot_connected_info between pairing completing and
                                    // this task running.
                                    if !*stop_rx.borrow() && bot_slot.is_current(generation) {
                                        *bot_connected_info.write().await =
                                            Some(format!("Feishu({chat_id})"));
                                        drop(lifecycle);
                                        info!("Feishu bot paired, starting message loop");
                                        bot_for_loop.run_message_loop(stop_rx).await;
                                    } else {
                                        info!("Feishu pairing completed but bot was stopped; discarding");
                                    }
                                }
                                Err(e) => {
                                    info!("Feishu pairing ended: {e}");
                                }
                            }
                        });

                        *self.bot_feishu_handle.write().await = Some(BotHandle { stop_tx });

                        "https://open.feishu.cn/app".to_string()
                    }
                    _ => {
                        return Err(anyhow::anyhow!(
                            "Feishu bot credentials not configured. \
                             Please set App ID and App Secret first."
                        ));
                    }
                }
            }
            ConnectionMethod::BotWeixin => {
                match &self.config.bot_weixin {
                    Some(bot::BotConfig::Weixin {
                        ilink_token,
                        base_url,
                        bot_account_id,
                    }) if !ilink_token.is_empty() && !bot_account_id.is_empty() => {
                        let generation = self.bot_weixin_slot.advance();
                        if let Some(handle) = self.bot_weixin_handle.write().await.take() {
                            handle.stop();
                        }
                        if let Some(previous_bot) = self.weixin_bot.write().await.take() {
                            if let Err(err) = previous_bot.notify_stop().await {
                                warn!("Weixin notify-stop failed during replacement: {err}");
                            }
                        }

                        let wx_cfg = bot::weixin::WeixinConfig {
                            ilink_token: ilink_token.clone(),
                            base_url: if base_url.trim().is_empty() {
                                "https://ilinkai.weixin.qq.com".to_string()
                            } else {
                                base_url.clone()
                            },
                            bot_account_id: bot_account_id.clone(),
                        };

                        let wx_bot = Arc::new(bot::weixin::WeixinBot::new_fenced(
                            wx_cfg,
                            bot::BotRuntimeFence::new(
                                self.bot_account_identity_epoch.clone(),
                                self.bot_weixin_slot.clone(),
                                generation,
                            )
                            .with_account(account_user_id.clone()),
                        ));
                        wx_bot.register_pairing(&pairing_code).await?;

                        let (stop_tx, stop_rx) = tokio::sync::watch::channel(false);

                        let bot_connected_info = self.bot_connected_info.clone();
                        let bot_for_pair = wx_bot.clone();
                        let bot_for_loop = wx_bot.clone();
                        let wx_bot_ref = self.weixin_bot.clone();
                        let bot_lifecycle = self.bot_lifecycle.clone();
                        let bot_slot = self.bot_weixin_slot.clone();

                        *wx_bot_ref.write().await = Some(wx_bot.clone());

                        tokio::spawn(async move {
                            if let Err(err) = bot_for_pair.notify_start().await {
                                warn!("Weixin notify-start failed; continuing: {err}");
                            }
                            let mut stop_rx = stop_rx;
                            match bot_for_pair.wait_for_pairing(&mut stop_rx).await {
                                Ok(peer_id) => {
                                    let lifecycle = bot_lifecycle.lock().await;
                                    if !*stop_rx.borrow() && bot_slot.is_current(generation) {
                                        *bot_connected_info.write().await =
                                            Some(format!("Weixin({peer_id})"));
                                        drop(lifecycle);
                                        info!("Weixin bot paired, starting message loop");
                                        bot_for_loop.run_message_loop(stop_rx).await;
                                    } else {
                                        info!("Weixin pairing completed but bot was stopped; discarding");
                                    }
                                }
                                Err(e) => {
                                    info!("Weixin pairing ended: {e}");
                                }
                            }
                            if bot_slot.is_current(generation) {
                                if let Err(err) = bot_for_pair.notify_stop().await {
                                    warn!("Weixin notify-stop failed: {err}");
                                }
                            }
                        });

                        *self.bot_weixin_handle.write().await = Some(BotHandle { stop_tx });

                        "https://www.wechat.com".to_string()
                    }
                    _ => {
                        return Err(anyhow::anyhow!(
                            "Weixin not linked. Complete WeChat QR login in Remote Connect first."
                        ));
                    }
                }
            }
            _ => {
                return Err(anyhow::anyhow!(
                    "start_bot_connection: unsupported method {method:?}"
                ));
            }
        };

        Ok(ConnectionResult {
            method: method.clone(),
            qr_data: None,
            qr_svg: None,
            qr_url: None,
            bot_pairing_code: Some(pairing_code),
            bot_link: Some(bot_link),
            pairing_state: PairingState::WaitingForScan,
        })
    }

    /// Restore a previously paired bot from persistence.
    /// Skips the pairing step and directly starts the message loop.
    pub async fn restore_bot(&self, saved: &bot::SavedBotConnection) -> Result<()> {
        let _lifecycle = self.bot_lifecycle.lock().await;
        let account_user_id = self
            .bot_account_user_id
            .read()
            .await
            .clone()
            .ok_or_else(|| anyhow::anyhow!("Sign in with GitHub before restoring a bot"))?;
        if saved.account_user_id.is_empty() || saved.account_user_id != account_user_id {
            anyhow::bail!("Saved bot belongs to a different account or requires pairing again");
        }
        match saved.config {
            bot::BotConfig::Telegram { ref bot_token } => {
                let generation = self.bot_telegram_slot.advance();
                if let Some(handle) = self.bot_telegram_handle.write().await.take() {
                    handle.stop();
                }

                let tg_bot = Arc::new(bot::telegram::TelegramBot::new_fenced(
                    bot::telegram::TelegramConfig {
                        bot_token: bot_token.clone(),
                    },
                    bot::BotRuntimeFence::new(
                        self.bot_account_identity_epoch.clone(),
                        self.bot_telegram_slot.clone(),
                        generation,
                    )
                    .with_account(account_user_id.clone()),
                ));

                let chat_id: i64 = saved.chat_id.parse().map_err(|_| {
                    anyhow::anyhow!("invalid saved telegram chat_id: {}", saved.chat_id)
                })?;
                tg_bot
                    .restore_chat_state(chat_id, saved.chat_state.clone())
                    .await;

                let (stop_tx, stop_rx) = tokio::sync::watch::channel(false);
                *self.telegram_bot.write().await = Some(tg_bot.clone());
                *self.bot_connected_info.write().await = Some(format!("Telegram({chat_id})"));

                let bot_for_loop = tg_bot.clone();
                tokio::spawn(async move {
                    info!("Telegram bot restored from persistence, starting message loop");
                    bot_for_loop.run_message_loop(stop_rx).await;
                });

                *self.bot_telegram_handle.write().await = Some(BotHandle { stop_tx });
                info!("Telegram bot restored for chat_id={chat_id}");
            }
            bot::BotConfig::Feishu {
                ref app_id,
                ref app_secret,
            } => {
                let generation = self.bot_feishu_slot.advance();
                if let Some(handle) = self.bot_feishu_handle.write().await.take() {
                    handle.stop();
                }

                let fs_bot = Arc::new(bot::feishu::FeishuBot::new_fenced(
                    bot::feishu::FeishuConfig {
                        app_id: app_id.clone(),
                        app_secret: app_secret.clone(),
                    },
                    bot::BotRuntimeFence::new(
                        self.bot_account_identity_epoch.clone(),
                        self.bot_feishu_slot.clone(),
                        generation,
                    )
                    .with_account(account_user_id.clone()),
                ));

                fs_bot
                    .restore_chat_state(&saved.chat_id, saved.chat_state.clone())
                    .await;

                let (stop_tx, stop_rx) = tokio::sync::watch::channel(false);
                *self.feishu_bot.write().await = Some(fs_bot.clone());

                let cid = saved.chat_id.clone();
                *self.bot_connected_info.write().await = Some(format!("Feishu({cid})"));

                let bot_for_loop = fs_bot.clone();
                tokio::spawn(async move {
                    info!("Feishu bot restored from persistence, starting message loop");
                    bot_for_loop.run_message_loop(stop_rx).await;
                });

                *self.bot_feishu_handle.write().await = Some(BotHandle { stop_tx });
                info!("Feishu bot restored for chat_id={}", saved.chat_id);
            }
            bot::BotConfig::Weixin {
                ref ilink_token,
                ref base_url,
                ref bot_account_id,
            } => {
                let generation = self.bot_weixin_slot.advance();
                if let Some(handle) = self.bot_weixin_handle.write().await.take() {
                    handle.stop();
                }
                if let Some(previous_bot) = self.weixin_bot.write().await.take() {
                    if let Err(err) = previous_bot.notify_stop().await {
                        warn!("Weixin notify-stop failed during restore replacement: {err}");
                    }
                }

                let wx_cfg = bot::weixin::WeixinConfig {
                    ilink_token: ilink_token.clone(),
                    base_url: if base_url.trim().is_empty() {
                        "https://ilinkai.weixin.qq.com".to_string()
                    } else {
                        base_url.clone()
                    },
                    bot_account_id: bot_account_id.clone(),
                };

                let wx_bot = Arc::new(bot::weixin::WeixinBot::new_fenced(
                    wx_cfg,
                    bot::BotRuntimeFence::new(
                        self.bot_account_identity_epoch.clone(),
                        self.bot_weixin_slot.clone(),
                        generation,
                    )
                    .with_account(account_user_id.clone()),
                ));
                wx_bot
                    .restore_chat_state(&saved.chat_id, saved.chat_state.clone())
                    .await;

                let (stop_tx, stop_rx) = tokio::sync::watch::channel(false);
                *self.weixin_bot.write().await = Some(wx_bot.clone());

                let cid = saved.chat_id.clone();
                *self.bot_connected_info.write().await = Some(format!("Weixin({cid})"));

                let bot_for_loop = wx_bot.clone();
                let bot_for_notify = wx_bot.clone();
                let bot_slot = self.bot_weixin_slot.clone();
                tokio::spawn(async move {
                    if let Err(err) = bot_for_notify.notify_start().await {
                        warn!("Weixin notify-start failed during restore; continuing: {err}");
                    }
                    info!("Weixin bot restored from persistence, starting message loop");
                    bot_for_loop.run_message_loop(stop_rx).await;
                    if bot_slot.is_current(generation) {
                        if let Err(err) = bot_for_notify.notify_stop().await {
                            warn!("Weixin notify-stop failed after restored loop: {err}");
                        }
                    }
                });

                *self.bot_weixin_handle.write().await = Some(BotHandle { stop_tx });
                info!("Weixin bot restored for chat_id={}", saved.chat_id);
            }
        }
        Ok(())
    }

    pub async fn pairing_state(&self) -> PairingState {
        if self.is_device_connected().await {
            PairingState::Connected
        } else {
            PairingState::Idle
        }
    }

    /// Stop Relay routing and its local host; bots retain their own lifecycle.
    pub async fn stop_relay(&self) {
        let _lifecycle = self.relay_lifecycle.lock().await;
        self.stop_relay_inner().await;
    }

    async fn stop_relay_inner(&self) {
        self.stop_device_connection().await;
        *self.active_method.write().await = None;
        *self.prepared_relay_url.write().await = None;
        self.embedded_relay_host.stop().await;
    }

    /// Stop all bot connections.
    pub async fn stop_bots(&self) {
        let _lifecycle = self.bot_lifecycle.lock().await;
        self.stop_bots_inner().await;
    }

    async fn stop_bots_inner(&self) {
        self.bot_telegram_slot.advance();
        if let Some(handle) = self.bot_telegram_handle.write().await.take() {
            handle.stop();
        }
        *self.telegram_bot.write().await = None;

        self.bot_feishu_slot.advance();
        if let Some(handle) = self.bot_feishu_handle.write().await.take() {
            handle.stop();
        }
        *self.feishu_bot.write().await = None;

        self.bot_weixin_slot.advance();
        if let Some(handle) = self.bot_weixin_handle.write().await.take() {
            handle.stop();
        }
        if let Some(weixin_bot) = self.weixin_bot.write().await.take() {
            if let Err(err) = weixin_bot.notify_stop().await {
                warn!("Weixin notify-stop failed during bot shutdown: {err}");
            }
        }
        *self.bot_connected_info.write().await = None;

        info!("Bot connections stopped");
    }

    /// Legacy `stop()` — only stops relay for backward compatibility.
    /// Bot connections persist independently.
    pub async fn stop(&self) {
        self.stop_relay().await;
    }

    /// Stop everything (relay + bots).
    pub async fn stop_all(&self) {
        self.stop_relay().await;
        self.stop_bots().await;
    }

    pub async fn is_connected(&self) -> bool {
        self.is_device_connected().await
    }

    pub async fn active_method(&self) -> Option<ConnectionMethod> {
        self.active_method.read().await.clone()
    }

    /// Check whether a specific bot type is currently running.
    pub async fn is_bot_running(&self, bot_type: &str) -> bool {
        match bot_type {
            "telegram" => self.bot_telegram_handle.read().await.is_some(),
            "feishu" => self.bot_feishu_handle.read().await.is_some(),
            "weixin" => self.bot_weixin_handle.read().await.is_some(),
            _ => false,
        }
    }

    pub async fn bot_connected_info(&self) -> Option<String> {
        self.bot_connected_info.read().await.clone()
    }

    // ── P2: Account-authenticated device routing ───────────────────────────

    /// Connect to the relay's WS endpoint and authenticate with an account
    /// token. Incoming device messages are
    /// forwarded via the returned event receiver.
    ///
    /// The caller (desktop Tauri layer) owns the AccountSession containing the
    /// master_key and is responsible for decrypting device-message payloads.
    /// Returns true if a device-routing WebSocket connection is currently
    /// active (i.e. `start_device_connection` has been called and not yet
    /// disconnected).
    pub async fn is_device_connected(&self) -> bool {
        let client = self.device_relay_client.read().await.clone();
        let Some(client) = client else {
            return false;
        };
        matches!(
            client.connection_state().await,
            relay_client::ConnectionState::Connected | relay_client::ConnectionState::Reconnecting
        )
    }

    pub async fn device_relay_url(&self) -> Option<String> {
        self.device_relay_url.read().await.clone()
    }

    /// Start account device routing. Returns
    /// `(event_rx, authenticated_device_id, connection_id)`.
    ///
    /// `AuthOk` is consumed here (not forwarded) so callers must use the returned
    /// `authenticated_device_id` — and this method adopts it into the persisted
    /// local `DeviceIdentity` before returning.
    ///
    /// `notifier` delivers host stream hints to subscribed controllers; the host
    /// adapter owns pairwise encryption and the routing lease, so it supplies it.
    pub async fn start_device_connection(
        &self,
        relay_url: &str,
        token: &str,
        device_name: &str,
        notifier: Arc<dyn host_stream::HostStreamNotifier>,
    ) -> Result<(
        tokio::sync::mpsc::Receiver<relay_client::RelayEvent>,
        String,
        u64,
    )> {
        let _lifecycle = self.device_relay_lifecycle.lock().await;
        // Disconnect previous device connection if any.
        self.stop_device_connection_inner().await;

        let (client, mut event_rx) = RelayClient::new();
        client.connect(relay_url).await?;
        client.connect_authenticated(token, device_name).await?;

        // Wait for AuthOk (or AuthError) before proceeding so that the
        // device is registered as online on the relay before the caller
        // gets back control.  This prevents an immediate device-list
        // query from seeing the local device as offline.
        //
        // The relay client may emit other events first (e.g. `Connected`),
        // so we loop until we see AuthOk/AuthError or time out.
        let deadline = tokio::time::Instant::now() + std::time::Duration::from_secs(10);
        let mut authenticated_device_id: Option<String> = None;
        let mut auth_error: Option<String> = None;
        while authenticated_device_id.is_none() && auth_error.is_none() {
            match tokio::time::timeout_at(deadline, event_rx.recv()).await {
                Ok(Some(relay_client::RelayEvent::AuthOk { user_id, device_id })) => {
                    log::info!("Device connection auth ok: user={user_id} device={device_id}");
                    // AuthOk is consumed here and never forwarded. Adopt immediately
                    // so getDeviceInfo / 本机 marking match the token-bound device.
                    if let Err(e) = DeviceIdentity::adopt_account_device_id(&device_id) {
                        log::warn!("Failed to adopt AuthOk device_id: {e}");
                    }
                    let hub = start_host_stream_hub(notifier.clone());
                    if let Some(previous) = self.host_stream_hub.write().await.replace(hub) {
                        previous.close();
                    }
                    authenticated_device_id = Some(device_id);
                }
                Ok(Some(relay_client::RelayEvent::AuthError { message })) => {
                    auth_error = Some(message);
                }
                Ok(Some(other)) => {
                    // Non-auth event (e.g. Connected) — skip and keep waiting.
                    log::debug!(
                        "Skipping non-auth relay event while waiting for AuthOk: {other:?}"
                    );
                }
                Ok(None) => {
                    anyhow::bail!("relay connection closed before auth response");
                }
                Err(_) => {
                    anyhow::bail!("timeout waiting for relay auth response");
                }
            }
        }
        if let Some(msg) = auth_error {
            anyhow::bail!("relay auth error: {msg}");
        }
        let authenticated_device_id = authenticated_device_id
            .ok_or_else(|| anyhow::anyhow!("relay auth completed without device_id"))?;

        let online_arc = self.online_devices.clone();
        let device_client_arc = self.device_relay_client.clone();
        let device_lifecycle = self.device_relay_lifecycle.clone();
        let active_connection_id = self.active_device_connection_id.clone();
        let connection_id = self
            .device_connection_generation
            .fetch_add(1, Ordering::AcqRel)
            + 1;
        *device_client_arc.write().await = Some(Arc::new(client));
        *active_connection_id.write().await = Some(connection_id);
        *self.authenticated_device_id.write().await = Some(authenticated_device_id.clone());
        *self.device_relay_url.write().await = Some(relay_url.to_string());
        let authenticated_id = self.authenticated_device_id.clone();
        // Spawn event forwarder that updates presence state; the raw event stream
        // is also forwarded to a new channel for the caller to consume.
        let (forward_tx, forward_rx) = tokio::sync::mpsc::channel(128);
        tokio::spawn(async move {
            while let Some(event) = event_rx.recv().await {
                let _effect = device_lifecycle.lock().await;
                if *active_connection_id.read().await != Some(connection_id) {
                    break;
                }
                match &event {
                    relay_client::RelayEvent::DevicePresence { devices } => {
                        *online_arc.write().await = devices.clone();
                    }
                    relay_client::RelayEvent::Disconnected => {
                        *online_arc.write().await = Vec::new();
                    }
                    _ => {}
                }
                if forward_tx.try_send(event).is_err() {
                    break;
                }
            }
            let _effect = device_lifecycle.lock().await;
            let mut active = active_connection_id.write().await;
            if *active == Some(connection_id) {
                *active = None;
                drop(active);
                *device_client_arc.write().await = None;
                *authenticated_id.write().await = None;
                online_arc.write().await.clear();
            }
        });

        Ok((forward_rx, authenticated_device_id, connection_id))
    }

    /// Disconnect the account-authenticated device-routing connection.
    pub async fn stop_device_connection(&self) {
        let _lifecycle = self.device_relay_lifecycle.lock().await;
        self.stop_device_connection_inner().await;
    }

    /// Host streams served to controllers while device routing is alive.
    pub async fn host_stream_hub(&self) -> Option<Arc<host_stream::HostStreamHub>> {
        self.host_stream_hub.read().await.clone()
    }

    async fn stop_device_connection_inner(&self) {
        if let Some(hub) = self.host_stream_hub.write().await.take() {
            hub.close();
        }
        *self.authenticated_device_id.write().await = None;
        *self.device_relay_url.write().await = None;
        *self.active_device_connection_id.write().await = None;
        let client = self.device_relay_client.write().await.take();
        if let Some(client) = client {
            client.disconnect().await;
        }
        self.online_devices.write().await.clear();
    }

    /// Send an encrypted device-to-device message via the account relay.
    pub async fn send_device_message(
        &self,
        target_device_id: &str,
        correlation_id: &str,
        encrypted_data: &str,
        nonce: &str,
    ) -> Result<()> {
        let client = self
            .device_relay_client
            .read()
            .await
            .clone()
            .ok_or_else(|| anyhow::anyhow!("device routing not connected"))?;
        client
            .send_device_message(target_device_id, correlation_id, encrypted_data, nonce)
            .await
    }

    /// Send through the exact device-routing client captured by the caller.
    /// Capture the transport under the lifecycle lease, then release that
    /// lease before awaiting IO. Replacement disconnects the captured epoch;
    /// a slow acknowledgement must not block logout or presence delivery.
    pub async fn send_device_message_if_connection(
        &self,
        expected_connection_id: u64,
        target_device_id: &str,
        correlation_id: &str,
        encrypted_data: &str,
        nonce: &str,
    ) -> Result<bool> {
        let _lifecycle = self.device_relay_lifecycle.lock().await;
        if *self.active_device_connection_id.read().await != Some(expected_connection_id) {
            return Ok(false);
        }
        let client = self
            .device_relay_client
            .read()
            .await
            .clone()
            .ok_or_else(|| anyhow::anyhow!("device routing not connected"))?;
        drop(_lifecycle);
        client
            .send_device_message(target_device_id, correlation_id, encrypted_data, nonce)
            .await?;
        Ok(true)
    }

    /// Current online devices in the account (presence list).
    pub async fn online_devices(&self) -> Vec<relay_client::DevicePresenceEntry> {
        self.online_devices.read().await.clone()
    }
}

#[cfg(test)]
mod host_lifecycle_tests;
#[cfg(test)]
mod host_stream_command_tests;

/// Create the account-scoped host stream owner and bridge runtime invalidation
/// sources into it. Streams hold no offline history: they are materialized by a
/// controller's first read and dropped once nobody reads them.
pub fn start_host_stream_hub(
    notifier: Arc<dyn host_stream::HostStreamNotifier>,
) -> Arc<host_stream::HostStreamHub> {
    let hub = host_stream::HostStreamHub::start(notifier);
    start_session_interaction_publication(&hub);
    hub
}

/// Answer the host-stream commands of one controller. `None` means the command
/// is not a host stream command and belongs to the regular dispatcher.
pub async fn handle_host_stream_command(
    hub: Option<&Arc<host_stream::HostStreamHub>>,
    source_device_id: &str,
    command: &remote_server::RemoteCommand,
) -> Option<remote_server::RemoteResponse> {
    use remote_server::{RemoteCommand, RemoteResponse};
    match command {
        RemoteCommand::GetSessionKey { .. } => Some(RemoteResponse::Error {
            message: host_stream::RELAY_SESSION_HISTORY_RETIRED_MESSAGE.to_string(),
        }),
        RemoteCommand::ReadStream { request } => {
            let Some(hub) = hub else {
                return Some(RemoteResponse::Error {
                    message: "Host streams are unavailable while device routing is offline"
                        .to_string(),
                });
            };
            if is_session_stream(&request.stream_id) && hub.needs_full_synchronization(request) {
                // A fresh subscriber, or one whose epoch the host no longer holds,
                // needs the runtime's stable records before its first page.
                hub.activate(&request.stream_id);
                if let Err(error) = synchronize_session_records(hub, &request.stream_id).await {
                    return Some(RemoteResponse::Error { message: error });
                }
            }
            Some(match hub.read(source_device_id, request) {
                Ok(page) => RemoteResponse::StreamPage { page },
                Err(error) => RemoteResponse::Error {
                    message: error.to_string(),
                },
            })
        }
        RemoteCommand::UnsubscribeStream { stream_id } => {
            if let Some(hub) = hub {
                hub.unsubscribe(source_device_id, stream_id);
            }
            Some(RemoteResponse::StreamUnsubscribed {
                stream_id: stream_id.clone(),
            })
        }
        _ => None,
    }
}

/// Session streams are keyed by session id; catalog and terminal streams carry
/// their own prefixes and are fed by appends rather than record synchronization.
pub fn is_session_stream(stream_id: &str) -> bool {
    stream_id != host_stream::HOST_CATALOG_ID && !stream_id.starts_with("terminal-")
}

/// Publish the owning runtime's stable persisted session records.
pub async fn synchronize_session_records(
    hub: &host_stream::HostStreamHub,
    session_id: &str,
) -> Result<(), String> {
    crate::service_agent_runtime::CoreServiceAgentRuntime::synchronize_relay_session(
        hub, session_id, None,
    )
    .await
}

/// Publish only a dirty turn at a semantic message boundary.
pub async fn synchronize_session_record_turn(
    hub: &host_stream::HostStreamHub,
    session_id: &str,
    turn_id: &str,
) -> Result<(), String> {
    crate::service_agent_runtime::CoreServiceAgentRuntime::synchronize_relay_session(
        hub,
        session_id,
        Some(turn_id),
    )
    .await
}

/// Bridge the runtime-owned question mailbox to the host streams. Only revisions
/// travel here; controllers read the authoritative live mailbox on invalidation.
pub fn start_session_interaction_publication(hub: &Arc<host_stream::HostStreamHub>) {
    permission_publication::start(hub);
    #[cfg(feature = "workspace-runtime")]
    start_host_catalog_publication(hub);
    let mut closed = hub.subscribe_closed();
    let weak = Arc::downgrade(hub);
    let manager = crate::agentic::tools::user_input_manager::get_user_input_manager();
    let mut changes = manager.subscribe_changes();
    tokio::spawn(async move {
        let mut previous = std::collections::HashSet::<String>::new();
        loop {
            if *closed.borrow() {
                break;
            }
            let revision = *changes.borrow_and_update();
            let current: std::collections::HashSet<_> =
                manager.pending_question_counts().into_keys().collect();
            let sessions: std::collections::HashSet<_> =
                previous.union(&current).cloned().collect();
            let Some(hub) = weak.upgrade() else {
                break;
            };
            let events = sessions.into_iter().map(|session_id| {
                (session_id.clone(), "session-interaction-changed".to_string(), serde_json::json!({"sessionId":session_id,"userQuestionsRevision":revision}))
            }).collect::<Vec<_>>();
            if !events.is_empty() {
                tokio::select! {
                    biased;
                    _ = closed.changed() => break,
                    result = hub.append_batch(events) => if let Err(error) = result {
                        log::error!("Unable to publish session interaction invalidation: {error}");
                    }
                }
            }
            drop(hub);
            previous = current;
            tokio::select! {
                biased;
                _ = closed.changed() => break,
                result = changes.changed() => if result.is_err() { break; }
            }
        }
    });
}

#[cfg(feature = "workspace-runtime")]
fn start_host_catalog_publication(hub: &Arc<host_stream::HostStreamHub>) {
    let mut closed = hub.subscribe_closed();
    let weak = Arc::downgrade(hub);
    let mut sessions = crate::service::session::SessionMetadataStore::subscribe_catalog_changes();
    let mut workspaces = crate::service::workspace::WorkspaceService::subscribe_catalog_changes();
    tokio::spawn(async move {
        loop {
            if *closed.borrow() {
                break;
            }
            // Coalesce metadata writes from one runtime operation; no periodic
            // reads or broadcasts occur while the catalog is unchanged.
            tokio::select! {
                biased;
                _ = closed.changed() => break,
                _ = tokio::time::sleep(std::time::Duration::from_millis(75)) => {}
            }
            let sessions_revision = *sessions.borrow_and_update();
            let workspaces_revision = *workspaces.borrow_and_update();
            let Some(hub) = weak.upgrade() else {
                break;
            };
            tokio::select! {
                biased;
                _ = closed.changed() => break,
                result = hub.append(host_stream::HOST_CATALOG_ID.into(), "host-catalog-changed".into(), serde_json::json!({"sessionsRevision":sessions_revision,"workspacesRevision":workspaces_revision})) => {
                    if let Err(error) = result { log::error!("Unable to publish host catalog invalidation: {error}"); }
                }
            }
            drop(hub);
            tokio::select! {
                biased;
                _ = closed.changed() => break,
                result = sessions.changed() => if result.is_err() { break; },
                result = workspaces.changed() => if result.is_err() { break; }
            }
        }
    });
}

/// Live session-list state is runtime-owned but not always a metadata write.
/// Only semantic lifecycle facts invalidate the catalog; output chunks do not.
pub fn notify_session_catalog_event(event: &openbitfun_events::AgenticEvent) {
    use openbitfun_events::AgenticEvent;
    if matches!(
        event,
        AgenticEvent::SessionCreated { .. }
            | AgenticEvent::SessionDeleted { .. }
            | AgenticEvent::SessionTitleGenerated { .. }
            | AgenticEvent::SessionStateChanged { .. }
            | AgenticEvent::DialogTurnStarted { .. }
            | AgenticEvent::DialogTurnCompleted { .. }
            | AgenticEvent::DialogTurnFailed { .. }
            | AgenticEvent::DialogTurnCancelled { .. }
    ) {
        crate::service::session::SessionMetadataStore::notify_catalog_changed();
    }
}
