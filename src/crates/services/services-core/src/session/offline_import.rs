//! Offline Session bundle writer and validator.
//!
//! The standalone data migrator cannot run the live Session runtime. It still
//! writes metadata and Turn envelopes through the same storage owners so a
//! successful import is immediately readable by Desktop, CLI, and Server.

use super::{
    DialogTurnData, SessionMetadata, SessionMetadataStore, SessionMetadataStoreError,
    SessionStorageLayout, StoredDialogTurnFile, StoredSessionMetadataFile,
    SESSION_STORAGE_SCHEMA_VERSION,
};
use crate::json_store::{JsonFileStore, JsonFileStoreError};
use openbitfun_core_types::validate_session_id;
use serde::{Deserialize, Serialize};
use std::collections::BTreeSet;
use std::path::{Path, PathBuf};
use thiserror::Error;
use tokio::fs;

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct OfflineSessionBundle {
    pub metadata: SessionMetadata,
    pub turns: Vec<DialogTurnData>,
}

#[derive(Serialize, Deserialize)]
struct BundleRepair {
    schema_version: u32,
    before: OfflineSessionBundle,
    after: OfflineSessionBundle,
}

fn same_record(left: &impl Serialize, right: &impl Serialize) -> bool {
    matches!((serde_json::to_value(left), serde_json::to_value(right)), (Ok(left), Ok(right)) if left == right)
}

impl OfflineSessionBundle {
    pub fn validate(&self) -> Result<(), OfflineSessionImportError> {
        validate_bundle_shape(self)
    }
}

#[derive(Debug, Error)]
pub enum OfflineSessionImportError {
    #[error("Session import cancelled")]
    Cancelled,
    #[error(transparent)]
    Metadata(#[from] SessionMetadataStoreError),
    #[error(transparent)]
    Json(#[from] JsonFileStoreError),
    #[error("Invalid Session bundle: {0}")]
    InvalidBundle(String),
}

#[derive(Debug, Clone)]
pub struct OfflineSessionImportStore {
    layout: SessionStorageLayout,
    metadata_store: SessionMetadataStore,
    json_store: JsonFileStore,
}

impl OfflineSessionImportStore {
    pub fn new(sessions_root: impl Into<PathBuf>) -> Self {
        let sessions_root = sessions_root.into();
        Self {
            layout: SessionStorageLayout::new(sessions_root.clone()),
            metadata_store: SessionMetadataStore::new(sessions_root),
            json_store: JsonFileStore,
        }
    }

    pub async fn write_bundle(
        &self,
        bundle: &OfflineSessionBundle,
    ) -> Result<(), OfflineSessionImportError> {
        validate_bundle_shape(bundle)?;
        self.metadata_store.save_metadata(&bundle.metadata).await?;
        self.layout
            .ensure_turns_dir(&bundle.metadata.session_id)
            .await
            .map_err(|error| {
                OfflineSessionImportError::InvalidBundle(format!(
                    "failed to create Turns directory: {error}"
                ))
            })?;
        for turn in &bundle.turns {
            self.json_store
                .write_atomic_strict(
                    &self.layout.turn_path(&turn.session_id, turn.turn_index),
                    &StoredDialogTurnFile::new(turn.clone()),
                )
                .await?;
        }
        Ok(())
    }

    /// Publishes a complete bundle only after every turn file has been written.
    /// The metadata file is the visibility boundary used by session listing, so
    /// a failed import cannot leave a half-populated session in the catalog.
    pub async fn write_bundle_atomic(
        &self,
        bundle: &OfflineSessionBundle,
    ) -> Result<(), OfflineSessionImportError> {
        self.write_bundle_atomic_cancellable(bundle, || false).await
    }

    /// Cancellation is honored until publication starts. Once published, the
    /// complete Session remains authoritative even if a late cancel arrives.
    pub async fn write_bundle_atomic_cancellable(
        &self,
        bundle: &OfflineSessionBundle,
        is_cancelled: impl Fn() -> bool,
    ) -> Result<(), OfflineSessionImportError> {
        if is_cancelled() {
            return Err(OfflineSessionImportError::Cancelled);
        }
        validate_bundle_shape(bundle)?;
        fs::create_dir_all(self.sessions_root())
            .await
            .map_err(|error| {
                OfflineSessionImportError::InvalidBundle(format!(
                    "failed to create Sessions directory: {error}"
                ))
            })?;

        let session_id = &bundle.metadata.session_id;
        let final_dir = self.layout.session_dir(session_id);
        if fs::try_exists(&final_dir).await.map_err(|error| {
            OfflineSessionImportError::InvalidBundle(format!(
                "failed to inspect existing Session directory: {error}"
            ))
        })? {
            return Err(OfflineSessionImportError::InvalidBundle(format!(
                "Session {session_id} already exists"
            )));
        }

        let nonce = std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .map(|duration| duration.as_nanos())
            .unwrap_or_default();
        let staging_root = self.sessions_root().join(format!(
            ".importing-{session_id}-{nonce}-{}",
            std::process::id()
        ));
        let staging_layout = SessionStorageLayout::new(&staging_root);
        staging_layout
            .ensure_turns_dir(session_id)
            .await
            .map_err(|error| {
                OfflineSessionImportError::InvalidBundle(format!(
                    "failed to create staging Turns directory: {error}"
                ))
            })?;

        let mut published = false;
        let write_result = async {
            for turn in &bundle.turns {
                if is_cancelled() {
                    return Err(OfflineSessionImportError::Cancelled);
                }
                self.json_store
                    .write_atomic_strict(
                        &staging_layout.turn_path(session_id, turn.turn_index),
                        &StoredDialogTurnFile::new(turn.clone()),
                    )
                    .await?;
            }

            if is_cancelled() {
                return Err(OfflineSessionImportError::Cancelled);
            }
            fs::rename(staging_layout.session_dir(session_id), &final_dir)
                .await
                .map_err(|error| {
                    OfflineSessionImportError::InvalidBundle(format!(
                        "failed to publish Session directory: {error}"
                    ))
                })?;
            published = true;
            self.metadata_store
                .save_metadata(&bundle.metadata)
                .await
                .map_err(OfflineSessionImportError::Metadata)
        }
        .await;

        if let Err(error) = write_result {
            let _ = fs::remove_dir_all(&staging_root).await;
            // A competing importer may have published the same stable ID.
            // Failure before our rename must never remove its completed data.
            if published {
                let _ = fs::remove_dir_all(&final_dir).await;
            }
            let _ = self.metadata_store.rebuild_index().await;
            return Err(error);
        }

        let _ = fs::remove_dir_all(&staging_root).await;
        Ok(())
    }

    pub async fn load_bundle(
        &self,
        session_id: &str,
    ) -> Result<Option<OfflineSessionBundle>, OfflineSessionImportError> {
        validate_session_id(session_id).map_err(OfflineSessionImportError::InvalidBundle)?;
        let Some(stored_metadata) = self
            .json_store
            .read_optional::<StoredSessionMetadataFile>(&self.layout.metadata_path(session_id))
            .await?
        else {
            return Ok(None);
        };
        if stored_metadata.schema_version > SESSION_STORAGE_SCHEMA_VERSION {
            return Err(OfflineSessionImportError::InvalidBundle(format!(
                "Session metadata schema {} is newer than supported schema {}",
                stored_metadata.schema_version, SESSION_STORAGE_SCHEMA_VERSION
            )));
        }

        let mut turns = Vec::new();
        for (file_index, path) in self
            .layout
            .list_indexed_turn_paths(session_id)
            .await
            .map_err(|error| {
                OfflineSessionImportError::InvalidBundle(format!(
                    "failed to list persisted Turns: {error}"
                ))
            })?
        {
            let stored = self
                .json_store
                .read_optional::<StoredDialogTurnFile>(&path)
                .await?
                .ok_or_else(|| {
                    OfflineSessionImportError::InvalidBundle(format!(
                        "persisted Turn disappeared while reading {}",
                        path.display()
                    ))
                })?;
            if stored.schema_version > SESSION_STORAGE_SCHEMA_VERSION {
                return Err(OfflineSessionImportError::InvalidBundle(format!(
                    "Turn schema {} is newer than supported schema {}",
                    stored.schema_version, SESSION_STORAGE_SCHEMA_VERSION
                )));
            }
            if stored.turn.turn_index != file_index {
                return Err(OfflineSessionImportError::InvalidBundle(format!(
                    "Turn file index {file_index} does not match payload index {}",
                    stored.turn.turn_index
                )));
            }
            turns.push(stored.turn);
        }
        let bundle = OfflineSessionBundle {
            metadata: stored_metadata.metadata,
            turns,
        };
        validate_bundle_shape(&bundle)?;
        Ok(Some(bundle))
    }

    /// Repairs an existing import under the caller's Session writer lock. The
    /// original bundle and complete target are retained before any replacement;
    /// metadata is committed last. A retry resumes without reading the source.
    pub async fn repair_bundle(
        &self,
        before: &OfflineSessionBundle,
        after: &OfflineSessionBundle,
    ) -> Result<(), OfflineSessionImportError> {
        before.validate()?;
        after.validate()?;
        if before.metadata.session_id != after.metadata.session_id
            || before.turns.iter().any(|turn| {
                !after
                    .turns
                    .iter()
                    .any(|next| next.turn_index == turn.turn_index && next.turn_id == turn.turn_id)
            })
        {
            return Err(OfflineSessionImportError::InvalidBundle(
                "A history repair cannot remove or reidentify existing Turns".into(),
            ));
        }
        let id = &before.metadata.session_id;
        let journal = self.layout.session_dir(id).join(".history-repair.json");
        if self
            .json_store
            .read_optional::<BundleRepair>(&journal)
            .await?
            .is_some()
        {
            return Err(OfflineSessionImportError::InvalidBundle(
                "A history repair already exists; resume it before starting another".into(),
            ));
        }
        let current = self.load_bundle(id).await?.ok_or_else(|| {
            OfflineSessionImportError::InvalidBundle("The Session to repair is missing".into())
        })?;
        if !same_record(&current, before) {
            return Err(OfflineSessionImportError::InvalidBundle(
                "The Session changed before history repair; preserving its current content".into(),
            ));
        }
        self.json_store
            .write_atomic_strict(
                &journal,
                &BundleRepair {
                    schema_version: 1,
                    before: before.clone(),
                    after: after.clone(),
                },
            )
            .await?;
        self.resume_bundle_repair(id).await?;
        Ok(())
    }

    /// Returns false when no repair journal exists. Never overwrite a Turn or
    /// metadata edited since the journal was written, including by older hosts.
    pub async fn resume_bundle_repair(&self, id: &str) -> Result<bool, OfflineSessionImportError> {
        validate_session_id(id).map_err(OfflineSessionImportError::InvalidBundle)?;
        let Some(repair) = self
            .json_store
            .read_optional::<BundleRepair>(
                &self.layout.session_dir(id).join(".history-repair.json"),
            )
            .await?
        else {
            return Ok(false);
        };
        repair.before.validate()?;
        repair.after.validate()?;
        if repair.schema_version != 1
            || repair.before.metadata.session_id != id
            || repair.after.metadata.session_id != id
            || repair.before.turns.iter().any(|turn| {
                !repair
                    .after
                    .turns
                    .iter()
                    .any(|next| next.turn_index == turn.turn_index && next.turn_id == turn.turn_id)
            })
        {
            return Err(OfflineSessionImportError::InvalidBundle(
                "Unsupported or mismatched history repair journal; original content is retained"
                    .into(),
            ));
        }
        let current = self
            .json_store
            .read_optional::<StoredSessionMetadataFile>(&self.layout.metadata_path(id))
            .await?
            .ok_or_else(|| {
                OfflineSessionImportError::InvalidBundle(
                    "The Session being repaired is missing".into(),
                )
            })?;
        if current.schema_version > SESSION_STORAGE_SCHEMA_VERSION
            || (!same_record(&current.metadata, &repair.before.metadata)
                && !same_record(&current.metadata, &repair.after.metadata))
        {
            return Err(OfflineSessionImportError::InvalidBundle(
                "Session metadata changed during history repair; original content is retained"
                    .into(),
            ));
        }
        let paths = self
            .layout
            .list_indexed_turn_paths(id)
            .await
            .map_err(|error| OfflineSessionImportError::InvalidBundle(error.to_string()))?;
        for (index, path) in &paths {
            let current = self
                .json_store
                .read_optional::<StoredDialogTurnFile>(path)
                .await?
                .ok_or_else(|| {
                    OfflineSessionImportError::InvalidBundle(
                        "A Turn disappeared during history repair".into(),
                    )
                })?;
            let matches = |bundle: &OfflineSessionBundle| {
                bundle
                    .turns
                    .iter()
                    .any(|turn| turn.turn_index == *index && same_record(turn, &current.turn))
            };
            if current.schema_version > SESSION_STORAGE_SCHEMA_VERSION
                || (!matches(&repair.before) && !matches(&repair.after))
            {
                return Err(OfflineSessionImportError::InvalidBundle("Session history changed during repair; original and current content are retained".into()));
            }
        }
        if repair
            .before
            .turns
            .iter()
            .any(|turn| !paths.iter().any(|(index, _)| *index == turn.turn_index))
        {
            return Err(OfflineSessionImportError::InvalidBundle("An original Turn is missing during history repair; refusing to recreate deleted history".into()));
        }
        for turn in &repair.after.turns {
            self.json_store
                .write_atomic_strict(
                    &self.layout.turn_path(id, turn.turn_index),
                    &StoredDialogTurnFile::new(turn.clone()),
                )
                .await?;
        }
        self.metadata_store
            .save_metadata(&repair.after.metadata)
            .await?;
        Ok(true)
    }

    pub async fn rebuild_index(&self) -> Result<(), OfflineSessionImportError> {
        self.metadata_store.rebuild_index().await?;
        Ok(())
    }

    pub async fn list_metadata_including_internal(
        &self,
    ) -> Result<Vec<SessionMetadata>, OfflineSessionImportError> {
        Ok(self
            .metadata_store
            .list_metadata_including_internal()
            .await?)
    }

    pub fn sessions_root(&self) -> &Path {
        self.layout.sessions_root()
    }
}

fn validate_bundle_shape(bundle: &OfflineSessionBundle) -> Result<(), OfflineSessionImportError> {
    validate_session_id(&bundle.metadata.session_id)
        .map_err(OfflineSessionImportError::InvalidBundle)?;
    if bundle.metadata.turn_count != bundle.turns.len() {
        return Err(OfflineSessionImportError::InvalidBundle(format!(
            "Session {} declares {} Turns but contains {}",
            bundle.metadata.session_id,
            bundle.metadata.turn_count,
            bundle.turns.len()
        )));
    }
    let mut indices = BTreeSet::new();
    let mut turn_ids = BTreeSet::new();
    for turn in &bundle.turns {
        if turn.session_id != bundle.metadata.session_id {
            return Err(OfflineSessionImportError::InvalidBundle(format!(
                "Turn {} belongs to a different Session",
                turn.turn_id
            )));
        }
        if !indices.insert(turn.turn_index) {
            return Err(OfflineSessionImportError::InvalidBundle(format!(
                "Session {} contains duplicate Turn index {}",
                bundle.metadata.session_id, turn.turn_index
            )));
        }
        if !turn_ids.insert(turn.turn_id.as_str()) {
            return Err(OfflineSessionImportError::InvalidBundle(format!(
                "Session {} contains duplicate Turn id",
                bundle.metadata.session_id
            )));
        }
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::fs;

    fn legacy_repair_bundles() -> (OfflineSessionBundle, OfflineSessionBundle) {
        let fixture = PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("../legacy-migration/tests/fixtures/v0.2.19/home/projects/c--fixture-workspace/sessions/session-1");
        let metadata: StoredSessionMetadataFile =
            serde_json::from_slice(&fs::read(fixture.join("metadata.json")).unwrap()).unwrap();
        let turn: StoredDialogTurnFile =
            serde_json::from_slice(&fs::read(fixture.join("turns/turn-0000.json")).unwrap())
                .unwrap();
        let before = OfflineSessionBundle {
            metadata: metadata.metadata,
            turns: vec![turn.turn],
        };
        let mut after = before.clone();
        after.turns[0].user_message.content.push_str(" restored");
        let mut second = after.turns[0].clone();
        second.turn_index = 1;
        second.turn_id = "restored-turn-2".into();
        after.turns.push(second);
        after.metadata.turn_count = 2;
        after.metadata.message_count += 1;
        (before, after)
    }

    #[tokio::test]
    async fn history_repair_retains_the_original_and_resumes_partial_writes() {
        let (before, after) = legacy_repair_bundles();
        let temp = tempfile::tempdir().unwrap();
        let store = OfflineSessionImportStore::new(temp.path());
        store.write_bundle_atomic(&before).await.unwrap();
        let id = &before.metadata.session_id;
        let journal_path = store.layout.session_dir(id).join(".history-repair.json");
        store
            .json_store
            .write_atomic_strict(
                &journal_path,
                &BundleRepair {
                    schema_version: 1,
                    before: before.clone(),
                    after: after.clone(),
                },
            )
            .await
            .unwrap();
        // Simulate interruption after one replacement and one append, before
        // the metadata commit. Recovery needs no original external source.
        for turn in &after.turns {
            store
                .json_store
                .write_atomic_strict(
                    &store.layout.turn_path(id, turn.turn_index),
                    &StoredDialogTurnFile::new(turn.clone()),
                )
                .await
                .unwrap();
        }
        assert!(store.load_bundle(id).await.is_err());
        let restarted = OfflineSessionImportStore::new(temp.path());
        assert!(restarted.resume_bundle_repair(id).await.unwrap());
        assert!(same_record(
            &restarted.load_bundle(id).await.unwrap().unwrap(),
            &after
        ));
        let journal: BundleRepair = restarted
            .json_store
            .read_optional(&journal_path)
            .await
            .unwrap()
            .unwrap();
        assert!(same_record(&journal.before, &before));
        assert!(restarted.resume_bundle_repair(id).await.unwrap());
        assert!(same_record(
            &restarted.load_bundle(id).await.unwrap().unwrap(),
            &after
        ));
    }

    #[tokio::test]
    async fn history_repair_refuses_changes_made_after_preparation() {
        for edit_metadata in [false, true] {
            let (before, after) = legacy_repair_bundles();
            let temp = tempfile::tempdir().unwrap();
            let store = OfflineSessionImportStore::new(temp.path());
            store.write_bundle_atomic(&before).await.unwrap();
            let id = &before.metadata.session_id;
            store
                .json_store
                .write_atomic_strict(
                    &store.layout.session_dir(id).join(".history-repair.json"),
                    &BundleRepair {
                        schema_version: 1,
                        before: before.clone(),
                        after,
                    },
                )
                .await
                .unwrap();
            let mut edited = before.clone();
            if edit_metadata {
                edited.metadata.session_name = "User edit after interruption".into();
            } else {
                edited.turns[0].user_message.content = "User edit after interruption".into();
            }
            store.write_bundle(&edited).await.unwrap();
            assert!(store.resume_bundle_repair(id).await.is_err());
            assert!(same_record(
                &store.load_bundle(id).await.unwrap().unwrap(),
                &edited
            ));
        }
    }

    #[tokio::test]
    async fn failed_publication_never_removes_another_importers_session() {
        use std::sync::atomic::{AtomicUsize, Ordering};
        let temp = tempfile::tempdir().unwrap();
        let store = OfflineSessionImportStore::new(temp.path());
        let bundle = OfflineSessionBundle {
            metadata: SessionMetadata::new(
                "same-source".into(),
                "Imported".into(),
                "primary".into(),
                "primary".into(),
            ),
            turns: vec![],
        };
        let final_dir = temp.path().join("same-source");
        let checkpoints = AtomicUsize::new(0);
        let result = store
            .write_bundle_atomic_cancellable(&bundle, || {
                // Another process publishes after the existence check, before our rename.
                if checkpoints.fetch_add(1, Ordering::SeqCst) == 1 {
                    fs::create_dir_all(&final_dir).unwrap();
                    fs::write(final_dir.join("other-process-history"), b"preserve me").unwrap();
                }
                false
            })
            .await;
        assert!(result.is_err());
        assert_eq!(
            fs::read(final_dir.join("other-process-history")).unwrap(),
            b"preserve me"
        );
    }

    #[tokio::test]
    async fn cancelled_atomic_import_cleans_staging_without_publishing_or_removing_existing_data() {
        use std::sync::atomic::{AtomicUsize, Ordering};
        let fixture = PathBuf::from(env!("CARGO_MANIFEST_DIR")).join(
            "../legacy-migration/tests/fixtures/v0.2.19/home/projects/c--fixture-workspace/sessions/session-1",
        );
        let stored_metadata: StoredSessionMetadataFile =
            serde_json::from_slice(&fs::read(fixture.join("metadata.json")).unwrap()).unwrap();
        let stored_turn: StoredDialogTurnFile =
            serde_json::from_slice(&fs::read(fixture.join("turns/turn-0000.json")).unwrap())
                .unwrap();
        let bundle = OfflineSessionBundle {
            metadata: stored_metadata.metadata,
            turns: vec![stored_turn.turn],
        };
        let temp = tempfile::tempdir().unwrap();
        fs::write(temp.path().join("existing-data"), b"preserved").unwrap();
        let store = OfflineSessionImportStore::new(temp.path());
        let checkpoints = AtomicUsize::new(0);

        let result = store
            .write_bundle_atomic_cancellable(&bundle, || {
                checkpoints.fetch_add(1, Ordering::SeqCst) >= 2
            })
            .await;

        assert!(matches!(result, Err(OfflineSessionImportError::Cancelled)));
        assert_eq!(checkpoints.load(Ordering::SeqCst), 3);
        assert!(store.load_bundle("session-1").await.unwrap().is_none());
        assert_eq!(
            fs::read(temp.path().join("existing-data")).unwrap(),
            b"preserved"
        );
        assert!(!fs::read_dir(temp.path()).unwrap().any(|entry| entry
            .unwrap()
            .file_name()
            .to_string_lossy()
            .starts_with(".importing-")));
    }

    #[tokio::test]
    async fn owner_writer_round_trips_a_legacy_bundle_in_the_current_format() {
        let fixture = PathBuf::from(env!("CARGO_MANIFEST_DIR")).join(
            "../legacy-migration/tests/fixtures/v0.2.19/home/projects/c--fixture-workspace/sessions/session-1",
        );
        let stored_metadata: StoredSessionMetadataFile =
            serde_json::from_slice(&fs::read(fixture.join("metadata.json")).unwrap()).unwrap();
        let stored_turn: StoredDialogTurnFile =
            serde_json::from_slice(&fs::read(fixture.join("turns/turn-0000.json")).unwrap())
                .unwrap();
        let bundle = OfflineSessionBundle {
            metadata: stored_metadata.metadata,
            turns: vec![stored_turn.turn],
        };
        let temp_root = std::env::var_os("OPENBITFUN_TEST_TMPDIR")
            .map(PathBuf::from)
            .unwrap_or_else(|| PathBuf::from("E:/tmp"));
        fs::create_dir_all(&temp_root).unwrap();
        let temp = tempfile::Builder::new()
            .prefix("openbitfun-offline-session-")
            .tempdir_in(temp_root)
            .unwrap();
        let store = OfflineSessionImportStore::new(temp.path());

        store.write_bundle_atomic(&bundle).await.unwrap();
        let reloaded = store.load_bundle("session-1").await.unwrap().unwrap();
        reloaded.validate().unwrap();
        assert_eq!(reloaded.metadata.session_id, "session-1");
        assert_eq!(reloaded.turns.len(), 1);
        assert_eq!(reloaded.turns[0].turn_id, "turn-1");
        let stored: StoredSessionMetadataFile =
            serde_json::from_slice(&fs::read(temp.path().join("session-1/metadata.json")).unwrap())
                .unwrap();
        assert_eq!(stored.schema_version, SESSION_STORAGE_SCHEMA_VERSION);
    }
}
