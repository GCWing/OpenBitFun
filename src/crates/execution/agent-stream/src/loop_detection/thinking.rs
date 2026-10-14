//! Thinking-stream loop detector.
//!
//! The plan makes thinking loops the first-priority use case and names three
//! signals: near-identical adjacent thinking blocks, connector-phrase stalling,
//! and the usage bypass that is the *only* observable signal when a provider
//! keeps its reasoning encrypted (OpenAI reasoning models). This module
//! implements all three.
//!
//! Confidence policy for the usage bypass is deliberately restrictive: the
//! signal cannot tell a long legitimate reasoning phase from a loop, so it is
//! capped at [`LoopDetectorConfig::reasoning_runaway_confidence`] and never asks
//! for judge arbitration. The plan's rule ("steer only, never abort hard" on the
//! opaque signal) is expressed by that cap plus `requires_arbitration = false`.

use super::normalize::{normalize_fragment, tokenize};
use super::similarity::{char_ngram_jaccard, longest_connector_run};
use super::{LoopDetectorConfig, LoopEvidence, LoopKind, LoopVerdict};

/// Snapshot of everything a [`ThinkingLoopDetector`] accumulates.
#[derive(Debug, Clone)]
pub struct ThinkingLoopState {
    last_block: Option<String>,
    stagnation_streak: usize,
    runaway_streak: usize,
    reported_kinds: Vec<LoopKind>,
}

impl ThinkingLoopState {
    fn empty() -> Self {
        Self {
            last_block: None,
            stagnation_streak: 0,
            runaway_streak: 0,
            reported_kinds: Vec::new(),
        }
    }

    /// Consecutive adjacent-block similarity hits currently recorded.
    pub fn stagnation_streak(&self) -> usize {
        self.stagnation_streak
    }

    /// Consecutive qualifying usage samples currently recorded.
    pub fn reasoning_runaway_streak(&self) -> usize {
        self.runaway_streak
    }
}

impl Default for ThinkingLoopState {
    fn default() -> Self {
        Self::empty()
    }
}

/// Detects degeneracy in thinking/reasoning streams.
#[derive(Debug, Clone)]
pub struct ThinkingLoopDetector {
    config: LoopDetectorConfig,
    state: ThinkingLoopState,
}

impl Default for ThinkingLoopDetector {
    fn default() -> Self {
        Self::with_config(LoopDetectorConfig::default())
    }
}

impl ThinkingLoopDetector {
    /// Creates a detector with the plan's initial thresholds.
    pub fn new() -> Self {
        Self::default()
    }

    /// Creates a detector with explicit thresholds.
    pub fn with_config(config: LoopDetectorConfig) -> Self {
        let config = config.sanitized();
        Self {
            config,
            state: ThinkingLoopState::empty(),
        }
    }

    /// Resumes from a previously captured state.
    pub fn from_state(config: LoopDetectorConfig, state: ThinkingLoopState) -> Self {
        Self {
            config: config.sanitized(),
            state,
        }
    }

    /// Effective configuration after sanitizing.
    pub fn config(&self) -> &LoopDetectorConfig {
        &self.config
    }

    /// Current detector state, for snapshotting.
    pub fn state(&self) -> &ThinkingLoopState {
        &self.state
    }

    /// Clears streaks and block memory (`clearDetection`).
    pub fn reset(&mut self) {
        self.state = ThinkingLoopState::empty();
    }

    /// Clears only the reported-loop memory, keeping the block history.
    ///
    /// Use this when the caller wants the same still-present loop reported again,
    /// for example once per dialog round while the ladder counts attempts.
    pub fn clear_reported(&mut self) {
        self.state.reported_kinds.clear();
    }

    /// Feeds one completed thinking/reasoning block.
    ///
    /// Blocks shorter than `thinking_min_block_chars` are ignored entirely: they
    /// are not compared and they do not reset the stagnation streak, because
    /// short interleaved blocks are normal in streamed thinking.
    pub fn feed_block(&mut self, block: &str) -> Option<LoopVerdict> {
        let normalized = normalize_fragment(
            block,
            self.config.structure_exclusion_enabled,
            self.config.line_buffer_max_chars,
        );
        let block_chars = normalized.chars().count();
        if block_chars < self.config.thinking_min_block_chars {
            return None;
        }

        let phrase = self.phrase_stuck_candidate(&normalized);
        let comparison = self.comparison_tail(&normalized);
        let similarity = self.state.last_block.as_deref().and_then(|previous| {
            char_ngram_jaccard(previous, comparison, self.config.ngram_chars())
        });

        if similarity.is_some_and(|value| value >= self.config.thinking_adjacent_similarity) {
            self.state.stagnation_streak += 1;
        } else {
            self.state.stagnation_streak = 0;
        }
        let previous_block = self.state.last_block.replace(comparison.to_string());

        if let Some((repeats, sample)) = phrase {
            let evidence = LoopEvidence {
                occurrences: repeats,
                consecutive_repeats: repeats,
                max_similarity: similarity,
                requires_arbitration: false,
                ..Default::default()
            }
            .with_samples(
                vec![sample],
                self.config.evidence_sample_limit,
                self.config.evidence_sample_chars,
            );
            return self.finish(
                LoopKind::PhraseStuck,
                self.config.phrase_stuck_confidence,
                evidence,
            );
        }

        if self.state.stagnation_streak >= self.config.thinking_stagnation_pairs {
            let samples = previous_block
                .map(|previous| vec![previous, comparison.to_string()])
                .unwrap_or_else(|| vec![comparison.to_string()]);
            let evidence = LoopEvidence {
                occurrences: self.state.stagnation_streak,
                consecutive_repeats: self.state.stagnation_streak,
                max_similarity: similarity,
                span_chars: Some(comparison.chars().count()),
                requires_arbitration: true,
                ..Default::default()
            }
            .with_samples(
                samples,
                self.config.evidence_sample_limit,
                self.config.evidence_sample_chars,
            );
            return self.finish(
                LoopKind::ThinkingStagnation,
                self.config.thinking_stagnation_confidence,
                evidence,
            );
        }

        None
    }

    /// Feeds one usage sample of reasoning/completion token deltas.
    ///
    /// The caller decides the sampling cadence; the detector only compares
    /// consecutive samples, so no clock is involved.
    pub fn feed_usage(
        &mut self,
        reasoning_tokens_delta: u64,
        completion_tokens_delta: u64,
    ) -> Option<LoopVerdict> {
        let qualifies = reasoning_tokens_delta >= self.config.reasoning_runaway_min_tokens
            && completion_tokens_delta <= self.config.reasoning_runaway_max_completion_tokens;
        if !qualifies {
            // The episode ends here: the streak resets and the kind becomes
            // reportable again, so a later sustained growth is not silently
            // suppressed forever.
            self.state.runaway_streak = 0;
            self.state
                .reported_kinds
                .retain(|kind| *kind != LoopKind::ReasoningRunaway);
            return None;
        }

        self.state.runaway_streak += 1;
        if self.state.runaway_streak < self.config.reasoning_runaway_consecutive_samples {
            return None;
        }

        let evidence = LoopEvidence {
            occurrences: self.state.runaway_streak,
            consecutive_repeats: self.state.runaway_streak,
            reasoning_tokens_delta: Some(reasoning_tokens_delta),
            completion_tokens_delta: Some(completion_tokens_delta),
            requires_arbitration: false,
            ..Default::default()
        };
        // Dedup is kind-scoped like every other verdict; the episode reset above
        // is what re-arms this signal.
        self.finish(
            LoopKind::ReasoningRunaway,
            self.config.reasoning_runaway_confidence,
            evidence,
        )
    }

    fn comparison_tail<'a>(&self, normalized: &'a str) -> &'a str {
        let chars = normalized.chars().count();
        let keep = chars.min(self.config.thinking_block_compare_chars);
        let skip = chars - keep;
        match normalized.char_indices().nth(skip) {
            Some((offset, _)) => &normalized[offset..],
            None => normalized,
        }
    }

    fn phrase_stuck_candidate(&self, normalized: &str) -> Option<(usize, String)> {
        let chars = normalized.chars().count();
        let keep = chars.min(self.config.phrase_stuck_span_chars);
        let skip = chars - keep;
        let text = match normalized.char_indices().nth(skip) {
            Some((offset, _)) => &normalized[offset..],
            None => normalized,
        };
        let tokens = tokenize(text);
        let run = longest_connector_run(&tokens, &self.config.phrase_stuck_tokens)?;
        if run.len < self.config.phrase_stuck_min_consecutive {
            return None;
        }
        Some((run.len, tokens[run.start..run.start + run.len].join(" ")))
    }

    fn finish(
        &mut self,
        kind: LoopKind,
        confidence: f32,
        evidence: LoopEvidence,
    ) -> Option<LoopVerdict> {
        if self.state.reported_kinds.contains(&kind) {
            return None;
        }
        self.state.reported_kinds.push(kind);
        Some(LoopVerdict {
            kind,
            confidence,
            evidence,
        })
    }
}
