use crate::client::utils::elapsed_ms_u64;
use crate::client::AIClient;
use crate::types::{
    ConnectionTestMessageCode, ConnectionTestResult, GeminiResponse, Message, ToolDefinition,
};
use anyhow::{anyhow, Result};
use log::debug;
use openbitfun_core_types::errors::{AiProviderError, ErrorCategory};
use std::time::Duration;

pub(crate) fn image_test_response_matches_expected(response: &str) -> bool {
    let upper = response.to_ascii_uppercase();

    let letters_only: String = upper.chars().filter(|c| c.is_ascii_alphabetic()).collect();
    if letters_only.contains(AIClient::TEST_IMAGE_EXPECTED_CODE) {
        return true;
    }

    let tokens: Vec<&str> = upper
        .split(|c: char| !c.is_ascii_alphabetic())
        .filter(|s| !s.is_empty())
        .collect();

    if tokens.contains(&AIClient::TEST_IMAGE_EXPECTED_CODE) {
        return true;
    }

    let single_letter_stream: String = tokens
        .iter()
        .filter_map(|token| {
            if token.len() == 1 {
                let ch = token.chars().next()?;
                if matches!(ch, 'R' | 'G' | 'B' | 'Y') {
                    return Some(ch);
                }
            }
            None
        })
        .collect();
    if single_letter_stream.contains(AIClient::TEST_IMAGE_EXPECTED_CODE) {
        return true;
    }

    let color_word_stream: String = tokens
        .iter()
        .filter_map(|token| match *token {
            "RED" => Some('R'),
            "GREEN" => Some('G'),
            "BLUE" => Some('B'),
            "YELLOW" => Some('Y'),
            _ => None,
        })
        .collect();
    if color_word_stream.contains(AIClient::TEST_IMAGE_EXPECTED_CODE) {
        return true;
    }

    let color_letter_stream: String = upper
        .chars()
        .filter(|c| matches!(*c, 'R' | 'G' | 'B' | 'Y'))
        .collect();
    color_letter_stream.contains(AIClient::TEST_IMAGE_EXPECTED_CODE)
}

fn connection_error_message_code(error_msg: &str) -> Option<ConnectionTestMessageCode> {
    let msg = error_msg.to_ascii_lowercase();

    let tls_keywords = [
        "certificate",
        "cert",
        "tls",
        "ssl",
        "rustls",
        "native-tls",
        "handshake",
        "unknownissuer",
        "unknown issuer",
        "invalid peer certificate",
        "peer certificate",
        "certificate verify",
        "certificate verification",
        "invalid certificate",
        "self signed",
        "self-signed",
        "webpki",
    ];
    if tls_keywords.iter().any(|keyword| msg.contains(keyword)) {
        return Some(ConnectionTestMessageCode::TlsOrCertificateIssue);
    }

    let proxy_keywords = ["proxy", "tunnel", "connect tunnel", "http connect"];
    if proxy_keywords.iter().any(|keyword| msg.contains(keyword)) {
        return Some(ConnectionTestMessageCode::ProxyIssue);
    }

    let network_keywords = [
        "connection failed",
        "error sending request",
        "dns",
        "network",
        "connection refused",
        "connection reset",
        "connection closed",
        "timed out",
        "timeout",
        "econnreset",
        "econnrefused",
        "etimedout",
    ];
    if network_keywords.iter().any(|keyword| msg.contains(keyword)) {
        return Some(ConnectionTestMessageCode::NetworkIssue);
    }

    None
}

fn tool_probe_is_unsupported(error: &anyhow::Error) -> bool {
    let Some(error) = error.downcast_ref::<AiProviderError>() else {
        return false;
    };
    if !matches!(error.http_status, Some(400 | 422))
        || error.category != ErrorCategory::InvalidRequest
    {
        return false;
    }
    // The provider's structured validation response, rather than a model name
    // or an arbitrary failure, must establish that the tool probe is unsupported.
    let Some(body_start) = error.message.find('{') else {
        return false;
    };
    let Ok(body) = serde_json::from_str::<serde_json::Value>(&error.message[body_start..]) else {
        return false;
    };
    let provider_error = body.get("error").unwrap_or(&body);
    let Some(message) = provider_error
        .get("message")
        .and_then(|value| value.as_str())
    else {
        return false;
    };
    message.contains("tool choice requires --enable-auto-tool-choice")
        && message.contains("--tool-call-parser")
}

async fn send_connection_probe(client: &AIClient, max_attempts: usize) -> Result<GeminiResponse> {
    let mut test_messages = vec![Message::user(
        "Call the get_weather tool for city=Beijing. Do not answer with plain text.".to_string(),
    )];
    let mut tools = Some(vec![ToolDefinition {
        name: "get_weather".to_string(),
        description: "Get the weather of a city".to_string(),
        parameters: serde_json::json!({
            "type": "object",
            "properties": {
                "city": { "type": "string", "description": "The city to get the weather for" }
            },
            "required": ["city"],
            "additionalProperties": false
        }),
    }]);

    let max_attempts = max_attempts.max(1);
    for attempt in 0..max_attempts {
        match client
            .send_test_message(test_messages.clone(), tools.clone(), 1)
            .await
        {
            Ok(response) => {
                if tools.is_none() && response.text.trim().is_empty() {
                    return Err(anyhow!(
                        "Connection test received no text from the tool-free probe"
                    ));
                }
                return Ok(response);
            }
            Err(error) => {
                if attempt + 1 == max_attempts {
                    return Err(error);
                }
                if tools.is_some() && tool_probe_is_unsupported(&error) {
                    debug!("Provider rejected the tool probe; testing text connectivity");
                    tools = None;
                    test_messages = vec![Message::user("Reply with OK.".to_string())];
                    continue;
                }
                if error
                    .downcast_ref::<AiProviderError>()
                    .is_some_and(|error| {
                        !openbitfun_agent_stream::retry::should_retry(&error.category)
                    })
                {
                    return Err(error);
                }
                let delay_ms = super::send_message_retry_delay_ms_for_error(attempt, &error);
                tokio::time::sleep(Duration::from_millis(delay_ms)).await;
            }
        }
    }
    unreachable!("connection probe returns within its attempt budget")
}

pub(crate) async fn test_connection(
    client: &AIClient,
    max_attempts: usize,
) -> Result<ConnectionTestResult> {
    let start_time = std::time::Instant::now();
    match send_connection_probe(client, max_attempts).await {
        Ok(response) => {
            let response_time_ms = elapsed_ms_u64(start_time);
            if response.tool_calls.is_some() {
                Ok(ConnectionTestResult {
                    success: true,
                    response_time_ms,
                    model_response: Some(response.text),
                    message_code: None,
                    error_details: None,
                })
            } else {
                Ok(ConnectionTestResult {
                    success: true,
                    response_time_ms,
                    model_response: Some(response.text),
                    message_code: Some(ConnectionTestMessageCode::ToolCallsNotDetected),
                    error_details: None,
                })
            }
        }
        Err(e) => {
            let response_time_ms = elapsed_ms_u64(start_time);
            let error_msg = format!("{}", e);
            debug!("test connection failed: {}", error_msg);
            Ok(ConnectionTestResult {
                success: false,
                response_time_ms,
                model_response: None,
                message_code: connection_error_message_code(&error_msg),
                error_details: Some(error_msg),
            })
        }
    }
}

pub(crate) async fn test_image_input_connection(
    client: &AIClient,
    max_attempts: usize,
) -> Result<ConnectionTestResult> {
    let start_time = std::time::Instant::now();
    let provider = client.config.format.to_ascii_lowercase();
    let prompt = "Inspect the attached image and reply with exactly one 4-letter code for quadrant colors in TL,TR,BL,BR order using letters R,G,B,Y (R=red, G=green, B=blue, Y=yellow).";

    let content = if provider == "anthropic" {
        serde_json::json!([
            {
                "type": "image",
                "source": {
                    "type": "base64",
                    "media_type": "image/png",
                    "data": AIClient::TEST_IMAGE_PNG_BASE64
                }
            },
            {
                "type": "text",
                "text": prompt
            }
        ])
    } else {
        serde_json::json!([
            {
                "type": "image_url",
                "image_url": {
                    "url": format!("data:image/png;base64,{}", AIClient::TEST_IMAGE_PNG_BASE64)
                }
            },
            {
                "type": "text",
                "text": prompt
            }
        ])
    };

    let test_messages = vec![Message {
        role: "user".to_string(),
        content: Some(content.to_string()),
        reasoning_content: None,
        thinking_signature: None,
        tool_calls: None,
        tool_call_id: None,
        name: None,
        is_error: None,
        tool_image_attachments: None,
        model_response_replay: None,
    }];

    match client
        .send_test_message(test_messages, None, max_attempts)
        .await
    {
        Ok(response) => {
            if image_test_response_matches_expected(&response.text) {
                Ok(ConnectionTestResult {
                    success: true,
                    response_time_ms: elapsed_ms_u64(start_time),
                    model_response: Some(response.text),
                    message_code: None,
                    error_details: None,
                })
            } else {
                let detail = format!(
                    "Image understanding verification failed: expected code '{}', got response '{}'",
                    AIClient::TEST_IMAGE_EXPECTED_CODE,
                    response.text
                );
                debug!("test image input connection failed: {}", detail);
                Ok(ConnectionTestResult {
                    success: false,
                    response_time_ms: elapsed_ms_u64(start_time),
                    model_response: Some(response.text),
                    message_code: Some(ConnectionTestMessageCode::ImageInputCheckFailed),
                    error_details: Some(detail),
                })
            }
        }
        Err(e) => {
            let error_msg = format!("{}", e);
            debug!("test image input connection failed: {}", error_msg);
            Ok(ConnectionTestResult {
                success: false,
                response_time_ms: elapsed_ms_u64(start_time),
                model_response: None,
                message_code: connection_error_message_code(&error_msg),
                error_details: Some(error_msg),
            })
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::types::AIConfig;
    use axum::{
        extract::State,
        http::{HeaderMap, StatusCode},
        response::{IntoResponse, Response},
        routing::post,
        Json, Router,
    };
    use serde_json::{json, Value};
    use std::sync::{Arc, Mutex};
    use tokio::task::JoinHandle;

    const TOOLS_DISABLED: &str =
        "\"auto\" tool choice requires --enable-auto-tool-choice and --tool-call-parser to be set";

    #[derive(Clone)]
    struct ProbeState {
        requests: Arc<Mutex<Vec<Value>>>,
        tool_error: Option<(StatusCode, &'static str)>,
        text_error: Option<(StatusCode, &'static str)>,
    }

    struct ProbeServer {
        client: AIClient,
        state: ProbeState,
        task: JoinHandle<()>,
    }

    impl ProbeServer {
        async fn spawn(
            tool_error: Option<(StatusCode, &'static str)>,
            text_error: Option<(StatusCode, &'static str)>,
        ) -> Self {
            let state = ProbeState {
                requests: Arc::default(),
                tool_error,
                text_error,
            };
            let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
            let base_url = format!("http://{}/v1", listener.local_addr().unwrap());
            let app = Router::new()
                .route("/v1/chat/completions", post(probe_handler))
                .with_state(state.clone());
            let task = tokio::spawn(async move { axum::serve(listener, app).await.unwrap() });
            let client = AIClient::new(AIConfig {
                name: "Unlisted service".into(),
                request_url: format!("{base_url}/chat/completions"),
                base_url,
                api_key: "fixture-key".into(),
                model: "unlisted-model".into(),
                format: "openai".into(),
                context_window: 65_536,
                max_tokens: Some(128),
                max_images_per_request: None,
                temperature: None,
                top_p: None,
                inline_think_in_text: false,
                custom_headers: None,
                custom_headers_mode: None,
                skip_ssl_verify: false,
                custom_request_body: None,
                custom_request_body_mode: None,
            });
            Self {
                client,
                state,
                task,
            }
        }
    }

    impl Drop for ProbeServer {
        fn drop(&mut self) {
            self.task.abort();
        }
    }

    async fn probe_handler(
        State(state): State<ProbeState>,
        headers: HeaderMap,
        Json(body): Json<Value>,
    ) -> Response {
        assert_eq!(headers["authorization"], "Bearer fixture-key");
        state.requests.lock().unwrap().push(body.clone());
        let has_tools = body.get("tools").is_some();
        let error = if has_tools {
            state.tool_error
        } else {
            state.text_error
        };
        if let Some((status, message)) = error.filter(|(status, _)| !status.is_success()) {
            return (
                status,
                Json(json!({"error": {"message": message, "type": "BadRequestError"}})),
            )
                .into_response();
        }
        let (delta, finish_reason) = if has_tools {
            (
                json!({"tool_calls": [{"index": 0, "id": "call-weather", "type": "function",
                    "function": {"name": "get_weather", "arguments": "{\"city\":\"Beijing\"}"}}]}),
                "tool_calls",
            )
        } else {
            let content = state
                .text_error
                .map(|(_, content)| content)
                .unwrap_or("{\"label\":\"primary\"}");
            (json!({"content": content}), "stop")
        };
        let chunk = json!({"id": "fixture", "object": "chat.completion.chunk", "created": 1,
            "model": "unlisted-model", "choices": [{"index": 0, "delta": delta, "finish_reason": null}]});
        let done = json!({"id": "fixture", "object": "chat.completion.chunk", "created": 1,
            "model": "unlisted-model", "choices": [{"index": 0, "delta": {}, "finish_reason": finish_reason}]});
        (
            [("content-type", "text/event-stream")],
            format!("data: {chunk}\n\ndata: {done}\n\ndata: [DONE]\n\n"),
        )
            .into_response()
    }

    #[tokio::test]
    async fn text_service_connects_when_tool_calling_is_disabled() {
        let server =
            ProbeServer::spawn(Some((StatusCode::BAD_REQUEST, TOOLS_DISABLED)), None).await;
        let original = serde_json::to_value(&server.client.config).unwrap();
        let result = test_connection(&server.client, 2).await.unwrap();
        assert!(result.success, "{:?}", result.error_details);
        assert_eq!(
            result.model_response.as_deref(),
            Some("{\"label\":\"primary\"}")
        );
        assert!(matches!(
            result.message_code,
            Some(ConnectionTestMessageCode::ToolCallsNotDetected)
        ));
        let requests = server.state.requests.lock().unwrap();
        assert_eq!(requests.len(), 2);
        assert_eq!(requests[0]["tools"][0]["function"]["name"], "get_weather");
        assert!(requests[1].get("tools").is_none());
        assert!(requests[1].get("tool_choice").is_none());
        assert!(!requests[1]["messages"][0]["content"]
            .as_str()
            .unwrap()
            .contains("get_weather"));
        assert_eq!(requests[1]["model"], "unlisted-model");
        assert_eq!(
            serde_json::to_value(&server.client.config).unwrap(),
            original
        );
    }

    #[tokio::test]
    async fn ordinary_models_keep_the_tool_call_probe() {
        let server = ProbeServer::spawn(None, None).await;
        let result = test_connection(&server.client, 2).await.unwrap();
        assert!(result.success);
        assert!(result.message_code.is_none());
        let requests = server.state.requests.lock().unwrap();
        assert_eq!(requests.len(), 1);
        assert_eq!(requests[0]["tools"][0]["function"]["name"], "get_weather");
    }

    #[tokio::test]
    async fn an_unsuccessful_text_probe_still_fails_the_connection_test() {
        let server = ProbeServer::spawn(
            Some((StatusCode::BAD_REQUEST, TOOLS_DISABLED)),
            Some((StatusCode::SERVICE_UNAVAILABLE, "Service unavailable")),
        )
        .await;
        let result = test_connection(&server.client, 2).await.unwrap();
        assert!(!result.success);
        assert!(result.error_details.unwrap().contains("503"));
        let requests = server.state.requests.lock().unwrap();
        assert_eq!(requests.len(), 2);
        assert!(requests[1].get("tools").is_none());
    }

    #[test]
    fn tool_fallback_requires_a_structured_request_validation_error() {
        let body = json!({"error": {"message": TOOLS_DISABLED, "type": "BadRequestError"}});
        for status in [400, 422] {
            let error = AiProviderError::from_parts(
                format!("OpenAI HTTP {status}: {body}"),
                None,
                None,
                Some(status),
            );
            assert!(tool_probe_is_unsupported(&error.into()));
        }
        for status in [401, 403, 404, 429, 500, 503] {
            let error = AiProviderError::from_parts(
                format!("OpenAI HTTP {status}: {body}"),
                None,
                None,
                Some(status),
            );
            assert!(!tool_probe_is_unsupported(&error.into()));
        }
        for (message, code, status) in [
            (TOOLS_DISABLED.to_string(), None, Some(400)),
            (format!("OpenAI HTTP 400: {body}"), None, None),
            (
                format!("OpenAI HTTP 400: {body}"),
                Some("invalid_api_key"),
                Some(400),
            ),
            (
                "OpenAI HTTP 400: {\"error\": {\"message\": \"Invalid model\"}}".into(),
                None,
                Some(400),
            ),
        ] {
            let error =
                AiProviderError::from_parts(message, None, code.map(str::to_string), status);
            assert!(!tool_probe_is_unsupported(&error.into()));
        }
    }

    #[tokio::test]
    async fn unrelated_bad_requests_do_not_switch_to_text_or_retry() {
        let server =
            ProbeServer::spawn(Some((StatusCode::BAD_REQUEST, "Invalid model")), None).await;
        let result = test_connection(&server.client, 5).await.unwrap();
        assert!(!result.success);
        assert!(result.error_details.unwrap().contains("Invalid model"));
        assert_eq!(server.state.requests.lock().unwrap().len(), 1);
    }

    #[tokio::test]
    async fn authentication_errors_do_not_switch_to_text_or_retry() {
        let server =
            ProbeServer::spawn(Some((StatusCode::UNAUTHORIZED, TOOLS_DISABLED)), None).await;
        let result = test_connection(&server.client, 5).await.unwrap();
        assert!(!result.success);
        assert!(result.error_details.unwrap().contains("401"));
        assert_eq!(server.state.requests.lock().unwrap().len(), 1);
    }

    #[tokio::test]
    async fn a_tool_free_probe_needs_an_actual_model_response() {
        let server = ProbeServer::spawn(
            Some((StatusCode::BAD_REQUEST, TOOLS_DISABLED)),
            Some((StatusCode::OK, "")),
        )
        .await;
        let result = test_connection(&server.client, 5).await.unwrap();
        assert!(!result.success);
        assert!(result.error_details.unwrap().contains("no text"));
        assert_eq!(server.state.requests.lock().unwrap().len(), 2);
    }

    #[tokio::test(start_paused = true)]
    async fn transient_errors_keep_the_shared_retry_policy_and_attempt_budget() {
        let server = ProbeServer::spawn(
            Some((StatusCode::SERVICE_UNAVAILABLE, "Service unavailable")),
            None,
        )
        .await;
        let result = test_connection(&server.client, 2).await.unwrap();
        assert!(!result.success);
        let requests = server.state.requests.lock().unwrap();
        assert_eq!(requests.len(), 2);
        assert!(requests.iter().all(|body| body.get("tools").is_some()));
    }
}
