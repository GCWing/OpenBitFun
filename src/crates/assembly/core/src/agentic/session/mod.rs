//! Session Management Layer
//!
//! Provides session lifecycle management and context management.

pub mod compression;
pub mod context_store;
mod context_usage;
pub mod evidence_ledger;
pub mod prompt_cache;
pub(crate) mod revert;
pub mod review_read_receipt;
pub mod session_manager;
pub mod session_store_port;
pub mod token_anchor;
pub(crate) mod transcript_render;
pub mod turn_skill_agent_snapshot_store;
pub(crate) mod turn_usage;

pub use compression::*;
pub use context_store::*;
pub use context_usage::*;
pub use evidence_ledger::*;
pub use prompt_cache::*;
pub use review_read_receipt::*;
pub use session_manager::*;
pub use session_store_port::*;
pub use token_anchor::*;
pub use turn_skill_agent_snapshot_store::*;

pub use openbitfun_runtime_ports::{
    SessionStorageKind, SessionStoragePathRequest, SessionStoragePathResolution,
    SessionTurnLoadTiming, SessionViewRestoreRequest, SessionViewRestoreTiming,
};
