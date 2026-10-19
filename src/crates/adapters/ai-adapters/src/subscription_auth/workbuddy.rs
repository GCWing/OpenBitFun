//! WorkBuddy browser sign-in, refresh and account-owned model discovery.
//! Protocol reference: magpie-community/plugins packages/workbuddy (2026-10-19).
//! Only OpenBitFun's credential vault is read; no desktop credential import.
use super::browser_poll::{self as api, integer, required, text};
use super::device_flow::{poll_device_code, DevicePoll};
use super::{
    store, ResolvedCredential, StartedLogin, StoredCredential, SubscriptionHttpOptions,
    SubscriptionProvider,
};
use anyhow::{anyhow, Result};
use serde_json::{json, Value};
use std::{collections::HashMap, time::Duration};
use tokio_util::sync::CancellationToken;

pub(crate) const USER_AGENT: &str = "WorkBuddy/5.5.6";

pub(super) fn root(provider: SubscriptionProvider) -> &'static str {
    match provider {
        SubscriptionProvider::Workbuddy => "https://copilot.tencent.com",
        SubscriptionProvider::WorkbuddyAi => "https://www.workbuddy.ai",
        _ => unreachable!("WorkBuddy provider required"),
    }
}

pub(super) fn suggested(
    provider: SubscriptionProvider,
) -> (&'static str, &'static str, &'static str) {
    match provider {
        SubscriptionProvider::Workbuddy => ("openai", "https://copilot.tencent.com/v2", "auto"),
        SubscriptionProvider::WorkbuddyAi => {
            ("openai", "https://www.workbuddy.ai/v2", "default-model")
        }
        _ => unreachable!("WorkBuddy provider required"),
    }
}

pub(super) fn inference_url(provider: SubscriptionProvider) -> &'static str {
    match provider {
        SubscriptionProvider::Workbuddy => "https://copilot.tencent.com/v2/chat/completions",
        SubscriptionProvider::WorkbuddyAi => "https://www.workbuddy.ai/v2/chat/completions",
        _ => unreachable!("WorkBuddy provider required"),
    }
}

fn request(
    client: &reqwest::Client,
    method: reqwest::Method,
    root: &str,
    path: &str,
) -> reqwest::RequestBuilder {
    client
        .request(method, format!("{root}{path}"))
        .header("User-Agent", USER_AGENT)
        .header("Accept", "application/json")
        .header("Content-Type", "application/json")
}

fn token_credential(
    token: &Value,
    identity: String,
    mut metadata: Value,
    previous_refresh: &str,
) -> Result<StoredCredential> {
    let access = required(token, "accessToken")?.to_owned();
    let refresh = text(token, "refreshToken");
    let refresh = if refresh.is_empty() {
        previous_refresh
    } else {
        refresh
    }
    .to_owned();
    if refresh.is_empty() {
        return Err(anyhow!("WorkBuddy did not provide a refresh token"));
    }
    let expires_at = integer(&token["expiresAt"]);
    let expires_in = integer(&token["expiresIn"]);
    let expires = if expires_at > 0 {
        expires_at
    } else if expires_in > 0 {
        chrono::Utc::now()
            .timestamp_millis()
            .saturating_add(expires_in.saturating_mul(1000))
    } else {
        return Err(anyhow!("WorkBuddy did not provide token expiry"));
    };
    for (remote, local) in [
        ("domain", "domain"),
        ("refreshExpiresAt", "refresh_expires_at"),
    ] {
        if let Some(value) = token.get(remote).filter(|v| !v.is_null()) {
            metadata[local] = value.clone();
        }
    }
    Ok(StoredCredential::Oauth {
        access,
        refresh,
        expires,
        account_id: Some(identity),
        metadata: Some(metadata),
    })
}

pub(crate) fn headers(
    provider: SubscriptionProvider,
    identity: &str,
    metadata: &Value,
) -> HashMap<String, String> {
    let mut headers = HashMap::from([
        ("User-Agent".into(), USER_AGENT.into()),
        (
            "X-User-Id".into(),
            if text(metadata, "uid").is_empty() {
                identity.into()
            } else {
                text(metadata, "uid").into()
            },
        ),
        (
            "X-Domain".into(),
            if text(metadata, "domain").is_empty() {
                root(provider).trim_start_matches("https://").into()
            } else {
                text(metadata, "domain").into()
            },
        ),
        ("X-Product".into(), "SaaS".into()),
        ("X-IDE-Type".into(), "WorkBuddy".into()),
        ("X-IDE-Name".into(), "WorkBuddy".into()),
        ("X-IDE-Version".into(), "5.5.6".into()),
        ("X-Agent-Intent".into(), "craft".into()),
        ("X-Agent-Purpose".into(), "conversation".into()),
        ("X-Requested-With".into(), "XMLHttpRequest".into()),
    ]);
    let enterprise = text(metadata, "enterprise_id");
    if !enterprise.is_empty() {
        headers.insert("X-Enterprise-Id".into(), enterprise.into());
        headers.insert("X-Tenant-Id".into(), enterprise.into());
    }
    if provider == SubscriptionProvider::WorkbuddyAi {
        headers.insert("X-Agent-Type".into(), "main".into());
    }
    headers
}

pub(super) async fn begin_login_for_account(
    provider: SubscriptionProvider,
    slot: String,
    cancel: CancellationToken,
    expected_revision: u64,
    options: SubscriptionHttpOptions,
) -> Result<StartedLogin> {
    let client = super::build_http_client_with_redirect_policy(
        &options,
        "WorkBuddy",
        reqwest::redirect::Policy::none(),
    )?;
    begin_login_with_client(
        provider,
        slot,
        cancel,
        expected_revision,
        client,
        root(provider).into(),
    )
    .await
}

async fn begin_login_with_client(
    provider: SubscriptionProvider,
    slot: String,
    cancel: CancellationToken,
    expected_revision: u64,
    client: reqwest::Client,
    api_root: String,
) -> Result<StartedLogin> {
    let platform = if provider == SubscriptionProvider::WorkbuddyAi {
        "workbuddy-ai"
    } else {
        "workbuddy"
    };
    let state = api::data(
        request(
            &client,
            reqwest::Method::POST,
            &api_root,
            &format!("/v2/plugin/auth/state?platform={platform}"),
        )
        .header("X-No-Authorization", "true")
        .header("X-No-User-Id", "true")
        .header("X-No-Enterprise-Id", "true")
        .header("X-No-Department-Info", "true")
        .json(&json!({})),
        false,
    )
    .await?;
    let state_id = required(&state, "state")?.to_owned();
    let mut url = api::authorization_url(required(&state, "authUrl")?)?;
    api::set_query(&mut url, "version", "2.0.0");
    api::set_query(
        &mut url,
        "loginSessionId",
        &uuid::Uuid::new_v4().simple().to_string(),
    );
    let runner = async move {
        super::authorize_then_persist(provider, cancel, async {
            let mut token_url = reqwest::Url::parse(&format!("{}/v2/plugin/auth/token", &api_root))?;
            token_url.query_pairs_mut().append_pair("state", &state_id);
            let token = poll_device_code(Duration::from_secs(1), super::LOGIN_TIMEOUT, Duration::ZERO, true, || async {
                match api::data(client.get(token_url.clone()).header("User-Agent", USER_AGENT), false).await {
                    Ok(data) if text(&data, "accessToken").is_empty() => Ok(DevicePoll::Pending),
                    Ok(data) => Ok(DevicePoll::Authorized(data)),
                    Err(error) if error.downcast_ref::<api::ApiError>().is_some_and(|e| e.code == 11217 || e.status == 408 || e.status == 429) => Ok(DevicePoll::Pending),
                    Err(error) => Err(error),
                }
            }).await?;
            let mut account_url = reqwest::Url::parse(&format!("{}/v2/plugin/login/account", &api_root))?;
            account_url.query_pairs_mut().append_pair("state", &state_id);
            let who = poll_device_code(Duration::from_secs(1), super::LOGIN_TIMEOUT, Duration::ZERO, true, || async {
                let builder = client.get(account_url.clone()).header("User-Agent", USER_AGENT).bearer_auth(required(&token, "accessToken")?)
                    .header("X-Domain", text(&token, "domain")).header("X-No-User-Id", "true").header("X-No-Enterprise-Id", "true");
                match api::data(builder, false).await {
                    Ok(data) if text(&data, "uid").is_empty() => Ok(DevicePoll::Pending),
                    Ok(data) => Ok(DevicePoll::Authorized(data)),
                    Err(error) if error.downcast_ref::<api::ApiError>().is_some_and(|e| e.code == 12151) => Ok(DevicePoll::Pending),
                    Err(error) => Err(error),
                }
            }).await?;
            let uid = required(&who, "uid")?.to_owned();
            let mut enterprise = text(&who, "enterpriseId").to_owned();
            let kind = text(&who, "type");
            if !kind.is_empty() && !kind.eq_ignore_ascii_case("personal") && enterprise.is_empty() {
                let list = api::data(request(&client, reqwest::Method::GET, &api_root, "/v2/plugin/accounts")
                    .bearer_auth(required(&token, "accessToken")?).header("X-Domain", text(&token, "domain")), false).await?;
                let mine: Vec<_> = list["accounts"].as_array().into_iter().flatten()
                    .filter(|a| text(a, "uid") == uid && !text(a, "enterpriseId").is_empty()).collect();
                let same: Vec<_> = mine.iter().copied().filter(|a| text(a, "type").eq_ignore_ascii_case(kind)).collect();
                let last: Vec<_> = mine.iter().copied().filter(|a| a["lastLogin"] == true).collect();
                let pick = if same.len() == 1 { Some(same[0]) } else if last.len() == 1 { Some(last[0]) } else if mine.len() == 1 { Some(mine[0]) } else { None };
                enterprise = pick.map(|a| text(a, "enterpriseId").to_owned()).ok_or_else(||anyhow!("WorkBuddy enterprise identity is ambiguous; sign in to the intended enterprise account again"))?;
            }
            let identity = if enterprise.is_empty() { uid.clone() } else { json!([uid, enterprise]).to_string() };
            token_credential(&token, identity, json!({"uid":uid,"email": ([text(&who, "nickname"), text(&who, "phoneNumber"), text(&who, "uid")].into_iter().find(|s| !s.is_empty()).unwrap_or("")), "enterprise_id": enterprise}), "")
        }, move |credential| async move {
            let outcome = super::accounts::persist_account_credential(provider, &slot, expected_revision, credential).await?;
            super::require_current_store_revision(provider, outcome).map(|_| ())
        }).await
    };
    Ok(StartedLogin { method: super::SubscriptionLoginMethod::Device, authorization_url: url.into(), user_code: None,
        instructions: "Sign in to WorkBuddy in your browser, then return to OpenBitFun. Authorization completes automatically.".into(), runner: Box::pin(runner) })
}

async fn fresh(
    provider: SubscriptionProvider,
    slot: &str,
    rejected: Option<&str>,
    options: &SubscriptionHttpOptions,
) -> Result<StoredCredential> {
    let (slot, rejected, options) = (
        slot.to_owned(),
        rejected.map(str::to_owned),
        options.clone(),
    );
    super::complete_credential_refresh(async move {
        let _lease = store::acquire_provider_refresh_lease(&slot).await?;
        let snapshot = store::load_entry_with_revision(&slot).await?;
        let credential = snapshot
            .credential
            .ok_or_else(|| anyhow!("WorkBuddy is not connected; sign in first"))?;
        let StoredCredential::Oauth {
            access,
            refresh,
            expires,
            account_id: Some(identity),
            metadata: Some(metadata),
        } = &credential
        else {
            return Err(anyhow!("Invalid WorkBuddy credential; sign in again"));
        };
        if rejected.as_deref() != Some(access.as_str())
            && *expires > chrono::Utc::now().timestamp_millis() + 60_000
        {
            return Ok(credential);
        }
        if refresh.is_empty() {
            return Err(anyhow!(
                "WorkBuddy session cannot be renewed; sign in again"
            ));
        }
        let client = super::build_http_client_with_redirect_policy(
            &options,
            "WorkBuddy",
            reqwest::redirect::Policy::none(),
        )?;
        let mut builder = request(
            &client,
            reqwest::Method::POST,
            root(provider),
            "/v2/plugin/auth/token/refresh",
        )
        .header("X-Refresh-Token", refresh)
        .header("X-Auth-Refresh-Source", "plugin");
        let mut required = reqwest::header::HeaderMap::new();
        for (k, v) in headers(provider, identity, metadata) {
            required.insert(
                reqwest::header::HeaderName::from_bytes(k.as_bytes())?,
                v.parse()?,
            );
        }
        builder = builder.headers(required);
        let response = api::data(builder.json(&json!({})), false).await?;
        let next = token_credential(&response, identity.clone(), metadata.clone(), refresh)?;
        let outcome = super::accounts::persist_account_credential(
            provider,
            &slot,
            snapshot.revision,
            next.clone(),
        )
        .await?;
        super::require_current_store_revision(provider, outcome)?;
        Ok(next)
    })
    .await
}

pub(super) async fn resolve(
    provider: SubscriptionProvider,
    slot: &str,
    options: &SubscriptionHttpOptions,
) -> Result<ResolvedCredential> {
    let credential = fresh(provider, slot, None, options).await?;
    let StoredCredential::Oauth {
        access,
        expires,
        account_id: Some(id),
        metadata: Some(metadata),
        ..
    } = credential
    else {
        unreachable!()
    };
    let (_, base, _) = suggested(provider);
    Ok(ResolvedCredential {
        api_key: access,
        base_url: Some(base.into()),
        request_url: Some(inference_url(provider).into()),
        format: Some("openai".into()),
        extra_headers: headers(provider, &id, &metadata),
        expires_at: Some(expires / 1000),
    })
}

pub(super) async fn recover(
    provider: SubscriptionProvider,
    slot: &str,
    rejected: &str,
    options: &SubscriptionHttpOptions,
) -> Result<()> {
    fresh(provider, slot, Some(rejected), options)
        .await
        .map(|_| ())
}

pub(crate) async fn list_models(
    client: &crate::client::AIClient,
    provider: SubscriptionProvider,
) -> Result<Vec<crate::types::RemoteModelInfo>> {
    let cfg = api::data(model_catalog_request(client, root(provider)), false).await?;
    parse_models(&cfg)
}

fn model_catalog_request(client: &crate::client::AIClient, root: &str) -> reqwest::RequestBuilder {
    let mut builder = client
        .client
        .get(format!("{root}/v3/config"))
        .bearer_auth(&client.config.api_key);
    // These were produced by resolve from the selected vault account.
    if let Some(headers) = &client.config.custom_headers {
        for (k, v) in headers {
            // reqwest appends header values. WorkBuddy selects the product by
            // User-Agent, so appending CLI after the OAuth IDE identity still
            // returns the IDE catalog, which has no `cli` agent.
            if !k.eq_ignore_ascii_case("user-agent") {
                builder = builder.header(k, v);
            }
        }
    }
    builder
        .header("User-Agent", "CLI/2.0.0 WorkBuddy/5.5.6")
        .header("Accept", "application/json")
}

fn parse_models(cfg: &Value) -> Result<Vec<crate::types::RemoteModelInfo>> {
    let ids = cfg["agents"]
        .as_array()
        .and_then(|agents| agents.iter().find(|a| text(a, "name") == "cli"))
        .and_then(|a| a["models"].as_array())
        .ok_or_else(|| anyhow!("WorkBuddy config has no CLI model catalog"))?;
    let models = cfg["models"].as_array();
    let out: Vec<_> = ids
        .iter()
        .filter_map(Value::as_str)
        .filter(|id| !id.is_empty())
        .map(|id| {
            let name = models
                .and_then(|ms| ms.iter().find(|m| text(m, "id") == id))
                .map(|m| text(m, "name"))
                .filter(|s| !s.is_empty());
            crate::types::RemoteModelInfo {
                id: id.into(),
                display_name: name.map(str::to_owned),
                routing: None,
            }
        })
        .collect();
    if out.is_empty() {
        return Err(anyhow!("WorkBuddy returned an empty model catalog"));
    }
    Ok(out)
}

#[cfg(test)]
mod tests {
    use super::*;
    fn catalog_client(provider: SubscriptionProvider) -> crate::AIClient {
        let config = serde_json::from_value(json!({
            "name":"catalog-test", "model":"auto", "format":"openai",
            "base_url":suggested(provider).1, "request_url":inference_url(provider),
            "api_key":"synthetic-access", "context_window":4096,
            "inline_think_in_text":false, "skip_ssl_verify":false,
            "custom_headers":headers(provider, "synthetic-user", &json!({"enterprise_id":"synthetic-team"}))
        })).unwrap();
        crate::AIClient::new(config)
    }

    #[tokio::test]
    async fn catalog_uses_a_single_cli_identity_and_selected_account() {
        use axum::{routing::get, Json, Router};
        let app = Router::new().route(
            "/v3/config",
            get(|headers: reqwest::header::HeaderMap| async move {
                let uas: Vec<_> = headers.get_all("user-agent").iter().collect();
                // The gateway routes by its first User-Agent. A second CLI value
                // cannot override the IDE identity already added by OAuth resolve.
                assert_eq!(uas.len(), 1);
                assert_eq!(uas[0], "CLI/2.0.0 WorkBuddy/5.5.6");
                assert_eq!(headers["authorization"], "Bearer synthetic-access");
                assert_eq!(headers["x-user-id"], "synthetic-user");
                assert_eq!(headers["x-enterprise-id"], "synthetic-team");
                assert_eq!(headers["x-tenant-id"], "synthetic-team");
                Json(json!({"code":0,"data":{"agents":[{"name":"cli","models":["wire-model"]}]}}))
            }),
        );
        let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
        let endpoint = format!("http://{}", listener.local_addr().unwrap());
        let server = tokio::spawn(async move {
            axum::serve(listener, app).await.unwrap();
        });
        for provider in [
            SubscriptionProvider::Workbuddy,
            SubscriptionProvider::WorkbuddyAi,
        ] {
            let mut client = catalog_client(provider);
            // Required account headers must also win over mixed-case saved
            // User-Agent spellings when selecting the catalog product.
            client
                .config
                .custom_headers
                .as_mut()
                .unwrap()
                .insert("uSeR-aGeNt".into(), "SavedClient/1".into());
            let cfg = api::data(model_catalog_request(&client, &endpoint), false)
                .await
                .unwrap();
            assert_eq!(parse_models(&cfg).unwrap()[0].id, "wire-model");
        }
        server.abort();
    }

    #[tokio::test]
    #[ignore = "Reads an explicitly selected OpenBitFun account and queries its real WorkBuddy catalog; never prints credentials"]
    async fn live_workbuddy_model_catalog() {
        let slot = std::env::var("OPENBITFUN_LIVE_WORKBUDDY_ACCOUNT")
            .expect("select an OpenBitFun account slot explicitly");
        let provider = if slot == "workbuddy_ai" || slot.starts_with("workbuddy_ai-account-") {
            SubscriptionProvider::WorkbuddyAi
        } else {
            SubscriptionProvider::Workbuddy
        };
        super::super::accounts::validate_account_id(provider, &slot).unwrap();
        let mut proxy = None;
        if let Ok(path) = std::env::var("OPENBITFUN_LIVE_SUBSCRIPTION_CONFIG") {
            let settings: Value = serde_json::from_slice(&std::fs::read(path).unwrap()).unwrap();
            proxy = serde_json::from_value(settings["ai"]["proxy"].clone()).unwrap();
        }
        let options = SubscriptionHttpOptions::new(proxy.clone(), false);
        let resolved = resolve(provider, &slot, &options)
            .await
            .expect("resolve selected in-app account");
        let mut client = catalog_client(provider);
        resolved.apply_to(&mut client.config);
        let client = crate::AIClient::new_with_proxy(client.config, proxy)
            .with_subscription_provider(provider);
        let models = tokio::time::timeout(Duration::from_secs(30), list_models(&client, provider))
            .await
            .expect("catalog request must finish within 30 seconds")
            .expect("selected account's CLI catalog must be available");
        eprintln!("workbuddy_catalog_model_count={}", models.len());
        assert!(!models.is_empty());
    }

    #[tokio::test]
    async fn browser_poll_commits_only_the_selected_slot_and_cancellation_keeps_it() {
        use axum::{
            routing::{get, post},
            Json, Router,
        };
        let _guard = super::super::tests::test_lock().lock().await;
        let dir = std::env::temp_dir().join(format!(
            "openbitfun-workbuddy-test-{}",
            uuid::Uuid::new_v4()
        ));
        store::set_store_path_for_test(dir.join("metadata.json"));
        let app = Router::new()
            .route("/v2/plugin/auth/state", post(|| async { Json(json!({"code":0,"data":{"state":"fixture-state","authUrl":"https://example.com/login"}})) }))
            .route("/v2/plugin/auth/token", get(|| async { Json(json!({"code":0,"data":{"accessToken":"synthetic-access","refreshToken":"synthetic-refresh","expiresIn":3600,"domain":"copilot.tencent.com"}})) }))
            .route("/v2/plugin/login/account", get(|headers:reqwest::header::HeaderMap| async move {
                assert_eq!(headers["authorization"],"Bearer synthetic-access");
                Json(json!({"code":0,"data":{"uid":"fixture-user","nickname":"Fixture","type":"personal"}}))
            }));
        let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
        let endpoint = format!("http://{}", listener.local_addr().unwrap());
        let server = tokio::spawn(async move {
            axum::serve(listener, app).await.unwrap();
        });
        let provider = SubscriptionProvider::Workbuddy;
        let slot = format!("workbuddy-account-{}", uuid::Uuid::new_v4());
        openbitfun_services_core::tls_provider::ensure_ring_crypto_provider();
        let client = reqwest::Client::builder().no_proxy().build().unwrap();
        let started = begin_login_with_client(
            provider,
            slot.clone(),
            CancellationToken::new(),
            0,
            client.clone(),
            endpoint.clone(),
        )
        .await
        .unwrap();
        started.runner.await.unwrap();
        let resolved = resolve(provider, &slot, &Default::default()).await.unwrap();
        assert_eq!(resolved.api_key, "synthetic-access");
        assert_eq!(resolved.extra_headers["X-User-Id"], "fixture-user");
        assert!(store::load_entry(provider.key()).await.unwrap().is_none());
        let revision = store::credential_revision(&slot).await.unwrap();
        let cancel = CancellationToken::new();
        let started = begin_login_with_client(
            provider,
            slot.clone(),
            cancel.clone(),
            revision,
            client,
            endpoint,
        )
        .await
        .unwrap();
        cancel.cancel();
        assert!(started.runner.await.is_err());
        assert_eq!(store::credential_revision(&slot).await.unwrap(), revision);
        super::super::logout_account(provider, &slot).await.unwrap();
        server.abort();
        let _ = std::fs::remove_dir_all(dir);
    }
    #[test]
    fn preserves_wire_model_ids_and_filters_other_agents() {
        let ms = parse_models(&json!({"agents":[{"name":"cli","models":["glm-5.3-flash"]},{"name":"other","models":["bad"]}],"models":[{"id":"glm-5.3-flash","name":"GLM-5.3-Flash"}]})).unwrap();
        assert_eq!(ms.len(), 1);
        assert_eq!(ms[0].id, "glm-5.3-flash");
        assert!(parse_models(&json!({})).is_err());
    }
    #[test]
    fn refresh_preserves_identity_and_enterprise() {
        let c = token_credential(
            &json!({"accessToken":"synthetic-new", "expiresIn":3600}),
            "uid".into(),
            json!({"enterprise_id":"team","domain":"copilot.tencent.com"}),
            "synthetic-refresh",
        )
        .unwrap();
        let StoredCredential::Oauth {
            refresh,
            account_id,
            metadata,
            ..
        } = c
        else {
            panic!()
        };
        assert_eq!(refresh, "synthetic-refresh");
        assert_eq!(account_id.as_deref(), Some("uid"));
        let h = headers(SubscriptionProvider::Workbuddy, "uid", &metadata.unwrap());
        assert_eq!(h["X-Enterprise-Id"], "team");
        assert_eq!(h["X-Tenant-Id"], "team");
    }
}
