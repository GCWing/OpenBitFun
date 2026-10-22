//! Windows desktop-layer integration. All mutations run on the window's UI thread.
//!
//! Parent cards to the existing Explorer window containing SHELLDLL_DefView,
//! above its icon view, rather than the wallpaper WorkerW behind the icons.
//! No undocumented Shell message, Explorer injection, or global topmost window
//! is needed. If Explorer does not expose that desktop, fail explicitly.

use windows::core::{w, BOOL};
use windows::Win32::Foundation::{
    GetLastError, SetLastError, HANDLE, HWND, LPARAM, POINT, RECT, WIN32_ERROR,
};
use windows::Win32::Graphics::Gdi::ScreenToClient;
use windows::Win32::UI::HiDpi::{AreDpiAwarenessContextsEqual, GetWindowDpiAwarenessContext};
use windows::Win32::UI::WindowsAndMessaging::{
    EnumWindows, FindWindowExW, GetParent, GetPropW, GetWindowLongW, GetWindowRect, RemovePropW,
    SetParent, SetPropW, SetWindowLongW, SetWindowPos, GWL_STYLE, HWND_NOTOPMOST, HWND_TOP,
    SWP_FRAMECHANGED, SWP_NOACTIVATE, SWP_NOMOVE, SWP_NOSIZE, WS_CHILD, WS_POPUP,
};

const ORIGINAL_STYLE: windows::core::PCWSTR = w!("OpenBitFun.DesktopCard.OriginalStyle");

unsafe extern "system" fn find_desktop(hwnd: HWND, data: LPARAM) -> BOOL {
    // SAFETY: EnumWindows is synchronous and data points to its caller's HWND.
    if unsafe { FindWindowExW(Some(hwnd), None, w!("SHELLDLL_DefView"), None) }.is_ok() {
        unsafe { *(data.0 as *mut HWND) = hwnd };
    }
    BOOL(1)
}

fn desktop_host() -> Result<HWND, String> {
    let mut host = HWND::default();
    unsafe { EnumWindows(Some(find_desktop), LPARAM(&mut host as *mut HWND as isize)) }
        .map_err(|error| error.to_string())?;
    if host.is_invalid() {
        Err("Windows desktop is unavailable. Start Windows Explorer and try again.".to_string())
    } else {
        Ok(host)
    }
}

pub(super) fn screen_position(hwnd: HWND) -> Result<POINT, String> {
    let mut rect = RECT::default();
    unsafe { GetWindowRect(hwnd, &mut rect) }.map_err(|error| error.to_string())?;
    Ok(POINT {
        x: rect.left,
        y: rect.top,
    })
}

fn set_style(hwnd: HWND, style: i32) -> Result<(), String> {
    unsafe {
        SetLastError(WIN32_ERROR(0));
        let previous = SetWindowLongW(hwnd, GWL_STYLE, style);
        if previous == 0 && GetLastError().0 != 0 {
            return Err(windows::core::Error::from_win32().to_string());
        }
    }
    Ok(())
}

fn reparent(hwnd: HWND, parent: Option<HWND>, style: i32, position: POINT) -> Result<(), String> {
    // SetParent legitimately returns NULL on success for a former top-level
    // window. The windows-rs Result wrapper alone cannot distinguish that case.
    unsafe {
        SetLastError(WIN32_ERROR(0));
        let result = SetParent(hwnd, parent);
        if result.is_err() && GetLastError().0 != 0 {
            return Err(windows::core::Error::from_win32().to_string());
        }
    }
    set_style(hwnd, style)?;
    let mut point = position;
    if let Some(parent) = parent {
        if !unsafe { ScreenToClient(parent, &mut point) }.as_bool() {
            return Err("Failed to map desktop card screen coordinates.".to_string());
        }
    }
    unsafe {
        SetWindowPos(
            hwnd,
            Some(HWND_TOP),
            point.x,
            point.y,
            0,
            0,
            SWP_NOSIZE | SWP_NOACTIVATE | SWP_FRAMECHANGED,
        )
    }
    .map_err(|error| error.to_string())
}

fn attach_to(hwnd: HWND, parent: HWND) -> Result<(), String> {
    // Cross-process SetParent with mismatched DPI contexts can forcibly reset
    // the child process's DPI awareness, affecting EVERY OpenBitFun window.
    // Refuse rather than silently breaking scaling or saved geometry.
    if !unsafe {
        AreDpiAwarenessContextsEqual(
            GetWindowDpiAwarenessContext(hwnd),
            GetWindowDpiAwarenessContext(parent),
        )
    }
    .as_bool()
    {
        return Err("Windows desktop and card DPI modes differ; desktop pinning is unavailable in this display configuration.".to_string());
    }
    let position = screen_position(hwnd)?;
    let style = unsafe { GetWindowLongW(hwnd, GWL_STYLE) };
    let previous_parent = unsafe { GetParent(hwnd) }.ok();
    let saved = unsafe { GetPropW(hwnd, ORIGINAL_STYLE) };
    if !saved.is_invalid() && previous_parent == Some(parent) {
        return Ok(());
    }
    // Keep only the parenting flags; visibility and resizing may change while
    // attached. +1 makes a zero original flag set distinguishable from absent.
    if saved.is_invalid() {
        let flags = (style as u32 & (WS_CHILD.0 | WS_POPUP.0)) as usize + 1;
        unsafe { SetPropW(hwnd, ORIGINAL_STYLE, Some(HANDLE(flags as *mut _))) }
            .map_err(|error| error.to_string())?;
    }
    let result = (|| {
        unsafe {
            SetWindowPos(
                hwnd,
                Some(HWND_NOTOPMOST),
                0,
                0,
                0,
                0,
                SWP_NOMOVE | SWP_NOSIZE | SWP_NOACTIVATE,
            )
        }
        .map_err(|error| error.to_string())?;
        let child_style = (style as u32 & !WS_POPUP.0) | WS_CHILD.0;
        // WS_CHILD must be set before parenting a former top-level window.
        set_style(hwnd, child_style as i32)?;
        reparent(hwnd, Some(parent), child_style as i32, position)
    })();
    if let Err(error) = result {
        let rollback = reparent(hwnd, previous_parent, style, position);
        if saved.is_invalid() {
            let _ = unsafe { RemovePropW(hwnd, ORIGINAL_STYLE) };
        }
        return Err(format!(
            "Failed to attach card to Windows desktop: {error}; rollback: {rollback:?}"
        ));
    }
    Ok(())
}

pub(super) fn set_pinned(hwnd: HWND, pinned: bool) -> Result<(), String> {
    if pinned {
        return attach_to(hwnd, desktop_host()?);
    }
    let saved = unsafe { GetPropW(hwnd, ORIGINAL_STYLE) };
    if saved.is_invalid() {
        return Ok(());
    }
    let position = screen_position(hwnd)?;
    let style = unsafe { GetWindowLongW(hwnd, GWL_STYLE) };
    let original_flags = (saved.0 as usize - 1) as u32;
    let restored = (style as u32 & !(WS_CHILD.0 | WS_POPUP.0)) | original_flags;
    let parent = unsafe { GetParent(hwnd) }.ok();
    if let Err(error) = reparent(hwnd, None, restored as i32, position) {
        let rollback = reparent(hwnd, parent, style, position);
        return Err(format!(
            "Failed to detach desktop card: {error}; rollback: {rollback:?}"
        ));
    }
    unsafe { RemovePropW(hwnd, ORIGINAL_STYLE) }.map_err(|error| error.to_string())?;
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;
    use windows::Win32::UI::WindowsAndMessaging::{
        CreateWindowExW, DestroyWindow, WINDOW_EX_STYLE, WS_OVERLAPPEDWINDOW,
    };

    struct TestWindow(HWND);
    impl TestWindow {
        fn new(x: i32, y: i32) -> Self {
            Self(
                unsafe {
                    CreateWindowExW(
                        WINDOW_EX_STYLE::default(),
                        w!("STATIC"),
                        w!("Desktop card test"),
                        WS_OVERLAPPEDWINDOW,
                        x,
                        y,
                        280,
                        180,
                        None,
                        None,
                        None,
                        None,
                    )
                }
                .unwrap(),
            )
        }
    }
    impl Drop for TestWindow {
        fn drop(&mut self) {
            let _ = unsafe { DestroyWindow(self.0) };
        }
    }

    #[test]
    fn desktop_parenting_round_trip_preserves_screen_position_and_style() {
        let parent = TestWindow::new(-300, 120);
        let card = TestWindow::new(45, 60);
        let style = unsafe { GetWindowLongW(card.0, GWL_STYLE) };
        let before = screen_position(card.0).unwrap();
        attach_to(card.0, parent.0).unwrap();
        attach_to(card.0, parent.0).unwrap(); // Idempotent restore.
        assert_eq!(unsafe { GetParent(card.0) }.unwrap(), parent.0);
        assert_ne!(
            unsafe { GetWindowLongW(card.0, GWL_STYLE) } as u32 & WS_CHILD.0,
            0
        );
        let attached = screen_position(card.0).unwrap();
        assert_eq!((attached.x, attached.y), (before.x, before.y));
        set_pinned(card.0, false).unwrap();
        set_pinned(card.0, false).unwrap();
        assert!(unsafe { GetParent(card.0) }.is_err());
        assert_eq!(unsafe { GetWindowLongW(card.0, GWL_STYLE) }, style);
        let after = screen_position(card.0).unwrap();
        assert_eq!((after.x, after.y), (before.x, before.y));
    }

    #[test]
    #[ignore = "requires a graphical Windows session with Explorer running"]
    fn live_explorer_attachment_round_trip() {
        // Hidden disposable window; never change Explorer's own styles or state.
        // Create it in the Shell's DPI context, as required by SetParent.
        use windows::Win32::UI::HiDpi::SetThreadDpiAwarenessContext;
        let context = unsafe { GetWindowDpiAwarenessContext(desktop_host().unwrap()) };
        let previous_context = unsafe { SetThreadDpiAwarenessContext(context) };
        let card = TestWindow::new(80, 90);
        let before = screen_position(card.0).unwrap();
        set_pinned(card.0, true).unwrap();
        assert_eq!(
            unsafe { GetParent(card.0) }.unwrap(),
            desktop_host().unwrap()
        );
        set_pinned(card.0, false).unwrap();
        assert!(unsafe { GetParent(card.0) }.is_err());
        let after = screen_position(card.0).unwrap();
        assert_eq!((after.x, after.y), (before.x, before.y));
        drop(card);
        unsafe { SetThreadDpiAwarenessContext(previous_context) };
    }

    #[test]
    fn mismatched_dpi_is_rejected_before_mutating_the_window() {
        use windows::Win32::UI::HiDpi::{
            SetThreadDpiAwarenessContext, DPI_AWARENESS_CONTEXT_PER_MONITOR_AWARE_V2,
            DPI_AWARENESS_CONTEXT_UNAWARE,
        };
        let previous = unsafe { SetThreadDpiAwarenessContext(DPI_AWARENESS_CONTEXT_UNAWARE) };
        let parent = TestWindow::new(0, 0);
        unsafe { SetThreadDpiAwarenessContext(DPI_AWARENESS_CONTEXT_PER_MONITOR_AWARE_V2) };
        let card = TestWindow::new(80, 90);
        unsafe { SetThreadDpiAwarenessContext(previous) };
        let style = unsafe { GetWindowLongW(card.0, GWL_STYLE) };
        assert!(attach_to(card.0, parent.0)
            .unwrap_err()
            .contains("DPI modes differ"));
        assert!(unsafe { GetParent(card.0) }.is_err());
        assert_eq!(unsafe { GetWindowLongW(card.0, GWL_STYLE) }, style);
        assert!(unsafe { GetPropW(card.0, ORIGINAL_STYLE) }.is_invalid());
    }

    #[test]
    fn invalid_parent_is_rejected_without_leaving_attachment_marker() {
        let card = TestWindow::new(80, 90);
        let style = unsafe { GetWindowLongW(card.0, GWL_STYLE) };
        assert!(attach_to(card.0, HWND(1 as *mut _)).is_err());
        assert!(unsafe { GetParent(card.0) }.is_err());
        assert_eq!(unsafe { GetWindowLongW(card.0, GWL_STYLE) }, style);
        assert!(unsafe { GetPropW(card.0, ORIGINAL_STYLE) }.is_invalid());
    }
}
