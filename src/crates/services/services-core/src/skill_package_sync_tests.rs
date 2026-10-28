use super::*;

#[test]
fn remote_cache_paths_use_posix_syntax_and_stay_inside_selected_workspace() {
    assert!(
        validate_remote_cache_location("/home/user/project/cache", "/home/user/project").is_ok()
    );
    assert!(validate_remote_cache_location("/home/user/a\\b/cache", "/home/user/a\\b").is_ok());
    for path in [
        "C:\\Users\\me\\cache",
        "relative/cache",
        "/tmp/../escape",
        "/tmp/./cache",
    ] {
        assert!(validate_remote_root(path).is_err(), "{path}");
    }
    assert!(validate_remote_cache_location("/workspace-other/cache", "/workspace").is_err());
    assert!(validate_remote_cache_location("/workspace", "/workspace").is_err());
}

#[cfg(all(unix, feature = "workspace-runtime"))]
mod posix {
    use super::*;
    use crate::workspace::{LocalWorkspaceFs, LocalWorkspaceShell};
    use openbitfun_runtime_ports::{
        WorkspaceDirEntry, WorkspaceReader, WorkspaceShell, WorkspaceWriter,
    };
    use std::{
        os::unix::fs::{symlink, PermissionsExt},
        pin::Pin,
        sync::atomic::AtomicUsize,
        task::{Context as TaskContext, Poll},
    };
    use tokio::io::AsyncWrite;

    fn write(root: &Path, name: &str, bytes: &[u8]) {
        let path = root.join(name);
        fs::create_dir_all(path.parent().unwrap()).unwrap();
        fs::write(path, bytes).unwrap();
    }

    fn mode(path: &Path, value: u32) {
        fs::set_permissions(path, fs::Permissions::from_mode(value)).unwrap();
    }

    #[derive(Default)]
    struct TransferCounts {
        active: AtomicUsize,
        peak: AtomicUsize,
        writes: AtomicUsize,
    }

    #[derive(Default)]
    struct PublicationGate {
        pause: AtomicBool,
        started: tokio::sync::Notify,
        release: tokio::sync::Notify,
    }

    #[derive(Default)]
    struct UploadBlock {
        blocked: AtomicBool,
        started: tokio::sync::Notify,
    }

    struct CountedWriter {
        inner: WorkspaceWriter,
        counts: Arc<TransferCounts>,
        upload_block: Option<Arc<UploadBlock>>,
    }
    impl Drop for CountedWriter {
        fn drop(&mut self) {
            self.counts.active.fetch_sub(1, Ordering::SeqCst);
        }
    }
    impl AsyncWrite for CountedWriter {
        fn poll_write(
            mut self: Pin<&mut Self>,
            cx: &mut TaskContext<'_>,
            data: &[u8],
        ) -> Poll<std::io::Result<usize>> {
            if let Some(block) = &self.upload_block {
                if block.blocked.load(Ordering::SeqCst) {
                    block.started.notify_one();
                    return Poll::Pending;
                }
            }
            Pin::new(&mut self.inner).poll_write(cx, data)
        }
        fn poll_flush(
            mut self: Pin<&mut Self>,
            cx: &mut TaskContext<'_>,
        ) -> Poll<std::io::Result<()>> {
            Pin::new(&mut self.inner).poll_flush(cx)
        }
        fn poll_shutdown(
            mut self: Pin<&mut Self>,
            cx: &mut TaskContext<'_>,
        ) -> Poll<std::io::Result<()>> {
            Pin::new(&mut self.inner).poll_shutdown(cx)
        }
    }

    #[derive(Default)]
    struct InstrumentedFs {
        counts: Arc<TransferCounts>,
        fail_upload: AtomicBool,
        fail_publish: AtomicBool,
        mutate_source: Mutex<Option<PathBuf>>,
        publication_gate: Mutex<Option<Arc<PublicationGate>>>,
        upload_block: Mutex<Option<Arc<UploadBlock>>>,
        fail_metadata: AtomicBool,
        bogus_listing_paths: AtomicBool,
    }
    #[async_trait::async_trait]
    impl WorkspaceFileSystem for InstrumentedFs {
        async fn open_read(&self, path: &str) -> Result<WorkspaceReader> {
            LocalWorkspaceFs.open_read(path).await
        }
        async fn open_write_new(&self, path: &str) -> Result<WorkspaceWriter> {
            if self.fail_upload.load(Ordering::SeqCst) {
                bail!("fixture rejects streamed upload");
            }
            if let Some(source) = self.mutate_source.lock().unwrap().take() {
                fs::write(source, b"after!")?;
            }
            let inner = LocalWorkspaceFs.open_write_new(path).await?;
            self.counts.writes.fetch_add(1, Ordering::SeqCst);
            let active = self.counts.active.fetch_add(1, Ordering::SeqCst) + 1;
            self.counts.peak.fetch_max(active, Ordering::SeqCst);
            Ok(Box::new(CountedWriter {
                inner,
                counts: self.counts.clone(),
                upload_block: self.upload_block.lock().unwrap().clone(),
            }))
        }
        async fn metadata(&self, path: &str, follow: bool) -> Result<Option<WorkspaceMetadata>> {
            if self.fail_metadata.load(Ordering::SeqCst) {
                bail!("fixture transport unavailable");
            }
            LocalWorkspaceFs.metadata(path, follow).await
        }
        async fn create_dir_new(&self, path: &str) -> Result<()> {
            LocalWorkspaceFs.create_dir_new(path).await
        }
        async fn set_permissions(&self, path: &str, permissions: u32) -> Result<()> {
            LocalWorkspaceFs.set_permissions(path, permissions).await
        }
        async fn rename(&self, from: &str, to: &str) -> Result<()> {
            if self.fail_publish.load(Ordering::SeqCst)
                && from.rsplit('/').next().unwrap().starts_with(".staging-")
            {
                bail!("fixture rejects publication");
            }
            let gate = self.publication_gate.lock().unwrap().clone();
            if let Some(gate) = gate {
                if gate.pause.swap(false, Ordering::SeqCst) {
                    gate.started.notify_one();
                    gate.release.notified().await;
                }
            }
            LocalWorkspaceFs.rename(from, to).await
        }
        async fn remove_dir(&self, path: &str, recursive: bool) -> Result<()> {
            LocalWorkspaceFs.remove_dir(path, recursive).await
        }
        async fn read_file(&self, path: &str) -> Result<Vec<u8>> {
            LocalWorkspaceFs.read_file(path).await
        }
        async fn read_file_text(&self, path: &str) -> Result<String> {
            LocalWorkspaceFs.read_file_text(path).await
        }
        async fn write_file(&self, path: &str, content: &[u8]) -> Result<()> {
            LocalWorkspaceFs.write_file(path, content).await
        }
        async fn exists(&self, path: &str) -> Result<bool> {
            LocalWorkspaceFs.exists(path).await
        }
        async fn is_file(&self, path: &str) -> Result<bool> {
            LocalWorkspaceFs.is_file(path).await
        }
        async fn is_dir(&self, path: &str) -> Result<bool> {
            LocalWorkspaceFs.is_dir(path).await
        }
        async fn read_dir(&self, path: &str) -> Result<Vec<WorkspaceDirEntry>> {
            LocalWorkspaceFs.read_dir(path).await
        }
    }

    #[tokio::test]
    async fn streams_complete_package_with_bounded_parallelism_and_preserves_executables() {
        let temp = tempfile::tempdir().unwrap();
        let local = temp.path().join("local user's skill");
        let remote = temp.path().join("remote workspace");
        fs::create_dir(&remote).unwrap();
        write(
            &local,
            "SKILL.md",
            b"Run scripts/hello.sh and read references/guide.md",
        );
        write(
            &local,
            "references/guide 'one' \u{4e2d}.md",
            b"full reference\n",
        );
        write(&local, "templates/example.bin", &[0, 255, 1, 2]);
        write(
            &local,
            "scripts/hello.sh",
            b"#!/bin/sh\nprintf remote-script-ok",
        );
        mode(&local.join("scripts/hello.sh"), 0o751);
        fs::create_dir(local.join("empty-directory")).unwrap();
        for index in 0..200 {
            write(&local, &format!("tiny/{index}.txt"), b"small");
        }
        let target_fs = InstrumentedFs::default();
        target_fs.bogus_listing_paths.store(true, Ordering::SeqCst);
        let phases = Arc::new(Mutex::new(Vec::new()));
        let observed = phases.clone();
        let cache = remote.join("cache");
        let result = sync_local_skill_package(
            &local,
            cache.to_str().unwrap(),
            remote.to_str().unwrap(),
            "user::fixture",
            &target_fs,
            Some(Arc::new(move |event| {
                observed.lock().unwrap().push(event.phase);
            })),
        )
        .await
        .unwrap();
        assert!(!result.reused);
        assert_eq!(result.file_count, 204);
        assert!(
            target_fs.counts.peak.load(Ordering::SeqCst) > 1,
            "small files should overlap transfers"
        );
        assert!(target_fs.counts.peak.load(Ordering::SeqCst) <= MAX_FILE_TRANSFERS);
        assert_eq!(target_fs.counts.active.load(Ordering::SeqCst), 0);
        assert_eq!(
            fs::read(Path::new(&result.path).join("references/guide 'one' \u{4e2d}.md")).unwrap(),
            b"full reference\n"
        );
        assert_eq!(
            fs::read(Path::new(&result.path).join("templates/example.bin")).unwrap(),
            [0, 255, 1, 2]
        );
        assert!(Path::new(&result.path).join("empty-directory").is_dir());
        let shell = LocalWorkspaceShell::new(remote.to_string_lossy().into_owned());
        let (stdout, stderr, exit) = shell
            .exec(&format!("'{}/scripts/hello.sh'", result.path), None)
            .await
            .unwrap();
        assert_eq!(exit, 0, "{stderr}");
        assert_eq!(stdout, "remote-script-ok");
        assert_eq!(
            fs::metadata(Path::new(&result.path).join("scripts/hello.sh"))
                .unwrap()
                .permissions()
                .mode()
                & 0o777,
            0o751
        );
        for phase in [
            SkillPackageSyncPhase::Scanning,
            SkillPackageSyncPhase::Checking,
            SkillPackageSyncPhase::Uploading,
            SkillPackageSyncPhase::Verifying,
            SkillPackageSyncPhase::Complete,
        ] {
            assert!(phases.lock().unwrap().contains(&phase));
        }
        let before = target_fs.counts.writes.load(Ordering::SeqCst);
        let reused = sync_local_skill_package(
            &local,
            cache.to_str().unwrap(),
            remote.to_str().unwrap(),
            "user::fixture",
            &target_fs,
            None,
        )
        .await
        .unwrap();
        assert!(reused.reused);
        assert_eq!(
            target_fs.counts.writes.load(Ordering::SeqCst),
            before,
            "verified cache reuse does not upload files"
        );
    }

    #[tokio::test]
    async fn cache_integrity_detects_bytes_modes_missing_extra_files_and_source_changes() {
        let temp = tempfile::tempdir().unwrap();
        let local = temp.path().join("local");
        write(&local, "SKILL.md", b"skill body");
        write(&local, "references/guide.md", b"original");
        write(&local, "templates/deleted.txt", b"delete locally later");
        let cache = temp.path().join("cache");
        let deploy = || {
            sync_local_skill_package(
                &local,
                cache.to_str().unwrap(),
                temp.path().to_str().unwrap(),
                "user::fixture",
                &LocalWorkspaceFs,
                None,
            )
        };
        let first = deploy().await.unwrap();
        assert!(!first.reused);
        assert!(deploy().await.unwrap().reused);
        let mut current = first.clone();
        for mutation in 0..4 {
            let guide = Path::new(&current.path).join("references/guide.md");
            match mutation {
                0 => fs::write(&guide, b"tampered").unwrap(),
                1 => fs::remove_file(&guide).unwrap(),
                2 => fs::write(Path::new(&current.path).join("extra.txt"), b"extra").unwrap(),
                _ => mode(&guide, 0o700),
            }
            let corrupted_path = current.path.clone();
            current = deploy().await.unwrap();
            assert!(!current.reused);
            assert_ne!(
                current.path, corrupted_path,
                "repair publishes a new immutable generation"
            );
            assert!(
                Path::new(&corrupted_path).is_dir(),
                "target-side data is preserved"
            );
            assert_eq!(
                fs::read(Path::new(&current.path).join("references/guide.md")).unwrap(),
                b"original"
            );
            assert!(!Path::new(&current.path).join("extra.txt").exists());
            let again = deploy().await.unwrap();
            assert!(again.reused);
            assert_eq!(again.path, current.path);
        }
        write(&local, "references/guide.md", b"updated locally");
        fs::remove_file(local.join("templates/deleted.txt")).unwrap();
        let updated = deploy().await.unwrap();
        assert_ne!(updated.content_hash, first.content_hash);
        assert_eq!(
            fs::read(Path::new(&updated.path).join("references/guide.md")).unwrap(),
            b"updated locally"
        );
        assert!(!Path::new(&updated.path)
            .join("templates/deleted.txt")
            .exists());
        assert!(
            Path::new(&current.path)
                .join("templates/deleted.txt")
                .is_file(),
            "old source versions remain available"
        );
    }

    #[tokio::test]
    async fn reuses_legacy_version_one_manifest_and_fixed_digest_directory() {
        let temp = tempfile::tempdir().unwrap();
        let local = temp.path().join("local");
        write(&local, "SKILL.md", b"legacy body");
        mode(&local.join("SKILL.md"), 0o640);
        let package = scan_package(
            &local,
            "user::fixture",
            &None,
            Arc::new(AtomicBool::new(false)),
        )
        .unwrap();
        let legacy = format!("{{\"version\":1,\"entries\":[{{\"path\":\"SKILL.md\",\"kind\":\"file\",\"mode\":416,\"size\":11,\"sha256\":\"{:x}\"}}]}}", Sha256::digest(b"legacy body"));
        assert_eq!(package.manifest_bytes, legacy.as_bytes());
        let cache = temp.path().join("cache");
        let target = cache.join(&package.package_id).join(&package.content_hash);
        fs::create_dir_all(&target).unwrap();
        mode(&target, 0o700);
        write(&target, "SKILL.md", b"legacy body");
        mode(&target.join("SKILL.md"), 0o640);
        write(&target, MANIFEST_NAME, legacy.as_bytes());
        mode(&target.join(MANIFEST_NAME), 0o644);
        let fs = InstrumentedFs::default();
        let loaded = sync_local_skill_package(
            &local,
            cache.to_str().unwrap(),
            temp.path().to_str().unwrap(),
            "user::fixture",
            &fs,
            None,
        )
        .await
        .unwrap();
        assert!(loaded.reused);
        assert_eq!(loaded.path, target.to_str().unwrap());
        assert_eq!(fs.counts.writes.load(Ordering::SeqCst), 0);
    }

    #[tokio::test]
    async fn supports_trusted_symlink_roots_and_rejects_managed_cache_escape() {
        let temp = tempfile::tempdir().unwrap();
        let local = temp.path().join("local");
        write(&local, "SKILL.md", b"skill body");
        let source_link = temp.path().join("source-link");
        symlink(&local, &source_link).unwrap();
        let real = temp.path().join("real");
        fs::create_dir_all(real.join("workspace")).unwrap();
        let alias = temp.path().join("alias");
        symlink(&real, &alias).unwrap();
        let workspace = alias.join("workspace");
        let cache = workspace.join(".openbitfun/cache/user-skills");
        let first = sync_local_skill_package(
            &source_link,
            cache.to_str().unwrap(),
            workspace.to_str().unwrap(),
            "user::fixture",
            &LocalWorkspaceFs,
            None,
        )
        .await
        .unwrap();
        assert!(first.path.starts_with(cache.to_str().unwrap()));
        assert!(
            sync_local_skill_package(
                &local,
                cache.to_str().unwrap(),
                workspace.to_str().unwrap(),
                "user::fixture",
                &LocalWorkspaceFs,
                None
            )
            .await
            .unwrap()
            .reused
        );
        symlink(temp.path(), local.join("escaping-link")).unwrap();
        let error = sync_local_skill_package(
            &local,
            cache.to_str().unwrap(),
            workspace.to_str().unwrap(),
            "user::fixture",
            &LocalWorkspaceFs,
            None,
        )
        .await
        .unwrap_err();
        assert!(error.to_string().contains("nested symbolic links"));
        fs::remove_file(local.join("escaping-link")).unwrap();
        fs::remove_dir_all(workspace.join(".openbitfun")).unwrap();
        fs::create_dir(workspace.join(".openbitfun")).unwrap();
        let outside = temp.path().join("outside");
        fs::create_dir(&outside).unwrap();
        write(&outside, "sentinel", b"untouched");
        symlink(&outside, workspace.join(".openbitfun/cache")).unwrap();
        let error = sync_local_skill_package(
            &local,
            cache.to_str().unwrap(),
            workspace.to_str().unwrap(),
            "user::fixture",
            &LocalWorkspaceFs,
            None,
        )
        .await
        .unwrap_err();
        assert!(error.to_string().contains("without symbolic links"));
        assert_eq!(fs::read(outside.join("sentinel")).unwrap(), b"untouched");
        assert!(!outside.join("user-skills").exists());
    }

    #[tokio::test]
    async fn source_mutation_upload_failure_and_publication_failure_never_report_success() {
        let temp = tempfile::tempdir().unwrap();
        let local = temp.path().join("local");
        write(&local, "SKILL.md", b"before");
        let cache = temp.path().join("cache");
        let fault = InstrumentedFs::default();
        fault
            .mutate_source
            .lock()
            .unwrap()
            .replace(local.join("SKILL.md"));
        let error = sync_local_skill_package(
            &local,
            cache.to_str().unwrap(),
            temp.path().to_str().unwrap(),
            "user::fixture",
            &fault,
            None,
        )
        .await
        .unwrap_err();
        assert!(
            error.to_string().contains("changed while preparing"),
            "{error:#}"
        );
        write(&local, "SKILL.md", b"before");
        fault.fail_upload.store(true, Ordering::SeqCst);
        let error = sync_local_skill_package(
            &local,
            cache.to_str().unwrap(),
            temp.path().to_str().unwrap(),
            "user::fixture",
            &fault,
            None,
        )
        .await
        .unwrap_err();
        assert!(error
            .to_string()
            .contains("streaming Skill package uploads"));
        fault.fail_upload.store(false, Ordering::SeqCst);
        let first = sync_local_skill_package(
            &local,
            cache.to_str().unwrap(),
            temp.path().to_str().unwrap(),
            "user::fixture",
            &fault,
            None,
        )
        .await
        .unwrap();
        fs::write(Path::new(&first.path).join("SKILL.md"), b"target change").unwrap();
        fault.fail_publish.store(true, Ordering::SeqCst);
        let error = sync_local_skill_package(
            &local,
            cache.to_str().unwrap(),
            temp.path().to_str().unwrap(),
            "user::fixture",
            &fault,
            None,
        )
        .await
        .unwrap_err();
        assert!(
            error.to_string().contains("publication failed"),
            "{error:#}"
        );
        assert_eq!(
            fs::read(Path::new(&first.path).join("SKILL.md")).unwrap(),
            b"target change",
            "failed repair preserves target-side data"
        );
    }

    #[tokio::test]
    async fn cancellation_during_streaming_preserves_prior_version_and_allows_retry() {
        let temp = tempfile::tempdir().unwrap();
        let local = temp.path().join("local");
        write(&local, "SKILL.md", b"original body");
        let cache = temp.path().join("cache");
        let original = sync_local_skill_package(
            &local,
            cache.to_str().unwrap(),
            temp.path().to_str().unwrap(),
            "user::fixture",
            &LocalWorkspaceFs,
            None,
        )
        .await
        .unwrap();
        write(&local, "SKILL.md", b"new body");
        let blocked = Arc::new(UploadBlock::default());
        blocked.blocked.store(true, Ordering::SeqCst);
        let target_fs = Arc::new(InstrumentedFs::default());
        target_fs
            .upload_block
            .lock()
            .unwrap()
            .replace(blocked.clone());
        let source = local.clone();
        let cache_string = cache.to_string_lossy().into_owned();
        let workspace = temp.path().to_string_lossy().into_owned();
        let fs_clone = target_fs.clone();
        let task = tokio::spawn(async move {
            sync_local_skill_package(
                &source,
                &cache_string,
                &workspace,
                "user::fixture",
                fs_clone.as_ref(),
                None,
            )
            .await
        });
        tokio::time::timeout(Duration::from_secs(5), blocked.started.notified())
            .await
            .unwrap();
        task.abort();
        assert!(task.await.unwrap_err().is_cancelled());
        assert_eq!(
            target_fs.counts.active.load(Ordering::SeqCst),
            0,
            "cancel releases every opened writer"
        );
        assert_eq!(
            fs::read(Path::new(&original.path).join("SKILL.md")).unwrap(),
            b"original body"
        );
        target_fs.upload_block.lock().unwrap().take();
        let retried = sync_local_skill_package(
            &local,
            cache.to_str().unwrap(),
            temp.path().to_str().unwrap(),
            "user::fixture",
            target_fs.as_ref(),
            None,
        )
        .await
        .unwrap();
        assert_eq!(
            fs::read(Path::new(&retried.path).join("SKILL.md")).unwrap(),
            b"new body"
        );
        target_fs.fail_metadata.store(true, Ordering::SeqCst);
        let error = sync_local_skill_package(
            &local,
            cache.to_str().unwrap(),
            temp.path().to_str().unwrap(),
            "user::fixture",
            target_fs.as_ref(),
            None,
        )
        .await
        .unwrap_err();
        assert!(
            error.to_string().contains("transport unavailable"),
            "offline metadata cannot fabricate a cache hit"
        );
    }

    #[tokio::test]
    async fn paused_repair_cannot_move_a_generation_returned_by_another_publisher() {
        let temp = tempfile::tempdir().unwrap();
        let local = temp.path().join("local");
        write(&local, "SKILL.md", b"expected body");
        let cache = temp.path().join("cache");
        let original = sync_local_skill_package(
            &local,
            cache.to_str().unwrap(),
            temp.path().to_str().unwrap(),
            "user::fixture",
            &LocalWorkspaceFs,
            None,
        )
        .await
        .unwrap();
        fs::write(Path::new(&original.path).join("SKILL.md"), b"target edits").unwrap();
        let gate = Arc::new(PublicationGate::default());
        gate.pause.store(true, Ordering::SeqCst);
        let paused_fs = Arc::new(InstrumentedFs::default());
        paused_fs
            .publication_gate
            .lock()
            .unwrap()
            .replace(gate.clone());
        let source = local.clone();
        let cache_string = cache.to_string_lossy().into_owned();
        let workspace = temp.path().to_string_lossy().into_owned();
        let fs_clone = paused_fs.clone();
        let first = tokio::spawn(async move {
            sync_local_skill_package(
                &source,
                &cache_string,
                &workspace,
                "user::fixture",
                fs_clone.as_ref(),
                None,
            )
            .await
        });
        tokio::time::timeout(Duration::from_secs(5), gate.started.notified())
            .await
            .unwrap();
        let winner = sync_local_skill_package(
            &local,
            cache.to_str().unwrap(),
            temp.path().to_str().unwrap(),
            "user::fixture",
            &LocalWorkspaceFs,
            None,
        )
        .await
        .unwrap();
        assert_eq!(
            fs::read(Path::new(&winner.path).join("SKILL.md")).unwrap(),
            b"expected body"
        );
        gate.release.notify_one();
        let other = first.await.unwrap().unwrap();
        assert_ne!(other.path, winner.path);
        assert_eq!(
            fs::read(Path::new(&winner.path).join("SKILL.md")).unwrap(),
            b"expected body",
            "a previously returned resource root stays reachable"
        );
        assert_eq!(
            fs::read(Path::new(&original.path).join("SKILL.md")).unwrap(),
            b"target edits",
            "corrupt target-side state is preserved"
        );
        assert!(
            sync_local_skill_package(
                &local,
                cache.to_str().unwrap(),
                temp.path().to_str().unwrap(),
                "user::fixture",
                &LocalWorkspaceFs,
                None
            )
            .await
            .unwrap()
            .reused
        );
    }

    #[tokio::test]
    async fn concurrent_publishers_leave_verified_deployments_and_remain_reusable() {
        let temp = tempfile::tempdir().unwrap();
        let local = temp.path().join("local");
        write(&local, "SKILL.md", b"concurrent body");
        for index in 0..20 {
            write(&local, &format!("references/{index}.txt"), b"content");
        }
        let cache = temp.path().join("cache");
        let deploy = || {
            sync_local_skill_package(
                &local,
                cache.to_str().unwrap(),
                temp.path().to_str().unwrap(),
                "user::fixture",
                &LocalWorkspaceFs,
                None,
            )
        };
        let (left, right) = tokio::join!(deploy(), deploy());
        assert!(left.is_ok() || right.is_ok(), "{left:?}; {right:?}");
        for result in [left, right].into_iter().flatten() {
            assert_eq!(
                fs::read(Path::new(&result.path).join("SKILL.md")).unwrap(),
                b"concurrent body"
            );
        }
        assert!(deploy().await.unwrap().reused);
    }
}
