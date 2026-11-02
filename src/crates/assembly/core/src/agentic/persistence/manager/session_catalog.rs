//! Host-owned, bounded navigation snapshots. Persisted indexes and their
//! filesystem revisions remain authoritative, including writes by other hosts.

use super::*;
use openbitfun_services_core::json_store::JsonFileRevision;
use openbitfun_services_core::session::page::{PreparedSessionCatalog, SessionCatalogQuery};
use std::collections::{HashSet, VecDeque};

const MAX_CATALOGS: usize = 8;
const MAX_CATALOG_BYTES: u64 = 32 * 1024 * 1024;

#[derive(Default)]
pub(super) struct CatalogCache {
    entries: VecDeque<CachedCatalog>,
    #[cfg(test)]
    builds: usize,
}

#[derive(Debug, PartialEq, Eq)]
struct CatalogRevision {
    native: Option<JsonFileRevision>,
    #[cfg(feature = "external-sources")]
    external: Option<JsonFileRevision>,
}

impl CatalogRevision {
    async fn read(root: &Path) -> OpenBitFunResult<Self> {
        Ok(Self {
            native: JsonFileStore
                .revision(&SessionStorageLayout::new(root).index_path())
                .await
                .map_err(|error| OpenBitFunError::io(error.to_string()))?,
            #[cfg(feature = "external-sources")]
            external: crate::external_session_import::deferred::catalog_revision(root).await?,
        })
    }

    fn cursor_revision(&self, root: &Path, query: &SessionCatalogQuery) -> String {
        let mut sort_timestamps = query.sort_timestamps.iter().collect::<Vec<_>>();
        sort_timestamps.sort_unstable_by(|left, right| left.0.cmp(right.0));
        let mut hash = Sha256::new();
        hash.update(format!("{root:?}\n{self:?}\n"));
        hash.update(
            serde_json::to_vec(&(
                &query.workspace_id,
                query.ordering,
                &query.source,
                sort_timestamps,
            ))
            .expect("catalog query is serializable"),
        );
        format!("{:x}", hash.finalize())
    }
}

struct CachedCatalog {
    root: PathBuf,
    query: SessionCatalogQuery,
    revision: CatalogRevision,
    prepared: PreparedSessionCatalog,
    native_ids: HashSet<String>,
    bytes: u64,
}

impl CachedCatalog {
    fn has_missing_native_entry(&self, page: &SessionMetadataPage) -> bool {
        let layout = SessionStorageLayout::new(&self.root);
        page.sessions.iter().any(|metadata| {
            self.native_ids.contains(&metadata.session_id)
                && !layout.metadata_path(&metadata.session_id).exists()
        })
    }
}

impl PersistenceManager {
    #[cfg(test)]
    pub(crate) async fn session_catalog_build_count_for_test(&self) -> usize {
        self.catalog_cache.lock().await.builds
    }

    pub(super) async fn list_cached_session_catalog_page(
        &self,
        workspace: &Path,
        cursor: Option<&str>,
        limit: usize,
        query: &SessionCatalogQuery,
    ) -> OpenBitFunResult<SessionMetadataPage> {
        let root = self.project_sessions_dir(workspace);
        // Serialize builds so simultaneous startup/expansion requests do not
        // parse and sort the same version twice.
        let mut cache = self.catalog_cache.lock().await;
        let mut before = match CatalogRevision::read(&root).await {
            Ok(revision) => revision,
            Err(_) => {
                // Withdraw the query acknowledgement so clients restart their
                // legacy traversal instead of mixing an unversioned page in.
                return self
                    .list_uncached_session_metadata_page(workspace, cursor, limit, None)
                    .await;
            }
        };
        let mut rebuild = false;
        if let Some(index) = cache
            .entries
            .iter()
            .position(|entry| entry.root == root && entry.query == *query)
        {
            let entry = cache.entries.remove(index).expect("located catalog");
            if entry.revision == before {
                let page = entry.prepared.page(cursor, limit);
                if !entry.has_missing_native_entry(&page) {
                    cache.entries.push_back(entry);
                    return Ok(page);
                }
                rebuild = true;
            }
        }
        // Superseded versions cannot be reused by another query either.
        cache
            .entries
            .retain(|entry| entry.root != root || entry.revision == before);
        let store = self.session_metadata_store(workspace);
        if rebuild {
            store
                .rebuild_index()
                .await
                .map_err(Self::session_metadata_store_error)?;
        }
        let (native, native_revision) = store
            .indexed_metadata_snapshot()
            .await
            .map_err(Self::session_metadata_store_error)?;
        before.native = native_revision;
        let native_ids = native
            .iter()
            .map(|entry| entry.session_id.clone())
            .collect();
        #[cfg(feature = "external-sources")]
        let metadata = {
            match crate::external_session_import::deferred::has_references(&root).await {
                Ok(true) => {
                    crate::external_session_import::deferred::merge_metadata(&root, native).await?
                }
                Ok(false) => native,
                // Preserve the established warning and independently readable
                // native rows instead of caching an incomplete merged catalog.
                Err(_) => {
                    return self
                        .list_uncached_session_metadata_page(workspace, cursor, limit, None)
                        .await
                }
            }
        };
        #[cfg(not(feature = "external-sources"))]
        let metadata = native;
        // Account for owned metadata plus lookup tables; oversized projections
        // can still serve a page without occupying the persistent cache.
        let bytes = serde_json::to_vec(&metadata)
            .map(|bytes| bytes.len() as u64 * 2)
            .unwrap_or(MAX_CATALOG_BYTES + 1)
            .saturating_add(
                (metadata.len() * (std::mem::size_of::<SessionMetadata>() + 128)) as u64,
            );
        let prepared = PreparedSessionCatalog::new(metadata, Some(query))
            .with_revision(before.cursor_revision(&root, query));
        #[cfg(test)]
        {
            cache.builds += 1;
        }
        let entry = CachedCatalog {
            root,
            query: query.clone(),
            revision: before,
            prepared,
            native_ids,
            bytes,
        };
        let page = entry.prepared.page(cursor, limit);
        if entry.has_missing_native_entry(&page) {
            // The index may have been stale before this cache existed. Repair
            // through its IO owner, then let the next request cache that version.
            store
                .rebuild_index()
                .await
                .map_err(Self::session_metadata_store_error)?;
            let mut repaired = self
                .list_uncached_session_metadata_page(workspace, None, limit, Some(query))
                .await?;
            repaired.catalog_reset = cursor.is_some();
            return Ok(repaired);
        }
        if page.catalog_query.is_some()
            && bytes <= MAX_CATALOG_BYTES
            && CatalogRevision::read(&entry.root)
                .await
                .is_ok_and(|after| after == entry.revision)
        {
            while cache.entries.len() >= MAX_CATALOGS
                || cache
                    .entries
                    .iter()
                    .map(|entry| entry.bytes)
                    .sum::<u64>()
                    .saturating_add(bytes)
                    > MAX_CATALOG_BYTES
            {
                cache.entries.pop_front();
            }
            cache.entries.push_back(entry);
        }
        Ok(page)
    }
}
