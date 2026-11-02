//! Budgeted historical import, independent of the live observation backpressure.

use super::{
    entry_for_prompt, EstimatedRouterTokens, RouterContextState, RouterEntry, RouterEntryKind,
    RouterSummaryWork, RouterTokenCounter,
};
use serde_json::Value;

/// Execution-local accounting for one historical batch. The host must recreate
/// it after applying a summary; source cursors and checkpoint publication do not
/// change its accounting. Entries continue to live in the resumable Router state.
pub struct RouterHistoryBatch {
    max_prompt_tokens: usize,
    max_bytes: usize,
    prompt_tokens: usize,
    bytes: usize,
}

impl RouterHistoryBatch {
    /// Existing checkpoint entries may exceed a newly tightened budget. Keep
    /// them intact: summary_work can drain fitting prefixes before any append.
    pub fn new(state: &RouterContextState, max_prompt_tokens: usize) -> Self {
        let mut batch = Self::empty(state, max_prompt_tokens);
        for entry in &state.entries {
            batch.charge(entry);
        }
        batch
    }

    fn empty(state: &RouterContextState, max_prompt_tokens: usize) -> Self {
        // A widest sequence number accounts for later appends without rebuilding
        // the complete prompt. Summing individually rounded heuristic counts is
        // conservative compared with estimating their concatenation.
        let envelope = state.summary_prompt(u64::MAX, "[]");
        Self {
            max_prompt_tokens,
            // The existing heuristic charges at least one token per three ASCII
            // bytes (and more for non-ASCII). Count full serialized entries here,
            // including source IDs/metadata absent from the model prompt. This
            // separately bounds the retained queue; it is not provider token usage
            // or a bound on the host's total memory.
            max_bytes: max_prompt_tokens.saturating_mul(3),
            prompt_tokens: EstimatedRouterTokens.count(&envelope),
            bytes: envelope.len(),
        }
    }

    fn charge(&mut self, entry: &RouterEntry) {
        let (_, tokens, bytes) = Self::entry_cost(entry);
        self.prompt_tokens = self.prompt_tokens.saturating_add(tokens);
        self.bytes = self.bytes.saturating_add(bytes);
    }

    fn entry_cost(entry: &RouterEntry) -> (String, usize, usize) {
        let projected = entry_for_prompt(entry).to_string();
        let tokens = EstimatedRouterTokens.count(&projected).saturating_add(1);
        (
            projected,
            // Charge a comma even for the first entry, keeping the accumulator
            // independent of the buffer length and conservative at boundaries.
            tokens,
            serde_json::to_string(entry)
                .expect("Router observations serialize to JSON")
                .len()
                .saturating_add(1),
        )
    }

    fn fits(&self, tokens: usize, bytes: usize) -> bool {
        self.prompt_tokens.saturating_add(tokens) <= self.max_prompt_tokens
            && self.bytes.saturating_add(bytes) <= self.max_bytes
    }

    /// Append a projected observation only if the entire historical batch fits.
    /// A rejected observation leaves state unchanged so the host can summarize
    /// its current prefix and retry it without advancing the durable cursor.
    /// This path never evicts entries at the live 128-observation boundary.
    pub fn try_append(
        &mut self,
        state: &mut RouterContextState,
        source_id: &str,
        kind: RouterEntryKind,
        content: &Value,
        counter: &dyn RouterTokenCounter,
    ) -> bool {
        assert!(
            state.history_bootstrap.is_some(),
            "Historical import requires a bootstrap cursor"
        );
        let entry = state.observation_entry(source_id.into(), kind, content.clone(), counter);
        let (_, tokens, bytes) = Self::entry_cost(&entry);
        if !self.fits(tokens, bytes) {
            return false;
        }
        state.append_entry(entry, counter);
        self.prompt_tokens = self.prompt_tokens.saturating_add(tokens);
        self.bytes = self.bytes.saturating_add(bytes);
        true
    }

    /// Select a complete contiguous prefix in one pass, including on recovery
    /// when a persisted queue is larger than the newly resolved model budget.
    /// Only the selected prompt is built; candidate prefixes are not repeatedly
    /// cloned/serialized. The live summary API keeps its existing exact-counter
    /// behavior independently of this historical heuristic budget.
    pub fn summary_work(
        &self,
        state: &RouterContextState,
        recent_rounds: usize,
    ) -> Option<RouterSummaryWork> {
        let count = if recent_rounds == 0 {
            state.entries.len()
        } else {
            state.recent_start(recent_rounds)
        };
        let mut plan = Self::empty(state, self.max_prompt_tokens);
        let mut entries = String::from("[");
        let mut through = None;
        let mut pending_tokens = 0usize;
        for entry in state.entries.iter().take(count) {
            let (projected, tokens, bytes) = Self::entry_cost(entry);
            if !plan.fits(tokens, bytes) {
                break;
            }
            plan.prompt_tokens = plan.prompt_tokens.saturating_add(tokens);
            plan.bytes = plan.bytes.saturating_add(bytes);
            if through.is_some() {
                entries.push(',');
            }
            entries.push_str(&projected);
            through = Some(entry.sequence);
            pending_tokens = pending_tokens.saturating_add(entry.token_count);
        }
        entries.push(']');
        let through = through?;
        Some(RouterSummaryWork {
            base_through: state.summarized_through,
            through,
            omitted_through: state.omitted_through,
            pending_tokens,
            prompt: state.summary_prompt(through, &entries),
        })
    }
}

#[cfg(test)]
mod tests;
