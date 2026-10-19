//! Codex (ChatGPT) subscription login and credential resolution.
//!
//! Aligned with OpenCode's `plugin/openai/codex.ts`: browser PKCE login against
//! `auth.openai.com` on registered loopback ports, then Bearer access to
//! `chatgpt.com/backend-api/codex/responses`.

use super::store::{self, StoredCredential};
use super::{
    jwt, oauth_server, pkce::Pkce, ResolvedCredential, StartedLogin, SubscriptionHttpOptions,
};
use anyhow::{anyhow, Context, Result};
use serde::Deserialize;
use std::collections::HashMap;
use std::time::Duration;
use tokio_util::sync::CancellationToken;

const CLIENT_ID: &str = "app_EMoamEEZ73f0CkXaXp7hrann";
const ISSUER: &str = "https://auth.openai.com";
const CALLBACK_PATH: &str = "/auth/callback";
const CALLBACK_PORT: u16 = 1455;
const DEVICE_USER_CODE_URL: &str = "https://auth.openai.com/api/accounts/deviceauth/usercode";
const DEVICE_TOKEN_URL: &str = "https://auth.openai.com/api/accounts/deviceauth/token";
const DEVICE_AUTHORIZATION_URL: &str = "https://auth.openai.com/codex/device";
const DEVICE_REDIRECT_URI: &str = "https://auth.openai.com/deviceauth/callback";
const OAUTH_POLLING_SAFETY_MARGIN_SECS: u64 = 3;
const SCOPE: &str = "openid profile email offline_access";
const CHATGPT_BASE_URL: &str = "https://chatgpt.com/backend-api/codex";
const CHATGPT_REQUEST_URL: &str = "https://chatgpt.com/backend-api/codex/responses";
const DEFAULT_MODEL: &str = "gpt-5.5";
const REFRESH_LEEWAY_MS: i64 = 5 * 60 * 1000;
const STORE_KEY: &str = "codex";

fn redirect_uri(port: u16) -> String {
    oauth_server::loopback_redirect_uri(port, CALLBACK_PATH)
}

#[derive(Debug, Deserialize)]
struct TokenResponse {
    #[serde(default)]
    id_token: Option<String>,
    #[serde(default)]
    access_token: Option<String>,
    #[serde(default)]
    refresh_token: Option<String>,
    #[serde(default)]
    expires_in: Option<i64>,
}

#[derive(Debug, Deserialize)]
struct DeviceCodeResponse {
    device_auth_id: String,
    user_code: String,
    interval: serde_json::Value,
}

#[derive(Debug, Deserialize)]
struct DeviceAuthorizationResponse {
    authorization_code: String,
    code_verifier: String,
}

fn user_agent() -> String {
    crate::providers::shared::product_user_agent()
}

fn device_poll_interval(value: &serde_json::Value) -> u64 {
    value
        .as_str()
        .and_then(|value| value.parse::<u64>().ok())
        .or_else(|| value.as_u64())
        .filter(|value| *value > 0)
        .unwrap_or(5)
}

fn build_authorize_url(pkce: &Pkce, state: &str, redirect_uri: &str) -> String {
    let params = [
        ("response_type", "code"),
        ("client_id", CLIENT_ID),
        ("redirect_uri", redirect_uri),
        ("scope", SCOPE),
        ("code_challenge", pkce.challenge.as_str()),
        ("code_challenge_method", "S256"),
        ("id_token_add_organizations", "true"),
        ("codex_cli_simplified_flow", "true"),
        ("state", state),
        ("originator", "openbitfun"),
    ];
    let query = params
        .iter()
        .map(|(key, value)| format!("{}={}", key, urlencoding::encode(value)))
        .collect::<Vec<_>>()
        .join("&");
    format!("{ISSUER}/oauth/authorize?{query}")
}

fn http_client(options: &SubscriptionHttpOptions) -> Result<reqwest::Client> {
    super::build_http_client(options, "Codex")
}

async fn exchange_code(
    code: &str,
    verifier: &str,
    redirect_uri: &str,
    options: &SubscriptionHttpOptions,
) -> Result<TokenResponse> {
    let client = http_client(options)?;
    let params = [
        ("grant_type", "authorization_code"),
        ("code", code),
        ("redirect_uri", redirect_uri),
        ("client_id", CLIENT_ID),
        ("code_verifier", verifier),
    ];
    let resp = client
        .post(format!("{ISSUER}/oauth/token"))
        .header(reqwest::header::USER_AGENT, user_agent())
        .header(reqwest::header::ACCEPT, "application/json")
        .form(&params)
        .send()
        .await
        .context("call codex token endpoint")?;
    if !resp.status().is_success() {
        let status = resp.status();
        let body = resp.text().await.unwrap_or_default();
        return Err(anyhow!(
            "codex token exchange failed: HTTP {status}: {body}"
        ));
    }
    resp.json().await.context("parse codex token response")
}

#[derive(Debug)]
struct RefreshGrantRejected;
impl std::fmt::Display for RefreshGrantRejected {
    fn fmt(&self, formatter: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        formatter.write_str("Codex refresh grant was rejected; sign in to this account again")
    }
}
impl std::error::Error for RefreshGrantRejected {}

async fn refresh(
    refresh_token: &str,
    options: &SubscriptionHttpOptions,
    endpoint: &str,
) -> Result<TokenResponse> {
    let client = http_client(options)?;
    let params = [
        ("grant_type", "refresh_token"),
        ("refresh_token", refresh_token),
        ("client_id", CLIENT_ID),
    ];
    let resp = client
        .post(endpoint)
        .header(reqwest::header::USER_AGENT, user_agent())
        .header(reqwest::header::ACCEPT, "application/json")
        .form(&params)
        .send()
        .await
        .context("call codex token endpoint")?;
    if !resp.status().is_success() {
        let status = resp.status();
        let body = resp.text().await.unwrap_or_default();
        if matches!(
            status,
            reqwest::StatusCode::BAD_REQUEST | reqwest::StatusCode::UNAUTHORIZED
        ) && serde_json::from_str::<serde_json::Value>(&body)
            .ok()
            .and_then(|value| {
                value
                    .get("error")
                    .and_then(serde_json::Value::as_str)
                    .map(str::to_owned)
            })
            .as_deref()
            == Some("invalid_grant")
        {
            return Err(RefreshGrantRejected.into());
        }
        return Err(anyhow!("codex token refresh failed: HTTP {status}: {body}"));
    }
    resp.json().await.context("parse codex token response")
}

async fn request_device_code(options: &SubscriptionHttpOptions) -> Result<DeviceCodeResponse> {
    let response = http_client(options)?
        .post(DEVICE_USER_CODE_URL)
        .header(reqwest::header::USER_AGENT, user_agent())
        .json(&serde_json::json!({ "client_id": CLIENT_ID }))
        .send()
        .await
        .context("call codex device authorization endpoint")?;
    if !response.status().is_success() {
        let status = response.status();
        let body = response.text().await.unwrap_or_default();
        return Err(anyhow!(
            "codex device authorization failed: HTTP {status}: {body}"
        ));
    }
    let device = response
        .json::<DeviceCodeResponse>()
        .await
        .context("parse codex device authorization response")?;
    if device.device_auth_id.trim().is_empty() || device.user_code.trim().is_empty() {
        return Err(anyhow!(
            "codex device authorization response is missing an id or user code"
        ));
    }
    Ok(device)
}

async fn poll_device_authorization(
    device: &DeviceCodeResponse,
    options: &SubscriptionHttpOptions,
) -> Result<DeviceAuthorizationResponse> {
    let interval =
        device_poll_interval(&device.interval).saturating_add(OAUTH_POLLING_SAFETY_MARGIN_SECS);
    loop {
        let response = http_client(options)?
            .post(DEVICE_TOKEN_URL)
            .header(reqwest::header::USER_AGENT, user_agent())
            .json(&serde_json::json!({
                "device_auth_id": device.device_auth_id,
                "user_code": device.user_code,
            }))
            .send()
            .await
            .context("poll codex device authorization endpoint")?;
        if response.status().is_success() {
            return response
                .json::<DeviceAuthorizationResponse>()
                .await
                .context("parse codex device authorization token response");
        }
        if !matches!(
            response.status(),
            reqwest::StatusCode::FORBIDDEN | reqwest::StatusCode::NOT_FOUND
        ) {
            let status = response.status();
            let body = response.text().await.unwrap_or_default();
            return Err(anyhow!(
                "codex device authorization failed: HTTP {status}: {body}"
            ));
        }
        tokio::time::sleep(Duration::from_secs(interval)).await;
    }
}

fn now_ms() -> i64 {
    chrono::Utc::now().timestamp_millis()
}

fn account_id_from(tokens: &TokenResponse) -> Option<String> {
    tokens
        .id_token
        .as_deref()
        .and_then(jwt::chatgpt_account_id)
        .or_else(|| {
            tokens
                .access_token
                .as_deref()
                .and_then(jwt::chatgpt_account_id)
        })
}

fn metadata_from(tokens: &TokenResponse) -> Option<serde_json::Value> {
    let email = tokens.id_token.as_deref().and_then(jwt::email)?;
    Some(serde_json::json!({ "email": email }))
}

async fn persist_tokens(
    store_key: &str,
    tokens: TokenResponse,
    expected_revision: u64,
) -> Result<()> {
    let access = tokens
        .access_token
        .clone()
        .ok_or_else(|| anyhow!("codex token response missing access_token"))?;
    let refresh = tokens
        .refresh_token
        .clone()
        .ok_or_else(|| anyhow!("codex token response missing refresh_token"))?;
    let expires = now_ms() + tokens.expires_in.unwrap_or(3600) * 1000;
    let expires = jwt::effective_expiry_ms(&access, expires);
    let account_id = account_id_from(&tokens);
    let metadata = metadata_from(&tokens);
    if store_key != STORE_KEY {
        let identity = account_id
            .as_deref()
            .filter(|id| !id.trim().is_empty())
            .ok_or_else(|| {
                anyhow!("Codex account authorization is missing its account identity")
            })?;
        if let Some(previous) = store::oauth_account_identity(store_key).await? {
            if previous.as_deref() != Some(identity) {
                return Err(anyhow!("Codex reauthentication returned a different account; add it as a new account instead"));
            }
        }
    }
    let outcome = store::upsert_if_revision(
        store_key,
        expected_revision,
        StoredCredential::Oauth {
            refresh,
            access,
            expires,
            account_id,
            metadata,
        },
    )
    .await?;
    super::require_current_store_revision(super::SubscriptionProvider::Codex, outcome)?;
    log::info!("codex subscription tokens saved");
    Ok(())
}

async fn begin_browser_login(
    store_key: String,
    cancel: CancellationToken,
    expected_revision: u64,
    options: SubscriptionHttpOptions,
) -> Result<StartedLogin> {
    let pkce = Pkce::generate();
    let state = super::pkce::random_state();
    let (listener, callback_port) = oauth_server::bind_loopback_ports(&[CALLBACK_PORT]).await?;
    let redirect_uri = redirect_uri(callback_port);
    let authorization_url = build_authorize_url(&pkce, &state, &redirect_uri);
    let verifier = pkce.verifier.clone();

    let runner = async move {
        super::authorize_then_persist(
            super::SubscriptionProvider::Codex,
            cancel,
            async {
                let params =
                    oauth_server::wait_for_callback(listener, CALLBACK_PATH, &state).await?;
                let code = params
                    .get("code")
                    .cloned()
                    .ok_or_else(|| anyhow!("codex callback missing code"))?;
                exchange_code(&code, &verifier, &redirect_uri, &options).await
            },
            move |tokens| async move { persist_tokens(&store_key, tokens, expected_revision).await },
        )
        .await
    };

    Ok(StartedLogin {
        method: super::SubscriptionLoginMethod::Browser,
        authorization_url,
        user_code: None,
        instructions: "Complete authorization in your browser, then return to OpenBitFun."
            .to_string(),
        runner: Box::pin(runner),
    })
}

async fn begin_device_login(
    store_key: String,
    cancel: CancellationToken,
    expected_revision: u64,
    options: SubscriptionHttpOptions,
) -> Result<StartedLogin> {
    let device = request_device_code(&options).await?;
    let user_code = device.user_code.clone();
    let runner = async move {
        super::authorize_then_persist(
            super::SubscriptionProvider::Codex,
            cancel,
            async {
                let authorization = poll_device_authorization(&device, &options).await?;
                exchange_code(
                    &authorization.authorization_code,
                    &authorization.code_verifier,
                    DEVICE_REDIRECT_URI,
                    &options,
                )
                .await
            },
            move |tokens| async move { persist_tokens(&store_key, tokens, expected_revision).await },
        )
        .await
    };

    Ok(StartedLogin {
        method: super::SubscriptionLoginMethod::Device,
        authorization_url: DEVICE_AUTHORIZATION_URL.to_string(),
        user_code: Some(user_code.clone()),
        instructions: format!("Open the verification link and enter code: {user_code}"),
        runner: Box::pin(runner),
    })
}

/// Starts the selected OpenCode-compatible Codex authorization flow. Legacy
/// callers that do not select a method keep browser-first behavior, with a
/// device-flow fallback when the registered loopback callback is unavailable.
pub(crate) async fn begin_login_for_account(
    store_key: String,
    cancel: CancellationToken,
    expected_revision: u64,
    method: Option<super::SubscriptionLoginMethod>,
    options: SubscriptionHttpOptions,
) -> Result<StartedLogin> {
    super::accounts::validate_account_id(super::SubscriptionProvider::Codex, &store_key)?;
    match method {
        Some(super::SubscriptionLoginMethod::Browser) => {
            begin_browser_login(store_key, cancel, expected_revision, options).await
        }
        Some(super::SubscriptionLoginMethod::Device) => {
            begin_device_login(store_key, cancel, expected_revision, options).await
        }
        None => match begin_browser_login(
            store_key.clone(),
            cancel.clone(),
            expected_revision,
            options.clone(),
        )
        .await
        {
            Ok(started) => Ok(started),
            Err(browser_error) => {
                log::info!(
                "Codex browser login unavailable; using device authorization: {browser_error:#}"
            );
                begin_device_login(store_key, cancel, expected_revision, options)
                .await
                .with_context(|| {
                    format!(
                        "start Codex device authorization after browser login was unavailable: {browser_error:#}"
                    )
                })
            }
        },
    }
}

/// Ensures the stored access token is fresh, refreshing it when needed. Returns
/// the current `(access, account_id, expires_ms)`.
async fn ensure_fresh(
    store_key: &str,
    options: &SubscriptionHttpOptions,
) -> Result<(String, Option<String>, i64, u64)> {
    ensure_fresh_at(store_key, options, None, &format!("{ISSUER}/oauth/token")).await
}

async fn ensure_fresh_at(
    store_key: &str,
    options: &SubscriptionHttpOptions,
    rejected: Option<(&str, Option<&str>)>,
    refresh_endpoint: &str,
) -> Result<(String, Option<String>, i64, u64)> {
    let _refresh_lease = store::acquire_provider_refresh_lease(store_key).await?;
    let snapshot = store::load_entry_with_revision(store_key).await?;
    let entry = snapshot
        .credential
        .ok_or_else(|| anyhow!("Codex is not connected; sign in first"))?;
    let StoredCredential::Oauth {
        refresh: refresh_token,
        access,
        expires,
        account_id,
        metadata,
    } = entry
    else {
        return Err(anyhow!("Codex credential is not an OAuth login"));
    };

    let expires = jwt::effective_expiry_ms(&access, expires);
    let current_identity = account_id
        .clone()
        .or_else(|| jwt::chatgpt_account_id(&access));
    if rejected
        .is_some_and(|(_, expected_identity)| current_identity.as_deref() != expected_identity)
    {
        return Err(anyhow!(
            "Codex account identity changed after the rejected request"
        ));
    }
    let force_refresh = rejected.is_some_and(|(rejected_access, _)| rejected_access == access);
    if !force_refresh && expires > now_ms() + REFRESH_LEEWAY_MS {
        return Ok((access, account_id, expires, snapshot.revision));
    }

    let refreshed = match refresh(&refresh_token, options, refresh_endpoint).await {
        Ok(refreshed) => refreshed,
        Err(error) => {
            if error.is::<RefreshGrantRejected>() {
                if let store::ConditionalCommitOutcome::Conflict { current_revision } =
                    store::require_reauthentication_if_revision(store_key, snapshot.revision)
                        .await?
                {
                    return credential_after_refresh_conflict(store_key, current_revision).await;
                }
            }
            return Err(error);
        }
    };
    let new_access = refreshed
        .access_token
        .clone()
        .ok_or_else(|| anyhow!("codex refresh response missing access_token"))?;
    let new_refresh = refreshed.refresh_token.clone().unwrap_or(refresh_token);
    let new_expires = now_ms() + refreshed.expires_in.unwrap_or(3600) * 1000;
    let new_expires = jwt::effective_expiry_ms(&new_access, new_expires);
    let refreshed_account_id = account_id_from(&refreshed);
    if (store_key != STORE_KEY || rejected.is_some())
        && refreshed_account_id
            .as_ref()
            .is_some_and(|id| Some(id) != current_identity.as_ref())
    {
        return Err(anyhow!(
            "Codex token refresh returned a different account identity"
        ));
    }
    let new_account_id = refreshed_account_id.or(current_identity);
    let new_metadata = metadata_from(&refreshed).or(metadata);
    let outcome = store::upsert_if_revision(
        store_key,
        snapshot.revision,
        StoredCredential::Oauth {
            refresh: new_refresh,
            access: new_access.clone(),
            expires: new_expires,
            account_id: new_account_id.clone(),
            metadata: new_metadata,
        },
    )
    .await?;
    match outcome {
        store::ConditionalCommitOutcome::Committed { revision } => {
            log::info!("codex subscription tokens refreshed");
            Ok((new_access, new_account_id, new_expires, revision))
        }
        store::ConditionalCommitOutcome::Conflict { current_revision } => {
            credential_after_refresh_conflict(store_key, current_revision).await
        }
    }
}

async fn credential_after_refresh_conflict(
    store_key: &str,
    current_revision: u64,
) -> Result<(String, Option<String>, i64, u64)> {
    let current = store::load_entry_with_revision(store_key).await?;
    match current.credential {
        Some(StoredCredential::Oauth {
            access,
            expires,
            account_id,
            ..
        }) if jwt::effective_expiry_ms(&access, expires) > now_ms() => {
            log::info!("codex refresh reused credentials committed by a concurrent account update");
            let expires = jwt::effective_expiry_ms(&access, expires);
            Ok((access, account_id, expires, current.revision))
        }
        _ => Err(super::store_revision_conflict(
            super::SubscriptionProvider::Codex,
            current_revision,
        )),
    }
}

pub(super) async fn recover_rejected_account(
    store_key: &str,
    rejected_access: &str,
    upstream_account_id: Option<&str>,
    options: &SubscriptionHttpOptions,
) -> Result<()> {
    super::accounts::validate_account_id(super::SubscriptionProvider::Codex, store_key)?;
    recover_rejected_account_at(
        store_key,
        rejected_access,
        upstream_account_id,
        options,
        &format!("{ISSUER}/oauth/token"),
    )
    .await
}

async fn recover_rejected_account_at(
    store_key: &str,
    rejected_access: &str,
    upstream_account_id: Option<&str>,
    options: &SubscriptionHttpOptions,
    endpoint: &str,
) -> Result<()> {
    let (store_key, rejected_access, upstream_account_id, options, endpoint) = (
        store_key.to_owned(),
        rejected_access.to_owned(),
        upstream_account_id.map(str::to_owned),
        options.clone(),
        endpoint.to_owned(),
    );
    // Once OAuth rotates a refresh token, finishing the local CAS commit is
    // independent of the model turn's cancellation. The account lease remains
    // owned by this task; logout/disable still invalidate its commit revision.
    tokio::spawn(async move {
        let (access, identity, _, _) = ensure_fresh_at(
            &store_key,
            &options,
            Some((&rejected_access, upstream_account_id.as_deref())),
            &endpoint,
        )
        .await?;
        if identity.or_else(|| jwt::chatgpt_account_id(&access)) != upstream_account_id {
            return Err(anyhow!(
                "Codex account identity changed during authentication recovery"
            ));
        }
        Ok(())
    })
    .await
    .map_err(|_| anyhow!("Codex authentication recovery task stopped"))?
}

/// Resolves the runtime credential (refreshing tokens if required).
pub(crate) async fn resolve(options: &SubscriptionHttpOptions) -> Result<ResolvedCredential> {
    resolve_account(STORE_KEY, options).await
}

pub(super) async fn resolve_account(
    store_key: &str,
    options: &SubscriptionHttpOptions,
) -> Result<ResolvedCredential> {
    Ok(resolve_account_versioned(store_key, options).await?.0)
}

pub(super) async fn resolve_account_versioned(
    store_key: &str,
    options: &SubscriptionHttpOptions,
) -> Result<(ResolvedCredential, u64)> {
    super::accounts::validate_account_id(super::SubscriptionProvider::Codex, store_key)?;
    let (access, account_id, expires, revision) = ensure_fresh(store_key, options).await?;
    let account_id = account_id.or_else(|| jwt::chatgpt_account_id(&access));
    if store_key != STORE_KEY && account_id.as_deref().is_none_or(|id| id.trim().is_empty()) {
        return Err(anyhow!(
            "Codex account is missing its upstream identity; sign in to this account again"
        ));
    }
    let mut headers = HashMap::new();
    if let Some(account) = account_id {
        headers.insert("ChatGPT-Account-ID".to_string(), account);
    }
    headers.insert("originator".to_string(), "openbitfun".to_string());
    headers.insert("User-Agent".to_string(), user_agent());
    if let Some(residency) = jwt::chatgpt_compute_residency(&access) {
        headers.insert("x-openai-internal-codex-residency".to_string(), residency);
    }

    let (format, base_url, request_url) = request_route();
    Ok((
        ResolvedCredential {
            api_key: access,
            base_url: Some(base_url.to_string()),
            request_url: Some(request_url.to_string()),
            format: Some(format.to_string()),
            extra_headers: headers,
            expires_at: Some(expires / 1000),
        },
        revision,
    ))
}

pub(super) fn request_route() -> (&'static str, &'static str, &'static str) {
    ("responses", CHATGPT_BASE_URL, CHATGPT_REQUEST_URL)
}

/// Provider metadata used to seed a new model entry.
pub(crate) fn suggested() -> (&'static str, &'static str, &'static str) {
    ("responses", CHATGPT_BASE_URL, DEFAULT_MODEL)
}

#[cfg(test)]
mod tests {
    use super::{
        build_authorize_url, device_poll_interval, redirect_uri, user_agent, CALLBACK_PORT,
        DEFAULT_MODEL,
    };
    use crate::subscription_auth::pkce::Pkce;

    struct RecoveryEndpoint {
        url: String,
        calls: std::sync::Arc<std::sync::atomic::AtomicUsize>,
        started: std::sync::Arc<tokio::sync::Notify>,
        release: std::sync::Arc<tokio::sync::Notify>,
        task: tokio::task::JoinHandle<()>,
    }
    impl Drop for RecoveryEndpoint {
        fn drop(&mut self) {
            self.task.abort();
        }
    }
    impl RecoveryEndpoint {
        async fn new(hold: bool) -> Self {
            Self::with_reply(hold, 200, serde_json::json!({"access_token":"renewed-access", "refresh_token":"renewed-refresh", "expires_in":3600})).await
        }
        async fn with_reply(hold: bool, status: u16, reply: serde_json::Value) -> Self {
            use std::sync::{
                atomic::{AtomicUsize, Ordering},
                Arc,
            };
            let calls = Arc::new(AtomicUsize::new(0));
            let started = Arc::new(tokio::sync::Notify::new());
            let release = Arc::new(tokio::sync::Notify::new());
            let (count, signal, wait) = (calls.clone(), started.clone(), release.clone());
            let app = axum::Router::new().route(
                "/token",
                axum::routing::post(move || {
                    let (count, signal, wait) = (count.clone(), signal.clone(), wait.clone());
                    let reply = reply.clone();
                    async move {
                        count.fetch_add(1, Ordering::SeqCst);
                        signal.notify_one();
                        if hold {
                            wait.notified().await;
                        }
                        (
                            axum::http::StatusCode::from_u16(status).unwrap(),
                            axum::Json(reply),
                        )
                    }
                }),
            );
            let listener = tokio::net::TcpListener::bind(("127.0.0.1", 0))
                .await
                .unwrap();
            let url = format!("http://{}/token", listener.local_addr().unwrap());
            let task = tokio::spawn(async move {
                axum::serve(listener, app).await.unwrap();
            });
            Self {
                url,
                calls,
                started,
                release,
                task,
            }
        }
    }
    async fn recovery_account(id: &str, seat: &str) -> u64 {
        use crate::subscription_auth::{store, StoredCredential};
        store::upsert(
            id,
            StoredCredential::Oauth {
                access: "rejected-access".into(),
                refresh: "initial-refresh".into(),
                expires: super::now_ms() + 3_600_000,
                account_id: Some(seat.into()),
                metadata: None,
            },
        )
        .await
        .unwrap();
        store::credential_revision(id).await.unwrap()
    }

    #[tokio::test]
    async fn rejected_unexpired_tokens_refresh_once_and_reuse_a_concurrent_replacement() {
        use crate::subscription_auth::{store, tests, SubscriptionHttpOptions};
        let _guard = tests::test_lock().lock().await;
        store::set_store_path_for_test(tests::temp_store_path());
        let id = format!("codex-account-{}", uuid::Uuid::new_v4());
        let revision = recovery_account(&id, "seat-one").await;
        let endpoint = RecoveryEndpoint::new(false).await;
        let options = SubscriptionHttpOptions::default();
        let (first, second) = tokio::join!(
            super::recover_rejected_account_at(
                &id,
                "rejected-access",
                Some("seat-one"),
                &options,
                &endpoint.url
            ),
            super::recover_rejected_account_at(
                &id,
                "rejected-access",
                Some("seat-one"),
                &options,
                &endpoint.url
            )
        );
        first.unwrap();
        second.unwrap();
        assert_eq!(endpoint.calls.load(std::sync::atomic::Ordering::SeqCst), 1);
        assert!(store::credential_revision(&id).await.unwrap() > revision);
        assert!(
            matches!(store::load_entry(&id).await.unwrap(), Some(crate::subscription_auth::StoredCredential::Oauth { access, .. }) if access == "renewed-access")
        );
    }

    #[tokio::test]
    async fn logout_and_disable_win_over_an_inflight_rejected_token_recovery() {
        use crate::subscription_auth::{
            self, store, tests, SubscriptionHttpOptions, SubscriptionProvider,
        };
        let _guard = tests::test_lock().lock().await;
        for disable in [false, true] {
            store::set_store_path_for_test(tests::temp_store_path());
            let id = format!("codex-account-{}", uuid::Uuid::new_v4());
            recovery_account(&id, "seat-one").await;
            let endpoint = RecoveryEndpoint::new(true).await;
            let (slot, url) = (id.clone(), endpoint.url.clone());
            let recovery = tokio::spawn(async move {
                super::recover_rejected_account_at(
                    &slot,
                    "rejected-access",
                    Some("seat-one"),
                    &SubscriptionHttpOptions::default(),
                    &url,
                )
                .await
            });
            tokio::time::timeout(
                std::time::Duration::from_secs(5),
                endpoint.started.notified(),
            )
            .await
            .unwrap();
            if disable {
                subscription_auth::set_account_instance_enabled(
                    SubscriptionProvider::Codex,
                    &id,
                    false,
                )
                .await
                .unwrap();
            } else {
                subscription_auth::logout_account(SubscriptionProvider::Codex, &id)
                    .await
                    .unwrap();
            }
            let revision = store::credential_revision(&id).await.unwrap();
            endpoint.release.notify_one();
            assert!(recovery.await.unwrap().is_err());
            assert_eq!(store::credential_revision(&id).await.unwrap(), revision);
            if disable {
                subscription_auth::set_account_instance_enabled(
                    SubscriptionProvider::Codex,
                    &id,
                    true,
                )
                .await
                .unwrap();
                assert!(
                    matches!(store::load_entry(&id).await.unwrap(), Some(subscription_auth::StoredCredential::Oauth { access, .. }) if access == "rejected-access")
                );
            } else {
                assert!(store::load_entry(&id).await.unwrap().is_none());
            }
        }
    }

    #[tokio::test]
    async fn cancelling_a_model_wait_does_not_abandon_a_rotated_oauth_credential() {
        use crate::subscription_auth::{store, tests, SubscriptionHttpOptions};
        let _guard = tests::test_lock().lock().await;
        store::set_store_path_for_test(tests::temp_store_path());
        let id = format!("codex-account-{}", uuid::Uuid::new_v4());
        let revision = recovery_account(&id, "seat-one").await;
        let endpoint = RecoveryEndpoint::new(true).await;
        let (slot, url) = (id.clone(), endpoint.url.clone());
        let waiting_turn = tokio::spawn(async move {
            super::recover_rejected_account_at(
                &slot,
                "rejected-access",
                Some("seat-one"),
                &SubscriptionHttpOptions::default(),
                &url,
            )
            .await
        });
        tokio::time::timeout(
            std::time::Duration::from_secs(5),
            endpoint.started.notified(),
        )
        .await
        .unwrap();
        waiting_turn.abort();
        assert!(waiting_turn.await.unwrap_err().is_cancelled());
        endpoint.release.notify_one();
        tokio::time::timeout(std::time::Duration::from_secs(5), async {
            while store::credential_revision(&id).await.unwrap() == revision {
                tokio::time::sleep(std::time::Duration::from_millis(5)).await;
            }
        })
        .await
        .unwrap();
        assert!(
            matches!(store::load_entry(&id).await.unwrap(), Some(crate::subscription_auth::StoredCredential::Oauth { access, .. }) if access == "renewed-access")
        );
        assert_eq!(endpoint.calls.load(std::sync::atomic::Ordering::SeqCst), 1);
    }

    #[tokio::test]
    async fn rejected_request_cannot_refresh_a_different_default_account_identity() {
        use crate::subscription_auth::{store, tests, SubscriptionHttpOptions};
        let _guard = tests::test_lock().lock().await;
        store::set_store_path_for_test(tests::temp_store_path());
        let revision = recovery_account("codex", "new-seat").await;
        let endpoint = RecoveryEndpoint::new(false).await;
        assert!(super::recover_rejected_account_at(
            "codex",
            "rejected-access",
            Some("old-seat"),
            &SubscriptionHttpOptions::default(),
            &endpoint.url
        )
        .await
        .is_err());
        assert_eq!(endpoint.calls.load(std::sync::atomic::Ordering::SeqCst), 0);
        assert_eq!(store::credential_revision("codex").await.unwrap(), revision);
    }

    #[tokio::test]
    async fn only_permanent_refresh_grant_rejections_require_reauthentication_and_keep_vault_refs()
    {
        use crate::subscription_auth::{store, tests, SubscriptionHttpOptions};
        let _guard = tests::test_lock().lock().await;
        for (status, code, permanent) in [
            (400, "invalid_grant", true),
            (401, "invalid_grant", true),
            (503, "invalid_grant", false),
            (400, "invalid_client", false),
        ] {
            let path = tests::temp_store_path();
            store::set_store_path_for_test(path.clone());
            let id = format!("codex-account-{}", uuid::Uuid::new_v4());
            let revision = recovery_account(&id, "seat-one").await;
            let before: serde_json::Value =
                serde_json::from_slice(&std::fs::read(&path).unwrap()).unwrap();
            let endpoint =
                RecoveryEndpoint::with_reply(false, status, serde_json::json!({"error":code}))
                    .await;
            assert!(super::recover_rejected_account_at(
                &id,
                "rejected-access",
                Some("seat-one"),
                &SubscriptionHttpOptions::default(),
                &endpoint.url
            )
            .await
            .is_err());
            let state = store::load_with_state().await.unwrap();
            assert_eq!(state.requires_reauthentication.contains(&id), permanent);
            assert_eq!(state.credentials.contains_key(&id), !permanent);
            assert_eq!(
                store::credential_revision(&id).await.unwrap(),
                revision + u64::from(permanent)
            );
            let after: serde_json::Value =
                serde_json::from_slice(&std::fs::read(&path).unwrap()).unwrap();
            for field in [
                "secret_set_id",
                "refresh_parts",
                "access_parts",
                "account_id",
            ] {
                assert_eq!(
                    before["accounts"][&id][field],
                    after["accounts"][&id][field]
                );
            }
        }
    }

    #[tokio::test]
    async fn a_stale_invalid_grant_response_reuses_a_newer_login_without_marking_it_invalid() {
        use crate::subscription_auth::{store, tests, SubscriptionHttpOptions};
        let _guard = tests::test_lock().lock().await;
        store::set_store_path_for_test(tests::temp_store_path());
        let id = format!("codex-account-{}", uuid::Uuid::new_v4());
        recovery_account(&id, "seat-one").await;
        let endpoint =
            RecoveryEndpoint::with_reply(true, 400, serde_json::json!({"error":"invalid_grant"}))
                .await;
        let (slot, url) = (id.clone(), endpoint.url.clone());
        let recovery = tokio::spawn(async move {
            super::recover_rejected_account_at(
                &slot,
                "rejected-access",
                Some("seat-one"),
                &SubscriptionHttpOptions::default(),
                &url,
            )
            .await
        });
        tokio::time::timeout(
            std::time::Duration::from_secs(5),
            endpoint.started.notified(),
        )
        .await
        .unwrap();
        store::upsert(
            &id,
            crate::subscription_auth::StoredCredential::Oauth {
                access: "new-login-access".into(),
                refresh: "new-login-refresh".into(),
                expires: super::now_ms() + 3_600_000,
                account_id: Some("seat-one".into()),
                metadata: None,
            },
        )
        .await
        .unwrap();
        let revision = store::credential_revision(&id).await.unwrap();
        endpoint.release.notify_one();
        recovery.await.unwrap().unwrap();
        assert_eq!(store::credential_revision(&id).await.unwrap(), revision);
        assert!(!store::load_with_state()
            .await
            .unwrap()
            .requires_reauthentication
            .contains(&id));
        assert!(
            matches!(store::load_entry(&id).await.unwrap(), Some(crate::subscription_auth::StoredCredential::Oauth { access, .. }) if access == "new-login-access")
        );
    }

    #[tokio::test]
    async fn rejected_token_recovery_cannot_commit_a_different_seat_returned_by_oauth() {
        use crate::subscription_auth::{store, tests, SubscriptionHttpOptions};
        use base64::{engine::general_purpose::URL_SAFE_NO_PAD, Engine as _};
        let _guard = tests::test_lock().lock().await;
        for id in [
            "codex".into(),
            format!("codex-account-{}", uuid::Uuid::new_v4()),
        ] {
            store::set_store_path_for_test(tests::temp_store_path());
            let revision = recovery_account(&id, "seat-one").await;
            let id_token = format!("header.{}.signature", URL_SAFE_NO_PAD.encode(serde_json::to_vec(&serde_json::json!({"https://api.openai.com/auth":{"chatgpt_account_id":"wrong-seat"}})).unwrap()));
            let endpoint = RecoveryEndpoint::with_reply(false, 200, serde_json::json!({"access_token":"wrong-access", "refresh_token":"wrong-refresh", "id_token":id_token, "expires_in":3600})).await;
            assert!(super::recover_rejected_account_at(
                &id,
                "rejected-access",
                Some("seat-one"),
                &SubscriptionHttpOptions::default(),
                &endpoint.url
            )
            .await
            .is_err());
            assert_eq!(store::credential_revision(&id).await.unwrap(), revision);
            assert!(
                matches!(store::load_entry(&id).await.unwrap(), Some(crate::subscription_auth::StoredCredential::Oauth { access, .. }) if access == "rejected-access")
            );
        }
    }

    #[tokio::test]
    async fn failed_reauthentication_marker_commit_preserves_epoch_metadata_and_credentials() {
        use crate::subscription_auth::{store, tests, SubscriptionHttpOptions};
        let _guard = tests::test_lock().lock().await;
        let path = tests::temp_store_path();
        store::set_store_path_for_test(path.clone());
        let id = format!("codex-account-{}", uuid::Uuid::new_v4());
        let revision = recovery_account(&id, "seat-one").await;
        let before = std::fs::read(&path).unwrap();
        let endpoint =
            RecoveryEndpoint::with_reply(false, 400, serde_json::json!({"error":"invalid_grant"}))
                .await;
        store::set_test_metadata_write_failure(true);
        let result = super::recover_rejected_account_at(
            &id,
            "rejected-access",
            Some("seat-one"),
            &SubscriptionHttpOptions::default(),
            &endpoint.url,
        )
        .await;
        store::set_test_metadata_write_failure(false);
        assert!(result.is_err());
        assert_eq!(std::fs::read(&path).unwrap(), before);
        assert_eq!(store::credential_revision(&id).await.unwrap(), revision);
        assert!(
            matches!(store::load_entry(&id).await.unwrap(), Some(crate::subscription_auth::StoredCredential::Oauth { access, .. }) if access == "rejected-access")
        );
    }

    #[tokio::test]
    async fn reauthentication_cannot_replace_a_named_account_with_another_seat() {
        use super::{persist_tokens, TokenResponse};
        use crate::subscription_auth::{store, tests, StoredCredential};
        use base64::{engine::general_purpose::URL_SAFE_NO_PAD, Engine as _};
        let _guard = tests::test_lock().lock().await;
        let path = tests::temp_store_path();
        store::set_store_path_for_test(path.clone());
        let slot = format!("codex-account-{}", uuid::Uuid::new_v4());
        let tokens = |seat: &str, access: &str| {
            TokenResponse {
            id_token: Some(format!("header.{}.signature", URL_SAFE_NO_PAD.encode(
                serde_json::to_vec(&serde_json::json!({"https://api.openai.com/auth":{"chatgpt_account_id":seat},"email":"same-email@example.com"})).unwrap()
            ))),
            access_token: Some(access.to_string()),
            refresh_token: Some(format!("refresh-{access}")),
            expires_in: Some(3600),
        }
        };
        persist_tokens(&slot, tokens("seat-one", "first"), 0)
            .await
            .unwrap();
        let revision = store::credential_revision(&slot).await.unwrap();
        assert!(
            persist_tokens(&slot, tokens("seat-two", "wrong-seat"), revision)
                .await
                .is_err()
        );
        assert_eq!(store::credential_revision(&slot).await.unwrap(), revision);
        assert!(
            matches!(store::load_entry(&slot).await.unwrap(), Some(StoredCredential::Oauth { access, .. }) if access == "first")
        );
        // A lost vault secret does not erase the committed seat identity.
        let mut metadata: serde_json::Value =
            serde_json::from_slice(&std::fs::read(&path).unwrap()).unwrap();
        metadata["accounts"][&slot]["needs_reauthentication"] = serde_json::json!(true);
        std::fs::write(&path, serde_json::to_vec(&metadata).unwrap()).unwrap();
        assert!(store::load_entry(&slot).await.unwrap().is_none());
        assert!(persist_tokens(
            &slot,
            tokens("seat-two", "wrong-seat-without-vault"),
            revision
        )
        .await
        .is_err());
        assert_eq!(store::credential_revision(&slot).await.unwrap(), revision);
        persist_tokens(&slot, tokens("seat-one", "renewed"), revision)
            .await
            .unwrap();
        assert!(
            matches!(store::load_entry(&slot).await.unwrap(), Some(StoredCredential::Oauth { access, .. }) if access == "renewed")
        );
        assert!(store::load_entry("codex").await.unwrap().is_none());
        let revision = store::credential_revision(&slot).await.unwrap();
        crate::subscription_auth::logout_account(
            crate::subscription_auth::SubscriptionProvider::Codex,
            &slot,
        )
        .await
        .unwrap();
        assert!(persist_tokens(&slot, tokens("seat-one", "stale"), revision)
            .await
            .is_err());
        assert!(store::load_entry(&slot).await.unwrap().is_none());
        let revision = store::credential_revision(&slot).await.unwrap();
        assert!(
            persist_tokens(&slot, tokens("seat-two", "wrong-after-logout"), revision)
                .await
                .is_err()
        );
        persist_tokens(&slot, tokens("seat-one", "reauthorized"), revision)
            .await
            .unwrap();
        assert!(
            matches!(store::load_entry(&slot).await.unwrap(), Some(StoredCredential::Oauth { access, .. }) if access == "reauthorized")
        );
    }

    #[test]
    fn uses_registered_localhost_redirect_uri() {
        let primary_redirect_uri = redirect_uri(CALLBACK_PORT);
        assert_eq!(primary_redirect_uri, "http://localhost:1455/auth/callback");

        let authorize_url = build_authorize_url(&Pkce::generate(), "state", &primary_redirect_uri);
        assert!(
            authorize_url.contains("redirect_uri=http%3A%2F%2Flocalhost%3A1455%2Fauth%2Fcallback")
        );
    }

    #[test]
    fn matches_opencode_device_polling_and_current_default_model() {
        assert_eq!(device_poll_interval(&serde_json::json!("5")), 5);
        assert_eq!(device_poll_interval(&serde_json::json!(2)), 2);
        assert_eq!(device_poll_interval(&serde_json::json!(0)), 5);
        assert_eq!(DEFAULT_MODEL, "gpt-5.5");
        assert!(
            build_authorize_url(&Pkce::generate(), "state", &redirect_uri(CALLBACK_PORT))
                .contains("originator=openbitfun")
        );
        assert!(user_agent().starts_with("OpenBitFun/"));
    }
}
