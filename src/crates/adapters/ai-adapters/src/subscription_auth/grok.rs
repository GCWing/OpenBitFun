//! xAI (SuperGrok) account login and credential resolution.
//!
//! Authentication uses xAI's public Grok CLI OAuth client with the RFC 8628
//! device flow. Subscription models and inference use Grok Build's authenticated
//! proxy; the public api.x.ai service is a separate API-key product.

use super::device_flow::{poll_device_code, DevicePoll};
use super::jwt;
use super::store::{self, StoredCredential};
use super::{ResolvedCredential, StartedLogin, SubscriptionHttpOptions};
use anyhow::{anyhow, Context, Result};
use serde::Deserialize;
use std::collections::HashMap;
use std::time::Duration;
use tokio_util::sync::CancellationToken;

const CLIENT_ID: &str = "b1a00492-073a-47ea-816f-4c329264a828";
const DEVICE_AUTHORIZATION_URL: &str = "https://auth.x.ai/oauth2/device/code";
const TOKEN_URL: &str = "https://auth.x.ai/oauth2/token";
const DEVICE_CODE_GRANT_TYPE: &str = "urn:ietf:params:oauth:grant-type:device_code";
const SCOPE: &str = "openid profile email offline_access grok-cli:access api:access";
const XAI_BASE_URL: &str = "https://cli-chat-proxy.grok.com/v1";
const XAI_REQUEST_URL: &str = "https://cli-chat-proxy.grok.com/v1/responses";
const DEFAULT_MODEL: &str = "grok-4.7";
const GROK_CLIENT_VERSION: &str = "1.0.41";
const STORE_KEY: &str = "grok";
const DEFAULT_TOKEN_LIFETIME_SECS: i64 = 60 * 60;
const DEFAULT_DEVICE_LIFETIME_SECS: i64 = 5 * 60;
const DEFAULT_POLL_INTERVAL_SECS: i64 = 5;
const SHORT_TOKEN_REFRESH_LEEWAY_MS: i64 = 2 * 60 * 1000;
const LONG_TOKEN_REFRESH_LEEWAY_MS: i64 = 60 * 60 * 1000;
const SHORT_TOKEN_THRESHOLD_MS: i64 = 45 * 60 * 1000;

#[derive(Debug, Deserialize)]
struct DeviceCodeResponse {
    device_code: String,
    user_code: String,
    verification_uri: String,
    #[serde(default)]
    verification_uri_complete: Option<String>,
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
    #[serde(default)]
    id_token: Option<String>,
    #[serde(default, deserialize_with = "deserialize_optional_i64")]
    expires_in: Option<i64>,
}

#[derive(Debug, Default, Deserialize)]
struct TokenErrorResponse {
    #[serde(default)]
    error: String,
    #[serde(default)]
    error_description: Option<String>,
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
    super::build_http_client(options, "xAI (SuperGrok)")
}

fn now_ms() -> i64 {
    chrono::Utc::now().timestamp_millis()
}

fn positive_seconds(value: Option<i64>, fallback: i64) -> i64 {
    value.filter(|value| *value > 0).unwrap_or(fallback)
}

fn expires_at_ms(expires_in: Option<i64>) -> i64 {
    now_ms().saturating_add(
        positive_seconds(expires_in, DEFAULT_TOKEN_LIFETIME_SECS).saturating_mul(1000),
    )
}

/// Current Hermes keeps a one-hour gateway safety window for multi-hour
/// SuperGrok sessions, but drops to two minutes for the short JWTs commonly
/// returned by device-code login so each request does not consume a rotating
/// refresh token.
fn refresh_leeway_ms(access: &str, stored_expires: i64, now: i64) -> i64 {
    let effective_expires = jwt::expires_at_ms(access).unwrap_or(stored_expires);
    let remaining = effective_expires.saturating_sub(now);
    if remaining > 0 && remaining <= SHORT_TOKEN_THRESHOLD_MS {
        SHORT_TOKEN_REFRESH_LEEWAY_MS
    } else {
        LONG_TOKEN_REFRESH_LEEWAY_MS
    }
}

fn opencode_user_agent() -> String {
    format!("opencode/{}", super::OPENCODE_COMPAT_VERSION)
}

fn oauth_request(builder: reqwest::RequestBuilder) -> reqwest::RequestBuilder {
    builder
        .header(reqwest::header::ACCEPT, "application/json")
        .header(reqwest::header::USER_AGENT, opencode_user_agent())
}

fn validate_user_code(code: &str) -> Result<()> {
    if code.is_empty()
        || !code
            .chars()
            .all(|character| character.is_ascii_alphanumeric() || character == '-')
    {
        return Err(anyhow!("xAI returned an invalid device authorization code"));
    }
    Ok(())
}

fn validate_verification_url(url: &str) -> Result<()> {
    if url.chars().any(|character| character.is_ascii_control()) {
        return Err(anyhow!("xAI returned an invalid device verification URL"));
    }
    let parsed = reqwest::Url::parse(url)
        .map_err(|_| anyhow!("xAI returned an invalid device verification URL"))?;
    if parsed.scheme() != "https" || parsed.host_str().is_none() {
        return Err(anyhow!(
            "xAI returned an unsupported device verification URL"
        ));
    }
    Ok(())
}

async fn request_device_code(options: &SubscriptionHttpOptions) -> Result<DeviceCodeResponse> {
    let client = http_client(options)?;
    let response = oauth_request(client.post(DEVICE_AUTHORIZATION_URL))
        .form(&[
            ("client_id", CLIENT_ID),
            ("scope", SCOPE),
            ("referrer", "opencode"),
        ])
        .send()
        .await
        .context("call xAI device code endpoint")?;
    if !response.status().is_success() {
        let status = response.status();
        let body = response.text().await.unwrap_or_default();
        return Err(anyhow!(
            "xAI device authorization failed: HTTP {status}: {body}"
        ));
    }

    let device = response
        .json::<DeviceCodeResponse>()
        .await
        .context("parse xAI device authorization response")?;
    if device.device_code.trim().is_empty() {
        return Err(anyhow!(
            "xAI device authorization response missing device_code"
        ));
    }
    validate_user_code(&device.user_code)?;
    validate_verification_url(&device.verification_uri)?;
    if let Some(url) = device.verification_uri_complete.as_deref() {
        validate_verification_url(url)?;
    }
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
            Err(anyhow!("xAI device authorization was denied"))
        }
        "expired_token" => Err(anyhow!("xAI device authorization code expired")),
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
                "xAI device token exchange failed: HTTP {status}: {detail}"
            ))
        }
    }
}

async fn poll_once(
    device_code: &str,
    options: &SubscriptionHttpOptions,
) -> Result<DevicePoll<TokenResponse>> {
    let client = http_client(options)?;
    let response = oauth_request(client.post(TOKEN_URL))
        .form(&[
            ("grant_type", DEVICE_CODE_GRANT_TYPE),
            ("client_id", CLIENT_ID),
            ("device_code", device_code),
        ])
        .send()
        .await
        .context("call xAI device token endpoint")?;
    let status = response.status();
    let body = response.text().await.unwrap_or_default();

    if status.is_success() {
        let tokens =
            serde_json::from_str::<TokenResponse>(&body).context("parse xAI token response")?;
        return Ok(DevicePoll::Authorized(tokens));
    }

    let error = serde_json::from_str::<TokenErrorResponse>(&body).unwrap_or_default();
    classify_device_poll_error(status, &error)
}

fn account_id_from(tokens: &TokenResponse) -> Option<String> {
    tokens
        .id_token
        .as_deref()
        .and_then(jwt::subject)
        .or_else(|| jwt::subject(&tokens.access_token))
}

fn metadata_from(
    tokens: &TokenResponse,
    previous: Option<serde_json::Value>,
) -> Option<serde_json::Value> {
    let mut object = previous
        .and_then(|value| value.as_object().cloned())
        .unwrap_or_default();
    let email = tokens
        .id_token
        .as_deref()
        .and_then(jwt::email)
        .or_else(|| jwt::email(&tokens.access_token));
    if let Some(email) = email {
        object.insert("email".to_string(), serde_json::Value::String(email));
    }
    if object.is_empty() {
        None
    } else {
        Some(serde_json::Value::Object(object))
    }
}

async fn persist_tokens_for_account(
    slot: &str,
    tokens: TokenResponse,
    expected_revision: u64,
) -> Result<()> {
    if tokens.access_token.trim().is_empty() {
        return Err(anyhow!("xAI token response missing access_token"));
    }
    let refresh = tokens
        .refresh_token
        .clone()
        .filter(|token| !token.trim().is_empty())
        .ok_or_else(|| anyhow!("xAI token response missing refresh_token"))?;
    let expires = expires_at_ms(tokens.expires_in);
    let expires = jwt::effective_expiry_ms(&tokens.access_token, expires);
    let account_id = account_id_from(&tokens);
    let metadata = metadata_from(&tokens, None);
    let outcome = super::accounts::persist_account_credential(
        super::SubscriptionProvider::Grok,
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
    super::require_current_store_revision(super::SubscriptionProvider::Grok, outcome)?;
    log::info!("xAI subscription tokens saved");
    Ok(())
}

async fn refresh(refresh_token: &str, options: &SubscriptionHttpOptions) -> Result<TokenResponse> {
    let client = http_client(options)?;
    let response = oauth_request(client.post(TOKEN_URL))
        .form(&[
            ("grant_type", "refresh_token"),
            ("refresh_token", refresh_token),
            ("client_id", CLIENT_ID),
        ])
        .send()
        .await
        .context("call xAI token refresh endpoint")?;
    if !response.status().is_success() {
        let status = response.status();
        let body = response.text().await.unwrap_or_default();
        return Err(anyhow!("xAI token refresh failed: HTTP {status}: {body}"));
    }
    response
        .json::<TokenResponse>()
        .await
        .context("parse xAI token refresh response")
}

/// Starts the device-code login flow. The verification URL and user code are
/// returned immediately; the runner polls in the background.
pub(crate) async fn begin_login_for_account(
    slot: String,
    cancel: CancellationToken,
    expected_revision: u64,
    options: SubscriptionHttpOptions,
) -> Result<StartedLogin> {
    let device = request_device_code(&options).await?;
    let interval = positive_seconds(device.interval, DEFAULT_POLL_INTERVAL_SECS);
    let expires_in = positive_seconds(device.expires_in, DEFAULT_DEVICE_LIFETIME_SECS)
        .min(super::LOGIN_TIMEOUT.as_secs() as i64);
    let device_code = device.device_code.clone();
    let user_code = device.user_code.clone();
    let authorization_url = device
        .verification_uri_complete
        .clone()
        .unwrap_or_else(|| device.verification_uri.clone());

    let runner = async move {
        super::authorize_then_persist(
            super::SubscriptionProvider::Grok,
            cancel,
            async {
                poll_device_code(
                    Duration::from_secs(interval as u64),
                    Duration::from_secs(expires_in as u64),
                    Duration::from_secs(3),
                    true,
                    || poll_once(&device_code, &options),
                )
                .await
                .context("complete xAI device authorization")
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
        instructions: "Open the verification link, confirm the code, then return to OpenBitFun."
            .to_string(),
        runner: Box::pin(runner),
    })
}

async fn ensure_fresh_for_account(
    slot: &str,
    rejected_access: Option<&str>,
    options: &SubscriptionHttpOptions,
) -> Result<(String, i64)> {
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
) -> Result<(String, i64)> {
    let _refresh_lease = store::acquire_provider_refresh_lease(slot).await?;
    let snapshot = store::load_entry_with_revision(slot).await?;
    let entry = snapshot
        .credential
        .ok_or_else(|| anyhow!("xAI is not connected; sign in first"))?;
    let StoredCredential::Oauth {
        refresh: refresh_token,
        access,
        expires,
        account_id,
        metadata,
    } = entry
    else {
        return Err(anyhow!("xAI credential is not an OAuth login"));
    };

    let now = now_ms();
    let expires = jwt::effective_expiry_ms(&access, expires);
    let refresh_leeway = refresh_leeway_ms(&access, expires, now);
    if rejected_access != Some(access.as_str())
        && expires > now + refresh_leeway
        && !super::jwt::expires_within(&access, now, refresh_leeway)
    {
        return Ok((access, expires));
    }

    let refreshed = refresh(&refresh_token, options).await?;
    if refreshed.access_token.trim().is_empty() {
        return Err(anyhow!("xAI token refresh response missing access_token"));
    }
    let new_refresh = refreshed
        .refresh_token
        .clone()
        .filter(|token| !token.trim().is_empty())
        .unwrap_or(refresh_token);
    let new_expires = expires_at_ms(refreshed.expires_in);
    let new_expires = jwt::effective_expiry_ms(&refreshed.access_token, new_expires);
    let new_account_id = account_id_from(&refreshed).or(account_id);
    let new_metadata = metadata_from(&refreshed, metadata);
    let new_access = refreshed.access_token.clone();
    let outcome = super::accounts::persist_account_credential(
        super::SubscriptionProvider::Grok,
        slot,
        snapshot.revision,
        StoredCredential::Oauth {
            refresh: new_refresh,
            access: new_access.clone(),
            expires: new_expires,
            account_id: new_account_id,
            metadata: new_metadata,
        },
    )
    .await?;
    match outcome {
        store::ConditionalCommitOutcome::Committed { .. } => {
            log::info!("xAI subscription tokens refreshed");
            Ok((new_access, new_expires))
        }
        store::ConditionalCommitOutcome::Conflict { current_revision } => {
            let current = super::load_account_store_after_conflict(
                super::SubscriptionProvider::Grok,
                slot,
                current_revision,
            )
            .await?;
            match current.credential {
                Some(StoredCredential::Oauth {
                    access, expires, ..
                }) if jwt::effective_expiry_ms(&access, expires) > now_ms() => {
                    log::info!("xAI refresh reused tokens committed by a concurrent refresh");
                    let expires = jwt::effective_expiry_ms(&access, expires);
                    Ok((access, expires))
                }
                _ => Err(super::store_revision_conflict(
                    super::SubscriptionProvider::Grok,
                    current_revision,
                )),
            }
        }
    }
}

fn inference_headers() -> HashMap<String, String> {
    let mut headers = HashMap::new();
    let os = std::env::consts::OS;
    headers.insert(
        "User-Agent".to_string(),
        format!(
            "grok-shell/{GROK_CLIENT_VERSION} ({os}; {})",
            std::env::consts::ARCH
        ),
    );
    headers.insert("x-grok-client-version".into(), GROK_CLIENT_VERSION.into());
    headers.insert("x-xai-token-auth".into(), "xai-grok-cli".into());
    headers.insert("x-grok-client-identifier".into(), "grok-shell".into());
    headers.insert("x-grok-client-mode".into(), "headless".into());
    headers
}

pub(crate) fn request_route() -> (&'static str, &'static str, &'static str) {
    ("responses", XAI_BASE_URL, XAI_REQUEST_URL)
}

pub(crate) async fn list_models(
    client: &crate::AIClient,
) -> Result<Vec<crate::types::RemoteModelInfo>> {
    let response = crate::providers::openai::common::apply_headers(
        client,
        client.client.get(format!("{XAI_BASE_URL}/models")),
    )
    .send()
    .await
    .context("read Grok Build account model catalog")?
    .error_for_status()
    .context("Grok Build refused account model discovery")?;
    let payload: serde_json::Value = response
        .json()
        .await
        .context("parse Grok Build model catalog")?;
    parse_models(&payload)
}

fn parse_models(payload: &serde_json::Value) -> Result<Vec<crate::types::RemoteModelInfo>> {
    let entries = payload["data"]
        .as_array()
        .ok_or_else(|| anyhow!("Grok Build model catalog is missing data"))?;
    let models = crate::client::utils::dedupe_remote_models(
        entries
            .iter()
            .filter_map(|entry| {
                let id = entry["id"].as_str()?.trim();
                let backend = entry["api_backend"].as_str().unwrap_or("responses");
                if id.is_empty() || backend != "responses" {
                    return None;
                }
                Some(crate::types::RemoteModelInfo {
                    id: id.into(),
                    display_name: entry["name"]
                        .as_str()
                        .filter(|name| !name.trim().is_empty())
                        .map(str::to_owned),
                    routing: None,
                })
            })
            .collect(),
    );
    if models.is_empty() {
        return Err(anyhow!(
            "Grok Build listed no Responses models for this account"
        ));
    }
    Ok(models)
}

/// Resolves the runtime credential and pins it to xAI's trusted Responses
/// endpoint. The selected model remains in the normal request body.
pub(crate) async fn resolve_for_account(
    slot: &str,
    _model: &str,
    options: &SubscriptionHttpOptions,
) -> Result<ResolvedCredential> {
    let headers = inference_headers();
    let (access, expires) = ensure_fresh_for_account(slot, None, options).await?;

    Ok(ResolvedCredential {
        api_key: access,
        base_url: Some(XAI_BASE_URL.to_string()),
        request_url: Some(XAI_REQUEST_URL.to_string()),
        format: Some("responses".to_string()),
        extra_headers: headers,
        expires_at: Some(expires / 1000),
    })
}

pub(crate) async fn resolve(options: &SubscriptionHttpOptions) -> Result<ResolvedCredential> {
    resolve_for(DEFAULT_MODEL, options).await
}

/// Provider metadata used to seed a new model entry.
pub(crate) fn suggested() -> (&'static str, &'static str, &'static str) {
    ("responses", XAI_BASE_URL, DEFAULT_MODEL)
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
    #[tokio::test]
    #[ignore = "Reads the selected OpenBitFun Grok account's catalog from official xAI services; no inference requests"]
    async fn live_grok_model_catalog() {
        let slot = std::env::var("OPENBITFUN_LIVE_GROK_ACCOUNT")
            .expect("select an exact in-app account slot");
        super::super::accounts::validate_account_id(
            super::super::SubscriptionProvider::Grok,
            &slot,
        )
        .unwrap();
        let proxy = std::env::var("OPENBITFUN_LIVE_SUBSCRIPTION_PROXY")
            .ok()
            .map(|url| crate::types::ProxyConfig {
                enabled: true,
                url,
                username: None,
                password: None,
            });
        let options = super::SubscriptionHttpOptions::new(proxy.clone(), false);
        let resolved = super::resolve_for_account(&slot, "model-discovery", &options)
            .await
            .unwrap();
        // Old persisted public routes must be overridden in the same transient
        // client configuration used by the application's discovery command.
        let mut config: crate::types::AIConfig = serde_json::from_value(serde_json::json!({
            "name":"live-grok-catalog", "model":"model-discovery", "format":"responses",
            "base_url":"https://api.x.ai/v1", "request_url":"https://api.x.ai/v1/responses",
            "api_key":"", "context_window":4096, "inline_think_in_text":false, "skip_ssl_verify":false
        })).unwrap();
        resolved.apply_to(&mut config);
        let client = crate::AIClient::new_with_proxy(config, proxy)
            .with_subscription_provider(super::super::SubscriptionProvider::Grok);
        let models = client.list_models().await.unwrap();
        assert!(!models.is_empty());
        println!(
            "Grok Build model_count={} model_ids={:?}",
            models.len(),
            models.iter().map(|model| &model.id).collect::<Vec<_>>()
        );
    }

    use super::{
        classify_device_poll_error, inference_headers, suggested, validate_user_code,
        validate_verification_url, DeviceCodeResponse, DevicePoll, TokenErrorResponse,
        TokenResponse, DEFAULT_MODEL, LONG_TOKEN_REFRESH_LEEWAY_MS, SHORT_TOKEN_REFRESH_LEEWAY_MS,
        XAI_BASE_URL, XAI_REQUEST_URL,
    };

    #[test]
    fn accepts_https_verification_urls_and_rejects_unsafe_urls() {
        validate_verification_url("https://accounts.x.ai/oauth2/device?user_code=ABCD-EFGH")
            .unwrap();
        assert!(validate_verification_url("javascript:alert(1)").is_err());
        assert!(validate_verification_url("http://accounts.x.ai/oauth2/device").is_err());
        assert!(validate_verification_url("https://accounts.x.ai/\nmalicious").is_err());
    }

    #[test]
    fn validates_device_user_code() {
        validate_user_code("ABCD-EFGH").unwrap();
        assert!(validate_user_code("").is_err());
        assert!(validate_user_code("ABCD\nEFGH").is_err());
    }

    #[test]
    fn parses_numeric_or_string_oauth_lifetimes() {
        let device: DeviceCodeResponse = serde_json::from_value(serde_json::json!({
            "device_code": "device",
            "user_code": "ABCD-EFGH",
            "verification_uri": "https://accounts.x.ai/oauth2/device",
            "expires_in": "300",
            "interval": 5
        }))
        .unwrap();
        assert_eq!(device.expires_in, Some(300));
        assert_eq!(device.interval, Some(5));

        let tokens: TokenResponse = serde_json::from_value(serde_json::json!({
            "access_token": "access",
            "refresh_token": "refresh",
            "expires_in": "3600"
        }))
        .unwrap();
        assert_eq!(tokens.expires_in, Some(3600));
    }

    #[test]
    fn subscription_requests_use_grok_build_route_and_required_headers() {
        assert_eq!(suggested(), ("responses", XAI_BASE_URL, DEFAULT_MODEL));
        assert_eq!(
            XAI_REQUEST_URL,
            "https://cli-chat-proxy.grok.com/v1/responses"
        );
        let headers = inference_headers();
        assert!(headers["User-Agent"].starts_with("grok-shell/"));
        assert_eq!(headers["x-xai-token-auth"], "xai-grok-cli");
        assert_eq!(headers["x-grok-client-identifier"], "grok-shell");
        assert_eq!(headers["x-grok-client-mode"], "headless");
        assert!(!headers.contains_key("x-grok-model-override"));
    }

    #[test]
    fn catalog_preserves_wire_ids_names_and_filters_unsupported_protocols() {
        let models = super::parse_models(&serde_json::json!({"data":[
            {"id":"grok-4.7","name":"Grok 4.7","api_backend":"responses"},
            {"id":"legacy","api_backend":"chat_completions"},
            {"id":"grok-4.7"}, {"id":"custom"}, {"id":" "}
        ]}))
        .unwrap();
        assert_eq!(models.len(), 2);
        assert_eq!(models[0].id, "grok-4.7");
        assert_eq!(models[0].display_name.as_deref(), Some("Grok 4.7"));
        assert_eq!(models[1].id, "custom");
        for invalid in [
            serde_json::json!({}),
            serde_json::json!({"data":[]}),
            serde_json::json!({"data":[{"id":"other","api_backend":"chat_completions"}]}),
        ] {
            assert!(super::parse_models(&invalid).is_err());
        }
    }

    #[test]
    fn legacy_subscription_configs_use_build_routes_without_rewriting_the_model_or_key() {
        let saved = serde_json::json!({
            "name":"legacy-grok", "model":"grok-4.5", "format":"responses",
            "base_url":"https://api.x.ai/v1", "request_url":"https://api.x.ai/v1/responses",
            "api_key":"synthetic-old-key", "context_window":4096,
            "inline_think_in_text":false, "skip_ssl_verify":false
        });
        let mut config: crate::types::AIConfig = serde_json::from_value(saved.clone()).unwrap();
        super::super::prepare_account_request_route(
            super::super::SubscriptionProvider::Grok,
            &mut config,
        )
        .unwrap();
        assert_eq!(config.base_url, XAI_BASE_URL);
        assert_eq!(config.request_url, XAI_REQUEST_URL);
        assert_eq!(config.model, "grok-4.5");
        assert_eq!(config.api_key, "synthetic-old-key");
        let read_again: crate::types::AIConfig = serde_json::from_value(saved).unwrap();
        assert_eq!(read_again.base_url, "https://api.x.ai/v1");
    }

    #[test]
    fn follows_rfc_8628_pending_slow_down_and_terminal_errors() {
        let pending = TokenErrorResponse {
            error: "authorization_pending".to_string(),
            error_description: None,
        };
        assert!(matches!(
            classify_device_poll_error(reqwest::StatusCode::BAD_REQUEST, &pending).unwrap(),
            DevicePoll::Pending
        ));

        let slow_down = TokenErrorResponse {
            error: "slow_down".to_string(),
            error_description: None,
        };
        assert!(matches!(
            classify_device_poll_error(reqwest::StatusCode::BAD_REQUEST, &slow_down).unwrap(),
            DevicePoll::SlowDown
        ));

        let denied = TokenErrorResponse {
            error: "access_denied".to_string(),
            error_description: None,
        };
        let Err(error) = classify_device_poll_error(reqwest::StatusCode::BAD_REQUEST, &denied)
        else {
            panic!("access_denied must be terminal");
        };
        assert!(error.to_string().contains("denied"));
    }

    #[test]
    fn uses_short_skew_for_short_tokens_and_gateway_skew_for_long_sessions() {
        let now = 1_800_000_000_000i64;
        assert_eq!(
            super::refresh_leeway_ms("opaque", now + 15 * 60 * 1000, now),
            SHORT_TOKEN_REFRESH_LEEWAY_MS
        );
        assert_eq!(
            super::refresh_leeway_ms("opaque", now + 6 * 60 * 60 * 1000, now),
            LONG_TOKEN_REFRESH_LEEWAY_MS
        );
    }
}
