//! Close-to-hide must leave the native fullscreen Space before ordering out.

use std::cell::RefCell;
use std::rc::Rc;

use block2::RcBlock;
use objc2::rc::Retained;
use objc2_app_kit::{NSWindow, NSWindowStyleMask};
use objc2_foundation::NSOperationQueue;

#[derive(Clone, Copy, Debug, Default, PartialEq, serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) enum FullscreenPhase {
    Entering,
    Fullscreen,
    Exiting,
    #[default]
    Windowed,
}

#[derive(Default)]
struct PendingClose {
    phase: FullscreenPhase,
    reason: Option<&'static str>,
}

#[derive(Debug, PartialEq)]
enum Action {
    Wait,
    ExitFullscreen,
    Hide(&'static str),
}

impl PendingClose {
    fn advance(&mut self) -> Action {
        let Some(reason) = self.reason else {
            return Action::Wait;
        };
        match self.phase {
            FullscreenPhase::Entering | FullscreenPhase::Exiting => Action::Wait,
            FullscreenPhase::Fullscreen => Action::ExitFullscreen,
            FullscreenPhase::Windowed => {
                self.reason = None;
                Action::Hide(reason)
            }
        }
    }

    fn request(&mut self, reason: &'static str) -> Action {
        if self.reason.is_some() {
            return Action::Wait;
        }
        self.reason = Some(reason);
        self.advance()
    }
}

/// Main-thread only, like the retained NSWindow. The chrome observer supplies
/// AppKit phases; frontend paint acknowledgments never gate window visibility.
pub(crate) struct CloseAfterFullscreen {
    window: Retained<NSWindow>,
    pending: RefCell<PendingClose>,
    on_hidden: fn(&str),
}

impl CloseAfterFullscreen {
    pub(crate) fn new(window: Retained<NSWindow>, on_hidden: fn(&str)) -> Rc<Self> {
        let phase = if window.styleMask().contains(NSWindowStyleMask::FullScreen) {
            FullscreenPhase::Fullscreen
        } else {
            FullscreenPhase::Windowed
        };
        Rc::new(Self {
            window,
            pending: RefCell::new(PendingClose {
                phase,
                reason: None,
            }),
            on_hidden,
        })
    }

    pub(crate) fn request_hide(self: &Rc<Self>, reason: &'static str) {
        let action = self.pending.borrow_mut().request(reason);
        self.apply(action);
    }

    pub(crate) fn transition(self: &Rc<Self>, phase: FullscreenPhase) {
        let action = {
            let mut pending = self.pending.borrow_mut();
            pending.phase = phase;
            pending.advance()
        };
        self.apply(action);
    }

    pub(crate) fn cancel(&self) {
        self.pending.borrow_mut().reason = None;
    }

    fn apply(self: &Rc<Self>, action: Action) {
        // Release RefCell borrows before AppKit calls: toggleFullScreen posts
        // WillExit synchronously and can re-enter our notification observer.
        match action {
            Action::Wait => {}
            Action::ExitFullscreen => {
                // DidEnter is posted before AppKit finishes its completion
                // handler. Toggling inside it can fail with "not in fullscreen
                // state". Return to the main loop first, then recheck intent.
                let close = Rc::downgrade(self);
                let block = RcBlock::new(move || {
                    let Some(close) = close.upgrade() else { return };
                    let should_exit = {
                        let pending = close.pending.borrow();
                        pending.reason.is_some() && pending.phase == FullscreenPhase::Fullscreen
                    };
                    if should_exit {
                        close.window.toggleFullScreen(None);
                    }
                });
                // SAFETY: The block and its non-Send window state are created,
                // executed and released on the AppKit main queue only.
                unsafe { NSOperationQueue::mainQueue().addOperationWithBlock(&block) };
            }
            Action::Hide(reason) => {
                // Same native operation as Tao's hide(), on the AppKit thread.
                self.window.orderOut(None);
                (self.on_hidden)(reason);
            }
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn both_close_sources_wait_for_native_exit() {
        for reason in ["frontend_ack", "frontend_timeout"] {
            let mut pending = PendingClose {
                phase: FullscreenPhase::Fullscreen,
                reason: None,
            };
            assert_eq!(pending.request(reason), Action::ExitFullscreen);
            assert_eq!(pending.request(reason), Action::Wait);
            pending.phase = FullscreenPhase::Exiting;
            assert_eq!(pending.advance(), Action::Wait);
            pending.phase = FullscreenPhase::Windowed;
            assert_eq!(pending.advance(), Action::Hide(reason));
            assert_eq!(pending.advance(), Action::Wait);
        }
    }

    #[test]
    fn close_during_entry_waits_before_requesting_exit() {
        let mut pending = PendingClose {
            phase: FullscreenPhase::Entering,
            reason: None,
        };
        assert_eq!(pending.request("frontend_ack"), Action::Wait);
        pending.phase = FullscreenPhase::Fullscreen;
        assert_eq!(pending.advance(), Action::ExitFullscreen);
        pending.phase = FullscreenPhase::Exiting;
        assert_eq!(pending.advance(), Action::Wait);
        pending.phase = FullscreenPhase::Windowed;
        assert_eq!(pending.advance(), Action::Hide("frontend_ack"));
    }

    #[test]
    fn reopen_cancels_deferred_hide_and_windowed_close_stays_immediate() {
        let mut pending = PendingClose {
            phase: FullscreenPhase::Exiting,
            reason: None,
        };
        assert_eq!(pending.request("frontend_timeout"), Action::Wait);
        pending.reason = None;
        pending.phase = FullscreenPhase::Windowed;
        assert_eq!(pending.advance(), Action::Wait);
        assert_eq!(
            pending.request("frontend_ack"),
            Action::Hide("frontend_ack")
        );
    }
}
