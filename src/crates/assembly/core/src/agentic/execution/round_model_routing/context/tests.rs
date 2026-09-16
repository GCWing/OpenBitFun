use super::*;
use crate::agentic::core::{ToolCall, ToolResult};
use std::sync::atomic::{AtomicUsize, Ordering};
use tokio::sync::Notify;

#[test]
fn summary_generation_limit_reserves_reasoning_headroom() {
    // The provider counts reasoning and final text against the same limit.
    // A 2K final summary must not also exhaust the entire generation budget.
    assert!(RouterContextConfig::default().summary_max_tokens >= 8_192);
}

fn summary_client_fixture(endpoint: &str) -> AIClient {
    AIClient::new(
        serde_json::from_value(json!({
            "name": "fast fixture", "model": "glm-5.3-flash", "format": "openai",
            "base_url": endpoint, "request_url": endpoint, "api_key": "synthetic-key",
            "context_window": 400_000, "max_tokens": 65_536,
            "temperature": 0.95, "top_p": 1.0, "inline_think_in_text": false,
            "skip_ssl_verify": false, "custom_request_body_mode": "merge",
            "custom_request_body": {"reasoning_effort": "max", "temperature": 0.95,
                "thinking": {"type": "enabled", "clear_thinking": false}, "top_p": 1.0}
        }))
        .unwrap(),
    )
}

#[test]
fn explicit_summary_preset_cannot_silently_fall_back_to_main_default() {
    let client = summary_client_fixture("http://127.0.0.1:1/v1/chat/completions");
    let mut config = RouterContextConfig {
        summary_reasoning_preset: Some("missing-preset".into()),
        ..Default::default()
    };
    assert!(summary_request_client(&client, &config).is_err());
    config.summary_reasoning_preset = None;
    let summary = summary_request_client(&client, &config).unwrap();
    assert_eq!(summary.config.max_tokens, Some(16_384));
    assert_eq!(client.config.max_tokens, Some(65_536));
    assert!(summary.selected_reasoning_preset().is_none());
    assert!(summary_system_prompt(&config).contains("4096 tokens"));
    config.summary_target_tokens = config.summary_max_tokens + 1;
    assert!(config.validate().is_err());
    config.summary_target_tokens = 1;
    config.summary_max_tokens = 0;
    assert!(config.validate().is_err());
    if usize::BITS > 32 {
        config.summary_max_tokens = u32::MAX as usize + 1;
        assert!(config.validate().is_err());
    }
}

#[tokio::test]
async fn summary_request_isolates_generation_limit_and_reasoning_on_the_wire() {
    use std::io::{BufRead, BufReader, Read, Write};
    let listener = std::net::TcpListener::bind("127.0.0.1:0").unwrap();
    let endpoint = format!(
        "http://{}/v1/chat/completions",
        listener.local_addr().unwrap()
    );
    let server = std::thread::spawn(move || {
        let mut bodies = Vec::new();
        for _ in 0..3 {
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
            let mut body = vec![0; length];
            reader.read_exact(&mut body).unwrap();
            bodies.push(serde_json::from_slice::<Value>(&body).unwrap());
            let data = json!({"id":"summary-fixture", "object":"chat.completion.chunk",
                "created":0, "model":"glm-5.3-flash", "choices":[{"index":0,
                "delta":{"content":"Confirmed parser regression; verification pending."},
                "finish_reason":"stop"}], "usage":{"prompt_tokens":10,"completion_tokens":8,"total_tokens":18}});
            let response = format!("data: {data}\n\ndata: [DONE]\n\n");
            write!(stream, "HTTP/1.1 200 OK\r\nContent-Type: text/event-stream\r\nContent-Length: {}\r\nConnection: close\r\n\r\n{}", response.len(), response).unwrap();
        }
        bodies
    });
    let shared = summary_client_fixture(&endpoint);
    let before = serde_json::to_value(&shared.config).unwrap();
    let projection = openbitfun_ai_adapters::models_dev::project_reasoning_catalog_with_limit(
        "openai",
        "glm-5.3-flash",
        "https://open.bigmodel.cn/api/paas/v4",
        65_536,
        None,
        None,
    );
    let low = projection
        .presets
        .iter()
        .find(|preset| preset.id == "low")
        .unwrap();
    let config = RouterContextConfig {
        summary_reasoning_preset: Some("low".into()),
        ..Default::default()
    };
    let summary = summary_request_client(&shared.with_reasoning_preset(low), &config).unwrap();
    let messages = || {
        vec![
            AIMessage::system(summary_system_prompt(&config)),
            AIMessage::user("Synthetic parser fixture".into()),
        ]
    };
    shared.send_message(messages(), None).await.unwrap();
    let response = summary.send_message(messages(), None).await.unwrap();
    let result = SummaryResult::from_response(response, "fast-fixture".into(), &summary);
    shared.send_message(messages(), None).await.unwrap();
    assert!(result.complete, "{:?}", result.diagnostics);
    assert_eq!(result.diagnostics.reasoning_preset.as_deref(), Some("low"));
    assert_eq!(result.diagnostics.finish_reason.as_deref(), Some("stop"));
    assert_eq!(result.usage.unwrap()["candidatesTokenCount"], 8);
    assert_eq!(serde_json::to_value(&shared.config).unwrap(), before);
    assert!(shared.selected_reasoning_preset().is_none());
    let bodies = server.join().unwrap();
    assert_eq!(bodies[0], bodies[2]);
    assert_eq!(bodies[0]["max_tokens"], 65_536);
    assert_eq!(bodies[0]["reasoning_effort"], "max");
    assert_eq!(bodies[0]["thinking"]["clear_thinking"], false);
    assert_eq!(bodies[1]["max_tokens"], 16_384);
    assert_eq!(bodies[1]["reasoning_effort"], "low");
    assert!(bodies[1].get("thinking").is_none());
    assert_eq!(bodies[1]["temperature"], 0.95);
    assert_eq!(bodies[1]["top_p"], 1.0);
    assert!(bodies[1].get("tools").is_none());
}

#[test]
fn summary_response_distinguishes_truncation_reasoning_only_and_success() {
    let client = summary_client_fixture("http://127.0.0.1:1/v1/chat/completions");
    for (text, finish, expected) in [
        ("partial", "length", Some("output_limit")),
        ("partial", "MAX_TOKENS", Some("output_limit")),
        ("", "stop", Some("empty_text")),
        ("   ", "stop", Some("empty_text")),
        ("Complete factual summary", "stop", None),
    ] {
        let response = serde_json::from_value(json!({"text":text,
            "reasoning_content":"PRIVATE_REASONING", "finish_reason":finish}))
        .unwrap();
        let result = SummaryResult::from_response(response, "fast".into(), &client);
        assert_eq!(result.complete, expected.is_none());
        assert_eq!(result.diagnostics.incomplete_reason, expected);
        assert_eq!(result.diagnostics.text_chars, text.chars().count());
        assert_eq!(result.diagnostics.reasoning_chars, 17);
        let diagnostics = serde_json::to_string(&result.diagnostics).unwrap();
        assert!(!diagnostics.contains("PRIVATE_REASONING"));
    }
}

struct FakeSummary {
    calls: AtomicUsize,
    release: Notify,
    fail: bool,
}

#[async_trait::async_trait]
impl SummaryProvider for FakeSummary {
    async fn summarize(
        &self,
        _: String,
        _: &RouterContextConfig,
    ) -> OpenBitFunResult<SummaryResult> {
        self.calls.fetch_add(1, Ordering::SeqCst);
        if self.fail {
            return Err(OpenBitFunError::AIClient("synthetic failure".into()));
        }
        self.release.notified().await;
        Ok(SummaryResult {
            text: "Found the parser regression; validation remains pending".into(),
            complete: true,
            model_id: "fast-fixture".into(),
            model_name: "fast-fixture".into(),
            usage: Some(json!({"promptTokenCount": 10, "candidatesTokenCount": 5})),
            diagnostics: SummaryDiagnostics::default(),
        })
    }
}

fn fixture(fail: bool) -> (RoundRouterContext, Arc<FakeSummary>) {
    let provider = Arc::new(FakeSummary {
        calls: AtomicUsize::new(0),
        release: Notify::new(),
        fail,
    });
    let mut factory = RouterContextFactory::new_with_counter(
        RouterContextConfig {
            summary_trigger_tokens: 1,
            ..Default::default()
        },
        3,
        "fixture system",
        None,
        Arc::new(Utf8ByteBudget),
    )
    .unwrap();
    factory.summary_provider = provider.clone();
    factory.summary_slots = Arc::new(Semaphore::new(1));
    (factory.create("session", "turn", "fix parser"), provider)
}

fn rounds(count: usize) -> Vec<Message> {
    (0..count)
        .map(|index| Message::assistant(format!("step-{index}")))
        .collect()
}

async fn settle(context: &mut RoundRouterContext) {
    tokio::time::timeout(Duration::from_secs(2), async {
        while context
            .pending_summary
            .as_ref()
            .is_some_and(|handle| !handle.is_finished())
        {
            tokio::task::yield_now().await;
        }
    })
    .await
    .unwrap();
    context.poll_summary().await;
}

#[tokio::test]
async fn slow_summary_never_blocks_routing_and_is_applied_to_only_its_prefix() {
    let (mut context, provider) = fixture(false);
    let mut messages = rounds(8);
    let snapshot = serde_json::to_value(&messages).unwrap();
    let first = context.prepare(&messages).await;
    assert!(first.user_prompt.contains("step-7"));
    assert_eq!(first.entry_tokens.len(), 8);
    assert_eq!(
        first
            .entry_tokens
            .iter()
            .filter(|entry| entry.section == "pending")
            .count(),
        5
    );
    assert!(first.entry_tokens.iter().all(|entry| entry.token_count > 0));
    assert_eq!(first.compression_records.len(), 1);
    assert_eq!(first.compression_records[0].status, "in_flight");
    assert_eq!(serde_json::to_value(&messages).unwrap(), snapshot);
    tokio::task::yield_now().await;
    assert_eq!(provider.calls.load(Ordering::SeqCst), 1);
    assert!(!context.pending_summary.as_ref().unwrap().is_finished());
    messages.push(Message::assistant("latest-new-evidence".into()));
    let pending = tokio::time::timeout(Duration::from_millis(100), context.prepare(&messages))
        .await
        .unwrap();
    assert!(pending.user_prompt.contains("latest-new-evidence"));
    assert_eq!(pending.summarized_through, 0);
    assert_eq!(provider.calls.load(Ordering::SeqCst), 1);
    provider.release.notify_one();
    tokio::time::timeout(Duration::from_secs(2), async {
        while context
            .pending_summary
            .as_ref()
            .is_some_and(|handle| !handle.is_finished())
        {
            tokio::task::yield_now().await;
        }
    })
    .await
    .unwrap();
    context.factory.config.summary_enabled = false;
    let prepared = context.prepare(&messages).await;
    assert!(prepared.user_prompt.contains("parser regression"));
    assert!(prepared.user_prompt.contains("latest-new-evidence"));
    assert_eq!(prepared.compression_records.len(), 1);
    assert_eq!(prepared.compression_records[0].status, "applied");
    assert!(prepared.compression_records[0].latency_ms.is_some());
    assert!(prepared.compression_records[0].usage.is_some());
    assert_eq!(prepared.observed_through, 9);
    assert_eq!(prepared.summarized_through, 5);
}

#[tokio::test]
async fn failed_summary_keeps_evidence_and_retries_on_the_next_round() {
    let (mut context, provider) = fixture(true);
    let mut messages = rounds(20);
    context.prepare(&messages).await;
    settle(&mut context).await;
    for _ in 0..5 {
        context.prepare(&messages).await;
    }
    assert_eq!(provider.calls.load(Ordering::SeqCst), 1);
    assert_eq!(context.state.summarized_through, 0);
    assert!(context.render().user_prompt.contains("step-19"));
    messages.extend(rounds(1));
    context.prepare(&messages).await;
    settle(&mut context).await;
    assert_eq!(provider.calls.load(Ordering::SeqCst), 2);
}

#[tokio::test]
async fn summary_timeout_and_generation_drop_release_concurrency_slot() {
    let (mut context, provider) = fixture(false);
    context.factory.config.summary_timeout = Duration::from_millis(5);
    context.prepare(&rounds(8)).await;
    settle(&mut context).await;
    assert_eq!(context.state.summarized_through, 0);
    assert_eq!(context.factory.summary_slots.available_permits(), 1);
    context.factory.config.summary_timeout = Duration::from_secs(30);
    context.prepare(&rounds(4)).await;
    tokio::task::yield_now().await;
    assert_eq!(provider.calls.load(Ordering::SeqCst), 2);
    let slots = context.factory.summary_slots.clone();
    drop(context);
    tokio::time::timeout(Duration::from_secs(1), async {
        while slots.available_permits() != 1 {
            tokio::task::yield_now().await;
        }
    })
    .await
    .unwrap();
}

#[tokio::test]
async fn compaction_is_read_only_and_user_steering_errors_and_results_survive() {
    let (mut context, _) = fixture(true);
    context.factory.config.summary_enabled = false;
    let mut messages = vec![
        Message::system("PRIVATE_MAIN_SYSTEM".into()),
        Message::user("old user task".into()),
        Message::user("fix parser".into()),
        Message::assistant_with_tools(
            "inspect failure".into(),
            vec![ToolCall {
                tool_id: "t1".into(),
                tool_name: "ExecCommand".into(),
                arguments: json!({"cmd": "test"}),
                ..Default::default()
            }],
        ),
        Message::tool_result(ToolResult {
            tool_id: "t1".into(),
            tool_name: "ExecCommand".into(),
            result: json!({"raw_only": "PRIVATE_RAW_RESULT"}),
            result_for_assistant: Some("AssertionError: expected 2, got 1".into()),
            is_error: true,
            effective_tool_name: None,
            duration_ms: None,
            image_attachments: None,
        }),
        Message::internal_reminder(InternalReminderKind::UserSteering, "inspect before editing"),
        Message::internal_reminder(
            InternalReminderKind::BackgroundResult,
            "background test finished: failed",
        ),
    ];
    let before = serde_json::to_value(&messages).unwrap();
    let prepared = context.prepare(&messages).await;
    assert_eq!(serde_json::to_value(&messages).unwrap(), before);
    for expected in [
        "AssertionError",
        "inspect before editing",
        "background test finished",
        "\"is_error\":true",
        "t1",
    ] {
        assert!(
            prepared.user_prompt.contains(expected),
            "missing {expected}"
        );
    }
    assert!(!prepared.user_prompt.contains("PRIVATE_RAW_RESULT"));
    assert!(!prepared.user_prompt.contains("PRIVATE_MAIN_SYSTEM"));
    assert!(!prepared
        .user_prompt
        .split("## Earlier history summary")
        .next()
        .unwrap()
        .contains("old user task"));
    let next_sequence = context.state.next_sequence;
    let main_summary = Message::user("PRIVATE_MAIN_COMPRESSION_SUMMARY".into())
        .with_semantic_kind(MessageSemanticKind::CompressionSummary);
    let boundary = Message::user("PRIVATE_BOUNDARY".into())
        .with_semantic_kind(MessageSemanticKind::CompressionBoundaryMarker);
    // Simulate main compaction replacing the entire request history.
    messages = vec![boundary, main_summary, messages.last().unwrap().clone()];
    let compacted_before = serde_json::to_value(&messages).unwrap();
    let after = context.prepare(&messages).await;
    assert_eq!(serde_json::to_value(&messages).unwrap(), compacted_before);
    assert_eq!(context.state.next_sequence, next_sequence);
    assert!(after.user_prompt.contains("AssertionError"));
    assert!(!after
        .user_prompt
        .contains("PRIVATE_MAIN_COMPRESSION_SUMMARY"));
    assert!(!after.user_prompt.contains("PRIVATE_BOUNDARY"));
}

#[tokio::test]
async fn task_feedback_defaults_to_retained_and_process_failure_is_not_tool_failure() {
    let (mut context, _) = fixture(true);
    context.factory.config.summary_enabled = false;
    let kinds = [
        InternalReminderKind::GoalContinuation,
        InternalReminderKind::SessionMessageRequest,
        InternalReminderKind::RemoteFileDelivery,
        InternalReminderKind::Generic,
        InternalReminderKind::BackgroundResult,
        InternalReminderKind::StopHookBlock,
    ];
    let mut messages = vec![
        Message::assistant("Run validation".into()),
        Message::tool_result(ToolResult {
            tool_id: "exec".into(),
            tool_name: "ExecCommand".into(),
            result: json!({"exit_code": 1, "raw_only": "PRIVATE_RAW_RESULT"}),
            result_for_assistant: Some("AssertionError: validation failed".into()),
            is_error: false,
            effective_tool_name: None,
            duration_ms: None,
            image_attachments: None,
        }),
    ];
    for (index, kind) in kinds.into_iter().enumerate() {
        messages.push(Message::internal_reminder(
            kind,
            format!("FRESH_FEEDBACK_{index}"),
        ));
    }
    messages.push(Message::internal_reminder(
        InternalReminderKind::SkillListingDiff,
        "CATALOG_SCAFFOLD",
    ));
    messages.push(Message::internal_reminder(
        InternalReminderKind::UserSteering,
        "LATEST_USER_CHANGE",
    ));
    let before = serde_json::to_value(&messages).unwrap();
    let prepared = context.prepare(&messages).await;
    assert_eq!(serde_json::to_value(&messages).unwrap(), before);
    assert!(context.state.entries[0].is_error);
    assert_eq!(
        context.state.entries[0].content["tool_results"][0]["status"]["exit_code"],
        1
    );
    for index in 0..6 {
        assert!(prepared
            .user_prompt
            .contains(&format!("FRESH_FEEDBACK_{index}")));
    }
    assert!(prepared.user_prompt.contains("LATEST_USER_CHANGE"));
    assert!(!prepared.user_prompt.contains("PRIVATE_RAW_RESULT"));
    assert!(!prepared.user_prompt.contains("CATALOG_SCAFFOLD"));
    assert_eq!(context.state.latest_user_updates.len(), 1);
}

#[tokio::test]
async fn sidecar_recovery_deduplicates_and_preserves_incompatible_files() {
    let dir = tempfile::tempdir().unwrap();
    let (mut context, _) = fixture(true);
    context.factory.config.summary_enabled = false;
    context.restore(Some(dir.path().to_path_buf())).await;
    let messages = rounds(6);
    context.prepare(&messages).await;
    context.finish(&messages).await;
    let path = context.checkpoint.clone().unwrap();
    let (mut recovered, _) = fixture(true);
    recovered.factory.config.summary_enabled = false;
    recovered.restore(Some(dir.path().to_path_buf())).await;
    recovered.prepare(&messages).await;
    recovered.finish(&messages).await;
    assert_eq!(recovered.state.next_sequence, context.state.next_sequence);
    assert_eq!(recovered.render().user_prompt, context.render().user_prompt);
    // Future state and invalid JSON are kept intact rather than overwritten/reset.
    for bytes in [
        br#"{"version":999,"session_id":"session","dialog_turn_id":"turn"}"#.as_slice(),
        b"{broken",
    ] {
        tokio::fs::write(&path, bytes).await.unwrap();
        let (mut incompatible, _) = fixture(true);
        incompatible.restore(Some(dir.path().to_path_buf())).await;
        incompatible.finish(&messages).await;
        assert!(incompatible.checkpoint.is_none());
        assert_eq!(tokio::fs::read(&path).await.unwrap(), bytes);
    }
}

#[tokio::test]
async fn exhausted_summary_capacity_does_not_queue_or_block_and_disabled_is_noop() {
    let (mut context, provider) = fixture(false);
    let permit = context
        .factory
        .summary_slots
        .clone()
        .acquire_owned()
        .await
        .unwrap();
    let messages = rounds(8);
    let prepared = context.prepare(&messages).await;
    assert!(prepared.user_prompt.contains("step-7"));
    assert!(context.pending_summary.is_none());
    drop(permit);
    context.factory.config.summary_enabled = false;
    context.prepare(&messages).await;
    assert_eq!(provider.calls.load(Ordering::SeqCst), 0);
}

#[tokio::test]
async fn checkpoint_migrates_to_snapshots_without_changing_legacy_or_main_context() {
    let dir = tempfile::tempdir().unwrap();
    let legacy = dir.path().join("request-traces");
    let snapshots = dir.path().join("snapshots");
    tokio::fs::create_dir_all(&snapshots).await.unwrap();
    let main = snapshots.join("context-0001.json");
    tokio::fs::write(&main, b"main context must stay unchanged")
        .await
        .unwrap();
    let (mut old, _) = fixture(true);
    old.factory.config.summary_enabled = false;
    old.restore(Some(legacy.clone())).await;
    old.finish(&rounds(3)).await;
    let old_path = old.checkpoint.clone().unwrap();
    let before = tokio::fs::read(&old_path).await.unwrap();

    let (mut migrated, _) = fixture(true);
    migrated.factory.config.summary_enabled = false;
    migrated
        .restore_with_legacy(Some(snapshots.clone()), Some(legacy.clone()))
        .await;
    assert_eq!(migrated.state.next_sequence, old.state.next_sequence);
    migrated.finish(&rounds(1)).await;
    let new_path = migrated.checkpoint.clone().unwrap();
    assert_eq!(new_path.parent(), Some(snapshots.as_path()));
    assert_eq!(tokio::fs::read(&old_path).await.unwrap(), before);
    assert_eq!(
        tokio::fs::read(&main).await.unwrap(),
        b"main context must stay unchanged"
    );

    let (mut restored, _) = fixture(true);
    restored
        .restore_with_legacy(Some(snapshots.clone()), Some(legacy.clone()))
        .await;
    assert_eq!(restored.state.next_sequence, migrated.state.next_sequence);
    restored.finish(&[]).await;
    // A bad new file must not silently fall back to an older state or be overwritten.
    for invalid in [
        b"{broken".as_slice(),
        br#"{"version":999}"#,
        br#"{"session_id":"other","dialog_turn_id":"turn"}"#,
    ] {
        tokio::fs::write(&new_path, invalid).await.unwrap();
        let (mut rejected, _) = fixture(true);
        rejected
            .restore_with_legacy(Some(snapshots.clone()), Some(legacy.clone()))
            .await;
        assert!(rejected.checkpoint.is_none());
        rejected.finish(&[]).await;
        assert_eq!(tokio::fs::read(&new_path).await.unwrap(), invalid);
        assert_eq!(tokio::fs::read(&old_path).await.unwrap(), before);
    }
}

#[tokio::test]
async fn slow_checkpoint_never_blocks_prepare_and_only_latest_snapshot_is_flushed() {
    let dir = tempfile::tempdir().unwrap();
    let (mut context, _) = fixture(true);
    context.factory.config.summary_enabled = false;
    context.restore(Some(dir.path().to_path_buf())).await;
    let path = context.checkpoint.clone().unwrap();
    let held_lock = JsonFileStore
        .acquire_cross_process_lock(&path)
        .await
        .unwrap();
    let mut messages = rounds(3);
    tokio::time::timeout(Duration::from_millis(100), context.prepare(&messages))
        .await
        .unwrap();
    messages.push(Message::assistant("NEWER_EVIDENCE".into()));
    let prepared = tokio::time::timeout(Duration::from_millis(100), context.prepare(&messages))
        .await
        .unwrap();
    assert!(prepared.user_prompt.contains("NEWER_EVIDENCE"));
    drop(held_lock);
    context.finish(&messages).await;
    let persisted: RouterContextState = JsonFileStore.read_optional(&path).await.unwrap().unwrap();
    assert_eq!(persisted.next_sequence, context.state.next_sequence);
    assert!(persisted
        .prepare(3, 4096, &Utf8ByteBudget)
        .user_prompt
        .contains("NEWER_EVIDENCE"));
}

#[tokio::test]
async fn late_checkpoint_cannot_overwrite_newer_generation_or_future_format() {
    let dir = tempfile::tempdir().unwrap();
    let path = dir.path().join("router-context.json");
    let (mut context, _) = fixture(true);
    context.observe(&rounds(3));
    let older = context.state.clone();
    context.observe(&rounds(2));
    write_checkpoint(&path, &context.state).await.unwrap();
    let before = tokio::fs::read(&path).await.unwrap();
    write_checkpoint(&path, &older).await.unwrap();
    assert_eq!(tokio::fs::read(&path).await.unwrap(), before);
    let future = br#"{"version":999,"session_id":"session","dialog_turn_id":"turn","future_field":"preserve me"}"#;
    tokio::fs::write(&path, future).await.unwrap();
    assert!(write_checkpoint(&path, &context.state).await.is_err());
    assert_eq!(tokio::fs::read(&path).await.unwrap(), future);
}

#[test]
fn budget_validation_reserves_system_template_and_output() {
    let config = RouterContextConfig {
        context_window: 512,
        ..Default::default()
    };
    assert!(RouterContextFactory::new_with_counter(
        config,
        3,
        "system",
        None,
        Arc::new(Utf8ByteBudget),
    )
    .is_err());
}

#[test]
fn render_is_bounded_by_router_tokens_not_an_unrelated_character_cap() {
    struct SingleToken;
    impl RouterTokenCounter for SingleToken {
        fn count(&self, _: &str) -> usize {
            1
        }
        fn name(&self) -> &'static str {
            "synthetic_single_token"
        }
    }
    let (mut context, _) = fixture(true);
    context.factory.config.max_input_tokens = 4096;
    context.factory.counter = Arc::new(SingleToken);
    context.state.task = "huge-task".repeat(20_000);
    context.observe(&[Message::assistant("huge-output".repeat(20_000))]);
    let prepared = context.render();
    assert!(prepared.user_prompt.chars().count() > 4096);
    assert_eq!(prepared.input_tokens, 1);
    assert_eq!(prepared.counter, "synthetic_single_token");
}

#[test]
fn router_summary_never_uses_the_general_fast_to_primary_fallback() {
    use crate::service::config::types::AIModelConfig;
    let mut config = AIConfig {
        models: vec![
            AIModelConfig {
                id: "main-id".into(),
                enabled: true,
                ..Default::default()
            },
            AIModelConfig {
                id: "fast-id".into(),
                enabled: true,
                ..Default::default()
            },
        ],
        ..Default::default()
    };
    config.default_models.primary = Some("main-id".into());
    // Preserve the existing primary Agent selector behavior, but do not reuse it here.
    assert_eq!(
        config.resolve_model_selection("fast").as_deref(),
        Some("main-id")
    );
    assert!(configured_summary_model(&config).is_err());
    config.default_models.fast = Some("deleted-id".into());
    assert!(configured_summary_model(&config).is_err());
    config.default_models.fast = Some("fast-id".into());
    assert_eq!(configured_summary_model(&config).unwrap(), "fast-id");
    config.models[1].enabled = false;
    assert!(configured_summary_model(&config).is_err());
    assert_eq!(
        config.resolve_model_selection("fast").as_deref(),
        Some("main-id")
    );
}

#[tokio::test]
async fn incomplete_summary_keeps_old_state_but_records_reported_usage() {
    struct Incomplete;
    #[async_trait::async_trait]
    impl SummaryProvider for Incomplete {
        async fn summarize(
            &self,
            _: String,
            _: &RouterContextConfig,
        ) -> OpenBitFunResult<SummaryResult> {
            Ok(SummaryResult {
                text: String::new(),
                complete: false,
                model_id: "fast-fixture".into(),
                model_name: "fast-fixture".into(),
                usage: Some(json!({"promptTokenCount": 12, "candidatesTokenCount": 4096})),
                diagnostics: SummaryDiagnostics {
                    finish_reason: Some("length".into()),
                    reasoning_chars: 12_000,
                    incomplete_reason: Some("output_limit"),
                    ..Default::default()
                },
            })
        }
    }
    let (mut context, _) = fixture(true);
    let dir = tempfile::tempdir().unwrap();
    let trace = dir.path().join("router-trace.jsonl");
    context.factory.trace_path = Some(trace.clone());
    context.factory.summary_provider = Arc::new(Incomplete);
    context.prepare(&rounds(8)).await;
    settle(&mut context).await;
    assert_eq!(context.state.summarized_through, 0);
    assert_eq!(context.state.entries.len(), 8);
    let content = tokio::fs::read_to_string(trace).await.unwrap();
    let events: Vec<Value> = content
        .lines()
        .map(|line| serde_json::from_str(line).unwrap())
        .collect();
    assert_eq!(events.len(), 2);
    assert_eq!(events[0]["event"], "router_context_summary_started");
    let event = &events[1];
    assert_eq!(event["request_id"], events[0]["request_id"]);
    assert_eq!(event["event"], "router_context_summary");
    assert_eq!(event["usage"]["candidatesTokenCount"], 4096);
    assert!(event["error"].is_string());
    assert_eq!(event["response"]["finish_reason"], "length");
    assert_eq!(event["response"]["text_chars"], 0);
    assert_eq!(event["response"]["reasoning_chars"], 12_000);
    assert_eq!(event["response"]["incomplete_reason"], "output_limit");
    assert_eq!(event["max_output_tokens"], 16_384);
    assert_eq!(events[0]["summary_target_tokens"], 4_096);
}
