//! Immutable source views. Only a fork publishes history into the native store.

use super::*;

mod history_cache;
pub(crate) use history_cache::HistorySnapshot;

#[cfg(test)]
mod refresh_tests;

const MODE: &str = "externalHistoryMode";
const VERSION: &str = "externalContentVersion";
const SNAPSHOTS: &str = ".external-history";

#[derive(Serialize, Deserialize)]
struct Snapshot {
    schema_version: u32,
    ecosystem_id: String,
    source_session_id: String,
    version: String,
    bundle: OfflineSessionBundle,
}

pub(crate) fn is_followed(metadata: &SessionMetadata) -> bool {
    metadata
        .custom_metadata
        .as_ref()
        .is_some_and(|value| value[MODE] == "follow")
}

/// Older hosts can materialize a pending reference into a native copy. Its
/// physical native history takes precedence over optional view-only metadata.
pub(super) fn project_native_metadata(metadata: &mut SessionMetadata) {
    if !is_followed(metadata) {
        return;
    }
    if let Some(custom) = metadata
        .custom_metadata
        .as_mut()
        .and_then(Value::as_object_mut)
    {
        for key in [
            MODE,
            VERSION,
            "externalSourceStatus",
            "externalSourceError",
            "externalObservedFingerprint",
            "externalMaterializedObservation",
            "externalSourceIncomplete",
        ] {
            custom.remove(key);
        }
        custom.insert(PENDING_KEY.into(), json!(false));
        custom.insert("continuationMode".into(), json!("openbitfun_local"));
    }
}

fn content_version(metadata: &SessionMetadata) -> Option<&str> {
    metadata.custom_metadata.as_ref()?.get(VERSION)?.as_str()
}

fn snapshot_path(root: &Path, id: &str, version: &str) -> OpenBitFunResult<PathBuf> {
    openbitfun_core_types::validate_session_id(id).map_err(OpenBitFunError::Validation)?;
    if version.len() != 64 || !version.bytes().all(|byte| byte.is_ascii_hexdigit()) {
        return Err(index_error("Invalid external history version"));
    }
    Ok(root
        .join(SNAPSHOTS)
        .join(id)
        .join(format!("{version}.json")))
}

async fn reference(root: &Path, id: &str) -> OpenBitFunResult<Option<Reference>> {
    Ok(read_index(root)
        .await?
        .entries
        .get(id)
        .filter(|entry| !entry.dismissed && is_followed(&entry.metadata))
        .cloned())
}

fn validate_snapshot(
    snapshot: &Snapshot,
    entry: &Reference,
    version: &str,
) -> OpenBitFunResult<()> {
    if snapshot.schema_version != 1
        || snapshot.version != version
        || snapshot.ecosystem_id != entry.ecosystem_id
        || snapshot.source_session_id != entry.source_session_id
        || snapshot.bundle.metadata.session_id != entry.metadata.session_id
        || content_version(&snapshot.bundle.metadata) != Some(version)
    {
        return Err(index_error(
            "External history snapshot identity does not match its source",
        ));
    }
    Ok(())
}

fn overlay_view_metadata(metadata: &mut SessionMetadata, entry: &Reference) {
    metadata.normalize_legacy_imported_agent_type();
    // Names and archive state belong to the local view, not to a frozen version.
    metadata.session_name = entry.metadata.session_name.clone();
    metadata.tags = entry.metadata.tags.clone();
    metadata.status = entry.metadata.status.clone();
    if let (Some(current), Some(custom)) = (
        entry.metadata.custom_metadata.as_ref(),
        metadata.custom_metadata.as_mut(),
    ) {
        for key in [
            "externalSourceStatus",
            "externalSourceError",
            "externalObservedFingerprint",
        ] {
            if let Some(value) = current.get(key) {
                custom[key] = value.clone();
            }
        }
    }
}

async fn read_snapshot_shared(
    root: &Path,
    entry: &Reference,
    version: &str,
) -> OpenBitFunResult<HistorySnapshot> {
    history_cache::read(root, entry, version).await
}

/// A turn carries its immutable view version. Existing fork requests can pin it
/// without changing their wire shape or accidentally using an unseen update.
pub(crate) async fn snapshot_at_turn(
    root: &Path,
    id: &str,
    turn_id: &str,
) -> OpenBitFunResult<Option<OfflineSessionBundle>> {
    Ok(snapshot_at_turn_shared(root, id, turn_id)
        .await?
        .map(HistorySnapshot::into_bundle))
}

pub(crate) async fn snapshot_at_turn_shared(
    root: &Path,
    id: &str,
    turn_id: &str,
) -> OpenBitFunResult<Option<HistorySnapshot>> {
    let Some(entry) = reference(root, id).await? else {
        return Ok(None);
    };
    let suffix = turn_id.strip_prefix(&format!("{id}-v")).ok_or_else(|| {
        index_error("A followed source must be forked from a viewed history version")
    })?;
    let (version, _) = suffix
        .split_once("-turn-")
        .ok_or_else(|| index_error("Invalid external history fork point"))?;
    let bundle = read_snapshot_shared(root, &entry, version).await?;
    if !bundle.contains_turn(turn_id) {
        return Err(index_error(
            "The fork point does not belong to the viewed external history",
        ));
    }
    Ok(Some(bundle))
}

pub(crate) async fn snapshot(
    root: &Path,
    id: &str,
    refresh: bool,
) -> OpenBitFunResult<Option<OfflineSessionBundle>> {
    Ok(snapshot_shared(root, id, refresh)
        .await?
        .map(HistorySnapshot::into_bundle))
}

pub(crate) async fn snapshot_shared(
    root: &Path,
    id: &str,
    refresh: bool,
) -> OpenBitFunResult<Option<HistorySnapshot>> {
    let Some(entry) = reference(root, id).await? else {
        return Ok(None);
    };
    let refreshed = if refresh || content_version(&entry.metadata).is_none() {
        Box::pin(refresh_source(root, entry)).await?
    } else {
        None
    };
    load_current_snapshot_shared(root, id, refreshed).await
}

#[cfg(test)]
async fn load_current_snapshot(
    root: &Path,
    id: &str,
    refreshed: Option<HistorySnapshot>,
) -> OpenBitFunResult<Option<OfflineSessionBundle>> {
    Ok(load_current_snapshot_shared(root, id, refreshed)
        .await?
        .map(HistorySnapshot::into_bundle))
}

async fn load_current_snapshot_shared(
    root: &Path,
    id: &str,
    refreshed: Option<HistorySnapshot>,
) -> OpenBitFunResult<Option<HistorySnapshot>> {
    let Some(entry) = reference(root, id).await? else {
        return Ok(None);
    };
    let version = content_version(&entry.metadata)
        .ok_or_else(|| index_error("The original source has no readable history snapshot"))?;
    if let Some(mut bundle) = refreshed.filter(|bundle| {
        content_version(&bundle.metadata) == Some(version)
            && bundle.metadata.session_id == entry.metadata.session_id
            && bundle
                .metadata
                .custom_metadata
                .as_ref()
                .is_some_and(|custom| {
                    custom["importedFrom"] == entry.ecosystem_id
                        && custom["sourceSessionId"] == entry.source_session_id
                })
    }) {
        // Recheck the pointer after refreshing: a concurrent remove, rename or
        // newer refresh must still win, as it did when this always reread disk.
        overlay_view_metadata(&mut bundle.metadata, &entry);
        return Ok(Some(bundle));
    }
    Ok(Some(read_snapshot_shared(root, &entry, version).await?))
}

async fn refresh_source(
    root: &Path,
    entry: Reference,
) -> OpenBitFunResult<Option<HistorySnapshot>> {
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
            "Following external history is unavailable for SSH workspaces",
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
    refresh_reference(root, entry, workspace, project, workspaces, |source, id| {
        source.read(id)
    })
    .await
}

async fn cache_unavailable_legacy_history(
    root: &Path,
    entry: &Reference,
) -> OpenBitFunResult<bool> {
    if !super::legacy::follows_native(&entry.metadata) {
        return Ok(false);
    }
    let Some(mut bundle) = OfflineSessionImportStore::new(root)
        .load_bundle(&entry.metadata.session_id)
        .await
        .map_err(index_error)?
    else {
        return Ok(false);
    };
    let id = &entry.metadata.session_id;
    let version = hex::encode(Sha256::digest(
        serde_json::to_vec(&("legacy-cache-v1", &bundle.turns)).map_err(index_error)?,
    ));
    bundle.metadata = metadata(root, id)
        .await?
        .unwrap_or_else(|| entry.metadata.clone());
    bundle
        .metadata
        .custom_metadata
        .get_or_insert_with(|| json!({}))[VERSION] = json!(version);
    for turn in &mut bundle.turns {
        turn.turn_id = format!("{id}-v{version}-turn-{}", turn.turn_index);
        turn.user_message.metadata.get_or_insert_with(|| json!({}))[VERSION] = json!(version);
    }
    let last_active = bundle.metadata.last_active_at;
    let workspace_path = bundle.metadata.workspace_path.clone().unwrap_or_default();
    openbitfun_services_core::session::refresh_session_metadata_from_turns(
        &mut bundle.metadata,
        &workspace_path,
        &bundle.turns,
        last_active,
    );
    let path = snapshot_path(root, id, &version)?;
    JsonFileStore
        .write_atomic_strict(
            &path,
            &Snapshot {
                schema_version: 1,
                ecosystem_id: entry.ecosystem_id.clone(),
                source_session_id: entry.source_session_id.clone(),
                version: version.clone(),
                bundle: bundle.clone(),
            },
        )
        .await
        .map_err(index_error)?;
    #[cfg(test)]
    super::test_io::record(root, |counts| counts.snapshot_writes += 1);
    update_index(root, |index| {
        let Some(current) = index.entries.get_mut(id).filter(|entry| !entry.dismissed) else {
            return ((), false);
        };
        current
            .metadata
            .custom_metadata
            .get_or_insert_with(|| json!({}))[VERSION] = json!(version);
        current.metadata.last_turn = bundle.metadata.last_turn;
        ((), true)
    })
    .await?;
    Ok(true)
}

pub(super) async fn refresh_reference(
    root: &Path,
    entry: Reference,
    workspace: WorkspaceInfo,
    project: WorkspaceInfo,
    workspaces: Vec<WorkspaceInfo>,
    read: impl FnOnce(ImportSource, &str) -> Result<ExternalSessionDocument, String> + Send + 'static,
) -> OpenBitFunResult<Option<HistorySnapshot>> {
    let id = entry.metadata.session_id.clone();
    openbitfun_core_types::validate_session_id(&id).map_err(OpenBitFunError::Validation)?;
    // The source lock is distinct from native Session writers. A snapshot is
    // published before its index pointer, so a crash leaves the old view valid.
    let _lock = JsonFileStore
        .acquire_cross_process_lock(&root.join(SNAPSHOTS).join(&id).join("refresh"))
        .await
        .map_err(index_error)?;
    let entry = reference(root, &id)
        .await?
        .ok_or_else(|| index_error("The external source view is no longer followed"))?;
    let source = ImportSource::from_ecosystem(&entry.ecosystem_id)
        .map_err(|error| index_error(error.detail))?;
    let candidate = entry.candidate_id.clone();
    #[cfg(test)]
    super::test_io::record(root, |counts| counts.source_reads += 1);
    let document = match tokio::task::spawn_blocking(move || read(source, &candidate))
        .await
        .map_err(index_error)?
    {
        Ok(document) => document,
        Err(error) => {
            update_index(root, |index| {
                if let Some(entry) = index.entries.get_mut(&id).filter(|entry| !entry.dismissed) {
                    let custom = entry
                        .metadata
                        .custom_metadata
                        .get_or_insert_with(|| json!({}));
                    let changed = custom["externalSourceStatus"] != "unavailable"
                        || custom["externalSourceError"] != error;
                    custom["externalSourceStatus"] = json!("unavailable");
                    custom["externalSourceError"] = json!(error);
                    ((), changed)
                } else {
                    ((), false)
                }
            })
            .await?;
            if content_version(&entry.metadata).is_some() {
                return Ok(None);
            }
            if cache_unavailable_legacy_history(root, &entry).await? {
                return Ok(None);
            }
            return Err(index_error(format!(
                "The original {} history is unavailable. Restore the source and retry. {error}",
                entry.ecosystem_id
            )));
        }
    };
    if document.candidate.ecosystem_id != entry.ecosystem_id
        || document.candidate.source_session_id != entry.source_session_id
        || !super::super::auto_discovery::belongs_to_workspace(
            &document.candidate,
            &workspace,
            &workspaces,
        )
    {
        return Err(index_error(
            "External history source identity or workspace changed; the cached view was preserved",
        ));
    }
    let version = hex::encode(Sha256::digest(
        serde_json::to_vec(&(source.revision(), &document.turns)).map_err(index_error)?,
    ));
    let path = snapshot_path(root, &id, &version)?;
    // A legacy native copy still needs its unversioned conversion for the
    // local-edit comparison. Never let snapshot reuse bypass that check.
    let mut cached = if !super::legacy::follows_native(&entry.metadata)
        && tokio::fs::try_exists(&path).await.map_err(index_error)?
    {
        Some(read_snapshot_shared(root, &entry, &version).await?)
    } else {
        None
    };
    let mut bundle = if cached.is_some() {
        let metadata = document_metadata(
            &id,
            &workspace,
            &project,
            &entry.metadata.agent_type,
            &entry.metadata.session_name,
            &document,
        )
        .map_err(|error| index_error(error.detail))?;
        // Only metadata changes during an unchanged refresh. Keep the frozen
        // body shared, including when opening a long history at its tail.
        OfflineSessionBundle {
            metadata,
            turns: Vec::new(),
        }
    } else {
        #[cfg(test)]
        super::test_io::record(root, |counts| counts.conversions += 1);
        convert_document(
            &id,
            &workspace,
            &project,
            &entry.metadata.agent_type,
            &entry.metadata.session_name,
            &document,
            true,
            true,
        )
        .map_err(|error| index_error(error.detail))?
    };
    if cached.is_none() && !super::legacy::validate_native(root, &entry, &bundle).await? {
        return Ok(None);
    }
    if cached.is_none() && tokio::fs::try_exists(&path).await.map_err(index_error)? {
        // Legacy comparison above must use freshly converted, unversioned
        // turns. Once it succeeds, use the frozen turns for their synthesized
        // timestamps too; missing source timestamps must not cause index churn.
        cached = Some(read_snapshot_shared(root, &entry, &version).await?);
    }
    if let Some(cached) = cached.as_ref() {
        finish_document_metadata(&mut bundle.metadata, cached.turns());
    }
    if content_version(&entry.metadata) == Some(version.as_str()) {
        // Conversion timestamps are not source changes. Keep the existing
        // version's creation time (and activity time for an empty history).
        bundle.metadata.created_at = entry.metadata.created_at;
        if cached
            .as_ref()
            .map_or(bundle.turns.is_empty(), |cached| cached.turns().is_empty())
        {
            bundle.metadata.last_active_at = entry.metadata.last_active_at;
            bundle.metadata.last_finished_at = entry.metadata.last_finished_at;
        }
    }
    bundle.metadata.tags = entry.metadata.tags.clone();
    bundle.metadata.status = entry.metadata.status.clone();
    let custom = bundle
        .metadata
        .custom_metadata
        .get_or_insert_with(|| json!({}));
    if let Some(previous) = entry
        .metadata
        .custom_metadata
        .as_ref()
        .and_then(Value::as_object)
    {
        for (key, value) in previous {
            if key.starts_with("external") {
                custom[key] = value.clone();
            }
        }
    }
    custom[MODE] = json!("follow");
    custom[VERSION] = json!(version);
    // This is still a reference with no native Session files. Retaining the old
    // pending flag lets an older host open it as an independent native import.
    custom["externalHistoryPending"] = json!(true);
    custom["externalSourceStatus"] = json!("available");
    custom["externalSourceError"] = Value::Null;
    custom["externalMaterializedObservation"] = entry
        .metadata
        .custom_metadata
        .as_ref()
        .and_then(|custom| custom.get("externalObservedFingerprint"))
        .cloned()
        .unwrap_or(Value::Null);
    custom["externalSourceIncomplete"] =
        json!(document.turns.last().is_some_and(|turn| turn.status
            != openbitfun_product_domains::session_import::ExternalSessionStatus::Complete));
    custom["continuationMode"] = json!("fork_before_continue");
    if cached.is_none() {
        for turn in &mut bundle.turns {
            turn.turn_id = format!("{id}-v{version}-turn-{}", turn.turn_index);
            if let Some(metadata) = turn.user_message.metadata.as_mut() {
                metadata[VERSION] = json!(version);
            }
        }
    }
    let last_active = bundle.metadata.last_active_at;
    openbitfun_services_core::session::refresh_session_metadata_from_turns(
        &mut bundle.metadata,
        &workspace.root_path.to_string_lossy(),
        cached
            .as_ref()
            .map_or(bundle.turns.as_slice(), |cached| cached.turns()),
        last_active,
    );
    if let Some(last) = bundle.metadata.last_turn.as_mut() {
        last.recovery_pending = Some(false);
    }
    if cached.is_none() {
        bundle.validate().map_err(index_error)?;
    }
    let mut metadata = bundle.metadata.clone();
    let published = if let Some(cached) = cached {
        cached
    } else if !tokio::fs::try_exists(&path).await.map_err(index_error)? {
        let snapshot = Snapshot {
            schema_version: 1,
            ecosystem_id: entry.ecosystem_id.clone(),
            source_session_id: entry.source_session_id.clone(),
            version: version.clone(),
            bundle,
        };
        JsonFileStore
            .write_atomic_strict(&path, &snapshot)
            .await
            .map_err(index_error)?;
        #[cfg(test)]
        super::test_io::record(root, |counts| counts.snapshot_writes += 1);
        // Publish the validated body while holding the source writer lock.
        history_cache::remember(root, &entry, &version, snapshot.bundle).await?
    } else {
        // Never trust an interrupted or malformed cache merely because it exists.
        read_snapshot_shared(root, &entry, &version).await?
    };
    update_index(root, |index| {
        let Some(current) = index.entries.get_mut(&id).filter(|entry| !entry.dismissed) else {
            return ((), false);
        };
        let before = serde_json::to_value(&*current).ok();
        // Preserve a concurrent rename/archive operation and a newer observation.
        metadata.session_name = current.metadata.session_name.clone();
        metadata.tags = current.metadata.tags.clone();
        metadata.status = current.metadata.status.clone();
        if let Some(custom) = current.metadata.custom_metadata.as_ref() {
            for key in [
                "externalSessionTitleOverride",
                "externalObservedFingerprint",
                "externalLegacyNativeHash",
            ] {
                if let Some(value) = custom.get(key) {
                    metadata.custom_metadata.as_mut().unwrap()[key] = value.clone();
                }
            }
        }
        if document.candidate.title.is_some()
            && (document.candidate.title_is_source_name || current.source_title.is_none())
        {
            current.source_title = document.candidate.title.clone();
        }
        current.fallback_title = document.candidate.fallback_title.clone();
        apply_source_title(
            &mut current.metadata,
            current.source_title.as_deref(),
            current.fallback_title.as_deref(),
        );
        metadata.session_name = current.metadata.session_name.clone();
        if let Some(title) = current
            .metadata
            .custom_metadata
            .as_ref()
            .and_then(|custom| custom.get(SOURCE_TITLE_KEY))
        {
            metadata.custom_metadata.as_mut().unwrap()[SOURCE_TITLE_KEY] = title.clone();
        }
        current.metadata = metadata;
        let changed = before.is_none() || before != serde_json::to_value(&*current).ok();
        ((), changed)
    })
    .await?;
    Ok(Some(published))
}

pub(crate) fn branch_metadata(source: &SessionMetadata, target: &mut SessionMetadata) {
    if !is_followed(source) {
        return;
    }
    let source_custom = source.custom_metadata.as_ref().unwrap();
    let custom = target.custom_metadata.get_or_insert_with(|| json!({}));
    if let Some(custom) = custom.as_object_mut() {
        custom.retain(|key, _| {
            !key.starts_with("external")
                && !key.starts_with("source")
                && key != "importedFrom"
                && key != "continuationMode"
        });
        custom.insert("externalBranchOf".into(), json!({
            "sessionId": source.session_id, "ecosystemId": source_custom["importedFrom"],
            "sourceSessionId": source_custom["sourceSessionId"], "contentVersion": source_custom[VERSION]
        }));
    }
}

#[cfg(test)]
mod tests {
    use super::super::tests::fixture;
    use super::*;
    use crate::agentic::persistence::SessionBranchRequest;
    use crate::external_session_import::auto_discovery::tests::{candidate, document};
    use openbitfun_services_core::session::SessionBranchBoundary;

    pub(super) async fn create_source(root: &Path, workspace: &WorkspaceInfo) -> Reference {
        register(
            root,
            workspace,
            workspace,
            vec![candidate("codex", "source-1", &workspace.root_path)],
        )
        .await
        .unwrap();
        read_index(root)
            .await
            .unwrap()
            .entries
            .values()
            .find(|entry| is_followed(&entry.metadata))
            .unwrap()
            .clone()
    }

    pub(super) async fn publish(
        root: &Path,
        workspace: &WorkspaceInfo,
        entry: &Reference,
        document: ExternalSessionDocument,
    ) {
        refresh_reference(
            root,
            entry.clone(),
            workspace.clone(),
            workspace.clone(),
            vec![workspace.clone()],
            move |_, _| Ok(document),
        )
        .await
        .unwrap();
    }

    #[tokio::test]
    async fn rediscovery_updates_source_activity_without_reading_history() {
        let (_temp, workspace, root, _manager) = fixture();
        let entry = create_source(&root, &workspace).await;
        let mut changed = candidate("codex", "source-1", &workspace.root_path);
        changed.updated_at = Some(42_000);
        changed.status =
            openbitfun_product_domains::session_import::ExternalSessionStatus::Interrupted;
        register(&root, &workspace, &workspace, vec![changed])
            .await
            .unwrap();
        let latest = metadata(&root, &entry.metadata.session_id)
            .await
            .unwrap()
            .unwrap();
        assert_eq!(latest.last_active_at, 42_000);
        assert_eq!(
            latest.custom_metadata.unwrap()["externalSourceIncomplete"],
            true
        );
        assert!(!root.join(SNAPSHOTS).exists());
        assert!(!root.join(&entry.metadata.session_id).exists());
    }

    #[tokio::test]
    async fn legacy_primary_source_snapshots_fork_with_a_valid_mode_without_rewriting_history() {
        let (_temp, workspace, root, manager) = fixture();
        let entry = create_source(&root, &workspace).await;
        assert_eq!(entry.metadata.agent_type, "Standard");
        assert_eq!(entry.metadata.model_name, "primary");
        let id = &entry.metadata.session_id;
        publish(
            &root,
            &workspace,
            &entry,
            document(candidate("codex", "source-1", &workspace.root_path)),
        )
        .await;
        let current = reference(&root, id).await.unwrap().unwrap();
        let version = content_version(&current.metadata).unwrap();
        let path = snapshot_path(&root, id, version).unwrap();
        let mut frozen: Snapshot = JsonFileStore.read_optional(&path).await.unwrap().unwrap();
        // A previous host wrote the model selector into both metadata and turns.
        frozen.bundle.metadata.agent_type = "primary".into();
        frozen.bundle.turns[0].agent_type = Some("primary".into());
        JsonFileStore
            .write_atomic_strict(&path, &frozen)
            .await
            .unwrap();
        update_index(&root, |index| {
            index.entries.get_mut(id).unwrap().metadata.agent_type = "primary".into();
            ((), true)
        })
        .await
        .unwrap();
        let original_history = std::fs::read(&path).unwrap();
        let original_index = std::fs::read(root.join(INDEX_FILE)).unwrap();

        assert_eq!(
            metadata(&root, id).await.unwrap().unwrap().agent_type,
            "Standard"
        );
        assert_eq!(
            merge_metadata(&root, vec![]).await.unwrap()[0].agent_type,
            "Standard"
        );
        let viewed = snapshot(&root, id, false).await.unwrap().unwrap();
        assert_eq!(viewed.metadata.agent_type, "Standard");
        assert_eq!(viewed.metadata.model_name, "primary");
        assert_eq!(viewed.turns[0].agent_type.as_deref(), Some("primary"));
        let branch_source = manager
            .external_history_branch_source(
                &workspace.root_path,
                id,
                Some(&viewed.turns[0].turn_id),
            )
            .await
            .unwrap()
            .unwrap();
        let branch = manager
            .branch_transient_session(
                &workspace.root_path,
                &SessionBranchRequest {
                    source_session_id: id.clone(),
                    source_turn_id: viewed.turns[0].turn_id.clone(),
                    boundary: SessionBranchBoundary::ThroughTurn,
                },
                branch_source,
            )
            .await
            .unwrap();
        assert_eq!(branch.agent_type, "Standard");
        let native = OfflineSessionImportStore::new(&root)
            .load_bundle(&branch.session_id)
            .await
            .unwrap()
            .unwrap();
        assert_eq!(native.metadata.agent_type, "Standard");
        assert_eq!(native.turns[0].agent_type.as_deref(), Some("primary"));
        assert_eq!(native.turns[0].user_message.content, "Saved question");
        assert_eq!(std::fs::read(&path).unwrap(), original_history);
        assert_eq!(
            std::fs::read(root.join(INDEX_FILE)).unwrap(),
            original_index
        );
    }

    #[tokio::test]
    async fn append_rewrite_and_source_loss_preserve_viewed_versions_without_native_copies() {
        let (_temp, workspace, root, manager) = fixture();
        let entry = create_source(&root, &workspace).await;
        let id = &entry.metadata.session_id;
        let first = document(candidate("codex", "source-1", &workspace.root_path));
        publish(&root, &workspace, &entry, first.clone()).await;
        let viewed = snapshot(&root, id, false).await.unwrap().unwrap();
        assert_eq!(viewed.turns.len(), 1);
        assert!(!root.join(id).join("metadata.json").exists());
        let mut appended = first.clone();
        let mut next = first.turns[0].clone();
        next.source_turn_id = "second".into();
        next.user_text = "A new question".into();
        appended.turns.push(next);
        publish(&root, &workspace, &entry, appended).await;
        assert_eq!(
            snapshot(&root, id, false)
                .await
                .unwrap()
                .unwrap()
                .turns
                .len(),
            2
        );
        let pinned = snapshot_at_turn(&root, id, &viewed.turns[0].turn_id)
            .await
            .unwrap()
            .unwrap();
        assert_eq!(
            pinned.turns.len(),
            1,
            "forks use the view, not a later append"
        );
        let mut rewritten = first;
        rewritten.turns[0].user_text = "Rewritten source".into();
        publish(&root, &workspace, &entry, rewritten).await;
        let latest = manager
            .load_session_turns(&workspace.root_path, id)
            .await
            .unwrap();
        assert_eq!(latest.len(), 1);
        assert_eq!(latest[0].user_message.content, "Rewritten source");
        assert_eq!(
            snapshot_at_turn(&root, id, &viewed.turns[0].turn_id)
                .await
                .unwrap()
                .unwrap()
                .turns[0]
                .user_message
                .content,
            "Saved question"
        );
        refresh_reference(
            &root,
            entry.clone(),
            workspace.clone(),
            workspace.clone(),
            vec![workspace.clone()],
            |_, _| Err("Source is offline".into()),
        )
        .await
        .unwrap();
        let cached = snapshot(&root, id, false).await.unwrap().unwrap();
        assert_eq!(cached.turns[0].user_message.content, "Rewritten source");
        assert_eq!(
            cached.metadata.custom_metadata.unwrap()["externalSourceStatus"],
            "unavailable"
        );
        assert!(!root.join(id).join("metadata.json").exists());
    }

    #[tokio::test]
    async fn fork_is_native_and_immutable_while_source_continues_and_rejects_writes() {
        let (_temp, workspace, root, manager) = fixture();
        let entry = create_source(&root, &workspace).await;
        let id = &entry.metadata.session_id;
        let first = document(candidate("codex", "source-1", &workspace.root_path));
        publish(&root, &workspace, &entry, first.clone()).await;
        let viewed = snapshot(&root, id, false).await.unwrap().unwrap();
        let turn_id = viewed.turns[0].turn_id.clone();
        let mut latest = first;
        latest.turns[0].user_text = "Later source content".into();
        publish(&root, &workspace, &entry, latest).await;
        let branch_source = manager
            .external_history_branch_source(&workspace.root_path, id, Some(&turn_id))
            .await
            .unwrap()
            .unwrap();
        let branch = manager
            .branch_transient_session(
                &workspace.root_path,
                &SessionBranchRequest {
                    source_session_id: id.clone(),
                    source_turn_id: turn_id,
                    boundary: SessionBranchBoundary::ThroughTurn,
                },
                branch_source,
            )
            .await
            .unwrap();
        let native = OfflineSessionImportStore::new(&root)
            .load_bundle(&branch.session_id)
            .await
            .unwrap()
            .unwrap();
        assert_eq!(native.turns[0].user_message.content, "Saved question");
        let custom = native.metadata.custom_metadata.as_ref().unwrap();
        assert_eq!(custom["externalBranchOf"]["sessionId"], *id);
        assert!(custom.get("importedFrom").is_none());
        assert!(!is_followed(&native.metadata));
        assert!(manager
            .assert_relay_history_supported(&workspace.root_path, id)
            .await
            .unwrap_err()
            .to_string()
            .contains("Relay is not supported"));
        manager
            .assert_relay_history_supported(&workspace.root_path, &branch.session_id)
            .await
            .unwrap();
        assert_eq!(
            native.turns[0].user_message.metadata.as_ref().unwrap()["importedFrom"],
            "codex"
        );
        assert!(manager
            .save_dialog_turn(&workspace.root_path, &viewed.turns[0])
            .await
            .unwrap_err()
            .to_string()
            .contains("read-only"));
        assert!(manager
            .delete_dialog_turns_from(&workspace.root_path, id, 0)
            .await
            .is_err());
        assert!(!root.join(id).join("metadata.json").exists());
        assert_eq!(
            merge_metadata(&root, vec![native.metadata])
                .await
                .unwrap()
                .len(),
            2
        );
    }

    #[tokio::test]
    async fn history_catalog_and_paging_stay_on_the_viewed_version() {
        use crate::service::session::SessionTurnWindowResponse;
        use openbitfun_runtime_ports::SessionTurnWindowRequest;
        let (_temp, workspace, root, manager) = fixture();
        let entry = create_source(&root, &workspace).await;
        let id = &entry.metadata.session_id;
        let first = document(candidate("codex", "source-1", &workspace.root_path));
        publish(&root, &workspace, &entry, first.clone()).await;
        let viewed = snapshot(&root, id, false).await.unwrap().unwrap();
        let mut rewritten = first;
        rewritten.turns[0].user_text = "An unseen rewrite".into();
        publish(&root, &workspace, &entry, rewritten).await;
        let catalog = manager
            .load_session_turn_catalog(&workspace.root_path, id, &viewed.turns, 1)
            .await
            .unwrap();
        assert_eq!(
            catalog.entries[0].turn_id.as_deref(),
            Some(viewed.turns[0].turn_id.as_str())
        );
        let window = manager
            .load_session_turn_window(&SessionTurnWindowRequest {
                workspace_path: workspace.root_path.clone(),
                session_id: id.clone(),
                include_internal: false,
                target_storage_turn_index: viewed.turns[0].turn_index,
                expected_turn_id: Some(viewed.turns[0].turn_id.clone()),
                expected_catalog_revision: Some(catalog.revision),
                before: 0,
                after: 1,
            })
            .await
            .unwrap();
        let SessionTurnWindowResponse::Ready { turns, .. } = window else {
            panic!("Viewed version must remain pageable")
        };
        assert_eq!(turns[0].user_message.content, "Saved question");
    }

    #[tokio::test]
    async fn legacy_automatic_import_reuses_one_row_and_preserves_native_files() {
        let (_temp, workspace, root, manager) = fixture();
        let original = document(candidate("codex", "source-1", &workspace.root_path));
        let id = super::super::super::auto_discovery::automatic_session_id(
            &workspace.id,
            "codex",
            "source-1",
        );
        let native = convert_document(
            &id, &workspace, &workspace, "primary", "Original", &original, true, true,
        )
        .unwrap();
        let store = OfflineSessionImportStore::new(&root);
        store.write_bundle_atomic(&native).await.unwrap();
        assert_eq!(
            register(
                &root,
                &workspace,
                &workspace,
                vec![original.candidate.clone()]
            )
            .await
            .unwrap(),
            0
        );
        let entry = read_index(&root).await.unwrap().entries[&id].clone();
        // Simulate the duplicate source reference published by the previous build.
        let mut duplicate = entry.clone();
        duplicate.metadata.session_id = format!("external-{id}");
        duplicate.metadata.custom_metadata.as_mut().unwrap()["externalLegacyNative"] = json!(false);
        update_index(&root, |index| {
            index
                .entries
                .insert(duplicate.metadata.session_id.clone(), duplicate);
            ((), true)
        })
        .await
        .unwrap();
        register(
            &root,
            &workspace,
            &workspace,
            vec![original.candidate.clone()],
        )
        .await
        .unwrap();
        let rows = merge_metadata(&root, vec![native.metadata.clone()])
            .await
            .unwrap();
        assert_eq!(rows.len(), 1);
        assert_eq!(rows[0].session_id, id);
        assert!(is_followed(&rows[0]));
        let mut old_branch = SessionMetadata::new(
            "branch".into(),
            "Branch".into(),
            "primary".into(),
            "primary".into(),
        );
        old_branch.custom_metadata = Some(
            json!({ "externalBranchOf": { "sessionId": format!("external-{id}"), "contentVersion": "older-view" } }),
        );
        let projected = merge_metadata(&root, vec![native.metadata.clone(), old_branch])
            .await
            .unwrap();
        assert_eq!(
            projected
                .iter()
                .find(|row| row.session_id == "branch")
                .unwrap()
                .custom_metadata
                .as_ref()
                .unwrap()["externalBranchOf"]["sessionId"],
            id
        );
        assert!(
            !root.join(SNAPSHOTS).exists(),
            "Discovery must not read/copy history"
        );
        publish(&root, &workspace, &entry, original.clone()).await;
        let viewed = snapshot(&root, &id, false).await.unwrap().unwrap();
        assert!(viewed.turns[0].turn_id.contains("-v"));
        assert!(manager
            .external_history_branch_source(
                &workspace.root_path,
                &id,
                Some(&viewed.turns[0].turn_id)
            )
            .await
            .unwrap()
            .is_some());
        assert!(manager
            .assert_native_history_mutation(&workspace.root_path, &id)
            .await
            .is_err());
        let mut updated = original;
        updated.turns[0].user_text = "Source was rewritten".into();
        publish(&root, &workspace, &entry, updated).await;
        assert_eq!(
            snapshot(&root, &id, false).await.unwrap().unwrap().turns[0]
                .user_message
                .content,
            "Source was rewritten"
        );
        assert_eq!(
            serde_json::to_value(store.load_bundle(&id).await.unwrap().unwrap().turns).unwrap(),
            serde_json::to_value(native.turns).unwrap()
        );
        assert_eq!(
            merge_metadata(&root, vec![native.metadata])
                .await
                .unwrap()
                .len(),
            1
        );
    }

    #[tokio::test]
    async fn legacy_cache_survives_first_open_offline_and_deletion_dismisses_aliases() {
        for ecosystem in ["codex", "zcode"] {
            let (_temp, workspace, root, manager) = fixture();
            let original = document(candidate(ecosystem, "source-1", &workspace.root_path));
            let id = super::super::super::auto_discovery::automatic_session_id(
                &workspace.id,
                ecosystem,
                "source-1",
            );
            let native = convert_document(
                &id, &workspace, &workspace, "primary", "Original", &original, true, true,
            )
            .unwrap();
            OfflineSessionImportStore::new(&root)
                .write_bundle_atomic(&native)
                .await
                .unwrap();
            register(
                &root,
                &workspace,
                &workspace,
                vec![original.candidate.clone()],
            )
            .await
            .unwrap();
            let entry = read_index(&root).await.unwrap().entries[&id].clone();
            let mut alias = entry.clone();
            alias.metadata.session_id = format!("external-{id}");
            alias.metadata.custom_metadata.as_mut().unwrap()["externalLegacyNative"] = json!(false);
            update_index(&root, |index| {
                index
                    .entries
                    .insert(alias.metadata.session_id.clone(), alias);
                ((), true)
            })
            .await
            .unwrap();
            register(
                &root,
                &workspace,
                &workspace,
                vec![original.candidate.clone()],
            )
            .await
            .unwrap();
            refresh_reference(
                &root,
                entry.clone(),
                workspace.clone(),
                workspace.clone(),
                vec![workspace.clone()],
                |_, _| Err("Source offline".into()),
            )
            .await
            .unwrap();
            let cached = snapshot(&root, &id, false).await.unwrap().unwrap();
            assert_eq!(cached.turns[0].user_message.content, "Saved question");
            assert_eq!(
                cached.metadata.custom_metadata.unwrap()["externalSourceStatus"],
                "unavailable"
            );
            // Recovering the source reuses the same row; an offline cache was
            // never mistaken for proof that a native copy is unedited.
            publish(&root, &workspace, &entry, original.clone()).await;
            assert_eq!(
                merge_metadata(&root, vec![native.metadata])
                    .await
                    .unwrap()
                    .len(),
                1
            );
            manager
                .delete_session(&workspace.root_path, &id)
                .await
                .unwrap();
            register(&root, &workspace, &workspace, vec![original.candidate])
                .await
                .unwrap();
            assert!(merge_metadata(&root, vec![]).await.unwrap().is_empty());
            assert!(read_index(&root)
                .await
                .unwrap()
                .entries
                .values()
                .all(|entry| entry.dismissed));
        }
    }

    #[tokio::test]
    async fn older_host_native_materialization_remains_independent_after_upgrade() {
        let (_temp, workspace, root, manager) = fixture();
        let entry = create_source(&root, &workspace).await;
        let id = &entry.metadata.session_id;
        let original = document(candidate("codex", "source-1", &workspace.root_path));
        publish(&root, &workspace, &entry, original.clone()).await;
        let mut old_native = snapshot(&root, id, false).await.unwrap().unwrap();
        assert!(
            is_deferred(&old_native.metadata),
            "Older hosts must still see an unmaterialized reference"
        );
        // The old writer retains unknown metadata while publishing native files.
        old_native.metadata.custom_metadata.as_mut().unwrap()[PENDING_KEY] = json!(false);
        old_native.turns[0].user_message.content = "Edited by an older host".into();
        OfflineSessionImportStore::new(&root)
            .write_bundle_atomic(&old_native)
            .await
            .unwrap();
        assert_eq!(
            manager
                .load_session_tail_turns(&workspace.root_path, id, 1)
                .await
                .unwrap()[0]
                .user_message
                .content,
            "Edited by an older host"
        );
        assert_eq!(
            manager
                .load_dialog_turn(&workspace.root_path, id, old_native.turns[0].turn_index)
                .await
                .unwrap()
                .unwrap()
                .user_message
                .content,
            "Edited by an older host"
        );
        let projected = manager
            .load_session_metadata(&workspace.root_path, id)
            .await
            .unwrap()
            .unwrap();
        assert!(!is_followed(&projected));
        manager
            .assert_native_history_mutation(&workspace.root_path, id)
            .await
            .unwrap();
        assert!(manager
            .external_history_branch_source(&workspace.root_path, id, None)
            .await
            .unwrap()
            .is_none());
        assert_eq!(
            register(
                &root,
                &workspace,
                &workspace,
                vec![original.candidate.clone()]
            )
            .await
            .unwrap(),
            0
        );
        // Discovery stays metadata-only. Opening recognizes the existing edit
        // and only then exposes the independent native history alongside its source.
        assert_eq!(
            merge_metadata(&root, vec![old_native.metadata.clone()])
                .await
                .unwrap()
                .len(),
            1
        );
        publish(&root, &workspace, &entry, original.clone()).await;
        let rows = merge_metadata(&root, vec![old_native.metadata])
            .await
            .unwrap();
        assert_eq!(rows.len(), 2);
        assert_eq!(rows.iter().filter(|row| is_followed(row)).count(), 1);
        assert!(rows
            .iter()
            .any(|row| row.session_id == *id && !is_followed(row)));
        assert_eq!(
            manager
                .load_session_turns(&workspace.root_path, id)
                .await
                .unwrap()[0]
                .user_message
                .content,
            "Edited by an older host"
        );
        let followed_id = rows
            .iter()
            .find(|row| is_followed(row))
            .unwrap()
            .session_id
            .clone();
        manager
            .delete_session(&workspace.root_path, id)
            .await
            .unwrap();
        let index = read_index(&root).await.unwrap();
        assert!(index.entries[id].dismissed);
        assert!(!is_followed(&index.entries[id].metadata));
        let mut updated = original.candidate;
        updated.fingerprint = "after-old-copy-deletion".into();
        register(&root, &workspace, &workspace, vec![updated])
            .await
            .unwrap();
        let followed = metadata(&root, &followed_id).await.unwrap().unwrap();
        assert_eq!(
            followed.custom_metadata.unwrap()["externalObservedFingerprint"],
            "after-old-copy-deletion"
        );
    }

    #[tokio::test]
    async fn renamed_archived_and_dismissed_sources_keep_local_intent() {
        let (_temp, workspace, root, _manager) = fixture();
        let entry = create_source(&root, &workspace).await;
        let first = document(candidate("codex", "source-1", &workspace.root_path));
        publish(&root, &workspace, &entry, first.clone()).await;
        let mut metadata = metadata(&root, &entry.metadata.session_id)
            .await
            .unwrap()
            .unwrap();
        metadata.session_name = "My source name".into();
        metadata.status = SessionStatus::Archived;
        save_metadata(&root, &metadata).await.unwrap();
        publish(&root, &workspace, &entry, first).await;
        let cached = snapshot(&root, &metadata.session_id, false)
            .await
            .unwrap()
            .unwrap();
        assert_eq!(cached.metadata.session_name, "My source name");
        assert_eq!(cached.metadata.status, SessionStatus::Archived);
        dismiss(&root, &metadata.session_id).await.unwrap();
        register(
            &root,
            &workspace,
            &workspace,
            vec![candidate("codex", "source-1", &workspace.root_path)],
        )
        .await
        .unwrap();
        assert!(merge_metadata(&root, vec![]).await.unwrap().is_empty());
        assert!(snapshot(&root, &metadata.session_id, false)
            .await
            .unwrap()
            .is_none());
    }

    #[tokio::test]
    async fn removed_source_restores_the_same_view_without_changing_native_branches() {
        let (_temp, workspace, root, manager) = fixture();
        let entry = create_source(&root, &workspace).await;
        let id = &entry.metadata.session_id;
        let original = document(candidate("codex", "source-1", &workspace.root_path));
        publish(&root, &workspace, &entry, original.clone()).await;
        let viewed = snapshot(&root, id, false).await.unwrap().unwrap();
        let turn_id = viewed.turns[0].turn_id.clone();
        let branch_source = manager
            .external_history_branch_source(&workspace.root_path, id, Some(&turn_id))
            .await
            .unwrap()
            .unwrap();
        let branch = manager
            .branch_transient_session(
                &workspace.root_path,
                &SessionBranchRequest {
                    source_session_id: id.clone(),
                    source_turn_id: turn_id,
                    boundary: SessionBranchBoundary::ThroughTurn,
                },
                branch_source,
            )
            .await
            .unwrap();
        let branch_path = root.join(&branch.session_id).join("metadata.json");
        let branch_before = tokio::fs::read(&branch_path).await.unwrap();

        manager
            .update_session_metadata(&workspace.root_path, id, |metadata| {
                metadata.session_name = "My source name".into();
                metadata.status = SessionStatus::Archived;
            })
            .await
            .unwrap();
        publish(&root, &workspace, &entry, original.clone()).await;
        assert_eq!(
            metadata(&root, id).await.unwrap().unwrap().status,
            SessionStatus::Archived
        );
        assert_eq!(tokio::fs::read(&branch_path).await.unwrap(), branch_before);

        manager
            .delete_session(&workspace.root_path, id)
            .await
            .unwrap();
        register(
            &root,
            &workspace,
            &workspace,
            vec![original.candidate.clone()],
        )
        .await
        .unwrap();
        assert!(metadata(&root, id).await.unwrap().is_none());
        let removed = removed_metadata(&root, &workspace.id, "codex")
            .await
            .unwrap();
        assert_eq!(removed.len(), 1);
        assert_eq!(removed[0].session_id, *id);
        assert_eq!(tokio::fs::read(&branch_path).await.unwrap(), branch_before);
        assert_eq!(
            manager
                .load_session_turns(&workspace.root_path, &branch.session_id)
                .await
                .unwrap()[0]
                .user_message
                .content,
            "Saved question"
        );

        manager
            .restore_external_session_reference(&workspace.root_path, &workspace.id, "codex", id)
            .await
            .unwrap();
        register(&root, &workspace, &workspace, vec![original.candidate])
            .await
            .unwrap();
        let restored = snapshot(&root, id, false).await.unwrap().unwrap();
        assert_eq!(restored.metadata.session_name, "My source name");
        assert_eq!(restored.metadata.status, SessionStatus::Active);
        assert_eq!(restored.turns[0].turn_id, viewed.turns[0].turn_id);
        assert!(removed_metadata(&root, &workspace.id, "codex")
            .await
            .unwrap()
            .is_empty());
        assert!(!root.join(id).join("metadata.json").exists());
        assert_eq!(tokio::fs::read(&branch_path).await.unwrap(), branch_before);

        manager
            .update_session_metadata(&workspace.root_path, &branch.session_id, |metadata| {
                metadata.status = SessionStatus::Archived;
            })
            .await
            .unwrap();
        assert_eq!(
            metadata(&root, id).await.unwrap().unwrap().status,
            SessionStatus::Active
        );
        manager
            .delete_session(&workspace.root_path, &branch.session_id)
            .await
            .unwrap();
        assert_eq!(
            snapshot(&root, id, false).await.unwrap().unwrap().turns[0].turn_id,
            viewed.turns[0].turn_id
        );
        assert!(removed_metadata(&root, &workspace.id, "codex")
            .await
            .unwrap()
            .is_empty());
    }

    #[tokio::test]
    async fn restored_reference_is_idempotent_owned_and_preserves_legacy_aliases() {
        let (_temp, workspace, root, _manager) = fixture();
        let entry = create_source(&root, &workspace).await;
        let id = &entry.metadata.session_id;
        let mut alias = entry.clone();
        alias.metadata.session_id = format!("alias-{id}");
        alias.metadata.custom_metadata.as_mut().unwrap()["externalHistoryAliasOf"] = json!(id);
        alias.dismissed = true;
        update_index(&root, |index| {
            index
                .entries
                .insert(alias.metadata.session_id.clone(), alias);
            ((), true)
        })
        .await
        .unwrap();
        dismiss(&root, id).await.unwrap();
        assert!(restore_reference(&root, "another-workspace", "codex", id)
            .await
            .is_err());
        assert!(restore_reference(&root, &workspace.id, "zcode", id)
            .await
            .is_err());
        assert!(metadata(&root, id).await.unwrap().is_none());
        assert_eq!(
            removed_metadata(&root, &workspace.id, "codex")
                .await
                .unwrap()
                .len(),
            1
        );
        restore_reference(&root, &workspace.id, "codex", id)
            .await
            .unwrap();
        let mut archived = metadata(&root, id).await.unwrap().unwrap();
        archived.status = SessionStatus::Archived;
        save_metadata(&root, &archived).await.unwrap();
        restore_reference(&root, &workspace.id, "codex", id)
            .await
            .unwrap();
        assert_eq!(
            metadata(&root, id).await.unwrap().unwrap().status,
            SessionStatus::Archived
        );
        let mut updated = candidate("codex", "source-1", &workspace.root_path);
        updated.fingerprint = "after-restoring".into();
        register(&root, &workspace, &workspace, vec![updated])
            .await
            .unwrap();
        let visible = merge_metadata(&root, vec![]).await.unwrap();
        assert_eq!(visible.len(), 1);
        assert_eq!(visible[0].session_id, *id);
        assert_eq!(
            visible[0].custom_metadata.as_ref().unwrap()["externalObservedFingerprint"],
            "after-restoring"
        );
        assert!(read_index(&root)
            .await
            .unwrap()
            .entries
            .values()
            .all(|entry| !entry.dismissed));
    }

    #[tokio::test]
    async fn legacy_native_import_remains_independent_and_source_gets_its_own_view() {
        let (_temp, workspace, root, _manager) = fixture();
        let document = document(candidate("codex", "source-1", &workspace.root_path));
        let mut native = convert_document(
            "old-import",
            &workspace,
            &workspace,
            "primary",
            "Old copy",
            &document,
            true,
            true,
        )
        .unwrap();
        native.turns[0].user_message.content = "Locally edited".into();
        let store = OfflineSessionImportStore::new(&root);
        store.write_bundle_atomic(&native).await.unwrap();
        let entry = create_source(&root, &workspace).await;
        assert_ne!(entry.metadata.session_id, "old-import");
        publish(&root, &workspace, &entry, document).await;
        assert_eq!(
            store
                .load_bundle("old-import")
                .await
                .unwrap()
                .unwrap()
                .turns[0]
                .user_message
                .content,
            "Locally edited"
        );
        let legacy = serde_json::to_value(&native.metadata).unwrap();
        assert!(!is_followed(
            &serde_json::from_value::<SessionMetadata>(legacy.clone()).unwrap()
        ));
        assert_eq!(
            serde_json::to_value(
                serde_json::from_value::<SessionMetadata>(legacy.clone()).unwrap()
            )
            .unwrap(),
            legacy
        );
        dismiss(&root, "old-import").await.unwrap();
        assert!(snapshot(&root, &entry.metadata.session_id, false)
            .await
            .unwrap()
            .is_some());
    }

    #[tokio::test]
    async fn foreign_identity_and_invalid_fork_versions_cannot_replace_or_escape_cache() {
        let (_temp, workspace, root, _manager) = fixture();
        let entry = create_source(&root, &workspace).await;
        let id = &entry.metadata.session_id;
        let first = document(candidate("codex", "source-1", &workspace.root_path));
        publish(&root, &workspace, &entry, first).await;
        let foreign = document(candidate("codex", "other-source", &workspace.root_path));
        assert!(refresh_reference(
            &root,
            entry.clone(),
            workspace.clone(),
            workspace.clone(),
            vec![workspace.clone()],
            move |_, _| Ok(foreign)
        )
        .await
        .is_err());
        assert!(
            snapshot_at_turn(&root, id, &format!("{id}-v../../outside-turn-0"))
                .await
                .is_err()
        );
        assert!(snapshot_at_turn(&root, id, "legacy-unversioned-turn")
            .await
            .is_err());
        assert_eq!(
            snapshot(&root, id, false).await.unwrap().unwrap().turns[0]
                .user_message
                .content,
            "Saved question"
        );
    }
}
