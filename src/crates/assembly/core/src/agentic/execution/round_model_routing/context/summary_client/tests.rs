use super::*;
use crate::util::types::Message as AIMessage;
use openbitfun_core_types::ReasoningConfig;
use serde_json::{json, Value};
use std::time::{Duration, Instant};

fn projection() -> ReasoningCatalogProjection {
    let configured: ReasoningConfig = serde_json::from_value(json!({
        "catalog": {"source": "auto"}
    }))
    .unwrap();
    openbitfun_ai_adapters::models_dev::project_reasoning_catalog_with_limit(
        "openai",
        "qwen3.8-flash-next",
        "https://gateway.example.invalid/v1",
        65_536,
        Some(&configured),
        None,
    )
}

fn auto_fixture(endpoint: &str) -> AIClient {
    AIClient::new(
        serde_json::from_value(json!({
            "name": "economy fixture", "model": "qwen3.8-flash-next", "format": "openai",
            "base_url": endpoint, "request_url": endpoint, "api_key": "synthetic-key",
            "context_window": 364_000, "max_tokens": 65_536,
            "temperature": 0.95, "top_p": 1.0, "inline_think_in_text": false,
            "skip_ssl_verify": false, "custom_request_body_mode": "merge",
            "custom_request_body": {"temperature": 0.95,
                "chat_template_kwargs": {"enable_thinking": true, "preserve_thinking": true}}
        }))
        .unwrap(),
    )
}

fn fixture(endpoint: &str) -> AIClient {
    let mut client = auto_fixture(endpoint);
    client.config.custom_request_body.as_mut().unwrap()["reasoning_effort"] = json!("high");
    let projection = projection();
    let high = projection
        .presets
        .iter()
        .find(|preset| preset.id == "high")
        .unwrap();
    client.with_model_reasoning_preset(high)
}

fn declared_patch_projection(effort: &str) -> ReasoningCatalogProjection {
    let configured: ReasoningConfig = serde_json::from_value(json!({
        "catalog": {"source": "disabled"},
        "presets": [{"id": effort, "actions": [{
            "type": "request_patch", "body": {"reasoning_effort": effort}
        }]}]
    }))
    .unwrap();
    openbitfun_ai_adapters::models_dev::project_reasoning_catalog_with_limit(
        "openai",
        "qwen3.8-flash-next",
        "https://gateway.example.invalid/v1",
        65_536,
        Some(&configured),
        None,
    )
}

#[test]
fn automatic_summary_does_not_treat_generic_controls_as_confirmed_capabilities() {
    let projection = projection();
    assert!(projection.presets.iter().any(|preset| preset.id == "off"));
    assert!(projection.presets.iter().any(|preset| preset.id == "on"));
    assert!(automatic_preset(&projection).is_none());
    let shared = auto_fixture("http://127.0.0.1:1/v1/chat/completions");
    let before = serde_json::to_value(&shared.config).unwrap();
    let derived = request_client(&shared, &projection, &RouterContextConfig::default()).unwrap();
    assert!(derived.selected_reasoning_preset().is_none());
    assert!(derived.model_reasoning_preset().is_none());
    assert_eq!(derived.config.max_tokens, Some(16_384));
    assert!(shared.selected_reasoning_preset().is_none());
    assert!(shared.model_reasoning_preset().is_none());
    assert_eq!(serde_json::to_value(&shared.config).unwrap(), before);
}

#[test]
fn summary_diagnostics_report_client_preset_identity_with_selected_override_priority() {
    let identity = |client: &AIClient| {
        let response = serde_json::from_value(json!({
            "text": "Confirmed synthetic history", "finish_reason": "stop"
        }))
        .unwrap();
        super::super::SummaryResult::from_response(response, "fixture".into(), client)
            .diagnostics
            .reasoning_preset
    };
    let endpoint = "http://127.0.0.1:1/v1/chat/completions";
    let config = RouterContextConfig::default();
    let unknown_auto = request_client(&auto_fixture(endpoint), &projection(), &config).unwrap();
    assert_eq!(identity(&unknown_auto), None);

    // The wire test separately proves that raw high overrides this model-level
    // low. Diagnostics report the client preset, not inferred wire parameters.
    let automatic = request_client(
        &fixture(endpoint),
        &declared_patch_projection("low"),
        &config,
    )
    .unwrap();
    assert_eq!(identity(&automatic).as_deref(), Some("low"));
    assert_eq!(
        automatic.config.custom_request_body.as_ref().unwrap()["reasoning_effort"],
        "high"
    );
    let explicit = request_client(
        &automatic,
        &projection(),
        &RouterContextConfig {
            summary_reasoning_preset: Some("medium".into()),
            ..config
        },
    )
    .unwrap();
    assert_eq!(explicit.model_reasoning_preset().unwrap().id, "low");
    assert_eq!(identity(&explicit).as_deref(), Some("medium"));
}

#[test]
fn explicit_summary_preset_is_resolved_strictly_in_the_summary_models_catalog() {
    let projection = projection();
    let shared = fixture("http://127.0.0.1:1/v1/chat/completions");
    let mut config = RouterContextConfig {
        summary_reasoning_preset: Some("medium".into()),
        ..Default::default()
    };
    let client = request_client(&shared, &projection, &config).unwrap();
    assert_eq!(client.selected_reasoning_preset().unwrap().id, "medium");
    config.summary_reasoning_preset = Some("missing-preset".into());
    assert!(request_client(&shared, &projection, &config)
        .err()
        .unwrap()
        .to_string()
        .contains("unavailable for the summary model"));
    assert_eq!(shared.model_reasoning_preset().unwrap().id, "high");
}

#[test]
fn automatic_summary_preserves_model_defaults_but_rejects_session_overlays() {
    let mut projection = projection();
    projection.presets.retain(|preset| preset.id == "off");
    let shared = fixture("http://127.0.0.1:1/v1/chat/completions");
    let configured = request_client(&shared, &projection, &RouterContextConfig::default()).unwrap();
    assert!(configured.selected_reasoning_preset().is_none());
    assert_eq!(configured.model_reasoning_preset().unwrap().id, "high");
    let inherited_session = shared.with_reasoning_preset(shared.model_reasoning_preset().unwrap());
    assert!(request_client(
        &inherited_session,
        &projection,
        &RouterContextConfig::default()
    )
    .is_err());
    projection.presets[0].source = ReasoningPresetSource::ModelConfig;
    assert_eq!(automatic_preset(&projection).unwrap().id, "off");

    let config = RouterContextConfig {
        summary_reasoning_preset: Some("off".into()),
        ..Default::default()
    };
    projection.presets[0].source = ReasoningPresetSource::AdapterFallback;
    assert_eq!(
        request_client(&shared, &projection, &config)
            .unwrap()
            .selected_reasoning_preset()
            .unwrap()
            .id,
        "off"
    );
}

#[test]
fn models_without_reasoning_presets_keep_automatic_requests_unchanged() {
    let shared = AIClient::new(
        serde_json::from_value(json!({
            "name": "text fixture", "model": "text-only", "format": "openai",
            "base_url": "http://127.0.0.1:1/v1", "request_url": "http://127.0.0.1:1/v1/chat/completions",
            "api_key": "synthetic-key", "context_window": 65_536, "max_tokens": 32_768,
            "inline_think_in_text": false, "skip_ssl_verify": false
        }))
        .unwrap(),
    );
    let disabled: ReasoningConfig = serde_json::from_value(json!({
        "catalog": {"source": "disabled"}
    }))
    .unwrap();
    let projection = openbitfun_ai_adapters::models_dev::project_reasoning_catalog_with_limit(
        "openai",
        "text-only",
        "http://127.0.0.1:1/v1",
        32_768,
        Some(&disabled),
        None,
    );
    assert!(projection.presets.is_empty());
    let request = request_client(&shared, &projection, &RouterContextConfig::default()).unwrap();
    assert!(request.selected_reasoning_preset().is_none());
    assert!(request.model_reasoning_preset().is_none());
    assert_eq!(request.config.max_tokens, Some(16_384));
    assert_eq!(shared.config.max_tokens, Some(32_768));
}

#[test]
fn send_time_validation_rejects_history_prepared_for_a_larger_model_window() {
    let config = RouterContextConfig::default();
    let shared = fixture("http://127.0.0.1:1/v1/chat/completions");
    let large = request_client(&shared, &projection(), &config).unwrap();
    let prompt = "x".repeat(100_000);
    assert!(validate_input(&large, &config, &prompt).is_ok());
    let mut smaller = large.clone();
    smaller.config.context_window = 32_768;
    let error = validate_input(&smaller, &config, &prompt).unwrap_err();
    assert!(error
        .to_string()
        .contains("exceeds the current summary model budget"));
    assert!(input_budget(&smaller, &config).unwrap() < input_budget(&large, &config).unwrap());

    let budget = input_budget(&smaller, &config).unwrap();
    // Estimated ASCII count is ceil(bytes / 3); exercise the exact boundary.
    assert!(validate_input(&smaller, &config, &"x".repeat(budget * 3)).is_ok());
    assert!(validate_input(&smaller, &config, &"x".repeat(budget * 3 + 1)).is_err());
}

#[test]
fn summary_budget_reserves_actual_output_system_framing_and_window_margin() {
    let config = RouterContextConfig::default();
    let shared = fixture("http://127.0.0.1:1/v1/chat/completions");
    let mut client = request_client(&shared, &projection(), &config).unwrap();
    let system = EstimatedRouterTokens.count(&summary_system_prompt(&config));
    assert_eq!(
        input_budget(&client, &config).unwrap(),
        364_000 - 36_400 - 16_384 - system - 256
    );
    client.config.max_tokens = Some(8_192);
    assert_eq!(
        input_budget(&client, &config).unwrap(),
        364_000 - 36_400 - 8_192 - system - 256
    );
    client.config.context_window = 16_384;
    client.config.max_tokens = Some(16_384);
    assert!(input_budget(&client, &config).is_err());
    assert!(validate_input(&client, &config, "small history").is_err());
}

fn wire_server(request_count: usize) -> (String, std::thread::JoinHandle<Vec<Value>>) {
    wire_server_with_reasoning_policy(request_count, false)
}

fn wire_server_with_reasoning_policy(
    request_count: usize,
    reject_reasoning: bool,
) -> (String, std::thread::JoinHandle<Vec<Value>>) {
    use std::io::{BufRead, BufReader, Read, Write};
    let listener = std::net::TcpListener::bind("127.0.0.1:0").unwrap();
    listener.set_nonblocking(true).unwrap();
    let endpoint = format!(
        "http://{}/v1/chat/completions",
        listener.local_addr().unwrap()
    );
    let server = std::thread::spawn(move || {
        let mut requests = Vec::new();
        for _ in 0..request_count {
            let deadline = Instant::now() + Duration::from_secs(5);
            let mut stream = loop {
                match listener.accept() {
                    Ok((stream, _)) => break stream,
                    Err(error) if error.kind() == std::io::ErrorKind::WouldBlock => {
                        assert!(
                            Instant::now() < deadline,
                            "Expected summary request did not arrive"
                        );
                        std::thread::sleep(Duration::from_millis(5));
                    }
                    Err(error) => panic!("Summary fixture could not accept request: {error}"),
                }
            };
            stream
                .set_read_timeout(Some(Duration::from_secs(5)))
                .unwrap();
            stream
                .set_write_timeout(Some(Duration::from_secs(5)))
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
                    length = value.trim().parse().unwrap();
                }
            }
            let mut body = vec![0; length];
            reader.read_exact(&mut body).unwrap();
            let body = serde_json::from_slice::<Value>(&body).unwrap();
            let unsupported = reject_reasoning && body.get("reasoning_effort").is_some();
            requests.push(body);
            if unsupported {
                let response = json!({"error": {"message": "reasoning_effort is unsupported",
                    "type": "BadRequestError", "code": 400}})
                .to_string();
                write!(stream, "HTTP/1.1 400 Bad Request\r\nContent-Type: application/json\r\nContent-Length: {}\r\nConnection: close\r\n\r\n{}", response.len(), response).unwrap();
                continue;
            }
            let response = format!(
                "data: {}\n\ndata: [DONE]\n\n",
                json!({
                    "id":"summary-fixture", "object":"chat.completion.chunk", "created":0,
                    "model":"qwen3.8-flash-next", "choices":[{"index":0,
                        "delta":{"content":"Confirmed parser history; verification pending."},
                        "finish_reason":"stop"}]
                })
            );
            write!(stream, "HTTP/1.1 200 OK\r\nContent-Type: text/event-stream\r\nContent-Length: {}\r\nConnection: close\r\n\r\n{}", response.len(), response).unwrap();
        }
        requests
    });
    (endpoint, server)
}

#[tokio::test]
async fn auxiliary_wire_preserves_custom_body_priority_and_explicit_overrides_without_mutation() {
    let (endpoint, server) = wire_server(4);
    let shared = fixture(&endpoint);
    let projection = projection();
    let config = RouterContextConfig::default();
    let automatic = request_client(&shared, &declared_patch_projection("low"), &config).unwrap();
    assert_eq!(automatic.model_reasoning_preset().unwrap().id, "low");
    assert!(automatic.selected_reasoning_preset().is_none());
    let explicit = request_client(
        &shared,
        &projection,
        &RouterContextConfig {
            summary_reasoning_preset: Some("medium".into()),
            ..config.clone()
        },
    )
    .unwrap();
    let messages = || vec![AIMessage::user("Synthetic parser fixture".into())];
    shared.send_message(messages(), None).await.unwrap();
    automatic.send_message(messages(), None).await.unwrap();
    explicit.send_message(messages(), None).await.unwrap();
    shared.send_message(messages(), None).await.unwrap();
    let requests = server.join().unwrap();
    assert_eq!(requests[0], requests[3]);
    assert_eq!(requests[0]["reasoning_effort"], "high");
    assert_eq!(requests[0]["max_tokens"], 65_536);
    assert_eq!(requests[1]["reasoning_effort"], "high");
    assert_eq!(requests[1]["max_tokens"], 16_384);
    assert_eq!(requests[2]["reasoning_effort"], "medium");
    assert_eq!(requests[2]["max_tokens"], 16_384);
    assert!(requests[1].get("tools").is_none());
    assert_eq!(requests[1]["temperature"], requests[0]["temperature"]);
    assert_eq!(
        requests[1]["chat_template_kwargs"],
        requests[0]["chat_template_kwargs"]
    );
    assert!(shared.selected_reasoning_preset().is_none());
    assert_eq!(shared.model_reasoning_preset().unwrap().id, "high");
}

#[tokio::test]
async fn unknown_auto_and_disabled_omit_effort_but_explicit_policies_are_not_rewritten() {
    tokio::time::timeout(Duration::from_secs(10), async {
        let (endpoint, server) = wire_server_with_reasoning_policy(4, true);
        let shared = auto_fixture(&endpoint);
        let before = serde_json::to_value(&shared.config).unwrap();
        let config = RouterContextConfig::default();
        let generic = projection();
        let disabled: ReasoningConfig = serde_json::from_value(json!({
            "catalog": {"source": "disabled"}
        }))
        .unwrap();
        let disabled = openbitfun_ai_adapters::models_dev::project_reasoning_catalog_with_limit(
            "openai",
            "qwen3.8-flash-next",
            &endpoint,
            65_536,
            Some(&disabled),
            None,
        );
        for projection in [&generic, &disabled] {
            let client = request_client(&shared, projection, &config).unwrap();
            assert!(client.selected_reasoning_preset().is_none());
            assert!(client.model_reasoning_preset().is_none());
            send_request(&client, &config, "Synthetic history".into())
                .await
                .unwrap();
        }
        // An explicit model default is user policy even when an unknown service
        // rejects it. Auto must not silently substitute low/off or learn a mapping.
        let explicit_model = fixture(&endpoint);
        let model_before = serde_json::to_value(&explicit_model.config).unwrap();
        let client = request_client(&explicit_model, &generic, &config).unwrap();
        let error = send_request(&client, &config, "Synthetic history".into())
            .await
            .expect_err("The explicit model default must reach the rejecting provider unchanged");
        assert!(error
            .to_string()
            .contains("reasoning_effort is unsupported"));
        let explicit_config = RouterContextConfig {
            summary_reasoning_preset: Some("low".into()),
            ..config.clone()
        };
        let explicit_summary = request_client(&shared, &generic, &explicit_config).unwrap();
        let error = send_request(
            &explicit_summary,
            &explicit_config,
            "Synthetic history".into(),
        )
        .await
        .expect_err("The explicit summary preset must reach the rejecting provider unchanged");
        assert!(error
            .to_string()
            .contains("reasoning_effort is unsupported"));
        let requests = tokio::task::spawn_blocking(move || server.join().unwrap())
            .await
            .unwrap();
        assert!(requests[0].get("reasoning_effort").is_none());
        assert!(requests[1].get("reasoning_effort").is_none());
        assert_eq!(requests[2]["reasoning_effort"], "high");
        assert_eq!(requests[3]["reasoning_effort"], "low");
        assert!(requests
            .iter()
            .all(|request| request["max_tokens"] == 16_384));
        for request in &requests {
            assert_eq!(request["messages"].as_array().unwrap().len(), 2);
            assert_eq!(request["messages"][0]["role"], "system");
            assert_eq!(
                request["messages"][0]["content"],
                summary_system_prompt(&config)
            );
            assert_eq!(request["messages"][1]["role"], "user");
            assert_eq!(request["messages"][1]["content"], "Synthetic history");
            assert!(request.get("tools").is_none());
        }
        assert_eq!(serde_json::to_value(&shared.config).unwrap(), before);
        assert_eq!(
            serde_json::to_value(&explicit_model.config).unwrap(),
            model_before
        );
        assert_eq!(explicit_model.model_reasoning_preset().unwrap().id, "high");
    })
    .await
    .expect("Summary policy fixture exceeded its total deadline");
}

#[tokio::test]
async fn user_declared_low_and_xhigh_patches_keep_their_exact_wire_values() {
    let (endpoint, server) = wire_server(2);
    let shared = auto_fixture(&endpoint);
    for effort in ["low", "xhigh"] {
        let projection = declared_patch_projection(effort);
        let client = request_client(&shared, &projection, &RouterContextConfig::default()).unwrap();
        assert_eq!(client.model_reasoning_preset().unwrap().id, effort);
        assert!(client.selected_reasoning_preset().is_none());
        client
            .send_message(vec![AIMessage::user("Synthetic history".into())], None)
            .await
            .unwrap();
    }
    let requests = server.join().unwrap();
    assert_eq!(requests[0]["reasoning_effort"], "low");
    assert_eq!(requests[1]["reasoning_effort"], "xhigh");
    assert!(shared.model_reasoning_preset().is_none());
    assert!(shared.selected_reasoning_preset().is_none());
}

#[test]
fn confirmed_catalog_and_model_specific_adapter_efforts_remain_automatic() {
    let catalog = openbitfun_ai_adapters::models_dev::ModelsDevCatalog::parse_str(
        r#"{
        "deepseek": {"models": {"deepseek-v4-flash": {
            "id": "deepseek-v4-flash", "reasoning": true,
            "reasoning_options": {"type": "effort", "values": ["low", "high", "max"]}
        }}}
    }"#,
    )
    .unwrap();
    for (catalog, source) in [
        (Some(&catalog), ReasoningPresetSource::ModelsDev),
        (None, ReasoningPresetSource::AdapterFallback),
    ] {
        let projection = openbitfun_ai_adapters::models_dev::project_reasoning_catalog_with_limit(
            "openai",
            "deepseek-v4-flash",
            "https://api.deepseek.com/v1",
            65_536,
            None,
            catalog,
        );
        let preset = automatic_preset(&projection).unwrap();
        assert_eq!(preset.id, "low");
        assert_eq!(preset.source, source);
        assert!(!is_protocol_generic_reasoning_preset(&preset));
        let mut shared = auto_fixture("http://127.0.0.1:1/v1/chat/completions");
        shared.config.model = "deepseek-v4-flash".into();
        let client = request_client(&shared, &projection, &RouterContextConfig::default()).unwrap();
        assert_eq!(client.model_reasoning_preset().unwrap().id, "low");
        assert!(client.selected_reasoning_preset().is_none());
        assert!(shared.model_reasoning_preset().is_none());
        assert_eq!(client.config.max_tokens, Some(16_384));
    }
}
