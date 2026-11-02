//! OS consent adapters. All probes are read-only; only request() may prompt.
use openbitfun_agent_tools::computer_use_permissions::{
    ComputerPermission, ComputerPermissionKind as Kind, ComputerPermissionReceipt,
    ComputerPermissionState as State, ComputerPermissions,
};

const KINDS: [Kind; 4] = [
    Kind::Accessibility,
    Kind::ScreenRecording,
    Kind::InputPosting,
    Kind::InputMonitoring,
];

pub async fn status() -> ComputerPermissions {
    let permissions = platform_status().await;
    ComputerPermissions {
        platform: std::env::consts::OS.into(),
        process_id: std::process::id(),
        executable: std::env::current_exe()
            .ok()
            .map(|path| path.display().to_string()),
        permissions,
        prompts_requested: false,
    }
}

pub async fn request(kind: Kind) -> Result<ComputerPermissionReceipt, String> {
    let before = status().await;
    let already_granted = before.usable(kind);
    #[cfg(target_os = "macos")]
    let api_returned_granted = if already_granted {
        None
    } else {
        Some(
            tokio::task::spawn_blocking(move || macos::request(kind))
                .await
                .map_err(|e| e.to_string())?,
        )
    };
    #[cfg(not(target_os = "macos"))]
    let api_returned_granted: Option<bool> = None;
    let after = status().await;
    let current_granted = after.usable(kind);
    let permission = after
        .permissions
        .into_iter()
        .find(|permission| permission.kind == kind)
        .ok_or("[PERMISSION_UNAVAILABLE] No permission provider")?;
    Ok(ComputerPermissionReceipt {
        kind, already_granted, current_granted,
        request_api_invoked: api_returned_granted.is_some(),
        prompt_requested: api_returned_granted.is_some(),
        prompt_visibility_observed: false,
        requires_user_action: !current_granted,
        restart_may_be_required: cfg!(target_os = "macos") && !already_granted,
        api_returned_granted, permission,
        permission_owner: if cfg!(target_os = "macos") {
            "macOS chooses the responsible executable. Requesting does not grant access or prove a visible prompt."
        } else if cfg!(target_os = "linux") {
            "The desktop portal grants a selected session when sharing starts. AT-SPI access belongs to the desktop user."
        } else {
            "Windows desktop, capture policy and target integrity level govern access. There is no application-wide consent prompt."
        }.into(),
    })
}

#[cfg(target_os = "macos")]
async fn platform_status() -> Vec<ComputerPermission> {
    KINDS.into_iter().map(|kind| ComputerPermission {
        kind,
        state: if macos::granted(kind) { State::Granted } else { State::Required },
        requestable: true,
        settings_url: Some(macos::settings_url(kind).into()),
        detail: match kind {
            Kind::Accessibility => "Required for application accessibility and semantic controls.",
            Kind::ScreenRecording => "Required for the selected application's window capture.",
            Kind::InputPosting => "Required for directed input; does not authorize foreground input.",
            Kind::InputMonitoring => "Optional diagnostic capability; normal sharing does not request global input monitoring.",
        }.into(),
    }).collect()
}

#[cfg(target_os = "windows")]
async fn platform_status() -> Vec<ComputerPermission> {
    let capture =
        windows::Graphics::Capture::GraphicsCaptureSession::IsSupported().unwrap_or(false);
    KINDS.into_iter().map(|kind| ComputerPermission {
        kind, requestable: false, settings_url: None,
        state: if kind == Kind::ScreenRecording && !capture { State::Unavailable } else { State::NotRequired },
        detail: if kind == Kind::ScreenRecording {
            "Windows Graphics Capture availability is a capability probe. A protected window or desktop can still refuse capture."
        } else if kind == Kind::InputMonitoring {
            "Global input monitoring is not required."
        } else {
            "Windows has no consent prompt for this route. UIPI, the target's integrity level and session isolation are checked per operation."
        }.into(),
    }).collect()
}

#[cfg(target_os = "linux")]
async fn platform_status() -> Vec<ComputerPermission> {
    // Opening the accessibility bus and reading the registry does not request
    // portal selection or seat input. Do not infer consent from DISPLAY.
    let accessible = match atspi::AccessibilityConnection::new().await {
        Ok(connection) => connection.root_accessible_on_registry().await.is_ok(),
        Err(_) => false,
    };
    let portal_active = super::linux_control::session_is_active();
    let portal_input = super::linux_control::session_has_input_consent();
    KINDS.into_iter().map(|kind| ComputerPermission {
        kind, requestable: false, settings_url: None,
        state: match kind {
            Kind::Accessibility if accessible => State::Granted,
            Kind::Accessibility => State::Unavailable,
            Kind::ScreenRecording if portal_active => State::Granted,
            Kind::ScreenRecording => State::SessionRequired,
            Kind::InputPosting if portal_input => State::Granted,
            Kind::InputPosting => State::SessionRequired,
            Kind::InputMonitoring => State::NotRequired,
        },
        detail: match kind {
            Kind::Accessibility => "AT-SPI provides background semantic actions for accessible applications; it does not provide arbitrary background coordinates.",
            Kind::ScreenRecording => "Start sharing to open the desktop portal's window selector. Consent is limited to that native session.",
            Kind::InputPosting => "Portal seat input requires an explicitly authorized foreground session. Background input is limited to AT-SPI semantic actions.",
            Kind::InputMonitoring => "Global input monitoring is not required.",
        }.into(),
    }).collect()
}

#[cfg(not(any(target_os = "macos", target_os = "windows", target_os = "linux")))]
async fn platform_status() -> Vec<ComputerPermission> {
    KINDS
        .into_iter()
        .map(|kind| ComputerPermission {
            kind,
            state: State::Unavailable,
            requestable: false,
            settings_url: None,
            detail: "No native Computer Use provider for this platform.".into(),
        })
        .collect()
}

#[cfg(target_os = "macos")]
pub(crate) mod macos {
    use super::Kind;
    use core_foundation::{
        base::TCFType, boolean::CFBoolean, dictionary::CFDictionary, string::CFString,
    };
    #[link(name = "ApplicationServices", kind = "framework")]
    unsafe extern "C" {
        fn AXIsProcessTrusted() -> bool;
        fn AXIsProcessTrustedWithOptions(options: *const std::ffi::c_void) -> bool;
        fn CGPreflightScreenCaptureAccess() -> bool;
        fn CGRequestScreenCaptureAccess() -> bool;
        fn CGPreflightPostEventAccess() -> bool;
        fn CGRequestPostEventAccess() -> bool;
        fn CGPreflightListenEventAccess() -> bool;
        fn CGRequestListenEventAccess() -> bool;
    }
    pub(crate) fn granted(kind: Kind) -> bool {
        unsafe {
            match kind {
                Kind::Accessibility => AXIsProcessTrusted(),
                Kind::ScreenRecording => CGPreflightScreenCaptureAccess(),
                Kind::InputPosting => CGPreflightPostEventAccess(),
                Kind::InputMonitoring => CGPreflightListenEventAccess(),
            }
        }
    }
    pub(crate) fn request(kind: Kind) -> bool {
        if granted(kind) {
            return true;
        }
        unsafe {
            match kind {
                Kind::Accessibility => {
                    let key = CFString::new("AXTrustedCheckOptionPrompt");
                    let value = CFBoolean::true_value();
                    let options =
                        CFDictionary::from_CFType_pairs(&[(key.as_CFType(), value.as_CFType())]);
                    AXIsProcessTrustedWithOptions(options.as_concrete_TypeRef() as *const _)
                }
                Kind::ScreenRecording => CGRequestScreenCaptureAccess(),
                Kind::InputPosting => CGRequestPostEventAccess(),
                Kind::InputMonitoring => CGRequestListenEventAccess(),
            }
        }
    }
    pub(crate) const fn settings_url(kind: Kind) -> &'static str {
        match kind {
            Kind::Accessibility | Kind::InputPosting => {
                "x-apple.systempreferences:com.apple.preference.security?Privacy_Accessibility"
            }
            Kind::ScreenRecording => {
                "x-apple.systempreferences:com.apple.preference.security?Privacy_ScreenCapture"
            }
            Kind::InputMonitoring => {
                "x-apple.systempreferences:com.apple.preference.security?Privacy_ListenEvent"
            }
        }
    }
}
