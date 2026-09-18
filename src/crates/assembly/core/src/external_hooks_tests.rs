use crate::external_hooks::{
    external_hook_catalog_snapshot, resolve_hook_project_topology,
    WorkspaceExternalHookCatalogService,
};
use openbitfun_product_domains::external_hook_catalog::{
    ExternalHookProviderIdentity, ExternalHookProviderSnapshot, ExternalHookSourceProvider,
};
use openbitfun_product_domains::external_sources::{
    ExecutionDomainId, ExternalSourceContext, ExternalSourceOperationErrorCode,
    ExternalSourceProviderError,
};
use std::path::PathBuf;
use std::sync::atomic::{AtomicUsize, Ordering};
use std::sync::Arc;

struct CountingProvider {
    calls: AtomicUsize,
    identity: ExternalHookProviderIdentity,
}

impl CountingProvider {
    fn new() -> Self {
        Self {
            calls: AtomicUsize::new(0),
            identity: ExternalHookProviderIdentity::new("test.hooks", "test", "Test Hooks")
                .unwrap(),
        }
    }
}

impl ExternalHookSourceProvider for CountingProvider {
    fn identity(&self) -> ExternalHookProviderIdentity {
        self.identity.clone()
    }

    fn discover(
        &self,
        _context: &ExternalSourceContext,
    ) -> Result<ExternalHookProviderSnapshot, ExternalSourceProviderError> {
        self.calls.fetch_add(1, Ordering::SeqCst);
        Ok(ExternalHookProviderSnapshot {
            provider: self.identity.clone(),
            sources: Vec::new(),
            entries: Vec::new(),
            diagnostics: Vec::new(),
        })
    }
}

struct SlowCountingProvider {
    calls: AtomicUsize,
    identity: ExternalHookProviderIdentity,
}

impl SlowCountingProvider {
    fn new() -> Self {
        Self {
            calls: AtomicUsize::new(0),
            identity: ExternalHookProviderIdentity::new("slow.hooks", "slow", "Slow Hooks")
                .unwrap(),
        }
    }
}

impl ExternalHookSourceProvider for SlowCountingProvider {
    fn identity(&self) -> ExternalHookProviderIdentity {
        self.identity.clone()
    }

    fn discover(
        &self,
        _context: &ExternalSourceContext,
    ) -> Result<ExternalHookProviderSnapshot, ExternalSourceProviderError> {
        self.calls.fetch_add(1, Ordering::SeqCst);
        std::thread::sleep(std::time::Duration::from_millis(250));
        Ok(ExternalHookProviderSnapshot {
            provider: self.identity.clone(),
            sources: Vec::new(),
            entries: Vec::new(),
            diagnostics: Vec::new(),
        })
    }
}

fn context(domain: &str) -> ExternalSourceContext {
    ExternalSourceContext {
        workspace_root: Some(PathBuf::from("C:/workspace")),
        execution_domain_id: ExecutionDomainId::new(domain).unwrap(),
    }
}

#[tokio::test]
async fn workspace_service_refreshes_only_registered_hook_providers() {
    let provider = Arc::new(CountingProvider::new());
    let service = Arc::new(
        WorkspaceExternalHookCatalogService::new(context("local-user"), vec![provider.clone()])
            .unwrap(),
    );

    assert!(service.snapshot().discovery_pending);
    assert!(!service.refresh().await.unwrap().discovery_pending);
    assert_eq!(provider.calls.load(Ordering::SeqCst), 1);
}

#[tokio::test]
async fn repeated_refresh_reuses_the_in_flight_hook_discovery() {
    let provider = Arc::new(SlowCountingProvider::new());
    let service = Arc::new(
        WorkspaceExternalHookCatalogService::new(context("local-user"), vec![provider.clone()])
            .unwrap(),
    );

    assert!(service.refresh().await.unwrap().discovery_pending);
    assert!(service.refresh().await.unwrap().discovery_pending);
    for _ in 0..200 {
        if !service.snapshot().discovery_pending {
            break;
        }
        tokio::time::sleep(std::time::Duration::from_millis(10)).await;
    }

    assert!(!service.snapshot().discovery_pending);
    assert_eq!(provider.calls.load(Ordering::SeqCst), 1);
}

#[tokio::test]
async fn initial_cache_only_request_starts_the_first_discovery() {
    let provider = Arc::new(CountingProvider::new());
    let service = Arc::new(
        WorkspaceExternalHookCatalogService::new(context("local-user"), vec![provider.clone()])
            .unwrap(),
    );

    let snapshot = service.snapshot_or_refresh(false).await.unwrap();

    assert!(!snapshot.discovery_pending);
    assert_eq!(provider.calls.load(Ordering::SeqCst), 1);
}

#[tokio::test]
async fn remote_execution_domain_fails_closed_before_local_discovery() {
    let error = external_hook_catalog_snapshot(None, context("peer-machine"), true)
        .await
        .unwrap_err();
    assert_eq!(error.code, ExternalSourceOperationErrorCode::Unsupported);
    assert!(error.detail.contains("remote workspace"));
}

#[test]
fn linked_worktree_topology_keeps_current_boundary_and_primary_hook_root() {
    let main = PathBuf::from("C:/repo");
    let linked = PathBuf::from("C:/worktrees/feature");
    let workspace = linked.join("packages/app");

    let topology =
        resolve_hook_project_topology(&workspace, &[(main.clone(), true), (linked.clone(), false)])
            .unwrap();
    assert_eq!(topology.current_root, linked);
    assert_eq!(topology.primary_root, Some(main));
}
