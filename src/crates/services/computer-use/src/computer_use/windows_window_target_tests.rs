//! Interactive Win32/WGC regression, using only this test process's own windows.
use super::find_default_window_for_pid;
use crate::computer_use::{control_session, windows_wgc_capture};
use openbitfun_agent_tools::computer_use_control::ControlMode;
use windows::core::w;
use windows::Win32::Foundation::{HWND, LPARAM, WPARAM};
use windows::Win32::System::Threading::GetCurrentThreadId;
use windows::Win32::UI::WindowsAndMessaging::*;

struct Fixture {
    main: usize,
    companion: usize,
    thread_id: u32,
    thread: Option<std::thread::JoinHandle<()>>,
}

impl Fixture {
    fn start() -> Self {
        let (send, receive) = std::sync::mpsc::sync_channel(1);
        let thread = std::thread::spawn(move || unsafe {
            struct Window(HWND);
            impl Drop for Window {
                fn drop(&mut self) {
                    unsafe {
                        let _ = DestroyWindow(self.0);
                    }
                }
            }
            let main = Window(
                CreateWindowExW(
                    WS_EX_APPWINDOW,
                    w!("STATIC"),
                    w!("OpenBitFun WGC main fixture"),
                    WS_OVERLAPPEDWINDOW,
                    40,
                    40,
                    640,
                    480,
                    None,
                    None,
                    None,
                    None,
                )
                .unwrap(),
            );
            // Same process and window class; topmost, but deliberately not a
            // TOOLWINDOW. This matches the important distinction in issue #3291.
            let companion = Window(
                CreateWindowExW(
                    WS_EX_APPWINDOW | WS_EX_TOPMOST,
                    w!("STATIC"),
                    w!("OpenBitFun WGC companion fixture"),
                    WS_OVERLAPPEDWINDOW,
                    400,
                    100,
                    288,
                    114,
                    None,
                    None,
                    None,
                    None,
                )
                .unwrap(),
            );
            let _ = ShowWindow(main.0, SW_SHOWNOACTIVATE);
            let _ = ShowWindow(companion.0, SW_SHOWNOACTIVATE);
            send.send((
                main.0 .0 as usize,
                companion.0 .0 as usize,
                GetCurrentThreadId(),
            ))
            .unwrap();
            let mut message = MSG::default();
            while GetMessageW(&mut message, None, 0, 0).0 > 0 {
                let _ = TranslateMessage(&message);
                DispatchMessageW(&message);
            }
        });
        let (main, companion, thread_id) = receive
            .recv_timeout(std::time::Duration::from_secs(10))
            .expect("fixture windows must initialize");
        Self {
            main,
            companion,
            thread_id,
            thread: Some(thread),
        }
    }
}

impl Drop for Fixture {
    fn drop(&mut self) {
        unsafe {
            let _ = PostThreadMessageW(self.thread_id, WM_QUIT, WPARAM(0), LPARAM(0));
        }
        if let Some(thread) = self.thread.take() {
            let _ = thread.join();
        }
    }
}

#[test]
#[ignore = "requires an interactive Windows 10 1903+ desktop with WGC"]
fn default_window_captures_main_beside_topmost_companion() {
    let foreground = unsafe { GetForegroundWindow() };
    let fixture = Fixture::start();
    let pid = std::process::id();
    let inventory = super::enumerate_windows(false);
    let position = |handle| {
        inventory
            .iter()
            .position(|window| window.hwnd == handle)
            .unwrap()
    };
    assert!(position(fixture.companion) < position(fixture.main));
    let target = find_default_window_for_pid(pid).expect("default content window");
    assert_eq!(target.0 as usize, fixture.main);

    const OWNER: &str = "windows-default-window-fixture";
    control_session::start(OWNER, ControlMode::Observe).unwrap();
    struct Stop;
    impl Drop for Stop {
        fn drop(&mut self) {
            let _ = control_session::stop(Some(OWNER), "fixture_complete");
        }
    }
    let _stop = Stop;
    let mut lease = control_session::acquire(OWNER, "get_app_state").unwrap();
    let target_id = format!("pid:{pid}/window:{}", fixture.main);
    control_session::bind_target(target_id.clone()).unwrap();
    let (pixels, width, height, _) = windows_wgc_capture::capture_window_bgra(target).unwrap();
    assert!(width > 288 && height > 114, "must capture the main window");
    assert_eq!(pixels.len(), width as usize * height as usize * 4);
    // A static HWND need not enqueue another WGC frame after each read.
    for _ in 0..3 {
        let (next, next_width, next_height, _) =
            windows_wgc_capture::capture_window_bgra(target).unwrap();
        assert_eq!((next_width, next_height), (width, height));
        assert_eq!(next.len(), pixels.len());
    }
    assert_eq!(
        control_session::snapshot().target.as_deref(),
        Some(target_id.as_str())
    );
    // Capture admission must not let a different HWND replace the bound window.
    let wrong_target = windows_wgc_capture::capture_window_bgra(HWND(fixture.companion as *mut _))
        .unwrap_err()
        .to_string();
    assert!(
        wrong_target.contains("CONTROL_TARGET_CHANGED"),
        "{wrong_target}"
    );
    assert_eq!(unsafe { GetForegroundWindow() }, foreground);
    lease.complete();
}
