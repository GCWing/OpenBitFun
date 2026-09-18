//! CLI adapter for account-backed device routing.
//!
//! Shared account identity, persistence and transitions are
//! owned by [`AccountRuntime`]. This module contains only CLI Host effects:
//! daemon retirement, Relay routing, and Peer Device Mode fan-out fencing.

use std::sync::{Arc, OnceLock, Weak};
use std::time::Duration;

use anyhow::{anyhow, Result};
use async_trait::async_trait;
use openbitfun_product_domains::account::{AccountDevice, AccountInfo, AccountSnapshotProjection};
use tokio::sync::RwLock;

use openbitfun_core::service::remote_connect::account::AccountSession;
use openbitfun_core::service::remote_connect::account_runtime::{
    AccountRoutingStartRequest, AccountRuntime, AccountRuntimeHost,
    BackgroundRoutingOwnerRetirementError,
};
use openbitfun_core::service::remote_connect::{
    self, encryption, relay_client::RelayClient, relay_client::RelayEvent, session_store,
    DeviceIdentity, RemoteServer,
};

pub(crate) struct CliAccountRuntimeParts {
    pub(crate) runtime: Arc<AccountRuntime>,
    pub(crate) routing: Arc<CliAccountRoutingHost>,
}

pub(crate) fn build_account_runtime() -> CliAccountRuntimeParts {
    let routing = CliAccountRoutingHost::new();
    let runtime = AccountRuntime::new(routing.clone());
    routing.bind_runtime(Arc::downgrade(&runtime));
    CliAccountRuntimeParts { runtime, routing }
}

pub(crate) fn build_management_account_runtime() -> Arc<AccountRuntime> {
    build_account_runtime().runtime
}

pub(crate) fn account_snapshot_projection(
    snapshot: openbitfun_core::service::remote_connect::account_runtime::AccountSnapshot,
) -> AccountSnapshotProjection {
    AccountSnapshotProjection {
        logged_in: snapshot.logged_in,
        info: snapshot.info.map(|info| AccountInfo {
            user_id: info.user_id,
            relay_url: info.relay_url,
            device_id: info.device_id,
            device_name: info.device_name,
        }),
        devices: snapshot
            .devices
            .into_iter()
            .map(|device| AccountDevice {
                device_id: device.device_id,
                device_name: device.device_name,
                online: device.online,
            })
            .collect(),
    }
}

pub(crate) fn account_login_status_message(
    result: &openbitfun_core::service::remote_connect::account_runtime::AccountLoginResult,
) -> String {
    if result.routing_connected {
        format!(
            "Logged in as user {} on {}. Device routing connected.",
            result.user_id, result.relay_url
        )
    } else if let Some(error) = &result.routing_error {
        format!(
            "Logged in as user {} on {}. Device routing failed: {}",
            result.user_id,
            result.relay_url,
            bounded_account_error(error)
        )
    } else {
        format!(
            "Logged in as user {} on {}.",
            result.user_id, result.relay_url
        )
    }
}

pub(crate) fn redact_login_error(error: anyhow::Error, secrets: [&str; 3]) -> anyhow::Error {
    let mut message = error.to_string();
    for secret in secrets {
        if !secret.is_empty() {
            message = message.replace(secret, "<redacted>");
        }
    }
    anyhow!(bounded_account_error(&message))
}

fn bounded_account_error(message: &str) -> String {
    message
        .chars()
        .filter(|character| !character.is_control())
        .take(500)
        .collect()
}

/// CLI-owned routing effects injected into the shared Account Runtime.
pub(crate) struct CliAccountRoutingHost {
    host_stream_hub:
        RwLock<Option<Arc<openbitfun_core::service::remote_connect::host_stream::HostStreamHub>>>,
    self_ref: Weak<CliAccountRoutingHost>,
    runtime: OnceLock<Weak<AccountRuntime>>,
    relay_client: RwLock<Option<Arc<RelayClient>>>,
    /// Read leases cover one routing event through its response. Routing owner
    /// changes take the write lease, so old events cannot escape through a new
    /// account's Relay client.
    lifecycle: Arc<RwLock<()>>,
    routing_cancel: tokio::sync::watch::Sender<u64>,
}

impl CliAccountRoutingHost {
    fn new() -> Arc<Self> {
        Arc::new_cyclic(|self_ref| Self {
            self_ref: self_ref.clone(),
            host_stream_hub: RwLock::new(None),
            runtime: OnceLock::new(),
            relay_client: RwLock::new(None),
            lifecycle: Arc::new(RwLock::new(())),
            routing_cancel: tokio::sync::watch::channel(0).0,
        })
    }

    /// Host streams served to controllers while this device's routing is alive.
    pub(crate) async fn host_stream_hub(
        &self,
    ) -> Option<Arc<openbitfun_core::service::remote_connect::host_stream::HostStreamHub>> {
        self.host_stream_hub.read().await.clone()
    }

    fn bind_runtime(&self, runtime: Weak<AccountRuntime>) {
        self.runtime
            .set(runtime)
            .unwrap_or_else(|_| panic!("CLI account routing runtime was bound twice"));
    }

    fn runtime(&self) -> Result<Arc<AccountRuntime>> {
        self.runtime
            .get()
            .and_then(Weak::upgrade)
            .ok_or_else(|| anyhow!("account runtime is unavailable"))
    }

    async fn start_routing(&self, request: AccountRoutingStartRequest) -> Result<()> {
        let runtime = self.runtime()?;
        if !runtime.account_context_is_current(request.account_generation) {
            return Err(anyhow!("account context changed"));
        }
        self.stop_routing().await;

        let (client, mut event_rx) = RelayClient::new();
        client.connect(&request.relay_url).await?;
        client
            .connect_authenticated(&request.session.token, &request.device_name)
            .await?;
        let client = Arc::new(client);
        {
            let _routing_guard = self.lifecycle.write().await;
            if !runtime.account_context_is_current(request.account_generation) {
                client.disconnect().await;
                return Err(anyhow!("account context changed"));
            }
            *self.relay_client.write().await = Some(client.clone());
        }
        if !runtime.account_context_is_current(request.account_generation) {
            self.retire_routing_client_if_same(&client).await;
            client.disconnect().await;
            return Err(anyhow!("account context changed"));
        }

        let routing = self
            .self_ref
            .upgrade()
            .ok_or_else(|| anyhow!("account routing is unavailable"))?;
        let expected_token = request.session.token;
        let generation = request.account_generation;
        tokio::spawn(async move {
            loop {
                if !routing.routing_loop_is_current(generation, &client).await {
                    tracing::debug!("Stopping stale device routing event loop");
                    break;
                }
                let Some(event) = event_rx.recv().await else {
                    break;
                };
                if !routing.routing_loop_is_current(generation, &client).await {
                    tracing::debug!("Stopping stale device routing event loop");
                    break;
                }
                if matches!(&event, RelayEvent::DeviceMessageReceived { .. }) {
                    let routing = routing.clone();
                    let client = client.clone();
                    let token = expected_token.clone();
                    tokio::spawn(async move {
                        routing
                            .handle_relay_event(event, &client, generation, &token)
                            .await;
                    });
                } else {
                    routing
                        .handle_relay_event(event, &client, generation, &expected_token)
                        .await;
                }
            }
            routing.retire_routing_client_if_same(&client).await;
            tracing::info!("Device routing event loop exited");
        });
        Ok(())
    }

    async fn stop_routing(&self) {
        // Wake and retire pending RPC futures before waiting for their leases.
        // Cancellation does not imply rollback; an interrupted mutation is never replayed.
        self.routing_cancel
            .send_modify(|epoch| *epoch = epoch.wrapping_add(1));
        let _routing_guard = self.lifecycle.write().await;
        self.stop_routing_locked().await;
    }

    pub(crate) async fn stop_device_routing(&self) {
        self.stop_routing().await;
    }

    async fn stop_routing_locked(&self) {
        if let Some(hub) = self.host_stream_hub.write().await.take() {
            hub.close();
        }
        if let Some(client) = self.relay_client.write().await.take() {
            client.disconnect().await;
        }
        crate::peer_host::update_controller_presence(Vec::new()).await;
    }

    async fn is_current_routing_client(&self, client: &Arc<RelayClient>) -> bool {
        same_routing_client(self.relay_client.read().await.as_ref(), client)
    }

    async fn routing_loop_is_current(
        &self,
        account_generation: u64,
        client: &Arc<RelayClient>,
    ) -> bool {
        let Ok(runtime) = self.runtime() else {
            return false;
        };
        if !runtime.account_context_is_current(account_generation) {
            return false;
        }
        let matches = self.is_current_routing_client(client).await;
        matches && runtime.account_context_is_current(account_generation)
    }

    async fn retire_routing_client_if_same(&self, client: &Arc<RelayClient>) -> bool {
        {
            let current = self.relay_client.read().await;
            if !same_routing_client(current.as_ref(), client) {
                return false;
            }
            self.routing_cancel
                .send_modify(|epoch| *epoch = epoch.wrapping_add(1));
        }
        let _routing_guard = self.lifecycle.write().await;
        let mut current = self.relay_client.write().await;
        if !take_routing_client_if_same(&mut current, client) {
            return false;
        }
        drop(current);
        crate::peer_host::update_controller_presence(Vec::new()).await;
        true
    }

    async fn handle_relay_event(
        self: &Arc<Self>,
        event: RelayEvent,
        relay_client: &Arc<RelayClient>,
        account_generation: u64,
        expected_token: &str,
    ) {
        if let RelayEvent::AuthError { message } = event {
            self.handle_relay_auth_error(message, relay_client, account_generation, expected_token)
                .await;
            return;
        }

        let mut cancelled = self.routing_cancel.subscribe();
        let _routing_lease = self.lifecycle.read().await;
        if !self
            .routing_loop_is_current(account_generation, relay_client)
            .await
        {
            tracing::debug!("Ignoring event from a stale device routing client");
            return;
        }
        let runtime = self.runtime().expect("bound account runtime");
        let Ok((session, relay_url)) = runtime
            .read_account_context_for_generation(account_generation)
            .await
        else {
            return;
        };
        let fanout_owner = PeerFanoutOwner {
            account_generation,
            account_token: expected_token.to_string(),
            relay_client: Arc::clone(relay_client),
            runtime: Arc::downgrade(&runtime),
            session,
            relay_url,
            cancellation: Some(cancelled.clone()),
        };
        tokio::select! {
            biased;
            _ = cancelled.changed() => { tracing::debug!("Retired pending RPC after account routing transition"); }
            _ = async {
        ACTIVE_PEER_FANOUT_OWNER
            .scope(fanout_owner, async {
                self.handle_current_relay_event(
                    event,
                    relay_client,
                    account_generation,
                    expected_token,
                )
                .await;
            })
            .await;
            } => {}
        }
    }

    async fn handle_current_relay_event(
        &self,
        event: RelayEvent,
        relay_client: &Arc<RelayClient>,
        account_generation: u64,
        expected_token: &str,
    ) {
        let runtime = match self.runtime() {
            Ok(runtime) => runtime,
            Err(_) => return,
        };
        match event {
            RelayEvent::AuthOk { user_id, device_id } => {
                tracing::info!("Device routing auth ok: user={user_id} device={device_id}");
                if let Err(error) = DeviceIdentity::adopt_account_device_id(&device_id) {
                    tracing::warn!("Failed to adopt AuthOk device_id: {error}");
                    return;
                }
                if let Ok((session, relay_url)) = runtime
                    .read_account_context_for_generation(account_generation)
                    .await
                {
                    if session.token == expected_token
                        && self
                            .routing_loop_is_current(account_generation, relay_client)
                            .await
                    {
                        let hub = openbitfun_core::service::remote_connect::start_host_stream_hub(
                            Arc::new(CliHostStreamNotifier {
                                routing: self.self_ref.clone(),
                            }),
                        );
                        if let Some(old) = self.host_stream_hub.write().await.replace(hub) {
                            old.close();
                        }
                        if let Err(error) = session_store::save_session_with_device(
                            &session.token,
                            &session.user_id,
                            &session.master_key,
                            &relay_url,
                            Some(device_id.as_str()),
                        ) {
                            tracing::warn!("Failed to persist AuthOk device_id: {error}");
                        }
                    }
                }
            }
            RelayEvent::DevicePresence { devices } => {
                if let Ok((session, _)) = runtime
                    .read_account_context_for_generation(account_generation)
                    .await
                {
                    session.clear_peer_keys().await;
                }
                tracing::info!("Device presence updated: {} online", devices.len());
                if !self
                    .routing_loop_is_current(account_generation, relay_client)
                    .await
                {
                    return;
                }
                let online: Vec<String> =
                    devices.into_iter().map(|device| device.device_id).collect();
                // Presence is authoritative for who can still receive stream
                // hints; a device that dropped off stops holding streams alive.
                if let Some(hub) = self.host_stream_hub().await {
                    hub.retain_online(&online);
                }
                crate::peer_host::update_controller_presence(online).await;
            }
            RelayEvent::DeviceMessageReceived {
                source_device_id,
                correlation_id,
                encrypted_data,
                nonce,
            } => {
                let Ok((session, relay_url)) = runtime
                    .read_account_context_for_generation(account_generation)
                    .await
                else {
                    return;
                };
                if session.token != expected_token
                    || !self
                        .routing_loop_is_current(account_generation, relay_client)
                        .await
                {
                    return;
                }
                let plaintext = match session
                    .decrypt_from_peer(&relay_url, &source_device_id, &encrypted_data, &nonce)
                    .await
                {
                    Ok(plaintext) => plaintext,
                    Err(error) => {
                        tracing::warn!("Failed to decrypt device message: {error}");
                        return;
                    }
                };
                use remote_connect::remote_server::{RemoteCommand, RemoteResponse};
                let command: RemoteCommand = match serde_json::from_str(&plaintext) {
                    Ok(command) => command,
                    Err(error) => {
                        tracing::warn!("Could not parse device command: {error}");
                        return;
                    }
                };
                tracing::info!(
                    "Device command received: source={source_device_id} corr={correlation_id}"
                );
                let peer_key = match session
                    .peer_message_key(&relay_url, &source_device_id)
                    .await
                {
                    Ok(key) => key,
                    Err(error) => {
                        tracing::warn!("Failed to resolve peer message key: {error}");
                        return;
                    }
                };
                // Host streams are answered from this host's memory for the
                // requesting device; every other command goes to the dispatcher.
                let hub = self.host_stream_hub().await;
                let response =
                    match openbitfun_core::service::remote_connect::handle_host_stream_command(
                        hub.as_ref(),
                        &source_device_id,
                        &command,
                    )
                    .await
                    {
                        Some(response) => response,
                        None => match &command {
                            RemoteCommand::HostInvoke { command, args } => {
                                crate::peer_host::handle_host_invoke(command, args.clone()).await
                            }
                            RemoteCommand::DeviceEvent { event, payload } => {
                                // A host is also a controller of its peers: stream
                                // hints addressed to this device feed local subscribers.
                                session.deliver_device_event(&source_device_id, event, payload);
                                crate::peer_host::handle_device_event_command()
                            }
                            other => RemoteServer::new(peer_key).dispatch(other).await,
                        },
                    };
                if !self
                    .routing_loop_is_current(account_generation, relay_client)
                    .await
                {
                    return;
                }
                let response_json = serde_json::to_string(&response).unwrap_or_else(|error| {
                    serde_json::to_string(&RemoteResponse::Error {
                        message: format!("failed to serialize RPC response: {error}"),
                    })
                    .unwrap_or_else(|_| {
                        r#"{"resp":"error","message":"serialize failed"}"#.to_string()
                    })
                });
                let Ok((encrypted_response, response_nonce)) =
                    encryption::encrypt_to_base64(&peer_key, &response_json)
                else {
                    tracing::warn!("Failed to encrypt RPC response");
                    return;
                };
                let reply_target = if source_device_id == "rpc" {
                    "rpc"
                } else {
                    source_device_id.as_str()
                };
                if let Err(error) = relay_client
                    .send_device_message(
                        reply_target,
                        &correlation_id,
                        &encrypted_response,
                        &response_nonce,
                    )
                    .await
                {
                    tracing::warn!("Failed to send RPC response: {error}");
                }
            }
            RelayEvent::Disconnected => {
                tracing::info!("Device routing disconnected");
                crate::peer_host::update_controller_presence(Vec::new()).await;
            }
            RelayEvent::Reconnected => tracing::info!("Device routing reconnected"),
            RelayEvent::Error { message } => {
                tracing::warn!("Device routing error: {message}")
            }
            RelayEvent::AuthError { .. } => unreachable!("AuthError handled before routing lease"),
            _ => {}
        }
    }

    async fn handle_relay_auth_error(
        &self,
        message: String,
        relay_client: &Arc<RelayClient>,
        account_generation: u64,
        expected_token: &str,
    ) {
        tracing::warn!("Device routing auth error: {message}");
        {
            let current = self.relay_client.read().await;
            if !same_routing_client(current.as_ref(), relay_client) {
                return;
            }
            self.routing_cancel
                .send_modify(|epoch| *epoch = epoch.wrapping_add(1));
        }
        {
            let _routing_guard = self.lifecycle.write().await;
            let mut current = self.relay_client.write().await;
            if !take_routing_client_if_same(&mut current, relay_client) {
                tracing::debug!("Ignoring auth error from a replaced routing client");
                return;
            }
            drop(current);
            relay_client.disconnect().await;
        }
        let Ok(runtime) = self.runtime() else {
            return;
        };
        if runtime
            .expire_rejected_context(account_generation, expected_token)
            .await
        {
            crate::peer_host::update_controller_presence(Vec::new()).await;
        }
    }

    pub(crate) async fn capture_peer_fanout_owner(&self) -> Result<PeerFanoutOwner> {
        let runtime = self.runtime()?;
        let generation = runtime.account_context_generation();
        let _routing_lease = self.lifecycle.read().await;
        let (session, relay_url) = runtime
            .read_account_context_for_generation(generation)
            .await?;
        let relay_client = self
            .relay_client
            .read()
            .await
            .clone()
            .ok_or_else(|| anyhow!("device routing not connected"))?;
        if !self
            .routing_loop_is_current(generation, &relay_client)
            .await
        {
            return Err(anyhow!("account context changed"));
        }
        Ok(PeerFanoutOwner {
            account_generation: generation,
            account_token: session.token.clone(),
            relay_client,
            runtime: Arc::downgrade(&runtime),
            session,
            relay_url,
            cancellation: Some(self.routing_cancel.subscribe()),
        })
    }
}

#[async_trait]
impl AccountRuntimeHost for CliAccountRoutingHost {
    async fn retire_background_routing_owner(
        &self,
    ) -> std::result::Result<bool, BackgroundRoutingOwnerRetirementError> {
        if !crate::daemon::is_daemon_running() {
            return Ok(false);
        }
        if !crate::daemon::request_daemon_shutdown() {
            return Err(BackgroundRoutingOwnerRetirementError {
                error: anyhow!("could not stop the CLI daemon; the current account remains active"),
                owner_may_exit: false,
            });
        }
        let deadline = tokio::time::Instant::now() + Duration::from_secs(10);
        while crate::daemon::is_daemon_running() {
            if tokio::time::Instant::now() >= deadline {
                return Err(BackgroundRoutingOwnerRetirementError {
                    error: anyhow!(
                        "CLI daemon did not stop in time; the current account remains active"
                    ),
                    owner_may_exit: true,
                });
            }
            tokio::time::sleep(Duration::from_millis(50)).await;
        }
        Ok(true)
    }

    fn background_routing_owner_is_running(&self) -> bool {
        crate::daemon::is_daemon_running()
    }

    fn request_background_routing_owner_shutdown(&self) -> bool {
        crate::daemon::request_daemon_shutdown()
    }

    async fn start_device_routing(&self, request: AccountRoutingStartRequest) -> Result<()> {
        self.start_routing(request).await
    }

    async fn stop_device_routing(&self) {
        self.stop_routing().await;
    }
}

fn same_routing_client<T>(current: Option<&Arc<T>>, expected: &Arc<T>) -> bool {
    current.is_some_and(|client| Arc::ptr_eq(client, expected))
}

fn take_routing_client_if_same<T>(current: &mut Option<Arc<T>>, expected: &Arc<T>) -> bool {
    if !same_routing_client(current.as_ref(), expected) {
        return false;
    }
    current.take();
    true
}

/// Immutable routing owner captured when a Peer DeviceEvent enters the queue.
#[derive(Clone)]
pub(crate) struct PeerFanoutOwner {
    account_generation: u64,
    account_token: String,
    relay_client: Arc<RelayClient>,
    runtime: Weak<AccountRuntime>,
    session: AccountSession,
    relay_url: String,
    // Captured at admission, not at dequeue: transitions that already happened
    // must also cancel queued work.
    cancellation: Option<tokio::sync::watch::Receiver<u64>>,
}

tokio::task_local! {
    static ACTIVE_PEER_FANOUT_OWNER: PeerFanoutOwner;
}

pub(crate) fn inherited_peer_fanout_owner() -> Option<PeerFanoutOwner> {
    ACTIVE_PEER_FANOUT_OWNER
        .try_with(PeerFanoutOwner::clone)
        .ok()
}

impl PeerFanoutOwner {
    pub(crate) fn cancellation_receiver(&self) -> Option<tokio::sync::watch::Receiver<u64>> {
        self.cancellation.clone()
    }

    fn matches(&self, generation: u64, token: &str, relay_client: &Arc<RelayClient>) -> bool {
        self.account_generation == generation
            && self.account_token == token
            && Arc::ptr_eq(&self.relay_client, relay_client)
    }

    #[cfg(test)]
    pub(crate) fn for_test(account_generation: u64, account_token: &str) -> Self {
        let (relay_client, _) = RelayClient::new();
        Self {
            account_generation,
            account_token: account_token.to_string(),
            relay_client: Arc::new(relay_client),
            runtime: Weak::new(),
            session: AccountSession::new(account_token.into(), "test".into(), [0; 32]),
            relay_url: "http://localhost".into(),
            cancellation: None,
        }
    }

    #[cfg(test)]
    pub(crate) fn with_test_cancellation(
        mut self,
        cancellation: tokio::sync::watch::Receiver<u64>,
    ) -> Self {
        self.cancellation = Some(cancellation);
        self
    }

    #[cfg(test)]
    pub(crate) fn generation_for_test(&self) -> u64 {
        self.account_generation
    }
}

/// Immutable credentials for one admitted delivery. Never holds a routing lock
/// during encryption, directory lookup, or network acknowledgement.
pub(crate) struct PeerFanoutLease {
    pub(crate) session: AccountSession,
    pub(crate) relay_url: String,
    pub(crate) relay_client: Arc<RelayClient>,
}

/// Delivers host stream hints as encrypted `DeviceEvent`s to the one device
/// that subscribed, attached Peer controller or not. Only the stream id, epoch
/// and cursor travel; the controller reads content back over RPC.
struct CliHostStreamNotifier {
    routing: Weak<CliAccountRoutingHost>,
}

impl openbitfun_core::service::remote_connect::host_stream::HostStreamNotifier
    for CliHostStreamNotifier
{
    fn notify(&self, target_device_id: &str, payload: serde_json::Value) {
        let Some(routing) = self.routing.upgrade() else {
            return;
        };
        let target = target_device_id.to_owned();
        tokio::spawn(async move {
            let owner = match routing.capture_peer_fanout_owner().await {
                Ok(owner) => owner,
                Err(error) => {
                    tracing::debug!("Host stream hint skipped: {error}");
                    return;
                }
            };
            let lease = match acquire_peer_fanout_lease(&owner) {
                Ok(lease) => lease,
                Err(error) => {
                    tracing::debug!("Host stream hint skipped: {error}");
                    return;
                }
            };
            use openbitfun_core::service::remote_connect::remote_server::RemoteCommand;
            let envelope = match serde_json::to_string(&RemoteCommand::DeviceEvent {
                event:
                    openbitfun_core::service::remote_connect::host_stream::HOST_STREAM_CHANGED_EVENT
                        .to_owned(),
                payload,
            }) {
                Ok(envelope) => envelope,
                Err(error) => {
                    tracing::warn!("Host stream hint serialization failed: {error}");
                    return;
                }
            };
            let (encrypted_data, nonce) = match lease
                .session
                .encrypt_for_peer(&lease.relay_url, &target, &envelope)
                .await
            {
                Ok(encrypted) => encrypted,
                Err(error) => {
                    tracing::warn!("Host stream hint encryption failed: {error}");
                    return;
                }
            };
            let correlation_id = uuid::Uuid::new_v4().to_string();
            if let Err(error) = lease
                .relay_client
                .send_device_message(&target, &correlation_id, &encrypted_data, &nonce)
                .await
            {
                tracing::debug!("Host stream hint to {target} failed: {error}");
            }
        });
    }
}

pub(crate) fn acquire_peer_fanout_lease(owner: &PeerFanoutOwner) -> Result<PeerFanoutLease> {
    let runtime = owner
        .runtime
        .upgrade()
        .ok_or_else(|| anyhow!("account runtime stopped"))?;
    if !runtime.account_context_is_current(owner.account_generation)
        || owner
            .cancellation
            .as_ref()
            .is_none_or(|cancel| cancel.has_changed().unwrap_or(true))
    {
        return Err(anyhow!("queued Peer event routing owner changed"));
    }
    Ok(PeerFanoutLease {
        session: owner.session.clone(),
        relay_url: owner.relay_url.clone(),
        relay_client: owner.relay_client.clone(),
    })
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::time::Duration;

    #[test]
    fn stale_routing_loop_cannot_clear_replacement_client() {
        let stale = Arc::new("stale");
        let replacement = Arc::new("replacement");
        let mut current = Some(Arc::clone(&replacement));
        assert!(!take_routing_client_if_same(&mut current, &stale));
        assert!(current
            .as_ref()
            .is_some_and(|client| Arc::ptr_eq(client, &replacement)));
    }

    #[test]
    fn queued_fanout_owner_requires_generation_token_and_client_identity() {
        let owner = PeerFanoutOwner::for_test(11, "token-a");
        let owned_client = Arc::clone(&owner.relay_client);
        let replacement = PeerFanoutOwner::for_test(12, "token-b");
        assert!(owner.matches(11, "token-a", &owned_client));
        assert!(!owner.matches(12, "token-a", &owned_client));
        assert!(!owner.matches(11, "token-b", &owned_client));
        assert!(!owner.matches(11, "token-a", &replacement.relay_client));
    }

    #[tokio::test]
    async fn routing_replacement_waits_for_an_in_flight_event_lease() {
        let routing = CliAccountRoutingHost::new();
        let event_lease = routing.lifecycle.read().await;
        let lifecycle = routing.lifecycle.clone();
        let (attempting_tx, attempting_rx) = tokio::sync::oneshot::channel();
        let replacement = tokio::spawn(async move {
            let _ = attempting_tx.send(());
            let _replacement_lease = lifecycle.write().await;
        });

        attempting_rx.await.expect("replacement task started");
        tokio::task::yield_now().await;
        assert!(!replacement.is_finished());
        drop(event_lease);

        tokio::time::timeout(Duration::from_secs(1), replacement)
            .await
            .expect("replacement should acquire the lifecycle after event completion")
            .expect("replacement task should finish");
    }
}
