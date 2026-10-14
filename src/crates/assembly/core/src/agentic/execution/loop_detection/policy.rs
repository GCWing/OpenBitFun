//! Translation of the loop-detection tier policy into detector configuration.
//!
//! The two owners cannot call each other: `openbitfun-agent-runtime` owns the
//! `(context profile, model capability)` tier table and must not depend on the
//! detector crate, and `openbitfun-agent-stream` owns the detector baselines
//! without knowing profiles exist. So the mapping is product wiring and lives
//! here, as one pure function.
//!
//! Precedence, per plan decision 2 and the calibration phase:
//!
//! 1. an explicit user override (`ai.loop_detection.thresholds.*`) wins outright;
//! 2. otherwise the tier scale applies to the detector's calibrated baseline;
//! 3. the detector's own baseline is the fallback when neither is set.
//!
//! Three knobs deliberately do not follow the tier helper literally, because
//! doing so would move them in the wrong direction, leave their domain, or
//! invent semantics the detector does not have:
//!
//! * `exact_block_max_mean_gap_chars` is a distance cap. A stricter tier asks
//!   for *closer* repeats, which is not `baseline * scale`, so the baseline
//!   stands unless the user overrides it.
//! * similarity and ratio thresholds are scaled in the *tolerance* domain by
//!   [`similarity_threshold`]. Multiplying a ratio baseline by the tier scale
//!   leaves the `0.0..=1.0` domain as soon as the scale exceeds about `1.18`
//!   (Conversation is `1.25`/`1.5`), and a saturated ratio would effectively
//!   disable the signal exactly where the calibration phase needs data from it.
//! * `reasoning_bypass_min_tokens_per_sec` is a rate, while the detector samples
//!   once per model round and has no clock (a documented property of the pure
//!   detector core). The configured rate is applied as the per-round sample
//!   minimum, and this deviation is recorded here on purpose: the calibration
//!   phase is the place to re-derive it from measured round durations.

use openbitfun_agent_runtime::context_profile::{ContextProfilePolicy, LoopDetectionPolicy};
use openbitfun_agent_stream::LoopDetectorConfig;
use openbitfun_config_contracts::LoopDetectionThresholdOverridesConfig;

/// Builds the detector configuration for one turn.
pub fn loop_detector_config(
    policy: &ContextProfilePolicy,
    overrides: &LoopDetectionThresholdOverridesConfig,
) -> LoopDetectorConfig {
    let baseline = LoopDetectorConfig::default();
    let tier = policy.loop_detection;

    LoopDetectorConfig {
        // Exact-block repetition.
        block_chars: count_override(
            overrides.exact_block_hash_chars,
            tier.scale_count(baseline.block_chars),
        ),
        verbatim_min_occurrences: count_override(
            overrides.exact_block_min_occurrences,
            tier.scale_count(baseline.verbatim_min_occurrences),
        ),
        verbatim_max_mean_interval_chars: distance_override(
            overrides.exact_block_max_mean_gap_chars,
            baseline.verbatim_max_mean_interval_chars,
        ),
        // Similarity thresholds.
        near_repetition_jaccard: similarity_threshold(
            policy,
            overrides.ngram_window_similarity_min,
            baseline.near_repetition_jaccard,
        ),
        near_repetition_strong_jaccard: similarity_threshold(
            policy,
            overrides.ngram_window_strong_similarity,
            baseline.near_repetition_strong_jaccard,
        ),
        // Thinking signals.
        thinking_adjacent_similarity: similarity_threshold(
            policy,
            overrides.thinking_block_similarity_min,
            baseline.thinking_adjacent_similarity,
        ),
        thinking_stagnation_pairs: count_override(
            overrides.thinking_stall_steps,
            tier.scale_count(baseline.thinking_stagnation_pairs),
        ),
        phrase_stuck_min_consecutive: count_override(
            overrides.stuck_phrase_min_repeats,
            tier.scale_count(baseline.phrase_stuck_min_consecutive),
        ),
        compression_min_redundancy: similarity_threshold(
            policy,
            overrides.window_compression_ratio_min,
            baseline.compression_min_redundancy,
        ),
        // Usage bypass for opaque reasoning.
        reasoning_runaway_min_tokens: overrides
            .reasoning_bypass_min_tokens_per_sec
            .filter(|value| *value > 0)
            .map_or(baseline.reasoning_runaway_min_tokens, |value| {
                u64::from(value)
            }),
        reasoning_runaway_consecutive_samples: count_override(
            overrides.reasoning_bypass_min_rounds,
            tier.scale_count(baseline.reasoning_runaway_consecutive_samples),
        ),
        // Structural exclusions are policy data, not a numeric threshold.
        structure_exclusion_enabled: structure_exclusions_enabled(tier),
        ..baseline
    }
}

/// Whether the detector's structural exclusion pass is enabled for `policy`.
///
/// The policy lists the structural classes whose repetition is legitimate. The
/// detector implements the canonical class set as a single normalizer pass with
/// one switch, so any non-empty exclusion set turns the pass on: a policy that
/// excludes a strict subset keeps the protection it can express instead of
/// silently disabling structure exclusion entirely.
pub fn structure_exclusions_enabled(policy: LoopDetectionPolicy) -> bool {
    !policy.structural_exclusions.is_empty()
}

/// An explicit count override wins; a non-positive value counts as unset so a
/// stray zero cannot disable a signal silently.
fn count_override(configured: Option<u32>, fallback: usize) -> usize {
    configured
        .filter(|value| *value > 0)
        .map_or(fallback, |value| value as usize)
}

/// A distance cap is not scaled by the tier; see the module documentation.
fn distance_override(configured: Option<u32>, baseline: f32) -> f32 {
    configured
        .filter(|value| *value > 0)
        .map_or(baseline, |value| value as f32)
}

/// Resolve a similarity / ratio threshold.
///
/// Override precedence belongs to the tier policy
/// (`resolve_loop_detection_threshold`): an explicit calibration knob wins
/// outright over the tier scale, and a non-positive override counts as unset.
///
/// The tier path scales the *tolerance* (`1 - baseline`) instead of the ratio
/// itself. A stricter tier then asks for a tighter tolerance
/// (`0.85 -> 0.88 -> 0.90`), which is monotone in the scale, never leaves
/// `0.0..=1.0`, and keeps the signal reportable while it is still in the
/// telemetry-only calibration phase.
fn similarity_threshold(
    policy: &ContextProfilePolicy,
    configured: Option<f32>,
    baseline: f32,
) -> f32 {
    if configured.filter(|value| *value > 0.0).is_some() {
        return policy
            .resolve_loop_detection_threshold(configured, baseline)
            .clamp(0.0, 1.0);
    }
    let scale = policy.loop_detection.threshold_scale.max(f32::EPSILON);
    let tolerance = (1.0 - baseline).clamp(0.0, 1.0);
    (1.0 - tolerance / scale).clamp(0.0, 1.0)
}
