//! Exact authorized-target capture, JPEG encoding, OCR and coordinate mapping.
//! No desktop capture or display/crop fallback is permitted when a bound window
//! or consented portal stream cannot be captured.

#[cfg(target_os = "macos")]
use super::macos;
use super::NativeComputerUseHost;
use crate::computer_use::displays::Screen;
use image::codecs::jpeg::JpegEncoder;
#[cfg(any(test, target_os = "macos", target_os = "windows"))]
use image::DynamicImage;
use image::RgbImage;
use openbitfun_agent_tools::computer_use_geometry::CaptureGeometry;
use openbitfun_agent_tools::computer_use_host::error::{OpenBitFunError, OpenBitFunResult};
#[cfg(any(test, target_os = "macos", target_os = "windows"))]
use openbitfun_agent_tools::computer_use_host::ComputerUseZoomRegion;
use openbitfun_agent_tools::computer_use_host::{
    ComputerScreenshot, ComputerUseDisplayInfo, ComputerUseImageContentRect,
    ComputerUseImageGlobalBounds, ComputerUseScreenshotParams, OcrRegionNative, OcrTextMatch,
};

#[cfg(any(test, target_os = "macos", target_os = "windows"))]
fn bound_window_identity(target: &str) -> OpenBitFunResult<(i32, isize)> {
    let identity = target
        .strip_prefix("pid:")
        .and_then(|value| value.split_once("/window:"))
        .and_then(|(pid, window)| Some((pid.parse::<i32>().ok()?, window.parse::<isize>().ok()?)))
        .filter(|(pid, window)| *pid > 0 && *window != 0);
    identity.ok_or_else(|| {
        OpenBitFunError::tool("[TARGET_INVALID] Capture requires an exact process/window identity")
    })
}

/// One validated image-to-surface transform shared by all native backends.
/// A zoomed observation covers a region of the window; its offset inside the
/// window and the window size keep it valid while the window only moves.
#[derive(Clone, Copy, Debug, PartialEq)]
pub(super) struct PointerMap {
    geometry: CaptureGeometry,
    window_offset: [f64; 2],
    window_size: [f64; 2],
    zoomed: bool,
}

impl PointerMap {
    fn full_window(geometry: CaptureGeometry) -> Self {
        let bounds = geometry.bounds();
        Self {
            geometry,
            window_offset: [0.0, 0.0],
            window_size: [bounds[2], bounds[3]],
            zoomed: false,
        }
    }

    /// The observed map that image coordinates address, valid only while it
    /// shares the window projection of the latest image. `implicit_needs_full`
    /// marks coordinates that omitted a screenshot_id they could have named.
    pub(super) fn for_coordinates(
        selected: Self,
        latest: Option<Self>,
        implicit_needs_full: bool,
    ) -> OpenBitFunResult<Self> {
        if !latest.is_some_and(|current| current.same_window_projection(&selected)) {
            return Err(OpenBitFunError::tool(
                "[STALE_CAPTURE] Screenshot does not match the target's current geometry",
            ));
        }
        // After a zoom, coordinates may come from either image; guessing the
        // region would move the pointer silently.
        if implicit_needs_full && selected.zoomed {
            return Err(OpenBitFunError::tool(
                "[SCREENSHOT_ID_REQUIRED] The latest image is a zoomed region; pass the screenshot_id of the image these coordinates come from, or observe the full window again",
            ));
        }
        Ok(selected)
    }

    #[cfg(any(test, target_os = "macos", target_os = "windows"))]
    fn window_region(
        geometry: CaptureGeometry,
        window_offset: [f64; 2],
        window_size: [f64; 2],
    ) -> Self {
        Self {
            geometry,
            window_offset,
            window_size,
            zoomed: true,
        }
    }

    /// The region of the window, relative to its origin, covered by an image
    /// pixel rectangle of this observation.
    #[cfg(any(test, target_os = "macos", target_os = "windows"))]
    fn window_region_of(&self, region: &ComputerUseZoomRegion) -> OpenBitFunResult<[f64; 4]> {
        let global = self
            .geometry
            .image_rect_to_global(region.x, region.y, region.width, region.height)
            .map_err(OpenBitFunError::tool)?;
        let bounds = self.geometry.bounds();
        Ok([
            global[0] - bounds[0] + self.window_offset[0],
            global[1] - bounds[1] + self.window_offset[1],
            global[2],
            global[3],
        ])
    }

    fn from_screenshot(shot: &ComputerScreenshot) -> OpenBitFunResult<Self> {
        let content = shot.image_content_rect.as_ref().ok_or_else(|| {
            OpenBitFunError::tool("[INVALID_GEOMETRY] Capture content rectangle unavailable")
        })?;
        let bounds = shot.image_global_bounds.as_ref().ok_or_else(|| {
            OpenBitFunError::tool(
                "[COORDINATES_UNAVAILABLE] Capture has no authoritative surface bounds",
            )
        })?;
        CaptureGeometry::new(shot.image_width, shot.image_height, content, bounds)
            .map(Self::full_window)
            .map_err(OpenBitFunError::tool)
    }
    #[cfg(target_os = "macos")]
    pub(super) fn image_delta_to_global(&self, dx: i32, dy: i32) -> OpenBitFunResult<(f64, f64)> {
        Ok(self.geometry.image_delta_to_global(dx, dy))
    }
    /// Two full-window observations must share one image projection. A
    /// zoomed region and any other observation of the window agree while the
    /// window keeps its size; each keeps its own image-to-window transform.
    pub(super) fn same_window_projection(&self, other: &Self) -> bool {
        if !self.zoomed && !other.zoomed {
            self.geometry.same_projection(&other.geometry)
        } else {
            self.window_size == other.window_size
        }
    }
    pub(super) fn at_window_bounds(self, bounds: [f64; 4]) -> OpenBitFunResult<Self> {
        if bounds[2..] != self.window_size {
            return Err(OpenBitFunError::tool(
                "[STALE_CAPTURE] Target resized; observe again before coordinate input",
            ));
        }
        let region = self.geometry.bounds();
        let geometry = self
            .geometry
            .at_bounds([
                bounds[0] + self.window_offset[0],
                bounds[1] + self.window_offset[1],
                region[2],
                region[3],
            ])
            .map_err(OpenBitFunError::tool)?;
        Ok(Self { geometry, ..self })
    }
    pub(super) fn map_image_to_global_f64(&self, x: i32, y: i32) -> OpenBitFunResult<(f64, f64)> {
        self.geometry
            .image_to_global(x, y)
            .map_err(OpenBitFunError::tool)
    }
    pub(super) fn map_normalized_to_global_f64(
        &self,
        x: i32,
        y: i32,
    ) -> OpenBitFunResult<(f64, f64)> {
        self.geometry
            .normalized_to_global(x, y)
            .map_err(OpenBitFunError::tool)
    }
}

impl NativeComputerUseHost {
    fn encode_jpeg(rgb: &RgbImage, quality: u8) -> OpenBitFunResult<Vec<u8>> {
        let mut buf = Vec::new();
        let mut enc = JpegEncoder::new_with_quality(&mut buf, quality);
        enc.encode(
            rgb.as_raw(),
            rgb.width(),
            rgb.height(),
            image::ExtendedColorType::Rgb8,
        )
        .map_err(|e| OpenBitFunError::tool(format!("JPEG encode: {}", e)))?;
        Ok(buf)
    }

    /// JPEG for OCR only: **no** pointer overlay — raw capture pixels.
    const OCR_RAW_JPEG_QUALITY: u8 = 85;

    /// Build [`ComputerScreenshot`] from a raw RGB crop; image pixels map 1:1 to `native_*` at `display_origin_*`.
    fn raw_shot_from_rgb_crop(
        rgb: RgbImage,
        display_origin_x: i32,
        display_origin_y: i32,
        native_w: u32,
        native_h: u32,
    ) -> OpenBitFunResult<ComputerScreenshot> {
        let jpeg_bytes = Self::encode_jpeg(&rgb, Self::OCR_RAW_JPEG_QUALITY)?;
        let iw = rgb.width();
        let ih = rgb.height();
        Ok(ComputerScreenshot {
            capture_frame: None,
            screenshot_id: Some(Self::next_screenshot_id()),
            bytes: jpeg_bytes,
            mime_type: "image/jpeg".to_string(),
            image_width: iw,
            image_height: ih,
            native_width: native_w,
            native_height: native_h,
            display_origin_x,
            display_origin_y,
            vision_scale: 1.0_f64,
            pointer_image_x: None,
            pointer_image_y: None,
            screenshot_crop_center: None,
            point_crop_half_extent_native: None,
            navigation_native_rect: None,
            quadrant_navigation_click_ready: false,
            image_content_rect: Some(ComputerUseImageContentRect {
                left: 0,
                top: 0,
                width: iw,
                height: ih,
            }),
            image_global_bounds: Some(ComputerUseImageGlobalBounds {
                left: display_origin_x as f64,
                top: display_origin_y as f64,
                width: native_w as f64,
                height: native_h as f64,
            }),
            implicit_confirmation_crop_applied: false,
            auxiliary_windows: Vec::new(),
            ui_tree_text: None,
        })
    }

    /// Square region in global logical coordinates for raw OCR preview crops around `(cx, cy)`.
    fn ocr_region_square_around_point(
        cx: f64,
        cy: f64,
        half: u32,
    ) -> OpenBitFunResult<OcrRegionNative> {
        let hh = half as f64;
        let x0 = (cx - hh).floor() as i32;
        let y0 = (cy - hh).floor() as i32;
        let w = half.saturating_mul(2).max(1);
        Ok(OcrRegionNative {
            x0,
            y0,
            width: w,
            height: w,
        })
    }

    /// Snapshot of all attached displays, with `is_active` / `has_pointer`
    /// flags resolved relative to `preferred_display_id` and the current
    /// mouse position.
    pub(super) fn enumerate_displays(
        preferred_display_id: Option<u32>,
        mouse_x: f64,
        mouse_y: f64,
    ) -> Vec<ComputerUseDisplayInfo> {
        let mx = mouse_x.round() as i32;
        let my = mouse_y.round() as i32;
        let pointer_display_id = Screen::from_point(mx, my).ok().map(|s| s.display_info.id);
        let active_id = preferred_display_id.or(pointer_display_id);

        let screens = match Screen::all() {
            Ok(v) => v,
            Err(_) => return vec![],
        };
        screens
            .into_iter()
            .map(|s| {
                let d = s.display_info;
                ComputerUseDisplayInfo {
                    display_id: d.id,
                    is_primary: d.is_primary,
                    is_active: Some(d.id) == active_id,
                    has_pointer: Some(d.id) == pointer_display_id,
                    origin_x: d.x,
                    origin_y: d.y,
                    width_logical: d.width,
                    height_logical: d.height,
                    scale_factor: d.scale_factor,
                    foreground_app: None,
                }
            })
            .collect()
    }
}

impl NativeComputerUseHost {
    #[cfg(target_os = "macos")]
    pub(super) async fn screenshot_for_app_pid(
        &self,
        pid: i32,
    ) -> OpenBitFunResult<ComputerScreenshot> {
        self.capture_app_pid(pid, true).await
    }

    #[cfg(target_os = "macos")]
    async fn capture_app_pid(
        &self,
        pid: i32,
        update_navigation: bool,
    ) -> OpenBitFunResult<ComputerScreenshot> {
        let (cap, scope) = crate::computer_use::control_session::spawn_blocking(move || {
            crate::computer_use::macos_capture::ensure_capture(pid, None)
                .map_err(OpenBitFunError::tool)?;
            let scope = crate::computer_use::control_session::observation_scope()
                .map_err(OpenBitFunError::tool)?;
            let cap = crate::computer_use::macos_capture::capture_frame(pid, None)
                .map_err(OpenBitFunError::tool)?;
            crate::computer_use::control_session::validate_observation_scope(&scope)
                .map_err(OpenBitFunError::tool)?;
            Ok::<_, OpenBitFunError>((cap, scope))
        })
        .await
        .map_err(|e| OpenBitFunError::tool(e.to_string()))??;
        let auxiliary = cap.auxiliary;
        let rgba = image::RgbaImage::from_raw(cap.width, cap.height, cap.rgba)
            .ok_or_else(|| OpenBitFunError::tool("CAPTURE_INVALID_FRAME"))?;
        let rgb = DynamicImage::ImageRgba8(rgba).to_rgb8();
        let origin_x = cap.bounds[0].round() as i32;
        let origin_y = cap.bounds[1].round() as i32;
        let logical_w = cap.bounds[2].round() as u32;
        let logical_h = cap.bounds[3].round() as u32;
        let mut shot = Self::raw_shot_from_rgb_crop(rgb, origin_x, origin_y, logical_w, logical_h)?;
        shot.image_global_bounds = Some(ComputerUseImageGlobalBounds {
            left: cap.bounds[0],
            top: cap.bounds[1],
            width: cap.bounds[2],
            height: cap.bounds[3],
        });
        shot.auxiliary_windows =
            crate::computer_use::overlay_windows::auxiliary_metadata(&shot, &auxiliary);
        shot.quadrant_navigation_click_ready = true;
        crate::computer_use::control_session::validate_observation_scope(&scope)
            .map_err(OpenBitFunError::tool)?;
        let map = PointerMap::from_screenshot(&shot)?;
        if !update_navigation {
            return Ok(shot);
        }
        let mut state = self.state_for_scope(&scope)?;
        state.transition_after_screenshot(
            shot.screenshot_id.clone().expect("capture identity"),
            map,
        );
        Ok(shot)
    }

    /// Capture the foreground window on Windows, build a [`ComputerScreenshot`]
    /// whose image pixels map 1:1 to the window's screen rectangle, and register
    /// the resulting [`PointerMap`] under both `pid` and the screenshot id so
    /// follow-up `ClickTarget::ImageXy` / `ImageGrid` calls resolve image pixels
    /// back to the right screen coordinates.
    ///
    /// `hwnd_raw` is the foreground window handle the AX snapshot was taken from
    /// (so the screenshot and the tree describe the same window). The capture is
    /// the window's own WGC pixels, with authoritative physical frame bounds.
    #[cfg(target_os = "windows")]
    pub(super) async fn screenshot_for_foreground_window(
        &self,
        pid: i32,
        hwnd_raw: isize,
    ) -> OpenBitFunResult<ComputerScreenshot> {
        self.capture_window(pid, hwnd_raw, true).await
    }

    #[cfg(target_os = "windows")]
    async fn capture_window(
        &self,
        _pid: i32,
        hwnd_raw: isize,
        update_navigation: bool,
    ) -> OpenBitFunResult<ComputerScreenshot> {
        use windows::Win32::Foundation::HWND;

        let scope = crate::computer_use::control_session::observation_scope()
            .map_err(OpenBitFunError::tool)?;
        let cap = crate::computer_use::control_session::spawn_blocking(move || {
            let hwnd = HWND(hwnd_raw as *mut std::ffi::c_void);
            crate::computer_use::windows_capture::screenshot_window_capture(hwnd)
        })
        .await
        .map_err(|e| OpenBitFunError::tool(e.to_string()))??;

        let auxiliary = cap.auxiliary;
        let rgba = image::RgbaImage::from_raw(cap.width, cap.height, cap.rgba)
            .ok_or_else(|| OpenBitFunError::tool("[CAPTURE_INVALID_FRAME] Invalid RGBA buffer"))?;
        let rgb = DynamicImage::ImageRgba8(rgba).to_rgb8();
        let native_w = rgb.width();
        let native_h = rgb.height();

        let mut shot =
            Self::raw_shot_from_rgb_crop(rgb, cap.origin_x, cap.origin_y, native_w, native_h)?;
        shot.capture_frame = Some(cap.frame_info);
        shot.auxiliary_windows =
            crate::computer_use::overlay_windows::auxiliary_metadata(&shot, &auxiliary);

        // Image pixels map 1:1 to the captured window rectangle (no downscale),
        // so content == image == native and the screen origin is the window's
        // (DWM-frame-adjusted) top-left.
        let map = PointerMap::from_screenshot(&shot)?;
        crate::computer_use::control_session::validate_observation_scope(&scope)
            .map_err(OpenBitFunError::tool)?;
        if update_navigation {
            self.state_for_scope(&scope)?.transition_after_screenshot(
                shot.screenshot_id.clone().expect("capture identity"),
                map,
            );
        }
        Ok(shot)
    }
}

/// Zoomed image size, in output pixels per window unit (macOS points,
/// Windows physical pixels): the long edge is enlarged toward a legible size
/// but kept below the size at which vision models downscale images again.
#[cfg(any(test, target_os = "macos", target_os = "windows"))]
const ZOOM_TARGET_LONG_EDGE: f64 = 1024.0;
#[cfg(any(test, target_os = "macos", target_os = "windows"))]
const ZOOM_MAX_LONG_EDGE: f64 = 1568.0;
#[cfg(any(test, target_os = "macos", target_os = "windows"))]
const ZOOM_MAX_SCALE: f64 = 8.0;

#[cfg(any(test, target_os = "macos", target_os = "windows"))]
fn zoom_scale(region_width: f64, region_height: f64, source_scale: f64) -> f64 {
    let long_edge = region_width.max(region_height);
    (ZOOM_TARGET_LONG_EDGE / long_edge)
        .clamp(source_scale.min(ZOOM_MAX_SCALE), ZOOM_MAX_SCALE)
        .min(ZOOM_MAX_LONG_EDGE / long_edge)
}

/// A window-relative region cut from a full-window frame. The region snaps
/// outward to whole source pixels, so the image and its mapping agree.
#[cfg(any(test, target_os = "macos", target_os = "windows"))]
struct ZoomCrop {
    image: RgbImage,
    region: [f64; 4],
}

#[cfg(any(test, target_os = "macos", target_os = "windows"))]
fn zoom_crop(
    source: &image::RgbaImage,
    window_size: [f64; 2],
    region: [f64; 4],
) -> OpenBitFunResult<ZoomCrop> {
    let scale_x = f64::from(source.width()) / window_size[0];
    let scale_y = f64::from(source.height()) / window_size[1];
    let x0 = (region[0] * scale_x).floor().max(0.0) as u32;
    let y0 = (region[1] * scale_y).floor().max(0.0) as u32;
    let x1 = ((region[0] + region[2]) * scale_x)
        .ceil()
        .min(f64::from(source.width())) as u32;
    let y1 = ((region[1] + region[3]) * scale_y)
        .ceil()
        .min(f64::from(source.height())) as u32;
    if !(scale_x.is_finite() && scale_y.is_finite()) || x1 <= x0 || y1 <= y0 {
        return Err(OpenBitFunError::tool(
            "[INVALID_COORDINATES] Zoom region is outside the bound window",
        ));
    }
    let snapped = [
        f64::from(x0) / scale_x,
        f64::from(y0) / scale_y,
        f64::from(x1 - x0) / scale_x,
        f64::from(y1 - y0) / scale_y,
    ];
    let scale = zoom_scale(snapped[2], snapped[3], scale_x.min(scale_y));
    let width = (snapped[2] * scale).round().max(1.0) as u32;
    let height = (snapped[3] * scale).round().max(1.0) as u32;
    let crop = image::imageops::crop_imm(source, x0, y0, x1 - x0, y1 - y0).to_image();
    let crop = if crop.dimensions() == (width, height) {
        crop
    } else {
        image::imageops::resize(
            &crop,
            width,
            height,
            image::imageops::FilterType::CatmullRom,
        )
    };
    Ok(ZoomCrop {
        image: DynamicImage::ImageRgba8(crop).to_rgb8(),
        region: snapped,
    })
}

#[cfg(any(target_os = "macos", target_os = "windows"))]
type DetailFrame = (
    image::RgbaImage,
    [f64; 4],
    Vec<crate::computer_use::overlay_windows::CapturedOverlay>,
);

#[cfg(any(target_os = "macos", target_os = "windows"))]
impl NativeComputerUseHost {
    /// A zoomed observation of the bound window: a fresh capture at the
    /// highest native detail, cut to a region of an earlier observation. It is
    /// recorded as the latest image with its own window-relative mapping.
    pub(super) async fn zoom_observation_impl(
        &self,
        app: openbitfun_agent_tools::computer_use_host::AppSelector,
        region: ComputerUseZoomRegion,
    ) -> OpenBitFunResult<ComputerScreenshot> {
        crate::computer_use::control_session::capture_allowed().map_err(OpenBitFunError::tool)?;
        let snapshot = crate::computer_use::control_session::snapshot();
        if snapshot.state != "active" {
            return Err(OpenBitFunError::tool(
                "[CONTROL_STOPPED] Zoom requires an active control session",
            ));
        }
        let target = snapshot.target.ok_or_else(|| {
            OpenBitFunError::tool("[TARGET_REQUIRED] Observe the bound window before zooming")
        })?;
        crate::computer_use::control_session::target_allowed(&target)
            .map_err(OpenBitFunError::tool)?;
        let (pid, window) = bound_window_identity(&target)?;
        if app.pid.is_some_and(|requested| requested != pid)
            || app
                .window_id
                .is_some_and(|requested| i64::try_from(requested).ok() != Some(window as i64))
        {
            return Err(OpenBitFunError::tool(
                "[TARGET_CHANGED] Zoom reads the bound window only; observe the requested window before zooming into it",
            ));
        }
        let scope = crate::computer_use::control_session::observation_scope()
            .map_err(OpenBitFunError::tool)?;
        let (window_region, window_size) = {
            let state = self.state_for_scope(&scope)?;
            let source = state
                .observations
                .image(Some(&region.screenshot_id))
                .map_err(OpenBitFunError::tool)?;
            if !state
                .observations
                .latest_image()
                .is_some_and(|current| current.same_window_projection(&source))
            {
                return Err(OpenBitFunError::tool(
                    "[STALE_CAPTURE] Screenshot does not match the target's current geometry; observe the window again before zooming",
                ));
            }
            (source.window_region_of(&region)?, source.window_size)
        };
        let (rgba, bounds, auxiliary) = Self::window_detail_frame(pid, window).await?;
        if bounds[2..] != window_size {
            return Err(OpenBitFunError::tool(
                "[STALE_CAPTURE] Target resized; observe the window again before zooming",
            ));
        }
        crate::computer_use::control_session::validate_observation_scope(&scope)
            .map_err(OpenBitFunError::tool)?;
        let crop = zoom_crop(&rgba, window_size, window_region)?;
        let [x, y, width, height] = crop.region;
        let left = bounds[0] + x;
        let top = bounds[1] + y;
        let mut shot = Self::raw_shot_from_rgb_crop(
            crop.image,
            left.round() as i32,
            top.round() as i32,
            width.round().max(1.0) as u32,
            height.round().max(1.0) as u32,
        )?;
        shot.image_global_bounds = Some(ComputerUseImageGlobalBounds {
            left,
            top,
            width,
            height,
        });
        shot.auxiliary_windows =
            crate::computer_use::overlay_windows::auxiliary_metadata(&shot, &auxiliary);
        let map = PointerMap::window_region(
            PointerMap::from_screenshot(&shot)?.geometry,
            [x, y],
            window_size,
        );
        crate::computer_use::control_session::validate_observation_scope(&scope)
            .map_err(OpenBitFunError::tool)?;
        self.state_for_scope(&scope)?.transition_after_screenshot(
            shot.screenshot_id.clone().expect("capture identity"),
            map,
        );
        Ok(shot)
    }

    /// The bound window's pixels at the most detail the platform offers, with
    /// its global frame and composited popups: backing scale on macOS 14+,
    /// else the live frame.
    #[cfg(target_os = "macos")]
    async fn window_detail_frame(pid: i32, window: isize) -> OpenBitFunResult<DetailFrame> {
        let window = u32::try_from(window)
            .map_err(|_| OpenBitFunError::tool("[TARGET_INVALID] Window id out of range"))?;
        let frame = crate::computer_use::control_session::spawn_blocking(move || {
            let bound = crate::computer_use::macos_capture::bound_window_id(pid)?;
            if bound != window {
                return Err(
                    "[TARGET_CHANGED] Native capture window differs from the authorized target"
                        .to_string(),
                );
            }
            match crate::computer_use::macos_capture::detail_frame(pid, window) {
                Err(reason) if reason.starts_with("DETAIL_CAPTURE_UNSUPPORTED") => {
                    log::debug!("Computer use zoom uses the live frame: pid={pid}, window={window}, reason={reason}");
                    crate::computer_use::macos_capture::capture_frame(pid, Some(window))
                }
                result => result,
            }
        })
        .await
        .map_err(|e| OpenBitFunError::tool(e.to_string()))?
        .map_err(OpenBitFunError::tool)?;
        let image = image::RgbaImage::from_raw(frame.width, frame.height, frame.rgba)
            .ok_or_else(|| OpenBitFunError::tool("[CAPTURE_INVALID_FRAME] Invalid RGBA buffer"))?;
        Ok((image, frame.bounds, frame.auxiliary))
    }

    #[cfg(target_os = "windows")]
    async fn window_detail_frame(_pid: i32, window: isize) -> OpenBitFunResult<DetailFrame> {
        let cap = crate::computer_use::control_session::spawn_blocking(move || {
            crate::computer_use::windows_capture::screenshot_window_capture(
                windows::Win32::Foundation::HWND(window as *mut std::ffi::c_void),
            )
        })
        .await
        .map_err(|e| OpenBitFunError::tool(e.to_string()))??;
        let bounds = [
            f64::from(cap.origin_x),
            f64::from(cap.origin_y),
            f64::from(cap.width),
            f64::from(cap.height),
        ];
        let image = image::RgbaImage::from_raw(cap.width, cap.height, cap.rgba)
            .ok_or_else(|| OpenBitFunError::tool("[CAPTURE_INVALID_FRAME] Invalid RGBA buffer"))?;
        Ok((image, bounds, cap.auxiliary))
    }
}

/// Inherent implementations backing the ComputerUseHost trait's screenshot
/// and OCR-capture methods (see `mod.rs`'s thin trait-method delegators).
impl NativeComputerUseHost {
    #[cfg(target_os = "linux")]
    async fn screenshot_portal(
        &self,
        session: &crate::computer_use::linux_control::LinuxControlSession,
        update_navigation: bool,
    ) -> OpenBitFunResult<ComputerScreenshot> {
        let scope = crate::computer_use::control_session::observation_scope()
            .map_err(OpenBitFunError::tool)?;
        let jpeg = session.capture().await.map_err(OpenBitFunError::tool)?;
        crate::computer_use::control_session::validate_observation_scope(&scope)
            .map_err(OpenBitFunError::tool)?;
        let rgb = image::load_from_memory(&jpeg)
            .map_err(|e| OpenBitFunError::tool(format!("[CAPTURE_INVALID_FRAME] {e}")))?
            .to_rgb8();
        let size = session.logical_size();
        let (logical_w, logical_h) = size
            .filter(|(w, h)| *w > 0 && *h > 0)
            .map(|(w, h)| (w as u32, h as u32))
            .unwrap_or((rgb.width(), rgb.height()));
        let mut shot = Self::raw_shot_from_rgb_crop(rgb, 0, 0, logical_w, logical_h)?;
        shot.quadrant_navigation_click_ready = true;
        shot.ui_tree_text = Some("Portal-selected surface. Coordinates are relative to this stream, not the entire desktop. Background app targeting is unavailable for seat input.".into());
        if size.is_none() {
            shot.image_global_bounds = None;
        }
        if update_navigation && shot.image_global_bounds.is_none() {
            self.state_for_scope(&scope)?.observations.clear_images();
        }
        if update_navigation && shot.image_global_bounds.is_some() {
            let map = PointerMap::from_screenshot(&shot)?;
            self.state_for_scope(&scope)?.transition_after_screenshot(
                shot.screenshot_id.clone().expect("capture identity"),
                map,
            );
        }
        crate::computer_use::control_session::publish_jpeg(
            &scope,
            &shot.bytes,
            [shot.image_width, shot.image_height],
            [0.0, 0.0, logical_w as f64, logical_h as f64],
        );
        Ok(shot)
    }

    pub(super) async fn screenshot_display_impl(
        &self,
        _params: ComputerUseScreenshotParams,
    ) -> OpenBitFunResult<ComputerScreenshot> {
        // Legacy crop/navigation parameters cannot widen the authorized scope.
        self.capture_bound_target(true).await
    }

    pub(super) async fn screenshot_peek_full_display_impl(
        &self,
    ) -> OpenBitFunResult<ComputerScreenshot> {
        // The legacy trait name is retained for callers, but preview captures
        // only the same authorized target and does not change coordinate maps.
        self.capture_bound_target(false).await
    }

    async fn capture_bound_target(
        &self,
        update_navigation: bool,
    ) -> OpenBitFunResult<ComputerScreenshot> {
        crate::computer_use::control_session::capture_allowed().map_err(OpenBitFunError::tool)?;
        let snapshot = crate::computer_use::control_session::snapshot();
        if snapshot.state != "active" {
            return Err(OpenBitFunError::tool(
                "[CONTROL_STOPPED] Capture requires an active control session",
            ));
        }
        let target = snapshot.target.ok_or_else(|| {
            OpenBitFunError::tool("[TARGET_REQUIRED] Select an authorized target before capture")
        })?;
        crate::computer_use::control_session::target_allowed(&target)
            .map_err(OpenBitFunError::tool)?;
        #[cfg(target_os = "windows")]
        {
            let (pid, window) = bound_window_identity(&target)?;
            return self.capture_window(pid, window, update_navigation).await;
        }
        #[cfg(target_os = "macos")]
        {
            let (pid, window) = bound_window_identity(&target)?;
            let bound = crate::computer_use::macos_capture::bound_window_id(pid)
                .map_err(OpenBitFunError::tool)?;
            if bound as isize != window {
                return Err(OpenBitFunError::tool(
                    "[TARGET_CHANGED] Native capture window differs from the authorized target",
                ));
            }
            return self.capture_app_pid(pid, update_navigation).await;
        }
        #[cfg(target_os = "linux")]
        {
            let session = crate::computer_use::linux_control::session()
                .map_err(OpenBitFunError::tool)?
                .ok_or_else(|| {
                    OpenBitFunError::tool(
                        "[CAPTURE_REQUIRED] Start an authorized portal capture session",
                    )
                })?;
            if target != session.target_identity() {
                return Err(OpenBitFunError::tool("[CAPTURE_TARGET_MISMATCH] Portal-selected pixels do not represent the bound application; no capture was taken"));
            }
            return self.screenshot_portal(&session, update_navigation).await;
        }
        #[allow(unreachable_code)]
        Err(OpenBitFunError::tool(
            "[CAPTURE_UNSUPPORTED] This platform has no authorized target capture provider",
        ))
    }

    async fn control_ocr_capture(
        &self,
        region: Option<OcrRegionNative>,
    ) -> OpenBitFunResult<ComputerScreenshot> {
        let snapshot = crate::computer_use::control_session::snapshot();
        if snapshot.state != "active" || snapshot.target.is_none() {
            return Err(OpenBitFunError::tool(
                "[CAPTURE_REQUIRED] Observe an authorized target before OCR",
            ));
        }
        #[cfg(target_os = "linux")]
        if snapshot
            .target
            .as_deref()
            .is_some_and(|target| target.starts_with("atspi:"))
        {
            return Err(OpenBitFunError::tool("[OCR_TARGET_ASSOCIATION_UNAVAILABLE] AT-SPI application identity is not linked to the portal-selected window. Observe the portal window independently; its pixels cannot verify this application's semantic state."));
        }
        let shot = self.screenshot_peek_full_display_impl().await?;
        let Some(region) = region else {
            return Ok(shot);
        };
        let bounds = shot.image_global_bounds.as_ref().ok_or_else(|| {
            OpenBitFunError::tool(
                "[COORDINATES_UNAVAILABLE] Capture has no authoritative coordinate geometry",
            )
        })?;
        let left = (region.x0 as f64).max(bounds.left);
        let top = (region.y0 as f64).max(bounds.top);
        let right = (region.x0 as f64 + region.width as f64).min(bounds.left + bounds.width);
        let bottom = (region.y0 as f64 + region.height as f64).min(bounds.top + bounds.height);
        if right <= left || bottom <= top || bounds.width <= 0.0 || bounds.height <= 0.0 {
            return Err(OpenBitFunError::tool(
                "[TARGET_SCOPE_MISMATCH] OCR region is outside the authorized target",
            ));
        }
        let image = image::load_from_memory(&shot.bytes)
            .map_err(|e| OpenBitFunError::tool(e.to_string()))?
            .to_rgb8();
        let scale_x = image.width() as f64 / bounds.width;
        let scale_y = image.height() as f64 / bounds.height;
        let x0 = ((left - bounds.left) * scale_x).floor() as u32;
        let y0 = ((top - bounds.top) * scale_y).floor() as u32;
        let x1 = (((right - bounds.left) * scale_x).ceil() as u32).min(image.width());
        let y1 = (((bottom - bounds.top) * scale_y).ceil() as u32).min(image.height());
        if x1 <= x0 || y1 <= y0 {
            return Err(OpenBitFunError::tool(
                "[INVALID_COORDINATES] Empty OCR crop",
            ));
        }
        let cropped = image::imageops::crop_imm(&image, x0, y0, x1 - x0, y1 - y0).to_image();
        Self::raw_shot_from_rgb_crop(
            cropped,
            left.round() as i32,
            top.round() as i32,
            (right - left).round().max(1.0) as u32,
            (bottom - top).round().max(1.0) as u32,
        )
    }

    pub(super) async fn read_screen_text_impl(&self) -> OpenBitFunResult<Vec<OcrTextMatch>> {
        let shot = self.control_ocr_capture(None).await?;
        crate::computer_use::control_session::spawn_blocking(move || {
            #[cfg(target_os = "macos")]
            {
                macos::catch_objc_local(|| crate::computer_use::screen_ocr::read_text(&shot))
            }
            #[cfg(not(target_os = "macos"))]
            {
                crate::computer_use::screen_ocr::read_text(&shot)
            }
        })
        .await
        .map_err(|error| OpenBitFunError::tool(error.to_string()))?
    }

    pub(super) async fn ocr_find_text_matches_impl(
        &self,
        text_query: &str,
        region_native: Option<openbitfun_agent_tools::computer_use_host::OcrRegionNative>,
    ) -> OpenBitFunResult<Vec<OcrTextMatch>> {
        let shot = self.control_ocr_capture(region_native).await?;
        let query = text_query.to_string();
        let desktop_matches = crate::computer_use::control_session::spawn_blocking(move || {
            // Vision (`VNRecognizeTextRequest`) can throw `NSException` on
            // malformed images / OOM. Catch it so OCR failures degrade to
            // an empty match list instead of aborting the runtime.
            #[cfg(target_os = "macos")]
            {
                macos::catch_objc_local(|| {
                    crate::computer_use::screen_ocr::find_text_matches(&shot, &query)
                })
            }
            #[cfg(not(target_os = "macos"))]
            {
                crate::computer_use::screen_ocr::find_text_matches(&shot, &query)
            }
        })
        .await
        .map_err(|e| OpenBitFunError::tool(e.to_string()))??;
        Ok(desktop_matches
            .into_iter()
            .map(
                |m| openbitfun_agent_tools::computer_use_host::OcrTextMatch {
                    text: m.text,
                    confidence: m.confidence,
                    center_x: m.center_x,
                    center_y: m.center_y,
                    bounds_left: m.bounds_left,
                    bounds_top: m.bounds_top,
                    bounds_width: m.bounds_width,
                    bounds_height: m.bounds_height,
                },
            )
            .collect())
    }

    pub(super) async fn ocr_preview_crop_jpeg_impl(
        &self,
        gx: f64,
        gy: f64,
        half_extent_native: u32,
    ) -> OpenBitFunResult<Vec<u8>> {
        let region = Self::ocr_region_square_around_point(gx, gy, half_extent_native)?;
        let shot = self.control_ocr_capture(Some(region)).await?;
        Ok(shot.bytes)
    }
}

#[cfg(test)]
mod window_projection_tests {
    #[cfg(target_os = "macos")]
    use super::NativeComputerUseHost;
    use super::{bound_window_identity, CaptureGeometry, PointerMap};
    #[cfg(target_os = "macos")]
    use openbitfun_agent_tools::computer_use_host::ComputerUseHost;

    #[test]
    fn native_capture_identity_never_accepts_an_unbound_or_partial_target() {
        assert_eq!(bound_window_identity("pid:12/window:34").unwrap(), (12, 34));
        for target in [
            "",
            "pid:12",
            "pid:12/window:0",
            "pid:0/window:34",
            "pid:-1/window:34",
            "pid:12/window:34/extra",
            "atspi:12",
            "portal:34",
        ] {
            assert!(bound_window_identity(target).is_err(), "{target}");
        }
    }

    fn capture_map() -> PointerMap {
        PointerMap::full_window(
            CaptureGeometry::new(
                900,
                600,
                &super::ComputerUseImageContentRect {
                    left: 0,
                    top: 0,
                    width: 900,
                    height: 600,
                },
                &super::ComputerUseImageGlobalBounds {
                    left: 139.0,
                    top: 40.0,
                    width: 1800.0,
                    height: 1200.0,
                },
            )
            .unwrap(),
        )
    }

    #[cfg(target_os = "macos")]
    #[test]
    fn relative_movement_after_capture_uses_geometry_without_ocr_navigation_gate() {
        let host = NativeComputerUseHost::new();
        let map = capture_map();
        host.state
            .lock()
            .unwrap()
            .transition_after_screenshot("fixture".into(), map);
        let retained = host
            .state
            .lock()
            .unwrap()
            .observations
            .latest_image()
            .unwrap();
        assert_eq!(retained.image_delta_to_global(4, -3).unwrap(), (8.0, -6.0));
        assert!(host.last_screenshot_refinement().is_none());
        // Absolute coordinates still use the existing validated map; this
        // delta helper does not waive target binding, leases or OS authority.
        assert_eq!(retained, map);
    }

    #[test]
    fn window_translation_preserves_observed_local_coordinates() {
        let observed = capture_map();
        let moved = observed
            .at_window_bounds([456.0, -20.0, 1800.0, 1200.0])
            .unwrap();
        assert!(observed.same_window_projection(&moved));
        let before = observed.map_image_to_global_f64(100, 200).unwrap();
        let after = moved.map_image_to_global_f64(100, 200).unwrap();
        assert_eq!(after, (before.0 + 317.0, before.1 - 60.0));
    }

    #[test]
    fn resizing_or_image_projection_change_requires_new_observation() {
        let observed = capture_map();
        assert!(observed
            .at_window_bounds([139.0, 40.0, 1790.0, 1200.0])
            .is_err());
        assert!(observed
            .at_window_bounds([f64::NAN, 40.0, 1800.0, 1200.0])
            .is_err());
        let resampled = PointerMap::full_window(
            CaptureGeometry::new(
                450,
                300,
                &super::ComputerUseImageContentRect {
                    left: 0,
                    top: 0,
                    width: 450,
                    height: 300,
                },
                &super::ComputerUseImageGlobalBounds {
                    left: 139.0,
                    top: 40.0,
                    width: 1800.0,
                    height: 1200.0,
                },
            )
            .unwrap(),
        );
        assert!(!observed.same_window_projection(&resampled));
    }

    fn zoom_region(x: u32, y: u32, width: u32, height: u32) -> super::ComputerUseZoomRegion {
        super::ComputerUseZoomRegion {
            screenshot_id: "observed".into(),
            x,
            y,
            width,
            height,
        }
    }

    /// The window region [200,100,180,120] of capture_map, as a 360x240 image.
    fn zoomed_map() -> PointerMap {
        PointerMap::window_region(
            CaptureGeometry::new(
                360,
                240,
                &super::ComputerUseImageContentRect {
                    left: 0,
                    top: 0,
                    width: 360,
                    height: 240,
                },
                &super::ComputerUseImageGlobalBounds {
                    left: 339.0,
                    top: 140.0,
                    width: 180.0,
                    height: 120.0,
                },
            )
            .unwrap(),
            [200.0, 100.0],
            [1800.0, 1200.0],
        )
    }

    #[test]
    fn zoom_regions_are_window_relative_and_nest() {
        let observed = capture_map();
        assert_eq!(
            observed
                .window_region_of(&zoom_region(100, 50, 90, 60))
                .unwrap(),
            [200.0, 100.0, 180.0, 120.0]
        );
        assert_eq!(
            zoomed_map()
                .window_region_of(&zoom_region(200, 150, 100, 75))
                .unwrap(),
            [300.0, 175.0, 50.0, 37.5]
        );
        assert!(observed
            .window_region_of(&zoom_region(850, 0, 51, 10))
            .is_err());
        assert!(observed
            .window_region_of(&zoom_region(0, 0, 0, 10))
            .is_err());
    }

    #[test]
    fn zoomed_observations_share_the_window_and_follow_its_moves() {
        let observed = capture_map();
        let zoomed = zoomed_map();
        assert!(observed.same_window_projection(&zoomed));
        assert!(zoomed.same_window_projection(&observed));
        assert_eq!(
            zoomed.map_image_to_global_f64(0, 0).unwrap(),
            (339.25, 140.25)
        );

        let moved = zoomed
            .at_window_bounds([500.0, 0.0, 1800.0, 1200.0])
            .unwrap();
        assert_eq!(
            moved.map_image_to_global_f64(200, 150).unwrap(),
            (800.25, 175.25)
        );
        assert!(observed.same_window_projection(&moved));
        assert!(zoomed
            .at_window_bounds([500.0, 0.0, 1700.0, 1200.0])
            .is_err());

        let other_window = PointerMap::full_window(
            CaptureGeometry::new(
                900,
                600,
                &super::ComputerUseImageContentRect {
                    left: 0,
                    top: 0,
                    width: 900,
                    height: 600,
                },
                &super::ComputerUseImageGlobalBounds {
                    left: 139.0,
                    top: 40.0,
                    width: 1700.0,
                    height: 1200.0,
                },
            )
            .unwrap(),
        );
        assert!(!zoomed.same_window_projection(&other_window));
    }

    #[test]
    fn a_whole_window_zoom_is_still_a_zoom() {
        let observed = capture_map();
        let whole = PointerMap::window_region(
            CaptureGeometry::new(
                1568,
                1045,
                &super::ComputerUseImageContentRect {
                    left: 0,
                    top: 0,
                    width: 1568,
                    height: 1045,
                },
                &super::ComputerUseImageGlobalBounds {
                    left: 139.0,
                    top: 40.0,
                    width: 1800.0,
                    height: 1200.0,
                },
            )
            .unwrap(),
            [0.0, 0.0],
            [1800.0, 1200.0],
        );
        assert!(!observed.geometry.same_projection(&whole.geometry));
        assert!(observed.same_window_projection(&whole));
        assert!(whole.same_window_projection(&observed));
        assert!(PointerMap::for_coordinates(observed, Some(whole), true).is_ok());
        let implicit = PointerMap::for_coordinates(whole, Some(whole), true).unwrap_err();
        assert!(
            implicit.to_string().contains("SCREENSHOT_ID_REQUIRED"),
            "{implicit}"
        );
    }

    #[test]
    fn coordinates_after_a_zoom_name_their_image() {
        let observed = capture_map();
        let zoomed = zoomed_map();
        let implicit = PointerMap::for_coordinates(zoomed, Some(zoomed), true).unwrap_err();
        assert!(
            implicit.to_string().contains("SCREENSHOT_ID_REQUIRED"),
            "{implicit}"
        );
        assert_eq!(
            PointerMap::for_coordinates(zoomed, Some(zoomed), false).unwrap(),
            zoomed
        );
        assert_eq!(
            PointerMap::for_coordinates(observed, Some(zoomed), false).unwrap(),
            observed
        );
        assert_eq!(
            PointerMap::for_coordinates(observed, Some(observed), true).unwrap(),
            observed
        );
        let resized = zoomed
            .at_window_bounds([139.0, 40.0, 1800.0, 1200.0])
            .unwrap();
        assert!(PointerMap::for_coordinates(observed, Some(resized), false).is_ok());
        for latest in [
            None,
            Some(PointerMap {
                window_size: [1700.0, 1200.0],
                ..zoomed
            }),
        ] {
            let stale = PointerMap::for_coordinates(observed, latest, false).unwrap_err();
            assert!(stale.to_string().contains("STALE_CAPTURE"), "{stale}");
        }
    }

    #[test]
    fn zoom_output_is_legible_without_exceeding_model_image_limits() {
        assert_eq!(super::zoom_scale(512.0, 300.0, 1.0), 2.0);
        assert_eq!(super::zoom_scale(10.0, 10.0, 1.0), 8.0);
        assert_eq!(super::zoom_scale(600.0, 200.0, 2.0), 2.0);
        assert!((super::zoom_scale(1800.0, 1200.0, 2.0) - 1568.0 / 1800.0).abs() < 1e-12);
    }

    #[test]
    fn zoom_crop_snaps_to_source_pixels_and_keeps_their_content() {
        // A 2x backing-scale frame of a 180x120 window; red encodes x, green y.
        let source = image::RgbaImage::from_fn(360, 240, |x, y| {
            image::Rgba([x.min(255) as u8, y as u8, 0, 255])
        });
        let crop = super::zoom_crop(&source, [180.0, 120.0], [10.25, 20.5, 40.0, 30.0]).unwrap();
        assert_eq!(crop.region, [10.0, 20.5, 40.5, 30.0]);
        assert_eq!(crop.image.dimensions(), (324, 240));
        let corner = crop.image.get_pixel(0, 0);
        assert!(
            corner[0].abs_diff(20) <= 1 && corner[1].abs_diff(41) <= 1,
            "{corner:?}"
        );
        let far = crop.image.get_pixel(323, 239);
        assert!(
            far[0].abs_diff(100) <= 1 && far[1].abs_diff(100) <= 1,
            "{far:?}"
        );

        assert!(super::zoom_crop(&source, [180.0, 120.0], [180.0, 0.0, 10.0, 10.0]).is_err());
    }
}
