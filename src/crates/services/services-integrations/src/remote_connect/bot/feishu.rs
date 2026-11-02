//! Feishu provider client and WebSocket protocol helpers for Remote Connect.

use anyhow::{anyhow, Result};
use futures::{SinkExt, StreamExt};
use log::{debug, info, warn};
use serde::{Deserialize, Serialize};
use std::sync::Arc;
use tokio::sync::RwLock;
use tokio_tungstenite::tungstenite::Message as WsMessage;

use super::{BotAction, BotActionStyle, BotLanguage};

type FeishuWsStream =
    tokio_tungstenite::WebSocketStream<tokio_tungstenite::MaybeTlsStream<tokio::net::TcpStream>>;
type FeishuWsWrite = futures::stream::SplitSink<FeishuWsStream, WsMessage>;

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct FeishuConfig {
    pub app_id: String,
    pub app_secret: String,
}

#[derive(Debug, Clone)]
struct FeishuToken {
    access_token: String,
    expires_at: i64,
}

#[derive(Debug, Clone)]
pub struct FeishuWsEndpoint {
    pub url: String,
    pub client_config: serde_json::Value,
}

#[derive(Debug, Clone)]
pub struct FeishuParsedMessage {
    pub chat_id: String,
    pub message_id: String,
    pub text: String,
    pub image_keys: Vec<String>,
}

#[derive(Debug, Clone)]
pub struct FeishuDownloadedImage {
    pub content_type: String,
    pub bytes: Vec<u8>,
}

pub struct FeishuBotApi {
    config: FeishuConfig,
    token: Arc<RwLock<Option<FeishuToken>>>,
}

/// Feishu IM file-upload hard limit (30 MB).
pub const MAX_FEISHU_FILE_BYTES: u64 = 30 * 1024 * 1024;

impl FeishuBotApi {
    pub fn new(config: FeishuConfig) -> Self {
        Self {
            config,
            token: Arc::new(RwLock::new(None)),
        }
    }

    pub fn config(&self) -> &FeishuConfig {
        &self.config
    }

    async fn get_access_token(&self) -> Result<String> {
        {
            let guard = self.token.read().await;
            if let Some(t) = guard.as_ref() {
                if t.expires_at > chrono::Utc::now().timestamp() + 60 {
                    return Ok(t.access_token.clone());
                }
            }
        }

        let client = crate::reqwest_client();
        let resp = client
            .post("https://open.feishu.cn/open-apis/auth/v3/tenant_access_token/internal")
            .json(&serde_json::json!({
                "app_id": self.config.app_id,
                "app_secret": self.config.app_secret,
            }))
            .send()
            .await
            .map_err(|e| anyhow!("feishu token request: {e}"))?;

        let token_resp_text = resp.text().await.unwrap_or_default();
        let body: serde_json::Value = serde_json::from_str(&token_resp_text).map_err(|e| {
            anyhow!(
                "feishu token response parse error: {e}, body: {}",
                truncate_for_error(&token_resp_text, 200)
            )
        })?;
        let access_token = body["tenant_access_token"]
            .as_str()
            .ok_or_else(|| anyhow!("missing tenant_access_token in response"))?
            .to_string();
        let expire = body["expire"].as_i64().unwrap_or(7200);

        *self.token.write().await = Some(FeishuToken {
            access_token: access_token.clone(),
            expires_at: chrono::Utc::now().timestamp() + expire,
        });

        info!("Feishu access token refreshed");
        Ok(access_token)
    }

    pub async fn send_message(&self, chat_id: &str, content: &str) -> Result<()> {
        let token = self.get_access_token().await?;
        let card = build_markdown_card(content);
        let client = crate::reqwest_client();
        let resp = client
            .post("https://open.feishu.cn/open-apis/im/v1/messages")
            .query(&[("receive_id_type", "chat_id")])
            .bearer_auth(&token)
            .json(&serde_json::json!({
                "receive_id": chat_id,
                "msg_type": "interactive",
                "content": serde_json::to_string(&card)?,
            }))
            .send()
            .await?;

        let status = resp.status();
        let body = resp.text().await.unwrap_or_default();
        if !status.is_success() {
            return Err(anyhow!("feishu send_message HTTP {status}: {body}"));
        }
        if let Ok(parsed) = serde_json::from_str::<serde_json::Value>(&body) {
            if let Some(code) = parsed.get("code").and_then(|c| c.as_i64()) {
                if code != 0 {
                    let msg = parsed
                        .get("msg")
                        .and_then(|m| m.as_str())
                        .unwrap_or("unknown");
                    warn!("Feishu send_message API error: code={code}, msg={msg}");
                    return Err(anyhow!(
                        "feishu send_message API error: code={code}, msg={msg}"
                    ));
                }
            }
        }
        debug!("Feishu message sent to {chat_id}");
        Ok(())
    }

    pub async fn send_action_card(
        &self,
        chat_id: &str,
        language: BotLanguage,
        content: &str,
        actions: &[BotAction],
    ) -> Result<()> {
        let token = self.get_access_token().await?;
        let client = crate::reqwest_client();
        let card = build_action_card(chat_id, language, content, actions);
        let resp = client
            .post("https://open.feishu.cn/open-apis/im/v1/messages")
            .query(&[("receive_id_type", "chat_id")])
            .bearer_auth(&token)
            .json(&serde_json::json!({
                "receive_id": chat_id,
                "msg_type": "interactive",
                "content": serde_json::to_string(&card)?,
            }))
            .send()
            .await?;

        if !resp.status().is_success() {
            let body = resp.text().await.unwrap_or_default();
            return Err(anyhow!("feishu send_action_card failed: {body}"));
        }
        debug!("Feishu action card sent to {chat_id}");
        Ok(())
    }

    /// Download a user-sent image from a Feishu message using the message resources API.
    pub async fn download_image_resource(
        &self,
        message_id: &str,
        file_key: &str,
    ) -> Result<FeishuDownloadedImage> {
        let token = self.get_access_token().await?;
        let client = crate::reqwest_client();
        let url = format!(
            "https://open.feishu.cn/open-apis/im/v1/messages/{}/resources/{}?type=image",
            message_id, file_key
        );
        let resp = client
            .get(&url)
            .bearer_auth(&token)
            .send()
            .await
            .map_err(|e| anyhow!("feishu download image: {e}"))?;

        let status = resp.status();
        if !status.is_success() {
            let body = resp.text().await.unwrap_or_default();
            return Err(anyhow!(
                "feishu image download failed: HTTP {status} \u{2014} {body}"
            ));
        }

        let content_type = resp
            .headers()
            .get("content-type")
            .and_then(|v| v.to_str().ok())
            .unwrap_or("image/png")
            .to_string();
        let bytes = resp.bytes().await?.to_vec();

        Ok(FeishuDownloadedImage {
            content_type,
            bytes,
        })
    }

    /// Send bytes already read and authorized by the owning session.
    pub async fn send_file_content_to_chat(
        &self,
        chat_id: &str,
        content: super::WorkspaceFileContent,
    ) -> Result<()> {
        if content.bytes.len() as u64 > MAX_FEISHU_FILE_BYTES {
            return Err(anyhow!("Feishu file exceeds the upload limit"));
        }
        let file_key = self.upload_file_content(content).await?;
        let token = self.get_access_token().await?;

        let client = crate::reqwest_client();
        let resp = client
            .post("https://open.feishu.cn/open-apis/im/v1/messages")
            .query(&[("receive_id_type", "chat_id")])
            .bearer_auth(&token)
            .json(&serde_json::json!({
                "receive_id": chat_id,
                "msg_type": "file",
                "content": serde_json::to_string(&serde_json::json!({"file_key": file_key}))?,
            }))
            .send()
            .await?;

        if !resp.status().is_success() {
            let body = resp.text().await.unwrap_or_default();
            return Err(anyhow!("Feishu file message failed: {body}"));
        }
        let body: serde_json::Value = resp.json().await?;
        ensure_feishu_success(&body, "file message")?;
        debug!("Feishu file sent to {chat_id}");
        Ok(())
    }

    async fn upload_file_content(&self, content: super::WorkspaceFileContent) -> Result<String> {
        let token = self.get_access_token().await?;

        let ext = std::path::Path::new(&content.name)
            .extension()
            .and_then(|e| e.to_str())
            .unwrap_or("")
            .to_lowercase();
        let file_type = match ext.as_str() {
            "pdf" => "pdf",
            "doc" | "docx" => "doc",
            "xls" | "xlsx" => "xls",
            "ppt" | "pptx" => "ppt",
            "mp4" => "mp4",
            _ => "stream",
        };

        let part = reqwest::multipart::Part::bytes(content.bytes)
            .file_name(content.name.clone())
            .mime_str("application/octet-stream")?;

        let form = reqwest::multipart::Form::new()
            .text("file_type", file_type.to_string())
            .text("file_name", content.name)
            .part("file", part);

        let client = crate::reqwest_client();
        let resp = client
            .post("https://open.feishu.cn/open-apis/im/v1/files")
            .bearer_auth(&token)
            .multipart(form)
            .send()
            .await?;

        if !resp.status().is_success() {
            let body = resp.text().await.unwrap_or_default();
            return Err(anyhow!("Feishu file upload failed: {body}"));
        }

        let body: serde_json::Value = resp.json().await?;
        body.pointer("/data/file_key")
            .and_then(|v| v.as_str())
            .map(|s| s.to_string())
            .ok_or_else(|| anyhow!("Feishu upload response missing file_key"))
    }

    /// Native previews use the image endpoint. Unknown formats remain files.
    pub async fn send_artifact_to_chat(
        &self,
        chat_id: &str,
        content: super::WorkspaceFileContent,
    ) -> Result<()> {
        if matches!(
            content.mime_type,
            "image/png" | "image/jpeg" | "image/gif" | "image/webp" | "image/bmp"
        ) && content.bytes.len() <= 10 * 1024 * 1024
        {
            // Only fall back if upload failed before any message was submitted.
            // An uncertain message response must not duplicate an already sent image.
            match self.upload_image_content(&content).await {
                Ok(key) => return self.send_image_key(chat_id, &key).await,
                Err(error) => {
                    warn!("Feishu image upload failed; sending original as a file: {error}")
                }
            }
        }
        self.send_file_content_to_chat(chat_id, content).await
    }

    async fn upload_image_content(&self, content: &super::WorkspaceFileContent) -> Result<String> {
        let token = self.get_access_token().await?;
        let form = reqwest::multipart::Form::new()
            .text("image_type", "message")
            .part(
                "image",
                reqwest::multipart::Part::bytes(content.bytes.clone())
                    .file_name(content.name.clone())
                    .mime_str(content.mime_type)?,
            );
        let response = crate::reqwest_client()
            .post("https://open.feishu.cn/open-apis/im/v1/images")
            .bearer_auth(token)
            .multipart(form)
            .send()
            .await?
            .error_for_status()?;
        let body: serde_json::Value = response.json().await?;
        ensure_feishu_success(&body, "image upload")?;
        body.pointer("/data/image_key")
            .and_then(|key| key.as_str())
            .map(str::to_string)
            .ok_or_else(|| anyhow!("Feishu image upload response missing image_key"))
    }

    async fn send_image_key(&self, chat_id: &str, key: &str) -> Result<()> {
        let token = self.get_access_token().await?;
        let response = crate::reqwest_client()
            .post("https://open.feishu.cn/open-apis/im/v1/messages")
            .query(&[("receive_id_type", "chat_id")])
            .bearer_auth(token)
            .json(
                &serde_json::json!({ "receive_id": chat_id, "msg_type": "image",
                "content": serde_json::to_string(&serde_json::json!({ "image_key": key }))? }),
            )
            .send()
            .await?
            .error_for_status()?;
        let body: serde_json::Value = response.json().await?;
        ensure_feishu_success(&body, "image message")
    }

    /// Obtain a WebSocket URL from Feishu for long-connection event delivery.
    pub async fn get_ws_endpoint(&self) -> Result<FeishuWsEndpoint> {
        let client = crate::reqwest_client();
        let resp = client
            .post("https://open.feishu.cn/callback/ws/endpoint")
            .json(&serde_json::json!({
                "AppID": self.config.app_id,
                "AppSecret": self.config.app_secret,
            }))
            .send()
            .await
            .map_err(|e| anyhow!("feishu ws endpoint request: {e}"))?;

        let ws_resp_text = resp.text().await.unwrap_or_default();
        let body: serde_json::Value = serde_json::from_str(&ws_resp_text).map_err(|e| {
            anyhow!(
                "feishu ws endpoint parse error: {e}, body: {}",
                truncate_for_error(&ws_resp_text, 300)
            )
        })?;
        let code = body["code"].as_i64().unwrap_or(-1);
        if code != 0 {
            let msg = body["msg"].as_str().unwrap_or("unknown error");
            return Err(anyhow!("feishu ws endpoint error {code}: {msg}"));
        }

        let url = body
            .pointer("/data/URL")
            .and_then(|v| v.as_str())
            .ok_or_else(|| anyhow!("missing WebSocket URL in feishu response"))?
            .to_string();
        let client_config = body
            .pointer("/data/ClientConfig")
            .cloned()
            .unwrap_or_default();

        Ok(FeishuWsEndpoint { url, client_config })
    }

    pub async fn connect_ws(&self, url: &str) -> Result<FeishuWsConnection> {
        // Feishu uses wss:// and bypasses RelayClient::dial; ensure CryptoProvider
        // is installed so rustls does not panic when ring + aws-lc-rs are both linked.
        crate::remote_connect::ensure_rustls_crypto_provider();
        let (ws_stream, _) = tokio_tungstenite::connect_async(url)
            .await
            .map_err(|e| anyhow!("feishu ws connect: {e}"))?;
        let (write, read) = ws_stream.split();
        Ok(FeishuWsConnection {
            write: Arc::new(RwLock::new(write)),
            read,
        })
    }
}

pub struct FeishuWsEvent {
    payload: Vec<u8>,
    response: FeishuFrame,
}

impl FeishuWsEvent {
    pub fn payload(&self) -> &[u8] {
        &self.payload
    }
}

pub struct FeishuWsConnection {
    write: Arc<RwLock<FeishuWsWrite>>,
    read: futures::stream::SplitStream<FeishuWsStream>,
}

impl FeishuWsConnection {
    async fn next_frame(&mut self) -> Result<Option<FeishuFrame>> {
        loop {
            match self.read.next().await {
                Some(Ok(WsMessage::Binary(data))) => {
                    if let Some(frame) = decode_frame(&data) {
                        return Ok(Some(frame));
                    }
                    debug!("Ignoring undecodable Feishu WS binary frame");
                }
                Some(Ok(WsMessage::Ping(data))) => {
                    let _ = self.write.write().await.send(WsMessage::Pong(data)).await;
                }
                Some(Ok(_)) => {}
                Some(Err(e)) => return Err(anyhow!("feishu ws error: {e}")),
                None => return Ok(None),
            }
        }
    }

    async fn send_frame(&self, frame: &FeishuFrame) -> Result<()> {
        self.write
            .write()
            .await
            .send(WsMessage::Binary(encode_frame(frame).into()))
            .await
            .map_err(|e| anyhow!("feishu ws send: {e}"))
    }

    pub async fn next_event(&mut self) -> Result<Option<FeishuWsEvent>> {
        loop {
            let Some(frame) = self.next_frame().await? else {
                return Ok(None);
            };
            match frame.method {
                FRAME_TYPE_DATA => {
                    if frame.get_header("type").unwrap_or("") == "event" {
                        let response = FeishuFrame::new_response(&frame, 200);
                        return Ok(Some(FeishuWsEvent {
                            payload: frame.payload,
                            response,
                        }));
                    }
                }
                FRAME_TYPE_CONTROL => {
                    debug!(
                        "Feishu WS control frame: type={}",
                        frame.get_header("type").unwrap_or("?")
                    );
                }
                _ => {}
            }
        }
    }

    pub async fn ack_event(&self, event: &FeishuWsEvent) -> Result<()> {
        self.send_frame(&event.response).await
    }

    pub async fn send_ping(&self, service_id: i32) -> Result<()> {
        let ping = FeishuFrame::new_ping(service_id);
        self.send_frame(&ping).await
    }
}
fn build_markdown_card(content: &str) -> serde_json::Value {
    serde_json::json!({
        "schema": "2.0",
        "config": {
            "wide_screen_mode": true,
        },
        "body": {
            "elements": [
                {
                    "tag": "markdown",
                    "content": content,
                    "text_align": "left",
                    "text_size": "normal",
                    "margin": "0px 0px 0px 0px",
                    "element_id": "openbitfun_remote_reply_markdown",
                }
            ],
        },
    })
}

fn build_action_card(
    chat_id: &str,
    language: BotLanguage,
    content: &str,
    actions: &[BotAction],
) -> serde_json::Value {
    let body = card_body_text(language, content);
    let mut elements = vec![serde_json::json!({
        "tag": "markdown",
        "content": body,
    })];

    for chunk in actions.chunks(2) {
        let buttons: Vec<_> = chunk
            .iter()
            .map(|action| {
                let button_type = match action.style {
                    BotActionStyle::Primary => "primary",
                    BotActionStyle::Default => "default",
                };
                serde_json::json!({
                    "tag": "button",
                    "text": {
                        "tag": "plain_text",
                        "content": action.label,
                    },
                    "type": button_type,
                    "value": {
                        "chat_id": chat_id,
                        "command": action.command,
                    }
                })
            })
            .collect();
        elements.push(serde_json::json!({
            "tag": "action",
            "actions": buttons,
        }));
    }

    serde_json::json!({
        "config": {
            "wide_screen_mode": true,
        },
        "header": {
            "title": {
                "tag": "plain_text",
                "content": "OpenBitFun Remote Connect",
            }
        },
        "elements": elements,
    })
}

fn card_body_text(language: BotLanguage, content: &str) -> String {
    let mut removed_command_lines = false;
    let mut lines = Vec::new();

    for line in content.lines() {
        let trimmed = line.trim_start();
        if trimmed.starts_with('/') && trimmed.contains(" - ") {
            removed_command_lines = true;
            continue;
        }
        if trimmed.contains("/cancel_task ") {
            lines.push(if language.is_chinese() {
                "如需停止本次请求，请使用下方的“取消任务”按钮。".to_string()
            } else {
                "If needed, use the Cancel Task button below to stop this request.".to_string()
            });
            continue;
        }
        lines.push(replace_command_tokens(language, line));
    }

    let mut body = lines.join("\n").trim().to_string();
    if removed_command_lines {
        if !body.is_empty() {
            body.push_str("\n\n");
        }
        body.push_str(if language.is_chinese() {
            "请选择下方操作。"
        } else {
            "Choose an action below."
        });
    }

    if body.is_empty() {
        if language.is_chinese() {
            "请选择下方操作。".to_string()
        } else {
            "Choose an action below.".to_string()
        }
    } else {
        body
    }
}

fn replace_command_tokens(language: BotLanguage, line: &str) -> String {
    let replacements = [
        (
            "/switch_workspace",
            if language.is_chinese() {
                "切换工作区"
            } else {
                "Switch Workspace"
            },
        ),
        (
            "/pro",
            if language.is_chinese() {
                "专业模式"
            } else {
                "Expert Mode"
            },
        ),
        (
            "/assistant",
            if language.is_chinese() {
                "助理模式"
            } else {
                "Assistant Mode"
            },
        ),
        (
            "/resume_session",
            if language.is_chinese() {
                "恢复会话"
            } else {
                "Resume Session"
            },
        ),
        (
            "/new_code_session",
            if language.is_chinese() {
                "新建编码会话"
            } else {
                "New Code Session"
            },
        ),
        (
            "/new_cowork_session",
            if language.is_chinese() {
                "新建协作会话"
            } else {
                "New Cowork Session"
            },
        ),
        (
            "/new_claw_session",
            if language.is_chinese() {
                "新建助理会话"
            } else {
                "New Assistant Session"
            },
        ),
        (
            "/cancel_task",
            if language.is_chinese() {
                "取消任务"
            } else {
                "Cancel Task"
            },
        ),
        (
            "/help",
            if language.is_chinese() {
                "帮助"
            } else {
                "Help"
            },
        ),
    ];

    replacements
        .iter()
        .fold(line.to_string(), |acc, (from, to)| acc.replace(from, to))
}

pub fn parse_message_event_full(event: &serde_json::Value) -> Option<FeishuParsedMessage> {
    let event_type = event
        .pointer("/header/event_type")
        .and_then(|v| v.as_str())?;
    if event_type != "im.message.receive_v1" {
        return None;
    }

    let chat_id = event
        .pointer("/event/message/chat_id")
        .and_then(|v| v.as_str())?
        .to_string();
    let message_id = event
        .pointer("/event/message/message_id")
        .and_then(|v| v.as_str())
        .unwrap_or("")
        .to_string();
    let msg_type = event
        .pointer("/event/message/message_type")
        .and_then(|v| v.as_str())?;
    let content_str = event
        .pointer("/event/message/content")
        .and_then(|v| v.as_str())?;
    let content: serde_json::Value = serde_json::from_str(content_str).ok()?;

    match msg_type {
        "text" => {
            let text = content["text"].as_str()?.trim().to_string();
            if text.is_empty() {
                return None;
            }
            Some(FeishuParsedMessage {
                chat_id,
                message_id,
                text,
                image_keys: vec![],
            })
        }
        "post" => {
            let (text, image_keys) = extract_from_post(&content);
            if text.is_empty() && image_keys.is_empty() {
                return None;
            }
            Some(FeishuParsedMessage {
                chat_id,
                message_id,
                text,
                image_keys,
            })
        }
        "image" => {
            let image_key = content["image_key"].as_str()?.to_string();
            Some(FeishuParsedMessage {
                chat_id,
                message_id,
                text: String::new(),
                image_keys: vec![image_key],
            })
        }
        _ => None,
    }
}

fn extract_from_post(content: &serde_json::Value) -> (String, Vec<String>) {
    let root = if content["content"].is_array() {
        content
    } else {
        content
            .get("zh_cn")
            .or_else(|| content.get("en_us"))
            .or_else(|| content.as_object().and_then(|obj| obj.values().next()))
            .unwrap_or(content)
    };

    let paragraphs = match root["content"].as_array() {
        Some(p) => p,
        None => return (String::new(), vec![]),
    };

    let mut text_parts: Vec<String> = Vec::new();
    let mut image_keys: Vec<String> = Vec::new();

    for para in paragraphs {
        if let Some(elements) = para.as_array() {
            for elem in elements {
                match elem["tag"].as_str().unwrap_or("") {
                    "text" | "a" => {
                        if let Some(t) = elem["text"].as_str() {
                            let trimmed = t.trim();
                            if !trimmed.is_empty() {
                                text_parts.push(trimmed.to_string());
                            }
                        }
                    }
                    "img" => {
                        if let Some(key) = elem["image_key"].as_str() {
                            if !key.is_empty() {
                                image_keys.push(key.to_string());
                            }
                        }
                    }
                    _ => {}
                }
            }
        }
    }

    let title = root["title"].as_str().unwrap_or("").trim();
    if !title.is_empty() {
        text_parts.insert(0, title.to_string());
    }

    (text_parts.join(" "), image_keys)
}

pub fn parse_card_action_event(event: &serde_json::Value) -> Option<(String, String)> {
    let event_type = event
        .pointer("/header/event_type")
        .and_then(|v| v.as_str())?;
    if event_type != "card.action.trigger" {
        return None;
    }

    let chat_id = event
        .pointer("/event/action/value/chat_id")
        .and_then(|v| v.as_str())
        .or_else(|| {
            event
                .pointer("/event/context/open_chat_id")
                .and_then(|v| v.as_str())
        })?
        .to_string();
    let command = event
        .pointer("/event/action/value/command")
        .and_then(|v| v.as_str())?
        .trim()
        .to_string();

    Some((chat_id, command))
}

pub fn extract_message_chat_id(event: &serde_json::Value) -> Option<String> {
    let event_type = event
        .pointer("/header/event_type")
        .and_then(|v| v.as_str())?;
    if event_type != "im.message.receive_v1" {
        return None;
    }
    event
        .pointer("/event/message/chat_id")
        .and_then(|v| v.as_str())
        .map(String::from)
}

#[cfg(test)]
fn parse_message_event(event: &serde_json::Value) -> Option<(String, String)> {
    let parsed = parse_message_event_full(event)?;
    if parsed.text.is_empty() {
        return None;
    }
    Some((parsed.chat_id, parsed.text))
}

#[cfg(test)]
fn parse_ws_event(event: &serde_json::Value) -> Option<(String, String)> {
    parse_message_event(event).or_else(|| parse_card_action_event(event))
}

pub fn extract_service_id_from_url(url: &str) -> i32 {
    url.split('?')
        .nth(1)
        .and_then(|qs| {
            qs.split('&').find_map(|pair| {
                let mut kv = pair.splitn(2, '=');
                match (kv.next(), kv.next()) {
                    (Some("service_id"), Some(v)) => v.parse::<i32>().ok(),
                    _ => None,
                }
            })
        })
        .unwrap_or(0)
}

fn truncate_for_error(s: &str, max: usize) -> String {
    if s.len() <= max {
        return s.to_string();
    }
    let mut end = max;
    while end > 0 && !s.is_char_boundary(end) {
        end -= 1;
    }
    format!("{}...", &s[..end])
}

#[derive(Debug, Default, Clone)]
struct FeishuFrame {
    pub seq_id: u64,
    pub log_id: u64,
    pub service: i32,
    pub method: i32,
    pub headers: Vec<(String, String)>,
    pub payload_encoding: String,
    pub payload_type: String,
    pub payload: Vec<u8>,
    pub log_id_new: String,
}

const FRAME_TYPE_CONTROL: i32 = 0;
const FRAME_TYPE_DATA: i32 = 1;

impl FeishuFrame {
    fn get_header(&self, key: &str) -> Option<&str> {
        self.headers
            .iter()
            .find(|(k, _)| k == key)
            .map(|(_, v)| v.as_str())
    }

    fn new_ping(service_id: i32) -> Self {
        FeishuFrame {
            method: FRAME_TYPE_CONTROL,
            service: service_id,
            headers: vec![("type".into(), "ping".into())],
            ..Default::default()
        }
    }

    fn new_response(original: &FeishuFrame, status_code: u16) -> Self {
        let mut headers = original.headers.clone();
        headers.push(("biz_rt".into(), "0".into()));
        FeishuFrame {
            seq_id: original.seq_id,
            log_id: original.log_id,
            service: original.service,
            method: original.method,
            headers,
            payload: serde_json::to_vec(&serde_json::json!({"code": status_code}))
                .unwrap_or_default(),
            log_id_new: original.log_id_new.clone(),
            ..Default::default()
        }
    }
}

fn decode_varint(data: &[u8], pos: &mut usize) -> Option<u64> {
    let mut result: u64 = 0;
    let mut shift = 0u32;
    loop {
        if *pos >= data.len() {
            return None;
        }
        let byte = data[*pos];
        *pos += 1;
        result |= ((byte & 0x7F) as u64) << shift;
        if byte & 0x80 == 0 {
            return Some(result);
        }
        shift += 7;
        if shift >= 64 {
            return None;
        }
    }
}

fn encode_varint(mut val: u64) -> Vec<u8> {
    let mut buf = Vec::with_capacity(10);
    loop {
        let mut byte = (val & 0x7F) as u8;
        val >>= 7;
        if val != 0 {
            byte |= 0x80;
        }
        buf.push(byte);
        if val == 0 {
            break;
        }
    }
    buf
}

fn read_len<'a>(data: &'a [u8], pos: &mut usize) -> Option<&'a [u8]> {
    let len = decode_varint(data, pos)? as usize;
    if *pos + len > data.len() {
        return None;
    }
    let slice = &data[*pos..*pos + len];
    *pos += len;
    Some(slice)
}

fn decode_header(data: &[u8]) -> Option<(String, String)> {
    let mut pos = 0;
    let (mut key, mut val) = (String::new(), String::new());
    while pos < data.len() {
        let tag = decode_varint(data, &mut pos)? as u32;
        match (tag >> 3, tag & 7) {
            (1, 2) => key = String::from_utf8_lossy(read_len(data, &mut pos)?).into(),
            (2, 2) => val = String::from_utf8_lossy(read_len(data, &mut pos)?).into(),
            (_, 0) => {
                decode_varint(data, &mut pos)?;
            }
            (_, 2) => {
                read_len(data, &mut pos)?;
            }
            _ => return None,
        }
    }
    Some((key, val))
}

fn decode_frame(data: &[u8]) -> Option<FeishuFrame> {
    let mut pos = 0;
    let mut f = FeishuFrame::default();
    while pos < data.len() {
        let tag = decode_varint(data, &mut pos)? as u32;
        match (tag >> 3, tag & 7) {
            (1, 0) => f.seq_id = decode_varint(data, &mut pos)?,
            (2, 0) => f.log_id = decode_varint(data, &mut pos)?,
            (3, 0) => f.service = decode_varint(data, &mut pos)? as i32,
            (4, 0) => f.method = decode_varint(data, &mut pos)? as i32,
            (5, 2) => {
                if let Some(h) = decode_header(read_len(data, &mut pos)?) {
                    f.headers.push(h);
                }
            }
            (6, 2) => {
                f.payload_encoding = String::from_utf8_lossy(read_len(data, &mut pos)?).into()
            }
            (7, 2) => f.payload_type = String::from_utf8_lossy(read_len(data, &mut pos)?).into(),
            (8, 2) => f.payload = read_len(data, &mut pos)?.to_vec(),
            (9, 2) => f.log_id_new = String::from_utf8_lossy(read_len(data, &mut pos)?).into(),
            (_, 0) => {
                decode_varint(data, &mut pos)?;
            }
            (_, 2) => {
                read_len(data, &mut pos)?;
            }
            (_, 5) => {
                pos += 4;
            }
            (_, 1) => {
                pos += 8;
            }
            _ => return None,
        }
    }
    Some(f)
}

fn write_varint(buf: &mut Vec<u8>, field: u32, val: u64) {
    buf.extend(encode_varint((field << 3) as u64));
    buf.extend(encode_varint(val));
}

fn write_bytes(buf: &mut Vec<u8>, field: u32, data: &[u8]) {
    buf.extend(encode_varint(((field << 3) | 2) as u64));
    buf.extend(encode_varint(data.len() as u64));
    buf.extend(data);
}

fn encode_header(key: &str, value: &str) -> Vec<u8> {
    let mut buf = Vec::new();
    write_bytes(&mut buf, 1, key.as_bytes());
    write_bytes(&mut buf, 2, value.as_bytes());
    buf
}

fn encode_frame(frame: &FeishuFrame) -> Vec<u8> {
    let mut buf = Vec::new();
    write_varint(&mut buf, 1, frame.seq_id);
    write_varint(&mut buf, 2, frame.log_id);
    write_varint(&mut buf, 3, frame.service as u64);
    write_varint(&mut buf, 4, frame.method as u64);
    for (k, v) in &frame.headers {
        let hdr = encode_header(k, v);
        write_bytes(&mut buf, 5, &hdr);
    }
    if !frame.payload_encoding.is_empty() {
        write_bytes(&mut buf, 6, frame.payload_encoding.as_bytes());
    }
    if !frame.payload_type.is_empty() {
        write_bytes(&mut buf, 7, frame.payload_type.as_bytes());
    }
    if !frame.payload.is_empty() {
        write_bytes(&mut buf, 8, &frame.payload);
    }
    if !frame.log_id_new.is_empty() {
        write_bytes(&mut buf, 9, frame.log_id_new.as_bytes());
    }
    buf
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn artifact_delivery_checks_provider_success_even_for_http_success() {
        assert!(ensure_feishu_success(&serde_json::json!({"code": 0}), "image message").is_ok());
        for body in [
            serde_json::json!({"code": 999, "msg": "Permission denied"}),
            serde_json::json!({}),
        ] {
            assert!(ensure_feishu_success(&body, "file message").is_err());
        }
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

        let parsed = parse_ws_event(&event);
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

        let parsed = parse_ws_event(&event);
        assert_eq!(
            parsed,
            Some(("oc_actual".to_string(), "/switch_workspace".to_string()))
        );
    }

    #[test]
    fn card_body_removes_slash_command_list() {
        let body = card_body_text(
            BotLanguage::EnUS,
            "Available commands:\n/switch_workspace - List and switch workspaces\n/help - Show this help message",
        );

        assert_eq!(body, "Available commands:\n\nChoose an action below.");
    }

    #[test]
    fn decode_frame_rejects_malformed_binary_payload() {
        assert!(decode_frame(b"not a feishu protobuf frame").is_none());
    }
}

fn ensure_feishu_success(body: &serde_json::Value, operation: &str) -> Result<()> {
    if body.get("code").and_then(|code| code.as_i64()) != Some(0) {
        return Err(anyhow!(
            "Feishu {operation} rejected: {}",
            body.get("msg")
                .and_then(|message| message.as_str())
                .unwrap_or("invalid response")
        ));
    }
    Ok(())
}
