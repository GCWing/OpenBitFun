//! The L2 arbitration port.
//!
//! L1 is a heuristic: cheap, offline, and occasionally wrong on text that is
//! repetitive for a legitimate reason. The plan therefore gives the boundary
//! cases an arbitration layer (a fast model judging a summarized signal, with
//! the observed model excluded as judge) and requires that the layer be
//! optional: unavailable arbitration degrades to the pure heuristic instead of
//! taking L1 down with it.
//!
//! This module is the port only. Core does not implement a judge, does not pick
//! a model, and does not build a prompt: an implementation is registered from
//! the outside through [`crate::agentic::execution::loop_detection::LoopDetectionRuntime`].
//!
//! Decision semantics, which the ladder depends on:
//!
//! * [`ArbiterDecision::Confirmed`] — the judge agrees. The ladder may escalate
//!   this verdict, including to a hard stop and including confidence-capped
//!   kinds it may otherwise never stop on.
//! * [`ArbiterDecision::Rejected`] — the judge disagrees. The verdict is dropped:
//!   no steer, no hard stop, no attempt counting. Telemetry still records it,
//!   because a rejected verdict is exactly the calibration data the plan wants.
//! * [`ArbiterDecision::Indeterminate`] — no usable answer (no judge installed,
//!   judge disabled, judge budget spent, or the judge itself abstained). The
//!   heuristic verdict stands, and the kind's own caps still apply.

use super::ladder::LoopSignalSource;
use openbitfun_agent_stream::LoopVerdict;

/// What the arbitration layer decided about one L1 verdict.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum ArbiterDecision {
    /// The judge agrees the repetition is degenerate.
    Confirmed,
    /// The judge disagrees; the verdict must not drive an intervention.
    Rejected,
    /// No usable judgement; keep the heuristic verdict and its caps.
    Indeterminate,
}

impl ArbiterDecision {
    /// Stable identifier for logs and telemetry.
    pub const fn as_str(self) -> &'static str {
        match self {
            Self::Confirmed => "confirmed",
            Self::Rejected => "rejected",
            Self::Indeterminate => "indeterminate",
        }
    }
}

/// The minimal turn facts an arbitrating judge needs.
///
/// Deliberately small: the verdict carries the evidence (kind, confidence, and
/// already-truncated excerpts), and everything else a judge must know is
/// identity — which session and turn it is analyzing, on which round, produced
/// by which model, and which stream showed the repetition. The judge is
/// required to avoid arbitrating its own model's output, which is why
/// `model_id` travels with the request rather than being resolved by the judge.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct LoopArbiterContext {
    /// Session whose turn produced the verdict.
    pub session_id: String,
    /// Dialog turn being observed.
    pub turn_id: String,
    /// Round index inside that turn.
    pub round_index: usize,
    /// Model that produced the observed round. A judge must not be this model.
    pub model_id: String,
    /// Agent type driving the turn, for judge prompt framing.
    pub agent_type: String,
    /// Stream whose repetition produced the verdict.
    pub signal_source: LoopSignalSource,
}

/// Arbitrates boundary-level L1 verdicts.
///
/// Implementations own their model call, prompt, and budget. They must be
/// side-effect free with respect to the turn: the only channel back is the
/// returned [`ArbiterDecision`]. A failure inside the implementation must
/// degrade to [`ArbiterDecision::Indeterminate`] rather than propagate, so a
/// broken judge cannot fail a turn.
#[async_trait::async_trait]
pub trait LoopArbiter: Send + Sync {
    async fn arbitrate(
        &self,
        verdict: &LoopVerdict,
        context: &LoopArbiterContext,
    ) -> ArbiterDecision;
}

/// Default port implementation: no arbitration is installed.
///
/// Returns [`ArbiterDecision::Indeterminate`] so the ladder keeps the heuristic
/// verdict and its caps. Installing no arbiter is a supported configuration,
/// not a degraded error path.
#[derive(Debug, Default, Clone, Copy)]
pub struct NoArbiter;

#[async_trait::async_trait]
impl LoopArbiter for NoArbiter {
    async fn arbitrate(
        &self,
        _verdict: &LoopVerdict,
        _context: &LoopArbiterContext,
    ) -> ArbiterDecision {
        ArbiterDecision::Indeterminate
    }
}
