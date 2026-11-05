//! Account connection owner shared by Desktop, CLI/daemon and bot adapters.
//! Socket.IO owns framing, heartbeat and RPC acks. This owner supplies account
//! epochs, bounded delivery, method registration and reconnect policy.
use super::realtime_client::{Incoming, JsonAck, RealtimeConnection, RealtimeSender};
pub use super::routing_lease::DeviceRoutingPriority;
use super::routing_lease::{RoutingLease, RoutingLeasePaths};
use anyhow::{anyhow, bail, Result};
use serde::{Deserialize, Serialize};
use serde_json::json;
use sioc::prelude::AckId;
use std::{
    collections::HashMap,
    sync::{Arc, Mutex},
    time::{Duration, Instant},
};
use tokio::sync::{mpsc, oneshot};

pub(super) fn device_envelope(data: &str, nonce: &str, offer_zstd: bool) -> serde_json::Value {
    let mut envelope = json!({"encrypted_data": data, "nonce": nonce});
    if offer_zstd {
        envelope["accept_encoding"] = super::message_encoding::ZSTD_ENCODING.into();
    }
    envelope
}

pub const RELAY_INBOUND_IDLE_TIMEOUT: Duration = Duration::from_secs(60);
/// How long a primary host waits for another primary host on this device to
/// release routing before its first connection fails.
const PRIMARY_ROUTING_WAIT: Duration = Duration::from_secs(10);

pub fn ensure_rustls_crypto_provider() {
    openbitfun_services_core::tls_provider::ensure_ring_crypto_provider();
}
#[derive(Debug, Clone, Default, PartialEq, Eq, Serialize, Deserialize)]
pub struct DevicePresenceEntry {
    pub device_id: String,
    pub device_name: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub device_alias: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub device_model: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub device_os: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub device_os_version: Option<String>,
    /// Build string the device last reported to the Relay. Absent for legacy
    /// devices and for Relays that predate the field. Accepts the `client_*`
    /// and camelCase spellings some Relays use.
    #[serde(
        default,
        alias = "client_version",
        alias = "clientVersion",
        skip_serializing_if = "Option::is_none"
    )]
    pub device_client_version: Option<String>,
    /// Control-contract protocol number the device last reported. Absent for
    /// legacy devices and for Relays that predate the field.
    #[serde(
        default,
        alias = "client_protocol",
        alias = "clientProtocol",
        skip_serializing_if = "Option::is_none"
    )]
    pub device_client_protocol: Option<u32>,
    /// Relay-computed compatibility, present in presence only when the Relay
    /// computes it. `None` means unknown and must be treated as compatible.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub compatible: Option<bool>,
}

impl DevicePresenceEntry {
    /// Whether the Relay considers this device compatible with our control
    /// contract.
    ///
    /// The Relay computes and exposes `compatible` only on `GET /api/devices`;
    /// presence entries carry the raw `client_version`/`client_protocol` at
    /// most, so this is normally `None`. A `Some(false)` value, when a Relay
    /// does send one, means the pair must not be remote-controlled (a device
    /// with no version, or a mismatched number). `None` means the Relay did not
    /// judge here — treat it as compatible; do not read a missing flag as "the
    /// device lacks a version".
    pub fn is_compatible(&self) -> bool {
        self.compatible.unwrap_or(true)
    }
}
/// An RPC caller and the machine serving RPC on the same device can run
/// different builds. Only machine events and RPC replies identify the host.
#[derive(Debug, Clone, Copy)]
pub enum PeerEncodingOffer {
    Host(bool),
    Controller(bool),
}

impl PeerEncodingOffer {
    pub fn accepts_zstd(self) -> bool {
        match self {
            Self::Host(accepted) | Self::Controller(accepted) => accepted,
        }
    }
}

#[derive(Debug, Clone)]
pub enum RelayEvent {
    Connected,
    Reconnected,
    Disconnected,
    Error {
        message: String,
    },
    AuthOk {
        user_id: String,
        device_id: String,
    },
    AuthError {
        message: String,
    },
    DeviceMessageReceived {
        source_device_id: String,
        correlation_id: String,
        encoding_offer: PeerEncodingOffer,
        encrypted_data: String,
        nonce: String,
    },
    DevicePresence {
        devices: Vec<DevicePresenceEntry>,
    },
}
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum ConnectionState {
    Disconnected,
    Connecting,
    Connected,
    Reconnecting,
    /// Another OpenBitFun host on this machine serves the same device on this
    /// Relay. The client connects by itself once that host releases routing.
    Standby,
}
enum RoutingTurn {
    Proceed,
    Unarbitrated,
    Exit,
}
struct Reply {
    id: AckId<JsonAck>,
    deadline: Instant,
    source: String,
}
struct Owner {
    epoch: u64,
    state: ConnectionState,
    url: Option<String>,
    task: Option<tokio::task::JoinHandle<()>>,
    sender: Option<RealtimeSender>,
    replies: HashMap<String, Reply>,
}
struct EpochCleanup {
    owner: Arc<Mutex<Owner>>,
    epoch: u64,
}
impl Drop for EpochCleanup {
    fn drop(&mut self) {
        if let Ok(mut owner) = self.owner.lock() {
            if owner.epoch == self.epoch {
                owner.sender = None;
                owner.replies.clear();
                owner.state = ConnectionState::Disconnected;
            }
        }
    }
}
pub struct RelayClient {
    account_session: Option<super::account::AccountSession>,
    owner: Arc<Mutex<Owner>>,
    events: mpsc::Sender<RelayEvent>,
    machine: bool,
    routing: Option<DeviceRoutingPriority>,
    #[cfg(test)]
    routing_dir: Option<std::path::PathBuf>,
}
impl RelayClient {
    /// Machine-scoped client without host-local arbitration.
    pub fn new() -> (Self, mpsc::Receiver<RelayEvent>) {
        Self::with_role(true, None)
    }
    /// Machine-scoped client for a product host that serves this device. Hosts
    /// sharing the device identity take turns by `priority` instead of
    /// replacing each other's socket on the Relay.
    pub fn new_device_host(priority: DeviceRoutingPriority) -> (Self, mpsc::Receiver<RelayEvent>) {
        Self::with_role(true, Some(priority))
    }
    pub fn new_controller() -> (Self, mpsc::Receiver<RelayEvent>) {
        Self::with_role(false, None)
    }
    pub fn with_account_session(mut self, session: &super::account::AccountSession) -> Self {
        self.account_session = Some(session.for_peer_messages());
        self
    }

    fn with_role(
        machine: bool,
        routing: Option<DeviceRoutingPriority>,
    ) -> (Self, mpsc::Receiver<RelayEvent>) {
        let (events, receiver) = mpsc::channel(128);
        (
            Self {
                account_session: None,
                owner: Arc::new(Mutex::new(Owner {
                    epoch: 0,
                    state: ConnectionState::Disconnected,
                    url: None,
                    task: None,
                    sender: None,
                    replies: HashMap::new(),
                })),
                events,
                machine,
                routing,
                #[cfg(test)]
                routing_dir: None,
            },
            receiver,
        )
    }
    fn routing_lease(&self, url: &str) -> Option<RoutingLease> {
        let priority = self.routing?;
        #[cfg(test)]
        if let Some(dir) = &self.routing_dir {
            return Some(RoutingLease::new(RoutingLeasePaths::in_dir(
                dir, url, priority,
            )));
        }
        match RoutingLeasePaths::for_relay(url, priority) {
            Ok(paths) => Some(RoutingLease::new(paths)),
            Err(error) => {
                log::warn!("Relay routing arbitration unavailable; connecting without it: {error}");
                None
            }
        }
    }
    pub async fn connection_state(&self) -> ConnectionState {
        self.owner.lock().unwrap().state.clone()
    }
    /// Capture the endpoint; authentication establishes the actual account
    /// socket. No application event is exposed before that handshake finishes.
    pub async fn connect(&self, relay_url: &str) -> Result<()> {
        let mut url = super::account::validate_relay_base_url(relay_url)?;
        let path = url.path().trim_end_matches('/').to_owned();
        url.set_path(&path);
        self.disconnect().await;
        let mut owner = self.owner.lock().unwrap();
        owner.url = Some(url.to_string());
        owner.state = ConnectionState::Connecting;
        Ok(())
    }
    pub async fn connect_authenticated(&self, token: &str, _device_name: &str) -> Result<()> {
        let (ready, receive) = oneshot::channel();
        let (epoch, url, lease) = {
            let mut owner = self.owner.lock().unwrap();
            let url = owner
                .url
                .clone()
                .ok_or_else(|| anyhow!("Relay endpoint is not configured"))?;
            if let Some(task) = owner.task.take() {
                task.abort();
            }
            owner.epoch += 1;
            let epoch = owner.epoch;
            owner.sender = None;
            owner.replies.clear();
            let lease = self.routing_lease(&url);
            (epoch, url, lease)
        };
        // Reset the previous connection before either independent cold-start
        // dependency begins. The account can fetch a peer key while this
        // socket authenticates, and that fresh key survives initial AuthOk.
        if let Some(session) = &self.account_session {
            session.clear_peer_keys().await;
        }
        {
            let mut owner = self.owner.lock().unwrap();
            if owner.epoch != epoch {
                return Err(anyhow!("Relay authentication superseded"));
            }
            owner.task = Some(tokio::spawn(Self::run(
                self.owner.clone(),
                self.events.clone(),
                epoch,
                url,
                token.to_owned(),
                self.machine,
                self.account_session.clone(),
                lease,
                ready,
            )));
        }
        match tokio::time::timeout(Duration::from_secs(20), receive).await {
            Ok(Ok(result)) => result,
            Ok(Err(_)) => Err(anyhow!("Relay authentication cancelled")),
            Err(_) => {
                let task = {
                    let mut owner = self.owner.lock().unwrap();
                    if owner.epoch == epoch {
                        owner.epoch += 1;
                        owner.sender = None;
                        owner.replies.clear();
                        owner.state = ConnectionState::Disconnected;
                        owner.task.take()
                    } else {
                        None
                    }
                };
                if let Some(task) = task {
                    task.abort();
                    let _ = task.await;
                }
                Err(anyhow!("Relay authentication timed out"))
            }
        }
    }
    async fn run(
        owner: Arc<Mutex<Owner>>,
        events: mpsc::Sender<RelayEvent>,
        epoch: u64,
        url: String,
        token: String,
        machine: bool,
        account_session: Option<super::account::AccountSession>,
        // Moved into this task: dropping it releases routing to the next host.
        mut lease: Option<RoutingLease>,
        ready: oneshot::Sender<Result<()>>,
    ) {
        // Every exit (including abort/panic) relinquishes this epoch's sender
        // and reply table. A failed handshake must not leave Connecting forever.
        let _cleanup = EpochCleanup {
            owner: owner.clone(),
            epoch,
        };
        let mut ready = Some(ready);
        let mut delay = Duration::from_secs(1);
        let mut connected_once = false;
        loop {
            if let Some(active) = lease.as_mut() {
                match Self::wait_for_routing_turn(&owner, epoch, active, &mut ready).await {
                    RoutingTurn::Proceed => {}
                    RoutingTurn::Unarbitrated => lease = None,
                    RoutingTurn::Exit => return,
                }
            }
            let connection = RealtimeConnection::connect(&url, &token, machine).await;
            match connection {
                Ok(mut connection) => {
                    // Invalidate before publishing the socket. Clearing in an
                    // asynchronous AuthOk listener can discard the first RPC's
                    // negotiated response after a cold connection succeeds.
                    if connected_once {
                        if let Some(session) = &account_session {
                            session.clear_peer_keys().await;
                        }
                    }
                    let first = !connected_once;
                    connected_once = true;
                    {
                        let mut state = owner.lock().unwrap();
                        if state.epoch != epoch {
                            return;
                        }
                        state.sender = Some(connection.sender());
                        state.state = ConnectionState::Connected;
                    }
                    if events
                        .send(if first {
                            RelayEvent::Connected
                        } else {
                            RelayEvent::Reconnected
                        })
                        .await
                        .is_err()
                    {
                        log::info!("Relay event receiver closed after connection");
                        connection.close().await;
                        return;
                    }
                    if events
                        .send(RelayEvent::AuthOk {
                            user_id: connection.user_id.clone(),
                            device_id: connection.device_id.clone(),
                        })
                        .await
                        .is_err()
                    {
                        log::info!("Relay event receiver closed after authentication");
                        connection.close().await;
                        return;
                    }
                    if let Some(ready) = ready.take() {
                        let _ = ready.send(Ok(()));
                    }
                    delay = Duration::from_secs(1);
                    let mut online = super::message_encoding::OnlinePeers::default();
                    loop {
                        let incoming = match connection.receive().await {
                            Ok(incoming) => incoming,
                            Err(error) => {
                                log::warn!(
                                    "Relay receive loop ended; scheduling reconnect: {error}"
                                );
                                break;
                            }
                        };
                        if let (Some(session), Incoming::Ephemeral(event)) =
                            (&account_session, &incoming)
                        {
                            if event.payload.0["type"] == "device-presence" {
                                session.clear_peer_keys().await;
                                if machine {
                                    online.announce(session, &url, &connection, &event.payload.0);
                                }
                            }
                        }
                        if !Self::route(&owner, &events, epoch, incoming).await {
                            log::info!("Relay event receiver closed; stopping reconnect loop");
                            connection.close().await;
                            return;
                        }
                    }
                    connection.close().await;
                }
                Err(error) => {
                    if let Some(ready) = ready.take() {
                        let _ = ready.send(Err(anyhow!("Relay connection failed: {error}")));
                        return;
                    }
                    log::warn!("Relay reconnect failed: {error}");
                }
            }
            {
                let mut state = owner.lock().unwrap();
                if state.epoch != epoch {
                    return;
                }
                state.sender = None;
                state.replies.clear();
                state.state = ConnectionState::Reconnecting;
            }
            if events.send(RelayEvent::Disconnected).await.is_err() {
                log::info!("Relay event receiver closed while reporting disconnect");
                return;
            }
            let jitter = rand::random::<u32>() as u64 % (delay.as_millis() as u64 + 1);
            tokio::time::sleep(delay / 2 + Duration::from_millis(jitter)).await;
            delay = (delay * 2).min(Duration::from_secs(5));
        }
    }
    /// Hold back (re)connection while a host of higher or equal priority on
    /// this machine serves the device; connecting anyway would only replace its
    /// socket on the Relay and be replaced in turn.
    async fn wait_for_routing_turn(
        owner: &Arc<Mutex<Owner>>,
        epoch: u64,
        lease: &mut RoutingLease,
        ready: &mut Option<oneshot::Sender<Result<()>>>,
    ) -> RoutingTurn {
        let started = Instant::now();
        let mut standing_by = false;
        loop {
            match lease.may_connect() {
                Ok(true) => {
                    if standing_by {
                        log::info!("Relay routing released by another OpenBitFun host; connecting");
                    }
                    return RoutingTurn::Proceed;
                }
                Ok(false) => {}
                Err(error) => {
                    log::warn!("Relay routing arbitration failed; connecting without it: {error}");
                    return RoutingTurn::Unarbitrated;
                }
            }
            let primary = lease.priority() == DeviceRoutingPriority::Primary;
            if primary && ready.is_some() {
                // An interactive host reports contention instead of hanging;
                // the brief wait covers a restarting process and the momentary
                // probe of a standing-by secondary host.
                if started.elapsed() >= PRIMARY_ROUTING_WAIT {
                    if let Some(ready) = ready.take() {
                        let _ = ready.send(Err(anyhow!(
                            "Another OpenBitFun Desktop on this machine already serves this device on the Relay"
                        )));
                    }
                    return RoutingTurn::Exit;
                }
            } else if !standing_by {
                standing_by = true;
                log::info!(
                    "Another OpenBitFun host on this machine serves this device on the Relay; standing by until it exits"
                );
                {
                    let mut state = owner.lock().unwrap();
                    if state.epoch != epoch {
                        return RoutingTurn::Exit;
                    }
                    state.state = ConnectionState::Standby;
                }
                // A background host is started successfully; it takes over later.
                if let Some(ready) = ready.take() {
                    let _ = ready.send(Ok(()));
                }
            }
            if owner.lock().unwrap().epoch != epoch {
                return RoutingTurn::Exit;
            }
            let poll = if primary {
                Duration::from_millis(200)
            } else {
                Duration::from_secs(1)
            };
            tokio::time::sleep(poll).await;
        }
    }
    async fn route(
        owner: &Arc<Mutex<Owner>>,
        events: &mpsc::Sender<RelayEvent>,
        epoch: u64,
        event: Incoming,
    ) -> bool {
        if owner.lock().unwrap().epoch != epoch {
            return false;
        }
        match event {
            Incoming::RpcRequest(event) => {
                let value = event.payload.0;
                let Some(source) = value["sourceDeviceId"].as_str() else {
                    return false;
                };
                let Some(data) = value["params"]["encrypted_data"].as_str() else {
                    return false;
                };
                let Some(nonce) = value["params"]["nonce"].as_str() else {
                    return false;
                };
                let correlation = format!("rpc-{}", uuid::Uuid::new_v4());
                {
                    let mut state = owner.lock().unwrap();
                    if state.epoch != epoch {
                        return false;
                    }
                    state
                        .replies
                        .retain(|_, reply| reply.deadline > Instant::now());
                    state.replies.insert(
                        correlation.clone(),
                        Reply {
                            id: event.id,
                            deadline: reply_deadline(&value),
                            source: source.into(),
                        },
                    );
                }
                events
                    .send(RelayEvent::DeviceMessageReceived {
                        source_device_id: source.into(),
                        correlation_id: correlation,
                        encoding_offer: PeerEncodingOffer::Controller(
                            value["params"]["accept_encoding"]
                                == super::message_encoding::ZSTD_ENCODING,
                        ),
                        encrypted_data: data.into(),
                        nonce: nonce.into(),
                    })
                    .await
                    .is_ok()
            }
            Incoming::Ephemeral(event) => {
                let value = event.payload.0;
                if value["type"] == "device-presence" {
                    match serde_json::from_value(value["devices"].clone()) {
                        Ok(devices) => events
                            .send(RelayEvent::DevicePresence { devices })
                            .await
                            .is_ok(),
                        Err(_) => false,
                    }
                } else if value["type"] == "device-event" {
                    let (Some(source), Some(data), Some(nonce)) = (
                        value["sourceDeviceId"].as_str(),
                        value["params"]["encrypted_data"].as_str(),
                        value["params"]["nonce"].as_str(),
                    ) else {
                        return false;
                    };
                    events
                        .send(RelayEvent::DeviceMessageReceived {
                            source_device_id: source.into(),
                            correlation_id: String::new(),
                            encoding_offer: PeerEncodingOffer::Host(
                                value["params"]["accept_encoding"]
                                    == super::message_encoding::ZSTD_ENCODING,
                            ),
                            encrypted_data: data.into(),
                            nonce: nonce.into(),
                        })
                        .await
                        .is_ok()
                } else {
                    true
                }
            }
            // Relay-stored session updates are retired; an older relay may still
            // emit them and they are ignored.
            Incoming::Update(_) | Incoming::AuthOk(_) | Incoming::Registered(_) => true,
        }
    }
    pub async fn request_device(
        &self,
        target: &str,
        encrypted_data: &str,
        nonce: &str,
    ) -> Result<(String, String)> {
        self.request_device_with_timeout(
            target,
            encrypted_data,
            nonce,
            super::realtime_client::DEFAULT_RPC_TIMEOUT,
        )
        .await
    }
    /// Like [`Self::request_device`], with an explicit end-to-end deadline
    /// carried to the target as the relay RPC `timeoutMs`.
    pub async fn request_device_with_timeout(
        &self,
        target: &str,
        encrypted_data: &str,
        nonce: &str,
        timeout: Duration,
    ) -> Result<(String, String)> {
        let (data, nonce, _) = self
            .request_device_message(target, encrypted_data, nonce, timeout, false)
            .await?;
        Ok((data, nonce))
    }

    pub(super) async fn request_device_message(
        &self,
        target: &str,
        encrypted_data: &str,
        nonce: &str,
        timeout: Duration,
        offer_zstd: bool,
    ) -> Result<(String, String, bool)> {
        let sender = self
            .owner
            .lock()
            .unwrap()
            .sender
            .clone()
            .ok_or_else(|| anyhow!("Relay is disconnected; request was not submitted"))?;
        let result = sender
            .call_with_timeout(
                target,
                device_envelope(encrypted_data, nonce, offer_zstd),
                timeout,
            )
            .await?;
        let data = result["encrypted_data"]
            .as_str()
            .ok_or_else(|| anyhow!("RPC response missing encrypted data"))?;
        let nonce = result["nonce"]
            .as_str()
            .ok_or_else(|| anyhow!("RPC response missing nonce"))?;
        Ok((
            data.into(),
            nonce.into(),
            result["accept_encoding"] == super::message_encoding::ZSTD_ENCODING,
        ))
    }
    pub async fn send_device_message(
        &self,
        target: &str,
        correlation: &str,
        encrypted_data: &str,
        nonce: &str,
    ) -> Result<()> {
        let (sender, reply) = {
            let mut state = self.owner.lock().unwrap();
            let sender = state
                .sender
                .clone()
                .ok_or_else(|| anyhow!("Relay is disconnected"))?;
            (sender, state.replies.remove(correlation))
        };
        // Opaque callers may provide their own decryption path. Only the
        // account host that installed the codec advertises it to a peer.
        let envelope = device_envelope(encrypted_data, nonce, self.account_session.is_some());
        if let Some(reply) = reply {
            if reply.source != target || reply.deadline <= Instant::now() {
                bail!("RPC response owner expired");
            }
            sender.respond(reply.id, envelope).await
        } else {
            if correlation.starts_with("rpc-") {
                bail!("RPC acknowledgement is no longer pending");
            }
            sender.event(target, envelope).await
        }
    }
    pub async fn disconnect(&self) {
        let task = {
            let mut state = self.owner.lock().unwrap();
            state.epoch += 1;
            state.sender = None;
            state.replies.clear();
            state.state = ConnectionState::Disconnected;
            state.task.take()
        };
        if let Some(task) = task {
            task.abort();
            let _ = task.await;
        }
    }
}
impl Drop for RelayClient {
    fn drop(&mut self) {
        if let Some(task) = self.owner.lock().unwrap().task.take() {
            task.abort();
        }
    }
}

fn reply_deadline(payload: &serde_json::Value) -> Instant {
    let timeout = payload["timeoutMs"]
        .as_u64()
        .filter(|value| *value > 0)
        .unwrap_or(120_000);
    let now = Instant::now();
    now.checked_add(Duration::from_millis(timeout))
        .unwrap_or(now)
}

#[cfg(test)]
mod tests {
    use super::*;
    use sioc::prelude::Event;

    #[test]
    fn presence_metadata_and_legacy_round_trip() {
        let legacy = serde_json::json!({"device_id":"id", "device_name":"technical"});
        let entry: super::DevicePresenceEntry = serde_json::from_value(legacy.clone()).unwrap();
        assert_eq!(serde_json::to_value(entry).unwrap(), legacy);
        let extended = serde_json::json!({"device_id":"id", "device_name":"technical",
            "device_alias":"Laptop", "device_model":"Mac14,7", "device_os":"macos", "device_os_version":"15"});
        let entry: super::DevicePresenceEntry = serde_json::from_value(extended.clone()).unwrap();
        assert_eq!(entry.device_name, "technical");
        assert_eq!(serde_json::to_value(entry).unwrap(), extended);
        let cleared: super::DevicePresenceEntry = serde_json::from_value(serde_json::json!({
            "device_id":"id", "device_name":"technical", "device_alias":null,
            "device_model":null, "device_os":null, "device_os_version":null, "future":true
        }))
        .unwrap();
        assert!(cleared.device_alias.is_none());
    }

    #[test]
    fn presence_client_compatibility_round_trips_and_legacy_stays_unknown() {
        // Legacy presence carries no build fields and no `compatible` flag.
        // Presence never judges compatibility, so a missing flag is unknown and
        // treated as compatible; this is not the "device lacks a version" case,
        // which the Relay reports as an explicit `compatible: false`.
        let legacy: super::DevicePresenceEntry = serde_json::from_value(
            serde_json::json!({"device_id":"id", "device_name":"technical"}),
        )
        .unwrap();
        assert!(legacy.device_client_version.is_none());
        assert!(legacy.device_client_protocol.is_none());
        assert!(legacy.compatible.is_none());
        assert!(legacy.is_compatible());

        // A device that never reported a version is judged incompatible when the
        // Relay does send `compatible: false` (raw build fields stay absent).
        let unversioned: super::DevicePresenceEntry = serde_json::from_value(serde_json::json!({
            "device_id":"id", "device_name":"technical", "compatible":false
        }))
        .unwrap();
        assert!(unversioned.device_client_protocol.is_none());
        assert!(!unversioned.is_compatible());

        // A Relay that also includes the build fields carries them through.
        let extended = serde_json::json!({
            "device_id":"id", "device_name":"technical",
            "device_client_version":"1.0.1", "device_client_protocol":2, "compatible":false
        });
        let entry: super::DevicePresenceEntry = serde_json::from_value(extended.clone()).unwrap();
        assert_eq!(entry.device_client_version.as_deref(), Some("1.0.1"));
        assert_eq!(entry.device_client_protocol, Some(2));
        assert!(!entry.is_compatible());
        assert_eq!(serde_json::to_value(&entry).unwrap(), extended);

        // The `client_*` spellings some Relays use are accepted too.
        let aliased: super::DevicePresenceEntry = serde_json::from_value(serde_json::json!({
            "device_id":"id", "device_name":"technical",
            "client_version":"1.0.1", "client_protocol":2
        }))
        .unwrap();
        assert_eq!(aliased.device_client_version.as_deref(), Some("1.0.1"));
        assert_eq!(aliased.device_client_protocol, Some(2));
    }

    fn arbitrated_client(
        priority: DeviceRoutingPriority,
        dir: &std::path::Path,
    ) -> (RelayClient, mpsc::Receiver<RelayEvent>) {
        let (mut client, events) = RelayClient::new_device_host(priority);
        client.routing_dir = Some(dir.to_path_buf());
        (client, events)
    }

    #[tokio::test]
    async fn secondary_host_stands_by_until_the_primary_host_exits() {
        let dir = tempfile::tempdir().unwrap();
        let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
        let url = format!("http://{}", listener.local_addr().unwrap());
        let mut desktop = RoutingLease::new(RoutingLeasePaths::in_dir(
            dir.path(),
            &url,
            DeviceRoutingPriority::Primary,
        ));
        assert!(desktop.may_connect().unwrap());

        let (client, _events) = arbitrated_client(DeviceRoutingPriority::Secondary, dir.path());
        client.connect(&url).await.unwrap();
        // A background host starts successfully without touching the Relay,
        // where it would only replace the primary host's socket.
        client
            .connect_authenticated("test-token", "Host")
            .await
            .unwrap();
        assert_eq!(client.connection_state().await, ConnectionState::Standby);
        assert!(
            tokio::time::timeout(Duration::from_millis(1500), listener.accept())
                .await
                .is_err()
        );

        drop(desktop);
        tokio::time::timeout(Duration::from_secs(5), listener.accept())
            .await
            .expect("the secondary host must connect once the primary host exits")
            .unwrap();
        client.disconnect().await;
    }

    #[tokio::test]
    async fn primary_host_connects_while_a_secondary_host_holds_routing() {
        let dir = tempfile::tempdir().unwrap();
        let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
        let url = format!("http://{}", listener.local_addr().unwrap());
        let mut daemon = RoutingLease::new(RoutingLeasePaths::in_dir(
            dir.path(),
            &url,
            DeviceRoutingPriority::Secondary,
        ));
        assert!(daemon.may_connect().unwrap());

        let (client, _events) = arbitrated_client(DeviceRoutingPriority::Primary, dir.path());
        client.connect(&url).await.unwrap();
        let connecting = tokio::spawn(async move {
            let _ = client.connect_authenticated("test-token", "Host").await;
        });
        tokio::time::timeout(Duration::from_secs(2), listener.accept())
            .await
            .expect("a primary host must not wait for a secondary host")
            .unwrap();
        // The secondary host yields once the Relay replaces its socket.
        assert!(!daemon.may_connect().unwrap());
        connecting.abort();
    }

    #[tokio::test]
    async fn base_endpoint_preserves_proxy_prefix_without_legacy_ws_conversion() {
        let (client, _events) = super::RelayClient::new();
        for (input, expected) in [
            ("https://relay.example/", "https://relay.example/"),
            (
                "https://relay.example/v/1.0.1/",
                "https://relay.example/v/1.0.1",
            ),
            (
                "http://127.0.0.1:9700/prefix",
                "http://127.0.0.1:9700/prefix",
            ),
        ] {
            client.connect(input).await.unwrap();
            assert_eq!(client.owner.lock().unwrap().url.as_deref(), Some(expected));
        }
        for invalid in [
            "ws://relay.example/ws",
            "https://user:pass@relay.example",
            "https://relay.example/?token=x",
        ] {
            assert!(client.connect(invalid).await.is_err());
        }
    }

    #[tokio::test]
    async fn route_waits_for_event_capacity_instead_of_dropping_connection() {
        let owner = Arc::new(Mutex::new(Owner {
            epoch: 1,
            state: ConnectionState::Connected,
            url: None,
            task: None,
            sender: None,
            replies: HashMap::new(),
        }));
        let (events, mut received) = mpsc::channel(1);
        events.send(RelayEvent::Connected).await.unwrap();

        let route_owner = owner.clone();
        let mut route_task = tokio::spawn(async move {
            RelayClient::route(
                &route_owner,
                &events,
                1,
                Incoming::Ephemeral(Event {
                    payload: super::super::realtime_client::Ephemeral(serde_json::json!({
                        "type": "device-presence",
                        "devices": [],
                    })),
                    id: (),
                    attachments: (),
                }),
            )
            .await
        });

        assert!(
            tokio::time::timeout(Duration::from_millis(20), &mut route_task)
                .await
                .is_err()
        );
        assert!(matches!(received.recv().await, Some(RelayEvent::Connected)));
        assert!(route_task.await.unwrap());
        assert!(matches!(
            received.recv().await,
            Some(RelayEvent::DevicePresence { devices }) if devices.is_empty()
        ));
    }

    #[tokio::test]
    async fn server_close_reconnects_and_restores_device_presence() {
        use futures::{SinkExt, StreamExt};
        use tokio::net::TcpListener;
        use tokio_tungstenite::{accept_async, tungstenite::Message};

        for websocket_close in [false, true] {
            let listener = TcpListener::bind("127.0.0.1:0").await.unwrap();
            let address = listener.local_addr().unwrap();
            let (close_tx, mut close_rx) = mpsc::channel(1);
            let (pending_tx, mut pending_rx) = mpsc::channel(1);
            let server = tokio::spawn(async move {
                for connection in 0..2 {
                    let (stream, _) = listener.accept().await.unwrap();
                    let mut socket = accept_async(stream).await.unwrap();
                    socket
                        .send(Message::Text(
                            format!(
                                "0{}",
                                json!({"sid":"test", "upgrades":[], "pingInterval":25_000,
                                    "pingTimeout":5_000, "maxPayload":1_000_000})
                            )
                            .into(),
                        ))
                        .await
                        .unwrap();
                    let auth = socket.next().await.unwrap().unwrap().into_text().unwrap();
                    let auth: serde_json::Value =
                        serde_json::from_str(auth.strip_prefix("40").unwrap()).unwrap();
                    assert_eq!(auth["token"], "test-token");
                    assert_eq!(auth["clientType"], "machine-scoped");
                    socket
                        .send(Message::Text("40{\"sid\":\"test\"}".into()))
                        .await
                        .unwrap();
                    socket
                        .send(Message::Text(
                            format!(
                                "42{}",
                                json!(["auth-ok", {"userId":"account", "deviceId":"host"}])
                            )
                            .into(),
                        ))
                        .await
                        .unwrap();

                    // Each replacement socket must register the host again.
                    let registration = socket.next().await.unwrap().unwrap().into_text().unwrap();
                    let registration = registration.strip_prefix("42").unwrap();
                    let event_start = registration.find('[').unwrap();
                    let event: serde_json::Value =
                        serde_json::from_str(&registration[event_start..]).unwrap();
                    assert_eq!(event, json!(["rpc-register", {"method":"host:invoke"}]));
                    socket
                        .send(Message::Text(
                            format!("43{}[{{\"ok\":true}}]", &registration[..event_start]).into(),
                        ))
                        .await
                        .unwrap();
                    let mut devices = vec![json!({"device_id":"host", "device_name":"Host"})];
                    if connection == 1 {
                        devices.push(json!({"device_id":"peer", "device_name":"Peer"}));
                    }
                    socket
                        .send(Message::Text(
                            format!(
                                "42{}",
                                json!(["ephemeral", {"type":"device-presence", "devices":devices}])
                            )
                            .into(),
                        ))
                        .await
                        .unwrap();

                    for call in 0..if connection == 0 { 2 } else { 1 } {
                        let request = socket.next().await.unwrap().unwrap().into_text().unwrap();
                        let request = request.strip_prefix("42").unwrap();
                        let event_start = request.find('[').unwrap();
                        let event: serde_json::Value =
                            serde_json::from_str(&request[event_start..]).unwrap();
                        assert_eq!(event[0], "rpc-call");
                        assert_eq!(event[1]["method"], "peer:invoke");
                        assert!(
                            event[1]["params"].get("accept_encoding").is_none(),
                            "an opaque RPC caller owns its decoder"
                        );
                        assert_eq!(
                            event[1]["params"]["encrypted_data"],
                            if call == 0 { "request" } else { "pending" }
                        );
                        if call == 0 {
                            socket
                                .send(Message::Text(
                                    format!(
                                        "43{}{}",
                                        &request[..event_start],
                                        json!([{"ok":true, "result":{
                                            "encrypted_data":format!("reply-{connection}"), "nonce":"nonce"
                                        }}])
                                    )
                                    .into(),
                                ))
                                .await
                                .unwrap();
                        } else {
                            // This request reached the old socket; it must
                            // fail on close and never replay on its replacement.
                            pending_tx.send(()).await.unwrap();
                        }
                    }

                    close_rx.recv().await.unwrap();
                    if connection == 0 {
                        if websocket_close {
                            socket.close(None).await.unwrap();
                        } else {
                            socket.send(Message::Text("1".into())).await.unwrap();
                        }
                        while let Some(Ok(message)) = socket.next().await {
                            if message.is_close() {
                                break;
                            }
                        }
                    }
                }
            });

            let (client, mut events) = RelayClient::new();
            let result = tokio::time::timeout(Duration::from_secs(8), async {
                client.connect(&format!("http://{address}")).await.unwrap();
                client
                    .connect_authenticated("test-token", "Host")
                    .await
                    .unwrap();
                assert!(matches!(events.recv().await, Some(RelayEvent::Connected)));
                assert!(matches!(events.recv().await, Some(RelayEvent::AuthOk { .. })));
                assert!(matches!(
                    events.recv().await,
                    Some(RelayEvent::DevicePresence { devices }) if devices.len() == 1
                ));
                assert_eq!(
                    client.request_device("peer", "request", "nonce").await.unwrap(),
                    ("reply-0".into(), "nonce".into())
                );

                let (pending, ()) = tokio::join!(
                    client.request_device("peer", "pending", "nonce"),
                    async {
                        pending_rx.recv().await.unwrap();
                        close_tx.send(()).await.unwrap();
                        assert!(matches!(events.recv().await, Some(RelayEvent::Disconnected)));
                    }
                );
                assert!(pending.is_err(), "an unacknowledged request must not report success");
                assert!(matches!(events.recv().await, Some(RelayEvent::Reconnected)));
                assert!(matches!(events.recv().await, Some(RelayEvent::AuthOk { .. })));
                assert!(matches!(
                    events.recv().await,
                    Some(RelayEvent::DevicePresence { devices })
                        if devices.iter().map(|device| device.device_id.as_str()).collect::<Vec<_>>()
                            == ["host", "peer"]
                ));
                assert_eq!(client.connection_state().await, ConnectionState::Connected);
                assert_eq!(
                    client.request_device("peer", "request", "nonce").await.unwrap(),
                    ("reply-1".into(), "nonce".into())
                );
                close_tx.send(()).await.unwrap();
            })
            .await;
            client.disconnect().await;
            if result.is_err() {
                server.abort();
            }
            let server_result = server.await;
            result.expect("closed Relay transport must reconnect and refresh device presence");
            server_result.unwrap();
        }
    }

    #[test]
    fn reply_deadline_respects_forwarded_timeout() {
        let now = Instant::now();
        assert!(reply_deadline(&json!({})) >= now + Duration::from_secs(120));
        assert!(reply_deadline(&json!({"timeoutMs":240_000})) >= now + Duration::from_secs(240));
        assert!(reply_deadline(&json!({"timeoutMs":1000})) < now + Duration::from_secs(2));
    }
}
