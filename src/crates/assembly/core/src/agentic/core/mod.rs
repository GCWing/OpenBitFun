//! Core data model module
//!
//! Contains all core data structures and state definitions

pub mod dialog_turn;
pub mod message;
pub mod messages_helper;
pub mod session;
pub mod state;
pub use dialog_turn::{new_turn_id, TurnStats};
pub use message::{
    CompressedMessage, CompressedMessageRole, CompressedTodoItem, CompressedTodoSnapshot,
    CompressedToolCall, CompressionContract, CompressionContractItem, CompressionEntry,
    CompressionPayload, InternalReminderKind, Message, MessageContent, MessageRole,
    MessageSemanticKind, ToolCall, ToolResult,
};
pub use messages_helper::{MessageHelper, RequestReasoningTokenPolicy};
pub use openbitfun_agent_runtime::prompt_markup::{
    has_prompt_markup, is_system_reminder_only, render_system_reminder, render_user_query,
    strip_prompt_markup, PromptBlock, PromptBlockKind, PromptEnvelope,
};
pub use session::{
    sanitize_persisted_session_state, CompressionState, PersistedSessionStateFile, Session,
    SessionAgentRouteOwner, SessionConfig, SessionContinuationPolicy, SessionKind,
    SessionModelBindingPolicy, SessionSummary, ToolPresentationMode,
};
pub use state::{ProcessingPhase, SessionState, ToolExecutionState};
