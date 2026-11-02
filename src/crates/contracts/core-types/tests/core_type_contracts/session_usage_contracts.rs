use openbitfun_core_types::{
    SessionUsageReport, UsageCoverageLevel, UsageToolCategory, SESSION_USAGE_REPORT_SCHEMA_VERSION,
};

#[test]
fn session_usage_report_is_a_shared_stable_contract() {
    let mut report = SessionUsageReport::partial_unavailable("session-1", 1_778_347_200_000);
    report.report_id = "usage-session-1-1778347200000".to_string();

    let json = serde_json::to_value(&report).expect("serialize usage report");
    let restored: SessionUsageReport =
        serde_json::from_value(json.clone()).expect("deserialize usage report");

    assert_eq!(restored, report);
    assert_eq!(
        json["schemaVersion"],
        serde_json::json!(SESSION_USAGE_REPORT_SCHEMA_VERSION)
    );
    assert_eq!(json["sessionId"], "session-1");
    assert_eq!(report.coverage.level, UsageCoverageLevel::Partial);
}

#[test]
fn usage_tool_category_keeps_the_persisted_wire_values() {
    assert_eq!(
        serde_json::to_value(UsageToolCategory::Git).expect("serialize category"),
        "git"
    );
}

#[test]
fn context_composition_keeps_legacy_reports_readable() {
    let report = SessionUsageReport::partial_unavailable("legacy", 42);
    let legacy = serde_json::to_value(&report).unwrap();
    assert!(legacy.get("context").is_none());
    assert!(legacy.get("systemPromptPreview").is_none());
    assert!(legacy.get("contextPreview").is_none());
    let mut restored: SessionUsageReport = serde_json::from_value(legacy.clone()).unwrap();
    assert!(restored.context.is_none());
    assert!(restored.system_prompt_preview.is_none());
    assert!(restored.context_preview.is_none());
    assert_eq!(serde_json::to_value(&restored).unwrap(), legacy);
    restored.context = Some(openbitfun_core_types::UsageContextBreakdown {
        system_prompt: 100,
        conversation: 900,
        context_window: Some(128_000),
        ..Default::default()
    });
    let encoded = serde_json::to_value(&restored).unwrap();
    assert_eq!(encoded["context"]["systemPrompt"], 100);
    assert_eq!(
        serde_json::from_value::<SessionUsageReport>(encoded).unwrap(),
        restored
    );
}

#[test]
fn system_prompt_preview_round_trips_without_changing_default_report_privacy() {
    let mut report = SessionUsageReport::partial_unavailable("session-1", 42);
    assert!(!report.privacy.prompt_content_included);
    report.system_prompt_preview = Some(openbitfun_core_types::UsageSystemPromptPreview {
        content: "# System\nExact cached instructions\n".into(),
        cached_at: 123,
    });
    report.privacy.prompt_content_included = true;
    let json = serde_json::to_value(&report).unwrap();
    assert_eq!(json["systemPromptPreview"]["cachedAt"], 123);
    assert_eq!(
        serde_json::from_value::<SessionUsageReport>(json).unwrap(),
        report
    );
}

#[test]
fn context_preview_round_trips_with_explicit_category_and_capture_time() {
    let mut report = SessionUsageReport::partial_unavailable("session-1", 42);
    report.context_preview = Some(openbitfun_core_types::UsageContextPreview {
        category: openbitfun_core_types::UsageContextCategory::ToolDefinitions,
        content: "```json\n[]\n```".into(),
        captured_at: 123,
    });
    let encoded = serde_json::to_value(&report).unwrap();
    assert_eq!(encoded["contextPreview"]["category"], "toolDefinitions");
    assert_eq!(encoded["contextPreview"]["capturedAt"], 123);
    assert_eq!(
        serde_json::from_value::<SessionUsageReport>(encoded).unwrap(),
        report
    );
}
