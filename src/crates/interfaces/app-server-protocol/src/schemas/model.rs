//! Model-domain App Server wire schemas.
//!
//! Read projections intentionally omit credentials and arbitrary secret
//! payloads. Secret-bearing values are accepted only by mutation requests and
//! are never returned by the server.

#[cfg(feature = "rpc")]
use agent_client_protocol::{JsonRpcRequest, JsonRpcResponse};
use openbitfun_core_types::{
    ProviderCatalog, ReasoningCatalogProjection, ReasoningCatalogProjectionRequest,
};
use serde::{Deserialize, Serialize};

pub use openbitfun_core_types::model::{
    ModelEditProjection, ModelMutation, ModelSummary, SecretUpdate,
};

macro_rules! unit_response {
    ($name:ident) => {
        #[derive(Debug, Clone, Serialize, Deserialize)]
        #[cfg_attr(feature = "rpc", derive(JsonRpcResponse))]
        pub struct $name {}
    };
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[cfg_attr(feature = "rpc", derive(JsonRpcRequest))]
#[cfg_attr(feature = "rpc", request(method = "model/list", response = ListModelsResponse))]
pub struct ListModelsRequest {}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[cfg_attr(feature = "rpc", derive(JsonRpcResponse))]
pub struct ListModelsResponse {
    pub models: Vec<ModelSummary>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub primary_model_id: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub fast_model_id: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub mode_default_model_id: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[cfg_attr(feature = "rpc", derive(JsonRpcRequest))]
#[cfg_attr(feature = "rpc", request(method = "model/get", response = GetModelResponse))]
pub struct GetModelRequest {
    pub model_id: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[cfg_attr(feature = "rpc", derive(JsonRpcResponse))]
pub struct GetModelResponse {
    pub model: ModelEditProjection,
}

/// Provider and reasoning facts needed by model configuration surfaces.
/// API keys and provider-specific execution metadata remain host-owned.
#[derive(Debug, Clone, Serialize, Deserialize)]
#[cfg_attr(feature = "rpc", derive(JsonRpcRequest))]
#[cfg_attr(feature = "rpc", request(method = "config/getTuiModelCatalog", response = TuiModelCatalogResponse))]
pub struct TuiModelCatalogRequest {}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[cfg_attr(feature = "rpc", derive(JsonRpcResponse))]
#[serde(rename_all = "camelCase")]
pub struct TuiModelCatalogResponse {
    pub provider_catalog: ProviderCatalog,
    pub reasoning_presets_by_model: std::collections::BTreeMap<String, Vec<String>>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[cfg_attr(feature = "rpc", derive(JsonRpcRequest))]
#[cfg_attr(feature = "rpc", request(method = "model/projectReasoningCatalog", response = ProjectReasoningCatalogResponse))]
#[serde(transparent)]
pub struct ProjectReasoningCatalogRequest(pub ReasoningCatalogProjectionRequest);

#[derive(Debug, Clone, Serialize, Deserialize)]
#[cfg_attr(feature = "rpc", derive(JsonRpcResponse))]
pub struct ProjectReasoningCatalogResponse {
    pub projection: ReasoningCatalogProjection,
}

#[derive(Clone, Serialize, Deserialize)]
#[cfg_attr(feature = "rpc", derive(JsonRpcRequest))]
#[cfg_attr(feature = "rpc", request(method = "model/add", response = AddModelResponse))]
pub struct AddModelRequest {
    pub model: ModelMutation,
    #[serde(default)]
    pub make_primary_if_empty: bool,
}

impl std::fmt::Debug for AddModelRequest {
    fn fmt(&self, formatter: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        formatter
            .debug_struct("AddModelRequest")
            .field("model", &self.model)
            .field("make_primary_if_empty", &self.make_primary_if_empty)
            .finish()
    }
}

unit_response!(AddModelResponse);

#[derive(Clone, Serialize, Deserialize)]
#[cfg_attr(feature = "rpc", derive(JsonRpcRequest))]
#[cfg_attr(feature = "rpc", request(method = "model/update", response = UpdateModelResponse))]
pub struct UpdateModelRequest {
    pub model_id: String,
    pub model: ModelMutation,
}

impl std::fmt::Debug for UpdateModelRequest {
    fn fmt(&self, formatter: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        formatter
            .debug_struct("UpdateModelRequest")
            .field("model_id", &self.model_id)
            .field("model", &self.model)
            .finish()
    }
}

unit_response!(UpdateModelResponse);

#[derive(Debug, Clone, Serialize, Deserialize)]
#[cfg_attr(feature = "rpc", derive(JsonRpcRequest))]
#[cfg_attr(feature = "rpc", request(method = "model/delete", response = DeleteModelResponse))]
pub struct DeleteModelRequest {
    pub model_id: String,
}

unit_response!(DeleteModelResponse);

#[derive(Debug, Clone, Serialize, Deserialize)]
#[cfg_attr(feature = "rpc", derive(JsonRpcRequest))]
#[cfg_attr(feature = "rpc", request(method = "model/setDefault", response = SetModelDefaultResponse))]
pub struct SetModelDefaultRequest {
    pub slot: ModelDefaultSlot,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub model_id: Option<String>,
}

unit_response!(SetModelDefaultResponse);

#[derive(Debug, Clone, Copy, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub enum ModelDefaultSlot {
    Primary,
    Mode,
}

#[cfg(test)]
mod tests {
    use super::*;
    use openbitfun_core_types::ReasoningConfig;

    fn model_summary() -> ModelSummary {
        ModelSummary {
            id: "model-1".to_string(),
            name: "Model".to_string(),
            provider: "openai".to_string(),
            model_name: "gpt-test".to_string(),
            base_url: "https://example.com/v1".to_string(),
            enabled: true,
            context_window: Some(128_000),
            max_tokens: Some(8_192),
            max_images_per_request: Some(3),
            api_key_configured: true,
            custom_header_names: vec!["Authorization".to_string()],
            custom_request_body_configured: true,
            auth_source: Some("api_key".to_string()),
        }
    }

    #[test]
    fn model_read_projection_contains_only_secret_metadata() {
        let projection = ModelEditProjection {
            summary: model_summary(),
            reasoning_preset_options: vec!["high".to_string()],
            reasoning: Some(ReasoningConfig {
                default_preset: Some("high".to_string()),
                ..Default::default()
            }),
            inline_think_in_text: true,
            skip_ssl_verify: false,
            custom_headers_mode: "merge".to_string(),
        };
        let json = serde_json::to_string(&projection).expect("serialize model projection");

        assert!(json.contains("apiKeyConfigured"));
        assert!(json.contains("customHeaderNames"));
        assert!(json.contains("customRequestBodyConfigured"));
        assert!(!json.contains("sk-secret"));
        assert!(!json.contains("Bearer secret"));
        assert!(!json.contains("secret-body-value"));
    }

    #[test]
    fn model_mutation_debug_redacts_all_write_only_values() {
        let mutation = ModelMutation {
            id: "model-1".to_string(),
            name: "Model".to_string(),
            provider: "openai".to_string(),
            model_name: "gpt-test".to_string(),
            base_url: "https://example.com/v1".to_string(),
            api_key: Some(SecretUpdate::Replace("sk-secret".to_string())),
            custom_headers: Some(SecretUpdate::Replace(
                r#"{"Authorization":"Bearer secret"}"#.to_string(),
            )),
            custom_request_body: Some(SecretUpdate::Replace(
                r#"{"secret":"secret-body-value"}"#.to_string(),
            )),
            context_window: Some(128_000),
            max_tokens: Some(8_192),
            max_images_per_request: Some(Some(3)),
            enabled: true,
            reasoning: None,
            inline_think_in_text: true,
            skip_ssl_verify: false,
            custom_headers_mode: Some("merge".to_string()),
        };

        let debug = format!("{mutation:?}");
        assert!(!debug.contains("sk-secret"));
        assert!(!debug.contains("Bearer secret"));
        assert!(!debug.contains("secret-body-value"));
        assert!(debug.contains("redacted"));
    }
}
