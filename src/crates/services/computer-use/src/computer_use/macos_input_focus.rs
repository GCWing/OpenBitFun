//! Application-local input focus for window-addressed background input.
//!
//! AppKit activation and WindowServer foreground ownership are different states.
//! We establish the former only in the authorized process. A focus-only event
//! pair is addressed outside that window's frame; no content is clicked. The
//! requested gesture retains its original modifiers and target. Delivery is
//! reported as submitted; the next observation verifies the application result.
use core_graphics::event::{CGEvent, CGEventFlags, CGEventType, CGMouseButton};
use core_graphics::geometry::CGPoint;
use foreign_types::ForeignType;
use openbitfun_agent_tools::computer_use_host::error::{OpenBitFunError, OpenBitFunResult};
use std::sync::Mutex;
use std::time::Duration;

unsafe extern "C" {
    fn obf_focus_loss_epoch(
        pid: i32,
        window: u32,
        generation: u64,
        identity_high: u32,
        identity_low: u32,
        start: bool,
    ) -> u64;
    fn obf_focus_loss_stop(
        pid: i32,
        window: u32,
        generation: u64,
        identity_high: u32,
        identity_low: u32,
    );
    #[cfg(test)]
    fn obf_focus_event_is_loss(event_type: u32, subtype: i64) -> bool;
}

#[derive(Clone, Copy)]
struct Focus {
    pid: i32,
    identity: super::macos_skylight::ProcessIdentity,
    window: u32,
    generation: u64,
    foreground: i32,
    activation_epoch: u64,
    loss_epoch: u64,
}
impl Focus {
    fn same_target(self, next: Self) -> bool {
        self.pid == next.pid
            && self.identity == next.identity
            && self.window == next.window
            && self.generation == next.generation
    }
    fn reusable(self, next: Self) -> bool {
        self.same_target(next)
            && self.foreground == next.foreground
            && next.activation_epoch != 0
            && self.activation_epoch == next.activation_epoch
            && next.loss_epoch != 0
            && self.loss_epoch == next.loss_epoch
    }
    fn observed_loss_epoch(self, start: bool) -> u64 {
        unsafe {
            obf_focus_loss_epoch(
                self.pid,
                self.window,
                self.generation,
                self.identity.0[0],
                self.identity.0[1],
                start,
            )
        }
    }
    fn stop_observer(self) {
        unsafe {
            obf_focus_loss_stop(
                self.pid,
                self.window,
                self.generation,
                self.identity.0[0],
                self.identity.0[1],
            )
        }
    }
}
static FOCUS: Mutex<Option<Focus>> = Mutex::new(None);

fn cleanup(focus: Focus) {
    // A user may have deliberately switched to the target in the meantime.
    // Never deactivate that real foreground application. Also reject PID reuse.
    if super::macos_bg_input::frontmost_pid_macos().is_some_and(|p| p != focus.pid)
        && super::macos_skylight::process_identity(focus.pid) == Some(focus.identity)
    {
        super::macos_skylight::set_local_activation(focus.identity, focus.window, false);
    }
}

pub(super) fn stop() {
    if let Ok(mut state) = FOCUS.lock() {
        if let Some(focus) = state.take() {
            focus.stop_observer();
            cleanup(focus);
        }
    }
}

fn check(pid: i32, window: u32) -> OpenBitFunResult<()> {
    super::control_session::input_allowed().map_err(OpenBitFunError::tool)?;
    super::control_session::target_allowed(&format!("pid:{pid}/window:{window}"))
        .map_err(OpenBitFunError::tool)
}

pub(super) fn prepare(pid: i32) -> OpenBitFunResult<()> {
    super::control_session::input_allowed().map_err(OpenBitFunError::tool)?;
    let window = super::macos_capture::bound_window_id(pid).map_err(OpenBitFunError::tool)?;
    check(pid, window)?;
    let foreground = super::macos_bg_input::frontmost_pid_macos().ok_or_else(|| {
        OpenBitFunError::tool("[BACKGROUND_INPUT_UNAVAILABLE] Foreground ownership is unavailable")
    })?;
    if foreground == pid || super::control_session::foreground_allowed().is_ok() {
        return Ok(());
    }
    let identity = super::macos_skylight::process_identity(pid).ok_or_else(|| {
        OpenBitFunError::tool(
            "[BACKGROUND_INPUT_UNAVAILABLE] Target process identity is unavailable",
        )
    })?;
    let generation = super::control_session::snapshot().generation;
    let activation_epoch = super::macos_capture::activation_epoch();
    // Obtain capture geometry before the focus lock: bind_target may hold the
    // capture lock while clearing old input focus. Never invert that order.
    let [x, y, width, height] =
        super::macos_capture::window_bounds(pid, window).map_err(OpenBitFunError::tool)?;
    let mut state = FOCUS
        .lock()
        .map_err(|_| OpenBitFunError::tool("Background input focus lock poisoned"))?;
    let mut focus = Focus {
        pid,
        identity,
        window,
        generation,
        foreground,
        activation_epoch,
        loss_epoch: 0,
    };
    focus.loss_epoch = focus.observed_loss_epoch(false);
    if state.is_some_and(|previous| previous.reusable(focus)) {
        return Ok(());
    }
    if ![x, y, width, height].iter().all(|v| v.is_finite()) || width <= 0.0 || height <= 0.0 {
        return Err(OpenBitFunError::tool(
            "[CONTROL_TARGET_CHANGED] Invalid window geometry for background focus",
        ));
    }
    let source = super::macos_bg_input::mouse_source("background_focus")?;
    let point = CGPoint::new(x - 8.0, y - 8.0);
    // Create both releases and routing metadata before the first mutation.
    let mut pair = Vec::with_capacity(2);
    for kind in [CGEventType::LeftMouseDown, CGEventType::LeftMouseUp] {
        let event = CGEvent::new_mouse_event(source.clone(), kind, point, CGMouseButton::Left)
            .map_err(|_| OpenBitFunError::tool("Background focus event unavailable"))?;
        for field in [51, 91, 92] {
            event.set_integer_value_field(field, window as i64);
        }
        event.set_integer_value_field(58, 1);
        event.set_integer_value_field(1, 1);
        event.set_flags(CGEventFlags::CGEventFlagNull);
        if !super::macos_skylight::set_window_location(event.as_ptr().cast(), -8.0, -8.0) {
            return Err(OpenBitFunError::tool(
                "[BACKGROUND_INPUT_UNAVAILABLE] Window-local input routing is unavailable",
            ));
        }
        pair.push(event);
    }
    check(pid, window)?;
    if let Some(old) = state.take() {
        if !old.same_target(focus) {
            old.stop_observer();
            cleanup(old);
        }
    }
    // Observe only this process, without suppressing or changing its events.
    // An unavailable/disabled tap returns zero, which disables cache reuse but
    // does not prevent normal directed input. No main-thread wait is involved.
    focus.loss_epoch = focus.observed_loss_epoch(true);
    // Register cleanup before attempting any native state mutation.
    *state = Some(focus);
    if !super::macos_skylight::set_local_activation(identity, window, true) {
        focus.stop_observer();
        state.take();
        return Err(OpenBitFunError::tool("[BACKGROUND_INPUT_UNAVAILABLE] Target-local input activation failed; no content input was sent"));
    }
    std::thread::sleep(Duration::from_millis(20));
    if let Err(error) = check(pid, window) {
        focus.stop_observer();
        cleanup(focus);
        state.take();
        return Err(error);
    }
    pair[0].post_to_pid(pid);
    std::thread::sleep(Duration::from_millis(10));
    // Complete this private focus gesture even if Stop arrived after its down.
    pair[1].post_to_pid(pid);
    // FIFO process delivery establishes the local window context ahead of the
    // requested gesture. AXFocused on a window is not a reliable key-state
    // acknowledgement (many AppKit windows do not expose it). Do not turn that
    // missing AX attribute into a blanket rejection of visual-only controls.
    std::thread::sleep(Duration::from_millis(10));
    if let Err(error) = check(pid, window) {
        focus.stop_observer();
        cleanup(focus);
        state.take();
        return Err(error);
    }
    drop(state);
    super::macos_capture::note_input(pid);
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::Focus;
    #[test]
    fn foreground_roundtrip_invalidates_local_focus_even_when_pid_returns() {
        let original = Focus {
            pid: 11,
            identity: super::super::macos_skylight::ProcessIdentity([0, 11]),
            window: 22,
            generation: 1,
            foreground: 33,
            activation_epoch: 4,
            loss_epoch: 1,
        };
        assert!(original.reusable(original));
        assert!(!original.reusable(Focus {
            identity: super::super::macos_skylight::ProcessIdentity([0, 12]),
            ..original
        }));
        assert!(!original.reusable(Focus {
            activation_epoch: 6,
            ..original
        }));
        assert!(!original.reusable(Focus {
            window: 23,
            ..original
        }));
        assert!(!original.reusable(Focus {
            generation: 2,
            ..original
        }));
    }
    #[test]
    fn pending_activation_observer_never_reuses_focus() {
        let pending = Focus {
            pid: 11,
            identity: super::super::macos_skylight::ProcessIdentity([0, 11]),
            window: 22,
            generation: 1,
            foreground: 33,
            activation_epoch: 0,
            loss_epoch: 1,
        };
        assert!(!pending.reusable(pending));
    }

    #[test]
    fn target_loss_invalidates_focus_without_a_foreground_switch() {
        let prepared = Focus {
            pid: 11,
            identity: super::super::macos_skylight::ProcessIdentity([0, 11]),
            window: 22,
            generation: 1,
            foreground: 33,
            activation_epoch: 4,
            loss_epoch: 1,
        };
        assert!(prepared.reusable(prepared));
        assert!(!prepared.reusable(Focus {
            loss_epoch: 2,
            ..prepared
        }));
        assert!(!prepared.reusable(Focus {
            loss_epoch: 0,
            ..prepared
        }));
    }

    #[test]
    fn only_native_focus_loss_events_invalidate_preparation() {
        // AppKit app deactivation, process deactivation and key-focus loss.
        for (kind, subtype) in [(13, 2), (19, 0), (21, 0x1000), (21, 0x4000)] {
            assert!(unsafe { super::obf_focus_event_is_loss(kind, subtype) });
        }
        // Our own activation, focus-return notifications and content input are
        // not losses and therefore cannot force preparation on every action.
        for (kind, subtype) in [(13, 1), (20, 0), (21, 0x8000), (1, 0), (10, 0)] {
            assert!(!unsafe { super::obf_focus_event_is_loss(kind, subtype) });
        }
    }
}
