//! Native process lifetime and executable identity for revocable sharing.
//! Adapted from computer-use-rust/native/macos.rs; equivalent native identities
//! are used on Windows and Linux instead of treating a recycled PID as an app.
use std::{
    path::PathBuf,
    time::{Duration, SystemTime, UNIX_EPOCH},
};

#[derive(Debug, Clone, PartialEq, Eq)]
pub(crate) struct ProcessIdentity {
    pub(crate) pid: i32,
    pub(crate) executable: PathBuf,
    pub(crate) started: SystemTime,
    pub(crate) bundle_id: Option<String>,
    lifetime: u64,
}

impl ProcessIdentity {
    pub(crate) fn read(pid: i32) -> Result<Self, String> {
        if pid <= 0 {
            return Err("[PROCESS_IDENTITY_UNAVAILABLE] Invalid process ID".into());
        }
        native_read(pid)
    }
    pub(crate) fn validate(&self) -> Result<(), String> {
        if Self::read(self.pid).as_ref() != Ok(self) {
            return Err("[STALE_PROCESS] Shared application exited or its process/executable identity changed; select it again".into());
        }
        Ok(())
    }
}

#[cfg(target_os = "macos")]
fn native_read(pid: i32) -> Result<ProcessIdentity, String> {
    use std::os::unix::ffi::OsStringExt;
    #[repr(C)]
    #[derive(Default)]
    struct BsdInfo {
        flags: u32,
        status: u32,
        xstatus: u32,
        pid: u32,
        ppid: u32,
        uid: u32,
        gid: u32,
        ruid: u32,
        rgid: u32,
        svuid: u32,
        svgid: u32,
        rfu: u32,
        comm: [u8; 16],
        name: [u8; 32],
        nfiles: u32,
        pgid: u32,
        pjobc: u32,
        tdev: u32,
        tpgid: u32,
        nice: i32,
        start_sec: u64,
        start_usec: u64,
    }
    unsafe extern "C" {
        fn proc_pidinfo(
            pid: i32,
            flavor: i32,
            arg: u64,
            buffer: *mut std::ffi::c_void,
            size: i32,
        ) -> i32;
        fn proc_pidpath(pid: i32, buffer: *mut std::ffi::c_void, size: u32) -> i32;
    }
    let mut info = BsdInfo::default();
    let size = std::mem::size_of::<BsdInfo>() as i32;
    if unsafe { proc_pidinfo(pid, 3, 0, (&mut info as *mut BsdInfo).cast(), size) } != size
        || info.pid != pid as u32
        || info.status == 5
        || info.start_usec >= 1_000_000
    {
        return Err(
            "[PROCESS_IDENTITY_UNAVAILABLE] Cannot read the live process start time".into(),
        );
    }
    let mut path = [0u8; 4096];
    if unsafe { proc_pidpath(pid, path.as_mut_ptr().cast(), path.len() as u32) } <= 0 {
        return Err("[PROCESS_IDENTITY_UNAVAILABLE] Cannot read the live executable path".into());
    }
    let length = path
        .iter()
        .position(|byte| *byte == 0)
        .ok_or("[PROCESS_IDENTITY_UNAVAILABLE] Truncated executable path")?;
    let started = UNIX_EPOCH
        .checked_add(Duration::from_secs(info.start_sec))
        .and_then(|time| time.checked_add(Duration::from_micros(info.start_usec)))
        .ok_or("[PROCESS_IDENTITY_UNAVAILABLE] Invalid process start time")?;
    Ok(ProcessIdentity {
        pid,
        executable: std::ffi::OsString::from_vec(path[..length].to_vec()).into(),
        started,
        bundle_id: objc2_app_kit::NSWorkspace::sharedWorkspace()
            .runningApplications()
            .iter()
            .find(|app| app.processIdentifier() == pid)
            .and_then(|app| app.bundleIdentifier())
            .map(|id| id.to_string()),
        lifetime: info
            .start_sec
            .wrapping_mul(1_000_000)
            .wrapping_add(info.start_usec),
    })
}

#[cfg(target_os = "windows")]
fn native_read(pid: i32) -> Result<ProcessIdentity, String> {
    use windows::Win32::{
        Foundation::{CloseHandle, FILETIME},
        System::Threading::{
            GetProcessTimes, OpenProcess, QueryFullProcessImageNameW, PROCESS_NAME_WIN32,
            PROCESS_QUERY_LIMITED_INFORMATION,
        },
    };
    let handle = unsafe { OpenProcess(PROCESS_QUERY_LIMITED_INFORMATION, false, pid as u32) }
        .map_err(|error| format!("[PROCESS_IDENTITY_UNAVAILABLE] {error}"))?;
    struct Handle(windows::Win32::Foundation::HANDLE);
    impl Drop for Handle {
        fn drop(&mut self) {
            let _ = unsafe { CloseHandle(self.0) };
        }
    }
    let handle = Handle(handle);
    let mut creation = FILETIME::default();
    let mut exit = FILETIME::default();
    let mut kernel = FILETIME::default();
    let mut user = FILETIME::default();
    unsafe { GetProcessTimes(handle.0, &mut creation, &mut exit, &mut kernel, &mut user) }
        .map_err(|error| format!("[PROCESS_IDENTITY_UNAVAILABLE] {error}"))?;
    if exit.dwHighDateTime != 0 || exit.dwLowDateTime != 0 {
        return Err("[STALE_PROCESS] Application has exited".into());
    }
    let ticks = (u64::from(creation.dwHighDateTime) << 32) | u64::from(creation.dwLowDateTime);
    let unix_ticks = ticks
        .checked_sub(116_444_736_000_000_000)
        .ok_or("[PROCESS_IDENTITY_UNAVAILABLE] Invalid creation time")?;
    let mut path = vec![0u16; 32_768];
    let mut length = path.len() as u32;
    unsafe {
        QueryFullProcessImageNameW(
            handle.0,
            PROCESS_NAME_WIN32,
            windows::core::PWSTR(path.as_mut_ptr()),
            &mut length,
        )
    }
    .map_err(|error| format!("[PROCESS_IDENTITY_UNAVAILABLE] {error}"))?;
    use std::os::windows::ffi::OsStringExt;
    Ok(ProcessIdentity {
        pid,
        executable: std::ffi::OsString::from_wide(&path[..length as usize]).into(),
        bundle_id: None,
        started: UNIX_EPOCH
            + Duration::from_secs(unix_ticks / 10_000_000)
            + Duration::from_nanos((unix_ticks % 10_000_000) * 100),
        lifetime: ticks,
    })
}

#[cfg(target_os = "linux")]
fn native_read(pid: i32) -> Result<ProcessIdentity, String> {
    let failed = |error: std::io::Error| format!("[PROCESS_IDENTITY_UNAVAILABLE] {error}");
    let stat = std::fs::read_to_string(format!("/proc/{pid}/stat")).map_err(failed)?;
    let rest = stat
        .rsplit_once(") ")
        .ok_or("[PROCESS_IDENTITY_UNAVAILABLE] Invalid process record")?
        .1;
    let fields: Vec<_> = rest.split_ascii_whitespace().collect();
    if fields
        .first()
        .is_none_or(|state| matches!(*state, "Z" | "X"))
    {
        return Err("[STALE_PROCESS] Application is not live".into());
    }
    let ticks = fields
        .get(19)
        .and_then(|value| value.parse::<u64>().ok())
        .ok_or("[PROCESS_IDENTITY_UNAVAILABLE] Missing process start time")?;
    let hz = unsafe { libc::sysconf(libc::_SC_CLK_TCK) };
    if hz <= 0 {
        return Err("[PROCESS_IDENTITY_UNAVAILABLE] Cannot read the system clock rate".into());
    }
    let system = std::fs::read_to_string("/proc/stat").map_err(failed)?;
    let boot = system
        .lines()
        .find_map(|line| line.strip_prefix("btime "))
        .and_then(|value| value.trim().parse::<u64>().ok())
        .ok_or("[PROCESS_IDENTITY_UNAVAILABLE] Missing system boot time")?;
    let executable = std::fs::read_link(format!("/proc/{pid}/exe")).map_err(failed)?;
    Ok(ProcessIdentity {
        pid,
        executable,
        started: UNIX_EPOCH
            + Duration::from_secs(boot + ticks / hz as u64)
            + Duration::from_nanos((ticks % hz as u64) * 1_000_000_000 / hz as u64),
        lifetime: ticks,
        bundle_id: None,
    })
}

#[cfg(not(any(target_os = "macos", target_os = "windows", target_os = "linux")))]
fn native_read(_pid: i32) -> Result<ProcessIdentity, String> {
    Err("[PROCESS_IDENTITY_UNAVAILABLE] No native provider".into())
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn live_identity_is_stable_and_modified_lifetime_is_rejected() {
        let identity = ProcessIdentity::read(std::process::id() as i32).unwrap();
        assert!(identity.executable.is_absolute());
        identity.validate().unwrap();
        let mut changed = identity;
        changed.lifetime = changed.lifetime.wrapping_add(1);
        assert!(changed.validate().is_err());
        assert!(ProcessIdentity::read(-1).is_err());
    }
}
