//! Dependency-free compression proxy.
//!
//! The plan asks for a "zlib compression ratio" as one repetition signal. The
//! plan's initial threshold is a *redundancy* scale (`>= 0.6` means "at least
//! 60% of the window is redundant"), which is the inverse of the
//! `compressed_size / original_size` convention used by some libraries; the
//! module documents its own scale explicitly and ignores the ambiguous reading.
//!
//! The dependency decision: instead of pulling `flate2` into
//! `openbitfun-agent-stream` (a stream-contract crate whose dependency list is
//! deliberately small and which has no other compression consumer), this module
//! implements a greedy LZ77 matcher with a deflate-like bit cost model. The
//! proxy is *not* zlib: it is honest about being an approximation, it is
//! deterministic, allocation-light, and it is conservative - on plain prose it
//! reports 0.0 redundancy, and it under-reports redundancy on data zlib would
//! compress because it has no entropy coding.
//!
//! The ratio is a *corroborating* signal only: it can resolve the near-repetition
//! boundary band, and it is attached to verdict evidence for telemetry. It never
//! produces a verdict on its own.

use std::collections::HashMap;

use super::LoopDetectorConfig;

/// Deflate-like cap on a single match length.
const LZ_MAX_MATCH: usize = 258;
/// Shortest key used to index the match chains.
const LZ_KEY_BYTES: usize = 4;
/// Below this many bytes a redundancy ratio carries no information.
const LZ_MIN_INPUT_BYTES: usize = 64;

/// Estimated redundancy of `text`: `1 - estimated_compressed_bits / (8 * bytes)`.
///
/// Returns `None` for inputs that are too short to measure.
pub(crate) fn compression_redundancy(text: &str, config: &LoopDetectorConfig) -> Option<f32> {
    let bytes = text.as_bytes();
    let len = bytes.len();
    if len < LZ_MIN_INPUT_BYTES {
        return None;
    }

    let min_match = config.compression_min_match_chars.max(LZ_KEY_BYTES);
    let back_window = config.compression_window_chars.max(min_match);
    let max_chain = config.compression_max_chain_attempts.max(1);

    let mut head: HashMap<u32, u32> = HashMap::new();
    let mut previous: Vec<u32> = vec![u32::MAX; len];
    let mut estimated_bits: u64 = 0;
    let mut position = 0usize;

    while position < len {
        let mut best_len = 0usize;

        if position + min_match <= len {
            let key = key_at(bytes, position);
            if let Some(&start) = head.get(&key) {
                let mut candidate = start;
                let mut attempts = 0usize;
                loop {
                    let distance = position.saturating_sub(candidate as usize);
                    if distance == 0 || distance > back_window {
                        break;
                    }
                    let max_len = (len - position).min(LZ_MAX_MATCH);
                    let mut matched = 0usize;
                    while matched < max_len
                        && bytes[candidate as usize + matched] == bytes[position + matched]
                    {
                        matched += 1;
                    }
                    if matched > best_len {
                        best_len = matched;
                    }
                    attempts += 1;
                    if attempts >= max_chain || matched >= max_len {
                        break;
                    }
                    let older = previous[candidate as usize];
                    if older == u32::MAX || older >= candidate {
                        break;
                    }
                    candidate = older;
                }
            }
        }

        if best_len >= min_match {
            estimated_bits =
                estimated_bits.saturating_add(u64::from(config.compression_match_bits));
            // Only the match start and literal positions enter the chains: the
            // first occurrence of a phrase has already been indexed, so later
            // repetitions still find it while the cost stays O(matches).
            remember(bytes, position, len, &mut head, &mut previous);
            position += best_len;
        } else {
            estimated_bits =
                estimated_bits.saturating_add(u64::from(config.compression_literal_bits));
            remember(bytes, position, len, &mut head, &mut previous);
            position += 1;
        }
    }

    let raw_bits = 8.0 * len as f64;
    let redundancy = 1.0 - (estimated_bits as f64 / raw_bits);
    Some(redundancy.clamp(0.0, 1.0) as f32)
}

fn remember(
    bytes: &[u8],
    position: usize,
    len: usize,
    head: &mut HashMap<u32, u32>,
    previous: &mut [u32],
) {
    if position + LZ_KEY_BYTES > len {
        return;
    }
    let key = key_at(bytes, position);
    let older = head.insert(key, position as u32);
    previous[position] = older.unwrap_or(u32::MAX);
}

fn key_at(bytes: &[u8], position: usize) -> u32 {
    u32::from_be_bytes([
        bytes[position],
        bytes[position + 1],
        bytes[position + 2],
        bytes[position + 3],
    ])
}

#[cfg(test)]
mod tests {
    use super::compression_redundancy;
    use crate::loop_detection::LoopDetectorConfig;

    #[test]
    fn repeated_text_is_highly_redundant() {
        let config = LoopDetectorConfig::default();
        let unit = "the stage waits while the trace records the same line again and again ";
        let text = unit.repeat(60);
        let redundancy = compression_redundancy(&text, &config).expect("long enough");
        assert!(
            redundancy >= config.compression_min_redundancy,
            "repetitive text redundancy: {redundancy}"
        );
    }

    #[test]
    fn prose_is_not_redundant() {
        let config = LoopDetectorConfig::default();
        let text = "Loop detection must stay cheap on the hot path, so every expensive \
            analysis runs on a strided window, results are cached per span, and the caller \
            decides when to force a pass. Nonsense flows here on purpose: quixotic zebras \
            juggle tungsten umbrellas under a violet sky while marmalade engines hum a \
            quiet tune beside the harbour wall. Weather reports arrive from a coastal \
            station, listing humidity, wind shear, tidal drift and visibility, and the \
            harbourmaster signs the ledger with a leaking fountain pen before cycling home.";
        let redundancy = compression_redundancy(text, &config).expect("long enough");
        assert!(
            redundancy < config.compression_min_redundancy,
            "prose redundancy: {redundancy}"
        );
    }

    #[test]
    fn short_input_reports_nothing() {
        let config = LoopDetectorConfig::default();
        assert!(compression_redundancy("too short", &config).is_none());
    }

    #[test]
    fn templated_lines_rank_between_prose_and_chanting() {
        let config = LoopDetectorConfig::default();
        let templated: String = (1..=80)
            .map(|index| format!("processed item {index} of 80 with status ok\n"))
            .collect();
        let chant = "let me think about it ".repeat(200);
        let templated_redundancy =
            compression_redundancy(&templated, &config).expect("long enough");
        let chant_redundancy = compression_redundancy(&chant, &config).expect("long enough");
        assert!(
            chant_redundancy > templated_redundancy,
            "chant {chant_redundancy} should exceed templated {templated_redundancy}"
        );
    }
}
