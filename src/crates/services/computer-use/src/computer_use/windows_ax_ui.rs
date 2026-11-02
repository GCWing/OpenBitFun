//! Windows UI Automation (UIA) tree walk for stable screen coordinates.
//!
//! Ported from cua-driver-rs v0.6.8 (`platform-windows/src/uia/mod.rs`):
//!   * `IUIAutomationCacheRequest` batches every property + pattern fetch into
//!     a single cross-process RPC (one `BuildUpdatedCache` instead of N
//!     per-property `CurrentXxx()` calls — Chrome's ~5000-node tree drops from
//!     >4s to a few hundred ms).
//!   * `ControlViewCondition()` filter skips decorative / raw-view nodes.
//!   * Full indexed tree (`Vec<UiaNode>`) with COM element-pointer retention
//!     (owned COM references) for later pattern dispatch.
//!   * `detect_cached_actions` probes cached patterns (Invoke / Toggle /
//!     SelectionItem / ExpandCollapse / Value / RangeValue / Text / Scroll).
//!   * Transient `E_FAIL` provider errors retried (3 attempts, 40ms backoff).
//!
//! Every provider call runs on one dedicated MTA thread, including locate,
//! hit-testing and shortcut discovery. Callers have a deadline independent of
//! COM timeouts; a blocked provider retains its slot until it really returns.

// Symbols here are wired up by the desktop host / ControlHub dispatch layer in a
// follow-up step. Until then, suppress dead-code lints without weakening real
// warnings elsewhere.
#![allow(dead_code)]

use super::ax_snapshot_digest::compute_digest;
use crate::computer_use::ui_locate_common;
use openbitfun_agent_tools::computer_use_host::error::{OpenBitFunError, OpenBitFunResult};
use openbitfun_agent_tools::computer_use_host::{
    AppInfo, AppStateSnapshot, AxNode, OcrAccessibilityHit, UiElementLocateQuery,
    UiElementLocateResult,
};
use windows::core::Interface;
use windows::Win32::Foundation::HWND;
use windows::Win32::System::Com::{
    CoCreateInstance, CoInitializeEx, CLSCTX_INPROC_SERVER, COINIT_MULTITHREADED,
};
use windows::Win32::UI::Accessibility::{
    CUIAutomation8, IUIAutomation, IUIAutomation2, IUIAutomationCacheRequest, IUIAutomationElement,
    IUIAutomationValuePattern, TreeScope_Subtree, UIA_AutomationIdPropertyId,
    UIA_BoundingRectanglePropertyId, UIA_ControlTypePropertyId, UIA_ExpandCollapsePatternId,
    UIA_HelpTextPropertyId, UIA_InvokePatternId, UIA_IsEnabledPropertyId,
    UIA_IsOffscreenPropertyId, UIA_NamePropertyId, UIA_RangeValuePatternId, UIA_ScrollPatternId,
    UIA_SelectionItemPatternId, UIA_TextPatternId, UIA_TogglePatternId, UIA_ValuePatternId,
};
use windows::Win32::UI::WindowsAndMessaging::{
    GetForegroundWindow, GetWindowThreadProcessId, IsWindow,
};

/// Transient-provider retry count for `BuildUpdatedCache`.
const BUILD_CACHE_MAX_ATTEMPTS: u32 = 3;
/// Backoff between `BuildUpdatedCache` retries (milliseconds).
const BUILD_CACHE_BACKOFF_MS: u64 = 40;

/// A single node in the UIA accessibility tree.
///
/// Owns retained COM references. Observation and semantic action cache entries
/// are created and released on the dedicated UIA worker apartment.
#[derive(Clone)]
pub(super) struct UiaNode {
    /// Dense index assigned only to actionable elements (`[N]` in the tree
    /// text). `None` for non-actionable content-only nodes.
    pub element_index: Option<usize>,
    pub control_type: String,
    pub name: Option<String>,
    pub value: Option<String>,
    pub automation_id: Option<String>,
    pub help_text: Option<String>,
    pub actions: Vec<String>,
    /// UIA or legacy MSAA interface retained without leaking a raw pointer.
    pub element: Option<windows::core::IUnknown>,
    /// Screen-coordinate center, captured at walk time to avoid later COM calls.
    pub center_x: i32,
    pub center_y: i32,
    /// Full screen-coord rect `(left, top, right, bottom)`.
    pub rect: Option<(i32, i32, i32, i32)>,
    /// MSAA role code; `None` on the UIA primary path.
    pub msaa_role: Option<i32>,
    /// Depth in the rendered tree (matches indent level).
    pub depth: usize,
    /// `element_index` of the nearest actionable ancestor, if any.
    pub parent_element_index: Option<usize>,
    /// Cached `UIA_IsEnabled`. Feeds [`AxNode::enabled`] on conversion.
    pub enabled: bool,
    pub focused: bool,
    pub selected: Option<bool>,
    pub expanded: Option<bool>,
}

impl UiaNode {
    /// Convert to OpenBitFun's [`AxNode`] for `get_app_state` integration.
    ///
    /// `idx` / `parent_idx` are supplied by the caller because `AxNode` uses a
    /// dense `u32` index over the *rendered* tree (including content-only
    /// nodes), whereas [`UiaNode::element_index`] only numbers actionable
    /// elements. The integration wiring is responsible for the dense
    /// re-indexing when `get_app_state` is connected on Windows.
    fn to_ax_node(&self, idx: u32, parent_idx: Option<u32>) -> AxNode {
        let frame_global = self
            .rect
            .map(|(l, t, r, b)| (l as f64, t as f64, (r - l) as f64, (b - t) as f64));
        AxNode {
            idx,
            parent_idx,
            role: self.control_type.clone(),
            title: self.name.clone(),
            value: self.value.clone(),
            description: None,
            identifier: self.automation_id.clone(),
            enabled: self.enabled,
            focused: self.focused,
            selected: self.selected,
            frame_global,
            actions: self.actions.clone(),
            role_description: None,
            subrole: None,
            help: self.help_text.clone(),
            url: None,
            expanded: self.expanded,
        }
    }
}

fn bstr_to_string(b: windows::core::BSTR) -> String {
    b.to_string()
}

fn localized_control_type_string(elem: &IUIAutomationElement) -> String {
    unsafe {
        elem.CurrentLocalizedControlType()
            .map(bstr_to_string)
            .unwrap_or_default()
    }
}

// ── Cache build ────────────────────────────────────────────────────────────

/// Build a cache request that pre-fetches every property + pattern we later
/// read, so the walk itself issues zero cross-process RPCs.
unsafe fn build_cache_request(
    automation: &IUIAutomation,
) -> OpenBitFunResult<IUIAutomationCacheRequest> {
    // SAFETY: `automation` is a live UI Automation COM interface and all ids
    // supplied below are documented properties, patterns, scopes, or filters.
    let cache_req = unsafe { automation.CreateCacheRequest() }
        .map_err(|e| OpenBitFunError::tool(format!("UI Automation CreateCacheRequest: {}.", e)))?;

    // Properties to pre-fetch (typed cached accessors read these).
    for prop in [
        UIA_ControlTypePropertyId,
        UIA_NamePropertyId,
        UIA_AutomationIdPropertyId,
        UIA_HelpTextPropertyId,
        UIA_IsEnabledPropertyId,
        UIA_IsOffscreenPropertyId,
        UIA_BoundingRectanglePropertyId,
        windows::Win32::UI::Accessibility::UIA_HasKeyboardFocusPropertyId,
        windows::Win32::UI::Accessibility::UIA_ValueValuePropertyId,
        windows::Win32::UI::Accessibility::UIA_ToggleToggleStatePropertyId,
        windows::Win32::UI::Accessibility::UIA_SelectionItemIsSelectedPropertyId,
        windows::Win32::UI::Accessibility::UIA_ExpandCollapseExpandCollapseStatePropertyId,
    ] {
        let _ = unsafe { cache_req.AddProperty(prop) };
    }

    // Patterns to pre-fetch (for action detection + Value read).
    for pat in [
        UIA_InvokePatternId,
        UIA_TogglePatternId,
        UIA_SelectionItemPatternId,
        UIA_ExpandCollapsePatternId,
        UIA_ValuePatternId,
        UIA_RangeValuePatternId,
        UIA_TextPatternId,
        UIA_ScrollPatternId,
    ] {
        let _ = unsafe { cache_req.AddPattern(pat) };
    }

    // Fetch the entire subtree in one bulk RPC.
    let _ = unsafe { cache_req.SetTreeScope(TreeScope_Subtree) };

    // Control-view filter (same set ControlViewWalker would walk) — drops
    // decorative / raw-view nodes that only add noise.
    if let Ok(ctrl_cond) = unsafe { automation.ControlViewCondition() } {
        let _ = unsafe { cache_req.SetTreeFilter(&ctrl_cond) };
    }

    Ok(cache_req)
}

/// `BuildUpdatedCache` with a short retry loop. A single transient provider
/// error (commonly `E_FAIL` / `0x80004005` from a control rebuilding its
/// automation subtree mid-walk) must not take down the whole snapshot — the
/// same call usually succeeds a beat later. See cua #1881.
pub(crate) unsafe fn build_updated_cache_with_retry(
    uncached: &IUIAutomationElement,
    cache_req: &IUIAutomationCacheRequest,
) -> OpenBitFunResult<IUIAutomationElement> {
    let mut attempt = 0u32;
    loop {
        // SAFETY: both COM interfaces are live for the call and `cache_req`
        // was constructed by the same UI Automation instance.
        checkpoint("build_updated_cache")?;
        match unsafe { uncached.BuildUpdatedCache(cache_req) } {
            Ok(e) => return Ok(e),
            Err(e) => {
                attempt += 1;
                if attempt >= BUILD_CACHE_MAX_ATTEMPTS
                    || e.code() != windows::Win32::Foundation::E_FAIL
                {
                    return Err(OpenBitFunError::tool(format!(
                        "UI Automation BuildUpdatedCache failed after {} attempts: {}.",
                        attempt, e
                    )));
                }
                log::debug!(
                    "UIA BuildUpdatedCache transient error (attempt {}): {}; retrying in {}ms",
                    attempt,
                    e,
                    BUILD_CACHE_BACKOFF_MS
                );
                std::thread::sleep(std::time::Duration::from_millis(BUILD_CACHE_BACKOFF_MS));
            }
        }
    }
}

// ── Cached property readers ─────────────────────────────────────────────────
//
// Every reader calls a `CachedXxx` accessor (or `GetCachedPatternAs`) which
// reads from the element's local cache populated by `BuildUpdatedCache`. No
// cross-process RPC is issued during the walk.

fn read_cached_control_type(element: &IUIAutomationElement) -> String {
    unsafe {
        element
            .CachedControlType()
            .ok()
            .map(|ct| control_type_name(ct.0))
            .unwrap_or_else(|| "Unknown".to_string())
    }
}

fn read_cached_name(element: &IUIAutomationElement) -> Option<String> {
    unsafe {
        let bstr = element.CachedName().ok()?;
        let s = bstr.to_string();
        if s.trim().is_empty() {
            None
        } else {
            Some(s)
        }
    }
}

fn read_cached_automation_id(element: &IUIAutomationElement) -> Option<String> {
    unsafe {
        let bstr = element.CachedAutomationId().ok()?;
        let s = bstr.to_string();
        if s.trim().is_empty() {
            None
        } else {
            Some(s)
        }
    }
}

fn read_cached_help_text(element: &IUIAutomationElement) -> Option<String> {
    unsafe {
        let bstr = element.CachedHelpText().ok()?;
        let s = bstr.to_string();
        if s.trim().is_empty() {
            None
        } else {
            Some(s)
        }
    }
}

/// Read `ValuePattern.Value` via the cached pattern (no VARIANT needed).
fn read_cached_value(element: &IUIAutomationElement) -> Option<String> {
    unsafe {
        let vp = element
            .GetCachedPatternAs::<IUIAutomationValuePattern>(UIA_ValuePatternId)
            .ok()?;
        let bstr = vp.CachedValue().ok()?;
        let s = bstr.to_string();
        if s.trim().is_empty() {
            None
        } else {
            Some(s)
        }
    }
}

fn read_cached_is_enabled(element: &IUIAutomationElement) -> bool {
    unsafe {
        element
            .CachedIsEnabled()
            .ok()
            .map(|b| b.0 != 0)
            .unwrap_or(true)
    }
}

fn read_cached_is_offscreen(element: &IUIAutomationElement) -> bool {
    unsafe {
        element
            .CachedIsOffscreen()
            .ok()
            .map(|b| b.0 != 0)
            .unwrap_or(false)
    }
}

/// Read bounding rect as `(center_x, center_y, Some((l, t, r, b)))`. Returns
/// `rect=None` when the element has no meaningful `BoundingRectangle`.
type CachedBoundingRect = (i32, i32, Option<(i32, i32, i32, i32)>);

fn read_cached_bounding_rect_full(element: &IUIAutomationElement) -> CachedBoundingRect {
    unsafe {
        match element.CachedBoundingRectangle() {
            Ok(r) if r.right > r.left && r.bottom > r.top => (
                (r.left + r.right) / 2,
                (r.top + r.bottom) / 2,
                Some((r.left, r.top, r.right, r.bottom)),
            ),
            _ => (0, 0, None),
        }
    }
}

/// Probe cached patterns to enumerate the actions an element supports. Each
/// `GetCachedPattern` is an in-process vtable read from the element's cache
/// (no cross-process RPC), so calling it 8 times per element is cheap.
fn detect_cached_actions(element: &IUIAutomationElement, is_enabled: bool) -> Vec<String> {
    if !is_enabled {
        return vec![];
    }
    let mut actions = Vec::new();
    unsafe {
        if element.GetCachedPattern(UIA_InvokePatternId).is_ok() {
            actions.push("invoke".to_string());
        }
        if element.GetCachedPattern(UIA_TogglePatternId).is_ok() {
            actions.push("toggle".to_string());
        }
        if element.GetCachedPattern(UIA_SelectionItemPatternId).is_ok() {
            actions.push("select".to_string());
        }
        if element
            .GetCachedPattern(UIA_ExpandCollapsePatternId)
            .is_ok()
        {
            actions.push("expand".to_string());
        }
        if element.GetCachedPattern(UIA_ValuePatternId).is_ok() {
            actions.push("set_value".to_string());
        }
        // RangeValuePattern is exposed by Sliders / ProgressBars. Without this
        // entry the slider parent gets actions=[] → no `[N]` index, making it
        // unaddressable by AutomationId.
        if element.GetCachedPattern(UIA_RangeValuePatternId).is_ok() {
            actions.push("set_value".to_string());
        }
        if element.GetCachedPattern(UIA_TextPatternId).is_ok() {
            actions.push("text".to_string());
        }
        if element.GetCachedPattern(UIA_ScrollPatternId).is_ok() {
            actions.push("scroll".to_string());
        }
    }
    actions
}

/// Map a UIA control-type id to a stable name. Matches the table in
/// cua-driver-rs (literal numeric ids kept for parity with the proven port).
fn control_type_name(id: i32) -> String {
    match id {
        50000 => "Button",
        50001 => "Calendar",
        50002 => "CheckBox",
        50003 => "ComboBox",
        50004 => "Edit",
        50005 => "Hyperlink",
        50006 => "Image",
        50007 => "ListItem",
        50008 => "List",
        50009 => "Menu",
        50010 => "MenuBar",
        50011 => "MenuItem",
        50012 => "ProgressBar",
        50013 => "RadioButton",
        50014 => "ScrollBar",
        50015 => "Slider",
        50016 => "Spinner",
        50017 => "StatusBar",
        50018 => "Tab",
        50019 => "TabItem",
        50020 => "Text",
        50021 => "ToolBar",
        50022 => "ToolTip",
        50023 => "Tree",
        50024 => "TreeItem",
        50025 => "Custom",
        50026 => "Group",
        50027 => "Thumb",
        50028 => "DataGrid",
        50029 => "DataItem",
        50030 => "Document",
        50031 => "SplitButton",
        50032 => "Window",
        50033 => "Pane",
        50034 => "Header",
        50035 => "HeaderItem",
        50036 => "Table",
        50037 => "TitleBar",
        50038 => "Separator",
        50039 => "SemanticZoom",
        50040 => "AppBar",
        _ => "Unknown",
    }
    .to_string()
}

// ── Tree walk ───────────────────────────────────────────────────────────────

/// Core walk: COM init → cache request → `ElementFromHandle` →
/// `BuildUpdatedCache` (retried) → recursive cached traversal → render.
unsafe fn walk_tree_full(
    hwnd: windows::Win32::Foundation::HWND,
    max_elements: usize,
    max_depth: usize,
) -> OpenBitFunResult<(String, Vec<UiaNode>)> {
    let automation = create_automation()?;

    let cache_req = unsafe { build_cache_request(&automation) }?;

    // SAFETY: `hwnd` is the caller-provided target handle. UIA reports an
    // error for an invalid or stale handle, which is propagated here.
    checkpoint("element_from_handle")?;
    let uncached = unsafe { automation.ElementFromHandle(hwnd) }.map_err(|e| {
        OpenBitFunError::tool(format!("UI Automation ElementFromHandle failed: {}.", e))
    })?;

    let root_elem = unsafe { build_updated_cache_with_retry(&uncached, &cache_req) }?;

    let mut nodes: Vec<UiaNode> = Vec::new();
    let mut lines: Vec<(usize, String)> = Vec::new();
    let mut counter = 0usize;
    let mut total = 0usize;
    unsafe {
        walk_cached_bounded(
            &root_elem,
            0,
            None,
            &mut nodes,
            &mut lines,
            &mut counter,
            &mut total,
            max_elements,
            max_depth,
        )
    };

    let tree_text = render_lines(&lines);
    Ok((tree_text, nodes))
}

#[allow(clippy::too_many_arguments)]
unsafe fn walk_cached_bounded(
    element: &IUIAutomationElement,
    depth: usize,
    parent_index: Option<usize>,
    nodes: &mut Vec<UiaNode>,
    lines: &mut Vec<(usize, String)>,
    counter: &mut usize,
    total: &mut usize,
    max_elements: usize,
    max_depth: usize,
) {
    if depth > max_depth
        || *total >= max_elements
        || request_checkpoint("walk_cached_tree").is_err()
    {
        return;
    }
    *total += 1;

    let control_type = read_cached_control_type(element);
    let name = read_cached_name(element);
    let value = read_cached_value(element).or_else(|| unsafe {
        use windows::Win32::UI::Accessibility::*;
        let state = element
            .GetCachedPatternAs::<IUIAutomationTogglePattern>(UIA_TogglePatternId)
            .ok()?
            .CachedToggleState()
            .ok()?;
        Some(
            if state == ToggleState_On {
                "on"
            } else if state == ToggleState_Off {
                "off"
            } else {
                "mixed"
            }
            .into(),
        )
    });
    let focused = unsafe {
        element
            .CachedHasKeyboardFocus()
            .map(|v| v.as_bool())
            .unwrap_or(false)
    };
    let selected = unsafe {
        use windows::Win32::UI::Accessibility::*;
        element
            .GetCachedPatternAs::<IUIAutomationSelectionItemPattern>(UIA_SelectionItemPatternId)
            .ok()
            .and_then(|p| p.CachedIsSelected().ok())
            .map(|v| v.as_bool())
    };
    let expanded = unsafe {
        use windows::Win32::UI::Accessibility::*;
        element
            .GetCachedPatternAs::<IUIAutomationExpandCollapsePattern>(UIA_ExpandCollapsePatternId)
            .ok()
            .and_then(|p| p.CachedExpandCollapseState().ok())
            .map(|v| v == ExpandCollapseState_Expanded)
    };
    let automation_id = read_cached_automation_id(element);
    let help_text = read_cached_help_text(element);
    let enabled = read_cached_is_enabled(element);
    let offscreen = read_cached_is_offscreen(element);

    let actions = detect_cached_actions(element, enabled);
    let is_actionable = !actions.is_empty() && enabled && !offscreen;
    let has_content = name
        .as_deref()
        .map(|s| !s.trim().is_empty())
        .unwrap_or(false)
        || value
            .as_deref()
            .map(|s| !s.trim().is_empty())
            .unwrap_or(false);

    let mut emitted_parent = parent_index;
    if is_actionable || has_content {
        // Read the bounding rect for content-only nodes too, so text/role
        // locate-by-filter can still resolve a click center (cua only reads it
        // for actionable nodes; OpenBitFun's `locate_ui_element_center` needs it).
        let (center_x, center_y, rect) = read_cached_bounding_rect_full(element);

        let node = if is_actionable {
            let idx = *counter;
            *counter += 1;
            emitted_parent = Some(idx);
            UiaNode {
                element_index: Some(idx),
                control_type: control_type.clone(),
                name: name.clone(),
                value: value.clone(),
                automation_id: automation_id.clone(),
                help_text: help_text.clone(),
                actions: actions.clone(),
                element: element.cast().ok(),
                center_x,
                center_y,
                rect,
                msaa_role: None,
                depth,
                parent_element_index: parent_index,
                enabled,
                focused,
                selected,
                expanded,
            }
        } else {
            UiaNode {
                element_index: None,
                control_type: control_type.clone(),
                name: name.clone(),
                value: value.clone(),
                automation_id: automation_id.clone(),
                help_text: help_text.clone(),
                actions: vec![],
                element: element.cast().ok(),
                center_x,
                center_y,
                rect,
                msaa_role: None,
                depth,
                parent_element_index: parent_index,
                enabled,
                focused,
                selected,
                expanded,
            }
        };

        lines.push((depth, format_node_line(&node)));
        nodes.push(node);
    }

    // Recurse using cached children — zero additional cross-process RPCs.
    // SAFETY: `element` is a live cached UIA element, and child indices are
    // bounded by the array length returned by UI Automation.
    if let Ok(children) = unsafe { element.GetCachedChildren() } {
        let len = unsafe { children.Length() }.unwrap_or(0);
        for i in 0..len {
            if let Ok(child) = unsafe { children.GetElement(i) } {
                unsafe {
                    walk_cached_bounded(
                        &child,
                        depth + 1,
                        emitted_parent,
                        nodes,
                        lines,
                        counter,
                        total,
                        max_elements,
                        max_depth,
                    )
                };
            }
        }
    }
}

// ── Rendering ──────────────────────────────────────────────────────────────

/// Format one node as a cua-style tree line:
///   `- [N] ControlType "Name" [value="…" id=… help="…" actions=[…]]`
///   `- ControlType "Name" = "Value"` (non-indexed read-only elements)
pub(crate) fn format_node_line(node: &UiaNode) -> String {
    let mut s = String::new();
    if let Some(idx) = node.element_index {
        s.push_str(&format!("- [{}] {}", idx, node.control_type));
        if let Some(n) = &node.name {
            s.push_str(&format!(" \"{}\"", n));
        }
        let mut attrs = Vec::new();
        if let Some(v) = &node.value {
            attrs.push(format!("value=\"{}\"", v));
        }
        if let Some(id) = &node.automation_id {
            attrs.push(format!("id={}", id));
        }
        if let Some(h) = &node.help_text {
            attrs.push(format!("help=\"{}\"", h));
        }
        if !node.actions.is_empty() {
            attrs.push(format!("actions=[{}]", node.actions.join(",")));
        }
        if !attrs.is_empty() {
            s.push_str(&format!(" [{}]", attrs.join(" ")));
        }
    } else {
        s.push_str(&format!("- {}", node.control_type));
        if let Some(n) = &node.name {
            s.push_str(&format!(" \"{}\"", n));
        }
        if let Some(v) = &node.value {
            s.push_str(&format!(" = \"{}\"", v));
        }
    }
    s
}

fn render_lines(lines: &[(usize, String)]) -> String {
    let mut out = String::new();
    for (depth, line) in lines {
        for _ in 0..*depth {
            out.push_str("  ");
        }
        out.push_str(line);
        out.push('\n');
    }
    out
}

/// Render tree text directly from a `UiaNode` vector (used by the MSAA
/// fallback, which returns nodes without a pre-rendered line list). Indents by
/// each node's `depth` and reuses [`format_node_line`] for parity with the UIA
/// primary path.
pub(crate) fn render_nodes_text(nodes: &[UiaNode]) -> String {
    let lines: Vec<(usize, String)> = nodes
        .iter()
        .map(|n| (n.depth, format_node_line(n)))
        .collect();
    render_lines(&lines)
}

// ── Locate (cached approach) ────────────────────────────────────────────────

/// Build a locate result from a walked node's retained rect + metadata.
fn center_result_from_node(
    node: &UiaNode,
    matched_node_idx: Option<u32>,
    matched_via: &str,
) -> OpenBitFunResult<UiElementLocateResult> {
    let (l, t, r, b) = node.rect.ok_or_else(|| {
        OpenBitFunError::tool(format!(
            "Matched UI element \"{}\" has no usable bounding rectangle.",
            node.name.as_deref().unwrap_or(node.control_type.as_str())
        ))
    })?;
    let gx = (l + r) as f64 / 2.0;
    let gy = (t + b) as f64 / 2.0;
    let bl = l as f64;
    let bt = t as f64;
    let bw = (r - l) as f64;
    let bh = (b - t) as f64;
    ui_locate_common::ok_result_with_context_full(
        gx,
        gy,
        bl,
        bt,
        bw,
        bh,
        node.control_type.clone(),
        node.name.clone(),
        node.automation_id.clone(),
        None,
        1,
        vec![],
        matched_node_idx,
        Some(matched_via.to_string()),
    )
}

/// Foreground window root, then a cached control-view UIA tree walk.
///
/// Uses the batched cache path internally (one `BuildUpdatedCache` RPC for the
/// whole subtree, then in-process cached reads). `node_idx` is now supported
/// because the cached walk produces a real indexed tree (previously
/// Windows-only-`text_contains`/`title_contains`+`role_substring`).
pub(super) fn locate_ui_element_center(
    query: &UiElementLocateQuery,
) -> OpenBitFunResult<UiElementLocateResult> {
    let hwnd = unsafe { GetForegroundWindow() };
    let mut pid = 0;
    unsafe {
        GetWindowThreadProcessId(hwnd, Some(&mut pid));
    }
    locate_ui_element_center_for_window(hwnd.0 as isize, pid, query)
}

fn target_window_matches(hwnd: HWND, expected_pid: u32) -> bool {
    if expected_pid == 0 || hwnd.is_invalid() || !unsafe { IsWindow(Some(hwnd)) }.as_bool() {
        return false;
    }
    let mut actual_pid = 0;
    unsafe {
        GetWindowThreadProcessId(hwnd, Some(&mut actual_pid));
    }
    actual_pid == expected_pid
}

/// Locate only inside the explicitly authorized window, regardless of which
/// application the human has brought to the foreground.
pub(super) fn locate_ui_element_center_for_window(
    hwnd_raw: isize,
    expected_pid: u32,
    query: &UiElementLocateQuery,
) -> OpenBitFunResult<UiElementLocateResult> {
    let query = query.clone();
    run_read("locate", move || {
        locate_ui_element_center_for_window_native(hwnd_raw, expected_pid, &query)
    })
}

fn locate_ui_element_center_for_window_native(
    hwnd_raw: isize,
    expected_pid: u32,
    query: &UiElementLocateQuery,
) -> OpenBitFunResult<UiElementLocateResult> {
    ui_locate_common::validate_query(query)?;

    let max_depth = query.max_depth.unwrap_or(48).clamp(1, 200) as usize;
    let max_elements = 12_000usize;

    let hwnd = HWND(hwnd_raw as *mut _);
    if !target_window_matches(hwnd, expected_pid) {
        return Err(OpenBitFunError::tool(
            "[TARGET_WINDOW_UNAVAILABLE] Authorized window identity is no longer valid."
                .to_string(),
        ));
    }

    let (_tree_text, nodes) = unsafe { walk_tree_full(hwnd, max_elements, max_depth) }?;
    if !target_window_matches(hwnd, expected_pid) {
        return Err(OpenBitFunError::tool(
            "[TARGET_WINDOW_UNAVAILABLE] Target changed during UIA observation",
        ));
    }

    // node_idx fast-path: address an actionable element by its `[N]` index.
    if let Some(idx) = query.node_idx {
        if let Some(node) = nodes.iter().find(|n| n.element_index == Some(idx as usize)) {
            return center_result_from_node(node, Some(idx), "node_idx");
        }
        return Err(OpenBitFunError::tool(format!(
            "[AX_IDX_NOT_FOUND] No UI element with node_idx={} in the target window tree \
             ({} nodes walked).",
            idx,
            nodes.len()
        )));
    }

    // Filter path: first node whose attrs match the query and that has a
    // usable bounding rect.
    let mut total_matches = 0u32;
    let mut other_matches: Vec<String> = Vec::new();
    for node in &nodes {
        let attrs = ui_locate_common::NodeAttrs {
            role: Some(node.control_type.as_str()),
            subrole: None,
            title: node.name.as_deref(),
            value: node.value.as_deref(),
            description: None,
            identifier: node.automation_id.as_deref(),
            help: node.help_text.as_deref(),
        };
        if !ui_locate_common::matches_filters_attrs(query, &attrs) {
            continue;
        }
        total_matches += 1;
        if node.rect.is_some() {
            let idx = node.element_index.map(|i| i as u32);
            return center_result_from_node(node, idx, "filters");
        }
        // Matched but no usable rect — record for diagnostics, keep scanning.
        if other_matches.len() < 5 {
            other_matches.push(format_node_line(node));
        }
    }

    if total_matches == 0 {
        Err(OpenBitFunError::tool(
            "No UI element matched in the target window for this query. Refine filters or \
             use ComputerUse screenshot. Locate uses the same UI Automation permission as \
             mouse/keyboard automation."
                .to_string(),
        ))
    } else {
        Err(OpenBitFunError::tool(format!(
            "UI element matched filters but had no usable bounding rectangle ({} match(es): {}).",
            total_matches,
            other_matches.join(" | ")
        )))
    }
}

// ── Window-scoped hit-test ────────────────────────────────────────────────

pub(super) fn accessibility_hit_at_global_point(
    gx: f64,
    gy: f64,
) -> OpenBitFunResult<Option<OcrAccessibilityHit>> {
    let hwnd = unsafe { GetForegroundWindow() };
    let mut pid = 0;
    unsafe {
        GetWindowThreadProcessId(hwnd, Some(&mut pid));
    }
    accessibility_hit_at_global_point_for_window(hwnd.0 as isize, pid, gx, gy)
}

/// Search the authorized window's subtree by geometry. ElementFromPoint would
/// resolve the covering application's element and disclose unrelated content.
pub(super) fn accessibility_hit_at_global_point_for_window(
    hwnd_raw: isize,
    expected_pid: u32,
    gx: f64,
    gy: f64,
) -> OpenBitFunResult<Option<OcrAccessibilityHit>> {
    run_read("hit_test", move || {
        accessibility_hit_at_global_point_for_window_native(hwnd_raw, expected_pid, gx, gy)
    })
}

fn accessibility_hit_at_global_point_for_window_native(
    hwnd_raw: isize,
    expected_pid: u32,
    gx: f64,
    gy: f64,
) -> OpenBitFunResult<Option<OcrAccessibilityHit>> {
    let hwnd = HWND(hwnd_raw as *mut _);
    if !gx.is_finite() || !gy.is_finite() || !target_window_matches(hwnd, expected_pid) {
        return Ok(None);
    }
    let (_, nodes) = unsafe { walk_tree_full(hwnd, 12_000, 64) }?;
    let Some(node) = nodes
        .iter()
        .filter(|node| {
            node.rect.is_some_and(|(left, top, right, bottom)| {
                gx >= left as f64 && gx < right as f64 && gy >= top as f64 && gy < bottom as f64
            })
        })
        .max_by_key(|node| node.depth)
    else {
        return Ok(None);
    };
    let Some(element) = node
        .element
        .as_ref()
        .and_then(|element| element.cast::<IUIAutomationElement>().ok())
    else {
        return Ok(None);
    };
    if !element_belongs_to_window(&element, hwnd, expected_pid)? {
        return Ok(None);
    }
    // Parent context, when present, comes from this same bounded observation;
    // never follow a top-level window's parent into the desktop tree.
    let parent_context = node.parent_element_index.and_then(|idx| {
        nodes
            .iter()
            .find(|parent| parent.element_index == Some(idx))
            .map(|parent| {
                format!(
                    "{}: {}",
                    parent.control_type,
                    parent.name.as_deref().unwrap_or("")
                )
            })
    });
    Ok(Some(OcrAccessibilityHit {
        role: Some(node.control_type.clone()),
        title: node.name.clone(),
        identifier: node.automation_id.clone(),
        description: format!(
            "role={} name={:?} id={:?} parent={:?}",
            node.control_type, node.name, node.automation_id, parent_context
        ),
        parent_context,
    }))
}

/// UIA can stitch a hosted provider from another process into this window's
/// tree (UWP, WebView). Membership is ancestry, not equality with the HWND PID.
/// Revalidate the native root on both sides of the bounded provider walk.
fn element_belongs_to_window(
    element: &IUIAutomationElement,
    hwnd: HWND,
    expected_pid: u32,
) -> OpenBitFunResult<bool> {
    if !target_window_matches(hwnd, expected_pid) {
        return Ok(false);
    }
    let automation = create_automation()?;
    checkpoint("target_root")?;
    let root = unsafe { automation.ElementFromHandle(hwnd) }
        .map_err(|error| OpenBitFunError::tool(format!("UI Automation target root: {error}")))?;
    let walker = unsafe { automation.RawViewWalker() }
        .map_err(|error| OpenBitFunError::tool(format!("UI Automation target walker: {error}")))?;
    let mut current = element.clone();
    let mut belongs_to_window = false;
    for _ in 0..200 {
        checkpoint("target_ancestry")?;
        if unsafe { automation.CompareElements(&current, &root) }.is_ok_and(|same| same.as_bool()) {
            belongs_to_window = true;
            break;
        }
        match unsafe { walker.GetParentElement(&current) } {
            Ok(parent) => current = parent,
            Err(_) => break,
        }
    }
    Ok(belongs_to_window && target_window_matches(hwnd, expected_pid))
}

// ── AppStateSnapshot builder ────────────────────────────────────────────────

/// Build a full [`AppStateSnapshot`] for an explicit top-level HWND selected by
/// the caller.
fn snapshot_and_nodes(
    hwnd: windows::Win32::Foundation::HWND,
    max_depth: u32,
    focus_window_only: bool,
) -> OpenBitFunResult<(AppStateSnapshot, Vec<UiaNode>)> {
    if hwnd.is_invalid() {
        return Err(OpenBitFunError::tool(
            "No target window (invalid HWND).".to_string(),
        ));
    }
    let _ = focus_window_only; // Windows UIA walk is always rooted at the given HWND.

    let hwnd_raw = hwnd.0 as isize;

    // Primary: UIA control-view walk. Fallback: MSAA for SAL/VCL windows
    // (LibreOffice / OpenOffice) whose UIA provider hangs on
    // `BuildUpdatedCache(Subtree)` or returns an empty tree, OR whenever the
    // UIA walk errors / yields nothing on a SAL/VCL class.
    let (_tree_text, mut uia_nodes) = match unsafe { walk_tree_full(hwnd, 500, max_depth as usize) }
    {
        Ok((text, nodes)) if !nodes.is_empty() => (text, nodes),
        primary => {
            checkpoint("legacy_observation_fallback")?;
            if crate::computer_use::windows_msaa::is_sal_vcl_window(hwnd_raw) {
                match crate::computer_use::windows_msaa::walk_msaa_tree(hwnd_raw) {
                    Ok(msaa_nodes) if !msaa_nodes.is_empty() => {
                        let text = render_nodes_text(&msaa_nodes);
                        (text, msaa_nodes)
                    }
                    _ => primary?,
                }
            } else {
                primary?
            }
        }
    };

    // Dense re-index: assign idx to every node (including content-only),
    // remap parent_element_index to the dense space.
    let mut nodes: Vec<AxNode> = Vec::with_capacity(uia_nodes.len());
    let mut uia_idx_to_dense: std::collections::HashMap<usize, u32> =
        std::collections::HashMap::new();
    for (dense_idx, n) in uia_nodes.iter().enumerate() {
        if let Some(ei) = n.element_index {
            uia_idx_to_dense.insert(ei, dense_idx as u32);
        }
    }
    for (dense_idx, n) in uia_nodes.iter().enumerate() {
        let parent_dense = n
            .parent_element_index
            .and_then(|p| uia_idx_to_dense.get(&p).copied());
        nodes.push(n.to_ax_node(dense_idx as u32, parent_dense));
    }

    // Keep text indices and DTO indices identical, including content nodes.
    // Actions address this retained observation; they never rewalk a new tree.
    for (idx, node) in uia_nodes.iter_mut().enumerate() {
        node.parent_element_index = nodes[idx].parent_idx.map(|i| i as usize);
        node.element_index = Some(idx);
    }
    let tree_text = render_nodes_text(&uia_nodes);

    // Compute digest — same algorithm as macOS `compute_digest`.
    let digest = compute_digest(&nodes);

    let window_title = window_title_for(hwnd);
    let pid = window_pid_for(hwnd).map(|p| p as i32);
    let app = AppInfo {
        name: window_title
            .clone()
            .unwrap_or_else(|| "unknown".to_string()),
        bundle_id: None,
        pid,
        running: true,
        last_used_ms: None,
        launch_count: 0,
    };

    Ok((
        AppStateSnapshot {
            observation_id: None,
            app,
            window_title,
            tree_text,
            nodes,
            digest,
            captured_at_ms: std::time::SystemTime::now()
                .duration_since(std::time::UNIX_EPOCH)
                .unwrap_or_default()
                .as_millis() as u64,
            screenshot: None,
            loop_warning: None,
        },
        uia_nodes,
    ))
}

fn foreground_app_name() -> Option<String> {
    let hwnd = unsafe { GetForegroundWindow() };
    window_title_for(hwnd)
}

fn window_title_for(hwnd: windows::Win32::Foundation::HWND) -> Option<String> {
    use windows::Win32::UI::WindowsAndMessaging::GetWindowTextW;
    if hwnd.is_invalid() {
        return None;
    }
    unsafe {
        let mut buf = [0u16; 256];
        let len = GetWindowTextW(hwnd, &mut buf);
        if len == 0 {
            return None;
        }
        Some(String::from_utf16_lossy(&buf[..len as usize]))
    }
}

fn window_pid_for(hwnd: windows::Win32::Foundation::HWND) -> Option<u32> {
    use windows::Win32::UI::WindowsAndMessaging::GetWindowThreadProcessId;
    if hwnd.is_invalid() {
        return None;
    }
    unsafe {
        let mut pid: u32 = 0;
        GetWindowThreadProcessId(hwnd, Some(&mut pid));
        if pid == 0 {
            None
        } else {
            Some(pid)
        }
    }
}

/// Raw handle of the current foreground window as `isize` (0 when none). Used
/// by the desktop host to capture a screenshot of the same window the AX
/// snapshot was taken from.
pub(super) fn foreground_window_handle() -> isize {
    let hwnd = unsafe { GetForegroundWindow() };
    hwnd.0 as isize
}

/// Owning process id of the current foreground window, if any.
pub(super) fn foreground_window_pid() -> Option<u32> {
    let hwnd = unsafe { GetForegroundWindow() };
    window_pid_for(hwnd)
}

// Snapshot COM references never cross threads. A request carries the originating
// action token so cancellation cannot borrow a later action's input lease.
enum SemanticAction {
    Invoke(u32),
    Insert(u32, String),
    Scroll(u32, i32, i32),
    Center(u32),
}
struct ObservedWindow {
    hwnd: isize,
    scope: openbitfun_agent_tools::computer_use_control::ObservationScope,
    pid: u32,
    nodes: Vec<UiaNode>,
    response: std::sync::Arc<super::provider_worker::Request>,
}
struct WorkerState {
    initialized: bool,
    observed: Option<ObservedWindow>,
}
impl Drop for WorkerState {
    fn drop(&mut self) {
        self.observed = None;
        if self.initialized {
            unsafe { windows::Win32::System::Com::CoUninitialize() };
        }
    }
}
// Two seconds for connection, five for one provider transaction and ten for
// the complete request (including retries). COM limits alone do not bound a
// misbehaving Invoke provider, so the caller also enforces the outer deadline.
const REQUEST_TIMEOUT: std::time::Duration = std::time::Duration::from_secs(10);
static UIA_WORKER: std::sync::OnceLock<super::provider_worker::Worker<WorkerState>> =
    std::sync::OnceLock::new();
static CLEAR_OBSERVATIONS: std::sync::atomic::AtomicBool =
    std::sync::atomic::AtomicBool::new(false);
thread_local! {
    static CURRENT_REQUEST: std::cell::RefCell<Option<std::sync::Arc<super::provider_worker::Request>>> = const { std::cell::RefCell::new(None) };
}

pub(super) fn clear_observations() {
    // Never enqueue behind a stuck provider, and never release COM on the
    // cancelling thread. Idle cleanup releases cached references promptly;
    // occupied workers consume the flag when their current call returns.
    CLEAR_OBSERVATIONS.store(true, std::sync::atomic::Ordering::Release);
    if let Some(worker) = UIA_WORKER.get() {
        worker.try_cleanup(|state| {
            if CLEAR_OBSERVATIONS.swap(false, std::sync::atomic::Ordering::AcqRel) {
                state.observed = None;
            }
        });
    }
}

pub(super) fn checkpoint(phase: &'static str) -> OpenBitFunResult<()> {
    super::control_session::capture_allowed().map_err(OpenBitFunError::tool)?;
    request_checkpoint(phase)
}

// Cached traversal checks the caller's fence without repeatedly opening the
// authorized process. Full authority is rechecked before publication and input.
fn request_checkpoint(phase: &'static str) -> OpenBitFunResult<()> {
    CURRENT_REQUEST.with_borrow(|request| {
        request
            .as_ref()
            .ok_or_else(|| {
                OpenBitFunError::tool("[AX_WORKER_REQUIRED] UIA requires the provider worker")
            })?
            .checkpoint(phase)
            .map_err(OpenBitFunError::tool)
    })
}
fn begin_input(phase: &'static str) -> OpenBitFunResult<()> {
    super::control_session::input_allowed().map_err(OpenBitFunError::tool)?;
    CURRENT_REQUEST.with_borrow(|request| {
        request
            .as_ref()
            .ok_or_else(|| {
                OpenBitFunError::tool("[AX_WORKER_REQUIRED] UIA input requires the provider worker")
            })?
            .begin_input(phase)
            .map_err(OpenBitFunError::tool)
    })
}

fn current_pattern<T: Interface>(
    element: &IUIAutomationElement,
    pattern_id: windows::Win32::UI::Accessibility::UIA_PATTERN_ID,
    phase: &'static str,
) -> OpenBitFunResult<Option<T>> {
    checkpoint(phase)?;
    let pattern = unsafe { element.GetCurrentPatternAs::<T>(pattern_id) };
    // A failed lookup can return long after cancellation. Do not proceed to
    // another pattern lookup (or another native input route) in that case.
    checkpoint(phase)?;
    Ok(pattern.ok())
}

pub(super) fn create_automation() -> OpenBitFunResult<IUIAutomation> {
    checkpoint("create_automation")?;
    let configured: IUIAutomation2 =
        unsafe { CoCreateInstance(&CUIAutomation8, None, CLSCTX_INPROC_SERVER) }.map_err(
            |error| OpenBitFunError::tool(format!("UI Automation initialization: {error}")),
        )?;
    unsafe {
        configured
            .SetAutoSetFocus(false)
            .and_then(|_| configured.SetConnectionTimeout(2000))
            .and_then(|_| configured.SetTransactionTimeout(5000))
    }
    .map_err(|error| {
        OpenBitFunError::tool(format!(
            "UI Automation timeout/focus configuration: {error}"
        ))
    })?;
    configured
        .cast()
        .map_err(|error| OpenBitFunError::tool(format!("UI Automation interface: {error}")))
}

fn run_uia<T: Send + 'static>(
    operation: &'static str,
    work: impl FnOnce(&mut WorkerState) -> OpenBitFunResult<T> + Send + 'static,
) -> OpenBitFunResult<T> {
    let token = super::control_session::capture_token().map_err(OpenBitFunError::tool)?;
    let worker = UIA_WORKER.get_or_init(|| {
        super::provider_worker::Worker::new(|| WorkerState {
            initialized: unsafe { CoInitializeEx(None, COINIT_MULTITHREADED) }.is_ok(),
            observed: None,
        })
    });
    let result = worker
        .run(
            operation,
            REQUEST_TIMEOUT,
            || super::control_session::with_token(token, super::control_session::capture_allowed),
            move |state, request| {
                super::control_session::with_token(token, || {
                    struct Reset;
                    impl Drop for Reset {
                        fn drop(&mut self) {
                            CURRENT_REQUEST.with_borrow_mut(|r| *r = None);
                        }
                    }
                    CURRENT_REQUEST.with_borrow_mut(|r| *r = Some(request.clone()));
                    let _reset = Reset;
                    if CLEAR_OBSERVATIONS.swap(false, std::sync::atomic::Ordering::AcqRel) {
                        state.observed = None;
                    }
                    let result = (|| {
                        if !state.initialized {
                            return Err(OpenBitFunError::tool(
                                "UI Automation MTA initialization failed",
                            ));
                        }
                        checkpoint("started")?;
                        log::debug!("UIA request started: operation={operation}");
                        let output = work(state)?;
                        checkpoint("completed")?;
                        Ok(output)
                    })()
                    .map_err(|error| {
                        if let Some(reason) = request.input_failure() {
                            log::warn!("UIA input failed after submission: {reason}");
                            OpenBitFunError::tool(format!("{reason}; provider error: {error}"))
                        } else {
                            error
                        }
                    });
                    if (result.is_err() && request.input_failure().is_some())
                        || request.check().is_err()
                        || super::control_session::capture_allowed().is_err()
                        || CLEAR_OBSERVATIONS.swap(false, std::sync::atomic::Ordering::AcqRel)
                    {
                        state.observed = None;
                    }
                    result
                })
            },
        )
        .map_err(|reason| {
            log::warn!("UIA request did not complete: {reason}");
            OpenBitFunError::tool(reason)
        })?;
    if result.is_ok() {
        log::debug!("UIA request completed: operation={operation}");
    }
    result
}

pub(super) fn run_read<T: Send + 'static>(
    operation: &'static str,
    work: impl FnOnce() -> OpenBitFunResult<T> + Send + 'static,
) -> OpenBitFunResult<T> {
    run_uia(operation, move |_| work())
}

pub(super) fn get_app_state_snapshot_for_window(
    hwnd: HWND,
    max_depth: u32,
    focus_window_only: bool,
) -> OpenBitFunResult<AppStateSnapshot> {
    let hwnd = hwnd.0 as isize;
    run_uia("observe", move |state| {
        state.observed = None;
        let scope = super::control_session::observation_scope().map_err(OpenBitFunError::tool)?;
        let handle = HWND(hwnd as *mut _);
        let (snapshot, nodes) = snapshot_and_nodes(handle, max_depth, focus_window_only)?;
        checkpoint("publish_observation")?;
        super::control_session::validate_observation_scope(&scope)
            .map_err(OpenBitFunError::tool)?;
        let response = CURRENT_REQUEST
            .with_borrow(|request| request.clone())
            .ok_or_else(|| {
                OpenBitFunError::tool(
                    "[AX_WORKER_REQUIRED] Observation requires the provider worker",
                )
            })?;
        state.observed = Some(ObservedWindow {
            hwnd,
            scope,
            pid: window_pid_for(handle).unwrap_or(0),
            nodes,
            response,
        });
        Ok(snapshot)
    })
}
/// Resolve an image-derived point inside the bound native window, or that
/// window thread's existing focus, without moving keyboard focus.
pub(super) fn insert_text_at_bound_target(
    hwnd: isize,
    point: Option<(f64, f64)>,
    text: &str,
) -> OpenBitFunResult<()> {
    let text = text.to_owned();
    run_read("insert_native", move || {
        insert_native_target(hwnd, point, &text)
    })
}

fn point_in_window(point: (f64, f64), rect: (i32, i32, i32, i32)) -> bool {
    point.0.is_finite()
        && point.1.is_finite()
        && rect.0 < rect.2
        && rect.1 < rect.3
        && point.0 >= rect.0 as f64
        && point.0 < rect.2 as f64
        && point.1 >= rect.1 as f64
        && point.1 < rect.3 as f64
}

fn insert_native_target(
    hwnd: isize,
    point: Option<(f64, f64)>,
    text: &str,
) -> OpenBitFunResult<()> {
    use windows::Win32::Foundation::{POINT, RECT};
    use windows::Win32::Graphics::Gdi::ScreenToClient;
    use windows::Win32::UI::WindowsAndMessaging::{
        ChildWindowFromPointEx, GetGUIThreadInfo, GetWindowRect, CWP_SKIPDISABLED,
        CWP_SKIPINVISIBLE, CWP_SKIPTRANSPARENT, GUITHREADINFO,
    };
    let top = HWND(hwnd as *mut _);
    super::control_session::input_allowed().map_err(OpenBitFunError::tool)?;
    let pid = window_pid_for(top)
        .ok_or_else(|| OpenBitFunError::tool("[AX_STALE_TARGET] Bound window has no process"))?;
    super::control_session::target_allowed(&format!("pid:{pid}/window:{hwnd}"))
        .map_err(OpenBitFunError::tool)?;
    let native_error = |e| OpenBitFunError::tool(format!("[AX_TARGET_UNAVAILABLE] {e}"));
    unsafe {
        let child = if let Some(point) = point {
            let mut rect = RECT::default();
            GetWindowRect(top, &mut rect).map_err(native_error)?;
            if !point_in_window(point, (rect.left, rect.top, rect.right, rect.bottom)) {
                return Err(OpenBitFunError::tool(
                    "[TARGET_COORDINATES_OUTSIDE_WINDOW] Text target is outside the bound window",
                ));
            }
            let mut current = top;
            loop {
                let mut local = POINT {
                    x: point.0.floor() as i32,
                    y: point.1.floor() as i32,
                };
                if !ScreenToClient(current, &mut local).as_bool() {
                    return Err(OpenBitFunError::tool(
                        "[AX_TARGET_UNAVAILABLE] Cannot map text target to bound window",
                    ));
                }
                let next = ChildWindowFromPointEx(
                    current,
                    local,
                    CWP_SKIPINVISIBLE | CWP_SKIPDISABLED | CWP_SKIPTRANSPARENT,
                );
                if next.0.is_null() || next == current {
                    break current;
                }
                current = next;
            }
        } else {
            let thread = GetWindowThreadProcessId(top, None);
            if thread == 0 {
                return Err(OpenBitFunError::tool(
                    "[AX_STALE_TARGET] Bound window thread is unavailable",
                ));
            }
            let mut info = GUITHREADINFO {
                cbSize: std::mem::size_of::<GUITHREADINFO>() as u32,
                ..Default::default()
            };
            GetGUIThreadInfo(thread, &mut info).map_err(native_error)?;
            if info.hwndFocus.0.is_null() {
                return Err(OpenBitFunError::tool("[BACKGROUND_TEXT_UNAVAILABLE] Bound window thread has no focused native text control"));
            }
            info.hwndFocus
        };
        let automation = create_automation()?;
        checkpoint("native_text_element")?;
        let element = automation.ElementFromHandle(child).map_err(native_error)?;
        // The retained UIA element must still identify the precise child that
        // was hit or focused; providers must not redirect us to another HWND.
        checkpoint("native_text_identity")?;
        if element.CurrentNativeWindowHandle().map_err(native_error)? != child {
            return Err(OpenBitFunError::tool(
                "[AX_STALE_ELEMENT] UIA native identity differs from the resolved text control",
            ));
        }
        if let Some(point) = point {
            checkpoint("native_text_geometry")?;
            let rect = element.CurrentBoundingRectangle().map_err(native_error)?;
            if !point_in_window(point, (rect.left, rect.top, rect.right, rect.bottom)) {
                return Err(OpenBitFunError::tool(
                    "[AX_GEOMETRY_CHANGED] Text control moved after point resolution",
                ));
            }
        }
        replace_native_edit_selection(&element, top, pid, text)?;
        if let Some((x, y)) = point {
            super::control_session::record_pointer(x, y, false);
        }
    }
    Ok(())
}

// EM_REPLACESEL is defined only for standard edit classes. Provider/window
// labels and arbitrary class-name substrings must not authorize this message.
fn is_native_edit_class(class: &str) -> bool {
    matches!(
        class.to_ascii_lowercase().as_str(),
        "edit" | "richedit" | "richedit20w" | "richedit50w" | "richeditd2d" | "richeditd2dpt"
    )
}

fn edit_replacement_utf16(text: &str) -> Result<Vec<u16>, &'static str> {
    if text.contains('\0') {
        return Err(
            "[INVALID_TEXT] Native edit insertion cannot represent embedded NUL characters",
        );
    }
    Ok(text.encode_utf16().chain(std::iter::once(0)).collect())
}

/// A single selection-aware edit message. It preserves the control's caret,
/// selection semantics and undo stack without touching seat focus or clipboard.
/// https://learn.microsoft.com/en-us/windows/win32/controls/em-replacesel
fn replace_native_edit_selection(
    element: &IUIAutomationElement,
    top: HWND,
    pid: u32,
    text: &str,
) -> OpenBitFunResult<()> {
    use windows::Win32::Foundation::{LPARAM, WPARAM};
    use windows::Win32::UI::Input::KeyboardAndMouse::IsWindowEnabled;
    use windows::Win32::UI::WindowsAndMessaging::{
        GetAncestor, GetClassNameW, GetWindowLongW, IsWindowUnicode, SendMessageTimeoutW,
        ES_READONLY, GA_ROOT, GWL_STYLE, SMTO_ABORTIFHUNG, SMTO_BLOCK,
    };
    let buffer = edit_replacement_utf16(text).map_err(OpenBitFunError::tool)?;
    checkpoint("native_edit_preflight")?;
    unsafe {
        let child = element.CurrentNativeWindowHandle().map_err(|_| {
            OpenBitFunError::tool(
                "[BACKGROUND_TEXT_UNAVAILABLE] Observed UIA element has no native edit window",
            )
        })?;
        checkpoint("native_edit_process")?;
        let provider_pid = element
            .CurrentProcessId()
            .map_err(|e| OpenBitFunError::tool(format!("[AX_ACTION_FAILED] {e}")))?
            as u32;
        if !target_window_matches(top, pid)
            || child.0.is_null()
            || !IsWindow(Some(child)).as_bool()
            || window_pid_for(child) != Some(provider_pid)
            || GetAncestor(child, GA_ROOT) != top
        {
            return Err(OpenBitFunError::tool("[AX_STALE_ELEMENT] Native edit HWND does not belong to the observed process and bound top-level window"));
        }
        let mut class = [0u16; 256];
        let length = GetClassNameW(child, &mut class);
        if length <= 0
            || !is_native_edit_class(&String::from_utf16_lossy(&class[..length as usize]))
            || !IsWindowUnicode(child).as_bool()
        {
            return Err(OpenBitFunError::tool("[BACKGROUND_TEXT_UNAVAILABLE] Selection-aware insertion requires a standard Unicode Win32 Edit or RichEdit control"));
        }
        if !IsWindowEnabled(child).as_bool() || GetWindowLongW(child, GWL_STYLE) & ES_READONLY != 0
        {
            return Err(OpenBitFunError::tool(
                "[BACKGROUND_TEXT_UNAVAILABLE] Native edit control is disabled or read-only",
            ));
        }
        if let Some(pattern) = current_pattern::<IUIAutomationValuePattern>(
            element,
            UIA_ValuePatternId,
            "native_edit_value_pattern",
        )? {
            checkpoint("native_edit_read_only")?;
            if pattern
                .CurrentIsReadOnly()
                .map_err(|e| OpenBitFunError::tool(format!("[AX_ACTION_FAILED] {e}")))?
                .as_bool()
            {
                return Err(OpenBitFunError::tool(
                    "[BACKGROUND_TEXT_UNAVAILABLE] UIA provider marks this control read-only",
                ));
            }
        }
        if text.is_empty() {
            return Ok(());
        }
        super::control_session::input_allowed().map_err(OpenBitFunError::tool)?;
        super::control_session::target_allowed(&format!("pid:{pid}/window:{}", top.0 as isize))
            .map_err(OpenBitFunError::tool)?;
        // This system message is marshalled by Windows across processes. Its
        // result has no success value; only the transport completion is known.
        begin_input("native_edit_replace_selection")?;
        let completed = SendMessageTimeoutW(
            child,
            0x00C2,
            WPARAM(1),
            LPARAM(buffer.as_ptr() as isize),
            SMTO_ABORTIFHUNG | SMTO_BLOCK,
            2000,
            None,
        );
        if completed.0 == 0 {
            // Same-process messages use the original pointer. A timed-out
            // receiver may still be reading it, so keep its allocation alive.
            if pid == std::process::id() {
                std::mem::forget(buffer);
            }
            return Err(OpenBitFunError::tool("[INPUT_OUTCOME_UNKNOWN] Native edit message did not complete; some text may already have been inserted. Observe before further input; no retry was sent"));
        }
    }
    Ok(())
}

fn dispatch_semantic(hwnd: isize, action: SemanticAction) -> OpenBitFunResult<(f64, f64)> {
    let operation = match &action {
        SemanticAction::Invoke(_) => "invoke",
        SemanticAction::Insert(_, _) => "insert",
        SemanticAction::Scroll(_, _, _) => "scroll",
        SemanticAction::Center(_) => "center",
    };
    run_uia(operation, move |state| {
        let cache = state.observed.as_ref().ok_or_else(|| {
            OpenBitFunError::tool(
                "[AX_OBSERVATION_REQUIRED] Read the target window before using a node index",
            )
        })?;
        apply_semantic(cache, hwnd, action)
    })
}
pub(super) fn invoke_cached_node(hwnd: isize, idx: u32) -> OpenBitFunResult<()> {
    dispatch_semantic(hwnd, SemanticAction::Invoke(idx)).map(|_| ())
}
pub(super) fn insert_cached_text(hwnd: isize, idx: u32, text: &str) -> OpenBitFunResult<()> {
    dispatch_semantic(hwnd, SemanticAction::Insert(idx, text.into())).map(|_| ())
}
pub(super) fn scroll_cached_node(hwnd: isize, idx: u32, dx: i32, dy: i32) -> OpenBitFunResult<()> {
    dispatch_semantic(hwnd, SemanticAction::Scroll(idx, dx, dy)).map(|_| ())
}
pub(super) fn cached_node_center(hwnd: isize, idx: u32) -> OpenBitFunResult<(f64, f64)> {
    dispatch_semantic(hwnd, SemanticAction::Center(idx))
}
fn apply_semantic(
    cache: &ObservedWindow,
    hwnd: isize,
    action: SemanticAction,
) -> OpenBitFunResult<(f64, f64)> {
    use windows::Win32::UI::Accessibility::{
        IUIAutomationInvokePattern, IUIAutomationScrollPattern, IUIAutomationSelectionItemPattern,
        IUIAutomationTogglePattern, ScrollAmount_NoAmount, ScrollAmount_SmallDecrement,
        ScrollAmount_SmallIncrement,
    };
    super::control_session::capture_allowed().map_err(OpenBitFunError::tool)?;
    if !cache.response.response_accepted() {
        return Err(OpenBitFunError::tool(
            "[AX_OBSERVATION_REQUIRED] The previous observation was not delivered; read the target again before input",
        ));
    }
    if cache.hwnd != hwnd
        || super::control_session::validate_observation_scope(&cache.scope).is_err()
        || window_pid_for(windows::Win32::Foundation::HWND(hwnd as *mut _)) != Some(cache.pid)
    {
        return Err(OpenBitFunError::tool(
            "[AX_STALE_TARGET] Read the target window again",
        ));
    }
    super::control_session::target_allowed(&format!("pid:{}/window:{hwnd}", cache.pid))
        .map_err(OpenBitFunError::tool)?;
    let idx = match &action {
        SemanticAction::Invoke(i)
        | SemanticAction::Insert(i, _)
        | SemanticAction::Scroll(i, _, _)
        | SemanticAction::Center(i) => *i,
    };
    let node = cache
        .nodes
        .get(idx as usize)
        .ok_or_else(|| OpenBitFunError::tool("[AX_STALE_INDEX] Read the target window again"))?;
    let element: IUIAutomationElement = node
        .element
        .as_ref()
        .and_then(|e| e.cast().ok())
        .ok_or_else(|| {
            OpenBitFunError::tool(
                "[AX_ACTION_UNSUPPORTED] This legacy element has no UIA semantic provider",
            )
        })?;
    let native = |e: windows::core::Error| OpenBitFunError::tool(format!("[AX_ACTION_FAILED] {e}"));
    checkpoint("semantic_preflight")?;
    unsafe {
        if !element_belongs_to_window(&element, HWND(hwnd as *mut _), cache.pid)? {
            return Err(OpenBitFunError::tool(
                "[AX_STALE_ELEMENT] The observed control no longer belongs to the bound window",
            ));
        }
        checkpoint("semantic_enabled")?;
        if !element.CurrentIsEnabled().map_err(native)?.as_bool() {
            return Err(OpenBitFunError::tool(
                "[AX_ELEMENT_DISABLED] The observed control is disabled",
            ));
        }
        checkpoint("semantic_geometry")?;
        let rect = element.CurrentBoundingRectangle().map_err(native)?;
        if node.rect != Some((rect.left, rect.top, rect.right, rect.bottom)) {
            return Err(OpenBitFunError::tool(
                "[AX_GEOMETRY_CHANGED] Observe the target again before input",
            ));
        }
        let center = (
            (rect.left as f64 + rect.right as f64) / 2.0,
            (rect.top as f64 + rect.bottom as f64) / 2.0,
        );
        if matches!(action, SemanticAction::Center(_)) {
            return Ok(center);
        }
        super::control_session::input_allowed().map_err(OpenBitFunError::tool)?;
        let clicked = matches!(action, SemanticAction::Invoke(_));
        match action {
            SemanticAction::Invoke(_) => {
                if let Some(pattern) = current_pattern::<IUIAutomationInvokePattern>(
                    &element,
                    UIA_InvokePatternId,
                    "invoke_pattern",
                )? {
                    super::control_session::input_allowed().map_err(OpenBitFunError::tool)?;
                    begin_input("invoke")?;
                    pattern.Invoke().map_err(native)?;
                } else if let Some(pattern) = current_pattern::<IUIAutomationTogglePattern>(
                    &element,
                    UIA_TogglePatternId,
                    "toggle_pattern",
                )? {
                    super::control_session::input_allowed().map_err(OpenBitFunError::tool)?;
                    begin_input("toggle")?;
                    pattern.Toggle().map_err(native)?;
                } else if let Some(pattern) = current_pattern::<IUIAutomationSelectionItemPattern>(
                    &element,
                    UIA_SelectionItemPatternId,
                    "selection_pattern",
                )? {
                    super::control_session::input_allowed().map_err(OpenBitFunError::tool)?;
                    begin_input("select")?;
                    pattern.Select().map_err(native)?;
                } else {
                    return Err(OpenBitFunError::tool("[AX_ACTION_UNSUPPORTED] Control exposes no invoke, toggle or selection pattern"));
                }
            }
            SemanticAction::Insert(_, text) => {
                replace_native_edit_selection(&element, HWND(hwnd as *mut _), cache.pid, &text)?;
            }
            SemanticAction::Scroll(_, dx, dy) => {
                let pattern = current_pattern::<IUIAutomationScrollPattern>(
                    &element,
                    UIA_ScrollPatternId,
                    "scroll_pattern",
                )?
                .ok_or_else(|| {
                    OpenBitFunError::tool(
                        "[AX_ACTION_UNSUPPORTED] Control has no background Scroll pattern",
                    )
                })?;
                let amount = |delta: i32| {
                    if delta > 0 {
                        ScrollAmount_SmallIncrement
                    } else if delta < 0 {
                        ScrollAmount_SmallDecrement
                    } else {
                        ScrollAmount_NoAmount
                    }
                };
                super::control_session::input_allowed().map_err(OpenBitFunError::tool)?;
                begin_input("scroll")?;
                pattern.Scroll(amount(dx), amount(dy)).map_err(native)?;
            }
            SemanticAction::Center(_) => unreachable!(),
        }
        checkpoint("record_pointer")?;
        super::control_session::record_pointer(center.0, center.1, clicked);
        Ok(center)
    }
}

#[cfg(test)]
mod control_native_tests {
    use super::*;
    use windows::core::w;
    use windows::Win32::Foundation::{HWND, LPARAM, WPARAM};
    use windows::Win32::UI::WindowsAndMessaging::*;

    #[test]
    fn native_edit_payload_preserves_unicode_and_rejects_ambiguous_classes() {
        for class in ["Edit", "RICHEDIT20W", "RICHEDIT50W", "RichEditD2DPT"] {
            assert!(is_native_edit_class(class));
        }
        for class in [
            "Chrome_RenderWidgetHostHWND",
            "CustomEdit",
            "RICHEDIT20A",
            "Static",
        ] {
            assert!(!is_native_edit_class(class));
        }
        assert_eq!(
            edit_replacement_utf16("\u{4e2d}\u{1f642}").unwrap(),
            vec![0x4e2d, 0xd83d, 0xde42, 0]
        );
        assert!(edit_replacement_utf16("bad\0text").is_err());
        assert!(point_in_window((15.5, 20.0), (10, 10, 30, 40)));
        for point in [
            (9.9, 20.0),
            (30.0, 20.0),
            (15.0, 40.0),
            (f64::NAN, 20.0),
            (15.0, f64::INFINITY),
        ] {
            assert!(!point_in_window(point, (10, 10, 30, 40)));
        }
    }

    /// Exercises real Win32 controls and the production COM cache. Run only on
    /// an interactive Windows test host; it does not touch another application.
    #[test]
    #[ignore = "requires an interactive Windows desktop"]
    fn semantic_actions_use_observed_controls_without_focus_or_text_loss() {
        #[link(name = "kernel32")]
        unsafe extern "system" {
            fn GetCurrentThreadId() -> u32;
        }
        struct Fixture {
            thread: Option<std::thread::JoinHandle<()>>,
            tid: u32,
        }
        impl Drop for Fixture {
            fn drop(&mut self) {
                unsafe {
                    let _ = PostThreadMessageW(self.tid, WM_QUIT, WPARAM(0), LPARAM(0));
                }
                if let Some(thread) = self.thread.take() {
                    let _ = thread.join();
                }
            }
        }
        let (tx, rx) = std::sync::mpsc::sync_channel(1);
        let thread = std::thread::spawn(move || unsafe {
            let window = CreateWindowExW(
                WINDOW_EX_STYLE::default(),
                w!("STATIC"),
                w!("OpenBitFun UIA isolated fixture"),
                WS_OVERLAPPEDWINDOW,
                50,
                50,
                400,
                180,
                None,
                None,
                None,
                None,
            )
            .unwrap();
            let toggle = CreateWindowExW(
                WINDOW_EX_STYLE::default(),
                w!("BUTTON"),
                w!("Fixture toggle"),
                WS_CHILD | WS_VISIBLE | WINDOW_STYLE(3),
                10,
                10,
                180,
                30,
                Some(window),
                None,
                None,
                None,
            )
            .unwrap();
            let edit = CreateWindowExW(
                WINDOW_EX_STYLE::default(),
                w!("EDIT"),
                w!(""),
                WS_CHILD | WS_VISIBLE | WS_BORDER,
                10,
                50,
                250,
                30,
                Some(window),
                None,
                None,
                None,
            )
            .unwrap();
            windows::Win32::System::LibraryLoader::LoadLibraryW(w!("Msftedit.dll")).unwrap();
            let rich = CreateWindowExW(
                WINDOW_EX_STYLE::default(),
                w!("RICHEDIT50W"),
                w!(""),
                WS_CHILD | WS_VISIBLE | WS_BORDER,
                10,
                90,
                250,
                30,
                Some(window),
                None,
                None,
                None,
            )
            .unwrap();
            let _ = ShowWindow(window, SW_SHOWNOACTIVATE);
            // Establish the fixture's own existing keyboard focus before the
            // baseline. Production insertion must not move it afterward.
            let _ = windows::Win32::UI::Input::KeyboardAndMouse::SetFocus(Some(edit));
            tx.send((
                window.0 as isize,
                toggle.0 as isize,
                edit.0 as isize,
                rich.0 as isize,
                GetCurrentThreadId(),
            ))
            .unwrap();
            let mut message = MSG::default();
            while GetMessageW(&mut message, None, 0, 0).as_bool() {
                let _ = TranslateMessage(&message);
                DispatchMessageW(&message);
            }
            let _ = DestroyWindow(window);
        });
        let (hwnd, toggle, edit, rich, tid) = rx.recv().unwrap();
        let _fixture = Fixture {
            thread: Some(thread),
            tid,
        };
        let owner = "windows-native-uia-test";
        super::super::control_session::start(
            owner,
            openbitfun_agent_tools::computer_use_control::ControlMode::Background,
        )
        .unwrap();
        super::super::control_session::bind_target(format!(
            "pid:{}/window:{hwnd}",
            std::process::id()
        ))
        .unwrap();
        let mut lease = super::super::control_session::acquire(owner, "app_click").unwrap();
        let observation =
            get_app_state_snapshot_for_window(HWND(hwnd as *mut _), 16, false).unwrap();
        let toggle_idx = observation
            .nodes
            .iter()
            .find(|n| n.title.as_deref() == Some("Fixture toggle"))
            .unwrap()
            .idx;
        let edit_idx = observation
            .nodes
            .iter()
            .find(|n| n.role.eq_ignore_ascii_case("edit"))
            .unwrap()
            .idx;
        let foreground = unsafe { GetForegroundWindow() };
        invoke_cached_node(hwnd, toggle_idx).unwrap();
        assert_eq!(
            unsafe {
                SendMessageW(
                    HWND(toggle as *mut _),
                    0x00F0,
                    Some(WPARAM(0)),
                    Some(LPARAM(0)),
                )
                .0
            },
            1
        );
        let mut edit_rect = windows::Win32::Foundation::RECT::default();
        unsafe {
            GetWindowRect(HWND(edit as *mut _), &mut edit_rect).unwrap();
        }
        let point = (
            (edit_rect.left + edit_rect.right) as f64 / 2.0,
            (edit_rect.top + edit_rect.bottom) as f64 / 2.0,
        );
        insert_text_at_bound_target(hwnd, Some(point), "preserved").unwrap();
        insert_text_at_bound_target(hwnd, None, " text").unwrap();
        assert!(
            insert_text_at_bound_target(hwnd, Some((f64::NAN, point.1)), "must not insert")
                .is_err()
        );
        assert!(
            insert_text_at_bound_target(hwnd, Some((-100000.0, -100000.0)), "must not insert")
                .is_err()
        );
        insert_cached_text(hwnd, edit_idx, " \u{4e2d}\u{6587}\u{1f642}").unwrap();
        unsafe {
            SendMessageW(
                HWND(edit as *mut _),
                0x00B1,
                Some(WPARAM(0)),
                Some(LPARAM(9)),
            );
        }
        insert_cached_text(hwnd, edit_idx, "selected").unwrap();
        insert_cached_text(hwnd, edit_idx, "!").unwrap();
        let mut text = [0u16; 64];
        let len = unsafe { GetWindowTextW(HWND(edit as *mut _), &mut text) };
        assert_eq!(
            String::from_utf16_lossy(&text[..len as usize]),
            "selected! text \u{4e2d}\u{6587}\u{1f642}"
        );
        assert!(insert_cached_text(hwnd, edit_idx, "bad\0text").is_err());
        unsafe {
            SendMessageW(
                HWND(edit as *mut _),
                0x00CF,
                Some(WPARAM(1)),
                Some(LPARAM(0)),
            );
        }
        assert!(insert_cached_text(hwnd, edit_idx, "read-only rejection").is_err());
        // RichEdit may expose a Text provider without a Value pattern. The
        // same native edit message still preserves its exact selection.
        unsafe {
            let replace_rich = |top: isize, text: &str| {
                let text = text.to_owned();
                run_read("rich_edit_fixture", move || {
                    let automation = create_automation()?;
                    let element = automation.ElementFromHandle(HWND(rich as *mut _)).unwrap();
                    replace_native_edit_selection(
                        &element,
                        HWND(top as *mut _),
                        std::process::id(),
                        &text,
                    )
                })
            };
            replace_rich(hwnd, "prefix \u{4e2d}\u{6587}").unwrap();
            replace_rich(hwnd, "\u{1f642}").unwrap();
            SendMessageW(
                HWND(rich as *mut _),
                0x00B1,
                Some(WPARAM(0)),
                Some(LPARAM(7)),
            );
            replace_rich(hwnd, "selected ").unwrap();
            let mut buffer = [0u16; 64];
            let count = GetWindowTextW(HWND(rich as *mut _), &mut buffer);
            assert_eq!(
                String::from_utf16_lossy(&buffer[..count as usize]),
                "selected \u{4e2d}\u{6587}\u{1f642}"
            );
            assert!(replace_rich(toggle, "wrong bound window").is_err());
        }
        let mut thread_state = GUITHREADINFO {
            cbSize: std::mem::size_of::<GUITHREADINFO>() as u32,
            ..Default::default()
        };
        unsafe {
            GetGUIThreadInfo(tid, &mut thread_state).unwrap();
        }
        assert_eq!(
            thread_state.hwndFocus,
            HWND(edit as *mut _),
            "point insertion must not change the window thread's focus"
        );
        assert_eq!(unsafe { GetForegroundWindow() }, foreground);
        lease.complete();
        drop(lease);
        super::super::control_session::stop(Some(owner), "test_complete").unwrap();
    }
}
