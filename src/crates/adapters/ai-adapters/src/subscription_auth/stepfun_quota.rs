//! Step Plan billing authorization is independent of an inference API key.
//! Sessions are explicitly pasted by the user, isolated by saved model and
//! region, and kept in the existing credential vault (never in model config).
use super::{plan_quota as plan, store, StoredCredential, SubscriptionHttpOptions};
use anyhow::{anyhow, Result};
use base64::Engine;
use openbitfun_core_types::subscription::{SubscriptionQuotaMeter, SubscriptionQuotaSnapshot};
use serde::Serialize;
use serde_json::{json, Value};
use sha2::{Digest, Sha256};

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct StepFunQuotaSetup {
    pub connected: bool,
    pub account: Option<String>,
    pub sign_in_url: String,
    pub bookmarklet: String,
}

fn site(base: &str) -> Result<(&'static str, &'static str)> {
    if plan::kind(base) != Some(plan::PlanQuotaKind::Stepfun) {
        return Err(anyhow!("Unsupported StepFun model origin"));
    }
    if reqwest::Url::parse(base)?.host_str() == Some("api.stepfun.com") {
        Ok(("https://platform.stepfun.com", "10300"))
    } else {
        Ok(("https://platform.stepfun.ai", "20700"))
    }
}

fn slot(base: &str, binding: &str) -> Result<String> {
    let (origin, _) = site(base)?;
    Ok(format!(
        "stepfun-quota-{:x}",
        Sha256::digest(format!("{origin}|{binding}").as_bytes())
    ))
}

fn claims(token: &str) -> Result<Value> {
    let parts: Vec<_> = token.split('.').collect();
    if parts.len() != 3 || parts.iter().any(|part| part.is_empty()) {
        return Err(anyhow!("Invalid StepFun session format"));
    }
    let payload = base64::engine::general_purpose::URL_SAFE_NO_PAD
        .decode(parts[1].trim_end_matches('='))
        .map_err(|_| anyhow!("Invalid StepFun session format"))?;
    serde_json::from_slice(&payload).map_err(|_| anyhow!("Invalid StepFun session format"))
}

fn account(token: &str) -> Result<String> {
    let c = claims(token)?;
    if c["activated"].as_bool() != Some(true) {
        return Err(anyhow!("Sign in to StepFun before connecting allowance"));
    }
    match &c["oasis_id"] {
        Value::String(id) if !id.is_empty() => Ok(id.clone()),
        Value::Number(id) => Ok(id.to_string()),
        _ => Err(anyhow!("StepFun session has no account identity")),
    }
}

fn bookmarklet(origin: &str, app: &str) -> String {
    // The browser reads its own session only after the user runs this saved
    // bookmark. It copies an explicit import payload; it never calls our host.
    format!(
        r#"javascript:(async()=>{{if(location.origin!=={origin:?}){{alert('Open your signed-in StepFun plan page first');return}}try{{let w=localStorage.getItem('web_id')||'';const r=await fetch('/passport/proto.api.passport.v1.PassportService/RefreshToken',{{method:'POST',credentials:'include',headers:{{'Content-Type':'application/json','Connect-Protocol-Version':'1','Oasis-Appid':{app:?},'Oasis-Platform':'web','Oasis-Webid':w}},body:'{{}}'}});if(!r.ok)throw 0;const j=await r.json(),a=j.accessToken?.raw,f=j.refreshToken?.raw;if(!a||!f)throw 0;const t='openbitfun-stepfun:'+JSON.stringify({{origin:{origin:?},access:a,refresh:f,webId:w}});try{{await navigator.clipboard.writeText(t);alert('Copied. Paste the session into OpenBitFun.')}}catch{{prompt('Copy and paste into OpenBitFun',t)}}}}catch{{alert('Sign in to StepFun and try again')}}}})()"#
    )
}

pub async fn setup(base: &str, binding: &str) -> Result<StepFunQuotaSetup> {
    let (origin, app) = site(base)?;
    let saved = store::load_entry(&slot(base, binding)?).await?;
    let identity = match saved {
        Some(StoredCredential::Oauth {
            account_id,
            metadata,
            ..
        }) if metadata.as_ref().and_then(|v| v["version"].as_u64()) == Some(1) => account_id,
        _ => None,
    };
    Ok(StepFunQuotaSetup {
        connected: identity.is_some(),
        account: identity,
        sign_in_url: format!("{origin}/step-plan"),
        bookmarklet: bookmarklet(origin, app),
    })
}

pub async fn disconnect(base: &str, binding: &str) -> Result<()> {
    store::sign_out_account(&slot(base, binding)?).await?;
    Ok(())
}

fn pasted(base: &str, text: &str) -> Result<StoredCredential> {
    if text.len() > 65536 {
        return Err(anyhow!("StepFun session is too large"));
    }
    let (origin, _) = site(base)?;
    let raw = text.trim();
    let (access, refresh, mut web_id) = if let Some(body) = raw
        .strip_prefix("openbitfun-stepfun:")
        .or_else(|| raw.strip_prefix("magpie-stepfun:"))
    {
        let data: Value =
            serde_json::from_str(body).map_err(|_| anyhow!("Invalid StepFun session format"))?;
        if data
            .get("origin")
            .and_then(Value::as_str)
            .is_some_and(|s| s != origin)
            || data.get("site").and_then(Value::as_str).is_some_and(|s| {
                !matches!(s, "com" | "ai") || (s == "com") != origin.ends_with(".com")
            })
        {
            return Err(anyhow!("StepFun session belongs to another region"));
        }
        (
            data["access"].as_str().unwrap_or("").to_owned(),
            data["refresh"].as_str().unwrap_or("").to_owned(),
            data["webId"].as_str().unwrap_or("").to_owned(),
        )
    } else {
        let cookie = raw
            .strip_prefix("Oasis-Token=")
            .unwrap_or(raw)
            .split(';')
            .next()
            .unwrap_or("");
        let (a, r) = cookie
            .split_once("...")
            .ok_or_else(|| anyhow!("Paste the StepFun authorization bookmark result"))?;
        (a.to_owned(), r.to_owned(), String::new())
    };
    let identity = account(&access)?;
    let device = claims(&refresh)?;
    match &device["device_id"] {
        Value::String(id) => web_id = id.clone(),
        Value::Number(id) => web_id = id.to_string(),
        _ => {}
    }
    if web_id.is_empty() {
        return Err(anyhow!("StepFun session has no device identity"));
    }
    let expires = claims(&access)?["exp"]
        .as_i64()
        .and_then(|n| n.checked_mul(1000))
        .unwrap_or(0);
    Ok(StoredCredential::Oauth {
        access,
        refresh,
        expires,
        account_id: Some(identity),
        metadata: Some(json!({"version":1,"web_id":web_id,"origin":origin})),
    })
}

#[derive(Debug)]
struct Unauthorized;
impl std::fmt::Display for Unauthorized {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.write_str("StepFun session expired")
    }
}
impl std::error::Error for Unauthorized {}

fn rotated(mut credential: StoredCredential, value: &Value) -> Result<StoredCredential> {
    let StoredCredential::Oauth {
        access,
        refresh,
        expires,
        account_id,
        metadata,
    } = &mut credential
    else {
        return Err(anyhow!("StepFun session is unavailable"));
    };
    let next = value["accessToken"]["raw"].as_str().unwrap_or("");
    let identity = account(next)?;
    if Some(&identity) != account_id.as_ref() {
        return Err(anyhow!("StepFun account changed; reconnect"));
    }
    *expires = claims(next)?["exp"]
        .as_i64()
        .and_then(|n| n.checked_mul(1000))
        .ok_or_else(|| anyhow!("StepFun session expiry is unavailable"))?;
    *access = next.into();
    if let Some(next) = value["refreshToken"]["raw"]
        .as_str()
        .filter(|s| !s.is_empty())
    {
        let claims = claims(next)?;
        if let Some(device) = claims["device_id"].as_str().filter(|s| !s.is_empty()) {
            if let Some(metadata) = metadata {
                metadata["web_id"] = device.into();
            }
        }
        *refresh = next.into();
    }
    Ok(credential)
}

async fn renew(
    client: &reqwest::Client,
    origin: &str,
    app: &str,
    slot: &str,
    credential: StoredCredential,
    revision: u64,
) -> Result<(StoredCredential, u64)> {
    let value = call(
        client,
        origin,
        app,
        &credential,
        "/passport/proto.api.passport.v1.PassportService/RefreshToken",
    )
    .await?;
    let next = rotated(credential, &value)?;
    match store::upsert_if_revision(slot, revision, next.clone()).await? {
        store::ConditionalCommitOutcome::Committed { revision } => Ok((next, revision)),
        _ => Err(anyhow!("StepFun connection changed; reconnect")),
    }
}

async fn call(
    client: &reqwest::Client,
    origin: &str,
    app: &str,
    credential: &StoredCredential,
    path: &str,
) -> Result<Value> {
    let StoredCredential::Oauth {
        access,
        refresh,
        metadata,
        ..
    } = credential
    else {
        return Err(anyhow!("StepFun session is unavailable"));
    };
    let meta = metadata
        .as_ref()
        .ok_or_else(|| anyhow!("StepFun session metadata is unavailable"))?;
    if meta["version"] != 1 || meta["origin"] != origin {
        return Err(anyhow!("Unsupported StepFun session binding; reconnect"));
    }
    let response = client
        .post(format!("{origin}{path}"))
        .header("Cookie", format!("Oasis-Token={access}...{refresh}"))
        .header("Content-Type", "application/json")
        .header("Connect-Protocol-Version", "1")
        .header("Oasis-Appid", app)
        .header("Oasis-Platform", "web")
        .header("Oasis-Webid", meta["web_id"].as_str().unwrap_or(""))
        .timeout(std::time::Duration::from_secs(20))
        .json(&json!({}))
        .send()
        .await?;
    if matches!(response.status().as_u16(), 401 | 403) {
        return Err(Unauthorized.into());
    }
    if !response.status().is_success() {
        return Err(anyhow!("StepFun allowance request failed"));
    }
    Ok(response.json().await?)
}

fn client(options: &SubscriptionHttpOptions) -> Result<reqwest::Client> {
    super::build_http_client_with_redirect_policy(
        options,
        "StepFun allowance",
        reqwest::redirect::Policy::none(),
    )
}

pub async fn connect(
    base: &str,
    binding: &str,
    text: &str,
    options: &SubscriptionHttpOptions,
) -> Result<()> {
    let slot = slot(base, binding)?;
    let revision = store::credential_revision(&slot).await?;
    let credential = pasted(base, text)?;
    let (origin, app) = site(base)?;
    // A locally decoded JWT is not proof of authorization: verify it with the
    // official read-only billing endpoint before committing any vault entry.
    call(
        &client(options)?,
        origin,
        app,
        &credential,
        "/api/step.openapi.devcenter.Dashboard/QueryStepPlanRateLimit",
    )
    .await
    .map_err(|_| {
        anyhow!("StepFun did not accept the session; sign in and copy authorization again")
    })?;
    if !matches!(
        store::upsert_if_revision(&slot, revision, credential).await?,
        store::ConditionalCommitOutcome::Committed { .. }
    ) {
        return Err(anyhow!(
            "StepFun connection changed during authorization; retry"
        ));
    }
    Ok(())
}

pub(super) fn parse(
    binding: &str,
    data: &Value,
    status: Option<&Value>,
    now: i64,
    revision: u64,
) -> Result<SubscriptionQuotaSnapshot> {
    let mut meters = vec![];
    for (id, seconds, left, reset, resetless) in [
        (
            "five-hour",
            Some(18000),
            &data["five_hour_usage_left_rate"],
            &data["five_hour_usage_reset_time"],
            false,
        ),
        (
            "weekly",
            Some(604800),
            &data["weekly_usage_left_rate"],
            &data["weekly_usage_reset_time"],
            false,
        ),
        (
            "credits",
            None,
            &data["plan_credit_rate_limit"]["subscription_credit_left_rate"],
            &data["plan_credit_rate_limit"]["subscription_credit_reset_time"],
            data["plan_credit_rate_limit"]["credit_buckets"]
                .as_array()
                .is_some_and(|a| !a.is_empty()),
        ),
    ] {
        let reset = plan::timestamp(reset);
        let Some(left) = plan::number(left) else {
            continue;
        };
        if reset.is_none() && !resetless {
            continue;
        }
        let left = if left > 1.0 { left / 100.0 } else { left };
        meters.push(SubscriptionQuotaMeter {
            id: id.into(),
            duration_seconds: seconds,
            used_percent: Some((1.0 - left.clamp(0.0, 1.0)) * 100.0),
            resets_at: reset,
            ..Default::default()
        });
    }
    let subscription = status.map(|s| &s["subscription"]);
    let expires = subscription.and_then(|s| plan::timestamp(&s["expired_at"]));
    let name = subscription
        .and_then(|s| s["name"].as_str())
        .filter(|s| !s.is_empty())
        .unwrap_or("Step Plan");
    plan::observed(
        "stepfun",
        binding,
        revision,
        now,
        Some(name.into()),
        expires,
        meters,
    )
}

pub async fn read(
    base: &str,
    binding: &str,
    options: &SubscriptionHttpOptions,
) -> Result<SubscriptionQuotaSnapshot> {
    // Once renewal starts, cancellation of an observer must not discard a
    // rotated browser refresh token before its revision-checked vault commit.
    let (base, binding, options) = (base.to_owned(), binding.to_owned(), options.clone());
    tokio::spawn(async move { read_owned(&base, &binding, &options).await })
        .await
        .map_err(|_| anyhow!("StepFun allowance task failed"))?
}

async fn read_owned(
    base: &str,
    binding: &str,
    options: &SubscriptionHttpOptions,
) -> Result<SubscriptionQuotaSnapshot> {
    let slot = slot(base, binding)?;
    let _lease = store::acquire_provider_refresh_lease(&format!("{slot}-quota")).await?;
    let entry = store::load_entry_with_revision(&slot).await?;
    let Some(mut credential) = entry.credential else {
        return Ok(plan::unavailable(
            "stepfun",
            binding,
            "stepfun_quota_sign_in_required",
        ));
    };
    let client = client(options)?;
    let (origin, app) = site(base)?;
    let now = chrono::Utc::now().timestamp();
    let mut revision = entry.revision;
    let expires_soon = matches!(&credential, StoredCredential::Oauth { expires, .. } if *expires <= (now+300)*1000);
    if expires_soon {
        match renew(&client, origin, app, &slot, credential, revision).await {
            Ok((next, next_revision)) => {
                credential = next;
                revision = next_revision;
            }
            Err(_) => {
                return Ok(plan::failed(
                    "stepfun",
                    binding,
                    "stepfun_quota_sign_in_required",
                ))
            }
        }
    }
    let path = "/api/step.openapi.devcenter.Dashboard/QueryStepPlanRateLimit";
    let mut data = call(&client, origin, app, &credential, path).await;
    if !expires_soon
        && data
            .as_ref()
            .err()
            .is_some_and(|error| error.downcast_ref::<Unauthorized>().is_some())
    {
        match renew(&client, origin, app, &slot, credential, revision).await {
            Ok((next, next_revision)) => {
                credential = next;
                revision = next_revision;
            }
            Err(_) => {
                return Ok(plan::failed(
                    "stepfun",
                    binding,
                    "stepfun_quota_sign_in_required",
                ))
            }
        }
        data = call(&client, origin, app, &credential, path).await;
    }
    let result = match data {
        Ok(data) => {
            let status = call(
                &client,
                origin,
                app,
                &credential,
                "/api/step.openapi.devcenter.Dashboard/GetStepPlanStatus",
            )
            .await
            .ok();
            parse(binding, &data, status.as_ref(), now, revision)
        }
        Err(error) => Err(error),
    };
    if store::credential_revision(&slot).await? != revision {
        return Ok(plan::failed(
            "stepfun",
            binding,
            "stepfun_quota_connection_changed",
        ));
    }
    Ok(result.unwrap_or_else(|_| plan::failed("stepfun", binding, "plan_quota_query_failed")))
}

#[cfg(test)]
mod tests {
    use super::*;
    fn jwt(data: Value) -> String {
        format!(
            "e30.{}.signature",
            base64::engine::general_purpose::URL_SAFE_NO_PAD
                .encode(serde_json::to_vec(&data).unwrap())
        )
    }
    fn payload(activated: bool) -> String {
        format!(
            "openbitfun-stepfun:{}",
            json!({"origin":"https://platform.stepfun.com","access":jwt(json!({"activated":activated,"oasis_id":"account-a","exp":2000000000})),"refresh":jwt(json!({"device_id":"device-real"})),"webId":"device-stale"})
        )
    }
    #[test]
    fn refresh_rejects_anonymous_and_different_accounts_without_rebinding() {
        let old = pasted("https://api.stepfun.com/v1", &payload(true)).unwrap();
        for claims in [
            json!({"activated":false,"oasis_id":"account-a","exp":2000000001}),
            json!({"activated":true,"oasis_id":"account-b","exp":2000000001}),
        ] {
            assert!(rotated(old.clone(), &json!({"accessToken":{"raw":jwt(claims)}})).is_err());
        }
        let next = rotated(old, &json!({"accessToken":{"raw":jwt(json!({"activated":true,"oasis_id":"account-a","exp":2000000001}))}})).unwrap();
        assert!(matches!(
            next,
            StoredCredential::Oauth {
                expires: 2000000001000,
                ..
            }
        ));
    }
    #[test]
    fn imports_explicit_session_and_validates_account_region_and_device() {
        let c = pasted("https://api.stepfun.com/v1", &payload(true)).unwrap();
        let StoredCredential::Oauth {
            account_id,
            metadata,
            expires,
            ..
        } = c
        else {
            panic!()
        };
        assert_eq!(account_id.as_deref(), Some("account-a"));
        assert_eq!(metadata.unwrap()["web_id"], "device-real");
        assert_eq!(expires, 2000000000000);
        assert!(pasted("https://api.stepfun.ai/v1", &payload(true)).is_err());
        assert!(pasted("https://api.stepfun.com/v1", &payload(false)).is_err());
        assert_ne!(
            slot("https://api.stepfun.com/v1", "model:a").unwrap(),
            slot("https://api.stepfun.ai/v1", "model:a").unwrap()
        );
        assert_ne!(
            slot("https://api.stepfun.com/v1", "model:a").unwrap(),
            slot("https://api.stepfun.com/v1", "model:b").unwrap()
        );
    }
    #[test]
    fn windows_keep_missing_values_unknown_and_accept_fraction_or_percent() {
        let q = parse("model:s", &json!({"five_hour_usage_left_rate":"0.6","five_hour_usage_reset_time":"2000000000","weekly_usage_left_rate":90,"weekly_usage_reset_time":2000001000000_i64,"plan_credit_rate_limit":{"subscription_credit_left_rate":0.8,"credit_buckets":[{}]}}), None, 1000, 2).unwrap();
        let m = &q.display.unwrap().meters;
        assert_eq!(m.len(), 3);
        assert_eq!(m[0].used_percent, Some(40.0));
        assert!((m[1].used_percent.unwrap() - 10.0).abs() < 0.00001);
        assert!(m.iter().all(|m| m.remaining.is_none()));
        assert!(q.windows.is_empty() && q.allowed.is_none());
        assert!(parse(
            "model:s",
            &json!({"five_hour_usage_left_rate":0,"five_hour_usage_reset_time":0}),
            None,
            1000,
            1
        )
        .is_err());
    }
    #[tokio::test]
    async fn session_is_vault_only_and_disconnect_fences_late_refresh() {
        let _guard = super::super::tests::test_lock().lock().await;
        let dir = std::env::temp_dir().join(format!("stepfun-quota-{}", uuid::Uuid::new_v4()));
        let path = dir.join("auth.json");
        store::set_store_path_for_test(path.clone());
        let base = "https://api.stepfun.com/v1";
        let name = slot(base, "model:a").unwrap();
        let c = pasted(base, &payload(true)).unwrap();
        store::upsert(&name, c.clone()).await.unwrap();
        let old = store::credential_revision(&name).await.unwrap();
        let text = std::fs::read_to_string(path).unwrap();
        assert!(!text.contains("signature"));
        assert!(setup(base, "model:a").await.unwrap().connected);
        assert!(!setup(base, "model:b").await.unwrap().connected);
        disconnect(base, "model:a").await.unwrap();
        assert!(!matches!(
            store::upsert_if_revision(&name, old, c).await.unwrap(),
            store::ConditionalCommitOutcome::Committed { .. }
        ));
        assert!(!setup(base, "model:a").await.unwrap().connected);
        let _ = std::fs::remove_dir_all(dir);
    }
    #[tokio::test]
    async fn connect_transport_uses_only_pinned_oasis_cookie_and_headers() {
        use axum::{extract::Request, routing::any, Json, Router};
        openbitfun_services_core::tls_provider::ensure_ring_crypto_provider();
        let router = Router::new().fallback(any(|request: Request| async move {
            assert_eq!(request.method(), "POST");
            assert_eq!(
                request.headers()["cookie"],
                "Oasis-Token=synthetic-access...synthetic-refresh"
            );
            assert_eq!(request.headers()["oasis-appid"], "10300");
            assert_eq!(request.headers()["oasis-webid"], "fixture-device");
            assert_eq!(request.headers()["connect-protocol-version"], "1");
            assert!(!request.headers().contains_key("authorization"));
            Json(json!({"weekly_usage_left_rate":0.5,"weekly_usage_reset_time":2000000000}))
        }));
        let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
        let origin = format!("http://{}", listener.local_addr().unwrap());
        let server = tokio::spawn(async move { axum::serve(listener, router).await.unwrap() });
        let c = StoredCredential::Oauth {
            access: "synthetic-access".into(),
            refresh: "synthetic-refresh".into(),
            expires: i64::MAX,
            account_id: Some("fixture".into()),
            metadata: Some(json!({"version":1,"origin":origin,"web_id":"fixture-device"})),
        };
        let response = call(
            &client(&SubscriptionHttpOptions::default()).unwrap(),
            &origin,
            "10300",
            &c,
            "/billing",
        )
        .await
        .unwrap();
        assert_eq!(response["weekly_usage_left_rate"], 0.5);
        server.abort();
    }
}
