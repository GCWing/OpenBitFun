//! Read-only allowances for saved, official API-key connections. Never accepts
//! a caller-provided billing URL or uses a UI draft's credentials.
use super::{quota, SubscriptionHttpOptions};
use anyhow::{anyhow, Result};
use openbitfun_core_types::subscription::{
    SubscriptionQuotaDisplay, SubscriptionQuotaMeter, SubscriptionQuotaSnapshot,
    SubscriptionQuotaState,
};
use serde::{Deserialize, Serialize};
use serde_json::Value;

#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum PlanQuotaKind {
    Minimax,
    KimiCode,
    Stepfun,
}

impl PlanQuotaKind {
    pub fn key(self) -> &'static str {
        match self {
            Self::Minimax => "minimax",
            Self::KimiCode => "kimi_code",
            Self::Stepfun => "stepfun",
        }
    }
}

pub fn kind(base: &str) -> Option<PlanQuotaKind> {
    let url = reqwest::Url::parse(base).ok()?;
    if url.scheme() != "https"
        || url.port().is_some()
        || !url.username().is_empty()
        || url.password().is_some()
        || url.query().is_some()
        || url.fragment().is_some()
    {
        return None;
    }
    let path = url.path().trim_end_matches('/');
    match url.host_str()? {
        "api.minimaxi.com" | "api.minimax.io" if matches!(path, "" | "/v1" | "/anthropic") => {
            Some(PlanQuotaKind::Minimax)
        }
        "api.kimi.com" | "api.kimi.ai" if matches!(path, "/coding" | "/coding/v1") => {
            Some(PlanQuotaKind::KimiCode)
        }
        "api.stepfun.com" | "api.stepfun.ai" if matches!(path, "" | "/v1" | "/step_plan/v1") => {
            Some(PlanQuotaKind::Stepfun)
        }
        _ => None,
    }
}

pub(super) fn number(value: &Value) -> Option<f64> {
    value
        .as_f64()
        .or_else(|| value.as_str()?.trim().parse().ok())
        .filter(|n| n.is_finite() && *n >= 0.0)
}

pub(super) fn timestamp(value: &Value) -> Option<i64> {
    let stamp = number(value)
        .filter(|n| *n > 0.0)
        .map(|n| {
            if n >= 1e12 {
                (n / 1000.0) as i64
            } else {
                n as i64
            }
        })
        .or_else(|| {
            chrono::DateTime::parse_from_rfc3339(value.as_str()?)
                .ok()
                .map(|d| d.timestamp())
        })?;
    chrono::DateTime::from_timestamp(stamp, 0).map(|_| stamp)
}

pub(super) fn observed(
    provider: &str,
    binding: &str,
    revision: u64,
    now: i64,
    plan: Option<String>,
    expires_at: Option<i64>,
    meters: Vec<SubscriptionQuotaMeter>,
) -> Result<SubscriptionQuotaSnapshot> {
    if meters.is_empty() {
        return Err(anyhow!("Provider returned no supported allowance windows"));
    }
    let mut snapshot = quota::empty_provider_snapshot(provider, binding, revision);
    snapshot.state = SubscriptionQuotaState::Known;
    snapshot.plan = plan;
    snapshot.observed_at = Some(now);
    snapshot.valid_until = Some(
        meters
            .iter()
            .filter_map(|m| m.resets_at)
            .filter(|at| *at > now)
            .fold(now + quota::CACHE_SECONDS, i64::min),
    );
    // Display-only observations deliberately carry no routing windows/details.
    snapshot.display = Some(SubscriptionQuotaDisplay {
        version: 1,
        expires_at,
        meters,
    });
    Ok(snapshot)
}

pub fn unavailable(provider: &str, binding: &str, reason: &str) -> SubscriptionQuotaSnapshot {
    let mut snapshot = quota::empty_provider_snapshot(provider, binding, 0);
    snapshot.state = SubscriptionQuotaState::Unsupported;
    snapshot.error = Some(reason.into());
    snapshot
}

pub(super) fn failed(provider: &str, binding: &str, reason: &str) -> SubscriptionQuotaSnapshot {
    let mut snapshot = quota::empty_provider_snapshot(provider, binding, 0);
    snapshot.state = SubscriptionQuotaState::QueryFailed;
    snapshot.error = Some(reason.into());
    snapshot
}

pub(super) fn parse_minimax(
    binding: &str,
    data: &Value,
    now: i64,
) -> Result<SubscriptionQuotaSnapshot> {
    if data
        .pointer("/base_resp/status_code")
        .and_then(Value::as_i64)
        != Some(0)
    {
        return Err(anyhow!("MiniMax rejected the plan query"));
    }
    let mut meters = vec![];
    for bucket in data["model_remains"].as_array().into_iter().flatten() {
        let Some(name) = bucket["model_name"]
            .as_str()
            .filter(|s| !s.trim().is_empty())
        else {
            continue;
        };
        if bucket["current_interval_status"] == 3
            && bucket["current_weekly_status"] == 3
            && number(&bucket["current_interval_total_count"]) == Some(0.0)
            && number(&bucket["current_weekly_total_count"]) == Some(0.0)
        {
            continue;
        }
        for (prefix, window, weekly) in [
            ("current_interval", "rolling", false),
            ("current_weekly", "weekly", true),
        ] {
            let status = bucket[format!("{prefix}_status")].as_i64();
            let left = number(&bucket[format!("{prefix}_remaining_percent")]).map(|n| n.min(100.0));
            if left.is_none() && !matches!(status, Some(2 | 3)) {
                continue;
            }
            let end = timestamp(
                &bucket[if weekly {
                    "weekly_end_time"
                } else {
                    "end_time"
                }],
            );
            let start = timestamp(
                &bucket[if weekly {
                    "weekly_start_time"
                } else {
                    "start_time"
                }],
            );
            let unlimited = status == Some(3);
            let used_percent = if unlimited {
                None
            } else if status == Some(2) {
                Some(100.0)
            } else {
                left.map(|n| 100.0 - n)
            };
            let mut meter = SubscriptionQuotaMeter {
                id: format!("{name}-{window}"),
                display_name: (!name.eq_ignore_ascii_case("general")).then(|| name.into()),
                secondary: !name.eq_ignore_ascii_case("general"),
                unlimited,
                used_percent,
                resets_at: end,
                duration_seconds: start
                    .zip(end)
                    .filter(|(a, b)| b > a)
                    .map(|(a, b)| (b - a) as u64)
                    .or(weekly.then_some(604800)),
                ..Default::default()
            };
            if let Some((count, total)) = number(&bucket[format!("{prefix}_usage_count")])
                .zip(number(&bucket[format!("{prefix}_total_count")]))
                .filter(|(c, t)| *t > 0.0 && c <= t)
            {
                if status == Some(2) {
                    meter.used = Some(total);
                } else if let Some(left) = left {
                    let as_used = ((total - count) / total * 100.0 - left).abs();
                    let as_left = (count / total * 100.0 - left).abs();
                    if as_used.min(as_left) <= 1.0 {
                        meter.used = Some(if as_used < as_left {
                            count
                        } else {
                            total - count
                        });
                    }
                }
                if let Some(used) = meter.used {
                    meter.limit = Some(total);
                    meter.remaining = Some((total - used).max(0.0));
                }
            }
            meters.push(meter);
        }
    }
    observed(
        "minimax",
        binding,
        0,
        now,
        Some("MiniMax Token Plan".into()),
        None,
        meters,
    )
}

pub(super) fn parse_kimi(
    binding: &str,
    data: &Value,
    now: i64,
) -> Result<SubscriptionQuotaSnapshot> {
    let mut meters = vec![];
    let mut add = |id: String, row: &Value, duration: Option<u64>| {
        let Some(limit) = number(&row["limit"]).filter(|n| *n > 0.0) else {
            return;
        };
        let used = number(&row["used"]).or_else(|| {
            number(&row["remaining"])
                .filter(|n| *n <= limit)
                .map(|n| limit - n)
        });
        let Some(used) = used else { return };
        let resets_at = ["resetTime", "resetAt", "reset_at", "reset_time"]
            .iter()
            .find_map(|key| timestamp(&row[*key]));
        meters.push(SubscriptionQuotaMeter {
            id,
            used: Some(used),
            limit: Some(limit),
            remaining: Some((limit - used).max(0.0)),
            used_percent: Some((used / limit * 100.0).min(100.0)),
            duration_seconds: duration,
            resets_at,
            ..Default::default()
        });
    };
    for (index, item) in data["limits"].as_array().into_iter().flatten().enumerate() {
        let duration = number(&item["window"]["duration"]);
        let unit = item["window"]["timeUnit"].as_str().unwrap_or("");
        let multiplier = if unit.contains("MINUTE") {
            60.0
        } else if unit.contains("HOUR") {
            3600.0
        } else if unit.contains("DAY") {
            86400.0
        } else if unit.contains("SECOND") {
            1.0
        } else {
            0.0
        };
        let seconds = duration
            .map(|n| n * multiplier)
            .filter(|n| *n > 0.0 && *n <= u64::MAX as f64)
            .map(|n| n as u64);
        add(
            format!("window-{index}"),
            item.get("detail")
                .filter(|v| v.is_object())
                .unwrap_or(&item["window"]),
            seconds,
        );
    }
    add("weekly".into(), &data["usage"], Some(604800));
    observed(
        "kimi_code",
        binding,
        0,
        now,
        Some("Kimi Code".into()),
        None,
        meters,
    )
}

pub async fn read(
    base: &str,
    key: &str,
    binding: &str,
    options: &SubscriptionHttpOptions,
) -> Result<SubscriptionQuotaSnapshot> {
    let provider = kind(base).ok_or_else(|| anyhow!("Unsupported model quota origin"))?;
    if provider == PlanQuotaKind::Stepfun {
        return super::stepfun_quota::read(base, binding, options).await;
    }
    let host = reqwest::Url::parse(base)?
        .host_str()
        .unwrap_or("")
        .to_owned();
    let endpoint = match (provider, host.as_str()) {
        (PlanQuotaKind::Minimax, "api.minimaxi.com") => {
            "https://www.minimax.cn/v1/token_plan/remains".into()
        }
        (PlanQuotaKind::Minimax, _) => "https://www.minimax.io/v1/token_plan/remains".into(),
        (PlanQuotaKind::KimiCode, _) => format!("https://{host}/coding/v1/usages"),
        _ => unreachable!(),
    };
    let client = super::build_http_client_with_redirect_policy(
        options,
        "model allowance",
        reqwest::redirect::Policy::none(),
    )?;
    Ok(
        match query(&client, provider, &endpoint, key, binding).await {
            Ok(snapshot) => snapshot,
            Err(_) => failed(provider.key(), binding, "plan_quota_query_failed"),
        },
    )
}

async fn query(
    client: &reqwest::Client,
    provider: PlanQuotaKind,
    endpoint: &str,
    key: &str,
    binding: &str,
) -> Result<SubscriptionQuotaSnapshot> {
    let response = client
        .get(endpoint)
        .bearer_auth(key)
        .header("Accept", "application/json")
        .timeout(std::time::Duration::from_secs(20))
        .send()
        .await?;
    if !response.status().is_success() {
        return Ok(failed(
            provider.key(),
            binding,
            if matches!(response.status().as_u16(), 401 | 403) {
                "plan_quota_key_rejected"
            } else {
                "plan_quota_query_failed"
            },
        ));
    }
    let data: Value = response.json().await?;
    let now = chrono::Utc::now().timestamp();
    match provider {
        PlanQuotaKind::Minimax => parse_minimax(binding, &data, now),
        PlanQuotaKind::KimiCode => parse_kimi(binding, &data, now),
        _ => Err(anyhow!("Unsupported keyed plan")),
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    #[test]
    fn only_official_plan_origins_are_accepted() {
        for base in [
            "https://api.minimaxi.com/anthropic",
            "https://api.minimax.io/v1/",
            "https://api.kimi.com/coding",
            "https://api.kimi.ai/coding/v1",
            "https://api.stepfun.com/v1",
        ] {
            assert!(kind(base).is_some(), "{base}");
        }
        for base in [
            "http://api.minimax.io/v1",
            "https://api.minimax.io.evil.test/v1",
            "https://user@api.kimi.com/coding",
            "https://api.kimi.com/coding?key=x",
            "https://api.moonshot.cn/v1",
            "https://api.kimi.com/v1",
            "https://api.stepfun.com:8443/v1",
        ] {
            assert!(kind(base).is_none(), "{base}");
        }
    }

    #[test]
    fn minimax_reconciles_counts_status_and_absent_buckets() {
        let data = json!({"base_resp":{"status_code":0},"model_remains":[
            {"model_name":"general","current_interval_status":1,"current_interval_remaining_percent":75,"current_interval_total_count":100,"current_interval_usage_count":25,"start_time":2000,"end_time":20000,
             "current_weekly_status":2,"current_weekly_remaining_percent":80,"current_weekly_total_count":100,"current_weekly_usage_count":20,"weekly_end_time":700000},
            {"model_name":"video","current_interval_status":3,"current_weekly_status":3,"current_interval_total_count":0,"current_weekly_total_count":0},
            {"model_name":"image","current_interval_status":1,"current_interval_remaining_percent":60,"current_interval_total_count":100,"current_interval_usage_count":60}
        ]});
        let q = parse_minimax("model:a", &data, 1000).unwrap();
        let meters = &q.display.unwrap().meters;
        assert_eq!(meters.len(), 3);
        assert_eq!(meters[0].used, Some(25.0));
        assert_eq!(meters[0].duration_seconds, Some(18000));
        assert_eq!(meters[1].used_percent, Some(100.0));
        assert_eq!(meters[1].remaining, Some(0.0));
        assert_eq!(meters[2].used, Some(40.0));
        assert!(meters[2].secondary);
        assert!(q.windows.is_empty() && q.details.is_none());
        assert!(parse_minimax(
            "model:a",
            &json!({"base_resp":{"status_code":1004},"model_remains":[]}),
            1000
        )
        .is_err());
        assert!(parse_minimax("model:a", &json!({"model_remains":[]}), 1000).is_err());
    }

    #[test]
    fn kimi_strings_derive_remaining_without_inventing_missing_usage() {
        let q = parse_kimi("model:k", &json!({"limits":[{"window":{"duration":300,"timeUnit":"TIME_UNIT_MINUTE"},"detail":{"limit":"100","remaining":"75","resetTime":"2026-11-01T00:00:00Z"}}],"usage":{"limit":"1000","used":"0","resetTime":"1793491200000"}}), 1000).unwrap();
        let m = &q.display.unwrap().meters;
        assert_eq!(m.len(), 2);
        assert_eq!(m[0].used, Some(25.0));
        assert_eq!(m[0].duration_seconds, Some(18000));
        assert_eq!(m[1].used_percent, Some(0.0));
        assert_eq!(m[1].resets_at, Some(1793491200));
        assert!(parse_kimi("model:k", &json!({"usage":{"limit":100}}), 1000).is_err());
        assert!(parse_kimi("model:k", &json!({"usage":{"limit":100,"used":-1}}), 1000).is_err());
    }

    #[tokio::test]
    async fn keyed_transport_uses_bearer_and_rejects_redirect_or_error_payloads() {
        use axum::{extract::Request, routing::any, Json, Router};
        openbitfun_services_core::tls_provider::ensure_ring_crypto_provider();
        let router = Router::new()
            .route(
                "/usages",
                any(|request: Request| async move {
                    assert_eq!(request.method(), "GET");
                    assert_eq!(
                        request.headers()["authorization"],
                        "Bearer synthetic-plan-key"
                    );
                    Json(json!({"usage":{"limit":"100","used":"9"}}))
                }),
            )
            .route(
                "/redirect",
                any(|| async { (axum::http::StatusCode::FOUND, [("location", "/usages")]) }),
            )
            .route(
                "/rejected",
                any(|| async {
                    (
                        axum::http::StatusCode::UNAUTHORIZED,
                        "private upstream response",
                    )
                }),
            );
        let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
        let root = format!("http://{}", listener.local_addr().unwrap());
        let server = tokio::spawn(async move { axum::serve(listener, router).await.unwrap() });
        let client = reqwest::Client::builder()
            .redirect(reqwest::redirect::Policy::none())
            .build()
            .unwrap();
        let q = query(
            &client,
            PlanQuotaKind::KimiCode,
            &format!("{root}/usages"),
            "synthetic-plan-key",
            "model:k",
        )
        .await
        .unwrap();
        assert_eq!(q.provider, "kimi_code");
        assert_eq!(q.account_id, "model:k");
        for path in ["redirect", "rejected"] {
            let q = query(
                &client,
                PlanQuotaKind::KimiCode,
                &format!("{root}/{path}"),
                "synthetic-plan-key",
                "model:k",
            )
            .await
            .unwrap();
            assert_eq!(q.state, SubscriptionQuotaState::QueryFailed);
            assert!(!q.error.unwrap().contains("private"));
            assert!(q.display.is_none());
        }
        server.abort();
    }
}
