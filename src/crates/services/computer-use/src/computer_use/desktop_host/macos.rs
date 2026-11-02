//! macOS-only low-level FFI helpers for the desktop Computer Use host:
//! Accessibility trust / prompt, screen-capture permission preflight, Quartz
//! pointer location, and the main-thread / Objective-C exception dispatch
//! wrappers required by AppKit / HIToolbox / Accessibility calls.
//!
//! Extracted verbatim from `desktop_host.rs` (no behavior change) so the
//! permission and thread-dispatch primitives have a single, independently
//! reviewable home instead of living inline inside the multi-thousand-line
//! host file.

use super::{OpenBitFunError, OpenBitFunResult};
use core_foundation::base::{CFRelease, TCFType};
use core_foundation::boolean::CFBoolean;
use core_foundation::dictionary::CFDictionary;
use core_foundation::string::CFString;
use dispatch::Queue;
use std::ffi::c_void;

#[repr(C)]
#[derive(Copy, Clone)]
struct CGPoint {
    x: f64,
    y: f64,
}

#[link(name = "System", kind = "dylib")]
unsafe extern "C" {
    fn pthread_main_np() -> i32;
}

/// Run work that may call TSM / HIToolbox (enigo keyboard & text) on the main dispatch queue.
///
/// The closure is wrapped in `objc2::exception::catch` so that any
/// Objective-C `NSException` thrown by TSM / HIToolbox / AppKit (which
/// historically appears as `__rust_foreign_exception` and aborts the
/// process when it crosses back into the Rust runtime) is converted into
/// a `OpenBitFunError` we can return to the caller. The closure must itself
/// return a `OpenBitFunResult<T>` so we can flatten the two error sources
/// (ObjC exception + Rust-side error) into one.
pub(super) fn run_on_main_for_enigo<F, T>(f: F) -> OpenBitFunResult<T>
where
    F: FnOnce() -> OpenBitFunResult<T> + Send,
    T: Send,
{
    let token = crate::computer_use::control_session::dispatch_token();
    let work = move || crate::computer_use::control_session::with_token(token, || catch_only(f));
    unsafe {
        if pthread_main_np() != 0 {
            work()
        } else {
            Queue::main().exec_sync(work)
        }
    }
}

/// Run AppKit / HIToolbox input work on main under an Objective-C catch.
/// Never wrap AX traversal or cached-node actions here: a same-process tree
/// also contains WebKit subprocess elements whose IPC needs main to stay free.
/// Use `catch_objc_local` for AX work; `macos_ax_dispatch` sends each individual
/// same-process message to main to preserve AppKit's thread requirement.
///
/// If we're already on the main thread we run inline (avoids
/// `dispatch_sync(main)` deadlock).
pub(super) fn catch_objc<F, T>(f: F) -> OpenBitFunResult<T>
where
    F: FnOnce() -> OpenBitFunResult<T> + Send,
    T: Send,
{
    let token = crate::computer_use::control_session::dispatch_token();
    let work = move || crate::computer_use::control_session::with_token(token, || catch_only(f));
    unsafe {
        if pthread_main_np() != 0 {
            work()
        } else {
            Queue::main().exec_sync(work)
        }
    }
}

/// Run a closure under an Objective-C `@try/@catch` **on the current
/// thread** (no main-queue dispatch). AX work routes individual messages through
/// `macos_ax_dispatch`; Vision OCR can also run here with borrowed image data.
pub(super) fn catch_objc_local<F, T>(f: F) -> OpenBitFunResult<T>
where
    F: FnOnce() -> OpenBitFunResult<T>,
{
    catch_only(f)
}

fn catch_only<F, T>(f: F) -> OpenBitFunResult<T>
where
    F: FnOnce() -> OpenBitFunResult<T>,
{
    use std::panic::AssertUnwindSafe;
    match objc2::exception::catch(AssertUnwindSafe(f)) {
        Ok(inner) => inner,
        Err(Some(exc)) => Err(OpenBitFunError::tool(format!(
            "Objective-C exception: {}",
            exc
        ))),
        Err(None) => Err(OpenBitFunError::tool(
            "Objective-C exception (nil)".to_string(),
        )),
    }
}

#[link(name = "ApplicationServices", kind = "framework")]
unsafe extern "C" {
    fn AXIsProcessTrusted() -> bool;
    fn AXIsProcessTrustedWithOptions(options: *const std::ffi::c_void) -> bool;
}

#[link(name = "CoreGraphics", kind = "framework")]
unsafe extern "C" {
    fn CGRequestScreenCaptureAccess() -> bool;
    fn CGEventCreate(source: *const c_void) -> *const c_void;
    fn CGEventGetLocation(event: *const c_void) -> CGPoint;
}

/// Mouse location in Quartz global coordinates (same space as `CGEvent` / `CGWarpMouseCursorPosition`).
pub(super) fn quartz_mouse_location() -> OpenBitFunResult<(f64, f64)> {
    unsafe {
        let ev = CGEventCreate(std::ptr::null());
        if ev.is_null() {
            return Err(OpenBitFunError::tool(
                "CGEventCreate returned null (pointer overlay).".to_string(),
            ));
        }
        let pt = CGEventGetLocation(ev);
        CFRelease(ev as *const _);
        Ok((pt.x, pt.y))
    }
}

pub(super) fn ax_trusted() -> bool {
    unsafe { AXIsProcessTrusted() }
}

pub(super) fn request_ax_prompt() {
    let key = CFString::new("AXTrustedCheckOptionPrompt");
    let val = CFBoolean::true_value();
    let dict = CFDictionary::from_CFType_pairs(&[(key.as_CFType(), val.as_CFType())]);
    unsafe {
        AXIsProcessTrustedWithOptions(dict.as_concrete_TypeRef() as *const _);
    }
}

pub(super) fn request_screen_capture() -> bool {
    unsafe { CGRequestScreenCaptureAccess() }
}

/// Observation never invokes consent prompts. The user's permission action
/// owns the explicit request and the OS owns its outcome.
pub(super) fn require_ax_trust_for(retry_hint: &str) -> OpenBitFunResult<()> {
    if ax_trusted() {
        return crate::computer_use::macos_ax_dispatch::require_process_routing()
            .map_err(OpenBitFunError::tool);
    }
    Err(OpenBitFunError::tool(format!(
        "[PERMISSION_DENIED] macOS Accessibility permission not granted to OpenBitFun. \
         Use Computer Use permissions to request access, or open System Settings → \
         Privacy & Security → Accessibility → enable OpenBitFun. {}",
        retry_hint
    )))
}
