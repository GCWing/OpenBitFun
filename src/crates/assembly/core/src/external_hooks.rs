//! Product wiring for the runtime-free external Hook catalog.
//!
//! This service is deliberately separate from the command/tool/subagent/MCP
//! control plane. Inspecting Hooks must not load code, recover workers, mutate
//! integration policy, or refresh executable external capabilities.

pub use openbitfun_product_domains::external_hook_catalog::{
    ExternalHookCatalogEntry, ExternalHookCatalogSnapshotV1, ExternalHookHandlerKind,
    ExternalHookMatcherSummary, ExternalHookNativeActivation, ExternalHookProjectionStatus,
    ExternalHookSource, ExternalHookSourceKind, EXTERNAL_HOOK_CATALOG_SCHEMA_V1,
};
pub use openbitfun_product_domains::external_sources::{ExecutionDomainId, ExternalSourceContext};

use crate::external_sources::host_execution_domain_id;
#[cfg(feature = "git")]
use crate::service::workspace::{global_worktree_topology_service, WorktreeTopologyFreshness};
use openbitfun_claude_code_adapter::{ClaudeCodeHookProvider, ClaudeCodeHookProviderOptions};
use openbitfun_codex_adapter::{CodexHookProvider, CodexHookProviderOptions};
use openbitfun_dsh_adapter::DshHookProvider;
use openbitfun_external_sources::ExternalHookCatalogCoordinator;
use openbitfun_opencode_adapter::{OpenCodeHookProvider, OpenCodeHookProviderOptions};
use openbitfun_pi_adapter::PiHookProvider;
use openbitfun_product_domains::external_hook_catalog::ExternalHookSourceProvider;
use openbitfun_product_domains::external_hook_import::PreparedExternalHookImport;
use openbitfun_product_domains::external_sources::{
    ExternalSourceOperationError, ExternalSourceOperationErrorCode, ExternalSourceOperationResult,
    ExternalSourceProviderError, SourceKey,
};
use std::collections::BTreeMap;
use std::path::PathBuf;
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::{Arc, OnceLock};
use std::time::Duration;

const MAX_CACHED_WORKSPACES: usize = 32;
#[cfg(not(test))]
const HOOK_PROVIDER_DISCOVERY_TIMEOUT: Duration = Duration::from_secs(5);
#[cfg(test)]
const HOOK_PROVIDER_DISCOVERY_TIMEOUT: Duration = Duration::from_millis(100);

pub(crate) struct WorkspaceExternalHookCatalogService {
    coordinator: Arc<ExternalHookCatalogCoordinator>,
    refresh_gate: tokio::sync::Mutex<()>,
    preparations: tokio::sync::Mutex<
        BTreeMap<
            (SourceKey, String),
            Arc<
                tokio::sync::OnceCell<
                    Result<PreparedExternalHookImport, ExternalSourceProviderError>,
                >,
            >,
        >,
    >,
}

impl WorkspaceExternalHookCatalogService {
    pub(crate) fn new(
        context: ExternalSourceContext,
        providers: Vec<Arc<dyn ExternalHookSourceProvider>>,
    ) -> Result<Self, String> {
        Ok(Self {
            coordinator: Arc::new(ExternalHookCatalogCoordinator::new(context, providers)?),
            refresh_gate: tokio::sync::Mutex::new(()),
            preparations: tokio::sync::Mutex::new(BTreeMap::new()),
        })
    }

    pub(crate) fn snapshot(&self) -> ExternalHookCatalogSnapshotV1 {
        self.coordinator.snapshot()
    }

    pub(crate) async fn snapshot_or_refresh(
        self: &Arc<Self>,
        force_refresh: bool,
    ) -> ExternalSourceOperationResult<ExternalHookCatalogSnapshotV1> {
        let snapshot = self.snapshot();
        if force_refresh || snapshot.discovery_pending {
            self.refresh().await
        } else {
            Ok(snapshot)
        }
    }

    pub(crate) async fn refresh(
        self: &Arc<Self>,
    ) -> ExternalSourceOperationResult<ExternalHookCatalogSnapshotV1> {
        let _refresh_guard = self.refresh_gate.lock().await;
        // The read-only Hook catalog never needs concurrent generations. A
        // repeated Desktop/TUI refresh observes the shared pending snapshot
        // instead of queuing work behind an uncancellable filesystem worker.
        // This keeps the existing lane's 30-second terminal bound intact.
        if self.coordinator.has_in_flight().await {
            return Ok(self.coordinator.snapshot());
        }
        let started = std::time::Instant::now();
        let batch = self
            .coordinator
            .discover(HOOK_PROVIDER_DISCOVERY_TIMEOUT)
            .await;
        let snapshot = self.coordinator.apply_discovery_results(batch.immediate);
        for deferred in batch.deferred {
            schedule_deferred_hook_discovery(Arc::clone(self), deferred);
        }
        log::info!(
            "External Hook catalog refreshed sources={} entries={} diagnostics={} stale_providers={} failed_providers={} elapsed_ms={}",
            snapshot.sources.len(),
            snapshot.entries.len(),
            snapshot.diagnostics.len(),
            snapshot.stale_provider_ids.len(),
            snapshot.failed_provider_ids.len(),
            started.elapsed().as_millis(),
        );
        Ok(snapshot)
    }

    pub(crate) async fn prepare_import(
        &self,
        source: SourceKey,
        expected_catalog_content_version: String,
    ) -> Result<PreparedExternalHookImport, ExternalSourceProviderError> {
        let key = (source.clone(), expected_catalog_content_version.clone());
        let cell = {
            let mut preparations = self.preparations.lock().await;
            Arc::clone(
                preparations
                    .entry(key.clone())
                    .or_insert_with(|| Arc::new(tokio::sync::OnceCell::new())),
            )
        };
        let coordinator = Arc::clone(&self.coordinator);
        let result = cell
            .get_or_init(|| async move {
                tokio::task::spawn_blocking(move || {
                    coordinator.prepare_import(&source, &expected_catalog_content_version)
                })
                .await
                .unwrap_or_else(|error| {
                    Err(ExternalSourceProviderError::new(
                        "external_hook.import_worker_failed",
                        format!("Hook import preparation worker failed: {error}"),
                        true,
                    ))
                })
            })
            .await
            .clone();
        let mut preparations = self.preparations.lock().await;
        if preparations
            .get(&key)
            .is_some_and(|current| Arc::ptr_eq(current, &cell))
        {
            preparations.remove(&key);
        }
        result
    }
}

fn schedule_deferred_hook_discovery(
    service: Arc<WorkspaceExternalHookCatalogService>,
    deferred: openbitfun_external_sources::DeferredDiscovery<
        openbitfun_external_sources::ExternalHookDiscoveryResult,
    >,
) {
    tokio::spawn(async move {
        let mut deferred = deferred;
        loop {
            let Some((completed, observer)) = service.coordinator.complete_deferred(deferred).await
            else {
                return;
            };
            {
                // Serialize lane finalization, snapshot publication, and a new
                // refresh exactly like the shared external-source service.
                let _refresh_guard = service.refresh_gate.lock().await;
                let Some(result) = service.coordinator.finalize_deferred(completed).await else {
                    return;
                };
                service.coordinator.apply_discovery_result(result);
            }
            let Some(observer) = observer else {
                return;
            };
            let Some(next) = service.coordinator.resume_abandoned(observer).await else {
                return;
            };
            deferred = next;
        }
    });
}

struct CachedHookCatalogService {
    service: Arc<WorkspaceExternalHookCatalogService>,
    last_used: u64,
}

fn service_cache() -> &'static tokio::sync::Mutex<BTreeMap<Option<String>, CachedHookCatalogService>>
{
    static CACHE: OnceLock<tokio::sync::Mutex<BTreeMap<Option<String>, CachedHookCatalogService>>> =
        OnceLock::new();
    CACHE.get_or_init(|| tokio::sync::Mutex::new(BTreeMap::new()))
}

fn next_access_tick() -> u64 {
    static ACCESS_TICK: AtomicU64 = AtomicU64::new(1);
    ACCESS_TICK.fetch_add(1, Ordering::Relaxed)
}

pub(crate) async fn service_for(
    workspace_id: Option<&str>,
) -> ExternalSourceOperationResult<Arc<WorkspaceExternalHookCatalogService>> {
    let workspace_root = local_workspace_root(workspace_id).await?;
    let cache_key = workspace_id.map(str::to_owned);
    {
        let mut cache = service_cache().lock().await;
        if let Some(cached) = cache.get_mut(&cache_key) {
            cached.last_used = next_access_tick();
            return Ok(Arc::clone(&cached.service));
        }
    }
    let project_topology = hook_project_topology(workspace_root.as_deref()).await;
    let project_boundary = project_topology
        .as_ref()
        .map(|topology| topology.current_root.clone());
    let primary_checkout_root = project_topology
        .as_ref()
        .and_then(|topology| topology.primary_root.clone());
    let service = Arc::new(
        WorkspaceExternalHookCatalogService::new(
            ExternalSourceContext {
                workspace_root: workspace_root.clone(),
                execution_domain_id: host_execution_domain_id().map_err(|error| {
                    ExternalSourceOperationError::new(
                        ExternalSourceOperationErrorCode::Internal,
                        error,
                        false,
                    )
                })?,
            },
            vec![
                Arc::new(DshHookProvider::default()),
                Arc::new(PiHookProvider::default()),
                Arc::new(OpenCodeHookProvider::new(OpenCodeHookProviderOptions {
                    project_root_override: project_boundary.clone(),
                    ..OpenCodeHookProviderOptions::default()
                })),
                Arc::new(ClaudeCodeHookProvider::new(ClaudeCodeHookProviderOptions {
                    project_root_override: project_boundary.clone(),
                    ..ClaudeCodeHookProviderOptions::default()
                })),
                Arc::new(CodexHookProvider::new(CodexHookProviderOptions {
                    project_root_override: project_boundary,
                    project_hooks_root_override: primary_checkout_root,
                    ..CodexHookProviderOptions::default()
                })),
            ],
        )
        .map_err(|error| {
            ExternalSourceOperationError::new(
                ExternalSourceOperationErrorCode::Internal,
                error,
                false,
            )
        })?,
    );
    let mut cache = service_cache().lock().await;
    if let Some(cached) = cache.get_mut(&cache_key) {
        // Service construction runs without the cache lock. Another caller
        // may have inserted a newer access meanwhile, so allocate a fresh LRU
        // tick instead of moving that shared entry backwards in time.
        cached.last_used = next_access_tick();
        return Ok(Arc::clone(&cached.service));
    }
    if cache.len() >= MAX_CACHED_WORKSPACES {
        let oldest = cache
            .iter()
            .min_by_key(|(key, cached)| (cached.last_used, (*key).clone()))
            .map(|(key, _)| key.clone());
        if let Some(oldest) = oldest {
            cache.remove(&oldest);
        }
    }
    cache.insert(
        cache_key,
        CachedHookCatalogService {
            service: Arc::clone(&service),
            last_used: next_access_tick(),
        },
    );
    Ok(service)
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub(crate) struct HookProjectTopology {
    pub(crate) current_root: PathBuf,
    pub(crate) primary_root: Option<PathBuf>,
}

#[cfg(feature = "git")]
async fn hook_project_topology(
    workspace_root: Option<&std::path::Path>,
) -> Option<HookProjectTopology> {
    let workspace_root = workspace_root?;
    let worktrees = global_worktree_topology_service()
        .list_worktrees(workspace_root, WorktreeTopologyFreshness::Cached)
        .await
        .ok()?;
    resolve_hook_project_topology(
        workspace_root,
        &worktrees
            .iter()
            .map(|worktree| (PathBuf::from(&worktree.path), worktree.is_main))
            .collect::<Vec<_>>(),
    )
}

#[cfg(not(feature = "git"))]
async fn hook_project_topology(
    _workspace_root: Option<&std::path::Path>,
) -> Option<HookProjectTopology> {
    None
}

pub(crate) fn resolve_hook_project_topology(
    workspace_root: &std::path::Path,
    worktrees: &[(PathBuf, bool)],
) -> Option<HookProjectTopology> {
    let main_root = worktrees.iter().find(|(_, is_main)| *is_main)?.0.clone();
    let (current_root, is_main) = worktrees
        .iter()
        .filter_map(|(path, is_main)| {
            workspace_root
                .strip_prefix(path)
                .ok()
                .map(|_| (path, *is_main))
        })
        .max_by_key(|(path, _)| path.components().count())?;
    Some(HookProjectTopology {
        current_root: current_root.clone(),
        primary_root: (!is_main && current_root != &main_root).then_some(main_root),
    })
}

/// Returns a local, static Hook catalog. Remote execution domains are rejected
/// before consulting the local filesystem so remote surfaces cannot
/// accidentally display Hooks from the controller machine.
pub async fn external_hook_catalog_snapshot(
    workspace_id: Option<&str>,
    context: ExternalSourceContext,
    force_refresh: bool,
) -> ExternalSourceOperationResult<ExternalHookCatalogSnapshotV1> {
    let host_domain = host_execution_domain_id().map_err(|error| {
        ExternalSourceOperationError::new(ExternalSourceOperationErrorCode::Internal, error, false)
    })?;
    if context.execution_domain_id != host_domain {
        return Err(ExternalSourceOperationError::new(
            ExternalSourceOperationErrorCode::Unsupported,
            "Static Hook inspection is not available for a remote workspace in this version",
            false,
        ));
    }
    let service = service_for(workspace_id).await?;
    service.snapshot_or_refresh(force_refresh).await
}

/// Convenience entry point for local product surfaces. Keeping execution-domain
/// construction here prevents transport adapters from depending on the
/// internal local-domain identifier.
pub async fn local_external_hook_catalog_snapshot(
    workspace_id: Option<&str>,
    force_refresh: bool,
) -> ExternalSourceOperationResult<ExternalHookCatalogSnapshotV1> {
    service_for(workspace_id)
        .await?
        .snapshot_or_refresh(force_refresh)
        .await
}

/// Resolve identity before deriving any local discovery or storage path.
pub(crate) async fn local_workspace_root(
    workspace_id: Option<&str>,
) -> ExternalSourceOperationResult<Option<PathBuf>> {
    let Some(id) = workspace_id else {
        return Ok(None);
    };
    let service = crate::service::workspace::get_global_workspace_service().ok_or_else(|| {
        ExternalSourceOperationError::invalid_request("Workspace service is unavailable")
    })?;
    let record = service
        .require_workspace(id)
        .await
        .map_err(|error| ExternalSourceOperationError::invalid_request(error.to_string()))?;
    if record.workspace_kind == crate::service::workspace::WorkspaceKind::Remote {
        return Err(ExternalSourceOperationError::host_capability_unavailable(
            "Static Hook inspection does not support remote workspaces",
        ));
    }
    Ok(Some(record.root_path))
}
