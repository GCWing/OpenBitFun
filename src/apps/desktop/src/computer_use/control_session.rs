//! Desktop GUI resource admission. Runtime remains the task/permission owner.
use openbitfun_agent_tools::computer_use_control::{
    action_is_observation, action_requires_foreground, ControlClick, ControlMode, ControlPointer,
    ControlSnapshot,
};
use openbitfun_core::agentic::tools::computer_use_host::ComputerUseActionLease;
use std::cell::Cell;
use std::sync::{Mutex, OnceLock};

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
enum Executor {
    Task(tokio::task::Id),
    Thread(std::thread::ThreadId),
}
fn executor() -> Executor {
    tokio::task::try_id()
        .map(Executor::Task)
        .unwrap_or_else(|| Executor::Thread(std::thread::current().id()))
}

/// An in-process capability, never deserialized from the controller. Blocking
/// workers retain the action identity even after the async tool future is gone.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub(crate) struct ControlToken {
    generation: u64,
    sequence: u64,
    input: bool,
}
impl ControlToken {
    pub(crate) fn generation(self) -> u64 {
        self.generation
    }
}
thread_local! { static TOKEN: Cell<Option<ControlToken>> = const { Cell::new(None) }; }

#[derive(Default)]
struct Resource {
    snapshot: ControlSnapshot,
    executor: Option<Executor>,
    busy: bool,
    cleaning: bool,
    preview: Option<ControlPreview>,
}
static RESOURCE: OnceLock<Mutex<Resource>> = OnceLock::new();
static SCOPE_CHANGED: tokio::sync::Notify = tokio::sync::Notify::const_new();
fn resource() -> &'static Mutex<Resource> {
    RESOURCE.get_or_init(|| Mutex::new(Resource::default()))
}
fn locked() -> Result<std::sync::MutexGuard<'static, Resource>, String> {
    resource()
        .lock()
        .map_err(|_| "[CONTROL_FAILED] Control resource lock poisoned".into())
}
fn active(r: &Resource) -> bool {
    r.snapshot.state == "active" && !r.cleaning
}
fn token_for(r: &Resource) -> ControlToken {
    ControlToken {
        generation: r.snapshot.generation,
        sequence: r.snapshot.sequence,
        input: r.busy && r.executor == Some(executor()),
    }
}
fn matches_token(r: &Resource, token: ControlToken) -> bool {
    token.generation == r.snapshot.generation && token.sequence == r.snapshot.sequence
}
fn check_context(r: &Resource) -> Result<(), String> {
    if !active(r) {
        return Err("[CONTROL_STOPPED] Start a new control session before capturing".into());
    }
    if TOKEN.get().is_some_and(|token| !matches_token(r, token)) {
        return Err("[CONTROL_STALE] This worker belongs to an earlier action".into());
    }
    Ok(())
}
pub(crate) fn capture_token() -> Result<ControlToken, String> {
    let r = locked()?;
    check_context(&r)?;
    Ok(TOKEN.get().unwrap_or_else(|| token_for(&r)))
}
pub(crate) fn with_token<T>(token: ControlToken, f: impl FnOnce() -> T) -> T {
    struct Reset(Option<ControlToken>);
    impl Drop for Reset {
        fn drop(&mut self) {
            TOKEN.set(self.0);
        }
    }
    let _reset = Reset(TOKEN.replace(Some(token)));
    f()
}
/// Drop-in replacement for host blocking operations. Stale workers never gain
/// the authority of a later task just because its global busy flag is true.
pub(crate) fn dispatch_token() -> ControlToken {
    capture_token().unwrap_or(ControlToken {
        generation: u64::MAX,
        sequence: u64::MAX,
        input: false,
    })
}
pub(crate) fn spawn_blocking<F, R>(f: F) -> tokio::task::JoinHandle<R>
where
    F: FnOnce() -> R + Send + 'static,
    R: Send + 'static,
{
    let token = dispatch_token();
    tokio::task::spawn_blocking(move || with_token(token, f))
}

async fn wait_with_scope_check(
    changed: &tokio::sync::Notify,
    duration: std::time::Duration,
    check: impl Fn() -> Result<(), String>,
) -> Result<(), String> {
    let timer = tokio::time::sleep(duration);
    tokio::pin!(timer);
    loop {
        let notification = changed.notified();
        tokio::pin!(notification);
        // Register before reading scope, so Stop cannot fall between the
        // validity check and notification subscription.
        notification.as_mut().enable();
        check()?;
        tokio::select! {
            biased;
            _ = &mut notification => {},
            _ = &mut timer => return check(),
        }
    }
}

pub(crate) async fn wait(ms: u64) -> Result<(), String> {
    let token = capture_token()?;
    let target = snapshot().target;
    wait_with_scope_check(&SCOPE_CHANGED, std::time::Duration::from_millis(ms), || {
        let r = locked()?;
        check_context(&r)?;
        if !matches_token(&r, token) || r.snapshot.target != target {
            return Err("[CONTROL_STALE] Control changed during wait".into());
        }
        Ok(())
    })
    .await
}

fn projected(r: &Resource) -> ControlSnapshot {
    let mut s = r.snapshot.clone();
    s.supported = true;
    s.capabilities = vec![
        "control-session-v1".into(),
        "stop-control".into(),
        "action-feedback".into(),
    ];
    // Backend routes, not a claim that every control implements them. These
    // facts let the agent plan before sending unsupported canvas operations.
    #[cfg(target_os = "macos")]
    s.capabilities.extend(
        [
            "window-capture",
            "background-ax-semantic-input",
            "background-directed-keyboard",
            "background-directed-scroll",
            "background-window-directed-input",
            "foreground-raw-pointer",
        ]
        .map(str::to_owned),
    );
    #[cfg(target_os = "windows")]
    s.capabilities.extend(
        [
            "window-capture",
            "background-uia-semantic-input",
            "background-window-messages",
            "foreground-seat-input",
        ]
        .map(str::to_owned),
    );
    #[cfg(target_os = "linux")]
    s.capabilities.extend(
        [
            "portal-capture",
            "background-atspi-semantic-input",
            "foreground-portal-seat-input",
        ]
        .map(str::to_owned),
    );
    if s.state.is_empty() {
        s.state = "idle".into();
    }
    s
}
pub(crate) fn snapshot() -> ControlSnapshot {
    locked()
        .map(|r| projected(&r))
        .unwrap_or_else(|e| ControlSnapshot {
            state: "failed".into(),
            reason: Some(e),
            ..Default::default()
        })
}
fn begin_start(r: &mut Resource, owner: &str, mode: ControlMode) -> Result<u64, String> {
    if owner.trim().is_empty() {
        return Err("[CONTROL_OWNER_REQUIRED] A runtime session is required".into());
    }
    if r.busy || r.cleaning || (active(r) && r.snapshot.owner.as_deref() != Some(owner)) {
        return Err("[CONTROL_BUSY] Another action or session owns desktop control".into());
    }
    r.cleaning = true;
    r.snapshot.generation += 1;
    r.snapshot.owner = Some(owner.into());
    r.snapshot.mode = mode;
    r.snapshot.target = None;
    r.snapshot.pointer = None;
    r.snapshot.reason = None;
    r.snapshot.action = None;
    r.snapshot.state = "starting".into();
    r.preview = None;
    Ok(r.snapshot.generation)
}
fn finish_start(r: &mut Resource, generation: u64) -> Result<(), String> {
    if r.snapshot.generation != generation || r.snapshot.state != "starting" {
        return Err("[CONTROL_STOPPED] Start was cancelled during native cleanup".into());
    }
    r.cleaning = false;
    r.snapshot.state = "active".into();
    Ok(())
}
pub(crate) fn start(owner: &str, mode: ControlMode) -> Result<ControlSnapshot, String> {
    let generation = begin_start(&mut *locked()?, owner, mode)?;
    stop_native();
    let mut r = locked()?;
    finish_start(&mut r, generation)?;
    Ok(projected(&r))
}
fn revoke(r: &mut Resource, reason: &str) -> u64 {
    SCOPE_CHANGED.notify_waiters();
    r.snapshot.generation += 1;
    r.snapshot.state = "stopped".into();
    r.snapshot.reason = Some(reason.into());
    r.snapshot.pointer = None;
    r.snapshot.action = None;
    r.busy = false;
    r.executor = None;
    r.cleaning = true;
    r.preview = None;
    r.snapshot.generation
}
fn finish_cleanup(r: &mut Resource, ticket: u64) {
    // An older callback cannot open admission while a newer cleanup is pending.
    if r.snapshot.generation == ticket && r.snapshot.state == "stopped" {
        r.cleaning = false;
    }
}
pub(crate) fn stop(owner: Option<&str>, reason: &str) -> Result<ControlSnapshot, String> {
    stop_checked(owner, None, reason)
}
pub(crate) fn stop_checked(
    owner: Option<&str>,
    generation: Option<u64>,
    reason: &str,
) -> Result<ControlSnapshot, String> {
    let ticket = {
        let mut r = locked()?;
        if generation.is_some_and(|g| r.snapshot.generation != g) {
            return Err("[CONTROL_STALE] The control session has changed".into());
        }
        if owner.is_some_and(|owner| {
            r.snapshot
                .owner
                .as_deref()
                .is_some_and(|current| current != owner)
        }) {
            return Err("[CONTROL_OWNER_MISMATCH] This task does not own desktop control".into());
        }
        revoke(&mut r, reason)
    };
    stop_native();
    let mut r = locked()?;
    finish_cleanup(&mut r, ticket);
    Ok(projected(&r))
}
fn cleanup_async(ticket: u64) {
    std::thread::spawn(move || {
        stop_native();
        if let Ok(mut r) = locked() {
            finish_cleanup(&mut r, ticket);
        }
    });
}
/// Native delegates pass the identity captured when their stream was created.
/// Never call an unscoped "stop current" from a delayed native callback.
#[cfg(target_os = "linux")]
pub(crate) fn native_stopped_generation(generation: u64, reason: &str) {
    native_stopped_inner(generation, None, reason);
}
pub(crate) fn native_stopped_target(generation: u64, target: &str, reason: &str) {
    native_stopped_inner(generation, Some(target), reason);
}
fn revoke_native(
    r: &mut Resource,
    generation: u64,
    target: Option<&str>,
    reason: &str,
) -> Option<u64> {
    if r.snapshot.generation != generation
        || !active(r)
        || target.is_some_and(|target| r.snapshot.target.as_deref() != Some(target))
    {
        return None;
    }
    Some(revoke(r, reason))
}
fn native_stopped_inner(generation: u64, target: Option<&str>, reason: &str) {
    let ticket = locked()
        .ok()
        .and_then(|mut r| revoke_native(&mut r, generation, target, reason));
    if let Some(ticket) = ticket {
        cleanup_async(ticket);
    }
}
pub(crate) fn capture_allowed() -> Result<(), String> {
    check_context(&*locked()?)
}
pub(crate) fn input_allowed() -> Result<(), String> {
    let r = locked()?;
    check_context(&r)?;
    let token = TOKEN.get().unwrap_or_else(|| token_for(&r));
    if !r.busy || !token.input || !matches_token(&r, token) {
        return Err("[CONTROL_STOPPED] Input lease has been revoked".into());
    }
    if r.snapshot.mode == ControlMode::Observe {
        return Err("[CONTROL_OBSERVE_ONLY] Observation does not authorize input".into());
    }
    Ok(())
}
pub(crate) fn foreground_allowed() -> Result<(), String> {
    input_allowed()?;
    if locked()?.snapshot.mode != ControlMode::Foreground {
        return Err(
            "[FOREGROUND_REQUIRED] Seat input requires start_control with mode=foreground".into(),
        );
    }
    Ok(())
}
pub(crate) fn bind_target(target: String) -> Result<(), String> {
    let mut r = locked()?;
    check_context(&r)?;
    if target.trim().is_empty() {
        return Err("[CONTROL_TARGET_REQUIRED] A native target is required".into());
    }
    let changed = r.snapshot.target.as_deref() != Some(&target);
    if changed {
        SCOPE_CHANGED.notify_waiters();
        r.preview = None;
        r.snapshot.pointer = None;
    }
    r.snapshot.target = Some(target);
    drop(r);
    if changed {
        #[cfg(target_os = "macos")]
        {
            super::macos_input_focus::stop();
            super::macos_capture::hide_pointer();
        }
        #[cfg(target_os = "windows")]
        super::windows_pointer_feedback::hide_pointer();
    }
    Ok(())
}
pub(crate) fn target_allowed(target: &str) -> Result<(), String> {
    let r = locked()?;
    check_context(&r)?;
    if r.snapshot.target.as_deref() != Some(target) {
        return Err(
            "[CONTROL_TARGET_CHANGED] The input target differs from the captured window".into(),
        );
    }
    Ok(())
}
pub(crate) fn record_pointer(x: f64, y: f64, click: bool) {
    if !x.is_finite() || !y.is_finite() || input_allowed().is_err() {
        return;
    }
    let target = if let Ok(mut r) = locked() {
        if check_context(&r).is_err() || !r.busy {
            return;
        }
        let occurred_at_ms = std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .unwrap_or_default()
            .as_millis() as u64;
        let sequence = r
            .snapshot
            .pointer
            .as_ref()
            .map_or(1, |p| p.sequence.saturating_add(1));
        let last_click = if click {
            Some(ControlClick {
                x,
                y,
                sequence,
                occurred_at_ms,
            })
        } else {
            r.snapshot
                .pointer
                .as_ref()
                .and_then(|p| p.last_click.clone())
        };
        r.snapshot.pointer = Some(ControlPointer {
            x,
            y,
            click,
            sequence,
            occurred_at_ms,
            last_click,
        });
        r.snapshot.target.clone()
    } else {
        return;
    };
    #[cfg(target_os = "macos")]
    {
        let _ = target;
        super::macos_capture::show_pointer(x, y, click);
    }
    #[cfg(target_os = "windows")]
    if let Some(hwnd) = target
        .as_deref()
        .and_then(|t| t.split("/window:").nth(1))
        .and_then(|s| s.parse::<usize>().ok())
    {
        super::windows_pointer_feedback::show_pointer(
            hwnd,
            x.round() as i32,
            y.round() as i32,
            click,
        );
    }
    #[cfg(target_os = "linux")]
    let _ = target;
}
fn admit(
    r: &mut Resource,
    owner: &str,
    action: &str,
    execution: Executor,
) -> Result<ControlToken, String> {
    if owner.trim().is_empty() {
        return Err("[CONTROL_OWNER_REQUIRED] A runtime session is required".into());
    }
    if r.snapshot.state.is_empty() || r.snapshot.state == "idle" {
        r.snapshot.owner = Some(owner.into());
        r.snapshot.mode = ControlMode::Background;
        r.snapshot.state = "active".into();
        r.snapshot.generation += 1;
    }
    if !active(r) {
        return Err("[CONTROL_STOPPED] Use start_control to begin a new session".into());
    }
    if r.snapshot.owner.as_deref() != Some(owner) || r.busy {
        return Err("[CONTROL_BUSY] Desktop control belongs to another task or action".into());
    }
    if r.snapshot.mode == ControlMode::Observe && !action_is_observation(action) {
        return Err("[CONTROL_OBSERVE_ONLY] Start a control session to send input".into());
    }
    if action_requires_foreground(action) && r.snapshot.mode != ControlMode::Foreground {
        return Err("[FOREGROUND_REQUIRED] This action uses desktop focus or seat input; explicitly start_control with mode=foreground".into());
    }
    r.busy = true;
    r.executor = Some(execution);
    r.snapshot.sequence += 1;
    r.snapshot.action = Some(action.into());
    Ok(ControlToken {
        generation: r.snapshot.generation,
        sequence: r.snapshot.sequence,
        input: true,
    })
}
pub(crate) fn acquire(
    owner: &str,
    action: &str,
) -> Result<Box<dyn ComputerUseActionLease>, String> {
    let token = admit(&mut *locked()?, owner, action, executor())?;
    Ok(Box::new(Lease {
        token,
        complete: false,
    }))
}
struct Lease {
    token: ControlToken,
    complete: bool,
}
impl ComputerUseActionLease for Lease {
    fn complete(&mut self) {
        self.complete = true;
    }
}
fn release(r: &mut Resource, token: ControlToken, complete: bool) -> Option<u64> {
    if !matches_token(r, token) {
        return None;
    }
    r.busy = false;
    r.executor = None;
    if complete {
        r.snapshot.action = None;
        None
    } else {
        Some(revoke(r, "action_cancelled"))
    }
}
impl Drop for Lease {
    fn drop(&mut self) {
        let ticket = locked()
            .ok()
            .and_then(|mut r| release(&mut r, self.token, self.complete));
        if let Some(ticket) = ticket {
            cleanup_async(ticket);
        }
    }
}
fn stop_native() {
    #[cfg(target_os = "macos")]
    {
        super::macos_capture::stop_capture();
        super::macos_input_focus::stop();
        super::macos_capture::hide_pointer();
    }
    #[cfg(target_os = "windows")]
    {
        super::windows_wgc_capture::stop_capture();
        super::windows_pointer_feedback::hide_pointer();
    }
    #[cfg(target_os = "linux")]
    {
        super::linux_control::stop_session();
    }
}

#[derive(Clone, serde::Serialize)]
pub struct ControlPreview {
    pub target: String,
    pub image_base64: String,
    pub mime_type: &'static str,
    pub width: u32,
    pub height: u32,
    pub origin_x: f64,
    pub origin_y: f64,
    pub span_width: f64,
    pub span_height: f64,
    pub generation: u64,
}

/// Capture callers pass the identity saved before native work, never retag a
/// late frame with snapshot() after a new task has acquired the device.
pub(crate) fn publish_rgba_generation(
    generation: u64,
    target: &str,
    bytes: &[u8],
    width: u32,
    height: u32,
    bounds: [f64; 4],
) {
    let Some(image) = image::RgbaImage::from_raw(width, height, bytes.to_vec()) else {
        return;
    };
    let image = image::DynamicImage::ImageRgba8(image)
        .thumbnail(1280, 800)
        .to_rgb8();
    let mut jpeg = Vec::new();
    if image::codecs::jpeg::JpegEncoder::new_with_quality(&mut jpeg, 75)
        .encode_image(&image)
        .is_ok()
    {
        publish_jpeg_generation(generation, target, &jpeg, bounds);
    }
}
pub(crate) fn publish_jpeg_generation(
    generation: u64,
    target: &str,
    bytes: &[u8],
    bounds: [f64; 4],
) {
    use base64::Engine;
    if bounds.iter().any(|v| !v.is_finite()) || bounds[2] <= 0.0 || bounds[3] <= 0.0 {
        return;
    }
    let Ok(image) = image::load_from_memory(bytes) else {
        return;
    };
    let frame = ControlPreview {
        target: target.to_owned(),
        image_base64: base64::engine::general_purpose::STANDARD.encode(bytes),
        mime_type: "image/jpeg",
        width: image.width(),
        height: image.height(),
        origin_x: bounds[0],
        origin_y: bounds[1],
        span_width: bounds[2],
        span_height: bounds[3],
        generation,
    };
    if let Ok(mut r) = locked() {
        if check_context(&r).is_ok()
            && r.snapshot.generation == generation
            && r.snapshot.target.as_deref() == Some(target)
        {
            r.preview = Some(frame);
        }
    }
}
pub(crate) fn preview(generation: u64) -> Result<Option<ControlPreview>, String> {
    let r = locked()?;
    if r.snapshot.generation != generation || !active(&r) {
        return Err("[CONTROL_STALE] Control session changed".into());
    }
    Ok(r.preview
        .as_ref()
        .filter(|p| p.generation == generation)
        .cloned())
}

#[cfg(test)]
mod tests {
    use super::*;
    fn running() -> Resource {
        let mut r = Resource::default();
        let g = begin_start(&mut r, "a", ControlMode::Background).unwrap();
        finish_start(&mut r, g).unwrap();
        r
    }
    #[test]
    fn stop_during_start_cannot_resurrect_admission() {
        let mut r = Resource::default();
        let started = begin_start(&mut r, "a", ControlMode::Background).unwrap();
        let stopped = revoke(&mut r, "user_stopped");
        assert!(finish_start(&mut r, started).is_err());
        assert!(!active(&r));
        finish_cleanup(&mut r, stopped);
        assert!(!active(&r));
    }
    #[test]
    fn old_cleanup_cannot_clear_new_cleanup_barrier() {
        let mut r = running();
        let first = revoke(&mut r, "first");
        let second = revoke(&mut r, "second");
        finish_cleanup(&mut r, first);
        assert!(r.cleaning);
        assert!(begin_start(&mut r, "a", ControlMode::Background).is_err());
        finish_cleanup(&mut r, second);
        assert!(!r.cleaning);
    }
    #[test]
    fn old_worker_and_old_lease_cannot_borrow_new_action() {
        let mut r = running();
        let first = admit(&mut r, "a", "app_click", executor()).unwrap();
        let stopped = revoke(&mut r, "cancelled");
        finish_cleanup(&mut r, stopped);
        let g = begin_start(&mut r, "a", ControlMode::Background).unwrap();
        finish_start(&mut r, g).unwrap();
        let second = admit(&mut r, "a", "app_click", executor()).unwrap();
        assert!(!matches_token(&r, first));
        assert!(matches_token(&r, second));
        with_token(first, || assert!(check_context(&r).is_err()));
        assert!(release(&mut r, first, false).is_none());
        assert!(r.busy);
    }
    #[test]
    fn successive_actions_in_same_session_have_distinct_authority() {
        let mut r = running();
        let first = admit(&mut r, "a", "app_click", executor()).unwrap();
        release(&mut r, first, true);
        let second = admit(&mut r, "a", "app_click", executor()).unwrap();
        assert_eq!(first.generation, second.generation);
        assert_ne!(first.sequence, second.sequence);
        with_token(first, || assert!(check_context(&r).is_err()));
    }
    #[test]
    fn native_stop_from_old_stream_cannot_revoke_retargeted_window() {
        let mut r = running();
        let generation = r.snapshot.generation;
        r.snapshot.target = Some("window:new".into());
        assert!(revoke_native(&mut r, generation, Some("window:old"), "closed").is_none());
        assert!(active(&r));
        let ticket = revoke_native(&mut r, generation, Some("window:new"), "closed").unwrap();
        assert!(r.cleaning);
        assert!(!active(&r));
        finish_cleanup(&mut r, ticket);
    }
    #[test]
    fn observer_foreground_and_owner_boundaries_are_enforced() {
        let mut r = running();
        r.snapshot.mode = ControlMode::Observe;
        assert!(admit(&mut r, "a", "app_click", executor()).is_err());
        assert!(admit(&mut r, "b", "get_app_state", executor()).is_err());
        r.snapshot.mode = ControlMode::Background;
        assert!(admit(&mut r, "a", "click", executor()).is_err());
        assert!(admit(&mut r, "", "get_app_state", executor()).is_err());
        assert!(!r.busy);
    }
}

#[cfg(test)]
mod wait_tests {
    use super::*;
    use std::sync::atomic::{AtomicBool, Ordering};
    #[tokio::test]
    async fn scope_revocation_interrupts_long_wait_without_polling_or_input() {
        let changed = tokio::sync::Notify::new();
        let started = tokio::sync::Notify::new();
        let active = AtomicBool::new(true);
        let waiting = wait_with_scope_check(&changed, std::time::Duration::from_secs(60), || {
            started.notify_one();
            if active.load(Ordering::SeqCst) {
                Ok(())
            } else {
                Err("stopped".into())
            }
        });
        let stop = async {
            started.notified().await;
            active.store(false, Ordering::SeqCst);
            changed.notify_waiters();
        };
        let (result, ()) = tokio::time::timeout(std::time::Duration::from_secs(1), async {
            tokio::join!(waiting, stop)
        })
        .await
        .expect("revocation must wake the wait immediately");
        assert_eq!(result.unwrap_err(), "stopped");
    }
}
