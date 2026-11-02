//! Debug overlay utilities for Computer Use screenshots.
//!
//! Provides a red crosshair marker that can be drawn on debug screenshots
//! to verify coordinate targeting — useful for checking that the
//! coordinates an agent computed actually land on the intended UI element.
//!
//! Ported from cua-driver-rs `cua-driver-core/src/image_utils.rs`
//! `crosshair_png_bytes` / `write_crosshair_png`, adapted to OpenBitFun's
//! `image` pipeline (`RgbaImage` + `OpenBitFunError`).

#![allow(dead_code)]

use image::{Rgba, RgbaImage};
use openbitfun_agent_tools::computer_use_host::error::{OpenBitFunError, OpenBitFunResult};
use std::io::Cursor;

/// Half-length of each crosshair arm in pixels (arm spans ±`ARM_LEN`).
const ARM_LEN: i32 = 10;
/// Stroke thickness of each arm in pixels.
const THICKNESS: i32 = 2;
/// Radius of the filled center circle in pixels.
const CIRCLE_R: i32 = 5;

/// Draw a crosshair marker at `(x, y)` on an RGBA image buffer.
///
/// The crosshair is 21px wide (±10px from center) with a 2px-thick stroke
/// for both arms and a small 5px-radius filled circle at the center. Pixels
/// outside the image bounds are skipped silently, so coordinates at the
/// edges (e.g. `(0, 0)` or `(width-1, height-1)`) never panic.
///
/// `color` is alpha-composited over the existing pixels, so a semi-transparent
/// color (e.g. alpha 180) blends with the underlying screenshot instead of
/// fully occluding it.
fn draw_crosshair(img: &mut RgbaImage, x: u32, y: u32, color: Rgba<u8>) {
    let (w, h) = img.dimensions();
    if x >= w || y >= h {
        return;
    }
    let xi = x as i32;
    let yi = y as i32;
    let iw = w as i32;
    let ih = h as i32;

    // Horizontal arm: spans ±ARM_LEN along x, THICKNESS rows tall.
    for dx in -ARM_LEN..=ARM_LEN {
        for toff in 0..THICKNESS {
            let off = toff - THICKNESS / 2;
            put_pixel(img, xi + dx, yi + off, color, iw, ih);
        }
    }

    // Vertical arm: spans ±ARM_LEN along y, THICKNESS columns wide.
    for dy in -ARM_LEN..=ARM_LEN {
        for toff in 0..THICKNESS {
            let off = toff - THICKNESS / 2;
            put_pixel(img, xi + off, yi + dy, color, iw, ih);
        }
    }

    // Filled center circle of radius CIRCLE_R.
    for dy in -CIRCLE_R..=CIRCLE_R {
        for dx in -CIRCLE_R..=CIRCLE_R {
            if dx * dx + dy * dy <= CIRCLE_R * CIRCLE_R {
                put_pixel(img, xi + dx, yi + dy, color, iw, ih);
            }
        }
    }
}

/// Convenience wrapper around [`draw_crosshair`] using a semi-transparent
/// red marker `(255, 0, 0, 180)` — visible over both light and dark UI
/// without fully hiding the pixel underneath.
fn draw_click_marker(img: &mut RgbaImage, x: u32, y: u32) {
    let red = Rgba([255u8, 0, 0, 180]);
    draw_crosshair(img, x, y, red);
}

/// Load a JPEG/PNG screenshot from `raw` bytes, draw a red click crosshair
/// at `(x, y)`, and re-encode the result as JPEG.
///
/// `mime` selects the input decoder (`image/jpeg`, `image/jpg`, or
/// `image/png`); the bytes themselves are content-detected by the `image`
/// crate so a slightly mismatched mime still decodes when the magic bytes
/// are valid. The output is always JPEG so it can drop into the existing
/// screenshot pipeline without changing any downstream wiring.
pub(super) fn annotate_screenshot_with_click(
    raw: &[u8],
    mime: &str,
    x: u32,
    y: u32,
) -> OpenBitFunResult<Vec<u8>> {
    let mime_lower = mime.to_ascii_lowercase();
    let supported = matches!(
        mime_lower.as_str(),
        "image/jpeg" | "image/jpg" | "image/png"
    );
    if !supported {
        return Err(OpenBitFunError::tool(format!(
            "debug_overlay: unsupported mime type: {mime}"
        )));
    }

    let mut img = image::load_from_memory(raw)
        .map_err(|e| OpenBitFunError::tool(format!("debug_overlay: decode image failed: {e}")))?
        .to_rgba8();
    draw_click_marker(&mut img, x, y);

    let mut out = Vec::with_capacity(raw.len());
    // image 0.25: JPEG has no alpha channel and the encoder rejects Rgba8
    // input, so flatten to RGB before encoding.
    let rgb = image::DynamicImage::ImageRgba8(img).to_rgb8();
    image::codecs::jpeg::JpegEncoder::new_with_quality(&mut Cursor::new(&mut out), 80)
        .encode(
            rgb.as_raw(),
            rgb.width(),
            rgb.height(),
            image::ExtendedColorType::Rgb8,
        )
        .map_err(|e| OpenBitFunError::tool(format!("debug_overlay: encode JPEG failed: {e}")))?;
    Ok(out)
}

/// Bounds-checked, alpha-composited pixel write. Mirrors the blending
/// convention used by `som_overlay::put_pixel` so semi-transparent marker
/// colors blend consistently across the Computer Use image pipeline.
#[inline]
fn put_pixel(img: &mut RgbaImage, x: i32, y: i32, color: Rgba<u8>, iw: i32, ih: i32) {
    if x < 0 || y < 0 || x >= iw || y >= ih {
        return;
    }
    let dst = img.get_pixel_mut(x as u32, y as u32);
    let a = color.0[3] as u32;
    if a == 255 {
        *dst = color;
        return;
    }
    if a == 0 {
        return;
    }
    let inv = 255 - a;
    for c in 0..3 {
        dst.0[c] = ((color.0[c] as u32 * a + dst.0[c] as u32 * inv) / 255) as u8;
    }
    dst.0[3] = 255;
}

#[cfg(test)]
mod tests {
    use super::*;
    use image::{ImageBuffer, ImageEncoder};
    use std::io::Cursor;

    /// Build a solid-black RGBA image of the given size.
    fn blank_rgba(w: u32, h: u32) -> RgbaImage {
        let mut img: RgbaImage = ImageBuffer::new(w, h);
        for px in img.pixels_mut() {
            *px = Rgba([0, 0, 0, 255]);
        }
        img
    }

    /// Encode a solid-color JPEG (matches the `som_overlay` test helper style).
    fn solid_jpeg(w: u32, h: u32) -> Vec<u8> {
        let mut buf: RgbaImage = ImageBuffer::new(w, h);
        for px in buf.pixels_mut() {
            *px = Rgba([20, 20, 20, 255]);
        }
        let rgb = image::DynamicImage::ImageRgba8(buf).to_rgb8();
        let mut out = Vec::new();
        let encoder = image::codecs::jpeg::JpegEncoder::new_with_quality(&mut out, 90);
        encoder
            .write_image(rgb.as_raw(), w, h, image::ExtendedColorType::Rgb8)
            .unwrap();
        out
    }

    #[test]
    fn crosshair_drawn_at_correct_position() {
        let mut img = blank_rgba(60, 60);
        draw_crosshair(&mut img, 30, 30, Rgba([255, 0, 0, 255]));

        // Center.
        assert_eq!(img.get_pixel(30, 30).0, [255, 0, 0, 255]);
        // Horizontal arm endpoints (±10 from center, on a red row).
        assert_eq!(img.get_pixel(20, 30).0, [255, 0, 0, 255]);
        assert_eq!(img.get_pixel(40, 30).0, [255, 0, 0, 255]);
        // Vertical arm endpoints (±10 from center, on a red column).
        assert_eq!(img.get_pixel(30, 20).0, [255, 0, 0, 255]);
        assert_eq!(img.get_pixel(30, 40).0, [255, 0, 0, 255]);
        // 2px thickness: the row just above center is also red.
        assert_eq!(img.get_pixel(20, 29).0, [255, 0, 0, 255]);
        // Pixels just past the arm length are NOT red.
        assert_ne!(img.get_pixel(19, 30).0, [255, 0, 0, 255]);
        assert_ne!(img.get_pixel(41, 30).0, [255, 0, 0, 255]);
        assert_ne!(img.get_pixel(30, 19).0, [255, 0, 0, 255]);
        assert_ne!(img.get_pixel(30, 41).0, [255, 0, 0, 255]);
    }

    #[test]
    fn center_pixels_are_red() {
        let mut img = blank_rgba(40, 40);
        draw_crosshair(&mut img, 20, 20, Rgba([255, 0, 0, 255]));
        assert_eq!(img.get_pixel(20, 20).0, [255, 0, 0, 255]);
    }

    #[test]
    fn does_not_panic_at_edge_coordinates() {
        // Top-left corner.
        let mut img = blank_rgba(30, 30);
        draw_crosshair(&mut img, 0, 0, Rgba([255, 0, 0, 255]));
        assert_eq!(img.get_pixel(0, 0).0, [255, 0, 0, 255]);

        // Bottom-right corner (width-1, height-1).
        draw_crosshair(&mut img, 29, 29, Rgba([255, 0, 0, 255]));
        assert_eq!(img.get_pixel(29, 29).0, [255, 0, 0, 255]);
    }

    #[test]
    fn out_of_bounds_coordinate_is_noop() {
        let mut img = blank_rgba(10, 10);
        draw_crosshair(&mut img, 100, 100, Rgba([255, 0, 0, 255]));
        for x in 0..10 {
            for y in 0..10 {
                assert_ne!(img.get_pixel(x, y).0, [255, 0, 0, 255]);
            }
        }
    }

    #[test]
    fn draw_click_marker_blends_center() {
        let mut img = blank_rgba(40, 40);
        draw_click_marker(&mut img, 20, 20);

        // A pixel drawn exactly once (arm only, outside the center circle)
        // blends red-over-black at alpha 180 -> R = 180.
        // (10, 20) is on the horizontal arm at distance 10 > circle radius 5,
        // and not on the vertical arm, so it is touched by a single put_pixel.
        let arm = img.get_pixel(10, 20);
        assert_eq!(arm.0, [180, 0, 0, 255]);

        // The exact center is drawn three times (horizontal arm + vertical arm
        // + filled circle), so it blends towards opaque red (R well above 180).
        let center = img.get_pixel(20, 20);
        assert!(
            center.0[0] > 200,
            "center red should be near-opaque: {:?}",
            center
        );
        assert_eq!(center.0[1], 0);
        assert_eq!(center.0[2], 0);
    }

    #[test]
    fn annotate_jpeg_round_trip_preserves_dimensions() {
        let jpeg = solid_jpeg(80, 60);
        let out = annotate_screenshot_with_click(&jpeg, "image/jpeg", 40, 30).expect("annotate");
        let decoded = image::load_from_memory(&out).expect("decode");
        assert_eq!(decoded.width(), 80);
        assert_eq!(decoded.height(), 60);
    }

    #[test]
    fn annotate_png_input_returns_jpeg() {
        let mut buf: RgbaImage = ImageBuffer::new(40, 40);
        for px in buf.pixels_mut() {
            *px = Rgba([10, 10, 10, 255]);
        }
        let mut png = Vec::new();
        image::DynamicImage::ImageRgba8(buf)
            .write_to(&mut Cursor::new(&mut png), image::ImageFormat::Png)
            .unwrap();
        let out = annotate_screenshot_with_click(&png, "image/png", 20, 20).expect("annotate");
        // JPEG magic: FF D8 FF.
        assert_eq!(&out[..3], &[0xFF, 0xD8, 0xFF]);
    }

    #[test]
    fn annotate_rejects_unsupported_mime() {
        let jpeg = solid_jpeg(20, 20);
        let res = annotate_screenshot_with_click(&jpeg, "image/gif", 10, 10);
        assert!(res.is_err());
    }
}
