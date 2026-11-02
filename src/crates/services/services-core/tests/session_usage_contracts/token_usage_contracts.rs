use chrono::Utc;
use openbitfun_services_core::token_usage::{
    ModelTokenStats, SessionTokenStats, TimeRange, TokenUsageQuery, TokenUsageRecord,
};

#[test]
fn token_usage_record_preserves_model_identity_and_cached_availability_default() {
    let record: TokenUsageRecord = serde_json::from_value(serde_json::json!({
        "model_config_id": "model-config-a",
        "effective_model_name": "model-a",
        "session_id": "session-1",
        "turn_id": "turn-1",
        "timestamp": Utc::now(),
        "input_tokens": 10,
        "output_tokens": 5,
        "cached_tokens": 0,
        "total_tokens": 15
    }))
    .expect("token usage record should deserialize");

    assert_eq!(record.model_config_id, "model-config-a");
    assert_eq!(record.effective_model_name, "model-a");
    assert!(!record.cached_tokens_available);
}

#[test]
fn context_composition_is_optional_and_survives_opaque_usage_details() {
    use openbitfun_services_core::token_usage::types::{
        model_request_context, with_model_request_context, ModelRequestUsageContext,
    };
    let legacy = serde_json::json!({
        "version": 1, "roundId": "round-1", "attemptId": "attempt-1", "attemptIndex": 1,
        "startedAt": "2026-10-29T00:00:00Z", "authentication": "api_key", "requestedModel": "model",
        "outcome": "completed", "usageKnown": true
    });
    let mut restored: ModelRequestUsageContext = serde_json::from_value(legacy.clone()).unwrap();
    assert!(restored.context_composition.is_none());
    assert_eq!(serde_json::to_value(&restored).unwrap(), legacy);
    restored.context_composition = Some(openbitfun_core_types::UsageContextBreakdown {
        rules: 100,
        conversation: 200,
        ..Default::default()
    });
    let opaque =
        with_model_request_context(Some(serde_json::json!({"providerField": 42})), &restored)
            .unwrap();
    let reloaded: serde_json::Value =
        serde_json::from_str(&serde_json::to_string(&opaque).unwrap()).unwrap();
    assert_eq!(reloaded["providerField"], 42);
    assert_eq!(
        model_request_context(Some(&reloaded)).unwrap(),
        Some(restored)
    );
}

#[test]
fn token_usage_query_preserves_include_subagent_default() {
    let query = TokenUsageQuery {
        model_id: None,
        session_id: None,
        time_range: TimeRange::All,
        time_zone: None,
        limit: None,
        offset: None,
        include_subagent: false,
    };

    let restored: TokenUsageQuery =
        serde_json::from_value(serde_json::to_value(query).expect("query should serialize"))
            .expect("query should deserialize");

    assert!(!restored.include_subagent);
    assert!(restored.time_zone.is_none());
}

#[test]
fn model_cache_hit_ratio_requires_reported_cache_telemetry() {
    let no_telemetry = ModelTokenStats {
        model_id: "model-a".to_string(),
        total_input: 100,
        total_cached: 0,
        ..Default::default()
    };
    assert_eq!(no_telemetry.cache_hit_ratio(), None);

    let reported = ModelTokenStats {
        model_id: "model-a".to_string(),
        total_input: 300,
        total_cached: 50,
        cache_reported_input_tokens: 100,
        ..Default::default()
    };
    assert_eq!(reported.cache_hit_ratio(), Some(0.5));
}

#[test]
fn session_cache_hit_ratio_uses_reported_input_denominator() {
    let stats = SessionTokenStats {
        session_id: "session-1".to_string(),
        model_id: "model-a".to_string(),
        total_input: 300,
        total_output: 20,
        total_cached: 50,
        total_cache_write: 0,
        cache_reported_input_tokens: 100,
        total_tokens: 320,
        request_count: 2,
        created_at: Utc::now(),
        last_updated: Utc::now(),
    };

    assert_eq!(stats.cache_hit_ratio(), Some(0.5));
}
