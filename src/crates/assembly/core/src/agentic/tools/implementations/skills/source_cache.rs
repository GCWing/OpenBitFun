use openbitfun_services_integrations::file_watch::{
    FileWatchEventKind, FileWatchService, FileWatcherConfig,
};
use std::collections::BTreeMap;
use std::future::Future;
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicBool, AtomicU64, Ordering};
use std::sync::{Arc, RwLock as StdRwLock};
use tokio::sync::{Mutex, RwLock};

// The cache itself is lazy, so coalescing invalidations has no scan-cost benefit
// and would only create a stale window before the next registry query.
const SKILL_WATCH_DEBOUNCE_MS: u64 = 0;
const MAX_SNAPSHOT_LOAD_ATTEMPTS: usize = 2;

#[derive(Clone)]
pub(super) struct SnapshotInvalidator {
    generation: Arc<AtomicU64>,
}

impl SnapshotInvalidator {
    fn new() -> Self {
        Self {
            generation: Arc::new(AtomicU64::new(0)),
        }
    }

    fn current(&self) -> u64 {
        self.generation.load(Ordering::Acquire)
    }

    pub(super) fn invalidate(&self) {
        self.generation.fetch_add(1, Ordering::AcqRel);
    }
}

struct CachedSnapshot<T> {
    generation: u64,
    value: T,
}

struct CompletedUncachedSnapshot<T> {
    generation: u64,
    completion: u64,
    value: T,
}

/// A lazy, single-flight snapshot that cannot publish a value observed across
/// an invalidation boundary.
pub(super) struct VersionedSnapshotCache<T> {
    invalidator: SnapshotInvalidator,
    snapshot: RwLock<Option<CachedSnapshot<T>>>,
    load_gate: Mutex<()>,
    completed_loads: AtomicU64,
    uncached_completion: RwLock<Option<CompletedUncachedSnapshot<T>>>,
}

impl<T: Clone> VersionedSnapshotCache<T> {
    pub(super) fn new() -> Self {
        Self {
            invalidator: SnapshotInvalidator::new(),
            snapshot: RwLock::new(None),
            load_gate: Mutex::new(()),
            completed_loads: AtomicU64::new(0),
            uncached_completion: RwLock::new(None),
        }
    }

    pub(super) fn invalidator(&self) -> SnapshotInvalidator {
        self.invalidator.clone()
    }

    pub(super) fn invalidate(&self) {
        self.invalidator.invalidate();
    }

    pub(super) async fn get_or_load<F, Fut>(&self, mut load: F) -> T
    where
        F: FnMut() -> Fut,
        Fut: Future<Output = (T, bool)>,
    {
        let observed_completion = self.completed_loads.load(Ordering::Acquire);
        let mut attempts = 0usize;
        loop {
            let generation = self.invalidator.current();
            if let Some(value) = self.value_for_generation(generation).await {
                return value;
            }

            let _load_guard = self.load_gate.lock().await;
            let generation = self.invalidator.current();
            if let Some(value) = self.value_for_generation(generation).await {
                return value;
            }
            // Concurrent readers share even an unhealthy scan, including its
            // diagnostics. A reader arriving after completion retries normally;
            // this is not a persistent cache of a failed/partial discovery.
            if let Some(completed) = self.uncached_completion.read().await.as_ref() {
                if completed.generation == generation && completed.completion > observed_completion
                {
                    return completed.value.clone();
                }
            }

            let (value, cacheable) = load().await;
            if !cacheable {
                let completion = self.completed_loads.fetch_add(1, Ordering::AcqRel) + 1;
                *self.uncached_completion.write().await = Some(CompletedUncachedSnapshot {
                    generation,
                    completion,
                    value: value.clone(),
                });
                return value;
            }
            if self.invalidator.current() != generation {
                attempts = attempts.saturating_add(1);
                if attempts >= MAX_SNAPSHOT_LOAD_ATTEMPTS {
                    return value;
                }
                continue;
            }

            *self.snapshot.write().await = Some(CachedSnapshot {
                generation,
                value: value.clone(),
            });
            self.completed_loads.fetch_add(1, Ordering::AcqRel);
            *self.uncached_completion.write().await = None;
            return value;
        }
    }

    async fn value_for_generation(&self, generation: u64) -> Option<T> {
        self.snapshot
            .read()
            .await
            .as_ref()
            .filter(|snapshot| snapshot.generation == generation)
            .map(|snapshot| snapshot.value.clone())
    }
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub(super) struct LocalSkillWatchRoot {
    pub(super) path: PathBuf,
    pub(super) recursive: bool,
}

impl LocalSkillWatchRoot {
    pub(super) fn recursive(path: PathBuf) -> Self {
        Self {
            path,
            recursive: true,
        }
    }
}

/// Process-lifetime watcher for user-level Skill sources. Project roots are
/// intentionally excluded because they follow workspace/session lifecycles and
/// continue to be read on demand by the registry.
pub(super) struct LocalSkillWatchMonitor {
    watcher: Arc<FileWatchService>,
    invalidator: SnapshotInvalidator,
    registrations: Mutex<BTreeMap<PathBuf, (bool, bool)>>,
    desired_paths: Arc<StdRwLock<Vec<PathBuf>>>,
    rebind_required: Arc<AtomicBool>,
    started: AtomicBool,
}

impl LocalSkillWatchMonitor {
    pub(super) fn new(invalidator: SnapshotInvalidator) -> Self {
        let mut config = FileWatcherConfig::default();
        config.ignore_hidden_files = false;
        config.ignore_common_build_directories = false;
        config.debounce_interval_ms = SKILL_WATCH_DEBOUNCE_MS;
        Self {
            watcher: Arc::new(FileWatchService::new(config)),
            invalidator,
            registrations: Mutex::new(BTreeMap::new()),
            desired_paths: Arc::new(StdRwLock::new(Vec::new())),
            rebind_required: Arc::new(AtomicBool::new(false)),
            started: AtomicBool::new(false),
        }
    }

    pub(super) fn start(&self) {
        if self
            .started
            .compare_exchange(false, true, Ordering::AcqRel, Ordering::Acquire)
            .is_err()
        {
            return;
        }

        let mut receiver = self.watcher.subscribe();
        let mut health_failures = self.watcher.subscribe_health_failures();
        let invalidator = self.invalidator.clone();
        let health_invalidator = invalidator.clone();
        let desired_paths = self.desired_paths.clone();
        let rebind_required = self.rebind_required.clone();
        let health_rebind_required = rebind_required.clone();
        tokio::spawn(async move {
            loop {
                let events = match receiver.recv().await {
                    Ok(events) => events,
                    Err(tokio::sync::broadcast::error::RecvError::Lagged(_)) => {
                        rebind_required.store(true, Ordering::Release);
                        invalidator.invalidate();
                        continue;
                    }
                    Err(tokio::sync::broadcast::error::RecvError::Closed) => {
                        rebind_required.store(true, Ordering::Release);
                        invalidator.invalidate();
                        break;
                    }
                };
                let desired = read_desired_paths(&desired_paths);
                let relevant = events.iter().filter(|event| {
                    let event_path = Path::new(&event.path);
                    desired
                        .iter()
                        .any(|root| event_path.starts_with(root) || root.starts_with(event_path))
                });
                let mut invalidated = false;
                for event in relevant {
                    invalidated = true;
                    if matches!(
                        &event.kind,
                        FileWatchEventKind::Remove
                            | FileWatchEventKind::Modify
                            | FileWatchEventKind::Rename { .. }
                            | FileWatchEventKind::Other
                    ) {
                        rebind_required.store(true, Ordering::Release);
                    }
                }
                if invalidated {
                    invalidator.invalidate();
                }
            }
        });
        tokio::spawn(async move {
            loop {
                match health_failures.recv().await {
                    Ok(()) | Err(tokio::sync::broadcast::error::RecvError::Lagged(_)) => {
                        health_rebind_required.store(true, Ordering::Release);
                        health_invalidator.invalidate();
                    }
                    Err(tokio::sync::broadcast::error::RecvError::Closed) => break,
                }
            }
        });
    }

    /// Replaces the desired source set. Returns false when any desired root
    /// cannot be covered by an OS watcher; callers then keep discovery uncached.
    pub(super) async fn sync_roots(&self, roots: Vec<LocalSkillWatchRoot>) -> bool {
        let backend_unhealthy = !self.watcher.is_healthy();
        let force_rebind = self.rebind_required.swap(false, Ordering::AcqRel) && !backend_unhealthy;
        let desired = merge_roots(roots);
        let desired_paths = desired.keys().cloned().collect::<Vec<_>>();
        let desired_changed = {
            let mut current = write_desired_paths(&self.desired_paths);
            if *current == desired_paths {
                false
            } else {
                *current = desired_paths;
                true
            }
        };

        let mut registrations = BTreeMap::new();
        let mut healthy = true;
        for (path, recursive) in desired {
            let Some((watch_path, watch_recursively)) = registration_for(&path, recursive) else {
                healthy = false;
                continue;
            };
            registrations
                .entry(watch_path)
                .and_modify(|registered_recursive| *registered_recursive |= watch_recursively)
                .or_insert(watch_recursively);
        }
        let registrations = remove_recursively_covered_roots(registrations);

        let mut states = self.registrations.lock().await;
        let obsolete = states
            .keys()
            .filter(|key| !registrations.contains_key(*key))
            .cloned()
            .collect::<Vec<_>>();
        let mut registration_changed = !obsolete.is_empty();
        for key in obsolete {
            if let Err(error) = self.watcher.unwatch_path(&key.to_string_lossy()).await {
                log::warn!(
                    "Failed to remove obsolete Skill watch root {}: {}",
                    key.display(),
                    error
                );
            }
            states.remove(&key);
        }

        for (path, recursive) in registrations {
            let previous = states.get(&path).copied();
            if !force_rebind && previous == Some((recursive, true)) && path.exists() {
                continue;
            }
            registration_changed = true;
            if !path.exists() {
                states.insert(path, (recursive, false));
                healthy = false;
                continue;
            }
            if previous.is_some() {
                let _ = self.watcher.unwatch_path(&path.to_string_lossy()).await;
            }
            let mut config = FileWatcherConfig::default();
            config.watch_recursively = recursive;
            config.ignore_hidden_files = false;
            config.ignore_common_build_directories = false;
            config.debounce_interval_ms = SKILL_WATCH_DEBOUNCE_MS;
            match self
                .watcher
                .watch_path(&path.to_string_lossy(), Some(config))
                .await
            {
                Ok(()) => {
                    states.insert(path, (recursive, true));
                }
                Err(error) => {
                    states.insert(path.clone(), (recursive, false));
                    healthy = false;
                    log::warn!(
                        "Failed to watch Skill source root {}: {}",
                        path.display(),
                        error
                    );
                }
            }
        }
        drop(states);

        if backend_unhealthy {
            match self.watcher.rebuild_watcher().await {
                Ok(()) => registration_changed = true,
                Err(error) => {
                    healthy = false;
                    log::warn!("Failed to rebuild the Skill file watcher: {}", error);
                }
            }
        }

        if desired_changed || registration_changed {
            self.invalidator.invalidate();
        }
        healthy && self.watcher.is_healthy()
    }
}

fn merge_roots(roots: Vec<LocalSkillWatchRoot>) -> BTreeMap<PathBuf, bool> {
    let mut merged = BTreeMap::new();
    for root in roots {
        merged
            .entry(root.path)
            .and_modify(|recursive| *recursive |= root.recursive)
            .or_insert(root.recursive);
    }
    merged
}

fn remove_recursively_covered_roots(
    registrations: BTreeMap<PathBuf, bool>,
) -> BTreeMap<PathBuf, bool> {
    let mut ordered = registrations.into_iter().collect::<Vec<_>>();
    ordered.sort_by(|(left, _), (right, _)| {
        left.components()
            .count()
            .cmp(&right.components().count())
            .then_with(|| left.cmp(right))
    });
    let mut minimal = BTreeMap::new();
    for (path, recursive) in ordered {
        let covered = minimal.iter().any(|(ancestor, ancestor_recursive)| {
            *ancestor_recursive && path.starts_with(ancestor)
        });
        if !covered {
            minimal.insert(path, recursive);
        }
    }
    minimal
}

fn registration_for(path: &Path, recursive: bool) -> Option<(PathBuf, bool)> {
    if path.exists() {
        return Some((path.to_path_buf(), recursive));
    }
    let mut parent = path.to_path_buf();
    while parent.pop() {
        if parent.exists() {
            return Some((parent, false));
        }
    }
    None
}

fn read_desired_paths(
    lock: &StdRwLock<Vec<PathBuf>>,
) -> std::sync::RwLockReadGuard<'_, Vec<PathBuf>> {
    lock.read().unwrap_or_else(|poisoned| poisoned.into_inner())
}

fn write_desired_paths(
    lock: &StdRwLock<Vec<PathBuf>>,
) -> std::sync::RwLockWriteGuard<'_, Vec<PathBuf>> {
    lock.write()
        .unwrap_or_else(|poisoned| poisoned.into_inner())
}

#[cfg(test)]
mod tests {
    use super::{
        remove_recursively_covered_roots, LocalSkillWatchMonitor, LocalSkillWatchRoot,
        VersionedSnapshotCache, MAX_SNAPSHOT_LOAD_ATTEMPTS,
    };
    use std::collections::BTreeMap;
    use std::fs;
    use std::sync::atomic::{AtomicUsize, Ordering};
    use std::sync::Arc;
    use std::time::Duration;

    #[test]
    fn recursive_parent_registration_covers_nested_skill_roots() {
        let parent = std::path::PathBuf::from("skills");
        let child = parent.join(".system");
        let sibling = std::path::PathBuf::from("other-skills");
        let registrations = BTreeMap::from([
            (child, true),
            (sibling.clone(), true),
            (parent.clone(), true),
        ]);

        let minimal = remove_recursively_covered_roots(registrations);

        assert_eq!(minimal, BTreeMap::from([(parent, true), (sibling, true)]));
    }

    #[tokio::test]
    async fn versioned_cache_reuses_a_stable_snapshot_and_reloads_after_invalidation() {
        let cache = VersionedSnapshotCache::new();
        let loads = AtomicUsize::new(0);

        let first = cache
            .get_or_load(|| async {
                loads.fetch_add(1, Ordering::SeqCst);
                ("first".to_string(), true)
            })
            .await;
        let reused = cache
            .get_or_load(|| async {
                loads.fetch_add(1, Ordering::SeqCst);
                ("unexpected".to_string(), true)
            })
            .await;
        cache.invalidate();
        let refreshed = cache
            .get_or_load(|| async {
                loads.fetch_add(1, Ordering::SeqCst);
                ("second".to_string(), true)
            })
            .await;

        assert_eq!(first, "first");
        assert_eq!(reused, "first");
        assert_eq!(refreshed, "second");
        assert_eq!(loads.load(Ordering::SeqCst), 2);
    }

    #[tokio::test]
    async fn invalidation_during_load_cannot_publish_the_stale_snapshot() {
        let cache = Arc::new(VersionedSnapshotCache::new());
        let loads = Arc::new(AtomicUsize::new(0));
        let invalidator = cache.clone();
        let load_count = loads.clone();

        let value = cache
            .get_or_load(move || {
                let invalidator = invalidator.clone();
                let load_count = load_count.clone();
                async move {
                    let attempt = load_count.fetch_add(1, Ordering::SeqCst);
                    if attempt == 0 {
                        invalidator.invalidate();
                    }
                    (attempt + 1, true)
                }
            })
            .await;

        assert_eq!(value, 2);
        assert_eq!(loads.load(Ordering::SeqCst), 2);
    }

    #[tokio::test]
    async fn continuous_invalidations_return_uncached_instead_of_starving_discovery() {
        let cache = VersionedSnapshotCache::new();
        let loads = AtomicUsize::new(0);

        let value = cache
            .get_or_load(|| async {
                let value = loads.fetch_add(1, Ordering::SeqCst) + 1;
                cache.invalidate();
                (value, true)
            })
            .await;

        assert_eq!(value, MAX_SNAPSHOT_LOAD_ATTEMPTS);
        assert_eq!(loads.load(Ordering::SeqCst), MAX_SNAPSHOT_LOAD_ATTEMPTS);
        let next = cache
            .get_or_load(|| async {
                let value = loads.fetch_add(1, Ordering::SeqCst) + 1;
                (value, true)
            })
            .await;
        assert_eq!(next, MAX_SNAPSHOT_LOAD_ATTEMPTS + 1);
    }

    #[tokio::test]
    async fn an_unhealthy_monitor_keeps_discovery_uncached() {
        let cache = VersionedSnapshotCache::new();
        let loads = AtomicUsize::new(0);

        for expected in [1, 2] {
            let value = cache
                .get_or_load(|| async {
                    let value = loads.fetch_add(1, Ordering::SeqCst) + 1;
                    (value, false)
                })
                .await;
            assert_eq!(value, expected);
        }

        assert_eq!(loads.load(Ordering::SeqCst), 2);
    }

    #[tokio::test]
    async fn concurrent_uncacheable_readers_share_one_scan_but_a_later_read_retries() {
        let cache = VersionedSnapshotCache::new();
        let loads = AtomicUsize::new(0);
        let mut leader = Box::pin(cache.get_or_load(|| async {
            loads.fetch_add(1, Ordering::SeqCst);
            ("unhealthy".to_owned(), false)
        }));
        // Hold the load gate while every follower has observed this flight.
        let gate = cache.load_gate.lock().await;
        assert!(
            std::future::poll_fn(|cx| std::task::Poll::Ready(std::future::Future::poll(
                leader.as_mut(),
                cx
            )))
            .await
            .is_pending()
        );
        let mut followers = (0..8)
            .map(|_| {
                Box::pin(cache.get_or_load(|| async {
                    loads.fetch_add(1, Ordering::SeqCst);
                    ("unexpected rescan".to_owned(), false)
                }))
            })
            .collect::<Vec<_>>();
        for follower in &mut followers {
            assert!(
                std::future::poll_fn(|cx| std::task::Poll::Ready(std::future::Future::poll(
                    follower.as_mut(),
                    cx
                )))
                .await
                .is_pending()
            );
        }
        drop(gate);
        assert_eq!(leader.await, "unhealthy");
        for follower in followers {
            assert_eq!(follower.await, "unhealthy");
        }
        assert_eq!(loads.load(Ordering::SeqCst), 1);
        let retry = cache
            .get_or_load(|| async {
                loads.fetch_add(1, Ordering::SeqCst);
                ("repaired".to_owned(), true)
            })
            .await;
        assert_eq!(retry, "repaired");
        assert_eq!(loads.load(Ordering::SeqCst), 2);
    }

    #[tokio::test]
    async fn watched_semantic_source_changes_invalidate_the_cached_snapshot() {
        let temp = tempfile::tempdir().expect("tempdir");
        let build_skill = temp.path().join("build");
        fs::create_dir_all(&build_skill).expect("build-named skill directory");
        let cache = VersionedSnapshotCache::new();
        let monitor = LocalSkillWatchMonitor::new(cache.invalidator());
        monitor.start();
        let roots = vec![LocalSkillWatchRoot::recursive(temp.path().to_path_buf())];
        let loads = AtomicUsize::new(0);

        let first = cache
            .get_or_load(|| async {
                let value = loads.fetch_add(1, Ordering::SeqCst) + 1;
                let cacheable = monitor.sync_roots(roots.clone()).await;
                (value, cacheable)
            })
            .await;

        let skill_file = build_skill.join("SKILL.md");
        fs::write(
            &skill_file,
            "---\nname: build\ndescription: Build workflow\n---\n",
        )
        .expect("write skill file");

        let refreshed = tokio::time::timeout(Duration::from_secs(5), async {
            loop {
                let value = cache
                    .get_or_load(|| async {
                        let value = loads.fetch_add(1, Ordering::SeqCst) + 1;
                        let cacheable = monitor.sync_roots(roots.clone()).await;
                        (value, cacheable)
                    })
                    .await;
                if value > first {
                    break value;
                }
                tokio::time::sleep(Duration::from_millis(25)).await;
            }
        })
        .await
        .expect("watched Skill change should invalidate the cache");

        assert!(refreshed > first);
    }

    #[tokio::test]
    async fn replacing_a_watched_directory_rebinds_before_caching_again() {
        let temp = tempfile::tempdir().expect("tempdir");
        let root = temp.path().join("skills");
        fs::create_dir_all(&root).expect("skill root");
        let skill_file = root.join("SKILL.md");
        fs::write(&skill_file, "first").expect("first snapshot");
        let cache = VersionedSnapshotCache::new();
        let monitor = LocalSkillWatchMonitor::new(cache.invalidator());
        monitor.start();
        let roots = vec![LocalSkillWatchRoot::recursive(root.clone())];

        let first = cache
            .get_or_load(|| async {
                let value = fs::read_to_string(&skill_file).unwrap_or_default();
                let cacheable = monitor.sync_roots(roots.clone()).await;
                (value, cacheable)
            })
            .await;
        assert_eq!(first, "first");

        fs::remove_dir_all(&root).expect("remove watched root");
        fs::create_dir_all(&root).expect("replace watched root");
        fs::write(&skill_file, "second").expect("replacement snapshot");
        let second = wait_for_snapshot(&cache, &monitor, &roots, &skill_file, "second").await;
        assert_eq!(second, "second");

        fs::write(&skill_file, "third").expect("modify replacement");
        let third = wait_for_snapshot(&cache, &monitor, &roots, &skill_file, "third").await;
        assert_eq!(third, "third");
    }

    async fn wait_for_snapshot(
        cache: &VersionedSnapshotCache<String>,
        monitor: &LocalSkillWatchMonitor,
        roots: &[LocalSkillWatchRoot],
        skill_file: &std::path::Path,
        expected: &str,
    ) -> String {
        tokio::time::timeout(Duration::from_secs(5), async {
            loop {
                let value = cache
                    .get_or_load(|| async {
                        let value = fs::read_to_string(skill_file).unwrap_or_default();
                        let cacheable = monitor.sync_roots(roots.to_vec()).await;
                        (value, cacheable)
                    })
                    .await;
                if value == expected {
                    break value;
                }
                tokio::time::sleep(Duration::from_millis(25)).await;
            }
        })
        .await
        .expect("watched directory update should invalidate the cache")
    }
}
