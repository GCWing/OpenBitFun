//! Worktree-domain App Server wire schemas.

#[cfg(feature = "rpc")]
use agent_client_protocol::{JsonRpcRequest, JsonRpcResponse};
pub use openbitfun_core_types::WorktreeErrorCode;
use openbitfun_runtime_ports::AgentSessionWorkspaceBinding;
use serde::{Deserialize, Serialize};

use crate::error::AppServerErrorData;

#[derive(Clone, Serialize, Deserialize)]
#[cfg_attr(feature = "rpc", derive(JsonRpcRequest))]
#[cfg_attr(feature = "rpc", request(method = "worktree/repositoryStatus", response = WorktreeRepositoryStatusResponse))]
#[serde(rename_all = "camelCase")]
pub struct WorktreeRepositoryStatusRequest {
    pub workspace_path: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub remote_connection_id: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub remote_ssh_host: Option<String>,
}

impl std::fmt::Debug for WorktreeRepositoryStatusRequest {
    fn fmt(&self, formatter: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        formatter
            .debug_struct("WorktreeRepositoryStatusRequest")
            .field("workspace_path", &"<redacted>")
            .field("remote", &self.is_remote())
            .finish()
    }
}

impl WorktreeRepositoryStatusRequest {
    pub fn is_remote(&self) -> bool {
        self.remote_connection_id.is_some() || self.remote_ssh_host.is_some()
    }
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[cfg_attr(feature = "rpc", derive(JsonRpcResponse))]
#[serde(rename_all = "camelCase")]
pub struct WorktreeRepositoryStatusResponse {
    pub is_repository: bool,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub current_branch: Option<String>,
}

#[derive(Clone, Serialize, Deserialize)]
#[cfg_attr(feature = "rpc", derive(JsonRpcRequest))]
#[cfg_attr(feature = "rpc", request(method = "worktree/bindSession", response = WorktreeBindingResponse))]
#[serde(rename_all = "camelCase")]
pub struct WorktreeBindSessionRequest {
    pub operation_id: String,
    pub session_id: String,
    /// Owning project workspace ID; authoritative when present.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub project_workspace_id: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub project_workspace_path: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub remote_connection_id: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub remote_ssh_host: Option<String>,
}

impl std::fmt::Debug for WorktreeBindSessionRequest {
    fn fmt(&self, formatter: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        formatter
            .debug_struct("WorktreeBindSessionRequest")
            .field("operation_id", &self.operation_id)
            .field("session_id", &self.session_id)
            .field("project_workspace_path", &"<redacted>")
            .field("remote", &self.is_remote())
            .finish()
    }
}

impl WorktreeBindSessionRequest {
    pub fn is_remote(&self) -> bool {
        self.remote_connection_id.is_some() || self.remote_ssh_host.is_some()
    }
}

#[derive(Clone, Serialize, Deserialize)]
#[cfg_attr(feature = "rpc", derive(JsonRpcRequest))]
#[cfg_attr(feature = "rpc", request(method = "worktree/releaseSession", response = WorktreeBindingResponse))]
#[serde(rename_all = "camelCase")]
pub struct WorktreeReleaseSessionRequest {
    pub operation_id: String,
    pub session_id: String,
    /// Owning project workspace ID; authoritative when present.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub project_workspace_id: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub project_workspace_path: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub remote_connection_id: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub remote_ssh_host: Option<String>,
}

impl std::fmt::Debug for WorktreeReleaseSessionRequest {
    fn fmt(&self, formatter: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        formatter
            .debug_struct("WorktreeReleaseSessionRequest")
            .field("operation_id", &self.operation_id)
            .field("session_id", &self.session_id)
            .field("project_workspace_path", &"<redacted>")
            .field("remote", &self.is_remote())
            .finish()
    }
}

impl WorktreeReleaseSessionRequest {
    pub fn is_remote(&self) -> bool {
        self.remote_connection_id.is_some() || self.remote_ssh_host.is_some()
    }
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[cfg_attr(feature = "rpc", derive(JsonRpcResponse))]
#[serde(rename_all = "camelCase")]
pub struct WorktreeBindingResponse {
    pub workspace_binding: AgentSessionWorkspaceBinding,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub retained_worktree_path: Option<String>,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct WorktreeErrorData {
    pub app: AppServerErrorData,
    pub error: WorktreeOperationError,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct WorktreeOperationError {
    pub code: WorktreeErrorCode,
    pub message: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub recovery_path: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub operation_id: Option<String>,
}

impl WorktreeOperationError {
    pub fn encode(&self) -> String {
        serde_json::to_string(self).unwrap_or_else(|_| {
            r#"{"code":"io_failed","message":"Worktree operation failed"}"#.to_string()
        })
    }

    pub fn decode(encoded: &str) -> Option<Self> {
        let mut error: Self = serde_json::from_str(encoded).ok()?;
        error.message = error
            .message
            .chars()
            .filter(|character| !character.is_control())
            .take(500)
            .collect();
        error.operation_id = error.operation_id.filter(|value| {
            !value.is_empty()
                && value.len() <= 160
                && value
                    .bytes()
                    .all(|byte| byte.is_ascii_alphanumeric() || matches!(byte, b'-' | b'_' | b'.'))
        });
        Some(error)
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::method::is_valid_method_name;

    #[test]
    fn worktree_methods_follow_the_stable_naming_contract() {
        for method in [
            "worktree/repositoryStatus",
            "worktree/bindSession",
            "worktree/releaseSession",
        ] {
            assert!(is_valid_method_name(method), "{method}");
        }
    }

    #[test]
    fn worktree_request_debug_redacts_workspace_paths() {
        let path = "C:/secret/project";
        let status = WorktreeRepositoryStatusRequest {
            workspace_path: path.to_string(),
            remote_connection_id: None,
            remote_ssh_host: None,
        };
        let bind = WorktreeBindSessionRequest {
            operation_id: "worktree-1".to_string(),
            session_id: "session-1".to_string(),
            project_workspace_id: Some("workspace-1".to_string()),
            project_workspace_path: Some(path.to_string()),
            remote_connection_id: None,
            remote_ssh_host: None,
        };
        let release = WorktreeReleaseSessionRequest {
            operation_id: "worktree-2".to_string(),
            session_id: "session-1".to_string(),
            project_workspace_id: Some("workspace-1".to_string()),
            project_workspace_path: Some(path.to_string()),
            remote_connection_id: None,
            remote_ssh_host: None,
        };

        assert!(!format!("{status:?}").contains(path));
        assert!(!format!("{bind:?}").contains(path));
        assert!(!format!("{release:?}").contains(path));
    }
}
