//! Accumulates per-turn billable tokens for active thread goals from model usage events.

use crate::agentic::coordination::get_global_coordinator;
use crate::agentic::events::AgenticEvent;
use log::debug;
use openbitfun_agent_runtime::thread_goal::{
    should_record_thread_goal_token_usage, ThreadGoalTokenUsageFacts,
};

/// Record at the model-usage producer before tools or turn settlement can run.
/// Event-bus consumers may lag behind those lifecycle decisions.
pub(crate) fn record_thread_goal_token_usage(event: &AgenticEvent) {
    let AgenticEvent::TokenUsageUpdated {
        session_id,
        turn_id,
        input_tokens,
        output_tokens,
        is_subagent,
        cached_tokens,
        ..
    } = event
    else {
        return;
    };

    let Some(billable) = should_record_thread_goal_token_usage(ThreadGoalTokenUsageFacts {
        input_tokens: *input_tokens,
        output_tokens: *output_tokens,
        cached_tokens: *cached_tokens,
        is_subagent: *is_subagent,
    }) else {
        return;
    };

    let Some(coordinator) = get_global_coordinator() else {
        return;
    };

    coordinator
        .thread_goal_runtime(session_id)
        .record_round_billable_tokens(turn_id, billable);

    debug!(
        "Thread goal token accounting: session_id={}, turn_id={}, billable={}",
        session_id, turn_id, billable
    );
}
