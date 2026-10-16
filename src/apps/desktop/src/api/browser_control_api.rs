//! Browser control API — Tauri commands for CDP-based browser control.

use openbitfun_core::agentic::tools::browser_control::browser_launcher::{
    BrowserKind, BrowserLauncher, LaunchResult, DEFAULT_CDP_PORT,
};
use openbitfun_core::agentic::tools::browser_control::cdp_client::CdpClient;
use openbitfun_core::agentic::tools::implementations::control_hub_tool::disconnect_external_browser;
use openbitfun_core::service::config::{get_global_config_service, GlobalConfig};
use serde::{Deserialize, Serialize};

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct BrowserControlStatusRequest {
    #[serde(default = "default_cdp_port")]
    pub port: u16,
}

fn default_cdp_port() -> u16 {
    DEFAULT_CDP_PORT
}

/// Reattach to a browser that is already running with remote debugging on.
///
/// The browser remembers the remote debugging preference across its own
/// restarts, and it keeps an approved connection grant for as long as it stays
/// running — but OpenBitFun's connection registry lives in this process, so every
/// OpenBitFun restart otherwise leaves Settings reporting "not connected" until
/// something asks for the browser. Reattaching here restores that connection
/// without the user having to click anything.
///
/// Opt-in, because the grant does not survive a browser restart: after one,
/// reattaching raises an approval dialog before the user has asked for the
/// browser at all.
///
/// This never starts a browser and never opens a settings page: when there is
/// no live endpoint to reattach to, it does nothing and leaves the on-demand
/// path to handle it.
pub fn init_on_startup() {
    tokio::spawn(async {
        if !auto_connect_on_startup_enabled().await {
            return;
        }
        let Ok(kind) = selected_browser_kind().await else {
            return;
        };
        let Some(endpoint) = BrowserLauncher::user_profile_debug_endpoint(&kind) else {
            return;
        };
        if CdpClient::browser_connection_for_kind(DEFAULT_CDP_PORT, &kind)
            .await
            .is_some()
        {
            return;
        }
        // A denial or an approval timeout is an ordinary outcome here, not an
        // error worth surfacing: the user never asked for this connection.
        match CdpClient::connect_user_profile_browser(
            DEFAULT_CDP_PORT,
            endpoint.port,
            &kind,
            &endpoint.web_socket_url,
        )
        .await
        {
            Ok(_) => log::info!("Reattached to the running {} profile on startup", kind),
            Err(error) => log::info!(
                "Could not reattach to the running {} profile on startup: {}",
                kind,
                error
            ),
        }
    });
}

async fn auto_connect_on_startup_enabled() -> bool {
    let Ok(service) = get_global_config_service().await else {
        return false;
    };
    service
        .get_config::<GlobalConfig>(None)
        .await
        .map(|config| config.ai.browser_control_auto_connect_on_startup)
        .unwrap_or(false)
}

async fn selected_browser_kind() -> Result<BrowserKind, String> {
    let config = get_global_config_service()
        .await
        .map_err(|e| e.to_string())?
        .get_config::<GlobalConfig>(None)
        .await
        .map_err(|e| e.to_string())?;
    BrowserLauncher::resolve_browser_kind(Some(&config.ai.browser_control_preferred_browser))
        .map_err(|e| e.to_string())
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct BrowserControlBrowserOption {
    pub value: String,
    pub label: String,
    pub installed: bool,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct BrowserControlBrowsersResponse {
    pub options: Vec<BrowserControlBrowserOption>,
}

/// List selectable browsers for CDP browser control.
#[tauri::command]
pub async fn browser_control_list_browsers() -> Result<BrowserControlBrowsersResponse, String> {
    let browsers = [
        ("default", "Default browser", true),
        (
            "chrome",
            "Google Chrome",
            BrowserLauncher::is_browser_installed(&BrowserKind::Chrome),
        ),
        (
            "edge",
            "Microsoft Edge",
            BrowserLauncher::is_browser_installed(&BrowserKind::Edge),
        ),
        (
            "brave",
            "Brave Browser",
            BrowserLauncher::is_browser_installed(&BrowserKind::Brave),
        ),
        (
            "chromium",
            "Chromium",
            BrowserLauncher::is_browser_installed(&BrowserKind::Chromium),
        ),
        (
            "arc",
            "Arc",
            BrowserLauncher::is_browser_installed(&BrowserKind::Arc),
        ),
    ];

    Ok(BrowserControlBrowsersResponse {
        options: browsers
            .into_iter()
            .map(|(value, label, installed)| BrowserControlBrowserOption {
                value: value.to_string(),
                label: label.to_string(),
                installed,
            })
            .collect(),
    })
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct BrowserControlStatusResponse {
    pub cdp_available: bool,
    pub default_cdp_supported: bool,
    pub default_cdp_enabled: bool,
    /// Browser-owned settings URL for the guarded user-profile CDP flow. The
    /// UI always displays it while setup is pending so the user can recover if
    /// the platform-specific automatic open did not produce the right tab.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub setup_url: Option<String>,
    /// The selected browser is running with remote debugging on, so OpenBitFun can
    /// attach whenever it needs to. Distinguishes "ready, nothing attached yet"
    /// from "nothing to attach to", which both used to read as "not connected".
    pub browser_ready: bool,
    pub browser_kind: String,
    pub browser_version: Option<String>,
    pub port: u16,
    pub page_count: usize,
}

/// Check CDP browser control status.
#[tauri::command]
pub async fn browser_control_get_status(
    request: BrowserControlStatusRequest,
) -> Result<BrowserControlStatusResponse, String> {
    let port = request.port;
    let configured_kind = selected_browser_kind().await?;
    let default_cdp_supported = BrowserLauncher::supports_default_cdp(&configured_kind);
    // Probe the live endpoint once and answer both questions from it: whether
    // the persistent setting is on, and whether there is something to attach to
    // right now. The probe is a file read plus a short local TCP connect, so it
    // never prompts the browser the way attaching does.
    let user_profile_endpoint = BrowserLauncher::user_profile_debug_endpoint(&configured_kind);
    let default_cdp_enabled = default_cdp_supported
        && (user_profile_endpoint.is_some()
            || BrowserLauncher::is_default_cdp_enabled(&configured_kind));
    let user_profile_connection =
        CdpClient::browser_connection_for_kind(port, &configured_kind).await;
    let browser_connection_suppressed = CdpClient::browser_connection_suppressed(port).await;
    let legacy_version =
        if user_profile_connection.is_none() && BrowserLauncher::is_cdp_available(port).await {
            CdpClient::get_version(port).await.ok()
        } else {
            None
        };
    // Chrome and Edge share the logical 9222 slot in Settings. Do not report
    // the selected browser as connected merely because the other one owns a
    // legacy fixed-port endpoint left from an earlier selection.
    let legacy_matches_selection = legacy_version.as_ref().is_some_and(|version| {
        let detected = version
            .browser
            .as_deref()
            .and_then(BrowserLauncher::browser_kind_from_cdp_version);
        match &configured_kind {
            BrowserKind::Chrome | BrowserKind::Edge => {
                detected.map(|kind| kind == configured_kind).unwrap_or(true)
            }
            _ => true,
        }
    });
    // A listening debug port is ready, not connected on the user's behalf.
    // Keep the UI's Connect action available until its grant exists, matching
    // the Agent's access gate rather than showing a misleading Connected state.
    let legacy_authorized =
        CdpClient::authorized_browser_kind(port).await.as_ref() == Some(&configured_kind);
    let available = !browser_connection_suppressed
        && (user_profile_connection.is_some() || (legacy_matches_selection && legacy_authorized));
    let browser_ready = available || user_profile_endpoint.is_some() || legacy_matches_selection;

    let (version, page_count, actual_kind) = if available {
        let ver_info = if let Some(connection) = &user_profile_connection {
            connection.client.browser_version().await.ok()
        } else {
            legacy_version
        };
        let ver = ver_info.as_ref().and_then(|v| v.browser.clone());
        // Identify the actual browser from CDP version response.
        let kind = ver
            .as_deref()
            .and_then(BrowserLauncher::browser_kind_from_cdp_version)
            .unwrap_or_else(|| configured_kind.clone());
        // Only count targets of type "page" (real browser tabs),
        // not service workers, browser targets, etc.
        let pages = if let Some(connection) = &user_profile_connection {
            connection.client.browser_pages().await.ok()
        } else {
            CdpClient::list_pages(port).await.ok()
        }
        .map(|p| {
            p.iter()
                .filter(|t| t.page_type.as_deref() == Some("page"))
                .count()
        })
        .unwrap_or(0);
        (ver, pages, kind)
    } else {
        (None, 0, configured_kind)
    };

    Ok(BrowserControlStatusResponse {
        cdp_available: available,
        default_cdp_supported,
        default_cdp_enabled,
        setup_url: BrowserLauncher::user_profile_debugging_setup_url(&actual_kind)
            .map(str::to_string),
        browser_ready,
        browser_kind: actual_kind.to_string(),
        browser_version: version,
        port,
        page_count,
    })
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct BrowserControlLaunchRequest {
    #[serde(default = "default_cdp_port")]
    pub port: u16,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct BrowserControlLaunchResponse {
    pub success: bool,
    pub status: String,
    pub message: Option<String>,
    pub browser_kind: String,
    /// Remote debugging settings URL, sent when the user has to open it
    /// themselves because the platform cannot open a `chrome://` URL for them.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub setup_url: Option<String>,
}

fn to_launch_response(kind: &BrowserKind, result: LaunchResult) -> BrowserControlLaunchResponse {
    match result {
        LaunchResult::AlreadyConnected => BrowserControlLaunchResponse {
            success: true,
            status: "already_connected".into(),
            message: None,
            browser_kind: kind.to_string(),
            setup_url: None,
        },
        LaunchResult::Launched => BrowserControlLaunchResponse {
            success: true,
            status: "launched".into(),
            message: None,
            browser_kind: kind.to_string(),
            setup_url: None,
        },
        LaunchResult::UserProfileReady { .. } => BrowserControlLaunchResponse {
            success: false,
            status: "user_profile_ready".into(),
            message: None,
            browser_kind: kind.to_string(),
            setup_url: None,
        },
        LaunchResult::UserProfileSetupRequired {
            instructions,
            setup_url,
            opened,
            ..
        } => BrowserControlLaunchResponse {
            success: false,
            // The two cases need different guidance: one asks the user to
            // finish on a page that is already in front of them, the other
            // asks them to open that page first.
            status: if opened {
                "requires_user_profile_setup".into()
            } else {
                "requires_manual_user_profile_setup".into()
            },
            message: Some(instructions),
            browser_kind: kind.to_string(),
            setup_url: Some(setup_url),
        },
        LaunchResult::LaunchedButCdpNotReady { message, .. } => BrowserControlLaunchResponse {
            success: false,
            status: "cdp_not_ready".into(),
            message: Some(message),
            browser_kind: kind.to_string(),
            setup_url: None,
        },
        LaunchResult::BrowserRunningWithoutCdp { instructions, .. } => {
            BrowserControlLaunchResponse {
                success: false,
                status: "needs_restart".into(),
                message: Some(instructions),
                browser_kind: kind.to_string(),
                setup_url: None,
            }
        }
    }
}

async fn complete_launch(
    kind: &BrowserKind,
    logical_port: u16,
    result: LaunchResult,
) -> Result<BrowserControlLaunchResponse, String> {
    match result {
        LaunchResult::UserProfileReady { endpoint } => {
            let connection = CdpClient::connect_user_profile_browser(
                logical_port,
                endpoint.port,
                kind,
                &endpoint.web_socket_url,
            )
            .await;
            if let Err(error) = connection {
                return Ok(BrowserControlLaunchResponse {
                    success: false,
                    status: "user_profile_connection_failed".into(),
                    message: Some(error.to_string()),
                    browser_kind: kind.to_string(),
                    setup_url: None,
                });
            }
            Ok(BrowserControlLaunchResponse {
                success: true,
                status: "connected_user_profile".into(),
                message: None,
                browser_kind: kind.to_string(),
                setup_url: None,
            })
        }
        other => {
            let response = to_launch_response(kind, other);
            if response.success {
                CdpClient::authorize_legacy_browser(logical_port, kind).await;
            }
            Ok(response)
        }
    }
}

/// Launch the user's default browser with CDP debug port.
#[tauri::command]
pub async fn browser_control_launch(
    request: BrowserControlLaunchRequest,
) -> Result<BrowserControlLaunchResponse, String> {
    let port = request.port;
    let kind = selected_browser_kind().await?;
    if CdpClient::authorized_browser_kind(port)
        .await
        .is_some_and(|connected| connected != kind)
    {
        // Switching the selected browser revokes its previous page bindings,
        // even if the replacement connection subsequently fails.
        disconnect_external_browser(port).await;
    }
    CdpClient::allow_browser_connection(port).await;

    if CdpClient::browser_connection_for_kind(port, &kind)
        .await
        .is_some()
    {
        return Ok(to_launch_response(&kind, LaunchResult::AlreadyConnected));
    }

    let result = BrowserLauncher::launch_with_cdp(&kind, port)
        .await
        .map_err(|e| e.to_string())?;

    complete_launch(&kind, port, result).await
}

/// Open the selected browser's persistent guarded-CDP setting and wait for the
/// user-owned consent toggle. Once enabled, immediately request and retain the
/// real-profile connection so the Settings action is one continuous flow.
#[tauri::command]
pub async fn browser_control_enable_default_cdp(
    request: BrowserControlLaunchRequest,
) -> Result<BrowserControlLaunchResponse, String> {
    let port = request.port;
    let kind = selected_browser_kind().await?;
    if CdpClient::authorized_browser_kind(port)
        .await
        .is_some_and(|connected| connected != kind)
    {
        disconnect_external_browser(port).await;
    }
    CdpClient::allow_browser_connection(port).await;

    if !BrowserLauncher::supports_default_cdp(&kind) {
        return Ok(BrowserControlLaunchResponse {
            success: false,
            status: "default_cdp_unsupported".into(),
            message: Some(format!(
                "{} does not expose a supported persistent guarded-CDP setting",
                kind
            )),
            browser_kind: kind.to_string(),
            setup_url: None,
        });
    }

    if CdpClient::browser_connection_for_kind(port, &kind)
        .await
        .is_some()
    {
        return Ok(to_launch_response(&kind, LaunchResult::AlreadyConnected));
    }
    let result = BrowserLauncher::enable_default_cdp(&kind, port)
        .await
        .map_err(|e| e.to_string())?;
    complete_launch(&kind, port, result).await
}

/// Restart the user's default browser with CDP debug port enabled.
#[tauri::command]
pub async fn browser_control_restart_with_cdp(
    request: BrowserControlLaunchRequest,
) -> Result<BrowserControlLaunchResponse, String> {
    let port = request.port;
    let kind = selected_browser_kind().await?;
    disconnect_external_browser(port).await;
    CdpClient::allow_browser_connection(port).await;

    let result = BrowserLauncher::restart_with_cdp(&kind, port)
        .await
        .map_err(|e| e.to_string())?;

    complete_launch(&kind, port, result).await
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct BrowserControlDisconnectResponse {
    pub success: bool,
    pub status: String,
    pub browser_kind: String,
}

/// Detach OpenBitFun from the selected browser without closing browser tabs or
/// changing the browser-owned Remote debugging preference.
#[tauri::command]
pub async fn browser_control_disconnect(
    request: BrowserControlLaunchRequest,
) -> Result<BrowserControlDisconnectResponse, String> {
    let kind = selected_browser_kind().await?;
    let disconnected_count = disconnect_external_browser(request.port).await;

    Ok(BrowserControlDisconnectResponse {
        success: true,
        status: if disconnected_count > 0 {
            "disconnected".into()
        } else {
            "already_disconnected".into()
        },
        browser_kind: kind.to_string(),
    })
}
