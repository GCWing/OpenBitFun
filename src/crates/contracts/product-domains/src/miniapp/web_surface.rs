//! Main-Agent to MiniApp Web surface contracts.
//!
//! Runtime control complements source inspection and editing through the
//! existing MiniApp authoring owner. This module owns the stable DTOs, limits,
//! and pure helpers for the Agent tool and Desktop surface adapter:
//!
//! - surface capabilities and session identity,
//! - locator priority and sanitization,
//! - short-lived target handles plus their staleness rules,
//! - bridge payload limits; wire envelopes are handled by the surface runtime.
//!
//! Nothing here may carry a `PathManager`, source directory, draft root, or any
//! other controller-local path.

use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
use std::collections::HashMap;

/// Bridge protocol version a MiniApp must echo in `agent-ready`.
pub const MINIAPP_WEB_SCHEMA_VERSION: &str = "agent.v1";

/// Upper bound for a single page-structure observation.
pub const MINIAPP_WEB_MAX_NODES: usize = 320;
/// Upper bound for the rendered tree depth.
pub const MINIAPP_WEB_MAX_DEPTH: usize = 12;
/// Upper bound for a node name / label.
pub const MINIAPP_WEB_MAX_NAME_CHARS: usize = 120;
/// Upper bound for a node text or value snippet.
pub const MINIAPP_WEB_MAX_TEXT_CHARS: usize = 400;
/// Upper bound for live target handles in one session.
pub const MINIAPP_WEB_MAX_TARGETS: usize = 320;
/// Upper bound for one `wait` call.
pub const MINIAPP_WEB_MAX_WAIT_MS: u64 = 10_000;
/// Default observation interval for `wait`.
pub const MINIAPP_WEB_DEFAULT_WAIT_MS: u64 = 200;
/// A target handle stops being usable this long after it was minted.
pub const MINIAPP_WEB_TARGET_TTL_MS: u64 = 10 * 60 * 1000;
/// Upper bound for a bridge request or response payload.
pub const MINIAPP_WEB_MAX_BRIDGE_BYTES: usize = 32 * 1024;
/// Upper bound for one bridge round trip.
pub const MINIAPP_WEB_BRIDGE_TIMEOUT_MS: u64 = 5_000;
/// Longest side a captured frame is scaled to before it reaches the model. A
/// Canvas MiniApp may need pixels when its bridge does not expose enough state;
/// the bound keeps one observation readable and cheap.
pub const MINIAPP_WEB_MAX_CAPTURE_EDGE: u32 = 1024;
/// Default longest side for a captured frame.
pub const MINIAPP_WEB_DEFAULT_CAPTURE_EDGE: u32 = 900;
/// Upper bound for one captured image, measured after base64 decoding.
pub const MINIAPP_WEB_MAX_CAPTURE_BYTES: usize = 1_500_000;
/// Upper bound for holding a key down. A game reads held input on its own
/// animation frame, so a key that goes down and up inside one call is invisible
/// to it; this is long enough to move, short enough not to stall a turn.
pub const MINIAPP_WEB_MAX_KEY_HOLD_MS: u64 = 2_000;
/// Upper bound for one `watch_state` window. A turn-paced Agent cannot follow a
/// running app by calling `observe_bridge` in a loop, because every round trip
/// costs a model turn; one bounded sampling window replaces that loop without
/// leaving the app the user is watching.
pub const MINIAPP_WEB_MAX_WATCH_MS: u64 = 120_000;
/// Default sampling window for `watch_state`.
pub const MINIAPP_WEB_DEFAULT_WATCH_MS: u64 = 20_000;
/// Fastest allowed sampling interval. Sampling is a rendered state read, not a
/// frame capture, but it still competes with the app's own loop.
pub const MINIAPP_WEB_MIN_WATCH_POLL_MS: u64 = 250;
/// Default sampling interval.
pub const MINIAPP_WEB_DEFAULT_WATCH_POLL_MS: u64 = 1_000;
/// Upper bound for retained samples in one window. Samples are deduplicated by
/// state, so this only fills up when the app is actually changing.
pub const MINIAPP_WEB_MAX_WATCH_SAMPLES: usize = 120;
/// Upper bound for one retained sample's serialized state.
pub const MINIAPP_WEB_MAX_WATCH_SAMPLE_BYTES: usize = 4 * 1024;

/// Upper bound for one app-discovery response. A user names a MiniApp, while the
/// surface is addressed by app id, so discovery is how the Agent crosses that
/// gap without reaching host paths.
pub const MINIAPP_WEB_MAX_APPS: usize = 200;
/// Upper bound for a discovered app description.
pub const MINIAPP_WEB_MAX_DESCRIPTION_CHARS: usize = 200;

/// Web surface capabilities reported by the host for one session.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum MiniAppWebCapability {
    /// The iframe document is readable, so page structure can be inspected.
    Dom,
    /// Locators may use accessibility role/name.
    Accessibility,
    /// The host can dispatch input events into the MiniApp frame.
    Input,
    /// Opt-in: click accepts a normalized position within a bound element.
    /// Older hosts may ignore unknown click parameters, so callers must check this.
    ElementPositionClick,
}

impl MiniAppWebCapability {
    pub const fn as_str(self) -> &'static str {
        match self {
            Self::Dom => "dom",
            Self::Accessibility => "accessibility",
            Self::Input => "input",
            Self::ElementPositionClick => "element-position-click-v1",
        }
    }

    /// Capabilities granted by a readable (same-origin) MiniApp frame.
    pub fn readable_surface() -> Vec<Self> {
        vec![Self::Dom, Self::Accessibility, Self::Input]
    }
}

/// Stable error taxonomy. Models branch on these codes instead of English text.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum MiniAppWebErrorCode {
    InvalidParams,
    UnknownApp,
    UnknownSession,
    UnknownTarget,
    StaleTarget,
    SurfaceUnavailable,
    CapabilityMissing,
    BridgeUnavailable,
    BridgeTimeout,
    BridgeRejected,
    Timeout,
    HostError,
}

impl MiniAppWebErrorCode {
    pub const fn as_str(self) -> &'static str {
        match self {
            Self::InvalidParams => "INVALID_PARAMS",
            Self::UnknownApp => "UNKNOWN_APP",
            Self::UnknownSession => "UNKNOWN_SESSION",
            Self::UnknownTarget => "UNKNOWN_TARGET",
            Self::StaleTarget => "STALE_TARGET",
            Self::SurfaceUnavailable => "SURFACE_UNAVAILABLE",
            Self::CapabilityMissing => "CAPABILITY_MISSING",
            Self::BridgeUnavailable => "BRIDGE_UNAVAILABLE",
            Self::BridgeTimeout => "BRIDGE_TIMEOUT",
            Self::BridgeRejected => "BRIDGE_REJECTED",
            Self::Timeout => "TIMEOUT",
            Self::HostError => "HOST_ERROR",
        }
    }
}

/// One captured frame of a MiniApp surface.
///
/// A canvas-backed MiniApp (in particular a game) exposes no readable document
/// state, so the only live observation is what the app paints. The surface
/// runtime captures the largest canvas in the frame, scales it within
/// [`MINIAPP_WEB_MAX_CAPTURE_EDGE`], and returns it as an image the model can
/// look at.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct MiniAppWebCapture {
    pub mime_type: String,
    pub data_base64: String,
    pub width: u32,
    pub height: u32,
    /// Which part of the frame was captured, for honest reporting.
    pub source: String,
    /// Element label or tag the capture came from.
    pub label: Option<String>,
}

impl MiniAppWebCapture {
    /// Image types the model side accepts. Anything else is a surface bug.
    pub const ALLOWED_MIME_TYPES: &'static [&'static str] =
        &["image/png", "image/jpeg", "image/webp"];

    /// Parse and bound a `capture` payload produced by the surface runtime. The
    /// frontend is not a trust boundary, so the image is validated here before
    /// it reaches the model.
    pub fn parse(payload: &Value) -> Result<Self, MiniAppWebErrorCode> {
        let mime_type = payload
            .get("mimeType")
            .and_then(Value::as_str)
            .map(|value| value.trim().to_ascii_lowercase())
            .filter(|value| Self::ALLOWED_MIME_TYPES.contains(&value.as_str()))
            .ok_or(MiniAppWebErrorCode::CapabilityMissing)?;
        let data_base64 = payload
            .get("dataBase64")
            .and_then(Value::as_str)
            .map(str::trim)
            .filter(|value| !value.is_empty())
            .ok_or(MiniAppWebErrorCode::CapabilityMissing)?;
        // Base64 inflates by 4/3, so this rejects an oversized frame without
        // decoding it.
        if data_base64.len() > MINIAPP_WEB_MAX_CAPTURE_BYTES / 3 * 4 {
            return Err(MiniAppWebErrorCode::HostError);
        }
        let width = payload
            .get("width")
            .and_then(Value::as_u64)
            .unwrap_or(0)
            .min(u64::from(MINIAPP_WEB_MAX_CAPTURE_EDGE)) as u32;
        let height = payload
            .get("height")
            .and_then(Value::as_u64)
            .unwrap_or(0)
            .min(u64::from(MINIAPP_WEB_MAX_CAPTURE_EDGE)) as u32;
        let source = payload
            .get("source")
            .and_then(Value::as_str)
            .map(|value| value.chars().take(40).collect::<String>())
            .unwrap_or_else(|| "canvas".to_string());
        let label = payload
            .get("label")
            .and_then(Value::as_str)
            .map(|value| value.chars().take(MINIAPP_WEB_MAX_NAME_CHARS).collect());
        Ok(Self {
            mime_type,
            data_base64: data_base64.to_string(),
            width,
            height,
            source,
            label,
        })
    }

    /// Bytes this capture occupies once decoded.
    pub fn decoded_len(&self) -> usize {
        self.data_base64.len() / 4 * 3
    }
}

/// Locator axes in resolution priority order. A CSS selector is the last resort
/// because it binds to implementation detail rather than user-visible meaning.
pub const MINIAPP_WEB_LOCATOR_PRIORITY: &[&str] =
    &["testId", "roleName", "name", "text", "selector"];

/// Element locator. All provided axes must match the same node.
#[derive(Clone, Debug, Default, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase", default)]
pub struct MiniAppWebLocator {
    pub test_id: Option<String>,
    pub role: Option<String>,
    pub name: Option<String>,
    pub text: Option<String>,
    pub selector: Option<String>,
    /// Require an exact (not substring) name/text match.
    pub exact: Option<bool>,
}

impl MiniAppWebLocator {
    /// Trim, drop empty axes, and bound every length before the value reaches
    /// the Web UI surface runtime.
    pub fn sanitized(self) -> Self {
        fn bounded(value: Option<String>, limit: usize) -> Option<String> {
            let value = value?;
            let trimmed = value.trim();
            if trimmed.is_empty() {
                return None;
            }
            Some(trimmed.chars().take(limit).collect())
        }

        Self {
            test_id: bounded(self.test_id, MINIAPP_WEB_MAX_NAME_CHARS),
            role: bounded(self.role.map(|role| role.to_ascii_lowercase()), 40),
            name: bounded(self.name, MINIAPP_WEB_MAX_NAME_CHARS),
            text: bounded(self.text, MINIAPP_WEB_MAX_TEXT_CHARS),
            selector: bounded(self.selector, MINIAPP_WEB_MAX_NAME_CHARS),
            exact: self.exact,
        }
    }

    pub fn is_empty(&self) -> bool {
        self.test_id.is_none()
            && self.role.is_none()
            && self.name.is_none()
            && self.text.is_none()
            && self.selector.is_none()
    }

    /// Which axes drive resolution, highest priority first.
    pub fn active_axes(&self) -> Vec<&'static str> {
        let mut axes = Vec::new();
        if self.test_id.is_some() {
            axes.push("testId");
        }
        if self.role.is_some() || self.name.is_some() {
            axes.push("roleName");
        }
        if self.text.is_some() {
            axes.push("text");
        }
        if self.selector.is_some() {
            axes.push("selector");
        }
        axes
    }

    /// A selector-only locator is a compatibility fallback: the tool warns the
    /// model so it prefers stable test ids or accessible names.
    pub fn is_selector_fallback(&self) -> bool {
        self.selector.is_some()
            && self.test_id.is_none()
            && self.name.is_none()
            && self.text.is_none()
    }

    pub fn to_value(&self) -> Value {
        json!({
            "testId": self.test_id,
            "role": self.role,
            "name": self.name,
            "text": self.text,
            "selector": self.selector,
            "exact": self.exact.unwrap_or(false),
        })
    }
}

/// One node of a page-structure observation. `node_key` is a host-internal
/// handle the Web UI mints; it never reaches the model.
#[derive(Clone, Debug, Default, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase", default)]
pub struct MiniAppWebNode {
    pub node_key: Option<String>,
    pub role: Option<String>,
    pub name: Option<String>,
    pub tag: Option<String>,
    pub test_id: Option<String>,
    pub value: Option<String>,
    pub text: Option<String>,
    pub enabled: Option<bool>,
    pub checked: Option<bool>,
    pub children: Vec<MiniAppWebNode>,
}

impl MiniAppWebNode {
    /// Bounded, single-line description used for model-facing summaries.
    pub fn summary_line(&self, target_id: &str) -> String {
        let mut line = target_id.to_string();
        line.push(' ');
        line.push_str(self.role.as_deref().unwrap_or("node"));
        if let Some(name) = self.name.as_deref().filter(|name| !name.trim().is_empty()) {
            line.push_str(&format!(" {name:?}"));
        }
        if let Some(test_id) = self.test_id.as_deref().filter(|id| !id.trim().is_empty()) {
            line.push_str(&format!(" testId={test_id}"));
        }
        if self.enabled == Some(false) {
            line.push_str(" [disabled]");
        }
        if let Some(checked) = self.checked {
            line.push_str(if checked {
                " [checked]"
            } else {
                " [unchecked]"
            });
        }
        if let Some(value) = self
            .value
            .as_deref()
            .filter(|value| !value.trim().is_empty())
        {
            line.push_str(&format!(" value={:?}", truncate_chars(value, 60)));
        }
        line
    }

    /// Drop host keys, bound every string, and cut the tree at the contract
    /// limits. Returns the sanitized tree and whether anything was dropped.
    pub fn sanitize_tree(nodes: Vec<MiniAppWebNode>) -> (Vec<MiniAppWebNode>, bool) {
        let mut budget = MINIAPP_WEB_MAX_NODES;
        let mut truncated = false;
        let sanitized = sanitize_level(nodes, 1, &mut budget, &mut truncated);
        (sanitized, truncated)
    }
}

fn sanitize_level(
    nodes: Vec<MiniAppWebNode>,
    depth: usize,
    budget: &mut usize,
    truncated: &mut bool,
) -> Vec<MiniAppWebNode> {
    if depth > MINIAPP_WEB_MAX_DEPTH {
        *truncated = true;
        return Vec::new();
    }
    let mut kept = Vec::new();
    for node in nodes {
        if *budget == 0 {
            *truncated = true;
            break;
        }
        *budget -= 1;
        let children = sanitize_level(node.children, depth + 1, budget, truncated);
        kept.push(MiniAppWebNode {
            node_key: node.node_key,
            role: truncate_option(node.role, 40),
            name: truncate_option(node.name, MINIAPP_WEB_MAX_NAME_CHARS),
            tag: truncate_option(node.tag, 32),
            test_id: truncate_option(node.test_id, MINIAPP_WEB_MAX_NAME_CHARS),
            value: truncate_option(node.value, MINIAPP_WEB_MAX_TEXT_CHARS),
            text: truncate_option(node.text, MINIAPP_WEB_MAX_TEXT_CHARS),
            enabled: node.enabled,
            checked: node.checked,
            children,
        });
    }
    kept
}

fn truncate_option(value: Option<String>, limit: usize) -> Option<String> {
    let value = value?;
    let trimmed = value.trim();
    if trimmed.is_empty() {
        return None;
    }
    Some(truncate_chars(trimmed, limit))
}

fn truncate_chars(value: &str, limit: usize) -> String {
    if value.chars().count() <= limit {
        return value.to_string();
    }
    let truncated = value.chars().take(limit).collect::<String>();
    format!("{truncated}…")
}

/// Surface description returned by `open`. `capabilities` is authoritative for
/// what the Agent may attempt on this session.
#[derive(Clone, Debug, Default, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase", default)]
pub struct MiniAppWebSurfaceInfo {
    pub instance_id: Option<String>,
    pub app_id: String,
    pub strict_runtime: bool,
    pub width: Option<u32>,
    pub height: Option<u32>,
    pub capabilities: Vec<String>,
    #[serde(default)]
    pub bridge_capabilities: Vec<String>,
    /// Action types the app listed for `act`. Empty means it listed none, so the
    /// vocabulary is unknown rather than empty: the app decides what it accepts,
    /// and this list is advisory, never a gate.
    #[serde(default)]
    pub declared_actions: Vec<String>,
    /// Where the app was presented before this request. A MiniApp already open
    /// in its own window is transferred into the tab the user is watching, and
    /// saying so is what keeps the move visible instead of surprising.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub presented_from: Option<String>,
    /// Which presentation the Agent is bound to. `Some("window")` means the app is
    /// running in its own installed window: that presentation can answer the
    /// declared agent bridge, but it cannot receive synthetic DOM input or pixels,
    /// so the two are not interchangeable and must never be reported as one.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub presentation: Option<String>,
}

/// The presentation kind of a MiniApp running in its own installed window.
pub const MINIAPP_WEB_WINDOW_PRESENTATION: &str = "window";

impl MiniAppWebSurfaceInfo {
    pub fn has_capability(&self, capability: MiniAppWebCapability) -> bool {
        self.capabilities
            .iter()
            .any(|value| value == capability.as_str())
    }

    pub fn has_bridge_capability(&self, capability: &str) -> bool {
        self.bridge_capabilities
            .iter()
            .any(|value| value == capability)
    }

    /// `true` when the Agent controls the MiniApp's own window instead of a tab it
    /// opened, which is what makes DOM and pixel actions unavailable.
    pub fn is_window_presentation(&self) -> bool {
        self.presentation.as_deref() == Some(MINIAPP_WEB_WINDOW_PRESENTATION)
    }

    /// A surface that hosts the app in its own window. It answers the declared
    /// agent bridge only, so it advertises no DOM, accessibility, or input
    /// capability and reports no frame size.
    pub fn window(app_id: String, instance_id: String, strict_runtime: bool) -> Self {
        Self {
            instance_id: Some(instance_id),
            app_id,
            strict_runtime,
            presentation: Some(MINIAPP_WEB_WINDOW_PRESENTATION.to_string()),
            ..Default::default()
        }
    }

    pub fn to_value(&self) -> Value {
        json!({
            "appId": self.app_id,
            "instanceId": self.instance_id,
            "strictRuntime": self.strict_runtime,
            "surface": {
                "kind": match self.is_window_presentation() {
                    true => MINIAPP_WEB_WINDOW_PRESENTATION,
                    false => "iframe",
                },
                "width": self.width,
                "height": self.height,
            },
            "capabilities": self.capabilities,
            "bridgeCapabilities": self.bridge_capabilities,
            "declaredActions": self.declared_actions,
            "presentedFrom": self.presented_from,
        })
    }
}

/// One installed MiniApp, projected for Agent discovery.
///
/// Discovery is deliberately app-neutral: it answers "which MiniApps exist and
/// how are they addressed", never "what is inside one".
#[derive(Clone, Debug, Default, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", default)]
pub struct MiniAppWebAppSummary {
    pub app_id: String,
    pub name: String,
    pub description: String,
    pub version: u32,
    pub updated_at: i64,
    /// The app runs in the strict (opaque-origin) profile, so only an app-declared
    /// bridge is observable; pixels and DOM are not readable.
    pub strict_runtime: bool,
}

impl MiniAppWebAppSummary {
    pub fn to_value(&self) -> Value {
        json!({
            "appId": self.app_id,
            "name": self.name,
            "description": self.description,
            "version": self.version,
            "updatedAt": self.updated_at,
            "strictRuntime": self.strict_runtime,
        })
    }

    #[cfg(test)]
    fn for_test(app_id: &str, name: &str) -> Self {
        Self {
            app_id: app_id.to_string(),
            name: name.to_string(),
            ..Default::default()
        }
    }
}

/// Outcome of resolving a requested app against the installed set.
#[derive(Clone, Debug, PartialEq, Eq)]
pub enum MiniAppWebAppMatch {
    /// Exactly one app matched.
    Single(String),
    /// Several apps matched; the caller reports candidates instead of guessing.
    Ambiguous(Vec<String>),
    /// Nothing matched.
    Missing,
}

/// Resolve a user-facing app reference into one installed app id.
///
/// Priority: exact id, then exact name (case-insensitive), then a name or id
/// substring that matches exactly one app. Anything looser risks driving the
/// wrong app, so ambiguity is reported rather than resolved.
pub fn match_installed_app(apps: &[MiniAppWebAppSummary], query: &str) -> MiniAppWebAppMatch {
    let query = query.trim();
    if query.is_empty() {
        return MiniAppWebAppMatch::Missing;
    }
    if let Some(app) = apps.iter().find(|app| app.app_id == query) {
        return MiniAppWebAppMatch::Single(app.app_id.clone());
    }

    let needle = query.to_lowercase();
    let mut exact = collect_app_ids(apps.iter().filter(|app| app.name.to_lowercase() == needle));
    if exact.len() == 1 {
        return MiniAppWebAppMatch::Single(exact.remove(0));
    }
    if exact.len() > 1 {
        return MiniAppWebAppMatch::Ambiguous(exact);
    }

    let partial = collect_app_ids(apps.iter().filter(|app| {
        app.name.to_lowercase().contains(&needle) || app.app_id.to_lowercase().contains(&needle)
    }));
    match partial.len() {
        0 => MiniAppWebAppMatch::Missing,
        1 => MiniAppWebAppMatch::Single(partial.into_iter().next().unwrap_or_default()),
        _ => MiniAppWebAppMatch::Ambiguous(partial),
    }
}

fn collect_app_ids<'a>(apps: impl Iterator<Item = &'a MiniAppWebAppSummary>) -> Vec<String> {
    let mut ids: Vec<String> = Vec::new();
    for app in apps {
        if !ids.contains(&app.app_id) {
            ids.push(app.app_id.clone());
        }
    }
    ids.sort();
    ids
}

/// A minted, short-lived element handle.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct MiniAppWebTarget {
    pub target_id: String,
    pub node_key: String,
    pub app_id: String,
    pub summary: String,
    pub generation: u64,
    pub minted_at_ms: u64,
}

/// Per-MiniApp target handles. Targets are bound to the app that minted them and
/// to one surface generation, so a reload invalidates every earlier handle
/// instead of silently acting on a lookalike node.
#[derive(Debug, Default)]
pub struct MiniAppWebTargetRegistry {
    targets: HashMap<String, MiniAppWebTarget>,
    next_id: u64,
    generation: u64,
}

impl MiniAppWebTargetRegistry {
    pub fn new() -> Self {
        Self {
            targets: HashMap::new(),
            next_id: 1,
            generation: 1,
        }
    }

    pub fn generation(&self) -> u64 {
        self.generation
    }

    /// A new document (reload, navigation, re-render) makes every earlier handle
    /// stale while keeping the session alive.
    pub fn invalidate(&mut self) {
        self.targets.clear();
        self.generation = self.generation.saturating_add(1);
    }

    pub fn len(&self) -> usize {
        self.targets.len()
    }

    pub fn is_empty(&self) -> bool {
        self.targets.is_empty()
    }

    pub fn mint(&mut self, app_id: &str, node_key: &str, summary: String, now_ms: u64) -> String {
        self.prune(now_ms);
        while self.targets.len() >= MINIAPP_WEB_MAX_TARGETS {
            let Some(oldest) = self
                .targets
                .values()
                .min_by_key(|target| target.minted_at_ms)
                .map(|target| target.target_id.clone())
            else {
                break;
            };
            self.targets.remove(&oldest);
        }
        let target_id = format!("target-{}", self.next_id);
        self.next_id = self.next_id.saturating_add(1);
        self.targets.insert(
            target_id.clone(),
            MiniAppWebTarget {
                target_id: target_id.clone(),
                node_key: node_key.to_string(),
                app_id: app_id.to_string(),
                summary,
                generation: self.generation,
                minted_at_ms: now_ms,
            },
        );
        target_id
    }

    /// Resolve a handle for one app. Unknown ids, expired handles, and handles
    /// minted by another MiniApp all fail with a typed error.
    pub fn resolve(
        &mut self,
        app_id: &str,
        target_id: &str,
        now_ms: u64,
    ) -> Result<MiniAppWebTarget, MiniAppWebErrorCode> {
        self.prune(now_ms);
        let target = self
            .targets
            .get(target_id)
            .ok_or(MiniAppWebErrorCode::UnknownTarget)?;
        if target.app_id != app_id || target.generation != self.generation {
            return Err(MiniAppWebErrorCode::StaleTarget);
        }
        Ok(target.clone())
    }

    fn prune(&mut self, now_ms: u64) {
        self.targets.retain(|_, target| {
            now_ms.saturating_sub(target.minted_at_ms) < MINIAPP_WEB_TARGET_TTL_MS
        });
    }
}

/// Reject oversized bridge payloads before they reach the MiniApp frame.
pub fn validate_bridge_payload_size(payload: &Value) -> Result<(), MiniAppWebErrorCode> {
    let size = payload.to_string().len();
    if size > MINIAPP_WEB_MAX_BRIDGE_BYTES {
        return Err(MiniAppWebErrorCode::InvalidParams);
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    fn node(key: &str) -> MiniAppWebNode {
        MiniAppWebNode {
            node_key: Some(key.to_string()),
            role: Some("button".to_string()),
            name: Some("Start".to_string()),
            tag: Some("button".to_string()),
            ..Default::default()
        }
    }

    #[test]
    fn locator_sanitize_drops_blank_axes_and_keeps_priority() {
        let locator = MiniAppWebLocator {
            test_id: Some("  start-button  ".to_string()),
            role: Some(" BUTTON ".to_string()),
            name: Some("   ".to_string()),
            text: None,
            selector: None,
            exact: None,
        }
        .sanitized();

        assert_eq!(locator.test_id.as_deref(), Some("start-button"));
        assert_eq!(locator.role.as_deref(), Some("button"));
        assert_eq!(locator.name, None);
        assert_eq!(locator.active_axes(), vec!["testId", "roleName"]);
        assert!(!locator.is_selector_fallback());
    }

    #[test]
    fn selector_only_locator_is_a_warned_fallback() {
        let locator = MiniAppWebLocator {
            selector: Some("#start".to_string()),
            ..Default::default()
        };
        assert!(locator.is_selector_fallback());
        assert_eq!(locator.active_axes(), vec!["selector"]);
        assert!(MiniAppWebLocator::default().is_empty());
    }

    #[test]
    fn targets_are_bound_to_one_app_and_generation() {
        let mut registry = MiniAppWebTargetRegistry::new();
        let target_id = registry.mint("demo", "n1", "target-1 button".to_string(), 1_000);
        assert_eq!(target_id, "target-1");
        assert!(registry.resolve("demo", &target_id, 1_100).is_ok());
        assert_eq!(
            registry.resolve("other", &target_id, 1_100),
            Err(MiniAppWebErrorCode::StaleTarget)
        );

        registry.invalidate();
        assert_eq!(
            registry.resolve("demo", &target_id, 1_200),
            Err(MiniAppWebErrorCode::UnknownTarget)
        );
        assert_eq!(
            registry.resolve("demo", "target-999", 1_200),
            Err(MiniAppWebErrorCode::UnknownTarget)
        );
    }

    #[test]
    fn capture_payload_rejects_unknown_types_and_oversized_frames() {
        let capture = MiniAppWebCapture::parse(&json!({
            "mimeType": "IMAGE/PNG",
            "dataBase64": "iVBORw0KGgo=",
            "width": 900,
            "height": 700,
            "source": "canvas",
            "label": "#game",
        }))
        .expect("valid capture");
        assert_eq!(capture.mime_type, "image/png");
        assert_eq!(capture.label.as_deref(), Some("#game"));
        assert_eq!(capture.decoded_len(), 9);

        assert_eq!(
            MiniAppWebCapture::parse(&json!({
                "mimeType": "image/svg+xml",
                "dataBase64": "abc",
            })),
            Err(MiniAppWebErrorCode::CapabilityMissing)
        );
        assert_eq!(
            MiniAppWebCapture::parse(&json!({ "mimeType": "image/png", "dataBase64": "   " })),
            Err(MiniAppWebErrorCode::CapabilityMissing)
        );
        let oversized = "A".repeat(MINIAPP_WEB_MAX_CAPTURE_BYTES / 3 * 4 + 8);
        assert_eq!(
            MiniAppWebCapture::parse(&json!({
                "mimeType": "image/jpeg",
                "dataBase64": oversized,
            })),
            Err(MiniAppWebErrorCode::HostError)
        );
        // A real frame never exceeds the published edge bound.
        let clamped = MiniAppWebCapture::parse(&json!({
            "mimeType": "image/png",
            "dataBase64": "iVBORw0KGgo=",
            "width": 99_999,
            "height": 99_999,
        }))
        .expect("clamped capture");
        assert_eq!(clamped.width, MINIAPP_WEB_MAX_CAPTURE_EDGE);
        assert_eq!(clamped.height, MINIAPP_WEB_MAX_CAPTURE_EDGE);
    }

    #[test]
    fn app_reference_resolves_by_id_then_exact_name_then_unique_substring() {
        let apps = [
            MiniAppWebAppSummary::for_test("7d27c9c1", "雷霆战机"),
            MiniAppWebAppSummary::for_test("notes", "Notes"),
            MiniAppWebAppSummary::for_test("todo", "Todo list"),
            MiniAppWebAppSummary::for_test("todo-pro", "Todo list pro"),
        ];

        assert_eq!(
            match_installed_app(&apps, "7d27c9c1"),
            MiniAppWebAppMatch::Single("7d27c9c1".to_string())
        );
        assert_eq!(
            match_installed_app(&apps, " 雷霆战机 "),
            MiniAppWebAppMatch::Single("7d27c9c1".to_string())
        );
        // Case-insensitive exact names still win over substring matches.
        assert_eq!(
            match_installed_app(&apps, "notes"),
            MiniAppWebAppMatch::Single("notes".to_string())
        );
        // An exact id is never widened by a namesake.
        assert_eq!(
            match_installed_app(&apps, "todo"),
            MiniAppWebAppMatch::Single("todo".to_string())
        );
        // A substring that hits two apps is reported, never guessed.
        assert_eq!(
            match_installed_app(&apps, "tod"),
            MiniAppWebAppMatch::Ambiguous(vec!["todo".to_string(), "todo-pro".to_string()])
        );
        assert_eq!(
            match_installed_app(&apps, "Todo list pro"),
            MiniAppWebAppMatch::Single("todo-pro".to_string())
        );
        assert_eq!(
            match_installed_app(&apps, "chess"),
            MiniAppWebAppMatch::Missing
        );
        assert_eq!(
            match_installed_app(&apps, "   "),
            MiniAppWebAppMatch::Missing
        );
    }

    #[test]
    fn app_summary_carries_no_host_paths() {
        let summary = MiniAppWebAppSummary {
            app_id: "demo".to_string(),
            name: "Demo".to_string(),
            description: "A demo app".to_string(),
            version: 3,
            updated_at: 42,
            strict_runtime: true,
        };
        let value = summary.to_value();
        assert_eq!(value["appId"], "demo");
        assert_eq!(value["strictRuntime"], true);
        let rendered = value.to_string();
        assert!(!rendered.contains('/'), "discovery must not leak paths");
    }

    #[test]
    fn targets_expire_and_stay_bounded() {
        let mut registry = MiniAppWebTargetRegistry::new();
        let target_id = registry.mint("demo", "n1", "node".to_string(), 0);
        assert_eq!(
            registry.resolve("demo", &target_id, MINIAPP_WEB_TARGET_TTL_MS),
            Err(MiniAppWebErrorCode::UnknownTarget)
        );

        for index in 0..(MINIAPP_WEB_MAX_TARGETS + 5) {
            registry.mint(
                "demo",
                &format!("n{index}"),
                "node".to_string(),
                1_000 + index as u64,
            );
        }
        assert_eq!(registry.len(), MINIAPP_WEB_MAX_TARGETS);
    }

    #[test]
    fn tree_sanitize_removes_host_keys_and_caps_nodes() {
        let nodes = vec![MiniAppWebNode {
            node_key: Some("root".to_string()),
            role: Some("main".to_string()),
            children: (0..MINIAPP_WEB_MAX_NODES)
                .map(|index| node(&format!("n{index}")))
                .collect(),
            ..Default::default()
        }];
        let (tree, truncated) = MiniAppWebNode::sanitize_tree(nodes);
        assert!(truncated);
        assert_eq!(tree.len(), 1);
        assert!(tree[0].children.len() < MINIAPP_WEB_MAX_NODES);
        assert_eq!(tree[0].children[0].node_key.as_deref(), Some("n0"));
    }

    #[test]
    fn tree_sanitize_stops_at_max_depth() {
        let mut deep = node("leaf");
        for index in 0..(MINIAPP_WEB_MAX_DEPTH + 4) {
            deep = MiniAppWebNode {
                node_key: Some(format!("d{index}")),
                children: vec![deep],
                ..Default::default()
            };
        }
        let (tree, truncated) = MiniAppWebNode::sanitize_tree(vec![deep]);
        assert!(truncated);
        let mut depth = 0;
        let mut cursor = tree.first();
        while let Some(current) = cursor {
            depth += 1;
            cursor = current.children.first();
        }
        assert_eq!(depth, MINIAPP_WEB_MAX_DEPTH);
    }

    #[test]
    fn node_summary_is_compact_and_marks_state() {
        let summary = MiniAppWebNode {
            enabled: Some(false),
            checked: Some(true),
            value: Some("abc".to_string()),
            ..node("n1")
        }
        .summary_line("target-7");
        assert!(summary.starts_with("target-7 button \"Start\""));
        assert!(summary.contains("[disabled]"));
        assert!(summary.contains("[checked]"));
        assert!(summary.contains("value=\"abc\""));
    }

    #[test]
    fn bridge_payload_limit_counts_serialized_utf8_bytes() {
        let at_limit = json!("x".repeat(MINIAPP_WEB_MAX_BRIDGE_BYTES - 2));
        assert_eq!(validate_bridge_payload_size(&at_limit), Ok(()));
        let over_limit = json!("x".repeat(MINIAPP_WEB_MAX_BRIDGE_BYTES - 1));
        assert_eq!(
            validate_bridge_payload_size(&over_limit),
            Err(MiniAppWebErrorCode::InvalidParams)
        );
        let multibyte = json!("界".repeat(MINIAPP_WEB_MAX_BRIDGE_BYTES / 3 + 1));
        assert_eq!(
            validate_bridge_payload_size(&multibyte),
            Err(MiniAppWebErrorCode::InvalidParams)
        );
    }

    #[test]
    fn surface_info_reports_capabilities_from_the_host() {
        let info = MiniAppWebSurfaceInfo {
            app_id: "demo".to_string(),
            capabilities: vec!["dom".to_string(), "input".to_string()],
            bridge_capabilities: vec!["observe".to_string()],
            ..Default::default()
        };
        assert!(info.has_capability(MiniAppWebCapability::Dom));
        assert!(!info.has_capability(MiniAppWebCapability::Accessibility));
        assert!(info.has_bridge_capability("observe"));
        assert!(!info.has_bridge_capability("act"));
        assert!(!info.has_capability(MiniAppWebCapability::ElementPositionClick));
        assert_eq!(info.to_value()["surface"]["kind"], "iframe");
    }

    #[test]
    fn positioned_click_capability_is_opt_in_and_survives_old_payload_round_trips() {
        let legacy = json!({ "appId": "demo", "capabilities": ["dom", "input"] });
        let old: MiniAppWebSurfaceInfo = serde_json::from_value(legacy).unwrap();
        assert!(!old.has_capability(MiniAppWebCapability::ElementPositionClick));
        let old_round_trip: MiniAppWebSurfaceInfo =
            serde_json::from_value(serde_json::to_value(old).unwrap()).unwrap();
        assert!(!old_round_trip.has_capability(MiniAppWebCapability::ElementPositionClick));
        let payload = json!({ "appId": "demo", "capabilities": ["dom", "input", "element-position-click-v1", "future-capability"] });
        let current: MiniAppWebSurfaceInfo = serde_json::from_value(payload).unwrap();
        assert!(current.has_capability(MiniAppWebCapability::ElementPositionClick));
        let round_trip: MiniAppWebSurfaceInfo =
            serde_json::from_value(serde_json::to_value(current).unwrap()).unwrap();
        assert_eq!(
            round_trip.capabilities,
            vec![
                "dom",
                "input",
                "element-position-click-v1",
                "future-capability"
            ]
        );
    }

    #[test]
    fn a_window_presentation_is_reported_as_a_different_surface() {
        let window = MiniAppWebSurfaceInfo {
            app_id: "demo".to_string(),
            instance_id: Some("instance-1".to_string()),
            presentation: Some("window".to_string()),
            ..Default::default()
        };
        assert!(window.is_window_presentation());
        let value = window.to_value();
        assert_eq!(value["surface"]["kind"], "window");
        // A window answers only its own bridge, so it advertises no DOM capability.
        assert_eq!(value["capabilities"].as_array().map(Vec::len), Some(0));
    }

    #[test]
    fn surfaces_written_before_presentations_existed_still_deserialize() {
        // Older hosts answered `open` without the field, and an older peer may
        // still send exactly this payload.
        let legacy = json!({
            "appId": "demo",
            "instanceId": "instance-1",
            "strictRuntime": true,
            "capabilities": ["dom"],
            "bridgeCapabilities": [],
        });
        let info: MiniAppWebSurfaceInfo =
            serde_json::from_value(legacy).expect("legacy surface payload");
        assert_eq!(info.presentation, None);
        assert!(!info.is_window_presentation());
        assert_eq!(info.to_value()["surface"]["kind"], "iframe");
        // The field is omitted when a surface never carried one, so an old reader
        // sees the same object it always did.
        let serialized = serde_json::to_value(&info).expect("reserialized surface");
        assert!(serialized.get("presentation").is_none());
    }
}
