//! Selection intent is independent of the concrete model used by an attempt.

use serde::{Deserialize, Serialize};

pub const MODEL_POOL_SELECTION_CAPABILITY: &str = "model_pool_selection_v1";

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(tag = "kind", rename_all = "snake_case")]
pub enum ModelSelection {
    Model { model_ref: String },
    Pool { pool_id: String },
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SessionModelTarget {
    pub session_id: String,
    pub selection: ModelSelection,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub binding: Option<ModelPoolBinding>,
}

/// Unknown strategies remain readable, but must never execute as another strategy.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum ModelPoolStrategy {
    Ordered,
    Balanced,
    #[serde(other)]
    Unsupported,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum ModelPoolHealthStatus {
    Unverified,
    Available,
    CoolingDown,
    Probing,
    NeedsAttention,
    Disabled,
    Missing,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ModelPoolMemberStatus {
    pub model_id: String,
    pub status: ModelPoolHealthStatus,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub reason: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub retry_at_ms: Option<u64>,
    /// Resolved execution-host limits; independent of transient health.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub context_budget: Option<ModelPoolContextBudget>,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ModelPoolContextBudget {
    pub context_window: u32,
    pub input_limit: u32,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ModelPoolBinding {
    pub pool_id: String,
    pub model_id: String,
    pub configuration_fingerprint: String,
    pub generation: u64,
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn member_context_budget_is_optional_on_the_wire() {
        let legacy = serde_json::json!({ "modelId": "model-a", "status": "available" });
        let mut status: ModelPoolMemberStatus = serde_json::from_value(legacy.clone()).unwrap();
        assert_eq!(status.context_budget, None);
        assert_eq!(serde_json::to_value(&status).unwrap(), legacy);
        status.context_budget = Some(ModelPoolContextBudget {
            context_window: 128_000,
            input_limit: 86_000,
        });
        let wire = serde_json::to_value(&status).unwrap();
        assert_eq!(wire["contextBudget"]["inputLimit"], 86_000);
        assert_eq!(
            serde_json::from_value::<ModelPoolMemberStatus>(wire).unwrap(),
            status
        );
    }
}
