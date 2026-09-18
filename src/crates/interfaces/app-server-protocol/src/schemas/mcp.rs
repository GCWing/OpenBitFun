//! MCP-domain App Server wire schemas.
//!
//! Mutation payloads can contain credentials and other sensitive values. Their
//! custom `Debug` implementations expose only configuration metadata.

#[cfg(feature = "rpc")]
use agent_client_protocol::{JsonRpcRequest, JsonRpcResponse};
use serde::{Deserialize, Serialize};

pub use openbitfun_product_domains::mcp::{
    McpServerAction, McpServerMutation, McpServerSummary, McpTransport,
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
#[cfg_attr(feature = "rpc", request(method = "mcp/list", response = ListMcpServersResponse))]
#[serde(rename_all = "camelCase")]
pub struct ListMcpServersRequest {
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub workspace_id: Option<String>,
    /// Upgrade-only reference.
    #[serde(default)]
    pub workspace_path: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[cfg_attr(feature = "rpc", derive(JsonRpcResponse))]
pub struct ListMcpServersResponse {
    pub servers: Vec<McpServerSummary>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub config_path: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[cfg_attr(feature = "rpc", derive(JsonRpcRequest))]
#[cfg_attr(feature = "rpc", request(method = "mcp/toggle", response = ToggleMcpServerResponse))]
pub struct ToggleMcpServerRequest {
    pub server_id: String,
}

unit_response!(ToggleMcpServerResponse);

#[derive(Clone, Serialize, Deserialize)]
#[cfg_attr(feature = "rpc", derive(JsonRpcRequest))]
#[cfg_attr(feature = "rpc", request(method = "mcp/add", response = AddMcpServerResponse))]
pub struct AddMcpServerRequest {
    pub name: String,
    pub config: McpServerMutation,
}

impl std::fmt::Debug for AddMcpServerRequest {
    fn fmt(&self, formatter: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        formatter
            .debug_struct("AddMcpServerRequest")
            .field("name", &self.name)
            .field("config", &self.config)
            .finish()
    }
}

unit_response!(AddMcpServerResponse);

#[derive(Debug, Clone, Serialize, Deserialize)]
#[cfg_attr(feature = "rpc", derive(JsonRpcRequest))]
#[cfg_attr(feature = "rpc", request(method = "mcp/delete", response = DeleteMcpServerResponse))]
pub struct DeleteMcpServerRequest {
    pub server_id: String,
}

unit_response!(DeleteMcpServerResponse);

#[derive(Debug, Clone, Serialize, Deserialize)]
#[cfg_attr(feature = "rpc", derive(JsonRpcRequest))]
#[cfg_attr(feature = "rpc", request(method = "mcp/externalDecision", response = ExternalMcpDecisionResponse))]
#[serde(rename_all = "camelCase")]
pub struct ExternalMcpDecisionRequest {
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub workspace_id: Option<String>,
    /// Upgrade-only reference.
    #[serde(default)]
    pub workspace_path: String,
    pub candidate_id: String,
    pub decision_key: String,
    pub approved: bool,
    pub expected_mcp_generation: u64,
    pub expected_preference_revision: u64,
}

unit_response!(ExternalMcpDecisionResponse);

#[derive(Debug, Clone, Serialize, Deserialize)]
#[cfg_attr(feature = "rpc", derive(JsonRpcRequest))]
#[cfg_attr(feature = "rpc", request(method = "mcp/conflictChoice", response = McpConflictChoiceResponse))]
#[serde(rename_all = "camelCase")]
pub struct McpConflictChoiceRequest {
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub workspace_id: Option<String>,
    /// Upgrade-only reference.
    #[serde(default)]
    pub workspace_path: String,
    pub conflict_key: String,
    pub candidate_id: String,
    pub approve_external: bool,
    pub expected_mcp_generation: u64,
    pub expected_preference_revision: u64,
}

unit_response!(McpConflictChoiceResponse);

#[cfg(test)]
mod tests {
    use std::collections::HashMap;

    use super::*;

    #[test]
    fn mcp_mutation_debug_redacts_arguments_and_secret_values() {
        let request = AddMcpServerRequest {
            name: "server".to_string(),
            config: McpServerMutation {
                transport: McpTransport::Stdio,
                command: Some("secret-command".to_string()),
                args: vec!["--token=secret-argument".to_string()],
                env: HashMap::from([("API_TOKEN".to_string(), "secret-env".to_string())]),
                headers: HashMap::from([(
                    "Authorization".to_string(),
                    "Bearer secret-header".to_string(),
                )]),
                url: Some("https://example.com?token=secret-url".to_string()),
                auto_start: true,
                enabled: true,
                oauth: Some(serde_json::json!({"clientSecret": "secret-oauth"})),
                xaa: Some(serde_json::json!({"token": "secret-xaa"})),
            },
        };

        let debug = format!("{request:?}");
        for secret in [
            "secret-command",
            "secret-argument",
            "secret-env",
            "secret-header",
            "secret-url",
            "secret-oauth",
            "secret-xaa",
        ] {
            assert!(!debug.contains(secret), "debug leaked {secret}");
        }
        assert!(debug.contains("API_TOKEN"));
        assert!(debug.contains("Authorization"));
    }
}
