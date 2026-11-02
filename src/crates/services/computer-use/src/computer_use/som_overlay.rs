//! Set-of-Mark overlay renderer.
//!
//! Takes a JPEG screenshot + a list of [`InteractiveElement`]s and paints
//! numbered coloured boxes (one per element). The result is encoded back
//! into JPEG so the host can return it inside a [`ComputerScreenshot`]
//! without changing any downstream wiring.
//!
//! Design choices that matter for the model:
//!   * Each element gets a small high-contrast badge containing its `i`
//!     index in the **top-left corner** of its rectangle (TuriX-CUA
//!     convention — the model is trained to look for `[N]` markers in
//!     that location).
//!   * Box colour is keyed off the AX role so the model can disambiguate
//!     visually similar widgets (e.g. button vs. text field) without
//!     reading the tree text.
//!   * Badges drift down/right when they would overlap the previous
//!     element's badge — keeps the overlay legible on dense menus.
//!   * Font is a small 5×7 monochrome bitmap baked into this file; no
//!     extra runtime dependencies (rusttype / ab_glyph / imageproc are
//!     not pulled in).

#![allow(dead_code)]

use image::{Rgba, RgbaImage};
use openbitfun_agent_tools::computer_use_host::error::{OpenBitFunError, OpenBitFunResult};
use openbitfun_agent_tools::computer_use_host::InteractiveElement;
use std::io::Cursor;

/// Render the SoM overlay onto `jpeg_bytes` and return a fresh JPEG.
///
/// `jpeg_quality` defaults to 80 when `None`. Elements whose
/// `frame_image` is `None` are skipped silently.
pub(crate) fn render_overlay(
    jpeg_bytes: &[u8],
    elements: &[InteractiveElement],
    jpeg_quality: Option<u8>,
) -> OpenBitFunResult<Vec<u8>> {
    let img = image::load_from_memory_with_format(jpeg_bytes, image::ImageFormat::Jpeg)
        .map_err(|e| OpenBitFunError::tool(format!("som_overlay: decode JPEG failed: {e}")))?
        .to_rgba8();
    let mut canvas: RgbaImage = img;

    let mut placed_badges: Vec<(i32, i32, i32, i32)> = Vec::with_capacity(elements.len());

    for el in elements {
        let Some((x, y, w, h)) = el.frame_image else {
            continue;
        };
        if w == 0 || h == 0 {
            continue;
        }
        let color = role_color(&el.role, el.subrole.as_deref());

        draw_rect_outline(
            &mut canvas,
            x as i32,
            y as i32,
            w as i32,
            h as i32,
            color,
            2,
        );

        let label = format!("{}", el.i);
        let badge_w = (label.len() as i32) * (CHAR_W as i32 + 1) + 5;
        let badge_h = CHAR_H as i32 + 4;
        let mut bx = x as i32;
        let mut by = y as i32 - badge_h;
        if by < 0 {
            by = y as i32;
        }

        // Slide the badge along the top edge until it does not collide
        // with another element's badge (cap retries to avoid blowups).
        for _ in 0..6 {
            let collides = placed_badges.iter().any(|(px, py, pw, ph)| {
                rects_overlap(
                    Rectangle {
                        x: bx,
                        y: by,
                        width: badge_w,
                        height: badge_h,
                    },
                    Rectangle {
                        x: *px,
                        y: *py,
                        width: *pw,
                        height: *ph,
                    },
                )
            });
            if !collides {
                break;
            }
            bx += badge_w + 2;
            if bx + badge_w > canvas.width() as i32 {
                bx = x as i32;
                by += badge_h + 2;
            }
        }

        draw_filled_rect(&mut canvas, bx, by, badge_w, badge_h, color);
        draw_rect_outline(&mut canvas, bx, by, badge_w, badge_h, BADGE_BORDER, 1);
        draw_text(&mut canvas, bx + 3, by + 2, &label, BADGE_TEXT);

        placed_badges.push((bx, by, badge_w, badge_h));
    }

    let mut out = Vec::with_capacity(jpeg_bytes.len());
    let quality = jpeg_quality.unwrap_or(80);
    // image 0.25: JPEG has no alpha channel and the encoder rejects Rgba8
    // input, so flatten to RGB before encoding.
    let rgb = image::DynamicImage::ImageRgba8(canvas).to_rgb8();
    image::codecs::jpeg::JpegEncoder::new_with_quality(&mut Cursor::new(&mut out), quality)
        .encode(
            rgb.as_raw(),
            rgb.width(),
            rgb.height(),
            image::ExtendedColorType::Rgb8,
        )
        .map_err(|e| OpenBitFunError::tool(format!("som_overlay: encode JPEG failed: {e}")))?;
    Ok(out)
}

const BADGE_BORDER: Rgba<u8> = Rgba([0, 0, 0, 255]);
const BADGE_TEXT: Rgba<u8> = Rgba([255, 255, 255, 255]);

fn role_color(role: &str, subrole: Option<&str>) -> Rgba<u8> {
    if let Some(sr) = subrole {
        match sr {
            "AXCloseButton" | "AXMinimizeButton" | "AXFullScreenButton" => {
                return Rgba([200, 80, 80, 255])
            }
            "AXSecureTextField" => return Rgba([90, 110, 220, 255]),
            _ => {}
        }
    }
    match role {
        "AXButton" | "AXMenuButton" | "AXPopUpButton" => Rgba([220, 60, 60, 255]),
        "AXTextField" | "AXSecureTextField" | "AXSearchField" | "AXTextArea" => {
            Rgba([60, 110, 220, 255])
        }
        "AXCheckBox" | "AXRadioButton" | "AXSwitch" | "AXToggle" => Rgba([200, 130, 30, 255]),
        "AXLink" => Rgba([60, 160, 220, 255]),
        "AXTab" | "AXTabGroup" => Rgba([130, 80, 200, 255]),
        "AXMenu" | "AXMenuItem" | "AXMenuBarItem" => Rgba([180, 90, 180, 255]),
        "AXSlider" | "AXIncrementor" | "AXStepper" => Rgba([60, 170, 130, 255]),
        "AXRow" | "AXOutlineRow" | "AXCell" => Rgba([100, 140, 100, 255]),
        _ => Rgba([90, 90, 90, 255]),
    }
}

struct Rectangle {
    x: i32,
    y: i32,
    width: i32,
    height: i32,
}

fn rects_overlap(first: Rectangle, second: Rectangle) -> bool {
    !(first.x + first.width <= second.x
        || second.x + second.width <= first.x
        || first.y + first.height <= second.y
        || second.y + second.height <= first.y)
}

fn draw_rect_outline(
    img: &mut RgbaImage,
    x: i32,
    y: i32,
    w: i32,
    h: i32,
    color: Rgba<u8>,
    thickness: i32,
) {
    if w <= 0 || h <= 0 {
        return;
    }
    let iw = img.width() as i32;
    let ih = img.height() as i32;
    let x0 = x.max(0);
    let y0 = y.max(0);
    let x1 = (x + w).min(iw);
    let y1 = (y + h).min(ih);
    if x1 <= x0 || y1 <= y0 {
        return;
    }
    for t in 0..thickness {
        // Top + bottom edges.
        for px in x0..x1 {
            put_pixel(img, px, y0 + t, color);
            put_pixel(img, px, y1 - 1 - t, color);
        }
        // Left + right edges.
        for py in y0..y1 {
            put_pixel(img, x0 + t, py, color);
            put_pixel(img, x1 - 1 - t, py, color);
        }
    }
}

fn draw_filled_rect(img: &mut RgbaImage, x: i32, y: i32, w: i32, h: i32, color: Rgba<u8>) {
    if w <= 0 || h <= 0 {
        return;
    }
    let iw = img.width() as i32;
    let ih = img.height() as i32;
    let x0 = x.max(0);
    let y0 = y.max(0);
    let x1 = (x + w).min(iw);
    let y1 = (y + h).min(ih);
    for py in y0..y1 {
        for px in x0..x1 {
            put_pixel(img, px, py, color);
        }
    }
}

#[inline]
fn put_pixel(img: &mut RgbaImage, x: i32, y: i32, color: Rgba<u8>) {
    if x >= 0 && y >= 0 && (x as u32) < img.width() && (y as u32) < img.height() {
        // Alpha blend.
        let dst = img.get_pixel_mut(x as u32, y as u32);
        let a = color.0[3] as u32;
        if a == 255 {
            *dst = color;
            return;
        }
        let inv = 255 - a;
        for c in 0..3 {
            dst.0[c] = ((color.0[c] as u32 * a + dst.0[c] as u32 * inv) / 255) as u8;
        }
        dst.0[3] = 255;
    }
}

fn draw_text(img: &mut RgbaImage, x: i32, y: i32, text: &str, color: Rgba<u8>) {
    let mut cx = x;
    for ch in text.chars() {
        if let Some(glyph) = glyph_for(ch) {
            for (row_idx, row) in glyph.iter().enumerate() {
                for col in 0..CHAR_W {
                    let bit = (row >> (CHAR_W - 1 - col)) & 1;
                    if bit == 1 {
                        put_pixel(img, cx + col as i32, y + row_idx as i32, color);
                    }
                }
            }
        }
        cx += CHAR_W as i32 + 1;
    }
}

const CHAR_W: usize = 5;
const CHAR_H: usize = 7;

/// 5×7 bitmap font, just enough for the digits 0-9 (badge labels).
fn glyph_for(ch: char) -> Option<[u8; CHAR_H]> {
    match ch {
        '0' => Some([
            0b01110, 0b10001, 0b10011, 0b10101, 0b11001, 0b10001, 0b01110,
        ]),
        '1' => Some([
            0b00100, 0b01100, 0b00100, 0b00100, 0b00100, 0b00100, 0b01110,
        ]),
        '2' => Some([
            0b01110, 0b10001, 0b00001, 0b00010, 0b00100, 0b01000, 0b11111,
        ]),
        '3' => Some([
            0b11110, 0b00001, 0b00001, 0b01110, 0b00001, 0b00001, 0b11110,
        ]),
        '4' => Some([
            0b00010, 0b00110, 0b01010, 0b10010, 0b11111, 0b00010, 0b00010,
        ]),
        '5' => Some([
            0b11111, 0b10000, 0b11110, 0b00001, 0b00001, 0b10001, 0b01110,
        ]),
        '6' => Some([
            0b00110, 0b01000, 0b10000, 0b11110, 0b10001, 0b10001, 0b01110,
        ]),
        '7' => Some([
            0b11111, 0b00001, 0b00010, 0b00100, 0b01000, 0b01000, 0b01000,
        ]),
        '8' => Some([
            0b01110, 0b10001, 0b10001, 0b01110, 0b10001, 0b10001, 0b01110,
        ]),
        '9' => Some([
            0b01110, 0b10001, 0b10001, 0b01111, 0b00001, 0b00010, 0b01100,
        ]),
        _ => None,
    }
}

#[allow(dead_code)]
pub(crate) fn draw_text_for_test(img: &mut RgbaImage, x: i32, y: i32, text: &str) {
    draw_text(img, x, y, text, Rgba([255, 255, 255, 255]));
}

#[cfg(test)]
mod tests {
    use super::*;
    use image::{ImageBuffer, ImageEncoder};

    fn solid_jpeg(w: u32, h: u32) -> Vec<u8> {
        let mut buf: ImageBuffer<Rgba<u8>, Vec<u8>> = ImageBuffer::new(w, h);
        for px in buf.pixels_mut() {
            *px = Rgba([20, 20, 20, 255]);
        }
        let mut out = Vec::new();
        let rgb = image::DynamicImage::ImageRgba8(buf).to_rgb8();
        let encoder = image::codecs::jpeg::JpegEncoder::new_with_quality(&mut out, 90);
        encoder
            .write_image(rgb.as_raw(), w, h, image::ExtendedColorType::Rgb8)
            .unwrap();
        out
    }

    fn elem(i: u32, role: &str, frame: (u32, u32, u32, u32)) -> InteractiveElement {
        InteractiveElement {
            i,
            node_idx: i + 100,
            role: role.to_string(),
            subrole: None,
            label: Some(format!("e{i}")),
            frame_image: Some(frame),
            frame_global: None,
            enabled: true,
            focused: false,
            ax_actionable: true,
        }
    }

    #[test]
    fn renders_without_panic_and_returns_valid_jpeg() {
        let jpeg = solid_jpeg(200, 120);
        let elements = vec![
            elem(0, "AXButton", (10, 10, 60, 30)),
            elem(1, "AXTextField", (80, 10, 100, 30)),
            elem(2, "AXLink", (10, 60, 50, 20)),
        ];
        let out = render_overlay(&jpeg, &elements, Some(75)).expect("overlay encode");
        let decoded = image::load_from_memory(&out).expect("decode overlay");
        assert_eq!(decoded.width(), 200);
        assert_eq!(decoded.height(), 120);
    }

    #[test]
    fn skips_elements_without_frame() {
        let jpeg = solid_jpeg(120, 80);
        let mut e = elem(0, "AXButton", (10, 10, 30, 20));
        e.frame_image = None;
        let out = render_overlay(&jpeg, &[e], None).expect("overlay");
        let _ = image::load_from_memory(&out).expect("decode overlay");
    }

    #[test]
    fn handles_overflowing_rect() {
        let jpeg = solid_jpeg(80, 60);
        let elements = vec![elem(99, "AXButton", (70, 50, 200, 200))];
        let out = render_overlay(&jpeg, &elements, None).expect("overlay");
        let decoded = image::load_from_memory(&out).expect("decode overlay");
        assert_eq!(decoded.width(), 80);
    }

    #[test]
    fn rectangles_touching_edges_do_not_overlap() {
        assert!(!rects_overlap(
            Rectangle {
                x: 0,
                y: 0,
                width: 10,
                height: 10,
            },
            Rectangle {
                x: 10,
                y: 0,
                width: 5,
                height: 5,
            },
        ));
        assert!(!rects_overlap(
            Rectangle {
                x: 0,
                y: 0,
                width: 10,
                height: 10,
            },
            Rectangle {
                x: 0,
                y: 10,
                width: 5,
                height: 5,
            },
        ));
    }

    #[test]
    fn rectangles_with_shared_area_overlap() {
        assert!(rects_overlap(
            Rectangle {
                x: 0,
                y: 0,
                width: 10,
                height: 10,
            },
            Rectangle {
                x: 9,
                y: 9,
                width: 5,
                height: 5,
            },
        ));
    }
}
