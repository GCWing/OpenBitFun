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
    super::control_session::validate_observation_scope(&scope).map_err(OpenBitFunError::service)?;
    super::control_session::publish_rgba(&scope, &rgba, width, height, bounds);
    Ok(WindowCapture {
        frame_info,
        rgba,
        origin_x: bounds[0] as i32,
        origin_y: bounds[1] as i32,
        width,
        height,
    })
}
