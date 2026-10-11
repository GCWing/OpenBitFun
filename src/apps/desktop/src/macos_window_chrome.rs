//! Main-window chrome follows AppKit's transition phases, not the final resize.

use std::cell::RefCell;
use std::ptr::NonNull;

use block2::RcBlock;
use objc2::rc::Retained;
use objc2::runtime::ProtocolObject;
use objc2::MainThreadMarker;
use objc2_app_kit::{
    NSAnimationContext, NSButton, NSWindow, NSWindowButton, NSWindowDidEnterFullScreenNotification,
    NSWindowDidExitFullScreenNotification, NSWindowStyleMask,
    NSWindowWillEnterFullScreenNotification, NSWindowWillExitFullScreenNotification,
};
use objc2_foundation::{NSNotification, NSNotificationCenter, NSObjectProtocol, NSRect};
use tauri::{Emitter, Listener, Manager};

const FULLSCREEN_CHROME_EVENT: &str = "window://fullscreen-chrome";
const FULLSCREEN_CHROME_HANDOFF: &str = "window://fullscreen-chrome-handoff";

#[derive(Clone, Copy, Default, PartialEq, serde::Serialize)]
#[serde(rename_all = "camelCase")]
enum FullscreenPhase {
    Entering,
    Fullscreen,
    Exiting,
    #[default]
    Windowed,
}

#[derive(Default)]
struct Handoff {
    phase: FullscreenPhase,
    transition_id: u64,
    client_id: Option<String>,
    awaiting_paint: bool,
}

impl Handoff {
    fn transition(&mut self, phase: FullscreenPhase) {
        if matches!(phase, FullscreenPhase::Entering | FullscreenPhase::Exiting) {
            self.transition_id += 1;
            self.awaiting_paint = phase == FullscreenPhase::Exiting && self.client_id.is_some();
        }
        self.phase = phase;
    }

    fn settle(&mut self, client_id: &str, transition_id: u64) {
        if self.client_id.as_deref() == Some(client_id) && self.transition_id == transition_id {
            self.awaiting_paint = false;
        }
    }

    fn suppress_buttons(&self) -> bool {
        self.client_id.is_some() && (self.phase == FullscreenPhase::Exiting || self.awaiting_paint)
    }
}

#[derive(serde::Deserialize)]
#[serde(
    tag = "kind",
    rename_all = "camelCase",
    rename_all_fields = "camelCase"
)]
enum FrontendMessage {
    Ready {
        client_id: String,
    },
    Settled {
        client_id: String,
        transition_id: u64,
    },
    Unready {
        client_id: String,
    },
}

#[derive(Clone, serde::Serialize)]
#[serde(rename_all = "camelCase")]
struct ChromeUpdate {
    phase: FullscreenPhase,
    transition_id: u64,
    requires_ack: bool,
}

#[derive(Default)]
struct NativeChrome {
    handoff: Handoff,
    window: Option<Retained<NSWindow>>,
    hidden_buttons: Vec<(Retained<NSButton>, f64)>,
    #[cfg(debug_assertions)]
    last_button_geometry: Option<(u64, f64)>,
}

impl NativeChrome {
    #[cfg(debug_assertions)]
    fn trace_geometry(&mut self) {
        if self.handoff.phase != FullscreenPhase::Windowed {
            return;
        }
        let Some(window) = &self.window else {
            return;
        };
        let Some(button) = window.standardWindowButton(NSWindowButton::CloseButton) else {
            return;
        };
        let bounds = button.bounds();
        let point = button.convertPoint_toView(
            objc2_foundation::NSPoint::new(bounds.size.width / 2.0, bounds.size.height / 2.0),
            None,
        );
        let center = window.frame().size.height - point.y;
        let geometry = (self.handoff.transition_id, center);
        if self.last_button_geometry != Some(geometry) {
            log::debug!(
                "Native chrome geometry: transition_id={}, button_center={center}, row_center={}, suppressed={}",
                self.handoff.transition_id,
                toolbar_height() / 2.0,
                self.handoff.suppress_buttons()
            );
            self.last_button_geometry = Some(geometry);
        }
    }

    fn sync_buttons(&mut self) {
        if self.handoff.suppress_buttons() {
            if let Some(window) = &self.window {
                for kind in [
                    NSWindowButton::CloseButton,
                    NSWindowButton::MiniaturizeButton,
                    NSWindowButton::ZoomButton,
                ] {
                    if let Some(button) = window.standardWindowButton(kind) {
                        if !self
                            .hidden_buttons
                            .iter()
                            .any(|(hidden, _)| std::ptr::eq(&**hidden, &*button))
                        {
                            let alpha = button.alphaValue();
                            self.hidden_buttons.push((button, alpha));
                        }
                    }
                }
            }
            for (button, _) in &self.hidden_buttons {
                // AppKit owns isHidden during fullscreen. Keep our suppression
                // separate so its titlebar restoration cannot reveal these early.
                button.setAlphaValue(0.0);
            }
        } else {
            for (button, alpha) in self.hidden_buttons.drain(..) {
                button.setAlphaValue(alpha);
            }
        }
    }

    fn emit(&self, target: &tauri::WebviewWindow) {
        // Older editable frontends still receive the original string payload.
        let result = if self.handoff.client_id.is_some() {
            target.emit_to(
                target.label(),
                FULLSCREEN_CHROME_EVENT,
                ChromeUpdate {
                    phase: self.handoff.phase,
                    transition_id: self.handoff.transition_id,
                    requires_ack: self.handoff.awaiting_paint,
                },
            )
        } else {
            target.emit_to(target.label(), FULLSCREEN_CHROME_EVENT, self.handoff.phase)
        };
        if let Err(error) = result {
            log::warn!("Failed to emit native fullscreen chrome phase: {error}");
        }
    }
}

// AppKit objects stay on the main thread. Removing the observations on window
// destruction also releases the blocks and their WebviewWindow handles.
thread_local! {
    static OBSERVERS: RefCell<Vec<Retained<ProtocolObject<dyn NSObjectProtocol>>>> = const { RefCell::new(Vec::new()) };
    static CHROME: RefCell<NativeChrome> = RefCell::new(NativeChrome::default());
}

pub(crate) fn reset_renderer(app: &tauri::AppHandle) {
    let _ = app.run_on_main_thread(|| {
        CHROME.with_borrow_mut(|chrome| {
            chrome.handoff.client_id = None;
            chrome.handoff.awaiting_paint = false;
            chrome.sync_buttons();
        })
    });
}

fn remove_observers() {
    let center = NSNotificationCenter::defaultCenter();
    OBSERVERS.with_borrow_mut(|observers| {
        for observer in observers.drain(..) {
            // SAFETY: Tokens came from this notification center on this thread.
            unsafe { center.removeObserver((*observer).as_ref()) };
        }
    });
    CHROME.with_borrow_mut(|chrome| {
        chrome.handoff.client_id = None;
        chrome.sync_buttons();
        *chrome = NativeChrome::default();
    });
}

// The same shared design token drives the Web UI row and native inset. Keep
// geometry in the framework's existing title/resize/fullscreen lifecycle; never
// move AppKit's private titlebar containers from our notification callbacks.
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

fn traffic_light_inset(row_height: f64, native_titlebar_height: f64, button_height: f64) -> f64 {
    // Tao's inset is measured from the container bottom, not the button top.
    // Its button center is inset + buttonHeight - nativeTitlebarHeight / 2.
    row_height / 2.0 + native_titlebar_height / 2.0 - button_height
}

pub(crate) fn traffic_light_position() -> Option<tauri::utils::config::LogicalPosition> {
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

fn without_animation(action: impl FnOnce()) {
    NSAnimationContext::beginGrouping();
    let context = NSAnimationContext::currentContext();
    context.setDuration(0.0);
    context.setAllowsImplicitAnimation(false);
    action();
    NSAnimationContext::endGrouping();
}

pub(crate) fn install(window: &tauri::WebviewWindow) -> Result<(), String> {
    let _mtm =
        MainThreadMarker::new().ok_or("Window chrome must be installed on the main thread")?;
    let native_window = window.ns_window().map_err(|error| error.to_string())?;
    // SAFETY: Tauri owns this live NSWindow; observations are scoped to it and
    // removed on destruction. AppKit posts these notifications on the main thread.
    let native_window = unsafe { &*native_window.cast::<NSWindow>() };
    remove_observers();
    CHROME.with_borrow_mut(|chrome| {
        // SAFETY: The live Tauri window is retained only on the main thread.
        chrome.window =
            unsafe { Retained::retain(native_window as *const NSWindow as *mut NSWindow) };
    });
    let center = NSNotificationCenter::defaultCenter();
    // SAFETY: These immutable notification names are provided by AppKit.
    let notifications = unsafe {
        [
            (
                NSWindowWillEnterFullScreenNotification,
                FullscreenPhase::Entering,
            ),
            (
                NSWindowDidEnterFullScreenNotification,
                FullscreenPhase::Fullscreen,
            ),
            (
                NSWindowWillExitFullScreenNotification,
                FullscreenPhase::Exiting,
            ),
            (
                NSWindowDidExitFullScreenNotification,
                FullscreenPhase::Windowed,
            ),
        ]
    };
    for (name, phase) in notifications {
        let target = window.clone();
        let callback = RcBlock::new(move |_: NonNull<NSNotification>| {
            CHROME.with_borrow_mut(|chrome| {
                chrome.handoff.transition(phase);
                // Synchronous with AppKit, before asynchronous WebKit delivery.
                // Keep controls suppressed through BOTH native exit and paint.
                without_animation(|| chrome.sync_buttons());
                log::debug!(
                    "Native fullscreen chrome: transition_id={}, suppressed={}, awaiting_paint={}",
                    chrome.handoff.transition_id,
                    chrome.handoff.suppress_buttons(),
                    chrome.handoff.awaiting_paint
                );
                chrome.emit(&target);
            });
        });
        // SAFETY: The filter is the live main NSWindow. The block captures only
        // a Send + Sync Tauri handle; queue=None delivers on the posting thread.
        let observer = unsafe {
            center.addObserverForName_object_queue_usingBlock(
                Some(name),
                Some(native_window),
                None,
                &callback,
            )
        };
        OBSERVERS.with_borrow_mut(|observers| observers.push(observer));
    }

    // Observe only: diagnostics must never become another layout writer.
    #[cfg(debug_assertions)]
    {
        let trace = RcBlock::new(move |_: NonNull<NSNotification>| {
            CHROME.with(|state| {
                if let Ok(mut chrome) = state.try_borrow_mut() {
                    chrome.trace_geometry();
                }
            });
        });
        let observer = unsafe {
            center.addObserverForName_object_queue_usingBlock(
                Some(objc2_app_kit::NSWindowDidUpdateNotification),
                Some(native_window),
                None,
                &trace,
            )
        };
        OBSERVERS.with_borrow_mut(|observers| observers.push(observer));
    }

    let target = window.clone();
    let handoff_listener = window.listen(FULLSCREEN_CHROME_HANDOFF, move |event| {
        let Ok(message) = serde_json::from_str::<FrontendMessage>(event.payload()) else { return };
        let target = target.clone();
        let app = target.app_handle().clone();
        let _ = app.run_on_main_thread(move || CHROME.with_borrow_mut(|chrome| {
            match message {
                FrontendMessage::Ready { client_id } => {
                    chrome.handoff.client_id = Some(client_id);
                    chrome.handoff.awaiting_paint |= chrome.handoff.phase == FullscreenPhase::Exiting;
                    without_animation(|| chrome.sync_buttons());
                    chrome.emit(&target);
                }
                FrontendMessage::Settled { client_id, transition_id } => {
                    chrome.handoff.settle(&client_id, transition_id);
                    without_animation(|| chrome.sync_buttons());
                    log::debug!("Native fullscreen chrome paint acknowledged: transition_id={}, suppressed={}",
                        transition_id, chrome.handoff.suppress_buttons());
                }
                FrontendMessage::Unready { client_id } => {
                    if chrome.handoff.client_id.as_deref() == Some(&client_id) {
                        chrome.handoff.client_id = None;
                        chrome.handoff.awaiting_paint = false;
                        without_animation(|| chrome.sync_buttons());
                    }
                }
            }
        }));
    });

    let app = window.app_handle().clone();
    window.on_window_event(move |event| {
        if matches!(event, tauri::WindowEvent::Destroyed) {
            app.unlisten(handoff_listener);
            let _ = app.run_on_main_thread(remove_observers);
        }
    });
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn buttons_wait_for_native_exit_and_rendered_clearance_in_either_order() {
        for paint_first in [true, false] {
            let mut state = Handoff {
                client_id: Some("webview".into()),
                ..Default::default()
            };
            state.transition(FullscreenPhase::Exiting);
            assert!(state.suppress_buttons());
            if paint_first {
                state.settle("webview", state.transition_id);
                assert!(state.suppress_buttons());
                state.transition(FullscreenPhase::Windowed);
            } else {
                state.transition(FullscreenPhase::Windowed);
                assert!(state.suppress_buttons());
                state.settle("webview", state.transition_id);
            }
            assert!(!state.suppress_buttons());
        }
    }

    #[test]
    fn stale_paint_cannot_reveal_buttons_during_a_later_exit() {
        let mut state = Handoff {
            client_id: Some("webview".into()),
            ..Default::default()
        };
        state.transition(FullscreenPhase::Exiting);
        let old = state.transition_id;
        state.transition(FullscreenPhase::Entering);
        state.transition(FullscreenPhase::Fullscreen);
        state.transition(FullscreenPhase::Exiting);
        state.transition(FullscreenPhase::Windowed);
        state.settle("webview", old);
        state.settle("old-webview", state.transition_id);
        assert!(state.suppress_buttons());
        state.settle("webview", state.transition_id);
        assert!(!state.suppress_buttons());
    }

    #[test]
    fn sdk_metrics_preserve_the_same_design_center() {
        let row = toolbar_height();
        assert_eq!(row, 45.0);
        for (titlebar, button) in [(28.0, 16.0), (32.0, 14.0)] {
            let inset = traffic_light_inset(row, titlebar, button);
            assert_eq!(inset + button - titlebar / 2.0, row / 2.0);
        }
    }

    #[test]
    fn legacy_frontends_never_wait_for_an_unsupported_paint_ack() {
        let mut state = Handoff::default();
        state.transition(FullscreenPhase::Exiting);
        assert!(!state.suppress_buttons());
        state.transition(FullscreenPhase::Windowed);
        assert!(!state.suppress_buttons());
    }
}
