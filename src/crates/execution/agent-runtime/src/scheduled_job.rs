//! Scheduled job runtime state and transition decisions.
//!
//! This module owns portable lifecycle state for scheduled agent turns. Concrete
//! storage, clock, schedule parsing, session creation, and scheduler submission
//! stay in the product runtime.

use serde::{Deserialize, Serialize};

pub const DEFAULT_SCHEDULED_JOB_RETRY_DELAY_MS: i64 = 5_000;

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum ScheduledJobRunStatus {
    Queued,
    Running,
    Ok,
    Error,
    Cancelled,
}

#[derive(Debug, Clone, Default, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ScheduledJobRuntimeState {
    #[serde(skip_serializing_if = "Option::is_none")]
    pub next_run_at_ms: Option<i64>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub pending_trigger_at_ms: Option<i64>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub retry_at_ms: Option<i64>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub last_trigger_at_ms: Option<i64>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub last_enqueued_at_ms: Option<i64>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub last_run_started_at_ms: Option<i64>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub last_run_finished_at_ms: Option<i64>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub last_duration_ms: Option<u64>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub last_run_status: Option<ScheduledJobRunStatus>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub last_error: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub active_turn_id: Option<String>,
    #[serde(default)]
    pub consecutive_failures: u32,
    #[serde(default)]
    pub coalesced_run_count: u32,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum ScheduledJobTriggerAction {
    Pending,
    Coalesced,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum ScheduledJobEnqueueFailureAction {
    Retry,
    DisableMissingSession,
}

impl ScheduledJobRuntimeState {
    pub fn mark_manual_trigger(&mut self, current_ms: i64) {
        if self.pending_trigger_at_ms.is_some() {
            self.coalesced_run_count = self.coalesced_run_count.saturating_add(1);
        }

        self.pending_trigger_at_ms = Some(current_ms);
        self.last_trigger_at_ms = Some(current_ms);
        self.retry_at_ms = None;
    }

    pub fn apply_due_scheduled_trigger(
        &mut self,
        scheduled_at_ms: i64,
        next_run_at_ms: Option<i64>,
    ) -> ScheduledJobTriggerAction {
        self.last_trigger_at_ms = Some(scheduled_at_ms);
        self.next_run_at_ms = next_run_at_ms;

        if self.active_turn_id.is_some() || self.pending_trigger_at_ms.is_some() {
            self.coalesced_run_count = self.coalesced_run_count.saturating_add(1);
            ScheduledJobTriggerAction::Coalesced
        } else {
            self.pending_trigger_at_ms = Some(scheduled_at_ms);
            self.retry_at_ms = None;
            ScheduledJobTriggerAction::Pending
        }
    }

    pub fn pending_is_due(&self, current_ms: i64) -> bool {
        let Some(pending_trigger_at_ms) = self.pending_trigger_at_ms else {
            return false;
        };

        let retry_at_ms = self.retry_at_ms.unwrap_or(pending_trigger_at_ms);
        retry_at_ms <= current_ms
    }

    pub fn next_wakeup_at_ms(&self) -> Option<i64> {
        let schedule_wakeup = self.next_run_at_ms;
        let retry_wakeup = self
            .pending_trigger_at_ms
            .map(|pending_trigger_at_ms| self.retry_at_ms.unwrap_or(pending_trigger_at_ms));

        match (schedule_wakeup, retry_wakeup) {
            (Some(left), Some(right)) => Some(left.min(right)),
            (Some(left), None) => Some(left),
            (None, Some(right)) => Some(right),
            (None, None) => None,
        }
    }

    pub fn mark_enqueued(&mut self, turn_id: String, enqueued_at_ms: i64, one_shot: bool) {
        self.active_turn_id = Some(turn_id);
        self.pending_trigger_at_ms = None;
        self.retry_at_ms = None;
        self.last_enqueued_at_ms = Some(enqueued_at_ms);
        self.last_run_status = Some(ScheduledJobRunStatus::Queued);
        self.last_error = None;

        if one_shot {
            self.next_run_at_ms = None;
        }
    }

    pub fn mark_enqueue_failed(
        &mut self,
        failed_at_ms: i64,
        error: String,
        retry_delay_ms: i64,
        missing_session: bool,
    ) -> ScheduledJobEnqueueFailureAction {
        self.last_run_status = Some(ScheduledJobRunStatus::Error);
        self.last_error = Some(error);
        self.last_run_finished_at_ms = Some(failed_at_ms);
        self.consecutive_failures = self.consecutive_failures.saturating_add(1);

        if missing_session {
            self.active_turn_id = None;
            self.next_run_at_ms = None;
            self.pending_trigger_at_ms = None;
            self.retry_at_ms = None;
            ScheduledJobEnqueueFailureAction::DisableMissingSession
        } else {
            self.retry_at_ms = Some(failed_at_ms + retry_delay_ms);
            ScheduledJobEnqueueFailureAction::Retry
        }
    }

    /// The trigger's dialog turn already exists, so the trigger was delivered by
    /// another owner: a second application instance racing the same trigger, or
    /// this instance before a restart that lost the enqueue result.
    ///
    /// A trigger's turn ID is derived from its scheduled timestamp, so every
    /// later delivery attempt for that trigger is rejected the same way.
    /// Retrying can never succeed, so record the trigger as delivered and stop
    /// counting failures instead of retrying until the process exits.
    pub fn mark_trigger_delivered_elsewhere(&mut self, delivered_at_ms: i64) {
        self.pending_trigger_at_ms = None;
        self.retry_at_ms = None;
        self.last_run_status = Some(ScheduledJobRunStatus::Ok);
        self.last_error = None;
        self.last_run_finished_at_ms = Some(delivered_at_ms);
        self.consecutive_failures = 0;
    }

    pub fn mark_turn_started(&mut self, started_at_ms: i64) {
        self.last_run_status = Some(ScheduledJobRunStatus::Running);
        self.last_run_started_at_ms = Some(started_at_ms);
    }

    pub fn mark_turn_completed(&mut self, finished_at_ms: i64, duration_ms: u64) {
        self.active_turn_id = None;
        self.last_run_status = Some(ScheduledJobRunStatus::Ok);
        self.last_error = None;
        self.last_duration_ms = Some(duration_ms);
        self.last_run_finished_at_ms = Some(finished_at_ms);
        self.last_run_started_at_ms = Some(finished_at_ms.saturating_sub(duration_ms as i64));
        self.consecutive_failures = 0;
    }

    pub fn mark_turn_failed(&mut self, failed_at_ms: i64, error: String) {
        self.active_turn_id = None;
        self.last_run_status = Some(ScheduledJobRunStatus::Error);
        self.last_error = Some(error);
        self.last_run_finished_at_ms = Some(failed_at_ms);
        self.consecutive_failures = self.consecutive_failures.saturating_add(1);
    }

    pub fn mark_turn_cancelled(&mut self, cancelled_at_ms: i64) {
        self.active_turn_id = None;
        self.last_run_status = Some(ScheduledJobRunStatus::Cancelled);
        self.last_error = None;
        self.last_run_finished_at_ms = Some(cancelled_at_ms);
    }

    pub fn recover_interrupted_turn_after_restart(
        &mut self,
        recovered_at_ms: i64,
        error_message: String,
    ) -> bool {
        if self.active_turn_id.is_none() {
            return false;
        }

        self.active_turn_id = None;
        self.pending_trigger_at_ms = None;
        self.retry_at_ms = None;
        self.last_run_status = Some(ScheduledJobRunStatus::Error);
        self.last_error = Some(error_message);
        self.last_run_finished_at_ms = Some(recovered_at_ms);
        self.consecutive_failures = self.consecutive_failures.saturating_add(1);
        true
    }

    pub fn mark_disabled(&mut self) {
        self.next_run_at_ms = None;
        self.clear_pending_trigger();
    }

    pub fn clear_pending_trigger(&mut self) {
        self.pending_trigger_at_ms = None;
        self.retry_at_ms = None;
    }

    pub fn ensure_pending_retry_at(&mut self, retry_at_ms: i64) -> bool {
        if self.pending_trigger_at_ms.is_some() && self.retry_at_ms.is_none() {
            self.retry_at_ms = Some(retry_at_ms);
            return true;
        }

        false
    }
}
