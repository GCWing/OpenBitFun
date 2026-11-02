//! SkyLight SPI bridge — private macOS framework symbols for background input.
//!
//! Two-layer story:
//!
//! 1. **Post path** — `SLEventPostToPid` goes through `SLEventPostToPSN` →
//!    `CGSTickleActivityMonitor` → `SLSUpdateSystemActivityWithLocation` →
//!    `IOHIDPostEvent`. The public `CGEventPostToPid` skips the activity-monitor
//!    tickle so Chromium/Catalyst targets don't accept those events as live input.
//!
//! 2. **Authentication** (keyboard only) — on macOS 14+, WindowServer gates
//!    synthetic keyboard events on Chromium-like targets on an attached
//!    `SLSEventAuthenticationMessage`. We build one via the ObjC factory and
//!    attach it with `SLEventSetAuthenticationMessage` before posting.
//!
//! All symbols are resolved once at first use via `dlopen` + `dlsym`.
//! If anything fails to resolve, the functions return `false` and callers
//! fall back to the public `CGEvent::post_to_pid`.
//!
//! Ported from cua-driver-rs `platform-macos/src/input/skylight.rs` (v0.6.8),
//! adapted to OpenBitFun's error types and logging conventions.

#![allow(dead_code)]

use std::ffi::{c_void, CStr};
use std::os::raw::{c_char, c_int, c_uint};
use std::sync::OnceLock;

// ── Function-pointer typedefs ──────────────────────────────────────────────

/// `void SLEventPostToPid(pid_t, CGEventRef)`
type PostToPidFn = unsafe extern "C" fn(i32, *mut c_void);

/// `void SLEventSetAuthenticationMessage(CGEventRef, id)`
type SetAuthMsgFn = unsafe extern "C" fn(*mut c_void, *mut c_void);

/// `void CGEventSetWindowLocation(CGEventRef, double x, double y)`
///
/// NOTE: CGPoint on 64-bit ARM/x86 is two f64 values packed consecutively.
/// We pass them as two separate f64 arguments which has identical ABI.
type SetWindowLocFn = unsafe extern "C" fn(*mut c_void, f64, f64);

/// `void SLEventSetIntegerValueField(CGEventRef, uint32_t field, int64_t value)`
type SetIntFieldFn = unsafe extern "C" fn(*mut c_void, u32, i64);

/// `uint32_t CGSMainConnectionID(void)`
type ConnectionIDFn = unsafe extern "C" fn() -> u32;

/// `CFArrayRef SLSCopyAssociatedWindows(int cid, uint32_t wid)` — the window's
/// AppKit child-window group (children and the window itself), any owner.
type CopyAssociatedWindowsFn = unsafe extern "C" fn(u32, u32) -> *const c_void;

// ── NSMenu shortcut activation SPIs ──────────────────────────────────────────

// ── Focus-without-raise SPIs ──────────────────────────────────────────────────

/// `OSStatus SLPSPostEventRecordTo(const void *psn, const uint8_t *bytes)`
/// Posts a 248-byte synthetic event record into the target process's Carbon
/// event queue. Build the buffer with bytes[0x04]=0xf8, bytes[0x08]=0x0d,
/// target window id at bytes 0x3c-0x3f (little-endian), focus/defocus marker
/// at bytes[0x8a] (0x01 = focus, 0x02 = defocus), all other bytes zero.
type PostEventRecordToFn = unsafe extern "C" fn(*const c_void, *const u8) -> i32;

/// `OSStatus _SLPSGetFrontProcess(void *psn)`
type GetFrontProcessFn = unsafe extern "C" fn(*mut c_void) -> i32;

/// `OSStatus GetProcessForPID(pid_t, void *psn)`
type GetProcessForPIDFn = unsafe extern "C" fn(i32, *mut c_void) -> i32;

/// Factory: `+[SLSEventAuthenticationMessage messageWithEventRecord:pid:version:]`
type FactoryMsgSendFn = unsafe extern "C" fn(
    *mut c_void, // Class (receiver)
    *mut c_void, // SEL
    *mut c_void, // SLSEventRecord*
    c_int,       // pid
    c_uint,      // version
) -> *mut c_void;

// ── Symbol resolution ──────────────────────────────────────────────────────

/// Load SkyLight once so all dlsym lookups via RTLD_DEFAULT find it.
fn ensure_skylight_loaded() {
    static LOADED: OnceLock<()> = OnceLock::new();
    LOADED.get_or_init(|| {
        let path = b"/System/Library/PrivateFrameworks/SkyLight.framework/SkyLight\0";
        unsafe {
            libc::dlopen(
                path.as_ptr() as *const c_char,
                libc::RTLD_LAZY | libc::RTLD_GLOBAL,
            );
        }
    });
}

/// Look up a symbol by name via RTLD_DEFAULT (after loading SkyLight).
fn find_sym(name: &[u8]) -> Option<*mut c_void> {
    ensure_skylight_loaded();
    let ptr = unsafe { libc::dlsym(libc::RTLD_DEFAULT, name.as_ptr() as *const c_char) };
    if ptr.is_null() {
        None
    } else {
        Some(ptr)
    }
}

/// Reinterpret a raw symbol pointer as a function pointer of type `T`.
///
/// # Safety
/// Caller guarantees T matches the symbol's actual signature.
unsafe fn as_fn<T: Copy>(ptr: *mut c_void) -> T {
    unsafe { std::mem::transmute_copy::<*mut c_void, T>(&ptr) }
}

// ── Lazily-resolved handles ────────────────────────────────────────────────

fn post_to_pid_fn() -> Option<PostToPidFn> {
    static SYM: OnceLock<Option<PostToPidFn>> = OnceLock::new();
    *SYM.get_or_init(|| find_sym(b"SLEventPostToPid\0").map(|p| unsafe { as_fn(p) }))
}

fn set_auth_msg_fn() -> Option<SetAuthMsgFn> {
    static SYM: OnceLock<Option<SetAuthMsgFn>> = OnceLock::new();
    *SYM.get_or_init(|| find_sym(b"SLEventSetAuthenticationMessage\0").map(|p| unsafe { as_fn(p) }))
}

fn set_window_loc_fn() -> Option<SetWindowLocFn> {
    static SYM: OnceLock<Option<SetWindowLocFn>> = OnceLock::new();
    *SYM.get_or_init(|| find_sym(b"CGEventSetWindowLocation\0").map(|p| unsafe { as_fn(p) }))
}

fn set_int_field_fn() -> Option<SetIntFieldFn> {
    static SYM: OnceLock<Option<SetIntFieldFn>> = OnceLock::new();
    *SYM.get_or_init(|| find_sym(b"SLEventSetIntegerValueField\0").map(|p| unsafe { as_fn(p) }))
}

fn connection_id_fn() -> Option<ConnectionIDFn> {
    static SYM: OnceLock<Option<ConnectionIDFn>> = OnceLock::new();
    *SYM.get_or_init(|| find_sym(b"CGSMainConnectionID\0").map(|p| unsafe { as_fn(p) }))
}

fn copy_associated_windows_fn() -> Option<CopyAssociatedWindowsFn> {
    static SYM: OnceLock<Option<CopyAssociatedWindowsFn>> = OnceLock::new();
    // SAFETY: `CopyAssociatedWindowsFn` matches the SPI's C signature.
    *SYM.get_or_init(|| find_sym(b"SLSCopyAssociatedWindows\0").map(|p| unsafe { as_fn(p) }))
}

fn factory_msg_send_fn() -> Option<FactoryMsgSendFn> {
    static SYM: OnceLock<Option<FactoryMsgSendFn>> = OnceLock::new();
    *SYM.get_or_init(|| find_sym(b"objc_msgSend\0").map(|p| unsafe { as_fn(p) }))
}

fn post_event_record_to_fn() -> Option<PostEventRecordToFn> {
    static SYM: OnceLock<Option<PostEventRecordToFn>> = OnceLock::new();
    *SYM.get_or_init(|| find_sym(b"SLPSPostEventRecordTo\0").map(|p| unsafe { as_fn(p) }))
}

fn get_front_process_fn() -> Option<GetFrontProcessFn> {
    static SYM: OnceLock<Option<GetFrontProcessFn>> = OnceLock::new();
    *SYM.get_or_init(|| find_sym(b"_SLPSGetFrontProcess\0").map(|p| unsafe { as_fn(p) }))
}

fn get_process_for_pid_fn() -> Option<GetProcessForPIDFn> {
    static SYM: OnceLock<Option<GetProcessForPIDFn>> = OnceLock::new();
    *SYM.get_or_init(|| find_sym(b"GetProcessForPID\0").map(|p| unsafe { as_fn(p) }))
}

/// `true` when `SLEventPostToPid` resolved.
pub(super) fn is_available() -> bool {
    post_to_pid_fn().is_some()
}

/// `true` when all three focus-without-raise SPIs resolved.
pub(super) fn is_focus_without_raise_available() -> bool {
    get_front_process_fn().is_some()
        && get_process_for_pid_fn().is_some()
        && post_event_record_to_fn().is_some()
}

// ── ObjC runtime helpers ───────────────────────────────────────────────────

fn objc_class(name: &CStr) -> *mut c_void {
    type GetClassFn = unsafe extern "C" fn(*const c_char) -> *mut c_void;
    static SYM: OnceLock<Option<GetClassFn>> = OnceLock::new();
    let f = *SYM.get_or_init(|| find_sym(b"objc_getClass\0").map(|p| unsafe { as_fn(p) }));
    match f {
        Some(f) => unsafe { f(name.as_ptr()) },
        None => std::ptr::null_mut(),
    }
}

fn sel_register(name: &CStr) -> *mut c_void {
    type SelRegFn = unsafe extern "C" fn(*const c_char) -> *mut c_void;
    static SYM: OnceLock<Option<SelRegFn>> = OnceLock::new();
    let f = *SYM.get_or_init(|| find_sym(b"sel_registerName\0").map(|p| unsafe { as_fn(p) }));
    match f {
        Some(f) => unsafe { f(name.as_ptr()) },
        None => std::ptr::null_mut(),
    }
}

/// Whether `cls` actually implements `sel`, via `class_respondsToSelector`.
///
/// macOS 14 (Sonoma) compatibility guard: `SLSEventAuthenticationMessage`
/// exists on macOS 14, but `messageWithEventRecord:pid:version:` was only
/// added in macOS 15 (Sequoia). `sel_registerName` always succeeds (it just
/// interns the string), so a `!sel.is_null()` check is not enough — we must
/// confirm the class responds before calling `objc_msgSend`.
fn class_responds_to_selector(cls: *mut c_void, sel: *mut c_void) -> bool {
    if cls.is_null() || sel.is_null() {
        return false;
    }
    type RespondsToFn = unsafe extern "C" fn(*mut c_void, *mut c_void) -> bool;
    static SYM: OnceLock<Option<RespondsToFn>> = OnceLock::new();
    let f =
        *SYM.get_or_init(|| find_sym(b"class_respondsToSelector\0").map(|p| unsafe { as_fn(p) }));
    match f {
        Some(f) => unsafe { f(cls, sel) },
        None => false,
    }
}

// The SPI copies a record into caller-owned storage and validates the event.
// Never probe opaque CGEvent object offsets: a different runtime layout can
// turn a non-null integer into a pointer and crash the automation host.
type CopyEventRecordFn = unsafe extern "C" fn(*mut c_void, *mut c_void, u32) -> i32;
#[repr(C, align(16))]
struct EventRecord([u8; 248]);
fn copy_event_record(event: *mut c_void) -> Option<EventRecord> {
    static COPY: OnceLock<Option<CopyEventRecordFn>> = OnceLock::new();
    let copy =
        (*COPY.get_or_init(|| find_sym(b"SLEventGetEventRecord\0").map(|p| unsafe { as_fn(p) })))?;
    if event.is_null() {
        return None;
    }
    let mut record = EventRecord([0; 248]);
    (unsafe { copy(event, record.0.as_mut_ptr().cast(), 248) } == 0).then_some(record)
}

// ── Public entry points ────────────────────────────────────────────────────

/// Post `event_ptr` (raw `CGEventRef`) to `pid` via `SLEventPostToPid`.
///
/// `attach_auth_message`: pass `true` for keyboard events (Chromium path),
/// `false` for mouse events.
///
/// Returns `true` when `SLEventPostToPid` resolved and the post was attempted.
/// Returns `false` when the SPI is absent — caller falls back to
/// `CGEvent::post_to_pid`.
pub(super) fn post_to_pid(pid: i32, event_ptr: *mut c_void, attach_auth_message: bool) -> bool {
    let post_fn = match post_to_pid_fn() {
        Some(f) => f,
        None => return false,
    };

    // Keep the owned record alive until event posting completes, even if a
    // framework version retains its address while creating authentication.
    let mut owned_record = if attach_auth_message {
        copy_event_record(event_ptr)
    } else {
        None
    };
    if attach_auth_message {
        let cls = objc_class(c"SLSEventAuthenticationMessage");
        let sel = sel_register(c"messageWithEventRecord:pid:version:");
        let factory = factory_msg_send_fn();

        if class_responds_to_selector(cls, sel) {
            if let Some(factory_fn) = factory {
                if let Some(record) = owned_record.as_mut() {
                    let msg = unsafe {
                        factory_fn(cls, sel, record.0.as_mut_ptr().cast(), pid as c_int, 0u32)
                    };
                    if !msg.is_null() {
                        if let Some(set_auth) = set_auth_msg_fn() {
                            unsafe { set_auth(event_ptr, msg) };
                        }
                    }
                }
            }
        }
    }

    unsafe { post_fn(pid, event_ptr) };
    true
}

/// Stamp a window-local `(x, y)` point onto `event_ptr` via the private
/// `CGEventSetWindowLocation` SPI. Returns `true` when the SPI resolved.
pub(super) fn set_window_location(event_ptr: *mut c_void, x: f64, y: f64) -> bool {
    match set_window_loc_fn() {
        Some(f) => {
            unsafe { f(event_ptr, x, y) };
            true
        }
        None => false,
    }
}

/// Stamp `value` onto `event_ptr` at raw SkyLight field index `field` via
/// `SLEventSetIntegerValueField`. Returns `false` when SPI absent.
pub(super) fn set_integer_field(event_ptr: *mut c_void, field: u32, value: i64) -> bool {
    match set_int_field_fn() {
        Some(f) => {
            unsafe { f(event_ptr, field, value) };
            true
        }
        None => false,
    }
}

/// Return the SkyLight main connection ID for the current process.
pub(super) fn main_connection_id() -> Option<u32> {
    connection_id_fn().map(|f| unsafe { f() })
}

/// Transitive AppKit child windows of `window`, excluding `window` itself.
/// `None` when the SPI is unavailable. Child windows inherit their parent's
/// level, so this is the only layer-independent way to recognize attached
/// popups from outside the owning process.
pub(super) fn child_windows(window: u32) -> Option<Vec<u32>> {
    use core_foundation::array::CFArray;
    use core_foundation::base::{CFGetTypeID, CFTypeRef, TCFType};
    use core_foundation::number::CFNumber;
    const MAX_CHILDREN: usize = 32;
    let copy = copy_associated_windows_fn()?;
    let connection = main_connection_id()?;
    let mut found = Vec::new();
    let mut pending = vec![window];
    while let Some(parent) = pending.pop() {
        // SAFETY: read-only WindowServer query on our own connection; the
        // result is null or an owned CFArray (create rule).
        let raw = unsafe { copy(connection, parent) };
        if raw.is_null() {
            continue;
        }
        // SAFETY: `raw` is a non-null owned CFArray.
        let group: CFArray<CFTypeRef> = unsafe { CFArray::wrap_under_create_rule(raw.cast()) };
        for item in group.iter() {
            // SAFETY: array elements are valid CF objects owned by `group`.
            if unsafe { CFGetTypeID(*item) } != CFNumber::type_id() {
                continue;
            }
            // SAFETY: the type id was checked above; the get rule retains it.
            let Some(id) = unsafe { CFNumber::wrap_under_get_rule((*item).cast()) }
                .to_i64()
                .and_then(|id| u32::try_from(id).ok())
            else {
                continue;
            };
            if id == window || id == parent || found.contains(&id) {
                continue;
            }
            found.push(id);
            pending.push(id);
            if found.len() == MAX_CHILDREN {
                return Some(found);
            }
        }
    }
    Some(found)
}

// ── Focus-without-raise ───────────────────────────────────────────────────────

/// Change only the target process's AppKit activation state. This does not
/// change WindowServer's front process, send a defocus event to the human's
/// application, order any window, or change Spaces. The caller owns lifecycle
/// cleanup and must validate the captured window before using this SPI.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub(super) struct ProcessIdentity(pub(super) [u32; 2]);

pub(super) fn process_identity(pid: i32) -> Option<ProcessIdentity> {
    let get = get_process_for_pid_fn()?;
    let mut psn = [0u32; 2];
    (unsafe { get(pid, psn.as_mut_ptr().cast()) } == 0).then_some(ProcessIdentity(psn))
}

/// Post to the retained process identity, never to a newly resolved PID owner.
pub(super) fn set_local_activation(identity: ProcessIdentity, window: u32, active: bool) -> bool {
    let Some(post) = post_event_record_to_fn() else {
        return false;
    };
    let mut record = [0u8; 248];
    record[4] = 248;
    record[8] = 13;
    record[0x3c..0x40].copy_from_slice(&window.to_le_bytes());
    record[0x8a] = if active { 1 } else { 2 };
    unsafe { post(identity.0.as_ptr().cast(), record.as_ptr()) == 0 }
}

/// Activate `target_pid`'s window `target_wid` without raising any windows
/// or triggering Space-follow. Ported from yabai's
/// `window_manager_focus_window_without_raise`.
///
/// Recipe:
/// 1. `_SLPSGetFrontProcess` -> capture current front PSN.
/// 2. `GetProcessForPID(target_pid)` -> target PSN.
/// 3. Post 248-byte defocus record to front PSN (`bytes[0x8a] = 0x02`).
/// 4. Post 248-byte focus record to target PSN (`bytes[0x8a] = 0x01`,
///    `bytes[0x3c..0x3f]` = `target_wid` little-endian).
///
/// Returns `true` when all SPIs resolved and both posts succeeded.
pub(super) fn activate_without_raise(target_pid: i32, target_wid: u32) -> bool {
    let post_fn = match post_event_record_to_fn() {
        Some(f) => f,
        None => return false,
    };
    let get_front = match get_front_process_fn() {
        Some(f) => f,
        None => return false,
    };
    let get_pid_psn = match get_process_for_pid_fn() {
        Some(f) => f,
        None => return false,
    };

    let mut prev_psn = [0u8; 8];
    let mut target_psn = [0u8; 8];

    let ok_prev = unsafe { get_front(prev_psn.as_mut_ptr() as *mut c_void) } == 0;
    if !ok_prev {
        return false;
    }

    let ok_target = unsafe { get_pid_psn(target_pid, target_psn.as_mut_ptr() as *mut c_void) } == 0;
    if !ok_target {
        return false;
    }

    let mut buf = [0u8; 0xF8];
    buf[0x04] = 0xF8;
    buf[0x08] = 0x0D;
    buf[0x3C] = (target_wid & 0xFF) as u8;
    buf[0x3D] = ((target_wid >> 8) & 0xFF) as u8;
    buf[0x3E] = ((target_wid >> 16) & 0xFF) as u8;
    buf[0x3F] = ((target_wid >> 24) & 0xFF) as u8;

    buf[0x8A] = 0x02;
    let defocus_ok = unsafe { post_fn(prev_psn.as_ptr() as *const c_void, buf.as_ptr()) == 0 };

    buf[0x8A] = 0x01;
    let focus_ok = unsafe { post_fn(target_psn.as_ptr() as *const c_void, buf.as_ptr()) == 0 };

    defocus_ok && focus_ok
}

#[cfg(test)]
mod event_record_tests {
    use super::*;
    use foreign_types::ForeignType;
    #[test]
    fn copy_owned_keyboard_record_without_posting_input() {
        assert!(copy_event_record(std::ptr::null_mut()).is_none());
        if find_sym(b"SLEventGetEventRecord\0").is_none() {
            return;
        }
        let event = core_graphics::event::CGEvent::new_keyboard_event(
            core_graphics::event_source::CGEventSource::new(
                core_graphics::event_source::CGEventSourceStateID::Private,
            )
            .unwrap(),
            0,
            true,
        )
        .unwrap();
        let record =
            copy_event_record(event.as_ptr().cast()).expect("valid local CGEvent must copy");
        assert!(record.0.iter().any(|value| *value != 0));
    }
}
