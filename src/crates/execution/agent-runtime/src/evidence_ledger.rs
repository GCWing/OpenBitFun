use crate::checkpoint::LightCheckpoint;
use dashmap::DashMap;
use openbitfun_runtime_ports::{CompressionContract, CompressionContractItem};
use serde::{Deserialize, Serialize};
use std::collections::{HashMap, HashSet};
use std::sync::Arc;
use std::time::{SystemTime, UNIX_EPOCH};

const MAX_PARTIAL_OUTPUT_BYTES: usize = 8_000;
pub const EVIDENCE_LEDGER_SCHEMA_VERSION: u32 = 1;
/// Per-category evidence bound shared by compression and reliability reporting.
pub const DEFAULT_COMPRESSION_CONTRACT_LIMIT: usize = 8;

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub enum EvidenceLedgerTargetKind {
    #[serde(rename = "file")]
    File,
    #[serde(rename = "command")]
    Command,
    #[serde(rename = "subagent")]
    Subagent,
    #[serde(rename = "artifact")]
    Artifact,
    #[serde(rename = "checkpoint")]
    Checkpoint,
    #[serde(other, rename = "unknown")]
    Unknown,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub enum EvidenceLedgerEventStatus {
    #[serde(rename = "created")]
    Created,
    #[serde(rename = "succeeded")]
    Succeeded,
    #[serde(rename = "failed")]
    Failed,
    #[serde(rename = "partial_timeout")]
    PartialTimeout,
    #[serde(rename = "cancelled")]
    Cancelled,
    #[serde(other, rename = "unknown")]
    Unknown,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct EvidenceLedgerCheckpoint {
    #[serde(skip_serializing_if = "Option::is_none")]
    pub current_branch: Option<String>,
    pub dirty_state_summary: String,
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub touched_files: Vec<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub diff_hash: Option<String>,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct EvidenceLedgerEvent {
    pub event_id: String,
    pub session_id: String,
    pub turn_id: String,
    pub tool_name: String,
    pub target_kind: EvidenceLedgerTargetKind,
    pub target: String,
    pub status: EvidenceLedgerEventStatus,
    #[serde(default)]
    pub exit_code_or_error_kind: Option<String>,
    #[serde(default)]
    pub touched_files: Vec<String>,
    #[serde(default)]
    pub artifact_path: Option<String>,
    pub summary: String,
    #[serde(default)]
    pub partial_output: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub checkpoint: Option<EvidenceLedgerCheckpoint>,
    #[serde(default)]
    pub created_at_ms: u64,
}

/// Versioned sidecar owned by the runtime and written by product persistence.
///
/// Keeping evidence separate from mutable Session state lets older builds
/// rewrite `state.json` without erasing evidence produced by a newer build.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct PersistedEvidenceLedgerFile {
    #[serde(default = "default_evidence_ledger_schema_version")]
    pub schema_version: u32,
    pub session_id: String,
    #[serde(default)]
    pub events: Vec<EvidenceLedgerEvent>,
}

#[derive(Debug, Clone, PartialEq, Eq, thiserror::Error)]
pub enum EvidenceLedgerPersistenceError {
    #[error(
        "unsupported evidence ledger schema version {actual}; maximum supported is {supported}"
    )]
    UnsupportedSchema { actual: u32, supported: u32 },
    #[error("evidence ledger session mismatch: expected {expected}, found {actual}")]
    SessionMismatch { expected: String, actual: String },
    #[error("evidence ledger event has an empty event_id")]
    EmptyEventId,
    #[error("evidence ledger event {event_id} belongs to session {actual}, expected {expected}")]
    EventSessionMismatch {
        event_id: String,
        expected: String,
        actual: String,
    },
    #[error("evidence ledger contains conflicting payloads for event {event_id}")]
    ConflictingEvent { event_id: String },
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct EvidenceLedgerSummaryItem {
    pub event_id: String,
    pub turn_id: String,
    pub tool_name: String,
    pub target_kind: EvidenceLedgerTargetKind,
    pub target: String,
    pub status: EvidenceLedgerEventStatus,
    pub summary: String,
    pub error_kind: Option<String>,
    pub partial_output: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub checkpoint: Option<EvidenceLedgerCheckpoint>,
}

#[derive(Debug, Clone, Default, PartialEq, Eq, Serialize, Deserialize)]
pub struct EvidenceLedgerSummary {
    pub touched_files: Vec<String>,
    pub latest_failed_commands: Vec<EvidenceLedgerSummaryItem>,
    pub latest_verification_commands: Vec<EvidenceLedgerSummaryItem>,
    pub partial_subagent_results: Vec<EvidenceLedgerSummaryItem>,
    pub latest_checkpoints: Vec<EvidenceLedgerSummaryItem>,
}

#[derive(Debug, Default)]
pub struct SessionEvidenceLedger {
    events_by_session: Arc<DashMap<String, Vec<EvidenceLedgerEvent>>>,
}

impl EvidenceLedgerEvent {
    pub fn new(
        session_id: impl Into<String>,
        turn_id: impl Into<String>,
        tool_name: impl Into<String>,
        target_kind: EvidenceLedgerTargetKind,
        target: impl Into<String>,
        status: EvidenceLedgerEventStatus,
        summary: impl Into<String>,
    ) -> Self {
        Self {
            event_id: uuid::Uuid::new_v4().to_string(),
            session_id: session_id.into(),
            turn_id: turn_id.into(),
            tool_name: tool_name.into(),
            target_kind,
            target: target.into(),
            status,
            exit_code_or_error_kind: None,
            touched_files: Vec::new(),
            artifact_path: None,
            summary: summary.into(),
            partial_output: None,
            checkpoint: None,
            created_at_ms: current_time_millis(),
        }
    }

    pub fn checkpoint_created(
        session_id: impl Into<String>,
        turn_id: impl Into<String>,
        tool_name: impl Into<String>,
        target: impl Into<String>,
        checkpoint: EvidenceLedgerCheckpoint,
    ) -> Self {
        let target = target.into();
        Self::new(
            session_id,
            turn_id,
            tool_name,
            EvidenceLedgerTargetKind::Checkpoint,
            target.clone(),
            EvidenceLedgerEventStatus::Created,
            format!("Checkpoint created before modifying {}.", target),
        )
        .with_touched_files(checkpoint.touched_files.clone())
        .with_checkpoint(checkpoint)
    }

    pub fn with_error_kind(mut self, error_kind: impl Into<String>) -> Self {
        self.exit_code_or_error_kind = Some(error_kind.into());
        self
    }

    pub fn with_partial_output(mut self, partial_output: impl Into<String>) -> Self {
        let partial_output = partial_output.into();
        self.partial_output = Some(truncate_string_at_char_boundary(
            &partial_output,
            MAX_PARTIAL_OUTPUT_BYTES,
        ));
        self
    }

    pub fn with_touched_files(mut self, touched_files: Vec<String>) -> Self {
        self.touched_files = touched_files;
        self
    }

    pub fn with_artifact_path(mut self, artifact_path: impl Into<String>) -> Self {
        self.artifact_path = Some(artifact_path.into());
        self
    }

    pub fn with_checkpoint(mut self, checkpoint: EvidenceLedgerCheckpoint) -> Self {
        self.checkpoint = Some(checkpoint);
        self
    }
}

impl From<LightCheckpoint> for EvidenceLedgerCheckpoint {
    fn from(value: LightCheckpoint) -> Self {
        Self {
            current_branch: value.current_branch,
            dirty_state_summary: value.dirty_state_summary,
            touched_files: value.touched_files,
            diff_hash: value.diff_hash,
        }
    }
}

impl PersistedEvidenceLedgerFile {
    pub fn new(session_id: impl Into<String>) -> Self {
        Self {
            schema_version: EVIDENCE_LEDGER_SCHEMA_VERSION,
            session_id: session_id.into(),
            events: Vec::new(),
        }
    }

    pub fn append(
        &mut self,
        event: EvidenceLedgerEvent,
    ) -> Result<bool, EvidenceLedgerPersistenceError> {
        self.validate_header(&event.session_id)?;
        self.validate_events()?;
        validate_event(&event, &self.session_id)?;

        if let Some(existing) = self
            .events
            .iter()
            .find(|existing| existing.event_id == event.event_id)
        {
            if existing == &event {
                return Ok(false);
            }
            return Err(EvidenceLedgerPersistenceError::ConflictingEvent {
                event_id: event.event_id,
            });
        }

        self.events.push(event);
        Ok(true)
    }

    /// Keep only events whose turn is still part of the session history.
    pub fn retain_turn_ids(
        &mut self,
        expected_session_id: &str,
        surviving_turn_ids: &HashSet<String>,
    ) -> Result<Vec<EvidenceLedgerEvent>, EvidenceLedgerPersistenceError> {
        self.validate_header(expected_session_id)?;
        let retained = self
            .validate_events()?
            .into_iter()
            .filter(|event| surviving_turn_ids.contains(&event.turn_id))
            .collect::<Vec<_>>();
        self.events = retained.clone();
        Ok(retained)
    }

    pub fn validated_events(
        self,
        expected_session_id: &str,
    ) -> Result<Vec<EvidenceLedgerEvent>, EvidenceLedgerPersistenceError> {
        self.validate_header(expected_session_id)?;
        self.validate_events()
    }

    fn validate_events(&self) -> Result<Vec<EvidenceLedgerEvent>, EvidenceLedgerPersistenceError> {
        let mut unique_events = Vec::with_capacity(self.events.len());
        let mut event_indices = HashMap::<String, usize>::new();

        for event in &self.events {
            validate_event(event, &self.session_id)?;
            if let Some(index) = event_indices.get(&event.event_id).copied() {
                if unique_events[index] != *event {
                    return Err(EvidenceLedgerPersistenceError::ConflictingEvent {
                        event_id: event.event_id.clone(),
                    });
                }
                continue;
            }
            event_indices.insert(event.event_id.clone(), unique_events.len());
            unique_events.push(event.clone());
        }

        Ok(unique_events)
    }

    fn validate_header(
        &self,
        expected_session_id: &str,
    ) -> Result<(), EvidenceLedgerPersistenceError> {
        if self.schema_version > EVIDENCE_LEDGER_SCHEMA_VERSION {
            return Err(EvidenceLedgerPersistenceError::UnsupportedSchema {
                actual: self.schema_version,
                supported: EVIDENCE_LEDGER_SCHEMA_VERSION,
            });
        }
        if self.session_id != expected_session_id {
            return Err(EvidenceLedgerPersistenceError::SessionMismatch {
                expected: expected_session_id.to_string(),
                actual: self.session_id.clone(),
            });
        }
        Ok(())
    }
}

fn default_evidence_ledger_schema_version() -> u32 {
    EVIDENCE_LEDGER_SCHEMA_VERSION
}

fn validate_event(
    event: &EvidenceLedgerEvent,
    expected_session_id: &str,
) -> Result<(), EvidenceLedgerPersistenceError> {
    if event.event_id.is_empty() {
        return Err(EvidenceLedgerPersistenceError::EmptyEventId);
    }
    if event.session_id != expected_session_id {
        return Err(EvidenceLedgerPersistenceError::EventSessionMismatch {
            event_id: event.event_id.clone(),
            expected: expected_session_id.to_string(),
            actual: event.session_id.clone(),
        });
    }
    Ok(())
}

impl SessionEvidenceLedger {
    pub fn new() -> Self {
        Self::default()
    }

    pub fn delete_session(&self, session_id: &str) -> bool {
        self.events_by_session.remove(session_id).is_some()
    }

    pub fn append(&self, event: EvidenceLedgerEvent) -> EvidenceLedgerEvent {
        let mut events = self
            .events_by_session
            .entry(event.session_id.clone())
            .or_default();
        if let Some(existing) = events
            .iter()
            .find(|existing| existing.event_id == event.event_id)
        {
            return existing.clone();
        }
        events.push(event.clone());
        event
    }

    pub fn retain_turn_ids(
        &self,
        session_id: &str,
        surviving_turn_ids: &HashSet<String>,
    ) -> Vec<EvidenceLedgerEvent> {
        let retained = self
            .events_for_session(session_id)
            .into_iter()
            .filter(|event| surviving_turn_ids.contains(&event.turn_id))
            .collect::<Vec<_>>();
        if retained.is_empty() {
            self.events_by_session.remove(session_id);
        } else {
            self.events_by_session
                .insert(session_id.to_string(), retained.clone());
        }
        retained
    }

    pub fn replace_session(
        &self,
        session_id: &str,
        events: Vec<EvidenceLedgerEvent>,
    ) -> Result<(), EvidenceLedgerPersistenceError> {
        let events = PersistedEvidenceLedgerFile {
            schema_version: EVIDENCE_LEDGER_SCHEMA_VERSION,
            session_id: session_id.to_string(),
            events,
        }
        .validated_events(session_id)?;

        if events.is_empty() {
            self.events_by_session.remove(session_id);
        } else {
            self.events_by_session
                .insert(session_id.to_string(), events);
        }
        Ok(())
    }

    pub fn events_for_session(&self, session_id: &str) -> Vec<EvidenceLedgerEvent> {
        self.events_by_session
            .get(session_id)
            .map(|events| events.clone())
            .unwrap_or_default()
    }

    pub fn events_for_turn(&self, session_id: &str, turn_id: &str) -> Vec<EvidenceLedgerEvent> {
        self.events_by_session
            .get(session_id)
            .map(|events| {
                events
                    .iter()
                    .filter(|event| event.turn_id == turn_id)
                    .cloned()
                    .collect()
            })
            .unwrap_or_default()
    }

    pub fn summary_for_session(&self, session_id: &str, limit: usize) -> EvidenceLedgerSummary {
        let Some(events) = self.events_by_session.get(session_id) else {
            return EvidenceLedgerSummary::default();
        };

        let mut touched_files = Vec::new();
        let mut latest_failed_commands = Vec::new();
        let mut latest_verification_commands = Vec::new();
        let mut partial_subagent_results = Vec::new();
        let mut latest_checkpoints = Vec::new();

        for event in events.iter().rev() {
            for file in &event.touched_files {
                if !touched_files.contains(file) {
                    touched_files.push(file.clone());
                }
            }

            if event.target_kind == EvidenceLedgerTargetKind::Command
                && event.status == EvidenceLedgerEventStatus::Failed
                && latest_failed_commands.len() < limit
            {
                latest_failed_commands.push(event.into());
            }

            if event.target_kind == EvidenceLedgerTargetKind::Command
                && is_verification_command(&event.target)
                && latest_verification_commands.len() < limit
            {
                latest_verification_commands.push(event.into());
            }

            if event.target_kind == EvidenceLedgerTargetKind::Subagent
                && event.status == EvidenceLedgerEventStatus::PartialTimeout
                && partial_subagent_results.len() < limit
            {
                partial_subagent_results.push(event.into());
            }

            if event.target_kind == EvidenceLedgerTargetKind::Checkpoint
                && event.status == EvidenceLedgerEventStatus::Created
                && latest_checkpoints.len() < limit
            {
                latest_checkpoints.push(event.into());
            }
        }

        touched_files.truncate(limit);

        EvidenceLedgerSummary {
            touched_files,
            latest_failed_commands,
            latest_verification_commands,
            partial_subagent_results,
            latest_checkpoints,
        }
    }
}

impl From<&EvidenceLedgerEvent> for EvidenceLedgerSummaryItem {
    fn from(event: &EvidenceLedgerEvent) -> Self {
        Self {
            event_id: event.event_id.clone(),
            turn_id: event.turn_id.clone(),
            tool_name: event.tool_name.clone(),
            target_kind: event.target_kind.clone(),
            target: event.target.clone(),
            status: event.status.clone(),
            summary: event.summary.clone(),
            error_kind: event.exit_code_or_error_kind.clone(),
            partial_output: event.partial_output.clone(),
            checkpoint: event.checkpoint.clone(),
        }
    }
}

impl From<EvidenceLedgerSummary> for CompressionContract {
    fn from(summary: EvidenceLedgerSummary) -> Self {
        Self {
            touched_files: summary.touched_files,
            verification_commands: summary
                .latest_verification_commands
                .into_iter()
                .map(compression_contract_item_from_summary_item)
                .collect(),
            blocking_failures: summary
                .latest_failed_commands
                .into_iter()
                .map(compression_contract_item_from_summary_item)
                .collect(),
            subagent_statuses: summary
                .partial_subagent_results
                .into_iter()
                .map(compression_contract_item_from_summary_item)
                .collect(),
        }
    }
}

fn compression_contract_item_from_summary_item(
    item: EvidenceLedgerSummaryItem,
) -> CompressionContractItem {
    CompressionContractItem {
        target: item.target,
        status: event_status_label(&item.status).to_string(),
        summary: item.summary,
        error_kind: item.error_kind,
    }
}

fn event_status_label(status: &EvidenceLedgerEventStatus) -> &'static str {
    match status {
        EvidenceLedgerEventStatus::Created => "created",
        EvidenceLedgerEventStatus::Succeeded => "succeeded",
        EvidenceLedgerEventStatus::Failed => "failed",
        EvidenceLedgerEventStatus::PartialTimeout => "partial_timeout",
        EvidenceLedgerEventStatus::Cancelled => "cancelled",
        EvidenceLedgerEventStatus::Unknown => "unknown",
    }
}

fn current_time_millis() -> u64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|duration| duration.as_millis().min(u128::from(u64::MAX)) as u64)
        .unwrap_or(0)
}

fn is_verification_command(command: &str) -> bool {
    let command = command.to_ascii_lowercase();
    command.contains(" test")
        || command.starts_with("test")
        || command.contains("cargo test")
        || command.contains("pnpm")
        || command.contains("npm test")
        || command.contains("yarn test")
        || command.contains("vitest")
        || command.contains("type-check")
        || command.contains("lint")
}

fn truncate_string_at_char_boundary(value: &str, max_bytes: usize) -> String {
    if value.len() <= max_bytes {
        return value.to_string();
    }

    let mut end = max_bytes.min(value.len());
    while !value.is_char_boundary(end) {
        end -= 1;
    }
    value[..end].to_string()
}

#[cfg(test)]
mod tests {
    use super::{
        CompressionContract, EvidenceLedgerCheckpoint, EvidenceLedgerEvent,
        EvidenceLedgerEventStatus, EvidenceLedgerPersistenceError, EvidenceLedgerTargetKind,
        PersistedEvidenceLedgerFile, SessionEvidenceLedger, EVIDENCE_LEDGER_SCHEMA_VERSION,
    };
    use crate::checkpoint::LightCheckpoint;
    use std::collections::HashSet;

    #[test]
    fn ledger_reads_events_scoped_by_session_and_turn() {
        let ledger = SessionEvidenceLedger::new();
        let event = EvidenceLedgerEvent::new(
            "session-a",
            "turn-a",
            "Task",
            EvidenceLedgerTargetKind::Subagent,
            "ReviewSecurity",
            EvidenceLedgerEventStatus::PartialTimeout,
            "Security reviewer timed out after partial output.",
        )
        .with_error_kind("timeout")
        .with_partial_output("Found token logging before timeout.");

        let appended = ledger.append(event);

        assert!(!appended.event_id.is_empty());
        assert_eq!(
            ledger.events_for_turn("session-a", "turn-a"),
            vec![appended.clone()]
        );
        assert!(ledger.events_for_turn("session-a", "other-turn").is_empty());
        assert!(ledger.events_for_turn("other-session", "turn-a").is_empty());
    }

    #[test]
    fn persisted_ledger_append_is_idempotent_and_rejects_conflicting_replays() {
        let event = EvidenceLedgerEvent::new(
            "session-a",
            "turn-a",
            "ExecCommand",
            EvidenceLedgerTargetKind::Command,
            "cargo test",
            EvidenceLedgerEventStatus::Succeeded,
            "Tests passed.",
        );
        let mut file = PersistedEvidenceLedgerFile::new("session-a");

        assert!(file.append(event.clone()).expect("first append"));
        assert!(!file.append(event.clone()).expect("idempotent replay"));

        let mut conflicting = event.clone();
        conflicting.summary = "Different payload.".to_string();
        assert!(matches!(
            file.append(conflicting),
            Err(EvidenceLedgerPersistenceError::ConflictingEvent { .. })
        ));
        assert_eq!(file.events, vec![event]);
    }

    #[test]
    fn persisted_ledger_retain_turn_ids_keeps_only_surviving_turn_evidence() {
        let mut file = PersistedEvidenceLedgerFile::new("session-a");
        let turn_a = EvidenceLedgerEvent::new(
            "session-a",
            "turn-a",
            "ExecCommand",
            EvidenceLedgerTargetKind::Command,
            "cargo test",
            EvidenceLedgerEventStatus::Succeeded,
            "Tests passed.",
        );
        let turn_b = EvidenceLedgerEvent::new(
            "session-a",
            "turn-b",
            "ExecCommand",
            EvidenceLedgerTargetKind::Command,
            "cargo check",
            EvidenceLedgerEventStatus::Failed,
            "Check failed.",
        );
        file.append(turn_a.clone()).expect("turn-a append");
        file.append(turn_b.clone()).expect("turn-b append");

        let retained = file
            .retain_turn_ids("session-a", &HashSet::from(["turn-a".to_string()]))
            .expect("retain should succeed");
        assert_eq!(retained, vec![turn_a.clone()]);
        assert_eq!(file.events, vec![turn_a.clone()]);

        let retained = file
            .retain_turn_ids("session-a", &HashSet::new())
            .expect("retain should clear");
        assert!(retained.is_empty());
        assert!(file.events.is_empty());
    }

    #[test]
    fn in_memory_ledger_retain_turn_ids_removes_empty_sessions() {
        let ledger = SessionEvidenceLedger::new();
        ledger.append(EvidenceLedgerEvent::new(
            "session-a",
            "turn-a",
            "Task",
            EvidenceLedgerTargetKind::Subagent,
            "Review",
            EvidenceLedgerEventStatus::Created,
            "Started",
        ));
        ledger.append(EvidenceLedgerEvent::new(
            "session-a",
            "turn-b",
            "Task",
            EvidenceLedgerTargetKind::Subagent,
            "Edit",
            EvidenceLedgerEventStatus::Created,
            "Started",
        ));

        let retained = ledger.retain_turn_ids("session-a", &HashSet::from(["turn-a".to_string()]));
        assert_eq!(retained.len(), 1);
        assert_eq!(retained[0].turn_id, "turn-a");

        let retained = ledger.retain_turn_ids("session-a", &HashSet::new());
        assert!(retained.is_empty());
        assert!(ledger.events_for_session("session-a").is_empty());
    }

    #[test]
    fn persisted_ledger_rejects_newer_schema_and_cross_session_events() {
        let newer = PersistedEvidenceLedgerFile {
            schema_version: EVIDENCE_LEDGER_SCHEMA_VERSION + 1,
            session_id: "session-a".to_string(),
            events: Vec::new(),
        };
        assert!(matches!(
            newer.validated_events("session-a"),
            Err(EvidenceLedgerPersistenceError::UnsupportedSchema { .. })
        ));

        let mut mismatched = PersistedEvidenceLedgerFile::new("session-a");
        mismatched.events.push(EvidenceLedgerEvent::new(
            "session-b",
            "turn-a",
            "ExecCommand",
            EvidenceLedgerTargetKind::Command,
            "cargo test",
            EvidenceLedgerEventStatus::Succeeded,
            "Tests passed.",
        ));
        assert!(matches!(
            mismatched.validated_events("session-a"),
            Err(EvidenceLedgerPersistenceError::EventSessionMismatch { .. })
        ));
    }

    #[test]
    fn legacy_evidence_event_payload_loads_with_additive_defaults() {
        let file: PersistedEvidenceLedgerFile = serde_json::from_value(serde_json::json!({
            "session_id": "session-a",
            "events": [{
                "event_id": "event-a",
                "session_id": "session-a",
                "turn_id": "turn-a",
                "tool_name": "ExecCommand",
                "target_kind": "command",
                "target": "cargo test",
                "status": "succeeded",
                "summary": "Tests passed."
            }]
        }))
        .expect("legacy payload should deserialize");

        assert_eq!(file.schema_version, EVIDENCE_LEDGER_SCHEMA_VERSION);
        let events = file
            .validated_events("session-a")
            .expect("legacy payload should validate");
        assert_eq!(events.len(), 1);
        assert_eq!(events[0].created_at_ms, 0);
        assert!(events[0].touched_files.is_empty());
        assert!(events[0].partial_output.is_none());

        let round_trip: PersistedEvidenceLedgerFile = serde_json::from_value(
            serde_json::to_value(PersistedEvidenceLedgerFile {
                schema_version: EVIDENCE_LEDGER_SCHEMA_VERSION,
                session_id: "session-a".to_string(),
                events,
            })
            .expect("upgraded payload should serialize"),
        )
        .expect("upgraded payload should deserialize");
        assert_eq!(
            round_trip
                .validated_events("session-a")
                .expect("round trip should validate")[0]
                .event_id,
            "event-a"
        );
    }

    #[test]
    fn deleting_a_session_releases_its_evidence_events() {
        let ledger = SessionEvidenceLedger::new();
        ledger.append(EvidenceLedgerEvent::new(
            "session-a",
            "turn-a",
            "Task",
            EvidenceLedgerTargetKind::Subagent,
            "Review",
            EvidenceLedgerEventStatus::Created,
            "Started",
        ));

        assert!(ledger.delete_session("session-a"));
        assert!(ledger.events_for_turn("session-a", "turn-a").is_empty());
        assert!(!ledger.delete_session("session-a"));
    }

    #[test]
    fn checkpoint_created_event_preserves_recovery_boundary_metadata() {
        let checkpoint = EvidenceLedgerCheckpoint {
            current_branch: Some("feature/context".to_string()),
            dirty_state_summary: "staged=1, unstaged=2, untracked=3".to_string(),
            touched_files: vec!["src/lib.rs".to_string()],
            diff_hash: Some("abc123".to_string()),
        };

        let event = EvidenceLedgerEvent::checkpoint_created(
            "session-a",
            "turn-a",
            "Edit",
            "src/lib.rs",
            checkpoint.clone(),
        );

        assert_eq!(event.target_kind, EvidenceLedgerTargetKind::Checkpoint);
        assert_eq!(event.status, EvidenceLedgerEventStatus::Created);
        assert_eq!(event.touched_files, vec!["src/lib.rs"]);
        assert_eq!(event.checkpoint.as_ref(), Some(&checkpoint));
    }

    #[test]
    fn checkpoint_from_light_checkpoint_preserves_recovery_boundary_metadata() {
        let checkpoint: EvidenceLedgerCheckpoint = LightCheckpoint {
            current_branch: Some("feature/context".to_string()),
            dirty_state_summary: "staged=1, unstaged=2, untracked=3".to_string(),
            touched_files: vec!["src/lib.rs".to_string()],
            diff_hash: Some("abc123".to_string()),
        }
        .into();

        assert_eq!(
            checkpoint.current_branch.as_deref(),
            Some("feature/context")
        );
        assert_eq!(
            checkpoint.dirty_state_summary,
            "staged=1, unstaged=2, untracked=3"
        );
        assert_eq!(checkpoint.touched_files, vec!["src/lib.rs"]);
        assert_eq!(checkpoint.diff_hash.as_deref(), Some("abc123"));
    }

    #[test]
    fn summary_projects_latest_checkpoints() {
        let ledger = SessionEvidenceLedger::new();
        ledger.append(EvidenceLedgerEvent::checkpoint_created(
            "session-a",
            "turn-a",
            "Delete",
            "src/old.rs",
            EvidenceLedgerCheckpoint {
                current_branch: Some("feature/context".to_string()),
                dirty_state_summary: "staged=0, unstaged=1, untracked=0".to_string(),
                touched_files: vec!["src/old.rs".to_string()],
                diff_hash: Some("def456".to_string()),
            },
        ));

        let summary = ledger.summary_for_session("session-a", 10);

        assert_eq!(summary.latest_checkpoints.len(), 1);
        assert_eq!(summary.latest_checkpoints[0].target, "src/old.rs");
        assert_eq!(
            summary.latest_checkpoints[0]
                .checkpoint
                .as_ref()
                .and_then(|checkpoint| checkpoint.current_branch.as_deref()),
            Some("feature/context")
        );
    }

    #[test]
    fn summary_projects_partial_subagent_results() {
        let ledger = SessionEvidenceLedger::new();
        ledger.append(
            EvidenceLedgerEvent::new(
                "session-a",
                "turn-a",
                "Task",
                EvidenceLedgerTargetKind::Subagent,
                "ReviewSecurity",
                EvidenceLedgerEventStatus::PartialTimeout,
                "Security reviewer timed out after partial output.",
            )
            .with_error_kind("timeout")
            .with_partial_output("Found token logging before timeout."),
        );

        let summary = ledger.summary_for_session("session-a", 10);

        assert_eq!(summary.partial_subagent_results.len(), 1);
        assert_eq!(summary.partial_subagent_results[0].target, "ReviewSecurity");
        assert_eq!(
            summary.partial_subagent_results[0]
                .partial_output
                .as_deref(),
            Some("Found token logging before timeout.")
        );
    }

    #[test]
    fn partial_output_is_truncated_on_utf8_boundary() {
        let ledger = SessionEvidenceLedger::new();
        let output = format!("{}{}", "a".repeat(7_999), "测");
        ledger.append(
            EvidenceLedgerEvent::new(
                "session-a",
                "turn-a",
                "Task",
                EvidenceLedgerTargetKind::Subagent,
                "ReviewSecurity",
                EvidenceLedgerEventStatus::PartialTimeout,
                "Security reviewer timed out after partial output.",
            )
            .with_partial_output(output),
        );

        let summary = ledger.summary_for_session("session-a", 10);
        let partial_output = summary.partial_subagent_results[0]
            .partial_output
            .as_deref()
            .expect("partial output");

        assert_eq!(partial_output.len(), 7_999);
        assert!(partial_output.is_char_boundary(partial_output.len()));
    }

    #[test]
    fn compression_contract_keeps_bounded_recent_evidence_without_pruning_the_ledger() {
        let ledger = SessionEvidenceLedger::new();
        for index in 0..12 {
            ledger.append(
                EvidenceLedgerEvent::new(
                    "session-a",
                    "turn-a",
                    "ExecCommand",
                    EvidenceLedgerTargetKind::Command,
                    format!("cargo test test_{index}"),
                    EvidenceLedgerEventStatus::Failed,
                    format!("Test {index} failed"),
                )
                .with_touched_files(vec![format!("src/file_{index}.rs")]),
            );
        }
        let contract: CompressionContract = ledger
            .summary_for_session("session-a", super::DEFAULT_COMPRESSION_CONTRACT_LIMIT)
            .into();
        assert_eq!(contract.touched_files.len(), 8);
        assert_eq!(contract.blocking_failures.len(), 8);
        assert_eq!(contract.verification_commands.len(), 8);
        assert_eq!(contract.touched_files.first().unwrap(), "src/file_11.rs");
        assert_eq!(contract.touched_files.last().unwrap(), "src/file_4.rs");
        assert_eq!(ledger.events_for_session("session-a").len(), 12);
    }

    #[test]
    fn summary_projects_into_compression_contract() {
        let ledger = SessionEvidenceLedger::new();
        ledger.append(
            EvidenceLedgerEvent::new(
                "session-a",
                "turn-a",
                "Edit",
                EvidenceLedgerTargetKind::File,
                "src/main.rs",
                EvidenceLedgerEventStatus::Succeeded,
                "Edited main file.",
            )
            .with_touched_files(vec!["src/main.rs".to_string()]),
        );
        ledger.append(
            EvidenceLedgerEvent::new(
                "session-a",
                "turn-a",
                "ExecCommand",
                EvidenceLedgerTargetKind::Command,
                "cargo test",
                EvidenceLedgerEventStatus::Failed,
                "Tests failed before compression.",
            )
            .with_error_kind("exit_code:1"),
        );
        ledger.append(EvidenceLedgerEvent::new(
            "session-a",
            "turn-a",
            "Task",
            EvidenceLedgerTargetKind::Subagent,
            "ReviewSecurity",
            EvidenceLedgerEventStatus::PartialTimeout,
            "Security reviewer timed out after partial output.",
        ));

        let contract: CompressionContract = ledger.summary_for_session("session-a", 10).into();

        assert_eq!(contract.touched_files, vec!["src/main.rs"]);
        assert_eq!(contract.verification_commands[0].target, "cargo test");
        assert_eq!(
            contract.blocking_failures[0].error_kind.as_deref(),
            Some("exit_code:1")
        );
        assert_eq!(contract.subagent_statuses[0].target, "ReviewSecurity");
        assert_eq!(contract.subagent_statuses[0].status, "partial_timeout");
    }
}
