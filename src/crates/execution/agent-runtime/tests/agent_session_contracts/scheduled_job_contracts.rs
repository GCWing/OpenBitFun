use openbitfun_agent_runtime::scheduled_job::{
    ScheduledJobEnqueueFailureAction, ScheduledJobRunStatus, ScheduledJobRuntimeState,
    ScheduledJobTriggerAction, DEFAULT_SCHEDULED_JOB_RETRY_DELAY_MS,
};
use serde_json::json;

#[test]
fn manual_trigger_coalesces_existing_pending_run() {
    let mut state = ScheduledJobRuntimeState {
        pending_trigger_at_ms: Some(10),
        retry_at_ms: Some(20),
        coalesced_run_count: 1,
        ..Default::default()
    };

    state.mark_manual_trigger(30);

    assert_eq!(state.pending_trigger_at_ms, Some(30));
    assert_eq!(state.last_trigger_at_ms, Some(30));
    assert_eq!(state.retry_at_ms, None);
    assert_eq!(state.coalesced_run_count, 2);
}

#[test]
fn due_scheduled_trigger_coalesces_when_active_or_pending() {
    let mut active_state = ScheduledJobRuntimeState {
        active_turn_id: Some("turn-1".to_string()),
        next_run_at_ms: Some(100),
        ..Default::default()
    };

    let active_action = active_state.apply_due_scheduled_trigger(100, Some(200));

    assert_eq!(active_action, ScheduledJobTriggerAction::Coalesced);
    assert_eq!(active_state.pending_trigger_at_ms, None);
    assert_eq!(active_state.last_trigger_at_ms, Some(100));
    assert_eq!(active_state.next_run_at_ms, Some(200));
    assert_eq!(active_state.coalesced_run_count, 1);

    let mut pending_state = ScheduledJobRuntimeState {
        pending_trigger_at_ms: Some(90),
        next_run_at_ms: Some(100),
        ..Default::default()
    };

    let pending_action = pending_state.apply_due_scheduled_trigger(100, Some(200));

    assert_eq!(pending_action, ScheduledJobTriggerAction::Coalesced);
    assert_eq!(pending_state.pending_trigger_at_ms, Some(90));
    assert_eq!(pending_state.last_trigger_at_ms, Some(100));
    assert_eq!(pending_state.next_run_at_ms, Some(200));
    assert_eq!(pending_state.coalesced_run_count, 1);
}

#[test]
fn due_scheduled_trigger_creates_pending_run_when_idle() {
    let mut state = ScheduledJobRuntimeState {
        next_run_at_ms: Some(100),
        retry_at_ms: Some(50),
        ..Default::default()
    };

    let action = state.apply_due_scheduled_trigger(100, Some(200));

    assert_eq!(action, ScheduledJobTriggerAction::Pending);
    assert_eq!(state.pending_trigger_at_ms, Some(100));
    assert_eq!(state.last_trigger_at_ms, Some(100));
    assert_eq!(state.retry_at_ms, None);
    assert_eq!(state.next_run_at_ms, Some(200));
}

#[test]
fn pending_wakeup_prefers_retry_time_when_present() {
    let mut state = ScheduledJobRuntimeState {
        next_run_at_ms: Some(1_000),
        pending_trigger_at_ms: Some(100),
        retry_at_ms: Some(500),
        ..Default::default()
    };

    assert_eq!(state.next_wakeup_at_ms(), Some(500));
    assert!(!state.pending_is_due(499));
    assert!(state.pending_is_due(500));

    state.retry_at_ms = None;

    assert_eq!(state.next_wakeup_at_ms(), Some(100));
    assert!(state.pending_is_due(100));
}

#[test]
fn disabled_and_config_clear_remove_pending_retry_without_touching_history() {
    let mut state = ScheduledJobRuntimeState {
        next_run_at_ms: Some(1_000),
        pending_trigger_at_ms: Some(100),
        retry_at_ms: Some(500),
        last_run_status: Some(ScheduledJobRunStatus::Error),
        consecutive_failures: 2,
        ..Default::default()
    };

    state.clear_pending_trigger();

    assert_eq!(state.next_run_at_ms, Some(1_000));
    assert_eq!(state.pending_trigger_at_ms, None);
    assert_eq!(state.retry_at_ms, None);
    assert_eq!(state.last_run_status, Some(ScheduledJobRunStatus::Error));
    assert_eq!(state.consecutive_failures, 2);

    state.pending_trigger_at_ms = Some(200);
    state.retry_at_ms = Some(300);

    state.mark_disabled();

    assert_eq!(state.next_run_at_ms, None);
    assert_eq!(state.pending_trigger_at_ms, None);
    assert_eq!(state.retry_at_ms, None);
    assert_eq!(state.last_run_status, Some(ScheduledJobRunStatus::Error));
    assert_eq!(state.consecutive_failures, 2);
}

#[test]
fn enqueue_success_sets_active_turn_and_disables_one_shot_next_run() {
    let mut state = ScheduledJobRuntimeState {
        next_run_at_ms: Some(300),
        pending_trigger_at_ms: Some(100),
        retry_at_ms: Some(200),
        last_error: Some("old error".to_string()),
        ..Default::default()
    };

    state.mark_enqueued("turn-1".to_string(), 150, true);

    assert_eq!(state.active_turn_id.as_deref(), Some("turn-1"));
    assert_eq!(state.pending_trigger_at_ms, None);
    assert_eq!(state.retry_at_ms, None);
    assert_eq!(state.last_enqueued_at_ms, Some(150));
    assert_eq!(state.last_run_status, Some(ScheduledJobRunStatus::Queued));
    assert_eq!(state.last_error, None);
    assert_eq!(state.next_run_at_ms, None);
}

#[test]
fn enqueue_failure_preserves_retry_and_missing_session_disable_semantics() {
    let mut retry_state = ScheduledJobRuntimeState {
        pending_trigger_at_ms: Some(100),
        consecutive_failures: 1,
        ..Default::default()
    };

    let retry_action = retry_state.mark_enqueue_failed(
        200,
        "temporary failure".to_string(),
        DEFAULT_SCHEDULED_JOB_RETRY_DELAY_MS,
        false,
    );

    assert_eq!(retry_action, ScheduledJobEnqueueFailureAction::Retry);
    assert_eq!(
        retry_state.retry_at_ms,
        Some(200 + DEFAULT_SCHEDULED_JOB_RETRY_DELAY_MS)
    );
    assert_eq!(retry_state.pending_trigger_at_ms, Some(100));
    assert_eq!(retry_state.consecutive_failures, 2);
    assert_eq!(
        retry_state.last_run_status,
        Some(ScheduledJobRunStatus::Error)
    );
    assert_eq!(retry_state.last_error.as_deref(), Some("temporary failure"));

    let mut missing_session_state = ScheduledJobRuntimeState {
        active_turn_id: Some("stale-turn".to_string()),
        next_run_at_ms: Some(300),
        pending_trigger_at_ms: Some(100),
        retry_at_ms: Some(150),
        consecutive_failures: 2,
        ..Default::default()
    };

    let disable_action = missing_session_state.mark_enqueue_failed(
        200,
        "session not found".to_string(),
        5_000,
        true,
    );

    assert_eq!(
        disable_action,
        ScheduledJobEnqueueFailureAction::DisableMissingSession
    );
    assert_eq!(missing_session_state.active_turn_id, None);
    assert_eq!(missing_session_state.next_run_at_ms, None);
    assert_eq!(missing_session_state.pending_trigger_at_ms, None);
    assert_eq!(missing_session_state.retry_at_ms, None);
    assert_eq!(missing_session_state.consecutive_failures, 3);
}

#[test]
fn trigger_delivered_elsewhere_clears_pending_and_stops_retrying() {
    let mut state = ScheduledJobRuntimeState {
        next_run_at_ms: Some(300),
        pending_trigger_at_ms: Some(100),
        retry_at_ms: Some(200),
        last_run_status: Some(ScheduledJobRunStatus::Error),
        last_error: Some(
            "Dialog turn ID is already active or completed: session_id=session_1, turn_id=turn-1"
                .to_string(),
        ),
        consecutive_failures: 416,
        ..Default::default()
    };

    state.mark_trigger_delivered_elsewhere(250);

    assert_eq!(state.pending_trigger_at_ms, None);
    assert_eq!(state.retry_at_ms, None);
    assert_eq!(state.next_run_at_ms, Some(300));
    assert_eq!(state.last_run_status, Some(ScheduledJobRunStatus::Ok));
    assert_eq!(state.last_error, None);
    assert_eq!(state.last_run_finished_at_ms, Some(250));
    assert_eq!(state.consecutive_failures, 0);
    assert!(!state.pending_is_due(1_000));
    assert_eq!(state.next_wakeup_at_ms(), Some(300));
}

#[test]
fn turn_completion_failure_and_cancel_preserve_legacy_status_fields() {
    let mut completed = ScheduledJobRuntimeState {
        active_turn_id: Some("turn-1".to_string()),
        consecutive_failures: 3,
        last_error: Some("old error".to_string()),
        ..Default::default()
    };

    completed.mark_turn_completed(1_000, 250);

    assert_eq!(completed.active_turn_id, None);
    assert_eq!(completed.last_run_status, Some(ScheduledJobRunStatus::Ok));
    assert_eq!(completed.last_error, None);
    assert_eq!(completed.last_duration_ms, Some(250));
    assert_eq!(completed.last_run_finished_at_ms, Some(1_000));
    assert_eq!(completed.last_run_started_at_ms, Some(750));
    assert_eq!(completed.consecutive_failures, 0);

    let mut failed = ScheduledJobRuntimeState {
        active_turn_id: Some("turn-2".to_string()),
        consecutive_failures: 1,
        ..Default::default()
    };

    failed.mark_turn_failed(2_000, "failed".to_string());

    assert_eq!(failed.active_turn_id, None);
    assert_eq!(failed.last_run_status, Some(ScheduledJobRunStatus::Error));
    assert_eq!(failed.last_error.as_deref(), Some("failed"));
    assert_eq!(failed.last_run_finished_at_ms, Some(2_000));
    assert_eq!(failed.consecutive_failures, 2);

    let mut cancelled = ScheduledJobRuntimeState {
        active_turn_id: Some("turn-3".to_string()),
        consecutive_failures: 4,
        last_error: Some("old error".to_string()),
        ..Default::default()
    };

    cancelled.mark_turn_cancelled(3_000);

    assert_eq!(cancelled.active_turn_id, None);
    assert_eq!(
        cancelled.last_run_status,
        Some(ScheduledJobRunStatus::Cancelled)
    );
    assert_eq!(cancelled.last_error, None);
    assert_eq!(cancelled.last_run_finished_at_ms, Some(3_000));
    assert_eq!(cancelled.consecutive_failures, 4);
}

#[test]
fn restart_recovery_marks_active_turn_error() {
    let mut state = ScheduledJobRuntimeState {
        active_turn_id: Some("turn-1".to_string()),
        pending_trigger_at_ms: Some(100),
        retry_at_ms: Some(200),
        consecutive_failures: 1,
        ..Default::default()
    };

    let changed =
        state.recover_interrupted_turn_after_restart(300, "Application restarted".to_string());

    assert!(changed);
    assert_eq!(state.active_turn_id, None);
    assert_eq!(state.pending_trigger_at_ms, None);
    assert_eq!(state.retry_at_ms, None);
    assert_eq!(state.last_run_status, Some(ScheduledJobRunStatus::Error));
    assert_eq!(state.last_error.as_deref(), Some("Application restarted"));
    assert_eq!(state.last_run_finished_at_ms, Some(300));
    assert_eq!(state.consecutive_failures, 2);

    assert!(!state.recover_interrupted_turn_after_restart(400, "ignored".to_string()));
}

#[test]
fn serde_shape_preserves_legacy_cron_state_wire_contract() {
    let state = ScheduledJobRuntimeState {
        next_run_at_ms: Some(100),
        pending_trigger_at_ms: Some(200),
        retry_at_ms: Some(300),
        last_trigger_at_ms: Some(400),
        last_enqueued_at_ms: Some(500),
        last_run_started_at_ms: Some(600),
        last_run_finished_at_ms: Some(700),
        last_duration_ms: Some(800),
        last_run_status: Some(ScheduledJobRunStatus::Running),
        last_error: Some("error".to_string()),
        active_turn_id: Some("turn".to_string()),
        consecutive_failures: 2,
        coalesced_run_count: 3,
    };

    assert_eq!(
        serde_json::to_value(state).expect("scheduled job runtime state should serialize"),
        json!({
            "nextRunAtMs": 100,
            "pendingTriggerAtMs": 200,
            "retryAtMs": 300,
            "lastTriggerAtMs": 400,
            "lastEnqueuedAtMs": 500,
            "lastRunStartedAtMs": 600,
            "lastRunFinishedAtMs": 700,
            "lastDurationMs": 800,
            "lastRunStatus": "running",
            "lastError": "error",
            "activeTurnId": "turn",
            "consecutiveFailures": 2,
            "coalescedRunCount": 3
        })
    );
}
