//! Provider-neutral report resolution. IO and semantic compatibility belong to the execution host.

use openbitfun_core_types::background_delivery::{
    BackgroundDelivery, BackgroundReport, BackgroundReportDisposition as Disposition,
    BackgroundReportPolicy as Policy,
};

pub fn resolve_report(
    mut delivery: BackgroundDelivery,
    success: bool,
    finish_reason: &str,
    report: Option<BackgroundReport>,
    source: &str,
    now_ms: u64,
) -> BackgroundDelivery {
    let interrupted = !success
        || !matches!(
            finish_reason,
            "complete" | "end_turn" | "stop" | "background_quiet"
        );
    let (disposition, reason, decision_source) = if interrupted {
        (
            Disposition::Attention,
            format!("execution_{finish_reason}"),
            "runtime",
        )
    } else if delivery.execution_generation > 0 {
        // Recovery resolves a previously interrupted execution and is itself
        // a meaningful lifecycle result, even when its business output is quiet.
        (
            Disposition::Report,
            "recovery_completed".to_owned(),
            "runtime",
        )
    } else if matches!(delivery.policy, Policy::Always | Policy::Unknown(_)) {
        (
            Disposition::Report,
            "policy_requires_report".to_owned(),
            "policy",
        )
    } else if let Some(report) = report.filter(|report| {
        !report.reason.trim().is_empty()
            && matches!(
                report.disposition,
                Disposition::Quiet | Disposition::Report | Disposition::Attention
            )
    }) {
        (report.disposition, report.reason, source)
    } else {
        (
            Disposition::Report,
            "decision_unavailable".to_owned(),
            "fallback",
        )
    };
    delivery.disposition = disposition;
    delivery.reason = reason;
    delivery.decision_source = decision_source.to_owned();
    delivery.resolved_at_ms = Some(now_ms);
    delivery
}

/// An explicit run-scoped report proposal makes an otherwise empty natural
/// model ending valid. Thinking-only and interrupted rounds retain recovery.
pub fn accepts_quiet_model_end(
    delivery: Option<&BackgroundDelivery>,
    has_more_rounds: bool,
    had_text: bool,
    had_thinking: bool,
    partially_recovered: bool,
) -> bool {
    !has_more_rounds
        && !had_text
        && !had_thinking
        && !partially_recovered
        && delivery.is_some_and(|delivery| {
            matches!(delivery.policy, Policy::Inherit | Policy::Conditional)
                && delivery.resolved_at_ms.is_none()
                && delivery.proposal.as_ref().is_some_and(|report| {
                    report.disposition == Disposition::Quiet && !report.reason.trim().is_empty()
                })
        })
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn quiet_completion_requires_an_explicit_proposal_and_a_clean_natural_model_end() {
        let mut delivery =
            BackgroundDelivery::pending("task".into(), "run".into(), Policy::Conditional);
        assert!(!accepts_quiet_model_end(
            Some(&delivery),
            false,
            false,
            false,
            false
        ));
        delivery.proposal = Some(BackgroundReport {
            disposition: Disposition::Quiet,
            reason: "No changes.".into(),
        });
        assert!(accepts_quiet_model_end(
            Some(&delivery),
            false,
            false,
            false,
            false
        ));
        assert!(!accepts_quiet_model_end(None, false, false, false, false));
        for (more, text, thinking, partial) in [
            (true, false, false, false),
            (false, true, false, false),
            (false, false, true, false),
            (false, false, false, true),
        ] {
            assert!(!accepts_quiet_model_end(
                Some(&delivery),
                more,
                text,
                thinking,
                partial
            ));
        }
        delivery.policy = Policy::Always;
        assert!(!accepts_quiet_model_end(
            Some(&delivery),
            false,
            false,
            false,
            false
        ));
    }

    #[test]
    fn recovered_runs_publish_their_changed_lifecycle_without_erasing_history() {
        let mut delivery =
            BackgroundDelivery::pending("task".into(), "run".into(), Policy::Conditional);
        delivery.execution_generation = 1;
        let resolved = resolve_report(
            delivery,
            true,
            "background_quiet",
            Some(BackgroundReport {
                disposition: Disposition::Quiet,
                reason: "No business change.".into(),
            }),
            "structured",
            1,
        );
        assert_eq!(resolved.disposition, Disposition::Report);
        assert_eq!(resolved.reason, "recovery_completed");
    }

    #[test]
    fn execution_failure_and_always_policy_cannot_be_hidden_by_model_proposals() {
        let proposal = BackgroundReport {
            disposition: Disposition::Quiet,
            reason: "no change".into(),
        };
        let inherited = BackgroundDelivery::pending("task".into(), "run".into(), Policy::Inherit);
        assert_eq!(
            resolve_report(
                inherited.clone(),
                false,
                "provider_error",
                Some(proposal.clone()),
                "structured",
                1
            )
            .disposition,
            Disposition::Attention
        );
        assert_eq!(
            resolve_report(
                inherited,
                true,
                "partial_truncated",
                Some(proposal.clone()),
                "structured",
                1
            )
            .disposition,
            Disposition::Attention
        );
        let always = BackgroundDelivery::pending("task".into(), "run".into(), Policy::Always);
        assert_eq!(
            resolve_report(always, true, "complete", Some(proposal), "structured", 1).disposition,
            Disposition::Report
        );
    }

    #[test]
    fn absent_and_invalid_decisions_fail_open_but_valid_quiet_is_durable() {
        let pending = BackgroundDelivery::pending("task".into(), "run".into(), Policy::Conditional);
        for report in [
            None,
            Some(BackgroundReport {
                disposition: Disposition::Pending,
                reason: "wait".into(),
            }),
            Some(BackgroundReport {
                disposition: Disposition::Quiet,
                reason: String::new(),
            }),
        ] {
            assert_eq!(
                resolve_report(
                    pending.clone(),
                    true,
                    "complete",
                    report,
                    "compatibility",
                    1
                )
                .disposition,
                Disposition::Report
            );
        }
        let resolved = resolve_report(
            pending,
            true,
            "complete",
            Some(BackgroundReport {
                disposition: Disposition::Quiet,
                reason: "no reportable change".into(),
            }),
            "compatibility",
            42,
        );
        assert_eq!(resolved.disposition, Disposition::Quiet);
        assert_eq!(resolved.resolved_at_ms, Some(42));
    }
}
