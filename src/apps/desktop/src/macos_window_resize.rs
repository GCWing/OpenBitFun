//! Keep the main frontend on AppKit's synchronous resize path and release
//! frontend measurement batching when the native resize gesture ends.

mod backdrop;
mod geometry;

use std::{cell::RefCell, ptr::NonNull};

use block2::RcBlock;
use objc2::{rc::Retained, runtime::ProtocolObject, MainThreadMarker};
use objc2_app_kit::{NSWindow, NSWindowDidEndLiveResizeNotification, NSWindowOrderingMode};
use objc2_foundation::{NSNotification, NSNotificationCenter, NSObjectProtocol};
use tauri::{Emitter, Listener, Manager};

const BACKDROP_EVENT: &str = "window://scene-backdrop";

#[derive(serde::Deserialize)]
#[serde(rename_all = "camelCase")]
struct BackdropUpdate {
    version: u8,
    client_id: String,
    #[serde(default)]
    release: bool,
    surface: Option<backdrop::Surface>,
}

thread_local! {
    static OBSERVER: RefCell<Option<Retained<ProtocolObject<dyn NSObjectProtocol>>>> = const { RefCell::new(None) };
    static BACKDROP: RefCell<Option<(Retained<backdrop::SceneBackdrop>, Option<String>)>> = const { RefCell::new(None) };
}

pub(crate) fn reset_backdrop() {
    BACKDROP.with_borrow_mut(|state| {
        if let Some((view, client)) = state {
            view.clear();
            *client = None;
        }
    });
}

fn remove_observer() {
    OBSERVER.with_borrow_mut(|observer| {
        if let Some(token) = observer.take() {
            // SAFETY: The token was registered with this center on this thread.
            unsafe { NSNotificationCenter::defaultCenter().removeObserver(token.as_ref()) };
        }
    });
    BACKDROP.with_borrow_mut(|state| {
        if let Some((view, _)) = state.take() {
            view.removeFromSuperview();
        }
    });
}

pub(crate) fn install(target: &tauri::WebviewWindow) -> Result<(), String> {
    let _mtm = MainThreadMarker::new().ok_or("Resize observation requires the main thread")?;
    remove_observer();
    // On the main thread Tauri executes with_webview synchronously. Complete
    // native setup before disabling its queued proportional resize owner, and
    // keep Tauri calls outside the callback to avoid re-entering its view lock.
    let (sender, receiver) = std::sync::mpsc::sync_channel(1);
    target
        .with_webview(move |platform| {
            // SAFETY: Tauri supplies the live WKWebView on the AppKit main thread.
            let view = unsafe { &*platform.inner().cast::<objc2_app_kit::NSView>() };
            let result = geometry::follow_parent_bounds(view);
            if result.is_ok() {
                // Behind the frontend, above OS material; no input interception.
                if let Some(parent) = unsafe { view.superview() } {
                    let backdrop = backdrop::SceneBackdrop::new(MainThreadMarker::new().unwrap());
                    parent.addSubview_positioned_relativeTo(
                        &backdrop,
                        NSWindowOrderingMode::Below,
                        Some(view),
                    );
                    BACKDROP.with_borrow_mut(|state| *state = Some((backdrop, None)));
                }
            }
            let _ = sender.send(result);
        })
        .map_err(|error| error.to_string())?;
    receiver
        .try_recv()
        .map_err(|error| format!("Native resize setup did not complete: {error}"))?
        .map_err(str::to_owned)?;
    let webview: &tauri::Webview = target.as_ref();
    webview
        .set_auto_resize(false)
        .map_err(|error| format!("Failed to disable queued main WebView resizing: {error}"))?;

    let pointer = target.ns_window().map_err(|error| error.to_string())?;
    // SAFETY: Tauri owns this NSWindow and installation runs on the main thread.
    let window = unsafe { &*pointer.cast::<NSWindow>() };
    let handle = target.clone();
    let callback = RcBlock::new(move |_: NonNull<NSNotification>| {
        // Additive, controller-local notification. Older frontends ignore it;
        // newer frontends also work without it and never arm a native cover.
        if let Err(error) = handle.emit_to(
            "main",
            "window://resize-ended",
            serde_json::json!({ "version": 1 }),
        ) {
            log::warn!("Failed to emit native window resize completion: {error}");
        }
    });
    let token = unsafe {
        NSNotificationCenter::defaultCenter().addObserverForName_object_queue_usingBlock(
            Some(NSWindowDidEndLiveResizeNotification),
            Some(window),
            None,
            &callback,
        )
    };
    OBSERVER.with_borrow_mut(|observer| *observer = Some(token));
    let app = target.app_handle().clone();
    let backdrop_listener = target.listen(BACKDROP_EVENT, move |event| {
        let Ok(update) = serde_json::from_str::<BackdropUpdate>(event.payload()) else {
            return;
        };
        if update.version != 1 {
            return;
        }
        let _ = app.run_on_main_thread(move || {
            BACKDROP.with_borrow_mut(|state| {
                let Some((view, client)) = state else { return };
                if update.release {
                    if client.as_deref() == Some(&update.client_id) {
                        view.clear();
                        *client = None;
                    }
                } else {
                    *client = Some(update.client_id);
                    view.update(update.surface);
                    log::debug!(
                        "Native scene background updated: visible={}, frame={:?}",
                        !view.isHidden(),
                        view.frame()
                    );
                }
            })
        });
    });
    let app = target.app_handle().clone();
    target.on_window_event(move |event| {
        if matches!(event, tauri::WindowEvent::Destroyed) {
            app.unlisten(backdrop_listener);
            let _ = app.run_on_main_thread(remove_observer);
        }
    });
    Ok(())
}
