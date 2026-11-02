use super::*;
use crate::router_context::{RouterHistoryBootstrap, Utf8ByteBudget};
use serde_json::json;

fn state() -> RouterContextState {
    RouterContextState {
        task: "Inspect the parser".into(),
        history_bootstrap: Some(RouterHistoryBootstrap {
            turn_ids: vec!["older".into()],
            ..Default::default()
        }),
        ..Default::default()
    }
}

fn short_round(index: usize) -> Value {
    json!({
        "round_id": index,
        "assistant": {"text": format!("verified-fact-{index}"), "tool_calls": []},
        "tool_results": [],
    })
}

#[test]
fn historical_batch_accepts_more_than_live_capacity_and_covers_one_contiguous_prefix() {
    let mut state = state();
    let budget = 65_536;
    let mut batch = RouterHistoryBatch::new(&state, budget);
    for index in 0..250 {
        assert!(batch.try_append(
            &mut state,
            &format!("older-{index}"),
            RouterEntryKind::Round,
            &short_round(index),
            &EstimatedRouterTokens,
        ));
    }
    assert_eq!(state.entries.len(), 250);
    assert_eq!(state.omitted_through, 0);
    let work = batch.summary_work(&state, 3).unwrap();
    assert_eq!((work.base_through, work.through), (0, 247));
    assert!(EstimatedRouterTokens.count(&work.prompt) <= budget);
    assert!(work.prompt.len() <= budget * 3);
    assert!(work.prompt.contains("verified-fact-0"));
    assert!(work.prompt.contains("verified-fact-246"));
    assert!(!work.prompt.contains("verified-fact-247"));
    assert!(state.apply_summary(&work, "Verified all observations through fact 246"));
    assert_eq!(state.entries.len(), 3);
    assert_eq!(state.entries.front().unwrap().sequence, 248);
    assert_eq!(state.entries.back().unwrap().sequence, 250);
    assert_eq!(state.omitted_through, 0);
}

#[test]
fn token_budget_charges_the_summary_task_and_complete_observation_without_clipping() {
    let mut state = state();
    state.summary = "Confirmed earlier evidence. ".repeat(20);
    let budget = 4096;
    let mut batch = RouterHistoryBatch::new(&state, budget);
    let content = json!("large historical user update ".repeat(250));
    assert!(batch.try_append(
        &mut state,
        "first",
        RouterEntryKind::UserUpdate,
        &content,
        &EstimatedRouterTokens,
    ));
    let before = serde_json::to_value(&state).unwrap();
    assert!(!batch.try_append(
        &mut state,
        "second",
        RouterEntryKind::UserUpdate,
        &content,
        &EstimatedRouterTokens,
    ));
    assert_eq!(serde_json::to_value(&state).unwrap(), before);
    let work = batch.summary_work(&state, 0).unwrap();
    assert_eq!(work.through, 1);
    assert!(EstimatedRouterTokens.count(&work.prompt) <= budget);
    assert!(work.prompt.contains(content.as_str().unwrap()));
    assert!(work.prompt.contains(&state.summary));
    assert!(work.prompt.contains(&state.task));
}

#[test]
fn serialized_byte_budget_also_charges_source_ids_absent_from_the_model_prompt() {
    let mut state = state();
    let budget = 512;
    let mut batch = RouterHistoryBatch::new(&state, budget);
    let content = short_round(0);
    assert!(batch.try_append(
        &mut state,
        "short-source-id",
        RouterEntryKind::Round,
        &content,
        &EstimatedRouterTokens,
    ));
    let huge_source_id = "source-metadata".repeat(150);
    let entry = state.observation_entry(
        huge_source_id.clone(),
        RouterEntryKind::Round,
        content.clone(),
        &EstimatedRouterTokens,
    );
    let (_, tokens, bytes) = RouterHistoryBatch::entry_cost(&entry);
    assert!(batch.prompt_tokens + tokens <= budget);
    assert!(batch.bytes + bytes > budget * 3);
    assert!(!batch.try_append(
        &mut state,
        &huge_source_id,
        RouterEntryKind::Round,
        &content,
        &EstimatedRouterTokens,
    ));
    assert_eq!(state.next_sequence, 2);
    assert_eq!(state.entries.len(), 1);
    assert_eq!(batch.summary_work(&state, 0).unwrap().through, 1);
}

#[test]
fn persisted_large_bootstrap_queue_repartitions_after_the_model_budget_shrinks() {
    let mut state = state();
    let mut batch = RouterHistoryBatch::new(&state, 65_536);
    for index in 0..250 {
        assert!(batch.try_append(
            &mut state,
            &format!("older-{index}"),
            RouterEntryKind::Round,
            &short_round(index),
            &EstimatedRouterTokens,
        ));
    }
    state.history_bootstrap.as_mut().unwrap().entry_cursor = 250;
    // No new persisted fields are needed: old bounded and new larger bootstrap
    // queues use the same tolerant v1 inner-state / v2 checkpoint-envelope shape.
    let encoded = serde_json::to_value(&state).unwrap();
    let mut restored: RouterContextState = serde_json::from_value(encoded.clone()).unwrap();
    assert_eq!(serde_json::to_value(&restored).unwrap(), encoded);
    let budget = 2048;
    let mut through = 0;
    let mut calls = 0;
    while restored.entries.len() > 3 {
        let batch = RouterHistoryBatch::new(&restored, budget);
        let work = batch.summary_work(&restored, 3).unwrap();
        assert_eq!(work.base_through, through);
        assert!(work.through > through);
        assert_eq!(work.omitted_through, 0);
        assert!(EstimatedRouterTokens.count(&work.prompt) <= budget);
        assert!(work.prompt.len() <= budget * 3);
        through = work.through;
        assert!(restored.apply_summary(&work, "Confirmed historical facts"));
        assert_eq!(
            restored.history_bootstrap.as_ref().unwrap().entry_cursor,
            250
        );
        assert_eq!(restored.omitted_through, 0);
        calls += 1;
        restored = serde_json::from_value(serde_json::to_value(&restored).unwrap()).unwrap();
    }
    assert!(calls > 1);
    assert_eq!(through, 247);
    assert_eq!(restored.next_sequence, 251);
    assert_eq!(restored.entries.front().unwrap().sequence, 248);
}

#[test]
fn realtime_append_still_evicts_at_the_original_observation_capacity() {
    let mut state = RouterContextState::default();
    for index in 0..130 {
        state.append(
            format!("live-{index}"),
            RouterEntryKind::Round,
            short_round(index),
            &Utf8ByteBudget,
        );
    }
    assert_eq!(state.entries.len(), 128);
    assert_eq!(state.omitted_through, 2);
    assert_eq!(state.entries.front().unwrap().sequence, 3);
    assert_eq!(state.entries.back().unwrap().sequence, 130);
}
