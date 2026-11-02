use super::super::history_source::HistoryObservation;
use super::*;
use crate::agentic::core::{ToolCall, ToolResult};
use openbitfun_agent_runtime::router_context::RouterHistoryBootstrap;
use std::sync::atomic::AtomicUsize;
use tokio::sync::Semaphore;

struct MemoryHistory {
    turns: HashMap<String, usize>,
    calls: Mutex<Vec<String>>,
    fail: bool,
    kind: RouterEntryKind,
}

impl MemoryHistory {
    fn new(turn: &str, observations: usize) -> Arc<Self> {
        Arc::new(Self {
            turns: HashMap::from([(turn.into(), observations)]),
            calls: Mutex::new(Vec::new()),
            fail: false,
            kind: RouterEntryKind::Round,
        })
    }
}

#[async_trait::async_trait]
impl RouterHistorySource for MemoryHistory {
    async fn observations(&self, turn_id: &str) -> OpenBitFunResult<Vec<HistoryObservation>> {
        self.calls.lock().unwrap().push(turn_id.into());
        if self.fail {
            return Err(OpenBitFunError::Session(
                "Historical turn is unavailable".into(),
            ));
        }
        let count = self
            .turns
            .get(turn_id)
            .ok_or_else(|| OpenBitFunError::Session("Unknown historical turn".into()))?;
        Ok((0..*count).map(|index| HistoryObservation {
            source_id: format!("{turn_id}/observation/{index}"),
            kind: self.kind,
            content: json!({
                "round_id": format!("{turn_id}-{index}"),
                "assistant": {"text": format!("FACT_{turn_id}_{index:03}: {}", "verified parser evidence ".repeat(12)), "tool_calls": []},
                "tool_results": [],
            }),
        }).collect())
    }
}

struct RecordingSummary {
    prompts: Mutex<Vec<String>>,
    targets: Mutex<Vec<usize>>,
    responses: Vec<String>,
    calls: AtomicUsize,
    fail_call: Option<usize>,
    block_from: Option<usize>,
    release: Semaphore,
    budget: usize,
}

impl RecordingSummary {
    fn new() -> Arc<Self> {
        Arc::new(Self {
            prompts: Mutex::new(Vec::new()),
            targets: Mutex::new(Vec::new()),
            responses: Vec::new(),
            calls: AtomicUsize::new(0),
            fail_call: None,
            block_from: None,
            release: Semaphore::new(0),
            budget: 4096,
        })
    }
}

#[async_trait::async_trait]
impl SummaryProvider for RecordingSummary {
    async fn input_budget(&self, _: &RouterContextConfig) -> OpenBitFunResult<usize> {
        Ok(self.budget)
    }

    async fn summarize(
        &self,
        prompt: String,
        config: &RouterContextConfig,
    ) -> OpenBitFunResult<SummaryResult> {
        assert!(EstimatedRouterTokens.count(&prompt) <= self.budget);
        self.prompts.lock().unwrap().push(prompt);
        self.targets
            .lock()
            .unwrap()
            .push(config.summary_target_tokens);
        let call = self.calls.fetch_add(1, Ordering::SeqCst) + 1;
        if self.fail_call == Some(call) {
            return Err(OpenBitFunError::AIClient(
                "Synthetic auxiliary failure".into(),
            ));
        }
        if self.block_from.is_some_and(|start| call >= start) {
            self.release.acquire().await.unwrap().forget();
        }
        Ok(SummaryResult {
            text: self.responses.get(call - 1).cloned().unwrap_or_else(|| {
                "Verified earlier parser evidence; current validation remains pending".into()
            }),
            complete: true,
            model_id: "economy-fixture".into(),
            model_name: "economy-fixture".into(),
            usage: None,
            diagnostics: SummaryDiagnostics::default(),
        })
    }
}

fn context(provider: Arc<RecordingSummary>) -> RoundRouterContext {
    let mut factory = RouterContextFactory::new_with_counter(
        RouterContextConfig {
            summary_trigger_tokens: usize::MAX,
            ..Default::default()
        },
        3,
        "Router fixture system",
        None,
        Arc::new(EstimatedRouterTokens),
    )
    .unwrap();
    factory.summary_provider = provider;
    factory.summary_queue = RouterSummaryQueue::new(1, 32);
    factory.create(
        &format!("history-test-{}", uuid::Uuid::new_v4()),
        "current",
        "Inspect the parser",
    )
}

async fn wait_done(context: &RoundRouterContext) {
    tokio::time::timeout(Duration::from_secs(5), async {
        loop {
            if context
                .history_bootstrap
                .as_ref()
                .unwrap()
                .updates
                .borrow()
                .done
            {
                break;
            }
            tokio::task::yield_now().await;
        }
    })
    .await
    .unwrap();
}

async fn wait_calls(provider: &RecordingSummary, count: usize) {
    tokio::time::timeout(Duration::from_secs(5), async {
        while provider.calls.load(Ordering::SeqCst) < count {
            tokio::task::yield_now().await;
        }
    })
    .await
    .unwrap();
}

fn lineage(previous: &str) -> Vec<String> {
    vec![previous.into(), "current".into()]
}

fn bounded_history_context(provider: Arc<RecordingSummary>) -> RoundRouterContext {
    let mut context = context(provider);
    context.factory.config.summary_target_tokens = 64;
    context.state.summary = "Earlier parser behavior is verified; the fix is unverified".into();
    context.state.history_coverage = vec!["verified-older-turn".into()];
    context.state.history_bootstrap = Some(RouterHistoryBootstrap {
        turn_ids: vec!["older".into()],
        entry_cursor: 3,
        ..Default::default()
    });
    let mut batch = RouterHistoryBatch::new(&context.state, 4096);
    for index in 0..3 {
        assert!(batch.try_append(
            &mut context.state,
            &format!("older/observation/{index}"),
            RouterEntryKind::Round,
            &json!({"round_id": format!("historical-round-{index}"),
                "assistant": {"text": format!("FACT_{index}: user correction; parser test remains failing")}}),
            &EstimatedRouterTokens,
        ));
    }
    context
}

#[tokio::test]
async fn oversized_history_summary_retry_keeps_all_evidence_and_coverage_when_still_too_large() {
    let oversized = "Repeated background without compression. ".repeat(40);
    assert!(EstimatedRouterTokens.count(&oversized) > 64);
    let mut provider = RecordingSummary::new();
    Arc::get_mut(&mut provider).unwrap().responses = vec![oversized.clone(), oversized];
    let mut context = bounded_history_context(provider.clone());
    let before = serde_json::to_value(&context.state).unwrap();
    let batch = RouterHistoryBatch::new(&context.state, 4096);
    let (_sender, mut cancellation) = watch::channel(true);
    let result = summarize_prefix(
        &mut context.state,
        &context.factory,
        &batch,
        0,
        "historical-budget-test",
        &mut cancellation,
        &tokio_util::sync::CancellationToken::new(),
    )
    .await;
    assert!(
        result.is_err(),
        "Oversized retry must not replace historical evidence"
    );
    assert_eq!(serde_json::to_value(&context.state).unwrap(), before);
    assert_eq!(provider.calls.load(Ordering::SeqCst), 2);
    let prompts = provider.prompts.lock().unwrap();
    assert_eq!(prompts[0], prompts[1]);
    for index in 0..3 {
        assert!(prompts[1].contains(&format!("FACT_{index}")));
    }
    assert_eq!(*provider.targets.lock().unwrap(), vec![32, 16]);
}

#[tokio::test]
async fn oversized_history_summary_retry_accepts_complete_bounded_rewrite_of_original_evidence() {
    let compact = "Latest user correction: preserve parser aliases; rejects_legacy_alias still fails; fix unverified.";
    assert!(EstimatedRouterTokens.count(compact) <= 64);
    let mut provider = RecordingSummary::new();
    Arc::get_mut(&mut provider).unwrap().responses = vec![
        "Repeated background without compression. ".repeat(40),
        compact.into(),
    ];
    let mut context = bounded_history_context(provider.clone());
    let batch = RouterHistoryBatch::new(&context.state, 4096);
    let (_sender, mut cancellation) = watch::channel(true);
    summarize_prefix(
        &mut context.state,
        &context.factory,
        &batch,
        0,
        "historical-budget-test",
        &mut cancellation,
        &tokio_util::sync::CancellationToken::new(),
    )
    .await
    .unwrap();
    assert_eq!(context.state.summary, compact);
    assert_eq!(context.state.summarized_through, 3);
    assert!(context.state.entries.is_empty());
    assert_eq!(context.state.omitted_through, 0);
    assert_eq!(context.state.history_coverage, vec!["verified-older-turn"]);
    assert_eq!(
        context
            .state
            .history_bootstrap
            .as_ref()
            .unwrap()
            .entry_cursor,
        3
    );
    assert!(!context.state.history_bootstrap.as_ref().unwrap().complete);
    assert_eq!(provider.calls.load(Ordering::SeqCst), 2);
    let prompts = provider.prompts.lock().unwrap();
    assert_eq!(prompts[0], prompts[1]);
    assert!(prompts[1].contains("Earlier parser behavior is verified"));
    assert_eq!(*provider.targets.lock().unwrap(), vec![32, 16]);
    let restored: RouterContextState =
        serde_json::from_value(serde_json::to_value(&context.state).unwrap()).unwrap();
    assert_eq!(restored.summary, compact);
    assert_eq!(restored.summarized_through, 3);
}

#[tokio::test]
async fn more_than_two_hundred_observations_recover_with_bounded_prompts_and_complete_recent_rounds(
) {
    let provider = RecordingSummary::new();
    let mut context = context(provider.clone());
    let source = MemoryHistory::new("older", 250);
    let messages = vec![Message::user("Current user request".into())];
    let original = serde_json::to_value(&messages).unwrap();
    context.prepare_history(source, &lineage("older"), &messages);
    assert!(context.render().history_truncated);
    wait_done(&context).await;
    context.poll_history_bootstrap();
    assert!(context.history_bootstrap.is_none());
    assert!(context.state.history_bootstrap.is_none());
    assert_eq!(context.state.omitted_through, 0);
    assert_eq!(context.state.history_coverage, vec!["older"]);
    assert_eq!(context.state.entries.len(), 3);
    let prepared = context.render();
    assert!(!prepared.history_truncated);
    let prompts = provider.prompts.lock().unwrap();
    assert!(prompts.len() > 1);
    let sent = prompts.join("\n");
    for index in 0..250 {
        let fact = format!("FACT_older_{index:03}");
        assert!(
            sent.contains(&fact) || prepared.user_prompt.contains(&fact),
            "missing {fact}"
        );
    }
    for index in 247..250 {
        assert!(prepared
            .user_prompt
            .contains(&format!("FACT_older_{index:03}")));
    }
    assert_eq!(serde_json::to_value(&messages).unwrap(), original);
}

#[tokio::test]
async fn model_budget_batches_more_than_live_capacity_in_one_historical_request() {
    let mut provider = RecordingSummary::new();
    Arc::get_mut(&mut provider).unwrap().budget = 65_536;
    let mut context = context(provider.clone());
    context.prepare_history(MemoryHistory::new("older", 250), &lineage("older"), &[]);
    wait_done(&context).await;
    let update = context
        .history_bootstrap
        .as_ref()
        .unwrap()
        .updates
        .borrow()
        .clone();
    assert!(update.error.is_none());
    assert!(update.state.history_bootstrap.as_ref().unwrap().complete);
    assert_eq!(update.state.omitted_through, 0);
    assert_eq!(provider.calls.load(Ordering::SeqCst), 1);
    let prompt = provider.prompts.lock().unwrap()[0].clone();
    for index in 0..247 {
        assert!(prompt.contains(&format!("FACT_older_{index:03}")));
    }
    context.poll_history_bootstrap();
    assert!(!context.render().history_truncated);
    assert_eq!(context.state.entries.len(), 3);
    assert_eq!(context.state.history_coverage, vec!["older"]);
}

#[tokio::test]
async fn cancelled_large_checkpoint_queue_resumes_under_a_smaller_model_budget() {
    let directory = tempfile::tempdir().unwrap();
    let mut provider = RecordingSummary::new();
    Arc::get_mut(&mut provider).unwrap().budget = 65_536;
    Arc::get_mut(&mut provider).unwrap().block_from = Some(1);
    let mut original = context(provider.clone());
    let session_id = original.state.session_id.clone();
    let visible = lineage("older");
    let cancellation = tokio_util::sync::CancellationToken::new();
    original.set_history_cancellation(cancellation.clone());
    original
        .restore_session(Some(directory.path().to_path_buf()), &visible, &[])
        .await;
    original.prepare_history(MemoryHistory::new("older", 250), &visible, &[]);
    wait_calls(&provider, 1).await;
    cancellation.cancel();
    wait_done(&original).await;
    assert!(original
        .history_bootstrap
        .as_ref()
        .unwrap()
        .updates
        .borrow()
        .error
        .is_some());
    drop(original);

    let healthy = RecordingSummary::new();
    let mut recovered = context(healthy.clone());
    recovered.state.session_id = session_id;
    recovered
        .restore_session(Some(directory.path().to_path_buf()), &visible, &[])
        .await;
    assert_eq!(recovered.state.entries.len(), 250);
    assert_eq!(recovered.state.omitted_through, 0);
    let progress = recovered.state.history_bootstrap.as_ref().unwrap();
    assert_eq!((progress.turn_cursor, progress.entry_cursor), (1, 0));
    assert!(!progress.complete);
    let source = MemoryHistory::new("older", 250);
    recovered.prepare_history(source.clone(), &visible, &[]);
    wait_done(&recovered).await;
    recovered.poll_history_bootstrap();
    assert!(source.calls.lock().unwrap().is_empty());
    assert!(!recovered.render().history_truncated);
    assert_eq!(recovered.state.omitted_through, 0);
    assert_eq!(recovered.state.entries.len(), 3);
    assert_eq!(recovered.state.history_coverage, vec!["older"]);
    assert!(healthy.calls.load(Ordering::SeqCst) > 1);
    let sent = healthy.prompts.lock().unwrap().join("\n");
    for index in 0..247 {
        assert!(sent.contains(&format!("FACT_older_{index:03}")));
    }
}

#[tokio::test]
async fn historical_completion_merges_only_when_the_live_suffix_fits_its_original_capacity() {
    for live_count in [125, 126, 129] {
        let mut provider = RecordingSummary::new();
        Arc::get_mut(&mut provider).unwrap().budget = 65_536;
        Arc::get_mut(&mut provider).unwrap().block_from = Some(1);
        let mut context = context(provider.clone());
        context.prepare_history(MemoryHistory::new("older", 250), &lineage("older"), &[]);
        wait_calls(&provider, 1).await;
        for index in 0..live_count {
            context.state.append(
                format!("live-{index}"),
                RouterEntryKind::Round,
                json!({"round_id": index, "assistant": {"text": format!("LIVE_FACT_{index}"), "tool_calls": []}, "tool_results": []}),
                context.factory.counter.as_ref(),
            );
        }
        provider.release.add_permits(1);
        wait_done(&context).await;
        context.poll_history_bootstrap();
        if live_count == 125 {
            assert!(context.history_bootstrap.is_none());
            assert_eq!(context.state.entries.len(), 128);
            assert_eq!(context.state.omitted_through, 0);
            assert_eq!(context.state.history_coverage, vec!["older"]);
            let ready = context.render().user_prompt;
            for index in 0..live_count {
                assert!(ready.contains(&format!("LIVE_FACT_{index}")));
            }
        } else {
            assert!(context.history_bootstrap.is_some());
            assert!(context.state.history_coverage.is_empty());
            assert!(context.render().history_truncated);
            assert_eq!(context.state.entries.len(), live_count.min(128));
            assert_eq!(context.state.omitted_through != 0, live_count > 128);
        }
    }
}

#[tokio::test]
async fn a_historical_feedback_tail_larger_than_live_capacity_is_summarized_before_merge() {
    let mut provider = RecordingSummary::new();
    Arc::get_mut(&mut provider).unwrap().budget = 65_536;
    let mut context = context(provider.clone());
    let mut source = MemoryHistory::new("older", 200);
    Arc::get_mut(&mut source).unwrap().kind = RouterEntryKind::Feedback;
    context.prepare_history(source, &lineage("older"), &[]);
    wait_done(&context).await;
    let update = context
        .history_bootstrap
        .as_ref()
        .unwrap()
        .updates
        .borrow()
        .clone();
    assert!(update.error.is_none());
    assert_eq!(provider.calls.load(Ordering::SeqCst), 1);
    assert!(update.state.entries.is_empty());
    assert_eq!(update.state.summarized_through, 200);
    context.poll_history_bootstrap();
    assert!(!context.render().history_truncated);
    assert_eq!(context.state.omitted_through, 0);
    assert_eq!(context.state.history_coverage, vec!["older"]);
}

#[tokio::test]
async fn damaged_sidecar_is_rebuilt_above_its_original_sequence_instead_of_clearing_the_gap() {
    let provider = RecordingSummary::new();
    let mut context = context(provider.clone());
    context.state.next_sequence = 169;
    context.state.omitted_through = 40;
    context
        .state
        .seen_message_ids
        .insert("claimed-old-message".into());
    context.prepare_history(MemoryHistory::new("older", 220), &lineage("older"), &[]);
    assert!(context.render().history_truncated);
    wait_done(&context).await;
    context.poll_history_bootstrap();
    assert!(!context.render().history_truncated);
    assert_eq!(context.state.omitted_through, 0);
    assert!(context.state.next_sequence > 169);
    assert!(context.state.summarized_through >= 169);
    assert!(provider
        .prompts
        .lock()
        .unwrap()
        .iter()
        .any(|prompt| prompt.contains("FACT_older_000")));
    assert_eq!(context.state.entries.len(), 3);
}

#[tokio::test]
async fn observations_arriving_during_bootstrap_are_merged_once_and_initial_messages_stay_claimed()
{
    let mut provider = RecordingSummary::new();
    Arc::get_mut(&mut provider).unwrap().block_from = Some(1);
    let mut context = context(provider.clone());
    let mut messages =
        vec![Message::assistant("HISTORICAL_ALREADY_CLAIMED".into()).with_turn_id("older".into())];
    context.prepare_history(
        MemoryHistory::new("older", 100),
        &lineage("older"),
        &messages,
    );
    wait_calls(&provider, 1).await;
    messages.push(Message::assistant("LIVE_ASSISTANT_FINDING".into()));
    messages.push(Message::user("LIVE_USER_CORRECTION: inspect only".into()));
    let pending = context.prepare(&messages).await;
    assert!(pending.history_truncated);
    assert!(pending.user_prompt.contains("LIVE_ASSISTANT_FINDING"));
    assert!(!pending.user_prompt.contains("HISTORICAL_ALREADY_CLAIMED"));
    provider.release.add_permits(128);
    wait_done(&context).await;
    context.poll_history_bootstrap();
    assert!(context.history_bootstrap.is_none());
    let ready = context.render();
    assert!(!ready.history_truncated);
    assert!(ready.user_prompt.contains("LIVE_ASSISTANT_FINDING"));
    assert!(ready.user_prompt.contains("LIVE_USER_CORRECTION"));
    assert!(!ready.user_prompt.contains("HISTORICAL_ALREADY_CLAIMED"));
    let entries = context.state.entries.len();
    context.observe(&messages);
    assert_eq!(context.state.entries.len(), entries);
    for message in &messages {
        assert!(context.state.seen_message_ids.contains(&message.id));
    }
    assert_eq!(
        context
            .state
            .entries
            .iter()
            .filter(|entry| entry.source_id == messages[1].id)
            .count(),
        1
    );
}

#[tokio::test]
async fn accepted_chunk_progress_survives_provider_failure_and_restarts_from_the_saved_cursor() {
    let directory = tempfile::tempdir().unwrap();
    let mut failing = RecordingSummary::new();
    Arc::get_mut(&mut failing).unwrap().fail_call = Some(2);
    let mut original = context(failing.clone());
    let session_id = original.state.session_id.clone();
    let visible = lineage("older");
    let messages = vec![Message::user("Current user request".into())];
    original
        .restore_session(Some(directory.path().to_path_buf()), &visible, &messages)
        .await;
    original.prepare_history(MemoryHistory::new("older", 220), &visible, &messages);
    wait_done(&original).await;
    assert!(original
        .history_bootstrap
        .as_ref()
        .unwrap()
        .updates
        .borrow()
        .error
        .is_some());
    original.poll_history_bootstrap();
    assert!(original.render().history_truncated);
    drop(original);

    let healthy = RecordingSummary::new();
    let mut recovered = context(healthy.clone());
    recovered.state.session_id = session_id;
    recovered
        .restore_session(Some(directory.path().to_path_buf()), &visible, &messages)
        .await;
    let saved = recovered.state.history_bootstrap.as_ref().unwrap().clone();
    assert_eq!(saved.turn_cursor, 0);
    assert!(saved.entry_cursor > 0 && saved.entry_cursor < 220);
    assert!(!recovered.state.summary.is_empty());
    assert!(recovered.state.summarized_through > 0);
    recovered.prepare_history(MemoryHistory::new("older", 220), &visible, &messages);
    wait_done(&recovered).await;
    recovered.poll_history_bootstrap();
    assert!(!recovered.render().history_truncated);
    assert_eq!(recovered.state.omitted_through, 0);
    assert_eq!(recovered.state.history_coverage, vec!["older"]);
    let resumed_prompts = healthy.prompts.lock().unwrap().join("\n");
    assert!(!resumed_prompts.contains("FACT_older_000"));
    assert!(resumed_prompts.contains(&format!("FACT_older_{:03}", saved.entry_cursor)));
    for index in 217..220 {
        assert!(recovered
            .render()
            .user_prompt
            .contains(&format!("FACT_older_{index:03}")));
    }
}

#[tokio::test]
async fn unavailable_or_shortened_source_never_certifies_partial_history() {
    for shortened in [false, true] {
        let provider = RecordingSummary::new();
        let mut context = context(provider.clone());
        let mut source = MemoryHistory::new("older", 5);
        if shortened {
            context.state.history_bootstrap = Some(RouterHistoryBootstrap {
                turn_ids: vec!["older".into()],
                turn_cursor: 0,
                entry_cursor: 50,
                complete: false,
            });
        } else {
            Arc::get_mut(&mut source).unwrap().fail = true;
        }
        context.prepare_history(source, &lineage("older"), &[]);
        wait_done(&context).await;
        assert!(context
            .history_bootstrap
            .as_ref()
            .unwrap()
            .updates
            .borrow()
            .error
            .is_some());
        context.poll_history_bootstrap();
        assert!(context.state.history_bootstrap.is_some());
        assert!(context.state.history_coverage.is_empty());
        assert!(context.render().history_truncated);
        assert_eq!(provider.calls.load(Ordering::SeqCst), 0);
    }
}

#[tokio::test]
async fn a_different_visible_history_rebuilds_instead_of_reusing_an_abandoned_cursor() {
    let provider = RecordingSummary::new();
    let mut context = context(provider.clone());
    context.state.history_bootstrap = Some(RouterHistoryBootstrap {
        turn_ids: vec!["abandoned".into()],
        turn_cursor: 1,
        entry_cursor: 0,
        complete: true,
    });
    context.state.summary = "ABANDONED_BRANCH_FACT".into();
    context.state.history_coverage = vec!["abandoned".into()];
    context.prepare_history(MemoryHistory::new("visible", 30), &lineage("visible"), &[]);
    wait_done(&context).await;
    context.poll_history_bootstrap();
    assert!(!context.render().history_truncated);
    assert_eq!(context.state.history_coverage, vec!["visible"]);
    assert!(!context
        .render()
        .user_prompt
        .contains("ABANDONED_BRANCH_FACT"));
    assert!(provider
        .prompts
        .lock()
        .unwrap()
        .iter()
        .all(|prompt| !prompt.contains("ABANDONED_BRANCH_FACT")));
}

#[tokio::test]
async fn independent_sessions_never_merge_each_others_history() {
    let left_provider = RecordingSummary::new();
    let right_provider = RecordingSummary::new();
    let mut left = context(left_provider.clone());
    let mut right = context(right_provider.clone());
    left.prepare_history(MemoryHistory::new("left", 50), &lineage("left"), &[]);
    right.prepare_history(MemoryHistory::new("right", 50), &lineage("right"), &[]);
    tokio::join!(wait_done(&left), wait_done(&right));
    left.poll_history_bootstrap();
    right.poll_history_bootstrap();
    assert_eq!(left.state.history_coverage, vec!["left"]);
    assert_eq!(right.state.history_coverage, vec!["right"]);
    assert!(!left.render().user_prompt.contains("FACT_right"));
    assert!(!right.render().user_prompt.contains("FACT_left"));
    assert!(left_provider
        .prompts
        .lock()
        .unwrap()
        .iter()
        .all(|prompt| !prompt.contains("FACT_right")));
    assert!(right_provider
        .prompts
        .lock()
        .unwrap()
        .iter()
        .all(|prompt| !prompt.contains("FACT_left")));
}

#[tokio::test]
async fn same_session_replacement_cancels_an_inflight_summary_and_fences_its_checkpoint() {
    let directory = tempfile::tempdir().unwrap();
    let mut old_provider = RecordingSummary::new();
    Arc::get_mut(&mut old_provider).unwrap().block_from = Some(1);
    let mut old = context(old_provider.clone());
    let session_id = old.state.session_id.clone();
    let visible = lineage("older");
    old.restore_session(Some(directory.path().to_path_buf()), &visible, &[])
        .await;
    let old_checkpoint = old.session_checkpoint.clone().unwrap();
    old.prepare_history(MemoryHistory::new("older", 200), &visible, &[]);
    wait_calls(&old_provider, 1).await;

    let replacement_provider = RecordingSummary::new();
    let mut replacement = context(replacement_provider.clone());
    replacement.state.session_id = session_id.clone();
    replacement
        .restore_session(Some(directory.path().to_path_buf()), &visible, &[])
        .await;
    replacement.prepare_history(MemoryHistory::new("older", 25), &visible, &[]);
    wait_done(&replacement).await;
    replacement.poll_history_bootstrap();
    assert!(!replacement.render().history_truncated);
    replacement.finish(&[]).await;
    let accepted = replacement.state.clone();
    old_provider.release.add_permits(128);
    for _ in 0..10 {
        tokio::task::yield_now().await;
    }
    assert_eq!(old_provider.calls.load(Ordering::SeqCst), 1);
    assert!(old.history_bootstrap.is_some());

    let mut stale = old.state.clone();
    stale.next_sequence = accepted.next_sequence + 1000;
    stale.summary = "STALE_GENERATION_FACT".into();
    old_checkpoint.save(&stale).await.unwrap();
    let (_, stored) = SessionRouterCheckpoint::open(
        directory.path(),
        &session_id,
        "current",
        "Inspect the parser",
        &visible,
        None,
    )
    .await
    .unwrap();
    let stored = stored.unwrap();
    assert_eq!(stored.next_sequence, accepted.next_sequence);
    assert!(!stored.summary.contains("STALE_GENERATION_FACT"));
    assert_eq!(stored.history_coverage, vec!["older", "current"]);
}

#[tokio::test]
async fn replacement_removes_a_superseded_waiting_job_before_it_calls_the_provider() {
    let old_provider = RecordingSummary::new();
    let mut old = context(old_provider.clone());
    let session_id = old.state.session_id.clone();
    let queue = old.factory.summary_queue.clone();
    let work = RouterSummaryWork {
        base_through: 0,
        through: 1,
        omitted_through: 0,
        pending_tokens: 1,
        prompt: "blocker".into(),
    };
    let (_, ticket) = queue.submit_for("blocker", "blocker", work).unwrap();
    let (_, permit) = ticket.start().await.unwrap();
    let old_source = MemoryHistory::new("older", 100);
    old.prepare_history(old_source.clone(), &lineage("older"), &[]);
    tokio::time::timeout(Duration::from_secs(5), async {
        while old_source.calls.lock().unwrap().is_empty() {
            tokio::task::yield_now().await;
        }
    })
    .await
    .unwrap();
    for _ in 0..10 {
        tokio::task::yield_now().await;
    }
    assert_eq!(old_provider.calls.load(Ordering::SeqCst), 0);
    assert_eq!(queue.available_permits(), 0);

    let replacement_provider = RecordingSummary::new();
    let mut replacement = context(replacement_provider.clone());
    replacement.state.session_id = session_id;
    replacement.factory.summary_queue = queue;
    replacement.prepare_history(MemoryHistory::new("older", 30), &lineage("older"), &[]);
    drop(permit);
    wait_done(&replacement).await;
    replacement.poll_history_bootstrap();
    assert!(!replacement.render().history_truncated);
    assert!(replacement_provider.calls.load(Ordering::SeqCst) > 0);
    assert_eq!(old_provider.calls.load(Ordering::SeqCst), 0);
}

#[tokio::test]
async fn explicit_turn_cancellation_releases_summary_admission_and_keeps_durable_resume_progress() {
    let directory = tempfile::tempdir().unwrap();
    let mut provider = RecordingSummary::new();
    Arc::get_mut(&mut provider).unwrap().block_from = Some(2);
    let mut context = context(provider.clone());
    let session_id = context.state.session_id.clone();
    let visible = lineage("older");
    let cancellation = tokio_util::sync::CancellationToken::new();
    context.set_history_cancellation(cancellation.clone());
    context
        .restore_session(Some(directory.path().to_path_buf()), &visible, &[])
        .await;
    context.prepare_history(MemoryHistory::new("older", 220), &visible, &[]);
    wait_calls(&provider, 2).await;
    assert_eq!(context.factory.summary_queue.available_permits(), 0);
    cancellation.cancel();
    wait_done(&context).await;
    assert!(context
        .history_bootstrap
        .as_ref()
        .unwrap()
        .updates
        .borrow()
        .error
        .is_some());
    context.poll_history_bootstrap();
    assert_eq!(context.factory.summary_queue.available_permits(), 1);
    assert!(context.render().history_truncated);
    assert!(context.state.history_bootstrap.is_some());
    assert_eq!(provider.calls.load(Ordering::SeqCst), 2);

    let (_, saved) = SessionRouterCheckpoint::open(
        directory.path(),
        &session_id,
        "current",
        "Inspect the parser",
        &visible,
        None,
    )
    .await
    .unwrap();
    let saved = saved.unwrap();
    let progress = saved.history_bootstrap.unwrap();
    assert!(!progress.complete);
    assert!(progress.entry_cursor > 0 && progress.entry_cursor < 220);
    assert!(!saved.summary.is_empty());
    assert_eq!(saved.omitted_through, 0);
}

#[tokio::test]
async fn normal_short_turn_finalization_does_not_cancel_the_background_history_job() {
    let directory = tempfile::tempdir().unwrap();
    let mut provider = RecordingSummary::new();
    Arc::get_mut(&mut provider).unwrap().block_from = Some(1);
    let mut context = context(provider.clone());
    let session_id = context.state.session_id.clone();
    let visible = lineage("older");
    let cancellation = tokio_util::sync::CancellationToken::new();
    context.set_history_cancellation(cancellation.clone());
    context
        .restore_session(Some(directory.path().to_path_buf()), &visible, &[])
        .await;
    context.prepare_history(MemoryHistory::new("older", 220), &visible, &[]);
    wait_calls(&provider, 1).await;
    let updates = context.history_bootstrap.as_ref().unwrap().updates.clone();
    context.finish(&[]).await;
    assert!(!cancellation.is_cancelled());
    drop(context);
    assert!(!cancellation.is_cancelled());
    provider.release.add_permits(128);
    tokio::time::timeout(Duration::from_secs(5), async {
        while !updates.borrow().done {
            tokio::task::yield_now().await;
        }
    })
    .await
    .unwrap();
    assert!(updates.borrow().error.is_none());
    assert!(
        updates
            .borrow()
            .state
            .history_bootstrap
            .as_ref()
            .unwrap()
            .complete
    );
    let (_, saved) = SessionRouterCheckpoint::open(
        directory.path(),
        &session_id,
        "current",
        "Inspect the parser",
        &visible,
        None,
    )
    .await
    .unwrap();
    let saved = saved.unwrap();
    assert!(saved.history_bootstrap.unwrap().complete);
    assert!(!saved.summary.is_empty());
    assert_eq!(saved.omitted_through, 0);
    assert_eq!(saved.entries.len(), 3);
}

#[tokio::test]
async fn same_turn_recovery_replays_active_tool_results_and_steering_beside_historical_backfill() {
    let directory = tempfile::tempdir().unwrap();
    let mut provider = RecordingSummary::new();
    Arc::get_mut(&mut provider).unwrap().block_from = Some(1);
    let mut original = context(provider.clone());
    let session_id = original.state.session_id.clone();
    let visible = lineage("older");
    let messages = vec![
        Message::assistant("HISTORICAL_ALREADY_CLAIMED".into()).with_turn_id("older".into()),
        Message::user("PRIVATE_MAIN_COMPACTION".into())
            .with_semantic_kind(MessageSemanticKind::CompressionSummary),
        Message::user("Inspect the parser".into()).with_turn_id("current".into()),
        Message::assistant_with_tools(
            "CURRENT_TURN_ASSISTANT_FINDING".into(),
            vec![ToolCall {
                tool_id: "active-tool".into(),
                tool_name: "ExecCommand".into(),
                arguments: json!({"cmd": "cargo test parser"}),
                ..Default::default()
            }],
        )
        .with_turn_id("current".into()),
        Message::tool_result(ToolResult {
            tool_id: "active-tool".into(),
            tool_name: "ExecCommand".into(),
            result: json!({"exit_code": 1, "raw_only": "PRIVATE_ACTIVE_RAW_RESULT"}),
            result_for_assistant: Some("CURRENT_TOOL_FAILURE: expected 2, got 1".into()),
            is_error: true,
            effective_tool_name: None,
            duration_ms: None,
            image_attachments: None,
        })
        .with_turn_id("current".into()),
        Message::internal_reminder(
            InternalReminderKind::UserSteering,
            "CURRENT_STEERING_ONLY_INSPECT",
        )
        .with_turn_id("current".into()),
        Message::assistant("UNKNOWN_TURN_FINDING_MUST_SURVIVE".into()),
    ];
    let before = serde_json::to_value(&messages).unwrap();
    original
        .restore_session(Some(directory.path().to_path_buf()), &visible, &messages)
        .await;
    original.state.next_sequence = 169;
    original.state.omitted_through = 40;
    original
        .state
        .seen_message_ids
        .extend(messages.iter().map(|message| message.id.clone()));
    original
        .session_checkpoint
        .as_ref()
        .unwrap()
        .save(&original.state)
        .await
        .unwrap();
    drop(original);

    let mut recovered = context(provider.clone());
    recovered.state.session_id = session_id;
    recovered
        .restore_session(Some(directory.path().to_path_buf()), &visible, &messages)
        .await;
    assert_eq!(recovered.state.omitted_through, 40);
    recovered.prepare_history(MemoryHistory::new("older", 100), &visible, &messages);
    wait_calls(&provider, 1).await;
    let pending = recovered.prepare(&messages).await;
    assert!(pending.history_truncated);
    provider.release.add_permits(128);
    wait_done(&recovered).await;
    recovered.poll_history_bootstrap();
    let ready = recovered.render();
    assert!(!ready.history_truncated);
    for fact in [
        "CURRENT_TURN_ASSISTANT_FINDING",
        "CURRENT_TOOL_FAILURE",
        "CURRENT_STEERING_ONLY_INSPECT",
        "UNKNOWN_TURN_FINDING_MUST_SURVIVE",
        "active-tool",
    ] {
        assert!(ready.user_prompt.contains(fact), "missing {fact}");
    }
    for excluded in [
        "HISTORICAL_ALREADY_CLAIMED",
        "PRIVATE_MAIN_COMPACTION",
        "PRIVATE_ACTIVE_RAW_RESULT",
    ] {
        assert!(!ready.user_prompt.contains(excluded));
    }
    let active_rounds = recovered
        .state
        .entries
        .iter()
        .filter(|entry| entry.source_id == messages[3].id)
        .collect::<Vec<_>>();
    assert_eq!(active_rounds.len(), 1);
    assert_eq!(
        active_rounds[0].content["tool_results"]
            .as_array()
            .unwrap()
            .len(),
        1
    );
    assert_eq!(
        active_rounds[0].content["tool_results"][0]["tool_id"],
        "active-tool"
    );
    assert_eq!(
        recovered
            .state
            .entries
            .iter()
            .filter(|entry| entry.source_id == messages[5].id)
            .count(),
        1
    );
    assert_eq!(
        recovered
            .state
            .entries
            .iter()
            .filter(|entry| entry.source_id == messages[6].id)
            .count(),
        1
    );
    let sequence = recovered.state.next_sequence;
    recovered.observe(&messages);
    assert_eq!(recovered.state.next_sequence, sequence);
    assert_eq!(serde_json::to_value(&messages).unwrap(), before);
}
