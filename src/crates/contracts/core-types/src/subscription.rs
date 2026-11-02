//! Subscription allowance observations. Vendor
//! quota is never inferred from the application's token ledger or concurrency.

use serde::{Deserialize, Serialize};

/// Provider-interpreted routing facts, computed from an existing snapshot.
/// These borrowed values are not a new persisted or wire format.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum ModelQuotaEligibility {
    Attemptable,
    TemporarilyUnavailable { recovery_at: Option<i64> },
    Unknown,
}

#[derive(Debug, Clone, Copy)]
pub struct ModelQuotaObservation<'a> {
    pub account_id: &'a str,
    pub provider: &'a str,
    pub model: &'a str,
    pub credential_revision: u64,
    pub observed_at: Option<i64>,
    pub valid_until: Option<i64>,
    pub eligibility: ModelQuotaEligibility,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum SubscriptionQuotaState {
    Known,
    Stale,
    Unknown,
    Unsupported,
    QueryFailed,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct SubscriptionQuotaWindow {
    pub id: String,
    /// Duration and reset timestamps are in seconds, not milliseconds.
    #[serde(default)]
    pub duration_seconds: Option<u64>,
    #[serde(default)]
    pub used_percent: Option<f64>,
    #[serde(default)]
    pub resets_at: Option<i64>,
}

/// Vendor-reported amounts for presentation, separate from routing policy.
/// Missing amounts are unknown, never zero. Old readers may ignore this view.
#[derive(Debug, Clone, Default, PartialEq, Serialize, Deserialize)]
pub struct SubscriptionQuotaMeter {
    pub id: String,
    #[serde(default)]
    pub display_name: Option<String>,
    #[serde(default)]
    pub duration_seconds: Option<u64>,
    #[serde(default)]
    pub used: Option<f64>,
    #[serde(default)]
    pub limit: Option<f64>,
    #[serde(default)]
    pub remaining: Option<f64>,
    #[serde(default)]
    pub unit: Option<String>,
    #[serde(default)]
    pub used_percent: Option<f64>,
    #[serde(default)]
    pub resets_at: Option<i64>,
    #[serde(default)]
    pub expires_at: Option<i64>,
    #[serde(default)]
    pub secondary: bool,
    #[serde(default)]
    pub unlimited: bool,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct SubscriptionQuotaDisplay {
    pub version: u8,
    #[serde(default)]
    pub expires_at: Option<i64>,
    #[serde(default)]
    pub meters: Vec<SubscriptionQuotaMeter>,
}

/// An independently metered allowance. Empty models means applicability is
/// unknown, not that this bucket gates every model on the account.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct SubscriptionQuotaBucket {
    pub id: String,
    #[serde(default)]
    pub display_name: Option<String>,
    #[serde(default)]
    pub models: Vec<String>,
    #[serde(default)]
    pub separate: bool,
    #[serde(default)]
    pub allowed: Option<bool>,
    #[serde(default)]
    pub limit_reached: Option<bool>,
    #[serde(default)]
    pub windows: Vec<SubscriptionQuotaWindow>,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct SubscriptionModelQuota {
    pub model: String,
    #[serde(default)]
    pub available: Option<bool>,
    #[serde(default)]
    pub available_at: Option<i64>,
    #[serde(default)]
    pub credits_would_enable: Option<bool>,
}

/// Full-observation scope facts, independent from the legacy single-plan view.
/// Unknown versions must not be interpreted as account-wide allowance.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct SubscriptionQuotaDetails {
    pub version: u8,
    #[serde(default)]
    pub valid_until: Option<i64>,
    #[serde(default)]
    pub included_limit_reached: Option<bool>,
    #[serde(default)]
    pub spend_control_reached: Option<bool>,
    #[serde(default)]
    pub spend_resets_at: Option<i64>,
    #[serde(default)]
    pub overage_limit_reached: Option<bool>,
    #[serde(default)]
    pub reached_type: Option<String>,
    #[serde(default)]
    pub buckets: Vec<SubscriptionQuotaBucket>,
    #[serde(default)]
    pub models: Vec<SubscriptionModelQuota>,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct SubscriptionQuotaSnapshot {
    pub account_id: String,
    pub provider: String,
    pub state: SubscriptionQuotaState,
    #[serde(default)]
    pub credential_revision: u64,
    #[serde(default)]
    pub observed_at: Option<i64>,
    /// Adapter-owned freshness deadline in UTC seconds. Missing legacy values
    /// cannot be interpreted as an indefinitely fresh observation.
    #[serde(default)]
    pub valid_until: Option<i64>,
    #[serde(default)]
    pub plan: Option<String>,
    #[serde(default)]
    pub allowed: Option<bool>,
    #[serde(default)]
    pub has_credits: Option<bool>,
    #[serde(default)]
    pub unlimited_credits: Option<bool>,
    #[serde(default)]
    pub windows: Vec<SubscriptionQuotaWindow>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub details: Option<SubscriptionQuotaDetails>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub display: Option<SubscriptionQuotaDisplay>,
    #[serde(default)]
    pub error: Option<String>,
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn older_snapshot_payload_preserves_unknown_values_and_roundtrips() {
        let snapshot: SubscriptionQuotaSnapshot = serde_json::from_value(serde_json::json!({
            "account_id":"codex", "provider":"codex", "state":"unknown",
            "windows":[{"id":"primary"}], "future_optional_field":"retained-by-source"
        }))
        .unwrap();
        assert_eq!(snapshot.observed_at, None);
        assert_eq!(snapshot.valid_until, None);
        assert_eq!(snapshot.allowed, None);
        assert_eq!(snapshot.details, None);
        assert_eq!(snapshot.display, None);
        assert!(serde_json::to_value(&snapshot)
            .unwrap()
            .get("details")
            .is_none());
        assert_eq!(snapshot.windows[0].used_percent, None);
        assert_eq!(snapshot.windows[0].resets_at, None);
        let restored: SubscriptionQuotaSnapshot =
            serde_json::from_value(serde_json::to_value(&snapshot).unwrap()).unwrap();
        assert_eq!(snapshot, restored);
    }

    #[test]
    fn amount_display_is_optional_and_does_not_turn_unknown_into_zero() {
        let old = serde_json::json!({"account_id":"zcode","provider":"zcode","state":"known","windows":[{"id":"primary","used_percent":25.0}]});
        let snapshot: SubscriptionQuotaSnapshot = serde_json::from_value(old).unwrap();
        assert!(snapshot.display.is_none());
        assert!(serde_json::to_value(&snapshot)
            .unwrap()
            .get("display")
            .is_none());
        let mut current = snapshot;
        current.display = Some(SubscriptionQuotaDisplay {
            version: 1,
            expires_at: None,
            meters: vec![SubscriptionQuotaMeter {
                id: "unknown-amount".into(),
                used_percent: Some(25.0),
                ..Default::default()
            }],
        });
        let wire = serde_json::to_value(&current).unwrap();
        let restored: SubscriptionQuotaSnapshot = serde_json::from_value(wire.clone()).unwrap();
        assert_eq!(restored, current);
        assert_eq!(restored.display.unwrap().meters[0].remaining, None);
        // Older consumers see the unchanged windows and ignore the optional view.
        #[derive(Deserialize)]
        struct Legacy {
            windows: Vec<SubscriptionQuotaWindow>,
        }
        assert_eq!(
            serde_json::from_value::<Legacy>(wire).unwrap().windows[0].used_percent,
            Some(25.0)
        );
    }

    #[test]
    fn scoped_quota_payload_defaults_missing_observations_without_claiming_availability() {
        let snapshot: SubscriptionQuotaSnapshot = serde_json::from_value(serde_json::json!({
            "account_id":"codex", "provider":"codex", "state":"known",
            "details":{"version":1,"valid_until":1060,
                "buckets":[{"id":"future-meter","future_field":true}],
                "models":[{"model":"model-one"}]}
        }))
        .unwrap();
        let details = snapshot.details.as_ref().unwrap();
        assert_eq!(details.buckets[0].allowed, None);
        assert!(details.buckets[0].models.is_empty());
        assert!(!details.buckets[0].separate);
        assert_eq!(details.models[0].available, None);
        assert_eq!(details.spend_control_reached, None);
        let restored = serde_json::from_value::<SubscriptionQuotaSnapshot>(
            serde_json::to_value(&snapshot).unwrap(),
        )
        .unwrap();
        assert_eq!(restored, snapshot);
    }
}
