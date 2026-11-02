//! Per-store operation probes; concurrent fixtures never share counters.
use super::*;

#[derive(Clone, Copy, Debug, Default, PartialEq, Eq)]
pub(super) struct Counts {
    pub source_reads: usize,
    pub snapshot_reads: usize,
    pub snapshot_writes: usize,
    pub conversions: usize,
    pub index_writes: usize,
    pub catalog_notifications: usize,
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
            .insert(root.to_path_buf(), Counts::default())
            .is_none());
        Self(root.to_path_buf())
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
