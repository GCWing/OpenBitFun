//! Local workspace snapshot access shared by product hosts.
//!
//! This is a local-only owner boundary. It is not part of the Agent Runtime
//! SDK, does not describe remote snapshot execution, and does not model a full
//! checkpoint/rewind transaction.

use std::path::PathBuf;

use crate::PortResult;

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct LocalWorkspaceSnapshotSessionRequest {
    pub workspace_id: String,
    pub session_id: String,
    /// Exclusive visible turn end supplied by the session lifecycle owner.
    /// `None` exposes the complete snapshot history.
    pub max_turn_exclusive: Option<usize>,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct LocalWorkspaceSnapshotTurnRequest {
    pub workspace_id: String,
    pub session_id: String,
    pub turn_index: usize,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct LocalWorkspaceSnapshotStats {
    pub session_id: String,
    pub total_files: usize,
    pub total_turns: usize,
    pub total_changes: usize,
}

#[async_trait::async_trait]
pub trait LocalWorkspaceSnapshotPort: Send + Sync {
    /// Prepares the existing local snapshot owner for a workspace.
    async fn prepare_local_workspace(&self, workspace_id: String) -> PortResult<()>;

    async fn get_session_files(
        &self,
        request: LocalWorkspaceSnapshotSessionRequest,
    ) -> PortResult<Vec<PathBuf>>;

    async fn get_session_stats(
        &self,
        request: LocalWorkspaceSnapshotSessionRequest,
    ) -> PortResult<LocalWorkspaceSnapshotStats>;

    /// Restores only workspace files. Conversation-history mutation remains a
    /// separate host/runtime-owner operation.
    async fn rollback_workspace_files_to_turn(
        &self,
        request: LocalWorkspaceSnapshotTurnRequest,
    ) -> PortResult<Vec<PathBuf>>;
}

#[cfg(test)]
mod tests {
    use super::{
        LocalWorkspaceSnapshotSessionRequest, LocalWorkspaceSnapshotStats,
        LocalWorkspaceSnapshotTurnRequest,
    };

    #[test]
    fn local_snapshot_contracts_keep_workspace_and_session_identity_explicit() {
        let session = LocalWorkspaceSnapshotSessionRequest {
            workspace_id: String::from("workspace"),
            session_id: "session-1".to_string(),
            max_turn_exclusive: Some(5),
        };
        let turn = LocalWorkspaceSnapshotTurnRequest {
            workspace_id: session.workspace_id.clone(),
            session_id: session.session_id.clone(),
            turn_index: 4,
        };
        let stats = LocalWorkspaceSnapshotStats {
            session_id: session.session_id.clone(),
            total_files: 2,
            total_turns: 5,
            total_changes: 7,
        };

        assert_eq!(turn.workspace_id, session.workspace_id);
        assert_eq!(turn.session_id, session.session_id);
        assert_eq!(turn.turn_index, 4);
        assert_eq!(stats.total_changes, 7);
    }

    #[test]
    fn local_snapshot_contracts_do_not_accept_remote_identity() {
        let source = include_str!("local_workspace_snapshot.rs");
        let first_forbidden_field = ["remote", "connection", "id"].join("_");
        let second_forbidden_field = ["remote", "ssh", "host"].join("_");
        assert!(!source.contains(&first_forbidden_field));
        assert!(!source.contains(&second_forbidden_field));
    }
}
