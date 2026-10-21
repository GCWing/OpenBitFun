//! Desktop GUI resource admission. Runtime remains the task/permission owner.
use openbitfun_agent_tools::computer_use_control::{
    ControlClick, ControlMode, ControlPointer, ControlSnapshot, ObservationScope,
};
use openbitfun_core::agentic::tools::computer_use_host::ComputerUseActionLease;
use std::cell::Cell;
use std::sync::{Mutex, OnceLock};

#[path = "control_session/admission.rs"]
mod admission;
#[path = "control_session/sharing.rs"]
mod sharing;
use admission::Admission;
pub(crate) use admission::ControlToken;
#[cfg(target_os = "macos")]
pub(crate) use sharing::shared_target_allowed;
pub(crate) use sharing::{
    acquire_shared, begin_share, finish_share, grant_preference_result, request_share,
    set_share_control, shared_process,
};

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

thread_local! { static TOKEN: Cell<Option<ControlToken>> = const { Cell::new(None) }; }

#[derive(Default)]
struct Resource {
    admission: Admission<Executor>,
    preview: Option<ControlPreview>,
    process: Option<super::process_identity::ProcessIdentity>,
}
static RESOURCE: OnceLock<Mutex<Resource>> = OnceLock::new();
static NATIVE_CLEANUP: Mutex<()> = Mutex::new(());
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
    r.admission.active()
}
fn token_for(r: &Resource) -> ControlToken {
    r.admission.token(executor())
}
fn matches_token(r: &Resource, token: ControlToken) -> bool {
    r.admission.matches_token(token)
}
fn check_context(r: &Resource) -> Result<(), String> {
    r.admission.check_observer(executor(), TOKEN.get())?;
    if let Some(process) = &r.process {
        process.validate()?;
    }
    Ok(())
}

/// Captured before crossing an async/native boundary; never mint a replacement
/// scope after the work completes.
pub(crate) fn observation_scope() -> Result<ObservationScope, String> {
    let r = locked()?;
    check_context(&r)?;
    Ok(ObservationScope::from_control(&r.admission.snapshot))
}
pub(crate) fn validate_observation_scope(scope: &ObservationScope) -> Result<(), String> {
    let r = locked()?;
    check_context(&r)?;
    if *scope != ObservationScope::from_control(&r.admission.snapshot) {
        return Err("[CONTROL_STALE] Observation belongs to a stopped or rebound target".into());
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
    capture_token().unwrap_or(ControlToken::invalid())
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
    let scope = observation_scope()?;
    wait_with_scope_check(&SCOPE_CHANGED, std::time::Duration::from_millis(ms), || {
        let r = locked()?;
        check_context(&r)?;
        if !matches_token(&r, token)
            || ObservationScope::from_control(&r.admission.snapshot) != scope
        {
            return Err("[CONTROL_STALE] Control changed during wait".into());
        }
        Ok(())
    })
    .await
}

fn projected(r: &Resource) -> ControlSnapshot {
    let mut s = r.admission.snapshot.clone();
    s.supported = true;
    s.capabilities = vec![
        "control-session-v1".into(),
        "agent-directed-control-v1".into(),
        "stop-control".into(),
        "action-feedback".into(),
        "observation-scope-v1".into(),
        "observation-id-v1".into(),
        "app-sharing-v1".into(),
        "permission-requests-v1".into(),
    ];
    // Backend routes, not a claim that every control implements them. These
    // facts let the agent plan before sending unsupported canvas operations.
    #[cfg(target_os = "macos")]
    s.capabilities.extend(
        [
            "window-capture",
            "window-target-v1",
            "activate-app-v1",
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
            "window-target-v1",
            "activate-app-v1",
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
pub(crate) fn start(owner: &str, mode: ControlMode) -> Result<ControlSnapshot, String> {
    let generation = {
        let mut r = locked()?;
        let generation = r.admission.begin_start(owner, mode)?;
        r.preview = None;
        r.process = None;
        SCOPE_CHANGED.notify_waiters();
        generation
    };
    stop_native(generation)?;
    let mut r = locked()?;
    r.admission.finish_start(generation)?;
    Ok(projected(&r))
}
fn revoke(r: &mut Resource, reason: &str) -> u64 {
    SCOPE_CHANGED.notify_waiters();
    r.preview = None;
    r.process = None;
    r.admission.revoke(reason)
}
fn finish_cleanup(r: &mut Resource, ticket: u64) {
    r.admission.finish_cleanup(ticket);
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
        let Some(ticket) = r.admission.request_stop(owner, generation, reason)? else {
            return Ok(projected(&r));
        };
        r.preview = None;
        r.process = None;
        SCOPE_CHANGED.notify_waiters();
        ticket
    };
    stop_native(ticket)?;
    let mut r = locked()?;
    finish_cleanup(&mut r, ticket);
    Ok(projected(&r))
}
fn cleanup_async(ticket: u64) {
    std::thread::spawn(move || {
        if stop_native(ticket).is_err() {
            return;
        }
        if let Ok(mut r) = locked() {
            finish_cleanup(&mut r, ticket);
        }
    });
}
/// Native delegates pass the identity captured when their stream was created.
/// Never call an unscoped "stop current" from a delayed native callback.
#[cfg(target_os = "linux")]
pub(crate) fn native_stopped_generation(generation: u64, reason: &str) {
    native_stopped_inner(generation, None, None, reason);
}
pub(crate) fn native_stopped_target(generation: u64, revision: u64, target: &str, reason: &str) {
    native_stopped_inner(generation, Some(revision), Some(target), reason);
}
fn revoke_native(
    r: &mut Resource,
    generation: u64,
    revision: Option<u64>,
    target: Option<&str>,
    reason: &str,
) -> Option<u64> {
    if r.admission.snapshot.generation != generation
        || !active(r)
        || revision.is_some_and(|revision| r.admission.snapshot.target_revision != revision)
        || target.is_some_and(|target| r.admission.snapshot.target.as_deref() != Some(target))
    {
        return None;
    }
    Some(revoke(r, reason))
}
fn native_stopped_inner(
    generation: u64,
    revision: Option<u64>,
    target: Option<&str>,
    reason: &str,
) {
    let ticket = locked()
        .ok()
        .and_then(|mut r| revoke_native(&mut r, generation, revision, target, reason));
    if let Some(ticket) = ticket {
        cleanup_async(ticket);
    }
}
pub(crate) fn capture_allowed() -> Result<(), String> {
    check_context(&*locked()?)
}
pub(crate) fn record_background_observation(
    scope: &ObservationScope,
    evidence: openbitfun_agent_tools::computer_use_control::BackgroundObservation,
) {
    if let Ok(mut r) = locked() {
        if active(&r) && ObservationScope::from_control(&r.admission.snapshot) == *scope {
            r.admission.snapshot.background_observation = Some(evidence);
        }
    }
}
pub(crate) fn input_allowed() -> Result<(), String> {
    let r = locked()?;
    check_context(&r)?;
    r.admission
        .check_input(TOKEN.get().unwrap_or_else(|| token_for(&r)))
}
pub(crate) fn foreground_allowed() -> Result<(), String> {
    input_allowed()?;
    let r = locked()?;
    if r.admission.snapshot.mode != ControlMode::Foreground {
        return Err(admission::foreground_required(
            r.admission.snapshot.action.as_deref(),
        ));
    }
    Ok(())
}
pub(crate) fn bind_target(target: String) -> Result<(), String> {
    let mut r = locked()?;
    check_context(&r)?;
    let changed = r.admission.bind(target)?;
    if changed {
        SCOPE_CHANGED.notify_waiters();
        r.preview = None;
    }
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
    if r.admission.snapshot.target.as_deref() != Some(target) {
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
        if check_context(&r).is_err() || !r.admission.busy {
            return;
        }
        let occurred_at_ms = std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .unwrap_or_default()
            .as_millis() as u64;
        let sequence = r
            .admission
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
            r.admission
                .snapshot
                .pointer
                .as_ref()
                .and_then(|p| p.last_click.clone())
        };
        r.admission.snapshot.pointer = Some(ControlPointer {
            x,
            y,
            click,
            sequence,
            occurred_at_ms,
            last_click,
        });
        r.admission.snapshot.target.clone()
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
pub(crate) fn acquire(
    owner: &str,
    action: &str,
) -> Result<Box<dyn ComputerUseActionLease>, String> {
    let token = locked()?.admission.admit(owner, action, executor())?;
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
impl Drop for Lease {
    fn drop(&mut self) {
        let ticket = locked().ok().and_then(|mut r| {
            let ticket = r.admission.release(self.token, self.complete);
            if ticket.is_some() {
                r.preview = None;
                SCOPE_CHANGED.notify_waiters();
            }
            ticket
        });
        if let Some(ticket) = ticket {
            cleanup_async(ticket);
        }
    }
}
fn stop_native(ticket: u64) -> Result<(), String> {
    // A cancelled Start and Stop can both enqueue cleanup. Serialize native
    // teardown and recheck the ticket after waiting, so delayed old cleanup
    // cannot stop resources created by a later successful Start.
    let _cleanup = NATIVE_CLEANUP
        .lock()
        .map_err(|_| "[CONTROL_FAILED] Native cleanup lock poisoned".to_string())?;
    if !locked()?.admission.owns_cleanup(ticket) {
        return Ok(());
    }
    #[cfg(target_os = "macos")]
    {
        super::macos_bg_input::release_held_inputs();
        super::macos_capture::stop_capture();
        super::macos_ax_dump::clear_observations();
        super::macos_input_focus::stop();
        super::macos_capture::hide_pointer();
    }
    #[cfg(target_os = "windows")]
    {
        super::windows_wgc_capture::stop_capture();
        super::windows_ax_ui::clear_observations();
        super::windows_pointer_feedback::hide_pointer();
    }
    #[cfg(target_os = "linux")]
    {
        super::linux_control::stop_session();
        super::linux_control_ax::clear_observations();
    }
    Ok(())
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
    pub target_revision: u64,
}

/// Capture callers pass the identity saved before native work, never retag a
/// late frame with snapshot() after a new task has acquired the device.
pub(crate) fn publish_rgba(
    scope: &ObservationScope,
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
        publish_jpeg(scope, &jpeg, [image.width(), image.height()], bounds);
    }
}
pub(crate) fn publish_jpeg(
    scope: &ObservationScope,
    bytes: &[u8],
    dimensions: [u32; 2],
    bounds: [f64; 4],
) {
    use base64::Engine;
    if bounds.iter().any(|v| !v.is_finite()) || bounds[2] <= 0.0 || bounds[3] <= 0.0 {
        return;
    }
    let Some(target) = scope.target.as_ref() else {
        return;
    };
    if dimensions.contains(&0) {
        return;
    }
    let frame = ControlPreview {
        target: target.clone(),
        image_base64: base64::engine::general_purpose::STANDARD.encode(bytes),
        mime_type: "image/jpeg",
        width: dimensions[0],
        height: dimensions[1],
        origin_x: bounds[0],
        origin_y: bounds[1],
        span_width: bounds[2],
        span_height: bounds[3],
        generation: scope.generation,
        target_revision: scope.target_revision,
    };
    if let Ok(mut r) = locked() {
        if check_context(&r).is_ok()
            && ObservationScope::from_control(&r.admission.snapshot) == *scope
        {
            r.preview = Some(frame);
        }
    }
}
pub(crate) fn preview(generation: u64) -> Result<Option<ControlPreview>, String> {
    let r = locked()?;
    if r.admission.snapshot.generation != generation || !active(&r) {
        return Err("[CONTROL_STALE] Control session changed".into());
    }
    Ok(r.preview
        .as_ref()
        .filter(|p| {
            p.generation == generation && p.target_revision == r.admission.snapshot.target_revision
        })
        .cloned())
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn old_native_stream_cannot_stop_a_return_to_the_same_window() {
        let mut r = Resource::default();
        let generation = r
            .admission
            .begin_start("a", ControlMode::Background)
            .unwrap();
        r.admission.finish_start(generation).unwrap();
        r.admission.bind("window:a".into()).unwrap();
        r.admission.bind("window:b".into()).unwrap();
        r.admission.bind("window:a".into()).unwrap();
        assert!(
            revoke_native(&mut r, generation, Some(1), Some("window:a"), "late close").is_none()
        );
        assert!(active(&r));
        assert!(revoke_native(
            &mut r,
            generation,
            Some(3),
            Some("window:a"),
            "current close"
        )
        .is_some());
    }
    #[test]
    fn native_stop_from_old_stream_cannot_revoke_retargeted_window() {
        let mut r = Resource::default();
        let generation = r
            .admission
            .begin_start("a", ControlMode::Background)
            .unwrap();
        r.admission.finish_start(generation).unwrap();
        r.admission.bind("window:new".into()).unwrap();
        assert!(revoke_native(&mut r, generation, Some(1), Some("window:old"), "closed").is_none());
        assert!(active(&r));
        let ticket =
            revoke_native(&mut r, generation, Some(1), Some("window:new"), "closed").unwrap();
        assert!(!active(&r));
        finish_cleanup(&mut r, ticket);
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
