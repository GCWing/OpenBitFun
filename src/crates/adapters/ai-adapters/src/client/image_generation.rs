//! Image generation over an explicit protocol dialect.
//!
//! The dialect alone decides the endpoint, request body shape, size syntax and
//! response parsing, so a new provider is a new dialect arm rather than a new
//! transport. This module deliberately does not know the persisted config shape:
//! callers resolve one configured service into [`ImageGenerationTarget`].
//!
//! Results always come back as decoded bytes. Several providers hand back
//! short-lived URLs (DashScope: 24 hours), so persisting them is the caller's job.

use crate::client::AIClient;
use crate::types::ProxyConfig;
use base64::engine::general_purpose::STANDARD as BASE64_STANDARD;
use base64::Engine as _;
use log::debug;
use openbitfun_core_types::ImageDialect;
use reqwest::Client;
use serde_json::{json, Map, Value};
use std::collections::HashMap;
use std::time::Duration;

/// Whole-request budget. Image generation is slow but not unbounded.
const REQUEST_TIMEOUT_SECS: u64 = 180;
/// Guard against a provider streaming an unbounded body.
const MAX_BODY_BYTES: usize = 64 * 1024 * 1024;
const DEFAULT_MIME: &str = "image/png";
/// Model ID observed in Codex Desktop's standalone Images requests. Legacy
/// service model names described a chat orchestrator and must not be reinterpreted
/// as image model IDs.
const DEFAULT_CODEX_IMAGE_MODEL: &str = "gpt-image-2";

/// Substrings that mean the provider refused on safety grounds rather than
/// failing. Reported separately so the UI can say "blocked" instead of "failed".
const CONTENT_FILTER_MARKERS: &[&str] = &[
    "content_policy",
    "content policy",
    "content_filter",
    "moderation_blocked",
    "safety system",
    "datainspectionfailed",
    "inappropriatecontent",
    "sensitivecontent",
    "risk control",
];

/// Protocol-level target resolved by the caller from one configured service.
pub struct ImageGenerationTarget<'a> {
    pub dialect: ImageDialect,
    pub base_url: &'a str,
    /// Full URL override. When set it replaces `base_url` + dialect path.
    pub request_url: Option<&'a str>,
    pub model: &'a str,
    pub api_key: &'a str,
    pub custom_headers: Option<&'a HashMap<String, String>>,
    /// `Some("replace")` sends only the custom headers.
    pub custom_headers_mode: Option<&'a str>,
    pub skip_ssl_verify: bool,
    pub proxy: Option<ProxyConfig>,
}

impl ImageGenerationTarget<'_> {
    /// Model ID sent to the image service, not an observed backend model.
    pub fn requested_model(&self) -> &str {
        match self.dialect {
            ImageDialect::ChatgptCodex => DEFAULT_CODEX_IMAGE_MODEL,
            _ => self.model,
        }
    }
}

/// One generation call. Unset fields fall back to the provider default.
#[derive(Debug, Clone, Default)]
pub struct ImageGenerationRequest {
    pub prompt: String,
    pub negative_prompt: Option<String>,
    pub size: Option<String>,
    pub n: Option<u32>,
    pub quality: Option<String>,
    pub background: Option<String>,
    pub output_format: Option<String>,
    pub watermark: Option<bool>,
    pub prompt_extend: Option<bool>,
    pub seed: Option<i64>,
}

/// One decoded image.
#[derive(Debug)]
pub struct GeneratedImage {
    pub bytes: Vec<u8>,
    pub mime: String,
}

impl GeneratedImage {
    /// Standard base64 payload for a settings-page preview. Kept on the adapter
    /// so UI hosts do not need to depend on an encoder.
    pub fn base64(&self) -> String {
        use base64::Engine as _;
        base64::engine::general_purpose::STANDARD.encode(&self.bytes)
    }
}

#[derive(Debug)]
pub struct ImageGenerationResponse {
    pub images: Vec<GeneratedImage>,
}

/// Why a generation failed. Kept coarse and stable: the settings surface maps
/// these to distinct guidance instead of showing one opaque error.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum ImageGenerationErrorKind {
    /// The configured service is unusable (missing endpoint, empty prompt).
    Config,
    /// Rejected credentials.
    Auth,
    /// Rate limited or quota exhausted.
    RateLimited,
    /// Rejected request, most often a dialect or parameter mismatch.
    InvalidRequest,
    /// Refused by the provider's safety system.
    ContentFiltered,
    Timeout,
    /// Network layer failure.
    Transport,
    /// Provider-side failure.
    Provider,
    /// The provider answered successfully but produced no image.
    EmptyResult,
}

impl ImageGenerationErrorKind {
    /// Stable wire name consumed by the settings surface. Adding a variant is a
    /// frontend-visible change, so keep these names fixed.
    pub fn wire_name(self) -> &'static str {
        match self {
            Self::Config => "config",
            Self::Auth => "auth",
            Self::RateLimited => "rate_limited",
            Self::InvalidRequest => "invalid_request",
            Self::ContentFiltered => "content_filtered",
            Self::Timeout => "timeout",
            Self::Transport => "transport",
            Self::Provider => "provider",
            Self::EmptyResult => "empty_result",
        }
    }
}

#[derive(Debug)]
pub struct ImageGenerationError {
    pub kind: ImageGenerationErrorKind,
    pub message: String,
}

impl ImageGenerationError {
    fn new(kind: ImageGenerationErrorKind, message: impl Into<String>) -> Self {
        Self {
            kind,
            message: message.into(),
        }
    }

    fn config(message: impl Into<String>) -> Self {
        Self::new(ImageGenerationErrorKind::Config, message)
    }

    fn empty_result(message: impl Into<String>) -> Self {
        Self::new(ImageGenerationErrorKind::EmptyResult, message)
    }
}

impl std::fmt::Display for ImageGenerationError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        write!(f, "{}", self.message)
    }
}

impl std::error::Error for ImageGenerationError {}

/// Resolve the absolute request URL for a target.
///
/// A user may paste either the service root or the full endpoint into the base
/// URL field, so an already-terminated path is not appended twice.
pub(crate) fn endpoint(target: &ImageGenerationTarget<'_>) -> Result<String, ImageGenerationError> {
    if let Some(url) = target
        .request_url
        .map(str::trim)
        .filter(|url| !url.is_empty())
    {
        return Ok(subscription_image_url(target.dialect, url));
    }

    let base_url = subscription_image_url(target.dialect, target.base_url.trim());
    let base = base_url.trim_end_matches('/');
    if base.is_empty() {
        return Err(ImageGenerationError::config(
            "image service has no request url and no base url",
        ));
    }

    let path = target.dialect.endpoint_path();
    if base.ends_with(path) {
        Ok(base.to_string())
    } else {
        Ok(format!("{base}{path}"))
    }
}

/// Older subscription services and login resolvers may still name /responses.
/// Translate that endpoint in memory without rewriting the saved configuration.
fn subscription_image_url(dialect: ImageDialect, url: &str) -> String {
    if dialect == ImageDialect::ChatgptCodex {
        if let Some(root) = url.trim_end_matches('/').strip_suffix("/responses") {
            return format!("{root}{}", dialect.endpoint_path());
        }
    }
    url.to_string()
}

/// Rewrite a size expression to the requested separator.
///
/// `size` stays a dialect-native string in config, so a user who typed the other
/// dialect's separator still gets a valid request instead of a 400.
fn normalize_size(raw: &str, separator: char) -> String {
    let trimmed = raw.trim();
    if trimmed.is_empty() {
        return trimmed.to_string();
    }
    trimmed
        .replace(['x', 'X', '×', '*'], "\u{0}")
        .replace('\u{0}', &separator.to_string())
}

fn clamped_n(request: &ImageGenerationRequest, dialect: ImageDialect) -> u32 {
    request
        .n
        .unwrap_or(1)
        .clamp(1, dialect.max_images_per_request())
}

/// OpenAI Images body. `response_format` is deliberately omitted: the GPT image
/// models return base64 unconditionally and reject the field, while compatible
/// providers may answer with a URL. Both shapes are parsed.
fn openai_body(target: &ImageGenerationTarget<'_>, request: &ImageGenerationRequest) -> Value {
    let mut body = json!({
        "model": target.model,
        "prompt": request.prompt,
        "n": clamped_n(request, target.dialect),
    });
    if let Some(size) = request.size.as_deref() {
        body["size"] = json!(normalize_size(size, 'x'));
    }
    if let Some(quality) = request.quality.as_deref() {
        body["quality"] = json!(quality);
    }
    if let Some(background) = request.background.as_deref() {
        body["background"] = json!(background);
    }
    if let Some(output_format) = request.output_format.as_deref() {
        body["output_format"] = json!(output_format);
    }
    body
}

/// DashScope native Qwen-Image body.
fn dashscope_body(target: &ImageGenerationTarget<'_>, request: &ImageGenerationRequest) -> Value {
    let mut parameters = Map::new();
    if let Some(size) = request.size.as_deref() {
        parameters.insert("size".to_string(), json!(normalize_size(size, '*')));
    }
    parameters.insert("n".to_string(), json!(clamped_n(request, target.dialect)));
    if let Some(negative_prompt) = request.negative_prompt.as_deref() {
        parameters.insert("negative_prompt".to_string(), json!(negative_prompt));
    }
    if let Some(watermark) = request.watermark {
        parameters.insert("watermark".to_string(), json!(watermark));
    }
    if let Some(prompt_extend) = request.prompt_extend {
        parameters.insert("prompt_extend".to_string(), json!(prompt_extend));
    }
    if let Some(seed) = request.seed {
        parameters.insert("seed".to_string(), json!(seed));
    }

    json!({
        "model": target.model,
        "input": {
            "messages": [{
                "role": "user",
                "content": [{ "text": request.prompt }],
            }],
        },
        "parameters": Value::Object(parameters),
    })
}

fn build_body(target: &ImageGenerationTarget<'_>, request: &ImageGenerationRequest) -> Value {
    match target.dialect {
        ImageDialect::OpenAiImages => openai_body(target, request),
        ImageDialect::DashScopeNative => dashscope_body(target, request),
        ImageDialect::ChatgptCodex => chatgpt_codex_body(request),
    }
}

/// Standalone Images JSON request, matching the Codex Desktop capture.
/// Explicit service parameters still win over the observed auto defaults.
/// The subscription endpoint generates one image; no chat model, tools, stream,
/// store, or n fields are sent.
fn chatgpt_codex_body(request: &ImageGenerationRequest) -> Value {
    let mut body = json!({
        "model": DEFAULT_CODEX_IMAGE_MODEL,
        "prompt": request.prompt,
        "background": request.background.as_deref().unwrap_or("opaque"),
        "quality": request.quality.as_deref().unwrap_or("auto"),
        "size": request.size.as_deref().map(|size| normalize_size(size, 'x')).unwrap_or_else(|| "auto".to_string()),
    });
    if let Some(output_format) = request.output_format.as_deref() {
        body["output_format"] = json!(output_format);
    }
    body
}

/// Where a parsed image still has to come from.
#[derive(Debug)]
enum ImageSource {
    Inline { bytes: Vec<u8>, mime: String },
    Remote(String),
}

fn parse_openai_images(value: &Value) -> Result<Vec<ImageSource>, ImageGenerationError> {
    let Some(data) = value.get("data").and_then(Value::as_array) else {
        return Err(ImageGenerationError::new(
            ImageGenerationErrorKind::Provider,
            "response is missing the 'data' array",
        ));
    };

    let mut sources = Vec::new();
    for item in data {
        let inline = item
            .get("b64_json")
            .and_then(Value::as_str)
            .or_else(|| item.get("base64").and_then(Value::as_str));
        if let Some(encoded) = inline {
            let bytes = BASE64_STANDARD.decode(encoded.trim()).map_err(|err| {
                ImageGenerationError::new(
                    ImageGenerationErrorKind::Provider,
                    format!("image payload is not valid base64: {err}"),
                )
            })?;
            let mime = sniff_mime(&bytes).unwrap_or(DEFAULT_MIME).to_string();
            sources.push(ImageSource::Inline { bytes, mime });
            continue;
        }

        let remote = item
            .get("url")
            .and_then(Value::as_str)
            .or_else(|| item.get("image_url").and_then(Value::as_str));
        if let Some(url) = remote {
            sources.push(ImageSource::Remote(url.to_string()));
        }
    }

    Ok(sources)
}

fn parse_dashscope_images(value: &Value) -> Result<Vec<ImageSource>, ImageGenerationError> {
    let mut sources = Vec::new();

    // Synchronous multimodal generation: output.choices[].message.content[].image
    if let Some(choices) = value.pointer("/output/choices").and_then(Value::as_array) {
        for choice in choices {
            let Some(content) = choice.pointer("/message/content").and_then(Value::as_array) else {
                continue;
            };
            for part in content {
                if let Some(image) = part.get("image").and_then(Value::as_str) {
                    sources.push(ImageSource::Remote(image.to_string()));
                }
            }
        }
    }

    // Task-shaped results: output.results[].url
    if let Some(results) = value.pointer("/output/results").and_then(Value::as_array) {
        for result in results {
            if let Some(url) = result.get("url").and_then(Value::as_str) {
                sources.push(ImageSource::Remote(url.to_string()));
            }
        }
    }

    Ok(sources)
}

fn parse_images(
    dialect: ImageDialect,
    value: &Value,
) -> Result<Vec<ImageSource>, ImageGenerationError> {
    match dialect {
        ImageDialect::OpenAiImages => parse_openai_images(value),
        ImageDialect::DashScopeNative => parse_dashscope_images(value),
        ImageDialect::ChatgptCodex => parse_openai_images(value),
    }
}

/// Error body of a rejected subscription request.
///
/// The Codex backend answers JSON (`{"detail": ...}` for request problems,
/// `{"error": {...}}` for API errors), just like a successful Images JSON response.
fn chatgpt_codex_error(status: reqwest::StatusCode, raw: &[u8]) -> ImageGenerationError {
    let value: Value = serde_json::from_slice(raw).unwrap_or(Value::Null);
    if let Some(detail) = value.get("detail").and_then(Value::as_str) {
        return ImageGenerationError::new(
            classify_status(status),
            format!("provider rejected the request: {detail}"),
        );
    }
    if !value.is_null() {
        return error_from_response(status, &value);
    }
    ImageGenerationError::new(
        classify_status(status),
        format!(
            "provider rejected the request (HTTP {status}): {}",
            String::from_utf8_lossy(&raw[..raw.len().min(200)])
        ),
    )
}

/// Extract a provider error from the shapes seen in the wild:
/// `{error:{code,message}}`, `{code,message}` and DashScope's `{output:{code,message}}`.
fn extract_error(value: &Value) -> Option<(Option<String>, String)> {
    if let Some(error) = value.get("error") {
        if let Some(message) = error.get("message").and_then(Value::as_str) {
            return Some((
                error
                    .get("code")
                    .and_then(Value::as_str)
                    .map(str::to_string),
                message.to_string(),
            ));
        }
        if let Some(message) = error.as_str() {
            return Some((None, message.to_string()));
        }
    }

    if let Some(message) = value.get("message").and_then(Value::as_str) {
        return Some((
            value
                .get("code")
                .and_then(Value::as_str)
                .map(str::to_string),
            message.to_string(),
        ));
    }

    if let Some(output) = value.get("output") {
        if let Some(message) = output.get("message").and_then(Value::as_str) {
            return Some((
                output
                    .get("code")
                    .and_then(Value::as_str)
                    .map(str::to_string),
                message.to_string(),
            ));
        }
    }

    None
}

fn looks_like_content_filter(message: &str) -> bool {
    let lowered = message.to_lowercase();
    CONTENT_FILTER_MARKERS
        .iter()
        .any(|marker| lowered.contains(marker))
}

/// DashScope reports an asynchronous failure inside a 200 response.
fn dialect_reported_failure(dialect: ImageDialect, value: &Value) -> Option<String> {
    if dialect != ImageDialect::DashScopeNative {
        return None;
    }
    let status = value
        .pointer("/output/task_status")
        .and_then(Value::as_str)?;
    matches!(status, "FAILED" | "CANCELED" | "UNKNOWN").then(|| status.to_string())
}

fn classify_status(status: reqwest::StatusCode) -> ImageGenerationErrorKind {
    match status.as_u16() {
        401 | 403 => ImageGenerationErrorKind::Auth,
        429 => ImageGenerationErrorKind::RateLimited,
        408 | 504 => ImageGenerationErrorKind::Timeout,
        400 | 404 | 405 | 409 | 413 | 415 | 422 => ImageGenerationErrorKind::InvalidRequest,
        _ => ImageGenerationErrorKind::Provider,
    }
}

fn error_from_response(status: reqwest::StatusCode, value: &Value) -> ImageGenerationError {
    let kind = classify_status(status);
    let (code, message) = match extract_error(value) {
        Some((code, message)) => (code, message),
        None => (None, value.to_string()),
    };
    let message = match code {
        Some(code) => format!("provider rejected the request ({code}): {message}"),
        None => format!("provider rejected the request: {message}"),
    };
    let kind = if looks_like_content_filter(&message) {
        ImageGenerationErrorKind::ContentFiltered
    } else {
        kind
    };
    ImageGenerationError::new(kind, message)
}

fn classify_transport(err: reqwest::Error) -> ImageGenerationError {
    let kind = if err.is_timeout() {
        ImageGenerationErrorKind::Timeout
    } else {
        ImageGenerationErrorKind::Transport
    };
    // A timeout message that names the budget lets the reader tell "slow
    // provider" apart from "unreachable endpoint" without a rebuild.
    let budget = if err.is_timeout() {
        let seconds = if err.is_connect() {
            AIClient::STREAM_CONNECT_TIMEOUT_SECS
        } else {
            REQUEST_TIMEOUT_SECS
        };
        format!(" after waiting up to {seconds}s")
    } else {
        String::new()
    };
    ImageGenerationError::new(
        kind,
        format!(
            "image generation request failed while {}{budget}: {err}",
            transport_stage(&err)
        ),
    )
}

/// Name the step that failed so a connection problem is diagnosable.
///
/// reqwest only exposes a flat error, so the stage is read from the source text.
/// Callers see the same kind either way; this only improves the message.
fn transport_stage(err: &reqwest::Error) -> &'static str {
    let text = err.to_string().to_lowercase();
    if text.contains("dns error") || text.contains("failed to lookup address") {
        "resolving the host name"
    } else if text.contains("certificate")
        || text.contains("tls")
        || text.contains("handshake")
        || text.contains("invalidcertificate")
    {
        "negotiating TLS"
    } else if text.contains("connection refused") || text.contains("connection reset") {
        "connecting to the host"
    } else if text.contains("timeout") || text.contains("timed out") {
        "waiting for the response"
    } else {
        "sending the request"
    }
}

fn sniff_mime(bytes: &[u8]) -> Option<&'static str> {
    if bytes.starts_with(&[0x89, b'P', b'N', b'G']) {
        return Some("image/png");
    }
    if bytes.starts_with(&[0xFF, 0xD8, 0xFF]) {
        return Some("image/jpeg");
    }
    if bytes.len() >= 12 && &bytes[0..4] == b"RIFF" && &bytes[8..12] == b"WEBP" {
        return Some("image/webp");
    }
    if bytes.starts_with(b"GIF8") {
        return Some("image/gif");
    }
    None
}

async fn download_image(
    client: &Client,
    url: &str,
) -> Result<(Vec<u8>, String), ImageGenerationError> {
    let response = client
        .get(url)
        .timeout(Duration::from_secs(REQUEST_TIMEOUT_SECS))
        .send()
        .await
        .map_err(classify_transport)?;

    let status = response.status();
    let header_mime = response
        .headers()
        .get(reqwest::header::CONTENT_TYPE)
        .and_then(|value| value.to_str().ok())
        .map(|value| {
            value
                .split(';')
                .next()
                .unwrap_or(DEFAULT_MIME)
                .trim()
                .to_string()
        })
        .filter(|value| value.starts_with("image/"));

    let bytes = response.bytes().await.map_err(classify_transport)?;
    if !status.is_success() {
        return Err(ImageGenerationError::new(
            classify_status(status),
            format!("failed to download the generated image: HTTP {status}"),
        ));
    }
    if bytes.len() > MAX_BODY_BYTES {
        return Err(ImageGenerationError::new(
            ImageGenerationErrorKind::Provider,
            "generated image exceeds the size limit",
        ));
    }

    let mime = header_mime
        .or_else(|| sniff_mime(&bytes).map(str::to_string))
        .unwrap_or_else(|| DEFAULT_MIME.to_string());
    Ok((bytes.to_vec(), mime))
}

/// Generate images for one configured service.
pub async fn generate(
    target: &ImageGenerationTarget<'_>,
    request: ImageGenerationRequest,
) -> Result<ImageGenerationResponse, ImageGenerationError> {
    if request.prompt.trim().is_empty() {
        return Err(ImageGenerationError::config("prompt must not be empty"));
    }
    if target.dialect != ImageDialect::ChatgptCodex && target.model.trim().is_empty() {
        return Err(ImageGenerationError::config("model name must not be empty"));
    }
    if target.dialect == ImageDialect::ChatgptCodex {
        if let Some(format) = request.output_format.as_deref() {
            if !matches!(format, "png" | "jpeg" | "webp" | "gif") {
                return Err(ImageGenerationError::config(
                    "subscription image output_format must be png, jpeg, webp, or gif",
                ));
            }
        }
    }

    let url = endpoint(target)?;
    let client =
        crate::client::http::create_http_client(target.proxy.clone(), target.skip_ssl_verify);

    let body = build_body(target, &request);
    let model = body
        .get("model")
        .and_then(Value::as_str)
        .unwrap_or_default();

    debug!(
        "Image generation request: dialect={:?} model={} url={}",
        target.dialect, model, url
    );

    let payload = serde_json::to_vec(&body).map_err(|err| {
        ImageGenerationError::config(format!("failed to encode the request body: {err}"))
    })?;

    let has_custom_headers = target
        .custom_headers
        .is_some_and(|headers| !headers.is_empty());
    let merge_headers = target.custom_headers_mode.as_deref() != Some("replace");

    let mut builder = client
        .post(&url)
        .timeout(Duration::from_secs(REQUEST_TIMEOUT_SECS))
        .body(payload);

    if !has_custom_headers || merge_headers {
        builder = builder
            .header(reqwest::header::CONTENT_TYPE, "application/json")
            .header(
                reqwest::header::AUTHORIZATION,
                format!("Bearer {}", target.api_key.trim()),
            );
    }
    if let Some(headers) = target.custom_headers {
        for (key, value) in headers {
            builder = builder.header(key.as_str(), value.as_str());
        }
    }

    let response = builder.send().await.map_err(classify_transport)?;
    let status = response.status();
    let raw = response.bytes().await.map_err(classify_transport)?;
    if raw.len() > MAX_BODY_BYTES {
        return Err(ImageGenerationError::new(
            ImageGenerationErrorKind::Provider,
            "image generation response exceeds the size limit",
        ));
    }

    if target.dialect == ImageDialect::ChatgptCodex && !status.is_success() {
        return Err(chatgpt_codex_error(status, &raw));
    }

    let value: Value = serde_json::from_slice(&raw).map_err(|err| {
        ImageGenerationError::new(
            classify_status(status),
            format!(
                "provider returned a non-JSON response (HTTP {status}): {err}; body starts with {:?}",
                String::from_utf8_lossy(&raw[..raw.len().min(120)])
            ),
        )
    })?;

    if !status.is_success() {
        return Err(error_from_response(status, &value));
    }

    if let Some(task_status) = dialect_reported_failure(target.dialect, &value) {
        let (code, message) = extract_error(&value)
            .map(|(code, message)| (code, message))
            .unwrap_or((None, format!("task finished with status {task_status}")));
        return Err(ImageGenerationError::new(
            ImageGenerationErrorKind::Provider,
            match code {
                Some(code) => format!("image task failed ({code}): {message}"),
                None => format!("image task failed: {message}"),
            },
        ));
    }

    if let Some((code, message)) = extract_error(&value) {
        // Some compatible providers answer 200 with an error envelope.
        let kind = if looks_like_content_filter(&message) {
            ImageGenerationErrorKind::ContentFiltered
        } else {
            ImageGenerationErrorKind::Provider
        };
        return Err(ImageGenerationError::new(
            kind,
            match code {
                Some(code) => format!("provider returned an error ({code}): {message}"),
                None => format!("provider returned an error: {message}"),
            },
        ));
    }

    let sources = parse_images(target.dialect, &value)?;
    if sources.is_empty() {
        return Err(ImageGenerationError::empty_result(
            "provider returned no images",
        ));
    }

    let mut images = Vec::with_capacity(sources.len());
    for source in sources {
        match source {
            ImageSource::Inline { bytes, mime } => images.push(GeneratedImage { bytes, mime }),
            ImageSource::Remote(url) => {
                let (bytes, mime) = download_image(&client, &url).await?;
                images.push(GeneratedImage { bytes, mime });
            }
        }
    }

    debug!(
        "Image generation finished: dialect={:?} images={}",
        target.dialect,
        images.len()
    );

    Ok(ImageGenerationResponse { images })
}

#[cfg(test)]
mod tests {
    use super::*;

    fn target<'a>(dialect: ImageDialect, base_url: &'a str) -> ImageGenerationTarget<'a> {
        ImageGenerationTarget {
            dialect,
            base_url,
            request_url: None,
            model: "test-model",
            api_key: "sk-test",
            custom_headers: None,
            custom_headers_mode: None,
            skip_ssl_verify: false,
            proxy: None,
        }
    }

    #[test]
    fn endpoint_appends_the_dialect_path() {
        assert_eq!(
            endpoint(&target(
                ImageDialect::OpenAiImages,
                "https://api.openai.com/v1"
            ))
            .unwrap(),
            "https://api.openai.com/v1/images/generations"
        );
        assert_eq!(
            endpoint(&target(
                ImageDialect::DashScopeNative,
                "https://dashscope.aliyuncs.com/api/v1/"
            ))
            .unwrap(),
            "https://dashscope.aliyuncs.com/api/v1/services/aigc/multimodal-generation/generation"
        );
    }

    #[test]
    fn endpoint_does_not_append_the_path_twice() {
        let url = "https://api.openai.com/v1/images/generations";
        assert_eq!(
            endpoint(&target(ImageDialect::OpenAiImages, url)).unwrap(),
            url
        );
    }

    #[test]
    fn request_url_override_wins() {
        let mut service = target(ImageDialect::OpenAiImages, "https://api.openai.com/v1");
        service.request_url = Some("https://proxy.example.com/custom/path");
        assert_eq!(
            endpoint(&service).unwrap(),
            "https://proxy.example.com/custom/path"
        );
    }

    #[test]
    fn endpoint_requires_some_url() {
        let error = endpoint(&target(ImageDialect::OpenAiImages, "   ")).unwrap_err();
        assert_eq!(error.kind, ImageGenerationErrorKind::Config);
    }

    #[test]
    fn size_separator_follows_the_dialect() {
        assert_eq!(normalize_size("1024x1024", 'x'), "1024x1024");
        assert_eq!(normalize_size("1024*1024", 'x'), "1024x1024");
        assert_eq!(normalize_size("2048*2048", '*'), "2048*2048");
        assert_eq!(normalize_size("2048x1152", '*'), "2048*1152");
    }

    #[test]
    fn openai_body_omits_absent_optional_fields() {
        let body = openai_body(
            &target(ImageDialect::OpenAiImages, "https://api.openai.com/v1"),
            &ImageGenerationRequest {
                prompt: "a red fox".to_string(),
                ..ImageGenerationRequest::default()
            },
        );

        assert_eq!(body["model"], "test-model");
        assert_eq!(body["prompt"], "a red fox");
        assert_eq!(body["n"], 1);
        assert!(body.get("size").is_none());
        assert!(body.get("quality").is_none());
        assert!(body.get("response_format").is_none());
    }

    #[test]
    fn openai_body_uses_x_separator_and_clamps_n() {
        let body = openai_body(
            &target(ImageDialect::OpenAiImages, "https://api.openai.com/v1"),
            &ImageGenerationRequest {
                prompt: "a red fox".to_string(),
                size: Some("1024*1536".to_string()),
                n: Some(99),
                quality: Some("high".to_string()),
                ..ImageGenerationRequest::default()
            },
        );

        assert_eq!(body["size"], "1024x1536");
        assert_eq!(body["n"], 10);
        assert_eq!(body["quality"], "high");
    }

    #[test]
    fn codex_body_matches_the_desktop_images_capture() {
        let body = chatgpt_codex_body(&ImageGenerationRequest {
            prompt: "a red fox".to_string(),
            ..ImageGenerationRequest::default()
        });
        assert_eq!(
            body,
            json!({
                "model": "gpt-image-2", "prompt": "a red fox",
                "background": "opaque", "quality": "auto", "size": "auto"
            })
        );
    }

    #[test]
    fn codex_body_preserves_explicit_image_parameters() {
        let body = chatgpt_codex_body(&ImageGenerationRequest {
            prompt: "a red fox".to_string(),
            quality: Some("high".to_string()),
            background: Some("transparent".to_string()),
            size: Some("1024*1536".to_string()),
            n: Some(10),
            ..ImageGenerationRequest::default()
        });
        assert_eq!(
            body,
            json!({
                "model": "gpt-image-2", "prompt": "a red fox",
                "background": "transparent", "quality": "high", "size": "1024x1536"
            })
        );
    }

    #[test]
    fn codex_body_requests_gif_without_changing_the_image_model() {
        let body = chatgpt_codex_body(&ImageGenerationRequest {
            prompt: "a fox blinking in a seamless loop".to_string(),
            output_format: Some("gif".to_string()),
            ..ImageGenerationRequest::default()
        });
        assert_eq!(body["output_format"], "gif");
        assert_eq!(body["model"], "gpt-image-2");
        assert_eq!(body["size"], "auto");
    }

    #[test]
    fn dashscope_body_nests_prompt_and_uses_star_separator() {
        let body = dashscope_body(
            &target(
                ImageDialect::DashScopeNative,
                "https://dashscope.aliyuncs.com/api/v1",
            ),
            &ImageGenerationRequest {
                prompt: "a red fox".to_string(),
                size: Some("2048x1152".to_string()),
                n: Some(99),
                negative_prompt: Some("blur".to_string()),
                watermark: Some(false),
                prompt_extend: Some(true),
                seed: Some(42),
                ..ImageGenerationRequest::default()
            },
        );

        assert_eq!(body["input"]["messages"][0]["role"], "user");
        assert_eq!(
            body["input"]["messages"][0]["content"][0]["text"],
            "a red fox"
        );
        assert_eq!(body["parameters"]["size"], "2048*1152");
        assert_eq!(body["parameters"]["n"], 6);
        assert_eq!(body["parameters"]["negative_prompt"], "blur");
        assert_eq!(body["parameters"]["watermark"], false);
        assert_eq!(body["parameters"]["prompt_extend"], true);
        assert_eq!(body["parameters"]["seed"], 42);
    }

    #[test]
    fn openai_parser_reads_inline_and_remote_sources() {
        let inline = BASE64_STANDARD.encode([0x89, b'P', b'N', b'G', 1, 2, 3]);
        let value = json!({
            "data": [
                { "b64_json": inline },
                { "url": "https://example.com/a.png" }
            ]
        });

        let sources = parse_openai_images(&value).unwrap();

        assert_eq!(sources.len(), 2);
        match &sources[0] {
            ImageSource::Inline { bytes, mime } => {
                assert_eq!(mime, "image/png");
                assert_eq!(bytes.len(), 7);
            }
            ImageSource::Remote(_) => panic!("expected an inline image"),
        }
        match &sources[1] {
            ImageSource::Remote(url) => assert_eq!(url, "https://example.com/a.png"),
            ImageSource::Inline { .. } => panic!("expected a remote image"),
        }
    }

    #[test]
    fn openai_parser_rejects_a_payload_without_data() {
        let error = parse_openai_images(&json!({"unexpected": true})).unwrap_err();
        assert_eq!(error.kind, ImageGenerationErrorKind::Provider);
    }

    #[test]
    fn dashscope_parser_reads_nested_content_images() {
        let value = json!({
            "output": {
                "task_status": "SUCCEEDED",
                "choices": [{
                    "message": {
                        "content": [
                            { "image": "https://example.com/a.png" },
                            { "image": "https://example.com/b.png" }
                        ]
                    }
                }]
            }
        });

        let sources = parse_dashscope_images(&value).unwrap();

        assert_eq!(sources.len(), 2);
        match &sources[1] {
            ImageSource::Remote(url) => assert_eq!(url, "https://example.com/b.png"),
            ImageSource::Inline { .. } => panic!("expected a remote image"),
        }
    }

    #[test]
    fn dashscope_parser_reads_task_results() {
        let value = json!({"output": {"results": [{"url": "https://example.com/a.png"}]}});

        assert_eq!(parse_dashscope_images(&value).unwrap().len(), 1);
    }

    #[test]
    fn error_extraction_covers_the_common_envelopes() {
        assert_eq!(
            extract_error(&json!({"error": {"code": "bad", "message": "nope"}})).unwrap(),
            (Some("bad".to_string()), "nope".to_string())
        );
        assert_eq!(
            extract_error(&json!({"code": "InvalidParameter", "message": "size invalid"})).unwrap(),
            (
                Some("InvalidParameter".to_string()),
                "size invalid".to_string()
            )
        );
        assert_eq!(
            extract_error(
                &json!({"output": {"code": "DataInspectionFailed", "message": "blocked"}})
            )
            .unwrap(),
            (
                Some("DataInspectionFailed".to_string()),
                "blocked".to_string()
            )
        );
        assert!(extract_error(&json!({"data": []})).is_none());
    }

    #[test]
    fn content_filter_is_detected_from_the_provider_message() {
        assert!(looks_like_content_filter(
            "Your request was rejected by the safety system"
        ));
        assert!(looks_like_content_filter("DataInspectionFailed"));
        assert!(!looks_like_content_filter("invalid size parameter"));
    }

    #[test]
    fn status_classification_maps_actionable_kinds() {
        assert_eq!(
            classify_status(reqwest::StatusCode::UNAUTHORIZED),
            ImageGenerationErrorKind::Auth
        );
        assert_eq!(
            classify_status(reqwest::StatusCode::TOO_MANY_REQUESTS),
            ImageGenerationErrorKind::RateLimited
        );
        assert_eq!(
            classify_status(reqwest::StatusCode::BAD_REQUEST),
            ImageGenerationErrorKind::InvalidRequest
        );
        assert_eq!(
            classify_status(reqwest::StatusCode::INTERNAL_SERVER_ERROR),
            ImageGenerationErrorKind::Provider
        );
    }

    #[test]
    fn dashscope_failed_task_status_is_reported() {
        let value = json!({"output": {"task_status": "FAILED"}});
        assert_eq!(
            dialect_reported_failure(ImageDialect::DashScopeNative, &value),
            Some("FAILED".to_string())
        );
        assert_eq!(
            dialect_reported_failure(ImageDialect::OpenAiImages, &value),
            None
        );
    }

    #[test]
    fn mime_sniffing_recognizes_common_formats() {
        assert_eq!(sniff_mime(&[0x89, b'P', b'N', b'G', 0]), Some("image/png"));
        assert_eq!(sniff_mime(&[0xFF, 0xD8, 0xFF, 0]), Some("image/jpeg"));
        assert_eq!(sniff_mime(b"RIFF0000WEBP"), Some("image/webp"));
        assert_eq!(sniff_mime(b"not an image"), None);
    }

    #[tokio::test]
    async fn subscription_posts_images_json_without_discovering_a_chat_model() {
        use axum::{http::HeaderMap, routing::post, Json, Router};
        let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
        let base_url = format!("http://{}", listener.local_addr().unwrap());
        let server = tokio::spawn(async move {
            let app = Router::new().route("/images/generations", post(|headers: HeaderMap, Json(body): Json<Value>| async move {
                assert_eq!(headers["authorization"], "Bearer sk-test");
                assert_eq!(headers["chatgpt-account-id"], "test-account");
                assert_eq!(headers["originator"], "openbitfun");
                assert_eq!(body, json!({"model":"gpt-image-2", "prompt":"a red fox", "background":"opaque", "quality":"auto", "size":"auto"}));
                Json(json!({"created":1793849136_u64,"background":"opaque","quality":"medium","size":"1254x1254",
                    "data":[{"b64_json":"iVBORw0KGgo=", "generation_id":"test-generation"}],
                    "usage":{"total_tokens":2494}}))
            }));
            axum::serve(listener, app).await.unwrap();
        });
        let headers = HashMap::from([
            ("ChatGPT-Account-ID".to_string(), "test-account".to_string()),
            ("originator".to_string(), "openbitfun".to_string()),
        ]);
        let mut target = target(ImageDialect::ChatgptCodex, &base_url);
        let legacy_url = format!("{base_url}/responses");
        target.request_url = Some(&legacy_url);
        target.model = "legacy-chat-model";
        target.custom_headers = Some(&headers);
        let result = generate(
            &target,
            ImageGenerationRequest {
                prompt: "a red fox".to_string(),
                ..ImageGenerationRequest::default()
            },
        )
        .await;
        server.abort();
        let response = result.unwrap();
        assert_eq!(response.images.len(), 1);
        assert_eq!(response.images[0].mime, "image/png");
        assert_eq!(
            response.images[0].bytes,
            BASE64_STANDARD.decode("iVBORw0KGgo=").unwrap()
        );
    }

    #[test]
    fn subscription_legacy_endpoints_are_adapted_without_changing_api_key_routes() {
        let root = "https://chatgpt.com/backend-api/codex";
        let expected = format!("{root}/images/generations");
        for base in [
            root.to_string(),
            format!("{root}/responses/"),
            expected.clone(),
        ] {
            assert_eq!(
                endpoint(&target(ImageDialect::ChatgptCodex, &base)).unwrap(),
                expected
            );
        }
        for old_model in ["", "gpt-6.1-sol", "gpt-6-astra", "gpt-image-2.6-sunburst"] {
            let mut saved = target(ImageDialect::ChatgptCodex, root);
            saved.model = old_model;
            assert_eq!(saved.requested_model(), "gpt-image-2");
            assert_eq!(
                build_body(&saved, &ImageGenerationRequest::default())["model"],
                "gpt-image-2"
            );
        }
        let mut api = target(ImageDialect::OpenAiImages, root);
        api.request_url = Some("https://gateway.example/responses");
        assert_eq!(endpoint(&api).unwrap(), "https://gateway.example/responses");
    }

    #[test]
    fn subscription_json_errors_and_empty_images_are_reported() {
        let error = chatgpt_codex_error(
            reqwest::StatusCode::UNAUTHORIZED,
            br#"{"detail":"login expired"}"#,
        );
        assert_eq!(error.kind, ImageGenerationErrorKind::Auth);
        assert!(error.message.contains("login expired"));
        let error = chatgpt_codex_error(reqwest::StatusCode::BAD_REQUEST, br#"{"error":{"code":"content_policy_violation","message":"blocked by safety system"}}"#);
        assert_eq!(error.kind, ImageGenerationErrorKind::ContentFiltered);
        assert!(
            parse_images(ImageDialect::ChatgptCodex, &json!({"data":[]}))
                .unwrap()
                .is_empty()
        );
        assert!(parse_images(
            ImageDialect::ChatgptCodex,
            &json!({"data":[{"b64_json":"invalid-base64"}]})
        )
        .is_err());
    }

    #[cfg(feature = "subscription-auth")]
    #[tokio::test]
    #[ignore = "requires a real Codex login; performs one billed image generation"]
    async fn probe_codex_subscription_image_generation() {
        let options = crate::subscription_auth::SubscriptionHttpOptions::default();
        let credential = crate::subscription_auth::resolve_with_options(
            crate::subscription_auth::SubscriptionProvider::Codex,
            &options,
        )
        .await
        .expect("codex credential");
        let target = ImageGenerationTarget {
            dialect: ImageDialect::ChatgptCodex,
            base_url: credential.base_url.as_deref().unwrap_or_default(),
            request_url: credential.request_url.as_deref(),
            model: "",
            api_key: &credential.api_key,
            custom_headers: Some(&credential.extra_headers),
            custom_headers_mode: None,
            skip_ssl_verify: false,
            proxy: None,
        };
        println!(
            "Testing subscription image generation: endpoint={} requested_model={}",
            endpoint(&target).unwrap(),
            DEFAULT_CODEX_IMAGE_MODEL
        );
        let output_format = std::env::var("PROBE_CODEX_IMAGE_OUTPUT_FORMAT").ok();
        let prompt = std::env::var("PROBE_CODEX_IMAGE_PROMPT").unwrap_or_else(|_| "A cute minimalist mascot icon with a rounded-rectangle body, two small friendly oval eyes, and a short top antenna ending in a round joystick knob. Use a playful, harmonious color palette selected randomly for each generation, with no fixed colors. Centered composition, clean uncluttered background, polished product illustration.".to_string());
        let response = generate(
            &target,
            ImageGenerationRequest {
                prompt,
                output_format: output_format.clone(),
                ..ImageGenerationRequest::default()
            },
        )
        .await
        .expect("subscription image generation");
        assert!(!response.images.is_empty());
        let output_dir =
            std::env::var_os("PROBE_CODEX_IMAGE_OUTPUT_DIR").map(std::path::PathBuf::from);
        if let Some(directory) = output_dir.as_ref() {
            tokio::fs::create_dir_all(directory)
                .await
                .expect("image output directory");
        }
        for (index, image) in response.images.into_iter().enumerate() {
            assert!(sniff_mime(&image.bytes).is_some());
            println!(
                "Generated image: requested_model={} mime={} bytes={}",
                DEFAULT_CODEX_IMAGE_MODEL,
                image.mime,
                image.bytes.len()
            );
            if let Some(directory) = output_dir.as_ref() {
                let extension = match image.mime.as_str() {
                    "image/jpeg" => "jpg",
                    "image/webp" => "webp",
                    "image/gif" => "gif",
                    _ => "png",
                };
                let path = directory.join(format!("codex-images-{}.{}", index + 1, extension));
                tokio::fs::write(&path, &image.bytes)
                    .await
                    .expect("generated image file");
                println!("Saved generated image: {}", path.display());
            }
            if output_format.as_deref() == Some("gif") {
                assert_eq!(image.mime, "image/gif", "provider must return a real GIF");
            }
        }
    }

    #[tokio::test]
    async fn generate_rejects_an_empty_prompt_before_any_request() {
        let error = generate(
            &target(ImageDialect::OpenAiImages, "https://api.openai.com/v1"),
            ImageGenerationRequest::default(),
        )
        .await
        .unwrap_err();

        assert_eq!(error.kind, ImageGenerationErrorKind::Config);
    }
}
