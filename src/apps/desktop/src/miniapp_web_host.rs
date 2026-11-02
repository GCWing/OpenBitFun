//! Desktop adapter for the platform-agnostic MiniApp Web surface port.
//!
//! The Agent drives a MiniApp through BrowserUse-style actions, but the DOM
//! lives inside the product window: only the Web UI can read the frame, walk the
//! document, and dispatch input events. This adapter therefore owns transport
//! only — request correlation, surface readiness, and timeouts — while the
//! product-domain contract, session registry, target handles, and method
//! whitelist stay in `openbitfun_core::agentic::tools::miniapp_surface`.
//!
//! It never lets the Agent reach host paths, Tauri commands, or arbitrary
//! JavaScript: only the whitelisted surface methods cross this boundary.

use std::collections::HashMap;
use std::sync::atomic::{AtomicBool, AtomicU64, Ordering};
use std::sync::{Mutex, OnceLock};
use std::time::Duration;

use openbitfun_core::agentic::tools::miniapp_surface::{
    set_miniapp_web_host, MiniAppWebCommand, MiniAppWebHost, MiniAppWebOpenRequest,
};
use openbitfun_core::infrastructure::events::{emit_global_event, BackendEvent};
use openbitfun_core::miniapp::try_get_global_miniapp_manager;
use openbitfun_product_domains::miniapp::web_surface::{
    MiniAppWebAppSummary, MiniAppWebErrorCode, MiniAppWebSurfaceInfo,
    MINIAPP_WEB_BRIDGE_TIMEOUT_MS, MINIAPP_WEB_MAX_APPS, MINIAPP_WEB_MAX_DESCRIPTION_CHARS,
};
use serde::Deserialize;
use serde_json::{json, Value};
use tokio::sync::oneshot;

use crate::miniapp_desktop::{AgentWindow, DesktopMiniApps};

const MINIAPP_WEB_REQUEST_EVENT: &str = "agentic://miniapp-web-request";

/// Opening may have to create a tab, mount the frame, and wait for the first
/// render, so it is the slowest request on this surface.
const OPEN_TIMEOUT: Duration = Duration::from_secs(90);
/// One DOM action against an already-mounted frame.
const EXECUTE_TIMEOUT: Duration = Duration::from_secs(30);
/// A bridge round trip is bounded by the MiniApp, not by us: give it one DOM
/// action plus the contract timeout and slack, so the surface can report
/// `BRIDGE_TIMEOUT` itself instead of losing the race to our transport.
const BRIDGE_TIMEOUT: Duration = EXECUTE_TIMEOUT.saturating_add(Duration::from_millis(
    MINIAPP_WEB_BRIDGE_TIMEOUT_MS + 10_000,
));
/// A launched desktop app has to start its process, resolve this host, and
/// bootstrap before its window can be attached to.
const WINDOW_BOOT_TIMEOUT: Duration = Duration::from_secs(20);
const WINDOW_BOOT_POLL: Duration = Duration::from_millis(150);

type PendingResponse = oneshot::Sender<Result<Value, String>>;

static NEXT_REQUEST_ID: AtomicU64 = AtomicU64::new(1);
static SURFACE_READY: AtomicBool = AtomicBool::new(false);
static PENDING_RESPONSES: OnceLock<Mutex<HashMap<String, PendingResponse>>> = OnceLock::new();

fn pending_responses() -> &'static Mutex<HashMap<String, PendingResponse>> {
    PENDING_RESPONSES.get_or_init(|| Mutex::new(HashMap::new()))
}

fn lock_pending_responses() -> std::sync::MutexGuard<'static, HashMap<String, PendingResponse>> {
    pending_responses()
        .lock()
        .unwrap_or_else(|poisoned| poisoned.into_inner())
}

/// Fail every waiting caller. Used when the surface detaches so a turn never
/// blocks on a listener that is gone.
fn fail_pending(message: &str) {
    let pending = std::mem::take(&mut *lock_pending_responses());
    for (_, sender) in pending {
        let _ = sender.send(Err(message.to_string()));
    }
}

async fn dispatch_surface_request(
    action: &str,
    payload: Value,
    timeout: Duration,
    purpose: &str,
) -> Result<Value, String> {
    if !SURFACE_READY.load(Ordering::Acquire) {
        return Err(format!(
            "{}: the Web UI MiniApp surface listener is not attached",
            MiniAppWebErrorCode::SurfaceUnavailable.as_str()
        ));
    }
    let request_id = format!(
        "miniapp-web-{}-{}",
        std::process::id(),
        NEXT_REQUEST_ID.fetch_add(1, Ordering::Relaxed)
    );
    let expires_at = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|elapsed| elapsed.as_millis() as u64)
        .unwrap_or(u64::MAX)
        .saturating_add(timeout.as_millis() as u64);
    let (sender, receiver) = oneshot::channel();
    lock_pending_responses().insert(request_id.clone(), sender);

    let mut payload = match payload {
        Value::Object(map) => map,
        _ => {
            lock_pending_responses().remove(&request_id);
            return Err(format!(
                "{}: MiniApp surface request payload was not an object",
                MiniAppWebErrorCode::InvalidParams.as_str()
            ));
        }
    };
    payload.insert("requestId".to_string(), Value::String(request_id.clone()));
    payload.insert("action".to_string(), Value::String(action.to_string()));
    payload.insert("expiresAt".to_string(), json!(expires_at));

    if let Err(error) = emit_global_event(BackendEvent::Custom {
        event_name: MINIAPP_WEB_REQUEST_EVENT.to_string(),
        payload: Value::Object(payload),
    })
    .await
    {
        lock_pending_responses().remove(&request_id);
        return Err(format!(
            "{}: failed to deliver the MiniApp surface request: {error}",
            MiniAppWebErrorCode::HostError.as_str()
        ));
    }

    receive_surface_result(&request_id, receiver, timeout, purpose).await
}

async fn receive_surface_result(
    request_id: &str,
    receiver: oneshot::Receiver<Result<Value, String>>,
    timeout: Duration,
    purpose: &str,
) -> Result<Value, String> {
    match tokio::time::timeout(timeout, receiver).await {
        Ok(Ok(result)) => result,
        Ok(Err(_)) => Err(format!(
            "{}: MiniApp surface response channel closed",
            MiniAppWebErrorCode::HostError.as_str()
        )),
        Err(_) => {
            lock_pending_responses().remove(request_id);
            // One slow action does not detach the listener. Readiness follows
            // explicit surface lifecycle reports, so a timeout remains retryable.
            Err(format!(
                "{}: the Web UI MiniApp surface did not {purpose} in time",
                MiniAppWebErrorCode::Timeout.as_str()
            ))
        }
    }
}

/// How one command relates to the app's own window.
///
/// Three answers, because the interesting failure is not "no window": a session
/// that is bound to an instance the window does not own must not quietly drift to
/// another surface, which is what produced an unrelated `SURFACE_UNAVAILABLE`
/// from the tab runtime.
#[derive(Debug, Clone, PartialEq, Eq)]
enum WindowRoute {
    /// The window is the instance this command addresses.
    Serve,
    /// The app is live in its own window, but the command addresses a different
    /// instance: a session from before that window opened, or a retired tab.
    Stale(crate::miniapp_desktop::AgentWindow),
    /// No window can carry this command, so the tab runtime is what remains.
    Absent,
}

fn window_route(
    host: &crate::miniapp_desktop::DesktopMiniApps,
    command: &MiniAppWebCommand,
) -> WindowRoute {
    let Some(window) = host.agent_window(&command.app_id) else {
        return WindowRoute::Absent;
    };
    match command.instance_id.as_deref() {
        // A command without an instance is a fresh session, which can only be
        // talking about the one presentation that exists.
        None => WindowRoute::Serve,
        Some(bound) if bound == window.instance_id => WindowRoute::Serve,
        Some(_) => WindowRoute::Stale(window),
    }
}

/// Answer a surface command through the MiniApp's own window.
///
/// Bridge observation, semantic actions, and host-routed key input travel this
/// way. A window presentation keeps its pixels and DOM to itself, so other
/// actions are refused with the capability gap instead of being sent somewhere
/// that cannot satisfy them. The envelopes are byte-for-byte the ones the tab
/// runtime returns, so the tool above this adapter has one transport contract.
async fn relay_to_window(
    host: &crate::miniapp_desktop::DesktopMiniApps,
    command: &MiniAppWebCommand,
) -> Result<Value, String> {
    match command.method.as_str() {
        "bridge_observe" => {
            let answer = host
                .call_agent_bridge(&command.app_id, "observe", None, BRIDGE_TIMEOUT)
                .await?;
            Ok(json!({
                "state": answer.value.get("state").cloned().unwrap_or(Value::Null),
                "auto": answer.value.get("auto").cloned().unwrap_or(Value::Null),
                "capabilities": answer.capabilities,
                "actions": answer.actions,
            }))
        }
        "bridge_act" => {
            let action = command
                .params
                .as_ref()
                .and_then(|params| params.get("action"))
                .cloned()
                .ok_or_else(|| {
                    format!(
                        "{}: bridge_act requires an action",
                        MiniAppWebErrorCode::InvalidParams.as_str()
                    )
                })?;
            let answer = host
                .call_agent_bridge(&command.app_id, "act", Some(action), BRIDGE_TIMEOUT)
                .await?;
            Ok(json!({
                "result": answer.value,
                "capabilities": answer.capabilities,
                "actions": answer.actions,
            }))
        }
        "key" => {
            let params = command.params.clone().unwrap_or_else(|| json!({}));
            let key = params
                .get("key")
                .and_then(Value::as_str)
                .filter(|value| !value.trim().is_empty())
                .ok_or_else(|| {
                    format!(
                        "{}: key requires a non-empty key",
                        MiniAppWebErrorCode::InvalidParams.as_str()
                    )
                })?;
            let answer = host
                .call_agent_bridge(
                    &command.app_id,
                    "input",
                    Some(json!({
                        "type": "key",
                        "key": key,
                        "modifiers": params.get("modifiers").cloned().unwrap_or_else(|| json!([])),
                        "holdMs": params.get("holdMs").cloned().unwrap_or_else(|| json!(0)),
                    })),
                    BRIDGE_TIMEOUT,
                )
                .await?;
            Ok(json!({
                "result": answer.value,
                "capabilities": answer.capabilities,
                "actions": answer.actions,
            }))
        }
        method => Err(format!(
            "{}: MiniApp {} is running in its own window, which cannot expose DOM structure or pixels, so '{method}' is unavailable there. Its agent bridge (observe_bridge, act_bridge, watch_state) and host-routed key input still work. To use DOM or screenshot actions, move the MiniApp to a tab.",
            MiniAppWebErrorCode::CapabilityMissing.as_str(),
            command.app_id
        )),
    }
}

/// Where an app should appear for this session.
///
/// The two presentations answer different transports, so the choice is made once,
/// up front, and the surface description is derived from it.
enum Presentation {
    /// The app's own window, identified by the instance it registered.
    Window(AgentWindow),
    /// The in-product tab, which the Web UI owns and mounts.
    Tab,
}

/// The Desktop implementation of the MiniApp Web surface port.
///
/// Two presentations can host one app, and they are not interchangeable: a tab
/// lives in the product window and can be read, clicked, and captured, while the
/// app's own installed window is a separate process that can only answer the
/// agent bridge it was compiled with. The adapter therefore picks the transport
/// per request — the window when one is live, otherwise the Web UI — and refuses
/// the actions the chosen transport cannot perform instead of pretending.
struct DesktopMiniAppWebHost {
    app: tauri::AppHandle,
}

impl DesktopMiniAppWebHost {
    fn miniapps(&self) -> Option<tauri::State<'_, DesktopMiniApps>> {
        use tauri::Manager;
        self.app.try_state::<DesktopMiniApps>()
    }

    /// Reject an unknown app before involving the UI, and tell the surface which
    /// runtime profile the app is installed with so it can report capabilities
    /// honestly instead of guessing from the frame alone.
    async fn open_surface(
        &self,
        request: MiniAppWebOpenRequest,
    ) -> Result<MiniAppWebSurfaceInfo, String> {
        let manager = try_get_global_miniapp_manager().ok_or_else(|| {
            format!(
                "{}: the MiniApp manager is not running in this process",
                MiniAppWebErrorCode::SurfaceUnavailable.as_str()
            )
        })?;
        let meta = manager
            .get_meta(&request.app_id)
            .await
            .map_err(|error| format!("{}: {error}", MiniAppWebErrorCode::UnknownApp.as_str()))?;
        let strict_runtime = manager.uses_market_strict_runtime(&request.app_id).await;

        match self.resolve_presentation(&request.app_id).await? {
            Presentation::Window(window) => Ok(MiniAppWebSurfaceInfo::window(
                request.app_id,
                window.instance_id,
                strict_runtime,
            )),
            // `open_tab_surface` above already attempted this path. Keep this
            // branch for a race where another surface mounted the tab between
            // the two checks.
            Presentation::Tab => {
                self.open_tab_surface(&request.app_id, meta.name, strict_runtime)
                    .await
            }
        }
    }

    /// Reuse an existing window, then an existing tab; otherwise launch the
    /// exported desktop app when available, falling back to a new tab.
    async fn resolve_presentation(&self, app_id: &str) -> Result<Presentation, String> {
        // A window the user already has open is theirs: attach to it instead of
        // moving the app somewhere else.
        if let Some(window) = self.miniapps().and_then(|host| host.agent_window(app_id)) {
            return Ok(Presentation::Window(window));
        }

        if self
            .miniapps()
            .is_some_and(|host| host.window_presentation_exists(app_id))
        {
            return Err(format!(
                "{}: MiniApp {} is already open in an independent window, but that Shell does not advertise the Agent bridge; refusing to move it to a tab because unsaved state may be lost. Upgrade/reopen the Shell or use the window's supported controls.",
                MiniAppWebErrorCode::CapabilityMissing.as_str(),
                app_id
            ));
        }

        // A tab is part of the product window, so the app is on screen already.
        // Opening a second copy of it would only split the user's attention.
        if self
            .miniapps()
            .is_some_and(|host| host.tab_presentation(app_id).is_some())
        {
            return Ok(Presentation::Tab);
        }

        // An app the user published to the desktop is opened as that app: the
        // window it launches is the copy they double-click, and it is the one that
        // can report live state to the agent bridge. Failing to launch it is a
        // degradation, not an error — the in-product surface still opens.
        let Some(bundle) = crate::miniapp_desktop::exported_desktop_app(&self.app, app_id).await?
        else {
            return Ok(Presentation::Tab);
        };
        if let Err(error) = crate::miniapp_desktop::launch_desktop_app(&bundle) {
            log::warn!(
                "MiniApp {}: the published desktop app could not be launched ({error}); using the in-product surface",
                app_id
            );
            return Ok(Presentation::Tab);
        }
        match self.wait_for_window(app_id).await {
            Some(window) => Ok(Presentation::Window(window)),
            None => {
                log::warn!(
                    "MiniApp {}: the published desktop app did not register a window in time; using the in-product surface",
                    app_id
                );
                Ok(Presentation::Tab)
            }
        }
    }

    /// Ask the Web UI for the in-product surface and adopt the host-owned facts.
    async fn open_tab_surface(
        &self,
        app_id: &str,
        name: String,
        strict_runtime: bool,
    ) -> Result<MiniAppWebSurfaceInfo, String> {
        let result = dispatch_surface_request(
            "open",
            json!({
                "appId": app_id,
                "name": name,
                "strictRuntime": strict_runtime,
            }),
            OPEN_TIMEOUT,
            "open the MiniApp surface",
        )
        .await?;

        let mut surface: MiniAppWebSurfaceInfo =
            serde_json::from_value(result).map_err(|error| {
                format!(
                    "{}: unreadable surface description: {error}",
                    MiniAppWebErrorCode::HostError.as_str()
                )
            })?;
        // The app id and runtime profile are host facts; never let a surface
        // response retarget the session to another app.
        surface.app_id = app_id.to_string();
        surface.strict_runtime = strict_runtime;
        Ok(surface)
    }

    /// Wait for a launched desktop app to become an attachable window.
    ///
    /// The bundle boots its own process and bootstraps against this host, so the
    /// presentation exists only after that handshake. Nothing is cached here: the
    /// instance the app registers is the one the session must address.
    async fn wait_for_window(&self, app_id: &str) -> Option<AgentWindow> {
        let deadline = tokio::time::Instant::now() + WINDOW_BOOT_TIMEOUT;
        loop {
            if let Some(window) = self.miniapps().and_then(|host| host.agent_window(app_id)) {
                return Some(window);
            }
            if tokio::time::Instant::now() >= deadline {
                return None;
            }
            tokio::time::sleep(WINDOW_BOOT_POLL).await;
        }
    }
}

#[async_trait::async_trait]
impl MiniAppWebHost for DesktopMiniAppWebHost {
    async fn open(&self, request: MiniAppWebOpenRequest) -> Result<MiniAppWebSurfaceInfo, String> {
        self.open_surface(request).await
    }

    async fn execute(&self, command: MiniAppWebCommand) -> Result<Value, String> {
        if let Some(host) = self.miniapps() {
            match window_route(&host, &command) {
                WindowRoute::Serve => return relay_to_window(&host, &command).await,
                // The app is in a window this session never bound to, and the tab
                // runtime never mounted it. Answering there would report a surface
                // that does not exist and hide the real cause, so name the window
                // the caller can reattach to instead.
                WindowRoute::Stale(window) => {
                    return Err(format!(
                        "{}: MiniApp {} is running in its own window as instance {}, but this session is bound to {}. Call open again to attach to that window.",
                        MiniAppWebErrorCode::SurfaceUnavailable.as_str(),
                        command.app_id,
                        window.instance_id,
                        command.instance_id.as_deref().unwrap_or("another instance"),
                    ));
                }
                WindowRoute::Absent => {}
            }
        }
        let timeout = if command.method.starts_with("bridge_") {
            BRIDGE_TIMEOUT
        } else {
            EXECUTE_TIMEOUT
        };
        dispatch_surface_request(
            "execute",
            json!({ "command": command }),
            timeout,
            "complete the MiniApp surface action",
        )
        .await
    }

    /// Discovery reads installed metadata only: no UI round trip, no host paths.
    /// A failure stays a failure, because an empty list would tell the Agent that
    /// nothing is installed.
    async fn list_apps(&self) -> Result<Vec<MiniAppWebAppSummary>, String> {
        let manager = try_get_global_miniapp_manager().ok_or_else(|| {
            format!(
                "{}: the MiniApp manager is not running in this process",
                MiniAppWebErrorCode::SurfaceUnavailable.as_str()
            )
        })?;
        let metas = manager
            .list()
            .await
            .map_err(|error| format!("{}: {error}", MiniAppWebErrorCode::HostError.as_str()))?;
        let mut apps = metas
            .into_iter()
            .map(|meta| {
                let strict_runtime = matches!(
                    meta.runtime_profile,
                    openbitfun_product_domains::miniapp::types::MiniAppRuntimeProfile::MarketStrict
                );
                MiniAppWebAppSummary {
                    app_id: meta.id,
                    name: meta.name,
                    description: meta
                        .description
                        .chars()
                        .take(MINIAPP_WEB_MAX_DESCRIPTION_CHARS)
                        .collect(),
                    version: meta.version,
                    updated_at: meta.updated_at,
                    strict_runtime,
                }
            })
            .collect::<Vec<_>>();
        // Most recently updated first: the app the user was just working on is
        // the one they usually name.
        apps.sort_by(|a, b| {
            b.updated_at
                .cmp(&a.updated_at)
                .then_with(|| a.name.cmp(&b.name))
        });
        apps.truncate(MINIAPP_WEB_MAX_APPS);
        Ok(apps)
    }
}

/// Install the Desktop surface host. Safe to call once during native setup.
///
/// The host keeps the app handle only to reach the MiniApp window registry: a
/// MiniApp the user opened from its installed shortcut is presented by another
/// process, and that registry is the one place that knows it exists.
pub(crate) fn install(app: tauri::AppHandle) {
    set_miniapp_web_host(std::sync::Arc::new(DesktopMiniAppWebHost { app }));
}

#[derive(Debug, Default, Deserialize)]
#[serde(default, rename_all = "camelCase")]
pub(crate) struct MiniAppWebSurfaceReadyRequest {
    ready: bool,
}

/// Attach or detach the Web UI MiniApp surface listener.
#[tauri::command]
pub(crate) fn mark_miniapp_web_surface_ready(request: Option<MiniAppWebSurfaceReadyRequest>) {
    let ready = request.map(|request| request.ready).unwrap_or(false);
    SURFACE_READY.store(ready, Ordering::Release);
    if !ready {
        fail_pending(&format!(
            "{}: the Web UI MiniApp surface detached",
            MiniAppWebErrorCode::SurfaceUnavailable.as_str()
        ));
    }
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct ReportMiniAppWebResultRequest {
    request_id: String,
    success: bool,
    #[serde(default)]
    result: Option<Value>,
    #[serde(default)]
    error: Option<String>,
}

/// Return a MiniApp surface result to the waiting Agent call.
#[tauri::command]
pub(crate) async fn report_miniapp_web_result(
    request: ReportMiniAppWebResultRequest,
) -> Result<(), String> {
    let sender = lock_pending_responses()
        .remove(&request.request_id)
        .ok_or_else(|| "MiniApp surface request is no longer pending".to_string())?;
    let result = if request.success {
        Ok(request.result.unwrap_or(Value::Null))
    } else {
        Err(request
            .error
            .filter(|message| !message.trim().is_empty())
            .unwrap_or_else(|| {
                format!(
                    "{}: the MiniApp surface action failed",
                    MiniAppWebErrorCode::HostError.as_str()
                )
            }))
    };
    sender
        .send(result)
        .map_err(|_| "MiniApp surface request receiver is no longer available".to_string())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[tokio::test]
    async fn an_action_timeout_does_not_detach_the_surface() {
        SURFACE_READY.store(true, Ordering::Release);
        let (sender, receiver) = oneshot::channel();
        lock_pending_responses().insert("timeout-test".into(), sender);
        let result =
            receive_surface_result("timeout-test", receiver, Duration::from_millis(1), "answer")
                .await;
        assert!(result.unwrap_err().starts_with("TIMEOUT:"));
        assert!(SURFACE_READY.load(Ordering::Acquire));
        assert!(!lock_pending_responses().contains_key("timeout-test"));
        let (sender, receiver) = oneshot::channel();
        sender.send(Ok(json!({"retried": true}))).unwrap();
        assert_eq!(
            receive_surface_result("retry-test", receiver, EXECUTE_TIMEOUT, "answer")
                .await
                .unwrap(),
            json!({"retried": true})
        );
        SURFACE_READY.store(false, Ordering::Release);
    }

    #[test]
    fn readiness_defaults_to_detached_so_calls_fail_loudly() {
        let request: MiniAppWebSurfaceReadyRequest =
            serde_json::from_value(json!({})).expect("empty request");
        assert!(!request.ready);
        let request: MiniAppWebSurfaceReadyRequest =
            serde_json::from_value(json!({ "ready": true })).expect("ready request");
        assert!(request.ready);
    }

    #[test]
    fn bridge_actions_get_a_longer_budget_than_dom_actions() {
        let dom = if "inspect".starts_with("bridge_") {
            BRIDGE_TIMEOUT
        } else {
            EXECUTE_TIMEOUT
        };
        assert_eq!(dom, EXECUTE_TIMEOUT);
        assert!(BRIDGE_TIMEOUT > EXECUTE_TIMEOUT);
    }

    #[test]
    fn result_reports_accept_camel_case_request_ids() {
        let request: ReportMiniAppWebResultRequest = serde_json::from_value(json!({
            "requestId": "miniapp-web-1",
            "success": false,
            "error": "STALE_TARGET: iframe reloaded",
        }))
        .expect("report request");
        assert_eq!(request.request_id, "miniapp-web-1");
        assert!(!request.success);
        assert!(request.result.is_none());
    }

    #[test]
    fn only_commands_bound_to_the_window_are_relayed_to_it() {
        let mut host = crate::miniapp_desktop::DesktopMiniApps::new(
            openbitfun_miniapp_ipc::HostChannel::Development,
        );
        let window = host.test_window("demo");

        // The session bound by `open` carries the window instance.
        assert_eq!(
            window_route(
                &host,
                &MiniAppWebCommand::new("demo", Some(&window.instance_id), "bridge_observe", None)
            ),
            WindowRoute::Serve
        );
        // A command without an instance is a fresh session, which can only be
        // talking about the one presentation that exists.
        assert_eq!(
            window_route(
                &host,
                &MiniAppWebCommand::new("demo", None, "bridge_observe", None)
            ),
            WindowRoute::Serve
        );
        // Another instance is a different presentation, so this window must not
        // answer for it, and the caller has to reattach instead of drifting.
        assert!(matches!(
            window_route(
                &host,
                &MiniAppWebCommand::new("demo", Some("instance-other"), "bridge_observe", None)
            ),
            WindowRoute::Stale(_)
        ));
        assert_eq!(
            window_route(
                &host,
                &MiniAppWebCommand::new("other", Some(&window.instance_id), "bridge_observe", None)
            ),
            WindowRoute::Absent
        );

        // A closed window stops being a route, and the tab runtime takes over.
        host.instances.detach(&window.instance_id, &window.view_id);
        assert_eq!(
            window_route(
                &host,
                &MiniAppWebCommand::new("demo", Some(&window.instance_id), "bridge_observe", None)
            ),
            WindowRoute::Absent
        );
    }

    #[test]
    fn the_surface_open_reports_is_the_instance_the_window_answers_for() {
        let mut host = crate::miniapp_desktop::DesktopMiniApps::new(
            openbitfun_miniapp_ipc::HostChannel::Development,
        );
        let window = host.test_window("demo");
        // This is what `open` returns to the tool, and the tool then binds its
        // session to the reported id. Reporting the view id here used to bind the
        // session to nothing the router recognised, so every bridge request fell
        // through to the tab runtime and reported an unrelated surface error.
        let surface =
            MiniAppWebSurfaceInfo::window("demo".to_string(), window.instance_id.clone(), false);
        assert!(surface.is_window_presentation());
        assert!(surface.capabilities.is_empty());

        let session_instance = surface.instance_id.expect("a window names its instance");
        assert_ne!(session_instance, window.view_id);
        assert_eq!(
            window_route(
                &host,
                &MiniAppWebCommand::new("demo", Some(&session_instance), "observe_bridge", None)
            ),
            WindowRoute::Serve
        );
    }

    #[tokio::test]
    async fn dom_actions_on_a_window_report_the_capability_gap() {
        let host = crate::miniapp_desktop::DesktopMiniApps::new(
            openbitfun_miniapp_ipc::HostChannel::Development,
        );
        let error = relay_to_window(
            &host,
            &MiniAppWebCommand::new("demo", None, "inspect", None),
        )
        .await
        .expect_err("a window cannot serve DOM actions");
        assert!(error.starts_with(MiniAppWebErrorCode::CapabilityMissing.as_str()));
        assert!(error.contains("move the MiniApp to a tab"), "{error}");

        let error = relay_to_window(
            &host,
            &MiniAppWebCommand::new("demo", None, "bridge_act", Some(json!({}))),
        )
        .await
        .expect_err("bridge_act needs an action");
        assert!(error.starts_with(MiniAppWebErrorCode::InvalidParams.as_str()));
    }
}
