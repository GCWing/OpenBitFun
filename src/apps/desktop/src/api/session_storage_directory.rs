//! Desktop-only access to host-owned Session storage, including remote mirrors.

use super::app_state::AppState;
use openbitfun_core::agentic::session::CoreSessionStorePort;
use openbitfun_core::service::session::SessionStorageLayout;
use openbitfun_runtime_ports::SessionStorePort;
use serde::Deserialize;
use std::path::{Path, PathBuf};
use tauri::State;

#[derive(Debug, Deserialize)]
pub struct RevealSessionStorageDirectoryRequest {
    pub workspace_id: String,
    #[serde(default)]
    pub session_id: Option<String>,
}

async fn prepare_storage_directory(
    sessions_root: &Path,
    session_id: Option<&str>,
) -> Result<PathBuf, String> {
    if let Some(session_id) = session_id {
        openbitfun_core_types::validate_session_id(session_id)?;
        let directory =
            SessionStorageLayout::new(sessions_root.to_path_buf()).session_dir(session_id);
        if !directory.is_dir() {
            return Err("The session has no stored directory in this workspace".to_string());
        }
        return Ok(directory);
    }

    // Empty workspaces still need a directory for backups and manual recovery.
    tokio::fs::create_dir_all(sessions_root)
        .await
        .map_err(|error| format!("Failed to create session storage directory: {error}"))?;
    Ok(sessions_root.to_path_buf())
}

#[tauri::command]
pub async fn reveal_session_storage_directory(
    state: State<'_, AppState>,
    request: RevealSessionStorageDirectoryRequest,
) -> Result<(), String> {
    let workspace_id = request.workspace_id.trim();
    if workspace_id.is_empty() {
        return Err("Workspace ID is required".to_string());
    }
    // Resolve the owning project and its managed storage; execution paths and
    // controller-side paths must never be used as session-storage fallbacks.
    state
        .workspace_service
        .require_workspace(workspace_id)
        .await
        .map_err(|error| error.to_string())?;
    let storage = CoreSessionStorePort::default()
        .resolve_workspace_storage(workspace_id)
        .await
        .map_err(|error| error.to_string())?;
    let directory = prepare_storage_directory(
        &storage.effective_storage_path,
        request.session_id.as_deref(),
    )
    .await?;
    super::commands::reveal_local_path_in_explorer(&directory, &directory.to_string_lossy())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[tokio::test]
    async fn opens_the_workspace_storage_root_and_existing_session_directory() {
        let temp = tempfile::tempdir().unwrap();
        let sessions_root = temp.path().join("project-runtime").join("sessions");
        assert_eq!(
            prepare_storage_directory(&sessions_root, None)
                .await
                .unwrap(),
            sessions_root
        );
        let directory = sessions_root.join("session-1");
        tokio::fs::create_dir(&directory).await.unwrap();
        tokio::fs::write(directory.join("metadata.json"), b"preserve this metadata")
            .await
            .unwrap();
        assert_eq!(
            prepare_storage_directory(&sessions_root, Some("session-1"))
                .await
                .unwrap(),
            directory
        );
        assert_eq!(
            tokio::fs::read(directory.join("metadata.json"))
                .await
                .unwrap(),
            b"preserve this metadata"
        );
    }

    #[tokio::test]
    async fn never_creates_a_missing_session_or_accepts_path_traversal() {
        let temp = tempfile::tempdir().unwrap();
        let sessions_root = temp.path().join("sessions");
        for session_id in ["missing-session", "", "../outside", "nested/session"] {
            assert!(prepare_storage_directory(&sessions_root, Some(session_id))
                .await
                .is_err());
        }
        assert!(!sessions_root.exists());
    }
}
