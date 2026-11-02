//! Agentic facade and product runtime assembly.
//!
//! Portable contracts move to owner crates first; concrete orchestration stays
//! here until it can be split without changing tool, session, or review flows.

// Core module
pub mod core;
pub mod events;
pub mod persistence;
pub mod skill_agent_snapshot;

// Session management module
pub mod session;

// Execution engine module
pub mod execution;

// Tools module
pub mod tools;

// Coordination module
pub mod context_profile;
pub mod coordination;
pub mod deep_review;
pub mod deep_review_policy;
pub(crate) mod subagent_runtime;

// Shared-context fork-agent execution module
pub mod fork_agent;

/// Round-boundary injection support for steering/background updates
pub mod round_preempt;

// Image analysis module
pub mod image_analysis;
#[cfg(feature = "tools-image-generation")]
pub mod image_generation;
pub(crate) mod keyed_lock;
pub mod memories;
pub(crate) mod permission_policy;

// Ephemeral side-question module (used by desktop /btw overlay)
pub mod side_question;

// Session goal mode (/goal command)
pub mod goal_mode;
pub(crate) mod init_agents_md;
pub mod system;

// Agents module
pub mod agents;
pub mod workspace;

mod util;

// Insights module
pub mod insights;

pub use agents::*;
pub use context_profile::*;
pub use coordination::*;
pub use core::*;
pub use events::{queue, router, types as event_types};
pub use execution::*;
pub use fork_agent::*;
pub use goal_mode::*;
pub use image_analysis::{ImageAnalyzer, MessageEnhancer};
pub use memories::service::MemoryPhase1Service;
pub use memories::startup::{start_memory_startup_task, MemoryStartupRequest};
pub use memories::types::{MemoryExtractionRecord, MemoryPhase1RunStats, MemorySourceSession};
pub use persistence::PersistenceManager;
pub use round_preempt::{
    DialogRoundInjectionInterrupt, DialogRoundInjectionSource, NoopDialogRoundInjectionSource,
    RoundInjection, RoundInjectionKind, RoundInjectionTarget, SessionRoundInjectionBuffer,
};
pub use session::*;
pub use side_question::*;
pub use skill_agent_snapshot::*;
#[cfg(feature = "product-full")]
pub use system::init_agentic_system;
pub use system::{
    init_agentic_system_for_profile, init_agentic_system_for_profile_with_runtime_ownership,
    AgenticSystem,
};
pub use workspace::{WorkspaceBackend, WorkspaceBinding};
