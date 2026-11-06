//! Browser API — commands for the embedded browser feature.
//!
//! This adapter creates browser targets and installs their initialization
//! scripts before navigation, independently of how each target is presented.

use super::browser_osr::{self, FrameStream};
use openbitfun_core::agentic::tools::browser_control::BuiltInBrowserTarget;
use serde::{Deserialize, Serialize};
use std::collections::HashMap;
use std::sync::{Mutex, OnceLock, Weak};
use tauri::{Emitter, Manager};
use tauri_runtime_cef::{FrameEventKind, WebviewBuilderCefExt};
use tokio::sync::watch;

pub(super) fn browser_navigation_allowed(app: &tauri::AppHandle, url: &tauri::Url) -> bool {
    // CEF projects privileged Tauri schemes onto ordinary HTTP origins.
    // Keep the embedded browser on the unprivileged side of that boundary.
    if matches!(
        url.host_str(),
        Some("openbitfun-ui.localhost" | "tauri.localhost" | "ipc.localhost" | "asset.localhost")
    ) {
        return false;
    }
    !tauri::is_dev()
        || app
            .config()
            .build
            .dev_url
            .as_ref()
            .is_none_or(|dev_url| dev_url.origin() != url.origin())
}

pub(super) fn find_browser_webview(
    app: &tauri::AppHandle,
    label: &str,
) -> Result<tauri::Webview, String> {
    app.get_webview(label)
        .ok_or_else(|| format!("Webview not found: {label}"))
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct WebviewEvalRequest {
    pub label: String,
    pub script: String,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct WebviewNavigateRequest {
    pub label: String,
    pub url: String,
    #[serde(default)]
    pub open_request_id: Option<String>,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct WebviewBoundsRequest {
    pub label: String,
    pub x: f64,
    pub y: f64,
    pub width: f64,
    pub height: f64,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct WebviewCreateRequest {
    pub label: String,
    pub url: String,
    pub x: f64,
    pub y: f64,
    pub width: f64,
    pub height: f64,
    #[serde(default)]
    pub open_request_id: Option<String>,
    #[serde(default)]
    pub conversation_id: Option<String>,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct BrowserAgentTargetStateRequest {
    pub label: String,
    pub active: bool,
    #[serde(default)]
    pub open_request_id: Option<String>,
}

#[derive(Clone, Debug, Default)]
struct BrowserTargetRecord {
    creating: bool,
    active: bool,
    last_active_seq: u64,
    url: String,
    title: Option<String>,
    open_request_id: Option<String>,
    conversation_id: Option<String>,
    navigation: Option<BrowserNavigation>,
    // The render handler owns the pixels for the native browser's lifetime.
    offscreen: Option<Weak<FrameStream>>,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub enum BrowserPresentation {
    Offscreen,
    OffscreenGpu,
}

#[derive(Clone, Debug)]
struct BrowserNavigation {
    started: bool,
    completed: watch::Sender<Option<Result<(), String>>>,
}

impl BrowserNavigation {
    fn new() -> Self {
        Self {
            started: false,
            completed: watch::channel(None).0,
        }
    }

    fn page_load(&mut self, event: &str) {
        if event == "started" {
            self.started = true;
        } else if event == "finished" && self.started && self.completed.borrow().is_none() {
            // Redirects may finish at a different URL. A finish from the old
            // document before this navigation starts must not release readers.
            self.completed.send_replace(Some(Ok(())));
        }
    }
}

#[derive(Default)]
struct BrowserTargetRegistry {
    next_seq: u64,
    records: HashMap<String, BrowserTargetRecord>,
}

impl BrowserTargetRegistry {
    fn label_for_open_request(&self, request_id: &str) -> Option<String> {
        self.records.iter().find_map(|(label, record)| {
            (record.open_request_id.as_deref() == Some(request_id)).then(|| label.clone())
        })
    }
}

static BROWSER_TARGETS: OnceLock<Mutex<BrowserTargetRegistry>> = OnceLock::new();

fn lock_browser_targets() -> std::sync::MutexGuard<'static, BrowserTargetRegistry> {
    BROWSER_TARGETS
        .get_or_init(|| Mutex::new(BrowserTargetRegistry::default()))
        .lock()
        .unwrap_or_else(|poisoned| poisoned.into_inner())
}

pub(crate) fn validate_browser_label(label: &str) -> Result<(), String> {
    if label.starts_with("embedded-browser-view-")
        || label.starts_with("embedded-browser-panel-view-")
    {
        Ok(())
    } else {
        Err("invalid browser webview label".to_string())
    }
}

fn register_browser_target(
    label: &str,
    url: &str,
    open_request_id: Option<String>,
    conversation_id: Option<String>,
    offscreen: Option<Weak<FrameStream>>,
) -> Result<(), String> {
    let mut registry = lock_browser_targets();
    if registry.records.contains_key(label) {
        return Err(format!("Browser webview already exists: {label}"));
    }
    registry.records.insert(
        label.to_string(),
        BrowserTargetRecord {
            creating: true,
            url: url.to_string(),
            open_request_id,
            conversation_id,
            offscreen,
            navigation: Some(BrowserNavigation::new()),
            ..BrowserTargetRecord::default()
        },
    );
    Ok(())
}

pub(super) fn offscreen_frame_stream(label: &str) -> Option<Weak<FrameStream>> {
    lock_browser_targets().records.get(label)?.offscreen.clone()
}

fn associate_browser_open_request(label: &str, open_request_id: Option<&str>) {
    let Some(open_request_id) = open_request_id
        .map(str::trim)
        .filter(|request_id| !request_id.is_empty())
    else {
        return;
    };
    if let Some(record) = lock_browser_targets().records.get_mut(label) {
        record.open_request_id = Some(open_request_id.to_string());
    }
}

pub(crate) fn update_browser_target_page_load(label: &str, event: &str, url: &str) {
    if let Some(record) = lock_browser_targets().records.get_mut(label) {
        record.url = url.to_string();
        // A navigation invalidates the cached document title. The async
        // automation host refreshes it from the page before target discovery
        // is returned to ControlHub.
        record.title = None;
        if let Some(navigation) = &mut record.navigation {
            navigation.page_load(event);
        }
    }
}

fn begin_browser_navigation(label: &str, url: &tauri::Url) {
    if let Some(record) = lock_browser_targets().records.get_mut(label) {
        record.url = url.to_string();
        record.title = None;
        let navigation = record.navigation.get_or_insert_with(BrowserNavigation::new);
        navigation.completed.send_replace(None);
        navigation.page_load("started");
    }
}

fn fail_browser_navigation(label: &str, url: &tauri::Url, error: &str) -> bool {
    let mut registry = lock_browser_targets();
    let Some(record) = registry.records.get_mut(label) else {
        return false;
    };
    if record.url != url.as_str() {
        return false;
    }
    let navigation = record.navigation.get_or_insert_with(BrowserNavigation::new);
    navigation
        .completed
        .send_replace(Some(Err(format!("[NOT_AVAILABLE] {error}"))));
    true
}

/// Native navigation can leave the previous completed document readable while
/// the replacement response is in flight. Do not expose that document to tools.
pub(crate) async fn wait_for_browser_navigation(label: &str) -> Result<(), String> {
    let pending = lock_browser_targets()
        .records
        .get(label)
        .and_then(|record| record.navigation.as_ref())
        .map(|navigation| navigation.completed.subscribe());
    if let Some(mut pending) = pending {
        let outcome = tokio::time::timeout(
            std::time::Duration::from_secs(15),
            pending.wait_for(Option::is_some),
        )
        .await
        .map_err(|_| {
            format!("Navigation on {label} is still loading; wait before reading this page")
        })?
        .map_err(|_| format!("Navigation on {label} was superseded or its page was closed"))?
        .clone();
        return outcome.expect("completed navigation has an outcome");
    }
    Ok(())
}

pub(crate) fn browser_navigation_failure(label: &str) -> Option<String> {
    lock_browser_targets()
        .records
        .get(label)
        .and_then(|record| record.navigation.as_ref())
        .and_then(|navigation| {
            navigation
                .completed
                .borrow()
                .as_ref()
                .and_then(|outcome| outcome.as_ref().err())
                .cloned()
        })
}

pub(crate) fn update_browser_target_metadata(label: &str, url: &str, title: &str) {
    if let Some(record) = lock_browser_targets().records.get_mut(label) {
        record.url = url.to_string();
        record.title = Some(title.to_string());
    }
}

pub(crate) fn unregister_browser_target(label: &str) {
    lock_browser_targets().records.remove(label);
}

pub(crate) fn list_browser_targets(app: &tauri::AppHandle) -> Vec<BuiltInBrowserTarget> {
    let (records, views) = {
        let mut registry = lock_browser_targets();
        // This only snapshots local handles; it performs no native UI calls.
        // Take it while registration is excluded, so a newly registered page
        // cannot be pruned against an older handle snapshot.
        let views = app.webviews();
        registry
            .records
            .retain(|label, record| record.creating || views.contains_key(label));
        (registry.records.clone(), views)
    };
    // Native URL reads may dispatch to the UI thread. Page-load callbacks on
    // that thread update this registry, so never hold its mutex across native IO.
    let mut targets = records
        .iter()
        .filter_map(|(label, record)| {
            if record.creating {
                return None;
            }
            let url = views
                .get(label)?
                .url()
                .ok()
                .map(|url| url.to_string())
                .filter(|url| !url.is_empty())
                .unwrap_or_else(|| record.url.clone());
            Some((
                record.last_active_seq,
                BuiltInBrowserTarget {
                    id: label.clone(),
                    url,
                    title: record.title.clone().unwrap_or_default(),
                    active: record.active,
                    conversation_id: record.conversation_id.clone(),
                },
            ))
        })
        .collect::<Vec<_>>();
    targets.sort_by(|left, right| right.0.cmp(&left.0));
    targets.into_iter().map(|(_, target)| target).collect()
}

/// Resolve the exact WebView that acknowledged one browser-open
/// request. The request ID is presentation lifecycle metadata and is kept out
/// of the public browser target DTO.
pub(crate) fn browser_target_for_open_request(
    app: &tauri::AppHandle,
    request_id: &str,
) -> Option<BuiltInBrowserTarget> {
    let label = {
        let registry = lock_browser_targets();
        registry.label_for_open_request(request_id)
    }?;
    list_browser_targets(app)
        .into_iter()
        .find(|target| target.id == label)
}

fn validate_webview_bounds(x: f64, y: f64, width: f64, height: f64) -> Result<(), String> {
    if !x.is_finite()
        || !y.is_finite()
        || !width.is_finite()
        || !height.is_finite()
        || width <= 1.0
        || height <= 1.0
    {
        Err("invalid webview bounds".to_string())
    } else {
        Ok(())
    }
}

#[tauri::command]
pub async fn browser_webview_create(
    app: tauri::AppHandle,
    request: WebviewCreateRequest,
) -> Result<Option<BrowserPresentation>, String> {
    validate_browser_label(&request.label)?;
    validate_webview_bounds(request.x, request.y, request.width, request.height)?;

    let url = request
        .url
        .parse::<tauri::Url>()
        .map_err(|e| format!("invalid url: {e}"))?;
    match url.scheme() {
        "http" | "https" => {}
        scheme => return Err(format!("unsupported protocol: {scheme}")),
    }
    if !browser_navigation_allowed(&app, &url) {
        return Err("The OpenBitFun frontend is reserved for application windows".into());
    }

    let window = app
        .get_window("main")
        .ok_or_else(|| "main window not found".to_string())?;
    let label = request.label;
    let navigation_app = app.clone();
    let observer_app = app.clone();
    let observer_label = label.clone();
    let mut builder =
        tauri::webview::WebviewBuilder::new(label.clone(), tauri::WebviewUrl::External(url.clone()))
            // Install before the initial navigation or any frontend panel.
            .initialization_script(include_str!(
                "../../../../shared/browser/blankTargetIntercept.js"
            ))
            .position(tauri::LogicalPosition::new(request.x, request.y))
            .size(tauri::LogicalSize::new(request.width, request.height))
            .transparent(false)
            .background_color(tauri::window::Color(0, 0, 0, 255))
            .on_navigation(move |url| browser_navigation_allowed(&navigation_app, url))
            .on_frame_event(move |event| {
                if !event.is_main {
                    return;
                }
                match event.kind {
                    FrameEventKind::NavigationStarted { url } => {
                        begin_browser_navigation(&observer_label, &url);
                    }
                    FrameEventKind::NavigationFailed { url } => {
                        let error = "Chromium could not load the page";
                        if fail_browser_navigation(&observer_label, &url, error) {
                            let app = observer_app.clone();
                            let label = observer_label.clone();
                            tauri::async_runtime::spawn(async move {
                                openbitfun_core::agentic::tools::browser_control::builtin_browser::publish_builtin_browser_navigation_failed(&label, error);
                                let _ = app.emit_to("main", crate::BROWSER_WEBVIEW_PAGE_LOAD_EVENT,
                                    serde_json::json!({ "label": label, "event": "failed", "url": "", "error": error }));
                            });
                        }
                    }
                    _ => {}
                }
            });

    #[cfg(any(debug_assertions, feature = "devtools"))]
    {
        builder = builder.devtools(true);
    }

    let offscreen = browser_osr::configure(&app, &mut builder, &label)?;
    let presentation = offscreen.as_ref().map(browser_osr::presentation);
    register_browser_target(
        &label,
        url.as_str(),
        request.open_request_id,
        request.conversation_id,
        offscreen,
    )?;
    let webview = match window.add_child(builder) {
        Ok(webview) => webview,
        Err(error) => {
            unregister_browser_target(&label);
            return Err(format!("failed to create browser webview: {error}"));
        }
    };
    if let Err(error) = webview.hide() {
        let _ = webview.close();
        unregister_browser_target(&label);
        return Err(format!(
            "failed to hide browser webview before positioning: {error}"
        ));
    }
    if let Some(record) = lock_browser_targets().records.get_mut(&label) {
        record.creating = false;
    }
    Ok(presentation)
}

/// Advertise which built-in browser surface the Agent should target. This is
/// lifecycle metadata only; browser actions remain in the shared Rust action
/// layer and native WebView adapter.
#[tauri::command]
pub async fn browser_webview_set_agent_target_state(
    request: BrowserAgentTargetStateRequest,
) -> Result<(), String> {
    validate_browser_label(&request.label)?;
    let mut registry = lock_browser_targets();
    if !registry.records.contains_key(&request.label) {
        return Err(format!("Webview not found: {}", request.label));
    }
    if request.active {
        registry.next_seq = registry.next_seq.saturating_add(1);
        let next_seq = registry.next_seq;
        for record in registry.records.values_mut() {
            record.active = false;
        }
        let record = registry
            .records
            .get_mut(&request.label)
            .expect("registered target");
        record.active = true;
        record.last_active_seq = next_seq;
        if let Some(request_id) = request
            .open_request_id
            .as_deref()
            .map(str::trim)
            .filter(|request_id| !request_id.is_empty())
            // Session requests are registered by the host before presentation.
            // A late callback from the old panel must not overwrite a newer open.
            .filter(|_| record.conversation_id.is_none())
        {
            record.open_request_id = Some(request_id.to_string());
        }
    } else if let Some(record) = registry.records.get_mut(&request.label) {
        record.active = false;
    }
    Ok(())
}

#[tauri::command]
pub async fn browser_webview_eval(
    app: tauri::AppHandle,
    request: WebviewEvalRequest,
) -> Result<(), String> {
    find_browser_webview(&app, &request.label)?
        .eval(&request.script)
        .map_err(|e| format!("eval failed: {e}"))
}

#[tauri::command]
pub async fn browser_webview_navigate(
    app: tauri::AppHandle,
    request: WebviewNavigateRequest,
) -> Result<(), String> {
    let url = request
        .url
        .parse::<tauri::Url>()
        .map_err(|e| format!("invalid url: {e}"))?;

    match url.scheme() {
        "http" | "https" => {}
        scheme => return Err(format!("unsupported protocol: {scheme}")),
    }
    if !browser_navigation_allowed(&app, &url) {
        return Err("The OpenBitFun frontend is reserved for application windows".into());
    }

    let webview = find_browser_webview(&app, &request.label)?;
    let same_document = webview.url().ok().is_some_and(|mut current| {
        let fragment_changed = current.fragment() != url.fragment();
        current.set_fragment(url.fragment());
        fragment_changed && current == url
    });
    if let Some(record) = lock_browser_targets().records.get_mut(&request.label) {
        record.navigation = (!same_document).then(BrowserNavigation::new);
    }
    if let Err(error) = webview.navigate(url) {
        if let Some(record) = lock_browser_targets().records.get_mut(&request.label) {
            record.navigation = None;
        }
        return Err(format!("navigate failed: {error}"));
    }
    // A failed URL parse or native navigation must never acknowledge an open
    // request merely because an older target is already active.
    associate_browser_open_request(&request.label, request.open_request_id.as_deref());
    Ok(())
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct WebviewLabelRequest {
    pub label: String,
}

#[derive(Debug, Serialize)]
#[serde(tag = "status", rename_all = "camelCase")]
pub enum WebviewPreviewResponse {
    Ready {
        #[serde(rename = "dataUrl")]
        data_url: String,
    },
    Unsupported {
        reason: String,
    },
}

// Preview frames are ephemeral UI assets, never files or full-page captures.
fn encode_browser_preview(png_base64: &str) -> Result<String, String> {
    use base64::Engine as _;
    let bytes = base64::engine::general_purpose::STANDARD
        .decode(png_base64)
        .map_err(|e| format!("decode browser preview failed: {e}"))?;
    let image = image::load_from_memory_with_format(&bytes, image::ImageFormat::Png)
        .map_err(|e| format!("decode browser preview PNG failed: {e}"))?;
    let image = if image.width() > 1600 || image.height() > 1600 {
        image.thumbnail(1600, 1600)
    } else {
        image
    };
    let mut jpeg = Vec::new();
    image::codecs::jpeg::JpegEncoder::new_with_quality(&mut jpeg, 80)
        .encode_image(&image.to_rgb8())
        .map_err(|e| format!("encode browser preview JPEG failed: {e}"))?;
    Ok(format!(
        "data:image/jpeg;base64,{}",
        base64::engine::general_purpose::STANDARD.encode(jpeg)
    ))
}

/// Capture only the controller's embedded page for DOM occlusion placeholders.
#[tauri::command]
pub async fn browser_webview_capture_preview(
    app: tauri::AppHandle,
    request: WebviewLabelRequest,
) -> Result<WebviewPreviewResponse, String> {
    validate_browser_label(&request.label)?;
    let webview = find_browser_webview(&app, &request.label)?;
    let png = match openbitfun_webdriver::platform::take_screenshot(webview, 1000).await {
        Ok(png) => png,
        Err(error) if error.error == "unsupported operation" => {
            return Ok(WebviewPreviewResponse::Unsupported {
                reason: error.message,
            });
        }
        Err(error) => return Err(error.message),
    };
    let data_url = tokio::task::spawn_blocking(move || encode_browser_preview(&png))
        .await
        .map_err(|e| format!("browser preview encoding task failed: {e}"))??;
    Ok(WebviewPreviewResponse::Ready { data_url })
}

#[tauri::command]
pub async fn browser_webview_reload(
    app: tauri::AppHandle,
    request: WebviewLabelRequest,
) -> Result<(), String> {
    find_browser_webview(&app, &request.label)?
        .reload()
        .map_err(|e| format!("reload failed: {e}"))
}

#[tauri::command]
pub async fn browser_webview_set_bounds(
    app: tauri::AppHandle,
    request: WebviewBoundsRequest,
) -> Result<Option<BrowserPresentation>, String> {
    validate_webview_bounds(request.x, request.y, request.width, request.height)?;

    let webview = app
        .get_webview(&request.label)
        .ok_or_else(|| format!("Webview not found: {}", request.label))?;

    webview
        .set_bounds(tauri::Rect {
            position: tauri::Position::Logical(tauri::LogicalPosition::new(request.x, request.y)),
            size: tauri::Size::Logical(tauri::LogicalSize::new(request.width, request.height)),
        })
        .map_err(|e| format!("set bounds failed: {e}"))?;
    Ok(offscreen_frame_stream(&request.label)
        .as_ref()
        .map(browser_osr::presentation))
}

/// Return the current URL of a browser webview.
#[tauri::command]
pub async fn browser_get_url(
    app: tauri::AppHandle,
    request: WebviewLabelRequest,
) -> Result<String, String> {
    let webview = find_browser_webview(&app, &request.label)?;
    if let Some(error) = browser_navigation_failure(&request.label) {
        return Err(error);
    }
    webview
        .url()
        .map(|url| url.to_string())
        .map_err(|e| format!("url failed: {e}"))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn replacement_navigation_does_not_accept_the_previous_document_finish() {
        let mut navigation = BrowserNavigation::new();
        navigation.page_load("finished");
        assert!(navigation.completed.borrow().is_none());
        navigation.page_load("started");
        navigation.page_load("started"); // A redirect or a superseding navigation.
        navigation.page_load("finished");
        assert_eq!(*navigation.completed.borrow(), Some(Ok(())));
    }

    #[tokio::test]
    async fn failed_navigation_releases_readers_and_a_manual_navigation_can_succeed() {
        let label = "embedded-browser-panel-view-navigation-failure-test";
        let url: tauri::Url = "https://example.com".parse().unwrap();
        register_browser_target(label, url.as_str(), None, None, None).unwrap();
        begin_browser_navigation(label, &url);
        let reader = tokio::spawn(wait_for_browser_navigation(label));
        tokio::task::yield_now().await;
        assert!(fail_browser_navigation(label, &url, "Could not connect"));
        let error = tokio::time::timeout(std::time::Duration::from_secs(1), reader)
            .await
            .unwrap()
            .unwrap()
            .unwrap_err();
        assert!(error.contains("Could not connect"));
        begin_browser_navigation(label, &url);
        update_browser_target_page_load(label, "finished", url.as_str());
        assert!(wait_for_browser_navigation(label).await.is_ok());
        unregister_browser_target(label);
    }

    #[test]
    fn legacy_create_payload_keeps_the_unscoped_browser_contract() {
        let request: WebviewCreateRequest = serde_json::from_value(serde_json::json!({
            "label": "embedded-browser-panel-view-old", "url": "https://example.com",
            "x": 0, "y": 0, "width": 800, "height": 600,
        }))
        .unwrap();
        assert!(request.conversation_id.is_none());
        assert!(request.open_request_id.is_none());
    }

    #[test]
    fn preview_is_a_bounded_jpeg_and_rejects_invalid_data() {
        use base64::Engine as _;
        let mut png = std::io::Cursor::new(Vec::new());
        image::DynamicImage::new_rgb8(2000, 1000)
            .write_to(&mut png, image::ImageFormat::Png)
            .unwrap();
        let encoded = base64::engine::general_purpose::STANDARD.encode(png.into_inner());
        let preview = encode_browser_preview(&encoded).unwrap();
        let bytes = base64::engine::general_purpose::STANDARD
            .decode(preview.strip_prefix("data:image/jpeg;base64,").unwrap())
            .unwrap();
        let image = image::load_from_memory(&bytes).unwrap();
        assert_eq!((image.width(), image.height()), (1600, 800));
        assert!(encode_browser_preview("invalid").is_err());
    }

    #[test]
    fn open_request_correlation_accepts_the_exact_background_target() {
        let mut registry = BrowserTargetRegistry::default();
        registry.records.insert(
            "embedded-browser-panel-view-old".to_string(),
            BrowserTargetRecord {
                active: true,
                open_request_id: Some("old-request".to_string()),
                ..BrowserTargetRecord::default()
            },
        );
        registry.records.insert(
            "embedded-browser-panel-view-new".to_string(),
            BrowserTargetRecord {
                active: false,
                open_request_id: Some("new-request".to_string()),
                ..BrowserTargetRecord::default()
            },
        );

        assert_eq!(
            registry.label_for_open_request("old-request").as_deref(),
            Some("embedded-browser-panel-view-old")
        );
        assert_eq!(registry.label_for_open_request("missing-request"), None);

        assert_eq!(
            registry.label_for_open_request("new-request").as_deref(),
            Some("embedded-browser-panel-view-new")
        );
    }
}
