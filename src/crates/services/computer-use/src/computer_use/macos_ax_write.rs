//! AX-first writers: prefer `AXUIElementPerformAction` /
//! `AXUIElementSetAttributeValue` over synthetic `CGEvent` injection.
//!
//! The dispatch layer's contract:
//!   1. Resolve `(pid, idx)` to a live `AxRef` via `macos_ax_dump::cached_ref`.
//!   2. Try the AX path here without activating the target. The target owns
//!      the semantic action's effects; dispatch alone does not verify them.
//!   3. Only preflight/unsupported outcomes may select `macos_bg_input`.
//!      An attempted mutation with an unknown outcome must never be replayed.
//!
//! Target applications decide which semantic operations they accept.

#![allow(dead_code)]

use super::macos_ax_dispatch::{
    is_attribute_settable as AXUIElementIsAttributeSettable,
    perform_action as AXUIElementPerformAction,
    set_input_attribute_value as AXUIElementSetAttributeValue,
};
use crate::computer_use::macos_ax_dump::AxRef;
use core_foundation::base::{CFTypeRef, TCFType};
use core_foundation::boolean::CFBoolean;
use core_foundation::string::CFString;

type AXUIElementRef = *const std::ffi::c_void;

#[link(name = "ApplicationServices", kind = "framework")]
unsafe extern "C" {
    fn AXUIElementGetPid(element: AXUIElementRef, pid: *mut i32) -> i32;
}

/// Result of an AX-first attempt.
#[derive(Debug)]
pub(super) enum AxWriteOutcome {
    /// The AX call succeeded — no fallback needed.
    Ok,
    /// AX rejected the call. Only an explicitly unsupported operation permits
    /// event injection; other failures may have an unknown mutation outcome.
    Unavailable(i32),
}

fn can_write(target: AxRef) -> bool {
    if target.0.is_null() || super::control_session::input_allowed().is_err() {
        return false;
    }
    let mut pid = 0;
    if unsafe { AXUIElementGetPid(target.0, &mut pid) } != 0 {
        return false;
    }
    let Ok(window) = super::macos_capture::bound_window_id(pid) else {
        return false;
    };
    let same_window = match super::macos_ax_dump::element_window_id(target) {
        Some(actual) => actual == window,
        // Menu-bar actions have application scope and no window. Arbitrary
        // controls with an unknown owning window cannot inherit that exception.
        None => super::macos_ax_dump::is_application_menu_item(target),
    };
    same_window
        && super::control_session::target_allowed(&format!("pid:{pid}/window:{window}")).is_ok()
}

fn note_dispatched_input(target: AxRef) {
    let mut pid = 0;
    if unsafe { AXUIElementGetPid(target.0, &mut pid) } == 0 {
        super::macos_capture::note_input(pid);
    }
}

/// Try to "click" via AXPress. Most controls (NSButton, links, menu items)
/// implement this; many text fields and webviews do not.
pub(super) fn try_ax_press(target: AxRef) -> AxWriteOutcome {
    if !can_write(target) {
        return AxWriteOutcome::Unavailable(-1);
    }
    let action = CFString::new("AXPress");
    let st = unsafe { AXUIElementPerformAction(target.0, action.as_concrete_TypeRef()) };
    if st == 0 {
        note_dispatched_input(target);
        AxWriteOutcome::Ok
    } else {
        AxWriteOutcome::Unavailable(st)
    }
}

/// Try to set the AXValue of a text field. `value` is sent as a CFString.
/// Caller is responsible for any subsequent focus / commit (Tab, Return).
pub(super) fn try_ax_set_value(target: AxRef, value: &str) -> AxWriteOutcome {
    if !can_write(target) {
        return AxWriteOutcome::Unavailable(-1);
    }
    let attr = CFString::new("AXValue");
    let v = CFString::new(value);
    let st = unsafe {
        AXUIElementSetAttributeValue(
            target.0,
            attr.as_concrete_TypeRef(),
            v.as_concrete_TypeRef() as CFTypeRef,
        )
    };
    if st == 0 {
        note_dispatched_input(target);
        AxWriteOutcome::Ok
    } else {
        AxWriteOutcome::Unavailable(st)
    }
}

/// Replace the selection (or insert at the caret) in one native operation.
/// `false` is returned only before mutation when this attribute is unsupported.
/// A failed write has an unknown outcome and must never fall back to key events.
pub(super) fn insert_selected_text(
    target: AxRef,
    text: &str,
) -> openbitfun_agent_tools::computer_use_host::error::OpenBitFunResult<bool> {
    use openbitfun_agent_tools::computer_use_host::error::OpenBitFunError;
    if !can_write(target) {
        return Err(OpenBitFunError::tool(
            "[CONTROL_TARGET_CHANGED] Text target is outside the active capture",
        ));
    }
    // Cross-process accessibility proxies (notably WebKit content) can report
    // AXSelectedText as settable while its implementation is a no-op. Do not
    // submit that write and then retry: choose directed keyboard input during
    // preflight. Native controls keep the selection-preserving AX fast path.
    let mut presenter = 0;
    let status = unsafe { AXUIElementGetPid(target.0, &mut presenter) };
    if status != 0 {
        return Err(OpenBitFunError::tool(format!(
            "[AX_TEXT_PREFLIGHT_FAILED] Cannot resolve the text target process (status={status}); no text was submitted"
        )));
    }
    let serving = unsafe { super::macos_ax_dispatch::actual_pid(target.0) }.map_err(|status| {
        OpenBitFunError::tool(format!(
            "[AX_TEXT_PREFLIGHT_FAILED] Cannot resolve the text provider process (status={status}); no text was submitted"
        ))
    })?;
    if serving != presenter {
        return Ok(false);
    }
    let attr = CFString::new("AXSelectedText");
    let mut settable = 0u8;
    let status = unsafe {
        AXUIElementIsAttributeSettable(target.0, attr.as_concrete_TypeRef(), &mut settable)
    };
    if matches!(status, -25205 | -25208 | -25212) || (status == 0 && settable == 0) {
        return Ok(false);
    }
    if status != 0 {
        return Err(OpenBitFunError::tool(format!("[AX_TEXT_PREFLIGHT_FAILED] Cannot inspect selected-text support (status={status}); no text was submitted")));
    }
    if !can_write(target) {
        return Err(OpenBitFunError::tool(
            "[CONTROL_TARGET_CHANGED] Text target changed before insertion",
        ));
    }
    let value = CFString::new(text);
    let status = unsafe {
        AXUIElementSetAttributeValue(
            target.0,
            attr.as_concrete_TypeRef(),
            value.as_concrete_TypeRef() as CFTypeRef,
        )
    };
    note_dispatched_input(target);
    if status != 0 {
        return Err(OpenBitFunError::tool(format!("[INPUT_OUTCOME_UNKNOWN] AXSelectedText returned {status}; do not repeat the insertion or send fallback keys")));
    }
    Ok(true)
}

/// Try a generic AX action by name (e.g. `"AXShowMenu"`, `"AXIncrement"`).
pub(super) fn try_ax_action(target: AxRef, action_name: &str) -> AxWriteOutcome {
    if !can_write(target) {
        return AxWriteOutcome::Unavailable(-1);
    }
    let a = CFString::new(action_name);
    let st = unsafe { AXUIElementPerformAction(target.0, a.as_concrete_TypeRef()) };
    if st == 0 {
        note_dispatched_input(target);
        AxWriteOutcome::Ok
    } else {
        AxWriteOutcome::Unavailable(st)
    }
}

/// Try to set `AXFocused = true` on the target element. This is a first-class
/// pre-focus primitive: focusing a control before sending a key event ensures
/// reliable key delivery to the right field.
///
/// Reports rejected focus changes as unavailable. A failed focus request is
/// never evidence that subsequent text input has the intended destination.
pub(super) fn try_ax_focus(target: AxRef) -> AxWriteOutcome {
    if !can_write(target) {
        return AxWriteOutcome::Unavailable(-1);
    }
    let attr = CFString::new("AXFocused");
    let val = CFBoolean::true_value();
    let st = unsafe {
        AXUIElementSetAttributeValue(
            target.0,
            attr.as_concrete_TypeRef(),
            val.as_concrete_TypeRef() as CFTypeRef,
        )
    };
    if st == 0 {
        note_dispatched_input(target);
        AxWriteOutcome::Ok
    } else {
        AxWriteOutcome::Unavailable(st)
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    /// Null AX refs must short-circuit to `Unavailable(-1)` so the dispatch
    /// layer falls back to event injection instead of dereferencing a null
    /// pointer in the AX framework.
    #[test]
    fn null_ref_press_returns_unavailable() {
        let r = AxRef(std::ptr::null());
        match try_ax_press(r) {
            AxWriteOutcome::Unavailable(-1) => {}
            other => panic!("expected Unavailable(-1), got {:?}", other),
        }
    }

    #[test]
    fn null_ref_set_value_returns_unavailable() {
        let r = AxRef(std::ptr::null());
        match try_ax_set_value(r, "hello") {
            AxWriteOutcome::Unavailable(-1) => {}
            other => panic!("expected Unavailable(-1), got {:?}", other),
        }
    }

    #[test]
    fn null_ref_action_returns_unavailable() {
        let r = AxRef(std::ptr::null());
        match try_ax_action(r, "AXShowMenu") {
            AxWriteOutcome::Unavailable(-1) => {}
            other => panic!("expected Unavailable(-1), got {:?}", other),
        }
    }

    #[test]
    fn null_ref_focus_returns_unavailable() {
        let r = AxRef(std::ptr::null());
        match try_ax_focus(r) {
            AxWriteOutcome::Unavailable(-1) => {}
            other => panic!("expected Unavailable(-1), got {:?}", other),
        }
    }
}
