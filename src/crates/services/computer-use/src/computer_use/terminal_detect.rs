#![allow(dead_code)]

//! Cross-platform terminal-emulator detection for terminal-safe typing.
//!
//! Terminal emulators (Ghostty, iTerm2, Terminal.app, Windows Terminal,
//! mintty, GVim, ...) silently drop text sent through the accessibility /
//! UIAutomation text channel: they expose a text area for their grid, but an
//! `AXSelectedText` / `ValuePattern` write never reaches the underlying pty
//! or input buffer, so a `type_text` call reports success while the shell
//! sees nothing. The same applies to GVim, which ignores programmatic text
//! insertion via the accessibility channel.
//!
//! This module mirrors cua-driver-rs's terminal-detection contract
//! (`platform-macos/src/terminal.rs`) and OpenBitFun's existing macOS pid-based
//! lookup (`macos_bg_input::is_terminal_emulator`): a small, explicit list of
//! known terminal identifiers per platform. When the target matches, callers
//! should skip the AX/UIA text path and route to key-event synthesis instead
//! — see [`TerminalRoute`].
//!
//! Detection here is **pure string matching** — it takes the app name /
//! bundle id / window class as strings instead of resolving a pid — so it
//! compiles and is unit-testable on every platform without `#[cfg]` gates.
//! The platform string passed to [`route_for_type_text`] selects which
//! identifier set is consulted. This makes it usable from platform-agnostic
//! dispatch code and from tests; the macOS-specific pid → bundle-id
//! resolution continues to live in `macos_bg_input`.

use log::debug;

/// Which delivery path a `type_text` call should take for a given target.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub(super) enum TerminalRoute {
    /// Normal accessibility / UIAutomation text channel
    /// (`AXSetAttribute(kAXSelectedText)` on macOS, `ValuePattern.SetValue`
    /// on Windows). Use for standard text views that honour programmatic
    /// text insertion.
    AxText,
    /// Fallback to per-keystroke key-event synthesis. Required for terminal
    /// emulators and GVim, which silently drop AX/UIA text writes.
    KeyEvent,
}

/// Lowercased name keywords for macOS terminal emulators. Matched via
/// `contains` against the lowercased app name (and, as a fallback, the
/// lowercased bundle id) so newly-shipped bundles whose app name contains a
/// known terminal word are still caught.
const MACOS_TERMINAL_NAME_KEYWORDS: &[&str] = &[
    "alacritty",
    "ghostty",
    "hyper",
    "iterm",
    "kitty",
    "kreyg",
    "tabby",
    "terminal",
    "warp",
    "wezterm",
];

/// Bundle identifiers of macOS terminal emulators where the AX value-set is
/// known to be silently dropped. Stored lowercased and compared (exact) against
/// the lowercased bundle id, so callers that already lower-case the id still
/// match. Union of the cua-driver-rs list and OpenBitFun's existing
/// `macos_bg_input::TERMINAL_BUNDLE_IDS`.
const MACOS_TERMINAL_BUNDLE_IDS: &[&str] = &[
    "co.zeit.hyper",                 // Hyper
    "com.apple.terminal",            // Apple Terminal.app
    "com.github.wez.wezterm",        // WezTerm (cua id)
    "com.googlecode.iterm2",         // iTerm2
    "com.kitty",                     // kitty (OpenBitFun id)
    "com.mitchellh.ghostty",         // Ghostty
    "com.neovide.neovide",           // Neovide
    "com.todesktop.230313mzl4w4u92", // Warp (ToDesktop build)
    "dev.warp.warp-stable",          // Warp (cua id)
    "dev.zed.zed.helper",            // Zed embedded terminal helper
    "io.alacritty",                  // Alacritty (newer id)
    "io.wez.wezterm",                // WezTerm (OpenBitFun id)
    "net.kovidgoyal.kitty",          // kitty (cua id)
    "org.alacritty",                 // Alacritty (older id)
];

/// Lowercased WM_CLASS (X11) / window-class (Windows) identifiers for
/// terminal emulators and GVim. Matched via `contains` against the lowercased
/// class name, so values like `gnome-terminal-server` match `gnome-terminal`.
///
/// `wt` is the Windows Terminal launch-executable short name and is
/// intentionally short — callers should pass the real window class / process
/// name, not an arbitrary substring.
const TERMINAL_WINDOW_CLASS_KEYWORDS: &[&str] = &[
    "alacritty",
    "gnome-terminal",
    "gvim",
    "konsole",
    "kitty",
    "mintty",
    "terminal",
    "urxvt",
    "windows terminal",
    "wt",
    "xterm",
];

/// Returns `true` when the macOS target is a known terminal emulator.
///
/// `app_name` is lowercased and matched (substring) against
/// [`MACOS_TERMINAL_NAME_KEYWORDS`]. `bundle_id`, when supplied, is
/// lowercased and matched exactly against [`MACOS_TERMINAL_BUNDLE_IDS`],
/// then — as a fallback — matched (substring) against the name keywords so a
/// bundle id that contains a known terminal word (e.g. `com.mitchellh.ghostty`
/// contains `ghostty`) is still flagged even if its exact id is not listed.
///
/// A hit on either signal flags the target so the caller routes past the AX
/// text channel to key-event synthesis. This mirrors the existing
/// `macos_bg_input::is_terminal_emulator` contract but operates on strings
/// instead of a pid, so it is usable from platform-agnostic dispatch code.
pub(super) fn is_terminal_emulator(app_name: &str, bundle_id: Option<&str>) -> bool {
    let name_lc = app_name.to_ascii_lowercase();
    let bundle_lc = bundle_id.map(|b| b.to_ascii_lowercase());

    let name_hit = MACOS_TERMINAL_NAME_KEYWORDS
        .iter()
        .any(|kw| !kw.is_empty() && name_lc.contains(kw));

    let bundle_hit = bundle_lc
        .as_deref()
        .map(|b| {
            MACOS_TERMINAL_BUNDLE_IDS.contains(&b)
                || MACOS_TERMINAL_NAME_KEYWORDS
                    .iter()
                    .any(|kw| !kw.is_empty() && b.contains(kw))
        })
        .unwrap_or(false);

    if name_hit || bundle_hit {
        debug!(
            "terminal_detect: macOS target is a terminal emulator \
             (app_name={:?}, bundle_id={:?})",
            app_name, bundle_id
        );
        true
    } else {
        false
    }
}

/// Returns `true` when the Linux/Windows window class names a known terminal
/// emulator or text widget that silently drops accessibility text writes.
///
/// `class_name` is the X11 `WM_CLASS` instance (Linux) or the Win32 window
/// class / process name (Windows). It is lowercased and matched (substring)
/// against [`TERMINAL_WINDOW_CLASS_KEYWORDS`]. Substring matching lets
/// `gnome-terminal-server` match `gnome-terminal` and `Alacritty` match
/// `alacritty`.
pub(super) fn is_terminal_window_class(class_name: &str) -> bool {
    let class_lc = class_name.to_ascii_lowercase();
    let hit = TERMINAL_WINDOW_CLASS_KEYWORDS
        .iter()
        .any(|kw| !kw.is_empty() && class_lc.contains(kw));
    if hit {
        debug!(
            "terminal_detect: window class {:?} is a terminal emulator",
            class_name
        );
    }
    hit
}

/// Decide the [`TerminalRoute`] for a `type_text` call from the target's
/// platform, app name, and (macOS) bundle id.
///
/// `platform` is the lowercased OS string (`"macos"`, `"windows"`, `"linux"`).
/// On macOS, `app_name` is the app's localized name and `bundle_id` its
/// reverse-DNS bundle id. On Windows/Linux, `app_name` carries the window
/// class / process name (the value that [`is_terminal_window_class`] expects)
/// and `bundle_id` is ignored. Unknown platforms default to
/// [`TerminalRoute::AxText`] so unaffected surfaces keep their normal text
/// channel rather than silently degrading.
pub(super) fn route_for_type_text(
    app_name: &str,
    bundle_id: Option<&str>,
    platform: &str,
) -> TerminalRoute {
    let is_terminal = match platform.to_ascii_lowercase().as_str() {
        "macos" => is_terminal_emulator(app_name, bundle_id),
        "windows" | "linux" => is_terminal_window_class(app_name),
        _ => false,
    };
    if is_terminal {
        debug!(
            "terminal_detect: routing type_text to key-event synthesis \
             (platform={}, app_name={:?}, bundle_id={:?})",
            platform, app_name, bundle_id
        );
        TerminalRoute::KeyEvent
    } else {
        TerminalRoute::AxText
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    // ── macOS: name keywords ───────────────────────────────────────────────

    #[test]
    fn macos_matches_documented_name_keywords() {
        for kw in MACOS_TERMINAL_NAME_KEYWORDS {
            // Capitalise the first letter to mimic a real app name and confirm
            // the lowercasing inside is_terminal_emulator normalises it.
            let name = format!(
                "{}{}",
                kw.chars()
                    .next()
                    .unwrap()
                    .to_uppercase()
                    .collect::<String>(),
                &kw[1..]
            );
            assert!(
                is_terminal_emulator(&name, None),
                "name keyword {kw:?} (as {name:?}) must match"
            );
        }
    }

    #[test]
    fn macos_name_match_is_case_insensitive() {
        assert!(is_terminal_emulator("Ghostty", None));
        assert!(is_terminal_emulator("GHOSTTY", None));
        assert!(is_terminal_emulator("iTerm2", None));
        assert!(is_terminal_emulator("ITERM", None));
        assert!(is_terminal_emulator("Apple Terminal", None));
    }

    #[test]
    fn macos_name_match_is_substring() {
        // "Terminal" is a substring of these real-looking names.
        assert!(is_terminal_emulator("Terminal", None));
        assert!(is_terminal_emulator("Hyper Terminal", None));
        assert!(is_terminal_emulator(
            "Warp — The Agentic Development Environment",
            None
        ));
    }

    // ── macOS: bundle ids ──────────────────────────────────────────────────

    #[test]
    fn macos_matches_documented_bundle_ids() {
        for bid in MACOS_TERMINAL_BUNDLE_IDS {
            assert!(
                is_terminal_emulator("", Some(bid)),
                "bundle id {bid:?} must match"
            );
        }
    }

    #[test]
    fn macos_bundle_match_is_case_insensitive() {
        // The stored ids are lowercased; mixed-case input must still match.
        assert!(is_terminal_emulator("", Some("com.apple.Terminal")));
        assert!(is_terminal_emulator("", Some("COM.APPLE.TERMINAL")));
        assert!(is_terminal_emulator("", Some("com.MitchellH.Ghostty")));
        assert!(is_terminal_emulator("", Some("com.googlecode.iTerm2")));
    }

    #[test]
    fn macos_bundle_falls_back_to_name_keyword() {
        // A bundle id not in the explicit list but containing a keyword still
        // matches via the name-keyword fallback.
        assert!(is_terminal_emulator("", Some("com.example.ghostty-fork")));
        assert!(is_terminal_emulator("", Some("org.unknown.iterm3")));
    }

    #[test]
    fn macos_rejects_non_terminal_apps() {
        for (name, bid) in [
            ("Safari", Some("com.apple.Safari")),
            ("TextEdit", Some("com.apple.TextEdit")),
            ("Finder", Some("com.apple.finder")),
            ("Google Chrome", Some("com.google.Chrome")),
            ("Visual Studio Code", Some("com.microsoft.VSCode")),
            ("Slack", Some("com.tinyspeck.slackmacgap")),
            ("", None),
            ("Notes", None),
        ] {
            assert!(
                !is_terminal_emulator(name, bid),
                "non-terminal (name={name:?}, bundle={bid:?}) must not match"
            );
        }
    }

    #[test]
    fn macos_ghostty_iterm_terminal_apple_all_present() {
        // Spot-check the trio called out in the bug report so the regression
        // that motivated this list can't quietly slip back out of the list.
        assert!(is_terminal_emulator(
            "Ghostty",
            Some("com.mitchellh.ghostty")
        ));
        assert!(is_terminal_emulator(
            "iTerm2",
            Some("com.googlecode.iterm2")
        ));
        assert!(is_terminal_emulator("Terminal", Some("com.apple.terminal")));
    }

    // ── Linux / Windows: window class ──────────────────────────────────────

    #[test]
    fn window_class_matches_documented_keywords() {
        for kw in TERMINAL_WINDOW_CLASS_KEYWORDS {
            assert!(
                is_terminal_window_class(kw),
                "keyword {kw:?} must match itself"
            );
        }
    }

    #[test]
    fn window_class_match_is_case_insensitive() {
        assert!(is_terminal_window_class("Alacritty"));
        assert!(is_terminal_window_class("ALACRITTY"));
        assert!(is_terminal_window_class("Gnome-Terminal-Server"));
        assert!(is_terminal_window_class("GVim"));
        assert!(is_terminal_window_class("Windows Terminal"));
    }

    #[test]
    fn window_class_match_is_substring() {
        assert!(is_terminal_window_class("gnome-terminal-server"));
        assert!(is_terminal_window_class("xterm.x86_64"));
        assert!(is_terminal_window_class("urxvt-256color"));
        assert!(is_terminal_window_class("mintty.exe"));
    }

    #[test]
    fn window_class_rejects_non_terminal_classes() {
        for class in [
            "Firefox",
            "Navigator",
            "QtApplication",
            "code.exe",
            "explorer.exe",
            "",
            "ChatWindow",
        ] {
            assert!(
                !is_terminal_window_class(class),
                "non-terminal class {class:?} must not match"
            );
        }
    }

    // ── route_for_type_text dispatch ───────────────────────────────────────

    #[test]
    fn route_macos_terminal_routes_to_key_events() {
        assert_eq!(
            route_for_type_text("Ghostty", Some("com.mitchellh.ghostty"), "macos"),
            TerminalRoute::KeyEvent
        );
        assert_eq!(
            route_for_type_text("iTerm2", Some("com.googlecode.iterm2"), "macos"),
            TerminalRoute::KeyEvent
        );
        assert_eq!(
            route_for_type_text("Terminal", Some("com.apple.Terminal"), "macOS"),
            TerminalRoute::KeyEvent
        );
    }

    #[test]
    fn route_macos_non_terminal_routes_to_ax_text() {
        assert_eq!(
            route_for_type_text("Safari", Some("com.apple.Safari"), "macos"),
            TerminalRoute::AxText
        );
        assert_eq!(
            route_for_type_text("TextEdit", Some("com.apple.TextEdit"), "macos"),
            TerminalRoute::AxText
        );
    }

    #[test]
    fn route_windows_terminal_routes_to_key_events() {
        assert_eq!(
            route_for_type_text("Windows Terminal", None, "windows"),
            TerminalRoute::KeyEvent
        );
        assert_eq!(
            route_for_type_text("mintty", None, "Windows"),
            TerminalRoute::KeyEvent
        );
        assert_eq!(
            route_for_type_text("wt", None, "windows"),
            TerminalRoute::KeyEvent
        );
    }

    #[test]
    fn route_linux_terminal_routes_to_key_events() {
        assert_eq!(
            route_for_type_text("gnome-terminal-server", None, "linux"),
            TerminalRoute::KeyEvent
        );
        assert_eq!(
            route_for_type_text("Alacritty", None, "Linux"),
            TerminalRoute::KeyEvent
        );
        assert_eq!(
            route_for_type_text("konsole", None, "linux"),
            TerminalRoute::KeyEvent
        );
    }

    #[test]
    fn route_linux_windows_non_terminal_routes_to_ax_text() {
        assert_eq!(
            route_for_type_text("Firefox", None, "linux"),
            TerminalRoute::AxText
        );
        assert_eq!(
            route_for_type_text("explorer.exe", None, "windows"),
            TerminalRoute::AxText
        );
    }

    #[test]
    fn route_unknown_platform_defaults_to_ax_text() {
        // Unknown platforms must not silently degrade to key-event synthesis.
        assert_eq!(
            route_for_type_text("Ghostty", Some("com.mitchellh.ghostty"), "haiku"),
            TerminalRoute::AxText
        );
        assert_eq!(
            route_for_type_text("Ghostty", Some("com.mitchellh.ghostty"), ""),
            TerminalRoute::AxText
        );
    }

    #[test]
    fn route_platform_string_is_case_insensitive() {
        assert_eq!(
            route_for_type_text("Ghostty", Some("com.mitchellh.ghostty"), "MACOS"),
            TerminalRoute::KeyEvent
        );
        assert_eq!(
            route_for_type_text("Alacritty", None, "LINUX"),
            TerminalRoute::KeyEvent
        );
        assert_eq!(
            route_for_type_text("mintty", None, "WINDOWS"),
            TerminalRoute::KeyEvent
        );
    }
}
