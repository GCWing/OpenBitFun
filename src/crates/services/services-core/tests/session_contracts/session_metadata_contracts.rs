use openbitfun_services_core::session::{
    build_session_index_snapshot, refresh_session_metadata_from_turns, remove_session_index_entry,
    try_refresh_session_metadata_for_saved_turn, upsert_session_index_entry, DialogTurnData,
    DialogTurnKind, ModelRoundData, SessionContextUsage, SessionContextUsageSource, SessionKind,
    SessionMetadata, StoredSessionIndexFile, TextItemData, ToolCallData, ToolItemData, TurnStatus,
    UserMessageData,
};

fn metadata(session_id: &str) -> SessionMetadata {
    SessionMetadata::new(
        session_id.to_string(),
        session_id.to_string(),
        "agent".to_string(),
        "model".to_string(),
    )
}

#[test]
fn legacy_agent_identity_migrates_without_changing_session_history() {
    let mut old = serde_json::to_value(metadata("legacy-session")).unwrap();
    old["agentType"] = serde_json::json!("agentic");
    old["lastUserDialogAgentType"] = serde_json::json!("Ultra");
    old["lastSubmittedAgentType"] = serde_json::json!("minimal");
    let migrated: SessionMetadata = serde_json::from_value(old.clone()).unwrap();
    assert_eq!(migrated.agent_type, "Standard");
    assert_eq!(
        migrated.last_user_dialog_agent_type.as_deref(),
        Some("Ultimate")
    );
    assert_eq!(
        migrated.last_submitted_agent_type.as_deref(),
        Some("Minimal")
    );
    old["agentType"] = serde_json::json!("Standard");
    old["lastUserDialogAgentType"] = serde_json::json!("Ultimate");
    old["lastSubmittedAgentType"] = serde_json::json!("Minimal");
    assert_eq!(serde_json::to_value(migrated).unwrap(), old);
}

fn user_message(content: &str) -> UserMessageData {
    UserMessageData {
        id: format!("user-{content}"),
        content: content.to_string(),
        timestamp: 0,
        metadata: None,
    }
}

fn text_item(id: &str) -> TextItemData {
    TextItemData {
        id: id.to_string(),
        content: id.to_string(),
        is_streaming: false,
        timestamp: 0,
        is_markdown: true,
        order_index: None,
        is_subagent_item: None,
        parent_task_tool_id: None,
        subagent_session_id: None,
        status: None,
        attempt_id: None,
        attempt_index: None,
    }
}

fn tool_item(id: &str) -> ToolItemData {
    ToolItemData {
        id: id.to_string(),
        tool_name: "Read".to_string(),
        tool_call: ToolCallData {
            input: serde_json::json!({ "path": "README.md" }),
            id: format!("call-{id}"),
        },
        tool_result: None,
        ai_intent: None,
        start_time: 0,
        end_time: Some(1),
        duration_ms: Some(1),
        queue_wait_ms: None,
        preflight_ms: None,
        confirmation_wait_ms: None,
        execution_ms: None,
        order_index: None,
        is_subagent_item: None,
        parent_task_tool_id: None,
        subagent_session_id: None,
        subagent_dialog_turn_id: None,
        attempt_id: None,
        attempt_index: None,
        subagent_model_id: None,
        subagent_model_display_name: None,
        status: Some("completed".to_string()),
        interruption_reason: None,
    }
}

fn round(turn_id: &str, text_count: usize, tool_count: usize) -> ModelRoundData {
    ModelRoundData {
        id: format!("round-{turn_id}"),
        turn_id: turn_id.to_string(),
        round_index: 0,
        round_group_id: None,
        timestamp: 0,
        text_items: (0..text_count)
            .map(|index| text_item(&format!("{turn_id}-text-{index}")))
            .collect(),
        tool_items: (0..tool_count)
            .map(|index| tool_item(&format!("{turn_id}-tool-{index}")))
            .collect(),
        thinking_items: Vec::new(),
        start_time: 0,
        end_time: Some(1),
        duration_ms: Some(1),
        provider_id: None,
        model_config_id: None,
        effective_model_name: None,
        routing: None,
        first_chunk_ms: None,
        first_visible_output_ms: None,
        stream_duration_ms: None,
        ttft_ms: None,
        attempt_count: None,
        attempt_diagnostics: vec![],
        failure_category: None,
        token_details: None,
        status: "completed".to_string(),
    }
}

fn turn(
    session_id: &str,
    turn_index: usize,
    text_count: usize,
    tool_count: usize,
) -> DialogTurnData {
    let turn_id = format!("turn-{turn_index}");
    let mut turn = DialogTurnData::new(
        turn_id.clone(),
        turn_index,
        session_id.to_string(),
        user_message(&format!("prompt-{turn_index}")),
    );
    turn.model_rounds
        .push(round(&turn_id, text_count, tool_count));
    turn
}

fn finished_turn(
    session_id: &str,
    turn_index: usize,
    status: TurnStatus,
    end_time: u64,
) -> DialogTurnData {
    let mut turn = turn(session_id, turn_index, 1, 0);
    turn.status = status;
    turn.end_time = Some(end_time);
    turn.duration_ms = Some(end_time.saturating_sub(turn.start_time));
    turn
}

#[test]
fn latest_turn_summary_is_additive_and_legacy_metadata_still_round_trips() {
    let original = metadata("session-a");
    let mut legacy = serde_json::to_value(&original).unwrap();
    legacy.as_object_mut().unwrap().remove("lastTurn");
    let mut loaded: SessionMetadata = serde_json::from_value(legacy.clone()).unwrap();
    assert!(loaded.last_turn.is_none());
    assert_eq!(serde_json::to_value(&loaded).unwrap(), legacy);
    let result = finished_turn("session-a", 0, TurnStatus::Error, 20);
    assert!(try_refresh_session_metadata_for_saved_turn(
        &mut loaded,
        "/workspace",
        None,
        &result,
        20
    ));
    let new_payload = serde_json::to_value(&loaded).unwrap();
    assert_eq!(new_payload["lastTurn"]["turnId"], "turn-0");
    assert_eq!(new_payload["lastTurn"]["status"], "error");
    assert_eq!(new_payload["unreadCompletion"], "error");
    let round_trip: SessionMetadata = serde_json::from_value(new_payload).unwrap();
    assert_eq!(round_trip.last_turn, loaded.last_turn);
}

#[test]
fn headless_completion_is_unread_but_checkpoint_repairs_do_not_revive_receipts() {
    let mut metadata = metadata("session-a");
    let active = turn("session-a", 0, 1, 0);
    assert!(try_refresh_session_metadata_for_saved_turn(
        &mut metadata,
        "/workspace",
        None,
        &active,
        1
    ));
    let done = finished_turn("session-a", 0, TurnStatus::Completed, 20);
    assert!(try_refresh_session_metadata_for_saved_turn(
        &mut metadata,
        "/workspace",
        Some(&active),
        &done,
        20
    ));
    assert_eq!(metadata.unread_completion.as_deref(), Some("completed"));
    metadata.unread_completion = None;
    let mut repaired = done.clone();
    repaired.end_time = Some(21);
    assert!(try_refresh_session_metadata_for_saved_turn(
        &mut metadata,
        "/workspace",
        Some(&done),
        &repaired,
        21
    ));
    assert!(metadata.unread_completion.is_none());
}

#[test]
fn repairing_an_older_turn_does_not_replace_the_latest_outcome() {
    let mut metadata = metadata("session-a");
    let first = finished_turn("session-a", 0, TurnStatus::Error, 20);
    let second = finished_turn("session-a", 1, TurnStatus::Completed, 30);
    refresh_session_metadata_from_turns(&mut metadata, "/workspace", &[first.clone(), second], 30);
    assert!(try_refresh_session_metadata_for_saved_turn(
        &mut metadata,
        "/workspace",
        Some(&first),
        &first,
        40
    ));
    assert_eq!(metadata.last_turn.as_ref().unwrap().turn_id, "turn-1");
    assert_eq!(
        metadata.last_turn.as_ref().unwrap().status,
        TurnStatus::Completed
    );
}

#[test]
fn delayed_read_receipts_cannot_clear_a_newer_result_and_legacy_receipts_still_work() {
    use openbitfun_services_core::session::apply_session_unread_completion;
    let mut current = metadata("session-a");
    let first = finished_turn("session-a", 0, TurnStatus::Completed, 20);
    refresh_session_metadata_from_turns(&mut current, "/workspace", &[first.clone()], 20);
    let mut stale = current.clone();
    stale.unread_completion = None;
    let second = finished_turn("session-a", 1, TurnStatus::Completed, 30);
    refresh_session_metadata_from_turns(&mut current, "/workspace", &[first, second], 30);
    apply_session_unread_completion(&mut current, &stale);
    assert_eq!(current.unread_completion.as_deref(), Some("completed"));
    let mut legacy = current.clone();
    legacy.last_turn = None;
    legacy.unread_completion = None;
    apply_session_unread_completion(&mut current, &legacy);
    assert!(current.unread_completion.is_none());
}

#[test]
fn deferred_tool_item_serializes_only_its_wire_invocation() {
    let mut item = tool_item("deferred");
    item.tool_name = "CallDeferredTool".to_string();
    item.tool_call.input = serde_json::json!({
        "tool_name": "WebFetch",
        "args": { "url": "https://example.test" }
    });

    let value = serde_json::to_value(&item).expect("serialize tool item");
    assert_eq!(value["toolName"], "CallDeferredTool");
    assert_eq!(value["toolCall"]["input"], item.tool_call.input);
    assert!(value.get("effectiveToolName").is_none());
    assert!(value.get("effectiveToolInput").is_none());
}

#[test]
fn full_refresh_recomputes_metadata_counters_from_turns() {
    let mut metadata = metadata("session-1");

    refresh_session_metadata_from_turns(
        &mut metadata,
        "D:/workspace/project",
        &[turn("session-1", 0, 2, 1), turn("session-1", 1, 1, 2)],
        42,
    );

    assert_eq!(metadata.turn_count, 2);
    assert_eq!(metadata.message_count, 5);
    assert_eq!(metadata.tool_call_count, 3);
    assert_eq!(metadata.last_active_at, 42);
    assert_eq!(
        metadata.workspace_path.as_deref(),
        Some("D:/workspace/project")
    );
}

#[test]
fn session_context_usage_round_trips_as_top_level_metadata() {
    let mut metadata = metadata("session-1");
    metadata.current_context_usage = Some(SessionContextUsage {
        turn_id: "turn-3".to_string(),
        input_tokens: 42_000,
        output_tokens: Some(1_500),
        total_tokens: 43_500,
        timestamp: 123,
        source: SessionContextUsageSource::ModelRequest,
    });

    let value = serde_json::to_value(&metadata).expect("serialize metadata");
    assert_eq!(value["currentContextUsage"]["turnId"], "turn-3");
    assert_eq!(value["currentContextUsage"]["source"], "model_request");

    let restored: SessionMetadata = serde_json::from_value(value).expect("deserialize metadata");
    assert_eq!(
        restored.current_context_usage,
        metadata.current_context_usage
    );
}

#[test]
fn full_refresh_drops_context_usage_for_a_removed_turn() {
    let mut metadata = metadata("session-1");
    metadata.current_context_usage = Some(SessionContextUsage {
        turn_id: "turn-1".to_string(),
        input_tokens: 42_000,
        output_tokens: Some(1_500),
        total_tokens: 43_500,
        timestamp: 123,
        source: SessionContextUsageSource::ModelRequest,
    });

    refresh_session_metadata_from_turns(
        &mut metadata,
        "D:/workspace/project",
        &[turn("session-1", 0, 1, 0)],
        42,
    );

    assert!(metadata.current_context_usage.is_none());
}

#[test]
fn full_refresh_keeps_context_usage_for_a_surviving_turn() {
    let mut metadata = metadata("session-1");
    metadata.current_context_usage = Some(SessionContextUsage {
        turn_id: "turn-0".to_string(),
        input_tokens: 42_000,
        output_tokens: Some(1_500),
        total_tokens: 43_500,
        timestamp: 123,
        source: SessionContextUsageSource::ModelRequest,
    });

    refresh_session_metadata_from_turns(
        &mut metadata,
        "D:/workspace/project",
        &[turn("session-1", 0, 1, 0)],
        42,
    );

    assert!(metadata.current_context_usage.is_some());
}

#[test]
fn saved_turn_refresh_updates_incrementally_for_append_and_replace() {
    let mut metadata = metadata("session-1");
    metadata.turn_count = 1;
    metadata.message_count = 2;
    metadata.tool_call_count = 1;

    assert!(try_refresh_session_metadata_for_saved_turn(
        &mut metadata,
        "D:/workspace/project",
        None,
        &turn("session-1", 1, 2, 2),
        50,
    ));
    assert_eq!(metadata.turn_count, 2);
    assert_eq!(metadata.message_count, 5);
    assert_eq!(metadata.tool_call_count, 3);

    assert!(try_refresh_session_metadata_for_saved_turn(
        &mut metadata,
        "D:/workspace/project",
        Some(&turn("session-1", 1, 2, 2)),
        &turn("session-1", 1, 1, 1),
        60,
    ));
    assert_eq!(metadata.turn_count, 2);
    assert_eq!(metadata.message_count, 4);
    assert_eq!(metadata.tool_call_count, 2);
    assert_eq!(metadata.last_active_at, 60);
}

#[test]
fn saved_turn_refresh_sets_last_finished_at_for_completed_user_dialog() {
    let mut metadata = metadata("session-1");
    let turn = finished_turn("session-1", 0, TurnStatus::Completed, 123);

    assert!(try_refresh_session_metadata_for_saved_turn(
        &mut metadata,
        "D:/workspace/project",
        None,
        &turn,
        200,
    ));

    assert_eq!(metadata.last_finished_at, Some(123));
}

#[test]
fn saved_turn_refresh_ignores_in_progress_turn_for_last_finished_at() {
    let mut metadata = metadata("session-1");
    let turn = turn("session-1", 0, 1, 0);

    assert!(try_refresh_session_metadata_for_saved_turn(
        &mut metadata,
        "D:/workspace/project",
        None,
        &turn,
        200,
    ));

    assert_eq!(metadata.last_finished_at, None);
}

#[test]
fn saved_turn_refresh_keeps_newer_last_finished_at() {
    let mut metadata = metadata("session-1");
    metadata.turn_count = 1;
    metadata.last_finished_at = Some(500);
    let turn = finished_turn("session-1", 1, TurnStatus::Completed, 300);

    assert!(try_refresh_session_metadata_for_saved_turn(
        &mut metadata,
        "D:/workspace/project",
        None,
        &turn,
        600,
    ));

    assert_eq!(metadata.last_finished_at, Some(500));
}

#[test]
fn full_refresh_uses_latest_terminal_user_dialog_finish_time() {
    let mut metadata = metadata("session-1");
    metadata.last_finished_at = Some(1);

    refresh_session_metadata_from_turns(
        &mut metadata,
        "D:/workspace/project",
        &[
            finished_turn("session-1", 0, TurnStatus::Completed, 100),
            finished_turn("session-1", 1, TurnStatus::Error, 300),
            finished_turn("session-1", 2, TurnStatus::Cancelled, 200),
        ],
        400,
    );

    assert_eq!(metadata.last_finished_at, Some(300));
}

#[test]
fn full_refresh_ignores_non_user_dialog_turns_for_last_finished_at() {
    let mut metadata = metadata("session-1");

    let mut local_command = finished_turn("session-1", 0, TurnStatus::Completed, 100);
    local_command.kind = DialogTurnKind::LocalCommand;
    let mut manual_compaction = finished_turn("session-1", 1, TurnStatus::Completed, 200);
    manual_compaction.kind = DialogTurnKind::ManualCompaction;

    refresh_session_metadata_from_turns(
        &mut metadata,
        "D:/workspace/project",
        &[local_command, manual_compaction],
        300,
    );

    assert_eq!(metadata.last_finished_at, None);
}

#[test]
fn full_refresh_clears_last_finished_at_without_terminal_user_dialog() {
    let mut metadata = metadata("session-1");
    metadata.last_finished_at = Some(500);

    refresh_session_metadata_from_turns(
        &mut metadata,
        "D:/workspace/project",
        &[turn("session-1", 0, 1, 0)],
        600,
    );

    assert_eq!(metadata.last_finished_at, None);
}

#[test]
fn saved_turn_refresh_rejects_gaps_and_session_mismatches() {
    let mut metadata = metadata("session-1");
    metadata.turn_count = 1;

    assert!(!try_refresh_session_metadata_for_saved_turn(
        &mut metadata,
        "D:/workspace/project",
        None,
        &turn("session-1", 2, 1, 0),
        50,
    ));
    assert!(!try_refresh_session_metadata_for_saved_turn(
        &mut metadata,
        "D:/workspace/project",
        Some(&turn("other-session", 0, 1, 0)),
        &turn("session-1", 0, 1, 0),
        50,
    ));
}

#[test]
fn completed_recovery_keeps_its_generation_and_rejects_an_older_receipt() {
    use openbitfun_services_core::session::apply_session_unread_completion;
    let mut current = metadata("session-1");
    let mut completed = finished_turn("session-1", 0, TurnStatus::Completed, 100);
    completed.recovery_epoch = Some(1);
    refresh_session_metadata_from_turns(&mut current, "workspace", &[completed.clone()], 100);
    let mut old = current.clone();
    old.unread_completion = None;

    completed.recovery_epoch = Some(2);
    completed.end_time = Some(200);
    refresh_session_metadata_from_turns(&mut current, "workspace", &[completed], 200);
    assert_eq!(
        current.last_turn.as_ref().unwrap().execution_generation,
        Some(2)
    );
    apply_session_unread_completion(&mut current, &old);
    assert_eq!(current.unread_completion.as_deref(), Some("completed"));

    let mut receipt = current.clone();
    receipt.unread_completion = None;
    apply_session_unread_completion(&mut current, &receipt);
    assert!(current.unread_completion.is_none());
}

#[test]
fn recovery_summary_upgrade_and_receipts_preserve_pause_cancellation_boundaries() {
    use openbitfun_services_core::session::{
        apply_session_unread_completion, DialogTurnRecoveryData, DialogTurnRecoveryStatus,
        SessionLastTurn,
    };
    let old = serde_json::json!({"turnId": "turn", "turnIndex": 0, "status": "cancelled"});
    let legacy: SessionLastTurn = serde_json::from_value(old.clone()).unwrap();
    assert_eq!(legacy.recovery_pending, None);
    assert_eq!(serde_json::to_value(&legacy).unwrap(), old);

    let mut old_summary = metadata("session-1");
    old_summary.last_turn = Some(legacy);
    old_summary.unread_completion = Some("interrupted".into());
    let mut new_client_receipt = old_summary.clone();
    new_client_receipt
        .last_turn
        .as_mut()
        .unwrap()
        .recovery_pending = Some(false);
    new_client_receipt.unread_completion = None;
    apply_session_unread_completion(&mut old_summary, &new_client_receipt);
    assert!(
        old_summary.unread_completion.is_none(),
        "new receipts must work with legacy summaries"
    );

    let mut current = metadata("session-1");
    let mut paused = finished_turn("session-1", 0, TurnStatus::Cancelled, 100);
    paused.finish_reason = Some("interrupted".into());
    paused.recovery = Some(DialogTurnRecoveryData {
        status: DialogTurnRecoveryStatus::Interrupted,
        execution_generation: 1,
        resume_count: 0,
        interrupted_at: Some(100),
        model_id: None,
    });
    refresh_session_metadata_from_turns(&mut current, "workspace", &[paused.clone()], 100);
    assert_eq!(
        current.last_turn.as_ref().unwrap().recovery_pending,
        Some(true)
    );
    let mut read_pause = current.clone();
    read_pause.unread_completion = None;
    apply_session_unread_completion(&mut current, &read_pause);
    assert!(current.unread_completion.is_none());
    assert_eq!(
        current.last_turn.as_ref().unwrap().recovery_pending,
        Some(true)
    );

    paused.finish_reason = Some("cancelled".into());
    paused.recovery_epoch = Some(1);
    paused.recovery = None;
    refresh_session_metadata_from_turns(&mut current, "workspace", &[paused], 200);
    assert_eq!(
        current.last_turn.as_ref().unwrap().recovery_pending,
        Some(false)
    );
    apply_session_unread_completion(&mut current, &read_pause);
    assert_eq!(current.unread_completion.as_deref(), Some("interrupted"));
    let mut read_stop = current.clone();
    read_stop.unread_completion = None;
    apply_session_unread_completion(&mut current, &read_stop);
    assert!(current.unread_completion.is_none());
}

#[test]
fn index_snapshot_keeps_visible_sessions_but_counts_all_metadata_files() {
    let mut first_tied = metadata("first-tied");
    first_tied.last_active_at = 1_000;
    let mut second_tied = metadata("second-tied");
    second_tied.last_active_at = 1_000;
    let mut older = metadata("older");
    older.last_active_at = 500;
    let mut internal = metadata("internal");
    internal.session_kind = SessionKind::Subagent;

    let (index, visible_sessions) =
        build_session_index_snapshot(vec![first_tied, older, internal, second_tied], 99);

    assert_eq!(index.updated_at, 99);
    assert_eq!(index.metadata_file_count, 4);
    assert_eq!(index.sessions.len(), 3);
    assert_eq!(
        visible_sessions
            .iter()
            .map(|metadata| metadata.session_id.as_str())
            .collect::<Vec<_>>(),
        vec!["first-tied", "second-tied", "older"]
    );
}

#[test]
fn index_entry_upsert_and_remove_preserve_sorting_and_counts() {
    let mut older = metadata("older");
    older.last_active_at = 10;
    let existing = StoredSessionIndexFile::with_metadata_file_count(1, vec![older], 1);

    let mut newer = metadata("newer");
    newer.last_active_at = 20;
    let index = upsert_session_index_entry(Some(existing), &newer, true, 99, 2);

    assert_eq!(index.metadata_file_count, 2);
    assert_eq!(
        index
            .sessions
            .iter()
            .map(|metadata| metadata.session_id.as_str())
            .collect::<Vec<_>>(),
        vec!["newer", "older"]
    );

    let index = remove_session_index_entry(Some(index), "newer", -1, 100)
        .expect("existing index should remain");
    assert_eq!(index.metadata_file_count, 1);
    assert_eq!(index.updated_at, 100);
    assert_eq!(index.sessions[0].session_id, "older");
}
