//! Explicit local-view lifecycle. Discovery never clears a removal marker.
use super::*;
use crate::service::workspace::WorkspaceKind;
use openbitfun_product_domains::session_import::{
    RemovedExternalSession, RestoreRemovedExternalSessionRequest,
};

pub async fn list_removed_external_sessions(
    ecosystem_id: &str,
) -> ExternalSourceOperationResult<Vec<RemovedExternalSession>> {
    ImportSource::from_ecosystem(ecosystem_id)?;
    let service = crate::service::workspace::get_global_workspace_service().ok_or_else(|| {
        operation(
            ExternalSourceOperationErrorCode::Unavailable,
            "Workspace service is unavailable",
            true,
        )
    })?;
    let mut removed = Vec::new();
    for workspace in service.list_workspace_infos().await {
        // A remote workspace's local storage directory is never a source host.
        if workspace.workspace_kind == WorkspaceKind::Remote {
            continue;
        }
        let (store, _) = import_storage(&workspace).await?;
        let entries =
            deferred::removed_metadata(store.sessions_root(), &workspace.id, ecosystem_id)
                .await
                .map_err(lifecycle_error)?;
        removed.extend(entries.into_iter().map(|metadata| RemovedExternalSession {
            ecosystem_id: ecosystem_id.into(),
            session_id: metadata.session_id,
            session_name: metadata.session_name,
            workspace_id: workspace.id.clone(),
            workspace_name: workspace.name.clone(),
        }));
    }
    removed.sort_by(|a, b| {
        (&a.workspace_name, &a.session_name, &a.session_id).cmp(&(
            &b.workspace_name,
            &b.session_name,
            &b.session_id,
        ))
    });
    Ok(removed)
}

pub async fn restore_removed_external_session(
    request: RestoreRemovedExternalSessionRequest,
) -> ExternalSourceOperationResult<()> {
    ImportSource::from_ecosystem(&request.ecosystem_id)?;
    let service = crate::service::workspace::get_global_workspace_service().ok_or_else(|| {
        operation(
            ExternalSourceOperationErrorCode::Unavailable,
            "Workspace service is unavailable",
            true,
        )
    })?;
    let workspace = service
        .require_workspace(&request.target_workspace_id)
        .await
        .map_err(lifecycle_error)?;
    if workspace.workspace_kind == WorkspaceKind::Remote {
        return Err(operation(
            ExternalSourceOperationErrorCode::Unsupported,
            "Restoring external source sessions is unavailable for SSH workspaces",
            false,
        ));
    }
    let coordinator = crate::agentic::coordination::get_global_coordinator().ok_or_else(|| {
        operation(
            ExternalSourceOperationErrorCode::Unavailable,
            "Runtime ownership is unavailable for external source sessions",
            true,
        )
    })?;
    coordinator
        .ensure_workspace_runtime_ownership(&workspace.root_path, None, None)
        .map_err(lifecycle_error)?;
    let (store, _) = import_storage(&workspace).await?;
    coordinator
        .get_session_manager()
        .persistence_manager()
        .restore_external_session_reference(
            store.sessions_root(),
            &workspace.id,
            &request.ecosystem_id,
            &request.session_id,
        )
        .await
        .map_err(lifecycle_error)
}

fn lifecycle_error(error: impl std::fmt::Display) -> ExternalSourceOperationError {
    operation(
        ExternalSourceOperationErrorCode::Unavailable,
        error.to_string(),
        true,
    )
}
