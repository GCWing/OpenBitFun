//! Predictable-enumeration classification.
//!
//! The plan requires numeric and alphabetic series (`2074-2075-...`,
//! `8.1A -> 8.2A`) to pass a "predictable change" classifier first, and to be
//! reported as their own kind instead of being treated as a verbatim or
//! near-verbatim loop. This module implements that classifier: two lines form a
//! drift pair when they share the same token skeleton and every differing token
//! is a counter (pure number, letter, or `prefix+number` / `number+letter`)
//! advancing by one constant, non-zero step.

use super::normalize::tokenize;

/// Which counter type a drift pair advances.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub(crate) enum CounterKind {
    /// A numeric counter.
    Numeric,
    /// A single-letter counter.
    Alpha,
}

/// Classification of one consecutive line pair.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub(crate) struct DriftPair {
    /// Counter type both lines advance.
    pub(crate) kind: CounterKind,
    /// Non-zero constant step.
    pub(crate) step: i64,
}

/// A run of consecutive lines that advance one counter by a constant step.
#[derive(Debug, Clone, PartialEq, Eq)]
pub(crate) struct DriftRun {
    /// Index of the first line of the run (inclusive).
    pub(crate) first_line: usize,
    /// Index of the last line of the run (inclusive).
    pub(crate) last_line: usize,
    /// Number of matched line pairs.
    pub(crate) steps: usize,
    /// Counter type of the run.
    pub(crate) kind: CounterKind,
    /// Constant step of the run.
    pub(crate) step: i64,
}

impl DriftRun {
    /// Number of lines covered by the run.
    pub(crate) fn samples(&self) -> usize {
        self.last_line - self.first_line + 1
    }
}

/// Classifies one line pair as a counter progression.
pub(crate) fn classify_drift_pair(a: &str, b: &str, max_diff_ratio: f32) -> Option<DriftPair> {
    let tokens_a = tokenize(a);
    let tokens_b = tokenize(b);
    if tokens_a.is_empty() || tokens_a.len() != tokens_b.len() {
        return None;
    }

    let token_count = tokens_a.len();
    let mut kind: Option<CounterKind> = None;
    let mut step: Option<i64> = None;
    let mut differences = 0usize;

    for (left, right) in tokens_a.iter().zip(tokens_b.iter()) {
        if left == right {
            continue;
        }
        differences += 1;
        if differences as f32 > max_diff_ratio * token_count as f32 {
            return None;
        }
        let (pair_kind, pair_step) = classify_counter_pair(left, right)?;
        match (kind, step) {
            (None, None) => {
                kind = Some(pair_kind);
                step = Some(pair_step);
            }
            (Some(existing_kind), Some(existing_step))
                if existing_kind == pair_kind && existing_step == pair_step => {}
            _ => return None,
        }
    }

    if differences == 0 {
        return None;
    }
    Some(DriftPair {
        kind: kind?,
        step: step?,
    })
}

/// Returns every counter run of at least `min_samples` consecutive lines.
pub(crate) fn drift_runs(lines: &[&str], max_diff_ratio: f32, min_samples: usize) -> Vec<DriftRun> {
    let mut runs = Vec::new();
    let mut current: Option<DriftRun> = None;

    for index in 0..lines.len().saturating_sub(1) {
        let pair = classify_drift_pair(lines[index], lines[index + 1], max_diff_ratio);
        let continues = match (&current, &pair) {
            (Some(run), Some(next)) => run.kind == next.kind && run.step == next.step,
            _ => false,
        };
        if continues {
            if let Some(run) = current.as_mut() {
                run.last_line = index + 1;
                run.steps += 1;
            }
            continue;
        }
        if let Some(run) = current.take() {
            if run.samples() >= min_samples {
                runs.push(run);
            }
        }
        if let Some(next) = pair {
            current = Some(DriftRun {
                first_line: index,
                last_line: index + 1,
                steps: 1,
                kind: next.kind,
                step: next.step,
            });
        }
    }

    if let Some(run) = current {
        if run.samples() >= min_samples {
            runs.push(run);
        }
    }
    runs
}

fn classify_counter_pair(left: &str, right: &str) -> Option<(CounterKind, i64)> {
    if let (Some(a), Some(b)) = (parse_number(left), parse_number(right)) {
        return non_zero_step(CounterKind::Numeric, a, b);
    }
    if let (Some(a), Some(b)) = (parse_alpha(left), parse_alpha(right)) {
        return non_zero_step(CounterKind::Alpha, a, b);
    }
    if let (Some(a), Some(b)) = (parse_suffixed(left), parse_suffixed(right)) {
        return non_zero_step(a.0, a.1, b.1);
    }
    None
}

fn non_zero_step(kind: CounterKind, from: i64, to: i64) -> Option<(CounterKind, i64)> {
    let step = to.checked_sub(from)?;
    if step == 0 {
        None
    } else {
        Some((kind, step))
    }
}

fn parse_number(token: &str) -> Option<i64> {
    if token.is_empty() || token.len() > 12 || !token.bytes().all(|b| b.is_ascii_digit()) {
        return None;
    }
    token.parse::<i64>().ok()
}

fn parse_alpha(token: &str) -> Option<i64> {
    let mut chars = token.chars();
    let first = chars.next()?;
    if chars.next().is_some() || !first.is_ascii_alphabetic() {
        return None;
    }
    Some(i64::from(first.to_ascii_lowercase() as u8 - b'a') + 1)
}

/// Parses `prefix+number` / `number+letter` counters such as `v12`, `item7`, `1a`.
fn parse_suffixed(token: &str) -> Option<(CounterKind, i64)> {
    let bytes = token.as_bytes();
    // `1a`, `12z`: a numeric head plus a single trailing letter counter.
    if bytes.len() >= 2
        && bytes[..bytes.len() - 1]
            .iter()
            .all(|byte| byte.is_ascii_digit())
        && bytes[bytes.len() - 1].is_ascii_alphabetic()
    {
        let letter = parse_alpha(&token[token.len() - 1..])?;
        return Some((CounterKind::Alpha, letter));
    }
    // `v12`, `item7`: an alphabetic prefix plus a trailing numeric counter.
    let split = bytes.iter().position(|byte| byte.is_ascii_digit())?;
    if split > 0
        && bytes[..split].iter().all(|byte| byte.is_ascii_alphabetic())
        && bytes[split..].iter().all(|byte| byte.is_ascii_digit())
    {
        let value = token[split..].parse::<i64>().ok()?;
        return Some((CounterKind::Numeric, value));
    }
    None
}

#[cfg(test)]
mod tests {
    use super::{classify_drift_pair, drift_runs, CounterKind};

    #[test]
    fn numeric_counter_lines_are_drift_pairs() {
        let pair = classify_drift_pair(
            "building variant 2074 of the matrix",
            "building variant 2075 of the matrix",
            0.5,
        )
        .expect("numeric progression");
        assert_eq!(pair.kind, CounterKind::Numeric);
        assert_eq!(pair.step, 1);
    }

    #[test]
    fn letter_and_suffixed_counters_are_drift_pairs() {
        let pair = classify_drift_pair("stage 8.1A result", "stage 8.1B result", 0.5)
            .expect("letter progression");
        assert_eq!(pair.kind, CounterKind::Alpha);
        assert_eq!(pair.step, 1);

        let pair = classify_drift_pair("item7 finished cleanly", "item8 finished cleanly", 0.5)
            .expect("suffixed numeric progression");
        assert_eq!(pair.kind, CounterKind::Numeric);
        assert_eq!(pair.step, 1);
    }

    #[test]
    fn constant_non_unit_steps_are_still_drift_pairs() {
        let pair = classify_drift_pair("7 done", "9 done", 0.5).expect("constant step");
        assert_eq!(pair.kind, CounterKind::Numeric);
        assert_eq!(pair.step, 2);
    }

    #[test]
    fn unrelated_lines_are_not_drift_pairs() {
        assert!(classify_drift_pair("alpha done", "beta pending", 0.5).is_none());
        assert!(classify_drift_pair("same text", "same text", 0.5).is_none());
        assert!(classify_drift_pair("1 of 9", "2 of 8", 0.5).is_none());
        assert!(classify_drift_pair("only one line", "with extra tokens here", 0.5).is_none());
    }

    #[test]
    fn groups_consecutive_pairs_into_runs() {
        let lines = [
            "building variant 2074 of the matrix",
            "building variant 2075 of the matrix",
            "building variant 2076 of the matrix",
            "building variant 2077 of the matrix",
            "unrelated closing sentence",
        ];
        let runs = drift_runs(&lines, 0.5, 4);
        assert_eq!(runs.len(), 1);
        assert_eq!(runs[0].samples(), 4);
        assert_eq!(runs[0].steps, 3);
        assert_eq!(runs[0].step, 1);
    }

    #[test]
    fn short_runs_below_the_minimum_are_ignored() {
        let lines = ["item 1 done", "item 2 done", "item 3 done"];
        assert!(drift_runs(&lines, 0.5, 4).is_empty());
    }
}
