//! Ubuntu/GNOME and other portal desktops: one consented capture/input session.
//!
//! Portal input controls the compositor seat, not an isolated background app.
//! Never fall back to XTest/enigo when this session fails or is revoked.

use super::linux_native::{self, Pipeline};
use atspi::zbus::{
    self,
    zvariant::{OwnedFd, OwnedObjectPath, OwnedValue, Value},
};
use futures::StreamExt;
use std::{
    collections::{HashMap, HashSet},
    os::fd::AsRawFd,
    sync::{
        atomic::{AtomicBool, AtomicU64, Ordering},
        Arc,
    },
    time::Duration,
};

type Options<'a> = HashMap<&'a str, Value<'a>>;
type Results = HashMap<String, OwnedValue>;
const DESTINATION: &str = "org.freedesktop.portal.Desktop";
const PATH: &str = "/org/freedesktop/portal/desktop";
const REMOTE: &str = "org.freedesktop.portal.RemoteDesktop";
const SCREEN: &str = "org.freedesktop.portal.ScreenCast";
static TOKEN: AtomicU64 = AtomicU64::new(1);

#[path = "linux_control_policy.rs"]
mod policy;
pub(super) use policy::button_code;
use policy::{character_keysym, classify_display, key_keysym, DisplaySession};

pub(super) fn display_session() -> DisplaySession {
    classify_display(
        std::env::var("XDG_SESSION_TYPE").ok().as_deref(),
        std::env::var("WAYLAND_DISPLAY").ok().as_deref(),
        std::env::var("DISPLAY").ok().as_deref(),
    )
}

pub(super) fn require_legacy_x11() -> Result<(), String> {
    match display_session() {
        DisplaySession::X11 => Ok(()),
        DisplaySession::Wayland => Err("[PORTAL_SESSION_REQUIRED] Wayland requires a user-authorized portal control session; XWayland DISPLAY is not permission to control the desktop.".into()),
        DisplaySession::Unavailable => Err("[GUI_UNAVAILABLE] No interactive Linux desktop session is available on this execution host.".into()),
    }
}

async fn proxy<'a>(
    connection: &'a zbus::Connection,
    interface: &'a str,
) -> Result<zbus::Proxy<'a>, String> {
    zbus::Proxy::new(connection, DESTINATION, PATH, interface)
        .await
        .map_err(|e| format!("[PORTAL_UNAVAILABLE] {e}"))
}

fn token() -> String {
    format!(
        "openbitfun_{}_{}",
        std::process::id(),
        TOKEN.fetch_add(1, Ordering::Relaxed)
    )
}

/// Subscribe before making a portal request: a fast Response must not be lost.
async fn request<B>(
    connection: &zbus::Connection,
    interface: &str,
    method: &str,
    request_token: &str,
    body: &B,
) -> Result<Results, String>
where
    B: serde::Serialize + zbus::zvariant::DynamicType,
{
    let sender = connection
        .unique_name()
        .ok_or("[PORTAL_UNAVAILABLE] D-Bus connection has no unique name")?
        .as_str()
        .trim_start_matches(':')
        .replace('.', "_");
    let path = format!("/org/freedesktop/portal/desktop/request/{sender}/{request_token}");
    let request = zbus::Proxy::new(
        connection,
        DESTINATION,
        path.as_str(),
        "org.freedesktop.portal.Request",
    )
    .await
    .map_err(|e| e.to_string())?;
    let mut responses = request
        .receive_signal("Response")
        .await
        .map_err(|e| e.to_string())?;
    let returned: OwnedObjectPath = proxy(connection, interface)
        .await?
        .call(method, body)
        .await
        .map_err(|e| format!("[PORTAL_REQUEST_FAILED] {method}: {e}"))?;
    if returned.as_str() != path {
        let legacy = zbus::Proxy::new(
            connection,
            DESTINATION,
            returned,
            "org.freedesktop.portal.Request",
        )
        .await
        .map_err(|e| e.to_string())?;
        let _: Result<(), _> = legacy.call("Close", &()).await;
        return Err(
            "[PORTAL_INCOMPATIBLE] Portal does not support predictable request handles.".into(),
        );
    }
    let signal = match tokio::time::timeout(Duration::from_secs(120), responses.next()).await {
        Ok(Some(signal)) => signal,
        _ => {
            let _: Result<(), _> = request.call("Close", &()).await;
            return Err("[LOCAL_AUTHORIZATION_REQUIRED] Portal authorization timed out or disconnected; approve on the execution host.".into());
        }
    };
    let (code, results): (u32, Results) = signal.body().deserialize().map_err(|e| e.to_string())?;
    match code {
        0 => Ok(results),
        1 => Err("[AUTHORIZATION_CANCELLED] The user cancelled portal authorization.".into()),
        _ => Err(format!("[PORTAL_REQUEST_FAILED] {method} response {code}")),
    }
}

pub(super) struct LinuxControlSession {
    connection: zbus::Connection,
    runtime: tokio::runtime::Handle,
    path: OwnedObjectPath,
    active: Arc<AtomicBool>,
    closed_monitor: tokio::task::JoinHandle<()>,
    pipeline: Pipeline,
    // Keep the authorized remote open for the complete pipeline lifetime.
    _pipewire_remote: OwnedFd,
    stream_id: u32,
    logical_size: Option<(i32, i32)>,
    input_devices: u32,
    generation: u64,
    frame_size: AtomicU64,
    input_lock: tokio::sync::Mutex<PressedInputs>,
}

#[derive(Default)]
struct PressedInputs {
    buttons: HashSet<i32>,
    keys: HashSet<i32>,
    keysyms: HashSet<i32>,
}

impl LinuxControlSession {
    /// User picks exactly one surface. Input, when requested, is foreground seat input.
    pub(super) async fn start(parent_window: &str, allow_input: bool) -> Result<Self, String> {
        let runtime = tokio::runtime::Handle::try_current()
            .map_err(|e| format!("[CONTROL_UNAVAILABLE] Async runtime unavailable: {e}"))?;
        let generation = super::control_session::snapshot().generation;
        if display_session() == DisplaySession::Unavailable {
            return Err("[GUI_UNAVAILABLE] No interactive desktop on this host.".into());
        }
        linux_native::init_capture()?;
        let connection = zbus::Connection::session()
            .await
            .map_err(|e| format!("[PORTAL_UNAVAILABLE] Session D-Bus: {e}"))?;
        let interface = if allow_input { REMOTE } else { SCREEN };
        let handle = token();
        let session_token = token();
        let options = Options::from([
            ("handle_token", Value::from(handle.as_str())),
            ("session_handle_token", Value::from(session_token.as_str())),
        ]);
        let mut result = request(
            &connection,
            interface,
            "CreateSession",
            &handle,
            &(options,),
        )
        .await?;
        let path = result
            .remove("session_handle")
            .ok_or("[PORTAL_INVALID_RESPONSE] Missing session handle")?;
        let path = String::try_from(path).map_err(|e| e.to_string())?;
        let path = OwnedObjectPath::try_from(path).map_err(|e| e.to_string())?;
        let session_proxy = zbus::Proxy::new_owned(
            connection.clone(),
            DESTINATION.to_string(),
            path.clone(),
            "org.freedesktop.portal.Session".to_string(),
        )
        .await
        .map_err(|e| e.to_string())?;
        let mut closed = session_proxy
            .receive_signal("Closed")
            .await
            .map_err(|e| e.to_string())?;
        let setup = Self::configure(&connection, &path, parent_window, allow_input).await;
        let (stream_id, logical_size, input_devices, fd, pipeline) = match setup {
            Ok(value) => value,
            Err(error) => {
                close_session(&connection, &path).await;
                return Err(error);
            }
        };
        let active = Arc::new(AtomicBool::new(true));
        let monitor_active = active.clone();
        let monitor_pipeline = pipeline.clone();
        let monitor_connection = connection.clone();
        let monitor_path = path.clone();
        let bus_pipeline = pipeline.clone();
        let closed_monitor = tokio::spawn(async move {
            let reason = tokio::select! {
                _ = closed.next() => "Linux portal sharing stopped or disconnected",
                _ = bus_pipeline.ended() => "Linux PipeWire capture ended or failed",
            };
            if monitor_active.swap(false, Ordering::AcqRel) {
                super::control_session::native_stopped_generation(generation, reason);
                let _ = monitor_pipeline.stop();
                close_session(&monitor_connection, &monitor_path).await;
            }
        });
        Ok(Self {
            connection,
            runtime,
            path,
            active,
            closed_monitor,
            pipeline,
            _pipewire_remote: fd,
            stream_id,
            logical_size,
            input_devices,
            generation,
            frame_size: AtomicU64::new(0),
            input_lock: tokio::sync::Mutex::new(PressedInputs::default()),
        })
    }

    async fn configure(
        connection: &zbus::Connection,
        path: &OwnedObjectPath,
        parent_window: &str,
        allow_input: bool,
    ) -> Result<(u32, Option<(i32, i32)>, u32, OwnedFd, Pipeline), String> {
        if allow_input {
            let handle = token();
            let options = Options::from([
                ("handle_token", Value::from(handle.as_str())),
                ("types", Value::from(3u32)),
            ]);
            request(
                connection,
                REMOTE,
                "SelectDevices",
                &handle,
                &(path, options),
            )
            .await?;
        }
        let screen = proxy(connection, SCREEN).await?;
        let source_types: u32 = screen
            .get_property("AvailableSourceTypes")
            .await
            .map_err(|e| format!("[PORTAL_UNAVAILABLE] {e}"))?;
        if source_types & 3 == 0 {
            return Err(
                "[CAPTURE_UNAVAILABLE] Portal offers neither window nor monitor capture.".into(),
            );
        }
        let cursor_modes: u32 = screen
            .get_property("AvailableCursorModes")
            .await
            .unwrap_or(1);
        let handle = token();
        let options = Options::from([
            ("handle_token", Value::from(handle.as_str())),
            ("types", Value::from(source_types & 3)), // window or monitor, selected by user
            ("multiple", Value::from(false)),
            (
                "cursor_mode",
                Value::from(if cursor_modes & 1 != 0 {
                    1u32
                } else if cursor_modes & 4 != 0 {
                    4u32
                } else {
                    2u32
                }),
            ),
        ]);
        request(
            connection,
            SCREEN,
            "SelectSources",
            &handle,
            &(path, options),
        )
        .await?;
        let handle = token();
        let options = Options::from([("handle_token", Value::from(handle.as_str()))]);
        let mut result = request(
            connection,
            if allow_input { REMOTE } else { SCREEN },
            "Start",
            &handle,
            &(path, parent_window, options),
        )
        .await?;
        let input_devices = result
            .remove("devices")
            .map(u32::try_from)
            .transpose()
            .map_err(|e| e.to_string())?
            .unwrap_or(0);
        if allow_input && input_devices & 3 != 3 {
            return Err(
                "[PERMISSION_DENIED] Portal did not grant both pointer and keyboard control."
                    .into(),
            );
        }
        let streams: Vec<(u32, Results)> = result
            .remove("streams")
            .ok_or("[PORTAL_INVALID_RESPONSE] No capture streams")?
            .try_into()
            .map_err(|e: zbus::zvariant::Error| e.to_string())?;
        if streams.len() != 1 {
            return Err(
                "[PORTAL_INVALID_RESPONSE] Expected exactly one authorized capture surface.".into(),
            );
        }
        let (stream_id, mut properties) = streams.into_iter().next().unwrap();
        let serial = properties
            .remove("pipewire-serial")
            .map(u64::try_from)
            .transpose()
            .map_err(|e| format!("[PORTAL_INVALID_RESPONSE] {e}"))?;
        let logical_size = properties
            .remove("logical_size")
            .or_else(|| properties.remove("size"))
            .and_then(|v| <(i32, i32)>::try_from(v).ok());
        let fd: OwnedFd = screen
            .call("OpenPipeWireRemote", &(path, Options::new()))
            .await
            .map_err(|e| format!("[CAPTURE_UNAVAILABLE] PipeWire remote: {e}"))?;
        let pipeline = Pipeline::start(&format!("pipewiresrc name=portal fd={} path={} do-timestamp=true ! videoconvert ! jpegenc ! appsink name=frames max-buffers=1 drop=true sync=false", fd.as_raw_fd(), stream_id), serial)?;
        Ok((stream_id, logical_size, input_devices, fd, pipeline))
    }

    pub(super) fn generation(&self) -> u64 {
        self.generation
    }

    pub(super) fn target_identity(&self) -> String {
        format!("portal:{}:{}", self.path.as_str(), self.stream_id)
    }

    pub(super) fn is_active(&self) -> bool {
        self.active.load(Ordering::Acquire)
    }

    fn ensure_active(&self, device: u32) -> Result<(), String> {
        if !self.active.load(Ordering::Acquire) {
            return Err("[CONTROL_SESSION_STOPPED] Portal session is no longer active.".into());
        }
        validate_portal_scope(self.generation, &self.target_identity())?;
        if device != 0 {
            super::control_session::foreground_allowed()?;
        }
        if self.input_devices & device != device {
            return Err(
                "[PERMISSION_DENIED] This session does not authorize the requested input device."
                    .into(),
            );
        }
        Ok(())
    }

    /// Returns a JPEG frame from the authorized PipeWire remote only.
    pub(super) async fn capture(&self) -> Result<Vec<u8>, String> {
        self.ensure_active(0)?;
        let sink = self.pipeline.clone();
        let bytes = super::control_session::spawn_blocking(move || {
            let sample = match sink.pull(Duration::from_millis(100))? {
                Some(frame) => frame,
                None => match sink.last()? {
                    Some(frame) => frame,
                    None => sink
                        .pull(Duration::from_secs(5))?
                        .ok_or("[CAPTURE_UNAVAILABLE] No PipeWire frame within five seconds")?,
                },
            };
            let dimensions = sample.dimensions();
            Ok::<_, String>((sample.bytes, dimensions))
        })
        .await
        .map_err(|e| e.to_string())??;
        self.ensure_active(0)?;
        let (bytes, dimensions) = bytes;
        let previous = self.frame_size.swap(dimensions, Ordering::AcqRel);
        if previous != 0 && previous != dimensions {
            self.active.store(false, Ordering::Release);
            super::control_session::native_stopped_generation(
                self.generation,
                "Portal stream geometry changed; select the surface again",
            );
            let _ = self.stop().await;
            return Err("[GEOMETRY_CHANGED] Portal stream resized; restart control to establish current logical coordinates.".into());
        }
        Ok(bytes)
    }

    /// Wait until the authorized stream stops changing after input. Some
    /// compositors resend identical frames, so only differing content counts
    /// as a repaint. The newest sample stays available for the next capture.
    pub(super) async fn wait_settled(
        &self,
        policy: openbitfun_agent_tools::computer_use_host::AppInputSettlePolicy,
    ) -> Result<openbitfun_agent_tools::computer_use_host::AppInputSettle, String> {
        use openbitfun_agent_tools::computer_use_host::{
            app_input_settle_decision, app_input_settle_next_wait_ms, AppInputSettle,
            AppInputSettleStatus,
        };
        self.ensure_active(0)?;
        let sink = self.pipeline.clone();
        let active = self.active.clone();
        super::control_session::spawn_blocking(move || {
            let digest = |sample: &linux_native::Frame| {
                use std::hash::{Hash, Hasher};
                let mut hasher = std::collections::hash_map::DefaultHasher::new();
                sample.bytes.hash(&mut hasher);
                hasher.finish()
            };
            let mut previous = match sink.last() {
                Ok(frame) => frame.map(|frame| digest(&frame)),
                Err(error) => return AppInputSettle::unavailable(error),
            };
            let started = std::time::Instant::now();
            let mut last_change = None;
            let mut wait_ms = 0;
            loop {
                if let Err(reason) = super::control_session::capture_allowed() {
                    return AppInputSettle {
                        status: AppInputSettleStatus::Interrupted,
                        waited_ms: started.elapsed().as_millis() as u64,
                        changed: None,
                        reason: Some(reason),
                    };
                }
                if !active.load(Ordering::Acquire) {
                    return AppInputSettle {
                        status: AppInputSettleStatus::Interrupted,
                        waited_ms: started.elapsed().as_millis() as u64,
                        changed: None,
                        reason: Some("Portal session ended".into()),
                    };
                }
                let sample = match sink.pull(Duration::from_millis(u64::from(wait_ms))) {
                    Ok(sample) => sample,
                    Err(error) => return AppInputSettle::unavailable(error),
                };
                if let Some(sample) = sample {
                    let current = digest(&sample);
                    if previous != Some(current) {
                        previous = Some(current);
                        last_change = Some(started.elapsed().as_millis() as u64);
                    }
                }
                let elapsed = started.elapsed().as_millis() as u64;
                if let Some(status) = app_input_settle_decision(policy, elapsed, last_change) {
                    return AppInputSettle {
                        status,
                        waited_ms: elapsed,
                        changed: Some(last_change.is_some()),
                        reason: None,
                    };
                }
                wait_ms = app_input_settle_next_wait_ms(policy, elapsed, last_change);
            }
        })
        .await
        .map_err(|e| e.to_string())
    }

    pub(super) async fn move_pointer(&self, x: f64, y: f64) -> Result<(), String> {
        let _input = self.input_lock.lock().await;
        self.ensure_active(2)?;
        if self.frame_size.load(Ordering::Acquire) == 0 {
            return Err("[FRESH_OBSERVATION_REQUIRED] Capture the authorized portal surface before absolute input.".into());
        }
        if let Some(sample) = self.pipeline.last()? {
            if sample.dimensions() != self.frame_size.load(Ordering::Acquire) {
                self.active.store(false, Ordering::Release);
                super::control_session::native_stopped_generation(
                    self.generation,
                    "Portal stream geometry changed before input",
                );
                return Err("[GEOMETRY_CHANGED] Portal stream resized after the observed frame; restart control.".into());
            }
        }
        if !x.is_finite() || !y.is_finite() || x < 0.0 || y < 0.0 {
            return Err(
                "[INVALID_COORDINATES] Expected finite non-negative stream coordinates.".into(),
            );
        }
        let (width, height) = self.logical_size.ok_or("[COORDINATES_UNAVAILABLE] Portal omitted logical stream geometry; absolute input is disabled.")?;
        if x >= f64::from(width) || y >= f64::from(height) {
            return Err("[INVALID_COORDINATES] Point is outside the authorized stream.".into());
        }
        proxy(&self.connection, REMOTE)
            .await?
            .call::<_, _, ()>(
                "NotifyPointerMotionAbsolute",
                &(&self.path, Options::new(), self.stream_id, x, y),
            )
            .await
            .map_err(|e| format!("[INPUT_FAILED] {e}"))
    }

    /// Linux evdev button codes: BTN_LEFT=272, BTN_RIGHT=273, BTN_MIDDLE=274.
    pub(super) async fn button(&self, button: i32, pressed: bool) -> Result<(), String> {
        let mut input = self.input_lock.lock().await;
        self.ensure_active(2)?;
        if !(272..=279).contains(&button) {
            return Err("[INVALID_BUTTON] Unsupported evdev pointer button.".into());
        }
        // Track before sending: an ambiguous D-Bus failure may still have reached the compositor.
        if pressed {
            input.buttons.insert(button);
        }
        proxy(&self.connection, REMOTE)
            .await?
            .call::<_, _, ()>(
                "NotifyPointerButton",
                &(&self.path, Options::new(), button, u32::from(pressed)),
            )
            .await
            .map_err(|e| format!("[INPUT_FAILED] {e}"))?;
        if !pressed {
            input.buttons.remove(&button);
        }
        Ok(())
    }

    /// Linux evdev keycodes, not X11 keycodes (which include an offset).
    pub(super) async fn keycode(&self, key: i32, pressed: bool) -> Result<(), String> {
        let mut input = self.input_lock.lock().await;
        self.ensure_active(1)?;
        if !(1..=0x2ff).contains(&key) {
            return Err("[INVALID_KEYCODE] Expected Linux evdev keycode.".into());
        }
        if pressed {
            input.keys.insert(key);
        }
        proxy(&self.connection, REMOTE)
            .await?
            .call::<_, _, ()>(
                "NotifyKeyboardKeycode",
                &(&self.path, Options::new(), key, u32::from(pressed)),
            )
            .await
            .map_err(|e| format!("[INPUT_FAILED] {e}"))?;
        if !pressed {
            input.keys.remove(&key);
        }
        Ok(())
    }

    /// XKB keysyms support Unicode text without using a controller-side clipboard.
    pub(super) async fn keysym(&self, symbol: i32, pressed: bool) -> Result<(), String> {
        let mut input = self.input_lock.lock().await;
        self.ensure_active(1)?;
        if symbol <= 0 {
            return Err("[INVALID_KEYSYM] Expected a positive XKB keysym.".into());
        }
        if pressed {
            input.keysyms.insert(symbol);
        }
        proxy(&self.connection, REMOTE)
            .await?
            .call::<_, _, ()>(
                "NotifyKeyboardKeysym",
                &(&self.path, Options::new(), symbol, u32::from(pressed)),
            )
            .await
            .map_err(|e| format!("[INPUT_FAILED] {e}"))?;
        if !pressed {
            input.keysyms.remove(&symbol);
        }
        Ok(())
    }

    pub(super) fn logical_size(&self) -> Option<(i32, i32)> {
        self.logical_size
    }

    pub(super) async fn scroll(&self, dx: f64, dy: f64) -> Result<(), String> {
        let _input = self.input_lock.lock().await;
        self.ensure_active(2)?;
        if !dx.is_finite() || !dy.is_finite() {
            return Err("[INVALID_SCROLL] Expected finite scroll deltas.".into());
        }
        if dx.fract() != 0.0
            || dy.fract() != 0.0
            || dx < i32::MIN as f64
            || dx > i32::MAX as f64
            || dy < i32::MIN as f64
            || dy > i32::MAX as f64
        {
            return Err("[INVALID_SCROLL] Expected integer wheel steps.".into());
        }
        let remote = proxy(&self.connection, REMOTE).await?;
        for (axis, steps) in [(1u32, dx as i32), (0u32, dy as i32)] {
            if steps != 0 {
                self.ensure_active(2)?;
                remote
                    .call::<_, _, ()>(
                        "NotifyPointerAxisDiscrete",
                        &(&self.path, Options::new(), axis, steps),
                    )
                    .await
                    .map_err(|e| format!("[INPUT_FAILED] {e}"))?;
            }
        }
        Ok(())
    }

    pub(super) async fn stop(&self) -> Result<(), String> {
        self.active.store(false, Ordering::Release);
        let mut input = self.input_lock.lock().await;
        if let Ok(remote) = proxy(&self.connection, REMOTE).await {
            let PressedInputs {
                buttons,
                keys,
                keysyms,
            } = &mut *input;
            for (method, codes) in [
                ("NotifyPointerButton", buttons),
                ("NotifyKeyboardKeycode", keys),
                ("NotifyKeyboardKeysym", keysyms),
            ] {
                for code in codes.drain() {
                    let _: Result<(), _> = remote
                        .call(method, &(&self.path, Options::new(), code, 0u32))
                        .await;
                }
            }
        }
        let capture_result = self
            .pipeline
            .stop()
            .map_err(|e| format!("[CAPTURE_STOP_FAILED] {e}"));
        close_session(&self.connection, &self.path).await;
        self.closed_monitor.abort();
        capture_result.map(|_| ())
    }
}

async fn close_session(connection: &zbus::Connection, path: &OwnedObjectPath) {
    if let Ok(session) = zbus::Proxy::new(
        connection,
        DESTINATION,
        path,
        "org.freedesktop.portal.Session",
    )
    .await
    {
        let _: Result<(), _> = session.call("Close", &()).await;
    }
}

impl Drop for LinuxControlSession {
    fn drop(&mut self) {
        self.active.store(false, Ordering::Release);
        self.closed_monitor.abort();
        let _ = self.pipeline.stop();
        let connection = self.connection.clone();
        let path = self.path.clone();
        self.runtime.spawn(async move {
            close_session(&connection, &path).await;
        });
        // When no runtime survives, dropping the owned D-Bus connection also revokes the session.
    }
}

static SESSION: std::sync::Mutex<Option<Arc<LinuxControlSession>>> = std::sync::Mutex::new(None);
static SESSION_REQUIRED: AtomicBool = AtomicBool::new(false);
static SESSION_EPOCH: AtomicU64 = AtomicU64::new(0);
static CLEANUP_TASKS: std::sync::Mutex<Vec<tokio::task::JoinHandle<()>>> =
    std::sync::Mutex::new(Vec::new());

/// Only one compositor seat controller may be active on this host.
fn validate_portal_scope(generation: u64, target: &str) -> Result<(), String> {
    super::control_session::capture_allowed()?;
    if super::control_session::snapshot().generation != generation {
        return Err(
            "[CONTROL_STALE] Portal stream belongs to an earlier control generation.".into(),
        );
    }
    super::control_session::target_allowed(target)
}

pub(super) async fn start_session(allow_input: bool) -> Result<(), String> {
    SESSION_REQUIRED.store(true, Ordering::Release);
    let generation = super::control_session::snapshot().generation;
    let authorization_token = super::control_session::capture_token()?;
    stop_session();
    let cleanup = CLEANUP_TASKS
        .lock()
        .map_err(|_| "[CONTROL_UNAVAILABLE] Cleanup lock poisoned")?
        .drain(..)
        .collect::<Vec<_>>();
    for task in cleanup {
        task.await
            .map_err(|e| format!("[CONTROL_CLEANUP_FAILED] {e}"))?;
    }
    let epoch = SESSION_EPOCH.load(Ordering::Acquire);
    let session = Arc::new(LinuxControlSession::start("", allow_input).await?);
    if super::control_session::snapshot().generation != generation
        || super::control_session::capture_allowed().is_err()
    {
        session.stop().await?;
        return Err(
            "[CONTROL_SESSION_STOPPED] Control was stopped while portal authorization was pending."
                .into(),
        );
    }
    let mut slot = SESSION
        .lock()
        .map_err(|_| "[CONTROL_UNAVAILABLE] Session lock poisoned")?;
    if SESSION_EPOCH.load(Ordering::Acquire) != epoch {
        return Err(
            "[CONTROL_SESSION_STOPPED] Portal authorization was superseded or cancelled.".into(),
        );
    }
    if slot.is_some() {
        return Err("[CONTROL_BUSY] A portal session is already active.".into());
    }
    if !session.is_active() {
        return Err("[CONTROL_SESSION_STOPPED] Portal closed during startup.".into());
    }
    // Bind at the explicit authorization boundary, not lazily during capture
    // or input. A completion from an older generation must never rebind the
    // target of the user's newer control session.
    super::control_session::with_token(authorization_token, || {
        super::control_session::bind_target(session.target_identity())
    })?;
    *slot = Some(session);
    Ok(())
}

/// Revoke synchronously; resource cleanup and key release run asynchronously.
pub(super) fn stop_session() {
    SESSION_EPOCH.fetch_add(1, Ordering::AcqRel);
    let previous = SESSION.lock().ok().and_then(|mut slot| slot.take());
    if let Some(session) = previous {
        session.active.store(false, Ordering::Release);
        let runtime = session.runtime.clone();
        let cleanup = runtime.spawn(async move {
            let _ = session.stop().await;
        });
        if let Ok(mut tasks) = CLEANUP_TASKS.lock() {
            tasks.retain(|task| !task.is_finished());
            tasks.push(cleanup);
        }
    }
}

/// None means an untouched legacy X11 host. A revoked portal never falls back.
pub(super) fn session_is_active() -> bool {
    SESSION
        .lock()
        .ok()
        .is_some_and(|slot| slot.as_ref().is_some_and(|session| session.is_active()))
}

pub(super) fn session_has_input_consent() -> bool {
    SESSION.lock().ok().is_some_and(|slot| {
        slot.as_ref()
            .is_some_and(|session| session.is_active() && session.input_devices & 3 == 3)
    })
}

pub(super) fn session() -> Result<Option<Arc<LinuxControlSession>>, String> {
    let current = SESSION
        .lock()
        .map_err(|_| "[CONTROL_UNAVAILABLE] Session lock poisoned")?
        .clone();
    if let Some(session) = current {
        session.ensure_active(0)?;
        Ok(Some(session))
    } else if {
        let owner = super::control_session::snapshot();
        policy::portal_required(
            SESSION_REQUIRED.load(Ordering::Acquire),
            &owner.state,
            owner.owner.is_some(),
        )
    } {
        Err("[CONTROL_SESSION_REQUIRED] Start a new authorized portal session before capture or input.".into())
    } else {
        require_legacy_x11()?;
        Ok(None)
    }
}

impl LinuxControlSession {
    pub(super) async fn move_relative(&self, dx: i32, dy: i32) -> Result<(), String> {
        let _input = self.input_lock.lock().await;
        self.ensure_active(2)?;
        let dimensions = self.frame_size.load(Ordering::Acquire);
        let pixel_width = (dimensions >> 32) as u32;
        let pixel_height = dimensions as u32;
        let (width, height) = self
            .logical_size
            .ok_or("[COORDINATES_UNAVAILABLE] Portal omitted logical geometry")?;
        if pixel_width == 0 || pixel_height == 0 {
            return Err(
                "[FRESH_OBSERVATION_REQUIRED] Capture the portal surface before relative input."
                    .into(),
            );
        }
        let logical_dx = f64::from(dx) * f64::from(width) / f64::from(pixel_width);
        let logical_dy = f64::from(dy) * f64::from(height) / f64::from(pixel_height);
        proxy(&self.connection, REMOTE)
            .await?
            .call::<_, _, ()>(
                "NotifyPointerMotion",
                &(&self.path, Options::new(), logical_dx, logical_dy),
            )
            .await
            .map_err(|e| format!("[INPUT_FAILED] {e}"))
    }

    pub(super) async fn type_text(&self, text: &str) -> Result<(), String> {
        for character in text.chars() {
            let symbol = character_keysym(character);
            self.keysym(symbol, true).await?;
            self.keysym(symbol, false).await?;
        }
        Ok(())
    }

    pub(super) async fn key_chord(&self, keys: &[String]) -> Result<(), String> {
        let symbols = keys
            .iter()
            .map(|key| key_keysym(key))
            .collect::<Result<Vec<_>, _>>()?;
        let mut down = Vec::new();
        let mut result = Ok(());
        for symbol in symbols {
            down.push(symbol);
            if let Err(error) = self.keysym(symbol, true).await {
                result = Err(error);
                break;
            }
        }
        for symbol in down.into_iter().rev() {
            if let Err(error) = self.keysym(symbol, false).await {
                if result.is_ok() {
                    result = Err(error);
                }
            }
        }
        result
    }
}

#[cfg(test)]
mod native_tests {
    use super::*;

    #[test]
    fn portal_scope_does_not_rebind_app_targets_or_accept_stale_authorization() {
        use super::super::control_session as control;
        use openbitfun_agent_tools::computer_use_control::ControlMode;
        let owner = "portal-scope-fixture";
        let initial = control::start(owner, ControlMode::Observe).unwrap();
        let token = control::capture_token().unwrap();
        let portal = "portal:/fixture/session:1";
        control::with_token(token, || control::bind_target(portal.into())).unwrap();
        validate_portal_scope(initial.generation, portal).unwrap();
        control::bind_target("atspi:421".into()).unwrap();
        assert!(validate_portal_scope(initial.generation, portal)
            .unwrap_err()
            .contains("CONTROL_TARGET_CHANGED"));
        assert_eq!(control::snapshot().target.as_deref(), Some("atspi:421"));
        control::stop(Some(owner), "fixture_restart").unwrap();
        let current = control::start(owner, ControlMode::Observe).unwrap();
        control::bind_target("atspi:422".into()).unwrap();
        assert!(current.generation > initial.generation);
        assert!(control::with_token(token, || control::bind_target(portal.into())).is_err());
        assert!(validate_portal_scope(initial.generation, portal)
            .unwrap_err()
            .contains("CONTROL_STALE"));
        assert_eq!(control::snapshot().target.as_deref(), Some("atspi:422"));
        control::stop(Some(owner), "fixture_complete").unwrap();
        assert!(validate_portal_scope(current.generation, "atspi:422").is_err());
    }

    /// Run with scripts/test-linux-computer-use-portal.sh in an Ubuntu desktop.
    #[tokio::test]
    #[ignore = "requires a real desktop portal and interactive consent for the dedicated fixture window"]
    async fn portal_observe_lifecycle() {
        use openbitfun_agent_tools::computer_use_control::ControlMode;
        super::super::control_session::start("native-linux-portal-fixture", ControlMode::Observe)
            .unwrap();
        start_session(false)
            .await
            .expect("approve the OpenBitFun Portal Fixture window in the system picker");
        let session = session().unwrap().expect("active portal session");
        assert_eq!(
            super::super::control_session::snapshot().target.as_deref(),
            Some(session.target_identity().as_str()),
            "authorization must bind the portal target before the first capture"
        );
        super::super::control_session::bind_target("atspi:421".into()).unwrap();
        assert!(session
            .capture()
            .await
            .unwrap_err()
            .contains("CONTROL_TARGET_CHANGED"));
        assert_eq!(
            super::super::control_session::snapshot().target.as_deref(),
            Some("atspi:421"),
            "capture must never overwrite a separately bound application"
        );
        super::super::control_session::bind_target(session.target_identity()).unwrap();
        let jpeg = session.capture().await.expect("PipeWire JPEG frame");
        let image = image::load_from_memory(&jpeg)
            .expect("valid JPEG")
            .to_rgb8();
        assert!(
            image.width() >= 200 && image.height() >= 100,
            "fixture window must be visible and nonempty"
        );
        let fixture_pixels = image
            .pixels()
            .filter(|pixel| {
                pixel[0] < 45
                    && pixel[1] > 120
                    && pixel[1] < 190
                    && pixel[2] > 120
                    && pixel[2] < 190
            })
            .count();
        assert!(
            fixture_pixels > image.width() as usize * image.height() as usize / 3,
            "select only the dedicated teal fixture window"
        );
        assert!(
            session.button(272, true).await.is_err(),
            "observe-only portal cannot inject input"
        );
        std::thread::spawn(stop_session)
            .join()
            .expect("stop from a native thread");
        let cleanup = CLEANUP_TASKS.lock().unwrap().drain(..).collect::<Vec<_>>();
        for task in cleanup {
            task.await.expect("saved runtime completes portal cleanup");
        }
        assert!(!session.is_active());
        assert!(
            session.capture().await.is_err(),
            "capture after stop must fail"
        );
        super::super::control_session::stop(None, "native fixture complete").unwrap();
    }
}
