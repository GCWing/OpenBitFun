//! Pure Linux session classification and input encoding. No native side effects.
/// Linux sessions must be identified before selecting the legacy input backend.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub(crate) enum DisplaySession {
    Wayland,
    X11,
    Unavailable,
}

pub(crate) fn classify_display(
    kind: Option<&str>,
    wayland: Option<&str>,
    x11: Option<&str>,
) -> DisplaySession {
    if kind == Some("wayland") || wayland.is_some_and(|s| !s.is_empty()) {
        DisplaySession::Wayland
    } else if x11.is_some_and(|s| !s.is_empty()) && (kind.is_none() || kind == Some("x11")) {
        DisplaySession::X11
    } else {
        DisplaySession::Unavailable
    }
}

/// Legacy capture is available only before any control owner takes over.
pub(crate) fn portal_required(previous_portal: bool, state: &str, has_owner: bool) -> bool {
    previous_portal || has_owner || state != "idle"
}

pub(crate) fn button_code(button: &str) -> Result<i32, String> {
    match button.to_ascii_lowercase().as_str() {
        "left" => Ok(272),
        "right" => Ok(273),
        "middle" => Ok(274),
        _ => Err(format!("[INVALID_BUTTON] Unknown pointer button {button}")),
    }
}

pub(crate) fn character_keysym(character: char) -> i32 {
    match character {
        '\n' | '\r' => 0xff0d,
        '\t' => 0xff09,
        c if c as u32 <= 0xff => c as i32,
        c => 0x0100_0000 | c as i32,
    }
}

pub(crate) fn key_keysym(key: &str) -> Result<i32, String> {
    let lowered = key.to_lowercase();
    Ok(match lowered.as_str() {
        "command" | "meta" | "super" | "win" => 0xffeb,
        "control" | "ctrl" => 0xffe3,
        "shift" => 0xffe1,
        "alt" | "option" => 0xffe9,
        "return" | "enter" => 0xff0d,
        "tab" => 0xff09,
        "escape" | "esc" => 0xff1b,
        "space" => 0x20,
        "backspace" => 0xff08,
        "delete" => 0xffff,
        "up" | "arrow_up" | "arrowup" => 0xff52,
        "down" | "arrow_down" | "arrowdown" => 0xff54,
        "left" | "arrow_left" | "arrowleft" => 0xff51,
        "right" | "arrow_right" | "arrowright" => 0xff53,
        "home" => 0xff50,
        "end" => 0xff57,
        "pageup" | "page_up" => 0xff55,
        "pagedown" | "page_down" => 0xff56,
        "capslock" | "caps_lock" => 0xffe5,
        s if s.starts_with('f') && s[1..].parse::<i32>().is_ok_and(|n| (1..=12).contains(&n)) => {
            0xffbd + s[1..].parse::<i32>().unwrap()
        }
        s if s.chars().count() == 1 => character_keysym(s.chars().next().unwrap()),
        _ => return Err(format!("[INVALID_KEY] Unknown key {key}")),
    })
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn implicit_owner_never_enables_legacy_capture() {
        assert!(!portal_required(false, "idle", false));
        for state in ["starting", "active", "stopping", "stopped", "failed"] {
            assert!(portal_required(false, state, false));
        }
        assert!(portal_required(false, "idle", true));
        assert!(portal_required(true, "idle", false));
    }
    #[test]
    fn xwayland_does_not_authorize_x11_desktop_input() {
        assert_eq!(
            classify_display(Some("wayland"), Some("wayland-0"), Some(":0")),
            DisplaySession::Wayland
        );
        assert_eq!(
            classify_display(None, Some("wayland-0"), Some(":0")),
            DisplaySession::Wayland
        );
        assert_eq!(
            classify_display(Some("x11"), None, Some(":0")),
            DisplaySession::X11
        );
        assert_eq!(
            classify_display(Some("tty"), None, Some(":0")),
            DisplaySession::Unavailable
        );
        assert_eq!(
            classify_display(None, None, None),
            DisplaySession::Unavailable
        );
    }
    #[test]
    fn text_uses_unicode_keysyms_and_control_keys() {
        assert_eq!(character_keysym('A'), 0x41);
        assert_eq!(character_keysym('\u{4e2d}'), 0x01004e2d);
        assert_eq!(character_keysym('\n'), 0xff0d);
        assert_eq!(character_keysym('\t'), 0xff09);
    }
    #[test]
    fn unknown_buttons_and_keys_are_rejected_before_input() {
        assert!(button_code("back").is_err());
        assert!(key_keysym("unrecognized").is_err());
        assert!(key_keysym("f13").is_err());
        assert_eq!(key_keysym("Control").unwrap(), 0xffe3);
        assert_eq!(key_keysym("F12").unwrap(), 0xffc9);
        assert_eq!(button_code("middle").unwrap(), 274);
    }
}
