//! Peer Device Mode: proxy product Tauri commands onto this host.
//!
//! Commands are executed through the same frontend invoke surface as local UI
//! (peer webview → `invoke`), so handler signatures stay single-sourced.
//! Which commands may run here on a controller's behalf is decided by the
//! Product Operation Registry (`openbitfun_product_domains::remote_surface`); this
//! module only applies its verdict before any bridge call. The frontend and
//! the CLI peer host derive their tables from the same registry, so the three
//! surfaces cannot drift apart. See `docs/architecture/remote-surface-contract.md`.

use std::collections::{HashMap, HashSet};
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Mutex, OnceLock};
use std::time::Duration;

use openbitfun_product_domains::remote_surface::{
    capability_map, digest as remote_surface_digest, peer_host_verdict, peer_stance,
    retired_reason, PeerHostKind, PeerHostVerdict, PeerStance,
};
use serde::{Deserialize, Serialize};
use serde_json::Value;
use tauri::{AppHandle, Emitter};
use tokio::sync::oneshot;

use super::remote_connect_api::{account_app_handle, current_device_id_for_peer, RelayRoute};

const DEFAULT_INVOKE_TIMEOUT: Duration = Duration::from_secs(120);

static PENDING: OnceLock<Mutex<HashMap<String, oneshot::Sender<HostInvokeBridgeResult>>>> =
    OnceLock::new();

#[derive(Default)]
struct PeerControlState {
    controllers: HashSet<(RelayRoute, String)>,
    permission_request_ids: HashSet<String>,
}

/// Controllers currently attached for DeviceEvent fan-out and the pending
/// permission requests projected to them.
static PEER_CONTROL_STATE: OnceLock<Mutex<PeerControlState>> = OnceLock::new();

/// True while this process is acting as a Peer Mode controller (Remote: B).
/// Used to pause cloud settings pull that would rewrite local disk mid-remote.
static PEER_CONTROLLER_ACTIVE: AtomicBool = AtomicBool::new(false);

fn pending_map() -> &'static Mutex<HashMap<String, oneshot::Sender<HostInvokeBridgeResult>>> {
    PENDING.get_or_init(|| Mutex::new(HashMap::new()))
}

fn peer_control_state() -> &'static Mutex<PeerControlState> {
    PEER_CONTROL_STATE.get_or_init(|| Mutex::new(PeerControlState::default()))
}

pub fn set_peer_controller_active(active: bool) {
    PEER_CONTROLLER_ACTIVE.store(active, Ordering::SeqCst);
}

pub fn is_peer_controller_active() -> bool {
    PEER_CONTROLLER_ACTIVE.load(Ordering::SeqCst)
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct HostInvokeBridgeResult {
    pub ok: bool,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub value: Option<Value>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub error: Option<String>,
}

#[derive(Clone, Serialize)]
#[serde(rename_all = "camelCase")]
struct HostInvokeBridgeRequest {
    id: String,
    command: String,
    args: Value,
}

/// Whether this host must refuse the command on a controller's behalf.
///
/// Covers both registry stances that a peer host never executes:
/// `ControllerLocal` (the controller keeps it) and `OperatorOnly` (only the
/// machine that owns the workspace may decide it, e.g. `git_trust_repository`).
pub fn is_local_only_command(command: &str) -> bool {
    matches!(
        peer_stance(command),
        Some(PeerStance::ControllerLocal | PeerStance::OperatorOnly)
    )
}

/// Commands kept as protocol tombstones after their runtime owner was removed.
pub fn is_retired_command(command: &str) -> bool {
    retired_reason(command).is_some()
}

/// Register a controller device id to receive peer UI events.
pub fn attach_controller(device_id: String) {
    attach_route_controller(RelayRoute::Official, device_id);
}

pub(crate) fn attach_route_controller(route: RelayRoute, device_id: String) {
    if let Ok(mut state) = peer_control_state().lock() {
        state.controllers.insert((route, device_id));
    }
}

#[cfg(test)]
fn detach_from_state(state: &mut PeerControlState, device_id: &str) -> Vec<String> {
    detach_route_from_state(state, RelayRoute::Official, device_id)
}

fn detach_route_from_state(
    state: &mut PeerControlState,
    route: RelayRoute,
    device_id: &str,
) -> Vec<String> {
    let removed = state.controllers.remove(&(route, device_id.to_string()));
    if removed && state.controllers.is_empty() {
        return state.permission_request_ids.drain().collect();
    }
    Vec::new()
}

/// Detach one controller and return requests that must fail closed when it was
/// the final controller.
pub fn detach_controller(device_id: &str) -> Vec<String> {
    detach_route_controller(RelayRoute::Official, device_id)
}

pub(crate) fn detach_route_controller(route: RelayRoute, device_id: &str) -> Vec<String> {
    let Ok(mut state) = peer_control_state().lock() else {
        return Vec::new();
    };
    detach_route_from_state(&mut state, route, device_id)
}

fn retain_online_in_state(
    state: &mut PeerControlState,
    online_device_ids: &HashSet<String>,
) -> Vec<String> {
    let had_controllers = !state.controllers.is_empty();
    state.controllers.retain(|(route, device_id)| {
        *route != RelayRoute::Official || online_device_ids.contains(device_id)
    });
    if had_controllers && state.controllers.is_empty() {
        return state.permission_request_ids.drain().collect();
    }
    Vec::new()
}

/// Remove controllers missing from account presence and return requests that
/// lost their final control surface.
pub fn retain_online_controllers(online_device_ids: &HashSet<String>) -> Vec<String> {
    let Ok(mut state) = peer_control_state().lock() else {
        return Vec::new();
    };
    retain_online_in_state(&mut state, online_device_ids)
}

/// Clear all attached controllers after the device-routing stream closes.
pub(crate) fn disconnect_route_controllers(route: RelayRoute) -> Vec<String> {
    let Ok(mut state) = peer_control_state().lock() else {
        return Vec::new();
    };
    state.controllers.retain(|(owner, _)| *owner != route);
    if state.controllers.is_empty() {
        state.permission_request_ids.drain().collect()
    } else {
        Vec::new()
    }
}

pub fn track_permission_event(
    event: &openbitfun_agent_runtime::sdk::PermissionRequestEvent,
) -> bool {
    let Ok(mut state) = peer_control_state().lock() else {
        return false;
    };
    match event {
        openbitfun_agent_runtime::sdk::PermissionRequestEvent::Asked { request } => {
            if !state.controllers.is_empty() {
                state
                    .permission_request_ids
                    .insert(request.request_id.clone());
                true
            } else {
                false
            }
        }
        openbitfun_agent_runtime::sdk::PermissionRequestEvent::Replied { request_id, .. }
        | openbitfun_agent_runtime::sdk::PermissionRequestEvent::Cancelled { request_id, .. } => {
            let was_tracked = state.permission_request_ids.remove(request_id);
            was_tracked && !state.controllers.is_empty()
        }
    }
}

pub fn take_tracked_permission_requests() -> Vec<String> {
    peer_control_state()
        .lock()
        .map(|mut state| state.permission_request_ids.drain().collect())
        .unwrap_or_default()
}

pub async fn fail_closed_permission_requests(
    request_ids: Vec<String>,
    reason: &str,
) -> Result<(), String> {
    if request_ids.is_empty() {
        return Ok(());
    }
    let manager = openbitfun_core::product_runtime::core_permission_request_manager()?;
    let mut failures = Vec::new();
    for request_id in request_ids {
        if let Err(error) = manager
            .cancel_request(&request_id, reason.to_string())
            .await
        {
            failures.push(format!("{request_id}: {error}"));
        }
    }
    if failures.is_empty() {
        Ok(())
    } else {
        Err(format!(
            "Failed to cancel Peer permission requests: {}",
            failures.join("; ")
        ))
    }
}

pub fn attached_controllers() -> Vec<String> {
    peer_control_state()
        .lock()
        .map(|state| state.controllers.iter().map(|(_, id)| id.clone()).collect())
        .unwrap_or_default()
}

pub(crate) fn attached_route_controllers(route: RelayRoute) -> Vec<String> {
    peer_control_state()
        .lock()
        .map(|state| {
            state
                .controllers
                .iter()
                .filter(|(owner, _)| *owner == route)
                .map(|(_, id)| id.clone())
                .collect()
        })
        .unwrap_or_default()
}

/// Complete a bridged invoke from the peer webview.
#[tauri::command]
pub async fn peer_host_invoke_complete(
    id: String,
    ok: bool,
    value: Option<Value>,
    error: Option<String>,
) -> Result<(), String> {
    let sender = pending_map()
        .lock()
        .map_err(|e| format!("peer host invoke lock poisoned: {e}"))?
        .remove(&id);
    if let Some(tx) = sender {
        let _ = tx.send(HostInvokeBridgeResult { ok, value, error });
        Ok(())
    } else {
        Err(format!("unknown peer host invoke id: {id}"))
    }
}

#[tauri::command]
pub async fn peer_control_attach(controller_device_id: String) -> Result<(), String> {
    if controller_device_id.trim().is_empty() {
        return Err("controller_device_id is required".to_string());
    }
    attach_controller(controller_device_id);
    Ok(())
}

#[tauri::command]
pub async fn peer_control_detach(controller_device_id: String) -> Result<(), String> {
    let request_ids = detach_controller(&controller_device_id);
    fail_closed_permission_requests(request_ids, "Last Peer controller detached").await
}

#[tauri::command]
pub async fn peer_mode_ping() -> Result<Value, String> {
    Ok(serde_json::json!({
        "ok": true,
        "peer": true,
        "device_id": current_device_id_for_peer()
            .unwrap_or_else(|_| "unknown".to_string()),
        // Declares which kind of host answered so the controller can resolve
        // capabilities that an older host did not advertise. An older Desktop
        // (pre-`50b76516`) omits `cancel_tool`/`tool_catalog` but still reports
        // `host_type: "desktop"` — and Desktop has always implemented both — so
        // the controller keeps the Interrupt button / tool list. An older CLI
        // reports `host_type: "cli"` and never implemented them, so the
        // controller gates them off instead of showing an action that silently
        // fails. See PR #2428 round 5 #1.
        "host_type": PeerHostKind::Desktop.as_wire_str(),
        // Only advertised keys, all `true`: a missing key means "older host",
        // which the controller resolves through `host_type`. The list is the
        // registry's, shared with the CLI host and the generated frontend
        // artifact, so a controller cannot probe a key no host will send.
        "capabilities": Value::Object(capability_map(PeerHostKind::Desktop)),
        // Additive: lets a controller detect that this host and its own
        // generated tables were built from different registries.
        "surface_registry_digest": remote_surface_digest(),
    }))
}

/// Mark this process as a Peer Mode controller so cloud pull does not rewrite local settings.
#[tauri::command]
pub async fn peer_controller_set_active(active: bool) -> Result<(), String> {
    set_peer_controller_active(active);
    Ok(())
}

/// Dispatch a product command on this peer according to the registry verdict.
pub async fn dispatch(command: &str, args: Value) -> HostInvokeBridgeResult {
    match peer_host_verdict(command, PeerHostKind::Desktop) {
        PeerHostVerdict::Refuse(refusal) => {
            return HostInvokeBridgeResult {
                ok: false,
                value: None,
                error: Some(refusal.message(command)),
            };
        }
        // Attach/detach/ping and the dispatch target verbs are answered by
        // `remote_connect_api::execute_local_remote_command` before this
        // function is reached; a direct call is a wiring bug, not a product
        // command to bridge.
        PeerHostVerdict::HostControlPlane => {
            return HostInvokeBridgeResult {
                ok: false,
                value: None,
                error: Some(format!(
                    "command '{command}' belongs to the peer host control plane and is not bridged as a product command"
                )),
            };
        }
        PeerHostVerdict::Execute => {}
    }

    let app = match account_app_handle() {
        Some(app) => app.clone(),
        None => {
            return HostInvokeBridgeResult {
                ok: false,
                value: None,
                error: Some("peer app handle not ready".to_string()),
            };
        }
    };

    use openbitfun_core_types::agent_identity_wire::{
        translate_agent_identity_command, translate_agent_identity_response, AgentIdentityDialect,
    };
    let args =
        match translate_agent_identity_command(command, args, AgentIdentityDialect::Canonical) {
            Ok(args) => args,
            Err(error) => {
                return HostInvokeBridgeResult {
                    ok: false,
                    value: None,
                    error: Some(error),
                }
            }
        };
    let response_scope =
        serde_json::json!({"path": args.get("request").unwrap_or(&args).get("path")});
    match bridge_via_webview(&app, command, args).await {
        Ok(mut result) => {
            if let Some(value) = result.value.take() {
                match translate_agent_identity_response(
                    command,
                    value,
                    &response_scope,
                    AgentIdentityDialect::Legacy,
                ) {
                    Ok(value) => result.value = Some(value),
                    Err(error) => {
                        result.ok = false;
                        result.error = Some(error);
                    }
                }
            }
            result
        }
        Err(error) => HostInvokeBridgeResult {
            ok: false,
            value: None,
            error: Some(error),
        },
    }
}

async fn bridge_via_webview(
    app: &AppHandle,
    command: &str,
    args: Value,
) -> Result<HostInvokeBridgeResult, String> {
    let id = uuid::Uuid::new_v4().to_string();
    let (tx, rx) = oneshot::channel();
    pending_map()
        .lock()
        .map_err(|e| format!("peer host invoke lock poisoned: {e}"))?
        .insert(id.clone(), tx);

    let request = HostInvokeBridgeRequest {
        id: id.clone(),
        command: command.to_string(),
        args,
    };

    if let Err(e) = app.emit("peer-host-invoke://request", &request) {
        pending_map().lock().ok().map(|mut map| map.remove(&id));
        return Err(format!("failed to emit peer host invoke request: {e}"));
    }

    match tokio::time::timeout(DEFAULT_INVOKE_TIMEOUT, rx).await {
        Ok(Ok(result)) => Ok(result),
        Ok(Err(_)) => Err("peer host invoke channel closed".to_string()),
        Err(_) => {
            pending_map().lock().ok().map(|mut map| map.remove(&id));
            Err(format!(
                "peer host invoke timed out after {}s for '{command}'",
                DEFAULT_INVOKE_TIMEOUT.as_secs()
            ))
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn control_state(controllers: &[&str], requests: &[&str]) -> PeerControlState {
        PeerControlState {
            controllers: controllers
                .iter()
                .map(|value| (RelayRoute::Official, value.to_string()))
                .collect(),
            permission_request_ids: requests.iter().map(|value| value.to_string()).collect(),
        }
    }

    #[test]
    fn detaching_one_route_preserves_the_other_controller_and_permissions() {
        let mut state = control_state(&["same-device"], &["pending-approval"]);
        state
            .controllers
            .insert((RelayRoute::Lan, "same-device".into()));
        assert!(detach_route_from_state(&mut state, RelayRoute::Lan, "same-device").is_empty());
        assert_eq!(state.permission_request_ids.len(), 1);
        assert_eq!(state.controllers.len(), 1);
        assert_eq!(
            detach_from_state(&mut state, "same-device"),
            vec!["pending-approval"]
        );
    }

    #[tokio::test]
    async fn peer_ping_advertises_mutation_capabilities() {
        let value = peer_mode_ping().await.expect("peer ping");
        assert_eq!(
            value.get("host_type").and_then(Value::as_str),
            Some("desktop")
        );
        assert_eq!(
            value
                .pointer("/capabilities/idempotent_dialog_submit")
                .and_then(Value::as_bool),
            Some(true)
        );
        assert_eq!(
            value
                .pointer("/capabilities/product_control_native_v1")
                .and_then(Value::as_bool),
            Some(true)
        );
        assert_eq!(
            value
                .pointer("/capabilities/product_control_presentation_v1")
                .and_then(Value::as_bool),
            Some(true)
        );
        assert_eq!(
            value
                .pointer("/capabilities/targeted_session_rollback")
                .and_then(Value::as_bool),
            Some(true)
        );
        assert_eq!(
            value
                .pointer("/capabilities/token_usage_statistics")
                .and_then(Value::as_bool),
            Some(true)
        );
        assert_eq!(
            value
                .pointer("/capabilities/miniapp_agent_context_files_v1")
                .and_then(Value::as_bool),
            Some(true)
        );
        assert_eq!(
            value
                .pointer("/capabilities/product_control_v1")
                .and_then(Value::as_bool),
            Some(true)
        );
        assert_eq!(
            value
                .pointer("/capabilities/cancel_tool")
                .and_then(Value::as_bool),
            Some(true)
        );
        assert_eq!(
            value
                .pointer("/capabilities/tool_catalog")
                .and_then(Value::as_bool),
            Some(true)
        );
        let capabilities = value
            .get("capabilities")
            .and_then(Value::as_object)
            .expect("capabilities object");
        assert!(
            capabilities.values().all(|v| v == &Value::Bool(true)),
            "advertised capabilities are published as true only"
        );
        assert_eq!(
            capabilities.len(),
            openbitfun_product_domains::remote_surface::advertised_by(PeerHostKind::Desktop).len()
        );
        assert!(value
            .get("surface_registry_digest")
            .and_then(Value::as_str)
            .is_some_and(|d| d.starts_with("fnv1a64:")));
        assert_eq!(
            value
                .pointer("/capabilities/user_question_response")
                .and_then(Value::as_bool),
            Some(true)
        );
    }

    #[test]
    fn appearance_market_stays_on_the_controller_device() {
        for command in [
            "appearance_market_browse",
            "appearance_market_get_listing",
            "appearance_market_download_release",
            "appearance_market_get_review_submission",
            "appearance_market_list_review_submissions",
            "appearance_market_list_submissions",
            "appearance_market_review_submission",
            "appearance_market_submit_package",
            "appearance_market_withdraw_submission",
        ] {
            assert!(is_local_only_command(command), "{command}");
        }
    }

    /// The controller-side FE deny list is an optimization, not the boundary.
    /// A controller on an older build (or a non-FE controller) still reaches
    /// this host, so every controller-owned command must be refused here too.
    #[test]
    fn controller_owned_capture_and_dispatch_commands_are_refused_on_the_peer() {
        for command in [
            // Capture and model files belong to the machine the user speaks at.
            "speech_list_models",
            "speech_download_model",
            "speech_cancel_model_download",
            "speech_delete_model",
            "speech_verify_model",
            "speech_start_input_session",
            "speech_append_audio_chunk",
            "speech_finish_input_session",
            "speech_cancel_input_session",
            "speech_start_realtime_session",
            "speech_append_realtime_audio",
            "speech_commit_realtime_audio",
            "speech_send_realtime_tool_result",
            "speech_speak_realtime_text",
            "speech_cancel_realtime_response",
            "speech_close_realtime_session",
            "speech_get_realtime_config",
            "speech_save_realtime_config",
            // Same controller-owned observer/credential family as the other
            // dispatch verbs already denied here.
            "dispatch_continue",
        ] {
            assert!(is_local_only_command(command), "{command}");
        }
    }

    #[test]
    fn built_in_browser_target_lifecycle_is_refused_on_the_peer() {
        assert!(is_local_only_command(
            "browser_webview_set_agent_target_state"
        ));
    }

    #[test]
    fn frontend_update_decisions_stay_with_the_controller_window() {
        assert!(is_local_only_command("frontend_update_candidate_ready"));
        assert!(is_local_only_command("get_frontend_update_status"));
        assert!(is_local_only_command("confirm_frontend_update"));
        assert!(is_local_only_command("rollback_frontend_update"));
    }

    #[test]
    fn product_control_presentation_callbacks_stay_with_the_controller_window() {
        for command in [
            "mark_openbitfun_control_surface_ready",
            "mark_openbitfun_control_surface_unready",
            "report_openbitfun_control_result",
        ] {
            assert!(is_local_only_command(command), "{command}");
        }
        assert!(!is_local_only_command("product_control_invoke"));
    }

    /// Reading why Git refuses a repository is safe to answer for a
    /// controller; granting the exception writes this user's global Git
    /// configuration and must be decided at this machine.
    #[test]
    fn granting_git_ownership_trust_is_refused_on_the_peer() {
        assert!(is_local_only_command("git_trust_repository"));
        assert!(!is_local_only_command("git_get_repository_trust"));
    }

    /// `remote_connect_api::execute_local_remote_command` special-cases these
    /// three names before the deny check; the registry must agree so the CLI
    /// host and the frontend derive the same control plane.
    #[test]
    fn control_plane_commands_are_host_control_plane_in_registry() {
        use openbitfun_product_domains::remote_surface::operation;
        for command in [
            "peer_control_attach",
            "peer_control_detach",
            "peer_mode_ping",
        ] {
            assert_eq!(
                operation(command).map(|op| op.peer),
                Some(PeerStance::HostControlPlane),
                "{command}"
            );
            assert!(
                !is_local_only_command(command),
                "{command} is answered by the control plane, not refused as local-only"
            );
        }
    }

    #[tokio::test]
    async fn local_only_commands_fail_before_the_webview_bridge() {
        let result = dispatch("account_login", serde_json::json!({})).await;
        assert!(!result.ok);
        assert_eq!(
            result.error.as_deref(),
            Some("command 'account_login' is local-only and cannot run on peer")
        );
        let result = dispatch("git_trust_repository", serde_json::json!({})).await;
        assert_eq!(
            result.error.as_deref(),
            Some("command 'git_trust_repository' is local-only and cannot run on peer")
        );
    }

    #[tokio::test]
    async fn cli_only_aliases_are_refused_with_a_host_reason() {
        let result = dispatch("list_files", serde_json::json!({})).await;
        assert!(!result.ok);
        let error = result.error.unwrap_or_default();
        assert!(
            error.starts_with("command 'list_files' is not supported on desktop peer host:"),
            "{error}"
        );
    }

    #[tokio::test]
    async fn unknown_commands_report_a_host_version_mismatch() {
        let result = dispatch("not_an_openbitfun_command", serde_json::json!({})).await;
        assert!(!result.ok);
        let error = result.error.unwrap_or_default();
        assert!(
            error.contains("is unknown to this OpenBitFun desktop peer host version"),
            "{error}"
        );
    }

    #[tokio::test]
    async fn retired_lsp_commands_fail_before_the_webview_bridge() {
        let result = dispatch("lsp_open_workspace", serde_json::json!({})).await;
        assert!(!result.ok);
        assert!(result.value.is_none());
        assert_eq!(
            result.error.as_deref(),
            Some(
                "command 'lsp_open_workspace' is unsupported because the OpenBitFun LSP runtime has been retired"
            )
        );
    }

    #[test]
    fn only_the_final_detach_drains_peer_permission_requests() {
        let mut state = control_state(&["controller-a", "controller-b"], &["request-1"]);

        assert!(detach_from_state(&mut state, "controller-a").is_empty());
        assert_eq!(
            detach_from_state(&mut state, "controller-b"),
            vec!["request-1".to_string()]
        );
    }

    #[test]
    fn presence_loss_drains_requests_only_when_every_controller_is_offline() {
        let mut state = control_state(&["controller-a", "controller-b"], &["request-1"]);
        let online = HashSet::from(["controller-b".to_string()]);
        assert!(retain_online_in_state(&mut state, &online).is_empty());

        assert_eq!(
            retain_online_in_state(&mut state, &HashSet::new()),
            vec!["request-1".to_string()]
        );
    }
}
