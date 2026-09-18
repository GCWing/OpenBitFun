//! Snapshot / rollback HostInvoke handlers for CLI Peer Host.

use std::path::PathBuf;

use serde_json::{json, Value};

use openbitfun_core::service::workspace::{WorkspaceInfo, WorkspaceKind};
use openbitfun_runtime_ports::{
    AgentSessionRollbackToTurnRequest, LocalWorkspaceSnapshotPort,
    LocalWorkspaceSnapshotSessionRequest, LocalWorkspaceSnapshotStats, PortError, PortErrorKind,
};

use crate::peer_host::args::{get_string, optional_string, request_value};
use crate::peer_host::state::PeerHostState;

use super::session::{ensure_session_workspace_runtime_ownership, resolved_session_storage_scope};

pub(super) async fn resolve_snapshot_workspace(
    state: &PeerHostState,
    request: &Value,
) -> Result<WorkspaceInfo, String> {
    if let Some(id) = optional_string(request, "workspaceId") {
        return state
            .workspace_service
            .require_workspace(&id)
            .await
            .map_err(|e| e.to_string());
    }
    // Temporary pre-ID protocol adapter; all downstream owners receive IDs.
    state
        .workspace_service
        .resolve_legacy_workspace_reference(
            None,
            &get_string(request, "workspacePath")?,
            optional_string(request, "remoteConnectionId").as_deref(),
            optional_string(request, "remoteSshHost").as_deref(),
        )
        .await
        .map_err(|e| e.to_string())?
        .ok_or_else(|| "Legacy snapshot workspace cannot be resolved".into())
}

pub(super) fn require_local_snapshot_workspace(workspace: &WorkspaceInfo) -> Result<(), String> {
    if workspace.workspace_kind == WorkspaceKind::Remote {
        return Err(format!(
            "Snapshot system not supported for remote workspace: {}",
            workspace.id
        ));
    }
    Ok(())
}

fn require_complete_rollback_workspace(workspace: &WorkspaceInfo) -> Result<(), String> {
    if workspace.workspace_kind == WorkspaceKind::Remote {
        return Err(format!("Complete rollback is not supported for remote workspaces because remote file snapshots are not recorded. No workspace files or session messages were changed: {}", workspace.id));
    }
    Ok(())
}

pub(super) fn snapshot_compatibility_error(error: PortError) -> String {
    if error.kind == PortErrorKind::InvalidRequest {
        error.message
    } else {
        format!("Service error: {}", error.message)
    }
}

pub(super) async fn local_snapshot_session_files(
    port: &dyn LocalWorkspaceSnapshotPort,
    workspace_id: String,
    session_id: String,
    max_turn_exclusive: Option<usize>,
) -> Result<Vec<PathBuf>, String> {
    port.get_session_files(LocalWorkspaceSnapshotSessionRequest {
        workspace_id,
        session_id,
        max_turn_exclusive,
    })
    .await
    .map_err(|error| {
        format!(
            "Failed to get session files: {}",
            snapshot_compatibility_error(error)
        )
    })
}

pub(super) async fn local_snapshot_session_stats(
    port: &dyn LocalWorkspaceSnapshotPort,
    workspace_id: String,
    session_id: String,
    max_turn_exclusive: Option<usize>,
) -> Result<LocalWorkspaceSnapshotStats, String> {
    port.get_session_stats(LocalWorkspaceSnapshotSessionRequest {
        workspace_id,
        session_id,
        max_turn_exclusive,
    })
    .await
    .map_err(|error| {
        format!(
            "Failed to get session stats: {}",
            snapshot_compatibility_error(error)
        )
    })
}

pub(crate) async fn get_session_files(
    state: &PeerHostState,
    args: &Value,
) -> Result<Value, String> {
    let request = request_value(args);
    let session_id = get_string(request, "sessionId")?;
    let workspace = resolve_snapshot_workspace(state, request).await?;

    openbitfun_agent_runtime::session_control::validate_session_id(&session_id)?;
    require_local_snapshot_workspace(&workspace)?;
    let scope = ensure_session_workspace_runtime_ownership(state, request).await?;
    let storage_path = resolved_session_storage_scope(state, scope).await?;
    let read = state
        .compatibility
        .begin_persisted_session_read(&storage_path, &session_id)
        .await
        .map_err(|error| format!("Failed to open a consistent snapshot view: {error}"))?;
    let files = local_snapshot_session_files(
        state.local_workspace_snapshot.as_ref(),
        workspace.id,
        session_id,
        read.visible_turn_end(),
    )
    .await?;

    Ok(json!(files
        .iter()
        .map(|p| p.to_string_lossy().to_string())
        .collect::<Vec<_>>()))
}

pub(crate) async fn rollback_session_to_turn(
    state: &PeerHostState,
    args: &Value,
) -> Result<Value, String> {
    let request = request_value(args);
    let mut rollback_request: AgentSessionRollbackToTurnRequest =
        serde_json::from_value(request.clone())
            .map_err(|error| format!("Invalid targeted Session rollback request: {error}"))?;

    openbitfun_agent_runtime::session_control::validate_session_id(&rollback_request.session_id)?;
    let workspace = if let Some(id) = rollback_request.workspace_id.as_deref() {
        state
            .workspace_service
            .require_workspace(id)
            .await
            .map_err(|e| e.to_string())?
    } else {
        state
            .workspace_service
            .resolve_legacy_workspace_reference(
                None,
                &rollback_request.workspace_path,
                rollback_request.remote_connection_id.as_deref(),
                rollback_request.remote_ssh_host.as_deref(),
            )
            .await
            .map_err(|e| e.to_string())?
            .ok_or("Legacy rollback workspace cannot be resolved")?
    };
    require_complete_rollback_workspace(&workspace)?;
    rollback_request.remote_connection_id = None;
    rollback_request.remote_ssh_host = None;
    rollback_request.workspace_id = Some(workspace.id);
    rollback_request.workspace_path = workspace.root_path.to_string_lossy().into_owned();
    let resolved_request = serde_json::to_value(&rollback_request).map_err(|e| e.to_string())?;
    let request = &resolved_request;
    ensure_session_workspace_runtime_ownership(state, request).await?;
    let outcome = state
        .agent_runtime
        .rollback_session_to_turn(rollback_request)
        .await
        .map_err(|error| error.into_message())?;
    serde_json::to_value(outcome).map_err(|error| error.to_string())
}

#[cfg(test)]
mod tests {
    use std::path::PathBuf;
    use std::sync::atomic::{AtomicUsize, Ordering};
    use std::sync::Mutex;

    use openbitfun_runtime_ports::{
        LocalWorkspaceSnapshotPort, LocalWorkspaceSnapshotSessionRequest,
        LocalWorkspaceSnapshotStats, LocalWorkspaceSnapshotTurnRequest, PortError, PortErrorKind,
        PortResult,
    };
    use serde_json::json;

    use super::{
        local_snapshot_session_files, local_snapshot_session_stats,
        require_complete_rollback_workspace, require_local_snapshot_workspace,
        snapshot_compatibility_error,
    };

    #[derive(Default)]
    struct RecordingSnapshotPort {
        file_calls: AtomicUsize,
        stats_calls: AtomicUsize,
        file_request: Mutex<Option<LocalWorkspaceSnapshotSessionRequest>>,
        stats_request: Mutex<Option<LocalWorkspaceSnapshotSessionRequest>>,
    }

    #[async_trait::async_trait]
    impl LocalWorkspaceSnapshotPort for RecordingSnapshotPort {
        async fn prepare_local_workspace(&self, _workspace_id: String) -> PortResult<()> {
            Ok(())
        }

        async fn get_session_files(
            &self,
            request: LocalWorkspaceSnapshotSessionRequest,
        ) -> PortResult<Vec<PathBuf>> {
            self.file_calls.fetch_add(1, Ordering::SeqCst);
            *self.file_request.lock().expect("file request lock") = Some(request);
            Ok(vec![PathBuf::from("changed.txt")])
        }

        async fn get_session_stats(
            &self,
            request: LocalWorkspaceSnapshotSessionRequest,
        ) -> PortResult<LocalWorkspaceSnapshotStats> {
            self.stats_calls.fetch_add(1, Ordering::SeqCst);
            let session_id = request.session_id.clone();
            *self.stats_request.lock().expect("stats request lock") = Some(request);
            Ok(LocalWorkspaceSnapshotStats {
                session_id,
                total_files: 1,
                total_turns: 2,
                total_changes: 3,
            })
        }

        async fn rollback_workspace_files_to_turn(
            &self,
            _request: LocalWorkspaceSnapshotTurnRequest,
        ) -> PortResult<Vec<PathBuf>> {
            Ok(vec![PathBuf::from("restored.txt")])
        }
    }

    #[tokio::test]
    async fn snapshot_kind_is_authoritative_without_transport_inference() {
        use openbitfun_core::service::workspace::WorkspaceInfoRuntimeExt;
        let directory = tempfile::tempdir().unwrap();
        let mut workspace =
            openbitfun_core::service::workspace::WorkspaceInfo::new_without_worktree(
                directory.path().to_path_buf(),
                Default::default(),
            )
            .await
            .unwrap();
        workspace
            .metadata
            .insert("connectionId".into(), json!("stale-ssh"));
        require_local_snapshot_workspace(&workspace).unwrap();
        require_complete_rollback_workspace(&workspace).unwrap();
        workspace.workspace_kind = super::WorkspaceKind::Remote;
        workspace.metadata.clear();
        assert!(require_local_snapshot_workspace(&workspace)
            .unwrap_err()
            .contains("not supported"));
        assert!(require_complete_rollback_workspace(&workspace)
            .unwrap_err()
            .contains("remote file snapshots"));
    }

    #[tokio::test]
    async fn local_snapshot_adapter_calls_each_port_operation_once_with_typed_requests() {
        let port = RecordingSnapshotPort::default();
        let workspace = "workspace-id".to_string();

        let files = local_snapshot_session_files(
            &port,
            workspace.clone(),
            "session-1".to_string(),
            Some(2),
        )
        .await
        .expect("file projection should succeed");
        let stats = local_snapshot_session_stats(
            &port,
            workspace.clone(),
            "session-1".to_string(),
            Some(2),
        )
        .await
        .expect("stats projection should succeed");
        assert_eq!(port.file_calls.load(Ordering::SeqCst), 1);
        assert_eq!(port.stats_calls.load(Ordering::SeqCst), 1);
        assert_eq!(files, vec![PathBuf::from("changed.txt")]);
        assert_eq!(stats.total_changes, 3);
        assert_eq!(
            port.file_request
                .lock()
                .expect("file request lock")
                .as_ref()
                .expect("file request")
                .workspace_id,
            workspace
        );
        assert_eq!(
            port.file_request
                .lock()
                .expect("file request lock")
                .as_ref()
                .expect("file request")
                .max_turn_exclusive,
            Some(2)
        );
    }

    #[test]
    fn port_errors_keep_the_existing_peer_host_error_categories() {
        let invalid = snapshot_compatibility_error(PortError::new(
            PortErrorKind::InvalidRequest,
            "Validation error: invalid session_id",
        ));
        assert_eq!(invalid, "Validation error: invalid session_id");

        let backend = snapshot_compatibility_error(PortError::new(
            PortErrorKind::Backend,
            "snapshot backend failed",
        ));
        assert_eq!(backend, "Service error: snapshot backend failed");
    }
}
