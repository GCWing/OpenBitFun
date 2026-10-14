//! Assistant-text loop detector.
//!
//! The detector keeps one bounded, normalized analysis window plus an incremental
//! rolling-block index, and derives every candidate from those two structures.
//! Nothing here touches IO, time, or randomness: the caller owns chunking and
//! forcing analyses, and can snapshot the whole state for cheap hand-off.

use std::collections::{HashMap, VecDeque};

use super::compression;
use super::drift;
use super::normalize::{self, Normalizer, RollingBlockHasher};
use super::similarity::{char_ngram_jaccard, longest_connector_run};
use super::{LoopDetectorConfig, LoopEvidence, LoopKind, LoopVerdict};

/// Snapshot of everything an [`OutputLoopDetector`] accumulates.
///
/// The structure is opaque on purpose: it exists so a caller can carry detector
/// state across turns or processes without re-feeding the whole window.
#[derive(Debug, Clone)]
pub struct LoopDetectionState {
    normalizer: Normalizer,
    analysis: String,
    char_bytes: Vec<u32>,
    /// Bytes of `analysis` already folded into the block index.
    indexed_bytes: usize,
    window_start_char: u64,
    total_chars: u64,
    hasher: RollingBlockHasher,
    block_index: HashMap<u64, VecDeque<u64>>,
    new_chars_since_analysis: usize,
    analysis_passes: u64,
    reported_kinds: Vec<LoopKind>,
}

impl LoopDetectionState {
    fn empty(config: &LoopDetectorConfig) -> Self {
        Self {
            normalizer: Normalizer::new(
                config.structure_exclusion_enabled,
                config.line_buffer_max_chars,
            ),
            analysis: String::new(),
            char_bytes: Vec::new(),
            indexed_bytes: 0,
            window_start_char: 0,
            total_chars: 0,
            hasher: RollingBlockHasher::new(config.block_chars),
            block_index: HashMap::new(),
            new_chars_since_analysis: 0,
            analysis_passes: 0,
            reported_kinds: Vec::new(),
        }
    }

    /// Normalized characters currently retained in the analysis window.
    pub fn window_chars(&self) -> usize {
        self.char_bytes.len()
    }

    /// Total normalized characters ever fed through this state.
    pub fn total_chars(&self) -> u64 {
        self.total_chars
    }

    /// Number of analysis passes that ran, for cost observability.
    pub fn analysis_passes(&self) -> u64 {
        self.analysis_passes
    }
}

impl Default for LoopDetectionState {
    fn default() -> Self {
        Self::empty(&LoopDetectorConfig::default())
    }
}

/// Detects repetition loops in assistant output text.
#[derive(Debug, Clone)]
pub struct OutputLoopDetector {
    config: LoopDetectorConfig,
    state: LoopDetectionState,
}

impl Default for OutputLoopDetector {
    fn default() -> Self {
        Self::with_config(LoopDetectorConfig::default())
    }
}

impl OutputLoopDetector {
    /// Creates a detector with the plan's initial thresholds.
    pub fn new() -> Self {
        Self::default()
    }

    /// Creates a detector with explicit thresholds.
    pub fn with_config(config: LoopDetectorConfig) -> Self {
        let config = config.sanitized();
        let state = LoopDetectionState::empty(&config);
        Self { config, state }
    }

    /// Resumes from a previously captured state.
    ///
    /// The window text and block index are rebuilt whenever the block length
    /// changed, so a policy that tightens `block_chars` mid-session loses no
    /// already-analyzed text.
    pub fn from_state(config: LoopDetectorConfig, mut state: LoopDetectionState) -> Self {
        let config = config.sanitized();
        if state.hasher.block_chars() != config.block_chars {
            state.hasher = RollingBlockHasher::new(config.block_chars);
            state.block_index.clear();
        }
        state.normalizer = Normalizer::new(
            config.structure_exclusion_enabled,
            config.line_buffer_max_chars,
        );
        let mut detector = Self { config, state };
        detector.rebuild_block_index();
        detector
    }

    /// Effective configuration after sanitizing.
    pub fn config(&self) -> &LoopDetectorConfig {
        &self.config
    }

    /// Current detector state, for snapshotting.
    pub fn state(&self) -> &LoopDetectionState {
        &self.state
    }

    /// Clears the window and all reported-loop memory (`clearDetection`).
    pub fn reset(&mut self) {
        self.state = LoopDetectionState::empty(&self.config);
    }

    /// Clears only the reported-loop memory, keeping the analysis window.
    ///
    /// Use this when the caller needs the same still-present loop to be reported
    /// again, for example once per dialog round while the intervention ladder is
    /// counting attempts. The plan's `clearDetection` escape hatch is
    /// [`OutputLoopDetector::reset`], which also forgets the window.
    pub fn clear_reported(&mut self) {
        self.state.reported_kinds.clear();
    }

    /// Appends a text chunk and analyzes once the stride is reached.
    ///
    /// Returns a verdict only when a new loop is recognized; repeated calls with
    /// unchanged content do not re-report the same loop.
    pub fn feed(&mut self, chunk: &str) -> Option<LoopVerdict> {
        if chunk.is_empty() {
            return None;
        }
        self.append(chunk);
        if self.state.new_chars_since_analysis >= self.config.analysis_stride_chars {
            self.analyze()
        } else {
            None
        }
    }

    /// Forces an analysis pass over the current window.
    ///
    /// Callers that batch per round should call this at the round boundary
    /// instead of relying on the internal stride.
    pub fn analyze(&mut self) -> Option<LoopVerdict> {
        // Emit whatever is still pending so a round boundary analyzes everything
        // that was fed, including a trailing line without a newline.
        self.flush_pending();
        self.state.new_chars_since_analysis = 0;
        self.state.analysis_passes = self.state.analysis_passes.saturating_add(1);
        self.prune();
        if self.state.char_bytes.len() < self.config.min_analyzed_chars {
            return None;
        }

        let phrase = self.phrase_stuck_candidate();
        let verbatim = self.verbatim_candidate();
        let periodic = self.periodic_candidate();
        let near = self.near_repetition_candidate();
        let any_repetition = verbatim.is_some() || periodic.is_some() || near.is_some();

        let mut drift = if any_repetition {
            self.drift_candidate()
        } else {
            None
        };
        let compression = if any_repetition || phrase.is_some() {
            self.compression_redundancy()
        } else {
            None
        };

        if let Some(phrase) = phrase {
            return self.finish_phrase_stuck(phrase, compression);
        }

        if let Some(run) = drift.as_ref() {
            let explained = verbatim
                .as_ref()
                .is_some_and(|candidate| run_explains(run, candidate.start, candidate.end))
                || periodic
                    .as_ref()
                    .is_some_and(|candidate| run_explains(run, candidate.start, candidate.end))
                || near.as_ref().is_some_and(|candidate| {
                    run_explains(run, candidate.tail_start, candidate.tail_end)
                });
            if explained {
                return self.finish_predictable_drift(run, compression);
            }
        }

        if let Some(verbatim) = verbatim {
            return self.finish_verbatim(verbatim, compression);
        }
        if let Some(periodic) = periodic {
            return self.finish_periodic(periodic, compression);
        }
        if let Some(near) = near {
            return self.finish_near_repetition(near, compression);
        }

        // Nothing loop-like was found. A predictable enumeration is still worth
        // classifying so the caller can tell a counter series apart from a loop
        // instead of guessing why nothing was reported.
        if drift.is_none() {
            drift = self.drift_candidate();
        }
        if let Some(run) = drift.as_ref() {
            let compression = compression.or_else(|| self.compression_redundancy());
            return self.finish_predictable_drift(run, compression);
        }
        None
    }

    /// Compression proxy redundancy of the current window, on demand.
    ///
    /// `None` when the window is too short to measure. The value is also attached
    /// to every verdict's evidence when a candidate fires.
    pub fn compression_redundancy(&self) -> Option<f32> {
        let input = self.compression_input()?;
        compression::compression_redundancy(input, &self.config)
    }

    // ------------------------- ingestion -------------------------

    fn append(&mut self, chunk: &str) {
        self.state.normalizer.push(chunk, &mut self.state.analysis);
        self.index_analysis();
    }

    /// Emits the still-open normalized line into the analysis window.
    fn flush_pending(&mut self) {
        self.state
            .normalizer
            .flush_open_line(&mut self.state.analysis);
        self.index_analysis();
    }

    /// Folds every normalized character not yet indexed into the block index.
    fn index_analysis(&mut self) {
        if self.state.indexed_bytes >= self.state.analysis.len() {
            return;
        }
        let start_byte = self.state.indexed_bytes;
        let indexed_before = self.state.char_bytes.len();
        for (offset, c) in self.state.analysis[start_byte..].char_indices() {
            let byte_index = start_byte + offset;
            let abs_char = self.state.window_start_char + self.state.char_bytes.len() as u64;
            self.state.char_bytes.push(byte_index as u32);
            if let Some(hit) = self.state.hasher.push(u32::from(c), abs_char) {
                self.state
                    .block_index
                    .entry(hit.hash)
                    .or_default()
                    .push_back(hit.start_char);
            }
        }
        self.state.new_chars_since_analysis += self.state.char_bytes.len() - indexed_before;
        self.state.indexed_bytes = self.state.analysis.len();
        self.state.total_chars = self.state.window_start_char + self.state.char_bytes.len() as u64;
    }

    /// Rebuilds character offsets and the block index from the window text.
    fn rebuild_block_index(&mut self) {
        self.state.hasher.clear();
        self.state.block_index.clear();
        self.state.char_bytes.clear();
        self.state.indexed_bytes = 0;
        self.index_analysis();
    }

    fn prune(&mut self) {
        let cap = self.config.window_chars;
        let excess = self.state.char_bytes.len().saturating_sub(cap);
        if excess == 0 {
            return;
        }
        let cut = self.state.char_bytes[excess] as usize;
        self.state.analysis.drain(..cut);
        self.state.indexed_bytes = self.state.indexed_bytes.saturating_sub(cut);
        self.state.char_bytes.drain(..excess);
        for byte_index in self.state.char_bytes.iter_mut() {
            *byte_index -= cut as u32;
        }
        self.state.window_start_char += excess as u64;
        let window_start = self.state.window_start_char;
        self.state.block_index.retain(|_, starts| {
            while starts.front().is_some_and(|start| *start < window_start) {
                starts.pop_front();
            }
            !starts.is_empty()
        });
    }

    // ------------------------- window helpers -------------------------

    fn window_end_char(&self) -> u64 {
        self.state.window_start_char + self.state.char_bytes.len() as u64
    }

    fn window_index(&self, abs_char: u64) -> Option<usize> {
        let index = abs_char.checked_sub(self.state.window_start_char)?;
        let index = usize::try_from(index).ok()?;
        if index > self.state.char_bytes.len() {
            return None;
        }
        Some(index)
    }

    /// Returns the window text for `[start_abs, end_abs)` characters.
    fn char_slice(&self, start_abs: u64, end_abs: u64) -> Option<&str> {
        let start_index = self.window_index(start_abs)?;
        let end_index = self.window_index(end_abs)?;
        let length = self.state.char_bytes.len();
        if start_index >= end_index || end_index > length {
            return None;
        }
        let start_byte = self.state.char_bytes[start_index] as usize;
        let end_byte = if end_index == length {
            self.state.analysis.len()
        } else {
            self.state.char_bytes[end_index] as usize
        };
        self.state.analysis.get(start_byte..end_byte)
    }

    /// Trailing `span_chars` characters of the window.
    fn tail_slice(&self, span_chars: usize) -> Option<&str> {
        let end = self.window_end_char();
        let start = end
            .saturating_sub(span_chars as u64)
            .max(self.state.window_start_char);
        self.char_slice(start, end)
    }

    fn compression_input(&self) -> Option<&str> {
        if self.state.char_bytes.is_empty() {
            return None;
        }
        self.tail_slice(self.config.compression_span_chars)
    }

    // ------------------------- candidates -------------------------

    fn verbatim_candidate(&self) -> Option<VerbatimCandidate> {
        let block_chars = self.config.block_chars as u64;
        let min_occurrences = self.config.verbatim_min_occurrences;
        let max_interval = f64::from(self.config.verbatim_max_mean_interval_chars);
        let mut best: Option<VerbatimCandidate> = None;

        for starts in self.state.block_index.values() {
            if starts.len() < min_occurrences {
                continue;
            }
            let mut groups: Vec<(&str, Vec<u64>)> = Vec::new();
            for start in starts.iter().copied() {
                let Some(text) = self.char_slice(start, start + block_chars) else {
                    continue;
                };
                match groups
                    .iter_mut()
                    .find(|(group_text, _)| *group_text == text)
                {
                    Some((_, occurrences)) => occurrences.push(start),
                    None => groups.push((text, vec![start])),
                }
            }
            for (text, occurrences) in groups {
                if occurrences.len() < min_occurrences {
                    continue;
                }
                let mean_interval = mean_interval(&occurrences);
                if mean_interval > max_interval {
                    continue;
                }
                let candidate = VerbatimCandidate {
                    start: occurrences[0],
                    end: occurrences[occurrences.len() - 1] + block_chars,
                    occurrences: occurrences.len(),
                    mean_interval,
                    sample: text.to_string(),
                };
                if is_better_verbatim(&candidate, best.as_ref()) {
                    best = Some(candidate);
                }
            }
        }
        best
    }

    /// Interval of a uniform long-period repetition, used as an extra scale.
    fn uniform_repeat_interval(&self) -> Option<u64> {
        let mut best: Option<(usize, u64)> = None;
        for starts in self.state.block_index.values() {
            if starts.len() < self.config.verbatim_min_occurrences {
                continue;
            }
            let mut minimum = u64::MAX;
            let mut maximum = 0u64;
            let mut total = 0u64;
            let mut previous: Option<u64> = None;
            for start in starts.iter().copied() {
                if let Some(previous) = previous {
                    let interval = start - previous;
                    minimum = minimum.min(interval);
                    maximum = maximum.max(interval);
                    total += interval;
                }
                previous = Some(start);
            }
            if maximum == 0 || maximum - minimum > (maximum / 8).max(1) {
                continue;
            }
            let mean = total / (starts.len() as u64 - 1);
            if mean == 0 {
                continue;
            }
            let better = match best {
                None => true,
                Some((count, existing)) => {
                    starts.len() > count || (starts.len() == count && mean < existing)
                }
            };
            if better {
                best = Some((starts.len(), mean));
            }
        }
        let (_, interval) = best?;
        if interval <= (self.config.window_chars / 2) as u64 {
            Some(interval)
        } else {
            None
        }
    }

    fn near_repetition_candidate(&self) -> Option<NearCandidate> {
        let window_chars = self.state.char_bytes.len();
        if window_chars == 0 {
            return None;
        }
        let ngram = self.config.ngram_chars();
        let mut scales = self.config.near_repetition_scales_chars.clone();
        if let Some(interval) = self.uniform_repeat_interval() {
            // A repetition whose period sits between the fixed scales is only
            // visible at its own interval, so both the interval and twice the
            // interval (which dilutes per-period variation) are evaluated.
            for candidate in [interval, interval.saturating_mul(2)] {
                let candidate = candidate as usize;
                if candidate > 0 && !scales.contains(&candidate) {
                    scales.push(candidate);
                }
            }
            scales.sort_unstable();
        }

        let mut best: Option<NearCandidate> = None;
        for scale in scales {
            if scale == 0 || window_chars < scale.saturating_mul(2) {
                continue;
            }
            let end = self.window_end_char();
            let tail_start = end - scale as u64;
            let previous_start = tail_start - scale as u64;
            let (Some(previous), Some(tail)) = (
                self.char_slice(previous_start, tail_start),
                self.char_slice(tail_start, end),
            ) else {
                continue;
            };
            let Some(similarity) = char_ngram_jaccard(previous, tail, ngram) else {
                continue;
            };
            if similarity < self.config.near_repetition_jaccard {
                continue;
            }
            let candidate = NearCandidate {
                scale,
                similarity,
                tail_start,
                tail_end: end,
                previous_sample: previous.to_string(),
                tail_sample: tail.to_string(),
            };
            if best
                .as_ref()
                .is_none_or(|current| similarity > current.similarity)
            {
                best = Some(candidate);
            }
        }
        best
    }

    fn periodic_candidate(&self) -> Option<PeriodicCandidate> {
        let unit_chars = self.config.period_unit_chars as u64;
        let unit_count = self.state.char_bytes.len() as u64 / unit_chars;
        if unit_count == 0 {
            return None;
        }
        let unit_count = unit_count as usize;
        let mut best: Option<PeriodicCandidate> = None;

        for period in 1..=self.config.period_max_units {
            if unit_count < period * self.config.period_min_repeats {
                continue;
            }
            let mut repeats = 1usize;
            while repeats < self.config.period_max_repeats && (repeats + 1) * period <= unit_count {
                // The region currently claimed to repeat is the last
                // `repeats * period` units; extend it backwards by one period
                // when every aligned unit still matches.
                let region_start = unit_count - repeats * period;
                let mut matches = true;
                for offset in 0..period {
                    let earlier = region_start - period + offset;
                    let later = region_start + offset;
                    if !self.period_units_match(earlier, later, unit_chars) {
                        matches = false;
                        break;
                    }
                }
                if !matches {
                    break;
                }
                repeats += 1;
            }
            if repeats < self.config.period_min_repeats {
                continue;
            }
            let span_units = repeats * period;
            let span_start =
                self.state.window_start_char + (unit_count - span_units) as u64 * unit_chars;
            let span_end = self.state.window_start_char + unit_count as u64 * unit_chars;
            let Some(sample) = self.char_slice(span_end - unit_chars * period as u64, span_end)
            else {
                continue;
            };
            let candidate = PeriodicCandidate {
                period_units: period,
                repeats,
                start: span_start,
                end: span_end,
                sample: sample.to_string(),
            };
            if best
                .as_ref()
                .is_none_or(|current| candidate.repeats >= current.repeats)
            {
                best = Some(candidate);
            }
        }
        best
    }

    fn period_units_match(&self, earlier: usize, later: usize, unit_chars: u64) -> bool {
        let base = self.state.window_start_char;
        let earlier_start = base + earlier as u64 * unit_chars;
        let later_start = base + later as u64 * unit_chars;
        let (Some(left), Some(right)) = (
            self.char_slice(earlier_start, earlier_start + unit_chars),
            self.char_slice(later_start, later_start + unit_chars),
        ) else {
            return false;
        };
        if left == right {
            return true;
        }
        if left.len() != right.len() {
            return false;
        }
        let differing = left
            .bytes()
            .zip(right.bytes())
            .filter(|(left_byte, right_byte)| left_byte != right_byte)
            .count();
        differing <= self.config.period_unit_max_diff_chars
    }

    fn phrase_stuck_candidate(&self) -> Option<PhraseStuckCandidate> {
        let text = self.tail_slice(self.config.phrase_stuck_span_chars)?;
        let tokens = normalize::tokenize(text);
        let run = longest_connector_run(&tokens, &self.config.phrase_stuck_tokens)?;
        if run.len < self.config.phrase_stuck_min_consecutive {
            return None;
        }
        let sample = tokens[run.start..run.start + run.len].join(" ");
        Some(PhraseStuckCandidate {
            repeats: run.len,
            sample,
        })
    }

    fn drift_candidate(&self) -> Option<DriftCandidate> {
        let text = self.tail_slice(self.config.predictable_drift_span_chars)?;
        let base = self.window_end_char() - text.chars().count() as u64;
        let mut lines: Vec<&str> = Vec::new();
        let mut line_starts: Vec<u64> = Vec::new();
        let mut line_ends: Vec<u64> = Vec::new();
        let mut cursor = base;

        for line in text.split('\n') {
            let chars = line.chars().count() as u64;
            if !line.trim().is_empty() {
                lines.push(line);
                line_starts.push(cursor);
                line_ends.push(cursor + chars);
            }
            cursor += chars + 1;
        }

        let runs = drift::drift_runs(
            &lines,
            self.config.predictable_drift_max_diff_ratio,
            self.config.predictable_drift_min_samples,
        );
        let run = runs
            .into_iter()
            .max_by_key(|run| (run.samples(), run.first_line))?;
        let sample = lines
            .get(run.last_line)
            .copied()
            .unwrap_or_default()
            .to_string();
        Some(DriftCandidate {
            samples: run.samples(),
            steps: run.steps,
            start: line_starts[run.first_line],
            end: line_ends[run.last_line],
            sample,
        })
    }

    // ------------------------- verdict builders -------------------------

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

    fn finish_phrase_stuck(
        &mut self,
        candidate: PhraseStuckCandidate,
        compression: Option<f32>,
    ) -> Option<LoopVerdict> {
        let evidence = LoopEvidence {
            occurrences: candidate.repeats,
            consecutive_repeats: candidate.repeats,
            span_chars: Some(candidate.sample.chars().count()),
            compression_redundancy: compression,
            requires_arbitration: false,
            ..Default::default()
        }
        .with_samples(
            vec![candidate.sample],
            self.config.evidence_sample_limit,
            self.config.evidence_sample_chars,
        );
        self.finish(
            LoopKind::PhraseStuck,
            self.config.phrase_stuck_confidence,
            evidence,
        )
    }

    fn finish_verbatim(
        &mut self,
        candidate: VerbatimCandidate,
        compression: Option<f32>,
    ) -> Option<LoopVerdict> {
        let span = candidate.end.saturating_sub(candidate.start) as usize;
        let evidence = LoopEvidence {
            occurrences: candidate.occurrences,
            consecutive_repeats: candidate.occurrences,
            mean_interval_chars: Some(candidate.mean_interval as f32),
            span_chars: Some(span),
            compression_redundancy: compression,
            requires_arbitration: false,
            ..Default::default()
        }
        .with_samples(
            vec![candidate.sample],
            self.config.evidence_sample_limit,
            self.config.evidence_sample_chars,
        );
        self.finish(
            LoopKind::VerbatimBlock,
            self.config.verbatim_confidence,
            evidence,
        )
    }

    fn finish_periodic(
        &mut self,
        candidate: PeriodicCandidate,
        compression: Option<f32>,
    ) -> Option<LoopVerdict> {
        let span = candidate.end.saturating_sub(candidate.start) as usize;
        let evidence = LoopEvidence {
            occurrences: candidate.repeats,
            consecutive_repeats: candidate.repeats,
            period_units: Some(candidate.period_units),
            span_chars: Some(span),
            compression_redundancy: compression,
            requires_arbitration: false,
            ..Default::default()
        }
        .with_samples(
            vec![candidate.sample],
            self.config.evidence_sample_limit,
            self.config.evidence_sample_chars,
        );
        self.finish(
            LoopKind::PeriodicSequence,
            self.config.periodic_confidence,
            evidence,
        )
    }

    fn finish_near_repetition(
        &mut self,
        candidate: NearCandidate,
        compression: Option<f32>,
    ) -> Option<LoopVerdict> {
        let corroborated = compression
            .is_some_and(|redundancy| redundancy >= self.config.compression_min_redundancy);
        let strong =
            candidate.similarity >= self.config.near_repetition_strong_jaccard || corroborated;
        let (confidence, requires_arbitration) = if strong {
            (self.config.near_repetition_strong_confidence, false)
        } else {
            (self.config.near_repetition_confidence, true)
        };
        let evidence = LoopEvidence {
            occurrences: 2,
            consecutive_repeats: 0,
            max_similarity: Some(candidate.similarity),
            matched_scale_chars: Some(candidate.scale),
            span_chars: Some(candidate.scale),
            compression_redundancy: compression,
            requires_arbitration,
            ..Default::default()
        }
        .with_samples(
            vec![candidate.previous_sample, candidate.tail_sample],
            self.config.evidence_sample_limit,
            self.config.evidence_sample_chars,
        );
        self.finish(LoopKind::NearRepetition, confidence, evidence)
    }

    fn finish_predictable_drift(
        &mut self,
        run: &DriftCandidate,
        compression: Option<f32>,
    ) -> Option<LoopVerdict> {
        let evidence = LoopEvidence {
            occurrences: run.samples,
            consecutive_repeats: run.steps,
            span_chars: Some((run.end.saturating_sub(run.start)) as usize),
            compression_redundancy: compression,
            requires_arbitration: false,
            ..Default::default()
        }
        .with_samples(
            vec![run.sample.clone()],
            self.config.evidence_sample_limit,
            self.config.evidence_sample_chars,
        );
        self.finish(
            LoopKind::PredictableDrift,
            self.config.predictable_drift_confidence,
            evidence,
        )
    }
}

fn mean_interval(occurrences: &[u64]) -> f64 {
    if occurrences.len() < 2 {
        return 0.0;
    }
    let total: u64 = occurrences.windows(2).map(|pair| pair[1] - pair[0]).sum();
    total as f64 / (occurrences.len() - 1) as f64
}

fn is_better_verbatim(candidate: &VerbatimCandidate, current: Option<&VerbatimCandidate>) -> bool {
    match current {
        None => true,
        Some(current) => {
            candidate.occurrences > current.occurrences
                || (candidate.occurrences == current.occurrences
                    && (candidate.mean_interval < current.mean_interval
                        || (candidate.mean_interval == current.mean_interval
                            && candidate.start < current.start)))
        }
    }
}

/// Whether a drift run covers at least half of the candidate region.
fn run_explains(run: &DriftCandidate, start: u64, end: u64) -> bool {
    if end <= start {
        return false;
    }
    let overlap_start = run.start.max(start);
    let overlap_end = run.end.min(end);
    if overlap_end <= overlap_start {
        return false;
    }
    let region = end - start;
    (overlap_end - overlap_start) * 2 >= region
}

struct VerbatimCandidate {
    start: u64,
    end: u64,
    occurrences: usize,
    mean_interval: f64,
    sample: String,
}

struct NearCandidate {
    scale: usize,
    similarity: f32,
    tail_start: u64,
    tail_end: u64,
    previous_sample: String,
    tail_sample: String,
}

struct PeriodicCandidate {
    period_units: usize,
    repeats: usize,
    start: u64,
    end: u64,
    sample: String,
}

struct PhraseStuckCandidate {
    repeats: usize,
    sample: String,
}

struct DriftCandidate {
    samples: usize,
    steps: usize,
    start: u64,
    end: u64,
    sample: String,
}
