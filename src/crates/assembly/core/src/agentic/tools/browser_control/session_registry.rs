//! Browser session registry — addresses CDP pages by stable session id and
//! removes the previous "single global slot" footgun.
//!
//! ## Why
//!
//! The Phase-0 ControlHub kept exactly **one** `Option<CdpClient>` in a
//! `OnceLock<RwLock<…>>`. Every `connect` / `switch_page` clobbered the
//! slot, and every concurrent action raced on it. A second user task that
//! switched to a different tab would silently steal the connection from
//! the first task and break its in-flight `wait` / lifecycle subscription.
//!
//! ## Model
//!
//! - Each connected page is a `BrowserSession` keyed by `session_id` (the
//!   CDP page id, which is stable for the page's lifetime).
//! - The registry tracks an optional **default** session for backward
//!   compatibility with callers that omit `session_id`.
//! - All sessions are reachable via `Arc<CdpClient>` so concurrent actions
//!   on the *same* page share one WebSocket while sessions on *different*
//!   pages stay isolated.
//!
//! ## Lifecycle
//!
//! - `register(session_id, client)` inserts/replaces, spawns the event
//!   listener task, and bumps the default.
//! - `set_default(session_id)` is called by `switch_page`.
//! - `get(session_id)` resolves a specific id or falls back to the default.
//! - `remove(session_id)` is called by `close` or when CDP disconnects.
//!
//! ## Event Recording
//!
//! Each session records network (500 cap), console (200 cap), errors (200 cap),
//! and optional CDP trace (1000 cap). Queries support filter, since, and limit.

use crate::agentic::tools::browser_control::cdp_client::{CdpClient, CdpEvent};
use crate::util::errors::{OpenBitFunError, OpenBitFunResult};
use serde_json::{json, Value};
use std::collections::{HashMap, VecDeque};
use std::sync::atomic::{AtomicBool, AtomicU64, Ordering};
use std::sync::Arc;
use tokio::sync::{Mutex, RwLock};

const NETWORK_CAPACITY: usize = 500;
const CONSOLE_CAPACITY: usize = 200;
const ERROR_CAPACITY: usize = 200;
const TRACE_CAPACITY: usize = 1000;

#[derive(Clone, Debug)]
pub struct DialogHandler {
    pub accept: bool,
    pub prompt_text: Option<String>,
}

#[derive(Default)]
pub struct BrowserSessionState {
    next_seq: AtomicU64,
    last_action_seq: AtomicU64,
    trace_recording: AtomicBool,
    trace_events: Mutex<VecDeque<Value>>,
    network_events: Mutex<VecDeque<Value>>,
    console_events: Mutex<VecDeque<Value>>,
    js_errors: Mutex<VecDeque<Value>>,
    dialog_handler: Mutex<Option<DialogHandler>>,
}

impl BrowserSessionState {
    pub fn new() -> Self {
        Self::default()
    }

    fn next_seq(&self) -> u64 {
        self.next_seq.fetch_add(1, Ordering::SeqCst) + 1
    }

    pub fn record_action(&self) -> u64 {
        let seq = self.next_seq();
        self.last_action_seq.store(seq, Ordering::SeqCst);
        seq
    }

    fn since_threshold(&self, since: Option<&str>) -> Option<u64> {
        match since {
            Some("last_action") => Some(self.last_action_seq.load(Ordering::SeqCst)),
            Some(raw) => raw.parse::<u64>().ok(),
            None => None,
        }
    }

    async fn push_capped(queue: &Mutex<VecDeque<Value>>, value: Value, capacity: usize) {
        let mut guard = queue.lock().await;
        if guard.len() >= capacity {
            guard.pop_front();
        }
        guard.push_back(value);
    }

    pub async fn record_event(&self, event: CdpEvent) {
        let seq = self.next_seq();
        if self.trace_recording.load(Ordering::SeqCst) {
            Self::push_capped(
                &self.trace_events,
                json!({
                    "seq": seq,
                    "method": event.method,
                    "params": event.params,
                    "timestamp_ms": chrono::Utc::now().timestamp_millis(),
                }),
                TRACE_CAPACITY,
            )
            .await;
        }
        match event.method.as_str() {
            "Network.requestWillBeSent" => {
                let request = event
                    .params
                    .get("request")
                    .cloned()
                    .unwrap_or_else(|| json!({}));
                Self::push_capped(
                    &self.network_events,
                    json!({
                        "seq": seq,
                        "event": "request",
                        "request_id": event.params.get("requestId"),
                        "loader_id": event.params.get("loaderId"),
                        "type": event.params.get("type"),
                        "timestamp": event.params.get("timestamp"),
                        "url": request.get("url"),
                        "method": request.get("method"),
                        "headers": request.get("headers"),
                        "post_data": request.get("postData"),
                    }),
                    NETWORK_CAPACITY,
                )
                .await;
            }
            "Network.responseReceived" => {
                let response = event
                    .params
                    .get("response")
                    .cloned()
                    .unwrap_or_else(|| json!({}));
                Self::push_capped(
                    &self.network_events,
                    json!({
                        "seq": seq,
                        "event": "response",
                        "request_id": event.params.get("requestId"),
                        "type": event.params.get("type"),
                        "timestamp": event.params.get("timestamp"),
                        "url": response.get("url"),
                        "status": response.get("status"),
                        "status_text": response.get("statusText"),
                        "mime_type": response.get("mimeType"),
                        "headers": response.get("headers"),
                    }),
                    NETWORK_CAPACITY,
                )
                .await;
            }
            "Network.loadingFailed" => {
                Self::push_capped(
                    &self.network_events,
                    json!({
                        "seq": seq,
                        "event": "failed",
                        "request_id": event.params.get("requestId"),
                        "timestamp": event.params.get("timestamp"),
                        "error_text": event.params.get("errorText"),
                        "canceled": event.params.get("canceled"),
                    }),
                    NETWORK_CAPACITY,
                )
                .await;
            }
            "Runtime.consoleAPICalled" => {
                Self::push_capped(
                    &self.console_events,
                    json!({
                        "seq": seq,
                        "type": event.params.get("type"),
                        "timestamp": event.params.get("timestamp"),
                        "args": event.params.get("args"),
                        "execution_context_id": event.params.get("executionContextId"),
                        "stack_trace": event.params.get("stackTrace"),
                    }),
                    CONSOLE_CAPACITY,
                )
                .await;
            }
            "Runtime.exceptionThrown" => {
                Self::push_capped(
                    &self.js_errors,
                    json!({
                        "seq": seq,
                        "timestamp": event.params.get("timestamp"),
                        "exception_details": event.params.get("exceptionDetails"),
                    }),
                    ERROR_CAPACITY,
                )
                .await;
            }
            _ => {}
        }
    }

    pub async fn query_network(
        &self,
        filter: Option<&str>,
        method: Option<&str>,
        status: Option<&str>,
        since: Option<&str>,
        limit: usize,
    ) -> Vec<Value> {
        let threshold = self.since_threshold(since);
        Self::query(&self.network_events, filter, threshold, limit, |item| {
            if let Some(method) = method {
                let wanted = method.to_uppercase();
                let actual = item
                    .get("method")
                    .and_then(|v| v.as_str())
                    .map(str::to_uppercase);
                if actual.as_deref() != Some(wanted.as_str()) {
                    return false;
                }
            }
            if let Some(status_filter) = status {
                let status_value = item.get("status").and_then(|v| v.as_u64());
                let matched = match status_filter {
                    "4xx" => status_value
                        .map(|s| (400..500).contains(&s))
                        .unwrap_or(false),
                    "5xx" => status_value
                        .map(|s| (500..600).contains(&s))
                        .unwrap_or(false),
                    raw => raw
                        .parse::<u64>()
                        .ok()
                        .zip(status_value)
                        .map(|(wanted, actual)| wanted == actual)
                        .unwrap_or(false),
                };
                if !matched {
                    return false;
                }
            }
            true
        })
        .await
    }

    pub async fn query_network_requests(
        &self,
        filter: Option<&str>,
        method: Option<&str>,
        status: Option<&str>,
        since: Option<&str>,
        limit: usize,
    ) -> Vec<Value> {
        let events = self
            .query_network(filter, method, status, since, usize::MAX)
            .await;
        let mut order = Vec::<String>::new();
        let mut by_id = HashMap::<String, Value>::new();
        for event in events.into_iter().rev() {
            let Some(request_id) = event
                .get("request_id")
                .and_then(|v| v.as_str())
                .map(str::to_string)
            else {
                continue;
            };
            let entry = by_id.entry(request_id.clone()).or_insert_with(|| {
                order.push(request_id.clone());
                json!({ "request_id": request_id })
            });
            if let Some(obj) = entry.as_object_mut() {
                if let Some(seq) = event.get("seq") {
                    obj.insert("seq".to_string(), seq.clone());
                }
                match event.get("event").and_then(|v| v.as_str()) {
                    Some("request") => {
                        for key in ["url", "method", "type", "timestamp", "headers", "post_data"] {
                            if let Some(value) = event.get(key) {
                                obj.insert(key.to_string(), value.clone());
                            }
                        }
                    }
                    Some("response") => {
                        for key in ["url", "status", "status_text", "mime_type", "headers"] {
                            if let Some(value) = event.get(key) {
                                obj.insert(format!("response_{key}"), value.clone());
                            }
                        }
                    }
                    Some("failed") => {
                        obj.insert("failed".to_string(), json!(true));
                        if let Some(value) = event.get("error_text") {
                            obj.insert("failure_reason".to_string(), value.clone());
                        }
                    }
                    _ => {}
                }
            }
        }
        order
            .into_iter()
            .filter_map(|id| by_id.remove(&id))
            .rev()
            .take(limit.max(1))
            .collect()
    }

    pub async fn query_console(
        &self,
        filter: Option<&str>,
        since: Option<&str>,
        limit: usize,
    ) -> Vec<Value> {
        let threshold = self.since_threshold(since);
        Self::query(&self.console_events, filter, threshold, limit, |_| true).await
    }

    pub async fn query_errors(
        &self,
        filter: Option<&str>,
        since: Option<&str>,
        limit: usize,
    ) -> Vec<Value> {
        let threshold = self.since_threshold(since);
        Self::query(&self.js_errors, filter, threshold, limit, |_| true).await
    }

    async fn query<F>(
        queue: &Mutex<VecDeque<Value>>,
        filter: Option<&str>,
        since: Option<u64>,
        limit: usize,
        extra_filter: F,
    ) -> Vec<Value>
    where
        F: Fn(&Value) -> bool,
    {
        let needle = filter.map(str::to_lowercase);
        let guard = queue.lock().await;
        guard
            .iter()
            .rev()
            .filter(|item| {
                if let Some(threshold) = since {
                    if item.get("seq").and_then(|v| v.as_u64()).unwrap_or(0) <= threshold {
                        return false;
                    }
                }
                if !extra_filter(item) {
                    return false;
                }
                needle
                    .as_ref()
                    .map(|n| item.to_string().to_lowercase().contains(n))
                    .unwrap_or(true)
            })
            .take(limit.max(1))
            .cloned()
            .collect()
    }

    pub async fn clear_network(&self) {
        self.network_events.lock().await.clear();
    }

    pub async fn clear_console(&self) {
        self.console_events.lock().await.clear();
    }

    pub async fn clear_errors(&self) {
        self.js_errors.lock().await.clear();
    }

    pub async fn trace_start(&self) -> Value {
        self.trace_events.lock().await.clear();
        self.trace_recording.store(true, Ordering::SeqCst);
        json!({ "recording": true, "event_count": 0 })
    }

    pub async fn trace_stop(&self, limit: usize) -> Value {
        self.trace_recording.store(false, Ordering::SeqCst);
        let events = Self::query(&self.trace_events, None, None, limit, |_| true).await;
        json!({
            "recording": false,
            "event_count": events.len(),
            "events": events,
        })
    }

    pub async fn trace_status(&self) -> Value {
        let event_count = self.trace_events.lock().await.len();
        json!({
            "recording": self.trace_recording.load(Ordering::SeqCst),
            "event_count": event_count,
        })
    }

    pub async fn trace_clear(&self) -> Value {
        self.trace_recording.store(false, Ordering::SeqCst);
        self.trace_events.lock().await.clear();
        json!({ "recording": false, "event_count": 0, "cleared": true })
    }

    pub async fn arm_dialog(&self, handler: DialogHandler) {
        *self.dialog_handler.lock().await = Some(handler);
    }

    pub async fn take_dialog_handler(&self) -> Option<DialogHandler> {
        self.dialog_handler.lock().await.take()
    }
}

#[derive(Clone)]
pub struct BrowserSession {
    pub session_id: String,
    pub port: u16,
    /// Verified disposable headless endpoint, never the user-profile permission.
    pub headless: bool,
    pub client: Arc<CdpClient>,
    pub state: Arc<BrowserSessionState>,
}

impl std::fmt::Debug for BrowserSession {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.debug_struct("BrowserSession")
            .field("session_id", &self.session_id)
            .field("port", &self.port)
            .field("client", &"<CdpClient>")
            .finish()
    }
}

#[derive(Default)]
struct RegistryInner {
    sessions: HashMap<String, BrowserSession>,
    default_id: Option<String>,
    /// Conversation-local selection; the browser page id is not a Runtime session id.
    selections: HashMap<String, BrowserSelection>,
}

#[derive(Clone, Debug, PartialEq, Eq)]
pub struct BrowserSelection {
    pub target: String,
    pub session_id: String,
}

#[derive(Default)]
pub struct BrowserSessionRegistry {
    inner: RwLock<RegistryInner>,
}

impl BrowserSessionRegistry {
    pub fn new() -> Self {
        Self::default()
    }

    pub async fn selection(&self, owner: &str) -> Option<BrowserSelection> {
        self.inner.read().await.selections.get(owner).cloned()
    }

    pub async fn select(&self, owner: &str, target: &str, session_id: &str) {
        self.inner.write().await.selections.insert(
            owner.to_string(),
            BrowserSelection {
                target: target.to_string(),
                session_id: session_id.to_string(),
            },
        );
    }

    /// Forget only the Agent's selection, never close a user's browser page.
    pub async fn release_selection(&self, owner: &str) {
        self.inner.write().await.selections.remove(owner);
    }

    /// Insert or replace a session and mark it as the default.
    /// Also spawns a background task that consumes CDP events for recording
    /// and dialog auto-handling.
    pub async fn register(&self, session: BrowserSession) {
        let mut events = session.client.subscribe_events();
        let state = session.state.clone();
        let client = session.client.clone();
        tokio::spawn(async move {
            loop {
                match events.recv().await {
                    Ok(event) => {
                        if event.method == "Page.javascriptDialogOpening" {
                            if let Some(handler) = state.take_dialog_handler().await {
                                let mut params = json!({ "accept": handler.accept });
                                if let Some(text) = handler.prompt_text {
                                    params["promptText"] = json!(text);
                                }
                                let _ = client
                                    .send("Page.handleJavaScriptDialog", Some(params))
                                    .await;
                            }
                        }
                        state.record_event(event).await;
                    }
                    Err(tokio::sync::broadcast::error::RecvError::Lagged(_)) => continue,
                    Err(tokio::sync::broadcast::error::RecvError::Closed) => break,
                }
            }
        });
        let mut g = self.inner.write().await;
        let id = session.session_id.clone();
        g.sessions.insert(id.clone(), session);
        g.default_id = Some(id);
    }

    /// Promote an existing session to the default. No-op if the id is unknown.
    pub async fn set_default(&self, session_id: &str) -> OpenBitFunResult<()> {
        let mut g = self.inner.write().await;
        if !g.sessions.contains_key(session_id) {
            return Err(OpenBitFunError::tool(format!(
                "Browser session '{}' not registered.",
                session_id
            )));
        }
        g.default_id = Some(session_id.to_string());
        Ok(())
    }

    /// Resolve a session id (or the current default) to a session.
    ///
    /// Also prunes entries whose underlying CDP WebSocket reader task has
    /// terminated (the user closed the tab outside of our control). Without
    /// the prune, the next `send` call would block until its 30-second
    /// internal timeout — confusing the model with a `TIMEOUT` error code
    /// that hides the real `WRONG_TAB` failure mode.
    pub async fn get(&self, session_id: Option<&str>) -> OpenBitFunResult<BrowserSession> {
        // First pass: read-only resolve.
        let resolved = {
            let g = self.inner.read().await;
            let id = match session_id {
                Some(s) => s.to_string(),
                None => g.default_id.clone().ok_or_else(|| {
                    OpenBitFunError::tool(
                        "No browser session registered. Use action 'connect' first.".to_string(),
                    )
                })?,
            };
            g.sessions.get(&id).cloned().map(|s| (id, s))
        };

        let (id, session) = resolved.ok_or_else(|| {
            OpenBitFunError::tool(
                "[WRONG_TAB] Browser session is not connected. Use action 'connect' or 'switch_page' with the intended page id."
                    .to_string(),
            )
        })?;

        if !session.client.is_connected() {
            // Best-effort eviction. Acquire the write lock only when we
            // actually need to mutate the map.
            let mut g = self.inner.write().await;
            g.sessions.remove(&id);
            if g.default_id.as_deref() == Some(id.as_str()) {
                g.default_id = None;
            }
            return Err(OpenBitFunError::tool(format!(
                "Browser session '{}' is no longer connected (the tab was likely closed). Call 'connect' or 'switch_page' to attach a new one.",
                id
            )));
        }

        Ok(session)
    }

    /// Remove a session. If it was the default, the default is cleared (the
    /// next `connect` / `switch_page` will install a new default).
    pub async fn remove(&self, session_id: &str) {
        let mut g = self.inner.write().await;
        g.sessions.remove(session_id);
        if g.default_id.as_deref() == Some(session_id) {
            g.default_id = None;
        }
    }

    /// Remove every external page session associated with one logical CDP
    /// port. The caller owns closing the returned clients so it can also close
    /// the retained browser-level transport in the same operation.
    pub async fn remove_by_port(&self, port: u16) -> Vec<BrowserSession> {
        let mut g = self.inner.write().await;
        let ids = g
            .sessions
            .iter()
            .filter_map(|(id, session)| (session.port == port).then_some(id.clone()))
            .collect::<Vec<_>>();
        let removed = ids
            .iter()
            .filter_map(|id| g.sessions.remove(id))
            .collect::<Vec<_>>();
        if g.default_id.as_ref().is_some_and(|id| ids.contains(id)) {
            g.default_id = None;
        }
        removed
    }

    /// Inventory is scoped to the authorized endpoint, not every browser in
    /// the process (which may include unrelated headless testing endpoints).
    pub async fn list_for_port(&self, port: u16) -> Vec<String> {
        let g = self.inner.read().await;
        let mut ids: Vec<_> = g
            .sessions
            .iter()
            .filter(|(_, session)| session.port == port && session.client.is_connected())
            .map(|(id, _)| id.clone())
            .collect();
        ids.sort();
        ids
    }

    /// Snapshot of registered session ids — used by `list_sessions` actions.
    pub async fn list(&self) -> Vec<String> {
        let g = self.inner.read().await;
        let mut ids: Vec<String> = g.sessions.keys().cloned().collect();
        ids.sort();
        ids
    }

    /// Current default session id, if any.
    pub async fn default_id(&self) -> Option<String> {
        let g = self.inner.read().await;
        g.default_id.clone()
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    // We can't construct a real `CdpClient` without a live browser, so
    // the tests below exercise only the bookkeeping paths that don't
    // require an actual session (empty get, unknown id ⇒ set_default).
    // Session-aware behavior is exercised by integration tests in the
    // browser_control e2e suite.

    #[tokio::test]
    async fn empty_registry_errors_on_get() {
        let r = BrowserSessionRegistry::new();
        let err = r.get(None).await.unwrap_err();
        assert!(err.to_string().contains("No browser session"));
    }

    #[tokio::test]
    async fn unknown_id_cannot_become_default() {
        let r = BrowserSessionRegistry::new();
        let err = r.set_default("missing").await.unwrap_err();
        assert!(err.to_string().contains("not registered"));
    }
}
