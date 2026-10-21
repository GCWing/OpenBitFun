//! Post-input repaint settling on the bound window stream. Waiting never sends
//! input, activates a window or substitutes another capture source.
use super::DesktopComputerUseHost;
use openbitfun_core::agentic::tools::computer_use_host::{
    AppInputSettle, AppInputSettlePolicy, AppSelector,
};
use openbitfun_core::util::errors::{OpenBitFunError, OpenBitFunResult};

#[cfg(any(target_os = "macos", target_os = "windows"))]
fn bound_window(app: &AppSelector) -> Result<(i32, u64), AppInputSettle> {
    let target = crate::computer_use::control_session::snapshot().target;
    let Some((pid, window)) = target
        .as_deref()
        .and_then(super::foreground::parse_native_target)
    else {
        return Err(AppInputSettle::unavailable(
            "No bound window stream; the observation was taken without waiting for repaint",
        ));
    };
    if app.pid.is_some_and(|requested| requested != pid)
        || app.window_id.is_some_and(|requested| requested != window)
    {
        return Err(AppInputSettle::unavailable(
            "The selected application is not the bound capture target",
        ));
    }
    Ok((pid, window))
}

impl DesktopComputerUseHost {
    pub(super) async fn settle_after_input_impl(
        &self,
        app: AppSelector,
        policy: AppInputSettlePolicy,
    ) -> OpenBitFunResult<AppInputSettle> {
        #[cfg(target_os = "macos")]
        {
            let (pid, window) = match bound_window(&app) {
                Ok(bound) => bound,
                Err(unavailable) => return Ok(unavailable),
            };
            let window = u32::try_from(window).map_err(|_| {
                OpenBitFunError::tool(
                    "[INVALID_PARAMS] window_id exceeds the macOS window ID range",
                )
            })?;
            crate::computer_use::control_session::spawn_blocking(move || {
                crate::computer_use::macos_capture::wait_settled(pid, window, policy)
            })
            .await
            .map_err(|error| OpenBitFunError::tool(error.to_string()))?
            .map_err(OpenBitFunError::tool)
        }
        #[cfg(target_os = "windows")]
        {
            let (_, window) = match bound_window(&app) {
                Ok(bound) => bound,
                Err(unavailable) => return Ok(unavailable),
            };
            let window = isize::try_from(window).map_err(|_| {
                OpenBitFunError::tool(
                    "[INVALID_PARAMS] window_id exceeds the native window handle range",
                )
            })?;
            crate::computer_use::control_session::spawn_blocking(move || {
                crate::computer_use::windows_wgc_capture::wait_settled(
                    windows::Win32::Foundation::HWND(window as *mut std::ffi::c_void),
                    policy,
                )
            })
            .await
            .map_err(|error| OpenBitFunError::tool(error.to_string()))?
        }
        #[cfg(target_os = "linux")]
        {
            let _ = app;
            match crate::computer_use::linux_control::session().ok().flatten() {
                Some(session) => session
                    .wait_settled(policy)
                    .await
                    .map_err(OpenBitFunError::tool),
                None => Ok(AppInputSettle::unavailable(
                    "Accessibility-only observation has no frame stream; the observation was taken without waiting for repaint",
                )),
            }
        }
        #[cfg(not(any(target_os = "macos", target_os = "windows", target_os = "linux")))]
        {
            let _ = (app, policy);
            Ok(AppInputSettle::unavailable(
                "This platform has no window frame stream",
            ))
        }
    }
}
