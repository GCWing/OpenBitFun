use super::super::tests::{create_source, publish};
use super::*;
use crate::agentic::persistence::SessionBranchRequest;
use crate::external_session_import::auto_discovery::tests::{candidate, document};
use crate::external_session_import::deferred::tests::fixture;
use crate::service::session::SessionTurnWindowResponse;
use openbitfun_runtime_ports::SessionTurnWindowRequest;
use openbitfun_services_core::session::SessionBranchBoundary;

async fn evict(root: &Path) {
    let mut cache = HISTORIES.lock().await;
    let paths: Vec<_> = cache
        .entries
        .iter()
        .filter(|entry| entry.path.starts_with(root))
        .map(|entry| entry.path.clone())
        .collect();
    for path in paths {
        cache.remove(&path);
    }
}

fn long_document(workspace: &WorkspaceInfo, count: usize) -> ExternalSessionDocument {
    let mut source = document(candidate("codex", "source-1", &workspace.root_path));
    let template = source.turns[0].clone();
    source.turns = (0..count)
        .map(|index| {
            let mut turn = template.clone();
            turn.source_turn_id = format!("source-turn-{index}");
            turn.user_text = format!("Question {index}: {}", "long history ".repeat(120));
            turn
        })
        .collect();
    source
}

#[tokio::test]
async fn history_cache_pages_share_one_cold_read_and_copy_only_requested_turns() {
    let (_temp, workspace, root, manager) = fixture();
    let entry = create_source(&root, &workspace).await;
    let id = &entry.metadata.session_id;
    publish(&root, &workspace, &entry, long_document(&workspace, 240)).await;
    let current = reference(&root, id).await.unwrap().unwrap();
    let path = snapshot_path(&root, id, content_version(&current.metadata).unwrap()).unwrap();
    let bytes = std::fs::read(&path).unwrap();
    let frozen: Snapshot = serde_json::from_slice(&bytes).unwrap();
    let index_before = std::fs::read(root.join(INDEX_FILE)).unwrap();
    evict(&root).await;
    let probe = probes::Probe::new(&root);
    let io = crate::external_session_import::deferred::test_io::Probe::new(&root);
    let tail = manager
        .load_session_tail_turns(&workspace.root_path, id, 5)
        .await
        .unwrap();
    let catalog = manager
        .load_session_turn_catalog(&workspace.root_path, id, &tail, 240)
        .await
        .unwrap();
    assert_eq!(
        catalog,
        crate::agentic::persistence::manager::external_history_catalog(&frozen.bundle)
    );
    assert_eq!(
        serde_json::to_value(&tail).unwrap(),
        serde_json::to_value(&frozen.bundle.turns[235..]).unwrap()
    );
    let targets = [220usize, 120, 0];
    for target in targets {
        let window = manager
            .load_session_turn_window(&SessionTurnWindowRequest {
                workspace_path: workspace.root_path.clone(),
                session_id: id.clone(),
                include_internal: false,
                target_storage_turn_index: target,
                expected_turn_id: Some(frozen.bundle.turns[target].turn_id.clone()),
                expected_catalog_revision: Some(catalog.revision.clone()),
                before: 2,
                after: 3,
            })
            .await
            .unwrap();
        let SessionTurnWindowResponse::Ready {
            turns,
            start_ordinal,
            end_ordinal_exclusive,
            total_turn_count,
            ..
        } = window
        else {
            panic!("expected a ready window");
        };
        assert_eq!(total_turn_count, 240);
        assert_eq!(start_ordinal, target.saturating_sub(2));
        assert_eq!(end_ordinal_exclusive, target + 3);
        assert_eq!(
            serde_json::to_value(turns).unwrap(),
            serde_json::to_value(&frozen.bundle.turns[start_ordinal..end_ordinal_exclusive])
                .unwrap()
        );
    }
    assert_eq!(
        probe.take(),
        probes::Counts {
            snapshot_reads: 1,
            snapshot_bytes: bytes.len() as u64,
            catalog_builds: 1,
            copied_turns: 18
        }
    );
    assert_eq!(
        io.take(),
        crate::external_session_import::deferred::test_io::Counts {
            snapshot_reads: 1,
            ..Default::default()
        }
    );
    assert_eq!(std::fs::read(&path).unwrap(), bytes);
    assert_eq!(std::fs::read(root.join(INDEX_FILE)).unwrap(), index_before);
    assert!(!root.join(id).join("metadata.json").exists());
}

#[tokio::test]
async fn history_cache_keeps_legacy_snapshot_and_window_shapes_readable() {
    let (_temp, workspace, root, manager) = fixture();
    let entry = create_source(&root, &workspace).await;
    let id = &entry.metadata.session_id;
    let version = "a".repeat(64);
    let turn_id = format!("{id}-v{version}-turn-7");
    // Handwritten v1 snapshot: snake-case aliases and no newer optional turn,
    // workspace, last-turn or recovery fields. No current serializer supplies
    // defaults to this compatibility input.
    let legacy = json!({
        "schema_version": 1, "ecosystem_id": "codex", "source_session_id": "source-1", "version": version,
        "bundle": {
            "metadata": {
                "session_id": id, "session_name": "Legacy history", "agent_type": "primary", "model_name": "primary",
                "created_at": 1, "last_active_at": 2, "turn_count": 1, "message_count": 1, "tool_call_count": 0, "status": "completed",
                "custom_metadata": { "externalHistoryMode": "follow", "externalContentVersion": version, "importedFrom": "codex", "sourceSessionId": "source-1" }
            },
            "turns": [{ "turn_id": turn_id, "turn_index": 7, "session_id": id, "timestamp": 1,
                "user_message": { "id": "legacy-message", "content": "Legacy question", "timestamp": 1 },
                "model_rounds": [], "start_time": 1, "status": "completed" }]
        }
    });
    let path = snapshot_path(&root, id, &version).unwrap();
    JsonFileStore
        .write_atomic_strict(&path, &legacy)
        .await
        .unwrap();
    update_index(&root, |index| {
        let metadata = &mut index.entries.get_mut(id).unwrap().metadata;
        metadata.agent_type = "primary".into();
        metadata.custom_metadata.as_mut().unwrap()[VERSION] = json!(version);
        ((), true)
    })
    .await
    .unwrap();
    let bytes = std::fs::read(&path).unwrap();
    let index_bytes = std::fs::read(root.join(INDEX_FILE)).unwrap();
    assert_eq!(
        metadata(&root, id).await.unwrap().unwrap().agent_type,
        "Standard"
    );
    assert_eq!(
        merge_metadata(&root, vec![]).await.unwrap()[0].agent_type,
        "Standard"
    );
    let probe = probes::Probe::new(&root);
    let cold = snapshot_shared(&root, id, false).await.unwrap().unwrap();
    let warm = snapshot_shared(&root, id, false).await.unwrap().unwrap();
    for snapshot in [&cold, &warm] {
        assert_eq!(snapshot.metadata.agent_type, "Standard");
        assert_eq!(snapshot.metadata.model_name, "primary");
    }
    assert!(Arc::ptr_eq(&cold.history, &warm.history));
    assert_eq!(probe.take().snapshot_reads, 1);
    let request = SessionTurnWindowRequest {
        workspace_path: workspace.root_path.clone(),
        session_id: id.clone(),
        include_internal: false,
        target_storage_turn_index: 7,
        expected_turn_id: None,
        expected_catalog_revision: None,
        before: usize::MAX,
        after: 0,
    };
    let first = manager.load_session_turn_window(&request).await.unwrap();
    let second = manager.load_session_turn_window(&request).await.unwrap();
    assert_eq!(
        serde_json::to_value(&first).unwrap(),
        serde_json::to_value(&second).unwrap()
    );
    let SessionTurnWindowResponse::Ready {
        turns,
        catalog_revision,
        total_turn_count,
        ..
    } = first
    else {
        panic!("legacy request must remain readable");
    };
    assert_eq!(turns.len(), 1);
    assert_eq!(turns[0].turn_index, 7);
    assert_eq!(turns[0].user_message.content, "Legacy question");
    assert_eq!(total_turn_count, 1);
    let round_trip: Snapshot = serde_json::from_value(
        serde_json::to_value(serde_json::from_value::<Snapshot>(legacy).unwrap()).unwrap(),
    )
    .unwrap();
    assert_eq!(round_trip.bundle.turns[0].turn_id, turn_id);
    assert_eq!(round_trip.schema_version, 1);
    assert_eq!(std::fs::read(path).unwrap(), bytes);
    let stale = manager
        .load_session_turn_window(&SessionTurnWindowRequest {
            expected_catalog_revision: Some("old-revision".into()),
            ..request.clone()
        })
        .await
        .unwrap();
    assert!(
        matches!(stale, SessionTurnWindowResponse::Stale { catalog } if catalog.revision == catalog_revision)
    );
    let missing = manager
        .load_session_turn_window(&SessionTurnWindowRequest {
            target_storage_turn_index: 8,
            ..request
        })
        .await
        .unwrap();
    assert!(
        matches!(missing, SessionTurnWindowResponse::NotFound { catalog } if catalog.total_turn_count == 1)
    );
    assert_eq!(std::fs::read(root.join(INDEX_FILE)).unwrap(), index_bytes);
}

#[tokio::test]
async fn history_cache_coalesces_concurrent_reads_of_the_same_version() {
    let (_temp, workspace, root, _manager) = fixture();
    let entry = create_source(&root, &workspace).await;
    publish(&root, &workspace, &entry, long_document(&workspace, 80)).await;
    evict(&root).await;
    let probe = probes::Probe::new(&root);
    let (left, right) = tokio::join!(
        snapshot_shared(&root, &entry.metadata.session_id, false),
        snapshot_shared(&root, &entry.metadata.session_id, false)
    );
    let left = left.unwrap().unwrap();
    let right = right.unwrap().unwrap();
    assert!(Arc::ptr_eq(&left.history, &right.history));
    let counts = probe.take();
    assert_eq!(counts.snapshot_reads, 1);
    assert_eq!(counts.catalog_builds, 1);
    assert_eq!(counts.copied_turns, 0);
}

#[tokio::test]
async fn history_cache_unchanged_refresh_shares_body_and_still_reads_source() {
    let (_temp, workspace, root, _manager) = fixture();
    let entry = create_source(&root, &workspace).await;
    let source = long_document(&workspace, 80);
    publish(&root, &workspace, &entry, source.clone()).await;
    let first = snapshot_shared(&root, &entry.metadata.session_id, false)
        .await
        .unwrap()
        .unwrap();
    let probe = probes::Probe::new(&root);
    let io = crate::external_session_import::deferred::test_io::Probe::new(&root);
    let refreshed = refresh_reference(
        &root,
        entry.clone(),
        workspace.clone(),
        workspace.clone(),
        vec![workspace],
        move |_, _| Ok(source),
    )
    .await
    .unwrap();
    let second = load_current_snapshot_shared(&root, &entry.metadata.session_id, refreshed)
        .await
        .unwrap()
        .unwrap();
    assert!(Arc::ptr_eq(&first.history, &second.history));
    assert_eq!(probe.take(), probes::Counts::default());
    assert_eq!(
        io.take(),
        crate::external_session_import::deferred::test_io::Counts {
            source_reads: 1,
            ..Default::default()
        }
    );
    assert_eq!(
        serde_json::to_value(first.turns()).unwrap(),
        serde_json::to_value(second.turns()).unwrap()
    );
}

#[tokio::test]
async fn history_cache_projects_live_metadata_and_preserves_pinned_versions_after_eviction() {
    let (_temp, workspace, root, manager) = fixture();
    let entry = create_source(&root, &workspace).await;
    let id = &entry.metadata.session_id;
    publish(&root, &workspace, &entry, long_document(&workspace, 8)).await;
    let viewed = snapshot_shared(&root, id, false).await.unwrap().unwrap();
    let old_turn = viewed.turns()[5].turn_id.clone();
    let old_revision = viewed.catalog().revision.clone();
    let old_text = viewed.turns()[5].user_message.content.clone();
    let old_path = snapshot_path(&root, id, content_version(&viewed.metadata).unwrap()).unwrap();
    let old_bytes = std::fs::read(&old_path).unwrap();
    publish(&root, &workspace, &entry, long_document(&workspace, 3)).await;
    let mut metadata = super::super::super::metadata(&root, id)
        .await
        .unwrap()
        .unwrap();
    metadata.session_name = "Local rename".into();
    metadata.status = SessionStatus::Archived;
    metadata.tags = vec!["local-tag".into()];
    super::super::super::save_metadata(&root, &metadata)
        .await
        .unwrap();
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
    let pinned = snapshot_at_turn_shared(&root, id, &old_turn)
        .await
        .unwrap()
        .unwrap();
    assert_eq!(pinned.metadata.session_name, "Local rename");
    assert_eq!(pinned.metadata.status, SessionStatus::Archived);
    assert_eq!(pinned.metadata.tags, vec!["local-tag"]);
    assert_eq!(
        pinned.metadata.custom_metadata.as_ref().unwrap()["externalSourceStatus"],
        "unavailable"
    );
    assert!(Arc::ptr_eq(&pinned.history, &viewed.history));
    assert_eq!(pinned.turns().len(), 8);
    evict(&root).await;
    let window = manager
        .load_session_turn_window(&SessionTurnWindowRequest {
            workspace_path: workspace.root_path.clone(),
            session_id: id.clone(),
            include_internal: false,
            target_storage_turn_index: 5,
            expected_turn_id: Some(old_turn.clone()),
            expected_catalog_revision: Some(old_revision),
            before: 0,
            after: 1,
        })
        .await
        .unwrap();
    let SessionTurnWindowResponse::Ready {
        turns,
        total_turn_count,
        ..
    } = window
    else {
        panic!("pinned window must remain readable");
    };
    assert_eq!(total_turn_count, 8);
    assert_eq!(turns[0].user_message.content, old_text);
    // Fork a point absent from the latest source after another cold reload.
    // Exercise native publication as well as selection of the frozen body.
    evict(&root).await;
    let source = manager
        .external_history_branch_source(&workspace.root_path, id, Some(&old_turn))
        .await
        .unwrap()
        .unwrap();
    assert_eq!(source.turns.len(), 8);
    assert_eq!(source.turns[5].user_message.content, old_text);
    let branch = manager
        .branch_transient_session(
            &workspace.root_path,
            &SessionBranchRequest {
                source_session_id: id.clone(),
                source_turn_id: old_turn.clone(),
                boundary: SessionBranchBoundary::ThroughTurn,
            },
            source,
        )
        .await
        .unwrap();
    let native = OfflineSessionImportStore::new(&root)
        .load_bundle(&branch.session_id)
        .await
        .unwrap()
        .unwrap();
    assert_eq!(native.turns.len(), 6);
    assert_eq!(native.turns[5].user_message.content, old_text);
    assert!(!is_followed(&native.metadata));
    assert_ne!(native.metadata.status, SessionStatus::Archived);
    assert_eq!(
        native.metadata.custom_metadata.as_ref().unwrap()["externalBranchOf"]["contentVersion"],
        content_version(&viewed.metadata).unwrap()
    );
    manager
        .assert_native_history_mutation(&workspace.root_path, &branch.session_id)
        .await
        .unwrap();
    assert_eq!(std::fs::read(&old_path).unwrap(), old_bytes);
    super::super::super::dismiss(&root, id).await.unwrap();
    assert!(snapshot_shared(&root, id, false).await.unwrap().is_none());
    assert!(snapshot_at_turn_shared(&root, id, &old_turn)
        .await
        .unwrap()
        .is_none());
    let mut edited = native.turns[5].clone();
    edited.user_message.content = "Independent native edit".into();
    manager
        .save_dialog_turn(&workspace.root_path, &edited)
        .await
        .unwrap();
    assert_eq!(
        manager
            .load_dialog_turn(&workspace.root_path, &branch.session_id, edited.turn_index)
            .await
            .unwrap()
            .unwrap()
            .user_message
            .content,
        "Independent native edit"
    );
    assert_eq!(std::fs::read(&old_path).unwrap(), old_bytes);
}

#[tokio::test]
async fn history_cache_does_not_hide_missing_corrupt_or_foreign_snapshots() {
    let (_temp, workspace, root, _manager) = fixture();
    let entry = create_source(&root, &workspace).await;
    publish(&root, &workspace, &entry, long_document(&workspace, 2)).await;
    let viewed = snapshot_shared(&root, &entry.metadata.session_id, false)
        .await
        .unwrap()
        .unwrap();
    let version = content_version(&viewed.metadata).unwrap();
    let path = snapshot_path(&root, &entry.metadata.session_id, version).unwrap();
    let original = std::fs::read(&path).unwrap();
    std::fs::write(&path, b"{broken snapshot").unwrap();
    assert!(snapshot_shared(&root, &entry.metadata.session_id, false)
        .await
        .is_err());
    assert_eq!(std::fs::read(&path).unwrap(), b"{broken snapshot");
    let mut foreign: Snapshot = serde_json::from_slice(&original).unwrap();
    foreign.source_session_id = "a different source".into();
    JsonFileStore
        .write_atomic_strict(&path, &foreign)
        .await
        .unwrap();
    assert!(snapshot_shared(&root, &entry.metadata.session_id, false)
        .await
        .err()
        .unwrap()
        .to_string()
        .contains("identity"));
    std::fs::write(&path, &original).unwrap();
    assert!(snapshot_shared(&root, &entry.metadata.session_id, false)
        .await
        .unwrap()
        .is_some());
    std::fs::remove_file(&path).unwrap();
    assert!(snapshot_shared(&root, &entry.metadata.session_id, false)
        .await
        .is_err());
}

#[tokio::test]
async fn history_cache_storage_owners_and_source_identity_do_not_alias() {
    let (temp, workspace, root, _manager) = fixture();
    let entry = create_source(&root, &workspace).await;
    publish(&root, &workspace, &entry, long_document(&workspace, 1)).await;
    let first = snapshot_shared(&root, &entry.metadata.session_id, false)
        .await
        .unwrap()
        .unwrap();
    let version = content_version(&first.metadata).unwrap();
    let other_root = temp.path().join("other-owner");
    let other_path = snapshot_path(&other_root, &entry.metadata.session_id, version).unwrap();
    let original_path = snapshot_path(&root, &entry.metadata.session_id, version).unwrap();
    let mut snapshot: Snapshot =
        serde_json::from_slice(&std::fs::read(original_path).unwrap()).unwrap();
    snapshot.bundle.turns[0].user_message.content = "Other owner's history".into();
    JsonFileStore
        .write_atomic_strict(&other_path, &snapshot)
        .await
        .unwrap();
    let other = read(&other_root, &entry, version).await.unwrap();
    assert!(!Arc::ptr_eq(&first.history, &other.history));
    assert_eq!(
        other.turns()[0].user_message.content,
        "Other owner's history"
    );
    assert_ne!(
        first.turns()[0].user_message.content,
        other.turns()[0].user_message.content
    );
    let mut foreign = entry.clone();
    foreign.ecosystem_id = "zcode".into();
    assert!(read(&root, &foreign, version).await.is_err());
}

#[tokio::test]
async fn history_cache_byte_budget_evicts_memory_without_deleting_versions() {
    let (_temp, workspace, root, _manager) = fixture();
    let entry = create_source(&root, &workspace).await;
    publish(&root, &workspace, &entry, long_document(&workspace, 2)).await;
    let first = snapshot_shared(&root, &entry.metadata.session_id, false)
        .await
        .unwrap()
        .unwrap();
    let first_path = snapshot_path(
        &root,
        &entry.metadata.session_id,
        content_version(&first.metadata).unwrap(),
    )
    .unwrap();
    publish(&root, &workspace, &entry, long_document(&workspace, 3)).await;
    let second = snapshot_shared(&root, &entry.metadata.session_id, false)
        .await
        .unwrap()
        .unwrap();
    let second_path = snapshot_path(
        &root,
        &entry.metadata.session_id,
        content_version(&second.metadata).unwrap(),
    )
    .unwrap();
    let budget = second
        .history
        .resident_bytes
        .max(first.history.resident_bytes);
    let mut cache = HistoryCache::default();
    let first_revision = revision(&first_path).await.unwrap();
    let second_revision = revision(&second_path).await.unwrap();
    cache.insert(
        CachedHistory {
            path: first_path.clone(),
            revision: first_revision.clone(),
            history: first.history.clone(),
        },
        budget,
    );
    cache.insert(
        CachedHistory {
            path: second_path.clone(),
            revision: second_revision.clone(),
            history: second.history.clone(),
        },
        budget,
    );
    assert_eq!(cache.entries.len(), 1);
    assert!(cache.get(&first_path, &first_revision).is_none());
    assert!(cache.get(&second_path, &second_revision).is_some());
    assert!(cache.resident_bytes <= budget);
    assert_eq!(
        first.turns().len(),
        2,
        "in-flight readers survive memory eviction"
    );
    cache.insert(
        CachedHistory {
            path: second_path.clone(),
            revision: second_revision,
            history: second.history.clone(),
        },
        1,
    );
    assert!(
        cache.entries.is_empty(),
        "oversize histories remain readable without being retained"
    );
    assert_eq!(second.turns().len(), 3);
    assert!(first_path.exists() && second_path.exists());
    evict(&root).await;
    let probe = probes::Probe::new(&root);
    let owned = second.into_bundle();
    assert_eq!(owned.turns.len(), 3);
    assert_eq!(
        probe.take().copied_turns,
        0,
        "a sole reader must move an evicted body's full history"
    );
}
