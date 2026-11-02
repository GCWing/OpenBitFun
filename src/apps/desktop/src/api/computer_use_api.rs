//! Tauri commands for Computer use (permissions + settings deep links).

use crate::api::app_state::AppState;
use openbitfun_agent_tools::computer_use_permissions::{
    ComputerPermissionKind, ComputerPermissionReceipt, ComputerPermissionRequest,
    ComputerPermissions,
};
use openbitfun_core::service::config::types::AIConfig;
use openbitfun_core::util::process_manager;
use serde::{Deserialize, Serialize};
use tauri::State;

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ComputerUseStatusResponse {
    pub computer_use_enabled: bool,
    pub accessibility_granted: bool,
    pub screen_capture_granted: bool,
    pub platform_note: Option<String>,
    pub permissions: ComputerPermissions,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ComputerUseOpenSettingsRequest {
    /// `accessibility` | `screen_capture`
    pub pane: String,
}

#[tauri::command]
pub async fn computer_use_get_status(
    state: State<'_, AppState>,
) -> Result<ComputerUseStatusResponse, String> {
    let ai: AIConfig = state
        .config_service
        .get_config(Some("ai"))
        .await
        .map_err(|e| e.to_string())?;

    let permissions = crate::computer_use::permissions::status().await;

    Ok(ComputerUseStatusResponse {
        computer_use_enabled: ai.computer_use_enabled,
        accessibility_granted: permissions.usable(ComputerPermissionKind::Accessibility),
        screen_capture_granted: permissions.usable(ComputerPermissionKind::ScreenRecording),
        platform_note: Some(
            permissions
                .permissions
                .iter()
                .map(|permission| permission.detail.as_str())
                .collect::<Vec<_>>()
                .join(" "),
        ),
        permissions,
    })
}

#[tauri::command]
pub async fn computer_use_request_permissions() -> Result<(), String> {
    // Compatibility command: older clients still invoke this from a user gesture.
    crate::computer_use::permissions::request(ComputerPermissionKind::Accessibility).await?;
    crate::computer_use::permissions::request(ComputerPermissionKind::ScreenRecording).await?;
    Ok(())
}

#[tauri::command]
pub async fn computer_use_request_permission(
    request: ComputerPermissionRequest,
) -> Result<ComputerPermissionReceipt, String> {
    crate::computer_use::permissions::request(request.kind).await
}

#[tauri::command]
pub async fn computer_use_open_system_settings(
    request: ComputerUseOpenSettingsRequest,
) -> Result<(), String> {
    #[cfg(target_os = "macos")]
    {
        let url = match request.pane.as_str() {
            "accessibility" | "input_posting" => {
                "x-apple.systempreferences:com.apple.preference.security?Privacy_Accessibility"
            }
            "screen_capture" | "screen_recording" => {
                "x-apple.systempreferences:com.apple.preference.security?Privacy_ScreenCapture"
            }
            "input_monitoring" => {
                "x-apple.systempreferences:com.apple.preference.security?Privacy_ListenEvent"
            }
            _ => return Err(format!("Unknown settings pane: {}", request.pane)),
        };
        process_manager::create_command("open")
            .arg(url)
            .status()
            .map_err(|e| e.to_string())?;
        Ok(())
    }
    #[cfg(target_os = "windows")]
    {
        let uri = match request.pane.as_str() {
            "accessibility" => "ms-settings:easeofaccess",
            "screen_capture" => "ms-settings:privacy",
            _ => return Err(format!("Unknown settings pane: {}", request.pane)),
        };
        process_manager::create_command("cmd")
            .args(["/C", "start", "", uri])
            .status()
            .map_err(|e| e.to_string())?;
        Ok(())
    }
    #[cfg(target_os = "linux")]
    {
        let _ = request;
        return Err(
            "Open system settings: use your desktop environment privacy settings.".to_string(),
        );
    }
    #[cfg(not(any(target_os = "macos", target_os = "windows", target_os = "linux")))]
    {
        let _ = request;
        Err("Unsupported platform.".to_string())
    }
}

/// Resource state is owned by the executing Desktop, not a newly constructed host.
#[tauri::command]
pub async fn computer_use_control_status(
) -> Result<openbitfun_agent_tools::computer_use_control::ControlSnapshot, String> {
    Ok(crate::computer_use::control_session::snapshot())
}
#[derive(Debug, Deserialize)]
pub struct ComputerUseControlRequest {
    pub generation: u64,
}
#[tauri::command]
pub async fn computer_use_control_stop(
    request: ComputerUseControlRequest,
) -> Result<openbitfun_agent_tools::computer_use_control::ControlSnapshot, String> {
    tokio::task::spawn_blocking(move || {
        crate::computer_use::control_session::stop_checked(
            None,
            Some(request.generation),
            "user_stopped",
        )
    })
    .await
    .map_err(|e| e.to_string())?
}
#[tauri::command]
pub async fn computer_use_control_preview(
    request: ComputerUseControlRequest,
) -> Result<Option<crate::computer_use::control_session::ControlPreview>, String> {
    crate::computer_use::control_session::preview(request.generation)
}

#[derive(Debug, Deserialize)]
pub struct ComputerUseShareStartRequest {
    pub generation: u64,
    pub target: String,
    #[serde(default)]
    pub mode: openbitfun_agent_tools::computer_use_control::ControlMode,
}
#[derive(Debug, Deserialize)]
pub struct ComputerUseShareControlRequest {
    pub generation: u64,
    pub target_revision: u64,
    pub authorization_revision: u64,
    pub enabled: bool,
    #[serde(default)]
    pub remember: bool,
}
#[tauri::command]
pub async fn computer_use_share_targets(
) -> Result<Vec<openbitfun_agent_tools::computer_use_control::ShareTarget>, String> {
    crate::computer_use::share_targets().await
}
#[tauri::command]
pub async fn computer_use_share_start(
    state: State<'_, AppState>,
    request: ComputerUseShareStartRequest,
) -> Result<openbitfun_agent_tools::computer_use_control::ControlSnapshot, String> {
    let snapshot = crate::computer_use::shared_preview::host()
        .share_selected_target(request.generation, &request.target, request.mode)
        .await?;
    crate::computer_use::share_grants::apply_remembered(computer_use_grants_path(&state), snapshot)
        .await
}
#[tauri::command]
pub async fn computer_use_share_control(
    state: State<'_, AppState>,
    request: ComputerUseShareControlRequest,
) -> Result<openbitfun_agent_tools::computer_use_control::ControlSnapshot, String> {
    let snapshot = crate::computer_use::control_session::set_share_control(
        request.generation,
        request.target_revision,
        request.authorization_revision,
        request.enabled,
    )?;
    if request.enabled && request.remember {
        crate::computer_use::share_grants::remember(computer_use_grants_path(&state), snapshot)
            .await
    } else {
        Ok(snapshot)
    }
}

fn computer_use_grants_path(state: &AppState) -> std::path::PathBuf {
    state
        .workspace_service
        .path_manager()
        .user_data_dir()
        .join("computer-use")
        .join("control-grants.json")
}

#[derive(Debug, Deserialize)]
pub struct ComputerUseShareRequest {
    #[serde(default)]
    pub owner: Option<String>,
    #[serde(default)]
    pub mode: openbitfun_agent_tools::computer_use_control::ControlMode,
}
#[tauri::command]
pub async fn computer_use_share_request(
    request: ComputerUseShareRequest,
) -> Result<openbitfun_agent_tools::computer_use_control::ControlSnapshot, String> {
    // Manual shares have an explicit owner. An Agent cannot silently adopt it.
    crate::computer_use::control_session::request_share(
        request.owner.as_deref().unwrap_or("user:manual-sharing"),
        request.mode,
    )
}
#[tauri::command]
pub async fn computer_use_share_grants(
    state: State<'_, AppState>,
) -> Result<Vec<crate::computer_use::grants::GrantRecord>, String> {
    crate::computer_use::share_grants::list(computer_use_grants_path(&state)).await
}
#[derive(Debug, Deserialize)]
pub struct ComputerUseForgetGrantRequest {
    pub identity: crate::computer_use::grants::GrantIdentity,
}
#[tauri::command]
pub async fn computer_use_share_forget_grant(
    state: State<'_, AppState>,
    request: ComputerUseForgetGrantRequest,
) -> Result<Option<String>, String> {
    crate::computer_use::share_grants::forget(computer_use_grants_path(&state), request.identity)
        .await
}

#[tauri::command]
pub async fn computer_use_share_observe(
    request: crate::computer_use::shared_preview::SharedPreviewRequest,
) -> Result<crate::computer_use::shared_preview::SharedObservation, String> {
    crate::computer_use::shared_preview::observe(request).await
}

#[tauri::command]
pub async fn computer_use_share_input(
    request: crate::computer_use::shared_preview::SharedInputRequest,
) -> Result<openbitfun_agent_tools::computer_use_control::ControlSnapshot, String> {
    crate::computer_use::shared_preview::input(request).await
}
