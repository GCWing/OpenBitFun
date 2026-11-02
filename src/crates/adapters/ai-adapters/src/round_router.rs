//! OpenAI-compatible Router transport and classifier protocol.
//!
//! The consumer supplies isolated input and owns thresholds, model slots, context,
//! traces, and fallback policy. This adapter has no session or config IO.

use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
use std::time::Duration;

const SIMPLE_TOKEN_ID: u32 = 22_944;
const NON_SIMPLE_FIRST_TOKEN_ID: u32 = 6_280;
const ROUTER_TOP_LOGPROBS: usize = 20;
const MAX_ERROR_BODY_BYTES: usize = 16 * 1024;

#[derive(Debug)]
pub enum RouterClientError {
    Http(String),
    ContextOverflow(String),
    Deserialization(String),
}

impl std::fmt::Display for RouterClientError {
    fn fmt(&self, formatter: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        match self {
            Self::Http(message)
            | Self::ContextOverflow(message)
            | Self::Deserialization(message) => formatter.write_str(message),
        }
    }
}

impl std::error::Error for RouterClientError {}

#[derive(Debug)]
pub struct RouterPrediction {
    pub generated_simple: bool,
    pub simple_probability: Option<f64>,
    pub recovered: bool,
    pub raw_output: String,
    pub usage: Option<Value>,
}

impl RouterPrediction {
    /// Total provider-reported prompt usage, including any cached input tokens.
    /// Error-message estimates and alternative/cache-only fields are not usage.
    pub fn prompt_tokens(&self) -> Option<usize> {
        self.usage
            .as_ref()?
            .get("prompt_tokens")?
            .as_u64()
            .filter(|tokens| *tokens > 0)
            .and_then(|tokens| usize::try_from(tokens).ok())
    }
}

pub struct RouterHttpClient {
    client: reqwest::Client,
    endpoint: String,
    service_identity: String,
    model: String,
    system_prompt: String,
    api_key: Option<String>,
    custom_headers: std::collections::HashMap<String, String>,
}

impl RouterHttpClient {
    pub fn new(
        endpoint: String,
        model: String,
        system_prompt: String,
        api_key: Option<String>,
        timeout: Duration,
    ) -> Result<Self, RouterClientError> {
        Self::with_transport(
            endpoint,
            model,
            system_prompt,
            api_key,
            timeout,
            None,
            Default::default(),
            false,
        )
    }

    pub fn with_transport(
        endpoint: String,
        model: String,
        system_prompt: String,
        api_key: Option<String>,
        timeout: Duration,
        proxy: Option<crate::types::ProxyConfig>,
        custom_headers: std::collections::HashMap<String, String>,
        skip_ssl_verify: bool,
    ) -> Result<Self, RouterClientError> {
        let mut url = reqwest::Url::parse(&endpoint)
            .map_err(|_| RouterClientError::Http("Invalid Router URL".into()))?;
        if !matches!(url.scheme(), "http" | "https")
            || !url.username().is_empty()
            || url.password().is_some()
        {
            return Err(RouterClientError::Http(
                "Router URL must use HTTP(S) without embedded credentials".into(),
            ));
        }
        let client =
            crate::client::http::create_router_http_client(timeout, proxy, skip_ssl_verify)
                .map_err(|error| RouterClientError::Http(error.to_string()))?;
        // Query authentication, fragments, model names and credential revisions must
        // not create independent capacity pools for the same service endpoint.
        url.set_query(None);
        url.set_fragment(None);
        let service_identity = url.as_str().trim_end_matches('/').to_string();
        Ok(Self {
            client,
            endpoint,
            service_identity,
            model,
            system_prompt,
            api_key,
            custom_headers,
        })
    }

    /// Opaque canonical endpoint identity for host-owned request admission.
    /// This value is not telemetry and must not be logged.
    pub fn service_identity(&self) -> &str {
        &self.service_identity
    }

    /// Make one bounded request. The runtime owns retries and fallback.
    pub async fn predict(&self, input: &str) -> Result<RouterPrediction, RouterClientError> {
        let body = OpenAiChatRequest {
            model: &self.model,
            messages: [
                OpenAiChatMessage {
                    role: "system",
                    content: &self.system_prompt,
                },
                OpenAiChatMessage {
                    role: "user",
                    content: input,
                },
            ],
            temperature: 0.0,
            top_p: 1.0,
            max_tokens: 128,
            stop: ["\n"],
            logprobs: true,
            top_logprobs: ROUTER_TOP_LOGPROBS,
            return_token_ids: true,
            return_tokens_as_token_ids: true,
            chat_template_kwargs: json!({"enable_thinking": false}),
        };
        let mut request = self.client.post(&self.endpoint).json(&body);
        if let Some(api_key) = self.api_key.as_deref() {
            request = request.bearer_auth(api_key);
        }
        for (name, value) in &self.custom_headers {
            request = request.header(name, value);
        }
        let response = request.send().await.map_err(|error| {
            RouterClientError::Http(format!("Router request failed: {}", error.without_url()))
        })?;
        if !response.status().is_success() {
            return Err(classify_http_failure(response).await);
        }
        let response = response
            .json::<OpenAiChatResponse>()
            .await
            .map_err(|error| {
                RouterClientError::Deserialization(format!(
                    "Failed to decode Router response: {}",
                    error.without_url()
                ))
            })?;
        let choice = response.choices.first().ok_or_else(|| {
            RouterClientError::Deserialization(
                "Router response did not contain a choice".to_string(),
            )
        })?;
        let raw_output = choice.message.content.as_deref().ok_or_else(|| {
            RouterClientError::Deserialization(
                "Router response did not contain assistant content".to_string(),
            )
        })?;
        let (generated_simple, recovered) = parse_router_route(raw_output)?;
        Ok(RouterPrediction {
            generated_simple,
            simple_probability: extract_simple_probability(choice, raw_output, generated_simple),
            recovered,
            raw_output: raw_output.to_string(),
            usage: response.usage,
        })
    }
}

async fn classify_http_failure(mut response: reqwest::Response) -> RouterClientError {
    let status = response.status().as_u16();
    // Authentication, throttling and service failures take precedence over any
    // provider text. A generic oversized HTTP payload is not a model context error.
    if matches!(status, 400 | 413 | 422) {
        let mut body = Vec::new();
        loop {
            match response.chunk().await {
                Ok(Some(chunk))
                    if body.len().saturating_add(chunk.len()) <= MAX_ERROR_BODY_BYTES =>
                {
                    body.extend_from_slice(&chunk);
                }
                Ok(None) => {
                    if is_context_overflow_body(&body) {
                        // Do not include provider messages, request echoes, URLs or credentials.
                        return RouterClientError::ContextOverflow(format!(
                            "Router input exceeds the model context window (HTTP {status})"
                        ));
                    }
                    break;
                }
                Ok(Some(_)) | Err(_) => break,
            }
        }
    }
    RouterClientError::Http(format!("Router returned HTTP {status}"))
}

fn is_context_overflow_body(body: &[u8]) -> bool {
    let Ok(value) = serde_json::from_slice::<Value>(body) else {
        return false;
    };
    let error = value.get("error").unwrap_or(&value);
    let code = error.get("code").and_then(Value::as_str);
    let kind = error.get("type").and_then(Value::as_str);
    let overflow_code = |code: &str| {
        matches!(
            code,
            "context_length_exceeded" | "model_context_window_exceeded" | "context_window_exceeded"
        )
    };
    if code.is_some_and(overflow_code) || kind.is_some_and(overflow_code) {
        return true;
    }
    // Message fallback is confined to OpenAI/vLLM request-validation errors.
    // Never reinterpret an explicit quota/authentication/other provider code.
    if code.is_some_and(|code| !matches!(code, "invalid_request_error" | "BadRequestError"))
        || kind.is_some_and(|kind| !matches!(kind, "invalid_request_error" | "BadRequestError"))
    {
        return false;
    }
    let Some(message) = error.get("message").and_then(Value::as_str) else {
        return false;
    };
    let message = message.trim().to_ascii_lowercase();
    message.starts_with("this model's maximum context length is ")
        && (message.contains("however, you requested ")
            || message.contains("however, your prompt contains ")
            || message.contains("but the prompt contains "))
}

#[derive(Debug, Serialize)]
struct OpenAiChatRequest<'a> {
    model: &'a str,
    messages: [OpenAiChatMessage<'a>; 2],
    temperature: f32,
    top_p: f32,
    max_tokens: usize,
    stop: [&'a str; 1],
    logprobs: bool,
    top_logprobs: usize,
    return_token_ids: bool,
    return_tokens_as_token_ids: bool,
    chat_template_kwargs: Value,
}

#[derive(Debug, Serialize)]
struct OpenAiChatMessage<'a> {
    role: &'a str,
    content: &'a str,
}

#[derive(Debug, Deserialize)]
struct OpenAiChatResponse {
    choices: Vec<OpenAiChatChoice>,
    #[serde(default)]
    usage: Option<Value>,
}

#[derive(Debug, Deserialize)]
struct OpenAiChatChoice {
    message: OpenAiResponseMessage,
    #[serde(default)]
    logprobs: Option<OpenAiChatLogprobs>,
    #[serde(default)]
    token_ids: Option<Vec<u32>>,
}

#[derive(Debug, Deserialize)]
struct OpenAiResponseMessage {
    content: Option<String>,
}

#[derive(Debug, Deserialize)]
struct OpenAiChatLogprobs {
    content: Option<Vec<OpenAiChatLogprobContent>>,
}

#[derive(Debug, Deserialize)]
struct OpenAiChatLogprobContent {
    bytes: Option<Vec<u8>>,
    top_logprobs: Vec<OpenAiTokenLogprob>,
}

#[derive(Debug, Deserialize)]
struct OpenAiTokenLogprob {
    token: String,
    logprob: f64,
}

fn extract_simple_probability(
    choice: &OpenAiChatChoice,
    raw_output: &str,
    generated_route: bool,
) -> Option<f64> {
    let token_ids = choice.token_ids.as_deref()?;
    let logprobs = choice.logprobs.as_ref()?.content.as_deref()?;
    if token_ids.len() != logprobs.len() {
        return None;
    }

    let generated_label_token = match generated_route {
        true => SIMPLE_TOKEN_ID,
        false => NON_SIMPLE_FIRST_TOKEN_ID,
    };
    let label_byte_offset = simple_type_value_byte_offset(raw_output)?;
    let label_index = token_index_at_byte_offset(logprobs, label_byte_offset)?;
    if token_ids.get(label_index).copied()? != generated_label_token {
        return None;
    }
    let candidates = &logprobs.get(label_index)?.top_logprobs;
    let simple_logprob = find_token_logprob(candidates, SIMPLE_TOKEN_ID)?;
    let non_simple_logprob = find_token_logprob(candidates, NON_SIMPLE_FIRST_TOKEN_ID)?;

    // Renormalize over the two routing classes only. Log-probabilities differ
    // from raw logits by the same log-softmax constant, so this is equivalent
    // to a two-class softmax over their logits.
    let maximum = simple_logprob.max(non_simple_logprob);
    let simple_weight = (simple_logprob - maximum).exp();
    let non_simple_weight = (non_simple_logprob - maximum).exp();
    Some(simple_weight / (simple_weight + non_simple_weight))
}

fn simple_type_value_byte_offset(raw_output: &str) -> Option<usize> {
    let first_line = raw_output.lines().next()?;
    let key_offset = first_line.find("\"simple_type\"")?;
    let after_key_offset = key_offset + "\"simple_type\"".len();
    let after_key = &first_line[after_key_offset..];
    let colon_offset = after_key.find(':')?;
    let after_colon_offset = after_key_offset + colon_offset + 1;
    let whitespace_bytes = first_line[after_colon_offset..]
        .len()
        .saturating_sub(first_line[after_colon_offset..].trim_start().len());
    let opening_quote_offset = after_colon_offset + whitespace_bytes;
    if first_line.as_bytes().get(opening_quote_offset) != Some(&b'"') {
        return None;
    }
    Some(opening_quote_offset + 1)
}

fn token_index_at_byte_offset(
    logprobs: &[OpenAiChatLogprobContent],
    target_offset: usize,
) -> Option<usize> {
    let mut current_offset: usize = 0;
    for (index, token) in logprobs.iter().enumerate() {
        let token_bytes = token.bytes.as_deref()?;
        let next_offset = current_offset.checked_add(token_bytes.len())?;
        if (current_offset..next_offset).contains(&target_offset) {
            return Some(index);
        }
        current_offset = next_offset;
    }
    None
}

fn find_token_logprob(candidates: &[OpenAiTokenLogprob], token_id: u32) -> Option<f64> {
    let expected = format!("token_id:{token_id}");
    // Some compatible services decode top candidates despite return_tokens_as_token_ids.
    // Accept only the classifier's two known token spellings; the generated
    // token ID and semantic label position are still validated by the caller.
    let decoded = match token_id {
        SIMPLE_TOKEN_ID => "simple",
        NON_SIMPLE_FIRST_TOKEN_ID => "non",
        _ => return None,
    };
    let mut observed_logprob = None;
    for candidate in candidates
        .iter()
        .filter(|candidate| candidate.token == expected || candidate.token == decoded)
    {
        if !candidate.logprob.is_finite() || candidate.logprob > 0.0 {
            return None;
        }
        if observed_logprob.is_some_and(|previous| previous != candidate.logprob) {
            return None;
        }
        observed_logprob = Some(candidate.logprob);
    }
    observed_logprob
}

fn parse_router_route(raw_output: &str) -> Result<(bool, bool), RouterClientError> {
    let first_line = raw_output.lines().next().unwrap_or_default().trim();
    if first_line.is_empty() || !first_line.starts_with('{') {
        return Err(RouterClientError::Deserialization(
            "Router output is not a JSON object".to_string(),
        ));
    }
    if first_line.matches("\"simple_type\"").count() != 1 {
        return Err(RouterClientError::Deserialization(
            "Router output must contain exactly one simple_type key".to_string(),
        ));
    }
    let (prediction, recovered) = match serde_json::from_str::<Value>(first_line) {
        Ok(value) => (value, false),
        Err(_) if !first_line.ends_with('}') => {
            let repaired = format!("{first_line}}}");
            let value = serde_json::from_str::<Value>(&repaired).map_err(|error| {
                RouterClientError::Deserialization(format!(
                    "Router output is invalid JSON: {error}"
                ))
            })?;
            (value, true)
        }
        Err(error) => {
            return Err(RouterClientError::Deserialization(format!(
                "Router output is invalid JSON: {error}"
            )));
        }
    };
    let simple_type = prediction
        .as_object()
        .and_then(|object| object.get("simple_type"))
        .and_then(Value::as_str)
        .ok_or_else(|| {
            RouterClientError::Deserialization(
                "Router output is missing a string simple_type".to_string(),
            )
        })?;
    match simple_type {
        "simple" => Ok((true, recovered)),
        "non_simple" => Ok((false, recovered)),
        value => Err(RouterClientError::Deserialization(format!(
            "Router output has unsupported simple_type: {value}"
        ))),
    }
}

#[cfg(test)]
mod tests {
    #[test]
    fn service_identity_is_canonical_and_ignores_auth_query_and_model() {
        use super::RouterHttpClient;
        use std::time::Duration;
        let first = RouterHttpClient::new(
            "https://ROUTER.example:443/v1/chat/completions/?api_key=secret#fragment".into(),
            "first-model".into(),
            "prompt".into(),
            Some("first-key".into()),
            Duration::from_secs(1),
        )
        .unwrap();
        let second = RouterHttpClient::new(
            "https://router.example/v1/chat/completions?api_key=changed".into(),
            "other-model".into(),
            "different prompt".into(),
            Some("rotated-key".into()),
            Duration::from_secs(1),
        )
        .unwrap();
        assert_eq!(first.service_identity(), second.service_identity());
        assert_eq!(
            first.service_identity(),
            "https://router.example/v1/chat/completions"
        );
        assert!(!first.service_identity().contains("secret"));
    }

    use super::*;

    #[test]
    fn prompt_usage_requires_positive_total_input_and_keeps_cached_tokens_included() {
        let prediction = |usage| RouterPrediction {
            generated_simple: true,
            simple_probability: None,
            recovered: false,
            raw_output: String::new(),
            usage,
        };
        assert_eq!(prediction(None).prompt_tokens(), None);
        for usage in [
            json!({}),
            json!({"prompt_tokens": null}),
            json!({"prompt_tokens": 0}),
            json!({"prompt_tokens": -1}),
            json!({"prompt_tokens": 42.0}),
            json!({"prompt_tokens": "42"}),
            json!({"input_tokens": 42}),
            json!({"prompt_cache_hit_tokens": 42, "completion_tokens": 8}),
            json!({"error": {"message": "Requested 42 tokens"}}),
        ] {
            assert_eq!(
                prediction(Some(usage.clone())).prompt_tokens(),
                None,
                "{usage}"
            );
        }
        for usage in [
            json!({"prompt_tokens": 42}),
            json!({"prompt_tokens": 42, "completion_tokens": 8, "total_tokens": 50}),
            json!({"prompt_tokens": 42, "prompt_tokens_details": {"cached_tokens": 30}}),
            json!({"prompt_tokens": 42, "prompt_cache_hit_tokens": 30, "prompt_cache_miss_tokens": 12}),
        ] {
            assert_eq!(
                prediction(Some(usage.clone())).prompt_tokens(),
                Some(42),
                "{usage}"
            );
        }
    }

    #[test]
    fn overflow_detection_requires_explicit_provider_context_evidence() {
        for error in [
            json!({"error": {"code": "context_length_exceeded", "message": "Request failed"}}),
            json!({"type": "model_context_window_exceeded"}),
            json!({"error": {"code": "context_window_exceeded"}}),
            json!({"object": "error", "type": "BadRequestError", "code": 400,
                "message": "This model's maximum context length is 4096 tokens. However, you requested 5000 tokens."}),
            json!({"error": {"type": "BadRequestError", "code": 400,
                "message": "This model's maximum context length is 4096 tokens. However, your prompt contains at least 4097 input tokens."}}),
            json!({"type": "BadRequestError", "message":
                "This model's maximum context length is 4096 tokens, but the prompt contains 5000 input tokens"}),
        ] {
            assert!(
                is_context_overflow_body(&serde_json::to_vec(&error).unwrap()),
                "{error}"
            );
        }
        for error in [
            json!({"error": {"code": "invalid_request_error", "message": "Unsupported field"}}),
            json!({"error": {"message": "Request Entity Too Large"}}),
            json!({"error": {"message": "max_tokens exceeds the permitted output limit"}}),
            json!({"error": {"message": "Invalid prompt: context_length_exceeded was quoted"}}),
            json!({"error": {"code": "invalid_api_key", "message":
                "This model's maximum context length is 4096 tokens. However, you requested 5000 tokens."}}),
            json!({"error": {"message": "This model's maximum context length is 4096 tokens."}}),
        ] {
            assert!(
                !is_context_overflow_body(&serde_json::to_vec(&error).unwrap()),
                "{error}"
            );
        }
        assert!(!is_context_overflow_body(b"context_length_exceeded"));
        assert!(!is_context_overflow_body(
            br#"{"error":{"code":"context_length_exceeded"}"#
        ));
    }

    #[tokio::test]
    async fn http_transport_preserves_auth_protocol_and_error_categories() {
        use axum::{
            extract::Json,
            http::{HeaderMap, StatusCode},
            routing::post,
            Router,
        };

        let app = Router::new().route("/v1/chat/completions", post(
            |headers: HeaderMap, Json(body): Json<Value>| async move {
                assert_eq!(body["messages"][0]["content"], "fixed system");
                assert_eq!(body["messages"][1]["content"], "isolated input");
                assert_eq!(body["temperature"], 0.0);
                assert_eq!(body["top_p"], 1.0);
                assert_eq!(body["max_tokens"], 128);
                assert_eq!(body["stop"], json!(["\n"]));
                assert_eq!(body["top_logprobs"], 20);
                assert_eq!(body["logprobs"], true);
                assert_eq!(body["return_token_ids"], true);
                assert_eq!(body["return_tokens_as_token_ids"], true);
                assert_eq!(body["chat_template_kwargs"], json!({"enable_thinking": false}));
                assert!(body.get("tools").is_none());
                let model = body["model"].as_str().unwrap();
                if model == "authenticated" {
                    assert_eq!(headers["authorization"], "Bearer fixture-key");
                } else {
                    assert!(!headers.contains_key("authorization"));
                }
                let valid = json!({"choices": [{"message": {"content": "{\"simple_type\":\"simple\"}"}}], "usage": {"prompt_tokens": 42}});
                let overflow = json!({"error": {"code": "context_length_exceeded",
                    "message": "fixture-secret-key and echoed isolated input"}});
                match model {
                    "http_error" => (StatusCode::SERVICE_UNAVAILABLE, String::from("unavailable")),
                    "overflow" => (StatusCode::BAD_REQUEST, overflow.to_string()),
                    "ordinary_400" => (StatusCode::BAD_REQUEST, json!({"error": {"message": "Unsupported field"}}).to_string()),
                    "ordinary_413" => (StatusCode::PAYLOAD_TOO_LARGE, String::from("Request Entity Too Large")),
                    "overflow_413" => (StatusCode::PAYLOAD_TOO_LARGE, overflow.to_string()),
                    "auth_error" => (StatusCode::UNAUTHORIZED, overflow.to_string()),
                    "permission_error" => (StatusCode::FORBIDDEN, overflow.to_string()),
                    "rate_limit" => (StatusCode::TOO_MANY_REQUESTS, overflow.to_string()),
                    "service_error" => (StatusCode::SERVICE_UNAVAILABLE, overflow.to_string()),
                    "oversized_error" => (StatusCode::BAD_REQUEST,
                        json!({"error": {"code": "context_length_exceeded", "message": "x".repeat(MAX_ERROR_BODY_BYTES)}}).to_string()),
                    "bad_json" => (StatusCode::OK, String::from("not json")),
                    "empty_choices" => (StatusCode::OK, json!({"choices": []}).to_string()),
                    "missing_content" => (StatusCode::OK, json!({"choices": [{"message": {}}]}).to_string()),
                    "invalid_output" => (StatusCode::OK, json!({"choices": [{"message": {"content": "not a prediction"}}]}).to_string()),
                    "timeout" => {
                        tokio::time::sleep(Duration::from_millis(300)).await;
                        (StatusCode::OK, valid.to_string())
                    }
                    _ => (StatusCode::OK, valid.to_string()),
                }
            }
        ));
        let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
        let endpoint = format!(
            "http://{}/v1/chat/completions",
            listener.local_addr().unwrap()
        );
        let server = tokio::spawn(async move { axum::serve(listener, app).await.unwrap() });
        for model in [
            "unauthenticated",
            "authenticated",
            "http_error",
            "overflow",
            "ordinary_400",
            "ordinary_413",
            "overflow_413",
            "auth_error",
            "permission_error",
            "rate_limit",
            "service_error",
            "oversized_error",
            "bad_json",
            "empty_choices",
            "missing_content",
            "invalid_output",
            "timeout",
        ] {
            let timeout = if model == "timeout" {
                Duration::from_millis(30)
            } else {
                Duration::from_secs(3)
            };
            let client = RouterHttpClient::new(
                format!("{endpoint}?api_key=fixture-query-secret"),
                model.into(),
                "fixed system".into(),
                (model == "authenticated").then(|| "fixture-key".into()),
                timeout,
            )
            .unwrap();
            let result = client.predict("isolated input").await;
            match model {
                "unauthenticated" | "authenticated" => {
                    let prediction = result.unwrap();
                    assert!(prediction.generated_simple);
                    assert_eq!(prediction.simple_probability, None);
                    assert!(!prediction.recovered);
                    assert_eq!(prediction.prompt_tokens(), Some(42));
                    assert_eq!(prediction.usage.unwrap()["prompt_tokens"], 42);
                }
                "overflow" | "overflow_413" => {
                    assert!(
                        matches!(result, Err(RouterClientError::ContextOverflow(_))),
                        "{result:?}"
                    );
                    let error = result.unwrap_err().to_string();
                    assert!(!error.contains("fixture-secret-key"));
                    assert!(!error.contains("isolated input"));
                    assert!(!error.contains("fixture-query-secret"));
                }
                "http_error" | "timeout" | "ordinary_400" | "ordinary_413" | "auth_error"
                | "permission_error" | "rate_limit" | "service_error" | "oversized_error" => {
                    assert!(
                        matches!(result, Err(RouterClientError::Http(_))),
                        "{model}: {result:?}"
                    );
                    assert!(!result
                        .unwrap_err()
                        .to_string()
                        .contains("fixture-query-secret"));
                }
                _ => assert!(
                    matches!(result, Err(RouterClientError::Deserialization(_))),
                    "{model}: {result:?}"
                ),
            }
        }
        server.abort();
        let _ = server.await;
    }
    #[test]
    fn parser_maps_simple_type_and_repairs_only_a_missing_closing_brace() {
        let simple = r#"{"phase":"editing","phase_detail":"production_change_applied","simple_type":"simple"}"#;
        let non_simple = r#"{"phase":"localization","phase_detail":"root_cause_closed","simple_type":"non_simple""#;

        assert_eq!(parse_router_route(simple).unwrap(), (true, false));
        assert_eq!(parse_router_route(non_simple).unwrap(), (false, true));
        assert!(parse_router_route("explanation first").is_err());
    }

    #[test]
    fn confidence_is_renormalized_over_simple_and_non_simple() {
        let raw_output = r#"{"simple_type":"simple"}"#;
        let choice = OpenAiChatChoice {
            message: OpenAiResponseMessage { content: None },
            logprobs: Some(OpenAiChatLogprobs {
                content: Some(vec![
                    OpenAiChatLogprobContent {
                        bytes: Some(br#"{"simple_type":""#.to_vec()),
                        top_logprobs: Vec::new(),
                    },
                    OpenAiChatLogprobContent {
                        bytes: Some(b"simple".to_vec()),
                        top_logprobs: vec![
                            OpenAiTokenLogprob {
                                token: format!("token_id:{SIMPLE_TOKEN_ID}"),
                                logprob: -0.2,
                            },
                            OpenAiTokenLogprob {
                                token: format!("token_id:{NON_SIMPLE_FIRST_TOKEN_ID}"),
                                logprob: -1.4,
                            },
                        ],
                    },
                    OpenAiChatLogprobContent {
                        bytes: Some(br#""}"#.to_vec()),
                        top_logprobs: Vec::new(),
                    },
                ]),
            }),
            token_ids: Some(vec![1, SIMPLE_TOKEN_ID, 2]),
        };

        let probability = extract_simple_probability(&choice, raw_output, true).unwrap();
        assert!((probability - 0.768_524_783_5).abs() < 1e-9);
    }

    #[test]
    fn missing_class_logprob_has_no_confidence() {
        let raw_output = r#"{"simple_type":"simple"}"#;
        let choice = OpenAiChatChoice {
            message: OpenAiResponseMessage { content: None },
            logprobs: Some(OpenAiChatLogprobs {
                content: Some(vec![
                    OpenAiChatLogprobContent {
                        bytes: Some(br#"{"simple_type":""#.to_vec()),
                        top_logprobs: Vec::new(),
                    },
                    OpenAiChatLogprobContent {
                        bytes: Some(b"simple".to_vec()),
                        top_logprobs: vec![OpenAiTokenLogprob {
                            token: format!("token_id:{SIMPLE_TOKEN_ID}"),
                            logprob: -0.2,
                        }],
                    },
                    OpenAiChatLogprobContent {
                        bytes: Some(br#""}"#.to_vec()),
                        top_logprobs: Vec::new(),
                    },
                ]),
            }),
            token_ids: Some(vec![1, SIMPLE_TOKEN_ID, 2]),
        };

        assert!(extract_simple_probability(&choice, raw_output, true).is_none());
    }

    fn classifier_choice(candidates: &[(&str, f64)]) -> OpenAiChatChoice {
        OpenAiChatChoice {
            message: OpenAiResponseMessage { content: None },
            logprobs: Some(OpenAiChatLogprobs {
                content: Some(vec![
                    OpenAiChatLogprobContent {
                        bytes: Some(br#"{"simple_type":""#.to_vec()),
                        top_logprobs: Vec::new(),
                    },
                    OpenAiChatLogprobContent {
                        bytes: Some(b"simple".to_vec()),
                        top_logprobs: candidates
                            .iter()
                            .map(|(token, logprob)| OpenAiTokenLogprob {
                                token: (*token).into(),
                                logprob: *logprob,
                            })
                            .collect(),
                    },
                    OpenAiChatLogprobContent {
                        bytes: Some(br#""}"#.to_vec()),
                        top_logprobs: Vec::new(),
                    },
                ]),
            }),
            token_ids: Some(vec![1, SIMPLE_TOKEN_ID, 2]),
        }
    }

    #[test]
    fn decoded_classifier_candidates_preserve_two_class_confidence() {
        for candidates in [
            vec![("simple", -0.2), ("non", -1.4)],
            vec![("token_id:22944", -0.2), ("token_id:6280", -1.4)],
            vec![("simple", -0.2), ("token_id:6280", -1.4)],
            vec![
                ("simple", -0.2),
                ("token_id:22944", -0.2),
                ("non", -1.4),
                ("non", -1.4),
            ],
        ] {
            let choice = classifier_choice(&candidates);
            let probability =
                extract_simple_probability(&choice, r#"{"simple_type":"simple"}"#, true).unwrap();
            assert!((probability - 0.768_524_783_5).abs() < 1e-9);
        }
        let mut choice = classifier_choice(&[("simple", -1.4), ("non", -0.2)]);
        choice.token_ids.as_mut().unwrap()[1] = NON_SIMPLE_FIRST_TOKEN_ID;
        let tokens = choice.logprobs.as_mut().unwrap().content.as_mut().unwrap();
        tokens[1].bytes = Some(b"non".to_vec());
        tokens[2].bytes = Some(br#"_simple"}"#.to_vec());
        let probability =
            extract_simple_probability(&choice, r#"{"simple_type":"non_simple"}"#, false).unwrap();
        assert!((probability - 0.231_475_216_5).abs() < 1e-9);
    }

    #[test]
    fn decoded_classifier_candidates_require_generated_id_and_label_position() {
        let raw = r#"{"simple_type":"simple"}"#;
        let mut wrong_id = classifier_choice(&[("simple", -0.2), ("non", -1.4)]);
        wrong_id.token_ids.as_mut().unwrap()[1] = NON_SIMPLE_FIRST_TOKEN_ID;
        assert!(extract_simple_probability(&wrong_id, raw, true).is_none());

        let mut wrong_position = classifier_choice(&[("simple", -0.2), ("non", -1.4)]);
        let tokens = wrong_position
            .logprobs
            .as_mut()
            .unwrap()
            .content
            .as_mut()
            .unwrap();
        tokens[0].top_logprobs = std::mem::take(&mut tokens[1].top_logprobs);
        assert!(extract_simple_probability(&wrong_position, raw, true).is_none());

        let mut wrong_alignment = classifier_choice(&[("simple", -0.2), ("non", -1.4)]);
        wrong_alignment.token_ids.as_mut().unwrap().pop();
        assert!(extract_simple_probability(&wrong_alignment, raw, true).is_none());
    }

    #[test]
    fn decoded_classifier_candidates_require_both_exact_classes() {
        for candidates in [
            vec![("simple", -0.2)],
            vec![("non", -1.4)],
            vec![("simple", -0.2), ("non_simple", -1.4)],
            vec![(" simple", -0.2), ("non", -1.4)],
            vec![("simple", -0.2), ("token_id:999", -1.4)],
        ] {
            let choice = classifier_choice(&candidates);
            assert!(
                extract_simple_probability(&choice, r#"{"simple_type":"simple"}"#, true).is_none()
            );
        }
    }

    #[test]
    fn classifier_candidates_reject_conflicting_and_invalid_probabilities() {
        for candidates in [
            vec![("simple", -0.2), ("simple", -0.3), ("non", -1.4)],
            vec![("simple", -0.2), ("token_id:22944", -0.3), ("non", -1.4)],
            vec![("simple", -0.2), ("non", -1.4), ("token_id:6280", -1.5)],
            vec![
                ("token_id:22944", -0.2),
                ("token_id:22944", -0.3),
                ("token_id:6280", -1.4),
            ],
            vec![("simple", f64::NAN), ("non", -1.4)],
            vec![("simple", -0.2), ("non", f64::INFINITY)],
            vec![("simple", f64::NEG_INFINITY), ("non", -1.4)],
            vec![("simple", 0.1), ("non", -1.4)],
            vec![("token_id:22944", -0.2), ("token_id:6280", 0.1)],
        ] {
            let choice = classifier_choice(&candidates);
            assert!(
                extract_simple_probability(&choice, r#"{"simple_type":"simple"}"#, true).is_none()
            );
        }
    }
}
