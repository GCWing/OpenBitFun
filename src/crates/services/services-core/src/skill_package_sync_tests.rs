use super::*;

#[test]
fn remote_cache_paths_use_posix_syntax_on_every_controller() {
    assert!(validate_remote_root("/home/user/project/cache").is_ok());
    assert!(validate_remote_root("/home/user/a\\b/cache").is_ok());
    for path in [
        "C:\\Users\\me\\cache",
        "relative/cache",
        "/tmp/../escape",
        "/tmp/./cache",
    ] {
        assert!(validate_remote_root(path).is_err(), "{path}");
    }
    assert_eq!(quote("a'b\n$HOME`x`"), "'a'\\''b\n$HOME`x`'");
    assert!(validate_remote_cache_location("/workspace/.openbitfun/cache", "/workspace").is_ok());
    assert!(
        validate_remote_cache_location("/workspace/.openbitfun/cache", "/workspace-other").is_err()
    );
    assert!(validate_remote_cache_location("/workspace", "/workspace").is_err());
    assert!(validate_remote_cache_location("/outside/cache", "/workspace").is_err());
}

#[test]
fn scanning_skips_compression_and_packing_rejects_source_changes() {
    let temp = tempfile::tempdir().unwrap();
    fs::write(temp.path().join("SKILL.md"), b"before").unwrap();
    let package = scan_package(
        temp.path(),
        "user::fixture",
        &None,
        Arc::new(AtomicBool::new(false)),
    )
    .unwrap();
    assert!(
        !package.path.exists(),
        "cache checking must not create a compressed archive"
    );
    fs::write(temp.path().join("SKILL.md"), b"after!").unwrap();
    let error = build_archive(package)
        .err()
        .expect("changed source must fail");
    assert!(
        error.to_string().contains("changed while preparing"),
        "{error:#}"
    );
}

#[cfg(all(unix, feature = "workspace-runtime"))]
mod posix {
    use super::*;
    use crate::workspace::{LocalWorkspaceFs, LocalWorkspaceShell};
    use openbitfun_runtime_ports::{WorkspaceCommandResult, WorkspaceDirEntry};
    use std::{
        os::unix::fs::{symlink, PermissionsExt},
        sync::{
            atomic::{AtomicUsize, Ordering},
            Mutex,
        },
    };

    struct CountingShell {
        inner: LocalWorkspaceShell,
        calls: AtomicUsize,
    }

    #[async_trait::async_trait]
    impl WorkspaceShell for CountingShell {
        async fn exec_with_options(
            &self,
            command: &str,
            options: WorkspaceCommandOptions,
        ) -> Result<WorkspaceCommandResult> {
            self.calls.fetch_add(1, Ordering::Relaxed);
            self.inner.exec_with_options(command, options).await
        }
    }

    fn write(root: &Path, name: &str, bytes: &[u8]) {
        let path = root.join(name);
        fs::create_dir_all(path.parent().unwrap()).unwrap();
        fs::write(path, bytes).unwrap();
    }

    #[tokio::test]
    async fn deploys_complete_package_in_two_commands_and_preserves_executables() {
        let temp = tempfile::tempdir().unwrap();
        let local = temp.path().join("local user's skill");
        let remote = temp.path().join("remote workspace");
        fs::create_dir(&remote).unwrap();
        write(
            &local,
            "SKILL.md",
            b"Run scripts/hello.sh, read references/guide.md",
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
            b"#!/bin/sh\nprintf '%s' remote-script-ok\n",
        );
        fs::set_permissions(
            local.join("scripts/hello.sh"),
            fs::Permissions::from_mode(0o751),
        )
        .unwrap();
        for number in 0..200 {
            write(&local, &format!("many/{number}.txt"), b"tiny file");
        }
        let shell = CountingShell {
            inner: LocalWorkspaceShell::new(remote.to_string_lossy().into_owned()),
            calls: AtomicUsize::new(0),
        };
        let phases = Arc::new(Mutex::new(Vec::new()));
        let observed = phases.clone();
        let result = sync_local_skill_package(
            &local,
            remote.join("cache 'target'\n$literal").to_str().unwrap(),
            remote.to_str().unwrap(),
            "user::test",
            &LocalWorkspaceFs,
            &shell,
            Some(Arc::new(move |progress| {
                observed.lock().unwrap().push(progress.phase)
            })),
        )
        .await
        .unwrap();
        assert!(!result.reused);
        assert_eq!(result.file_count, 204);
        assert_eq!(
            shell.calls.load(Ordering::Relaxed),
            2,
            "file count must not multiply SSH commands"
        );
        assert_eq!(
            fs::read(Path::new(&result.path).join("references/guide 'one' \u{4e2d}.md")).unwrap(),
            b"full reference\n"
        );
        assert_eq!(
            fs::read(Path::new(&result.path).join("templates/example.bin")).unwrap(),
            [0, 255, 1, 2]
        );
        let (output, _, status) = shell
            .exec(&quote(&format!("{}/scripts/hello.sh", result.path)), None)
            .await
            .unwrap();
        assert_eq!(status, 0);
        assert_eq!(output, "remote-script-ok");
        assert_eq!(
            fs::metadata(Path::new(&result.path).join("scripts/hello.sh"))
                .unwrap()
                .permissions()
                .mode()
                & 0o777,
            0o751
        );
        let phases = phases.lock().unwrap();
        for phase in [
            SkillPackageSyncPhase::Scanning,
            SkillPackageSyncPhase::Checking,
            SkillPackageSyncPhase::Uploading,
            SkillPackageSyncPhase::Extracting,
            SkillPackageSyncPhase::Complete,
        ] {
            assert!(phases.contains(&phase));
        }
    }

    #[tokio::test]
    async fn cache_reuse_verifies_bytes_modes_missing_and_extra_files_then_tracks_local_changes() {
        let temp = tempfile::tempdir().unwrap();
        let local = temp.path().join("local");
        write(&local, "SKILL.md", b"skill body");
        write(&local, "references/guide.md", b"original");
        write(&local, "templates/deleted.txt", b"delete locally later");
        let cache = temp.path().join("cache").to_string_lossy().into_owned();
        let shell = LocalWorkspaceShell::new(temp.path().to_string_lossy().into_owned());
        let deploy = || {
            sync_local_skill_package(
                &local,
                &cache,
                temp.path().to_str().unwrap(),
                "user::fixture",
                &LocalWorkspaceFs,
                &shell,
                None,
            )
        };
        let original = deploy().await.unwrap();
        assert!(!original.reused);
        let again = deploy().await.unwrap();
        assert!(again.reused);
        assert_eq!(again.path, original.path);
        let guide = Path::new(&original.path).join("references/guide.md");
        fs::write(&guide, b"tampered").unwrap();
        assert!(!deploy().await.unwrap().reused);
        assert_eq!(fs::read(&guide).unwrap(), b"original");
        fs::remove_file(&guide).unwrap();
        assert!(!deploy().await.unwrap().reused);
        assert!(guide.is_file());
        let extra = Path::new(&original.path).join("extra.txt");
        fs::write(&extra, b"not in source").unwrap();
        assert!(!deploy().await.unwrap().reused);
        assert!(!extra.exists());
        fs::set_permissions(&guide, fs::Permissions::from_mode(0o700)).unwrap();
        assert!(!deploy().await.unwrap().reused);
        write(&local, "references/guide.md", b"updated locally");
        fs::remove_file(local.join("templates/deleted.txt")).unwrap();
        let updated = deploy().await.unwrap();
        assert!(!updated.reused);
        assert_ne!(updated.content_hash, original.content_hash);
        assert_eq!(
            fs::read(Path::new(&updated.path).join("references/guide.md")).unwrap(),
            b"updated locally"
        );
        assert!(!Path::new(&updated.path)
            .join("templates/deleted.txt")
            .exists());
        assert_eq!(
            fs::read(&guide).unwrap(),
            b"original",
            "older content-addressed deployments stay intact"
        );
    }

    #[tokio::test]
    async fn accepts_symlinked_package_root_but_rejects_nested_links_without_success() {
        let temp = tempfile::tempdir().unwrap();
        let local = temp.path().join("local");
        write(&local, "SKILL.md", b"skill body");
        let link = temp.path().join("linked-root");
        symlink(&local, &link).unwrap();
        let cache = temp.path().join("cache").to_string_lossy().into_owned();
        let shell = LocalWorkspaceShell::new(temp.path().to_string_lossy().into_owned());
        let first = sync_local_skill_package(
            &link,
            &cache,
            temp.path().to_str().unwrap(),
            "user::fixture",
            &LocalWorkspaceFs,
            &shell,
            None,
        )
        .await
        .unwrap();
        assert!(!first.reused);
        assert!(
            sync_local_skill_package(
                &local,
                &cache,
                temp.path().to_str().unwrap(),
                "user::fixture",
                &LocalWorkspaceFs,
                &shell,
                None
            )
            .await
            .unwrap()
            .reused
        );
        symlink(temp.path(), local.join("escaping-link")).unwrap();
        let error = sync_local_skill_package(
            &local,
            &cache,
            temp.path().to_str().unwrap(),
            "user::fixture",
            &LocalWorkspaceFs,
            &shell,
            None,
        )
        .await
        .unwrap_err();
        assert!(
            error.to_string().contains("nested symbolic links"),
            "{error:#}"
        );
        assert!(Path::new(&first.path).join("SKILL.md").is_file());
    }

    #[tokio::test]
    async fn supports_symlinked_workspace_ancestors_but_rejects_managed_cache_links() {
        let temp = tempfile::tempdir().unwrap();
        let local = temp.path().join("local");
        write(&local, "SKILL.md", b"skill body");
        write(&local, "references/guide.md", b"deployed reference");
        let real = temp.path().join("real");
        fs::create_dir_all(real.join("workspace")).unwrap();
        let alias = temp.path().join("alias");
        symlink(&real, &alias).unwrap();
        let workspace = alias.join("workspace");
        let cache = workspace.join(".openbitfun/cache/user-skills");
        let shell = LocalWorkspaceShell::new(workspace.to_string_lossy().into_owned());
        let deploy = || {
            sync_local_skill_package(
                &local,
                cache.to_str().unwrap(),
                workspace.to_str().unwrap(),
                "user::fixture",
                &LocalWorkspaceFs,
                &shell,
                None,
            )
        };
        let first = deploy().await.unwrap();
        assert!(first.path.starts_with(cache.to_str().unwrap()));
        assert_eq!(
            fs::read(Path::new(&first.path).join("references/guide.md")).unwrap(),
            b"deployed reference"
        );
        assert!(deploy().await.unwrap().reused);

        // Resolving the trusted workspace must not authorize a repository's
        // .openbitfun/cache link to escape to an unrelated directory.
        fs::remove_dir_all(workspace.join(".openbitfun")).unwrap();
        fs::create_dir(workspace.join(".openbitfun")).unwrap();
        let outside = temp.path().join("outside");
        fs::create_dir(&outside).unwrap();
        write(&outside, "sentinel", b"untouched");
        symlink(&outside, workspace.join(".openbitfun/cache")).unwrap();
        let error = deploy().await.unwrap_err();
        assert!(
            error.to_string().contains("without symbolic links"),
            "{error:#}"
        );
        assert_eq!(fs::read(outside.join("sentinel")).unwrap(), b"untouched");
        assert!(!outside.join("user-skills").exists());
    }

    struct NoPython;
    #[async_trait::async_trait]
    impl WorkspaceShell for NoPython {
        async fn exec_with_options(
            &self,
            _: &str,
            _: WorkspaceCommandOptions,
        ) -> Result<WorkspaceCommandResult> {
            Ok(WorkspaceCommandResult {
                stdout: String::new(),
                stderr: "Full user Skill sync requires Python 3 on the remote target".into(),
                exit_code: 127,
                interrupted: false,
                timed_out: false,
            })
        }
    }

    struct NoUploads;
    #[async_trait::async_trait]
    impl WorkspaceFileSystem for NoUploads {
        async fn read_file(&self, _: &str) -> Result<Vec<u8>> {
            bail!("unexpected read")
        }
        async fn read_file_text(&self, _: &str) -> Result<String> {
            bail!("unexpected read")
        }
        async fn write_file(&self, _: &str, _: &[u8]) -> Result<()> {
            bail!("unexpected write")
        }
        async fn exists(&self, _: &str) -> Result<bool> {
            bail!("unexpected exists")
        }
        async fn is_file(&self, _: &str) -> Result<bool> {
            bail!("unexpected stat")
        }
        async fn is_dir(&self, _: &str) -> Result<bool> {
            bail!("unexpected stat")
        }
        async fn read_dir(&self, _: &str) -> Result<Vec<WorkspaceDirEntry>> {
            bail!("unexpected listing")
        }
    }

    #[tokio::test]
    async fn unsupported_targets_and_failed_uploads_never_return_a_loaded_package() {
        let temp = tempfile::tempdir().unwrap();
        let local = temp.path().join("local");
        write(&local, "SKILL.md", b"original");
        let cache = temp.path().join("cache").to_string_lossy().into_owned();
        let error = sync_local_skill_package(
            &local,
            &cache,
            temp.path().to_str().unwrap(),
            "user::fixture",
            &NoUploads,
            &NoPython,
            None,
        )
        .await
        .unwrap_err();
        assert!(error.to_string().contains("requires Python 3"));
        assert!(!Path::new(&cache).exists());
        let shell = LocalWorkspaceShell::new(temp.path().to_string_lossy().into_owned());
        let original = sync_local_skill_package(
            &local,
            &cache,
            temp.path().to_str().unwrap(),
            "user::fixture",
            &LocalWorkspaceFs,
            &shell,
            None,
        )
        .await
        .unwrap();
        write(&local, "SKILL.md", b"updated locally");
        let error = sync_local_skill_package(
            &local,
            &cache,
            temp.path().to_str().unwrap(),
            "user::fixture",
            &NoUploads,
            &shell,
            None,
        )
        .await
        .unwrap_err();
        assert!(error
            .to_string()
            .contains("streaming Skill package uploads"));
        assert_eq!(
            fs::read(Path::new(&original.path).join("SKILL.md")).unwrap(),
            b"original"
        );
    }
}
