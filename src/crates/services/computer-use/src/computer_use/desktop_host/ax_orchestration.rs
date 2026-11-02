//! AX-first orchestration for the desktop Computer Use host: the
//! `app_*` window-scoped actions (click/type/scroll/key-chord/wait) and the
//! `interactive_*` / `visual_*` cached-index action families (build view,
//! click/type/scroll by cached index), plus their shared digest/grid-
//! detection helpers.
//!
//! Extracted from `desktop_host/mod.rs` (no behavior change) so the
//! AX-orchestration surface has a single, independently reviewable home
//! instead of living inline inside the multi-thousand-line host file.

#[cfg(target_os = "macos")]
use super::macos;
#[cfg(any(target_os = "macos", target_os = "windows"))]
use super::resolve_pid;
use super::NativeComputerUseHost;
#[cfg(not(any(target_os = "macos", target_os = "windows")))]
use super::LINUX_LEGACY_AX_UNAVAILABLE;
#[cfg(target_os = "macos")]
use super::{require_macos_background_input, resolve_pid_macos};
#[cfg(any(target_os = "macos", target_os = "windows"))]
use super::{CachedInteractiveView, CachedVisualMarkView};
#[cfg(any(target_os = "macos", target_os = "windows"))]
use log::warn;
use openbitfun_agent_tools::computer_use_host::error::{OpenBitFunError, OpenBitFunResult};
#[cfg(any(test, target_os = "macos", target_os = "windows"))]
use openbitfun_agent_tools::computer_use_host::ComputerScreenshot;
use openbitfun_agent_tools::computer_use_host::ComputerUseHost;
#[cfg(any(target_os = "macos", target_os = "windows"))]
use openbitfun_agent_tools::computer_use_host::VisualMark;
use openbitfun_agent_tools::computer_use_host::{
    AppClickParams, AppInputAction, AppSelector, AppStateSnapshot, AppWaitPredicate, ClickTarget,
    InteractiveActionResult, InteractiveClickParams, InteractiveScrollParams,
    InteractiveTypeTextParams, InteractiveView, InteractiveViewOpts, VisualActionResult,
    VisualClickParams, VisualMarkView, VisualMarkViewOpts,
};
#[cfg(any(target_os = "macos", target_os = "windows"))]
use std::time::{Duration, Instant};

#[cfg(all(test, any(target_os = "macos", target_os = "windows")))]
mod context_integrity_tests {
    use super::*;

    #[test]
    fn point_press_preserves_non_plain_click_contracts() {
        assert!(is_plain_activation_click("left", 1, &[]));
        for button in ["right", "middle"] {
            assert!(!is_plain_activation_click(button, 1, &[]));
        }
        for count in [0, 2, 3] {
            assert!(!is_plain_activation_click("left", count, &[]));
        }
        for modifier in ["command", "control", "shift", "option"] {
            assert!(!is_plain_activation_click("left", 1, &[modifier.into()]));
        }
    }

    #[cfg(target_os = "macos")]
    #[test]
    fn absent_observed_node_never_resnapshots_or_dispatches_input() {
        let error = resolve_macos_node_click(i32::MAX, 0, true).unwrap_err();
        assert!(error.to_string().contains("AX_NODE_STALE"), "{error}");
    }

    #[test]
    fn coordinate_fallback_requires_a_finite_nonempty_observed_frame() {
        assert_eq!(
            observed_node_center((100.0, 200.0, 80.0, 40.0)).unwrap(),
            (140.0, 220.0)
        );
        for frame in [
            (0.0, 0.0, 0.0, 10.0),
            (0.0, 0.0, 10.0, -1.0),
            (f64::NAN, 0.0, 10.0, 10.0),
            (0.0, 0.0, f64::INFINITY, 10.0),
        ] {
            assert!(observed_node_center(frame).is_err());
        }
    }

    #[tokio::test]
    async fn stale_view_actions_do_not_rebuild_and_retarget_old_indices() {
        let host = NativeComputerUseHost::new();
        // No running app is involved. A stale request must fail before capture
        // or OS input, leaving the cached observation untouched.
        let pid = i32::MAX;
        {
            let mut state = host.state.lock().unwrap();
            state.interactive_view_cache.insert(
                pid,
                CachedInteractiveView {
                    digest: "current-observation".into(),
                    elements: vec![],
                },
            );
            state.visual_mark_cache.insert(
                pid,
                CachedVisualMarkView {
                    digest: "current-observation".into(),
                    marks: vec![],
                    screenshot_id: None,
                },
            );
        }
        let interactive = serde_json::from_value(serde_json::json!({
            "i":0, "before_view_digest":"previous-observation"
        }))
        .unwrap();
        let error = host
            .interactive_click_impl(AppSelector::by_pid(pid), interactive)
            .await
            .unwrap_err();
        assert!(
            error.to_string().contains("STALE_INTERACTIVE_VIEW"),
            "{error}"
        );
        let visual = serde_json::from_value(serde_json::json!({
            "i":0, "before_view_digest":"previous-observation"
        }))
        .unwrap();
        let error = host
            .visual_click_impl(AppSelector::by_pid(pid), visual)
            .await
            .unwrap_err();
        assert!(
            error.to_string().contains("STALE_VISUAL_MARK_VIEW"),
            "{error}"
        );
        assert_eq!(
            host.state.lock().unwrap().interactive_view_cache[&pid].digest,
            "current-observation"
        );
    }
}

#[cfg(any(test, target_os = "macos"))]
fn is_plain_activation_click(button: &str, count: u8, modifiers: &[String]) -> bool {
    button == "left" && count == 1 && modifiers.is_empty()
}

#[cfg(target_os = "macos")]
fn try_macos_point_press(pid: i32, x: f64, y: f64) -> OpenBitFunResult<bool> {
    let Some(target) = crate::computer_use::macos_ax_dump::retained_target_at_point(pid, x, y)?
    else {
        return Ok(false);
    };
    crate::computer_use::macos_ax_dump::validate_bound_target(pid, target.reference())?;
    if !target.supports_point_press() {
        return Ok(false);
    }
    match crate::computer_use::macos_ax_write::try_ax_press(target.reference()) {
        crate::computer_use::macos_ax_write::AxWriteOutcome::Ok => {
            crate::computer_use::control_session::record_pointer(x, y, true);
            Ok(true)
        },
        crate::computer_use::macos_ax_write::AxWriteOutcome::Unavailable(-25206) => Ok(false),
        crate::computer_use::macos_ax_write::AxWriteOutcome::Unavailable(status) => Err(OpenBitFunError::tool(format!("AX_ACTION_OUTCOME_UNKNOWN: AXPress returned {status}; no coordinate retry was sent. Observe before choosing another action"))),
    }
}

#[cfg(target_os = "macos")]
fn resolve_macos_node_click(
    pid: i32,
    idx: u32,
    semantic: bool,
) -> OpenBitFunResult<Option<(f64, f64)>> {
    let target = crate::computer_use::macos_ax_dump::retained_cached_target(pid, idx)
        .ok_or_else(|| OpenBitFunError::tool(format!("AX_NODE_STALE: idx={idx} is not in the observed app snapshot; observe the app again")))?;
    crate::computer_use::macos_ax_dump::validate_bound_target(pid, target.reference())?;
    if semantic {
        match crate::computer_use::macos_ax_write::try_ax_press(target.reference()) {
            crate::computer_use::macos_ax_write::AxWriteOutcome::Ok => return Ok(None),
            // kAXErrorActionUnsupported guarantees no semantic action was sent.
            crate::computer_use::macos_ax_write::AxWriteOutcome::Unavailable(-25206) => {}
            crate::computer_use::macos_ax_write::AxWriteOutcome::Unavailable(status) => {
                return Err(OpenBitFunError::tool(format!("AX_ACTION_OUTCOME_UNKNOWN: AXPress returned {status}; no coordinate retry was sent. Re-observe before deciding another action")));
            }
        }
    }
    let frame = target.frame_global().ok_or_else(|| {
        OpenBitFunError::tool(format!(
            "AX_NODE_STALE: idx={idx} no longer has a readable frame; observe the app again"
        ))
    })?;
    observed_node_center(frame).map(Some)
}

#[cfg(any(test, target_os = "macos"))]
fn observed_node_center(
    (x, y, width, height): (f64, f64, f64, f64),
) -> OpenBitFunResult<(f64, f64)> {
    if ![x, y, width, height].into_iter().all(f64::is_finite) || width <= 0.0 || height <= 0.0 {
        return Err(OpenBitFunError::tool(
            "AX_NODE_STALE: Observed target has an invalid or empty frame",
        ));
    }
    Ok((x + width / 2.0, y + height / 2.0))
}

impl NativeComputerUseHost {
    async fn dispatch_app_click_impl(&self, params: AppClickParams) -> OpenBitFunResult<()> {
        super::background_guard::run(self.dispatch_app_click_native(params)).await
    }
    async fn dispatch_app_type_text_impl(
        &self,
        app: AppSelector,
        text: &str,
        focus: Option<ClickTarget>,
    ) -> OpenBitFunResult<()> {
        super::background_guard::run(self.dispatch_app_type_text_native(app, text, focus)).await
    }
    async fn dispatch_app_scroll_impl(
        &self,
        app: AppSelector,
        focus: Option<ClickTarget>,
        dx: i32,
        dy: i32,
    ) -> OpenBitFunResult<()> {
        super::background_guard::run(self.dispatch_app_scroll_native(app, focus, dx, dy)).await
    }
    async fn dispatch_app_key_chord_impl(
        &self,
        app: AppSelector,
        keys: Vec<String>,
        focus_idx: Option<u32>,
    ) -> OpenBitFunResult<()> {
        super::background_guard::run(self.dispatch_app_key_chord_native(app, keys, focus_idx)).await
    }
    async fn dispatch_app_drag_impl(
        &self,
        app: AppSelector,
        from: ClickTarget,
        to: ClickTarget,
        button: String,
        duration_ms: u64,
    ) -> OpenBitFunResult<()> {
        super::background_guard::run(self.dispatch_app_drag_native(
            app,
            from,
            to,
            button,
            duration_ms,
        ))
        .await
    }

    pub(super) async fn dispatch_app_input_impl(
        &self,
        app: AppSelector,
        action: AppInputAction,
    ) -> OpenBitFunResult<()> {
        action.validate().map_err(OpenBitFunError::tool)?;
        crate::computer_use::control_session::input_allowed().map_err(OpenBitFunError::tool)?;
        match action {
            AppInputAction::Click {
                target,
                click_count,
                mouse_button,
                modifier_keys,
                wait_ms_after,
            } => {
                self.dispatch_app_click_impl(AppClickParams {
                    app,
                    target,
                    click_count,
                    mouse_button,
                    modifier_keys,
                    wait_ms_after,
                })
                .await
            }
            AppInputAction::TypeText { text, focus } => {
                self.dispatch_app_type_text_impl(app, &text, focus).await
            }
            AppInputAction::KeyChord { keys, focus_idx } => {
                self.dispatch_app_key_chord_impl(app, keys, focus_idx).await
            }
            AppInputAction::Scroll { dx, dy, focus } => {
                self.dispatch_app_scroll_impl(app, focus, dx, dy).await
            }
            AppInputAction::Wait { ms } => self.wait_ms(ms).await,
            AppInputAction::Drag {
                from,
                to,
                mouse_button,
                duration_ms,
            } => {
                self.dispatch_app_drag_impl(app, from, to, mouse_button, duration_ms)
                    .await
            }
        }
    }

    async fn dispatch_app_drag_native(
        &self,
        app: AppSelector,
        from: ClickTarget,
        to: ClickTarget,
        button: String,
        duration_ms: u64,
    ) -> OpenBitFunResult<()> {
        #[cfg(any(target_os = "macos", target_os = "windows"))]
        {
            #[cfg(target_os = "macos")]
            let pid = resolve_pid_macos(self, &app).await?;
            #[cfg(target_os = "windows")]
            let (pid, hwnd) = self.windows_target(&app).await?;
            // Both endpoints refer to observed pixels from this same window.
            let point = |target: ClickTarget| -> OpenBitFunResult<(f64, f64)> {
                match target {
                    ClickTarget::ImageXy {x, y, screenshot_id} => self.map_app_image_coords_to_pointer_f64(pid, x, y, screenshot_id.as_deref()),
                    _ => Err(OpenBitFunError::tool("[INVALID_DRAG_TARGET] Drag endpoints require image_xy and screenshot_id from the observed app window")),
                }
            };
            let (x0, y0) = point(from)?;
            let (x1, y1) = point(to)?;
            let steps = (duration_ms / 16).clamp(2, 120) as usize;
            #[cfg(target_os = "macos")]
            {
                let wid = crate::computer_use::macos_capture::bound_window_id(pid)
                    .map_err(OpenBitFunError::tool)?;
                let [wx, wy, _, _] = crate::computer_use::macos_capture::window_bounds(pid, wid)
                    .map_err(OpenBitFunError::tool)?;
                let button = match button.as_str() {
                    "right" => crate::computer_use::macos_bg_input::BgDragButton::Right,
                    "middle" => crate::computer_use::macos_bg_input::BgDragButton::Middle,
                    _ => crate::computer_use::macos_bg_input::BgDragButton::Left,
                };
                crate::computer_use::control_session::spawn_blocking(move || {
                    macos::catch_objc(|| {
                        crate::computer_use::macos_bg_input::bg_drag(
                            pid,
                            x0,
                            y0,
                            x1,
                            y1,
                            Some((x0 - wx, y0 - wy)),
                            Some((x1 - wx, y1 - wy)),
                            Some(wid),
                            duration_ms,
                            steps,
                            &[],
                            button,
                        )
                    })
                })
                .await
                .map_err(|e| OpenBitFunError::tool(e.to_string()))??;
            }
            #[cfg(target_os = "windows")]
            {
                crate::computer_use::control_session::spawn_blocking(move || {
                    crate::computer_use::windows_bg_input::post_drag_screen(
                        windows::Win32::Foundation::HWND(hwnd as *mut std::ffi::c_void),
                        x0.round() as i32,
                        y0.round() as i32,
                        x1.round() as i32,
                        y1.round() as i32,
                        duration_ms,
                        steps,
                        &button,
                    )
                })
                .await
                .map_err(|e| OpenBitFunError::tool(e.to_string()))??;
            }
            crate::computer_use::control_session::record_pointer(x1, y1, false);
            Ok(())
        }
        #[cfg(not(any(target_os = "macos", target_os = "windows")))]
        {
            let _ = (app, from, to, button, duration_ms);
            Err(OpenBitFunError::tool("[BACKGROUND_DRAG_UNAVAILABLE] This compositor does not support app-directed background dragging"))
        }
    }

    pub(super) async fn app_click_impl(
        &self,
        params: AppClickParams,
    ) -> OpenBitFunResult<AppStateSnapshot> {
        let app = params.app.clone();
        self.dispatch_app_click_impl(params).await?;
        self.observe_after_app_input(app).await
    }

    async fn observe_after_app_input(
        &self,
        app: AppSelector,
    ) -> OpenBitFunResult<AppStateSnapshot> {
        // Settling only delays the read; its outcome never fails delivered input.
        let _ = self
            .settle_after_input_impl(
                app.clone(),
                openbitfun_agent_tools::computer_use_host::AppInputSettlePolicy::default(),
            )
            .await;
        self.get_app_state(app, 32, true).await.map_err(|error| {
            OpenBitFunError::tool(format!("[POST_INPUT_OBSERVATION_FAILED] Input was already submitted; only observation failed: {error}. Observe the target before deciding another input; do not replay the action to repair this error."))
        })
    }

    async fn dispatch_app_click_native(&self, params: AppClickParams) -> OpenBitFunResult<()> {
        #[cfg(target_os = "macos")]
        {
            let pid = resolve_pid_macos(self, &params.app).await?;
            let self_pid = std::process::id() as i32;
            log::info!(
                target: "computer_use::app_click",
                "app_click.enter pid={} self_pid={} same_process={} target={:?} button={} click_count={} modifier_keys={:?}",
                pid,
                self_pid,
                pid == self_pid,
                params.target,
                params.mouse_button,
                params.click_count,
                params.modifier_keys
            );
            // Retain the exact observed AX node. Never rebuild a tree and
            // reinterpret an old index after an unsupported semantic action.
            let mut node_coordinates = None;
            let mut image_coordinates = None;
            let ax_ok = match &params.target {
                ClickTarget::NodeIdx { idx } => {
                    let idx = *idx;
                    let semantic = params.mouse_button == "left"
                        && params.click_count == 1
                        && params.modifier_keys.is_empty();
                    node_coordinates =
                        crate::computer_use::control_session::spawn_blocking(move || {
                            macos::catch_objc_local(|| resolve_macos_node_click(pid, idx, semantic))
                        })
                        .await
                        .map_err(|error| OpenBitFunError::tool(error.to_string()))??;
                    node_coordinates.is_none()
                }
                ClickTarget::ImageXy {
                    x,
                    y,
                    screenshot_id,
                } if is_plain_activation_click(
                    &params.mouse_button,
                    params.click_count,
                    &params.modifier_keys,
                ) =>
                {
                    let (x, y) = self.map_app_image_coords_to_pointer_f64(
                        pid,
                        *x,
                        *y,
                        screenshot_id.as_deref(),
                    )?;
                    image_coordinates = Some((x, y));
                    crate::computer_use::control_session::spawn_blocking(move || {
                        macos::catch_objc_local(|| try_macos_point_press(pid, x, y))
                    })
                    .await
                    .map_err(|error| OpenBitFunError::tool(error.to_string()))??
                }
                ClickTarget::ScreenXy { .. }
                | ClickTarget::ImageXy { .. }
                | ClickTarget::ImageGrid { .. }
                | ClickTarget::VisualGrid { .. }
                | ClickTarget::OcrText { .. } => false,
            };
            if !ax_ok {
                require_macos_background_input()?;
                let (x, y) = self
                    .resolve_macos_pointer_target(
                        pid,
                        &params.target,
                        node_coordinates,
                        image_coordinates,
                    )
                    .await?;
                let mods: Vec<crate::computer_use::macos_bg_input::BgModifier> = params
                    .modifier_keys
                    .iter()
                    .filter_map(|m| crate::computer_use::macos_bg_input::BgModifier::from_str(m))
                    .collect();
                let btn = match params.mouse_button.as_str() {
                    "right" => crate::computer_use::macos_bg_input::BgMouseButton::Right,
                    "middle" => crate::computer_use::macos_bg_input::BgMouseButton::Middle,
                    _ => crate::computer_use::macos_bg_input::BgMouseButton::Left,
                };
                let cnt = params.click_count.max(1) as u32;
                log::info!(
                    target: "computer_use::app_click",
                    "app_click.bg_dispatch pid={} self_pid={} same_process={} resolved_x={:.2} resolved_y={:.2} click_count={}",
                    pid, self_pid, pid == self_pid, x, y, cnt
                );

                // Chromium routing must use the same window and coordinate
                // basis as the captured image. The sharing indicator can be
                // WindowServer's first window for this PID; it is not a target.
                let bundle_id_opt = params
                    .app
                    .bundle_id
                    .clone()
                    .or_else(|| crate::computer_use::macos_bg_input::bundle_id_for_pid(pid));
                let is_chromium = crate::computer_use::macos_bg_input::is_chromium_electron(
                    bundle_id_opt.as_deref(),
                );
                let (win_id, win_bounds) =
                    crate::computer_use::control_session::spawn_blocking(move || {
                        macos::catch_objc(|| {
                            let wid = crate::computer_use::macos_capture::bound_window_id(pid)
                                .map_err(OpenBitFunError::tool)?;
                            let bounds =
                                crate::computer_use::macos_capture::window_bounds(pid, wid)
                                    .map_err(OpenBitFunError::tool)?;
                            Ok::<_, OpenBitFunError>((wid, bounds))
                        })
                    })
                    .await
                    .map_err(|error| OpenBitFunError::tool(error.to_string()))??;

                // Raw mouse-down requires explicit foreground authorization;
                // the native dispatcher rejects background mode before posting.
                let mods_for_bg = mods.clone();
                let win_bounds_for_click = win_bounds;
                let wid_for_click = win_id;
                crate::computer_use::control_session::spawn_blocking(move || {
                    macos::catch_objc(|| {
                        // This Chromium recipe encodes a left button. Other
                        // buttons use the ordinary directed event path.
                        if is_chromium
                            && btn == crate::computer_use::macos_bg_input::BgMouseButton::Left
                        {
                            let [wx, wy, _, _] = win_bounds_for_click;
                            return crate::computer_use::macos_bg_input::bg_click_chromium(
                                pid,
                                x,
                                y,
                                x - wx,
                                y - wy,
                                wid_for_click,
                                cnt,
                                &mods_for_bg,
                            );
                        }
                        crate::computer_use::macos_bg_input::bg_click(
                            pid,
                            (x, y),
                            btn,
                            cnt,
                            &mods_for_bg,
                        )
                    })
                })
                .await
                .map_err(|e| OpenBitFunError::tool(e.to_string()))??;
            }
            let settle_ms = params.wait_ms_after.unwrap_or(0);
            if settle_ms > 0 {
                crate::computer_use::control_session::wait(settle_ms as u64)
                    .await
                    .map_err(OpenBitFunError::tool)?;
            }
            Ok(())
        }
        #[cfg(target_os = "windows")]
        {
            let (_, hwnd_raw) = self.windows_target(&params.app).await?;
            if let ClickTarget::NodeIdx { idx } = &params.target {
                if params.mouse_button != "left"
                    || params.click_count != 1
                    || !params.modifier_keys.is_empty()
                {
                    return Err(OpenBitFunError::tool("[AX_ACTION_UNSUPPORTED] Semantic activation supports one unmodified left click"));
                }
                let idx = *idx;
                crate::computer_use::control_session::spawn_blocking(move || {
                    crate::computer_use::windows_ax_ui::invoke_cached_node(hwnd_raw, idx)
                })
                .await
                .map_err(|e| OpenBitFunError::tool(e.to_string()))??;
            } else {
                let (x, y) = self
                    .resolve_click_target_windows(&params.target, &params.app)
                    .await?;
                let button = params.mouse_button.clone();
                let count = params.click_count.max(1) as usize;
                let modifiers = params.modifier_keys.clone();
                crate::computer_use::control_session::spawn_blocking(move || {
                    let hwnd = windows::Win32::Foundation::HWND(hwnd_raw as *mut std::ffi::c_void);
                    crate::computer_use::windows_bg_input::post_click_screen(
                        hwnd,
                        x.round() as i32,
                        y.round() as i32,
                        &button,
                        count,
                        &modifiers,
                    )?;
                    crate::computer_use::control_session::record_pointer(x, y, true);
                    Ok::<_, OpenBitFunError>(())
                })
                .await
                .map_err(|e| OpenBitFunError::tool(e.to_string()))??;
            }
            let settle_ms = params.wait_ms_after.unwrap_or(0);
            if settle_ms > 0 {
                crate::computer_use::control_session::wait(settle_ms as u64)
                    .await
                    .map_err(OpenBitFunError::tool)?;
            }
            Ok(())
        }
        #[cfg(target_os = "linux")]
        {
            if params.click_count != 1
                || params.mouse_button != "left"
                || !params.modifier_keys.is_empty()
            {
                return Err(OpenBitFunError::tool("[BACKGROUND_ACTION_UNAVAILABLE] AT-SPI default actions support one semantic activation without mouse modifiers."));
            }
            let ClickTarget::NodeIdx { idx } = params.target else {
                return Err(OpenBitFunError::tool("[FOREGROUND_REQUIRED] Linux background app actions require an observed AT-SPI node. Coordinate input requires an authorized foreground portal session."));
            };
            crate::computer_use::linux_control_ax::press(&params.app, idx).await?;
            if let Some(delay) = params.wait_ms_after {
                crate::computer_use::control_session::wait(delay as u64)
                    .await
                    .map_err(OpenBitFunError::tool)?;
            }
            Ok(())
        }
    }

    pub(super) async fn app_type_text_impl(
        &self,
        app: AppSelector,
        text: &str,
        focus: Option<ClickTarget>,
    ) -> OpenBitFunResult<AppStateSnapshot> {
        self.dispatch_app_type_text_impl(app.clone(), text, focus)
            .await?;
        self.observe_after_app_input(app).await
    }

    /// Resolve focus through the target application's own accessibility hit test,
    /// not the human's foreground window and not a guessed containing rectangle.
    /// This preserves text insertion semantics without synthesizing a mouse click.
    #[cfg(target_os = "macos")]
    async fn try_focus_macos_text_target(
        &self,
        pid: i32,
        target: &ClickTarget,
    ) -> OpenBitFunResult<bool> {
        self.try_macos_text_operation(pid, target, None).await
    }

    #[cfg(target_os = "macos")]
    async fn try_macos_text_operation(
        &self,
        pid: i32,
        target: &ClickTarget,
        insertion: Option<String>,
    ) -> OpenBitFunResult<bool> {
        let point = match target {
            ClickTarget::NodeIdx { .. } => None,
            _ => Some(
                self.resolve_macos_pointer_target(pid, target, None, None)
                    .await?,
            ),
        };
        let index = if let ClickTarget::NodeIdx { idx } = target {
            Some(*idx)
        } else {
            None
        };
        if point.is_none() && index.is_none() {
            return Ok(false);
        }
        crate::computer_use::control_session::spawn_blocking(move || macos::catch_objc_local(|| {
            let element = if let Some(index) = index {
                Some(crate::computer_use::macos_ax_dump::retained_cached_target(pid, index)
                    .ok_or_else(|| OpenBitFunError::tool("AX_NODE_STALE: text focus target is no longer in the observed snapshot"))?)
            } else if let Some((x, y)) = point {
                crate::computer_use::macos_ax_dump::retained_target_at_point(pid, x, y)?
            } else { None };
            let Some(element) = element else { return Ok(false); };
            crate::computer_use::macos_ax_dump::validate_bound_target(pid, element.reference())?;
            if !element.is_text_input() { return Ok(false); }
            if let Some(text) = insertion.as_deref() {
                return crate::computer_use::macos_ax_write::insert_selected_text(element.reference(), text);
            }
            // Reapplying AXFocused can reset a native editor's selection.
            // A retained, already-focused field needs no mutation here.
            if element.is_focused() { return Ok(true); }
            match crate::computer_use::macos_ax_write::try_ax_focus(element.reference()) {
                crate::computer_use::macos_ax_write::AxWriteOutcome::Ok => Ok(true),
                crate::computer_use::macos_ax_write::AxWriteOutcome::Unavailable(-25205 | -25206) => Ok(false),
                crate::computer_use::macos_ax_write::AxWriteOutcome::Unavailable(status) => Err(OpenBitFunError::tool(format!("AX_FOCUS_OUTCOME_UNKNOWN: AXFocused returned {status}; no click or text was sent. Observe before choosing another action"))),
            }
        })).await.map_err(|error| OpenBitFunError::tool(error.to_string()))?
    }

    async fn dispatch_app_type_text_native(
        &self,
        app: AppSelector,
        text: &str,
        focus: Option<ClickTarget>,
    ) -> OpenBitFunResult<()> {
        #[cfg(target_os = "macos")]
        {
            let pid = resolve_pid_macos(self, &app).await?;
            let text_target = focus.clone();
            // Focus an observed text control semantically before considering pointer input.
            if let Some(target) = focus {
                if !self.try_focus_macos_text_target(pid, &target).await? {
                    let verify_pointer_focus = !matches!(&target, ClickTarget::NodeIdx { .. });
                    let click = AppClickParams {
                        app: app.clone(),
                        target,
                        click_count: 1,
                        mouse_button: "left".to_string(),
                        modifier_keys: vec![],
                        wait_ms_after: None,
                    };
                    // The outer focus-and-type action already witnesses the
                    // complete operation, including this native focus click.
                    self.dispatch_app_click_native(click).await?;
                    // Pointer targets (including OCR) record the actual submitted
                    // location. Do not infer it from the human's real mouse.
                    let intended_point = verify_pointer_focus
                        .then(|| crate::computer_use::control_session::snapshot().pointer)
                        .flatten()
                        .map(|point| (point.x, point.y));
                    if let Some((x, y)) = intended_point {
                        let mismatch = crate::computer_use::control_session::spawn_blocking(move || macos::catch_objc_local(||
                        crate::computer_use::macos_ax_dump::focused_text_target_mismatch(pid, x, y)
                    )).await.map_err(|error| OpenBitFunError::tool(error.to_string()))??;
                        if mismatch {
                            return Err(OpenBitFunError::tool("FOCUS_TARGET_MISMATCH: The application still reports a different text field as focused after the click. No text was sent. Observe and select the intended field before typing."));
                        }
                    }
                }
            }
            if let Some(target) = text_target.as_ref() {
                if self
                    .try_macos_text_operation(pid, target, Some(text.to_owned()))
                    .await?
                {
                    return Ok(());
                }
            }
            require_macos_background_input()?;
            log::info!(
                target: "computer_use::app_type_text",
                "app_type_text.bg_dispatch pid={} char_count={}",
                pid,
                text.chars().count()
            );
            let txt = text.to_string();
            // Use bg_type_text_auto which routes to terminal-safe key-event
            // typing when the target is a terminal emulator.
            crate::computer_use::control_session::spawn_blocking(move || {
                macos::catch_objc(|| {
                    crate::computer_use::macos_bg_input::bg_type_text_auto(pid, &txt)
                })
            })
            .await
            .map_err(|e| OpenBitFunError::tool(e.to_string()))??;
            Ok(())
        }
        #[cfg(target_os = "windows")]
        {
            let (pid, hwnd_raw) = self.windows_target(&app).await?;
            let (index, point) = match focus {
                Some(ClickTarget::NodeIdx { idx }) => (Some(idx), None),
                Some(ClickTarget::ImageXy { x, y, screenshot_id }) => (None, Some(self.map_app_image_coords_to_pointer_f64(pid, x, y, screenshot_id.as_deref())?)),
                Some(ClickTarget::ScreenXy { x, y }) => (None, Some((x,y))),
                None => (None, None),
                _ => return Err(OpenBitFunError::tool("[BACKGROUND_TEXT_UNAVAILABLE] Windows text targeting requires an observed node, image pixel or bound native focus")),
            };
            let text = text.to_owned();
            crate::computer_use::control_session::spawn_blocking(move || match index {
                Some(idx) => {
                    crate::computer_use::windows_ax_ui::insert_cached_text(hwnd_raw, idx, &text)
                }
                None => crate::computer_use::windows_ax_ui::insert_text_at_bound_target(
                    hwnd_raw, point, &text,
                ),
            })
            .await
            .map_err(|e| OpenBitFunError::tool(e.to_string()))??;
            Ok(())
        }
        #[cfg(target_os = "linux")]
        {
            let Some(ClickTarget::NodeIdx { idx }) = focus else {
                return Err(OpenBitFunError::tool("[BACKGROUND_TEXT_UNAVAILABLE] Linux background text insertion requires an explicit observed EditableText node; implicit system focus is not used."));
            };
            crate::computer_use::linux_control_ax::insert_text(&app, idx, text).await?;
            Ok(())
        }
    }

    /// Resolve an observed pointer target without pressing, focusing, or raising it.
    #[cfg(target_os = "macos")]
    async fn resolve_macos_pointer_target(
        &self,
        pid: i32,
        target: &ClickTarget,
        node_coordinates: Option<(f64, f64)>,
        image_coordinates: Option<(f64, f64)>,
    ) -> OpenBitFunResult<(f64, f64)> {
        Ok(match target {
            ClickTarget::ScreenXy { x, y } => (*x, *y),
            ClickTarget::ImageXy {
                x,
                y,
                screenshot_id,
            } => match image_coordinates {
                Some(point) => point,
                None => {
                    self.map_app_image_coords_to_pointer_f64(pid, *x, *y, screenshot_id.as_deref())?
                }
            },
            ClickTarget::ImageGrid { screenshot_id, .. } => {
                let (ix, iy) = Self::image_grid_target_to_xy(target)?.ok_or_else(|| {
                    OpenBitFunError::tool("invalid image_grid target".to_string())
                })?;
                self.map_app_image_coords_to_pointer_f64(pid, ix, iy, screenshot_id.as_deref())?
            }
            ClickTarget::VisualGrid {
                rows,
                cols,
                row,
                col,
                intersections,
                wait_ms_after_detection,
            } => {
                let shot = self.screenshot_for_app_pid(pid).await?;
                let (x0, y0, width, height) =
                    detect_regular_grid_rect_from_screenshot(&shot, *rows, *cols)?;
                let target = ClickTarget::ImageGrid {
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
                let (ix, iy) = Self::image_grid_target_to_xy(&target)?.ok_or_else(|| {
                    OpenBitFunError::tool("invalid detected visual_grid target".to_string())
                })?;
                if let Some(wait) = wait_ms_after_detection {
                    if *wait > 0 {
                        tokio::time::sleep(Duration::from_millis(*wait as u64)).await;
                    }
                }
                self.map_app_image_coords_to_pointer_f64(
                    pid,
                    ix,
                    iy,
                    shot.screenshot_id.as_deref(),
                )?
            }
            ClickTarget::NodeIdx { idx } => match node_coordinates {
                Some(point) => point,
                None => {
                    let idx = *idx;
                    crate::computer_use::control_session::spawn_blocking(move || {
                        macos::catch_objc_local(|| resolve_macos_node_click(pid, idx, false))
                    })
                    .await
                    .map_err(|error| OpenBitFunError::tool(error.to_string()))??
                    .ok_or_else(|| {
                        OpenBitFunError::tool("AX_NODE_STALE: target has no observed coordinates")
                    })?
                }
            },
            ClickTarget::OcrText { needle } => {
                // Codex parity: when the AX tree doesn't expose the
                // target widget (Canvas, WebGL, custom-drawn cell),
                // fall back to OCR-on-screenshot. We screenshot the
                // bound target window so covering applications cannot
                // contribute OCR matches or change the click target.
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
                (m.center_x, m.center_y)
            }
        })
    }

    pub(super) async fn app_scroll_impl(
        &self,
        app: AppSelector,
        focus: Option<ClickTarget>,
        dx: i32,
        dy: i32,
    ) -> OpenBitFunResult<AppStateSnapshot> {
        self.dispatch_app_scroll_impl(app.clone(), focus, dx, dy)
            .await?;
        self.observe_after_app_input(app).await
    }

    async fn dispatch_app_scroll_native(
        &self,
        app: AppSelector,
        focus: Option<ClickTarget>,
        dx: i32,
        dy: i32,
    ) -> OpenBitFunResult<()> {
        #[cfg(target_os = "macos")]
        {
            let pid = resolve_pid_macos(self, &app).await?;
            if let Some(target) = focus {
                let (x, y) = self
                    .resolve_macos_pointer_target(pid, &target, None, None)
                    .await?;
                let window = crate::computer_use::macos_capture::bound_window_id(pid)
                    .map_err(OpenBitFunError::tool)?;
                let [wx, wy, width, height] =
                    crate::computer_use::macos_capture::window_bounds(pid, window)
                        .map_err(OpenBitFunError::tool)?;
                if !x.is_finite()
                    || !y.is_finite()
                    || x < wx
                    || y < wy
                    || x >= wx + width
                    || y >= wy + height
                {
                    return Err(OpenBitFunError::tool("TARGET_COORDINATES_OUTSIDE_WINDOW: Scroll anchor is outside the bound window"));
                }
                // Scrolling at a point never implies pressing the control there.
                crate::computer_use::control_session::record_pointer(x, y, false);
            }
            require_macos_background_input()?;
            crate::computer_use::control_session::spawn_blocking(move || {
                macos::catch_objc(|| crate::computer_use::macos_bg_input::bg_scroll(pid, dx, dy))
            })
            .await
            .map_err(|e| OpenBitFunError::tool(e.to_string()))??;
            Ok(())
        }
        #[cfg(target_os = "windows")]
        {
            let Some(ClickTarget::NodeIdx { idx }) = focus else {
                return Err(OpenBitFunError::tool("[FOREGROUND_REQUIRED] Background scrolling requires an explicitly observed scrollable node"));
            };
            let (_, hwnd_raw) = self.windows_target(&app).await?;
            crate::computer_use::control_session::spawn_blocking(move || {
                crate::computer_use::windows_ax_ui::scroll_cached_node(hwnd_raw, idx, dx, dy)
            })
            .await
            .map_err(|e| OpenBitFunError::tool(e.to_string()))??;
            Ok(())
        }
        #[cfg(not(any(target_os = "macos", target_os = "windows")))]
        {
            let _ = (app, focus, dx, dy);
            Err(OpenBitFunError::tool(
                LINUX_LEGACY_AX_UNAVAILABLE.to_string(),
            ))
        }
    }

    #[cfg(target_os = "windows")]
    pub(super) async fn app_key_chord_impl(
        &self,
        app: AppSelector,
        keys: Vec<String>,
        focus_idx: Option<u32>,
    ) -> OpenBitFunResult<AppStateSnapshot> {
        self.dispatch_app_key_chord_impl(app.clone(), keys, focus_idx)
            .await?;
        self.observe_after_app_input(app).await
    }

    async fn dispatch_app_key_chord_native(
        &self,
        app: AppSelector,
        keys: Vec<String>,
        focus_idx: Option<u32>,
    ) -> OpenBitFunResult<()> {
        #[cfg(target_os = "macos")]
        {
            let pid = resolve_pid_macos(self, &app).await?;
            if let Some(idx) = focus_idx {
                if !self
                    .try_focus_macos_text_target(pid, &ClickTarget::NodeIdx { idx })
                    .await?
                {
                    let click = AppClickParams {
                        app: app.clone(),
                        target: ClickTarget::NodeIdx { idx },
                        click_count: 1,
                        mouse_button: "left".to_string(),
                        modifier_keys: vec![],
                        wait_ms_after: None,
                    };
                    // The outer chord action already witnesses this focus click.
                    self.dispatch_app_click_native(click).await?;
                }
            }
            require_macos_background_input()?;
            crate::computer_use::control_session::spawn_blocking(
                move || -> OpenBitFunResult<()> {
                    macos::catch_objc(|| {
                        let (mods, kc) =
                            crate::computer_use::macos_bg_input::parse_key_sequence(&keys)?;
                        crate::computer_use::macos_bg_input::bg_key_chord(pid, &mods, kc)?;
                        Ok(())
                    })
                },
            )
            .await
            .map_err(|e| OpenBitFunError::tool(e.to_string()))??;
            Ok(())
        }
        #[cfg(target_os = "windows")]
        {
            let _ = (app, keys, focus_idx);
            Err(OpenBitFunError::tool("[FOREGROUND_REQUIRED] Windows keyboard chords require an explicitly authorized foreground input action; no focus click was sent"))
        }
        #[cfg(not(any(target_os = "macos", target_os = "windows")))]
        {
            let _ = (app, keys, focus_idx);
            Err(OpenBitFunError::tool(
                LINUX_LEGACY_AX_UNAVAILABLE.to_string(),
            ))
        }
    }

    pub(super) async fn app_wait_for_impl(
        &self,
        app: AppSelector,
        pred: AppWaitPredicate,
        timeout_ms: u32,
        poll_ms: u32,
    ) -> OpenBitFunResult<AppStateSnapshot> {
        #[cfg(any(target_os = "macos", target_os = "windows"))]
        {
            let deadline = Instant::now() + Duration::from_millis(timeout_ms as u64);
            let poll = Duration::from_millis(poll_ms.max(50) as u64);
            loop {
                // The caller's previous digest is the comparison baseline.
                // Taking a new baseline here would miss a change that already
                // completed between the mutation and this wait call.
                let mut snap = self
                    .get_app_state_inner(app.clone(), 32, false, false)
                    .await?;
                if app_wait_observation_ready(&snap, &pred, Instant::now() >= deadline, timeout_ms)?
                {
                    // Capture only the identity that satisfied the predicate.
                    // A failed window capture must never expose desktop pixels
                    // or return success without the expected final observation.
                    let pid = snap.app.pid.ok_or_else(|| {
                        OpenBitFunError::tool(
                            "[WAIT_TARGET_UNAVAILABLE] Matched application has no process identity",
                        )
                    })?;
                    #[cfg(target_os = "macos")]
                    let capture = self.screenshot_for_app_pid(pid).await;
                    #[cfg(target_os = "windows")]
                    let capture = {
                        let target = AppSelector {
                            pid: Some(pid),
                            ..Default::default()
                        };
                        let (_, hwnd) = self.windows_target(&target).await?;
                        self.screenshot_for_foreground_window(pid, hwnd).await
                    };
                    snap.screenshot = Some(capture.map_err(|error| OpenBitFunError::tool(format!(
                        "[WAIT_OBSERVATION_UNAVAILABLE] Predicate matched; target capture failed: {error}. Last observed digest: {}. Do not repeat the preceding mutation based on this capture failure.", snap.digest,
                    )))?);
                    return Ok(snap);
                }
                tokio::time::sleep(poll.min(deadline.saturating_duration_since(Instant::now())))
                    .await;
            }
        }
        #[cfg(not(any(target_os = "macos", target_os = "windows")))]
        {
            let _ = (app, pred, timeout_ms, poll_ms);
            Err(OpenBitFunError::tool(
                LINUX_LEGACY_AX_UNAVAILABLE.to_string(),
            ))
        }
    }

    pub(super) async fn build_interactive_view_impl(
        &self,
        app: AppSelector,
        opts: InteractiveViewOpts,
    ) -> OpenBitFunResult<InteractiveView> {
        #[cfg(any(target_os = "macos", target_os = "windows"))]
        {
            let pid = resolve_pid(self, &app).await?;
            let snap = self
                .get_app_state_inner(app.clone(), 64, opts.focus_window_only, true)
                .await?;
            let max_elements = opts
                .max_elements
                .map(|n| n as usize)
                .unwrap_or(80)
                .clamp(1, 200);
            let filter_opts = crate::computer_use::interactive_filter::FilterOpts {
                max_elements,
                clip_to_image_bounds: opts.focus_window_only,
            };
            let (elements, eligible_count) =
                crate::computer_use::interactive_filter::build_interactive_elements_with_count(
                    &snap.nodes,
                    snap.screenshot.as_ref(),
                    &filter_opts,
                );
            let omitted_element_count = eligible_count.saturating_sub(elements.len()) as u32;
            let mut tree_text = if opts.include_tree_text {
                crate::computer_use::interactive_filter::render_element_tree_text(&elements)
            } else {
                String::new()
            };
            if opts.include_tree_text && omitted_element_count > 0 {
                tree_text.push_str(&format!(
                    "Note: {} additional controls omitted by max_elements; request a larger view budget or use get_app_state/locate to inspect them.\n",
                    omitted_element_count
                ));
            }
            let digest = compute_interactive_view_digest(&elements);

            let mut screenshot_out: Option<ComputerScreenshot> = None;
            if opts.annotate_screenshot {
                if let Some(shot) = snap.screenshot.as_ref() {
                    match crate::computer_use::som_overlay::render_overlay(
                        &shot.bytes,
                        &elements,
                        Some(80),
                    ) {
                        Ok(jpeg) => {
                            let mut out = shot.clone();
                            out.bytes = jpeg;
                            out.mime_type = "image/jpeg".to_string();
                            screenshot_out = Some(out);
                        }
                        Err(e) => {
                            warn!(
                                target: "computer_use::interactive_view",
                                "som_overlay render failed (non-fatal): {}",
                                e
                            );
                            screenshot_out = Some(shot.clone());
                        }
                    }
                }
            } else {
                screenshot_out = snap.screenshot.clone();
            }

            let captured_at_ms = std::time::SystemTime::now()
                .duration_since(std::time::UNIX_EPOCH)
                .map(|d| d.as_millis() as u64)
                .unwrap_or_default();

            let view = InteractiveView {
                observation_id: snap.observation_id.clone(),
                app: snap.app.clone(),
                window_title: snap.window_title.clone(),
                elements: elements.clone(),
                omitted_element_count,
                tree_text,
                digest: digest.clone(),
                captured_at_ms,
                screenshot: screenshot_out,
                loop_warning: snap.loop_warning.clone(),
            };

            // Cache for subsequent `interactive_*` calls.
            {
                let mut s = self
                    .state
                    .lock()
                    .map_err(|e| OpenBitFunError::tool(format!("lock: {}", e)))?;
                s.interactive_view_cache.insert(
                    pid,
                    CachedInteractiveView {
                        digest: digest.clone(),
                        elements,
                    },
                );
            }
            Ok(view)
        }
        #[cfg(not(any(target_os = "macos", target_os = "windows")))]
        {
            let _ = (app, opts);
            Err(OpenBitFunError::tool(
                LINUX_LEGACY_AX_UNAVAILABLE.to_string(),
            ))
        }
    }

    pub(super) async fn interactive_click_impl(
        &self,
        app: AppSelector,
        params: InteractiveClickParams,
    ) -> OpenBitFunResult<InteractiveActionResult> {
        #[cfg(any(target_os = "macos", target_os = "windows"))]
        {
            // A rebuilt view can assign this index to a different control.
            // Preserve stale-view errors so the caller observes and chooses again.
            let node_idx = self
                .resolve_interactive_index(&app, params.i, params.before_view_digest.as_deref())
                .await?;

            // Look up the cached element's image-pixel center as a
            // pointer fallback. Always available when `frame_image` was
            // populated at view-build time; covers Electron / Canvas /
            // custom-drawn widgets that AXPress can't dispatch into.
            let pointer_fallback_image_xy: Option<(i32, i32)> =
                self.cached_interactive_image_center(&app, params.i).await;

            // Primary path: AX-targeted click via `app_click`. On
            // failure, fall back to a pointer click at the element's
            // image-pixel center if we have one.
            let click_res = self
                .app_click_impl(AppClickParams {
                    app: app.clone(),
                    target: ClickTarget::NodeIdx { idx: node_idx },
                    click_count: params.click_count.max(1),
                    mouse_button: params.mouse_button.clone(),
                    modifier_keys: params.modifier_keys.clone(),
                    wait_ms_after: params.wait_ms_after,
                })
                .await;

            let (snapshot, fallback_used) = match click_res {
                Ok(s) => (s, false),
                Err(e) if pointer_fallback_image_xy.is_some() => {
                    let (ix, iy) = pointer_fallback_image_xy.unwrap();
                    warn!(
                        target: "computer_use::interactive_view",
                        "interactive_click: AX path failed, falling back to image_xy=({},{}): {}",
                        ix, iy, e
                    );
                    let s = self
                        .app_click_impl(AppClickParams {
                            app: app.clone(),
                            target: ClickTarget::ImageXy {
                                x: ix,
                                y: iy,
                                screenshot_id: None,
                            },
                            click_count: params.click_count.max(1),
                            mouse_button: params.mouse_button.clone(),
                            modifier_keys: params.modifier_keys.clone(),
                            wait_ms_after: params.wait_ms_after,
                        })
                        .await?;
                    (s, true)
                }
                Err(e) => return Err(e),
            };

            let view = if params.return_view {
                Some(
                    self.build_interactive_view(app, InteractiveViewOpts::default())
                        .await?,
                )
            } else {
                None
            };
            let mut note = format!("index_resolved_via_node_idx({})", node_idx);
            if fallback_used {
                note.push_str(",fallback_image_xy");
            }
            Ok(InteractiveActionResult {
                snapshot,
                view,
                execution_note: Some(note),
            })
        }
        #[cfg(not(any(target_os = "macos", target_os = "windows")))]
        {
            let _ = (app, params);
            Err(OpenBitFunError::tool(
                LINUX_LEGACY_AX_UNAVAILABLE.to_string(),
            ))
        }
    }

    pub(super) async fn build_visual_mark_view_impl(
        &self,
        app: AppSelector,
        opts: VisualMarkViewOpts,
    ) -> OpenBitFunResult<VisualMarkView> {
        #[cfg(any(target_os = "macos", target_os = "windows"))]
        {
            let pid = resolve_pid(self, &app).await?;
            let mut snap = self
                .get_app_state_inner(app.clone(), 16, true, true)
                .await?;
            if snap.screenshot.is_none() {
                #[cfg(target_os = "macos")]
                {
                    if let Ok(shot) = self.screenshot_for_app_pid(pid).await {
                        snap.screenshot = Some(shot);
                    }
                }
                #[cfg(target_os = "windows")]
                {
                    let (_, hwnd_raw) = self.windows_target(&app).await?;
                    if hwnd_raw != 0 {
                        if let Ok(shot) = self.screenshot_for_foreground_window(pid, hwnd_raw).await
                        {
                            snap.screenshot = Some(shot);
                        }
                    }
                }
            }
            let shot = snap.screenshot.as_ref().ok_or_else(|| {
                OpenBitFunError::tool(
                    "build_visual_mark_view: app screenshot unavailable; grant Screen Recording permission and retry".to_string(),
                )
            })?;

            let marks = build_regular_visual_marks(shot, &opts)?;
            let digest = compute_visual_mark_view_digest(&marks, shot.screenshot_id.as_deref());

            let mut screenshot_out: Option<ComputerScreenshot> = Some(shot.clone());
            if opts.include_grid && !marks.is_empty() {
                let overlay_elements = visual_marks_to_overlay_elements(&marks);
                match crate::computer_use::som_overlay::render_overlay(
                    &shot.bytes,
                    &overlay_elements,
                    Some(82),
                ) {
                    Ok(jpeg) => {
                        let mut out = shot.clone();
                        out.bytes = jpeg;
                        out.mime_type = "image/jpeg".to_string();
                        screenshot_out = Some(out);
                    }
                    Err(e) => {
                        warn!(
                            target: "computer_use::visual_mark_view",
                            "visual mark overlay render failed (non-fatal): {}",
                            e
                        );
                    }
                }
            }

            let captured_at_ms = std::time::SystemTime::now()
                .duration_since(std::time::UNIX_EPOCH)
                .map(|d| d.as_millis() as u64)
                .unwrap_or_default();
            let view = VisualMarkView {
                observation_id: snap.observation_id.clone(),
                app: snap.app.clone(),
                window_title: snap.window_title.clone(),
                marks: marks.clone(),
                digest: digest.clone(),
                captured_at_ms,
                screenshot: screenshot_out,
            };
            {
                let mut s = self
                    .state
                    .lock()
                    .map_err(|e| OpenBitFunError::tool(format!("lock: {}", e)))?;
                s.visual_mark_cache.insert(
                    pid,
                    CachedVisualMarkView {
                        digest,
                        marks,
                        screenshot_id: shot.screenshot_id.clone(),
                    },
                );
            }
            Ok(view)
        }
        #[cfg(not(any(target_os = "macos", target_os = "windows")))]
        {
            let _ = (app, opts);
            Err(OpenBitFunError::tool(
                LINUX_LEGACY_AX_UNAVAILABLE.to_string(),
            ))
        }
    }

    pub(super) async fn visual_click_impl(
        &self,
        app: AppSelector,
        params: VisualClickParams,
    ) -> OpenBitFunResult<VisualActionResult> {
        #[cfg(any(target_os = "macos", target_os = "windows"))]
        {
            // Visual indices are also tied to the view the caller actually saw.
            let mark = self
                .resolve_visual_mark(&app, params.i, params.before_view_digest.as_deref())
                .await?;

            let screenshot_id = {
                let pid = resolve_pid(self, &app).await?;
                let s = self
                    .state
                    .lock()
                    .map_err(|e| OpenBitFunError::tool(format!("lock: {}", e)))?;
                s.visual_mark_cache
                    .get(&pid)
                    .and_then(|cached| cached.screenshot_id.clone())
            };

            let snapshot = self
                .app_click_impl(AppClickParams {
                    app: app.clone(),
                    target: ClickTarget::ImageXy {
                        x: mark.x,
                        y: mark.y,
                        screenshot_id,
                    },
                    click_count: params.click_count.max(1),
                    mouse_button: params.mouse_button.clone(),
                    modifier_keys: params.modifier_keys.clone(),
                    wait_ms_after: params.wait_ms_after,
                })
                .await?;

            let view = if params.return_view {
                Some(
                    self.build_visual_mark_view(app, VisualMarkViewOpts::default())
                        .await?,
                )
            } else {
                None
            };
            let note = format!("visual_mark_image_xy({},{})", mark.x, mark.y);
            Ok(VisualActionResult {
                snapshot,
                view,
                execution_note: Some(note),
            })
        }
        #[cfg(not(any(target_os = "macos", target_os = "windows")))]
        {
            let _ = (app, params);
            Err(OpenBitFunError::tool(
                LINUX_LEGACY_AX_UNAVAILABLE.to_string(),
            ))
        }
    }

    pub(super) async fn interactive_type_text_impl(
        &self,
        app: AppSelector,
        params: InteractiveTypeTextParams,
    ) -> OpenBitFunResult<InteractiveActionResult> {
        #[cfg(any(target_os = "macos", target_os = "windows"))]
        {
            let focus = if let Some(i) = params.i {
                let node_idx = self
                    .resolve_interactive_index(&app, i, params.before_view_digest.as_deref())
                    .await?;
                Some(ClickTarget::NodeIdx { idx: node_idx })
            } else {
                None
            };

            if params.clear_first {
                if let Some(target) = focus.clone() {
                    let _ = self
                        .app_click_impl(AppClickParams {
                            app: app.clone(),
                            target,
                            click_count: 1,
                            mouse_button: "left".to_string(),
                            modifier_keys: vec![],
                            wait_ms_after: Some(60),
                        })
                        .await?;
                }
                // Select-all + delete to clear the field. The "select all"
                // accelerator is Cmd+A on macOS and Ctrl+A on Windows.
                #[cfg(target_os = "macos")]
                {
                    let pid = resolve_pid_macos(self, &app).await?;
                    crate::computer_use::control_session::spawn_blocking(
                        move || -> OpenBitFunResult<()> {
                            macos::catch_objc(|| {
                                let (m1, k1) =
                                    crate::computer_use::macos_bg_input::parse_key_sequence(&[
                                        "cmd".to_string(),
                                        "a".to_string(),
                                    ])?;
                                crate::computer_use::macos_bg_input::bg_key_chord(pid, &m1, k1)?;
                                let (m2, k2) =
                                    crate::computer_use::macos_bg_input::parse_key_sequence(&[
                                        "delete".to_string(),
                                    ])?;
                                crate::computer_use::macos_bg_input::bg_key_chord(pid, &m2, k2)?;
                                Ok(())
                            })
                        },
                    )
                    .await
                    .map_err(|e| OpenBitFunError::tool(e.to_string()))??;
                }
                #[cfg(target_os = "windows")]
                {
                    let _ = self
                        .app_key_chord_impl(
                            app.clone(),
                            vec!["ctrl".to_string(), "a".to_string()],
                            None,
                        )
                        .await?;
                    let _ = self
                        .app_key_chord_impl(app.clone(), vec!["delete".to_string()], None)
                        .await?;
                }
            }

            let snapshot = self
                .app_type_text_impl(app.clone(), &params.text, focus)
                .await?;

            if params.press_enter_after {
                #[cfg(target_os = "macos")]
                {
                    let pid = resolve_pid_macos(self, &app).await?;
                    crate::computer_use::control_session::spawn_blocking(
                        move || -> OpenBitFunResult<()> {
                            macos::catch_objc(|| {
                                let (m, k) =
                                    crate::computer_use::macos_bg_input::parse_key_sequence(&[
                                        "return".to_string(),
                                    ])?;
                                crate::computer_use::macos_bg_input::bg_key_chord(pid, &m, k)?;
                                Ok(())
                            })
                        },
                    )
                    .await
                    .map_err(|e| OpenBitFunError::tool(e.to_string()))??;
                }
                #[cfg(target_os = "windows")]
                {
                    let _ = self
                        .app_key_chord_impl(app.clone(), vec!["return".to_string()], None)
                        .await?;
                }
            }

            if let Some(wait) = params.wait_ms_after {
                tokio::time::sleep(Duration::from_millis(wait.min(5_000) as u64)).await;
            }

            let view = if params.return_view {
                Some(
                    self.build_interactive_view(app, InteractiveViewOpts::default())
                        .await?,
                )
            } else {
                None
            };
            Ok(InteractiveActionResult {
                snapshot,
                view,
                execution_note: Some("ax_focus_then_bg_type_text".to_string()),
            })
        }
        #[cfg(not(any(target_os = "macos", target_os = "windows")))]
        {
            let _ = (app, params);
            Err(OpenBitFunError::tool(
                LINUX_LEGACY_AX_UNAVAILABLE.to_string(),
            ))
        }
    }

    pub(super) async fn interactive_scroll_impl(
        &self,
        app: AppSelector,
        params: InteractiveScrollParams,
    ) -> OpenBitFunResult<InteractiveActionResult> {
        #[cfg(any(target_os = "macos", target_os = "windows"))]
        {
            let focus = if let Some(i) = params.i {
                let node_idx = self
                    .resolve_interactive_index(&app, i, params.before_view_digest.as_deref())
                    .await?;
                Some(ClickTarget::NodeIdx { idx: node_idx })
            } else {
                None
            };
            let snapshot = self
                .app_scroll_impl(app.clone(), focus, params.dx, params.dy)
                .await?;
            if let Some(wait) = params.wait_ms_after {
                tokio::time::sleep(Duration::from_millis(wait.min(5_000) as u64)).await;
            }
            let view = if params.return_view {
                Some(
                    self.build_interactive_view(app, InteractiveViewOpts::default())
                        .await?,
                )
            } else {
                None
            };
            Ok(InteractiveActionResult {
                snapshot,
                view,
                execution_note: Some("app_scroll".to_string()),
            })
        }
        #[cfg(not(any(target_os = "macos", target_os = "windows")))]
        {
            let _ = (app, params);
            Err(OpenBitFunError::tool(
                LINUX_LEGACY_AX_UNAVAILABLE.to_string(),
            ))
        }
    }
}

/// Evaluate the current observation against the caller's predicate before
/// considering the deadline: an already satisfied condition needs no polling.
#[cfg(any(test, target_os = "macos", target_os = "windows"))]
fn app_wait_observation_ready(
    snap: &AppStateSnapshot,
    pred: &AppWaitPredicate,
    deadline_reached: bool,
    timeout_ms: u32,
) -> OpenBitFunResult<bool> {
    let matched = match pred {
        AppWaitPredicate::DigestChanged { prev_digest } => snap.digest != *prev_digest,
        AppWaitPredicate::TitleContains { needle } => {
            snap.window_title
                .as_deref()
                .is_some_and(|title| title.contains(needle))
                || snap.nodes.iter().any(|node| {
                    node.title
                        .as_deref()
                        .is_some_and(|title| title.contains(needle))
                })
        }
        AppWaitPredicate::RoleEnabled { role } => snap
            .nodes
            .iter()
            .any(|node| node.role == *role && node.enabled),
        AppWaitPredicate::NodeEnabled { idx } => snap
            .nodes
            .iter()
            .any(|node| node.idx == *idx && node.enabled),
    };
    if matched {
        return Ok(true);
    }
    if deadline_reached {
        return Err(OpenBitFunError::tool(format!(
            "[WAIT_TIMEOUT] Predicate {pred:?} was not satisfied within {timeout_ms} ms. Last observed digest: {}. Re-observe the target; timeout does not prove the preceding mutation failed.", snap.digest,
        )));
    }
    Ok(false)
}

#[cfg(test)]
mod app_wait_tests {
    use super::*;

    fn snapshot(digest: &str) -> AppStateSnapshot {
        serde_json::from_value(serde_json::json!({
            "app":{"name":"Fixture","pid":421,"running":true},
            "tree_text":"", "digest":digest, "captured_at_ms":1
        }))
        .unwrap()
    }

    #[test]
    fn app_wait_already_changed_succeeds_on_first_observation() {
        let pred = AppWaitPredicate::DigestChanged {
            prev_digest: "before".into(),
        };
        assert!(app_wait_observation_ready(&snapshot("after"), &pred, false, 1000).unwrap());
        assert!(app_wait_observation_ready(&snapshot("after"), &pred, true, 0).unwrap());
    }

    #[test]
    fn app_wait_unsatisfied_deadline_is_an_error_with_last_digest() {
        let pred = AppWaitPredicate::DigestChanged {
            prev_digest: "unchanged".into(),
        };
        assert!(!app_wait_observation_ready(&snapshot("unchanged"), &pred, false, 1000).unwrap());
        let error = app_wait_observation_ready(&snapshot("unchanged"), &pred, true, 1000)
            .unwrap_err()
            .to_string();
        assert!(error.contains("WAIT_TIMEOUT"));
        assert!(error.contains("Last observed digest: unchanged"));
    }

    #[test]
    fn app_wait_missing_requested_node_does_not_match() {
        let pred = AppWaitPredicate::NodeEnabled { idx: 3 };
        assert!(!app_wait_observation_ready(&snapshot("state"), &pred, false, 1000).unwrap());
    }
}

/// Stable lowercase-hex SHA1 over a *layout-only* canonical payload:
/// `i|node_idx|role|subrole|x_bucket,y_bucket,w_bucket,h_bucket`.
///
/// Deliberately omits `label` (textfield value, focused selection, live
/// counters etc. would otherwise turn every keystroke into a STALE error)
/// and snaps coordinates to an 8-pt grid so a 1-pixel re-layout from a
/// scrollbar appearing / IME bar resizing doesn't invalidate the cached
/// view either. The digest is meant to detect *structural* changes
/// (elements appeared, disappeared, or moved noticeably), not cosmetic
/// noise.
#[cfg(any(target_os = "macos", target_os = "windows"))]
fn compute_interactive_view_digest(
    elements: &[openbitfun_agent_tools::computer_use_host::InteractiveElement],
) -> String {
    use sha1::{Digest, Sha1};
    const BUCKET: f64 = 8.0;
    let mut hasher = Sha1::new();
    for e in elements {
        let subrole = e.subrole.as_deref().unwrap_or("");
        let (x, y, w, h) = e.frame_global.unwrap_or((0.0, 0.0, 0.0, 0.0));
        let xb = (x / BUCKET).floor() as i64;
        let yb = (y / BUCKET).floor() as i64;
        let wb = (w / BUCKET).round().max(1.0) as i64;
        let hb = (h / BUCKET).round().max(1.0) as i64;
        let line = format!(
            "{}|{}|{}|{}|{},{},{},{}\n",
            e.i, e.node_idx, e.role, subrole, xb, yb, wb, hb,
        );
        hasher.update(line.as_bytes());
    }
    let bytes = hasher.finalize();
    let mut out = String::with_capacity(bytes.len() * 2);
    for b in bytes.iter() {
        out.push_str(&format!("{:02x}", b));
    }
    out
}

#[cfg(any(target_os = "macos", target_os = "windows"))]
fn compute_visual_mark_view_digest(marks: &[VisualMark], screenshot_id: Option<&str>) -> String {
    use sha1::{Digest, Sha1};
    let mut hasher = Sha1::new();
    hasher.update(screenshot_id.unwrap_or("").as_bytes());
    hasher.update(b"\n");
    for mark in marks {
        let frame = mark.frame_image.unwrap_or((0, 0, 0, 0));
        let line = format!(
            "{}|{}|{}|{},{},{},{}\n",
            mark.i, mark.x, mark.y, frame.0, frame.1, frame.2, frame.3
        );
        hasher.update(line.as_bytes());
    }
    let bytes = hasher.finalize();
    let mut out = String::with_capacity(bytes.len() * 2);
    for b in bytes.iter() {
        out.push_str(&format!("{:02x}", b));
    }
    out
}

#[cfg(any(target_os = "macos", target_os = "windows"))]
fn build_regular_visual_marks(
    shot: &ComputerScreenshot,
    opts: &VisualMarkViewOpts,
) -> OpenBitFunResult<Vec<VisualMark>> {
    if !opts.include_grid {
        return Ok(Vec::new());
    }

    let image_w = shot.image_width.max(1);
    let image_h = shot.image_height.max(1);
    let (mut x0, mut y0, mut width, mut height) = if let Some(region) = opts.region.as_ref() {
        (region.x0, region.y0, region.width, region.height)
    } else if let Some(rect) = shot.image_content_rect.as_ref() {
        (rect.left, rect.top, rect.width, rect.height)
    } else {
        (0, 0, image_w, image_h)
    };

    x0 = x0.min(image_w.saturating_sub(1));
    y0 = y0.min(image_h.saturating_sub(1));
    width = width.min(image_w.saturating_sub(x0)).max(1);
    height = height.min(image_h.saturating_sub(y0)).max(1);

    let max_points = opts.max_points.unwrap_or(64).clamp(4, 196);
    let aspect = (width as f64 / height.max(1) as f64).clamp(0.25, 4.0);
    let mut cols = ((max_points as f64 * aspect).sqrt().ceil() as u32).clamp(2, max_points);
    let mut rows = ((max_points as f64) / cols as f64).ceil() as u32;
    rows = rows.max(2);
    while rows.saturating_mul(cols) > max_points && rows > 2 {
        rows -= 1;
    }
    while rows.saturating_mul(cols) > max_points && cols > 2 {
        cols -= 1;
    }

    let mut marks = Vec::with_capacity(rows.saturating_mul(cols) as usize);
    for row in 0..rows {
        for col in 0..cols {
            if marks.len() >= max_points as usize {
                break;
            }
            let x = x0 as f64 + ((col as f64 + 0.5) * width as f64 / cols as f64);
            let y = y0 as f64 + ((row as f64 + 0.5) * height as f64 / rows as f64);
            let x = x.round().clamp(0.0, image_w.saturating_sub(1) as f64) as i32;
            let y = y.round().clamp(0.0, image_h.saturating_sub(1) as f64) as i32;
            let box_size_i32 = if width.min(height) < 180 { 18 } else { 24 };
            let half = box_size_i32 / 2;
            let fx = (x - half).max(0) as u32;
            let fy = (y - half).max(0) as u32;
            let box_size = box_size_i32 as u32;
            let fw = box_size.min(image_w.saturating_sub(fx)).max(1);
            let fh = box_size.min(image_h.saturating_sub(fy)).max(1);
            marks.push(VisualMark {
                i: marks.len() as u32,
                x,
                y,
                frame_image: Some((fx, fy, fw, fh)),
                label: None,
            });
        }
    }

    if marks.is_empty() {
        return Err(OpenBitFunError::tool(
            "build_visual_mark_view: no visual marks generated for the requested region"
                .to_string(),
        ));
    }
    Ok(marks)
}

#[cfg(any(target_os = "macos", target_os = "windows"))]
fn visual_marks_to_overlay_elements(
    marks: &[VisualMark],
) -> Vec<openbitfun_agent_tools::computer_use_host::InteractiveElement> {
    marks
        .iter()
        .map(
            |mark| openbitfun_agent_tools::computer_use_host::InteractiveElement {
                i: mark.i,
                node_idx: mark.i,
                role: "VisualMark".to_string(),
                subrole: None,
                label: mark.label.clone(),
                frame_image: mark.frame_image,
                frame_global: None,
                enabled: true,
                focused: false,
                ax_actionable: false,
            },
        )
        .collect()
}

#[cfg(any(test, target_os = "macos", target_os = "windows"))]
pub(super) fn detect_regular_grid_rect_from_screenshot(
    shot: &ComputerScreenshot,
    rows: u32,
    cols: u32,
) -> OpenBitFunResult<(i32, i32, u32, u32)> {
    if rows < 2 || cols < 2 {
        return Err(OpenBitFunError::tool(
            "visual_grid requires rows and cols >= 2".to_string(),
        ));
    }

    let img = image::load_from_memory(&shot.bytes)
        .map_err(|e| OpenBitFunError::tool(format!("visual_grid: decode screenshot failed: {e}")))?
        .to_rgb8();
    let (image_w, image_h) = img.dimensions();
    let (left, top, width, height) = shot
        .image_content_rect
        .as_ref()
        .map(|r| (r.left, r.top, r.width, r.height))
        .unwrap_or((0, 0, image_w, image_h));
    let right = left.saturating_add(width).min(image_w);
    let bottom = top.saturating_add(height).min(image_h);
    if right <= left + 8 || bottom <= top + 8 {
        return Err(OpenBitFunError::tool(
            "visual_grid: screenshot content rect is too small".to_string(),
        ));
    }

    let vertical = projection_darkness(&img, left, top, right, bottom, true);
    let horizontal = projection_darkness(&img, left, top, right, bottom, false);
    let x_seq = detect_regular_line_sequence(&vertical, cols, left)?;
    let y_seq = detect_regular_line_sequence(&horizontal, rows, top)?;
    let x0 = *x_seq.first().unwrap_or(&left);
    let x1 = *x_seq.last().unwrap_or(&right.saturating_sub(1));
    let y0 = *y_seq.first().unwrap_or(&top);
    let y1 = *y_seq.last().unwrap_or(&bottom.saturating_sub(1));
    let w = x1.saturating_sub(x0).saturating_add(1).max(2);
    let h = y1.saturating_sub(y0).saturating_add(1).max(2);

    let aspect = w as f64 / h.max(1) as f64;
    if !(0.5..=2.0).contains(&aspect) {
        return Err(OpenBitFunError::tool(format!(
            "visual_grid: detected grid is implausibly non-square (x0={}, y0={}, width={}, height={}, aspect={:.2}); pass image_grid with an explicit rectangle",
            x0, y0, w, h, aspect
        )));
    }

    Ok((x0 as i32, y0 as i32, w, h))
}

#[cfg(any(test, target_os = "macos", target_os = "windows"))]
fn projection_darkness(
    img: &image::RgbImage,
    left: u32,
    top: u32,
    right: u32,
    bottom: u32,
    vertical: bool,
) -> Vec<f64> {
    let len = (if vertical { right - left } else { bottom - top }) as usize;
    let mut out = vec![0.0; len];
    if vertical {
        for x in left..right {
            let mut sum = 0.0;
            for y in top..bottom {
                let p = img.get_pixel(x, y).0;
                let gray = 0.299 * p[0] as f64 + 0.587 * p[1] as f64 + 0.114 * p[2] as f64;
                sum += (255.0 - gray).max(0.0);
            }
            out[(x - left) as usize] = sum / (bottom - top).max(1) as f64;
        }
    } else {
        for y in top..bottom {
            let mut sum = 0.0;
            for x in left..right {
                let p = img.get_pixel(x, y).0;
                let gray = 0.299 * p[0] as f64 + 0.587 * p[1] as f64 + 0.114 * p[2] as f64;
                sum += (255.0 - gray).max(0.0);
            }
            out[(y - top) as usize] = sum / (right - left).max(1) as f64;
        }
    }
    smooth_projection(&out, 2)
}

#[cfg(any(test, target_os = "macos", target_os = "windows"))]
fn smooth_projection(values: &[f64], radius: usize) -> Vec<f64> {
    if values.is_empty() {
        return Vec::new();
    }
    let mut out = Vec::with_capacity(values.len());
    for i in 0..values.len() {
        let start = i.saturating_sub(radius);
        let end = (i + radius + 1).min(values.len());
        let sum: f64 = values[start..end].iter().sum();
        out.push(sum / (end - start).max(1) as f64);
    }
    out
}

#[cfg(any(test, target_os = "macos", target_os = "windows"))]
fn detect_regular_line_sequence(
    projection: &[f64],
    count: u32,
    offset: u32,
) -> OpenBitFunResult<Vec<u32>> {
    if projection.len() < count as usize {
        return Err(OpenBitFunError::tool(
            "visual_grid: projection is smaller than requested grid count".to_string(),
        ));
    }
    let mut sorted = projection.to_vec();
    sorted.sort_by(|a, b| a.partial_cmp(b).unwrap_or(std::cmp::Ordering::Equal));
    let baseline = sorted[sorted.len() / 2];
    let adjusted: Vec<f64> = projection
        .iter()
        .map(|v| (*v - baseline).max(0.0))
        .collect();
    let mut adjusted_sorted = adjusted.clone();
    adjusted_sorted.sort_by(|a, b| a.partial_cmp(b).unwrap_or(std::cmp::Ordering::Equal));
    let threshold = adjusted_sorted
        [(adjusted_sorted.len() * 95 / 100).min(adjusted_sorted.len().saturating_sub(1))]
    .max(1.0);
    let mut peaks: Vec<usize> = Vec::new();
    let min_gap = ((projection.len() as f64 / count.max(1) as f64) * 0.35).round() as usize;
    let mut i = 0usize;
    while i < projection.len() {
        if adjusted[i] < threshold {
            i += 1;
            continue;
        }
        let start = i;
        let mut best = i;
        let mut best_score = adjusted[i];
        while i < adjusted.len() && adjusted[i] >= threshold {
            if adjusted[i] > best_score {
                best = i;
                best_score = adjusted[i];
            }
            i += 1;
        }
        let end = i.saturating_sub(1);
        let center = if best_score <= threshold {
            (start + end) / 2
        } else {
            best
        };
        if let Some(last) = peaks.last_mut() {
            if center.saturating_sub(*last) < min_gap.max(2) {
                if adjusted[center] > adjusted[*last] {
                    *last = center;
                }
                continue;
            }
        }
        peaks.push(center);
    }
    if peaks.len() < 2 {
        if let Some(fallback) = top_regular_positions(&adjusted, count, offset, min_gap.max(2)) {
            return Ok(fallback);
        }
        return Err(OpenBitFunError::tool(
            "visual_grid: could not find enough line peaks".to_string(),
        ));
    }

    let mut best: Option<(f64, Vec<u32>)> = None;
    let desired = count as usize;
    for a_idx in 0..peaks.len() {
        for b_idx in (a_idx + 1)..peaks.len() {
            let first = peaks[a_idx] as f64;
            let last = peaks[b_idx] as f64;
            let span = last - first;
            if span < desired.saturating_sub(1).max(1) as f64 * 4.0 {
                continue;
            }
            let step = span / desired.saturating_sub(1).max(1) as f64;
            let tolerance = (step * 0.18).max(3.0);
            let mut positions = Vec::with_capacity(desired);
            let mut score = 0.0;
            let mut matched = 0usize;
            for k in 0..desired {
                let expected = first + k as f64 * step;
                let nearest = peaks
                    .iter()
                    .min_by(|a, b| {
                        ((**a as f64 - expected).abs())
                            .partial_cmp(&((**b as f64 - expected).abs()))
                            .unwrap_or(std::cmp::Ordering::Equal)
                    })
                    .copied();
                let pos = if let Some(p) = nearest {
                    if (p as f64 - expected).abs() <= tolerance {
                        matched += 1;
                        p as f64
                    } else {
                        expected
                    }
                } else {
                    expected
                };
                let idx = pos
                    .round()
                    .clamp(0.0, projection.len().saturating_sub(1) as f64)
                    as usize;
                score += adjusted[idx];
                positions.push(offset + idx as u32);
            }
            if matched < (desired * 2 / 3).max(2) {
                continue;
            }
            score += matched as f64 * threshold;
            score += span * 0.02;
            if best.as_ref().map(|(s, _)| score > *s).unwrap_or(true) {
                best = Some((score, positions));
            }
        }
    }

    best.map(|(_, positions)| positions)
        .or_else(|| top_regular_positions(&adjusted, count, offset, min_gap.max(2)))
        .ok_or_else(|| {
            OpenBitFunError::tool(
                "visual_grid: no regular grid sequence detected; pass image_grid with an explicit rectangle or build_visual_mark_view to choose a point"
                    .to_string(),
            )
        })
}

#[cfg(any(test, target_os = "macos", target_os = "windows"))]
fn top_regular_positions(
    scores: &[f64],
    count: u32,
    offset: u32,
    min_gap: usize,
) -> Option<Vec<u32>> {
    let desired = count as usize;
    let mut ranked: Vec<usize> = (0..scores.len()).collect();
    ranked.sort_by(|a, b| {
        scores[*b]
            .partial_cmp(&scores[*a])
            .unwrap_or(std::cmp::Ordering::Equal)
    });
    let mut selected: Vec<usize> = Vec::with_capacity(desired);
    for idx in ranked {
        if scores[idx] <= 0.0 {
            break;
        }
        if selected.iter().any(|s| idx.abs_diff(*s) < min_gap.max(2)) {
            continue;
        }
        selected.push(idx);
        if selected.len() == desired {
            break;
        }
    }
    if selected.len() < desired {
        return None;
    }
    selected.sort_unstable();
    Some(
        selected
            .into_iter()
            .map(|idx| offset + idx as u32)
            .collect(),
    )
}

/// Returns `true` if the error reported by `resolve_interactive_index`
/// is the recoverable `STALE_INTERACTIVE_VIEW` variant. We match on the
/// error text rather than introducing a typed error enum because every
/// `OpenBitFunError::tool` is already string-based throughout the host
/// surface; adding a new variant would ripple through ~40 callers.
impl NativeComputerUseHost {
    /// Return the image-pixel center `(x, y)` of the cached interactive
    /// element with the given `i`, when its `frame_image` is known. Used
    /// as a pointer-click fallback in `interactive_click` when AXPress
    /// fails (Electron / Canvas / custom-drawn surfaces).
    #[cfg(any(target_os = "macos", target_os = "windows"))]
    async fn cached_interactive_image_center(
        &self,
        app: &AppSelector,
        i: u32,
    ) -> Option<(i32, i32)> {
        let pid = resolve_pid(self, app).await.ok()?;
        let s = self.state.lock().ok()?;
        let cached = s.interactive_view_cache.get(&pid)?;
        let el = cached.elements.iter().find(|e| e.i == i)?;
        let (ix, iy, iw, ih) = el.frame_image?;
        Some((
            (ix as i64 + (iw as i64) / 2) as i32,
            (iy as i64 + (ih as i64) / 2) as i32,
        ))
    }

    /// Resolve an `interactive_*` `i` index into the underlying AX `node_idx`
    /// using the per-pid cache populated by `build_interactive_view`. Returns
    /// a `STALE_INTERACTIVE_VIEW` tool error when the digest no longer matches
    /// (i.e. the UI changed between view + action) so the caller can re-build
    /// the interactive view before retrying.
    #[cfg(any(target_os = "macos", target_os = "windows"))]
    async fn resolve_interactive_index(
        &self,
        app: &AppSelector,
        i: u32,
        before_digest: Option<&str>,
    ) -> OpenBitFunResult<u32> {
        let pid = resolve_pid(self, app).await?;
        let s = self
            .state
            .lock()
            .map_err(|e| OpenBitFunError::tool(format!("lock: {}", e)))?;
        let cached = s.interactive_view_cache.get(&pid).ok_or_else(|| {
            OpenBitFunError::tool(
                "INTERACTIVE_VIEW_MISSING: call `build_interactive_view` before `interactive_*` actions"
                    .to_string(),
            )
        })?;
        if let Some(want) = before_digest {
            let want = want.trim();
            if !want.is_empty() {
                let matches = if want.len() >= 8 && want.len() <= cached.digest.len() {
                    cached.digest.starts_with(want)
                } else {
                    want == cached.digest
                };
                if !matches {
                    return Err(OpenBitFunError::tool(format!(
                        "STALE_INTERACTIVE_VIEW: before_view_digest={} but current cached digest={}; re-call `build_interactive_view` and reuse the new digest (full or >=8-char prefix)",
                        want, cached.digest
                    )));
                }
            }
        }
        let el = cached.elements.iter().find(|e| e.i == i).ok_or_else(|| {
            OpenBitFunError::tool(format!(
                "INTERACTIVE_INDEX_OUT_OF_RANGE: i={} not in cached view (len={})",
                i,
                cached.elements.len()
            ))
        })?;
        Ok(el.node_idx)
    }

    #[cfg(any(target_os = "macos", target_os = "windows"))]
    async fn resolve_visual_mark(
        &self,
        app: &AppSelector,
        i: u32,
        before_digest: Option<&str>,
    ) -> OpenBitFunResult<VisualMark> {
        let pid = resolve_pid(self, app).await?;
        let s = self
            .state
            .lock()
            .map_err(|e| OpenBitFunError::tool(format!("lock: {}", e)))?;
        let cached = s.visual_mark_cache.get(&pid).ok_or_else(|| {
            OpenBitFunError::tool(
                "VISUAL_MARK_VIEW_MISSING: call `build_visual_mark_view` before `visual_click`"
                    .to_string(),
            )
        })?;
        if let Some(want) = before_digest {
            let want = want.trim();
            if !want.is_empty() {
                let matches = if want.len() >= 8 && want.len() <= cached.digest.len() {
                    cached.digest.starts_with(want)
                } else {
                    want == cached.digest
                };
                if !matches {
                    return Err(OpenBitFunError::tool(format!(
                        "STALE_VISUAL_MARK_VIEW: before_view_digest={} but current cached digest={}; re-call `build_visual_mark_view` and reuse the new digest (full or >=8-char prefix)",
                        want, cached.digest
                    )));
                }
            }
        }
        cached
            .marks
            .iter()
            .find(|mark| mark.i == i)
            .cloned()
            .ok_or_else(|| {
                OpenBitFunError::tool(format!(
                    "VISUAL_INDEX_OUT_OF_RANGE: i={} not in cached visual mark view (len={})",
                    i,
                    cached.marks.len()
                ))
            })
    }
}
