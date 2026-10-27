//! Model-management projections shared by TUI surfaces and App Server hosts.

use crate::ai::{ProviderCatalog, ReasoningConfig};
use serde::{Deserialize, Serialize};

/// A write-only secret update. `Preserve` is used by edit forms that leave a
/// secret blank; `Clear` is explicit and is never emitted in read responses.
#[derive(Clone, Serialize, Deserialize)]
#[serde(tag = "kind", content = "value", rename_all = "camelCase")]
pub enum SecretUpdate {
    Preserve,
    Replace(String),
    Clear,
}

impl std::fmt::Debug for SecretUpdate {
    fn fmt(&self, formatter: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        formatter.write_str(match self {
            Self::Preserve => "Preserve",
            Self::Replace(_) => "Replace(<redacted>)",
            Self::Clear => "Clear",
        })
    }
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ModelSummary {
    pub id: String,
    pub name: String,
    pub provider: String,
    pub model_name: String,
    pub base_url: String,
    pub enabled: bool,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub context_window: Option<u32>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub max_tokens: Option<u32>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub max_images_per_request: Option<usize>,
    #[serde(default)]
    pub api_key_configured: bool,
    #[serde(default)]
    pub custom_header_names: Vec<String>,
    #[serde(default)]
    pub custom_request_body_configured: bool,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub auth_source: Option<String>,
}

/// Editable model fields. This projection is still secret-safe: it exposes
/// only whether write-only values exist, never their contents.
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ModelEditProjection {
    pub summary: ModelSummary,
    pub reasoning_preset_options: Vec<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub reasoning: Option<ReasoningConfig>,
    pub inline_think_in_text: bool,
    pub skip_ssl_verify: bool,
    pub custom_headers_mode: String,
}

#[derive(Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ModelMutation {
    pub id: String,
    pub name: String,
    pub provider: String,
    pub model_name: String,
    pub base_url: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub api_key: Option<SecretUpdate>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub custom_headers: Option<SecretUpdate>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub custom_request_body: Option<SecretUpdate>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub context_window: Option<u32>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub max_tokens: Option<u32>,
    /// `None` means the caller omitted this field and an update should keep
    /// the current value. `Some(None)` explicitly clears the limit.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub max_images_per_request: Option<Option<usize>>,
    #[serde(default)]
    pub enabled: bool,
    #[serde(default)]
    pub reasoning: Option<ReasoningConfig>,
    #[serde(default)]
    pub inline_think_in_text: bool,
    #[serde(default)]
    pub skip_ssl_verify: bool,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub custom_headers_mode: Option<String>,
}

impl std::fmt::Debug for ModelMutation {
    fn fmt(&self, formatter: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        formatter
            .debug_struct("ModelMutation")
            .field("id", &self.id)
            .field("name", &self.name)
            .field("provider", &self.provider)
            .field("model_name", &self.model_name)
            .field("base_url", &self.base_url)
            .field("api_key", &self.api_key.as_ref().map(|_| "<redacted>"))
            .field(
                "custom_headers",
                &self.custom_headers.as_ref().map(|_| "<redacted>"),
            )
            .field(
                "custom_request_body",
                &self.custom_request_body.as_ref().map(|_| "<redacted>"),
            )
            .field("context_window", &self.context_window)
            .field("max_tokens", &self.max_tokens)
            .field("max_images_per_request", &self.max_images_per_request)
            .field("enabled", &self.enabled)
            .finish()
    }
}

/// Model list data needed by model pickers, independent of the App Server
/// JSON-RPC response envelope.
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ModelListProjection {
    pub models: Vec<ModelSummary>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub primary_model_id: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub fast_model_id: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub mode_default_model_id: Option<String>,
}

/// Provider and reasoning facts needed by model configuration surfaces.
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct TuiModelCatalogProjection {
    pub provider_catalog: ProviderCatalog,
    pub reasoning_presets_by_model: std::collections::BTreeMap<String, Vec<String>>,
}
