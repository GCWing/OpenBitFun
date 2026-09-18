//! Skill-domain App Server wire schemas.

#[cfg(feature = "rpc")]
use agent_client_protocol::{JsonRpcRequest, JsonRpcResponse};
use serde::{Deserialize, Serialize};

pub use openbitfun_product_domains::agent_catalog::SkillSummary;

#[derive(Debug, Clone, Serialize, Deserialize)]
#[cfg_attr(feature = "rpc", derive(JsonRpcRequest))]
#[cfg_attr(feature = "rpc", request(method = "skill/list", response = ListSkillsResponse))]
#[serde(rename_all = "camelCase")]
pub struct ListSkillsRequest {
    #[serde(default)]
    pub workspace_id: Option<String>,
    /// Upgrade-only input for pre-ID clients.
    #[serde(default)]
    pub workspace_path: String,
    pub mode_id: String,
    #[serde(default)]
    pub manageable: bool,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[cfg_attr(feature = "rpc", derive(JsonRpcResponse))]
pub struct ListSkillsResponse {
    pub skills: Vec<SkillSummary>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[cfg_attr(feature = "rpc", derive(JsonRpcRequest))]
#[cfg_attr(feature = "rpc", request(method = "skill/setEnabled", response = SetSkillEnabledResponse))]
#[serde(rename_all = "camelCase")]
pub struct SetSkillEnabledRequest {
    #[serde(default)]
    pub workspace_id: Option<String>,
    /// Upgrade-only input for pre-ID clients.
    #[serde(default)]
    pub workspace_path: String,
    pub mode_id: String,
    pub skill_key: String,
    pub enabled: bool,
    pub default_enabled: bool,
    pub level: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[cfg_attr(feature = "rpc", derive(JsonRpcResponse))]
pub struct SetSkillEnabledResponse {}
