#![cfg(feature = "process-runtime")]

use openbitfun_services_core::system::check_command;

#[test]
fn system_check_command_preserves_missing_command_shape() {
    let result = check_command("__openbitfun_missing_command_for_services_core_test__");

    assert!(!result.exists);
    assert_eq!(result.path, None);
}

#[cfg(windows)]
mod windows_process_cleanup {
    use openbitfun_services_core::process_manager::{
        cleanup_all_processes, contain_current_process_tree, create_command,
    };
    use openbitfun_services_core::process_tree::ProcessTreeChild;
    use std::path::Path;
    use std::process::Stdio;
    use std::time::{Duration, Instant};
    use tokio::io::AsyncReadExt;
    use windows::Win32::Foundation::{CloseHandle, ERROR_INVALID_PARAMETER, HANDLE, WAIT_OBJECT_0};
    use windows::Win32::System::Threading::{
        OpenProcess, WaitForSingleObject, PROCESS_SYNCHRONIZE,
    };

    const FIXTURE_TEST: &str = "windows_process_cleanup::fixture_process";
    const FIXTURE_ROLE: &str = "OPENBITFUN_PROCESS_CLEANUP_FIXTURE";
    const FIXTURE_DIR: &str = "OPENBITFUN_PROCESS_CLEANUP_DIR";
    const HOST_PID: &str = "OPENBITFUN_PROCESS_CLEANUP_HOST_PID";

    #[tokio::test]
    async fn empty_cleanup_returns_and_handoff_survives_host_exit() {
        run_owner_fixture("empty").await;
    }

    #[tokio::test]
    async fn cleanup_stops_managed_descendants_and_preserves_handoff() {
        run_owner_fixture("managed").await;
    }

    #[tokio::test]
    async fn cleanup_preserves_explicit_service_host_lifetime_containment() {
        run_owner_fixture("contained").await;
    }

    async fn run_owner_fixture(mode: &str) {
        let temporary = tempfile::tempdir().expect("create process cleanup fixture directory");
        let directory = temporary.path();
        let mut command = tokio::process::Command::from(fixture_command(mode, directory));
        command.stderr(Stdio::piped());
        // An outer child Job protects the test runner and removes fixture
        // descendants even when an assertion or the old self-kill bug fires.
        let mut owner = ProcessTreeChild::spawn(&mut command)
            .await
            .expect("spawn isolated cleanup owner");
        let mut stderr = owner.take_stderr().expect("capture owner errors");
        let status = tokio::time::timeout(Duration::from_secs(20), owner.wait())
            .await
            .expect("cleanup owner must finish")
            .expect("wait for cleanup owner");
        let mut errors = String::new();
        stderr.read_to_string(&mut errors).await.unwrap();
        assert!(status.success(), "cleanup owner failed: {errors}");
        // Windows Job self-termination can return exit code 0. An explicit
        // post-cleanup marker is required to distinguish it from success.
        assert!(
            directory.join("cleanup-complete").is_file(),
            "host did not return from cleanup: {errors}"
        );
        assert!(!directory.join("unexpected-spawn").exists());

        if mode == "contained" {
            let pid = read_pid(&directory.join("lifetime.pid"));
            match ProcessHandle::open(pid) {
                Ok(process) => process.assert_exited(),
                Err(error) => assert_eq!(
                    error.code(),
                    windows::core::HRESULT::from_win32(ERROR_INVALID_PARAMETER.0),
                    "an unavailable fixture PID must already have exited"
                ),
            }
        } else {
            for role in ["handoff-before", "handoff-after"] {
                wait_for_file(&directory.join(format!("{role}.complete"))).await;
            }
        }
    }

    fn fixture_command(role: &str, directory: &Path) -> std::process::Command {
        let mut command = create_command(std::env::current_exe().expect("locate test executable"));
        command
            .args(["--exact", FIXTURE_TEST, "--nocapture"])
            .env(FIXTURE_ROLE, role)
            .env(FIXTURE_DIR, directory)
            .stdin(Stdio::null())
            .stdout(Stdio::null())
            .stderr(Stdio::null());
        command
    }

    #[test]
    fn fixture_process() {
        let Ok(role) = std::env::var(FIXTURE_ROLE) else {
            return;
        };
        let directory = std::path::PathBuf::from(std::env::var_os(FIXTURE_DIR).unwrap());
        match role.as_str() {
            "managed-parent" => {
                let _child = fixture_command("managed-leaf", &directory)
                    .spawn()
                    .expect("spawn managed descendant");
                idle();
            }
            "managed-leaf" | "lifetime" => {
                let file = if role == "lifetime" {
                    "lifetime.pid"
                } else {
                    "descendant.pid"
                };
                std::fs::write(directory.join(file), std::process::id().to_string()).unwrap();
                idle();
            }
            "handoff-before" | "handoff-after" => {
                let host = ProcessHandle::open(std::env::var(HOST_PID).unwrap().parse().unwrap())
                    .expect("open handoff parent before it exits");
                std::fs::write(directory.join(format!("{role}.ready")), "ready").unwrap();
                host.assert_exited();
                std::fs::write(directory.join(format!("{role}.complete")), "survived").unwrap();
            }
            "unexpected" => {
                std::fs::write(directory.join("unexpected-spawn"), "started").unwrap();
            }
            "empty" | "managed" | "contained" => {
                tokio::runtime::Builder::new_current_thread()
                    .enable_all()
                    .build()
                    .unwrap()
                    .block_on(run_cleanup_owner(&role, &directory));
            }
            _ => panic!("unknown cleanup fixture role: {role}"),
        }
    }

    async fn run_cleanup_owner(mode: &str, directory: &Path) {
        if mode == "contained" {
            contain_current_process_tree().expect("establish explicit host lifetime containment");
        } else {
            spawn_handoff("handoff-before", directory).await;
        }

        let mut managed = None;
        let mut descendant = None;
        if mode != "empty" {
            let mut command =
                tokio::process::Command::from(fixture_command("managed-parent", directory));
            managed = Some(ProcessTreeChild::spawn(&mut command).await.unwrap());
            let pid_file = directory.join("descendant.pid");
            wait_for_file(&pid_file).await;
            descendant = Some(ProcessHandle::open(read_pid(&pid_file)).unwrap());
        }

        cleanup_all_processes();
        cleanup_all_processes();
        if let Some(mut tree) = managed {
            tokio::time::timeout(Duration::from_secs(5), tree.wait())
                .await
                .expect("managed parent must exit after cleanup")
                .unwrap();
            descendant.unwrap().assert_exited();
        }

        let mut command = tokio::process::Command::from(fixture_command("unexpected", directory));
        let error = ProcessTreeChild::spawn(&mut command)
            .await
            .expect_err("shutdown must reject new managed children before they run");
        assert_eq!(error.kind(), std::io::ErrorKind::BrokenPipe);
        std::fs::write(directory.join("cleanup-complete"), "completed").unwrap();

        if mode == "contained" {
            // Cleanup must leave the explicit host Job intact: even a raw
            // descendant started afterwards still ends when this host exits.
            let _child = fixture_command("lifetime", directory).spawn().unwrap();
            wait_for_file(&directory.join("lifetime.pid")).await;
        } else {
            spawn_handoff("handoff-after", directory).await;
        }
    }

    async fn spawn_handoff(role: &str, directory: &Path) {
        let _child = fixture_command(role, directory)
            .env(HOST_PID, std::process::id().to_string())
            .spawn()
            .expect("start independent handoff process");
        wait_for_file(&directory.join(format!("{role}.ready"))).await;
    }

    async fn wait_for_file(path: &Path) {
        let deadline = Instant::now() + Duration::from_secs(5);
        while !std::fs::metadata(path).is_ok_and(|metadata| metadata.len() > 0) {
            assert!(Instant::now() < deadline, "fixture did not write {path:?}");
            tokio::time::sleep(Duration::from_millis(10)).await;
        }
    }

    fn read_pid(path: &Path) -> u32 {
        std::fs::read_to_string(path)
            .unwrap()
            .trim()
            .parse()
            .unwrap()
    }

    fn idle() -> ! {
        loop {
            std::thread::park();
        }
    }

    struct ProcessHandle(HANDLE);

    impl ProcessHandle {
        fn open(pid: u32) -> windows::core::Result<Self> {
            // SAFETY: the PID comes from an owned fixture; this handle only
            // permits waiting and is closed by Drop.
            unsafe { OpenProcess(PROCESS_SYNCHRONIZE, false, pid).map(Self) }
        }

        fn assert_exited(&self) {
            // SAFETY: the handle is owned and valid throughout this wait.
            assert_eq!(
                unsafe { WaitForSingleObject(self.0, 10_000) },
                WAIT_OBJECT_0,
                "fixture process survived its lifecycle boundary"
            );
        }
    }

    impl Drop for ProcessHandle {
        fn drop(&mut self) {
            // SAFETY: this handle is owned and closed exactly once.
            let _ = unsafe { CloseHandle(self.0) };
        }
    }
}

/// Linux children must resolve the same executables a login shell would.
///
/// A `.desktop` launch starts with the session PATH, which omits entries a
/// login shell adds (`~/.local/bin`, version-manager bin dirs). The async
/// command builder is the path used by MCP servers, hooks, plugin hosts and
/// desktop cards, so it must carry the resolved entries to the child.
#[cfg(target_os = "linux")]
mod platform_path_environment {
    use openbitfun_services_core::process_manager::create_tokio_command;
    use openbitfun_services_core::system::platform_path_entries;
    use std::path::PathBuf;
    use std::process::Stdio;

    /// Set only in the probe child, so the parent test can run the assertion
    /// with a deliberately narrow `PATH`.
    const PROBE_ENV: &str = "OPENBITFUN_PLATFORM_PATH_PROBE";
    const NARROW_PATH: &str = "/openbitfun-probe-missing";

    #[test]
    fn platform_path_entries_are_deduplicated_existing_directories() {
        let entries = platform_path_entries();
        assert!(
            !entries.is_empty(),
            "Linux must contribute platform PATH entries"
        );

        for entry in &entries {
            assert!(entry.is_absolute(), "{} is not absolute", entry.display());
            assert!(entry.is_dir(), "{} is not a directory", entry.display());
        }

        let mut unique = entries.clone();
        unique.sort();
        unique.dedup();
        assert_eq!(
            unique.len(),
            entries.len(),
            "platform PATH entries must be deduplicated: {entries:?}"
        );
    }

    /// A child whose `PATH` omits every platform entry proves the override is
    /// real: with the developer's own shell `PATH` in place the assertion would
    /// pass even if no `PATH` were ever handed to the child.
    #[test]
    fn async_children_receive_the_platform_path() {
        if std::env::var_os(PROBE_ENV).is_some() {
            assert_child_receives_platform_path();
            return;
        }

        let exe = std::env::current_exe().expect("test binary path");
        let output = std::process::Command::new(exe)
            .args([
                "--exact",
                "platform_path_environment::async_children_receive_the_platform_path",
                "--nocapture",
            ])
            .env("PATH", NARROW_PATH)
            .env(PROBE_ENV, "1")
            .output()
            .expect("spawn PATH probe");

        assert!(
            output.status.success(),
            "PATH probe failed:\n{}",
            String::from_utf8_lossy(&output.stderr)
        );
    }

    fn assert_child_receives_platform_path() {
        let platform_entries = platform_path_entries();
        assert!(
            !platform_entries.is_empty(),
            "Linux must contribute platform PATH entries"
        );

        let runtime = tokio::runtime::Builder::new_current_thread()
            .enable_all()
            .build()
            .expect("build probe runtime");
        let child_path = runtime.block_on(async {
            let mut command = create_tokio_command("/bin/sh");
            command
                .args(["-c", "printf '%s' \"$PATH\""])
                .stdout(Stdio::piped());
            let output = command.output().await.expect("run PATH probe");
            assert!(output.status.success(), "PATH probe command failed");
            String::from_utf8_lossy(&output.stdout).into_owned()
        });
        let child_entries: Vec<PathBuf> = std::env::split_paths(&child_path).collect();

        for entry in &platform_entries {
            assert!(
                child_entries.contains(entry),
                "child PATH is missing {}: {child_entries:?}",
                entry.display()
            );
        }

        assert!(
            child_entries
                .iter()
                .any(|entry| entry == std::path::Path::new(NARROW_PATH)),
            "child PATH dropped the inherited entry: {child_entries:?}"
        );
    }
}
