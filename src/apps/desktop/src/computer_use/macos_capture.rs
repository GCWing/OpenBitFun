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
    fn obf_capture_mark_input(handle: *mut c_void);
    fn obf_capture_free(bytes: *mut c_void);
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
    pub generation: u64,
}

struct CaptureSession {
    handle: NonNull<c_void>,
    pid: i32,
    window_id: u32,
    generation: u64,
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
            generation: self.generation,
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
    super::control_session::capture_allowed()?;
    let mut active = capture().lock().map_err(|_| "Capture lock poisoned")?;
    let generation = super::control_session::capture_token()?.generation();
    if let Some(session) = active.as_ref() {
        if session.generation != generation {
            return Err(
                "CAPTURE_GENERATION_CHANGED: Previous capture cleanup is still pending".into(),
            );
        }
        if session.pid == pid {
            validate_bound_window(session.window_id, window_id)?;
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
    let session = CaptureSession::start(pid, window_id)?;
    // Stop can race a slow permission/capture callback.
    super::control_session::capture_allowed()?;
    super::control_session::bind_target(format!("pid:{pid}/window:{}", session.window_id))?;
    *active = Some(session);
    Ok(())
}
// The sharing indicator itself may be reported as this application's front
// window. Once selected, a window stays bound until the session is stopped.
fn validate_bound_window(bound: u32, requested: Option<u32>) -> Result<(), String> {
    if requested.is_some_and(|id| id != bound) {
        return Err("TARGET_WINDOW_CHANGED: Existing capture remains active; use the bound window or start a new control session to select another window".into());
    }
    Ok(())
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
    let frame = session.frame()?;
    drop(active);
    let target = format!("pid:{pid}/window:{}", frame.window_id);
    super::control_session::publish_rgba_generation(
        frame.generation,
        &target,
        &frame.rgba,
        frame.width,
        frame.height,
        frame.bounds,
    );
    Ok(frame)
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
        &format!("pid:{pid}/window:{window_id}"),
        &message,
    );
}

#[cfg(test)]
mod tests {
    use super::validate_bound_window;

    #[test]
    fn sharing_badge_cannot_retarget_an_existing_window_capture() {
        assert!(validate_bound_window(100, None).is_ok());
        assert!(validate_bound_window(100, Some(100)).is_ok());
        assert!(validate_bound_window(100, Some(101))
            .unwrap_err()
            .starts_with("TARGET_WINDOW_CHANGED:"));
    }
}
