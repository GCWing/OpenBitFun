//! The loop-detection intervention ladder.
//!
//! This is a pure state machine: it owns the per-turn detectors, the attempt
//! counters, and the copy of the steer reminder, and it returns a decision. It
//! performs no IO, no message mutation, no logging, and no arbitration — the
//! engine does those. Keeping the seam at "decision in, action out" is what
//! makes the asymmetric policy the plan asks for testable in isolation.
//!
//! # Ladder shape
//!
//! ```text
//! observe(round) -> no verdict        -> reset attempts, escalate nowhere
//!                -> verdict, ambiguous -> ask the arbiter (engine), then confirm()
//!                -> verdict           -> L0 telemetry, or L1 steer, or L2 hard stop
//! ```
//!
//! * **L0 telemetry** always happens: every verdict is recorded and logged,
//!   which is the calibration default (`mode = telemetry`).
//! * **L1 steer** injects a root-cause reminder at the round boundary, mirroring
//!   the existing failed-tool recovery pipeline. Attempts are capped by
//!   [`MAX_LOOP_RECOVERY_ATTEMPTS`].
//! * **L2 hard stop** ends the turn with
//!   [`LOOP_DETECTED_FINALIZATION_REASON`] once a persisting high-confidence
//!   signal has ignored the cap.
//!
//! # Asymmetric handling (per plan decision 4)
//!
//! Kinds are not treated alike, because their false-positive cost is not alike:
//!
//! | Kind | Steer | Hard stop |
//! |---|---|---|
//! | `verbatim_block`, `phrase_stuck`, `periodic_sequence` | yes | yes |
//! | `near_repetition` | yes | only when strong (or judge-confirmed) |
//! | `thinking_stagnation` | yes | yes |
//! | `predictable_drift` | only when judge-confirmed | only when judge-confirmed |
//! | `reasoning_runaway` | yes | **never**, unless the judge confirms |
//!
//! The last two rows are the plan's capped signals: a counter series and a long
//! opaque reasoning phase are both indistinguishable from a legitimately long
//! turn, so they may nudge at most. A declined nudge is not repeated forever
//! either: a capped signal past its steer cap goes quiet and stays in telemetry
//! rather than nagging a turn that is probably fine.
//!
//! # DITTO guard
//!
//! The reminder deliberately contains **no excerpt of the repeated text**. It
//! names the signal, the source stream, the confidence, and a bounded numeric
//! description of the pattern, then instructs the model to abandon the line it
//! is repeating. Injecting the looped passage back would re-anchor the model on
//! exactly the text it must drop, and assistant text can also carry secrets.
//!
//! What this module cannot do is remove the looped reasoning that already sits
//! in the request history: core replays assistant reasoning content between
//! rounds (only display summaries are withheld), and this ladder does not
//! rewrite history. The guard is therefore prompt-level plus detector-level, and
//! a stricter history-side guard is a follow-up, not something invented here.

use super::arbiter::ArbiterDecision;
use super::health::{LoopEscalationLevel, LoopHealthFields};
use crate::agentic::core::{InternalReminderKind, Message, MessageContent};
use openbitfun_agent_stream::{
    LoopDetectorConfig, LoopKind, LoopVerdict, OutputLoopDetector, ThinkingLoopDetector,
};
use openbitfun_config_contracts::LoopDetectionMode;
use std::cmp::Ordering;

/// Steer reminders injected for one persisting signal before the hard fallback.
///
/// Mirrors `MAX_FAILED_TOOL_RECOVERY_ATTEMPTS`: three soft attempts, then one
/// hard decision. The number is a policy constant, not a workflow step.
pub const MAX_LOOP_RECOVERY_ATTEMPTS: usize = 3;

/// Finalization reason of a turn ended by the hard fallback.
pub const LOOP_DETECTED_FINALIZATION_REASON: &str = "loop_detected";

/// Which stream produced a verdict.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum LoopSignalSource {
    /// User-visible assistant text.
    Output,
    /// Thinking / reasoning content.
    Thinking,
}

impl LoopSignalSource {
    /// Stable identifier for logs, telemetry, and judge context.
    pub const fn as_str(self) -> &'static str {
        match self {
            Self::Output => "output",
            Self::Thinking => "thinking",
        }
    }

    /// Reminder kind used when this source needs steering.
    const fn reminder_kind(self) -> InternalReminderKind {
        match self {
            Self::Output => InternalReminderKind::OutputLoopRecovery,
            Self::Thinking => InternalReminderKind::ThinkingLoopRecovery,
        }
    }
}

/// One usage sample: token deltas reported for one model round.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct LoopUsageSample {
    /// Reasoning tokens the provider reported for this round.
    pub reasoning_tokens: u64,
    /// Completion tokens excluding reasoning; see [`visible_completion_tokens`].
    pub visible_completion_tokens: u64,
}

impl LoopUsageSample {
    pub const fn new(reasoning_tokens: u64, visible_completion_tokens: u64) -> Self {
        Self {
            reasoning_tokens,
            visible_completion_tokens,
        }
    }
}

/// Detector inputs of one completed model round.
#[derive(Debug, Clone, Copy, Default)]
pub struct LoopRoundObservation<'a> {
    /// User-visible assistant text of the round.
    pub output_text: Option<&'a str>,
    /// The round's completed thinking block.
    ///
    /// Detection is quantized to the round boundary on purpose: the stream's
    /// per-delta path is a hot path, and the plan's throttle guidance explicitly
    /// allows per-round analysis. One merged block per round still catches the
    /// cross-round thinking loop, which is the case the plan ranks first.
    pub thinking_block: Option<&'a str>,
    /// Usage deltas of the round, when the provider reported them.
    pub usage: Option<LoopUsageSample>,
}

/// A verdict plus the stream it was observed in.
#[derive(Debug, Clone, PartialEq)]
pub struct LoopObservedVerdict {
    pub source: LoopSignalSource,
    pub verdict: LoopVerdict,
}

impl LoopObservedVerdict {
    /// Whether the L2 judge should arbitrate before the ladder escalates.
    pub fn requires_arbitration(&self) -> bool {
        self.verdict.requires_arbitration()
    }
}

/// A steer reminder the engine must inject at the round boundary.
#[derive(Debug, Clone, PartialEq)]
pub struct LoopSteer {
    /// Reminder kind carried on the injected message.
    pub reminder_kind: InternalReminderKind,
    /// Stream that produced the signal.
    pub source: LoopSignalSource,
    /// Detected kind.
    pub kind: LoopKind,
    /// Detector confidence.
    pub confidence: f32,
    /// Root-cause reminder text (plain prose; `Message::internal_reminder`
    /// wraps it in the system-reminder markup).
    pub text: String,
}

/// What the ladder wants the engine to do about this round.
#[derive(Debug, Clone, PartialEq)]
pub enum LoopLadderAction {
    /// Observe only.
    None,
    /// Inject the steer reminder and continue the turn.
    Steer(LoopSteer),
    /// Stop the turn; `reason` is the finalization reason to report.
    HardStop {
        reason: &'static str,
        source: LoopSignalSource,
        kind: LoopKind,
        confidence: f32,
    },
}

/// Result of observing one round.
#[derive(Debug, Clone, PartialEq)]
pub struct LoopLadderStep {
    /// The strongest verdict of this round, when one was found.
    pub verdict: Option<LoopObservedVerdict>,
    /// The engine must consult the arbitration port and report the decision back
    /// through [`LoopInterventionLadder::confirm`]; `action` stays `None` while
    /// this is true.
    pub pending_arbitration: bool,
    /// Action for this round. Always `None` while arbitration is pending.
    pub action: LoopLadderAction,
}

impl LoopLadderStep {
    fn observed_nothing() -> Self {
        Self {
            verdict: None,
            pending_arbitration: false,
            action: LoopLadderAction::None,
        }
    }
}

/// One turn's ladder configuration.
#[derive(Debug, Clone)]
pub struct LoopLadderSettings {
    /// Detection and intervention level from `ai.loop_detection.mode`.
    pub mode: LoopDetectionMode,
    /// Whether the session escape hatch leaves detection on.
    pub session_enabled: bool,
    /// Detector thresholds resolved from the tier policy and user overrides.
    pub detector_config: LoopDetectorConfig,
    /// Whether the L2 judge may be consulted at all.
    pub judge_enabled: bool,
    /// Hard cap on arbitration requests per turn.
    pub max_arbitration_requests_per_turn: u32,
    /// Confidence a judge confirmation must state before it is treated as
    /// authoritative, from `ai.loop_detection.thresholds.judge_verdict_confidence_min`
    /// (baseline
    /// [`DEFAULT_JUDGE_VERDICT_CONFIDENCE_MIN`](crate::agentic::execution::loop_detection::DEFAULT_JUDGE_VERDICT_CONFIDENCE_MIN)).
    /// A lower or absent confidence keeps the heuristic verdict and its caps.
    pub judge_confidence_min: f32,
}

/// Per-turn loop-detection ladder.
pub struct LoopInterventionLadder {
    settings: LoopLadderSettings,
    output: OutputLoopDetector,
    thinking: ThinkingLoopDetector,
    session_enabled: bool,
    verdict_count: usize,
    arbitration_requests: u32,
    steer_attempts: usize,
    last: Option<LoopObservedVerdict>,
    arbitration: Option<ArbiterDecision>,
    escalation: LoopEscalationLevel,
    pending: Option<LoopObservedVerdict>,
}

impl LoopInterventionLadder {
    /// Creates a ladder for one dialog turn.
    ///
    /// The detector state lives for exactly this turn: one ladder owns one turn's
    /// window and thinking history, so state survives across that turn's rounds
    /// without leaking into the next turn.
    pub fn new(settings: LoopLadderSettings) -> Self {
        let session_enabled = settings.session_enabled;
        let escalation = if settings.mode == LoopDetectionMode::Off || !session_enabled {
            LoopEscalationLevel::Off
        } else {
            LoopEscalationLevel::Telemetry
        };
        let detector_config = settings.detector_config.clone();
        Self {
            settings,
            output: OutputLoopDetector::with_config(detector_config.clone()),
            thinking: ThinkingLoopDetector::with_config(detector_config),
            session_enabled,
            verdict_count: 0,
            arbitration_requests: 0,
            steer_attempts: 0,
            last: None,
            arbitration: None,
            escalation,
            pending: None,
        }
    }

    /// Whether detection observes anything at all.
    ///
    /// `false` means the detectors are never fed: mode `off`, or the session
    /// escape hatch closed. That is the zero-overhead path the plan requires.
    pub fn active(&self) -> bool {
        self.settings.mode != LoopDetectionMode::Off && self.session_enabled
    }

    /// Whether the ladder may intervene (not just report).
    fn steering_enabled(&self) -> bool {
        self.settings.mode == LoopDetectionMode::Enforce && self.session_enabled
    }

    /// Loads the L2 arbitration budget for this turn.
    pub fn max_arbitration_requests(&self) -> u32 {
        self.settings.max_arbitration_requests_per_turn
    }

    /// Runtime toggle of the session escape hatch.
    ///
    /// Turning detection off for a session also clears detector state and the
    /// attempt counters, so a session that re-enables detection starts clean
    /// instead of inheriting a window from before the escape hatch. The engine
    /// re-reads the session flag every round, which is what makes a mid-turn
    /// clear effective immediately.
    pub fn set_session_enabled(&mut self, enabled: bool) {
        if self.session_enabled == enabled {
            return;
        }
        self.session_enabled = enabled;
        self.clear_detection();
    }

    /// Whether detection is enabled for this session right now.
    pub fn session_enabled(&self) -> bool {
        self.session_enabled
    }

    /// Drops the analysis window, reported-loop memory, and counters.
    ///
    /// This is the plan's `clearDetection` escape hatch: after it, the same loop
    /// must be re-observed from fresh evidence instead of continuing an
    /// escalation that the user already decided to ignore.
    pub fn clear_detection(&mut self) {
        self.output.reset();
        self.thinking.reset();
        self.verdict_count = 0;
        self.arbitration_requests = 0;
        self.steer_attempts = 0;
        self.last = None;
        self.arbitration = None;
        self.pending = None;
        self.escalation = if self.active() {
            LoopEscalationLevel::Telemetry
        } else {
            LoopEscalationLevel::Off
        };
    }

    /// Current attempt counter, for tests and telemetry.
    pub fn steer_attempts(&self) -> usize {
        self.steer_attempts
    }

    /// Telemetry of the most recent observation.
    pub fn health_fields(&self) -> LoopHealthFields {
        LoopHealthFields {
            signal_source: self.last.as_ref().map(|observed| observed.source.as_str()),
            verdict_kind: self
                .last
                .as_ref()
                .map(|observed| observed.verdict.kind.as_str()),
            verdict_confidence: self
                .last
                .as_ref()
                .map(|observed| observed.verdict.confidence),
            verdict_count: self.verdict_count,
            steer_attempts: self.steer_attempts,
            arbitration: self.arbitration.map(ArbiterDecision::as_str),
            escalation: self.escalation,
        }
    }

    /// Observes one completed round and decides what to do about it.
    ///
    /// Every observation re-arms the detectors' reported-loop memory, because
    /// the ladder — not the detector — counts attempts: a still-present loop has
    /// to keep being reported for the cap to mean anything.
    pub fn observe(&mut self, observation: &LoopRoundObservation<'_>) -> LoopLadderStep {
        if !self.active() {
            return LoopLadderStep::observed_nothing();
        }

        let mut candidates: Vec<LoopObservedVerdict> = Vec::new();
        if let Some(text) = observation.output_text {
            if let Some(verdict) = self.output.feed(text) {
                candidates.push(LoopObservedVerdict {
                    source: LoopSignalSource::Output,
                    verdict,
                });
            }
        }
        // The round boundary is the preferred hook: it analyzes everything fed,
        // including a trailing line without a newline.
        if let Some(verdict) = self.output.analyze() {
            candidates.push(LoopObservedVerdict {
                source: LoopSignalSource::Output,
                verdict,
            });
        }
        if let Some(block) = observation.thinking_block {
            if let Some(verdict) = self.thinking.feed_block(block) {
                candidates.push(LoopObservedVerdict {
                    source: LoopSignalSource::Thinking,
                    verdict,
                });
            }
        }
        if let Some(usage) = observation.usage {
            if let Some(verdict) = self
                .thinking
                .feed_usage(usage.reasoning_tokens, usage.visible_completion_tokens)
            {
                candidates.push(LoopObservedVerdict {
                    source: LoopSignalSource::Thinking,
                    verdict,
                });
            }
        }
        self.output.clear_reported();
        self.thinking.clear_reported();

        self.observe_verdict(strongest_verdict(candidates))
    }

    /// Feeds the round's strongest verdict into the escalation policy, or `None`
    /// when the round produced none.
    ///
    /// Split out from [`Self::observe`] so the policy — kind eligibility, attempt
    /// caps, arbitration admission — is testable without synthesizing a detector
    /// corpus for every kind and confidence band.
    pub(super) fn observe_verdict(
        &mut self,
        strongest: Option<LoopObservedVerdict>,
    ) -> LoopLadderStep {
        // Disabled detection is a no-op on every path, including this one: the
        // escape hatch must not be bypassable by feeding a verdict directly.
        if !self.active() {
            return LoopLadderStep::observed_nothing();
        }
        let Some(strongest) = strongest else {
            // A clean round means whatever loop was running has ended: the next
            // one starts its escalation from zero.
            self.steer_attempts = 0;
            self.last = None;
            self.arbitration = None;
            self.pending = None;
            self.escalation = LoopEscalationLevel::Telemetry;
            return LoopLadderStep::observed_nothing();
        };

        self.verdict_count += 1;
        self.arbitration = None;
        self.last = Some(strongest.clone());

        if self.should_arbitrate(&strongest) {
            self.arbitration_requests += 1;
            self.pending = Some(strongest.clone());
            self.escalation = LoopEscalationLevel::Telemetry;
            return LoopLadderStep {
                verdict: Some(strongest),
                pending_arbitration: true,
                action: LoopLadderAction::None,
            };
        }

        let action = self.escalate(&strongest, false);
        LoopLadderStep {
            verdict: Some(strongest),
            pending_arbitration: false,
            action,
        }
    }

    /// Reports the arbitration decision for the pending verdict.
    ///
    /// A call with nothing pending is a no-op, so the engine can stay
    /// unconditional.
    pub fn confirm(&mut self, decision: ArbiterDecision) -> LoopLadderAction {
        let Some(observed) = self.pending.take() else {
            return LoopLadderAction::None;
        };
        // The configuration decides how much the judge's sentence is worth: a
        // confirmation below `judge_confidence_min`, or one without a usable
        // confidence, is applied as an indeterminate answer. The gate only ever
        // removes authority, so a rejected verdict and a plain indeterminate one
        // are unaffected.
        let decision = decision.gated_by_confidence(self.settings.judge_confidence_min);
        self.arbitration = Some(decision);
        match decision {
            ArbiterDecision::Rejected => {
                // The judge disagreed: drop the verdict without spending an
                // attempt, and keep it in telemetry for the calibration report.
                self.escalation = LoopEscalationLevel::Telemetry;
                LoopLadderAction::None
            }
            ArbiterDecision::Confirmed { .. } => self.escalate(&observed, true),
            ArbiterDecision::Indeterminate => self.escalate(&observed, false),
        }
    }

    fn should_arbitrate(&self, observed: &LoopObservedVerdict) -> bool {
        if !(self.settings.mode == LoopDetectionMode::Enforce
            && self.session_enabled
            && self.settings.judge_enabled)
        {
            return false;
        }
        if self.arbitration_requests >= self.settings.max_arbitration_requests_per_turn {
            // Budget spent: the plan wants the judge layer to degrade into the
            // pure heuristic, never to block detection.
            return false;
        }
        self.heuristic_needs_judgement(observed)
    }

    /// Whether the pure heuristic cannot decide this verdict on its own.
    ///
    /// Three cases, and nothing else: boundary-band evidence the detector marked
    /// as ambiguous, a kind that needs a classifier verdict before it may act at
    /// all, and a capped signal that has spent its soft attempts and would
    /// otherwise go quiet — that last one is the only door through which a judge
    /// can upgrade a confidence-capped kind to a hard stop.
    fn heuristic_needs_judgement(&self, observed: &LoopObservedVerdict) -> bool {
        if observed.requires_arbitration() || !steer_eligible(observed.verdict.kind) {
            return true;
        }
        self.steer_attempts >= MAX_LOOP_RECOVERY_ATTEMPTS
            && !self.hard_stop_eligible(observed, false)
    }

    fn escalate(&mut self, observed: &LoopObservedVerdict, confirmed: bool) -> LoopLadderAction {
        // Telemetry mode observes, records, and returns. It never injects, so a
        // calibration run cannot change turn behavior.
        if !self.steering_enabled() {
            self.escalation = LoopEscalationLevel::Telemetry;
            return LoopLadderAction::None;
        }

        if !steer_eligible(observed.verdict.kind) && !confirmed {
            self.escalation = LoopEscalationLevel::Telemetry;
            return LoopLadderAction::None;
        }

        if self.steer_attempts >= MAX_LOOP_RECOVERY_ATTEMPTS {
            if self.hard_stop_eligible(observed, confirmed) {
                self.escalation = LoopEscalationLevel::HardStop;
                return LoopLadderAction::HardStop {
                    reason: LOOP_DETECTED_FINALIZATION_REASON,
                    source: observed.source,
                    kind: observed.verdict.kind,
                    confidence: observed.verdict.confidence,
                };
            }
            // A capped signal may steer but never abort, and repeating the same
            // nudge a fourth time only adds noise to a turn that is likely long
            // rather than broken.
            self.escalation = LoopEscalationLevel::Telemetry;
            return LoopLadderAction::None;
        }

        self.steer_attempts += 1;
        self.escalation = LoopEscalationLevel::Steer;
        LoopLadderAction::Steer(LoopSteer {
            reminder_kind: observed.source.reminder_kind(),
            source: observed.source,
            kind: observed.verdict.kind,
            confidence: observed.verdict.confidence,
            text: render_loop_steer_text(observed),
        })
    }

    /// Whether this signal may end the turn.
    fn hard_stop_eligible(&self, observed: &LoopObservedVerdict, confirmed: bool) -> bool {
        if confirmed {
            return true;
        }
        match observed.verdict.kind {
            LoopKind::VerbatimBlock | LoopKind::PhraseStuck | LoopKind::PeriodicSequence => true,
            LoopKind::ThinkingStagnation => true,
            // Only a strong near-repetition is conclusive; the arbitration band
            // exists precisely because 0.85..0.90 is not.
            LoopKind::NearRepetition => {
                observed.verdict.confidence
                    >= self.output.config().near_repetition_strong_confidence
            }
            LoopKind::PredictableDrift | LoopKind::ReasoningRunaway => false,
        }
    }
}

/// Whether a kind may be nudged at all without arbitration.
fn steer_eligible(kind: LoopKind) -> bool {
    // A bare enumeration is legitimate output often enough that the plan wants a
    // classifier verdict (here: the judge) before it counts as a loop to steer.
    !matches!(kind, LoopKind::PredictableDrift)
}

/// Highest-confidence verdict of one round.
///
/// Ties break deterministically: thinking before output, then kind identifier,
/// so the same round always produces the same reminder.
fn strongest_verdict(candidates: Vec<LoopObservedVerdict>) -> Option<LoopObservedVerdict> {
    let mut strongest: Option<LoopObservedVerdict> = None;
    for candidate in candidates {
        let replace = match strongest.as_ref() {
            None => true,
            Some(current) => {
                let confidence = candidate
                    .verdict
                    .confidence
                    .partial_cmp(&current.verdict.confidence)
                    .unwrap_or(Ordering::Equal);
                match confidence {
                    Ordering::Greater => true,
                    Ordering::Less => false,
                    Ordering::Equal => {
                        let source =
                            source_rank(candidate.source).cmp(&source_rank(current.source));
                        match source {
                            Ordering::Greater => true,
                            Ordering::Less => false,
                            Ordering::Equal => {
                                candidate
                                    .verdict
                                    .kind
                                    .as_str()
                                    .cmp(current.verdict.kind.as_str())
                                    == Ordering::Greater
                            }
                        }
                    }
                }
            }
        };
        if replace {
            strongest = Some(candidate);
        }
    }
    strongest
}

fn source_rank(source: LoopSignalSource) -> u8 {
    match source {
        LoopSignalSource::Output => 0,
        LoopSignalSource::Thinking => 1,
    }
}

/// Visible assistant text and thinking content of one model round.
///
/// `MessageContent::Mixed` is what a completed model round actually produces
/// (text plus tool calls plus reasoning), so it has to be handled here rather
/// than relying on the plain-text accessors used for persisted history.
pub fn round_text_and_reasoning(message: &Message) -> (Option<&str>, Option<&str>) {
    match &message.content {
        MessageContent::Text(text) => (non_empty(text), None),
        MessageContent::Multimodal { text, .. } => (non_empty(text), None),
        MessageContent::Mixed {
            reasoning_content,
            text,
            ..
        } => (
            non_empty(text),
            reasoning_content.as_deref().and_then(non_empty),
        ),
        MessageContent::ToolResult { .. } => (None, None),
    }
}

fn non_empty(text: &str) -> Option<&str> {
    let trimmed = text.trim();
    (!trimmed.is_empty()).then_some(trimmed)
}

/// Completion tokens of one round that are not reasoning tokens.
///
/// The usage bypass asks whether reasoning grew while *visible* output stalled.
/// Providers disagree on whether the completion count already contains
/// reasoning: the Gemini usage shape folds thoughts into it, so the reasoning
/// count must be subtracted to keep the signal comparable across providers.
/// Providers that report no reasoning count leave the completion count alone.
pub fn visible_completion_tokens(
    candidates_token_count: u32,
    reasoning_token_count: Option<u32>,
) -> u64 {
    u64::from(candidates_token_count).saturating_sub(u64::from(reasoning_token_count.unwrap_or(0)))
}

/// Root-cause reminder text for one observed verdict.
///
/// English only, emoji free, and free of repeated assistant text (see the module
/// documentation's DITTO guard). The copy is per source: repeated visible output
/// and repeated internal reasoning need different next actions.
pub fn render_loop_steer_text(observed: &LoopObservedVerdict) -> String {
    let verdict = &observed.verdict;
    let (headline, instruction) = match observed.source {
        LoopSignalSource::Thinking => (
            "Internal reasoning loop detected",
            "Stop this line of reasoning now. Do not restate, re-derive, or re-check what you have already reasoned through, and do not repeat the same sentences. State the conclusion you are going to act on in one or two sentences, then either call the tool that advances the task or write the final answer to the user.",
        ),
        LoopSignalSource::Output => (
            "Repeated output loop detected",
            "Stop repeating now. Do not restate or paraphrase any passage you have already written, and do not restart the same explanation. Continue from the last point that was genuinely new, or, if the answer is complete, write the final answer in plain text and finish the turn.",
        ),
    };
    format!(
        "{headline}: signal={signal}, source={source}, confidence={confidence:.2} ({detail}). If the task is genuinely blocked, say exactly what is missing instead of repeating yourself. {instruction}",
        signal = verdict.kind.as_str(),
        source = observed.source.as_str(),
        confidence = verdict.confidence,
        detail = evidence_detail(verdict),
    )
}

/// Bounded numeric description of the detected pattern; never assistant text.
fn evidence_detail(verdict: &LoopVerdict) -> String {
    let evidence = &verdict.evidence;
    match verdict.kind {
        LoopKind::VerbatimBlock => format!(
            "the same passage recurred {} times inside the last response with a mean spacing of about {} characters",
            evidence.occurrences,
            evidence.mean_interval_chars.unwrap_or(0.0).round() as u64
        ),
        LoopKind::NearRepetition => match evidence.max_similarity {
            Some(similarity) => format!(
                "two comparable stretches of the last response were about {:.0}% identical",
                similarity * 100.0
            ),
            None => "two comparable stretches of the last response were near-identical".to_string(),
        },
        LoopKind::PhraseStuck => format!(
            "a connector phrase repeated {} times without new content",
            evidence.consecutive_repeats.max(evidence.occurrences)
        ),
        LoopKind::PeriodicSequence => match evidence.period_units {
            Some(units) => format!(
                "a repeating {}-unit pattern cycled {} times without new content",
                units,
                evidence.consecutive_repeats.max(evidence.occurrences)
            ),
            None => format!(
                "a short repeating pattern cycled {} times without new content",
                evidence.consecutive_repeats.max(evidence.occurrences)
            ),
        },
        LoopKind::PredictableDrift => {
            "the text repeated as a predictable enumeration".to_string()
        }
        LoopKind::ThinkingStagnation => format!(
            "{} consecutive reasoning blocks were near-identical",
            evidence.occurrences.max(evidence.consecutive_repeats)
        ),
        LoopKind::ReasoningRunaway => format!(
            "reasoning kept growing ({} tokens in the last step) while visible output stayed empty",
            evidence.reasoning_tokens_delta.unwrap_or(0)
        ),
    }
}
