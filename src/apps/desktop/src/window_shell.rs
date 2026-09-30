//! Windows shell integration for the main window.
//!
//! Two window details that the native non-client area owns are settled here:
//! the frame strips the undecorated window leaves unpainted, and the backdrop
//! capability that decides whether the native sidebar material can be hosted
//! by the compositor at all.

use windows::Win32::Foundation::{GetLastError, HWND, LPARAM, LRESULT, WPARAM};
use windows::Win32::UI::Shell::{DefSubclassProc, SetWindowSubclass, SUBCLASSPROC};
use windows::Win32::UI::WindowsAndMessaging::{
    IsZoomed, SetWindowPos, SWP_FRAMECHANGED, SWP_NOACTIVATE, SWP_NOMOVE, SWP_NOOWNERZORDER,
    SWP_NOSIZE, SWP_NOZORDER, WM_NCCALCSIZE,
};

/// Identifies the main window's client/frame subclass.
const FRAME_SUBCLASS_ID: usize = 0x4f42_4653; // "OBFS"

/// Windows 11 22H2 is the first release that can host the window backdrop in
/// the compositor (`DWMWA_SYSTEMBACKDROP_TYPE`).
const WINDOWS_BACKDROP_MIN_BUILD: u32 = 22621;

/// The undecorated main window keeps its resizable frame so that Windows still
/// provides the resize border, Aero Snap and the system move/size gestures.
/// tao sizes the WebView to the client rectangle and leaves the window class
/// without a background brush, so the strips between the client rectangle and
/// the window rectangle stay unpainted. Those strips sit on the left, right and
/// bottom edges (the top edge has none), and a transparent window composites
/// them as bare window backdrop, which reads as a drop shadow around the window.
///
/// Widen the client rectangle over the strips instead. Resizing, snapping and
/// the move/size gestures are all driven by the window rectangle, so removing
/// the non-client area leaves every native interaction intact while the WebView
/// paints the window edge-to-edge. Maximized windows keep the default handling:
/// Windows inflates their window rectangle beyond the work area, which already
/// moves the strips off-screen.
pub(crate) fn install_frame_handling(window: &tauri::WebviewWindow) -> Result<(), String> {
    let hwnd = window.hwnd().map_err(|error| error.to_string())?;
    let subclass: SUBCLASSPROC = Some(frame_subclass_proc);
    let installed = unsafe { SetWindowSubclass(hwnd, subclass, FRAME_SUBCLASS_ID, 0) };
    if !installed.as_bool() {
        return Err(format!(
            "SetWindowSubclass failed for the main window: 0x{:08X}",
            unsafe { GetLastError() }.0
        ));
    }
    // The subclass applies from the next frame recalculation onwards.
    unsafe {
        SetWindowPos(
            hwnd,
            None,
            0,
            0,
            0,
            0,
            SWP_FRAMECHANGED
                | SWP_NOMOVE
                | SWP_NOSIZE
                | SWP_NOZORDER
                | SWP_NOOWNERZORDER
                | SWP_NOACTIVATE,
        )
        .map_err(|error| error.to_string())?;
    }
    Ok(())
}

/// Whether the compositor can host the window backdrop on this build.
///
/// Windows 10 has no `DWMWA_SYSTEMBACKDROP_TYPE`, so the window material falls
/// back to a live blur-behind that re-blurs everything behind the window on
/// every move. Dragging the window then drops frames, which is why the native
/// sidebar material is only requested where the backdrop is compositor-owned.
pub(crate) fn window_backdrop_available() -> bool {
    use windows::Win32::System::SystemInformation::{GetVersionExW, OSVERSIONINFOW};

    let mut version = OSVERSIONINFOW {
        dwOSVersionInfoSize: std::mem::size_of::<OSVERSIONINFOW>() as u32,
        ..Default::default()
    };
    unsafe { GetVersionExW(&mut version) }.is_ok()
        && version.dwBuildNumber >= WINDOWS_BACKDROP_MIN_BUILD
}

unsafe extern "system" fn frame_subclass_proc(
    hwnd: HWND,
    msg: u32,
    wparam: WPARAM,
    lparam: LPARAM,
    _subclass_id: usize,
    _ref_data: usize,
) -> LRESULT {
    // A non-zero `wparam` marks the `NCCALCSIZE_PARAMS` form of the message,
    // whose `rgrc[0]` already holds the proposed window rectangle. Returning
    // zero adopts that rectangle unchanged, which is what removes the strips.
    if msg == WM_NCCALCSIZE && wparam.0 != 0 && !IsZoomed(hwnd).as_bool() {
        return LRESULT(0);
    }
    DefSubclassProc(hwnd, msg, wparam, lparam)
}
