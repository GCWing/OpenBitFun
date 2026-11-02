//! Hermes (Nous Portal) subscription login and credential resolution.
//!
//! Authentication follows Hermes Agent's OAuth 2.0 device-code flow. The
//! access token is an inference-scoped JWT and the refresh token rotates on
//! every use. Runtime requests are pinned to Nous Research's trusted
//! inference host using OpenAI Chat Completions, including `anthropic/*`.
//! Hermes defaults to this wire while the Portal native Messages cache issue
//! is unresolved (hermes_cli/providers.py, upstream 2026-09-08).

use super::device_flow::{poll_device_code, DevicePoll};
use super::jwt;
use super::store::{self, StoredCredential};
use super::{ResolvedCredential, StartedLogin, SubscriptionHttpOptions};
use anyhow::{anyhow, Context, Result};
use serde::Deserialize;
use std::collections::{HashMap, HashSet};
use std::time::Duration;
use tokio_util::sync::CancellationToken;

const DEVICE_CODE_URL: &str = "https://portal.nousresearch.com/api/oauth/device/code";
const TOKEN_URL: &str = "https://portal.nousresearch.com/api/oauth/token";
const CLIENT_ID: &str = "hermes-cli";
const DEVICE_CODE_GRANT_TYPE: &str = "urn:ietf:params:oauth:grant-type:device_code";
const INFERENCE_SCOPE: &str = "inference:invoke";
const INFERENCE_BASE_URL: &str = "https://inference-api.nousresearch.com/v1";
const INFERENCE_HOST: &str = "inference-api.nousresearch.com";
const PORTAL_HOST: &str = "portal.nousresearch.com";
const DEFAULT_MODEL: &str = "z-ai/glm-5.2";
const STORE_KEY: &str = "hermes";
const DEFAULT_TOKEN_LIFETIME_SECS: i64 = 60 * 60;
const DEFAULT_DEVICE_LIFETIME_SECS: i64 = 5 * 60;
const DEFAULT_POLL_INTERVAL_SECS: i64 = 5;
const REFRESH_LEEWAY_MS: i64 = 2 * 60 * 1000;

pub(crate) const MANAGEMENT_URL: &str = "https://portal.nousresearch.com/manage-subscription";

#[derive(Debug, Deserialize)]
struct DeviceCodeResponse {
    device_code: String,
    user_code: String,
    verification_uri: String,
    verification_uri_complete: String,
    #[serde(default, deserialize_with = "deserialize_optional_i64")]
    expires_in: Option<i64>,
    #[serde(default, deserialize_with = "deserialize_optional_i64")]
    interval: Option<i64>,
}

#[derive(Debug, Deserialize)]
struct TokenResponse {
    access_token: String,
    #[serde(default)]
    refresh_token: Option<String>,
    #[serde(default, deserialize_with = "deserialize_optional_i64")]
    expires_in: Option<i64>,
    #[serde(default)]
    token_type: Option<String>,
    #[serde(default)]
    scope: Option<String>,
    #[serde(default)]
    inference_base_url: Option<String>,
}

#[derive(Debug, Default, Deserialize)]
struct TokenErrorResponse {
    #[serde(default)]
    error: String,
    #[serde(default)]
    error_description: Option<String>,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
struct HermesRoute {
    format: &'static str,
    suffix: &'static str,
}

fn deserialize_optional_i64<'de, D>(deserializer: D) -> std::result::Result<Option<i64>, D::Error>
where
    D: serde::Deserializer<'de>,
{
    let value = Option::<serde_json::Value>::deserialize(deserializer)?;
    Ok(value.and_then(|value| match value {
        serde_json::Value::Number(number) => number.as_i64(),
        serde_json::Value::String(string) => string.parse::<i64>().ok(),
        _ => None,
    }))
}

fn http_client(options: &SubscriptionHttpOptions) -> Result<reqwest::Client> {
    super::build_http_client(options, "Hermes (Nous Portal)")
}

fn now_ms() -> i64 {
    chrono::Utc::now().timestamp_millis()
}

fn positive_seconds(value: Option<i64>, fallback: i64) -> i64 {
    value.filter(|value| *value > 0).unwrap_or(fallback)
}

fn expires_at_ms(tokens: &TokenResponse) -> i64 {
    jwt::expires_at_ms(&tokens.access_token).unwrap_or_else(|| {
        now_ms().saturating_add(
            positive_seconds(tokens.expires_in, DEFAULT_TOKEN_LIFETIME_SECS).saturating_mul(1000),
        )
    })
}

fn parse_scope(raw: Option<&str>) -> HashSet<String> {
    raw.unwrap_or_default()
        .replace(',', " ")
        .split_whitespace()
        .map(str::to_string)
        .collect()
}

fn validate_access_token(access: &str, scope: Option<&str>, expires: i64) -> Result<()> {
    if access.split('.').count() != 3 || jwt::decode_claims(access).is_none() {
        return Err(anyhow!(
            "Nous Portal access token is not an inference JWT; sign in again"
        ));
    }
    let mut scopes = parse_scope(scope);
    scopes.extend(jwt::scopes(access));
    if !scopes.contains(INFERENCE_SCOPE) {
        return Err(anyhow!(
            "Nous Portal access token is missing the {INFERENCE_SCOPE} scope; activate a subscription at {MANAGEMENT_URL} and sign in again"
        ));
    }
    let now = now_ms();
    if expires <= now.saturating_add(REFRESH_LEEWAY_MS)
        || jwt::expires_within(access, now, REFRESH_LEEWAY_MS)
    {
        return Err(anyhow!(
            "Nous Portal inference token is expired or too close to expiry"
        ));
    }
    Ok(())
}

fn validate_user_code(code: &str) -> Result<()> {
    if code.is_empty()
        || !code
            .chars()
            .all(|character| character.is_ascii_alphanumeric() || character == '-')
    {
        return Err(anyhow!(
            "Nous Portal returned an invalid device authorization code"
        ));
    }
    Ok(())
}

fn validate_portal_url(url: &str) -> Result<()> {
    if url.chars().any(|character| character.is_ascii_control()) {
        return Err(anyhow!(
            "Nous Portal returned an invalid device verification URL"
        ));
    }
    let parsed = reqwest::Url::parse(url)
        .map_err(|_| anyhow!("Nous Portal returned an invalid device verification URL"))?;
    if parsed.scheme() != "https" || parsed.host_str() != Some(PORTAL_HOST) {
        return Err(anyhow!(
            "Nous Portal returned an untrusted device verification URL"
        ));
    }
    Ok(())
}

/// Accepts only the production Nous inference origin for a network-provided
/// routing value. A missing or poisoned value heals to the official default.
fn validate_inference_base_url(url: Option<&str>) -> Option<String> {
    let raw = url?.trim().trim_end_matches('/');
    if raw.is_empty() || raw.chars().any(|character| character.is_ascii_control()) {
        return None;
    }
    let parsed = reqwest::Url::parse(raw).ok()?;
    if parsed.scheme() != "https" || parsed.host_str() != Some(INFERENCE_HOST) {
        return None;
    }
    Some(raw.to_string())
}

fn effective_inference_base_url(metadata: Option<&serde_json::Value>) -> String {
    metadata
        .and_then(|value| value.get("inference_base_url"))
        .and_then(serde_json::Value::as_str)
        .and_then(|url| validate_inference_base_url(Some(url)))
        .unwrap_or_else(|| INFERENCE_BASE_URL.to_string())
}

fn metadata_scope(metadata: Option<&serde_json::Value>) -> Option<&str> {
    metadata
        .and_then(|value| value.get("scope"))
        .and_then(serde_json::Value::as_str)
}

fn metadata_from(tokens: &TokenResponse, previous: Option<serde_json::Value>) -> serde_json::Value {
    let previous_scope = metadata_scope(previous.as_ref()).map(str::to_string);
    let mut object = previous
        .and_then(|value| value.as_object().cloned())
        .unwrap_or_default();

    if let Some(email) = jwt::email(&tokens.access_token) {
        object.insert("email".to_string(), serde_json::Value::String(email));
    }
    if let Some(scope) = tokens
        .scope
        .as_deref()
        .filter(|scope| !scope.trim().is_empty())
        .map(str::to_string)
        .or(previous_scope)
    {
        object.insert("scope".to_string(), serde_json::Value::String(scope));
    }
    if let Some(token_type) = tokens
        .token_type
        .as_deref()
        .filter(|token_type| !token_type.trim().is_empty())
    {
        object.insert(
            "token_type".to_string(),
            serde_json::Value::String(token_type.to_string()),
        );
    }
    let inference_base_url = validate_inference_base_url(tokens.inference_base_url.as_deref())
        .unwrap_or_else(|| INFERENCE_BASE_URL.to_string());
    object.insert(
        "inference_base_url".to_string(),
        serde_json::Value::String(inference_base_url),
    );
    serde_json::Value::Object(object)
}

async fn request_device_code(client: &reqwest::Client) -> Result<DeviceCodeResponse> {
    let response = client
        .post(DEVICE_CODE_URL)
        .header(reqwest::header::ACCEPT, "application/json")
        .form(&[("client_id", CLIENT_ID), ("scope", INFERENCE_SCOPE)])
        .send()
        .await
        .context("call Nous Portal device code endpoint")?;
    if !response.status().is_success() {
        let status = response.status();
        let body = response.text().await.unwrap_or_default();
        return Err(anyhow!(
            "Nous Portal device authorization failed: HTTP {status}: {body}"
        ));
    }
    let device = response
        .json::<DeviceCodeResponse>()
        .await
        .context("parse Nous Portal device authorization response")?;
    if device.device_code.trim().is_empty() {
        return Err(anyhow!(
            "Nous Portal device authorization response missing device_code"
        ));
    }
    validate_user_code(&device.user_code)?;
    validate_portal_url(&device.verification_uri)?;
    validate_portal_url(&device.verification_uri_complete)?;
    Ok(device)
}

fn classify_device_poll_error(
    status: reqwest::StatusCode,
    error: &TokenErrorResponse,
) -> Result<DevicePoll<TokenResponse>> {
    match error.error.as_str() {
        "authorization_pending" => Ok(DevicePoll::Pending),
        "slow_down" => Ok(DevicePoll::SlowDown),
        "access_denied" | "authorization_denied" => {
            Err(anyhow!("Nous Portal device authorization was denied"))
        }
        "expired_token" => Err(anyhow!("Nous Portal device authorization code expired")),
        _ => {
            let detail = error
                .error_description
                .as_deref()
                .filter(|detail| !detail.trim().is_empty())
                .unwrap_or_else(|| {
                    if error.error.is_empty() {
                        "unrecognized response"
                    } else {
                        &error.error
                    }
                });
            Err(anyhow!(
                "Nous Portal device token exchange failed: HTTP {status}: {detail}"
            ))
        }
    }
}

async fn poll_once(
    client: &reqwest::Client,
    device_code: &str,
) -> Result<DevicePoll<TokenResponse>> {
    let response = client
        .post(TOKEN_URL)
        .header(reqwest::header::ACCEPT, "application/json")
        .form(&[
            ("grant_type", DEVICE_CODE_GRANT_TYPE),
            ("client_id", CLIENT_ID),
            ("device_code", device_code),
        ])
        .send()
        .await
        .context("call Nous Portal device token endpoint")?;
    let status = response.status();
    let body = response.text().await.unwrap_or_default();
    if status.is_success() {
        let tokens = serde_json::from_str::<TokenResponse>(&body)
            .context("parse Nous Portal token response")?;
        return Ok(DevicePoll::Authorized(tokens));
    }
    let error = serde_json::from_str::<TokenErrorResponse>(&body).unwrap_or_default();
    classify_device_poll_error(status, &error)
}

async fn persist_tokens_for_account(
    slot: &str,
    tokens: TokenResponse,
    expected_revision: u64,
) -> Result<()> {
    if tokens.access_token.trim().is_empty() {
        return Err(anyhow!("Nous Portal token response missing access_token"));
    }
    let refresh = tokens
        .refresh_token
        .clone()
        .filter(|token| !token.trim().is_empty())
        .ok_or_else(|| anyhow!("Nous Portal token response missing refresh_token"))?;
    let expires = expires_at_ms(&tokens);
    validate_access_token(&tokens.access_token, tokens.scope.as_deref(), expires)?;
    let account_id = jwt::subject(&tokens.access_token);
    let metadata = Some(metadata_from(&tokens, None));
    let outcome = super::accounts::persist_account_credential(
        super::SubscriptionProvider::Hermes,
        slot,
        expected_revision,
        StoredCredential::Oauth {
            refresh,
            access: tokens.access_token,
            expires,
            account_id,
            metadata,
        },
    )
    .await?;
    super::require_current_store_revision(super::SubscriptionProvider::Hermes, outcome)?;
    log::info!("Hermes subscription tokens saved");
    Ok(())
}

fn refresh_request(client: &reqwest::Client, refresh_token: &str) -> reqwest::RequestBuilder {
    client
        .post(TOKEN_URL)
        .header(reqwest::header::ACCEPT, "application/json")
        .header("x-nous-refresh-token", refresh_token)
        .form(&[("grant_type", "refresh_token"), ("client_id", CLIENT_ID)])
}

async fn refresh(refresh_token: &str, options: &SubscriptionHttpOptions) -> Result<TokenResponse> {
    let client = http_client(options)?;
    let response = refresh_request(&client, refresh_token)
        .send()
        .await
        .context("call Nous Portal token refresh endpoint")?;
    let status = response.status();
    let body = response.text().await.unwrap_or_default();
    if status.is_success() {
        return serde_json::from_str::<TokenResponse>(&body)
            .context("parse Nous Portal token refresh response");
    }
    let error = serde_json::from_str::<TokenErrorResponse>(&body).unwrap_or_default();
    let detail = error
        .error_description
        .as_deref()
        .filter(|detail| !detail.trim().is_empty())
        .or_else(|| (!error.error.is_empty()).then_some(error.error.as_str()))
        .unwrap_or("unrecognized response");
    if error.error == "refresh_token_reused" || detail.to_ascii_lowercase().contains("reuse") {
        return Err(anyhow!(
            "Nous Portal rejected a reused refresh token and revoked this session; sign in again"
        ));
    }
    Err(anyhow!(
        "Nous Portal token refresh failed: HTTP {status}: {detail}"
    ))
}

/// Starts the Nous Portal device-code flow. It works when the browser and the
/// OpenBitFun execution host are on different machines.
pub(crate) async fn begin_login_for_account(
    slot: String,
    cancel: CancellationToken,
    expected_revision: u64,
    options: SubscriptionHttpOptions,
) -> Result<StartedLogin> {
    let client = http_client(&options)?;
    let device = request_device_code(&client).await?;
    let interval = positive_seconds(device.interval, DEFAULT_POLL_INTERVAL_SECS);
    let expires_in = positive_seconds(device.expires_in, DEFAULT_DEVICE_LIFETIME_SECS)
        .min(super::LOGIN_TIMEOUT.as_secs() as i64);
    let device_code = device.device_code.clone();
    let user_code = device.user_code.clone();
    let authorization_url = device.verification_uri_complete.clone();

    let runner = async move {
        super::authorize_then_persist(
            super::SubscriptionProvider::Hermes,
            cancel,
            async {
                poll_device_code(
                    Duration::from_secs(interval as u64),
                    Duration::from_secs(expires_in as u64),
                    Duration::ZERO,
                    true,
                    || poll_once(&client, &device_code),
                )
                .await
                .context("complete Nous Portal device authorization")
            },
            move |tokens| async move {
                persist_tokens_for_account(&slot, tokens, expected_revision).await
            },
        )
        .await
    };

    Ok(StartedLogin {
        method: super::SubscriptionLoginMethod::Device,
        authorization_url,
        user_code: Some(user_code),
        instructions:
            "Open the Nous Portal verification link on any device, approve the code, then return to OpenBitFun."
                .to_string(),
        runner: Box::pin(runner),
    })
}

fn stored_credential_is_usable(
    access: &str,
    expires: i64,
    metadata: Option<&serde_json::Value>,
) -> bool {
    validate_access_token(access, metadata_scope(metadata), expires).is_ok()
}

async fn ensure_fresh_for_account(
    slot: &str,
    rejected_access: Option<&str>,
    options: &SubscriptionHttpOptions,
) -> Result<(String, i64, String)> {
    let (slot, rejected_access, options) = (
        slot.to_owned(),
        rejected_access.map(str::to_owned),
        options.clone(),
    );
    super::complete_credential_refresh(async move {
        ensure_fresh_in_account(&slot, rejected_access.as_deref(), &options).await
    })
    .await
}

async fn ensure_fresh_in_account(
    slot: &str,
    rejected_access: Option<&str>,
    options: &SubscriptionHttpOptions,
) -> Result<(String, i64, String)> {
    // Nous refresh tokens rotate after one use. Collapse concurrent refreshes
    // across OpenBitFun processes before reading the latest durable revision.
    let _refresh_lease = store::acquire_provider_refresh_lease(slot).await?;
    let snapshot = store::load_entry_with_revision(slot).await?;
    let entry = snapshot
        .credential
        .ok_or_else(|| anyhow!("Hermes is not connected; sign in first"))?;
    let StoredCredential::Oauth {
        refresh: refresh_token,
        access,
        expires,
        account_id,
        metadata,
    } = entry
    else {
        return Err(anyhow!("Hermes credential is not an OAuth login"));
    };

    if rejected_access != Some(access.as_str())
        && stored_credential_is_usable(&access, expires, metadata.as_ref())
    {
        return Ok((
            access,
            expires,
            effective_inference_base_url(metadata.as_ref()),
        ));
    }

    let refreshed = match refresh(&refresh_token, options).await {
        Ok(tokens) => tokens,
        Err(error) => {
            // A different OpenBitFun process may have rotated and committed first.
            // Prefer its newer usable credential over a stale refresh error.
            if let Ok(current) = store::load_entry_with_revision(slot).await {
                if current.revision != snapshot.revision {
                    if let Some(StoredCredential::Oauth {
                        access,
                        expires,
                        metadata,
                        ..
                    }) = current.credential
                    {
                        if stored_credential_is_usable(&access, expires, metadata.as_ref()) {
                            return Ok((
                                access,
                                expires,
                                effective_inference_base_url(metadata.as_ref()),
                            ));
                        }
                    }
                }
            }
            return Err(error);
        }
    };
    if refreshed.access_token.trim().is_empty() {
        return Err(anyhow!(
            "Nous Portal token refresh response missing access_token"
        ));
    }
    let new_refresh = refreshed
        .refresh_token
        .clone()
        .filter(|token| !token.trim().is_empty())
        .unwrap_or(refresh_token);
    let new_access = refreshed.access_token.clone();
    let new_expires = expires_at_ms(&refreshed);
    let new_account_id = jwt::subject(&new_access).or(account_id);
    let new_metadata = Some(metadata_from(&refreshed, metadata));
    let inference_base_url = effective_inference_base_url(new_metadata.as_ref());

    // Commit the rotated refresh token before validating the new access JWT.
    // The previous refresh token is already consumed once the server replies.
    let outcome = super::accounts::persist_account_credential(
        super::SubscriptionProvider::Hermes,
        slot,
        snapshot.revision,
        StoredCredential::Oauth {
            refresh: new_refresh,
            access: new_access.clone(),
            expires: new_expires,
            account_id: new_account_id,
            metadata: new_metadata.clone(),
        },
    )
    .await?;
    match outcome {
        store::ConditionalCommitOutcome::Committed { .. } => {
            validate_access_token(
                &new_access,
                metadata_scope(new_metadata.as_ref()),
                new_expires,
            )?;
            log::info!("Hermes subscription tokens refreshed");
            Ok((new_access, new_expires, inference_base_url))
        }
        store::ConditionalCommitOutcome::Conflict { current_revision } => {
            let current = super::load_account_store_after_conflict(
                super::SubscriptionProvider::Hermes,
                slot,
                current_revision,
            )
            .await?;
            match current.credential {
                Some(StoredCredential::Oauth {
                    access,
                    expires,
                    metadata,
                    ..
                }) if stored_credential_is_usable(&access, expires, metadata.as_ref()) => Ok((
                    access,
                    expires,
                    effective_inference_base_url(metadata.as_ref()),
                )),
                _ => Err(super::store_revision_conflict(
                    super::SubscriptionProvider::Hermes,
                    current_revision,
                )),
            }
        }
    }
}

fn route_for(_model: &str) -> HermesRoute {
    // Hermes currently uses chat even for anthropic/*: concurrent native
    // Messages calls can rewrite the previous prompt-cache breakpoint.
    HermesRoute {
        format: "openai",
        suffix: "chat/completions",
    }
}

fn request_url(base_url: &str, route: HermesRoute) -> String {
    format!("{}/{}", base_url.trim_end_matches('/'), route.suffix)
}

/// Resolves the runtime credential and pins it to the model-derived Nous API
/// route. The selected catalog model remains unchanged in the request body.
pub(crate) async fn resolve_for_account(
    slot: &str,
    model: &str,
    options: &SubscriptionHttpOptions,
) -> Result<ResolvedCredential> {
    let (access, expires, base_url) = ensure_fresh_for_account(slot, None, options).await?;
    let route = route_for(model);
    Ok(ResolvedCredential {
        api_key: access,
        base_url: Some(base_url.clone()),
        request_url: Some(request_url(&base_url, route)),
        format: Some(route.format.to_string()),
        extra_headers: HashMap::new(),
        expires_at: Some(expires / 1000),
    })
}

pub(crate) async fn resolve(options: &SubscriptionHttpOptions) -> Result<ResolvedCredential> {
    resolve_for(DEFAULT_MODEL, options).await
}

/// Provider metadata used to seed a new model entry. The fallback model is the
/// cost-safe offline default used by current Hermes rather than the catalog's
/// most expensive first entry.
pub(crate) fn suggested() -> (&'static str, &'static str, &'static str) {
    ("openai", INFERENCE_BASE_URL, DEFAULT_MODEL)
}

pub(crate) async fn resolve_for(
    model: &str,
    options: &SubscriptionHttpOptions,
) -> Result<ResolvedCredential> {
    resolve_for_account(STORE_KEY, model, options).await
}

pub(crate) async fn recover_rejected_account(
    slot: &str,
    rejected_access: &str,
    options: &SubscriptionHttpOptions,
) -> Result<()> {
    ensure_fresh_for_account(slot, Some(rejected_access), options).await?;
    Ok(())
}
#[cfg(test)]
mod tests {
    use super::*;
    use base64::{engine::general_purpose::URL_SAFE_NO_PAD, Engine as _};

    fn make_token(payload: serde_json::Value) -> String {
        let header = URL_SAFE_NO_PAD.encode(b"{\"alg\":\"none\"}");
        let body = URL_SAFE_NO_PAD.encode(serde_json::to_vec(&payload).unwrap());
        format!("{header}.{body}.sig")
    }

    #[test]
    fn pins_portal_and_inference_urls_to_nous_hosts() {
        validate_portal_url("https://portal.nousresearch.com/device?code=ABCD").unwrap();
        assert!(validate_portal_url("https://portal.nousresearch.com.evil.test/device").is_err());
        assert!(validate_portal_url("http://portal.nousresearch.com/device").is_err());

        assert_eq!(
            validate_inference_base_url(Some("https://inference-api.nousresearch.com/v1/"))
                .as_deref(),
            Some("https://inference-api.nousresearch.com/v1")
        );
        assert_eq!(
            validate_inference_base_url(Some("https://attacker.test/v1")),
            None
        );
        assert_eq!(
            validate_inference_base_url(Some("http://inference-api.nousresearch.com/v1")),
            None
        );
    }

    #[test]
    fn requires_an_unexpired_inference_scoped_jwt() {
        let future = chrono::Utc::now().timestamp() + 3600;
        let scoped = make_token(serde_json::json!({
            "sub": "user_123",
            "exp": future,
            "scp": ["inference:invoke"]
        }));
        validate_access_token(&scoped, None, future * 1000).unwrap();

        let unscoped = make_token(serde_json::json!({ "exp": future }));
        assert!(validate_access_token(&unscoped, None, future * 1000).is_err());
        assert!(validate_access_token("opaque", Some(INFERENCE_SCOPE), future * 1000).is_err());
    }

    #[test]
    fn refresh_uses_the_portal_header_without_a_token_in_the_form() {
        let client = http_client(&SubscriptionHttpOptions::default()).unwrap();
        let request = refresh_request(&client, "synthetic-refresh")
            .build()
            .unwrap();
        assert_eq!(request.url().as_str(), TOKEN_URL);
        assert_eq!(request.method(), reqwest::Method::POST);
        assert_eq!(request.headers()["accept"], "application/json");
        assert_eq!(
            request.headers()["x-nous-refresh-token"],
            "synthetic-refresh"
        );
        assert_eq!(
            request.headers()["content-type"],
            "application/x-www-form-urlencoded"
        );
        let body = std::str::from_utf8(request.body().unwrap().as_bytes().unwrap()).unwrap();
        assert_eq!(body, "grant_type=refresh_token&client_id=hermes-cli");
        assert!(!body.contains("synthetic-refresh"));
    }

    #[test]
    fn defaults_to_chat_for_all_portal_catalog_ids() {
        let anthropic = route_for("anthropic/claude-sonnet-5");
        assert_eq!(anthropic.format, "openai");
        assert_eq!(
            request_url(INFERENCE_BASE_URL, anthropic),
            "https://inference-api.nousresearch.com/v1/chat/completions"
        );

        let openai = route_for("openai/gpt-5.6-sol");
        assert_eq!(openai.format, "openai");
        assert_eq!(
            request_url(INFERENCE_BASE_URL, openai),
            "https://inference-api.nousresearch.com/v1/chat/completions"
        );
        assert_eq!(suggested().2, "z-ai/glm-5.2");
        assert_eq!(
            MANAGEMENT_URL,
            "https://portal.nousresearch.com/manage-subscription"
        );
    }

    #[test]
    fn handles_rfc_8628_terminal_device_errors() {
        let denied = TokenErrorResponse {
            error: "access_denied".to_string(),
            error_description: None,
        };
        let Err(error) = classify_device_poll_error(reqwest::StatusCode::BAD_REQUEST, &denied)
        else {
            panic!("access_denied must be terminal");
        };
        assert!(error.to_string().contains("denied"));

        let pending = TokenErrorResponse {
            error: "authorization_pending".to_string(),
            error_description: None,
        };
        assert!(matches!(
            classify_device_poll_error(reqwest::StatusCode::BAD_REQUEST, &pending).unwrap(),
            DevicePoll::Pending
        ));
    }
}
