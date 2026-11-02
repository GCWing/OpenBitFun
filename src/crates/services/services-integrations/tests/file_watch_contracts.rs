#![cfg(feature = "file-watch")]

use openbitfun_events::EventEmitter;
use openbitfun_services_integrations::file_watch::{
    FileWatchEventKind, FileWatchService, FileWatcherConfig, FILE_WATCH_STATUS_CHANGED_EVENT,
};
use std::fs;
use std::sync::Arc;
use std::time::Duration;

/// Records product events so a contract test can assert what surfaces receive.
struct RecordingEmitter {
    events: tokio::sync::mpsc::UnboundedSender<(String, serde_json::Value)>,
}

#[async_trait::async_trait]
impl EventEmitter for RecordingEmitter {
    async fn emit(&self, event_name: &str, payload: serde_json::Value) -> anyhow::Result<()> {
        let _ = self.events.send((event_name.to_string(), payload));
        Ok(())
    }
}

#[tokio::test]
async fn file_watch_status_reaches_product_events() {
    let temp = tempfile::tempdir().expect("tempdir");
    let root = temp.path().join("watched");
    fs::create_dir_all(&root).expect("watched root");
    let mut config = FileWatcherConfig::default();
    config.debounce_interval_ms = 0;
    let service = FileWatchService::new(config.clone());
    let (events_tx, mut events_rx) = tokio::sync::mpsc::unbounded_channel();
    service
        .set_emitter(Arc::new(RecordingEmitter { events: events_tx }))
        .await;

    service
        .watch_path(&root.to_string_lossy(), Some(config))
        .await
        .expect("initial watch");

    let (event_name, healthy) = next_status(&mut events_rx).await;
    assert_eq!(event_name, FILE_WATCH_STATUS_CHANGED_EVENT);
    assert_eq!(healthy["healthy"], true);
    assert_eq!(healthy["failure"], serde_json::Value::Null);
    assert_eq!(healthy["watchedPaths"].as_array().map(Vec::len), Some(1));

    // A watched root that disappears is a real backend failure, not a test hook.
    fs::remove_dir_all(&root).expect("remove watched root");
    service.rebuild_watcher().await.expect_err("missing root");

    let (event_name, failed) = next_status(&mut events_rx).await;
    assert_eq!(event_name, FILE_WATCH_STATUS_CHANGED_EVENT);
    assert_eq!(failed["healthy"], false);
    assert_eq!(failed["failure"]["code"], "backend_unavailable");
    assert_eq!(failed["failure"]["hint"], serde_json::Value::Null);
    assert_eq!(failed["failure"]["path"], root.to_string_lossy().as_ref());

    fs::create_dir_all(&root).expect("recreate watched root");
    service
        .rebuild_watcher()
        .await
        .expect("rebuild after recovery");

    let (_, recovered) = next_status(&mut events_rx).await;
    assert_eq!(recovered["healthy"], true);
    assert_eq!(recovered["failure"], serde_json::Value::Null);
}

async fn next_status(
    events: &mut tokio::sync::mpsc::UnboundedReceiver<(String, serde_json::Value)>,
) -> (String, serde_json::Value) {
    loop {
        let (event_name, payload) = tokio::time::timeout(Duration::from_secs(5), events.recv())
            .await
            .expect("status event")
            .expect("emitter channel open");
        if event_name == FILE_WATCH_STATUS_CHANGED_EVENT {
            return (event_name, payload);
        }
    }
}

#[tokio::test]
async fn file_watch_preserves_missing_path_error() {
    let service = FileWatchService::new(FileWatcherConfig::default());

    let error = service
        .watch_path(
            "__openbitfun_missing_watch_path_for_services_integrations_test__",
            None,
        )
        .await
        .expect_err("missing paths should keep the existing error contract");

    assert_eq!(error, "Path does not exist");
}

#[test]
fn file_watch_event_kind_serializes_snake_case() {
    let value = serde_json::to_value(FileWatchEventKind::Modify).expect("serialize event kind");

    assert_eq!(value, "modify");
}

#[test]
fn file_watch_worker_does_not_extend_tokio_runtime_lifetime() {
    let temp = tempfile::tempdir().expect("tempdir");
    let service = Arc::new(FileWatchService::new(FileWatcherConfig::default()));
    let worker_service = service.clone();
    let watched_path = temp.path().to_string_lossy().into_owned();
    let (finished_tx, finished_rx) = std::sync::mpsc::sync_channel(1);

    let runtime_owner = std::thread::spawn(move || {
        let runtime = tokio::runtime::Builder::new_current_thread()
            .enable_all()
            .build()
            .expect("test runtime");
        runtime.block_on(async move {
            worker_service
                .watch_path(&watched_path, None)
                .await
                .expect("watch temp directory");
        });
        drop(runtime);
        finished_tx.send(()).expect("report runtime shutdown");
    });

    finished_rx
        .recv_timeout(Duration::from_secs(3))
        .expect("file-watch worker must not keep a short-lived runtime alive");
    drop(service);
    runtime_owner.join().expect("runtime owner thread");
}

#[tokio::test]
async fn file_watch_publishes_debounced_batches_to_backend_subscribers() {
    let temp = tempfile::tempdir().expect("tempdir");
    let mut config = FileWatcherConfig::default();
    config.debounce_interval_ms = 40;
    config.ignore_hidden_files = false;
    let service = FileWatchService::new(config.clone());
    let mut events = service.subscribe();
    service
        .watch_path(temp.path().to_str().unwrap(), Some(config))
        .await
        .expect("watch temp directory");

    let file = temp.path().join("command.md");
    fs::write(&file, "first").expect("create watched file");
    fs::write(&file, "second").expect("modify watched file");

    let batch = tokio::time::timeout(Duration::from_secs(5), events.recv())
        .await
        .expect("watch batch timeout")
        .expect("watch broadcast remains open");
    assert!(batch
        .iter()
        .any(|event| event.path == file.to_string_lossy()));
}

#[tokio::test]
async fn file_watch_can_include_build_named_directories_for_semantic_sources() {
    let temp = tempfile::tempdir().expect("tempdir");
    let build_skill = temp.path().join("build");
    fs::create_dir_all(&build_skill).expect("build-named skill directory");
    let mut config = FileWatcherConfig::default();
    config.debounce_interval_ms = 40;
    config.ignore_hidden_files = false;
    config.ignore_common_build_directories = false;
    let service = FileWatchService::new(config.clone());
    let mut events = service.subscribe();
    service
        .watch_path(temp.path().to_str().unwrap(), Some(config))
        .await
        .expect("watch semantic source root");

    let file = build_skill.join("SKILL.md");
    fs::write(
        &file,
        "---\nname: build\ndescription: Build workflow\n---\n",
    )
    .expect("write skill file");

    let deadline = tokio::time::Instant::now() + Duration::from_secs(5);
    loop {
        let batch = tokio::time::timeout_at(deadline, events.recv())
            .await
            .expect("build-named semantic source should emit events")
            .expect("watch broadcast remains open");
        if batch
            .iter()
            .any(|event| event.path == file.to_string_lossy())
        {
            break;
        }
    }
}

#[tokio::test]
async fn a_narrow_duplicate_registration_does_not_downgrade_recursive_watch() {
    let temp = tempfile::tempdir().expect("tempdir");
    let nested = temp.path().join("nested");
    fs::create_dir_all(&nested).expect("nested directory");
    let mut recursive = FileWatcherConfig::default();
    recursive.debounce_interval_ms = 40;
    recursive.ignore_hidden_files = false;
    let service = FileWatchService::new(recursive.clone());
    let mut events = service.subscribe();
    service
        .watch_path(temp.path().to_str().unwrap(), Some(recursive.clone()))
        .await
        .expect("recursive watch");
    recursive.watch_recursively = false;
    service
        .watch_path(temp.path().to_str().unwrap(), Some(recursive))
        .await
        .expect("shared narrow watch");

    let file = nested.join("command.md");
    fs::write(&file, "created").expect("nested file");
    let batch = tokio::time::timeout(Duration::from_secs(5), events.recv())
        .await
        .expect("watch batch timeout")
        .expect("watch broadcast remains open");
    assert!(batch
        .iter()
        .any(|event| event.path == file.to_string_lossy()));
}

#[tokio::test]
async fn a_removed_root_does_not_block_registering_another_root() {
    let temp = tempfile::tempdir().expect("tempdir");
    let removed = temp.path().join("removed");
    let replacement = temp.path().join("replacement");
    fs::create_dir_all(&removed).expect("removed root");
    fs::create_dir_all(&replacement).expect("replacement root");
    let service = FileWatchService::new(FileWatcherConfig::default());
    service
        .watch_path(removed.to_str().unwrap(), None)
        .await
        .expect("first root");
    fs::remove_dir_all(&removed).expect("remove first root");

    service
        .watch_path(replacement.to_str().unwrap(), None)
        .await
        .expect("missing stale roots should be skipped during reconfiguration");
}

#[tokio::test]
async fn re_registering_a_recreated_root_resumes_watching() {
    // `ensure_watch_roots` never unwatches a root that merely disappeared: it
    // just re-calls `watch_path` once the root exists again. The service must
    // therefore re-register the path with the OS watcher on a repeat
    // registration, not treat it as a no-op because the config is unchanged.
    let temp = tempfile::tempdir().expect("tempdir");
    let root = temp.path().join("root");
    fs::create_dir_all(&root).expect("root directory");
    let mut config = FileWatcherConfig::default();
    config.debounce_interval_ms = 40;
    config.ignore_hidden_files = false;
    let service = FileWatchService::new(config.clone());
    let mut events = service.subscribe();
    service
        .watch_path(root.to_str().unwrap(), Some(config.clone()))
        .await
        .expect("initial watch");

    fs::remove_dir_all(&root).expect("remove watched root");
    fs::create_dir_all(&root).expect("recreate watched root");

    service
        .watch_path(root.to_str().unwrap(), Some(config))
        .await
        .expect("re-registration of a recreated root");

    let file = root.join("command.md");
    fs::write(&file, "created").expect("file in recreated root");

    let deadline = tokio::time::Instant::now() + Duration::from_secs(10);
    loop {
        let batch = tokio::time::timeout_at(deadline, events.recv())
            .await
            .expect("recreated root should still emit events")
            .expect("watch broadcast remains open");
        if batch
            .iter()
            .any(|event| event.path == file.to_string_lossy())
        {
            break;
        }
    }
}

#[tokio::test]
async fn atomic_rename_keeps_the_non_temporary_destination_path() {
    let temp = tempfile::tempdir().expect("tempdir");
    let mut config = FileWatcherConfig::default();
    config.debounce_interval_ms = 40;
    config.ignore_hidden_files = false;
    let service = FileWatchService::new(config.clone());
    let mut events = service.subscribe();
    service
        .watch_path(temp.path().to_str().unwrap(), Some(config))
        .await
        .expect("watch temp directory");

    let temporary = temp.path().join("command.md.tmp");
    let destination = temp.path().join("command.md");
    fs::write(&temporary, "complete").expect("temporary file");
    fs::rename(&temporary, &destination).expect("atomic rename");

    let batch = tokio::time::timeout(Duration::from_secs(5), events.recv())
        .await
        .expect("watch batch timeout")
        .expect("watch broadcast remains open");
    assert!(batch
        .iter()
        .any(|event| event.path == destination.to_string_lossy()));
}
