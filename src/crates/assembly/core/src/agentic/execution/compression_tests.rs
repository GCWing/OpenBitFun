use super::*;
use crate::agentic::events::EventQueueConfig;
use crate::agentic::execution::round_executor::tests::{
    retry_test_success, test_round_executor, RetryTestServer,
};
use crate::agentic::persistence::PersistenceManager;
use crate::agentic::session::{SessionContextStore, SessionManagerConfig};

fn engine() -> (tempfile::TempDir, ExecutionEngine) {
    let temp = tempfile::Builder::new()
        .prefix("compression-")
        .tempdir()
        .unwrap();
    let manager = SessionManager::new(
        Arc::new(SessionContextStore::new()),
        Arc::new(
            PersistenceManager::new(Arc::new(
                crate::infrastructure::PathManager::with_user_root_for_tests(temp.path().into()),
            ))
            .unwrap(),
        ),
        SessionManagerConfig {
            enable_persistence: false,
            ..Default::default()
        },
    );
    (
        temp,
        ExecutionEngine::new(
            Arc::new(test_round_executor()),
            Arc::new(EventQueue::new(EventQueueConfig::default())),
            Arc::new(manager),
            Arc::new(ContextCompressor::new()),
            ExecutionEngineConfig::default(),
        ),
    )
}

fn messages() -> Vec<Message> {
    let mut messages = vec![Message::system("system".into())];
    for index in 0..8 {
        messages.push(Message::user(format!(
            "Request {index}: {}",
            "old context ".repeat(4_000)
        )));
        messages.push(Message::assistant(format!(
            "Answer {index}: {}",
            "earlier work ".repeat(4_000)
        )));
    }
    messages
}

fn overflow() -> (u16, String) {
    (
        400,
        serde_json::json!({"error": {
            "code": "context_length_exceeded", "message": "context length exceeded"
        }})
        .to_string(),
    )
}

fn prefetch_job(
    engine: &ExecutionEngine,
    server: &RetryTestServer,
    messages: &[Message],
    recent: usize,
) -> CompressionJob {
    CompressionJob::new(
        engine.context_compressor.clone(),
        "session",
        128_000,
        recent,
        CompressionModelSummaryInput {
            ai_client: server.client(),
            model_request_context: &ModelRequestContext::default(),
            runtime_messages: messages,
            dialog_turn_id: "turn",
            workspace: None,
            workspace_services: None,
            tool_definitions: &None,
            prepended_prompt_reminders: &PrependedPromptReminders::default(),
            primary_supports_image_understanding: false,
            trace_config: None,
        },
    )
}

async fn prefetch_session(
    engine: &ExecutionEngine,
    path: &std::path::Path,
    messages: &[Message],
) -> String {
    let session = engine
        .session_manager
        .create_session(
            "prefetch test".into(),
            "Standard".into(),
            crate::agentic::core::SessionConfig {
                workspace_path: Some(path.to_string_lossy().into_owned()),
                ..Default::default()
            },
        )
        .await
        .unwrap();
    engine
        .session_manager
        .replace_context_messages(&session.session_id, messages.to_vec())
        .await;
    session.session_id
}

async fn apply_prefetch(
    engine: &ExecutionEngine,
    session: &str,
    server: &RetryTestServer,
    messages: &[Message],
    prefetch: Option<PrefetchedCompression>,
) -> OpenBitFunResult<Option<(usize, Vec<Message>)>> {
    let pressure = ExecutionEngine::estimate_auto_compression_pressure(
        messages,
        None,
        128_000,
        ExecutionEngine::compression_trigger_budget(128_000, None),
        0,
    );
    engine
        .compress_messages(
            session,
            "turn",
            "auto",
            messages.to_vec(),
            pressure,
            128_000,
            server.client(),
            &ModelRequestContext::default(),
            &None,
            messages[0].clone(),
            &PrependedPromptReminders::default(),
            false,
            10_000,
            None,
            None,
            prefetch,
        )
        .await
}

#[tokio::test]
async fn compression_prefetch_starts_at_zero_and_replans_with_fresh_tail() {
    let (_temp, engine) = engine();
    let server = RetryTestServer::new(vec![retry_test_success()]);
    let messages = messages();
    let zero = prefetch_job(&engine, &server, &messages, 0)
        .run()
        .await
        .unwrap();
    assert_eq!(zero.plan.recent_target_tokens, 0);
    assert!(zero.plan.recent_tail_messages.is_empty());
    assert_eq!(zero.plan.summary_messages.len(), messages.len() - 1);
    let server = RetryTestServer::new(vec![overflow(), retry_test_success()]);
    let replanned = prefetch_job(&engine, &server, &messages, 0)
        .run()
        .await
        .unwrap();
    assert!(replanned.plan.recent_target_tokens >= 10_000);
    assert!(replanned.plan.cutoff_message_index < zero.plan.cutoff_message_index);
    let new = Message::assistant("New evidence during prefetch".into());
    let mut latest = messages.clone();
    latest.push(new.clone());
    let plan = engine
        .context_compressor
        .rebase_plan(replanned.plan.clone(), &latest, "turn")
        .unwrap()
        .unwrap();
    assert_eq!(
        plan.recent_tail_messages.len(),
        replanned.plan.recent_tail_messages.len() + 1
    );
    assert_eq!(plan.recent_tail_messages.last().unwrap().id, new.id);
}

#[tokio::test]
async fn compression_prefetch_ready_is_silent_and_reused_with_new_tail() {
    let (temp, engine) = engine();
    let server = RetryTestServer::new(vec![retry_test_success()]);
    let mut messages = messages();
    let session = prefetch_session(&engine, temp.path(), &messages).await;
    engine.event_queue.dequeue_batch(100).await;
    let job = prefetch_job(&engine, &server, &messages, 0);
    let (published, barrier) = tokio::sync::oneshot::channel();
    let work = job.spawn_prefetch_with(&CancellationToken::new(), |job| async move {
        let result = job.run().await;
        let _ = published.send(());
        result
    });
    barrier.await.unwrap();
    assert!(engine.event_queue.dequeue_batch(100).await.is_empty());
    assert_eq!(
        engine
            .session_manager
            .get_session(&session)
            .unwrap()
            .compression_state
            .compression_count,
        0
    );
    let new = Message::assistant("New evidence during prefetch".into());
    // Bookkeeping changes keep identity and must not invalidate the candidate.
    messages[1].metadata.tokens = Some(99);
    messages[1].timestamp = std::time::UNIX_EPOCH;
    messages.push(new.clone());
    engine
        .session_manager
        .add_message(&session, new.clone())
        .await
        .unwrap();
    let result = tokio::time::timeout(
        std::time::Duration::from_secs(10),
        apply_prefetch(&engine, &session, &server, &messages, Some(work)),
    )
    .await
    .unwrap()
    .unwrap()
    .unwrap();
    assert!(result.1.iter().any(|message| message.id == new.id));
    assert_eq!(
        server.requests.lock().unwrap().len(),
        1,
        "ready candidate must not send another request"
    );
    let events = engine.event_queue.dequeue_batch(100).await;
    assert_eq!(
        events
            .iter()
            .filter(|event| matches!(event.event, AgenticEvent::ContextCompressionStarted { .. }))
            .count(),
        1
    );
    assert_eq!(
        events
            .iter()
            .filter(|event| matches!(
                event.event,
                AgenticEvent::ContextCompressionCompleted { applied: true, .. }
            ))
            .count(),
        1
    );
}

#[tokio::test]
async fn compression_prefetch_completed_failure_starts_new_blocking_request() {
    let (temp, engine) = engine();
    let server = RetryTestServer::new(vec![retry_test_success()]);
    let messages = messages();
    let session = prefetch_session(&engine, temp.path(), &messages).await;
    let (published, barrier) = tokio::sync::oneshot::channel();
    let work = prefetch_job(&engine, &server, &messages, 0).spawn_prefetch_with(
        &CancellationToken::new(),
        |_| async {
            let _ = published.send(());
            Err(OpenBitFunError::AIClient("Speculative failure".into()))
        },
    );
    barrier.await.unwrap();
    apply_prefetch(&engine, &session, &server, &messages, Some(work))
        .await
        .unwrap()
        .unwrap();
    assert_eq!(server.requests.lock().unwrap().len(), 1);
}

#[test]
fn compression_commit_id_prefix_accepts_bookkeeping_and_rejects_replacement() {
    let snapshot = vec![
        Message::user("first".into()),
        Message::assistant("second".into()),
    ];
    let extra = Message::assistant("new tail".into());
    let mut latest = snapshot.clone();
    latest[0].metadata.tokens = Some(7);
    latest[0].timestamp = std::time::UNIX_EPOCH;
    latest.push(extra.clone());
    let mut runtime = snapshot.clone();
    runtime.push(extra.clone());
    let merged = compression_job::merge_latest_context(&runtime, &snapshot, &latest).unwrap();
    assert_eq!(
        merged.len(),
        3,
        "tail already present in runtime must not be duplicated"
    );
    assert_eq!(merged[2].id, extra.id);
    assert!(compression_job::merge_latest_context(&runtime, &snapshot, &latest[..1]).is_err());
    latest.swap(0, 1);
    assert!(compression_job::merge_latest_context(&runtime, &snapshot, &latest).is_err());
    latest.swap(0, 1);
    latest[0] = Message::user("first".into());
    assert_ne!(
        latest[0].id, snapshot[0].id,
        "even same-text replacements have new identity"
    );
    assert!(compression_job::merge_latest_context(&runtime, &snapshot, &latest).is_err());
}

#[tokio::test]
async fn compression_prefetch_oversized_latest_tail_starts_fresh_blocking_plan() {
    let (temp, engine) = engine();
    let server = RetryTestServer::new(vec![retry_test_success()]);
    let mut messages = messages();
    let job = prefetch_job(&engine, &server, &messages, 0);
    let (published, barrier) = tokio::sync::oneshot::channel();
    let work = job.spawn_prefetch_with(&CancellationToken::new(), |job| async move {
        let result = job.run().await;
        let _ = published.send(());
        result
    });
    barrier.await.unwrap();
    messages.push(Message::assistant(
        "New large tool evidence ".repeat(100_000),
    ));
    let session = prefetch_session(&engine, temp.path(), &messages).await;
    let (_, result) = apply_prefetch(&engine, &session, &server, &messages, Some(work))
        .await
        .unwrap()
        .unwrap();
    assert_eq!(server.requests.lock().unwrap().len(), 2);
    assert!(result
        .iter()
        .any(|message| message.content.to_string().contains("Recovered")));
}

#[tokio::test]
async fn compression_prefetch_invalid_running_task_is_discarded_without_waiting() {
    let (temp, engine) = engine();
    let server = RetryTestServer::new(vec![retry_test_success()]);
    let mut messages = messages();
    let work = prefetch_job(&engine, &server, &messages, 0)
        .spawn_prefetch_with(&CancellationToken::new(), |_| std::future::pending());
    messages[1] = Message::user("Rewritten history".into());
    let session = prefetch_session(&engine, temp.path(), &messages).await;
    tokio::time::timeout(
        std::time::Duration::from_secs(10),
        apply_prefetch(&engine, &session, &server, &messages, Some(work)),
    )
    .await
    .unwrap()
    .unwrap()
    .unwrap();
    assert_eq!(server.requests.lock().unwrap().len(), 1);
}

#[tokio::test]
async fn compression_prefetch_cancelled_owner_never_falls_back() {
    let (temp, engine) = engine();
    let server = RetryTestServer::new(vec![retry_test_success()]);
    let messages = messages();
    let session = prefetch_session(&engine, temp.path(), &messages).await;
    let token = engine.round_executor.ensure_cancel_token("turn");
    let work = prefetch_job(&engine, &server, &messages, 0).spawn_prefetch(&token);
    token.cancel();
    let error = apply_prefetch(&engine, &session, &server, &messages, Some(work))
        .await
        .unwrap_err();
    assert!(matches!(error, OpenBitFunError::Cancelled(_)));
    assert!(server.requests.lock().unwrap().is_empty());
}

#[tokio::test]
async fn compression_prefetch_claimed_failure_ends_turn_without_new_request() {
    let (temp, engine) = engine();
    let server = RetryTestServer::new(vec![retry_test_success()]);
    let messages = messages();
    let session = prefetch_session(&engine, temp.path(), &messages).await;
    let (release, barrier) = tokio::sync::oneshot::channel();
    let work = prefetch_job(&engine, &server, &messages, 0).spawn_prefetch_with(
        &CancellationToken::new(),
        |_| async {
            barrier.await.unwrap();
            Err(OpenBitFunError::AIClient("Claimed failure".into()))
        },
    );
    let release_after_started = async {
        loop {
            if engine
                .event_queue
                .dequeue_batch(100)
                .await
                .iter()
                .any(|event| matches!(event.event, AgenticEvent::ContextCompressionStarted { .. }))
            {
                break;
            }
            tokio::task::yield_now().await;
        }
        release.send(()).unwrap();
    };
    let (result, _) = tokio::join!(
        apply_prefetch(&engine, &session, &server, &messages, Some(work)),
        release_after_started
    );
    assert!(result.unwrap_err().to_string().contains("Claimed failure"));
    assert!(server.requests.lock().unwrap().is_empty());
    assert_eq!(
        engine
            .session_manager
            .get_session(&session)
            .unwrap()
            .compression_state
            .compression_count,
        0
    );
}

#[tokio::test]
async fn compression_prefetch_commit_includes_append_during_formal_wait() {
    let (temp, engine) = engine();
    let server = RetryTestServer::new(vec![retry_test_success()]);
    let messages = messages();
    let session = prefetch_session(&engine, temp.path(), &messages).await;
    let candidate = prefetch_job(&engine, &server, &messages, 0)
        .run()
        .await
        .unwrap();
    engine.event_queue.dequeue_batch(100).await;
    let new = Message::assistant("Appended after formal snapshot".into());
    let (release, barrier) = tokio::sync::oneshot::channel();
    let work = prefetch_job(&engine, &server, &messages, 0).spawn_prefetch_with(
        &CancellationToken::new(),
        |_| async {
            barrier.await.unwrap();
            Ok(candidate)
        },
    );
    let append = async {
        loop {
            if engine
                .event_queue
                .dequeue_batch(100)
                .await
                .iter()
                .any(|event| matches!(event.event, AgenticEvent::ContextCompressionStarted { .. }))
            {
                break;
            }
            tokio::task::yield_now().await;
        }
        engine
            .session_manager
            .add_message(&session, new.clone())
            .await
            .unwrap();
        release.send(()).unwrap();
    };
    let (result, _) = tokio::join!(
        apply_prefetch(&engine, &session, &server, &messages, Some(work)),
        append
    );
    let (_, result) = result.unwrap().unwrap();
    assert!(result.iter().any(|message| message.id == new.id));
    let stored = engine
        .session_manager
        .get_context_messages(&session)
        .await
        .unwrap();
    assert!(stored.iter().any(|message| message.id == new.id));
    assert_eq!(server.requests.lock().unwrap().len(), 1);
}

#[tokio::test]
async fn compression_overflow_replans_with_smaller_input() {
    let (_temp, engine) = engine();
    let server = RetryTestServer::new(vec![overflow(), retry_test_success()]);
    let result = engine
        .build_planned_compression_result(
            "session",
            "turn",
            &messages(),
            128_000,
            None,
            server.client(),
            &ModelRequestContext::default(),
            &None,
            &PrependedPromptReminders::default(),
            false,
            None,
            None,
            None,
        )
        .await
        .unwrap()
        .unwrap();
    assert!(result
        .messages
        .iter()
        .any(|message| message.content.to_string().contains("Recovered")));
    let requests = server.requests.lock().unwrap();
    assert_eq!(requests.len(), 2);
    assert!(
        requests[1]["messages"].as_array().unwrap().len()
            < requests[0]["messages"].as_array().unwrap().len()
    );
}

#[tokio::test]
async fn compression_overflow_exhausts_four_plans_without_local_summary() {
    let (_temp, engine) = engine();
    let server = RetryTestServer::new(vec![overflow()]);
    let error = engine
        .build_planned_compression_result(
            "session",
            "turn",
            &messages(),
            128_000,
            None,
            server.client(),
            &ModelRequestContext::default(),
            &None,
            &PrependedPromptReminders::default(),
            false,
            None,
            None,
            None,
        )
        .await
        .unwrap_err();
    assert!(error.to_string().contains("plan 4"), "{error}");
    assert_eq!(server.requests.lock().unwrap().len(), 4);
}

#[tokio::test]
async fn compression_failure_preserves_context_and_success_count() {
    let (_temp, engine) = engine();
    let session = engine
        .session_manager
        .create_session(
            "compression test".into(),
            "Standard".into(),
            crate::agentic::core::SessionConfig {
                workspace_path: Some(_temp.path().to_string_lossy().into_owned()),
                ..Default::default()
            },
        )
        .await
        .unwrap();
    let messages = messages();
    engine
        .session_manager
        .replace_context_messages(&session.session_id, messages.clone())
        .await;
    let before = serde_json::to_value(
        engine
            .session_manager
            .get_context_messages(&session.session_id)
            .await
            .unwrap(),
    )
    .unwrap();
    let before_state = serde_json::to_value(
        engine
            .session_manager
            .get_session(&session.session_id)
            .unwrap()
            .compression_state,
    )
    .unwrap();
    let server = RetryTestServer::new(vec![(
        401,
        serde_json::json!({
            "error": {"code": "invalid_api_key", "message": "invalid api key"}
        })
        .to_string(),
    )]);
    let pressure = ExecutionEngine::estimate_auto_compression_pressure(
        &messages,
        None,
        128_000,
        ExecutionEngine::compression_trigger_budget(128_000, None),
        0,
    );
    let error = engine
        .compress_messages(
            &session.session_id,
            "turn",
            "auto",
            messages,
            pressure,
            128_000,
            server.client(),
            &ModelRequestContext::default(),
            &None,
            Message::system("system".into()),
            &PrependedPromptReminders::default(),
            false,
            10_000,
            None,
            None,
            None,
        )
        .await
        .unwrap_err();
    assert!(error.to_string().contains("plan 1"));
    assert_eq!(server.requests.lock().unwrap().len(), 1);
    assert_eq!(
        before,
        serde_json::to_value(
            engine
                .session_manager
                .get_context_messages(&session.session_id)
                .await
                .unwrap()
        )
        .unwrap()
    );
    assert_eq!(
        before_state,
        serde_json::to_value(
            engine
                .session_manager
                .get_session(&session.session_id)
                .unwrap()
                .compression_state
        )
        .unwrap()
    );
    let events = engine.event_queue.dequeue_batch(20).await;
    assert!(events
        .iter()
        .any(|event| matches!(event.event, AgenticEvent::ContextCompressionFailed { .. })));
    assert!(!events.iter().any(|event| matches!(
        event.event,
        AgenticEvent::ContextCompressionCompleted { .. }
    )));
}
