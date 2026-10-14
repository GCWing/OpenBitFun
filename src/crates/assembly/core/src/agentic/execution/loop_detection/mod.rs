//! Product-side agent loop-detection wiring.
//!
//! Three owners meet here, and each keeps its own facts:
//!
//! * `openbitfun-agent-stream` owns the pure L1 detectors, their baselines, and
//!   the verdict shape. Nothing in that crate knows about sessions, profiles, or
//!   reminders.
//! * `openbitfun-agent-runtime` owns the tier table (`LoopDetectionPolicy`) that
//!   scales those baselines per context profile and model capability. It must not
//!   depend on the detector crate, so it exposes pure data plus scaling helpers.
//! * This module is the product wiring that connects them, and it owns the three
//!   decisions neither of those crates may make: how a verdict escalates into an
//!   intervention ([`LoopInterventionLadder`]), what the L2 arbitration port
//!   looks like ([`LoopArbiter`]), and which arbiter a session host installs
//!   ([`configured_model_loop_arbiter`]).
//!
//! Detection is observability first. The intervention ladder mirrors the
//! existing failed-tool recovery pipeline: a soft steer reminder at the round
//! boundary, a small attempt cap, then one hard fallback that ends the turn.
//! Nothing here retries, rewrites context, or blocks a round; the ladder only
//! reports what it decided and the engine performs the mechanics.
//!
//! Layout:
//!
//! * [`policy`] — pure `(tier policy, user overrides) -> LoopDetectorConfig`
//!   translation.
//! * [`ladder`] — the intervention state machine and its root-cause reminder copy.
//! * [`arbiter`] — the L2 arbitration port plus the no-arbiter default.
//! * [`model_arbiter`] — the model-backed judge adapted to that port, plus the
//!   registration gate session hosts use.
//! * [`runtime`] — engine-owned runtime state: the installed arbiter and the
//!   per-session clear-detection escape hatch.
//! * [`health`] — telemetry fields attached to the context-health snapshot.

mod arbiter;
mod health;
mod ladder;
mod model_arbiter;
mod policy;
mod runtime;

#[cfg(test)]
mod tests;

pub use arbiter::{ArbiterDecision, LoopArbiter, LoopArbiterContext, NoArbiter};
pub use health::{LoopEscalationLevel, LoopHealthFields};
pub use ladder::{
    render_loop_steer_text, round_text_and_reasoning, visible_completion_tokens,
    LoopInterventionLadder, LoopLadderAction, LoopLadderSettings, LoopLadderStep,
    LoopObservedVerdict, LoopRoundObservation, LoopSignalSource, LoopSteer, LoopUsageSample,
    LOOP_DETECTED_FINALIZATION_REASON, MAX_LOOP_RECOVERY_ATTEMPTS,
};
pub use model_arbiter::{
    arbitration_decision_for, configured_model_loop_arbiter, judge_request_for,
};
pub use policy::{loop_detector_config, structure_exclusions_enabled};
pub use runtime::LoopDetectionRuntime;
