//! Computer Use tool contracts and provider-neutral payload helpers.
//!
//! Concrete desktop automation remains in host implementations. This module owns
//! the DTOs, input parsing, and result payload shape shared by those hosts and
//! the agent-facing Computer Use tool.

use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
use std::fmt;

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct ComputerUseContractError {
    message: String,
}

impl ComputerUseContractError {
    pub fn tool(message: impl Into<String>) -> Self {
        Self {
            message: message.into(),
        }
    }

    pub fn message(&self) -> &str {
        &self.message
    }
}

impl fmt::Display for ComputerUseContractError {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        f.write_str(&self.message)
    }
}

impl std::error::Error for ComputerUseContractError {}

pub type ComputerUseContractResult<T> = Result<T, ComputerUseContractError>;

/// Center of a **point crop** in **full-display native capture pixels** (same origin as full-screen computer-use JPEG pixels).
#[derive(Debug, Clone, Copy, Serialize, Deserialize, PartialEq, Eq)]
pub struct ScreenshotCropCenter {
    pub x: u32,
    pub y: u32,
}

/// Native-pixel rectangle on the **captured display bitmap** (0..`native_width`, 0..`native_height`).
#[derive(Debug, Clone, Copy, Serialize, Deserialize, PartialEq, Eq)]
pub struct ComputerUseNavigationRect {
    pub x0: u32,
    pub y0: u32,
    pub width: u32,
    pub height: u32,
}

/// Subdivide the current navigation view into four tiles (model picks one per `screenshot` step).
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum ComputerUseNavigateQuadrant {
    TopLeft,
    TopRight,
    BottomLeft,
    BottomRight,
}

/// Center for host-applied **implicit** 500×500 confirmation crops (when a fresh screenshot is required).
#[derive(Debug, Clone, Copy, Default, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum ComputerUseImplicitScreenshotCenter {
    #[default]
    Mouse,
    /// Best-effort focused text field / insertion area (macOS AX); other platforms fall back to mouse.
    TextCaret,
}

/// Parameters for `ComputerUseHost::screenshot_display`.
#[derive(Debug, Clone, Copy, Default, PartialEq, Eq)]
pub struct ComputerUseScreenshotParams {
    pub crop_center: Option<ScreenshotCropCenter>,
    pub navigate_quadrant: Option<ComputerUseNavigateQuadrant>,
    /// Clear stored navigation focus before applying this capture (next quadrant step starts from full display).
    pub reset_navigation: bool,
    /// Half-size of the point crop in **native** pixels (total width/height ≈ `2 * half`). `None` → [`COMPUTER_USE_POINT_CROP_HALF_DEFAULT`].
    pub point_crop_half_extent_native: Option<u32>,
    /// For `action: screenshot`: when the host applies an implicit 500×500 crop, use mouse vs text-focus center (see desktop host).
    pub implicit_confirmation_center: Option<ComputerUseImplicitScreenshotCenter>,
    /// For `action: screenshot`: crop the capture to the **focused window of
    /// the foreground application** instead of the default mouse-centered
    /// 500×500 region. The single most useful setting after `system.open_app`,
    /// `cmd+f`, or any keystroke that may have moved focus inside an app
    /// without moving the mouse — the model gets the WHOLE application
    /// window in one shot rather than a stale 500×500 around an unrelated
    /// pointer position. Falls back to a full-display capture (with a
    /// `warning`) when the host cannot resolve the focused window (e.g.
    /// missing AX permission or the app exposes no AX windows).
    pub crop_to_focused_window: bool,
}

/// Longest side of the navigation region must be **strictly below** this to allow `click` without a separate point crop (desktop).
pub const COMPUTER_USE_QUADRANT_CLICK_READY_MAX_LONG_EDGE: u32 = 500;

/// Native pixels added on **each** side after a quadrant choice before compositing the JPEG (avoids controls sitting exactly on the split line).
pub const COMPUTER_USE_QUADRANT_EDGE_EXPAND_PX: u32 = 50;

/// Default **half** extent (native px) for point crop around `screenshot_crop_center_*` → total region up to **500×500**.
pub const COMPUTER_USE_POINT_CROP_HALF_DEFAULT: u32 = 250;

/// Minimum **half** extent for point crop (native px) — total region **≥ 128×128** when the display is large enough.
pub const COMPUTER_USE_POINT_CROP_HALF_MIN: u32 = 64;

/// Maximum **half** extent for point crop (native px). Historically capped at
/// 250 (= 500×500) to keep the "implicit confirmation" crop tight, but that
/// crop mode has been removed. The only consumer left is the focused-window
/// crop path, which legitimately needs to cover the entire window — anywhere
/// up to the full display in either dimension. Set high enough that
/// `screenshot_display`'s own per-display clamp is the effective ceiling.
pub const COMPUTER_USE_POINT_CROP_HALF_MAX: u32 = 16384;

/// Clamp optional model/host request to a valid point-crop half extent.
#[inline]
pub fn clamp_point_crop_half_extent(requested: Option<u32>) -> u32 {
    let v = requested.unwrap_or(COMPUTER_USE_POINT_CROP_HALF_DEFAULT);
    v.clamp(
        COMPUTER_USE_POINT_CROP_HALF_MIN,
        COMPUTER_USE_POINT_CROP_HALF_MAX,
    )
}

/// Suggest a tighter half-extent from AX **native** bounds size (smaller controls → smaller JPEG).
#[inline]
pub fn suggested_point_crop_half_extent_from_native_bounds(native_w: u32, native_h: u32) -> u32 {
    let max_edge = native_w.max(native_h).max(1);
    let half = max_edge.saturating_div(2).saturating_add(32);
    clamp_point_crop_half_extent(Some(half))
}

/// Snapshot of OS permissions relevant to computer use.
#[derive(Debug, Clone, Serialize, Deserialize, Default, PartialEq, Eq)]
pub struct ComputerUsePermissionSnapshot {
    pub accessibility_granted: bool,
    pub screen_capture_granted: bool,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub platform_note: Option<String>,
}

/// Frontmost application (for Computer use tool JSON).
#[derive(Debug, Clone, Serialize, Deserialize, Default, PartialEq, Eq)]
pub struct ComputerUseForegroundApplication {
    /// Human-readable label for the frontmost app. On Windows this is the
    /// window *title*, so it carries page/document text and must never be
    /// pattern-matched to identify the application itself.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub name: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub bundle_id: Option<String>,
    /// Executable basename (Windows) or process name (macOS) of the frontmost
    /// app — the only stable identity signal across platforms.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub process_name: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub process_id: Option<i32>,
}

/// Mouse cursor position in **global** screen space (host native units, e.g. macOS Quartz points).
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
pub struct ComputerUsePointerGlobal {
    pub x: f64,
    pub y: f64,
}

/// Foreground app + pointer position after a Computer use action (best-effort per platform).
#[derive(Debug, Clone, Serialize, Deserialize, Default, PartialEq)]
pub struct ComputerUseSessionSnapshot {
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub foreground_application: Option<ComputerUseForegroundApplication>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub pointer_global: Option<ComputerUsePointerGlobal>,
}

/// Pixel rectangle of the **screen capture** in JPEG image coordinates (offset is zero when there is no frame padding).
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
pub struct ComputerUseImageContentRect {
    pub left: u32,
    pub top: u32,
    pub width: u32,
    pub height: u32,
}

/// Approximate global screen rectangle covered by the screenshot image. Values
/// are in the same coordinate space as `ClickTarget::ScreenXy`.
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
pub struct ComputerUseImageGlobalBounds {
    pub left: f64,
    pub top: f64,
    pub width: f64,
    pub height: f64,
}

/// A rectangle of an earlier observation to capture again at higher detail,
/// in that screenshot's image pixels. The zoomed image is an observation of
/// the same bound window with its own screenshot_id and coordinate mapping.
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(deny_unknown_fields)]
pub struct ComputerUseZoomRegion {
    pub screenshot_id: String,
    pub x: u32,
    pub y: u32,
    pub width: u32,
    pub height: u32,
}

/// Screenshot payload for the model and for pointer coordinate mapping.
/// The `ComputerUse` tool embeds these fields in tool-result JSON and adds **`hierarchical_navigation`**
/// (`full_display` vs `region_crop`, plus **`shortcut_policy`**).
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
pub struct ComputerScreenshot {
    /// Recency of a retained native frame. Missing on older/other providers;
    /// a reused frame is not evidence that the latest input was processed.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub capture_frame: Option<CaptureFrameInfo>,
    /// Stable id for this exact screenshot coordinate basis. Follow-up
    /// `ClickTarget::ImageXy` / `ImageGrid` calls should pass this id so the
    /// host maps image pixels against the same frame the model saw.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub screenshot_id: Option<String>,
    pub bytes: Vec<u8>,
    pub mime_type: String,
    /// Dimensions of the image attached for the model (may be downscaled).
    pub image_width: u32,
    pub image_height: u32,
    /// Native capture dimensions for this display (before downscale).
    pub native_width: u32,
    pub native_height: u32,
    /// Top-left of this display in global screen space (for multi-monitor).
    pub display_origin_x: i32,
    pub display_origin_y: i32,
    /// Shrink factor for vision image vs native capture (Anthropic-style long-edge + megapixel cap).
    pub vision_scale: f64,
    /// When set, the **tip** of the drawn pointer overlay was placed at this pixel in the JPEG (`image_width` x `image_height`).
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub pointer_image_x: Option<i32>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub pointer_image_y: Option<i32>,
    /// When set, this JPEG is a crop around this center in **full-display native** pixels (see tool docs).
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub screenshot_crop_center: Option<ScreenshotCropCenter>,
    /// Half extent used for this point crop (native px); omitted when not a point crop.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub point_crop_half_extent_native: Option<u32>,
    /// Native rectangle corresponding to this JPEG’s content (full display, quadrant drill region, or point-crop bounds).
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub navigation_native_rect: Option<ComputerUseNavigationRect>,
    /// When true (desktop), `click` is allowed on this frame without an extra ~500×500 point crop — region is small enough for pointer positioning + `click`.
    #[serde(default, skip_serializing_if = "is_false")]
    pub quadrant_navigation_click_ready: bool,
    /// Screen capture rectangle in JPEG pixel coordinates (offset zero when there is no frame padding); the host maps this rect to the display.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub image_content_rect: Option<ComputerUseImageContentRect>,
    /// Approximate global screen rectangle represented by the screenshot. Use
    /// `ClickTarget::ImageXy` when clicking from the attached image; this field
    /// is a human/model hint and the host uses its precise internal map.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub image_global_bounds: Option<ComputerUseImageGlobalBounds>,
    /// Condensed text representation of the UI tree, focusing on interactive elements (inspired by TuriX-CUA).
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub ui_tree_text: Option<String>,
    /// Desktop: this JPEG was produced by implicit 500×500 confirmation crop (mouse or text focus center).
    #[serde(default, skip_serializing_if = "is_false")]
    pub implicit_confirmation_crop_applied: bool,
    /// Same-process menus, popups and suggestion lists above the captured
    /// window, front to back. Composited ones are drawn into this image.
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub auxiliary_windows: Vec<ComputerUseAuxiliaryWindow>,
}

/// A transient window owned by the captured application that covers part of
/// its window (menu, popup, dropdown, tooltip). Pointer input inside its
/// `image_rect` is delivered to this window, as a physical click would be.
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
pub struct ComputerUseAuxiliaryWindow {
    pub window_id: u64,
    /// Visible part of the window in this image's pixel coordinates.
    pub image_rect: ComputerUseImageContentRect,
    /// Full global frame, which may extend beyond the captured window.
    pub global_bounds: ComputerUseImageGlobalBounds,
    /// Whether its pixels are drawn into the attached image.
    pub composited: bool,
    /// Whether part of the window lies outside the captured window's image.
    #[serde(default, skip_serializing_if = "is_false")]
    pub clipped: bool,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub layer: Option<i32>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub title: Option<String>,
    /// Why the pixels are missing when `composited` is false.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub unavailable_reason: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
pub struct CaptureFrameInfo {
    pub age_ms: u64,
    pub reused: bool,
}

fn is_false(b: &bool) -> bool {
    !*b
}

/// Optional **global native** rectangle (same space as pointer / `display_origin` + capture) to limit
/// OCR to a screen region (e.g. one app window) and avoid matching text in other windows.
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
pub struct OcrRegionNative {
    pub x0: i32,
    pub y0: i32,
    pub width: u32,
    pub height: u32,
}

/// A single OCR text match with global display coordinates.
/// Returned by `ComputerUseHost::ocr_find_text_matches`.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct OcrTextMatch {
    pub text: String,
    pub confidence: f32,
    pub center_x: f64,
    pub center_y: f64,
    pub bounds_left: f64,
    pub bounds_top: f64,
    pub bounds_width: f64,
    pub bounds_height: f64,
}

/// Filter for native accessibility (macOS AX) BFS search — role/title/identifier substrings.
#[derive(Debug, Clone, Serialize, Deserialize, Default)]
pub struct UiElementLocateQuery {
    #[serde(default)]
    pub title_contains: Option<String>,
    /// **Wide** text needle: matched against `title | value | description | help` of each AX node
    /// (case-insensitive substring). Use this when the on-screen visible text is not in `AXTitle`
    /// (e.g. a card whose label sits in `AXValue` of a child `AXStaticText`, or a button labelled
    /// only via `AXDescription`). Independent of `title_contains` — both can be supplied and
    /// `filter_combine` controls the boolean.
    #[serde(default)]
    pub text_contains: Option<String>,
    #[serde(default)]
    pub role_substring: Option<String>,
    #[serde(default)]
    pub identifier_contains: Option<String>,
    /// BFS depth from the application root (default 48, max 200).
    #[serde(default)]
    pub max_depth: Option<u32>,
    /// `"all"` (default): every non-empty filter must match the **same** element (AND).
    /// `"any"`: at least one non-empty filter matches (OR) — useful when title and role are not both present on one node (e.g. search field with empty AXTitle).
    #[serde(default)]
    pub filter_combine: Option<String>,
    /// Direct AX-node-index pin from the most recent `get_app_state` snapshot for the same
    /// application. When present the host SHORT-CIRCUITS BFS and resolves the node from its
    /// per-pid cache. Always preferred over text/role filters when an `AppStateSnapshot` is
    /// available — guarantees the exact node the model already saw, not a re-ranked guess.
    #[serde(default)]
    pub node_idx: Option<u32>,
    /// Optional digest from the same `AppStateSnapshot` that produced `node_idx`. When set the
    /// host returns `AX_IDX_STALE` if the cached snapshot has rotated. Omit for a "loose" lookup.
    #[serde(default)]
    pub app_state_digest: Option<String>,
}

/// Matched element geometry from the accessibility tree: center plus **axis-aligned bounds** (four corners).
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct UiElementLocateResult {
    /// Same space as `ComputerUse` `use_screen_coordinates` / host pointer moves.
    pub global_center_x: f64,
    pub global_center_y: f64,
    /// Use with `ComputerUse` `screenshot_crop_center_x` / `y` (full-capture native indices).
    pub native_center_x: u32,
    pub native_center_y: u32,
    /// Element frame in **global** pointer space: top-left `(left, top)`, size `(width, height)`.
    /// Four corners: `(left, top)`, `(left+width, top)`, `(left, top+height)`, `(left+width, top+height)`.
    pub global_bounds_left: f64,
    pub global_bounds_top: f64,
    pub global_bounds_width: f64,
    pub global_bounds_height: f64,
    /// Tight **native** pixel bounds on the capture bitmap (full-display indices), derived from the global frame
    /// (mapping uses the display that contains the center; large spans may be approximate).
    pub native_bounds_min_x: u32,
    pub native_bounds_min_y: u32,
    pub native_bounds_max_x: u32,
    pub native_bounds_max_y: u32,
    pub matched_role: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub matched_title: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub matched_identifier: Option<String>,
    /// Parent element role + title for disambiguation (e.g. "AXWindow: Settings").
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub parent_context: Option<String>,
    /// Total number of elements that matched the query (before ranking).
    /// If > 1, the model should consider whether this is the right one.
    #[serde(default)]
    pub total_matches: u32,
    /// Brief descriptions of other matches (up to 4) for disambiguation.
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub other_matches: Vec<String>,
    /// AX-tree node index of the matched element when resolvable from the most recent
    /// `get_app_state` cache (e.g. macOS). Pass back as `node_idx` for the cheapest possible
    /// follow-up `click_element` / `locate` call.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub matched_node_idx: Option<u32>,
    /// Which filter type produced the match: one of `"node_idx" | "text_contains" |
    /// "title_contains" | "role_substring" | "identifier_contains" | "climbed"`.
    /// `"climbed"` indicates a static-text leaf was promoted to its nearest clickable ancestor.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub matched_via: Option<String>,
}

/// Hit-tested accessibility node at a global screen point (OCR disambiguation).
#[derive(Debug, Clone, Serialize, Deserialize, Default, PartialEq, Eq)]
pub struct OcrAccessibilityHit {
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub role: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub title: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub identifier: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub parent_context: Option<String>,
    /// One-line summary for the model (role, title, parent).
    pub description: String,
}

// =====================================================================
// Codex-style AX-first data types (Phase 1: surface-only definitions).
// =====================================================================

/// Identifies a target application for the Codex-style `app_*` actions.
/// At least one of `name` / `bundle_id` / `pid` must be set; hosts pick
/// the most specific available (pid > bundle_id > name).
#[derive(Debug, Clone, Default, Serialize, Deserialize, PartialEq, Eq)]
pub struct AppSelector {
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub name: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub bundle_id: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub pid: Option<i32>,
    /// Exact native window from `list_windows`. Requires its owning PID and a
    /// host advertising `window-target-v1`; never silently ignore this field.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub window_id: Option<u64>,
}

impl AppSelector {
    /// Convenience: select by name only (e.g. `"Safari"`).
    pub fn by_name(name: impl Into<String>) -> Self {
        Self {
            name: Some(name.into()),
            bundle_id: None,
            pid: None,
            window_id: None,
        }
    }

    /// Convenience: select by pid only.
    pub fn by_pid(pid: i32) -> Self {
        Self {
            name: None,
            bundle_id: None,
            pid: Some(pid),
            window_id: None,
        }
    }

    /// Convenience: select by bundle id (macOS).
    pub fn by_bundle_id(bundle_id: impl Into<String>) -> Self {
        Self {
            name: None,
            bundle_id: Some(bundle_id.into()),
            pid: None,
            window_id: None,
        }
    }

    /// True when no selector field is populated.
    pub fn is_empty(&self) -> bool {
        self.name.is_none()
            && self.bundle_id.is_none()
            && self.pid.is_none()
            && self.window_id.is_none()
    }

    pub fn validate_window_target(&self) -> Result<(), &'static str> {
        if self.window_id.is_some()
            && (self.window_id == Some(0) || self.pid.is_none_or(|pid| pid <= 0))
        {
            return Err("[INVALID_PARAMS] window_id requires a positive owning pid and a positive window_id from list_windows");
        }
        Ok(())
    }
}

/// Read-only native window discovery, independent of AX content and of the
/// application launcher's identity. Discovery does not select or activate it.
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
pub struct AppWindowInfo {
    pub pid: i32,
    pub window_id: u64,
    pub application: String,
    pub title: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub bundle_id: Option<String>,
    /// Native visibility fact, not a guarantee that capture or input works.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub is_on_screen: Option<bool>,
    /// Global window frame in the host's input coordinate space, so a tiny
    /// system badge is distinguishable from an application's content window.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub bounds: Option<ComputerUseImageGlobalBounds>,
}

impl AppWindowInfo {
    /// Present visible, titled and larger windows first. Inventory order is
    /// otherwise preserved, so this never hides or drops a window.
    pub fn sort_for_discovery(windows: &mut [AppWindowInfo]) {
        windows.sort_by_key(|window| {
            let area = window
                .bounds
                .as_ref()
                .map(|bounds| (bounds.width.max(0.0) * bounds.height.max(0.0)) as u64)
                .unwrap_or(0);
            (
                window.is_on_screen != Some(true),
                window.title.trim().is_empty(),
                std::cmp::Reverse(area),
            )
        });
    }

    /// Case-insensitive substring match on the application name, bundle
    /// identifier or title, so one query reaches an app's helper processes.
    pub fn matches_query(&self, query: &str) -> bool {
        let query = query.trim().to_lowercase();
        !query.is_empty()
            && [
                Some(self.application.as_str()),
                self.bundle_id.as_deref(),
                Some(self.title.as_str()),
            ]
            .into_iter()
            .flatten()
            .any(|field| field.to_lowercase().contains(&query))
    }
}

/// One running application, returned by `ComputerUseHost::list_apps`.
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
pub struct AppInfo {
    pub name: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub bundle_id: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub pid: Option<i32>,
    /// Whether the application currently has at least one running process.
    pub running: bool,
    /// Unix-epoch milliseconds of last user activation, when the host can
    /// resolve it from LaunchServices / equivalent. Used for ordering.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub last_used_ms: Option<i64>,
    /// Cumulative launch count, when the host can resolve it.
    #[serde(default)]
    pub launch_count: u64,
}

/// One node of a Codex-style accessibility tree.
///
/// Indices are dense and stable **within a single
/// [`AppStateSnapshot`]** — they are only valid until the next
/// `get_app_state` / `app_*` call, after which the host re-dumps the tree
/// and assigns fresh indices. Callers that need to chain mutations should
/// use the snapshot returned from the previous mutation as the new
/// addressing basis.
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
pub struct AxNode {
    /// Stable index inside this snapshot. Zero is the application root.
    pub idx: u32,
    /// Parent index, `None` for the root.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub parent_idx: Option<u32>,
    /// Native role string (e.g. macOS AX `AXButton`).
    pub role: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub title: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub value: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub description: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub identifier: Option<String>,
    pub enabled: bool,
    pub focused: bool,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub selected: Option<bool>,
    /// Frame in **global** pointer space: `(x, y, width, height)`. `None`
    /// when the AX backend cannot resolve the position.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub frame_global: Option<(f64, f64, f64, f64)>,
    /// Names of supported AX actions (e.g. `kAXPress`, `kAXShowMenu`).
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub actions: Vec<String>,
    /// Localized role description (`AXRoleDescription` on macOS), e.g.
    /// "standard window", "close button", "scroll area", "HTML content",
    /// "tab group". Codex-style renderers prefer this over [`Self::role`]
    /// because it matches what a sighted user would call the element.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub role_description: Option<String>,
    /// Native AX subrole (e.g. `AXCloseButton`, `AXFullScreenButton`,
    /// `AXMinimizeButton`, `AXSecureTextField`). Useful for button
    /// disambiguation when `role` is generic.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub subrole: Option<String>,
    /// `AXHelp` / tooltip text — frequently the only place an icon-only
    /// button explains itself.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub help: Option<String>,
    /// `AXURL` for `AXWebArea` / "HTML content" nodes (e.g. Tauri
    /// `tauri://localhost`, Electron `file://…`, Safari pages).
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub url: Option<String>,
    /// `AXExpanded` for disclosure controls / collapsible sidebars.
    /// `Some(true)` = expanded, `Some(false)` = collapsed, `None` =
    /// attribute not exposed by the element.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub expanded: Option<bool>,
}

/// One keyboard shortcut extracted from a target application's menu
/// structure. Returned by `ComputerUseHost::get_app_shortcuts` — this is
/// the **read** counterpart to `ComputerUseHost::key_chord` /
/// `app_key_chord` (which only **send** keys); this DTO reports what the
/// app itself has registered.
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
pub struct AppMenuShortcut {
    /// Full breadcrumb from the top-level menu to this item, e.g.
    /// `["File", "Save"]` or `["File", "Export As...", "PDF"]`.
    pub menu_path: Vec<String>,
    /// Menu item title (same as `menu_path.last()`).
    pub title: String,
    /// Human-readable rendering of the shortcut, e.g. `"⌘S"` (macOS) or
    /// `"Ctrl+S"` (Windows, as reported by the OS). `None` when the item
    /// has no shortcut (should not normally appear — callers filter these
    /// out before pushing into `AppShortcutsSnapshot::shortcuts`).
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub shortcut_display: Option<String>,
    /// Lowercase modifier key names in canonical order, e.g.
    /// `["control", "option", "shift", "command"]` on macOS or
    /// `["control", "alt", "shift"]` on Windows. Empty when no shortcut.
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub modifiers: Vec<String>,
    /// Lowercase main key name, e.g. `"s"`, `"left"`, `"f5"`, `"delete"`.
    /// `None` when no shortcut.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub key: Option<String>,
    pub enabled: bool,
    /// `Some(true/false)` for checkable/radio menu items whose checked
    /// state the host could resolve; `None` when not applicable or the
    /// host could not determine it (best-effort).
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub checked: Option<bool>,
}

/// Result of `ComputerUseHost::get_app_shortcuts`.
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
pub struct AppShortcutsSnapshot {
    /// Identity of the target application.
    pub app: AppInfo,
    /// Menu items that carry a resolvable keyboard shortcut. Items without
    /// a shortcut are **not** included here (see
    /// `menu_items_without_shortcut` for a diagnostic count).
    pub shortcuts: Vec<AppMenuShortcut>,
    /// Count of menu items walked that had no resolvable keyboard
    /// shortcut (e.g. plain "File" / "Edit" submenu openers, or items
    /// whose shortcut glyph the host could not decode). Diagnostic only.
    #[serde(default)]
    pub menu_items_without_shortcut: u32,
    /// Unix-epoch milliseconds when the snapshot was captured.
    pub captured_at_ms: u64,
}

/// Parse a Windows UI Automation `AcceleratorKey` display string (e.g.
/// `"Ctrl+Shift+S"`, `"Alt+F4"`, `"F5"`, `"Del"`) into
/// `(modifiers, key)`. Windows already renders this as a human-readable
/// string (unlike macOS's raw `AXMenuItemCmdModifiers` bitmask), so this
/// is a plain tokenizer — no guessing involved. Platform-agnostic so it
/// can be unit-tested without any `windows-rs` dependency.
///
/// Returns `(vec![], None)` for an empty/whitespace-only input.
pub fn parse_windows_accelerator_display(s: &str) -> (Vec<String>, Option<String>) {
    let trimmed = s.trim();
    if trimmed.is_empty() {
        return (Vec::new(), None);
    }
    let tokens: Vec<&str> = trimmed
        .split('+')
        .map(str::trim)
        .filter(|t| !t.is_empty())
        .collect();
    if tokens.is_empty() {
        return (Vec::new(), None);
    }
    let (key_token, modifier_tokens) = tokens.split_last().expect("tokens is non-empty");
    let modifiers = modifier_tokens
        .iter()
        .map(|t| normalize_windows_modifier(t))
        .collect();
    let key = normalize_windows_key(key_token);
    (modifiers, Some(key))
}

fn normalize_windows_modifier(token: &str) -> String {
    match token.to_ascii_lowercase().as_str() {
        "ctrl" | "control" => "control".to_string(),
        "alt" => "alt".to_string(),
        "shift" => "shift".to_string(),
        "win" | "windows" => "windows".to_string(),
        other => other.to_string(),
    }
}

fn normalize_windows_key(token: &str) -> String {
    match token.to_ascii_lowercase().as_str() {
        "del" => "delete".to_string(),
        "esc" => "escape".to_string(),
        "ins" => "insert".to_string(),
        "pgup" => "page_up".to_string(),
        "pgdn" | "pgdown" => "page_down".to_string(),
        "spacebar" | "space" => "space".to_string(),
        "enter" | "return" => "return".to_string(),
        "backspace" => "backspace".to_string(),
        other => other.to_string(),
    }
}

/// Snapshot of an application's AX tree. Returned by
/// `ComputerUseHost::get_app_state` and as the after-state of every
/// `app_*` mutation so the model can verify changes in one round-trip.
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
pub struct AppStateSnapshot {
    /// Opaque node address-space identity. Echo on subsequent input; unlike the
    /// content digest this changes even when two observations look identical.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub observation_id: Option<String>,
    /// Identity of the captured application.
    pub app: AppInfo,
    /// Title of the focused window when `focus_window_only=true`, else
    /// the frontmost-window title (best effort).
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub window_title: Option<String>,
    /// Codex-style human-readable text rendering of the tree (used in the
    /// model prompt). Indices in `tree_text` match `nodes[i].idx`.
    pub tree_text: String,
    /// Structured nodes, dense indexing.
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub nodes: Vec<AxNode>,
    /// Stable digest of the snapshot (lowercase hex SHA1 of the canonical
    /// node payload). Used as `before_app_state_digest` to detect "no-op"
    /// mutations and as a cheap equality check between successive
    /// snapshots.
    pub digest: String,
    /// Unix-epoch milliseconds when the snapshot was captured.
    pub captured_at_ms: u64,
    /// Optional focused-window screenshot. Existing observations include pixels
    /// by default; explicit AX-only reads and internal polling omit them. Capture
    /// failure can also leave this absent. Canvas and visual decisions need a
    /// fresh image-bearing observation.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub screenshot: Option<ComputerScreenshot>,
    /// Optional per-snapshot warning emitted by the host when it detects
    /// the agent is targeting the same node / coordinate repeatedly without
    /// progress. The recommended remediation is encoded directly in the
    /// message and the model is expected to switch tactic (take a real
    /// `screenshot`, fall back to keyboard, re-locate via OCR, …) on the
    /// **very next** turn rather than retry the failing target.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub loop_warning: Option<String>,
}

// =====================================================================
// Interactive-View (Set-of-Mark) data types — TuriX-CUA inspired.
// =====================================================================

/// Options for `ComputerUseHost::build_interactive_view`.
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
pub struct InteractiveViewOpts {
    /// When `true` (default) only emit elements inside the focused window
    /// of the target application; when `false` emit every interactive
    /// element across all windows of the app (heavier overlay).
    #[serde(default = "default_focus_window_only_true")]
    pub focus_window_only: bool,
    /// Maximum number of interactive elements to include / annotate. The
    /// host trims by visual area (largest first) when exceeded so the
    /// overlay stays legible. `None` → host default (typically ~80).
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub max_elements: Option<u32>,
    /// When `true` (default), the host paints numbered coloured boxes on a
    /// fresh focused-window screenshot. Set `false` to skip the overlay
    /// (text-only payload — cheaper, useful for retries / loop probes).
    #[serde(default = "default_annotate_true")]
    pub annotate_screenshot: bool,
    /// When `true` (default), include the compact `tree_text` rendering of
    /// the filtered elements alongside the structured `elements` array.
    #[serde(default = "default_include_tree_text_true")]
    pub include_tree_text: bool,
}

fn default_focus_window_only_true() -> bool {
    true
}
fn default_annotate_true() -> bool {
    true
}
fn default_include_tree_text_true() -> bool {
    true
}

impl Default for InteractiveViewOpts {
    fn default() -> Self {
        Self {
            focus_window_only: true,
            max_elements: None,
            annotate_screenshot: true,
            include_tree_text: true,
        }
    }
}

/// One interactive element inside an [`InteractiveView`]. The [`Self::i`]
/// field is the only handle the model is expected to use — every other
/// field is informational so the model can disambiguate between visually
/// similar boxes.
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
pub struct InteractiveElement {
    /// Dense per-view index (0-based). The single source of truth the
    /// model passes back via [`ClickIndexTarget::Index`] /
    /// [`InteractiveClickParams::i`].
    pub i: u32,
    /// Underlying [`AxNode::idx`] in the snapshot embedded in this view.
    /// Hosts use this to round-trip back to existing `app_click` /
    /// `app_type_text` plumbing.
    pub node_idx: u32,
    /// Native AX role (`AXButton`, `AXTextField`, …). The overlay colour
    /// is derived from this.
    pub role: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub subrole: Option<String>,
    /// Best human-readable label for the element (title → description →
    /// help → value, whichever is non-empty first).
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub label: Option<String>,
    /// Frame in **JPEG image pixel** space of the overlay screenshot
    /// (`x, y, width, height`). When `annotate_screenshot=false` the host
    /// may return `None` for elements outside the captured window.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub frame_image: Option<(u32, u32, u32, u32)>,
    /// Frame in **global pointer** space (`x, y, width, height`). Useful
    /// for hosts that need a coordinate fallback when AX press fails.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub frame_global: Option<(f64, f64, f64, f64)>,
    /// `true` when the element is focusable / actionable right now.
    #[serde(default = "default_true")]
    pub enabled: bool,
    #[serde(default, skip_serializing_if = "is_false")]
    pub focused: bool,
    /// Whether the host can dispatch a press via AX (vs. falling back to a
    /// pointer click).
    #[serde(default = "default_true")]
    pub ax_actionable: bool,
}

fn default_true() -> bool {
    true
}

/// Set-of-Mark interactive snapshot returned by
/// `ComputerUseHost::build_interactive_view`.
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
pub struct InteractiveView {
    /// Node/view address space from the underlying application observation.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub observation_id: Option<String>,
    /// Identity of the captured application.
    pub app: AppInfo,
    /// Title of the focused window (or `None` when the host could not
    /// resolve it).
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub window_title: Option<String>,
    /// Filtered + sorted interactive elements with dense `i` indices.
    pub elements: Vec<InteractiveElement>,
    /// Eligible controls omitted by the view's element budget (not absent
    /// from the AX tree). Older payloads did not report this count.
    #[serde(default)]
    pub omitted_element_count: u32,
    /// Compact text rendering of `elements` (one element per line, prefixed
    /// with `[i] role "label"`). Empty string when
    /// `opts.include_tree_text=false`.
    #[serde(default, skip_serializing_if = "String::is_empty")]
    pub tree_text: String,
    /// Stable lowercase-hex SHA1 over the canonical element payload.
    /// Subsequent `interactive_*` calls echo this back as
    /// `before_view_digest` so the host can detect "stale index" usage.
    pub digest: String,
    /// Unix-epoch milliseconds when the view was captured.
    pub captured_at_ms: u64,
    /// Annotated focused-window screenshot (numbered coloured boxes).
    /// `None` when `opts.annotate_screenshot=false` or the capture failed.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub screenshot: Option<ComputerScreenshot>,
    /// Loop / no-progress warning, mirrored from
    /// [`AppStateSnapshot::loop_warning`].
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub loop_warning: Option<String>,
}

/// Where an `ComputerUseHost::interactive_click` should land. `Index`
/// is the canonical addressing mode; the other variants exist only so
/// hosts can transparently fall back to existing `app_click` paths when
/// AX press is rejected for a given element.
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "snake_case", tag = "kind")]
pub enum ClickIndexTarget {
    /// `i` value from [`InteractiveElement::i`].
    Index { i: u32 },
    /// Authoritative AX node index (used internally when the host falls
    /// back from a stale interactive index).
    NodeIdx { idx: u32 },
}

/// Parameters for `ComputerUseHost::interactive_click`.
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
pub struct InteractiveClickParams {
    /// Required: the `i` index from the most recent interactive view.
    pub i: u32,
    /// Echo of [`InteractiveView::digest`] so the host can detect stale
    /// indices when the UI changed between view + click.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub before_view_digest: Option<String>,
    #[serde(default = "default_click_count_one")]
    pub click_count: u8,
    /// `"left"` / `"right"` / `"middle"`.
    #[serde(default = "default_left_button")]
    pub mouse_button: String,
    /// Modifier names (e.g. `["command"]`).
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub modifier_keys: Vec<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub wait_ms_after: Option<u32>,
    /// Whether the host should re-build the interactive view after the
    /// click (default `true` — the model gets a fresh annotated screenshot
    /// for the next turn). Set `false` when chaining many `interactive_*`
    /// calls in a row to save on overlay rendering.
    #[serde(default = "default_true")]
    pub return_view: bool,
}

fn default_click_count_one() -> u8 {
    1
}
fn default_left_button() -> String {
    "left".to_string()
}

/// Parameters for `ComputerUseHost::interactive_type_text`.
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
pub struct InteractiveTypeTextParams {
    /// `i` index of the text field. `None` types into whatever element is
    /// currently focused.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub i: Option<u32>,
    pub text: String,
    /// When `true`, host clears the field via `cmd+a` + `delete` (macOS)
    /// or equivalent before typing.
    #[serde(default, skip_serializing_if = "is_false")]
    pub clear_first: bool,
    /// When `true`, host presses `return` after typing.
    #[serde(default, skip_serializing_if = "is_false")]
    pub press_enter_after: bool,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub before_view_digest: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub wait_ms_after: Option<u32>,
    #[serde(default = "default_true")]
    pub return_view: bool,
}

/// Parameters for `ComputerUseHost::interactive_scroll`.
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
pub struct InteractiveScrollParams {
    /// `i` index of the scroll target. `None` scrolls at pointer / focused
    /// window centre.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub i: Option<u32>,
    /// Vertical scroll amount in lines / "wheel ticks" (positive = down).
    #[serde(default)]
    pub dy: i32,
    /// Horizontal scroll amount in lines / "wheel ticks" (positive = right).
    #[serde(default)]
    pub dx: i32,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub before_view_digest: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub wait_ms_after: Option<u32>,
    #[serde(default = "default_true")]
    pub return_view: bool,
}

/// Result envelope for `interactive_*` actions. Always carries the bare
/// AX snapshot; the rendered [`InteractiveView`] is only populated when
/// the caller asked for it via `return_view=true`.
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
pub struct InteractiveActionResult {
    pub snapshot: AppStateSnapshot,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub view: Option<InteractiveView>,
    /// Best-effort note about how the host actually executed the request
    /// (e.g. `"ax_press"`, `"pointer_click_fallback"`,
    /// `"index_resolved_via_node_idx"`).
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub execution_note: Option<String>,
}

/// Options for generic visual marking. This is intentionally UI-agnostic:
/// hosts should produce useful candidate points even when AX/OCR exposes
/// nothing, such as Canvas, games, maps, drawings, and icon-only controls.
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
pub struct VisualMarkViewOpts {
    /// Max candidate points to emit. Default keeps the overlay readable.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub max_points: Option<u32>,
    /// Optional region in screenshot image pixels to mark. When omitted,
    /// the host marks the whole app screenshot.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub region: Option<VisualImageRegion>,
    /// Include regular grid points. Default true.
    #[serde(default = "default_true")]
    pub include_grid: bool,
}

impl Default for VisualMarkViewOpts {
    fn default() -> Self {
        Self {
            max_points: None,
            region: None,
            include_grid: true,
        }
    }
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
pub struct VisualImageRegion {
    pub x0: u32,
    pub y0: u32,
    pub width: u32,
    pub height: u32,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
pub struct VisualMark {
    pub i: u32,
    pub x: i32,
    pub y: i32,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub frame_image: Option<(u32, u32, u32, u32)>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub label: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
pub struct VisualMarkView {
    /// Node/view address space from the underlying application observation.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub observation_id: Option<String>,
    pub app: AppInfo,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub window_title: Option<String>,
    pub marks: Vec<VisualMark>,
    pub digest: String,
    pub captured_at_ms: u64,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub screenshot: Option<ComputerScreenshot>,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
pub struct VisualClickParams {
    pub i: u32,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub before_view_digest: Option<String>,
    #[serde(default = "default_click_count_one")]
    pub click_count: u8,
    #[serde(default = "default_left_button")]
    pub mouse_button: String,
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub modifier_keys: Vec<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub wait_ms_after: Option<u32>,
    #[serde(default = "default_true")]
    pub return_view: bool,
}

/// Result envelope for `visual_*` actions. This mirrors
/// [`InteractiveActionResult`], but carries a [`VisualMarkView`] because the
/// addressing basis is screenshot marks rather than AX elements.
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
pub struct VisualActionResult {
    pub snapshot: AppStateSnapshot,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub view: Option<VisualMarkView>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub execution_note: Option<String>,
}

/// Where an `ComputerUseHost::app_click` should land.
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "snake_case", tag = "kind")]
pub enum ClickTarget {
    /// Global screen-space coordinates (same space as `mouse_move`).
    ScreenXy { x: f64, y: f64 },
    /// Pixel coordinates in the most recent screenshot attached by
    /// `get_app_state` / `screenshot`. This is the preferred target for
    /// visual surfaces such as Canvas, SVG boards, and WebGL scenes.
    ImageXy {
        x: i32,
        y: i32,
        #[serde(default, skip_serializing_if = "Option::is_none")]
        screenshot_id: Option<String>,
    },
    /// Grid target inside the most recent screenshot attached by
    /// `get_app_state` / `app_click`. This is for non-text visual surfaces
    /// such as boards and canvases where a single guessed pixel is brittle.
    ///
    /// `x0/y0/width/height` describe the board/grid rectangle in screenshot
    /// image pixels. `row` and `col` are zero-based. When `intersections` is
    /// true, rows/cols are line intersections (e.g. Go/Gomoku 15x15); when
    /// false, rows/cols are cells and the click lands in the cell center.
    ImageGrid {
        x0: i32,
        y0: i32,
        width: u32,
        height: u32,
        rows: u32,
        cols: u32,
        row: u32,
        col: u32,
        #[serde(default)]
        intersections: bool,
        #[serde(default, skip_serializing_if = "Option::is_none")]
        screenshot_id: Option<String>,
    },
    /// Self-locating regular visual grid target. The host captures the app
    /// screenshot, detects a regular line grid, then clicks the requested
    /// row/col in the detected grid. Use when the surface is custom-drawn and
    /// the grid rectangle is not exposed by AX/OCR.
    VisualGrid {
        rows: u32,
        cols: u32,
        row: u32,
        col: u32,
        #[serde(default)]
        intersections: bool,
        #[serde(default, skip_serializing_if = "Option::is_none")]
        wait_ms_after_detection: Option<u32>,
    },
    /// AX node addressed by index inside the most recent
    /// [`AppStateSnapshot`] for this app.
    NodeIdx { idx: u32 },
    /// OCR text needle: the host screenshots the target app, runs OCR,
    /// and clicks the centre of the highest-confidence match. Used as a
    /// fallback when the AX tree does not expose the desired element
    /// (e.g. inside a Canvas / WebGL / custom-drawn surface).
    OcrText { needle: String },
}

/// Parameters for `ComputerUseHost::app_click`.
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
pub struct AppClickParams {
    pub app: AppSelector,
    pub target: ClickTarget,
    /// Number of clicks (1 = single, 2 = double, 3 = triple).
    #[serde(default = "AppClickParams::default_click_count")]
    pub click_count: u8,
    /// `"left"` / `"right"` / `"middle"`.
    #[serde(default = "AppClickParams::default_button")]
    pub mouse_button: String,
    /// Modifier names held during the click (e.g. `["command"]`).
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub modifier_keys: Vec<String>,
    /// Optional settle delay before returning the after-state screenshot.
    /// Useful for game boards, WebViews, animations, and delayed AI moves.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub wait_ms_after: Option<u32>,
}

impl AppClickParams {
    fn default_click_count() -> u8 {
        1
    }
    fn default_button() -> String {
        "left".to_string()
    }
}

/// App-scoped input program. The target app is bound once outside the steps;
/// a step cannot change the application, session mode or capture authorization.
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(tag = "action", deny_unknown_fields)]
pub enum AppInputAction {
    #[serde(rename = "app_click")]
    Click {
        target: ClickTarget,
        #[serde(default = "AppClickParams::default_click_count")]
        click_count: u8,
        #[serde(default = "AppClickParams::default_button")]
        mouse_button: String,
        #[serde(default)]
        modifier_keys: Vec<String>,
        #[serde(default, skip_serializing_if = "Option::is_none")]
        wait_ms_after: Option<u32>,
    },
    #[serde(rename = "app_type_text")]
    TypeText {
        text: String,
        #[serde(default)]
        focus: Option<ClickTarget>,
    },
    #[serde(rename = "app_key_chord")]
    KeyChord {
        keys: Vec<String>,
        #[serde(default)]
        focus_idx: Option<u32>,
    },
    #[serde(rename = "app_scroll")]
    Scroll {
        #[serde(default)]
        dx: i32,
        #[serde(default)]
        dy: i32,
        #[serde(default)]
        focus: Option<ClickTarget>,
    },
    #[serde(rename = "app_drag")]
    Drag {
        from: ClickTarget,
        to: ClickTarget,
        #[serde(default = "AppClickParams::default_button")]
        mouse_button: String,
        #[serde(default = "default_app_drag_ms")]
        duration_ms: u64,
    },
    #[serde(rename = "wait")]
    Wait { ms: u64 },
}

/// Outcome of waiting for the input target to stop repainting before the
/// post-input observation. Settling is evidence about pixels only; it never
/// proves that asynchronous application work has finished.
#[derive(Debug, Clone, Copy, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "snake_case")]
pub enum AppInputSettleStatus {
    /// The target produced no new frame for the host's quiet interval.
    Stable,
    /// The target was still repainting when the host's bound elapsed.
    StillChanging,
    /// This host or target has no live frame stream to measure.
    Unavailable,
    /// No input step was submitted, so nothing needed to settle.
    Skipped,
    /// Stop, cancellation or a changed control scope ended the wait early.
    Interrupted,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
pub struct AppInputSettle {
    pub status: AppInputSettleStatus,
    #[serde(default)]
    pub waited_ms: u64,
    /// Whether at least one repaint was observed after the input.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub changed: Option<bool>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub reason: Option<String>,
}

impl AppInputSettle {
    pub fn unavailable(reason: impl Into<String>) -> Self {
        Self {
            status: AppInputSettleStatus::Unavailable,
            waited_ms: 0,
            changed: None,
            reason: Some(reason.into()),
        }
    }
    pub fn skipped() -> Self {
        Self {
            status: AppInputSettleStatus::Skipped,
            waited_ms: 0,
            changed: None,
            reason: None,
        }
    }
}

/// Bounds for one post-input settle. `quiet_ms` is the repaint-free interval
/// that counts as settled; `first_change_ms` is how long an input that has not
/// repainted yet may take to start; `max_ms` caps the whole wait.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct AppInputSettlePolicy {
    pub quiet_ms: u32,
    pub first_change_ms: u32,
    pub max_ms: u32,
}

impl Default for AppInputSettlePolicy {
    fn default() -> Self {
        Self {
            quiet_ms: 250,
            first_change_ms: 400,
            max_ms: 2000,
        }
    }
}

/// Pure decision shared by native frame trackers. Times are milliseconds since
/// the settle anchor (the input barrier). `last_change_ms` is the newest
/// repaint at or after the anchor.
pub fn app_input_settle_decision(
    policy: AppInputSettlePolicy,
    elapsed_ms: u64,
    last_change_ms: Option<u64>,
) -> Option<AppInputSettleStatus> {
    let settled = match last_change_ms {
        Some(changed) => elapsed_ms.saturating_sub(changed) >= u64::from(policy.quiet_ms),
        None => elapsed_ms >= u64::from(policy.first_change_ms),
    };
    if settled {
        Some(AppInputSettleStatus::Stable)
    } else if elapsed_ms >= u64::from(policy.max_ms) {
        Some(AppInputSettleStatus::StillChanging)
    } else {
        None
    }
}

/// How long a frame tracker may block before the decision can change. A new
/// repaint should wake it sooner; short slices keep Stop checks responsive.
pub fn app_input_settle_next_wait_ms(
    policy: AppInputSettlePolicy,
    elapsed_ms: u64,
    last_change_ms: Option<u64>,
) -> u32 {
    let due = match last_change_ms {
        Some(changed) => changed.saturating_add(u64::from(policy.quiet_ms)),
        None => u64::from(policy.first_change_ms),
    }
    .min(u64::from(policy.max_ms));
    due.saturating_sub(elapsed_ms).clamp(1, 100) as u32
}

fn default_app_drag_ms() -> u64 {
    400
}
impl AppInputAction {
    pub fn name(&self) -> &'static str {
        match self {
            Self::Click { .. } => "app_click",
            Self::TypeText { .. } => "app_type_text",
            Self::KeyChord { .. } => "app_key_chord",
            Self::Scroll { .. } => "app_scroll",
            Self::Drag { .. } => "app_drag",
            Self::Wait { .. } => "wait",
        }
    }
    pub fn validate(&self) -> Result<(), String> {
        match self {
            Self::Click {
                click_count,
                mouse_button,
                ..
            } if !(1..=3).contains(click_count)
                || !matches!(mouse_button.as_str(), "left" | "right" | "middle") =>
            {
                return Err(
                    "click_count must be 1..3 and mouse_button must be left/right/middle".into(),
                );
            }
            Self::KeyChord { keys, .. }
                if keys.is_empty() || keys.iter().any(|key| key.trim().is_empty()) =>
            {
                return Err("keys must contain non-empty key names".into());
            }
            Self::Drag {
                from,
                to,
                mouse_button,
                duration_ms,
            } => {
                if !matches!((from, to), (
                    ClickTarget::ImageXy { screenshot_id: Some(a), .. },
                    ClickTarget::ImageXy { screenshot_id: Some(b), .. }
                ) if a == b)
                {
                    return Err(
                        "drag endpoints must use image_xy coordinates from the same screenshot_id"
                            .into(),
                    );
                }
                if !matches!(mouse_button.as_str(), "left" | "right" | "middle")
                    || *duration_ms == 0
                {
                    return Err("drag requires a valid button and positive duration_ms".into());
                }
            }
            _ => {}
        }
        match self {
            Self::Click { target, .. } => target.validate(),
            Self::TypeText {
                focus: Some(target),
                ..
            }
            | Self::Scroll {
                focus: Some(target),
                ..
            } => target.validate(),
            Self::Drag { from, to, .. } => {
                from.validate()?;
                to.validate()
            }
            _ => Ok(()),
        }
    }
}

impl ClickTarget {
    pub fn validate(&self) -> Result<(), String> {
        match self {
            ClickTarget::ImageXy {
                x,
                y,
                screenshot_id,
            } => {
                if *x < 0
                    || *y < 0
                    || screenshot_id
                        .as_deref()
                        .is_none_or(|id| id.trim().is_empty())
                {
                    return Err("image_xy requires nonnegative image coordinates and the observed screenshot_id".into());
                }
            }
            ClickTarget::ImageGrid {
                x0,
                y0,
                width,
                height,
                rows,
                cols,
                row,
                col,
                intersections,
                screenshot_id,
            } => {
                if *x0 < 0
                    || *y0 < 0
                    || *width == 0
                    || *height == 0
                    || i64::from(*x0) + i64::from(*width) > i64::from(i32::MAX) + 1
                    || i64::from(*y0) + i64::from(*height) > i64::from(i32::MAX) + 1
                    || *rows == 0
                    || *cols == 0
                    || row >= rows
                    || col >= cols
                    || (*intersections && (*rows < 2 || *cols < 2))
                    || screenshot_id
                        .as_deref()
                        .is_none_or(|id| id.trim().is_empty())
                {
                    return Err("image_grid requires a nonempty observed screenshot_id, positive rectangle/grid dimensions and an in-range row/col".into());
                }
            }
            ClickTarget::VisualGrid {
                rows,
                cols,
                row,
                col,
                intersections,
                ..
            } => {
                if *rows == 0
                    || *cols == 0
                    || row >= rows
                    || col >= cols
                    || (*intersections && (*rows < 2 || *cols < 2))
                {
                    return Err(
                        "visual_grid requires positive dimensions and an in-range row/col".into(),
                    );
                }
            }
            ClickTarget::OcrText { needle } if needle.trim().is_empty() => {
                return Err("ocr_text requires non-empty observed text".into())
            }
            ClickTarget::ScreenXy { x, y } if !x.is_finite() || !y.is_finite() => {
                return Err("screen_xy coordinates must be finite".into())
            }
            _ => {}
        }
        Ok(())
    }
}

/// Predicate for `ComputerUseHost::app_wait_for`.
///
/// Hosts that don't yet implement AX waiting can simply return the
/// `app_wait_for is not available` default error; consumers fall back to
/// `wait_ms` + `get_app_state`.
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "snake_case", tag = "kind")]
pub enum AppWaitPredicate {
    /// Wait until the AX tree digest changes from `prev_digest`.
    DigestChanged { prev_digest: String },
    /// Wait until any node's `title` contains the given substring.
    TitleContains { needle: String },
    /// Wait until any node has the given role and `enabled == true`.
    RoleEnabled { role: String },
    /// Wait until the node identified by `idx` reports `enabled=true`.
    NodeEnabled { idx: u32 },
}

/// One physical display reported by the desktop host. Returned by
/// `ComputerUseHost::list_displays` and surfaced to the model in
/// `interaction_state.displays` so it can pick the right screen explicitly
/// instead of falling back to whichever screen the mouse pointer happens
/// to be on (the original "computer use 在多屏时搞错操作的屏幕" failure mode).
///
/// `interaction_state.displays` is populated **only when more than one display
/// is attached** — it rides on every result, and on a single-screen machine
/// repeating it says nothing `active_display_id` does not already say. Callers
/// that need the list unconditionally should use `list_displays`.
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
pub struct ComputerUseDisplayInfo {
    /// Stable per-session id of the display. Pass back to
    /// `ComputerUseHost::focus_display` to pin subsequent screenshots /
    /// clicks to this screen.
    pub display_id: u32,
    /// Whether the OS marks this as the primary display.
    pub is_primary: bool,
    /// Whether this is the display ControlHub will currently capture by
    /// default (matches the host's `preferred_display_id`, falling back to
    /// the screen under the mouse pointer if no preference is pinned).
    pub is_active: bool,
    /// Whether the cursor is on this display right now.
    pub has_pointer: bool,
    /// Top-left corner in **global** logical coordinate space.
    pub origin_x: i32,
    pub origin_y: i32,
    /// Logical (DIP) size; native pixels = logical × `scale_factor`.
    pub width_logical: u32,
    pub height_logical: u32,
    pub scale_factor: f32,
    /// Best-effort name of the foreground window's app on this display, if
    /// the host can determine it. Useful for the model to confirm it is
    /// targeting the "right" screen (e.g. the one with the editor).
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub foreground_app: Option<String>,
}

/// Result of launching an application via `ComputerUseHost::open_app`.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct OpenAppResult {
    pub app_name: String,
    pub success: bool,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub process_id: Option<i32>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub error_message: Option<String>,
    /// Bundle identifier of the launched app (macOS). The agent needs this to
    /// address the app afterwards: the name it launched by (`Lark`), the
    /// executable name (`Feishu`) and the bundle id (`com.electron.lark`) are
    /// routinely three different strings, and only the bundle id works with
    /// every follow-up path.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub bundle_id: Option<String>,
    /// Process name as the OS reports it — the identity AppleScript's
    /// `tell process "…"` and `ps` expect, which is often **not** `app_name`.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub process_name: Option<String>,
    /// Windows the app owns once the launch settled. `Some(0)` means the
    /// process is alive but has nothing on screen — a real state for Electron
    /// apps whose window was closed while the process stayed resident, and one
    /// the agent otherwise has no way to distinguish from a healthy launch.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub window_count: Option<usize>,
    /// How the app ended up in front. Diagnostic: tells the agent whether a
    /// plain activate sufficed or the host had to re-open the bundle to force
    /// a window.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub launch_path: Option<String>,
}

/// Whether the latest screenshot JPEG was the full display, a point crop, or a quadrant-drill region.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum ComputerUseScreenshotRefinement {
    FullDisplay,
    RegionAroundPoint {
        center_x: u32,
        center_y: u32,
    },
    /// Partial-screen view from hierarchical quadrant navigation.
    QuadrantNavigation {
        x0: u32,
        y0: u32,
        width: u32,
        height: u32,
        click_ready: bool,
    },
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "snake_case")]
pub enum ComputerUseInteractionScreenshotKind {
    FullDisplay,
    RegionCrop,
    QuadrantDrill,
    QuadrantTerminal,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "snake_case")]
pub enum ComputerUseLastMutationKind {
    Screenshot,
    PointerMove,
    Click,
    Scroll,
    KeyChord,
    TypeText,
    Wait,
    Locate,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Default)]
pub struct ComputerUseInteractionState {
    pub click_ready: bool,
    pub enter_ready: bool,
    pub requires_fresh_screenshot_before_click: bool,
    pub requires_fresh_screenshot_before_enter: bool,
    /// When true, the last action (click, key, typing, scroll, etc.) changed the UI; take **`screenshot`**
    /// next to **confirm** the outcome (Cowork-style verify step), ideally after **`wait`** if the UI animates.
    #[serde(default, skip_serializing_if = "is_false")]
    pub recommend_screenshot_to_verify_last_action: bool,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub last_screenshot_kind: Option<ComputerUseInteractionScreenshotKind>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub last_mutation: Option<ComputerUseLastMutationKind>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub recommended_next_action: Option<String>,
    /// Snapshot of all displays at the time of this interaction state.
    /// The model should consult this list before issuing screen-coordinate
    /// actions on multi-monitor setups so it can disambiguate targets via
    /// `desktop.focus_display` instead of relying on cursor location.
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub displays: Vec<ComputerUseDisplayInfo>,
    /// Currently pinned display id (set via `desktop.focus_display`).
    /// `None` means "fall back to whichever screen the mouse is on" — the
    /// legacy behavior, kept for compatibility but discouraged.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub active_display_id: Option<u32>,
}

pub fn use_screen_coordinates(input: &Value) -> bool {
    input
        .get("use_screen_coordinates")
        .and_then(|v| v.as_bool())
        .unwrap_or(false)
}

/// Rejects JPEG/normalized coordinates for pointer moves — vision-derived positions are unreliable.
/// Use `use_screen_coordinates: true` with globals from OCR/AX tools, or non-coordinate actions.
pub fn ensure_pointer_move_uses_screen_coordinates_only(
    input: &Value,
) -> ComputerUseContractResult<()> {
    if use_screen_coordinates(input) {
        return Ok(());
    }
    Err(ComputerUseContractError::tool(
        "Positioning from screenshot pixels (coordinate_mode image/normalized) is disabled: do not guess coordinates from vision. Set use_screen_coordinates: true with global display coordinates from move_to_text (global_center_x/y), locate, click_element, or pointer_image_x/y from the last screenshot JSON; or use move_to_text, click_element, pointer_move_rel. Screenshots are for confirmation only.".to_string(),
    ))
}

pub fn coordinate_mode(input: &Value) -> &str {
    input
        .get("coordinate_mode")
        .and_then(|v| v.as_str())
        .unwrap_or("image")
}

#[allow(dead_code)] // kept around for the deprecation shim — no longer wired in
pub fn parse_screenshot_crop_center(
    input: &Value,
) -> ComputerUseContractResult<Option<ScreenshotCropCenter>> {
    let xv = input.get("screenshot_crop_center_x");
    let yv = input.get("screenshot_crop_center_y");
    let x_none = xv.is_none() || xv.is_some_and(|v| v.is_null());
    let y_none = yv.is_none() || yv.is_some_and(|v| v.is_null());

    match (x_none, y_none) {
        (true, true) => Ok(None),
        (false, false) => {
            let x = xv
                .and_then(|v| v.as_u64())
                .ok_or_else(|| ComputerUseContractError::tool("screenshot_crop_center_x must be a non-negative integer (full-display native pixels).".to_string()))?;
            let y = yv
                .and_then(|v| v.as_u64())
                .ok_or_else(|| ComputerUseContractError::tool("screenshot_crop_center_y must be a non-negative integer (full-display native pixels).".to_string()))?;
            Ok(Some(ScreenshotCropCenter {
                x: u32::try_from(x)
                    .map_err(|_| ComputerUseContractError::tool("screenshot_crop_center_x is too large.".to_string()))?,
                y: u32::try_from(y)
                    .map_err(|_| ComputerUseContractError::tool("screenshot_crop_center_y is too large.".to_string()))?,
            }))
        }
        _ => Err(ComputerUseContractError::tool(
            "screenshot_crop_center_x and screenshot_crop_center_y must both be set or both omitted for action screenshot.".to_string(),
        )),
    }
}

#[allow(dead_code)]
pub fn parse_screenshot_crop_half_extent_native(
    input: &Value,
) -> ComputerUseContractResult<Option<u32>> {
    match input.get("screenshot_crop_half_extent_native") {
        None => Ok(None),
        Some(v) if v.is_null() => Ok(None),
        Some(v) => {
            let n = v.as_u64().ok_or_else(|| {
                ComputerUseContractError::tool(
                    "screenshot_crop_half_extent_native must be a non-negative integer."
                        .to_string(),
                )
            })?;
            Ok(Some(u32::try_from(n).map_err(|_| {
                ComputerUseContractError::tool(
                    "screenshot_crop_half_extent_native is too large.".to_string(),
                )
            })?))
        }
    }
}

#[allow(dead_code)]
pub fn input_has_screenshot_crop_fields(input: &Value) -> bool {
    let x = input.get("screenshot_crop_center_x");
    let y = input.get("screenshot_crop_center_y");
    x.is_some_and(|v| !v.is_null()) || y.is_some_and(|v| !v.is_null())
}

#[allow(dead_code)]
pub fn parse_screenshot_implicit_center(
    input: &Value,
) -> ComputerUseContractResult<Option<ComputerUseImplicitScreenshotCenter>> {
    match input
        .get("screenshot_implicit_center")
        .and_then(|v| v.as_str())
        .map(str::trim)
    {
        None | Some("") => Ok(None),
        Some("mouse") => Ok(Some(ComputerUseImplicitScreenshotCenter::Mouse)),
        Some("text_caret") => Ok(Some(ComputerUseImplicitScreenshotCenter::TextCaret)),
        Some(other) => Err(ComputerUseContractError::tool(format!(
            "screenshot_implicit_center must be \"mouse\" or \"text_caret\", got {:?}",
            other
        ))),
    }
}

#[allow(dead_code)]
pub fn parse_screenshot_navigate_quadrant(
    input: &Value,
) -> ComputerUseContractResult<Option<ComputerUseNavigateQuadrant>> {
    let value = input
        .get("screenshot_navigate_quadrant")
        .filter(|x| !x.is_null())
        .and_then(|x| x.as_str());
    let Some(s) = value else {
        return Ok(None);
    };

    let n = s.trim().to_ascii_lowercase().replace('-', "_");
    Ok(Some(match n.as_str() {
        "top_left" | "topleft" | "upper_left" => ComputerUseNavigateQuadrant::TopLeft,
        "top_right" | "topright" | "upper_right" => ComputerUseNavigateQuadrant::TopRight,
        "bottom_left" | "bottomleft" | "lower_left" => ComputerUseNavigateQuadrant::BottomLeft,
        "bottom_right" | "bottomright" | "lower_right" => ComputerUseNavigateQuadrant::BottomRight,
        _ => {
            return Err(ComputerUseContractError::tool(
                "screenshot_navigate_quadrant must be one of: top_left, top_right, bottom_left, bottom_right.".to_string(),
            ));
        }
    }))
}

/// Parse `screenshot_window` / `window` truthy flags. Accepts:
/// - boolean `true`
/// - string `"focused"`, `"focused_window"`, `"app"`, `"window"` (case-insensitive)
///
/// Anything else (including `false` / `null` / missing) → `false`.
pub fn parse_screenshot_window_flag(input: &Value) -> bool {
    let raw = input
        .get("screenshot_window")
        .or_else(|| input.get("window"));
    let Some(v) = raw else {
        return false;
    };
    if let Some(b) = v.as_bool() {
        return b;
    }
    if let Some(s) = v.as_str() {
        let n = s.trim().to_ascii_lowercase();
        return matches!(
            n.as_str(),
            "focused" | "focused_window" | "app" | "window" | "true" | "1"
        );
    }
    false
}

/// Crop / quadrant / implicit-center parameters are **deprecated and silently
/// ignored** — every screenshot is now either the focused application window
/// (default, when AX can resolve it) or the full display (fallback). Only
/// `screenshot_window` / `window` is still honored, as a hint to prefer the
/// focused window when both branches are available. Old prompts and tests
/// that pass the legacy fields keep working without erroring out.
pub fn parse_screenshot_params(
    input: &Value,
) -> ComputerUseContractResult<(ComputerUseScreenshotParams, bool)> {
    let crop_to_focused_window = parse_screenshot_window_flag(input);
    Ok((
        ComputerUseScreenshotParams {
            crop_center: None,
            navigate_quadrant: None,
            reset_navigation: false,
            point_crop_half_extent_native: None,
            implicit_confirmation_center: None,
            crop_to_focused_window,
        },
        false,
    ))
}

#[cfg(test)]
mod input_tests {
    use super::*;
    use serde_json::json;

    #[test]
    fn screenshot_params_silently_ignore_legacy_quadrant_and_crop_fields() {
        // Crop / quadrant / reset_navigation are deprecated. The parser must
        // accept them (no error) and discard them so old prompts keep working
        // — every screenshot is now full-window or full-display only.
        let input = json!({
            "screenshot_navigate_quadrant": "top_left",
            "screenshot_crop_center_x": 120,
            "screenshot_crop_center_y": 340,
            "screenshot_reset_navigation": true,
        });

        let (params, ignored_crop) =
            parse_screenshot_params(&input).expect("parse screenshot params");

        assert_eq!(params.navigate_quadrant, None);
        assert_eq!(params.crop_center, None);
        assert!(!params.reset_navigation);
        assert!(!ignored_crop);
    }

    #[test]
    fn screenshot_params_silently_ignore_crop_half_extent() {
        let input = json!({
            "screenshot_crop_center_x": 33,
            "screenshot_crop_center_y": 44,
            "screenshot_crop_half_extent_native": 180
        });

        let (params, ignored_crop) =
            parse_screenshot_params(&input).expect("parse screenshot params");

        assert_eq!(params.crop_center, None);
        assert_eq!(params.point_crop_half_extent_native, None);
        assert!(!ignored_crop);
    }

    #[test]
    fn screenshot_params_silently_ignore_implicit_center() {
        let input = json!({ "screenshot_implicit_center": "text_caret" });
        let (params, _) = parse_screenshot_params(&input).expect("parse");
        assert_eq!(params.implicit_confirmation_center, None);
    }

    #[test]
    fn screenshot_params_honor_window_flag() {
        let input = json!({ "screenshot_window": true });
        let (params, _) = parse_screenshot_params(&input).expect("parse");
        assert!(params.crop_to_focused_window);

        let input = json!({ "window": "focused" });
        let (params, _) = parse_screenshot_params(&input).expect("parse");
        assert!(params.crop_to_focused_window);

        let input = json!({});
        let (params, _) = parse_screenshot_params(&input).expect("parse");
        assert!(!params.crop_to_focused_window);
    }
}

#[cfg(test)]
mod window_selector_tests {
    use super::*;
    use serde_json::json;

    #[test]
    fn legacy_app_selectors_round_trip_without_new_fields() {
        for value in [
            json!({"pid":421}),
            json!({"name":"Example"}),
            json!({"bundle_id":"example.app"}),
        ] {
            let selector: AppSelector = serde_json::from_value(value.clone()).unwrap();
            assert_eq!(selector.window_id, None);
            assert!(selector.validate_window_target().is_ok());
            assert_eq!(serde_json::to_value(selector).unwrap(), value);
        }
    }

    #[test]
    fn exact_window_requires_its_owning_process() {
        for value in [
            json!({"window_id":42}),
            json!({"name":"Example","window_id":42}),
            json!({"pid":0,"window_id":42}),
            json!({"pid":421,"window_id":0}),
        ] {
            let selector: AppSelector = serde_json::from_value(value).unwrap();
            assert!(!selector.is_empty());
            assert!(selector.validate_window_target().is_err());
        }
        let value = json!({"pid":421,"window_id":42});
        let selector: AppSelector = serde_json::from_value(value.clone()).unwrap();
        assert!(selector.validate_window_target().is_ok());
        assert_eq!(serde_json::to_value(selector).unwrap(), value);
    }
}

pub fn build_screenshot_tool_body_and_hint(
    shot: &ComputerScreenshot,
    debug_rel: Option<String>,
) -> (Value, String) {
    let pointer_marker_note = match (shot.pointer_image_x, shot.pointer_image_y) {
        (Some(_), Some(_)) => {
            "The synthetic cursor tip marks the actual pointer position in image pixels."
        }
        _ => "No pointer overlay is present; use pointer_global to observe the pointer position.",
    };
    let mut data = json!({
        "success": true,
        "screenshot_id": shot.screenshot_id,
        "capture_frame": shot.capture_frame,
        "mime_type": shot.mime_type,
        "image_width": shot.image_width,
        "image_height": shot.image_height,
        "display_width_px": shot.image_width,
        "display_height_px": shot.image_height,
        "native_width": shot.native_width,
        "native_height": shot.native_height,
        "display_origin_x": shot.display_origin_x,
        "display_origin_y": shot.display_origin_y,
        "vision_scale": shot.vision_scale,
        "pointer_image_x": shot.pointer_image_x,
        "pointer_image_y": shot.pointer_image_y,
        "pointer_marker": pointer_marker_note,
        "screenshot_crop_center": shot.screenshot_crop_center,
        "point_crop_half_extent_native": shot.point_crop_half_extent_native,
        "navigation_native_rect": shot.navigation_native_rect,
        "quadrant_navigation_click_ready": shot.quadrant_navigation_click_ready,
        "image_content_rect": shot.image_content_rect,
        "image_global_bounds": shot.image_global_bounds,
        "implicit_confirmation_crop_applied": shot.implicit_confirmation_crop_applied,
        "debug_screenshot_path": debug_rel,
        "ui_tree_text": shot.ui_tree_text,
    });
    if !shot.auxiliary_windows.is_empty() {
        data["auxiliary_windows"] = json!(shot.auxiliary_windows);
    }
    // Preserve legacy result fields, but never instruct the model to send
    // crop/quadrant parameters that parse_screenshot_params now ignores.
    let cropped = !screenshot_covers_full_display(shot);
    let phase = if shot.screenshot_crop_center.is_some() {
        "region_crop"
    } else if shot.quadrant_navigation_click_ready {
        "quadrant_terminal"
    } else if cropped {
        "quadrant_drill"
    } else {
        "full_display"
    };
    let instruction = "Use AX node IDs or OCR text to target controls. mouse_move takes global screen coordinates from tool results with use_screen_coordinates=true; image pixels are a different coordinate space. For app actions that accept image_xy, pass screenshot_id with the coordinates from that image. After an action, follow interaction_state to decide whether to capture again. Screenshot capture prefers the focused application window when available; window=true requests that view explicitly.";
    data["hierarchical_navigation"] = json!({
        "phase": phase,
        "image_is_crop_only": cropped,
        "host_auto_quadrant": false,
        "shortcut_policy": instruction,
        "instruction": if cropped {
            "This image shows a region. image_content_rect is in image pixels; image_global_bounds describes its global screen coverage."
        } else {
            "This image shows the full display. Use the supplied mapping metadata rather than treating image pixels as global coordinates."
        },
    });
    if shot.screenshot_crop_center.is_none() && !shot.quadrant_navigation_click_ready {
        data["recommended_next_for_click_targeting"] =
            json!("move_to_text_then_click_or_mouse_move_screen_globals_then_click");
    }
    let kind = if cropped {
        "Region crop screenshot"
    } else {
        "Full screenshot"
    };
    let hint = format!(
        "{} {}x{}; screenshot_id={}. {}",
        kind,
        shot.image_width,
        shot.image_height,
        shot.screenshot_id.as_deref().unwrap_or("unavailable"),
        instruction,
    );
    (data, hint)
}

pub fn screenshot_covers_full_display(shot: &ComputerScreenshot) -> bool {
    if shot.screenshot_crop_center.is_some() {
        return false;
    }
    match shot.navigation_native_rect {
        None => true,
        Some(n) => {
            n.x0 == 0 && n.y0 == 0 && n.width == shot.native_width && n.height == shot.native_height
        }
    }
}

#[cfg(test)]
mod windows_accelerator_parsing_tests {
    use super::*;

    #[test]
    fn parses_single_modifier() {
        let (mods, key) = parse_windows_accelerator_display("Ctrl+S");
        assert_eq!(mods, vec!["control".to_string()]);
        assert_eq!(key, Some("s".to_string()));
    }

    #[test]
    fn parses_multiple_modifiers_in_order() {
        let (mods, key) = parse_windows_accelerator_display("Ctrl+Shift+S");
        assert_eq!(mods, vec!["control".to_string(), "shift".to_string()]);
        assert_eq!(key, Some("s".to_string()));
    }

    #[test]
    fn parses_alt_function_key() {
        let (mods, key) = parse_windows_accelerator_display("Alt+F4");
        assert_eq!(mods, vec!["alt".to_string()]);
        assert_eq!(key, Some("f4".to_string()));
    }

    #[test]
    fn parses_bare_function_key_with_no_modifiers() {
        let (mods, key) = parse_windows_accelerator_display("F5");
        assert!(mods.is_empty());
        assert_eq!(key, Some("f5".to_string()));
    }

    #[test]
    fn normalizes_special_key_aliases() {
        assert_eq!(
            parse_windows_accelerator_display("Ctrl+Del").1,
            Some("delete".to_string())
        );
        assert_eq!(
            parse_windows_accelerator_display("Esc").1,
            Some("escape".to_string())
        );
        assert_eq!(
            parse_windows_accelerator_display("Ctrl+PgUp").1,
            Some("page_up".to_string())
        );
    }

    #[test]
    fn normalizes_windows_key_modifier_alias() {
        let (mods, key) = parse_windows_accelerator_display("Win+E");
        assert_eq!(mods, vec!["windows".to_string()]);
        assert_eq!(key, Some("e".to_string()));
    }

    #[test]
    fn empty_input_yields_no_shortcut() {
        assert_eq!(parse_windows_accelerator_display(""), (vec![], None));
        assert_eq!(parse_windows_accelerator_display("   "), (vec![], None));
    }
}

#[cfg(test)]
mod tool_body_tests {
    use super::*;
    use serde_json::json;

    fn screenshot() -> ComputerScreenshot {
        ComputerScreenshot {
            capture_frame: None,
            screenshot_id: Some("test-shot".to_string()),
            bytes: vec![1, 2, 3],
            mime_type: "image/jpeg".to_string(),
            image_width: 100,
            image_height: 80,
            native_width: 100,
            native_height: 80,
            display_origin_x: 0,
            display_origin_y: 0,
            vision_scale: 1.0,
            pointer_image_x: Some(10),
            pointer_image_y: Some(11),
            screenshot_crop_center: None,
            point_crop_half_extent_native: None,
            navigation_native_rect: None,
            quadrant_navigation_click_ready: false,
            image_content_rect: Some(ComputerUseImageContentRect {
                left: 1,
                top: 2,
                width: 98,
                height: 76,
            }),
            image_global_bounds: None,
            implicit_confirmation_crop_applied: false,
            ui_tree_text: None,
            auxiliary_windows: Vec::new(),
        }
    }

    #[test]
    fn screenshot_tool_body_preserves_legacy_full_display_shape() {
        let shot = screenshot();
        let (body, hint) = build_screenshot_tool_body_and_hint(&shot, None);

        assert_eq!(body["success"], json!(true));
        assert_eq!(body["mime_type"], json!("image/jpeg"));
        assert_eq!(body["image_width"], json!(100));
        assert_eq!(body["display_width_px"], json!(100));
        assert_eq!(body["native_width"], json!(100));
        assert_eq!(body["display_origin_x"], json!(0));
        assert!(body.get("image_jpeg_width").is_none());
        assert_eq!(
            body["hierarchical_navigation"]["phase"],
            json!("full_display")
        );
        assert_eq!(
            body["recommended_next_for_click_targeting"],
            json!("move_to_text_then_click_or_mouse_move_screen_globals_then_click")
        );
        assert!(hint.contains("Full screenshot"));
        assert!(screenshot_covers_full_display(&shot));
    }

    #[test]
    fn screenshot_tool_body_reports_region_crop_phase() {
        let mut shot = screenshot();
        shot.screenshot_crop_center = Some(ScreenshotCropCenter { x: 45, y: 50 });

        let (body, hint) = build_screenshot_tool_body_and_hint(&shot, Some("debug/a.jpg".into()));

        assert_eq!(
            body["hierarchical_navigation"]["phase"],
            json!("region_crop")
        );
        assert_eq!(body["debug_screenshot_path"], json!("debug/a.jpg"));
        assert!(body.get("recommended_next_for_click_targeting").is_none());
        assert!(hint.contains("Region crop screenshot"));
        assert!(!screenshot_covers_full_display(&shot));
    }

    #[test]
    fn screenshot_context_preserves_identity_and_does_not_recommend_ignored_inputs() {
        let shot = screenshot();
        let (body, hint) = build_screenshot_tool_body_and_hint(&shot, None);
        assert_eq!(body["screenshot_id"], "test-shot");
        let all_text = format!("{body}{hint}");
        for obsolete in [
            "screenshot_navigate_quadrant",
            "screenshot_reset_navigation",
            "screenshot_implicit_center",
        ] {
            assert!(
                !all_text.contains(obsolete),
                "recommends ignored parameter {obsolete}"
            );
        }
    }

    #[test]
    fn legacy_screenshot_round_trip_preserves_optional_context() {
        let mut payload = serde_json::to_value(screenshot()).unwrap();
        payload.as_object_mut().unwrap().remove("screenshot_id");
        payload["future_field"] = json!({"version":2});
        let old: ComputerScreenshot = serde_json::from_value(payload).unwrap();
        assert_eq!(old.screenshot_id, None);
        assert_eq!(old.capture_frame, None);
        let restored: ComputerScreenshot =
            serde_json::from_value(serde_json::to_value(&old).unwrap()).unwrap();
        assert_eq!(old, restored);
    }

    #[test]
    fn retained_frame_recency_round_trips_and_reaches_tool_output() {
        let mut shot = screenshot();
        shot.capture_frame = Some(CaptureFrameInfo {
            age_ms: 1234,
            reused: true,
        });
        let payload = serde_json::to_value(&shot).unwrap();
        assert_eq!(
            serde_json::from_value::<ComputerScreenshot>(payload).unwrap(),
            shot
        );
        let (body, _) = build_screenshot_tool_body_and_hint(&shot, None);
        assert_eq!(body["capture_frame"], json!({"age_ms":1234,"reused":true}));
    }

    #[test]
    fn legacy_interactive_view_defaults_omission_count_and_round_trips() {
        let mut view: InteractiveView = serde_json::from_value(json!({
            "app":{"name":"Fixture", "running":true}, "elements":[], "digest":"old", "captured_at_ms":0
        })).unwrap();
        assert_eq!(view.omitted_element_count, 0);
        view.omitted_element_count = 12;
        let restored: InteractiveView =
            serde_json::from_value(serde_json::to_value(&view).unwrap()).unwrap();
        assert_eq!(view, restored);
    }
}

#[cfg(test)]
mod app_input_program_tests {
    #[test]
    fn legacy_app_observation_omits_identity_without_losing_content() {
        let old = serde_json::json!({"app":{"name":"Editor","pid":7,"running":true},"tree_text":"[0] Button","digest":"same-content","captured_at_ms":1});
        let snapshot: super::AppStateSnapshot = serde_json::from_value(old).unwrap();
        assert!(snapshot.observation_id.is_none());
        let round: super::AppStateSnapshot =
            serde_json::from_value(serde_json::to_value(&snapshot).unwrap()).unwrap();
        assert_eq!(snapshot, round);
    }

    #[test]
    fn all_program_targets_are_validated_before_native_dispatch() {
        for value in [
            serde_json::json!({"action":"app_click","target":{"kind":"image_xy","x":1,"y":1}}),
            serde_json::json!({"action":"app_type_text","text":"x","focus":{"kind":"ocr_text","needle":" "}}),
            serde_json::json!({"action":"app_scroll","dx":0,"dy":1,"focus":{"kind":"image_grid","x0":2147483647,"y0":0,"width":2,"height":1,"rows":1,"cols":1,"row":0,"col":0,"screenshot_id":"shot"}}),
        ] {
            let input: super::AppInputAction = serde_json::from_value(value).unwrap();
            assert!(input.validate().is_err());
        }
    }

    use super::*;
    use serde_json::json;

    #[test]
    fn legacy_click_program_defaults_optional_wait_and_round_trips() {
        let old = json!({"action":"app_click","target":{"kind":"node_idx","idx":17}});
        let step: AppInputAction = serde_json::from_value(old).unwrap();
        assert!(matches!(
            &step,
            AppInputAction::Click {
                wait_ms_after: None,
                ..
            }
        ));
        let written = serde_json::to_value(&step).unwrap();
        assert!(written.get("wait_ms_after").is_none());
        assert_eq!(
            serde_json::from_value::<AppInputAction>(written).unwrap(),
            step
        );
    }

    #[test]
    fn steps_cannot_retarget_or_escalate_control() {
        for step in [
            json!({"action":"app_type_text","text":"test","app":{"pid":99}}),
            json!({"action":"app_click","target":{"kind":"node_idx","idx":1},"mode":"foreground"}),
            json!({"action":"start_control","mode":"foreground"}),
        ] {
            assert!(serde_json::from_value::<AppInputAction>(step).is_err());
        }
    }

    #[test]
    fn drag_requires_one_observed_coordinate_basis() {
        let mut step = json!({"action":"app_drag",
            "from":{"kind":"image_xy","x":10,"y":20,"screenshot_id":"frame-a"},
            "to":{"kind":"image_xy","x":80,"y":90,"screenshot_id":"frame-a"}});
        assert!(serde_json::from_value::<AppInputAction>(step.clone())
            .unwrap()
            .validate()
            .is_ok());
        step["to"]["screenshot_id"] = json!("frame-b");
        assert!(serde_json::from_value::<AppInputAction>(step.clone())
            .unwrap()
            .validate()
            .is_err());
        step["to"].as_object_mut().unwrap().remove("screenshot_id");
        assert!(serde_json::from_value::<AppInputAction>(step)
            .unwrap()
            .validate()
            .is_err());
    }
}

#[cfg(test)]
mod settle_and_overlay_tests {
    use super::*;
    use serde_json::json;

    const POLICY: AppInputSettlePolicy = AppInputSettlePolicy {
        quiet_ms: 250,
        first_change_ms: 400,
        max_ms: 2000,
    };

    #[test]
    fn settles_after_quiet_interval_once_a_change_was_seen() {
        assert_eq!(app_input_settle_decision(POLICY, 300, Some(100)), None);
        assert_eq!(
            app_input_settle_decision(POLICY, 350, Some(100)),
            Some(AppInputSettleStatus::Stable)
        );
        assert_eq!(app_input_settle_next_wait_ms(POLICY, 300, Some(100)), 50);
    }

    #[test]
    fn unchanged_window_settles_after_first_change_window() {
        assert_eq!(app_input_settle_decision(POLICY, 399, None), None);
        assert_eq!(
            app_input_settle_decision(POLICY, 400, None),
            Some(AppInputSettleStatus::Stable)
        );
        assert_eq!(app_input_settle_next_wait_ms(POLICY, 390, None), 10);
    }

    #[test]
    fn continuous_repaint_reports_still_changing_at_the_cap() {
        assert_eq!(app_input_settle_decision(POLICY, 1990, Some(1900)), None);
        assert_eq!(
            app_input_settle_decision(POLICY, 2000, Some(1950)),
            Some(AppInputSettleStatus::StillChanging)
        );
        assert_eq!(app_input_settle_next_wait_ms(POLICY, 1990, Some(1900)), 10);
        assert_eq!(app_input_settle_next_wait_ms(POLICY, 0, None), 100);
        assert_eq!(app_input_settle_next_wait_ms(POLICY, 5000, Some(10)), 1);
    }

    #[test]
    fn settle_receipt_uses_snake_case_and_omits_unknown_fields() {
        let settle = AppInputSettle::skipped();
        let value = serde_json::to_value(&settle).unwrap();
        assert_eq!(value["status"], "skipped");
        let unavailable = AppInputSettle::unavailable("no stream");
        let value = serde_json::to_value(&unavailable).unwrap();
        assert_eq!(value["status"], "unavailable");
        assert_eq!(value["reason"], "no stream");
        let stable: AppInputSettle =
            serde_json::from_value(json!({"status":"still_changing","waited_ms":2000})).unwrap();
        assert_eq!(stable.status, AppInputSettleStatus::StillChanging);
        assert_eq!(stable.changed, None);
    }

    #[test]
    fn legacy_window_inventory_without_bounds_round_trips() {
        let old = json!({"pid":7,"window_id":11,"application":"Editor","title":"Doc"});
        let window: AppWindowInfo = serde_json::from_value(old.clone()).unwrap();
        assert!(window.bounds.is_none());
        assert_eq!(serde_json::to_value(&window).unwrap(), old);
    }

    #[test]
    fn window_query_matches_application_bundle_or_title_case_insensitively() {
        let window = |application: &str, bundle_id: Option<&str>, title: &str| AppWindowInfo {
            pid: 1,
            window_id: 1,
            application: application.into(),
            title: title.into(),
            bundle_id: bundle_id.map(Into::into),
            is_on_screen: Some(true),
            bounds: None,
        };
        let helper = window("WeChatAppEx", Some("com.tencent.flue.WeChatAppEx"), "");
        let host = window("WeChat", Some("com.tencent.xinWeChat"), "羊了个羊：星球");
        assert!(helper.matches_query("wechat"));
        assert!(host.matches_query(" WECHAT "));
        assert!(host.matches_query("羊了个羊"));
        assert!(helper.matches_query("flue"));
        assert!(!helper.matches_query("羊了个羊"));
        assert!(!host.matches_query("   "));
        assert!(!window("Finder", None, "").matches_query("wechat"));
    }

    #[test]
    fn discovery_order_puts_visible_titled_large_windows_first_without_dropping() {
        let window = |id: u64, title: &str, on_screen: Option<bool>, size: f64| AppWindowInfo {
            pid: 1,
            window_id: id,
            application: "App".into(),
            title: title.into(),
            bundle_id: None,
            is_on_screen: on_screen,
            bounds: Some(ComputerUseImageGlobalBounds {
                left: 0.0,
                top: 0.0,
                width: size,
                height: size,
            }),
        };
        let mut windows = vec![
            window(1, "", Some(true), 20.0),
            window(2, "Hidden", Some(false), 900.0),
            window(3, "Small", Some(true), 100.0),
            window(4, "Main", Some(true), 800.0),
            window(5, "Unknown", None, 500.0),
        ];
        AppWindowInfo::sort_for_discovery(&mut windows);
        let order: Vec<u64> = windows.iter().map(|window| window.window_id).collect();
        assert_eq!(order, [4, 3, 1, 2, 5]);
    }

    #[test]
    fn legacy_screenshot_without_auxiliary_windows_round_trips() {
        let old = json!({
            "bytes": [], "mime_type": "image/jpeg", "image_width": 10, "image_height": 10,
            "native_width": 10, "native_height": 10, "display_origin_x": 0, "display_origin_y": 0,
            "vision_scale": 1.0
        });
        let shot: ComputerScreenshot = serde_json::from_value(old).unwrap();
        assert!(shot.auxiliary_windows.is_empty());
        let value = serde_json::to_value(&shot).unwrap();
        assert!(value.get("auxiliary_windows").is_none());
        let round: ComputerScreenshot = serde_json::from_value(value).unwrap();
        assert_eq!(shot, round);
    }

    #[test]
    fn auxiliary_window_metadata_serializes_minimal_shape() {
        let window = ComputerUseAuxiliaryWindow {
            window_id: 9,
            image_rect: ComputerUseImageContentRect {
                left: 1,
                top: 2,
                width: 3,
                height: 4,
            },
            global_bounds: ComputerUseImageGlobalBounds {
                left: 10.0,
                top: 20.0,
                width: 3.0,
                height: 4.0,
            },
            composited: true,
            clipped: false,
            layer: None,
            title: None,
            unavailable_reason: None,
        };
        let value = serde_json::to_value(&window).unwrap();
        assert_eq!(
            value,
            json!({"window_id":9,"image_rect":{"left":1,"top":2,"width":3,"height":4},
                "global_bounds":{"left":10.0,"top":20.0,"width":3.0,"height":4.0},"composited":true})
        );
        let round: ComputerUseAuxiliaryWindow = serde_json::from_value(value).unwrap();
        assert_eq!(round, window);
    }
}
