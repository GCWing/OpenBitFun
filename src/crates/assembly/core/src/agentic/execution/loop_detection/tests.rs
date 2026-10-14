//! Focused tests for the product-side loop-detection wiring.
//!
//! The detectors have their own corpus tests in `openbitfun-agent-stream`; these
//! tests cover what this module adds on top: the tier/override translation, the
//! asymmetric escalation policy, the arbitration handshake, the session escape
//! hatch, and the reminder copy.

use super::arbiter::{ArbiterDecision, NoArbiter};
use super::health::LoopEscalationLevel;
use super::ladder::{
    render_loop_steer_text, round_text_and_reasoning, visible_completion_tokens,
    LoopInterventionLadder, LoopLadderAction, LoopLadderSettings, LoopObservedVerdict,
    LoopRoundObservation, LoopSignalSource, LoopUsageSample, LOOP_DETECTED_FINALIZATION_REASON,
    MAX_LOOP_RECOVERY_ATTEMPTS,
};
use super::policy::{
    judge_confidence_min, loop_detector_config, structure_exclusions_enabled,
    DEFAULT_JUDGE_VERDICT_CONFIDENCE_MIN,
};
use super::runtime::LoopDetectionRuntime;
use crate::agentic::core::{InternalReminderKind, Message};
use openbitfun_agent_runtime::context_profile::{
    ContextProfilePolicy, LoopDetectionPolicy, ModelCapabilityProfile, StructuralExclusionKind,
};
use openbitfun_agent_stream::{LoopDetectorConfig, LoopEvidence, LoopKind, LoopVerdict};
use openbitfun_config_contracts::{
    LoopDetectionMode, LoopDetectionThresholdOverridesConfig,
    DEFAULT_LOOP_DETECTION_MAX_VERDICTS_PER_TURN,
};

const REPEATED_PASSAGE: &str =
    "the same normalized paragraph repeats here without any new information ";

fn long_task_standard_policy() -> ContextProfilePolicy {
    ContextProfilePolicy::for_agent_context("Standard", false, ModelCapabilityProfile::Standard)
}

fn conversation_weak_policy() -> ContextProfilePolicy {
    // "Chat" is deliberately outside the long-task agent set.
    ContextProfilePolicy::for_agent_context("Chat", false, ModelCapabilityProfile::Weak)
}

fn settings(mode: LoopDetectionMode) -> LoopLadderSettings {
    LoopLadderSettings {
        mode,
        session_enabled: true,
        detector_config: LoopDetectorConfig::default(),
        judge_enabled: true,
        max_arbitration_requests_per_turn: DEFAULT_LOOP_DETECTION_MAX_VERDICTS_PER_TURN,
        judge_confidence_min: DEFAULT_JUDGE_VERDICT_CONFIDENCE_MIN,
    }
}

/// A confirmation at a confidence the configured gate accepts.
fn confident_judge() -> ArbiterDecision {
    ArbiterDecision::Confirmed {
        confidence: Some(0.95),
    }
}

fn observed(
    source: LoopSignalSource,
    kind: LoopKind,
    confidence: f32,
    requires_arbitration: bool,
) -> LoopObservedVerdict {
    LoopObservedVerdict {
        source,
        verdict: LoopVerdict {
            kind,
            confidence,
            evidence: LoopEvidence {
                occurrences: 4,
                consecutive_repeats: 3,
                requires_arbitration,
                ..Default::default()
            },
        },
    }
}

fn output_verdict(kind: LoopKind, confidence: f32) -> LoopObservedVerdict {
    observed(LoopSignalSource::Output, kind, confidence, false)
}

fn thinking_verdict(
    kind: LoopKind,
    confidence: f32,
    requires_arbitration: bool,
) -> LoopObservedVerdict {
    observed(
        LoopSignalSource::Thinking,
        kind,
        confidence,
        requires_arbitration,
    )
}

fn steered_kind(action: &LoopLadderAction) -> Option<InternalReminderKind> {
    match action {
        LoopLadderAction::Steer(steer) => Some(steer.reminder_kind),
        _ => None,
    }
}

// ------------------------------ policy translation ------------------------------

#[test]
fn calibrated_tier_keeps_detector_baselines() {
    let policy = long_task_standard_policy();
    assert_eq!(policy.loop_detection.threshold_scale, 1.0);

    let config = loop_detector_config(&policy, &LoopDetectionThresholdOverridesConfig::default());

    assert_eq!(config, LoopDetectorConfig::default());
}

#[test]
fn conservative_tiers_ask_for_more_evidence() {
    let long_task = loop_detector_config(
        &long_task_standard_policy(),
        &LoopDetectionThresholdOverridesConfig::default(),
    );
    let weak = loop_detector_config(
        &conversation_weak_policy(),
        &LoopDetectionThresholdOverridesConfig::default(),
    );

    assert!(weak.verbatim_min_occurrences > long_task.verbatim_min_occurrences);
    assert!(weak.thinking_stagnation_pairs > long_task.thinking_stagnation_pairs);
    assert!(weak.phrase_stuck_min_consecutive > long_task.phrase_stuck_min_consecutive);
    assert!(
        weak.near_repetition_jaccard > long_task.near_repetition_jaccard,
        "a conservative tier must demand a closer match"
    );
    assert!(weak.thinking_adjacent_similarity > long_task.thinking_adjacent_similarity);
    assert!(weak.compression_min_redundancy > long_task.compression_min_redundancy);
}

#[test]
fn tier_scaled_similarity_stays_inside_the_ratio_domain() {
    // The tier scale shrinks the tolerance instead of multiplying the ratio:
    // 0.85 * 1.5 would leave the domain and silently mute the signal.
    let weak = loop_detector_config(
        &conversation_weak_policy(),
        &LoopDetectionThresholdOverridesConfig::default(),
    );

    assert!(
        weak.near_repetition_jaccard > 0.85 && weak.near_repetition_jaccard < 1.0,
        "expected a strictly tighter, still reachable ratio, got {}",
        weak.near_repetition_jaccard
    );
    assert!(
        weak.near_repetition_strong_jaccard >= weak.near_repetition_jaccard,
        "the strong band must not sit below the suspicious band"
    );
    assert!(weak.near_repetition_strong_jaccard < 1.0);
}

#[test]
fn explicit_overrides_win_over_the_tier() {
    let overrides = LoopDetectionThresholdOverridesConfig {
        exact_block_hash_chars: Some(80),
        exact_block_min_occurrences: Some(7),
        ngram_window_similarity_min: Some(0.6),
        thinking_stall_steps: Some(5),
        stuck_phrase_min_repeats: Some(12),
        window_compression_ratio_min: Some(0.4),
        reasoning_bypass_min_tokens_per_sec: Some(900),
        reasoning_bypass_min_rounds: Some(4),
        ..Default::default()
    };

    let config = loop_detector_config(&conversation_weak_policy(), &overrides);

    assert_eq!(config.block_chars, 80);
    assert_eq!(config.verbatim_min_occurrences, 7);
    assert_eq!(config.near_repetition_jaccard, 0.6);
    assert_eq!(config.thinking_stagnation_pairs, 5);
    assert_eq!(config.phrase_stuck_min_consecutive, 12);
    assert_eq!(config.compression_min_redundancy, 0.4);
    assert_eq!(config.reasoning_runaway_min_tokens, 900);
    assert_eq!(config.reasoning_runaway_consecutive_samples, 4);
}

#[test]
fn non_positive_overrides_count_as_unset() {
    let overrides = LoopDetectionThresholdOverridesConfig {
        exact_block_min_occurrences: Some(0),
        ngram_window_similarity_min: Some(0.0),
        ..Default::default()
    };

    let config = loop_detector_config(&long_task_standard_policy(), &overrides);

    assert_eq!(config, LoopDetectorConfig::default());
}

#[test]
fn canonical_structural_exclusions_enable_the_detector_pass() {
    let policy = conversation_weak_policy();
    assert_eq!(
        policy.loop_detection.structural_exclusions,
        StructuralExclusionKind::ALL
    );
    assert!(structure_exclusions_enabled(policy.loop_detection));

    let without_exclusions = LoopDetectionPolicy {
        threshold_scale: 1.0,
        structural_exclusions: &[],
    };
    assert!(!structure_exclusions_enabled(without_exclusions));
}

// ------------------------------ observation plumbing ------------------------------

#[test]
fn visible_completion_excludes_reported_reasoning() {
    // Providers that fold reasoning into the completion count would otherwise
    // look like progress while the visible answer stays empty.
    assert_eq!(visible_completion_tokens(900, Some(880)), 20);
    assert_eq!(visible_completion_tokens(900, None), 900);
    assert_eq!(visible_completion_tokens(10, Some(400)), 0);
}

#[test]
fn round_text_and_reasoning_reads_completed_rounds() {
    let mixed = Message::assistant_with_reasoning(
        Some("internal reasoning".to_string()),
        "visible answer".to_string(),
        Vec::new(),
    );
    let (text, thinking) = round_text_and_reasoning(&mixed);
    assert_eq!(text, Some("visible answer"));
    assert_eq!(thinking, Some("internal reasoning"));

    let text_only = Message::assistant("answer".to_string());
    let (text, thinking) = round_text_and_reasoning(&text_only);
    assert_eq!(text, Some("answer"));
    assert_eq!(thinking, None);

    let empty_reasoning =
        Message::assistant_with_reasoning(Some("   ".to_string()), "  ".to_string(), Vec::new());
    assert_eq!(round_text_and_reasoning(&empty_reasoning), (None, None));
}

#[test]
fn observe_detects_a_repeated_output_passage() {
    let mut ladder = LoopInterventionLadder::new(settings(LoopDetectionMode::Enforce));
    let text = REPEATED_PASSAGE.repeat(8);

    let step = ladder.observe(&LoopRoundObservation {
        output_text: Some(&text),
        ..Default::default()
    });

    let verdict = step.verdict.expect("verdict for repeated output");
    assert!(verdict.source == LoopSignalSource::Output);
    assert!(verdict.verdict.kind.is_output_loop());
    assert_eq!(
        steered_kind(&step.action),
        Some(InternalReminderKind::OutputLoopRecovery)
    );
    assert_eq!(
        ladder.health_fields().escalation,
        LoopEscalationLevel::Steer
    );
}

#[test]
fn observe_detects_stagnating_thinking_blocks() {
    let mut ladder = LoopInterventionLadder::new(settings(LoopDetectionMode::Enforce));
    let block = "I should check the config file again. The value must be the same, so I will re-read it and confirm the same conclusion about the missing key.";
    let mut action = LoopLadderAction::None;
    for _ in 0..3 {
        let step = ladder.observe(&LoopRoundObservation {
            thinking_block: Some(block),
            ..Default::default()
        });
        // The engine consults the arbitration port when the ladder asks for it.
        action = if step.pending_arbitration {
            ladder.confirm(ArbiterDecision::Indeterminate)
        } else {
            step.action
        };
    }

    assert_eq!(
        steered_kind(&action),
        Some(InternalReminderKind::ThinkingLoopRecovery)
    );
}

#[test]
fn observe_feeds_the_usage_bypass() {
    let mut ladder = LoopInterventionLadder::new(settings(LoopDetectionMode::Enforce));
    let runaway = LoopUsageSample::new(900, 0);

    let first = ladder.observe(&LoopRoundObservation {
        usage: Some(runaway),
        ..Default::default()
    });
    assert_eq!(first.verdict, None, "one sample is not a streak");

    let second = ladder.observe(&LoopRoundObservation {
        usage: Some(runaway),
        ..Default::default()
    });
    let verdict = second.verdict.expect("runaway verdict");
    assert_eq!(verdict.verdict.kind, LoopKind::ReasoningRunaway);
    assert_eq!(
        steered_kind(&second.action),
        Some(InternalReminderKind::ThinkingLoopRecovery)
    );
}

// ------------------------------ ladder: modes and the escape hatch ------------------------------

#[test]
fn mode_off_never_feeds_the_detectors() {
    let mut ladder = LoopInterventionLadder::new(settings(LoopDetectionMode::Off));
    let text = REPEATED_PASSAGE.repeat(8);

    let step = ladder.observe(&LoopRoundObservation {
        output_text: Some(&text),
        thinking_block: Some(&text),
        usage: Some(LoopUsageSample::new(900, 0)),
    });

    assert!(!ladder.active());
    assert!(step.verdict.is_none());
    assert!(!step.pending_arbitration);
    assert_eq!(step.action, LoopLadderAction::None);
    let health = ladder.health_fields();
    assert!(!health.has_verdict());
    assert_eq!(health.verdict_count, 0);
    assert_eq!(health.steer_attempts, 0);
    assert_eq!(health.escalation, LoopEscalationLevel::Off);
}

#[test]
fn telemetry_mode_reports_without_injecting() {
    let mut ladder = LoopInterventionLadder::new(settings(LoopDetectionMode::Telemetry));

    let step = ladder.observe_verdict(Some(output_verdict(LoopKind::VerbatimBlock, 0.95)));

    assert!(step.verdict.is_some());
    assert_eq!(step.action, LoopLadderAction::None);
    let health = ladder.health_fields();
    assert_eq!(health.verdict_kind, Some("verbatim_block"));
    assert_eq!(health.verdict_confidence, Some(0.95));
    assert_eq!(health.verdict_count, 1);
    assert_eq!(health.steer_attempts, 0);
    assert_eq!(health.escalation, LoopEscalationLevel::Telemetry);
}

#[test]
fn session_escape_hatch_behaves_like_off() {
    let mut ladder = LoopInterventionLadder::new(settings(LoopDetectionMode::Enforce));
    ladder.set_session_enabled(false);

    let step = ladder.observe_verdict(Some(output_verdict(LoopKind::VerbatimBlock, 0.95)));

    assert!(!ladder.active());
    assert_eq!(step.action, LoopLadderAction::None);
    assert_eq!(ladder.health_fields().escalation, LoopEscalationLevel::Off);

    // Re-enabling starts from clean detector state instead of inheriting the
    // window from before the escape hatch.
    ladder.set_session_enabled(true);
    assert!(ladder.active());
    assert_eq!(
        ladder.health_fields().escalation,
        LoopEscalationLevel::Telemetry
    );
    assert_eq!(ladder.steer_attempts(), 0);
}

#[test]
fn clearing_detection_drops_escalation_state() {
    let mut ladder = LoopInterventionLadder::new(settings(LoopDetectionMode::Enforce));
    for _ in 0..2 {
        ladder.observe_verdict(Some(output_verdict(LoopKind::VerbatimBlock, 0.95)));
    }
    assert_eq!(ladder.steer_attempts(), 2);

    ladder.clear_detection();

    let health = ladder.health_fields();
    assert_eq!(health.steer_attempts, 0);
    assert_eq!(health.verdict_count, 0);
    assert!(!health.has_verdict());
    assert_eq!(health.escalation, LoopEscalationLevel::Telemetry);
}

// ------------------------------ ladder: asymmetric policy ------------------------------

#[test]
fn enforce_mode_steers_three_times_then_hard_stops() {
    let mut ladder = LoopInterventionLadder::new(settings(LoopDetectionMode::Enforce));

    for attempt in 1..=MAX_LOOP_RECOVERY_ATTEMPTS {
        let step = ladder.observe_verdict(Some(output_verdict(LoopKind::VerbatimBlock, 0.95)));
        assert_eq!(
            steered_kind(&step.action),
            Some(InternalReminderKind::OutputLoopRecovery),
            "attempt {attempt} must steer"
        );
        assert_eq!(ladder.steer_attempts(), attempt);
        assert_eq!(
            ladder.health_fields().escalation,
            LoopEscalationLevel::Steer
        );
    }

    let step = ladder.observe_verdict(Some(output_verdict(LoopKind::VerbatimBlock, 0.95)));

    match step.action {
        LoopLadderAction::HardStop { reason, kind, .. } => {
            assert_eq!(reason, LOOP_DETECTED_FINALIZATION_REASON);
            assert_eq!(kind, LoopKind::VerbatimBlock);
        }
        other => panic!("expected a hard stop, got {other:?}"),
    }
    assert_eq!(
        ladder.health_fields().escalation,
        LoopEscalationLevel::HardStop
    );
}

#[test]
fn a_clean_round_resets_the_attempt_counter() {
    let mut ladder = LoopInterventionLadder::new(settings(LoopDetectionMode::Enforce));
    for _ in 0..2 {
        ladder.observe_verdict(Some(output_verdict(LoopKind::VerbatimBlock, 0.95)));
    }
    assert_eq!(ladder.steer_attempts(), 2);

    let step = ladder.observe_verdict(None);

    assert_eq!(step.action, LoopLadderAction::None);
    assert_eq!(ladder.steer_attempts(), 0);
    assert!(!ladder.health_fields().has_verdict());
    assert_eq!(
        ladder.health_fields().escalation,
        LoopEscalationLevel::Telemetry
    );
}

#[test]
fn weak_near_repetition_may_steer_but_never_hard_stops_alone() {
    let mut ladder = LoopInterventionLadder::new(settings(LoopDetectionMode::Enforce));

    // The 0.85..0.90 arbitration band: eligible to nudge, not to abort.
    for _ in 0..MAX_LOOP_RECOVERY_ATTEMPTS {
        let step = ladder.observe_verdict(Some(output_verdict(LoopKind::NearRepetition, 0.60)));
        assert!(steered_kind(&step.action).is_some());
    }

    let step = ladder.observe_verdict(Some(output_verdict(LoopKind::NearRepetition, 0.60)));
    assert!(
        step.pending_arbitration,
        "past the steer cap the judge has to bless an escalation"
    );
    let action = ladder.confirm(ArbiterDecision::Indeterminate);

    assert_eq!(
        action,
        LoopLadderAction::None,
        "a weak near-repetition must not end the turn"
    );
    assert_eq!(
        ladder.health_fields().escalation,
        LoopEscalationLevel::Telemetry
    );
}

#[test]
fn strong_near_repetition_is_hard_stop_eligible() {
    let mut ladder = LoopInterventionLadder::new(settings(LoopDetectionMode::Enforce));
    for _ in 0..MAX_LOOP_RECOVERY_ATTEMPTS {
        ladder.observe_verdict(Some(output_verdict(LoopKind::NearRepetition, 0.88)));
    }

    let step = ladder.observe_verdict(Some(output_verdict(LoopKind::NearRepetition, 0.88)));

    assert!(matches!(step.action, LoopLadderAction::HardStop { .. }));
}

#[test]
fn confidence_capped_kinds_never_hard_stop_on_heuristics_alone() {
    // A reasoning runaway is steer-only: it takes the same three soft attempts
    // as any other signal, and the fourth round may not end the turn unless the
    // judge upgrades it.
    let mut ladder = LoopInterventionLadder::new(settings(LoopDetectionMode::Enforce));
    let runaway = || Some(thinking_verdict(LoopKind::ReasoningRunaway, 0.35, false));
    for attempt in 1..=MAX_LOOP_RECOVERY_ATTEMPTS {
        let step = ladder.observe_verdict(runaway());
        assert!(
            steered_kind(&step.action).is_some(),
            "attempt {attempt} must steer"
        );
    }
    let step = ladder.observe_verdict(runaway());
    assert!(step.pending_arbitration);
    assert_eq!(
        ladder.confirm(ArbiterDecision::Indeterminate),
        LoopLadderAction::None
    );
    assert_eq!(
        ladder.health_fields().escalation,
        LoopEscalationLevel::Telemetry
    );

    // A predictable enumeration may not even steer before a classifier confirms
    // it: repeated counters are legitimate output often enough.
    let mut ladder = LoopInterventionLadder::new(settings(LoopDetectionMode::Enforce));
    let drift = || Some(output_verdict(LoopKind::PredictableDrift, 0.25));
    let step = ladder.observe_verdict(drift());
    assert!(step.pending_arbitration);
    assert_eq!(
        ladder.confirm(ArbiterDecision::Indeterminate),
        LoopLadderAction::None
    );
    assert_eq!(ladder.steer_attempts(), 0);

    // Confirmed, it may steer; it still never hard stops on heuristics alone.
    let mut ladder = LoopInterventionLadder::new(settings(LoopDetectionMode::Enforce));
    ladder.observe_verdict(drift());
    assert_eq!(
        steered_kind(&ladder.confirm(confident_judge())),
        Some(InternalReminderKind::OutputLoopRecovery)
    );
    for _ in 0..=MAX_LOOP_RECOVERY_ATTEMPTS {
        ladder.observe_verdict(drift());
    }
    assert_ne!(
        ladder.health_fields().escalation,
        LoopEscalationLevel::HardStop
    );
}

// ------------------------------ ladder: arbitration handshake ------------------------------

#[test]
fn boundary_verdicts_ask_the_arbiter_first() {
    let mut ladder = LoopInterventionLadder::new(settings(LoopDetectionMode::Enforce));

    let step = ladder.observe_verdict(Some(thinking_verdict(
        LoopKind::ThinkingStagnation,
        0.75,
        true,
    )));

    assert!(step.pending_arbitration);
    assert_eq!(step.action, LoopLadderAction::None);
    assert_eq!(ladder.steer_attempts(), 0);
}

#[test]
fn indeterminate_arbitration_keeps_the_heuristic_verdict() {
    let mut ladder = LoopInterventionLadder::new(settings(LoopDetectionMode::Enforce));
    let step = ladder.observe_verdict(Some(thinking_verdict(
        LoopKind::ThinkingStagnation,
        0.75,
        true,
    )));
    assert!(step.pending_arbitration);

    let action = ladder.confirm(ArbiterDecision::Indeterminate);

    assert_eq!(
        steered_kind(&action),
        Some(InternalReminderKind::ThinkingLoopRecovery)
    );
    assert_eq!(
        ladder.health_fields().arbitration,
        Some(ArbiterDecision::Indeterminate.as_str())
    );
}

#[test]
fn rejected_arbitration_drops_the_verdict_without_spending_an_attempt() {
    let mut ladder = LoopInterventionLadder::new(settings(LoopDetectionMode::Enforce));
    ladder.observe_verdict(Some(thinking_verdict(
        LoopKind::ThinkingStagnation,
        0.75,
        true,
    )));

    let action = ladder.confirm(ArbiterDecision::Rejected);

    assert_eq!(action, LoopLadderAction::None);
    assert_eq!(ladder.steer_attempts(), 0);
    let health = ladder.health_fields();
    assert_eq!(health.arbitration, Some("rejected"));
    assert!(health.has_verdict(), "a rejection is calibration data");
    assert_eq!(health.escalation, LoopEscalationLevel::Telemetry);
}

#[test]
fn confirmed_arbitration_upgrades_a_capped_kind_to_a_hard_stop() {
    let mut ladder = LoopInterventionLadder::new(settings(LoopDetectionMode::Enforce));
    // Steer-only signal, three soft attempts already spent.
    for _ in 0..MAX_LOOP_RECOVERY_ATTEMPTS {
        ladder.observe_verdict(Some(thinking_verdict(
            LoopKind::ReasoningRunaway,
            0.35,
            false,
        )));
    }

    let step = ladder.observe_verdict(Some(thinking_verdict(
        LoopKind::ReasoningRunaway,
        0.35,
        false,
    )));
    assert!(
        step.pending_arbitration,
        "a capped signal past its cap asks the judge whether it may upgrade"
    );

    let action = ladder.confirm(confident_judge());

    match action {
        LoopLadderAction::HardStop { reason, kind, .. } => {
            assert_eq!(reason, LOOP_DETECTED_FINALIZATION_REASON);
            assert_eq!(kind, LoopKind::ReasoningRunaway);
        }
        other => panic!("a confirmed capped signal may end the turn, got {other:?}"),
    }
}

// --------------------------- ladder: confidence gate ---------------------------

#[test]
fn a_confirmation_below_the_configured_confidence_keeps_the_heuristic_caps() {
    let mut ladder = LoopInterventionLadder::new(settings(LoopDetectionMode::Enforce));
    for _ in 0..MAX_LOOP_RECOVERY_ATTEMPTS {
        ladder.observe_verdict(Some(thinking_verdict(
            LoopKind::ReasoningRunaway,
            0.35,
            false,
        )));
    }
    let step = ladder.observe_verdict(Some(thinking_verdict(
        LoopKind::ReasoningRunaway,
        0.35,
        false,
    )));
    assert!(step.pending_arbitration);

    // The judge says `loop`, but only with 0.60: below the 0.9 baseline gate.
    let action = ladder.confirm(ArbiterDecision::Confirmed {
        confidence: Some(0.60),
    });

    assert_eq!(
        action,
        LoopLadderAction::None,
        "a below-threshold confirmation may not end a capped signal's turn"
    );
    let health = ladder.health_fields();
    assert_eq!(
        health.arbitration,
        Some(ArbiterDecision::Indeterminate.as_str()),
        "a gated confirmation is applied as an indeterminate answer"
    );
    assert_eq!(health.escalation, LoopEscalationLevel::Telemetry);
    assert_eq!(
        ladder.steer_attempts(),
        MAX_LOOP_RECOVERY_ATTEMPTS,
        "gating must not spend another steer attempt"
    );
}

#[test]
fn the_confidence_gate_is_configurable() {
    // A calibration run can move the bar: 0.60 then confirms the same signal.
    let mut gated = settings(LoopDetectionMode::Enforce);
    gated.judge_confidence_min = 0.5;
    let mut ladder = LoopInterventionLadder::new(gated);
    for _ in 0..MAX_LOOP_RECOVERY_ATTEMPTS {
        ladder.observe_verdict(Some(thinking_verdict(
            LoopKind::ReasoningRunaway,
            0.35,
            false,
        )));
    }
    ladder.observe_verdict(Some(thinking_verdict(
        LoopKind::ReasoningRunaway,
        0.35,
        false,
    )));

    let action = ladder.confirm(ArbiterDecision::Confirmed {
        confidence: Some(0.60),
    });

    assert!(
        matches!(
            action,
            LoopLadderAction::HardStop {
                kind: LoopKind::ReasoningRunaway,
                ..
            }
        ),
        "a confirmation at the configured confidence stays authoritative, got {action:?}"
    );
}

#[test]
fn an_unstated_confidence_is_not_authoritative_but_still_allows_a_steer() {
    // A capped signal past its steers: the judge answered `loop` without stating a
    // confidence, so it may not upgrade the kind to a hard stop.
    let mut ladder = LoopInterventionLadder::new(settings(LoopDetectionMode::Enforce));
    for _ in 0..MAX_LOOP_RECOVERY_ATTEMPTS {
        ladder.observe_verdict(Some(thinking_verdict(
            LoopKind::ReasoningRunaway,
            0.35,
            false,
        )));
    }
    ladder.observe_verdict(Some(thinking_verdict(
        LoopKind::ReasoningRunaway,
        0.35,
        false,
    )));

    assert_eq!(
        ladder.confirm(ArbiterDecision::Confirmed { confidence: None }),
        LoopLadderAction::None
    );

    // The steer path is not collateral damage: an ambiguous verdict on a
    // steer-eligible kind still nudges the turn.
    let mut ladder = LoopInterventionLadder::new(settings(LoopDetectionMode::Enforce));
    let step = ladder.observe_verdict(Some(thinking_verdict(
        LoopKind::ThinkingStagnation,
        0.75,
        true,
    )));
    assert!(step.pending_arbitration);

    assert_eq!(
        steered_kind(&ladder.confirm(ArbiterDecision::Confirmed { confidence: None })),
        Some(InternalReminderKind::ThinkingLoopRecovery)
    );
}

#[test]
fn the_port_confidence_gate_only_removes_authority() {
    let minimum = DEFAULT_JUDGE_VERDICT_CONFIDENCE_MIN;

    assert_eq!(
        ArbiterDecision::Confirmed {
            confidence: Some(minimum),
        }
        .gated_by_confidence(minimum),
        ArbiterDecision::Confirmed {
            confidence: Some(minimum),
        },
        "a confirmation exactly at the threshold passes"
    );
    for below in [Some(minimum - 0.01), None] {
        assert_eq!(
            ArbiterDecision::Confirmed { confidence: below }.gated_by_confidence(minimum),
            ArbiterDecision::Indeterminate,
            "confidence {below:?} must not confirm"
        );
    }
    assert_eq!(
        ArbiterDecision::Rejected.gated_by_confidence(minimum),
        ArbiterDecision::Rejected
    );
    assert_eq!(
        ArbiterDecision::Indeterminate.gated_by_confidence(minimum),
        ArbiterDecision::Indeterminate
    );
}

#[test]
fn the_judge_confidence_gate_resolves_overrides_over_the_baseline() {
    let mut overrides = LoopDetectionThresholdOverridesConfig::default();

    assert_eq!(DEFAULT_JUDGE_VERDICT_CONFIDENCE_MIN, 0.9);
    assert_eq!(
        judge_confidence_min(&overrides),
        DEFAULT_JUDGE_VERDICT_CONFIDENCE_MIN
    );

    overrides.judge_verdict_confidence_min = Some(0.75);
    assert_eq!(judge_confidence_min(&overrides), 0.75);

    // Non-positive and non-finite values count as unset, like every other knob in
    // the override table.
    for unset in [0.0, -1.0, f32::NAN] {
        overrides.judge_verdict_confidence_min = Some(unset);
        assert_eq!(
            judge_confidence_min(&overrides),
            DEFAULT_JUDGE_VERDICT_CONFIDENCE_MIN,
            "override {unset} counts as unset"
        );
    }

    // A ratio above 1.0 can never be reached, so it clamps to the most demanding
    // reachable gate instead of disabling the judge silently.
    overrides.judge_verdict_confidence_min = Some(1.5);
    assert_eq!(judge_confidence_min(&overrides), 1.0);
}

#[test]
fn arbitration_requests_respect_the_per_turn_budget() {
    let mut settings = settings(LoopDetectionMode::Enforce);
    settings.max_arbitration_requests_per_turn = 2;
    let mut ladder = LoopInterventionLadder::new(settings);
    let verdict = || Some(thinking_verdict(LoopKind::ThinkingStagnation, 0.75, true));

    assert!(ladder.observe_verdict(verdict()).pending_arbitration);
    ladder.confirm(ArbiterDecision::Rejected);
    assert!(ladder.observe_verdict(verdict()).pending_arbitration);
    ladder.confirm(ArbiterDecision::Rejected);

    let spent = ladder.observe_verdict(verdict());

    assert!(
        !spent.pending_arbitration,
        "the judge budget must not be exceeded"
    );
    assert!(
        steered_kind(&spent.action).is_some(),
        "an exhausted budget degrades to the pure heuristic"
    );
}

#[test]
fn arbitration_is_not_requested_in_telemetry_mode() {
    let mut ladder = LoopInterventionLadder::new(settings(LoopDetectionMode::Telemetry));

    let step = ladder.observe_verdict(Some(thinking_verdict(
        LoopKind::ThinkingStagnation,
        0.75,
        true,
    )));

    assert!(!step.pending_arbitration);
    assert_eq!(step.action, LoopLadderAction::None);
}

#[test]
fn confirming_without_a_pending_verdict_is_a_no_op() {
    let mut ladder = LoopInterventionLadder::new(settings(LoopDetectionMode::Enforce));

    assert_eq!(ladder.confirm(confident_judge()), LoopLadderAction::None);
    assert_eq!(ladder.steer_attempts(), 0);
}

// ------------------------------ runtime state ------------------------------

#[test]
fn session_override_wins_for_that_session_only() {
    let runtime = LoopDetectionRuntime::default();

    assert!(runtime.session_enabled("session-a", true));
    assert!(!runtime.session_enabled("session-b", false));

    runtime.set_session_enabled("session-a", false);

    assert!(!runtime.session_enabled("session-a", true));
    assert!(runtime.session_enabled("session-b", true));

    runtime.set_session_enabled("session-a", true);
    assert!(runtime.session_enabled("session-a", false));
}

#[tokio::test]
async fn default_arbiter_slot_is_empty_and_no_arbiter_stays_indeterminate() {
    let runtime = LoopDetectionRuntime::default();
    assert!(runtime.arbiter().is_none());

    runtime.install_arbiter(std::sync::Arc::new(NoArbiter));
    let arbiter = runtime.arbiter().expect("installed arbiter");
    let decision = arbiter
        .arbitrate(
            &output_verdict(LoopKind::NearRepetition, 0.86).verdict,
            &super::arbiter::LoopArbiterContext {
                session_id: "session".to_string(),
                turn_id: "turn".to_string(),
                round_index: 1,
                model_id: "primary".to_string(),
                agent_type: "Standard".to_string(),
                signal_source: LoopSignalSource::Output,
            },
        )
        .await;

    assert_eq!(decision, ArbiterDecision::Indeterminate);
}

// ------------------------------ reminder copy ------------------------------

#[test]
fn steer_reminder_is_distinct_per_source_and_cites_the_signal() {
    let output = render_loop_steer_text(&output_verdict(LoopKind::VerbatimBlock, 0.95));
    let thinking =
        render_loop_steer_text(&thinking_verdict(LoopKind::ThinkingStagnation, 0.75, true));

    assert_ne!(output, thinking);
    assert!(output.contains("verbatim_block"));
    assert!(output.contains("0.95"));
    assert!(thinking.contains("thinking_stagnation"));
    assert!(thinking.contains("0.75"));
    assert!(output.starts_with("Repeated output loop detected"));
    assert!(thinking.starts_with("Internal reasoning loop detected"));
}

#[test]
fn steer_reminder_never_echoes_assistant_text() {
    let mut verdict = output_verdict(LoopKind::VerbatimBlock, 0.95);
    verdict.verdict.evidence.samples = vec![REPEATED_PASSAGE.to_string()];

    let text = render_loop_steer_text(&verdict);

    // Echoing the looped passage would re-anchor the model on the text it must
    // abandon (DITTO guard); the reminder cites numbers instead.
    assert!(!text.contains("without any new information"));
    assert!(text.contains("stop repeating") || text.contains("Stop repeating"));
}

#[test]
fn steer_reminder_is_english_ascii_and_bounded() {
    for verdict in [
        output_verdict(LoopKind::VerbatimBlock, 0.95),
        output_verdict(LoopKind::NearRepetition, 0.88),
        output_verdict(LoopKind::PhraseStuck, 0.90),
        output_verdict(LoopKind::PeriodicSequence, 0.90),
        thinking_verdict(LoopKind::ThinkingStagnation, 0.75, true),
        thinking_verdict(LoopKind::ReasoningRunaway, 0.35, false),
    ] {
        let text = render_loop_steer_text(&verdict);

        assert!(
            text.is_ascii(),
            "reminder must stay ASCII (English logs/copy): {text}"
        );
        assert!(
            text.len() < 900,
            "reminder must stay bounded, got {} characters",
            text.len()
        );
        assert!(
            text.contains("do not") || text.contains("Do not"),
            "reminder must tell the model what to stop doing: {text}"
        );
    }
}

#[test]
fn source_labels_are_stable() {
    assert_eq!(LoopSignalSource::Output.as_str(), "output");
    assert_eq!(LoopSignalSource::Thinking.as_str(), "thinking");
}

#[test]
fn per_turn_ladders_keep_independent_detector_state() {
    // The ladder owns its detectors, so one turn's window never leaks into the
    // next; the settings value stays reusable for the session.
    let settings = settings(LoopDetectionMode::Enforce);
    let text = REPEATED_PASSAGE.repeat(8);
    let observation = LoopRoundObservation {
        output_text: Some(&text),
        ..Default::default()
    };

    let mut first = LoopInterventionLadder::new(settings.clone());
    let mut second = LoopInterventionLadder::new(settings);

    let first_step = first.observe(&observation);
    let second_step = second.observe(&observation);

    assert!(first_step.verdict.is_some());
    assert!(second_step.verdict.is_some());
    assert_eq!(first.steer_attempts(), 1);
    assert_eq!(second.steer_attempts(), 1);
}
