//! Bounded file delivery over the filesystem selected by the owning session.
use super::{
    detect_remote_mime_type, RemoteWorkspaceFileChunk, RemoteWorkspaceFileContent,
    RemoteWorkspaceFileInfo, REMOTE_FILE_MAX_CHUNK_BYTES,
};
use openbitfun_runtime_ports::{WorkspaceFileSystem, WorkspaceMetadata, WorkspacePathKind};
use std::{path::Path, sync::Arc};
use tokio::io::{AsyncReadExt, AsyncSeekExt};

/// Explicit controller reads may address any file on the selected provider.
/// Automatic output delivery and runtime artifact URIs retain their root boundary.
#[derive(Clone, Copy, PartialEq, Eq)]
pub enum FileReadScope {
    Workspace,
    Provider,
}

pub fn controller_file_read_scope(reference: &str) -> Result<FileReadScope, String> {
    Ok(
        if normalize_file_reference(reference)?.starts_with("openbitfun://") {
            FileReadScope::Workspace
        } else {
            FileReadScope::Provider
        },
    )
}

/// Assembly selects the provider and allowed root. This layer owns IO and confinement.
pub struct SessionFileTarget {
    pub fs: Arc<dyn WorkspaceFileSystem>,
    pub path: String,
    pub root: String,
    pub remote: bool,
}

/// Decode a link once, before path resolution. Runtime URIs have their own parser.
pub fn normalize_file_reference(raw: &str) -> Result<String, String> {
    if raw.starts_with("openbitfun://") {
        return Ok(raw.to_string());
    }
    let uri_path = raw
        .strip_prefix("computer://")
        .or_else(|| raw.strip_prefix("file://"))
        .or_else(|| raw.strip_prefix("file:"));
    let path = match uri_path {
        Some(path) => {
            urlencoding::decode(path).map_err(|_| "Invalid encoded file reference".to_string())?
        }
        None => std::borrow::Cow::Borrowed(raw),
    };
    let path = path.strip_prefix("{{workspaceFolder}}/").unwrap_or(&path);
    let path = if path.as_bytes().first() == Some(&b'/') && path.as_bytes().get(2) == Some(&b':') {
        &path[1..]
    } else {
        path
    };
    if path.is_empty() || path.contains('\0') {
        return Err("Empty or invalid file reference".to_string());
    }
    Ok(path.to_string())
}

fn posix_path(path: &str) -> Result<String, String> {
    if !path.starts_with('/') {
        return Err("Remote file path must be absolute".to_string());
    }
    let mut parts = Vec::new();
    for part in path.split('/') {
        match part {
            "" | "." => {}
            ".." => {
                if parts.pop().is_none() {
                    return Err("File path escapes its root".to_string());
                }
            }
            part => parts.push(part),
        }
    }
    Ok(format!("/{}", parts.join("/")))
}

impl SessionFileTarget {
    async fn checked_path(&self, scope: FileReadScope) -> Result<String, String> {
        if !self.remote {
            let path = tokio::fs::canonicalize(&self.path)
                .await
                .map_err(|e| format!("Cannot resolve output file: {e}"))?;
            if scope == FileReadScope::Workspace {
                let root = tokio::fs::canonicalize(&self.root)
                    .await
                    .map_err(|e| format!("Cannot resolve file workspace: {e}"))?;
                if !path.starts_with(root) {
                    return Err("Output file is outside its session workspace".to_string());
                }
            }
            return Ok(path.to_string_lossy().into_owned());
        }
        // Remote syntax stays POSIX even on Windows. Never probe controller paths.
        let path = posix_path(&self.path)?;
        if scope == FileReadScope::Provider {
            return Ok(path);
        }
        let root = posix_path(&self.root)?;
        if root != "/" && path != root && !path.starts_with(&format!("{root}/")) {
            return Err("Output file is outside its session workspace".to_string());
        }
        // Providers expose exact no-follow metadata. Until canonical remote paths
        // are available, do not follow a symlink that could escape the boundary.
        let mut ancestor = String::new();
        for part in path.split('/').filter(|part| !part.is_empty()) {
            ancestor.push('/');
            ancestor.push_str(part);
            match self.fs.path_kind_no_follow(&ancestor).await.map_err(|e| e.to_string())? {
                Some(WorkspacePathKind::Symlink) => return Err("Remote output through a symbolic link is unsupported; copy the file into the session workspace".to_string()),
                None => return Err(format!("Output file not found: {ancestor}")),
                _ => {}
            }
        }
        Ok(path)
    }

    async fn metadata_at(
        &self,
        path: &str,
        scope: FileReadScope,
    ) -> Result<WorkspaceMetadata, String> {
        let metadata = self
            .fs
            .metadata(path, scope == FileReadScope::Provider)
            .await
            .map_err(|e| e.to_string())?
            .ok_or_else(|| "Output file not found".to_string())?;
        if metadata.kind != WorkspacePathKind::File {
            return Err("Output is not a regular file".to_string());
        }
        if metadata.size.is_none() {
            return Err("Output file size is unavailable".to_string());
        }
        Ok(metadata)
    }

    async fn unchanged(
        &self,
        path: &str,
        before: &WorkspaceMetadata,
        scope: FileReadScope,
    ) -> Result<(), String> {
        let after = self.metadata_at(path, scope).await?;
        if after.size != before.size || after.modified != before.modified {
            return Err(
                "Output file changed during transfer; retry when generation finishes".to_string(),
            );
        }
        Ok(())
    }

    pub async fn info(&self) -> Result<RemoteWorkspaceFileInfo, String> {
        self.info_with_scope(FileReadScope::Workspace).await
    }

    pub async fn info_with_scope(
        &self,
        scope: FileReadScope,
    ) -> Result<RemoteWorkspaceFileInfo, String> {
        let path = self.checked_path(scope).await?;
        let metadata = self.metadata_at(&path, scope).await?;
        // A POSIX basename is independent of the controller OS.
        let name = path
            .rsplit(if self.remote {
                '/'
            } else {
                std::path::MAIN_SEPARATOR
            })
            .next()
            .unwrap_or("file")
            .to_string();
        Ok(RemoteWorkspaceFileInfo {
            mime_type: detect_remote_mime_type(Path::new(&name)),
            name,
            size: metadata.size.unwrap(),
        })
    }

    pub async fn read(&self, max_bytes: u64) -> Result<RemoteWorkspaceFileContent, String> {
        self.read_with_scope(max_bytes, FileReadScope::Workspace)
            .await
    }

    pub async fn read_with_scope(
        &self,
        max_bytes: u64,
        scope: FileReadScope,
    ) -> Result<RemoteWorkspaceFileContent, String> {
        let path = self.checked_path(scope).await?;
        let before = self.metadata_at(&path, scope).await?;
        let size = before.size.unwrap();
        if size > max_bytes {
            return Err(format!(
                "Output file too large ({size} bytes, limit {max_bytes} bytes)"
            ));
        }
        let bound =
            usize::try_from(max_bytes).map_err(|_| "Invalid file size limit".to_string())?;
        let bytes = self
            .fs
            .read_file_bounded(&path, bound)
            .await
            .map_err(|e| e.to_string())?
            .ok_or_else(|| "Output file grew beyond the transfer limit".to_string())?;
        self.unchanged(&path, &before, scope).await?;
        if bytes.len() as u64 != size {
            return Err("Output file transfer was truncated".to_string());
        }
        let name = path
            .rsplit(if self.remote {
                '/'
            } else {
                std::path::MAIN_SEPARATOR
            })
            .next()
            .unwrap_or("file")
            .to_string();
        Ok(RemoteWorkspaceFileContent {
            mime_type: detect_remote_mime_type(Path::new(&name)),
            name,
            size,
            bytes,
        })
    }

    pub async fn read_chunk(
        &self,
        offset: u64,
        limit: u64,
    ) -> Result<RemoteWorkspaceFileChunk, String> {
        self.read_chunk_with_revision(offset, limit, None)
            .await
            .map(|(chunk, _)| chunk)
    }

    pub async fn read_chunk_with_scope(
        &self,
        offset: u64,
        limit: u64,
        scope: FileReadScope,
    ) -> Result<RemoteWorkspaceFileChunk, String> {
        self.read_chunk_with_revision_and_scope(offset, limit, None, scope)
            .await
            .map(|(chunk, _)| chunk)
    }

    /// Binds separate chunk requests to one file revision without retaining a
    /// stream or requiring the observer to stay connected between requests.
    pub async fn read_chunk_with_revision(
        &self,
        offset: u64,
        limit: u64,
        expected_revision: Option<&str>,
    ) -> Result<(RemoteWorkspaceFileChunk, String), String> {
        self.read_chunk_with_revision_and_scope(
            offset,
            limit,
            expected_revision,
            FileReadScope::Workspace,
        )
        .await
    }

    async fn read_chunk_with_revision_and_scope(
        &self,
        offset: u64,
        limit: u64,
        expected_revision: Option<&str>,
        scope: FileReadScope,
    ) -> Result<(RemoteWorkspaceFileChunk, String), String> {
        let path = self.checked_path(scope).await?;
        let before = self.metadata_at(&path, scope).await?;
        let total_size = before.size.unwrap();
        let modified = before
            .modified
            .and_then(|time| time.duration_since(std::time::UNIX_EPOCH).ok())
            .ok_or_else(|| "Output file revision is unavailable".to_string());
        // Legacy remote providers may omit mtime. Existing unversioned reads
        // retain their wire contract; versioned clients require it after chunk 0.
        let revision = modified
            .map(|time| format!("{total_size}:{}", time.as_nanos()))
            .unwrap_or_default();
        if expected_revision.is_some_and(|expected| revision.is_empty() || expected != revision) {
            return Err(
                "Output file changed during transfer; retry when generation finishes".to_string(),
            );
        }
        if offset > total_size || limit == 0 {
            return Err("Invalid output file chunk range".to_string());
        }
        let count = limit
            .min(REMOTE_FILE_MAX_CHUNK_BYTES)
            .min(total_size - offset);
        let mut reader = self.fs.open_read(&path).await.map_err(|e| e.to_string())?;
        reader
            .seek(std::io::SeekFrom::Start(offset))
            .await
            .map_err(|e| e.to_string())?;
        let mut bytes = Vec::with_capacity(count as usize);
        reader
            .take(count)
            .read_to_end(&mut bytes)
            .await
            .map_err(|e| e.to_string())?;
        self.unchanged(&path, &before, scope).await?;
        if bytes.len() as u64 != count {
            return Err("Output file chunk was truncated".to_string());
        }
        let name = path
            .rsplit(if self.remote {
                '/'
            } else {
                std::path::MAIN_SEPARATOR
            })
            .next()
            .unwrap_or("file")
            .to_string();
        Ok((
            RemoteWorkspaceFileChunk {
                revision: revision.clone(),
                mime_type: detect_remote_mime_type(Path::new(&name)),
                name,
                bytes,
                offset,
                chunk_size: count,
                total_size,
            },
            revision,
        ))
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use openbitfun_runtime_ports::{WorkspaceDirEntry, WorkspaceReader};
    use std::sync::{
        atomic::{AtomicBool, Ordering},
        Mutex,
    };

    struct RemoteFs {
        bytes: Vec<u8>,
        reads: Mutex<Vec<String>>,
        symlink: bool,
        truncate: bool,
        changed: AtomicBool,
    }
    #[async_trait::async_trait]
    impl WorkspaceFileSystem for RemoteFs {
        async fn open_read(&self, path: &str) -> anyhow::Result<WorkspaceReader> {
            self.reads.lock().unwrap().push(path.into());
            Ok(Box::new(std::io::Cursor::new(if self.truncate {
                vec![1]
            } else {
                self.bytes.clone()
            })))
        }
        async fn metadata(&self, _: &str, _: bool) -> anyhow::Result<Option<WorkspaceMetadata>> {
            Ok(Some(WorkspaceMetadata {
                kind: WorkspacePathKind::File,
                size: Some(if self.changed.load(Ordering::SeqCst) {
                    999
                } else {
                    self.bytes.len() as u64
                }),
                modified: None,
                permissions: None,
            }))
        }
        async fn path_kind_no_follow(
            &self,
            path: &str,
        ) -> anyhow::Result<Option<WorkspacePathKind>> {
            Ok(Some(if self.symlink && path.ends_with("/link") {
                WorkspacePathKind::Symlink
            } else if path.ends_with(".png") {
                WorkspacePathKind::File
            } else {
                WorkspacePathKind::Directory
            }))
        }
        async fn read_file(&self, path: &str) -> anyhow::Result<Vec<u8>> {
            self.reads.lock().unwrap().push(path.into());
            Ok(self.bytes.clone())
        }
        async fn read_file_text(&self, _: &str) -> anyhow::Result<String> {
            anyhow::bail!("unused")
        }
        async fn write_file(&self, _: &str, _: &[u8]) -> anyhow::Result<()> {
            anyhow::bail!("unused")
        }
        async fn exists(&self, _: &str) -> anyhow::Result<bool> {
            anyhow::bail!("unused")
        }
        async fn is_file(&self, _: &str) -> anyhow::Result<bool> {
            anyhow::bail!("unused")
        }
        async fn is_dir(&self, _: &str) -> anyhow::Result<bool> {
            anyhow::bail!("unused")
        }
        async fn read_dir(&self, _: &str) -> anyhow::Result<Vec<WorkspaceDirEntry>> {
            anyhow::bail!("unused")
        }
    }
    fn fixture(
        root: &str,
        path: &str,
        symlink: bool,
        truncate: bool,
    ) -> (SessionFileTarget, Arc<RemoteFs>) {
        let fs = Arc::new(RemoteFs {
            bytes: b"remote-image".to_vec(),
            reads: Mutex::new(vec![]),
            symlink,
            truncate,
            changed: AtomicBool::new(false),
        });
        (
            SessionFileTarget {
                fs: fs.clone(),
                root: root.into(),
                path: path.into(),
                remote: true,
            },
            fs,
        )
    }

    #[tokio::test]
    async fn remote_delivery_uses_provider_bytes_even_when_controller_has_the_same_path() {
        let root = std::env::temp_dir().join(format!("output-projection-{}", uuid::Uuid::new_v4()));
        std::fs::create_dir(&root).unwrap();
        let path = root.join("preview.png");
        std::fs::write(&path, b"private-controller-image").unwrap();
        let (target, fs) = fixture(root.to_str().unwrap(), path.to_str().unwrap(), false, false);
        let file = target.read(100).await.unwrap();
        assert_eq!(file.bytes, b"remote-image");
        assert_eq!(file.name, "preview.png");
        assert_eq!(file.mime_type, "image/png");
        assert_eq!(
            fs.reads.lock().unwrap().as_slice(),
            &[path.to_string_lossy()]
        );
        std::fs::remove_dir_all(root).unwrap();
    }

    #[tokio::test]
    async fn remote_output_checks_scope_symlinks_and_limits_before_transfer() {
        for (path, symlink) in [
            ("/workspace/../secret.png", false),
            ("/workspace-other/secret.png", false),
            ("/workspace/link/preview.png", true),
        ] {
            let (target, fs) = fixture("/workspace", path, symlink, false);
            assert!(target.read(100).await.is_err());
            assert!(fs.reads.lock().unwrap().is_empty());
        }
        let (target, fs) = fixture("/workspace", "/workspace/preview.png", false, false);
        assert!(target.read(2).await.unwrap_err().contains("too large"));
        assert!(fs.reads.lock().unwrap().is_empty());
    }

    #[tokio::test]
    async fn chunk_reads_are_bounded_and_truncation_is_not_success() {
        let (target, _) = fixture("/workspace", "/workspace/preview.png", false, false);
        let chunk = target.read_chunk(7, 100).await.unwrap();
        assert_eq!(chunk.bytes, b"image");
        assert_eq!(chunk.offset, 7);
        assert_eq!(chunk.total_size, 12);
        assert!(target.read_chunk(13, 1).await.is_err());
        assert!(target.read_chunk(0, 0).await.is_err());
        let (truncated, _) = fixture("/workspace", "/workspace/preview.png", false, true);
        assert!(truncated
            .read_chunk(0, 12)
            .await
            .unwrap_err()
            .contains("truncated"));
    }

    #[tokio::test]
    async fn explicit_reads_outside_workspace_keep_the_selected_remote_provider() {
        let local = tempfile::tempdir().unwrap();
        let path = local.path().join("qr.png");
        std::fs::write(&path, b"controller-private").unwrap();
        let (target, fs) = fixture("/workspace", path.to_str().unwrap(), false, false);
        assert!(target.read(100).await.is_err());
        let info = target
            .info_with_scope(FileReadScope::Provider)
            .await
            .unwrap();
        assert_eq!(info.name, "qr.png");
        let file = target
            .read_with_scope(100, FileReadScope::Provider)
            .await
            .unwrap();
        assert_eq!(file.bytes, b"remote-image");
        let chunk = target
            .read_chunk_with_scope(7, 100, FileReadScope::Provider)
            .await
            .unwrap();
        assert_eq!(chunk.bytes, b"image");
        assert!(fs
            .reads
            .lock()
            .unwrap()
            .iter()
            .all(|read| read == path.to_str().unwrap()));
        assert!(target
            .read_with_scope(2, FileReadScope::Provider)
            .await
            .is_err());
        assert!(
            target.read(100).await.is_err(),
            "explicit reads must not widen automatic delivery"
        );
    }

    #[test]
    fn controller_scope_preserves_runtime_uri_confinement() {
        for reference in [
            "/tmp/wxqr/qr.png",
            "computer:///tmp/wxqr/qr.png",
            "../output.png",
        ] {
            assert!(controller_file_read_scope(reference).unwrap() == FileReadScope::Provider);
        }
        for reference in [
            "openbitfun://current-session/artifacts/qr.png",
            "computer://openbitfun%3A%2F%2Fcurrent-session%2Fartifacts%2Fqr.png",
        ] {
            assert!(controller_file_read_scope(reference).unwrap() == FileReadScope::Workspace);
        }
    }

    #[test]
    fn uri_paths_decode_once_and_preserve_runtime_scope() {
        assert_eq!(
            normalize_file_reference("computer://preview%20%E5%9B%BE%2520.png").unwrap(),
            "preview 图%20.png"
        );
        assert_eq!(
            normalize_file_reference("preview 图%20.png").unwrap(),
            "preview 图%20.png"
        );
        assert_eq!(
            normalize_file_reference("file:///C:/output/preview.png").unwrap(),
            "C:/output/preview.png"
        );
        assert_eq!(
            normalize_file_reference("openbitfun://current-session/artifacts/preview.png").unwrap(),
            "openbitfun://current-session/artifacts/preview.png"
        );
    }
}
