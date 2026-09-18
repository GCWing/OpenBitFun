use super::*;
use std::path::{Path, PathBuf};

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum RemoteWorkspaceKind {
    Normal,
    Assistant,
    Remote,
}

impl RemoteWorkspaceKind {
    pub const fn as_wire_str(self) -> &'static str {
        match self {
            Self::Normal => "normal",
            Self::Assistant => "assistant",
            Self::Remote => "remote",
        }
    }
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct RemoteWorkspaceFacts {
    /// Owning-host identity. Paths are presentation and IO data only.
    pub workspace_id: String,
    pub path: String,
    pub name: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub git_branch: Option<String>,
    pub kind: RemoteWorkspaceKind,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub assistant_id: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub remote_connection_id: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub remote_ssh_host: Option<String>,
}

#[derive(Debug, Clone, Default, PartialEq, Eq)]
pub struct RemoteSessionWorkspaceIdentity {
    pub workspace_id: Option<String>,
    pub remote_connection_id: Option<String>,
    pub remote_ssh_host: Option<String>,
}

impl RemoteSessionWorkspaceIdentity {
    pub fn new(remote_connection_id: Option<String>, remote_ssh_host: Option<String>) -> Self {
        Self {
            workspace_id: None,
            remote_connection_id,
            remote_ssh_host,
        }
    }

    pub fn from_workspace(workspace: &RemoteWorkspaceFacts) -> Self {
        Self::new(
            workspace.remote_connection_id.clone(),
            workspace.remote_ssh_host.clone(),
        )
        .with_workspace_id(Some(workspace.workspace_id.clone()))
    }

    pub fn with_workspace_id(mut self, workspace_id: Option<String>) -> Self {
        self.workspace_id = workspace_id;
        self
    }

    pub fn is_empty(&self) -> bool {
        self.workspace_id.is_none()
            && self.remote_connection_id.is_none()
            && self.remote_ssh_host.is_none()
    }
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct RemoteRecentWorkspaceFacts {
    /// Owning-host identity. Paths are presentation and IO data only.
    pub workspace_id: String,
    pub path: String,
    pub name: String,
    pub last_opened: String,
    pub kind: RemoteWorkspaceKind,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub remote_connection_id: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub remote_ssh_host: Option<String>,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct RemoteAssistantWorkspaceFacts {
    /// Owning-host identity. Paths are presentation and IO data only.
    pub workspace_id: String,
    pub path: String,
    pub name: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub assistant_id: Option<String>,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct RemoteWorkspaceUpdate {
    /// Owning-host identity. Paths are presentation and IO data only.
    pub workspace_id: String,
    pub path: String,
    pub name: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub remote_connection_id: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub remote_ssh_host: Option<String>,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct RemoteSessionMetadata {
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub workspace_id: Option<String>,
    pub session_id: String,
    pub name: String,
    pub agent_type: String,
    pub created_at_ms: u64,
    pub last_active_at_ms: u64,
    pub turn_count: usize,
    /// Parent session id for child sessions (btw/review/miniapp/subagent).
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub parent_session_id: Option<String>,
    /// Relationship kind as the snake_case tag persisted by Services
    /// (`btw`, `review`, `deep_review`, `miniapp`, `subagent`).
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub relationship_kind: Option<String>,
}

impl RemoteSessionMetadata {
    /// Child sessions belong under their parent, not in a flat session list.
    pub fn is_child_session(&self) -> bool {
        self.parent_session_id.is_some()
    }
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct RemoteWorkspaceFileContent {
    pub name: String,
    pub bytes: Vec<u8>,
    pub mime_type: &'static str,
    pub size: u64,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct RemoteWorkspaceFileChunk {
    /// Empty for legacy providers without file revision metadata.
    pub revision: String,
    pub name: String,
    pub bytes: Vec<u8>,
    pub offset: u64,
    pub chunk_size: u64,
    pub total_size: u64,
    pub mime_type: &'static str,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct RemoteWorkspaceFileInfo {
    pub name: String,
    pub size: u64,
    pub mime_type: &'static str,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct RemoteFileChunkRange {
    pub start: usize,
    pub end: usize,
    pub chunk_size: u64,
}

/// Old remote-connect host compatibility trait for workspace commands.
#[async_trait::async_trait]
pub trait RemoteWorkspaceRuntimeHost: Send + Sync {
    async fn current_workspace(&self) -> Option<RemoteWorkspaceFacts>;
    async fn recent_workspaces(&self) -> Vec<RemoteRecentWorkspaceFacts>;
    /// Authoritative sidebar catalog, including opened assistant workspaces.
    /// `None` advertises a legacy host; `Some([])` means no workspaces are open.
    async fn opened_workspaces(&self) -> Result<Option<Vec<RemoteRecentWorkspaceFacts>>, String> {
        Ok(None)
    }
    /// ID-based selection; legacy providers must advertise unsupported.
    async fn select_workspace(&self, _workspace_id: &str) -> Result<RemoteWorkspaceUpdate, String> {
        Err("Host does not support workspace ID selection".to_string())
    }
    /// Upgrade-only path ingress. New clients must use `select_workspace`.
    async fn open_workspace(
        &self,
        path: &str,
        remote_connection_id: Option<&str>,
        remote_ssh_host: Option<&str>,
    ) -> Result<RemoteWorkspaceUpdate, String>;
    async fn select_assistant_workspace(
        &self,
        _workspace_id: &str,
    ) -> Result<RemoteWorkspaceUpdate, String> {
        Err("Host does not support assistant workspace ID selection".to_string())
    }
    async fn assistant_workspaces(&self) -> Vec<RemoteAssistantWorkspaceFacts>;
    async fn open_assistant_workspace(&self, path: &str) -> Result<RemoteWorkspaceUpdate, String>;
}

/// Typed registration boundary for remote workspace providers.
pub trait RemoteWorkspacePort: RuntimeServicePort + RemoteWorkspaceRuntimeHost {}

impl<T> RemoteWorkspacePort for T where T: RuntimeServicePort + RemoteWorkspaceRuntimeHost + ?Sized {}

/// Old remote-connect host compatibility trait for initial sync.
#[async_trait::async_trait]
pub trait RemoteInitialSyncRuntimeHost: Send + Sync {
    async fn current_workspace(&self) -> Option<RemoteWorkspaceFacts>;
    async fn list_session_metadata(
        &self,
        workspace_path: &Path,
        workspace_identity: RemoteSessionWorkspaceIdentity,
    ) -> Result<Vec<RemoteSessionMetadata>, String>;
}

/// Old remote-connect host compatibility trait for remote file projection.
#[async_trait::async_trait]
pub trait RemoteWorkspaceFileRuntimeHost: Send + Sync {
    async fn resolve_remote_file_workspace_root(&self, session_id: Option<&str>)
        -> Option<PathBuf>;

    /// Session-aware providers own routing, including SSH and runtime artifacts.
    /// `None` retains the legacy workspace-root provider; errors never fall back.
    async fn read_remote_file(
        &self,
        _path: &str,
        _session_id: Option<&str>,
        _max_bytes: u64,
    ) -> Result<Option<RemoteWorkspaceFileContent>, String> {
        Ok(None)
    }

    /// Explicit file workspace identity is the workspace ID when the
    /// controller supplies one; `workspace_path` + `remote_connection_id` is
    /// the legacy projection for pre-ID controllers.
    async fn read_remote_file_chunk(
        &self,
        _path: &str,
        _session_id: Option<&str>,
        _workspace_id: Option<&str>,
        _workspace_path: Option<&str>,
        _remote_connection_id: Option<&str>,
        _offset: u64,
        _limit: u64,
    ) -> Result<Option<RemoteWorkspaceFileChunk>, String> {
        Ok(None)
    }

    async fn remote_file_info(
        &self,
        _path: &str,
        _session_id: Option<&str>,
        _workspace_id: Option<&str>,
        _workspace_path: Option<&str>,
        _remote_connection_id: Option<&str>,
    ) -> Result<Option<RemoteWorkspaceFileInfo>, String> {
        Ok(None)
    }
}

/// Typed registration boundary for remote filesystem/terminal/image projection providers.
pub trait RemoteProjectionPort: RuntimeServicePort + RemoteWorkspaceFileRuntimeHost {}

impl<T> RemoteProjectionPort for T where
    T: RuntimeServicePort + RemoteWorkspaceFileRuntimeHost + ?Sized
{
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn remote_workspace_contracts_preserve_workspace_and_session_facts() {
        let workspace = RemoteWorkspaceFacts {
            workspace_id: "test-workspace".to_string(),
            path: "/workspace/project".to_string(),
            name: "project".to_string(),
            git_branch: Some("main".to_string()),
            kind: RemoteWorkspaceKind::Remote,
            assistant_id: Some("assistant_1".to_string()),
            remote_connection_id: Some("conn-1".to_string()),
            remote_ssh_host: Some("host-1".to_string()),
        };
        let session = RemoteSessionMetadata {
            workspace_id: None,
            session_id: "session_1".to_string(),
            name: "Research".to_string(),
            agent_type: "CodeAgent".to_string(),
            created_at_ms: 10,
            last_active_at_ms: 20,
            turn_count: 3,
            parent_session_id: None,
            relationship_kind: None,
        };

        assert_eq!(workspace.kind.as_wire_str(), "remote");
        assert_eq!(workspace.assistant_id.as_deref(), Some("assistant_1"));
        assert_eq!(workspace.remote_connection_id.as_deref(), Some("conn-1"));
        assert_eq!(workspace.remote_ssh_host.as_deref(), Some("host-1"));
        assert_eq!(session.turn_count, 3);
    }

    #[test]
    fn remote_projection_contract_preserves_file_chunk_identity() {
        let chunk = RemoteWorkspaceFileChunk {
            revision: String::new(),
            name: "report.md".to_string(),
            bytes: b"chunk".to_vec(),
            offset: 6,
            chunk_size: 5,
            total_size: 11,
            mime_type: "text/markdown",
        };

        assert_eq!(chunk.name, "report.md");
        assert_eq!(chunk.bytes, b"chunk");
        assert_eq!(chunk.offset + chunk.chunk_size, chunk.total_size);
    }
}
