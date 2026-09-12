use std::process::{Command, Stdio};
#[cfg(unix)]
use std::time::Duration;

use anyhow::{anyhow, bail, Context, Result};

use super::store::DispatchStore;

pub(crate) const PREPARING_GRACE_SECONDS: u64 = 10;

pub(crate) fn is_supported() -> bool {
    cfg!(any(target_os = "linux", target_os = "macos"))
}

pub(crate) fn spawn(store: &DispatchStore, job_id: &str) -> Result<u32> {
    let result = spawn_detached_action("__run", job_id, "dispatch worker");
    if result.is_err() {
        store.clear_preparing(job_id);
    }
    result
}

pub(crate) fn spawn_workspace_provision(job_id: &str) -> Result<u32> {
    spawn_detached_action(
        "__workspace_provision_run",
        job_id,
        "dispatch workspace provisioner",
    )
}

pub(crate) fn spawn_workspace_bundle_commit(job_id: &str) -> Result<u32> {
    spawn_detached_action(
        "__workspace_bundle_commit_run",
        job_id,
        "dispatch bundle importer",
    )
}

pub(crate) fn spawn_workspace_sync(job_id: &str) -> Result<u32> {
    spawn_detached_action(
        "__workspace_sync_run",
        job_id,
        "dispatch workspace synchronizer",
    )
}

fn spawn_detached_action(action: &str, job_id: &str, description: &str) -> Result<u32> {
    if !is_supported() {
        bail!("dispatch detached workers are supported only on Linux and macOS");
    }

    let executable = std::env::current_exe().context("resolve OpenBitFun executable")?;
    let mut command = openbitfun_services_core::process_manager::create_command(executable);
    command
        .arg("dispatch")
        .arg(action)
        .arg("--job")
        .arg(job_id)
        .stdin(Stdio::null())
        .stdout(Stdio::null())
        .stderr(Stdio::null());
    if let Some(home) = dirs::home_dir() {
        command.current_dir(home);
    }
    configure_detached_process(&mut command);

    let child = command
        .spawn()
        .with_context(|| format!("start detached {description}"))?;
    let pid = child.id();
    // The action acquires its durable job or upload lock in the child. The
    // parent PID is informational until that target-owned claim succeeds.
    Ok(pid)
}

pub(crate) fn worker_process_alive(pid: u32, job_id: &str) -> bool {
    process_alive(pid) && process_matches_job(pid, job_id)
}

pub(crate) fn workspace_operation_process_alive(pid: u32, action: &str, job_id: &str) -> bool {
    process_alive(pid) && process_matches_action(pid, action, job_id)
}

pub(crate) fn worker_process_group_alive(pid: u32) -> bool {
    #[cfg(unix)]
    {
        i32::try_from(pid)
            .ok()
            .is_some_and(|process_group| process_group > 1 && process_group_alive(process_group))
    }
    #[cfg(not(unix))]
    {
        let _ = pid;
        false
    }
}

pub(crate) fn terminate_worker(pid: u32, job_id: &str) -> Result<bool> {
    let signed_pid = i32::try_from(pid).map_err(|_| anyhow!("worker pid is out of range"))?;
    if signed_pid <= 1 {
        bail!("refusing to signal unsafe dispatch worker pid {pid}");
    }
    #[cfg(unix)]
    {
        let pid = signed_pid;
        if !process_alive(pid as u32) {
            if process_group_alive(pid) {
                bail!(
                    "dispatch worker leader pid {pid} is no longer alive; refusing to signal \
                     unverified process group {pid} because its PGID may have been reused"
                );
            }
            return Ok(false);
        }
        if !process_matches_job(pid as u32, job_id) {
            bail!("dispatch worker pid {pid} does not match job '{job_id}'");
        }
        if pid as u32 == std::process::id() {
            bail!("refusing to signal the current dispatch process {pid}");
        }

        // The live, identity-verified worker called setsid, so its PID is also
        // the process-group ID. Never enter this signalling path from a marker
        // whose leader has already disappeared.
        if !signal_process_group(pid, libc::SIGTERM)? {
            return Ok(true);
        }
        if wait_for_process_group_exit(pid) {
            return Ok(true);
        }

        // Escalation requires a fresh, exact leader identity. The group may
        // have emptied and its numeric PGID may have been reused during the
        // TERM grace period, so an absent leader can no longer authenticate
        // any remaining group even though it was verified before TERM.
        if !process_alive(pid as u32) {
            bail!(
                "dispatch worker leader pid {pid} exited after SIGTERM; refusing to signal \
                 unverified process group {pid} because its PGID may have been reused"
            );
        }
        if !process_matches_job(pid as u32, job_id) {
            bail!("dispatch worker pid {pid} changed identity before SIGKILL");
        }
        if !signal_process_group(pid, libc::SIGKILL)? {
            return Ok(true);
        }
        if !wait_for_process_group_exit(pid) {
            bail!("dispatch worker process group {pid} remained alive after SIGKILL");
        }
        Ok(true)
    }
    #[cfg(not(unix))]
    {
        let _ = (pid, job_id);
        bail!("dispatch worker cancellation is unsupported on this platform")
    }
}

fn configure_detached_process(command: &mut Command) {
    #[cfg(unix)]
    {
        use std::os::unix::process::CommandExt;
        unsafe {
            command.pre_exec(|| {
                if libc::setsid() == -1 {
                    Err(std::io::Error::last_os_error())
                } else {
                    Ok(())
                }
            });
        }
    }
    #[cfg(not(unix))]
    let _ = command;
}

#[cfg(unix)]
fn signal_process_group(process_group: i32, signal: i32) -> Result<bool> {
    // SAFETY: callers validate the positive process-group id and worker
    // identity before signalling.
    if unsafe { libc::kill(-process_group, signal) } == 0 {
        return Ok(true);
    }
    let error = std::io::Error::last_os_error();
    if error.raw_os_error() == Some(libc::ESRCH) {
        Ok(false)
    } else {
        Err(error).with_context(|| {
            format!("signal dispatch worker process group {process_group} with {signal}")
        })
    }
}

#[cfg(unix)]
fn wait_for_process_group_exit(process_group: i32) -> bool {
    for _ in 0..40 {
        if !process_group_alive(process_group) {
            return true;
        }
        std::thread::sleep(Duration::from_millis(25));
    }
    !process_group_alive(process_group)
}

#[cfg(unix)]
fn process_group_alive(process_group: i32) -> bool {
    // SAFETY: signal 0 performs liveness/permission checking only.
    if unsafe { libc::kill(-process_group, 0) } == 0 {
        return true;
    }
    matches!(
        std::io::Error::last_os_error().raw_os_error(),
        Some(libc::EPERM)
    )
}

#[cfg(any(test, target_os = "macos"))]
fn macos_process_state_allows_escalation(stat: &str) -> bool {
    let Some(stat) = stat.split_whitespace().next() else {
        return false;
    };
    matches!(stat.chars().next(), Some('I' | 'R' | 'S' | 'T' | 'U'))
        && !stat.chars().skip(1).any(|modifier| modifier == 'E')
}

#[cfg(unix)]
pub(crate) fn process_alive(pid: u32) -> bool {
    let Ok(pid) = i32::try_from(pid) else {
        return false;
    };
    // SAFETY: signal 0 performs liveness/permission checking only.
    if unsafe { libc::kill(pid, 0) } != 0
        && !matches!(
            std::io::Error::last_os_error().raw_os_error(),
            Some(libc::EPERM)
        )
    {
        return false;
    }

    #[cfg(target_os = "linux")]
    {
        // A zombie still answers to kill(0), but it has already exited and
        // must not be treated as an authenticated leader for escalation.
        if let Ok(stat) = std::fs::read_to_string(format!("/proc/{pid}/stat")) {
            if stat
                .rsplit_once(") ")
                .and_then(|(_, fields)| fields.split_whitespace().next())
                == Some("Z")
            {
                return false;
            }
        }
    }

    #[cfg(target_os = "macos")]
    {
        // macOS reports zombies as present to kill(0), and ps marks a process
        // that is trying to exit with the E modifier. Require a known live
        // state with no exit modifier before authenticating SIGKILL escalation;
        // a failed or unrecognized query must fail closed.
        let output = Command::new("ps")
            .args(["-p", &pid.to_string(), "-o", "stat="])
            .output();
        let Ok(output) = output else {
            return false;
        };
        if !output.status.success() {
            return false;
        }
        return macos_process_state_allows_escalation(&String::from_utf8_lossy(&output.stdout));
    }

    #[cfg(not(target_os = "macos"))]
    {
        true
    }
}

#[cfg(not(unix))]
pub(crate) fn process_alive(_pid: u32) -> bool {
    false
}

#[cfg(target_os = "linux")]
fn process_matches_job(pid: u32, job_id: &str) -> bool {
    process_matches_action(pid, "__run", job_id)
}

#[cfg(target_os = "linux")]
fn process_matches_action(pid: u32, action: &str, job_id: &str) -> bool {
    let Ok(raw) = std::fs::read(format!("/proc/{pid}/cmdline")) else {
        return false;
    };
    let args = raw
        .split(|byte| *byte == 0)
        .filter(|arg| !arg.is_empty())
        .map(|arg| String::from_utf8_lossy(arg).into_owned())
        .collect::<Vec<_>>();
    arguments_match_action(&args, action, job_id)
}

#[cfg(target_os = "macos")]
fn process_matches_job(pid: u32, job_id: &str) -> bool {
    process_matches_action(pid, "__run", job_id)
}

#[cfg(target_os = "macos")]
fn process_matches_action(pid: u32, action: &str, job_id: &str) -> bool {
    let output = Command::new("ps")
        .args(["-p", &pid.to_string(), "-o", "command="])
        .output();
    let Ok(output) = output else {
        return false;
    };
    if !output.status.success() {
        return false;
    }
    let command = String::from_utf8_lossy(&output.stdout);
    let args = command
        .split_whitespace()
        .map(ToOwned::to_owned)
        .collect::<Vec<_>>();
    arguments_match_action(&args, action, job_id)
}

#[cfg(not(any(target_os = "linux", target_os = "macos")))]
fn process_matches_job(_pid: u32, _job_id: &str) -> bool {
    false
}

#[cfg(not(any(target_os = "linux", target_os = "macos")))]
fn process_matches_action(_pid: u32, _action: &str, _job_id: &str) -> bool {
    false
}

fn arguments_match_action(args: &[String], action: &str, job_id: &str) -> bool {
    args.windows(4).any(|window| {
        window[0] == "dispatch"
            && window[1] == action
            && window[2] == "--job"
            && window[3] == job_id
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn detached_runner_support_matches_the_v1_platform_contract() {
        assert_eq!(
            is_supported(),
            cfg!(any(target_os = "linux", target_os = "macos"))
        );
    }

    #[test]
    fn current_test_process_is_not_mistaken_for_a_dispatch_worker() {
        assert!(!worker_process_alive(std::process::id(), "job-1"));
    }

    #[test]
    fn process_identity_requires_the_exact_hidden_worker_arguments() {
        let expected = ["openbitfun", "dispatch", "__run", "--job", "job-1"].map(str::to_string);
        assert!(arguments_match_action(&expected, "__run", "job-1"));
        assert!(!arguments_match_action(&expected, "__run", "job-2"));
        let unrelated = ["openbitfun", "dispatch", "status"].map(str::to_string);
        assert!(!arguments_match_action(&unrelated, "__run", "job-1"));
    }

    #[test]
    fn workspace_operation_identity_requires_the_exact_hidden_action() {
        let expected = [
            "openbitfun",
            "dispatch",
            "__workspace_sync_run",
            "--job",
            "job-1",
        ]
        .map(str::to_string);
        assert!(arguments_match_action(
            &expected,
            "__workspace_sync_run",
            "job-1"
        ));
        assert!(!arguments_match_action(
            &expected,
            "__workspace_provision_run",
            "job-1"
        ));
        assert!(!arguments_match_action(
            &expected,
            "__workspace_sync_run",
            "job-2"
        ));
    }

    #[test]
    fn macos_live_process_states_can_authenticate_sigkill_escalation() {
        for stat in ["I", "R+", "Ss", "T", "U"] {
            assert!(
                macos_process_state_allows_escalation(stat),
                "live state {stat} should authenticate escalation"
            );
        }
    }

    #[test]
    fn macos_dead_or_unknown_process_states_cannot_authenticate_sigkill_escalation() {
        for stat in ["", "Z", "Z+", "?"] {
            assert!(
                !macos_process_state_allows_escalation(stat),
                "dead state {stat:?} must not authenticate escalation"
            );
        }
    }

    #[test]
    fn macos_exiting_process_states_cannot_authenticate_sigkill_escalation() {
        for stat in ["SE", "UEs"] {
            assert!(
                !macos_process_state_allows_escalation(stat),
                "exiting state {stat} must not authenticate escalation"
            );
        }
    }

    #[cfg(unix)]
    #[test]
    fn cancellation_does_not_signal_an_unverified_group_after_leader_exit() {
        use std::io::Write;

        struct ProcessGroupGuard(i32);
        impl Drop for ProcessGroupGuard {
            fn drop(&mut self) {
                // SAFETY: this test created the isolated process group.
                unsafe {
                    libc::kill(-self.0, libc::SIGKILL);
                }
            }
        }

        let ready_dir = tempfile::tempdir().expect("ready directory");
        let ready_path = ready_dir.path().join("hup-resistant-child-ready");
        let mut command = openbitfun_services_core::process_manager::create_command("/bin/sh");
        command
            .arg("-c")
            // Keep the leader alive until the child has installed its HUP
            // disposition; exiting immediately races child startup on macOS.
            .arg(
                "trap '' HUP; \
                 sh -c 'trap \"\" HUP; printf ready > \"$OPENBITFUN_DISPATCH_HUP_TEST_READY\"; \
                 exec sleep 30' & \
                 read release",
            )
            .env("OPENBITFUN_DISPATCH_HUP_TEST_READY", &ready_path)
            .stdin(Stdio::piped())
            .stdout(Stdio::null())
            .stderr(Stdio::null());
        configure_detached_process(&mut command);
        let mut leader = command.spawn().expect("spawn process-group leader");
        let process_group = i32::try_from(leader.id()).expect("safe pid");
        let _guard = ProcessGroupGuard(process_group);
        for _ in 0..100 {
            if ready_path.is_file() {
                break;
            }
            std::thread::sleep(Duration::from_millis(10));
        }
        assert!(
            ready_path.is_file(),
            "HUP-resistant child must be ready before the leader exits"
        );
        leader
            .stdin
            .take()
            .expect("leader release pipe")
            .write_all(b"release\n")
            .expect("release process-group leader");
        leader.wait().expect("reap process-group leader");
        assert!(!process_alive(process_group as u32));
        assert!(process_group_alive(process_group));

        let error = terminate_worker(process_group as u32, "leader-already-exited")
            .expect_err("an absent leader cannot authenticate the remaining process group");
        assert!(error.to_string().contains("refusing to signal"));
        assert!(error.to_string().contains("PGID may have been reused"));
        assert!(
            process_group_alive(process_group),
            "the fail-safe path must not signal an unverified process group"
        );
    }

    #[cfg(unix)]
    #[test]
    fn cancellation_does_not_escalate_after_term_exits_the_verified_leader() {
        struct ProcessGroupGuard(i32);
        impl Drop for ProcessGroupGuard {
            fn drop(&mut self) {
                // SAFETY: this test created the isolated process group.
                unsafe {
                    libc::kill(-self.0, libc::SIGKILL);
                }
            }
        }

        let job_id = "leader-exits-after-term";
        let ready_dir = tempfile::tempdir().expect("ready directory");
        let ready_path = ready_dir.path().join("term-resistant-child-ready");
        let mut command = Command::new("/bin/sh");
        command
            .arg("-c")
            // Keep the leader in the shell's `wait` builtin so TERM runs its
            // trap immediately; an external `sleep` can defer trap handling.
            .arg(
                "trap 'exit 0' TERM; trap '' HUP; \
                 sh -c 'trap \"\" TERM HUP; printf ready > \"$OPENBITFUN_DISPATCH_TERM_TEST_READY\"; \
                 while :; do sleep 30; done' & \
                 wait",
            )
            // These trailing arguments make the real process identity match
            // the hidden worker contract without launching OpenBitFun Runtime.
            .args(["dispatch", "__run", "--job", job_id])
            .env("OPENBITFUN_DISPATCH_TERM_TEST_READY", &ready_path)
            .stdin(Stdio::null())
            .stdout(Stdio::null())
            .stderr(Stdio::null());
        configure_detached_process(&mut command);
        let mut leader = command.spawn().expect("spawn process-group leader");
        let process_group = i32::try_from(leader.id()).expect("safe pid");
        let _guard = ProcessGroupGuard(process_group);
        for _ in 0..100 {
            if ready_path.is_file() {
                break;
            }
            std::thread::sleep(Duration::from_millis(10));
        }
        assert!(
            ready_path.is_file(),
            "TERM-resistant child must be ready before cancellation"
        );
        assert!(worker_process_alive(process_group as u32, job_id));
        let reaper = std::thread::spawn(move || leader.wait());

        let error = terminate_worker(process_group as u32, job_id)
            .expect_err("SIGKILL must not follow a vanished leader");
        assert!(error.to_string().contains("exited after SIGTERM"));
        assert!(error.to_string().contains("refusing to signal"));
        assert!(
            process_group_alive(process_group),
            "the TERM-resistant child proves SIGKILL was not sent"
        );
        reaper
            .join()
            .expect("join leader reaper")
            .expect("reap process-group leader");
    }
}
