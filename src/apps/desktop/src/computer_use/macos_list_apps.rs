//! Fresh native GUI application discovery, without AppleScript or process scans.
//! Regular applications are discoverable even before they open a window;
//! accessory applications are included when WindowServer reports a real window.

use core_foundation::array::CFArray;
use core_foundation::base::{CFGetTypeID, CFTypeRef, TCFType};
use core_foundation::dictionary::CFDictionary;
use core_foundation::number::CFNumber;
use core_foundation::string::CFString;
use objc2_app_kit::{NSApplicationActivationPolicy, NSWorkspace};
use openbitfun_core::agentic::tools::computer_use_host::AppInfo;
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

fn window_owners() -> OpenBitFunResult<HashSet<i32>> {
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
    let mut owners = HashSet::new();
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
        if number(&bounds, "Width").is_none_or(|width| width <= 0.0)
            || number(&bounds, "Height").is_none_or(|height| height <= 0.0)
        {
            continue;
        }
        if let Some(pid) = number(&window, "kCGWindowOwnerPID").filter(|pid| *pid > 0.0) {
            owners.insert(pid as i32);
        }
    }
    Ok(owners)
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
