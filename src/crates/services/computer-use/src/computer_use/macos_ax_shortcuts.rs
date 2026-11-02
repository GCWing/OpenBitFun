//! macOS menu-bar keyboard shortcut extraction (`get_app_shortcuts`).
//!
//! Walks the target application's `AXMenuBar` and reads the
//! `AXMenuItemCmd*` attributes that macOS's Cocoa menu system publishes for
//! every registered key equivalent. This is the **read** counterpart to
//! `macos_skylight.rs` (which only *delivers* key equivalents) — no other
//! module in this crate currently exposes "what shortcut does this menu
//! item have?".
//!
//! Self-contained: declares its own minimal AX/CF FFI bindings rather than
//! reusing `macos_ax_dump.rs` / `macos_ax_ui.rs`, following the existing
//! convention in this directory that each AX walker owns its bindings.

#![allow(dead_code)]

use super::macos_ax_dispatch::copy_attribute_value as AXUIElementCopyAttributeValue;
use core_foundation::array::{CFArray, CFArrayRef};
use core_foundation::base::{CFGetTypeID, CFTypeRef, TCFType};
use core_foundation::boolean::{CFBooleanGetTypeID, CFBooleanRef};
use core_foundation::string::{CFString, CFStringRef};
use openbitfun_agent_tools::computer_use_host::error::{OpenBitFunError, OpenBitFunResult};
use openbitfun_agent_tools::computer_use_host::AppMenuShortcut;
use std::ffi::c_void;

type CFNumberRef = *const c_void;
type CFTypeID = usize;
const K_CF_NUMBER_LONG_LONG_TYPE: i32 = 11;

type AXUIElementRef = *const c_void;

#[link(name = "ApplicationServices", kind = "framework")]
unsafe extern "C" {
    fn AXUIElementCreateApplication(pid: i32) -> AXUIElementRef;
}

#[link(name = "CoreFoundation", kind = "framework")]
unsafe extern "C" {
    fn CFBooleanGetValue(boolean: CFBooleanRef) -> u8;
    fn CFStringGetTypeID() -> CFTypeID;
    fn CFNumberGetTypeID() -> CFTypeID;
    fn CFNumberGetValue(number: CFNumberRef, the_type: i32, value_ptr: *mut c_void) -> u8;
}

/// Maximum menu-tree depth we'll recurse (menu bar → menu → item →
/// submenu → …). Real apps rarely nest more than 4-5 levels; this is a
/// defensive cap against pathological/malformed AX trees.
const MAX_DEPTH: u32 = 12;
/// Total AX elements visited cap, mirroring `macos_ax_dump.rs`'s
/// node-count defense.
const MAX_VISITED: usize = 3_000;

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

/// See `macos_ax_dump.rs::cfstring_to_string` for why the type check is
/// mandatory before treating a CFTypeRef as a CFString.
unsafe fn cfstring_to_string(cf: CFTypeRef) -> Option<String> {
    unsafe {
        if cf.is_null() || CFGetTypeID(cf) != CFStringGetTypeID() {
            return None;
        }
        Some(CFString::wrap_under_get_rule(cf as CFStringRef).to_string())
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

unsafe fn read_cf_bool_attr(elem: AXUIElementRef, key: &str) -> Option<bool> {
    unsafe {
        let v = ax_copy_attr(elem, key)?;
        let out = if CFGetTypeID(v) == CFBooleanGetTypeID() {
            Some(CFBooleanGetValue(v as CFBooleanRef) != 0)
        } else {
            None
        };
        ax_release(v);
        out
    }
}

unsafe fn read_cf_number_attr(elem: AXUIElementRef, key: &str) -> Option<i64> {
    unsafe {
        let v = ax_copy_attr(elem, key)?;
        let out = if CFGetTypeID(v) == CFNumberGetTypeID() {
            let mut i: i64 = 0;
            if CFNumberGetValue(
                v as CFNumberRef,
                K_CF_NUMBER_LONG_LONG_TYPE,
                &mut i as *mut _ as *mut c_void,
            ) != 0
            {
                Some(i)
            } else {
                None
            }
        } else {
            None
        };
        ax_release(v);
        out
    }
}

/// Decode `AXMenuItemCmdModifiers` bitmask into canonical lowercase
/// modifier names, in the conventional macOS display order (Control,
/// Option, Shift, Command). Verified against public documentation:
/// bit0(0x1)=shift, bit1(0x2)=option, bit2(0x4)=control are "present when
/// set"; bit3(0x8) is `kAXMenuItemModifierNoCommand` — Command is present
/// by default and only *absent* when this bit is set.
fn parse_ax_menu_modifiers(bits: i64) -> Vec<String> {
    let mut mods = Vec::with_capacity(4);
    if bits & 0x4 != 0 {
        mods.push("control".to_string());
    }
    if bits & 0x2 != 0 {
        mods.push("option".to_string());
    }
    if bits & 0x1 != 0 {
        mods.push("shift".to_string());
    }
    if bits & 0x8 == 0 {
        mods.push("command".to_string());
    }
    mods
}

/// Render the macOS glyph combo for a shortcut, e.g. `"⌃⌥⇧⌘S"`.
fn render_shortcut_display(modifiers: &[String], key: &str) -> String {
    let mut out = String::new();
    for m in modifiers {
        out.push_str(match m.as_str() {
            "control" => "⌃",
            "option" => "⌥",
            "shift" => "⇧",
            "command" => "⌘",
            _ => "",
        });
    }
    // Single-char keys render uppercase (macOS convention: "⌘S" not
    // "⌘s"); multi-char names (e.g. "left", "f5") render as-is.
    if key.chars().count() == 1 {
        out.push_str(&key.to_uppercase());
    } else {
        out.push_str(key);
    }
    out
}

/// Cocoa `NS*FunctionKey` private-use-area code points
/// (`AppKit/NSEvent.h`), which `AXMenuItemCmdChar` uses verbatim for
/// non-printable keys like arrows and function keys.
fn function_key_name(cp: u32) -> Option<&'static str> {
    let name = match cp {
        0xF700 => "up",
        0xF701 => "down",
        0xF702 => "left",
        0xF703 => "right",
        0xF704..=0xF726 => return Some(f_key_name(cp - 0xF704 + 1)),
        0xF727 => "insert",
        0xF728 => "delete",
        0xF729 => "home",
        0xF72A => "begin",
        0xF72B => "end",
        0xF72C => "page_up",
        0xF72D => "page_down",
        0xF72E => "print_screen",
        0xF72F => "scroll_lock",
        0xF730 => "pause",
        0xF731 => "sys_req",
        0xF732 => "break",
        0xF733 => "reset",
        0xF734 => "stop",
        0xF735 => "menu",
        0xF736 => "user",
        0xF737 => "system",
        0xF738 => "print",
        0xF739 => "clear_line",
        0xF73A => "clear_display",
        0xF73B => "insert_line",
        0xF73C => "delete_line",
        0xF73D => "insert_char",
        0xF73E => "delete_char",
        0xF73F => "prev",
        0xF740 => "next",
        0xF741 => "select",
        0xF742 => "execute",
        0xF743 => "undo",
        0xF744 => "redo",
        0xF745 => "find",
        0xF746 => "help",
        0xF747 => "mode_switch",
        _ => return None,
    };
    Some(name)
}

fn f_key_name(n: u32) -> &'static str {
    // NSF1FunctionKey..NSF35FunctionKey map to F1..F35 contiguously.
    const NAMES: [&str; 35] = [
        "f1", "f2", "f3", "f4", "f5", "f6", "f7", "f8", "f9", "f10", "f11", "f12", "f13", "f14",
        "f15", "f16", "f17", "f18", "f19", "f20", "f21", "f22", "f23", "f24", "f25", "f26", "f27",
        "f28", "f29", "f30", "f31", "f32", "f33", "f34", "f35",
    ];
    NAMES
        .get((n.saturating_sub(1)) as usize)
        .copied()
        .unwrap_or("f?")
}

fn special_char_name(cp: u32) -> Option<&'static str> {
    match cp {
        0x03 => Some("enter"),
        0x08 => Some("backspace"),
        0x09 => Some("tab"),
        0x0D => Some("return"),
        0x1B => Some("escape"),
        0x20 => Some("space"),
        0x7F => Some("delete"),
        _ => None,
    }
}

/// Decode `AXMenuItemCmdChar` into a canonical lowercase key name.
/// Returns `None` for unrecognized control characters.
fn decode_cmd_char(s: &str) -> Option<String> {
    let c = s.chars().next()?;
    let cp = c as u32;
    if let Some(name) = special_char_name(cp) {
        return Some(name.to_string());
    }
    if let Some(name) = function_key_name(cp) {
        return Some(name.to_string());
    }
    if c.is_control() {
        return None;
    }
    Some(c.to_lowercase().to_string())
}

/// Carbon `kVK_*` virtual keycodes (`HIToolbox/Events.h`), used only as a
/// fallback when `AXMenuItemCmdChar` is empty. Covers the keys that
/// cannot be expressed via `CmdChar` on some apps (arrows/function keys
/// duplicate `function_key_name` for redundancy; letters/digits included
/// for completeness though normally already covered by `CmdChar`).
fn keycode_name(vk: i64) -> Option<String> {
    let name = match vk {
        0x00 => "a",
        0x0B => "b",
        0x08 => "c",
        0x02 => "d",
        0x0E => "e",
        0x03 => "f",
        0x05 => "g",
        0x04 => "h",
        0x22 => "i",
        0x26 => "j",
        0x28 => "k",
        0x25 => "l",
        0x2E => "m",
        0x2D => "n",
        0x1F => "o",
        0x23 => "p",
        0x0C => "q",
        0x0F => "r",
        0x01 => "s",
        0x11 => "t",
        0x20 => "u",
        0x09 => "v",
        0x0D => "w",
        0x07 => "x",
        0x10 => "y",
        0x06 => "z",
        0x12 => "1",
        0x13 => "2",
        0x14 => "3",
        0x15 => "4",
        0x17 => "5",
        0x16 => "6",
        0x1A => "7",
        0x1C => "8",
        0x19 => "9",
        0x1D => "0",
        0x24 => "return",
        0x30 => "tab",
        0x31 => "space",
        0x33 => "backspace",
        0x35 => "escape",
        0x75 => "delete",
        0x73 => "home",
        0x77 => "end",
        0x74 => "page_up",
        0x79 => "page_down",
        0x7B => "left",
        0x7C => "right",
        0x7D => "down",
        0x7E => "up",
        0x7A => "f1",
        0x78 => "f2",
        0x63 => "f3",
        0x76 => "f4",
        0x60 => "f5",
        0x61 => "f6",
        0x62 => "f7",
        0x64 => "f8",
        0x65 => "f9",
        0x6D => "f10",
        0x67 => "f11",
        0x6F => "f12",
        0x69 => "f13",
        0x6B => "f14",
        0x71 => "f15",
        0x6A => "f16",
        0x40 => "f17",
        0x4F => "f18",
        0x50 => "f19",
        0x5A => "f20",
        0x72 => "help",
        0x18 => "=",
        0x1B => "-",
        0x1E => "]",
        0x21 => "[",
        0x27 => "'",
        0x29 => ";",
        0x2A => "\\",
        0x2B => ",",
        0x2C => "/",
        0x2F => ".",
        0x32 => "`",
        _ => return None,
    };
    Some(name.to_string())
}

struct WalkState {
    out: Vec<AppMenuShortcut>,
    without_shortcut: u32,
    visited: usize,
}

fn walk(elem: AXUIElementRef, path: &[String], depth: u32, state: &mut WalkState) {
    if depth > MAX_DEPTH || state.visited >= MAX_VISITED {
        return;
    }
    state.visited += 1;

    let role = unsafe { read_cf_string_attr(elem, "AXRole") }.unwrap_or_default();
    let mut next_path = path.to_vec();
    let is_menu_item = matches!(role.as_str(), "AXMenuItem" | "AXMenuBarItem");

    if is_menu_item {
        let title = unsafe { read_cf_string_attr(elem, "AXTitle") }.unwrap_or_default();
        if !title.is_empty() {
            next_path.push(title);

            let cmd_char = unsafe { read_cf_string_attr(elem, "AXMenuItemCmdChar") };
            let vk = unsafe { read_cf_number_attr(elem, "AXMenuItemCmdVirtualKey") };
            let key = cmd_char
                .as_deref()
                .filter(|s| !s.is_empty())
                .and_then(decode_cmd_char)
                .or_else(|| vk.and_then(keycode_name));

            match key {
                Some(key) => {
                    let modifiers_bits =
                        unsafe { read_cf_number_attr(elem, "AXMenuItemCmdModifiers") }.unwrap_or(0);
                    let modifiers = parse_ax_menu_modifiers(modifiers_bits);
                    let enabled = unsafe { read_cf_bool_attr(elem, "AXEnabled") }.unwrap_or(true);
                    let checked = unsafe { read_cf_string_attr(elem, "AXMenuItemMarkChar") }
                        .map(|m| !m.is_empty());
                    let shortcut_display = render_shortcut_display(&modifiers, &key);
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

    if let Some(children_ref) = unsafe { ax_copy_attr(elem, "AXChildren") } {
        unsafe {
            let arr = CFArray::<*const c_void>::wrap_under_create_rule(children_ref as CFArrayRef);
            for i in 0..arr.len() {
                if let Some(slot) = arr.get(i) {
                    let child = *slot;
                    if !child.is_null() {
                        walk(child as AXUIElementRef, &next_path, depth + 1, state);
                    }
                }
            }
        }
    }
}

/// Walk `pid`'s `AXMenuBar` and return `(shortcuts, menu_items_without_shortcut)`.
///
/// Returns an empty result (not an error) when the app has no menu bar
/// (e.g. background-only agents) — that is a legitimate "no shortcuts"
/// answer, not a failure.
pub(super) fn dump_app_menu_shortcuts(pid: i32) -> OpenBitFunResult<(Vec<AppMenuShortcut>, u32)> {
    let app = unsafe { AXUIElementCreateApplication(pid) };
    if app.is_null() {
        return Err(OpenBitFunError::tool(format!(
            "AXUIElementCreateApplication returned null for pid={}",
            pid
        )));
    }

    let menu_bar = unsafe { ax_copy_attr(app, "AXMenuBar") };
    unsafe { ax_release(app as CFTypeRef) };

    let Some(menu_bar) = menu_bar else {
        return Ok((Vec::new(), 0));
    };

    let mut state = WalkState {
        out: Vec::new(),
        without_shortcut: 0,
        visited: 0,
    };
    walk(menu_bar as AXUIElementRef, &[], 0, &mut state);
    unsafe { ax_release(menu_bar) };

    Ok((state.out, state.without_shortcut))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn parses_command_only_modifier() {
        // No bits set: only kAXMenuItemModifierNoCommand absent -> Command.
        assert_eq!(parse_ax_menu_modifiers(0), vec!["command".to_string()]);
    }

    #[test]
    fn parses_shift_command() {
        assert_eq!(
            parse_ax_menu_modifiers(0x1),
            vec!["shift".to_string(), "command".to_string()]
        );
    }

    #[test]
    fn parses_control_option_shift_no_command() {
        assert_eq!(
            parse_ax_menu_modifiers(0x4 | 0x2 | 0x1 | 0x8),
            vec![
                "control".to_string(),
                "option".to_string(),
                "shift".to_string(),
            ]
        );
    }

    #[test]
    fn parses_command_only_bitmask() {
        // Only kAXMenuItemModifierNoCommand bit set alone: no shift/opt/ctrl, command absent.
        assert_eq!(parse_ax_menu_modifiers(0x8), Vec::<String>::new());
    }

    #[test]
    fn renders_shortcut_display_with_glyph_order() {
        let mods = vec![
            "control".to_string(),
            "option".to_string(),
            "shift".to_string(),
            "command".to_string(),
        ];
        assert_eq!(render_shortcut_display(&mods, "s"), "⌃⌥⇧⌘S");
    }

    #[test]
    fn renders_multi_char_key_lowercase() {
        assert_eq!(
            render_shortcut_display(&["command".to_string()], "left"),
            "⌘left"
        );
    }

    #[test]
    fn decodes_function_key_unicode_range() {
        let arrow_up = char::from_u32(0xF700).unwrap().to_string();
        assert_eq!(decode_cmd_char(&arrow_up), Some("up".to_string()));
        let f5 = char::from_u32(0xF704 + 4).unwrap().to_string();
        assert_eq!(decode_cmd_char(&f5), Some("f5".to_string()));
        let delete_fn = char::from_u32(0xF728).unwrap().to_string();
        assert_eq!(decode_cmd_char(&delete_fn), Some("delete".to_string()));
    }

    #[test]
    fn decodes_special_ascii_control_chars() {
        assert_eq!(decode_cmd_char("\u{1B}"), Some("escape".to_string()));
        assert_eq!(decode_cmd_char("\t"), Some("tab".to_string()));
        assert_eq!(decode_cmd_char("\r"), Some("return".to_string()));
    }

    #[test]
    fn decodes_plain_letter_lowercase() {
        assert_eq!(decode_cmd_char("S"), Some("s".to_string()));
        assert_eq!(decode_cmd_char("s"), Some("s".to_string()));
    }

    #[test]
    fn decodes_digit_and_symbol_verbatim() {
        assert_eq!(decode_cmd_char("1"), Some("1".to_string()));
        assert_eq!(decode_cmd_char(","), Some(",".to_string()));
    }

    #[test]
    fn virtual_keycode_fallback_covers_arrows_and_function_keys() {
        assert_eq!(keycode_name(0x7B), Some("left".to_string()));
        assert_eq!(keycode_name(0x7A), Some("f1".to_string()));
        assert_eq!(keycode_name(0x75), Some("delete".to_string()));
        assert_eq!(keycode_name(0x35), Some("escape".to_string()));
        assert_eq!(keycode_name(0xFFFF), None);
    }
}
