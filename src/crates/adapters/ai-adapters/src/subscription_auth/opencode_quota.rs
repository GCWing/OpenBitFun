//! Read-only OpenCode Go API-key allowance. Console OAuth and public Zen do not
//! share this authentication boundary. No keys or observations are persisted.
use super::{quota, SubscriptionHttpOptions, SubscriptionProvider};
use anyhow::{anyhow, Result};
use openbitfun_core_types::subscription::{
    SubscriptionQuotaDisplay, SubscriptionQuotaMeter, SubscriptionQuotaSnapshot,
    SubscriptionQuotaState,
};
use serde_json::Value;

pub fn unavailable(binding: &str, reason: &str) -> SubscriptionQuotaSnapshot {
    let mut out = quota::empty_snapshot(SubscriptionProvider::Opencode, binding, 0);
    out.state = SubscriptionQuotaState::Unsupported;
    out.error = Some(reason.into());
    out
}

fn parse(binding: &str, data: &Value, now: i64) -> Result<SubscriptionQuotaSnapshot> {
    let mut meters = Vec::new();
    for (id, seconds, legacy) in [
        ("rolling", 18000, "rollingUsage"),
        ("weekly", 604800, "weeklyUsage"),
        ("monthly", 2592000, "monthlyUsage"),
    ] {
        // Current envelope and the endpoint's original public response.
        let window = data
            .get("usage")
            .and_then(|u| u.get(id))
            .or_else(|| data.get(legacy));
        let Some(window) = window else { continue };
        let Some(percent) = window
            .get("percent")
            .and_then(Value::as_f64)
            .filter(|n| n.is_finite() && *n >= 0.0)
        else {
            continue;
        };
        let reset = (percent > 0.0)
            .then(|| {
                window
                    .get("resetsAt")
                    .and_then(Value::as_str)
                    .and_then(|raw| chrono::DateTime::parse_from_rfc3339(raw).ok())
                    .map(|t| t.timestamp())
            })
            .flatten();
        meters.push(SubscriptionQuotaMeter {
            id: id.into(),
            duration_seconds: Some(seconds),
            used_percent: Some(percent),
            resets_at: reset,
            ..Default::default()
        });
    }
    if meters.is_empty() {
        return Err(anyhow!("OpenCode returned no supported allowance windows"));
    }
    let mut out = quota::empty_snapshot(SubscriptionProvider::Opencode, binding, 0);
    out.state = SubscriptionQuotaState::Known;
    out.plan = Some("OpenCode Go".into());
    out.observed_at = Some(now);
    out.valid_until = Some(
        meters
            .iter()
            .filter_map(|m| m.resets_at)
            .fold(now + quota::CACHE_SECONDS, i64::min),
    );
    out.display = Some(SubscriptionQuotaDisplay {
        version: 1,
        expires_at: None,
        meters,
    });
    Ok(out)
}

async fn request(
    client: &reqwest::Client,
    endpoint: &str,
    key: &str,
    binding: &str,
) -> Result<SubscriptionQuotaSnapshot> {
    let response = client
        .get(endpoint)
        .bearer_auth(key)
        .header("Accept", "application/json")
        .header("User-Agent", crate::providers::shared::product_user_agent())
        .timeout(std::time::Duration::from_secs(20))
        .send()
        .await?;
    if !response.status().is_success() {
        let mut out = quota::empty_snapshot(SubscriptionProvider::Opencode, binding, 0);
        out.state = SubscriptionQuotaState::QueryFailed;
        out.error = Some(
            match response.status().as_u16() {
                401 => "opencode_key_rejected",
                403 => "opencode_go_required",
                _ => "opencode_query_failed",
            }
            .into(),
        );
        return Ok(out);
    }
    parse(
        binding,
        &response.json::<Value>().await?,
        chrono::Utc::now().timestamp(),
    )
}

/// The host supplies a saved API-key model's binding. Never accept an arbitrary
/// billing URL, OAuth token, or custom authorization as a Go key.
pub async fn read_api_key_quota(
    base: &str,
    key: &str,
    binding: &str,
    options: &SubscriptionHttpOptions,
) -> Result<SubscriptionQuotaSnapshot> {
    let base = base.trim_end_matches('/');
    if base == "https://opencode.ai/zen/v1" {
        return Ok(unavailable(
            binding,
            if key.trim().is_empty() || key.trim() == "public" {
                "opencode_public"
            } else {
                "opencode_balance_unavailable"
            },
        ));
    }
    if base != "https://opencode.ai/zen/go/v1" {
        return Err(anyhow!("Unsupported OpenCode quota origin"));
    }
    if key.trim().is_empty() || key.trim() == "public" {
        return Ok(unavailable(binding, "opencode_go_key_required"));
    }
    let client = super::build_http_client_with_redirect_policy(
        options,
        "OpenCode allowance",
        reqwest::redirect::Policy::none(),
    )?;
    match request(
        &client,
        "https://opencode.ai/zen/go/v1/usage",
        key.trim(),
        binding,
    )
    .await
    {
        Ok(out) => Ok(out),
        Err(_) => {
            let mut out = quota::empty_snapshot(SubscriptionProvider::Opencode, binding, 0);
            out.state = SubscriptionQuotaState::QueryFailed;
            out.error = Some("opencode_query_failed".into());
            Ok(out)
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;
    #[test]
    fn reads_current_and_legacy_windows_without_fabricating_idle_resets_or_amounts() {
        for data in [
            json!({"usage":{"rolling":{"percent":0,"resetsAt":"2026-11-01T00:00:00Z"},"weekly":{"percent":62,"resetsAt":"2026-11-01T00:00:00Z"},"monthly":{"percent":100}}}),
            json!({"rollingUsage":{"percent":0},"weeklyUsage":{"percent":62,"resetsAt":"2026-11-01T00:00:00Z"},"monthlyUsage":{"percent":100}}),
        ] {
            let out = parse("model:fixture", &data, 1000).unwrap();
            let meters = out.display.unwrap().meters;
            assert_eq!(meters.len(), 3);
            assert_eq!(meters[0].resets_at, None);
            assert!(meters[1].resets_at.is_some());
            assert_eq!(meters[1].used_percent, Some(62.0));
            assert!(meters
                .iter()
                .all(|m| m.remaining.is_none() && m.limit.is_none()));
        }
        assert!(parse(
            "model:fixture",
            &json!({"usage":{"rolling":{"percent":null}}}),
            1000
        )
        .is_err());
    }
    #[tokio::test]
    async fn transport_uses_bearer_key_and_distinguishes_entitlement_from_auth_failure() {
        openbitfun_services_core::tls_provider::ensure_ring_crypto_provider();
        let app = axum::Router::new().route(
            "/usage",
            axum::routing::get(|headers: reqwest::header::HeaderMap| async move {
                let status = match headers["authorization"].to_str().unwrap() {
                    "Bearer entitled" => 200,
                    "Bearer no-plan" => 403,
                    _ => 401,
                };
                (
                    reqwest::StatusCode::from_u16(status).unwrap(),
                    axum::Json(json!({"usage":{"rolling":{"percent":37}}})),
                )
            }),
        );
        let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
        let endpoint = format!("http://{}/usage", listener.local_addr().unwrap());
        let server = tokio::spawn(async move { axum::serve(listener, app).await.unwrap() });
        let client = reqwest::Client::builder().no_proxy().build().unwrap();
        assert_eq!(
            request(&client, &endpoint, "entitled", "model:fixture")
                .await
                .unwrap()
                .state,
            SubscriptionQuotaState::Known
        );
        assert_eq!(
            request(&client, &endpoint, "no-plan", "model:fixture")
                .await
                .unwrap()
                .error
                .as_deref(),
            Some("opencode_go_required")
        );
        assert_eq!(
            request(&client, &endpoint, "rejected", "model:fixture")
                .await
                .unwrap()
                .error
                .as_deref(),
            Some("opencode_key_rejected")
        );
        server.abort();
    }
    #[tokio::test]
    async fn public_and_zen_keys_have_explicit_non_network_states_and_origins_are_pinned() {
        let options = SubscriptionHttpOptions::default();
        for (base, key, reason) in [
            ("https://opencode.ai/zen/v1", "public", "opencode_public"),
            (
                "https://opencode.ai/zen/v1",
                "synthetic",
                "opencode_balance_unavailable",
            ),
            (
                "https://opencode.ai/zen/go/v1",
                "public",
                "opencode_go_key_required",
            ),
        ] {
            assert_eq!(
                read_api_key_quota(base, key, "model:fixture", &options)
                    .await
                    .unwrap()
                    .error
                    .as_deref(),
                Some(reason)
            );
        }
        assert!(read_api_key_quota(
            "https://opencode.ai.evil/zen/go/v1",
            "synthetic",
            "model:fixture",
            &options
        )
        .await
        .is_err());
    }
}
