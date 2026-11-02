use super::{common, OpenAIMessageConverter};
use crate::client::quirks::should_append_tool_stream;
use crate::client::sse::execute_sse_request_with_http_fallback;
use crate::client::{AIClient, StreamResponse};
use crate::providers::shared;
use crate::stream::handle_openai_stream;
use crate::trace::ModelExchangeTraceConfig;
use crate::types::{Message, ModelRequestContext, ToolDefinition};
use anyhow::Result;
use log::{debug, warn};
use reqwest::StatusCode;
use serde_json::{json, Value};

fn include_usage_by_default(request_body: &mut Value) {
    if request_body.get("stream") != Some(&Value::Bool(true)) {
        return;
    }
    // Apply after custom-body merging so sibling options are preserved. An
    // explicit false/null remains an opt-out, including in replace/trim mode.
    if let Some(body) = request_body.as_object_mut() {
        if let Some(options) = body
            .entry("stream_options")
            .or_insert_with(|| json!({}))
            .as_object_mut()
        {
            options.entry("include_usage").or_insert(Value::Bool(true));
        }
    }
}

#[derive(Clone, Copy)]
enum RejectedUsageOption {
    IncludeUsage,
    StreamOptions,
}

fn usage_option_at_path(path: &[&str]) -> Option<RejectedUsageOption> {
    let path = path.strip_prefix(&["body"]).unwrap_or(path);
    match path {
        ["include_usage"] | ["stream_options", "include_usage"] => {
            Some(RejectedUsageOption::IncludeUsage)
        }
        ["stream_options"] => Some(RejectedUsageOption::StreamOptions),
        _ => None,
    }
}

fn usage_option_in_field(field: &str) -> Option<RejectedUsageOption> {
    let path: Vec<_> = field
        .split(|c: char| !c.is_ascii_alphanumeric() && c != '_')
        .filter(|word| !word.is_empty())
        .collect();
    usage_option_at_path(&path)
}

fn usage_option_named(message: &str) -> Option<RejectedUsageOption> {
    let mut rejected = None;
    for field in message.split_whitespace() {
        match usage_option_in_field(field) {
            Some(RejectedUsageOption::IncludeUsage) => {
                return Some(RejectedUsageOption::IncludeUsage);
            }
            Some(RejectedUsageOption::StreamOptions) => {
                rejected = Some(RejectedUsageOption::StreamOptions);
            }
            None => {}
        }
    }
    rejected
}

fn rejected_usage_option(diagnostic: &Value) -> Option<RejectedUsageOption> {
    let message = diagnostic
        .get("message")
        .or_else(|| diagnostic.get("msg"))
        .and_then(Value::as_str)
        .or_else(|| diagnostic.as_str())
        .unwrap_or_default()
        .to_ascii_lowercase();
    let code = diagnostic
        .get("code")
        .or_else(|| diagnostic.get("type"))
        .and_then(Value::as_str)
        .unwrap_or_default()
        .to_ascii_lowercase();
    let rejected = matches!(
        code.as_str(),
        "unsupported_parameter"
            | "unknown_parameter"
            | "unrecognized_parameter"
            | "extra_forbidden"
    ) || [
        "not supported",
        "unsupported",
        "unrecognized",
        "unknown parameter",
        "unknown field",
        "unexpected keyword argument",
        "unexpected argument",
        "not permitted",
        "not allowed",
        "not accepted",
    ]
    .iter()
    .any(|phrase| message.contains(phrase));
    if !rejected {
        return None;
    }

    // Prefer the explicit offending field over message text or an echoed
    // request body. A rejection of a sibling option must not disable usage.
    if let Some(parameter) = diagnostic.get("param").and_then(Value::as_str) {
        return usage_option_in_field(parameter);
    }
    if let Some(location) = diagnostic.get("loc").and_then(Value::as_array) {
        let path: Vec<_> = location.iter().map(Value::as_str).collect::<Option<_>>()?;
        return usage_option_at_path(&path);
    }
    usage_option_named(&message)
}

fn without_rejected_usage_option(
    status: StatusCode,
    error_text: &str,
    request_body: &Value,
) -> Option<Value> {
    // Compatible gateways may wrap validation failures in other 4xx/5xx
    // statuses. Require explicit parameter-rejection evidence below instead
    // of assuming only 400/422, while preserving auth and rate-limit handling.
    if !(status.is_client_error() || status.is_server_error())
        || matches!(
            status,
            StatusCode::UNAUTHORIZED
                | StatusCode::FORBIDDEN
                | StatusCode::PROXY_AUTHENTICATION_REQUIRED
                | StatusCode::TOO_MANY_REQUESTS
        )
        || request_body.get("stream") != Some(&Value::Bool(true))
        || request_body.pointer("/stream_options/include_usage") != Some(&Value::Bool(true))
    {
        return None;
    }
    let diagnostic = serde_json::from_str::<Value>(error_text)
        .unwrap_or_else(|_| Value::String(error_text.into()));
    let rejected = if let Some(details) = diagnostic.get("detail").and_then(Value::as_array) {
        details.iter().find_map(rejected_usage_option)
    } else {
        rejected_usage_option(
            diagnostic
                .get("error")
                .or_else(|| diagnostic.get("detail"))
                .unwrap_or(&diagnostic),
        )
    }?;
    let mut body = request_body.clone();
    match rejected {
        RejectedUsageOption::StreamOptions => {
            body.as_object_mut()?.remove("stream_options");
        }
        RejectedUsageOption::IncludeUsage => {
            let options = body.get_mut("stream_options")?.as_object_mut()?;
            options.remove("include_usage");
            if options.is_empty() {
                body.as_object_mut()?.remove("stream_options");
            }
        }
    }
    Some(body)
}

fn try_build_request_body_with_context(
    client: &AIClient,
    url: &str,
    openai_messages: Vec<serde_json::Value>,
    openai_tools: Option<Vec<serde_json::Value>>,
    extra_body: Option<serde_json::Value>,
    request_context: Option<&ModelRequestContext>,
) -> Result<serde_json::Value> {
    let mut request_body = serde_json::json!({
        "model": client.config.model,
        "messages": openai_messages,
        "stream": true
    });

    let model_name = client.config.model.to_lowercase();

    if should_append_tool_stream(url, &model_name) {
        request_body["tool_stream"] = serde_json::Value::Bool(true);
    }

    let base_reasoning_fields = shared::capture_reasoning_fields(
        &request_body,
        &["thinking", "enable_thinking", "reasoning_effort"],
        &[],
    );

    if let Some(max_tokens) = client.config.max_tokens {
        request_body["max_tokens"] = serde_json::json!(max_tokens);
    }

    let protected_keys = &[
        "model",
        "messages",
        "stream",
        "max_tokens",
        "tool_stream",
        "tools",
    ];
    if let Some(preset) = client.model_reasoning_preset.as_ref() {
        shared::apply_reasoning_actions(
            preset,
            &mut request_body,
            protected_keys,
            &[],
            |action, body| {
                common::compile_chat_reasoning_action(
                    preset,
                    action,
                    body,
                    url,
                    &client.config.model,
                )
            },
        )?;
    }

    let protected_body = shared::protect_request_body(
        client,
        &mut request_body,
        &["model", "messages", "stream", "max_tokens", "tool_stream"],
        &[],
    );

    if let Some(extra) = extra_body {
        if let Some(extra_obj) = extra.as_object() {
            shared::merge_extra_body(&mut request_body, extra_obj);
            shared::log_extra_body_keys("ai::openai_stream_request", extra_obj);
        }
    }

    shared::restore_protected_body(&mut request_body, protected_body);
    // Third-party Chat Completions servers may reject unknown fields, so the
    // cache routing key is limited to OpenAI's own endpoint.
    if shared::is_https_endpoint(url, "api.openai.com", "/v1") {
        if let Some(prompt_cache_route_key) = request_context
            .and_then(|context| context.prompt_cache_route_key.as_deref())
            .map(str::trim)
            .filter(|key| !key.is_empty())
        {
            request_body["prompt_cache_key"] =
                serde_json::Value::String(prompt_cache_route_key.into());
        }
    }
    if let Some(preset) = client.selected_reasoning_preset.as_ref() {
        shared::reset_reasoning_fields(
            &mut request_body,
            base_reasoning_fields.as_ref(),
            &["thinking", "enable_thinking", "reasoning_effort"],
            &[],
        );
        shared::apply_reasoning_actions(
            preset,
            &mut request_body,
            protected_keys,
            &[],
            |action, body| {
                common::compile_chat_reasoning_action(
                    preset,
                    action,
                    body,
                    url,
                    &client.config.model,
                )
            },
        )?;
    }

    if let Some(request_obj) = request_body.as_object_mut() {
        if let Some(existing_n) = request_obj.remove("n") {
            warn!(
                target: "ai::openai_stream_request",
                "Removed custom request field n={} because the stream processor only handles the first choice",
                existing_n
            );
        }
    }
    if let Some(schema) = request_context.and_then(|context| context.output_schema.as_ref()) {
        request_body["response_format"] = serde_json::json!({
            "type": "json_schema",
            "json_schema": {
                "name": "openbitfun_output",
                "strict": true,
                "schema": schema
            }
        });
    }

    include_usage_by_default(&mut request_body);

    shared::log_request_body(
        "ai::openai_stream_request",
        "OpenAI stream request body (excluding tools):",
        &request_body,
    );

    common::attach_tools(&mut request_body, openai_tools, "ai::openai_stream_request");

    Ok(request_body)
}

pub(crate) fn try_build_request_body(
    client: &AIClient,
    url: &str,
    openai_messages: Vec<serde_json::Value>,
    openai_tools: Option<Vec<serde_json::Value>>,
    extra_body: Option<serde_json::Value>,
) -> Result<serde_json::Value> {
    try_build_request_body_with_context(
        client,
        url,
        openai_messages,
        openai_tools,
        extra_body,
        None,
    )
}

#[cfg(test)]
pub(crate) fn build_request_body(
    client: &AIClient,
    url: &str,
    openai_messages: Vec<serde_json::Value>,
    openai_tools: Option<Vec<serde_json::Value>>,
    extra_body: Option<serde_json::Value>,
) -> serde_json::Value {
    try_build_request_body(client, url, openai_messages, openai_tools, extra_body)
        .expect("request body should compile")
}

#[cfg(test)]
pub(crate) fn build_request_body_with_context(
    client: &AIClient,
    url: &str,
    openai_messages: Vec<serde_json::Value>,
    openai_tools: Option<Vec<serde_json::Value>>,
    extra_body: Option<serde_json::Value>,
    request_context: Option<&ModelRequestContext>,
) -> serde_json::Value {
    try_build_request_body_with_context(
        client,
        url,
        openai_messages,
        openai_tools,
        extra_body,
        request_context,
    )
    .expect("request body should compile")
}

pub(crate) async fn send_stream(
    client: &AIClient,
    messages: Vec<Message>,
    tools: Option<Vec<ToolDefinition>>,
    extra_body: Option<serde_json::Value>,
    max_tries: usize,
    trace: Option<ModelExchangeTraceConfig>,
    request_context: Option<ModelRequestContext>,
) -> Result<StreamResponse> {
    let url = client.config.request_url.clone();
    let request_context = shared::prepare_request_context(client, request_context);
    debug!(
        "OpenAI config: model={}, request_url={}, max_tries={}",
        client.config.model, client.config.request_url, max_tries
    );

    let openai_messages = OpenAIMessageConverter::convert_messages(messages);
    let openai_tools = OpenAIMessageConverter::convert_tools(tools);
    let mut request_body = try_build_request_body_with_context(
        client,
        &url,
        openai_messages,
        openai_tools,
        extra_body,
        request_context.as_ref(),
    )?;
    let inline_think_in_text = client.config.inline_think_in_text;
    let idle_timeout = client.stream_options.idle_timeout;
    let ttft_timeout = client.stream_options.ttft_timeout;

    let compatibility = crate::providers::opencode::FreeTools::prepare(client, &mut request_body)?;

    execute_sse_request_with_http_fallback(
        Some(client),
        "OpenAI Streaming API",
        &url,
        &request_body,
        max_tries,
        ttft_timeout,
        trace,
        || {
            let builder = shared::apply_affinity_headers(
                client,
                common::apply_headers(client, client.client.post(&url)),
                &url,
                request_context.as_ref(),
            );
            builder
        },
        move |response, tx, tx_raw, remaining_ttft_timeout| {
            handle_openai_stream(
                response,
                tx,
                tx_raw,
                inline_think_in_text,
                remaining_ttft_timeout,
                idle_timeout,
            )
        },
        without_rejected_usage_option,
    )
    .await
    .map(|response| compatibility.wrap(response))
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::trace::{
        ModelExchangeRequestAttempt, ModelExchangeRequestTraceHandle, ModelExchangeResponseTrace,
        ModelExchangeTraceSink,
    };
    use crate::types::AIConfig;
    use axum::{routing::post, Json, Router};
    use futures::StreamExt;
    use openbitfun_core_types::errors::AiProviderError;
    use std::sync::{
        atomic::{AtomicUsize, Ordering},
        Arc, Mutex,
    };

    const UNSUPPORTED_USAGE: &str = r#"{"error":{"code":"unsupported_parameter","param":"stream_options.include_usage","message":"Parameter is not supported"}}"#;
    const SUCCESS: &str = concat!(
        "data: {\"id\":\"test\",\"model\":\"fixture-model\",\"object\":\"chat.completion.chunk\",\"choices\":[{\"index\":0,\"delta\":{\"content\":\"OK\"}}]}\n\n",
        "data: {\"id\":\"test\",\"model\":\"fixture-model\",\"object\":\"chat.completion.chunk\",\"choices\":[{\"index\":0,\"delta\":{},\"finish_reason\":\"stop\"}]}\n\n",
        "data: {\"id\":\"test\",\"model\":\"fixture-model\",\"object\":\"chat.completion.chunk\",\"choices\":[],\"usage\":{\"prompt_tokens\":68,\"completion_tokens\":32,\"total_tokens\":100,\"prompt_tokens_details\":{\"cached_tokens\":40}}}\n\n",
        "data: [DONE]\n\n",
    );

    fn client(url: &str) -> AIClient {
        AIClient::new(AIConfig {
            name: "usage fixture".into(),
            base_url: url.into(),
            request_url: url.into(),
            api_key: "synthetic-usage-key".into(),
            model: "fixture-model".into(),
            format: "openai".into(),
            context_window: 4096,
            max_tokens: Some(32),
            max_images_per_request: None,
            temperature: None,
            top_p: None,
            inline_think_in_text: false,
            custom_headers: None,
            custom_headers_mode: None,
            skip_ssl_verify: false,
            custom_request_body: None,
            custom_request_body_mode: None,
        })
    }

    #[test]
    fn usage_defaults_survive_custom_body_modes_and_preserve_overrides() {
        for mode in [None, Some("merge"), Some("replace"), Some("trim")] {
            let mut client = client("https://compatible.example/v1/chat/completions");
            client.config.custom_request_body_mode = mode.map(str::to_string);
            for (extra, expected) in [
                (None, json!({"include_usage": true})),
                (
                    Some(json!({"stream_options": {"continuous_usage_stats": true}})),
                    json!({"include_usage": true, "continuous_usage_stats": true}),
                ),
                (
                    Some(json!({"stream_options": {"include_usage": false}})),
                    json!({"include_usage": false}),
                ),
                (
                    Some(json!({"stream_options": {"include_usage": null}})),
                    json!({"include_usage": null}),
                ),
                (Some(json!({"stream_options": null})), Value::Null),
            ] {
                let body =
                    build_request_body(&client, &client.config.request_url, vec![], None, extra);
                assert_eq!(body["stream_options"], expected, "mode={mode:?}");
                assert_eq!(body["stream"], true);
            }
        }
        let client = client("https://compatible.example/v1/chat/completions");
        let body = build_request_body(
            &client,
            &client.config.request_url,
            vec![],
            None,
            Some(json!({"stream": false})),
        );
        assert!(body.get("stream_options").is_none());
    }

    #[test]
    fn fallback_recognizes_parameter_rejections_and_preserves_request_content() {
        let original = json!({
            "model": "fixture-model", "stream": true,
            "messages": [{"role":"user", "content":"hello"}],
            "tools": [{"type":"function", "function":{"name":"read"}}],
            "stream_options": {"include_usage":true, "continuous_usage_stats":true}
        });
        for error in [
            UNSUPPORTED_USAGE,
            r#"{"error":{"message":"Unsupported parameter: stream_options.include_usage"}}"#,
            r#"{"detail":[{"loc":["body","stream_options","include_usage"],"type":"extra_forbidden","msg":"Extra inputs are not permitted"}]}"#,
            "got an unexpected keyword argument 'include_usage'",
        ] {
            let mut expected = original.clone();
            expected["stream_options"]
                .as_object_mut()
                .unwrap()
                .remove("include_usage");
            for status in [StatusCode::BAD_REQUEST, StatusCode::UNPROCESSABLE_ENTITY] {
                assert_eq!(
                    without_rejected_usage_option(status, error, &original),
                    Some(expected.clone()),
                    "{error}"
                );
            }
        }
        for error in [
            r#"{"error":{"message":"Unrecognized request argument supplied: stream_options"}}"#,
            r#"{"error":{"message":"Unsupported parameter: stream_options."}}"#,
            r#"{"detail":"Unknown parameter: stream_options"}"#,
            r#"{"error":{"param":"stream_options","code":"unsupported_parameter"}}"#,
            r#"{"detail":[{"loc":["body","stream_options"],"type":"extra_forbidden"}]}"#,
        ] {
            let mut expected = original.clone();
            expected.as_object_mut().unwrap().remove("stream_options");
            assert_eq!(
                without_rejected_usage_option(StatusCode::BAD_REQUEST, error, &original),
                Some(expected)
            );
        }
    }

    #[test]
    fn fallback_requires_specific_evidence_and_enabled_usage() {
        let original = json!({"stream":true,"stream_options":{"include_usage":true}});
        for error in [
            r#"{"error":{"message":"Invalid type for stream_options.include_usage"}}"#,
            r#"{"error":{"message":"Unsupported model","param":"model"},"request":{"stream_options":{"include_usage":true}}}"#,
            r#"{"error":{"message":"Unsupported include_usage in messages","param":"messages"}}"#,
            r#"{"error":{"code":"unsupported_parameter","param":"response_format.json_schema.schema.properties.include_usage"}}"#,
            r#"{"error":{"message":"Unsupported parameter: response_format.json_schema.schema.properties.include_usage"}}"#,
            r#"{"error":{"code":"unsupported_parameter","param":"messages[0].stream_options"}}"#,
            r#"{"detail":[{"loc":["body","messages",0,"include_usage"],"type":"extra_forbidden"}]}"#,
            r#"{"error":{"message":"Unsupported parameter: stream_options.continuous_usage_stats"}}"#,
            r#"{"detail":[{"loc":["body","stream_options","other"],"type":"extra_forbidden"}]}"#,
            r#"{"error":{"message":"Context length exceeded"}}"#,
            "Bad request",
        ] {
            assert!(
                without_rejected_usage_option(StatusCode::BAD_REQUEST, error, &original).is_none(),
                "{error}"
            );
        }
        for status in [
            StatusCode::OK,
            StatusCode::FOUND,
            StatusCode::UNAUTHORIZED,
            StatusCode::FORBIDDEN,
            StatusCode::PROXY_AUTHENTICATION_REQUIRED,
            StatusCode::TOO_MANY_REQUESTS,
        ] {
            assert!(without_rejected_usage_option(status, UNSUPPORTED_USAGE, &original).is_none());
        }
        for body in [
            json!({"stream":true}),
            json!({"stream":true,"stream_options":{"include_usage":false}}),
            json!({"stream":false,"stream_options":{"include_usage":true}}),
        ] {
            assert!(without_rejected_usage_option(
                StatusCode::BAD_REQUEST,
                UNSUPPORTED_USAGE,
                &body
            )
            .is_none());
        }
    }

    #[test]
    fn parameter_rejection_evidence_is_not_limited_to_validation_status_codes() {
        let body = json!({"stream":true,"stream_options":{"include_usage":true}});
        for status in [
            StatusCode::BAD_REQUEST,
            StatusCode::NOT_FOUND,
            StatusCode::METHOD_NOT_ALLOWED,
            StatusCode::CONFLICT,
            StatusCode::UNSUPPORTED_MEDIA_TYPE,
            StatusCode::UNPROCESSABLE_ENTITY,
            StatusCode::INTERNAL_SERVER_ERROR,
            StatusCode::NOT_IMPLEMENTED,
            StatusCode::BAD_GATEWAY,
            StatusCode::SERVICE_UNAVAILABLE,
            StatusCode::GATEWAY_TIMEOUT,
        ] {
            assert_eq!(
                without_rejected_usage_option(status, UNSUPPORTED_USAGE, &body),
                Some(json!({"stream":true})),
                "an explicit parameter rejection must be recognized despite HTTP {status}",
            );
            for unrelated in [
                r#"{"error":{"message":"Upstream service unavailable"}}"#,
                r#"{"error":{"message":"Request timed out"}}"#,
                r#"{"error":{"message":"Unsupported model","param":"model"}}"#,
            ] {
                assert!(without_rejected_usage_option(status, unrelated, &body).is_none());
            }
        }
    }

    struct Fixture {
        url: String,
        requests: Arc<Mutex<Vec<Value>>>,
        server: tokio::task::JoinHandle<()>,
    }

    impl Fixture {
        async fn new(responses: Vec<(StatusCode, impl Into<String>)>) -> Self {
            let responses: Vec<_> = responses
                .into_iter()
                .map(|(status, body)| (status, body.into()))
                .collect();
            let requests = Arc::new(Mutex::new(Vec::new()));
            let captured = requests.clone();
            let app = Router::new().route(
                "/chat/completions",
                post(move |Json(body): Json<Value>| {
                    let mut requests = captured.lock().unwrap();
                    let index = requests.len().min(responses.len() - 1);
                    requests.push(body);
                    let (status, body) = responses[index].clone();
                    async move { (status, [("content-type", "text/event-stream")], body) }
                }),
            );
            let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
            let url = format!("http://{}/chat/completions", listener.local_addr().unwrap());
            let server = tokio::spawn(async move { axum::serve(listener, app).await.unwrap() });
            Self {
                url,
                requests,
                server,
            }
        }
    }

    impl Drop for Fixture {
        fn drop(&mut self) {
            self.server.abort();
        }
    }

    #[derive(Default)]
    struct Trace {
        attempts: Mutex<Vec<ModelExchangeRequestAttempt>>,
        failures: AtomicUsize,
    }

    #[async_trait::async_trait]
    impl ModelExchangeTraceSink for Trace {
        async fn request_attempt_started(
            &self,
            attempt: &ModelExchangeRequestAttempt,
        ) -> Option<ModelExchangeRequestTraceHandle> {
            self.attempts.lock().unwrap().push(attempt.clone());
            Some(ModelExchangeRequestTraceHandle {
                trace_id: attempt.attempt_number.to_string(),
            })
        }
        async fn request_attempt_failed(
            &self,
            _: Option<&ModelExchangeRequestTraceHandle>,
            _: &str,
        ) {
            self.failures.fetch_add(1, Ordering::SeqCst);
        }
        async fn request_attempt_completed(
            &self,
            _: &ModelExchangeRequestTraceHandle,
            _: &ModelExchangeResponseTrace,
        ) {
        }
    }

    #[tokio::test]
    async fn default_request_delivers_trailing_usage_and_cache_hits() {
        // Both standard choices:[] and the gateway's choices:[{delta:{}}]
        // trailing usage shapes must survive the preceding finish_reason.
        for (choices, cached) in [("[]", 40), ("[{\"index\":0,\"delta\":{}}]", 0)] {
            let body = SUCCESS
                .replace("\"choices\":[]", &format!("\"choices\":{choices}"))
                .replace(
                    "\"cached_tokens\":40",
                    &format!("\"cached_tokens\":{cached}"),
                );
            let fixture = Fixture::new(vec![(StatusCode::OK, body)]).await;
            let mut response =
                send_stream(&client(&fixture.url), vec![], None, None, 1, None, None)
                    .await
                    .unwrap();
            let mut text = String::new();
            let mut usage = None;
            while let Some(chunk) = response.stream.next().await {
                let chunk = chunk.unwrap();
                text.push_str(chunk.text.as_deref().unwrap_or_default());
                if chunk.usage.is_some() {
                    usage = chunk.usage;
                }
            }
            assert_eq!(text, "OK");
            let usage = usage.expect("usage after finish_reason must be delivered");
            assert_eq!(
                (
                    usage.prompt_token_count,
                    usage.candidates_token_count,
                    usage.total_token_count
                ),
                (68, 32, 100)
            );
            assert_eq!(usage.cached_content_token_count, Some(cached));
            let requests = fixture.requests.lock().unwrap();
            assert_eq!(requests.len(), 1);
            assert_eq!(requests[0]["stream_options"]["include_usage"], true);
        }
    }

    #[tokio::test]
    async fn rejected_usage_retries_once_even_with_one_attempt_and_traces_actual_bodies() {
        let without_usage = SUCCESS
            .lines()
            .filter(|line| !line.contains("\"usage\""))
            .collect::<Vec<_>>()
            .join("\n")
            + "\n";
        let fixture = Fixture::new(vec![
            (StatusCode::BAD_REQUEST, UNSUPPORTED_USAGE.to_string()),
            (StatusCode::OK, without_usage),
        ])
        .await;
        let trace = Arc::new(Trace::default());
        let mut response = send_stream(
            &client(&fixture.url),
            vec![],
            None,
            Some(json!({"temperature":0.5})),
            1,
            Some(
                ModelExchangeTraceConfig::new(trace.clone(), true)
                    .with_round_attempt("round-1".into(), 1),
            ),
            None,
        )
        .await
        .unwrap();
        let mut text = String::new();
        while let Some(chunk) = response.stream.next().await {
            let chunk = chunk.unwrap();
            text.push_str(chunk.text.as_deref().unwrap_or_default());
            assert!(
                chunk.usage.is_none(),
                "missing provider usage must remain unknown"
            );
        }
        assert_eq!(text, "OK");
        let requests = fixture.requests.lock().unwrap();
        assert_eq!(requests.len(), 2);
        assert_eq!(requests[0]["stream_options"]["include_usage"], true);
        let mut expected = requests[0].clone();
        expected.as_object_mut().unwrap().remove("stream_options");
        assert_eq!(requests[1], expected);
        let attempts = trace.attempts.lock().unwrap();
        assert_eq!(attempts.len(), 2);
        for (index, attempt) in attempts.iter().enumerate() {
            assert_eq!(attempt.attempt_number, index + 1);
            assert_eq!(attempt.request_body.as_ref(), Some(&requests[index]));
            assert_eq!(
                attempt.round_attempt.as_ref().unwrap().attempt_id,
                "round-1"
            );
        }
        assert_eq!(trace.failures.load(Ordering::SeqCst), 1);
    }

    #[tokio::test]
    async fn failed_fallback_surfaces_error_without_looping() {
        let fixture = Fixture::new(vec![(StatusCode::BAD_REQUEST, UNSUPPORTED_USAGE)]).await;
        let error = send_stream(&client(&fixture.url), vec![], None, None, 1, None, None)
            .await
            .err()
            .expect("both requests fail");
        assert_eq!(fixture.requests.lock().unwrap().len(), 2);
        assert_eq!(
            error.downcast_ref::<AiProviderError>().unwrap().http_status,
            Some(400)
        );
    }

    #[tokio::test]
    async fn gateway_status_preserves_the_single_parameter_fallback() {
        for status in [StatusCode::INTERNAL_SERVER_ERROR, StatusCode::BAD_GATEWAY] {
            let fixture =
                Fixture::new(vec![(status, UNSUPPORTED_USAGE), (StatusCode::OK, SUCCESS)]).await;
            let response = send_stream(&client(&fixture.url), vec![], None, None, 1, None, None)
                .await
                .expect(
                    "a gateway-wrapped parameter rejection must negotiate before ordinary retries",
                );
            let result = crate::client::response_aggregator::aggregate_stream_response(response)
                .await
                .unwrap();
            assert_eq!(result.text, "OK");
            let requests = fixture.requests.lock().unwrap();
            assert_eq!(requests.len(), 2);
            let mut expected = requests[0].clone();
            expected.as_object_mut().unwrap().remove("stream_options");
            assert_eq!(requests[1], expected);
        }
    }

    #[tokio::test]
    async fn ordinary_retries_keep_the_adapted_request_body() {
        let fixture = Fixture::new(vec![
            (StatusCode::BAD_REQUEST, UNSUPPORTED_USAGE),
            (StatusCode::BAD_GATEWAY, "Temporary gateway failure"),
            (StatusCode::OK, SUCCESS),
        ])
        .await;
        let mut response = send_stream(&client(&fixture.url), vec![], None, None, 2, None, None)
            .await
            .unwrap();
        while let Some(chunk) = response.stream.next().await {
            chunk.unwrap();
        }
        let requests = fixture.requests.lock().unwrap();
        assert_eq!(requests.len(), 3);
        assert!(requests[1].get("stream_options").is_none());
        assert_eq!(requests[1], requests[2]);
    }

    #[tokio::test]
    async fn unrelated_http_errors_and_sse_errors_do_not_trigger_usage_fallback() {
        for (status, body) in [
            (
                StatusCode::BAD_REQUEST,
                r#"{"error":{"message":"Unknown model"}}"#,
            ),
            (StatusCode::UNAUTHORIZED, UNSUPPORTED_USAGE),
            (StatusCode::TOO_MANY_REQUESTS, UNSUPPORTED_USAGE),
            (
                StatusCode::INTERNAL_SERVER_ERROR,
                r#"{"error":{"message":"Upstream service unavailable"}}"#,
            ),
        ] {
            let fixture = Fixture::new(vec![(status, body)]).await;
            assert!(
                send_stream(&client(&fixture.url), vec![], None, None, 1, None, None)
                    .await
                    .is_err()
            );
            assert_eq!(fixture.requests.lock().unwrap().len(), 1);
        }
        let fixture = Fixture::new(vec![(StatusCode::OK, concat!(
            "data: {\"id\":\"test\",\"model\":\"fixture-model\",\"object\":\"chat.completion.chunk\",\"choices\":[{\"index\":0,\"delta\":{\"content\":\"partial\"}}]}\n\n",
            "data: {\"error\":{\"code\":\"unsupported_parameter\",\"param\":\"stream_options.include_usage\",\"message\":\"include_usage is not supported\"}}\n\n"
        ))]).await;
        let mut response = send_stream(&client(&fixture.url), vec![], None, None, 1, None, None)
            .await
            .unwrap();
        let first = response.stream.next().await.unwrap().unwrap();
        assert_eq!(first.text.as_deref(), Some("partial"));
        assert!(response.stream.next().await.unwrap().is_err());
        assert_eq!(fixture.requests.lock().unwrap().len(), 1);
    }

    #[tokio::test]
    async fn compatibility_retry_revalidates_host_authorization() {
        #[derive(Debug)]
        struct Authorization(AtomicUsize);
        impl crate::client::ModelRequestAuthorization for Authorization {
            fn validate(
                &self,
            ) -> std::pin::Pin<Box<dyn std::future::Future<Output = Result<()>> + Send + '_>>
            {
                Box::pin(async move {
                    anyhow::ensure!(
                        self.0.fetch_add(1, Ordering::SeqCst) == 0,
                        "Fixture authorization revoked"
                    );
                    Ok(())
                })
            }
        }
        let fixture = Fixture::new(vec![
            (StatusCode::BAD_REQUEST, UNSUPPORTED_USAGE),
            (StatusCode::OK, SUCCESS),
        ])
        .await;
        let authorization = Arc::new(Authorization(AtomicUsize::new(0)));
        let client = client(&fixture.url).with_request_authorization(authorization.clone());
        let error = send_stream(&client, vec![], None, None, 1, None, None)
            .await
            .err()
            .expect("authorization must reject the fallback send");
        assert!(error.to_string().contains("Fixture authorization revoked"));
        assert_eq!(authorization.0.load(Ordering::SeqCst), 2);
        assert_eq!(fixture.requests.lock().unwrap().len(), 1);
    }
}
