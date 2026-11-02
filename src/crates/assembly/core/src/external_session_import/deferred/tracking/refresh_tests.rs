use super::super::test_io::{Counts, Probe};
use super::super::tests::fixture;
use super::tests::{create_source, publish};
use super::*;
use crate::external_session_import::auto_discovery::tests::{candidate, document};
use openbitfun_product_domains::session_import::ExternalSessionItem;

async fn open_document(
    root: &Path,
    workspace: &WorkspaceInfo,
    entry: &Reference,
    document: ExternalSessionDocument,
) -> OpenBitFunResult<Option<OfflineSessionBundle>> {
    let refreshed = refresh_reference(
        root,
        entry.clone(),
        workspace.clone(),
        workspace.clone(),
        vec![workspace.clone()],
        move |_, _| Ok(document),
    )
    .await?;
    load_current_snapshot(root, &entry.metadata.session_id, refreshed).await
}

#[tokio::test]
async fn unchanged_opens_reuse_snapshot_and_do_not_convert_write_or_notify() {
    let (_temp, workspace, root, _manager) = fixture();
    let entry = create_source(&root, &workspace).await;
    let mut document = document(candidate("codex", "source-1", &workspace.root_path));
    document.candidate.model_provider = Some("source-provider".into());
    document.candidate.model_name = Some("source-model".into());
    document.turns[0].items.extend([
        ExternalSessionItem::Thinking {
            text: "Saved reasoning".into(),
        },
        ExternalSessionItem::Tool {
            id: "saved-call".into(),
            name: "exec_command".into(),
            input: json!({"cmd":"echo saved"}),
            result: Some(json!({"stdout":"saved"})),
            success: Some(true),
        },
    ]);
    let probe = Probe::new(&root);
    let first = open_document(&root, &workspace, &entry, document.clone())
        .await
        .unwrap()
        .unwrap();
    assert_eq!(
        probe.take(),
        Counts {
            source_reads: 1,
            conversions: 1,
            snapshot_writes: 1,
            index_writes: 1,
            catalog_notifications: 1,
            ..Counts::default()
        }
    );
    let index = std::fs::read(root.join(INDEX_FILE)).unwrap();
    let path = snapshot_path(
        &root,
        &entry.metadata.session_id,
        content_version(&first.metadata).unwrap(),
    )
    .unwrap();
    let frozen = std::fs::read(&path).unwrap();
    // Wall-clock changes must not turn conversion-generated timestamps into
    // source changes. The persisted version remains the same on every open.
    tokio::time::sleep(Duration::from_millis(3)).await;
    for _ in 0..5 {
        let reopened = open_document(&root, &workspace, &entry, document.clone())
            .await
            .unwrap()
            .unwrap();
        assert_eq!(
            serde_json::to_value(reopened).unwrap(),
            serde_json::to_value(&first).unwrap()
        );
    }
    assert_eq!(
        probe.take(),
        Counts {
            source_reads: 5,
            ..Counts::default()
        }
    );
    assert_eq!(std::fs::read(root.join(INDEX_FILE)).unwrap(), index);
    assert_eq!(std::fs::read(path).unwrap(), frozen);
}

#[tokio::test]
async fn empty_and_undated_versions_are_stable_on_reopen() {
    for empty in [true, false] {
        let (_temp, workspace, root, _manager) = fixture();
        let entry = create_source(&root, &workspace).await;
        let mut document = document(candidate("codex", "source-1", &workspace.root_path));
        if empty {
            document.turns.clear();
        } else {
            document.turns[0].timestamp = 0;
        }
        let first = open_document(&root, &workspace, &entry, document.clone())
            .await
            .unwrap()
            .unwrap();
        tokio::time::sleep(Duration::from_millis(3)).await;
        let probe = Probe::new(&root);
        let reopened = open_document(&root, &workspace, &entry, document)
            .await
            .unwrap()
            .unwrap();
        assert_eq!(
            serde_json::to_value(reopened).unwrap(),
            serde_json::to_value(first).unwrap()
        );
        assert_eq!(
            probe.take(),
            Counts {
                source_reads: 1,
                ..Counts::default()
            }
        );
    }
}

#[tokio::test]
async fn fresh_source_changes_are_detected_even_when_discovery_fingerprint_is_unchanged() {
    let (_temp, workspace, root, _manager) = fixture();
    let entry = create_source(&root, &workspace).await;
    let original = document(candidate("codex", "source-1", &workspace.root_path));
    let first = open_document(&root, &workspace, &entry, original.clone())
        .await
        .unwrap()
        .unwrap();
    let mut changed = original;
    changed.turns[0].user_text = "An externally rewritten question".into();
    let probe = Probe::new(&root);
    let latest = open_document(&root, &workspace, &entry, changed)
        .await
        .unwrap()
        .unwrap();
    assert_eq!(
        latest.turns[0].user_message.content,
        "An externally rewritten question"
    );
    assert_ne!(
        content_version(&latest.metadata),
        content_version(&first.metadata)
    );
    assert_eq!(
        probe.take(),
        Counts {
            source_reads: 1,
            conversions: 1,
            snapshot_writes: 1,
            index_writes: 1,
            catalog_notifications: 1,
            ..Counts::default()
        }
    );
    let pinned = snapshot_at_turn(&root, &entry.metadata.session_id, &first.turns[0].turn_id)
        .await
        .unwrap()
        .unwrap();
    assert_eq!(
        serde_json::to_value(pinned.turns).unwrap(),
        serde_json::to_value(first.turns).unwrap()
    );
}

#[tokio::test]
async fn unchanged_content_still_updates_source_title_and_availability() {
    let (_temp, workspace, root, _manager) = fixture();
    let entry = create_source(&root, &workspace).await;
    let original = document(candidate("codex", "source-1", &workspace.root_path));
    publish(&root, &workspace, &entry, original.clone()).await;
    let mut renamed = original;
    renamed.candidate.title = Some("Renamed in source".into());
    renamed.candidate.title_is_source_name = true;
    let probe = Probe::new(&root);
    let opened = open_document(&root, &workspace, &entry, renamed.clone())
        .await
        .unwrap()
        .unwrap();
    assert_eq!(opened.metadata.session_name, "Renamed in source");
    assert_eq!(
        probe.take(),
        Counts {
            source_reads: 1,
            index_writes: 1,
            catalog_notifications: 1,
            ..Counts::default()
        }
    );
    for expected_writes in [1, 0] {
        let refreshed = refresh_reference(
            &root,
            entry.clone(),
            workspace.clone(),
            workspace.clone(),
            vec![workspace.clone()],
            |_, _| Err("Source is offline".into()),
        )
        .await
        .unwrap();
        let offline = load_current_snapshot(&root, &entry.metadata.session_id, refreshed)
            .await
            .unwrap()
            .unwrap();
        assert_eq!(
            offline.metadata.custom_metadata.unwrap()["externalSourceStatus"],
            "unavailable"
        );
        assert_eq!(
            probe.take(),
            Counts {
                source_reads: 1,
                index_writes: expected_writes,
                catalog_notifications: expected_writes,
                ..Counts::default()
            }
        );
    }
    let restored = open_document(&root, &workspace, &entry, renamed)
        .await
        .unwrap()
        .unwrap();
    assert_eq!(
        restored.metadata.custom_metadata.unwrap()["externalSourceStatus"],
        "available"
    );
    assert_eq!(
        probe.take(),
        Counts {
            source_reads: 1,
            index_writes: 1,
            catalog_notifications: 1,
            ..Counts::default()
        }
    );
}

#[tokio::test]
async fn malformed_existing_snapshot_is_not_trusted_or_overwritten() {
    let (_temp, workspace, root, _manager) = fixture();
    let entry = create_source(&root, &workspace).await;
    let document = document(candidate("codex", "source-1", &workspace.root_path));
    let first = open_document(&root, &workspace, &entry, document.clone())
        .await
        .unwrap()
        .unwrap();
    let path = snapshot_path(
        &root,
        &entry.metadata.session_id,
        content_version(&first.metadata).unwrap(),
    )
    .unwrap();
    std::fs::write(&path, b"{interrupted snapshot").unwrap();
    let index = std::fs::read(root.join(INDEX_FILE)).unwrap();
    let probe = Probe::new(&root);
    assert!(open_document(&root, &workspace, &entry, document)
        .await
        .is_err());
    assert_eq!(
        probe.take(),
        Counts {
            source_reads: 1,
            snapshot_reads: 1,
            ..Counts::default()
        }
    );
    assert_eq!(std::fs::read(path).unwrap(), b"{interrupted snapshot");
    assert_eq!(std::fs::read(root.join(INDEX_FILE)).unwrap(), index);
}

#[tokio::test]
async fn concurrent_local_changes_and_removal_win_during_an_unchanged_refresh() {
    for remove in [false, true] {
        let (_temp, workspace, root, _manager) = fixture();
        let entry = create_source(&root, &workspace).await;
        let original = document(candidate("codex", "source-1", &workspace.root_path));
        publish(&root, &workspace, &entry, original.clone()).await;
        let (started_tx, started_rx) = tokio::sync::oneshot::channel();
        let (release_tx, release_rx) = std::sync::mpsc::channel();
        let refresh_root = root.clone();
        let refresh_workspace = workspace.clone();
        let refresh_entry = entry.clone();
        let task = tokio::spawn(async move {
            refresh_reference(
                &refresh_root,
                refresh_entry,
                refresh_workspace.clone(),
                refresh_workspace.clone(),
                vec![refresh_workspace],
                move |_, _| {
                    started_tx.send(()).unwrap();
                    release_rx.recv_timeout(Duration::from_secs(5)).unwrap();
                    Ok(original)
                },
            )
            .await
        });
        started_rx.await.unwrap();
        if remove {
            dismiss(&root, &entry.metadata.session_id).await.unwrap();
        } else {
            let mut local = metadata(&root, &entry.metadata.session_id)
                .await
                .unwrap()
                .unwrap();
            local.session_name = "Local name".into();
            local.status = SessionStatus::Archived;
            local.tags = vec!["keep-local-tag".into()];
            save_metadata(&root, &local).await.unwrap();
        }
        let probe = Probe::new(&root);
        release_tx.send(()).unwrap();
        let refreshed = task.await.unwrap().unwrap();
        let current = load_current_snapshot(&root, &entry.metadata.session_id, refreshed)
            .await
            .unwrap();
        if remove {
            assert!(current.is_none());
        } else {
            let current = current.unwrap();
            assert_eq!(current.metadata.session_name, "Local name");
            assert_eq!(current.metadata.status, SessionStatus::Archived);
            assert_eq!(current.metadata.tags, vec!["keep-local-tag"]);
        }
        assert_eq!(probe.take(), Counts::default());
    }
}

#[tokio::test]
async fn legacy_reopens_skip_unchanged_index_writes_but_still_detect_native_edits() {
    let (_temp, workspace, root, _manager) = fixture();
    let mut original = document(candidate("codex", "source-1", &workspace.root_path));
    original.turns[0].timestamp = 0;
    let id = crate::external_session_import::auto_discovery::automatic_session_id(
        &workspace.id,
        "codex",
        "source-1",
    );
    let mut native = convert_document(
        &id,
        &workspace,
        &workspace,
        "primary",
        "Old import",
        &original,
        true,
        true,
    )
    .unwrap();
    let store = OfflineSessionImportStore::new(&root);
    store.write_bundle_atomic(&native).await.unwrap();
    register(
        &root,
        &workspace,
        &workspace,
        vec![original.candidate.clone()],
    )
    .await
    .unwrap();
    let entry = reference(&root, &id).await.unwrap().unwrap();
    publish(&root, &workspace, &entry, original.clone()).await;
    tokio::time::sleep(Duration::from_millis(3)).await;
    let probe = Probe::new(&root);
    open_document(&root, &workspace, &entry, original.clone())
        .await
        .unwrap()
        .unwrap();
    assert_eq!(
        probe.take(),
        Counts {
            source_reads: 1,
            conversions: 1,
            ..Counts::default()
        }
    );
    native.turns[0].user_message.content = "A local edit by an older host".into();
    store.write_bundle(&native).await.unwrap();
    assert!(open_document(&root, &workspace, &entry, original)
        .await
        .unwrap()
        .is_none());
    let saved = store.load_bundle(&id).await.unwrap().unwrap();
    assert_eq!(
        saved.turns[0].user_message.content,
        "A local edit by an older host"
    );
    assert!(
        metadata(&root, &id).await.unwrap().is_none(),
        "The locally edited copy must leave the followed-view metadata path"
    );
}

#[tokio::test]
async fn a_newer_published_version_wins_before_the_refresh_result_is_delivered() {
    let (_temp, workspace, root, _manager) = fixture();
    let entry = create_source(&root, &workspace).await;
    let original = document(candidate("codex", "source-1", &workspace.root_path));
    let first = open_document(&root, &workspace, &entry, original.clone())
        .await
        .unwrap()
        .unwrap();
    let mut next = original;
    let first = snapshot_at_turn_shared(&root, &entry.metadata.session_id, &first.turns[0].turn_id)
        .await
        .unwrap()
        .unwrap();
    next.turns[0].user_text = "Newer refresh".into();
    publish(&root, &workspace, &entry, next).await;
    let probe = Probe::new(&root);
    let current = load_current_snapshot(&root, &entry.metadata.session_id, Some(first))
        .await
        .unwrap()
        .unwrap();
    assert_eq!(current.turns[0].user_message.content, "Newer refresh");
    assert_eq!(probe.take(), Counts::default());
}
