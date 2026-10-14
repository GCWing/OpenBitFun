//! Loop-detection telemetry attached to the context-health snapshot.
//!
//! The detection plan's first phase is calibration: run with reporting only and
//! measure false-positive rates before any default escalates to `Enforce`. These
//! fields exist so a single existing log line (`ContextHealthSnapshot`)
//! describes what detection saw and how far the ladder went, instead of forcing
//! log archaeology across the detector, the ladder, and the arbiter.

use openbitfun_events::LoopDetectionEscalation;

/// How far the loop-detection ladder escalated for the signal it was watching.
///
/// This is an action record, not a detector state: `Telemetry` also covers a
/// signal the ladder observed while deliberately not acting (report-only mode,
/// or a confidence-capped kind past its steer attempts).
#[derive(Debug, Clone, Copy, PartialEq, Eq, Default)]
pub enum LoopEscalationLevel {
    /// Detection is off for this turn (mode `off`, or the session escape hatch).
    #[default]
    Off,
    /// Observed and reported, never acted on.
    Telemetry,
    /// A steer reminder was injected at the round boundary.
    Steer,
    /// The turn was stopped with `loop_detected`.
    HardStop,
}

impl LoopEscalationLevel {
    /// Stable identifier for logs and telemetry.
    pub const fn as_str(self) -> &'static str {
        match self {
            Self::Off => "off",
            Self::Telemetry => "telemetry",
            Self::Steer => "steer",
            Self::HardStop => "hard_stop",
        }
    }

    /// Level reported on the product event for one ladder decision.
    ///
    /// The mapping is total on purpose. `Off` cannot coexist with a reported
    /// verdict — `LoopInterventionLadder::observe` returns before recording one
    /// while detection is disabled — and collapsing it into the report-only
    /// level keeps the emission site free of an unreachable branch that would
    /// otherwise have to guess.
    pub const fn event_escalation(self) -> LoopDetectionEscalation {
        match self {
            Self::Steer => LoopDetectionEscalation::Steered,
            Self::HardStop => LoopDetectionEscalation::Stopped,
            Self::Off | Self::Telemetry => LoopDetectionEscalation::Noted,
        }
    }
}

/// Loop-detection facts of the turn's most recent round observation.
///
/// Plain data on purpose: the snapshot must be loggable and comparable without
/// holding detector state, and a calibration run can serialize these fields
/// without pulling the detector's window into the report.
#[derive(Debug, Clone, Copy, Default, PartialEq)]
pub struct LoopHealthFields {
    /// Which stream produced the last verdict: `output` or `thinking`.
    pub signal_source: Option<&'static str>,
    /// Stable identifier of the last verdict kind (see `LoopKind::as_str`).
    pub verdict_kind: Option<&'static str>,
    /// Confidence of the last verdict.
    pub verdict_confidence: Option<f32>,
    /// Verdicts observed in this turn, including ones the arbiter rejected.
    pub verdict_count: usize,
    /// Steer reminders injected for the current signal.
    pub steer_attempts: usize,
    /// Outcome of the last L2 arbitration after the configured confidence gate,
    /// when one was requested: a confirmation below
    /// `judge_verdict_confidence_min` is reported as `indeterminate`, because that
    /// is the decision the ladder applied.
    pub arbitration: Option<&'static str>,
    /// Highest action the ladder took or attempted.
    pub escalation: LoopEscalationLevel,
}

impl LoopHealthFields {
    /// Whether this round produced a verdict worth logging.
    pub fn has_verdict(&self) -> bool {
        self.verdict_kind.is_some()
    }
}

#[cfg(test)]
mod tests {
    use super::{LoopEscalationLevel, LoopHealthFields};
    use openbitfun_events::LoopDetectionEscalation;

    #[test]
    fn escalation_levels_have_stable_labels() {
        assert_eq!(LoopEscalationLevel::default(), LoopEscalationLevel::Off);
        assert_eq!(LoopEscalationLevel::Off.as_str(), "off");
        assert_eq!(LoopEscalationLevel::Telemetry.as_str(), "telemetry");
        assert_eq!(LoopEscalationLevel::Steer.as_str(), "steer");
        assert_eq!(LoopEscalationLevel::HardStop.as_str(), "hard_stop");
    }

    #[test]
    fn product_event_levels_match_the_ladder_action() {
        assert_eq!(
            LoopEscalationLevel::Telemetry.event_escalation(),
            LoopDetectionEscalation::Noted
        );
        assert_eq!(
            LoopEscalationLevel::Off.event_escalation(),
            LoopDetectionEscalation::Noted
        );
        assert_eq!(
            LoopEscalationLevel::Steer.event_escalation(),
            LoopDetectionEscalation::Steered
        );
        assert_eq!(
            LoopEscalationLevel::HardStop.event_escalation(),
            LoopDetectionEscalation::Stopped
        );
    }

    #[test]
    fn empty_health_fields_report_no_verdict() {
        let fields = LoopHealthFields::default();

        assert!(!fields.has_verdict());
        assert_eq!(fields.verdict_count, 0);
        assert_eq!(fields.escalation, LoopEscalationLevel::Off);
    }
}
