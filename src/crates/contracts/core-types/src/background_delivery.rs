//! Additive delivery facts for background runs. Raw execution records remain authoritative.

use serde::{Deserialize, Serialize};
use serde_json::Value;

pub const BACKGROUND_DELIVERY_METADATA_KEY: &str = "backgroundDelivery";
pub const BACKGROUND_DELIVERY_SCHEMA_VERSION: u32 = 1;

#[derive(Debug, Clone, Default, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum BackgroundReportPolicy {
    #[default]
    Inherit,
    Always,
    Conditional,
    #[serde(untagged)]
    Unknown(String),
}

#[derive(Debug, Clone, Default, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum BackgroundReportDisposition {
    Pending,
    Quiet,
    #[default]
    Report,
    Attention,
    #[serde(untagged)]
    Unknown(String),
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct BackgroundReport {
    pub disposition: BackgroundReportDisposition,
    pub reason: String,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct BackgroundDecisionUsage {
    pub input_tokens: u32,
    pub output_tokens: u32,
    pub total_tokens: u32,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub cached_input_tokens: Option<u32>,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct BackgroundDelivery {
    pub schema_version: u32,
    pub source: String,
    pub task_id: String,
    pub run_id: String,
    #[serde(default)]
    pub execution_generation: u32,
    #[serde(default)]
    pub policy: BackgroundReportPolicy,
    #[serde(default)]
    pub disposition: BackgroundReportDisposition,
    #[serde(default)]
    pub decision_source: String,
    #[serde(default)]
    pub reason: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub proposal: Option<BackgroundReport>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub resolved_at_ms: Option<u64>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub decision_usage: Option<BackgroundDecisionUsage>,
}

impl BackgroundDelivery {
    pub fn pending(task_id: String, run_id: String, policy: BackgroundReportPolicy) -> Self {
        Self {
            schema_version: BACKGROUND_DELIVERY_SCHEMA_VERSION,
            source: "scheduled_job".to_owned(),
            task_id,
            run_id,
            execution_generation: 0,
            policy,
            disposition: BackgroundReportDisposition::Pending,
            decision_source: "pending".to_owned(),
            reason: String::new(),
            proposal: None,
            resolved_at_ms: None,
            decision_usage: None,
        }
    }

    /// Only a recognized, identity-bound record may suppress ordinary delivery.
    pub fn from_metadata(metadata: Option<&Value>, run_id: &str) -> Option<Self> {
        let value = metadata?.get(BACKGROUND_DELIVERY_METADATA_KEY)?;
        let delivery: Self = serde_json::from_value(value.clone()).ok()?;
        (delivery.schema_version == BACKGROUND_DELIVERY_SCHEMA_VERSION
            && delivery.run_id == run_id
            && !delivery.task_id.trim().is_empty()
            && delivery.source == "scheduled_job")
            .then_some(delivery)
    }

    pub fn suppresses_report(&self) -> bool {
        matches!(
            self.disposition,
            BackgroundReportDisposition::Pending | BackgroundReportDisposition::Quiet
        ) && self.schema_version == BACKGROUND_DELIVERY_SCHEMA_VERSION
            && !matches!(
                self.policy,
                BackgroundReportPolicy::Always | BackgroundReportPolicy::Unknown(_)
            )
            && (self.disposition != BackgroundReportDisposition::Quiet
                || self.resolved_at_ms.is_some())
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    #[test]
    fn old_unknown_and_foreign_records_remain_visible() {
        assert!(BackgroundDelivery::from_metadata(None, "run").is_none());
        let mut delivery = BackgroundDelivery::pending(
            "job".into(),
            "run".into(),
            BackgroundReportPolicy::Inherit,
        );
        delivery.disposition = BackgroundReportDisposition::Quiet;
        delivery.resolved_at_ms = Some(1);
        let metadata = json!({BACKGROUND_DELIVERY_METADATA_KEY: delivery});
        assert!(BackgroundDelivery::from_metadata(Some(&metadata), "other").is_none());
        assert!(BackgroundDelivery::from_metadata(Some(&metadata), "run")
            .unwrap()
            .suppresses_report());
        let mut future = metadata.clone();
        future[BACKGROUND_DELIVERY_METADATA_KEY]["schemaVersion"] = json!(2);
        assert!(BackgroundDelivery::from_metadata(Some(&future), "run").is_none());
        future = metadata;
        future[BACKGROUND_DELIVERY_METADATA_KEY]["disposition"] = json!("future_decision");
        assert!(!BackgroundDelivery::from_metadata(Some(&future), "run")
            .unwrap()
            .suppresses_report());
        let decoded = BackgroundDelivery::from_metadata(Some(&future), "run").unwrap();
        assert_eq!(
            serde_json::to_value(decoded).unwrap()["disposition"],
            "future_decision"
        );
    }

    #[test]
    fn policy_and_optional_fields_round_trip_without_changing_raw_messages() {
        let delivery =
            BackgroundDelivery::pending("job".into(), "run".into(), BackgroundReportPolicy::Always);
        assert!(!delivery.suppresses_report());
        let mut legacy = serde_json::to_value(delivery).unwrap();
        legacy.as_object_mut().unwrap().remove("policy");
        legacy.as_object_mut().unwrap().remove("proposal");
        let decoded: BackgroundDelivery = serde_json::from_value(legacy).unwrap();
        assert_eq!(decoded.policy, BackgroundReportPolicy::Inherit);
        assert_eq!(
            serde_json::from_str::<BackgroundDelivery>(&serde_json::to_string(&decoded).unwrap())
                .unwrap(),
            decoded
        );
    }
}
