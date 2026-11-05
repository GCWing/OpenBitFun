use super::*;
use serde_json::{json, Value};
use std::time::Duration;
use tokio::io::{AsyncReadExt, AsyncWriteExt};

fn host_and_draft(endpoint: &str) -> (AIConfig, AIModelConfig) {
    let mut host = AIConfig::default();
    host.model_routing.router_model_id = Some("router".into());
    host.model_routing.protocol = "openai_router_extension".into();
    host.model_routing.timeout_ms = 1_000;
    host.models.push(AIModelConfig {
        id: "router".into(),
        name: "saved router".into(),
        provider: "openai".into(),
        base_url: "http://127.0.0.1:1/v1".into(),
        model_name: "saved-model".into(),
        enabled: true,
        ..Default::default()
    });
    let draft = AIModelConfig {
        id: "router".into(),
        name: "draft router".into(),
        provider: "openai".into(),
        base_url: endpoint.into(),
        model_name: "draft-model".into(),
        api_key: "draft-key".into(),
        enabled: true,
        ..Default::default()
    };
    (host, draft)
}

fn classifier_response() -> Value {
    let prediction =
        json!({"phase":"planning", "phase_detail":"plan_created", "simple_type":"simple"});
    json!({"choices":[{"message":{"content":prediction.to_string()}}],
        "router":{"prediction":prediction,"probabilities":{"simple_type":{"simple":0.8,"non_simple":0.2}}},
        "usage":{"prompt_tokens":2000,"completion_tokens":0,"total_tokens":2000}})
}

async fn server(response: Value, delay: Duration) -> (String, tokio::task::JoinHandle<Value>) {
    let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
    let endpoint = format!("http://{}/v1", listener.local_addr().unwrap());
    let server = tokio::spawn(async move {
        let (mut stream, _) = tokio::time::timeout(Duration::from_secs(5), listener.accept())
            .await
            .unwrap()
            .unwrap();
        let mut request = Vec::new();
        let header_end = loop {
            let mut chunk = [0; 4096];
            let count = stream.read(&mut chunk).await.unwrap();
            assert!(count > 0);
            request.extend_from_slice(&chunk[..count]);
            if let Some(offset) = request.windows(4).position(|x| x == b"\r\n\r\n") {
                break offset + 4;
            }
        };
        let headers = String::from_utf8_lossy(&request[..header_end]).to_ascii_lowercase();
        assert!(headers.starts_with("post /v1/chat/completions "));
        assert!(headers.contains("authorization: bearer draft-key\r\n"));
        let length: usize = headers
            .lines()
            .find_map(|line| line.strip_prefix("content-length:"))
            .unwrap()
            .trim()
            .parse()
            .unwrap();
        let mut body = request[header_end..].to_vec();
        while body.len() < length {
            let mut chunk = [0; 4096];
            let count = stream.read(&mut chunk).await.unwrap();
            assert!(count > 0);
            body.extend_from_slice(&chunk[..count]);
        }
        tokio::time::sleep(delay).await;
        let response = response.to_string();
        let _ = stream.write_all(format!("HTTP/1.1 200 OK\r\nContent-Type: application/json\r\nContent-Length: {}\r\nConnection: close\r\n\r\n{}", response.len(), response).as_bytes()).await;
        serde_json::from_slice(&body[..length]).unwrap()
    });
    (endpoint, server)
}

#[tokio::test]
async fn router_model_probe_tests_the_supplied_draft_with_classifier_wire() {
    let (endpoint, server) = server(classifier_response(), Duration::ZERO).await;
    let (host, draft) = host_and_draft(&endpoint);
    let original_host = serde_json::to_value(&host).unwrap();
    let result = probe_for_config(&host, &draft, true).await.unwrap();
    assert!(result.success, "{:?}", result.error_details);
    assert!(result.message_code.is_none());
    assert!(result.error_details.is_none());
    let request = server.await.unwrap();
    assert_eq!(request["model"], "draft-model");
    assert_eq!(request["messages"].as_array().unwrap().len(), 2);
    assert_eq!(
        request["messages"][0]["content"],
        super::super::SYSTEM_PROMPT
    );
    assert_eq!(request["stream"], false);
    for absent in [
        "tools",
        "tool_choice",
        "stream_options",
        "logprobs",
        "chat_template_kwargs",
    ] {
        assert!(request.get(absent).is_none(), "{absent}");
    }
    assert_eq!(serde_json::to_value(&host).unwrap(), original_host);
}

#[tokio::test]
async fn router_model_probe_respects_the_router_deadline() {
    let (endpoint, server) = server(classifier_response(), Duration::from_millis(160)).await;
    let (mut host, draft) = host_and_draft(&endpoint);
    host.model_routing.timeout_ms = 40;
    let result = probe_for_config(&host, &draft, true).await.unwrap();
    assert!(!result.success);
    assert!(result.response_time_ms < 1_000);
    assert!(result.error_details.is_some());
    server.await.unwrap();
}

#[tokio::test]
async fn router_model_probe_invalid_probabilities_fail_instead_of_fake_success() {
    let (endpoint, server) = server(
        json!({"choices":[{"message":{"content":"{\"simple_type\":\"simple\"}"}}]}),
        Duration::ZERO,
    )
    .await;
    let (host, draft) = host_and_draft(&endpoint);
    let result = probe_for_config(&host, &draft, true).await.unwrap();
    assert!(!result.success);
    assert!(result
        .error_details
        .unwrap()
        .contains("classification extension"));
    server.await.unwrap();
}

#[tokio::test]
async fn router_model_probe_ordinary_models_keep_the_existing_host_test() {
    let (mut host, mut draft) = host_and_draft("http://127.0.0.1:1/v1");
    host.model_routing.protocol = "future-protocol".into();
    draft.id = "ordinary-model".into();
    assert!(probe_for_config(&host, &draft, true).await.is_none());
    draft.id.clear();
    assert!(probe_for_config(&host, &draft, true).await.is_none());
}

#[tokio::test]
async fn router_model_probe_closed_or_unknown_profiles_do_not_send_requests() {
    let listener = std::net::TcpListener::bind("127.0.0.1:0").unwrap();
    listener.set_nonblocking(true).unwrap();
    let endpoint = format!("http://{}/v1", listener.local_addr().unwrap());
    let (mut host, draft) = host_and_draft(&endpoint);
    let closed = probe_for_config(&host, &draft, false).await.unwrap();
    assert!(!closed.success);
    assert!(closed
        .error_details
        .unwrap()
        .contains("unavailable in this release"));
    host.model_routing.protocol = "future-protocol".into();
    let unknown = probe_for_config(&host, &draft, true).await.unwrap();
    assert!(!unknown.success);
    assert!(unknown
        .error_details
        .unwrap()
        .contains("Unsupported Router protocol"));
    assert_eq!(
        listener.accept().unwrap_err().kind(),
        std::io::ErrorKind::WouldBlock
    );
}

#[tokio::test]
#[ignore = "Requires the configured live local classifier; opt in with ROUTER_EXTENSION_TEST_URL"]
async fn router_model_probe_live_classifier_checks_the_supplied_candidate() {
    let endpoint =
        std::env::var("ROUTER_EXTENSION_TEST_URL").expect("Set ROUTER_EXTENSION_TEST_URL");
    let model =
        std::env::var("ROUTER_EXTENSION_TEST_MODEL").expect("Set ROUTER_EXTENSION_TEST_MODEL");
    let (mut host, mut draft) = host_and_draft(&endpoint);
    host.model_routing.timeout_ms = 120_000;
    draft.request_url = Some(endpoint);
    draft.model_name = model;
    draft.context_window = Some(32_768);
    draft.api_key.clear();
    let result = probe_for_config(&host, &draft, true).await.unwrap();
    assert!(result.success, "{:?}", result.error_details);
    assert!(result.message_code.is_none());
}
