//! Next-input prompt suggestion policy.
//!
//! After an interactive turn completes, the host may ask the same model over
//! the same request prefix to predict the user's next message. This module
//! owns the provider-neutral facts: which turns qualify, the instruction that
//! is appended at the request tail, the plain-text response contract,
//! reasoning selection, and per-session cancellation of in-flight
//! requests. Provider calls and event emission stay in Product Assembly.

use std::sync::Arc;

use dashmap::DashMap;
use openbitfun_core_types::{ReasoningPresetAction, ReasoningPresetDescriptor, SessionKind};
use openbitfun_runtime_ports::DialogTriggerSource;
use tokio_util::sync::CancellationToken;

/// Execution-context flag set by the coordinator for turns whose submitter can
/// show a suggestion in a chat input.
pub const PROMPT_SUGGESTION_ELIGIBLE_CONTEXT_KEY: &str = "prompt_suggestion_eligible";

const PROMPT_SUGGESTION_INSTRUCTION: &str = "This is an app-generated request for a suggested next user message. \
The user did not write this message. Your suggestion will appear in the user's empty message composer. \
They can accept it, edit it, or ignore it; it will not be sent automatically. \
Predict the single message this user is most likely to type next from the visible conversation. \
Use the whole conversation to understand their current intent and the latest exchange. \
Choose the action and specific object that best continue that intent, rather than a generally useful follow-up. \
Express its core naturally in the user's voice and language, keeping the requirements needed to retain its meaning. \
Choose the strongest grounded move even if several continuations are possible; uncertainty about exact wording or incidental details is not a reason to return null. \
Use null only when the conversation offers no grounded next move at all. \
Return exactly one natural user message as plain text, one line, at most 240 characters, or the literal null. \
No JSON, wrapping quotes, alternatives, or explanation. Do not continue the task or call tools.";

/// Instruction appended as the last user message of the suggestion request.
pub fn prompt_suggestion_instruction() -> &'static str {
    PROMPT_SUGGESTION_INSTRUCTION
}

/// Empty output and the literal null decline a suggestion. Preserve all other
/// model text verbatim; shape and length are guided only by the prompt.
pub fn prompt_suggestion_text(raw: String) -> Option<String> {
    match raw.trim() {
        "" | "null" => None,
        _ => Some(raw),
    }
}

/// Prefer disabled reasoning, then the lowest explicit effort or token budget.
/// Opaque custom presets use the catalog's declared order as the fallback.
pub fn lowest_prompt_suggestion_reasoning_preset(
    presets: &[ReasoningPresetDescriptor],
) -> Option<&ReasoningPresetDescriptor> {
    presets.iter().min_by_key(|preset| {
        let rank = preset
            .actions
            .iter()
            .filter_map(|action| match action {
                ReasoningPresetAction::Toggle { enabled: false } => Some((0, 0)),
                ReasoningPresetAction::Effort { value } => {
                    let effort = preset.effective_effort.as_deref().unwrap_or(value);
                    match effort {
                        "none" => Some((0, 0)),
                        "minimal" => Some((1, 0)),
                        "low" => Some((1, 1)),
                        "medium" => Some((1, 2)),
                        "high" => Some((1, 3)),
                        "xhigh" => Some((1, 4)),
                        "max" => Some((1, 5)),
                        "ultra" => Some((1, 6)),
                        _ => None,
                    }
                }
                ReasoningPresetAction::BudgetTokens { value } => Some((2, *value)),
                _ => None,
            })
            .min()
            .unwrap_or((3, 0));
        (rank, preset.order)
    })
}

/// Whether the submitter of a turn has a chat input that can show a suggestion.
///
/// Only interactive desktop/peer surfaces and the mobile remote-control relay
/// qualify. Headless CLI, detached dispatch, scheduled jobs, bots, SDK hosts,
/// Agent-to-Agent messages, ACP clients, subagents, and `/btw` children do not.
pub fn prompt_suggestion_source_eligible(
    trigger_source: DialogTriggerSource,
    session_kind: SessionKind,
    acp_transport: bool,
) -> bool {
    !acp_transport
        && session_kind == SessionKind::Standard
        && matches!(
            trigger_source,
            DialogTriggerSource::DesktopUi | DialogTriggerSource::RemoteRelay
        )
}

/// Terminal facts of a dialog turn relevant to offering a suggestion.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct PromptSuggestionTurnOutcome<'a> {
    pub finish_reason: &'a str,
    pub has_final_response: bool,
    pub used_local_final_response_synthesis: bool,
    pub emits_lifecycle_events: bool,
    pub is_subagent: bool,
}

/// Only a turn that ended naturally with a model-authored final reply gets a
/// suggestion; forced finalization, steering, and truncation do not.
pub fn turn_outcome_allows_prompt_suggestion(outcome: PromptSuggestionTurnOutcome<'_>) -> bool {
    outcome.finish_reason == "complete"
        && outcome.has_final_response
        && !outcome.used_local_final_response_synthesis
        && outcome.emits_lifecycle_events
        && !outcome.is_subagent
}

#[derive(Debug)]
struct InflightPromptSuggestion {
    turn_id: String,
    token: CancellationToken,
}

/// Per-session cancellation for in-flight suggestion requests. A newer turn
/// or suggestion on the same session supersedes the older request.
#[derive(Debug, Clone, Default)]
pub struct PromptSuggestionRuntime {
    inflight: Arc<DashMap<String, InflightPromptSuggestion>>,
}

impl PromptSuggestionRuntime {
    pub fn new() -> Self {
        Self::default()
    }

    /// Register a request for `turn_id`, cancelling any older request on the session.
    pub fn begin(&self, session_id: &str, turn_id: &str) -> CancellationToken {
        let token = CancellationToken::new();
        if let Some(previous) = self.inflight.insert(
            session_id.to_string(),
            InflightPromptSuggestion {
                turn_id: turn_id.to_string(),
                token: token.clone(),
            },
        ) {
            previous.token.cancel();
        }
        token
    }

    /// Cancel the in-flight request of a session. Returns whether one existed.
    pub fn cancel_session(&self, session_id: &str) -> bool {
        match self.inflight.remove(session_id) {
            Some((_, previous)) => {
                previous.token.cancel();
                true
            }
            None => false,
        }
    }

    /// Release the registration of a finished request without touching a newer one.
    pub fn finish(&self, session_id: &str, turn_id: &str) {
        self.inflight
            .remove_if(session_id, |_, inflight| inflight.turn_id == turn_id);
    }

    pub fn is_inflight(&self, session_id: &str) -> bool {
        self.inflight.contains_key(session_id)
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn only_interactive_standard_sessions_are_eligible() {
        assert!(prompt_suggestion_source_eligible(
            DialogTriggerSource::DesktopUi,
            SessionKind::Standard,
            false
        ));
        assert!(prompt_suggestion_source_eligible(
            DialogTriggerSource::RemoteRelay,
            SessionKind::Standard,
            false
        ));
        for source in [
            DialogTriggerSource::DesktopApi,
            DialogTriggerSource::AgentSession,
            DialogTriggerSource::ScheduledJob,
            DialogTriggerSource::Bot,
            DialogTriggerSource::Cli,
            DialogTriggerSource::SdkHost,
        ] {
            assert!(!prompt_suggestion_source_eligible(
                source,
                SessionKind::Standard,
                false
            ));
        }
        assert!(!prompt_suggestion_source_eligible(
            DialogTriggerSource::DesktopUi,
            SessionKind::Subagent,
            false
        ));
        assert!(!prompt_suggestion_source_eligible(
            DialogTriggerSource::DesktopUi,
            SessionKind::EphemeralChild,
            false
        ));
        assert!(!prompt_suggestion_source_eligible(
            DialogTriggerSource::DesktopUi,
            SessionKind::Standard,
            true
        ));
    }

    fn outcome(finish_reason: &str) -> PromptSuggestionTurnOutcome<'_> {
        PromptSuggestionTurnOutcome {
            finish_reason,
            has_final_response: true,
            used_local_final_response_synthesis: false,
            emits_lifecycle_events: true,
            is_subagent: false,
        }
    }

    #[test]
    fn only_naturally_completed_turns_allow_a_suggestion() {
        assert!(turn_outcome_allows_prompt_suggestion(outcome("complete")));
        for reason in [
            "max_rounds",
            "repeated_tool_failures",
            "user_steering",
            "partial_truncated",
        ] {
            assert!(!turn_outcome_allows_prompt_suggestion(outcome(reason)));
        }
        assert!(!turn_outcome_allows_prompt_suggestion(
            PromptSuggestionTurnOutcome {
                has_final_response: false,
                ..outcome("complete")
            }
        ));
        assert!(!turn_outcome_allows_prompt_suggestion(
            PromptSuggestionTurnOutcome {
                used_local_final_response_synthesis: true,
                ..outcome("complete")
            }
        ));
        assert!(!turn_outcome_allows_prompt_suggestion(
            PromptSuggestionTurnOutcome {
                emits_lifecycle_events: false,
                ..outcome("complete")
            }
        ));
        assert!(!turn_outcome_allows_prompt_suggestion(
            PromptSuggestionTurnOutcome {
                is_subagent: true,
                ..outcome("complete")
            }
        ));
    }

    #[test]
    fn plain_text_suggestion_preserves_the_model_text_verbatim() {
        for text in [
            "  Suggestion: \"Run the tests. Then commit.\"  ".to_string(),
            "我来运行测试。然后提交。\n不要裁剪这段文本。".to_string(),
            "a".repeat(300),
            "NONE".to_string(),
            "null is the expected value".to_string(),
            "{\"suggestion\":\"Run the tests\"}".to_string(),
        ] {
            assert_eq!(prompt_suggestion_text(text.clone()), Some(text));
        }
    }

    #[test]
    fn empty_output_and_literal_null_decline_a_suggestion() {
        for raw in ["", " \n\t ", "null", " \nnull\t "] {
            assert_eq!(prompt_suggestion_text(raw.to_string()), None, "{raw}");
        }
    }

    fn preset(
        id: &str,
        order: i32,
        actions: Vec<ReasoningPresetAction>,
    ) -> ReasoningPresetDescriptor {
        ReasoningPresetDescriptor {
            id: id.to_string(),
            label: id.to_string(),
            order,
            actions,
            source: openbitfun_core_types::ReasoningPresetSource::ModelConfig,
            effective_effort: None,
            execution_provider: None,
            execution_model: None,
        }
    }

    #[test]
    fn lowest_reasoning_prefers_off_and_orders_efforts_by_strength() {
        let mut presets = vec![
            preset(
                "high",
                0,
                vec![ReasoningPresetAction::Effort {
                    value: "high".into(),
                }],
            ),
            preset(
                "low",
                1,
                vec![ReasoningPresetAction::Effort {
                    value: "low".into(),
                }],
            ),
            preset(
                "minimal",
                2,
                vec![ReasoningPresetAction::Effort {
                    value: "minimal".into(),
                }],
            ),
        ];
        assert_eq!(
            lowest_prompt_suggestion_reasoning_preset(&presets)
                .unwrap()
                .id,
            "minimal"
        );
        presets.push(preset(
            "off",
            3,
            vec![ReasoningPresetAction::Toggle { enabled: false }],
        ));
        assert_eq!(
            lowest_prompt_suggestion_reasoning_preset(&presets)
                .unwrap()
                .id,
            "off"
        );
        presets[3].actions = vec![ReasoningPresetAction::Effort {
            value: "none".into(),
        }];
        assert_eq!(
            lowest_prompt_suggestion_reasoning_preset(&presets)
                .unwrap()
                .id,
            "off"
        );
    }

    #[test]
    fn lowest_reasoning_uses_effective_effort_and_smallest_budget() {
        let mut presets = vec![
            preset(
                "alias",
                0,
                vec![ReasoningPresetAction::Effort {
                    value: "low".into(),
                }],
            ),
            preset(
                "high",
                1,
                vec![ReasoningPresetAction::Effort {
                    value: "high".into(),
                }],
            ),
        ];
        presets[0].effective_effort = Some("max".into());
        assert_eq!(
            lowest_prompt_suggestion_reasoning_preset(&presets)
                .unwrap()
                .id,
            "high"
        );
        let budgets = vec![
            preset(
                "on",
                0,
                vec![ReasoningPresetAction::Toggle { enabled: true }],
            ),
            preset(
                "large",
                1,
                vec![ReasoningPresetAction::BudgetTokens { value: 8192 }],
            ),
            preset(
                "small",
                2,
                vec![ReasoningPresetAction::BudgetTokens { value: 1024 }],
            ),
        ];
        assert_eq!(
            lowest_prompt_suggestion_reasoning_preset(&budgets)
                .unwrap()
                .id,
            "small"
        );
        assert!(lowest_prompt_suggestion_reasoning_preset(&[]).is_none());
    }

    #[test]
    fn runtime_supersedes_and_releases_requests_per_session() {
        let runtime = PromptSuggestionRuntime::new();
        let first = runtime.begin("session-1", "turn-1");
        let second = runtime.begin("session-1", "turn-2");
        assert!(first.is_cancelled());
        assert!(!second.is_cancelled());

        runtime.finish("session-1", "turn-1");
        assert!(runtime.is_inflight("session-1"));

        let other = runtime.begin("session-2", "turn-1");
        assert!(runtime.cancel_session("session-1"));
        assert!(second.is_cancelled());
        assert!(!other.is_cancelled());
        assert!(!runtime.cancel_session("session-1"));

        runtime.finish("session-2", "turn-1");
        assert!(!runtime.is_inflight("session-2"));
        assert!(!other.is_cancelled());
    }
}
