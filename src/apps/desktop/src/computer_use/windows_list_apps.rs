//! Enumerate running desktop applications on Windows.
//!
//! Mirrors the cua-driver-rs window enumeration model
//! (`platform-windows/src/win32/windows.rs` + `apps.rs`): walk `EnumWindows`
//! for every visible, non-minimized, titled top-level window, group by owning
//! pid, and resolve each pid's executable basename for the app name. This is
//! the Windows analogue of `macos_list_apps::list_running_apps` — a process
//! that has at least one visible top-level window is a "running app" the agent
//! can target.
//!
//! `QueryFullProcessImageNameW` / `OpenProcess` / `CloseHandle` are declared
//! via `extern "system"` (same convention as `windows_bg_input.rs`) so we do
//! not need to broaden the desktop crate's `windows` Cargo features.

#![cfg(target_os = "windows")]
#![allow(dead_code)]

use std::collections::HashMap;
use std::ffi::c_void;
use std::sync::Mutex;

use openbitfun_core::agentic::tools::computer_use_host::{AppInfo, AppWindowInfo};
use openbitfun_core::util::errors::OpenBitFunResult;
use windows::core::BOOL;
use windows::Win32::Foundation::{HWND, LPARAM, TRUE};
use windows::Win32::UI::WindowsAndMessaging::{
    EnumWindows, GetWindowTextLengthW, GetWindowTextW, GetWindowThreadProcessId, IsIconic,
    IsWindowVisible,
};

type Handle = *mut c_void;

const PROCESS_QUERY_LIMITED_INFORMATION: u32 = 0x1000;

#[link(name = "kernel32")]
extern "system" {
    fn OpenProcess(access: u32, inherit: i32, pid: u32) -> Handle;
    fn QueryFullProcessImageNameW(handle: Handle, flags: u32, buf: *mut u16, len: *mut u32) -> i32;
    fn CloseHandle(h: Handle) -> i32;
}

/// One visible top-level window discovered during enumeration.
struct WindowEntry {
    hwnd: usize,
    pid: u32,
    title: String,
}

struct EnumState {
    windows: Vec<WindowEntry>,
}

/// List running applications that own at least one visible, titled top-level
/// window, sorted by name. `include_hidden` is accepted for parity with the
/// macOS host; on Windows there is no per-app hidden flag, so every windowed
/// process is returned regardless.
pub(super) fn list_running_apps(_include_hidden: bool) -> OpenBitFunResult<Vec<AppInfo>> {
    let windows = enumerate_windows();

    // Group by pid: keep the first non-empty title as a fallback display name.
    let mut by_pid: HashMap<u32, String> = HashMap::new();
    for w in windows {
        by_pid.entry(w.pid).or_insert(w.title);
    }

    let mut apps: Vec<AppInfo> = Vec::with_capacity(by_pid.len());
    for (pid, fallback_title) in by_pid {
        let name = exe_basename_for_pid(pid)
            .map(|exe| strip_exe_suffix(&exe))
            .filter(|s| !s.is_empty())
            .unwrap_or_else(|| fallback_title.clone());
        apps.push(AppInfo {
            name,
            bundle_id: None,
            pid: Some(pid as i32),
            running: true,
            last_used_ms: None,
            launch_count: 0,
        });
    }

    sort_apps_by_name(&mut apps);
    Ok(apps)
}

pub(super) fn list_share_targets() -> Vec<openbitfun_agent_tools::computer_use_control::ShareTarget>
{
    enumerate_windows()
        .into_iter()
        .map(
            |window| openbitfun_agent_tools::computer_use_control::ShareTarget {
                selection_id: String::new(),
                unavailable_reason: None,
                id: format!("pid:{}/window:{}", window.pid, window.hwnd),
                pid: Some(window.pid as i32),
                window_id: Some(window.hwnd as u64),
                application: exe_basename_for_pid(window.pid)
                    .unwrap_or_else(|| window.title.clone()),
                title: window.title,
                bundle_id: None,
                background_pointer: true,
                background_semantic: true,
                selection_required: false,
            },
        )
        .collect()
}

/// Available visible, non-minimized titled top-level windows. Unlike the app
/// list this preserves every window of a process and its exact native handle.
pub(super) fn list_windows() -> Vec<AppWindowInfo> {
    enumerate_windows()
        .into_iter()
        .map(|window| AppWindowInfo {
            pid: window.pid as i32,
            window_id: window.hwnd as u64,
            application: exe_basename_for_pid(window.pid).unwrap_or_default(),
            title: window.title,
            bundle_id: None,
            is_on_screen: Some(true),
            bounds: super::windows_capture::window_bounds(HWND(window.hwnd as *mut c_void))
                .ok()
                .map(|[left, top, width, height]| {
                    openbitfun_core::agentic::tools::computer_use_host::ComputerUseImageGlobalBounds {
                        left,
                        top,
                        width,
                        height,
                    }
                }),
        })
        .collect()
}

fn sort_apps_by_name(apps: &mut [AppInfo]) {
    apps.sort_by_cached_key(|app| app.name.to_lowercase());
}

/// Choose an initial content window for a PID-only selector. Floating companions
/// precede content in EnumWindows order, so they must not win by order alone.
/// Explicit HWNDs and existing control bindings do not use this default.
pub(super) fn find_default_window_for_pid(pid: u32) -> Option<HWND> {
    use super::windows_window_target::{inspect_window, select_default_window};
    let candidates = enumerate_windows()
        .into_iter()
        .filter(|window| window.pid == pid)
        .map(|window| inspect_window(HWND(window.hwnd as *mut c_void)));
    select_default_window(pid, candidates).map(|handle| HWND(handle as *mut c_void))
}

fn enumerate_windows() -> Vec<WindowEntry> {
    let state = Mutex::new(EnumState {
        windows: Vec::new(),
    });
    let state_ptr = &state as *const Mutex<EnumState> as isize;
    unsafe {
        let _ = EnumWindows(Some(enum_windows_cb), LPARAM(state_ptr));
    }
    state.into_inner().unwrap().windows
}

unsafe extern "system" fn enum_windows_cb(hwnd: HWND, lparam: LPARAM) -> BOOL {
    // SAFETY: `lparam` points to the live `Mutex<EnumState>` supplied to the
    // synchronous `EnumWindows` call in `enumerate_windows`.
    let state = unsafe { &*(lparam.0 as *const Mutex<EnumState>) };

    // Skip invisible or minimized windows.
    if unsafe { IsWindowVisible(hwnd) }.0 == 0 || unsafe { IsIconic(hwnd) }.0 != 0 {
        return TRUE;
    }

    let title_len = unsafe { GetWindowTextLengthW(hwnd) };
    if title_len == 0 {
        return TRUE;
    }
    let mut buf = vec![0u16; (title_len + 1) as usize];
    let n = unsafe { GetWindowTextW(hwnd, &mut buf) };
    let title = {
        let len = (n as usize).min(buf.len());
        String::from_utf16_lossy(&buf[..len])
    };
    if title.trim().is_empty() {
        return TRUE;
    }

    let mut pid: u32 = 0;
    unsafe { GetWindowThreadProcessId(hwnd, Some(&mut pid)) };
    if pid == 0 {
        return TRUE;
    }

    if let Ok(mut s) = state.lock() {
        s.windows.push(WindowEntry {
            hwnd: hwnd.0 as usize,
            pid,
            title,
        });
    }
    TRUE
}

/// Resolve the full image path of `pid` and return its `.exe` basename.
pub(super) fn exe_basename_for_pid(pid: u32) -> Option<String> {
    let handle = unsafe { OpenProcess(PROCESS_QUERY_LIMITED_INFORMATION, 0, pid) };
    if handle.is_null() {
        return None;
    }
    let mut buf = [0u16; 1024];
    let mut len: u32 = buf.len() as u32;
    let ok = unsafe { QueryFullProcessImageNameW(handle, 0, buf.as_mut_ptr(), &mut len) } != 0;
    unsafe {
        CloseHandle(handle);
    }
    if !ok || len == 0 {
        return None;
    }
    let path = String::from_utf16_lossy(&buf[..len as usize]);
    let name = path.rsplit(['\\', '/']).next().unwrap_or(&path).to_string();
    if name.is_empty() {
        None
    } else {
        Some(name)
    }
}

/// Strip a trailing `.exe` (case-insensitive) from an executable basename so
/// the app name reads as `notepad` rather than `notepad.exe`.
fn strip_exe_suffix(basename: &str) -> String {
    if let Some(stripped) = basename
        .strip_suffix(".exe")
        .or_else(|| basename.strip_suffix(".EXE"))
    {
        stripped.to_string()
    } else {
        basename.to_string()
    }
}

#[cfg(test)]
#[path = "windows_window_target_tests.rs"]
mod native_target_tests;

#[cfg(test)]
mod tests {
    use super::*;

    fn app(name: &str, pid: i32) -> AppInfo {
        AppInfo {
            name: name.to_string(),
            bundle_id: None,
            pid: Some(pid),
            running: true,
            last_used_ms: None,
            launch_count: 0,
        }
    }

    #[test]
    fn app_name_sort_is_case_insensitive_ascending_and_stable() {
        let mut apps = vec![app("beta", 1), app("ALPHA", 2), app("Beta", 3)];

        sort_apps_by_name(&mut apps);

        assert_eq!(
            apps.iter().map(|app| app.pid).collect::<Vec<_>>(),
            [Some(2), Some(1), Some(3)]
        );
    }
}
