//! Engine-owned loop-detection runtime state.
//!
//! Two facts live here that deliberately are *not* part of
//! `ExecutionEngineConfig`:
//!
//! * the installed L2 arbitration port, which has runtime identity and is
//!   registered after construction by product assembly (or a test);
//! * the per-session clear-detection escape hatch, which the plan requires so a
//!   session can switch detection off for itself without rewriting the persisted
//!   mode and without touching other sessions.
//!
//! The config stays a pure, cloneable value read from the persisted document;
//! nothing here reads or writes user configuration.

use super::arbiter::LoopArbiter;
use dashmap::DashMap;
use std::sync::{Arc, RwLock};

/// Shared loop-detection runtime state.
#[derive(Default)]
pub struct LoopDetectionRuntime {
    arbiter: RwLock<Option<Arc<dyn LoopArbiter>>>,
    /// Per-session overrides of `ai.loop_detection.session_enabled`. Only
    /// sessions that flipped the switch appear here, so a configuration change
    /// still reaches every session that never touched it.
    session_overrides: DashMap<String, bool>,
}

impl LoopDetectionRuntime {
    /// Registers the arbitration implementation. Registration is intentionally
    /// idempotent and last-writer-wins: it is installed once during assembly,
    /// and a later install (for example a test harness) replaces it.
    pub fn install_arbiter(&self, arbiter: Arc<dyn LoopArbiter>) {
        let mut slot = self
            .arbiter
            .write()
            .unwrap_or_else(|poisoned| poisoned.into_inner());
        *slot = Some(arbiter);
    }

    /// The installed arbitration port, when one exists.
    pub fn arbiter(&self) -> Option<Arc<dyn LoopArbiter>> {
        let slot = self
            .arbiter
            .read()
            .unwrap_or_else(|poisoned| poisoned.into_inner());
        slot.clone()
    }

    /// Whether detection is enabled for `session_id`.
    ///
    /// `configured_default` comes from `ai.loop_detection.session_enabled`; a
    /// session override wins over it for that session only.
    pub fn session_enabled(&self, session_id: &str, configured_default: bool) -> bool {
        self.session_overrides
            .get(session_id)
            .map(|value| *value)
            .unwrap_or(configured_default)
    }

    /// Session-scoped escape hatch (`clearDetection`): detection stops for this
    /// session, no matter what the persisted mode says, and no other session is
    /// affected. The override is explicit, so re-enabling a session whose
    /// configured default is `false` works as the caller expects.
    pub fn set_session_enabled(&self, session_id: &str, enabled: bool) {
        self.session_overrides
            .insert(session_id.to_string(), enabled);
    }
}
