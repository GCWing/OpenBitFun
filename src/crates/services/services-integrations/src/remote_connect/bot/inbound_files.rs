//! Incoming attachments are written through the session-selected filesystem.
use crate::remote_connect::file_projection::SessionFileTarget;
use anyhow::{bail, Context, Result};
use base64::{engine::general_purpose::STANDARD as B64, Engine};
use openbitfun_runtime_ports::WorkspacePathKind;
use openbitfun_runtime_ports::{RemoteSessionAttachment, RemoteStoredAttachment};
use sha2::{Digest, Sha256};
use tokio::io::AsyncWriteExt;

pub const MAX_SESSION_ATTACHMENT_BYTES: usize = 30 * 1024 * 1024;
// Serializes duplicate RPC retries through validation, write and publication.
static SAVE_LOCK: tokio::sync::Mutex<()> = tokio::sync::Mutex::const_new(());

pub async fn store_session_attachment(
    target: &SessionFileTarget,
    session_id: &str,
    attachment: RemoteSessionAttachment,
) -> Result<RemoteStoredAttachment> {
    if session_id.is_empty() || uuid::Uuid::parse_str(&attachment.attachment_id).is_err() {
        bail!("Invalid session attachment identity");
    }
    if attachment.name.len() > 1024
        || attachment.content_base64.len() > MAX_SESSION_ATTACHMENT_BYTES.div_ceil(3) * 4
    {
        bail!("Session attachment exceeds the transfer limit");
    }
    let bytes = B64
        .decode(&attachment.content_base64)
        .context("Invalid attachment base64")?;
    if bytes.len() > MAX_SESSION_ATTACHMENT_BYTES {
        bail!("Session attachment exceeds the transfer limit");
    }
    let storage_id = format!(
        "{:x}",
        Sha256::digest(format!("{session_id}:{}", attachment.attachment_id))
    );
    let file = InboundFile {
        name: attachment.name,
        bytes,
    };
    let path = save_with_id(target, &file, &storage_id, true).await?;
    Ok(RemoteStoredAttachment {
        attachment_id: attachment.attachment_id,
        name: safe_filename(&file.name),
        path,
        size: file.bytes.len() as u64,
    })
}

#[derive(Debug)]
pub struct InboundFile {
    pub name: String,
    pub bytes: Vec<u8>,
}

fn safe_filename(name: &str) -> String {
    let name = name.rsplit(['/', '\\']).next().unwrap_or_default();
    let name: String = name
        .chars()
        .take(120)
        .map(|ch| {
            if ch.is_control() || "<>:\"|?*".contains(ch) {
                '_'
            } else {
                ch
            }
        })
        .collect();
    let mut end = name.len().min(180);
    while !name.is_char_boundary(end) {
        end -= 1;
    }
    let name = &name[..end];
    let name = name.trim_matches([' ', '.']);
    if name.is_empty() {
        return "file.bin".into();
    }
    // Prefix avoids Windows reserved device names, including names with extensions.
    let stem = name
        .split('.')
        .next()
        .unwrap_or_default()
        .to_ascii_uppercase();
    if matches!(stem.as_str(), "CON" | "PRN" | "AUX" | "NUL")
        || (stem.len() == 4
            && (stem.starts_with("COM") || stem.starts_with("LPT"))
            && stem.as_bytes()[3].is_ascii_digit())
    {
        format!("file-{name}")
    } else {
        name.to_owned()
    }
}

/// Each attachment gets a private, unique directory. The supplied name cannot
/// select a path or overwrite a workspace file. Return only after the stream is
/// closed, so an Agent never receives a path to a partial download.
pub async fn save_inbound_file(target: &SessionFileTarget, file: &InboundFile) -> Result<String> {
    save_with_id(target, file, &uuid::Uuid::new_v4().to_string(), false).await
}

async fn save_with_id(
    target: &SessionFileTarget,
    file: &InboundFile,
    storage_id: &str,
    replay: bool,
) -> Result<String> {
    let _guard = SAVE_LOCK.lock().await;

    let root = if target.remote {
        if !target.root.starts_with('/') || target.root.split('/').any(|p| p == ".." || p == ".") {
            bail!("Remote attachment workspace must be an absolute POSIX path");
        }
        let mut ancestor = String::new();
        for part in target.root.split('/').filter(|part| !part.is_empty()) {
            ancestor.push('/');
            ancestor.push_str(part);
            if target.fs.path_kind_no_follow(&ancestor).await? != Some(WorkspacePathKind::Directory)
            {
                bail!("Remote attachment workspace is unavailable or traverses a symbolic link");
            }
        }
        target.root.clone()
    } else {
        tokio::fs::canonicalize(&target.root)
            .await
            .context("Attachment workspace is unavailable")?
            .to_string_lossy()
            .into_owned()
    };
    let directory = target
        .fs
        .join_path(&root, &[&format!(".openbitfun-inbound-{storage_id}")]);
    let path = target
        .fs
        .join_path(&directory, &[&safe_filename(&file.name)]);
    if let Some(kind) = target.fs.path_kind_no_follow(&directory).await? {
        if replay
            && kind == WorkspacePathKind::Directory
            && target.fs.path_kind_no_follow(&path).await? == Some(WorkspacePathKind::File)
            && target
                .fs
                .read_file_bounded(&path, file.bytes.len())
                .await?
                .as_deref()
                == Some(file.bytes.as_slice())
        {
            return Ok(path);
        }
        bail!("Attachment identity already exists with different or incomplete content; resend as a new attachment");
    }
    target.fs.create_dir_all(&directory).await?;
    let mut file_created = false;
    let saved = async {
        if target.fs.path_kind_no_follow(&directory).await? != Some(WorkspacePathKind::Directory) {
            bail!("Attachment directory is not a regular directory");
        }
        if target.remote || cfg!(unix) {
            target.fs.set_permissions(&directory, 0o700).await?;
        }
        let mut writer = target.fs.open_write_new(&path).await?;
        file_created = true;
        if target.remote || cfg!(unix) {
            target.fs.set_permissions(&path, 0o600).await?;
        }
        writer.write_all(&file.bytes).await?;
        writer.shutdown().await?;
        Ok::<_, anyhow::Error>(path.clone())
    }
    .await;
    if saved.is_err() {
        // Only clean up this newly created attachment, never existing user data.
        if file_created {
            let _ = target.fs.remove_file(&path).await;
        }
        let _ = target.fs.remove_dir(&directory, false).await;
    }
    saved
}

pub fn attachment_prompt(name: &str, path: &str, size: usize) -> String {
    format!(
        "\n\n[User attached a file]\n{}",
        serde_json::json!({
            "name": name, "path": path, "size_bytes": size,
        })
    )
}

#[cfg(test)]
mod tests {
    use super::*;
    use openbitfun_runtime_ports::{WorkspaceDirEntry, WorkspaceFileSystem, WorkspaceWriter};
    use std::{
        path::PathBuf,
        sync::{Arc, Mutex},
    };

    struct TestFs {
        root: PathBuf,
        remote: bool,
        offline: bool,
        writes: Mutex<Vec<String>>,
    }
    impl TestFs {
        fn local(&self, path: &str) -> PathBuf {
            if self.remote {
                assert!(path == "/remote" || path.starts_with("/remote/"));
                self.root.join(
                    path.strip_prefix("/remote")
                        .unwrap()
                        .trim_start_matches('/'),
                )
            } else {
                PathBuf::from(path)
            }
        }
    }
    #[async_trait::async_trait]
    impl WorkspaceFileSystem for TestFs {
        fn join_path(&self, root: &str, components: &[&str]) -> String {
            if self.remote {
                format!("{}/{}", root.trim_end_matches('/'), components.join("/"))
            } else {
                let mut p = PathBuf::from(root);
                p.extend(components);
                p.to_string_lossy().into()
            }
        }
        async fn path_kind_no_follow(&self, path: &str) -> Result<Option<WorkspacePathKind>> {
            if self.offline {
                bail!("offline");
            }
            match tokio::fs::symlink_metadata(self.local(path)).await {
                Ok(m) => Ok(Some(if m.is_symlink() {
                    WorkspacePathKind::Symlink
                } else if m.is_dir() {
                    WorkspacePathKind::Directory
                } else {
                    WorkspacePathKind::File
                })),
                Err(e) if e.kind() == std::io::ErrorKind::NotFound => Ok(None),
                Err(e) => Err(e.into()),
            }
        }
        async fn create_dir_all(&self, path: &str) -> Result<()> {
            Ok(tokio::fs::create_dir_all(self.local(path)).await?)
        }
        async fn open_write_new(&self, path: &str) -> Result<WorkspaceWriter> {
            self.writes.lock().unwrap().push(path.into());
            Ok(Box::new(
                tokio::fs::OpenOptions::new()
                    .write(true)
                    .create_new(true)
                    .open(self.local(path))
                    .await?,
            ))
        }
        async fn set_permissions(&self, path: &str, mode: u32) -> Result<()> {
            #[cfg(unix)]
            {
                use std::os::unix::fs::PermissionsExt;
                tokio::fs::set_permissions(self.local(path), std::fs::Permissions::from_mode(mode))
                    .await?;
            }
            #[cfg(not(unix))]
            let _ = (path, mode);
            Ok(())
        }
        async fn read_file(&self, path: &str) -> Result<Vec<u8>> {
            Ok(tokio::fs::read(self.local(path)).await?)
        }
        async fn read_file_text(&self, _: &str) -> Result<String> {
            bail!("unused")
        }
        async fn write_file(&self, _: &str, _: &[u8]) -> Result<()> {
            bail!("unused")
        }
        async fn exists(&self, _: &str) -> Result<bool> {
            bail!("unused")
        }
        async fn is_file(&self, _: &str) -> Result<bool> {
            bail!("unused")
        }
        async fn is_dir(&self, _: &str) -> Result<bool> {
            bail!("unused")
        }
        async fn read_dir(&self, _: &str) -> Result<Vec<WorkspaceDirEntry>> {
            bail!("unused")
        }
    }
    #[tokio::test]
    async fn inbound_files_are_private_unique_and_stay_on_the_selected_filesystem() {
        for remote in [false, true] {
            let directory = tempfile::tempdir().unwrap();
            let fs = Arc::new(TestFs {
                root: directory.path().into(),
                remote,
                offline: false,
                writes: Mutex::new(vec![]),
            });
            let root = if remote {
                "/remote".into()
            } else {
                directory.path().to_string_lossy().into_owned()
            };
            let target = SessionFileTarget {
                fs: fs.clone(),
                root,
                path: String::new(),
                remote,
            };
            let file = InboundFile {
                name: r"../../C:\keys\KeyPair.pem".into(),
                bytes: b"fixture\0\xff".to_vec(),
            };
            let first = save_inbound_file(&target, &file).await.unwrap();
            let second = save_inbound_file(&target, &file).await.unwrap();
            assert_ne!(first, second);
            assert!(first.ends_with("KeyPair.pem"));
            assert_eq!(fs.read_file(&first).await.unwrap(), file.bytes);
            assert_eq!(*fs.writes.lock().unwrap(), vec![first.clone(), second]);
            if remote {
                assert!(first.starts_with("/remote/.openbitfun-inbound-"));
            }
            #[cfg(unix)]
            {
                use std::os::unix::fs::PermissionsExt;
                assert_eq!(
                    std::fs::metadata(fs.local(&first))
                        .unwrap()
                        .permissions()
                        .mode()
                        & 0o777,
                    0o600
                );
                assert_eq!(
                    std::fs::metadata(fs.local(&first).parent().unwrap())
                        .unwrap()
                        .permissions()
                        .mode()
                        & 0o777,
                    0o700
                );
            }
            let prompt = attachment_prompt(&file.name, &first, file.bytes.len());
            let data: serde_json::Value =
                serde_json::from_str(prompt.lines().last().unwrap()).unwrap();
            assert_eq!(data["path"], first);
            assert_eq!(data["name"], file.name);
        }
    }
    #[tokio::test]
    async fn offline_remote_has_no_local_fallback() {
        let directory = tempfile::tempdir().unwrap();
        let fs = Arc::new(TestFs {
            root: directory.path().into(),
            remote: true,
            offline: true,
            writes: Mutex::new(vec![]),
        });
        let target = SessionFileTarget {
            fs: fs.clone(),
            root: "/remote".into(),
            path: String::new(),
            remote: true,
        };
        assert!(save_inbound_file(
            &target,
            &InboundFile {
                name: "key.pem".into(),
                bytes: vec![42]
            }
        )
        .await
        .is_err());
        assert!(fs.writes.lock().unwrap().is_empty());
        assert_eq!(std::fs::read_dir(directory.path()).unwrap().count(), 0);
    }
    #[cfg(unix)]
    #[tokio::test]
    async fn remote_workspace_symlink_is_rejected_before_writing() {
        let directory = tempfile::tempdir().unwrap();
        let outside = tempfile::tempdir().unwrap();
        std::os::unix::fs::symlink(outside.path(), directory.path().join("link")).unwrap();
        let fs = Arc::new(TestFs {
            root: directory.path().into(),
            remote: true,
            offline: false,
            writes: Mutex::new(vec![]),
        });
        let target = SessionFileTarget {
            fs: fs.clone(),
            root: "/remote/link".into(),
            path: String::new(),
            remote: true,
        };
        assert!(save_inbound_file(
            &target,
            &InboundFile {
                name: "key.pem".into(),
                bytes: vec![42]
            }
        )
        .await
        .is_err());
        assert!(fs.writes.lock().unwrap().is_empty());
        assert_eq!(std::fs::read_dir(outside.path()).unwrap().count(), 0);
    }

    #[test]
    fn filenames_cannot_escape_or_select_device_paths() {
        for (name, expected) in [
            ("..", "file.bin"),
            ("../../key.pem", "key.pem"),
            (r"C:\keys\key.pem", "key.pem"),
            ("CON.txt", "file-CON.txt"),
            ("a\n:b.pem", "a__b.pem"),
        ] {
            assert_eq!(safe_filename(name), expected);
        }
        assert!(safe_filename(&"文".repeat(200)).len() <= 180);
    }

    #[tokio::test]
    async fn session_attachment_retries_are_idempotent_scoped_and_conflict_safe() {
        let directory = tempfile::tempdir().unwrap();
        let fs = Arc::new(TestFs {
            root: directory.path().into(),
            remote: true,
            offline: false,
            writes: Mutex::new(vec![]),
        });
        let target = SessionFileTarget {
            fs: fs.clone(),
            root: "/remote".into(),
            path: String::new(),
            remote: true,
        };
        let request = RemoteSessionAttachment {
            attachment_id: uuid::Uuid::new_v4().to_string(),
            name: "key.pem".into(),
            content_base64: B64.encode(b"fixture"),
        };
        let (first, repeated) = tokio::join!(
            store_session_attachment(&target, "session-a", request.clone()),
            store_session_attachment(&target, "session-a", request.clone()),
        );
        let first = first.unwrap();
        assert_eq!(first, repeated.unwrap());
        assert_eq!(fs.writes.lock().unwrap().len(), 1);
        let other_session = store_session_attachment(&target, "session-b", request.clone())
            .await
            .unwrap();
        assert_ne!(first.path, other_session.path);
        let mut conflict = request.clone();
        conflict.content_base64 = B64.encode(b"changed");
        assert!(store_session_attachment(&target, "session-a", conflict)
            .await
            .is_err());
        assert_eq!(fs.read_file(&first.path).await.unwrap(), b"fixture");
        // A lost ACK can be retried after restart: no in-memory receipt is needed.
        assert_eq!(
            store_session_attachment(&target, "session-a", request)
                .await
                .unwrap(),
            first
        );
    }

    #[tokio::test]
    async fn invalid_attachment_wire_payload_never_writes() {
        let directory = tempfile::tempdir().unwrap();
        let fs = Arc::new(TestFs {
            root: directory.path().into(),
            remote: true,
            offline: false,
            writes: Mutex::new(vec![]),
        });
        let target = SessionFileTarget {
            fs: fs.clone(),
            root: "/remote".into(),
            path: String::new(),
            remote: true,
        };
        for (id, encoded) in [
            ("../escape".into(), B64.encode(b"fixture")),
            (uuid::Uuid::new_v4().to_string(), "invalid-base64".into()),
        ] {
            assert!(store_session_attachment(
                &target,
                "session",
                RemoteSessionAttachment {
                    attachment_id: id,
                    name: "key.pem".into(),
                    content_base64: encoded
                }
            )
            .await
            .is_err());
        }
        assert!(fs.writes.lock().unwrap().is_empty());
    }
}
