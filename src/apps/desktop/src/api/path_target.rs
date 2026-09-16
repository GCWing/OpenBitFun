//! Shared desktop resolution and access helpers for local, runtime, and remote paths.

use crate::api::app_state::AppState;
use base64::{engine::general_purpose::STANDARD as BASE64, Engine as _};
use openbitfun_core::agentic::tools::workspace_paths::{
    is_openbitfun_runtime_uri, parse_openbitfun_runtime_uri,
};
use openbitfun_core::infrastructure::get_path_manager_arc;
use openbitfun_core::infrastructure::FileOperationOptions;
use openbitfun_core::service::remote_ssh::workspace_state::remote_workspace_runtime_root;
use openbitfun_core::service::remote_ssh::{
    get_remote_workspace_manager, normalize_remote_workspace_path, RemoteWorkspaceEntry,
};
use openbitfun_core::service::workspace::{WorkspaceInfo, WorkspaceKind};
use serde::Serialize;
use std::path::{Path, PathBuf};
use std::time::SystemTime;

/// Resolved file routing identity, independent of workspace registration.
#[derive(Debug, Clone)]
pub struct RemotePathConnection {
    pub connection_id: String,
}

#[derive(Debug, Clone)]
pub enum DesktopPathTarget<T = RemotePathConnection> {
    Local {
        requested_path: String,
        resolved_path: PathBuf,
        is_runtime_artifact: bool,
    },
    Remote {
        requested_path: String,
        entry: T,
    },
}

impl DesktopPathTarget {
    pub fn requested_path(&self) -> &str {
        match self {
            Self::Local { requested_path, .. } | Self::Remote { requested_path, .. } => {
                requested_path.as_str()
            }
        }
    }

    pub fn as_local_path(&self) -> Option<&Path> {
        match self {
            Self::Local { resolved_path, .. } => Some(resolved_path.as_path()),
            Self::Remote { .. } => None,
        }
    }

    pub fn is_runtime_artifact(&self) -> bool {
        matches!(
            self,
            Self::Local {
                is_runtime_artifact: true,
                ..
            }
        )
    }
}

fn runtime_root_for_workspace_info(workspace: &WorkspaceInfo) -> Result<PathBuf, String> {
    if workspace.workspace_kind == WorkspaceKind::Remote {
        let ssh_host = workspace
            .metadata
            .get("sshHost")
            .and_then(|value| value.as_str())
            .map(str::trim)
            .filter(|value| !value.is_empty())
            .ok_or_else(|| {
                format!(
                    "Remote workspace '{}' is missing sshHost metadata",
                    workspace.id
                )
            })?;

        let remote_root = normalize_remote_workspace_path(&workspace.root_path.to_string_lossy());
        return Ok(remote_workspace_runtime_root(ssh_host, &remote_root));
    }

    Ok(get_path_manager_arc().project_runtime_root(&workspace.root_path))
}

async fn resolve_runtime_artifact_path(
    app_state: &AppState,
    raw_path: &str,
) -> Result<Option<PathBuf>, String> {
    if !is_openbitfun_runtime_uri(raw_path) {
        return Ok(None);
    }

    let parsed = parse_openbitfun_runtime_uri(raw_path).map_err(|e| e.to_string())?;
    let workspace = if parsed.workspace_scope == "current" {
        app_state.workspace_service.get_current_workspace().await
    } else {
        app_state
            .workspace_service
            .list_workspace_infos()
            .await
            .into_iter()
            .find(|workspace| workspace.id == parsed.workspace_scope)
    }
    .ok_or_else(|| {
        format!(
            "Unable to resolve runtime URI scope '{}'",
            parsed.workspace_scope
        )
    })?;

    let mut resolved = runtime_root_for_workspace_info(&workspace)?;
    for segment in parsed.relative_path.split('/') {
        resolved.push(segment);
    }

    Ok(Some(resolved))
}

async fn lookup_remote_entry_for_path(
    app_state: &AppState,
    path: &str,
    request_preferred: Option<&str>,
) -> Option<RemoteWorkspaceEntry> {
    if should_force_local_assistant_path(path, request_preferred) {
        return None;
    }

    let manager = get_remote_workspace_manager()?;
    if let Some(connection_id) = request_preferred {
        return manager.lookup_scoped_connection(path, connection_id).await;
    }

    let legacy = app_state
        .get_remote_workspace_async()
        .await
        .map(|workspace| workspace.connection_id);
    manager.lookup_connection(path, legacy.as_deref()).await
}

fn should_force_local_assistant_path(
    path: &str,
    explicit_remote_connection_id: Option<&str>,
) -> bool {
    explicit_remote_connection_id.is_none()
        && get_path_manager_arc().is_local_assistant_workspace_path(path)
}

pub async fn resolve_desktop_path_target(
    app_state: &AppState,
    raw_path: &str,
    preferred_remote_connection_id: Option<&str>,
) -> Result<DesktopPathTarget, String> {
    if let Some(resolved_path) = resolve_runtime_artifact_path(app_state, raw_path).await? {
        return Ok(DesktopPathTarget::Local {
            requested_path: raw_path.to_string(),
            resolved_path,
            is_runtime_artifact: true,
        });
    }

    if preferred_remote_connection_id == Some("") {
        return Ok(DesktopPathTarget::Local {
            requested_path: raw_path.to_string(),
            resolved_path: PathBuf::from(raw_path),
            is_runtime_artifact: false,
        });
    }

    let explicit_connection_id = preferred_remote_connection_id
        .map(str::trim)
        .filter(|value| !value.is_empty());
    if let Some(id) = explicit_connection_id {
        let connection_id = openbitfun_core::service::filesystem::path_operations::resolve_explicit_path_connection(raw_path, id).await?;
        return Ok(DesktopPathTarget::Remote {
            requested_path: raw_path.to_string(),
            entry: RemotePathConnection { connection_id },
        });
    }
    if let Some(entry) =
        lookup_remote_entry_for_path(app_state, raw_path, explicit_connection_id).await
    {
        return Ok(DesktopPathTarget::Remote {
            requested_path: raw_path.to_string(),
            entry: RemotePathConnection {
                connection_id: entry.connection_id,
            },
        });
    }

    Ok(DesktopPathTarget::Local {
        requested_path: raw_path.to_string(),
        resolved_path: PathBuf::from(raw_path),
        is_runtime_artifact: false,
    })
}

/// Workspace search retains registered-root scope even when device file tools
/// use a saved SSH connection outside any opened workspace.
pub async fn resolve_desktop_workspace_path_target(
    app_state: &AppState,
    path: &str,
    preferred: Option<&str>,
) -> Result<DesktopPathTarget<RemoteWorkspaceEntry>, String> {
    match resolve_desktop_path_target(app_state, path, preferred).await? {
        DesktopPathTarget::Local {
            requested_path,
            resolved_path,
            is_runtime_artifact,
        } => Ok(DesktopPathTarget::Local {
            requested_path,
            resolved_path,
            is_runtime_artifact,
        }),
        DesktopPathTarget::Remote {
            requested_path,
            entry,
        } => {
            let workspace = lookup_remote_entry_for_path(
                app_state,
                &requested_path,
                Some(&entry.connection_id),
            )
            .await
            .ok_or("Remote search requires a registered workspace owning the requested path")?;
            Ok(DesktopPathTarget::Remote {
                requested_path,
                entry: workspace,
            })
        }
    }
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct LocalFileMetadata {
    pub path: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub resolved_path: Option<String>,
    pub modified: u64,
    pub size: u64,
    pub is_file: bool,
    pub is_dir: bool,
    pub is_symlink: bool,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub is_remote: Option<bool>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub is_runtime_artifact: Option<bool>,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct RemoteFileMetadata {
    pub path: String,
    pub modified: u64,
    pub size: u64,
    pub is_file: bool,
    pub is_dir: bool,
    pub is_symlink: bool,
    pub is_remote: bool,
}

pub fn stat_local_path_metadata(
    requested_path: &str,
    resolved_path: &Path,
    is_runtime_artifact: bool,
) -> Result<LocalFileMetadata, String> {
    let link_metadata = std::fs::symlink_metadata(resolved_path).map_err(|e| {
        format!(
            "Failed to inspect local file type '{}': {}",
            resolved_path.display(),
            e
        )
    })?;
    let metadata = std::fs::metadata(resolved_path).map_err(|e| {
        format!(
            "Failed to stat local file '{}': {}",
            resolved_path.display(),
            e
        )
    })?;

    // Not collapsible: on Windows a junction/reparse point is not reported as a
    // symlink by `file_type()`, so the extra attribute check is load-bearing.
    // Clippy only sees the `#[cfg(not(windows))] { false }` arm on other targets.
    #[allow(clippy::needless_bool)]
    let is_symlink = if link_metadata.file_type().is_symlink() {
        true
    } else {
        #[cfg(windows)]
        {
            use std::os::windows::fs::MetadataExt;
            const FILE_ATTRIBUTE_REPARSE_POINT: u32 = 0x0400;
            link_metadata.file_attributes() & FILE_ATTRIBUTE_REPARSE_POINT != 0
        }
        #[cfg(not(windows))]
        {
            false
        }
    };

    let modified = metadata
        .modified()
        .unwrap_or(SystemTime::UNIX_EPOCH)
        .duration_since(SystemTime::UNIX_EPOCH)
        .unwrap_or_default()
        .as_millis() as u64;

    Ok(LocalFileMetadata {
        path: requested_path.to_string(),
        resolved_path: is_runtime_artifact.then(|| resolved_path.to_string_lossy().to_string()),
        modified,
        size: metadata.len(),
        is_file: metadata.is_file(),
        is_dir: metadata.is_dir(),
        is_symlink,
        is_remote: Some(false),
        is_runtime_artifact: is_runtime_artifact.then_some(true),
    })
}

pub async fn read_text_file(
    app_state: &AppState,
    raw_path: &str,
    encoding: Option<&str>,
    preferred_remote_connection_id: Option<&str>,
) -> Result<String, String> {
    let target =
        resolve_desktop_path_target(app_state, raw_path, preferred_remote_connection_id).await?;
    match &target {
        DesktopPathTarget::Local { resolved_path, .. } => {
            if encoding.is_some_and(|value| value.eq_ignore_ascii_case("base64")) {
                let bytes = app_state
                    .filesystem_service
                    .read_file_bytes(&resolved_path.to_string_lossy())
                    .await
                    .map_err(|e| format!("Failed to read file content: {}", e))?;
                return Ok(BASE64.encode(bytes));
            }

            let result = app_state
                .filesystem_service
                .read_file(&resolved_path.to_string_lossy())
                .await
                .map_err(|e| format!("Failed to read file content: {}", e))?;
            Ok(result.content)
        }
        DesktopPathTarget::Remote {
            requested_path,
            entry,
        } => {
            let remote_fs = app_state
                .get_remote_file_service_async()
                .await
                .map_err(|e| format!("Remote file service not available: {}", e))?;
            let bytes = remote_fs
                .read_file(&entry.connection_id, requested_path)
                .await
                .map_err(|e| format!("Failed to read remote file: {}", e))?;
            encode_remote_file_bytes(bytes, encoding)
        }
    }
}

fn encode_remote_file_bytes(bytes: Vec<u8>, encoding: Option<&str>) -> Result<String, String> {
    if encoding.is_some_and(|value| value.eq_ignore_ascii_case("base64")) {
        return Ok(BASE64.encode(bytes));
    }

    String::from_utf8(bytes).map_err(|e| format!("File is not valid UTF-8: {}", e))
}

pub async fn write_text_file(
    app_state: &AppState,
    raw_path: &str,
    content: &str,
    preferred_remote_connection_id: Option<&str>,
) -> Result<(), String> {
    match resolve_desktop_path_target(app_state, raw_path, preferred_remote_connection_id).await? {
        DesktopPathTarget::Local { resolved_path, .. } => {
            let options = FileOperationOptions {
                backup_on_overwrite: false,
                ..FileOperationOptions::default()
            };
            app_state
                .filesystem_service
                .write_file_with_options(&resolved_path.to_string_lossy(), content, options)
                .await
                .map(|_| ())
                .map_err(|e| format!("Failed to write file {}: {}", raw_path, e))
        }
        DesktopPathTarget::Remote {
            requested_path,
            entry,
        } => {
            let remote_fs = app_state
                .get_remote_file_service_async()
                .await
                .map_err(|e| format!("Remote file service not available: {}", e))?;
            remote_fs
                .write_file(&entry.connection_id, &requested_path, content.as_bytes())
                .await
                .map_err(|e| format!("Failed to write remote file: {}", e))
        }
    }
}

pub async fn path_exists(
    app_state: &AppState,
    raw_path: &str,
    preferred_remote_connection_id: Option<&str>,
) -> Result<bool, String> {
    match resolve_desktop_path_target(app_state, raw_path, preferred_remote_connection_id).await? {
        DesktopPathTarget::Local { resolved_path, .. } => Ok(resolved_path.exists()),
        DesktopPathTarget::Remote {
            requested_path,
            entry,
        } => {
            let remote_fs = app_state
                .get_remote_file_service_async()
                .await
                .map_err(|e| format!("Remote file service not available: {}", e))?;
            remote_fs
                .exists(&entry.connection_id, &requested_path)
                .await
                .map_err(|e| format!("Failed to check remote path: {}", e))
        }
    }
}

pub async fn get_path_metadata(
    app_state: &AppState,
    raw_path: &str,
    preferred_remote_connection_id: Option<&str>,
) -> Result<serde_json::Value, String> {
    match resolve_desktop_path_target(app_state, raw_path, preferred_remote_connection_id).await? {
        DesktopPathTarget::Local {
            requested_path,
            resolved_path,
            is_runtime_artifact,
        } => {
            let metadata =
                stat_local_path_metadata(&requested_path, &resolved_path, is_runtime_artifact)?;
            serde_json::to_value(metadata)
                .map_err(|e| format!("Failed to serialize file metadata: {}", e))
        }
        DesktopPathTarget::Remote {
            requested_path,
            entry,
        } => {
            let remote_fs = app_state
                .get_remote_file_service_async()
                .await
                .map_err(|e| format!("Remote file service not available: {}", e))?;

            let stat_entry = remote_fs
                .stat(&entry.connection_id, &requested_path)
                .await
                .map_err(|e| format!("Failed to stat remote file: {}", e))?;

            let (is_file, is_dir, is_symlink, size, modified) = match stat_entry {
                Some(entry) => (
                    entry.is_file,
                    entry.is_dir,
                    entry.is_symlink,
                    entry.size.unwrap_or(0),
                    entry.modified.unwrap_or(0),
                ),
                None => (false, false, false, 0, 0),
            };

            serde_json::to_value(RemoteFileMetadata {
                path: requested_path,
                modified,
                size,
                is_file,
                is_dir,
                is_symlink,
                is_remote: true,
            })
            .map_err(|e| format!("Failed to serialize remote file metadata: {}", e))
        }
    }
}

pub async fn rename_path(
    app_state: &AppState,
    old_path: &str,
    new_path: &str,
    preferred_remote_connection_id: Option<&str>,
) -> Result<(), String> {
    match resolve_desktop_path_target(app_state, old_path, preferred_remote_connection_id).await? {
        DesktopPathTarget::Local {
            resolved_path: old_resolved_path,
            ..
        } => {
            let new_resolved_path = match resolve_desktop_path_target(
                app_state,
                new_path,
                preferred_remote_connection_id,
            )
            .await?
            {
                DesktopPathTarget::Local { resolved_path, .. } => resolved_path,
                DesktopPathTarget::Remote { .. } => {
                    return Err(format!(
                        "Cannot rename local path '{}' to remote destination '{}'",
                        old_path, new_path
                    ))
                }
            };

            app_state
                .filesystem_service
                .move_file(
                    &old_resolved_path.to_string_lossy(),
                    &new_resolved_path.to_string_lossy(),
                )
                .await
                .map_err(|e| format!("Failed to rename file: {}", e))
        }
        DesktopPathTarget::Remote { entry, .. } => {
            let remote_fs = app_state
                .get_remote_file_service_async()
                .await
                .map_err(|e| format!("Remote file service not available: {}", e))?;
            remote_fs
                .rename(&entry.connection_id, old_path, new_path)
                .await
                .map_err(|e| format!("Failed to rename remote file: {}", e))
        }
    }
}

pub async fn delete_file(
    app_state: &AppState,
    raw_path: &str,
    preferred_remote_connection_id: Option<&str>,
) -> Result<(), String> {
    match resolve_desktop_path_target(app_state, raw_path, preferred_remote_connection_id).await? {
        DesktopPathTarget::Local { resolved_path, .. } => app_state
            .filesystem_service
            .delete_file(&resolved_path.to_string_lossy())
            .await
            .map_err(|e| format!("Failed to delete file: {}", e)),
        DesktopPathTarget::Remote {
            requested_path,
            entry,
        } => {
            let remote_fs = app_state
                .get_remote_file_service_async()
                .await
                .map_err(|e| format!("Remote file service not available: {}", e))?;
            remote_fs
                .remove_file(&entry.connection_id, &requested_path)
                .await
                .map_err(|e| format!("Failed to delete remote file: {}", e))
        }
    }
}

pub async fn delete_directory(
    app_state: &AppState,
    raw_path: &str,
    recursive: bool,
    preferred_remote_connection_id: Option<&str>,
) -> Result<(), String> {
    match resolve_desktop_path_target(app_state, raw_path, preferred_remote_connection_id).await? {
        DesktopPathTarget::Local { resolved_path, .. } => app_state
            .filesystem_service
            .delete_directory(&resolved_path.to_string_lossy(), recursive)
            .await
            .map_err(|e| format!("Failed to delete directory: {}", e)),
        DesktopPathTarget::Remote {
            requested_path,
            entry,
        } => {
            let remote_fs = app_state
                .get_remote_file_service_async()
                .await
                .map_err(|e| format!("Remote file service not available: {}", e))?;
            if recursive {
                remote_fs
                    .remove_dir_all(&entry.connection_id, &requested_path)
                    .await
                    .map_err(|e| format!("Failed to delete remote directory: {}", e))
            } else {
                remote_fs
                    .remove_dir(&entry.connection_id, &requested_path)
                    .await
                    .map_err(|e| format!("Failed to delete remote directory: {}", e))
            }
        }
    }
}

pub async fn create_empty_file(
    app_state: &AppState,
    raw_path: &str,
    preferred_remote_connection_id: Option<&str>,
) -> Result<(), String> {
    match resolve_desktop_path_target(app_state, raw_path, preferred_remote_connection_id).await? {
        DesktopPathTarget::Local { resolved_path, .. } => {
            let options = FileOperationOptions::default();
            app_state
                .filesystem_service
                .write_file_with_options(&resolved_path.to_string_lossy(), "", options)
                .await
                .map(|_| ())
                .map_err(|e| format!("Failed to create file: {}", e))
        }
        DesktopPathTarget::Remote {
            requested_path,
            entry,
        } => {
            let remote_fs = app_state
                .get_remote_file_service_async()
                .await
                .map_err(|e| format!("Remote file service not available: {}", e))?;
            remote_fs
                .write_file(&entry.connection_id, &requested_path, b"")
                .await
                .map_err(|e| format!("Failed to create remote file: {}", e))
        }
    }
}

pub async fn create_directory(
    app_state: &AppState,
    raw_path: &str,
    preferred_remote_connection_id: Option<&str>,
) -> Result<(), String> {
    match resolve_desktop_path_target(app_state, raw_path, preferred_remote_connection_id).await? {
        DesktopPathTarget::Local { resolved_path, .. } => app_state
            .filesystem_service
            .create_directory(&resolved_path.to_string_lossy())
            .await
            .map_err(|e| format!("Failed to create directory: {}", e)),
        DesktopPathTarget::Remote {
            requested_path,
            entry,
        } => {
            let remote_fs = app_state
                .get_remote_file_service_async()
                .await
                .map_err(|e| format!("Remote file service not available: {}", e))?;
            remote_fs
                .create_dir_all(&entry.connection_id, &requested_path)
                .await
                .map_err(|e| format!("Failed to create remote directory: {}", e))
        }
    }
}

#[cfg(test)]
mod tests {
    use super::{
        encode_remote_file_bytes, get_path_manager_arc, should_force_local_assistant_path,
    };

    #[test]
    fn remote_file_bytes_support_explicit_base64_encoding() {
        let png_header = vec![0x89, b'P', b'N', b'G'];
        assert_eq!(
            encode_remote_file_bytes(png_header, Some("base64")).expect("base64 should encode"),
            "iVBORw=="
        );
    }

    #[test]
    fn remote_file_bytes_preserve_text_default() {
        assert_eq!(
            encode_remote_file_bytes(b"hello".to_vec(), None).expect("text should decode"),
            "hello"
        );
        assert!(encode_remote_file_bytes(vec![0xff], None).is_err());
    }

    #[test]
    fn local_assistant_path_ignores_legacy_remote_fallback_without_explicit_hint() {
        let assistant_path = get_path_manager_arc()
            .assistant_workspace_dir("path-target-local-save", None)
            .to_string_lossy()
            .to_string();

        assert!(should_force_local_assistant_path(&assistant_path, None));
        assert!(!should_force_local_assistant_path(
            &assistant_path,
            Some("explicit-remote-connection")
        ));
        assert!(!should_force_local_assistant_path(
            "/tmp/regular-project",
            None
        ));
    }
}
