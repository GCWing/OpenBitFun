//! Immutable, host-owned history bodies. Only request windows are copied on
//! warm reads; mutable view metadata is projected from the current reference.

use super::*;
use crate::service::session::SessionTurnCatalog;
use openbitfun_services_core::json_store::JsonFileRevision;
use std::collections::VecDeque;
use std::ops::Range;
use std::sync::Weak;

const MAX_HISTORY_BYTES: usize = 64 * 1024 * 1024;
const MAX_HISTORIES: usize = 128;

struct FrozenHistory {
    snapshot: Snapshot,
    catalog: SessionTurnCatalog,
    turn_positions: HashMap<usize, usize>,
    turn_ids: HashSet<String>,
    resident_bytes: usize,
}

impl FrozenHistory {
    fn new(root: &Path, snapshot: Snapshot, file_bytes: u64) -> Self {
        let catalog =
            crate::agentic::persistence::manager::external_history_catalog(&snapshot.bundle);
        let turn_positions: HashMap<_, _> = snapshot
            .bundle
            .turns
            .iter()
            .enumerate()
            .map(|(position, turn)| (turn.turn_index, position))
            .collect();
        let turn_ids: HashSet<_> = snapshot
            .bundle
            .turns
            .iter()
            .map(|turn| turn.turn_id.clone())
            .collect();
        // Conservative resident estimate, including decoded payload/container
        // overhead, turn storage, derived previews and lookup tables. This is
        // a retention budget, not a limit on readable history or file size.
        let resident_bytes = usize::try_from(file_bytes)
            .unwrap_or(usize::MAX)
            .saturating_mul(4)
            .saturating_add(std::mem::size_of::<Self>())
            .saturating_add(
                snapshot
                    .bundle
                    .turns
                    .capacity()
                    .saturating_mul(std::mem::size_of::<DialogTurnData>()),
            )
            .saturating_add(
                catalog
                    .entries
                    .capacity()
                    .saturating_mul(std::mem::size_of::<
                        crate::service::session::SessionTurnCatalogEntry,
                    >()),
            )
            .saturating_add(
                turn_positions
                    .capacity()
                    .saturating_mul(3 * std::mem::size_of::<usize>()),
            )
            .saturating_add(
                turn_ids
                    .capacity()
                    .saturating_mul(std::mem::size_of::<String>() + 1),
            );
        #[cfg(test)]
        probes::record(root, |counts| counts.catalog_builds += 1);
        #[cfg(not(test))]
        let _ = root;
        Self {
            snapshot,
            catalog,
            turn_positions,
            turn_ids,
            resident_bytes,
        }
    }
}

pub(crate) struct HistorySnapshot {
    pub metadata: SessionMetadata,
    history: Arc<FrozenHistory>,
    #[cfg(test)]
    root: PathBuf,
}

impl HistorySnapshot {
    fn view(root: &Path, history: Arc<FrozenHistory>, entry: &Reference) -> Self {
        let mut metadata = history.snapshot.bundle.metadata.clone();
        overlay_view_metadata(&mut metadata, entry);
        #[cfg(not(test))]
        let _ = root;
        Self {
            metadata,
            history,
            #[cfg(test)]
            root: root.to_path_buf(),
        }
    }

    pub(crate) fn turns(&self) -> &[DialogTurnData] {
        &self.history.snapshot.bundle.turns
    }
    pub(crate) fn catalog(&self) -> &SessionTurnCatalog {
        &self.history.catalog
    }
    pub(crate) fn turn_position(&self, index: usize) -> Option<usize> {
        self.history.turn_positions.get(&index).copied()
    }
    pub(super) fn contains_turn(&self, id: &str) -> bool {
        self.history.turn_ids.contains(id)
    }

    pub(crate) fn copy_turns(&self, range: Range<usize>) -> Vec<DialogTurnData> {
        #[cfg(test)]
        probes::record(&self.root, |counts| counts.copied_turns += range.len());
        self.turns()[range].to_vec()
    }

    pub(crate) fn into_bundle(self) -> OfflineSessionBundle {
        let Self {
            metadata,
            history,
            #[cfg(test)]
            root,
        } = self;
        let turns = match Arc::try_unwrap(history) {
            // Oversize or evicted versions may have just this reader. A full
            // restore/fork can take ownership instead of doubling the body.
            Ok(history) => history.snapshot.bundle.turns,
            Err(history) => {
                #[cfg(test)]
                probes::record(&root, |counts| {
                    counts.copied_turns += history.snapshot.bundle.turns.len()
                });
                history.snapshot.bundle.turns.clone()
            }
        };
        OfflineSessionBundle { metadata, turns }
    }
}

struct CachedHistory {
    path: PathBuf,
    revision: JsonFileRevision,
    history: Arc<FrozenHistory>,
}

#[derive(Default)]
struct HistoryCache {
    entries: VecDeque<CachedHistory>,
    resident_bytes: usize,
    readers: HashMap<PathBuf, Weak<tokio::sync::Mutex<()>>>,
}

impl HistoryCache {
    fn remove(&mut self, path: &Path) -> Option<CachedHistory> {
        let index = self.entries.iter().position(|entry| entry.path == path)?;
        let entry = self.entries.remove(index)?;
        self.resident_bytes -= entry.history.resident_bytes;
        Some(entry)
    }

    fn get(&mut self, path: &Path, revision: &JsonFileRevision) -> Option<Arc<FrozenHistory>> {
        let entry = self.remove(path)?;
        if entry.revision != *revision {
            return None;
        }
        let history = entry.history.clone();
        self.resident_bytes += history.resident_bytes;
        self.entries.push_back(entry);
        Some(history)
    }

    fn insert(&mut self, entry: CachedHistory, budget: usize) {
        self.remove(&entry.path);
        if entry.history.resident_bytes > budget {
            return;
        }
        while self.entries.len() >= MAX_HISTORIES
            || self.resident_bytes > budget - entry.history.resident_bytes
        {
            let Some(oldest) = self.entries.pop_front() else {
                break;
            };
            self.resident_bytes -= oldest.history.resident_bytes;
        }
        self.resident_bytes += entry.history.resident_bytes;
        self.entries.push_back(entry);
    }

    fn reader(&mut self, path: &Path) -> Arc<tokio::sync::Mutex<()>> {
        self.readers.retain(|_, lock| lock.strong_count() > 0);
        if let Some(lock) = self.readers.get(path).and_then(Weak::upgrade) {
            return lock;
        }
        let lock = Arc::new(tokio::sync::Mutex::new(()));
        self.readers
            .insert(path.to_path_buf(), Arc::downgrade(&lock));
        lock
    }
}

static HISTORIES: LazyLock<tokio::sync::Mutex<HistoryCache>> = LazyLock::new(Default::default);

async fn revision(path: &Path) -> OpenBitFunResult<JsonFileRevision> {
    match JsonFileStore.revision(path).await.map_err(index_error)? {
        Some(revision) => Ok(revision),
        None => {
            HISTORIES.lock().await.remove(path);
            Err(index_error(
                "The viewed external history version is unavailable; reopen the source session",
            ))
        }
    }
}

pub(super) async fn read(
    root: &Path,
    entry: &Reference,
    version: &str,
) -> OpenBitFunResult<HistorySnapshot> {
    let path = snapshot_path(root, &entry.metadata.session_id, version)?;
    let current = revision(&path).await?;
    if let Some(history) = HISTORIES.lock().await.get(&path, &current) {
        validate_snapshot(&history.snapshot, entry, version)?;
        return Ok(HistorySnapshot::view(root, history, entry));
    }
    // Coalesce readers of this version without holding the global LRU lock over
    // disk IO, or serializing unrelated workspaces behind a long cold read.
    let reader = HISTORIES.lock().await.reader(&path);
    let _read = reader.lock().await;
    let before = revision(&path).await?;
    if let Some(history) = HISTORIES.lock().await.get(&path, &before) {
        validate_snapshot(&history.snapshot, entry, version)?;
        return Ok(HistorySnapshot::view(root, history, entry));
    }
    #[cfg(test)]
    super::super::test_io::record(root, |counts| counts.snapshot_reads += 1);
    #[cfg(test)]
    probes::record(root, |counts| {
        counts.snapshot_reads += 1;
        counts.snapshot_bytes += before.len;
    });
    let snapshot: Snapshot = JsonFileStore
        .read_optional(&path)
        .await
        .map_err(index_error)?
        .ok_or_else(|| {
            index_error(
                "The viewed external history version is unavailable; reopen the source session",
            )
        })?;
    validate_snapshot(&snapshot, entry, version)?;
    snapshot.bundle.validate().map_err(index_error)?;
    let history = Arc::new(FrozenHistory::new(root, snapshot, before.len));
    if revision(&path).await? == before {
        HISTORIES.lock().await.insert(
            CachedHistory {
                path,
                revision: before,
                history: history.clone(),
            },
            MAX_HISTORY_BYTES,
        );
    }
    Ok(HistorySnapshot::view(root, history, entry))
}

pub(super) async fn remember(
    root: &Path,
    entry: &Reference,
    version: &str,
    bundle: OfflineSessionBundle,
) -> OpenBitFunResult<HistorySnapshot> {
    let path = snapshot_path(root, &entry.metadata.session_id, version)?;
    let current = revision(&path).await?;
    if let Some(history) = HISTORIES.lock().await.get(&path, &current) {
        validate_snapshot(&history.snapshot, entry, version)?;
        return Ok(HistorySnapshot::view(root, history, entry));
    }
    let snapshot = Snapshot {
        schema_version: 1,
        ecosystem_id: entry.ecosystem_id.clone(),
        source_session_id: entry.source_session_id.clone(),
        version: version.into(),
        bundle,
    };
    validate_snapshot(&snapshot, entry, version)?;
    snapshot.bundle.validate().map_err(index_error)?;
    let history = Arc::new(FrozenHistory::new(root, snapshot, current.len));
    HISTORIES.lock().await.insert(
        CachedHistory {
            path,
            revision: current,
            history: history.clone(),
        },
        MAX_HISTORY_BYTES,
    );
    Ok(HistorySnapshot::view(root, history, entry))
}

#[cfg(test)]
mod tests;

#[cfg(test)]
pub(super) mod probes {
    use super::*;

    #[derive(Debug, Default, PartialEq, Eq)]
    pub(super) struct Counts {
        pub snapshot_reads: usize,
        pub snapshot_bytes: u64,
        pub catalog_builds: usize,
        pub copied_turns: usize,
    }
    static COUNTERS: LazyLock<Mutex<HashMap<PathBuf, Counts>>> = LazyLock::new(Default::default);
    pub(super) fn record(root: &Path, update: impl FnOnce(&mut Counts)) {
        if let Some(counts) = COUNTERS.lock().unwrap().get_mut(root) {
            update(counts);
        }
    }
    pub(super) struct Probe(PathBuf);
    impl Probe {
        pub(super) fn new(root: &Path) -> Self {
            assert!(COUNTERS
                .lock()
                .unwrap()
                .insert(root.into(), Counts::default())
                .is_none());
            Self(root.into())
        }
        pub(super) fn take(&self) -> Counts {
            std::mem::take(COUNTERS.lock().unwrap().get_mut(&self.0).unwrap())
        }
    }
    impl Drop for Probe {
        fn drop(&mut self) {
            COUNTERS.lock().unwrap().remove(&self.0);
        }
    }
}
