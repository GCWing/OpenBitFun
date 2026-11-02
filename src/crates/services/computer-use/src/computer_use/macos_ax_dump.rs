//! Codex-style macOS Accessibility (AX) tree dump.
//!
//! Walks an application's full AX tree (BFS) starting from a `pid`, emits:
//!   * a human-readable indented `tree_text` (Codex parity),
//!   * a structured `Vec<AxNode>` with stable, monotonic `idx` values,
//!   * a sha1 `digest` over the structural fingerprint so callers can detect
//!     "did anything change?" cheaply,
//!   * a per-pid cache mapping `idx → AXUIElementRef` so subsequent
//!     `app_click` / `app_type_text` / ... actions can resolve a numeric idx
//!     back to a live AX element without re-walking.
//!
//! All AX refs returned in the cache are `CFRetain`-ed and released when
//! the snapshot for that pid is replaced.

// Symbols here are wired up by the ControlHub `desktop.*` dispatch layer in a
// follow-up step (`controlhub-actions`). Until then, suppress dead-code lints
// without weakening real warnings elsewhere.
#![allow(dead_code)]

use super::ax_snapshot_digest::compute_digest;
use super::macos_ax_dispatch::{
    copy_action_names as AXUIElementCopyActionNames,
    copy_attribute_value as AXUIElementCopyAttributeValue,
    copy_element_at_position as AXUIElementCopyElementAtPosition,
    set_attribute_value as AXUIElementSetAttributeValue,
};
use core_foundation::array::{CFArray, CFArrayRef};
use core_foundation::base::{CFGetTypeID, CFTypeRef, TCFType};
use core_foundation::boolean::{CFBoolean, CFBooleanGetTypeID, CFBooleanRef};
use core_foundation::string::{CFString, CFStringRef};
use core_graphics::geometry::{CGPoint, CGSize};
use openbitfun_agent_tools::computer_use_host::error::{OpenBitFunError, OpenBitFunResult};
use openbitfun_agent_tools::computer_use_host::{AppStateSnapshot, AxNode};
use std::collections::{HashMap, VecDeque};
use std::ffi::c_void;
use std::sync::{Mutex, OnceLock};
use std::thread;
use std::time::{Duration, SystemTime, UNIX_EPOCH};

type CFNumberRef = *const c_void;
type CFTypeID = usize;
const K_CF_NUMBER_DOUBLE_TYPE: i32 = 13;
const K_CF_NUMBER_LONG_LONG_TYPE: i32 = 11;

type AXUIElementRef = *const c_void;
type AXValueRef = *const c_void;

#[link(name = "ApplicationServices", kind = "framework")]
unsafe extern "C" {
    fn AXUIElementCreateApplication(pid: i32) -> AXUIElementRef;
    fn AXUIElementGetPid(element: AXUIElementRef, pid: *mut i32) -> i32;
    fn AXUIElementSetMessagingTimeout(element: AXUIElementRef, timeout: f32) -> i32;
    fn AXValueGetType(value: AXValueRef) -> u32;
    fn AXValueGetValue(value: AXValueRef, the_type: u32, ptr: *mut c_void) -> bool;
    fn AXUIElementGetTypeID() -> CFTypeID;
}

#[link(name = "CoreFoundation", kind = "framework")]
unsafe extern "C" {
    fn CFRetain(cf: CFTypeRef) -> CFTypeRef;
    fn CFEqual(a: CFTypeRef, b: CFTypeRef) -> u8;
    fn CFBooleanGetValue(boolean: CFBooleanRef) -> u8;
    fn CFStringGetTypeID() -> CFTypeID;
    fn CFNumberGetTypeID() -> CFTypeID;
    fn CFNumberIsFloatType(number: CFNumberRef) -> u8;
    fn CFNumberGetValue(number: CFNumberRef, the_type: i32, value_ptr: *mut c_void) -> u8;
}

const K_AX_VALUE_CGPOINT: u32 = 1;
const K_AX_VALUE_CGSIZE: u32 = 2;

// ── Wrappers around raw pointers so we can stash them in `Send`-able caches ─

/// Newtype wrapping `AXUIElementRef`. Manually implements `Send + Sync` —
/// AX refs are CF objects, safe to share across threads as long as we only
/// drop them with `CFRelease`. The cache is internally locked.
#[derive(Copy, Clone)]
pub(crate) struct AxRef(pub AXUIElementRef);
unsafe impl Send for AxRef {}
unsafe impl Sync for AxRef {}

impl AxRef {
    fn release(self) {
        if !self.0.is_null() {
            unsafe { core_foundation::base::CFRelease(self.0 as CFTypeRef) };
        }
    }
}

// ── Per-pid cache: snapshot id → idx → retained AXUIElementRef ─────────────
//
// We keep the most recent snapshot per pid only; resolving a stale `idx`
// against an old snapshot returns `None`, which the dispatch layer maps to
// `AX_NODE_STALE`.

struct CachedSnapshot {
    scope: openbitfun_agent_tools::computer_use_control::ObservationScope,
    digest: String,
    refs: Vec<AxRef>,
}

impl Drop for CachedSnapshot {
    fn drop(&mut self) {
        for r in self.refs.drain(..) {
            r.release();
        }
    }
}

static SNAPSHOT_CACHE: OnceLock<Mutex<HashMap<i32, CachedSnapshot>>> = OnceLock::new();

fn snapshot_cache() -> &'static Mutex<HashMap<i32, CachedSnapshot>> {
    SNAPSHOT_CACHE.get_or_init(|| Mutex::new(HashMap::new()))
}

pub(super) fn clear_observations() {
    if let Ok(mut cache) = snapshot_cache().lock() {
        cache.clear();
    }
}

/// Resolve and retain `(pid, idx)` while the cache is locked. Stop or a new
/// observation can clear the cache immediately after this lookup; the caller's
/// reference stays alive until its guard is dropped.
pub(crate) fn cached_ref(
    pid: i32,
    expected_digest: Option<&str>,
    idx: u32,
) -> Option<RetainedCachedTarget> {
    let cache = snapshot_cache().lock().ok()?;
    let snap = cache.get(&pid)?;
    if snap.scope
        != openbitfun_agent_tools::computer_use_control::ObservationScope::from_control(
            &super::control_session::snapshot(),
        )
    {
        return None;
    }
    if let Some(want) = expected_digest {
        if snap.digest != want {
            return None;
        }
    }
    let reference = *snap.refs.get(idx as usize)?;
    if reference.0.is_null() {
        return None;
    }
    unsafe { CFRetain(reference.0 as CFTypeRef) };
    Some(RetainedCachedTarget(reference))
}

/// Like `cached_ref` but does not require a digest match. Used for
/// best-effort follow-up actions where the caller did not have a chance to
/// re-snapshot (e.g. `app_wait_for` polling).
pub(crate) fn cached_ref_loose(pid: i32, idx: u32) -> Option<RetainedCachedTarget> {
    cached_ref(pid, None, idx)
}

/// A retained reference to the exact observed node. Unlike a borrowed cache
/// pointer, this remains alive if a later observation replaces the cache.
pub(crate) struct RetainedCachedTarget(AxRef);

impl RetainedCachedTarget {
    pub(crate) fn reference(&self) -> AxRef {
        self.0
    }

    pub(crate) fn role(&self) -> Option<String> {
        unsafe { read_cf_string_attr(self.0 .0, "AXRole") }
    }

    pub(crate) fn is_focused(&self) -> bool {
        (unsafe { read_cf_bool_attr(self.0 .0, "AXFocused") }) == Some(true)
    }

    pub(crate) fn is_text_input(&self) -> bool {
        matches!(
            self.role().as_deref(),
            Some("AXTextField" | "AXTextArea" | "AXSearchField")
        )
    }

    /// Only controls whose primary activation is independent of the exact
    /// point can replace a plain coordinate click with AXPress. Text, sliders,
    /// containers and custom canvases retain their coordinate semantics.
    pub(crate) fn supports_point_press(&self) -> bool {
        matches!(
            self.role().as_deref(),
            Some("AXButton" | "AXCheckBox" | "AXRadioButton" | "AXLink")
        ) && unsafe { read_cf_bool_attr(self.0 .0, "AXEnabled") } != Some(false)
            && unsafe { read_action_names(self.0 .0) }
                .iter()
                .any(|action| action == "AXPress")
    }

    pub(crate) fn frame_global(&self) -> Option<(f64, f64, f64, f64)> {
        unsafe { read_global_frame(self.0 .0) }
    }
}

impl Drop for RetainedCachedTarget {
    fn drop(&mut self) {
        self.0.release();
    }
}

pub(crate) fn retained_cached_target(pid: i32, idx: u32) -> Option<RetainedCachedTarget> {
    cached_ref(pid, None, idx)
}

pub(crate) fn validate_bound_target(pid: i32, target: AxRef) -> OpenBitFunResult<()> {
    super::control_session::input_allowed().map_err(OpenBitFunError::tool)?;
    let bound = super::macos_capture::bound_window_id(pid).map_err(OpenBitFunError::tool)?;
    let mut actual_pid = 0;
    if unsafe { AXUIElementGetPid(target.0, &mut actual_pid) } != 0 || actual_pid != pid {
        return Err(OpenBitFunError::tool(
            "AX_TARGET_MISMATCH: Accessibility target belongs to a different application",
        ));
    }
    // An open menu or popup of the bound window is a separate window of the
    // same process; physical input there reaches it, so its elements qualify.
    let allowed = match element_window_id(target) {
        Some(actual) => {
            actual == bound
                || super::macos_capture::overlays(pid, bound)
                    .is_ok_and(|overlays| overlays.iter().any(|o| o.window_id == actual as u64))
        }
        None => is_application_menu_item(target),
    };
    if !allowed {
        return Err(OpenBitFunError::tool(
            "AX_TARGET_MISMATCH: Accessibility target does not belong to the captured window",
        ));
    }
    super::control_session::target_allowed(&format!("pid:{pid}/window:{bound}"))
        .map_err(OpenBitFunError::tool)
}

pub(crate) fn element_window_id(target: AxRef) -> Option<u32> {
    unsafe {
        super::macos_ax_ui::ax_window_id(target.0)
            .filter(|id| *id != 0)
            .or_else(|| {
                let owner = ax_copy_attr(target.0, "AXWindow")?;
                let id =
                    super::macos_ax_ui::ax_window_id(owner as AXUIElementRef).filter(|id| *id != 0);
                ax_release(owner);
                id
            })
    }
}

pub(crate) fn is_application_menu_item(target: AxRef) -> bool {
    unsafe {
        matches!(
            read_cf_string_attr(target.0, "AXRole").as_deref(),
            Some("AXMenuItem" | "AXMenuBarItem")
        )
    }
}

/// Hit testing is a read-only optimization for an independently addressed
/// window coordinate. A busy app or missing AX implementation does not make
/// directed pointer input unavailable. Never apply this policy to AX writes or
/// observed node indices: their outcome/identity must remain authoritative.
fn optional_point_hit_available(status: i32) -> OpenBitFunResult<bool> {
    match status {
        0 => Ok(true),
        // Failure / CannotComplete / AttributeUnsupported / NoValue /
        // NotImplemented. None of these read results submitted an action.
        -25200 | -25204 | -25205 | -25208 | -25212 => {
            log::debug!(target: "computer_use::ax", "Optional AX point lookup unavailable (status={status}); retaining window-directed pointer route");
            Ok(false)
        }
        // Keep permission denial, invalid references/arguments and unknown
        // errors visible instead of treating them as missing accessibility.
        _ => Err(OpenBitFunError::tool(format!(
            "AX_HIT_TEST_FAILED: Application hit testing failed (status={status})"
        ))),
    }
}

/// Native application-scoped hit testing ignores other applications' covering
/// windows. The result must belong to the captured window; another same-app
/// window is never substituted. Rectangle ranking is not a valid fallback.
pub(crate) fn retained_target_at_point(
    pid: i32,
    x: f64,
    y: f64,
) -> OpenBitFunResult<Option<RetainedCachedTarget>> {
    if !x.is_finite() || !y.is_finite() {
        return Ok(None);
    }
    let window_id = super::macos_capture::bound_window_id(pid).map_err(OpenBitFunError::tool)?;
    super::control_session::target_allowed(&format!("pid:{pid}/window:{window_id}"))
        .map_err(OpenBitFunError::tool)?;
    unsafe {
        let app = AXUIElementCreateApplication(pid);
        if app.is_null() {
            return Ok(None);
        }
        // This optional query must not impose the AX default multi-second
        // messaging timeout on every visual click into a busy application.
        // The timeout is local to this temporary application reference.
        AXUIElementSetMessagingTimeout(app, 0.3);
        let mut hit = std::ptr::null();
        let status = AXUIElementCopyElementAtPosition(app, x as f32, y as f32, &mut hit);
        ax_release(app as CFTypeRef);
        if status != 0 {
            ax_release(hit as CFTypeRef);
            optional_point_hit_available(status)?;
            return Ok(None);
        }
        if hit.is_null() {
            return Ok(None);
        }
        let target = RetainedCachedTarget(AxRef(hit));
        let mut hit_pid = 0;
        if AXUIElementGetPid(hit, &mut hit_pid) != 0 || hit_pid != pid {
            return Ok(None);
        }
        let owning_window = element_window_id(target.reference());
        if owning_window != Some(window_id) {
            return Ok(None);
        }
        let Some((left, top, width, height)) = target.frame_global() else {
            return Ok(None);
        };
        if width <= 0.0
            || height <= 0.0
            || x < left
            || y < top
            || x >= left + width
            || y >= top + height
        {
            return Ok(None);
        }
        Ok(Some(target))
    }
}

/// Evidence check after a visual focus attempt. `false` means no proven
/// mismatch, not verified delivery: custom canvases may expose no AX focus.
pub(crate) fn focused_text_target_mismatch(pid: i32, x: f64, y: f64) -> OpenBitFunResult<bool> {
    super::control_session::input_allowed().map_err(OpenBitFunError::tool)?;
    let bound = super::macos_capture::bound_window_id(pid).map_err(OpenBitFunError::tool)?;
    unsafe {
        let app = AXUIElementCreateApplication(pid);
        if app.is_null() {
            return Ok(false);
        }
        let attr = CFString::new("AXFocusedUIElement");
        let mut value: CFTypeRef = std::ptr::null();
        let status = AXUIElementCopyAttributeValue(app, attr.as_concrete_TypeRef(), &mut value);
        ax_release(app as CFTypeRef);
        if status != 0 {
            ax_release(value);
            return if matches!(status, -25205 | -25208 | -25212) {
                Ok(false)
            } else {
                Err(OpenBitFunError::tool(format!("AX_FOCUS_CHECK_FAILED: Cannot inspect the current text destination (status={status})")))
            };
        }
        if value.is_null() {
            return Ok(false);
        }
        let target = RetainedCachedTarget(AxRef(value as AXUIElementRef));
        if !target.is_text_input() {
            return Ok(false);
        }
        if element_window_id(target.reference()).is_some_and(|window| window != bound) {
            return Ok(true);
        }
        if let Some((left, top, width, height)) = target.frame_global() {
            if width > 0.0 && height > 0.0 {
                return Ok(x < left || y < top || x >= left + width || y >= top + height);
            }
        }
        Ok(false)
    }
}

// ── Low-level CF / AX helpers (intentionally separate from macos_ax_ui.rs
//    to keep the older locate path self-contained and untouched) ──────────

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

/// Safely convert a CF object to a Rust `String`. **MUST type-check first**:
/// blindly wrapping a non-CFString as `CFStringRef` and calling `.to_string()`
/// dispatches `_fastCStringContents:` to whatever class the object actually
/// is, raising an Objective-C `NSException` (`unrecognized selector …`) that
/// unwinds across the FFI boundary and either aborts the process or, if
/// caught, simply blanks out the entire AX snapshot.
///
/// This is the canonical foot-gun on Tauri / Electron / WebKit-hosted apps,
/// where `AXValue` on tabs is the selected child *element*, on toggles is a
/// `CFNumber`, on bool attributes is a `CFBoolean`, and on geometric
/// attributes is an opaque `AXValueRef` — none of which are strings.
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

/// Best-effort: read an attribute and coerce *whatever* CF type comes back
/// into a printable string — strings stay verbatim, booleans become
/// `"true"`/`"false"`, numbers become decimal, AX value refs (CGPoint /
/// CGSize / CGRect) become `(x, y)` / `(w x h)` / `(x, y, w, h)`. Anything
/// else (e.g. an AXUIElementRef returned for `AXValue` on a tab group)
/// becomes `None` rather than blowing up.
unsafe fn cf_to_display_string(cf: CFTypeRef) -> Option<String> {
    unsafe {
        if cf.is_null() {
            return None;
        }
        let tid = CFGetTypeID(cf);
        if tid == CFStringGetTypeID() {
            let s = CFString::wrap_under_get_rule(cf as CFStringRef);
            return Some(s.to_string());
        }
        if tid == CFBooleanGetTypeID() {
            return Some(if CFBooleanGetValue(cf as CFBooleanRef) != 0 {
                "true".to_string()
            } else {
                "false".to_string()
            });
        }
        if tid == CFNumberGetTypeID() {
            let nref = cf as CFNumberRef;
            if CFNumberIsFloatType(nref) != 0 {
                let mut d: f64 = 0.0;
                if CFNumberGetValue(
                    nref,
                    K_CF_NUMBER_DOUBLE_TYPE,
                    &mut d as *mut _ as *mut c_void,
                ) != 0
                {
                    // Trim trailing zeros for cleaner display (1.0 → "1").
                    let s = format!("{}", d);
                    return Some(s);
                }
                return None;
            } else {
                let mut i: i64 = 0;
                if CFNumberGetValue(
                    nref,
                    K_CF_NUMBER_LONG_LONG_TYPE,
                    &mut i as *mut _ as *mut c_void,
                ) != 0
                {
                    return Some(i.to_string());
                }
                return None;
            }
        }
        // CGPoint / CGSize / CGRect / CFRange via AXValueRef.
        if let Some(p) = ax_value_to_point(cf) {
            return Some(format!("({}, {})", p.x, p.y));
        }
        if let Some(s) = ax_value_to_size(cf) {
            return Some(format!("({} x {})", s.width, s.height));
        }
        None
    }
}

unsafe fn read_cf_string_attr(elem: AXUIElementRef, key: &str) -> Option<String> {
    unsafe {
        let v = ax_copy_attr(elem, key)?;
        let s = cfstring_to_string(v);
        ax_release(v);
        s
    }
}

/// Like `read_cf_string_attr` but accepts numbers / booleans / AXValues too
/// (used for `AXValue`, which on macOS can be almost anything depending on
/// the role).
unsafe fn read_cf_value_attr(elem: AXUIElementRef, key: &str) -> Option<String> {
    unsafe {
        let v = ax_copy_attr(elem, key)?;
        let s = cf_to_display_string(v);
        ax_release(v);
        s
    }
}

unsafe fn read_cf_bool_attr(elem: AXUIElementRef, key: &str) -> Option<bool> {
    unsafe {
        let v = ax_copy_attr(elem, key)?;
        let mut out = None;
        if CFGetTypeID(v) == CFBooleanGetTypeID() {
            out = Some(CFBooleanGetValue(v as CFBooleanRef) != 0);
        }
        ax_release(v);
        out
    }
}

/// Returns `Some(point)` only if `v` is a non-null AXValueRef encoding a
/// CGPoint. Safe to call on any CFTypeRef — non-AXValue inputs return `None`.
unsafe fn ax_value_to_point(v: CFTypeRef) -> Option<CGPoint> {
    unsafe {
        if v.is_null() {
            return None;
        }
        let av = v as AXValueRef;
        if AXValueGetType(av) != K_AX_VALUE_CGPOINT {
            return None;
        }
        let mut pt = CGPoint { x: 0.0, y: 0.0 };
        if !AXValueGetValue(av, K_AX_VALUE_CGPOINT, &mut pt as *mut _ as *mut c_void) {
            return None;
        }
        Some(pt)
    }
}

unsafe fn ax_value_to_size(v: CFTypeRef) -> Option<CGSize> {
    unsafe {
        if v.is_null() {
            return None;
        }
        let av = v as AXValueRef;
        if AXValueGetType(av) != K_AX_VALUE_CGSIZE {
            return None;
        }
        let mut sz = CGSize {
            width: 0.0,
            height: 0.0,
        };
        if !AXValueGetValue(av, K_AX_VALUE_CGSIZE, &mut sz as *mut _ as *mut c_void) {
            return None;
        }
        Some(sz)
    }
}

unsafe fn read_global_frame(elem: AXUIElementRef) -> Option<(f64, f64, f64, f64)> {
    unsafe {
        let pos = ax_copy_attr(elem, "AXPosition")?;
        let size = ax_copy_attr(elem, "AXSize")?;
        let pt = ax_value_to_point(pos);
        let sz = ax_value_to_size(size);
        ax_release(pos);
        ax_release(size);
        let pt = pt?;
        let sz = sz?;
        Some((pt.x, pt.y, sz.width, sz.height))
    }
}

unsafe fn read_action_names(elem: AXUIElementRef) -> Vec<String> {
    unsafe {
        let mut names: CFArrayRef = std::ptr::null();
        let st = AXUIElementCopyActionNames(elem, &mut names);
        if st != 0 || names.is_null() {
            return vec![];
        }
        let arr = CFArray::<*const c_void>::wrap_under_create_rule(names);
        let mut out = Vec::with_capacity(arr.len() as usize);
        for i in 0..arr.len() {
            if let Some(s) = arr.get(i) {
                let p = *s;
                if !p.is_null() {
                    out.push(CFString::wrap_under_get_rule(p as CFStringRef).to_string());
                }
            }
        }
        out
    }
}

// ── Chromium AX tree enablement ───────────────────────────────────────────
//
// Chromium/Electron apps (Arc, VS Code, Electron shells) ship their
// web-content AX tree OFF and only build it once an assistive client asks
// for it. Without this, the first walk of such an app returns an
// empty/title-bar-only tree. We flip `AXManualAccessibility` (modern, no
// screen-reader side effects) — or fall back to the legacy
// `AXEnhancedUserInterface` for older Electron builds — then let the
// asynchronously-built tree settle before reading it.
//
// Ported from cua-driver-rs `ax/bindings.rs:303-315` + `ax/tree.rs:43-154`.

/// How long to let a freshly-enabled Chromium/Electron app build its
/// web-content AX tree before we read it (seconds).
const CHROMIUM_SETTLE_SECONDS: f64 = 0.5;

/// Pids for which we have already flipped on accessibility and paid the
/// one-time settle delay. Repeat snapshots of the same app skip the settle.
fn enabled_pids() -> &'static Mutex<std::collections::HashSet<i32>> {
    static ENABLED_PIDS: OnceLock<Mutex<std::collections::HashSet<i32>>> = OnceLock::new();
    ENABLED_PIDS.get_or_init(|| Mutex::new(std::collections::HashSet::new()))
}

/// Enable Chromium/Electron accessibility on the app element.
/// Returns `true` when the enablement attribute was accepted (and thus
/// the tree needs a settle delay). Native Cocoa apps reject the attribute
/// and return `false` — they pay no settle cost.
unsafe fn enable_chromium_accessibility(app_element: AXUIElementRef) -> bool {
    unsafe {
        // Try the modern attribute first (no screen-reader side effects).
        let key = CFString::new("AXManualAccessibility");
        let val = CFBoolean::true_value();
        let st = AXUIElementSetAttributeValue(
            app_element,
            key.as_concrete_TypeRef(),
            val.as_concrete_TypeRef() as CFTypeRef,
        );
        if st == 0 {
            return true;
        }
        // `kAXErrorAttributeUnsupported` = -25205. Anything other than that
        // is a transient error (timeout / app busy) — don't bother with the
        // legacy fallback, and don't claim enablement happened.
        if st != -25205 {
            return false;
        }
        // Legacy fallback for older Electron builds.
        let key2 = CFString::new("AXEnhancedUserInterface");
        let val2 = CFBoolean::true_value();
        AXUIElementSetAttributeValue(
            app_element,
            key2.as_concrete_TypeRef(),
            val2.as_concrete_TypeRef() as CFTypeRef,
        ) == 0
    }
}

/// Briefly pump the CF run loop to let a freshly-enabled Chromium app
/// build its AX tree asynchronously over IPC.
fn pump_run_loop_briefly(seconds: f64) {
    thread::sleep(Duration::from_secs_f64(seconds));
}

// ── BFS walker ────────────────────────────────────────────────────────────

struct Queued {
    elem: AXUIElementRef,
    parent_idx: Option<u32>,
    depth: u32,
}

/// Configurable knobs for the dump. Defaults mirror what the dispatch layer
/// will call with: depth 32, focus_window_only false, capped at 4000 nodes.
pub(super) struct DumpOpts {
    pub max_depth: u32,
    pub max_nodes: usize,
    pub focus_window_only: bool,
    /// Walk into menus that are currently closed. Off by default.
    ///
    /// A closed `AXMenu` still reports its whole item hierarchy, but every item
    /// comes back collapsed at a zero-size off-screen frame — unclickable until
    /// the menu is opened, and useless for addressing. They dominate the dump
    /// anyway: observing a windowless app produced 188 nodes, 180 of them
    /// closed menu items. `get_app_shortcuts` is the supported way to read menu
    /// structure (and walks menus itself), so `get_app_state` stops at the menu.
    pub include_closed_menus: bool,
}

impl Default for DumpOpts {
    fn default() -> Self {
        Self {
            max_depth: 32,
            max_nodes: 4_000,
            focus_window_only: false,
            include_closed_menus: false,
        }
    }
}

/// Whether a node is a menu container that is not currently open, and whose
/// children are therefore off-screen and unclickable.
///
/// macOS gives an open menu's items real on-screen frames; a closed one leaves
/// them at a zero-size origin. Size is the reliable signal here — `AXExpanded`
/// is not exposed consistently by `AXMenu` across apps.
fn is_closed_menu_container(role: &str, frame: Option<(f64, f64, f64, f64)>) -> bool {
    if role != "AXMenu" {
        return false;
    }
    match frame {
        // No frame at all: treat as closed.
        None => true,
        Some((_, _, w, h)) => w < 1.0 || h < 1.0,
    }
}

pub(super) fn dump_app_ax(pid: i32, opts: DumpOpts) -> OpenBitFunResult<AppStateSnapshot> {
    let scope = openbitfun_agent_tools::computer_use_control::ObservationScope::from_control(
        &super::control_session::snapshot(),
    );
    let app = unsafe { AXUIElementCreateApplication(pid) };
    if app.is_null() {
        return Err(OpenBitFunError::tool(format!(
            "AXUIElementCreateApplication returned null for pid={}",
            pid
        )));
    }

    // Chromium/Electron apps ship their web-content AX tree OFF and only
    // build it once an assistive client asks for it. Flip the enablement
    // attribute, then — only when the flip took and only the first time
    // we see this pid — let the asynchronously-built tree settle before
    // reading it. Native Cocoa apps reject the attribute, paying no cost.
    let already_enabled = enabled_pids()
        .lock()
        .map(|s| s.contains(&pid))
        .unwrap_or(false);
    if !already_enabled {
        let enabled = unsafe { enable_chromium_accessibility(app) };
        if enabled {
            pump_run_loop_briefly(CHROMIUM_SETTLE_SECONDS);
            if let Ok(mut set) = enabled_pids().lock() {
                set.insert(pid);
            }
        }
    }

    // A captured window and its AX nodes must describe the same surface, even
    // if a second ordinary window or the sharing indicator becomes focused.
    let bound_window = super::control_session::snapshot()
        .target
        .as_deref()
        .and_then(|target| target.strip_prefix(&format!("pid:{pid}/window:")))
        .and_then(|id| id.parse::<u32>().ok());
    let root = if opts.focus_window_only {
        if let Some(window_id) = bound_window {
            match unsafe { super::macos_ax_ui::try_window_element_by_id(app, window_id) } {
                Some(window) => window,
                None => {
                    unsafe { ax_release(app as CFTypeRef) };
                    return Err(OpenBitFunError::tool("AX_BOUND_WINDOW_UNAVAILABLE: Accessibility cannot identify the captured window; another application window was not substituted"));
                }
            }
        } else {
            unsafe {
                try_focused_window(app)
                    .unwrap_or_else(|| CFRetain(app as CFTypeRef) as AXUIElementRef)
            }
        }
    } else {
        unsafe { CFRetain(app as CFTypeRef) as AXUIElementRef }
    };
    let window_title = if opts.focus_window_only {
        unsafe { read_cf_string_attr(root, "AXTitle") }
    } else {
        unsafe { try_focused_window(app) }.and_then(|window| {
            let title = unsafe { read_cf_string_attr(window, "AXTitle") };
            unsafe { ax_release(window as CFTypeRef) };
            title
        })
    };

    let popup_roots = match (opts.focus_window_only, bound_window) {
        // SAFETY: `app` is still retained here and released only below.
        (true, Some(window_id)) => unsafe { popup_ax_roots(app, pid, window_id) },
        _ => Vec::new(),
    };

    // We're done with the app handle for now (root is independently retained).
    unsafe { ax_release(app as CFTypeRef) };

    let mut nodes: Vec<AxNode> = Vec::new();
    let mut refs: Vec<AxRef> = Vec::new();
    let mut queue: VecDeque<Queued> = VecDeque::new();
    queue.push_back(Queued {
        elem: root,
        parent_idx: None,
        depth: 0,
    });
    let popup_count = popup_roots.len();
    for popup in popup_roots {
        queue.push_back(Queued {
            elem: popup,
            parent_idx: None,
            depth: 0,
        });
    }
    let mut visited: usize = 0;
    let mut pruned_menu_subtrees: usize = 0;

    while let Some(cur) = queue.pop_front() {
        if cur.depth > opts.max_depth || visited >= opts.max_nodes {
            unsafe { ax_release(cur.elem as CFTypeRef) };
            continue;
        }
        visited += 1;

        let idx = nodes.len() as u32;
        let role = unsafe { read_cf_string_attr(cur.elem, "AXRole") };
        let role_description = unsafe { read_cf_string_attr(cur.elem, "AXRoleDescription") };
        let subrole = unsafe { read_cf_string_attr(cur.elem, "AXSubrole") };
        let title = unsafe { read_cf_string_attr(cur.elem, "AXTitle") };
        // AXValue is the canonical foot-gun: on a slider it's a CFNumber, on
        // a toggle it's a CFBoolean, on a tab group it's an AXUIElementRef
        // pointing at the selected child. Use the type-tolerant reader.
        let value = unsafe { read_cf_value_attr(cur.elem, "AXValue") }
            .or_else(|| unsafe { read_cf_string_attr(cur.elem, "AXPlaceholderValue") });
        let description = unsafe { read_cf_string_attr(cur.elem, "AXDescription") };
        let help = unsafe { read_cf_string_attr(cur.elem, "AXHelp") };
        let identifier = unsafe { read_cf_string_attr(cur.elem, "AXIdentifier") };
        let url = unsafe { read_cf_string_attr(cur.elem, "AXURL") };
        let enabled = unsafe { read_cf_bool_attr(cur.elem, "AXEnabled") };
        let focused = unsafe { read_cf_bool_attr(cur.elem, "AXFocused") };
        let selected = unsafe { read_cf_bool_attr(cur.elem, "AXSelected") };
        let expanded = unsafe { read_cf_bool_attr(cur.elem, "AXExpanded") };
        let frame = unsafe { read_global_frame(cur.elem) };
        let actions = unsafe { read_action_names(cur.elem) };

        let role = role.unwrap_or_default();
        let is_closed_menu = is_closed_menu_container(&role, frame);

        nodes.push(AxNode {
            idx,
            parent_idx: cur.parent_idx,
            role,
            title,
            value,
            description,
            identifier,
            enabled: enabled.unwrap_or(true),
            focused: focused.unwrap_or(false),
            selected,
            frame_global: frame,
            actions,
            role_description,
            subrole,
            help,
            url,
            expanded,
        });
        // Cache the retained ref so future actions can look it up.
        refs.push(AxRef(cur.elem));

        // A closed menu is a leaf for our purposes: keep the container node so
        // the model can see the menu exists (and `AXPress` it), but skip the
        // subtree of unclickable zero-size items underneath.
        if is_closed_menu && !opts.include_closed_menus {
            pruned_menu_subtrees += 1;
            continue;
        }

        // Enqueue children — but DO NOT release `cur.elem`; the cache owns it.
        // At the application root (parent_idx is None), union `AXChildren`
        // with `AXWindows`. macOS only puts windows in `AXChildren` when the
        // app is frontmost; `AXWindows` returns the window list regardless of
        // focus state. Without this union, backgrounded apps return an empty
        // tree. (Ported from cua-driver-rs `ax/tree.rs:156-171`.)
        let next_depth = cur.depth + 1;
        let attrs: &[&str] = if cur.parent_idx.is_none() {
            &["AXChildren", "AXWindows"]
        } else {
            &["AXChildren"]
        };
        let mut seen_refs: Vec<AXUIElementRef> = Vec::new();
        for attr_name in attrs {
            let children_ref = unsafe { ax_copy_attr(cur.elem, attr_name) };
            let Some(ch) = children_ref else { continue };
            unsafe {
                if CFGetTypeID(ch) != core_foundation::array::CFArrayGetTypeID() {
                    ax_release(ch);
                    continue;
                }
                let arr = CFArray::<*const c_void>::wrap_under_create_rule(ch as CFArrayRef);
                for i in 0..arr.len() {
                    let Some(slot) = arr.get(i) else { continue };
                    let child = *slot;
                    if child.is_null() {
                        continue;
                    }
                    // AXChildren and AXWindows return distinct proxy pointers for
                    // the same remote element. CFEqual compares AX identity.
                    if seen_refs.iter().any(|known| CFEqual(*known, child) != 0) {
                        continue;
                    }
                    seen_refs.push(child);
                    let retained = CFRetain(child as CFTypeRef) as AXUIElementRef;
                    if !retained.is_null() {
                        queue.push_back(Queued {
                            elem: retained,
                            parent_idx: Some(idx),
                            depth: next_depth,
                        });
                    }
                }
            }
        }
    }
    // Drain anything we didn't walk (depth-cap or node-cap overflow).
    while let Some(q) = queue.pop_front() {
        unsafe { ax_release(q.elem as CFTypeRef) };
    }

    let mut tree_text = render_tree_text(&nodes);
    if window_tree_has_only_chrome(&nodes) {
        tree_text.push_str("\n[note] AX_WINDOW_CONTENT_UNAVAILABLE: The application exposes window chrome but no accessible content controls. This tree cannot identify content or prove its absence. Use the same target window screenshot/OCR; repeated AX searches cannot reveal controls the app does not expose.\n");
    }

    if popup_count > 0 {
        tree_text.push_str(&format!(
            "\n[note] {popup_count} open popup/menu window(s) of this window are listed as additional top-level nodes. Their elements are part of this observation and accept app_click like any other node.\n"
        ));
    }

    // Say that menus were skipped on purpose, and where to get them. Otherwise
    // an agent that needs a menu command sees a bare `AXMenu` leaf and has no
    // way to tell "pruned" from "this app has no menu items".
    if pruned_menu_subtrees > 0 {
        tree_text.push_str(&format!(
            "\n[note] {} closed menu subtree(s) omitted — their items are off-screen and \
unclickable until the menu opens. Use `get_app_shortcuts` for menu commands and their key \
equivalents, or AXPress the menu first.\n",
            pruned_menu_subtrees
        ));
    }
    let digest = compute_digest(&nodes);
    let captured_at_ms = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|d| d.as_millis() as u64)
        .unwrap_or(0);

    // Install in cache, replacing any previous snapshot for this pid.
    {
        let mut cache = snapshot_cache()
            .lock()
            .map_err(|_| OpenBitFunError::tool("AX snapshot cache poisoned".to_string()))?;
        cache.clear();
        cache.insert(
            pid,
            CachedSnapshot {
                scope,
                digest: digest.clone(),
                refs,
            },
        );
    }

    Ok(AppStateSnapshot {
        observation_id: None,
        app: openbitfun_agent_tools::computer_use_host::AppInfo {
            name: window_title.clone().unwrap_or_default(),
            bundle_id: None,
            pid: Some(pid),
            running: true,
            last_used_ms: None,
            launch_count: 0,
        },
        window_title,
        tree_text,
        nodes,
        digest,
        captured_at_ms,
        screenshot: None,
        loop_warning: None,
    })
}

/// Prefer the focused/main application window, excluding system sharing chrome. Returns a
/// retained ref the caller must release (or hand to the cache).
unsafe fn try_focused_window(app: AXUIElementRef) -> Option<AXUIElementRef> {
    unsafe { super::macos_ax_ui::try_frontmost_window_element(app) }
}

/// Detect an exposed window whose descendants consist only of native chrome.
/// This reports observation quality rather than assuming a node-count threshold.
fn window_tree_has_only_chrome(nodes: &[AxNode]) -> bool {
    let mut ancestry: HashMap<u32, (bool, bool)> = HashMap::new();
    let mut has_window = false;
    for n in nodes {
        let (parent_window, parent_chrome) = n
            .parent_idx
            .and_then(|idx| ancestry.get(&idx).copied())
            .unwrap_or_default();
        let is_window = n.role == "AXWindow";
        let chrome = parent_chrome
            || matches!(
                n.subrole.as_deref(),
                Some("AXCloseButton" | "AXMinimizeButton" | "AXZoomButton" | "AXFullScreenButton")
            )
            || n.title.as_deref() == Some("WindowSharingSessionButton");
        has_window |= is_window;
        ancestry.insert(n.idx, (is_window || parent_window, chrome));
        if parent_window && !chrome && !matches!(n.role.as_str(), "AXWindow" | "AXGroup") {
            return false;
        }
    }
    has_window
}

/// A retained application-level AXMenu and its global frame.
type MenuRoot = (AXUIElementRef, (f64, f64, f64, f64));

/// Retained AX roots for the bound window's open popups, front to back.
/// Popup panels are AXWindows; open menus are application-level AXMenus,
/// matched to their WindowServer window by frame.
unsafe fn popup_ax_roots(app: AXUIElementRef, pid: i32, bound: u32) -> Vec<AXUIElementRef> {
    let Ok(overlays) = super::macos_capture::overlays(pid, bound) else {
        return Vec::new();
    };
    if overlays.is_empty() {
        return Vec::new();
    }
    let mut roots: Vec<AXUIElementRef> = Vec::new();
    let mut menus: Option<Vec<MenuRoot>> = None;
    // SAFETY: `app` is a live AX element owned by the caller; every element
    // retained here is either returned in `roots` or released below.
    unsafe {
        for overlay in &overlays {
            let found = u32::try_from(overlay.window_id)
                .ok()
                .and_then(|id| super::macos_ax_ui::try_window_element_by_id(app, id))
                .or_else(|| {
                    let menus = menus.get_or_insert_with(|| open_application_menus(app));
                    menus
                        .iter()
                        .find(|(_, frame)| frame_matches(*frame, overlay.bounds))
                        .map(|(menu, _)| CFRetain(*menu as CFTypeRef) as AXUIElementRef)
                });
            let Some(found) = found else { continue };
            if roots
                .iter()
                .any(|known| CFEqual(*known as CFTypeRef, found as CFTypeRef) != 0)
            {
                ax_release(found as CFTypeRef);
                continue;
            }
            roots.push(found);
        }
        for (menu, _) in menus.unwrap_or_default() {
            ax_release(menu as CFTypeRef);
        }
    }
    roots
}

unsafe fn open_application_menus(app: AXUIElementRef) -> Vec<MenuRoot> {
    let mut menus = Vec::new();
    // SAFETY: `app` is a live AX element; the children array follows the
    // create rule and each returned menu is retained for the caller.
    unsafe {
        let Some(raw) = ax_copy_attr(app, "AXChildren") else {
            return menus;
        };
        if CFGetTypeID(raw) != core_foundation::array::CFArrayGetTypeID() {
            ax_release(raw);
            return menus;
        }
        let children = CFArray::<*const c_void>::wrap_under_create_rule(raw as CFArrayRef);
        for index in 0..children.len() {
            let Some(child) = children.get(index).map(|child| *child as AXUIElementRef) else {
                continue;
            };
            if child.is_null() || read_cf_string_attr(child, "AXRole").as_deref() != Some("AXMenu")
            {
                continue;
            }
            if let Some(frame) = read_global_frame(child).filter(|f| f.2 > 0.0 && f.3 > 0.0) {
                menus.push((CFRetain(child as CFTypeRef) as AXUIElementRef, frame));
            }
        }
    }
    menus
}

fn frame_matches(frame: (f64, f64, f64, f64), bounds: [f64; 4]) -> bool {
    // Menu windows add a few points of rounded chrome around the AXMenu frame.
    const SLACK: f64 = 8.0;
    (frame.0 - bounds[0]).abs() <= SLACK
        && (frame.1 - bounds[1]).abs() <= SLACK
        && (frame.2 - bounds[2]).abs() <= 2.0 * SLACK
        && (frame.3 - bounds[3]).abs() <= 2.0 * SLACK
}

/// Render a Codex-style indented tree.
///
/// Layout per node (one line):
///
/// ```text
/// {indent}[{idx}] {label} title="…" value="…" id="…" desc="…" help="…" \
///         url="…" frame=(x,y,wxh) {flags…} actions=[AXPress,AXShowMenu]
/// ```
///
/// `{label}` prefers `role_description` (humanised) over `role`+`subrole`
/// because that's what a sighted user calls the element. Numeric `idx` is
/// always shown so the model can address nodes deterministically.
fn render_tree_text(nodes: &[AxNode]) -> String {
    let mut children: Vec<Vec<u32>> = vec![Vec::new(); nodes.len()];
    let mut roots: Vec<u32> = Vec::new();
    for n in nodes {
        match n.parent_idx {
            Some(p) => {
                if let Some(slot) = children.get_mut(p as usize) {
                    slot.push(n.idx);
                }
            }
            None => roots.push(n.idx),
        }
    }
    let mut out = String::new();
    let mut stack: Vec<(u32, u32)> = roots.iter().rev().map(|&r| (r, 0u32)).collect();
    while let Some((idx, depth)) = stack.pop() {
        let n = &nodes[idx as usize];
        for _ in 0..depth {
            out.push_str("  ");
        }
        out.push_str(&format!("[{}] {}", n.idx, format_label(n)));
        if let Some(t) = &n.title {
            if !t.is_empty() {
                out.push_str(&format!(" title={}", quote_clip(t, 120)));
            }
        }
        if let Some(v) = &n.value {
            if !v.is_empty() {
                out.push_str(&format!(" value={}", quote_clip(v, 120)));
            }
        }
        if let Some(id) = &n.identifier {
            if !id.is_empty() {
                out.push_str(&format!(" id={}", quote_clip(id, 80)));
            }
        }
        if let Some(d) = &n.description {
            if !d.is_empty() {
                out.push_str(&format!(" desc={}", quote_clip(d, 120)));
            }
        }
        if let Some(h) = &n.help {
            if !h.is_empty() {
                out.push_str(&format!(" help={}", quote_clip(h, 120)));
            }
        }
        if let Some(u) = &n.url {
            if !u.is_empty() {
                out.push_str(&format!(" url={}", quote_clip(u, 200)));
            }
        }
        if let Some((x, y, w, h)) = n.frame_global {
            out.push_str(&format!(" frame=({:.0},{:.0},{:.0}x{:.0})", x, y, w, h));
        }
        if !n.enabled {
            out.push_str(" [disabled]");
        }
        if n.focused {
            out.push_str(" [focused]");
        }
        if let Some(true) = n.selected {
            out.push_str(" [selected]");
        }
        match n.expanded {
            Some(true) => out.push_str(" [expanded]"),
            Some(false) => out.push_str(" [collapsed]"),
            None => {}
        }
        // Surface non-trivial AX actions inline so the model can pick
        // AXShowMenu / AXIncrement / AXDecrement etc. without re-querying.
        let extra: Vec<&str> = n
            .actions
            .iter()
            .map(String::as_str)
            .filter(|a| !matches!(*a, "AXPress" | "AXShowAlternateUI" | "AXShowDefaultUI"))
            .collect();
        if !extra.is_empty() {
            out.push_str(&format!(" actions=[{}]", extra.join(",")));
        }
        out.push('\n');
        if let Some(kids) = children.get(idx as usize) {
            for &c in kids.iter().rev() {
                stack.push((c, depth + 1));
            }
        }
    }
    out
}

/// Compose a Codex-style label: prefer humanised role description, fall
/// back to `role + (subrole)`.
fn format_label(n: &AxNode) -> String {
    if let Some(rd) = &n.role_description {
        if !rd.is_empty() {
            return rd.clone();
        }
    }
    match &n.subrole {
        Some(s) if !s.is_empty() => format!("{}({})", n.role, s),
        _ => n.role.clone(),
    }
}

/// Quote a value, clipping at `max` chars (counted in bytes for safety on
/// arbitrary UTF-8 — we cut on a char boundary so we never split a code
/// point).
fn quote_clip(s: &str, max: usize) -> String {
    let trimmed: String = s.chars().take(max).collect();
    let escaped = trimmed.replace('\\', "\\\\").replace('"', "\\\"");
    if s.chars().count() > max {
        format!("\"{}…\"", escaped)
    } else {
        format!("\"{}\"", escaped)
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn optional_point_hit_read_failure_preserves_directed_input_route() {
        assert!(optional_point_hit_available(0).unwrap());
        for status in [-25200, -25204, -25205, -25208, -25212] {
            assert!(!optional_point_hit_available(status).unwrap(), "{status}");
        }
    }

    #[test]
    fn optional_point_hit_keeps_denial_and_invalid_target_errors() {
        for status in [-25201, -25202, -25203, -25211, -99999] {
            let error = optional_point_hit_available(status).unwrap_err();
            assert!(error.to_string().contains("AX_HIT_TEST_FAILED"));
            assert!(error.to_string().contains(&status.to_string()));
        }
    }

    #[test]
    #[ignore = "run scripts/test-native-ax-context.mjs with macOS Accessibility permission"]
    fn native_ax_fixture_round_trips_tree_and_cached_targets() {
        let pid: i32 = std::env::var("OPENBITFUN_AX_FIXTURE_PID")
            .expect("isolated fixture PID")
            .parse()
            .unwrap();
        let snapshot = dump_app_ax(pid, DumpOpts::default()).expect("native AX dump");
        assert_eq!(snapshot.app.pid, Some(pid));
        // AXChildren/AXWindows may expose different CF proxies for one window.
        for title in ["Save report", "Delete draft"] {
            assert_eq!(
                snapshot
                    .nodes
                    .iter()
                    .filter(|n| n.title.as_deref() == Some(title))
                    .count(),
                1,
                "the same native element must not be emitted twice"
            );
        }
        let query = openbitfun_agent_tools::computer_use_host::UiElementLocateQuery {
            text_contains: Some("Save report".into()),
            ..Default::default()
        };
        let located = super::super::macos_ax_ui::locate_ui_element_center_for_pid(pid, &query)
            .expect("explicit application locate");
        assert_eq!(located.matched_title.as_deref(), Some("Save report"));

        for title in ["Save report", "Delete draft", "Unavailable action"] {
            assert!(
                snapshot.tree_text.contains(title),
                "fixture control {title} missing; verify Accessibility permission: {}",
                snapshot.tree_text
            );
        }
        assert!(snapshot
            .nodes
            .iter()
            .any(|n| n.value.as_deref() == Some("context-value")));
        assert!(snapshot
            .nodes
            .iter()
            .any(|n| n.title.as_deref() == Some("Unavailable action") && !n.enabled));
        for (i, n) in snapshot.nodes.iter().enumerate() {
            assert_eq!(n.idx as usize, i);
            if let Some(parent) = n.parent_idx {
                assert!((parent as usize) < i);
            }
            assert!(
                cached_ref_loose(pid, n.idx).is_some(),
                "missing cached target {}",
                n.idx
            );
        }
        let save = snapshot
            .nodes
            .iter()
            .find(|node| node.title.as_deref() == Some("Save report"))
            .unwrap();
        let retained = retained_cached_target(pid, save.idx).expect("observed target retained");
        let located =
            cached_ref(pid, Some(&snapshot.digest), save.idx).expect("located target retained");
        let frame = retained.frame_global().expect("observed target frame");
        clear_observations();
        assert!(cached_ref_loose(pid, save.idx).is_none());
        assert_eq!(
            retained.frame_global(),
            Some(frame),
            "cache replacement must not release an in-flight target reference"
        );
        assert_eq!(located.frame_global(), Some(frame));
        dump_app_ax(pid, DumpOpts::default()).expect("restore fixture observation cache");

        let elements = crate::computer_use::interactive_filter::build_interactive_elements(
            &snapshot.nodes,
            None,
            &crate::computer_use::interactive_filter::FilterOpts::default(),
        );
        for title in ["Save report", "Delete draft"] {
            assert!(
                elements.iter().any(|e| e.label.as_deref() == Some(title)),
                "lost native target {title}"
            );
        }
        let restored: AppStateSnapshot =
            serde_json::from_value(serde_json::to_value(&snapshot).unwrap()).unwrap();
        assert_eq!(restored, snapshot);
    }
    use openbitfun_agent_tools::computer_use_host::AxNode;

    fn n(idx: u32, parent: Option<u32>, role: &str, title: Option<&str>) -> AxNode {
        AxNode {
            idx,
            parent_idx: parent,
            role: role.to_string(),
            title: title.map(str::to_string),
            value: None,
            description: None,
            identifier: None,
            enabled: true,
            focused: false,
            selected: None,
            frame_global: None,
            actions: vec![],
            role_description: None,
            subrole: None,
            help: None,
            url: None,
            expanded: None,
        }
    }

    #[test]
    fn render_tree_text_indents_by_depth_and_orders_siblings() {
        let nodes = vec![
            n(0, None, "AXApplication", Some("Cursor")),
            n(1, Some(0), "AXWindow", Some("main")),
            n(2, Some(1), "AXButton", Some("Save")),
            n(3, Some(1), "AXButton", Some("Close")),
        ];
        let out = render_tree_text(&nodes);
        let expected =
            "[0] AXApplication title=\"Cursor\"\n  [1] AXWindow title=\"main\"\n    [2] AXButton title=\"Save\"\n    [3] AXButton title=\"Close\"\n";
        assert_eq!(out, expected);
    }

    #[test]
    fn render_tree_text_uses_role_description_and_inline_flags() {
        let mut a = n(0, None, "AXButton", Some("Close"));
        a.role_description = Some("close button".to_string());
        a.help = Some("Close window".to_string());
        a.subrole = Some("AXCloseButton".to_string());
        a.frame_global = Some((10.0, 20.0, 30.0, 30.0));
        a.actions = vec!["AXPress".into(), "AXShowMenu".into()];
        a.focused = true;
        let out = render_tree_text(&[a]);
        // role_description wins over role/subrole; AXPress is filtered out
        // but AXShowMenu shows up as a secondary action.
        assert!(out.contains("[0] close button"));
        assert!(out.contains("title=\"Close\""));
        assert!(out.contains("help=\"Close window\""));
        assert!(out.contains("frame=(10,20,30x30)"));
        assert!(out.contains("[focused]"));
        assert!(out.contains("actions=[AXShowMenu]"));
    }

    #[test]
    fn closed_menus_are_pruned_but_open_ones_are_kept() {
        // A closed menu reports its items at a zero-size off-screen frame.
        assert!(is_closed_menu_container(
            "AXMenu",
            Some((0.0, 982.0, 0.0, 0.0))
        ));
        assert!(is_closed_menu_container("AXMenu", None));
        // An open menu has a real frame and must still be walked.
        assert!(!is_closed_menu_container(
            "AXMenu",
            Some((100.0, 40.0, 220.0, 380.0))
        ));
        // Only menus are ever pruned — a zero-size button is still a node the
        // model may need to reason about.
        assert!(!is_closed_menu_container(
            "AXButton",
            Some((0.0, 0.0, 0.0, 0.0))
        ));
        assert!(!is_closed_menu_container("AXMenuItem", None));
    }

    #[test]
    fn chrome_only_quality_does_not_depend_on_node_count() {
        let mut nodes = vec![
            n(0, None, "AXWindow", Some("Fixture")),
            n(1, Some(0), "AXButton", None),
        ];
        nodes[1].subrole = Some("AXCloseButton".into());
        assert!(window_tree_has_only_chrome(&nodes));
        nodes.push(n(2, Some(0), "AXTextField", Some("Search")));
        assert!(!window_tree_has_only_chrome(&nodes));
    }

    #[test]
    fn quote_clip_truncates_on_char_boundary() {
        let s = "中文字符测试abcdef";
        let q = quote_clip(s, 4);
        assert_eq!(q, "\"中文字符…\"");
    }

    #[test]
    fn digest_changes_when_a_title_changes() {
        let mut a = vec![n(0, None, "AXButton", Some("Save"))];
        let d1 = compute_digest(&a);
        a[0].title = Some("Saved".to_string());
        let d2 = compute_digest(&a);
        assert_ne!(d1, d2);
    }

    /// Measure the closed-menu pruning against a real running app rather than
    /// trusting the unit test's synthetic frames.
    ///
    /// Dumps the frontmost application twice — once with menus walked, once
    /// with the default pruning — and reports both node counts. Requires
    /// Accessibility permission and a GUI session, so it is `#[ignore]`d.
    #[test]
    #[ignore]
    fn closed_menu_pruning_shrinks_a_real_app_dump() {
        let pid = crate::computer_use::macos_bg_input::frontmost_pid_macos()
            .expect("a GUI session has a frontmost app");

        let with_menus = dump_app_ax(
            pid,
            DumpOpts {
                include_closed_menus: true,
                ..Default::default()
            },
        )
        .expect("dump with menus");
        let pruned = dump_app_ax(pid, DumpOpts::default()).expect("pruned dump");

        // What `describe_screen` actually asks for: depth 8, focused window
        // only. Reported alongside so the cost of the observe path is visible
        // next to the cost of a full `get_app_state`.
        let observe = dump_app_ax(
            pid,
            DumpOpts {
                max_depth: 8,
                focus_window_only: true,
                ..Default::default()
            },
        )
        .expect("describe_screen-shaped dump");

        eprintln!(
            "pid={pid}\n  full+menus:  {:>5} nodes, {:>7} bytes\n  full pruned: {:>5} nodes, {:>7} bytes\n  observe:     {:>5} nodes, {:>7} bytes",
            with_menus.nodes.len(),
            with_menus.tree_text.len(),
            pruned.nodes.len(),
            pruned.tree_text.len(),
            observe.nodes.len(),
            observe.tree_text.len(),
        );
        // Depth profile of the focused window. Run this when retuning
        // `DESCRIBE_SCREEN_AX_DEPTH`: "actionable" (has AX actions and a real
        // frame) is what the agent can actually click, and it is the column
        // that matters — node count and bytes grow long after it plateaus.
        for d in [8u32, 12, 16, 20, 24, 32] {
            let s = dump_app_ax(
                pid,
                DumpOpts {
                    max_depth: d,
                    focus_window_only: true,
                    ..Default::default()
                },
            )
            .expect("depth dump");
            let actionable = s
                .nodes
                .iter()
                .filter(|n| !n.actions.is_empty() && n.frame_global.is_some())
                .count();
            eprintln!(
                "  depth {:>2}: {:>5} nodes, {:>4} actionable, {:>7} bytes",
                d,
                s.nodes.len(),
                actionable,
                s.tree_text.len()
            );
        }
        assert!(
            pruned.nodes.len() <= with_menus.nodes.len(),
            "pruning must never grow the tree"
        );
    }

    /// Smoke test: dump the AX tree of *this* test process. The test process
    /// usually has no AX windows of its own, so we only assert the call
    /// returns *something* (possibly an empty tree) without panicking and
    /// produces a stable digest. Marked `#[ignore]` because it requires
    /// Accessibility permission for `cargo test` on macOS.
    #[test]
    #[ignore]
    fn dump_self_pid_returns_snapshot() {
        let pid = std::process::id() as i32;
        let snap = dump_app_ax(pid, DumpOpts::default()).expect("dump_app_ax should succeed");
        assert!(!snap.digest.is_empty(), "digest must be non-empty");
        assert_eq!(snap.app.pid, Some(pid));
    }

    #[test]
    fn digest_is_stable_for_same_input() {
        let nodes = vec![
            n(0, None, "AXWindow", Some("X")),
            n(1, Some(0), "AXButton", Some("Y")),
        ];
        assert_eq!(compute_digest(&nodes), compute_digest(&nodes));
    }
}
