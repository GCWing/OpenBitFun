use serde::{Deserialize, Serialize};

use crate::product_identity::{hidden_data_directory, product_id};

/// User-facing choice for where a newly-created session executes.
///
/// This is a request contract. Once resolved, sessions persist a
/// [`SessionExecutionTarget`] containing the immutable commit and concrete
/// execution root selected by the product layer.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, Default)]
#[serde(
    tag = "kind",
    rename_all = "camelCase",
    rename_all_fields = "camelCase"
)]
pub enum SessionExecutionTargetRequest {
    #[default]
    Local,
    NewManagedWorktree {
        #[serde(default, skip_serializing_if = "Option::is_none")]
        base_ref: Option<String>,
        #[serde(default)]
        copy_local_changes: bool,
    },
    ExistingWorktree {
        worktree_id: String,
    },
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash, Serialize, Deserialize, Default)]
#[cfg_attr(feature = "ts", derive(ts_rs::TS), ts(export))]
#[serde(rename_all = "camelCase")]
pub enum SessionExecutionTargetKind {
    #[default]
    Local,
    ManagedWorktree,
    ExistingWorktree,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash, Serialize, Deserialize)]
#[cfg_attr(feature = "ts", derive(ts_rs::TS), ts(export))]
#[serde(rename_all = "camelCase")]
pub enum WorktreeLifecycle {
    Managed,
    Permanent,
    External,
}

/// Resolved and persisted execution location for a session.
#[derive(Debug, Clone, PartialEq, Eq, Hash, Serialize, Deserialize)]
#[cfg_attr(feature = "ts", derive(ts_rs::TS), ts(export))]
#[serde(rename_all = "camelCase")]
pub struct SessionExecutionTarget {
    pub kind: SessionExecutionTargetKind,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub worktree_id: Option<String>,
    pub root_path: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub base_ref: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub base_commit: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub branch: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub lifecycle: Option<WorktreeLifecycle>,
}

impl SessionExecutionTarget {
    pub fn local(root_path: impl Into<String>) -> Self {
        Self {
            kind: SessionExecutionTargetKind::Local,
            worktree_id: None,
            root_path: root_path.into(),
            base_ref: None,
            base_commit: None,
            branch: None,
            lifecycle: None,
        }
    }
}

/// User-level defaults for worktrees created by session isolation.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(default, rename_all = "camelCase")]
pub struct WorktreeSettings {
    pub root_path: String,
    pub branch_prefix: String,
    pub copy_local_changes: bool,
    pub auto_delete_enabled: bool,
    pub auto_delete_limit: usize,
}

impl Default for WorktreeSettings {
    fn default() -> Self {
        Self {
            root_path: format!("~/{}/worktrees", hidden_data_directory()),
            branch_prefix: format!("{}/", product_id()),
            copy_local_changes: false,
            auto_delete_enabled: true,
            auto_delete_limit: 15,
        }
    }
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct WorktreeSessionSummary {
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub workspace_id: Option<String>,
    pub session_id: String,
    pub session_name: String,
    pub status: String,
    #[serde(default)]
    pub archived: bool,
}

/// Reconciled worktree state shown to UI and tools.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct WorktreeSummary {
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub workspace_id: Option<String>,
    pub worktree_id: String,
    pub project_workspace_path: String,
    pub path: String,
    pub head: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub branch: Option<String>,
    pub lifecycle: WorktreeLifecycle,
    pub is_main: bool,
    pub dirty: bool,
    pub locked: bool,
    pub missing: bool,
    pub has_unpublished_commits: bool,
    #[serde(default)]
    pub associated_session_count: usize,
    #[serde(default)]
    pub running_session_count: usize,
    #[serde(default)]
    pub sessions: Vec<WorktreeSessionSummary>,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum WorktreeErrorCode {
    RemoteUnsupported,
    NotGitRepository,
    /// The repository is there, but Git refuses to read it because the directory
    /// belongs to another user. Distinct from `NotGitRepository`: nothing is
    /// missing and nothing needs initializing — the user has to trust the path.
    RepositoryUntrusted,
    UnbornRepo,
    InvalidBaseRef,
    WorktreeNotFound,
    WorktreeBusy,
    WorktreeLocked,
    DirtyWorktree,
    UnpublishedCommits,
    CopyConflict,
    InvalidPath,
    BranchExists,
    RequestConflict,
    RollbackIncomplete,
    GitFailed,
    IoFailed,
}

impl WorktreeErrorCode {
    pub fn as_str(self) -> &'static str {
        match self {
            Self::RemoteUnsupported => "remote_unsupported",
            Self::NotGitRepository => "not_git_repository",
            Self::RepositoryUntrusted => "repository_untrusted",
            Self::UnbornRepo => "unborn_repo",
            Self::InvalidBaseRef => "invalid_base_ref",
            Self::WorktreeNotFound => "worktree_not_found",
            Self::WorktreeBusy => "worktree_busy",
            Self::WorktreeLocked => "worktree_locked",
            Self::DirtyWorktree => "dirty_worktree",
            Self::UnpublishedCommits => "unpublished_commits",
            Self::CopyConflict => "copy_conflict",
            Self::InvalidPath => "invalid_path",
            Self::BranchExists => "branch_exists",
            Self::RequestConflict => "request_conflict",
            Self::RollbackIncomplete => "rollback_incomplete",
            Self::GitFailed => "git_failed",
            Self::IoFailed => "io_failed",
        }
    }
}

#[derive(Debug, Clone, PartialEq, Eq, Hash, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct WorktreeError {
    pub code: WorktreeErrorCode,
    pub message: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub recovery_path: Option<String>,
}

impl std::fmt::Display for WorktreeError {
    fn fmt(&self, formatter: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        write!(formatter, "{}: {}", self.code.as_str(), self.message)
    }
}

impl std::error::Error for WorktreeError {}

#[cfg(test)]
mod tests {
    use super::{
        SessionExecutionTargetRequest, WorktreeError, WorktreeErrorCode, WorktreeSettings,
    };

    #[test]
    fn execution_target_request_uses_stable_camel_case_tags() {
        let value = serde_json::to_value(SessionExecutionTargetRequest::NewManagedWorktree {
            base_ref: Some("main".to_string()),
            copy_local_changes: true,
        })
        .expect("request should serialize");

        assert_eq!(value["kind"], "newManagedWorktree");
        assert_eq!(value["baseRef"], "main");
        assert_eq!(value["copyLocalChanges"], true);
    }

    #[test]
    fn worktree_defaults_include_managed_cleanup_policy() {
        let defaults = WorktreeSettings::default();
        assert_eq!(defaults.root_path, "~/.openbitfun/worktrees");
        assert_eq!(defaults.branch_prefix, "openbitfun/");
        assert!(!defaults.copy_local_changes);
        assert!(defaults.auto_delete_enabled);
        assert_eq!(defaults.auto_delete_limit, 15);
    }

    #[test]
    fn legacy_worktree_settings_receive_auto_delete_defaults() {
        let settings: WorktreeSettings = serde_json::from_value(serde_json::json!({
            "rootPath": "/custom/worktrees",
            "branchPrefix": "custom/",
            "copyLocalChanges": true
        }))
        .expect("legacy settings should deserialize");

        assert_eq!(settings.root_path, "/custom/worktrees");
        assert_eq!(settings.branch_prefix, "custom/");
        assert!(settings.copy_local_changes);
        assert!(settings.auto_delete_enabled);
        assert_eq!(settings.auto_delete_limit, 15);
    }

    #[test]
    fn worktree_errors_render_the_stable_wire_code() {
        let error = WorktreeError {
            code: WorktreeErrorCode::DirtyWorktree,
            message: "local changes".to_string(),
            recovery_path: None,
        };

        assert_eq!(error.to_string(), "dirty_worktree: local changes");
    }
}
