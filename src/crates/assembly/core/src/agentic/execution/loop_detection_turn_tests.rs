//! Engine-level tests for the loop-detection mounting points.
//!
//! These tests drive the production round-boundary entry point
//! ([`ExecutionEngine::drive_loop_detection`], the function the dialog turn loop
//! calls right after a round completes) with **real** rounds: the scripted
//! provider fixture in `round_executor::tests` serves a model round through the
//! real stream processor, so the detector sees the same `RoundResult` shape a
//! live turn produces. The session manager, the context store, and the event
//! queue are real too, which is what makes the persistence and product-event
//! assertions below meaningful.
//!
//! What is covered end to end:
//!
//! * `Enforce` steers a repeating round: the reminder lands in the round's
//!   `messages`, is persisted through the session manager, produces exactly one
//!   `LoopDetectionNoted` per decision, and keeps the turn alive.
//! * After three unheeded steers the ladder hands the turn a hard stop carrying
//!   [`LOOP_DETECTED_FINALIZATION_REASON`], and the production turn-effect
//!   mapping turns that into the finalization reason the completion report uses.
//! * `Telemetry` reports without injecting; `Off` and the session escape hatch
//!   never feed the detectors at all.
//! * The thinking source (`feed_block`) and the usage sample (`feed_usage`) are
//!   fed from the same round boundary, so a reasoning loop steers with
//!   `ThinkingLoopRecovery` instead of `OutputLoopRecovery`.
//!
//! The dialog turn loop itself is not driven here: `execute_dialog_turn` needs
//! the process-global AI client factory, config service, agent registry, and
//! tool manager, which a unit-level test cannot install. The two decisions the
//! loop takes from a loop-detection result (`LoopTurnEffect`, the finalize
//! reminder, and the completed-event success flag) are extracted into production
//! helpers and asserted directly, so no part of the decision chain is left to
//! source inspection alone.

use super::{
    ExecutionContext, ExecutionEngine, ExecutionEngineConfig, LoopDetectionSettings,
    LoopRoundDecision, LoopTurnEffect,
};
use crate::agentic::context_profile::{ContextProfilePolicy, ModelCapabilityProfile};
use crate::agentic::core::{InternalReminderKind, Message, MessageContent, SessionConfig};
use crate::agentic::events::{AgenticEvent, EventQueue, EventQueueConfig, LoopDetectionEscalation};
use crate::agentic::execution::loop_detection::{
    round_text_and_reasoning, visible_completion_tokens, LoopHealthFields, LoopInterventionLadder,
    LoopUsageSample, LOOP_DETECTED_FINALIZATION_REASON, MAX_LOOP_RECOVERY_ATTEMPTS,
};
use crate::agentic::execution::round_executor::tests::{
    test_round_context, test_round_executor, RetryTestServer,
};
use crate::agentic::execution::RoundExecutor;
use crate::agentic::persistence::PersistenceManager;
use crate::agentic::session::{
    ContextCompressor, SessionContextStore, SessionManager, SessionManagerConfig,
};
use crate::util::types::Message as AIMessage;
use openbitfun_config_contracts::LoopDetectionMode;
use openbitfun_runtime_ports::DelegationPolicy;
use serde_json::json;
use std::collections::HashMap;
use std::sync::Arc;

/// One repeated sentence. It carries no connector-phrase run, no counter series,
/// and no markdown structure, so the repetition it produces is an exact-block
/// loop and nothing else.
const REPEATED_LINE: &str = "The reviewer walks the same staged pipeline again and confirms every recorded step matches the earlier note about the failing call.";
/// Enough repetitions to clear every tier-scaled `verbatim_min_occurrences`.
const REPEATED_LINE_COUNT: usize = 12;
/// Visible text of the reasoning-loop fixture, short enough to stay below the
/// detector's `min_analyzed_chars` window so only the thinking signal can fire.
const SHORT_VISIBLE_TEXT: &str = "Working on it.";
/// One repeated reasoning block, above `thinking_min_block_chars`.
const REPEATED_REASONING: &str = "I keep re-reading the same region of the trace and re-deriving the same conclusion about the staged pipeline, so the next step is to stop reasoning and act on what I already know.";

fn repeated_output_round() -> (u16, String) {
    let text = std::iter::repeat(REPEATED_LINE)
        .take(REPEATED_LINE_COUNT)
        .collect::<Vec<_>>()
        .join("\n");
    scripted_round(&text, None)
}

fn repeated_reasoning_round() -> (u16, String) {
    scripted_round(SHORT_VISIBLE_TEXT, Some(REPEATED_REASONING))
}

/// One OpenAI-format SSE round: a single content/reasoning chunk that also
/// carries `finish_reason` and `usage`, exactly like the provider fixtures the
/// round executor tests already use.
fn scripted_round(text: &str, reasoning: Option<&str>) -> (u16, String) {
    let mut delta = serde_json::Map::new();
    delta.insert("content".to_string(), json!(text));
    if let Some(reasoning) = reasoning {
        delta.insert("reasoning_content".to_string(), json!(reasoning));
    }
    let body = json!({
        "id": "loop-detection-test",
        "object": "chat.completion.chunk",
        "created": 1,
        "model": "retry-test-model",
        "choices": [{"index": 0, "delta": delta, "finish_reason": "stop"}],
        "usage": {"prompt_tokens": 24, "completion_tokens": 96, "total_tokens": 120}
    });
    (200, format!("data: {body}\n\ndata: [DONE]\n\n"))
}

/// A `LoopDetectionNoted` product event, as the engine emitted it.
#[derive(Debug, Clone, PartialEq)]
struct Notice {
    kind: String,
    confidence: f32,
    escalation: LoopDetectionEscalation,
    judge_arbitrated: bool,
}

/// What one observed round produced.
struct RoundTrace {
    /// User-visible assistant text of the round the detector analyzed.
    text: String,
    /// The usage sample the ladder was given for this round.
    usage: Option<LoopUsageSample>,
    /// The loop-detection decision the engine returned for this round.
    decision: LoopRoundDecision,
    /// Ladder telemetry after the round.
    health: LoopHealthFields,
}

impl RoundTrace {
    fn turn_effect(&self) -> LoopTurnEffect {
        self.decision.turn_effect()
    }
}

/// One scripted turn: a real engine, a real session, and a provider that always
/// answers with the same round.
struct TurnHarness {
    engine: ExecutionEngine,
    executor: Arc<RoundExecutor>,
    server: RetryTestServer,
    session_id: String,
    turn_id: String,
    context: ExecutionContext,
    ladder: LoopInterventionLadder,
    messages: Vec<Message>,
    notices: Vec<Notice>,
    store: Arc<SessionContextStore>,
    _temp: tempfile::TempDir,
}

impl TurnHarness {
    async fn start(mode: LoopDetectionMode, reply: (u16, String)) -> Self {
        let temp = tempfile::Builder::new()
            .prefix("loop-detection-turn-")
            .tempdir()
            .unwrap();
        // Sessions only exist inside registered workspaces.
        crate::service::workspace::legacy_compat::register_local_fixture_blocking(temp.path());
        let store = Arc::new(SessionContextStore::new());
        let manager = SessionManager::new(
            store.clone(),
            Arc::new(
                PersistenceManager::new(Arc::new(
                    crate::infrastructure::PathManager::with_user_root_for_tests(
                        temp.path().into(),
                    ),
                ))
                .unwrap(),
            ),
            SessionManagerConfig {
                enable_persistence: false,
                ..Default::default()
            },
        );
        let executor = Arc::new(test_round_executor());
        let engine = ExecutionEngine::new(
            executor.clone(),
            Arc::new(EventQueue::new(EventQueueConfig::default())),
            Arc::new(manager),
            Arc::new(ContextCompressor::new()),
            ExecutionEngineConfig {
                loop_detection: LoopDetectionSettings {
                    mode,
                    ..Default::default()
                },
                ..Default::default()
            },
        );
        let session = engine
            .session_manager
            .create_session(
                "loop detection turn".to_string(),
                "Standard".to_string(),
                SessionConfig {
                    workspace_path: Some(temp.path().to_string_lossy().into_owned()),
                    ..Default::default()
                },
            )
            .await
            .unwrap();
        let context = execution_context(&session.session_id, "turn-1");
        // The ladder comes from the same production helper the dialog turn uses.
        let ladder =
            engine.loop_ladder_for_turn(&context.session_id, &context_profile_policy("Standard"));
        Self {
            engine,
            executor,
            server: RetryTestServer::new(vec![reply]),
            session_id: session.session_id,
            turn_id: context.dialog_turn_id.clone(),
            context,
            ladder,
            messages: vec![Message::user("Keep working on the task".to_string())],
            notices: Vec::new(),
            store,
            _temp: temp,
        }
    }

    /// Runs one scripted model round and observes it through the production
    /// round-boundary entry point.
    async fn run_round(&mut self, round_index: usize) -> RoundTrace {
        let mut round_context = test_round_context();
        round_context.session_id = self.session_id.clone();
        round_context.dialog_turn_id = self.turn_id.clone();
        round_context.round_number = round_index;
        round_context.model_config_id = "retry-test-model".to_string();
        round_context.effective_model_name = "retry-test-model".to_string();
        let round_result = tokio::time::timeout(
            std::time::Duration::from_secs(10),
            self.executor.execute_round(
                self.server.client(),
                round_context,
                vec![AIMessage::user("Continue".to_string())],
                None,
                None,
            ),
        )
        .await
        .expect("scripted round must not hang")
        .expect("scripted round must succeed");

        let (text, _) = round_text_and_reasoning(&round_result.assistant_message);
        let usage = round_result.usage.as_ref().map(|usage| {
            LoopUsageSample::new(
                u64::from(usage.reasoning_token_count.unwrap_or(0)),
                visible_completion_tokens(
                    usage.candidates_token_count,
                    usage.reasoning_token_count,
                ),
            )
        });

        let decision = self
            .engine
            .drive_loop_detection(
                &self.context,
                &mut self.messages,
                &mut self.ladder,
                &round_result,
                round_index,
                "retry-test-model",
            )
            .await;
        self.notices
            .extend(drain_notices(&self.engine, &self.session_id, &self.turn_id).await);
        RoundTrace {
            text: text.unwrap_or_default().to_string(),
            usage,
            decision,
            health: self.ladder.health_fields(),
        }
    }

    /// Loop-detection reminders currently in the round's message list.
    fn loop_reminders(&self) -> Vec<&Message> {
        self.messages
            .iter()
            .filter(|message| message.metadata.internal_reminder_kind.is_some())
            .collect()
    }

    /// Messages the session manager holds for this session.
    fn persisted_messages(&self) -> Vec<Message> {
        self.store.get_context_messages(&self.session_id)
    }
}

fn execution_context(session_id: &str, turn_id: &str) -> ExecutionContext {
    ExecutionContext {
        session_id: session_id.to_string(),
        dialog_turn_id: turn_id.to_string(),
        turn_index: 0,
        agent_type: "Standard".to_string(),
        workspace: None,
        context: HashMap::new(),
        subagent_parent_info: None,
        permission_delegation: None,
        permission_runtime_ceiling: None,
        delegation_policy: DelegationPolicy::top_level(),
        runtime_tool_restrictions: Default::default(),
        workspace_services: None,
        terminal_port: None,
        remote_exec_port: None,
        round_injection: None,
        emit_lifecycle_events: false,
        recover_partial_on_cancel: false,
    }
}

fn context_profile_policy(agent_type: &str) -> ContextProfilePolicy {
    ContextProfilePolicy::for_agent_context(
        agent_type,
        false,
        ModelCapabilityProfile::from_resolved_model("retry-test-model", "retry-test-model"),
    )
}

/// Drains the engine's event queue and keeps the loop-detection notices.
///
/// Every notice must be scoped to the session and turn that produced it, which
/// is how a product surface keys the signal.
async fn drain_notices(engine: &ExecutionEngine, session_id: &str, turn_id: &str) -> Vec<Notice> {
    engine
        .event_queue
        .dequeue_batch(64)
        .await
        .into_iter()
        .filter_map(|queued| match queued.event {
            AgenticEvent::LoopDetectionNoted {
                session_id: event_session_id,
                turn_id: event_turn_id,
                kind,
                confidence,
                escalation,
                judge_arbitrated,
            } => {
                assert_eq!(event_session_id, session_id);
                assert_eq!(event_turn_id, turn_id);
                Some(Notice {
                    kind,
                    confidence,
                    escalation,
                    judge_arbitrated,
                })
            }
            _ => None,
        })
        .collect()
}

fn reminder_text(message: &Message) -> &str {
    match &message.content {
        MessageContent::Text(text) => text,
        other => panic!("a loop reminder is a plain user message, got {other:?}"),
    }
}

// ---------------------------------------------------------------------------
// Enforce: the L1 steer and the L2 hard fallback
// ---------------------------------------------------------------------------

#[tokio::test]
async fn enforce_mode_steers_a_repeating_round_then_hard_stops_the_turn() {
    let mut harness = TurnHarness::start(LoopDetectionMode::Enforce, repeated_output_round()).await;

    let mut traces = Vec::new();
    let mut steered_rounds = 0usize;
    let mut finalization_reason = None;
    for round_index in 0..(MAX_LOOP_RECOVERY_ATTEMPTS + 4) {
        let trace = harness.run_round(round_index).await;
        match trace.turn_effect() {
            LoopTurnEffect::Continue => {}
            LoopTurnEffect::Steered => steered_rounds += 1,
            LoopTurnEffect::Finalize(reason) => {
                finalization_reason = Some(reason);
                traces.push(trace);
                break;
            }
        }
        traces.push(trace);
    }

    // The scripted rounds really produced the repeated output the detector read.
    assert!(
        traces[0].text.contains(REPEATED_LINE),
        "the scripted round must carry the repeated corpus"
    );
    assert!(traces[0].usage.is_some(), "the round reports usage");

    // L1: three steers, then the hard fallback on the fourth persisting round.
    assert_eq!(steered_rounds, MAX_LOOP_RECOVERY_ATTEMPTS);
    assert_eq!(
        finalization_reason,
        Some(LOOP_DETECTED_FINALIZATION_REASON),
        "the turn must end with the loop-detection finalization reason"
    );
    assert_eq!(traces.len(), MAX_LOOP_RECOVERY_ATTEMPTS + 1);

    let first = &traces[0];
    assert_eq!(first.health.signal_source, Some("output"));
    assert_eq!(first.health.verdict_kind, Some("verbatim_block"));
    assert_eq!(first.health.steer_attempts, 1);
    assert_eq!(first.turn_effect(), LoopTurnEffect::Steered);

    let last = traces.last().unwrap();
    assert_eq!(last.health.escalation.as_str(), "hard_stop");
    assert_eq!(last.health.steer_attempts, MAX_LOOP_RECOVERY_ATTEMPTS);
    assert_eq!(
        last.turn_effect(),
        LoopTurnEffect::Finalize(LOOP_DETECTED_FINALIZATION_REASON)
    );
    assert_eq!(last.health.verdict_count, traces.len());

    // One product event per decision, never one per detector candidate.
    assert_eq!(harness.notices.len(), traces.len());
    for (notice, trace) in harness.notices.iter().zip(traces.iter()) {
        assert_eq!(notice.kind, "verbatim_block");
        assert!(notice.confidence >= 0.9, "confidence {}", notice.confidence);
        // No arbiter is installed here, so no judge verdict backs the decision.
        assert!(!notice.judge_arbitrated);
        let expected = if matches!(trace.turn_effect(), LoopTurnEffect::Finalize(_)) {
            LoopDetectionEscalation::Stopped
        } else {
            LoopDetectionEscalation::Steered
        };
        assert_eq!(notice.escalation, expected);
    }

    // The L1 reminder lands in the round's messages exactly once per steer, is
    // turn-scoped, and never echoes the passage it is steering away from.
    let reminders = harness.loop_reminders();
    assert_eq!(reminders.len(), MAX_LOOP_RECOVERY_ATTEMPTS);
    for reminder in &reminders {
        assert_eq!(
            reminder.metadata.internal_reminder_kind,
            Some(InternalReminderKind::OutputLoopRecovery)
        );
        assert_eq!(reminder.metadata.turn_id.as_deref(), Some("turn-1"));
        let text = reminder_text(reminder);
        assert!(
            text.contains("<system_reminder>") && text.contains("Repeated output loop detected"),
            "unexpected reminder text: {text}"
        );
        assert!(
            text.contains("signal=verbatim_block"),
            "the reminder cites the signal: {text}"
        );
        let excerpt: String = REPEATED_LINE.chars().take(40).collect();
        assert!(
            !text.contains(&excerpt),
            "the DITTO guard forbids echoing the repeated text: {text}"
        );
    }
    // Every steer produces its own distinct reminder message.
    let distinct_ids: std::collections::HashSet<&String> =
        reminders.iter().map(|message| &message.id).collect();
    assert_eq!(distinct_ids.len(), MAX_LOOP_RECOVERY_ATTEMPTS);

    // Durability: the same reminders are in the session transcript, in order.
    let transcript = harness.persisted_messages();
    let persisted: Vec<&Message> = transcript
        .iter()
        .filter(|message| {
            matches!(
                message.metadata.internal_reminder_kind,
                Some(InternalReminderKind::OutputLoopRecovery)
            )
        })
        .collect();
    assert_eq!(persisted.len(), MAX_LOOP_RECOVERY_ATTEMPTS);
    let persisted_ids: Vec<&String> = persisted.iter().map(|message| &message.id).collect();
    let reminder_ids: Vec<&String> = reminders.iter().map(|message| &message.id).collect();
    assert_eq!(persisted_ids, reminder_ids);
    for message in &persisted {
        assert_eq!(message.metadata.turn_id.as_deref(), Some("turn-1"));
        assert_eq!(message.role, crate::agentic::core::MessageRole::User);
    }

    // The generation-message record the engine keeps for the transcript replay.
    let generation_messages = harness
        .engine
        .generation_messages
        .get(&(harness.session_id.clone(), harness.turn_id.clone()))
        .map(|entry| (*entry).clone())
        .unwrap_or_default();
    for message in &reminders {
        assert!(
            generation_messages
                .iter()
                .any(|recorded| recorded.id == message.id),
            "the reminder must be recorded as a generation message"
        );
    }
}

#[tokio::test]
async fn a_steer_keeps_the_turn_alive_instead_of_finalizing_it() {
    let mut harness = TurnHarness::start(LoopDetectionMode::Enforce, repeated_output_round()).await;

    // A single round is enough: the decision itself says "continue".
    let trace = harness.run_round(0).await;

    assert_eq!(trace.turn_effect(), LoopTurnEffect::Steered);
    assert!(trace.decision.hard_stop_reason.is_none());
    assert_eq!(harness.loop_reminders().len(), 1);
    assert_eq!(harness.notices.len(), 1);
    assert_eq!(
        harness.notices[0].escalation,
        LoopDetectionEscalation::Steered
    );

    // The reminder is durable at the first steer already: it is in the round's
    // messages and in the session transcript, so the record survives the turn.
    let reminder_id = harness.loop_reminders()[0].id.clone();
    let persisted = harness.persisted_messages();
    assert!(
        persisted
            .iter()
            .any(|message| message.id == reminder_id
                && message.metadata.internal_reminder_kind
                    == Some(InternalReminderKind::OutputLoopRecovery)),
        "the steer reminder must be persisted with its kind"
    );
}

#[tokio::test]
async fn a_thinking_loop_steers_with_the_thinking_reminder() {
    let mut harness =
        TurnHarness::start(LoopDetectionMode::Enforce, repeated_reasoning_round()).await;

    let mut straight_line_steers = 0usize;
    let mut finalization_reason = None;
    let mut first_steer = None;
    for round_index in 0..12 {
        let trace = harness.run_round(round_index).await;
        match trace.turn_effect() {
            LoopTurnEffect::Continue => {}
            LoopTurnEffect::Steered => {
                straight_line_steers += 1;
                if first_steer.is_none() {
                    first_steer = Some(trace.health);
                }
            }
            LoopTurnEffect::Finalize(reason) => {
                finalization_reason = Some(reason);
                break;
            }
        }
    }

    let first_steer = first_steer.expect("a repeated reasoning block must steer");
    assert_eq!(first_steer.signal_source, Some("thinking"));
    assert_eq!(first_steer.verdict_kind, Some("thinking_stagnation"));
    assert_eq!(
        straight_line_steers, MAX_LOOP_RECOVERY_ATTEMPTS,
        "the thinking signal is capped like every other steer-eligible kind"
    );
    assert_eq!(finalization_reason, Some(LOOP_DETECTED_FINALIZATION_REASON));

    let reminders = harness.loop_reminders();
    assert_eq!(reminders.len(), MAX_LOOP_RECOVERY_ATTEMPTS);
    for reminder in &reminders {
        assert_eq!(
            reminder.metadata.internal_reminder_kind,
            Some(InternalReminderKind::ThinkingLoopRecovery)
        );
        let text = reminder_text(reminder);
        assert!(
            text.contains("Internal reasoning loop detected"),
            "unexpected reminder text: {text}"
        );
        let excerpt: String = REPEATED_REASONING.chars().take(40).collect();
        assert!(
            !text.contains(&excerpt),
            "reasoning text must not be echoed"
        );
    }
    // The visible text of these rounds is short, so no output verdict was mixed in.
    assert!(harness
        .notices
        .iter()
        .all(|notice| notice.kind == "thinking_stagnation"));
}

// ---------------------------------------------------------------------------
// Telemetry and Off
// ---------------------------------------------------------------------------

#[tokio::test]
async fn telemetry_mode_reports_verdicts_without_injecting() {
    let mut harness =
        TurnHarness::start(LoopDetectionMode::Telemetry, repeated_output_round()).await;
    let before = harness.messages.len();

    for round_index in 0..4 {
        let trace = harness.run_round(round_index).await;
        assert_eq!(trace.turn_effect(), LoopTurnEffect::Continue);
        assert_eq!(trace.health.escalation.as_str(), "telemetry");
        assert_eq!(trace.health.verdict_kind, Some("verbatim_block"));
        assert_eq!(trace.health.steer_attempts, 0);
    }

    // Calibration observes: one notice per round, no message, no persistence.
    assert_eq!(harness.notices.len(), 4);
    for notice in &harness.notices {
        assert_eq!(notice.escalation, LoopDetectionEscalation::Noted);
        assert_eq!(notice.kind, "verbatim_block");
        assert!(!notice.judge_arbitrated);
    }
    assert_eq!(harness.messages.len(), before);
    assert!(harness.loop_reminders().is_empty());
    assert!(harness.persisted_messages().is_empty());
}

#[tokio::test]
async fn off_mode_never_feeds_the_detectors() {
    let mut harness = TurnHarness::start(LoopDetectionMode::Off, repeated_output_round()).await;
    assert!(!harness.engine.loop_detection_active(&harness.session_id));
    let before = harness.messages.len();

    for round_index in 0..4 {
        let trace = harness.run_round(round_index).await;
        assert_eq!(trace.turn_effect(), LoopTurnEffect::Continue);
        assert_eq!(trace.health, LoopHealthFields::default());
    }

    assert!(harness.notices.is_empty());
    assert_eq!(harness.messages.len(), before);
    assert!(harness.persisted_messages().is_empty());
}

#[tokio::test]
async fn the_session_escape_hatch_clears_and_restarts_detection_within_the_turn() {
    let mut harness = TurnHarness::start(LoopDetectionMode::Enforce, repeated_output_round()).await;

    let first = harness.run_round(0).await;
    assert_eq!(first.turn_effect(), LoopTurnEffect::Steered);
    assert_eq!(harness.loop_reminders().len(), 1);

    // Mid-turn clear: the very next round observes nothing and drops the state.
    harness
        .engine
        .set_session_loop_detection_enabled(&harness.session_id, false);
    assert!(!harness.engine.loop_detection_active(&harness.session_id));
    let cleared = harness.run_round(1).await;
    assert_eq!(cleared.turn_effect(), LoopTurnEffect::Continue);
    assert_eq!(cleared.health, LoopHealthFields::default());
    assert_eq!(harness.loop_reminders().len(), 1);
    assert_eq!(harness.notices.len(), 1);

    // Re-enabling starts from fresh evidence: the same loop steers again as
    // attempt one, because the escape hatch also cleared the counters.
    harness
        .engine
        .set_session_loop_detection_enabled(&harness.session_id, true);
    let resumed = harness.run_round(2).await;
    assert_eq!(resumed.turn_effect(), LoopTurnEffect::Steered);
    assert_eq!(resumed.health.steer_attempts, 1);
    assert_eq!(harness.loop_reminders().len(), 2);
    assert_eq!(harness.notices.len(), 2);
}

// ---------------------------------------------------------------------------
// Turn-level decision mapping
// ---------------------------------------------------------------------------

#[test]
fn loop_detection_decisions_map_to_the_turn_effect() {
    let continue_decision = LoopRoundDecision::default();
    assert_eq!(continue_decision.turn_effect(), LoopTurnEffect::Continue);

    let steered = LoopRoundDecision {
        steered: true,
        hard_stop_reason: None,
    };
    assert_eq!(steered.turn_effect(), LoopTurnEffect::Steered);

    let stopped = LoopRoundDecision {
        steered: false,
        hard_stop_reason: Some(LOOP_DETECTED_FINALIZATION_REASON),
    };
    assert_eq!(
        stopped.turn_effect(),
        LoopTurnEffect::Finalize(LOOP_DETECTED_FINALIZATION_REASON)
    );
    // A hard stop never claims to have steered: the turn ends instead.
    assert!(!matches!(stopped.turn_effect(), LoopTurnEffect::Steered));
}

#[test]
fn a_loop_detected_turn_asks_for_a_final_answer_and_reports_success() {
    let reminder = ExecutionEngine::finalize_reminder_for(LOOP_DETECTED_FINALIZATION_REASON)
        .expect("a loop-detected turn must ask for a closing answer");
    assert!(reminder.contains("repeating itself"));
    assert!(ExecutionEngine::finalize_reminder_for("empty_round").is_none());

    // The loop-detected turn ends without a final response but is still reported
    // as a completed turn, so the surface can explain the termination inline.
    assert!(ExecutionEngine::turn_success(
        false,
        LOOP_DETECTED_FINALIZATION_REASON
    ));
    assert!(!ExecutionEngine::turn_success(false, "empty_round"));
    assert!(!ExecutionEngine::turn_success(false, "partial_truncated"));
    assert!(ExecutionEngine::turn_success(true, "complete"));
}
