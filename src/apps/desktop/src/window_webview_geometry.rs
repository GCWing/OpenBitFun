//! Keep the main WebView's last usable bounds while Windows minimizes its host.
//!
//! Tauri's unstable multi-WebView autoresizer forwards the minimized client
//! rectangle (for example 215x26) through Wry's explicit set_bounds path, which
//! bypasses Wry's WM_SIZE/SIZE_MINIMIZED guard. Own only the main WebView resize
//! here; child browser previews retain their existing layout owners.

use tauri::Manager;

pub(crate) fn install(window: &tauri::WebviewWindow) -> Result<(), String> {
    let webview: &tauri::Webview = window.as_ref();
    webview
        .set_auto_resize(false)
        .map_err(|error| format!("Failed to disable main WebView autoresize: {error}"))
}

fn usable_size(
    minimized: bool,
    size: tauri::PhysicalSize<u32>,
) -> Option<tauri::PhysicalSize<u32>> {
    (!minimized && size.width > 0 && size.height > 0).then_some(size)
}

pub(crate) fn handle_event(window: &tauri::Window, event: &tauri::WindowEvent) {
    if window.label() != "main"
        || !matches!(
            event,
            tauri::WindowEvent::Resized(_) | tauri::WindowEvent::ScaleFactorChanged { .. }
        )
    {
        return;
    }
    // Read current host geometry, not a potentially stale queued event payload.
    // On query failure retain the last bounds rather than guessing a size.
    let result = (|| -> tauri::Result<()> {
        let minimized = window.is_minimized()?;
        if minimized {
            return Ok(());
        }
        let Some(size) = usable_size(minimized, window.inner_size()?) else {
            return Ok(());
        };
        if let Some(webview) = window.app_handle().get_webview("main") {
            webview.set_size(size)?;
        }
        Ok(())
    })();
    if let Err(error) = result {
        log::warn!("Failed to synchronize main WebView geometry: {error}");
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn minimize_restore_retains_last_usable_bounds() {
        let normal = tauri::PhysicalSize::new(2488, 1600);
        let mut bounds = normal;
        for (minimized, size) in [
            (true, tauri::PhysicalSize::new(215, 26)),
            (false, tauri::PhysicalSize::new(0, 0)),
        ] {
            if let Some(next) = usable_size(minimized, size) {
                bounds = next;
            }
            assert_eq!(bounds, normal);
        }
        let restored = tauri::PhysicalSize::new(1920, 1080);
        assert_eq!(usable_size(false, restored), Some(restored));
        // Small but legitimate non-minimized windows must not be size-clamped.
        let small = tauri::PhysicalSize::new(215, 26);
        assert_eq!(usable_size(false, small), Some(small));
    }
}
