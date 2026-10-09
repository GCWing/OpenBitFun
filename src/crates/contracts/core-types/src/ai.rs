use crate::ToolImageAttachment;
use serde::{Deserialize, Serialize};
use serde_json::Value;
use std::collections::{HashMap, HashSet};

fn is_false(value: &bool) -> bool {
    !*value
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq, Default)]
#[serde(tag = "source", rename_all = "snake_case")]
pub enum ReasoningCatalogBinding {
    #[default]
    Auto,
    ModelsDev {
        provider: String,
        model: String,
    },
    Disabled,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(tag = "type", rename_all = "snake_case", deny_unknown_fields)]
pub enum ReasoningPresetAction {
    Effort { value: String },
    Toggle { enabled: bool },
    BudgetTokens { value: u32 },
    RequestPatch { body: Value },
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Default)]
#[serde(default, deny_unknown_fields)]
pub struct ReasoningPreset {
    pub id: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub label: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub order: Option<i32>,
    #[serde(skip_serializing_if = "is_false")]
    pub disabled: bool,
    #[serde(skip_serializing_if = "Vec::is_empty")]
    pub actions: Vec<ReasoningPresetAction>,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Default)]
#[serde(default, deny_unknown_fields)]
pub struct ReasoningConfig {
    pub catalog: ReasoningCatalogBinding,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub default_preset: Option<String>,
    #[serde(skip_serializing_if = "Vec::is_empty")]
    pub presets: Vec<ReasoningPreset>,
}

impl ReasoningConfig {
    pub fn preset(&self, preset_id: &str) -> Option<&ReasoningPreset> {
        let preset_id = preset_id.trim();
        self.presets
            .iter()
            .rev()
            .find(|preset| preset.id.trim() == preset_id)
            .filter(|preset| !preset.disabled && !preset.actions.is_empty())
    }

    pub fn default_preset(&self) -> Option<&ReasoningPreset> {
        self.default_preset
            .as_deref()
            .and_then(|preset_id| self.preset(preset_id))
    }

    /// Validates the provider-neutral canonical reasoning schema.
    ///
    /// Catalog-dependent default resolution is intentionally owned by the
    /// configuration provider because generated presets are not available in
    /// this dependency-light contract crate.
    pub fn validate_schema(&self) -> Result<(), String> {
        if let ReasoningCatalogBinding::ModelsDev { provider, model } = &self.catalog {
            if provider.trim().is_empty() {
                return Err("models.dev catalog provider must not be empty".to_string());
            }
            if model.trim().is_empty() {
                return Err("models.dev catalog model must not be empty".to_string());
            }
        }

        if let Some(default_preset) = self.default_preset.as_deref() {
            if default_preset.trim().is_empty() {
                return Err("default preset ID must not be empty".to_string());
            }
            if default_preset != default_preset.trim() {
                return Err("default preset ID must not contain surrounding whitespace".to_string());
            }
        }

        let mut preset_ids = HashSet::new();
        for (index, preset) in self.presets.iter().enumerate() {
            let preset_id = preset.id.trim();
            if preset_id.is_empty() {
                return Err(format!("preset ID must not be empty at index {index}"));
            }
            if preset.id != preset_id {
                return Err(format!(
                    "preset ID must not contain surrounding whitespace at index {index}"
                ));
            }
            if !preset_ids.insert(preset_id) {
                return Err(format!("duplicate preset ID '{preset_id}'"));
            }

            if !preset.disabled {
                if preset.actions.is_empty() {
                    return Err(format!(
                        "enabled preset '{preset_id}' must define at least one action"
                    ));
                }
                let mut singleton_action_types = HashSet::new();
                for (action_index, action) in preset.actions.iter().enumerate() {
                    validate_reasoning_action(action).map_err(|message| {
                        format!("invalid preset '{preset_id}' action {action_index}: {message}")
                    })?;
                    if let Some(action_type) = singleton_reasoning_action_type(action) {
                        if !singleton_action_types.insert(action_type) {
                            return Err(format!(
                                "preset '{preset_id}' must not contain more than one {action_type} action"
                            ));
                        }
                    }
                }
            }
        }

        Ok(())
    }
}

fn singleton_reasoning_action_type(action: &ReasoningPresetAction) -> Option<&'static str> {
    match action {
        ReasoningPresetAction::Effort { .. } => Some("effort"),
        ReasoningPresetAction::Toggle { .. } => Some("toggle"),
        ReasoningPresetAction::BudgetTokens { .. } => Some("budget_tokens"),
        ReasoningPresetAction::RequestPatch { .. } => None,
    }
}

fn validate_reasoning_action(action: &ReasoningPresetAction) -> Result<(), String> {
    match action {
        ReasoningPresetAction::Effort { value } if value.trim().is_empty() => {
            Err("effort value must not be empty".to_string())
        }
        ReasoningPresetAction::BudgetTokens { value: 0 } => {
            Err("budget_tokens value must be greater than 0".to_string())
        }
        ReasoningPresetAction::RequestPatch { body } if !body.is_object() => {
            Err("request_patch body must be a JSON object".to_string())
        }
        ReasoningPresetAction::Effort { .. }
        | ReasoningPresetAction::Toggle { .. }
        | ReasoningPresetAction::BudgetTokens { .. }
        | ReasoningPresetAction::RequestPatch { .. } => Ok(()),
    }
}

#[derive(Debug, Clone, Copy, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "snake_case")]
pub enum ReasoningPresetSource {
    ModelsDev,
    AdapterFallback,
    ModelConfig,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
pub struct ReasoningPresetDescriptor {
    pub id: String,
    pub label: String,
    pub order: i32,
    pub actions: Vec<ReasoningPresetAction>,
    pub source: ReasoningPresetSource,
    /// Adapter-resolved effort for display and alias grouping. Request actions
    /// and persisted preset ids remain unchanged; older peers may omit this.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub effective_effort: Option<String>,
    /// Catalog identity used only by the host-side adapter compiler. It is
    /// intentionally omitted from Web/remote projections.
    #[serde(skip)]
    pub execution_provider: Option<String>,
    #[serde(skip)]
    pub execution_model: Option<String>,
}

#[derive(Debug, Clone, Copy, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "snake_case")]
pub enum ReasoningCapabilityStatus {
    Unsupported,
    Known,
    Unknown,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
pub struct ReasoningCatalogProjection {
    pub status: ReasoningCapabilityStatus,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub default_preset: Option<String>,
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub presets: Vec<ReasoningPresetDescriptor>,
    /// Presets declared by the selected models.dev model that the active
    /// request adapter cannot compile reliably. These are informational only
    /// and must not be offered as selectable presets.
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub unavailable_presets: Vec<ReasoningPresetDescriptor>,
}

/// Secret-free model facts used to preview the effective reasoning presets
/// while a model configuration is still being edited.
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct ReasoningCatalogProjectionRequest {
    pub provider: String,
    pub model_name: String,
    pub base_url: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub context_window: Option<u32>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub max_tokens: Option<u32>,
    pub reasoning: ReasoningConfig,
}

#[derive(Debug, Clone, Copy, Serialize, Deserialize, PartialEq, Eq, Default)]
#[serde(rename_all = "snake_case")]
pub enum ProviderCatalogSource {
    Cache,
    Bundle,
    #[default]
    OpenBitFun,
    Mixed,
}

#[derive(Debug, Clone, Copy, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "snake_case")]
pub enum ProviderCatalogModelSource {
    ModelsDev,
    OpenBitFun,
    Merged,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq, Default)]
pub struct ProviderCatalogModelCapabilities {
    pub chat: bool,
    pub tool_call: bool,
    pub reasoning: bool,
    pub attachment: bool,
    pub structured_output: bool,
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub input_modalities: Vec<String>,
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub output_modalities: Vec<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq, Default)]
pub struct ProviderCatalogModelLimits {
    #[serde(skip_serializing_if = "Option::is_none")]
    pub context: Option<u32>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub input: Option<u32>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub output: Option<u32>,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq, Default)]
pub struct ProviderCatalogModelPricing {
    #[serde(skip_serializing_if = "Option::is_none")]
    pub input: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub output: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub cache_read: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub cache_write: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
pub struct ProviderCatalogModel {
    pub id: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub display_name: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub description: Option<String>,
    pub recommended: bool,
    pub source: ProviderCatalogModelSource,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub family: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub status: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub release_date: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub last_updated: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub knowledge: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub open_weights: Option<bool>,
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub catalog_provider_ids: Vec<String>,
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub endpoint_ids: Vec<String>,
    pub capabilities: ProviderCatalogModelCapabilities,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub limits: Option<ProviderCatalogModelLimits>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub pricing: Option<ProviderCatalogModelPricing>,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
pub struct ProviderCatalogUpstreamProvider {
    pub id: String,
    pub name: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub api: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub doc: Option<String>,
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub env: Vec<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
pub struct ProviderCatalogEndpoint {
    pub id: String,
    pub base_url: String,
    pub api_format: String,
    pub label: String,
    pub is_default: bool,
    pub trusted_for_auto_detection: bool,
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub catalog_provider_ids: Vec<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
pub struct ProviderCatalogProvider {
    pub id: String,
    pub display_order: i32,
    pub name: String,
    pub description: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub help_url: Option<String>,
    pub requires_api_key: bool,
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub catalog_provider_ids: Vec<String>,
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub catalog_providers: Vec<ProviderCatalogUpstreamProvider>,
    pub endpoints: Vec<ProviderCatalogEndpoint>,
    pub models: Vec<ProviderCatalogModel>,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq, Default)]
pub struct ProviderCatalog {
    pub revision: String,
    pub source: ProviderCatalogSource,
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub providers: Vec<ProviderCatalogProvider>,
}

#[derive(Debug, Clone, Copy, Serialize, Deserialize, PartialEq, Eq, Default)]
#[serde(rename_all = "snake_case")]
pub enum ModelsDevCatalogSource {
    Cache,
    Bundle,
    #[default]
    Empty,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
pub struct ModelsDevReasoningModel {
    pub id: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub display_name: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
pub struct ModelsDevReasoningProvider {
    pub id: String,
    pub name: String,
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub models: Vec<ModelsDevReasoningModel>,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq, Default)]
pub struct ModelsDevReasoningCatalog {
    pub revision: String,
    pub source: ModelsDevCatalogSource,
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub providers: Vec<ModelsDevReasoningProvider>,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
pub struct ModelsDevCatalogStatus {
    pub active_source: ModelsDevCatalogSource,
    pub revision: String,
    pub cache_path: String,
    pub cache_exists: bool,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub cache_updated_at_ms: Option<i64>,
    pub provider_count: usize,
    pub reasoning_model_count: usize,
    pub refresh_in_progress: bool,
}

#[derive(Debug, Clone, Copy, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "snake_case")]
pub enum ModelsDevRefreshStatus {
    Updated,
    Unchanged,
    Throttled,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
pub struct ModelsDevRefreshResult {
    pub outcome: ModelsDevRefreshStatus,
    pub status: ModelsDevCatalogStatus,
}

#[cfg(test)]
mod reasoning_tests {
    use serde_json::json;

    use super::{ReasoningCatalogBinding, ReasoningConfig, ReasoningPreset, ReasoningPresetAction};

    fn config_with(action: ReasoningPresetAction) -> ReasoningConfig {
        ReasoningConfig {
            default_preset: Some("custom".to_string()),
            presets: vec![ReasoningPreset {
                id: "custom".to_string(),
                actions: vec![action],
                ..Default::default()
            }],
            ..Default::default()
        }
    }

    #[test]
    fn schema_rejects_duplicate_preset_ids_and_uses_last_definition_defensively() {
        let config = ReasoningConfig {
            default_preset: Some("same".to_string()),
            presets: vec![
                ReasoningPreset {
                    id: "same".to_string(),
                    actions: vec![ReasoningPresetAction::Effort {
                        value: "low".to_string(),
                    }],
                    ..Default::default()
                },
                ReasoningPreset {
                    id: "same".to_string(),
                    actions: vec![ReasoningPresetAction::Effort {
                        value: "high".to_string(),
                    }],
                    ..Default::default()
                },
            ],
            ..Default::default()
        };

        assert_eq!(
            config.validate_schema(),
            Err("duplicate preset ID 'same'".to_string())
        );
        assert!(matches!(
            config.default_preset().and_then(|preset| preset.actions.first()),
            Some(ReasoningPresetAction::Effort { value }) if value == "high"
        ));
    }

    #[test]
    fn schema_rejects_non_positive_budget_and_non_object_patch() {
        assert_eq!(
            config_with(ReasoningPresetAction::BudgetTokens { value: 0 }).validate_schema(),
            Err(
                "invalid preset 'custom' action 0: budget_tokens value must be greater than 0"
                    .to_string()
            )
        );
        assert_eq!(
            config_with(ReasoningPresetAction::RequestPatch {
                body: json!(["not", "an", "object"]),
            })
            .validate_schema(),
            Err(
                "invalid preset 'custom' action 0: request_patch body must be a JSON object"
                    .to_string()
            )
        );
    }

    #[test]
    fn schema_accepts_ordered_actions() {
        let mut config = config_with(ReasoningPresetAction::BudgetTokens { value: 4096 });
        config.presets[0]
            .actions
            .push(ReasoningPresetAction::RequestPatch {
                body: json!({"reasoning": {"effort": "high"}}),
            });

        assert_eq!(config.validate_schema(), Ok(()));
    }

    #[test]
    fn schema_rejects_duplicate_singleton_actions() {
        let duplicate_actions = [
            (
                ReasoningPresetAction::Effort {
                    value: "low".to_string(),
                },
                ReasoningPresetAction::Effort {
                    value: "high".to_string(),
                },
                "effort",
            ),
            (
                ReasoningPresetAction::Toggle { enabled: true },
                ReasoningPresetAction::Toggle { enabled: false },
                "toggle",
            ),
            (
                ReasoningPresetAction::BudgetTokens { value: 4096 },
                ReasoningPresetAction::BudgetTokens { value: 8192 },
                "budget_tokens",
            ),
        ];

        for (first, second, action_type) in duplicate_actions {
            let mut config = config_with(first);
            config.presets[0].actions.push(second);
            assert_eq!(
                config.validate_schema(),
                Err(format!(
                    "preset 'custom' must not contain more than one {action_type} action"
                ))
            );
        }
    }

    #[test]
    fn schema_accepts_multiple_request_patches_and_distinct_typed_actions() {
        let config = ReasoningConfig {
            default_preset: Some("custom".to_string()),
            presets: vec![ReasoningPreset {
                id: "custom".to_string(),
                actions: vec![
                    ReasoningPresetAction::Effort {
                        value: "high".to_string(),
                    },
                    ReasoningPresetAction::Toggle { enabled: true },
                    ReasoningPresetAction::BudgetTokens { value: 8192 },
                    ReasoningPresetAction::RequestPatch {
                        body: json!({"reasoning": {"summary": "detailed"}}),
                    },
                    ReasoningPresetAction::RequestPatch {
                        body: json!({"reasoning": {"summary": "concise"}}),
                    },
                ],
                ..Default::default()
            }],
            ..Default::default()
        };

        assert_eq!(config.validate_schema(), Ok(()));
    }

    #[test]
    fn schema_rejects_empty_catalog_binding_and_enabled_preset_without_actions() {
        let invalid_binding = ReasoningConfig {
            catalog: ReasoningCatalogBinding::ModelsDev {
                provider: "  ".to_string(),
                model: "gpt-test".to_string(),
            },
            ..Default::default()
        };
        assert_eq!(
            invalid_binding.validate_schema(),
            Err("models.dev catalog provider must not be empty".to_string())
        );

        let missing_setting = ReasoningConfig {
            presets: vec![ReasoningPreset {
                id: "custom".to_string(),
                ..Default::default()
            }],
            ..Default::default()
        };
        assert_eq!(
            missing_setting.validate_schema(),
            Err("enabled preset 'custom' must define at least one action".to_string())
        );
    }

    #[test]
    fn abandoned_setting_and_mode_shapes_are_rejected() {
        for value in [
            json!({
                "presets": [{
                    "id": "legacy",
                    "setting": { "type": "toggle", "enabled": true }
                }]
            }),
            json!({
                "presets": [{
                    "id": "legacy",
                    "actions": [{ "type": "effort", "value": "high", "mode": "enabled" }]
                }]
            }),
            json!({
                "presets": [{
                    "id": "legacy",
                    "actions": [{ "type": "sequence", "settings": [] }]
                }]
            }),
        ] {
            assert!(serde_json::from_value::<ReasoningConfig>(value).is_err());
        }
    }
}

#[derive(Debug, Clone, Serialize, Deserialize, Default)]
#[serde(default)]
pub struct ProxyConfig {
    pub enabled: bool,
    pub url: String,
    pub username: Option<String>,
    pub password: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct AIConfig {
    pub name: String,
    pub base_url: String,
    pub request_url: String,
    pub api_key: String,
    pub model: String,
    pub format: String,
    pub context_window: u32,
    pub max_tokens: Option<u32>,
    pub temperature: Option<f64>,
    pub top_p: Option<f64>,
    pub inline_think_in_text: bool,
    pub custom_headers: Option<HashMap<String, String>>,
    pub custom_headers_mode: Option<String>,
    pub skip_ssl_verify: bool,
    pub custom_request_body: Option<Value>,
    pub custom_request_body_mode: Option<String>,
}

/// Provider-neutral options that vary per model request rather than per model
/// configuration.
///
/// Adapters may map these opaque facts to provider-specific request fields.
/// Runtime owners must not place provider field names or raw local identifiers
/// in this contract.
#[derive(Debug, Clone, Default, PartialEq, Eq)]
pub struct ModelRequestContext {
    /// Stable, opaque routing identity for provider-side prompt-prefix caches.
    pub prompt_cache_route_key: Option<String>,
    /// JSON Schema requested for this turn's final model output.
    pub output_schema: Option<Value>,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct ModelResponseReplay {
    pub protocol: String,
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub items: Vec<ModelResponseReplayItem>,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(tag = "kind", rename_all = "snake_case")]
pub enum ModelResponseReplayItem {
    OpaqueReasoning {
        #[serde(default, skip_serializing_if = "Option::is_none")]
        item_id: Option<String>,
        #[serde(default, skip_serializing_if = "Vec::is_empty")]
        summary: Vec<ModelReasoningSummaryPart>,
        opaque_state: String,
    },
    AssistantMessage,
    FunctionCall {
        call_id: String,
    },
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct ModelReasoningSummaryPart {
    pub text: String,
}

/// Human-readable reasoning text exposed by a model provider.
///
/// A summary is safe, provider-generated display content and is not equivalent
/// to either raw reasoning text or opaque reasoning state used for replay.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum ReasoningContentKind {
    Reasoning,
    Summary,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct ToolCall {
    pub id: String,
    pub name: String,
    pub arguments: Value,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub raw_arguments: Option<String>,
}

impl ToolCall {
    pub fn serialized_arguments(&self) -> String {
        self.raw_arguments
            .as_deref()
            .filter(|raw| serde_json::from_str::<Value>(raw).is_ok())
            .map(ToOwned::to_owned)
            .unwrap_or_else(|| {
                serde_json::to_string(&self.arguments).unwrap_or_else(|_| "{}".to_string())
            })
    }
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct ToolDefinition {
    pub name: String,
    pub description: String,
    pub parameters: Value,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct ToolCallConfirmationDetails {
    pub request: ToolCallRequestInfo,
    #[serde(rename = "type")]
    pub confirmation_type: String,
    pub message: Option<String>,
    pub file_diff: Option<String>,
    pub file_name: Option<String>,
    pub original_content: Option<String>,
    pub new_content: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct ToolCallRequestInfo {
    pub call_id: String,
    pub name: String,
    pub args: HashMap<String, Value>,
    pub is_client_initiated: bool,
    pub prompt_id: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct ToolCallResponseInfo {
    pub call_id: String,
    pub response_parts: Value,
    pub result_display: Option<String>,
    pub error: Option<String>,
    pub error_type: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct Message {
    pub role: String,
    pub content: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub reasoning_content: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub thinking_signature: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub tool_calls: Option<Vec<ToolCall>>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub tool_call_id: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub name: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub is_error: Option<bool>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub tool_image_attachments: Option<Vec<ToolImageAttachment>>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub model_response_replay: Option<ModelResponseReplay>,
}

impl Message {
    pub fn user(content: String) -> Self {
        Self {
            role: "user".to_string(),
            content: Some(content),
            reasoning_content: None,
            thinking_signature: None,
            tool_calls: None,
            tool_call_id: None,
            name: None,
            is_error: None,
            tool_image_attachments: None,
            model_response_replay: None,
        }
    }

    pub fn assistant(content: String) -> Self {
        Self {
            role: "assistant".to_string(),
            content: Some(content),
            reasoning_content: None,
            thinking_signature: None,
            tool_calls: None,
            tool_call_id: None,
            name: None,
            is_error: None,
            tool_image_attachments: None,
            model_response_replay: None,
        }
    }

    pub fn assistant_with_tools(tool_calls: Vec<ToolCall>) -> Self {
        Self {
            role: "assistant".to_string(),
            content: None,
            reasoning_content: None,
            thinking_signature: None,
            tool_calls: Some(tool_calls),
            tool_call_id: None,
            name: None,
            is_error: None,
            tool_image_attachments: None,
            model_response_replay: None,
        }
    }

    pub fn system(content: String) -> Self {
        Self {
            role: "system".to_string(),
            content: Some(content),
            reasoning_content: None,
            thinking_signature: None,
            tool_calls: None,
            tool_call_id: None,
            name: None,
            is_error: None,
            tool_image_attachments: None,
            model_response_replay: None,
        }
    }
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum ConnectionTestMessageCode {
    ToolCallsNotDetected,
    ImageInputCheckFailed,
    TlsOrCertificateIssue,
    ProxyIssue,
    NetworkIssue,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct ConnectionTestResult {
    pub success: bool,
    pub response_time_ms: u64,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub model_response: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub message_code: Option<ConnectionTestMessageCode>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub error_details: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct RemoteModelInfo {
    pub id: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub display_name: Option<String>,
    /// Optional provider-owned route; older hosts may omit it.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub routing: Option<RemoteModelRouting>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct RemoteModelRouting {
    pub format: String,
    pub base_url: String,
    pub request_url: String,
}

#[cfg(test)]
mod remote_model_routing_compatibility {
    #[test]
    fn reasoning_preset_old_payload_round_trips_without_display_metadata() {
        let old = serde_json::json!({
            "id": "medium", "label": "Medium", "order": 10,
            "actions": [{"type": "effort", "value": "medium"}], "source": "models_dev"
        });
        let preset: super::ReasoningPresetDescriptor = serde_json::from_value(old.clone()).unwrap();
        assert!(preset.effective_effort.is_none());
        assert_eq!(serde_json::to_value(&preset).unwrap(), old);

        let mut enriched = preset;
        enriched.effective_effort = Some("high".to_string());
        let serialized = serde_json::to_value(&enriched).unwrap();
        let restored: super::ReasoningPresetDescriptor =
            serde_json::from_value(serialized).unwrap();
        assert_eq!(restored, enriched);
        assert_eq!(restored.id, "medium");
    }

    #[test]
    fn old_discovery_payload_round_trips_without_route_fields() {
        let old = serde_json::json!({"id":"legacy-model", "display_name":"Legacy"});
        let model: super::RemoteModelInfo = serde_json::from_value(old.clone()).unwrap();
        assert!(model.routing.is_none());
        assert_eq!(serde_json::to_value(model).unwrap(), old);
    }
}
