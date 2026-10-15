//! WorkspaceInfo → frontend DTO JSON (aligned with desktop WorkspaceInfoDto).

use openbitfun_core::service::remote_ssh::LOCAL_WORKSPACE_SSH_HOST;
use openbitfun_core::service::workspace::manager::{WorkspaceInfo, WorkspaceKind};
use serde_json::{json, Value};

pub(crate) fn workspace_info_to_json(info: &WorkspaceInfo) -> Value {
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

    let root_path = info.root_path.to_string_lossy().to_string();
    let workspace_kind = match info.workspace_kind {
        WorkspaceKind::Normal => "normal",
        WorkspaceKind::Assistant => "assistant",
        WorkspaceKind::Remote => "remote",
    };

    let mut obj = json!({
        "id": info.id,
        "name": info.name,
        "rootPath": root_path,
        "workspaceType": info.workspace_type,
        "workspaceKind": workspace_kind,
        "assistantId": info.assistant_id,
        "defaultNameNumber": openbitfun_core::service::workspace::assistant_naming::default_name_number(info),
        "languages": info.languages,
        "openedAt": info.opened_at.to_rfc3339(),
        "lastAccessed": info.last_accessed.to_rfc3339(),
        "description": info.description,
        "tags": info.tags,
        "identity": info.identity,
        "worktree": info.worktree,
        "relatedPaths": info.related_paths,
    });

    if let Some(stats) = &info.statistics {
        obj["statistics"] = json!({
            "totalFiles": stats.total_files,
            "totalLines": 0,
            "totalSize": stats.total_size_bytes,
            "filesByLanguage": {},
            "filesByExtension": stats.file_extensions,
            "lastUpdated": stats.last_modified.map(|t| t.to_rfc3339()).unwrap_or_default(),
        });
    }

    if let Some(cid) = connection_id {
        obj["connectionId"] = json!(cid);
    }
    if let Some(name) = connection_name {
        obj["connectionName"] = json!(name);
    }
    if let Some(host) = ssh_host {
        obj["sshHost"] = json!(host);
    }

    obj
}

pub(crate) fn workspace_list_to_json(list: &[WorkspaceInfo]) -> Value {
    Value::Array(list.iter().map(workspace_info_to_json).collect())
}
