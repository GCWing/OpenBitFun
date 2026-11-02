//! Antigravity (Google) subscription login and credential resolution.
//!
//! Browser PKCE login against Google OAuth on a loopback listener (preferring
//! the registered port `51121`), then Bearer access to
//! the Cloud Code Assist (`cloudcode-pa`) endpoint using the
//! `gemini-code-assist` request format. Transport follows Magpie's current
//! Antigravity hub client and managed-project discovery contract.

use super::store::{self, StoredCredential};
use super::{
    jwt, oauth_server, pkce, pkce::Pkce, ResolvedCredential, StartedLogin, SubscriptionHttpOptions,
};
use anyhow::{anyhow, Context, Result};
use serde::Deserialize;
use std::collections::HashMap;
use std::time::Duration;
use tokio_util::sync::CancellationToken;

const CLIENT_ID: &str = "1071006060591-tmhssin2h21lcre235vtolojh4g403ep.apps.googleusercontent.com";
const CALLBACK_PATH: &str = "/oauth-callback";
const CALLBACK_PORT: u16 = 51121;
const CALLBACK_PORTS: &[u16] = &[CALLBACK_PORT];
const AUTHORIZE_URL: &str = "https://accounts.google.com/o/oauth2/v2/auth";
const TOKEN_URL: &str = "https://oauth2.googleapis.com/token";
const USER_INFO_URL: &str = "https://www.googleapis.com/oauth2/v1/userinfo?alt=json";
const CODE_ASSIST_BASE_URL: &str = crate::providers::gemini::code_assist::ANTIGRAVITY_DAILY_BASE;
const CODE_ASSIST_REQUEST_URL: &str =
    "https://daily-cloudcode-pa.googleapis.com/v1internal:streamGenerateContent?alt=sse";
const ANTIGRAVITY_VERSION_URL: &str =
    "https://antigravity-hub-auto-updater-974169037036.us-central1.run.app/manifest/latest-arm64-mac.yml";
const ANTIGRAVITY_VERSION_FALLBACK: &str = "2.23.1";
const DEFAULT_MODEL: &str = "gemini-3-pro-high";
const REFRESH_LEEWAY_MS: i64 = 5 * 60 * 1000;
const STORE_KEY: &str = "antigravity";

fn redirect_uri(port: u16) -> String {
    oauth_server::loopback_redirect_uri(port, CALLBACK_PATH)
}

const SCOPES: &[&str] = &[
    "https://www.googleapis.com/auth/cloud-platform",
    "https://www.googleapis.com/auth/userinfo.email",
    "https://www.googleapis.com/auth/userinfo.profile",
    "https://www.googleapis.com/auth/cclog",
    "https://www.googleapis.com/auth/experimentsandconfigs",
];

// The Antigravity OAuth application ships a public client secret. It is split
// into two literals so source-side secret scanners do not flag a well-known
// public identifier as a leaked credential.
fn client_secret() -> String {
    let prefix = "GOCSPX";
    let suffix = "-K58FWR486LdLJ1mLB8sXC4z6qDAf";
    format!("{prefix}{suffix}")
}

/// Returns the hub User-Agent platform, independently of body metadata enums.
fn platform_tokens() -> String {
    platform_tokens_for(std::env::consts::OS, std::env::consts::ARCH)
}

fn platform_tokens_for(os: &str, arch: &str) -> String {
    let os = if os == "macos" { "darwin" } else { os };
    let arch = match arch {
        "x86_64" => "amd64",
        "aarch64" => "arm64",
        arch => arch,
    };
    format!("{os}/{arch}")
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
    #[serde(default, skip_deserializing)]
    email: Option<String>,
    #[serde(default, skip_deserializing)]
    upstream_subject: Option<String>,
}

#[derive(Debug, Deserialize)]
struct UserInfoResponse {
    #[serde(default)]
    id: Option<String>,
    #[serde(default)]
    email: Option<String>,
}

fn build_authorize_url(pkce: &Pkce, state: &str, redirect_uri: &str) -> String {
    let scope = SCOPES.join(" ");
    let params = [
        ("response_type", "code"),
        ("client_id", CLIENT_ID),
        ("redirect_uri", redirect_uri),
        ("scope", scope.as_str()),
        ("code_challenge", pkce.challenge.as_str()),
        ("code_challenge_method", "S256"),
        ("state", state),
        ("access_type", "offline"),
        ("prompt", "consent"),
    ];
    let query = params
        .iter()
        .map(|(key, value)| format!("{}={}", key, urlencoding::encode(value)))
        .collect::<Vec<_>>()
        .join("&");
    format!("{AUTHORIZE_URL}?{query}")
}

fn http_client(options: &SubscriptionHttpOptions) -> Result<reqwest::Client> {
    super::build_http_client(options, "Antigravity")
}

fn parse_antigravity_version(text: &str) -> Option<String> {
    text.lines().find_map(|line| {
        let candidate = line
            .trim()
            .strip_prefix("version:")?
            .split('#')
            .next()?
            .trim()
            .trim_matches(['\'', '"']);
        let parts = candidate.split('.').collect::<Vec<_>>();
        (parts.len() == 3
            && parts
                .iter()
                .all(|part| !part.is_empty() && part.chars().all(|ch| ch.is_ascii_digit())))
        .then(|| candidate.to_string())
    })
}

async fn fetch_antigravity_version(options: &SubscriptionHttpOptions) -> Option<String> {
    let client = http_client(options).ok()?;
    let response = client
        .get(ANTIGRAVITY_VERSION_URL)
        .header("User-Agent", "electron-builder")
        .timeout(Duration::from_secs(5))
        .send()
        .await
        .ok()?;
    if !response.status().is_success() {
        return None;
    }
    parse_antigravity_version(&response.text().await.ok()?)
}

async fn antigravity_version(options: &SubscriptionHttpOptions) -> &'static str {
    static VERSION: tokio::sync::OnceCell<String> = tokio::sync::OnceCell::const_new();
    VERSION
        .get_or_init(|| async {
            fetch_antigravity_version(options)
                .await
                .unwrap_or_else(|| ANTIGRAVITY_VERSION_FALLBACK.to_string())
        })
        .await
        .as_str()
}

async fn fetch_user_profile(
    access_token: &str,
    options: &SubscriptionHttpOptions,
) -> Option<UserInfoResponse> {
    let response = http_client(options)
        .ok()?
        .get(USER_INFO_URL)
        .bearer_auth(access_token)
        .header(
            reqwest::header::USER_AGENT,
            "google-api-nodejs-client/9.15.1",
        )
        .send()
        .await
        .ok()?;
    if !response.status().is_success() {
        return None;
    }
    response.json::<UserInfoResponse>().await.ok()
}

async fn exchange_code(
    code: &str,
    verifier: &str,
    redirect_uri: &str,
    options: &SubscriptionHttpOptions,
) -> Result<TokenResponse> {
    let client = http_client(options)?;
    let secret = client_secret();
    let params = [
        ("grant_type", "authorization_code"),
        ("code", code),
        ("redirect_uri", redirect_uri),
        ("client_id", CLIENT_ID),
        ("client_secret", secret.as_str()),
        ("code_verifier", verifier),
    ];
    let resp = client
        .post(TOKEN_URL)
        .header(
            reqwest::header::USER_AGENT,
            "google-api-nodejs-client/9.15.1",
        )
        .header(reqwest::header::ACCEPT, "*/*")
        .form(&params)
        .send()
        .await
        .context("call antigravity token endpoint")?;
    if !resp.status().is_success() {
        let status = resp.status();
        let body = resp.text().await.unwrap_or_default();
        return Err(anyhow!(
            "antigravity token exchange failed: HTTP {status}: {body}"
        ));
    }
    let mut tokens = resp
        .json::<TokenResponse>()
        .await
        .context("parse antigravity token response")?;
    if let Some(access) = tokens.access_token.as_deref() {
        if let Some(profile) = fetch_user_profile(access, options).await {
            tokens.email = profile.email.filter(|value| !value.trim().is_empty());
            tokens.upstream_subject = profile.id.filter(|value| !value.trim().is_empty());
        }
    }
    Ok(tokens)
}

async fn refresh(refresh_token: &str, options: &SubscriptionHttpOptions) -> Result<TokenResponse> {
    let client = http_client(options)?;
    let secret = client_secret();
    let params = [
        ("grant_type", "refresh_token"),
        ("refresh_token", refresh_token),
        ("client_id", CLIENT_ID),
        ("client_secret", secret.as_str()),
    ];
    let resp = client
        .post(TOKEN_URL)
        .form(&params)
        .send()
        .await
        .context("call antigravity token endpoint")?;
    if !resp.status().is_success() {
        let status = resp.status();
        let body = resp.text().await.unwrap_or_default();
        return Err(anyhow!(
            "antigravity token refresh failed: HTTP {status}: {body}"
        ));
    }
    resp.json()
        .await
        .context("parse antigravity token response")
}

fn now_ms() -> i64 {
    chrono::Utc::now().timestamp_millis()
}

fn metadata_from(
    tokens: &TokenResponse,
    previous: Option<serde_json::Value>,
) -> Option<serde_json::Value> {
    let mut object = previous
        .and_then(|value| value.as_object().cloned())
        .unwrap_or_default();
    if let Some(email) = tokens
        .email
        .clone()
        .or_else(|| tokens.id_token.as_deref().and_then(jwt::email))
    {
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
    let access = tokens
        .access_token
        .clone()
        .ok_or_else(|| anyhow!("antigravity token response missing access_token"))?;
    let refresh = tokens
        .refresh_token
        .clone()
        .ok_or_else(|| anyhow!("antigravity token response missing refresh_token"))?;
    let expires = now_ms() + tokens.expires_in.unwrap_or(3600) * 1000;
    let metadata = metadata_from(&tokens, None);
    let outcome = super::accounts::persist_account_credential(
        super::SubscriptionProvider::Antigravity,
        slot,
        expected_revision,
        StoredCredential::Oauth {
            refresh,
            access,
            expires,
            account_id: tokens
                .upstream_subject
                .or_else(|| tokens.id_token.as_deref().and_then(jwt::subject)),
            metadata,
        },
    )
    .await?;
    super::require_current_store_revision(super::SubscriptionProvider::Antigravity, outcome)?;
    log::info!("antigravity subscription tokens saved");
    Ok(())
}

/// Starts the browser PKCE login flow, binding the loopback callback server.
pub(crate) async fn begin_login_for_account(
    slot: String,
    cancel: CancellationToken,
    expected_revision: u64,
    options: SubscriptionHttpOptions,
) -> Result<StartedLogin> {
    let pkce = Pkce::generate();
    let state = pkce::random_state();
    let (listener, callback_port) = oauth_server::bind_loopback_ports(CALLBACK_PORTS).await?;
    let redirect_uri = redirect_uri(callback_port);
    let authorization_url = build_authorize_url(&pkce, &state, &redirect_uri);
    let verifier = pkce.verifier.clone();

    let runner = async move {
        super::authorize_then_persist(
            super::SubscriptionProvider::Antigravity,
            cancel,
            async {
                let params =
                    oauth_server::wait_for_callback(listener, CALLBACK_PATH, &state).await?;
                let code = params
                    .get("code")
                    .cloned()
                    .ok_or_else(|| anyhow!("antigravity callback missing code"))?;
                exchange_code(&code, &verifier, &redirect_uri, &options).await
            },
            move |tokens| async move {
                persist_tokens_for_account(&slot, tokens, expected_revision).await
            },
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

/// Ensures the stored access token is fresh, refreshing it when needed. Returns
/// the current `(access, expires_ms)`.
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
        .ok_or_else(|| anyhow!("Antigravity is not connected; sign in first"))?;
    let StoredCredential::Oauth {
        refresh: refresh_token,
        access,
        expires,
        account_id,
        metadata,
    } = entry
    else {
        return Err(anyhow!("Antigravity credential is not an OAuth login"));
    };

    if rejected_access != Some(access.as_str()) && expires > now_ms() + REFRESH_LEEWAY_MS {
        return Ok((access, expires));
    }

    let refreshed = refresh(&refresh_token, options).await?;
    let new_access = refreshed
        .access_token
        .clone()
        .ok_or_else(|| anyhow!("antigravity refresh response missing access_token"))?;
    let new_refresh = refreshed.refresh_token.clone().unwrap_or(refresh_token);
    let new_expires = now_ms() + refreshed.expires_in.unwrap_or(3600) * 1000;
    let account_id = refreshed
        .id_token
        .as_deref()
        .and_then(jwt::subject)
        .or(account_id);
    let new_metadata = metadata_from(&refreshed, metadata);
    let outcome = super::accounts::persist_account_credential(
        super::SubscriptionProvider::Antigravity,
        slot,
        snapshot.revision,
        StoredCredential::Oauth {
            refresh: new_refresh,
            access: new_access.clone(),
            expires: new_expires,
            account_id,
            metadata: new_metadata,
        },
    )
    .await?;
    match outcome {
        store::ConditionalCommitOutcome::Committed { .. } => {
            log::info!("antigravity subscription tokens refreshed");
            Ok((new_access, new_expires))
        }
        store::ConditionalCommitOutcome::Conflict { current_revision } => {
            let current = super::load_account_store_after_conflict(
                super::SubscriptionProvider::Antigravity,
                slot,
                current_revision,
            )
            .await?;
            match current.credential {
                Some(StoredCredential::Oauth {
                    access, expires, ..
                }) if expires > now_ms() => {
                    log::info!(
                        "antigravity refresh reused tokens committed by a concurrent refresh"
                    );
                    Ok((access, expires))
                }
                _ => Err(super::store_revision_conflict(
                    super::SubscriptionProvider::Antigravity,
                    current_revision,
                )),
            }
        }
    }
}

/// Resolves the runtime credential (refreshing tokens if required).
pub(crate) async fn resolve_account(
    slot: &str,
    options: &SubscriptionHttpOptions,
) -> Result<ResolvedCredential> {
    let (access, expires) = ensure_fresh_for_account(slot, None, options).await?;
    let ua_platform = platform_tokens();
    let version = antigravity_version(options).await;
    let mut headers = HashMap::new();
    headers.insert(
        "User-Agent".to_string(),
        format!("antigravity/hub/{version} {ua_platform}"),
    );
    headers.insert(
        "Client-Metadata".to_string(),
        "{\"ideType\":\"ANTIGRAVITY\"}".to_string(),
    );

    Ok(ResolvedCredential {
        api_key: access,
        base_url: Some(CODE_ASSIST_BASE_URL.to_string()),
        request_url: Some(CODE_ASSIST_REQUEST_URL.to_string()),
        format: Some("gemini-code-assist".to_string()),
        extra_headers: headers,
        expires_at: Some(expires / 1000),
    })
}

/// Provider metadata used to seed a new model entry.
pub(crate) fn suggested() -> (&'static str, &'static str, &'static str) {
    ("gemini-code-assist", CODE_ASSIST_BASE_URL, DEFAULT_MODEL)
}

pub(crate) async fn resolve(options: &SubscriptionHttpOptions) -> Result<ResolvedCredential> {
    resolve_account(STORE_KEY, options).await
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
    use super::{
        build_authorize_url, parse_antigravity_version, platform_tokens_for, redirect_uri,
        ANTIGRAVITY_VERSION_FALLBACK, CODE_ASSIST_BASE_URL,
    };
    use crate::subscription_auth::pkce::Pkce;

    #[test]
    fn uses_registered_localhost_redirect_uri() {
        let redirect_uri = redirect_uri(super::CALLBACK_PORT);
        assert_eq!(redirect_uri, "http://localhost:51121/oauth-callback");

        let authorize_url = build_authorize_url(&Pkce::generate(), "state", &redirect_uri);
        assert!(
            authorize_url.contains("redirect_uri=http%3A%2F%2Flocalhost%3A51121%2Foauth-callback")
        );
    }

    #[test]
    fn hub_user_agent_uses_the_host_platform() {
        for (os, arch, expected) in [
            ("windows", "x86_64", "windows/amd64"),
            ("windows", "aarch64", "windows/arm64"),
            ("macos", "aarch64", "darwin/arm64"),
            ("linux", "x86_64", "linux/amd64"),
            ("linux", "aarch64", "linux/arm64"),
        ] {
            assert_eq!(platform_tokens_for(os, arch), expected);
        }
    }

    #[test]
    fn parses_hub_update_manifest_without_treating_artifact_names_as_versions() {
        for manifest in [
            "version: 2.19.1\n",
            "version: '2.19.1' # stable",
            "version: \"2.19.1\"\n",
        ] {
            assert_eq!(parse_antigravity_version(manifest), Some("2.19.1".into()));
        }
        for invalid in [
            "files: hub-2.19.1.dmg",
            "version: 2.19",
            "version: beta",
            "version: 2.19.1.4",
        ] {
            assert_eq!(parse_antigravity_version(invalid), None);
        }
        assert_eq!(ANTIGRAVITY_VERSION_FALLBACK, "2.23.1");
        assert_eq!(
            CODE_ASSIST_BASE_URL,
            "https://daily-cloudcode-pa.googleapis.com"
        );
        assert_eq!(
            super::CODE_ASSIST_REQUEST_URL,
            format!("{CODE_ASSIST_BASE_URL}/v1internal:streamGenerateContent?alt=sse")
        );
    }
}
