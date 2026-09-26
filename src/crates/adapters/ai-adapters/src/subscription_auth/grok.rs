//! xAI (SuperGrok) account login and credential resolution.
//!
//! Authentication uses xAI's public Grok CLI OAuth client with the RFC 8628
//! device flow. Subscription inference uses xAI's normal Responses endpoint,
//! matching OpenCode's built-in xAI auth plugin.

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
const ISSUER: &str = "https://auth.x.ai";
const DISCOVERY_URL: &str = "https://auth.x.ai/.well-known/openid-configuration";
const DEVICE_CODE_GRANT_TYPE: &str = "urn:ietf:params:oauth:grant-type:device_code";
const SCOPE: &str = "openid profile email offline_access grok-cli:access api:access";
const XAI_BASE_URL: &str = "https://api.x.ai/v1";
const XAI_REQUEST_URL: &str = "https://api.x.ai/v1/responses";
const DEFAULT_MODEL: &str = "grok-4.5";
const STORE_KEY: &str = "grok";
const DEFAULT_TOKEN_LIFETIME_SECS: i64 = 60 * 60;
const DEFAULT_DEVICE_LIFETIME_SECS: i64 = 5 * 60;
const DEFAULT_POLL_INTERVAL_SECS: i64 = 5;
const SHORT_TOKEN_REFRESH_LEEWAY_MS: i64 = 2 * 60 * 1000;
const LONG_TOKEN_REFRESH_LEEWAY_MS: i64 = 60 * 60 * 1000;
const SHORT_TOKEN_THRESHOLD_MS: i64 = 45 * 60 * 1000;

#[derive(Debug, Deserialize)]
struct DiscoveryDocument {
    issuer: String,
    device_authorization_endpoint: String,
    token_endpoint: String,
}

struct OAuthEndpoints {
    device_authorization: reqwest::Url,
    token: reqwest::Url,
}

fn trusted_auth_endpoint(value: &str) -> Result<reqwest::Url> {
    let url = reqwest::Url::parse(value).context("parse xAI authentication endpoint")?;
    if value.chars().any(|character| character.is_ascii_control())
        || url.scheme() != "https"
        || url.host_str() != Some("auth.x.ai")
        || url.port_or_known_default() != Some(443)
        || !url.username().is_empty()
        || url.password().is_some()
        || url.fragment().is_some()
    {
        return Err(anyhow!(
            "xAI discovery returned an untrusted authentication endpoint"
        ));
    }
    Ok(url)
}

fn discovery_endpoints(document: DiscoveryDocument) -> Result<OAuthEndpoints> {
    if document.issuer.trim_end_matches('/') != ISSUER {
        return Err(anyhow!(
            "xAI discovery issuer does not match the expected issuer"
        ));
    }
    Ok(OAuthEndpoints {
        device_authorization: trusted_auth_endpoint(&document.device_authorization_endpoint)?,
        token: trusted_auth_endpoint(&document.token_endpoint)?,
    })
}

async fn discover_endpoints(options: &SubscriptionHttpOptions) -> Result<OAuthEndpoints> {
    let response = oauth_request(http_client(options)?.get(DISCOVERY_URL))
        .send()
        .await
        .context("fetch xAI OpenID discovery document")?;
    if !response.status().is_success() {
        return Err(anyhow!("xAI discovery failed: HTTP {}", response.status()));
    }
    discovery_endpoints(
        response
            .json()
            .await
            .context("parse xAI discovery document")?,
    )
}

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

async fn request_device_code(
    options: &SubscriptionHttpOptions,
    endpoints: &OAuthEndpoints,
) -> Result<DeviceCodeResponse> {
    let client = http_client(options)?;
    let response = oauth_request(client.post(endpoints.device_authorization.clone()))
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
    endpoints: &OAuthEndpoints,
) -> Result<DevicePoll<TokenResponse>> {
    let client = http_client(options)?;
    let response = oauth_request(client.post(endpoints.token.clone()))
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

async fn persist_tokens(tokens: TokenResponse, expected_revision: u64) -> Result<()> {
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
    let outcome = store::upsert_if_revision(
        STORE_KEY,
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
    let endpoints = discover_endpoints(options).await?;
    let client = http_client(options)?;
    let response = oauth_request(client.post(endpoints.token))
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
pub(crate) async fn begin_login(
    cancel: CancellationToken,
    expected_revision: u64,
    options: SubscriptionHttpOptions,
) -> Result<StartedLogin> {
    let endpoints = discover_endpoints(&options).await?;
    let device = request_device_code(&options, &endpoints).await?;
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
                    || poll_once(&device_code, &options, &endpoints),
                )
                .await
                .context("complete xAI device authorization")
            },
            move |tokens| persist_tokens(tokens, expected_revision),
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

async fn ensure_fresh(options: &SubscriptionHttpOptions) -> Result<(String, i64)> {
    let _refresh_lease = store::acquire_provider_refresh_lease(STORE_KEY).await?;
    let snapshot = store::load_entry_with_revision(STORE_KEY).await?;
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
    if expires > now + refresh_leeway && !super::jwt::expires_within(&access, now, refresh_leeway) {
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
    let outcome = store::upsert_if_revision(
        STORE_KEY,
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
            let current = super::load_current_store_after_conflict(
                super::SubscriptionProvider::Grok,
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
    headers.insert("User-Agent".to_string(), opencode_user_agent());
    headers
}

/// Resolves the runtime credential and pins it to xAI's trusted Responses
/// endpoint. The selected model remains in the normal request body.
pub(crate) async fn resolve_for(
    _model: &str,
    options: &SubscriptionHttpOptions,
) -> Result<ResolvedCredential> {
    let headers = inference_headers();
    let (access, expires) = ensure_fresh(options).await?;

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

#[cfg(test)]
mod tests {
    use super::{
        classify_device_poll_error, inference_headers, suggested, validate_user_code,
        validate_verification_url, DeviceCodeResponse, DevicePoll, TokenErrorResponse,
        TokenResponse, DEFAULT_MODEL, LONG_TOKEN_REFRESH_LEEWAY_MS, SHORT_TOKEN_REFRESH_LEEWAY_MS,
        XAI_BASE_URL, XAI_REQUEST_URL,
    };

    #[test]
    fn discovery_accepts_changed_paths_and_ignores_unrelated_metadata() {
        let document = serde_json::from_value(serde_json::json!({
            "issuer": "https://auth.x.ai/",
            "device_authorization_endpoint": "https://auth.x.ai/new/device",
            "token_endpoint": "https://auth.x.ai/new/token",
            "authorization_endpoint": "https://auth.x.ai/authorize"
        }))
        .unwrap();
        let endpoints = super::discovery_endpoints(document).unwrap();
        assert_eq!(
            endpoints.device_authorization.as_str(),
            "https://auth.x.ai/new/device"
        );
        assert_eq!(endpoints.token.as_str(), "https://auth.x.ai/new/token");
    }

    #[test]
    fn discovery_rejects_wrong_issuer_missing_fields_and_untrusted_endpoints() {
        for invalid in [
            "http://auth.x.ai/token",
            "https://auth.x.ai:8443/token",
            "https://user@auth.x.ai/token",
            "https://auth.x.ai.evil.test/token",
            "https://attacker.example/token",
            "https://auth.x.ai/token#fragment",
            "https://auth.x.ai/\ntoken",
        ] {
            for field in ["token_endpoint", "device_authorization_endpoint"] {
                let mut value = serde_json::json!({
                    "issuer": "https://auth.x.ai",
                    "device_authorization_endpoint": "https://auth.x.ai/device",
                    "token_endpoint": "https://auth.x.ai/token"
                });
                value[field] = serde_json::json!(invalid);
                assert!(
                    super::discovery_endpoints(serde_json::from_value(value).unwrap()).is_err()
                );
            }
        }
        let document = serde_json::from_value(serde_json::json!({
            "issuer": "https://attacker.example",
            "device_authorization_endpoint": "https://auth.x.ai/device",
            "token_endpoint": "https://auth.x.ai/token"
        }))
        .unwrap();
        assert!(super::discovery_endpoints(document).is_err());
        assert!(
            serde_json::from_value::<super::DiscoveryDocument>(serde_json::json!({
                "issuer": "https://auth.x.ai", "token_endpoint": "https://auth.x.ai/token"
            }))
            .is_err()
        );
    }

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
    fn uses_standard_xai_responses_route_and_opencode_user_agent() {
        assert_eq!(suggested(), ("responses", XAI_BASE_URL, DEFAULT_MODEL));
        assert_eq!(XAI_REQUEST_URL, "https://api.x.ai/v1/responses");
        let headers = inference_headers();
        assert_eq!(
            headers.get("User-Agent").map(String::as_str),
            Some(concat!("opencode/", "1.18.29"))
        );
        assert_eq!(super::super::OPENCODE_COMPAT_VERSION, "1.18.29");
        assert!(!headers.contains_key("X-XAI-Token-Auth"));
        assert!(!headers.contains_key("x-grok-model-override"));
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
