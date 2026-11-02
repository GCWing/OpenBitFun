//! Scheduled-job change events for product surfaces.
//!
//! Scheduled jobs can change without the rendering surface asking for it: the
//! agent creates or edits a job through the `Cron` tool, the scheduler mutates
//! run state, or a session delete removes its jobs. Surfaces that cache the
//! job list must be told to re-read it.
//!
//! Like the other `*://changed` hints, this is a hint, not a payload contract:
//! consumers re-read jobs through `list_cron_jobs` / `list_jobs_filtered`.

use serde::{Deserialize, Serialize};

/// Event name delivered to host UI surfaces (and mirrored to attached Peer
/// Mode controllers by the host adapter).
pub const CRON_JOBS_CHANGED_EVENT: &str = "cron://jobs-changed";

/// Why the job set changed. Serialized in camelCase.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub enum CronJobsChangedReason {
    /// A job was created.
    Created,
    /// A job's config was edited.
    Updated,
    /// One or more jobs were deleted.
    Deleted,
    /// Run state changed (trigger, enqueue, turn lifecycle), config untouched.
    StateChanged,
}

/// Payload for [`CRON_JOBS_CHANGED_EVENT`]. The job id is present when the
/// change concerns a single known job and absent for batch or unknown targets.
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct CronJobsChangedEvent {
    pub reason: CronJobsChangedReason,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub job_id: Option<String>,
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    #[test]
    fn serializes_camel_case_payload() {
        let payload = serde_json::to_value(CronJobsChangedEvent {
            reason: CronJobsChangedReason::Created,
            job_id: Some("cron_abc".to_string()),
        })
        .expect("payload should serialize");

        assert_eq!(payload, json!({ "reason": "created", "jobId": "cron_abc" }));
    }

    #[test]
    fn omits_absent_job_id() {
        let payload = serde_json::to_value(CronJobsChangedEvent {
            reason: CronJobsChangedReason::StateChanged,
            job_id: None,
        })
        .expect("payload should serialize");

        assert_eq!(payload, json!({ "reason": "stateChanged" }));
    }
}
