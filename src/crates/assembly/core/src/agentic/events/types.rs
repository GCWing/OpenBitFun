//! Unified event model
//!
//! Uses openbitfun-events layer event definitions, extending core-specific functionality here

use crate::agentic::core::SessionState;
use openbitfun_agent_runtime::session_state::session_state_label_for_state;

// ============ Re-export events layer types ============
pub use openbitfun_events::agentic::ErrorCategory;
pub use openbitfun_events::{
    AgenticEvent as BaseAgenticEvent, AgenticEventEnvelope as EventEnvelope,
    AgenticEventPriority as EventPriority, DeepReviewQueueReason, DeepReviewQueueState,
    DeepReviewQueueStatus, LoopDetectionEscalation, ModelRoundAttemptDiagnostic,
    ModelRoundAttemptToolDiagnostic, SubagentParentInfo, ToolEventData,
};

// ============ Core layer AgenticEvent extension ============

/// Core layer AgenticEvent
///
/// Used internally in core, contains full type information (SessionState)
/// When sent to transport layer, it is converted to BaseAgenticEvent (using serde_json::Value)
pub type AgenticEvent = BaseAgenticEvent;

// ============ Helper conversion functions ============

/// Convert SessionState to String (for transmission)
pub fn session_state_to_string(state: &SessionState) -> String {
    session_state_label_for_state(state).to_string()
}
