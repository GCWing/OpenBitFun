//! Product path routing shared by headless and graphical hosts.
//! Concrete IO stays in the existing local and SSH filesystem services.

use super::FileSystemService;
use crate::service::remote_ssh::{get_remote_workspace_manager, RemoteFileService};

/// Resolve an explicit file-operation connection without registering a workspace.
/// Existing workspace providers remain supported; saved SSH profiles also own
/// device-level paths outside opened workspaces.
pub async fn resolve_explicit_path_connection(path: &str, id: &str) -> Result<String, String> {
    if !path.starts_with('/') || path.contains('\0') {
        return Err("Remote file operation requires an absolute POSIX path".into());
    }
    if let Some(entry) =
        crate::service::remote_ssh::workspace_state::lookup_remote_connection_scoped(path, id).await
    {
        return Ok(entry.connection_id);
    }
    #[cfg(feature = "ssh-remote")]
    {
        let state =
            crate::service::remote_ssh::workspace_state::ensure_saved_connection_services().await?;
        let ssh = state
            .get_ssh_manager()
            .await
            .ok_or("SSH manager is unavailable")?;
        if ssh
            .get_saved_connections()
            .await
            .iter()
            .any(|profile| profile.id == id)
        {
            return Ok(id.to_string());
        }
    }
    Err("Remote connection is unavailable or not saved on this runtime; local fallback was not attempted".into())
}

async fn remote(
    path: &str,
    hint: Option<&str>,
) -> Result<Option<(RemoteFileService, String)>, String> {
    if hint == Some("") {
        return Ok(None);
    }
    let hint = hint.map(str::trim).filter(|value| !value.is_empty());
    let connection_id = if let Some(id) = hint {
        resolve_explicit_path_connection(path, id).await?
    } else {
        return Ok(None);
    };
    let manager =
        get_remote_workspace_manager().ok_or("Remote workspace manager is unavailable")?;
    let service = manager
        .get_file_service()
        .await
        .ok_or("Remote file service is unavailable")?;
    Ok(Some((service, connection_id)))
}

pub async fn read_text(
    service: &FileSystemService,
    path: &str,
    hint: Option<&str>,
) -> Result<String, String> {
    if let Some((fs, id)) = remote(path, hint).await? {
        return String::from_utf8(fs.read_file(&id, path).await.map_err(|e| e.to_string())?)
            .map_err(|_| "File is not UTF-8 text".into());
    }
    let file = service.read_file(path).await.map_err(|e| e.to_string())?;
    if file.is_binary || file.encoding != "UTF-8" {
        return Err("File is not UTF-8 text".into());
    }
    Ok(file.content)
}

/// Serialize optimistic writes by target/path. As in Happy's writeFile handler,
/// expected_hash is checked on the runtime, never by a controller-side read.
/// Empty hash means create-only; absent hash preserves ordinary runtime writes.
/// External editors are not participants in this in-process critical section.
async fn write_guard(key: String) -> std::sync::Arc<tokio::sync::Mutex<()>> {
    openbitfun_services_core::file_write_lock::write_guard(key)
}

pub async fn write_text(
    service: &FileSystemService,
    path: &str,
    content: &str,
    hint: Option<&str>,
) -> Result<(), String> {
    write_text_checked(service, path, content, hint, None).await
}

pub async fn write_text_checked(
    service: &FileSystemService,
    path: &str,
    content: &str,
    hint: Option<&str>,
    expected_hash: Option<&str>,
) -> Result<(), String> {
    write_target_checked(
        service,
        path,
        content,
        remote(path, hint).await?,
        expected_hash,
    )
    .await
}

/// A desktop path resolver has already established that this is host-local.
pub async fn write_local_text_checked(
    service: &FileSystemService,
    path: &str,
    content: &str,
    expected_hash: Option<&str>,
) -> Result<(), String> {
    write_target_checked(service, path, content, None, expected_hash).await
}

async fn write_target_checked(
    service: &FileSystemService,
    path: &str,
    content: &str,
    target: Option<(RemoteFileService, String)>,
    expected_hash: Option<&str>,
) -> Result<(), String> {
    use sha2::{Digest, Sha256};
    let lock_path = if target.is_none() {
        match tokio::fs::canonicalize(path).await {
            Ok(path) => path.to_string_lossy().into_owned(),
            Err(_) => {
                let value = std::path::Path::new(path);
                match (value.parent(), value.file_name()) {
                    (Some(parent), Some(name)) => tokio::fs::canonicalize(parent)
                        .await
                        .map(|parent| parent.join(name).to_string_lossy().into_owned())
                        .unwrap_or_else(|_| path.to_string()),
                    _ => path.to_string(),
                }
            }
        }
    } else {
        path.to_string()
    };
    let key = format!(
        "{}\0{}",
        target
            .as_ref()
            .map(|(_, id)| id.as_str())
            .unwrap_or("local"),
        lock_path
    );
    let lock = write_guard(key).await;
    let _guard = lock.lock().await;
    if let Some(expected) = expected_hash {
        let exists = if let Some((fs, id)) = &target {
            fs.exists(id, path).await.map_err(|e| e.to_string())?
        } else {
            service.exists(path).await
        };
        if expected.is_empty() {
            if exists {
                return Err(
                    "FILE_CONFLICT: File already exists; refresh before replacing it".into(),
                );
            }
        } else {
            if !exists {
                return Err("FILE_CONFLICT: File was removed after it was read".into());
            }
            let bytes = if let Some((fs, id)) = &target {
                fs.read_file(id, path).await.map_err(|e| e.to_string())?
            } else {
                service
                    .read_file_bytes(path)
                    .await
                    .map_err(|e| e.to_string())?
            };
            if format!("{:x}", Sha256::digest(&bytes)) != expected {
                return Err(
                    "FILE_CONFLICT: File changed after it was read; refresh before saving".into(),
                );
            }
        }
    }
    if let Some((fs, id)) = target {
        fs.write_workspace_file(&id, path, content.as_bytes())
            .await
            .map_err(|e| e.to_string())
    } else {
        service
            .write_file_with_options(
                path,
                content,
                openbitfun_services_core::filesystem::FileOperationOptions {
                    // Interactive saves do not request retained sibling backups.
                    // Explicit backup operations retain their own policy.
                    backup_on_overwrite: false,
                    ..Default::default()
                },
            )
            .await
            .map(|_| ())
            .map_err(|e| e.to_string())
    }
}

pub async fn rename(
    service: &FileSystemService,
    from: &str,
    to: &str,
    hint: Option<&str>,
) -> Result<(), String> {
    let source = remote(from, hint).await?;
    let destination = remote(to, hint).await?;
    match (source, destination) {
        (Some((fs, id)), Some((_, target))) if id == target => {
            fs.rename(&id, from, to).await.map_err(|e| e.to_string())
        }
        (None, None) => service.move_file(from, to).await.map_err(|e| e.to_string()),
        _ => Err("Rename cannot cross filesystem connections".into()),
    }
}

pub async fn remove(
    service: &FileSystemService,
    path: &str,
    directory: bool,
    recursive: bool,
    hint: Option<&str>,
) -> Result<(), String> {
    if let Some((fs, id)) = remote(path, hint).await? {
        return if !directory {
            fs.remove_file(&id, path).await
        } else if recursive {
            fs.remove_dir_all(&id, path).await
        } else {
            fs.remove_dir(&id, path).await
        }
        .map_err(|e| e.to_string());
    }
    if directory {
        service.delete_directory(path, recursive).await
    } else {
        service.delete_file(path).await
    }
    .map_err(|e| e.to_string())
}

pub async fn create_directory(
    service: &FileSystemService,
    path: &str,
    hint: Option<&str>,
) -> Result<(), String> {
    if let Some((fs, id)) = remote(path, hint).await? {
        return fs
            .create_dir_all(&id, path)
            .await
            .map_err(|e| e.to_string());
    }
    service
        .create_directory(path)
        .await
        .map_err(|e| e.to_string())
}

pub async fn exists(
    service: &FileSystemService,
    path: &str,
    hint: Option<&str>,
) -> Result<bool, String> {
    if let Some((fs, id)) = remote(path, hint).await? {
        return fs.exists(&id, path).await.map_err(|e| e.to_string());
    }
    Ok(service.exists(path).await)
}

#[cfg(test)]
mod tests {
    #[tokio::test]
    async fn explicit_file_scope_retains_registered_provider_and_rejects_invalid_paths() {
        let manager = crate::service::remote_ssh::workspace_state::init_remote_workspace_manager();
        let root = format!("/routing-test-{}", uuid::Uuid::new_v4());
        manager
            .register_remote_workspace(
                root.clone(),
                "file-scope-test".into(),
                "Fixture".into(),
                "host".into(),
            )
            .await;
        assert_eq!(
            super::resolve_explicit_path_connection(&format!("{root}/file"), "file-scope-test")
                .await
                .unwrap(),
            "file-scope-test"
        );
        for path in ["relative/file", "C:\\file", "/invalid\0file"] {
            assert!(
                super::resolve_explicit_path_connection(path, "file-scope-test")
                    .await
                    .is_err()
            );
        }
        manager
            .unregister_remote_workspace("file-scope-test", &root)
            .await;
    }

    #[tokio::test]
    async fn explicit_local_scope_bypasses_same_path_remote_routing() {
        let temp = tempfile::tempdir().unwrap();
        let root = temp.path().to_string_lossy().to_string();
        std::fs::write(temp.path().join("local.txt"), "local bytes").unwrap();
        let manager = crate::service::remote_ssh::workspace_state::init_remote_workspace_manager();
        manager
            .register_remote_workspace(
                root.clone(),
                "path-ops-shadow".into(),
                "Other provider".into(),
                "test-host".into(),
            )
            .await;
        let service = super::FileSystemService::default();
        let path = format!("{root}/local.txt");
        assert_eq!(
            super::read_text(&service, &path, Some("")).await.unwrap(),
            "local bytes"
        );
        super::write_text_checked(&service, &path, "updated local", Some(""), None)
            .await
            .unwrap();
        assert_eq!(std::fs::read_to_string(&path).unwrap(), "updated local");
        manager
            .unregister_remote_workspace("path-ops-shadow", &root)
            .await;
    }

    use super::*;

    #[tokio::test]
    async fn interactive_saves_and_conflicts_do_not_leave_sibling_backups() {
        use sha2::{Digest, Sha256};
        let root = tempfile::tempdir().unwrap();
        let path = root.path().join("edited.txt");
        let path = path.to_str().unwrap();
        let service = FileSystemService::default();
        write_text_checked(&service, path, "first", None, Some(""))
            .await
            .unwrap();
        let first_hash = format!("{:x}", Sha256::digest(b"first"));
        write_text_checked(&service, path, "second", None, Some(&first_hash))
            .await
            .unwrap();
        let error = write_text_checked(&service, path, "stale", None, Some(&first_hash))
            .await
            .unwrap_err();
        assert!(error.contains("FILE_CONFLICT"));
        assert_eq!(tokio::fs::read_to_string(path).await.unwrap(), "second");
        write_local_text_checked(&service, path, "third", None)
            .await
            .unwrap();
        write_text_checked(&service, path, "fourth", None, None)
            .await
            .unwrap();
        let entries: Vec<_> = std::fs::read_dir(root.path())
            .unwrap()
            .map(|entry| entry.unwrap().file_name())
            .collect();
        assert_eq!(entries, vec![std::ffi::OsString::from("edited.txt")]);
    }

    #[tokio::test]
    async fn optimistic_writes_reject_stale_and_create_collisions() {
        use sha2::{Digest, Sha256};
        let root = tempfile::tempdir().unwrap();
        let path = root.path().join("revision.txt");
        let path = path.to_str().unwrap();
        let service = FileSystemService::default();
        write_local_text_checked(&service, path, "initial", Some(""))
            .await
            .unwrap();
        assert!(
            write_local_text_checked(&service, path, "overwrite", Some(""))
                .await
                .is_err()
        );
        let hash = format!("{:x}", Sha256::digest(b"initial"));
        let (first, second) = tokio::join!(
            write_local_text_checked(&service, path, "first", Some(&hash)),
            write_local_text_checked(&service, path, "second", Some(&hash))
        );
        assert_ne!(first.is_ok(), second.is_ok());
        assert!(
            write_local_text_checked(&service, path, "stale", Some(&hash))
                .await
                .is_err()
        );
        assert_ne!(read_text(&service, path, None).await.unwrap(), "stale");
    }

    #[tokio::test]
    async fn explicit_missing_remote_never_reads_or_mutates_local_twin() {
        let root = tempfile::tempdir().unwrap();
        let path = root.path().join("twin.txt");
        tokio::fs::write(&path, "local-secret").await.unwrap();
        let path = path.to_str().unwrap();
        let service = FileSystemService::default();
        let hint = Some("unavailable-filesystem-test-connection");
        assert!(read_text(&service, path, hint).await.is_err());
        assert!(write_text(&service, path, "changed", hint).await.is_err());
        assert!(remove(&service, path, false, false, hint).await.is_err());
        assert!(exists(&service, path, hint).await.is_err());
        assert_eq!(
            tokio::fs::read_to_string(path).await.unwrap(),
            "local-secret"
        );
    }

    #[tokio::test]
    async fn local_file_management_round_trip_and_nonrecursive_delete() {
        let root = tempfile::tempdir().unwrap();
        let directory = root.path().join("managed");
        let first = directory.join("first.txt");
        let second = directory.join("second.txt");
        let service = FileSystemService::default();
        create_directory(&service, directory.to_str().unwrap(), None)
            .await
            .unwrap();
        write_text(&service, first.to_str().unwrap(), "hello 世界", None)
            .await
            .unwrap();
        rename(
            &service,
            first.to_str().unwrap(),
            second.to_str().unwrap(),
            None,
        )
        .await
        .unwrap();
        assert_eq!(
            read_text(&service, second.to_str().unwrap(), None)
                .await
                .unwrap(),
            "hello 世界"
        );
        assert!(
            remove(&service, directory.to_str().unwrap(), true, false, None)
                .await
                .is_err()
        );
        remove(&service, second.to_str().unwrap(), false, false, None)
            .await
            .unwrap();
        remove(&service, directory.to_str().unwrap(), true, false, None)
            .await
            .unwrap();
    }
}
