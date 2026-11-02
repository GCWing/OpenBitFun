//! Provider-neutral Router input budgeting. Calibration belongs to one execution,
//! not the service queue, root session, or provider prompt cache.

use super::RouterTokenCounter;
use std::sync::Mutex;

/// A local heuristic, not a tokenizer or a billing measurement. Non-ASCII text
/// receives more room than ordinary ASCII; the request budget also reserves slack.
pub struct EstimatedRouterTokens;

impl RouterTokenCounter for EstimatedRouterTokens {
    fn count(&self, text: &str) -> usize {
        let mut ascii = 0usize;
        let mut other = 0usize;
        for character in text.chars() {
            if character.is_ascii() {
                ascii += 1;
            } else {
                other += 1;
            }
        }
        ascii.div_ceil(3).saturating_add(other.saturating_mul(2))
    }

    fn name(&self) -> &'static str {
        "estimated_tokens"
    }
}

/// Keep cached text counts stable and adjust the allowed budget instead. Router
/// summaries rewrite the input, so a main-conversation prefix anchor cannot be
/// reused here. Successful full-input usage raises a conservative scale factor.
#[derive(Debug)]
pub struct RouterInputBudget {
    context_window: usize,
    max_input_tokens: usize,
    fixed_input_tokens: usize,
    reserve_tokens: usize,
    scale_millis: Mutex<u128>,
}

impl RouterInputBudget {
    pub fn new(context_window: usize, max_input_tokens: usize, system_tokens: usize) -> Self {
        Self {
            context_window,
            max_input_tokens,
            fixed_input_tokens: system_tokens.saturating_add(256),
            // Classification generates at most 128 tokens. Leave additional room
            // for heuristic error and service-side template differences.
            reserve_tokens: 128 + (context_window / 10).clamp(256, 8192),
            scale_millis: Mutex::new(1000),
        }
    }

    pub fn user_budget(&self) -> usize {
        let scale = *self.scale_millis.lock().unwrap_or_else(|e| e.into_inner());
        let total = self.context_window.saturating_sub(self.reserve_tokens) as u128;
        let raw_budget = ((total * 1000) / scale).min(usize::MAX as u128) as usize;
        let raw_input_cap =
            ((self.max_input_tokens as u128 * 1000) / scale).min(usize::MAX as u128) as usize;
        raw_budget
            .saturating_sub(self.fixed_input_tokens)
            .min(raw_input_cap)
    }

    /// `input_tokens` must be the server's complete prompt count, including cached
    /// input. Missing, malformed and zero usage is not evidence for calibration.
    pub fn observe_usage(&self, raw_user_tokens: usize, input_tokens: usize) {
        if input_tokens == 0 {
            return;
        }
        let raw_total = self.fixed_input_tokens.saturating_add(raw_user_tokens);
        if raw_total == 0 {
            return;
        }
        let mut scale = self.scale_millis.lock().unwrap_or_else(|e| e.into_inner());
        let measured = (input_tokens as u128 * 1000).div_ceil(raw_total as u128);
        if measured > *scale {
            // A lower later measurement never loosens a previously tightened
            // budget. Content composition may differ substantially each round.
            *scale = measured.saturating_mul(110).div_ceil(100);
        }
    }

    /// One rejected request falls back to the primary model. Tighten subsequent
    /// Router inputs without retrying classification or mutating session history.
    pub fn observe_overflow(&self, raw_user_tokens: usize) {
        let raw_total = self
            .fixed_input_tokens
            .saturating_add(raw_user_tokens)
            .max(1);
        let usable = self.context_window.saturating_sub(self.reserve_tokens) as u128;
        let required = (usable * 1000).div_ceil(raw_total as u128);
        let mut scale = self.scale_millis.lock().unwrap_or_else(|e| e.into_inner());
        *scale = (*scale).max(required).saturating_mul(3).div_ceil(2);
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn heuristic_counts_multilingual_and_empty_inputs_without_files() {
        let counter = EstimatedRouterTokens;
        assert_eq!(counter.count(""), 0);
        assert_eq!(counter.count("abcdef"), 2);
        assert_eq!(counter.count("你好🙂"), 6);
        assert!(counter.count("a") > 0);
    }

    #[test]
    fn complete_usage_tightens_budget_without_changing_cached_counts() {
        let budget = RouterInputBudget::new(8192, 8192, 300);
        let before = budget.user_budget();
        budget.observe_usage(2000, 5000);
        assert!(budget.user_budget() < before);
        let tightened = budget.user_budget();
        budget.observe_usage(2000, 1000);
        budget.observe_usage(2000, 0);
        assert_eq!(budget.user_budget(), tightened);
    }

    #[test]
    fn overflow_tightens_below_rejected_input_and_is_leaf_isolated() {
        let first = RouterInputBudget::new(8192, 8192, 300);
        let second = RouterInputBudget::new(8192, 8192, 300);
        let before = second.user_budget();
        first.observe_overflow(2000);
        assert!(first.user_budget() < 2000);
        assert_eq!(second.user_budget(), before);
    }

    #[test]
    fn explicit_small_input_cap_also_tracks_server_calibration() {
        let budget = RouterInputBudget::new(65536, 4096, 300);
        assert_eq!(budget.user_budget(), 4096);
        budget.observe_usage(2000, 8000);
        assert!(budget.user_budget() < 1400);
    }

    #[test]
    fn exhausted_budget_does_not_expand_to_a_minimum_prompt_size() {
        let budget = RouterInputBudget::new(1024, 1024, 900);
        assert_eq!(budget.user_budget(), 0);
        budget.observe_usage(usize::MAX, usize::MAX);
        budget.observe_overflow(usize::MAX);
        assert_eq!(budget.user_budget(), 0);
    }
}
