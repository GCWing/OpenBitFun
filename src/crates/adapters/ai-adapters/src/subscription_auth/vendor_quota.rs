//! WorkBuddy, ZCode and Grok billing reads. Endpoints, units and regional account
//! headers stay in this adapter; display observations never gate model routing.
use super::{accounts, browser_poll, quota, store, SubscriptionHttpOptions, SubscriptionProvider};
use anyhow::{anyhow, Result};
use openbitfun_core_types::subscription::{
    SubscriptionQuotaDisplay, SubscriptionQuotaMeter, SubscriptionQuotaSnapshot,
    SubscriptionQuotaState, SubscriptionQuotaWindow,
};
use serde_json::{json, Value};
use std::time::Duration;

fn number(value: &Value) -> Option<f64> {
    value
        .as_f64()
        .or_else(|| {
            value
                .as_str()
                .filter(|s| !s.trim().is_empty())
                .and_then(|s| s.parse().ok())
        })
        .filter(|n| n.is_finite() && *n >= 0.0)
}

fn timestamp(value: &Value) -> Option<i64> {
    let raw = number(value).filter(|n| *n > 0.0);
    let parsed = raw
        .map(|n| {
            if n > 100_000_000_000.0 {
                (n / 1000.0) as i64
            } else {
                n as i64
            }
        })
        .or_else(|| {
            value
                .as_str()
                .and_then(|s| chrono::DateTime::parse_from_rfc3339(s).ok())
                .map(|d| d.timestamp())
        })
        .or_else(|| {
            value.as_str().and_then(|s| {
                let date = chrono::NaiveDateTime::parse_from_str(s.trim(), "%Y-%m-%d %H:%M:%S")
                    .ok()
                    .or_else(|| {
                        chrono::NaiveDate::parse_from_str(s.trim(), "%Y-%m-%d")
                            .ok()
                            .and_then(|d| d.and_hms_opt(0, 0, 0))
                    })?;
                date.and_local_timezone(chrono::FixedOffset::east_opt(8 * 3600)?)
                    .single()
                    .map(|d| d.timestamp())
            })
        });
    parsed.filter(|s| chrono::DateTime::from_timestamp(*s, 0).is_some())
}

fn amounts(
    id: String,
    used: Option<f64>,
    limit: Option<f64>,
    remaining: Option<f64>,
) -> SubscriptionQuotaMeter {
    let remaining =
        remaining.or_else(|| limit.zip(used).map(|(limit, used)| (limit - used).max(0.0)));
    let used = used.or_else(|| {
        limit
            .zip(remaining)
            .map(|(limit, left)| (limit - left).max(0.0))
    });
    let used_percent = limit
        .filter(|limit| *limit > 0.0)
        .zip(used)
        .map(|(limit, used)| used / limit * 100.0);
    SubscriptionQuotaMeter {
        id,
        used,
        limit,
        remaining,
        used_percent,
        ..Default::default()
    }
}

fn snapshot(
    provider: SubscriptionProvider,
    slot: &str,
    revision: u64,
    now: i64,
    plan: Option<String>,
    expires_at: Option<i64>,
    meters: Vec<SubscriptionQuotaMeter>,
) -> SubscriptionQuotaSnapshot {
    let mut snapshot = quota::empty_snapshot(provider, slot, revision);
    snapshot.state = if meters.is_empty() {
        SubscriptionQuotaState::Unknown
    } else {
        SubscriptionQuotaState::Known
    };
    snapshot.observed_at = Some(now);
    snapshot.valid_until = Some(
        meters
            .iter()
            .filter_map(|m| m.resets_at)
            .fold(now + quota::CACHE_SECONDS, i64::min),
    );
    snapshot.plan = plan;
    snapshot.windows = meters
        .iter()
        .filter(|meter| !meter.secondary)
        .map(|meter| SubscriptionQuotaWindow {
            id: meter.id.clone(),
            duration_seconds: meter.duration_seconds,
            used_percent: meter.used_percent,
            resets_at: meter.resets_at,
        })
        .collect();
    snapshot.display = Some(SubscriptionQuotaDisplay {
        version: 1,
        expires_at,
        meters,
    });
    snapshot
}

fn parse_workbuddy(
    provider: SubscriptionProvider,
    slot: &str,
    revision: u64,
    now: i64,
    data: &Value,
    enterprise: Option<&Value>,
) -> Result<SubscriptionQuotaSnapshot> {
    let plan = if enterprise.is_some() {
        Some("Enterprise".to_owned())
    } else {
        data["IsPaidUser"]
            .as_bool()
            .map(|paid| if paid { "Pro" } else { "Free" }.to_owned())
    };
    let mut meters = Vec::new();
    if let Some(enterprise) = enterprise {
        let limit = number(&enterprise["limitNum"]);
        let used = number(&enterprise["credit"]);
        if limit.is_some() || used.is_some() {
            let mut meter = amounts("credits".into(), used, limit, None);
            meter.unit = Some("credits".into());
            meter.resets_at = timestamp(&enterprise["cycleResetTime"]);
            meter.duration_seconds = timestamp(&enterprise["cycleStartTime"])
                .zip(meter.resets_at)
                .filter(|(start, end)| end > start)
                .map(|(start, end)| (end - start) as u64);
            meters.push(meter);
        }
    } else {
        let packages = data["Packages"]
            .as_array()
            .ok_or_else(|| anyhow!("WorkBuddy quota response missing package list"))?;
        if !packages.is_empty() {
            // Aggregate only complete vendor fields. A missing capacity in one
            // package must not make the displayed account total look smaller.
            let total = packages
                .iter()
                .map(|p| number(&p["CycleTotalCapacity"]))
                .collect::<Option<Vec<_>>>()
                .map(|ns| ns.iter().sum());
            let used = packages
                .iter()
                .map(|p| number(&p["CycleUsedCapacity"]))
                .collect::<Option<Vec<_>>>()
                .map(|ns| ns.iter().sum());
            let left = packages
                .iter()
                .map(|p| number(&p["CycleRemainCapacity"]))
                .collect::<Option<Vec<_>>>()
                .map(|ns| ns.iter().sum());
            if total.is_some() || used.is_some() || left.is_some() {
                let mut meter = amounts("credits".into(), used, total, left);
                meter.unit = Some("credits".into());
                meter.expires_at = packages
                    .iter()
                    .filter_map(|p| {
                        timestamp(&p["ExpiredTime"]).or_else(|| timestamp(&p["DeductionEndTime"]))
                    })
                    .filter(|at| *at > now)
                    .min();
                meter.resets_at = packages
                    .iter()
                    .filter_map(|p| timestamp(&p["CycleEndTime"]))
                    .filter(|at| *at > now)
                    .min();
                meters.push(meter);
            }
        }
    }
    Ok(snapshot(provider, slot, revision, now, plan, None, meters))
}

fn zcode_duration(value: &Value) -> Option<u64> {
    let unit = number(&value["unit"])? as u64;
    let count = number(&value["number"])
        .filter(|n| *n > 0.0)
        .map(|n| n as u64)
        .unwrap_or(if unit == 3 { 5 } else { 1 });
    let multiplier = match unit {
        1 => 60,
        3 => 3600,
        4 => 86400,
        5 => 30 * 86400,
        6 => 7 * 86400,
        _ => return None,
    };
    count.checked_mul(multiplier)
}

fn parse_zcode(
    provider: SubscriptionProvider,
    slot: &str,
    revision: u64,
    now: i64,
    data: &Value,
    metadata: &Value,
    subscriptions: Option<&Value>,
) -> Result<SubscriptionQuotaSnapshot> {
    let limits = data["limits"]
        .as_array()
        .ok_or_else(|| anyhow!("ZCode quota response missing limits"))?;
    let mut meters = Vec::new();
    for (index, limit) in limits.iter().enumerate() {
        let total = number(&limit["usage"]);
        let left = number(&limit["remaining"]);
        let used = total
            .zip(left)
            .map(|(total, left)| (total - left).max(0.0))
            .or_else(|| number(&limit["currentValue"]));
        let mut meter = amounts(format!("limit-{index}"), used, total, left);
        if left.is_none() && number(&limit["percentage"]).is_some() {
            meter.used_percent = number(&limit["percentage"]);
        }
        let kind = browser_poll::text(limit, "type");
        meter.secondary = kind.eq_ignore_ascii_case("TIME_LIMIT");
        meter.unlimited = total == Some(0.0);
        if meter.unlimited {
            meter.used_percent = None;
            meter.remaining = None;
        }
        meter.unit = if meter.secondary {
            Some("requests".into())
        } else if kind.eq_ignore_ascii_case("CREDIT_LIMIT") {
            Some("credits".into())
        } else {
            None
        };
        meter.duration_seconds = zcode_duration(limit);
        meter.resets_at = timestamp(&limit["nextResetTime"]);
        meters.push(meter);
    }
    let level = browser_poll::text(data, "level");
    let plan = if !level.is_empty() {
        Some(format!("GLM Coding {level}"))
    } else {
        metadata["plan"]
            .as_str()
            .filter(|s| !s.is_empty())
            .map(str::to_owned)
    };
    let expires = subscriptions
        .and_then(Value::as_array)
        .and_then(|subs| {
            subs.iter()
                .find(|s| browser_poll::text(s, "status").eq_ignore_ascii_case("VALID"))
        })
        .and_then(|s| timestamp(&s["nextRenewTime"]).or_else(|| timestamp(&s["subscribeEndTime"])));
    Ok(snapshot(
        provider, slot, revision, now, plan, expires, meters,
    ))
}

fn parse_grok(
    slot: &str,
    revision: u64,
    now: i64,
    data: &Value,
) -> Result<SubscriptionQuotaSnapshot> {
    let config = &data["config"];
    let mut meters = Vec::new();
    if let Some(used) = number(&config["creditUsagePercent"]) {
        let duration = match config["currentPeriod"]["type"].as_str() {
            Some("USAGE_PERIOD_TYPE_DAILY") => Some(86400),
            Some("USAGE_PERIOD_TYPE_WEEKLY") => Some(604800),
            Some("USAGE_PERIOD_TYPE_MONTHLY") => Some(2592000),
            _ => None,
        };
        meters.push(SubscriptionQuotaMeter {
            id: "period".into(),
            used_percent: Some(used.min(100.0)),
            duration_seconds: duration,
            resets_at: timestamp(&config["currentPeriod"]["end"])
                .or_else(|| timestamp(&config["billingPeriodEnd"])),
            ..Default::default()
        });
    }
    if let Some(cap) = number(&config["onDemandCap"]["val"]).filter(|n| *n > 0.0) {
        if let Some(used) = number(&config["onDemandUsed"]["val"]) {
            let mut meter = amounts("on-demand".into(), Some(used), Some(cap), None);
            meter.display_name = Some("On-demand".into());
            meter.secondary = true;
            meter.resets_at = timestamp(&config["billingPeriodEnd"])
                .or_else(|| timestamp(&config["currentPeriod"]["end"]));
            meters.push(meter);
        }
    }
    if meters.is_empty() {
        return Err(anyhow!("Grok returned no supported allowance windows"));
    }
    let mut observation = quota::empty_snapshot(SubscriptionProvider::Grok, slot, revision);
    observation.state = SubscriptionQuotaState::Known;
    observation.observed_at = Some(now);
    observation.valid_until = Some(
        meters
            .iter()
            .filter_map(|meter| meter.resets_at)
            .filter(|reset| *reset > now)
            .fold(now + quota::CACHE_SECONDS, i64::min),
    );
    observation.plan = Some("Grok".into());
    // Grok reports display-only account usage, without model eligibility facts.
    observation.display = Some(SubscriptionQuotaDisplay {
        version: 1,
        expires_at: None,
        meters,
    });
    Ok(observation)
}

fn signed(
    mut builder: reqwest::RequestBuilder,
    credential: &super::ResolvedCredential,
    bearer: bool,
) -> Result<reqwest::RequestBuilder> {
    let mut headers = reqwest::header::HeaderMap::new();
    if bearer {
        headers.insert(
            "authorization",
            format!("Bearer {}", credential.api_key).parse()?,
        );
    }
    for (name, value) in &credential.extra_headers {
        // Billing endpoints below name their own Authorization spelling. In
        // particular ZCode business/monitor APIs take the bare project key.
        if !name.eq_ignore_ascii_case("authorization") && !name.eq_ignore_ascii_case("x-api-key") {
            headers.insert(
                reqwest::header::HeaderName::from_bytes(name.as_bytes())?,
                value.parse()?,
            );
        }
    }
    if !bearer {
        headers.insert("authorization", credential.api_key.parse()?);
    }
    builder = builder.headers(headers);
    Ok(builder
        .header("Accept", "application/json")
        .timeout(Duration::from_secs(20)))
}

async fn fetch(
    provider: SubscriptionProvider,
    slot: &str,
    options: &SubscriptionHttpOptions,
) -> Result<SubscriptionQuotaSnapshot> {
    let credential = accounts::resolve_account_with_options(provider, slot, options)
        .await
        .map_err(|_| {
            anyhow!("Subscription authorization is unavailable; refresh the account status")
        })?;
    let entry = store::load_entry_with_revision(slot).await?;
    let Some(super::StoredCredential::Oauth {
        access, metadata, ..
    }) = entry.credential
    else {
        return Err(anyhow!("Subscription account is unavailable"));
    };
    if access != credential.api_key {
        return Err(anyhow!(
            "Subscription authorization changed; refresh quota again"
        ));
    }
    let metadata = metadata.unwrap_or_else(|| json!({}));
    let client = super::build_http_client_with_redirect_policy(
        options,
        "subscription quota",
        reqwest::redirect::Policy::none(),
    )?;
    let now = chrono::Utc::now().timestamp();
    let team = !browser_poll::text(&metadata, "organization").is_empty();
    let root = billing_root(provider, team)?;
    let (data, supplementary) =
        query_billing(provider, &credential, &metadata, &client, root).await?;
    match provider {
        SubscriptionProvider::Grok => parse_grok(slot, entry.revision, now, &data),
        SubscriptionProvider::Workbuddy | SubscriptionProvider::WorkbuddyAi => parse_workbuddy(
            provider,
            slot,
            entry.revision,
            now,
            &data,
            supplementary.as_ref(),
        ),
        SubscriptionProvider::Zcode | SubscriptionProvider::ZcodeCn => parse_zcode(
            provider,
            slot,
            entry.revision,
            now,
            &data,
            &metadata,
            supplementary.as_ref(),
        ),
        _ => Err(anyhow!(
            "Quota query is unsupported for this subscription provider"
        )),
    }
}

fn billing_root(provider: SubscriptionProvider, team: bool) -> Result<&'static str> {
    Ok(match provider {
        SubscriptionProvider::Grok => "https://cli-chat-proxy.grok.com/v1",
        SubscriptionProvider::Workbuddy | SubscriptionProvider::WorkbuddyAi => {
            super::workbuddy::root(provider)
        }
        SubscriptionProvider::ZcodeCn if team => "https://bigmodel.cn",
        SubscriptionProvider::ZcodeCn => "https://open.bigmodel.cn",
        SubscriptionProvider::Zcode => "https://api.z.ai",
        _ => {
            return Err(anyhow!(
                "Quota query is unsupported for this subscription provider"
            ))
        }
    })
}

// The caller pins the production origin; tests substitute an isolated HTTP fixture.
async fn query_billing(
    provider: SubscriptionProvider,
    credential: &super::ResolvedCredential,
    metadata: &Value,
    client: &reqwest::Client,
    root: &str,
) -> Result<(Value, Option<Value>)> {
    match provider {
        SubscriptionProvider::Grok => {
            let response = signed(
                client.get(format!("{root}/billing?format=credits")),
                credential,
                true,
            )?
            .send()
            .await?;
            if !response.status().is_success() {
                return Err(anyhow!("Grok billing request failed"));
            }
            Ok((response.json().await?, None))
        }

        SubscriptionProvider::Workbuddy | SubscriptionProvider::WorkbuddyAi => {
            let sum = browser_poll::data(
                signed(
                    client
                        .post(format!("{root}/billing/meter/get-user-resource-summary"))
                        .json(&json!({})),
                    credential,
                    true,
                )?,
                false,
            )
            .await?;
            let enterprise = if !browser_poll::text(metadata, "enterprise_id").is_empty() {
                Some(
                    browser_poll::data(
                        signed(
                            client
                                .post(format!("{root}/billing/meter/get-enterprise-user-usage"))
                                .json(&json!({})),
                            credential,
                            true,
                        )?,
                        false,
                    )
                    .await?,
                )
            } else {
                None
            };
            Ok((sum, enterprise))
        }
        SubscriptionProvider::Zcode | SubscriptionProvider::ZcodeCn => {
            let team = !browser_poll::text(metadata, "organization").is_empty();
            let suffix = if team { "?type=2" } else { "" };
            let data = browser_poll::data(
                signed(
                    client.get(format!("{root}/api/monitor/usage/quota/limit{suffix}")),
                    credential,
                    false,
                )?
                .header("User-Agent", "ZCode/3.14.3"),
                true,
            )
            .await?;
            let subscriptions = if team {
                None
            } else {
                // Plan-term lookup is supplementary. Its failure cannot erase
                // a successfully observed allowance or imply a missing plan.
                browser_poll::data(
                    signed(
                        client.get(format!("{root}/api/biz/subscription/list")),
                        credential,
                        false,
                    )?,
                    true,
                )
                .await
                .ok()
            };
            Ok((data, subscriptions))
        }
        _ => Err(anyhow!(
            "Quota query is unsupported for this subscription provider"
        )),
    }
}

pub(super) async fn read(
    provider: SubscriptionProvider,
    slot: &str,
    force: bool,
    options: &SubscriptionHttpOptions,
) -> Result<SubscriptionQuotaSnapshot> {
    let _lease = store::acquire_provider_refresh_lease(&format!("{slot}-quota")).await?;
    let (revision, cached) = store::load_account_quota(slot).await?;
    let now = chrono::Utc::now().timestamp();
    if !force {
        if let Some(cached) = cached.as_ref().filter(|q| {
            q.provider == provider.key()
                && q.credential_revision == revision
                && q.state == SubscriptionQuotaState::Known
                && q.valid_until.is_some_and(|end| end > now)
        }) {
            return Ok(cached.clone());
        }
    }
    let result = fetch(provider, slot, options).await;
    finish(provider, slot, revision, cached, result).await
}

async fn finish(
    provider: SubscriptionProvider,
    slot: &str,
    revision: u64,
    cached: Option<SubscriptionQuotaSnapshot>,
    result: Result<SubscriptionQuotaSnapshot>,
) -> Result<SubscriptionQuotaSnapshot> {
    let mut snapshot = match result {
        Ok(snapshot) => snapshot,
        Err(_) => {
            let mut snapshot =
                cached.unwrap_or_else(|| quota::empty_snapshot(provider, slot, revision));
            snapshot.state = SubscriptionQuotaState::QueryFailed;
            snapshot.error=Some("Could not read the provider's quota. Check authorization and network access, then retry.".into());
            snapshot
        }
    };
    if !store::save_account_quota(&snapshot).await? {
        snapshot = quota::empty_snapshot(provider, slot, store::credential_revision(slot).await?);
        snapshot.state = SubscriptionQuotaState::Stale;
        snapshot.error =
            Some("Account authorization changed while reading quota; refresh again".into());
    }
    Ok(snapshot)
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn grok_period_percent_and_on_demand_are_display_only() {
        let q = parse_grok("grok:fixture", 7, 1000, &json!({"config":{"creditUsagePercent":"42.5","currentPeriod":{"type":"USAGE_PERIOD_TYPE_WEEKLY","end":"2026-11-01T00:00:00Z"},"onDemandCap":{"val":100},"onDemandUsed":{"val":20}}})).unwrap();
        let m = &q.display.unwrap().meters;
        assert_eq!(m[0].duration_seconds, Some(604800));
        assert_eq!(m[0].used_percent, Some(42.5));
        assert_eq!(m[1].remaining, Some(80.0));
        assert!(m[1].secondary);
        assert!(q.allowed.is_none() && q.windows.is_empty());
        assert!(parse_grok("grok", 1, 1000, &json!({"config":{}})).is_err());
        assert!(parse_grok(
            "grok",
            1,
            1000,
            &json!({"config":{"creditUsagePercent":-1}})
        )
        .is_err());
    }
    #[tokio::test]
    async fn grok_billing_uses_selected_account_token_and_cli_headers() {
        use axum::{extract::Request, routing::any, Json, Router};
        openbitfun_services_core::tls_provider::ensure_ring_crypto_provider();
        let router = Router::new().fallback(any(|request: Request| async move {
            assert_eq!(request.uri(), "/billing?format=credits");
            assert_eq!(
                request.headers()["authorization"],
                "Bearer selected-account"
            );
            assert_eq!(request.headers()["x-fixture-cli"], "cli-signature");
            Json(json!({"config":{"creditUsagePercent":12}}))
        }));
        let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
        let root = format!("http://{}", listener.local_addr().unwrap());
        let server = tokio::spawn(async move { axum::serve(listener, router).await.unwrap() });
        let credential = super::super::ResolvedCredential {
            api_key: "selected-account".into(),
            extra_headers: [("x-fixture-cli".into(), "cli-signature".into())].into(),
            base_url: None,
            request_url: None,
            format: None,
            expires_at: None,
        };
        let (data, _) = query_billing(
            SubscriptionProvider::Grok,
            &credential,
            &json!({}),
            &reqwest::Client::new(),
            &root,
        )
        .await
        .unwrap();
        assert_eq!(data["config"]["creditUsagePercent"], 12);
        server.abort();
    }
    #[test]
    fn workbuddy_accepts_decimal_strings_and_keeps_missing_capacities_unknown() {
        let q=parse_workbuddy(SubscriptionProvider::Workbuddy,"workbuddy",1,1000,&json!({"IsPaidUser":true,"Packages":[{"CycleTotalCapacity":"1000","CycleUsedCapacity":"123.5","CycleRemainCapacity":"876.5"}]}),None).unwrap();
        let m = &q.display.unwrap().meters[0];
        assert_eq!(m.remaining, Some(876.5));
        assert_eq!(m.used_percent, Some(12.35));
        let q = parse_workbuddy(
            SubscriptionProvider::Workbuddy,
            "workbuddy",
            1,
            1000,
            &json!({"Packages":[{"CycleTotalCapacity":100},{}]}),
            None,
        )
        .unwrap();
        assert_eq!(q.state, SubscriptionQuotaState::Unknown);
        assert!(q.windows.is_empty());
    }
    #[test]
    fn zcode_distinguishes_unlimited_unknown_and_mcp_from_coding_limits() {
        let q=parse_zcode(SubscriptionProvider::ZcodeCn,"zcode_cn",1,1000,&json!({"limits":[{"type":"TOKENS_LIMIT","unit":3,"usage":100,"remaining":20,"nextResetTime":2000000},{"type":"TIME_LIMIT","unit":5,"percentage":50},{"type":"TOKENS_LIMIT","unit":6,"usage":0,"percentage":100},{"type":"TOKENS_LIMIT","unit":6}]}),&json!({}),None).unwrap();
        let ms = &q.display.as_ref().unwrap().meters;
        assert_eq!(ms[0].used_percent, Some(80.0));
        assert_eq!(ms[0].duration_seconds, Some(18000));
        assert!(ms[1].secondary);
        assert!(ms[2].unlimited);
        assert_eq!(ms[3].used_percent, None);
        let conflicting = parse_zcode(
            SubscriptionProvider::Zcode,
            "zcode",
            1,
            1000,
            &json!({"limits":[{"usage":100,"remaining":20,"currentValue":99,"percentage":99}]}),
            &json!({}),
            None,
        )
        .unwrap();
        assert_eq!(
            conflicting.display.unwrap().meters[0].used_percent,
            Some(80.0)
        );
        assert!(q.allowed.is_none());
        assert!(q.details.is_none());
        assert!(matches!(
            quota::model_quota_observation(&q, "any-model", 1000).eligibility,
            openbitfun_core_types::subscription::ModelQuotaEligibility::Unknown
        ));
    }
    #[test]
    fn enterprise_meter_preserves_the_vendor_cycle_and_is_not_a_personal_wallet() {
        let q=parse_workbuddy(SubscriptionProvider::Workbuddy,"workbuddy",1,1000,&json!({"Packages":[]}),Some(&json!({"limitNum":"800","credit":"200","cycleStartTime":"2026-10-01 00:00:00","cycleResetTime":"2026-11-01 00:00:00"}))).unwrap();
        assert_eq!(q.plan.as_deref(), Some("Enterprise"));
        let m = &q.display.unwrap().meters[0];
        assert_eq!(m.remaining, Some(600.0));
        assert_eq!(m.used_percent, Some(25.0));
        assert_eq!(m.resets_at, Some(1793462400));
    }
    #[tokio::test]
    async fn billing_transport_preserves_vendor_auth_account_headers_and_team_queries() {
        use axum::{extract::Request, routing::any, Json, Router};
        use std::sync::{Arc, Mutex};
        openbitfun_services_core::tls_provider::ensure_ring_crypto_provider();
        for provider in [
            SubscriptionProvider::Workbuddy,
            SubscriptionProvider::WorkbuddyAi,
            SubscriptionProvider::Zcode,
            SubscriptionProvider::ZcodeCn,
        ] {
            for team in [false, true] {
                let workbuddy = matches!(
                    provider,
                    SubscriptionProvider::Workbuddy | SubscriptionProvider::WorkbuddyAi
                );
                let requests = Arc::new(Mutex::new(Vec::new()));
                let received = requests.clone();
                let app = Router::new().fallback(any(move |request: Request| {
                    let received = received.clone();
                    async move {
                        let headers = request.headers();
                        assert_eq!(headers["authorization"], if workbuddy { "Bearer synthetic-key" } else { "synthetic-key" });
                        assert!(!headers.contains_key("x-api-key"));
                        if workbuddy {
                            assert_eq!(headers["x-user-id"], "fixture-user");
                            assert_eq!(headers["x-domain"], "fixture-domain");
                            if team {
                                assert_eq!(headers["x-enterprise-id"], "fixture-team");
                                assert_eq!(headers["x-tenant-id"], "fixture-team");
                            }
                            assert_eq!(request.method(), reqwest::Method::POST);
                        } else {
                            assert_eq!(request.method(), reqwest::Method::GET);
                            if team {
                                assert_eq!(headers["bigmodel-organization"], "fixture-team");
                                assert_eq!(headers["bigmodel-project"], "fixture-project");
                            }
                        }
                        let path = request.uri().to_string();
                        received.lock().unwrap().push(path.clone());
                        let data = match request.uri().path() {
                            "/billing/meter/get-user-resource-summary" => json!({"IsPaidUser":true,"Packages":[{"CycleTotalCapacity":"100","CycleRemainCapacity":"75"}]}),
                            "/billing/meter/get-enterprise-user-usage" => json!({"limitNum":400,"credit":100}),
                            "/api/monitor/usage/quota/limit" => {
                                assert_eq!(request.uri().query(), if team { Some("type=2") } else { None });
                                json!({"limits":[{"type":"TOKENS_LIMIT","usage":100,"remaining":75}]})
                            },
                            // Optional plan details may fail independently of allowance.
                            "/api/biz/subscription/list" => return Json(json!({"code":500,"data":null})),
                            _ => panic!("Unexpected billing fixture path"),
                        };
                        Json(json!({"code":if workbuddy {0} else {200},"data":data}))
                    }
                }));
                let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
                let root = format!("http://{}", listener.local_addr().unwrap());
                let server = tokio::spawn(async move {
                    axum::serve(listener, app).await.unwrap();
                });
                let mut headers = std::collections::HashMap::from([
                    ("Authorization".into(), "must-be-overridden".into()),
                    ("x-api-key".into(), "must-be-removed".into()),
                ]);
                if workbuddy {
                    headers.insert("X-User-Id".into(), "fixture-user".into());
                    headers.insert("X-Domain".into(), "fixture-domain".into());
                    if team {
                        headers.insert("X-Enterprise-Id".into(), "fixture-team".into());
                        headers.insert("X-Tenant-Id".into(), "fixture-team".into());
                    }
                } else if team {
                    headers.insert("bigmodel-organization".into(), "fixture-team".into());
                    headers.insert("bigmodel-project".into(), "fixture-project".into());
                }
                let credential = super::super::ResolvedCredential {
                    api_key: "synthetic-key".into(),
                    base_url: None,
                    request_url: None,
                    format: None,
                    extra_headers: headers,
                    expires_at: None,
                };
                let metadata = if team {
                    json!({"enterprise_id":"fixture-team","organization":"fixture-team"})
                } else {
                    json!({})
                };
                let client = reqwest::Client::builder().no_proxy().build().unwrap();
                let (data, supplementary) =
                    query_billing(provider, &credential, &metadata, &client, &root)
                        .await
                        .unwrap();
                let quota = if workbuddy {
                    parse_workbuddy(
                        provider,
                        provider.key(),
                        1,
                        1000,
                        &data,
                        supplementary.as_ref(),
                    )
                    .unwrap()
                } else {
                    assert!(supplementary.is_none());
                    parse_zcode(provider, provider.key(), 1, 1000, &data, &metadata, None).unwrap()
                };
                assert_eq!(quota.state, SubscriptionQuotaState::Known);
                let paths = requests.lock().unwrap();
                assert_eq!(
                    paths.len(),
                    if workbuddy && !team || !workbuddy && team {
                        1
                    } else {
                        2
                    }
                );
                server.abort();
            }
        }
        assert_eq!(
            billing_root(SubscriptionProvider::Workbuddy, false).unwrap(),
            "https://copilot.tencent.com"
        );
        assert_eq!(
            billing_root(SubscriptionProvider::WorkbuddyAi, true).unwrap(),
            "https://www.workbuddy.ai"
        );
        assert_eq!(
            billing_root(SubscriptionProvider::Zcode, false).unwrap(),
            "https://api.z.ai"
        );
        assert_eq!(
            billing_root(SubscriptionProvider::ZcodeCn, false).unwrap(),
            "https://open.bigmodel.cn"
        );
        assert_eq!(
            billing_root(SubscriptionProvider::ZcodeCn, true).unwrap(),
            "https://bigmodel.cn"
        );
    }

    #[tokio::test]
    async fn failed_refresh_retains_observation_and_logout_wins_a_delayed_response() {
        let _guard = super::super::tests::test_lock().lock().await;
        let dir = std::env::temp_dir().join(format!("quota-test-{}", uuid::Uuid::new_v4()));
        store::set_store_path_for_test(dir.join("auth.json"));
        let slot = "workbuddy";
        store::upsert(
            slot,
            super::super::StoredCredential::Oauth {
                access: "synthetic".into(),
                refresh: "synthetic".into(),
                expires: i64::MAX,
                account_id: Some("fixture".into()),
                metadata: None,
            },
        )
        .await
        .unwrap();
        let revision = store::credential_revision(slot).await.unwrap();
        let old = snapshot(
            SubscriptionProvider::Workbuddy,
            slot,
            revision,
            1000,
            None,
            None,
            vec![amounts("credits".into(), Some(20.0), Some(100.0), None)],
        );
        let failed = finish(
            SubscriptionProvider::Workbuddy,
            slot,
            revision,
            Some(old.clone()),
            Err(anyhow!("synthetic private error")),
        )
        .await
        .unwrap();
        assert_eq!(failed.observed_at, Some(1000));
        assert_eq!(failed.display, old.display);
        assert_eq!(failed.state, SubscriptionQuotaState::QueryFailed);
        assert!(!failed.error.unwrap().contains("private"));
        super::super::logout(SubscriptionProvider::Workbuddy)
            .await
            .unwrap();
        let late = finish(
            SubscriptionProvider::Workbuddy,
            slot,
            revision,
            None,
            Ok(old),
        )
        .await
        .unwrap();
        assert_eq!(late.state, SubscriptionQuotaState::Stale);
        assert!(late.display.is_none());
        let _ = std::fs::remove_dir_all(dir);
    }
}
