//! Text similarity and connector-run helpers.
//!
//! Similarity is a Jaccard ratio over the *set* of character n-gram hashes of
//! two texts. Character n-grams are language agnostic (no tokenizer needed for
//! CJK or code), cheap to build with the rolling hasher, and insensitive to the
//! phase of a repetition as long as a compared span covers at least one full
//! repetition period.

use std::collections::HashSet;

use super::normalize::RollingBlockHasher;

/// Jaccard similarity of the character n-gram sets of `a` and `b`.
///
/// Returns `None` when either side is shorter than one n-gram.
pub(crate) fn char_ngram_jaccard(a: &str, b: &str, ngram: usize) -> Option<f32> {
    let a_set = ngram_set(a, ngram)?;
    let b_set = ngram_set(b, ngram)?;
    let intersection = a_set.intersection(&b_set).count();
    let union = a_set.len() + b_set.len() - intersection;
    if union == 0 {
        return None;
    }
    Some(intersection as f32 / union as f32)
}

fn ngram_set(text: &str, ngram: usize) -> Option<HashSet<u64>> {
    let mut hasher = RollingBlockHasher::new(ngram.max(1));
    let mut set = HashSet::new();
    for (index, c) in text.chars().enumerate() {
        if let Some(hit) = hasher.push(u32::from(c), index as u64) {
            set.insert(hit.hash);
        }
    }
    if set.is_empty() {
        None
    } else {
        Some(set)
    }
}

/// Longest run of consecutive tokens that all appear in `seeds`.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub(crate) struct ConnectorRun {
    /// Index of the first token of the run.
    pub(crate) start: usize,
    /// Number of consecutive connector tokens.
    pub(crate) len: usize,
}

/// Finds the longest consecutive connector run, preferring the most recent on a tie.
pub(crate) fn longest_connector_run(tokens: &[&str], seeds: &[String]) -> Option<ConnectorRun> {
    let mut best: Option<ConnectorRun> = None;
    let mut run_start = 0usize;
    let mut run_len = 0usize;
    for (index, token) in tokens.iter().enumerate() {
        let is_seed = seeds.iter().any(|seed| token.eq_ignore_ascii_case(seed));
        if is_seed {
            if run_len == 0 {
                run_start = index;
            }
            run_len += 1;
            if best.is_none_or(|current| run_len >= current.len) {
                best = Some(ConnectorRun {
                    start: run_start,
                    len: run_len,
                });
            }
        } else {
            run_len = 0;
        }
    }
    best
}

#[cfg(test)]
mod tests {
    use super::{char_ngram_jaccard, longest_connector_run};
    use crate::loop_detection::normalize::tokenize;

    fn seeds() -> Vec<String> {
        vec!["wait".to_string(), "so".to_string(), "but".to_string()]
    }

    #[test]
    fn identical_text_is_fully_similar() {
        let text = "the stage waits while the trace records the same line again";
        assert_eq!(char_ngram_jaccard(text, text, 5), Some(1.0));
    }

    #[test]
    fn unrelated_prose_stays_well_below_the_threshold() {
        let a = "the reviewer reads the staged pipeline output and records the result";
        let b = "meanwhile a completely different sentence discusses weather patterns";
        let similarity = char_ngram_jaccard(a, b, 5).expect("both sides have n-grams");
        assert!(similarity < 0.2, "unexpected similarity: {similarity}");
    }

    #[test]
    fn single_character_edits_keep_blocks_similar() {
        let a = "the stage waits while the trace records the same line again and again";
        let b = "the stage waits while the trace records the same line again and again!";
        let similarity = char_ngram_jaccard(a, b, 5).expect("both sides have n-grams");
        assert!(
            similarity > 0.7,
            "single edit should stay similar: {similarity}"
        );
    }

    #[test]
    fn short_text_has_no_ngrams() {
        assert_eq!(char_ngram_jaccard("ab", "ab", 5), None);
    }

    #[test]
    fn finds_the_longest_connector_run() {
        let tokens = tokenize("we stop so but wait wait wait wait wait wait wait wait now");
        let run = longest_connector_run(&tokens, &seeds()).expect("a connector run exists");
        assert_eq!(run.len, 10);
        assert_eq!(tokens[run.start], "so");

        let tokens = tokenize("wait so wait so wait so");
        let run = longest_connector_run(&tokens, &seeds()).expect("a connector run exists");
        assert_eq!(run.len, 6);
        assert_eq!(run.start, 0);
    }

    #[test]
    fn no_connector_run_reports_none() {
        let tokens = tokenize("the reviewer reads the staged pipeline output");
        let run = longest_connector_run(&tokens, &seeds());
        assert!(run.is_none_or(|value| value.len < 8));
    }
}
