use crate::api::app_state::AppState;
use log::{debug, info, warn};
use openbitfun_core::service::search::{
    workspace_search_runtime_available, WorkspaceSearchAutoIndexPriority,
};
use openbitfun_core::service::workspace::{WorkspaceInfo, WorkspaceKind};
use std::path::PathBuf;
use std::sync::Arc;
use std::time::Instant;
use tokio::sync::RwLock;

pub fn spawn_workspace_background_warmup(state: &AppState, workspace_info: WorkspaceInfo) {
    let workspace_id = state.workspace_id.clone();
    let agent_registry = state.agent_registry.clone();
    let workspace_search_service = state.workspace_search_service.clone();

    tokio::spawn(async move {
        warm_workspace_background_services(
            workspace_id,
            agent_registry,
            workspace_search_service,
            workspace_info,
        )
        .await;
    });
}

pub fn spawn_restored_workspace_auto_index(
    state: &AppState,
    workspaces: Vec<WorkspaceInfo>,
    budget_roots: Vec<PathBuf>,
) {
    let workspace_id = state.workspace_id.clone();
    let workspace_search_service = state.workspace_search_service.clone();
    tokio::spawn(async move {
        if !workspace_search_runtime_available().await {
            return;
        }

        let focused_id = workspace_id.read().await.clone();
        let protected_roots = workspaces
            .iter()
            .filter(|workspace| {
                workspace.workspace_kind != WorkspaceKind::Remote
                    && focused_id.as_deref() == Some(workspace.id.as_str())
            })
            .map(|workspace| workspace.root_path.clone())
            .collect();
        workspace_search_service
            .enforce_index_disk_budget(budget_roots, protected_roots)
            .await;

        if let Some(focused) = workspaces.iter().find(|workspace| {
            workspace.workspace_kind != WorkspaceKind::Remote
                && focused_id.as_deref() == Some(workspace.id.as_str())
        }) {
            workspace_search_service
                .schedule_auto_index(
                    &focused.root_path,
                    WorkspaceSearchAutoIndexPriority::Focused,
                )
                .await;
        }

        for workspace in workspaces {
            if workspace.workspace_kind == WorkspaceKind::Remote
                || focused_id.as_deref() == Some(workspace.id.as_str())
            {
                continue;
            }
            workspace_search_service
                .schedule_auto_index(
                    workspace.root_path,
                    WorkspaceSearchAutoIndexPriority::Background,
                )
                .await;
        }
    });
}

async fn warm_workspace_background_services(
    workspace_id: Arc<RwLock<Option<String>>>,
    agent_registry: Arc<openbitfun_core::agentic::agents::AgentRegistry>,
    workspace_search_service: Arc<openbitfun_core::service::search::WorkspaceSearchService>,
    workspace_info: WorkspaceInfo,
) {
    let started_at = Instant::now();
    let target_path = workspace_info.root_path.clone();

    if is_workspace_active(&workspace_id, &workspace_info.id).await {
        let subagents_started_at = Instant::now();
        agent_registry
            .load_custom_agents(Some(&workspace_info.id))
            .await;
        debug!(
            "Workspace custom agent warmup completed: path={}, elapsed_ms={}",
            target_path.display(),
            subagents_started_at.elapsed().as_millis()
        );
    }

    if workspace_info.workspace_kind != WorkspaceKind::Remote
        && is_workspace_active(&workspace_id, &workspace_info.id).await
        && workspace_search_runtime_available().await
    {
        let search_started_at = Instant::now();
        match workspace_search_service.open_repo(&target_path).await {
            Ok(_) => {
                let still_active = is_workspace_active(&workspace_id, &workspace_info.id).await;
                workspace_search_service
                    .schedule_auto_index(
                        target_path.clone(),
                        if still_active {
                            WorkspaceSearchAutoIndexPriority::Focused
                        } else {
                            WorkspaceSearchAutoIndexPriority::Background
                        },
                    )
                    .await;
                if !still_active {
                    workspace_search_service.schedule_repo_release(target_path.clone());
                    debug!(
                        "Released flashgrep warmup session for inactive workspace: path={}",
                        target_path.display()
                    );
                }
                info!(
                    "Workspace search warmup completed: path={}, elapsed_ms={}, active_after_open={}",
                    target_path.display(),
                    search_started_at.elapsed().as_millis(),
                    still_active
                );
            }
            Err(error) => {
                warn!(
                    "Failed to open workspace search repository session during warmup: path={}, error={}",
                    target_path.display(),
                    error
                );
            }
        }
    }

    debug!(
        "Workspace background warmup completed: path={}, total_elapsed_ms={}",
        target_path.display(),
        started_at.elapsed().as_millis()
    );
}

async fn is_workspace_active(workspace_id: &Arc<RwLock<Option<String>>>, target_id: &str) -> bool {
    workspace_id
        .read()
        .await
        .as_ref()
        .is_some_and(|current| current == target_id)
}
