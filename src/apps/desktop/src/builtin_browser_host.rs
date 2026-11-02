//! Desktop adapter for the built-in browser automation host port.

use std::collections::HashMap;
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::Arc;

use async_trait::async_trait;
use openbitfun_core::agentic::tools::browser_control::builtin_browser::{
    set_builtin_browser_host, BuiltInBrowserCommand, BuiltInBrowserHost, BuiltInBrowserOpenRequest,
    BuiltInBrowserTarget,
};
use openbitfun_core::infrastructure::events::{emit_global_event, BackendEvent};
use serde_json::{json, Value};
use tauri::{AppHandle, Manager};
use tokio::sync::{Mutex, RwLock};

use crate::api::browser_api;

const OPEN_BUILT_IN_BROWSER_EVENT: &str = "agentic://open-built-in-browser";
static NEXT_OPEN_REQUEST_ID: AtomicU64 = AtomicU64::new(1);

struct DesktopBuiltInBrowserHost {
    app: AppHandle,
    open_lock: Mutex<()>,
    drivers: RwLock<HashMap<String, Arc<openbitfun_webdriver::EmbeddedWebviewAutomation>>>,
}

impl DesktopBuiltInBrowserHost {
    fn new(app: AppHandle) -> Self {
        Self {
            app,
            open_lock: Mutex::new(()),
            drivers: RwLock::new(HashMap::new()),
        }
    }

    async fn driver(
        &self,
        target_id: &str,
    ) -> Result<Arc<openbitfun_webdriver::EmbeddedWebviewAutomation>, String> {
        browser_api::validate_browser_label(target_id)?;
        if let Some(driver) = self.drivers.read().await.get(target_id).cloned() {
            return Ok(driver);
        }
        let mut drivers = self.drivers.write().await;
        if let Some(driver) = drivers.get(target_id).cloned() {
            return Ok(driver);
        }
        let driver = Arc::new(
            openbitfun_webdriver::EmbeddedWebviewAutomation::attach(self.app.clone(), target_id)
                .await?,
        );
        drivers.insert(target_id.to_string(), driver.clone());
        Ok(driver)
    }
    async fn discover_targets(
        &self,
        conversation_id: Option<&str>,
    ) -> Result<Vec<BuiltInBrowserTarget>, String> {
        let mut targets = browser_api::list_browser_targets(&self.app);
        let stale_drivers = {
            let mut drivers = self.drivers.write().await;
            let stale_ids = drivers
                .keys()
                // A driver may have attached after the inventory snapshot.
                // Check current handles before dropping its automation session.
                .filter(|target_id| self.app.get_webview(target_id).is_none())
                .cloned()
                .collect::<Vec<_>>();
            stale_ids
                .into_iter()
                .filter_map(|target_id| drivers.remove(&target_id))
                .collect::<Vec<_>>()
        };
        for driver in stale_drivers {
            driver.detach().await;
        }
        // Do not evaluate other sessions while discovering this session: a slow
        // background document must not block an unrelated conversation.
        targets.retain(|target| {
            conversation_id.is_none() || target.conversation_id.as_deref() == conversation_id
        });
        for target in &mut targets {
            if target.title.is_empty()
                && browser_api::browser_navigation_failure(&target.id).is_none()
            {
                if let Ok(driver) = self.driver(&target.id).await {
                    if let Ok(result) = driver
                        .execute(
                            "Runtime.evaluate",
                            Some(json!({
                                "expression": "({ title: document.title, url: window.location.href })",
                                "returnByValue": true,
                                "awaitPromise": true,
                            })),
                        )
                        .await
                    {
                        if let Some(identity) = result.pointer("/result/value") {
                            if let Some(url) = identity.get("url").and_then(Value::as_str) {
                                target.url = url.to_string();
                            }
                            if let Some(title) = identity.get("title").and_then(Value::as_str) {
                                target.title = title.to_string();
                            }
                            browser_api::update_browser_target_metadata(
                                &target.id,
                                &target.url,
                                &target.title,
                            );
                        }
                    }
                }
            }
            if target.title.is_empty() {
                target.title = "Built-in browser".to_string();
            }
        }
        Ok(targets)
    }
}

#[async_trait]
impl BuiltInBrowserHost for DesktopBuiltInBrowserHost {
    async fn open(
        &self,
        request: BuiltInBrowserOpenRequest,
    ) -> Result<BuiltInBrowserTarget, String> {
        let request_id = format!(
            "builtin-browser-open-{}-{}",
            std::process::id(),
            NEXT_OPEN_REQUEST_ID.fetch_add(1, Ordering::Relaxed)
        );
        // Native page lifetime belongs to the session, not to a mounted panel.
        // Creating it hidden also works when another conversation is on screen.
        let _open_guard = self.open_lock.lock().await;
        let existing = request
            .replace_existing
            .then(|| {
                browser_api::list_browser_targets(&self.app)
                    .into_iter()
                    .find(|target| target.conversation_id == request.conversation_id)
            })
            .flatten();
        let target_id = if let Some(target) = existing {
            browser_api::browser_webview_navigate(
                self.app.clone(),
                browser_api::WebviewNavigateRequest {
                    label: target.id.clone(),
                    url: request.url.clone(),
                    open_request_id: Some(request_id.clone()),
                },
            )
            .await?;
            target.id
        } else {
            let label = format!("embedded-browser-panel-view-{request_id}");
            browser_api::browser_webview_create(
                self.app.clone(),
                browser_api::WebviewCreateRequest {
                    label: label.clone(),
                    url: request.url.clone(),
                    // Stay outside the window even during add_child -> hide. The
                    // presenting panel supplies its bounds only when it is active.
                    x: -10000.0,
                    y: -10000.0,
                    width: 1024.0,
                    height: 768.0,
                    open_request_id: Some(request_id.clone()),
                    conversation_id: request.conversation_id.clone(),
                },
            )
            .await?;
            label
        };
        browser_api::update_browser_target_metadata(&target_id, &request.url, &request.title);
        let target = browser_api::browser_target_for_open_request(&self.app, &request_id)
            .ok_or_else(|| "the session browser WebView was closed while opening".to_string())?;
        emit_global_event(BackendEvent::Custom {
            event_name: OPEN_BUILT_IN_BROWSER_EVENT.to_string(),
            payload: json!({
                "requestId": request_id,
                "sessionId": request.conversation_id,
                "targetId": target.id,
                "url": request.url,
                "title": request.title,
                "replaceExisting": request.replace_existing,
            }),
        })
        .await
        .map_err(|error| format!("failed to present the built-in browser: {error}"))?;
        Ok(target)
    }

    async fn list_targets(&self) -> Result<Vec<BuiltInBrowserTarget>, String> {
        self.discover_targets(None).await
    }

    async fn list_targets_for_session(
        &self,
        conversation_id: Option<&str>,
    ) -> Result<Vec<BuiltInBrowserTarget>, String> {
        self.discover_targets(conversation_id).await
    }

    async fn execute(&self, command: BuiltInBrowserCommand) -> Result<Value, String> {
        #[cfg(target_os = "macos")]
        if command.method == "Page.navigate" {
            let url = command
                .params
                .as_ref()
                .and_then(|params| params.get("url"))
                .and_then(Value::as_str)
                .ok_or("Page.navigate requires url")?;
            browser_api::browser_webview_navigate(
                self.app.clone(),
                browser_api::WebviewNavigateRequest {
                    label: command.target_id.clone(),
                    url: url.to_string(),
                    open_request_id: None,
                },
            )
            .await?;
            return Ok(json!({ "frameId": command.target_id }));
        }
        if command.method == "Runtime.evaluate" {
            browser_api::wait_for_browser_navigation(&command.target_id).await?;
        }
        let driver = self.driver(&command.target_id).await?;
        let result = driver.execute(&command.method, command.params).await;
        if command.method == "Page.close" && result.is_ok() {
            self.drivers.write().await.remove(&command.target_id);
            driver.detach().await;
            browser_api::unregister_browser_target(&command.target_id);
        }
        result
    }
}

pub(crate) fn install(app: AppHandle) {
    set_builtin_browser_host(Arc::new(DesktopBuiltInBrowserHost::new(app)));
}
