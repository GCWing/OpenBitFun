//! Platform-neutral host port for automating OpenBitFun's built-in browser.

use std::collections::HashMap;
use std::sync::{Arc, OnceLock, RwLock};

use async_trait::async_trait;
use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
use tokio::sync::broadcast;

use super::automation_client::{
    BrowserAutomationCapabilities, BrowserAutomationClient, BrowserAutomationEvent,
};
use crate::util::errors::{OpenBitFunError, OpenBitFunResult};

const BUILTIN_EVENT_CAPACITY: usize = 128;

#[cfg(test)]
pub(crate) static TEST_HOST_LOCK: tokio::sync::Mutex<()> = tokio::sync::Mutex::const_new(());

#[derive(Clone, Debug, Serialize, Deserialize, PartialEq, Eq)]
pub struct BuiltInBrowserTarget {
    pub id: String,
    pub url: String,
    pub title: String,
    pub active: bool,
    /// Agent conversation that owns this page; visibility never changes ownership.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub conversation_id: Option<String>,
}

#[derive(Clone, Debug, Serialize, Deserialize)]
pub struct BuiltInBrowserCommand {
    pub target_id: String,
    pub method: String,
    #[serde(default)]
    pub params: Option<Value>,
}

/// Ask the host for a registered page owned by this conversation. Presentation
/// is independent: the page must be usable while its conversation is hidden or
/// has no mounted panel. A replacement can only reuse a page with the same owner.
#[derive(Clone, Debug, Serialize, Deserialize, PartialEq, Eq)]
pub struct BuiltInBrowserOpenRequest {
    pub url: String,
    pub title: String,
    pub replace_existing: bool,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub conversation_id: Option<String>,
}

#[async_trait]
pub trait BuiltInBrowserHost: Send + Sync {
    async fn open(
        &self,
        request: BuiltInBrowserOpenRequest,
    ) -> Result<BuiltInBrowserTarget, String>;

    async fn list_targets(&self) -> Result<Vec<BuiltInBrowserTarget>, String>;

    async fn list_targets_for_session(
        &self,
        conversation_id: Option<&str>,
    ) -> Result<Vec<BuiltInBrowserTarget>, String> {
        Ok(self
            .list_targets()
            .await?
            .into_iter()
            .filter(|target| {
                conversation_id.is_none() || target.conversation_id.as_deref() == conversation_id
            })
            .collect())
    }

    async fn execute(&self, command: BuiltInBrowserCommand) -> Result<Value, String>;
}

type HostSlot = RwLock<Option<Arc<dyn BuiltInBrowserHost>>>;

static BUILTIN_BROWSER_HOST: OnceLock<HostSlot> = OnceLock::new();
static BUILTIN_BROWSER_EVENTS: OnceLock<
    RwLock<HashMap<String, broadcast::Sender<BrowserAutomationEvent>>>,
> = OnceLock::new();
static DEFAULT_BUILTIN_TARGET: OnceLock<RwLock<Option<String>>> = OnceLock::new();

fn host_slot() -> &'static HostSlot {
    BUILTIN_BROWSER_HOST.get_or_init(|| RwLock::new(None))
}

fn event_channels() -> &'static RwLock<HashMap<String, broadcast::Sender<BrowserAutomationEvent>>> {
    BUILTIN_BROWSER_EVENTS.get_or_init(|| RwLock::new(HashMap::new()))
}

fn default_target_slot() -> &'static RwLock<Option<String>> {
    DEFAULT_BUILTIN_TARGET.get_or_init(|| RwLock::new(None))
}

fn read_lock<T>(lock: &RwLock<T>) -> std::sync::RwLockReadGuard<'_, T> {
    lock.read().unwrap_or_else(|poisoned| poisoned.into_inner())
}

fn write_lock<T>(lock: &RwLock<T>) -> std::sync::RwLockWriteGuard<'_, T> {
    lock.write()
        .unwrap_or_else(|poisoned| poisoned.into_inner())
}

pub fn set_builtin_browser_host(host: Arc<dyn BuiltInBrowserHost>) {
    *write_lock(host_slot()) = Some(host);
}

pub fn builtin_browser_host_available() -> bool {
    read_lock(host_slot()).is_some()
}

fn host() -> OpenBitFunResult<Arc<dyn BuiltInBrowserHost>> {
    read_lock(host_slot()).clone().ok_or_else(|| {
        OpenBitFunError::tool(
            "OpenBitFun's built-in browser automation host is unavailable in this runtime. This capability requires an active Desktop product surface."
                .to_string(),
        )
    })
}

pub async fn list_builtin_browser_targets() -> OpenBitFunResult<Vec<BuiltInBrowserTarget>> {
    host()?.list_targets().await.map_err(|error| {
        OpenBitFunError::tool(format!("Built-in browser target discovery failed: {error}"))
    })
}

/// Conversation callers cannot discover or attach to another conversation's pages.
/// Unscoped callers retain the legacy inventory for host UI/diagnostics.
pub async fn list_builtin_browser_targets_for_session(
    conversation_id: Option<&str>,
) -> OpenBitFunResult<Vec<BuiltInBrowserTarget>> {
    host()?
        .list_targets_for_session(conversation_id)
        .await
        .map_err(|error| {
            OpenBitFunError::tool(format!("Built-in browser target discovery failed: {error}"))
        })
}

pub async fn open_builtin_browser(
    request: BuiltInBrowserOpenRequest,
) -> OpenBitFunResult<BuiltInBrowserClient> {
    let conversation_id = request.conversation_id.clone();
    let target = host()?.open(request).await.map_err(|error| {
        OpenBitFunError::tool(format!("Built-in browser surface failed to open: {error}"))
    })?;
    if target.conversation_id != conversation_id {
        return Err(OpenBitFunError::tool(
            "[WRONG_TAB] The browser host returned a page owned by another conversation"
                .to_string(),
        ));
    }
    if target.conversation_id.is_none() {
        set_default_builtin_browser_target(Some(target.id.clone()));
    }
    Ok(BuiltInBrowserClient {
        events: event_sender(&target.id),
        target,
    })
}

pub fn default_builtin_browser_target_id() -> Option<String> {
    read_lock(default_target_slot()).clone()
}

pub fn set_default_builtin_browser_target(target_id: Option<String>) {
    *write_lock(default_target_slot()) = target_id;
}

fn event_sender(target_id: &str) -> broadcast::Sender<BrowserAutomationEvent> {
    let mut channels = write_lock(event_channels());
    channels
        .entry(target_id.to_string())
        .or_insert_with(|| broadcast::channel(BUILTIN_EVENT_CAPACITY).0)
        .clone()
}

/// Feed native WebView load notifications into the same lifecycle stream used
/// by CDP-backed actions. Desktop calls this from its single `on_page_load`
/// adapter; no page-action implementation lives in the frontend.
pub fn publish_builtin_browser_page_load(target_id: &str, event: &str, url: &str) {
    let lifecycle_name = match event {
        "started" => "init",
        "finished" => "load",
        _ => return,
    };
    let sender = event_sender(target_id);
    let _ = sender.send(BrowserAutomationEvent {
        method: "Page.lifecycleEvent".to_string(),
        params: json!({
            "frameId": target_id,
            "name": lifecycle_name,
            "url": url,
        }),
    });
    if event == "finished" {
        // Native WebView APIs expose a load-finished boundary rather than
        // CDP's finer-grained DOMContentLoaded and network-idle events.
        // Publish that boundary under both shared lifecycle names so every
        // documented wait condition remains portable and explicitly marks
        // the approximation in diagnostic payloads.
        for name in ["DOMContentLoaded", "networkIdle"] {
            let _ = sender.send(BrowserAutomationEvent {
                method: "Page.lifecycleEvent".to_string(),
                params: json!({
                    "frameId": target_id,
                    "name": name,
                    "url": url,
                    "approximation": "native_load_finished",
                }),
            });
        }
    }
}

/// A native navigation failed, including failures before a document exists.
pub fn publish_builtin_browser_navigation_failed(target_id: &str, error: &str) {
    let _ = event_sender(target_id).send(BrowserAutomationEvent {
        method: "Page.lifecycleEvent".to_string(),
        params: json!({ "frameId": target_id, "name": "error", "errorText": error }),
    });
}

pub async fn connect_builtin_browser(
    requested_target_id: Option<&str>,
) -> OpenBitFunResult<BuiltInBrowserClient> {
    connect_builtin_browser_matching(requested_target_id, None, None).await
}

/// Attach to a built-in page using the same selection inputs exposed by the
/// external CDP `connect` path. An explicit session id is exact and never
/// falls back to another page; URL/title filters are case-insensitive
/// substrings and must both match when both are present.
pub async fn connect_builtin_browser_matching(
    requested_target_id: Option<&str>,
    target_url: Option<&str>,
    target_title: Option<&str>,
) -> OpenBitFunResult<BuiltInBrowserClient> {
    connect_builtin_browser_for_session(requested_target_id, target_url, target_title, None).await
}

pub async fn connect_builtin_browser_for_session(
    requested_target_id: Option<&str>,
    target_url: Option<&str>,
    target_title: Option<&str>,
    conversation_id: Option<&str>,
) -> OpenBitFunResult<BuiltInBrowserClient> {
    let targets = list_builtin_browser_targets_for_session(conversation_id).await?;
    let default_id = conversation_id
        .is_none()
        .then(default_builtin_browser_target_id)
        .flatten();
    let target = select_builtin_browser_target(
        &targets,
        requested_target_id,
        target_url,
        target_title,
        default_id.as_deref(),
    )?;

    if conversation_id.is_none() {
        set_default_builtin_browser_target(Some(target.id.clone()));
    }
    Ok(BuiltInBrowserClient {
        events: event_sender(&target.id),
        target,
    })
}

fn select_builtin_browser_target(
    targets: &[BuiltInBrowserTarget],
    requested_target_id: Option<&str>,
    target_url: Option<&str>,
    target_title: Option<&str>,
    default_target_id: Option<&str>,
) -> OpenBitFunResult<BuiltInBrowserTarget> {
    if let Some(requested_id) = requested_target_id {
        return targets
            .iter()
            .find(|target| target.id == requested_id)
            .cloned()
            .ok_or_else(|| {
                OpenBitFunError::tool(format!(
                    "[WRONG_TAB] Built-in browser page '{requested_id}' was not found. It may have been closed."
                ))
            });
    }

    let normalized_url = target_url.map(str::to_lowercase);
    let normalized_title = target_title.map(str::to_lowercase);
    if normalized_url.is_some() || normalized_title.is_some() {
        let matches: Vec<_> = targets
            .iter()
            .filter(|target| {
                normalized_url
                    .as_ref()
                    .map(|needle| target.url.to_lowercase().contains(needle))
                    .unwrap_or(true)
                    && normalized_title
                        .as_ref()
                        .map(|needle| target.title.to_lowercase().contains(needle))
                        .unwrap_or(true)
            })
            .collect();
        if matches.len() > 1 {
            return Err(OpenBitFunError::tool(
                "[AMBIGUOUS] Several built-in pages match. Use browser.list_pages, then an exact session_id.".to_string(),
            ));
        }
        return matches.first().copied().cloned()
            .ok_or_else(|| {
                OpenBitFunError::tool(format!(
                    "[WRONG_TAB] No built-in browser page matched target_url={normalized_url:?} target_title={normalized_title:?}"
                ))
            });
    }

    default_target_id
        .and_then(|id| targets.iter().find(|target| target.id == id))
        .or_else(|| targets.iter().find(|target| target.active))
        .or_else(|| targets.first())
        .cloned()
        .ok_or_else(|| {
            OpenBitFunError::tool(
                "[NOT_AVAILABLE] No built-in page is open. Use browser.navigate with a URL to open and control it in one call."
                    .to_string(),
            )
        })
}

pub struct BuiltInBrowserClient {
    target: BuiltInBrowserTarget,
    events: broadcast::Sender<BrowserAutomationEvent>,
}

impl BuiltInBrowserClient {
    pub fn target(&self) -> &BuiltInBrowserTarget {
        &self.target
    }
}

#[async_trait]
impl BrowserAutomationClient for BuiltInBrowserClient {
    async fn send(&self, method: &str, params: Option<Value>) -> OpenBitFunResult<Value> {
        host()?
            .execute(BuiltInBrowserCommand {
                target_id: self.target.id.clone(),
                method: method.to_string(),
                params,
            })
            .await
            .map_err(|error| {
                // Retain the navigation outcome code for ControlHub while
                // preserving operation context for ordinary adapter errors.
                if error.starts_with("[NOT_AVAILABLE] ") {
                    OpenBitFunError::tool(error)
                } else {
                    OpenBitFunError::tool(format!(
                        "Built-in browser adapter failed for {method}: {error}"
                    ))
                }
            })
    }

    fn subscribe_events(&self) -> broadcast::Receiver<BrowserAutomationEvent> {
        self.events.subscribe()
    }

    fn is_connected(&self) -> bool {
        true
    }

    fn capabilities(&self) -> BrowserAutomationCapabilities {
        BrowserAutomationCapabilities::embedded_webview()
    }

    fn target_kind(&self) -> &'static str {
        "builtin"
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn legacy_browser_payloads_round_trip_without_an_owner() {
        let request_json =
            json!({"url":"https://example.com","title":"Example","replace_existing":true});
        let request: BuiltInBrowserOpenRequest =
            serde_json::from_value(request_json.clone()).unwrap();
        assert_eq!(request.conversation_id, None);
        assert_eq!(serde_json::to_value(request).unwrap(), request_json);
        let target_json =
            json!({"id":"old-page","url":"https://example.com","title":"Example","active":false});
        let target: BuiltInBrowserTarget = serde_json::from_value(target_json.clone()).unwrap();
        assert_eq!(target.conversation_id, None);
        assert_eq!(serde_json::to_value(target).unwrap(), target_json);
    }

    #[test]
    fn page_load_events_use_the_shared_lifecycle_shape() {
        let mut receiver = event_sender("embedded-browser-test").subscribe();
        publish_builtin_browser_page_load(
            "embedded-browser-test",
            "finished",
            "https://example.test/",
        );
        let event = receiver.try_recv().expect("lifecycle event");
        assert_eq!(event.method, "Page.lifecycleEvent");
        assert_eq!(event.params["name"], "load");
        assert_eq!(event.params["frameId"], "embedded-browser-test");
        let dom_content_loaded = receiver.try_recv().expect("dom-content-loaded event");
        assert_eq!(dom_content_loaded.params["name"], "DOMContentLoaded");
        assert_eq!(
            dom_content_loaded.params["approximation"],
            "native_load_finished"
        );
        let network_idle = receiver.try_recv().expect("network-idle event");
        assert_eq!(network_idle.params["name"], "networkIdle");
        assert_eq!(network_idle.params["approximation"], "native_load_finished");
    }

    #[test]
    fn embedded_capabilities_keep_protocol_only_extensions_explicit() {
        let capabilities = BrowserAutomationCapabilities::embedded_webview();
        assert!(!capabilities.raw_cdp);
        assert!(!capabilities.protocol_diagnostics);
        assert!(!capabilities.backend_node_ids);
    }

    fn target(id: &str, url: &str, title: &str, active: bool) -> BuiltInBrowserTarget {
        BuiltInBrowserTarget {
            id: id.to_string(),
            url: url.to_string(),
            title: title.to_string(),
            active,
            conversation_id: None,
        }
    }

    #[test]
    fn explicit_target_id_never_silently_falls_back() {
        let targets = vec![target(
            "embedded-browser-panel-view-1",
            "https://example.com/",
            "Example",
            true,
        )];
        let error = select_builtin_browser_target(
            &targets,
            Some("embedded-browser-panel-view-missing"),
            None,
            None,
            None,
        )
        .expect_err("a stale exact id must fail");
        assert!(error.to_string().contains("was not found"));
    }

    #[test]
    fn url_and_title_filters_match_like_external_connect() {
        let targets = vec![
            target(
                "embedded-browser-panel-view-docs",
                "https://docs.example.com/guide",
                "Example Guide",
                false,
            ),
            target(
                "embedded-browser-panel-view-mail",
                "https://mail.example.com/inbox",
                "Inbox",
                true,
            ),
        ];
        let selected = select_builtin_browser_target(
            &targets,
            None,
            Some("DOCS.EXAMPLE"),
            Some("guide"),
            Some("embedded-browser-panel-view-mail"),
        )
        .expect("filters should take precedence over the default target");
        assert_eq!(selected.id, "embedded-browser-panel-view-docs");

        let error = select_builtin_browser_target(
            &targets,
            None,
            Some("mail.example"),
            Some("guide"),
            None,
        )
        .expect_err("both filters must match one page");
        assert!(error
            .to_string()
            .contains("No built-in browser page matched"));
    }
}
