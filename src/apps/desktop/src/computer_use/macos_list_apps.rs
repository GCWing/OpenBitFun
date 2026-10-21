//! Fresh native GUI application discovery, without AppleScript or process scans.
//! Regular applications are discoverable even before they open a window;
//! accessory applications are included when WindowServer reports a real window.

use core_foundation::array::CFArray;
use core_foundation::base::{CFGetTypeID, CFTypeRef, TCFType};
use core_foundation::boolean::CFBoolean;
use core_foundation::dictionary::CFDictionary;
use core_foundation::number::CFNumber;
use core_foundation::string::CFString;
use objc2_app_kit::{NSApplicationActivationPolicy, NSRunningApplication, NSWorkspace};
use openbitfun_core::agentic::tools::computer_use_host::{
    AppInfo, AppWindowInfo, ComputerUseImageGlobalBounds,
};
use openbitfun_core::util::errors::{OpenBitFunError, OpenBitFunResult};
use std::collections::HashSet;
use std::ffi::c_void;

type Dictionary = CFDictionary<*const c_void, *const c_void>;

fn value(dictionary: &Dictionary, key: &str) -> Option<CFTypeRef> {
    let key = CFString::new(key);
    dictionary
        .find(key.as_concrete_TypeRef().cast())
        .map(|value| *value)
}
fn number(dictionary: &Dictionary, key: &str) -> Option<f64> {
    let value = value(dictionary, key)?;
    if unsafe { CFGetTypeID(value) } != CFNumber::type_id() {
        return None;
    }
    unsafe { CFNumber::wrap_under_get_rule(value.cast()) }.to_f64()
}

pub(super) fn list_windows() -> OpenBitFunResult<Vec<AppWindowInfo>> {
    #[link(name = "CoreGraphics", kind = "framework")]
    unsafe extern "C" {
        fn CGWindowListCopyWindowInfo(
            options: u32,
            relative_to: u32,
        ) -> core_foundation::array::CFArrayRef;
    }
    // Include off-screen/minimized windows so include_hidden refers to an
    // application's hidden state rather than whichever Space is visible.
    let raw = unsafe { CGWindowListCopyWindowInfo(16, 0) };
    if raw.is_null() {
        return Err(OpenBitFunError::tool(
            "APP_DISCOVERY_UNAVAILABLE: WindowServer application inventory is unavailable",
        ));
    }
    let windows: CFArray<CFTypeRef> = unsafe { CFArray::wrap_under_create_rule(raw) };
    let mut targets = Vec::new();
    for window in windows.iter() {
        if unsafe { CFGetTypeID(*window) } != Dictionary::type_id() {
            continue;
        }
        let window = unsafe { Dictionary::wrap_under_get_rule((*window).cast()) };
        if number(&window, "kCGWindowLayer") != Some(0.0) {
            continue;
        }
        let Some(bounds) = value(&window, "kCGWindowBounds") else {
            continue;
        };
        if unsafe { CFGetTypeID(bounds) } != Dictionary::type_id() {
            continue;
        }
        let bounds = unsafe { Dictionary::wrap_under_get_rule(bounds.cast()) };
        let (Some(width), Some(height)) = (
            number(&bounds, "Width").filter(|width| *width > 0.0),
            number(&bounds, "Height").filter(|height| *height > 0.0),
        ) else {
            continue;
        };
        let frame = ComputerUseImageGlobalBounds {
            left: number(&bounds, "X").unwrap_or(0.0),
            top: number(&bounds, "Y").unwrap_or(0.0),
            width,
            height,
        };
        if let Some(pid) = number(&window, "kCGWindowOwnerPID").filter(|pid| *pid > 0.0) {
            let Some(id) = number(&window, "kCGWindowNumber").filter(|id| *id > 0.0) else {
                continue;
            };
            let string = |key: &str| {
                value(&window, key)
                    .filter(|value| unsafe { CFGetTypeID(*value) } == CFString::type_id())
                    .map(|value| unsafe { CFString::wrap_under_get_rule(value.cast()) }.to_string())
            };
            let app = NSRunningApplication::runningApplicationWithProcessIdentifier(pid as i32);
            let is_on_screen = value(&window, "kCGWindowIsOnscreen")
                .filter(|value| unsafe { CFGetTypeID(*value) } == CFBoolean::type_id())
                .map(|value| bool::from(unsafe { CFBoolean::wrap_under_get_rule(value.cast()) }));
            targets.push(AppWindowInfo {
                pid: pid as i32,
                window_id: id as u64,
                application: string("kCGWindowOwnerName")
                    .unwrap_or_else(|| format!("Application {}", pid as i32)),
                title: string("kCGWindowName").unwrap_or_default(),
                bundle_id: app
                    .and_then(|app| app.bundleIdentifier())
                    .map(|id| id.to_string()),
                is_on_screen,
                bounds: Some(frame),
            });
        }
    }
    Ok(targets)
}

/// Front-to-back same-process windows above `bound` that intersect `frame` and
/// are either on a raised layer (menus, popups, suggestion lists, floating
/// panels) or AppKit child windows of `bound`, which inherit its layer.
/// Other same-layer windows are independent surfaces, not overlays.
pub(super) fn overlays_above(
    pid: i32,
    bound: u32,
    frame: [f64; 4],
) -> Vec<super::overlay_windows::OverlayWindow> {
    #[link(name = "CoreGraphics", kind = "framework")]
    unsafe extern "C" {
        fn CGWindowListCopyWindowInfo(
            options: u32,
            relative_to: u32,
        ) -> core_foundation::array::CFArrayRef;
    }
    const ON_SCREEN_ABOVE_WINDOW: u32 = 1 << 1;
    const EXCLUDE_DESKTOP_ELEMENTS: u32 = 1 << 4;
    // Screen saver and assistive-technology levels and above are system chrome.
    const MAX_APP_LAYER: f64 = 1000.0;
    // SAFETY: plain CoreGraphics query; the result follows the create rule.
    let raw = unsafe {
        CGWindowListCopyWindowInfo(ON_SCREEN_ABOVE_WINDOW | EXCLUDE_DESKTOP_ELEMENTS, bound)
    };
    if raw.is_null() {
        return Vec::new();
    }
    // SAFETY: `raw` is a non-null owned CFArray from a Copy function.
    let windows: CFArray<CFTypeRef> = unsafe { CFArray::wrap_under_create_rule(raw) };
    let mut children: Option<Vec<u32>> = None;
    let mut overlays = Vec::new();
    for window in windows.iter() {
        // SAFETY: array elements are valid CF objects owned by `windows`.
        if unsafe { CFGetTypeID(*window) } != Dictionary::type_id() {
            continue;
        }
        // SAFETY: the type id was checked above; the get rule retains it.
        let window = unsafe { Dictionary::wrap_under_get_rule((*window).cast()) };
        if number(&window, "kCGWindowOwnerPID") != Some(pid as f64) {
            continue;
        }
        let Some(id) = number(&window, "kCGWindowNumber").filter(|id| *id > 0.0) else {
            continue;
        };
        if id as u32 == bound {
            continue;
        }
        let Some(layer) = number(&window, "kCGWindowLayer").filter(|layer| *layer < MAX_APP_LAYER)
        else {
            continue;
        };
        if layer <= 0.0
            && !children
                .get_or_insert_with(|| {
                    super::macos_skylight::child_windows(bound).unwrap_or_default()
                })
                .contains(&(id as u32))
        {
            continue;
        }
        if number(&window, "kCGWindowAlpha").is_some_and(|alpha| alpha <= 0.0) {
            continue;
        }
        // SAFETY: dictionary values are valid CF objects owned by `window`;
        // the type id is checked before wrapping under the get rule.
        let Some(bounds) = value(&window, "kCGWindowBounds")
            .filter(|bounds| unsafe { CFGetTypeID(*bounds) } == Dictionary::type_id())
            .map(|bounds| unsafe { Dictionary::wrap_under_get_rule(bounds.cast()) })
        else {
            continue;
        };
        let rect = [
            number(&bounds, "X").unwrap_or(0.0),
            number(&bounds, "Y").unwrap_or(0.0),
            number(&bounds, "Width").unwrap_or(0.0),
            number(&bounds, "Height").unwrap_or(0.0),
        ];
        if rect[2] < 2.0 || rect[3] < 2.0 || !super::overlay_windows::intersects(rect, frame) {
            continue;
        }
        // SAFETY: as for `bounds`, checked to be a CFString before wrapping.
        let title = value(&window, "kCGWindowName")
            .filter(|value| unsafe { CFGetTypeID(*value) } == CFString::type_id())
            .map(|value| unsafe { CFString::wrap_under_get_rule(value.cast()) }.to_string())
            .filter(|title| !title.is_empty());
        overlays.push(super::overlay_windows::OverlayWindow {
            window_id: id as u64,
            bounds: rect,
            layer: Some(layer as i32),
            title,
        });
        if overlays.len() == super::overlay_windows::MAX_OVERLAYS {
            break;
        }
    }
    overlays
}

pub(super) fn list_share_targets(
) -> OpenBitFunResult<Vec<openbitfun_agent_tools::computer_use_control::ShareTarget>> {
    Ok(list_windows()?
        .into_iter()
        .map(
            |window| openbitfun_agent_tools::computer_use_control::ShareTarget {
                selection_id: String::new(),
                unavailable_reason: None,
                id: format!("pid:{}/window:{}", window.pid, window.window_id),
                pid: Some(window.pid),
                window_id: Some(window.window_id),
                application: window.application,
                title: window.title,
                bundle_id: window.bundle_id,
                background_pointer: true,
                background_semantic: true,
                selection_required: false,
            },
        )
        .collect())
}

fn window_owners() -> OpenBitFunResult<HashSet<i32>> {
    Ok(list_share_targets()?
        .into_iter()
        .filter_map(|window| window.pid)
        .collect())
}

fn include_application(
    policy: NSApplicationActivationPolicy,
    owns_window: bool,
    hidden: bool,
    include_hidden: bool,
) -> bool {
    (policy == NSApplicationActivationPolicy::Regular
        || (policy == NSApplicationActivationPolicy::Accessory && owns_window))
        && (include_hidden || !hidden)
}

pub(super) fn list_running_apps(include_hidden: bool) -> OpenBitFunResult<Vec<AppInfo>> {
    let owners = window_owners()?;
    let applications = NSWorkspace::sharedWorkspace().runningApplications();
    let mut apps = Vec::new();
    for app in applications.iter() {
        let pid = app.processIdentifier();
        if pid <= 0
            || app.isTerminated()
            || !include_application(
                app.activationPolicy(),
                owners.contains(&pid),
                app.isHidden(),
                include_hidden,
            )
        {
            continue;
        }
        let bundle_id = app.bundleIdentifier().map(|value| value.to_string());
        let name = app
            .localizedName()
            .map(|value| value.to_string())
            .filter(|value| !value.trim().is_empty())
            .or_else(|| bundle_id.clone())
            .unwrap_or_else(|| format!("Application {pid}"));
        apps.push(AppInfo {
            name,
            bundle_id,
            pid: Some(pid),
            running: true,
            last_used_ms: None,
            launch_count: 0,
        });
    }
    apps.sort_by(|a, b| {
        a.name
            .to_lowercase()
            .cmp(&b.name.to_lowercase())
            .then(a.pid.cmp(&b.pid))
    });
    Ok(apps)
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn native_discovery_includes_windowed_accessories_but_not_daemons() {
        assert!(include_application(
            NSApplicationActivationPolicy::Regular,
            false,
            false,
            false
        ));
        assert!(include_application(
            NSApplicationActivationPolicy::Accessory,
            true,
            false,
            false
        ));
        assert!(!include_application(
            NSApplicationActivationPolicy::Accessory,
            false,
            false,
            true
        ));
        assert!(!include_application(
            NSApplicationActivationPolicy::Prohibited,
            true,
            false,
            true
        ));
    }
    #[test]
    fn hidden_filter_is_independent_of_activation_policy() {
        for policy in [
            NSApplicationActivationPolicy::Regular,
            NSApplicationActivationPolicy::Accessory,
        ] {
            assert!(!include_application(policy, true, true, false));
            assert!(include_application(policy, true, true, true));
        }
    }
}
