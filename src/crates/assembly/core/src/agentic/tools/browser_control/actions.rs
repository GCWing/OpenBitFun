//! Atomic browser actions shared by every browser target adapter.

use super::automation_client::{BrowserAutomationClient, BrowserAutomationEvent};
use crate::agentic::tools::implementations::control_hub::{coded_tool_error, ErrorCode};
use crate::util::errors::{OpenBitFunError, OpenBitFunResult};
use serde_json::{json, Value};
#[path = "snapshot_context.rs"]
mod snapshot_context;
use tokio::sync::broadcast;

/// Upper bound for an explicit `wait` duration. Pacing waits ("check again in
/// 30 minutes") are a legitimate agent pattern, so the ceiling is generous;
/// it exists only so a nonsense duration cannot wedge the session forever.
/// Kept in step with `AgentWaitTool::MAX_TIMEOUT_MS`.
pub const MAX_WAIT_MS: u64 = 60 * 60 * 1_000;

/// How long a `wait { condition }` runs before giving up when the caller does
/// not say. Matches the previous hard-coded lifecycle and selector budgets.
pub const DEFAULT_CONDITION_TIMEOUT_MS: u64 = 15_000;

/// Result of waiting for a shared browser lifecycle event.
enum LifecycleOutcome {
    /// One of the requested lifecycle names fired in time. Carries the name
    /// (e.g. `"load"`, `"networkIdle"`) so callers can report which condition
    /// actually matched.
    Reached(String),
    /// Timed out before any of the requested events fired.
    Timeout,
    /// Subscription closed (typically: page navigated away or browser quit).
    Closed,
}

/// Block until a `Page.lifecycleEvent` whose `name` ∈ `wanted` arrives for the
/// given `frame_id` (or any frame if `frame_id` is `None`). Bounded by a hard
/// timeout so a hung page can never wedge the agent.
async fn wait_for_lifecycle(
    events: &mut broadcast::Receiver<BrowserAutomationEvent>,
    frame_id: Option<&str>,
    wanted: &[&str],
    timeout_ms: u64,
) -> LifecycleOutcome {
    let deadline = tokio::time::Instant::now() + std::time::Duration::from_millis(timeout_ms);
    loop {
        let remaining = deadline.saturating_duration_since(tokio::time::Instant::now());
        if remaining.is_zero() {
            return LifecycleOutcome::Timeout;
        }
        let recv_fut = events.recv();
        let evt = match tokio::time::timeout(remaining, recv_fut).await {
            Err(_) => return LifecycleOutcome::Timeout,
            Ok(Err(broadcast::error::RecvError::Closed)) => return LifecycleOutcome::Closed,
            // We deliberately swallow Lagged: lifecycle bursts can outpace
            // our buffer briefly; the next iteration will catch the next one.
            Ok(Err(broadcast::error::RecvError::Lagged(_))) => continue,
            Ok(Ok(evt)) => evt,
        };
        if evt.method != "Page.lifecycleEvent" {
            continue;
        }
        let name = evt
            .params
            .get("name")
            .and_then(|v| v.as_str())
            .unwrap_or("");
        if !wanted.contains(&name) {
            continue;
        }
        if let Some(want_frame) = frame_id {
            let evt_frame = evt
                .params
                .get("frameId")
                .and_then(|v| v.as_str())
                .unwrap_or("");
            if evt_frame != want_frame {
                continue;
            }
        }
        return LifecycleOutcome::Reached(name.to_string());
    }
}

// ── Structured errors ──────────────────────────────────────────────────
//
// High-frequency failure points build the `[CODE] message\nHints: a | b`
// wire format at the source, so ControlHub's `map_dispatch_error` recovers a
// stable `error.code` plus recovery hints through structured parsing instead
// of the fragile phrase-matching fallback.

/// Build a structured error in the `[CODE] message\nHints: a | b` shape.
fn structured_error(
    code: ErrorCode,
    message: impl std::fmt::Display,
    hints: &[&str],
) -> OpenBitFunError {
    if hints.is_empty() {
        coded_tool_error(code, message)
    } else {
        coded_tool_error(code, format!("{}\nHints: {}", message, hints.join(" | ")))
    }
}

/// Classify a JS exception reported by `Runtime.evaluate` into a structured
/// error. `Element not found` originates from `resolve_element_js` and is by
/// far the most common interaction failure, so it gets a dedicated
/// `NOT_FOUND` code with a snapshot-recovery instruction for the model.
pub(crate) fn classify_evaluate_exception(message: &str) -> OpenBitFunError {
    if message.contains("Element not found") {
        // `resolve_element_js` appends the cross-origin iframe count to its
        // throw message: those frames are invisible to both `snapshot` and
        // the resolver, so without saying so the model reads "not found" as
        // "not on the page" and retries forever.
        let mut hints = vec!["Element not found — take a new snapshot and use a fresh @eN ref"];
        if message.contains("cross-origin iframe") {
            hints.push("The page contains cross-origin iframes whose contents cannot be inspected or clicked — an element inside one is unreachable; work with the top-level document instead");
        }
        structured_error(
            ErrorCode::NotFound,
            format!("JS error: {}", message),
            &hints,
        )
    } else {
        structured_error(
            ErrorCode::Internal,
            format!("JS error: {}", message),
            &["JavaScript threw during evaluation — fix the expression, or take a fresh snapshot to re-check page state"],
        )
    }
}

/// Classify a browser-target transport failure (send/receive level). A dead
/// WebSocket or missing native WebView means the session is unusable and must
/// be re-attached; a transport timeout means the page did not answer. Anything
/// else passes through so the heuristic fallback in `map_dispatch_error` still
/// applies.
pub(crate) fn classify_transport_error(err: OpenBitFunError) -> OpenBitFunError {
    let raw = err.to_string();
    let message = raw.strip_prefix("Tool error: ").unwrap_or(raw.as_str());
    if message.contains("CDP send failed")
        || message.contains("CDP response channel closed")
        || message.contains("Target closed")
        || message.contains("Webview not found")
        || message.contains("WebView not found")
    {
        structured_error(
            ErrorCode::WrongTab,
            message,
            &["The browser session is dead (tab closed or browser quit) — call browser.connect or switch_page to attach a live tab, then retry"],
        )
    } else if message.contains("CDP timeout") {
        structured_error(
            ErrorCode::Timeout,
            message,
            &["The page did not answer in time — take a snapshot to check its state, or reload and retry"],
        )
    } else {
        err
    }
}

/// Error for a click/hover target whose center point is covered by another
/// element. Dispatching the mouse event anyway would act on the overlay while
/// reporting success for the intended element — the worst possible outcome,
/// so the action is refused instead.
pub(crate) fn occluded_element_error(selector: &str, blocker: &str) -> OpenBitFunError {
    structured_error(
        ErrorCode::GuardRejected,
        format!(
            "Element '{}' is not clickable at its center point: it is covered by {}.",
            selector, blocker
        ),
        &["Clear what covers it (close the modal / cookie banner, or press Escape), or scroll it fully into view, then take a fresh snapshot and retry"],
    )
}

/// Error for an element that resolved inside a cross-origin iframe: its
/// coordinates cannot be translated to the top-level viewport, so
/// coordinate-based actions (click/hover) cannot reach it.
pub(crate) fn cross_origin_frame_error(selector: &str) -> OpenBitFunError {
    structured_error(
        ErrorCode::NotAvailable,
        format!(
            "Element '{}' sits inside a cross-origin iframe; its coordinates cannot be mapped to the top-level viewport, so coordinate-based actions (click/hover) cannot reach it.",
            selector
        ),
        &["Take a snapshot and target an element in the top document or a same-origin frame instead"],
    )
}

/// CDP fields that make `Input.dispatchKeyEvent` behave like a real key press.
///
/// Chrome only runs a key's **default action** — Enter submitting a form, Tab
/// moving focus, a character being inserted — when the event carries
/// `windowsVirtualKeyCode` and, for text-producing keys, `text`. A bare
/// `{ type, key }` event still reaches JS listeners, which is why the omission
/// looks like it works right up until the page relies on the default action.
/// Mapping follows the US layout table used by Chrome's own automation
/// clients: only Enter and single-character keys carry `text`.
fn key_event_fields(key: &str) -> Value {
    let (name, code, virtual_key, text): (&str, &str, i64, Option<&str>) = match key {
        "Enter" | "Return" => ("Enter", "Enter", 13, Some("\r")),
        "Tab" => ("Tab", "Tab", 9, None),
        "Escape" | "Esc" => ("Escape", "Escape", 27, None),
        "Backspace" => ("Backspace", "Backspace", 8, None),
        "Delete" => ("Delete", "Delete", 46, None),
        "ArrowUp" => ("ArrowUp", "ArrowUp", 38, None),
        "ArrowDown" => ("ArrowDown", "ArrowDown", 40, None),
        "ArrowLeft" => ("ArrowLeft", "ArrowLeft", 37, None),
        "ArrowRight" => ("ArrowRight", "ArrowRight", 39, None),
        "Home" => ("Home", "Home", 36, None),
        "End" => ("End", "End", 35, None),
        "PageUp" => ("PageUp", "PageUp", 33, None),
        "PageDown" => ("PageDown", "PageDown", 34, None),
        "Space" | " " => (" ", "Space", 32, Some(" ")),
        other => {
            let mut chars = other.chars();
            return match (chars.next(), chars.next()) {
                (Some(ch), None) => {
                    let virtual_key = ch.to_ascii_uppercase() as i64;
                    json!({
                        "key": other,
                        "text": other,
                        "windowsVirtualKeyCode": virtual_key,
                        "nativeVirtualKeyCode": virtual_key,
                    })
                }
                // Unknown named key: pass it through so the page still sees a
                // keydown, rather than guessing a wrong virtual key code.
                _ => json!({ "key": other }),
            };
        }
    };
    let mut fields = json!({
        "key": name,
        "code": code,
        "windowsVirtualKeyCode": virtual_key,
        "nativeVirtualKeyCode": virtual_key,
    });
    if let Some(text) = text {
        fields["text"] = json!(text);
    }
    fields
}

/// Snapshot walker. Kept as a module const so the ordering guarantees it
/// encodes (stale refs cleared **before** renumbering) are unit-testable.
const SNAPSHOT_SCRIPT: &str = include_str!("snapshot.js");

/// High-level browser actions backed by a target adapter.
pub struct BrowserActions<'a> {
    client: &'a dyn BrowserAutomationClient,
}

impl<'a> BrowserActions<'a> {
    pub fn new(client: &'a dyn BrowserAutomationClient) -> Self {
        Self { client }
    }

    pub async fn enable_observers(&self) -> OpenBitFunResult<Value> {
        let _ = self.client.send("Page.enable", None).await;
        let _ = self.client.send("Runtime.enable", None).await;
        let _ = self.client.send("Network.enable", None).await;
        let _ = self.client.send("DOM.enable", None).await;
        Ok(json!({ "success": true, "action": "enable_observers" }))
    }

    // ── Navigation ─────────────────────────────────────────────────────

    pub async fn navigate(&self, url: &str) -> OpenBitFunResult<Value> {
        // Subscribe **before** issuing the navigate so we can never miss the
        // `Page.lifecycleEvent` ("load") that fires while we are awaiting the
        // command response. Page lifecycle events must be enabled explicitly.
        let _ = self.client.send("Page.enable", None).await;
        let _ = self
            .client
            .send(
                "Page.setLifecycleEventsEnabled",
                Some(json!({ "enabled": true })),
            )
            .await;
        let mut events = self.client.subscribe_events();

        let result = self
            .client
            .send("Page.navigate", Some(json!({ "url": url })))
            .await?;
        let frame_id = result
            .get("frameId")
            .and_then(|v| v.as_str())
            .map(str::to_string);

        // Wait for the matching "load" lifecycle event (or "DOMContentLoaded"
        // as an early signal). Capped at ~15s so a hung page eventually
        // surfaces a Timeout error to the model rather than blocking forever.
        let outcome = wait_for_lifecycle(&mut events, frame_id.as_deref(), &["load"], 15_000).await;

        let mut body = json!({
            "url": url,
            "frameId": frame_id,
        });
        match outcome {
            LifecycleOutcome::Reached(name) => {
                if let Some(obj) = body.as_object_mut() {
                    obj.insert("success".to_string(), json!(true));
                    obj.insert("loaded".to_string(), json!(true));
                    obj.insert("lifecycle_event".to_string(), json!(name));
                }
            }
            LifecycleOutcome::Timeout => {
                if let Some(obj) = body.as_object_mut() {
                    obj.insert("success".to_string(), json!(true));
                    obj.insert("loaded".to_string(), json!(false));
                    obj.insert(
                        "warning".to_string(),
                        json!("navigation timed out before lifecycle 'load' event; page may still be loading"),
                    );
                }
            }
            LifecycleOutcome::Closed => {
                return Err(OpenBitFunError::tool(
                    "Browser target closed before the page finished loading.".to_string(),
                ));
            }
        }
        Ok(body)
    }

    pub async fn back(&self) -> OpenBitFunResult<Value> {
        self.evaluate("history.back(); undefined").await?;
        Ok(json!({ "success": true, "action": "back" }))
    }

    pub async fn forward(&self) -> OpenBitFunResult<Value> {
        self.evaluate("history.forward(); undefined").await?;
        Ok(json!({ "success": true, "action": "forward" }))
    }

    pub async fn reload(&self, ignore_cache: bool) -> OpenBitFunResult<Value> {
        self.client
            .send("Page.reload", Some(json!({ "ignoreCache": ignore_cache })))
            .await?;
        Ok(json!({ "success": true, "action": "reload", "ignore_cache": ignore_cache }))
    }

    pub async fn get_url(&self) -> OpenBitFunResult<String> {
        let result = self.evaluate("window.location.href").await?;
        Ok(result
            .get("result")
            .and_then(|r| r.get("value"))
            .and_then(|v| v.as_str())
            .unwrap_or("")
            .to_string())
    }

    pub async fn get_title(&self) -> OpenBitFunResult<String> {
        let result = self.evaluate("document.title").await?;
        Ok(result
            .get("result")
            .and_then(|r| r.get("value"))
            .and_then(|v| v.as_str())
            .unwrap_or("")
            .to_string())
    }

    // ── Snapshot / DOM ─────────────────────────────────────────────────

    /// Get an accessibility-tree snapshot of interactive elements.
    ///
    /// Phase 3: traversal now descends into **open shadow roots** and
    /// **same-origin iframes**, which the old flat `document.querySelectorAll`
    /// path silently skipped. Each element's `frame_path` reports where in
    /// the frame tree it lives (`""` for top frame,
    /// `"iframe[src='/foo']"` for an iframe child) and its `scope` reports
    /// `"document" | "shadow" | "iframe"`. The synthetic `data-cdp-ref`
    /// attribute is set in the host scope so subsequent `click` / `fill`
    /// can locate it via the same recursive walk.
    ///
    /// The listing covers the **current viewport only**; elements scrolled
    /// out of view and cross-origin iframe contents are excluded but
    /// reported (`offscreen_count`, `cross_origin_frames`, plus trailing
    /// note lines in `snapshot`) so their absence is never read as "the
    /// element does not exist".
    pub async fn snapshot(&self) -> OpenBitFunResult<Value> {
        self.snapshot_with_options(false).await
    }

    /// Snapshot variant that can additionally resolve a stable
    /// **backendNodeId** (CDP `DOM.Node.backendNodeId`) for each element.
    /// `backendNodeId` is invariant across reflows and JS re-renders within
    /// the same DOM lifetime, so saving it lets the agent re-target an
    /// element after a partial mutation without taking a full snapshot.
    ///
    /// The call is opt-in (and slightly more expensive) because it costs
    /// one extra CDP round-trip plus a `DOM.querySelectorAll` walk. When
    /// `with_backend_node_ids` is `true`, every snapshot element gets a
    /// `backend_node_id` field; pages where `DOM.getDocument` errors out
    /// (very rare — e.g. about:blank) silently fall back to no ids.
    pub async fn snapshot_with_options(
        &self,
        with_backend_node_ids: bool,
    ) -> OpenBitFunResult<Value> {
        let result = self.evaluate(SNAPSHOT_SCRIPT).await?;
        let mut parsed = snapshot_context::parse_snapshot_result(&result).map_err(|message| {
            structured_error(
                ErrorCode::Internal,
                message,
                &["Take a fresh snapshot; the previous page context was incomplete"],
            )
        })?;

        if with_backend_node_ids && self.client.capabilities().backend_node_ids {
            if let Err(e) = self.attach_backend_node_ids(&mut parsed).await {
                // Don't fail the snapshot — the elements list is still
                // useful without backendNodeIds. Surface the failure so the
                // model can decide whether to retry.
                if let Value::Object(m) = &mut parsed {
                    m.insert(
                        "backend_node_ids_warning".to_string(),
                        json!(format!("Failed to resolve backendNodeIds: {}", e)),
                    );
                }
            }
        } else if with_backend_node_ids {
            if let Value::Object(map) = &mut parsed {
                map.insert(
                    "backend_node_ids_warning".to_string(),
                    json!(format!(
                        "backend node ids are not available for the {} browser target",
                        self.client.target_kind()
                    )),
                );
            }
        }
        Self::attach_snapshot_text(&mut parsed);
        Ok(parsed)
    }

    fn attach_snapshot_text(parsed: &mut Value) {
        snapshot_context::attach_snapshot_text(parsed);
    }

    /// Resolve `backend_node_id` for every snapshot element by walking the
    /// DOM through CDP. Mutates `parsed["elements"][i]["backend_node_id"]`
    /// in place. Returns `Err` if the document tree could not be fetched.
    async fn attach_backend_node_ids(&self, parsed: &mut Value) -> OpenBitFunResult<()> {
        let doc = self.client.send("DOM.getDocument", None).await?;
        let root_id = doc
            .get("root")
            .and_then(|r| r.get("nodeId"))
            .and_then(|v| v.as_i64())
            .ok_or_else(|| {
                OpenBitFunError::tool("DOM.getDocument: missing root nodeId".to_string())
            })?;
        let qsa = self
            .client
            .send(
                "DOM.querySelectorAll",
                Some(json!({ "nodeId": root_id, "selector": "[data-cdp-ref]" })),
            )
            .await?;
        let node_ids: Vec<i64> = qsa
            .get("nodeIds")
            .and_then(|v| v.as_array())
            .map(|a| a.iter().filter_map(|n| n.as_i64()).collect())
            .unwrap_or_default();

        let mut by_ref: std::collections::HashMap<String, i64> = Default::default();
        for nid in node_ids {
            let described = match self
                .client
                .send("DOM.describeNode", Some(json!({ "nodeId": nid })))
                .await
            {
                Ok(d) => d,
                Err(_) => continue,
            };
            let backend = described
                .get("node")
                .and_then(|n| n.get("backendNodeId"))
                .and_then(|v| v.as_i64());
            // Read the data-cdp-ref attribute from the node's attributes
            // (DOM.describeNode returns flat [name, value, name, value]).
            let attrs = described
                .get("node")
                .and_then(|n| n.get("attributes"))
                .and_then(|v| v.as_array());
            let ref_name = attrs.and_then(|a| {
                a.chunks(2)
                    .find(|c| c.first().and_then(|n| n.as_str()) == Some("data-cdp-ref"))
                    .and_then(|c| c.get(1).and_then(|v| v.as_str().map(str::to_string)))
            });
            if let (Some(rn), Some(b)) = (ref_name, backend) {
                by_ref.insert(rn, b);
            }
        }

        if let Some(elements) = parsed.get_mut("elements").and_then(|v| v.as_array_mut()) {
            for el in elements.iter_mut() {
                let r = el.get("ref").and_then(|v| v.as_str()).map(str::to_string);
                if let Some(r) = r {
                    if let Some(b) = by_ref.get(&r) {
                        if let Value::Object(m) = el {
                            m.insert("backend_node_id".to_string(), json!(b));
                        }
                    }
                }
            }
        }
        Ok(())
    }

    /// Get the text content of an element by CSS selector or `@eN` ref.
    ///
    /// Phase 3: returns `Ok(None)` when the selector matched nothing (so
    /// ControlHub can surface a `NOT_FOUND` error instead of a misleading
    /// empty string), and `Ok(Some(""))` when the element was found but
    /// genuinely empty. The lookup walks shadow roots / same-origin
    /// iframes, matching the rest of the browser action surface.
    pub async fn get_text(&self, selector: &str) -> OpenBitFunResult<Option<String>> {
        self.get_attribute(selector, "text")
            .await
            .map(|v| v.map(|v| v.as_str().unwrap_or("").to_string()))
    }

    pub async fn get_attribute(
        &self,
        selector: &str,
        attribute: &str,
    ) -> OpenBitFunResult<Option<Value>> {
        let resolve = Self::resolve_element_js(selector);
        let getter = match attribute {
            "text" => "(el.textContent || '').trim().slice(0, 5000)".to_string(),
            "value" => "('value' in el ? el.value : '')".to_string(),
            "html" => "el.outerHTML".to_string(),
            other => format!(
                "el.getAttribute('{}')",
                other.replace('\\', "\\\\").replace('\'', "\\'")
            ),
        };
        let js = format!(
            r#"(function(){{
                try {{
                    {resolve}
                    return JSON.stringify({{ found: true, value: {getter} }});
                }} catch (e) {{
                    return JSON.stringify({{ found: false, error: String(e && e.message || e) }});
                }}
            }})()"#,
            resolve = resolve,
            getter = getter,
        );
        let result = self.evaluate(&js).await?;
        let raw = result
            .get("result")
            .and_then(|r| r.get("value"))
            .and_then(|v| v.as_str())
            .unwrap_or("{}");
        let parsed: Value = serde_json::from_str(raw).unwrap_or(json!({}));
        if parsed
            .get("found")
            .and_then(|v| v.as_bool())
            .unwrap_or(false)
        {
            Ok(Some(parsed.get("value").cloned().unwrap_or(Value::Null)))
        } else {
            Ok(None)
        }
    }

    // ── Interaction ────────────────────────────────────────────────────

    /// Click an element by CSS selector or by `@eN` ref.
    pub async fn click(&self, selector: &str) -> OpenBitFunResult<Value> {
        let (x, y) = self.element_center(selector).await?;

        self.client
            .send(
                "Input.dispatchMouseEvent",
                Some(json!({
                    "type": "mousePressed",
                    "x": x, "y": y,
                    "button": "left", "clickCount": 1
                })),
            )
            .await?;
        self.client
            .send(
                "Input.dispatchMouseEvent",
                Some(json!({
                    "type": "mouseReleased",
                    "x": x, "y": y,
                    "button": "left", "clickCount": 1
                })),
            )
            .await?;

        Ok(json!({
            "success": true,
            "action": "click",
            "selector": selector,
            "coordinates": { "x": x, "y": y }
        }))
    }

    /// Resolve the element's center in **top-level viewport** coordinates.
    ///
    /// `getBoundingClientRect` is relative to the element's own document's
    /// viewport. For an element inside a same-origin iframe (which
    /// `resolve_element_js` can reach) that is the *iframe's* viewport, while
    /// `Input.dispatchMouseEvent` expects top-level viewport coordinates — so
    /// walk the `window.frameElement` chain upward and add each frame's own
    /// bounding rect (plus its border via `clientLeft`/`clientTop`). A
    /// cross-origin ancestor throws on `frameElement` access; that case is
    /// surfaced as a structured error instead of clicking at a wrong spot.
    ///
    /// The point is also hit-tested with `elementFromPoint` in the element's
    /// own document: a mouse event dispatched at coordinates covered by an
    /// overlay lands on the overlay, and reporting that as a successful click
    /// on the intended element is the worst failure mode available.
    async fn element_center(&self, selector: &str) -> OpenBitFunResult<(f64, f64)> {
        let center_js = Self::element_center_js(selector);
        let result = self.evaluate(&center_js).await?;
        let coords_str = result
            .get("result")
            .and_then(|r| r.get("value"))
            .and_then(|v| v.as_str())
            .unwrap_or("{}");
        let coords: Value = serde_json::from_str(coords_str).unwrap_or(json!({}));
        if coords.get("error").and_then(|v| v.as_str()) == Some("cross_origin_frame") {
            return Err(cross_origin_frame_error(selector));
        }
        if let Some(blocker) = coords.get("blocked_by").and_then(|v| v.as_str()) {
            return Err(occluded_element_error(selector, blocker));
        }
        match (
            coords.get("x").and_then(|v| v.as_f64()),
            coords.get("y").and_then(|v| v.as_f64()),
        ) {
            (Some(x), Some(y)) => Ok((x, y)),
            _ => Err(structured_error(
                ErrorCode::Internal,
                format!("Failed to compute viewport center for '{}'", selector),
                &["Take a fresh snapshot and retry with a new @eN ref"],
            )),
        }
    }

    fn element_center_js(selector: &str) -> String {
        format!(
            r#"(function(){{
                {js}
                // Reveal the target without repositioning already visible content.
                el.scrollIntoView({{ block: 'nearest', inline: 'nearest', behavior: 'instant' }});
                const rect = el.getClientRects()[0] || el.getBoundingClientRect();
                const ownerWindow = el.ownerDocument.defaultView || window;
                const localX = (Math.max(0, rect.left) + Math.min(ownerWindow.innerWidth, rect.right)) / 2;
                const localY = (Math.max(0, rect.top) + Math.min(ownerWindow.innerHeight, rect.bottom)) / 2;
                let x = localX;
                let y = localY;
                try {{
                    let win = el.ownerDocument.defaultView;
                    while (win && win !== win.top) {{
                        const fe = win.frameElement;
                        if (!fe) break;
                        const fr = fe.getBoundingClientRect();
                        x += fr.x + fe.clientLeft;
                        y += fr.y + fe.clientTop;
                        win = win.parent;
                    }}
                }} catch (e) {{
                    return JSON.stringify({{ error: 'cross_origin_frame' }});
                }}
                let blockedBy = null;
                try {{
                    let hit = el.ownerDocument.elementFromPoint(localX, localY);
                    // Document-level elementFromPoint stops at a shadow host,
                    // and host.contains(shadowChild) is false — without
                    // descending, every element inside an open shadow root
                    // (which resolve/snapshot deliberately support) would be
                    // misreported as occluded by its own host.
                    while (hit && hit.shadowRoot) {{
                        const inner = hit.shadowRoot.elementFromPoint(localX, localY);
                        if (!inner || inner === hit) break;
                        hit = inner;
                    }}
                    if (!hit) {{
                        blockedBy = 'nothing (the point is outside the viewport)';
                    }} else if (hit !== el && !el.contains(hit) && !hit.contains(el)) {{
                        const hid = hit.id ? '#' + hit.id : '';
                        const hcls = (typeof hit.className === 'string' && hit.className.trim())
                            ? '.' + hit.className.trim().split(/\s+/).slice(0, 2).join('.')
                            : '';
                        const label = (hit.textContent || '').trim().slice(0, 40);
                        blockedBy = '<' + hit.tagName.toLowerCase() + hid + hcls + '>' + (label ? ' "' + label + '"' : '');
                    }}
                }} catch (_) {{}}
                return JSON.stringify({{ x: x, y: y, blocked_by: blockedBy }});
            }})()"#,
            js = Self::resolve_element_js(selector)
        )
    }

    pub async fn hover(&self, selector: &str) -> OpenBitFunResult<Value> {
        let (x, y) = self.element_center(selector).await?;
        self.client
            .send(
                "Input.dispatchMouseEvent",
                Some(json!({
                    "type": "mouseMoved",
                    "x": x, "y": y,
                    "button": "none"
                })),
            )
            .await?;
        Ok(json!({
            "success": true,
            "action": "hover",
            "selector": selector,
            "coordinates": { "x": x, "y": y }
        }))
    }

    /// Fill (clear + type) a text input identified by selector or `@eN` ref.
    pub async fn fill(&self, selector: &str, value: &str) -> OpenBitFunResult<Value> {
        let js = Self::resolve_element_js(selector);
        let focus_js = format!(
            r#"(function(){{ {} el.scrollIntoView({{ block: 'nearest', inline: 'nearest', behavior: 'instant' }}); el.focus({{ preventScroll: true }}); el.value = ''; el.dispatchEvent(new Event('input', {{ bubbles: true }})); return true; }})()"#,
            js
        );
        self.evaluate(&focus_js).await?;

        self.client
            .send("Input.insertText", Some(json!({ "text": value })))
            .await?;

        Ok(json!({
            "success": true,
            "action": "fill",
            "selector": selector,
        }))
    }

    /// Type text at the currently focused element (appends, does not clear).
    pub async fn type_text(&self, text: &str) -> OpenBitFunResult<Value> {
        self.client
            .send("Input.insertText", Some(json!({ "text": text })))
            .await?;
        Ok(json!({ "success": true, "action": "type", "text": text }))
    }

    pub async fn set_checked(&self, selector: &str, checked: bool) -> OpenBitFunResult<Value> {
        let js = Self::resolve_element_js(selector);
        let script = format!(
            r#"(function(){{
                {js}
                el.checked = {checked};
                el.dispatchEvent(new Event('input', {{ bubbles: true }}));
                el.dispatchEvent(new Event('change', {{ bubbles: true }}));
                return JSON.stringify({{ success: true, checked: !!el.checked }});
            }})()"#,
            js = js,
            checked = if checked { "true" } else { "false" }
        );
        let result = self.evaluate(&script).await?;
        let text = result
            .get("result")
            .and_then(|r| r.get("value"))
            .and_then(|v| v.as_str())
            .unwrap_or("{}");
        let parsed: Value = serde_json::from_str(text).unwrap_or(json!({}));
        Ok(json!({
            "success": parsed.get("success").and_then(|v| v.as_bool()).unwrap_or(true),
            "action": if checked { "check" } else { "uncheck" },
            "selector": selector,
            "checked": parsed.get("checked").cloned().unwrap_or(json!(checked)),
        }))
    }

    /// Select a dropdown option by visible text.
    pub async fn select(&self, selector: &str, option_text: &str) -> OpenBitFunResult<Value> {
        let js = Self::select_option_js(selector, option_text);
        let result = self.evaluate(&js).await?;
        let text = result
            .get("result")
            .and_then(|r| r.get("value"))
            .and_then(|v| v.as_str())
            .unwrap_or("{}");
        let parsed: Value = serde_json::from_str(text).unwrap_or(json!({}));
        Ok(parsed)
    }

    /// Press a key (Enter, Escape, Tab, etc.).
    pub async fn press_key(&self, key: &str) -> OpenBitFunResult<Value> {
        let fields = key_event_fields(key);
        // `keyDown` with `text` is what makes Chrome perform the key's default
        // action; keys that produce no text must go out as `rawKeyDown` or the
        // renderer drops them.
        let event_type = if fields.get("text").is_some() {
            "keyDown"
        } else {
            "rawKeyDown"
        };
        let mut down = fields.clone();
        if let Some(obj) = down.as_object_mut() {
            obj.insert("type".to_string(), json!(event_type));
        }
        self.client
            .send("Input.dispatchKeyEvent", Some(down))
            .await?;

        let mut up = fields;
        if let Some(obj) = up.as_object_mut() {
            obj.remove("text");
            obj.insert("type".to_string(), json!("keyUp"));
        }
        self.client.send("Input.dispatchKeyEvent", Some(up)).await?;
        Ok(json!({ "success": true, "action": "press_key", "key": key }))
    }

    /// Scroll the page.
    pub async fn scroll(&self, direction: &str, amount: Option<i64>) -> OpenBitFunResult<Value> {
        let px = amount.unwrap_or(500);
        let (delta_x, delta_y) = match direction {
            "up" => (0, -px),
            "down" => (0, px),
            "left" => (-px, 0),
            "right" => (px, 0),
            "top" => {
                self.evaluate("window.scrollTo(0, 0)").await?;
                return Ok(json!({ "success": true, "action": "scroll", "direction": "top" }));
            }
            "bottom" => {
                self.evaluate("window.scrollTo(0, document.body.scrollHeight)")
                    .await?;
                return Ok(json!({ "success": true, "action": "scroll", "direction": "bottom" }));
            }
            _ => (0, px),
        };
        self.client
            .send(
                "Input.dispatchMouseEvent",
                Some(json!({
                    "type": "mouseWheel",
                    "x": 400, "y": 300,
                    "deltaX": delta_x, "deltaY": delta_y,
                })),
            )
            .await?;
        Ok(json!({ "success": true, "action": "scroll", "direction": direction, "amount": px }))
    }

    pub async fn auto_scroll(
        &self,
        direction: &str,
        max_scrolls: u64,
        delay_ms: u64,
    ) -> OpenBitFunResult<Value> {
        let max_scrolls = max_scrolls.clamp(1, 200);
        let delay_ms = delay_ms.clamp(0, 5_000);
        let delta = if direction == "up" {
            "-window.innerHeight"
        } else {
            "window.innerHeight"
        };
        let boundary = if direction == "up" {
            "window.scrollY === 0"
        } else {
            "window.innerHeight + window.scrollY >= document.documentElement.scrollHeight - 2"
        };
        let script = format!(
            r#"(async () => {{
                let scrolls = 0;
                while (scrolls < {max_scrolls}) {{
                    const before = window.scrollY;
                    window.scrollBy(0, {delta});
                    await new Promise(resolve => setTimeout(resolve, {delay_ms}));
                    scrolls++;
                    if ({boundary} || window.scrollY === before) break;
                }}
                return {{ scrolls, scrollY: window.scrollY, height: document.documentElement.scrollHeight }};
            }})()"#
        );
        let result = self.evaluate(&script).await?;
        Ok(json!({
            "success": true,
            "action": "auto_scroll",
            "direction": direction,
            "result": result.get("result").and_then(|r| r.get("value")).cloned().unwrap_or(Value::Null),
        }))
    }

    /// Wait for a duration or a condition.
    ///
    /// Callers that can observe cancellation should sleep themselves rather
    /// than routing a plain duration through here — see ControlHub's
    /// `browser.wait`, which owns the cancellable, session-free duration path.
    ///
    /// `condition_timeout_ms` bounds the condition wait; it defaults to
    /// [`DEFAULT_CONDITION_TIMEOUT_MS`] and is ignored for duration waits.
    pub async fn wait(
        &self,
        duration_ms: Option<u64>,
        condition: Option<&str>,
        condition_timeout_ms: Option<u64>,
    ) -> OpenBitFunResult<Value> {
        if let Some(ms) = duration_ms {
            let clamped = ms.min(MAX_WAIT_MS);
            tokio::time::sleep(std::time::Duration::from_millis(clamped)).await;
            return Ok(json!({
                "success": true,
                "action": "wait",
                "ms": clamped,
                "requested_ms": ms,
                "clamped": clamped != ms,
            }));
        }
        if let Some(cond) = condition {
            let timeout_ms = condition_timeout_ms
                .filter(|ms| *ms > 0)
                .unwrap_or(DEFAULT_CONDITION_TIMEOUT_MS)
                .min(MAX_WAIT_MS);
            match cond {
                "networkidle" | "load" | "domcontentloaded" => {
                    // Phase 1: replace the previous "sleep 2s and hope" with
                    // a real `Page.lifecycleEvent` subscription. Lifecycle
                    // event names per CDP: `load`, `DOMContentLoaded`,
                    // `networkIdle`, `firstMeaningfulPaint`, etc.
                    let _ = self.client.send("Page.enable", None).await;
                    let _ = self
                        .client
                        .send(
                            "Page.setLifecycleEventsEnabled",
                            Some(json!({ "enabled": true })),
                        )
                        .await;
                    let mut events = self.client.subscribe_events();
                    let wanted: &[&str] = match cond {
                        "networkidle" => &["networkIdle"],
                        "domcontentloaded" => &["DOMContentLoaded", "load"],
                        _ => &["load"],
                    };
                    let outcome = wait_for_lifecycle(&mut events, None, wanted, timeout_ms).await;
                    let (success, lifecycle_event, timed_out) = match outcome {
                        LifecycleOutcome::Reached(n) => (true, Some(n), false),
                        LifecycleOutcome::Timeout => (false, None, true),
                        LifecycleOutcome::Closed => (false, None, false),
                    };
                    return Ok(json!({
                        "success": success,
                        "action": "wait",
                        "condition": cond,
                        "lifecycle_event": lifecycle_event,
                        "timed_out": timed_out,
                        "timeout_ms": timeout_ms,
                    }));
                }
                selector => {
                    const POLL_INTERVAL_MS: u64 = 500;
                    let js = Self::element_exists_js(selector);
                    let deadline =
                        tokio::time::Instant::now() + std::time::Duration::from_millis(timeout_ms);
                    loop {
                        let result = self.evaluate(&js).await?;
                        let found = result
                            .get("result")
                            .and_then(|r| r.get("value"))
                            .and_then(|v| v.as_bool())
                            .unwrap_or(false);
                        if found {
                            return Ok(json!({
                                "success": true,
                                "action": "wait",
                                "condition": cond,
                                "timeout_ms": timeout_ms,
                            }));
                        }
                        let remaining = deadline
                            .saturating_duration_since(tokio::time::Instant::now())
                            .as_millis() as u64;
                        if remaining == 0 {
                            break;
                        }
                        tokio::time::sleep(std::time::Duration::from_millis(
                            remaining.min(POLL_INTERVAL_MS),
                        ))
                        .await;
                    }
                    return Err(structured_error(
                        ErrorCode::Timeout,
                        format!("Timeout waiting for element: {}", cond),
                        &["Wait timed out — take a snapshot to check the current page state, or wait on 'load' / 'networkidle' instead of a selector"],
                    ));
                }
            }
        }
        // No duration and no condition: there is nothing to wait for. Reporting
        // success here used to make a mis-keyed duration (`ms` instead of
        // `duration_ms`) look like a completed wait that in fact returned
        // instantly, so the agent silently skipped its pause.
        Err(structured_error(
            ErrorCode::InvalidParams,
            "wait requires a duration or a condition",
            &[
                "Pass `duration_ms` (alias `ms`) to pause, e.g. { \"duration_ms\": 1800000 } for 30 minutes",
                "Or pass `condition`: 'load' | 'domcontentloaded' | 'networkidle' | a CSS/@ref selector",
            ],
        ))
    }

    // ── Capture ────────────────────────────────────────────────────────

    /// Take a screenshot of the current page, returns base64 JPEG data.
    pub async fn screenshot(&self) -> OpenBitFunResult<Value> {
        self.screenshot_with_options("jpeg", Some(80), true).await
    }

    pub async fn screenshot_with_options(
        &self,
        format: &str,
        quality: Option<u8>,
        from_surface: bool,
    ) -> OpenBitFunResult<Value> {
        self.screenshot_with_options_ext(format, quality, from_surface, false)
            .await
    }

    pub async fn screenshot_with_options_ext(
        &self,
        format: &str,
        quality: Option<u8>,
        from_surface: bool,
        full_page: bool,
    ) -> OpenBitFunResult<Value> {
        let normalized = if format.eq_ignore_ascii_case("png") {
            "png"
        } else {
            "jpeg"
        };

        let full_page_supported = self.client.capabilities().full_page_screenshot;
        if full_page && full_page_supported {
            if let Ok(metrics) = self.client.send("Page.getLayoutMetrics", None).await {
                let size = metrics
                    .get("cssContentSize")
                    .or_else(|| metrics.get("contentSize"));
                if let Some(size) = size {
                    let width = size
                        .get("width")
                        .and_then(|v| v.as_f64())
                        .unwrap_or(0.0)
                        .ceil() as u64;
                    let height = size
                        .get("height")
                        .and_then(|v| v.as_f64())
                        .unwrap_or(0.0)
                        .ceil() as u64;
                    if width > 0 && height > 0 {
                        let _ = self
                            .client
                            .send(
                                "Emulation.setDeviceMetricsOverride",
                                Some(json!({
                                    "mobile": false,
                                    "width": width,
                                    "height": height,
                                    "deviceScaleFactor": 1,
                                })),
                            )
                            .await;
                    }
                }
            }
        }

        let mut params = json!({
            "format": normalized,
            "fromSurface": from_surface,
        });
        if normalized == "jpeg" {
            params["quality"] = json!(quality.unwrap_or(80).min(100));
        }
        let result = self
            .client
            .send("Page.captureScreenshot", Some(params))
            .await?;
        if full_page && full_page_supported {
            let _ = self
                .client
                .send("Emulation.clearDeviceMetricsOverride", None)
                .await;
        }
        let data = result.get("data").and_then(|v| v.as_str()).unwrap_or("");
        Ok(json!({
            "success": true,
            "action": "screenshot",
            "format": normalized,
            "full_page": full_page && full_page_supported,
            "full_page_requested": full_page,
            "warning": if full_page && !full_page_supported {
                Value::String(format!(
                    "full-page capture is not available for the {} browser target; captured the visible viewport",
                    self.client.target_kind()
                ))
            } else {
                Value::Null
            },
            "data_length": data.len(),
            "base64_data": data,
            "data_url": format!("data:image/{};base64,{}", normalized, data),
        }))
    }

    // ── JavaScript ─────────────────────────────────────────────────────

    /// Evaluate a JavaScript expression in the page context.
    pub async fn evaluate(&self, expression: &str) -> OpenBitFunResult<Value> {
        self.evaluate_with_options(expression, true, true).await
    }

    pub async fn evaluate_with_options(
        &self,
        expression: &str,
        await_promise: bool,
        return_by_value: bool,
    ) -> OpenBitFunResult<Value> {
        let mut last_error: Option<OpenBitFunError> = None;
        for attempt in 0..2 {
            let result = self
                .client
                .send(
                    "Runtime.evaluate",
                    Some(json!({
                        "expression": expression,
                        "returnByValue": return_by_value,
                        "awaitPromise": await_promise,
                    })),
                )
                .await;
            match result {
                Ok(value) => {
                    if let Some(details) = value.get("exceptionDetails") {
                        let message = details
                            .get("exception")
                            .and_then(|e| e.get("description"))
                            .and_then(|v| v.as_str())
                            .or_else(|| details.get("text").and_then(|v| v.as_str()))
                            .unwrap_or("Runtime.evaluate failed");
                        return Err(classify_evaluate_exception(message));
                    }
                    return Ok(value);
                }
                Err(err) => {
                    let message = err.to_string();
                    let retryable = message.contains("Inspected target navigated")
                        || message.contains("Target closed")
                        || message.contains("Cannot find context with specified id");
                    last_error = Some(err);
                    if retryable && attempt == 0 {
                        tokio::time::sleep(std::time::Duration::from_millis(200)).await;
                        continue;
                    }
                    break;
                }
            }
        }
        Err(classify_transport_error(last_error.unwrap_or_else(|| {
            OpenBitFunError::tool("Runtime.evaluate failed".to_string())
        })))
    }

    pub async fn get_cookies(&self, urls: Option<Vec<String>>) -> OpenBitFunResult<Value> {
        let params = urls
            .filter(|items| !items.is_empty())
            .map(|urls| json!({ "urls": urls }))
            .unwrap_or_else(|| json!({}));
        let result = self.client.send("Network.getCookies", Some(params)).await?;
        Ok(json!({
            "success": true,
            "action": "cookies",
            "cookies": result.get("cookies").cloned().unwrap_or_else(|| json!([])),
        }))
    }

    pub async fn set_cookies(&self, cookies: &[Value]) -> OpenBitFunResult<Value> {
        let mut set = 0usize;
        let mut errors = Vec::<Value>::new();
        for cookie in cookies {
            match self
                .client
                .send("Network.setCookie", Some(cookie.clone()))
                .await
            {
                Ok(result)
                    if result
                        .get("success")
                        .and_then(|v| v.as_bool())
                        .unwrap_or(true) =>
                {
                    set += 1;
                }
                Ok(result) => errors.push(json!({ "cookie": cookie, "result": result })),
                Err(err) => errors.push(json!({ "cookie": cookie, "error": err.to_string() })),
            }
        }
        Ok(json!({
            "success": errors.is_empty(),
            "action": "set_cookies",
            "set": set,
            "errors": errors,
        }))
    }

    pub async fn set_file_input_files(
        &self,
        selector: Option<&str>,
        files: &[String],
    ) -> OpenBitFunResult<Value> {
        if files.is_empty() {
            return Err(OpenBitFunError::tool(
                "set_file_input_files requires non-empty 'files'".to_string(),
            ));
        }
        let query = selector.unwrap_or("input[type=\"file\"]");
        let css_selector = if query.starts_with("@e") {
            format!(r#"[data-cdp-ref="{}"]"#, query)
        } else {
            query.to_string()
        };
        let document = self.client.send("DOM.getDocument", None).await?;
        let root_id = document
            .get("root")
            .and_then(|r| r.get("nodeId"))
            .and_then(|v| v.as_i64())
            .ok_or_else(|| {
                OpenBitFunError::tool("DOM.getDocument: missing root nodeId".to_string())
            })?;
        let node = self
            .client
            .send(
                "DOM.querySelector",
                Some(json!({ "nodeId": root_id, "selector": css_selector })),
            )
            .await?;
        let node_id = node.get("nodeId").and_then(|v| v.as_i64()).unwrap_or(0);
        if node_id == 0 {
            return Err(OpenBitFunError::tool(format!(
                "No file input found for selector: {}",
                query
            )));
        }
        self.client
            .send(
                "DOM.setFileInputFiles",
                Some(json!({ "nodeId": node_id, "files": files })),
            )
            .await?;
        Ok(json!({
            "success": true,
            "action": "set_file_input_files",
            "selector": query,
            "count": files.len(),
        }))
    }

    pub async fn fetch(
        &self,
        url: &str,
        method: &str,
        headers: Value,
        body: Option<&str>,
    ) -> OpenBitFunResult<Value> {
        let script = format!(
            r#"(async () => {{
                try {{
                    const init = {{
                        method: {method},
                        credentials: 'include',
                        headers: {headers}
                    }};
                    const body = {body};
                    if (body !== null && init.method !== 'GET' && init.method !== 'HEAD') init.body = body;
                    const resp = await fetch({url}, init);
                    const contentType = resp.headers.get('content-type') || '';
                    let responseBody;
                    if (contentType.includes('application/json') && resp.status !== 204) {{
                        try {{ responseBody = await resp.json(); }} catch (_) {{ responseBody = await resp.text(); }}
                    }} else {{
                        responseBody = await resp.text();
                    }}
                    return JSON.stringify({{
                        ok: resp.ok,
                        status: resp.status,
                        status_text: resp.statusText,
                        content_type: contentType,
                        url: resp.url,
                        body: responseBody
                    }});
                }} catch (e) {{
                    return JSON.stringify({{ error: String(e && e.message || e) }});
                }}
            }})()"#,
            url = serde_json::to_string(url).unwrap_or_else(|_| "\"\"".to_string()),
            method = serde_json::to_string(&method.to_uppercase())
                .unwrap_or_else(|_| "\"GET\"".to_string()),
            headers = headers,
            body = body
                .map(|b| serde_json::to_string(b).unwrap_or_else(|_| "null".to_string()))
                .unwrap_or_else(|| "null".to_string()),
        );
        let result = self.evaluate(&script).await?;
        let raw = result
            .get("result")
            .and_then(|r| r.get("value"))
            .and_then(|v| v.as_str())
            .unwrap_or("{}");
        let parsed: Value = serde_json::from_str(raw).unwrap_or(json!({}));
        Ok(json!({ "success": parsed.get("error").is_none(), "action": "fetch", "result": parsed }))
    }

    pub async fn read_article(&self) -> OpenBitFunResult<Value> {
        let script = r#"
        (function() {
            function textOf(node) {
                return (node && node.textContent || '').replace(/\s+/g, ' ').trim();
            }
            const article = document.querySelector('article') || document.querySelector('main') || document.body;
            const title = document.querySelector('meta[property="og:title"]')?.content || document.title || '';
            const description = document.querySelector('meta[name="description"]')?.content || document.querySelector('meta[property="og:description"]')?.content || '';
            const siteName = document.querySelector('meta[property="og:site_name"]')?.content || location.hostname;
            const publishedTime = document.querySelector('meta[property="article:published_time"]')?.content || document.querySelector('time[datetime]')?.getAttribute('datetime') || null;
            const textContent = textOf(article);
            const headings = Array.from(article.querySelectorAll('h1,h2,h3')).slice(0, 20).map(h => ({ level: h.tagName.toLowerCase(), text: textOf(h) })).filter(h => h.text);
            return {
                title,
                description,
                siteName,
                publishedTime,
                url: location.href,
                length: textContent.length,
                excerpt: textContent.slice(0, 500),
                textContent,
                headings,
            };
        })()
        "#;
        let result = self.evaluate(script).await?;
        Ok(json!({
            "success": true,
            "action": "read_article",
            "article": result.get("result").and_then(|r| r.get("value")).cloned().unwrap_or(Value::Null),
        }))
    }

    // ── Close ──────────────────────────────────────────────────────────

    pub async fn close_page(&self) -> OpenBitFunResult<Value> {
        let _ = self.client.send("Page.close", None).await;
        Ok(json!({ "success": true, "action": "close" }))
    }

    // ── Internal helpers ───────────────────────────────────────────────

    /// Generate JS to resolve an element from selector or `@eN` ref.
    ///
    /// Phase 3: ref / selector lookup walks open shadow roots and
    /// same-origin iframes so refs / selectors created by `snapshot()` for
    /// elements inside a shadow root or iframe actually resolve. The legacy
    /// `document.querySelector` path returned `null` for any element nested
    /// inside a shadow root, which made `click @e7` mysteriously fail
    /// whenever the page used a web-component design system.
    fn resolve_element_js(selector: &str) -> String {
        snapshot_context::resolve_element_js(selector)
    }

    /// JS that reports whether `selector` (CSS **or** `@eN` ref) currently
    /// resolves, without throwing. `wait { condition: <selector> }` polls it;
    /// the raw `document.querySelector` it replaced threw a `SyntaxError` on
    /// every `@eN` ref because `@e3` is not valid CSS.
    fn element_exists_js(selector: &str) -> String {
        format!(
            r#"(function(){{
                try {{
                    {resolve}
                    return !!el;
                }} catch (_) {{
                    return false;
                }}
            }})()"#,
            resolve = Self::resolve_element_js(selector)
        )
    }

    /// JS that picks a `<select>` option by visible substring.
    ///
    /// The `{ error: 'Select not found' | 'Option not found', available }`
    /// result shape is a contract with ControlHub's `select` arm, which lifts
    /// it into the structured error envelope — keep the strings in sync.
    fn select_option_js(selector: &str, option_text: &str) -> String {
        format!(
            r#"(function(){{
                let sel = null;
                try {{
                    {resolve}
                    sel = el;
                }} catch (_) {{}}
                if (!sel || !sel.options) return JSON.stringify({{ error: 'Select not found' }});
                const needle = {needle};
                const opts = Array.from(sel.options);
                const opt = opts.find(o => o.text.includes(needle));
                if (!opt) return JSON.stringify({{ error: 'Option not found', available: opts.map(o => o.text) }});
                sel.value = opt.value;
                sel.dispatchEvent(new Event('change', {{ bubbles: true }}));
                return JSON.stringify({{ success: true, value: opt.value, text: opt.text }});
            }})()"#,
            resolve = Self::resolve_element_js(selector),
            needle = serde_json::to_string(option_text).unwrap_or_else(|_| "\"\"".to_string()),
        )
    }
}

#[cfg(test)]
mod shared_target_tests {
    use super::*;
    use crate::agentic::tools::browser_control::{
        BrowserAutomationCapabilities, BrowserAutomationEvent,
    };
    use std::sync::Mutex;

    struct FakeEmbeddedClient {
        events: broadcast::Sender<BrowserAutomationEvent>,
        methods: Mutex<Vec<String>>,
    }

    impl FakeEmbeddedClient {
        fn new() -> Self {
            Self {
                events: broadcast::channel(8).0,
                methods: Mutex::new(Vec::new()),
            }
        }

        fn methods(&self) -> Vec<String> {
            self.methods
                .lock()
                .unwrap_or_else(|poisoned| poisoned.into_inner())
                .clone()
        }
    }

    #[async_trait::async_trait]
    impl BrowserAutomationClient for FakeEmbeddedClient {
        async fn send(&self, method: &str, params: Option<Value>) -> OpenBitFunResult<Value> {
            self.methods
                .lock()
                .unwrap_or_else(|poisoned| poisoned.into_inner())
                .push(method.to_string());
            match method {
                "Runtime.evaluate" => {
                    let expression = params
                        .as_ref()
                        .and_then(|value| value.get("expression"))
                        .and_then(Value::as_str)
                        .unwrap_or("");
                    let value = if expression.contains("offscreen_count") {
                        json!({
                            "url": "https://example.test/",
                            "title": "Example",
                            "elements": [{ "ref": "@e1", "tag": "button", "text": "Continue" }],
                            "offscreen_count": 0,
                            "cross_origin_frames": 0,
                        })
                        .to_string()
                    } else {
                        json!({
                            "x": 32,
                            "y": 24,
                            "visible": true,
                            "disabled": false,
                            "blocked_by": null,
                            "cross_origin_frame": false,
                        })
                        .to_string()
                    };
                    Ok(json!({ "result": { "type": "string", "value": value } }))
                }
                "Input.dispatchMouseEvent" => Ok(json!({})),
                other => Err(OpenBitFunError::tool(format!(
                    "unexpected primitive: {other}"
                ))),
            }
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

    #[tokio::test]
    async fn embedded_target_runs_snapshot_and_click_through_browser_actions() {
        let client = FakeEmbeddedClient::new();
        let actions = BrowserActions::new(&client);

        let snapshot = actions.snapshot_with_options(true).await.expect("snapshot");
        assert_eq!(snapshot["elements"][0]["ref"], "@e1");
        assert!(snapshot["backend_node_ids_warning"]
            .as_str()
            .is_some_and(|warning| warning.contains("builtin")));

        let clicked = actions.click("@e1").await.expect("click");
        assert_eq!(clicked["success"], true);
        assert_eq!(
            client.methods(),
            vec![
                "Runtime.evaluate",
                "Runtime.evaluate",
                "Input.dispatchMouseEvent",
                "Input.dispatchMouseEvent",
            ]
        );
    }
}

#[cfg(test)]
mod structured_error_tests {
    use super::*;

    // These errors are produced at the failure source in the `[CODE]
    // message\nHints: …` wire format so ControlHub's `map_dispatch_error`
    // recovers a stable `error.code` via structured parsing. The round-trip
    // through `map_dispatch_error` itself is asserted in
    // `control_hub_tool.rs` tests.

    #[test]
    fn classify_evaluate_exception_maps_element_not_found_to_not_found_code() {
        let msg = classify_evaluate_exception(
            "Error: Element not found: @e7 — take a fresh snapshot or check shadow/iframe scope",
        )
        .to_string();
        assert!(msg.contains("[NOT_FOUND]"), "got: {msg}");
        assert!(
            msg.contains("take a new snapshot") && msg.contains("@eN"),
            "recovery hint missing: {msg}"
        );
    }

    #[test]
    fn classify_evaluate_exception_defaults_to_internal() {
        let msg = classify_evaluate_exception("TypeError: x is undefined").to_string();
        assert!(msg.contains("[INTERNAL]"), "got: {msg}");
        assert!(msg.contains("TypeError: x is undefined"), "got: {msg}");
    }

    #[test]
    fn classify_transport_error_maps_dead_socket_to_wrong_tab() {
        let msg = classify_transport_error(OpenBitFunError::tool(
            "CDP send failed: broken pipe".to_string(),
        ))
        .to_string();
        assert!(msg.contains("[WRONG_TAB]"), "got: {msg}");
        assert!(msg.contains("browser.connect"), "got: {msg}");
    }

    #[test]
    fn classify_transport_error_maps_cdp_timeout_to_timeout() {
        let msg = classify_transport_error(OpenBitFunError::tool(
            "CDP timeout for method Runtime.evaluate".to_string(),
        ))
        .to_string();
        assert!(msg.contains("[TIMEOUT]"), "got: {msg}");
    }

    #[test]
    fn classify_transport_error_maps_missing_builtin_target_to_wrong_tab() {
        let msg = classify_transport_error(OpenBitFunError::tool(
            "Built-in browser adapter failed for Runtime.evaluate: Webview not found".to_string(),
        ))
        .to_string();
        assert!(msg.contains("[WRONG_TAB]"), "got: {msg}");
        assert!(msg.contains("switch_page"), "got: {msg}");
    }

    #[test]
    fn classify_transport_error_passes_through_other_errors() {
        let msg =
            classify_transport_error(OpenBitFunError::tool("CDP error: some detail".to_string()))
                .to_string();
        assert!(msg.contains("CDP error: some detail"), "got: {msg}");
        assert!(
            !msg.contains("[WRONG_TAB]") && !msg.contains("[TIMEOUT]"),
            "must not be re-coded: {msg}"
        );
    }

    #[test]
    fn cross_origin_frame_error_is_structured_and_actionable() {
        let msg = cross_origin_frame_error("@e3").to_string();
        assert!(msg.contains("[NOT_AVAILABLE]"), "got: {msg}");
        assert!(msg.contains("cross-origin iframe"), "got: {msg}");
        assert!(
            msg.contains("Take a snapshot") && msg.contains("same-origin"),
            "recovery hint missing: {msg}"
        );
    }

    #[test]
    fn classify_evaluate_exception_declares_cross_origin_iframes_when_present() {
        // A page whose target lives in a cross-origin iframe can only ever
        // answer "not found"; without the added hint the model reads that as
        // "the element does not exist" and retries forever.
        let msg = classify_evaluate_exception(
            "Error: Element not found: @e7 — take a fresh snapshot or check shadow/iframe scope (page contains 2 cross-origin iframe(s) whose contents cannot be inspected)",
        )
        .to_string();
        assert!(msg.contains("[NOT_FOUND]"), "got: {msg}");
        assert!(
            msg.contains("cross-origin iframes whose contents cannot be inspected"),
            "cross-origin limitation not surfaced: {msg}"
        );
    }

    #[test]
    fn classify_evaluate_exception_omits_cross_origin_hint_without_frames() {
        let msg = classify_evaluate_exception("Error: Element not found: @e7").to_string();
        assert!(
            !msg.contains("cross-origin"),
            "must not claim cross-origin frames that do not exist: {msg}"
        );
    }

    #[test]
    fn occluded_element_error_refuses_instead_of_reporting_success() {
        let msg = occluded_element_error("@e4", "<div#cookie-banner> \"Accept all\"").to_string();
        assert!(msg.contains("[GUARD_REJECTED]"), "got: {msg}");
        assert!(msg.contains("cookie-banner"), "blocker missing: {msg}");
        assert!(
            msg.contains("press Escape") && msg.contains("fresh snapshot"),
            "recovery hint missing: {msg}"
        );
    }
}

#[cfg(test)]
mod script_tests {
    use super::*;

    #[test]
    fn snapshot_clears_stale_refs_before_renumbering() {
        // Refs restart at @e1 every snapshot, so a leftover `data-cdp-ref`
        // would make a stale element answer to a ref that now belongs to a
        // different one — `click @eN` would then silently hit the wrong
        // element while reporting success.
        let clear = SNAPSHOT_SCRIPT
            .find("clearRefs(document);")
            .expect("top document refs must be cleared");
        assert!(SNAPSHOT_SCRIPT.contains("if (doc) clearRefs(doc)"));
        let walk = SNAPSHOT_SCRIPT
            .find("walk(document, window, 'document', '');")
            .expect("snapshot must walk the top document");
        assert!(clear < walk, "clearRefs(document) must precede renumbering");
        assert!(
            SNAPSHOT_SCRIPT.contains("if (host.shadowRoot) clearRefs(host.shadowRoot)"),
            "clearRefs must descend into open shadow roots"
        );
    }

    #[test]
    fn snapshot_reports_what_it_could_not_see() {
        assert!(
            SNAPSHOT_SCRIPT.contains("offscreen++"),
            "elements outside the viewport must be counted"
        );
        assert!(
            SNAPSHOT_SCRIPT.contains("offscreen_count: offscreen"),
            "offscreen count must be reported"
        );
        assert!(
            SNAPSHOT_SCRIPT.contains("crossOriginFrames++")
                && SNAPSHOT_SCRIPT.contains("cross_origin_frames: crossOriginFrames"),
            "cross-origin iframes must be counted and reported"
        );
        assert!(
            SNAPSHOT_SCRIPT.contains("viewport_only: true"),
            "the viewport-only limitation must be declared"
        );
    }

    #[test]
    fn snapshot_text_notes_elements_the_listing_omits() {
        let mut parsed = json!({
            "elements": [{ "ref": "@e1", "tag": "button", "text": "Buy" }],
            "offscreen_count": 3,
            "cross_origin_frames": 1,
        });
        BrowserActions::attach_snapshot_text(&mut parsed);
        let text = parsed
            .get("snapshot")
            .and_then(|v| v.as_str())
            .unwrap_or_default();
        assert!(text.contains("- button [@e1]"), "got: {text}");
        assert!(
            text.contains("3 more interactive element(s) exist outside the current viewport"),
            "offscreen note missing: {text}"
        );
        assert!(
            text.contains("1 cross-origin iframe(s)"),
            "cross-origin note missing: {text}"
        );
    }

    #[test]
    fn snapshot_text_stays_quiet_when_nothing_was_omitted() {
        let mut parsed = json!({
            "elements": [{ "ref": "@e1", "tag": "button", "text": "Buy" }],
            "offscreen_count": 0,
            "cross_origin_frames": 0,
        });
        BrowserActions::attach_snapshot_text(&mut parsed);
        let text = parsed
            .get("snapshot")
            .and_then(|v| v.as_str())
            .unwrap_or_default();
        assert!(!text.contains("note:"), "unexpected note: {text}");
    }

    #[test]
    fn element_center_hit_tests_the_click_point() {
        let js = BrowserActions::element_center_js("@e2");
        assert!(
            js.contains("elementFromPoint(localX, localY)"),
            "click point must be hit-tested: {js}"
        );
        assert!(
            js.contains("hit !== el && !el.contains(hit) && !hit.contains(el)"),
            "hit test must accept the element and its own subtree only: {js}"
        );
        assert!(
            js.contains("blocked_by: blockedBy"),
            "the blocker must be reported back: {js}"
        );
    }

    #[test]
    fn select_and_wait_accept_element_refs() {
        // `document.querySelector('@e3')` throws a SyntaxError — both call
        // sites must go through the ref-aware resolver instead.
        let select_js = BrowserActions::select_option_js("@e3", "Standard shipping");
        assert!(
            select_js.contains(r#"[data-cdp-ref=\"@e3\"]"#),
            "select must resolve @eN refs: {select_js}"
        );
        assert!(
            select_js.contains("'Select not found'") && select_js.contains("'Option not found'"),
            "ControlHub's error contract must be preserved: {select_js}"
        );
        assert!(
            select_js.contains(r#""Standard shipping""#),
            "option text must be embedded as a JS string literal: {select_js}"
        );

        let wait_js = BrowserActions::element_exists_js("@e3");
        assert!(
            wait_js.contains(r#"[data-cdp-ref=\"@e3\"]"#),
            "wait must resolve @eN refs: {wait_js}"
        );
        assert!(
            wait_js.contains("return false;"),
            "a missing element must be falsy, not an exception: {wait_js}"
        );
    }

    #[test]
    fn select_js_escapes_option_text() {
        let js = BrowserActions::select_option_js("select#ship", "O'Brien \"fast\"");
        assert!(
            js.contains(r#""O'Brien \"fast\"""#),
            "quotes in the option text must not break the script: {js}"
        );
    }

    #[test]
    fn resolve_element_js_reports_cross_origin_frames_when_lookup_fails() {
        let js = BrowserActions::resolve_element_js("@e1");
        assert!(
            js.contains("crossOriginFrames++"),
            "not-found path must count cross-origin frames: {js}"
        );
        assert!(
            js.contains("cross-origin iframe(s) whose contents cannot be inspected"),
            "the limitation must reach the thrown message: {js}"
        );
    }

    #[test]
    fn press_key_enter_carries_text_and_virtual_key_code() {
        // Without these fields Chrome delivers a keydown to listeners but
        // performs no default action, so Enter never submits a form.
        let fields = key_event_fields("Enter");
        assert_eq!(fields.get("text").and_then(|v| v.as_str()), Some("\r"));
        assert_eq!(
            fields.get("windowsVirtualKeyCode").and_then(|v| v.as_i64()),
            Some(13)
        );
        assert_eq!(fields.get("code").and_then(|v| v.as_str()), Some("Enter"));
        assert_eq!(fields.get("key").and_then(|v| v.as_str()), Some("Enter"));
    }

    #[test]
    fn press_key_maps_named_keys_and_single_characters() {
        let tab = key_event_fields("Tab");
        assert_eq!(
            tab.get("windowsVirtualKeyCode").and_then(|v| v.as_i64()),
            Some(9)
        );
        assert!(tab.get("text").is_none(), "Tab produces no text: {tab}");

        let arrow = key_event_fields("ArrowDown");
        assert_eq!(
            arrow.get("windowsVirtualKeyCode").and_then(|v| v.as_i64()),
            Some(40)
        );

        let letter = key_event_fields("a");
        assert_eq!(letter.get("text").and_then(|v| v.as_str()), Some("a"));
        assert_eq!(
            letter.get("windowsVirtualKeyCode").and_then(|v| v.as_i64()),
            Some(65),
            "virtual key codes are for the uppercased character: {letter}"
        );

        let unknown = key_event_fields("F13");
        assert_eq!(unknown.get("key").and_then(|v| v.as_str()), Some("F13"));
        assert!(
            unknown.get("windowsVirtualKeyCode").is_none(),
            "unknown keys must not guess a virtual key code: {unknown}"
        );
    }
}
