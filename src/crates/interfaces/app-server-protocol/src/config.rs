//! Configuration wire contracts shared by App Server hosts and clients.
//!
//! These payloads intentionally contain only wire-owned data. Server adapters
//! translate them to the configuration service's domain request/result types.

#[cfg(feature = "rpc")]
use agent_client_protocol::{JsonRpcRequest, JsonRpcResponse};
use serde::{Deserialize, Serialize};
use std::collections::{BTreeMap, HashMap};

/// API view of a mode configuration.
#[derive(Debug, Clone, Default, Serialize, Deserialize)]
#[cfg_attr(feature = "ts", derive(ts_rs::TS), ts(export))]
#[serde(default)]
pub struct AgentProfileView {
    pub profile_id: String,
    pub enabled_tools: Vec<String>,
    pub default_tools: Vec<String>,
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub disabled_user_skills: Vec<String>,
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub enabled_user_skills: Vec<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[cfg_attr(feature = "rpc", derive(JsonRpcRequest))]
#[cfg_attr(feature = "rpc", request(method = "config/getAgentProfileConfigs", response = GetAgentProfileConfigsResponse))]
pub struct GetAgentProfileConfigsMessage {}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[cfg_attr(feature = "rpc", derive(JsonRpcResponse))]
pub struct GetAgentProfileConfigsResponse {
    pub profiles: HashMap<String, AgentProfileView>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[cfg_attr(feature = "rpc", derive(JsonRpcRequest))]
#[cfg_attr(feature = "ts", derive(ts_rs::TS), ts(export))]
#[cfg_attr(feature = "rpc", request(method = "config/getAgentProfileConfig", response = GetAgentProfileConfigResponse))]
pub struct GetAgentProfileConfigMessage {
    pub agent_id: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[cfg_attr(feature = "rpc", derive(JsonRpcResponse))]
pub struct GetAgentProfileConfigResponse(pub AgentProfileView);

#[derive(Debug, Clone, Serialize, Deserialize)]
#[cfg_attr(feature = "rpc", derive(JsonRpcRequest))]
#[cfg_attr(feature = "rpc", request(method = "config/getModelConfigs", response = GetModelConfigsResponse))]
pub struct GetModelConfigsMessage {}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[cfg_attr(feature = "rpc", derive(JsonRpcResponse))]
pub struct GetModelConfigsResponse {
    pub models: Vec<serde_json::Value>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[cfg_attr(feature = "rpc", derive(JsonRpcRequest))]
#[serde(rename_all = "camelCase")]
#[cfg_attr(feature = "rpc", request(method = "config/getConfig", response = GetConfigResponse))]
pub struct GetConfigMessage {
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub path: Option<String>,
    #[serde(default, skip_serializing_if = "skip_if_false")]
    pub skip_retry_on_not_found: bool,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[cfg_attr(feature = "rpc", derive(JsonRpcResponse))]
pub struct GetConfigResponse(pub serde_json::Value);

#[derive(Debug, Clone, Serialize, Deserialize)]
#[cfg_attr(feature = "rpc", derive(JsonRpcRequest))]
#[serde(rename_all = "camelCase")]
#[cfg_attr(feature = "rpc", request(method = "config/getConfigs", response = GetConfigsResponse))]
pub struct GetConfigsMessage {
    pub paths: Vec<String>,
    #[serde(default, skip_serializing_if = "skip_if_false")]
    pub skip_retry_on_not_found: bool,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[cfg_attr(feature = "rpc", derive(JsonRpcResponse))]
pub struct GetConfigsResponse {
    pub configs: BTreeMap<String, serde_json::Value>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[cfg_attr(feature = "rpc", derive(JsonRpcRequest))]
#[serde(rename_all = "camelCase")]
#[cfg_attr(feature = "rpc", request(method = "config/setConfig", response = SetConfigResponse))]
pub struct SetConfigMessage {
    pub path: String,
    pub value: serde_json::Value,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[cfg_attr(feature = "rpc", derive(JsonRpcResponse))]
pub struct SetConfigResponse {}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[cfg_attr(feature = "rpc", derive(JsonRpcRequest))]
#[cfg_attr(feature = "ts", derive(ts_rs::TS), ts(export))]
#[serde(rename_all = "camelCase")]
#[cfg_attr(feature = "rpc", request(method = "config/setAgentProfileConfig", response = SetAgentProfileConfigResponse))]
pub struct SetAgentProfileConfigMessage {
    pub agent_id: String,
    pub config: serde_json::Value,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[cfg_attr(feature = "rpc", derive(JsonRpcResponse))]
#[cfg_attr(feature = "ts", derive(ts_rs::TS), ts(export))]
pub struct SetAgentProfileConfigResponse(pub AgentProfileView);

#[derive(Debug, Clone, Serialize, Deserialize)]
#[cfg_attr(feature = "rpc", derive(JsonRpcRequest))]
#[cfg_attr(feature = "ts", derive(ts_rs::TS), ts(export))]
#[serde(rename_all = "camelCase")]
#[cfg_attr(feature = "rpc", request(method = "config/resetAgentProfileConfig", response = ResetAgentProfileConfigResponse))]
pub struct ResetAgentProfileConfigMessage {
    pub agent_id: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[cfg_attr(feature = "rpc", derive(JsonRpcResponse))]
#[cfg_attr(feature = "ts", derive(ts_rs::TS), ts(export))]
pub struct ResetAgentProfileConfigResponse(pub AgentProfileView);

fn skip_if_false(value: &bool) -> bool {
    !*value
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[cfg_attr(feature = "ts", derive(ts_rs::TS), ts(export))]
#[serde(rename_all = "camelCase")]
pub struct SaveCloudSpeechConfigRequest {
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub config_id: Option<String>,
    pub preset: String,
    pub name: String,
    pub base_url: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub request_url: Option<String>,
    pub model_name: String,
    pub api_key: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[cfg_attr(feature = "rpc", derive(JsonRpcRequest))]
#[cfg_attr(feature = "ts", derive(ts_rs::TS), ts(export))]
#[cfg_attr(feature = "rpc", request(method = "config/saveCloudSpeechConfig", response = SaveCloudSpeechConfigResponse))]
pub struct SaveCloudSpeechConfigMessage {
    pub request: SaveCloudSpeechConfigRequest,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[cfg_attr(feature = "ts", derive(ts_rs::TS), ts(export))]
#[serde(rename_all = "camelCase")]
pub struct SaveCloudSpeechConfigResult {
    pub model_id: String,
    pub created: bool,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[cfg_attr(feature = "rpc", derive(JsonRpcResponse))]
#[cfg_attr(feature = "ts", derive(ts_rs::TS), ts(export))]
pub struct SaveCloudSpeechConfigResponse(pub SaveCloudSpeechConfigResult);

#[derive(Debug, Clone, Serialize, Deserialize)]
#[cfg_attr(feature = "ts", derive(ts_rs::TS), ts(export))]
#[serde(rename_all = "camelCase")]
pub struct WebSearchCredentialProviderRequest {
    pub provider: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[cfg_attr(feature = "ts", derive(ts_rs::TS), ts(export))]
#[serde(rename_all = "camelCase")]
pub struct SaveWebSearchCredentialRequest {
    pub provider: String,
    pub secret: String,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[cfg_attr(feature = "ts", derive(ts_rs::TS), ts(export))]
#[serde(rename_all = "camelCase")]
pub struct WebSearchCredentialStatus {
    pub provider: String,
    pub configured: bool,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[cfg_attr(feature = "rpc", derive(JsonRpcRequest))]
#[cfg_attr(feature = "rpc", request(method = "config/getWebSearchCredentialStatus", response = GetWebSearchCredentialStatusResponse))]
pub struct GetWebSearchCredentialStatusMessage {
    pub request: WebSearchCredentialProviderRequest,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[cfg_attr(feature = "rpc", derive(JsonRpcResponse))]
pub struct GetWebSearchCredentialStatusResponse(pub WebSearchCredentialStatus);

#[derive(Debug, Clone, Serialize, Deserialize)]
#[cfg_attr(feature = "rpc", derive(JsonRpcRequest))]
#[cfg_attr(feature = "rpc", request(method = "config/saveWebSearchCredential", response = SaveWebSearchCredentialResponse))]
pub struct SaveWebSearchCredentialMessage {
    pub request: SaveWebSearchCredentialRequest,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[cfg_attr(feature = "rpc", derive(JsonRpcResponse))]
pub struct SaveWebSearchCredentialResponse(pub WebSearchCredentialStatus);

#[derive(Debug, Clone, Serialize, Deserialize)]
#[cfg_attr(feature = "rpc", derive(JsonRpcRequest))]
#[cfg_attr(feature = "rpc", request(method = "config/clearWebSearchCredential", response = ClearWebSearchCredentialResponse))]
pub struct ClearWebSearchCredentialMessage {
    pub request: WebSearchCredentialProviderRequest,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[cfg_attr(feature = "rpc", derive(JsonRpcResponse))]
pub struct ClearWebSearchCredentialResponse(pub WebSearchCredentialStatus);

#[derive(Debug, Clone, Serialize, Deserialize, Default)]
#[cfg_attr(feature = "ts", derive(ts_rs::TS), ts(export))]
#[cfg_attr(feature = "rpc", derive(JsonRpcRequest))]
#[cfg_attr(feature = "rpc", request(method = "config/getDecisionModelCredentialStatus", response = GetDecisionModelCredentialStatusResponse))]
pub struct GetDecisionModelCredentialStatusMessage {}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[cfg_attr(feature = "ts", derive(ts_rs::TS), ts(export))]
#[serde(rename_all = "camelCase")]
pub struct DecisionModelCredentialStatus {
    pub configured: bool,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[cfg_attr(feature = "rpc", derive(JsonRpcResponse))]
pub struct GetDecisionModelCredentialStatusResponse(pub DecisionModelCredentialStatus);

#[derive(Debug, Clone, Serialize, Deserialize)]
#[cfg_attr(feature = "rpc", derive(JsonRpcRequest))]
#[cfg_attr(feature = "rpc", request(method = "config/saveDecisionModelCredential", response = SaveDecisionModelCredentialResponse))]
pub struct SaveDecisionModelCredentialMessage {
    pub request: SaveDecisionModelCredentialRequest,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[cfg_attr(feature = "rpc", derive(JsonRpcResponse))]
pub struct SaveDecisionModelCredentialResponse(pub DecisionModelCredentialStatus);

#[derive(Debug, Clone, Serialize, Deserialize)]
#[cfg_attr(feature = "rpc", derive(JsonRpcRequest))]
#[cfg_attr(feature = "rpc", request(method = "config/clearDecisionModelCredential", response = ClearDecisionModelCredentialResponse))]
pub struct ClearDecisionModelCredentialMessage {}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[cfg_attr(feature = "rpc", derive(JsonRpcResponse))]
pub struct ClearDecisionModelCredentialResponse(pub DecisionModelCredentialStatus);

#[derive(Debug, Clone, Serialize, Deserialize)]
#[cfg_attr(feature = "ts", derive(ts_rs::TS), ts(export))]
#[serde(rename_all = "camelCase")]
pub struct SaveDecisionModelCredentialRequest {
    pub secret: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[cfg_attr(feature = "rpc", derive(JsonRpcRequest))]
#[cfg_attr(feature = "rpc", request(method = "config/validateConfig", response = ValidateConfigResponse))]
pub struct ValidateConfigMessage {}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[cfg_attr(feature = "rpc", derive(JsonRpcResponse))]
pub struct ValidateConfigResponse(pub serde_json::Value);

#[cfg(test)]
mod tests {
    use super::SaveCloudSpeechConfigRequest;

    #[test]
    fn cloud_speech_request_uses_the_camel_case_wire_shape() {
        let value = serde_json::to_value(SaveCloudSpeechConfigRequest {
            config_id: Some("speech".to_string()),
            preset: "custom".to_string(),
            name: "Speech".to_string(),
            base_url: "https://example.com/v1".to_string(),
            request_url: None,
            model_name: "speech-model".to_string(),
            api_key: "secret".to_string(),
        })
        .expect("request should serialize");

        assert_eq!(value["configId"], "speech");
        assert_eq!(value["baseUrl"], "https://example.com/v1");
        assert_eq!(value["modelName"], "speech-model");
        assert!(value.get("requestUrl").is_none());
    }
}
