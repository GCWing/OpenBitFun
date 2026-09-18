//! Filesystem HostInvoke handlers.

use serde_json::{json, Value};

use crate::peer_host::args::{get_string, optional_string, request_value};
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
