use super::{apply_model_default_reasoning, AIClient};
use crate::service::config::types::AIModelConfig;
use openbitfun_ai_adapters::ConnectionTestResult;
use openbitfun_core_types::{ReasoningCatalogBinding, ReasoningConfig};
use serde_json::{json, Value};
use std::io::{BufRead, BufReader, Read, Write};
use std::time::Duration;

/// A local provider accepts Auto and its supported efforts, but rejects high.
/// It never interprets the probe's instruction or contacts an external service.
async fn probe_draft(
    reasoning: Option<ReasoningConfig>,
    custom_request_body: Option<String>,
) -> (ConnectionTestResult, Value) {
    let listener = std::net::TcpListener::bind("127.0.0.1:0").unwrap();
    let endpoint = format!("http://{}/v1", listener.local_addr().unwrap());
    let server = std::thread::spawn(move || {
        let (mut stream, _) = listener.accept().unwrap();
        stream
            .set_read_timeout(Some(Duration::from_secs(5)))
            .unwrap();
        let mut reader = BufReader::new(stream.try_clone().unwrap());
        let mut length = 0;
        loop {
            let mut line = String::new();
            assert!(reader.read_line(&mut line).unwrap() > 0);
            if line == "\r\n" {
                break;
            }
            if let Some(value) = line.to_ascii_lowercase().strip_prefix("content-length:") {
                length = value.trim().parse::<usize>().unwrap();
            }
        }
        let mut bytes = vec![0; length];
        reader.read_exact(&mut bytes).unwrap();
        let body: Value = serde_json::from_slice(&bytes).unwrap();
        if body["reasoning_effort"] == "high" {
            let response = json!({"error": {
                "message": "Unsupported reasoning effort high; supported values are medium and low",
                "type": "BadRequestError", "code": 400
            }})
            .to_string();
            write!(stream, "HTTP/1.1 400 Bad Request\r\nContent-Type: application/json\r\nContent-Length: {}\r\nConnection: close\r\n\r\n{}", response.len(), response).unwrap();
        } else {
            let chunk = json!({"id":"probe-fixture", "object":"chat.completion.chunk",
                "created":0, "model":"unsaved-draft-model", "choices":[{"index":0,
                "delta":{"content":"OK"}, "finish_reason":"stop"}]});
            let response = format!("data: {chunk}\n\ndata: [DONE]\n\n");
            write!(stream, "HTTP/1.1 200 OK\r\nContent-Type: text/event-stream\r\nContent-Length: {}\r\nConnection: close\r\n\r\n{}", response.len(), response).unwrap();
        }
        body
    });
    // This ID is never installed in a config store. A probe must honor the
    // supplied unsaved draft rather than substituting a cached client by ID.
    let model = AIModelConfig {
        id: "unregistered-draft-id".into(),
        name: "Unsaved draft".into(),
        provider: "openai".into(),
        model_name: "unsaved-draft-model".into(),
        base_url: endpoint,
        api_key: "synthetic-key".into(),
        reasoning,
        custom_request_body,
        custom_request_body_mode: Some("merge".into()),
        max_tokens: Some(1_024),
        ..Default::default()
    };
    let original = serde_json::to_value(&model).unwrap();
    let client = AIClient::new(model.clone().try_into().unwrap());
    let transport_config = serde_json::to_value(&client.config).unwrap();
    let client = apply_model_default_reasoning(client, &model).await;
    assert_eq!(
        serde_json::to_value(&client.config).unwrap(),
        transport_config
    );
    assert!(client.selected_reasoning_preset().is_none());
    let result = client.test_connection().await.unwrap();
    let request = server.join().unwrap();
    assert_eq!(request["model"], "unsaved-draft-model");
    assert_eq!(request["max_tokens"], 1_024);
    assert_eq!(serde_json::to_value(&model).unwrap(), original);
    (result, request)
}

fn default_reasoning(preset: &str) -> ReasoningConfig {
    ReasoningConfig {
        default_preset: Some(preset.into()),
        ..Default::default()
    }
}

#[tokio::test]
async fn connection_probe_rejects_the_same_unsupported_model_default_as_chat() {
    let (result, request) = probe_draft(Some(default_reasoning("high")), None).await;
    assert_eq!(request["reasoning_effort"], "high");
    assert!(!result.success);
    assert!(result
        .error_details
        .unwrap()
        .contains("reasoning effort high"));
}

#[tokio::test]
async fn connection_probe_preserves_legacy_supported_and_custom_body_policies() {
    for (reasoning, custom, expected) in [
        (None, None, None),
        (Some(default_reasoning("medium")), None, Some("medium")),
        (
            Some(default_reasoning("high")),
            Some(
                json!({"reasoning_effort": "medium", "chat_template_kwargs": {
                    "enable_thinking": true, "preserve_thinking": true
                }})
                .to_string(),
            ),
            Some("medium"),
        ),
        (
            Some(ReasoningConfig {
                catalog: ReasoningCatalogBinding::Disabled,
                ..default_reasoning("high")
            }),
            None,
            None,
        ),
    ] {
        let (result, request) = probe_draft(reasoning, custom).await;
        assert!(result.success, "{:?}", result.error_details);
        assert_eq!(
            request.get("reasoning_effort").and_then(Value::as_str),
            expected
        );
        if request.get("chat_template_kwargs").is_some() {
            assert_eq!(request["chat_template_kwargs"]["enable_thinking"], true);
            assert_eq!(request["chat_template_kwargs"]["preserve_thinking"], true);
        }
    }
}
