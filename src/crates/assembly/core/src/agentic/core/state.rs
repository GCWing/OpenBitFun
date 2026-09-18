//! State definitions.
//!
//! Keeps core-owned tool execution state and re-exports runtime-owned session state facts.

use crate::agentic::tools::framework::ToolResult;
pub use openbitfun_agent_runtime::session_state::{ProcessingPhase, SessionState};
use serde::{Deserialize, Serialize};
use std::time::SystemTime;

// ============ Tool Execution State ============

/// Tool execution state
#[derive(Debug, Clone, Serialize, Deserialize)]
pub enum ToolExecutionState {
    /// Queued waiting for execution
    Queued { position: usize },

    /// Waiting for dependent tools to complete
    Waiting { dependencies: Vec<String> },

    /// Running
    Running {
        started_at: SystemTime,
        progress: Option<f32>, // 0.0-1.0
    },

    /// Streaming output
    Streaming {
        started_at: SystemTime,
        chunks_received: usize,
    },

    /// Execution completed
    Completed {
        result: ToolResult,
        duration_ms: u64,
        #[serde(default, skip_serializing_if = "Option::is_none")]
        queue_wait_ms: Option<u64>,
        #[serde(default, skip_serializing_if = "Option::is_none")]
        preflight_ms: Option<u64>,
        #[serde(default, skip_serializing_if = "Option::is_none")]
        confirmation_wait_ms: Option<u64>,
        #[serde(default, skip_serializing_if = "Option::is_none")]
        execution_ms: Option<u64>,
    },

    /// Execution failed
    Failed {
        error: String,
        #[serde(default, skip_serializing_if = "Option::is_none")]
        error_detail: Option<openbitfun_core_types::errors::ToolErrorDetail>,
        is_retryable: bool,
        #[serde(default, skip_serializing_if = "Option::is_none")]
        duration_ms: Option<u64>,
        #[serde(default, skip_serializing_if = "Option::is_none")]
        queue_wait_ms: Option<u64>,
        #[serde(default, skip_serializing_if = "Option::is_none")]
        preflight_ms: Option<u64>,
        #[serde(default, skip_serializing_if = "Option::is_none")]
        confirmation_wait_ms: Option<u64>,
        #[serde(default, skip_serializing_if = "Option::is_none")]
        execution_ms: Option<u64>,
    },

    /// Rejected by user before execution
    Rejected {
        reason: String,
        #[serde(default, skip_serializing_if = "Option::is_none")]
        duration_ms: Option<u64>,
        #[serde(default, skip_serializing_if = "Option::is_none")]
        queue_wait_ms: Option<u64>,
        #[serde(default, skip_serializing_if = "Option::is_none")]
        preflight_ms: Option<u64>,
        #[serde(default, skip_serializing_if = "Option::is_none")]
        confirmation_wait_ms: Option<u64>,
        #[serde(default, skip_serializing_if = "Option::is_none")]
        execution_ms: Option<u64>,
    },

    /// Cancelled
    Cancelled {
        reason: String,
        #[serde(default, skip_serializing_if = "Option::is_none")]
        duration_ms: Option<u64>,
        #[serde(default, skip_serializing_if = "Option::is_none")]
        queue_wait_ms: Option<u64>,
        #[serde(default, skip_serializing_if = "Option::is_none")]
        preflight_ms: Option<u64>,
        #[serde(default, skip_serializing_if = "Option::is_none")]
        confirmation_wait_ms: Option<u64>,
        #[serde(default, skip_serializing_if = "Option::is_none")]
        execution_ms: Option<u64>,
    },
}

/// Tool statistics
#[derive(Debug, Clone, Default, Serialize, Deserialize)]
pub struct ToolStats {
    pub total_tools: usize,
    pub queued: usize,
    pub waiting: usize,
    pub running: usize,
    pub streaming: usize,
    pub completed: usize,
    pub failed: usize,
    pub rejected: usize,
    pub cancelled: usize,
}

// Note: DialogTurnState and ModelRoundState used to live here as a second
// (and divergent) copy of the same names found in `dialog_turn.rs` /
// `model_round.rs`. Both copies were dead code: turn / round lifecycle is
// tracked via `SessionState::Processing` + `TurnStatus` for persistence.
// Removed to avoid future ambiguity.
