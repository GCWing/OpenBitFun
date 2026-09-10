use super::tool_activity::project_tool_activity;
use super::LoopxController;
use crate::agentic::events::{AgenticEvent, EventSubscriber};
use openbitfun_agent_runtime::event_bus::{EventBusError, EventSubscriberResult};
use openbitfun_core_types::errors::{AiErrorDetail, ErrorCategory};
use openbitfun_product_domains::miniapp::loopx::LoopxAgentTurnStatus;
use std::collections::HashMap;
use std::sync::{Arc, Mutex};
use std::time::{Duration, Instant};

const ACTIVITY_PERSIST_INTERVAL: Duration = Duration::from_secs(2);
const MAX_FINAL_RESPONSE_CHARS: usize = 16_000;

pub struct LoopxEventSubscriber {
    controller: Arc<LoopxController>,
    activity: ActivityGate,
}

impl LoopxEventSubscriber {
    pub fn new(controller: Arc<LoopxController>) -> Self {
        Self {
            controller,
            activity: ActivityGate::default(),
        }
    }
}

#[derive(Default)]
struct ActivityGate(Mutex<HashMap<String, TurnActivity>>);

#[derive(Default)]
struct TurnActivity {
    last_persisted: Option<Instant>,
    stream_events: u64,
    suppressed_tool_events: u64,
    tool_lifecycle_events: u64,
    persisted_checkpoints: u64,
    latest_round_id: Option<String>,
    latest_attempt_id: Option<String>,
    latest_round_text: String,
}

#[derive(Debug, Default, PartialEq, Eq)]
struct ActivitySummary {
    stream_events: u64,
    suppressed_tool_events: u64,
    tool_lifecycle_events: u64,
    persisted_checkpoints: u64,
    final_response: Option<String>,
}

impl ActivityGate {
    fn start_round(&self, turn_id: &str, round_id: &str) {
        let mut turns = self
            .0
            .lock()
            .unwrap_or_else(|poisoned| poisoned.into_inner());
        let activity = turns.entry(turn_id.to_string()).or_default();
        if activity.latest_round_id.as_deref() != Some(round_id) {
            activity.latest_round_id = Some(round_id.to_string());
            activity.latest_attempt_id = None;
            activity.latest_round_text.clear();
        }
    }

    fn record_text(&self, turn_id: &str, round_id: &str, attempt_id: Option<&str>, text: &str) {
        let mut turns = self
            .0
            .lock()
            .unwrap_or_else(|poisoned| poisoned.into_inner());
        let activity = turns.entry(turn_id.to_string()).or_default();
        let round_changed = activity.latest_round_id.as_deref() != Some(round_id);
        let attempt_changed = !round_changed
            && attempt_id.is_some_and(|incoming| {
                activity
                    .latest_attempt_id
                    .as_deref()
                    .is_some_and(|current| current != incoming)
            });
        if round_changed || attempt_changed {
            activity.latest_round_id = Some(round_id.to_string());
            activity.latest_attempt_id = attempt_id.map(str::to_string);
            activity.latest_round_text.clear();
        } else if activity.latest_attempt_id.is_none() {
            activity.latest_attempt_id = attempt_id.map(str::to_string);
        }
        append_bounded_text(
            &mut activity.latest_round_text,
            text,
            MAX_FINAL_RESPONSE_CHARS,
        );
    }

    fn record_stream(&self, turn_id: &str, force: bool) -> bool {
        self.record_stream_at(turn_id, Instant::now(), force)
    }

    fn record_stream_at(&self, turn_id: &str, now: Instant, force: bool) -> bool {
        let mut turns = self
            .0
            .lock()
            .unwrap_or_else(|poisoned| poisoned.into_inner());
        let activity = turns.entry(turn_id.to_string()).or_default();
        activity.stream_events = activity.stream_events.saturating_add(1);
        let should_persist = force
            || activity
                .last_persisted
                .is_none_or(|last| now.duration_since(last) >= ACTIVITY_PERSIST_INTERVAL);
        if should_persist {
            activity.last_persisted = Some(now);
            activity.persisted_checkpoints = activity.persisted_checkpoints.saturating_add(1);
        }
        should_persist
    }

    fn record_suppressed_tool_event(&self, turn_id: &str) -> bool {
        let now = Instant::now();
        let mut turns = self
            .0
            .lock()
            .unwrap_or_else(|poisoned| poisoned.into_inner());
        let activity = turns.entry(turn_id.to_string()).or_default();
        activity.suppressed_tool_events = activity.suppressed_tool_events.saturating_add(1);
        let should_persist = activity
            .last_persisted
            .is_none_or(|last| now.duration_since(last) >= ACTIVITY_PERSIST_INTERVAL);
        if should_persist {
            activity.last_persisted = Some(now);
            activity.persisted_checkpoints = activity.persisted_checkpoints.saturating_add(1);
        }
        should_persist
    }

    fn record_tool_lifecycle(&self, turn_id: &str) {
        let mut turns = self
            .0
            .lock()
            .unwrap_or_else(|poisoned| poisoned.into_inner());
        let activity = turns.entry(turn_id.to_string()).or_default();
        activity.last_persisted = Some(Instant::now());
        activity.tool_lifecycle_events = activity.tool_lifecycle_events.saturating_add(1);
        activity.persisted_checkpoints = activity.persisted_checkpoints.saturating_add(1);
    }

    fn finish(&self, turn_id: &str) -> Option<ActivitySummary> {
        self.0
            .lock()
            .unwrap_or_else(|poisoned| poisoned.into_inner())
            .remove(turn_id)
            .map(|activity| ActivitySummary {
                stream_events: activity.stream_events,
                suppressed_tool_events: activity.suppressed_tool_events,
                tool_lifecycle_events: activity.tool_lifecycle_events,
                persisted_checkpoints: activity.persisted_checkpoints,
                final_response: (!activity.latest_round_text.trim().is_empty())
                    .then(|| activity.latest_round_text.trim().to_string()),
            })
    }
}

impl LoopxEventSubscriber {
    fn finish_activity(&self, turn_id: &str) -> Option<ActivitySummary> {
        let Some(summary) = self.activity.finish(turn_id) else {
            return None;
        };
        log::info!(
            "LoopX Agent event projection summary: turn_id={}, stream_events={}, suppressed_tool_events={}, tool_lifecycle_events={}, persisted_checkpoints={}",
            turn_id,
            summary.stream_events,
            summary.suppressed_tool_events,
            summary.tool_lifecycle_events,
            summary.persisted_checkpoints
        );
        Some(summary)
    }
}

#[async_trait::async_trait]
impl EventSubscriber for LoopxEventSubscriber {
    async fn on_event(&self, event: &AgenticEvent) -> EventSubscriberResult {
        let result = match event {
            AgenticEvent::TextChunk {
                turn_id,
                round_id,
                attempt_id,
                text,
                ..
            } => {
                self.activity
                    .record_text(turn_id, round_id, attempt_id.as_deref(), text);
                if self.activity.record_stream(turn_id, false) {
                    self.controller.handle_agent_activity(turn_id).await
                } else {
                    Ok(())
                }
            }
            AgenticEvent::ThinkingChunk { turn_id, .. } => {
                if self.activity.record_stream(turn_id, false) {
                    self.controller.handle_agent_activity(turn_id).await
                } else {
                    Ok(())
                }
            }
            AgenticEvent::ModelRoundStarted {
                turn_id, round_id, ..
            } => {
                self.activity.start_round(turn_id, round_id);
                if self.activity.record_stream(turn_id, true) {
                    self.controller.handle_agent_activity(turn_id).await
                } else {
                    Ok(())
                }
            }
            AgenticEvent::ToolEvent {
                turn_id,
                tool_event,
                ..
            } => {
                if let Some(activity) = project_tool_activity(tool_event) {
                    self.activity.record_tool_lifecycle(turn_id);
                    self.controller
                        .handle_agent_tool_activity(turn_id, activity)
                        .await
                } else if self.activity.record_suppressed_tool_event(turn_id) {
                    self.controller.handle_agent_activity(turn_id).await
                } else {
                    Ok(())
                }
            }
            AgenticEvent::DialogTurnCompleted {
                turn_id,
                success,
                has_final_response,
                ..
            } => {
                let summary = self.finish_activity(turn_id).and_then(|summary| {
                    (has_final_response.unwrap_or(true))
                        .then_some(summary.final_response)
                        .flatten()
                });
                let status = if *success == Some(false) {
                    LoopxAgentTurnStatus::Failed
                } else {
                    LoopxAgentTurnStatus::Completed
                };
                self.controller
                    .handle_agent_terminal(turn_id, status, summary, false)
                    .await
            }
            AgenticEvent::DialogTurnFailed {
                turn_id,
                error,
                error_category,
                error_detail,
                ..
            } => {
                let _ = self.finish_activity(turn_id);
                let summary = failure_summary(error, error_detail.as_ref());
                let blocks_repository =
                    failure_blocks_repository(error_category.as_ref(), error_detail.as_ref());
                self.controller
                    .handle_agent_terminal(
                        turn_id,
                        LoopxAgentTurnStatus::Failed,
                        Some(summary),
                        blocks_repository,
                    )
                    .await
            }
            AgenticEvent::DialogTurnCancelled { turn_id, .. } => {
                let _ = self.finish_activity(turn_id);
                self.controller
                    .handle_agent_terminal(turn_id, LoopxAgentTurnStatus::Cancelled, None, false)
                    .await
            }
            AgenticEvent::DialogTurnInterrupted { turn_id, .. } => {
                let _ = self.finish_activity(turn_id);
                self.controller
                    .handle_agent_terminal(turn_id, LoopxAgentTurnStatus::Interrupted, None, false)
                    .await
            }
            _ => Ok(()),
        };
        result.map_err(EventBusError::subscriber)
    }
}

fn append_bounded_text(buffer: &mut String, text: &str, max_chars: usize) {
    buffer.push_str(text);
    let total = buffer.chars().count();
    if total > max_chars {
        // Keep the TAIL, not the head: the agent's structured summary
        // contract (`loopx_summary_v1`) emits its fenced JSON at the END of
        // the final response, so a head-keeping bound would cut exactly the
        // part the structured parser and the UI need (live 2026-09-10: the
        // issue-closeout summary rendered as a truncated raw JSON fragment
        // like `"rejected": [{"route": ...` because the fenced block never
        // survived the bound).
        let skip = total - max_chars;
        let mut kept = String::with_capacity(max_chars);
        kept.extend(buffer.chars().skip(skip));
        *buffer = kept;
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn bounded_text_keeps_the_tail_for_structured_summaries() {
        // The `loopx_summary_v1` fenced JSON lands at the END of an agent's
        // final response; the bound must keep the tail so the structured
        // parser can find a complete fence (live 2026-09-10: head-keeping
        // bounds rendered the closeout summary as `"rejected": ...` raw
        // fragments).
        let mut buffer = String::new();
        append_bounded_text(&mut buffer, &"x".repeat(120), 100);
        append_bounded_text(&mut buffer, &"\n```loopx_summary_v1\n{}\n```", 100);

        assert_eq!(buffer.chars().count(), 100);
        assert!(buffer.starts_with('x'));
        assert!(buffer.contains("loopx_summary_v1"));
        assert!(buffer.trim_end().ends_with("```"));
    }

    #[test]
    fn activity_gate_coalesces_stream_chunks_but_allows_forced_boundaries() {
        let gate = ActivityGate::default();
        let now = Instant::now();

        assert!(gate.record_stream_at("turn-1", now, false));
        assert!(!gate.record_stream_at("turn-1", now + Duration::from_millis(500), false));
        assert!(gate.record_stream_at("turn-1", now + Duration::from_millis(600), true));
        assert!(!gate.record_stream_at("turn-1", now + Duration::from_secs(1), false));
        assert!(gate.record_stream_at("turn-1", now + Duration::from_secs(3), false));
    }

    #[test]
    fn clearing_activity_allows_the_next_generation_to_persist_immediately() {
        let gate = ActivityGate::default();
        let now = Instant::now();
        assert!(gate.record_stream_at("turn-1", now, false));
        let summary = gate.finish("turn-1").expect("activity summary");
        assert_eq!(summary.stream_events, 1);
        assert!(gate.record_stream_at("turn-1", now + Duration::from_millis(1), false));
    }

    #[test]
    fn stream_flood_produces_one_liveness_checkpoint_inside_the_interval() {
        let gate = ActivityGate::default();
        let now = Instant::now();
        let checkpoints = (0..10_000)
            .filter(|_| gate.record_stream_at("turn-1", now, false))
            .count();

        assert_eq!(checkpoints, 1);
        assert_eq!(
            gate.finish("turn-1").expect("activity summary"),
            ActivitySummary {
                stream_events: 10_000,
                persisted_checkpoints: 1,
                ..ActivitySummary::default()
            }
        );
    }

    #[test]
    fn final_response_uses_only_the_latest_model_round() {
        let gate = ActivityGate::default();
        gate.start_round("turn-1", "round-1");
        gate.record_text("turn-1", "round-1", Some("attempt-1"), "intermediate");
        gate.start_round("turn-1", "round-2");
        gate.record_text("turn-1", "round-2", Some("attempt-1"), "final ");
        gate.record_text("turn-1", "round-2", Some("attempt-1"), "answer");

        assert_eq!(
            gate.finish("turn-1")
                .and_then(|summary| summary.final_response),
            Some("final answer".to_string())
        );
    }

    #[test]
    fn superseded_attempt_does_not_leak_partial_text() {
        let gate = ActivityGate::default();
        gate.start_round("turn-1", "round-1");
        gate.record_text("turn-1", "round-1", Some("attempt-1"), "partial");
        gate.record_text("turn-1", "round-1", Some("attempt-2"), "retry answer");

        assert_eq!(
            gate.finish("turn-1")
                .and_then(|summary| summary.final_response),
            Some("retry answer".to_string())
        );
    }
}

fn failure_summary(error: &str, detail: Option<&AiErrorDetail>) -> String {
    detail
        .and_then(|detail| detail.provider_message.as_deref())
        .filter(|message| !message.trim().is_empty())
        .unwrap_or(error)
        .chars()
        .take(1_000)
        .collect()
}

fn failure_blocks_repository(
    category: Option<&ErrorCategory>,
    detail: Option<&AiErrorDetail>,
) -> bool {
    let category = category.or_else(|| detail.map(|detail| &detail.category));
    matches!(
        category,
        Some(
            ErrorCategory::Network
                | ErrorCategory::Auth
                | ErrorCategory::RateLimit
                | ErrorCategory::Timeout
                | ErrorCategory::ProviderQuota
                | ErrorCategory::ProviderBilling
                | ErrorCategory::ProviderUnavailable
                | ErrorCategory::Permission
                | ErrorCategory::InvalidRequest
                | ErrorCategory::ModelError
        )
    )
}
