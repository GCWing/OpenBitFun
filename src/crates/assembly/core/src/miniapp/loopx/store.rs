use openbitfun_product_domains::miniapp::loopx::{
    task_state_after_restart, LoopxEnvironmentSnapshot, LoopxEvent, LoopxEventKind,
    LoopxEventLevel, LoopxEventSource, LoopxEventsPageStatus, LoopxEventsSinceResponse,
    LoopxExecutionDomain, LoopxExecutionSupport, LoopxPhase, LoopxSnapshot, LoopxTaskSnapshot,
    LoopxTaskState,
};
use openbitfun_services_core::json_store::JsonFileStore;
use serde::{Deserialize, Serialize};
use std::collections::BTreeMap;
use std::path::{Path, PathBuf};

const LOOPX_STATE_SCHEMA_VERSION: u32 = 1;
const MAX_SEMANTIC_EVENTS: usize = 2_000;
const MAX_IDEMPOTENCY_KEYS: usize = 512;
const DEFAULT_EVENT_PAGE_SIZE: usize = 200;
const MAX_EVENT_PAGE_SIZE: usize = 1_000;

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(default, rename_all = "camelCase")]
pub struct LoopxPersistedState {
    pub schema_version: u32,
    pub stream_id: String,
    pub cursor: u64,
    pub revision: u64,
    pub environment: LoopxEnvironmentSnapshot,
    /// Durable BitFun host jobs and the last read-only LoopX Goal projection.
    /// LoopX registry state remains authoritative for Goal lifecycle facts.
    pub tasks: Vec<LoopxTaskSnapshot>,
    pub runtime: BTreeMap<String, LoopxTaskRuntimeRecord>,
    pub events: Vec<LoopxEvent>,
    pub processed_request_ids: Vec<String>,
    /// True while the user stopped the whole LoopX run (suite-level pause).
    /// Held intake and scheduling stay durable across host restarts; resume is
    /// an explicit `resume_all` action.
    #[serde(default)]
    pub suspended: bool,
}

#[derive(Debug, Clone, Default, Serialize, Deserialize)]
#[serde(default, rename_all = "camelCase")]
pub struct LoopxTaskRuntimeRecord {
    pub operation_id: String,
    pub registry_path: String,
    pub session_id: Option<String>,
    pub agent_turn_id: Option<String>,
    pub loopx_turn_id: Option<String>,
    pub settlement_token: Option<String>,
    pub expected_durable_revision: Option<String>,
    /// Last attempt time of the passive UI-attach Goal reconciliation. Tracked
    /// separately from `updated_at` because the reconcile's own progress
    /// events must not restart its throttle window.
    pub last_goal_reconcile_at_ms: Option<i64>,
    /// One-shot flag: after a NoDurableProgress settlement the host schedules
    /// exactly one corrective turn (with a host note) before parking the task
    /// for interactive recovery.
    pub durable_compensation_pending: bool,
    /// One-shot host note appended to the next agent instruction (used by the
    /// durable-writeback compensation turn).
    pub pending_host_note: Option<String>,
    /// One-shot flag: the pinned LoopX references (CLI help reference and the
    /// official workflow-skill documents) are injected only on the FIRST agent
    /// turn of the session (mirroring how a LoopX codex-style host loads its
    /// workflow skills once at session start), so later turns stay a small,
    /// cache-friendly instruction prefix instead of re-sending ~130KB.
    pub pinned_reference_injected: bool,
}

impl Default for LoopxPersistedState {
    fn default() -> Self {
        Self::new(0)
    }
}

impl LoopxPersistedState {
    pub fn new(_now_ms: i64) -> Self {
        Self {
            schema_version: LOOPX_STATE_SCHEMA_VERSION,
            stream_id: uuid::Uuid::new_v4().to_string(),
            cursor: 0,
            revision: 0,
            environment: LoopxEnvironmentSnapshot::default(),
            tasks: Vec::new(),
            runtime: BTreeMap::new(),
            events: Vec::new(),
            processed_request_ids: Vec::new(),
            suspended: false,
        }
    }

    pub fn snapshot(
        &self,
        execution_domain: LoopxExecutionDomain,
        execution_support: LoopxExecutionSupport,
        unsupported_reason: Option<String>,
        now_ms: i64,
    ) -> LoopxSnapshot {
        LoopxSnapshot {
            schema_version: self.schema_version,
            stream_id: self.stream_id.clone(),
            cursor: self.cursor,
            revision: self.revision,
            execution_domain,
            execution_support,
            unsupported_reason,
            environment: self.environment.clone(),
            tasks: self.tasks.clone(),
            generated_at: now_ms,
            suspended: self.suspended,
        }
    }

    pub fn apply_restart_policy(&mut self, now_ms: i64) -> bool {
        let mut changed = false;
        let mut recovery_required = 0usize;
        let mut requeued = 0usize;
        for task in &mut self.tasks {
            let restarted = task_state_after_restart(task.state);
            if restarted == task.state {
                continue;
            }
            task.state = restarted;
            task.phase = if restarted == LoopxTaskState::RecoveryRequired {
                recovery_required = recovery_required.saturating_add(1);
                task.recovery_reason = Some("host_restart".to_string());
                LoopxPhase::Recovering
            } else if restarted == LoopxTaskState::Queued {
                requeued = requeued.saturating_add(1);
                LoopxPhase::Queued
            } else {
                task.phase
            };
            task.revision = task.revision.saturating_add(1);
            task.updated_at = now_ms;
            task.current_tool = None;
            task.deadline_at = None;
            task.retry_at = None;
            changed = true;
        }
        if changed {
            let needs_recovery = recovery_required > 0;
            let message = match (needs_recovery, requeued > 0) {
                (true, true) => {
                    "Host restarted; interrupted LoopX tasks require recovery and pending tasks were requeued"
                }
                (true, false) => "Host restarted; interrupted LoopX tasks require explicit recovery",
                (false, true) => "Host restarted; pending LoopX tasks were requeued",
                (false, false) => "Host restarted; LoopX task state was refreshed",
            };
            self.revision = self.revision.saturating_add(1);
            self.append_event(LoopxEvent {
                kind: LoopxEventKind::SnapshotInvalidated,
                level: if needs_recovery {
                    LoopxEventLevel::Warning
                } else {
                    LoopxEventLevel::Info
                },
                source: LoopxEventSource::Controller,
                phase: Some(if needs_recovery {
                    LoopxPhase::Recovering
                } else {
                    LoopxPhase::Queued
                }),
                message: message.to_string(),
                important: needs_recovery,
                occurred_at: now_ms,
                ..LoopxEvent::default()
            });
        }
        changed
    }

    pub fn append_event(&mut self, mut event: LoopxEvent) {
        self.cursor = self.cursor.saturating_add(1);
        event.stream_id = self.stream_id.clone();
        event.cursor = self.cursor;
        self.events.push(event);
        if self.events.len() > MAX_SEMANTIC_EVENTS {
            let remove = self.events.len() - MAX_SEMANTIC_EVENTS;
            self.events.drain(0..remove);
        }
    }

    pub fn events_since(
        &self,
        stream_id: &str,
        after_cursor: u64,
        requested_limit: Option<u32>,
    ) -> LoopxEventsSinceResponse {
        if stream_id != self.stream_id {
            return LoopxEventsSinceResponse {
                status: LoopxEventsPageStatus::SnapshotRequired,
                stream_id: self.stream_id.clone(),
                next_cursor: self.cursor,
                ..LoopxEventsSinceResponse::default()
            };
        }

        let limit = requested_limit
            .map(|value| value as usize)
            .unwrap_or(DEFAULT_EVENT_PAGE_SIZE)
            .clamp(1, MAX_EVENT_PAGE_SIZE);
        let mut available = self
            .events
            .iter()
            .filter(|event| event.cursor > after_cursor);
        let events = available.by_ref().take(limit).cloned().collect::<Vec<_>>();
        let has_more = available.next().is_some();
        let next_cursor = events
            .last()
            .map(|event| event.cursor)
            .unwrap_or(after_cursor.min(self.cursor));
        LoopxEventsSinceResponse {
            status: LoopxEventsPageStatus::Current,
            stream_id: self.stream_id.clone(),
            events,
            next_cursor,
            has_more,
        }
    }

    pub fn has_processed_request(&self, request_id: &str) -> bool {
        self.processed_request_ids
            .iter()
            .any(|existing| existing == request_id)
    }

    pub fn record_processed_request(&mut self, request_id: String) {
        if request_id.is_empty() || self.has_processed_request(&request_id) {
            return;
        }
        self.processed_request_ids.push(request_id);
        if self.processed_request_ids.len() > MAX_IDEMPOTENCY_KEYS {
            let remove = self.processed_request_ids.len() - MAX_IDEMPOTENCY_KEYS;
            self.processed_request_ids.drain(0..remove);
        }
    }
}

#[derive(Debug, Clone)]
pub struct LoopxStateStore {
    path: PathBuf,
    json: JsonFileStore,
}

impl LoopxStateStore {
    pub fn new(path: PathBuf) -> Self {
        Self {
            path,
            json: JsonFileStore,
        }
    }

    pub fn path(&self) -> &Path {
        &self.path
    }

    pub async fn load(&self) -> Result<Option<LoopxPersistedState>, String> {
        self.json
            .read_locked_optional(&self.path)
            .await
            .map_err(|error| format!("Failed to load LoopX task state: {error}"))
    }

    pub async fn save(&self, state: &LoopxPersistedState) -> Result<(), String> {
        self.json
            .write_atomic_strict(&self.path, state)
            .await
            .map_err(|error| format!("Failed to persist LoopX task state: {error}"))
    }

    pub async fn clear(&self) -> Result<(), String> {
        match tokio::fs::remove_file(&self.path).await {
            Ok(()) => Ok(()),
            Err(error) if error.kind() == std::io::ErrorKind::NotFound => Ok(()),
            Err(error) => Err(format!("Failed to remove LoopX task state: {error}")),
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use openbitfun_product_domains::miniapp::loopx::{LoopxTaskSnapshot, LoopxTaskState};

    #[tokio::test]
    async fn restart_requeues_pending_work_and_recovers_inflight_work() {
        let root = tempfile::tempdir().expect("tempdir");
        let store = LoopxStateStore::new(root.path().join("loopx-state.json"));
        let mut state = LoopxPersistedState::new(10);
        state.tasks.push(LoopxTaskSnapshot {
            task_id: "task-1".to_string(),
            state: LoopxTaskState::Running,
            phase: LoopxPhase::AgentRunning,
            revision: 3,
            created_at: 1,
            updated_at: 2,
            ..LoopxTaskSnapshot::default()
        });
        state.tasks.push(LoopxTaskSnapshot {
            task_id: "task-2".to_string(),
            state: LoopxTaskState::RetryWait,
            phase: LoopxPhase::RetryBackoff,
            revision: 5,
            created_at: 1,
            updated_at: 2,
            retry_at: Some(30),
            ..LoopxTaskSnapshot::default()
        });
        assert!(state.apply_restart_policy(20));
        store.save(&state).await.expect("save");

        let loaded = store.load().await.expect("load").expect("state");
        assert_eq!(loaded.tasks[0].state, LoopxTaskState::RecoveryRequired);
        assert_eq!(
            loaded.tasks[0].recovery_reason.as_deref(),
            Some("host_restart")
        );
        assert_eq!(loaded.tasks[0].revision, 4);
        assert_eq!(loaded.tasks[1].state, LoopxTaskState::Queued);
        assert_eq!(loaded.tasks[1].phase, LoopxPhase::Queued);
        assert_eq!(loaded.tasks[1].retry_at, None);
        assert_eq!(loaded.tasks[1].recovery_reason, None);
        assert_eq!(loaded.tasks[1].revision, 6);
        assert_eq!(loaded.events[0].kind, LoopxEventKind::SnapshotInvalidated);
    }

    #[test]
    fn cursor_gap_and_pagination_are_explicit() {
        let mut state = LoopxPersistedState::new(1);
        for index in 0..3 {
            state.append_event(LoopxEvent {
                message: format!("event-{index}"),
                ..LoopxEvent::default()
            });
        }

        let wrong = state.events_since("old-stream", 0, None);
        assert_eq!(wrong.status, LoopxEventsPageStatus::SnapshotRequired);
        let first = state.events_since(&state.stream_id, 0, Some(2));
        assert_eq!(first.events.len(), 2);
        assert!(first.has_more);
        let second = state.events_since(&state.stream_id, first.next_cursor, Some(2));
        assert_eq!(second.events.len(), 1);
        assert!(!second.has_more);
    }
}
