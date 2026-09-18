//! Hidden process creation and explicit host-lifetime containment.
//!
//! Host containment belongs to long-lived CLI/SDK services. Graceful cleanup
//! only closes managed child trees; it must never close a Job containing the
//! calling host before an updater, restart, or shutdown can finish.

use std::process::{Command, Stdio};
#[cfg(windows)]
use std::sync::LazyLock;
#[cfg(target_os = "macos")]
use std::sync::OnceLock;
use tokio::process::Command as TokioCommand;

#[cfg(windows)]
use log::warn;

#[cfg(windows)]
use std::sync::{Arc, Mutex};

#[cfg(windows)]
use std::os::windows::process::CommandExt;

#[cfg(windows)]
use win32job::Job;

#[cfg(windows)]
const CREATE_NO_WINDOW: u32 = 0x08000000;
#[cfg(windows)]
const CREATE_NEW_PROCESS_GROUP: u32 = 0x00000200;
#[cfg(windows)]
const CREATE_BREAKAWAY_FROM_JOB: u32 = 0x01000000;

#[cfg(windows)]
static GLOBAL_PROCESS_MANAGER: LazyLock<ProcessManager> = LazyLock::new(ProcessManager::new);

pub struct ProcessManager {
    #[cfg(windows)]
    job: Arc<Mutex<Option<Job>>>,
}

impl ProcessManager {
    #[cfg(windows)]
    fn new() -> Self {
        let manager = Self {
            #[cfg(windows)]
            job: Arc::new(Mutex::new(None)),
        };

        #[cfg(windows)]
        {
            if let Err(e) = manager.initialize_job() {
                warn!("Failed to initialize Windows Job object: {}", e);
            }
        }

        manager
    }

    #[cfg(windows)]
    fn initialize_job(&self) -> Result<(), Box<dyn std::error::Error>> {
        use win32job::{ExtendedLimitInfo, Job};

        let job = Job::create()?;

        // Terminate all child processes when the Job closes
        let mut info = ExtendedLimitInfo::new();
        info.limit_kill_on_job_close();
        job.set_extended_limit_info(&info)?;
        allow_explicit_job_breakaway(&job)?;

        // Assign current process to Job so child processes inherit automatically
        job.assign_current_process()?;

        let mut job_guard = self.job.lock().map_err(|e| {
            std::io::Error::other(format!("Failed to lock process manager job mutex: {}", e))
        })?;
        *job_guard = Some(job);

        Ok(())
    }

    pub fn cleanup_all(&self) {
        crate::process_tree::cleanup_all_process_trees();
    }
}

#[cfg(windows)]
fn allow_explicit_job_breakaway(job: &Job) -> Result<(), Box<dyn std::error::Error>> {
    use std::ffi::c_void;
    use std::mem::size_of;
    use windows::Win32::Foundation::HANDLE;
    use windows::Win32::System::JobObjects::{
        JobObjectExtendedLimitInformation, QueryInformationJobObject, SetInformationJobObject,
        JOBOBJECT_EXTENDED_LIMIT_INFORMATION, JOB_OBJECT_LIMIT_BREAKAWAY_OK,
    };

    let handle = HANDLE(job.handle() as *mut c_void);
    let mut info = JOBOBJECT_EXTENDED_LIMIT_INFORMATION::default();
    // SAFETY: `job` owns a live Job handle and `info` is a correctly sized,
    // writable buffer for the requested information class.
    unsafe {
        QueryInformationJobObject(
            Some(handle),
            JobObjectExtendedLimitInformation,
            &mut info as *mut _ as *mut c_void,
            size_of::<JOBOBJECT_EXTENDED_LIMIT_INFORMATION>() as u32,
            None,
        )?;
    }
    info.BasicLimitInformation.LimitFlags |= JOB_OBJECT_LIMIT_BREAKAWAY_OK;
    // SAFETY: the same live Job handle and initialized information buffer are
    // passed with their exact byte size.
    unsafe {
        SetInformationJobObject(
            handle,
            JobObjectExtendedLimitInformation,
            &info as *const _ as *const c_void,
            size_of::<JOBOBJECT_EXTENDED_LIMIT_INFORMATION>() as u32,
        )?;
    }
    Ok(())
}

/// Create synchronous Command (Windows automatically adds CREATE_NO_WINDOW)
pub fn create_command<S: AsRef<std::ffi::OsStr>>(program: S) -> Command {
    let cmd = Command::new(program.as_ref());

    #[cfg(windows)]
    {
        let mut cmd = cmd;
        cmd.creation_flags(CREATE_NO_WINDOW);
        cmd
    }

    #[cfg(not(windows))]
    cmd
}

/// Create Tokio async Command (Windows automatically adds CREATE_NO_WINDOW)
pub fn create_tokio_command<S: AsRef<std::ffi::OsStr>>(program: S) -> TokioCommand {
    let cmd = TokioCommand::new(program.as_ref());

    #[cfg(target_os = "macos")]
    {
        let mut cmd = cmd;
        apply_cached_macos_path(&mut cmd);
        cmd
    }

    #[cfg(windows)]
    {
        let mut cmd = cmd;
        cmd.creation_flags(CREATE_NO_WINDOW);
        cmd
    }

    #[cfg(not(any(target_os = "macos", windows)))]
    cmd
}

/// Create a command that must survive the current GUI process exiting.
///
/// This is reserved for signed, product-owned process handoffs such as the
/// offline Data Migrator and the trusted main-app restart. Callers must resolve
/// the executable from an authenticated installation boundary; this helper
/// only supplies lifecycle and no-console-window behavior.
pub fn create_detached_command<S: AsRef<std::ffi::OsStr>>(program: S) -> Command {
    #[cfg_attr(not(windows), allow(unused_mut))]
    let mut command = create_handoff_command(program);

    #[cfg(windows)]
    command.creation_flags(detached_creation_flags());

    command
}

/// Create a hidden Windows handoff process group without requesting Job
/// breakaway.
///
/// The child keeps the caller's Job association when one exists. This is a
/// development-only fallback for hosts whose outer Job rejects explicit
/// breakaway; callers must not treat it as equivalent to a detached handoff.
#[cfg(windows)]
pub fn create_inherited_job_process_group_command<S: AsRef<std::ffi::OsStr>>(
    program: S,
) -> Command {
    let mut command = create_handoff_command(program);
    command.creation_flags(inherited_job_process_group_creation_flags());
    command
}

fn create_handoff_command<S: AsRef<std::ffi::OsStr>>(program: S) -> Command {
    let mut command = Command::new(program.as_ref());
    command
        .stdin(Stdio::null())
        .stdout(Stdio::null())
        .stderr(Stdio::null());
    command
}

#[cfg(windows)]
const fn detached_creation_flags() -> u32 {
    CREATE_NO_WINDOW | CREATE_NEW_PROCESS_GROUP | CREATE_BREAKAWAY_FROM_JOB
}

#[cfg(windows)]
const fn inherited_job_process_group_creation_flags() -> u32 {
    CREATE_NO_WINDOW | CREATE_NEW_PROCESS_GROUP
}

#[cfg(target_os = "macos")]
fn apply_cached_macos_path(cmd: &mut TokioCommand) {
    if let Some(path) = cached_macos_path_env() {
        cmd.env("PATH", path);
    }
}

#[cfg(target_os = "macos")]
fn cached_macos_path_env() -> Option<&'static std::ffi::OsString> {
    static MACOS_PATH_ENV: OnceLock<Option<std::ffi::OsString>> = OnceLock::new();
    MACOS_PATH_ENV.get_or_init(build_macos_path_env).as_ref()
}

#[cfg(target_os = "macos")]
fn build_macos_path_env() -> Option<std::ffi::OsString> {
    let existing_path = std::env::var_os("PATH");
    let mut entries = Vec::new();
    if let Some(path) = existing_path {
        entries.extend(std::env::split_paths(&path));
    }
    entries.extend(crate::system::platform_path_entries());

    if entries.is_empty() {
        return None;
    }

    let mut merged = Vec::new();
    let mut seen = std::collections::HashSet::new();
    for path in entries {
        if path.as_os_str().is_empty() {
            continue;
        }
        let key = path.to_string_lossy().to_string();
        if seen.insert(key) {
            merged.push(path);
        }
    }

    std::env::join_paths(merged).ok()
}

/// Stop managed child trees without creating or closing host containment.
/// Safe to call repeatedly, including when no child process was ever started.
pub fn cleanup_all_processes() {
    // Accessing the lazy host manager here would assign this process to a Job
    // for the first time during Desktop exit. Keep that initialization exclusive
    // to contain_current_process_tree(), and keep its handle alive until exit.
    crate::process_tree::cleanup_all_process_trees();
}

/// Keep descendants of a long-lived service in the process-wide Job until the
/// host exits. This lifetime guard is independent of managed-child cleanup.
pub fn contain_current_process_tree() -> std::io::Result<()> {
    #[cfg(windows)]
    if GLOBAL_PROCESS_MANAGER
        .job
        .lock()
        .map_err(|error| std::io::Error::other(error.to_string()))?
        .is_none()
    {
        return Err(std::io::Error::other("Windows process Job is unavailable"));
    }
    Ok(())
}

#[cfg(all(test, windows))]
mod tests {
    use super::*;

    #[test]
    fn detached_handoff_is_hidden_and_can_leave_the_process_job() {
        let flags = detached_creation_flags();
        assert_ne!(flags & CREATE_NO_WINDOW, 0);
        assert_ne!(flags & CREATE_NEW_PROCESS_GROUP, 0);
        assert_ne!(flags & CREATE_BREAKAWAY_FROM_JOB, 0);
    }

    #[test]
    fn inherited_job_handoff_is_hidden_without_requesting_breakaway() {
        let flags = inherited_job_process_group_creation_flags();
        assert_ne!(flags & CREATE_NO_WINDOW, 0);
        assert_ne!(flags & CREATE_NEW_PROCESS_GROUP, 0);
        assert_eq!(flags & CREATE_BREAKAWAY_FROM_JOB, 0);
    }
}
