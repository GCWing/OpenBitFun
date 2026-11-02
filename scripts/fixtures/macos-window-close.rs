// Run through scripts/test-macos-window-close.mjs on the AppKit main thread.
use std::cell::Cell;
use std::ptr::NonNull;
use std::rc::Rc;
use std::time::{Duration, Instant};

use block2::RcBlock;
use macos_window_close::{CloseAfterFullscreen, FullscreenPhase};
use objc2::{MainThreadMarker, MainThreadOnly};
use objc2_app_kit::{
    NSApplication, NSApplicationActivationPolicy, NSBackingStoreType, NSWindow,
    NSWindowCollectionBehavior, NSWindowDidEnterFullScreenNotification,
    NSWindowDidExitFullScreenNotification, NSWindowStyleMask,
    NSWindowWillEnterFullScreenNotification, NSWindowWillExitFullScreenNotification,
};
use objc2_foundation::{NSNotification, NSNotificationCenter, NSPoint, NSRect, NSSize};

#[link(name = "CoreFoundation", kind = "framework")]
unsafe extern "C" {
    static kCFRunLoopDefaultMode: *const std::ffi::c_void;
    fn CFRunLoopRunInMode(
        mode: *const std::ffi::c_void,
        seconds: f64,
        return_after_source: bool,
    ) -> i32;
}

fn wait_for(label: &str, ready: impl Fn() -> bool) {
    let deadline = Instant::now() + Duration::from_secs(15);
    while !ready() {
        assert!(Instant::now() < deadline, "Timed out: {label}");
        unsafe { CFRunLoopRunInMode(kCFRunLoopDefaultMode, 0.01, true) };
    }
}

fn main() {
    let mtm = MainThreadMarker::new().unwrap();
    let app = NSApplication::sharedApplication(mtm);
    app.setActivationPolicy(NSApplicationActivationPolicy::Regular);
    app.finishLaunching();
    let window = unsafe {
        NSWindow::initWithContentRect_styleMask_backing_defer(
            NSWindow::alloc(mtm),
            NSRect::new(NSPoint::new(100.0, 100.0), NSSize::new(800.0, 600.0)),
            NSWindowStyleMask::Titled
                | NSWindowStyleMask::Closable
                | NSWindowStyleMask::Resizable
                | NSWindowStyleMask::Miniaturizable,
            NSBackingStoreType::Buffered,
            false,
        )
    };
    window.setCollectionBehavior(NSWindowCollectionBehavior::FullScreenPrimary);
    let close = CloseAfterFullscreen::new(window.clone(), |_| {});
    let phase = Rc::new(Cell::new(FullscreenPhase::Windowed));
    let close_on_entry = Rc::new(Cell::new(false));
    let center = NSNotificationCenter::defaultCenter();
    let mut observers = Vec::new();
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
    for (name, next) in notifications {
        let close = close.clone();
        let phase = phase.clone();
        let close_on_entry = close_on_entry.clone();
        let target = window.clone();
        let callback = RcBlock::new(move |_: NonNull<NSNotification>| {
            phase.set(next);
            close.transition(next);
            if next == FullscreenPhase::Entering && close_on_entry.replace(false) {
                close.request_hide("frontend_ack");
            }
            if matches!(next, FullscreenPhase::Entering | FullscreenPhase::Exiting) {
                assert!(
                    target.isVisible(),
                    "Window must stay visible during native transitions"
                );
            }
        });
        observers.push(unsafe {
            center.addObserverForName_object_queue_usingBlock(
                Some(name),
                Some(&window),
                None,
                &callback,
            )
        });
    }
    #[allow(deprecated)]
    app.activateIgnoringOtherApps(true);

    // Ordinary close and reopen still work without a fullscreen transition.
    window.makeKeyAndOrderFront(None);
    close.request_hide("frontend_ack");
    assert!(!window.isVisible());

    for reason in ["frontend_ack", "frontend_timeout"] {
        window.makeKeyAndOrderFront(None);
        window.toggleFullScreen(None);
        wait_for("enter fullscreen", || {
            phase.get() == FullscreenPhase::Fullscreen
        });
        close.request_hide(reason);
        close.request_hide(reason);
        wait_for("exit then hide", || !window.isVisible());
        assert_eq!(phase.get(), FullscreenPhase::Windowed);
        assert!(!window.styleMask().contains(NSWindowStyleMask::FullScreen));
        window.makeKeyAndOrderFront(None);
        assert!(window.isVisible());
        println!("PASS native fullscreen close and reopen: {reason}");
    }

    // A close received in WillEnter must survive entry and exit before hiding.
    close_on_entry.set(true);
    window.toggleFullScreen(None);
    wait_for("close during entry", || !window.isVisible());
    assert_eq!(phase.get(), FullscreenPhase::Windowed);
    println!("PASS native close during fullscreen entry");

    window.makeKeyAndOrderFront(None);
    window.toggleFullScreen(None);
    wait_for("enter before cancellation", || {
        phase.get() == FullscreenPhase::Fullscreen
    });
    close.request_hide("frontend_ack");
    wait_for("exit before reopen", || {
        phase.get() == FullscreenPhase::Exiting
    });
    close.cancel();
    window.makeKeyAndOrderFront(None);
    wait_for("exit after reopen", || {
        phase.get() == FullscreenPhase::Windowed
    });
    assert!(window.isVisible(), "Reopen must cancel deferred hide");
    println!("PASS native reopen during fullscreen exit cancels hide");

    window.toggleFullScreen(None);
    wait_for("enter before early cancellation", || {
        phase.get() == FullscreenPhase::Fullscreen
    });
    close.request_hide("frontend_ack");
    close.cancel();
    // Drain the queued exit operation: a reopen before it runs must cancel it.
    unsafe { CFRunLoopRunInMode(kCFRunLoopDefaultMode, 0.05, false) };
    assert_eq!(phase.get(), FullscreenPhase::Fullscreen);
    assert!(window.isVisible());
    println!("PASS reopen before queued exit preserves fullscreen");

    window.toggleFullScreen(None);
    wait_for("user started exit", || {
        phase.get() == FullscreenPhase::Exiting
    });
    close.request_hide("frontend_ack");
    wait_for("close during exit", || !window.isVisible());
    assert_eq!(phase.get(), FullscreenPhase::Windowed);
    println!("PASS native close during fullscreen exit");

    for observer in observers {
        unsafe { center.removeObserver(observer.as_ref()) };
    }
    window.orderOut(None);
}
