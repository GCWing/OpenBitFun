//! Streaming normalization and rolling-hash building blocks for loop detection.
//!
//! Normalization is deliberately small: ASCII lower casing, horizontal
//! whitespace collapsed to a single space, line breaks kept (line structure is
//! needed by the predictable-enumeration classifier), and structure-excluded
//! lines dropped from the analysis text.
//!
//! Dropping excluded lines is what implements the plan's false-positive
//! exclusion list without a parallel mask array: repetition that lives inside a
//! fenced code block, table, list, heading, quote, or thematic break simply
//! never reaches the detectors, so it cannot form an identical block, a shared
//! character n-gram, or a connector run. Consecutive line breaks collapse, so a
//! long excluded region cannot produce a block of newline characters either.

use std::collections::VecDeque;

use super::structure::{classify_line, FenceState};

/// Base of the polynomial rolling hash used for block and n-gram fingerprints.
pub(crate) const HASH_BASE: u64 = 0x0000_0100_0000_01b3;

/// Default cap on a buffered partial line before it is classified and flushed.
pub(crate) const DEFAULT_LINE_BUFFER_MAX_CHARS: usize = 512;

/// Splits text into alphanumeric tokens without allocating.
///
/// Tokens are compared case-insensitively by callers, so no lower casing (and
/// therefore no allocation) is needed here.
pub(crate) fn tokenize(text: &str) -> Vec<&str> {
    let mut tokens = Vec::new();
    let mut start: Option<usize> = None;
    for (offset, c) in text.char_indices() {
        if c.is_alphanumeric() {
            if start.is_none() {
                start = Some(offset);
            }
        } else if let Some(begin) = start.take() {
            tokens.push(&text[begin..offset]);
        }
    }
    if let Some(begin) = start {
        tokens.push(&text[begin..]);
    }
    tokens
}

/// Incremental normalizer: appends normalized text to a caller-owned buffer.
///
/// A line is only classified once it is complete, so the normalizer keeps the
/// current line open. [`Normalizer::flush_open_line`] emits the part of that line
/// that is safe to analyze without closing it, which is how a round-boundary
/// analysis sees trailing text that has no final newline.
#[derive(Debug, Clone)]
pub(crate) struct Normalizer {
    fence: FenceState,
    line_buffer: String,
    line_buffer_chars: usize,
    line_buffer_max_chars: usize,
    emitted_bytes: usize,
    pending_break: bool,
    pending_space: bool,
    structure_exclusion: bool,
}

impl Normalizer {
    pub(crate) fn new(structure_exclusion: bool, line_buffer_max_chars: usize) -> Self {
        Self {
            fence: FenceState::None,
            line_buffer: String::new(),
            line_buffer_chars: 0,
            line_buffer_max_chars: line_buffer_max_chars.max(1),
            emitted_bytes: 0,
            pending_break: false,
            pending_space: false,
            structure_exclusion,
        }
    }

    /// Normalizes `chunk`, appending to `out`.
    pub(crate) fn push(&mut self, chunk: &str, out: &mut String) {
        for c in chunk.chars() {
            match c {
                '\n' => {
                    self.close_line(out, true);
                    self.pending_break = true;
                }
                '\r' => {}
                _ => {
                    self.line_buffer.push(c);
                    self.line_buffer_chars += 1;
                    if self.line_buffer_chars >= self.line_buffer_max_chars {
                        // A markdown structure line is short, so an oversized
                        // line is prose by construction: emit it as content
                        // without closing the source line.
                        self.close_line(out, false);
                    }
                }
            }
        }
    }

    /// Emits the not-yet-emitted part of the open line, keeping it open.
    ///
    /// Lines that already look like a structure-excluded line emit nothing until
    /// they are complete, so a partial table row or fence delimiter cannot leak
    /// content into the analysis window.
    pub(crate) fn flush_open_line(&mut self, out: &mut String) {
        if self.emitted_bytes >= self.line_buffer.len() {
            return;
        }
        if self.structure_exclusion && is_structure_line(&self.line_buffer, self.fence) {
            return;
        }
        let remainder = self.line_buffer[self.emitted_bytes..].to_string();
        self.emit(&remainder, out, false);
        self.emitted_bytes = self.line_buffer.len();
    }

    /// Flushes any pending partial line and closes it.
    pub(crate) fn finish(&mut self, out: &mut String) {
        if !self.line_buffer.is_empty() {
            self.close_line(out, true);
        }
    }

    fn close_line(&mut self, out: &mut String, line_complete: bool) {
        let line = std::mem::take(&mut self.line_buffer);
        self.line_buffer_chars = 0;
        let emitted_bytes = std::mem::replace(&mut self.emitted_bytes, 0);
        if line.is_empty() {
            return;
        }

        let decision = classify_line(&line, self.fence);
        self.fence = decision.fence;
        if self.structure_exclusion && decision.excluded.is_some() {
            return;
        }

        let remainder = line[emitted_bytes.min(line.len())..].to_string();
        self.emit(&remainder, out, line_complete);
    }

    fn emit(&mut self, text: &str, out: &mut String, line_complete: bool) {
        if text.is_empty() {
            if line_complete {
                self.pending_space = true;
            }
            return;
        }
        if self.pending_break && !out.is_empty() && !out.ends_with('\n') {
            out.push('\n');
        }
        self.pending_break = false;
        for c in text.chars() {
            push_normalized_char(c, out, &mut self.pending_space);
        }
        if line_complete {
            self.pending_space = true;
        }
    }
}

fn is_structure_line(line: &str, fence: FenceState) -> bool {
    classify_line(line, fence).excluded.is_some()
}

fn push_normalized_char(c: char, out: &mut String, pending_space: &mut bool) {
    if c.is_whitespace() {
        *pending_space = true;
        return;
    }
    if *pending_space && !out.is_empty() && !out.ends_with('\n') {
        out.push(' ');
    }
    *pending_space = false;
    out.push(c.to_ascii_lowercase());
}

/// Normalizes one independent fragment (used for thinking blocks).
pub(crate) fn normalize_fragment(
    text: &str,
    structure_exclusion: bool,
    line_buffer_max_chars: usize,
) -> String {
    let mut normalizer = Normalizer::new(structure_exclusion, line_buffer_max_chars);
    let mut out = String::new();
    normalizer.push(text, &mut out);
    normalizer.finish(&mut out);
    out
}

/// Fingerprint of one completed block of `block_chars` characters.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub(crate) struct BlockHit {
    /// Polynomial rolling hash of the block.
    pub(crate) hash: u64,
    /// Absolute character offset of the first character of the block.
    pub(crate) start_char: u64,
}

/// Rolling polynomial-hash hasher that emits one hash per completed window.
///
/// Sliding is O(1) per character: the ring only holds the current window.
#[derive(Debug, Clone)]
pub(crate) struct RollingBlockHasher {
    block_chars: usize,
    base: u64,
    pow: u64,
    hash: u64,
    ring: VecDeque<(u32, u64)>,
}

impl RollingBlockHasher {
    pub(crate) fn new(block_chars: usize) -> Self {
        let block_chars = block_chars.max(1);
        let mut pow = 1u64;
        for _ in 1..block_chars {
            pow = pow.wrapping_mul(HASH_BASE);
        }
        Self {
            block_chars,
            base: HASH_BASE,
            pow,
            hash: 0,
            ring: VecDeque::with_capacity(block_chars),
        }
    }

    pub(crate) fn block_chars(&self) -> usize {
        self.block_chars
    }

    pub(crate) fn clear(&mut self) {
        self.hash = 0;
        self.ring.clear();
    }

    /// Pushes one character; returns the completed block once the window is full.
    pub(crate) fn push(&mut self, code: u32, abs_char: u64) -> Option<BlockHit> {
        if self.ring.len() == self.block_chars {
            if let Some((old_code, _)) = self.ring.pop_front() {
                let removed = (u64::from(old_code) + 1).wrapping_mul(self.pow);
                self.hash = self
                    .hash
                    .wrapping_sub(removed)
                    .wrapping_mul(self.base)
                    .wrapping_add(u64::from(code) + 1);
            }
        } else {
            self.hash = self
                .hash
                .wrapping_mul(self.base)
                .wrapping_add(u64::from(code) + 1);
        }
        self.ring.push_back((code, abs_char));
        if self.ring.len() < self.block_chars {
            return None;
        }
        let start_char = self.ring.front().map(|(_, offset)| *offset)?;
        Some(BlockHit {
            hash: self.hash,
            start_char,
        })
    }
}

/// Reference implementation of the same polynomial hash, used by tests.
#[cfg(test)]
pub(crate) fn naive_block_hash(codes: &[u32]) -> u64 {
    codes.iter().fold(0u64, |acc, code| {
        acc.wrapping_mul(HASH_BASE)
            .wrapping_add(u64::from(*code) + 1)
    })
}

#[cfg(test)]
mod tests {
    use super::{naive_block_hash, normalize_fragment, tokenize, Normalizer, RollingBlockHasher};

    #[test]
    fn normalizes_case_whitespace_and_line_breaks() {
        let text = "Hello   WORLD\n\n  Second\tLine\n";
        let normalized = normalize_fragment(text, true, 512);
        assert_eq!(normalized, "hello world\nsecond line");
    }

    #[test]
    fn drops_structure_excluded_lines_from_the_analysis_text() {
        let text = "intro\n- repeated label\n- repeated label\n- repeated label\noutro";
        let normalized = normalize_fragment(text, true, 512);
        assert_eq!(normalized, "intro\noutro");
    }

    #[test]
    fn long_excluded_regions_do_not_emit_newline_runs() {
        let mut text = String::from("before\n```\n");
        for _ in 0..200 {
            text.push_str("let value = compute(input);\n");
        }
        text.push_str("```\nafter");
        let normalized = normalize_fragment(&text, true, 512);
        assert_eq!(normalized, "before\nafter");
    }

    #[test]
    fn structure_exclusion_can_be_disabled() {
        let text = "- bullet content";
        assert_eq!(normalize_fragment(text, true, 512), "");
        assert_eq!(normalize_fragment(text, false, 512), "- bullet content");
    }

    #[test]
    fn flushes_oversized_lines_without_inventing_line_breaks() {
        let long = "ab".repeat(400);
        let mut normalizer = Normalizer::new(true, 8);
        let mut out = String::new();
        normalizer.push(&long, &mut out);
        normalizer.finish(&mut out);
        assert_eq!(out, long);
    }

    #[test]
    fn rolling_hash_matches_naive_hash_and_slides() {
        let text: Vec<u32> = "the quick brown fox jumps".chars().map(u32::from).collect();
        let block = 5usize;
        let mut hasher = RollingBlockHasher::new(block);
        let mut emitted = Vec::new();
        for (index, code) in text.iter().enumerate() {
            if let Some(hit) = hasher.push(*code, index as u64) {
                emitted.push((hit, index));
            }
        }
        assert_eq!(emitted.len(), text.len() - block + 1);
        for (hit, end_index) in emitted {
            let start = end_index + 1 - block;
            assert_eq!(hit.start_char, start as u64);
            assert_eq!(hit.hash, naive_block_hash(&text[start..=end_index]));
        }
    }

    #[test]
    fn rolling_hash_is_offset_independent() {
        let mut first = RollingBlockHasher::new(4);
        let mut second = RollingBlockHasher::new(4);
        let mut hashes_a = Vec::new();
        let mut hashes_b = Vec::new();
        for (index, c) in "xxxxsame".chars().enumerate() {
            if let Some(hit) = first.push(u32::from(c), index as u64) {
                hashes_a.push(hit.hash);
            }
        }
        for (index, c) in "same".chars().enumerate() {
            if let Some(hit) = second.push(u32::from(c), index as u64) {
                hashes_b.push(hit.hash);
            }
        }
        assert_eq!(hashes_a.last(), hashes_b.last());
    }

    #[test]
    fn tokenize_splits_on_non_alphanumeric() {
        let tokens = tokenize("wait, wait! 8.1A->8.1Z");
        assert_eq!(tokens, vec!["wait", "wait", "8", "1A", "8", "1Z"]);
    }
}
