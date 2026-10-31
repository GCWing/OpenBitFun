//! Host lifecycle support without a GUI framework. Native resources always
//! belong to the executing process and its graphical login session.
use std::thread::JoinHandle;

/// Explain whether this process can attach to its own graphical session.
/// This does not request OS permissions, capture pixels, or activate an app.
pub fn availability() -> Result<(), String> {
    if std::env::var_os("SSH_CONNECTION").is_some() || std::env::var_os("SSH_TTY").is_some() {
        return Err("[GUI_SESSION_UNAVAILABLE] Computer Use requires a local graphical login session; SSH sessions cannot control another desktop.".into());
    }
    platform_availability()
}

#[cfg(target_os = "linux")]
fn platform_availability() -> Result<(), String> {
    linux_session_available(
        std::env::var_os("DISPLAY").is_some_and(|s| !s.is_empty()),
        std::env::var_os("WAYLAND_DISPLAY").is_some_and(|s| !s.is_empty()),
        std::env::var_os("DBUS_SESSION_BUS_ADDRESS").is_some_and(|s| !s.is_empty()),
    )
}

#[cfg(any(target_os = "linux", test))]
fn linux_session_available(x11: bool, wayland: bool, session_bus: bool) -> Result<(), String> {
    if (x11 || wayland) && session_bus {
        Ok(())
    } else {
        Err("[GUI_SESSION_UNAVAILABLE] Linux Computer Use requires an X11 or Wayland session and its D-Bus session bus. Screen capture and foreground input additionally require the desktop portal.".into())
    }
}

#[cfg(target_os = "macos")]
fn platform_availability() -> Result<(), String> {
    use core_foundation::base::CFRelease;
    #[link(name = "CoreGraphics", kind = "framework")]
    unsafe extern "C" {
        fn CGSessionCopyCurrentDictionary() -> *const std::ffi::c_void;
    }
    // Copy follows the CF ownership rule. No capture or permission prompting.
    let session = unsafe { CGSessionCopyCurrentDictionary() };
    if session.is_null() {
        return Err(
            "[GUI_SESSION_UNAVAILABLE] macOS Computer Use requires a graphical login session."
                .into(),
        );
    }
    unsafe { CFRelease(session) };
    Ok(())
}

#[cfg(target_os = "windows")]
fn platform_availability() -> Result<(), String> {
    use windows::Win32::System::StationsAndDesktops::{
        GetProcessWindowStation, GetUserObjectInformationW, UOI_FLAGS, USEROBJECTFLAGS,
    };
    use windows::Win32::{Foundation::HANDLE, UI::WindowsAndMessaging::WSF_VISIBLE};
    // A service's invisible window station is not an interactive desktop.
    let station = unsafe { GetProcessWindowStation() }.map_err(|error| {
        format!("[GUI_SESSION_UNAVAILABLE] Cannot inspect the process window station: {error}")
    })?;
    let mut flags = USEROBJECTFLAGS::default();
    unsafe {
        GetUserObjectInformationW(
            HANDLE(station.0),
            UOI_FLAGS,
            Some((&mut flags as *mut USEROBJECTFLAGS).cast()),
            std::mem::size_of::<USEROBJECTFLAGS>() as u32,
            None,
        )
    }
    .map_err(|error| {
        format!("[GUI_SESSION_UNAVAILABLE] Cannot inspect the process window station: {error}")
    })?;
    if flags.dwFlags & WSF_VISIBLE as u32 != 0 {
        Ok(())
    } else {
        Err("[GUI_SESSION_UNAVAILABLE] Windows Computer Use requires an interactive user window station; services and session 0 cannot control a desktop.".into())
    }
}

#[cfg(not(any(target_os = "macos", target_os = "windows", target_os = "linux")))]
fn platform_availability() -> Result<(), String> {
    Err("[GUI_SESSION_UNAVAILABLE] No native Computer Use provider for this platform.".into())
}

/// CLI runs its existing async Runtime on a worker. macOS additionally needs
/// its real main dispatch/run loop for AppKit, capture and native input.
/// Windows owns native message/COM workers; Linux uses its async portal/AT-SPI IO.
pub fn join<T: Send + 'static>(worker: JoinHandle<T>) -> std::thread::Result<T> {
    #[cfg(target_os = "macos")]
    {
        #[link(name = "CoreFoundation", kind = "framework")]
        unsafe extern "C" {
            static kCFRunLoopDefaultMode: *const std::ffi::c_void;
            fn CFRunLoopRunInMode(
                mode: *const std::ffi::c_void,
                seconds: f64,
                return_after_source: bool,
            ) -> i32;
        }
        while !worker.is_finished() {
            unsafe {
                CFRunLoopRunInMode(kCFRunLoopDefaultMode, 0.01, true);
            }
            // The CF loop can return immediately before any source exists.
            std::thread::sleep(std::time::Duration::from_millis(1));
        }
    }
    worker.join()
}

/// Initialize the framework owned by a CLI graphical host, without activation.
/// Desktop already initializes AppKit through its own host lifecycle.
pub fn initialize() -> Result<(), String> {
    availability()?;
    #[cfg(target_os = "macos")]
    dispatch::Queue::main().exec_sync(|| {
        let app: *mut objc2::runtime::AnyObject =
            unsafe { objc2::msg_send![objc2::class!(NSApplication), sharedApplication] };
        let _: bool = unsafe { objc2::msg_send![app, setActivationPolicy: 2isize] };
    });
    Ok(())
}

/// Drop on the Runtime worker before exiting, while main still services cleanup.
pub struct StopOnExit;
impl Drop for StopOnExit {
    fn drop(&mut self) {
        let _ = crate::control_session::stop(None, "host_shutdown");
    }
}

#[cfg(test)]
mod tests {
    #[test]
    fn linux_headless_and_missing_bus_do_not_become_local_fallbacks() {
        for (x11, wayland, bus) in [
            (false, false, false),
            (false, false, true),
            (true, false, false),
            (false, true, false),
        ] {
            assert!(super::linux_session_available(x11, wayland, bus)
                .unwrap_err()
                .contains("GUI_SESSION_UNAVAILABLE"));
        }
        assert!(super::linux_session_available(true, false, true).is_ok());
        assert!(super::linux_session_available(false, true, true).is_ok());
    }
}
