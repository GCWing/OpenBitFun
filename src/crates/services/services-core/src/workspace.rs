//! Local workspace runtime services.
//!
//! This module owns local filesystem and shell implementations for the
//! workspace runtime ports. Product crates remain responsible for selecting
//! when these providers are used.

use async_trait::async_trait;
use openbitfun_runtime_ports::{
    WorkspaceCommandOptions, WorkspaceCommandResult, WorkspaceDirEntry, WorkspaceFileSystem,
    WorkspaceMetadata, WorkspacePathKind, WorkspaceReader, WorkspaceServices, WorkspaceShell,
};
use std::path::Path;
use std::sync::Arc;
use std::time::SystemTime;
use tokio::io::AsyncReadExt;

/// Local filesystem implementation of [`WorkspaceFileSystem`].
pub struct LocalWorkspaceFs;

#[async_trait]
impl WorkspaceFileSystem for LocalWorkspaceFs {
    async fn open_write_new(
        &self,
        path: &str,
    ) -> anyhow::Result<openbitfun_runtime_ports::WorkspaceWriter> {
        let file = tokio::fs::OpenOptions::new()
            .write(true)
            .create_new(true)
            .open(path)
            .await?;
        Ok(Box::new(file))
    }
    async fn atomic_replace(&self, from: &str, to: &str) -> anyhow::Result<()> {
        if Path::new(from).parent() != Path::new(to).parent() {
            anyhow::bail!("Atomic replacement requires a same-directory staged file");
        }
        tokio::fs::rename(from, to).await?;
        Ok(())
    }

    async fn open_read(&self, path: &str) -> anyhow::Result<WorkspaceReader> {
        let file = tokio::fs::File::open(path).await?;
        if !file.metadata().await?.is_file() {
            anyhow::bail!("Workspace path is not a regular file: {path}");
        }
        Ok(Box::new(file))
    }

    async fn metadata(
        &self,
        path: &str,
        follow_symlinks: bool,
    ) -> anyhow::Result<Option<WorkspaceMetadata>> {
        let metadata = match if follow_symlinks {
            tokio::fs::metadata(path).await
        } else {
            tokio::fs::symlink_metadata(path).await
        } {
            Ok(metadata) => metadata,
            Err(error) if error.kind() == std::io::ErrorKind::NotFound => return Ok(None),
            Err(error) => return Err(error.into()),
        };
        // Rust classifies name-surrogate reparse tags, including junctions.
        // Other reparse points (for example cloud placeholders) are not links.
        let kind = if metadata.file_type().is_symlink() {
            WorkspacePathKind::Symlink
        } else if metadata.is_dir() {
            WorkspacePathKind::Directory
        } else if metadata.is_file() {
            WorkspacePathKind::File
        } else {
            WorkspacePathKind::Other
        };
        #[cfg(unix)]
        let permissions = {
            use std::os::unix::fs::PermissionsExt;
            Some(metadata.permissions().mode())
        };
        #[cfg(not(unix))]
        let permissions = None;
        Ok(Some(WorkspaceMetadata {
            kind,
            size: Some(metadata.len()),
            modified: metadata.modified().ok(),
            permissions,
        }))
    }

    async fn read_file(&self, path: &str) -> anyhow::Result<Vec<u8>> {
        Ok(tokio::fs::read(path).await?)
    }

    async fn read_file_bounded(
        &self,
        path: &str,
        max_bytes: usize,
    ) -> anyhow::Result<Option<Vec<u8>>> {
        let metadata = tokio::fs::metadata(path).await?;
        if metadata.len() > max_bytes as u64 {
            return Ok(None);
        }
        let mut bytes = Vec::with_capacity(metadata.len() as usize);
        tokio::fs::File::open(path)
            .await?
            .take(max_bytes.saturating_add(1) as u64)
            .read_to_end(&mut bytes)
            .await?;
        Ok((bytes.len() <= max_bytes).then_some(bytes))
    }

    async fn read_file_text(&self, path: &str) -> anyhow::Result<String> {
        Ok(tokio::fs::read_to_string(path).await?)
    }

    async fn read_file_text_bounded(
        &self,
        path: &str,
        max_bytes: usize,
    ) -> anyhow::Result<Option<String>> {
        self.read_file_bounded(path, max_bytes)
            .await?
            .map(String::from_utf8)
            .transpose()
            .map_err(Into::into)
    }

    async fn write_file(&self, path: &str, contents: &[u8]) -> anyhow::Result<()> {
        if let Some(parent) = Path::new(path).parent() {
            tokio::fs::create_dir_all(parent).await?;
        }
        Ok(tokio::fs::write(path, contents).await?)
    }

    async fn exists(&self, path: &str) -> anyhow::Result<bool> {
        Ok(tokio::fs::try_exists(path).await?)
    }

    async fn is_file(&self, path: &str) -> anyhow::Result<bool> {
        Ok(self
            .metadata(path, true)
            .await?
            .is_some_and(|metadata| metadata.kind == WorkspacePathKind::File))
    }

    async fn is_dir(&self, path: &str) -> anyhow::Result<bool> {
        Ok(self
            .metadata(path, true)
            .await?
            .is_some_and(|metadata| metadata.kind == WorkspacePathKind::Directory))
    }

    async fn remove_file(&self, path: &str) -> anyhow::Result<()> {
        #[cfg(windows)]
        {
            use std::os::windows::fs::FileTypeExt;
            let file_type = tokio::fs::symlink_metadata(path).await?.file_type();
            // Directory symlinks and junctions need RemoveDirectory on Windows.
            // Inspect the link object, including dangling links; never recurse.
            if file_type.is_symlink_dir() {
                return Ok(tokio::fs::remove_dir(path).await?);
            }
        }
        Ok(tokio::fs::remove_file(path).await?)
    }

    async fn remove_dir(&self, path: &str, recursive: bool) -> anyhow::Result<()> {
        if recursive {
            tokio::fs::remove_dir_all(path).await?;
        } else {
            tokio::fs::remove_dir(path).await?;
        }
        Ok(())
    }

    async fn create_dir_all(&self, path: &str) -> anyhow::Result<()> {
        Ok(tokio::fs::create_dir_all(path).await?)
    }

    async fn create_dir_new(&self, path: &str) -> anyhow::Result<()> {
        Ok(tokio::fs::create_dir(path).await?)
    }

    async fn set_permissions(&self, path: &str, permissions: u32) -> anyhow::Result<()> {
        #[cfg(unix)]
        {
            use std::os::unix::fs::PermissionsExt;
            tokio::fs::set_permissions(path, std::fs::Permissions::from_mode(permissions)).await?;
            Ok(())
        }
        #[cfg(not(unix))]
        {
            let _ = (path, permissions);
            anyhow::bail!("POSIX permissions are not supported by the local filesystem")
        }
    }

    async fn set_modified(&self, path: &str, modified: SystemTime) -> anyhow::Result<()> {
        let path = path.to_string();
        tokio::task::spawn_blocking(move || {
            filetime::set_file_mtime(path, filetime::FileTime::from_system_time(modified))
        })
        .await??;
        Ok(())
    }

    async fn rename(&self, from: &str, to: &str) -> anyhow::Result<()> {
        Ok(tokio::fs::rename(from, to).await?)
    }

    async fn path_kind_no_follow(&self, path: &str) -> anyhow::Result<Option<WorkspacePathKind>> {
        Ok(self
            .metadata(path, false)
            .await?
            .map(|metadata| metadata.kind))
    }

    async fn read_dir(&self, path: &str) -> anyhow::Result<Vec<WorkspaceDirEntry>> {
        self.read_dir_bounded(path, usize::MAX).await
    }

    async fn read_dir_bounded(
        &self,
        path: &str,
        max_entries: usize,
    ) -> anyhow::Result<Vec<WorkspaceDirEntry>> {
        let mut entries = Vec::new();
        let mut scanned_entries = 0usize;
        let mut read_dir = tokio::fs::read_dir(path).await?;
        while scanned_entries < max_entries {
            let Some(entry) = read_dir.next_entry().await? else {
                break;
            };
            scanned_entries += 1;
            let path = entry.path();
            let metadata = tokio::fs::symlink_metadata(&path).await?;
            entries.push(WorkspaceDirEntry {
                name: entry.file_name().to_string_lossy().to_string(),
                path: path.to_string_lossy().to_string(),
                is_dir: metadata.is_dir(),
                is_symlink: metadata.file_type().is_symlink(),
                modified: metadata.modified().ok(),
            });
        }
        Ok(entries)
    }
}

/// Local shell implementation of [`WorkspaceShell`].
pub struct LocalWorkspaceShell {
    workspace_root: String,
}

impl LocalWorkspaceShell {
    pub fn new(workspace_root: String) -> Self {
        Self { workspace_root }
    }
}

#[async_trait]
impl WorkspaceShell for LocalWorkspaceShell {
    async fn exec_with_options(
        &self,
        command: &str,
        options: WorkspaceCommandOptions,
    ) -> anyhow::Result<WorkspaceCommandResult> {
        use std::process::Stdio;
        use tokio::io::AsyncReadExt;

        let mut cmd = crate::process_manager::create_tokio_command("sh");
        cmd.arg("-c").arg(command);
        cmd.current_dir(&self.workspace_root);
        cmd.stdout(Stdio::piped());
        cmd.stderr(Stdio::piped());

        let mut child = cmd.spawn()?;
        let stdout = child
            .stdout
            .take()
            .ok_or_else(|| anyhow::anyhow!("Failed to capture command stdout"))?;
        let stderr = child
            .stderr
            .take()
            .ok_or_else(|| anyhow::anyhow!("Failed to capture command stderr"))?;

        let stdout_task = tokio::spawn(async move {
            let mut reader = tokio::io::BufReader::new(stdout);
            let mut buffer = Vec::new();
            reader.read_to_end(&mut buffer).await?;
            Ok::<Vec<u8>, std::io::Error>(buffer)
        });
        let stderr_task = tokio::spawn(async move {
            let mut reader = tokio::io::BufReader::new(stderr);
            let mut buffer = Vec::new();
            reader.read_to_end(&mut buffer).await?;
            Ok::<Vec<u8>, std::io::Error>(buffer)
        });

        let mut interrupted = false;
        let mut timed_out = false;
        let mut exit_code = -1;
        let deadline = options
            .timeout_ms
            .map(|ms| tokio::time::Instant::now() + std::time::Duration::from_millis(ms));

        loop {
            if let Some(token) = options.cancellation_token.as_ref() {
                if token.is_cancelled() {
                    interrupted = true;
                    let _ = child.start_kill();
                    break;
                }
            }

            if let Some(deadline) = deadline {
                if tokio::time::Instant::now() >= deadline {
                    timed_out = true;
                    let _ = child.start_kill();
                    break;
                }
            }

            if let Some(status) = child.try_wait()? {
                exit_code = status.code().unwrap_or(-1);
                break;
            }

            tokio::time::sleep(std::time::Duration::from_millis(25)).await;
        }

        if interrupted || timed_out {
            let _ = child.wait().await;
            if interrupted {
                #[cfg(windows)]
                {
                    exit_code = -1073741510;
                }
                #[cfg(not(windows))]
                {
                    exit_code = 130;
                }
            } else if timed_out {
                exit_code = 124;
            }
        }

        let stdout = String::from_utf8_lossy(
            &stdout_task
                .await
                .map_err(|error| anyhow::anyhow!("Failed to join stdout task: {}", error))??,
        )
        .to_string();
        let stderr = String::from_utf8_lossy(
            &stderr_task
                .await
                .map_err(|error| anyhow::anyhow!("Failed to join stderr task: {}", error))??,
        )
        .to_string();

        Ok(WorkspaceCommandResult {
            stdout,
            stderr,
            exit_code,
            interrupted,
            timed_out,
        })
    }
}

/// Build [`WorkspaceServices`] backed by the local filesystem and shell.
pub fn local_workspace_services(workspace_root: String) -> WorkspaceServices {
    WorkspaceServices {
        fs: Arc::new(LocalWorkspaceFs),
        shell: Arc::new(LocalWorkspaceShell::new(workspace_root)),
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use openbitfun_runtime_ports::WorkspaceFileSystem;

    #[tokio::test]
    async fn local_workspace_exclusive_directory_creation_preserves_existing_paths() {
        let temp = tempfile::tempdir().unwrap();
        let directory = temp.path().join("new directory");
        let fs = LocalWorkspaceFs;
        fs.create_dir_new(directory.to_str().unwrap())
            .await
            .unwrap();
        std::fs::write(directory.join("keep.txt"), b"keep").unwrap();
        assert!(fs
            .create_dir_new(directory.to_str().unwrap())
            .await
            .is_err());
        assert_eq!(std::fs::read(directory.join("keep.txt")).unwrap(), b"keep");
        let existing_file = temp.path().join("file");
        std::fs::write(&existing_file, b"file").unwrap();
        assert!(fs
            .create_dir_new(existing_file.to_str().unwrap())
            .await
            .is_err());
        assert!(fs
            .create_dir_new(temp.path().join("missing/child").to_str().unwrap())
            .await
            .is_err());
        #[cfg(unix)]
        {
            let link = temp.path().join("directory-link");
            std::os::unix::fs::symlink(&directory, &link).unwrap();
            assert!(fs.create_dir_new(link.to_str().unwrap()).await.is_err());
        }
    }

    #[cfg(windows)]
    #[tokio::test]
    async fn local_workspace_unlinks_directory_junction_without_removing_target() {
        let temp = tempfile::tempdir().unwrap();
        let target = temp.path().join("target");
        let link = temp.path().join("junction");
        std::fs::create_dir(&target).unwrap();
        std::fs::write(target.join("keep.txt"), b"keep").unwrap();
        // Junction creation does not require the symlink privilege or Developer Mode.
        let create_link = || {
            let output = crate::process_manager::create_command("cmd.exe")
                .args(["/C", "mklink", "/J"])
                .arg(&link)
                .arg(&target)
                .output()
                .unwrap();
            assert!(
                output.status.success(),
                "junction creation failed: {}",
                String::from_utf8_lossy(&output.stderr)
            );
        };
        create_link();
        let fs = LocalWorkspaceFs;
        let link_path = link.to_str().unwrap();
        assert_eq!(
            fs.path_kind_no_follow(link_path).await.unwrap(),
            Some(WorkspacePathKind::Symlink)
        );
        fs.remove_file(link_path).await.unwrap();
        assert!(std::fs::symlink_metadata(&link).is_err());
        assert_eq!(std::fs::read(target.join("keep.txt")).unwrap(), b"keep");
        assert!(fs.remove_file(target.to_str().unwrap()).await.is_err());
        create_link();
        std::fs::remove_dir_all(&target).unwrap();
        fs.remove_file(link_path).await.unwrap();
        assert!(std::fs::symlink_metadata(&link).is_err());
    }

    #[tokio::test]
    async fn local_workspace_file_handle_and_mutation_contract() {
        use tokio::io::{AsyncReadExt, AsyncSeekExt};
        let temp = tempfile::tempdir().unwrap();
        let directory = temp.path().join("nested").to_string_lossy().into_owned();
        let path = temp
            .path()
            .join("nested/file.bin")
            .to_string_lossy()
            .into_owned();
        let renamed = temp
            .path()
            .join("nested/renamed.bin")
            .to_string_lossy()
            .into_owned();
        let fs = LocalWorkspaceFs;
        fs.create_dir_all(&directory).await.unwrap();
        assert!(fs.metadata(&path, true).await.unwrap().is_none());
        fs.write_file(&path, b"abc\0def").await.unwrap();
        let mut reader = fs.open_read(&path).await.unwrap();
        reader.seek(std::io::SeekFrom::Start(3)).await.unwrap();
        let mut content = Vec::new();
        reader.read_to_end(&mut content).await.unwrap();
        assert_eq!(content, b"\0def");
        drop(reader);
        let modified = std::time::UNIX_EPOCH + std::time::Duration::from_secs(1_700_000_000);
        fs.set_modified(&path, modified).await.unwrap();
        let metadata = fs.metadata(&path, true).await.unwrap().unwrap();
        assert_eq!(metadata.kind, WorkspacePathKind::File);
        assert_eq!(metadata.size, Some(7));
        assert_eq!(metadata.modified, Some(modified));
        assert!(fs.remove_dir(&directory, false).await.is_err());
        fs.rename(&path, &renamed).await.unwrap();
        assert!(fs.metadata(&path, false).await.unwrap().is_none());
        fs.remove_file(&renamed).await.unwrap();
        fs.remove_dir(&directory, false).await.unwrap();
        fs.write_file(&path, b"nested again").await.unwrap();
        fs.remove_dir(&directory, true).await.unwrap();
        assert!(!fs.exists(&directory).await.unwrap());
    }

    #[tokio::test]
    async fn local_workspace_metadata_preserves_native_path_error_semantics() {
        use std::io::ErrorKind;

        let temp = tempfile::tempdir().unwrap();
        let file = temp.path().join("file.bin");
        std::fs::write(&file, b"file").unwrap();
        let below_file = file.join("child");
        let missing_leaf = temp.path().join("missing.bin");
        let missing_parent = temp.path().join("missing/child");
        let invalid_path = format!("{}\0child", file.to_str().unwrap());
        let fs = LocalWorkspaceFs;

        for follow in [false, true] {
            for missing in [&missing_leaf, &missing_parent] {
                assert!(fs
                    .metadata(missing.to_str().unwrap(), follow)
                    .await
                    .unwrap()
                    .is_none());
            }

            let native_error = if follow {
                std::fs::metadata(&below_file)
            } else {
                std::fs::symlink_metadata(&below_file)
            }
            .unwrap_err();
            let result = fs.metadata(below_file.to_str().unwrap(), follow).await;
            // Windows reports a nonexistent pathname below a file; Unix
            // reports ENOTDIR. The port maps native NotFound to None without
            // inventing an errno through separate, racy ancestor probes.
            #[cfg(windows)]
            {
                assert_eq!(native_error.kind(), ErrorKind::NotFound);
                assert!(result.unwrap().is_none());
            }
            #[cfg(unix)]
            {
                assert_eq!(native_error.kind(), ErrorKind::NotADirectory);
                let error = result.unwrap_err();
                let error = error.downcast_ref::<std::io::Error>().unwrap();
                assert_eq!(error.kind(), ErrorKind::NotADirectory);
                assert_eq!(error.raw_os_error(), native_error.raw_os_error());
            }

            // A malformed pathname is reliably an error on every supported
            // platform and must never be misreported as a missing file.
            let error = fs.metadata(&invalid_path, follow).await.unwrap_err();
            assert_eq!(
                error.downcast_ref::<std::io::Error>().unwrap().kind(),
                ErrorKind::InvalidInput
            );
        }
    }

    #[cfg(unix)]
    #[tokio::test]
    async fn local_workspace_preserves_links_and_modes_and_lists_link_metadata() {
        let temp = tempfile::tempdir().unwrap();
        let target = temp.path().join("target");
        let link = temp.path().join("link");
        let fs = LocalWorkspaceFs;
        fs.write_file(target.to_str().unwrap(), b"before")
            .await
            .unwrap();
        fs.set_permissions(target.to_str().unwrap(), 0o640)
            .await
            .unwrap();
        std::os::unix::fs::symlink(&target, &link).unwrap();
        fs.write_file(link.to_str().unwrap(), b"after")
            .await
            .unwrap();
        assert_eq!(
            fs.metadata(link.to_str().unwrap(), false)
                .await
                .unwrap()
                .unwrap()
                .kind,
            WorkspacePathKind::Symlink
        );
        let followed = fs
            .metadata(link.to_str().unwrap(), true)
            .await
            .unwrap()
            .unwrap();
        assert_eq!(followed.kind, WorkspacePathKind::File);
        assert_eq!(followed.permissions.unwrap() & 0o777, 0o640);
        assert_eq!(std::fs::read(&target).unwrap(), b"after");
        let entries = fs.read_dir(temp.path().to_str().unwrap()).await.unwrap();
        let listed_link = entries.iter().find(|entry| entry.name == "link").unwrap();
        assert!(listed_link.is_symlink);
        assert!(listed_link.modified.is_some());
        fs.remove_file(link.to_str().unwrap()).await.unwrap();
        assert!(target.exists());
    }

    #[tokio::test]
    async fn local_workspace_fs_writes_parent_dirs_and_reads_text() {
        let temp = tempfile::tempdir().expect("temp dir");
        let file = temp.path().join("nested").join("file.txt");
        let path = file.to_string_lossy().to_string();
        let fs = LocalWorkspaceFs;

        fs.write_file(&path, b"hello").await.unwrap();

        assert!(fs.exists(&path).await.unwrap());
        assert!(fs.is_file(&path).await.unwrap());
        assert_eq!(fs.read_file_text(&path).await.unwrap(), "hello");
        assert!(fs.read_file_bounded(&path, 4).await.unwrap().is_none());
        assert_eq!(
            fs.read_file_bounded(&path, 5).await.unwrap(),
            Some(b"hello".to_vec())
        );
    }

    #[tokio::test]
    async fn local_workspace_shell_timeout_preserves_legacy_result_shape() {
        if which::which("sh").is_err() {
            return;
        }

        let temp = tempfile::tempdir().expect("temp dir");
        let shell = LocalWorkspaceShell::new(temp.path().to_string_lossy().to_string());

        let result = shell
            .exec_with_options(
                "sleep 2",
                WorkspaceCommandOptions {
                    timeout_ms: Some(50),
                    cancellation_token: None,
                },
            )
            .await
            .unwrap();

        assert!(result.timed_out);
        assert!(!result.interrupted);
        assert_eq!(result.exit_code, 124);
    }
}
