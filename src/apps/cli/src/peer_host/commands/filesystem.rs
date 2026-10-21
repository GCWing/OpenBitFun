//! Filesystem HostInvoke handlers.

use openbitfun_core::service::filesystem::path_operations;
use openbitfun_core::service::workspace::WorkspaceKind;
use serde_json::{json, Value};

use crate::peer_host::args::{get_string, optional_bool, optional_string, request_value};
use crate::peer_host::state::PeerHostState;

async fn file_connection(state: &PeerHostState, request: &Value) -> Result<Option<String>, String> {
    if let Some(id) =
        optional_string(request, "workspaceId").or_else(|| optional_string(request, "workspace_id"))
    {
        let record = state
            .workspace_service
            .require_workspace(&id)
            .await
            .map_err(|e| e.to_string())?;
        return record
            .filesystem_connection_id()
            .map(|id| id.map(str::to_owned));
    }
    state
        .workspace_service
        .upgrade_legacy_file_connection(
            &get_string(request, "path")?,
            optional_string(request, "workspacePath").as_deref(),
            optional_string(request, "remoteConnectionId").as_deref(),
        )
        .await
        .map_err(|e| e.to_string())
}

fn directory_nodes_to_json(
    nodes: Vec<openbitfun_core::infrastructure::FileTreeNode>,
) -> Vec<Value> {
    nodes
        .into_iter()
        .map(|node| {
            json!({
                "path": node.path,
                "name": node.name,
                "isDirectory": node.is_directory,
                "size": node.size,
                "extension": node.extension,
                "lastModified": node.last_modified
            })
        })
        .collect()
}

pub(crate) async fn get_directory_children(
    state: &PeerHostState,
    args: &Value,
) -> Result<Value, String> {
    let request = request_value(args);
    let path = get_string(request, "path")?;
    let preferred = file_connection(state, request).await?;
    let nodes = state
        .filesystem_service
        .get_directory_contents_on_connection(&path, preferred.as_deref())
        .await
        .map_err(|e| format!("Failed to get directory children: {e}"))?;
    Ok(json!(directory_nodes_to_json(nodes)))
}

pub(crate) async fn get_directory_children_paginated(
    state: &PeerHostState,
    args: &Value,
) -> Result<Value, String> {
    let request = request_value(args);
    let path = get_string(request, "path")?;
    let preferred = file_connection(state, request).await?;
    let offset = request.get("offset").and_then(|v| v.as_u64()).unwrap_or(0) as usize;
    let limit = request.get("limit").and_then(|v| v.as_u64()).unwrap_or(100) as usize;

    let mut nodes = state
        .filesystem_service
        .get_directory_contents_on_connection(&path, preferred.as_deref())
        .await
        .map_err(|e| format!("Failed to get paginated directory children: {e}"))?;
    openbitfun_services_core::filesystem::sort_directory_nodes(
        &mut nodes,
        request.get("sortBy").and_then(Value::as_str),
        request.get("sortOrder").and_then(Value::as_str),
    )?;
    let total = nodes.len();
    let has_more = total > offset.saturating_add(limit);
    let page_nodes: Vec<_> = nodes.into_iter().skip(offset).take(limit).collect();

    Ok(json!({
        "children": directory_nodes_to_json(page_nodes),
        "total": total,
        "hasMore": has_more,
        "offset": offset,
        "limit": limit
    }))
}

fn file_tree_node_to_json(node: openbitfun_core::infrastructure::FileTreeNode) -> Value {
    let mut json = json!({
        "path": node.path,
        "name": node.name,
        "isDirectory": node.is_directory,
        "size": node.size,
        "extension": node.extension,
        "lastModified": node.last_modified
    });
    if let Some(children) = node.children {
        json["children"] = Value::Array(children.into_iter().map(file_tree_node_to_json).collect());
    }
    json
}

/// A directory request names a real directory on whichever filesystem the
/// request resolved to. Empty identity is the explicit runtime-local scope.
async fn ensure_directory_path(path: &str, connection: Option<&str>) -> Result<(), String> {
    if let Some(id) = connection.filter(|id| !id.trim().is_empty()) {
        path_operations::resolve_explicit_path_connection(path, id.trim()).await?;
        return Ok(());
    }
    let path_buf = std::path::Path::new(path);
    if !path_buf.exists() {
        return Err("Directory does not exist".to_string());
    }
    if !path_buf.is_dir() {
        return Err("Path is not a directory".to_string());
    }
    Ok(())
}

/// Whole-tree read. Registered as `get_file_tree` and, for the current file
/// explorer controller, as `explorer_get_file_tree`.
pub(crate) async fn get_file_tree(state: &PeerHostState, args: &Value) -> Result<Value, String> {
    let request = request_value(args);
    let path = get_string(request, "path")?;
    let preferred = file_connection(state, request).await?;
    ensure_directory_path(&path, preferred.as_deref()).await?;
    let nodes = state
        .filesystem_service
        .build_file_tree_on_connection(&path, preferred.as_deref())
        .await
        .map_err(|e| format!("Failed to build file tree: {e}"))?;
    let root_name = std::path::Path::new(&path)
        .file_name()
        .and_then(|name| name.to_str())
        .unwrap_or(&path)
        .to_string();
    Ok(json!([json!({
        "path": path,
        "name": root_name,
        "isDirectory": true,
        "size": Value::Null,
        "extension": Value::Null,
        "lastModified": Value::Null,
        "children": nodes.into_iter().map(file_tree_node_to_json).collect::<Vec<_>>()
    })]))
}

pub(crate) async fn get_file_metadata(
    state: &PeerHostState,
    args: &Value,
) -> Result<Value, String> {
    let request = request_value(args);
    let path = get_string(request, "path")?;
    let hint = file_connection(state, request).await?;
    let metadata =
        path_operations::metadata(&state.filesystem_service, &path, hint.as_deref()).await?;
    serde_json::to_value(metadata).map_err(|e| format!("Failed to serialize file metadata: {e}"))
}

pub(crate) async fn get_file_editor_sync_hash(
    state: &PeerHostState,
    args: &Value,
) -> Result<Value, String> {
    let request = request_value(args);
    let path = get_string(request, "path")?;
    let hint = file_connection(state, request).await?;
    let (hash, is_remote) =
        path_operations::editor_sync_hash(&state.filesystem_service, &path, hint.as_deref())
            .await?;
    Ok(if is_remote {
        json!({ "path": path, "hash": hash, "is_remote": true })
    } else {
        json!({ "path": path, "hash": hash })
    })
}

pub(crate) async fn create_file(state: &PeerHostState, args: &Value) -> Result<Value, String> {
    let request = request_value(args);
    let path = get_string(request, "path")?;
    let hint = file_connection(state, request).await?;
    path_operations::create_empty_file(&state.filesystem_service, &path, hint.as_deref()).await?;
    Ok(Value::Null)
}

/// Resolve a watch request to a host-local path, mirroring the Desktop Host:
/// a workspace ID is the current ingress, and remote workspaces are refused
/// because the watcher only observes this host's filesystem.
async fn watch_target(
    state: &PeerHostState,
    request: &Value,
) -> Result<(String, Option<bool>), String> {
    if let Some(workspace_id) = optional_string(request, "workspaceId") {
        let record = state
            .workspace_service
            .require_workspace(&workspace_id)
            .await
            .map_err(|e| e.to_string())?;
        if record.workspace_kind == WorkspaceKind::Remote {
            return Err("Filesystem watching is not available for remote workspaces".into());
        }
        return Ok((
            get_string(request, "path")?,
            optional_bool(request, "recursive"),
        ));
    }
    // Temporary 1.0.0 wire ingress; current callers must send the ID request.
    let path = get_string(request, "path")?;
    if state
        .workspace_service
        .upgrade_legacy_file_connection(&path, None, None)
        .await
        .map_err(|e| e.to_string())?
        .is_some()
    {
        return Err("Filesystem watching is not available for remote workspaces".into());
    }
    Ok((path, optional_bool(request, "recursive")))
}

pub(crate) async fn start_file_watch(state: &PeerHostState, args: &Value) -> Result<Value, String> {
    let (path, recursive) = watch_target(state, request_value(args)).await?;
    openbitfun_core::service::start_file_watch(path, recursive).await?;
    Ok(Value::Null)
}

pub(crate) async fn stop_file_watch(state: &PeerHostState, args: &Value) -> Result<Value, String> {
    let (path, _) = watch_target(state, request_value(args)).await?;
    openbitfun_core::service::stop_file_watch(path).await?;
    Ok(Value::Null)
}

pub(crate) async fn get_watched_paths() -> Result<Value, String> {
    let paths = openbitfun_core::service::get_watched_paths().await?;
    Ok(json!(paths))
}

pub(crate) async fn check_path_exists(
    state: &PeerHostState,
    args: &Value,
) -> Result<Value, String> {
    let request = request_value(args);
    let path = get_string(request, "path")?;
    let hint = file_connection(state, request).await?;
    openbitfun_core::service::filesystem::path_operations::exists(
        &state.filesystem_service,
        &path,
        hint.as_deref(),
    )
    .await
    .map(|exists| json!(exists))
}

pub(crate) async fn create_directory(state: &PeerHostState, args: &Value) -> Result<Value, String> {
    let request = request_value(args);
    let path = get_string(request, "path")?;
    let hint = file_connection(state, request).await?;
    openbitfun_core::service::filesystem::path_operations::create_directory(
        &state.filesystem_service,
        &path,
        hint.as_deref(),
    )
    .await?;
    Ok(Value::Null)
}

pub(crate) async fn read_file_content(
    state: &PeerHostState,
    args: &Value,
) -> Result<Value, String> {
    let request = request_value(args);
    let path = get_string(request, "filePath")?;
    let hint = file_connection(state, request).await?;
    if let Some(encoding) = optional_string(request, "encoding") {
        if !encoding.eq_ignore_ascii_case("utf-8") && !encoding.eq_ignore_ascii_case("utf8") {
            return Err(format!("Unsupported text encoding: {encoding}"));
        }
    }
    openbitfun_core::service::filesystem::path_operations::read_text(
        &state.filesystem_service,
        &path,
        hint.as_deref(),
    )
    .await
    .map(Value::String)
}

pub(crate) async fn write_file_content(
    state: &PeerHostState,
    args: &Value,
) -> Result<Value, String> {
    let request = request_value(args);
    let path = get_string(request, "filePath")?;
    let content = get_string(request, "content")?;
    let hint = file_connection(state, request).await?;
    openbitfun_core::service::filesystem::path_operations::write_text_checked(
        &state.filesystem_service,
        &path,
        &content,
        hint.as_deref(),
        request
            .get("expectedHash")
            .or_else(|| request.get("expected_hash"))
            .and_then(Value::as_str),
    )
    .await?;
    Ok(Value::Null)
}

pub(crate) async fn rename_file(state: &PeerHostState, args: &Value) -> Result<Value, String> {
    let request = request_value(args);
    let from = get_string(request, "oldPath")?;
    let to = get_string(request, "newPath")?;
    let hint = file_connection(state, request).await?;
    openbitfun_core::service::filesystem::path_operations::rename(
        &state.filesystem_service,
        &from,
        &to,
        hint.as_deref(),
    )
    .await?;
    Ok(Value::Null)
}

pub(crate) async fn delete_path(
    state: &PeerHostState,
    args: &Value,
    directory: bool,
) -> Result<Value, String> {
    let request = request_value(args);
    let path = get_string(request, "path")?;
    let hint = file_connection(state, request).await?;
    let recursive = request
        .get("recursive")
        .and_then(Value::as_bool)
        .unwrap_or(false);
    openbitfun_core::service::filesystem::path_operations::remove(
        &state.filesystem_service,
        &path,
        directory,
        recursive,
        hint.as_deref(),
    )
    .await?;
    Ok(Value::Null)
}

pub(crate) async fn list_directory_files(
    state: &PeerHostState,
    args: &Value,
) -> Result<Value, String> {
    let request = request_value(args);
    let path = get_string(request, "path")?;
    let hint = file_connection(state, request).await?;
    let extensions = request.get("extensions").and_then(Value::as_array);
    let nodes = state
        .filesystem_service
        .get_directory_contents_on_connection(&path, hint.as_deref())
        .await
        .map_err(|e| e.to_string())?;
    let mut files: Vec<_> = nodes
        .into_iter()
        .filter(|node| !node.is_directory)
        .filter(|node| {
            extensions.is_none_or(|values| {
                node.extension.as_ref().is_some_and(|ext| {
                    values.iter().any(|value| {
                        value
                            .as_str()
                            .is_some_and(|value| value.eq_ignore_ascii_case(ext))
                    })
                })
            })
        })
        .map(|node| node.name)
        .collect();
    files.sort();
    Ok(json!(files))
}

pub(crate) async fn workspace_file_upload(
    state: &PeerHostState,
    args: &Value,
) -> Result<Value, String> {
    let account = state
        .account_runtime
        .snapshot()
        .await
        .info
        .ok_or("Sign in to use workspace transfers")?;
    let request = serde_json::from_value(request_value(args).clone())
        .map_err(|error| format!("Invalid workspace upload request: {error}"))?;
    let result = openbitfun_core::service::filesystem::upload::workspace_file_upload(
        account.user_id,
        request,
    )
    .await?;
    serde_json::to_value(result).map_err(|error| error.to_string())
}
