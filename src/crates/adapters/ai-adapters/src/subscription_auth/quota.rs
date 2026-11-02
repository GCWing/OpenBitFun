//! Account-scoped subscription allowance observations. Only the adapter knows the vendor endpoint
//! and wire fields; snapshots are account-scoped and contain no token material.

use super::{accounts, codex, store, SubscriptionHttpOptions, SubscriptionProvider};
use anyhow::{anyhow, Result};
use openbitfun_core_types::subscription::{
    SubscriptionModelQuota, SubscriptionQuotaBucket, SubscriptionQuotaDetails,
    SubscriptionQuotaSnapshot, SubscriptionQuotaState, SubscriptionQuotaWindow,
};
use serde_json::Value;
use std::time::Duration;

/// Interpret provider billing details here; the runtime only validates scope,
/// freshness and this minimal conclusion. No network or storage access occurs.
pub fn model_quota_observation<'a>(
    snapshot: &'a SubscriptionQuotaSnapshot,
    model: &'a str,
    now: i64,
) -> openbitfun_core_types::subscription::ModelQuotaObservation<'a> {
    use openbitfun_core_types::subscription::{ModelQuotaEligibility, ModelQuotaObservation};
    let valid_until = snapshot
        .details
        .as_ref()
        .filter(|details| details.version == 1)
        .and_then(|details| details.valid_until);
    let eligibility =
        if snapshot.provider != "codex" || snapshot.state != SubscriptionQuotaState::Known {
            ModelQuotaEligibility::Unknown
        } else {
            match model_allowance(snapshot, model, now) {
                Allowance::Available => ModelQuotaEligibility::Attemptable,
                Allowance::Exhausted(recovery_at) => {
                    ModelQuotaEligibility::TemporarilyUnavailable { recovery_at }
                }
                Allowance::Unknown => ModelQuotaEligibility::Unknown,
            }
        };
    ModelQuotaObservation {
        account_id: &snapshot.account_id,
        provider: &snapshot.provider,
        model,
        credential_revision: snapshot.credential_revision,
        observed_at: snapshot.observed_at,
        valid_until,
        eligibility,
    }
}

enum Allowance {
    Available,
    Exhausted(Option<i64>),
    Unknown,
}

fn window_recovery(
    windows: &[openbitfun_core_types::subscription::SubscriptionQuotaWindow],
    now: i64,
) -> Option<i64> {
    windows
        .iter()
        .filter_map(|window| window.resets_at)
        .filter(|reset| *reset > now)
        .min()
}

fn windows_expired(
    windows: &[openbitfun_core_types::subscription::SubscriptionQuotaWindow],
    now: i64,
) -> bool {
    windows
        .iter()
        .any(|window| window.resets_at.is_some_and(|reset| reset <= now))
}

fn model_allowance(quota: &SubscriptionQuotaSnapshot, model: &str, now: i64) -> Allowance {
    let Some(details) = quota
        .details
        .as_ref()
        .filter(|details| details.version == 1)
    else {
        return Allowance::Unknown;
    };
    let credits = quota.has_credits == Some(true) || quota.unlimited_credits == Some(true);
    if details.spend_control_reached == Some(true)
        && details.spend_resets_at.is_some_and(|reset| reset <= now)
    {
        return Allowance::Unknown;
    }
    let spend_blocked = details.spend_control_reached == Some(true);
    let credit_funding = credits && !spend_blocked && details.overage_limit_reached != Some(true);
    if let Some(availability) = details.models.iter().find(|entry| entry.model == model) {
        match availability.available {
            Some(true) => {
                let conflicting_bucket = details.buckets.iter().any(|bucket| {
                    bucket.models.iter().any(|entry| entry == model)
                        && bucket.allowed == Some(false)
                        && !windows_expired(&bucket.windows, now)
                });
                return if spend_blocked || conflicting_bucket {
                    Allowance::Unknown
                } else {
                    Allowance::Available
                };
            }
            Some(false) => {
                if availability.available_at.is_some_and(|reset| reset <= now) {
                    return Allowance::Unknown;
                }
                if availability.credits_would_enable == Some(true) && credit_funding {
                    return Allowance::Unknown;
                }
                return Allowance::Exhausted(
                    availability.available_at.filter(|reset| *reset > now),
                );
            }
            None => {}
        }
    }
    if spend_blocked {
        return if quota.allowed == Some(true) {
            Allowance::Unknown
        } else {
            Allowance::Exhausted(details.spend_resets_at.filter(|reset| *reset > now))
        };
    }
    let buckets: Vec<_> = details
        .buckets
        .iter()
        .filter(|bucket| bucket.models.iter().any(|candidate| candidate == model))
        .collect();
    let mut unknown_bucket = false;
    for bucket in &buckets {
        if windows_expired(&bucket.windows, now) {
            unknown_bucket = true;
            continue;
        }
        if bucket.allowed == Some(false) {
            // Plan credits never prove funding of a separately metered model.
            return Allowance::Exhausted(window_recovery(&bucket.windows, now));
        }
        unknown_bucket |= bucket.allowed.is_none();
    }
    if unknown_bucket {
        return Allowance::Unknown;
    }
    if buckets.iter().any(|bucket| bucket.separate) {
        return Allowance::Available;
    }
    if details
        .buckets
        .iter()
        .any(|bucket| bucket.models.is_empty() && bucket.allowed != Some(true))
    {
        return Allowance::Unknown;
    }
    if windows_expired(&quota.windows, now) {
        return Allowance::Unknown;
    }
    match quota.allowed {
        Some(true) => Allowance::Available,
        Some(false) if credit_funding => Allowance::Available,
        // An open overage window is not proof of workspace eligibility, but
        // neither is a plan denial proof that all extra usage is unavailable.
        Some(false) if details.overage_limit_reached == Some(false) => Allowance::Unknown,
        Some(false) => Allowance::Exhausted(window_recovery(&quota.windows, now)),
        None if credit_funding && details.included_limit_reached == Some(true) => {
            Allowance::Available
        }
        None => Allowance::Unknown,
    }
}

const CODEX_QUOTA_URL: &str = "https://chatgpt.com/backend-api/wham/usage";
pub(super) const CACHE_SECONDS: i64 = 60;

pub(super) fn empty_snapshot(
    provider: SubscriptionProvider,
    account_id: &str,
    revision: u64,
) -> SubscriptionQuotaSnapshot {
    SubscriptionQuotaSnapshot {
        account_id: account_id.to_string(),
        provider: provider.key().to_string(),
        state: SubscriptionQuotaState::Unknown,
        credential_revision: revision,
        observed_at: None,
        valid_until: None,
        plan: None,
        allowed: None,
        has_credits: None,
        unlimited_credits: None,
        windows: Vec::new(),
        details: None,
        display: None,
        error: None,
    }
}

fn parse_codex_quota(
    account_id: &str,
    revision: u64,
    now: i64,
    value: &Value,
) -> Result<SubscriptionQuotaSnapshot> {
    let mut snapshot = empty_snapshot(SubscriptionProvider::Codex, account_id, revision);
    snapshot.plan = value
        .get("plan_type")
        .and_then(Value::as_str)
        .map(str::to_string);
    let rate = value.get("rate_limit");
    snapshot.allowed = rate
        .and_then(|rate| rate.get("allowed"))
        .and_then(Value::as_bool);
    let credits = value.get("credits");
    snapshot.has_credits = credits
        .and_then(|credits| credits.get("has_credits"))
        .and_then(Value::as_bool);
    snapshot.unlimited_credits = credits
        .and_then(|credits| credits.get("unlimited"))
        .and_then(Value::as_bool);
    snapshot.windows = parse_windows(rate, now)?;
    let spend = value.get("spend_control");
    let mut details = SubscriptionQuotaDetails {
        version: 1,
        valid_until: now.checked_add(CACHE_SECONDS),
        included_limit_reached: rate
            .and_then(|rate| rate.get("limit_reached"))
            .and_then(Value::as_bool),
        spend_control_reached: spend
            .and_then(|spend| spend.get("reached"))
            .and_then(Value::as_bool),
        spend_resets_at: spend
            .and_then(|spend| spend.get("individual_limit"))
            .and_then(|limit| parse_reset(limit, now)),
        overage_limit_reached: credits
            .and_then(|credits| credits.get("overage_limit_reached"))
            .and_then(Value::as_bool),
        reached_type: value
            .get("rate_limit_reached_type")
            .and_then(|reason| reason.get("type"))
            .and_then(Value::as_str)
            .map(str::to_string),
        buckets: Vec::new(),
        models: Vec::new(),
    };
    // Normalize a recognized owner-imposed spending denial into the generic
    // spend gate; runtime policy must not parse provider reason strings.
    if details.reached_type.as_deref() == Some("workspace_owner_usage_limit_reached") {
        details.spend_control_reached = Some(true);
    }
    if let Some(additional) = value
        .get("additional_rate_limits")
        .filter(|value| !value.is_null())
    {
        let additional = additional
            .as_array()
            .ok_or_else(|| anyhow!("Codex quota returned invalid additional allowances"))?;
        let mut ids = std::collections::HashSet::new();
        for (index, entry) in additional.iter().enumerate() {
            if !entry.is_object() {
                return Err(anyhow!(
                    "Codex quota returned an invalid additional allowance"
                ));
            }
            let meter = entry
                .get("metered_feature")
                .and_then(Value::as_str)
                .filter(|value| !value.is_empty());
            let name = entry
                .get("limit_name")
                .and_then(Value::as_str)
                .filter(|value| !value.is_empty());
            let id = meter
                .map(str::to_string)
                .unwrap_or_else(|| format!("additional:{index}"));
            if !ids.insert(id.clone()) {
                return Err(anyhow!(
                    "Codex quota returned duplicate additional allowance identities"
                ));
            }
            // Compatibility mapping for the independent Spark meter. Never
            // infer model membership from an arbitrary display label or suffix.
            let models = match meter {
                Some("codex_bengalfox" | "codex_spark") => vec!["gpt-5.3-codex-spark".to_string()],
                _ => Vec::new(),
            };
            let rate = entry.get("rate_limit");
            details.buckets.push(SubscriptionQuotaBucket {
                id,
                display_name: name.map(str::to_string),
                separate: !models.is_empty(),
                models,
                allowed: rate
                    .and_then(|rate| rate.get("allowed"))
                    .and_then(Value::as_bool),
                limit_reached: rate
                    .and_then(|rate| rate.get("limit_reached"))
                    .and_then(Value::as_bool),
                windows: parse_windows(rate, now)?,
            });
        }
    }
    if let Some(models) = value.get("model_usage").filter(|value| !value.is_null()) {
        let models = models
            .as_object()
            .ok_or_else(|| anyhow!("Codex quota returned invalid model availability"))?;
        for (model, entry) in models {
            if model.trim().is_empty() || !entry.is_object() {
                return Err(anyhow!("Codex quota returned invalid model availability"));
            }
            let available_at = entry
                .get("available_at")
                .and_then(|value| {
                    value
                        .as_str()
                        .and_then(|value| {
                            chrono::DateTime::parse_from_rfc3339(value)
                                .ok()
                                .map(|date| date.timestamp())
                        })
                        .or_else(|| value.as_i64())
                })
                .filter(|timestamp| {
                    *timestamp > 0 && chrono::DateTime::from_timestamp(*timestamp, 0).is_some()
                });
            details.models.push(SubscriptionModelQuota {
                model: model.clone(),
                available: entry.get("available").and_then(Value::as_bool),
                available_at,
                credits_would_enable: entry.get("credits_would_enable").and_then(Value::as_bool),
            });
        }
    }
    if snapshot.allowed.is_none()
        && snapshot
            .windows
            .iter()
            .all(|window| window.used_percent.is_none())
        && details.buckets.iter().all(|bucket| {
            bucket.allowed.is_none()
                && bucket
                    .windows
                    .iter()
                    .all(|window| window.used_percent.is_none())
        })
        && details.models.iter().all(|model| model.available.is_none())
        && details.spend_control_reached.is_none()
    {
        return Err(anyhow!(
            "Codex quota response contains no supported allowance observation"
        ));
    }
    snapshot.details = Some(details);
    snapshot.observed_at = Some(now);
    snapshot.valid_until = freshness_deadline(&snapshot);
    snapshot.state = SubscriptionQuotaState::Known;
    Ok(snapshot)
}

fn parse_reset(window: &Value, now: i64) -> Option<i64> {
    window
        .get("reset_at")
        .and_then(Value::as_i64)
        .filter(|value| *value > 0)
        .or_else(|| {
            window
                .get("reset_after_seconds")
                .and_then(Value::as_i64)
                .filter(|value| *value >= 0)
                .and_then(|value| now.checked_add(value))
        })
        .filter(|timestamp| chrono::DateTime::from_timestamp(*timestamp, 0).is_some())
}

fn parse_windows(rate: Option<&Value>, now: i64) -> Result<Vec<SubscriptionQuotaWindow>> {
    if rate.is_some_and(|value| !value.is_null() && !value.is_object()) {
        return Err(anyhow!("Codex quota returned invalid allowance windows"));
    }
    let mut windows = Vec::new();
    for (field, id) in [
        ("primary_window", "primary"),
        ("secondary_window", "secondary"),
    ] {
        let Some(window) = rate
            .and_then(|rate| rate.get(field))
            .filter(|window| !window.is_null())
        else {
            continue;
        };
        if !window.is_object() {
            return Err(anyhow!("Codex quota returned an invalid allowance window"));
        }
        let used_percent = match window.get("used_percent") {
            None | Some(Value::Null) => None,
            Some(value) => Some(
                value
                    .as_f64()
                    .filter(|value| value.is_finite() && *value >= 0.0)
                    .ok_or_else(|| anyhow!("Codex quota returned an invalid usage percentage"))?,
            ),
        };
        let duration_seconds = window
            .get("limit_window_seconds")
            .and_then(Value::as_u64)
            .filter(|value| *value > 0);
        let resets_at = window
            .get("reset_at")
            .and_then(Value::as_i64)
            .filter(|value| *value > 0)
            .or_else(|| {
                window
                    .get("reset_after_seconds")
                    .and_then(Value::as_i64)
                    .filter(|value| *value >= 0)
                    .and_then(|value| now.checked_add(value))
            })
            .filter(|timestamp| chrono::DateTime::from_timestamp(*timestamp, 0).is_some());
        windows.push(SubscriptionQuotaWindow {
            id: id.to_string(),
            duration_seconds,
            used_percent,
            resets_at,
        });
    }
    Ok(windows)
}

fn freshness_deadline(snapshot: &SubscriptionQuotaSnapshot) -> Option<i64> {
    let deadline = snapshot.observed_at?.checked_add(CACHE_SECONDS)?;
    Some(
        snapshot
            .windows
            .iter()
            .filter_map(|window| window.resets_at)
            .fold(deadline, i64::min),
    )
}

fn is_fresh(snapshot: &SubscriptionQuotaSnapshot, now: i64) -> bool {
    if snapshot.provider != "codex" {
        return snapshot.state == SubscriptionQuotaState::Known
            && snapshot.observed_at.is_some_and(|at| at <= now)
            && snapshot.valid_until.is_some_and(|until| until > now);
    }

    snapshot.state == SubscriptionQuotaState::Known
        && snapshot.observed_at.is_some_and(|observed| observed <= now)
        && match &snapshot.details {
            Some(details) => {
                details.version == 1
                    && snapshot
                        .observed_at
                        .and_then(|observed| observed.checked_add(CACHE_SECONDS))
                        .zip(details.valid_until)
                        .is_some_and(|(ttl, deadline)| now < ttl.min(deadline))
            }
            None => freshness_deadline(snapshot).is_some_and(|deadline| now < deadline),
        }
}

pub(super) fn supports_quota(provider: SubscriptionProvider) -> bool {
    matches!(
        provider,
        SubscriptionProvider::Codex
            | SubscriptionProvider::Grok
            | SubscriptionProvider::Zcode
            | SubscriptionProvider::ZcodeCn
    )
}

/// Reads the last observation without resolving credentials or contacting the
/// provider. Runtime routing can consume this path so quota reads cannot turn each
/// model attempt into a blocking network refresh.
pub async fn cached_account_quota(
    provider: SubscriptionProvider,
    account_id: &str,
) -> Result<SubscriptionQuotaSnapshot> {
    accounts::validate_account_id(provider, account_id)?;
    let (revision, cached) = store::load_account_quota(account_id).await?;
    let mut snapshot = cached.unwrap_or_else(|| empty_snapshot(provider, account_id, revision));
    if !supports_quota(provider) {
        snapshot.state = SubscriptionQuotaState::Unsupported;
    } else if snapshot.state == SubscriptionQuotaState::Known {
        if !is_fresh(&snapshot, chrono::Utc::now().timestamp()) {
            snapshot.state = SubscriptionQuotaState::Stale;
        }
        if provider == SubscriptionProvider::Codex {
            snapshot.valid_until = freshness_deadline(&snapshot);
        }
    }
    Ok(snapshot)
}

/// Reads cached observations or refreshes on the account's host. A failed
/// refresh retains a previous observation without extending its read time.
pub async fn read_account_quota_with_options(
    provider: SubscriptionProvider,
    account_id: &str,
    force_refresh: bool,
    options: &SubscriptionHttpOptions,
) -> Result<SubscriptionQuotaSnapshot> {
    accounts::validate_account_id(provider, account_id)?;
    if provider != SubscriptionProvider::Codex && supports_quota(provider) {
        return super::vendor_quota::read(provider, account_id, force_refresh, options).await;
    }
    if provider != SubscriptionProvider::Codex {
        let revision = store::credential_revision(account_id).await?;
        let mut snapshot = empty_snapshot(provider, account_id, revision);
        snapshot.state = SubscriptionQuotaState::Unsupported;
        if provider == SubscriptionProvider::Opencode {
            snapshot.error = Some("opencode_balance_unavailable".into());
        }
        return Ok(snapshot);
    }
    read_codex_at(account_id, force_refresh, options, CODEX_QUOTA_URL).await
}

async fn read_codex_at(
    account_id: &str,
    force_refresh: bool,
    options: &SubscriptionHttpOptions,
    endpoint: &str,
) -> Result<SubscriptionQuotaSnapshot> {
    // Reuse the OS lease primitive with a distinct key from token refresh.
    // Reload after acquisition so concurrent processes coalesce ordinary reads.
    let _lease = store::acquire_provider_refresh_lease(&format!("{account_id}-quota")).await?;
    let (revision, cached) = store::load_account_quota(account_id).await?;
    let now = chrono::Utc::now().timestamp();
    if !force_refresh {
        if let Some(snapshot) = cached.as_ref().filter(|snapshot| is_fresh(snapshot, now)) {
            let mut snapshot = snapshot.clone();
            snapshot.valid_until = freshness_deadline(&snapshot);
            return Ok(snapshot);
        }
    }
    let observation = fetch_codex(account_id, options, endpoint).await;
    let mut snapshot = match observation {
        Ok(snapshot) => snapshot,
        Err(error) => {
            let mut snapshot = cached.unwrap_or_else(|| {
                empty_snapshot(SubscriptionProvider::Codex, account_id, revision)
            });
            snapshot.state = SubscriptionQuotaState::QueryFailed;
            snapshot.error = Some(error.to_string());
            snapshot
        }
    };
    if !store::save_account_quota(&snapshot).await? {
        // An older request must not expose its observation as the current
        // account's even if its upstream HTTP call succeeded.
        let revision = store::credential_revision(account_id).await?;
        snapshot = empty_snapshot(SubscriptionProvider::Codex, account_id, revision);
        snapshot.state = SubscriptionQuotaState::Stale;
        snapshot.error =
            Some("Account authorization changed while reading quota; refresh again".to_string());
    }
    Ok(snapshot)
}

async fn fetch_codex(
    account_id: &str,
    options: &SubscriptionHttpOptions,
    endpoint: &str,
) -> Result<SubscriptionQuotaSnapshot> {
    let (credential, revision) = codex::resolve_account_versioned(account_id, options)
        .await
        .map_err(|_| anyhow!("Could not resolve this account's subscription authorization"))?;
    let client = super::build_http_client_with_redirect_policy(
        options,
        "Codex quota",
        reqwest::redirect::Policy::none(),
    )
    .map_err(|_| anyhow!("Could not initialize subscription quota transport"))?;
    let mut request = client
        .get(endpoint)
        .bearer_auth(&credential.api_key)
        .timeout(Duration::from_secs(15));
    for (name, value) in &credential.extra_headers {
        request = request.header(name, value);
    }
    let response = request.send().await.map_err(|_| {
        anyhow!("Subscription quota request failed; check the account's network connection")
    })?;
    if !response.status().is_success() {
        return Err(anyhow!(
            "Subscription quota endpoint returned HTTP {}",
            response.status().as_u16()
        ));
    }
    let value: Value = response
        .json()
        .await
        .map_err(|_| anyhow!("Subscription quota endpoint returned invalid JSON"))?;
    parse_codex_quota(account_id, revision, chrono::Utc::now().timestamp(), &value)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn independent_meters_and_exact_model_availability_keep_their_scopes() {
        let snapshot = parse_codex_quota("codex", 3, 1000, &serde_json::json!({
            "rate_limit":{"allowed":false,"primary_window":{"used_percent":100,"reset_at":1010}},
            "additional_rate_limits":[
                {"metered_feature":"codex_bengalfox","limit_name":"GPT-5.3-Codex-Spark","rate_limit":{"allowed":true,"primary_window":{"used_percent":7,"reset_at":1040}}},
                {"metered_feature":"future_meter","limit_name":"gpt-5.3-codex-spark","rate_limit":{"allowed":false}}
            ],
            "model_usage":{"gpt-6-astra":{"available":false,"available_at":"2030-01-01T00:00:00Z","credits_would_enable":false}},
            "credits":{"has_credits":true,"overage_limit_reached":false},
            "spend_control":{"reached":false}
        })).unwrap();
        let details = snapshot.details.as_ref().unwrap();
        assert_eq!(details.version, 1);
        assert_eq!(details.valid_until, Some(1060));
        assert_eq!(snapshot.valid_until, Some(1010));
        assert_eq!(details.buckets[0].models, ["gpt-5.3-codex-spark"]);
        assert!(details.buckets[0].separate);
        assert_eq!(details.buckets[0].windows[0].used_percent, Some(7.0));
        assert_eq!(details.buckets[0].windows[0].resets_at, Some(1040));
        assert!(
            details.buckets[1].models.is_empty(),
            "labels must not invent membership"
        );
        assert_eq!(details.models[0].available_at, Some(1_893_456_000));
        assert_eq!(details.models[0].credits_would_enable, Some(false));
        assert!(
            is_fresh(&snapshot, 1011),
            "other scopes remain observable after a shared reset"
        );
    }

    #[test]
    fn owner_limits_and_partial_observations_are_not_replaced_with_false_allowance() {
        let snapshot = parse_codex_quota(
            "codex",
            1,
            1000,
            &serde_json::json!({
                "spend_control":{"reached":false,"individual_limit":{"reset_after_seconds":30}},
                "rate_limit_reached_type":{"type":"workspace_owner_usage_limit_reached"},
                "model_usage":{"model-one":{"available":false,"available_at":"invalid"}}
            }),
        )
        .unwrap();
        let details = snapshot.details.unwrap();
        assert_eq!(details.spend_control_reached, Some(true));
        assert_eq!(details.spend_resets_at, Some(1030));
        assert_eq!(details.models[0].available_at, None);
        assert_eq!(snapshot.allowed, None);
        let extra_only = parse_codex_quota("codex", 1, 1000, &serde_json::json!({
            "additional_rate_limits":[{"metered_feature":"codex_spark","rate_limit":{"allowed":true}}]
        })).unwrap();
        assert_eq!(extra_only.allowed, None);
        assert!(extra_only.windows.is_empty());
        assert_eq!(extra_only.details.unwrap().buckets[0].allowed, Some(true));
        for malformed in [
            serde_json::json!({"additional_rate_limits":{}}),
            serde_json::json!({"additional_rate_limits":[{"metered_feature":"x"},{"metered_feature":"x"}]}),
            serde_json::json!({"rate_limit":{"allowed":true,"primary_window":[]}}),
        ] {
            assert!(parse_codex_quota("codex", 0, 1000, &malformed).is_err());
        }
    }

    #[test]
    fn codex_windows_keep_observation_time_and_unknown_values() {
        let value = serde_json::json!({"plan_type":"team", "rate_limit":{"allowed":true,
            "primary_window":{"used_percent":97,"limit_window_seconds":18000,"reset_after_seconds":120},
            "secondary_window":{"reset_at":2000}}, "credits":{"has_credits":false}});
        let snapshot = parse_codex_quota("codex", 3, 1000, &value).unwrap();
        assert_eq!(snapshot.observed_at, Some(1000));
        assert_eq!(snapshot.valid_until, Some(1060));
        assert_eq!(snapshot.windows[0].resets_at, Some(1120));
        assert_eq!(snapshot.windows[0].used_percent, Some(97.0));
        assert_eq!(snapshot.windows[1].used_percent, None);
        assert_eq!(snapshot.windows[1].resets_at, Some(2000));
        assert_eq!(snapshot.allowed, Some(true));
        assert!(parse_codex_quota("codex", 0, 1000, &serde_json::json!({})).is_err());
        assert!(parse_codex_quota(
            "codex",
            0,
            1000,
            &serde_json::json!({"rate_limit":{"primary_window":{"used_percent":-1}}})
        )
        .is_err());
        let invalid_reset = parse_codex_quota(
            "codex",
            0,
            1000,
            &serde_json::json!({
                "rate_limit":{"allowed":true,"primary_window":{"reset_at":i64::MAX}}
            }),
        )
        .unwrap();
        assert_eq!(invalid_reset.windows[0].resets_at, None);
    }

    #[test]
    fn collection_ttl_does_not_turn_one_reset_into_expiry_of_unrelated_scopes() {
        let snapshot = parse_codex_quota(
            "codex",
            0,
            1000,
            &serde_json::json!({
                "rate_limit":{"allowed":true,"primary_window":{"reset_at":1010,"used_percent":90}}
            }),
        )
        .unwrap();
        assert_eq!(snapshot.valid_until, Some(1010));
        assert!(is_fresh(&snapshot, 1009));
        assert!(is_fresh(&snapshot, 1010));
        assert!(!is_fresh(&snapshot, 1060));
        assert!(!is_fresh(&snapshot, 999));
        let mut invalid = snapshot;
        invalid.observed_at = Some(i64::MAX);
        assert!(!is_fresh(&invalid, i64::MAX));
        invalid.observed_at = Some(i64::MIN);
        assert!(!is_fresh(&invalid, 1000));
    }

    #[tokio::test]
    async fn persistent_cache_is_revision_scoped_and_stale_writes_cannot_resurrect_it() {
        use crate::subscription_auth::{tests, StoredCredential};
        let _guard = tests::test_lock().lock().await;
        let path = tests::temp_store_path();
        store::set_store_path_for_test(path.clone());
        store::upsert(
            "codex",
            StoredCredential::Oauth {
                refresh: "synthetic-refresh".into(),
                access: "synthetic-access".into(),
                expires: chrono::Utc::now().timestamp_millis() + 3_600_000,
                account_id: Some("seat".into()),
                metadata: None,
            },
        )
        .await
        .unwrap();
        let revision = store::credential_revision("codex").await.unwrap();
        let snapshot = parse_codex_quota("codex", revision, chrono::Utc::now().timestamp(), &serde_json::json!({"rate_limit":{"allowed":true,"primary_window":{"used_percent":40}}})).unwrap();
        assert!(store::save_account_quota(&snapshot).await.unwrap());
        assert_eq!(
            store::load_account_quota("codex").await.unwrap().1,
            Some(snapshot.clone())
        );
        let bytes = std::fs::read_to_string(path.with_extension("quotas.json")).unwrap();
        assert!(!bytes.contains("synthetic-access"));
        assert!(!bytes.contains("synthetic-refresh"));
        let cache_path = path.with_extension("quotas.json");
        let mut raw: Value = serde_json::from_str(&bytes).unwrap();
        raw["future_root"] = serde_json::json!({"keep":true});
        raw["accounts"]["future_account"] =
            serde_json::json!({"details":{"version":99},"future":true});
        tokio::fs::write(&cache_path, serde_json::to_vec(&raw).unwrap())
            .await
            .unwrap();
        assert!(store::save_account_quota(&snapshot).await.unwrap());
        let preserved: Value =
            serde_json::from_slice(&tokio::fs::read(&cache_path).await.unwrap()).unwrap();
        assert_eq!(preserved["future_root"], raw["future_root"]);
        assert_eq!(
            preserved["accounts"]["future_account"],
            raw["accounts"]["future_account"]
        );
        let mut future = preserved.clone();
        future["accounts"]["codex"]["details"]["version"] = serde_json::json!(99);
        let future_bytes = serde_json::to_vec(&future).unwrap();
        tokio::fs::write(&cache_path, &future_bytes).await.unwrap();
        assert!(store::load_account_quota("codex").await.is_err());
        assert!(store::save_account_quota(&snapshot).await.is_err());
        assert_eq!(tokio::fs::read(&cache_path).await.unwrap(), future_bytes);
        let mut future_display = preserved.clone();
        future_display["accounts"]["codex"]["display"] =
            serde_json::json!({"version":99,"future":"keep"});
        let future_display_bytes = serde_json::to_vec(&future_display).unwrap();
        tokio::fs::write(&cache_path, &future_display_bytes)
            .await
            .unwrap();
        assert!(store::load_account_quota("codex").await.is_err());
        assert!(store::save_account_quota(&snapshot).await.is_err());
        assert_eq!(
            tokio::fs::read(&cache_path).await.unwrap(),
            future_display_bytes
        );
        tokio::fs::write(&cache_path, serde_json::to_vec(&preserved).unwrap())
            .await
            .unwrap();
        let listener = tokio::net::TcpListener::bind(("127.0.0.1", 0))
            .await
            .unwrap();
        let endpoint = format!("http://{}/quota", listener.local_addr().unwrap());
        let app = axum::Router::new().route(
            "/quota",
            axum::routing::get(|| async { axum::http::StatusCode::SERVICE_UNAVAILABLE }),
        );
        let server = tokio::spawn(async move {
            axum::serve(listener, app).await.unwrap();
        });
        let cached = read_codex_at(
            "codex",
            false,
            &SubscriptionHttpOptions::default(),
            &endpoint,
        )
        .await
        .unwrap();
        assert_eq!(cached, snapshot);
        let failed = read_codex_at(
            "codex",
            true,
            &SubscriptionHttpOptions::default(),
            &endpoint,
        )
        .await
        .unwrap();
        assert_eq!(failed.state, SubscriptionQuotaState::QueryFailed);
        assert_eq!(failed.windows, snapshot.windows);
        assert_eq!(failed.observed_at, snapshot.observed_at);
        let mut expired = snapshot.clone();
        expired.observed_at = Some(chrono::Utc::now().timestamp() - CACHE_SECONDS - 1);
        assert!(store::save_account_quota(&expired).await.unwrap());
        let stale = cached_account_quota(SubscriptionProvider::Codex, "codex")
            .await
            .unwrap();
        assert_eq!(stale.state, SubscriptionQuotaState::Stale);
        assert_eq!(stale.observed_at, expired.observed_at);
        assert_eq!(stale.windows, expired.windows);
        server.abort();
        store::remove("codex").await.unwrap();
        assert!(store::load_account_quota("codex")
            .await
            .unwrap()
            .1
            .is_none());
        assert!(!store::save_account_quota(&snapshot).await.unwrap());
        let future_cache = serde_json::json!({"version":99,"accounts":{"future":"keep"}});
        std::fs::write(
            path.with_extension("quotas.json"),
            serde_json::to_vec(&future_cache).unwrap(),
        )
        .unwrap();
        assert!(store::load_account_quota("codex").await.is_err());
        assert_eq!(
            serde_json::from_slice::<Value>(
                &std::fs::read(path.with_extension("quotas.json")).unwrap()
            )
            .unwrap(),
            future_cache
        );
    }

    #[tokio::test]
    async fn quota_requests_use_exact_account_and_logout_invalidates_in_flight_results() {
        use crate::subscription_auth::{tests, StoredCredential};
        use std::sync::Arc;
        let _guard = tests::test_lock().lock().await;
        store::set_store_path_for_test(tests::temp_store_path());
        let account_id = format!("codex-account-{}", uuid::Uuid::new_v4());
        store::upsert(
            &account_id,
            StoredCredential::Oauth {
                refresh: "synthetic-refresh".into(),
                access: "synthetic-access".into(),
                expires: chrono::Utc::now().timestamp_millis() + 3_600_000,
                account_id: Some("exact-seat".into()),
                metadata: None,
            },
        )
        .await
        .unwrap();
        let started = Arc::new(tokio::sync::Notify::new());
        let release = Arc::new(tokio::sync::Notify::new());
        let handler_started = started.clone();
        let handler_release = release.clone();
        let app = axum::Router::new().route("/quota", axum::routing::get(move |headers: axum::http::HeaderMap| {
            let started = handler_started.clone();
            let release = handler_release.clone();
            async move {
                assert_eq!(headers["authorization"], "Bearer synthetic-access");
                assert_eq!(headers["chatgpt-account-id"], "exact-seat");
                assert_eq!(headers["originator"], "openbitfun");
                started.notify_one();
                release.notified().await;
                axum::Json(serde_json::json!({"rate_limit":{"allowed":true,"primary_window":{"used_percent":20}}}))
            }
        }));
        let listener = tokio::net::TcpListener::bind(("127.0.0.1", 0))
            .await
            .unwrap();
        let endpoint = format!("http://{}/quota", listener.local_addr().unwrap());
        let server = tokio::spawn(async move {
            axum::serve(listener, app).await.unwrap();
        });
        let slot = account_id.clone();
        let query = tokio::spawn(async move {
            read_codex_at(&slot, true, &SubscriptionHttpOptions::default(), &endpoint).await
        });
        tokio::time::timeout(Duration::from_secs(5), started.notified())
            .await
            .unwrap();
        accounts::logout_account(SubscriptionProvider::Codex, &account_id)
            .await
            .unwrap();
        release.notify_one();
        let result = query.await.unwrap().unwrap();
        assert_eq!(result.state, SubscriptionQuotaState::Stale);
        assert!(result.windows.is_empty());
        assert!(store::load_account_quota(&account_id)
            .await
            .unwrap()
            .1
            .is_none());
        server.abort();
    }
}

#[cfg(test)]
mod routing_eligibility_tests {
    use super::*;
    use openbitfun_core_types::subscription::ModelQuotaEligibility;
    fn quota() -> SubscriptionQuotaSnapshot {
        SubscriptionQuotaSnapshot {
            account_id: "primary".into(),
            provider: "codex".into(),
            state: SubscriptionQuotaState::Known,
            credential_revision: 3,
            observed_at: Some(1000),
            valid_until: Some(1060),
            plan: None,
            allowed: Some(false),
            has_credits: None,
            unlimited_credits: None,
            windows: vec![],
            details: Some(
                openbitfun_core_types::subscription::SubscriptionQuotaDetails {
                    version: 1,
                    valid_until: Some(1060),
                    included_limit_reached: None,
                    spend_control_reached: None,
                    spend_resets_at: None,
                    overage_limit_reached: None,
                    reached_type: None,
                    buckets: Vec::new(),
                    models: Vec::new(),
                },
            ),
            display: None,
            error: None,
        }
    }
    fn decision(
        snapshot: &SubscriptionQuotaSnapshot,
        model: &str,
        now: i64,
    ) -> ModelQuotaEligibility {
        let observation = model_quota_observation(snapshot, model, now);
        if observation.observed_at.is_none_or(|at| at > now)
            || observation.valid_until.is_none_or(|until| until <= now)
        {
            ModelQuotaEligibility::Unknown
        } else {
            observation.eligibility
        }
    }
    fn model_bucket(
        allowed: bool,
        reset: i64,
    ) -> openbitfun_core_types::subscription::SubscriptionQuotaBucket {
        use openbitfun_core_types::subscription::{
            SubscriptionQuotaBucket, SubscriptionQuotaWindow,
        };
        SubscriptionQuotaBucket {
            id: "separate-meter".into(),
            display_name: None,
            models: vec!["special-model".into()],
            separate: true,
            allowed: Some(allowed),
            limit_reached: Some(!allowed),
            windows: vec![SubscriptionQuotaWindow {
                id: "primary".into(),
                duration_seconds: Some(100),
                used_percent: Some(100.0),
                resets_at: Some(reset),
            }],
        }
    }

    #[test]
    fn separate_model_meter_does_not_disable_other_models_and_plan_credits_do_not_fund_it() {
        let mut observation = quota();
        observation.allowed = Some(true);
        observation.has_credits = Some(true);
        observation
            .details
            .as_mut()
            .unwrap()
            .buckets
            .push(model_bucket(false, 1040));
        assert!(matches!(
            decision(&observation, "test-model", 1001),
            ModelQuotaEligibility::Attemptable
        ));
        assert_eq!(
            decision(&observation, "special-model", 1001),
            ModelQuotaEligibility::TemporarilyUnavailable {
                recovery_at: Some(1040)
            }
        );
        let details = observation.details.as_mut().unwrap();
        details.buckets[0].allowed = Some(true);
        observation.allowed = Some(false);
        observation.has_credits = Some(false);
        assert!(matches!(
            decision(&observation, "special-model", 1001),
            ModelQuotaEligibility::Attemptable
        ));
        assert!(matches!(
            decision(&observation, "test-model", 1001),
            ModelQuotaEligibility::TemporarilyUnavailable { .. } | ModelQuotaEligibility::Unknown
        ));
    }

    #[test]
    fn a_shared_window_reset_does_not_expire_an_independent_model_meter_or_restore_allowance() {
        let mut observation = quota();
        observation.windows = model_bucket(false, 1010).windows;
        observation.valid_until = Some(1010);
        observation
            .details
            .as_mut()
            .unwrap()
            .buckets
            .push(model_bucket(true, 1040));
        assert!(matches!(
            decision(&observation, "special-model", 1011),
            ModelQuotaEligibility::Attemptable
        ));
        assert!(matches!(
            decision(&observation, "test-model", 1011),
            ModelQuotaEligibility::Unknown
        ));
        assert!(matches!(
            decision(&observation, "special-model", 1040),
            ModelQuotaEligibility::Unknown
        ));
    }

    #[test]
    fn exact_model_availability_beats_plan_percentages_but_contradictions_stay_unknown() {
        use openbitfun_core_types::subscription::SubscriptionModelQuota;
        let mut observation = quota();
        observation.allowed = Some(true);
        observation.has_credits = Some(true);
        observation
            .details
            .as_mut()
            .unwrap()
            .models
            .push(SubscriptionModelQuota {
                model: "test-model".into(),
                available: Some(false),
                available_at: Some(1040),
                credits_would_enable: Some(false),
            });
        assert!(matches!(
            decision(&observation, "test-model", 1001),
            ModelQuotaEligibility::TemporarilyUnavailable {
                recovery_at: Some(1040)
            }
        ));
        assert!(matches!(
            decision(&observation, "another-model", 1001),
            ModelQuotaEligibility::Attemptable
        ));
        observation.details.as_mut().unwrap().models[0].credits_would_enable = Some(true);
        assert!(matches!(
            decision(&observation, "test-model", 1001),
            ModelQuotaEligibility::Unknown
        ));
        observation.details.as_mut().unwrap().models[0].available = Some(true);
        observation.allowed = Some(false);
        observation.has_credits = Some(false);
        assert!(matches!(
            decision(&observation, "test-model", 1001),
            ModelQuotaEligibility::Attemptable
        ));
    }

    #[test]
    fn spend_controls_cannot_be_bypassed_with_credits_and_an_open_overage_is_not_permission() {
        let mut observation = quota();
        observation.has_credits = Some(true);
        let details = observation.details.as_mut().unwrap();
        details.spend_control_reached = Some(true);
        details.spend_resets_at = Some(1040);
        assert_eq!(
            decision(&observation, "test-model", 1001),
            ModelQuotaEligibility::TemporarilyUnavailable {
                recovery_at: Some(1040)
            }
        );
        assert!(matches!(
            decision(&observation, "test-model", 1040),
            ModelQuotaEligibility::Unknown
        ));
        observation.has_credits = Some(false);
        observation.details.as_mut().unwrap().spend_control_reached = Some(false);
        observation.details.as_mut().unwrap().overage_limit_reached = Some(false);
        assert!(matches!(
            decision(&observation, "test-model", 1001),
            ModelQuotaEligibility::Unknown
        ));
    }

    #[test]
    fn legacy_and_unmapped_observations_never_invent_model_applicability() {
        let mut observation = quota();
        observation.details = None;
        assert!(matches!(
            decision(&observation, "test-model", 1001),
            ModelQuotaEligibility::Unknown
        ));
        observation = quota();
        observation.allowed = Some(true);
        let mut bucket = model_bucket(false, 1040);
        bucket.models.clear();
        observation.details.as_mut().unwrap().buckets.push(bucket);
        assert!(matches!(
            decision(&observation, "test-model", 1001),
            ModelQuotaEligibility::Unknown
        ));
    }

    #[test]
    fn percentage_alone_is_unknown_and_credits_keep_an_account_probeable() {
        let mut snapshot = quota();
        snapshot.allowed = None;
        snapshot.windows = model_bucket(false, 2000).windows;
        assert_eq!(
            decision(&snapshot, "test-model", 1001),
            ModelQuotaEligibility::Unknown
        );
        snapshot.allowed = Some(false);
        assert_eq!(
            decision(&snapshot, "test-model", 1001),
            ModelQuotaEligibility::TemporarilyUnavailable {
                recovery_at: Some(2000)
            }
        );
        snapshot.has_credits = Some(true);
        assert_eq!(
            decision(&snapshot, "test-model", 1001),
            ModelQuotaEligibility::Attemptable
        );
        snapshot.has_credits = Some(false);
        snapshot.unlimited_credits = Some(true);
        assert_eq!(
            decision(&snapshot, "test-model", 1001),
            ModelQuotaEligibility::Attemptable
        );
    }
}
