//! Persisted Workspace record types shared by the live service and offline import.

use serde::{Deserialize, Serialize};
use std::collections::HashMap;
use std::path::PathBuf;

pub use openbitfun_runtime_ports::RelatedPath;

/// Workspace type.
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq, Hash)]
pub enum WorkspaceType {
    RustProject,
    NodeProject,
    PythonProject,
    JavaProject,
    CppProject,
    WebProject,
    MobileProject,
    Other,
}

/// Workspace status.
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
pub enum WorkspaceStatus {
    Active,
    Inactive,
    Loading,
    Error,
    Archived,
}

pub use openbitfun_core_types::WorkspaceKind;

/// Stable identity of the assistant workspace that owns the primary role.
///
/// Local workspace ids are derived from canonical storage paths, so the primary
/// selection is persisted using the assistant identity instead of that path-derived id.
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(tag = "kind", rename_all = "snake_case")]
pub enum PrimaryAssistantKey {
    BuiltIn,
    Named { assistant_id: String },
}

impl PrimaryAssistantKey {
    pub fn from_workspace(workspace: &WorkspaceInfo) -> Option<Self> {
        if workspace.workspace_kind != WorkspaceKind::Assistant {
            return None;
        }
        Some(match workspace.assistant_id.as_deref() {
            Some(assistant_id) if !assistant_id.trim().is_empty() => Self::Named {
                assistant_id: assistant_id.trim().to_string(),
            },
            _ => Self::BuiltIn,
        })
    }

    pub fn matches(&self, workspace: &WorkspaceInfo) -> bool {
        if workspace.workspace_kind != WorkspaceKind::Assistant {
            return false;
        }
        match (self, workspace.assistant_id.as_deref()) {
            (Self::BuiltIn, None) => true,
            (Self::Named { assistant_id }, Some(candidate)) => assistant_id == candidate,
            _ => false,
        }
    }
}

/// Parsed agent identity fields from `IDENTITY.md` frontmatter.
#[derive(Debug, Clone, Default, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct WorkspaceIdentity {
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub name: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub creature: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub vibe: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub avatar: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub emoji: Option<String>,
}

/// Git worktree metadata attached to a workspace.
#[derive(Debug, Clone, Default, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct WorkspaceWorktreeInfo {
    /// Authoritative project relationship. `main_repo_path` remains an IO projection.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub main_workspace_id: Option<String>,
    pub path: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub branch: Option<String>,
    pub main_repo_path: String,
    pub is_main: bool,
}

/// Workspace metadata.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct WorkspaceInfo {
    pub id: String,
    pub name: String,
    #[serde(rename = "rootPath")]
    pub root_path: PathBuf,
    #[serde(rename = "workspaceType")]
    pub workspace_type: WorkspaceType,
    #[serde(rename = "workspaceKind", default)]
    pub workspace_kind: WorkspaceKind,
    #[serde(
        rename = "assistantId",
        default,
        skip_serializing_if = "Option::is_none"
    )]
    pub assistant_id: Option<String>,
    pub status: WorkspaceStatus,
    pub languages: Vec<String>,
    #[serde(rename = "openedAt")]
    pub opened_at: chrono::DateTime<chrono::Utc>,
    #[serde(rename = "lastAccessed")]
    pub last_accessed: chrono::DateTime<chrono::Utc>,
    pub description: Option<String>,
    pub tags: Vec<String>,
    pub statistics: Option<WorkspaceStatistics>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub identity: Option<WorkspaceIdentity>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub worktree: Option<WorkspaceWorktreeInfo>,
    #[serde(rename = "relatedPaths", default)]
    pub related_paths: Vec<RelatedPath>,
    pub metadata: HashMap<String, serde_json::Value>,
}

impl WorkspaceInfo {
    /// Workspace owning this execution workspace's sessions.
    pub fn project_workspace_id(&self) -> Result<&str, String> {
        if self.workspace_kind != WorkspaceKind::Remote {
            if let Some(tree) = self.worktree.as_ref().filter(|tree| !tree.is_main) {
                return tree
                    .main_workspace_id
                    .as_deref()
                    .filter(|id| !id.is_empty())
                    .ok_or_else(|| {
                        format!(
                            "Workspace '{}' has an unresolved project workspace ID",
                            self.id
                        )
                    });
            }
        }
        Ok(&self.id)
    }

    /// Select the filesystem provider from the authoritative workspace kind.
    /// Paths and stale SSH metadata never change a local workspace into a remote one.
    pub fn filesystem_connection_id(&self) -> Result<Option<&str>, String> {
        if self.workspace_kind != WorkspaceKind::Remote {
            return Ok(None);
        }
        self.remote_ssh_connection_id().map(Some).ok_or_else(|| {
            format!(
                "Remote workspace '{}' has no saved SSH connection ID",
                self.id
            )
        })
    }

    /// SSH connection id persisted in [`WorkspaceInfo::metadata`] for remote workspaces.
    pub fn remote_ssh_connection_id(&self) -> Option<&str> {
        self.metadata
            .get("connectionId")
            .and_then(|value| value.as_str())
            .filter(|value| !value.is_empty())
    }
}

/// Workspace statistics.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct WorkspaceStatistics {
    pub total_files: usize,
    pub total_directories: usize,
    pub total_size_bytes: u64,
    pub file_extensions: HashMap<String, usize>,
    pub last_modified: Option<chrono::DateTime<chrono::Utc>>,
    pub git_info: Option<GitInfo>,
}

/// Git information.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct GitInfo {
    pub is_git_repo: bool,
    pub current_branch: Option<String>,
    pub remote_url: Option<String>,
    pub has_uncommitted_changes: bool,
    pub total_commits: Option<usize>,
}
