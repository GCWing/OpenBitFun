//! Durable Router continuity follows the host's visible Session turn lineage.
//!
//! Each lineage has its own checkpoint. Revert leaves the abandoned branch intact;
//! a new turn may inherit only its exact immediate predecessor. A generation lease
//! prevents an older asynchronous writer from publishing after same-turn recovery.

use crate::util::errors::{OpenBitFunError, OpenBitFunResult};
use log::warn;
use openbitfun_agent_runtime::router_context::RouterContextState;
use openbitfun_services_core::json_store::JsonFileStore;
use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};
use std::collections::{HashMap, HashSet};
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, Mutex, OnceLock, Weak};
use uuid::Uuid;

#[derive(Clone)]
pub(super) struct SessionRouterCheckpoint {
    path: PathBuf,
    session_id: String,
    visible_turn_ids: Vec<String>,
    generation: String,
    staged: Arc<StagedCheckpoint>,
}

/// Finalization may return while a coalescing writer is still draining. Retain
/// the latest queued state only as long as that writer/context owns its handle.
/// The registry itself holds no context payloads alive.
struct StagedCheckpoint {
    generation: String,
    state: Mutex<Option<RouterContextState>>,
}

static STAGED_CHECKPOINTS: OnceLock<Mutex<HashMap<PathBuf, Weak<StagedCheckpoint>>>> =
    OnceLock::new();

#[derive(Serialize, Deserialize)]
struct CheckpointRecord {
    version: u32,
    session_id: String,
    visible_turn_ids: Vec<String>,
    generation: String,
    #[serde(default)]
    state: Option<RouterContextState>,
}

struct OpenGuard(Arc<AtomicBool>);

impl Drop for OpenGuard {
    fn drop(&mut self) {
        self.0.store(false, Ordering::Release);
    }
}

impl SessionRouterCheckpoint {
    /// Claim this execution generation while retaining any compatible durable state.
    /// Legacy per-turn files have no lineage proof and are intentionally left alone.
    pub(super) async fn open(
        snapshot_dir: &Path,
        session_id: &str,
        dialog_turn_id: &str,
        task: &str,
        visible_turn_ids: &[String],
        retained_message_ids: Option<&HashSet<String>>,
    ) -> OpenBitFunResult<(Self, Option<RouterContextState>)> {
        let active = Arc::new(AtomicBool::new(true));
        let _guard = OpenGuard(active.clone());
        let snapshot_dir = snapshot_dir.to_path_buf();
        let session_id = session_id.to_string();
        let dialog_turn_id = dialog_turn_id.to_string();
        let task = task.to_string();
        let visible_turn_ids = visible_turn_ids.to_vec();
        let retained_message_ids = retained_message_ids.cloned();
        // Atomic filesystem replacement itself is not cancellation-safe. Detaching
        // this owned transaction lets it retain the advisory lock until IO settles.
        // If the caller times out before publication starts, the guard prevents a
        // delayed lease claim from superseding a newer recovery generation.
        tokio::spawn(async move {
            Self::open_transaction(
                &snapshot_dir,
                &session_id,
                &dialog_turn_id,
                &task,
                &visible_turn_ids,
                retained_message_ids.as_ref(),
                &active,
            )
            .await
        })
        .await
        .map_err(|error| incompatible(&format!("Router checkpoint open task failed: {error}")))?
    }

    async fn open_transaction(
        snapshot_dir: &Path,
        session_id: &str,
        dialog_turn_id: &str,
        task: &str,
        visible_turn_ids: &[String],
        retained_message_ids: Option<&HashSet<String>>,
        active: &AtomicBool,
    ) -> OpenBitFunResult<(Self, Option<RouterContextState>)> {
        if session_id.is_empty()
            || dialog_turn_id.is_empty()
            || visible_turn_ids.last().map(String::as_str) != Some(dialog_turn_id)
            || visible_turn_ids.iter().any(String::is_empty)
            || visible_turn_ids.iter().collect::<HashSet<_>>().len() != visible_turn_ids.len()
        {
            return Err(incompatible(
                "Router checkpoint requires the complete visible turn lineage",
            ));
        }
        let path = checkpoint_path(snapshot_dir, session_id, visible_turn_ids);
        let _lock = JsonFileStore
            .acquire_cross_process_lock(&path)
            .await
            .map_err(|error| incompatible(&error.to_string()))?;
        if !active.load(Ordering::Acquire) {
            return Err(incompatible("Router checkpoint open was cancelled"));
        }
        let record = JsonFileStore
            .read_optional::<CheckpointRecord>(&path)
            .await
            .map_err(|error| incompatible(&error.to_string()))?;
        let mut state = if let Some(record) = record {
            validate_record(&record, session_id, visible_turn_ids)?;
            latest_staged_state(&path, record)
        } else if visible_turn_ids.len() > 1 {
            // Missing intermediate Router state (for example a manual turn) breaks
            // continuity: its evidence might already have left the main context.
            let predecessor = &visible_turn_ids[..visible_turn_ids.len() - 1];
            let parent_path = checkpoint_path(snapshot_dir, session_id, predecessor);
            match JsonFileStore
                .read_optional::<CheckpointRecord>(&parent_path)
                .await
            {
                Ok(Some(record)) => match validate_record(&record, session_id, predecessor) {
                    Ok(()) => latest_staged_state(&parent_path, record),
                    Err(error) => {
                        warn!("Router predecessor checkpoint is incompatible; preserving it and starting independent context: path={}, error={}", parent_path.display(), error);
                        None
                    }
                },
                Ok(None) => None,
                Err(error) => {
                    warn!("Router predecessor checkpoint is unreadable; preserving it and starting independent context: path={}, error={}", parent_path.display(), error);
                    None
                }
            }
        } else {
            None
        };
        if let Some(state) = state.as_mut() {
            if state.dialog_turn_id != dialog_turn_id {
                // Prior steering remains historical evidence, not the current task's
                // priority corrections. Source IDs remain claimed across turns.
                state.latest_user_updates.clear();
                // Cross-turn observation sees only the retained main-history prefix
                // and new generation messages. IDs no longer present there cannot
                // replay, so do not accumulate them for the session's lifetime.
                // Same-turn recovery keeps all claims until its generation settles.
                if let Some(retained) = retained_message_ids {
                    state.seen_message_ids.retain(|id| retained.contains(id));
                }
            }
            state.dialog_turn_id = dialog_turn_id.to_string();
            state.task = task.to_string();
        }
        let generation = Uuid::new_v4().to_string();
        let checkpoint = Self {
            path,
            session_id: session_id.to_string(),
            visible_turn_ids: visible_turn_ids.to_vec(),
            staged: Arc::new(StagedCheckpoint {
                generation: generation.clone(),
                state: Mutex::new(state.clone()),
            }),
            generation,
        };
        let record = checkpoint.record(state.clone());
        if !active.load(Ordering::Acquire) {
            return Err(incompatible("Router checkpoint open was cancelled"));
        }
        JsonFileStore
            .write_atomic_strict(&checkpoint.path, &record)
            .await
            .map_err(|error| incompatible(&error.to_string()))?;
        let mut staged = STAGED_CHECKPOINTS
            .get_or_init(|| Mutex::new(HashMap::new()))
            .lock()
            .unwrap_or_else(|error| error.into_inner());
        staged.retain(|_, checkpoint| checkpoint.strong_count() > 0);
        staged.insert(checkpoint.path.clone(), Arc::downgrade(&checkpoint.staged));
        Ok((checkpoint, state))
    }

    /// Publish the newest queued snapshot synchronously before handing it to the
    /// disk writer, so a successor turn cannot permanently miss compacted facts.
    pub(super) fn stage(&self, state: &RouterContextState) -> OpenBitFunResult<()> {
        validate_state(state, &self.session_id, &self.visible_turn_ids)?;
        let mut staged = self
            .staged
            .state
            .lock()
            .unwrap_or_else(|error| error.into_inner());
        if staged
            .as_ref()
            .is_some_and(|current| state_is_newer(current, state))
        {
            return Ok(());
        }
        *staged = Some(state.clone());
        Ok(())
    }

    /// Called by the context's coalescing writer. Replaced generations are no-ops.
    pub(super) async fn save(&self, state: &RouterContextState) -> OpenBitFunResult<()> {
        self.stage(state)?;
        let _lock = JsonFileStore
            .acquire_cross_process_lock(&self.path)
            .await
            .map_err(|error| incompatible(&error.to_string()))?;
        let current = JsonFileStore
            .read_optional::<CheckpointRecord>(&self.path)
            .await
            .map_err(|error| incompatible(&error.to_string()))?
            .ok_or_else(|| incompatible("Router checkpoint lease is missing"))?;
        validate_record(&current, &self.session_id, &self.visible_turn_ids)?;
        if current.generation != self.generation {
            return Ok(());
        }
        if current
            .state
            .as_ref()
            .is_some_and(|current| state_is_newer(current, state))
        {
            return Ok(());
        }
        JsonFileStore
            .write_atomic_strict(&self.path, &self.record(Some(state.clone())))
            .await
            .map_err(|error| incompatible(&error.to_string()))
    }

    fn record(&self, state: Option<RouterContextState>) -> CheckpointRecord {
        CheckpointRecord {
            // Legacy readers reject an outer version other than 1. They must
            // not mistake an unfinished historical prefix for complete context
            // after ignoring the newer bootstrap marker on the inner state.
            version: if state
                .as_ref()
                .is_some_and(|state| state.history_bootstrap.is_some())
            {
                2
            } else {
                1
            },
            session_id: self.session_id.clone(),
            visible_turn_ids: self.visible_turn_ids.clone(),
            generation: self.generation.clone(),
            state,
        }
    }
}

fn latest_staged_state(path: &Path, record: CheckpointRecord) -> Option<RouterContextState> {
    let staged = STAGED_CHECKPOINTS
        .get_or_init(|| Mutex::new(HashMap::new()))
        .lock()
        .unwrap_or_else(|error| error.into_inner())
        .get(path)
        .and_then(Weak::upgrade);
    let Some(staged) = staged.filter(|staged| staged.generation == record.generation) else {
        return record.state;
    };
    let state = staged
        .state
        .lock()
        .unwrap_or_else(|error| error.into_inner())
        .clone();
    match state {
        Some(state)
            if !record
                .state
                .as_ref()
                .is_some_and(|current| state_is_newer(current, &state)) =>
        {
            Some(state)
        }
        _ => record.state,
    }
}

fn state_is_newer(current: &RouterContextState, candidate: &RouterContextState) -> bool {
    current.next_sequence > candidate.next_sequence
        || current.summarized_through > candidate.summarized_through
        || (current.next_sequence == candidate.next_sequence
            && current.summarized_through == candidate.summarized_through
            && current.seen_message_ids.len() > candidate.seen_message_ids.len())
}

fn checkpoint_path(dir: &Path, session_id: &str, visible_turn_ids: &[String]) -> PathBuf {
    let mut hash = Sha256::new();
    for part in std::iter::once(session_id).chain(visible_turn_ids.iter().map(String::as_str)) {
        hash.update((part.len() as u64).to_le_bytes());
        hash.update(part.as_bytes());
    }
    dir.join(format!("router-session-context-{:x}.json", hash.finalize()))
}

fn validate_record(
    record: &CheckpointRecord,
    session_id: &str,
    visible_turn_ids: &[String],
) -> OpenBitFunResult<()> {
    if !matches!(record.version, 1 | 2)
        || record.session_id != session_id
        || record.visible_turn_ids != visible_turn_ids
        || record.generation.is_empty()
    {
        return Err(incompatible(
            "Incompatible Router session checkpoint; preserving the file",
        ));
    }
    if let Some(state) = &record.state {
        validate_state(state, session_id, visible_turn_ids)?;
    }
    Ok(())
}

fn validate_state(
    state: &RouterContextState,
    session_id: &str,
    visible_turn_ids: &[String],
) -> OpenBitFunResult<()> {
    if state.version != 1
        || state.session_id != session_id
        || visible_turn_ids.last().map(String::as_str) != Some(state.dialog_turn_id.as_str())
        || state.next_sequence <= state.summarized_through
    {
        return Err(incompatible(
            "Router state does not match the visible session history",
        ));
    }
    Ok(())
}

fn incompatible(message: &str) -> OpenBitFunError {
    OpenBitFunError::Session(message.to_string())
}

#[cfg(test)]
mod tests {
    use super::*;

    fn lineage(ids: &[&str]) -> Vec<String> {
        ids.iter().map(|id| id.to_string()).collect()
    }

    fn summary(session: &str, turn: &str, text: &str) -> RouterContextState {
        RouterContextState {
            session_id: session.into(),
            dialog_turn_id: turn.into(),
            task: "previous task".into(),
            summary: text.into(),
            next_sequence: 3,
            summarized_through: 2,
            seen_message_ids: HashSet::from(["user-1".into(), "assistant-1".into()]),
            latest_user_updates: ["old steering".into()].into(),
            ..Default::default()
        }
    }

    async fn open(
        dir: &Path,
        session: &str,
        ids: &[&str],
    ) -> (SessionRouterCheckpoint, Option<RouterContextState>) {
        SessionRouterCheckpoint::open(
            dir,
            session,
            ids.last().unwrap(),
            "current task",
            &lineage(ids),
            None,
        )
        .await
        .unwrap()
    }

    #[tokio::test]
    async fn next_turn_inherits_summary_and_source_ids_but_refreshes_task() {
        let dir = tempfile::tempdir().unwrap();
        let (first, _) = open(dir.path(), "session", &["turn-1"]).await;
        first
            .save(&summary("session", "turn-1", "confirmed finding"))
            .await
            .unwrap();
        let (_, state) = open(dir.path(), "session", &["turn-1", "turn-2"]).await;
        let mut state = state.unwrap();
        assert_eq!(state.summary, "confirmed finding");
        assert_eq!(state.dialog_turn_id, "turn-2");
        assert_eq!(state.task, "current task");
        assert!(state.latest_user_updates.is_empty());
        assert!(!state.claim_message("assistant-1"));
    }

    #[tokio::test]
    async fn next_turn_inherits_final_staged_state_while_parent_writer_is_blocked() {
        let dir = tempfile::tempdir().unwrap();
        let (parent, _) = open(dir.path(), "session", &["turn-1"]).await;
        parent
            .save(&summary("session", "turn-1", "old checkpoint"))
            .await
            .unwrap();
        let mut final_state = summary("session", "turn-1", "final compacted finding");
        final_state.next_sequence = 4;
        final_state.summarized_through = 3;
        final_state
            .seen_message_ids
            .insert("final-observation".into());
        parent.stage(&final_state).unwrap();
        let parent_path = parent.path.clone();
        let staged = Arc::downgrade(&parent.staged);
        let lock = JsonFileStore
            .acquire_cross_process_lock(&parent_path)
            .await
            .unwrap();
        let writer = parent.clone();
        let writing = tokio::spawn(async move { writer.save(&final_state).await });
        // Model the context ending before its 500 ms best-effort flush completes.
        // The writer alone retains staged state; the registry is weak.
        drop(parent);
        let (_, inherited) = open(dir.path(), "session", &["turn-1", "turn-2"]).await;
        let inherited = inherited.unwrap();
        assert_eq!(inherited.summary, "final compacted finding");
        assert!(inherited.seen_message_ids.contains("final-observation"));
        let on_disk = JsonFileStore
            .read_optional::<CheckpointRecord>(&parent_path)
            .await
            .unwrap()
            .unwrap();
        assert_eq!(on_disk.state.unwrap().summary, "old checkpoint");
        assert!(staged.upgrade().is_some());
        drop(lock);
        writing.await.unwrap().unwrap();
        assert!(staged.upgrade().is_none());
        let on_disk = JsonFileStore
            .read_optional::<CheckpointRecord>(&parent_path)
            .await
            .unwrap()
            .unwrap();
        assert_eq!(on_disk.state.unwrap().summary, "final compacted finding");
    }

    #[tokio::test]
    async fn same_turn_recovery_inherits_staged_state_and_fences_old_generation() {
        let dir = tempfile::tempdir().unwrap();
        let (old, _) = open(dir.path(), "session", &["turn-1"]).await;
        old.save(&summary("session", "turn-1", "durable prefix"))
            .await
            .unwrap();
        let mut staged = summary("session", "turn-1", "latest queued prefix");
        staged.next_sequence = 4;
        staged.summarized_through = 3;
        old.stage(&staged).unwrap();
        let (current, inherited) = open(dir.path(), "session", &["turn-1"]).await;
        assert_eq!(inherited.unwrap().summary, "latest queued prefix");
        staged.summary = "late obsolete generation".into();
        staged.next_sequence = 100;
        old.save(&staged).await.unwrap();
        let (_, recovered) = open(dir.path(), "session", &["turn-1"]).await;
        assert_eq!(recovered.unwrap().summary, "latest queued prefix");
        drop(current);
    }

    #[tokio::test]
    async fn cross_turn_retains_only_visible_source_ids_but_recovery_keeps_all_claims() {
        let dir = tempfile::tempdir().unwrap();
        let (first, _) = open(dir.path(), "session", &["turn-1"]).await;
        let mut state = summary("session", "turn-1", "old evidence already compacted");
        state.seen_message_ids = (0..1000).map(|index| format!("message-{index}")).collect();
        first.save(&state).await.unwrap();
        let retained = HashSet::from(["message-999".to_string()]);
        let (recovered, same_turn) = SessionRouterCheckpoint::open(
            dir.path(),
            "session",
            "turn-1",
            "resumed task",
            &lineage(&["turn-1"]),
            Some(&retained),
        )
        .await
        .unwrap();
        assert_eq!(same_turn.unwrap().seen_message_ids.len(), 1000);
        drop(recovered);
        let (_, next_turn) = SessionRouterCheckpoint::open(
            dir.path(),
            "session",
            "turn-2",
            "new task",
            &lineage(&["turn-1", "turn-2"]),
            Some(&retained),
        )
        .await
        .unwrap();
        let mut next_turn = next_turn.unwrap();
        assert_eq!(next_turn.seen_message_ids, retained);
        assert!(!next_turn.claim_message("message-999"));
        assert_eq!(next_turn.summary, "old evidence already compacted");
        // Pruning happened before the new generation was installed; disk recovery
        // must not reject its smaller set as an older snapshot.
        let (_, stored) = open(dir.path(), "session", &["turn-1", "turn-2"]).await;
        assert_eq!(stored.unwrap().seen_message_ids, retained);
    }

    #[tokio::test]
    async fn reopened_generation_rejects_late_previous_writer_even_with_more_entries() {
        let dir = tempfile::tempdir().unwrap();
        let (old, _) = open(dir.path(), "session", &["turn-1"]).await;
        old.save(&summary("session", "turn-1", "settled"))
            .await
            .unwrap();
        let (current, state) = open(dir.path(), "session", &["turn-1"]).await;
        assert_eq!(state.unwrap().summary, "settled");
        let mut stale = summary("session", "turn-1", "late stale result");
        stale.next_sequence = 100;
        old.save(&stale).await.unwrap();
        let record = JsonFileStore
            .read_optional::<CheckpointRecord>(&current.path)
            .await
            .unwrap()
            .unwrap();
        assert_eq!(record.state.unwrap().summary, "settled");
        current
            .save(&summary("session", "turn-1", "new generation"))
            .await
            .unwrap();
        let (_, state) = open(dir.path(), "session", &["turn-1"]).await;
        assert_eq!(state.unwrap().summary, "new generation");
    }

    #[tokio::test]
    async fn rollback_then_new_branch_inherits_only_surviving_prefix() {
        let dir = tempfile::tempdir().unwrap();
        let (first, _) = open(dir.path(), "session", &["turn-1"]).await;
        first
            .save(&summary("session", "turn-1", "surviving fact"))
            .await
            .unwrap();
        let (abandoned, _) = open(dir.path(), "session", &["turn-1", "turn-2"]).await;
        abandoned
            .save(&summary("session", "turn-2", "removed fact"))
            .await
            .unwrap();
        let (_, state) = open(dir.path(), "session", &["turn-1", "new-turn-2"]).await;
        assert_eq!(state.unwrap().summary, "surviving fact");
        assert!(abandoned.path.exists());
        let (_, state) = open(dir.path(), "session", &["replacement-turn-1"]).await;
        assert!(state.is_none());
    }

    #[tokio::test]
    async fn fork_and_other_sessions_cannot_inherit_parent_state() {
        let dir = tempfile::tempdir().unwrap();
        let (parent, _) = open(dir.path(), "parent", &["turn-1"]).await;
        parent
            .save(&summary("parent", "turn-1", "parent-only fact"))
            .await
            .unwrap();
        let (_, state) = open(dir.path(), "fork", &["turn-1", "turn-2"]).await;
        assert!(state.is_none());
        let copied_path = checkpoint_path(dir.path(), "fork", &lineage(&["turn-1"]));
        tokio::fs::copy(&parent.path, &copied_path).await.unwrap();
        let result = SessionRouterCheckpoint::open(
            dir.path(),
            "fork",
            "turn-1",
            "task",
            &lineage(&["turn-1"]),
            None,
        )
        .await;
        assert!(result.is_err());
        assert_eq!(
            tokio::fs::read(&parent.path).await.unwrap(),
            tokio::fs::read(&copied_path).await.unwrap()
        );
    }

    #[tokio::test]
    async fn missing_intermediate_turn_does_not_reuse_older_checkpoint() {
        let dir = tempfile::tempdir().unwrap();
        let (first, _) = open(dir.path(), "session", &["turn-1"]).await;
        first
            .save(&summary("session", "turn-1", "before manual turn"))
            .await
            .unwrap();
        let (_, state) = open(dir.path(), "session", &["turn-1", "manual-turn", "turn-3"]).await;
        assert!(state.is_none());
    }

    #[tokio::test]
    async fn malformed_and_future_records_are_preserved() {
        let dir = tempfile::tempdir().unwrap();
        let path = checkpoint_path(dir.path(), "session", &lineage(&["turn-1"]));
        for bytes in [b"not-json".as_slice(), br#"{"version":3,"session_id":"session","visible_turn_ids":["turn-1"],"generation":"future"}"#] {
            tokio::fs::write(&path, bytes).await.unwrap();
            assert!(SessionRouterCheckpoint::open(dir.path(), "session", "turn-1", "task", &lineage(&["turn-1"]), None).await.is_err());
            assert_eq!(tokio::fs::read(&path).await.unwrap(), bytes);
        }
    }

    #[tokio::test]
    async fn bootstrap_record_fences_legacy_readers_and_returns_to_v1_after_host_merge() {
        use openbitfun_agent_runtime::router_context::RouterHistoryBootstrap;

        // This is the old outer envelope: its parser ignores new state fields,
        // so its existing version == 1 admission check must reject this cache.
        #[derive(Deserialize)]
        struct LegacyCheckpointRecord {
            version: u32,
            state: Option<serde_json::Value>,
        }

        let dir = tempfile::tempdir().unwrap();
        let ids = ["older", "turn-1"];
        let (checkpoint, _) = open(dir.path(), "session", &ids).await;
        let path = checkpoint.path.clone();
        let mut state = summary("session", "turn-1", "partially prepared history");
        for complete in [false, true] {
            state.history_bootstrap = Some(RouterHistoryBootstrap {
                turn_ids: vec!["older".into()],
                turn_cursor: usize::from(complete),
                entry_cursor: 0,
                complete,
            });
            checkpoint.save(&state).await.unwrap();
            let bytes = tokio::fs::read(&path).await.unwrap();
            let legacy: LegacyCheckpointRecord = serde_json::from_slice(&bytes).unwrap();
            assert_ne!(legacy.version, 1);
            assert_eq!(legacy.version, 2);
            assert_eq!(legacy.state.unwrap()["version"], 1);
            let current: CheckpointRecord = serde_json::from_slice(&bytes).unwrap();
            validate_record(&current, "session", &lineage(&ids)).unwrap();
            assert_eq!(
                current.state.unwrap().history_bootstrap.unwrap().complete,
                complete
            );
        }

        let (current, restored) = open(dir.path(), "session", &ids).await;
        let mut restored = restored.unwrap();
        assert!(restored.history_bootstrap.as_ref().unwrap().complete);
        assert_eq!(restored.summary, state.summary);
        assert_eq!(restored.version, 1);
        restored.history_bootstrap = None;
        restored.next_sequence += 1;
        current.save(&restored).await.unwrap();
        let bytes = tokio::fs::read(&path).await.unwrap();
        let legacy: LegacyCheckpointRecord = serde_json::from_slice(&bytes).unwrap();
        assert_eq!(legacy.version, 1);
        assert!(legacy.state.unwrap().get("history_bootstrap").is_none());
        let (_, ordinary) = open(dir.path(), "session", &ids).await;
        assert!(ordinary.unwrap().history_bootstrap.is_none());
    }

    #[tokio::test]
    async fn legacy_turn_state_is_readable_but_not_migrated_without_lineage_proof() {
        let dir = tempfile::tempdir().unwrap();
        let legacy: RouterContextState = serde_json::from_str(r#"{"session_id":"session","dialog_turn_id":"turn-1","summary":"legacy evidence","next_sequence":2}"#).unwrap();
        let bytes = serde_json::to_vec(&legacy).unwrap();
        let path = dir.path().join(format!(
            "router-context-{:x}.json",
            Sha256::digest(b"turn-1")
        ));
        tokio::fs::write(&path, &bytes).await.unwrap();
        let (_, state) = open(dir.path(), "session", &["turn-1"]).await;
        assert!(state.is_none());
        assert_eq!(tokio::fs::read(path).await.unwrap(), bytes);
        let roundtrip: RouterContextState = serde_json::from_slice(&bytes).unwrap();
        assert_eq!(roundtrip.summary, "legacy evidence");
    }

    #[tokio::test]
    async fn no_state_record_from_interrupted_open_can_be_reclaimed() {
        let dir = tempfile::tempdir().unwrap();
        let path = checkpoint_path(dir.path(), "session", &lineage(&["turn-1"]));
        tokio::fs::write(&path, br#"{"version":1,"session_id":"session","visible_turn_ids":["turn-1"],"generation":"interrupted"}"#).await.unwrap();
        let (checkpoint, state) = open(dir.path(), "session", &["turn-1"]).await;
        assert!(state.is_none());
        checkpoint
            .save(&summary("session", "turn-1", "recovered"))
            .await
            .unwrap();
    }

    #[tokio::test]
    async fn timed_out_open_waiting_for_lock_cannot_claim_a_later_generation() {
        let dir = tempfile::tempdir().unwrap();
        let (first, _) = open(dir.path(), "session", &["turn-1"]).await;
        first
            .save(&summary("session", "turn-1", "settled"))
            .await
            .unwrap();
        let lock = JsonFileStore
            .acquire_cross_process_lock(&first.path)
            .await
            .unwrap();
        let result = tokio::time::timeout(
            std::time::Duration::from_millis(20),
            SessionRouterCheckpoint::open(
                dir.path(),
                "session",
                "turn-1",
                "cancelled open",
                &lineage(&["turn-1"]),
                None,
            ),
        )
        .await;
        assert!(result.is_err());
        drop(lock);
        let (current, recovered) = open(dir.path(), "session", &["turn-1"]).await;
        assert_eq!(recovered.unwrap().summary, "settled");
        current
            .save(&summary("session", "turn-1", "current generation"))
            .await
            .unwrap();
        // A cancelled transaction may acquire the lock before or after this one;
        // in either order it must not touch the current lease or task identity.
        let inactive = AtomicBool::new(false);
        assert!(SessionRouterCheckpoint::open_transaction(
            dir.path(),
            "session",
            "turn-1",
            "cancelled open",
            &lineage(&["turn-1"]),
            None,
            &inactive,
        )
        .await
        .is_err());
        let record = JsonFileStore
            .read_optional::<CheckpointRecord>(&current.path)
            .await
            .unwrap()
            .unwrap();
        assert_eq!(record.generation, current.generation);
        assert_eq!(record.state.unwrap().summary, "current generation");
    }

    #[tokio::test]
    async fn refuses_duplicate_or_incomplete_lineage_and_mismatched_state() {
        let dir = tempfile::tempdir().unwrap();
        for ids in [
            lineage(&[]),
            lineage(&["turn-1", "turn-1"]),
            lineage(&["turn-2"]),
        ] {
            assert!(SessionRouterCheckpoint::open(
                dir.path(),
                "session",
                "turn-1",
                "task",
                &ids,
                None
            )
            .await
            .is_err());
        }
        let (checkpoint, _) = open(dir.path(), "session", &["turn-1"]).await;
        assert!(checkpoint
            .save(&summary("other-session", "turn-1", "wrong session"))
            .await
            .is_err());
        assert!(checkpoint
            .save(&summary("session", "turn-2", "wrong turn"))
            .await
            .is_err());
    }
}
