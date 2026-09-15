//! Weixin iLink provider client for Remote Connect.
//!
//! This module owns iLink HTTP, QR login polling, CDN media encryption, typing
//! status, and provider message parsing. Product pairing, command routing, and
//! session execution stay in product assembly.

use aes::cipher::{BlockDecrypt, BlockEncrypt, KeyInit};
use aes::Aes128;
use anyhow::{anyhow, Context, Result};
use base64::{engine::general_purpose::STANDARD as B64, Engine as _};
use log::{debug, warn};
use rand::{Rng, RngCore};
use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
use std::collections::HashMap;
use std::path::PathBuf;
use std::sync::{Arc, Mutex, OnceLock};
use std::time::{Duration, Instant, SystemTime, UNIX_EPOCH};
use tokio::sync::RwLock;

const DEFAULT_BASE_URL: &str = "https://ilinkai.weixin.qq.com";
const DEFAULT_ILINK_BOT_TYPE: &str = "3";
// Wire compatibility baseline audited against @tencent-weixin/openclaw-weixin 2.4.8.
const CHANNEL_VERSION: &str = "2.4.8";
const ILINK_APP_ID: &str = "bot";
const ILINK_APP_CLIENT_VERSION: &str = "132104"; // 0x00020408
const BOT_AGENT: &str = concat!("OpenBitFun/", env!("CARGO_PKG_VERSION"));
const API_TIMEOUT_SECS: u64 = 20;
const QR_POLL_TIMEOUT_SECS: u64 = 35;
const QR_SESSION_TTL_MS: i64 = 5 * 60_000;
pub const WEIXIN_SESSION_EXPIRED_ERRCODE: i64 = -14;
const SESSION_PAUSE_SECS: u64 = 3600;
const MAX_TEXT_CHUNK: usize = 4000;
const MAX_QR_REFRESH: u32 = 3;
const DEFAULT_CDN_BASE_URL: &str = "https://novac2c.cdn.weixin.qq.com/c2c";
pub const MAX_WEIXIN_FILE_BYTES: u64 = 30 * 1024 * 1024;
const CDN_UPLOAD_MAX_RETRIES: u32 = 3;
pub const MAX_INBOUND_IMAGES: usize = 5;

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct WeixinConfig {
    pub ilink_token: String,
    pub base_url: String,
    /// Normalized ilink bot id (filesystem-safe); used for sync buffer path.
    pub bot_account_id: String,
}

#[derive(Debug, Serialize)]
pub struct WeixinQrStartResponse {
    pub session_key: String,
    pub qr_image_url: String,
    pub message: String,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "snake_case")]
pub enum WeixinQrPollStatus {
    Wait,
    Scanned,
    NeedVerifyCode,
    Confirmed,
    Expired,
    Error,
}

#[derive(Debug, Clone, Serialize)]
pub struct WeixinQrPollResponse {
    pub status: WeixinQrPollStatus,
    pub message: String,
    /// Present when a new QR was issued after expiry (client should refresh image).
    pub qr_image_url: Option<String>,
    pub ilink_token: Option<String>,
    pub bot_account_id: Option<String>,
    pub base_url: Option<String>,
}

#[derive(Debug, Clone)]
pub struct WeixinIncomingImage {
    pub name: String,
    pub mime_type: &'static str,
    pub bytes: Vec<u8>,
}

#[derive(Debug)]
struct UploadedMediaInfo {
    download_encrypted_query_param: String,
    aeskey_hex: String,
    file_size_plain: u64,
    file_size_cipher: usize,
}

#[derive(Debug, Clone)]
struct UploadUrlResult {
    upload_full_url: Option<String>,
    upload_param: Option<String>,
}

#[derive(Debug, Clone)]
struct QrLoginSession {
    qrcode: String,
    started_at_ms: i64,
    refresh_count: u32,
    current_base_url: String,
    local_token_list: Vec<String>,
    existing_ilink_token: Option<String>,
    existing_bot_account_id: Option<String>,
    existing_base_url: Option<String>,
    // Serialize polls and retain a confirmed result until TTL expiry so a lost
    // controller response can be retried without losing the one-time login.
    poll_lock: Arc<tokio::sync::Mutex<()>>,
    completed: Option<WeixinQrPollResponse>,
}

enum QrSessionLookup {
    Missing,
    TimedOut,
    Found(QrLoginSession),
}

#[derive(Debug, Deserialize)]
struct QrCodeApiResponse {
    qrcode: Option<String>,
    qrcode_img_content: Option<String>,
}

#[derive(Debug, Deserialize)]
struct QrStatusApiResponse {
    ret: Option<i64>,
    errcode: Option<i64>,
    status: Option<String>,
    bot_token: Option<String>,
    ilink_bot_id: Option<String>,
    baseurl: Option<String>,
    redirect_host: Option<String>,
}

pub struct WeixinProviderClient {
    config: WeixinConfig,
    http_client: reqwest::Client,
    typing_tickets: Arc<RwLock<HashMap<String, String>>>,
    session_pause_until_ms: Arc<RwLock<HashMap<String, i64>>>,
}

pub struct TypingHandle {
    cancel: Arc<std::sync::atomic::AtomicBool>,
    handle: Option<tokio::task::JoinHandle<()>>,
    api: Arc<WeixinProviderClient>,
    peer_id: String,
    context_token: Option<String>,
    stopped: bool,
}

impl TypingHandle {
    pub async fn stop(mut self) {
        self.stopped = true;
        self.cancel
            .store(true, std::sync::atomic::Ordering::Release);
        if let Some(handle) = self.handle.take() {
            let _ = handle.await;
        }
        if let Err(err) = self
            .api
            .send_typing(&self.peer_id, 2, self.context_token.clone())
            .await
        {
            debug!(
                "weixin: send typing(cancel) failed for peer {peer}: {err}",
                peer = self.peer_id
            );
        }
    }
}

impl Drop for TypingHandle {
    fn drop(&mut self) {
        if self.stopped {
            return;
        }
        self.cancel
            .store(true, std::sync::atomic::Ordering::Release);
        if let Some(handle) = self.handle.take() {
            handle.abort();
        }
        let api = self.api.clone();
        let peer = self.peer_id.clone();
        let context_token = self.context_token.clone();
        tokio::spawn(async move {
            if let Err(err) = api.send_typing(&peer, 2, context_token).await {
                debug!("weixin: drop-cancel typing failed for peer {peer}: {err}");
            }
        });
    }
}

impl WeixinProviderClient {
    pub fn new(config: WeixinConfig) -> Self {
        Self {
            config,
            http_client: crate::reqwest_client(),
            typing_tickets: Arc::new(RwLock::new(HashMap::new())),
            session_pause_until_ms: Arc::new(RwLock::new(HashMap::new())),
        }
    }

    pub fn config(&self) -> &WeixinConfig {
        &self.config
    }

    fn base_url(&self) -> String {
        ensure_trailing_slash(&self.config.base_url)
    }

    async fn is_session_paused(&self) -> bool {
        let id = &self.config.bot_account_id;
        let mut sessions = self.session_pause_until_ms.write().await;
        let now = now_ms();
        if let Some(until) = sessions.get(id).copied() {
            if now >= until {
                sessions.remove(id);
                return false;
            }
            return true;
        }
        false
    }

    async fn pause_session(&self) {
        let until = now_ms() + (SESSION_PAUSE_SECS as i64) * 1000;
        self.session_pause_until_ms
            .write()
            .await
            .insert(self.config.bot_account_id.clone(), until);
        warn!(
            "weixin: iLink token is stale (err -14), pausing API for {}s",
            SESSION_PAUSE_SECS
        );
    }

    fn build_auth_headers(&self) -> reqwest::header::HeaderMap {
        use reqwest::header::{HeaderName, HeaderValue};
        let mut headers = build_common_headers();
        headers.insert(
            HeaderName::from_static("content-type"),
            HeaderValue::from_static("application/json"),
        );
        headers.insert(
            HeaderName::from_static("authorizationtype"),
            HeaderValue::from_static("ilink_bot_token"),
        );
        headers.insert(
            HeaderName::from_static("x-wechat-uin"),
            HeaderValue::from_str(&random_wechat_uin_header())
                .unwrap_or(HeaderValue::from_static("MA==")),
        );
        if let Ok(value) =
            HeaderValue::from_str(&format!("Bearer {}", self.config.ilink_token.trim()))
        {
            headers.insert(HeaderName::from_static("authorization"), value);
        }
        headers
    }

    async fn post_ilink(&self, endpoint: &str, body: Value, timeout: Duration) -> Result<String> {
        let url = format!("{}{}", self.base_url(), endpoint.trim_start_matches('/'));
        let body_str = serde_json::to_string(&body)?;
        let resp = self
            .http_client
            .post(&url)
            .timeout(timeout)
            .headers(self.build_auth_headers())
            .body(body_str)
            .send()
            .await?;
        let status = resp.status();
        let text = resp.text().await.unwrap_or_default();
        if !status.is_success() {
            return Err(anyhow!("ilink {endpoint} HTTP {status}: {text}"));
        }
        let value: Value = serde_json::from_str(&text)
            .with_context(|| format!("ilink {endpoint}: invalid JSON response"))?;
        if !value.is_object() {
            return Err(anyhow!("ilink {endpoint}: expected a JSON object"));
        }
        if endpoint != "ilink/bot/getupdates" {
            let ret = value["ret"].as_i64().unwrap_or(0);
            let errcode = value["errcode"].as_i64().unwrap_or(0);
            if ret != 0 || errcode != 0 {
                let errmsg = value["errmsg"]
                    .as_str()
                    .or_else(|| value["msg"].as_str())
                    .unwrap_or("");
                return Err(anyhow!(
                    "ilink {endpoint} application error ret={ret} errcode={errcode} errmsg={errmsg}"
                ));
            }
        }
        Ok(text)
    }

    pub async fn get_updates_once(&self, buf: &str, timeout: Duration) -> Result<Value> {
        if self.is_session_paused().await {
            tokio::time::sleep(Duration::from_secs(2)).await;
            return Ok(json!({
                "ret": WEIXIN_SESSION_EXPIRED_ERRCODE,
                "errcode": WEIXIN_SESSION_EXPIRED_ERRCODE,
                "errmsg": "WeChat login token is stale; sign in again",
                "msgs": []
            }));
        }

        let raw = self
            .post_ilink(
                "ilink/bot/getupdates",
                json!({
                    "get_updates_buf": buf,
                    "base_info": base_info()
                }),
                timeout,
            )
            .await;
        let raw = match raw {
            Ok(raw) => raw,
            Err(err)
                if err
                    .downcast_ref::<reqwest::Error>()
                    .is_some_and(|err| err.is_timeout()) =>
            {
                // An empty long poll is normal, not a reason to delay the next poll.
                return Ok(json!({ "ret": 0, "msgs": [], "get_updates_buf": buf }));
            }
            Err(err) => return Err(err),
        };
        let value: Value = serde_json::from_str(&raw)?;
        let ret = value["ret"].as_i64().unwrap_or(0);
        let errcode = value["errcode"].as_i64().unwrap_or(0);
        if errcode == WEIXIN_SESSION_EXPIRED_ERRCODE || ret == WEIXIN_SESSION_EXPIRED_ERRCODE {
            self.pause_session().await;
        }
        debug!(
            "weixin: getupdates ret={ret} errcode={errcode} messages={}",
            value["msgs"].as_array().map_or(0, Vec::len)
        );
        Ok(value)
    }

    async fn send_message_raw(
        &self,
        to_user_id: &str,
        context_token: &str,
        text: &str,
    ) -> Result<()> {
        let item_list = if text.is_empty() {
            None
        } else {
            Some(vec![json!({
                "type": 1,
                "text_item": { "text": text }
            })])
        };
        let msg = json!({
            "from_user_id": "",
            "to_user_id": to_user_id,
            "client_id": format!("openbitfun-wx-{}", uuid::Uuid::new_v4()),
            "message_type": 2,
            "message_state": 2,
            "item_list": item_list,
            "context_token": context_token,
        });
        let body = json!({
            "msg": msg,
            "base_info": base_info()
        });
        self.post_ilink(
            "ilink/bot/sendmessage",
            body,
            Duration::from_secs(API_TIMEOUT_SECS),
        )
        .await?;
        Ok(())
    }

    pub async fn send_text_chunks(
        &self,
        to_user_id: &str,
        context_token: &str,
        text: &str,
    ) -> Result<()> {
        for chunk in chunk_text_for_weixin(text) {
            self.send_message_raw(to_user_id, context_token, &chunk)
                .await?;
        }
        Ok(())
    }

    pub fn is_context_token_error(err: &anyhow::Error) -> bool {
        err.to_string()
            .to_ascii_lowercase()
            .contains("context_token")
    }

    pub async fn notify_start(&self) -> Result<()> {
        self.post_ilink(
            "ilink/bot/msg/notifystart",
            json!({ "base_info": base_info() }),
            Duration::from_secs(API_TIMEOUT_SECS),
        )
        .await?;
        Ok(())
    }

    pub async fn notify_stop(&self) -> Result<()> {
        self.post_ilink(
            "ilink/bot/msg/notifystop",
            json!({ "base_info": base_info() }),
            Duration::from_secs(API_TIMEOUT_SECS),
        )
        .await?;
        Ok(())
    }

    pub fn start_typing(
        self: &Arc<Self>,
        peer_id: String,
        context_token: Option<String>,
    ) -> TypingHandle {
        use std::sync::atomic::{AtomicBool, Ordering};
        let cancel = Arc::new(AtomicBool::new(false));
        let cancel_task = cancel.clone();
        let api = self.clone();
        let peer_for_task = peer_id.clone();
        let context_token_for_task = context_token.clone();
        let handle = tokio::spawn(async move {
            const TICK: Duration = Duration::from_millis(100);
            const TICKS_PER_REFRESH: u32 = 50;
            const TICKS_AFTER_FAILURE: u32 = 100;

            loop {
                if cancel_task.load(Ordering::Acquire) {
                    return;
                }
                let next_wait = match api
                    .send_typing(&peer_for_task, 1, context_token_for_task.clone())
                    .await
                {
                    Ok(()) => TICKS_PER_REFRESH,
                    Err(err) => {
                        debug!("weixin: send typing(start) failed for peer {peer_for_task}: {err}");
                        TICKS_AFTER_FAILURE
                    }
                };
                for _ in 0..next_wait {
                    if cancel_task.load(Ordering::Acquire) {
                        return;
                    }
                    tokio::time::sleep(TICK).await;
                }
            }
        });
        TypingHandle {
            cancel,
            handle: Some(handle),
            api: self.clone(),
            peer_id,
            context_token,
            stopped: false,
        }
    }

    async fn fetch_typing_ticket(
        &self,
        peer_id: &str,
        context_token: Option<String>,
    ) -> Result<String> {
        let mut body = json!({
            "ilink_user_id": peer_id,
            "base_info": base_info()
        });
        if let Some(token) = context_token {
            body["context_token"] = json!(token);
        }
        let raw = self
            .post_ilink(
                "ilink/bot/getconfig",
                body,
                Duration::from_secs(API_TIMEOUT_SECS),
            )
            .await?;
        let value: Value = serde_json::from_str(&raw)?;
        let ticket = value["typing_ticket"]
            .as_str()
            .filter(|s| !s.is_empty())
            .map(str::to_string)
            .ok_or_else(|| anyhow!("ilink/bot/getconfig returned empty typing_ticket"))?;
        self.typing_tickets
            .write()
            .await
            .insert(peer_id.to_string(), ticket.clone());
        Ok(ticket)
    }

    async fn send_typing(
        &self,
        peer_id: &str,
        status: i64,
        context_token: Option<String>,
    ) -> Result<()> {
        let cached = self.typing_tickets.read().await.get(peer_id).cloned();
        let ticket = match cached {
            Some(ticket) => ticket,
            None => {
                self.fetch_typing_ticket(peer_id, context_token.clone())
                    .await?
            }
        };

        let send_with = |ticket: String| async move {
            self.post_ilink(
                "ilink/bot/sendtyping",
                json!({
                    "ilink_user_id": peer_id,
                    "typing_ticket": ticket,
                    "status": status,
                    "base_info": base_info()
                }),
                Duration::from_secs(API_TIMEOUT_SECS),
            )
            .await
        };

        match send_with(ticket.clone()).await {
            Ok(_) => Ok(()),
            Err(err) => {
                {
                    let mut tickets = self.typing_tickets.write().await;
                    if tickets.get(peer_id).map(|t| t == &ticket).unwrap_or(false) {
                        tickets.remove(peer_id);
                    }
                }
                debug!("weixin: typing ticket retry for peer {peer_id} (prev err: {err})");
                let fresh = self.fetch_typing_ticket(peer_id, context_token).await?;
                send_with(fresh).await?;
                Ok(())
            }
        }
    }

    pub async fn send_file_content_to_peer(
        &self,
        peer_id: &str,
        context_token: &str,
        content: super::WorkspaceFileContent,
    ) -> Result<()> {
        if content.bytes.len() as u64 > MAX_WEIXIN_FILE_BYTES {
            return Err(anyhow!("Weixin file exceeds the upload limit"));
        }
        let mime = content.mime_type;

        let item = if matches!(
            mime,
            "image/png" | "image/jpeg" | "image/gif" | "image/webp" | "image/bmp"
        ) {
            let uploaded = self
                .upload_bytes_to_weixin_cdn(peer_id, &content.bytes, 1)
                .await?;
            let aes_key = media_aes_key_b64(&uploaded.aeskey_hex)?;
            json!({
                "type": 2,
                "image_item": {
                    "media": {
                        "encrypt_query_param": uploaded.download_encrypted_query_param,
                        "aes_key": aes_key,
                        "encrypt_type": 1
                    },
                    "mid_size": uploaded.file_size_cipher
                }
            })
        } else if mime.starts_with("video/") {
            let uploaded = self
                .upload_bytes_to_weixin_cdn(peer_id, &content.bytes, 2)
                .await?;
            let aes_key = media_aes_key_b64(&uploaded.aeskey_hex)?;
            json!({
                "type": 5,
                "video_item": {
                    "media": {
                        "encrypt_query_param": uploaded.download_encrypted_query_param,
                        "aes_key": aes_key,
                        "encrypt_type": 1
                    },
                    "video_size": uploaded.file_size_cipher
                }
            })
        } else {
            let uploaded = self
                .upload_bytes_to_weixin_cdn(peer_id, &content.bytes, 3)
                .await?;
            let aes_key = media_aes_key_b64(&uploaded.aeskey_hex)?;
            json!({
                "type": 4,
                "file_item": {
                    "media": {
                        "encrypt_query_param": uploaded.download_encrypted_query_param,
                        "aes_key": aes_key,
                        "encrypt_type": 1
                    },
                    "file_name": content.name,
                    "len": format!("{}", uploaded.file_size_plain)
                }
            })
        };

        self.send_message_with_items(peer_id, context_token, vec![item])
            .await
    }

    pub async fn download_inbound_images(&self, msg: &Value) -> (Vec<WeixinIncomingImage>, usize) {
        let Some(items) = msg["item_list"].as_array() else {
            return (vec![], 0);
        };
        let total_with_param = items
            .iter()
            .filter(|item| {
                item["type"].as_i64() == Some(2)
                    && item["image_item"]["media"]["encrypt_query_param"]
                        .as_str()
                        .is_some_and(|s| !s.is_empty())
            })
            .count();
        let skipped = total_with_param.saturating_sub(MAX_INBOUND_IMAGES);

        let mut images = Vec::new();
        for item in items {
            if images.len() >= MAX_INBOUND_IMAGES {
                break;
            }
            if item["type"].as_i64() != Some(2) {
                continue;
            }
            match self.inbound_image_bytes_from_item(item).await {
                Ok(bytes) => {
                    images.push(WeixinIncomingImage {
                        name: format!("weixin_image_{}.jpg", images.len() + 1),
                        mime_type: sniff_image_mime(&bytes),
                        bytes,
                    });
                }
                Err(err) => warn!("Weixin inbound image download failed: {err}"),
            }
        }
        (images, skipped)
    }

    async fn send_message_with_items(
        &self,
        to_user_id: &str,
        context_token: &str,
        items: Vec<Value>,
    ) -> Result<()> {
        let msg = json!({
            "from_user_id": "",
            "to_user_id": to_user_id,
            "client_id": format!("openbitfun-wx-{}", uuid::Uuid::new_v4()),
            "message_type": 2,
            "message_state": 2,
            "item_list": items,
            "context_token": context_token,
        });
        let body = json!({
            "msg": msg,
            "base_info": base_info()
        });
        self.post_ilink(
            "ilink/bot/sendmessage",
            body,
            Duration::from_secs(API_TIMEOUT_SECS),
        )
        .await?;
        Ok(())
    }

    async fn fetch_weixin_cdn_bytes(
        &self,
        encrypted_query_param: &str,
        full_url: Option<&str>,
    ) -> Result<Vec<u8>> {
        let url = match full_url.map(str::trim).filter(|s| !s.is_empty()) {
            Some(url) => url.to_string(),
            None => build_cdn_download_url(DEFAULT_CDN_BASE_URL, encrypted_query_param),
        };
        let client = crate::reqwest_client_builder()
            .timeout(Duration::from_secs(120))
            .build()?;
        let resp = client.get(&url).send().await?;
        let status = resp.status();
        if !status.is_success() {
            let body = resp.text().await.unwrap_or_default();
            return Err(anyhow!("weixin CDN GET {status}: {body}"));
        }
        Ok(resp.bytes().await?.to_vec())
    }

    async fn inbound_image_bytes_from_item(&self, item: &Value) -> Result<Vec<u8>> {
        let image = &item["image_item"];
        let param = image["media"]["encrypt_query_param"]
            .as_str()
            .filter(|s| !s.is_empty())
            .ok_or_else(|| anyhow!("image: missing encrypt_query_param"))?;
        let full_url = image["media"]["full_url"].as_str();

        let key = if let Some(hex_s) = image["aeskey"].as_str().filter(|s| !s.is_empty()) {
            let bytes =
                hex::decode(hex_s.trim()).map_err(|err| anyhow!("image aeskey hex: {err}"))?;
            if bytes.len() != 16 {
                return Err(anyhow!("image aeskey must decode to 16 bytes"));
            }
            let mut key = [0u8; 16];
            key.copy_from_slice(&bytes);
            Some(key)
        } else if let Some(b64) = image["media"]["aes_key"].as_str().filter(|s| !s.is_empty()) {
            Some(parse_weixin_cdn_aes_key(b64)?)
        } else {
            None
        };

        let encrypted = self.fetch_weixin_cdn_bytes(param, full_url).await?;
        match key {
            Some(key) => decrypt_aes_128_ecb_pkcs7(&encrypted, &key),
            None => Ok(encrypted),
        }
    }

    async fn upload_bytes_to_weixin_cdn(
        &self,
        to_user_id: &str,
        plaintext: &[u8],
        media_type: i64,
    ) -> Result<UploadedMediaInfo> {
        let rawsize = plaintext.len() as u64;
        let rawfilemd5 = md5_hex_lower(plaintext);
        let mut aeskey = [0u8; 16];
        rand::thread_rng().fill_bytes(&mut aeskey);
        let aeskey_hex = hex::encode(aeskey);
        let ciphertext = encrypt_aes_128_ecb_pkcs7(plaintext, &aeskey);
        let filesize_cipher = aes_ecb_ciphertext_len(plaintext.len());

        let mut filekey_raw = [0u8; 16];
        rand::thread_rng().fill_bytes(&mut filekey_raw);
        let filekey = hex::encode(filekey_raw);

        let url_resp = self
            .ilink_get_upload_url(
                to_user_id,
                &filekey,
                media_type,
                rawsize,
                &rawfilemd5,
                filesize_cipher,
                &aeskey_hex,
            )
            .await?;
        let cdn_url = if let Some(full) = url_resp.upload_full_url.as_deref() {
            full.to_string()
        } else if let Some(param) = url_resp.upload_param.as_deref() {
            build_cdn_upload_url(DEFAULT_CDN_BASE_URL, param, &filekey)
        } else {
            return Err(anyhow!(
                "getuploadurl: missing both upload_full_url and upload_param"
            ));
        };
        debug!(
            "weixin CDN upload: media_type={media_type} rawsize={rawsize} cipher_len={}",
            ciphertext.len()
        );
        let download_encrypted_query_param =
            self.post_weixin_cdn_upload(&cdn_url, &ciphertext).await?;

        Ok(UploadedMediaInfo {
            download_encrypted_query_param,
            aeskey_hex,
            file_size_plain: rawsize,
            file_size_cipher: ciphertext.len(),
        })
    }

    #[allow(clippy::too_many_arguments)]
    async fn ilink_get_upload_url(
        &self,
        to_user_id: &str,
        filekey: &str,
        media_type: i64,
        rawsize: u64,
        rawfilemd5: &str,
        filesize: usize,
        aeskey_hex: &str,
    ) -> Result<UploadUrlResult> {
        let raw = self
            .post_ilink(
                "ilink/bot/getuploadurl",
                json!({
                    "filekey": filekey,
                    "media_type": media_type,
                    "to_user_id": to_user_id,
                    "rawsize": rawsize,
                    "rawfilemd5": rawfilemd5,
                    "filesize": filesize,
                    "no_need_thumb": true,
                    "aeskey": aeskey_hex,
                    "base_info": base_info()
                }),
                Duration::from_secs(API_TIMEOUT_SECS),
            )
            .await?;
        let value: Value = serde_json::from_str(&raw)?;
        let pick = |key: &str| -> Option<String> {
            value[key]
                .as_str()
                .map(|s| s.trim().to_string())
                .filter(|s| !s.is_empty())
        };
        let upload_full_url = pick("upload_full_url");
        let upload_param = pick("upload_param");
        if upload_full_url.is_none() && upload_param.is_none() {
            return Err(anyhow!(
                "getuploadurl: missing both upload_full_url and upload_param"
            ));
        }
        Ok(UploadUrlResult {
            upload_full_url,
            upload_param,
        })
    }

    async fn post_weixin_cdn_upload(&self, cdn_url: &str, ciphertext: &[u8]) -> Result<String> {
        let client = crate::reqwest_client_builder()
            .timeout(Duration::from_secs(120))
            .build()?;
        let mut last_err: Option<anyhow::Error> = None;
        for attempt in 1..=CDN_UPLOAD_MAX_RETRIES {
            let resp = client
                .post(cdn_url)
                .header("Content-Type", "application/octet-stream")
                .body(ciphertext.to_vec())
                .send()
                .await;
            let resp = match resp {
                Ok(resp) => resp,
                Err(err) => {
                    last_err = Some(anyhow!("CDN upload attempt {attempt}: {err}"));
                    if attempt < CDN_UPLOAD_MAX_RETRIES {
                        tokio::time::sleep(Duration::from_secs(1)).await;
                    }
                    continue;
                }
            };
            let status = resp.status();
            if status.is_client_error() {
                let body = resp.text().await.unwrap_or_default();
                return Err(anyhow!("CDN client error {status}: {body}"));
            }
            if !status.is_success() {
                let body = resp.text().await.unwrap_or_default();
                last_err = Some(anyhow!("CDN server error {status}: {body}"));
                if attempt < CDN_UPLOAD_MAX_RETRIES {
                    tokio::time::sleep(Duration::from_secs(1)).await;
                }
                continue;
            }
            let download_param = resp
                .headers()
                .get("x-encrypted-param")
                .and_then(|header| header.to_str().ok())
                .map(str::to_string)
                .filter(|s| !s.is_empty());
            return download_param
                .ok_or_else(|| anyhow!("CDN response missing x-encrypted-param header"));
        }
        Err(last_err.unwrap_or_else(|| anyhow!("CDN upload failed")))
    }
}

pub async fn weixin_qr_start(
    base_url_override: Option<String>,
    existing_ilink_token: Option<String>,
    existing_bot_account_id: Option<String>,
) -> Result<WeixinQrStartResponse> {
    let existing_base_url = base_url_override.filter(|value| !value.trim().is_empty());
    // The reference client always obtains and refreshes login QR codes from the
    // fixed iLink entrypoint. The account-specific base URL only applies after login.
    let base = ensure_trailing_slash(DEFAULT_BASE_URL);
    let existing_ilink_token = existing_ilink_token.filter(|value| !value.trim().is_empty());
    let existing_bot_account_id = existing_bot_account_id.filter(|value| !value.trim().is_empty());
    let local_token_list = existing_ilink_token.clone().into_iter().collect::<Vec<_>>();
    let parsed = fetch_qr_code(&base, &local_token_list).await?;
    let qrcode = parsed
        .qrcode
        .filter(|s| !s.is_empty())
        .ok_or_else(|| anyhow!("get_bot_qrcode: missing qrcode"))?;
    let qr_image_url = parsed
        .qrcode_img_content
        .filter(|s| !s.is_empty())
        .ok_or_else(|| anyhow!("get_bot_qrcode: missing qrcode_img_content"))?;

    let session_key = uuid::Uuid::new_v4().to_string();
    qr_sessions()
        .lock()
        .map_err(|err| anyhow!("qr session lock: {err}"))?
        .retain(|_, session| now_ms() - session.started_at_ms <= QR_SESSION_TTL_MS);
    qr_sessions()
        .lock()
        .map_err(|err| anyhow!("qr session lock: {err}"))?
        .insert(
            session_key.clone(),
            QrLoginSession {
                qrcode,
                started_at_ms: now_ms(),
                refresh_count: 0,
                current_base_url: base,
                local_token_list,
                existing_ilink_token,
                existing_bot_account_id,
                existing_base_url,
                poll_lock: Arc::new(tokio::sync::Mutex::new(())),
                completed: None,
            },
        );

    Ok(WeixinQrStartResponse {
        session_key,
        qr_image_url,
        message: "Scan the QR code with WeChat.".to_string(),
    })
}

pub async fn weixin_qr_poll(
    session_key: &str,
    _base_url_override: Option<String>,
    verify_code: Option<String>,
) -> Result<WeixinQrPollResponse> {
    let base = ensure_trailing_slash(DEFAULT_BASE_URL);

    let lookup = {
        let mut sessions = qr_sessions()
            .lock()
            .map_err(|err| anyhow!("qr session lock: {err}"))?;
        match sessions.get(session_key) {
            None => QrSessionLookup::Missing,
            Some(session) => {
                if now_ms() - session.started_at_ms > QR_SESSION_TTL_MS {
                    sessions.remove(session_key);
                    QrSessionLookup::TimedOut
                } else {
                    QrSessionLookup::Found(session.clone())
                }
            }
        }
    };

    match lookup {
        QrSessionLookup::Missing => Ok(qr_error("No active QR session. Start login again.")),
        QrSessionLookup::TimedOut => Ok(qr_error("QR session expired. Start again.")),
        QrSessionLookup::Found(session) => {
            let poll_lock = session.poll_lock.clone();
            let _poll = poll_lock.lock().await;
            // Re-read after waiting for any earlier request to finish.
            let current = qr_sessions()
                .lock()
                .map_err(|err| anyhow!("qr session lock: {err}"))?
                .get(session_key)
                .cloned();
            let Some(session) = current else {
                return Ok(qr_error("No active QR session. Start login again."));
            };
            if now_ms() - session.started_at_ms > QR_SESSION_TTL_MS {
                qr_sessions()
                    .lock()
                    .map_err(|err| anyhow!("qr session lock: {err}"))?
                    .remove(session_key);
                return Ok(qr_error("QR session expired. Start again."));
            }
            if let Some(completed) = session.completed {
                return Ok(completed);
            }
            poll_found_qr_session(session_key, session, &base, verify_code.as_deref()).await
        }
    }
}

async fn poll_found_qr_session(
    session_key: &str,
    session: QrLoginSession,
    original_base: &str,
    verify_code: Option<&str>,
) -> Result<WeixinQrPollResponse> {
    let base = ensure_trailing_slash(&session.current_base_url);
    let qrcode_enc = urlencoding::encode(&session.qrcode);
    let mut url = format!("{}ilink/bot/get_qrcode_status?qrcode={}", base, qrcode_enc);
    if let Some(code) = verify_code.map(str::trim).filter(|code| !code.is_empty()) {
        url.push_str("&verify_code=");
        url.push_str(&urlencoding::encode(code));
    }

    let started = Instant::now();
    let resp = qr_http_client()
        .get(&url)
        .timeout(Duration::from_secs(QR_POLL_TIMEOUT_SECS))
        .headers(build_common_headers())
        .send()
        .await;

    let resp = match resp {
        Ok(resp) => resp,
        Err(err) => {
            if err.is_timeout() {
                debug!("weixin: QR status long poll timed out; continuing");
                return Ok(qr_wait("waiting"));
            }
            warn!(
                "weixin: transient QR status request failed; retrying: {}",
                err.without_url()
            );
            return Ok(qr_wait("waiting"));
        }
    };

    let status = resp.status();
    if !status.is_success() {
        warn!("weixin: QR status HTTP {status}");
        if status.is_client_error() {
            return Ok(qr_error(&format!(
                "WeChat rejected the login request (HTTP {status}). Start login again."
            )));
        }
        return Ok(qr_wait("waiting"));
    }

    let status_json: QrStatusApiResponse = resp.json().await?;
    let ret = status_json.ret.unwrap_or(0);
    let errcode = status_json.errcode.unwrap_or(0);
    if ret != 0 || errcode != 0 {
        warn!("weixin: QR status application error ret={ret} errcode={errcode}");
        return Ok(qr_error(&format!(
            "WeChat login failed (ret={ret}, errcode={errcode}). Start login again."
        )));
    }
    debug!(
        "weixin: QR status={} elapsed_ms={}",
        status_json.status.as_deref().unwrap_or("missing"),
        started.elapsed().as_millis()
    );
    match status_json.status.as_deref().unwrap_or("") {
        "wait" => Ok(qr_wait("waiting")),
        "scaned" => Ok(WeixinQrPollResponse {
            status: WeixinQrPollStatus::Scanned,
            message: "Scanned; confirm on your phone.".to_string(),
            qr_image_url: None,
            ilink_token: None,
            bot_account_id: None,
            base_url: None,
        }),
        "need_verifycode" => Ok(qr_need_verify_code()),
        "verify_code_blocked" => refresh_qr_session(session_key, original_base).await,
        "scaned_but_redirect" => redirect_qr_session(session_key, status_json),
        "binded_redirect" => confirm_existing_qr_session(session_key, session),
        "confirmed" => confirm_qr_session(session_key, status_json, &base),
        "expired" => refresh_qr_session(session_key, original_base).await,
        _ => Ok(qr_error(
            "WeChat returned an unsupported login state. Start login again.",
        )),
    }
}

fn redirect_qr_session(
    session_key: &str,
    status_json: QrStatusApiResponse,
) -> Result<WeixinQrPollResponse> {
    let redirect_host = status_json
        .redirect_host
        .map(|value| value.trim().to_string())
        .filter(|value| !value.is_empty())
        .ok_or_else(|| anyhow!("scaned_but_redirect missing redirect_host"))?;
    let redirect_base = if redirect_host.starts_with("https://") {
        ensure_trailing_slash(&redirect_host)
    } else {
        ensure_trailing_slash(&format!("https://{redirect_host}"))
    };
    let mut sessions = qr_sessions()
        .lock()
        .map_err(|err| anyhow!("qr session lock: {err}"))?;
    let session = sessions
        .get_mut(session_key)
        .ok_or_else(|| anyhow!("QR session lost during redirect"))?;
    session.current_base_url = redirect_base;
    Ok(WeixinQrPollResponse {
        status: WeixinQrPollStatus::Scanned,
        message: "Scanned; continuing on the assigned iLink host.".to_string(),
        qr_image_url: None,
        ilink_token: None,
        bot_account_id: None,
        base_url: None,
    })
}

fn confirm_existing_qr_session(
    session_key: &str,
    session: QrLoginSession,
) -> Result<WeixinQrPollResponse> {
    let token = session
        .existing_ilink_token
        .filter(|value| !value.is_empty())
        .ok_or_else(|| anyhow!("binded_redirect received without existing ilink token"))?;
    let account_id = session
        .existing_bot_account_id
        .filter(|value| !value.is_empty())
        .ok_or_else(|| anyhow!("binded_redirect received without existing bot account id"))?;
    cache_qr_completion(
        session_key,
        WeixinQrPollResponse {
            status: WeixinQrPollStatus::Confirmed,
            message: "WeChat was already linked; reused the existing login.".to_string(),
            qr_image_url: None,
            ilink_token: Some(token),
            bot_account_id: Some(account_id),
            base_url: Some(
                session
                    .existing_base_url
                    .unwrap_or(session.current_base_url)
                    .trim_end_matches('/')
                    .to_string(),
            ),
        },
    )
}

fn confirm_qr_session(
    session_key: &str,
    status_json: QrStatusApiResponse,
    base: &str,
) -> Result<WeixinQrPollResponse> {
    let token = status_json
        .bot_token
        .filter(|s| !s.is_empty())
        .ok_or_else(|| anyhow!("confirmed but bot_token missing"))?;
    let raw_id = status_json
        .ilink_bot_id
        .filter(|s| !s.is_empty())
        .ok_or_else(|| anyhow!("confirmed but ilink_bot_id missing"))?;
    let normalized = normalize_weixin_account_id(&raw_id);
    let baseurl = status_json
        .baseurl
        .filter(|s| !s.is_empty())
        .unwrap_or_else(|| base.trim_end_matches('/').to_string());

    cache_qr_completion(
        session_key,
        WeixinQrPollResponse {
            status: WeixinQrPollStatus::Confirmed,
            message: "WeChat linked.".to_string(),
            qr_image_url: None,
            ilink_token: Some(token),
            bot_account_id: Some(normalized),
            base_url: Some(baseurl),
        },
    )
}

fn cache_qr_completion(
    session_key: &str,
    response: WeixinQrPollResponse,
) -> Result<WeixinQrPollResponse> {
    let mut sessions = qr_sessions()
        .lock()
        .map_err(|err| anyhow!("qr session lock: {err}"))?;
    let session = sessions
        .get_mut(session_key)
        .ok_or_else(|| anyhow!("QR session lost before confirmation"))?;
    session.completed = Some(response.clone());
    Ok(response)
}

async fn refresh_qr_session(session_key: &str, base: &str) -> Result<WeixinQrPollResponse> {
    let local_token_list = {
        let mut sessions = qr_sessions()
            .lock()
            .map_err(|err| anyhow!("qr session lock: {err}"))?;
        let Some(session) = sessions.get_mut(session_key) else {
            return Ok(qr_error("Session lost. Start again."));
        };
        session.refresh_count += 1;
        if session.refresh_count > MAX_QR_REFRESH {
            sessions.remove(session_key);
            None
        } else {
            Some(session.local_token_list.clone())
        }
    };

    let Some(local_token_list) = local_token_list else {
        return Ok(qr_error("QR expired too many times; start again."));
    };

    let parsed = match fetch_qr_code(base, &local_token_list).await {
        Ok(parsed) => parsed,
        Err(err) => {
            qr_sessions()
                .lock()
                .map_err(|lock_err| anyhow!("qr session lock: {lock_err}"))?
                .remove(session_key);
            return Ok(qr_error(&format!("Failed to refresh QR: {err}")));
        }
    };
    let qrcode = parsed
        .qrcode
        .filter(|s| !s.is_empty())
        .ok_or_else(|| anyhow!("refresh: missing qrcode"))?;
    let qr_image_url = parsed
        .qrcode_img_content
        .filter(|s| !s.is_empty())
        .ok_or_else(|| anyhow!("refresh: missing qrcode_img_content"))?;

    {
        let mut sessions = qr_sessions()
            .lock()
            .map_err(|err| anyhow!("qr session lock: {err}"))?;
        if let Some(session) = sessions.get_mut(session_key) {
            session.qrcode = qrcode;
            session.started_at_ms = now_ms();
            session.current_base_url = ensure_trailing_slash(base);
        }
    }

    Ok(WeixinQrPollResponse {
        status: WeixinQrPollStatus::Expired,
        message: "QR refreshed.".to_string(),
        qr_image_url: Some(qr_image_url),
        ilink_token: None,
        bot_account_id: None,
        base_url: None,
    })
}

pub fn load_sync_buf(bot_account_id: &str) -> String {
    let path = sync_buf_path(bot_account_id);
    std::fs::read_to_string(&path)
        .unwrap_or_default()
        .trim()
        .to_string()
}

pub fn save_sync_buf(bot_account_id: &str, buf: &str) {
    let path = sync_buf_path(bot_account_id);
    if let Some(parent) = path.parent() {
        let _ = std::fs::create_dir_all(parent);
    }
    if let Err(err) = std::fs::write(&path, buf) {
        warn!("weixin: failed to save sync buf {}: {err}", path.display());
    }
}

pub fn load_context_tokens(bot_account_id: &str) -> HashMap<String, String> {
    let path = context_tokens_path(bot_account_id);
    let Ok(raw) = std::fs::read_to_string(path) else {
        return HashMap::new();
    };
    serde_json::from_str::<HashMap<String, String>>(&raw)
        .unwrap_or_default()
        .into_iter()
        .filter(|(peer, token)| !peer.trim().is_empty() && !token.trim().is_empty())
        .collect()
}

pub fn save_context_tokens(bot_account_id: &str, tokens: &HashMap<String, String>) {
    use std::io::Write;

    let path = context_tokens_path(bot_account_id);
    if let Some(parent) = path.parent() {
        let _ = std::fs::create_dir_all(parent);
    }
    let Ok(serialized) = serde_json::to_vec(tokens) else {
        warn!("weixin: failed to serialize context token cache");
        return;
    };
    let write_result = (|| -> std::io::Result<()> {
        let mut options = std::fs::OpenOptions::new();
        options.write(true).create(true).truncate(true);
        #[cfg(unix)]
        {
            use std::os::unix::fs::OpenOptionsExt;
            options.mode(0o600);
        }
        let mut file = options.open(&path)?;
        file.write_all(&serialized)?;
        file.sync_all()
    })();
    if let Err(err) = write_result {
        warn!(
            "weixin: failed to save context token cache {}: {err}",
            path.display()
        );
    }
}

pub fn is_user_message(msg: &Value) -> bool {
    msg["message_type"].as_i64() == Some(1)
}

pub fn peer_id(msg: &Value) -> Option<String> {
    msg["from_user_id"]
        .as_str()
        .map(str::to_string)
        .filter(|s| !s.is_empty())
}

pub fn context_token(msg: &Value) -> Option<String> {
    msg["context_token"]
        .as_str()
        .map(str::to_string)
        .filter(|s| !s.is_empty())
}

pub fn updates_failed(response: &Value) -> bool {
    response["ret"].as_i64().unwrap_or(0) != 0 || response["errcode"].as_i64().unwrap_or(0) != 0
}

pub fn suggested_long_poll_timeout(response: &Value, current: Duration) -> Duration {
    response["longpolling_timeout_ms"]
        .as_u64()
        .filter(|millis| (1_000..=120_000).contains(millis))
        .map(Duration::from_millis)
        .unwrap_or(current)
}

pub fn has_inbound_image_items(msg: &Value) -> bool {
    let Some(items) = msg["item_list"].as_array() else {
        return false;
    };
    items.iter().any(|item| {
        item["type"].as_i64() == Some(2)
            && item["image_item"]["media"]["encrypt_query_param"]
                .as_str()
                .is_some_and(|s| !s.is_empty())
    })
}

pub fn body_from_message(msg: &Value) -> String {
    let Some(items) = msg["item_list"].as_array() else {
        return String::new();
    };
    body_from_item_list(items)
}

fn body_from_item_list(items: &[Value]) -> String {
    for item in items {
        let item_type = item["type"].as_i64().unwrap_or(0);
        if item_type == 1 {
            if let Some(text) = item["text_item"]["text"].as_str() {
                let text = text.to_string();
                let ref_msg = &item["ref_msg"];
                if !ref_msg.is_object() {
                    return text;
                }
                let ref_title = ref_msg["title"].as_str();
                let ref_item = &ref_msg["message_item"];
                if ref_item.is_object() {
                    let media_type = ref_item["type"].as_i64().unwrap_or(0);
                    if is_weixin_media_item_type(media_type) {
                        return text;
                    }
                    let ref_body = body_from_item_list(std::slice::from_ref(ref_item));
                    if ref_title.is_none() && ref_body.is_empty() {
                        return text;
                    }
                    let mut parts = Vec::new();
                    if let Some(title) = ref_title {
                        parts.push(title.to_string());
                    }
                    if !ref_body.is_empty() {
                        parts.push(ref_body);
                    }
                    if parts.is_empty() {
                        return text;
                    }
                    let joined = parts.join(" | ");
                    return format!("[引用: {joined}]\n{text}");
                }
                if let Some(title) = ref_title {
                    return format!("[引用: {title}]\n{text}");
                }
                return text;
            }
        }
        if item_type == 3 {
            if let Some(text) = item["voice_item"]["text"].as_str() {
                return text.to_string();
            }
        }
    }
    String::new()
}

fn aes_ecb_ciphertext_len(plaintext_len: usize) -> usize {
    let pad = 16 - (plaintext_len % 16);
    let pad = if pad == 0 { 16 } else { pad };
    plaintext_len + pad
}

fn encrypt_aes_128_ecb_pkcs7(plaintext: &[u8], key: &[u8; 16]) -> Vec<u8> {
    let cipher = Aes128::new_from_slice(key).expect("AES-128 key len");
    let pad_len = 16 - (plaintext.len() % 16);
    let pad_len = if pad_len == 0 { 16 } else { pad_len };
    let mut buf = plaintext.to_vec();
    buf.extend(std::iter::repeat_n(pad_len as u8, pad_len));
    let mut out = Vec::with_capacity(buf.len());
    for chunk in buf.chunks_exact(16) {
        let mut block = aes::cipher::generic_array::GenericArray::clone_from_slice(chunk);
        cipher.encrypt_block(&mut block);
        out.extend_from_slice(&block);
    }
    out
}

fn decrypt_aes_128_ecb_pkcs7(ciphertext: &[u8], key: &[u8; 16]) -> Result<Vec<u8>> {
    if ciphertext.is_empty() || !ciphertext.len().is_multiple_of(16) {
        return Err(anyhow!("invalid ciphertext length {}", ciphertext.len()));
    }
    let cipher = Aes128::new_from_slice(key).expect("AES-128 key len");
    let mut out = Vec::with_capacity(ciphertext.len());
    for chunk in ciphertext.chunks_exact(16) {
        let mut block = aes::cipher::generic_array::GenericArray::clone_from_slice(chunk);
        cipher.decrypt_block(&mut block);
        out.extend_from_slice(&block);
    }
    let Some(&pad_byte) = out.last() else {
        return Err(anyhow!("empty after decrypt"));
    };
    let pad = pad_byte as usize;
    if pad == 0 || pad > 16 || pad > out.len() {
        return Err(anyhow!("invalid PKCS#7 padding (pad={pad})"));
    }
    if !out[out.len() - pad..].iter().all(|&b| b == pad_byte) {
        return Err(anyhow!("invalid PKCS#7 padding bytes"));
    }
    out.truncate(out.len() - pad);
    Ok(out)
}

fn parse_weixin_cdn_aes_key(aes_key_base64: &str) -> Result<[u8; 16]> {
    let decoded = B64
        .decode(aes_key_base64.trim())
        .map_err(|err| anyhow!("aes_key base64: {err}"))?;
    if decoded.len() == 16 {
        let mut key = [0u8; 16];
        key.copy_from_slice(&decoded);
        return Ok(key);
    }
    if decoded.len() == 32 {
        let text =
            std::str::from_utf8(&decoded).map_err(|_| anyhow!("aes_key: expected utf8 hex"))?;
        if text.len() == 32 && text.chars().all(|c| c.is_ascii_hexdigit()) {
            let bytes = hex::decode(text).map_err(|err| anyhow!("aes_key inner hex: {err}"))?;
            if bytes.len() == 16 {
                let mut key = [0u8; 16];
                key.copy_from_slice(&bytes);
                return Ok(key);
            }
        }
    }
    Err(anyhow!(
        "aes_key: unsupported encoding (decoded {} bytes)",
        decoded.len()
    ))
}

fn media_aes_key_b64(aeskey_hex: &str) -> Result<String> {
    let trimmed = aeskey_hex.trim();
    if trimmed.len() != 32 || !trimmed.chars().all(|c| c.is_ascii_hexdigit()) {
        return Err(anyhow!("aeskey must be 32 ascii hex chars"));
    }
    Ok(B64.encode(trimmed.as_bytes()))
}

fn md5_hex_lower(data: &[u8]) -> String {
    format!("{:x}", md5::compute(data))
}

fn build_cdn_upload_url(cdn_base: &str, upload_param: &str, filekey: &str) -> String {
    let base = cdn_base.trim_end_matches('/');
    format!(
        "{}/upload?encrypted_query_param={}&filekey={}",
        base,
        urlencoding::encode(upload_param),
        urlencoding::encode(filekey)
    )
}

fn build_cdn_download_url(cdn_base: &str, encrypted_query_param: &str) -> String {
    let base = cdn_base.trim_end_matches('/');
    format!(
        "{}/download?encrypted_query_param={}",
        base,
        urlencoding::encode(encrypted_query_param)
    )
}

fn sniff_image_mime(bytes: &[u8]) -> &'static str {
    if bytes.len() >= 3 && bytes[0] == 0xff && bytes[1] == 0xd8 && bytes[2] == 0xff {
        return "image/jpeg";
    }
    if bytes.len() >= 8 && bytes[..8] == [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a] {
        return "image/png";
    }
    if bytes.len() >= 6
        && (&bytes[..6] == b"GIF87a".as_slice() || &bytes[..6] == b"GIF89a".as_slice())
    {
        return "image/gif";
    }
    if bytes.len() >= 12 && &bytes[..4] == b"RIFF" && &bytes[8..12] == b"WEBP" {
        return "image/webp";
    }
    "image/jpeg"
}

fn qr_http_client() -> &'static reqwest::Client {
    static CLIENT: OnceLock<reqwest::Client> = OnceLock::new();
    CLIENT.get_or_init(crate::reqwest_client)
}

fn qr_sessions() -> &'static Mutex<HashMap<String, QrLoginSession>> {
    static CELL: OnceLock<Mutex<HashMap<String, QrLoginSession>>> = OnceLock::new();
    CELL.get_or_init(|| Mutex::new(HashMap::new()))
}

fn now_ms() -> i64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|duration| duration.as_millis() as i64)
        .unwrap_or(0)
}

fn normalize_weixin_account_id(raw: &str) -> String {
    raw.chars()
        .map(|c| {
            if c.is_ascii_alphanumeric() || c == '-' || c == '_' {
                c
            } else {
                '-'
            }
        })
        .collect()
}

fn random_wechat_uin_header() -> String {
    let n: u32 = rand::thread_rng().gen();
    B64.encode(n.to_string().as_bytes())
}

fn build_common_headers() -> reqwest::header::HeaderMap {
    use reqwest::header::{HeaderMap, HeaderName, HeaderValue};
    let mut headers = HeaderMap::new();
    headers.insert(
        HeaderName::from_static("ilink-app-id"),
        HeaderValue::from_static(ILINK_APP_ID),
    );
    headers.insert(
        HeaderName::from_static("ilink-app-clientversion"),
        HeaderValue::from_static(ILINK_APP_CLIENT_VERSION),
    );
    headers
}

fn base_info() -> Value {
    json!({
        "channel_version": CHANNEL_VERSION,
        "bot_agent": BOT_AGENT,
    })
}

fn ensure_trailing_slash(url: &str) -> String {
    if url.ends_with('/') {
        url.to_string()
    } else {
        format!("{url}/")
    }
}

async fn fetch_qr_code(base: &str, local_token_list: &[String]) -> Result<QrCodeApiResponse> {
    use reqwest::header::{HeaderName, HeaderValue};
    let url = format!(
        "{}ilink/bot/get_bot_qrcode?bot_type={}",
        ensure_trailing_slash(base),
        urlencoding::encode(DEFAULT_ILINK_BOT_TYPE)
    );
    let mut headers = build_common_headers();
    headers.insert(
        HeaderName::from_static("content-type"),
        HeaderValue::from_static("application/json"),
    );
    headers.insert(
        HeaderName::from_static("authorizationtype"),
        HeaderValue::from_static("ilink_bot_token"),
    );
    headers.insert(
        HeaderName::from_static("x-wechat-uin"),
        HeaderValue::from_str(&random_wechat_uin_header())
            .unwrap_or(HeaderValue::from_static("MA==")),
    );
    let response = qr_http_client()
        .post(&url)
        .timeout(Duration::from_secs(API_TIMEOUT_SECS))
        .headers(headers)
        .json(&json!({ "local_token_list": local_token_list }))
        .send()
        .await?;
    let status = response.status();
    if !status.is_success() {
        let body = response.text().await.unwrap_or_default();
        return Err(anyhow!("get_bot_qrcode HTTP {status}: {body}"));
    }
    Ok(response.json().await?)
}

fn sync_buf_path(bot_account_id: &str) -> PathBuf {
    let base = super::super::product_home_dir().unwrap_or_else(|| {
        std::env::temp_dir()
            .join(openbitfun_services_core::product_identity::hidden_data_directory())
    });
    base.join("weixin")
        .join(format!("{bot_account_id}_get_updates_buf.txt"))
}

fn context_tokens_path(bot_account_id: &str) -> PathBuf {
    let base = super::super::product_home_dir().unwrap_or_else(|| {
        std::env::temp_dir()
            .join(openbitfun_services_core::product_identity::hidden_data_directory())
    });
    base.join("weixin")
        .join(format!("{bot_account_id}_context_tokens.json"))
}

fn chunk_text_for_weixin(text: &str) -> Vec<String> {
    if text.len() <= MAX_TEXT_CHUNK {
        return vec![text.to_string()];
    }
    let mut out = Vec::new();
    let mut rest = text;
    while !rest.is_empty() {
        if rest.len() <= MAX_TEXT_CHUNK {
            out.push(rest.to_string());
            break;
        }
        let mut cut = MAX_TEXT_CHUNK;
        while cut > 0 && !rest.is_char_boundary(cut) {
            cut -= 1;
        }
        if cut == 0 {
            cut = rest.chars().next().map(|c| c.len_utf8()).unwrap_or(1);
        }
        out.push(rest[..cut].to_string());
        rest = &rest[cut..];
    }
    out
}

fn is_weixin_media_item_type(type_id: i64) -> bool {
    matches!(type_id, 2..=5)
}

fn qr_wait(message: &str) -> WeixinQrPollResponse {
    WeixinQrPollResponse {
        status: WeixinQrPollStatus::Wait,
        message: message.to_string(),
        qr_image_url: None,
        ilink_token: None,
        bot_account_id: None,
        base_url: None,
    }
}

fn qr_need_verify_code() -> WeixinQrPollResponse {
    WeixinQrPollResponse {
        status: WeixinQrPollStatus::NeedVerifyCode,
        message: "Enter the number displayed in WeChat to continue.".to_string(),
        qr_image_url: None,
        ilink_token: None,
        bot_account_id: None,
        base_url: None,
    }
}

fn qr_error(message: &str) -> WeixinQrPollResponse {
    WeixinQrPollResponse {
        status: WeixinQrPollStatus::Error,
        message: message.to_string(),
        qr_image_url: None,
        ilink_token: None,
        bot_account_id: None,
        base_url: None,
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    async fn mock_ilink(
        replies: Vec<(u64, &'static str)>,
    ) -> (
        String,
        tokio::sync::mpsc::UnboundedReceiver<String>,
        tokio::task::JoinHandle<()>,
    ) {
        use tokio::io::{AsyncReadExt, AsyncWriteExt};
        let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
        let base = format!("http://{}/", listener.local_addr().unwrap());
        let (tx, rx) = tokio::sync::mpsc::unbounded_channel();
        let task = tokio::spawn(async move {
            for (delay_ms, body) in replies {
                let (mut stream, _) = listener.accept().await.unwrap();
                let mut request = Vec::new();
                let mut chunk = [0; 4096];
                loop {
                    let read = stream.read(&mut chunk).await.unwrap();
                    if read == 0 {
                        break;
                    }
                    request.extend_from_slice(&chunk[..read]);
                    if let Some(end) = request.windows(4).position(|w| w == b"\r\n\r\n") {
                        let headers = String::from_utf8_lossy(&request[..end]);
                        let length = headers
                            .lines()
                            .find_map(|line| {
                                let (key, value) = line.split_once(':')?;
                                key.eq_ignore_ascii_case("content-length")
                                    .then(|| value.trim().parse::<usize>().ok())
                                    .flatten()
                            })
                            .unwrap_or(0);
                        if request.len() >= end + 4 + length {
                            break;
                        }
                    }
                }
                tx.send(String::from_utf8(request).unwrap()).unwrap();
                tokio::time::sleep(Duration::from_millis(delay_ms)).await;
                let response = format!(
                    "HTTP/1.1 200 OK\r\nContent-Type: application/json\r\nContent-Length: {}\r\nConnection: close\r\n\r\n{}",
                    body.len(), body
                );
                let _ = stream.write_all(response.as_bytes()).await;
            }
        });
        (base, rx, task)
    }

    fn test_client(base_url: String) -> WeixinProviderClient {
        WeixinProviderClient::new(WeixinConfig {
            ilink_token: "fixture-token".into(),
            base_url,
            bot_account_id: "fixture-bot".into(),
        })
    }

    fn test_qr_session(base: &str) -> String {
        let key = uuid::Uuid::new_v4().to_string();
        qr_sessions().lock().unwrap().insert(
            key.clone(),
            QrLoginSession {
                qrcode: "fixture-qr".into(),
                started_at_ms: now_ms(),
                refresh_count: 0,
                current_base_url: base.into(),
                local_token_list: vec!["fixture-token".into()],
                existing_ilink_token: Some("fixture-token".into()),
                existing_bot_account_id: Some("fixture-bot".into()),
                existing_base_url: Some(base.into()),
                poll_lock: Arc::new(tokio::sync::Mutex::new(())),
                completed: None,
            },
        );
        key
    }

    #[tokio::test]
    async fn qr_scan_confirmation_is_replayable_after_response_loss() {
        let (base, mut requests, task) = mock_ilink(vec![
            (0, r#"{"status":"scaned"}"#),
            (0, r#"{"status":"confirmed","bot_token":"new-token","ilink_bot_id":"fixture@bot","baseurl":"https://assigned.example"}"#),
        ]).await;
        let key = test_qr_session(&base);
        let scanned = weixin_qr_poll(&key, None, None).await.unwrap();
        assert!(matches!(scanned.status, WeixinQrPollStatus::Scanned));
        let (confirmed, overlapping) = tokio::join!(
            weixin_qr_poll(&key, None, None),
            weixin_qr_poll(&key, None, None),
        );
        let confirmed = confirmed.unwrap();
        assert_eq!(
            serde_json::to_value(&confirmed).unwrap(),
            serde_json::to_value(overlapping.unwrap()).unwrap()
        );
        assert!(matches!(confirmed.status, WeixinQrPollStatus::Confirmed));
        assert_eq!(
            confirmed.base_url.as_deref(),
            Some("https://assigned.example")
        );
        let replay = weixin_qr_poll(&key, None, None).await.unwrap();
        assert_eq!(
            serde_json::to_value(&confirmed).unwrap(),
            serde_json::to_value(replay).unwrap()
        );
        task.await.unwrap();
        assert!(requests
            .recv()
            .await
            .unwrap()
            .starts_with("GET /ilink/bot/get_qrcode_status?qrcode=fixture-qr "));
        assert!(requests.recv().await.is_some());
        assert!(requests.recv().await.is_none());
        qr_sessions().lock().unwrap().remove(&key);
    }

    #[tokio::test]
    async fn verification_and_reused_login_follow_reference_states() {
        let (base, mut requests, task) = mock_ilink(vec![
            (0, r#"{"status":"need_verifycode"}"#),
            (0, r#"{"status":"binded_redirect"}"#),
        ])
        .await;
        let key = test_qr_session(&base);
        assert!(matches!(
            weixin_qr_poll(&key, None, None).await.unwrap().status,
            WeixinQrPollStatus::NeedVerifyCode
        ));
        let reused = weixin_qr_poll(&key, None, Some("12 34&56".into()))
            .await
            .unwrap();
        assert!(matches!(reused.status, WeixinQrPollStatus::Confirmed));
        assert_eq!(reused.ilink_token.as_deref(), Some("fixture-token"));
        task.await.unwrap();
        requests.recv().await.unwrap();
        assert!(requests
            .recv()
            .await
            .unwrap()
            .contains("verify_code=12%2034%2656"));
        qr_sessions().lock().unwrap().remove(&key);
    }

    #[tokio::test]
    async fn expired_qr_refresh_preserves_local_tokens_and_resets_poll_host() {
        let (base, mut requests, task) = mock_ilink(vec![(
            0,
            r#"{"qrcode":"fresh-code","qrcode_img_content":"https://example.test/scan"}"#,
        )])
        .await;
        let key = test_qr_session("https://old.example/");
        let refreshed = refresh_qr_session(&key, &base).await.unwrap();
        assert!(matches!(refreshed.status, WeixinQrPollStatus::Expired));
        assert_eq!(
            refreshed.qr_image_url.as_deref(),
            Some("https://example.test/scan")
        );
        let session = qr_sessions().lock().unwrap().remove(&key).unwrap();
        assert_eq!(session.current_base_url, base);
        assert_eq!(session.qrcode, "fresh-code");
        task.await.unwrap();
        let request = requests.recv().await.unwrap();
        assert!(request.starts_with("POST /ilink/bot/get_bot_qrcode?bot_type=3 "));
        assert!(request.contains(r#""local_token_list":["fixture-token"]"#));
    }

    #[tokio::test]
    async fn missing_or_failed_qr_status_is_not_reported_as_waiting() {
        for response in [r#"{"ret":-14}"#, r#"{}"#, r#"{"status":"unsupported"}"#] {
            let (base, _requests, task) = mock_ilink(vec![(0, response)]).await;
            let key = test_qr_session(&base);
            assert!(matches!(
                weixin_qr_poll(&key, None, None).await.unwrap().status,
                WeixinQrPollStatus::Error
            ));
            task.await.unwrap();
            qr_sessions().lock().unwrap().remove(&key);
        }
    }

    #[tokio::test]
    async fn long_poll_timeout_preserves_cursor_without_backoff_error() {
        let (base, _requests, task) = mock_ilink(vec![(100, r#"{"ret":0,"msgs":[]}"#)]).await;
        let response = test_client(base)
            .get_updates_once("previous-cursor", Duration::from_millis(20))
            .await
            .unwrap();
        assert_eq!(response["get_updates_buf"], "previous-cursor");
        assert!(!updates_failed(&response));
        task.await.unwrap();
    }

    #[tokio::test]
    async fn stale_token_remains_an_error_while_requests_are_paused() {
        let (base, mut requests, task) = mock_ilink(vec![(0, r#"{"ret":-14}"#)]).await;
        let client = test_client(base);
        let response = client
            .get_updates_once("cursor", Duration::from_secs(1))
            .await
            .unwrap();
        assert!(updates_failed(&response));
        let paused = client
            .get_updates_once("cursor", Duration::from_secs(1))
            .await
            .unwrap();
        assert!(updates_failed(&paused));
        assert!(paused.get("get_updates_buf").is_none());
        task.await.unwrap();
        assert!(requests.recv().await.is_some());
        assert!(requests.recv().await.is_none());
    }

    #[tokio::test]
    async fn send_response_must_be_valid_json_and_successful() {
        for response in [
            "not-json",
            "null",
            r#"{"ret":-1,"errmsg":"denied"}"#,
            r#"{"errcode":42}"#,
        ] {
            let (base, _requests, task) = mock_ilink(vec![(0, response)]).await;
            assert!(test_client(base)
                .send_text_chunks("peer", "context", "hello")
                .await
                .is_err());
            task.await.unwrap();
        }
    }

    #[tokio::test]
    async fn outbound_text_uses_inbound_context_and_reference_envelope() {
        let (base, mut requests, task) = mock_ilink(vec![(0, "{}")]).await;
        test_client(base)
            .send_text_chunks("peer", "incoming-context", "hello")
            .await
            .unwrap();
        task.await.unwrap();
        let request = requests.recv().await.unwrap();
        assert!(request
            .to_ascii_lowercase()
            .contains("authorization: bearer fixture-token"));
        let body: Value = serde_json::from_str(request.split_once("\r\n\r\n").unwrap().1).unwrap();
        assert_eq!(body["msg"]["context_token"], "incoming-context");
        assert_eq!(body["msg"]["message_type"], 2);
        assert_eq!(body["msg"]["message_state"], 2);
        assert_eq!(body["msg"]["item_list"][0]["text_item"]["text"], "hello");
        assert_eq!(body["base_info"]["channel_version"], "2.4.8");
    }

    #[test]
    fn context_token_error_heuristic() {
        let app_err = anyhow!(
            "ilink ilink/bot/sendmessage application error ret=0 errcode=12345 errmsg=context_token expired"
        );
        assert!(WeixinProviderClient::is_context_token_error(&app_err));

        let unrelated_app_err = anyhow!("upstream returned errcode=42 unauthorized");
        assert!(!WeixinProviderClient::is_context_token_error(
            &unrelated_app_err
        ));

        let net_err = anyhow!("error sending request: connection refused");
        assert!(!WeixinProviderClient::is_context_token_error(&net_err));

        let http_err = anyhow!("ilink ilink/bot/sendmessage HTTP 500 Internal Server Error");
        assert!(!WeixinProviderClient::is_context_token_error(&http_err));
    }

    #[test]
    fn wire_metadata_matches_audited_reference_contract() {
        let metadata = base_info();
        assert_eq!(metadata["channel_version"], CHANNEL_VERSION);
        assert_eq!(metadata["bot_agent"], BOT_AGENT);

        let headers = build_common_headers();
        assert_eq!(
            headers
                .get("iLink-App-Id")
                .and_then(|value| value.to_str().ok()),
            Some(ILINK_APP_ID)
        );
        assert_eq!(
            headers
                .get("iLink-App-ClientVersion")
                .and_then(|value| value.to_str().ok()),
            Some(ILINK_APP_CLIENT_VERSION)
        );
    }

    #[test]
    fn verify_code_status_uses_frontend_wire_name() {
        assert_eq!(
            serde_json::to_string(&WeixinQrPollStatus::NeedVerifyCode).unwrap(),
            "\"need_verify_code\""
        );
    }

    #[test]
    fn text_chunk_limit_matches_reference_channel() {
        let chunks = chunk_text_for_weixin(&"a".repeat(MAX_TEXT_CHUNK + 1));
        assert_eq!(chunks.len(), 2);
        assert_eq!(chunks[0].len(), MAX_TEXT_CHUNK);
        assert_eq!(chunks[1], "a");
    }

    #[test]
    fn accepts_bounded_server_long_poll_timeout() {
        let fallback = Duration::from_secs(36);
        assert_eq!(
            suggested_long_poll_timeout(&json!({ "longpolling_timeout_ms": 35_000 }), fallback),
            Duration::from_secs(35)
        );
        assert_eq!(
            suggested_long_poll_timeout(&json!({ "longpolling_timeout_ms": 999_999 }), fallback),
            fallback
        );
    }

    #[test]
    fn aes_ecb_roundtrip() {
        let key = [9u8; 16];
        let plain = b"hello weixin cdn";
        let ciphertext = encrypt_aes_128_ecb_pkcs7(plain, &key);
        let decrypted = decrypt_aes_128_ecb_pkcs7(&ciphertext, &key).unwrap();
        assert_eq!(decrypted.as_slice(), plain.as_slice());
    }

    #[test]
    fn parse_aes_key_raw16_base64() {
        let raw = [1u8, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12, 13, 14, 15, 16];
        let b64 = B64.encode(raw);
        let key = parse_weixin_cdn_aes_key(&b64).unwrap();
        assert_eq!(key, raw);
    }

    #[test]
    fn parse_aes_key_hex_wrapped_base64() {
        let raw = [0xabu8; 16];
        let hex_str = hex::encode(raw);
        let b64 = B64.encode(hex_str.as_bytes());
        let key = parse_weixin_cdn_aes_key(&b64).unwrap();
        assert_eq!(key, raw);
    }

    #[test]
    fn media_aes_key_b64_matches_openclaw_hex_ascii_format() {
        let raw = [
            0x01u8, 0x23, 0x45, 0x67, 0x89, 0xab, 0xcd, 0xef, 0xfe, 0xdc, 0xba, 0x98, 0x76, 0x54,
            0x32, 0x10,
        ];
        let aeskey_hex = hex::encode(raw);
        let produced = media_aes_key_b64(&aeskey_hex).unwrap();
        let expected = B64.encode(aeskey_hex.as_bytes());
        assert_eq!(produced, expected);
        let decoded = B64.decode(&produced).unwrap();
        assert_eq!(decoded.len(), 32);
        assert!(std::str::from_utf8(&decoded)
            .map(|s| s.chars().all(|c| c.is_ascii_hexdigit()))
            .unwrap_or(false));
    }

    #[test]
    fn media_aes_key_b64_rejects_non_hex_input() {
        assert!(media_aes_key_b64("not_hex_at_all").is_err());
        assert!(media_aes_key_b64("zz".repeat(16).as_str()).is_err());
        assert!(media_aes_key_b64("ab").is_err());
    }

    #[test]
    fn body_from_message_plain_text() {
        let msg = json!({
            "item_list": [{ "type": 1, "text_item": { "text": "hi" } }]
        });
        assert_eq!(body_from_message(&msg), "hi");
    }

    #[test]
    fn body_from_message_quoted_text() {
        let msg = json!({
            "item_list": [{
                "type": 1,
                "text_item": { "text": "reply" },
                "ref_msg": { "title": " earlier ", "message_item": { "type": 1, "text_item": { "text": "orig" } } }
            }]
        });
        let body = body_from_message(&msg);
        assert!(body.contains("[引用:"));
        assert!(body.contains("reply"));
    }
}
