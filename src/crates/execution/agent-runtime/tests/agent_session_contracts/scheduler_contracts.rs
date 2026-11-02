use openbitfun_agent_runtime::scheduler::{
    build_thread_goal_objective_updated_delivery_plan, build_thread_goal_resumed_delivery_plan,
    resolve_agent_session_reply_action, resolve_background_delivery_action,
    resolve_background_delivery_injection, resolve_background_delivery_injection_for_turn,
    resolve_dialog_start_route, resolve_dialog_steering_action, ActiveDialogTurn,
    ActiveDialogTurnStore, AgentSessionReplyAction, BackgroundDeliveryAction,
    BackgroundDeliveryFacts, BackgroundInjectionKind, DialogReplySuppressionSet,
    DialogRoundInjectionInterrupt, DialogStartRoute, DialogStartRouteFacts, DialogSteeringAction,
    DialogTurnQueue, DialogTurnQueueError, SessionAbortFlags, SessionRoundInjectionBuffer,
    ThreadGoalDeliveryReminderKind, TurnOutcome, TurnOutcomeQueueAction, TurnOutcomeStatus,
    DEFAULT_MAX_DIALOG_QUEUE_DEPTH,
};
use openbitfun_runtime_ports::{
    AgentInputAttachment, AgentSessionReplyRoute, DialogQueuePriority, DialogSessionStateFact,
    DialogSteerOutcome, DialogSubmissionPolicy, DialogTriggerSource, RoundInjection,
    RoundInjectionKind, RoundInjectionTarget, RoundInjectionToolPreemption, ThreadGoal,
    ThreadGoalStatus,
};
use std::sync::Arc;
use std::time::SystemTime;

#[test]
fn background_delivery_injects_when_session_is_processing() {
    let action = resolve_background_delivery_action(BackgroundDeliveryFacts {
        session_state: DialogSessionStateFact::Processing,
    });

    assert_eq!(action, BackgroundDeliveryAction::InjectIntoRunningTurn);
}

#[test]
fn background_delivery_starts_agent_session_follow_up_when_session_is_not_processing() {
    for session_state in [
        DialogSessionStateFact::Missing,
        DialogSessionStateFact::Idle,
        DialogSessionStateFact::Error,
    ] {
        let action = resolve_background_delivery_action(BackgroundDeliveryFacts { session_state });

        assert_eq!(
            action,
            BackgroundDeliveryAction::SubmitAgentSessionFollowUp {
                queue_priority: DialogQueuePriority::Low,
            }
        );
    }
}

#[test]
fn background_delivery_follow_up_uses_agent_session_source_semantics() {
    let action = resolve_background_delivery_action(BackgroundDeliveryFacts {
        session_state: DialogSessionStateFact::Missing,
    });

    let policy = action
        .follow_up_submission_policy()
        .expect("follow-up action should expose submission policy");

    assert_eq!(policy.trigger_source, DialogTriggerSource::AgentSession);
    assert_eq!(policy.queue_priority, DialogQueuePriority::Low);
}

#[test]
fn background_delivery_injection_does_not_expose_follow_up_policy() {
    let action = resolve_background_delivery_action(BackgroundDeliveryFacts {
        session_state: DialogSessionStateFact::Processing,
    });

    assert_eq!(action.follow_up_submission_policy(), None);
}

#[test]
fn background_delivery_injection_builds_thread_goal_current_turn_message() {
    let created_at = SystemTime::UNIX_EPOCH;

    let injection = resolve_background_delivery_injection(
        BackgroundInjectionKind::ThreadGoalObjectiveUpdated,
        "injection-id".to_string(),
        "prompt".to_string(),
        Some("display".to_string()),
        created_at,
    );

    assert_eq!(injection.id, "injection-id");
    assert_eq!(
        injection.kind,
        RoundInjectionKind::ThreadGoalObjectiveUpdated
    );
    assert_eq!(injection.target, RoundInjectionTarget::CurrentRunningTurn);
    assert_eq!(injection.content, "prompt");
    assert_eq!(injection.display_content, "display");
    assert_eq!(injection.created_at, created_at);
    assert_eq!(
        injection.execution_policy.tool_preemption,
        RoundInjectionToolPreemption::None
    );
}

#[test]
fn background_delivery_injection_builds_background_result_with_display_fallback() {
    let created_at = SystemTime::UNIX_EPOCH;

    let injection = resolve_background_delivery_injection(
        BackgroundInjectionKind::BackgroundResult,
        "injection-id".to_string(),
        "result content".to_string(),
        None,
        created_at,
    );

    assert_eq!(injection.id, "injection-id");
    assert_eq!(injection.kind, RoundInjectionKind::BackgroundResult);
    assert_eq!(injection.target, RoundInjectionTarget::CurrentRunningTurn);
    assert_eq!(injection.content, "result content");
    assert_eq!(injection.display_content, "result content");
    assert_eq!(injection.created_at, created_at);
    assert_eq!(
        injection.execution_policy.tool_preemption,
        RoundInjectionToolPreemption::None
    );
}

#[test]
fn background_delivery_injection_can_target_one_exact_turn() {
    let created_at = SystemTime::now();
    let injection = resolve_background_delivery_injection_for_turn(
        BackgroundInjectionKind::BackgroundResult,
        "injection-id".to_string(),
        "result content".to_string(),
        None,
        created_at,
        "turn-1".to_string(),
    );

    assert_eq!(
        injection.target,
        RoundInjectionTarget::ExactTurn("turn-1".to_string())
    );
}

fn thread_goal() -> ThreadGoal {
    ThreadGoal {
        goal_id: "goal-1".to_string(),
        session_id: "session-1".to_string(),
        objective: "finish PR-C".to_string(),
        status: ThreadGoalStatus::Active,
        token_budget: None,
        tokens_used: 0,
        time_used_seconds: 0,
        created_at: 1,
        updated_at: 2,
        auto_continuation_count: 2,
    }
}

#[test]
fn thread_goal_resumed_delivery_plan_preserves_follow_up_and_metadata() {
    let plan = build_thread_goal_resumed_delivery_plan(&thread_goal());

    assert_eq!(
        plan.follow_up_user_input,
        "Resume working toward the active thread goal."
    );
    assert_eq!(
        plan.follow_up_original_user_input,
        Some(plan.display_message.clone())
    );
    assert!(plan
        .injection_prompt
        .contains("Continue working toward the active thread goal."));
    assert_eq!(plan.injection_display, plan.display_message);
    assert_eq!(
        plan.prepended_reminders[0].kind,
        ThreadGoalDeliveryReminderKind::GoalContinuation
    );
    assert_eq!(plan.user_message_metadata["threadGoalContinuation"], true);
    assert_eq!(plan.user_message_metadata["autoContinuationAttempt"], 2);
}

#[test]
fn thread_goal_objective_updated_delivery_plan_preserves_follow_up_and_metadata() {
    let plan = build_thread_goal_objective_updated_delivery_plan(&thread_goal());

    assert_eq!(
        plan.follow_up_user_input,
        "Adjust work to match the updated thread goal."
    );
    assert_eq!(plan.injection_display, "Thread goal updated: finish PR-C");
    assert_eq!(
        plan.follow_up_original_user_input,
        Some(plan.injection_display.clone())
    );
    assert!(plan
        .injection_prompt
        .contains("The active thread goal has been set or updated by the user."));
    assert_eq!(
        plan.prepended_reminders[0].kind,
        ThreadGoalDeliveryReminderKind::GoalObjectiveUpdated
    );
    assert_eq!(
        plan.user_message_metadata["threadGoalObjectiveUpdated"],
        true
    );
    assert_eq!(plan.user_message_metadata["goalId"], "goal-1");
}

#[test]
fn dialog_turn_queue_preserves_priority_order_and_fifo_within_priority() {
    let queue = DialogTurnQueue::with_max_depth(4);

    queue
        .enqueue("s1", "normal-1", DialogQueuePriority::Normal)
        .expect("normal turn should enqueue");
    queue
        .enqueue("s1", "high", DialogQueuePriority::High)
        .expect("high-priority turn should enqueue");
    queue
        .enqueue("s1", "normal-2", DialogQueuePriority::Normal)
        .expect("second normal turn should enqueue");

    assert_eq!(queue.depth("s1"), 3);
    assert!(queue.has_items("s1"));
    assert_eq!(queue.dequeue_next("s1"), Some("high"));
    assert_eq!(queue.dequeue_next("s1"), Some("normal-1"));
    assert_eq!(queue.dequeue_next("s1"), Some("normal-2"));
    assert_eq!(queue.dequeue_next("s1"), None);
}

#[test]
fn dialog_turn_queue_rejects_overflow_and_preserves_current_error_shape() {
    let queue = DialogTurnQueue::with_max_depth(1);

    queue
        .enqueue("s1", "first", DialogQueuePriority::Normal)
        .expect("first turn should fit");
    let error = queue
        .enqueue("s1", "overflow", DialogQueuePriority::Normal)
        .expect_err("overflow must reject instead of dropping queued work");

    assert_eq!(
        error,
        DialogTurnQueueError::Full {
            session_id: "s1".to_string(),
            max_depth: 1,
        }
    );
    assert_eq!(
        error.to_string(),
        "Message queue full for session s1 (max 1 messages)"
    );
    assert_eq!(queue.dequeue_next("s1"), Some("first"));
}

#[test]
fn dialog_turn_queue_clear_and_requeue_front_preserve_scheduler_recovery_contract() {
    let queue = DialogTurnQueue::default();

    assert_eq!(queue.max_depth(), DEFAULT_MAX_DIALOG_QUEUE_DEPTH);
    queue
        .enqueue("s1", "queued", DialogQueuePriority::Low)
        .expect("turn should enqueue");
    queue.requeue_front("s1", "retry", DialogQueuePriority::Low);

    assert_eq!(queue.dequeue_next("s1"), Some("retry"));
    assert_eq!(queue.clear("s1"), vec!["queued"]);
    assert!(!queue.has_items("s1"));
    assert_eq!(queue.depth("s1"), 0);
}

#[test]
fn dialog_turn_queue_requeued_turn_keeps_original_priority_for_later_ordering() {
    let queue = DialogTurnQueue::default();

    queue.requeue_front("s1", "retry-low", DialogQueuePriority::Low);
    queue
        .enqueue("s1", "new-high", DialogQueuePriority::High)
        .expect("new high-priority turn should enqueue before requeued low-priority turn");

    assert_eq!(queue.dequeue_next("s1"), Some("new-high"));
    assert_eq!(queue.dequeue_next("s1"), Some("retry-low"));
}

#[test]
fn dialog_turn_queue_removes_matching_queued_turn_without_reordering_others() {
    let queue = DialogTurnQueue::default();

    queue
        .enqueue("s1", "normal-1", DialogQueuePriority::Normal)
        .expect("first normal turn should enqueue");
    queue
        .enqueue("s1", "high", DialogQueuePriority::High)
        .expect("high-priority turn should enqueue");
    queue
        .enqueue("s1", "normal-2", DialogQueuePriority::Normal)
        .expect("second normal turn should enqueue");
    queue
        .enqueue("s2", "other-session", DialogQueuePriority::High)
        .expect("other session turn should enqueue");

    assert_eq!(
        queue.remove_first_matching("s1", |turn| *turn == "normal-1"),
        Some("normal-1")
    );
    assert_eq!(queue.depth("s1"), 2);
    assert_eq!(queue.dequeue_next("s1"), Some("high"));
    assert_eq!(queue.dequeue_next("s1"), Some("normal-2"));
    assert_eq!(queue.dequeue_next("s1"), None);
    assert_eq!(queue.dequeue_next("s2"), Some("other-session"));
}

#[test]
fn dialog_start_route_preserves_image_and_prepended_message_matrix() {
    assert_eq!(
        resolve_dialog_start_route(DialogStartRouteFacts {
            has_image_contexts: false,
            has_prepended_messages: false,
        }),
        DialogStartRoute::Plain
    );
    assert_eq!(
        resolve_dialog_start_route(DialogStartRouteFacts {
            has_image_contexts: false,
            has_prepended_messages: true,
        }),
        DialogStartRoute::WithPrependedMessages
    );
    assert_eq!(
        resolve_dialog_start_route(DialogStartRouteFacts {
            has_image_contexts: true,
            has_prepended_messages: false,
        }),
        DialogStartRoute::WithImageContexts
    );
    assert_eq!(
        resolve_dialog_start_route(DialogStartRouteFacts {
            has_image_contexts: true,
            has_prepended_messages: true,
        }),
        DialogStartRoute::WithImageContextsAndPrependedMessages
    );
}

#[test]
fn active_dialog_turn_owns_agent_session_reply_suppression_facts() {
    let route = AgentSessionReplyRoute {
        source_session_id: "source-session".to_string(),
        source_workspace_path: "workspace".to_string(),
        source_remote_connection_id: Some("conn-1".to_string()),
        source_remote_ssh_host: Some("host-1".to_string()),
    };
    let turn = ActiveDialogTurn::new(
        "turn-1".to_string(),
        Some("workspace".to_string()),
        Some("target-conn".to_string()),
        Some("target-host".to_string()),
        "Standard".to_string(),
        "run task".to_string(),
        Some(serde_json::json!({"kind": "session_message"})),
        DialogSubmissionPolicy::for_source(DialogTriggerSource::AgentSession),
        Some(route),
    );

    assert!(turn.is_agent_session_request());
    assert_eq!(turn.turn_id(), "turn-1");
    assert_eq!(turn.workspace_path(), Some("workspace"));
    assert_eq!(turn.remote_connection_id(), Some("target-conn"));
    assert_eq!(turn.remote_ssh_host(), Some("target-host"));
    assert_eq!(turn.agent_type(), "Standard");
    assert_eq!(turn.user_input(), "run task");
    assert!(turn.user_message_metadata().is_some());
    assert!(turn.reply_route().is_some());
    assert!(turn.should_suppress_cancelled_reply_for_requester("source-session"));
    assert!(!turn.should_suppress_cancelled_reply_for_requester("other-session"));
}

#[test]
fn active_dialog_turn_does_not_suppress_non_agent_session_turns() {
    let turn = ActiveDialogTurn::new(
        "turn-1".to_string(),
        None,
        None,
        None,
        "Standard".to_string(),
        "user task".to_string(),
        None,
        DialogSubmissionPolicy::for_source(DialogTriggerSource::DesktopUi),
        None,
    );

    assert!(!turn.is_agent_session_request());
    assert!(!turn.should_suppress_cancelled_reply_for_requester("source-session"));
}

#[test]
fn active_dialog_turn_store_owns_suppression_key_resolution_and_removal() {
    let store = ActiveDialogTurnStore::default();
    let turn = agent_session_turn("source-session");
    store.insert("target-session", turn);

    assert_eq!(
        store.suppression_key_for_requester("target-session", "source-session"),
        Some(("target-session".to_string(), "turn-1".to_string()))
    );
    assert_eq!(
        store.suppression_key_for_requester("target-session", "other-session"),
        None
    );

    let removed = store
        .remove("target-session")
        .expect("active turn should remove");
    assert_eq!(removed.turn_id(), "turn-1");
    assert!(store.remove("target-session").is_none());
}

#[test]
fn reply_suppression_set_marks_takes_and_clears_turn_keys() {
    let set = DialogReplySuppressionSet::default();

    set.mark("session-a", "turn-1");
    assert!(set.take("session-a", "turn-1"));
    assert!(!set.take("session-a", "turn-1"));

    set.mark("session-a", "turn-2");
    set.clear("session-a", "turn-2");
    assert!(!set.take("session-a", "turn-2"));
}

#[test]
fn session_abort_flags_are_session_scoped() {
    let flags = SessionAbortFlags::default();

    flags.mark("s1");
    assert!(flags.contains("s1"));
    assert!(!flags.contains("s2"));

    flags.clear("s1");
    assert!(!flags.contains("s1"));
}

#[test]
fn agent_session_reply_action_forwards_completed_outcome_with_legacy_reminder_text() {
    let turn = agent_session_turn("source-session");
    let outcome = TurnOutcome::Completed {
        turn_id: "turn-1".to_string(),
        final_response: "done".to_string(),
    };

    let action = resolve_agent_session_reply_action("target-session", &turn, &outcome, false);

    let AgentSessionReplyAction::Forward(plan) = action else {
        panic!("agent-session completion should forward a reply");
    };
    assert_eq!(plan.target_session_id, "source-session");
    assert_eq!(plan.target_workspace_path, "workspace");
    assert_eq!(plan.target_remote_connection_id.as_deref(), Some("conn-1"));
    assert_eq!(plan.target_remote_ssh_host.as_deref(), Some("host-1"));
    assert_eq!(plan.user_input, "done");
    assert_eq!(
        plan.user_message_metadata,
        Some(serde_json::json!({"kind": "session_message"}))
    );
    assert_eq!(
        plan.reminder_text,
        "This message is an automated reply to a previous SessionMessage call, not a human user message.\n\
From session: target-session\n\
From workspace: workspace\n\
Status: completed"
    );
}

#[test]
fn agent_session_reply_action_suppresses_cancelled_auto_reply_when_requested() {
    let turn = agent_session_turn("source-session");
    let outcome = TurnOutcome::Cancelled {
        turn_id: "turn-1".to_string(),
    };

    let action = resolve_agent_session_reply_action("target-session", &turn, &outcome, true);

    assert_eq!(
        action,
        AgentSessionReplyAction::SkipSuppressedCancelledReply
    );
}

#[test]
fn agent_session_reply_action_ignores_non_agent_session_turns() {
    let turn = ActiveDialogTurn::new(
        "turn-1".to_string(),
        Some("workspace".to_string()),
        None,
        None,
        "Standard".to_string(),
        "user task".to_string(),
        None,
        DialogSubmissionPolicy::for_source(DialogTriggerSource::DesktopUi),
        None,
    );
    let outcome = TurnOutcome::Completed {
        turn_id: "turn-1".to_string(),
        final_response: "done".to_string(),
    };

    let action = resolve_agent_session_reply_action("target-session", &turn, &outcome, false);

    assert_eq!(action, AgentSessionReplyAction::NoReply);
}

#[test]
fn dialog_steering_action_buffers_exact_running_turn_with_display_fallback() {
    let created_at = SystemTime::UNIX_EPOCH;

    let action = resolve_dialog_steering_action(
        Some("turn-1"),
        "session-1",
        "turn-1",
        "steer content".to_string(),
        None,
        vec![AgentInputAttachment::remote_image(
            "image-1",
            "shot.png",
            "data:image/png;base64,abc",
        )],
        serde_json::Map::from_iter([(
            "kind".to_string(),
            serde_json::Value::String("steering".to_string()),
        )]),
        "steer-id".to_string(),
        created_at,
    );

    let DialogSteeringAction::Buffer { injection, outcome } = action else {
        panic!("matching running turn should buffer steering");
    };
    assert_eq!(injection.id, "steer-id");
    assert_eq!(injection.kind, RoundInjectionKind::UserSteering);
    assert_eq!(
        injection.target,
        RoundInjectionTarget::ExactTurn("turn-1".to_string())
    );
    assert_eq!(injection.content, "steer content");
    assert_eq!(injection.display_content, "steer content");
    // Attachments and metadata ride the injection so the running turn sees the
    // same payload a turn-boundary submission would have carried.
    assert_eq!(injection.attachments.len(), 1);
    assert_eq!(injection.attachments[0].id, "image-1");
    assert_eq!(
        injection.metadata.get("kind").and_then(|v| v.as_str()),
        Some("steering")
    );
    assert_eq!(injection.created_at, created_at);
    assert_eq!(
        injection.execution_policy.tool_preemption,
        RoundInjectionToolPreemption::InterruptAfterCurrentAtomicUnit
    );
    assert_eq!(
        outcome,
        DialogSteerOutcome::Buffered {
            session_id: "session-1".to_string(),
            turn_id: "turn-1".to_string(),
            steering_id: "steer-id".to_string(),
        }
    );
}

#[test]
fn dialog_steering_action_rejects_when_target_turn_is_not_running() {
    let action = resolve_dialog_steering_action(
        Some("other-turn"),
        "session-1",
        "turn-1",
        "steer content".to_string(),
        Some("display".to_string()),
        Vec::new(),
        serde_json::Map::new(),
        "steer-id".to_string(),
        SystemTime::UNIX_EPOCH,
    );

    assert_eq!(
        action,
        DialogSteeringAction::Reject {
            error: "Dialog turn is no longer running and cannot be steered: session_id=session-1, turn_id=turn-1".to_string(),
        }
    );
}

#[test]
fn turn_outcome_status_reply_and_queue_policy_are_portable() {
    let completed = TurnOutcome::Completed {
        turn_id: "turn-complete".to_string(),
        final_response: "done".to_string(),
    };
    assert_eq!(completed.turn_id(), "turn-complete");
    assert_eq!(completed.status(), TurnOutcomeStatus::Completed);
    assert_eq!(completed.status_str(), "completed");
    assert_eq!(completed.reply_text(), "done");
    assert_eq!(
        completed.queue_action(),
        TurnOutcomeQueueAction::DispatchNext
    );

    let empty_completed = TurnOutcome::Completed {
        turn_id: "turn-empty".to_string(),
        final_response: "  ".to_string(),
    };
    assert_eq!(empty_completed.reply_text(), "(no final text response)");

    let cancelled = TurnOutcome::Cancelled {
        turn_id: "turn-cancel".to_string(),
    };
    assert_eq!(cancelled.status(), TurnOutcomeStatus::Cancelled);
    assert!(cancelled.reply_text().contains("cancelled"));
    assert_eq!(
        cancelled.queue_action(),
        TurnOutcomeQueueAction::DispatchNext
    );

    let failed = TurnOutcome::Failed {
        turn_id: "turn-fail".to_string(),
        error: "network offline".to_string(),
    };
    assert_eq!(failed.status(), TurnOutcomeStatus::Failed);
    assert!(failed.reply_text().contains("network offline"));
    assert_eq!(failed.queue_action(), TurnOutcomeQueueAction::ClearQueue);
}

#[test]
fn round_injection_buffer_drains_only_messages_for_the_active_turn() {
    let buffer = Arc::new(SessionRoundInjectionBuffer::default());
    buffer.push("s1", exact_turn_msg("turn-a", "first"));
    buffer.push("s1", exact_turn_msg("turn-b", "other"));
    buffer.push("s1", current_turn_msg("background"));

    let interrupt =
        DialogRoundInjectionInterrupt::new("s1".to_string(), "turn-a".to_string(), buffer.clone());
    assert!(interrupt.should_interrupt());
    assert!(!interrupt.should_cancel_running_tools());
    assert_eq!(
        interrupt.pending_tool_preemption(),
        RoundInjectionToolPreemption::InterruptAfterCurrentAtomicUnit
    );

    let drained = buffer.drain_for_turn("s1", "turn-a");
    assert_eq!(drained.len(), 2);
    assert_eq!(drained[0].content, "first");
    assert_eq!(drained[1].content, "background");
    assert_eq!(buffer.pending_count("s1"), 1);

    let remaining = buffer.drain_for_turn("s1", "turn-b");
    assert_eq!(remaining.len(), 1);
    assert_eq!(remaining[0].content, "other");
    assert_eq!(buffer.pending_count("s1"), 0);
}

#[test]
fn human_turn_handoff_leaves_runtime_reminders_and_other_targets_intact() {
    let buffer = SessionRoundInjectionBuffer::default();
    buffer.push("s1", exact_turn_msg("turn-a", "first"));
    buffer.push("s1", current_turn_msg("background"));
    buffer.push("s1", exact_turn_msg("turn-b", "other"));
    buffer.push("s1", exact_turn_msg("turn-a", "second"));
    let human = buffer.drain_matching_for_turn("s1", "turn-a", |message| {
        message.kind == RoundInjectionKind::UserSteering
    });
    assert_eq!(
        human
            .iter()
            .map(|message| message.content.as_str())
            .collect::<Vec<_>>(),
        vec!["first", "second"]
    );
    assert_eq!(
        buffer.drain_for_turn("s1", "turn-a")[0].content,
        "background"
    );
    assert_eq!(buffer.drain_for_turn("s1", "turn-b")[0].content, "other");
}

#[test]
fn round_injection_buffer_removes_one_exact_delivery_by_id() {
    let buffer = SessionRoundInjectionBuffer::default();
    buffer.push("s1", exact_turn_msg("turn-a", "first"));
    buffer.push("s1", exact_turn_msg("turn-a", "second"));

    let removed = buffer
        .remove_by_id("s1", "id-turn-a-first")
        .expect("remove exact injection");

    assert_eq!(removed.content, "first");
    assert_eq!(buffer.pending_count("s1"), 1);
    assert!(buffer.remove_by_id("s1", "missing").is_none());
    assert_eq!(buffer.drain_for_turn("s1", "turn-a")[0].content, "second");
}

fn exact_turn_msg(turn_id: &str, content: &str) -> RoundInjection {
    RoundInjection {
        id: format!("id-{turn_id}-{content}"),
        kind: RoundInjectionKind::UserSteering,
        execution_policy: RoundInjectionKind::UserSteering.default_execution_policy(),
        target: RoundInjectionTarget::ExactTurn(turn_id.to_string()),
        content: content.to_string(),
        display_content: content.to_string(),
        attachments: Vec::new(),
        metadata: serde_json::Map::new(),
        created_at: SystemTime::now(),
    }
}

fn current_turn_msg(content: &str) -> RoundInjection {
    RoundInjection {
        id: format!("id-current-{content}"),
        kind: RoundInjectionKind::BackgroundResult,
        execution_policy: RoundInjectionKind::BackgroundResult.default_execution_policy(),
        target: RoundInjectionTarget::CurrentRunningTurn,
        content: content.to_string(),
        display_content: content.to_string(),
        attachments: Vec::new(),
        metadata: serde_json::Map::new(),
        created_at: SystemTime::now(),
    }
}

fn agent_session_turn(source_session_id: &str) -> ActiveDialogTurn {
    ActiveDialogTurn::new(
        "turn-1".to_string(),
        Some("workspace".to_string()),
        Some("target-conn".to_string()),
        Some("target-host".to_string()),
        "Standard".to_string(),
        "run task".to_string(),
        Some(serde_json::json!({"kind": "session_message"})),
        DialogSubmissionPolicy::for_source(DialogTriggerSource::AgentSession),
        Some(AgentSessionReplyRoute {
            source_session_id: source_session_id.to_string(),
            source_workspace_path: "workspace".to_string(),
            source_remote_connection_id: Some("conn-1".to_string()),
            source_remote_ssh_host: Some("host-1".to_string()),
        }),
    )
}
