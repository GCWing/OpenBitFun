//! Account connection owner shared by Desktop, CLI/daemon and bot adapters.
//! Socket.IO owns framing, heartbeat and RPC acks. This owner supplies account
//! epochs, bounded delivery, method registration and reconnect policy.
use super::realtime_client::{Incoming, JsonAck, RealtimeConnection, RealtimeSender};
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

pub const RELAY_INBOUND_IDLE_TIMEOUT: Duration = Duration::from_secs(60);

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
    owner: Arc<Mutex<Owner>>,
    events: mpsc::Sender<RelayEvent>,
    machine: bool,
}
impl RelayClient {
    pub fn new() -> (Self, mpsc::Receiver<RelayEvent>) {
        Self::with_role(true)
    }
    pub fn new_controller() -> (Self, mpsc::Receiver<RelayEvent>) {
        Self::with_role(false)
    }
    fn with_role(machine: bool) -> (Self, mpsc::Receiver<RelayEvent>) {
        let (events, receiver) = mpsc::channel(128);
        (
            Self {
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
            },
            receiver,
        )
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
        let epoch = {
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
            owner.task = Some(tokio::spawn(Self::run(
                self.owner.clone(),
                self.events.clone(),
                epoch,
                url,
                token.to_owned(),
                self.machine,
                ready,
            )));
            epoch
        };
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
        loop {
            let connection = RealtimeConnection::connect(&url, &token, machine).await;
            match connection {
                Ok(mut connection) => {
                    let first = ready.is_some();
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
        let sender = self
            .owner
            .lock()
            .unwrap()
            .sender
            .clone()
            .ok_or_else(|| anyhow!("Relay is disconnected; request was not submitted"))?;
        let result = sender
            .call(
                target,
                json!({"encrypted_data":encrypted_data,"nonce":nonce}),
            )
            .await?;
        let data = result["encrypted_data"]
            .as_str()
            .ok_or_else(|| anyhow!("RPC response missing encrypted data"))?;
        let nonce = result["nonce"]
            .as_str()
            .ok_or_else(|| anyhow!("RPC response missing nonce"))?;
        Ok((data.into(), nonce.into()))
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
        if let Some(reply) = reply {
            if reply.source != target || reply.deadline <= Instant::now() {
                bail!("RPC response owner expired");
            }
            sender
                .respond(
                    reply.id,
                    json!({"encrypted_data":encrypted_data,"nonce":nonce}),
                )
                .await
        } else {
            if correlation.starts_with("rpc-") {
                bail!("RPC acknowledgement is no longer pending");
            }
            sender
                .event(
                    target,
                    json!({"encrypted_data":encrypted_data,"nonce":nonce}),
                )
                .await
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

    #[test]
    fn reply_deadline_respects_forwarded_timeout() {
        let now = Instant::now();
        assert!(reply_deadline(&json!({})) >= now + Duration::from_secs(120));
        assert!(reply_deadline(&json!({"timeoutMs":240_000})) >= now + Duration::from_secs(240));
        assert!(reply_deadline(&json!({"timeoutMs":1000})) < now + Duration::from_secs(2));
    }
}
