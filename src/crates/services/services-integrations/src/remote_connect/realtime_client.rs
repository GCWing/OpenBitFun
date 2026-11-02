//! Shared Happy-style Socket.IO RPC adapter for product hosts and controllers.
//! IO, acknowledgement ownership and admission stay below platform adapters.
use anyhow::{anyhow, bail, Result};
use futures::{stream::FuturesUnordered, StreamExt};
use serde_json::{json, Value};
use sioc::prelude::*;
use std::time::Duration;

/// Default end-to-end device RPC deadline, unchanged for ordinary commands.
pub const DEFAULT_RPC_TIMEOUT: Duration = Duration::from_secs(120);

/// Deadlines for one relay RPC: the target's reply deadline (sent as
/// `timeoutMs`), the Socket.IO acknowledgement wait, and the overall guard.
/// The acknowledgement and guard keep the previous 3 s / 5 s margins over the
/// target deadline so the target's own timeout error arrives first.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub(crate) struct RpcCallDeadlines {
    pub target: Duration,
    pub ack: Duration,
    pub overall: Duration,
}

impl RpcCallDeadlines {
    pub(crate) fn for_timeout(timeout: Duration) -> Self {
        let target = timeout.max(Duration::from_secs(1));
        Self {
            target,
            ack: target + Duration::from_secs(3),
            overall: target + Duration::from_secs(5),
        }
    }
}

pub(crate) fn rpc_call_payload(target: &str, params: Value, timeout: Duration) -> Value {
    let timeout_ms = u64::try_from(timeout.as_millis()).unwrap_or(u64::MAX);
    json!({"method":format!("{target}:invoke"),"params":params,"timeoutMs":timeout_ms})
}

/// Authentication payload shared by all Rust hosts and controllers.
///
/// Every (re)connect carries the build string and control-contract protocol
/// number so the Relay can gate compatibility instead of treating this device
/// as legacy.
pub fn account_auth_payload(token: &str, machine: bool) -> Value {
    json!({
        "token": token,
        "clientType": if machine { "machine-scoped" } else { "user-scoped" },
        "clientVersion": openbitfun_product_domains::account::client_version(),
        "clientProtocol": openbitfun_product_domains::account::CLIENT_PROTOCOL_VERSION,
    })
}

#[derive(Debug, AckType, SerializePayload, DeserializePayload)]
pub struct JsonAck(pub Value);

macro_rules! json_event {
    ($name:ident, $wire:literal, $ack:ty) => {
        #[derive(Debug, SerializePayload, DeserializePayload)]
        pub struct $name(pub Value);
        impl EventType for $name {
            const NAME: &'static str = $wire;
            type Ack = $ack;
            type Binary = NoBinary;
        }
    };
}
json_event!(RpcCall, "rpc-call", HasAck<JsonAck>);
json_event!(RpcRegister, "rpc-register", HasAck<JsonAck>);
json_event!(RpcRequest, "rpc-request", HasAck<JsonAck>);
json_event!(AuthOk, "auth-ok", NoAck);
json_event!(Update, "update", NoAck);
json_event!(Ephemeral, "ephemeral", NoAck);
json_event!(MachineEvent, "machine-event", HasAck<JsonAck>);
json_event!(Registered, "rpc-registered", NoAck);

#[derive(Debug, EventRouter)]
pub enum Incoming {
    AuthOk(Event<AuthOk>),
    RpcRequest(Event<RpcRequest>),
    Update(Event<Update>),
    Ephemeral(Event<Ephemeral>),
    Registered(Event<Registered>),
}

/// One connection epoch. The owner replaces this entire object on reconnect;
/// outstanding calls never migrate to a new socket or retry automatically.
pub struct RealtimeConnection {
    sender: SocketSender,
    receiver: SocketReceiver,
    downloads: FuturesUnordered<futures::future::BoxFuture<'static, Result<Option<Incoming>>>>,
    client: Client,
    payloads: super::realtime_payload::PayloadClient,
    pub user_id: String,
    pub device_id: String,
}

#[derive(Clone)]
pub struct RealtimeSender {
    sender: SocketSender,
    payloads: super::realtime_payload::PayloadClient,
}

impl RealtimeConnection {
    pub async fn connect(relay_url: &str, token: &str, machine: bool) -> Result<Self> {
        super::relay_client::ensure_rustls_crypto_provider();
        let mut base = reqwest::Url::parse(relay_url)?;
        if !matches!(base.scheme(), "http" | "https")
            || !base.username().is_empty()
            || base.password().is_some()
            || base.query().is_some()
            || base.fragment().is_some()
        {
            bail!("Invalid Relay URL");
        }
        // url::join treats a final segment as a file unless it ends in '/'.
        // Preserve the official versioned Relay mount as well as local roots.
        base.set_path(&format!("{}/", base.path().trim_end_matches('/')));
        let payloads = super::realtime_payload::PayloadClient::new(&base, token)?;
        let client = ClientBuilder::new(base)
            .path("v1/updates/")
            .transport(TransportStrategy::WebSocket)
            .channels(64usize)
            .http_client(super::relay_http::relay_http_client().clone())
            .open()?;
        let auth = account_auth_payload(token, machine).to_string();
        let (sender, mut receiver) = client.connect_with("/", auth).await?;
        let identity = tokio::time::timeout(Duration::from_secs(15), async {
            loop {
                match receiver
                    .recv()
                    .await
                    .ok_or_else(|| anyhow!("Relay connection closed"))?
                {
                    Signal::Event(event) => {
                        if let Incoming::AuthOk(event) = Incoming::try_from(event)? {
                            return Ok::<_, anyhow::Error>(event.payload.0);
                        }
                    }
                    Signal::Connect(_) => {}
                    Signal::ConnectError(_) => bail!("Relay authentication rejected"),
                    Signal::Disconnect => {
                        bail!("Relay disconnected before authentication completed")
                    }
                }
            }
        })
        .await
        .map_err(|_| anyhow!("Relay authentication timed out"))??;
        let connection = Self {
            sender,
            receiver,
            downloads: FuturesUnordered::new(),
            client,
            payloads,
            user_id: identity["userId"]
                .as_str()
                .ok_or_else(|| anyhow!("Missing account identity"))?
                .into(),
            device_id: identity["deviceId"]
                .as_str()
                .ok_or_else(|| anyhow!("Missing device identity"))?
                .into(),
        };
        if machine {
            let ack = connection
                .sender
                .emit(RpcRegister(
                    json!({"method":format!("{}:invoke",connection.device_id)}),
                ))
                .await?
                .timeout(Duration::from_secs(10))
                .await?;
            if ack.payload.0["ok"] != true {
                bail!("Relay RPC registration rejected");
            }
        }
        Ok(connection)
    }
    pub fn sender(&self) -> RealtimeSender {
        RealtimeSender {
            sender: self.sender.clone(),
            payloads: self.payloads.clone(),
        }
    }
    pub async fn receive(&mut self) -> Result<Incoming> {
        loop {
            let signal = tokio::select! {
                completed = self.downloads.next(), if !self.downloads.is_empty() => {
                    if let Some(incoming) = completed { if let Some(incoming) = incoming? { return Ok(incoming); } }
                    continue;
                }
                signal = self.receiver.recv() => signal.ok_or_else(|| anyhow!("Relay connection closed"))?,
            };
            match signal {
                Signal::Event(event) => {
                    let incoming = Incoming::try_from(event)?;
                    if let Incoming::RpcRequest(mut request) = incoming {
                        let payloads = self.payloads.clone();
                        let sender = self.sender.clone();
                        self.downloads.push(Box::pin(async move {
                            let params = request
                                .payload
                                .0
                                .get_mut("params")
                                .ok_or_else(|| anyhow!("RPC params missing"))?;
                            match payloads.resolve(params.take()).await {
                                Ok(resolved) => *params = resolved,
                                Err(_) => {
                                    let _ = sender.acknowledge(request.id, JsonAck(json!({"$relayError":"RPC payload unavailable; request was not executed"}))).await;
                                    return Ok(None);
                                }
                            }
                            Ok(Some(Incoming::RpcRequest(request)))
                        }));
                    } else {
                        return Ok(incoming);
                    }
                }
                Signal::Connect(_) => {}
                Signal::ConnectError(_) => bail!("Relay authentication rejected"),
                Signal::Disconnect => bail!("Relay disconnected"),
            }
        }
    }
    pub async fn close(self) {
        // A server-initiated close may already have stopped the Socket.IO
        // manager. Do not let graceful teardown block the reconnect owner.
        let _ = tokio::time::timeout(Duration::from_secs(5), self.sender.disconnect()).await;
        drop(self.sender);
        drop(self.receiver);
        // Joining releases the Engine.IO heartbeat and socket tasks as well as
        // the namespace. A replacement connection has no abandoned owner.
        let _ = tokio::time::timeout(Duration::from_secs(5), self.client.join()).await;
    }
}
impl RealtimeSender {
    pub async fn event(&self, target: &str, params: Value) -> Result<()> {
        let response = self
            .sender
            .emit(MachineEvent(
                json!({"targetDeviceId":target,"params":params}),
            ))
            .await?
            .timeout(Duration::from_secs(10))
            .await?;
        if response.payload.0["ok"] != true {
            bail!(
                "Relay event rejected: {}",
                response.payload.0["error"]
                    .as_str()
                    .unwrap_or("no reason provided by relay")
            );
        }
        Ok(())
    }
    pub async fn call(&self, target: &str, params: Value) -> Result<Value> {
        self.call_with_timeout(target, params, DEFAULT_RPC_TIMEOUT)
            .await
    }
    /// Call a target device with an explicit end-to-end deadline. The relay
    /// forwards `timeoutMs` to the target, whose reply owner uses it as its
    /// deadline, so a long-running command must carry its budget here.
    pub async fn call_with_timeout(
        &self,
        target: &str,
        params: Value,
        timeout: Duration,
    ) -> Result<Value> {
        let params = self.payloads.upload_if_large(params).await?;
        let deadlines = RpcCallDeadlines::for_timeout(timeout);
        let ack = tokio::time::timeout(deadlines.overall, async {
            self.sender
                .emit(RpcCall(rpc_call_payload(target, params, deadlines.target)))
                .await?
                .timeout(deadlines.ack)
                .await
                .map_err(anyhow::Error::from)
        })
        .await
        .map_err(|_| anyhow!("Relay RPC timed out; delivery outcome is unknown"))??;
        let result = ack.payload.0;
        if result["ok"] != true {
            bail!("{}", result["error"].as_str().unwrap_or("Relay RPC failed"));
        }
        self.payloads
            .resolve(
                result
                    .get("result")
                    .cloned()
                    .ok_or_else(|| anyhow!("Relay RPC response missing result"))?,
            )
            .await
    }
    pub async fn respond(&self, id: AckId<JsonAck>, result: Value) -> Result<()> {
        let result = self.payloads.upload_if_large(result).await?;
        tokio::time::timeout(
            Duration::from_secs(10),
            self.sender.acknowledge(id, JsonAck(result)),
        )
        .await
        .map_err(|_| anyhow!("Relay response write timed out"))??;
        Ok(())
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn default_rpc_payload_keeps_the_legacy_deadlines() {
        let deadlines = RpcCallDeadlines::for_timeout(DEFAULT_RPC_TIMEOUT);
        assert_eq!(deadlines.target, Duration::from_secs(120));
        assert_eq!(deadlines.ack, Duration::from_secs(123));
        assert_eq!(deadlines.overall, Duration::from_secs(125));
        let payload = rpc_call_payload("device-1", json!({"nonce":"n"}), deadlines.target);
        assert_eq!(payload["method"], "device-1:invoke");
        assert_eq!(payload["timeoutMs"], 120_000);
    }

    #[test]
    fn long_rpc_carries_its_budget_to_the_target() {
        let deadlines = RpcCallDeadlines::for_timeout(Duration::from_millis(185_000));
        let payload = rpc_call_payload("device-1", json!({}), deadlines.target);
        // Hosts derive their reply deadline from this field.
        assert_eq!(payload["timeoutMs"], 185_000);
        assert!(deadlines.ack > deadlines.target);
        assert!(deadlines.overall > deadlines.ack);
    }
}
