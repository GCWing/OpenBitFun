//! Tauri commands for Remote Connect.

use crate::embedded_relay_host::DesktopEmbeddedRelayHost;
use base64::{engine::general_purpose::STANDARD as BASE64, Engine as _};
use openbitfun_core::agentic::tools::account_login_capability::set_account_login_available;
use openbitfun_core::agentic::tools::page_deploy_host::set_page_deploy_handler;
use openbitfun_core::agentic::tools::page_publish_host::set_page_publish_handler;
use openbitfun_core::service::dispatch::{
    DispatchAccountDaemonIdentity, DispatchAccountDaemonProvisionRequest,
    DISPATCH_ACCOUNT_DAEMON_PROVISIONING_SCHEMA_VERSION,
};
use openbitfun_core::service::remote_connect::session_store::{
    clear_credential_hint, load_credential_hint, save_credential_hint, AccountHint,
};
use openbitfun_core::service::remote_connect::{
    bot::{self, weixin, BotConfig},
    lan, session_store, AccountClient, AccountSession, ConnectionMethod, ConnectionResult,
    DeviceIdentity, RemoteConnectConfig, RemoteConnectService,
};
use openbitfun_events::AI_MODEL_CATALOG_UPDATED_EVENT;
use openbitfun_services_integrations::remote_connect::account::{
    error_indicates_expired_token, validate_relay_base_url,
};
use openbitfun_services_integrations::remote_connect::{
    deploy_page_version_on_relay, join_relay_url, list_pages_from_relay,
    publish_page_content_on_relay,
};
use regex::Regex;
use serde::{Deserialize, Serialize};
use std::collections::HashMap;
use std::path::PathBuf;
use std::sync::atomic::{AtomicU64, AtomicUsize, Ordering};
use std::sync::{Arc, OnceLock};
use tauri::{AppHandle, Emitter};
use tokio::sync::RwLock;

static REMOTE_CONNECT_SERVICE: OnceLock<Arc<RwLock<Option<RemoteConnectService>>>> =
    OnceLock::new();

/// Session and relay URL must move together. Keeping them behind one lock
/// prevents a request from observing a token from one login and the URL from
/// another while an account transition is in progress.
#[derive(Clone)]
struct AccountContextState {
    session: AccountSession,
    relay_url: String,
}

static ACCOUNT_CONTEXT: OnceLock<Arc<RwLock<Option<AccountContextState>>>> = OnceLock::new();

/// Serializes credential-bearing operations against login/logout transitions.
static ACCOUNT_OPERATION_LOCK: tokio::sync::Mutex<()> = tokio::sync::Mutex::const_new(());
/// Serializes credential verification attempts without hiding or disconnecting
/// the currently active account. A successful candidate acquires the account
/// transition guard only after all login-time network requests complete.
static ACCOUNT_LOGIN_LOCK: tokio::sync::Mutex<()> = tokio::sync::Mutex::const_new(());
static ACCOUNT_CONTEXT_TRANSITION_LOCK: tokio::sync::Mutex<()> = tokio::sync::Mutex::const_new(());
/// Serializes connection entry point changes and explicit disconnection.
static RELAY_START_STOP_LOCK: tokio::sync::Mutex<()> = tokio::sync::Mutex::const_new(());
static ACCOUNT_TRANSITION_BOUNDARY_LOCK: tokio::sync::Mutex<()> = tokio::sync::Mutex::const_new(());
static ACCOUNT_CONTEXT_GENERATION: AtomicU64 = AtomicU64::new(1);
static ACCOUNT_CONTEXT_TRANSITIONS: AtomicUsize = AtomicUsize::new(0);

/// Device-routing effects take a read lease; connection replacement and
/// teardown take the write lease. Together with `DeviceRoutingOwner`, this
/// prevents a retiring event loop from dispatching through a newer socket.
static DEVICE_ROUTING_LIFECYCLE_LOCK: tokio::sync::RwLock<()> = tokio::sync::RwLock::const_new(());
static DEVICE_ROUTING_CONNECTION_ID: AtomicU64 = AtomicU64::new(0);

/// RPC memory admission belongs to the shared relay transport. Account
/// transitions cancel pending host futures before waiting for routing leases.
fn device_rpc_cancellation() -> &'static tokio::sync::watch::Sender<u64> {
    static CANCEL: OnceLock<tokio::sync::watch::Sender<u64>> = OnceLock::new();
    CANCEL.get_or_init(|| tokio::sync::watch::channel(0).0)
}

fn cancel_pending_device_rpcs() {
    device_rpc_cancellation().send_modify(|epoch| *epoch = epoch.wrapping_add(1));
}

#[derive(Clone, Debug, Eq, PartialEq)]
struct DeviceRoutingOwner {
    account_generation: u64,
    account_token: String,
    connection_id: u64,
    service_connection_id: u64,
}

#[derive(Default)]
struct DeviceRoutingState {
    owner: Option<DeviceRoutingOwner>,
    online_devices: Vec<OnlineDeviceInfo>,
    /// Account-auth QR clients use HTTP device RPC instead of the QR room.
    /// A successful control heartbeat proves that a client reached this host.
    control_ping_generation: u64,
    control_clients: std::collections::BTreeMap<String, (String, std::time::Instant)>,
    last_unidentified_control_ping: Option<std::time::Instant>,
}

static DEVICE_ROUTING_STATE: OnceLock<std::sync::Mutex<DeviceRoutingState>> = OnceLock::new();

pub(crate) fn account_context_generation() -> u64 {
    ACCOUNT_CONTEXT_GENERATION.load(Ordering::Acquire)
}

pub(crate) fn account_context_is_current(generation: u64) -> bool {
    ACCOUNT_CONTEXT_TRANSITIONS.load(Ordering::Acquire) == 0
        && account_context_generation() == generation
}

struct AccountContextTransitionPermit;

impl AccountContextTransitionPermit {
    fn begin() -> Self {
        ACCOUNT_CONTEXT_TRANSITIONS.fetch_add(1, Ordering::AcqRel);
        ACCOUNT_CONTEXT_GENERATION.fetch_add(1, Ordering::AcqRel);
        cancel_pending_device_rpcs();
        clear_session_subscriptions();
        Self
    }
}

impl Drop for AccountContextTransitionPermit {
    fn drop(&mut self) {
        // Invalidate work queued during the transition before making the newly
        // installed (or cleared) account context discoverable.
        ACCOUNT_CONTEXT_GENERATION.fetch_add(1, Ordering::AcqRel);
        ACCOUNT_CONTEXT_TRANSITIONS.fetch_sub(1, Ordering::AcqRel);
    }
}

struct AccountContextTransitionGuard {
    operation_guard: Option<tokio::sync::MutexGuard<'static, ()>>,
    transition: Option<AccountContextTransitionPermit>,
    transition_guard: Option<tokio::sync::MutexGuard<'static, ()>>,
}

impl AccountContextTransitionGuard {
    /// Make the committed context observable while retaining the transition
    /// mutex. Login-state listeners can now probe `account_status`, while a
    /// competing logout or replacement remains blocked until publication ends.
    fn make_context_observable(&mut self) {
        drop(self.operation_guard.take());
        drop(self.transition.take());
    }
}

impl Drop for AccountContextTransitionGuard {
    fn drop(&mut self) {
        // Release the operation lock before reopening context discovery. A
        // queued operation that wins this handoff still fails on the gate.
        drop(self.operation_guard.take());
        drop(self.transition.take());
        drop(self.transition_guard.take());
    }
}

async fn lock_account_operation(
    generation: u64,
) -> Result<tokio::sync::MutexGuard<'static, ()>, String> {
    let guard = ACCOUNT_OPERATION_LOCK.lock().await;
    if !account_context_is_current(generation) {
        return Err("account context changed".to_string());
    }
    Ok(guard)
}

async fn begin_account_transition() -> AccountContextTransitionGuard {
    // Serialize transition creation so a stale invalidation can re-check its
    // generation before it makes the current account undiscoverable.
    let transition_guard = ACCOUNT_CONTEXT_TRANSITION_LOCK.lock().await;
    let transition = AccountContextTransitionPermit::begin();
    let operation_guard = ACCOUNT_OPERATION_LOCK.lock().await;
    AccountContextTransitionGuard {
        operation_guard: Some(operation_guard),
        transition: Some(transition),
        transition_guard: Some(transition_guard),
    }
}

async fn begin_account_transition_if_current(
    expected_generation: u64,
) -> Option<AccountContextTransitionGuard> {
    let transition_guard = ACCOUNT_CONTEXT_TRANSITION_LOCK.lock().await;
    if !account_context_is_current(expected_generation) {
        return None;
    }
    let transition = AccountContextTransitionPermit::begin();
    let operation_guard = ACCOUNT_OPERATION_LOCK.lock().await;
    Some(AccountContextTransitionGuard {
        operation_guard: Some(operation_guard),
        transition: Some(transition),
        transition_guard: Some(transition_guard),
    })
}

/// Global handle to the DialogScheduler, set during app startup. Used by the
/// device-routing background task to execute commands received from peer
/// devices (ExecuteOnDevice).
static DIALOG_SCHEDULER: OnceLock<Arc<openbitfun_core::agentic::coordination::DialogScheduler>> =
    OnceLock::new();

/// Set the global scheduler handle. Called once during app startup.
pub fn set_dialog_scheduler(
    scheduler: Arc<openbitfun_core::agentic::coordination::DialogScheduler>,
) {
    let _ = DIALOG_SCHEDULER.set(scheduler);
}

/// AppHandle used by the device-routing background task to emit UI events
/// (presence / settings-applied) without requiring a Tauri command context.
static ACCOUNT_APP_HANDLE: OnceLock<AppHandle> = OnceLock::new();

/// Store the app handle for account device-routing events. Called once during setup.
pub fn set_account_app_handle(app: AppHandle) {
    let _ = ACCOUNT_APP_HANDLE.set(app);
}

/// Shared AppHandle for account / peer-host bridges.
pub fn account_app_handle() -> Option<&'static AppHandle> {
    ACCOUNT_APP_HANDLE.get()
}

/// Current device id for peer capability probes.
pub fn current_device_id_for_peer() -> Result<String, String> {
    Ok(current_device_identity()?.device_id)
}

fn emit_account_event(event: &str, payload: serde_json::Value) {
    if let Some(app) = ACCOUNT_APP_HANDLE.get() {
        if let Err(e) = app.emit(event, payload) {
            log::warn!("Failed to emit {event}: {e}");
        }
    }
}

/// Payload key carrying the device that produced a re-emitted Peer DeviceEvent.
///
/// The controller re-emits peer events under their original event name so the
/// existing listeners keep working, which means a controller that is also
/// running its own local work would otherwise see two indistinguishable
/// streams on one bus. The frontend routes on this key and delivers an event
/// only to the device surface it belongs to. Keep in sync with
/// `src/web-ui/src/infrastructure/peer-device/deviceSurfaceRouting.ts`.
pub const PEER_EVENT_SOURCE_KEY: &str = "__openbitfunSourceDeviceId";

/// Wrapper key used when a peer payload is not a JSON object and therefore
/// cannot carry `PEER_EVENT_SOURCE_KEY` inline.
pub const PEER_EVENT_WRAPPED_PAYLOAD_KEY: &str = "__openbitfunSourcePayload";

/// Tag a peer-originated event payload with the device that produced it.
fn tag_peer_event_source(payload: serde_json::Value, source_device_id: &str) -> serde_json::Value {
    let source = serde_json::Value::String(source_device_id.to_string());
    match payload {
        serde_json::Value::Object(mut map) => {
            map.insert(PEER_EVENT_SOURCE_KEY.to_string(), source);
            serde_json::Value::Object(map)
        }
        other => {
            let mut map = serde_json::Map::new();
            map.insert(PEER_EVENT_SOURCE_KEY.to_string(), source);
            map.insert(PEER_EVENT_WRAPPED_PAYLOAD_KEY.to_string(), other);
            serde_json::Value::Object(map)
        }
    }
}

fn emit_device_presence(devices: &[(String, String)]) {
    let payload = serde_json::json!({
        "devices": devices
            .iter()
            .map(|(id, name)| serde_json::json!({
                "device_id": id,
                "device_name": name,
            }))
            .collect::<Vec<_>>(),
    });
    emit_account_event("account://device-presence", payload);
}

async fn disconnect_peer_controllers(reason: &'static str) {
    let request_ids = crate::api::peer_host_invoke::disconnect_controllers();
    if let Err(error) =
        crate::api::peer_host_invoke::fail_closed_permission_requests(request_ids, reason).await
    {
        log::warn!("Peer permission requests were not fully cancelled: {error}");
    }
    emit_device_presence(&[]);
}

/// Retire the active routing owner before touching the shared service. The
/// lifecycle write lease ensures no retiring event handler can cross this
/// boundary and dispatch through a subsequently installed connection.
async fn stop_and_clear_device_routing(reason: &'static str) {
    cancel_pending_device_rpcs();
    let _lifecycle = DEVICE_ROUTING_LIFECYCLE_LOCK.write().await;
    clear_device_routing_state();
    if let Some(service) = get_service_holder().read().await.as_ref() {
        service.stop_device_connection().await;
    }
    disconnect_peer_controllers(reason).await;
}

async fn finish_device_routing_event_loop(owner: &DeviceRoutingOwner) {
    let current = with_device_routing_state(|state| {
        if state.owner.as_ref() != Some(owner) {
            return false;
        }
        cancel_pending_device_rpcs();
        true
    });
    if !current {
        return;
    }
    let _lifecycle = DEVICE_ROUTING_LIFECYCLE_LOCK.write().await;
    if !clear_device_routing_if_owner(owner) {
        return;
    }
    disconnect_peer_controllers("Peer device-routing stream closed").await;
}

pub(crate) async fn session_publisher(
) -> Option<Arc<openbitfun_core::service::remote_connect::session_log::SessionPublisher>> {
    let service = get_service_holder().read().await;
    match service.as_ref() {
        Some(service) => service.session_publisher().await,
        None => None,
    }
}

/// Emit granular auto-sync progress for the account login / devices UI.
pub fn fanout_peer_device_event(event: String, payload: serde_json::Value) {
    if crate::api::peer_host_invoke::attached_controllers().is_empty() {
        return;
    }
    let Some(routing_owner) = current_device_routing_owner_snapshot() else {
        return;
    };
    let tx = PEER_EVENT_FANOUT_TX.get_or_init(|| {
        let (tx, mut rx) = tokio::sync::mpsc::unbounded_channel::<PeerEventFanoutItem>();
        tokio::spawn(async move {
            while let Some(item) = rx.recv().await {
                fanout_peer_device_event_once(item).await;
            }
        });
        tx
    });
    if let Err(e) = tx.send(PeerEventFanoutItem {
        routing_owner,
        event,
        payload,
    }) {
        log::debug!("peer event fanout queue closed: {e}");
    }
}

struct PeerEventFanoutItem {
    routing_owner: DeviceRoutingOwner,
    event: String,
    payload: serde_json::Value,
}

static PEER_EVENT_FANOUT_TX: OnceLock<tokio::sync::mpsc::UnboundedSender<PeerEventFanoutItem>> =
    OnceLock::new();

async fn fanout_peer_device_event_once(item: PeerEventFanoutItem) {
    let mut cancelled = device_rpc_cancellation().subscribe();
    tokio::select! {
        biased;
        _ = cancelled.changed() => {},
        _ = fanout_peer_device_event_current(item) => {}
    }
}

async fn fanout_peer_device_event_current(item: PeerEventFanoutItem) {
    let Some(_routing_effect) = lock_current_device_routing(&item.routing_owner).await else {
        return;
    };
    let targets = crate::api::peer_host_invoke::attached_controllers();
    if targets.is_empty() {
        return;
    }
    let (session, relay_url) =
        match read_account_context_for_generation(item.routing_owner.account_generation).await {
            Ok(ctx) => ctx,
            Err(e) => {
                log::debug!("peer event fanout skipped (no account): {e}");
                return;
            }
        };
    if session.token != item.routing_owner.account_token
        || !device_routing_owner_is_current(&item.routing_owner).await
    {
        return;
    }
    use openbitfun_core::service::remote_connect::remote_server::RemoteCommand;
    let mut payload = item.payload;
    if let Err(error) = openbitfun_core_types::agent_identity_wire::translate_agent_identity_fields(
        &mut payload,
        openbitfun_core_types::agent_identity_wire::AgentIdentityDialect::Legacy,
    ) {
        log::warn!("Peer event contains conflicting Agent profiles; preserving records: {error}");
    }
    let envelope = match serde_json::to_string(&RemoteCommand::DeviceEvent {
        event: item.event.clone(),
        payload,
    }) {
        Ok(s) => s,
        Err(e) => {
            log::warn!("peer event fanout serialize failed: {e}");
            return;
        }
    };
    for target in targets {
        let (encrypted_data, nonce) = match session
            .encrypt_for_peer(&relay_url, &target, &envelope)
            .await
        {
            Ok(value) => value,
            Err(error) => {
                log::warn!("peer event fanout encrypt failed: {error}");
                continue;
            }
        };
        let correlation_id = uuid::Uuid::new_v4().to_string();
        if let Err(e) = send_device_message_with_routing_lease(
            &item.routing_owner,
            &target,
            &correlation_id,
            &encrypted_data,
            &nonce,
        )
        .await
        {
            log::debug!("peer event fanout to {target} failed: {e}");
        }
    }
}

fn should_fanout_peer_ui_event(event: &str) -> bool {
    matches!(
        event,
        "terminal_event"
            | "file-system-changed"
            | "backend-event-mcpinteractionrequest"
            | "backend-event-acppermissionrequest"
            | "backend-event-toolexecutionprogress"
            | "backend-event-toolterminalready"
            | "backend-event-backgroundcommandlifecycle"
            | "backend-event-toolexecutionstarted"
            | "backend-event-toolexecutioncompleted"
            | "backend-event-toolexecutionerror"
            | "backend-event-toolawaitinguserinput"
            | "backend-event-toolcallconfirmation"
            | "permission://event"
            | AI_MODEL_CATALOG_UPDATED_EVENT
    )
}

/// Whether the given UI event would currently be fanned out to attached Peer
/// Mode controllers. Callers can use this to avoid cloning/serializing payloads
/// when no fanout will happen.
pub fn peer_ui_event_fanout_active(event: &str) -> bool {
    should_fanout_peer_ui_event(event)
        && !crate::api::peer_host_invoke::attached_controllers().is_empty()
}

/// Fan-out non-agentic UI events to attached Peer Mode controllers when needed.
pub fn maybe_fanout_peer_ui_event(event: &str, payload: serde_json::Value) {
    if !peer_ui_event_fanout_active(event) {
        return;
    }
    fanout_peer_device_event(event.to_string(), payload);
}

/// EventEmitter wrapper that mirrors selected UI events to Peer Mode controllers.
pub struct PeerAwareEmitter {
    inner: Arc<dyn openbitfun_core::infrastructure::events::EventEmitter>,
}

impl PeerAwareEmitter {
    pub fn new(inner: Arc<dyn openbitfun_core::infrastructure::events::EventEmitter>) -> Self {
        Self { inner }
    }
}

#[async_trait::async_trait]
impl openbitfun_core::infrastructure::events::EventEmitter for PeerAwareEmitter {
    async fn emit(&self, event_name: &str, payload: serde_json::Value) -> anyhow::Result<()> {
        // Only clone the payload when a peer fanout will actually happen;
        // otherwise move it into the inner emitter zero-copy.
        if peer_ui_event_fanout_active(event_name) {
            self.inner.emit(event_name, payload.clone()).await?;
            fanout_peer_device_event(event_name.to_string(), payload);
        } else {
            self.inner.emit(event_name, payload).await?;
        }
        Ok(())
    }
}

pub fn wrap_peer_aware_emitter(
    inner: Arc<dyn openbitfun_core::infrastructure::events::EventEmitter>,
) -> Arc<dyn openbitfun_core::infrastructure::events::EventEmitter> {
    Arc::new(PeerAwareEmitter::new(inner))
}

async fn send_device_message_with_routing_lease(
    owner: &DeviceRoutingOwner,
    target_device_id: &str,
    correlation_id: &str,
    encrypted_data: &str,
    nonce: &str,
) -> Result<(), String> {
    if !device_routing_owner_is_current(owner).await {
        return Err("device routing changed".to_string());
    }
    let holder = get_service_holder().read().await;
    if !device_routing_owner_is_current(owner).await {
        return Err("device routing changed".to_string());
    }
    let service = holder
        .as_ref()
        .ok_or_else(|| "remote connect service not initialized".to_string())?;
    let sent = service
        .send_device_message_if_connection(
            owner.service_connection_id,
            target_device_id,
            correlation_id,
            encrypted_data,
            nonce,
        )
        .await
        .map_err(|error| error.to_string())?;
    if !sent || !device_routing_owner_is_current(owner).await {
        return Err("device routing changed".to_string());
    }
    Ok(())
}

/// Encrypt and send an RPC response (or error) back to the HTTP caller via relay.
async fn send_rpc_envelope(
    owner: &DeviceRoutingOwner,
    session: &AccountSession,
    source_device_id: &str,
    correlation_id: &str,
    resp_value: serde_json::Value,
) -> bool {
    if !device_routing_owner_is_current(owner).await {
        return false;
    }
    let resp_json = match serde_json::to_string(&resp_value) {
        Ok(s) => s,
        Err(e) => {
            log::warn!("RPC: serialize response failed: {e}");
            serde_json::json!({
                "resp": "error",
                "message": format!("failed to serialize RPC response: {e}"),
            })
            .to_string()
        }
    };
    let Ok((_, relay_url)) = read_account_context_for_generation(owner.account_generation).await
    else {
        return false;
    };
    match session
        .encrypt_for_peer(&relay_url, source_device_id, &resp_json)
        .await
    {
        Ok((enc_resp, resp_nonce)) => {
            match send_device_message_with_routing_lease(
                owner,
                source_device_id,
                correlation_id,
                &enc_resp,
                &resp_nonce,
            )
            .await
            {
                Ok(()) => true,
                Err(e) => {
                    log::warn!("RPC: send response failed: {e}");
                    false
                }
            }
        }
        Err(e) => {
            log::warn!("RPC: encrypt response failed: {e}");
            false
        }
    }
}

async fn send_rpc_error(
    owner: &DeviceRoutingOwner,
    session: &AccountSession,
    source_device_id: &str,
    correlation_id: &str,
    message: impl Into<String>,
) {
    send_rpc_envelope(
        owner,
        session,
        source_device_id,
        correlation_id,
        serde_json::json!({
            "resp": "error",
            "message": message.into(),
        }),
    )
    .await;
}

/// Global flag set when the relay returns HTTP 401 (token expired). The
/// frontend checks this via `account_token_expired` and prompts re-login.
static TOKEN_EXPIRED: std::sync::atomic::AtomicBool = std::sync::atomic::AtomicBool::new(false);

/// Check if the account token has been marked expired by the sync loop.
#[tauri::command]
pub async fn account_token_expired() -> bool {
    TOKEN_EXPIRED.load(std::sync::atomic::Ordering::Relaxed)
}

/// Drop the local account session after the relay rejects the token, but only
/// if the response still belongs to the same account generation and token.
/// Keeps the username/relay hint so the login form can be prefilled.
async fn invalidate_local_account_session_if_current(
    expected_generation: u64,
    expected_token: &str,
    reason: &str,
) -> bool {
    if !account_context_matches(expected_generation, expected_token).await {
        log::info!("Ignored auth failure from a stale account generation");
        return false;
    }
    let _room_boundary_guard = ACCOUNT_TRANSITION_BOUNDARY_LOCK.lock().await;
    if !account_context_matches(expected_generation, expected_token).await {
        log::info!("Ignored auth failure from a stale account generation");
        return false;
    }
    let Some(_transition_guard) = begin_account_transition_if_current(expected_generation).await
    else {
        log::info!("Ignored auth failure from a stale account generation");
        return false;
    };
    let token_matches = get_account_context()
        .read()
        .await
        .as_ref()
        .is_some_and(|context| context.session.token == expected_token);
    if !token_matches {
        log::info!("Ignored auth failure from a replaced account token");
        return false;
    }
    sync_account_login_capability(false);
    TOKEN_EXPIRED.store(true, std::sync::atomic::Ordering::Relaxed);
    stop_and_clear_device_routing("Account session expired").await;
    if let Some(service) = get_service_holder().read().await.as_ref() {
        service.clear_bot_delegated_identities().await;
    }
    *get_account_context().write().await = None;
    session_store::clear_session();
    emit_account_event(
        "account://login-state",
        serde_json::json!({ "logged_in": false, "reason": "session_expired" }),
    );
    log::warn!("Invalidated local account session after relay auth failure: {reason}");
    true
}

fn sync_account_login_capability(logged_in: bool) {
    set_account_login_available(logged_in);
}

fn register_page_deploy_host() {
    set_page_deploy_handler(Arc::new(|slug, version_id| {
        Box::pin(async move {
            let generation = account_context_generation();
            let (session, relay_url) = read_account_context_for_generation(generation).await?;
            let page = list_pages_from_relay(&relay_url, &session.token)
                .await
                .map_err(|e| e.to_string())?
                .into_iter()
                .find(|page| page.slug == slug)
                .ok_or_else(|| {
                    "Page not found; refresh the Page list before deploying".to_string()
                })?;
            let info = deploy_page_version_on_relay(
                &relay_url,
                &session.token,
                &slug,
                &version_id,
                &page.generation,
            )
            .await
            .map_err(|e| e.to_string())?;
            if !account_context_is_current(generation) {
                return Err("account context changed".to_string());
            }
            let mut value = serde_json::to_value(info).map_err(|e| e.to_string())?;
            if let Some(obj) = value.as_object_mut() {
                let path = obj
                    .get("url_path")
                    .and_then(|v| v.as_str())
                    .unwrap_or("")
                    .to_string();
                let preview_path = obj
                    .get("preview_url_path")
                    .and_then(|v| v.as_str())
                    .unwrap_or("")
                    .to_string();
                obj.insert(
                    "url".into(),
                    serde_json::Value::String(join_relay_url(&relay_url, &path)),
                );
                if !preview_path.is_empty() {
                    obj.insert(
                        "preview_url".into(),
                        serde_json::Value::String(join_relay_url(&relay_url, &preview_path)),
                    );
                }
            }
            Ok(value)
        })
    }));
}

fn register_page_publish_host() {
    set_page_publish_handler(Arc::new(|request| {
        Box::pin(async move {
            let generation = account_context_generation();
            let (session, relay_url) = read_account_context_for_generation(generation).await?;
            let result = publish_page_content_on_relay(
                &relay_url,
                &session.token,
                &request.slug,
                &request.visibility,
                request.title.as_deref(),
                request.note.as_deref(),
                request.deploy,
                request.directory.as_deref(),
                request.files.as_ref(),
            )
            .await
            .map_err(|e| e.to_string())?;
            if !account_context_is_current(generation) {
                return Err("account context changed".to_string());
            }
            serde_json::to_value(result).map_err(|e| e.to_string())
        })
    }));
}

fn get_account_context() -> &'static Arc<RwLock<Option<AccountContextState>>> {
    ACCOUNT_CONTEXT.get_or_init(|| Arc::new(RwLock::new(None)))
}

/// Read both the session and relay URL, returning owned clones to avoid
/// holding locks across awaits.
pub(crate) async fn read_account_context() -> Result<(AccountSession, String), String> {
    let generation = account_context_generation();
    read_account_context_for_generation(generation).await
}

async fn read_account_context_raw() -> Result<(AccountSession, String), String> {
    get_account_context()
        .read()
        .await
        .clone()
        .map(|context| (context.session, context.relay_url))
        .ok_or_else(|| "not logged in".to_string())
}

pub(crate) async fn read_account_context_for_generation(
    generation: u64,
) -> Result<(AccountSession, String), String> {
    if !account_context_is_current(generation) {
        return Err("account context changed".to_string());
    }
    let context = read_account_context_raw().await?;
    if !account_context_is_current(generation) {
        return Err("account context changed".to_string());
    }
    Ok(context)
}

/// Secret-bearing, Rust-only handoff for one SSH target bootstrap. It is never
/// serialized through Tauri; only its redacted outcome reaches the Web UI.
pub(crate) struct DispatchAccountDeviceProvisioning {
    pub(crate) request: DispatchAccountDaemonProvisionRequest,
    target_session: AccountSession,
    relay_url: String,
}

impl DispatchAccountDeviceProvisioning {
    pub(crate) fn device_id(&self) -> &str {
        &self.request.device_id
    }

    pub(crate) fn user_id(&self) -> &str {
        &self.request.user_id
    }
}

/// Mint a distinct full device credential for an SSH host. Callers receive
/// `None` and skip account/daemon setup when this Desktop is logged out.
pub(crate) async fn provision_dispatch_account_device(
    identity: &DispatchAccountDaemonIdentity,
) -> Result<Option<DispatchAccountDeviceProvisioning>, String> {
    let generation = account_context_generation();
    let Ok(_account_guard) = lock_account_operation(generation).await else {
        return Ok(None);
    };
    let (session, relay_url) = match read_account_context_for_generation(generation).await {
        Ok(context) => context,
        Err(error) if error == "not logged in" => return Ok(None),
        Err(error) => return Err(error),
    };
    let request_id = uuid::Uuid::new_v4();
    let target_secret =
        openbitfun_services_integrations::remote_connect::device_crypto::provisioning_secret(
            &session.master_key,
            &identity.device_id,
            &request_id.to_string(),
        );
    let issued = AccountClient::new()
        .provision_device_token(
            &relay_url,
            &session,
            &identity.device_id,
            &identity.device_name,
            "desktop",
            request_id,
            &target_secret,
        )
        .await
        .map_err(|error| format!("provision remote account device: {error}"))?;
    let target_session =
        AccountSession::new(issued.token.clone(), issued.user_id.clone(), target_secret);
    let provisioning = DispatchAccountDeviceProvisioning {
        request: DispatchAccountDaemonProvisionRequest {
            schema_version: DISPATCH_ACCOUNT_DAEMON_PROVISIONING_SCHEMA_VERSION,
            token: issued.token,
            user_id: issued.user_id,
            master_key_base64: BASE64.encode(target_secret),
            relay_url: relay_url.clone(),
            device_id: issued.device_id,
        },
        target_session,
        relay_url,
    };
    if !account_context_matches(generation, &session.token).await {
        let _ = remove_dispatch_account_device(&provisioning).await;
        return Err("account context changed while provisioning the SSH target".to_string());
    }
    Ok(Some(provisioning))
}

pub(crate) async fn wait_for_dispatch_account_device_online(
    provisioning: &DispatchAccountDeviceProvisioning,
) -> Result<(), String> {
    let deadline = tokio::time::Instant::now() + std::time::Duration::from_secs(30);
    loop {
        let devices = AccountClient::new()
            .list_devices(&provisioning.relay_url, &provisioning.target_session)
            .await
            .map_err(|error| format!("verify remote daemon connection: {error}"))?;
        if devices
            .iter()
            .any(|device| device.device_id == provisioning.request.device_id && device.online)
        {
            return Ok(());
        }
        if tokio::time::Instant::now() >= deadline {
            return Err(
                "remote OpenBitFun daemon did not connect to the relay within 30 seconds"
                    .to_string(),
            );
        }
        tokio::time::sleep(std::time::Duration::from_millis(500)).await;
    }
}

pub(crate) async fn remove_dispatch_account_device(
    provisioning: &DispatchAccountDeviceProvisioning,
) -> Result<(), String> {
    AccountClient::new()
        .delete_device(
            &provisioning.relay_url,
            &provisioning.target_session,
            &provisioning.request.device_id,
        )
        .await
        .map_err(|error| format!("remove provisioned account device: {error}"))
}

async fn account_context_matches(generation: u64, token: &str) -> bool {
    if !account_context_is_current(generation) {
        return false;
    }
    let token_matches = get_account_context()
        .read()
        .await
        .as_ref()
        .is_some_and(|context| context.session.token == token);
    token_matches && account_context_is_current(generation)
}

fn get_device_routing_state() -> &'static std::sync::Mutex<DeviceRoutingState> {
    DEVICE_ROUTING_STATE.get_or_init(|| std::sync::Mutex::new(DeviceRoutingState::default()))
}

fn with_device_routing_state<T>(update: impl FnOnce(&mut DeviceRoutingState) -> T) -> T {
    let mut state = get_device_routing_state()
        .lock()
        .unwrap_or_else(|poisoned| poisoned.into_inner());
    update(&mut state)
}

fn new_device_routing_owner(
    account_generation: u64,
    account_token: &str,
    service_connection_id: u64,
) -> DeviceRoutingOwner {
    DeviceRoutingOwner {
        account_generation,
        account_token: account_token.to_string(),
        connection_id: DEVICE_ROUTING_CONNECTION_ID.fetch_add(1, Ordering::AcqRel) + 1,
        service_connection_id,
    }
}

fn install_device_routing_owner(owner: DeviceRoutingOwner) {
    with_device_routing_state(|state| {
        state.owner = Some(owner);
        state.online_devices.clear();
        state.control_clients.clear();
        state.last_unidentified_control_ping = None;
        state.control_ping_generation = 0;
    });
}

fn control_ping_generation(owner: &DeviceRoutingOwner) -> Option<u64> {
    with_device_routing_state(|state| {
        (state.owner.as_ref() == Some(owner)).then_some(state.control_ping_generation)
    })
}

fn record_control_ping_if_owner(
    owner: &DeviceRoutingOwner,
    generation: u64,
    now: std::time::Instant,
    client: Option<&openbitfun_services_integrations::remote_connect::RemoteControlClient>,
) {
    with_device_routing_state(|state| {
        if state.owner.as_ref() == Some(owner) && state.control_ping_generation == generation {
            // Leases use receipt time, not the completion time of queued replies.
            use openbitfun_services_integrations::remote_connect::relay_client::RELAY_INBOUND_IDLE_TIMEOUT;
            state.control_clients.retain(|_, (_, last)| {
                now.saturating_duration_since(*last) < RELAY_INBOUND_IDLE_TIMEOUT
            });
            if let Some(client) =
                client.filter(|client| !client.id.trim().is_empty() && client.id.len() <= 128)
            {
                let name: String = client
                    .name
                    .chars()
                    .filter(|c| !c.is_control())
                    .take(120)
                    .collect();
                let entry = state
                    .control_clients
                    .entry(client.id.clone())
                    .or_insert((name.clone(), now));
                if now >= entry.1 {
                    *entry = (name, now);
                }
            } else {
                state.last_unidentified_control_ping = Some(
                    state
                        .last_unidentified_control_ping
                        .map_or(now, |last| last.max(now)),
                );
            }
        }
    });
}

fn clear_control_ping_if_owner(owner: &DeviceRoutingOwner) {
    with_device_routing_state(|state| {
        if state.owner.as_ref() == Some(owner) {
            state.control_clients.clear();
            state.last_unidentified_control_ping = None;
            state.control_ping_generation = state.control_ping_generation.wrapping_add(1);
        }
    });
}

#[cfg(test)]
fn has_recent_control_ping(owner: &DeviceRoutingOwner, now: std::time::Instant) -> bool {
    let (clients, unidentified) = account_control_clients(owner, now);
    !clients.is_empty() || unidentified
}

fn is_successful_control_ping(
    command: &openbitfun_core::service::remote_connect::remote_server::RemoteCommand,
    response: &serde_json::Value,
) -> bool {
    use openbitfun_core::service::remote_connect::remote_server::RemoteCommand;
    // The mobile/browser connection-health loop pings its selected target.
    // `peer_mode_ping` is also used before attaching or switching a device;
    // accepting that capability probe would manufacture a mobile connection.
    matches!(command, RemoteCommand::Ping { .. })
        && response.get("resp").and_then(|v| v.as_str()) == Some("pong")
}

fn account_control_clients(
    owner: &DeviceRoutingOwner,
    now: std::time::Instant,
) -> (
    Vec<openbitfun_services_integrations::remote_connect::RemoteControlClient>,
    bool,
) {
    use openbitfun_services_integrations::remote_connect::{
        relay_client::RELAY_INBOUND_IDLE_TIMEOUT, RemoteControlClient,
    };
    with_device_routing_state(|state| {
        if state.owner.as_ref() != Some(owner) {
            return (Vec::new(), false);
        }
        let clients = state
            .control_clients
            .iter()
            .filter(|(_, (_, last))| {
                now.saturating_duration_since(*last) < RELAY_INBOUND_IDLE_TIMEOUT
            })
            .map(|(id, (name, _))| RemoteControlClient {
                id: id.clone(),
                name: name.clone(),
            })
            .collect();
        let unidentified = state
            .last_unidentified_control_ping
            .is_some_and(|last| now.saturating_duration_since(last) < RELAY_INBOUND_IDLE_TIMEOUT);
        (clients, unidentified)
    })
}

async fn account_control_snapshot(
    now: std::time::Instant,
) -> Option<(
    String,
    Vec<openbitfun_services_integrations::remote_connect::RemoteControlClient>,
    bool,
)> {
    let generation = account_context_generation();
    let (session, relay_url) = read_account_context_for_generation(generation).await.ok()?;
    let owner = device_routing_owner_for_account(generation, &session.token)?;
    let (clients, unidentified) = account_control_clients(&owner, now);
    if clients.is_empty() && !unidentified {
        return None;
    }
    (account_context_is_current(generation) && device_routing_owner_is_registered(&owner))
        .then_some((relay_url, clients, unidentified))
}

#[cfg(test)]
async fn account_control_relay_url(now: std::time::Instant) -> Option<String> {
    account_control_snapshot(now).await.map(|(url, _, _)| url)
}

fn device_routing_owner_is_registered(owner: &DeviceRoutingOwner) -> bool {
    with_device_routing_state(|state| state.owner.as_ref() == Some(owner))
}

fn device_routing_owner_for_account(
    account_generation: u64,
    account_token: &str,
) -> Option<DeviceRoutingOwner> {
    with_device_routing_state(|state| {
        let owner = state.owner.as_ref()?;
        if owner.account_generation != account_generation || owner.account_token != account_token {
            return None;
        }
        Some(owner.clone())
    })
}

fn current_device_routing_owner_snapshot() -> Option<DeviceRoutingOwner> {
    with_device_routing_state(|state| state.owner.clone()).filter(|owner| {
        account_context_is_current(owner.account_generation)
            && device_routing_owner_is_registered(owner)
    })
}

async fn device_routing_owner_is_current(owner: &DeviceRoutingOwner) -> bool {
    device_routing_owner_is_registered(owner)
        && account_context_matches(owner.account_generation, &owner.account_token).await
        && device_routing_owner_is_registered(owner)
}

async fn lock_current_device_routing(
    owner: &DeviceRoutingOwner,
) -> Option<tokio::sync::RwLockReadGuard<'static, ()>> {
    let guard = DEVICE_ROUTING_LIFECYCLE_LOCK.read().await;
    if device_routing_owner_is_current(owner).await {
        Some(guard)
    } else {
        None
    }
}

fn replace_device_presence_if_owner(
    owner: &DeviceRoutingOwner,
    devices: Vec<OnlineDeviceInfo>,
) -> bool {
    with_device_routing_state(|state| {
        if state.owner.as_ref() != Some(owner) {
            return false;
        }
        state.online_devices = devices;
        true
    })
}

fn device_presence_for_account(
    account_generation: u64,
    account_token: &str,
) -> Option<Vec<OnlineDeviceInfo>> {
    with_device_routing_state(|state| {
        let owner = state.owner.as_ref()?;
        if owner.account_generation != account_generation || owner.account_token != account_token {
            return None;
        }
        Some(state.online_devices.clone())
    })
}

fn clear_device_routing_if_owner(owner: &DeviceRoutingOwner) -> bool {
    with_device_routing_state(|state| {
        if state.owner.as_ref() != Some(owner) {
            return false;
        }
        state.owner = None;
        state.online_devices.clear();
        state.control_clients.clear();
        state.last_unidentified_control_ping = None;
        true
    })
}

fn clear_device_routing_state() -> bool {
    with_device_routing_state(|state| {
        let had_owner = state.owner.take().is_some();
        state.online_devices.clear();
        state.control_clients.clear();
        state.last_unidentified_control_ping = None;
        had_owner
    })
}

fn normalize_relay_url(relay_url: &str) -> Result<String, String> {
    let parsed = validate_relay_base_url(relay_url.trim()).map_err(|error| error.to_string())?;
    Ok(parsed.as_str().trim_end_matches('/').to_string())
}

async fn revoke_login_candidate(
    client: &AccountClient,
    relay_url: &str,
    session: &AccountSession,
    reason: &str,
) {
    if let Err(error) = client.revoke_token(relay_url, session).await {
        log::warn!("Failed to revoke rejected login candidate after {reason}: {error}");
    }
}

fn select_replaced_account_for_revocation(
    previous: Option<AccountContextState>,
    replacement_relay_url: &str,
    replacement_token: &str,
) -> Option<AccountContextState> {
    previous.filter(|account| {
        account.relay_url != replacement_relay_url || account.session.token != replacement_token
    })
}

async fn revoke_replaced_account(client: &AccountClient, account: Option<AccountContextState>) {
    let Some(account) = account else {
        return;
    };
    if let Err(error) = client
        .revoke_token(&account.relay_url, &account.session)
        .await
    {
        // The replacement is already fully published. Revocation is
        // best-effort and must never roll the new account back.
        log::warn!("Failed to revoke replaced account token: {error}");
    }
}

// ── Credential persistence (non-secret: username + relay_url only) ──────
// Owned by shared `session_store` so Desktop and CLI use the same hint file.

/// Tauri command: get the persisted credential hint for pre-filling the login form.
#[tauri::command]
pub async fn account_get_credential_hint() -> Option<AccountHint> {
    load_credential_hint()
}

/// Tauri resource directory path for mobile-web, set during app setup.
static MOBILE_WEB_RESOURCE_PATH: OnceLock<PathBuf> = OnceLock::new();

fn get_service_holder() -> &'static Arc<RwLock<Option<RemoteConnectService>>> {
    REMOTE_CONNECT_SERVICE.get_or_init(|| Arc::new(RwLock::new(None)))
}

/// Called from Tauri setup to register the resolved resource directory path
/// for the bundled mobile-web files.
pub fn set_mobile_web_resource_path(path: PathBuf) {
    log::info!("Registered mobile-web resource path: {}", path.display());
    let _ = MOBILE_WEB_RESOURCE_PATH.set(path);
}

/// Called from Tauri setup to eagerly initialize the remote connect service
/// and restore any previously paired bot connections.  Without this, bots
/// only start listening after the user first opens the Remote Connect dialog.
/// Register delegated identity providers for mobile-web (room channel) and
/// IM bots (global provider). Called after session is restored (startup) or
/// after fresh login.
async fn register_delegated_identity_providers() {
    // Global provider for IM bots.
    let account_context = get_account_context().clone();
    openbitfun_core::service::remote_connect::bot::set_delegated_identity_provider(move || {
        let account_context = account_context.clone();
        Box::pin(async move {
            let generation = account_context_generation();
            if !account_context_is_current(generation) {
                return None;
            }
            let context = account_context.read().await.clone()?;
            if !account_context_is_current(generation) {
                return None;
            }
            match AccountClient::new()
                .delegate_token(&context.relay_url, &context.session)
                .await
            {
                Ok(delegated) if account_context_is_current(generation) => Some((
                    context.relay_url,
                    delegated.token,
                    delegated.device_secret.to_vec(),
                )),
                Ok(_) => None,
                Err(e) => {
                    log::warn!("Bot delegate token failed: {e}");
                    None
                }
            }
        })
    });
}

pub fn init_on_startup() {
    register_page_deploy_host();
    register_page_publish_host();
    tokio::spawn(async {
        let startup_generation = account_context_generation();
        // Restore persisted account session (if any) before anything else
        // so that device routing and bot delegation work on restart.
        match session_store::load_session_detailed() {
            Ok(Some(loaded)) => {
                let user_id = loaded.user_id.clone();
                let relay_url = match normalize_relay_url(&loaded.relay_url) {
                    Ok(url) => url,
                    Err(error) => {
                        log::warn!("Ignoring invalid persisted relay URL: {error}");
                        // Keep the record intact. A newer build, repaired
                        // configuration, or explicit user action may recover
                        // it; startup validation must never become data loss.
                        sync_account_login_capability(false);
                        if let Err(error) = ensure_service().await {
                            log::warn!("Remote connect startup init failed: {error}");
                        }
                        return;
                    }
                };
                if openbitfun_services_integrations::remote_connect::account::is_retired_official_relay(&relay_url) {
                    if let Some(device_id) = loaded.device_id.as_deref() {
                        if let Err(error) = DeviceIdentity::adopt_account_device_id(device_id) {
                            log::warn!("Failed to adopt migrating account device id: {error}");
                            return;
                        }
                    }
                    match login_account_on_relay_for_generation(openbitfun_product_domains::account::DEFAULT_RELAY_URL.to_string(), Some(startup_generation)).await {
                        Ok(_) => {
                            if let Err(error) = account_connect_devices_with_retry().await {
                                log::warn!("New Relay routing failed: {error}");
                            }
                            restore_saved_bots().await;
                        }
                        Err(error) => {
                            sync_account_login_capability(false);
                            log::warn!("New Relay sign-in required; previous credential retained: {error}");
                            if let Err(error) = ensure_service().await {
                                log::warn!("Remote connect startup init failed: {error}");
                            }
                        }
                    }
                    return;
                }
                let Some(restore_guard) =
                    begin_account_transition_if_current(startup_generation).await
                else {
                    log::info!(
                        "Skipped persisted session restore after a newer account transition"
                    );
                    if let Err(error) = ensure_service().await {
                        log::warn!("Remote connect startup init failed: {error}");
                    }
                    return;
                };
                if let Some(device_id) = loaded.device_id.as_deref() {
                    if let Err(e) = DeviceIdentity::adopt_account_device_id(device_id) {
                        log::warn!("Failed to adopt restored session device_id: {e}");
                    }
                }
                let session = AccountSession::new(loaded.token, user_id.clone(), loaded.master_key);
                *get_account_context().write().await = Some(AccountContextState {
                    session,
                    relay_url: relay_url.clone(),
                });
                sync_account_login_capability(true);
                // Keep the mirrored "Self-Hosted" server field in sync for
                // sessions restored from an older version without the mirror.
                log::info!("Restored account session for user {user_id}");
                drop(restore_guard);

                // Initialize the remote-connect service if not yet ready.
                if let Err(e) = ensure_service().await {
                    log::warn!("Remote connect startup init failed: {e}");
                }

                // Re-register delegated identity providers for mobile-web / bots.
                register_delegated_identity_providers().await;

                // Best-effort: restore bot connections now that delegated
                // identity is available again.
                restore_saved_bots().await;

                // Re-establish device routing WebSocket in the background.
                // Uses the same Tauri command logic — fire and forget.
                tokio::spawn(async {
                    match account_connect_devices_with_retry().await {
                        Ok(_) => log::info!("Device routing restored on startup"),
                        Err(e) => log::warn!("Startup device connect failed: {e}"),
                    }
                });
            }
            Ok(None) => {
                sync_account_login_capability(false);
                // No persisted session — normal for first-time users.
                if let Err(e) = ensure_service().await {
                    log::warn!("Remote connect startup init failed: {e}");
                }
            }
            Err(e) => {
                sync_account_login_capability(false);
                log::warn!("Failed to load persisted session: {e}");
                if let Err(e) = ensure_service().await {
                    log::warn!("Remote connect startup init failed: {e}");
                }
            }
        }
    });
}

/// Synchronous cleanup called when the application exits.
pub fn cleanup_on_exit() {
    log::info!("Remote connect cleanup completed on exit");
}

async fn ensure_service() -> Result<(), String> {
    let holder = get_service_holder();
    let guard = holder.read().await;
    if guard.is_some() {
        return Ok(());
    }
    drop(guard);

    let config = RemoteConnectConfig {
        mobile_web_dir: detect_mobile_web_dir(),
        ..RemoteConnectConfig::default()
    };
    let service =
        new_remote_connect_service(config).map_err(|e| format!("init remote connect: {e}"))?;
    *holder.write().await = Some(service);

    // Auto-restore previously paired bots
    restore_saved_bots().await;

    Ok(())
}

fn new_remote_connect_service(config: RemoteConnectConfig) -> anyhow::Result<RemoteConnectService> {
    RemoteConnectService::new(config, Arc::new(DesktopEmbeddedRelayHost::default()))
}

/// Restore any bot connections that were previously saved to disk.
async fn restore_saved_bots() {
    use openbitfun_core::service::remote_connect::bot;

    let generation = account_context_generation();
    let Ok(_account_guard) = lock_account_operation(generation).await else {
        return;
    };
    let Ok((session, _)) = read_account_context_for_generation(generation).await else {
        return;
    };
    let data = bot::load_bot_persistence();
    if data.connections.is_empty() {
        return;
    }

    let holder = get_service_holder();
    let guard = holder.read().await;
    let Some(service) = guard.as_ref() else {
        return;
    };

    service.set_bot_account(Some(session.user_id.clone())).await;
    for conn in &data.connections {
        if !conn.chat_state.paired || conn.account_user_id != session.user_id {
            continue;
        }
        log::info!(
            "Restoring {} bot connection for chat_id={}",
            conn.bot_type,
            conn.chat_id
        );
        let result = service.restore_bot(conn).await;
        if let Err(e) = result {
            log::warn!("Failed to restore {} bot: {e}", conn.bot_type);
        }
    }
}

/// Auto-detect the mobile-web build output directory.
fn detect_mobile_web_dir() -> Option<String> {
    if let Ok(dir) = std::env::var("OPENBITFUN_MOBILE_WEB_DIR") {
        let p = std::path::Path::new(&dir);
        if p.join("index.html").exists() {
            log::info!("Using OPENBITFUN_MOBILE_WEB_DIR: {dir}");
            return Some(dir);
        }
        log::warn!("OPENBITFUN_MOBILE_WEB_DIR set but index.html not found: {dir}");
    }

    if let Some(resource_path) = MOBILE_WEB_RESOURCE_PATH.get() {
        if is_valid_mobile_web_dir(resource_path) {
            let dir = resource_path.to_string_lossy().into_owned();
            log::info!("Using Tauri bundled mobile-web: {dir}");
            return Some(dir);
        }
        log::debug!(
            "Tauri resource path registered but not a valid mobile-web dir: {}",
            resource_path.display()
        );
    }

    if let Some(dir) = detect_from_exe() {
        return Some(dir);
    }

    if let Some(dir) = detect_from_cwd() {
        return Some(dir);
    }

    log::warn!("mobile-web dist directory not found; LAN mode will not serve static files");
    None
}

fn detect_from_exe() -> Option<String> {
    let exe = std::env::current_exe().ok()?;
    let exe_dir = exe.parent()?;

    let mut candidates: Vec<PathBuf> = Vec::new();

    if cfg!(target_os = "macos") {
        // Primary: tauri.conf.json maps dist -> mobile-web/dist in Resources
        candidates.push(exe_dir.join("../Resources/mobile-web/dist"));
        // Fallback: legacy layout without dist subdirectory
        candidates.push(exe_dir.join("../Resources/mobile-web"));
        // Fallback: array-format bundling may place files at Resources/dist directly
        candidates.push(exe_dir.join("../Resources/dist"));
    }
    candidates.push(exe_dir.join("mobile-web/dist"));
    candidates.push(exe_dir.join("mobile-web"));
    candidates.push(exe_dir.join("resources/mobile-web/dist"));
    candidates.push(exe_dir.join("resources/mobile-web"));

    if cfg!(target_os = "linux") {
        candidates.push(exe_dir.join("../lib/openbitfun/mobile-web/dist"));
        candidates.push(exe_dir.join("../lib/openbitfun/mobile-web"));
        candidates.push(exe_dir.join("../share/openbitfun/mobile-web/dist"));
        candidates.push(exe_dir.join("../share/openbitfun/mobile-web"));
        candidates.push(exe_dir.join("../share/com.openbitfun.desktop/mobile-web/dist"));
        candidates.push(exe_dir.join("../share/com.openbitfun.desktop/mobile-web"));
    }

    check_candidates(&candidates, "exe-relative")
}

fn detect_from_cwd() -> Option<String> {
    let cwd = std::env::current_dir().ok()?;
    let candidates = [
        cwd.join("src/mobile-web/dist"),
        cwd.join("../../mobile-web/dist"),
        cwd.join("../mobile-web/dist"),
    ];

    check_candidates(&candidates, "cwd-relative")
}

fn check_candidates(candidates: &[PathBuf], source: &str) -> Option<String> {
    for candidate in candidates {
        if is_valid_mobile_web_dir(candidate) {
            if let Ok(abs) = candidate.canonicalize() {
                log::info!("Detected mobile-web dir ({}): {}", source, abs.display());
                return Some(abs.to_string_lossy().into_owned());
            }
        }
    }
    None
}

fn is_valid_mobile_web_dir(dir: &std::path::Path) -> bool {
    dir.join("index.html").exists() && dir.join("assets").is_dir()
}

// ── Request / Response DTOs ────────────────────────────────────────

#[derive(Debug, Deserialize)]
pub struct StartRemoteConnectRequest {
    pub method: String,
    pub lan_ip: Option<String>,
}

#[derive(Debug, Serialize, Deserialize)]
pub struct RemoteConnectStatusResponse {
    pub relay_connected: bool,
    pub relay_url: Option<String>,
    pub active_method: Option<ConnectionMethod>,
    pub clients: Vec<openbitfun_services_integrations::remote_connect::RemoteControlClient>,
    pub bot_connected: Option<String>,
    pub bot_verbose_mode: bool,
}

#[derive(Debug, Serialize)]
pub struct ConnectionMethodInfo {
    pub id: String,
    pub name: String,
    pub available: bool,
    pub description: String,
}

#[derive(Debug, Serialize)]
pub struct DeviceInfo {
    pub device_id: String,
    pub device_name: String,
    pub mac_address: String,
}

#[derive(Debug, Serialize)]
pub struct LanNetworkInterface {
    pub interface_name: String,
    pub ip: String,
    pub gateway_ip: Option<String>,
}

#[derive(Debug, Serialize)]
pub struct LanNetworkInfo {
    pub local_ip: String,
    pub gateway_ip: Option<String>,
    pub available_ips: Vec<LanNetworkInterface>,
}

fn detect_default_gateway_ip() -> Option<String> {
    #[cfg(target_os = "macos")]
    {
        let output = openbitfun_core::util::process_manager::create_command("route")
            .args(["-n", "get", "default"])
            .output()
            .ok()?;
        if !output.status.success() {
            return None;
        }
        let stdout = String::from_utf8_lossy(&output.stdout);
        let re = Regex::new(r"(?m)^\s*gateway:\s*([0-9]+\.[0-9]+\.[0-9]+\.[0-9]+)\s*$").ok()?;
        return re
            .captures(&stdout)
            .and_then(|c| c.get(1).map(|m| m.as_str().to_string()));
    }

    #[cfg(target_os = "linux")]
    {
        let output = openbitfun_core::util::process_manager::create_command("ip")
            .args(["route", "show", "default"])
            .output()
            .ok()?;
        if !output.status.success() {
            return None;
        }
        let stdout = String::from_utf8_lossy(&output.stdout);
        let re = Regex::new(r"(?m)^default\s+via\s+([0-9]+\.[0-9]+\.[0-9]+\.[0-9]+)\b").ok()?;
        return re
            .captures(&stdout)
            .and_then(|c| c.get(1).map(|m| m.as_str().to_string()));
    }

    #[cfg(target_os = "windows")]
    {
        let output = openbitfun_core::util::process_manager::create_command("route")
            .args(["print", "-4"])
            .output()
            .ok()?;
        if !output.status.success() {
            return None;
        }
        let stdout = String::from_utf8_lossy(&output.stdout);
        let re =
            Regex::new(r"(?m)^\s*0\.0\.0\.0\s+0\.0\.0\.0\s+([0-9]+\.[0-9]+\.[0-9]+\.[0-9]+)\s+")
                .ok()?;
        return re
            .captures(&stdout)
            .and_then(|c| c.get(1).map(|m| m.as_str().to_string()));
    }

    #[allow(unreachable_code)]
    None
}

/// Detect per-interface gateway IPs by parsing the system routing table.
///
/// Returns a map keyed by interface identifier (interface name on macOS/Linux,
/// interface IP on Windows) → gateway IP.  Only interfaces that have a default
/// route entry appear in the map.
fn detect_interface_gateways() -> HashMap<String, String> {
    let mut map = HashMap::new();

    #[cfg(target_os = "macos")]
    {
        if let Ok(output) = openbitfun_core::util::process_manager::create_command("netstat")
            .args(["-rn", "-f", "inet"])
            .output()
        {
            if output.status.success() {
                let stdout = String::from_utf8_lossy(&output.stdout);
                // Lines look like:
                //   default            192.168.1.1       UGScg    en0
                for line in stdout.lines() {
                    let parts: Vec<&str> = line.split_whitespace().collect();
                    if parts.len() >= 4 && parts[0] == "default" {
                        let gateway = parts[1];
                        let netif = parts[3];
                        if is_ipv4(gateway) {
                            map.insert(netif.to_string(), gateway.to_string());
                        }
                    }
                }
            }
        }
    }

    #[cfg(target_os = "linux")]
    {
        if let Ok(output) = openbitfun_core::util::process_manager::create_command("ip")
            .args(["route", "show", "default"])
            .output()
        {
            if output.status.success() {
                let stdout = String::from_utf8_lossy(&output.stdout);
                // Lines look like:
                //   default via 192.168.1.1 dev eth0 proto dhcp metric 100
                for line in stdout.lines() {
                    let parts: Vec<&str> = line.split_whitespace().collect();
                    let mut via = None;
                    let mut dev = None;
                    for i in 0..parts.len() {
                        match parts[i] {
                            "via" if i + 1 < parts.len() => via = Some(parts[i + 1]),
                            "dev" if i + 1 < parts.len() => dev = Some(parts[i + 1]),
                            _ => {}
                        }
                    }
                    if let (Some(gw), Some(iface)) = (via, dev) {
                        if is_ipv4(gw) {
                            map.insert(iface.to_string(), gw.to_string());
                        }
                    }
                }
            }
        }
    }

    #[cfg(target_os = "windows")]
    {
        if let Ok(output) = openbitfun_core::util::process_manager::create_command("route")
            .args(["print", "-4"])
            .output()
        {
            if output.status.success() {
                let stdout = String::from_utf8_lossy(&output.stdout);
                // Lines look like:
                //   0.0.0.0  0.0.0.0  192.168.1.1  192.168.1.2  25
                // Column 3 = gateway, column 4 = interface IP
                for line in stdout.lines() {
                    let parts: Vec<&str> = line.split_whitespace().collect();
                    if parts.len() >= 4
                        && parts[0] == "0.0.0.0"
                        && parts[1] == "0.0.0.0"
                        && is_ipv4(parts[2])
                        && is_ipv4(parts[3])
                    {
                        // Key by interface IP so it can be matched later
                        map.insert(parts[3].to_string(), parts[2].to_string());
                    }
                }
            }
        }
    }

    map
}

/// Quick check whether a string looks like an IPv4 address.
fn is_ipv4(s: &str) -> bool {
    s.split('.').count() == 4 && s.split('.').all(|p| p.parse::<u8>().is_ok())
}

#[tauri::command]
pub async fn remote_connect_get_device_info() -> Result<DeviceInfo, String> {
    ensure_service().await?;
    // Always read the persisted/account-adopted identity — not a stale copy
    // captured when RemoteConnectService was first constructed.
    let id = DeviceIdentity::from_current_machine().map_err(|e| format!("detect device: {e}"))?;
    Ok(DeviceInfo {
        device_id: id.device_id,
        device_name: id.device_name,
        mac_address: id.mac_address,
    })
}

#[tauri::command]
pub async fn remote_connect_get_lan_ip() -> Result<String, String> {
    lan::get_local_ip().map_err(|e| format!("get local ip: {e}"))
}

#[tauri::command]
pub async fn remote_connect_get_lan_network_info() -> Result<LanNetworkInfo, String> {
    let interfaces = lan::list_local_ips().map_err(|e| format!("list local ips: {e}"))?;
    let local_ip = interfaces
        .first()
        .map(|e| e.ip.clone())
        .ok_or_else(|| "no local IPv4 addresses found".to_string())?;
    let gateway_ip = detect_default_gateway_ip();
    // Build per-interface gateway map once from the routing table.
    let gateway_map = detect_interface_gateways();
    let available_ips = interfaces
        .into_iter()
        .map(|e| {
            // Look up by interface name (macOS/Linux) or by IP (Windows).
            let gw = gateway_map
                .get(&e.interface_name)
                .or_else(|| gateway_map.get(&e.ip))
                .cloned();
            LanNetworkInterface {
                gateway_ip: gw,
                interface_name: e.interface_name,
                ip: e.ip,
            }
        })
        .collect();
    Ok(LanNetworkInfo {
        local_ip,
        gateway_ip,
        available_ips,
    })
}

#[tauri::command]
pub async fn remote_connect_get_methods() -> Result<Vec<ConnectionMethodInfo>, String> {
    ensure_service().await?;
    let holder = get_service_holder();
    let guard = holder.read().await;
    let service = guard.as_ref().ok_or("service not initialized")?;
    let methods = service.available_methods().await;

    let infos = methods
        .into_iter()
        .map(|m| match m {
            ConnectionMethod::Lan { .. } => ConnectionMethodInfo {
                id: "lan".into(),
                name: "LAN".into(),
                available: true,
                description: "Same local network".into(),
            },
            ConnectionMethod::OpenBitFunServer => ConnectionMethodInfo {
                id: "openbitfun_server".into(),
                name: "OpenBitFun Server".into(),
                available: true,
                description: "Official OpenBitFun relay".into(),
            },
            ConnectionMethod::BotFeishu => ConnectionMethodInfo {
                id: "bot_feishu".into(),
                name: "Feishu Bot".into(),
                available: true,
                description: "Via Feishu messenger".into(),
            },
            ConnectionMethod::BotTelegram => ConnectionMethodInfo {
                id: "bot_telegram".into(),
                name: "Telegram Bot".into(),
                available: true,
                description: "Via Telegram".into(),
            },
            ConnectionMethod::BotWeixin => ConnectionMethodInfo {
                id: "bot_weixin".into(),
                name: "WeChat (Weixin)".into(),
                available: true,
                description: "Via WeChat iLink bot".into(),
            },
        })
        .collect();

    Ok(infos)
}

fn parse_connection_method(
    method: &str,
    lan_ip: Option<String>,
) -> Result<ConnectionMethod, String> {
    match method {
        "lan" => Ok(ConnectionMethod::Lan {
            ip: lan_ip.filter(|s| !s.is_empty()),
        }),
        "openbitfun_server" => Ok(ConnectionMethod::OpenBitFunServer),
        "bot_feishu" => Ok(ConnectionMethod::BotFeishu),
        "bot_telegram" => Ok(ConnectionMethod::BotTelegram),
        "bot_weixin" => Ok(ConnectionMethod::BotWeixin),
        _ => Err(format!("unknown connection method: {method}")),
    }
}

#[tauri::command]
pub async fn remote_connect_start(
    request: StartRemoteConnectRequest,
) -> Result<ConnectionResult, String> {
    ensure_service().await?;
    let method = parse_connection_method(&request.method, request.lan_ip)?;
    let _start_stop = RELAY_START_STOP_LOCK.lock().await;
    if matches!(
        method,
        ConnectionMethod::BotFeishu | ConnectionMethod::BotTelegram | ConnectionMethod::BotWeixin
    ) {
        // IM transports also require the signed-in account before pairing.
        if read_account_context().await.is_err() {
            account_login(AccountAuthRequest {}).await?;
        }
        let generation = account_context_generation();
        let _account_guard = lock_account_operation(generation).await?;
        let (session, _) = read_account_context_for_generation(generation).await?;
        let holder = get_service_holder().read().await;
        let service = holder.as_ref().ok_or("service not initialized")?;
        service.set_bot_account(Some(session.user_id)).await;
        return service
            .start(method)
            .await
            .map_err(|e| format!("start remote connect: {e}"));
    }
    let relay_url = {
        let holder = get_service_holder().read().await;
        holder
            .as_ref()
            .ok_or("service not initialized")?
            .prepare_relay(&method)
            .await
            .map_err(|e| e.to_string())?
    };
    let result = async {
        let current_url = read_account_context().await.ok().map(|(_, url)| url);
        if current_url.as_deref() != Some(relay_url.as_str()) {
            login_account_on_relay(relay_url).await?;
        }
        account_connect_devices().await?;
        let holder = get_service_holder().read().await;
        holder
            .as_ref()
            .ok_or("service not initialized")?
            .start(method)
            .await
            .map_err(|e| format!("start remote connect: {e}"))
    }
    .await;
    if result.is_err() {
        stop_and_clear_device_routing("Relay connection failed").await;
        if let Some(service) = get_service_holder().read().await.as_ref() {
            service.stop_relay().await;
        }
    }
    result
}

#[tauri::command]
pub async fn remote_connect_stop() -> Result<(), String> {
    let _start_stop = RELAY_START_STOP_LOCK.lock().await;
    stop_and_clear_device_routing("Relay stopped").await;
    let holder = get_service_holder();
    let guard = holder.read().await;
    if let Some(service) = guard.as_ref() {
        service.stop_relay().await;
    }
    Ok(())
}

#[tauri::command]
pub async fn remote_connect_stop_bot() -> Result<(), String> {
    let holder = get_service_holder();
    let guard = holder.read().await;
    if let Some(service) = guard.as_ref() {
        service.stop_bots().await;
    }
    // Remove persistence so the bot is not auto-restored
    bot::update_bot_persistence(|data| data.connections.clear());
    Ok(())
}

#[tauri::command]
pub async fn remote_connect_status() -> Result<RemoteConnectStatusResponse, String> {
    ensure_service().await?;
    let holder = get_service_holder();
    let guard = holder.read().await;
    let service = guard.as_ref().ok_or("service not initialized")?;

    let relay_connected = service.is_device_connected().await;
    let relay_url = service.device_relay_url().await;
    let clients = account_control_snapshot(std::time::Instant::now())
        .await
        .map(|(_, clients, _)| clients)
        .unwrap_or_default();
    Ok(RemoteConnectStatusResponse {
        relay_connected,
        relay_url,
        active_method: service.active_method().await,
        clients,
        bot_connected: service.bot_connected_info().await,
        bot_verbose_mode: bot::load_bot_persistence().verbose_mode,
    })
}

#[tauri::command]
pub async fn remote_connect_get_form_state() -> Result<bot::RemoteConnectFormState, String> {
    Ok(bot::load_bot_persistence().form_state)
}

#[tauri::command]
pub async fn remote_connect_set_form_state(
    request: bot::RemoteConnectFormState,
) -> Result<(), String> {
    bot::update_bot_persistence(|data| data.form_state = request);
    Ok(())
}

#[derive(Debug, Deserialize)]
pub struct ConfigureBotRequest {
    pub bot_type: String,
    pub app_id: Option<String>,
    pub app_secret: Option<String>,
    pub bot_token: Option<String>,
    pub weixin_ilink_token: Option<String>,
    pub weixin_base_url: Option<String>,
    pub weixin_bot_account_id: Option<String>,
}

#[derive(Debug, Deserialize)]
pub struct WeixinQrStartRequest {
    pub base_url: Option<String>,
    pub existing_ilink_token: Option<String>,
    pub existing_bot_account_id: Option<String>,
}

#[derive(Debug, Deserialize)]
pub struct WeixinQrPollRequest {
    pub session_key: String,
    pub base_url: Option<String>,
    pub verify_code: Option<String>,
}

#[tauri::command]
pub async fn remote_connect_configure_bot(request: ConfigureBotRequest) -> Result<(), String> {
    let holder = get_service_holder();
    let mut guard = holder.write().await;

    let bot_config = match request.bot_type.as_str() {
        "feishu" => BotConfig::Feishu {
            app_id: request.app_id.unwrap_or_default(),
            app_secret: request.app_secret.unwrap_or_default(),
        },
        "telegram" => BotConfig::Telegram {
            bot_token: request.bot_token.unwrap_or_default(),
        },
        "weixin" => BotConfig::Weixin {
            ilink_token: request.weixin_ilink_token.unwrap_or_default(),
            base_url: request.weixin_base_url.unwrap_or_default(),
            bot_account_id: request.weixin_bot_account_id.unwrap_or_default(),
        },
        _ => return Err(format!("unknown bot type: {}", request.bot_type)),
    };

    if guard.is_none() {
        let config = match bot_config {
            BotConfig::Feishu { .. } => RemoteConnectConfig {
                mobile_web_dir: detect_mobile_web_dir(),
                bot_feishu: Some(bot_config),
                ..RemoteConnectConfig::default()
            },
            BotConfig::Telegram { .. } => RemoteConnectConfig {
                mobile_web_dir: detect_mobile_web_dir(),
                bot_telegram: Some(bot_config),
                ..RemoteConnectConfig::default()
            },
            BotConfig::Weixin { .. } => RemoteConnectConfig {
                mobile_web_dir: detect_mobile_web_dir(),
                bot_weixin: Some(bot_config),
                ..RemoteConnectConfig::default()
            },
        };
        let service = new_remote_connect_service(config).map_err(|e| format!("init: {e}"))?;
        *guard = Some(service);
    } else if let Some(service) = guard.as_mut() {
        service.update_bot_config(bot_config);
    }

    Ok(())
}

#[tauri::command]
pub async fn remote_connect_weixin_qr_start(
    request: WeixinQrStartRequest,
) -> Result<weixin::WeixinQrStartResponse, String> {
    weixin::weixin_qr_start_with_existing(
        request.base_url,
        request.existing_ilink_token,
        request.existing_bot_account_id,
    )
    .await
    .map_err(|e| format!("weixin qr start: {e}"))
}

#[tauri::command]
pub async fn remote_connect_weixin_qr_poll(
    request: WeixinQrPollRequest,
) -> Result<weixin::WeixinQrPollResponse, String> {
    weixin::weixin_qr_poll(&request.session_key, request.base_url, request.verify_code)
        .await
        .map_err(|e| format!("weixin qr poll: {e}"))
}

#[tauri::command]
pub async fn remote_connect_get_bot_verbose_mode() -> Result<bool, String> {
    let data = bot::load_bot_persistence();
    Ok(data.verbose_mode)
}

#[tauri::command]
pub async fn remote_connect_set_bot_verbose_mode(verbose: bool) -> Result<(), String> {
    log::info!(
        "remote_connect_set_bot_verbose_mode called with verbose={}",
        verbose
    );
    bot::update_bot_persistence(|data| data.verbose_mode = verbose);
    log::info!("Saved bot verbose_mode={} to persistence", verbose);
    Ok(())
}

// ── Account commands ────────────────────────────────────────────────────

/// Result returned to the frontend after a successful register/login.
/// The master key is deliberately NOT included — it stays in Rust memory.
#[derive(Serialize, Deserialize, Clone)]
pub struct AccountLoginResult {
    pub user_id: String,
}

/// Current account login status (no secrets exposed).
#[derive(Serialize, Deserialize)]
pub struct AccountStatus {
    pub logged_in: bool,
    pub user_id: Option<String>,
}

/// Login uses the shared GitHub credential; no per-Relay credentials or URL.
#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
pub struct AccountAuthRequest {}

fn current_device_identity() -> Result<DeviceIdentity, String> {
    DeviceIdentity::from_current_machine().map_err(|e| format!("detect device: {e}"))
}

/// Persist the in-memory account session so restart restores login.
async fn persist_account_session(device_id: Option<&str>) -> Result<(), String> {
    // Login installs the context while its transition permit is still held;
    // this internal persistence step intentionally reads that staged value.
    let (session, relay_url) = read_account_context_raw().await?;
    session_store::save_session_with_device(
        &session.token,
        &session.user_id,
        &session.master_key,
        &relay_url,
        device_id,
    )
    .map_err(|e| format!("persist session: {e}"))
}

#[tauri::command]
pub async fn account_login(_request: AccountAuthRequest) -> Result<AccountLoginResult, String> {
    login_account_on_relay(openbitfun_product_domains::account::DEFAULT_RELAY_URL.to_string()).await
}

async fn login_account_on_relay(relay_url: String) -> Result<AccountLoginResult, String> {
    login_account_on_relay_for_generation(relay_url, None).await
}

async fn login_account_on_relay_for_generation(
    relay_url: String,
    required_generation: Option<u64>,
) -> Result<AccountLoginResult, String> {
    // Keep the old account fully usable while credentials are verified. Only a
    // successful candidate is allowed to begin the protected replacement
    // transition and retire the old account's runtime state.
    let _login_guard = ACCOUNT_LOGIN_LOCK.lock().await;
    let expected_generation = required_generation.unwrap_or_else(account_context_generation);
    if !account_context_is_current(expected_generation) {
        return Err("account context changed".to_string());
    }
    let device = current_device_identity()?;
    let client = AccountClient::new();
    let (session, profile) = client
        .login_with_identity(&relay_url, &device)
        .await
        .map_err(|e| format!("{e}"))?;

    let _room_boundary_guard = ACCOUNT_TRANSITION_BOUNDARY_LOCK.lock().await;
    if !account_context_is_current(expected_generation) {
        revoke_login_candidate(&client, &relay_url, &session, "account replacement race").await;
        return Err("account context changed".to_string());
    }
    let Some(mut transition_guard) = begin_account_transition_if_current(expected_generation).await
    else {
        revoke_login_candidate(&client, &relay_url, &session, "account replacement race").await;
        return Err("account context changed".to_string());
    };
    // The old account is now hidden, so account-backed tools must be hidden as
    // well. A committed login re-enables them after publication.
    sync_account_login_capability(false);
    let replaced_account = select_replaced_account_for_revocation(
        get_account_context().read().await.clone(),
        &relay_url,
        &session.token,
    );

    // The candidate is authenticated and the old context is now hidden. Clear
    // its device socket, presence, controllers, and account-pairing callbacks
    // before publishing the replacement context.
    stop_and_clear_device_routing("Account changed").await;
    if let Ok((previous, _)) = read_account_context_raw().await {
        if let Err(error) =
            openbitfun_core::service::filesystem::upload::retire_account_uploads(&previous.user_id)
                .await
        {
            log::warn!("Failed to clean up retired account uploads: {error}");
        }
    }
    if let Some(service) = get_service_holder().read().await.as_ref() {
        service.clear_bot_delegated_identities().await;
    }
    // Retire the prior credential before persisting the authenticated replacement.
    session_store::clear_session();

    let result = AccountLoginResult {
        user_id: session.user_id.clone(),
    };
    *get_account_context().write().await = Some(AccountContextState {
        session,
        relay_url: relay_url.clone(),
    });
    // Persist non-secret credentials for next startup pre-fill
    save_credential_hint(&profile.login, &relay_url);
    // Mirror the relay URL into the Remote Connect "Self-Hosted" server field
    // so phone pairing can ride the same relay the account is logged into.
    // Reset the token-expired flag on fresh login
    TOKEN_EXPIRED.store(false, std::sync::atomic::Ordering::Relaxed);

    if let Err(e) = persist_account_session(Some(device.device_id.as_str())).await {
        log::warn!("Failed to persist session: {e}");
    }
    register_delegated_identity_providers().await;

    // AccountClient revocation is transport-only and does not re-enter host
    // lifecycle locks. Keep the transition lease until it finishes so no
    // caller can replace B and then observe this command returning B's result.
    revoke_replaced_account(&client, replaced_account).await;
    // End context hiding before notifying listeners. Keep the transition mutex
    // until after the event so a listener's immediate account-status probe sees
    // this committed account instead of a transient logged-out state.
    transition_guard.make_context_observable();
    sync_account_login_capability(true);
    emit_account_event(
        "account://login-state",
        serde_json::json!({ "logged_in": true, "relay_url": relay_url }),
    );
    log::info!("Account logged in: {}", result.user_id);
    Ok(result)
}

#[tauri::command]
pub async fn account_status() -> Result<AccountStatus, String> {
    let context = read_account_context().await.ok();
    let logged_in = context.is_some();
    Ok(AccountStatus {
        logged_in,
        user_id: if logged_in {
            context.map(|(session, _)| session.user_id)
        } else {
            None
        },
    })
}

/// Stop account-backed runtime services and clear all local login state.
///
/// `revoke_relay_token` is false after deleting this device because the relay
/// deletion already revoked the current token along with the device row.
async fn clear_account_login(revoke_relay_token: bool) {
    // Retire account-bound operations before clearing credentials.
    let _room_boundary_guard = ACCOUNT_TRANSITION_BOUNDARY_LOCK.lock().await;
    let _operation_guard = begin_account_transition().await;
    clear_account_login_state(revoke_relay_token).await;
}

async fn clear_account_login_if_current(
    expected_generation: u64,
    expected_token: &str,
    revoke_relay_token: bool,
) -> bool {
    if !account_context_matches(expected_generation, expected_token).await {
        return false;
    }
    let _room_boundary_guard = ACCOUNT_TRANSITION_BOUNDARY_LOCK.lock().await;
    if !account_context_matches(expected_generation, expected_token).await {
        return false;
    }
    let Some(_transition_guard) = begin_account_transition_if_current(expected_generation).await
    else {
        return false;
    };
    let token_matches = get_account_context()
        .read()
        .await
        .as_ref()
        .is_some_and(|context| context.session.token == expected_token);
    if !token_matches {
        return false;
    }
    clear_account_login_state(revoke_relay_token).await;
    true
}

async fn clear_account_login_state(revoke_relay_token: bool) {
    // Account transitions hide the context immediately; hide account-backed
    // tools at the same boundary rather than after network cleanup completes.
    sync_account_login_capability(false);
    // Disconnect device routing before clearing the session.
    stop_and_clear_device_routing("Account logged out").await;
    if let Ok((previous, _)) = read_account_context_raw().await {
        if let Err(error) =
            openbitfun_core::service::filesystem::upload::retire_account_uploads(&previous.user_id)
                .await
        {
            log::warn!("Failed to clean up retired account uploads: {error}");
        }
    }
    if let Some(service) = get_service_holder().read().await.as_ref() {
        service.clear_bot_delegated_identities().await;
    }
    if revoke_relay_token {
        // Best-effort relay revocation must not prevent local logout.
        if let Ok((session, relay_url)) = read_account_context_raw().await {
            let _ = AccountClient::new()
                .revoke_token(&relay_url, &session)
                .await;
        }
    }
    *get_account_context().write().await = None;
    clear_credential_hint();
    session_store::clear_session();
    // Clear the mirrored "Self-Hosted" server field on logout.
    TOKEN_EXPIRED.store(false, std::sync::atomic::Ordering::Relaxed);
    emit_account_event(
        "account://login-state",
        serde_json::json!({ "logged_in": false }),
    );
}

#[tauri::command]
pub async fn account_logout(app: tauri::AppHandle) -> Result<(), String> {
    let mut identity = openbitfun_services_integrations::account_identity::AccountIdentityClient::from_environment()
        .await.map_err(|error| error.to_string())?;
    identity.logout().await.map_err(|error| error.to_string())?;
    clear_account_login(true).await;
    super::account_identity_api::emit_identity_changed(&app, "signed-out");
    log::info!("Account logged out");
    Ok(())
}

// ── P2: Device routing commands ──────────────────────────────────────────

#[derive(Clone, Debug, Serialize, PartialEq, Eq)]
pub struct OnlineDeviceInfo {
    pub device_id: String,
    pub device_name: String,
}

const STARTUP_DEVICE_CONNECT_MAX_ATTEMPTS: usize = 5;

async fn account_connect_devices_with_retry() -> Result<Vec<OnlineDeviceInfo>, String> {
    let expected_generation = account_context_generation();
    for attempt in 1..=STARTUP_DEVICE_CONNECT_MAX_ATTEMPTS {
        if !account_context_is_current(expected_generation) {
            return Err("account context changed".to_string());
        }
        match account_connect_devices().await {
            Ok(devices) => return Ok(devices),
            Err(error) => {
                if error_indicates_expired_token(&error)
                    || error.contains("account context changed")
                    || attempt == STARTUP_DEVICE_CONNECT_MAX_ATTEMPTS
                {
                    return Err(error);
                }
                let delay_ms = 500_u64.saturating_mul(2_u64.pow((attempt - 1) as u32));
                log::warn!(
                    "Startup device connection attempt {attempt}/{STARTUP_DEVICE_CONNECT_MAX_ATTEMPTS} \
                     failed; retrying in {delay_ms}ms: {error}"
                );
                tokio::time::sleep(std::time::Duration::from_millis(delay_ms)).await;
            }
        }
    }
    Err("device connection failed".to_string())
}

/// Connect to the account relay for device-to-device routing. Must be called
/// after `account_login`. The event receiver is consumed in a background task
/// that logs presence updates; device messages are forwarded to the RemoteConnectService.
#[tauri::command]
pub async fn account_connect_devices() -> Result<Vec<OnlineDeviceInfo>, String> {
    let account_generation = account_context_generation();
    let operation_guard = lock_account_operation(account_generation).await?;
    let (session, relay_url) = read_account_context_for_generation(account_generation).await?;
    let identity = current_device_identity()?;
    let device_name = identity.device_name.clone();
    let holder = get_service_holder().read().await;
    let service = holder
        .as_ref()
        .ok_or_else(|| "remote connect service not initialized".to_string())?;

    // Reuse is allowed only when the active socket is explicitly owned by the
    // current account generation and token. A service-level connected flag by
    // itself may still describe the account that was just replaced.
    if let Some(devices) = device_presence_for_account(account_generation, &session.token) {
        let is_connected = service.is_device_connected().await;
        if !account_context_matches(account_generation, &session.token).await {
            return Err("account context changed".to_string());
        }
        if is_connected {
            let local_id = DeviceIdentity::from_current_machine()
                .ok()
                .map(|d| d.device_id);
            let local_known = local_id
                .as_ref()
                .is_some_and(|id| devices.iter().any(|d| d.device_id == *id));
            if local_known {
                return Ok(devices);
            }
            log::info!(
            "Device WS connected but local device_id not in online set; reconnecting to heal identity"
        );
        }
    }

    cancel_pending_device_rpcs();
    let routing_lifecycle = DEVICE_ROUTING_LIFECYCLE_LOCK.write().await;

    // Invalidate the prior loop before `start_device_connection` swaps the
    // service client. Its compare-and-clear exit path must not touch this new
    // connection's controllers or presence.
    clear_device_routing_state();
    disconnect_peer_controllers("Device routing reconnecting").await;

    let (mut event_rx, auth_device_id, service_connection_id) = match service
        .start_device_connection(&relay_url, &session.token, &device_name)
        .await
    {
        Ok(result) => result,
        Err(e) => {
            let msg = format!("{e}");
            clear_device_routing_state();
            // Token invalidation re-enters the account transition path, so the
            // current account-operation lease must be released first.
            drop(routing_lifecycle);
            drop(operation_guard);
            drop(holder);
            if error_indicates_expired_token(&msg) {
                invalidate_local_account_session_if_current(
                    account_generation,
                    &session.token,
                    &msg,
                )
                .await;
            }
            return Err(msg);
        }
    };

    if !account_context_matches(account_generation, &session.token).await {
        service.stop_device_connection().await;
        clear_device_routing_state();
        return Err("account context changed".to_string());
    }
    let routing_owner =
        new_device_routing_owner(account_generation, &session.token, service_connection_id);
    install_device_routing_owner(routing_owner.clone());

    if let Err(e) = session_store::save_session_with_device(
        &session.token,
        &session.user_id,
        &session.master_key,
        &relay_url,
        Some(auth_device_id.as_str()),
    ) {
        log::warn!("Failed to persist AuthOk device_id into session: {e}");
    }

    // Background task: consume events (presence / device messages / auth errors)
    // Note: AuthOk is consumed inside start_device_connection (adopt happens there).
    let event_relay_url = relay_url.clone();
    let event_session = session.clone();
    let event_owner = routing_owner.clone();
    tokio::spawn(async move {
        use openbitfun_core::service::remote_connect::relay_client::RelayEvent;
        'routing_events: while let Some(event) = event_rx.recv().await {
            if !device_routing_owner_is_current(&event_owner).await {
                break;
            }
            match event {
                RelayEvent::AuthOk { user_id, device_id } => {
                    // Should not normally arrive — start_device_connection consumes AuthOk.
                    log::info!(
                        "Device routing auth ok (forwarded unexpectedly): user={user_id} device={device_id}"
                    );
                }
                RelayEvent::AuthError { message } => {
                    log::warn!("Device routing auth error: {message}");
                    // The socket can be rejected while the account panel is
                    // closed. Fully invalidate local state here so desktop
                    // capabilities and every UI surface agree immediately.
                    invalidate_local_account_session_if_current(
                        account_generation,
                        &event_session.token,
                        &message,
                    )
                    .await;
                    break;
                }
                RelayEvent::DevicePresence { devices } => {
                    event_session.clear_peer_keys().await;
                    let Some(_routing_effect) = lock_current_device_routing(&event_owner).await
                    else {
                        break 'routing_events;
                    };
                    let presence = devices
                        .iter()
                        .map(|device| OnlineDeviceInfo {
                            device_id: device.device_id.clone(),
                            device_name: device.device_name.clone(),
                        })
                        .collect();
                    if !replace_device_presence_if_owner(&event_owner, presence) {
                        break 'routing_events;
                    }
                    log::info!("Device presence updated: {} online", devices.len());
                    // Offline presence does not revoke an account device or its
                    // permission mailbox. Reconnect resumes the same ownership.
                    if !device_routing_owner_is_current(&event_owner).await {
                        break 'routing_events;
                    }
                    let pairs: Vec<(String, String)> = devices
                        .iter()
                        .map(|d| (d.device_id.clone(), d.device_name.clone()))
                        .collect();
                    emit_device_presence(&pairs);
                }
                RelayEvent::DeviceMessageReceived {
                    source_device_id,
                    correlation_id,
                    encrypted_data,
                    nonce,
                } => {
                    match event_session
                        .decrypt_from_peer(
                            &event_relay_url,
                            &source_device_id,
                            &encrypted_data,
                            &nonce,
                        )
                        .await
                    {
                        Ok(plaintext) => {
                            use openbitfun_core::service::remote_connect::remote_server::RemoteCommand;
                            match serde_json::from_str::<RemoteCommand>(&plaintext) {
                                Ok(RemoteCommand::DeviceEvent { event, payload }) => {
                                    let Some(_routing_effect) =
                                        lock_current_device_routing(&event_owner).await
                                    else {
                                        break 'routing_events;
                                    };
                                    // Controller receiving peer UI events — re-emit locally
                                    // under the same event name so PeerDeviceTransport listen
                                    // works. The source device is tagged onto the payload so a
                                    // controller that is also running local work can route each
                                    // stream to the right device surface.
                                    log::debug!("DeviceEvent from {source_device_id}: {event}");
                                    emit_account_event(
                                        &event,
                                        tag_peer_event_source(payload, &source_device_id),
                                    );
                                }
                                Ok(RemoteCommand::ExecuteOnDevice {
                                    session_id,
                                    content,
                                    agent_type,
                                    workspace_path,
                                }) => {
                                    let Some(_routing_effect) =
                                        lock_current_device_routing(&event_owner).await
                                    else {
                                        break 'routing_events;
                                    };
                                    log::info!(
                                        "ExecuteOnDevice from {source_device_id}: \
                                         session={:?} content_len={}",
                                        session_id,
                                        content.len()
                                    );
                                    if let Some(scheduler) = DIALOG_SCHEDULER.get() {
                                        use openbitfun_core::agentic::coordination::{
                                            DialogSubmissionPolicy, DialogTriggerSource,
                                        };
                                        let session_id = session_id
                                            .unwrap_or_else(|| uuid::Uuid::new_v4().to_string());
                                        let policy = DialogSubmissionPolicy::for_source(
                                            DialogTriggerSource::RemoteRelay,
                                        );
                                        let wp = match resolve_requested_local_workspace_path(
                                            workspace_path.as_deref(),
                                        ) {
                                            Ok(path) => path,
                                            Err(error) => {
                                                log::warn!(
                                                    "ExecuteOnDevice rejected invalid workspace: {error}"
                                                );
                                                continue;
                                            }
                                        };
                                        let agent =
                                            agent_type.unwrap_or_else(|| "Standard".to_string());
                                        if let Err(e) = scheduler
                                            .submit(
                                                session_id,
                                                content,
                                                None,
                                                None,
                                                agent,
                                                Some(wp),
                                                None,
                                                None,
                                                policy,
                                                None,
                                                None,
                                                None,
                                            )
                                            .await
                                        {
                                            log::warn!("ExecuteOnDevice failed: {e}");
                                        }
                                    } else {
                                        log::warn!(
                                            "DialogScheduler not available for ExecuteOnDevice"
                                        );
                                    }
                                    if !device_routing_owner_is_current(&event_owner).await {
                                        break 'routing_events;
                                    }
                                }
                                Ok(cmd) => {
                                    // The lease is taken here, on the loop, so a
                                    // retiring loop still notices it has been
                                    // replaced and stops reading events at once.
                                    let mut cancelled = device_rpc_cancellation().subscribe();
                                    let Some(routing_effect) =
                                        lock_current_device_routing(&event_owner).await
                                    else {
                                        break 'routing_events;
                                    };
                                    // HTTP RPC request from another device via relay.
                                    // Execute the command locally and send back
                                    // the encrypted response (including errors).
                                    log::info!(
                                        "RPC request received from relay: corr={correlation_id}"
                                    );
                                    // Spawned rather than awaited. Most commands
                                    // are answered by the webview, which can take
                                    // up to DEFAULT_INVOKE_TIMEOUT (120s) to reply;
                                    // awaiting here meant one slow command stalled
                                    // every device behind it, so a `ping` from the
                                    // watch could take 40s to come back for no
                                    // reason of its own. Each RPC carries its own
                                    // correlation id, so nothing about the reply
                                    // path depends on them finishing in order.
                                    let rpc_owner = event_owner.clone();
                                    let rpc_session = event_session.clone();
                                    let ping_generation = control_ping_generation(&rpc_owner);
                                    let ping_received_at = std::time::Instant::now();
                                    tokio::spawn(async move {
                                        tokio::select! {
                                            biased;
                                            _ = cancelled.changed() => {},
                                            _ = async move {
                                        // A transition cancels this future before
                                        // taking the write lease. Captured account
                                        // ownership cannot cross into its replacement.
                                        let _routing_effect = routing_effect;
                                        let execution = if let RemoteCommand::GetSessionKey {
                                            session_id,
                                        } = &cmd
                                        {
                                            async {
                                                let publisher=session_publisher().await.ok_or_else(||anyhow::anyhow!("Session publisher unavailable"))?;
                                                if session_id != openbitfun_core::service::remote_connect::session_log::HOST_CATALOG_ID && !session_id.starts_with("terminal-") {
                                                    openbitfun_core::service::remote_connect::synchronize_session_records(&publisher,session_id).await.map_err(anyhow::Error::msg)?;
                                                }
                                                let response_session=session_id.clone();
                                                let session_id=session_id.clone();let account=rpc_session.user_id.clone();
                                                let (relay_session_id,key)=tokio::task::spawn_blocking(move || -> anyhow::Result<(String,String)> {
                                                    use openbitfun_core::service::remote_connect::{DeviceIdentity,session_log::SessionLog};
                                                    let device=DeviceIdentity::from_current_machine()?;
                                                    let log=SessionLog::existing_for_host(&account,&device.device_id,&session_id)?;
                                                    Ok((log.relay_session_id(),log.key_grant()?))
                                                }).await??;
                                                Ok(serde_json::json!({"resp":"session_key","session_id":response_session,"relay_session_id":relay_session_id,"key":key}))
                                            }.await
                                        } else {
                                            execute_local_remote_command(&cmd).await
                                        };
                                        // Returning drops this reply only. The loop
                                        // re-checks ownership at the top of every
                                        // iteration, so a stale connection is still
                                        // retired there — just not from in here.
                                        if !device_routing_owner_is_current(&rpc_owner).await {
                                            return;
                                        }
                                        match execution {
                                            Ok(resp_value) => {
                                                let control_ping =
                                                    is_successful_control_ping(&cmd, &resp_value);
                                                let sent = send_rpc_envelope(
                                                    &rpc_owner,
                                                    &rpc_session,
                                                    &source_device_id,
                                                    &correlation_id,
                                                    resp_value,
                                                )
                                                .await;
                                                if let Some(generation) =
                                                    ping_generation.filter(|_| sent && control_ping)
                                                {
                                                    record_control_ping_if_owner(
                                                        &rpc_owner,
                                                        generation,
                                                        ping_received_at,
                                                        match &cmd {
                                                            RemoteCommand::Ping { client } => {
                                                                client.as_ref()
                                                            }
                                                            _ => None,
                                                        },
                                                    );
                                                }
                                            }
                                            Err(e) => {
                                                log::warn!("RPC: execute command failed: {e}");
                                                send_rpc_error(
                                                    &rpc_owner,
                                                    &rpc_session,
                                                    &source_device_id,
                                                    &correlation_id,
                                                    format!("RPC execute failed: {e}"),
                                                )
                                                .await;
                                            }
                                        }

                                            } => {}
                                        }
                                    });
                                }
                                Err(e) => {
                                    log::warn!("Could not parse device command: {e}");
                                    if !correlation_id.is_empty() {
                                        let Some(_routing_effect) =
                                            lock_current_device_routing(&event_owner).await
                                        else {
                                            break 'routing_events;
                                        };
                                        send_rpc_error(
                                            &event_owner,
                                            &event_session,
                                            &source_device_id,
                                            &correlation_id,
                                            format!("invalid RPC command: {e}"),
                                        )
                                        .await;
                                        if !device_routing_owner_is_current(&event_owner).await {
                                            break 'routing_events;
                                        }
                                    }
                                }
                            }
                        }
                        Err(e) => {
                            log::warn!("Failed to decrypt device message: {e}");
                            if !correlation_id.is_empty() {
                                let Some(_routing_effect) =
                                    lock_current_device_routing(&event_owner).await
                                else {
                                    break 'routing_events;
                                };
                                send_rpc_error(
                                    &event_owner,
                                    &event_session,
                                    &source_device_id,
                                    &correlation_id,
                                    format!("failed to decrypt RPC request: {e}"),
                                )
                                .await;
                                if !device_routing_owner_is_current(&event_owner).await {
                                    break 'routing_events;
                                }
                            }
                        }
                    }
                }
                RelayEvent::Disconnected => {
                    let Some(_routing_effect) = lock_current_device_routing(&event_owner).await
                    else {
                        break 'routing_events;
                    };
                    if !replace_device_presence_if_owner(&event_owner, Vec::new()) {
                        break 'routing_events;
                    }
                    clear_control_ping_if_owner(&event_owner);
                    log::info!("Device routing disconnected");
                    // Preserve pending permissions across network loss. Explicit
                    // account retirement retains the revocation path.
                    if !device_routing_owner_is_current(&event_owner).await {
                        break 'routing_events;
                    }
                    emit_device_presence(&[]);
                }
                RelayEvent::Reconnected => {
                    let Some(_routing_effect) = lock_current_device_routing(&event_owner).await
                    else {
                        break 'routing_events;
                    };
                    log::info!("Device routing reconnected — AuthConnect re-sent by transport");
                }
                _ => {}
            }
        }
        finish_device_routing_event_loop(&event_owner).await;
    });

    drop(routing_lifecycle);
    if !account_context_matches(account_generation, &session.token).await {
        return Err("account context changed".to_string());
    }
    Ok(device_presence_for_account(account_generation, &session.token).unwrap_or_default())
}

/// Get the current online device list.
#[tauri::command]
pub async fn account_online_devices() -> Result<Vec<OnlineDeviceInfo>, String> {
    let account_generation = account_context_generation();
    let (session, _) = read_account_context_for_generation(account_generation).await?;
    let _lifecycle = DEVICE_ROUTING_LIFECYCLE_LOCK.read().await;
    if !account_context_matches(account_generation, &session.token).await {
        return Err("account context changed".to_string());
    }
    Ok(device_presence_for_account(account_generation, &session.token).unwrap_or_default())
}

/// Send an encrypted session to a peer device. The `session_json` is encrypted
/// with the master key before being sent over the relay.
// ── P4: Session / settings sync commands ─────────────────────────────────

/// Execute a task on a remote device — sends an ExecuteOnDevice command
/// over the device-messaging WS pathway.
#[tauri::command]
pub async fn account_execute_on_device(
    target_device_id: String,
    session_id: Option<String>,
    content: String,
    agent_type: Option<String>,
    workspace_path: Option<String>,
) -> Result<(), String> {
    let account_generation = account_context_generation();
    let (session, relay_url) = read_account_context_for_generation(account_generation).await?;

    use openbitfun_core::service::remote_connect::remote_server::RemoteCommand;
    let envelope = serde_json::to_string(&RemoteCommand::ExecuteOnDevice {
        session_id,
        content,
        agent_type,
        workspace_path,
    })
    .map_err(|e| format!("serialize envelope: {e}"))?;

    let _routing_effect = DEVICE_ROUTING_LIFECYCLE_LOCK.read().await;
    let routing_owner = device_routing_owner_for_account(account_generation, &session.token)
        .ok_or_else(|| "device routing not connected for current account".to_string())?;
    if !device_routing_owner_is_current(&routing_owner).await {
        return Err("device routing changed".to_string());
    }
    let (encrypted_data, nonce) = session
        .encrypt_for_peer(&relay_url, &target_device_id, &envelope)
        .await
        .map_err(|e| format!("{e}"))?;

    let correlation_id = uuid::Uuid::new_v4().to_string();
    send_device_message_with_routing_lease(
        &routing_owner,
        &target_device_id,
        &correlation_id,
        &encrypted_data,
        &nonce,
    )
    .await
}

/// List all online devices in the account via the relay HTTP API.
/// Returns `(device_id, device_name)` pairs.
#[derive(Serialize)]
pub struct AccountDeviceInfo {
    pub device_id: String,
    pub device_name: String,
    pub online: bool,
    pub last_seen_at: Option<i64>,
}

#[tauri::command]
pub async fn account_list_devices() -> Result<Vec<AccountDeviceInfo>, String> {
    let generation = account_context_generation();
    let (session, relay_url) = read_account_context_for_generation(generation).await?;
    let client = AccountClient::new();
    let devices = match client.list_devices(&relay_url, &session).await {
        Ok(devices) => devices,
        Err(e) => {
            let msg = format!("{e}");
            if error_indicates_expired_token(&msg) {
                invalidate_local_account_session_if_current(generation, &session.token, &msg).await;
            }
            return Err(msg);
        }
    };
    if !account_context_is_current(generation) {
        return Err("account context changed".to_string());
    }
    Ok(devices
        .into_iter()
        .map(|d| AccountDeviceInfo {
            device_id: d.device_id,
            device_name: d.device_name,
            online: d.online,
            last_seen_at: d.last_seen_at,
        })
        .collect())
}

/// Remove a device from the account.
#[tauri::command]
pub async fn account_delete_device(targetDeviceId: String) -> Result<(), String> {
    let generation = account_context_generation();
    let (session, relay_url) = read_account_context_for_generation(generation).await?;
    let is_current_device = current_device_identity()?.device_id == targetDeviceId;
    if let Err(error) = AccountClient::new()
        .delete_device(&relay_url, &session, &targetDeviceId)
        .await
    {
        let message = error.to_string();
        if error_indicates_expired_token(&message) {
            invalidate_local_account_session_if_current(generation, &session.token, &message).await;
        }
        return Err(message);
    }
    if !account_context_is_current(generation) {
        return Err("account context changed".to_string());
    }
    log::info!("Device {targetDeviceId} removed from account");
    if is_current_device {
        if clear_account_login_if_current(generation, &session.token, false).await {
            log::info!("Current device removed; local account session cleared");
        } else {
            return Err("account context changed".to_string());
        }
    }
    Ok(())
}

/// Send any RemoteCommand to a target device via HTTP RPC.
/// The command is encrypted with the master_key, sent to the relay,
/// which routes it to the target device's WS. The target executes it
/// and the response is returned (decrypted).
/// Returns the decrypted response JSON.
const ACCOUNT_DEVICE_RPC_DEFAULT_TIMEOUT_MS: u64 = 120_000;
const ACCOUNT_DEVICE_RPC_MIN_TIMEOUT_MS: u64 = 1_000;

fn account_device_rpc_timeout_ms(requested: Option<u64>) -> u64 {
    requested
        .unwrap_or(ACCOUNT_DEVICE_RPC_DEFAULT_TIMEOUT_MS)
        .clamp(
            ACCOUNT_DEVICE_RPC_MIN_TIMEOUT_MS,
            ACCOUNT_DEVICE_RPC_DEFAULT_TIMEOUT_MS,
        )
}

#[tauri::command]
pub async fn account_device_rpc(
    target_device_id: String,
    command_json: String,
    timeout_ms: Option<u64>,
) -> Result<String, String> {
    let account_generation = account_context_generation();
    let (session, relay_url) = read_account_context_for_generation(account_generation).await?;
    let client = AccountClient::new();
    let timeout_ms = account_device_rpc_timeout_ms(timeout_ms);
    let response = tokio::time::timeout(
        std::time::Duration::from_millis(timeout_ms),
        client.device_rpc(&relay_url, &session, &target_device_id, &command_json),
    )
    .await
    .map_err(|_| format!("device RPC timed out after {timeout_ms}ms"))?
    .map_err(|e| format!("{e}"))?;
    if !account_context_matches(account_generation, &session.token).await {
        return Err("account context changed".to_string());
    }
    Ok(response)
}

/// Result of an auto-sync operation, returned to the frontend.
fn resolve_requested_local_workspace_path(workspace_path: Option<&str>) -> Result<String, String> {
    let requested = workspace_path
        .map(str::trim)
        .filter(|path| !path.is_empty())
        .ok_or_else(|| "workspace_path is required".to_string())?;
    let path = std::path::PathBuf::from(requested);
    if !path.is_absolute() {
        return Err("workspace_path must be absolute".to_string());
    }
    let canonical = path
        .canonicalize()
        .map_err(|error| format!("resolve workspace_path: {error}"))?;
    if !canonical.is_dir() {
        return Err("workspace_path is not a directory".to_string());
    }
    canonical
        .to_str()
        .map(ToOwned::to_owned)
        .ok_or_else(|| "workspace_path is not valid UTF-8".to_string())
}

/// Execute a RemoteCommand locally (for RPC requests from other devices).
/// Returns the RemoteResponse serialized as JSON to be encrypted and sent back.
async fn execute_local_remote_command(
    cmd: &openbitfun_core::service::remote_connect::remote_server::RemoteCommand,
) -> anyhow::Result<serde_json::Value> {
    use openbitfun_core::service::remote_connect::remote_server::{RemoteCommand, RemoteResponse};

    match cmd {
        RemoteCommand::HostInvoke { command, args } => {
            // Detached jobs are independent of Peer controller attachment.
            // Route their distinct target command family directly to the
            // durable dispatch runner before the generic webview bridge.
            if crate::api::dispatch_host::is_target_command(command) {
                let result = crate::api::dispatch_host::dispatch(command, args.clone()).await;
                let (ok, value, error) = match result {
                    Ok(value) => (true, Some(value), None),
                    Err(error) => (false, None, Some(format!("{error:#}"))),
                };
                return serde_json::to_value(RemoteResponse::HostInvokeResult { ok, value, error })
                    .map_err(|e| anyhow::anyhow!("serialize response: {e}"));
            }

            // Control-plane peer attach/detach/ping can run without webview bridge.
            if command == "peer_control_attach" {
                let controller_id = args
                    .get("controllerDeviceId")
                    .or_else(|| args.get("controller_device_id"))
                    .and_then(|v| v.as_str())
                    .unwrap_or("")
                    .to_string();
                crate::api::peer_host_invoke::attach_controller(controller_id);
                return serde_json::to_value(RemoteResponse::HostInvokeResult {
                    ok: true,
                    value: Some(serde_json::json!({ "attached": true })),
                    error: None,
                })
                .map_err(|e| anyhow::anyhow!("serialize response: {e}"));
            }
            if command == "peer_control_detach" {
                let controller_id = args
                    .get("controllerDeviceId")
                    .or_else(|| args.get("controller_device_id"))
                    .and_then(|v| v.as_str())
                    .unwrap_or("");
                let request_ids = crate::api::peer_host_invoke::detach_controller(controller_id);
                crate::api::peer_host_invoke::fail_closed_permission_requests(
                    request_ids,
                    "Last Peer controller detached",
                )
                .await
                .map_err(anyhow::Error::msg)?;
                return serde_json::to_value(RemoteResponse::HostInvokeResult {
                    ok: true,
                    value: Some(serde_json::json!({ "detached": true })),
                    error: None,
                })
                .map_err(|e| anyhow::anyhow!("serialize response: {e}"));
            }
            if command == "peer_mode_ping" {
                let value = crate::api::peer_host_invoke::peer_mode_ping()
                    .await
                    .map_err(|e| anyhow::anyhow!(e))?;
                return serde_json::to_value(RemoteResponse::HostInvokeResult {
                    ok: true,
                    value: Some(value),
                    error: None,
                })
                .map_err(|e| anyhow::anyhow!("serialize response: {e}"));
            }

            let result = crate::api::peer_host_invoke::dispatch(command, args.clone()).await;
            serde_json::to_value(RemoteResponse::HostInvokeResult {
                ok: result.ok,
                value: result.value,
                error: result.error,
            })
            .map_err(|e| anyhow::anyhow!("serialize response: {e}"))
        }
        RemoteCommand::DeviceEvent { event, payload } => {
            // Peer→controller events are handled on the controller; on peer this is a no-op ack.
            let _ = (event, payload);
            serde_json::to_value(RemoteResponse::DeviceEventAccepted)
                .map_err(|e| anyhow::anyhow!("serialize response: {e}"))
        }
        other => {
            // RemoteServer uses the global dispatcher internally — no need for
            // manual coordinator access. The dummy shared secret is irrelevant
            // because we call dispatch() directly (encryption is handled at the
            // RPC envelope level, not here).
            let server = openbitfun_core::service::remote_connect::RemoteServer::new([0u8; 32]);
            let response = server.dispatch(other).await;
            serde_json::to_value(&response).map_err(|e| anyhow::anyhow!("serialize response: {e}"))
        }
    }
}

#[cfg(test)]
mod sync_state_tests {
    use super::*;

    /// Serializes these tests against the process-global account context.
    /// Async-aware so the guard may be held across each test's awaits; the
    /// plain `#[test]` cases take it with `blocking_lock`, which cannot stall
    /// because they run without an ambient runtime.
    static ACCOUNT_CONTEXT_TEST_LOCK: tokio::sync::Mutex<()> = tokio::sync::Mutex::const_new(());

    #[test]
    fn account_control_clients_deduplicate_expire_and_fence_disconnects() {
        use openbitfun_services_integrations::remote_connect::{
            relay_client::RELAY_INBOUND_IDLE_TIMEOUT, RemoteControlClient,
        };
        let _test_guard = ACCOUNT_CONTEXT_TEST_LOCK.blocking_lock();
        let owner = new_device_routing_owner(1, "clients", 1);
        install_device_routing_owner(owner.clone());
        let now = std::time::Instant::now();
        let later = now + std::time::Duration::from_secs(10);
        let phone = RemoteControlClient {
            id: "phone".into(),
            name: "Safari · iOS".into(),
        };
        let browser = RemoteControlClient {
            id: "browser".into(),
            name: "Chrome · Windows".into(),
        };
        record_control_ping_if_owner(&owner, 0, now, Some(&phone));
        record_control_ping_if_owner(&owner, 0, later, Some(&browser));
        record_control_ping_if_owner(&owner, 0, now, Some(&browser));
        assert_eq!(
            account_control_clients(&owner, later),
            (vec![browser.clone(), phone], false)
        );
        assert_eq!(
            account_control_clients(&owner, now + RELAY_INBOUND_IDLE_TIMEOUT),
            (vec![browser], false)
        );
        record_control_ping_if_owner(&owner, 0, later, None);
        assert!(account_control_clients(&owner, later).1);
        clear_control_ping_if_owner(&owner);
        record_control_ping_if_owner(&owner, 0, later, None);
        assert_eq!(account_control_clients(&owner, later), (vec![], false));
        install_device_routing_owner(new_device_routing_owner(2, "replacement", 2));
        assert_eq!(account_control_clients(&owner, later), (vec![], false));
        clear_device_routing_state();
    }

    #[test]
    fn account_control_ping_requires_a_successful_control_response() {
        use openbitfun_core::service::remote_connect::remote_server::RemoteCommand;
        assert!(is_successful_control_ping(
            &RemoteCommand::Ping { client: None },
            &serde_json::json!({"resp": "pong"})
        ));
        assert!(!is_successful_control_ping(
            &RemoteCommand::Ping { client: None },
            &serde_json::json!({"resp": "error"})
        ));
        let peer_ping = RemoteCommand::HostInvoke {
            command: "peer_mode_ping".into(),
            args: serde_json::json!({}),
        };
        assert!(!is_successful_control_ping(
            &peer_ping,
            &serde_json::json!({"resp": "host_invoke_result", "ok": true})
        ));
        assert!(!is_successful_control_ping(
            &peer_ping,
            &serde_json::json!({"resp": "host_invoke_result", "ok": false})
        ));
        let directory = RemoteCommand::HostInvoke {
            command: "account_list_devices".into(),
            args: serde_json::json!({}),
        };
        assert!(!is_successful_control_ping(
            &directory,
            &serde_json::json!({"resp": "host_invoke_result", "ok": true})
        ));
    }

    #[test]
    fn account_control_ping_expires_disconnects_and_fences_replaced_routes() {
        use openbitfun_services_integrations::remote_connect::relay_client::RELAY_INBOUND_IDLE_TIMEOUT;
        let _test_guard = ACCOUNT_CONTEXT_TEST_LOCK.blocking_lock();
        let first = new_device_routing_owner(1, "first", 1);
        let second = new_device_routing_owner(2, "second", 2);
        let now = std::time::Instant::now();
        install_device_routing_owner(first.clone());
        assert!(!has_recent_control_ping(&first, now));
        record_control_ping_if_owner(&first, 0, now, None);
        assert!(has_recent_control_ping(&first, now));
        assert!(!has_recent_control_ping(
            &first,
            now + RELAY_INBOUND_IDLE_TIMEOUT
        ));
        clear_control_ping_if_owner(&first);
        assert!(!has_recent_control_ping(&first, now));
        record_control_ping_if_owner(&first, 0, now, None);
        assert!(
            !has_recent_control_ping(&first, now),
            "a queued pre-disconnect ping must not revive connectivity"
        );
        let reconnected = control_ping_generation(&first).unwrap();
        record_control_ping_if_owner(&first, reconnected, now, None);
        assert!(has_recent_control_ping(&first, now));
        install_device_routing_owner(second.clone());
        record_control_ping_if_owner(&first, 0, now, None);
        assert!(!has_recent_control_ping(&first, now));
        assert!(!has_recent_control_ping(&second, now));
        record_control_ping_if_owner(&second, 0, now, None);
        clear_control_ping_if_owner(&first);
        assert!(has_recent_control_ping(&second, now));
        let newer = now + std::time::Duration::from_secs(1);
        record_control_ping_if_owner(&second, 0, newer, None);
        record_control_ping_if_owner(&second, 0, now, None);
        assert!(has_recent_control_ping(
            &second,
            now + RELAY_INBOUND_IDLE_TIMEOUT
        ));
        assert!(!has_recent_control_ping(
            &second,
            newer + RELAY_INBOUND_IDLE_TIMEOUT
        ));
        clear_device_routing_state();
        assert!(!has_recent_control_ping(&second, now));
    }

    #[tokio::test(flavor = "current_thread")]
    async fn account_control_status_uses_its_own_route_without_a_room_invitation() {
        use openbitfun_services_integrations::remote_connect::relay_client::RELAY_INBOUND_IDLE_TIMEOUT;
        let _test_guard = ACCOUNT_CONTEXT_TEST_LOCK.lock().await;
        let relay_url = "https://relay.example/base/";
        *get_account_context().write().await = Some(AccountContextState {
            session: AccountSession::new("control-token".into(), "control-user".into(), [7; 32]),
            relay_url: relay_url.into(),
        });
        let owner = new_device_routing_owner(account_context_generation(), "control-token", 1);
        install_device_routing_owner(owner.clone());
        let now = std::time::Instant::now();
        assert_eq!(
            account_control_relay_url(now).await,
            None,
            "login alone is not a connection"
        );

        record_control_ping_if_owner(&owner, 0, now, None);
        assert_eq!(
            account_control_relay_url(now).await.as_deref(),
            Some(relay_url)
        );
        assert_eq!(
            account_control_relay_url(now + RELAY_INBOUND_IDLE_TIMEOUT).await,
            None
        );
        clear_control_ping_if_owner(&owner);
        assert_eq!(account_control_relay_url(now).await, None);

        let reconnect_generation = control_ping_generation(&owner).unwrap();
        record_control_ping_if_owner(&owner, reconnect_generation, now, None);
        assert_eq!(
            account_control_relay_url(now).await.as_deref(),
            Some(relay_url)
        );
        let transition = AccountContextTransitionPermit::begin();
        assert_eq!(account_control_relay_url(now).await, None);
        drop(transition);
        assert_eq!(
            account_control_relay_url(now).await,
            None,
            "a previous account route cannot revive after a transition"
        );
        clear_device_routing_state();
        *get_account_context().write().await = None;
    }

    #[test]
    fn relay_status_has_one_account_device_contract_for_both_endpoints() {
        for (method, endpoint) in [
            (
                serde_json::json!("openbitfun_server"),
                "https://remote.openbitfun.com/v/1.0.1",
            ),
            (
                serde_json::json!({"lan":{"ip":"192.168.1.2"}}),
                "http://192.168.1.2:9700",
            ),
        ] {
            let payload = serde_json::json!({
                "relay_connected": true, "relay_url": endpoint, "active_method": method,
                "clients": [{"id":"phone","name":"Safari"}],
                "bot_connected": null, "bot_verbose_mode": false,
            });
            let status: RemoteConnectStatusResponse =
                serde_json::from_value(payload.clone()).unwrap();
            assert_eq!(serde_json::to_value(status).unwrap(), payload);
        }
    }

    #[test]
    fn relay_url_normalization_removes_all_trailing_slashes() {
        assert_eq!(
            normalize_relay_url("https://relay.example.com///").unwrap(),
            "https://relay.example.com"
        );
    }

    #[test]
    fn device_rpc_timeout_is_bounded_for_peer_requests() {
        assert_eq!(
            account_device_rpc_timeout_ms(None),
            ACCOUNT_DEVICE_RPC_DEFAULT_TIMEOUT_MS
        );
        assert_eq!(account_device_rpc_timeout_ms(Some(10_000)), 10_000);
        assert_eq!(
            account_device_rpc_timeout_ms(Some(100)),
            ACCOUNT_DEVICE_RPC_MIN_TIMEOUT_MS
        );
        assert_eq!(
            account_device_rpc_timeout_ms(Some(u64::MAX)),
            ACCOUNT_DEVICE_RPC_DEFAULT_TIMEOUT_MS
        );
    }

    #[test]
    fn replaced_token_revocation_never_selects_the_published_credential() {
        let account = |token: &str, relay_url: &str| AccountContextState {
            session: AccountSession::new(token.to_string(), "user-a".to_string(), [7; 32]),
            relay_url: relay_url.to_string(),
        };

        assert!(select_replaced_account_for_revocation(
            Some(account("token-b", "https://relay.example.com")),
            "https://relay.example.com",
            "token-b",
        )
        .is_none());
        let same_account_old_token = select_replaced_account_for_revocation(
            Some(account("token-a", "https://relay.example.com")),
            "https://relay.example.com",
            "token-b",
        )
        .expect("same-account relogin must revoke the old token");
        assert_eq!(same_account_old_token.session.token, "token-a");
        let other_relay = select_replaced_account_for_revocation(
            Some(account("same-token", "https://relay-a.example.com")),
            "https://relay-b.example.com",
            "same-token",
        )
        .expect("the same token text on a different relay is a distinct credential");
        assert_eq!(other_relay.relay_url, "https://relay-a.example.com");
    }

    #[tokio::test(flavor = "current_thread")]
    async fn external_account_reads_are_hidden_during_transition() {
        let _test_guard = ACCOUNT_CONTEXT_TEST_LOCK.lock().await;
        *get_account_context().write().await = Some(AccountContextState {
            session: AccountSession::new("token-a".to_string(), "user-a".to_string(), [7; 32]),
            relay_url: "https://relay.example.com".to_string(),
        });
        assert!(read_account_context().await.is_ok());

        let permit = AccountContextTransitionPermit::begin();
        assert!(read_account_context().await.is_err());
        assert!(read_account_context_raw().await.is_ok());
        drop(permit);

        *get_account_context().write().await = None;
    }

    #[tokio::test(flavor = "current_thread")]
    async fn login_event_probe_sees_context_before_transition_mutex_is_released() {
        let _test_guard = ACCOUNT_CONTEXT_TEST_LOCK.lock().await;
        let transition_guard = ACCOUNT_CONTEXT_TRANSITION_LOCK.lock().await;
        let transition = AccountContextTransitionPermit::begin();
        let mut guard = AccountContextTransitionGuard {
            operation_guard: None,
            transition: Some(transition),
            transition_guard: Some(transition_guard),
        };

        assert!(!account_context_is_current(account_context_generation()));
        guard.make_context_observable();
        assert!(account_context_is_current(account_context_generation()));
        assert!(ACCOUNT_CONTEXT_TRANSITION_LOCK.try_lock().is_err());

        drop(guard);
        assert!(ACCOUNT_CONTEXT_TRANSITION_LOCK.try_lock().is_ok());
    }

    #[test]
    fn stale_routing_owner_cannot_clear_or_update_replacement() {
        let _test_guard = ACCOUNT_CONTEXT_TEST_LOCK.blocking_lock();
        clear_device_routing_state();
        let owner_a = DeviceRoutingOwner {
            account_generation: 10,
            account_token: "token-a".to_string(),
            connection_id: 1,
            service_connection_id: 101,
        };
        let owner_b = DeviceRoutingOwner {
            account_generation: 12,
            account_token: "token-b".to_string(),
            connection_id: 2,
            service_connection_id: 102,
        };
        install_device_routing_owner(owner_a.clone());
        assert!(replace_device_presence_if_owner(
            &owner_a,
            vec![OnlineDeviceInfo {
                device_id: "a-device".to_string(),
                device_name: "A".to_string(),
            }],
        ));

        install_device_routing_owner(owner_b.clone());
        assert!(!replace_device_presence_if_owner(
            &owner_a,
            vec![OnlineDeviceInfo {
                device_id: "late-a-device".to_string(),
                device_name: "Late A".to_string(),
            }],
        ));
        assert!(!clear_device_routing_if_owner(&owner_a));
        assert_eq!(
            device_presence_for_account(owner_b.account_generation, &owner_b.account_token),
            Some(Vec::new())
        );
        assert!(clear_device_routing_if_owner(&owner_b));
    }

    #[test]
    fn routing_presence_is_bound_to_account_generation_and_token() {
        let _test_guard = ACCOUNT_CONTEXT_TEST_LOCK.blocking_lock();
        clear_device_routing_state();
        let owner = DeviceRoutingOwner {
            account_generation: 20,
            account_token: "token-current".to_string(),
            connection_id: 3,
            service_connection_id: 103,
        };
        install_device_routing_owner(owner.clone());
        assert!(replace_device_presence_if_owner(
            &owner,
            vec![OnlineDeviceInfo {
                device_id: "current-device".to_string(),
                device_name: "Current".to_string(),
            }],
        ));

        assert!(device_presence_for_account(20, "token-current").is_some());
        assert!(device_presence_for_account(21, "token-current").is_none());
        assert!(device_presence_for_account(20, "token-replaced").is_none());
        clear_device_routing_state();
    }
}

#[cfg(test)]
mod peer_event_tests {
    use super::should_fanout_peer_ui_event;

    #[test]
    fn permission_events_are_fanned_out_to_peer_controllers() {
        assert!(should_fanout_peer_ui_event("permission://event"));
        assert!(!should_fanout_peer_ui_event("permission://internal"));
    }

    #[test]
    fn model_catalog_updates_are_fanned_out_to_peer_controllers() {
        assert!(should_fanout_peer_ui_event("ai://model-catalog-updated"));
    }
}

static SESSION_SUBSCRIPTIONS: OnceLock<
    std::sync::Mutex<
        std::collections::HashMap<
            String,
            openbitfun_core::service::remote_connect::session_subscriber::SessionSubscriber,
        >,
    >,
> = OnceLock::new();

fn clear_session_subscriptions() {
    if let Some(subscriptions) = SESSION_SUBSCRIPTIONS.get() {
        if let Ok(mut subscriptions) = subscriptions.lock() {
            subscriptions.clear();
        }
    }
}

#[derive(Deserialize)]
pub struct SubscribeSessionRequest {
    target_device_id: String,
    session_id: String,
}
#[derive(Deserialize)]
pub struct UnsubscribeSessionRequest {
    subscription_id: String,
}

#[tauri::command]
pub async fn account_load_older_session(request: UnsubscribeSessionRequest) -> Result<(), String> {
    let load = {
        let subscriptions = SESSION_SUBSCRIPTIONS
            .get_or_init(|| std::sync::Mutex::new(std::collections::HashMap::new()))
            .lock()
            .map_err(|_| "session subscription owner unavailable")?;
        subscriptions
            .get(&request.subscription_id)
            .ok_or("session subscription is no longer active")?
            .load_older()
    };
    load.await.map_err(|error| error.to_string())
}

#[tauri::command]
pub async fn account_subscribe_session(request: SubscribeSessionRequest) -> Result<String, String> {
    let generation = account_context_generation();
    let (session, relay) = read_account_context_for_generation(generation).await?;
    let source = request.target_device_id.clone();
    let error_source = source.clone();
    let error_session_id = request.session_id.clone();
    let subscriber =
        openbitfun_core::service::remote_connect::session_subscriber::SessionSubscriber::start(
            session,
            relay,
            request.target_device_id,
            request.session_id,
            Arc::new(move |event| {
                if !account_context_is_current(generation) {
                    anyhow::bail!("account subscription retired");
                }
                emit_account_event(&event.event, tag_peer_event_source(event.payload, &source));
                Ok(())
            }),
            Arc::new(move |error| {
                if account_context_is_current(generation) {
                    emit_account_event(
                        "account://session-sync-error",
                        serde_json::json!({"message":error,"sessionId":error_session_id,"targetDeviceId":error_source}),
                    );
                }
            }),
        )
        .await
        .map_err(|e| e.to_string())?;
    let id = uuid::Uuid::new_v4().to_string();
    let mut subscriptions = SESSION_SUBSCRIPTIONS
        .get_or_init(|| std::sync::Mutex::new(std::collections::HashMap::new()))
        .lock()
        .map_err(|_| "session subscription owner unavailable")?;
    if !account_context_is_current(generation) {
        return Err("account context changed".into());
    }
    subscriptions.insert(id.clone(), subscriber);
    Ok(id)
}

#[tauri::command]
pub async fn account_unsubscribe_session(request: UnsubscribeSessionRequest) -> Result<(), String> {
    if let Some(subscriptions) = SESSION_SUBSCRIPTIONS.get() {
        subscriptions
            .lock()
            .map_err(|_| "session subscription owner unavailable")?
            .remove(&request.subscription_id);
    }
    Ok(())
}
