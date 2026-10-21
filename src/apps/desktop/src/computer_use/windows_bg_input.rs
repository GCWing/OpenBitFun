//! Windows background input — non-disruptive injection to background /
//! occluded windows.
//!
//! Two complementary paths, ported from cua-driver-rs v0.6.8
//! (`platform-windows/src/input/{mouse,keyboard,inject,mod}.rs`):
//!
//! 1. **`PostMessageW` path** (`post_click` / `post_key` /
//!    `post_char`): posts `WM_*BUTTON` / `WM_KEYDOWN` / `WM_KEYUP` / `WM_CHAR`
//!    to the **deepest child** HWND at the click point. Invisible and never
//!    raises the target — no `SetForegroundWindow`, no cursor movement. Works
//!    for classic Win32 edit controls and standard message-loop apps.
//!
//! Targets requiring system keyboard input return `foreground_required` from
//! the former cloaked entry points. A hidden focus switch still interrupts the
//! user's keyboard and is never a background operation.
//!
//! Posted-message success means dispatch only, not observed application effect.
//! The host must observe the target before reporting a verified outcome.

// This whole module is only compiled on Windows (gated at the `mod` declaration
// in `mod.rs`). The inner `cfg` keeps the file self-documenting and robust if
// that declaration is ever moved.
#![cfg(target_os = "windows")]
// Symbols here are wired up by the desktop host / ControlHub dispatch layer in a
// follow-up step. Until then, suppress dead-code lints without weakening real
// warnings elsewhere.
#![allow(dead_code)]

use std::ffi::c_void;
use std::thread::sleep;
use std::time::Duration;

use openbitfun_core::util::errors::{OpenBitFunError, OpenBitFunResult};
use windows::Win32::Foundation::{HWND, LPARAM, POINT, WPARAM};
use windows::Win32::Graphics::Gdi::{ClientToScreen, ScreenToClient};
use windows::Win32::UI::WindowsAndMessaging::{
    ChildWindowFromPointEx, GetClassNameW, GetWindowThreadProcessId, IsChild, PostMessageW,
    WindowFromPoint, CWP_SKIPDISABLED, CWP_SKIPINVISIBLE, CWP_SKIPTRANSPARENT, SB_LINEDOWN,
    SB_LINELEFT, SB_LINERIGHT, SB_LINEUP, WM_CHAR, WM_HSCROLL, WM_KEYDOWN, WM_KEYUP,
    WM_LBUTTONDOWN, WM_LBUTTONUP, WM_MBUTTONDOWN, WM_MBUTTONUP, WM_MOUSEMOVE, WM_RBUTTONDOWN,
    WM_RBUTTONUP, WM_VSCROLL,
};

// ── raw Win32 FFI ───────────────────────────────────────────────────────────
//
// The desktop crate enables `Win32_Foundation`, `Win32_Graphics_Dwm`,
// `Win32_Graphics_Gdi`, `Win32_System_Com`, `Win32_UI_Accessibility`, and
// `Win32_UI_WindowsAndMessaging` — but NOT `Win32_UI_Input_KeyboardAndMouse`
// (`SendInput` / `INPUT` / `KEYBDINPUT`), `Win32_System_Threading`
// (`AttachThreadInput` / `GetCurrentThreadId` / process queries), or
// `Win32_Security` (token / integrity queries for the UIPI check). Rather than
// broaden the Cargo feature set, we declare those entry points here via
// `extern "system"` (stdcall on x86, C on x64 — the ABI the `windows` crate
// itself uses) and mirror the exact C ABI. Struct layouts are `#[repr(C)]`, so
// Rust matches the platform's C layout; `cbSize` is computed with `size_of` so
// it is correct on both 32- and 64-bit.

/// Opaque Win32 `HANDLE` (`void*`). Pointer-sized; pseudo-handles such as the
/// `GetCurrentProcess()` sentinel (`-1`) are passed through as raw pointer
/// values.
type Handle = *mut c_void;

/// `INPUT` type tag for keyboard events (winuser.h `INPUT_KEYBOARD`).
const INPUT_KEYBOARD: u32 = 1;
const KEYEVENTF_UNICODE: u32 = 0x0004;
const KEYEVENTF_KEYUP: u32 = 0x0002;
/// `MapVirtualKeyW` translation mode: virtual-key code → scan code.
const MAPVK_VK_TO_VSC: u32 = 0;
/// `VK_CONTROL` — used to poke the foreground lock (not currently needed, kept
/// for parity with cua-driver-rs `foreground_unlock_keypoke`).
#[allow(dead_code)]
const VK_CONTROL: u16 = 0x11;

/// `WS_EX_NOREDIRECTIONBITMAP` (0x00200000): the window has no GDI redirection
/// surface, i.e. it is composited via DirectComposition. Strong signal that
/// `PostMessage` WM_*BUTTON won't reach it.
const WS_EX_NOREDIRECTIONBITMAP: usize = 0x0020_0000;
/// `GWL_EXSTYLE` index for `GetWindowLongPtrW`.
const GWL_EXSTYLE: i32 = -20;
/// `WM_USER` (0x0400): UIPI only filters messages below this cutoff from a
/// lower-integrity sender to a higher-integrity target; app-defined messages
/// at or above `WM_USER` pass regardless of integrity.
const WM_USER_CUTOFF: u32 = 0x0400;

// Token / integrity level constants (winnt.h).
const TOKEN_QUERY: u32 = 0x0008;
/// `TOKEN_INFORMATION_CLASS::TokenIntegrityLevel` == 25.
const TOKEN_INTEGRITY_LEVEL_CLASS: u32 = 25;
const PROCESS_QUERY_LIMITED_INFORMATION: u32 = 0x1000;

/// Windows mandatory integrity-level RIDs (the last sub-authority of the
/// integrity SID). Higher = more privileged.
mod il {
    pub(super) const UNTRUSTED: u32 = 0x0000;
    pub(super) const LOW: u32 = 0x1000;
    pub(super) const MEDIUM: u32 = 0x2000;
    pub(super) const MEDIUM_PLUS: u32 = 0x2100;
    pub(super) const HIGH: u32 = 0x3000;
    pub(super) const SYSTEM: u32 = 0x4000;
}

fn il_name(rid: u32) -> &'static str {
    match rid {
        il::UNTRUSTED => "Untrusted",
        il::LOW => "Low",
        il::MEDIUM => "Medium",
        il::MEDIUM_PLUS => "Medium+",
        il::HIGH => "High",
        il::SYSTEM => "System",
        _ => "unknown",
    }
}

// ── SendInput structures (winuser.h) ────────────────────────────────────────

#[repr(C)]
#[derive(Clone, Copy)]
struct KeybdInput {
    wVk: u16,
    wScan: u16,
    dwFlags: u32,
    time: u32,
    dwExtraInfo: usize,
}

#[repr(C)]
#[derive(Clone, Copy)]
struct MouseInput {
    dx: i32,
    dy: i32,
    mouseData: u32,
    dwFlags: u32,
    time: u32,
    dwExtraInfo: usize,
}

#[repr(C)]
#[derive(Clone, Copy)]
struct HardwareInput {
    uMsg: u32,
    wParamL: u16,
    wParamH: u16,
}

/// Anonymous union of `INPUT` (`mi` / `ki` / `hi`). `#[repr(C)]` union over
/// `Copy` fields — matches the C layout the `windows` crate generates.
#[repr(C)]
#[derive(Clone, Copy)]
union INPUT_0 {
    ki: KeybdInput,
    mi: MouseInput,
    hi: HardwareInput,
}

#[repr(C)]
#[derive(Clone, Copy)]
struct Input {
    r#type: u32,
    Anonymous: INPUT_0,
}

// `SID_AND_ATTRIBUTES` / `TOKEN_MANDATORY_LABEL` (winnt.h) for the UIPI check.
#[repr(C)]
struct SID_AND_ATTRIBUTES {
    sid: *mut c_void,
    attributes: u32,
}

#[repr(C)]
struct TOKEN_MANDATORY_LABEL {
    label: SID_AND_ATTRIBUTES,
}

#[link(name = "user32")]
extern "system" {
    fn SendInput(c_inputs: u32, p_inputs: *const Input, cb_size: i32) -> u32;
    fn MapVirtualKeyW(code: u32, map_type: u32) -> u32;
    /// `VkKeyScanW` — translate a Unicode char to a virtual-key code + shift
    /// state. Declared here (rather than via the `windows` crate) to avoid
    /// enabling `Win32_UI_Input_KeyboardAndMouse`; the low byte of the return
    /// is the VK code, the high byte the shift state. Returns `-1` on failure.
    fn VkKeyScanW(ch: u16) -> i16;
    /// `GetWindowLongPtrW` — declared here (rather than via the `windows` crate)
    /// so we can pass `GWL_EXSTYLE` as a plain `i32` without depending on the
    /// `WINDOW_LONG_PTR_INDEX` newtype. `hwnd` is the raw pointer value of the
    /// `HWND` (`hwnd.0 as isize`).
    fn GetWindowLongPtrW(hwnd: isize, nindex: i32) -> isize;
}

#[link(name = "kernel32")]
extern "system" {
    fn GetCurrentProcess() -> Handle;
    fn OpenProcess(access: u32, inherit: i32, pid: u32) -> Handle;
    fn QueryFullProcessImageNameW(handle: Handle, flags: u32, buf: *mut u16, len: *mut u32) -> i32;
    fn CloseHandle(h: Handle) -> i32;
}

#[link(name = "advapi32")]
extern "system" {
    fn OpenProcessToken(handle: Handle, access: u32, token: *mut Handle) -> i32;
    fn GetTokenInformation(
        handle: Handle,
        class: u32,
        buf: *mut u8,
        len: u32,
        ret_len: *mut u32,
    ) -> i32;
    fn GetSidSubAuthorityCount(sid: *const c_void) -> *mut u8;
    fn GetSidSubAuthority(sid: *const c_void, index: u32) -> *mut u32;
}

/// Mouse-button key-state flags packed into WPARAM for WM_*BUTTON messages.
const MK_LBUTTON: u32 = 0x0001;
const MK_RBUTTON: u32 = 0x0002;
const MK_SHIFT: u32 = 0x0004;
const MK_CONTROL: u32 = 0x0008;
const MK_MBUTTON: u32 = 0x0010;

/// Translate modifier names into the `MK_*` key-state flags Win32 mouse
/// messages carry in their `WPARAM`. Only Shift and Control have an `MK_*`
/// representation — `WM_*BUTTON` messages have no bit for Alt or the Windows
/// key (those are not part of the mouse-message contract). Unsupported
/// modifier names are reported back to the caller so it can log them.
fn mk_flags_for_modifiers(modifier_keys: &[String]) -> (u32, Vec<String>) {
    let mut flags = 0u32;
    let mut unsupported = Vec::new();
    for m in modifier_keys {
        match m.to_lowercase().as_str() {
            "shift" => flags |= MK_SHIFT,
            "ctrl" | "control" => flags |= MK_CONTROL,
            other => unsupported.push(other.to_string()),
        }
    }
    (flags, unsupported)
}

/// Down → up hold time inside a single click (ms). Matches cua-driver-rs.
const CLICK_DELAY_MS: u64 = 35;
/// Gap between successive clicks in a multi-click (ms).
const MULTI_CLICK_DELAY_MS: u64 = 80;
/// Max depth when walking child windows to find the deepest descendant.
const DEEPEST_CHILD_MAX_DEPTH: usize = 16;

/// Walk from `root` down to the deepest visible, enabled, non-transparent
/// child window that contains the **screen** point `(sx, sy)`, mirroring
/// cua-driver-rs `DeepestChildFromScreenPoint`.
///
/// The OS is first asked which window is actually on top at the screen point
/// (`WindowFromPoint`, which respects z-order / occlusion). If that hit is
/// inside `root`'s subtree we descend from it; if `root` is occluded by another
/// app we still descend within `root`'s subtree — `PostMessage` targets the
/// per-window message queue, so it lands on a background window regardless of
/// what is visually on top. Descending to the deepest child avoids the
/// top-level window responding to `WM_LBUTTONDOWN` by activating itself
/// (focus-steal).
///
/// Returns `root` itself if no deeper child is found (or if `root` is invalid).
fn deepest_child(root: HWND, sx: i32, sy: i32) -> HWND {
    if root.is_invalid() {
        return root;
    }
    let screen_pt = POINT { x: sx, y: sy };

    // Real z-order hit-test at the screen point.
    let hit = unsafe { WindowFromPoint(screen_pt) };
    let start = if !hit.is_invalid() && unsafe { IsChild(root, hit) }.as_bool() {
        hit
    } else {
        root
    };

    // Descend through `ChildWindowFromPointEx` until we reach the leaf.
    let mut current = start;
    for _ in 0..DEEPEST_CHILD_MAX_DEPTH {
        let mut client = screen_pt;
        unsafe {
            let _ = ScreenToClient(current, &mut client);
        }
        let child = unsafe {
            ChildWindowFromPointEx(
                current,
                client,
                CWP_SKIPINVISIBLE | CWP_SKIPDISABLED | CWP_SKIPTRANSPARENT,
            )
        };
        // No deeper child, or same window — done.
        if child.is_invalid() || child == current {
            break;
        }
        current = child;
    }
    current
}

/// Post a mouse click at **client-area** coordinates `(x, y)` of `root` using
/// `PostMessageW`, routed to the deepest child HWND at the click point first.
///
/// The click is invisible: no `SetForegroundWindow`, no cursor movement. For
/// multi-click (`click_count > 1`) the down/up cycle repeats with a short gap
/// between clicks. `button` is `"left"`, `"right"`, or `"middle"` (any other
/// value defaults to left). Surfaces a `OpenBitFunError::Service` on
/// `PostMessageW` failure or a UIPI block.
fn post_click(
    root: HWND,
    x: i32,
    y: i32,
    button: &str,
    click_count: usize,
) -> OpenBitFunResult<()> {
    if root.is_invalid() {
        return Err(OpenBitFunError::service("post_click: invalid HWND"));
    }

    let (down_msg, up_msg, mk_flag) = match button {
        "right" => (WM_RBUTTONDOWN, WM_RBUTTONUP, MK_RBUTTON),
        "middle" => (WM_MBUTTONDOWN, WM_MBUTTONUP, MK_MBUTTON),
        _ => (WM_LBUTTONDOWN, WM_LBUTTONUP, MK_LBUTTON),
    };

    // root-local client → screen.
    let mut screen_pt = POINT { x, y };
    unsafe {
        let _ = ClientToScreen(root, &mut screen_pt);
    }

    // Resolve the deepest child at the screen point.
    let target = deepest_child(root, screen_pt.x, screen_pt.y);

    // UIPI check — a Medium-IL sender posting to a High-IL target is silently
    // dropped by the target's message pump (PostMessageW still returns OK).
    if let Some(uipi) = post_message_blocked_by_uipi(target, down_msg) {
        return Err(OpenBitFunError::service(uipi));
    }

    // screen → target-local client coordinates for the LPARAM.
    let mut client = screen_pt;
    unsafe {
        let _ = ScreenToClient(target, &mut client);
    }

    let lparam = make_lparam(client.x, client.y);
    let wdown = WPARAM(mk_flag as usize);
    let wup = WPARAM(0);

    for i in 0..click_count {
        // WM_MOUSEMOVE first so hover state is correct before the click.
        post_msg(target, WM_MOUSEMOVE, WPARAM(0), lparam)?;
        post_msg(target, down_msg, wdown, lparam)?;
        sleep(Duration::from_millis(CLICK_DELAY_MS));
        post_msg(target, up_msg, wup, lparam)?;
        if i + 1 < click_count {
            sleep(Duration::from_millis(MULTI_CLICK_DELAY_MS));
        }
    }
    Ok(())
}

/// Post a key event to `hwnd` via `PostMessageW`.
///
/// When `down` is `true` a `WM_KEYDOWN` is posted; when `false` a `WM_KEYUP`.
/// `vk` is the virtual-key code; `scan` is the hardware scan code (obtain via
/// `MapVirtualKeyW(vk, MAPVK_VK_TO_VSC)`). The LPARAM encodes the repeat count,
/// scan code, previous key state, and transition state per the Win32
/// `WM_KEYDOWN` / `WM_KEYUP` specification.
fn post_key(hwnd: HWND, vk: u16, scan: u32, down: bool) -> OpenBitFunResult<()> {
    if hwnd.is_invalid() {
        return Err(OpenBitFunError::service("post_key: invalid HWND"));
    }
    if let Some(uipi) = post_message_blocked_by_uipi(hwnd, WM_KEYDOWN) {
        return Err(OpenBitFunError::service(uipi));
    }
    let lparam = make_key_lparam(scan, down);
    let msg = if down { WM_KEYDOWN } else { WM_KEYUP };
    post_msg(hwnd, msg, WPARAM(vk as usize), lparam)
}

/// Post a Unicode character to `hwnd` as `WM_CHAR` via `PostMessageW`.
///
/// WPARAM carries the character's Unicode scalar value; LPARAM is the repeat
/// count (1). This is the simplest reliable text-entry path for Win32 edit
/// controls; richer XAML / WinUI3 / UWP targets may reject posted `WM_CHAR`
/// (their CoreInput dispatcher only consumes system-queue events) — use
/// [`inject_text_cloaked`] for those.
fn post_char(hwnd: HWND, ch: char) -> OpenBitFunResult<()> {
    if hwnd.is_invalid() {
        return Err(OpenBitFunError::service("post_char: invalid HWND"));
    }
    if let Some(uipi) = post_message_blocked_by_uipi(hwnd, WM_CHAR) {
        return Err(OpenBitFunError::service(uipi));
    }
    let code = ch as u32 as usize;
    post_msg(hwnd, WM_CHAR, WPARAM(code), LPARAM(1))
}

/// Compatibility entry point: cloaking never made foreground input safe.
/// Unsupported system-input targets require an explicitly authorized foreground
/// operation at the host boundary, not an invisible focus switch here.
pub(super) fn inject_text_cloaked(_hwnd: HWND, _text: &str) -> OpenBitFunResult<()> {
    Err(OpenBitFunError::service("foreground_required: this target requires system keyboard input; background text injection cannot steal focus"))
}

pub(super) fn inject_key_cloaked(
    _hwnd: HWND,
    _keycode: u16,
    _modifiers: &[u16],
) -> OpenBitFunResult<()> {
    Err(OpenBitFunError::service("foreground_required: this target requires system keyboard input; background key injection cannot steal focus"))
}

// ── UIPI integrity check ────────────────────────────────────────────────────

/// Read the mandatory integrity level (the last sub-authority of the integrity
/// SID) of a process handle. Returns `None` on any API failure.
///
/// # Safety
/// `process` must be a valid `HANDLE` (or the `GetCurrentProcess()` pseudo-
/// handle) with `TOKEN_QUERY` access for `OpenProcessToken` to succeed.
unsafe fn process_integrity_rid(process: Handle) -> Option<u32> {
    let mut token: Handle = std::ptr::null_mut();
    // SAFETY: the caller supplies a process handle valid for `TOKEN_QUERY`;
    // `token` is a live out-pointer for the duration of the call.
    if unsafe { OpenProcessToken(process, TOKEN_QUERY, &mut token) } == 0 {
        return None;
    }
    // Probe the required buffer size first (the first call always fails with
    // ERROR_INSUFFICIENT_BUFFER and writes `needed`).
    let mut needed: u32 = 0;
    unsafe {
        GetTokenInformation(
            token,
            TOKEN_INTEGRITY_LEVEL_CLASS,
            std::ptr::null_mut(),
            0,
            &mut needed,
        )
    };
    if needed == 0 {
        unsafe { CloseHandle(token) };
        return None;
    }
    let mut buf = vec![0u8; needed as usize];
    let ok = unsafe {
        GetTokenInformation(
            token,
            TOKEN_INTEGRITY_LEVEL_CLASS,
            buf.as_mut_ptr(),
            needed,
            &mut needed,
        )
    } != 0;
    unsafe { CloseHandle(token) };
    if !ok {
        return None;
    }
    // The buffer holds a TOKEN_MANDATORY_LABEL { SID_AND_ATTRIBUTES { Sid, Attr } }.
    // SAFETY: a successful `GetTokenInformation(TokenIntegrityLevel)` fills
    // `buf` with a `TOKEN_MANDATORY_LABEL` and a SID owned by that buffer.
    // `read_unaligned` avoids assuming that `Vec<u8>` has the struct's alignment.
    let tml = unsafe { (buf.as_ptr() as *const TOKEN_MANDATORY_LABEL).read_unaligned() };
    let sid = tml.label.sid as *const c_void;
    let count_ptr = unsafe { GetSidSubAuthorityCount(sid) };
    if count_ptr.is_null() {
        return None;
    }
    let count = unsafe { *count_ptr };
    if count == 0 {
        return None;
    }
    let rid_ptr = unsafe { GetSidSubAuthority(sid, (count - 1) as u32) };
    if rid_ptr.is_null() {
        return None;
    }
    Some(unsafe { *rid_ptr })
}

/// If posting `msg` from the current process to `hwnd` would be silently
/// blocked by UIPI (User Interface Privilege Isolation), return a diagnostic
/// string the caller should surface as an actionable error. Otherwise `None`.
///
/// UIPI blocks `PostMessage` / `SendMessage` of input-class messages
/// (`WM_KEYDOWN`, `WM_KEYUP`, `WM_CHAR`, `WM_LBUTTONDOWN`, … — everything below
/// `WM_USER`) from a lower-integrity process to a higher-integrity window.
/// Crucially, `PostMessage` still returns `TRUE` — the message is queued but
/// the elevated target's message pump filters it out before delivery. The
/// lower-integrity sender has no way to detect this from the return value, so
/// without this check `post_click` / `post_key` / `post_char` silently no-op
/// against elevated apps.
///
/// Messages at or above `WM_USER` are app-defined and not UIPI-filtered, so the
/// (relatively expensive) integrity comparison is skipped for them.
fn post_message_blocked_by_uipi(hwnd: HWND, msg: u32) -> Option<String> {
    // Only messages below WM_USER are subject to UIPI filtering.
    if msg >= WM_USER_CUTOFF {
        return None;
    }
    let mut pid: u32 = 0;
    if unsafe { GetWindowThreadProcessId(hwnd, Some(&mut pid)) } == 0 || pid == 0 {
        return None;
    }
    // SAFETY: `GetCurrentProcess` returns a pseudo-handle that is always valid.
    let own = unsafe { process_integrity_rid(GetCurrentProcess()) }?;
    // SAFETY: `PROCESS_QUERY_LIMITED_INFORMATION` is the minimal access needed
    // to read the target's integrity level; the handle is closed immediately.
    let target_handle = unsafe { OpenProcess(PROCESS_QUERY_LIMITED_INFORMATION, 0, pid) };
    if target_handle.is_null() {
        return None;
    }
    let target = unsafe { process_integrity_rid(target_handle) };
    unsafe {
        CloseHandle(target_handle);
    }
    let target = target?;
    if target > own {
        Some(format!(
            "UIPI: target hwnd 0x{:x} (pid {}) is at {} integrity; this process is at {} \
             integrity. PostMessage of msg 0x{:x} to a higher-integrity window is silently \
             dropped by the target's message pump — the call would return success but no input \
             would land. Common cause: a Win32 app whose manifest requests \
             `requireAdministrator` (most Program-Files installs of Notepad++, VS Code \
             system-scope, etc. land at High integrity). Run elevated to drive these, or use a \
             non-elevated copy of the target. See \
             https://learn.microsoft.com/en-us/windows/win32/winauto/uipi",
            hwnd.0 as usize,
            pid,
            il_name(target),
            il_name(own),
            msg,
        ))
    } else {
        None
    }
}

// ── UWP / DirectComposition heuristic ───────────────────────────────────────
//
// Two routing signals, OR'd (mirrors cua-driver-rs `is_xaml_host_hwnd`), plus a
// DirectComposition signal:
//   1. `WS_EX_NOREDIRECTIONBITMAP` — no GDI redirection surface ⇒ the window is
//      composited via DirectComposition (UWP/WinUI/Electron accelerated). A
//      posted `WM_*BUTTON` won't reach it.
//   2. Top-level window class name matches a known XAML host class.
//   3. Owning process `.exe` basename matches a known XAML/UWP-hosted `.exe`.

const XAML_HOST_CLASSES: &[&str] = &[
    "ApplicationFrameWindow",
    "WinUIDesktopWin32WindowClass",
    "Windows.UI.Core.CoreWindow",
    "Microsoft.UI.Content.DesktopChildSiteBridge",
];

const XAML_HOST_EXES: &[&str] = &[
    "notepad.exe",              // Win 11 modern Notepad (UWP-packaged)
    "calculatorapp.exe",        // UWP Calculator
    "calc.exe",                 // some Win 11 builds expose the stub directly
    "applicationframehost.exe", // generic UWP frame host
    "photos.exe",               // UWP Photos
    "systemsettings.exe",       // modern Settings
];

/// `true` when `hwnd` is likely a UWP / WinUI / DirectComposition-backed
/// surface where `PostMessage`-based input injection silently fails and a
/// coordinate-routed path (touch injection, or cloaked `SendInput`) is needed.
///
/// Combines three signals (any one is sufficient): the
/// `WS_EX_NOREDIRECTIONBITMAP` extended style (DirectComposition), a known
/// XAML/UWP host window class name, or a known XAML/UWP-packaged owning
/// process. The EXE-basename signal is the more reliable of the class/exe
/// pair: cross-session `GetClassNameW` can return nothing, and modern apps
/// like Win 11 Notepad keep the legacy `"Notepad"` class even though they
/// render XAML underneath.
fn is_probably_uwp_or_directcomposition(hwnd: HWND) -> bool {
    if hwnd.is_invalid() {
        return false;
    }

    // Signal 1: WS_EX_NOREDIRECTIONBITMAP (DirectComposition-backed surface).
    let exstyle = unsafe { GetWindowLongPtrW(hwnd.0 as isize, GWL_EXSTYLE) } as usize;
    if exstyle & WS_EX_NOREDIRECTIONBITMAP != 0 {
        log::debug!(
            "is_probably_uwp_or_directcomposition: hwnd=0x{:x} has WS_EX_NOREDIRECTIONBITMAP \
             (DirectComposition)",
            hwnd.0 as usize
        );
        return true;
    }

    // Signal 2: known XAML / UWP host window class name.
    if let Some(cls) = class_name(hwnd) {
        if XAML_HOST_CLASSES.iter().any(|known| cls == *known) {
            log::debug!(
                "is_probably_uwp_or_directcomposition: hwnd=0x{:x} class={cls:?} matches XAML \
                 host",
                hwnd.0 as usize
            );
            return true;
        }
    }

    // Signal 3: owning process is a known XAML/UWP-packaged app.
    if let Some(exe) = owning_exe_basename(hwnd) {
        if XAML_HOST_EXES.iter().any(|known| exe == *known) {
            log::debug!(
                "is_probably_uwp_or_directcomposition: hwnd=0x{:x} exe={exe:?} matches UWP host",
                hwnd.0 as usize
            );
            return true;
        }
    }

    false
}

fn class_name(hwnd: HWND) -> Option<String> {
    let mut buf = [0u16; 256];
    let n = unsafe { GetClassNameW(hwnd, &mut buf) };
    if n <= 0 {
        None
    } else {
        Some(String::from_utf16_lossy(&buf[..n as usize]))
    }
}

fn owning_exe_basename(hwnd: HWND) -> Option<String> {
    let mut pid: u32 = 0;
    let tid = unsafe { GetWindowThreadProcessId(hwnd, Some(&mut pid)) };
    if tid == 0 || pid == 0 {
        return None;
    }
    // SAFETY: `PROCESS_QUERY_LIMITED_INFORMATION` is the minimal access for
    // `QueryFullProcessImageNameW`; the handle is closed before returning.
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
    let name = path
        .rsplit(['\\', '/'])
        .next()
        .unwrap_or(&path)
        .to_ascii_lowercase();
    Some(name)
}

// ── internals ───────────────────────────────────────────────────────────────

/// Post a window message, converting the `windows` crate's `Error` into a
/// `OpenBitFunError`. Logged at `error` on failure.
fn post_msg(hwnd: HWND, msg: u32, wparam: WPARAM, lparam: LPARAM) -> OpenBitFunResult<()> {
    // Releases remain deliverable after cancellation so an interrupted gesture
    // does not leave the target with a held synthetic key/button.
    if !matches!(msg, WM_KEYUP | WM_LBUTTONUP | WM_RBUTTONUP | WM_MBUTTONUP) {
        crate::computer_use::control_session::input_allowed().map_err(OpenBitFunError::service)?;
        let root = unsafe {
            windows::Win32::UI::WindowsAndMessaging::GetAncestor(
                hwnd,
                windows::Win32::UI::WindowsAndMessaging::GA_ROOT,
            )
        };
        let mut pid = 0;
        unsafe {
            GetWindowThreadProcessId(root, Some(&mut pid));
        }
        crate::computer_use::control_session::target_allowed(&format!(
            "pid:{pid}/window:{}",
            root.0 as isize
        ))
        .map_err(OpenBitFunError::service)?;
    }
    unsafe {
        match PostMessageW(Some(hwnd), msg, wparam, lparam) {
            Ok(()) => Ok(()),
            Err(e) => {
                let name = message_name(msg);
                let err = OpenBitFunError::service(format!(
                    "PostMessageW({name}, hwnd=0x{:x}) failed: {e}",
                    hwnd.0 as usize
                ));
                log::error!("{err}");
                Err(err)
            }
        }
    }
}

/// Pack client coordinates into an LPARAM (low word = x, high word = y),
/// clamping to the i16 range that Win32 mouse-message LPARAMs expect.
fn make_lparam(x: i32, y: i32) -> LPARAM {
    let clamp = |v: i32| v.clamp(i16::MIN as i32, i16::MAX as i32) as u16;
    let packed = ((clamp(y) as u32) << 16) | (clamp(x) as u32);
    LPARAM(packed as isize)
}

/// Build the LPARAM for `WM_KEYDOWN` / `WM_KEYUP`.
///
/// Bits 0–15: repeat count (1). Bits 16–23: scan code. Bit 30: previous key
/// state (0 on a fresh keydown, 1 on keyup). Bit 31: transition state
/// (0 = keydown, 1 = keyup). Mirrors cua-driver-rs `post_enter_keystroke`.
fn make_key_lparam(scan: u32, down: bool) -> LPARAM {
    let base = 1u32 | ((scan & 0xFF) << 16);
    let lp = if down {
        base
    } else {
        base | (1u32 << 30) | (1u32 << 31)
    };
    LPARAM(lp as isize)
}

/// One `SendInput` keyboard event carrying a Unicode code unit (`KEYEVENTF_
/// UNICODE`). `up` adds `KEYEVENTF_KEYUP`.
fn unicode_event(unit: u16, up: bool) -> Input {
    let mut flags = KEYEVENTF_UNICODE;
    if up {
        flags |= KEYEVENTF_KEYUP;
    }
    Input {
        r#type: INPUT_KEYBOARD,
        Anonymous: INPUT_0 {
            ki: KeybdInput {
                wVk: 0,
                wScan: unit,
                dwFlags: flags,
                time: 0,
                dwExtraInfo: 0,
            },
        },
    }
}

/// One `SendInput` keyboard event for a virtual-key code. `up` adds
/// `KEYEVENTF_KEYUP`.
fn vk_event(vk: u16, scan: u32, up: bool) -> Input {
    let flags = if up { KEYEVENTF_KEYUP } else { 0 };
    Input {
        r#type: INPUT_KEYBOARD,
        Anonymous: INPUT_0 {
            ki: KeybdInput {
                wVk: vk,
                wScan: scan as u16,
                dwFlags: flags,
                time: 0,
                dwExtraInfo: 0,
            },
        },
    }
}

/// Deliver `text` as genuine `KEYEVENTF_UNICODE` down/up pairs via `SendInput`.
///
/// # Safety
/// `SendInput` reads `ev.len()` `INPUT` records from `ev.as_ptr()`; every
/// record is fully initialized above. `cbSize` is the true `size_of::<INPUT>`.
unsafe fn send_unicode(text: &str) -> OpenBitFunResult<()> {
    let mut ev: Vec<Input> = Vec::with_capacity(text.len() * 2);
    for u in text.encode_utf16() {
        ev.push(unicode_event(u, false));
        ev.push(unicode_event(u, true));
    }
    if ev.is_empty() {
        return Ok(());
    }
    let sent = unsafe {
        SendInput(
            ev.len() as u32,
            ev.as_ptr(),
            std::mem::size_of::<Input>() as i32,
        )
    };
    if sent as usize != ev.len() {
        return Err(OpenBitFunError::service(format!(
            "SendInput typed only {sent} of {} key events",
            ev.len()
        )));
    }
    Ok(())
}

/// Deliver a key + modifiers as a single `SendInput` burst: modifiers down,
/// key down, key up, modifiers up (reverse).
///
/// # Safety
/// `SendInput` reads a fully-initialized `INPUT` array; `cbSize` is correct.
unsafe fn send_key_combo(keycode: u16, modifiers: &[u16]) -> OpenBitFunResult<()> {
    let mut ev: Vec<Input> = Vec::with_capacity(modifiers.len() * 2 + 2);
    for &m in modifiers {
        // SAFETY: `MapVirtualKeyW` accepts every virtual-key value and has no
        // pointer or lifetime requirements.
        let m_scan = unsafe { MapVirtualKeyW(m as u32, MAPVK_VK_TO_VSC) };
        ev.push(vk_event(m, m_scan, false));
    }
    let scan = unsafe { MapVirtualKeyW(keycode as u32, MAPVK_VK_TO_VSC) };
    ev.push(vk_event(keycode, scan, false));
    ev.push(vk_event(keycode, scan, true));
    for &m in modifiers.iter().rev() {
        let m_scan = unsafe { MapVirtualKeyW(m as u32, MAPVK_VK_TO_VSC) };
        ev.push(vk_event(m, m_scan, true));
    }
    if ev.is_empty() {
        return Ok(());
    }
    let sent = unsafe {
        SendInput(
            ev.len() as u32,
            ev.as_ptr(),
            std::mem::size_of::<Input>() as i32,
        )
    };
    if sent as usize != ev.len() {
        return Err(OpenBitFunError::service(format!(
            "SendInput sent only {sent} of {} key events",
            ev.len()
        )));
    }
    Ok(())
}

/// Fallback for [`inject_key_cloaked`] when foreground can't be obtained: post
/// `WM_KEYDOWN` / `WM_KEYUP` to the window's queue (best-effort; may miss
/// `GetKeyState`-gated accelerators, but never drops the action).
fn send_key_combo_posted(hwnd: HWND, keycode: u16, modifiers: &[u16]) -> OpenBitFunResult<()> {
    for &m in modifiers {
        let scan = unsafe { MapVirtualKeyW(m as u32, MAPVK_VK_TO_VSC) };
        post_key(hwnd, m, scan, true)?;
    }
    let scan = unsafe { MapVirtualKeyW(keycode as u32, MAPVK_VK_TO_VSC) };
    post_key(hwnd, keycode, scan, true)?;
    post_key(hwnd, keycode, scan, false)?;
    for &m in modifiers.iter().rev() {
        let scan = unsafe { MapVirtualKeyW(m as u32, MAPVK_VK_TO_VSC) };
        post_key(hwnd, m, scan, false)?;
    }
    Ok(())
}

/// Human-readable name for a window message code, for log diagnostics.
fn message_name(msg: u32) -> &'static str {
    match msg {
        WM_LBUTTONDOWN => "WM_LBUTTONDOWN",
        WM_LBUTTONUP => "WM_LBUTTONUP",
        WM_RBUTTONDOWN => "WM_RBUTTONDOWN",
        WM_RBUTTONUP => "WM_RBUTTONUP",
        WM_MBUTTONDOWN => "WM_MBUTTONDOWN",
        WM_MBUTTONUP => "WM_MBUTTONUP",
        WM_MOUSEMOVE => "WM_MOUSEMOVE",
        WM_KEYDOWN => "WM_KEYDOWN",
        WM_KEYUP => "WM_KEYUP",
        WM_CHAR => "WM_CHAR",
        _ => "WM_UNKNOWN",
    }
}

// ── screen-coordinate click ─────────────────────────────────────────────────

/// Post a mouse click at **screen** coordinates `(sx, sy)`, resolving the
/// deepest child of `root` at that point and posting in the child's own client
/// coordinates. Mirrors cua-driver-rs `post_click_screen`.
///
/// [`post_click`] takes *root-local client* coordinates; the desktop host's
/// resolved targets (a node's `frame_global` center, an absolute `ScreenXy`,
/// an image-pixel point mapped to global) are all **screen** coordinates, so
/// this variant is the one the host wires up.
pub(super) fn post_click_screen(
    root: HWND,
    sx: i32,
    sy: i32,
    button: &str,
    click_count: usize,
    modifier_keys: &[String],
) -> OpenBitFunResult<()> {
    if root.is_invalid() {
        return Err(OpenBitFunError::service("post_click_screen: invalid HWND"));
    }
    let target = deepest_child(super::windows_overlay::pointer_root(root, sx, sy), sx, sy);
    let (down_msg, up_msg, mk_flag) = match button {
        "right" => (WM_RBUTTONDOWN, WM_RBUTTONUP, MK_RBUTTON),
        "middle" => (WM_MBUTTONDOWN, WM_MBUTTONUP, MK_MBUTTON),
        _ => (WM_LBUTTONDOWN, WM_LBUTTONUP, MK_LBUTTON),
    };
    if let Some(uipi) = post_message_blocked_by_uipi(target, down_msg) {
        return Err(OpenBitFunError::service(uipi));
    }
    let (mk_mods, unsupported) = mk_flags_for_modifiers(modifier_keys);
    if !unsupported.is_empty() {
        log::warn!(
            "post_click_screen: modifiers {unsupported:?} have no MK_* mouse-message flag on \
             Windows (only shift/control are carried in WM_*BUTTON WPARAM); they are ignored \
             for this click."
        );
    }
    // screen → target-local client coordinates for the LPARAM.
    let mut client = POINT { x: sx, y: sy };
    unsafe {
        let _ = ScreenToClient(target, &mut client);
    }
    let lparam = make_lparam(client.x, client.y);
    let wdown = WPARAM((mk_flag | mk_mods) as usize);
    let wup = WPARAM(mk_mods as usize);
    let count = click_count.max(1);
    for i in 0..count {
        post_msg(target, WM_MOUSEMOVE, WPARAM(mk_mods as usize), lparam)?;
        post_msg(target, down_msg, wdown, lparam)?;
        sleep(Duration::from_millis(CLICK_DELAY_MS));
        post_msg(target, up_msg, wup, lparam)?;
        if i + 1 < count {
            sleep(Duration::from_millis(MULTI_CLICK_DELAY_MS));
        }
    }
    Ok(())
}

// ── scroll ──────────────────────────────────────────────────────────────────

/// Convert a pixel-ish wheel delta to a count of line-scroll messages.
///
/// The desktop tool layer hands `app_scroll` pixel-style deltas (macOS uses
/// CGEvent pixel scrolls). Windows scrollbars step per **line**, so a raw
/// pixel delta of e.g. 120 must not turn into 120 `SB_LINEDOWN` messages.
/// Divide by an approximate line height (40 px) and clamp to a sane range.
fn delta_to_line_count(delta: i32) -> usize {
    let mag = delta.unsigned_abs();
    if mag == 0 {
        return 0;
    }
    ((mag as usize) / 40).clamp(1, 50)
}

/// Post line-granular scroll messages to the deepest child of `root` at the
/// **screen** point `(sx, sy)` via `WM_VSCROLL` / `WM_HSCROLL`.
///
/// Sign convention matches the macOS `bg_scroll` / system trackpad: positive
/// `dy` scrolls the content **down** (further into the document), positive
/// `dx` scrolls **right**. Mirrors cua-driver-rs `ScrollTool`'s
/// `WM_VSCROLL`/`WM_HSCROLL` transport.
pub(super) fn post_scroll_screen(
    root: HWND,
    sx: i32,
    sy: i32,
    dx: i32,
    dy: i32,
) -> OpenBitFunResult<()> {
    if root.is_invalid() {
        return Err(OpenBitFunError::service("post_scroll_screen: invalid HWND"));
    }
    let target = deepest_child(super::windows_overlay::pointer_root(root, sx, sy), sx, sy);
    if let Some(uipi) = post_message_blocked_by_uipi(target, WM_VSCROLL) {
        return Err(OpenBitFunError::service(uipi));
    }

    if dy != 0 {
        let code = if dy > 0 { SB_LINEDOWN } else { SB_LINEUP };
        for _ in 0..delta_to_line_count(dy) {
            post_msg(target, WM_VSCROLL, WPARAM(code.0 as usize), LPARAM(0))?;
        }
    }
    if dx != 0 {
        let code = if dx > 0 { SB_LINERIGHT } else { SB_LINELEFT };
        for _ in 0..delta_to_line_count(dx) {
            post_msg(target, WM_HSCROLL, WPARAM(code.0 as usize), LPARAM(0))?;
        }
    }
    Ok(())
}

// ── drag ──────────────────────────────────────────────────────────────────

/// Down → up hold time at each drag endpoint (ms).
const DRAG_ENDPOINT_DELAY_MS: u64 = 35;

/// Press-drag-release gesture via `PostMessageW`, resolving the deepest child
/// at the **screen** start point and posting the whole gesture in that child's
/// client coordinates. Mirrors cua-driver-rs `post_drag_screen`.
///
/// Endpoints are given in **screen** coordinates; both are converted to the
/// resolved target's client space so a drag stays within one control (a
/// WinForms panel, a Win32 child canvas, …) rather than leaking to the frame.
#[allow(clippy::too_many_arguments)]
pub(super) fn post_drag_screen(
    root: HWND,
    sx_from: i32,
    sy_from: i32,
    sx_to: i32,
    sy_to: i32,
    duration_ms: u64,
    steps: usize,
    button: &str,
) -> OpenBitFunResult<()> {
    if root.is_invalid() {
        return Err(OpenBitFunError::service("post_drag_screen: invalid HWND"));
    }
    // A press keeps the window it started on for the whole gesture.
    let target = deepest_child(
        super::windows_overlay::pointer_root(root, sx_from, sy_from),
        sx_from,
        sy_from,
    );
    if let Some(uipi) = post_message_blocked_by_uipi(target, WM_LBUTTONDOWN) {
        return Err(OpenBitFunError::service(uipi));
    }
    let mut c_from = POINT {
        x: sx_from,
        y: sy_from,
    };
    let mut c_to = POINT { x: sx_to, y: sy_to };
    unsafe {
        let _ = ScreenToClient(target, &mut c_from);
        let _ = ScreenToClient(target, &mut c_to);
    }
    let (down_msg, up_msg, mk_flag) = match button {
        "right" => (WM_RBUTTONDOWN, WM_RBUTTONUP, MK_RBUTTON),
        "middle" => (WM_MBUTTONDOWN, WM_MBUTTONUP, MK_MBUTTON),
        _ => (WM_LBUTTONDOWN, WM_LBUTTONUP, MK_LBUTTON),
    };
    let wdown = WPARAM(mk_flag as usize);
    let steps = steps.max(1);
    let step_delay_ms = if steps > 1 {
        duration_ms / steps as u64
    } else {
        duration_ms
    };

    // Pre-drag MOUSEMOVE (no buttons down yet), then DOWN at the start.
    post_msg(
        target,
        WM_MOUSEMOVE,
        WPARAM(0),
        make_lparam(c_from.x, c_from.y),
    )?;
    post_msg(target, down_msg, wdown, make_lparam(c_from.x, c_from.y))?;
    struct ReleaseOnDrop {
        target: HWND,
        msg: u32,
        point: LPARAM,
        armed: bool,
    }
    impl Drop for ReleaseOnDrop {
        fn drop(&mut self) {
            if self.armed {
                let _ = post_msg(self.target, self.msg, WPARAM(0), self.point);
            }
        }
    }
    let mut release = ReleaseOnDrop {
        target,
        msg: up_msg,
        point: make_lparam(c_from.x, c_from.y),
        armed: true,
    };
    sleep(Duration::from_millis(DRAG_ENDPOINT_DELAY_MS));

    for i in 1..=steps {
        let t = i as f64 / steps as f64;
        let ix = c_from.x + ((c_to.x - c_from.x) as f64 * t).round() as i32;
        let iy = c_from.y + ((c_to.y - c_from.y) as f64 * t).round() as i32;
        release.point = make_lparam(ix, iy);
        post_msg(target, WM_MOUSEMOVE, wdown, release.point)?;
        if step_delay_ms > 0 {
            sleep(Duration::from_millis(step_delay_ms));
        }
    }

    post_msg(target, up_msg, WPARAM(0), make_lparam(c_to.x, c_to.y))?;
    release.armed = false;
    Ok(())
}

// ── key-name → virtual-key parsing ──────────────────────────────────────────

/// Map a modifier name (`ctrl`/`control`, `shift`, `alt`/`option`/`menu`,
/// `win`/`meta`/`cmd`/`command`/`super`) to its virtual-key code. Mirrors
/// cua-driver-rs `modifier_vk`. Returns `None` for non-modifier names.
fn vk_for_modifier(name: &str) -> Option<u16> {
    match name.to_lowercase().as_str() {
        "ctrl" | "control" => Some(0x11),        // VK_CONTROL
        "shift" => Some(0x10),                   // VK_SHIFT
        "alt" | "menu" | "option" => Some(0x12), // VK_MENU
        "win" | "meta" | "windows" | "cmd" | "command" | "super" => Some(0x5B), // VK_LWIN
        _ => None,
    }
}

/// Map a key name (named keys like `enter`, `tab`, arrows, `f1..f12`, or a
/// single printable character) to a virtual-key code. Mirrors cua-driver-rs
/// `key_name_to_vk`; single characters go through `VkKeyScanW`.
fn vk_for_key(key: &str) -> OpenBitFunResult<u16> {
    let vk: u16 = match key.to_lowercase().as_str() {
        "enter" | "return" => 0x0D,
        "tab" => 0x09,
        "escape" | "esc" => 0x1B,
        "space" | " " => 0x20,
        "backspace" => 0x08,
        "delete" | "del" => 0x2E,
        "insert" | "ins" => 0x2D,
        "home" => 0x24,
        "end" => 0x23,
        "pageup" | "pgup" => 0x21,
        "pagedown" | "pgdn" => 0x22,
        "up" => 0x26,
        "down" => 0x28,
        "left" => 0x25,
        "right" => 0x27,
        "f1" => 0x70,
        "f2" => 0x71,
        "f3" => 0x72,
        "f4" => 0x73,
        "f5" => 0x74,
        "f6" => 0x75,
        "f7" => 0x76,
        "f8" => 0x77,
        "f9" => 0x78,
        "f10" => 0x79,
        "f11" => 0x7A,
        "f12" => 0x7B,
        "ctrl" | "control" => 0x11,
        "shift" => 0x10,
        "alt" | "option" => 0x12,
        "win" | "windows" | "meta" | "command" | "cmd" | "super" => 0x5B,
        "capslock" => 0x14,
        "numlock" => 0x90,
        _ => {
            // Single printable character → VK via VkKeyScanW (low byte).
            let ch = key
                .chars()
                .next()
                .ok_or_else(|| OpenBitFunError::tool("empty key name".to_string()))?;
            let scan = unsafe { VkKeyScanW(ch as u16) };
            if scan == -1 {
                return Err(OpenBitFunError::tool(format!("unknown key: {key}")));
            }
            (scan & 0xFF) as u16
        }
    };
    Ok(vk)
}

/// Parse a `key_chord` key list (modifiers + a final key, in any order) into a
/// `(modifiers, keycode)` pair suitable for [`inject_key_cloaked`]. Modifier
/// names are collected as modifiers; the first non-modifier (or, if every entry
/// is a modifier, the last one) becomes the main key. Mirrors the macOS
/// `parse_key_sequence` contract.
pub(super) fn parse_key_chord(keys: &[String]) -> OpenBitFunResult<(Vec<u16>, u16)> {
    if keys.is_empty() {
        return Err(OpenBitFunError::tool("empty key chord".to_string()));
    }
    let mut modifiers: Vec<u16> = Vec::new();
    let mut main_key: Option<u16> = None;
    for k in keys {
        if let Some(m) = vk_for_modifier(k) {
            if !modifiers.contains(&m) {
                modifiers.push(m);
            }
        } else {
            main_key = Some(vk_for_key(k)?);
        }
    }
    let keycode = match main_key {
        Some(k) => k,
        None => {
            // All entries were modifiers — treat the last as the key (e.g.
            // pressing a lone modifier).
            vk_for_key(keys.last().unwrap())?
        }
    };
    Ok((modifiers, keycode))
}

#[cfg(test)]
mod tests {
    use super::{HardwareInput, Input, KeybdInput, MouseInput, INPUT_0};
    use std::mem::{align_of, offset_of, size_of};

    #[test]
    fn send_input_ffi_layout_matches_winuser() {
        assert_eq!(size_of::<HardwareInput>(), 8);
        assert_eq!(align_of::<HardwareInput>(), 4);
        assert_eq!(offset_of!(HardwareInput, uMsg), 0);
        assert_eq!(offset_of!(HardwareInput, wParamL), 4);
        assert_eq!(offset_of!(HardwareInput, wParamH), 6);

        if cfg!(target_pointer_width = "64") {
            assert_eq!(size_of::<KeybdInput>(), 24);
            assert_eq!(align_of::<KeybdInput>(), 8);
            assert_eq!(offset_of!(KeybdInput, dwExtraInfo), 16);
            assert_eq!(size_of::<MouseInput>(), 32);
            assert_eq!(align_of::<MouseInput>(), 8);
            assert_eq!(offset_of!(MouseInput, dwExtraInfo), 24);
            assert_eq!(size_of::<INPUT_0>(), 32);
            assert_eq!(align_of::<INPUT_0>(), 8);
            assert_eq!(size_of::<Input>(), 40);
            assert_eq!(align_of::<Input>(), 8);
            assert_eq!(offset_of!(Input, Anonymous), 8);
        } else {
            assert_eq!(size_of::<KeybdInput>(), 16);
            assert_eq!(align_of::<KeybdInput>(), 4);
            assert_eq!(offset_of!(KeybdInput, dwExtraInfo), 12);
            assert_eq!(size_of::<MouseInput>(), 24);
            assert_eq!(align_of::<MouseInput>(), 4);
            assert_eq!(offset_of!(MouseInput, dwExtraInfo), 20);
            assert_eq!(size_of::<INPUT_0>(), 24);
            assert_eq!(align_of::<INPUT_0>(), 4);
            assert_eq!(size_of::<Input>(), 28);
            assert_eq!(align_of::<Input>(), 4);
            assert_eq!(offset_of!(Input, Anonymous), 4);
        }

        assert_eq!(offset_of!(KeybdInput, wVk), 0);
        assert_eq!(offset_of!(KeybdInput, wScan), 2);
        assert_eq!(offset_of!(KeybdInput, dwFlags), 4);
        assert_eq!(offset_of!(KeybdInput, time), 8);
        assert_eq!(offset_of!(MouseInput, dx), 0);
        assert_eq!(offset_of!(MouseInput, dy), 4);
        assert_eq!(offset_of!(MouseInput, mouseData), 8);
        assert_eq!(offset_of!(MouseInput, dwFlags), 12);
        assert_eq!(offset_of!(MouseInput, time), 16);
        assert_eq!(offset_of!(Input, r#type), 0);
    }
}
