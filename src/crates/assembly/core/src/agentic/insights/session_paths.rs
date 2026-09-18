//! Resolve on-disk session roots for insights (local + remote SSH mirror).

use crate::agentic::session::session_store_port::CoreSessionStorePort;
use crate::service::workspace::get_global_workspace_service;
use openbitfun_runtime_ports::SessionStorePort;
use std::collections::HashSet;
use std::path::PathBuf;

#[derive(Debug, Clone)]
pub struct EffectiveSessionStorageTarget {
    pub workspace_id: String,
    pub workspace_path: PathBuf,
    pub session_storage_path: PathBuf,
}

/// Enumerate registered workspace IDs, then ask the persistence owner for roots.
/// A failed resolution is never replaced by the logical execution directory.
pub async fn collect_effective_session_storage_targets(
) -> crate::OpenBitFunResult<Vec<EffectiveSessionStorageTarget>> {
    let service = get_global_workspace_service()
        .ok_or_else(|| crate::OpenBitFunError::service("Workspace service is unavailable"))?;
    let mut targets = Vec::new();
    let mut seen = HashSet::new();
    for workspace in service.list_workspace_infos().await {
        let resolution = CoreSessionStorePort::default()
            .resolve_workspace_storage(&workspace.id)
            .await
            .map_err(|error| crate::OpenBitFunError::service(error.to_string()))?;
        if resolution.effective_storage_path.exists() && seen.insert(workspace.id.clone()) {
            targets.push(EffectiveSessionStorageTarget {
                workspace_id: workspace.id,
                workspace_path: workspace.root_path,
                session_storage_path: resolution.effective_storage_path,
            });
        }
    }
    Ok(targets)
}
