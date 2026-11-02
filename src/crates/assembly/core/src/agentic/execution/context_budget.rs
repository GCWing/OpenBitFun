//! Input admission budgets shared by ordinary requests and pool routing.

use crate::service::config::types::automatic_max_output_tokens;
use openbitfun_core_types::model_pool::ModelPoolContextBudget;

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub(super) struct CompressionTriggerBudget {
    pub input_limit: usize,
    pub output_reserve_tokens: usize,
    pub safety_reserve_tokens: usize,
}

impl CompressionTriggerBudget {
    const SAFETY_RESERVE_TOKENS: usize = 10_000;

    pub(super) fn for_model(context_window: usize, configured_max_tokens: Option<u32>) -> Self {
        let output_reserve_tokens = configured_max_tokens
            .map(|value| value as usize)
            .unwrap_or_else(|| automatic_max_output_tokens(context_window as u32) as usize);
        let safety_reserve_tokens = Self::SAFETY_RESERVE_TOKENS;
        Self {
            input_limit: context_window
                .saturating_sub(output_reserve_tokens + safety_reserve_tokens),
            output_reserve_tokens,
            safety_reserve_tokens,
        }
    }

    pub(super) fn for_pool(budget: ModelPoolContextBudget) -> Self {
        let context_window = budget.context_window as usize;
        let input_limit = budget.input_limit as usize;
        let safety_reserve_tokens = Self::SAFETY_RESERVE_TOKENS.min(context_window);
        Self {
            input_limit,
            // This is an equivalent reserve for the common window, not a new
            // max_tokens setting for any member's provider request.
            output_reserve_tokens: context_window
                .saturating_sub(input_limit + safety_reserve_tokens),
            safety_reserve_tokens,
        }
    }
}
