//! Lightweight CDP (Chrome DevTools Protocol) client over WebSocket.

use crate::util::errors::{OpenBitFunError, OpenBitFunResult};
use futures::stream::{SplitSink, SplitStream};
use futures::{SinkExt, StreamExt};
use log::{debug, info, warn};
use openbitfun_services_integrations::browser_control::CdpEndpointProvider;
pub use openbitfun_services_integrations::browser_control::{CdpPageInfo, CdpVersionInfo};
use serde_json::{json, Value};
use std::collections::{HashMap, HashSet};
use std::sync::atomic::{AtomicBool, AtomicI64, Ordering};
use std::sync::{Arc, OnceLock, Weak};
use std::time::Duration;
use tokio::net::TcpStream;
use tokio::sync::{broadcast, Mutex, RwLock};
use tokio_tungstenite::tungstenite::Message;
use tokio_tungstenite::{connect_async, MaybeTlsStream, WebSocketStream};

use super::browser_launcher::BrowserKind;
use super::{BrowserAutomationCapabilities, BrowserAutomationClient, BrowserAutomationEvent};

type WsSink = SplitSink<WebSocketStream<MaybeTlsStream<TcpStream>>, Message>;
type WsStream = SplitStream<WebSocketStream<MaybeTlsStream<TcpStream>>>;
type PendingResponses = Arc<RwLock<HashMap<i64, tokio::sync::oneshot::Sender<Value>>>>;
type EventChannels = Arc<RwLock<HashMap<Option<String>, broadcast::Sender<CdpEvent>>>>;
type SessionStatuses = Arc<RwLock<HashMap<String, Weak<AtomicBool>>>>;

const PAGE_CDP_CONNECT_TIMEOUT: Duration = Duration::from_secs(30);
const USER_PROFILE_APPROVAL_TIMEOUT: Duration = Duration::from_secs(90);

/// Backward-compatible name for events recorded by CDP-only diagnostics.
pub type CdpEvent = BrowserAutomationEvent;

struct CdpTransport {
    sink: Arc<Mutex<WsSink>>,
    pending: PendingResponses,
    next_id: AtomicI64,
    event_channels: EventChannels,
    session_statuses: SessionStatuses,
    alive: Arc<AtomicBool>,
    reader_handle: tokio::task::JoinHandle<()>,
}

impl Drop for CdpTransport {
    fn drop(&mut self) {
        self.reader_handle.abort();
    }
}

/// A CDP client connected either directly to a page WebSocket or to a flattened
/// target session carried by a browser-level WebSocket. The latter is required
/// for user-approved real-profile connections because guarded endpoints do not
/// necessarily expose the legacy `/json` HTTP API.
pub struct CdpClient {
    transport: Arc<CdpTransport>,
    session_id: Option<String>,
    events: broadcast::Sender<CdpEvent>,
    session_alive: Option<Arc<AtomicBool>>,
}

/// Process-wide browser connection retained after the user approves OpenBitFun.
/// Keeping one browser WebSocket avoids repeated approval prompts and lets
/// settings commands and agent tools share the same live profile.
#[derive(Clone)]
pub struct CdpBrowserConnection {
    pub actual_port: u16,
    pub browser_kind: BrowserKind,
    pub client: Arc<CdpClient>,
}

static BROWSER_CONNECTIONS: OnceLock<RwLock<HashMap<u16, CdpBrowserConnection>>> = OnceLock::new();
static AUTHORIZED_LEGACY_BROWSERS: OnceLock<RwLock<HashMap<u16, BrowserKind>>> = OnceLock::new();
static SUPPRESSED_BROWSER_CONNECTIONS: OnceLock<RwLock<HashSet<u16>>> = OnceLock::new();

fn browser_connections() -> &'static RwLock<HashMap<u16, CdpBrowserConnection>> {
    BROWSER_CONNECTIONS.get_or_init(|| RwLock::new(HashMap::new()))
}

fn suppressed_browser_connections() -> &'static RwLock<HashSet<u16>> {
    SUPPRESSED_BROWSER_CONNECTIONS.get_or_init(|| RwLock::new(HashSet::new()))
}

impl CdpClient {
    /// Discover browser version on a legacy fixed debug port.
    pub async fn get_version(port: u16) -> OpenBitFunResult<CdpVersionInfo> {
        CdpEndpointProvider::get_version(port)
            .await
            .map_err(|error| OpenBitFunError::tool(error.to_string()))
    }

    /// List all pages/tabs on a legacy fixed debug port.
    pub async fn list_pages(port: u16) -> OpenBitFunResult<Vec<CdpPageInfo>> {
        CdpEndpointProvider::list_pages(port)
            .await
            .map_err(|error| OpenBitFunError::tool(error.to_string()))
    }

    /// Create a new page/tab on a legacy fixed debug port.
    pub async fn create_page(port: u16, url: Option<&str>) -> OpenBitFunResult<CdpPageInfo> {
        CdpEndpointProvider::create_page(port, url)
            .await
            .map_err(|error| OpenBitFunError::tool(error.to_string()))
    }

    /// Connect to a specific page by its legacy WebSocket debugger URL.
    pub async fn connect(ws_url: &str) -> OpenBitFunResult<Self> {
        info!("CDP connecting to page WebSocket");
        Self::connect_with_timeout(ws_url, PAGE_CDP_CONNECT_TIMEOUT).await
    }

    /// Connect to a guarded browser-level endpoint and retain it under the
    /// logical port used by OpenBitFun's browser tools. The WebSocket handshake
    /// waits for the user to approve the request in their browser.
    pub async fn connect_user_profile_browser(
        logical_port: u16,
        actual_port: u16,
        browser_kind: &BrowserKind,
        ws_url: &str,
    ) -> OpenBitFunResult<CdpBrowserConnection> {
        if Self::browser_connection_suppressed(logical_port).await {
            return Err(OpenBitFunError::tool(
                "Browser control was disconnected in Settings. Reconnect it there before attaching again."
                    .to_string(),
            ));
        }
        if let Some(existing) = Self::browser_connection(logical_port).await {
            if existing.actual_port == actual_port && existing.browser_kind == *browser_kind {
                return Ok(existing);
            }
        }

        info!(
            "Requesting user-approved browser profile connection on port {}",
            actual_port
        );
        let client = Arc::new(
            Self::connect_with_timeout(ws_url, USER_PROFILE_APPROVAL_TIMEOUT)
                .await
                .map_err(|error| {
                    OpenBitFunError::tool(format!(
                        "Could not connect to the current browser profile. Approve OpenBitFun's remote debugging request in the browser, then try again: {}",
                        error
                    ))
                })?,
        );
        // Validate that this is a browser-level CDP endpoint before retaining
        // it. This also fails quickly if the DevToolsActivePort file was stale.
        client.browser_version().await?;
        if Self::browser_connection_suppressed(logical_port).await {
            client.disconnect().await;
            return Err(OpenBitFunError::tool(
                "Browser Control was disconnected while approval was pending",
            ));
        }

        let connection = CdpBrowserConnection {
            actual_port,
            browser_kind: browser_kind.clone(),
            client,
        };
        browser_connections()
            .write()
            .await
            .insert(logical_port, connection.clone());
        if Self::browser_connection_suppressed(logical_port).await {
            Self::disconnect_browser_connection(logical_port).await;
            return Err(OpenBitFunError::tool(
                "Browser Control was disconnected while approval was pending",
            ));
        }
        Ok(connection)
    }

    /// Return a healthy retained browser connection, pruning it if the browser
    /// has closed the underlying WebSocket.
    pub async fn browser_connection(logical_port: u16) -> Option<CdpBrowserConnection> {
        let existing = browser_connections()
            .read()
            .await
            .get(&logical_port)
            .cloned();
        match existing {
            Some(connection) if connection.client.is_connected() => Some(connection),
            Some(_) => {
                browser_connections().write().await.remove(&logical_port);
                None
            }
            None => None,
        }
    }

    /// Return the retained connection only when it belongs to the browser the
    /// caller selected. A logical tool port is shared by every browser option,
    /// so blindly reusing it after a Chrome/Edge switch would control the wrong
    /// profile.
    pub async fn browser_connection_for_kind(
        logical_port: u16,
        browser_kind: &BrowserKind,
    ) -> Option<CdpBrowserConnection> {
        Self::browser_connection(logical_port)
            .await
            .filter(|connection| connection.browser_kind == *browser_kind)
    }

    /// Forget the browser-level connection assigned to a logical tool port.
    /// Existing page sessions retain their own transport references, while
    /// subsequent browser actions resolve against the newly selected browser.
    pub async fn remove_browser_connection(logical_port: u16) {
        browser_connections().write().await.remove(&logical_port);
    }

    /// Close and forget the browser-level connection assigned to a logical
    /// tool port. Unlike [`remove_browser_connection`], this is an explicit
    /// user disconnect: all flattened page clients sharing the transport are
    /// invalidated immediately instead of being allowed to finish naturally.
    pub async fn disconnect_browser_connection(logical_port: u16) -> bool {
        let connection = browser_connections().write().await.remove(&logical_port);
        if let Some(connection) = connection {
            connection.client.disconnect().await;
            true
        } else {
            false
        }
    }

    /// Prevent agent-driven actions from silently reattaching after the user
    /// explicitly disconnected Browser Control in Settings. An explicit user
    /// connect action clears this process-local guard.
    pub async fn suppress_browser_connection(logical_port: u16) {
        AUTHORIZED_LEGACY_BROWSERS
            .get_or_init(|| RwLock::new(HashMap::new()))
            .write()
            .await
            .remove(&logical_port);
        suppressed_browser_connections()
            .write()
            .await
            .insert(logical_port);
    }

    /// Settings calls this only after its selected legacy browser is connected.
    /// Merely discovering an open debugging port is not a user grant.
    pub async fn authorize_legacy_browser(logical_port: u16, kind: &BrowserKind) {
        if !Self::browser_connection_suppressed(logical_port).await {
            AUTHORIZED_LEGACY_BROWSERS
                .get_or_init(|| RwLock::new(HashMap::new()))
                .write()
                .await
                .insert(logical_port, kind.clone());
        }
    }

    pub async fn authorized_browser_kind(logical_port: u16) -> Option<BrowserKind> {
        if Self::browser_connection_suppressed(logical_port).await {
            return None;
        }
        if let Some(connection) = Self::browser_connection(logical_port).await {
            return Some(connection.browser_kind);
        }
        AUTHORIZED_LEGACY_BROWSERS
            .get_or_init(|| RwLock::new(HashMap::new()))
            .read()
            .await
            .get(&logical_port)
            .cloned()
    }

    pub async fn allow_browser_connection(logical_port: u16) {
        suppressed_browser_connections()
            .write()
            .await
            .remove(&logical_port);
    }

    pub async fn browser_connection_suppressed(logical_port: u16) -> bool {
        suppressed_browser_connections()
            .read()
            .await
            .contains(&logical_port)
    }

    async fn connect_with_timeout(ws_url: &str, timeout: Duration) -> OpenBitFunResult<Self> {
        let (ws_stream, _) = tokio::time::timeout(timeout, connect_async(ws_url))
            .await
            .map_err(|_| {
                OpenBitFunError::tool(
                    "Timed out waiting for the CDP WebSocket connection".to_string(),
                )
            })?
            .map_err(|error| {
                OpenBitFunError::tool(format!("CDP WebSocket connect failed: {}", error))
            })?;

        let (sink, stream) = ws_stream.split();
        let sink = Arc::new(Mutex::new(sink));
        let pending: PendingResponses = Arc::new(RwLock::new(HashMap::new()));
        let event_channels: EventChannels = Arc::new(RwLock::new(HashMap::new()));
        let session_statuses: SessionStatuses = Arc::new(RwLock::new(HashMap::new()));
        let alive = Arc::new(AtomicBool::new(true));

        // Buffer up to 256 events per target subscriber. Lifecycle / network
        // events arrive in bursts during page load; older entries can be
        // dropped from a lagging subscriber without affecting the protocol.
        let (events_tx, _) = broadcast::channel::<CdpEvent>(256);
        event_channels.write().await.insert(None, events_tx.clone());

        let reader_handle = tokio::spawn(Self::reader_loop(
            stream,
            pending.clone(),
            event_channels.clone(),
            session_statuses.clone(),
            alive.clone(),
        ));

        Ok(Self {
            transport: Arc::new(CdpTransport {
                sink,
                pending,
                next_id: AtomicI64::new(1),
                event_channels,
                session_statuses,
                alive,
                reader_handle,
            }),
            session_id: None,
            events: events_tx,
            session_alive: None,
        })
    }

    /// Subscribe to events for this page session only.
    pub fn subscribe_events(&self) -> broadcast::Receiver<CdpEvent> {
        self.events.subscribe()
    }

    /// Returns `true` while the underlying WebSocket and, for a flattened page
    /// session, that specific target session are still alive.
    pub fn is_connected(&self) -> bool {
        self.transport.alive.load(Ordering::SeqCst)
            && self
                .session_alive
                .as_ref()
                .map(|alive| alive.load(Ordering::SeqCst))
                .unwrap_or(true)
    }

    /// Explicitly close this CDP transport and invalidate every page session
    /// multiplexed over it. This is idempotent so a browser-level connection
    /// and its registered page sessions can all participate in one cleanup.
    pub async fn disconnect(&self) {
        if !self.transport.alive.swap(false, Ordering::SeqCst) {
            return;
        }

        self.transport.pending.write().await.clear();
        self.transport.event_channels.write().await.clear();
        for status in self
            .transport
            .session_statuses
            .write()
            .await
            .drain()
            .map(|(_, status)| status)
        {
            if let Some(status) = status.upgrade() {
                status.store(false, Ordering::SeqCst);
            }
        }

        // The local state above makes disconnect observable immediately. Give
        // the browser a short opportunity to receive a normal WebSocket close
        // frame, then abort the reader so a stalled peer cannot hold up the UI.
        let sink = self.transport.sink.clone();
        let _ = tokio::time::timeout(Duration::from_secs(1), async move {
            sink.lock().await.send(Message::Close(None)).await
        })
        .await;
        self.transport.reader_handle.abort();
    }

    /// Connect to the first available page on a legacy debug port.
    pub async fn connect_to_first_page(port: u16) -> OpenBitFunResult<Self> {
        let pages = Self::list_pages(port).await?;
        let page = pages
            .iter()
            .find(|page| {
                page.page_type.as_deref() == Some("page") && page.web_socket_debugger_url.is_some()
            })
            .or_else(|| pages.first())
            .ok_or_else(|| OpenBitFunError::tool("No browser pages found via CDP".to_string()))?;

        let ws_url = page.web_socket_debugger_url.as_ref().ok_or_else(|| {
            OpenBitFunError::tool("Page has no WebSocket debugger URL".to_string())
        })?;

        Self::connect(ws_url).await
    }

    /// Query version metadata from a browser-level CDP connection.
    pub async fn browser_version(&self) -> OpenBitFunResult<CdpVersionInfo> {
        self.require_browser_connection()?;
        let result = self.send("Browser.getVersion", None).await?;
        Ok(CdpVersionInfo {
            user_agent: result
                .get("userAgent")
                .and_then(Value::as_str)
                .map(str::to_string),
            browser: result
                .get("product")
                .and_then(Value::as_str)
                .map(str::to_string),
            protocol_version: result
                .get("protocolVersion")
                .and_then(Value::as_str)
                .map(str::to_string),
            web_socket_debugger_url: None,
        })
    }

    /// List targets through the browser WebSocket. This replaces `/json` for
    /// an approval-only real-profile endpoint.
    pub async fn browser_pages(&self) -> OpenBitFunResult<Vec<CdpPageInfo>> {
        self.require_browser_connection()?;
        let result = self.send("Target.getTargets", None).await?;
        Ok(Self::page_infos_from_target_result(&result))
    }

    /// Create a target through the browser WebSocket and return its metadata.
    pub async fn create_browser_page(&self, url: Option<&str>) -> OpenBitFunResult<CdpPageInfo> {
        self.require_browser_connection()?;
        let target_url = url.unwrap_or("about:blank");
        let result = self
            .send("Target.createTarget", Some(json!({ "url": target_url })))
            .await?;
        let target_id = result
            .get("targetId")
            .and_then(Value::as_str)
            .ok_or_else(|| {
                OpenBitFunError::tool("Target.createTarget returned no target id".to_string())
            })?
            .to_string();

        for _ in 0..10 {
            if let Some(page) = self
                .browser_pages()
                .await?
                .into_iter()
                .find(|page| page.id == target_id)
            {
                return Ok(page);
            }
            tokio::time::sleep(Duration::from_millis(50)).await;
        }

        Ok(CdpPageInfo {
            id: target_id,
            title: String::new(),
            url: target_url.to_string(),
            web_socket_debugger_url: None,
            page_type: Some("page".to_string()),
        })
    }

    /// Attach to one target using a flattened CDP session carried over the
    /// retained browser WebSocket. All subsequent page commands are tagged with
    /// the returned `sessionId`, while events are routed to this client only.
    pub async fn attach_to_page(&self, target_id: &str) -> OpenBitFunResult<Self> {
        self.require_browser_connection()?;
        let result = self
            .send(
                "Target.attachToTarget",
                Some(json!({ "targetId": target_id, "flatten": true })),
            )
            .await?;
        let session_id = result
            .get("sessionId")
            .and_then(Value::as_str)
            .ok_or_else(|| {
                OpenBitFunError::tool("Target.attachToTarget returned no session id".to_string())
            })?
            .to_string();

        let (events_tx, _) = broadcast::channel::<CdpEvent>(256);
        self.transport
            .event_channels
            .write()
            .await
            .insert(Some(session_id.clone()), events_tx.clone());
        let session_alive = Arc::new(AtomicBool::new(true));
        self.transport
            .session_statuses
            .write()
            .await
            .insert(session_id.clone(), Arc::downgrade(&session_alive));

        Ok(Self {
            transport: self.transport.clone(),
            session_id: Some(session_id),
            events: events_tx,
            session_alive: Some(session_alive),
        })
    }

    fn require_browser_connection(&self) -> OpenBitFunResult<()> {
        if self.session_id.is_some() {
            return Err(OpenBitFunError::tool(
                "This CDP operation requires the browser-level connection".to_string(),
            ));
        }
        Ok(())
    }

    fn page_infos_from_target_result(result: &Value) -> Vec<CdpPageInfo> {
        result
            .get("targetInfos")
            .and_then(Value::as_array)
            .into_iter()
            .flatten()
            .filter_map(|target| {
                let id = target.get("targetId")?.as_str()?.to_string();
                Some(CdpPageInfo {
                    id,
                    title: target
                        .get("title")
                        .and_then(Value::as_str)
                        .unwrap_or_default()
                        .to_string(),
                    url: target
                        .get("url")
                        .and_then(Value::as_str)
                        .unwrap_or_default()
                        .to_string(),
                    web_socket_debugger_url: None,
                    page_type: target
                        .get("type")
                        .and_then(Value::as_str)
                        .map(str::to_string),
                })
            })
            .collect()
    }

    /// Send a CDP method call and wait for the response.
    pub async fn send(&self, method: &str, params: Option<Value>) -> OpenBitFunResult<Value> {
        if !self.is_connected() {
            return Err(OpenBitFunError::tool(
                "CDP response channel closed".to_string(),
            ));
        }
        let id = self.transport.next_id.fetch_add(1, Ordering::SeqCst);
        let mut msg = json!({
            "id": id,
            "method": method,
            "params": params.unwrap_or(json!({})),
        });
        if let Some(session_id) = &self.session_id {
            msg["sessionId"] = json!(session_id);
        }

        let (tx, rx) = tokio::sync::oneshot::channel();
        self.transport.pending.write().await.insert(id, tx);

        debug!("CDP send id={} method={}", id, method);
        let send_result = {
            let mut sink = self.transport.sink.lock().await;
            sink.send(Message::Text(msg.to_string().into())).await
        };
        if let Err(error) = send_result {
            self.transport.pending.write().await.remove(&id);
            return Err(OpenBitFunError::tool(format!("CDP send failed: {}", error)));
        }

        let result = match tokio::time::timeout(Duration::from_secs(30), rx).await {
            Ok(Ok(result)) => result,
            Ok(Err(_)) => {
                return Err(OpenBitFunError::tool(
                    "CDP response channel closed".to_string(),
                ))
            }
            Err(_) => {
                self.transport.pending.write().await.remove(&id);
                return Err(OpenBitFunError::tool(format!(
                    "CDP timeout for method {}",
                    method
                )));
            }
        };

        if let Some(error) = result.get("error") {
            return Err(OpenBitFunError::tool(format!("CDP error: {}", error)));
        }

        Ok(result.get("result").cloned().unwrap_or(json!({})))
    }

    async fn reader_loop(
        mut stream: WsStream,
        pending: PendingResponses,
        event_channels: EventChannels,
        session_statuses: SessionStatuses,
        alive: Arc<AtomicBool>,
    ) {
        while let Some(msg_result) = stream.next().await {
            match msg_result {
                Ok(Message::Text(text)) => {
                    if let Ok(value) = serde_json::from_str::<Value>(&text) {
                        if let Some(id) = value.get("id").and_then(Value::as_i64) {
                            let sender = pending.write().await.remove(&id);
                            if let Some(sender) = sender {
                                let _ = sender.send(value);
                            }
                            continue;
                        }

                        let Some(method) = value
                            .get("method")
                            .and_then(Value::as_str)
                            .map(str::to_string)
                        else {
                            continue;
                        };
                        let params = value.get("params").cloned().unwrap_or(json!({}));

                        if method == "Target.detachedFromTarget" {
                            if let Some(session_id) =
                                params.get("sessionId").and_then(Value::as_str)
                            {
                                if let Some(status) = session_statuses
                                    .write()
                                    .await
                                    .remove(session_id)
                                    .and_then(|status| status.upgrade())
                                {
                                    status.store(false, Ordering::SeqCst);
                                }
                                event_channels
                                    .write()
                                    .await
                                    .remove(&Some(session_id.to_string()));
                            }
                        }

                        let route = value
                            .get("sessionId")
                            .and_then(Value::as_str)
                            .map(str::to_string);
                        if let Some(events) = event_channels.read().await.get(&route).cloned() {
                            let _ = events.send(CdpEvent { method, params });
                        }
                    }
                }
                Ok(Message::Close(_)) => {
                    debug!("CDP WebSocket closed by server");
                    break;
                }
                Err(error) => {
                    warn!("CDP WebSocket read error: {}", error);
                    break;
                }
                _ => {}
            }
        }

        alive.store(false, Ordering::SeqCst);
        pending.write().await.clear();
        for status in session_statuses
            .write()
            .await
            .drain()
            .map(|(_, status)| status)
        {
            if let Some(status) = status.upgrade() {
                status.store(false, Ordering::SeqCst);
            }
        }
    }
}

#[async_trait::async_trait]
impl BrowserAutomationClient for CdpClient {
    async fn send(&self, method: &str, params: Option<Value>) -> OpenBitFunResult<Value> {
        CdpClient::send(self, method, params).await
    }

    fn subscribe_events(&self) -> broadcast::Receiver<CdpEvent> {
        CdpClient::subscribe_events(self)
    }

    fn is_connected(&self) -> bool {
        CdpClient::is_connected(self)
    }

    fn capabilities(&self) -> BrowserAutomationCapabilities {
        BrowserAutomationCapabilities::cdp()
    }

    fn target_kind(&self) -> &'static str {
        "external_cdp"
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn browser_target_metadata_maps_to_page_info() {
        let pages = CdpClient::page_infos_from_target_result(&json!({
            "targetInfos": [
                {
                    "targetId": "page-1",
                    "type": "page",
                    "title": "Inbox",
                    "url": "https://mail.example.test/"
                },
                {
                    "targetId": "worker-1",
                    "type": "service_worker",
                    "title": "Service Worker",
                    "url": "https://mail.example.test/sw.js"
                }
            ]
        }));

        assert_eq!(pages.len(), 2);
        assert_eq!(pages[0].id, "page-1");
        assert_eq!(pages[0].page_type.as_deref(), Some("page"));
        assert_eq!(pages[0].web_socket_debugger_url, None);
    }

    #[tokio::test]
    async fn browser_websocket_flattens_commands_and_routes_page_events() {
        let listener = tokio::net::TcpListener::bind(("127.0.0.1", 0))
            .await
            .expect("bind mock CDP server");
        let address = listener.local_addr().expect("mock CDP address");
        let server = tokio::spawn(async move {
            let (stream, _) = listener.accept().await.expect("accept CDP client");
            let mut socket = tokio_tungstenite::accept_async(stream)
                .await
                .expect("accept WebSocket");

            while let Some(message) = socket.next().await {
                let Message::Text(text) = message.expect("read CDP command") else {
                    continue;
                };
                let command: Value = serde_json::from_str(&text).expect("parse CDP command");
                let id = command
                    .get("id")
                    .and_then(Value::as_i64)
                    .expect("command id");
                let method = command
                    .get("method")
                    .and_then(Value::as_str)
                    .expect("command method");

                let result = match method {
                    "Browser.getVersion" => json!({
                        "product": "Chrome/151.0.0.0",
                        "protocolVersion": "1.3"
                    }),
                    "Target.getTargets" => json!({
                        "targetInfos": [{
                            "targetId": "page-1",
                            "type": "page",
                            "title": "Signed-in page",
                            "url": "https://example.test/"
                        }]
                    }),
                    "Target.attachToTarget" => {
                        assert_eq!(command["params"]["targetId"], "page-1");
                        assert_eq!(command["params"]["flatten"], true);
                        json!({ "sessionId": "session-1" })
                    }
                    "Runtime.enable" => {
                        assert_eq!(command["sessionId"], "session-1");
                        socket
                            .send(Message::Text(
                                json!({
                                    "method": "Runtime.consoleAPICalled",
                                    "sessionId": "session-1",
                                    "params": { "type": "log" }
                                })
                                .to_string()
                                .into(),
                            ))
                            .await
                            .expect("send flattened page event");
                        json!({})
                    }
                    other => panic!("unexpected CDP command: {other}"),
                };

                socket
                    .send(Message::Text(
                        json!({ "id": id, "result": result }).to_string().into(),
                    ))
                    .await
                    .expect("send CDP response");

                if method == "Runtime.enable" {
                    break;
                }
            }
        });

        let browser = CdpClient::connect(&format!("ws://{address}"))
            .await
            .expect("connect browser WebSocket");
        assert_eq!(
            browser
                .browser_version()
                .await
                .expect("browser version")
                .browser
                .as_deref(),
            Some("Chrome/151.0.0.0")
        );
        let pages = browser.browser_pages().await.expect("browser targets");
        assert_eq!(pages.len(), 1);

        let mut browser_events = browser.subscribe_events();
        let page = browser
            .attach_to_page(&pages[0].id)
            .await
            .expect("attach flattened page session");
        let mut page_events = page.subscribe_events();
        page.send("Runtime.enable", None)
            .await
            .expect("send flattened command");

        let event = tokio::time::timeout(Duration::from_secs(1), page_events.recv())
            .await
            .expect("page event timeout")
            .expect("page event");
        assert_eq!(event.method, "Runtime.consoleAPICalled");
        assert!(matches!(
            browser_events.try_recv(),
            Err(tokio::sync::broadcast::error::TryRecvError::Empty)
        ));

        server.await.expect("mock CDP server");
    }

    #[tokio::test]
    async fn disconnect_invalidates_browser_and_flattened_page_clients() {
        let listener = tokio::net::TcpListener::bind(("127.0.0.1", 0))
            .await
            .expect("bind mock CDP server");
        let address = listener.local_addr().expect("mock CDP address");
        let server = tokio::spawn(async move {
            let (stream, _) = listener.accept().await.expect("accept CDP client");
            let mut socket = tokio_tungstenite::accept_async(stream)
                .await
                .expect("accept WebSocket");

            while let Some(message) = socket.next().await {
                match message.expect("read CDP message") {
                    Message::Text(text) => {
                        let command: Value =
                            serde_json::from_str(&text).expect("parse CDP command");
                        let id = command
                            .get("id")
                            .and_then(Value::as_i64)
                            .expect("command id");
                        assert_eq!(command["method"], "Target.attachToTarget");
                        socket
                            .send(Message::Text(
                                json!({ "id": id, "result": { "sessionId": "session-1" } })
                                    .to_string()
                                    .into(),
                            ))
                            .await
                            .expect("send attach response");
                    }
                    Message::Close(_) => break,
                    _ => {}
                }
            }
        });

        let browser = CdpClient::connect(&format!("ws://{address}"))
            .await
            .expect("connect browser WebSocket");
        let page = browser
            .attach_to_page("page-1")
            .await
            .expect("attach flattened page session");
        assert!(browser.is_connected());
        assert!(page.is_connected());

        browser.disconnect().await;

        assert!(!browser.is_connected());
        assert!(!page.is_connected());
        let error = page
            .send("Runtime.enable", None)
            .await
            .expect_err("disconnected page must reject new commands");
        assert!(error.to_string().contains("response channel closed"));
        server.await.expect("mock CDP server");
    }
}
