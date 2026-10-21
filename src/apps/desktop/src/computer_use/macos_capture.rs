//! Window-scoped ScreenCaptureKit session. Never substitutes display pixels.
use std::ffi::{c_char, c_void, CStr};
use std::ptr::NonNull;
use std::sync::{Mutex, OnceLock};

unsafe extern "C" {
    fn obf_capture_activation_epoch() -> u64;
    fn obf_capture_start(
        pid: i32,
        window: u32,
        generation: u64,
        error: *mut c_char,
        capacity: usize,
    ) -> *mut c_void;
    fn obf_capture_validate_target(
        pid: i32,
        window: u32,
        error: *mut c_char,
        capacity: usize,
    ) -> u32;
    fn obf_capture_status(handle: *mut c_void, error: *mut c_char, capacity: usize) -> i32;
    fn obf_capture_bounds(
        handle: *mut c_void,
        bounds: *mut f64,
        error: *mut c_char,
        capacity: usize,
    ) -> i32;
    fn obf_capture_frame(
        handle: *mut c_void,
        bytes: *mut *mut u8,
        length: *mut usize,
        width: *mut u32,
        height: *mut u32,
        window: *mut u32,
        bounds: *mut f64,
        sequence: *mut u64,
        error: *mut c_char,
        capacity: usize,
    ) -> i32;
    fn obf_capture_bind_revision(handle: *mut c_void, revision: u64);
    fn obf_capture_mark_input(handle: *mut c_void);
    fn obf_capture_settle_anchor(handle: *mut c_void) -> i64;
    fn obf_capture_settle_poll(
        handle: *mut c_void,
        anchor_ns: i64,
        wait_ms: u32,
        elapsed_ms: *mut i64,
        last_change_ms: *mut i64,
        error: *mut c_char,
        capacity: usize,
    ) -> i32;
    fn obf_capture_retain(handle: *mut c_void) -> *mut c_void;
    fn obf_capture_release(handle: *mut c_void);
    fn obf_capture_free(bytes: *mut c_void);
    fn obf_capture_window_snapshot(
        pid: i32,
        window: u32,
        bytes: *mut *mut u8,
        length: *mut usize,
        width: *mut u32,
        height: *mut u32,
        error: *mut c_char,
        capacity: usize,
    ) -> i32;
    fn obf_capture_stop(handle: *mut c_void);
    fn obf_pointer_show(window: u32, x: f64, y: f64, click: bool);
    fn obf_pointer_hide();
}

/// Process-wide native workspace activation sequence. Zero means the observer
/// has not reached the main runloop yet and must not be used for cache reuse.
pub(super) fn activation_epoch() -> u64 {
    unsafe { obf_capture_activation_epoch() }
}

pub(super) struct CaptureFrame {
    pub rgba: Vec<u8>,
    pub width: u32,
    pub height: u32,
    pub window_id: u32,
    pub bounds: [f64; 4],
    pub scope: openbitfun_agent_tools::computer_use_control::ObservationScope,
    /// Same-process popups composited over (or missing from) `rgba`, front to back.
    pub auxiliary: Vec<super::overlay_windows::CapturedOverlay>,
}

struct CaptureSession {
    handle: NonNull<c_void>,
    pid: i32,
    window_id: u32,
    generation: u64,
    target_revision: u64,
}
// Native state is protected by NSCondition. All Rust accesses additionally use
// CAPTURE; AppKit presentation is explicitly dispatched to the main queue.
unsafe impl Send for CaptureSession {}

fn error_string(error: &[c_char]) -> String {
    // Every native error write is bounded and NUL terminated; the array starts zeroed.
    unsafe {
        CStr::from_ptr(error.as_ptr())
            .to_string_lossy()
            .into_owned()
    }
}
impl CaptureSession {
    fn start(pid: i32, window_id: Option<u32>) -> Result<Self, String> {
        let mut error = [0; 1024];
        let generation = super::control_session::capture_token()?.generation();
        let handle = NonNull::new(unsafe {
            obf_capture_start(
                pid,
                window_id.unwrap_or(0),
                generation,
                error.as_mut_ptr(),
                error.len(),
            )
        })
        .ok_or_else(|| error_string(&error))?;
        let mut session = Self {
            handle,
            pid,
            window_id: window_id.unwrap_or(0),
            generation,
            target_revision: u64::MAX,
        };
        session.window_id = session.frame()?.window_id;
        Ok(session)
    }
    fn check(&self) -> Result<(), String> {
        let mut error = [0; 1024];
        if unsafe { obf_capture_status(self.handle.as_ptr(), error.as_mut_ptr(), error.len()) } == 0
        {
            return Err(error_string(&error));
        }
        Ok(())
    }
    fn frame(&self) -> Result<CaptureFrame, String> {
        let mut error = [0; 1024];
        let mut bytes = std::ptr::null_mut();
        let mut length = 0;
        let (mut width, mut height, mut window_id, mut sequence) = (0, 0, 0, 0);
        let mut bounds = [0.0; 4];
        let ok = unsafe {
            obf_capture_frame(
                self.handle.as_ptr(),
                &mut bytes,
                &mut length,
                &mut width,
                &mut height,
                &mut window_id,
                bounds.as_mut_ptr(),
                &mut sequence,
                error.as_mut_ptr(),
                error.len(),
            )
        };
        if ok == 0 {
            return Err(error_string(&error));
        }
        if bytes.is_null() || length != width as usize * height as usize * 4 {
            unsafe { obf_capture_free(bytes.cast()) };
            return Err("CAPTURE_INVALID_FRAME: Invalid RGBA buffer".into());
        }
        let rgba = unsafe { std::slice::from_raw_parts(bytes, length).to_vec() };
        unsafe { obf_capture_free(bytes.cast()) };
        Ok(CaptureFrame {
            rgba,
            width,
            height,
            window_id,
            bounds,
            auxiliary: Vec::new(),
            scope: openbitfun_agent_tools::computer_use_control::ObservationScope {
                generation: self.generation,
                target_revision: self.target_revision,
                target: Some(format!("pid:{}/window:{}", self.pid, window_id)),
            },
        })
    }
}
impl Drop for CaptureSession {
    fn drop(&mut self) {
        unsafe { obf_capture_stop(self.handle.as_ptr()) };
    }
}
static CAPTURE: OnceLock<Mutex<Option<CaptureSession>>> = OnceLock::new();
fn capture() -> &'static Mutex<Option<CaptureSession>> {
    CAPTURE.get_or_init(|| Mutex::new(None))
}

pub(super) fn ensure_capture(pid: i32, mut window_id: Option<u32>) -> Result<(), String> {
    let selected = super::control_session::snapshot();
    if selected.sharing.is_some() {
        let prefix = format!("pid:{pid}/window:");
        let shared_window = selected
            .target
            .as_deref()
            .and_then(|target| target.strip_prefix(&prefix))
            .and_then(|id| id.parse::<u32>().ok())
            .ok_or("[SHARED_TARGET_ONLY] Application was not shared by the user")?;
        if window_id.is_some_and(|window| window != shared_window) {
            return Err("[SHARED_TARGET_ONLY] Window was not shared by the user".into());
        }
        window_id = Some(shared_window);
        super::control_session::shared_target_allowed(&format!(
            "pid:{pid}/window:{shared_window}"
        ))?;
    }
    super::control_session::capture_allowed()?;
    let mut active = capture().lock().map_err(|_| "Capture lock poisoned")?;
    let generation = super::control_session::capture_token()?.generation();
    if let Some(session) = active.as_ref() {
        if session.generation != generation {
            return Err(
                "CAPTURE_GENERATION_CHANGED: Previous capture cleanup is still pending".into(),
            );
        }
        if session.pid == pid && reuse_bound_window(session.window_id, window_id) {
            return session.check();
        }
        // A bad target request must not destroy a healthy stream. Resolve the
        // new target before releasing the previous one; never overlap streams.
        let mut error = [0; 1024];
        let validated_window = unsafe {
            obf_capture_validate_target(
                pid,
                window_id.unwrap_or(0),
                error.as_mut_ptr(),
                error.len(),
            )
        };
        if validated_window == 0 {
            return Err(error_string(&error));
        }
        window_id = Some(validated_window);
    }
    active.take();
    super::control_session::capture_allowed()?;
    let mut session = CaptureSession::start(pid, window_id)?;
    // Stop can race a slow permission/capture callback.
    super::control_session::capture_allowed()?;
    super::control_session::bind_target(format!("pid:{pid}/window:{}", session.window_id))?;
    session.target_revision = super::control_session::observation_scope()?.target_revision;
    unsafe { obf_capture_bind_revision(session.handle.as_ptr(), session.target_revision) };
    session.check()?;
    *active = Some(session);
    Ok(())
}
// The sharing indicator itself may be reported as this application's front
// window. Omitted selection keeps the binding; only an explicit window ID may
// request a replacement, validated above before the old stream is released.
fn reuse_bound_window(bound: u32, requested: Option<u32>) -> bool {
    requested.is_none_or(|id| id == bound)
}

pub(super) fn bound_window_id(pid: i32) -> Result<u32, String> {
    super::control_session::capture_allowed()?;
    let active = capture().lock().map_err(|_| "Capture lock poisoned")?;
    let session = active.as_ref().ok_or("CAPTURE_STOPPED")?;
    if session.pid != pid {
        return Err("CAPTURE_TARGET_CHANGED: Re-observe the intended app".into());
    }
    session.check()?;
    Ok(session.window_id)
}

pub(super) fn capture_frame(pid: i32, window_id: Option<u32>) -> Result<CaptureFrame, String> {
    ensure_capture(pid, window_id)?;
    let active = capture().lock().map_err(|_| "Capture lock poisoned")?;
    super::control_session::capture_allowed()?;
    let session = active.as_ref().ok_or("CAPTURE_STOPPED")?;
    if session.pid != pid || window_id.is_some_and(|id| session.window_id != id) {
        return Err("CAPTURE_TARGET_CHANGED: Re-observe the intended target".into());
    }
    let mut frame = session.frame()?;
    drop(active);
    composite_overlays(pid, &mut frame);
    super::control_session::validate_observation_scope(&frame.scope)?;
    super::control_session::publish_rgba(
        &frame.scope,
        &frame.rgba,
        frame.width,
        frame.height,
        frame.bounds,
    );
    Ok(frame)
}
fn window_snapshot(pid: i32, window_id: u32) -> Result<(Vec<u8>, u32, u32), String> {
    let mut error = [0; 1024];
    let mut bytes = std::ptr::null_mut();
    let (mut length, mut width, mut height) = (0, 0, 0);
    // SAFETY: every out-pointer refers to a live local, and `error` is a
    // writable buffer of the advertised capacity.
    let ok = unsafe {
        obf_capture_window_snapshot(
            pid,
            window_id,
            &mut bytes,
            &mut length,
            &mut width,
            &mut height,
            error.as_mut_ptr(),
            error.len(),
        )
    };
    if ok == 0 {
        return Err(error_string(&error));
    }
    if bytes.is_null() || length != width as usize * height as usize * 4 {
        // SAFETY: the buffer, if any, was allocated by the native snapshot and
        // is freed exactly once; free(NULL) is a no-op.
        unsafe { obf_capture_free(bytes.cast()) };
        return Err("AUXILIARY_CAPTURE_FAILED: Invalid popup buffer".into());
    }
    // SAFETY: on success the native snapshot returns a non-null buffer of
    // exactly `length` initialized bytes that stays valid until freed below.
    let rgba = unsafe { std::slice::from_raw_parts(bytes, length).to_vec() };
    // SAFETY: freed exactly once, after the copy above.
    unsafe { obf_capture_free(bytes.cast()) };
    Ok((rgba, width, height))
}

/// Paints the target's open menus and popups over its window capture, back
/// to front, so the observation matches what the user sees. A popup whose
/// pixels cannot be captured is still reported, with composited=false.
fn composite_overlays(pid: i32, frame: &mut CaptureFrame) {
    let overlays = super::macos_list_apps::overlays_above(pid, frame.window_id, frame.bounds);
    let mut captured = Vec::with_capacity(overlays.len());
    for overlay in overlays.into_iter().rev() {
        let result = u32::try_from(overlay.window_id)
            .map_err(|_| "AUXILIARY_WINDOW_UNAVAILABLE: Window id out of range".to_string())
            .and_then(|id| window_snapshot(pid, id));
        let (composited, unavailable_reason) = match result {
            Ok((pixels, width, height)) => {
                super::overlay_windows::blend_premultiplied(
                    &mut frame.rgba,
                    (frame.width, frame.height),
                    frame.bounds,
                    &pixels,
                    (width, height),
                    overlay.bounds,
                );
                (true, None)
            }
            Err(reason) => {
                log::debug!(
                    "Computer use popup capture unavailable: pid={pid}, window={}, reason={reason}",
                    overlay.window_id
                );
                (false, Some(reason))
            }
        };
        captured.push(super::overlay_windows::CapturedOverlay {
            window: overlay,
            composited,
            unavailable_reason,
        });
    }
    captured.reverse();
    frame.auxiliary = captured;
}

/// Same-process popups above the bound window, front to back.
pub(super) fn overlays(
    pid: i32,
    window_id: u32,
) -> Result<Vec<super::overlay_windows::OverlayWindow>, String> {
    let bounds = window_bounds(pid, window_id)?;
    Ok(super::macos_list_apps::overlays_above(
        pid, window_id, bounds,
    ))
}

/// Current global frame of the bound window or of one of its open popups.
/// Usable after revocation so held presses can still be released.
pub(super) fn routing_bounds(pid: i32, window_id: u32) -> Result<[f64; 4], String> {
    let bound = {
        let active = capture().lock().map_err(|_| "Capture lock poisoned")?;
        let session = active.as_ref().ok_or("CAPTURE_STOPPED")?;
        if session.pid != pid {
            return Err("CAPTURE_TARGET_CHANGED".into());
        }
        session.window_id
    };
    let bound_bounds = window_bounds(pid, bound)?;
    if window_id == bound {
        return Ok(bound_bounds);
    }
    super::macos_list_apps::overlays_above(pid, bound, bound_bounds)
        .into_iter()
        .find(|overlay| overlay.window_id == window_id as u64)
        .map(|overlay| overlay.bounds)
        .ok_or_else(|| "AUXILIARY_WINDOW_CLOSED: The popup that received the press is gone".into())
}

pub(super) fn window_bounds(pid: i32, window_id: u32) -> Result<[f64; 4], String> {
    let active = capture().lock().map_err(|_| "Capture lock poisoned")?;
    let session = active.as_ref().ok_or("CAPTURE_STOPPED")?;
    if session.pid != pid || session.window_id != window_id {
        return Err("CAPTURE_TARGET_CHANGED".into());
    }
    let mut bounds = [0.0; 4];
    let mut error = [0; 1024];
    if unsafe {
        obf_capture_bounds(
            session.handle.as_ptr(),
            bounds.as_mut_ptr(),
            error.as_mut_ptr(),
            error.len(),
        )
    } == 0
    {
        return Err(error_string(&error));
    }
    Ok(bounds)
}
/// Called only after input was dispatched. Failure to find an old/stopped
/// binding must not turn an already delivered input into a retryable failure.
pub(super) fn note_input(pid: i32) {
    if let Ok(active) = capture().lock() {
        if let Some(session) = active.as_ref().filter(|session| session.pid == pid) {
            unsafe { obf_capture_mark_input(session.handle.as_ptr()) };
        }
    }
}

/// Native session reference held across a settle wait without CAPTURE, so a
/// concurrent Stop is never blocked behind it.
struct RetainedCapture(NonNull<c_void>);
// SAFETY: the native object is internally synchronized by its NSCondition.
unsafe impl Send for RetainedCapture {}
impl Drop for RetainedCapture {
    fn drop(&mut self) {
        // SAFETY: balances the single retain taken when this value was built.
        unsafe { obf_capture_release(self.0.as_ptr()) };
    }
}

/// Wait until the bound window has not repainted for the policy's quiet
/// interval after the latest input barrier. Never captures pixels itself.
pub(super) fn wait_settled(
    pid: i32,
    window_id: u32,
    policy: openbitfun_core::agentic::tools::computer_use_host::AppInputSettlePolicy,
) -> Result<openbitfun_core::agentic::tools::computer_use_host::AppInputSettle, String> {
    use openbitfun_core::agentic::tools::computer_use_host::{
        app_input_settle_decision, app_input_settle_next_wait_ms, AppInputSettle,
        AppInputSettleStatus,
    };
    let started = std::time::Instant::now();
    let retained = {
        let active = capture().lock().map_err(|_| "Capture lock poisoned")?;
        let Some(session) = active.as_ref() else {
            return Ok(AppInputSettle::unavailable(
                "No live window stream; the observation was taken without waiting for repaint",
            ));
        };
        if session.pid != pid || session.window_id != window_id {
            return Ok(AppInputSettle::unavailable(
                "The live window stream belongs to another target",
            ));
        }
        session.check()?;
        RetainedCapture(
            // SAFETY: the session handle is live while CAPTURE is locked.
            NonNull::new(unsafe { obf_capture_retain(session.handle.as_ptr()) })
                .ok_or("CAPTURE_STOPPED")?,
        )
    };
    let interrupted = |reason: String| AppInputSettle {
        status: AppInputSettleStatus::Interrupted,
        waited_ms: started.elapsed().as_millis() as u64,
        changed: None,
        reason: Some(reason),
    };
    // SAFETY: `retained` keeps the native session alive for this call.
    let anchor = unsafe { obf_capture_settle_anchor(retained.0.as_ptr()) };
    let mut wait_ms = 0;
    loop {
        if let Err(reason) = super::control_session::capture_allowed() {
            return Ok(interrupted(reason));
        }
        let (mut elapsed, mut last_change) = (0_i64, -1_i64);
        let mut error = [0; 1024];
        // SAFETY: `retained` keeps the session alive; out-pointers are live
        // locals and `error` has the advertised capacity.
        let ok = unsafe {
            obf_capture_settle_poll(
                retained.0.as_ptr(),
                anchor,
                wait_ms,
                &mut elapsed,
                &mut last_change,
                error.as_mut_ptr(),
                error.len(),
            )
        };
        if ok == 0 {
            return Ok(interrupted(error_string(&error)));
        }
        let elapsed = elapsed.max(0) as u64;
        let last_change = u64::try_from(last_change).ok();
        if let Some(status) = app_input_settle_decision(policy, elapsed, last_change) {
            return Ok(AppInputSettle {
                status,
                waited_ms: started.elapsed().as_millis() as u64,
                changed: Some(last_change.is_some()),
                reason: None,
            });
        }
        wait_ms = app_input_settle_next_wait_ms(policy, elapsed, last_change);
    }
}

pub(super) fn stop_capture() {
    super::macos_bg_input::release_held_inputs();
    if let Ok(mut session) = capture().lock() {
        session.take();
    }
    hide_pointer();
}
pub(super) fn show_pointer(gx: f64, gy: f64, click: bool) {
    if !gx.is_finite() || !gy.is_finite() {
        return;
    }
    if let Ok(active) = capture().lock() {
        if let Some(session) = active.as_ref().filter(|s| s.check().is_ok()) {
            unsafe { obf_pointer_show(session.window_id, gx, gy, click) };
        }
    }
}
pub(super) fn hide_pointer() {
    unsafe { obf_pointer_hide() };
}

// Native delegates call this after releasing NSCondition. The owner must only
// revoke input here; it must not synchronously re-enter the capture mutex.
#[unsafe(no_mangle)]
extern "C" fn obf_control_native_stopped(
    generation: u64,
    target_revision: u64,
    pid: i32,
    window_id: u32,
    reason: *const c_char,
) {
    let message = if reason.is_null() {
        "CAPTURE_STOPPED".into()
    } else {
        unsafe { CStr::from_ptr(reason).to_string_lossy() }
    };
    super::control_session::native_stopped_target(
        generation,
        target_revision,
        &format!("pid:{pid}/window:{window_id}"),
        &message,
    );
}

#[cfg(test)]
mod tests {
    use super::reuse_bound_window;

    #[test]
    fn sharing_badge_cannot_retarget_an_existing_window_capture() {
        assert!(reuse_bound_window(100, None));
        assert!(reuse_bound_window(100, Some(100)));
        assert!(!reuse_bound_window(100, Some(101)));
    }
}
