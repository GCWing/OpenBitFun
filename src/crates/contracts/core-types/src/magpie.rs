//! Read-only Magpie gateway discovery. No inference or credentials in responses.
use serde::{Deserialize, Serialize};

#[derive(Clone, Deserialize, Serialize)]
pub struct MagpieProbeRequest {
    pub base_url: String,
    #[serde(default)]
    pub api_key: String,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Deserialize, Serialize)]
#[serde(rename_all = "snake_case")]
pub enum MagpieProbeStatus {
    Ready,
    Empty,
    Unreachable,
    AccessDenied,
    Unrecognized,
    CatalogError,
    InvalidAddress,
}

#[derive(Debug, Clone, Deserialize, Serialize)]
pub struct MagpieProbeResult {
    pub status: MagpieProbeStatus,
    pub base_url: String,
    #[serde(default)]
    pub version: Option<String>,
    #[serde(default)]
    pub models: Vec<MagpieModel>,
}

#[derive(Debug, Clone, Deserialize, Serialize)]
pub struct MagpieModel {
    pub id: String,
    #[serde(default)]
    pub display_name: Option<String>,
    #[serde(default)]
    pub owned_by: Option<String>,
    #[serde(default)]
    pub context_window: Option<u64>,
    #[serde(default)]
    pub max_output_tokens: Option<u64>,
    #[serde(default)]
    pub tool_call: Option<bool>,
    #[serde(default)]
    pub reasoning: Option<bool>,
    #[serde(default)]
    pub modalities: Option<MagpieModalities>,
}

#[derive(Debug, Clone, Deserialize, Serialize)]
pub struct MagpieModalities {
    #[serde(default)]
    pub input: Vec<String>,
    #[serde(default)]
    pub output: Vec<String>,
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn minimal_and_future_payloads_round_trip() {
        let request: MagpieProbeRequest = serde_json::from_value(serde_json::json!({
            "base_url": "http://127.0.0.1:3425", "future": true
        }))
        .unwrap();
        assert!(request.api_key.is_empty());
        let model: MagpieModel =
            serde_json::from_value(serde_json::json!({"id":"group/work", "future":true})).unwrap();
        assert!(model.context_window.is_none());
        let reread: MagpieModel =
            serde_json::from_value(serde_json::to_value(model).unwrap()).unwrap();
        assert_eq!(reread.id, "group/work");
        assert!(reread.tool_call.is_none());
    }
}
