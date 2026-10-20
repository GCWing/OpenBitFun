//! Exact authorized-target capture, JPEG encoding, OCR and coordinate mapping.
//! No desktop capture or display/crop fallback is permitted when a bound window
//! or consented portal stream cannot be captured.

#[cfg(target_os = "macos")]
use super::macos;
use super::DesktopComputerUseHost;
use image::codecs::jpeg::JpegEncoder;
#[cfg(any(target_os = "macos", target_os = "windows"))]
use image::DynamicImage;
use image::RgbImage;
use openbitfun_core::agentic::tools::computer_use_host::{
    ComputerScreenshot, ComputerUseDisplayInfo, ComputerUseImageContentRect,
    ComputerUseImageGlobalBounds, ComputerUseScreenshotParams, OcrRegionNative, OcrTextMatch,
};
use openbitfun_core::util::errors::{OpenBitFunError, OpenBitFunResult};
use screenshots::Screen;

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
#[derive(Clone, Copy, Debug, PartialEq)]
pub(super) struct PointerMap(openbitfun_agent_tools::computer_use_geometry::CaptureGeometry);

impl PointerMap {
    fn from_screenshot(shot: &ComputerScreenshot) -> OpenBitFunResult<Self> {
        let content = shot.image_content_rect.as_ref().ok_or_else(|| {
            OpenBitFunError::tool("[INVALID_GEOMETRY] Capture content rectangle unavailable")
        })?;
        let bounds = shot.image_global_bounds.as_ref().ok_or_else(|| {
            OpenBitFunError::tool(
                "[COORDINATES_UNAVAILABLE] Capture has no authoritative surface bounds",
            )
        })?;
        openbitfun_agent_tools::computer_use_geometry::CaptureGeometry::new(
            shot.image_width,
            shot.image_height,
            content,
            bounds,
        )
        .map(Self)
        .map_err(OpenBitFunError::tool)
    }
    #[cfg(target_os = "macos")]
    pub(super) fn image_delta_to_global(&self, dx: i32, dy: i32) -> OpenBitFunResult<(f64, f64)> {
        Ok(self.0.image_delta_to_global(dx, dy))
    }
    pub(super) fn same_window_projection(&self, other: &Self) -> bool {
        self.0.same_projection(&other.0)
    }
    pub(super) fn at_window_bounds(self, bounds: [f64; 4]) -> OpenBitFunResult<Self> {
        self.0
            .at_bounds(bounds)
            .map(Self)
            .map_err(OpenBitFunError::tool)
    }
    pub(super) fn map_image_to_global_f64(&self, x: i32, y: i32) -> OpenBitFunResult<(f64, f64)> {
        self.0.image_to_global(x, y).map_err(OpenBitFunError::tool)
    }
    pub(super) fn map_normalized_to_global_f64(
        &self,
        x: i32,
        y: i32,
    ) -> OpenBitFunResult<(f64, f64)> {
        self.0
            .normalized_to_global(x, y)
            .map_err(OpenBitFunError::tool)
    }
}

impl DesktopComputerUseHost {
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

impl DesktopComputerUseHost {
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

        let rgba = image::RgbaImage::from_raw(cap.width, cap.height, cap.rgba)
            .ok_or_else(|| OpenBitFunError::tool("[CAPTURE_INVALID_FRAME] Invalid RGBA buffer"))?;
        let rgb = DynamicImage::ImageRgba8(rgba).to_rgb8();
        let native_w = rgb.width();
        let native_h = rgb.height();

        let mut shot =
            Self::raw_shot_from_rgb_crop(rgb, cap.origin_x, cap.origin_y, native_w, native_h)?;
        shot.capture_frame = Some(cap.frame_info);

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

/// Inherent implementations backing the ComputerUseHost trait's screenshot
/// and OCR-capture methods (see `mod.rs`'s thin trait-method delegators).
impl DesktopComputerUseHost {
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
        region_native: Option<openbitfun_core::agentic::tools::computer_use_host::OcrRegionNative>,
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
                |m| openbitfun_core::agentic::tools::computer_use_host::OcrTextMatch {
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
    use super::DesktopComputerUseHost;
    use super::{bound_window_identity, PointerMap};
    #[cfg(target_os = "macos")]
    use openbitfun_core::agentic::tools::computer_use_host::ComputerUseHost;

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
        PointerMap(
            openbitfun_agent_tools::computer_use_geometry::CaptureGeometry::new(
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
        let host = DesktopComputerUseHost::new();
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
        let resampled = PointerMap(
            openbitfun_agent_tools::computer_use_geometry::CaptureGeometry::new(
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
}
