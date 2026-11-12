use serde::{Deserialize, Serialize};
use std::collections::HashMap;

/// Installation options passed from the frontend
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct InstallOptions {
    #[serde(default)]
    pub all_users: bool,
    /// Target installation directory
    pub install_path: String,
    /// Create a desktop shortcut
    pub desktop_shortcut: bool,
    /// Add to Start Menu
    pub start_menu: bool,
    /// Launch after installation
    pub launch_after_install: bool,
    /// First-launch app language (zh-CN / en-US)
    pub app_language: String,
    /// First-launch theme preference (`system` or OpenBitFun built-in theme id)
    pub theme_preference: String,
    /// Optional first-launch model configuration.
    pub model_config: Option<ModelConfig>,
}

/// Optional model configuration (from installer model step).
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct ModelConfig {
    pub provider: String,
    pub api_key: String,
    pub base_url: String,
    pub model_name: String,
    pub format: String,
    #[serde(default)]
    pub config_name: Option<String>,
    #[serde(default)]
    pub custom_request_body: Option<String>,
    #[serde(default)]
    pub skip_ssl_verify: Option<bool>,
    #[serde(default)]
    pub custom_headers: Option<HashMap<String, String>>,
    #[serde(default)]
    pub custom_headers_mode: Option<String>,
    /// Optional capability ids (e.g. `image_understanding`) — aligns with main app when set.
    #[serde(default)]
    pub capabilities: Option<Vec<String>>,
    /// Optional model category (e.g. `multimodal`) — aligns with main app when set.
    #[serde(default)]
    pub category: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct RemoteModelInfo {
    pub id: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub display_name: Option<String>,
}

impl From<openbitfun_ai_adapters::types::RemoteModelInfo> for RemoteModelInfo {
    fn from(value: openbitfun_ai_adapters::types::RemoteModelInfo) -> Self {
        Self {
            id: value.id,
            display_name: value.display_name,
        }
    }
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub(crate) enum ConnectionTestMessageCode {
    ToolCallsNotDetected,
    ImageInputCheckFailed,
    TlsOrCertificateIssue,
    ProxyIssue,
    NetworkIssue,
}

impl From<openbitfun_ai_adapters::types::ConnectionTestMessageCode> for ConnectionTestMessageCode {
    fn from(value: openbitfun_ai_adapters::types::ConnectionTestMessageCode) -> Self {
        match value {
            openbitfun_ai_adapters::types::ConnectionTestMessageCode::ToolCallsNotDetected => {
                Self::ToolCallsNotDetected
            }
            openbitfun_ai_adapters::types::ConnectionTestMessageCode::ImageInputCheckFailed => {
                Self::ImageInputCheckFailed
            }
            openbitfun_ai_adapters::types::ConnectionTestMessageCode::TlsOrCertificateIssue => {
                Self::TlsOrCertificateIssue
            }
            openbitfun_ai_adapters::types::ConnectionTestMessageCode::ProxyIssue => {
                Self::ProxyIssue
            }
            openbitfun_ai_adapters::types::ConnectionTestMessageCode::NetworkIssue => {
                Self::NetworkIssue
            }
        }
    }
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct ConnectionTestResult {
    pub success: bool,
    pub response_time_ms: u64,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub model_response: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub message_code: Option<ConnectionTestMessageCode>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub error_details: Option<String>,
}

impl From<openbitfun_ai_adapters::types::ConnectionTestResult> for ConnectionTestResult {
    fn from(value: openbitfun_ai_adapters::types::ConnectionTestResult) -> Self {
        Self {
            success: value.success,
            response_time_ms: value.response_time_ms,
            model_response: value.model_response,
            message_code: value.message_code.map(Into::into),
            error_details: value.error_details,
        }
    }
}

/// Progress update sent to the frontend
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub(super) struct InstallProgress {
    /// Current step name
    pub step: String,
    /// Progress percentage (0-100)
    pub percent: u32,
    /// Human-readable status message
    pub message: String,
}

/// Disk space information
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct DiskSpaceInfo {
    /// Total disk space in bytes
    pub total: u64,
    /// Available disk space in bytes
    pub available: u64,
    /// Required space in bytes (estimated)
    pub required: u64,
    /// Whether there is enough space
    pub sufficient: bool,
}

impl Default for InstallOptions {
    fn default() -> Self {
        Self {
            all_users: false,
            install_path: String::new(),
            desktop_shortcut: true,
            start_menu: true,
            launch_after_install: true,
            app_language: "zh-CN".to_string(),
            theme_preference: "system".to_string(),
            model_config: None,
        }
    }
}
