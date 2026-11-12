//! Typed classification of a target's answer to a dispatch status request.
//!
//! A status read can fail because the target is unreachable, or because the
//! target answered but has no record of the job. The second case means the
//! job was never delivered (an unknown first submit) or the target lost it,
//! and the controller UI must not present it as a transport outage.
//!
//! Wire compatibility: current target CLIs prefix the failure with
//! [`DISPATCH_JOB_NOT_FOUND_MARKER`]; older targets only emit the legacy text,
//! which is still recognized here. The controller always returns an error that
//! starts with the marker, so the renderer needs a single check (it also keeps
//! the legacy text check for controllers that predate this module).

use std::fmt;

/// Stable wire marker. Keep in sync with the target CLI store and the web UI
/// `DISPATCH_JOB_NOT_FOUND_MARKER`.
pub const DISPATCH_JOB_NOT_FOUND_MARKER: &str = "[dispatch_job_not_found]";

/// Text older target CLIs produce when the job directory or its commit marker
/// is missing.
const LEGACY_NOT_FOUND_TEXT: [&str; 2] =
    ["dispatch job not found:", "dispatch job is not committed:"];

/// The target answered that it has no record of the job.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct DispatchJobNotFoundOnTarget {
    pub job_id: String,
}

impl fmt::Display for DispatchJobNotFoundOnTarget {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        write!(
            formatter,
            "{DISPATCH_JOB_NOT_FOUND_MARKER} Dispatch job {} was not found on the target",
            self.job_id
        )
    }
}

impl std::error::Error for DispatchJobNotFoundOnTarget {}

/// True when a target error message says the job does not exist there.
pub fn is_target_job_not_found_message(message: &str) -> bool {
    if message.contains(DISPATCH_JOB_NOT_FOUND_MARKER) {
        return true;
    }
    let lower = message.to_ascii_lowercase();
    LEGACY_NOT_FOUND_TEXT
        .iter()
        .any(|legacy| lower.contains(legacy))
}

/// Replace a target "no such job" failure with the typed error; any other
/// failure (transport, protocol, authentication) is returned unchanged.
pub fn classify_target_status_error(job_id: &str, error: anyhow::Error) -> anyhow::Error {
    if error
        .downcast_ref::<DispatchJobNotFoundOnTarget>()
        .is_some()
    {
        return error;
    }
    if is_target_job_not_found_message(&format!("{error:#}")) {
        return anyhow::Error::new(DispatchJobNotFoundOnTarget {
            job_id: job_id.to_string(),
        });
    }
    error
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn current_target_marker_maps_to_typed_not_found() {
        let error = anyhow::anyhow!(
            "dispatch status failed (exit 1): {DISPATCH_JOB_NOT_FOUND_MARKER} dispatch job not found: job-1"
        );
        let classified = classify_target_status_error("job-1", error);
        assert_eq!(
            classified.downcast_ref::<DispatchJobNotFoundOnTarget>(),
            Some(&DispatchJobNotFoundOnTarget {
                job_id: "job-1".into()
            })
        );
        assert!(classified
            .to_string()
            .starts_with(DISPATCH_JOB_NOT_FOUND_MARKER));
    }

    #[test]
    fn legacy_target_text_maps_to_typed_not_found() {
        for message in [
            "dispatch status failed (exit 1): {\"error\":\"dispatch job not found: job-1: No such file or directory (os error 2)\"}",
            "dispatch job is not committed: job-1: No such file or directory (os error 2)",
        ] {
            let classified = classify_target_status_error("job-1", anyhow::anyhow!("{message}"));
            assert!(
                classified.downcast_ref::<DispatchJobNotFoundOnTarget>().is_some(),
                "{message}"
            );
        }
        // Context chains are inspected too: the legacy text may be a cause.
        let chained = anyhow::anyhow!("dispatch job not found: job-1")
            .context("device dispatch_target_status failed");
        assert!(classify_target_status_error("job-1", chained)
            .downcast_ref::<DispatchJobNotFoundOnTarget>()
            .is_some());
    }

    #[test]
    fn transport_failures_stay_unchanged() {
        for message in [
            "dispatch status failed (exit 255): ssh: connect to host build port 22: Operation timed out",
            "Outbound dispatch job was not found",
            "OpenBitFun CLI is not installed on the SSH target; confirm installation first",
        ] {
            let classified = classify_target_status_error("job-1", anyhow::anyhow!("{message}"));
            assert!(classified.downcast_ref::<DispatchJobNotFoundOnTarget>().is_none());
            assert_eq!(classified.to_string(), message);
        }
    }
}
