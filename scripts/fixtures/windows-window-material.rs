// Run with scripts/test-windows-window-material.mjs. This creates no product
// state and never shows the test windows. Hit testing is performed by the real
// production Tauri/CEF window procedures, not a fixture copy of their algorithm.
#[cfg(target_os = "windows")]
mod native {
    use std::error::Error;
    use std::mem::size_of;
    use tauri::{WebviewUrl, WebviewWindowBuilder};
    use windows::Win32::Foundation::{HWND, LPARAM, LRESULT, POINT, RECT, WPARAM};
    use windows::Win32::Graphics::Dwm::{DwmGetWindowAttribute, DWMWA_SYSTEMBACKDROP_TYPE};
    use windows::Win32::Graphics::Gdi::ClientToScreen;
    use windows::Win32::UI::Shell::{DefSubclassProc, RemoveWindowSubclass, SetWindowSubclass};
    use windows::Win32::UI::WindowsAndMessaging::{
        GetClientRect, GetWindowLongPtrW, GetWindowRect, IsWindowVisible, SendMessageW,
        SetWindowPos, GWL_STYLE, HTBOTTOM, HTBOTTOMLEFT, HTBOTTOMRIGHT, HTLEFT, HTRIGHT, HTTOP,
        HTTOPLEFT, HTTOPRIGHT, SWP_FRAMECHANGED, SWP_NOACTIVATE, SWP_NOMOVE, SWP_NOSIZE,
        SWP_NOZORDER, WM_NCCALCSIZE, WM_NCHITTEST, WS_SIZEBOX,
    };

    type Result<T = ()> = std::result::Result<T, Box<dyn Error>>;

    fn window_rect(hwnd: HWND) -> Result<RECT> {
        let mut rect = RECT::default();
        unsafe { GetWindowRect(hwnd, &mut rect)? };
        Ok(rect)
    }

    fn verify_frame(hwnd: HWND) -> Result {
        let outer = window_rect(hwnd)?;
        let mut client = RECT::default();
        unsafe { GetClientRect(hwnd, &mut client)? };
        let mut origin = POINT::default();
        assert!(unsafe { ClientToScreen(hwnd, &mut origin) }.as_bool());
        let insets = [
            origin.x - outer.left,
            origin.y - outer.top,
            outer.right - origin.x - client.right,
            outer.bottom - origin.y - client.bottom,
        ];
        assert!(
            insets[0] > 0 && insets[2] > 0 && insets[3] > 0,
            "Native side/bottom frame must remain outside the client area: {insets:?}"
        );
        assert_ne!(
            unsafe { GetWindowLongPtrW(hwnd, GWL_STYLE) } as u32 & WS_SIZEBOX.0,
            0,
            "Native window must retain its resizable frame style"
        );
        println!("PASS native resize frame insets: {insets:?}");
        Ok(())
    }

    fn verify_hit_testing(hwnd: HWND) -> Result {
        let rect = window_rect(hwnd)?;
        let middle_x = rect.left + (rect.right - rect.left) / 2;
        let middle_y = rect.top + (rect.bottom - rect.top) / 2;
        let left = rect.left + 1;
        let right = rect.right - 2;
        let top = rect.top + 1;
        let bottom = rect.bottom - 2;
        for (name, x, y, expected) in [
            ("left", left, middle_y, HTLEFT),
            ("right", right, middle_y, HTRIGHT),
            ("top", middle_x, top, HTTOP),
            ("bottom", middle_x, bottom, HTBOTTOM),
            ("top-left", left, top, HTTOPLEFT),
            ("top-right", right, top, HTTOPRIGHT),
            ("bottom-left", left, bottom, HTBOTTOMLEFT),
            ("bottom-right", right, bottom, HTBOTTOMRIGHT),
        ] {
            // WM_NCHITTEST packs signed screen coordinates into two 16-bit words.
            let coordinates = LPARAM(((x as u16 as u32) | ((y as u16 as u32) << 16)) as isize);
            let actual = unsafe { SendMessageW(hwnd, WM_NCHITTEST, None, Some(coordinates)) }.0;
            assert_eq!(actual, expected as isize, "Native resize hit test: {name}");
        }
        println!("PASS native hit testing on all four edges and all four corners");
        Ok(())
    }

    fn verify_size_change(hwnd: HWND) -> Result {
        let original = window_rect(hwnd)?;
        let width = original.right - original.left;
        let height = original.bottom - original.top;
        unsafe {
            SetWindowPos(
                hwnd,
                None,
                0,
                0,
                width + 73,
                height + 41,
                SWP_NOMOVE | SWP_NOZORDER | SWP_NOACTIVATE,
            )?;
        }
        let resized = window_rect(hwnd)?;
        assert_eq!(resized.right - resized.left, width + 73);
        assert_eq!(resized.bottom - resized.top, height + 41);
        verify_frame(hwnd)?;
        verify_hit_testing(hwnd)?;
        unsafe {
            SetWindowPos(
                hwnd,
                None,
                0,
                0,
                width,
                height,
                SWP_NOMOVE | SWP_NOZORDER | SWP_NOACTIVATE,
            )?;
        }
        let restored = window_rect(hwnd)?;
        assert_eq!(restored.right - restored.left, width);
        assert_eq!(restored.bottom - restored.top, height);
        assert!(!unsafe { IsWindowVisible(hwnd) }.as_bool());
        println!("PASS physical native resize and size restoration while hidden");
        Ok(())
    }

    fn verify_backdrop(hwnd: HWND) -> Result {
        let mut backdrop: i32 = -1;
        if unsafe {
            DwmGetWindowAttribute(
                hwnd,
                DWMWA_SYSTEMBACKDROP_TYPE,
                &mut backdrop as *mut _ as _,
                size_of::<i32>() as u32,
            )
        }
        .is_ok()
        {
            assert!(
                backdrop == 0 || backdrop == 1,
                "The Chromium window must not request a system material: {backdrop}"
            );
        }
        Ok(())
    }

    // Negative control reproduces PR #3217's frame collapse, demonstrating that
    // the actual HWND assertion detects the regression. It is removed immediately.
    unsafe extern "system" fn collapse_frame(
        hwnd: HWND,
        message: u32,
        wparam: WPARAM,
        lparam: LPARAM,
        _subclass_id: usize,
        _data: usize,
    ) -> LRESULT {
        if message == WM_NCCALCSIZE && wparam.0 != 0 {
            LRESULT(0)
        } else {
            unsafe { DefSubclassProc(hwnd, message, wparam, lparam) }
        }
    }

    fn verify_regression_control(hwnd: HWND) -> Result {
        const SUBCLASS_ID: usize = 0x4f42_4654;
        unsafe {
            assert!(SetWindowSubclass(hwnd, Some(collapse_frame), SUBCLASS_ID, 0).as_bool());
            SetWindowPos(
                hwnd,
                None,
                0,
                0,
                0,
                0,
                SWP_FRAMECHANGED | SWP_NOMOVE | SWP_NOSIZE | SWP_NOZORDER | SWP_NOACTIVATE,
            )?;
        }
        let outer = window_rect(hwnd)?;
        let mut client = RECT::default();
        unsafe { GetClientRect(hwnd, &mut client)? };
        assert_eq!(
            client.right,
            outer.right - outer.left,
            "Negative control must expose the collapsed horizontal frame"
        );
        assert_eq!(
            client.bottom,
            outer.bottom - outer.top,
            "Negative control must expose the collapsed vertical frame"
        );
        unsafe {
            assert!(RemoveWindowSubclass(hwnd, Some(collapse_frame), SUBCLASS_ID).as_bool());
            SetWindowPos(
                hwnd,
                None,
                0,
                0,
                0,
                0,
                SWP_FRAMECHANGED | SWP_NOMOVE | SWP_NOSIZE | SWP_NOZORDER | SWP_NOACTIVATE,
            )?;
        }
        verify_frame(hwnd)?;
        verify_hit_testing(hwnd)?;
        println!("PASS regression control distinguishes collapsed and native frames");
        Ok(())
    }

    pub fn run() -> Result {
        let storage = tempfile::tempdir()?;
        let app = tauri::Builder::default()
            .runtime(tauri_runtime_cef::Cef::default().root_cache_path(storage.path()))
            .build(tauri::generate_context!())?;
        println!("Running with Chromium {}", app.webview_version()?);
        let builder =
            WebviewWindowBuilder::new(&app, "opaque", WebviewUrl::External("about:blank".parse()?))
                .title("OpenBitFun hidden Chromium window fixture")
                .inner_size(640.0, 480.0)
                .position(80.0, 80.0)
                .resizable(true)
                .visible(false)
                .skip_taskbar(true)
                .incognito(true);
        let window = crate::window_material::configure_main_window(
            builder,
            tauri::window::Color(24, 26, 28, 255),
        )
        .build()?;
        let hwnd = window.hwnd()?;
        assert!(!unsafe { IsWindowVisible(hwnd) }.as_bool());
        verify_frame(hwnd)?;
        verify_hit_testing(hwnd)?;
        verify_backdrop(hwnd)?;
        verify_size_change(hwnd)?;
        verify_regression_control(hwnd)?;
        window.destroy()?;
        // Destroy is dispatched through the real event loop, even on the main
        // thread. Let all native Destroyed events release their WebViews before
        // the last-window exit completes and temporary storage is removed.
        assert_eq!(app.run_return(|_, _| {}), 0);
        println!("Native checks do not measure drag frame rate or rendered shadow appearance.");
        Ok(())
    }
}

#[cfg(target_os = "windows")]
#[tauri_runtime_cef::cef_entry_point]
fn main() {
    native::run().expect("Windows Chromium window fixture failed");
}

#[cfg(not(target_os = "windows"))]
fn main() {
    panic!("This native fixture must be built for and executed on Windows");
}
