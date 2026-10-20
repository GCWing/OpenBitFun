//! Explicit foreground recovery. Activation never runs inside an input retry.
use super::DesktopComputerUseHost;
use openbitfun_core::util::errors::{OpenBitFunError, OpenBitFunResult};

pub(super) fn parse_native_target(target: &str) -> Option<(i32, u64)> {
    let (pid, window) = target.strip_prefix("pid:")?.split_once("/window:")?;
    let pid = pid.parse().ok()?;
    let window = window.parse().ok()?;
    (pid > 0 && window > 0).then_some((pid, window))
}

impl DesktopComputerUseHost {
    pub(super) fn ensure_foreground_target() -> OpenBitFunResult<()> {
        crate::computer_use::control_session::foreground_allowed()
            .map_err(OpenBitFunError::tool)?;
        #[cfg(any(target_os = "macos", target_os = "windows"))]
        {
            let target = crate::computer_use::control_session::snapshot().target;
            let (pid, window) = target.as_deref().and_then(parse_native_target).ok_or_else(|| {
                OpenBitFunError::tool("[FOREGROUND_TARGET_REQUIRED] Observe and activate the intended window before global input")
            })?;
            #[cfg(target_os = "windows")]
            let matches = unsafe {
                use windows::Win32::UI::WindowsAndMessaging::{
                    GetForegroundWindow, GetWindowThreadProcessId,
                };
                let foreground = GetForegroundWindow();
                let mut owner = 0;
                GetWindowThreadProcessId(foreground, Some(&mut owner));
                foreground.0 as usize as u64 == window && owner == pid as u32
            };
            #[cfg(target_os = "macos")]
            let matches = super::macos::run_on_main_for_enigo(move || {
                Ok(
                    crate::computer_use::macos_bg_input::frontmost_pid_macos() == Some(pid)
                        && u32::try_from(window).ok().is_some_and(|window| {
                            crate::computer_use::macos_ax_ui::focused_window_id(pid) == Some(window)
                        }),
                )
            })?;
            if !matches {
                return Err(OpenBitFunError::tool(
                    "[FOREGROUND_TARGET_MISMATCH] The actual foreground window differs from the observed target. No input was submitted. Use activate_app for the intended window, then observe again before global input.",
                ));
            }
        }
        // Linux seat methods independently validate the consented portal target.
        Ok(())
    }

    pub(super) fn activate_prepared_window() -> OpenBitFunResult<()> {
        crate::computer_use::control_session::foreground_allowed()
            .map_err(OpenBitFunError::tool)?;
        #[cfg(any(target_os = "macos", target_os = "windows"))]
        {
            let target = crate::computer_use::control_session::snapshot().target;
            let (pid, window) = target.as_deref().and_then(parse_native_target).ok_or_else(|| {
                OpenBitFunError::tool("[FOREGROUND_TARGET_REQUIRED] Select the intended native window before activation")
            })?;
            #[cfg(target_os = "windows")]
            unsafe {
                use windows::Win32::Foundation::HWND;
                use windows::Win32::UI::WindowsAndMessaging::{
                    GetWindowThreadProcessId, IsWindow, SetForegroundWindow,
                };
                let hwnd = HWND(window as usize as *mut _);
                let mut owner = 0;
                GetWindowThreadProcessId(hwnd, Some(&mut owner));
                if !IsWindow(Some(hwnd)).as_bool() || owner != pid as u32 {
                    return Err(OpenBitFunError::tool(
                        "[AX_STALE_TARGET] The selected window closed or changed owner",
                    ));
                }
                if !SetForegroundWindow(hwnd).as_bool() {
                    return Err(OpenBitFunError::tool("[FOREGROUND_ACTIVATION_DENIED] Windows did not grant foreground focus; no keyboard or pointer input was sent"));
                }
            }
            #[cfg(target_os = "macos")]
            super::macos::run_on_main_for_enigo(move || {
                let window = u32::try_from(window).map_err(|_| {
                    OpenBitFunError::tool("[INVALID_PARAMS] Invalid macOS window ID")
                })?;
                if !crate::computer_use::macos_bg_input::activate_pid_macos(pid)? {
                    return Err(OpenBitFunError::tool("[FOREGROUND_ACTIVATION_DENIED] macOS did not activate the selected application"));
                }
                crate::computer_use::macos_ax_ui::raise_window(pid, window)
            })?;
            // Activation is asynchronous on some hosts. Poll ownership only;
            // never repeat activation or send a speculative input.
            for _ in 0..10 {
                crate::computer_use::control_session::foreground_allowed()
                    .map_err(OpenBitFunError::tool)?;
                if Self::ensure_foreground_target().is_ok() {
                    return Ok(());
                }
                std::thread::sleep(std::time::Duration::from_millis(50));
            }
            Self::ensure_foreground_target()
        }
        #[cfg(not(any(target_os = "macos", target_os = "windows")))]
        Err(OpenBitFunError::tool(
            "[ACTIVATION_UNSUPPORTED] Native-window activation is unavailable. Use the consented Linux portal surface, observe it, and verify focus before seat input; AT-SPI PID selection is separate.",
        ))
    }
}

#[cfg(test)]
mod tests {
    use super::parse_native_target;

    #[test]
    fn native_target_requires_both_valid_identities() {
        assert_eq!(parse_native_target("pid:123/window:456"), Some((123, 456)));
        for target in [
            "pid:0/window:1",
            "pid:2/window:0",
            "pid:2",
            "portal:2",
            "atspi:2",
            "pid:2/window:4/other",
        ] {
            assert_eq!(parse_native_target(target), None);
        }
    }
}
