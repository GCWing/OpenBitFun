//! Native window policy. MiniApps customize the row, never system controls.

pub(crate) fn config() -> tauri::utils::config::WindowConfig {
    #[allow(unused_mut)]
    let mut config = tauri::utils::config::WindowConfig {
        label: "miniapp-shell".into(),
        url: tauri::WebviewUrl::External(
            "openbitfun-miniapp://localhost/index.html".parse().unwrap(),
        ),
        decorations: cfg!(target_os = "macos"),
        ..Default::default()
    };
    #[cfg(target_os = "macos")]
    {
        // Configure both the native Window and WebView, as the main app does.
        // Tao then restores AppKit's own buttons on resize/fullscreen changes.
        config.title_bar_style = tauri::TitleBarStyle::Overlay;
        config.hidden_title = true;
        config.traffic_light_position = macos::traffic_light_position();
    }
    config
}

#[cfg(target_os = "macos")]
pub(crate) async fn double_click(window: &tauri::WebviewWindow) -> Result<(), String> {
    let (send, receive) = tokio::sync::oneshot::channel();
    let native_window = window.clone();
    window
        .run_on_main_thread(move || {
            let result = native_window
                .ns_window()
                .map_err(|error| error.to_string())
                .map(|pointer| {
                    // SAFETY: Tauri owns the live NSWindow, and this closure
                    // runs on AppKit's main thread for the retained window.
                    let window = unsafe { &*pointer.cast::<objc2_app_kit::NSWindow>() };
                    macos::double_click(window);
                });
            let _ = send.send(result);
        })
        .map_err(|error| error.to_string())?;
    receive.await.map_err(|error| error.to_string())?
}

#[cfg(target_os = "macos")]
mod macos {
    use objc2::MainThreadMarker;
    use objc2_app_kit::{NSWindow, NSWindowButton, NSWindowStyleMask};
    use objc2_foundation::{NSRect, NSString, NSUserDefaults};

    fn toolbar_height() -> f64 {
        let tokens: serde_json::Value = serde_json::from_str(include_str!(
            "../../../../design-system/packages/design-tokens/src/system.tokens.json"
        ))
        .expect("Bundled design system tokens must be valid");
        tokens
            .pointer("/layout/toolbar/mdHeight/$value")
            .and_then(serde_json::Value::as_str)
            .and_then(|value| value.strip_suffix("px"))
            .and_then(|value| value.parse().ok())
            .expect("The native toolbar requires the design system height in logical pixels")
    }

    fn traffic_light_inset(row: f64, native_titlebar: f64, button: f64) -> f64 {
        // Tao measures this from the container bottom, not the button top.
        row / 2.0 + native_titlebar / 2.0 - button
    }

    pub(super) fn traffic_light_position() -> Option<tauri::utils::config::LogicalPosition> {
        let mtm = MainThreadMarker::new()?;
        let style = NSWindowStyleMask::Titled
            | NSWindowStyleMask::Closable
            | NSWindowStyleMask::Miniaturizable
            | NSWindowStyleMask::Resizable;
        let native_height = NSWindow::frameRectForContentRect_styleMask(NSRect::ZERO, style, mtm)
            .size
            .height;
        let button =
            NSWindow::standardWindowButton_forStyleMask(NSWindowButton::CloseButton, style, mtm)?;
        Some(tauri::utils::config::LogicalPosition {
            x: 12.0,
            y: traffic_light_inset(toolbar_height(), native_height, button.frame().size.height),
        })
    }

    pub(super) fn double_click(window: &NSWindow) {
        let action = NSUserDefaults::standardUserDefaults()
            .stringForKey(&NSString::from_str("AppleActionOnDoubleClick"))
            .map(|value| value.to_string());
        match action.as_deref() {
            Some("Minimize") => window.performMiniaturize(None),
            Some("None") => {}
            _ => window.performZoom(None),
        }
    }

    #[cfg(test)]
    mod tests {
        use super::*;

        #[test]
        fn native_button_center_matches_the_shared_toolbar() {
            for (native_titlebar, button) in [(22.0, 14.0), (28.0, 16.0)] {
                let inset = traffic_light_inset(toolbar_height(), native_titlebar, button);
                assert_eq!(
                    inset + button - native_titlebar / 2.0,
                    toolbar_height() / 2.0
                );
            }
        }
    }
}

#[cfg(test)]
mod tests {
    #[test]
    fn native_controls_follow_the_host_platform() {
        let config = super::config();
        assert_eq!(config.decorations, cfg!(target_os = "macos"));
        #[cfg(target_os = "macos")]
        {
            assert_eq!(config.title_bar_style, tauri::TitleBarStyle::Overlay);
            assert!(config.hidden_title);
        }
    }
}
