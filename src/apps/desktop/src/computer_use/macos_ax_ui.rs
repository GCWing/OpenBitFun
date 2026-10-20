//! macOS Accessibility (AX) tree search for stable UI centers (native “DOM”).
//!
//! Coordinates match CoreGraphics global space used by [`crate::computer_use::DesktopComputerUseHost`].

use crate::computer_use::ui_locate_common;
use core_foundation::array::{CFArray, CFArrayRef};
use core_foundation::base::{CFGetTypeID, CFTypeRef, TCFType};
use core_foundation::string::{CFString, CFStringRef};
use core_graphics::geometry::{CGPoint, CGSize};
use openbitfun_core::agentic::tools::computer_use_host::{
    OcrAccessibilityHit, UiElementLocateQuery, UiElementLocateResult,
};
use openbitfun_core::util::errors::{OpenBitFunError, OpenBitFunResult};
use std::collections::VecDeque;
use std::ffi::c_void;

type AXUIElementRef = *const c_void;
type AXValueRef = *const c_void;

#[link(name = "ApplicationServices", kind = "framework")]
unsafe extern "C" {
    fn AXUIElementCreateSystemWide() -> AXUIElementRef;
    fn AXUIElementCreateApplication(pid: i32) -> AXUIElementRef;
    fn AXUIElementGetPid(element: AXUIElementRef, pid: *mut i32) -> i32;
    fn AXUIElementCopyAttributeValue(
        element: AXUIElementRef,
        attribute: CFStringRef,
        value: *mut CFTypeRef,
    ) -> i32;
    fn AXUIElementCopyActionNames(element: AXUIElementRef, names: *mut CFArrayRef) -> i32;
    fn AXUIElementPerformAction(element: AXUIElementRef, action: CFStringRef) -> i32;
    fn AXUIElementSetMessagingTimeout(element: AXUIElementRef, timeout: f32) -> i32;
    fn AXUIElementCopyElementAtPosition(
        element: AXUIElementRef,
        x: f32,
        y: f32,
        out_elem: *mut AXUIElementRef,
    ) -> i32;
    fn AXValueGetType(value: AXValueRef) -> u32;
    fn AXValueGetValue(value: AXValueRef, the_type: u32, ptr: *mut c_void) -> bool;
}

type CFTypeID = usize;

#[link(name = "CoreFoundation", kind = "framework")]
unsafe extern "C" {
    fn CFRetain(cf: CFTypeRef) -> CFTypeRef;
    fn CFStringGetTypeID() -> CFTypeID;
    fn CFEqual(a: CFTypeRef, b: CFTypeRef) -> u8;
}

const K_AX_VALUE_CGPOINT: u32 = 1;
const K_AX_VALUE_CGSIZE: u32 = 2;

unsafe fn ax_release(v: CFTypeRef) {
    unsafe {
        if !v.is_null() {
            core_foundation::base::CFRelease(v);
        }
    }
}

unsafe fn ax_copy_attr(elem: AXUIElementRef, key: &str) -> Option<CFTypeRef> {
    unsafe {
        let mut val: CFTypeRef = std::ptr::null();
        let k = CFString::new(key);
        let st = AXUIElementCopyAttributeValue(elem, k.as_concrete_TypeRef(), &mut val);
        if st != 0 || val.is_null() {
            if !val.is_null() {
                ax_release(val);
            }
            return None;
        }
        Some(val)
    }
}

/// Safely convert a CF object to `String`.
///
/// **Critical**: AX attributes like `AXValue` are polymorphic — on toggles they're a
/// `CFNumber`, on tabs an `AXUIElement`, on geometric attrs an opaque `AXValueRef`. Wrapping
/// any of those as `CFStringRef` and calling `.to_string()` dispatches `_fastCStringContents:`
/// to the wrong class, which raises an Objective-C `NSException` that unwinds across the FFI
/// boundary — Rust then aborts with `fatal runtime error: Rust cannot catch foreign exceptions`.
/// Always type-check first.
unsafe fn cfstring_to_string(cf: CFTypeRef) -> Option<String> {
    unsafe {
        if cf.is_null() {
            return None;
        }
        if CFGetTypeID(cf) != CFStringGetTypeID() {
            return None;
        }
        let s = CFString::wrap_under_get_rule(cf as CFStringRef);
        Some(s.to_string())
    }
}

unsafe fn ax_value_to_point(v: CFTypeRef) -> Option<CGPoint> {
    unsafe {
        let v = v as AXValueRef;
        let t = AXValueGetType(v);
        if t != K_AX_VALUE_CGPOINT {
            return None;
        }
        let mut pt = CGPoint { x: 0.0, y: 0.0 };
        if !AXValueGetValue(v, K_AX_VALUE_CGPOINT, &mut pt as *mut _ as *mut c_void) {
            return None;
        }
        Some(pt)
    }
}

unsafe fn ax_value_to_size(v: CFTypeRef) -> Option<CGSize> {
    unsafe {
        let v = v as AXValueRef;
        let t = AXValueGetType(v);
        if t != K_AX_VALUE_CGSIZE {
            return None;
        }
        let mut sz = CGSize {
            width: 0.0,
            height: 0.0,
        };
        if !AXValueGetValue(v, K_AX_VALUE_CGSIZE, &mut sz as *mut _ as *mut c_void) {
            return None;
        }
        Some(sz)
    }
}

unsafe fn ax_copy_action_names(elem: AXUIElementRef) -> Vec<String> {
    unsafe {
        let mut names: CFArrayRef = std::ptr::null();
        let st = AXUIElementCopyActionNames(elem, &mut names);
        if st != 0 || names.is_null() {
            return vec![];
        }
        let arr = CFArray::<*const c_void>::wrap_under_create_rule(names);
        let mut res = Vec::new();
        for i in 0..arr.len() {
            if let Some(s) = arr.get(i) {
                let p = *s;
                if !p.is_null() {
                    let cf_str = CFString::wrap_under_get_rule(p as CFStringRef);
                    res.push(cf_str.to_string());
                }
            }
        }
        res
    }
}

unsafe fn is_ax_enabled(elem: AXUIElementRef) -> bool {
    unsafe {
        let Some(val) = ax_copy_attr(elem, "AXEnabled") else {
            return false;
        };
        let mut enabled: bool = false;
        let type_id = core_foundation::base::CFGetTypeID(val);
        if type_id == core_foundation::boolean::CFBooleanGetTypeID() {
            let b = val as core_foundation::boolean::CFBooleanRef;
            enabled = core_foundation::number::CFBooleanGetValue(b);
        }
        ax_release(val);
        enabled
    }
}

/// All text-bearing AX attributes a single element exposes — read in one pass so the BFS
/// body never has to choose between "fast (3 attrs)" and "complete (5 attrs)" paths.
#[derive(Debug, Default, Clone)]
pub(crate) struct NodeText {
    pub role: Option<String>,
    pub subrole: Option<String>,
    pub title: Option<String>,
    pub value: Option<String>,
    pub description: Option<String>,
    pub identifier: Option<String>,
    pub help: Option<String>,
}

unsafe fn ax_copy_string_attr(elem: AXUIElementRef, key: &str) -> Option<String> {
    unsafe {
        ax_copy_attr(elem, key).and_then(|v| {
            let s = cfstring_to_string(v);
            ax_release(v);
            s
        })
    }
}

pub(crate) unsafe fn read_node_text(elem: AXUIElementRef) -> NodeText {
    unsafe {
        NodeText {
            role: ax_copy_string_attr(elem, "AXRole"),
            subrole: ax_copy_string_attr(elem, "AXSubrole"),
            title: ax_copy_string_attr(elem, "AXTitle"),
            value: ax_copy_string_attr(elem, "AXValue"),
            description: ax_copy_string_attr(elem, "AXDescription"),
            identifier: ax_copy_string_attr(elem, "AXIdentifier"),
            help: ax_copy_string_attr(elem, "AXHelp"),
        }
    }
}

/// Legacy three-field shim used by `enumerate_ui_tree_text` and parent-context helpers; see
/// [`read_node_text`] for the full reader.
unsafe fn read_role_title_id(
    elem: AXUIElementRef,
) -> (Option<String>, Option<String>, Option<String>) {
    unsafe {
        let role = ax_copy_string_attr(elem, "AXRole");
        let title = ax_copy_string_attr(elem, "AXTitle");
        let ident = ax_copy_string_attr(elem, "AXIdentifier");
        (role, title, ident)
    }
}

/// Legacy two-field reader used by `enumerate_ui_tree_text`. Prefer [`read_node_text`].
unsafe fn read_value_desc(elem: AXUIElementRef) -> (Option<String>, Option<String>) {
    unsafe {
        let value = ax_copy_string_attr(elem, "AXValue");
        let desc = ax_copy_string_attr(elem, "AXDescription");
        (value, desc)
    }
}

/// Global center and axis-aligned bounds from `AXPosition` + `AXSize`.
unsafe fn element_frame_global(elem: AXUIElementRef) -> Option<(f64, f64, f64, f64, f64, f64)> {
    unsafe {
        let pos = ax_copy_attr(elem, "AXPosition")?;
        let size = ax_copy_attr(elem, "AXSize")?;
        let pt = ax_value_to_point(pos)?;
        let sz = ax_value_to_size(size)?;
        ax_release(pos);
        ax_release(size);
        if sz.width <= 0.0 || sz.height <= 0.0 {
            return None;
        }
        let left = pt.x;
        let top = pt.y;
        let w = sz.width;
        let h = sz.height;
        Some((left + w / 2.0, top + h / 2.0, left, top, w, h))
    }
}

struct Queued {
    ax: AXUIElementRef,
    depth: u32,
    /// Parent's role + title for context (e.g. "AXWindow: Settings").
    parent_desc: Option<String>,
}

/// A candidate match found during BFS, before ranking.
struct CandidateMatch {
    gx: f64,
    gy: f64,
    bounds_left: f64,
    bounds_top: f64,
    bounds_width: f64,
    bounds_height: f64,
    role: String,
    subrole: Option<String>,
    title: Option<String>,
    value: Option<String>,
    description: Option<String>,
    help: Option<String>,
    identifier: Option<String>,
    parent_desc: Option<String>,
    depth: u32,
    /// Whether AXHidden is explicitly false / absent (visible).
    is_visible: bool,
    /// Retained pointer to the matched AX node, used by climb-up to walk to a clickable ancestor.
    /// Released by [`release_candidate_refs`] once ranking is done.
    ax_ref: AXUIElementRef,
}

impl CandidateMatch {
    /// Higher = better. Prefer visible, reasonably-sized, shallower, on-screen elements.
    fn rank_score(&self, query: &UiElementLocateQuery) -> i64 {
        let mut score: i64 = 0;

        // Visibility is critical
        if !self.is_visible {
            score -= 10000;
        }

        // Off-screen penalty
        if !ui_locate_common::is_element_on_screen(
            self.gx,
            self.gy,
            self.bounds_width,
            self.bounds_height,
        ) {
            score -= 5000;
        }

        // Prefer reasonably-sized elements (buttons, text fields) over huge containers
        let area = self.bounds_width * self.bounds_height;
        if area > 0.0 && area < 50000.0 {
            score += 100; // Small interactive element
        } else if (50000.0..200000.0).contains(&area) {
            score += 50; // Medium element
        }
        // Very large elements (>200000 area) get no bonus -- likely containers

        // Prefer shallower elements (closer to the top of the tree = more likely
        // to be the "primary" instance vs a deeply nested duplicate)
        score -= self.depth as i64;

        // Bonus for elements in focused/active contexts
        if let Some(ref pd) = self.parent_desc {
            let pd_lower = pd.to_lowercase();
            if pd_lower.contains("sheet")
                || pd_lower.contains("dialog")
                || pd_lower.contains("popover")
            {
                score += 200; // Prefer elements in modal dialogs / sheets
            }
        }

        // Prefer elements with a non-empty title (more likely to be interactive)
        if self.title.as_ref().is_some_and(|t| !t.is_empty()) {
            score += 20;
        }

        // Among text inputs, the composer is usually **lower** on screen than the top search bar.
        let rl = self.role.to_lowercase();
        if rl.contains("textfield") || rl.contains("textarea") {
            score += ((self.gy / 8.0) as i64).clamp(0, 400);
        }

        // ── Batch 4: actionable role bias ────────────────────────────────────────────────
        // Strongly prefer truly clickable / interactive roles over pure containers. This
        // is what fixes the "matched the AXStaticText inside the card, not the card
        // button itself" case (the climb-up step then promotes any remaining static-text
        // match to its clickable ancestor).
        const ACTIONABLE_ROLES: &[&str] = &[
            "AXButton",
            "AXMenuItem",
            "AXMenuButton",
            "AXLink",
            "AXCheckBox",
            "AXRadioButton",
            "AXTextField",
            "AXTextArea",
            "AXSearchField",
            "AXCell",
            "AXRow",
            "AXTab",
            "AXPopUpButton",
            "AXDisclosureTriangle",
        ];
        if ACTIONABLE_ROLES.contains(&self.role.as_str()) {
            score += 300;
        }
        const CONTAINER_ROLES: &[&str] = &[
            "AXGroup",
            "AXSplitter",
            "AXSplitGroup",
            "AXScrollArea",
            "AXLayoutArea",
            "AXLayoutItem",
            "AXUnknown",
            "AXGenericElement",
        ];
        if CONTAINER_ROLES.contains(&self.role.as_str()) {
            score -= 200;
        }

        // ── Batch 4: text-quality bias ───────────────────────────────────────────────────
        // When the caller used `text_contains`, exact (case-insensitive) whole-string
        // matches against any text-bearing field beat substring-only matches. This is
        // what lets "五子棋" prefer the card title over a paragraph that *contains*
        // "五子棋" in body copy.
        if let Some(ref needle) = query.text_contains {
            let n = needle.trim().to_lowercase();
            if !n.is_empty() {
                let fields: [&Option<String>; 4] =
                    [&self.title, &self.value, &self.description, &self.help];
                let mut exact = false;
                let mut substring = false;
                for s in fields.into_iter().flatten() {
                    let sl = s.trim().to_lowercase();
                    if sl == n {
                        exact = true;
                        break;
                    }
                    if sl.contains(&n) {
                        substring = true;
                    }
                }
                if exact {
                    score += 150;
                } else if substring {
                    score += 50;
                }
            }
        }

        score
    }

    fn short_description(&self) -> String {
        let title_str = self.title.as_deref().unwrap_or("");
        let parent_str = self.parent_desc.as_deref().unwrap_or("?");
        let mut extras = String::new();
        if let Some(v) = self.value.as_deref().filter(|s| !s.is_empty()) {
            extras.push_str(&format!(" value={:?}", v));
        }
        if let Some(d) = self.description.as_deref().filter(|s| !s.is_empty()) {
            extras.push_str(&format!(" desc={:?}", d));
        }
        if let Some(sr) = self.subrole.as_deref().filter(|s| !s.is_empty()) {
            extras.push_str(&format!(" subrole={}", sr));
        }
        format!(
            "role={} title={:?}{} at ({:.0},{:.0}) size={:.0}x{:.0} parent=[{}]",
            self.role,
            title_str,
            extras,
            self.gx,
            self.gy,
            self.bounds_width,
            self.bounds_height,
            parent_str
        )
    }
}

/// Release any retained AX refs held by candidate matches (call exactly once after ranking).
fn release_candidate_refs(candidates: &mut [CandidateMatch]) {
    for c in candidates.iter_mut() {
        if !c.ax_ref.is_null() {
            unsafe { ax_release(c.ax_ref as CFTypeRef) };
            c.ax_ref = std::ptr::null();
        }
    }
}

/// Roles that are clickable/actionable enough to be a click target. Used by climb-up.
fn is_clickable_role(role: &str) -> bool {
    matches!(
        role,
        "AXButton"
            | "AXMenuItem"
            | "AXMenuButton"
            | "AXLink"
            | "AXCheckBox"
            | "AXRadioButton"
            | "AXCell"
            | "AXRow"
            | "AXTab"
            | "AXPopUpButton"
            | "AXDisclosureTriangle"
    )
}

/// Walk up `AXParent` from `start` (retained) up to `max_steps`, returning the first ancestor
/// whose role is "clickable" (button-like / cell). Returns the retained ancestor on success.
unsafe fn climb_to_clickable_ancestor(
    start: AXUIElementRef,
    max_steps: u32,
) -> Option<(AXUIElementRef, NodeText, (f64, f64, f64, f64, f64, f64))> {
    unsafe {
        let mut cur = start;
        let mut owns_cur = false;
        for _ in 0..max_steps {
            let parent_val = ax_copy_attr(cur, "AXParent");
            if owns_cur {
                ax_release(cur as CFTypeRef);
            }
            let Some(parent_val) = parent_val else {
                return None;
            };
            let parent = parent_val as AXUIElementRef;
            if parent.is_null() {
                ax_release(parent_val);
                return None;
            }
            // We now own `parent_val`; treat it as our retained ref.
            cur = parent;
            owns_cur = true;

            let nt = read_node_text(cur);
            if let Some(role) = nt.role.as_deref() {
                if is_clickable_role(role) {
                    if let Some(frame) = element_frame_global(cur) {
                        if frame.4 > 0.0 && frame.5 > 0.0 {
                            return Some((cur, nt, frame));
                        }
                    }
                }
            }
        }
        if owns_cur {
            ax_release(cur as CFTypeRef);
        }
        None
    }
}

/// Check if an AX element has `AXHidden` set to true.
unsafe fn is_ax_hidden(elem: AXUIElementRef) -> bool {
    unsafe {
        let Some(val) = ax_copy_attr(elem, "AXHidden") else {
            return false; // No AXHidden attribute = not hidden
        };
        // AXHidden is a CFBoolean
        let hidden = std::ptr::eq(
            val,
            core_foundation::boolean::kCFBooleanTrue as *const c_void,
        );
        ax_release(val);
        hidden
    }
}

/// Build a short description string for an element (for use as parent context).
fn element_short_desc(role: Option<&str>, title: Option<&str>) -> String {
    let r = role.unwrap_or("?");
    match title {
        Some(t) if !t.is_empty() => format!("{}: {}", r, t),
        _ => r.to_string(),
    }
}

const MAX_CANDIDATES: usize = 10;

/// Search only the explicitly selected application, even while another app is active.
pub(super) fn locate_ui_element_center_for_pid(
    pid: i32,
    query: &UiElementLocateQuery,
) -> OpenBitFunResult<UiElementLocateResult> {
    ui_locate_common::validate_query(query)?;

    // ── Batch 5: node_idx fast path ──────────────────────────────────────────
    // If the caller already grabbed an `app_state` snapshot, they can pass the
    // exact `node_idx` of the element they want. We resolve it via the per-pid
    // cache and skip BFS entirely. `app_state_digest` (when supplied) guards
    // against stale snapshots; without it we fall back to a loose lookup.
    if let Some(idx) = query.node_idx {
        let cached = match query.app_state_digest.as_deref() {
            Some(digest) => crate::computer_use::macos_ax_dump::cached_ref(pid, Some(digest), idx),
            None => crate::computer_use::macos_ax_dump::cached_ref_loose(pid, idx),
        };
        let ax = match cached {
            Some(r) => r,
            None => {
                return Err(OpenBitFunError::tool(format!(
                    "[AX_IDX_STALE] node_idx={} no longer present in cached app state for pid={}. \
                     Re-call `desktop.get_app_state` and reuse the freshly returned idx.",
                    idx, pid
                )));
            }
        };
        let nt = unsafe { read_node_text(ax.reference().0) };
        let frame = unsafe { element_frame_global(ax.reference().0) }.ok_or_else(|| {
            OpenBitFunError::tool(format!(
                "[AX_IDX_STALE] node_idx={} resolved but has no AXFrame (off-screen / minimised). \
                 Re-call `desktop.get_app_state`.",
                idx
            ))
        })?;
        let parent_context = Some(format!(
            "node_idx={} role={} title={:?}",
            idx,
            nt.role.as_deref().unwrap_or(""),
            nt.title.as_deref().unwrap_or(""),
        ));
        return ui_locate_common::ok_result_with_context_full(
            frame.0,
            frame.1,
            frame.2,
            frame.3,
            frame.4,
            frame.5,
            nt.role.unwrap_or_default(),
            nt.title,
            nt.identifier,
            parent_context,
            1,
            Vec::new(),
            Some(idx),
            Some("node_idx".to_string()),
        );
    }

    let max_depth = query.max_depth.unwrap_or(48).clamp(1, 200);
    let root = unsafe { AXUIElementCreateApplication(pid) };
    if root.is_null() {
        return Err(OpenBitFunError::tool(
            "AXUIElementCreateApplication returned null.".to_string(),
        ));
    }
    let mut bfs_queue = VecDeque::new();
    bfs_queue.push_back(Queued {
        ax: root,
        depth: 0,
        parent_desc: None,
    });
    let mut visited = 0usize;
    let max_nodes = 12_000usize;
    let mut candidates: Vec<CandidateMatch> = Vec::new();

    while let Some(cur) = bfs_queue.pop_front() {
        if cur.depth > max_depth {
            unsafe {
                ax_release(cur.ax as CFTypeRef);
            }
            continue;
        }
        visited += 1;
        if visited > max_nodes {
            unsafe {
                ax_release(cur.ax as CFTypeRef);
            }
            // Drain remaining queue
            while let Some(c) = bfs_queue.pop_front() {
                unsafe {
                    ax_release(c.ax as CFTypeRef);
                }
            }
            break;
        }

        let nt = unsafe { read_node_text(cur.ax) };
        let attrs = ui_locate_common::NodeAttrs {
            role: nt.role.as_deref(),
            subrole: nt.subrole.as_deref(),
            title: nt.title.as_deref(),
            value: nt.value.as_deref(),
            description: nt.description.as_deref(),
            identifier: nt.identifier.as_deref(),
            help: nt.help.as_deref(),
        };

        let matched = ui_locate_common::matches_filters_attrs(query, &attrs);
        let mut consumed_ref = false;
        if matched {
            if let Some((gx, gy, bl, bt, bw, bh)) = unsafe { element_frame_global(cur.ax) } {
                let is_visible = !unsafe { is_ax_hidden(cur.ax) };
                // Retain a fresh ref for the candidate so the climb-up step can walk parents
                // even after we've released our BFS-owned ref below.
                let retained = unsafe { CFRetain(cur.ax as CFTypeRef) as AXUIElementRef };
                consumed_ref = !retained.is_null();
                candidates.push(CandidateMatch {
                    gx,
                    gy,
                    bounds_left: bl,
                    bounds_top: bt,
                    bounds_width: bw,
                    bounds_height: bh,
                    role: nt.role.clone().unwrap_or_default(),
                    subrole: nt.subrole.clone(),
                    title: nt.title.clone(),
                    value: nt.value.clone(),
                    description: nt.description.clone(),
                    help: nt.help.clone(),
                    identifier: nt.identifier.clone(),
                    parent_desc: cur.parent_desc.clone(),
                    depth: cur.depth,
                    is_visible,
                    ax_ref: if consumed_ref {
                        retained
                    } else {
                        std::ptr::null()
                    },
                });
                // Stop collecting after MAX_CANDIDATES to avoid excessive work
                if candidates.len() >= MAX_CANDIDATES {
                    unsafe {
                        ax_release(cur.ax as CFTypeRef);
                    }
                    while let Some(c) = bfs_queue.pop_front() {
                        unsafe {
                            ax_release(c.ax as CFTypeRef);
                        }
                    }
                    break;
                }
            }
        }
        let _ = consumed_ref;

        // Build description for this node to pass as parent context to children
        let this_desc = element_short_desc(nt.role.as_deref(), nt.title.as_deref());

        let child_refs = unsafe { observation_children(cur.ax, cur.depth == 0) };
        let next_depth = cur.depth + 1;
        unsafe {
            ax_release(cur.ax as CFTypeRef);
        }

        for retained in child_refs {
            if !retained.is_null() {
                bfs_queue.push_back(Queued {
                    ax: retained,
                    depth: next_depth,
                    parent_desc: Some(this_desc.clone()),
                });
            }
        }
    }

    if candidates.is_empty() {
        return Err(OpenBitFunError::tool(
            "No accessibility element matched in the selected app. Tips: `role_substring` **`TextArea`** also matches **`AXTextField`**; use `text_contains` for any visible label; use `filter_combine: \"any\"` for OR matching; match the UI language; keep the same target app. If the AX tree is sparse, use `move_to_text` (OCR) or `describe_screen` / `screenshot` for target-scoped visual observation."
                .to_string(),
        ));
    }

    // Sort by rank score (descending); tie-break text fields toward **lower on screen** (chat input).
    candidates.sort_by(|a, b| {
        let sa = a.rank_score(query);
        let sb = b.rank_score(query);
        match sb.cmp(&sa) {
            std::cmp::Ordering::Equal => {
                let a_txt = a.role.contains("TextField") || a.role.contains("TextArea");
                let b_txt = b.role.contains("TextField") || b.role.contains("TextArea");
                if a_txt && b_txt {
                    b.gy.partial_cmp(&a.gy).unwrap_or(std::cmp::Ordering::Equal)
                } else {
                    std::cmp::Ordering::Equal
                }
            }
            o => o,
        }
    });

    let total = candidates.len() as u32;

    // Pull best out so we can mutate it (climb-up replaces frame in-place).
    let mut best = candidates.remove(0);

    // ── Batch 4: climb-up from AXStaticText to clickable ancestor ────────────────────────
    // If the highest-ranked match is a static-text leaf inside a button/cell, the user
    // almost certainly wants to click the wrapping container (e.g. the "五子棋" card),
    // not the text glyph. Walk parents up to 6 hops looking for a clickable role.
    let mut climbed_from: Option<String> = None;
    let area = best.bounds_width * best.bounds_height;
    if best.role == "AXStaticText" && area > 0.0 && area < 1500.0 && !best.ax_ref.is_null() {
        let original_text = best
            .title
            .clone()
            .or_else(|| best.value.clone())
            .or_else(|| best.description.clone())
            .unwrap_or_else(|| "<static text>".to_string());
        // Take the candidate's retained ref; climb_to_clickable_ancestor consumes it.
        let leaf_ref = best.ax_ref;
        best.ax_ref = std::ptr::null();
        if let Some((ancestor_ref, ancestor_nt, ancestor_frame)) =
            unsafe { climb_to_clickable_ancestor(leaf_ref, 6) }
        {
            best.gx = ancestor_frame.0;
            best.gy = ancestor_frame.1;
            best.bounds_left = ancestor_frame.2;
            best.bounds_top = ancestor_frame.3;
            best.bounds_width = ancestor_frame.4;
            best.bounds_height = ancestor_frame.5;
            best.role = ancestor_nt.role.clone().unwrap_or_default();
            best.subrole = ancestor_nt.subrole.clone();
            // Preserve the matched text in `title` slot for visibility, but record where it came from.
            if best.title.is_none() {
                best.title = ancestor_nt.title.clone();
            }
            best.identifier = ancestor_nt.identifier.clone().or(best.identifier.clone());
            climbed_from = Some(original_text);
            unsafe { ax_release(ancestor_ref as CFTypeRef) };
        } else {
            // Climb failed — leaf stays as the result; release nothing extra (leaf_ref already consumed).
        }
    }

    // Build "other matches" summaries for the model to see alternatives
    let other_matches: Vec<String> = candidates
        .iter()
        .take(4)
        .map(|c| c.short_description())
        .collect();

    // Choose `matched_via` based on which filter actually contributed to the win.
    let matched_via = if query.text_contains.is_some() {
        Some("text_contains".to_string())
    } else if query.title_contains.is_some() {
        Some("title_contains".to_string())
    } else if query.role_substring.is_some() {
        Some("role_substring".to_string())
    } else if query.identifier_contains.is_some() {
        Some("identifier_contains".to_string())
    } else {
        None
    };
    let matched_via = match (matched_via, climbed_from.as_ref()) {
        (Some(v), Some(_)) => Some(format!("climbed:{}", v)),
        (Some(v), None) => Some(v),
        (None, Some(_)) => Some("climbed".to_string()),
        (None, None) => None,
    };
    let parent_context = match climbed_from {
        Some(text) => Some(format!(
            "{} (climbed from AXStaticText {:?})",
            best.parent_desc.as_deref().unwrap_or("?"),
            text,
        )),
        None => best.parent_desc.clone(),
    };

    // Release the best candidate's retained ref (if any) and any remaining candidate refs.
    if !best.ax_ref.is_null() {
        unsafe { ax_release(best.ax_ref as CFTypeRef) };
        best.ax_ref = std::ptr::null();
    }
    release_candidate_refs(&mut candidates);

    ui_locate_common::ok_result_with_context_full(
        best.gx,
        best.gy,
        best.bounds_left,
        best.bounds_top,
        best.bounds_width,
        best.bounds_height,
        best.role.clone(),
        best.title.clone(),
        best.identifier.clone(),
        parent_context,
        total,
        other_matches,
        None,
        matched_via,
    )
}

unsafe fn is_ax_interactive(elem: AXUIElementRef, role: &str) -> bool {
    unsafe {
        let actions = ax_copy_action_names(elem);
        let interactive_actions = [
            "AXPress",
            "AXShowMenu",
            "AXIncrement",
            "AXDecrement",
            "AXConfirm",
            "AXCancel",
            "AXRaise",
            "AXSetValue",
            "AXScrollLeftByPage",
            "AXScrollRightByPage",
            "AXScrollUpByPage",
            "AXScrollDownByPage",
        ];

        let mut has_interactive = false;
        for a in &actions {
            if interactive_actions.contains(&a.as_str()) {
                has_interactive = true;
                break;
            }
        }

        if actions.iter().any(|a| a == "AXSetValue") && role == "AXTextField" {
            return is_ax_enabled(elem);
        }

        if actions.iter().any(|a| a == "AXPress") && (role == "AXButton" || role == "AXLink") {
            return is_ax_enabled(elem);
        }

        has_interactive
    }
}

/// Enumerate visible interactive elements in the selected app's AX tree
/// and return a condensed text representation of the UI for context.
pub(super) fn enumerate_ui_tree_text_for_pid(pid: i32, max_elements: usize) -> Option<String> {
    let root = unsafe { AXUIElementCreateApplication(pid) };
    if root.is_null() {
        return None;
    }

    let win_bounds = window_bounds_global_for_pid(pid).ok();

    struct BfsItem {
        ax: AXUIElementRef,
        depth: u32,
    }

    struct InteractiveElement {
        label: u32,
        role: String,
        title: Option<String>,
        value: Option<String>,
        description: Option<String>,
        bounds_width: f64,
        bounds_height: f64,
    }

    let mut queue = VecDeque::new();
    queue.push_back(BfsItem { ax: root, depth: 0 });
    let max_depth: u32 = 30;
    let max_nodes: usize = 8_000;
    let mut visited: usize = 0;
    let mut results: Vec<InteractiveElement> = Vec::new();

    while let Some(cur) = queue.pop_front() {
        if cur.depth > max_depth || results.len() >= max_elements {
            unsafe {
                ax_release(cur.ax as CFTypeRef);
            }
            continue;
        }
        visited += 1;
        if visited > max_nodes {
            unsafe {
                ax_release(cur.ax as CFTypeRef);
            }
            while let Some(c) = queue.pop_front() {
                unsafe {
                    ax_release(c.ax as CFTypeRef);
                }
            }
            break;
        }

        let (role_s, title_s, _id_s) = unsafe { read_role_title_id(cur.ax) };
        let role = role_s.as_deref().unwrap_or("");

        if unsafe { is_ax_interactive(cur.ax, role) } {
            let hidden = unsafe { is_ax_hidden(cur.ax) };
            if !hidden {
                if let Some((gx, gy, bl, bt, bw, bh)) = unsafe { element_frame_global(cur.ax) } {
                    if bw >= 4.0 && bh >= 4.0 && bw <= 2000.0 && bh <= 1000.0 {
                        let mut on_screen = gx >= 0.0 && gy >= 0.0;
                        if let Some((wx, wy, ww, wh)) = win_bounds {
                            let wx_f = wx as f64;
                            let wy_f = wy as f64;
                            let ww_f = ww as f64;
                            let wh_f = wh as f64;
                            on_screen = bl < wx_f + ww_f
                                && bl + bw > wx_f
                                && bt < wy_f + wh_f
                                && bt + bh > wy_f;
                        }
                        if on_screen {
                            let (val_s, desc_s) = unsafe { read_value_desc(cur.ax) };
                            let label = results.len() as u32 + 1;
                            results.push(InteractiveElement {
                                label,
                                role: role.to_string(),
                                title: title_s.clone().filter(|s| !s.is_empty()),
                                value: val_s.filter(|s| !s.is_empty()),
                                description: desc_s.filter(|s| !s.is_empty()),
                                bounds_width: bw,
                                bounds_height: bh,
                            });
                            if results.len() >= max_elements {
                                unsafe {
                                    ax_release(cur.ax as CFTypeRef);
                                }
                                while let Some(c) = queue.pop_front() {
                                    unsafe {
                                        ax_release(c.ax as CFTypeRef);
                                    }
                                }
                                break;
                            }
                        }
                    }
                }
            }
        }

        let child_refs = unsafe { observation_children(cur.ax, cur.depth == 0) };
        let next_depth = cur.depth + 1;
        unsafe {
            ax_release(cur.ax as CFTypeRef);
        }

        for retained in child_refs {
            if !retained.is_null() {
                queue.push_back(BfsItem {
                    ax: retained,
                    depth: next_depth,
                });
            }
        }
    }

    if results.is_empty() {
        return None;
    }
    let mut ui_tree_lines = Vec::new();
    for el in &results {
        let mut attrs = String::new();
        if let Some(t) = &el.title {
            attrs.push_str(&format!(" title: \"{}\"", t));
        }
        if let Some(v) = &el.value {
            attrs.push_str(&format!(" value: \"{}\"", v));
        }
        if let Some(d) = &el.description {
            attrs.push_str(&format!(" description: \"{}\"", d));
        }
        attrs.push_str(&format!(
            " (w,h): \"{}, {}\"",
            el.bounds_width as i32, el.bounds_height as i32
        ));
        ui_tree_lines.push(format!(
            "{}[:]<{} {}>",
            el.label,
            el.role,
            attrs.trim_start()
        ));
    }
    Some(ui_tree_lines.join("\n"))
}

unsafe fn ax_parent_context_line(elem: AXUIElementRef) -> Option<String> {
    unsafe {
        let parent_val = ax_copy_attr(elem, "AXParent")?;
        let parent = parent_val as AXUIElementRef;
        if parent.is_null() {
            ax_release(parent_val);
            return None;
        }
        let (r, t, _) = read_role_title_id(parent);
        ax_release(parent_val);
        Some(element_short_desc(r.as_deref(), t.as_deref()))
    }
}

/// Hit-test the accessibility element at global screen coordinates (OCR `move_to_text` disambiguation).
pub(super) fn accessibility_hit_at_global_point_for_pid(
    pid: i32,
    gx: f64,
    gy: f64,
) -> Option<OcrAccessibilityHit> {
    unsafe { accessibility_hit_from_root(AXUIElementCreateApplication(pid), Some(pid), gx, gy) }
}

unsafe fn accessibility_hit_from_root(
    sys: AXUIElementRef,
    expected_pid: Option<i32>,
    gx: f64,
    gy: f64,
) -> Option<OcrAccessibilityHit> {
    unsafe {
        if sys.is_null() {
            return None;
        }
        let mut elem: AXUIElementRef = std::ptr::null();
        let err = AXUIElementCopyElementAtPosition(sys, gx as f32, gy as f32, &mut elem);
        ax_release(sys as CFTypeRef);
        if err != 0 || elem.is_null() {
            if !elem.is_null() {
                ax_release(elem as CFTypeRef);
            }
            return None;
        }
        if let Some(expected) = expected_pid {
            let mut actual = 0;
            if AXUIElementGetPid(elem, &mut actual) != 0 || actual != expected {
                ax_release(elem as CFTypeRef);
                return None;
            }
        }
        let (role, title, ident) = read_role_title_id(elem);
        let parent_context = ax_parent_context_line(elem);
        ax_release(elem as CFTypeRef);
        let desc = format!(
            "{} | title={:?} | id={:?} | parent=[{}]",
            role.as_deref().unwrap_or("?"),
            title.as_deref().unwrap_or(""),
            ident.as_deref().unwrap_or(""),
            parent_context.as_deref().unwrap_or("?"),
        );
        Some(OcrAccessibilityHit {
            role,
            title,
            identifier: ident,
            parent_context,
            description: desc,
        })
    }
}

/// Number of windows the app currently owns, per the AX `AXWindows` attribute.
///
/// A launched-but-windowless app — common for Electron clients whose window was
/// closed while the process kept running — is otherwise indistinguishable from a
/// healthy launch: `open_app` reports `success: true` with a live pid while
/// there is nothing on screen to act on. Returning the count lets `open_app`
/// detect that case and re-open the app instead of leaving the agent to
/// discover it by trial and error.
///
/// `None` means the AX handle could not be created at all (dead pid, no
/// Accessibility trust); `Some(0)` means the app is alive with no windows.
pub(super) fn window_count_for_pid(pid: i32) -> Option<usize> {
    // SAFETY: `AXUIElementCreateApplication` accepts any pid and returns null
    // rather than an invalid handle, which we check before use.
    let app = unsafe { AXUIElementCreateApplication(pid) };
    if app.is_null() {
        return None;
    }
    // SAFETY: `app` is a live non-null AXUIElementRef we own. `ax_copy_attr`
    // follows the CF *Copy* rule, so the returned array carries a +1 retain that
    // `wrap_under_create_rule` takes over. `app` is released as soon as the
    // attribute has been copied out of it, on both the Some and None paths.
    unsafe {
        let arr_ref = ax_copy_attr(app, "AXWindows");
        ax_release(app as CFTypeRef);
        let arr_ref = arr_ref?;
        let arr = CFArray::<*const c_void>::wrap_under_create_rule(arr_ref as CFArrayRef);
        Some(arr.len() as usize)
    }
}

/// Bounds of the selected app's focused or main window in global screen coordinates.
pub(super) fn window_bounds_global_for_pid(pid: i32) -> OpenBitFunResult<(i32, i32, u32, u32)> {
    let app = unsafe { AXUIElementCreateApplication(pid) };
    if app.is_null() {
        return Err(OpenBitFunError::tool(
            "AXUIElementCreateApplication returned null for window bounds.".to_string(),
        ));
    }
    unsafe {
        let win = try_frontmost_window_element(app);
        ax_release(app as CFTypeRef);
        let Some(win) = win else {
            return Err(OpenBitFunError::tool(
                "No AX window for target app (try AXFocusedWindow / AXMainWindow / AXWindows)."
                    .to_string(),
            ));
        };
        let frame = element_frame_global(win).ok_or_else(|| {
            ax_release(win as CFTypeRef);
            OpenBitFunError::tool("Could not read AXPosition/AXSize for target window.".to_string())
        })?;
        ax_release(win as CFTypeRef);
        let (_, _, bl, bt, bw, bh) = frame;
        if bw < 1.0 || bh < 1.0 {
            return Err(OpenBitFunError::tool(
                "Target window has invalid size for screenshot.".to_string(),
            ));
        }
        let x0 = bl.floor() as i32;
        let y0 = bt.floor() as i32;
        let w = bw.ceil().max(1.0) as u32;
        let h = bh.ceil().max(1.0) as u32;
        Ok((x0, y0, w, h))
    }
}

/// Match the exact WindowServer identity retained by the capture session. The
/// private lookup is optional: if unavailable, return no match rather than
/// substituting another same-app window with similar bounds or title.
pub(super) unsafe fn ax_window_id(element: AXUIElementRef) -> Option<u32> {
    type GetWindow = unsafe extern "C" fn(AXUIElementRef, *mut u32) -> i32;
    static LOOKUP: std::sync::OnceLock<Option<GetWindow>> = std::sync::OnceLock::new();
    let lookup = (*LOOKUP.get_or_init(|| {
        let symbol = unsafe { libc::dlsym(libc::RTLD_DEFAULT, c"_AXUIElementGetWindow".as_ptr()) };
        if symbol.is_null() {
            None
        } else {
            Some(unsafe { std::mem::transmute::<*mut c_void, GetWindow>(symbol) })
        }
    }))?;
    let mut window_id = 0;
    if unsafe { lookup(element, &mut window_id) } == 0 {
        Some(window_id)
    } else {
        None
    }
}

pub(super) unsafe fn try_window_element_by_id(
    app: AXUIElementRef,
    window_id: u32,
) -> Option<AXUIElementRef> {
    unsafe {
        if let Some(raw) = ax_copy_attr(app, "AXWindows") {
            let windows = CFArray::<*const c_void>::wrap_under_create_rule(raw as CFArrayRef);
            for index in 0..windows.len() {
                let Some(value) = windows.get(index) else {
                    continue;
                };
                let element = *value as AXUIElementRef;
                if !element.is_null() && ax_window_id(element) == Some(window_id) {
                    return Some(CFRetain(element as CFTypeRef) as AXUIElementRef);
                }
            }
        }
        for name in ["AXFocusedWindow", "AXMainWindow"] {
            if let Some(raw) = ax_copy_attr(app, name) {
                if ax_window_id(raw as AXUIElementRef) == Some(window_id) {
                    return Some(raw as AXUIElementRef);
                }
                ax_release(raw);
            }
        }
    }
    None
}

pub(super) fn focused_window_id(pid: i32) -> Option<u32> {
    unsafe {
        let app = AXUIElementCreateApplication(pid);
        if app.is_null() {
            return None;
        }
        AXUIElementSetMessagingTimeout(app, 0.5);
        let window = ax_copy_attr(app, "AXFocusedWindow");
        let id = window.and_then(|window| {
            let id = ax_window_id(window as AXUIElementRef);
            ax_release(window);
            id
        });
        ax_release(app);
        id
    }
}

pub(super) fn raise_window(pid: i32, window: u32) -> OpenBitFunResult<()> {
    super::control_session::foreground_allowed().map_err(OpenBitFunError::tool)?;
    super::control_session::target_allowed(&format!("pid:{pid}/window:{window}"))
        .map_err(OpenBitFunError::tool)?;
    unsafe {
        let app = AXUIElementCreateApplication(pid);
        if app.is_null() {
            return Err(OpenBitFunError::tool(
                "[AX_STALE_TARGET] Application is unavailable",
            ));
        }
        AXUIElementSetMessagingTimeout(app, 0.5);
        let element = try_window_element_by_id(app, window);
        ax_release(app);
        let element = element.ok_or_else(|| {
            OpenBitFunError::tool("[AX_STALE_TARGET] The exact window is unavailable")
        })?;
        let action = CFString::new("AXRaise");
        let result = AXUIElementPerformAction(element, action.as_concrete_TypeRef());
        ax_release(element);
        if result != 0 {
            return Err(OpenBitFunError::tool(format!("[FOREGROUND_ACTIVATION_DENIED] AXRaise failed ({result}); verify current focus before input")));
        }
    }
    Ok(())
}

pub(super) unsafe fn try_frontmost_window_element(app: AXUIElementRef) -> Option<AXUIElementRef> {
    unsafe {
        for key in ["AXFocusedWindow", "AXMainWindow"] {
            if let Some(w) = ax_copy_attr(app, key) {
                let elem = w as AXUIElementRef;
                if !elem.is_null()
                    && element_frame_global(elem).is_some()
                    && !is_sharing_indicator_window(elem)
                {
                    return Some(elem);
                }
                ax_release(w);
            }
        }
        first_ax_window_from_ax_windows(app)
    }
}

#[allow(dead_code)] // legacy: text-caret crop is gone; kept for completeness
fn is_text_editing_ax_role(role: &str) -> bool {
    matches!(
        role,
        "AXTextField" | "AXTextArea" | "AXComboBox" | "AXSearchField" | "AXSecureTextField"
    )
}

#[allow(dead_code)]
unsafe fn ax_focused_element_from_system_wide() -> Option<AXUIElementRef> {
    unsafe {
        let sys = AXUIElementCreateSystemWide();
        if sys.is_null() {
            return None;
        }
        let mut focused: CFTypeRef = std::ptr::null();
        let k = CFString::new("AXFocusedUIElement");
        let st = AXUIElementCopyAttributeValue(sys, k.as_concrete_TypeRef(), &mut focused);
        if st != 0 || focused.is_null() {
            if !focused.is_null() {
                ax_release(focused);
            }
            return None;
        }
        Some(focused as AXUIElementRef)
    }
}

/// Best-effort global (x, y) for a 500×500 screenshot centered near the focused text field (AX element center).
/// Returns `None` if no suitable focused text UI; caller should fall back to the mouse position.
#[allow(dead_code)]
pub(super) fn global_point_for_text_caret_screenshot(mx: f64, my: f64) -> (f64, f64) {
    unsafe {
        let Some(el) = ax_focused_element_from_system_wide() else {
            return (mx, my);
        };
        let (role, _, _) = read_role_title_id(el);
        let Some(role) = role.as_deref() else {
            ax_release(el as CFTypeRef);
            return (mx, my);
        };
        if !is_text_editing_ax_role(role) {
            ax_release(el as CFTypeRef);
            return (mx, my);
        }
        let Some((gx, gy, _, _, _, _)) = element_frame_global(el) else {
            ax_release(el as CFTypeRef);
            return (mx, my);
        };
        ax_release(el as CFTypeRef);
        (gx, gy)
    }
}

unsafe fn first_ax_window_from_ax_windows(app: AXUIElementRef) -> Option<AXUIElementRef> {
    unsafe {
        let arr_ref = ax_copy_attr(app, "AXWindows")?;
        let arr = CFArray::<*const c_void>::wrap_under_create_rule(arr_ref as CFArrayRef);
        for i in 0..arr.len() {
            let Some(w) = arr.get(i) else {
                continue;
            };
            let child = *w as AXUIElementRef;
            if child.is_null() {
                continue;
            }
            let retained = CFRetain(child as CFTypeRef) as AXUIElementRef;
            if retained.is_null() {
                continue;
            }
            let (role, _, _) = read_role_title_id(retained);
            if role.as_deref() == Some("AXWindow")
                && element_frame_global(retained).is_some()
                && !is_sharing_indicator_window(retained)
            {
                return Some(retained);
            }
            ax_release(retained as CFTypeRef);
        }
        None
    }
}

/// The system adds this auxiliary panel to AXWindows while sharing. It is
/// sharing chrome, not an application dialog or an input destination.
pub(super) unsafe fn is_sharing_indicator_window(elem: AXUIElementRef) -> bool {
    unsafe {
        let Some(value) = ax_copy_attr(elem, "AXChildren") else {
            return false;
        };
        if CFGetTypeID(value) != core_foundation::array::CFArrayGetTypeID() {
            ax_release(value);
            return false;
        }
        let children = CFArray::<*const c_void>::wrap_under_create_rule(value as CFArrayRef);
        let is_indicator = children.iter().any(|child| {
            let (_, title, identifier) = read_role_title_id(*child);
            title.as_deref() == Some("WindowSharingSessionButton")
                || identifier.as_deref() == Some("WindowSharingSessionButton")
        });
        is_indicator
    }
}

unsafe fn observation_children(elem: AXUIElementRef, app_root: bool) -> Vec<AXUIElementRef> {
    unsafe {
        let mut result = Vec::new();
        let attrs: &[&str] = if app_root {
            &["AXChildren", "AXWindows"]
        } else {
            &["AXChildren"]
        };
        for key in attrs {
            let Some(value) = ax_copy_attr(elem, key) else {
                continue;
            };
            if CFGetTypeID(value) != core_foundation::array::CFArrayGetTypeID() {
                ax_release(value);
                continue;
            }
            let children = CFArray::<*const c_void>::wrap_under_create_rule(value as CFArrayRef);
            for child in children.iter() {
                let child = *child;
                if child.is_null() || result.iter().any(|known| CFEqual(*known, child) != 0) {
                    continue;
                }
                result.push(CFRetain(child));
            }
        }
        result
    }
}

#[cfg(test)]
mod tests {
    use std::io::Read;

    fn module_source() -> String {
        let path = std::path::Path::new(env!("CARGO_MANIFEST_DIR"))
            .join("src/computer_use/macos_ax_ui.rs");
        let mut src = String::new();
        std::fs::File::open(&path)
            .unwrap()
            .read_to_string(&mut src)
            .unwrap();
        src
    }

    /// Extract the body of `fn rank_score` (the AX candidate scoring logic),
    /// by brace-matching the function body.
    fn rank_score_body(src: &str) -> &str {
        let sig = src.find("fn rank_score").expect("rank_score present");
        let open = src[sig..].find('{').expect("rank_score body open brace") + sig;
        let mut depth: i32 = 0;
        let mut end = open;
        for (i, b) in src[open..].char_indices() {
            match b {
                '{' => depth += 1,
                '}' => {
                    depth -= 1;
                    if depth == 0 {
                        end = open + i;
                        break;
                    }
                }
                _ => {}
            }
        }
        &src[open + 1..end]
    }

    /// Guard against regressing special-case, app-specific adaptations in the AX
    /// ranking logic. A prior WeChat-private hack inspected the `identifier`
    /// field for a vendor prefix and applied a hardcoded score penalty. It must
    /// not come back: AX ranking stays generic (role, visibility, size, depth,
    /// screen position) and app-specific disambiguation is left to the model via
    /// `describe_screen` / `get_app_state`.
    #[test]
    fn ax_ranking_does_not_branch_on_identifier() {
        let src = module_source();
        let body = rank_score_body(&src);
        assert!(
            !body.contains("identifier"),
            "rank_score must not branch on the AX `identifier` field — that invites app-specific hacks. Got: {}",
            body
        );
    }

    /// The "no AX element matched" error must stay model-neutral and app-agnostic:
    /// no WeChat / chat-app specific guidance baked into a generic locate failure.
    #[test]
    fn no_match_error_is_app_agnostic() {
        let src = module_source();
        // The error string lives outside the test module, so scoping to the
        // pre-`#[cfg(test)]` slice keeps the assertion self-contained.
        let scope_end = src.find("#[cfg(test)]").unwrap_or(src.len());
        let scope = &src[..scope_end];
        let err_start = scope
            .find("No accessibility element matched in the selected app")
            .expect("no-match error string present");
        let err_end = scope[err_start..]
            .find('\n')
            .unwrap_or(scope.len() - err_start);
        let err = &scope[err_start..err_start + err_end];
        assert!(
            !err.contains("WeChat") && !err.contains("chat app"),
            "no-match error must not name a specific app/category: {}",
            err
        );
    }
}
