//! DTO Module

use openbitfun_core::service::remote_ssh::{
    normalize_remote_workspace_path, LOCAL_WORKSPACE_SSH_HOST,
};
use openbitfun_core::service::workspace::manager::WorkspaceKind;
use serde::{Deserialize, Serialize};
use std::collections::HashMap;

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub enum WorkspaceTypeDto {
    SingleProject,
    MultiProject,
    Documentation,
    Other,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "lowercase")]
pub enum WorkspaceKindDto {
    Normal,
    Assistant,
    Remote,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ProjectStatisticsDto {
    pub total_files: usize,
    pub total_lines: usize,
    pub total_size: usize,
    pub files_by_language: HashMap<String, usize>,
    pub files_by_extension: HashMap<String, usize>,
    pub last_updated: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct WorkspaceIdentityDto {
    pub name: Option<String>,
    pub creature: Option<String>,
    pub vibe: Option<String>,
    pub avatar: Option<String>,
    pub emoji: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct WorkspaceWorktreeInfoDto {
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub main_workspace_id: Option<String>,
    pub path: String,
    pub branch: Option<String>,
    pub main_repo_path: String,
    pub is_main: bool,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct RelatedPathDto {
    pub path: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub description: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct WorkspaceInfoDto {
    pub id: String,
    pub name: String,
    pub root_path: String,
    pub workspace_type: WorkspaceTypeDto,
    pub workspace_kind: WorkspaceKindDto,
    pub assistant_id: Option<String>,
    pub languages: Vec<String>,
    pub opened_at: String,
    pub last_accessed: String,
    pub description: Option<String>,
    pub tags: Vec<String>,
    pub statistics: Option<ProjectStatisticsDto>,
    pub identity: Option<WorkspaceIdentityDto>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub worktree: Option<WorkspaceWorktreeInfoDto>,
    #[serde(default)]
    pub related_paths: Vec<RelatedPathDto>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub connection_id: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub connection_name: Option<String>,
    #[serde(rename = "sshHost", skip_serializing_if = "Option::is_none")]
    pub ssh_host: Option<String>,
}

impl WorkspaceInfoDto {
    pub fn from_workspace_info(
        info: &openbitfun_core::service::workspace::manager::WorkspaceInfo,
    ) -> Self {
        let connection_id = info
            .metadata
            .get("connectionId")
            .and_then(|v| v.as_str())
            .map(|s| s.to_string());
        let connection_name = info
            .metadata
            .get("connectionName")
            .and_then(|v| v.as_str())
            .map(|s| s.to_string());
        let ssh_host = info
            .metadata
            .get("sshHost")
            .and_then(|v| v.as_str())
            .map(|s| s.to_string())
            .or_else(|| {
                if matches!(info.workspace_kind, WorkspaceKind::Remote) {
                    None
                } else {
                    Some(LOCAL_WORKSPACE_SSH_HOST.to_string())
                }
            });

        let root_path = if matches!(info.workspace_kind, WorkspaceKind::Remote) {
            normalize_remote_workspace_path(&info.root_path.to_string_lossy())
        } else {
            info.root_path.to_string_lossy().to_string()
        };

        Self {
            id: info.id.clone(),
            name: info.name.clone(),
            root_path,
            workspace_type: WorkspaceTypeDto::from_workspace_type(&info.workspace_type),
            workspace_kind: WorkspaceKindDto::from_workspace_kind(&info.workspace_kind),
            assistant_id: info.assistant_id.clone(),
            languages: info.languages.clone(),
            opened_at: info.opened_at.to_rfc3339(),
            last_accessed: info.last_accessed.to_rfc3339(),
            description: info.description.clone(),
            tags: info.tags.clone(),
            statistics: info
                .statistics
                .as_ref()
                .map(ProjectStatisticsDto::from_workspace_statistics),
            identity: info
                .identity
                .as_ref()
                .map(WorkspaceIdentityDto::from_workspace_identity),
            worktree: info
                .worktree
                .as_ref()
                .map(WorkspaceWorktreeInfoDto::from_workspace_worktree_info),
            related_paths: info
                .related_paths
                .iter()
                .map(RelatedPathDto::from_related_path)
                .collect(),
            connection_id,
            connection_name,
            ssh_host,
        }
    }
}

impl WorkspaceIdentityDto {
    pub fn from_workspace_identity(
        identity: &openbitfun_core::service::workspace::manager::WorkspaceIdentity,
    ) -> Self {
        Self {
            name: identity.name.clone(),
            creature: identity.creature.clone(),
            vibe: identity.vibe.clone(),
            avatar: identity.avatar.clone(),
            emoji: identity.emoji.clone(),
        }
    }
}

impl WorkspaceWorktreeInfoDto {
    pub fn from_workspace_worktree_info(
        info: &openbitfun_core::service::workspace::manager::WorkspaceWorktreeInfo,
    ) -> Self {
        Self {
            path: info.path.clone(),
            branch: info.branch.clone(),
            main_repo_path: info.main_repo_path.clone(),
            main_workspace_id: info.main_workspace_id.clone(),
            is_main: info.is_main,
        }
    }
}

impl RelatedPathDto {
    pub fn from_related_path(path: &openbitfun_core::service::workspace::RelatedPath) -> Self {
        Self {
            path: path.path.clone(),
            description: path.description.clone(),
        }
    }
}

impl WorkspaceTypeDto {
    pub fn from_workspace_type(
        workspace_type: &openbitfun_core::service::workspace::manager::WorkspaceType,
    ) -> Self {
        use openbitfun_core::service::workspace::manager::WorkspaceType;
        match workspace_type {
            WorkspaceType::RustProject
            | WorkspaceType::NodeProject
            | WorkspaceType::PythonProject
            | WorkspaceType::JavaProject
            | WorkspaceType::CppProject
            | WorkspaceType::WebProject
            | WorkspaceType::MobileProject => WorkspaceTypeDto::SingleProject,
            WorkspaceType::Other => WorkspaceTypeDto::Other,
        }
    }
}

impl WorkspaceKindDto {
    pub fn from_workspace_kind(
        workspace_kind: &openbitfun_core::service::workspace::manager::WorkspaceKind,
    ) -> Self {
        use openbitfun_core::service::workspace::manager::WorkspaceKind;
        match workspace_kind {
            WorkspaceKind::Normal => WorkspaceKindDto::Normal,
            WorkspaceKind::Assistant => WorkspaceKindDto::Assistant,
            WorkspaceKind::Remote => WorkspaceKindDto::Remote,
        }
    }
}

impl ProjectStatisticsDto {
    pub fn from_workspace_statistics(
        stats: &openbitfun_core::service::workspace::manager::WorkspaceStatistics,
    ) -> Self {
        Self {
            total_files: stats.total_files,
            total_lines: 0, // Temporarily set to 0 as the internal structure lacks this field
            total_size: stats.total_size_bytes as usize,
            files_by_language: HashMap::new(), // Temporarily empty, requires future implementation
            files_by_extension: stats.file_extensions.clone(),
            last_updated: stats
                .last_modified
                .map_or_else(|| chrono::Utc::now().to_rfc3339(), |dt| dt.to_rfc3339()),
        }
    }
}
