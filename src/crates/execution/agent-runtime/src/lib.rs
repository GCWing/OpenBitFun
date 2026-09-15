//! Agent runtime owner contracts.
//!
//! This crate owns runtime decisions that can be built and tested without
//! depending on `openbitfun-core` concrete session or scheduler lifecycle.

#[cfg(feature = "agent-runtime")]
pub mod agents;
#[cfg(feature = "agent-runtime")]
pub mod checkpoint;
#[cfg(feature = "agent-runtime")]
pub mod compression_prefetch;
#[cfg(feature = "agent-runtime")]
pub mod context_profile;
#[cfg(any(feature = "agent-runtime", feature = "definition-contracts"))]
pub mod custom_agent;
#[cfg(feature = "agent-runtime")]
pub mod custom_subagent;
#[cfg(feature = "agent-runtime")]
pub mod deep_review;
#[cfg(feature = "agent-runtime")]
pub mod dialog_turn;
#[cfg(feature = "agent-runtime")]
pub mod event_bus;
#[cfg(feature = "agent-runtime")]
pub mod event_queue;
#[cfg(feature = "agent-runtime")]
pub mod event_router;
#[cfg(feature = "agent-runtime")]
pub mod event_source;
#[cfg(feature = "agent-runtime")]
pub mod events;
#[cfg(feature = "agent-runtime")]
pub mod evidence_ledger;
#[cfg(feature = "native-hook-settings")]
pub mod native_hooks;
#[cfg(feature = "agent-runtime")]
pub mod output_surface;
#[cfg(feature = "agent-runtime")]
pub mod permission;
#[cfg(feature = "agent-runtime")]
pub mod post_call_hooks;
#[cfg(any(feature = "agent-runtime", feature = "definition-contracts"))]
pub mod prompt;
#[cfg(feature = "agent-runtime")]
pub mod prompt_cache;
#[cfg(feature = "agent-runtime")]
pub mod prompt_markup;
#[cfg(feature = "agent-runtime")]
pub mod remote_file_delivery;
#[cfg(feature = "agent-runtime")]
pub mod review_read_receipt;
#[cfg(feature = "agent-runtime")]
pub mod runtime;
#[cfg(feature = "agent-runtime")]
pub mod scheduled_job;
#[cfg(feature = "agent-runtime")]
pub mod scheduler;
#[cfg(feature = "agent-runtime")]
pub mod sdk;
#[cfg(feature = "agent-runtime")]
pub mod session;
#[cfg(feature = "agent-runtime")]
pub mod session_control;
#[cfg(feature = "agent-runtime")]
pub mod session_state;
#[cfg(feature = "agent-runtime")]
pub mod session_state_manager;
#[cfg(feature = "agent-runtime")]
pub mod side_question;
#[cfg(feature = "agent-runtime")]
pub mod skill_agent_snapshot;
#[cfg(any(feature = "agent-runtime", feature = "definition-contracts"))]
pub mod skills;
#[cfg(feature = "agent-runtime")]
pub mod subagent_task;
#[cfg(feature = "agent-runtime")]
pub mod thread_goal;
#[cfg(feature = "agent-runtime")]
pub mod thread_goal_tools;
#[cfg(feature = "agent-runtime")]
pub mod turn_cancellation;
#[cfg(feature = "agent-runtime")]
pub mod user_questions;
