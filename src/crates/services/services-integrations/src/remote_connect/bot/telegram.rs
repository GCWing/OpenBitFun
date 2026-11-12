//! Telegram Bot API provider client for Remote Connect.

use anyhow::{anyhow, Result};
use log::debug;
use serde::{Deserialize, Serialize};

use super::BotAction;
use crate::remote_connect::ImageAttachment;

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct TelegramConfig {
    pub bot_token: String,
}

#[derive(Debug, Clone)]
pub struct TelegramIncomingMessage {
    pub chat_id: i64,
    pub text: String,
    pub images: Vec<ImageAttachment>,
}

pub struct TelegramBotApi {
    config: TelegramConfig,
}

/// Telegram Bot API hard limit for `sendDocument` uploads (50 MB), aligned
/// across all IM platforms by capping at 30 MB to match Feishu / WeChat.
pub const MAX_TELEGRAM_FILE_BYTES: u64 = 30 * 1024 * 1024;

/// Telegram caps `sendMessage.text` at 4096 UTF-16 code units. We chunk on
/// char boundaries and stay slightly under the limit to leave headroom for
/// any client-side counting differences.
const MAX_TELEGRAM_TEXT_CHUNK: usize = 4000;

fn chunk_text_for_telegram(text: &str) -> Vec<String> {
    if text.len() <= MAX_TELEGRAM_TEXT_CHUNK {
        return vec![text.to_string()];
    }
    let mut out = Vec::new();
    let mut rest = text;
    while !rest.is_empty() {
        if rest.len() <= MAX_TELEGRAM_TEXT_CHUNK {
            out.push(rest.to_string());
            break;
        }
        let mut cut = MAX_TELEGRAM_TEXT_CHUNK;
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

/// A Telegram Bot API response with `ok: false` (or a non-success status).
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum TelegramApiError {
    /// 401: the bot token was revoked or is wrong. Polling cannot recover.
    Unauthorized(String),
    /// 409: another `getUpdates` consumer or an active webhook owns the token.
    Conflict(String),
    /// 429: wait `retry_after` seconds before the next request.
    RateLimited {
        retry_after_secs: u64,
        description: String,
    },
    /// Any other rejection.
    Rejected { code: u16, description: String },
}

impl TelegramApiError {
    /// `None` when the body reports `ok: true` on a success status.
    pub fn from_body(status: u16, body: &serde_json::Value) -> Option<Self> {
        let success = (200..300).contains(&status);
        if success && body.get("ok").and_then(|value| value.as_bool()) == Some(true) {
            return None;
        }
        let code = body
            .get("error_code")
            .and_then(|value| value.as_u64())
            .and_then(|code| u16::try_from(code).ok())
            .unwrap_or(if success { 0 } else { status });
        let description = body
            .get("description")
            .and_then(|value| value.as_str())
            .unwrap_or("invalid response")
            .to_string();
        Some(match code {
            401 => Self::Unauthorized(description),
            409 => Self::Conflict(description),
            429 => Self::RateLimited {
                retry_after_secs: body
                    .pointer("/parameters/retry_after")
                    .and_then(|value| value.as_u64())
                    .unwrap_or(5),
                description,
            },
            code => Self::Rejected { code, description },
        })
    }

    /// Whether polling with the same token can ever succeed again.
    pub fn is_fatal(&self) -> bool {
        matches!(self, Self::Unauthorized(_))
    }

    fn into_send_failure(self, operation: &str) -> super::delivery::SendFailure {
        let message = format!("Telegram {operation} failed: {self}");
        match self {
            Self::RateLimited {
                retry_after_secs, ..
            } => super::delivery::SendFailure::from_status(
                429,
                Some(std::time::Duration::from_secs(retry_after_secs)),
                message,
            ),
            Self::Rejected { code, .. } => {
                super::delivery::SendFailure::from_status(code, None, message)
            }
            Self::Unauthorized(_) | Self::Conflict(_) => {
                super::delivery::SendFailure::permanent(message)
            }
        }
    }
}

impl std::fmt::Display for TelegramApiError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        match self {
            Self::Unauthorized(description) => write!(f, "unauthorized (401): {description}"),
            Self::Conflict(description) => write!(f, "conflict (409): {description}"),
            Self::RateLimited {
                retry_after_secs,
                description,
            } => write!(
                f,
                "rate limited (429), retry after {retry_after_secs}s: {description}"
            ),
            Self::Rejected { code, description } => write!(f, "rejected ({code}): {description}"),
        }
    }
}

impl std::error::Error for TelegramApiError {}

/// Turn a send response into a classified [`super::delivery::SendFailure`].
async fn check_telegram_response(resp: reqwest::Response, operation: &str) -> Result<()> {
    let status = resp.status().as_u16();
    let text = resp.text().await.unwrap_or_default();
    let body = serde_json::from_str::<serde_json::Value>(&text).unwrap_or_default();
    if body.is_null() && (200..300).contains(&status) {
        return Ok(());
    }
    match TelegramApiError::from_body(status, &body) {
        None => Ok(()),
        Some(error) => Err(anyhow::Error::new(error.into_send_failure(operation))),
    }
}

impl TelegramBotApi {
    pub fn new(config: TelegramConfig) -> Self {
        Self { config }
    }

    pub fn config(&self) -> &TelegramConfig {
        &self.config
    }

    fn api_url(&self, method: &str) -> String {
        format!(
            "https://api.telegram.org/bot{}/{}",
            self.config.bot_token, method
        )
    }

    /// Send `text`, split into Telegram-sized parts. Each part is retried with
    /// backoff (honouring `retry_after`); on final failure the error is a
    /// [`super::delivery::UndeliveredText`] holding the unsent parts.
    pub async fn send_message(&self, chat_id: i64, text: &str) -> Result<()> {
        let client = crate::reqwest_client();
        let url = self.api_url("sendMessage");
        super::delivery::send_chunks(
            chunk_text_for_telegram(text),
            &super::delivery::RetryPolicy::default(),
            |chunk| {
                let request = client.post(&url).json(&serde_json::json!({
                    "chat_id": chat_id,
                    "text": chunk,
                }));
                async move {
                    let resp = request.send().await?;
                    check_telegram_response(resp, "sendMessage").await
                }
            },
        )
        .await?;
        debug!("Telegram message sent to chat {chat_id}");
        Ok(())
    }

    /// Send a message with Telegram inline keyboard buttons.
    pub async fn send_message_with_keyboard(
        &self,
        chat_id: i64,
        text: &str,
        actions: &[BotAction],
    ) -> Result<()> {
        let keyboard: Vec<Vec<serde_json::Value>> = actions
            .iter()
            .map(|action| {
                vec![serde_json::json!({
                    "text": action.label,
                    "callback_data": action.command,
                })]
            })
            .collect();

        let client = crate::reqwest_client();
        let resp = client
            .post(self.api_url("sendMessage"))
            .json(&serde_json::json!({
                "chat_id": chat_id,
                "text": text,
                "reply_markup": {
                    "inline_keyboard": keyboard,
                },
            }))
            .send()
            .await?;

        check_telegram_response(resp, "sendMessage (keyboard)").await?;
        debug!("Telegram keyboard message sent to chat {chat_id}");
        Ok(())
    }

    /// The session supplies bytes; the bot transport never resolves local paths.
    pub async fn send_artifact(
        &self,
        chat_id: i64,
        content: super::WorkspaceFileContent,
    ) -> Result<()> {
        if content.bytes.len() as u64 > MAX_TELEGRAM_FILE_BYTES {
            return Err(anyhow!("Telegram file exceeds the upload limit"));
        }
        let photo = telegram_photo_eligible(&content);
        let (method, field) = if photo {
            ("sendPhoto", "photo")
        } else {
            ("sendDocument", "document")
        };

        let part = reqwest::multipart::Part::bytes(content.bytes)
            .file_name(content.name.clone())
            .mime_str("application/octet-stream")?;

        let form = reqwest::multipart::Form::new()
            .text("chat_id", chat_id.to_string())
            .part(field, part);

        let client = crate::reqwest_client();
        let resp = client
            .post(self.api_url(method))
            .multipart(form)
            .send()
            .await?;

        if !resp.status().is_success() {
            let body = resp.text().await.unwrap_or_default();
            return Err(anyhow!("Telegram {method} failed: {body}"));
        }
        let body: serde_json::Value = resp.json().await?;
        if body.get("ok").and_then(|value| value.as_bool()) != Some(true) {
            return Err(anyhow!(
                "Telegram {method} rejected: {}",
                body.get("description")
                    .and_then(|value| value.as_str())
                    .unwrap_or("invalid response")
            ));
        }
        debug!("Telegram artifact sent to chat {chat_id}: {}", content.name);
        Ok(())
    }

    /// Acknowledge a callback query so Telegram removes the button loading state.
    pub async fn answer_callback_query(&self, callback_query_id: &str) {
        let client = crate::reqwest_client();
        let _ = client
            .post(self.api_url("answerCallbackQuery"))
            .json(&serde_json::json!({ "callback_query_id": callback_query_id }))
            .send()
            .await;
    }

    /// Register the bot command menu visible in Telegram's "/" menu.
    pub async fn set_bot_commands(&self) -> Result<()> {
        let client = crate::reqwest_client();
        let commands = serde_json::json!({
            "commands": [
                { "command": "menu", "description": "Show the main menu" },
                { "command": "new", "description": "Create a new session" },
                { "command": "resume", "description": "Resume an existing session" },
                { "command": "switch", "description": "Switch assistant or workspace" },
                { "command": "model", "description": "Switch the session model" },
                { "command": "cancel", "description": "Cancel the current task" },
                { "command": "expert", "description": "Switch to Expert mode" },
                { "command": "assistant", "description": "Switch to Assistant mode" },
                { "command": "settings", "description": "Open settings" },
                { "command": "help", "description": "Show help" },
            ]
        });
        let resp = client
            .post(self.api_url("setMyCommands"))
            .json(&commands)
            .send()
            .await?;
        if !resp.status().is_success() {
            let body = resp.text().await.unwrap_or_default();
            log::warn!("Failed to set Telegram bot commands: {body}");
        }
        Ok(())
    }

    /// Download a Telegram photo by file_id and return it as an ImageAttachment.
    async fn download_photo(&self, file_id: &str) -> Result<ImageAttachment> {
        let client = crate::reqwest_client();

        let resp = client
            .post(self.api_url("getFile"))
            .json(&serde_json::json!({ "file_id": file_id }))
            .send()
            .await?;
        let body: serde_json::Value = resp.json().await?;
        let file_path = body
            .pointer("/result/file_path")
            .and_then(|v| v.as_str())
            .ok_or_else(|| anyhow!("Telegram getFile: missing file_path for file_id={file_id}"))?
            .to_string();

        let download_url = format!(
            "https://api.telegram.org/file/bot{}/{}",
            self.config.bot_token, file_path
        );
        let bytes = client.get(&download_url).send().await?.bytes().await?;

        use base64::Engine as _;
        let b64 = base64::engine::general_purpose::STANDARD.encode(&bytes);
        let mime_type = if file_path.ends_with(".jpg") || file_path.ends_with(".jpeg") {
            "image/jpeg"
        } else if file_path.ends_with(".png") {
            "image/png"
        } else if file_path.ends_with(".gif") {
            "image/gif"
        } else if file_path.ends_with(".webp") {
            "image/webp"
        } else {
            "image/jpeg"
        };
        let data_url = format!("data:{mime_type};base64,{b64}");
        let name = file_path
            .rsplit('/')
            .next()
            .unwrap_or("photo.jpg")
            .to_string();

        debug!(
            "Telegram photo downloaded: file_id={file_id}, size={}B",
            bytes.len()
        );
        Ok(ImageAttachment { name, data_url })
    }

    /// Returns incoming messages from Telegram Bot API long polling.
    pub async fn poll_updates(
        &self,
        last_update_id: i64,
    ) -> Result<(i64, Vec<TelegramIncomingMessage>)> {
        let client = crate::reqwest_client_builder()
            .timeout(std::time::Duration::from_secs(35))
            .build()?;

        let resp = client
            .get(self.api_url("getUpdates"))
            .query(&[
                ("offset", (last_update_id + 1).to_string()),
                ("timeout", "30".to_string()),
            ])
            .send()
            .await?;

        let status = resp.status().as_u16();
        let body: serde_json::Value = resp
            .json()
            .await
            .map_err(|error| anyhow!("Telegram getUpdates returned HTTP {status}: {error}"))?;
        if let Some(error) = TelegramApiError::from_body(status, &body) {
            return Err(anyhow::Error::new(error));
        }
        let results = body["result"].as_array().cloned().unwrap_or_default();

        let mut new_last_update_id = last_update_id;
        let mut messages = Vec::new();
        for update in results {
            if let Some(update_id) = update["update_id"].as_i64() {
                if update_id > new_last_update_id {
                    new_last_update_id = update_id;
                }
            }

            if let Some(cq) = update.get("callback_query") {
                let cq_id = cq["id"].as_str().unwrap_or("").to_string();
                let chat_id = cq.pointer("/message/chat/id").and_then(|v| v.as_i64());
                let data = cq["data"].as_str().map(|s| s.trim().to_string());
                if let (Some(chat_id), Some(data)) = (chat_id, data) {
                    self.answer_callback_query(&cq_id).await;
                    messages.push(TelegramIncomingMessage {
                        chat_id,
                        text: data,
                        images: vec![],
                    });
                }
                continue;
            }

            let Some(chat_id) = update.pointer("/message/chat/id").and_then(|v| v.as_i64()) else {
                continue;
            };

            if let Some(text) = update.pointer("/message/text").and_then(|v| v.as_str()) {
                messages.push(TelegramIncomingMessage {
                    chat_id,
                    text: text.trim().to_string(),
                    images: vec![],
                });
                continue;
            }

            if let Some(photo_array) = update.pointer("/message/photo").and_then(|v| v.as_array()) {
                let file_id = photo_array
                    .last()
                    .and_then(|p| p["file_id"].as_str())
                    .map(|s| s.to_string());

                let caption = update
                    .pointer("/message/caption")
                    .and_then(|v| v.as_str())
                    .unwrap_or("")
                    .trim()
                    .to_string();

                let images = if let Some(fid) = file_id {
                    match self.download_photo(&fid).await {
                        Ok(attachment) => vec![attachment],
                        Err(e) => {
                            log::warn!("Failed to download Telegram photo file_id={fid}: {e}");
                            vec![]
                        }
                    }
                } else {
                    vec![]
                };

                messages.push(TelegramIncomingMessage {
                    chat_id,
                    text: caption,
                    images,
                });
            }
        }

        Ok((new_last_update_id, messages))
    }
}

#[cfg(test)]
mod tests {
    use super::{chunk_text_for_telegram, TelegramApiError};
    use crate::remote_connect::bot::delivery::classify_send_error;
    use serde_json::json;

    #[test]
    fn not_ok_responses_are_classified_errors() {
        assert_eq!(
            TelegramApiError::from_body(200, &json!({"ok": true, "result": []})),
            None
        );
        let unauthorized = TelegramApiError::from_body(
            401,
            &json!({"ok": false, "error_code": 401, "description": "Unauthorized"}),
        )
        .unwrap();
        assert!(unauthorized.is_fatal());
        let conflict = TelegramApiError::from_body(
            409,
            &json!({"ok": false, "error_code": 409,
                "description": "Conflict: terminated by other getUpdates request"}),
        )
        .unwrap();
        assert!(matches!(conflict, TelegramApiError::Conflict(_)));
        assert!(!conflict.is_fatal());
        let limited = TelegramApiError::from_body(
            429,
            &json!({"ok": false, "error_code": 429, "description": "Too Many Requests",
                "parameters": {"retry_after": 7}}),
        )
        .unwrap();
        assert_eq!(
            limited,
            TelegramApiError::RateLimited {
                retry_after_secs: 7,
                description: "Too Many Requests".into()
            }
        );
        // A 200 response that still says ok:false is an error, not an empty batch.
        assert!(matches!(
            TelegramApiError::from_body(200, &json!({"ok": false, "description": "odd"})),
            Some(TelegramApiError::Rejected { code: 0, .. })
        ));
    }

    #[test]
    fn send_failures_retry_only_rate_limits_and_server_errors() {
        let failure = |error: TelegramApiError| {
            classify_send_error(&anyhow::Error::new(error.into_send_failure("sendMessage")))
        };
        assert_eq!(
            failure(TelegramApiError::RateLimited {
                retry_after_secs: 3,
                description: String::new(),
            }),
            (true, Some(std::time::Duration::from_secs(3)))
        );
        assert_eq!(
            failure(TelegramApiError::Rejected {
                code: 502,
                description: String::new(),
            }),
            (true, None)
        );
        assert_eq!(
            failure(TelegramApiError::Rejected {
                code: 400,
                description: String::new(),
            }),
            (false, None)
        );
        assert_eq!(
            failure(TelegramApiError::Unauthorized(String::new())),
            (false, None)
        );
    }

    #[test]
    fn chunks_text_on_char_boundary() {
        let text = "a".repeat(4001);
        let chunks = chunk_text_for_telegram(&text);
        assert_eq!(chunks.len(), 2);
        assert_eq!(chunks[0].len(), 4000);
        assert_eq!(chunks[1], "a");
    }
}

// https://core.telegram.org/bots/api#sendphoto — larger/unusual images retain
// original bytes as documents, including SVG and animated GIF artifacts.
fn telegram_photo_eligible(content: &super::WorkspaceFileContent) -> bool {
    if !matches!(content.mime_type, "image/png" | "image/jpeg")
        || content.bytes.len() > 10 * 1024 * 1024
    {
        return false;
    }
    let Ok(reader) =
        image::ImageReader::new(std::io::Cursor::new(&content.bytes)).with_guessed_format()
    else {
        return false;
    };
    let Ok((width, height)) = reader.into_dimensions() else {
        return false;
    };
    width > 0
        && height > 0
        && u64::from(width) + u64::from(height) <= 10000
        && u64::from(width.max(height)) <= 20 * u64::from(width.min(height))
}
