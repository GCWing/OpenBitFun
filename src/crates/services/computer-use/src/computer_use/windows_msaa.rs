//! Windows MSAA (Microsoft Active Accessibility) tree walker — UIA fallback.
//!
//! Ported from cua-driver-rs v0.6.8 (`platform-windows/src/msaa.rs`).
//!
//! Fallback for SAL/VCL window classes (LibreOffice, OpenOffice) where the UIA
//! walker hangs on `BuildUpdatedCache(Subtree)` or returns an empty tree. MSAA
//! via oleacc.dll's `AccessibleObjectFromWindow` (`OBJID_CLIENT`) + recursive
//! `accChild` traversal walks these windows cleanly because it avoids the
//! bulk-cache cross-process RPC that VCL's UIA provider deadlocks on under a
//! multi-threaded COM apartment.
//!
//! Bonus payoff: MSAA preserves the `ROLE_SYSTEM_BUTTONDROPDOWN` role (0x38)
//! that Windows' built-in MSAA→UIA proxy collapses to a featureless
//! `SplitButton` (no `ExpandCollapse` pattern, no separable dropdown child).
//! For `BUTTONDROPDOWN` this walker emits `actions=["invoke","expand"]` so a
//! follow-up click step can route `action:"expand"` to a right-edge click that
//! opens the dropdown half (e.g. LO Writer "Font Color" → color picker) instead
//! of just re-firing the press half.
//!
//! Produces the same [`UiaNode`] shape as the UIA path in [`super::windows_ax_ui`];
//! the `msaa_role` field is `Some(role)` on every node emitted here (it is
//! `None` on the UIA primary path) so a downstream click dispatcher can tell the
//! two sources apart and route `expand` to a coordinate click rather than a UIA
//! pattern lookup.
//!
//! [`is_sal_vcl_window`] flags SAL/VCL windows (LibreOffice / OpenOffice) so the
//! desktop host can route them to this MSAA walker instead of the UIA path.
//!
//! # Build requirements
//!
//! `IAccessible`'s VARIANT-taking methods (`get_accRole` / `get_accName` /
//! `accLocation` / `get_accChild` / `get_accDefaultAction`) and the `VARIANT`
//! struct itself are gated in the `windows` 0.61 crate behind
//! `Win32_System_Ole` + `Win32_System_Variant`. The desktop crate enables both
//! (see `src/apps/desktop/Cargo.toml`); `AccessibleObjectFromWindow` and the
//! `IAccessible` type come from the already-enabled `Win32_UI_Accessibility`
//! feature (the `windows` crate links them from `oleacc.dll`), so no manual
//! `extern "system"` FFI declarations are needed. The module is kept
//! `#![allow(dead_code)]` and unwired until the fallback is connected by the
//! desktop host.

#![allow(dead_code)]

use std::ptr::null_mut;

use openbitfun_agent_tools::computer_use_host::error::{OpenBitFunError, OpenBitFunResult};
use windows::core::Interface;
use windows::Win32::Foundation::HWND;
use windows::Win32::System::Com::{CoInitializeEx, COINIT_APARTMENTTHREADED};
use windows::Win32::System::Variant::{VARIANT, VT_I4};
use windows::Win32::UI::Accessibility::{AccessibleObjectFromWindow, IAccessible};
use windows::Win32::UI::WindowsAndMessaging::GetClassNameW;

use super::windows_ax_ui::UiaNode;

/// `OBJID_CLIENT` — request the `IAccessible` for the window's client area.
const OBJID_CLIENT: u32 = 0xFFFFFFFC;
/// `CHILDID_SELF` — identify the object itself rather than one of its children.
const CHILDID_SELF: i32 = 0;

// MSAA role codes (subset; full list in winuser.h / oleacc.h).
const ROLE_SYSTEM_TITLEBAR: i32 = 0x01;
const ROLE_SYSTEM_MENUBAR: i32 = 0x02;
const ROLE_SYSTEM_SCROLLBAR: i32 = 0x03;
const ROLE_SYSTEM_WINDOW: i32 = 0x09;
const ROLE_SYSTEM_CLIENT: i32 = 0x0A;
const ROLE_SYSTEM_MENUPOPUP: i32 = 0x0B;
const ROLE_SYSTEM_MENUITEM: i32 = 0x0C;
const ROLE_SYSTEM_TOOLTIP: i32 = 0x0D;
const ROLE_SYSTEM_DIALOG: i32 = 0x12;
const ROLE_SYSTEM_GROUPING: i32 = 0x14;
const ROLE_SYSTEM_TOOLBAR: i32 = 0x16;
const ROLE_SYSTEM_STATUSBAR: i32 = 0x17;
const ROLE_SYSTEM_LINK: i32 = 0x1E;
const ROLE_SYSTEM_LIST: i32 = 0x21;
const ROLE_SYSTEM_LISTITEM: i32 = 0x22;
const ROLE_SYSTEM_PAGETAB: i32 = 0x25;
const ROLE_SYSTEM_GRAPHIC: i32 = 0x28;
const ROLE_SYSTEM_STATICTEXT: i32 = 0x29;
const ROLE_SYSTEM_TEXT: i32 = 0x2A;
const ROLE_SYSTEM_PUSHBUTTON: i32 = 0x2B;
const ROLE_SYSTEM_CHECKBUTTON: i32 = 0x2C;
const ROLE_SYSTEM_RADIOBUTTON: i32 = 0x2D;
const ROLE_SYSTEM_COMBOBOX: i32 = 0x2E;
const ROLE_SYSTEM_PROGRESSBAR: i32 = 0x30;
const ROLE_SYSTEM_SLIDER: i32 = 0x33;
/// Preserved verbatim — Windows' built-in MSAA→UIA proxy collapses this to a
/// featureless `SplitButton`; MSAA keeps it so `expand` can address the
/// dropdown half separately.
const ROLE_SYSTEM_BUTTONDROPDOWN: i32 = 0x38;
const ROLE_SYSTEM_BUTTONMENU: i32 = 0x39;
const ROLE_SYSTEM_BUTTONDROPDOWNGRID: i32 = 0x3A;
const ROLE_SYSTEM_PAGETABLIST: i32 = 0x3C;
const ROLE_SYSTEM_SPLITBUTTON: i32 = 0x3E;

/// Default depth cap; mirrors cua-driver-rs and the UIA path.
const MAX_DEPTH: usize = 25;
/// Default total-element cap; mirrors cua-driver-rs and the UIA path.
const MAX_TOTAL_ELEMENTS: usize = 5000;

/// Walk the MSAA tree for the window with the given HWND.
///
/// Used as a fallback for SAL/VCL targets (LibreOffice / OpenOffice) where the
/// UIA walker hangs or yields an empty tree. Returns the same `UiaNode` shape as
/// the UIA path; every emitted node carries `msaa_role = Some(role)` so a
/// downstream dispatcher can distinguish MSAA-sourced nodes from UIA-sourced
/// ones.
pub(super) fn walk_msaa_tree(hwnd: isize) -> OpenBitFunResult<Vec<UiaNode>> {
    unsafe { walk_bounded(hwnd, MAX_TOTAL_ELEMENTS, MAX_DEPTH) }
}

unsafe fn walk_bounded(
    hwnd: isize,
    max_total: usize,
    max_depth: usize,
) -> OpenBitFunResult<Vec<UiaNode>> {
    // OpenBitFun is a Tauri GUI app; match the UIA path's apartment threading.
    // SAFETY: initializes COM for the current thread; the result is intentionally
    // ignored because an already initialized apartment is acceptable here.
    let _ = unsafe { CoInitializeEx(None, COINIT_APARTMENTTHREADED) };

    let hwnd_win = HWND(hwnd as *mut _);
    let mut raw_root: *mut std::ffi::c_void = null_mut();
    // `AccessibleObjectFromWindow` returns the IAccessible for the window's
    // client area (OBJID_CLIENT) via the IID we pass.
    let iid = IAccessible::IID;
    // SAFETY: `raw_root` is a valid out-pointer for the requested `IAccessible`
    // IID. The API owns initialization and reports invalid HWNDs as errors.
    let res = unsafe {
        AccessibleObjectFromWindow(
            hwnd_win,
            OBJID_CLIENT,
            &iid,
            &mut raw_root as *mut _ as *mut _,
        )
    };
    if res.is_err() || raw_root.is_null() {
        return Err(OpenBitFunError::tool(format!(
            "MSAA AccessibleObjectFromWindow failed for hwnd 0x{hwnd:x}: {res:?}."
        )));
    }
    // SAFETY: success returned a non-null COM pointer for exactly
    // `IAccessible::IID`; ownership is transferred into the interface wrapper.
    let root: IAccessible = unsafe { IAccessible::from_raw(raw_root) };

    let mut nodes: Vec<UiaNode> = Vec::new();
    let mut counter = 0usize;
    let mut total = 0usize;

    unsafe {
        walk(
            &root,
            0,
            None,
            &mut nodes,
            &mut counter,
            &mut total,
            max_depth,
            max_total,
        )
    };

    log::debug!(
        "MSAA walk for hwnd 0x{hwnd:x} produced {} nodes ({} actionable).",
        nodes.len(),
        nodes.iter().filter(|n| n.element_index.is_some()).count()
    );

    Ok(nodes)
}

/// Returns `true` when `hwnd` belongs to a LibreOffice / OpenOffice VCL window
/// whose UIA provider is known to hang on `BuildUpdatedCache(Subtree)` or return
/// an empty tree. VCL registers its windows under `SAL`-prefixed class names
/// (`SALFRAME`, `SALTMPSUBFRAME`, ...) on Windows; MSAA via `oleacc.dll` walks
/// these cleanly because it sidesteps the bulk-cache cross-process RPC that the
/// UIA provider deadlocks on. Callers should prefer [`walk_msaa_tree`] over the
/// UIA path when this returns `true`.
pub(super) fn is_sal_vcl_window(hwnd: isize) -> bool {
    match window_class_name(hwnd) {
        Some(class) if class.starts_with("SAL") => {
            log::debug!(
                "MSAA fallback selected: hwnd 0x{hwnd:x} class \"{class}\" is a SAL/VCL window."
            );
            true
        }
        Some(_) => false,
        None => false,
    }
}

/// Read the window class name via `GetClassNameW`. Returns `None` on failure or
/// an empty name. The buffer is sized to the documented window-class-name max
/// (256 wchars); class names longer than that are truncated by the API, which is
/// fine because the SAL prefix lives in the first 3 characters.
fn window_class_name(hwnd: isize) -> Option<String> {
    const BUF_LEN: usize = 256;
    let mut buf = [0u16; BUF_LEN];
    // SAFETY: `GetClassNameW` writes up to `BUF_LEN` wchars into `buf` and
    // returns the count (excluding the NUL terminator). `hwnd` is treated as an
    // opaque handle; an invalid handle yields a 0 return, handled below.
    let n = unsafe { GetClassNameW(HWND(hwnd as *mut std::ffi::c_void), &mut buf) };
    if n <= 0 {
        return None;
    }
    let len = n as usize;
    String::from_utf16(&buf[..len])
        .ok()
        .filter(|s| !s.is_empty())
}

#[allow(clippy::too_many_arguments)]
unsafe fn walk(
    acc: &IAccessible,
    depth: usize,
    parent_index: Option<usize>,
    nodes: &mut Vec<UiaNode>,
    counter: &mut usize,
    total: &mut usize,
    max_depth: usize,
    max_total: usize,
) {
    if depth >= max_depth || *total >= max_total {
        return;
    }
    *total += 1;

    // SAFETY: constructs the documented `VT_I4` representation used by MSAA
    // for `CHILDID_SELF` and the child indices below.
    let self_var = unsafe { child_id_variant(CHILDID_SELF) };

    // Properties — each call wrapped to swallow per-element COM errors.
    let role_int: Option<i32> = unsafe { acc.get_accRole(&self_var) }
        .ok()
        .and_then(|v| unsafe { variant_to_i32(&v) });
    let name: Option<String> = unsafe { acc.get_accName(&self_var) }
        .ok()
        .map(|b| b.to_string())
        .filter(|s| !s.trim().is_empty());
    let default_action: Option<String> = unsafe { acc.get_accDefaultAction(&self_var) }
        .ok()
        .map(|b| b.to_string())
        .filter(|s| !s.trim().is_empty());

    // accLocation: out left, top, width, height (screen coords).
    let rect: Option<(i32, i32, i32, i32)> = {
        let mut l = 0i32;
        let mut t = 0i32;
        let mut w = 0i32;
        let mut h = 0i32;
        if unsafe { acc.accLocation(&mut l, &mut t, &mut w, &mut h, &self_var) }.is_ok()
            && w > 0
            && h > 0
        {
            Some((l, t, l + w, t + h))
        } else {
            None
        }
    };

    let role = role_int.unwrap_or(0);
    let control_type = role_to_control_type(role);
    let actions = actions_for(role, default_action.as_deref());
    let is_actionable = !actions.is_empty();
    let has_content = name.is_some();

    if is_actionable || has_content {
        let (center_x, center_y) = rect
            .map(|(l, t, r, b)| ((l + r) / 2, (t + b) / 2))
            .unwrap_or((0, 0));

        // MSAA does not expose a cheap enabled flag in the cua port; default
        // true. `get_accState` & `STATE_SYSTEM_UNAVAILABLE` could refine this
        // later if a caller needs disabled-state fidelity on the fallback path.
        let enabled = true;

        let node = if is_actionable {
            let idx = *counter;
            *counter += 1;
            UiaNode {
                element_index: Some(idx),
                control_type: control_type.clone(),
                name: name.clone(),
                value: None,
                automation_id: None,
                help_text: None,
                actions: actions.clone(),
                element: acc.cast().ok(),
                center_x,
                center_y,
                rect,
                msaa_role: role_int,
                depth,
                parent_element_index: parent_index,
                enabled,
                focused: false,
                selected: None,
                expanded: None,
            }
        } else {
            UiaNode {
                element_index: None,
                control_type: control_type.clone(),
                name: name.clone(),
                value: None,
                automation_id: None,
                help_text: None,
                actions: Vec::new(),
                element: acc.cast().ok(),
                center_x: 0,
                center_y: 0,
                rect,
                msaa_role: role_int,
                depth,
                parent_element_index: parent_index,
                enabled,
                focused: false,
                selected: None,
                expanded: None,
            }
        };
        // Track this node as the parent for its descendants only when it
        // received an element_index (only indexed rows are addressable).
        let next_parent = node.element_index.or(parent_index);
        nodes.push(node);

        // Recurse via accChildCount + get_accChild.
        let child_count = unsafe { acc.accChildCount() }.unwrap_or(0);
        for i in 1..=child_count {
            let child_var = unsafe { child_id_variant(i) };
            // accChild returns IDispatch — query for IAccessible.
            if let Ok(child_disp) = unsafe { acc.get_accChild(&child_var) } {
                if let Ok(child_acc) = child_disp.cast::<IAccessible>() {
                    unsafe {
                        walk(
                            &child_acc,
                            depth + 1,
                            next_parent,
                            nodes,
                            counter,
                            total,
                            max_depth,
                            max_total,
                        )
                    };
                }
            }
        }
        return;
    }

    // Non-emitting path (filtered out by !is_actionable && !has_content): still
    // recurse, propagating the same parent_index.
    let child_count = unsafe { acc.accChildCount() }.unwrap_or(0);
    for i in 1..=child_count {
        let child_var = unsafe { child_id_variant(i) };
        if let Ok(child_disp) = unsafe { acc.get_accChild(&child_var) } {
            if let Ok(child_acc) = child_disp.cast::<IAccessible>() {
                unsafe {
                    walk(
                        &child_acc,
                        depth + 1,
                        parent_index,
                        nodes,
                        counter,
                        total,
                        max_depth,
                        max_total,
                    )
                };
            }
        }
    }
}

/// Construct a `VT_I4` VARIANT carrying `id` (used for `CHILDID_SELF` and child
/// indices). The `windows` 0.61 crate exposes `VARIANT` as a `#[repr(C)]` struct
/// with no `From<i32>` helper (the 0.58 `windows::core::VARIANT` wrapper was
/// removed), so `vt` + `lVal` are set manually on a zeroed variant. The
/// `VARIANT_0.Anonymous` field is `ManuallyDrop<VARIANT_0_0>` inside a union;
/// the borrow checker refuses to auto-`DerefMut` it for a write, so the
/// `ManuallyDrop` is dereferenced explicitly.
unsafe fn child_id_variant(id: i32) -> VARIANT {
    let mut var = VARIANT::default();
    // SAFETY: `VARIANT::default` is initialized, and setting `vt = VT_I4`
    // selects the `lVal` union member written immediately afterward.
    unsafe {
        (*var.Anonymous.Anonymous).vt = VT_I4;
        (*var.Anonymous.Anonymous).Anonymous.lVal = id;
    }
    var
}

/// Read a `VT_I4` out of a VARIANT. `get_accRole` returns `VT_I4` in practice
/// (custom roles may arrive as `VT_BSTR`, which we map to `None` = unknown).
unsafe fn variant_to_i32(v: &VARIANT) -> Option<i32> {
    // SAFETY: the `lVal` union member is read only after the discriminant is
    // confirmed to be `VT_I4`.
    unsafe {
        if (*v.Anonymous.Anonymous).vt == VT_I4 {
            Some((*v.Anonymous.Anonymous).Anonymous.lVal)
        } else {
            None
        }
    }
}

/// Map an MSAA role id to a `control_type` string matching the UIA path. For
/// roles not in this list we emit `Role_<hex>` so the agent still sees something
/// diagnostic.
fn role_to_control_type(role: i32) -> String {
    match role {
        ROLE_SYSTEM_TITLEBAR => "TitleBar",
        ROLE_SYSTEM_MENUBAR => "MenuBar",
        ROLE_SYSTEM_SCROLLBAR => "ScrollBar",
        ROLE_SYSTEM_WINDOW => "Window",
        ROLE_SYSTEM_CLIENT => "Pane",
        ROLE_SYSTEM_MENUPOPUP => "Menu",
        ROLE_SYSTEM_MENUITEM => "MenuItem",
        ROLE_SYSTEM_TOOLTIP => "ToolTip",
        ROLE_SYSTEM_DIALOG => "Window",
        ROLE_SYSTEM_GROUPING => "Group",
        ROLE_SYSTEM_TOOLBAR => "ToolBar",
        ROLE_SYSTEM_STATUSBAR => "StatusBar",
        ROLE_SYSTEM_LINK => "Hyperlink",
        ROLE_SYSTEM_LIST => "List",
        ROLE_SYSTEM_LISTITEM => "ListItem",
        ROLE_SYSTEM_PAGETAB => "TabItem",
        ROLE_SYSTEM_PAGETABLIST => "Tab",
        ROLE_SYSTEM_GRAPHIC => "Image",
        ROLE_SYSTEM_STATICTEXT => "Text",
        ROLE_SYSTEM_TEXT => "Edit",
        ROLE_SYSTEM_PUSHBUTTON => "Button",
        ROLE_SYSTEM_CHECKBUTTON => "CheckBox",
        ROLE_SYSTEM_RADIOBUTTON => "RadioButton",
        ROLE_SYSTEM_COMBOBOX => "ComboBox",
        ROLE_SYSTEM_PROGRESSBAR => "ProgressBar",
        ROLE_SYSTEM_SLIDER => "Slider",
        ROLE_SYSTEM_BUTTONDROPDOWN
        | ROLE_SYSTEM_BUTTONMENU
        | ROLE_SYSTEM_BUTTONDROPDOWNGRID
        | ROLE_SYSTEM_SPLITBUTTON => "SplitButton",
        0 => "Unknown",
        other => return format!("Role_0x{:X}", other),
    }
    .into()
}

/// Compute `actions=[...]` for an MSAA element. Roles with a meaningful default
/// action get `invoke`. Dropdown-flavored roles ALSO get `expand` so callers can
/// address the dropdown half separately — a click step routes `action:"expand"`
/// to a right-edge click rather than just calling `accDoDefaultAction` (which
/// fires the press half).
fn actions_for(role: i32, default_action: Option<&str>) -> Vec<String> {
    let has_action = default_action
        .map(|s| !s.trim().is_empty())
        .unwrap_or(false);
    let mut actions = Vec::new();

    let is_dropdown = matches!(
        role,
        ROLE_SYSTEM_BUTTONDROPDOWN
            | ROLE_SYSTEM_BUTTONMENU
            | ROLE_SYSTEM_BUTTONDROPDOWNGRID
            | ROLE_SYSTEM_SPLITBUTTON
    );
    let is_clickable = matches!(
        role,
        ROLE_SYSTEM_PUSHBUTTON
            | ROLE_SYSTEM_CHECKBUTTON
            | ROLE_SYSTEM_RADIOBUTTON
            | ROLE_SYSTEM_LINK
            | ROLE_SYSTEM_MENUITEM
            | ROLE_SYSTEM_LISTITEM
            | ROLE_SYSTEM_PAGETAB
            | ROLE_SYSTEM_COMBOBOX
    );

    if has_action || is_dropdown || is_clickable {
        actions.push("invoke".into());
    }
    if is_dropdown {
        actions.push("expand".into());
    }
    actions
}
