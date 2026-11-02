use super::stream_stats::StreamStats;
use super::{next_stream_item, StreamTimeoutController, StreamTimeoutStage, TimedStreamItem};
use crate::stream::types::gemini::GeminiSSEData;
use crate::stream::types::unified::UnifiedResponse;
use anyhow::{anyhow, Result};
use eventsource_stream::Eventsource;
use log::{error, trace};
use openbitfun_core_types::errors::AiProviderError;
use reqwest::Response;
use serde_json::Value;
use std::collections::HashMap;
use std::sync::atomic::{AtomicU64, Ordering};
use std::time::Duration;
use tokio::sync::mpsc;

const AI_STREAM_RESPONSE_TARGET: &str = "ai::gemini_stream_response";

static GEMINI_STREAM_ID_SEQ: AtomicU64 = AtomicU64::new(1);

#[derive(Debug)]
struct GeminiToolCallState {
    active_calls: HashMap<Option<usize>, (String, Option<String>)>,
    stream_id: u64,
    next_index: usize,
}

impl GeminiToolCallState {
    fn new() -> Self {
        Self {
            active_calls: HashMap::new(),
            stream_id: GEMINI_STREAM_ID_SEQ.fetch_add(1, Ordering::Relaxed),
            next_index: 0,
        }
    }

    fn on_non_tool_response(&mut self) {
        self.active_calls.clear();
    }

    fn assign_id(&mut self, tool_call: &mut crate::stream::types::unified::UnifiedToolCall) {
        let tool_key = tool_call.tool_call_index;
        if let Some(existing_id) = tool_call.id.as_ref().filter(|value| !value.is_empty()) {
            self.active_calls.insert(
                tool_key,
                (
                    existing_id.clone(),
                    tool_call.name.clone().filter(|value| !value.is_empty()),
                ),
            );
            return;
        }

        let tool_name = tool_call.name.clone().filter(|value| !value.is_empty());
        if let Some((_, active_name)) = self.active_calls.get(&tool_key) {
            if active_name == &tool_name {
                tool_call.id = None;
                return;
            }
        }

        self.next_index += 1;
        let generated_id = format!("gemini_call_{}_{}", self.stream_id, self.next_index);
        tool_call.id = Some(generated_id.clone());
        self.active_calls
            .insert(tool_key, (generated_id, tool_name));
    }
}

fn extract_api_error_message(event_json: &Value) -> Option<String> {
    let error = event_json.get("error")?;
    if let Some(message) = error.get("message").and_then(Value::as_str) {
        return Some(message.to_string());
    }
    if let Some(message) = error.as_str() {
        return Some(message.to_string());
    }
    Some("Gemini streaming request failed".to_string())
}

fn extract_api_error(event_json: &Value) -> Option<AiProviderError> {
    let error = event_json.get("error")?;
    let code = error
        .get("status")
        .or_else(|| error.get("code"))
        .and_then(|value| match value {
            Value::String(value) => Some(value.clone()),
            Value::Number(value) => Some(value.to_string()),
            _ => None,
        });
    let mut detail = AiProviderError::from_parts(
        extract_api_error_message(event_json)?,
        Some("gemini".to_string()),
        code,
        None,
    );
    // This is a Google RPC status in an SSE event, not an HTTP status.
    // Preserve more specific quota/context classifications from the message.
    if matches!(
        detail.category,
        openbitfun_core_types::errors::ErrorCategory::Unknown
            | openbitfun_core_types::errors::ErrorCategory::ModelError
    ) && detail.provider_code.as_deref() == Some("RESOURCE_EXHAUSTED")
    {
        detail.category = openbitfun_core_types::errors::ErrorCategory::RateLimit;
    }
    Some(detail)
}

pub async fn handle_gemini_stream(
    response: Response,
    tx_event: mpsc::UnboundedSender<Result<UnifiedResponse>>,
    tx_raw_sse: Option<mpsc::UnboundedSender<String>>,
    ttft_timeout: Option<Duration>,
    idle_timeout: Option<Duration>,
) {
    handle_gemini_stream_inner(
        response,
        tx_event,
        tx_raw_sse,
        ttft_timeout,
        idle_timeout,
        false,
    )
    .await;
}

/// Code Assist wraps the ordinary Gemini event in a response envelope.
/// Keep that translation at the adapter boundary; public Gemini remains flat.
pub async fn handle_gemini_code_assist_stream(
    response: Response,
    tx_event: mpsc::UnboundedSender<Result<UnifiedResponse>>,
    tx_raw_sse: Option<mpsc::UnboundedSender<String>>,
    ttft_timeout: Option<Duration>,
    idle_timeout: Option<Duration>,
) {
    handle_gemini_stream_inner(
        response,
        tx_event,
        tx_raw_sse,
        ttft_timeout,
        idle_timeout,
        true,
    )
    .await;
}

async fn handle_gemini_stream_inner(
    response: Response,
    tx_event: mpsc::UnboundedSender<Result<UnifiedResponse>>,
    tx_raw_sse: Option<mpsc::UnboundedSender<String>>,
    ttft_timeout: Option<Duration>,
    idle_timeout: Option<Duration>,
    code_assist: bool,
) {
    let mut stream = response.bytes_stream().eventsource();
    let mut received_finish_reason = false;
    let mut tool_call_state = GeminiToolCallState::new();
    let mut stats = StreamStats::new("Gemini");
    let mut timeout_controller = StreamTimeoutController::new(ttft_timeout, idle_timeout);

    loop {
        let sse = match next_stream_item(&mut stream, &timeout_controller).await {
            TimedStreamItem::Item(Ok(sse)) => sse,
            TimedStreamItem::End => {
                if received_finish_reason {
                    stats.log_summary("stream_closed_after_finish_reason");
                    return;
                }
                let error_msg = "Gemini SSE stream closed before response completed";
                stats.log_summary("stream_closed_before_completion");
                error!("{}", error_msg);
                let _ = tx_event.send(Err(anyhow!(error_msg)));
                return;
            }
            TimedStreamItem::Item(Err(e)) => {
                let error_msg = format!("Gemini SSE stream error: {}", e);
                stats.log_summary("sse_stream_error");
                error!("{}", error_msg);
                let _ = tx_event.send(Err(anyhow!(error_msg)));
                return;
            }
            TimedStreamItem::TimedOut(StreamTimeoutStage::Ttft) => {
                let timeout_secs = ttft_timeout.map(|timeout| timeout.as_secs()).unwrap_or(0);
                let error_msg = format!(
                    "Gemini stream TTFT timeout after {}s waiting for first effective output",
                    timeout_secs
                );
                stats.log_summary("ttft_timeout");
                error!("{}", error_msg);
                let _ = tx_event.send(Err(anyhow!(error_msg)));
                return;
            }
            TimedStreamItem::TimedOut(StreamTimeoutStage::Idle) => {
                let timeout_secs = idle_timeout.map(|timeout| timeout.as_secs()).unwrap_or(0);
                let error_msg = format!("Gemini SSE stream timeout after {}s", timeout_secs);
                stats.log_summary("sse_stream_timeout");
                error!("{}", error_msg);
                let _ = tx_event.send(Err(anyhow!(error_msg)));
                return;
            }
        };

        let raw = sse.data;
        stats.record_sse_event("data");
        trace!(target: AI_STREAM_RESPONSE_TARGET, "Gemini SSE: {:?}", raw);

        if let Some(ref tx) = tx_raw_sse {
            let _ = tx.send(raw.clone());
        }

        if raw == "[DONE]" {
            stats.increment("marker:done");
            stats.log_summary("done_marker_received");
            return;
        }

        let event_json: Value = match serde_json::from_str(&raw) {
            Ok(json) => json,
            Err(e) => {
                let error_msg = format!("Gemini SSE parsing error: {}, data: {}", e, raw);
                stats.increment("error:sse_parsing");
                stats.log_summary("sse_parsing_error");
                error!("{}", error_msg);
                let _ = tx_event.send(Err(anyhow!(error_msg)));
                return;
            }
        };

        // Top-level errors retain priority over an optional response envelope.
        // Raw SSE is captured before translation for diagnostics and replay.
        let event_json = if code_assist && event_json.get("error").is_none() {
            event_json.get("response").cloned().unwrap_or(event_json)
        } else {
            event_json
        };

        if let Some(mut provider_error) = extract_api_error(&event_json) {
            provider_error.message = format!(
                "Gemini SSE API error: {}, data: {}",
                provider_error.message, raw
            );
            stats.increment("error:api");
            stats.log_summary("sse_api_error");
            error!("{}", provider_error);
            let _ = tx_event.send(Err(anyhow!(provider_error)));
            return;
        }

        let sse_data: GeminiSSEData = match serde_json::from_value(event_json) {
            Ok(data) => data,
            Err(e) => {
                let error_msg = format!("Gemini SSE data schema error: {}, data: {}", e, raw);
                stats.increment("error:schema");
                stats.log_summary("sse_data_schema_error");
                error!("{}", error_msg);
                let _ = tx_event.send(Err(anyhow!(error_msg)));
                return;
            }
        };

        let mut unified_responses = sse_data.into_unified_responses();
        if unified_responses.is_empty() {
            stats.increment("skip:empty_unified_responses");
        }
        for unified_response in &mut unified_responses {
            if let Some(tool_call) = unified_response.tool_call.as_mut() {
                tool_call_state.assign_id(tool_call);
            } else {
                tool_call_state.on_non_tool_response();
            }

            if unified_response.finish_reason.is_some() {
                received_finish_reason = true;
                tool_call_state.on_non_tool_response();
            }
        }

        trace!(
            target: AI_STREAM_RESPONSE_TARGET,
            "Gemini unified responses: {:?}",
            unified_responses
        );

        for unified_response in unified_responses {
            timeout_controller.observe_unified_response(&unified_response);
            stats.record_unified_response(&unified_response);
            let _ = tx_event.send(Ok(unified_response));
        }
    }
}

#[cfg(test)]
mod tests {
    use super::{extract_api_error, GeminiToolCallState};
    use crate::stream::types::unified::UnifiedToolCall;
    use openbitfun_core_types::errors::ErrorCategory;

    async fn parse_http_event(
        event: serde_json::Value,
        code_assist: bool,
    ) -> (Vec<anyhow::Result<super::UnifiedResponse>>, Vec<String>) {
        use axum::{body::Body, extract::State, http::header, routing::get, Router};
        async fn serve(
            State(body): State<String>,
        ) -> ([(header::HeaderName, &'static str); 1], Body) {
            (
                [(header::CONTENT_TYPE, "text/event-stream")],
                Body::from(body),
            )
        }
        let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
        let url = format!("http://{}/events", listener.local_addr().unwrap());
        let payload = format!("data: {}\n\n", event);
        let task = tokio::spawn(async move {
            axum::serve(
                listener,
                Router::new()
                    .route("/events", get(serve))
                    .with_state(payload),
            )
            .await
            .unwrap();
        });
        openbitfun_services_core::tls_provider::ensure_ring_crypto_provider();
        let response = reqwest::Client::builder()
            .no_proxy()
            .build()
            .unwrap()
            .get(url)
            .send()
            .await
            .unwrap();
        let (tx, mut rx) = tokio::sync::mpsc::unbounded_channel();
        let (raw_tx, mut raw_rx) = tokio::sync::mpsc::unbounded_channel();
        super::handle_gemini_stream_inner(response, tx, Some(raw_tx), None, None, code_assist)
            .await;
        let mut events = Vec::new();
        while let Some(event) = rx.recv().await {
            events.push(event);
        }
        let mut raw = Vec::new();
        while let Some(event) = raw_rx.recv().await {
            raw.push(event);
        }
        task.abort();
        (events, raw)
    }

    #[tokio::test]
    async fn code_assist_http_envelope_retains_text_signature_usage_and_completion() {
        let payload = serde_json::json!({
            "candidates":[{"content":{"parts":[{"text":"answer","thoughtSignature":"fixture-signature"}]},"finishReason":"STOP"}],
            "usageMetadata":{"promptTokenCount":20,"candidatesTokenCount":5,"totalTokenCount":25}
        });
        for (event, code_assist) in [
            (payload.clone(), false),
            (payload.clone(), true),
            (
                serde_json::json!({"response":payload,"traceId":"fixture-trace"}),
                true,
            ),
        ] {
            let (events, raw) = parse_http_event(event.clone(), code_assist).await;
            assert!(events.iter().all(Result::is_ok));
            let events: Vec<_> = events.into_iter().map(Result::unwrap).collect();
            assert!(events
                .iter()
                .any(|event| event.text.as_deref() == Some("answer")));
            assert!(events
                .iter()
                .any(|event| event.thinking_signature.as_deref() == Some("fixture-signature")));
            assert!(events
                .iter()
                .any(|event| event.finish_reason.as_deref() == Some("STOP")));
            assert!(events.iter().any(|event| event
                .usage
                .as_ref()
                .is_some_and(
                    |usage| usage.prompt_token_count == 20 && usage.candidates_token_count == 5
                )));
            assert_eq!(raw, vec![event.to_string()]);
        }
    }

    #[tokio::test]
    async fn code_assist_wrapped_errors_are_classified_and_public_gemini_does_not_guess_envelopes()
    {
        let (events, _) = parse_http_event(serde_json::json!({"response":{"error":{"status":"RESOURCE_EXHAUSTED","message":"quota exhausted"}}}), true).await;
        assert!(events
            .into_iter()
            .any(|event| event.err().is_some_and(|error| error
                .downcast_ref::<super::AiProviderError>()
                .is_some_and(|error| error.category == ErrorCategory::RateLimit
                    || error.category == ErrorCategory::ProviderQuota))));
        let (events, _) = parse_http_event(
            serde_json::json!({"response":{"candidates":[{"finishReason":"STOP"}]}}),
            false,
        )
        .await;
        assert!(events.iter().any(Result::is_err));
    }

    #[test]
    fn reuses_active_tool_id_by_omitting_follow_up_ids() {
        let mut state = GeminiToolCallState::new();

        let mut first = UnifiedToolCall {
            tool_call_index: Some(0),
            id: None,
            name: Some("get_weather".to_string()),
            arguments: Some("{\"city\":".to_string()),
            arguments_is_snapshot: false,
        };
        state.assign_id(&mut first);

        let mut second = UnifiedToolCall {
            tool_call_index: Some(0),
            id: None,
            name: Some("get_weather".to_string()),
            arguments: Some("\"Paris\"}".to_string()),
            arguments_is_snapshot: false,
        };
        state.assign_id(&mut second);

        assert!(first
            .id
            .as_deref()
            .is_some_and(|id| id.starts_with("gemini_call_")));
        assert!(second.id.is_none());
    }

    #[test]
    fn assigns_distinct_ids_for_same_named_calls_with_different_indices() {
        let mut state = GeminiToolCallState::new();

        let mut first = UnifiedToolCall {
            tool_call_index: Some(0),
            id: None,
            name: Some("read_file".to_string()),
            arguments: Some("{\"path\":\"a.rs\"}".to_string()),
            arguments_is_snapshot: true,
        };
        state.assign_id(&mut first);

        let mut second = UnifiedToolCall {
            tool_call_index: Some(1),
            id: None,
            name: Some("read_file".to_string()),
            arguments: Some("{\"path\":\"b.rs\"}".to_string()),
            arguments_is_snapshot: true,
        };
        state.assign_id(&mut second);

        let first_id = first.id.expect("first id");
        let second_id = second.id.expect("second id");
        assert_ne!(first_id, second_id);
    }

    #[test]
    fn clears_active_tool_after_non_tool_response() {
        let mut state = GeminiToolCallState::new();

        let mut first = UnifiedToolCall {
            tool_call_index: Some(0),
            id: None,
            name: Some("get_weather".to_string()),
            arguments: Some("{}".to_string()),
            arguments_is_snapshot: false,
        };
        state.assign_id(&mut first);
        state.on_non_tool_response();

        let mut second = UnifiedToolCall {
            tool_call_index: Some(0),
            id: None,
            name: Some("get_weather".to_string()),
            arguments: Some("{}".to_string()),
            arguments_is_snapshot: false,
        };
        state.assign_id(&mut second);

        let first_id = first.id.expect("first id");
        let second_id = second.id.expect("second id");
        assert!(first_id.starts_with("gemini_call_"));
        assert!(second_id.starts_with("gemini_call_"));
        assert_ne!(first_id, second_id);
    }

    #[test]
    fn generates_unique_prefixes_across_streams() {
        let mut first_state = GeminiToolCallState::new();
        let mut second_state = GeminiToolCallState::new();

        let mut first = UnifiedToolCall {
            tool_call_index: None,
            id: None,
            name: Some("grep".to_string()),
            arguments: Some("{}".to_string()),
            arguments_is_snapshot: false,
        };
        let mut second = UnifiedToolCall {
            tool_call_index: None,
            id: None,
            name: Some("read".to_string()),
            arguments: Some("{}".to_string()),
            arguments_is_snapshot: false,
        };

        first_state.assign_id(&mut first);
        second_state.assign_id(&mut second);

        assert_ne!(first.id, second.id);
    }

    #[test]
    fn classifies_context_overflow_from_gemini_error_message() {
        let event = serde_json::json!({
            "error": {
                "code": 400,
                "status": "INVALID_ARGUMENT",
                "message": "The input token count exceeds the maximum number of tokens allowed"
            }
        });

        let error = extract_api_error(&event).expect("provider error");
        assert_eq!(error.category, ErrorCategory::ContextOverflow);
        assert_eq!(error.provider_code.as_deref(), Some("INVALID_ARGUMENT"));
    }
}
