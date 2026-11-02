#![cfg(feature = "local-storage")]

use openbitfun_services_core::exclusive_file_lease::{ExclusiveFileLease, ExclusiveFileLeaseError};
use std::path::Path;
use std::process::{Command, Stdio};
use std::time::{Duration, Instant};
use tempfile::tempdir;

#[test]
fn one_resource_can_have_only_one_lease_holder() {
    let project_root = tempdir().expect("project runtime root");
    let lock_path = project_root.path().join("lease.lock");

    let holder = ExclusiveFileLease::try_acquire(&lock_path).expect("first holder");
    let error = ExclusiveFileLease::try_acquire(&lock_path)
        .expect_err("second holder must fail immediately");

    assert!(matches!(error, ExclusiveFileLeaseError::InUse));
    assert_eq!(error.code(), "lease_in_use");
    assert_eq!(holder.lock_path(), lock_path.as_path());

    drop(holder);
    ExclusiveFileLease::try_acquire(&lock_path).expect("holder after release");
}

#[test]
fn different_lease_paths_are_independent() {
    let project_root = tempdir().expect("project runtime root");

    let _scheduler = ExclusiveFileLease::try_acquire(&project_root.path().join("scheduler.lock"))
        .expect("scheduler lease");
    let _store = ExclusiveFileLease::try_acquire(&project_root.path().join("store.lock"))
        .expect("store lease");
}

#[test]
fn a_stale_lock_file_does_not_block_a_new_holder() {
    let project_root = tempdir().expect("project runtime root");
    let lock_path = project_root.path().join("lease.lock");

    let holder = ExclusiveFileLease::try_acquire(&lock_path).expect("first holder");
    assert!(
        lock_path.exists(),
        "acquiring the lease creates its lock file"
    );
    drop(holder);

    assert!(
        lock_path.exists(),
        "the lock file may remain after the OS lock is released"
    );
    ExclusiveFileLease::try_acquire(&lock_path).expect("stale file must not imply ownership");
}

#[test]
fn acquiring_creates_a_missing_parent_directory() {
    let project_root = tempdir().expect("project runtime root");
    let lock_path = project_root.path().join("nested").join("lease.lock");

    let _holder = ExclusiveFileLease::try_acquire(&lock_path).expect("holder in a new directory");

    assert!(lock_path.exists());
}

#[test]
fn a_path_alias_resolves_to_the_same_lease() {
    let project_root = tempdir().expect("project runtime root");
    let lock_path = project_root.path().join("lease.lock");
    let alias = project_root.path().join(".").join("lease.lock");

    let _holder = ExclusiveFileLease::try_acquire(&lock_path).expect("first holder");
    let error = ExclusiveFileLease::try_acquire(&alias)
        .expect_err("a path alias must identify the same lease");

    assert_eq!(error.code(), "lease_in_use");
}

#[test]
fn abnormal_process_exit_releases_the_lease() {
    let project_root = tempdir().expect("project runtime root");
    let lock_path = project_root.path().join("lease.lock");
    let ready_path = project_root.path().join("child-ready");
    let mut command = Command::new(std::env::current_exe().expect("current test executable"));
    #[cfg(windows)]
    {
        use std::os::windows::process::CommandExt;
        command.creation_flags(0x0800_0000);
    }
    let mut child = command
        .arg("--exact")
        .arg("abnormal_exit_child_holds_lease")
        .arg("--nocapture")
        .env("OPENBITFUN_EXCLUSIVE_FILE_LEASE_CHILD", "1")
        .env("OPENBITFUN_EXCLUSIVE_FILE_LEASE_LOCK_PATH", &lock_path)
        .env("OPENBITFUN_EXCLUSIVE_FILE_LEASE_READY_PATH", &ready_path)
        .stdout(Stdio::null())
        .stderr(Stdio::null())
        .spawn()
        .expect("spawn lease child");

    let deadline = Instant::now() + Duration::from_secs(5);
    while !ready_path.exists() && Instant::now() < deadline {
        if let Some(status) = child.try_wait().expect("poll lease child") {
            panic!("lease child exited before acquiring the lease: {status}");
        }
        std::thread::sleep(Duration::from_millis(10));
    }
    if !ready_path.exists() {
        let _ = child.kill();
        let _ = child.wait();
        panic!("lease child did not become ready");
    }
    let was_blocked = matches!(
        ExclusiveFileLease::try_acquire(&lock_path),
        Err(ExclusiveFileLeaseError::InUse)
    );

    child.kill().expect("terminate lease child");
    child.wait().expect("reap lease child");
    assert!(was_blocked, "child process must own the lease");
    ExclusiveFileLease::try_acquire(&lock_path).expect("lease after abnormal process exit");
}

#[test]
fn abnormal_exit_child_holds_lease() {
    if std::env::var_os("OPENBITFUN_EXCLUSIVE_FILE_LEASE_CHILD").is_none() {
        return;
    }
    let lock_path = std::path::PathBuf::from(
        std::env::var_os("OPENBITFUN_EXCLUSIVE_FILE_LEASE_LOCK_PATH").expect("child lock path"),
    );
    let ready_path = std::path::PathBuf::from(
        std::env::var_os("OPENBITFUN_EXCLUSIVE_FILE_LEASE_READY_PATH").expect("child ready path"),
    );
    let _lease = ExclusiveFileLease::try_acquire(Path::new(&lock_path)).expect("child lease");
    std::fs::write(ready_path, b"ready").expect("publish child readiness");
    loop {
        std::thread::park();
    }
}
