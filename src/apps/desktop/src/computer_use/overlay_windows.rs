//! Same-process transient windows (menus, popups, suggestion lists) stacked
//! above the bound window. The window server shows them as separate windows,
//! so a single-window capture omits them while a physical pointer over them
//! reaches them instead of the window beneath. Bounds use the same global
//! basis as the bound frame: macOS points, Windows physical pixels.
use openbitfun_core::agentic::tools::computer_use_host::{
    ComputerScreenshot, ComputerUseAuxiliaryWindow, ComputerUseImageContentRect,
    ComputerUseImageGlobalBounds,
};

/// At most this many front-most overlays are composited per observation.
pub(super) const MAX_OVERLAYS: usize = 8;

#[derive(Clone, Debug, PartialEq)]
pub(super) struct OverlayWindow {
    pub window_id: u64,
    pub bounds: [f64; 4],
    pub layer: Option<i32>,
    pub title: Option<String>,
}

#[derive(Clone, Debug, PartialEq)]
pub(super) struct CapturedOverlay {
    pub window: OverlayWindow,
    pub composited: bool,
    pub unavailable_reason: Option<String>,
}

pub(super) fn intersects(a: [f64; 4], b: [f64; 4]) -> bool {
    a[0] < b[0] + b[2] && b[0] < a[0] + a[2] && a[1] < b[1] + b[3] && b[1] < a[1] + a[3]
}

pub(super) fn contains(bounds: [f64; 4], x: f64, y: f64) -> bool {
    x >= bounds[0] && x < bounds[0] + bounds[2] && y >= bounds[1] && y < bounds[1] + bounds[3]
}

/// Front-most overlay containing a global point. `overlays` is front to back.
pub(super) fn topmost_at(overlays: &[OverlayWindow], x: f64, y: f64) -> Option<&OverlayWindow> {
    overlays
        .iter()
        .find(|overlay| contains(overlay.bounds, x, y))
}

/// Source-over blend of a premultiplied RGBA overlay into the bound frame.
/// The overlay is resampled to its global bounds in the frame's pixel basis
/// and clipped to the frame. Returns whether any part fell outside the frame.
pub(super) fn blend_premultiplied(
    frame: &mut [u8],
    frame_size: (u32, u32),
    frame_bounds: [f64; 4],
    overlay: &[u8],
    overlay_size: (u32, u32),
    overlay_bounds: [f64; 4],
) -> bool {
    let (fw, fh) = frame_size;
    let (ow, oh) = overlay_size;
    if fw == 0 || fh == 0 || ow == 0 || oh == 0 || frame_bounds[2] <= 0.0 || frame_bounds[3] <= 0.0
    {
        return false;
    }
    if frame.len() < fw as usize * fh as usize * 4 || overlay.len() < ow as usize * oh as usize * 4
    {
        return false;
    }
    let sx = fw as f64 / frame_bounds[2];
    let sy = fh as f64 / frame_bounds[3];
    let x0 = ((overlay_bounds[0] - frame_bounds[0]) * sx).round() as i64;
    let y0 = ((overlay_bounds[1] - frame_bounds[1]) * sy).round() as i64;
    let dw = (overlay_bounds[2] * sx).round().max(1.0) as i64;
    let dh = (overlay_bounds[3] * sy).round().max(1.0) as i64;
    let clipped = x0 < 0 || y0 < 0 || x0 + dw > fw as i64 || y0 + dh > fh as i64;
    for dy in 0..dh {
        let y = y0 + dy;
        if y < 0 || y >= fh as i64 {
            continue;
        }
        let src_y = ((dy * oh as i64) / dh).min(oh as i64 - 1) as usize;
        for dx in 0..dw {
            let x = x0 + dx;
            if x < 0 || x >= fw as i64 {
                continue;
            }
            let src_x = ((dx * ow as i64) / dw).min(ow as i64 - 1) as usize;
            let s = (src_y * ow as usize + src_x) * 4;
            let d = (y as usize * fw as usize + x as usize) * 4;
            let alpha = overlay[s + 3] as u32;
            if alpha == 0 {
                continue;
            }
            let inverse = 255 - alpha;
            for channel in 0..4 {
                let blended =
                    overlay[s + channel] as u32 + (frame[d + channel] as u32 * inverse + 127) / 255;
                frame[d + channel] = blended.min(255) as u8;
            }
        }
    }
    clipped
}

/// Projects captured overlays into the screenshot's image pixels. Overlays
/// fully outside the image are dropped; partially outside ones are clipped.
pub(super) fn auxiliary_metadata(
    shot: &ComputerScreenshot,
    overlays: &[CapturedOverlay],
) -> Vec<ComputerUseAuxiliaryWindow> {
    let (Some(content), Some(global)) = (&shot.image_content_rect, &shot.image_global_bounds)
    else {
        return Vec::new();
    };
    if global.width <= 0.0 || global.height <= 0.0 {
        return Vec::new();
    }
    let sx = content.width as f64 / global.width;
    let sy = content.height as f64 / global.height;
    let image_x = |gx: f64| content.left as f64 + (gx - global.left) * sx;
    let image_y = |gy: f64| content.top as f64 + (gy - global.top) * sy;
    let right = content.left as f64 + content.width as f64;
    let bottom = content.top as f64 + content.height as f64;
    overlays
        .iter()
        .filter_map(|captured| {
            let b = captured.window.bounds;
            let left = image_x(b[0]).round();
            let top = image_y(b[1]).round();
            let end_x = image_x(b[0] + b[2]).round();
            let end_y = image_y(b[1] + b[3]).round();
            let clip_left = left.max(content.left as f64);
            let clip_top = top.max(content.top as f64);
            let clip_right = end_x.min(right);
            let clip_bottom = end_y.min(bottom);
            if clip_right <= clip_left || clip_bottom <= clip_top {
                return None;
            }
            Some(ComputerUseAuxiliaryWindow {
                window_id: captured.window.window_id,
                image_rect: ComputerUseImageContentRect {
                    left: clip_left as u32,
                    top: clip_top as u32,
                    width: (clip_right - clip_left) as u32,
                    height: (clip_bottom - clip_top) as u32,
                },
                global_bounds: ComputerUseImageGlobalBounds {
                    left: b[0],
                    top: b[1],
                    width: b[2],
                    height: b[3],
                },
                composited: captured.composited,
                clipped: clip_left > left
                    || clip_top > top
                    || clip_right < end_x
                    || clip_bottom < end_y,
                layer: captured.window.layer,
                title: captured
                    .window
                    .title
                    .clone()
                    .filter(|title| !title.is_empty()),
                unavailable_reason: captured.unavailable_reason.clone(),
            })
        })
        .collect()
}

#[cfg(test)]
mod tests {
    use super::*;

    fn overlay(id: u64, bounds: [f64; 4]) -> OverlayWindow {
        OverlayWindow {
            window_id: id,
            bounds,
            layer: Some(101),
            title: None,
        }
    }

    #[test]
    fn topmost_prefers_front_window_and_respects_half_open_bounds() {
        let overlays = [
            overlay(2, [10.0, 10.0, 20.0, 20.0]),
            overlay(1, [0.0, 0.0, 100.0, 100.0]),
        ];
        assert_eq!(topmost_at(&overlays, 15.0, 15.0).unwrap().window_id, 2);
        assert_eq!(topmost_at(&overlays, 30.0, 30.0).unwrap().window_id, 1);
        assert!(topmost_at(&overlays, 100.0, 50.0).is_none());
    }

    #[test]
    fn blend_scales_overlay_and_reports_clipping() {
        let mut frame = vec![0u8; 4 * 4 * 4];
        let overlay_pixels = [255u8, 0, 0, 255].repeat(4);
        let clipped = blend_premultiplied(
            &mut frame,
            (4, 4),
            [100.0, 100.0, 2.0, 2.0],
            &overlay_pixels,
            (2, 2),
            [101.0, 101.0, 1.0, 1.0],
        );
        assert!(!clipped);
        let pixel = |x: usize, y: usize| &frame[(y * 4 + x) * 4..(y * 4 + x) * 4 + 4];
        assert_eq!(pixel(2, 2), [255, 0, 0, 255]);
        assert_eq!(pixel(3, 3), [255, 0, 0, 255]);
        assert_eq!(pixel(1, 1), [0, 0, 0, 0]);
        let clipped = blend_premultiplied(
            &mut frame,
            (4, 4),
            [100.0, 100.0, 2.0, 2.0],
            &overlay_pixels,
            (2, 2),
            [101.5, 99.0, 2.0, 2.0],
        );
        assert!(clipped);
    }

    #[test]
    fn blend_keeps_frame_under_transparent_and_mixes_translucent_pixels() {
        let mut frame = [0u8, 0, 200, 255].repeat(1);
        blend_premultiplied(
            &mut frame,
            (1, 1),
            [0.0, 0.0, 1.0, 1.0],
            &[0, 0, 0, 0],
            (1, 1),
            [0.0, 0.0, 1.0, 1.0],
        );
        assert_eq!(frame, [0, 0, 200, 255]);
        blend_premultiplied(
            &mut frame,
            (1, 1),
            [0.0, 0.0, 1.0, 1.0],
            &[128, 0, 0, 128],
            (1, 1),
            [0.0, 0.0, 1.0, 1.0],
        );
        assert_eq!(frame, [128, 0, 100, 255]);
    }

    #[test]
    fn metadata_projects_into_image_pixels_and_clips() {
        let shot: ComputerScreenshot = serde_json::from_value(serde_json::json!({
            "bytes": [], "mime_type": "image/jpeg", "image_width": 400, "image_height": 300,
            "native_width": 200, "native_height": 150, "display_origin_x": 0, "display_origin_y": 0,
            "vision_scale": 1.0,
            "image_content_rect": {"left": 0, "top": 0, "width": 400, "height": 300},
            "image_global_bounds": {"left": 100.0, "top": 50.0, "width": 200.0, "height": 150.0}
        }))
        .unwrap();
        let captured = |window: OverlayWindow, composited| CapturedOverlay {
            window,
            composited,
            unavailable_reason: (!composited).then(|| "AUXILIARY_CAPTURE_UNSUPPORTED".into()),
        };
        let meta = auxiliary_metadata(
            &shot,
            &[
                captured(overlay(7, [150.0, 60.0, 50.0, 40.0]), true),
                captured(overlay(8, [280.0, 180.0, 50.0, 50.0]), false),
                captured(overlay(9, [500.0, 500.0, 10.0, 10.0]), true),
            ],
        );
        assert_eq!(meta.len(), 2);
        assert_eq!(meta[0].window_id, 7);
        assert_eq!(
            meta[0].image_rect,
            ComputerUseImageContentRect {
                left: 100,
                top: 20,
                width: 100,
                height: 80
            }
        );
        assert!(!meta[0].clipped && meta[0].composited);
        assert_eq!(meta[1].image_rect.left, 360);
        assert_eq!(meta[1].image_rect.width, 40);
        assert!(meta[1].clipped && !meta[1].composited);
        assert!(meta[1].unavailable_reason.is_some());
    }
}
