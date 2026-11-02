//! Low-level pointer (mouse) and keyboard input primitives for the desktop
//! Computer Use host: `enigo` dispatch plumbing, smooth cursor-path motion,
//! button/key name mapping, image/normalized coordinate → global-pointer
//! mapping, and the [`ComputerUseHost`] trait methods for mouse move/click/
//! drag/scroll/key-chord/type-text.
//!
//! Extracted from `desktop_host/mod.rs` (no behavior change) so the input
//! subsystem has a single, independently reviewable home instead of living
//! inline inside the multi-thousand-line host file.

#[cfg(target_os = "macos")]
use super::macos;
use super::{NativeComputerUseHost, PointerMap};
use enigo::{Axis, Button, Coordinate, Direction, Enigo, Key, Keyboard, Mouse, Settings};
use log::debug;
use openbitfun_agent_tools::computer_use_host::error::{OpenBitFunError, OpenBitFunResult};
#[cfg(target_os = "windows")]
use openbitfun_agent_tools::computer_use_host::AppSelector;
#[cfg(any(target_os = "macos", target_os = "windows"))]
use openbitfun_agent_tools::computer_use_host::ClickTarget;
use openbitfun_agent_tools::computer_use_host::{ComputerUseHost, ComputerUseLastMutationKind};
use std::time::Duration;

impl NativeComputerUseHost {
    pub(super) fn ensure_input_automation_allowed() -> OpenBitFunResult<()> {
        Self::ensure_foreground_target()?;
        #[cfg(target_os = "macos")]
        {
            if macos::ax_trusted() {
                return Ok(());
            }
            let exe = std::env::current_exe()
                .map(|p| p.display().to_string())
                .unwrap_or_else(|_| "(unknown path)".to_string());
            Err(OpenBitFunError::tool(format!(
                "macOS Accessibility is not enabled for this executable. System Settings > Privacy & Security > Accessibility: add and enable OpenBitFun. Development builds use the debug binary at: {}",
                exe
            )))
        }
        #[cfg(not(target_os = "macos"))]
        {
            Ok(())
        }
    }

    fn with_enigo<F, T>(f: F) -> OpenBitFunResult<T>
    where
        F: FnOnce(&mut Enigo) -> OpenBitFunResult<T>,
    {
        Self::ensure_input_automation_allowed()?;
        #[cfg(target_os = "linux")]
        crate::computer_use::linux_control::require_legacy_x11().map_err(OpenBitFunError::tool)?;
        let settings = Settings::default();
        let mut enigo = Enigo::new(&settings)
            .map_err(|e| OpenBitFunError::tool(format!("enigo init: {}", e)))?;
        f(&mut enigo)
    }

    /// Enigo on macOS uses Text Input Source / AppKit paths that must run on the main queue.
    /// Tokio `spawn_blocking` threads are not main; dispatch there hits `dispatch_assert_queue_fail`.
    ///
    /// On macOS, the main-queue dispatch is also wrapped in an Objective-C
    /// `@try/@catch` (via `objc2::exception::catch`) so that an `NSException`
    /// thrown by TSM / HIToolbox / AppKit during keyboard or text input is
    /// converted into a Rust error instead of propagating across the FFI
    /// boundary as a "foreign exception" — which would otherwise cause Rust's
    /// `catch_unwind` to abort the whole process (`SIGABRT`).
    pub(super) fn run_enigo_job<F, T>(job: F) -> OpenBitFunResult<T>
    where
        F: FnOnce(&mut Enigo) -> OpenBitFunResult<T> + Send,
        T: Send,
    {
        #[cfg(target_os = "macos")]
        {
            macos::run_on_main_for_enigo(move || Self::with_enigo(job))
        }
        #[cfg(not(target_os = "macos"))]
        {
            Self::with_enigo(job)
        }
    }

    /// Absolute pointer move in Quartz global **points** with full float precision (avoids enigo integer truncation).
    #[cfg(target_os = "macos")]
    fn post_mouse_moved_cg_global(x: f64, y: f64) -> OpenBitFunResult<()> {
        crate::computer_use::control_session::foreground_allowed()
            .map_err(OpenBitFunError::tool)?;
        crate::computer_use::control_session::record_pointer(x, y, false);
        use core_graphics::event::{CGEvent, CGEventTapLocation, CGEventType, CGMouseButton};
        use core_graphics::event_source::{CGEventSource, CGEventSourceStateID};
        use core_graphics::geometry::CGPoint;

        let source =
            CGEventSource::new(CGEventSourceStateID::CombinedSessionState).map_err(|_| {
                OpenBitFunError::tool("CGEventSource create failed (mouse_move)".to_string())
            })?;
        let pt = CGPoint { x, y };
        let ev = CGEvent::new_mouse_event(source, CGEventType::MouseMoved, pt, CGMouseButton::Left)
            .map_err(|_| OpenBitFunError::tool("CGEvent MouseMoved failed".to_string()))?;
        ev.post(CGEventTapLocation::HID);
        Ok(())
    }

    /// Ease 0..1 for pointer paths (smooth acceleration/deceleration).
    fn smoothstep01(t: f64) -> f64 {
        let t = t.clamp(0.0, 1.0);
        t * t * (3.0 - 2.0 * t)
    }

    /// Move the pointer along a short visible path instead of warping in one event.
    #[cfg(target_os = "macos")]
    fn smooth_mouse_move_cg_global(x1: f64, y1: f64) -> OpenBitFunResult<()> {
        Self::ensure_foreground_target()?;
        const MIN_DIST: f64 = 2.5;
        const MIN_STEPS: usize = 8;
        const MAX_STEPS: usize = 85;
        const MAX_DURATION_MS: u64 = 400;

        let (x0, y0) = macos::quartz_mouse_location().unwrap_or((x1, y1));
        let dx = x1 - x0;
        let dy = y1 - y0;
        let dist = (dx * dx + dy * dy).sqrt();
        if dist < MIN_DIST {
            return Self::post_mouse_moved_cg_global(x1, y1);
        }
        let duration_ms = (70.0 + dist * 0.28).min(MAX_DURATION_MS as f64) as u64;
        let steps = ((dist / 5.5).ceil() as usize).clamp(MIN_STEPS, MAX_STEPS);
        let step_delay = Duration::from_millis((duration_ms / steps as u64).max(1));

        for i in 1..=steps {
            let t = i as f64 / steps as f64;
            let te = Self::smoothstep01(t);
            let x = x0 + dx * te;
            let y = y0 + dy * te;
            Self::post_mouse_moved_cg_global(x, y)?;
            if i < steps {
                std::thread::sleep(step_delay);
            }
        }
        Ok(())
    }

    /// Windows/Linux: same smooth path using enigo absolute moves (single `Enigo` session).
    #[cfg(not(target_os = "macos"))]
    fn smooth_mouse_move_enigo_abs(x1: f64, y1: f64) -> OpenBitFunResult<()> {
        const MIN_DIST: f64 = 2.5;
        const MIN_STEPS: usize = 8;
        const MAX_STEPS: usize = 85;
        const MAX_DURATION_MS: u64 = 400;

        Self::run_enigo_job(|e| {
            let (cx, cy) = e.location().map_err(|err| {
                OpenBitFunError::tool(format!("smooth_mouse_move: pointer location: {}", err))
            })?;
            let x0 = cx as f64;
            let y0 = cy as f64;
            let dx = x1 - x0;
            let dy = y1 - y0;
            let dist = (dx * dx + dy * dy).sqrt();
            if dist < MIN_DIST {
                return e
                    .move_mouse(x1.round() as i32, y1.round() as i32, Coordinate::Abs)
                    .map_err(|err| OpenBitFunError::tool(format!("mouse_move: {}", err)));
            }
            let duration_ms = (70.0 + dist * 0.28).min(MAX_DURATION_MS as f64) as u64;
            let steps = ((dist / 5.5).ceil() as usize).clamp(MIN_STEPS, MAX_STEPS);
            let step_delay = Duration::from_millis((duration_ms / steps as u64).max(1));

            for i in 1..=steps {
                crate::computer_use::control_session::foreground_allowed()
                    .map_err(OpenBitFunError::tool)?;
                let t = i as f64 / steps as f64;
                let te = Self::smoothstep01(t);
                let x = x0 + dx * te;
                let y = y0 + dy * te;
                e.move_mouse(x.round() as i32, y.round() as i32, Coordinate::Abs)
                    .map_err(|err| OpenBitFunError::tool(format!("mouse_move: {}", err)))?;
                if i < steps {
                    std::thread::sleep(step_delay);
                }
            }
            Ok(())
        })
    }

    fn map_button(s: &str) -> OpenBitFunResult<Button> {
        match s.to_lowercase().as_str() {
            "left" => Ok(Button::Left),
            "right" => Ok(Button::Right),
            "middle" => Ok(Button::Middle),
            _ => Err(OpenBitFunError::tool(format!(
                "Unknown mouse button: {}",
                s
            ))),
        }
    }

    fn map_key(name: &str) -> OpenBitFunResult<Key> {
        let n = name.to_lowercase();
        Ok(match n.as_str() {
            "command" | "meta" | "super" | "win" => Key::Meta,
            "control" | "ctrl" => Key::Control,
            "shift" => Key::Shift,
            "alt" | "option" => Key::Alt,
            "return" | "enter" => Key::Return,
            "tab" => Key::Tab,
            "escape" | "esc" => Key::Escape,
            "space" => Key::Space,
            "backspace" => Key::Backspace,
            "delete" => Key::Delete,
            "up" | "arrow_up" | "arrowup" => Key::UpArrow,
            "down" | "arrow_down" | "arrowdown" => Key::DownArrow,
            "left" | "arrow_left" | "arrowleft" => Key::LeftArrow,
            "right" | "arrow_right" | "arrowright" => Key::RightArrow,
            "home" => Key::Home,
            "end" => Key::End,
            "pageup" | "page_up" => Key::PageUp,
            "pagedown" | "page_down" => Key::PageDown,
            "capslock" | "caps_lock" => Key::CapsLock,
            "f1" => Key::F1,
            "f2" => Key::F2,
            "f3" => Key::F3,
            "f4" => Key::F4,
            "f5" => Key::F5,
            "f6" => Key::F6,
            "f7" => Key::F7,
            "f8" => Key::F8,
            "f9" => Key::F9,
            "f10" => Key::F10,
            "f11" => Key::F11,
            "f12" => Key::F12,
            s if s.len() == 1 => {
                let c = s.chars().next().unwrap();
                Key::Unicode(c)
            }
            _ => {
                return Err(OpenBitFunError::tool(format!("Unknown key name: {}", name)));
            }
        })
    }

    fn chord_includes_return_or_enter(keys: &[String]) -> bool {
        keys.iter()
            .any(|s| matches!(s.to_lowercase().as_str(), "return" | "enter" | "kp_enter"))
    }
}

impl NativeComputerUseHost {
    /// Perform a physical click at the current pointer without running [`ComputerUseHost::computer_use_guard_click_allowed`].
    /// Used after `mouse_move_global_f64` when coordinates came from AX or OCR (not from vision model image coords).
    async fn mouse_click_at_current_pointer(&self, button: &str) -> OpenBitFunResult<()> {
        #[cfg(target_os = "linux")]
        if let Some(session) =
            crate::computer_use::linux_control::session().map_err(OpenBitFunError::tool)?
        {
            let code = crate::computer_use::linux_control::button_code(button)
                .map_err(OpenBitFunError::tool)?;
            session
                .button(code, true)
                .await
                .map_err(OpenBitFunError::tool)?;
            session
                .button(code, false)
                .await
                .map_err(OpenBitFunError::tool)?;
            ComputerUseHost::computer_use_after_click(self);
            return Ok(());
        }
        let button = button.to_string();
        crate::computer_use::control_session::spawn_blocking(move || {
            Self::run_enigo_job(|e| {
                let b = Self::map_button(&button)?;
                e.button(b, Direction::Click)
                    .map_err(|err| OpenBitFunError::tool(format!("click: {}", err)))
            })
        })
        .await
        .map_err(|e| OpenBitFunError::tool(e.to_string()))??;

        // Flash a click highlight at current pointer (macOS only, non-blocking).
        #[cfg(target_os = "macos")]
        {
            if let Ok((mx, my)) = macos::quartz_mouse_location() {
                std::thread::spawn(move || {
                    flash_click_highlight_cg(mx, my);
                });
            }
        }

        ComputerUseHost::computer_use_after_click(self);
        Ok(())
    }

    /// Resolve image/normalized input against the observation scope and live
    /// native bounds, including legacy foreground actions. Inputs that accept
    /// a screenshot_id set `zoom_needs_id`; legacy actions without one keep
    /// addressing the latest image, zoomed or not.
    pub(super) fn observed_pointer_map(
        &self,
        expected_pid: Option<i32>,
        screenshot_id: Option<&str>,
        zoom_needs_id: bool,
    ) -> OpenBitFunResult<PointerMap> {
        let scope = crate::computer_use::control_session::observation_scope()
            .map_err(OpenBitFunError::tool)?;
        if expected_pid.is_some_and(|pid| {
            !scope
                .target
                .as_deref()
                .is_some_and(|target| target.starts_with(&format!("pid:{pid}/window:")))
        }) {
            return Err(OpenBitFunError::tool(
                "[STALE_CAPTURE] Target window changed; observe it again",
            ));
        }
        let map = {
            let state = self.state_for_scope(&scope)?;
            let selected = state
                .observations
                .image(screenshot_id)
                .map_err(OpenBitFunError::tool)?;
            PointerMap::for_coordinates(
                selected,
                state.observations.latest_image(),
                zoom_needs_id && screenshot_id.is_none(),
            )?
        };
        #[cfg(target_os = "macos")]
        let map = {
            let pid = scope
                .target
                .as_deref()
                .and_then(|target| target.strip_prefix("pid:"))
                .and_then(|target| target.split('/').next())
                .and_then(|id| id.parse::<i32>().ok())
                .ok_or_else(|| OpenBitFunError::tool("[STALE_CAPTURE] Missing process identity"))?;
            let window = crate::computer_use::macos_capture::bound_window_id(pid)
                .map_err(OpenBitFunError::tool)?;
            map.at_window_bounds(
                crate::computer_use::macos_capture::window_bounds(pid, window)
                    .map_err(OpenBitFunError::tool)?,
            )?
        };
        #[cfg(target_os = "windows")]
        let map = {
            let hwnd = scope
                .target
                .as_deref()
                .and_then(|target| target.split("/window:").nth(1))
                .and_then(|id| id.parse::<isize>().ok())
                .ok_or_else(|| OpenBitFunError::tool("[STALE_CAPTURE] Missing window identity"))?;
            map.at_window_bounds(crate::computer_use::windows_capture::window_bounds(
                windows::Win32::Foundation::HWND(hwnd as *mut _),
            )?)?
        };
        crate::computer_use::control_session::validate_observation_scope(&scope)
            .map_err(OpenBitFunError::tool)?;
        Ok(map)
    }

    #[cfg(any(target_os = "macos", target_os = "windows"))]
    pub(super) fn map_app_image_coords_to_pointer_f64(
        &self,
        pid: i32,
        x: i32,
        y: i32,
        screenshot_id: Option<&str>,
    ) -> OpenBitFunResult<(f64, f64)> {
        self.observed_pointer_map(Some(pid), screenshot_id, true)?
            .map_image_to_global_f64(x, y)
    }

    #[cfg(any(target_os = "macos", target_os = "windows"))]
    pub(super) fn image_grid_target_to_xy(
        target: &ClickTarget,
    ) -> OpenBitFunResult<Option<(i32, i32)>> {
        let ClickTarget::ImageGrid {
            x0,
            y0,
            width,
            height,
            rows,
            cols,
            row,
            col,
            intersections,
            ..
        } = target
        else {
            return Ok(None);
        };

        if *width == 0 || *height == 0 || *rows == 0 || *cols == 0 {
            return Err(OpenBitFunError::tool(
                "image_grid requires positive width, height, rows, and cols.".to_string(),
            ));
        }
        if row >= rows || col >= cols {
            return Err(OpenBitFunError::tool(format!(
                "image_grid row/col out of range: row={} col={} for rows={} cols={}",
                row, col, rows, cols
            )));
        }

        let (fx, fy) = if *intersections {
            let denom_x = cols.saturating_sub(1).max(1) as f64;
            let denom_y = rows.saturating_sub(1).max(1) as f64;
            (
                *x0 as f64 + (*col as f64 * width.saturating_sub(1) as f64 / denom_x),
                *y0 as f64 + (*row as f64 * height.saturating_sub(1) as f64 / denom_y),
            )
        } else {
            (
                *x0 as f64 + ((*col as f64 + 0.5) * *width as f64 / *cols as f64),
                *y0 as f64 + ((*row as f64 + 0.5) * *height as f64 / *rows as f64),
            )
        };

        Ok(Some((fx.round() as i32, fy.round() as i32)))
    }
}

/// Draw a transient red highlight circle at `(gx, gy)` in CoreGraphics global coordinates (macOS).
/// Uses a CGContext overlay window approach: draws into a temporary image and posts via overlay.
/// Runs synchronously on its own thread; caller should `std::thread::spawn`.
#[cfg(target_os = "macos")]
fn flash_click_highlight_cg(gx: f64, gy: f64) {
    crate::computer_use::control_session::record_pointer(gx, gy, true);
}

impl NativeComputerUseHost {
    #[cfg(target_os = "windows")]
    pub(super) async fn windows_target(&self, app: &AppSelector) -> OpenBitFunResult<(i32, isize)> {
        app.validate_window_target()
            .map_err(OpenBitFunError::tool)?;
        let pid = super::resolve_pid(self, app).await?;
        // A sharing indicator or newly opened utility window must not replace
        // the window already owned by the control session.
        let prefix = format!("pid:{pid}/window:");
        let control = crate::computer_use::control_session::snapshot();
        let bound = control
            .target
            .as_deref()
            .and_then(|target| target.strip_prefix(&prefix))
            .and_then(|window| window.parse::<isize>().ok());
        let requested = app
            .window_id
            .map(isize::try_from)
            .transpose()
            .map_err(|_| {
                OpenBitFunError::tool(
                    "[INVALID_PARAMS] window_id exceeds the native window handle range",
                )
            })?;
        if control.sharing.is_some()
            && (bound.is_none() || requested.is_some_and(|id| Some(id) != bound))
        {
            return Err(OpenBitFunError::tool(
                "[SHARED_TARGET_ONLY] Window was not shared by the user",
            ));
        }
        if let Some(window) = requested.or(bound) {
            use windows::Win32::Foundation::HWND;
            use windows::Win32::UI::WindowsAndMessaging::{GetWindowThreadProcessId, IsWindow};
            let hwnd = HWND(window as *mut std::ffi::c_void);
            let mut actual_pid = 0;
            unsafe {
                GetWindowThreadProcessId(hwnd, Some(&mut actual_pid));
            }
            if !unsafe { IsWindow(Some(hwnd)) }.as_bool() || actual_pid != pid as u32 {
                return Err(OpenBitFunError::tool("[TARGET_WINDOW_UNAVAILABLE] The requested window no longer belongs to this process; refresh list_windows and select the intended window"));
            }
            return Ok((pid, window));
        }
        if crate::computer_use::control_session::snapshot()
            .sharing
            .is_some()
        {
            return Err(OpenBitFunError::tool(
                "[SHARED_TARGET_ONLY] Application was not shared by the user",
            ));
        }
        let hwnd = crate::computer_use::windows_list_apps::find_default_window_for_pid(pid as u32)
            .ok_or_else(|| {
                match crate::computer_use::windows_list_apps::minimized_window_for_pid(pid as u32) {
                    Some(handle) => OpenBitFunError::tool(
                        crate::computer_use::windows_window_target::CaptureUnavailable::Minimized
                            .error(pid as u32, handle),
                    ),
                    None => OpenBitFunError::tool(
                        "[TARGET_UNAVAILABLE] Target has no eligible visible window; inspect list_windows and select an explicit window_id",
                    ),
                }
            })?;
        Ok((pid, hwnd.0 as isize))
    }

    /// Owning pid of the current foreground window (Windows), `0` when unknown.
    /// Used to key pointer maps / element caches for the foreground-targeted
    /// `app_*` actions.
    #[cfg(target_os = "windows")]
    pub(super) fn windows_foreground_pid() -> i32 {
        crate::computer_use::windows_ax_ui::foreground_window_pid()
            .map(|p| p as i32)
            .unwrap_or(0)
    }

    /// Resolve a [`ClickTarget`] into a **global screen** `(x, y)` on Windows.
    ///
    /// Mirrors the macOS coordinate-resolution arm of `app_click`, but every
    /// branch targets the foreground window (Windows snapshots are always of the
    /// foreground window). Image-pixel targets are mapped through the stored
    /// pointer map; `NodeIdx` reads the node's `frame_global` center from a
    /// fresh snapshot; `OcrText` runs OCR and takes the highest-confidence match.
    #[cfg(target_os = "windows")]
    pub(super) async fn resolve_click_target_windows(
        &self,
        target: &ClickTarget,
        app: &AppSelector,
    ) -> OpenBitFunResult<(f64, f64)> {
        let (pid, hwnd_raw) = self.windows_target(app).await?;
        match target {
            ClickTarget::ScreenXy { x, y } => Ok((*x, *y)),
            ClickTarget::ImageXy {
                x,
                y,
                screenshot_id,
            } => self.map_app_image_coords_to_pointer_f64(pid, *x, *y, screenshot_id.as_deref()),
            ClickTarget::ImageGrid { screenshot_id, .. } => {
                let (ix, iy) = Self::image_grid_target_to_xy(target)?.ok_or_else(|| {
                    OpenBitFunError::tool("invalid image_grid target".to_string())
                })?;
                self.map_app_image_coords_to_pointer_f64(pid, ix, iy, screenshot_id.as_deref())
            }
            ClickTarget::VisualGrid {
                rows,
                cols,
                row,
                col,
                intersections,
                wait_ms_after_detection,
            } => {
                let shot = self.screenshot_for_foreground_window(pid, hwnd_raw).await?;
                let (x0, y0, width, height) =
                    super::ax_orchestration::detect_regular_grid_rect_from_screenshot(
                        &shot, *rows, *cols,
                    )?;
                let detected = ClickTarget::ImageGrid {
                    x0,
                    y0,
                    width,
                    height,
                    rows: *rows,
                    cols: *cols,
                    row: *row,
                    col: *col,
                    intersections: *intersections,
                    screenshot_id: shot.screenshot_id.clone(),
                };
                let (ix, iy) = Self::image_grid_target_to_xy(&detected)?.ok_or_else(|| {
                    OpenBitFunError::tool("invalid detected visual_grid target".to_string())
                })?;
                if let Some(wait) = wait_ms_after_detection {
                    if *wait > 0 {
                        tokio::time::sleep(Duration::from_millis(*wait as u64)).await;
                    }
                }
                self.map_app_image_coords_to_pointer_f64(pid, ix, iy, shot.screenshot_id.as_deref())
            }
            ClickTarget::NodeIdx { idx } => {
                let (_, hwnd) = self.windows_target(app).await?;
                let idx = *idx;
                crate::computer_use::control_session::spawn_blocking(move || {
                    crate::computer_use::windows_ax_ui::cached_node_center(hwnd, idx)
                })
                .await
                .map_err(|e| OpenBitFunError::tool(e.to_string()))?
            }
            ClickTarget::OcrText { needle } => {
                let matches = self.ocr_find_text_matches(needle, None).await?;
                let best = matches.into_iter().max_by(|a, b| {
                    a.confidence
                        .partial_cmp(&b.confidence)
                        .unwrap_or(std::cmp::Ordering::Equal)
                });
                let m = best.ok_or_else(|| {
                    OpenBitFunError::tool(format!(
                        "NOT_FOUND: no OCR match for needle {:?}",
                        needle
                    ))
                })?;
                Ok((m.center_x, m.center_y))
            }
        }
    }
}

/// Inherent implementations backing the [`ComputerUseHost`] trait's pointer,
/// keyboard, and coordinate-mapping methods (see `mod.rs`'s thin trait-method
/// delegators).
impl NativeComputerUseHost {
    pub(super) fn map_image_coords_to_pointer_f64_impl(
        &self,
        x: i32,
        y: i32,
    ) -> OpenBitFunResult<(f64, f64)> {
        self.observed_pointer_map(None, None, false)?
            .map_image_to_global_f64(x, y)
    }

    pub(super) fn map_normalized_coords_to_pointer_f64_impl(
        &self,
        x: i32,
        y: i32,
    ) -> OpenBitFunResult<(f64, f64)> {
        self.observed_pointer_map(None, None, false)?
            .map_normalized_to_global_f64(x, y)
    }

    pub(super) async fn mouse_move_global_f64_impl(
        &self,
        gx: f64,
        gy: f64,
    ) -> OpenBitFunResult<()> {
        #[cfg(target_os = "linux")]
        if let Some(session) =
            crate::computer_use::linux_control::session().map_err(OpenBitFunError::tool)?
        {
            session
                .move_pointer(gx, gy)
                .await
                .map_err(OpenBitFunError::tool)?;
            ComputerUseHost::computer_use_after_pointer_mutation(self);
            return Ok(());
        }
        debug!(
            "computer_use: mouse_move_global_f64 smooth target ({:.2}, {:.2})",
            gx, gy
        );
        crate::computer_use::control_session::spawn_blocking(move || {
            #[cfg(target_os = "macos")]
            {
                Self::run_enigo_job(|_| Self::smooth_mouse_move_cg_global(gx, gy))
            }
            #[cfg(not(target_os = "macos"))]
            {
                Self::smooth_mouse_move_enigo_abs(gx, gy)
            }
        })
        .await
        .map_err(|e| OpenBitFunError::tool(e.to_string()))??;
        ComputerUseHost::computer_use_after_pointer_mutation(self);
        Ok(())
    }

    pub(super) async fn pointer_move_relative_impl(
        &self,
        dx: i32,
        dy: i32,
    ) -> OpenBitFunResult<()> {
        if dx == 0 && dy == 0 {
            return Ok(());
        }

        #[cfg(target_os = "linux")]
        if let Some(session) =
            crate::computer_use::linux_control::session().map_err(OpenBitFunError::tool)?
        {
            session
                .move_relative(dx, dy)
                .await
                .map_err(OpenBitFunError::tool)?;
            ComputerUseHost::computer_use_after_pointer_mutation(self);
            return Ok(());
        }

        #[cfg(target_os = "macos")]
        {
            // enigo `Coordinate::Rel` uses `location()` on macOS, which mixes NSEvent + main-display
            // pixel height — not the same space as `CGEvent` / our screenshot mapping. Use Quartz
            // position + scale from the last capture (display points per screenshot pixel).
            let (dpt_x, dpt_y) = self
                .observed_pointer_map(None, None, false)?
                .image_delta_to_global(dx, dy)?;

            crate::computer_use::control_session::spawn_blocking(move || {
                Self::run_enigo_job(|e| {
                    let (cx, cy) = macos::quartz_mouse_location().map_err(|err| {
                        OpenBitFunError::tool(format!("quartz pointer (relative move): {}", err))
                    })?;
                    let nx = (cx + dpt_x).round() as i32;
                    let ny = (cy + dpt_y).round() as i32;
                    e.move_mouse(nx, ny, Coordinate::Abs).map_err(|err| {
                        OpenBitFunError::tool(format!("pointer_move_relative: {}", err))
                    })
                })
            })
            .await
            .map_err(|e| OpenBitFunError::tool(e.to_string()))??;
            ComputerUseHost::computer_use_after_pointer_mutation(self);
            Ok(())
        }

        #[cfg(not(target_os = "macos"))]
        {
            crate::computer_use::control_session::spawn_blocking(move || {
                Self::run_enigo_job(|e| {
                    e.move_mouse(dx, dy, Coordinate::Rel).map_err(|err| {
                        OpenBitFunError::tool(format!("pointer_move_relative: {}", err))
                    })
                })
            })
            .await
            .map_err(|e| OpenBitFunError::tool(e.to_string()))??;
            ComputerUseHost::computer_use_after_pointer_mutation(self);
            Ok(())
        }
    }

    pub(super) async fn mouse_click_impl(&self, button: &str) -> OpenBitFunResult<()> {
        debug!("computer_use: mouse_click button={}", button);
        ComputerUseHost::computer_use_guard_click_allowed(self)?;
        self.mouse_click_at_current_pointer(button).await
    }

    pub(super) async fn mouse_click_authoritative_impl(
        &self,
        button: &str,
    ) -> OpenBitFunResult<()> {
        debug!("computer_use: mouse_click_authoritative button={}", button);
        self.mouse_click_at_current_pointer(button).await
    }

    pub(super) async fn mouse_down_impl(&self, button: &str) -> OpenBitFunResult<()> {
        #[cfg(target_os = "linux")]
        if let Some(session) =
            crate::computer_use::linux_control::session().map_err(OpenBitFunError::tool)?
        {
            let code = crate::computer_use::linux_control::button_code(button)
                .map_err(OpenBitFunError::tool)?;
            session
                .button(code, true)
                .await
                .map_err(OpenBitFunError::tool)?;
            ComputerUseHost::computer_use_after_pointer_mutation(self);
            return Ok(());
        }
        debug!("computer_use: mouse_down button={}", button);
        let button = button.to_string();
        crate::computer_use::control_session::spawn_blocking(move || {
            Self::run_enigo_job(|e| {
                let b = Self::map_button(&button)?;
                e.button(b, Direction::Press)
                    .map_err(|err| OpenBitFunError::tool(format!("mouse_down: {}", err)))
            })
        })
        .await
        .map_err(|e| OpenBitFunError::tool(e.to_string()))??;
        ComputerUseHost::computer_use_after_pointer_mutation(self);
        Ok(())
    }

    pub(super) async fn mouse_up_impl(&self, button: &str) -> OpenBitFunResult<()> {
        #[cfg(target_os = "linux")]
        if let Some(session) =
            crate::computer_use::linux_control::session().map_err(OpenBitFunError::tool)?
        {
            let code = crate::computer_use::linux_control::button_code(button)
                .map_err(OpenBitFunError::tool)?;
            session
                .button(code, false)
                .await
                .map_err(OpenBitFunError::tool)?;
            ComputerUseHost::computer_use_after_pointer_mutation(self);
            return Ok(());
        }
        debug!("computer_use: mouse_up button={}", button);
        let button = button.to_string();
        crate::computer_use::control_session::spawn_blocking(move || {
            Self::run_enigo_job(|e| {
                let b = Self::map_button(&button)?;
                e.button(b, Direction::Release)
                    .map_err(|err| OpenBitFunError::tool(format!("mouse_up: {}", err)))
            })
        })
        .await
        .map_err(|e| OpenBitFunError::tool(e.to_string()))??;
        ComputerUseHost::computer_use_after_pointer_mutation(self);
        Ok(())
    }

    /// Press-drag-release gesture. The desktop host performs a **background**
    /// (non-disruptive) drag where supported: macOS posts `bg_drag` to the
    /// frontmost app's pid, Windows posts `post_drag_screen` to the foreground
    /// window. When the background path is unavailable it falls back to the
    /// foreground composite gesture (visible cursor movement).
    pub(super) async fn drag_impl(
        &self,
        from: (f64, f64),
        to: (f64, f64),
        button: &str,
        duration_ms: u64,
    ) -> OpenBitFunResult<()> {
        Self::ensure_foreground_target()?;
        debug!(
            "computer_use: drag from=({:.1},{:.1}) to=({:.1},{:.1}) button={} dur={}ms",
            from.0, from.1, to.0, to.1, button, duration_ms
        );
        #[cfg(target_os = "linux")]
        if let Some(session) =
            crate::computer_use::linux_control::session().map_err(OpenBitFunError::tool)?
        {
            let code = crate::computer_use::linux_control::button_code(button)
                .map_err(OpenBitFunError::tool)?;
            session
                .move_pointer(from.0, from.1)
                .await
                .map_err(OpenBitFunError::tool)?;
            session
                .button(code, true)
                .await
                .map_err(OpenBitFunError::tool)?;
            let mut result = Ok(());
            for step in 1..=24 {
                let fraction = Self::smoothstep01(step as f64 / 24.0);
                if let Err(error) = session
                    .move_pointer(
                        from.0 + (to.0 - from.0) * fraction,
                        from.1 + (to.1 - from.1) * fraction,
                    )
                    .await
                {
                    result = Err(error);
                    break;
                }
                if step < 24 {
                    tokio::time::sleep(Duration::from_millis(duration_ms.min(10_000) / 24)).await;
                }
            }
            let release = session.button(code, false).await;
            result.and(release).map_err(OpenBitFunError::tool)?;
            ComputerUseHost::computer_use_after_pointer_mutation(self);
            ComputerUseHost::computer_use_after_committed_ui_action(self);
            return Ok(());
        }
        // Number of intermediate move samples for a smooth drag path.
        #[cfg(any(target_os = "macos", target_os = "windows"))]
        const DRAG_STEPS: usize = 24;

        #[cfg(target_os = "macos")]
        {
            crate::computer_use::control_session::foreground_allowed()
                .map_err(OpenBitFunError::tool)?;
            if crate::computer_use::macos_bg_input::supports_background_input() {
                if let Some(pid) = crate::computer_use::macos_bg_input::frontmost_pid_macos() {
                    let bg_button = match button {
                        "right" => crate::computer_use::macos_bg_input::BgDragButton::Right,
                        "middle" => crate::computer_use::macos_bg_input::BgDragButton::Middle,
                        _ => crate::computer_use::macos_bg_input::BgDragButton::Left,
                    };
                    let (fx, fy) = from;
                    let (tx, ty) = to;
                    crate::computer_use::control_session::spawn_blocking(move || {
                        macos::catch_objc(|| {
                            let wid = crate::computer_use::macos_capture::bound_window_id(pid)
                                .map_err(OpenBitFunError::tool)?;
                            crate::computer_use::macos_bg_input::bg_drag(
                                pid,
                                fx,
                                fy,
                                tx,
                                ty,
                                None,
                                None,
                                Some(wid),
                                duration_ms,
                                DRAG_STEPS,
                                &[],
                                bg_button,
                            )
                        })
                    })
                    .await
                    .map_err(|e| OpenBitFunError::tool(e.to_string()))??;
                    return Ok(());
                }
            }
        }

        #[cfg(target_os = "windows")]
        {
            let hwnd_raw = crate::computer_use::windows_ax_ui::foreground_window_handle();
            if hwnd_raw != 0 {
                let bstr = button.to_string();
                let (fx, fy) = (from.0.round() as i32, from.1.round() as i32);
                let (tx, ty) = (to.0.round() as i32, to.1.round() as i32);
                crate::computer_use::control_session::spawn_blocking(move || {
                    let hwnd = windows::Win32::Foundation::HWND(hwnd_raw as *mut std::ffi::c_void);
                    crate::computer_use::windows_bg_input::post_drag_screen(
                        hwnd,
                        fx,
                        fy,
                        tx,
                        ty,
                        duration_ms,
                        DRAG_STEPS,
                        &bstr,
                    )
                })
                .await
                .map_err(|e| OpenBitFunError::tool(e.to_string()))??;
                return Ok(());
            }
        }

        // Foreground fallback: visible composite gesture (default behavior).
        self.mouse_move_global_f64(from.0, from.1).await?;
        self.mouse_down(button).await?;
        let half = (duration_ms / 2).min(2_000);
        if half > 0 {
            self.wait_ms(half).await?;
        }
        self.mouse_move_global_f64(to.0, to.1).await?;
        if half > 0 {
            self.wait_ms(half).await?;
        }
        self.mouse_up(button).await
    }

    pub(super) async fn scroll_impl(&self, delta_x: i32, delta_y: i32) -> OpenBitFunResult<()> {
        if delta_x == 0 && delta_y == 0 {
            return Ok(());
        }
        #[cfg(target_os = "linux")]
        if let Some(session) =
            crate::computer_use::linux_control::session().map_err(OpenBitFunError::tool)?
        {
            session
                .scroll(f64::from(delta_x), f64::from(delta_y))
                .await
                .map_err(OpenBitFunError::tool)?;
            ComputerUseHost::computer_use_after_pointer_mutation(self);
            ComputerUseHost::computer_use_after_committed_ui_action(self);
            ComputerUseHost::computer_use_record_mutation(
                self,
                ComputerUseLastMutationKind::Scroll,
            );
            return Ok(());
        }
        crate::computer_use::control_session::spawn_blocking(move || {
            Self::run_enigo_job(|e| {
                if delta_x != 0 {
                    e.scroll(delta_x, Axis::Horizontal).map_err(|err| {
                        OpenBitFunError::tool(format!("scroll horizontal: {}", err))
                    })?;
                }
                if delta_y != 0 {
                    e.scroll(delta_y, Axis::Vertical).map_err(|err| {
                        OpenBitFunError::tool(format!("scroll vertical: {}", err))
                    })?;
                }
                Ok(())
            })
        })
        .await
        .map_err(|e| OpenBitFunError::tool(e.to_string()))??;
        ComputerUseHost::computer_use_after_pointer_mutation(self);
        ComputerUseHost::computer_use_after_committed_ui_action(self);
        ComputerUseHost::computer_use_record_mutation(self, ComputerUseLastMutationKind::Scroll);
        Ok(())
    }

    pub(super) async fn key_chord_impl(&self, keys: Vec<String>) -> OpenBitFunResult<()> {
        if keys.is_empty() {
            return Ok(());
        }
        debug!("computer_use: key_chord keys={:?}", keys);
        if Self::chord_includes_return_or_enter(&keys) {
            // Phase 1 fix: Enter/Return commits whatever has focus (form
            // submit, send-button, default action), so it is just as
            // dangerous as a `click` and must clear the **same** guard chain
            // as `click`. The previous `guard_verified_ui` only blocked
            // `click_needs_fresh_screenshot`, so a user could fire Enter
            // after a coarse full-display screenshot without ever taking
            // the required fine screenshot. Routing through
            // `computer_use_guard_click_allowed` makes the two paths
            // consistent and prevents the model from "smuggling" a click
            // through an Enter key.
            Self::computer_use_guard_click_allowed(self)?;
        }
        #[cfg(target_os = "linux")]
        if let Some(session) =
            crate::computer_use::linux_control::session().map_err(OpenBitFunError::tool)?
        {
            session
                .key_chord(&keys)
                .await
                .map_err(OpenBitFunError::tool)?;
            ComputerUseHost::computer_use_after_pointer_mutation(self);
            ComputerUseHost::computer_use_after_committed_ui_action(self);
            ComputerUseHost::computer_use_record_mutation(
                self,
                ComputerUseLastMutationKind::KeyChord,
            );
            return Ok(());
        }
        let keys_for_job = keys;
        crate::computer_use::control_session::spawn_blocking(move || {
            Self::run_enigo_job(|e| {
                let mapped: Vec<Key> = keys_for_job
                    .iter()
                    .map(|s| Self::map_key(s))
                    .collect::<OpenBitFunResult<_>>()?;
                let chord_has_modifier = keys_for_job.iter().any(|s| {
                    matches!(
                        s.to_lowercase().as_str(),
                        "command"
                            | "meta"
                            | "super"
                            | "win"
                            | "control"
                            | "ctrl"
                            | "shift"
                            | "alt"
                            | "option"
                    )
                });
                if mapped.len() == 1 {
                    e.key(mapped[0], Direction::Click)
                        .map_err(|err| OpenBitFunError::tool(format!("key: {}", err)))?;
                } else {
                    let mods = &mapped[..mapped.len() - 1];
                    let last = *mapped.last().unwrap();
                    for k in mods {
                        e.key(*k, Direction::Press)
                            .map_err(|err| OpenBitFunError::tool(format!("key press: {}", err)))?;
                    }
                    if chord_has_modifier {
                        // Modifiers must be registered before the main key; otherwise macOS / IME
                        // treats the letter as plain typing (e.g. Cmd+F becomes "f" in the text box).
                        #[cfg(target_os = "macos")]
                        std::thread::sleep(std::time::Duration::from_millis(160));
                        #[cfg(not(target_os = "macos"))]
                        std::thread::sleep(std::time::Duration::from_millis(55));
                    }
                    crate::computer_use::control_session::foreground_allowed()
                        .map_err(OpenBitFunError::tool)?;
                    e.key(last, Direction::Click)
                        .map_err(|err| OpenBitFunError::tool(format!("key click: {}", err)))?;
                    for k in mods.iter().rev() {
                        e.key(*k, Direction::Release).map_err(|err| {
                            OpenBitFunError::tool(format!("key release: {}", err))
                        })?;
                    }
                    if chord_has_modifier {
                        std::thread::sleep(std::time::Duration::from_millis(35));
                    }
                }
                Ok(())
            })
        })
        .await
        .map_err(|e| OpenBitFunError::tool(e.to_string()))??;
        ComputerUseHost::computer_use_after_pointer_mutation(self);
        ComputerUseHost::computer_use_after_committed_ui_action(self);
        ComputerUseHost::computer_use_record_mutation(self, ComputerUseLastMutationKind::KeyChord);
        Ok(())
    }

    pub(super) async fn type_text_impl(&self, text: &str) -> OpenBitFunResult<()> {
        Self::ensure_foreground_target()?;
        if text.is_empty() {
            return Ok(());
        }
        #[cfg(target_os = "linux")]
        if let Some(session) =
            crate::computer_use::linux_control::session().map_err(OpenBitFunError::tool)?
        {
            session
                .type_text(text)
                .await
                .map_err(OpenBitFunError::tool)?;
            ComputerUseHost::computer_use_after_committed_ui_action(self);
            ComputerUseHost::computer_use_trust_pointer_after_text_input(self);
            ComputerUseHost::computer_use_record_mutation(
                self,
                ComputerUseLastMutationKind::TypeText,
            );
            return Ok(());
        }
        // On macOS, route through background input when the frontmost app
        // is a terminal emulator — enigo.text() uses Unicode string
        // injection which terminal emulators (Ghostty, iTerm2, Terminal.app)
        // silently drop. bg_type_text_auto detects this and switches to
        // per-keystroke key-event synthesis.
        #[cfg(target_os = "macos")]
        {
            crate::computer_use::control_session::foreground_allowed()
                .map_err(OpenBitFunError::tool)?;
            if crate::computer_use::macos_bg_input::supports_background_input() {
                let frontmost = crate::computer_use::macos_bg_input::frontmost_pid_macos();
                if let Some(pid) = frontmost {
                    if crate::computer_use::macos_bg_input::is_terminal_emulator(pid) {
                        let txt = text.to_string();
                        crate::computer_use::control_session::spawn_blocking(move || {
                            macos::catch_objc(|| {
                                crate::computer_use::macos_bg_input::bg_type_text_auto(pid, &txt)
                            })
                        })
                        .await
                        .map_err(|e| OpenBitFunError::tool(e.to_string()))??;
                        ComputerUseHost::computer_use_after_committed_ui_action(self);
                        ComputerUseHost::computer_use_trust_pointer_after_text_input(self);
                        ComputerUseHost::computer_use_record_mutation(
                            self,
                            ComputerUseLastMutationKind::TypeText,
                        );
                        return Ok(());
                    }
                }
            }
        }
        let owned = text.to_string();
        crate::computer_use::control_session::spawn_blocking(move || {
            Self::run_enigo_job(|e| {
                e.text(&owned)
                    .map_err(|err| OpenBitFunError::tool(format!("type_text: {}", err)))
            })
        })
        .await
        .map_err(|e| OpenBitFunError::tool(e.to_string()))??;
        // Typing does not move the pointer; do not set click_needs (would block Enter after search).
        ComputerUseHost::computer_use_after_committed_ui_action(self);
        ComputerUseHost::computer_use_trust_pointer_after_text_input(self);
        ComputerUseHost::computer_use_record_mutation(self, ComputerUseLastMutationKind::TypeText);
        Ok(())
    }
}
