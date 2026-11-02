//! Permission facts and explicit request receipts. Probing never requests consent.
use serde::{Deserialize, Serialize};

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum ComputerPermissionKind {
    Accessibility,
    #[serde(alias = "screen_capture")]
    ScreenRecording,
    InputPosting,
    InputMonitoring,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum ComputerPermissionState {
    Granted,
    Required,
    /// Authorization belongs to the selected native session, not the whole OS.
    SessionRequired,
    NotRequired,
    Unavailable,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct ComputerPermission {
    pub kind: ComputerPermissionKind,
    pub state: ComputerPermissionState,
    pub requestable: bool,
    pub settings_url: Option<String>,
    pub detail: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct ComputerPermissions {
    pub platform: String,
    pub process_id: u32,
    pub executable: Option<String>,
    pub permissions: Vec<ComputerPermission>,
    /// A status read is never an authorization gesture.
    pub prompts_requested: bool,
}

impl ComputerPermissions {
    pub fn usable(&self, kind: ComputerPermissionKind) -> bool {
        self.permissions.iter().any(|item| {
            item.kind == kind
                && matches!(
                    item.state,
                    ComputerPermissionState::Granted | ComputerPermissionState::NotRequired
                )
        })
    }
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct ComputerPermissionRequest {
    pub kind: ComputerPermissionKind,
}

/// Adapted from computer-use-rust/native/permissions.rs. An invoked OS API is
/// not evidence that a prompt was visible or that permission was granted.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct ComputerPermissionReceipt {
    pub kind: ComputerPermissionKind,
    pub already_granted: bool,
    pub current_granted: bool,
    pub request_api_invoked: bool,
    pub prompt_requested: bool,
    pub prompt_visibility_observed: bool,
    pub api_returned_granted: Option<bool>,
    pub requires_user_action: bool,
    pub restart_may_be_required: bool,
    pub permission: ComputerPermission,
    pub permission_owner: String,
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn legacy_capture_kind_and_future_fields_remain_compatible() {
        let request: ComputerPermissionRequest = serde_json::from_value(serde_json::json!({
            "kind": "screen_capture", "future": true,
        }))
        .unwrap();
        assert_eq!(request.kind, ComputerPermissionKind::ScreenRecording);
        let round: ComputerPermissionRequest =
            serde_json::from_value(serde_json::to_value(request).unwrap()).unwrap();
        assert_eq!(round.kind, ComputerPermissionKind::ScreenRecording);
    }
    #[test]
    fn session_consent_is_not_global_permission() {
        let status = ComputerPermissions {
            platform: "linux".into(),
            process_id: 1,
            executable: None,
            prompts_requested: false,
            permissions: vec![ComputerPermission {
                kind: ComputerPermissionKind::ScreenRecording,
                state: ComputerPermissionState::SessionRequired,
                requestable: false,
                settings_url: None,
                detail: String::new(),
            }],
        };
        assert!(!status.usable(ComputerPermissionKind::ScreenRecording));
    }
}
