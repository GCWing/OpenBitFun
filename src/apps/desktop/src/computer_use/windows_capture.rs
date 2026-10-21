//! Window-only WGC frames and authoritative DWM geometry.
//! There is no desktop/GDI fallback and no encode/decode round trip.
use openbitfun_core::util::errors::{OpenBitFunError, OpenBitFunResult};
use windows::Win32::Foundation::{HWND, RECT};
use windows::Win32::Graphics::Dwm::{DwmGetWindowAttribute, DWMWA_EXTENDED_FRAME_BOUNDS};

pub(super) struct WindowCapture {
    pub frame_info: openbitfun_core::agentic::tools::computer_use_host::CaptureFrameInfo,
    pub rgba: Vec<u8>,
    pub origin_x: i32,
    pub origin_y: i32,
    pub width: u32,
    pub height: u32,
    /// The bound window's open popups, front to back, composited into `rgba`
    /// unless their capture failed.
    pub auxiliary: Vec<super::overlay_windows::CapturedOverlay>,
}

/// Live physical frame geometry is also used immediately before input. Preview
/// metadata is an observation, never evidence of the window's current position.
pub(super) fn window_bounds(hwnd: HWND) -> OpenBitFunResult<[f64; 4]> {
    let mut bounds = RECT::default();
    unsafe {
        DwmGetWindowAttribute(
            hwnd,
            DWMWA_EXTENDED_FRAME_BOUNDS,
            &mut bounds as *mut _ as *mut _,
            std::mem::size_of::<RECT>() as u32,
        )
    }
    .map_err(|e| OpenBitFunError::service(format!("[CAPTURE_GEOMETRY_UNAVAILABLE] {e}")))?;
    let width = i64::from(bounds.right) - i64::from(bounds.left);
    let height = i64::from(bounds.bottom) - i64::from(bounds.top);
    if width <= 0 || height <= 0 {
        return Err(OpenBitFunError::service(
            "[CAPTURE_GEOMETRY_UNAVAILABLE] Empty window bounds",
        ));
    }
    Ok([
        bounds.left as f64,
        bounds.top as f64,
        width as f64,
        height as f64,
    ])
}

pub(super) fn screenshot_window_capture(hwnd: HWND) -> OpenBitFunResult<WindowCapture> {
    let scope = super::control_session::observation_scope().map_err(OpenBitFunError::service)?;
    let (mut rgba, width, height, frame_info) =
        super::windows_wgc_capture::capture_window_bgra(hwnd)?;
    let bounds = window_bounds(hwnd)?;
    if bounds[2] != f64::from(width) || bounds[3] != f64::from(height) {
        return Err(OpenBitFunError::service(
            "[CAPTURE_GEOMETRY_CHANGED] Refresh the resized window before input",
        ));
    }
    if width == 0 || height == 0 || u64::from(width) * u64::from(height) * 4 != rgba.len() as u64 {
        return Err(OpenBitFunError::service(
            "[CAPTURE_INVALID_FRAME] Invalid BGRA buffer",
        ));
    }
    for pixel in rgba.chunks_exact_mut(4) {
        pixel.swap(0, 2);
    }
    let auxiliary = composite_popups(hwnd, &mut rgba, (width, height), bounds);
    super::control_session::validate_observation_scope(&scope).map_err(OpenBitFunError::service)?;
    super::control_session::publish_rgba(&scope, &rgba, width, height, bounds);
    Ok(WindowCapture {
        frame_info,
        rgba,
        origin_x: bounds[0] as i32,
        origin_y: bounds[1] as i32,
        width,
        height,
        auxiliary,
    })
}

/// Paints the bound window's open popups over its capture, back to front, so
/// the observation matches what the user sees. A popup whose pixels cannot be
/// captured is still reported, with composited=false.
fn composite_popups(
    hwnd: HWND,
    rgba: &mut [u8],
    size: (u32, u32),
    bounds: [f64; 4],
) -> Vec<super::overlay_windows::CapturedOverlay> {
    let overlays = super::windows_overlay::popups_above(hwnd, bounds);
    let mut captured = Vec::with_capacity(overlays.len());
    for overlay in overlays.into_iter().rev() {
        let popup = HWND(overlay.window_id as usize as *mut _);
        let (composited, unavailable_reason) =
            match super::windows_wgc_capture::snapshot_popup(hwnd, popup) {
                Ok((mut pixels, width, height)) => {
                    for pixel in pixels.chunks_exact_mut(4) {
                        pixel.swap(0, 2);
                    }
                    super::overlay_windows::blend_premultiplied(
                        rgba,
                        size,
                        bounds,
                        &pixels,
                        (width, height),
                        overlay.bounds,
                    );
                    (true, None)
                }
                Err(error) => {
                    log::debug!(
                        "Computer use popup capture unavailable: window={}, reason={error}",
                        overlay.window_id
                    );
                    (false, Some(error.to_string()))
                }
            };
        captured.push(super::overlay_windows::CapturedOverlay {
            window: overlay,
            composited,
            unavailable_reason,
        });
    }
    captured.reverse();
    captured
}
