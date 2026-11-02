//! Coordinate transforms for an observed surface, independent of the host OS.
//!
//! Adapted from computer-use-rust's sharing::CoordinateMap. The image's actual
//! content rectangle and the captured surface bounds are the only scale source;
//! display DPI, the human pointer and the current foreground window are not.

use crate::computer_use::{ComputerUseImageContentRect, ComputerUseImageGlobalBounds};

#[derive(Clone, Copy, Debug, PartialEq)]
pub struct CaptureGeometry {
    image: [u32; 2],
    content: [u32; 4],
    bounds: [f64; 4],
}

impl CaptureGeometry {
    pub fn new(
        width: u32,
        height: u32,
        content: &ComputerUseImageContentRect,
        bounds: &ComputerUseImageGlobalBounds,
    ) -> Result<Self, String> {
        let geometry = Self {
            image: [width, height],
            content: [content.left, content.top, content.width, content.height],
            bounds: [bounds.left, bounds.top, bounds.width, bounds.height],
        };
        geometry.validate()?;
        Ok(geometry)
    }

    fn validate(&self) -> Result<(), String> {
        let [left, top, width, height] = self.content;
        let [x, y, span_x, span_y] = self.bounds;
        if self.image.contains(&0)
            || width == 0
            || height == 0
            || left
                .checked_add(width)
                .is_none_or(|right| right > self.image[0])
            || top
                .checked_add(height)
                .is_none_or(|bottom| bottom > self.image[1])
            || !self.bounds.iter().all(|value| value.is_finite())
            || span_x <= 0.0
            || span_y <= 0.0
            || !(x + span_x).is_finite()
            || !(y + span_y).is_finite()
        {
            return Err("[INVALID_GEOMETRY] Capture requires finite bounds and a nonempty content rectangle inside the image".into());
        }
        Ok(())
    }

    /// Image pixel indices address their centers. Padding and out-of-range
    /// points fail; clamping them could silently click a different control.
    pub fn image_to_global(&self, x: i32, y: i32) -> Result<(f64, f64), String> {
        let [left, top, width, height] = self.content;
        let x = i64::from(x) - i64::from(left);
        let y = i64::from(y) - i64::from(top);
        if x < 0 || y < 0 || x >= i64::from(width) || y >= i64::from(height) {
            return Err("[INVALID_COORDINATES] Point is outside the captured image content (including padding)".into());
        }
        Ok((
            self.bounds[0] + (x as f64 + 0.5) * self.bounds[2] / f64::from(width),
            self.bounds[1] + (y as f64 + 0.5) * self.bounds[3] / f64::from(height),
        ))
    }

    /// Legacy normalized coordinates select the surface's native point grid.
    /// Preserve endpoint semantics, while rejecting out-of-range values.
    pub fn normalized_to_global(&self, x: i32, y: i32) -> Result<(f64, f64), String> {
        if !(0..=1000).contains(&x) || !(0..=1000).contains(&y) {
            return Err(
                "[INVALID_COORDINATES] Normalized coordinates must be within 0..=1000".into(),
            );
        }
        let axis = |origin: f64, span: f64, value: i32| {
            origin + f64::from(value) / 1000.0 * (span - 1.0).max(0.0) + span.min(1.0) / 2.0
        };
        Ok((
            axis(self.bounds[0], self.bounds[2], x),
            axis(self.bounds[1], self.bounds[3], y),
        ))
    }

    pub fn image_delta_to_global(&self, dx: i32, dy: i32) -> (f64, f64) {
        (
            f64::from(dx) * self.bounds[2] / f64::from(self.content[2]),
            f64::from(dy) * self.bounds[3] / f64::from(self.content[3]),
        )
    }

    /// Continuous image coordinates are used by a preview gesture. Unlike
    /// integer pixel indices they already describe their sub-pixel location.
    pub fn image_point_to_global(&self, x: f64, y: f64) -> Result<(f64, f64), String> {
        let [left, top, width, height] = self.content.map(f64::from);
        if !x.is_finite()
            || !y.is_finite()
            || x < left
            || y < top
            || x >= left + width
            || y >= top + height
        {
            return Err("[INVALID_COORDINATES] Point is outside captured image content".into());
        }
        Ok((
            self.bounds[0] + (x - left) * self.bounds[2] / width,
            self.bounds[1] + (y - top) * self.bounds[3] / height,
        ))
    }

    /// The global frame covered by an image pixel rectangle. The rectangle
    /// must lie inside the image content; padding is never part of a region.
    pub fn image_rect_to_global(
        &self,
        x: u32,
        y: u32,
        width: u32,
        height: u32,
    ) -> Result<[f64; 4], String> {
        let [left, top, content_width, content_height] = self.content;
        let inside = width > 0
            && height > 0
            && x >= left
            && y >= top
            && x.checked_add(width)
                .is_some_and(|right| right <= left + content_width)
            && y.checked_add(height)
                .is_some_and(|bottom| bottom <= top + content_height);
        if !inside {
            return Err("[INVALID_COORDINATES] Region must be a nonempty rectangle inside the captured image content".into());
        }
        let scale_x = self.bounds[2] / f64::from(content_width);
        let scale_y = self.bounds[3] / f64::from(content_height);
        Ok([
            self.bounds[0] + f64::from(x - left) * scale_x,
            self.bounds[1] + f64::from(y - top) * scale_y,
            f64::from(width) * scale_x,
            f64::from(height) * scale_y,
        ])
    }

    pub fn global_to_image(&self, x: f64, y: f64) -> Result<(f64, f64), String> {
        if !contains(self.bounds, [x, y]) {
            return Err("[INVALID_COORDINATES] Point is outside the captured window".into());
        }
        Ok((
            f64::from(self.content[0])
                + (x - self.bounds[0]) / self.bounds[2] * f64::from(self.content[2]),
            f64::from(self.content[1])
                + (y - self.bounds[1]) / self.bounds[3] * f64::from(self.content[3]),
        ))
    }

    pub fn fit_preview(&self, available: [f64; 4]) -> Result<PreviewGeometry, String> {
        if !valid_bounds(available) {
            return Err("[INVALID_GEOMETRY] Preview bounds must be finite and positive".into());
        }
        let scale =
            (available[2] / f64::from(self.image[0])).min(available[3] / f64::from(self.image[1]));
        let width = f64::from(self.image[0]) * scale;
        let height = f64::from(self.image[1]) * scale;
        let bounds = [
            available[0] + (available[2] - width) / 2.0,
            available[1] + (available[3] - height) / 2.0,
            width,
            height,
        ];
        if !valid_bounds(bounds) {
            return Err("[INVALID_GEOMETRY] Preview projection overflowed".into());
        }
        Ok(PreviewGeometry {
            capture: *self,
            bounds,
        })
    }

    pub fn same_projection(&self, other: &Self) -> bool {
        self.image == other.image
            && self.content == other.content
            && self.bounds[2..] == other.bounds[2..]
    }

    /// A moved window preserves local coordinates; resizing requires another
    /// observation. Bounds stay fractional (macOS points) or physical pixels
    /// (Windows), according to the native provider's coordinate contract.
    pub fn at_bounds(mut self, bounds: [f64; 4]) -> Result<Self, String> {
        if bounds[2..] != self.bounds[2..] {
            return Err(
                "[STALE_CAPTURE] Target resized; observe again before coordinate input".into(),
            );
        }
        self.bounds = bounds;
        self.validate()?;
        Ok(self)
    }

    pub fn bounds(&self) -> [f64; 4] {
        self.bounds
    }
}

fn valid_bounds(bounds: [f64; 4]) -> bool {
    bounds.iter().all(|value| value.is_finite())
        && bounds[2] > 0.0
        && bounds[3] > 0.0
        && (bounds[0] + bounds[2]).is_finite()
        && (bounds[1] + bounds[3]).is_finite()
}
fn contains(bounds: [f64; 4], point: [f64; 2]) -> bool {
    point.iter().all(|value| value.is_finite())
        && point[0] >= bounds[0]
        && point[1] >= bounds[1]
        && point[0] < bounds[0] + bounds[2]
        && point[1] < bounds[1] + bounds[3]
}

/// Aspect-fit preview geometry, migrated from sharing::CoordinateMap. Preview
/// letterboxing and padding inside the capture are different excluded regions.
#[derive(Debug, Clone, Copy)]
pub struct PreviewGeometry {
    capture: CaptureGeometry,
    bounds: [f64; 4],
}
impl PreviewGeometry {
    pub fn bounds(&self) -> [f64; 4] {
        self.bounds
    }
    pub fn preview_to_image(&self, x: f64, y: f64) -> Result<(f64, f64), String> {
        if !contains(self.bounds, [x, y]) {
            return Err("[INVALID_COORDINATES] Point is outside the preview image, including letterbox margins".into());
        }
        let image = (
            (x - self.bounds[0]) / self.bounds[2] * f64::from(self.capture.image[0]),
            (y - self.bounds[1]) / self.bounds[3] * f64::from(self.capture.image[1]),
        );
        self.capture.image_point_to_global(image.0, image.1)?;
        Ok(image)
    }
    pub fn preview_to_global(&self, x: f64, y: f64) -> Result<(f64, f64), String> {
        let image = self.preview_to_image(x, y)?;
        self.capture.image_point_to_global(image.0, image.1)
    }
    pub fn image_to_preview(&self, x: f64, y: f64) -> Result<(f64, f64), String> {
        self.capture.image_point_to_global(x, y)?;
        Ok((
            self.bounds[0] + x / f64::from(self.capture.image[0]) * self.bounds[2],
            self.bounds[1] + y / f64::from(self.capture.image[1]) * self.bounds[3],
        ))
    }
    pub fn global_to_preview(&self, x: f64, y: f64) -> Result<(f64, f64), String> {
        let image = self.capture.global_to_image(x, y)?;
        self.image_to_preview(image.0, image.1)
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn geometry() -> CaptureGeometry {
        CaptureGeometry::new(
            220,
            140,
            &ComputerUseImageContentRect {
                left: 10,
                top: 20,
                width: 200,
                height: 100,
            },
            &ComputerUseImageGlobalBounds {
                left: -1200.25,
                top: 40.5,
                width: 400.0,
                height: 150.0,
            },
        )
        .unwrap()
    }

    #[test]
    fn mixed_scale_negative_origin_and_padding_use_the_observed_surface() {
        let map = geometry();
        assert_eq!(map.image_to_global(10, 20).unwrap(), (-1199.25, 41.25));
        assert_eq!(map.image_to_global(209, 119).unwrap(), (-801.25, 189.75));
        assert_eq!(map.image_delta_to_global(4, -3), (8.0, -4.5));
        for point in [
            (9, 20),
            (10, 19),
            (210, 20),
            (10, 120),
            (-1, 20),
            (i32::MIN, i32::MAX),
        ] {
            assert!(map.image_to_global(point.0, point.1).is_err(), "{point:?}");
        }
    }

    #[test]
    fn movement_preserves_fractional_coordinates_but_even_small_resizes_invalidate() {
        let before = geometry();
        let after = before.at_bounds([10.25, -50.0, 400.0, 150.0]).unwrap();
        assert!(before.same_projection(&after));
        assert_eq!(after.image_to_global(10, 20).unwrap(), (11.25, -49.25));
        assert!(before.at_bounds([0.0, 0.0, 400.5, 150.0]).is_err());
        assert!(before.at_bounds([f64::NAN, 0.0, 400.0, 150.0]).is_err());
    }

    #[test]
    fn malformed_or_overflowing_geometry_is_never_actionable() {
        let mut content = ComputerUseImageContentRect {
            left: 0,
            top: 0,
            width: 10,
            height: 10,
        };
        let mut bounds = ComputerUseImageGlobalBounds {
            left: 0.0,
            top: 0.0,
            width: 10.0,
            height: 10.0,
        };
        assert!(CaptureGeometry::new(0, 10, &content, &bounds).is_err());
        content.left = u32::MAX;
        assert!(CaptureGeometry::new(u32::MAX, 10, &content, &bounds).is_err());
        content.left = 0;
        bounds.width = f64::INFINITY;
        assert!(CaptureGeometry::new(10, 10, &content, &bounds).is_err());
        bounds.width = f64::MAX;
        bounds.left = f64::MAX;
        assert!(CaptureGeometry::new(10, 10, &content, &bounds).is_err());
    }

    #[test]
    fn image_regions_map_to_the_covered_global_frame_and_reject_padding() {
        let map = geometry();
        assert_eq!(
            map.image_rect_to_global(10, 20, 200, 100).unwrap(),
            [-1200.25, 40.5, 400.0, 150.0]
        );
        assert_eq!(
            map.image_rect_to_global(60, 40, 50, 20).unwrap(),
            [-1100.25, 70.5, 100.0, 30.0]
        );
        for (x, y, width, height) in [
            (9, 20, 10, 10),
            (10, 19, 10, 10),
            (200, 20, 11, 10),
            (10, 110, 10, 11),
            (10, 20, 0, 10),
            (u32::MAX, 20, 10, 10),
        ] {
            assert!(
                map.image_rect_to_global(x, y, width, height).is_err(),
                "{x},{y},{width},{height}"
            );
        }
    }

    #[test]
    fn normalized_endpoints_preserve_legacy_mapping_without_clamping() {
        let map = geometry();
        assert_eq!(
            map.normalized_to_global(0, 1000).unwrap(),
            (-1199.75, 190.0)
        );
        assert!(map.normalized_to_global(-1, 0).is_err());
        assert!(map.normalized_to_global(0, 1001).is_err());
    }

    #[test]
    fn preview_letterbox_and_capture_padding_are_rejected_independently() {
        let capture = geometry();
        let map = capture.fit_preview([10.0, 20.0, 440.0, 440.0]).unwrap();
        assert_eq!(map.bounds(), [10.0, 100.0, 440.0, 280.0]);
        assert!(map.preview_to_image(20.0, 30.0).is_err()); // preview margin
        assert!(map.preview_to_image(20.0, 110.0).is_err()); // capture padding
        assert!(map.preview_to_image(450.0, 200.0).is_err()); // right edge
        let point = map.image_to_preview(42.25, 62.5).unwrap();
        assert_eq!(point, (94.5, 225.0));
        assert_eq!(
            map.preview_to_image(point.0, point.1).unwrap(),
            (42.25, 62.5)
        );
        let global = map.preview_to_global(point.0, point.1).unwrap();
        assert_eq!(global, (-1135.75, 104.25));
        assert_eq!(map.global_to_preview(global.0, global.1).unwrap(), point);
    }

    #[test]
    fn preview_resize_preserves_the_same_image_point() {
        let capture = geometry();
        for size in [
            [-50.0, 20.0, 600.0, 130.0],
            [0.0, 0.0, 100.0, 800.0],
            [0.0, 0.0, 0.25, 0.5],
        ] {
            let preview = capture.fit_preview(size).unwrap();
            let point = preview.image_to_preview(100.5, 50.5).unwrap();
            let recovered = preview.preview_to_image(point.0, point.1).unwrap();
            assert!((recovered.0 - 100.5).abs() < 1e-9 && (recovered.1 - 50.5).abs() < 1e-9);
        }
        assert!(capture.fit_preview([0.0, 0.0, 0.0, 10.0]).is_err());
        assert!(capture
            .fit_preview([f64::MAX, 0.0, f64::MAX, 10.0])
            .is_err());
    }
}
