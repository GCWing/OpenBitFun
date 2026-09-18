//! Resolve local persisted session roots for memory extraction.

use crate::agentic::session::session_store_port::CoreSessionStorePort;
use crate::service::workspace::{get_global_workspace_service, WorkspaceInfo, WorkspaceKind};
use openbitfun_runtime_ports::SessionStorePort;
use std::collections::HashSet;
use std::path::PathBuf;

#[derive(Debug, Clone, PartialEq, Eq)]
pub(super) struct LocalSessionStorageRoot {
    pub workspace_path: PathBuf,
    pub session_storage_path: PathBuf,
}

/// Unique local workspace session directories that exist on disk.
///
/// Memory generation currently uses a local-only global memory workspace, so
/// remote SSH mirror roots are intentionally excluded before session metadata is
/// read.
pub(super) async fn collect_local_session_storage_roots() -> Vec<LocalSessionStorageRoot> {
    let mut paths = Vec::new();
    let mut seen = HashSet::new();

    let Some(ws_service) = get_global_workspace_service() else {
        return paths;
    };

    for ws in ws_service.list_workspace_infos().await {
        if !workspace_is_local_memory_source(&ws) {
            continue;
        }

        // Storage is owned by the workspace ID. A workspace whose storage cannot
        // be resolved is skipped instead of falling back to its execution root,
        // which is never a session directory.
        let Some(session_storage_path) = local_session_storage_dir_for_workspace(&ws).await else {
            log::warn!(
                "Skipping memory session root: storage is unavailable for workspace {}",
                ws.id
            );
            continue;
        };
        if session_storage_path.exists() && seen.insert(session_storage_path.clone()) {
            paths.push(LocalSessionStorageRoot {
                workspace_path: ws.root_path.clone(),
                session_storage_path,
            });
        }
    }

    paths
}

fn workspace_is_local_memory_source(ws: &WorkspaceInfo) -> bool {
    ws.workspace_kind != WorkspaceKind::Remote
}

async fn local_session_storage_dir_for_workspace(ws: &WorkspaceInfo) -> Option<PathBuf> {
    CoreSessionStorePort::default()
        .resolve_workspace_storage(&ws.id)
        .await
        .map(|resolution| resolution.effective_storage_path)
        .ok()
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::service::workspace::{WorkspaceStatus, WorkspaceType};
    use chrono::Utc;
    use std::collections::HashMap;

    fn workspace(kind: WorkspaceKind) -> WorkspaceInfo {
        WorkspaceInfo {
            id: "workspace-1".to_string(),
            name: "workspace".to_string(),
            root_path: PathBuf::from("E:/workspace"),
            workspace_type: WorkspaceType::Other,
            workspace_kind: kind,
            assistant_id: None,
            status: WorkspaceStatus::Active,
            languages: Vec::new(),
            opened_at: Utc::now(),
            last_accessed: Utc::now(),
            description: None,
            tags: Vec::new(),
            statistics: None,
            identity: None,
            worktree: None,
            related_paths: Vec::new(),
            metadata: HashMap::new(),
        }
    }

    #[test]
    fn memory_session_roots_skip_remote_workspaces() {
        assert!(workspace_is_local_memory_source(&workspace(
            WorkspaceKind::Normal
        )));
        assert!(workspace_is_local_memory_source(&workspace(
            WorkspaceKind::Assistant
        )));
        assert!(!workspace_is_local_memory_source(&workspace(
            WorkspaceKind::Remote
        )));
    }
}
