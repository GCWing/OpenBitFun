//! Subagent-domain App Server wire schemas.

#[cfg(feature = "rpc")]
use agent_client_protocol::{JsonRpcRequest, JsonRpcResponse};
use serde::{Deserialize, Serialize};

pub use openbitfun_product_domains::agent_catalog::SubagentSummary;

#[derive(Debug, Clone, Serialize, Deserialize)]
#[cfg_attr(feature = "rpc", derive(JsonRpcRequest))]
#[cfg_attr(feature = "rpc", request(method = "subagent/list", response = ListSubagentsResponse))]
#[serde(rename_all = "camelCase")]
pub struct ListSubagentsRequest {
    #[serde(default)]
    pub workspace_id: Option<String>,
    /// Upgrade-only input for pre-ID clients.
    #[serde(default)]
    pub workspace_path: String,
    pub parent_mode_id: String,
    #[serde(default)]
    pub management: bool,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[cfg_attr(feature = "rpc", derive(JsonRpcResponse))]
pub struct ListSubagentsResponse {
    pub subagents: Vec<SubagentSummary>,
    #[serde(default)]
    pub has_external: bool,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[cfg_attr(feature = "rpc", derive(JsonRpcRequest))]
#[cfg_attr(feature = "rpc", request(method = "subagent/setEnabled", response = SetSubagentEnabledResponse))]
#[serde(rename_all = "camelCase")]
pub struct SetSubagentEnabledRequest {
    #[serde(default)]
    pub workspace_id: Option<String>,
    /// Upgrade-only input for pre-ID clients.
    #[serde(default)]
    pub workspace_path: String,
    pub parent_mode_id: String,
    pub subagent_id: String,
    pub enabled: bool,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[cfg_attr(feature = "rpc", derive(JsonRpcResponse))]
pub struct SetSubagentEnabledResponse {}
