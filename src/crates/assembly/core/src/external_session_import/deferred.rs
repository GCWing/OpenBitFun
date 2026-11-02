//! Lightweight external history references. Only an explicit history read
//! reads a source snapshot; navigation never copies transcript bodies.

mod legacy;
#[cfg(test)]
mod test_io;
pub(crate) mod tracking;
pub(crate) use legacy::has_native_view;

use super::*;
use crate::service::workspace::{WorkspaceInfo, WorkspaceKind};
use crate::util::errors::{OpenBitFunError, OpenBitFunResult};
use openbitfun_services_core::{json_store::JsonFileStore, session::SessionMetadataStore};
use serde::{Deserialize, Serialize};
use serde_json::Value;
use std::collections::{BTreeMap, HashSet};

const INDEX_FILE: &str = ".external-session-index.json";
const PENDING_KEY: &str = "externalHistoryPending";
const SOURCE_TITLE_KEY: &str = "sourceSessionTitle";

pub(crate) fn needs_legacy_history_repair(metadata: &SessionMetadata) -> bool {
    let custom = metadata.custom_metadata.as_ref();
    custom.is_some_and(|custom| {
        custom["importedFrom"] == "codex" && custom["sourceRevision"] == "codex-rollout-jsonl-v1"
    }) && metadata.turn_count > 0
        && metadata.status != SessionStatus::Active
        && metadata.message_count == metadata.turn_count
        && metadata.tool_call_count == 0
}

fn can_repair_history(before: &OfflineSessionBundle, after: &OfflineSessionBundle) -> bool {
    needs_legacy_history_repair(&before.metadata)
        && before.turns.len() <= after.turns.len()
        && after.metadata.message_count > after.metadata.turn_count
        && before.turns.iter().zip(&after.turns).all(|(old, new)| {
            old.turn_id == new.turn_id
                && old.turn_index == new.turn_index
                && old.status != TurnStatus::InProgress
                && old.user_message.content.trim_end_matches(['\r', '\n'])
                    == new.user_message.content.trim_end_matches(['\r', '\n'])
                && old.user_message.metadata.as_ref().is_some_and(|metadata| {
                    metadata["importedFrom"] == "codex" && metadata["sourceTurnId"].is_string()
                })
                && old.model_rounds.len() == 1
                && old.model_rounds.iter().all(|round| {
                    round.status == "completed"
                        && round.text_items.is_empty()
                        && round.tool_items.is_empty()
                        && round.thinking_items.is_empty()
                })
        })
}

#[derive(Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
struct Reference {
    ecosystem_id: String,
    candidate_id: String,
    source_session_id: String,
    metadata: SessionMetadata,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    source_title: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    fallback_title: Option<String>,
    #[serde(default)]
    dismissed: bool,
}

#[derive(Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
struct Index {
    #[serde(default = "schema_version")]
    schema_version: u32,
    #[serde(default)]
    entries: BTreeMap<String, Reference>,
}

fn schema_version() -> u32 {
    1
}
impl Default for Index {
    fn default() -> Self {
        Self {
            schema_version: 1,
            entries: BTreeMap::new(),
        }
    }
}

type Stamp = openbitfun_services_core::json_store::JsonFileRevision;
type IndexCache = HashMap<PathBuf, (Stamp, Arc<Index>)>;
static CACHE: LazyLock<tokio::sync::Mutex<IndexCache>> = LazyLock::new(Default::default);

pub(crate) async fn catalog_revision(root: &Path) -> OpenBitFunResult<Option<Stamp>> {
    JsonFileStore
        .revision(&root.join(INDEX_FILE))
        .await
        .map_err(index_error)
}

fn index_error(error: impl std::fmt::Display) -> OpenBitFunError {
    OpenBitFunError::io(format!("External session index is unavailable: {error}"))
}

async fn read_index(root: &Path) -> OpenBitFunResult<Arc<Index>> {
    let path = root.join(INDEX_FILE);
    let Some(stamp) = catalog_revision(root).await? else {
        CACHE.lock().await.remove(&path);
        return Ok(Arc::new(Index::default()));
    };
    let mut cache = CACHE.lock().await;
    if let Some((previous, index)) = cache.get(&path) {
        if *previous == stamp {
            return Ok(index.clone());
        }
    }
    let mut index: Index = JsonFileStore
        .read_optional(&path)
        .await
        .map_err(index_error)?
        .unwrap_or_default();
    if index.schema_version != 1 {
        return Err(index_error(
            "This external history index requires a newer OpenBitFun host",
        ));
    }
    // Read compatibility must not rewrite the user's index or frozen history.
    for entry in index.entries.values_mut() {
        entry.metadata.normalize_legacy_imported_agent_type();
    }
    let index = Arc::new(index);
    cache.insert(path, (stamp, index.clone()));
    Ok(index)
}

async fn update_index<T>(
    root: &Path,
    update: impl FnOnce(&mut Index) -> (T, bool),
) -> OpenBitFunResult<T> {
    let path = root.join(INDEX_FILE);
    let _lock = JsonFileStore
        .acquire_cross_process_lock(&path)
        .await
        .map_err(index_error)?;
    // Read under the cross-process writer lock; never overwrite a peer writer
    // with an in-memory snapshot or repair an unreadable record by discarding it.
    let mut index: Index = JsonFileStore
        .read_optional(&path)
        .await
        .map_err(index_error)?
        .unwrap_or_default();
    if index.schema_version != 1 {
        return Err(index_error(
            "This external history index requires a newer OpenBitFun host",
        ));
    }
    let (result, changed) = update(&mut index);
    if changed {
        JsonFileStore
            .write_atomic_strict(&path, &index)
            .await
            .map_err(index_error)?;
        CACHE.lock().await.remove(&path);
        #[cfg(test)]
        test_io::record(root, |counts| counts.index_writes += 1);
        SessionMetadataStore::notify_catalog_changed();
        #[cfg(test)]
        test_io::record(root, |counts| counts.catalog_notifications += 1);
    }
    Ok(result)
}

pub(crate) fn is_deferred(metadata: &SessionMetadata) -> bool {
    metadata
        .custom_metadata
        .as_ref()
        .and_then(|value| value.get(PENDING_KEY))
        .and_then(serde_json::Value::as_bool)
        == Some(true)
}

fn apply_source_title(
    metadata: &mut SessionMetadata,
    source_title: Option<&str>,
    fallback_title: Option<&str>,
) -> bool {
    let Some(title) = source_title.filter(|title| !title.trim().is_empty()) else {
        return false;
    };
    if metadata
        .custom_metadata
        .as_ref()
        .and_then(|custom| custom.get("externalSessionTitleOverride"))
        .and_then(Value::as_bool)
        == Some(true)
    {
        return false;
    }
    let previous = metadata
        .custom_metadata
        .as_ref()
        .and_then(|custom| custom.get(SOURCE_TITLE_KEY))
        .and_then(Value::as_str);
    let unchanged = if let Some(previous) = previous {
        metadata.session_name == previous
    } else {
        // Older imports used either the adapter's exact prompt preview or its
        // empty-title default. Do not infer ownership from arbitrary prefixes.
        metadata.session_name == title
            || fallback_title == Some(metadata.session_name.as_str())
            || metadata.session_name == "Imported session"
            || metadata
                .custom_metadata
                .as_ref()
                .and_then(|custom| custom.get("importedFrom"))
                .and_then(Value::as_str)
                .and_then(|source| ImportSource::from_ecosystem(source).ok())
                .is_some_and(|source| {
                    metadata.session_name == format!("Imported {} Session", source.name())
                })
    };
    if !unchanged || (metadata.session_name == title && previous == Some(title)) {
        return false;
    }
    metadata.session_name = title.into();
    if let Some(custom) = metadata
        .custom_metadata
        .get_or_insert_with(|| json!({}))
        .as_object_mut()
    {
        custom.insert(SOURCE_TITLE_KEY.into(), json!(title));
    }
    true
}

fn project_titles(index: &Index, metadata: &mut [SessionMetadata]) {
    let sources = index
        .entries
        .values()
        .filter(|entry| !entry.dismissed)
        .map(|entry| {
            (
                (
                    entry.metadata.workspace_id.as_deref(),
                    entry.ecosystem_id.as_str(),
                    entry.source_session_id.as_str(),
                ),
                entry,
            )
        })
        .collect::<HashMap<_, _>>();
    for metadata in metadata {
        let source = super::auto_discovery::source_identity(metadata.custom_metadata.as_ref());
        let entry = index
            .entries
            .get(&metadata.session_id)
            .filter(|entry| !entry.dismissed)
            .or_else(|| {
                source.as_ref().and_then(|(ecosystem, source_id)| {
                    sources
                        .get(&(
                            metadata.workspace_id.as_deref(),
                            ecosystem.as_str(),
                            source_id.as_str(),
                        ))
                        .copied()
                })
            });
        if let Some(entry) = entry {
            apply_source_title(
                metadata,
                entry.source_title.as_deref(),
                entry.fallback_title.as_deref(),
            );
        }
    }
}

/// Metadata reads project corrected source names without rewriting every native
/// Session on startup. A later ordinary save retains the title and its baseline.
pub(crate) async fn refresh_metadata_titles(root: &Path, metadata: &mut [SessionMetadata]) {
    for entry in metadata.iter_mut() {
        tracking::project_native_metadata(entry);
    }
    match read_index(root).await {
        Ok(index) => {
            project_titles(&index, metadata);
            legacy::project_metadata(&index, metadata);
        }
        Err(error) => log::warn!("External session names could not be refreshed: {error}"),
    }
}

pub(crate) async fn register(
    root: &Path,
    workspace: &WorkspaceInfo,
    project: &WorkspaceInfo,
    candidates: Vec<ExternalSessionCandidate>,
) -> OpenBitFunResult<usize> {
    if candidates.is_empty() {
        return Ok(0);
    }
    // This index read does not open hundreds of existing metadata/Turn files.
    let native = SessionMetadataStore::new(root)
        .list_indexed_metadata()
        .await
        .map_err(index_error)?;
    let native_by_source = native
        .iter()
        .filter(|metadata| metadata.workspace_id.as_deref() == Some(&workspace.id))
        .filter_map(|metadata| {
            super::auto_discovery::source_identity(metadata.custom_metadata.as_ref())
                .map(|identity| (identity, metadata))
        })
        .collect::<HashMap<_, _>>();
    let native_ids = native
        .iter()
        .map(|metadata| metadata.session_id.as_str())
        .collect::<HashSet<_>>();
    update_index(root, |index| {
        let mut added = 0;
        let mut changed = false;
        let mut known = index
            .entries
            .iter()
            .filter(|(id, entry)| {
                entry.metadata.workspace_id.as_deref() == Some(&workspace.id)
                    && (entry.dismissed || legacy::follows_native(&entry.metadata) || (!native_ids.contains(id.as_str())
                        && (is_deferred(&entry.metadata) || tracking::is_followed(&entry.metadata))))
            })
            .map(|(id, entry)| {
                (
                    (entry.ecosystem_id.clone(), entry.source_session_id.clone()),
                    id.clone(),
                )
            })
            .collect::<HashMap<_, _>>();
        for (id, entry) in &index.entries {
            if entry.metadata.workspace_id.as_deref() == Some(&workspace.id)
                && !entry.dismissed && !legacy::is_alias(&entry.metadata)
                && !native_ids.contains(id.as_str()) && tracking::is_followed(&entry.metadata) {
                known.insert((entry.ecosystem_id.clone(), entry.source_session_id.clone()), id.clone());
            }
        }
        for candidate in candidates {
            let identity = (
                candidate.ecosystem_id.clone(),
                candidate.source_session_id.clone(),
            );
            let automatic_id = super::auto_discovery::automatic_session_id(
                &workspace.id, &identity.0, &identity.1,
            );
            let existing = native.iter().find(|metadata| metadata.session_id == automatic_id)
                .or_else(|| native_by_source.get(&identity).copied());
            if let Some(native) = existing {
                if !index.entries.contains_key(&native.session_id) {
                    index.entries.insert(native.session_id.clone(), Reference {
                        ecosystem_id: identity.0.clone(), candidate_id: candidate.candidate_id.clone(),
                        source_session_id: identity.1.clone(), metadata: native.clone(),
                        source_title: candidate.title.clone(), fallback_title: candidate.fallback_title.clone(), dismissed: false,
                    });
                    changed = true;
                }
            }
            if let Some(native) = existing.filter(|native| native.session_id == automatic_id) {
                changed |= legacy::prepare_reference(index, native, &candidate);
                if index.entries.get(&automatic_id).is_some_and(|entry| legacy::follows_native(&entry.metadata)) {
                    known.insert(identity.clone(), automatic_id.clone());
                }
            }
            // Automatic legacy imports retain their ID; opening validates the
            // old copy before treating it as a cache of the source.
            let mut id = if existing.is_some() { format!("external-{automatic_id}") } else { automatic_id.clone() };
            let mut generation = 2;
            while native_ids.contains(id.as_str()) {
                id = format!("external-{automatic_id}-{generation}");
                generation += 1;
            }
            // A persisted reference owns user edits and deletion intent. A scan
            // cannot undo rename/archive/delete or a completed native import.
            if let Some(known_id) = known.get(&identity) {
                if let Some(entry) = index
                    .entries
                    .get_mut(known_id)
                    .filter(|entry| !entry.dismissed)
                {
                    if !tracking::is_followed(&entry.metadata) && existing.is_none() {
                        entry.metadata.custom_metadata.get_or_insert_with(|| json!({}))["externalHistoryMode"] = json!("follow");
                        changed = true;
                    }
                    if tracking::is_followed(&entry.metadata) {
                        if let Some(last_active_at) = candidate.updated_at.or(candidate.created_at) {
                            if entry.metadata.last_active_at != last_active_at {
                                entry.metadata.last_active_at = last_active_at;
                                changed = true;
                            }
                        }
                        let custom = entry.metadata.custom_metadata.get_or_insert_with(|| json!({}));
                        let observed = json!(candidate.fingerprint);
                        if custom["externalObservedFingerprint"] != observed {
                            custom["externalObservedFingerprint"] = observed;
                            changed = true;
                        }
                        if custom["externalContentVersion"].is_null() {
                            let incomplete = json!(candidate.status != openbitfun_product_domains::session_import::ExternalSessionStatus::Complete);
                            if custom["externalSourceIncomplete"] != incomplete {
                                custom["externalSourceIncomplete"] = incomplete;
                                changed = true;
                            }
                        }
                    }
                    // Codex may archive a rollout under a different filename.
                    // Refresh its locator while keeping all user metadata.
                    if entry.candidate_id != candidate.candidate_id {
                        entry.candidate_id = candidate.candidate_id;
                        changed = true;
                    }
                    // An unavailable optional title store must not erase a name
                    // obtained from the source on an earlier successful scan.
                    if candidate.title.is_some()
                        && (candidate.title_is_source_name || entry.source_title.is_none())
                        && entry.source_title != candidate.title
                    {
                        entry.source_title = candidate.title;
                        changed = true;
                    }
                    if entry.fallback_title != candidate.fallback_title {
                        entry.fallback_title = candidate.fallback_title;
                        changed = true;
                    }
                    if is_deferred(&entry.metadata) {
                        changed |= apply_source_title(
                            &mut entry.metadata,
                            entry.source_title.as_deref(),
                            entry.fallback_title.as_deref(),
                        );
                    }
                }
                continue;
            }
            known.insert(identity.clone(), id.clone());
            let metadata = {
                let mut metadata = SessionMetadata::new(
                    id.clone(),
                    candidate
                        .title
                        .clone()
                        .unwrap_or_else(|| "Imported session".into()),
                    "Standard".into(),
                    "primary".into(),
                );
                metadata.workspace_id = Some(workspace.id.clone());
                metadata.workspace_path = Some(workspace.root_path.to_string_lossy().into_owned());
                metadata.project_workspace_id = Some(project.id.clone());
                metadata.project_workspace_path =
                    Some(project.root_path.to_string_lossy().into_owned());
                metadata.created_at = candidate.created_at.or(candidate.updated_at).unwrap_or(0);
                metadata.last_active_at =
                    candidate.updated_at.or(candidate.created_at).unwrap_or(0);
                metadata.memory_mode = SessionMemoryMode::Disabled;
                metadata.status = SessionStatus::Completed;
                metadata.custom_metadata = Some(json!({
                    "importedFrom": identity.0, "sourceSessionId": identity.1,
                    "sourceFingerprint": candidate.fingerprint, "sourceCwd": candidate.cwd,
                    "sourceSessionTitle": candidate.title,
                    "externalHistoryPending": true, "continuationMode": "fork_before_continue",
                    "externalHistoryMode": "follow", "externalObservedFingerprint": candidate.fingerprint,
                    "externalSourceIncomplete": candidate.status != openbitfun_product_domains::session_import::ExternalSessionStatus::Complete
                }));
                metadata
            };
            index.entries.insert(
                id,
                Reference {
                    ecosystem_id: identity.0,
                    candidate_id: candidate.candidate_id,
                    source_session_id: identity.1,
                    metadata,
                    source_title: candidate.title,
                    fallback_title: candidate.fallback_title,
                    dismissed: false,
                },
            );
            added += 1;
            changed = true;
        }
        (added, changed)
    })
    .await
}

pub(crate) async fn merge_metadata(
    root: &Path,
    mut native: Vec<SessionMetadata>,
) -> OpenBitFunResult<Vec<SessionMetadata>> {
    for metadata in &mut native {
        tracking::project_native_metadata(metadata);
    }
    let index = match read_index(root).await {
        Ok(index) => index,
        Err(error) => {
            // The page endpoint exposes a discovery warning. An unreadable
            // optional sidecar must not hide independently persisted Sessions.
            log::warn!("External session references could not be listed: {error}");
            return Ok(native);
        }
    };
    project_titles(&index, &mut native);
    legacy::project_metadata(&index, &mut native);
    let identities = native
        .iter()
        .filter_map(|metadata| {
            super::auto_discovery::source_identity(metadata.custom_metadata.as_ref())
                .map(|source| (metadata.workspace_id.clone(), source))
        })
        .collect::<HashSet<_>>();
    let ids = native
        .iter()
        .map(|metadata| metadata.session_id.clone())
        .collect::<HashSet<_>>();
    native.extend(
        index
            .entries
            .values()
            .filter(|entry| {
                !entry.dismissed
                    && !legacy::is_alias(&entry.metadata)
                    && (is_deferred(&entry.metadata) || tracking::is_followed(&entry.metadata))
                    && !ids.contains(&entry.metadata.session_id)
                    && (tracking::is_followed(&entry.metadata)
                        || !identities.contains(&(
                            entry.metadata.workspace_id.clone(),
                            (entry.ecosystem_id.clone(), entry.source_session_id.clone()),
                        )))
            })
            .map(|entry| entry.metadata.clone()),
    );
    native.sort_by(|a, b| {
        b.last_active_at
            .cmp(&a.last_active_at)
            .then(a.session_id.cmp(&b.session_id))
    });
    Ok(native)
}

pub(crate) async fn has_references(root: &Path) -> OpenBitFunResult<bool> {
    Ok(read_index(root).await?.entries.values().any(|entry| {
        !entry.dismissed
            && (is_deferred(&entry.metadata)
                || tracking::is_followed(&entry.metadata)
                || entry.source_title.is_some())
    }))
}

pub(crate) async fn metadata(root: &Path, id: &str) -> OpenBitFunResult<Option<SessionMetadata>> {
    Ok(read_index(root)
        .await?
        .entries
        .get(id)
        .filter(|entry| {
            !entry.dismissed
                && (is_deferred(&entry.metadata) || tracking::is_followed(&entry.metadata))
        })
        .map(|entry| entry.metadata.clone()))
}

pub(crate) async fn save_metadata(
    root: &Path,
    metadata: &SessionMetadata,
) -> OpenBitFunResult<bool> {
    if (!is_deferred(metadata) && !tracking::is_followed(metadata))
        || (!legacy::follows_native(metadata)
            && tokio::fs::try_exists(root.join(&metadata.session_id).join("metadata.json"))
                .await
                .map_err(index_error)?)
    {
        return Ok(false);
    }
    update_index(root, |index| {
        let Some(entry) = index
            .entries
            .get_mut(&metadata.session_id)
            .filter(|entry| !entry.dismissed)
        else {
            return (false, false);
        };
        let renamed = entry.metadata.session_name != metadata.session_name;
        let mut next = metadata.clone();
        if tracking::is_followed(&entry.metadata) {
            next.turn_count = entry.metadata.turn_count;
            next.message_count = entry.metadata.message_count;
            next.tool_call_count = entry.metadata.tool_call_count;
            next.last_turn = entry.metadata.last_turn.clone();
            next.last_finished_at = entry.metadata.last_finished_at;
            let custom = next.custom_metadata.get_or_insert_with(|| json!({}));
            if let Some(current) = entry
                .metadata
                .custom_metadata
                .as_ref()
                .and_then(Value::as_object)
            {
                for (key, value) in current {
                    if key.starts_with("external")
                        || key.starts_with("source")
                        || key == "importedFrom"
                        || key == "continuationMode"
                    {
                        custom[key] = value.clone();
                    }
                }
            }
        }
        entry.metadata = next;
        if renamed {
            if let Some(custom) = entry
                .metadata
                .custom_metadata
                .as_mut()
                .and_then(Value::as_object_mut)
            {
                custom.insert("externalSessionTitleOverride".into(), json!(true));
            }
        }
        (true, true)
    })
    .await
}

pub(crate) async fn dismiss(root: &Path, id: &str) -> OpenBitFunResult<()> {
    let native = SessionMetadataStore::new(root)
        .load_metadata(id)
        .await
        .map_err(index_error)?;
    let identity = native.as_ref().and_then(|metadata| {
        super::auto_discovery::source_identity(metadata.custom_metadata.as_ref())
    });
    if identity.is_none() && !read_index(root).await?.entries.contains_key(id) {
        return Ok(());
    }
    update_index(root, |index| {
        let mut changed = false;
        let deleting_source = index
            .entries
            .get(id)
            .is_some_and(|entry| legacy::follows_native(&entry.metadata));
        if let (Some(metadata), Some((ecosystem_id, source_session_id))) =
            (native.as_ref(), identity.as_ref())
        {
            if !index.entries.contains_key(id) {
                index.entries.insert(
                    id.into(),
                    Reference {
                        ecosystem_id: ecosystem_id.clone(),
                        candidate_id: String::new(),
                        source_session_id: source_session_id.clone(),
                        metadata: metadata.clone(),
                        source_title: None,
                        fallback_title: None,
                        dismissed: true,
                    },
                );
                changed = true;
            }
            if let Some(entry) = index.entries.get_mut(id).filter(|_| !deleting_source) {
                // An older writer may have materialized a followed reference.
                // Its deletion must only dismiss that now-independent copy.
                entry.metadata = metadata.clone();
                tracking::project_native_metadata(&mut entry.metadata);
                changed = true;
            }
        }
        for (entry_id, entry) in &mut index.entries {
            let same_source = identity.as_ref().is_some_and(|(ecosystem, source)| {
                ecosystem == &entry.ecosystem_id
                    && source == &entry.source_session_id
                    && native.as_ref().is_some_and(|metadata| {
                        metadata.workspace_id == entry.metadata.workspace_id
                    })
            });
            if (entry_id == id
                || (same_source && (deleting_source || !tracking::is_followed(&entry.metadata))))
                && !entry.dismissed
            {
                entry.dismissed = true;
                changed = true;
            }
        }
        ((), changed)
    })
    .await
}

pub(crate) async fn removed_metadata(
    root: &Path,
    workspace_id: &str,
    ecosystem_id: &str,
) -> OpenBitFunResult<Vec<SessionMetadata>> {
    Ok(read_index(root)
        .await?
        .entries
        .values()
        .filter(|entry| {
            entry.dismissed
                && !legacy::is_alias(&entry.metadata)
                && (is_deferred(&entry.metadata) || tracking::is_followed(&entry.metadata))
                && entry.metadata.workspace_id.as_deref() == Some(workspace_id)
                && entry.ecosystem_id == ecosystem_id
        })
        .map(|entry| entry.metadata.clone())
        .collect())
}

pub(crate) async fn restore_reference(
    root: &Path,
    workspace_id: &str,
    ecosystem_id: &str,
    id: &str,
) -> OpenBitFunResult<()> {
    update_index(root, |index| {
        let Some(entry) = index.entries.get_mut(id).filter(|entry| {
            entry.metadata.workspace_id.as_deref() == Some(workspace_id)
                && entry.ecosystem_id == ecosystem_id
                && !legacy::is_alias(&entry.metadata)
                && (is_deferred(&entry.metadata) || tracking::is_followed(&entry.metadata))
        }) else {
            return (
                Err(OpenBitFunError::NotFound(
                    "Removed source session was not found in this workspace".into(),
                )),
                false,
            );
        };
        if !entry.dismissed {
            // A retry after a successful restore must not undo a later archive.
            return (Ok(()), false);
        }
        entry.dismissed = false;
        entry.metadata.status = SessionStatus::Active;
        let custom = entry
            .metadata
            .custom_metadata
            .get_or_insert_with(|| json!({}));
        custom[PENDING_KEY] = json!(true);
        custom["externalHistoryMode"] = json!("follow");
        custom["continuationMode"] = json!("fork_before_continue");
        // Legacy links can refer to an alias of this same source. Preserve those
        // identities and snapshots without creating another navigation row.
        for alias in index.entries.values_mut().filter(|entry| {
            entry.metadata.workspace_id.as_deref() == Some(workspace_id)
                && entry.ecosystem_id == ecosystem_id
                && entry
                    .metadata
                    .custom_metadata
                    .as_ref()
                    .is_some_and(|custom| custom["externalHistoryAliasOf"] == id)
        }) {
            alias.dismissed = false;
        }
        (Ok(()), true)
    })
    .await?
}

/// Caller holds the existing Session write and persistence locks. An unopened
/// reference is kept on failure, so source loss never masquerades as an empty
/// native conversation and can be retried after the source is restored.
pub(crate) async fn materialize(root: &Path, id: &str) -> OpenBitFunResult<()> {
    // A prepared repair survives process interruption and source loss.
    if OfflineSessionImportStore::new(root)
        .resume_bundle_repair(id)
        .await
        .map_err(index_error)?
    {
        return Ok(());
    }
    let Some(entry) = read_index(root)
        .await?
        .entries
        .get(id)
        .filter(|entry| !entry.dismissed)
        .cloned()
    else {
        return Ok(());
    };
    let service = crate::service::workspace::get_global_workspace_service()
        .ok_or_else(|| index_error("Workspace service is unavailable"))?;
    let workspace_id = entry
        .metadata
        .workspace_id
        .as_deref()
        .ok_or_else(|| index_error("External history has no workspace owner"))?;
    let workspace = service
        .require_workspace(workspace_id)
        .await
        .map_err(index_error)?;
    if workspace.workspace_kind == WorkspaceKind::Remote {
        return Err(index_error(
            "External history is unavailable for SSH workspaces",
        ));
    }
    let (store, project) = import_storage(&workspace)
        .await
        .map_err(|error| index_error(error.detail))?;
    if normalized_path(store.sessions_root()) != normalized_path(root) {
        return Err(index_error(
            "External history belongs to a different storage owner",
        ));
    }
    let workspaces = service.list_workspace_infos().await;
    materialize_reference(root, entry, workspace, project, workspaces, |source, id| {
        source.read(id)
    })
    .await
}

async fn materialize_reference(
    root: &Path,
    entry: Reference,
    workspace: WorkspaceInfo,
    project: WorkspaceInfo,
    workspaces: Vec<WorkspaceInfo>,
    read: impl FnOnce(ImportSource, &str) -> Result<ExternalSessionDocument, String> + Send + 'static,
) -> OpenBitFunResult<()> {
    // Kept only for legacy fixed imports and the guarded v1 history repair.
    // New source views never publish a native Session merely by being opened.
    if tracking::is_followed(&entry.metadata) {
        return Box::pin(tracking::refresh_reference(
            root, entry, workspace, project, workspaces, read,
        ))
        .await
        .map(|_| ());
    }
    let store = OfflineSessionImportStore::new(root);
    let before = store
        .load_bundle(&entry.metadata.session_id)
        .await
        .map_err(index_error)?;
    if before
        .as_ref()
        .is_some_and(|bundle| !needs_legacy_history_repair(&bundle.metadata))
    {
        return Ok(());
    }
    let source = ImportSource::from_ecosystem(&entry.ecosystem_id)
        .map_err(|error| index_error(error.detail))?;
    let candidate_id = entry.candidate_id.clone();
    let document = match tokio::task::spawn_blocking(move || read(source, &candidate_id)).await.map_err(index_error)? {
        Ok(document) => document,
        Err(error) if before.is_some() => {
            log::warn!("Original Codex history is unavailable for legacy repair; keeping the existing native copy: session_id={} error={error}", entry.metadata.session_id);
            return Ok(());
        },
        Err(error) => return Err(index_error(format!("The original {} history could not be read. Restore the source file or database and retry. {error}", entry.ecosystem_id))),
    };
    if document.candidate.ecosystem_id != entry.ecosystem_id
        || document.candidate.source_session_id != entry.source_session_id
        || !super::auto_discovery::belongs_to_workspace(
            &document.candidate,
            &workspace,
            &workspaces,
        )
    {
        return Err(index_error(
            "External history source identity or workspace changed; no native copy was created",
        ));
    }
    let mut metadata = before
        .as_ref()
        .map(|bundle| bundle.metadata.clone())
        .unwrap_or(entry.metadata);
    if document.candidate.title_is_source_name {
        apply_source_title(
            &mut metadata,
            document.candidate.title.as_deref(),
            document.candidate.fallback_title.as_deref(),
        );
    }
    let mut bundle = convert_document(
        &metadata.session_id,
        &workspace,
        &project,
        &metadata.agent_type,
        &metadata.session_name,
        &document,
        true,
        true,
    )
    .map_err(|error| index_error(error.detail))?;
    if let Some(before) = &before {
        if !can_repair_history(before, &bundle) {
            return Ok(());
        }
        // Preserve the exact imported prompt (including its original whitespace)
        // and message identity while filling only the missing history.
        for (old, new) in before.turns.iter().zip(&mut bundle.turns) {
            new.user_message = old.user_message.clone();
        }
    }
    metadata.turn_count = bundle.metadata.turn_count;
    metadata.message_count = bundle.metadata.message_count;
    metadata.tool_call_count = bundle.metadata.tool_call_count;
    metadata.last_finished_at = bundle.metadata.last_finished_at;
    if before.is_some() {
        metadata.last_turn = None;
    }
    let custom = metadata.custom_metadata.get_or_insert_with(|| json!({}));
    if let Some(custom) = custom.as_object_mut() {
        custom.remove(PENDING_KEY);
        if let Some(mut source_custom) = bundle
            .metadata
            .custom_metadata
            .and_then(|value| value.as_object().cloned())
        {
            if !document.candidate.title_is_source_name && custom.contains_key(SOURCE_TITLE_KEY) {
                source_custom.remove(SOURCE_TITLE_KEY);
            }
            custom.extend(source_custom);
        }
    }
    bundle.metadata = metadata;
    if let Some(before) = &before {
        store
            .repair_bundle(before, &bundle)
            .await
            .map_err(index_error)?;
    } else {
        store
            .write_bundle_atomic(&bundle)
            .await
            .map_err(index_error)?;
    }
    // Keep the reference for deletion intent and compatibility; native metadata
    // always wins. A crash before this update still resolves to the native copy.
    update_index(root, |index| {
        if let Some(entry) = index.entries.get_mut(&bundle.metadata.session_id) {
            entry.metadata = bundle.metadata;
            if document.candidate.title_is_source_name {
                entry.source_title = document.candidate.title.clone();
                entry.fallback_title = document.candidate.fallback_title.clone();
            }
            ((), true)
        } else {
            ((), false)
        }
    })
    .await?;
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::super::auto_discovery::tests::{candidate, document};
    use super::*;
    use crate::agentic::persistence::PersistenceManager;
    use crate::infrastructure::PathManager;

    fn legacy_answerless_bundle(id: &str, workspace: &WorkspaceInfo) -> OfflineSessionBundle {
        let mut original = document(candidate("codex", id, &workspace.root_path));
        original.turns[0].items.clear();
        original.turns[0].user_text.push('\n');
        let mut bundle = convert_document(
            id,
            workspace,
            workspace,
            "primary",
            "My saved name",
            &original,
            true,
            true,
        )
        .unwrap();
        bundle.metadata.custom_metadata.as_mut().unwrap()["sourceRevision"] =
            json!("codex-rollout-jsonl-v1");
        bundle
    }

    #[tokio::test]
    #[ignore = "Read-only installed history verification; writes only to a temporary copy"]
    async fn inspect_installed_codex_history_repair() {
        let input_root = PathBuf::from(
            std::env::var_os("OPENBITFUN_TEST_NATIVE_SESSIONS_ROOT")
                .expect("Set OPENBITFUN_TEST_NATIVE_SESSIONS_ROOT"),
        );
        let id = std::env::var("OPENBITFUN_TEST_NATIVE_SESSION_ID")
            .expect("Set OPENBITFUN_TEST_NATIVE_SESSION_ID");
        let source_store = OfflineSessionImportStore::new(&input_root);
        let before = source_store.load_bundle(&id).await.unwrap().unwrap();
        assert!(needs_legacy_history_repair(&before.metadata));
        let source_id = before.metadata.custom_metadata.as_ref().unwrap()["sourceSessionId"]
            .as_str()
            .unwrap();
        let candidate = codex_reader()
            .discover_all()
            .unwrap()
            .candidates
            .into_iter()
            .find(|candidate| candidate.source_session_id == source_id)
            .unwrap();
        let (_temp, mut workspace, root, _manager) = fixture();
        workspace.id = before.metadata.workspace_id.clone().unwrap();
        workspace.root_path = PathBuf::from(before.metadata.workspace_path.as_ref().unwrap());
        let entry = Reference {
            ecosystem_id: "codex".into(),
            candidate_id: candidate.candidate_id,
            source_session_id: source_id.into(),
            metadata: before.metadata.clone(),
            source_title: candidate.title,
            fallback_title: candidate.fallback_title,
            dismissed: false,
        };
        let store = OfflineSessionImportStore::new(&root);
        store.write_bundle_atomic(&before).await.unwrap();
        materialize_reference(
            &root,
            entry,
            workspace.clone(),
            workspace.clone(),
            vec![workspace],
            |source, id| source.read(id),
        )
        .await
        .unwrap();
        let after = store.load_bundle(&id).await.unwrap().unwrap();
        assert!(!needs_legacy_history_repair(&after.metadata));
        assert!(after.metadata.message_count > after.metadata.turn_count);
        assert_eq!(
            after.turns[0].user_message.content,
            before.turns[0].user_message.content
        );
        assert_eq!(
            serde_json::to_value(source_store.load_bundle(&id).await.unwrap().unwrap()).unwrap(),
            serde_json::to_value(before).unwrap()
        );
        println!("Installed history repair in temporary copy: {} turns, {} assistant text items, {} tools; original native copy unchanged", after.metadata.turn_count, after.metadata.message_count - after.metadata.turn_count, after.metadata.tool_call_count);
    }

    #[tokio::test]
    async fn legacy_answerless_import_is_repaired_on_open_with_native_metadata_preserved() {
        let (_temp, workspace, root, manager) = fixture();
        let before = legacy_answerless_bundle("old", &workspace);
        let store = OfflineSessionImportStore::new(&root);
        store.write_bundle_atomic(&before).await.unwrap();
        let source = candidate("codex", "old", &workspace.root_path);
        register(&root, &workspace, &workspace, vec![source.clone()])
            .await
            .unwrap();
        let entry = read_index(&root).await.unwrap().entries["old"].clone();
        let mut complete = document(source);
        let mut second = complete.turns[0].clone();
        second.source_turn_id = "second".into();
        second.user_text = "Follow-up question".into();
        complete.turns.push(second);
        materialize_reference(
            &root,
            entry,
            workspace.clone(),
            workspace.clone(),
            vec![workspace.clone()],
            move |_, _| Ok(complete),
        )
        .await
        .unwrap();
        let after = store.load_bundle("old").await.unwrap().unwrap();
        assert_eq!(after.turns.len(), 2);
        assert_eq!(after.metadata.message_count, 4);
        assert_eq!(after.metadata.session_name, before.metadata.session_name);
        assert_eq!(
            after.metadata.last_active_at,
            before.metadata.last_active_at
        );
        assert_eq!(after.metadata.workspace_id, before.metadata.workspace_id);
        assert_eq!(
            after.turns[0].user_message.content,
            before.turns[0].user_message.content
        );
        assert_eq!(
            after.turns[0].model_rounds[0].text_items[0].content,
            "Saved answer"
        );
        assert!(!needs_legacy_history_repair(&after.metadata));
        assert!(root.join("old/.history-repair.json").is_file());
        // Public history reads and a new manager both see the restored turns.
        let (_, turns) = manager.load_session_with_turns(&root, "old").await.unwrap();
        assert_eq!(turns.len(), 2);
        let restarted = PersistenceManager::new(Arc::new(PathManager::with_user_root_for_tests(
            _temp.path().join("user"),
        )))
        .unwrap();
        assert_eq!(
            restarted
                .load_session_turns(&root, "old")
                .await
                .unwrap()
                .len(),
            2
        );
    }

    #[tokio::test]
    async fn legacy_repair_preserves_local_prompt_edits_continuations_and_source_loss() {
        for scenario in ["edited", "continued", "missing", "active", "running"] {
            let (_temp, workspace, root, _manager) = fixture();
            let mut before = legacy_answerless_bundle(scenario, &workspace);
            if scenario == "edited" {
                before.turns[0].user_message.content = "My locally edited question".into();
            } else if scenario == "active" {
                before.metadata.status = SessionStatus::Active;
            } else if scenario == "running" {
                before.turns[0].status = TurnStatus::InProgress;
            } else if scenario == "continued" {
                let mut local = before.turns[0].clone();
                local.turn_id = format!("{scenario}-turn-1");
                local.turn_index = 1;
                local.user_message.metadata = None;
                before.turns.push(local);
                before.metadata.turn_count = 2;
                before.metadata.message_count = 2;
            }
            let store = OfflineSessionImportStore::new(&root);
            store.write_bundle_atomic(&before).await.unwrap();
            let source = candidate("codex", scenario, &workspace.root_path);
            register(&root, &workspace, &workspace, vec![source.clone()])
                .await
                .unwrap();
            let entry = read_index(&root).await.unwrap().entries[scenario].clone();
            let mut complete = document(source);
            complete.turns.push(complete.turns[0].clone());
            materialize_reference(
                &root,
                entry,
                workspace.clone(),
                workspace.clone(),
                vec![workspace],
                move |_, _| {
                    if scenario == "missing" {
                        Err("Source is offline".into())
                    } else {
                        Ok(complete)
                    }
                },
            )
            .await
            .unwrap();
            let after = store.load_bundle(scenario).await.unwrap().unwrap();
            assert_eq!(
                serde_json::to_value(after).unwrap(),
                serde_json::to_value(before).unwrap()
            );
            assert!(!root.join(scenario).join(".history-repair.json").exists());
        }
    }

    #[tokio::test]
    async fn persistence_recovers_a_prepared_legacy_repair_without_the_source() {
        use openbitfun_services_core::session::StoredDialogTurnFile;
        let (_temp, workspace, root, manager) = fixture();
        let before = legacy_answerless_bundle("recover", &workspace);
        let mut source = document(candidate("codex", "recover", &workspace.root_path));
        source.turns.push(source.turns[0].clone());
        let after = convert_document(
            "recover",
            &workspace,
            &workspace,
            "primary",
            "My saved name",
            &source,
            true,
            true,
        )
        .unwrap();
        let store = OfflineSessionImportStore::new(&root);
        store.write_bundle_atomic(&before).await.unwrap();
        JsonFileStore
            .write_atomic_strict(
                &root.join("recover/.history-repair.json"),
                &json!({"schema_version":1,"before":before,"after":after}),
            )
            .await
            .unwrap();
        // The old metadata still declares one turn; an interrupted writer has
        // already appended the second turn. Ordinary bundle loading now fails.
        JsonFileStore
            .write_atomic_strict(
                &root.join("recover/turns/turn-0001.json"),
                &StoredDialogTurnFile::new(after.turns[1].clone()),
            )
            .await
            .unwrap();
        assert!(store.load_bundle("recover").await.is_err());
        let (_, tail, total) = manager
            .load_session_with_tail_turns(&root, "recover", 1)
            .await
            .unwrap();
        assert_eq!(total, 2);
        assert_eq!(tail.len(), 1);
        assert_eq!(
            tail[0].model_rounds[0].text_items[0].content,
            "Saved answer"
        );
        assert!(!needs_legacy_history_repair(
            &store
                .load_bundle("recover")
                .await
                .unwrap()
                .unwrap()
                .metadata
        ));
    }

    #[tokio::test]
    async fn native_write_does_not_reenter_the_optional_legacy_repair_lock() {
        let (_temp, workspace, root, manager) = fixture();
        let before = legacy_answerless_bundle("writing", &workspace);
        let store = OfflineSessionImportStore::new(&root);
        store.write_bundle_atomic(&before).await.unwrap();
        let mut turn = before.turns[0].clone();
        turn.user_message.content = "A local edit".into();
        turn.user_message.metadata = None;
        tokio::time::timeout(
            Duration::from_secs(5),
            manager.save_dialog_turn(&root, &turn),
        )
        .await
        .expect("Native persistence must not deadlock during legacy repair")
        .unwrap();
        assert_eq!(
            store.load_bundle("writing").await.unwrap().unwrap().turns[0]
                .user_message
                .content,
            "A local edit"
        );
    }

    pub(super) fn fixture() -> (
        tempfile::TempDir,
        WorkspaceInfo,
        PathBuf,
        PersistenceManager,
    ) {
        let temp = tempfile::tempdir().unwrap();
        let project = temp.path().join("project");
        std::fs::create_dir_all(&project).unwrap();
        let project = dunce::canonicalize(project).unwrap();
        let workspace =
            crate::service::workspace::legacy_compat::register_local_fixture_blocking(&project);
        let paths = Arc::new(PathManager::with_user_root_for_tests(
            temp.path().join("user"),
        ));
        let root = paths.project_sessions_dir(&project);
        (
            temp,
            workspace,
            root,
            PersistenceManager::new(paths).unwrap(),
        )
    }

    async fn entry(root: &Path) -> Reference {
        read_index(root)
            .await
            .unwrap()
            .entries
            .values()
            .next()
            .unwrap()
            .clone()
    }

    #[tokio::test]
    async fn source_names_refresh_legacy_references_without_unfolding_history_or_losing_local_names(
    ) {
        let (_temp, workspace, root, manager) = fixture();
        let mut source = candidate("codex", "one", &workspace.root_path);
        source.title = Some("Prompt preview".into());
        source.fallback_title = source.title.clone();
        register(&root, &workspace, &workspace, vec![source.clone()])
            .await
            .unwrap();
        let id = entry(&root).await.metadata.session_id;
        update_index(&root, |index| {
            let entry = index.entries.get_mut(&id).unwrap();
            entry.source_title = None;
            entry.fallback_title = None;
            entry
                .metadata
                .custom_metadata
                .as_mut()
                .unwrap()
                .as_object_mut()
                .unwrap()
                .remove(SOURCE_TITLE_KEY);
            ((), true)
        })
        .await
        .unwrap();
        source.title = Some("Original Agent name".into());
        source.title_is_source_name = true;
        register(&root, &workspace, &workspace, vec![source.clone()])
            .await
            .unwrap();
        assert_eq!(
            manager
                .load_session_metadata(&root, &id)
                .await
                .unwrap()
                .unwrap()
                .session_name,
            "Original Agent name"
        );
        assert!(!root.join(&id).exists());
        let mut unavailable = source.clone();
        unavailable.title = unavailable.fallback_title.clone();
        unavailable.title_is_source_name = false;
        register(&root, &workspace, &workspace, vec![unavailable])
            .await
            .unwrap();
        assert_eq!(
            manager
                .load_session_metadata(&root, &id)
                .await
                .unwrap()
                .unwrap()
                .session_name,
            "Original Agent name"
        );
        manager
            .update_session_title_metadata(&root, &id, "My local name", 4000, true)
            .await
            .unwrap();
        // Even a source name temporarily matching the local edit must not take
        // ownership of that user edit on a later scan.
        for name in ["My local name", "Another source name"] {
            source.title = Some(name.into());
            register(&root, &workspace, &workspace, vec![source.clone()])
                .await
                .unwrap();
        }
        let restored = manager
            .load_session_metadata(&root, &id)
            .await
            .unwrap()
            .unwrap();
        assert_eq!(restored.session_name, "My local name");
        assert_eq!(restored.last_active_at, 4000);
        assert!(!root.join(id).exists());
    }

    #[tokio::test]
    async fn legacy_native_names_are_corrected_on_reads_without_rewriting_history_or_user_edits() {
        let (_temp, workspace, root, manager) = fixture();
        let mut candidates = Vec::new();
        let mut original_metadata = Vec::new();
        for (id, title) in [
            ("default", "Prompt preview"),
            ("renamed", "My existing name"),
        ] {
            let mut source = candidate("codex", id, &workspace.root_path);
            source.title = Some("Prompt preview".into());
            source.fallback_title = source.title.clone();
            let mut bundle = convert_document(
                id,
                &workspace,
                &workspace,
                "primary",
                title,
                &document(source.clone()),
                true,
                true,
            )
            .unwrap();
            bundle
                .metadata
                .custom_metadata
                .as_mut()
                .unwrap()
                .as_object_mut()
                .unwrap()
                .remove(SOURCE_TITLE_KEY);
            OfflineSessionImportStore::new(&root)
                .write_bundle_atomic(&bundle)
                .await
                .unwrap();
            original_metadata.push((
                id,
                std::fs::read(root.join(id).join("metadata.json")).unwrap(),
            ));
            source.title = Some("Saved source name".into());
            source.title_is_source_name = true;
            candidates.push(source);
        }
        register(&root, &workspace, &workspace, candidates.clone())
            .await
            .unwrap();
        let page = manager
            .list_session_metadata_page(&root, None, 5)
            .await
            .unwrap();
        assert_eq!(
            page.sessions
                .iter()
                .find(|session| session.session_id == "default")
                .unwrap()
                .session_name,
            "Saved source name"
        );
        assert_eq!(
            page.sessions
                .iter()
                .find(|session| session.session_id == "renamed")
                .unwrap()
                .session_name,
            "My existing name"
        );
        assert_eq!(
            manager
                .session_metadata_by_ids(&root, &["default".into()])
                .await
                .unwrap()[0]
                .session_name,
            "Saved source name"
        );
        assert_eq!(
            manager
                .load_session_metadata(&root, "default")
                .await
                .unwrap()
                .unwrap()
                .session_name,
            "Saved source name"
        );
        for (id, before) in original_metadata {
            assert_eq!(
                std::fs::read(root.join(id).join("metadata.json")).unwrap(),
                before
            );
            assert_eq!(
                manager.load_session_turns(&root, id).await.unwrap()[0]
                    .user_message
                    .content,
                "Saved question"
            );
        }
        manager
            .update_session_title_metadata(&root, "default", "My chosen name", 5000, true)
            .await
            .unwrap();
        for source in &mut candidates {
            source.title = Some("Source renamed later".into());
        }
        register(&root, &workspace, &workspace, candidates)
            .await
            .unwrap();
        assert_eq!(
            manager
                .load_session_metadata(&root, "default")
                .await
                .unwrap()
                .unwrap()
                .session_name,
            "My chosen name"
        );
    }

    #[tokio::test]
    async fn first_open_uses_a_source_name_changed_after_indexing() {
        let (_temp, workspace, root, manager) = fixture();
        let mut source = candidate("codex", "one", &workspace.root_path);
        source.title_is_source_name = true;
        register(&root, &workspace, &workspace, vec![source.clone()])
            .await
            .unwrap();
        let reference = entry(&root).await;
        let id = reference.metadata.session_id.clone();
        source.title = Some("Name saved since discovery".into());
        materialize_reference(
            &root,
            reference,
            workspace.clone(),
            workspace.clone(),
            vec![workspace],
            move |_, _| Ok(document(source)),
        )
        .await
        .unwrap();
        assert_eq!(
            manager
                .load_session_metadata(&root, &id)
                .await
                .unwrap()
                .unwrap()
                .session_name,
            "Name saved since discovery"
        );
        assert!(SessionMetadataStore::new(&root)
            .load_metadata(&id)
            .await
            .unwrap()
            .is_none());
    }

    #[tokio::test]
    async fn startup_indexes_all_sessions_without_copying_bodies_and_persistence_pages_survive_restart(
    ) {
        let (_temp, workspace, root, manager) = fixture();
        let candidates = (0..57)
            .map(|id| candidate("codex", &id.to_string(), &workspace.root_path))
            .collect();
        assert_eq!(
            register(&root, &workspace, &workspace, candidates)
                .await
                .unwrap(),
            57
        );
        assert!(SessionMetadataStore::new(&root)
            .list_indexed_metadata()
            .await
            .unwrap()
            .is_empty());
        let page = manager
            .list_session_metadata_page(&root, None, 5)
            .await
            .unwrap();
        assert_eq!(page.total_top_level_count, 57);
        assert_eq!(page.sessions.len(), 5);
        assert!(page
            .sessions
            .iter()
            .all(|metadata| metadata.turn_count == 0 && !metadata.needs_last_turn_backfill()));
        let id = &page.sessions[0].session_id;
        assert_eq!(
            manager
                .session_metadata_by_ids(&root, &[id.clone()])
                .await
                .unwrap()
                .len(),
            1
        );
        assert!(manager
            .load_session_metadata(&root, id)
            .await
            .unwrap()
            .is_some());
        assert!(!root.join(id).exists());
        CACHE.lock().await.remove(&root.join(INDEX_FILE));
        let restarted = PersistenceManager::new(manager.path_manager().clone()).unwrap();
        let next = restarted
            .list_session_metadata_page(&root, page.next_cursor.as_deref(), 5)
            .await
            .unwrap();
        assert_eq!(next.total_top_level_count, 57);
        assert!(next.sessions.iter().all(|metadata| !page
            .sessions
            .iter()
            .any(|first| first.session_id == metadata.session_id)));
        assert!(
            std::fs::metadata(root.join(INDEX_FILE)).unwrap().len() < 128 * 1024,
            "The startup index stores metadata only"
        );
    }

    #[tokio::test]
    async fn catalog_query_pages_native_and_external_metadata_without_materializing_history() {
        use openbitfun_services_core::session::page::{
            SessionCatalogOrdering, SessionCatalogQuery,
        };
        let (_temp, workspace, root, manager) = fixture();
        let candidates = (0..60)
            .map(|index| {
                let mut value = candidate(
                    if index % 2 == 0 { "codex" } else { "zcode" },
                    &index.to_string(),
                    &workspace.root_path,
                );
                value.created_at = Some(index + 1);
                value.updated_at = Some(1000 - index);
                value
            })
            .collect();
        register(&root, &workspace, &workspace, candidates)
            .await
            .unwrap();
        let mut other = workspace.clone();
        other.id = "another-workspace".into();
        register(
            &root,
            &other,
            &workspace,
            vec![candidate("codex", "other", &workspace.root_path)],
        )
        .await
        .unwrap();
        let mut native = SessionMetadata::new(
            "native".into(),
            "Native".into(),
            "agent".into(),
            "model".into(),
        );
        native.workspace_id = Some(workspace.id.clone());
        native.created_at = 100;
        SessionMetadataStore::new(&root)
            .save_metadata(&native)
            .await
            .unwrap();
        let before = tokio::fs::read(root.join(INDEX_FILE)).await.unwrap();
        let mut query = SessionCatalogQuery {
            workspace_id: workspace.id.clone(),
            ordering: SessionCatalogOrdering::Updated,
            source: "codex".into(),
            sort_timestamps: HashMap::new(),
        };
        let first = manager
            .list_session_metadata_page_with_query(&root, None, 5, Some(&query))
            .await
            .unwrap();
        assert_eq!(first.catalog_query, Some(query.clone()));
        assert_eq!(first.total_top_level_count, 30);
        assert_eq!(first.sessions.len(), 5);
        assert_eq!(first.sessions[0].session_name, "58");
        let second = manager
            .list_session_metadata_page_with_query(
                &root,
                first.next_cursor.as_deref(),
                5,
                Some(&query),
            )
            .await
            .unwrap();
        assert_eq!(second.sessions[0].session_name, "48");
        assert_eq!(second.catalog_revision, first.catalog_revision);
        assert_eq!(manager.session_catalog_build_count_for_test().await, 1);
        assert!(first
            .sessions
            .iter()
            .chain(&second.sessions)
            .all(|record| !root.join(&record.session_id).exists()));
        query.source = "all".into();
        let all = manager
            .list_session_metadata_page_with_query(&root, None, 5, Some(&query))
            .await
            .unwrap();
        assert_eq!(all.total_top_level_count, 61);
        assert_eq!(all.sessions[0].session_id, "native");
        assert_eq!(
            tokio::fs::read(root.join(INDEX_FILE)).await.unwrap(),
            before
        );
        assert_eq!(manager.session_catalog_build_count_for_test().await, 2);

        // Bypass the process-local notification/cache as a foreign writer does.
        let mut foreign: Index = serde_json::from_slice(&before).unwrap();
        let renamed_id = first.sessions[0].session_id.clone();
        let renamed = foreign.entries.get_mut(&renamed_id).unwrap();
        renamed.metadata.session_name = "Renamed outside this process".into();
        renamed.metadata.custom_metadata.as_mut().unwrap()["externalSessionTitleOverride"] =
            Value::Bool(true);
        JsonFileStore
            .write_atomic_strict(&root.join(INDEX_FILE), &foreign)
            .await
            .unwrap();
        query.source = "codex".into();
        let refreshed = manager
            .list_session_metadata_page_with_query(
                &root,
                first.next_cursor.as_deref(),
                5,
                Some(&query),
            )
            .await
            .unwrap();
        assert!(refreshed.catalog_reset);
        assert_eq!(
            refreshed.sessions[0].session_name,
            "Renamed outside this process"
        );
        assert_eq!(manager.session_catalog_build_count_for_test().await, 3);
        let continued = manager
            .list_session_metadata_page_with_query(
                &root,
                refreshed.next_cursor.as_deref(),
                5,
                Some(&query),
            )
            .await
            .unwrap();
        assert!(!continued.catalog_reset);
        assert_eq!(continued.sessions[0].session_name, "48");
        assert_eq!(manager.session_catalog_build_count_for_test().await, 3);
    }

    #[tokio::test]
    async fn rename_archive_and_delete_remain_index_only_and_rediscovery_preserves_intent() {
        let (_temp, workspace, root, manager) = fixture();
        let source = candidate("zcode", "one", &workspace.root_path);
        register(&root, &workspace, &workspace, vec![source.clone()])
            .await
            .unwrap();
        let id = entry(&root).await.metadata.session_id;
        manager
            .update_session_metadata(&root, &id, |metadata| {
                metadata.session_name = "My title".into();
                metadata.status = SessionStatus::Archived;
            })
            .await
            .unwrap();
        assert!(!root.join(&id).exists());
        assert!(manager
            .list_session_metadata_page(&root, None, 5)
            .await
            .unwrap()
            .sessions
            .is_empty());
        let archived = manager
            .list_session_metadata_including_internal(&root)
            .await
            .unwrap();
        assert_eq!(archived[0].session_name, "My title");
        assert_eq!(
            register(&root, &workspace, &workspace, vec![source.clone()])
                .await
                .unwrap(),
            0
        );
        manager.delete_session(&root, &id).await.unwrap();
        assert_eq!(
            register(&root, &workspace, &workspace, vec![source])
                .await
                .unwrap(),
            0
        );
        assert!(manager
            .load_session_metadata(&root, &id)
            .await
            .unwrap()
            .is_none());
        assert!(manager
            .list_session_metadata_page(&root, None, 5)
            .await
            .unwrap()
            .sessions
            .is_empty());
    }

    #[tokio::test]
    async fn legacy_reference_materialization_preserves_user_metadata() {
        let (_temp, workspace, root, manager) = fixture();
        let source = candidate("codex", "one", &workspace.root_path);
        register(
            &root,
            &workspace,
            &workspace,
            vec![
                source.clone(),
                candidate("codex", "two", &workspace.root_path),
            ],
        )
        .await
        .unwrap();
        let id = super::super::auto_discovery::automatic_session_id(&workspace.id, "codex", "one");
        update_index(&root, |index| {
            index
                .entries
                .get_mut(&id)
                .unwrap()
                .metadata
                .custom_metadata
                .as_mut()
                .unwrap()
                .as_object_mut()
                .unwrap()
                .remove("externalHistoryMode");
            ((), true)
        })
        .await
        .unwrap();
        manager
            .update_session_metadata(&root, &id, |metadata| {
                metadata.session_name = "My title".into();
            })
            .await
            .unwrap();
        let reference = read_index(&root).await.unwrap().entries[&id].clone();
        materialize_reference(
            &root,
            reference,
            workspace.clone(),
            workspace.clone(),
            vec![workspace.clone()],
            move |_, _| Ok(document(source)),
        )
        .await
        .unwrap();
        let native = SessionMetadataStore::new(&root)
            .list_indexed_metadata()
            .await
            .unwrap();
        assert_eq!(native.len(), 1);
        assert!(!is_deferred(&native[0]));
        assert_eq!(native[0].session_name, "My title");
        let (restored, turns, total) = manager
            .load_session_with_tail_turns(&root, &id, 5)
            .await
            .unwrap();
        assert_eq!(total, 1);
        assert_eq!(turns[0].user_message.content, "Saved question");
        assert_eq!(restored.session_id, id);
        assert_eq!(
            manager
                .list_session_metadata_page(&root, None, 5)
                .await
                .unwrap()
                .total_top_level_count,
            2
        );
        manager.delete_session(&root, &id).await.unwrap();
        register(
            &root,
            &workspace,
            &workspace,
            vec![candidate("codex", "one", &workspace.root_path)],
        )
        .await
        .unwrap();
        assert!(manager
            .load_session_metadata(&root, &id)
            .await
            .unwrap()
            .is_none());
    }

    #[tokio::test]
    async fn source_loss_and_movement_preserve_reference_without_publishing_empty_history() {
        let (_temp, workspace, root, _) = fixture();
        let source = candidate("codex", "one", &workspace.root_path);
        register(&root, &workspace, &workspace, vec![source.clone()])
            .await
            .unwrap();
        let reference = entry(&root).await;
        let id = reference.metadata.session_id.clone();
        let error = materialize_reference(
            &root,
            reference.clone(),
            workspace.clone(),
            workspace.clone(),
            vec![workspace.clone()],
            |_, _| Err("source removed".into()),
        )
        .await
        .unwrap_err();
        assert!(error.to_string().contains("Restore the source"));
        assert!(metadata(&root, &id).await.unwrap().is_some());
        assert!(!root.join(&id).exists());
        let mut moved = source;
        moved.cwd = Some(
            workspace
                .root_path
                .with_extension("elsewhere")
                .to_string_lossy()
                .into_owned(),
        );
        assert!(materialize_reference(
            &root,
            reference,
            workspace.clone(),
            workspace.clone(),
            vec![workspace],
            move |_, _| Ok(document(moved))
        )
        .await
        .is_err());
        assert!(!root.join(id).exists());
    }

    #[tokio::test]
    async fn existing_native_copy_and_continuation_win_over_discovery() {
        let (_temp, workspace, root, manager) = fixture();
        let source = candidate("zcode", "one", &workspace.root_path);
        let mut bundle = convert_document(
            "legacy-import",
            &workspace,
            &workspace,
            "primary",
            "Renamed",
            &document(source.clone()),
            true,
            true,
        )
        .unwrap();
        bundle.metadata.status = SessionStatus::Archived;
        bundle.turns[0].user_message.content = "Local continuation".into();
        OfflineSessionImportStore::new(&root)
            .write_bundle_atomic(&bundle)
            .await
            .unwrap();
        register(&root, &workspace, &workspace, vec![source.clone()])
            .await
            .unwrap();
        register(&root, &workspace, &workspace, vec![source])
            .await
            .unwrap();
        let merged = manager
            .list_session_metadata_including_internal(&root)
            .await
            .unwrap();
        assert_eq!(merged.len(), 2);
        let independent = merged
            .iter()
            .find(|metadata| metadata.session_id == "legacy-import")
            .unwrap();
        assert_eq!(independent.session_name, "Renamed");
        assert_eq!(independent.status, SessionStatus::Archived);
        assert_eq!(
            merged
                .iter()
                .filter(|metadata| tracking::is_followed(metadata))
                .count(),
            1
        );
        assert_eq!(
            manager
                .load_session_turns(&root, "legacy-import")
                .await
                .unwrap()[0]
                .user_message
                .content,
            "Local continuation"
        );
        manager
            .delete_session(&root, "legacy-import")
            .await
            .unwrap();
        assert!(
            has_references(&root).await.unwrap(),
            "Removing a fixed native copy keeps the followed source"
        );
    }

    #[tokio::test]
    async fn old_index_payload_defaults_round_trip_and_unreadable_records_are_never_reset() {
        let (_temp, workspace, root, _) = fixture();
        register(
            &root,
            &workspace,
            &workspace,
            vec![candidate("codex", "one", &workspace.root_path)],
        )
        .await
        .unwrap();
        let mut old = serde_json::to_value(read_index(&root).await.unwrap().as_ref()).unwrap();
        old.as_object_mut().unwrap().remove("schemaVersion");
        for entry in old["entries"].as_object_mut().unwrap().values_mut() {
            entry.as_object_mut().unwrap().remove("dismissed");
            entry.as_object_mut().unwrap().remove("sourceTitle");
            entry.as_object_mut().unwrap().remove("fallbackTitle");
        }
        let upgraded: Index = serde_json::from_value(old).unwrap();
        let round_trip: Index =
            serde_json::from_value(serde_json::to_value(&upgraded).unwrap()).unwrap();
        assert_eq!(round_trip.schema_version, 1);
        assert!(!round_trip.entries.values().next().unwrap().dismissed);
        assert!(round_trip
            .entries
            .values()
            .next()
            .unwrap()
            .source_title
            .is_none());
        assert!(round_trip
            .entries
            .values()
            .next()
            .unwrap()
            .fallback_title
            .is_none());
        std::fs::write(root.join(INDEX_FILE), "{broken").unwrap();
        assert!(register(
            &root,
            &workspace,
            &workspace,
            vec![candidate("codex", "two", &workspace.root_path)]
        )
        .await
        .is_err());
        assert_eq!(
            std::fs::read_to_string(root.join(INDEX_FILE)).unwrap(),
            "{broken"
        );
    }

    #[tokio::test]
    async fn rediscovery_updates_an_archived_source_locator_without_resetting_its_title() {
        let (_temp, workspace, root, manager) = fixture();
        let mut source = candidate("codex", "one", &workspace.root_path);
        register(&root, &workspace, &workspace, vec![source.clone()])
            .await
            .unwrap();
        let id = entry(&root).await.metadata.session_id;
        manager
            .update_session_metadata(&root, &id, |metadata| {
                metadata.session_name = "My title".into()
            })
            .await
            .unwrap();
        source.candidate_id = "codex:archived-location".into();
        assert_eq!(
            register(&root, &workspace, &workspace, vec![source.clone()])
                .await
                .unwrap(),
            0
        );
        let reference = entry(&root).await;
        assert_eq!(reference.candidate_id, source.candidate_id);
        assert_eq!(reference.metadata.session_name, "My title");
        materialize_reference(
            &root,
            reference,
            workspace.clone(),
            workspace.clone(),
            vec![workspace],
            move |_, candidate_id| {
                assert_eq!(candidate_id, source.candidate_id);
                Ok(document(source))
            },
        )
        .await
        .unwrap();
    }

    #[tokio::test]
    async fn a_broken_optional_index_keeps_native_history_visible_with_a_warning() {
        let (_temp, workspace, root, manager) = fixture();
        let bundle = convert_document(
            "native",
            &workspace,
            &workspace,
            "primary",
            "Native history",
            &document(candidate("codex", "one", &workspace.root_path)),
            true,
            true,
        )
        .unwrap();
        OfflineSessionImportStore::new(&root)
            .write_bundle_atomic(&bundle)
            .await
            .unwrap();
        std::fs::write(root.join(INDEX_FILE), "{broken").unwrap();
        let page = manager
            .list_session_metadata_page(&root, None, 5)
            .await
            .unwrap();
        assert_eq!(page.sessions.len(), 1);
        assert_eq!(page.sessions[0].session_id, "native");
        assert_eq!(page.discovery_warnings.len(), 1);
        let query = openbitfun_services_core::session::page::SessionCatalogQuery {
            workspace_id: workspace.id.clone(),
            ordering: openbitfun_services_core::session::page::SessionCatalogOrdering::Updated,
            source: "all".into(),
            sort_timestamps: HashMap::new(),
        };
        let fallback = manager
            .list_session_metadata_page_with_query(&root, Some("old-cursor"), 5, Some(&query))
            .await
            .unwrap();
        assert_eq!(fallback.sessions[0].session_id, "native");
        assert_eq!(fallback.discovery_warnings.len(), 1);
        assert!(
            fallback.catalog_query.is_none(),
            "an unavailable revision must restart legacy traversal"
        );
        assert_eq!(manager.session_catalog_build_count_for_test().await, 0);
        assert_eq!(manager.list_session_metadata(&root).await.unwrap().len(), 1);
        assert_eq!(
            manager
                .load_session_turns(&root, "native")
                .await
                .unwrap()
                .len(),
            1
        );
        assert_eq!(
            std::fs::read_to_string(root.join(INDEX_FILE)).unwrap(),
            "{broken"
        );
    }
}
