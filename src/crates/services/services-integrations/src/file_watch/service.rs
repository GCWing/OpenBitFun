use log::{debug, error, warn};
use notify::{
    Config, Error as NotifyError, Event, EventKind, RecommendedWatcher, RecursiveMode, Watcher,
};
use openbitfun_events::EventEmitter;
use std::collections::hash_map::Entry;
use std::collections::HashMap;
use std::future::Future;
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicBool, AtomicU64, Ordering};
use std::sync::{Arc, Mutex as StdMutex, RwLock as StdRwLock};
use tokio::sync::{broadcast, mpsc, Mutex};

use super::types::{
    FileWatchEvent, FileWatchEventKind, FileWatchFailure, FileWatchFailureCode, FileWatchStatus,
    FileWatcherConfig,
};

/// Event name carrying [`FileWatchStatus`] changes to product surfaces.
pub const FILE_WATCH_STATUS_CHANGED_EVENT: &str = "file-watch-status-changed";

#[derive(Clone)]
struct WatchedPath {
    config: FileWatcherConfig,
    /// Native backends may report canonical paths even when callers register a
    /// logical alias (notably `/private/var` for `/var` on macOS).
    backend_root: PathBuf,
}

impl WatchedPath {
    fn new(path: &Path, config: FileWatcherConfig) -> Self {
        Self {
            config,
            backend_root: std::fs::canonicalize(path).unwrap_or_else(|_| path.to_path_buf()),
        }
    }
}

type WatchedPaths = StdRwLock<HashMap<PathBuf, WatchedPath>>;
type EmitterDispatch = StdRwLock<Option<mpsc::Sender<Vec<FileWatchEvent>>>>;

const EVENT_CHANNEL_CAPACITY: usize = 64;

struct FileWatchHealth {
    healthy: AtomicBool,
    failure: StdMutex<Option<FileWatchFailure>>,
    sender: broadcast::Sender<()>,
}

impl FileWatchHealth {
    fn new() -> Self {
        let (sender, _) = broadcast::channel(8);
        Self {
            healthy: AtomicBool::new(true),
            failure: StdMutex::new(None),
            sender,
        }
    }

    fn is_healthy(&self) -> bool {
        self.healthy.load(Ordering::Acquire)
    }

    fn failure(&self) -> Option<FileWatchFailure> {
        failure_slot(&self.failure).clone()
    }

    fn subscribe(&self) -> broadcast::Receiver<()> {
        self.sender.subscribe()
    }

    fn mark_healthy(&self) {
        *failure_slot(&self.failure) = None;
        self.healthy.store(true, Ordering::Release);
    }

    fn mark_unhealthy(&self, failure: FileWatchFailure) {
        *failure_slot(&self.failure) = Some(failure);
        if self.healthy.swap(false, Ordering::AcqRel) {
            let _ = self.sender.send(());
        }
    }
}

fn failure_slot(
    lock: &StdMutex<Option<FileWatchFailure>>,
) -> std::sync::MutexGuard<'_, Option<FileWatchFailure>> {
    lock.lock().unwrap_or_else(|poisoned| poisoned.into_inner())
}

/// Maps a native backend error onto the product failure contract.
///
/// `ErrorKind::MaxFilesWatch` is produced only by the inotify backend, which
/// translates `ENOSPC` for exactly this purpose; Windows and macOS backends
/// never emit it, so they keep the generic backend path.
fn classify_notify_failure(error: &NotifyError, path: Option<&Path>) -> FileWatchFailure {
    let code = match error.kind {
        notify::ErrorKind::MaxFilesWatch => FileWatchFailureCode::WatchLimitExceeded,
        _ => FileWatchFailureCode::BackendUnavailable,
    };
    let mut detail = error.to_string();
    if code == FileWatchFailureCode::WatchLimitExceeded {
        if let Some(limit) = watch_limit_current_value() {
            detail.push_str(&format!(" (fs.inotify.max_user_watches={limit})"));
        }
    }
    FileWatchFailure {
        code,
        detail,
        hint: match code {
            FileWatchFailureCode::WatchLimitExceeded => watch_limit_remediation(),
            FileWatchFailureCode::BackendUnavailable => None,
        },
        path: path
            .map(Path::to_path_buf)
            .or_else(|| error.paths.first().cloned())
            .map(|path| path.to_string_lossy().into_owned()),
    }
}

#[cfg(target_os = "linux")]
fn watch_limit_current_value() -> Option<u64> {
    std::fs::read_to_string("/proc/sys/fs/inotify/max_user_watches")
        .ok()?
        .trim()
        .parse()
        .ok()
}

#[cfg(not(target_os = "linux"))]
fn watch_limit_current_value() -> Option<u64> {
    None
}

#[cfg(target_os = "linux")]
fn watch_limit_remediation() -> Option<String> {
    const LIMIT: &str = "524288";
    Some(format!(
        "sudo sysctl -w fs.inotify.max_user_watches={LIMIT}\n\
         printf 'fs.inotify.max_user_watches={LIMIT}\\n' | \
         sudo tee /etc/sysctl.d/99-openbitfun-inotify.conf"
    ))
}

#[cfg(not(target_os = "linux"))]
fn watch_limit_remediation() -> Option<String> {
    None
}

fn snapshot_status(health: &FileWatchHealth, watched_paths: &WatchedPaths) -> FileWatchStatus {
    let mut watched = read_watched_paths(watched_paths)
        .keys()
        .map(|path| path.to_string_lossy().into_owned())
        .collect::<Vec<_>>();
    watched.sort();
    FileWatchStatus {
        healthy: health.is_healthy(),
        watched_paths: watched,
        failure: health.failure(),
    }
}

/// Broadcasts one status snapshot. Cheap no-op while nothing subscribes, which
/// keeps it safe to call from the native watcher thread.
fn broadcast_status(
    health: &FileWatchHealth,
    watched_paths: &WatchedPaths,
    sender: &broadcast::Sender<FileWatchStatus>,
) {
    if sender.receiver_count() == 0 {
        return;
    }
    let status = snapshot_status(health, watched_paths);
    debug!(
        "File watch status changed: healthy={} watched_roots={} failure={:?}",
        status.healthy,
        status.watched_paths.len(),
        status.failure.as_ref().map(|failure| failure.code)
    );
    let _ = sender.send(status);
}

fn read_watched_paths(
    lock: &WatchedPaths,
) -> std::sync::RwLockReadGuard<'_, HashMap<PathBuf, WatchedPath>> {
    lock.read().unwrap_or_else(|poisoned| poisoned.into_inner())
}

fn write_watched_paths(
    lock: &WatchedPaths,
) -> std::sync::RwLockWriteGuard<'_, HashMap<PathBuf, WatchedPath>> {
    lock.write()
        .unwrap_or_else(|poisoned| poisoned.into_inner())
}

fn read_emitter_dispatch(
    lock: &EmitterDispatch,
) -> std::sync::RwLockReadGuard<'_, Option<mpsc::Sender<Vec<FileWatchEvent>>>> {
    lock.read().unwrap_or_else(|poisoned| poisoned.into_inner())
}

fn write_emitter_dispatch(
    lock: &EmitterDispatch,
) -> std::sync::RwLockWriteGuard<'_, Option<mpsc::Sender<Vec<FileWatchEvent>>>> {
    lock.write()
        .unwrap_or_else(|poisoned| poisoned.into_inner())
}

impl From<&EventKind> for FileWatchEventKind {
    fn from(kind: &EventKind) -> Self {
        match kind {
            EventKind::Create(_) => FileWatchEventKind::Create,
            EventKind::Modify(_) => FileWatchEventKind::Modify,
            EventKind::Remove(_) => FileWatchEventKind::Remove,
            EventKind::Any => FileWatchEventKind::Other,
            _ => FileWatchEventKind::Other,
        }
    }
}

pub struct FileWatchService {
    emitter_dispatch: Arc<EmitterDispatch>,
    watcher: Arc<Mutex<Option<RecommendedWatcher>>>,
    registration_gate: Mutex<()>,
    /// Path table shared with the watcher event thread. Uses a synchronous
    /// RwLock so per-event filtering never needs `block_on` into the async
    /// runtime; guards are only held for short, await-free sections.
    watched_paths: Arc<WatchedPaths>,
    event_buffer: Arc<StdMutex<Vec<FileWatchEvent>>>,
    event_sender: broadcast::Sender<Vec<FileWatchEvent>>,
    status_sender: broadcast::Sender<FileWatchStatus>,
    health: Arc<FileWatchHealth>,
    active_watcher_instance: Arc<AtomicU64>,
    config: FileWatcherConfig,
}

fn lock_event_buffer(
    event_buffer: &StdMutex<Vec<FileWatchEvent>>,
) -> std::sync::MutexGuard<'_, Vec<FileWatchEvent>> {
    match event_buffer.lock() {
        Ok(buffer) => buffer,
        Err(poisoned) => {
            error!("File watcher event buffer mutex was poisoned, recovering lock");
            poisoned.into_inner()
        }
    }
}

impl FileWatchService {
    pub fn new(config: FileWatcherConfig) -> Self {
        let (event_sender, _) = broadcast::channel(EVENT_CHANNEL_CAPACITY);
        let (status_sender, _) = broadcast::channel(EVENT_CHANNEL_CAPACITY);
        Self {
            emitter_dispatch: Arc::new(StdRwLock::new(None)),
            watcher: Arc::new(Mutex::new(None)),
            registration_gate: Mutex::new(()),
            watched_paths: Arc::new(StdRwLock::new(HashMap::new())),
            event_buffer: Arc::new(StdMutex::new(Vec::new())),
            event_sender,
            status_sender,
            health: Arc::new(FileWatchHealth::new()),
            active_watcher_instance: Arc::new(AtomicU64::new(0)),
            config,
        }
    }

    /// Subscribe to the same debounced event batches emitted to product surfaces.
    pub fn subscribe(&self) -> broadcast::Receiver<Vec<FileWatchEvent>> {
        self.event_sender.subscribe()
    }

    /// Reports failures from the native watcher thread separately from file
    /// events so cache owners can stop publishing snapshots until re-registration
    /// succeeds.
    pub fn subscribe_health_failures(&self) -> broadcast::Receiver<()> {
        self.health.subscribe()
    }

    pub fn is_healthy(&self) -> bool {
        self.health.is_healthy()
    }

    /// Current watch coverage. Readable at any time, including while the
    /// backend is unhealthy, so surfaces can explain a stale view.
    pub fn status(&self) -> FileWatchStatus {
        snapshot_status(&self.health, &self.watched_paths)
    }

    /// Subscribe to status transitions and failure-detail updates.
    pub fn subscribe_status(&self) -> broadcast::Receiver<FileWatchStatus> {
        self.status_sender.subscribe()
    }

    fn publish_status(&self) {
        broadcast_status(&self.health, &self.watched_paths, &self.status_sender);
    }

    pub async fn set_emitter(&self, emitter: Arc<dyn EventEmitter>) {
        self.set_emitter_dispatch({
            let emitter = emitter.clone();
            move |events| {
                let emitter = emitter.clone();
                async move { Self::emit_events(&emitter, &events).await }
            }
        });

        let mut status_events = self.status_sender.subscribe();
        tokio::spawn(async move {
            while let Ok(status) = status_events.recv().await {
                if let Err(error) = emitter
                    .emit(
                        FILE_WATCH_STATUS_CHANGED_EVENT,
                        serde_json::to_value(&status).unwrap_or(serde_json::Value::Null),
                    )
                    .await
                {
                    warn!("Failed to emit file watch status: {}", error);
                }
            }
        });
    }

    fn set_emitter_dispatch<F, Fut>(&self, mut emit: F)
    where
        F: FnMut(Vec<FileWatchEvent>) -> Fut + Send + 'static,
        Fut: Future<Output = ()> + Send + 'static,
    {
        let (sender, mut receiver) = mpsc::channel::<Vec<FileWatchEvent>>(EVENT_CHANNEL_CAPACITY);
        *write_emitter_dispatch(&self.emitter_dispatch) = Some(sender);
        tokio::spawn(async move {
            while let Some(events) = receiver.recv().await {
                emit(events).await;
            }
        });
    }

    pub async fn watch_path(
        &self,
        path: &str,
        config: Option<FileWatcherConfig>,
    ) -> Result<(), String> {
        let _registration_guard = self.registration_gate.lock().await;
        let path_buf = PathBuf::from(path);

        if !path_buf.exists() {
            return Err("Path does not exist".to_string());
        }

        let registration =
            WatchedPath::new(&path_buf, config.unwrap_or_else(|| self.config.clone()));
        let (recursive, is_new) = {
            let mut watched_paths = write_watched_paths(&self.watched_paths);
            let config = registration.config;
            let backend_root = registration.backend_root;
            match watched_paths.entry(path_buf.clone()) {
                Entry::Occupied(mut entry) => {
                    // Multiple product services may share a root. Registering a
                    // narrower observer must not silently downgrade an existing
                    // recursive or hidden-file-aware watch.
                    let existing = entry.get_mut();
                    existing.config.watch_recursively |= config.watch_recursively;
                    existing.config.ignore_hidden_files &= config.ignore_hidden_files;
                    existing.config.ignore_common_build_directories &=
                        config.ignore_common_build_directories;
                    existing.config.debounce_interval_ms = existing
                        .config
                        .debounce_interval_ms
                        .min(config.debounce_interval_ms);
                    existing.config.max_events_per_interval = existing
                        .config
                        .max_events_per_interval
                        .max(config.max_events_per_interval);
                    existing.backend_root = backend_root;
                    (existing.config.watch_recursively, false)
                }
                Entry::Vacant(entry) => {
                    let recursive = config.watch_recursively;
                    entry.insert(WatchedPath {
                        config,
                        backend_root,
                    });
                    (recursive, true)
                }
            }
        };

        // Register incrementally on the existing watcher instead of rebuilding
        // the whole watcher (recursive registrations are expensive on Windows).
        let mut watcher_guard = self.watcher.lock().await;
        match watcher_guard.as_mut() {
            Some(watcher) => {
                let mode = if recursive {
                    RecursiveMode::Recursive
                } else {
                    RecursiveMode::NonRecursive
                };
                // A repeat registration must always re-register with the OS
                // watcher, not just when the recursion mode changed: the path
                // may have failed a prior registration, or been removed and
                // recreated since, leaving a stale/absent OS-level watch.
                // `ensure_watch_roots` relies on
                // exactly this to resume watching a root that reappeared, and
                // the pre-incremental implementation got it for free by
                // rebuilding the whole watcher on every call.
                if !is_new {
                    // May never have been registered; ignore unwatch failures.
                    let _ = watcher.unwatch(&path_buf);
                }
                if let Err(error) = watcher.watch(&path_buf, mode) {
                    self.health
                        .mark_unhealthy(classify_notify_failure(&error, Some(&path_buf)));
                    self.publish_status();
                    return Err(format!(
                        "Failed to watch path {}: {}",
                        path_buf.display(),
                        error
                    ));
                }
                Ok(())
            }
            None => {
                drop(watcher_guard);
                self.create_watcher().await
            }
        }
    }

    pub async fn unwatch_path(&self, path: &str) -> Result<(), String> {
        let _registration_guard = self.registration_gate.lock().await;
        let path_buf = PathBuf::from(path);

        let (removed, is_empty) = {
            let mut watched_paths = write_watched_paths(&self.watched_paths);
            let removed = watched_paths.remove(&path_buf).is_some();
            (removed, watched_paths.is_empty())
        };

        let mut watcher_guard = self.watcher.lock().await;
        if is_empty {
            // Dropping the watcher disconnects its channel; the event thread
            // exits on its own.
            self.active_watcher_instance.fetch_add(1, Ordering::AcqRel);
            *watcher_guard = None;
            self.health.mark_healthy();
            self.publish_status();
        } else if removed {
            if let Some(watcher) = watcher_guard.as_mut() {
                // The path may never have been registered (e.g. it was missing
                // when the watcher was created); ignore unwatch failures.
                let _ = watcher.unwatch(&path_buf);
            }
        }

        Ok(())
    }

    /// Recreates the native watcher and re-registers the complete current path
    /// table. A backend failure is only considered recovered after this succeeds.
    pub async fn rebuild_watcher(&self) -> Result<(), String> {
        let _registration_guard = self.registration_gate.lock().await;
        self.create_watcher().await
    }

    async fn create_watcher(&self) -> Result<(), String> {
        // Keep the sync read guard scopes free of awaits: check emptiness with
        // a short-lived guard before touching the async watcher mutex.
        if read_watched_paths(&self.watched_paths).is_empty() {
            let mut watcher_guard = self.watcher.lock().await;
            self.active_watcher_instance.fetch_add(1, Ordering::AcqRel);
            *watcher_guard = None;
            self.health.mark_healthy();
            self.publish_status();
            return Ok(());
        }

        let (tx, rx) = std::sync::mpsc::channel();
        let mut watcher = match RecommendedWatcher::new(tx, Config::default()) {
            Ok(watcher) => watcher,
            Err(error) => {
                self.health
                    .mark_unhealthy(classify_notify_failure(&error, None));
                self.publish_status();
                return Err(format!("Failed to create watcher: {}", error));
            }
        };

        for (path, config) in refresh_watch_registrations(&self.watched_paths) {
            let mode = if config.watch_recursively {
                RecursiveMode::Recursive
            } else {
                RecursiveMode::NonRecursive
            };

            if let Err(error) = watcher.watch(&path, mode) {
                self.health
                    .mark_unhealthy(classify_notify_failure(&error, Some(&path)));
                self.publish_status();
                return Err(format!(
                    "Failed to watch path {}: {}",
                    path.display(),
                    error
                ));
            }
        }

        let watcher_instance;
        {
            let mut watcher_guard = self.watcher.lock().await;
            watcher_instance = self
                .active_watcher_instance
                .fetch_add(1, Ordering::AcqRel)
                .saturating_add(1);
            *watcher_guard = Some(watcher);
        }
        self.health.mark_healthy();
        self.publish_status();

        let event_buffer = self.event_buffer.clone();
        let emitter_dispatch = self.emitter_dispatch.clone();
        let default_debounce_ms = self.config.debounce_interval_ms;
        let watched_paths = self.watched_paths.clone();
        let event_sender = self.event_sender.clone();
        let status_sender = self.status_sender.clone();
        let health = self.health.clone();
        let active_watcher_instance = self.active_watcher_instance.clone();
        // The native receiver lives for as long as its OS watcher. Keeping that
        // process-lifetime loop in Tokio's blocking pool would make short-lived
        // runtimes wait forever during shutdown. Emitter delivery is handed to
        // the runtime-owned dispatch queue configured by `set_emitter`.
        let worker = std::thread::Builder::new()
            .name("openbitfun-file-watch".to_string())
            .spawn(move || {
                let poll = std::time::Duration::from_millis(50);
                let mut last_event_time: Option<std::time::Instant> = None;

                loop {
                    match rx.recv_timeout(poll) {
                        Ok(Ok(event)) => {
                            // Synchronous path-table snapshot: no block_on needed
                            // per event.
                            let file_events = Self::convert_events(&event, &watched_paths);
                            if !file_events.is_empty() {
                                lock_event_buffer(&event_buffer).extend(file_events);
                                last_event_time = Some(std::time::Instant::now());
                            }
                        }
                        Ok(Err(error)) => {
                            error!("File watch error: {}", error);
                            if active_watcher_instance.load(Ordering::Acquire) == watcher_instance {
                                health.mark_unhealthy(classify_notify_failure(&error, None));
                                broadcast_status(&health, &watched_paths, &status_sender);
                            }
                        }
                        Err(std::sync::mpsc::RecvTimeoutError::Timeout) => {}
                        Err(std::sync::mpsc::RecvTimeoutError::Disconnected) => {
                            if active_watcher_instance.load(Ordering::Acquire) == watcher_instance {
                                health.mark_unhealthy(FileWatchFailure::backend_unavailable(
                                    "file watch backend channel closed",
                                    None,
                                ));
                                broadcast_status(&health, &watched_paths, &status_sender);
                            }
                            break;
                        }
                    }

                    if let Some(t) = last_event_time {
                        let debounce_ms = read_watched_paths(&watched_paths)
                            .values()
                            .map(|registration| registration.config.debounce_interval_ms)
                            .min()
                            .unwrap_or(default_debounce_ms);
                        if t.elapsed() >= std::time::Duration::from_millis(debounce_ms) {
                            Self::flush_events_static(
                                &event_buffer,
                                &emitter_dispatch,
                                &event_sender,
                            );
                            last_event_time = None;
                        }
                    }
                }
            });
        if let Err(error) = worker {
            self.active_watcher_instance.fetch_add(1, Ordering::AcqRel);
            *self.watcher.lock().await = None;
            self.health
                .mark_unhealthy(FileWatchFailure::backend_unavailable(
                    format!("failed to start file watch worker: {error}"),
                    None,
                ));
            self.publish_status();
            return Err(format!("Failed to start file watch worker: {error}"));
        }

        Ok(())
    }

    fn convert_events(event: &Event, watched_paths: &WatchedPaths) -> Vec<FileWatchEvent> {
        let paths = read_watched_paths(watched_paths);
        event
            .paths
            .iter()
            .filter_map(|event_path| {
                let (registered_root, registration) =
                    preferred_event_registration(event_path, &paths)?;
                let projected_path =
                    project_event_path(registered_root, &registration.backend_root, event_path);
                if registration.config.ignore_common_build_directories
                    && Self::is_in_excluded_directory(&projected_path)
                    || Self::is_temporary_file(&projected_path)
                    || registration.config.ignore_hidden_files
                        && projected_path
                            .file_name()
                            .and_then(|name| name.to_str())
                            .is_some_and(|name| name.starts_with('.'))
                {
                    return None;
                }
                Self::convert_event(&event.kind, &projected_path)
            })
            .collect()
    }

    fn is_in_excluded_directory(path: &Path) -> bool {
        const EXCLUDED_DIRS: &[&str] = &[
            "node_modules",
            ".git",
            ".svn",
            ".hg",
            "target",
            "dist",
            "build",
            "out",
            ".next",
            ".nuxt",
            "vendor",
            "__pycache__",
            ".pytest_cache",
            ".mypy_cache",
            "venv",
            ".venv",
            "env",
            ".env",
            "bower_components",
            ".idea",
            ".vscode",
            ".vs",
            "bin",
            "obj",
            ".terraform",
            "coverage",
            ".coverage",
            "htmlcov",
        ];

        for component in path.components() {
            if let Some(os_str) = component.as_os_str().to_str() {
                if EXCLUDED_DIRS.contains(&os_str) {
                    return true;
                }
            }
        }

        false
    }

    fn is_temporary_file(path: &Path) -> bool {
        if let Some(file_name) = path.file_name() {
            if let Some(name_str) = file_name.to_str() {
                return name_str.ends_with('~')
                    || name_str.ends_with(".swp")
                    || name_str.ends_with(".swo")
                    || name_str.ends_with(".swn")
                    || name_str.starts_with(".#")
                    || name_str.ends_with(".tmp")
                    || name_str.ends_with(".temp")
                    || name_str.ends_with(".bak")
                    || name_str.ends_with(".old")
                    || name_str.starts_with('#') && name_str.ends_with('#')
                    || name_str == ".DS_Store"
                    || name_str == "Thumbs.db"
                    || name_str == "desktop.ini"
                    || name_str.ends_with(".crdownload")
                    || name_str.ends_with(".part");
            }
        }

        false
    }

    fn convert_event(kind: &EventKind, path: &Path) -> Option<FileWatchEvent> {
        let kind = match kind {
            EventKind::Create(_) => FileWatchEventKind::Create,
            EventKind::Modify(_) => FileWatchEventKind::Modify,
            EventKind::Remove(_) => FileWatchEventKind::Remove,
            EventKind::Other => FileWatchEventKind::Other,
            _ => return None,
        };

        Some(FileWatchEvent {
            path: path.to_string_lossy().to_string(),
            kind,
            timestamp: std::time::SystemTime::now()
                .duration_since(std::time::UNIX_EPOCH)
                .unwrap_or_default()
                .as_secs(),
        })
    }

    fn flush_events_static(
        event_buffer: &Arc<StdMutex<Vec<FileWatchEvent>>>,
        emitter_dispatch: &Arc<EmitterDispatch>,
        event_sender: &broadcast::Sender<Vec<FileWatchEvent>>,
    ) {
        let events = {
            let mut buffer = lock_event_buffer(event_buffer);
            if buffer.is_empty() {
                return;
            }
            buffer.drain(..).collect::<Vec<_>>()
        };

        // No active backend subscriber is a normal state; the frontend emitter
        // may still consume this batch.
        let _ = event_sender.send(events.clone());

        match read_emitter_dispatch(emitter_dispatch).as_ref() {
            Some(dispatch) => match dispatch.try_send(events) {
                Ok(()) => {}
                Err(mpsc::error::TrySendError::Full(_)) => {
                    debug!("EventEmitter queue full, skipping file watch events");
                }
                Err(mpsc::error::TrySendError::Closed(_)) => {
                    debug!("EventEmitter runtime unavailable, skipping file watch events");
                }
            },
            None => debug!("EventEmitter not configured, skipping file watch events"),
        }
    }

    async fn emit_events(emitter: &Arc<dyn EventEmitter>, events: &[FileWatchEvent]) {
        let mut event_array = Vec::new();

        for event in events {
            let kind = match event.kind {
                FileWatchEventKind::Create => "create",
                FileWatchEventKind::Modify => "modify",
                FileWatchEventKind::Remove => "remove",
                FileWatchEventKind::Rename { ref from, ref to } => {
                    event_array.push(serde_json::json!({
                        "path": to,
                        "kind": "rename",
                        "from": from,
                        "to": to,
                        "timestamp": event.timestamp
                    }));
                    continue;
                }
                FileWatchEventKind::Other => "other",
            };

            event_array.push(serde_json::json!({
                "path": event.path,
                "kind": kind,
                "timestamp": event.timestamp
            }));
        }

        if let Err(error) = emitter
            .emit("file-system-changed", serde_json::json!(event_array))
            .await
        {
            error!("Failed to emit file-system-changed events: {}", error);
        } else {
            debug!("Emitted {} file system change events", event_array.len());
        }
    }

    pub async fn get_watched_paths(&self) -> Vec<String> {
        let watched_paths = read_watched_paths(&self.watched_paths);
        watched_paths
            .keys()
            .map(|path| path.to_string_lossy().to_string())
            .collect()
    }
}

fn refresh_watch_registrations(watched_paths: &WatchedPaths) -> Vec<(PathBuf, FileWatcherConfig)> {
    let roots = read_watched_paths(watched_paths)
        .keys()
        .cloned()
        .collect::<Vec<_>>();
    let refreshed_roots = roots
        .into_iter()
        .map(|root| {
            let backend_root = std::fs::canonicalize(&root).unwrap_or_else(|_| root.clone());
            (root, backend_root)
        })
        .collect::<HashMap<_, _>>();

    let mut paths = write_watched_paths(watched_paths);
    for (root, registration) in paths.iter_mut() {
        if let Some(backend_root) = refreshed_roots.get(root) {
            registration.backend_root.clone_from(backend_root);
        }
    }
    let mut registrations = paths
        .iter()
        .map(|(root, registration)| (root.clone(), registration.config.clone()))
        .collect::<Vec<_>>();
    registrations.sort_by(|(left, _), (right, _)| left.cmp(right));
    registrations
}

fn preferred_event_registration<'a>(
    event_path: &Path,
    paths: &'a HashMap<PathBuf, WatchedPath>,
) -> Option<(&'a PathBuf, &'a WatchedPath)> {
    paths
        .iter()
        .filter_map(|(registered_root, registration)| {
            let registered_depth = event_path
                .starts_with(registered_root)
                .then(|| registered_root.components().count());
            let backend_depth = event_path
                .starts_with(&registration.backend_root)
                .then(|| registration.backend_root.components().count());
            let matched_depth = registered_depth.into_iter().chain(backend_depth).max()?;
            let direct_at_matched_depth = registered_depth == Some(matched_depth);
            Some((
                registered_root,
                registration,
                matched_depth,
                direct_at_matched_depth,
            ))
        })
        .max_by(|left, right| {
            left.2
                .cmp(&right.2)
                .then_with(|| left.3.cmp(&right.3))
                // Keep canonical aliases deterministic when neither registration
                // directly matches the backend event namespace.
                .then_with(|| right.0.cmp(left.0))
        })
        .map(|(registered_root, registration, _, _)| (registered_root, registration))
}

fn project_event_path(registered_root: &Path, backend_root: &Path, event_path: &Path) -> PathBuf {
    event_path
        .strip_prefix(backend_root)
        .map(|relative| registered_root.join(relative))
        .unwrap_or_else(|_| event_path.to_path_buf())
}

#[cfg(test)]
mod tests {
    use super::{
        classify_notify_failure, preferred_event_registration, read_watched_paths,
        refresh_watch_registrations, write_watched_paths, FileWatchService, WatchedPath,
    };
    use crate::file_watch::{FileWatchFailure, FileWatchFailureCode, FileWatcherConfig};
    use notify::event::CreateKind;
    use notify::{Event, EventKind};
    use std::collections::HashMap;
    use std::fs;
    use std::path::Path;
    use std::sync::RwLock as StdRwLock;
    use std::time::Duration;

    #[test]
    fn backend_canonical_paths_are_projected_to_the_registered_namespace() {
        let registered_root = Path::new("/var/folders/openbitfun-skills").to_path_buf();
        let backend_root = Path::new("/private/var/folders/openbitfun-skills").to_path_buf();
        let backend_event = backend_root.join("example/SKILL.md");
        let watched_paths = StdRwLock::new(HashMap::from([(
            registered_root.clone(),
            WatchedPath {
                config: FileWatcherConfig::default(),
                backend_root,
            },
        )]));
        let event = Event::new(EventKind::Create(CreateKind::File)).add_path(backend_event);

        let converted = FileWatchService::convert_events(&event, &watched_paths);

        assert_eq!(converted.len(), 1);
        assert_eq!(
            converted[0].path,
            registered_root.join("example/SKILL.md").to_string_lossy()
        );
    }

    #[test]
    fn a_direct_registered_path_wins_a_canonical_alias_at_equal_depth() {
        let alias_root = Path::new("/var/folders/openbitfun-skills").to_path_buf();
        let direct_root = Path::new("/private/var/folders/openbitfun-skills").to_path_buf();
        let watched_paths = HashMap::from([
            (
                alias_root,
                WatchedPath {
                    config: FileWatcherConfig::default(),
                    backend_root: direct_root.clone(),
                },
            ),
            (
                direct_root.clone(),
                WatchedPath {
                    config: FileWatcherConfig::default(),
                    backend_root: direct_root.clone(),
                },
            ),
        ]);

        let (registered_root, _) =
            preferred_event_registration(&direct_root.join("example/SKILL.md"), &watched_paths)
                .expect("matching registration");

        assert_eq!(registered_root, &direct_root);
    }

    #[test]
    fn canonical_alias_fallback_is_deterministic() {
        let first_alias = Path::new("/aliases/first/openbitfun-skills").to_path_buf();
        let second_alias = Path::new("/aliases/second/openbitfun-skills").to_path_buf();
        let backend_root = Path::new("/private/var/folders/openbitfun-skills").to_path_buf();
        let watched_paths = HashMap::from([
            (
                second_alias,
                WatchedPath {
                    config: FileWatcherConfig::default(),
                    backend_root: backend_root.clone(),
                },
            ),
            (
                first_alias.clone(),
                WatchedPath {
                    config: FileWatcherConfig::default(),
                    backend_root: backend_root.clone(),
                },
            ),
        ]);

        let (registered_root, _) =
            preferred_event_registration(&backend_root.join("example/SKILL.md"), &watched_paths)
                .expect("matching registration");

        assert_eq!(registered_root, &first_alias);
    }

    #[test]
    fn watcher_rebuild_refreshes_the_native_backend_root() {
        let temp = tempfile::tempdir().expect("tempdir");
        let root = temp.path().join("skills");
        fs::create_dir_all(&root).expect("skill root");
        let expected = std::fs::canonicalize(&root).expect("canonical skill root");
        let watched_paths = StdRwLock::new(HashMap::from([(
            root.clone(),
            WatchedPath {
                config: FileWatcherConfig::default(),
                backend_root: Path::new("/stale/backend/root").to_path_buf(),
            },
        )]));

        let registrations = refresh_watch_registrations(&watched_paths);

        assert_eq!(registrations.len(), 1);
        assert_eq!(
            read_watched_paths(&watched_paths)[&root].backend_root,
            expected
        );
    }

    #[tokio::test]
    async fn backend_health_recovers_only_after_a_full_rebuild() {
        let temp = tempfile::tempdir().expect("tempdir");
        let first = temp.path().join("first");
        let second = temp.path().join("second");
        fs::create_dir_all(&first).expect("first root");
        fs::create_dir_all(&second).expect("second root");
        let mut config = FileWatcherConfig::default();
        config.debounce_interval_ms = 0;
        let service = FileWatchService::new(config.clone());
        let mut events = service.subscribe();
        let mut failures = service.subscribe_health_failures();
        service
            .watch_path(&first.to_string_lossy(), Some(config.clone()))
            .await
            .expect("initial watch");

        service
            .health
            .mark_unhealthy(FileWatchFailure::backend_unavailable("test failure", None));

        failures.recv().await.expect("health failure notification");
        service
            .watch_path(&second.to_string_lossy(), Some(config))
            .await
            .expect("incremental registration");
        assert!(!service.is_healthy());

        service.rebuild_watcher().await.expect("full rebuild");
        assert!(service.is_healthy());
        fs::write(second.join("SKILL.md"), "updated").expect("watched update");

        let batch = tokio::time::timeout(Duration::from_secs(5), events.recv())
            .await
            .expect("event after rebuild")
            .expect("watch event batch");
        assert!(batch.iter().any(|event| event.path.ends_with("SKILL.md")));
    }

    #[tokio::test]
    async fn rebuild_does_not_report_a_missing_registered_path_as_healthy() {
        let temp = tempfile::tempdir().expect("tempdir");
        let missing = temp.path().join("missing");
        let service = FileWatchService::new(FileWatcherConfig::default());
        write_watched_paths(&service.watched_paths).insert(
            missing.clone(),
            WatchedPath::new(&missing, FileWatcherConfig::default()),
        );

        let error = service
            .rebuild_watcher()
            .await
            .expect_err("missing registered path must fail rebuild");

        assert!(error.contains("Failed to watch path"));
        assert!(!service.is_healthy());

        let status = service.status();
        let failure = status.failure.expect("a failed rebuild reports its reason");
        assert_eq!(failure.code, FileWatchFailureCode::BackendUnavailable);
        assert_eq!(
            failure.path.as_deref(),
            Some(missing.to_string_lossy().as_ref())
        );
        assert!(failure.hint.is_none());
    }

    #[test]
    fn a_watch_limit_failure_maps_to_the_limit_code() {
        let error = notify::Error::new(notify::ErrorKind::MaxFilesWatch);

        let failure = classify_notify_failure(&error, Some(Path::new("/tmp/workspace")));

        assert_eq!(failure.code, FileWatchFailureCode::WatchLimitExceeded);
        assert_eq!(failure.path.as_deref(), Some("/tmp/workspace"));
        // The remediation command belongs to inotify only; other platforms have
        // no such quota, so they must not be handed a Linux sysctl command.
        #[cfg(target_os = "linux")]
        assert!(failure
            .hint
            .as_deref()
            .is_some_and(|hint| hint.contains("fs.inotify.max_user_watches")));
        #[cfg(not(target_os = "linux"))]
        assert!(failure.hint.is_none());
    }

    #[test]
    fn a_generic_backend_failure_reports_no_hint() {
        let error = notify::Error::new(notify::ErrorKind::Generic("backend down".to_string()));

        let failure = classify_notify_failure(&error, None);

        assert_eq!(failure.code, FileWatchFailureCode::BackendUnavailable);
        assert!(failure.hint.is_none());
        assert_eq!(failure.detail, "backend down");
    }

    #[test]
    fn status_reports_the_failure_and_clears_it_after_recovery() {
        let service = FileWatchService::new(FileWatcherConfig::default());
        let mut statuses = service.subscribe_status();

        let initial = service.status();
        assert!(initial.healthy);
        assert!(initial.failure.is_none());

        service.health.mark_unhealthy(classify_notify_failure(
            &notify::Error::new(notify::ErrorKind::MaxFilesWatch),
            None,
        ));
        service.publish_status();

        let reported = statuses.try_recv().expect("status push on failure");
        assert!(!reported.healthy);
        assert_eq!(
            reported.failure.expect("failure detail").code,
            FileWatchFailureCode::WatchLimitExceeded
        );

        service.health.mark_healthy();
        service.publish_status();

        let recovered = statuses.try_recv().expect("status push on recovery");
        assert!(recovered.healthy);
        assert!(recovered.failure.is_none());
    }

    #[test]
    fn emitter_dispatch_can_rebind_after_runtime_shutdown() {
        let temp = tempfile::tempdir().expect("tempdir");
        let mut config = FileWatcherConfig::default();
        config.debounce_interval_ms = 0;
        config.ignore_hidden_files = false;
        let service = FileWatchService::new(config.clone());

        let first_runtime = tokio::runtime::Builder::new_current_thread()
            .enable_all()
            .build()
            .expect("first runtime");
        first_runtime.block_on(async {
            service.set_emitter_dispatch(|_| async {
                tokio::time::sleep(Duration::from_millis(1)).await;
            });
            service
                .watch_path(temp.path().to_str().unwrap(), Some(config))
                .await
                .expect("watch temp directory");
        });
        drop(first_runtime);

        let second_runtime = tokio::runtime::Builder::new_current_thread()
            .enable_all()
            .build()
            .expect("second runtime");
        second_runtime.block_on(async {
            let (observed, mut emitted) = tokio::sync::mpsc::unbounded_channel();
            service.set_emitter_dispatch(move |events| {
                let observed = observed.clone();
                async move {
                    tokio::time::sleep(Duration::from_millis(1)).await;
                    let _ = observed.send(events);
                }
            });

            let first_file = temp.path().join("first.md");
            fs::write(&first_file, "first").expect("first watched update");
            let deadline = tokio::time::Instant::now() + Duration::from_secs(5);
            loop {
                let events = tokio::time::timeout_at(deadline, emitted.recv())
                    .await
                    .expect("dispatch after runtime rebind")
                    .expect("emitter dispatch remains open");
                if events
                    .iter()
                    .any(|event| event.path == first_file.to_string_lossy())
                {
                    break;
                }
            }

            tokio::time::sleep(Duration::from_millis(50)).await;
            let second_file = temp.path().join("second.md");
            fs::write(&second_file, "second").expect("second watched update");
            let deadline = tokio::time::Instant::now() + Duration::from_secs(5);
            loop {
                let events = tokio::time::timeout_at(deadline, emitted.recv())
                    .await
                    .expect("watch worker survives the first runtime shutdown")
                    .expect("emitter dispatch remains open");
                if events
                    .iter()
                    .any(|event| event.path == second_file.to_string_lossy())
                {
                    break;
                }
            }
        });
    }
}

static GLOBAL_FILE_WATCH_SERVICE: std::sync::OnceLock<Arc<FileWatchService>> =
    std::sync::OnceLock::new();

pub fn get_global_file_watch_service() -> Arc<FileWatchService> {
    GLOBAL_FILE_WATCH_SERVICE
        .get_or_init(|| Arc::new(FileWatchService::new(FileWatcherConfig::default())))
        .clone()
}

pub async fn start_file_watch(path: String, recursive: Option<bool>) -> Result<(), String> {
    let watcher = get_global_file_watch_service();
    let mut config = FileWatcherConfig::default();
    if let Some(rec) = recursive {
        config.watch_recursively = rec;
    }

    watcher.watch_path(&path, Some(config)).await
}

pub async fn stop_file_watch(path: String) -> Result<(), String> {
    let watcher = get_global_file_watch_service();
    watcher.unwatch_path(&path).await
}

pub async fn get_watched_paths() -> Result<Vec<String>, String> {
    let watcher = get_global_file_watch_service();
    Ok(watcher.get_watched_paths().await)
}

pub fn get_file_watch_status() -> FileWatchStatus {
    get_global_file_watch_service().status()
}

/// Re-registers every watched root on a fresh native watcher, which is the only
/// way a surface can recover from a backend failure (for example after the user
/// raises a watch quota).
pub async fn retry_file_watch() -> Result<(), String> {
    get_global_file_watch_service().rebuild_watcher().await
}

pub fn initialize_file_watch_service(emitter: Arc<dyn EventEmitter>) {
    let watcher = get_global_file_watch_service();

    tokio::spawn(async move {
        watcher.set_emitter(emitter).await;
    });
}
