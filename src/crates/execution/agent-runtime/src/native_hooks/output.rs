//! Hook stdout decision schema and aggregated dispatch outcome.
//!
//! On exit code 0 a hook may print a JSON object using the Codex output
//! schema (`continue`, `stopReason`, `systemMessage`, `suppressOutput`,
//! `decision`/`reason`, and per-event `hookSpecificOutput`). Unknown fields
//! are tolerated for forward compatibility.

use serde::Deserialize;
use serde_json::Value;

/// Raw stdout JSON as printed by a hook process (all fields optional).
#[derive(Debug, Clone, Default, Deserialize)]
pub(crate) struct RawHookOutput {
    #[serde(rename = "continue")]
    pub continue_: Option<bool>,
    #[serde(rename = "stopReason")]
    pub stop_reason: Option<String>,
    #[serde(rename = "systemMessage")]
    pub system_message: Option<String>,
    #[serde(rename = "suppressOutput")]
    pub suppress_output: Option<bool>,
    /// Legacy/common decision field: `"block"` blocks the event.
    pub decision: Option<String>,
    pub reason: Option<String>,
    #[serde(rename = "hookSpecificOutput")]
    pub hook_specific_output: Option<RawHookSpecificOutput>,
}

#[derive(Debug, Clone, Default, Deserialize)]
pub(crate) struct RawHookSpecificOutput {
    #[serde(rename = "hookEventName")]
    #[allow(dead_code)]
    pub hook_event_name: Option<String>,
    /// PreToolUse: `"allow"` | `"deny"`.
    #[serde(rename = "permissionDecision")]
    pub permission_decision: Option<String>,
    #[serde(rename = "permissionDecisionReason")]
    pub permission_decision_reason: Option<String>,
    /// PreToolUse: replacement tool input.
    #[serde(rename = "updatedInput")]
    pub updated_input: Option<Value>,
    /// PostToolUse (and others): extra model-visible context.
    #[serde(rename = "additionalContext")]
    pub additional_context: Option<String>,
    /// PermissionRequest: `{ "behavior": "allow"|"deny", "message": "..." }`.
    pub decision: Option<RawPermissionRequestDecision>,
}

#[derive(Debug, Clone, Default, Deserialize)]
pub(crate) struct RawPermissionRequestDecision {
    pub behavior: Option<String>,
    pub message: Option<String>,
}

/// Permission-shaped decision produced by PreToolUse `permissionDecision`
/// or PermissionRequest `decision.behavior`.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum AgentHookPermissionOutcome {
    Allow {
        reason: Option<String>,
    },
    Deny {
        reason: Option<String>,
    },
    /// Only enabled by registrations whose source contract supports ask.
    Ask {
        reason: Option<String>,
    },
}

/// Aggregated result of dispatching one event across all matching handlers.
///
/// Merge rules: the first blocking decision wins and stops later handlers;
/// a permission `deny` overrides an earlier `allow`; `updatedInput` from a
/// later handler replaces an earlier one; context and system messages are
/// collected from every handler.
#[derive(Debug, Clone, Default)]
pub struct AgentHookOutcome {
    /// Set when a handler blocked the event (`decision: "block"` or exit
    /// code 2, whose stderr becomes the reason).
    pub block_reason: Option<String>,
    pub permission: Option<AgentHookPermissionOutcome>,
    pub updated_input: Option<Value>,
    /// Model-visible context: `additionalContext` plus, for events where
    /// plain stdout is context, non-JSON stdout text.
    pub additional_context: Vec<String>,
    /// User-facing messages (`systemMessage`).
    pub system_messages: Vec<String>,
    /// Set when a handler asked to stop the whole turn (`continue: false`).
    pub stop_reason: Option<String>,
    /// Non-blocking handler problems (spawn failure, timeout, non-zero
    /// non-blocking exit codes, unparsable output).
    pub warnings: Vec<String>,
    pub suppress_output: bool,
    /// Number of handlers that were actually spawned.
    pub executed_handlers: usize,
}

impl AgentHookOutcome {
    pub fn is_blocked(&self) -> bool {
        self.block_reason.is_some()
    }

    pub fn permission_denied(&self) -> bool {
        matches!(
            self.permission,
            Some(AgentHookPermissionOutcome::Deny { .. })
        )
    }

    /// Fold one parsed stdout document into the aggregate. Returns `true`
    /// when dispatch should stop running further handlers (a final blocking
    /// or denying decision was made).
    pub(crate) fn apply_output_with_ask(
        &mut self,
        output: RawHookOutput,
        supports_ask: bool,
    ) -> bool {
        let mut finalized = false;
        if let Some(message) = non_empty(output.system_message) {
            self.system_messages.push(message);
        }
        if output.suppress_output == Some(true) {
            self.suppress_output = true;
        }
        if output.continue_ == Some(false) && self.stop_reason.is_none() {
            self.stop_reason = Some(
                non_empty(output.stop_reason)
                    .unwrap_or_else(|| "A hook requested to stop this turn.".to_string()),
            );
        }
        if output.decision.as_deref() == Some("block") && self.block_reason.is_none() {
            self.block_reason = Some(
                non_empty(output.reason)
                    .unwrap_or_else(|| "A hook blocked this event.".to_string()),
            );
            finalized = true;
        }
        if let Some(specific) = output.hook_specific_output {
            if supports_ask
                && specific.permission_decision.as_deref() == Some("ask")
                && !self.permission_denied()
            {
                self.permission = Some(AgentHookPermissionOutcome::Ask {
                    reason: non_empty(specific.permission_decision_reason.clone()),
                });
            }
            if let Some(context) = non_empty(specific.additional_context) {
                self.additional_context.push(context);
            }
            if let Some(updated_input) = specific.updated_input {
                self.updated_input = Some(updated_input);
            }
            // PreToolUse uses `permissionDecision`; PermissionRequest uses
            // `decision.behavior`. Both carry the same allow/deny vocabulary.
            finalized |= self.apply_permission_decision(
                specific.permission_decision.as_deref(),
                non_empty(specific.permission_decision_reason),
            );
            if let Some(decision) = specific.decision {
                finalized |= self.apply_permission_decision(
                    decision.behavior.as_deref(),
                    non_empty(decision.message),
                );
            }
        }
        finalized
    }

    /// Apply one allow/deny decision. A deny is final and outranks any
    /// earlier allow. Returns `true` when the dispatch is finalized.
    fn apply_permission_decision(
        &mut self,
        behavior: Option<&str>,
        reason: Option<String>,
    ) -> bool {
        match behavior {
            Some("deny") => {
                self.permission = Some(AgentHookPermissionOutcome::Deny { reason });
                true
            }
            Some("allow")
                if !self.permission_denied()
                    && !matches!(
                        self.permission,
                        Some(AgentHookPermissionOutcome::Ask { .. })
                    ) =>
            {
                self.permission = Some(AgentHookPermissionOutcome::Allow { reason });
                false
            }
            _ => false,
        }
    }
}

/// Normalize one hook-supplied string: trim it, drop it when empty, and hold
/// it to the model-visible output budget. Every decision field a hook can
/// surface to the model or the operator passes through here, so the budget
/// applies to JSON-supplied text exactly as it does to plain stdout.
pub(crate) fn non_empty(value: Option<String>) -> Option<String> {
    value
        .map(|value| value.trim().to_string())
        .filter(|value| !value.is_empty())
        .map(|value| super::engine::truncate_model_output(&value))
}
