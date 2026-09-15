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
