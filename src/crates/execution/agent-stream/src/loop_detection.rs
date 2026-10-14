//! Pure L1 loop detection for agent output and thinking streams.
//!
//! This module is the detector core of the agent loop-detection plan: rolling-hash
//! block repetition, character n-gram window similarity, short-period detection, a
//! dependency-free compression proxy, connector-phrase stalling, predictable
//! enumeration classification, and the thinking signals (adjacent-block similarity
//! plus the usage bypass for encrypted reasoning).
//!
//! # Contracts
//!
//! * Pure state transitions: no IO, no `await`, no globals, no clocks, no
//!   randomness. Token deltas and chunk boundaries are inputs, never read here.
//! * `feed` is incremental but strided internally (`analysis_stride_chars`, default
//!   4 KB, matching the plan's throttle guidance), so a caller that feeds every
//!   stream delta still pays for analysis at most once per stride. `analyze` forces
//!   a pass for callers that batch per round and is the preferred hook.
//! * A verdict is evidence, never an action. `kind` + `confidence` +
//!   `evidence.requires_arbitration` is the whole contract the intervention ladder
//!   needs; the detector never steers, cancels, writes, or logs.
//! * Dedup is per kind: within one detector state each [`LoopKind`] is reported
//!   once, so a persisting loop cannot spam the caller. A caller that needs the
//!   signal again for the same still-present loop (for example once per dialog
//!   round while the ladder counts attempts) calls `clear_reported`; the plan's
//!   `clearDetection` escape hatch is `reset`, which also forgets the window.
//!
//! # Kinds and how to read them
//!
//! | Kind | Meaning | `requires_arbitration` |
//! |---|---|---|
//! | [`LoopKind::VerbatimBlock`] | Same normalized block recurs many times close together | false |
//! | [`LoopKind::NearRepetition`] | Two comparable windows are near-identical | true in the 0.85..0.9 band, false when strong |
//! | [`LoopKind::PhraseStuck`] | Connector tokens repeat without progress | false |
//! | [`LoopKind::PeriodicSequence`] | A short unit repeats with a fixed period | false |
//! | [`LoopKind::PredictableDrift`] | Predictable enumeration (counter series) | false, low confidence on purpose |
//! | [`LoopKind::ThinkingStagnation`] | Adjacent thinking blocks are near-identical | true |
//! | [`LoopKind::ReasoningRunaway`] | Opaque reasoning grows while completion stalls | false, confidence capped at `reasoning_runaway_confidence` |
//!
//! [`PredictableDrift`](LoopKind::PredictableDrift) is reported *as its own kind*
//! rather than silently dropped, as the plan requires, but its confidence is
//! capped low: a counter series is usually legitimate enumeration, so the caller
//! must not treat it as a hard loop hit. [`ReasoningRunaway`](LoopKind::ReasoningRunaway)
//! follows the same rule: the plan says the opaque-reasoning signal may only
//! steer, never abort, because it cannot distinguish a long legitimate reasoning
//! phase from a loop. Use `evidence.occurrences` (enumeration samples, or
//! consecutive runaway samples) if a caller wants to escalate a long series.
//!
//! # Thresholds
//!
//! Every threshold is a [`LoopDetectorConfig`] field; the defaults are the plan's
//! initial values:
//!
//! | Signal | Field(s) | Default |
//! |---|---|---|
//! | Window and throttle | `window_chars`, `min_analyzed_chars`, `analysis_stride_chars` | 16384, 400, 4096 chars |
//! | Exact block reproduction | `block_chars`, `verbatim_min_occurrences`, `verbatim_max_mean_interval_chars` | 50 chars, 4 occurrences, mean interval <= 400 chars |
//! | n-gram window Jaccard | `near_repetition_scales_chars`, `near_repetition_ngram_chars`, `near_repetition_jaccard`, `near_repetition_strong_jaccard` | scales 512/2048/8192, 5-grams, 0.85 / 0.90 |
//! | Period detection | `period_max_units`, `period_min_repeats`, `period_unit_chars`, `period_unit_max_diff_chars` | period 1..5 units, 4 repeats, 50-char units, <= 6 differing characters |
//! | Adjacent thinking similarity | `thinking_adjacent_similarity`, `thinking_stagnation_pairs` | 0.7, 2 consecutive pairs |
//! | Phrase stalling | `phrase_stuck_min_consecutive`, `phrase_stuck_tokens` | 8 consecutive, connector seed list |
//! | Compression redundancy | `compression_min_redundancy`, `compression_span_chars` | 0.6 over a 4096-char window |
//! | Reasoning bypass | `reasoning_runaway_min_tokens`, `reasoning_runaway_max_completion_tokens`, `reasoning_runaway_consecutive_samples` | 512 tokens/sample, completion <= 16, 2 samples |
//! | Judge arbitration | `near_repetition_jaccard`, `near_repetition_strong_jaccard` | arbitrate in 0.85..0.90 only |
//!
//! # Deviations from the plan's wording (documented on purpose)
//!
//! * **Compression proxy instead of zlib.** See [`LoopDetectorConfig::compression_min_redundancy`]
//!   and the `compression` module: no new dependency, honest approximation,
//!   conservative direction.
//! * **Compression ratio scale.** The plan's `>= 0.6` is interpreted on the
//!   redundancy scale (`1 - compressed/original`), the only reading under which
//!   ">= 0.6" means "repetitive".
//! * **Near-repetition scales.** The plan names one window; a single span pair
//!   cannot see a repetition whose period is close to or larger than the span, so
//!   similarity is evaluated at several scales (including the interval observed in
//!   the exact-block index, and twice that interval). This is what makes a
//!   long-period repeated block detectable without loosening the pinned verbatim
//!   rule.
//! * **Long-period verbatim repetition surfaces as [`LoopKind::NearRepetition`].**
//!   The verbatim rule's 400-character mean-distance cap is kept exactly as
//!   pinned, so an identical block repeated at a long interval is reported through
//!   the interval-scale similarity (with a near-1.0 ratio) instead of a loosened
//!   verbatim rule.
//! * **Predictable enumeration is reported only when it explains something.**
//!   [`LoopKind::PredictableDrift`] needs an otherwise-repetitive region (a
//!   verbatim, periodic, or near-repetition candidate) to explain; a bare counter
//!   series that produces no repetition candidate has nothing to explain and is
//!   not reported.
//! * **Duplicate suppression.** Dedup is kind-scoped, as described above.
//!   Escalation on a *strengthening* loop is the intervention ladder's job, since
//!   it owns the attempt counters.

mod compression;
mod drift;
mod normalize;
mod output;
mod similarity;
mod structure;
mod thinking;

pub use output::{LoopDetectionState, OutputLoopDetector};
pub use thinking::{ThinkingLoopDetector, ThinkingLoopState};

use serde::{Deserialize, Serialize};

/// Which degenerate repetition signature a verdict describes.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum LoopKind {
    /// The same normalized character block recurs many times close together.
    VerbatimBlock,
    /// Two comparable text windows are near-identical.
    NearRepetition,
    /// A connector token run repeats without progress.
    PhraseStuck,
    /// A short unit repeats with a fixed period.
    PeriodicSequence,
    /// The text is a predictable enumeration (counter or letter series).
    PredictableDrift,
    /// Adjacent thinking blocks are near-identical.
    ThinkingStagnation,
    /// Opaque reasoning keeps growing while completion output stays empty.
    ReasoningRunaway,
}

impl LoopKind {
    /// Stable snake_case identifier, matching the serde representation.
    pub const fn as_str(self) -> &'static str {
        match self {
            Self::VerbatimBlock => "verbatim_block",
            Self::NearRepetition => "near_repetition",
            Self::PhraseStuck => "phrase_stuck",
            Self::PeriodicSequence => "periodic_sequence",
            Self::PredictableDrift => "predictable_drift",
            Self::ThinkingStagnation => "thinking_stagnation",
            Self::ReasoningRunaway => "reasoning_runaway",
        }
    }

    /// Whether this kind describes user-visible output rather than thinking.
    pub const fn is_output_loop(self) -> bool {
        matches!(
            self,
            Self::VerbatimBlock
                | Self::NearRepetition
                | Self::PhraseStuck
                | Self::PeriodicSequence
                | Self::PredictableDrift
        )
    }
}

impl std::fmt::Display for LoopKind {
    fn fmt(&self, formatter: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        formatter.write_str(self.as_str())
    }
}

/// Bounded, plain-data evidence for one verdict.
///
/// `samples` are shortened excerpts of the offending text (at most
/// `evidence_sample_limit` entries, each truncated to `evidence_sample_chars`
/// characters). They are safe for telemetry in size, but they *are* assistant
/// content: a caller that persists or transmits them still owns redaction of
/// secrets or user data.
#[derive(Debug, Clone, Default, PartialEq, Serialize, Deserialize)]
pub struct LoopEvidence {
    /// Occurrences of the repeated unit (or enumeration samples for drift,
    /// qualifying usage samples for a reasoning runaway).
    pub occurrences: usize,
    /// Consecutive repetitions, stagnation pairs, or runaway samples observed.
    pub consecutive_repeats: usize,
    /// Mean distance between occurrences of the repeated unit, in characters.
    pub mean_interval_chars: Option<f32>,
    /// Highest similarity ratio observed for this verdict.
    pub max_similarity: Option<f32>,
    /// Window scale (characters) whose comparison produced the verdict.
    pub matched_scale_chars: Option<usize>,
    /// Detected period in units (see `period_unit_chars`) for a periodic sequence.
    pub period_units: Option<usize>,
    /// Character span of the offending region inside the analysis window.
    pub span_chars: Option<usize>,
    /// Compression proxy redundancy of the analyzed window, when measured.
    pub compression_redundancy: Option<f32>,
    /// Reasoning-token delta of the sample that produced a runaway verdict.
    pub reasoning_tokens_delta: Option<u64>,
    /// Completion-token delta of the sample that produced a runaway verdict.
    pub completion_tokens_delta: Option<u64>,
    /// `true` when the L1 signal is boundary-level and the L2 judge should
    /// arbitrate before the ladder escalates. `false` means the signal is either
    /// confident enough to act on or deliberately benign (low-confidence kinds).
    pub requires_arbitration: bool,
    /// Bounded excerpts of the offending text.
    pub samples: Vec<String>,
}

impl LoopEvidence {
    /// Copies the bounded sample list from strings, truncating each entry.
    fn with_samples(mut self, samples: Vec<String>, limit: usize, max_chars: usize) -> Self {
        self.samples = samples
            .into_iter()
            .take(limit.max(1))
            .map(|sample| truncate_sample(&sample, max_chars))
            .collect();
        self
    }
}

/// Detection result for one analysis.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct LoopVerdict {
    /// Which degenerate signature was recognized.
    pub kind: LoopKind,
    /// Confidence in `0.0..=1.0`. Compare against the caller's policy band; the
    /// detector does not own the escalation thresholds.
    pub confidence: f32,
    /// Bounded evidence for telemetry, judging, and steering copy.
    pub evidence: LoopEvidence,
}

impl LoopVerdict {
    /// Whether the L2 judge should arbitrate before escalation.
    pub fn requires_arbitration(&self) -> bool {
        self.evidence.requires_arbitration
    }
}

/// Truncates a sample to `max_chars` characters, appending an ellipsis marker.
fn truncate_sample(sample: &str, max_chars: usize) -> String {
    let max_chars = max_chars.max(1);
    if sample.chars().count() <= max_chars {
        return sample.to_string();
    }
    let mut truncated: String = sample.chars().take(max_chars).collect();
    truncated.push_str("...");
    truncated
}

/// Default normalized block length for exact-block repetition.
const DEFAULT_BLOCK_CHARS: usize = 50;
/// Default cap on retained normalized characters.
const DEFAULT_WINDOW_CHARS: usize = 16_384;
/// Default minimum normalized characters in the window before any verdict.
const DEFAULT_MIN_ANALYZED_CHARS: usize = 400;
/// Default minimum newly normalized characters between two analyses. Matches the
/// plan's "throttle the window analysis to every 4 KB or every round" guidance.
const DEFAULT_ANALYSIS_STRIDE_CHARS: usize = 4096;
/// Default number of retained evidence samples.
const DEFAULT_EVIDENCE_SAMPLE_LIMIT: usize = 3;
/// Default truncation length of one evidence sample.
const DEFAULT_EVIDENCE_SAMPLE_CHARS: usize = 80;
/// Default similarity scales for near-repetition comparison.
const DEFAULT_NEAR_REPETITION_SCALES: [usize; 3] = [512, 2048, 8192];
/// Default connector seed list from the plan's "stuck landing token" list.
const DEFAULT_PHRASE_STUCK_TOKENS: [&str; 6] = ["wait", "so", "but", "alternatively", "the", "yes"];
/// Minimum retained window size; a smaller window cannot hold the pinned rules.
const MIN_WINDOW_CHARS: usize = 256;

/// Thresholds and window sizes for both detectors.
///
/// `Default` yields the plan's initial values. All fields are meant to be
/// policy-driven later; keep hard-coded thresholds out of the detector.
#[derive(Debug, Clone, PartialEq)]
pub struct LoopDetectorConfig {
    /// Normalized characters retained for analysis. Older characters are pruned.
    pub window_chars: usize,
    /// Minimum normalized characters before any verdict is produced.
    pub min_analyzed_chars: usize,
    /// Minimum newly normalized characters between two automatic analyses when
    /// feeding incrementally. This is the detector's own hot-path throttle.
    pub analysis_stride_chars: usize,
    /// Maximum number of evidence samples per verdict.
    pub evidence_sample_limit: usize,
    /// Maximum characters per evidence sample.
    pub evidence_sample_chars: usize,
    /// Block length for exact-block repetition.
    pub block_chars: usize,
    /// Whether markdown structure lines are excluded from repetition analysis.
    pub structure_exclusion_enabled: bool,
    /// Cap on a buffered partial line before it is flushed as content.
    pub line_buffer_max_chars: usize,
    /// Minimum occurrences of the same block to report a verbatim loop.
    pub verbatim_min_occurrences: usize,
    /// Maximum mean distance between verbatim repetitions, in characters.
    pub verbatim_max_mean_interval_chars: f32,
    /// Confidence reported for a verbatim block.
    pub verbatim_confidence: f32,
    /// Window scales (characters) used for near-repetition comparison.
    pub near_repetition_scales_chars: Vec<usize>,
    /// Character n-gram length used by every similarity comparison.
    pub near_repetition_ngram_chars: usize,
    /// Jaccard ratio at which a window pair is suspicious.
    pub near_repetition_jaccard: f32,
    /// Jaccard ratio at which a window pair is a strong match.
    pub near_repetition_strong_jaccard: f32,
    /// Confidence for a suspicious (arbitration) near-repetition.
    pub near_repetition_confidence: f32,
    /// Confidence for a strong near-repetition.
    pub near_repetition_strong_confidence: f32,
    /// Maximum period, in units, considered a periodic sequence.
    pub period_max_units: usize,
    /// Minimum consecutive repetitions of the period.
    pub period_min_repeats: usize,
    /// Maximum consecutive repetitions counted (bounds the per-analysis cost).
    pub period_max_repeats: usize,
    /// Length of one period unit, in normalized characters.
    pub period_unit_chars: usize,
    /// Maximum character differences for two period units to count as the same
    /// phase. A period of near-identical units is detected without building
    /// n-gram sets per comparison.
    pub period_unit_max_diff_chars: usize,
    /// Confidence reported for a periodic sequence.
    pub periodic_confidence: f32,
    /// Minimum consecutive connector tokens for a phrase-stuck verdict.
    pub phrase_stuck_min_consecutive: usize,
    /// Trailing characters examined for connector runs.
    pub phrase_stuck_span_chars: usize,
    /// Connector seed tokens; matched case-insensitively as whole tokens.
    pub phrase_stuck_tokens: Vec<String>,
    /// Confidence reported for a stuck connector phrase.
    pub phrase_stuck_confidence: f32,
    /// Characters fed into the compression proxy.
    pub compression_span_chars: usize,
    /// Back-reference window of the compression proxy.
    pub compression_window_chars: usize,
    /// Shortest match accepted by the compression proxy.
    pub compression_min_match_chars: usize,
    /// Maximum match-chain probes per position in the compression proxy.
    pub compression_max_chain_attempts: usize,
    /// Estimated bit cost of a literal in the compression proxy.
    pub compression_literal_bits: u32,
    /// Estimated bit cost of a match in the compression proxy.
    pub compression_match_bits: u32,
    /// Redundancy (`1 - compressed/original`) at which a window counts as
    /// repetitive. Corroborates a suspicious near-repetition only.
    pub compression_min_redundancy: f32,
    /// Trailing characters scanned for predictable enumerations.
    pub predictable_drift_span_chars: usize,
    /// Minimum lines (samples) in a counter progression.
    pub predictable_drift_min_samples: usize,
    /// Maximum fraction of differing tokens between two enumeration lines.
    pub predictable_drift_max_diff_ratio: f32,
    /// Confidence reported for a predictable enumeration. Deliberately low: the
    /// caller must not treat a counter series as a hard loop.
    pub predictable_drift_confidence: f32,
    /// Minimum normalized characters for a thinking block to be compared.
    pub thinking_min_block_chars: usize,
    /// Trailing characters of a thinking block used for similarity.
    pub thinking_block_compare_chars: usize,
    /// Adjacent thinking-block similarity at which one stagnation is counted.
    pub thinking_adjacent_similarity: f32,
    /// Consecutive stagnation pairs that produce a verdict.
    pub thinking_stagnation_pairs: usize,
    /// Confidence reported for thinking stagnation.
    pub thinking_stagnation_confidence: f32,
    /// Minimum reasoning-token delta per usage sample to count as growth.
    pub reasoning_runaway_min_tokens: u64,
    /// Maximum completion-token delta per usage sample to count as stalled.
    pub reasoning_runaway_max_completion_tokens: u64,
    /// Consecutive qualifying usage samples that produce a verdict.
    pub reasoning_runaway_consecutive_samples: usize,
    /// Confidence cap for the opaque-reasoning signal.
    pub reasoning_runaway_confidence: f32,
}

impl Default for LoopDetectorConfig {
    fn default() -> Self {
        Self {
            window_chars: DEFAULT_WINDOW_CHARS,
            min_analyzed_chars: DEFAULT_MIN_ANALYZED_CHARS,
            analysis_stride_chars: DEFAULT_ANALYSIS_STRIDE_CHARS,
            evidence_sample_limit: DEFAULT_EVIDENCE_SAMPLE_LIMIT,
            evidence_sample_chars: DEFAULT_EVIDENCE_SAMPLE_CHARS,
            block_chars: DEFAULT_BLOCK_CHARS,
            structure_exclusion_enabled: true,
            line_buffer_max_chars: normalize::DEFAULT_LINE_BUFFER_MAX_CHARS,
            verbatim_min_occurrences: 4,
            verbatim_max_mean_interval_chars: 400.0,
            verbatim_confidence: 0.95,
            near_repetition_scales_chars: DEFAULT_NEAR_REPETITION_SCALES.to_vec(),
            near_repetition_ngram_chars: 5,
            near_repetition_jaccard: 0.85,
            near_repetition_strong_jaccard: 0.90,
            near_repetition_confidence: 0.60,
            near_repetition_strong_confidence: 0.88,
            period_max_units: 5,
            period_min_repeats: 4,
            period_max_repeats: 16,
            period_unit_chars: DEFAULT_BLOCK_CHARS,
            period_unit_max_diff_chars: 6,
            periodic_confidence: 0.90,
            phrase_stuck_min_consecutive: 8,
            phrase_stuck_span_chars: 512,
            phrase_stuck_tokens: DEFAULT_PHRASE_STUCK_TOKENS
                .iter()
                .map(|token| (*token).to_string())
                .collect(),
            phrase_stuck_confidence: 0.90,
            compression_span_chars: 4096,
            compression_window_chars: 4096,
            compression_min_match_chars: 4,
            compression_max_chain_attempts: 32,
            compression_literal_bits: 9,
            compression_match_bits: 24,
            compression_min_redundancy: 0.60,
            predictable_drift_span_chars: 4096,
            predictable_drift_min_samples: 4,
            predictable_drift_max_diff_ratio: 0.5,
            predictable_drift_confidence: 0.25,
            thinking_min_block_chars: 40,
            thinking_block_compare_chars: 2048,
            thinking_adjacent_similarity: 0.70,
            thinking_stagnation_pairs: 2,
            thinking_stagnation_confidence: 0.75,
            reasoning_runaway_min_tokens: 512,
            reasoning_runaway_max_completion_tokens: 16,
            reasoning_runaway_consecutive_samples: 2,
            reasoning_runaway_confidence: 0.35,
        }
    }
}

impl LoopDetectorConfig {
    /// Clamps nonsensical values so a misconfigured policy cannot panic or
    /// divide by zero. Called by every detector constructor.
    pub fn sanitized(mut self) -> Self {
        self.window_chars = self.window_chars.max(MIN_WINDOW_CHARS);
        self.min_analyzed_chars = self.min_analyzed_chars.min(self.window_chars);
        self.analysis_stride_chars = self.analysis_stride_chars.max(1);
        self.evidence_sample_limit = self.evidence_sample_limit.max(1);
        self.evidence_sample_chars = self.evidence_sample_chars.max(8);
        self.block_chars = self.block_chars.max(1).min(self.window_chars / 2).max(1);
        self.line_buffer_max_chars = self.line_buffer_max_chars.max(16);
        self.verbatim_min_occurrences = self.verbatim_min_occurrences.max(2);
        self.verbatim_max_mean_interval_chars = self.verbatim_max_mean_interval_chars.max(1.0);
        self.near_repetition_ngram_chars = self.near_repetition_ngram_chars.max(1);
        self.near_repetition_scales_chars = {
            let min_scale = self.near_repetition_ngram_chars + 1;
            let mut scales: Vec<usize> = self
                .near_repetition_scales_chars
                .into_iter()
                .filter(|scale| *scale >= min_scale)
                .collect();
            if scales.is_empty() {
                scales.push(min_scale);
            }
            scales.sort_unstable();
            scales.dedup();
            scales
        };
        self.near_repetition_jaccard = self.near_repetition_jaccard.clamp(0.0, 1.0);
        self.near_repetition_strong_jaccard = self
            .near_repetition_strong_jaccard
            .clamp(self.near_repetition_jaccard, 1.0);
        self.period_max_units = self.period_max_units.clamp(1, 64);
        self.period_min_repeats = self.period_min_repeats.max(2);
        self.period_max_repeats = self.period_max_repeats.max(self.period_min_repeats);
        self.period_unit_chars = self
            .period_unit_chars
            .max(1)
            .min(self.window_chars / 2)
            .max(1);
        // Never let the unit-match tolerance swallow the whole unit: a unit may
        // differ in at most a quarter of its characters.
        self.period_unit_max_diff_chars = self
            .period_unit_max_diff_chars
            .min(self.period_unit_chars / 4);
        self.phrase_stuck_min_consecutive = self.phrase_stuck_min_consecutive.max(2);
        self.phrase_stuck_span_chars = self.phrase_stuck_span_chars.max(32);
        self.compression_span_chars = self.compression_span_chars.max(64);
        self.compression_window_chars = self.compression_window_chars.max(16);
        self.compression_min_match_chars = self.compression_min_match_chars.max(2);
        self.compression_max_chain_attempts = self.compression_max_chain_attempts.max(1);
        self.compression_literal_bits = self.compression_literal_bits.max(1);
        self.compression_match_bits = self.compression_match_bits.max(1);
        self.compression_min_redundancy = self.compression_min_redundancy.clamp(0.0, 1.0);
        self.predictable_drift_span_chars = self.predictable_drift_span_chars.max(64);
        self.predictable_drift_min_samples = self.predictable_drift_min_samples.max(2);
        self.predictable_drift_max_diff_ratio =
            self.predictable_drift_max_diff_ratio.clamp(0.0, 1.0);
        self.predictable_drift_confidence = self.predictable_drift_confidence.clamp(0.0, 1.0);
        self.thinking_min_block_chars = self.thinking_min_block_chars.max(1);
        self.thinking_block_compare_chars = self.thinking_block_compare_chars.max(32);
        self.thinking_adjacent_similarity = self.thinking_adjacent_similarity.clamp(0.0, 1.0);
        self.thinking_stagnation_pairs = self.thinking_stagnation_pairs.max(1);
        self.reasoning_runaway_min_tokens = self.reasoning_runaway_min_tokens.max(1);
        self.reasoning_runaway_consecutive_samples =
            self.reasoning_runaway_consecutive_samples.max(1);
        self.reasoning_runaway_confidence = self.reasoning_runaway_confidence.clamp(0.0, 1.0);
        self.verbatim_confidence = self.verbatim_confidence.clamp(0.0, 1.0);
        self.near_repetition_confidence = self.near_repetition_confidence.clamp(0.0, 1.0);
        self.near_repetition_strong_confidence =
            self.near_repetition_strong_confidence.clamp(0.0, 1.0);
        self.periodic_confidence = self.periodic_confidence.clamp(0.0, 1.0);
        self.phrase_stuck_confidence = self.phrase_stuck_confidence.clamp(0.0, 1.0);
        self.thinking_stagnation_confidence = self.thinking_stagnation_confidence.clamp(0.0, 1.0);
        self
    }

    /// Character n-gram length used by every similarity comparison.
    pub fn ngram_chars(&self) -> usize {
        self.near_repetition_ngram_chars
    }
}
