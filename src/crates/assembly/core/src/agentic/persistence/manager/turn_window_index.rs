//! Versioned physical index used by native Turn window reads.

use super::*;
use openbitfun_services_core::json_store::JsonFileRevision;
use std::collections::VecDeque;

const MAX_INDEXES: usize = 4;
const MAX_INDEX_BYTES: u64 = 32 * 1024 * 1024;

#[derive(Default)]
pub(super) struct TurnWindowIndexCache {
    entries: VecDeque<CachedIndex>,
}

#[derive(Clone, PartialEq, Eq)]
pub(super) struct TurnWindowRevision {
    turns: Option<JsonFileRevision>,
    catalog: Option<JsonFileRevision>,
}

pub(super) struct TurnWindowIndex {
    pub paths: Arc<Vec<(usize, PathBuf)>>,
    pub catalog: SessionTurnCatalog,
    pub needs_catalog_repair: bool,
}

struct CachedIndex {
    key: PathBuf,
    revision: TurnWindowRevision,
    index: Arc<TurnWindowIndex>,
    bytes: u64,
}

impl PersistenceManager {
    pub(super) async fn turn_window_revision(
        &self,
        workspace_path: &Path,
        session_id: &str,
    ) -> Option<TurnWindowRevision> {
        let turns_dir = self.turns_dir(workspace_path, session_id);
        let catalog_path = self.turn_catalog_path(workspace_path, session_id);
        let (turns, catalog) = tokio::try_join!(
            JsonFileStore.revision(&turns_dir),
            JsonFileStore.revision(&catalog_path),
        )
        .ok()?;
        Some(TurnWindowRevision { turns, catalog })
    }

    pub(super) async fn remember_turn_window_index(
        &self,
        workspace_path: &Path,
        session_id: &str,
        observed: &TurnWindowRevision,
        catalog_replaced: bool,
        index: Arc<TurnWindowIndex>,
    ) {
        let Some(revision) = self.turn_window_revision(workspace_path, session_id).await else {
            return;
        };
        if revision.turns != observed.turns
            || (!catalog_replaced && revision.catalog != observed.catalog)
        {
            return;
        }
        let bytes = revision
            .catalog
            .as_ref()
            .map_or(0, |file| file.len.saturating_mul(2))
            .saturating_add(
                index
                    .paths
                    .iter()
                    .map(|(_, path)| {
                        (std::mem::size_of::<(usize, PathBuf)>()
                            + std::mem::size_of::<SessionTurnCatalogEntry>()
                            + path.as_os_str().len()) as u64
                    })
                    .sum(),
            );
        if bytes > MAX_INDEX_BYTES {
            return;
        }
        let key = self.turn_catalog_path(workspace_path, session_id);
        let mut cache = self.turn_window_index_cache.lock().await;
        cache.entries.retain(|entry| entry.key != key);
        while cache.entries.len() >= MAX_INDEXES
            || cache.entries.iter().map(|entry| entry.bytes).sum::<u64>() + bytes > MAX_INDEX_BYTES
        {
            cache.entries.pop_front();
        }
        cache.entries.push_back(CachedIndex {
            key,
            revision,
            index,
            bytes,
        });
    }

    pub(super) async fn forget_turn_window_index(&self, workspace_path: &Path, session_id: &str) {
        let key = self.turn_catalog_path(workspace_path, session_id);
        self.turn_window_index_cache
            .lock()
            .await
            .entries
            .retain(|entry| entry.key != key);
    }

    pub(super) async fn load_turn_window_index(
        &self,
        workspace_path: &Path,
        session_id: &str,
    ) -> OpenBitFunResult<(Arc<TurnWindowIndex>, Option<TurnWindowRevision>)> {
        let revision = self.turn_window_revision(workspace_path, session_id).await;
        let key = self.turn_catalog_path(workspace_path, session_id);
        let mut unchanged_paths = None;
        if let Some(revision) = &revision {
            let mut cache = self.turn_window_index_cache.lock().await;
            if let Some(position) = cache.entries.iter().position(|entry| entry.key == key) {
                let entry = cache.entries.remove(position).expect("located Turn index");
                if entry.revision == *revision {
                    let index = Arc::clone(&entry.index);
                    cache.entries.push_back(entry);
                    return Ok((index, Some(revision.clone())));
                }
                if entry.revision.turns == revision.turns {
                    unchanged_paths = Some(Arc::clone(&entry.index.paths));
                }
            }
        }
        let paths = match unchanged_paths {
            Some(paths) => paths,
            None => Arc::new(
                self.list_indexed_turn_paths(workspace_path, session_id)
                    .await?,
            ),
        };
        let projection = self
            .build_session_turn_catalog_projection_with_physical(
                workspace_path,
                session_id,
                paths.iter().map(|(index, _)| *index).collect(),
                &[],
                paths.len(),
            )
            .await?;
        let index = Arc::new(TurnWindowIndex {
            paths,
            catalog: projection.physical,
            needs_catalog_repair: projection.physical_changed,
        });
        if let Some(revision) = &revision {
            self.remember_turn_window_index(
                workspace_path,
                session_id,
                revision,
                false,
                Arc::clone(&index),
            )
            .await;
        }
        Ok((index, revision))
    }
}
