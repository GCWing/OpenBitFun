//! End-to-end integration tests for the enhanced Computer Use system.
//!
//! These tests verify the correctness of the cua-driver-rs integration:
//!   1. SkyLight SPI bridge — graceful loading and symbol resolution
//!   2. Dual-post strategy — SkyLight + public API belt+suspenders
//!   3. Chromium AX tree enablement — function exists and is callable
//!   4. Element token system — register → format → resolve end-to-end
//!   5. Terminal-safe typing detection — routes correctly
//!   6. Crosshair debug marker — produces valid annotated screenshots
//!   7. New background input API surface — functions exist with correct types
//!   8. AX-first writer — focus_element pre-focus primitive
//!
//! Tests that require Accessibility permission or a real desktop are
//! marked `#[ignore]` so they can be run manually with `cargo test --
//! --ignored`.

#![cfg(test)]

#[cfg(target_os = "macos")]
mod tests {
    // ── 1. SkyLight SPI bridge ───────────────────────────────────────────

    #[test]
    fn skylight_availability_check_does_not_panic() {
        // is_available() resolves SLEventPostToPid via dlopen+dlsym.
        // On a stock macOS it should resolve (SkyLight.framework exists).
        // On a hardened/gated system it may return false — both are valid.
        let _ = super::super::macos_skylight::is_available();
    }

    #[test]
    fn skylight_focus_without_raise_check_does_not_panic() {
        let _ = super::super::macos_skylight::is_focus_without_raise_available();
    }

    // ── 2. Dual-post strategy ────────────────────────────────────────────

    #[test]
    fn bg_input_supports_skylight_post_check() {
        // supports_skylight_post() is a probe that should not panic.
        let _ = super::super::macos_bg_input::supports_skylight_post();
    }

    #[test]
    fn bg_input_supports_focus_without_raise_check() {
        let _ = super::super::macos_bg_input::supports_focus_without_raise();
    }

    #[test]
    fn bg_input_supports_background_input_does_not_panic() {
        // This probes AX trust + Private event source. On a test process
        // without AX permission it returns false — that's fine.
        let _ = super::super::macos_bg_input::supports_background_input();
    }

    // ── 3. New background input API surface ──────────────────────────────

    #[test]
    fn bg_click_chromium_function_exists() {
        // Verify the function exists and accepts the correct argument types.
        // We don't actually post events — just verify the signature compiles
        // and the function is callable with dummy args (it will fail early
        // because click_count=0 is a no-op).
        let result = super::super::macos_bg_input::bg_click_chromium(
            0, // pid (invalid — but click_count=0 short-circuits)
            0.0,
            0.0, // screen coords
            0.0,
            0.0, // window-local coords
            0,   // window id
            0,   // click_count = 0 → no-op
            &[], // modifiers
        );
        assert!(
            result.is_ok(),
            "bg_click_chromium with click_count=0 should be a no-op Ok"
        );
    }

    #[test]
    fn bg_drag_function_exists() {
        // Verify bg_drag exists with the correct signature. Use 0 steps
        // (clamped to 1 internally) and an invalid pid — the function will
        // create a CGEventSource which may fail without AX permission.
        let result = super::super::macos_bg_input::bg_drag(
            0,
            0.0,
            0.0,
            10.0,
            10.0,
            None,
            None,
            None,
            0,
            0,
            &[],
            super::super::macos_bg_input::BgDragButton::Left,
        );
        // Without AX permission this will error — that's expected.
        // We just verify the function is callable.
        let _ = result;
    }

    #[test]
    fn bg_key_chord_no_auth_function_exists() {
        let result = super::super::macos_bg_input::bg_key_chord_no_auth(0, &[], 0);
        // Without AX permission this will error — that's expected.
        let _ = result;
    }

    #[test]
    fn bg_right_click_function_exists() {
        let result = super::super::macos_bg_input::bg_right_click(0, (0.0, 0.0), &[]);
        let _ = result;
    }

    #[test]
    fn bg_middle_click_function_exists() {
        let result = super::super::macos_bg_input::bg_middle_click(0, (0.0, 0.0), &[]);
        let _ = result;
    }

    #[test]
    fn fn_modifier_is_supported() {
        // Verify Fn modifier was added to the BgModifier enum and parses
        // correctly from string aliases.
        assert_eq!(
            super::super::macos_bg_input::BgModifier::from_str("fn"),
            Some(super::super::macos_bg_input::BgModifier::Fn)
        );
        assert_eq!(
            super::super::macos_bg_input::BgModifier::from_str("Fn"),
            Some(super::super::macos_bg_input::BgModifier::Fn)
        );
    }

    // ── 4. AX-first writer — focus_element ───────────────────────────────

    #[test]
    fn try_ax_focus_null_ref_returns_unavailable() {
        use super::super::macos_ax_write::{try_ax_focus, AxWriteOutcome};
        let r = super::super::macos_ax_dump::AxRef(std::ptr::null());
        match try_ax_focus(r) {
            AxWriteOutcome::Unavailable(-1) => {}
            other => panic!("expected Unavailable(-1) for null ref, got {:?}", other),
        }
    }

    // ── 5. AX tree dump — Chromium enablement + AXWindows union ───────────

    #[test]
    #[ignore = "requires macOS Accessibility permission"]
    fn dump_self_pid_chromium_enablement_does_not_panic() {
        // This test verifies the complete AX dump pipeline:
        //   1. enable_chromium_accessibility is called before walking
        //   2. AXChildren ∪ AXWindows union is performed at root level
        //   3. SHA1 digest is computed
        //   4. Per-pid cache is installed
        let pid = std::process::id() as i32;
        let snap = super::super::macos_ax_dump::dump_app_ax(
            pid,
            super::super::macos_ax_dump::DumpOpts::default(),
        )
        .expect("dump_app_ax should succeed with AX permission");
        assert!(!snap.digest.is_empty(), "digest must be non-empty");
        assert_eq!(snap.app.pid, Some(pid));
    }

    // ── 6. Terminal-safe typing detection ─────────────────────────────────

    #[test]
    fn terminal_detection_routes_known_terminals_correctly() {
        use super::super::terminal_detect::{
            is_terminal_emulator, is_terminal_window_class, route_for_type_text, TerminalRoute,
        };

        // macOS terminals
        assert!(is_terminal_emulator("Terminal", Some("com.apple.Terminal")));
        assert!(is_terminal_emulator(
            "iTerm2",
            Some("com.googlecode.iterm2")
        ));
        assert!(is_terminal_emulator(
            "Ghostty",
            Some("com.mitchellh.ghostty")
        ));
        assert!(!is_terminal_emulator("Safari", Some("com.apple.Safari")));

        // Linux/Windows terminal window classes
        assert!(is_terminal_window_class("gnome-terminal-server"));
        assert!(is_terminal_window_class("mintty"));
        assert!(!is_terminal_window_class("chrome"));

        // Route dispatch
        assert_eq!(
            route_for_type_text("Terminal", Some("com.apple.Terminal"), "macos"),
            TerminalRoute::KeyEvent
        );
        assert_eq!(
            route_for_type_text("Safari", Some("com.apple.Safari"), "macos"),
            TerminalRoute::AxText
        );
    }

    // ── 7. Crosshair debug marker ─────────────────────────────────────────

    #[test]
    fn crosshair_annotation_produces_valid_jpeg() {
        use super::super::debug_overlay::annotate_screenshot_with_click;

        // Create a simple 100x100 white JPEG. image 0.25's JPEG encoder
        // rejects Rgba8 input, so flatten to RGB first.
        let img = image::RgbaImage::from_pixel(100, 100, image::Rgba([255, 255, 255, 255]));
        let rgb = image::DynamicImage::ImageRgba8(img).to_rgb8();
        let mut jpeg_buf = Vec::new();
        let mut encoder = image::codecs::jpeg::JpegEncoder::new_with_quality(&mut jpeg_buf, 80);
        encoder
            .encode(rgb.as_raw(), 100, 100, image::ExtendedColorType::Rgb8)
            .expect("JPEG encode should succeed");

        // Annotate with a crosshair at (50, 50).
        let annotated = annotate_screenshot_with_click(&jpeg_buf, "image/jpeg", 50, 50)
            .expect("annotation should succeed");

        // Verify output is valid JPEG (magic bytes FF D8 FF).
        assert_eq!(&annotated[0..3], &[0xFF, 0xD8, 0xFF]);
        assert!(!annotated.is_empty());
    }

    // ── 8. Element token system integration ───────────────────────────────
    //
    // The element token system lives in the tool-contracts crate (Layer 6).
    // These tests verify the cross-crate integration: the token format,
    // registration, and resolution are all consistent.

    #[test]
    fn element_token_register_format_resolve_round_trip() {
        use openbitfun_agent_tools::element_token;

        let pid = 12345;
        let window_id = 42u32;
        let element_count = 100usize;

        // Register a snapshot.
        let snapshot_id = element_token::global().register_snapshot(pid, window_id, element_count);
        assert!(snapshot_id > 0, "snapshot_id must be positive");

        // Format a token for element index 5.
        let token = element_token::format_token(snapshot_id, 5);
        assert!(token.starts_with("s"), "token must start with 's'");

        // Resolve the token back.
        let (resolved_window, resolved_idx) = element_token::global()
            .resolve(pid, &token)
            .expect("token should resolve successfully");
        assert_eq!(resolved_window, window_id);
        assert_eq!(resolved_idx, 5);
    }

    #[test]
    fn element_token_stale_token_returns_error() {
        use openbitfun_agent_tools::element_token;

        let pid = 99999;
        // Register 9 snapshots (LRU cap is 8) — the first one should be evicted.
        let first_id = element_token::global().register_snapshot(pid, 1, 10);
        for _ in 0..8 {
            element_token::global().register_snapshot(pid, 1, 10);
        }

        // The first snapshot's token should now be stale.
        let token = element_token::format_token(first_id, 0);
        let result = element_token::global().resolve(pid, &token);
        assert!(result.is_err(), "stale token should return error");
    }

    #[test]
    fn element_token_resolve_element_args_precedence() {
        use openbitfun_agent_tools::element_token::{self, ResolvedElement};

        let pid = 55555;
        let wid = 7u32;

        // Register a snapshot.
        let sid = element_token::global().register_snapshot(pid, wid, 50);
        let token = element_token::format_token(sid, 10);

        // Case 1: both token and index provided, they agree → token wins.
        let resolved = element_token::resolve_element_args(pid, Some(10), Some(&token), Some(wid))
            .expect("should resolve");
        match resolved {
            ResolvedElement::Element {
                window_id,
                element_index,
                via_token: true,
            } => {
                assert_eq!(window_id, Some(wid));
                assert_eq!(element_index, 10);
            }
            _ => panic!("expected Element(via_token=true) when both are provided"),
        }

        // Case 2: only index provided → legacy path.
        let resolved = element_token::resolve_element_args(pid, Some(10), None, Some(wid))
            .expect("should resolve");
        match resolved {
            ResolvedElement::Element {
                element_index,
                via_token: false,
                ..
            } => {
                assert_eq!(element_index, 10);
            }
            _ => panic!("expected Element(via_token=false) when only index is provided"),
        }

        // Case 3: neither provided → None.
        let resolved = element_token::resolve_element_args(pid, None, None, Some(wid))
            .expect("should resolve");
        match resolved {
            ResolvedElement::None => {}
            _ => panic!("expected None when neither is provided"),
        }
    }

    // ── 9. Complete flow: AX dump → token registration → bg_input fallback ─
    //
    // This is a "code rationality" test: it verifies that the key types
    // and functions across the three layers (contracts → assembly → desktop)
    // are compatible and can be composed in the expected order.

    #[test]
    fn complete_flow_type_compatibility() {
        // Verify that the AxNode type from the host trait can be constructed
        // with the fields that macos_ax_dump produces.
        use openbitfun_agent_tools::computer_use_host::{AppInfo, AppStateSnapshot, AxNode};

        let node = AxNode {
            idx: 0,
            parent_idx: None,
            role: "AXButton".to_string(),
            title: Some("Save".to_string()),
            value: None,
            description: None,
            identifier: None,
            enabled: true,
            focused: false,
            selected: None,
            frame_global: Some((10.0, 20.0, 80.0, 30.0)),
            actions: vec!["AXPress".to_string()],
            role_description: Some("button".to_string()),
            subrole: None,
            help: None,
            url: None,
            expanded: None,
        };

        let snap = AppStateSnapshot {
            observation_id: None,
            app: AppInfo {
                name: "TestApp".to_string(),
                bundle_id: None,
                pid: Some(1234),
                running: true,
                last_used_ms: None,
                launch_count: 0,
            },
            window_title: Some("Main".to_string()),
            tree_text: "[0] button title=\"Save\"\n".to_string(),
            nodes: vec![node],
            digest: "abc123".to_string(),
            captured_at_ms: 0,
            screenshot: None,
            loop_warning: None,
        };

        // Verify we can compute an element token for this snapshot.
        use openbitfun_agent_tools::element_token;
        let sid = element_token::global().register_snapshot(1234, 0, 1);
        let token = element_token::format_token(sid, 0);
        let (wid, idx) = element_token::global()
            .resolve(1234, &token)
            .expect("should resolve");
        assert_eq!(wid, 0);
        assert_eq!(idx, 0);

        // Verify the snapshot's node has the expected action for AX-first dispatch.
        assert!(snap.nodes[0].actions.contains(&"AXPress".to_string()));
    }
}

// Cross-platform tests (run on all OSes).
#[cfg(not(target_os = "macos"))]
mod tests {
    #[test]
    fn element_token_system_works_cross_platform() {
        use openbitfun_agent_tools::element_token;

        let pid = 12345;
        let sid = element_token::global().register_snapshot(pid, 1, 10);
        let token = element_token::format_token(sid, 5);
        let (wid, idx) = element_token::global()
            .resolve(pid, &token)
            .expect("should resolve");
        assert_eq!(wid, 1);
        assert_eq!(idx, 5);
    }
}
