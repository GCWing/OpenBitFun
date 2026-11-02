//! Windows UI Automation (UIA) menu-bar keyboard shortcut extraction
//! (`get_app_shortcuts`).
//!
//! Native Win32 `HMENU`-backed menu bars expose their full item structure
//! through the default UIA proxy without requiring the menu to be open
//! (this is how tools like WinAppDriver enumerate "File > Save" without
//! ever clicking "File"), and UIA already renders `AcceleratorKey` as a
//! human-readable string (e.g. `"Ctrl+Shift+S"`) rather than a raw
//! keycode/modifier pair — so this walk is a straightforward cached
//! `UIA_MenuBarControlTypeId` / `UIA_MenuItemControlTypeId` traversal
//! followed by [`parse_windows_accelerator_display`].
//!
//! Reuses [`super::windows_ax_ui::build_updated_cache_with_retry`] rather
//! than duplicating the transient-`E_FAIL` retry handling.

#![cfg(target_os = "windows")]
#![allow(dead_code)]

use crate::computer_use::windows_ax_ui::build_updated_cache_with_retry;
use openbitfun_agent_tools::computer_use_host::error::{OpenBitFunError, OpenBitFunResult};
use openbitfun_agent_tools::computer_use_host::{
    parse_windows_accelerator_display, AppMenuShortcut,
};
use windows::Win32::Foundation::HWND;
use windows::Win32::UI::Accessibility::{
    IUIAutomation, IUIAutomationCacheRequest, IUIAutomationElement, IUIAutomationTogglePattern,
    ToggleState_On, TreeScope_Subtree, UIA_AcceleratorKeyPropertyId, UIA_ControlTypePropertyId,
    UIA_IsEnabledPropertyId, UIA_MenuBarControlTypeId, UIA_MenuItemControlTypeId,
    UIA_NamePropertyId, UIA_TogglePatternId,
};

/// Menu-tree recursion depth cap (menu bar → menu → item → submenu → …).
const MAX_DEPTH: u32 = 12;
/// Total UIA elements visited cap, mirroring the macOS walker's defense.
const MAX_VISITED: usize = 3_000;
/// Bound on how deep we search from the window root to *find* the menu
/// bar before concluding the window has none (a legitimate result for
/// modern Fluent/Electron apps with no classic menu bar).
const MENU_BAR_SEARCH_DEPTH: u32 = 6;
const MENU_BAR_SEARCH_MAX_VISITED: usize = 4_000;

unsafe fn build_shortcuts_cache_request(
    automation: &IUIAutomation,
) -> OpenBitFunResult<IUIAutomationCacheRequest> {
    // SAFETY: `automation` is a live UI Automation COM interface and every
    // property, pattern, and scope identifier below is a documented UIA value.
    let cache_req = unsafe { automation.CreateCacheRequest() }
        .map_err(|e| OpenBitFunError::tool(format!("UI Automation CreateCacheRequest: {}.", e)))?;
    for prop in [
        UIA_ControlTypePropertyId,
        UIA_NamePropertyId,
        UIA_AcceleratorKeyPropertyId,
        UIA_IsEnabledPropertyId,
    ] {
        let _ = unsafe { cache_req.AddProperty(prop) };
    }
    let _ = unsafe { cache_req.AddPattern(UIA_TogglePatternId) };
    let _ = unsafe { cache_req.SetTreeScope(TreeScope_Subtree) };
    Ok(cache_req)
}

fn read_cached_name(element: &IUIAutomationElement) -> Option<String> {
    unsafe {
        let s = element.CachedName().ok()?.to_string();
        if s.trim().is_empty() {
            None
        } else {
            Some(s)
        }
    }
}

fn read_cached_accelerator_key(element: &IUIAutomationElement) -> Option<String> {
    unsafe {
        let s = element.CachedAcceleratorKey().ok()?.to_string();
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

fn read_cached_control_type(element: &IUIAutomationElement) -> i32 {
    unsafe { element.CachedControlType().map(|c| c.0).unwrap_or(0) }
}

fn read_cached_toggle_state(element: &IUIAutomationElement) -> Option<bool> {
    unsafe {
        let tp = element
            .GetCachedPatternAs::<IUIAutomationTogglePattern>(UIA_TogglePatternId)
            .ok()?;
        let state = tp.CachedToggleState().ok()?;
        Some(state == ToggleState_On)
    }
}

struct WalkState {
    out: Vec<AppMenuShortcut>,
    without_shortcut: u32,
    visited: usize,
}

fn walk(element: &IUIAutomationElement, path: &[String], depth: u32, state: &mut WalkState) {
    if depth > MAX_DEPTH || state.visited >= MAX_VISITED {
        return;
    }
    state.visited += 1;

    let control_type = read_cached_control_type(element);
    let is_menu_item = control_type == UIA_MenuItemControlTypeId.0;

    let mut next_path = path.to_vec();
    if is_menu_item {
        if let Some(name) = read_cached_name(element) {
            next_path.push(name);

            match read_cached_accelerator_key(element).and_then(|s| {
                let (modifiers, key) = parse_windows_accelerator_display(&s);
                key.map(|k| (modifiers, k))
            }) {
                Some((modifiers, key)) => {
                    let enabled = read_cached_is_enabled(element);
                    let checked = read_cached_toggle_state(element);
                    let shortcut_display = if modifiers.is_empty() {
                        key.clone()
                    } else {
                        format!(
                            "{}+{}",
                            modifiers
                                .iter()
                                .map(|m| capitalize(m))
                                .collect::<Vec<_>>()
                                .join("+"),
                            capitalize(&key)
                        )
                    };
                    state.out.push(AppMenuShortcut {
                        menu_path: next_path.clone(),
                        title: next_path.last().cloned().unwrap_or_default(),
                        shortcut_display: Some(shortcut_display),
                        modifiers,
                        key: Some(key),
                        enabled,
                        checked,
                    });
                }
                None => {
                    state.without_shortcut += 1;
                }
            }
        }
    }

    if let Ok(children) = unsafe { element.GetCachedChildren() } {
        let len = unsafe { children.Length() }.unwrap_or(0);
        for i in 0..len {
            if state.visited >= MAX_VISITED {
                break;
            }
            if let Ok(child) = unsafe { children.GetElement(i) } {
                walk(&child, &next_path, depth + 1, state);
            }
        }
    }
}

fn capitalize(s: &str) -> String {
    let mut chars = s.chars();
    match chars.next() {
        Some(c) => c.to_uppercase().collect::<String>() + chars.as_str(),
        None => String::new(),
    }
}

/// Bounded BFS from `root` for the first `UIA_MenuBarControlTypeId`
/// descendant. Separate from the shortcut walk's depth/visited budget
/// since a menu bar can sit a few levels below the window root (title
/// bar, ribbon container, ...).
fn find_menu_bar(root: &IUIAutomationElement) -> Option<IUIAutomationElement> {
    let mut queue: std::collections::VecDeque<(IUIAutomationElement, u32)> =
        std::collections::VecDeque::new();
    queue.push_back((root.clone(), 0));
    let mut visited = 0usize;
    while let Some((elem, depth)) = queue.pop_front() {
        if depth > MENU_BAR_SEARCH_DEPTH || visited >= MENU_BAR_SEARCH_MAX_VISITED {
            continue;
        }
        visited += 1;
        if read_cached_control_type(&elem) == UIA_MenuBarControlTypeId.0 {
            return Some(elem);
        }
        if let Ok(children) = unsafe { elem.GetCachedChildren() } {
            let len = unsafe { children.Length() }.unwrap_or(0);
            for i in 0..len {
                if let Ok(child) = unsafe { children.GetElement(i) } {
                    queue.push_back((child, depth + 1));
                }
            }
        }
    }
    None
}

/// Walk `hwnd`'s UIA tree and return `(shortcuts, menu_items_without_shortcut)`.
///
/// Returns an empty result (not an error) when no `MenuBar` element is
/// found — modern Fluent/Electron apps frequently have no classic menu
/// bar, which is a legitimate "no shortcuts (via this mechanism)" answer.
pub(super) fn get_app_menu_shortcuts(hwnd: HWND) -> OpenBitFunResult<(Vec<AppMenuShortcut>, u32)> {
    let hwnd = hwnd.0 as isize;
    super::windows_ax_ui::run_read("shortcuts", move || unsafe {
        let hwnd = HWND(hwnd as *mut _);
        let automation = super::windows_ax_ui::create_automation()?;

        let cache_req = build_shortcuts_cache_request(&automation)?;

        let uncached = automation.ElementFromHandle(hwnd).map_err(|e| {
            OpenBitFunError::tool(format!("UI Automation ElementFromHandle: {}.", e))
        })?;

        let root = build_updated_cache_with_retry(&uncached, &cache_req)?;

        let Some(menu_bar) = find_menu_bar(&root) else {
            return Ok((Vec::new(), 0));
        };

        let mut state = WalkState {
            out: Vec::new(),
            without_shortcut: 0,
            visited: 0,
        };
        walk(&menu_bar, &[], 0, &mut state);
        Ok((state.out, state.without_shortcut))
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn capitalize_lowercases_are_titled() {
        assert_eq!(capitalize("control"), "Control".to_string());
        assert_eq!(capitalize("s"), "S".to_string());
        assert_eq!(capitalize(""), "".to_string());
    }
}
