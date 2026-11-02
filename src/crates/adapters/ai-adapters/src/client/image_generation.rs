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
/// The Responses API has a separate image-tool model. Keep this independent
/// from the subscription's top-level chat model, which is only responsible for
/// orchestrating the tool call and revising the prompt.
const DEFAULT_CODEX_IMAGE_MODEL: &str = "gpt-image-2.5-sunburst";
/// `high` is supported by the current GPT Image models and older GPT Image
/// models, so existing subscription configurations can opt into a quality
/// setting without a persisted-config migration.
const DEFAULT_CODEX_IMAGE_QUALITY: &str = "high";

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
        return Ok(url.to_string());
    }

    let base = target.base_url.trim().trim_end_matches('/');
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
        ImageDialect::ChatgptCodex => chatgpt_codex_body(target.model, request),
    }
}

/// ChatGPT subscription body.
///
/// The image is not requested from an image endpoint: the model is asked to call
/// its built-in `image_generation` tool, and the picture arrives as a Responses
/// output item. `store: false` is required by the Codex backend, and `stream`
/// is what produces the SSE events the caller parses.
fn chatgpt_codex_body(model: &str, request: &ImageGenerationRequest) -> Value {
    let mut tool = json!({
        "type": "image_generation",
        "model": DEFAULT_CODEX_IMAGE_MODEL,
        "quality": request
            .quality
            .as_deref()
            .unwrap_or(DEFAULT_CODEX_IMAGE_QUALITY),
    });
    // The tool accepts the same knobs as the image API. Quality defaults to a
    // high-quality setting above, while an explicit service setting wins.
    if let Some(size) = request.size.as_deref() {
        tool["size"] = json!(normalize_size(size, 'x'));
    }
    if let Some(quality) = request.quality.as_deref() {
        tool["quality"] = json!(quality);
    }
    if let Some(background) = request.background.as_deref() {
        tool["background"] = json!(background);
    }

    json!({
        "model": model,
        "stream": true,
        "store": false,
        "tools": [tool],
        "input": [{
            "role": "user",
            "content": [{ "type": "input_text", "text": request.prompt }],
        }],
    })
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
        // Streamed by `parse_chatgpt_codex_stream`; reaching here means the JSON
        // path was taken for a dialect that never answers with one document.
        ImageDialect::ChatgptCodex => Err(ImageGenerationError::new(
            ImageGenerationErrorKind::Provider,
            "the ChatGPT subscription dialect streams its result and cannot be read as JSON",
        )),
    }
}

/// Reads the Responses SSE transcript and returns the image the model produced.
///
/// The backend emits progress events while the tool runs, so only the terminal
/// `output_item.done` carries `result`. A response that completes without an
/// image item means the model declined to call the tool, which is a different
/// failure from an empty payload and is reported as such.
fn parse_chatgpt_codex_stream(raw: &[u8]) -> Result<Vec<ImageSource>, ImageGenerationError> {
    let text = String::from_utf8_lossy(raw);
    let mut sources = Vec::new();
    let mut failure: Option<(Option<String>, String)> = None;
    let mut completed_without_image = false;

    for line in text.lines() {
        let Some(payload) = line.strip_prefix("data:") else {
            continue;
        };
        let payload = payload.trim();
        if payload.is_empty() || payload == "[DONE]" {
            continue;
        }
        let Ok(value) = serde_json::from_str::<Value>(payload) else {
            continue;
        };
        match value
            .get("type")
            .and_then(Value::as_str)
            .unwrap_or_default()
        {
            "response.output_item.done" => {
                let item = value.get("item");
                if item
                    .and_then(|item| item.get("type"))
                    .and_then(Value::as_str)
                    != Some("image_generation_call")
                {
                    continue;
                }
                let Some(encoded) = item
                    .and_then(|item| item.get("result"))
                    .and_then(Value::as_str)
                else {
                    continue;
                };
                let bytes = BASE64_STANDARD.decode(encoded.trim()).map_err(|err| {
                    ImageGenerationError::new(
                        ImageGenerationErrorKind::Provider,
                        format!("image payload is not valid base64: {err}"),
                    )
                })?;
                let mime = sniff_mime(&bytes).unwrap_or(DEFAULT_MIME).to_string();
                sources.push(ImageSource::Inline { bytes, mime });
            }
            "response.failed" => {
                let error = value.pointer("/response/error");
                failure = Some((
                    error
                        .and_then(|error| error.get("code"))
                        .and_then(Value::as_str)
                        .map(str::to_string),
                    error
                        .and_then(|error| error.get("message"))
                        .and_then(Value::as_str)
                        .unwrap_or("the model reported a failed response")
                        .to_string(),
                ));
            }
            "error" => {
                let error = value.get("error");
                failure = Some((
                    error
                        .and_then(|error| error.get("code"))
                        .and_then(Value::as_str)
                        .map(str::to_string),
                    error
                        .and_then(|error| error.get("message"))
                        .and_then(Value::as_str)
                        .unwrap_or("the provider streamed an error")
                        .to_string(),
                ));
            }
            "response.completed" => completed_without_image = true,
            _ => {}
        }
    }

    if let Some((code, message)) = failure {
        return Err(ImageGenerationError::new(
            codex_stream_error_kind(&message),
            match code {
                Some(code) => format!("provider failed the image request ({code}): {message}"),
                None => format!("provider failed the image request: {message}"),
            },
        ));
    }
    if sources.is_empty() {
        return Err(ImageGenerationError::empty_result(
            if completed_without_image {
                "the response completed without calling the image tool; pick a model that can generate images"
            } else {
                "the provider streamed no image result"
            },
        ));
    }
    Ok(sources)
}

/// Map a streamed error message onto the guidance class the UI renders.
fn codex_stream_error_kind(message: &str) -> ImageGenerationErrorKind {
    let lowered = message.to_ascii_lowercase();
    if looks_like_content_filter(message) {
        ImageGenerationErrorKind::ContentFiltered
    } else if lowered.contains("rate limit") || lowered.contains("usage limit") {
        ImageGenerationErrorKind::RateLimited
    } else if lowered.contains("timed out") || lowered.contains("timeout") {
        ImageGenerationErrorKind::Timeout
    } else {
        ImageGenerationErrorKind::Provider
    }
}

/// Error body of a rejected subscription request.
///
/// The Codex backend answers JSON (`{"detail": ...}` for request problems,
/// `{"error": {...}}` for API errors) even though a successful call streams.
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

/// Ask the account's own catalog which model to drive the image tool with.
async fn discover_chatgpt_codex_model(
    client: &Client,
    target: &ImageGenerationTarget<'_>,
) -> Result<String, ImageGenerationError> {
    let base = match target.request_url {
        Some(request_url) => request_url
            .trim_end_matches('/')
            .trim_end_matches("/responses")
            .to_string(),
        None => target.base_url.trim_end_matches('/').to_string(),
    };
    let url = format!("{base}/models?client_version=1.0.0");

    let mut builder = client
        .get(&url)
        .bearer_auth(target.api_key.trim())
        .timeout(Duration::from_secs(REQUEST_TIMEOUT_SECS));
    if let Some(headers) = target.custom_headers {
        for (key, value) in headers {
            builder = builder.header(key.as_str(), value.as_str());
        }
    }
    let response = builder.send().await.map_err(classify_transport)?;
    let status = response.status();
    let raw = response.bytes().await.map_err(classify_transport)?;
    let value: Value = serde_json::from_slice(&raw).map_err(|err| {
        ImageGenerationError::new(
            classify_status(status),
            format!("could not read the subscription model catalog: {err}"),
        )
    })?;
    if !status.is_success() {
        return Err(error_from_response(status, &value));
    }

    let model = value
        .get("models")
        .and_then(Value::as_array)
        .and_then(|models| {
            let mut entries: Vec<(u64, String)> = models
                .iter()
                .filter_map(|model| {
                    let slug = model.get("slug").and_then(Value::as_str)?.trim();
                    if slug.is_empty() {
                        return None;
                    }
                    let priority = model
                        .get("priority")
                        .and_then(Value::as_u64)
                        .unwrap_or(10_000);
                    Some((priority, slug.to_string()))
                })
                .collect();
            entries.sort_by(|a, b| a.0.cmp(&b.0).then_with(|| a.1.cmp(&b.1)));
            entries.into_iter().next().map(|(_, slug)| slug)
        });

    model.ok_or_else(|| {
        ImageGenerationError::config(
            "the subscription login exposes no model to drive image generation; set a model name explicitly",
        )
    })
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
    // The subscription route asks a chat model to call its image tool, so the
    // model is whatever the account's catalog offers. Discover it when the
    // service left the field empty instead of guessing a slug.
    let discover_model =
        target.dialect == ImageDialect::ChatgptCodex && target.model.trim().is_empty();
    if target.model.trim().is_empty() && !discover_model {
        return Err(ImageGenerationError::config("model name must not be empty"));
    }

    let url = endpoint(target)?;
    let client =
        crate::client::http::create_http_client(target.proxy.clone(), target.skip_ssl_verify);

    let model = if discover_model {
        discover_chatgpt_codex_model(&client, target).await?
    } else {
        target.model.trim().to_string()
    };
    let body = if target.dialect == ImageDialect::ChatgptCodex {
        chatgpt_codex_body(&model, &request)
    } else {
        build_body(target, &request)
    };

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

    // The subscription route answers with an SSE transcript, not a JSON document.
    if target.dialect == ImageDialect::ChatgptCodex {
        if !status.is_success() {
            return Err(chatgpt_codex_error(status, &raw));
        }
        let sources = parse_chatgpt_codex_stream(&raw)?;
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
        return Ok(ImageGenerationResponse { images });
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
    fn codex_body_selects_explicit_high_quality_image_model() {
        let body = chatgpt_codex_body(
            "gpt-6-astra",
            &ImageGenerationRequest {
                prompt: "a red fox".to_string(),
                ..ImageGenerationRequest::default()
            },
        );

        assert_eq!(body["model"], "gpt-6-astra");
        assert_eq!(body["tools"][0]["type"], "image_generation");
        assert_eq!(body["tools"][0]["model"], "gpt-image-2.5-sunburst");
        assert_eq!(body["tools"][0]["quality"], "high");
    }

    #[test]
    fn codex_body_preserves_an_explicit_quality_override() {
        let body = chatgpt_codex_body(
            "gpt-6-astra",
            &ImageGenerationRequest {
                prompt: "a red fox".to_string(),
                quality: Some("max".to_string()),
                ..ImageGenerationRequest::default()
            },
        );

        assert_eq!(body["tools"][0]["quality"], "max");
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
    async fn subscription_catalog_sends_bearer_and_account_headers() {
        use axum::{
            http::{HeaderMap, StatusCode},
            routing::get,
            Json, Router,
        };
        let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
        let base_url = format!("http://{}", listener.local_addr().unwrap());
        let server = tokio::spawn(async move {
            let app = Router::new().route("/models", get(|headers: HeaderMap| async move {
                if headers.get("authorization").and_then(|value| value.to_str().ok()) != Some("Bearer sk-test")
                    || headers.get("chatgpt-account-id").and_then(|value| value.to_str().ok()) != Some("test-account")
                {
                    return (StatusCode::UNAUTHORIZED, Json(json!({"error": {"message": "missing subscription authentication"}})));
                }
                (StatusCode::OK, Json(json!({"models": [{"slug": "account-model", "priority": 0}]})))
            }));
            axum::serve(listener, app).await.unwrap();
        });
        let headers =
            HashMap::from([("ChatGPT-Account-ID".to_string(), "test-account".to_string())]);
        let mut target = target(ImageDialect::ChatgptCodex, &base_url);
        target.custom_headers = Some(&headers);
        openbitfun_services_core::tls_provider::ensure_ring_crypto_provider();
        let client = Client::builder().no_proxy().build().unwrap();
        let result = discover_chatgpt_codex_model(&client, &target).await;
        server.abort();
        assert_eq!(result.unwrap(), "account-model");
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
        let model = std::env::var("PROBE_CODEX_MODEL").unwrap_or_default();
        let target = ImageGenerationTarget {
            dialect: ImageDialect::ChatgptCodex,
            base_url: credential.base_url.as_deref().unwrap_or_default(),
            request_url: credential.request_url.as_deref(),
            model: &model,
            api_key: &credential.api_key,
            custom_headers: Some(&credential.extra_headers),
            custom_headers_mode: None,
            skip_ssl_verify: false,
            proxy: None,
        };
        let response = generate(
            &target,
            ImageGenerationRequest {
                prompt: "A cute minimalist mascot icon with a rounded-rectangle body, two small friendly oval eyes, and a short top antenna ending in a round joystick knob. Use a playful, harmonious color palette selected randomly for each generation, with no fixed colors. Centered composition, clean uncluttered background, polished product illustration.".to_string(),
                size: Some("1024x1024".to_string()),
                n: Some(1),
                ..ImageGenerationRequest::default()
            },
        )
        .await
        .expect("subscription image generation");
        assert!(!response.images.is_empty());
        for image in response.images {
            assert!(sniff_mime(&image.bytes).is_some());
            println!(
                "Generated image: mime={} bytes={}",
                image.mime,
                image.bytes.len()
            );
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
