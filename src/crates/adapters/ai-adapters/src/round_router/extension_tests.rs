use super::*;
use axum::{extract::Json, http::StatusCode, routing::post, Router};

fn classifier_response() -> Value {
    let prediction = json!({
        "phase": "editing",
        "phase_detail": "production_change_applied",
        "simple_type": "simple",
    });
    json!({
        "choices": [{"message": {"content": prediction.to_string()}, "logprobs": null}],
        "router": {
            "prediction": prediction,
            "probabilities": {"simple_type": {"simple": 0.6, "non_simple": 0.4}},
            "prefix_cache": {"cache_hit": true},
        },
        "usage": {"prompt_tokens": 1200, "completion_tokens": 0, "total_tokens": 1200,
            "prompt_tokens_details": {"cached_tokens": 1000}},
    })
}

fn extension_client(endpoint: String) -> RouterHttpClient {
    RouterHttpClient::with_transport_and_protocol(
        endpoint,
        "classifier".into(),
        "fixed system".into(),
        None,
        Duration::from_secs(3),
        None,
        Default::default(),
        false,
        RouterProtocol::OpenAiRouterExtension,
    )
    .unwrap()
}

#[tokio::test]
async fn extension_http_transport_preserves_input_and_reads_class_probabilities() {
    let app = Router::new().route(
        "/v1/chat/completions",
        post(|Json(body): Json<Value>| async move {
            let expected = json!({
                "model": "classifier",
                "messages": [
                    {"role": "system", "content": "fixed system"},
                    {"role": "user", "content": "complete original history"},
                ],
                "temperature": 0.0,
                "top_p": 1.0,
                "max_tokens": 128,
                "stream": false,
            });
            assert_eq!(body, expected);
            Json(classifier_response())
        }),
    );
    let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
    let endpoint = format!(
        "http://{}/v1/chat/completions",
        listener.local_addr().unwrap()
    );
    let server = tokio::spawn(async move { axum::serve(listener, app).await.unwrap() });
    let prediction = extension_client(endpoint)
        .predict("complete original history")
        .await
        .unwrap();
    assert!(prediction.generated_simple);
    // The consumer still applies its threshold; the adapter must not turn the label into 1.0.
    assert_eq!(prediction.simple_probability, Some(0.6));
    assert_eq!(prediction.prompt_tokens(), Some(1200));
    assert_eq!(prediction.usage.as_ref().unwrap()["completion_tokens"], 0);
    assert_eq!(
        prediction.usage.as_ref().unwrap()["prompt_tokens_details"]["cached_tokens"],
        1000
    );
    assert!(!prediction.recovered);
    server.abort();
}

#[test]
fn extension_validation_rejects_invalid_or_inconsistent_classification_facts() {
    let response = classifier_response();
    let content = response["choices"][0]["message"]["content"]
        .as_str()
        .unwrap();
    let router = response["router"].clone();
    assert_eq!(
        parse_router_extension(content, Some(&router)).unwrap(),
        (true, 0.6)
    );
    assert!(parse_router_extension(content, None).is_err());
    assert!(parse_router_extension("{\"simple_type\":\"simple\"", Some(&router)).is_err());
    assert!(parse_router_extension(&format!("{content}\nfuture output"), Some(&router)).is_err());
    for probabilities in [
        Value::Null,
        json!({}),
        json!({"simple": 0.6}),
        json!({"simple": "0.6", "non_simple": 0.4}),
        json!({"simple": null, "non_simple": 1}),
        json!({"simple": -0.1, "non_simple": 1.1}),
        json!({"simple": 1.1, "non_simple": -0.1}),
        json!({"simple": 0.4, "non_simple": 0.4}),
        json!({"simple": 0.6, "non_simple": 0.4, "unknown": 0}),
    ] {
        let mut invalid = router.clone();
        invalid["probabilities"]["simple_type"] = probabilities;
        assert!(
            parse_router_extension(content, Some(&invalid)).is_err(),
            "{invalid}"
        );
    }
    for field in ["phase", "phase_detail", "simple_type"] {
        let mut invalid = router.clone();
        invalid["prediction"][field] = json!("different");
        assert!(parse_router_extension(content, Some(&invalid)).is_err());
    }
    let mut rounded = router.clone();
    rounded["probabilities"]["simple_type"] =
        json!({"simple": 0.9797065258, "non_simple": 0.020293491});
    assert!(parse_router_extension(content, Some(&rounded)).is_ok());
}

#[test]
fn extension_overflow_evidence_is_strict_and_does_not_change_legacy_detection() {
    let error = json!({"error": {
        "type": "invalid_request_error", "code": "invalid_request",
        "message": "Prompt has 32769 tokens; max_length=32768; no truncation is performed",
    }});
    let body = serde_json::to_vec(&error).unwrap();
    assert!(is_extension_context_overflow_body(&body));
    assert!(!is_context_overflow_body(&body));
    for (field, value) in [
        ("code", "unsupported_parameter"),
        ("type", "server_error"),
        (
            "message",
            "Prompt has 32768 tokens; max_length=32768; no truncation is performed",
        ),
        (
            "message",
            "Prompt has 32769 tokens; max_length=0; no truncation is performed",
        ),
        (
            "message",
            "quoted Prompt has 32769 tokens; max_length=32768; no truncation is performed",
        ),
    ] {
        let mut invalid = error.clone();
        invalid["error"][field] = json!(value);
        assert!(!is_extension_context_overflow_body(
            &serde_json::to_vec(&invalid).unwrap()
        ));
    }
}

#[tokio::test]
async fn extension_http_errors_preserve_overflow_and_busy_categories() {
    let app = Router::new().route(
        "/v1/chat/completions",
        post(|Json(body): Json<Value>| async move {
            let (status, value) = match body["messages"][1]["content"].as_str().unwrap() {
                "overflow" => (StatusCode::BAD_REQUEST, json!({"error": {
                    "type":"invalid_request_error", "code":"invalid_request",
                    "message":"Prompt has 32769 tokens; max_length=32768; no truncation is performed",
                }})),
                "busy" => (StatusCode::SERVICE_UNAVAILABLE, json!({"error": {"message":"private echoed input"}})),
                _ => (StatusCode::BAD_REQUEST, json!({"error": {"code":"unsupported_parameter"}})),
            };
            (status, Json(value))
        }),
    );
    let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
    let endpoint = format!(
        "http://{}/v1/chat/completions",
        listener.local_addr().unwrap()
    );
    let server = tokio::spawn(async move { axum::serve(listener, app).await.unwrap() });
    let client = extension_client(endpoint);
    assert!(matches!(
        client.predict("overflow").await,
        Err(RouterClientError::ContextOverflow(_))
    ));
    let busy = client.predict("busy").await.unwrap_err();
    assert!(matches!(busy, RouterClientError::Http(_)));
    assert_eq!(busy.to_string(), "Router returned HTTP 503");
    assert!(matches!(
        client.predict("unsupported").await,
        Err(RouterClientError::Http(_))
    ));
    server.abort();
}

#[tokio::test]
async fn extension_loopback_bypasses_proxy_without_changing_remote_or_legacy_policy() {
    let app = Router::new().fallback(|| async { Json(classifier_response()) });
    let direct = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
    let direct_url = format!(
        "http://{}/v1/chat/completions",
        direct.local_addr().unwrap()
    );
    let direct_server = tokio::spawn(async move { axum::serve(direct, app).await.unwrap() });
    let proxy_app = Router::new().fallback(|| async {
        let mut value = classifier_response();
        value["usage"]["prompt_tokens"] = json!(2000);
        Json(value)
    });
    let proxy = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
    let proxy_url = format!("http://{}", proxy.local_addr().unwrap());
    let proxy_server = tokio::spawn(async move { axum::serve(proxy, proxy_app).await.unwrap() });
    let client = |endpoint, protocol| {
        RouterHttpClient::with_transport_and_protocol(
            endpoint,
            "classifier".into(),
            "fixed system".into(),
            None,
            Duration::from_secs(3),
            Some(crate::types::ProxyConfig {
                enabled: true,
                url: proxy_url.clone(),
                ..Default::default()
            }),
            Default::default(),
            false,
            protocol,
        )
        .unwrap()
    };
    assert_eq!(
        client(direct_url.clone(), RouterProtocol::OpenAiRouterExtension)
            .predict("input")
            .await
            .unwrap()
            .prompt_tokens(),
        Some(1200)
    );
    assert_eq!(
        client(
            "http://classifier-proxy-fixture.invalid/v1/chat/completions".into(),
            RouterProtocol::OpenAiRouterExtension
        )
        .predict("input")
        .await
        .unwrap()
        .prompt_tokens(),
        Some(2000)
    );
    assert_eq!(
        client(direct_url, RouterProtocol::OpenAiLogprobs)
            .predict("input")
            .await
            .unwrap()
            .prompt_tokens(),
        Some(2000)
    );
    direct_server.abort();
    proxy_server.abort();
}

#[test]
fn loopback_detection_does_not_infer_a_protocol_from_hosts_or_model_names() {
    for url in [
        "http://127.0.0.1:8767/v1/chat/completions",
        "http://127.1.2.3/route",
        "http://localhost/route",
        "http://[::1]/route",
    ] {
        assert!(is_loopback_endpoint(&reqwest::Url::parse(url).unwrap()));
    }
    for url in [
        "http://router.example/route",
        "http://localhost.example/route",
        "http://192.168.1.2/route",
    ] {
        assert!(!is_loopback_endpoint(&reqwest::Url::parse(url).unwrap()));
    }
}

#[tokio::test]
#[ignore = "Requires a configured live classifier service; opt in with ROUTER_EXTENSION_TEST_URL"]
async fn live_router_extension_profile_returns_real_classifier_usage() {
    let endpoint =
        std::env::var("ROUTER_EXTENSION_TEST_URL").expect("Set ROUTER_EXTENSION_TEST_URL");
    let model =
        std::env::var("ROUTER_EXTENSION_TEST_MODEL").expect("Set ROUTER_EXTENSION_TEST_MODEL");
    let client = RouterHttpClient::with_transport_and_protocol(
        endpoint,
        model,
        std::fs::read_to_string(
            std::env::var("ROUTER_EXTENSION_TEST_SYSTEM_PROMPT")
                .expect("Set ROUTER_EXTENSION_TEST_SYSTEM_PROMPT"),
        )
        .unwrap(),
        None,
        Duration::from_secs(120),
        None,
        Default::default(),
        false,
        RouterProtocol::OpenAiRouterExtension,
    )
    .unwrap();
    let result = client.predict("## Task\nInspect a file and explain its purpose\n\n## Earlier history summary\n(none)\n\n## Recent trajectory\n[]").await.unwrap();
    assert!(result
        .simple_probability
        .is_some_and(|p| (0.0..=1.0).contains(&p)));
    assert!(result.prompt_tokens().is_some());
    assert_eq!(result.usage.unwrap()["completion_tokens"], 0);
}
