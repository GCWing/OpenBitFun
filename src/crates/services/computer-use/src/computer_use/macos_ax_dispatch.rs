//! Dispatch individual AX messages, never an entire tree walk.
//!
//! Same-process AX calls invoke AppKit directly and must run on main. A tree
//! rooted in our process can contain elements owned by a WebKit subprocess:
//! those messages must stay on the calling worker so main can answer WebKit's
//! synchronous IPC (including AX client authentication during AXPosition reads).

use core_foundation::{array::CFArrayRef, base::CFTypeRef, string::CFStringRef};
use std::{ffi::c_void, panic::AssertUnwindSafe};

type Element = *const c_void;

mod ffi {
    use super::*;
    #[link(name = "ApplicationServices", kind = "framework")]
    unsafe extern "C" {
        pub(super) fn AXUIElementCopyAttributeValue(
            element: Element,
            attr: CFStringRef,
            out: *mut CFTypeRef,
        ) -> i32;
        pub(super) fn AXUIElementCopyActionNames(element: Element, out: *mut CFArrayRef) -> i32;
        pub(super) fn AXUIElementCopyElementAtPosition(
            element: Element,
            x: f32,
            y: f32,
            out: *mut Element,
        ) -> i32;
        pub(super) fn AXUIElementIsAttributeSettable(
            element: Element,
            attr: CFStringRef,
            out: *mut u8,
        ) -> i32;
        pub(super) fn AXUIElementSetAttributeValue(
            element: Element,
            attr: CFStringRef,
            value: CFTypeRef,
        ) -> i32;
        pub(super) fn AXUIElementPerformAction(element: Element, action: CFStringRef) -> i32;
    }
}

type GetWindow = unsafe extern "C" fn(Element, *mut u32) -> i32;
type GetActualPid = unsafe extern "C" fn(Element, *mut i32) -> i32;

fn actual_pid_lookup() -> Option<GetActualPid> {
    static LOOKUP: std::sync::OnceLock<Option<GetActualPid>> = std::sync::OnceLock::new();
    *LOOKUP.get_or_init(|| {
        let symbol =
            unsafe { libc::dlsym(libc::RTLD_DEFAULT, c"_AXUIElementGetActualPid".as_ptr()) };
        if symbol.is_null() {
            None
        } else {
            Some(unsafe { std::mem::transmute::<*mut c_void, GetActualPid>(symbol) })
        }
    })
}

pub(super) fn require_process_routing() -> Result<(), &'static str> {
    actual_pid_lookup().map(|_| ()).ok_or(
        "[AX_DISPATCH_UNAVAILABLE] Native Accessibility process routing is unavailable on this macOS version"
    )
}

/// AXUIElementGetPid reports the *presenting* application for WebKit children,
/// even when their messages are served by WebContent. Use the serving PID only
/// for thread routing; target/permission validation must keep the presenter PID.
/// WebKit's TestController.cpp declares this same AXError(AXUIElementRef,pid_t*)
/// SPI. Resolve it dynamically and fail explicitly when unavailable.
pub(super) unsafe fn actual_pid(element: Element) -> Result<i32, i32> {
    let lookup = actual_pid_lookup().ok_or(-25212)?; // kAXErrorNotImplemented
    let mut pid = 0;
    let status = unsafe { lookup(element, &mut pid) };
    if status == 0 {
        Ok(pid)
    } else {
        Err(status)
    }
}

enum Operation {
    Attribute(CFStringRef, *mut CFTypeRef),
    Actions(*mut CFArrayRef),
    HitTest(f32, f32, *mut Element),
    Settable(CFStringRef, *mut u8),
    Set(CFStringRef, CFTypeRef),
    SetInput(CFStringRef, CFTypeRef),
    Perform(CFStringRef),
    Window(GetWindow, *mut u32),
}

struct Request {
    element: Element,
    operation: Operation,
}

// SAFETY: dispatch is synchronous. The unsafe entry points require all input
// references and output storage to remain valid until return. The caller is
// blocked while main uses that storage; neither pointers nor closures escape.
unsafe impl Send for Request {}

impl Request {
    fn invoke(self) -> i32 {
        // Stop can revoke the token while a same-process message waits for
        // main. Check again on the executing thread before native input starts.
        if matches!(
            self.operation,
            Operation::SetInput(..) | Operation::Perform(..)
        ) && super::control_session::input_allowed().is_err()
        {
            return -25200; // kAXErrorFailure; input was not submitted.
        }
        // Catch on the executing thread: an exception must never unwind through
        // libdispatch, even when the caller has its own Objective-C catch.
        let result = objc2::exception::catch(AssertUnwindSafe(|| unsafe {
            match self.operation {
                Operation::Attribute(attr, out) => {
                    ffi::AXUIElementCopyAttributeValue(self.element, attr, out)
                }
                Operation::Actions(out) => ffi::AXUIElementCopyActionNames(self.element, out),
                Operation::HitTest(x, y, out) => {
                    ffi::AXUIElementCopyElementAtPosition(self.element, x, y, out)
                }
                Operation::Settable(attr, out) => {
                    ffi::AXUIElementIsAttributeSettable(self.element, attr, out)
                }
                Operation::Set(attr, value) | Operation::SetInput(attr, value) => {
                    ffi::AXUIElementSetAttributeValue(self.element, attr, value)
                }
                Operation::Perform(action) => ffi::AXUIElementPerformAction(self.element, action),
                Operation::Window(lookup, out) => lookup(self.element, out),
            }
        }));
        match result {
            Ok(status) => status,
            Err(exception) => {
                log::warn!("Computer Use AX call raised an Objective-C exception: {exception:?}");
                -25200 // kAXErrorFailure; never claim success or retry input.
            }
        }
    }

    fn dispatch(self) -> i32 {
        let pid = match unsafe { actual_pid(self.element) } {
            Ok(pid) => pid,
            Err(status) => return status,
        };
        if pid == std::process::id() as i32 && objc2::MainThreadMarker::new().is_none() {
            let token = super::control_session::dispatch_token();
            dispatch::Queue::main()
                .exec_sync(move || super::control_session::with_token(token, || self.invoke()))
        } else {
            self.invoke()
        }
    }
}

// These wrappers preserve the native AX error/ownership contract. Like the C
// APIs, callers own all inputs and must provide valid writable output pointers.
pub(super) unsafe fn copy_attribute_value(
    element: Element,
    attr: CFStringRef,
    out: *mut CFTypeRef,
) -> i32 {
    Request {
        element,
        operation: Operation::Attribute(attr, out),
    }
    .dispatch()
}

pub(super) unsafe fn copy_action_names(element: Element, out: *mut CFArrayRef) -> i32 {
    Request {
        element,
        operation: Operation::Actions(out),
    }
    .dispatch()
}

pub(super) unsafe fn copy_element_at_position(
    element: Element,
    x: f32,
    y: f32,
    out: *mut Element,
) -> i32 {
    Request {
        element,
        operation: Operation::HitTest(x, y, out),
    }
    .dispatch()
}

pub(super) unsafe fn is_attribute_settable(
    element: Element,
    attr: CFStringRef,
    out: *mut u8,
) -> i32 {
    Request {
        element,
        operation: Operation::Settable(attr, out),
    }
    .dispatch()
}

pub(super) unsafe fn set_attribute_value(
    element: Element,
    attr: CFStringRef,
    value: CFTypeRef,
) -> i32 {
    Request {
        element,
        operation: Operation::Set(attr, value),
    }
    .dispatch()
}

/// User input needs a final revocation check after crossing the main queue.
/// Observation-only AX enablement continues to use `set_attribute_value`.
pub(super) unsafe fn set_input_attribute_value(
    element: Element,
    attr: CFStringRef,
    value: CFTypeRef,
) -> i32 {
    Request {
        element,
        operation: Operation::SetInput(attr, value),
    }
    .dispatch()
}

pub(super) unsafe fn perform_action(element: Element, action: CFStringRef) -> i32 {
    Request {
        element,
        operation: Operation::Perform(action),
    }
    .dispatch()
}

pub(super) unsafe fn window_id(element: Element) -> Option<u32> {
    static LOOKUP: std::sync::OnceLock<Option<GetWindow>> = std::sync::OnceLock::new();
    let lookup = (*LOOKUP.get_or_init(|| {
        let symbol = unsafe { libc::dlsym(libc::RTLD_DEFAULT, c"_AXUIElementGetWindow".as_ptr()) };
        if symbol.is_null() {
            None
        } else {
            Some(unsafe { std::mem::transmute::<*mut c_void, GetWindow>(symbol) })
        }
    }))?;
    let mut window = 0;
    let status = Request {
        element,
        operation: Operation::Window(lookup, &mut window),
    }
    .dispatch();
    (status == 0).then_some(window)
}
