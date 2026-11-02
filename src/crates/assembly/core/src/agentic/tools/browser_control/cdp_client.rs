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

use super::browser_launcher::{BrowserKind, BrowserLauncher};
use super::{BrowserAutomationCapabilities, BrowserAutomationClient, BrowserAutomationEvent};

type WsSink = SplitSink<WebSocketStream<MaybeTlsStream<TcpStream>>, Message>;
type WsStream = SplitStream<WebSocketStream<MaybeTlsStream<TcpStream>>>;
type PendingResponses = Arc<RwLock<HashMap<i64, tokio::sync::oneshot::Sender<Value>>>>;
type EventChannels = Arc<RwLock<HashMap<Option<String>, broadcast::Sender<CdpEvent>>>>;
type SessionStatuses = Arc<RwLock<HashMap<String, Weak<AtomicBool>>>>;

const PAGE_CDP_CONNECT_TIMEOUT: Duration = Duration::from_secs(30);
const USER_PROFILE_APPROVAL_TIMEOUT: Duration = Duration::from_secs(90);
/// Backoff between guarded WebSocket attempts that failed before the upgrade.
/// All attempts share [`USER_PROFILE_APPROVAL_TIMEOUT`].
const USER_PROFILE_CONNECT_RETRY_BACKOFF: [Duration; 4] = [
    Duration::from_millis(250),
    Duration::from_millis(500),
    Duration::from_secs(1),
    Duration::from_secs(2),
];
/// A reset faster than this cannot follow a user's answer to the approval
/// prompt, so it is treated as the endpoint not being ready yet.
const USER_PROFILE_FAST_RESET_WINDOW: Duration = Duration::from_secs(1);

/// Why a guarded user-profile connection could not be established.
#[derive(Debug)]
pub enum UserProfileConnectError {
    /// The endpoint answered the WebSocket upgrade with HTTP 404. An inferred
    /// endpoint may fall back to setup; authentication/permission refusals may not.
    NotABrowserEndpoint(OpenBitFunError),
    /// Any other failure: timeout, denial, transport error, product mismatch.
    Failed(OpenBitFunError),
}

impl UserProfileConnectError {
    pub fn into_error(self) -> OpenBitFunError {
        match self {
            Self::NotABrowserEndpoint(error) | Self::Failed(error) => error,
        }
    }
}

/// Why a WebSocket connection could not be opened.
enum WsConnectError {
    /// The TCP connect or HTTP upgrade did not finish in time. For a guarded
    /// endpoint this usually means the approval prompt is still pending.
    Timeout,
    Failed(tokio_tungstenite::tungstenite::Error),
}

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

    /// Create a new page/tab on a legacy fixed debug port without raising the
    /// browser window.
    ///
    /// `PUT /json/new` always creates a foreground tab. Background creation
    /// therefore goes through the browser-level WebSocket that `/json/version`
    /// advertises and falls back to the HTTP endpoint when that WebSocket is
    /// unavailable, so an old or restricted endpoint keeps working.
    pub async fn create_page_in_background(
        port: u16,
        url: Option<&str>,
    ) -> OpenBitFunResult<CdpPageInfo> {
        let Some(ws_url) = Self::get_version(port)
            .await
            .ok()
            .and_then(|version| version.web_socket_debugger_url)
        else {
            return Self::create_page(port, url).await;
        };
        let Ok(browser) = Self::connect(&ws_url).await else {
            return Self::create_page(port, url).await;
        };
        let created = browser.create_browser_page(url, true).await;
        browser.disconnect().await;
        let page = created?;

        // A browser-level create response carries no page WebSocket URL, but
        // legacy callers attach through it. Resolve the same target from `/json`
        // so both creation paths return the identical shape.
        for _ in 0..10 {
            if let Ok(pages) = Self::list_pages(port).await {
                if let Some(page) = pages.into_iter().find(|candidate| {
                    candidate.id == page.id && candidate.web_socket_debugger_url.is_some()
                }) {
                    return Ok(page);
                }
            }
            tokio::time::sleep(Duration::from_millis(50)).await;
        }

        Err(OpenBitFunError::tool(format!(
            "Created tab {} but its page WebSocket never appeared on port {}. Connect to that page by id instead of creating another tab.",
            page.id, port
        )))
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
        Self::connect_user_profile_browser_checked(logical_port, actual_port, browser_kind, ws_url)
            .await
            .map_err(UserProfileConnectError::into_error)
    }

    /// [`Self::connect_user_profile_browser`] with a distinct HTTP 404 result.
    /// Callers that inferred the endpoint from a 404 port probe may fall back
    /// to setup; other failures, including permission refusals, stay failures.
    pub async fn connect_user_profile_browser_checked(
        logical_port: u16,
        actual_port: u16,
        browser_kind: &BrowserKind,
        ws_url: &str,
    ) -> Result<CdpBrowserConnection, UserProfileConnectError> {
        if Self::browser_connection_suppressed(logical_port).await {
            return Err(UserProfileConnectError::Failed(OpenBitFunError::tool(
                "Browser control was disconnected in Settings. Reconnect it there before attaching again."
                    .to_string(),
            )));
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
        let wrap = |error: OpenBitFunError| {
            OpenBitFunError::tool(format!(
                "Could not connect to the current browser profile. Approve OpenBitFun's remote debugging request in the browser, then try again: {}",
                error
            ))
        };
        let client = Arc::new(
            Self::connect_user_profile_websocket(
                ws_url,
                USER_PROFILE_APPROVAL_TIMEOUT,
                &USER_PROFILE_CONNECT_RETRY_BACKOFF,
            )
            .await
            .map_err(|error| match error {
                UserProfileConnectError::NotABrowserEndpoint(error) => {
                    UserProfileConnectError::NotABrowserEndpoint(wrap(error))
                }
                UserProfileConnectError::Failed(error) => {
                    UserProfileConnectError::Failed(wrap(error))
                }
            })?,
        );
        Self::retain_user_profile_browser(logical_port, actual_port, browser_kind, client)
            .await
            .map_err(UserProfileConnectError::Failed)
    }

    async fn retain_user_profile_browser(
        logical_port: u16,
        actual_port: u16,
        browser_kind: &BrowserKind,
        client: Arc<CdpClient>,
    ) -> OpenBitFunResult<CdpBrowserConnection> {
        // Validate that this is a browser-level CDP endpoint before retaining
        // it. This also fails quickly if the DevToolsActivePort file was stale.
        let version = match client.browser_version().await {
            Ok(version) => version,
            Err(error) => {
                client.disconnect().await;
                return Err(error);
            }
        };
        // A guarded port found without DevToolsActivePort carries no product
        // identity, and Chrome and Edge both default to 9222. Never retain a
        // connection to the other browser's profile under this selection.
        if let Some(detected) = Self::guarded_product_mismatch(browser_kind, &version) {
            client.disconnect().await;
            return Err(OpenBitFunError::tool(format!(
                "The browser on port {} is {}, not the selected {}. Select {} in Settings > Browser control, or turn off remote debugging in it and connect {} instead.",
                actual_port, detected, browser_kind, detected, browser_kind
            )));
        }
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

    /// Detect a retained-connection candidate whose product is the other
    /// guarded browser (Chrome vs Edge). Edge may report a Chrome-like
    /// `product`, so its `Edg/` user-agent token is checked first.
    fn guarded_product_mismatch(
        expected: &BrowserKind,
        version: &CdpVersionInfo,
    ) -> Option<BrowserKind> {
        let detected = if version
            .user_agent
            .as_deref()
            .is_some_and(|agent| agent.contains("Edg/"))
        {
            Some(BrowserKind::Edge)
        } else {
            version
                .browser
                .as_deref()
                .and_then(BrowserLauncher::browser_kind_from_cdp_version)
        }?;
        match (expected, &detected) {
            (BrowserKind::Chrome, BrowserKind::Edge) | (BrowserKind::Edge, BrowserKind::Chrome) => {
                Some(detected)
            }
            _ => None,
        }
    }

    /// Open the guarded browser WebSocket within one overall budget.
    ///
    /// Guarded remote debugging sometimes refuses or resets a connection
    /// before the upgrade while the browser is still bringing its endpoint up,
    /// so those outright failures are retried with backoff. A handshake that
    /// stalls is different: the browser is showing its approval prompt, and
    /// every new socket would raise another prompt, so it is never retried.
    async fn connect_user_profile_websocket(
        ws_url: &str,
        budget: Duration,
        backoff: &[Duration],
    ) -> Result<Self, UserProfileConnectError> {
        let deadline = tokio::time::Instant::now() + budget;
        let mut delays = backoff.iter();
        loop {
            let remaining = deadline.saturating_duration_since(tokio::time::Instant::now());
            if remaining.is_zero() {
                return Err(UserProfileConnectError::Failed(
                    Self::websocket_timeout_error(),
                ));
            }
            let attempt_started = tokio::time::Instant::now();
            let error = match Self::open_websocket(ws_url, remaining).await {
                Ok(client) => return Ok(client),
                Err(WsConnectError::Timeout) => {
                    return Err(UserProfileConnectError::Failed(
                        Self::websocket_timeout_error(),
                    ))
                }
                Err(WsConnectError::Failed(error)) => error,
            };
            // Only a missing endpoint permits the setup fallback. Authentication
            // or permission refusals must remain failures, not trigger a new prompt.
            if matches!(
                &error,
                tokio_tungstenite::tungstenite::Error::Http(response)
                    if response.status() == tokio_tungstenite::tungstenite::http::StatusCode::NOT_FOUND
            ) {
                return Err(UserProfileConnectError::NotABrowserEndpoint(
                    Self::websocket_failed_error(&error),
                ));
            }
            let retryable = Self::is_retryable_before_upgrade(&error, attempt_started.elapsed());
            let delay = delays.next().copied();
            match delay {
                Some(delay)
                    if retryable
                        && deadline.saturating_duration_since(tokio::time::Instant::now())
                            > delay =>
                {
                    debug!(
                        "Guarded browser WebSocket connect failed before upgrade, retrying in {:?}: {}",
                        delay, error
                    );
                    tokio::time::sleep(delay).await;
                }
                _ => {
                    return Err(UserProfileConnectError::Failed(
                        Self::websocket_failed_error(&error),
                    ))
                }
            }
        }
    }

    /// A refused connection never reached the browser. A reset or abort is
    /// retried only when it arrives faster than any user decision could, so a
    /// browser that drops the socket after its prompt is not asked again.
    fn is_retryable_before_upgrade(
        error: &tokio_tungstenite::tungstenite::Error,
        elapsed: Duration,
    ) -> bool {
        use std::io::ErrorKind;
        let tokio_tungstenite::tungstenite::Error::Io(io_error) = error else {
            return false;
        };
        match io_error.kind() {
            ErrorKind::ConnectionRefused => true,
            ErrorKind::ConnectionReset | ErrorKind::ConnectionAborted => {
                elapsed < USER_PROFILE_FAST_RESET_WINDOW
            }
            _ => false,
        }
    }

    fn websocket_timeout_error() -> OpenBitFunError {
        OpenBitFunError::tool("Timed out waiting for the CDP WebSocket connection".to_string())
    }

    fn websocket_failed_error(error: &tokio_tungstenite::tungstenite::Error) -> OpenBitFunError {
        OpenBitFunError::tool(format!("CDP WebSocket connect failed: {}", error))
    }

    async fn connect_with_timeout(ws_url: &str, timeout: Duration) -> OpenBitFunResult<Self> {
        Self::open_websocket(ws_url, timeout)
            .await
            .map_err(|error| match error {
                WsConnectError::Timeout => Self::websocket_timeout_error(),
                WsConnectError::Failed(error) => Self::websocket_failed_error(&error),
            })
    }

    async fn open_websocket(ws_url: &str, timeout: Duration) -> Result<Self, WsConnectError> {
        let (ws_stream, _) = tokio::time::timeout(timeout, connect_async(ws_url))
            .await
            .map_err(|_| WsConnectError::Timeout)?
            .map_err(WsConnectError::Failed)?;

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
    ///
    /// `background` asks the browser not to activate the new tab.
    /// `Target.createTarget` defaults to a foreground tab, and a foreground tab
    /// raises the browser window and takes focus away from whatever the user is
    /// doing. Browsers that ignore the parameter degrade to the old behavior
    /// instead of failing the call.
    pub async fn create_browser_page(
        &self,
        url: Option<&str>,
        background: bool,
    ) -> OpenBitFunResult<CdpPageInfo> {
        self.require_browser_connection()?;
        let target_url = url.unwrap_or("about:blank");
        let mut request = json!({ "url": target_url });
        if background {
            request["background"] = json!(true);
        }
        let result = self.send("Target.createTarget", Some(request)).await?;
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
    async fn page_creation_only_asks_for_a_background_tab_when_requested() {
        let listener = tokio::net::TcpListener::bind(("127.0.0.1", 0))
            .await
            .expect("bind mock CDP server");
        let address = listener.local_addr().expect("mock CDP address");
        let server = tokio::spawn(async move {
            let (stream, _) = listener.accept().await.expect("accept CDP client");
            let mut socket = tokio_tungstenite::accept_async(stream)
                .await
                .expect("accept WebSocket");
            let mut requested_background = Vec::new();
            let mut created = 0;
            let mut listed = 0;

            while let Some(message) = socket.next().await {
                let Message::Text(text) = message.expect("read CDP command") else {
                    continue;
                };
                let command: Value = serde_json::from_str(&text).expect("parse CDP command");
                let id = command
                    .get("id")
                    .and_then(Value::as_i64)
                    .expect("command id");

                let result = match command
                    .get("method")
                    .and_then(Value::as_str)
                    .expect("command method")
                {
                    "Target.createTarget" => {
                        created += 1;
                        requested_background.push(command["params"]["background"].clone());
                        json!({ "targetId": format!("page-{created}") })
                    }
                    "Target.getTargets" => {
                        listed += 1;
                        json!({
                            "targetInfos": [{
                                "targetId": format!("page-{created}"),
                                "type": "page",
                                "title": "",
                                "url": "about:blank"
                            }]
                        })
                    }
                    other => panic!("unexpected CDP command: {other}"),
                };

                socket
                    .send(Message::Text(
                        json!({ "id": id, "result": result }).to_string().into(),
                    ))
                    .await
                    .expect("send CDP response");

                if listed == 2 {
                    break;
                }
            }

            requested_background
        });

        let browser = CdpClient::connect(&format!("ws://{address}"))
            .await
            .expect("connect browser WebSocket");
        browser
            .create_browser_page(None, true)
            .await
            .expect("create background page");
        browser
            .create_browser_page(None, false)
            .await
            .expect("create foreground page");

        let requested_background = server.await.expect("mock CDP server");
        assert_eq!(
            requested_background,
            vec![json!(true), Value::Null],
            "background creation asks for a background tab; foreground creation keeps the browser default"
        );
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

    /// Mock of Chromium's guarded remote debugging: every `/json*` HTTP
    /// request answers an empty 404, and only `/devtools/browser` upgrades to
    /// a browser-level CDP WebSocket that reports `product`.
    async fn spawn_guarded_browser(
        product: &'static str,
        user_agent: &'static str,
    ) -> (u16, Arc<std::sync::Mutex<Vec<String>>>) {
        use tokio::io::AsyncWriteExt;
        use tokio_tungstenite::tungstenite::handshake::server::{Request, Response};

        let listener = tokio::net::TcpListener::bind(("127.0.0.1", 0))
            .await
            .expect("bind guarded browser");
        let port = listener.local_addr().expect("address").port();
        let upgraded_paths = Arc::new(std::sync::Mutex::new(Vec::new()));
        let paths = upgraded_paths.clone();
        tokio::spawn(async move {
            loop {
                let Ok((mut stream, _)) = listener.accept().await else {
                    return;
                };
                let paths = paths.clone();
                tokio::spawn(async move {
                    let mut head = [0_u8; 2048];
                    let read = stream.peek(&mut head).await.unwrap_or(0);
                    let request = String::from_utf8_lossy(&head[..read]).to_ascii_lowercase();
                    if !request.contains("upgrade: websocket") {
                        let _ = stream
                            .write_all(
                                b"HTTP/1.1 404 Not Found\r\nContent-Length: 0\r\nConnection: close\r\n\r\n",
                            )
                            .await;
                        return;
                    }
                    let callback = |request: &Request, response: Response| {
                        paths.lock().unwrap().push(request.uri().path().to_string());
                        Ok(response)
                    };
                    let Ok(mut socket) =
                        tokio_tungstenite::accept_hdr_async(stream, callback).await
                    else {
                        return;
                    };
                    while let Some(Ok(message)) = socket.next().await {
                        let Message::Text(text) = message else {
                            continue;
                        };
                        let command: Value = serde_json::from_str(&text).expect("command");
                        let result = match command["method"].as_str() {
                            Some("Browser.getVersion") => json!({
                                "product": product,
                                "userAgent": user_agent,
                                "protocolVersion": "1.3"
                            }),
                            Some("Target.getTargets") => json!({
                                "targetInfos": [{
                                    "targetId": "page-1",
                                    "type": "page",
                                    "title": "Signed-in page",
                                    "url": "https://example.test/"
                                }]
                            }),
                            _ => json!({}),
                        };
                        let _ = socket
                            .send(Message::Text(
                                json!({ "id": command["id"], "result": result })
                                    .to_string()
                                    .into(),
                            ))
                            .await;
                    }
                });
            }
        });
        (port, upgraded_paths)
    }

    #[tokio::test]
    async fn guarded_port_without_json_endpoints_connects_over_browser_websocket() {
        let (port, upgraded_paths) = spawn_guarded_browser(
            "Chrome/156.0.8078.74",
            "Mozilla/5.0 (Macintosh) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/156.0.0.0 Safari/537.36",
        )
        .await;
        // The legacy HTTP discovery path reports actionable guidance instead
        // of a JSON parse error.
        let http_error = CdpClient::get_version(port).await.unwrap_err();
        assert!(http_error
            .to_string()
            .contains("Settings > Browser control"));

        // The endpoint the launcher infers for a 404 port whose browser runs.
        let endpoint = super::super::browser_launcher::BrowserDebugEndpoint {
            port,
            web_socket_url: format!("ws://127.0.0.1:{port}/devtools/browser"),
        };
        assert!(
            openbitfun_services_integrations::browser_control::BrowserLauncher::is_inferred_guarded_endpoint(&endpoint)
        );
        let logical_port = port;
        let connection = CdpClient::connect_user_profile_browser(
            logical_port,
            endpoint.port,
            &BrowserKind::Chrome,
            &endpoint.web_socket_url,
        )
        .await
        .expect("connect guarded browser");
        assert_eq!(connection.browser_kind, BrowserKind::Chrome);
        assert_eq!(
            upgraded_paths.lock().unwrap().as_slice(),
            ["/devtools/browser".to_string()]
        );
        let pages = connection.client.browser_pages().await.expect("targets");
        assert_eq!(pages.len(), 1);
        assert!(CdpClient::browser_connection(logical_port).await.is_some());
        assert!(CdpClient::disconnect_browser_connection(logical_port).await);
    }

    #[tokio::test]
    async fn guarded_port_owned_by_the_other_browser_is_not_retained() {
        let (port, _) = spawn_guarded_browser(
            "Chrome/156.0.0.0",
            "Mozilla/5.0 AppleWebKit/537.36 Chrome/156.0.0.0 Safari/537.36 Edg/156.0.0.0",
        )
        .await;
        let error = CdpClient::connect_user_profile_browser(
            port,
            port,
            &BrowserKind::Chrome,
            &format!("ws://127.0.0.1:{port}/devtools/browser"),
        )
        .await
        .err()
        .expect("Edge must not be retained as Chrome");
        assert!(error.to_string().contains("Microsoft Edge"));
        assert!(CdpClient::browser_connection(port).await.is_none());
    }

    #[test]
    fn product_mismatch_only_rejects_the_other_guarded_browser() {
        let version = |product: &str, agent: &str| CdpVersionInfo {
            user_agent: Some(agent.to_string()),
            browser: Some(product.to_string()),
            protocol_version: None,
            web_socket_debugger_url: None,
        };
        let chrome = version("Chrome/156.0", "Mozilla/5.0 Chrome/156.0 Safari/537.36");
        let edge = version("Chrome/156.0", "Mozilla/5.0 Chrome/156.0 Edg/156.0");
        assert_eq!(
            CdpClient::guarded_product_mismatch(&BrowserKind::Chrome, &chrome),
            None
        );
        assert_eq!(
            CdpClient::guarded_product_mismatch(&BrowserKind::Edge, &chrome),
            Some(BrowserKind::Chrome)
        );
        assert_eq!(
            CdpClient::guarded_product_mismatch(&BrowserKind::Chrome, &edge),
            Some(BrowserKind::Edge)
        );
        assert_eq!(
            CdpClient::guarded_product_mismatch(&BrowserKind::Brave, &chrome),
            None
        );
    }

    #[tokio::test]
    async fn guarded_websocket_retries_refused_connections_within_budget() {
        let reserved = std::net::TcpListener::bind("127.0.0.1:0").expect("reserve port");
        let port = reserved.local_addr().expect("address").port();
        drop(reserved);

        let server = tokio::spawn(async move {
            // Refuse the first attempts, then come up like a browser that is
            // still starting its guarded endpoint.
            tokio::time::sleep(Duration::from_millis(400)).await;
            let listener = tokio::net::TcpListener::bind(("127.0.0.1", port))
                .await
                .expect("rebind port");
            let (stream, _) = listener.accept().await.expect("accept");
            let mut socket = tokio_tungstenite::accept_async(stream)
                .await
                .expect("upgrade");
            while let Some(Ok(message)) = socket.next().await {
                if matches!(message, Message::Close(_)) {
                    break;
                }
            }
        });

        let backoff = [
            Duration::from_millis(100),
            Duration::from_millis(200),
            Duration::from_millis(400),
            Duration::from_millis(800),
        ];
        let client = CdpClient::connect_user_profile_websocket(
            &format!("ws://127.0.0.1:{port}/devtools/browser"),
            Duration::from_secs(10),
            &backoff,
        )
        .await
        .expect("retry until the endpoint accepts");
        client.disconnect().await;
        server.await.expect("server");
    }

    #[tokio::test]
    async fn guarded_websocket_never_retries_a_stalled_handshake() {
        let listener = tokio::net::TcpListener::bind(("127.0.0.1", 0))
            .await
            .expect("bind");
        let port = listener.local_addr().expect("address").port();
        let accepted = Arc::new(std::sync::atomic::AtomicUsize::new(0));
        let counter = accepted.clone();
        tokio::spawn(async move {
            let mut held = Vec::new();
            while let Ok((stream, _)) = listener.accept().await {
                // Hold the socket open without answering, like a browser
                // waiting on its approval prompt.
                counter.fetch_add(1, Ordering::SeqCst);
                held.push(stream);
            }
        });

        let error = CdpClient::connect_user_profile_websocket(
            &format!("ws://127.0.0.1:{port}/devtools/browser"),
            Duration::from_millis(300),
            &USER_PROFILE_CONNECT_RETRY_BACKOFF,
        )
        .await
        .err()
        .expect("stalled handshake must time out");
        assert!(matches!(error, UserProfileConnectError::Failed(_)));
        assert!(error.into_error().to_string().contains("Timed out"));
        tokio::time::sleep(Duration::from_millis(100)).await;
        assert_eq!(accepted.load(Ordering::SeqCst), 1);
    }

    #[tokio::test]
    async fn http_upgrade_denial_does_not_trigger_not_found_setup_fallback() {
        use tokio::io::{AsyncReadExt, AsyncWriteExt};

        for (status, not_found) in [
            ("404 Not Found", true),
            ("401 Unauthorized", false),
            ("403 Forbidden", false),
        ] {
            let listener = tokio::net::TcpListener::bind(("127.0.0.1", 0))
                .await
                .expect("bind");
            let port = listener.local_addr().expect("address").port();
            let accepted = Arc::new(std::sync::atomic::AtomicUsize::new(0));
            let counter = accepted.clone();
            let server = tokio::spawn(async move {
                while let Ok((mut stream, _)) = listener.accept().await {
                    counter.fetch_add(1, Ordering::SeqCst);
                    let mut buffer = [0_u8; 2048];
                    let _ = stream.read(&mut buffer).await;
                    let response = format!(
                        "HTTP/1.1 {status}\r\nContent-Length: 0\r\nConnection: close\r\n\r\n"
                    );
                    let _ = stream.write_all(response.as_bytes()).await;
                }
            });

            let error = CdpClient::connect_user_profile_browser_checked(
                port,
                port,
                &BrowserKind::Chrome,
                &format!("ws://127.0.0.1:{port}/devtools/browser"),
            )
            .await
            .err()
            .expect("a rejected upgrade must fail");
            server.abort();
            assert_eq!(
                matches!(error, UserProfileConnectError::NotABrowserEndpoint(_)),
                not_found,
                "access denial must not reopen setup: {status}"
            );
            assert_eq!(accepted.load(Ordering::SeqCst), 1);
            assert!(CdpClient::browser_connection(port).await.is_none());
        }
    }
}
