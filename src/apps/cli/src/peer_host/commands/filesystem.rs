//! Filesystem HostInvoke handlers.

use openbitfun_core::service::{filesystem::FileSystemService, workspace::WorkspaceService};
use serde_json::{json, Value};

use crate::peer_host::args::{get_string, optional_string, request_value};
use crate::peer_host::state::PeerHostState;

pub(crate) async fn html_preview_read_resource(args: &Value) -> Result<Value, String> {
    let request = serde_json::from_value(request_value(args).clone())
        .map_err(|error| format!("Invalid HTML preview request: {error}"))?;
    let reply =
        openbitfun_core::service::filesystem::html_preview::html_preview_read_resource(request)
            .await;
    serde_json::to_value(reply).map_err(|error| error.to_string())
}

async fn file_connection(
    state: &PeerHostState,
    request: &Value,
    path: &str,
) -> Result<Option<String>, String> {
    directory_connection(&state.workspace_service, request, path).await
}

async fn directory_connection(
    workspaces: &WorkspaceService,
    request: &Value,
    path: &str,
) -> Result<Option<String>, String> {
    if let Some(id) =
        optional_string(request, "workspaceId").or_else(|| optional_string(request, "workspace_id"))
    {
        let record = workspaces
            .require_workspace(&id)
            .await
            .map_err(|e| e.to_string())?;
        return record
            .filesystem_connection_id()
            .map(|id| id.map(str::to_owned));
    }
    workspaces
        .upgrade_legacy_file_connection(
            path,
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
    files: &FileSystemService,
    workspaces: &WorkspaceService,
    args: &Value,
) -> Result<Value, String> {
    let request = request_value(args);
    let path = get_string(request, "path")?;
    let preferred = directory_connection(workspaces, request, &path).await?;
    let nodes = files
        .get_directory_contents_on_connection(&path, preferred.as_deref())
        .await
        .map_err(|e| format!("Failed to get directory children: {e}"))?;
    Ok(json!(directory_nodes_to_json(nodes)))
}

pub(crate) async fn get_directory_children_paginated(
    files: &FileSystemService,
    workspaces: &WorkspaceService,
    args: &Value,
) -> Result<Value, String> {
    let request = request_value(args);
    let path = get_string(request, "path")?;
    let preferred = directory_connection(workspaces, request, &path).await?;
    let offset = request.get("offset").and_then(|v| v.as_u64()).unwrap_or(0) as usize;
    let limit = request.get("limit").and_then(|v| v.as_u64()).unwrap_or(100) as usize;

    let mut nodes = files
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

pub(crate) async fn get_file_tree(
    files: &FileSystemService,
    workspaces: &WorkspaceService,
    args: &Value,
) -> Result<Value, String> {
    let request = request_value(args);
    let path = get_string(request, "path")?;
    let preferred = directory_connection(workspaces, request, &path).await?;
    let nodes = files
        .build_file_tree_on_connection(&path, preferred.as_deref())
        .await
        .map_err(|error| format!("Failed to build file tree: {error}"))?;
    fn node_value(mut node: openbitfun_core::infrastructure::FileTreeNode) -> Value {
        let children = node.children.take();
        let mut value = directory_nodes_to_json(vec![node]).pop().unwrap();
        if let Some(children) = children {
            value["children"] = json!(children.into_iter().map(node_value).collect::<Vec<_>>());
        }
        value
    }
    let name = if preferred.as_deref().is_some_and(|id| !id.is_empty()) {
        path.trim_end_matches('/')
            .rsplit('/')
            .next()
            .filter(|name| !name.is_empty())
            .unwrap_or(&path)
    } else {
        std::path::Path::new(&path)
            .file_name()
            .and_then(|name| name.to_str())
            .unwrap_or(&path)
    };
    Ok(json!([{
        "path": path, "name": name, "isDirectory": true,
        "size": null, "extension": null, "lastModified": null,
        "children": nodes.into_iter().map(node_value).collect::<Vec<_>>()
    }]))
}

pub(crate) async fn check_path_exists(
    state: &PeerHostState,
    args: &Value,
) -> Result<Value, String> {
    let request = request_value(args);
    let path = get_string(request, "path")?;
    let hint = file_connection(state, request, &path).await?;
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
    let hint = file_connection(state, request, &path).await?;
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
    let hint = file_connection(state, request, &path).await?;
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
    let hint = file_connection(state, request, &path).await?;
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
    let hint = file_connection(state, request, &from).await?;
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
    let hint = file_connection(state, request, &path).await?;
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
    let hint = file_connection(state, request, &path).await?;
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

#[cfg(test)]
mod tests {
    use super::*;

    #[tokio::test]
    async fn explorer_lists_registered_workspace_children_pages_and_tree() {
        let temporary = tempfile::tempdir().unwrap();
        let root = temporary.path().join("workspace");
        std::fs::create_dir_all(root.join("nested")).unwrap();
        std::fs::write(root.join("alpha.txt"), "alpha").unwrap();
        std::fs::write(root.join("zeta.html"), "page").unwrap();
        std::fs::write(root.join("nested/child.js"), "script").unwrap();
        let workspaces =
            WorkspaceService::new_isolated_for_tests(temporary.path().join("user")).await;
        let workspace = workspaces
            .register_local_workspace_record(root.clone())
            .await
            .unwrap();
        let files = FileSystemService::default();
        let args = json!({"request": {"workspaceId": workspace.id, "path": root}});
        let children = get_directory_children(&files, &workspaces, &args)
            .await
            .unwrap();
        let children = children.as_array().unwrap();
        assert_eq!(children.len(), 3);
        assert!(children
            .iter()
            .any(|node| node["name"] == "nested" && node["isDirectory"] == true));
        assert!(children
            .iter()
            .any(|node| node["name"] == "zeta.html" && node["isDirectory"] == false));
        let mut paginated = args.clone();
        paginated["request"]["offset"] = json!(1);
        paginated["request"]["limit"] = json!(1);
        paginated["request"]["sortBy"] = json!("name");
        paginated["request"]["sortOrder"] = json!("asc");
        let page = get_directory_children_paginated(&files, &workspaces, &paginated)
            .await
            .unwrap();
        assert_eq!(page["total"], 3);
        assert_eq!(page["hasMore"], true);
        assert_eq!(page["children"][0]["name"], "alpha.txt");
        let tree = get_file_tree(&files, &workspaces, &args).await.unwrap();
        assert_eq!(tree[0]["name"], "workspace");
        assert_eq!(tree[0]["isDirectory"], true);
        let nested = tree[0]["children"]
            .as_array()
            .unwrap()
            .iter()
            .find(|node| node["name"] == "nested")
            .unwrap();
        assert_eq!(nested["children"][0]["name"], "child.js");
        // Legacy file operations name their path differently from directory reads.
        // Their selected host-local provider must not require a second `path` field.
        for field in ["filePath", "oldPath"] {
            let legacy = json!({field: root.join("alpha.txt"), "remoteConnectionId": ""});
            let selected =
                directory_connection(&workspaces, &legacy, legacy[field].as_str().unwrap())
                    .await
                    .unwrap();
            assert!(selected.is_none());
        }
        let mut invalid = args;
        invalid["request"]["workspaceId"] = json!("missing-workspace");
        assert!(get_directory_children(&files, &workspaces, &invalid)
            .await
            .is_err());
        assert!(get_file_tree(&files, &workspaces, &invalid).await.is_err());
    }
}
