//! OpenCode account login, catalog discovery, and credential resolution.
//!
//! Uses the OAuth 2.0 Device Authorization Grant against
//! `opencode.ai/console`, aligned with OpenCode's `provider/opencode.ts`.
//! Console OAuth is restricted to Zen. Go requires a separate API-key config.

use super::device_flow::{poll_device_code, DevicePoll};
use super::store::{self, StoredCredential};
use super::{
    OpenCodePlan, ResolvedCredential, StartedLogin, SubscriptionApiOffering,
    SubscriptionHttpOptions, SubscriptionOfferingModel,
};
use anyhow::{anyhow, Context, Result};
use serde::Deserialize;
use std::collections::{HashMap, HashSet};
use std::time::Duration;
use tokio_util::sync::CancellationToken;

const SERVER: &str = "https://opencode.ai/console";
const CLIENT_ID: &str = "opencode-cli";
const DEVICE_GRANT: &str = "urn:ietf:params:oauth:grant-type:device_code";
const ZEN_BASE_URL: &str = "https://opencode.ai/zen/v1";
const DEFAULT_MODEL: &str = "gpt-5.4";
const REFRESH_LEEWAY_MS: i64 = 5 * 60 * 1000;
const STORE_KEY: &str = "opencode";
const OFFERINGS_METADATA_KEY: &str = "api_offerings";
const SUPPORTED_FORMATS: [&str; 3] = ["openai", "responses", "anthropic"];

struct FreshCredential {
    access: String,
    expires_at_ms: Option<i64>,
    metadata: Option<serde_json::Value>,
}

#[derive(Debug, Deserialize)]
struct DeviceCodeResponse {
    device_code: String,
    user_code: String,
    verification_uri_complete: String,
    #[serde(default)]
    expires_in: Option<u64>,
    #[serde(default)]
    interval: Option<u64>,
}

#[derive(Debug, Deserialize)]
struct TokenResponse {
    access_token: String,
    refresh_token: String,
    expires_in: i64,
}

#[derive(Debug, Deserialize)]
struct PendingResponse {
    error: String,
    #[serde(default)]
    error_description: Option<String>,
}

#[derive(Debug, Deserialize)]
struct UserResponse {
    #[serde(default)]
    id: Option<String>,
    #[serde(default)]
    email: Option<String>,
}

#[derive(Debug, Deserialize)]
struct OrgResponse {
    #[serde(default)]
    id: Option<String>,
    #[serde(default)]
    name: Option<String>,
}

#[derive(Debug, Deserialize)]
struct RemoteConfigResponse {
    config: serde_json::Value,
}

// Versioned, secret-free account routing. Never persist the remote apiKey value.
const CONSOLE_ROUTES_KEY: &str = "console_routes_v1";

#[derive(Debug, Clone, serde::Serialize, Deserialize)]
struct ConsoleRoute {
    base_url: String,
    request_url: String,
    format: String,
    #[serde(default)]
    headers: HashMap<String, String>,
}

fn console_route(base: &str, format: &str) -> Result<ConsoleRoute> {
    let base = base.trim_end_matches('/');
    let url = reqwest::Url::parse(base).context("Invalid OpenCode Console inference URL")?;
    // Console owns this namespace. Public Zen/Go routes authenticate API keys.
    if !crate::providers::shared::is_https_endpoint(base, "opencode.ai", "/inference")
        || url.query().is_some()
        || url.fragment().is_some()
        || base.contains('%')
        || base.contains('\\')
        || base.split('/').any(|part| part == "." || part == "..")
        || url.path() == "/inference"
    {
        return Err(anyhow!("Untrusted OpenCode Console inference URL"));
    }
    let suffix = match format {
        "openai" => "chat/completions",
        "responses" => "responses",
        "anthropic" => "messages",
        _ => return Err(anyhow!("Unsupported OpenCode Console request format")),
    };
    Ok(ConsoleRoute {
        base_url: base.to_string(),
        request_url: format!("{base}/{suffix}"),
        format: format.to_string(),
        headers: HashMap::new(),
    })
}

fn console_headers(value: Option<&serde_json::Value>) -> Result<HashMap<String, String>> {
    let mut headers = HashMap::new();
    if let Some(value) = value.filter(|value| !value.is_null()) {
        let value = value
            .as_object()
            .ok_or_else(|| anyhow!("Invalid OpenCode Console account headers"))?;
        for (name, value) in value {
            let name = name.to_ascii_lowercase();
            // Account routing metadata may contain organization identity, never secrets.
            if name != "x-opencode-org-id" {
                return Err(anyhow!("Unsupported OpenCode Console account header"));
            }
            let value = value
                .as_str()
                .ok_or_else(|| anyhow!("Invalid OpenCode Console account header"))?;
            reqwest::header::HeaderValue::from_str(value)
                .context("Invalid OpenCode Console account header")?;
            headers.insert(name, value.to_string());
        }
    }
    Ok(headers)
}

fn console_routes(config: &serde_json::Value) -> Result<HashMap<String, ConsoleRoute>> {
    let provider = config
        .pointer("/provider/opencode")
        .ok_or_else(|| anyhow!("OpenCode Console returned no Zen provider configuration"))?;
    let provider_key = provider
        .pointer("/options/apiKey")
        .and_then(serde_json::Value::as_str);
    let provider_headers = console_headers(provider.pointer("/options/headers"))?;
    let mut routes = HashMap::new();
    if let Some(models) = provider
        .get("models")
        .and_then(serde_json::Value::as_object)
    {
        for (id, model) in models {
            if model.get("status").and_then(serde_json::Value::as_str) == Some("deprecated") {
                continue;
            }
            let key = model
                .pointer("/options/apiKey")
                .and_then(serde_json::Value::as_str)
                .or(provider_key);
            if key != Some("{env:OPENCODE_CONSOLE_TOKEN}") {
                return Err(anyhow!("Unsupported OpenCode Console credential binding"));
            }
            let npm = model
                .pointer("/provider/npm")
                .and_then(serde_json::Value::as_str)
                .or_else(|| provider.get("npm").and_then(serde_json::Value::as_str));
            let api = model
                .pointer("/provider/api")
                .and_then(serde_json::Value::as_str)
                .or_else(|| provider.get("api").and_then(serde_json::Value::as_str));
            let Some(format) = format_for_remote_model(npm, api) else {
                continue;
            };
            let api = api.ok_or_else(|| anyhow!("Missing OpenCode Console inference URL"))?;
            // Sparse account overrides can leave public-only models in the base
            // catalog. They are not Console OAuth offerings.
            if crate::providers::shared::is_https_endpoint(api, "opencode.ai", "/zen") {
                continue;
            }
            let mut route = console_route(api, format)?;
            route.headers = provider_headers.clone();
            route.headers.extend(console_headers(model.get("headers"))?);
            let wire_id = model
                .get("id")
                .and_then(serde_json::Value::as_str)
                .unwrap_or(id);
            routes.insert(wire_id.to_string(), route);
        }
    }
    Ok(routes)
}

fn console_offerings(
    config: &serde_json::Value,
    routes: &HashMap<String, ConsoleRoute>,
) -> Vec<SubscriptionApiOffering> {
    let mut offerings: Vec<SubscriptionApiOffering> = Vec::new();
    let names: HashMap<String, String> = config
        .pointer("/provider/opencode/models")
        .and_then(serde_json::Value::as_object)
        .into_iter()
        .flatten()
        .filter_map(|(id, model)| {
            Some((
                model
                    .get("id")
                    .and_then(serde_json::Value::as_str)
                    .unwrap_or(id)
                    .to_string(),
                model.get("name")?.as_str()?.to_string(),
            ))
        })
        .collect();
    let mut models: Vec<_> = routes.iter().collect();
    models.sort_by_key(|(id, _)| *id);
    for (id, route) in models {
        let index = offerings
            .iter()
            .position(|item| item.format == route.format && item.base_url == route.base_url)
            .unwrap_or_else(|| {
                offerings.push(SubscriptionApiOffering {
                    plan: OpenCodePlan::Zen,
                    format: route.format.clone(),
                    base_url: route.base_url.clone(),
                    suggested_model: id.clone(),
                    models: Vec::new(),
                });
                offerings.len() - 1
            });
        offerings[index].models.push(SubscriptionOfferingModel {
            id: id.clone(),
            display_name: names.get(id).cloned(),
        });
    }
    offerings
}

fn http_client(options: &SubscriptionHttpOptions) -> Result<reqwest::Client> {
    super::build_http_client(options, "OpenCode")
}

fn now_ms() -> i64 {
    chrono::Utc::now().timestamp_millis()
}

async fn request_device_code(options: &SubscriptionHttpOptions) -> Result<DeviceCodeResponse> {
    let client = http_client(options)?;
    let resp = client
        .post(format!("{SERVER}/auth/device/code"))
        .json(&serde_json::json!({ "client_id": CLIENT_ID }))
        .send()
        .await
        .context("call opencode device code endpoint")?;
    if !resp.status().is_success() {
        let status = resp.status();
        let body = resp.text().await.unwrap_or_default();
        return Err(anyhow!(
            "opencode device authorization failed: HTTP {status}: {body}"
        ));
    }
    resp.json().await.context("parse opencode device response")
}

fn classify_device_poll_error(
    status: reqwest::StatusCode,
    pending: &PendingResponse,
) -> Result<DevicePoll<TokenResponse>> {
    match pending.error.as_str() {
        "authorization_pending" => Ok(DevicePoll::Pending),
        "slow_down" => Ok(DevicePoll::SlowDown),
        "expired_token" => Err(anyhow!("opencode device authorization code expired")),
        "access_denied" | "authorization_denied" => {
            Err(anyhow!("opencode device authorization was denied"))
        }
        other => {
            let detail = pending
                .error_description
                .as_deref()
                .filter(|value| !value.trim().is_empty())
                .unwrap_or(other);
            Err(anyhow!(
                "opencode device authorization failed: HTTP {status}: {detail}"
            ))
        }
    }
}

/// One poll attempt against the device-token endpoint.
async fn poll_once(
    device_code: &str,
    options: &SubscriptionHttpOptions,
) -> Result<DevicePoll<TokenResponse>> {
    let client = http_client(options)?;
    let resp = client
        .post(format!("{SERVER}/auth/device/token"))
        .json(&serde_json::json!({
            "grant_type": DEVICE_GRANT,
            "device_code": device_code,
            "client_id": CLIENT_ID,
        }))
        .send()
        .await
        .context("call opencode device token endpoint")?;
    let status = resp.status();
    let body = resp.text().await.unwrap_or_default();
    if status.is_success() {
        let tokens = serde_json::from_str::<TokenResponse>(&body)
            .context("parse opencode device token response")?;
        return Ok(DevicePoll::Authorized(tokens));
    }
    if let Ok(pending) = serde_json::from_str::<PendingResponse>(&body) {
        return classify_device_poll_error(status, &pending);
    }
    Err(anyhow!(
        "opencode device token response unrecognized: HTTP {status}: {body}"
    ))
}

fn empty_offering(plan: OpenCodePlan, format: &str) -> SubscriptionApiOffering {
    SubscriptionApiOffering {
        plan,
        format: format.to_string(),
        base_url: ZEN_BASE_URL.to_string(),
        suggested_model: String::new(),
        models: Vec::new(),
    }
}

fn fallback_offerings() -> Vec<SubscriptionApiOffering> {
    [OpenCodePlan::Zen]
        .into_iter()
        .flat_map(|plan| {
            SUPPORTED_FORMATS
                .into_iter()
                .map(move |format| empty_offering(plan, format))
        })
        .collect()
}

fn canonicalize_offerings(
    offerings: impl IntoIterator<Item = SubscriptionApiOffering>,
) -> Vec<SubscriptionApiOffering> {
    let mut result = fallback_offerings();

    for mut offering in offerings {
        if offering.plan != OpenCodePlan::Zen {
            continue;
        }
        let normalized_format = offering.format.trim().to_ascii_lowercase();
        let normalized_format = match normalized_format.as_str() {
            "response" | "responses" => "responses",
            "openai" => "openai",
            "anthropic" => "anthropic",
            _ => continue,
        };
        offering.format = normalized_format.to_string();
        offering.base_url = ZEN_BASE_URL.to_string();

        let mut seen = HashSet::new();
        offering.models.retain(|model| {
            let id = model.id.trim();
            !id.is_empty() && seen.insert(id.to_ascii_lowercase())
        });
        offering.models.sort_by(|left, right| {
            left.display_name
                .as_deref()
                .unwrap_or(&left.id)
                .to_ascii_lowercase()
                .cmp(
                    &right
                        .display_name
                        .as_deref()
                        .unwrap_or(&right.id)
                        .to_ascii_lowercase(),
                )
                .then_with(|| left.id.cmp(&right.id))
        });
        offering.suggested_model = offering
            .models
            .first()
            .map(|model| model.id.clone())
            .unwrap_or_default();

        if let Some(slot) = result.iter_mut().find(|candidate| {
            candidate.plan == offering.plan && candidate.format == offering.format
        }) {
            *slot = offering;
        }
    }

    result
}

fn format_for_remote_model(npm: Option<&str>, api: Option<&str>) -> Option<&'static str> {
    let package = npm.unwrap_or_default().to_ascii_lowercase();
    if package.contains("openai-compatible") {
        return Some("openai");
    }
    if package.contains("anthropic") {
        return Some("anthropic");
    }
    if package == "@ai-sdk/openai" || package.ends_with("/openai") {
        return Some("responses");
    }

    let api = api.unwrap_or_default().trim_end_matches('/');
    if api.ends_with("/chat/completions") {
        Some("openai")
    } else if api.ends_with("/responses") {
        Some("responses")
    } else if api.ends_with("/messages") {
        Some("anthropic")
    } else {
        None
    }
}

pub(crate) fn offerings_from_metadata(
    metadata: Option<&serde_json::Value>,
) -> Vec<SubscriptionApiOffering> {
    let parsed = metadata
        .and_then(|value| value.get(OFFERINGS_METADATA_KEY))
        .cloned()
        .and_then(|value| serde_json::from_value::<Vec<SubscriptionApiOffering>>(value).ok());
    if metadata
        .and_then(|value| value.get(CONSOLE_ROUTES_KEY))
        .is_some()
    {
        return parsed
            .unwrap_or_default()
            .into_iter()
            .filter(|item| {
                item.plan == OpenCodePlan::Zen
                    && console_route(&item.base_url, &item.format).is_ok()
            })
            .collect();
    }
    canonicalize_offerings(parsed.unwrap_or_default())
}

async fn fetch_remote_offerings(
    client: &reqwest::Client,
    access: &str,
    org_id: Option<&str>,
) -> Result<(Vec<SubscriptionApiOffering>, HashMap<String, ConsoleRoute>)> {
    let mut catalog = crate::opencode_catalog::base_catalog_value(client).await?;
    let mut request = client
        .get(format!("{SERVER}/api/config"))
        .bearer_auth(access);
    if let Some(org_id) = org_id {
        request = request.header("x-org-id", org_id);
    }
    let response = request
        .send()
        .await
        .context("fetch OpenCode provider catalog")?;
    if !response.status().is_success() {
        return Err(anyhow!(
            "OpenCode provider catalog failed: HTTP {}",
            response.status()
        ));
    }
    let remote = response
        .json::<RemoteConfigResponse>()
        .await
        .context("parse OpenCode provider catalog")?;
    merge_catalog_override(&mut catalog, remote.config);
    let routes = console_routes(&catalog)?;
    Ok((console_offerings(&catalog, &routes), routes))
}

fn merge_catalog_override(base: &mut serde_json::Value, overlay: serde_json::Value) {
    match (base, overlay) {
        (serde_json::Value::Object(base), serde_json::Value::Object(overlay)) => {
            for (key, value) in overlay {
                merge_catalog_override(base.entry(key).or_insert(serde_json::Value::Null), value);
            }
        }
        (base, value) => *base = value,
    }
}

fn persist_catalog_metadata(
    metadata: &mut serde_json::Map<String, serde_json::Value>,
    offerings: Vec<SubscriptionApiOffering>,
    routes: HashMap<String, ConsoleRoute>,
) -> Result<()> {
    metadata.insert(
        OFFERINGS_METADATA_KEY.to_string(),
        serde_json::to_value(offerings)?,
    );
    metadata.insert(
        CONSOLE_ROUTES_KEY.to_string(),
        serde_json::to_value(routes)?,
    );
    Ok(())
}

async fn fetch_metadata(
    access: &str,
    existing: Option<&serde_json::Value>,
    options: &SubscriptionHttpOptions,
    require_catalog: bool,
) -> Result<serde_json::Value> {
    let mut metadata = existing
        .and_then(serde_json::Value::as_object)
        .cloned()
        .unwrap_or_default();
    metadata.insert(
        "server".to_string(),
        serde_json::Value::String(SERVER.to_string()),
    );
    let client = http_client(options)?;

    if let Ok(resp) = client
        .get(format!("{SERVER}/api/user"))
        .bearer_auth(access)
        .send()
        .await
    {
        if let Ok(user) = resp.json::<UserResponse>().await {
            if let Some(email) = user.email {
                metadata.insert("email".to_string(), serde_json::Value::String(email));
            }
            if let Some(id) = user.id {
                metadata.insert("account_id".to_string(), serde_json::Value::String(id));
            }
        }
    }

    if let Ok(resp) = client
        .get(format!("{SERVER}/api/orgs"))
        .bearer_auth(access)
        .send()
        .await
    {
        if let Ok(mut orgs) = resp.json::<Vec<OrgResponse>>().await {
            orgs.sort_by(|a, b| {
                a.name
                    .as_deref()
                    .unwrap_or_default()
                    .cmp(b.name.as_deref().unwrap_or_default())
                    .then_with(|| {
                        a.id.as_deref()
                            .unwrap_or_default()
                            .cmp(b.id.as_deref().unwrap_or_default())
                    })
            });
            if let Some(org) = orgs.into_iter().next() {
                if let Some(id) = org.id {
                    metadata.insert("org_id".to_string(), serde_json::Value::String(id));
                }
                if let Some(name) = org.name {
                    metadata.insert("org_name".to_string(), serde_json::Value::String(name));
                }
            }
        }
    }

    let org_id = metadata.get("org_id").and_then(serde_json::Value::as_str);
    match fetch_remote_offerings(&client, access, org_id).await {
        Ok((offerings, routes)) => {
            persist_catalog_metadata(&mut metadata, offerings, routes)?;
        }
        Err(error) if require_catalog => return Err(error),
        Err(error) => log::warn!("OpenCode signed in without a refreshed model catalog: {error:#}"),
    }

    Ok(serde_json::Value::Object(metadata))
}

async fn persist_tokens_for_account(
    slot: &str,
    tokens: TokenResponse,
    metadata: serde_json::Value,
    expected_revision: u64,
) -> Result<()> {
    let expires = now_ms() + tokens.expires_in * 1000;
    let outcome = super::accounts::persist_account_credential(
        super::SubscriptionProvider::Opencode,
        slot,
        expected_revision,
        StoredCredential::Oauth {
            refresh: tokens.refresh_token,
            access: tokens.access_token,
            expires,
            account_id: metadata
                .get("account_id")
                .and_then(serde_json::Value::as_str)
                .map(str::to_string),
            metadata: Some(metadata),
        },
    )
    .await?;
    super::require_current_store_revision(super::SubscriptionProvider::Opencode, outcome)?;
    log::info!("opencode subscription tokens saved");
    Ok(())
}

async fn refresh(refresh_token: &str, options: &SubscriptionHttpOptions) -> Result<TokenResponse> {
    let client = http_client(options)?;
    let resp = client
        .post(format!("{SERVER}/auth/device/token"))
        .json(&serde_json::json!({
            "grant_type": "refresh_token",
            "refresh_token": refresh_token,
            "client_id": CLIENT_ID,
        }))
        .send()
        .await
        .context("call opencode device token endpoint")?;
    if !resp.status().is_success() {
        let status = resp.status();
        let body = resp.text().await.unwrap_or_default();
        return Err(anyhow!(
            "opencode token refresh failed: HTTP {status}: {body}"
        ));
    }
    resp.json().await.context("parse opencode token response")
}

/// Resolves OpenCode's device verification URI to an absolute URL.
///
/// The console API returns a path such as `/device?user_code=...` (same as
/// OpenCode's own client, which resolves relative paths against its console base URL).
fn absolute_verification_url(uri: &str) -> Result<String> {
    let trimmed = uri.trim();
    if trimmed.is_empty()
        || trimmed
            .chars()
            .any(|character| character.is_ascii_control())
    {
        return Err(anyhow!(
            "OpenCode returned an invalid device verification URL"
        ));
    }
    let base =
        reqwest::Url::parse(&format!("{SERVER}/")).context("parse OpenCode Console base URL")?;
    let resolved = base
        .join(trimmed)
        .context("resolve OpenCode device verification URL")?;
    if !matches!(resolved.scheme(), "http" | "https") || resolved.host_str().is_none() {
        return Err(anyhow!(
            "OpenCode returned an unsupported device verification URL"
        ));
    }
    Ok(resolved.to_string())
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
    let interval = device.interval.unwrap_or(5).max(1);
    let expires_in = device
        .expires_in
        .unwrap_or(super::LOGIN_TIMEOUT.as_secs())
        .max(1)
        .min(super::LOGIN_TIMEOUT.as_secs());
    let device_code = device.device_code.clone();
    let user_code = device.user_code.clone();
    let authorization_url = absolute_verification_url(&device.verification_uri_complete)?;

    let runner = async move {
        super::authorize_then_persist(
            super::SubscriptionProvider::Opencode,
            cancel,
            async {
                let tokens = poll_device_code(
                    Duration::from_secs(interval),
                    Duration::from_secs(expires_in),
                    Duration::ZERO,
                    false,
                    || poll_once(&device_code, &options),
                )
                .await
                .context("complete OpenCode device authorization")?;
                // Keep optional profile/catalog IO outside the credential commit lock.
                let metadata = fetch_metadata(&tokens.access_token, None, &options, false).await?;
                Ok((tokens, metadata))
            },
            move |(tokens, metadata)| async move {
                persist_tokens_for_account(&slot, tokens, metadata, expected_revision).await
            },
        )
        .await
    };

    Ok(StartedLogin {
        method: super::SubscriptionLoginMethod::Device,
        authorization_url,
        user_code: Some(user_code),
        instructions: "Open the verification link and enter the code, then return to OpenBitFun."
            .to_string(),
        runner: Box::pin(runner),
    })
}

async fn ensure_fresh_for_account(
    slot: &str,
    rejected_access: Option<&str>,
    options: &SubscriptionHttpOptions,
) -> Result<FreshCredential> {
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
) -> Result<FreshCredential> {
    let _refresh_lease = store::acquire_provider_refresh_lease(slot).await?;
    let snapshot = store::load_entry_with_revision(slot).await?;
    let entry = snapshot
        .credential
        .ok_or_else(|| anyhow!("OpenCode is not connected; sign in first"))?;
    match entry {
        StoredCredential::Api { key, metadata } => Ok(FreshCredential {
            access: key,
            expires_at_ms: None,
            metadata,
        }),
        StoredCredential::Oauth {
            refresh: refresh_token,
            access,
            expires,
            account_id,
            metadata,
        } => {
            if rejected_access != Some(access.as_str()) && expires > now_ms() + REFRESH_LEEWAY_MS {
                return Ok(FreshCredential {
                    access,
                    expires_at_ms: Some(expires),
                    metadata,
                });
            }
            let refreshed = refresh(&refresh_token, options).await?;
            let new_expires = now_ms() + refreshed.expires_in * 1000;
            let refreshed_access = refreshed.access_token.clone();
            let refreshed_metadata = metadata.clone();
            let outcome = super::accounts::persist_account_credential(
                super::SubscriptionProvider::Opencode,
                slot,
                snapshot.revision,
                StoredCredential::Oauth {
                    refresh: refreshed.refresh_token,
                    access: refreshed_access.clone(),
                    expires: new_expires,
                    account_id,
                    metadata,
                },
            )
            .await?;
            match outcome {
                store::ConditionalCommitOutcome::Committed { .. } => {
                    log::info!("opencode subscription tokens refreshed");
                    Ok(FreshCredential {
                        access: refreshed_access,
                        expires_at_ms: Some(new_expires),
                        metadata: refreshed_metadata,
                    })
                }
                store::ConditionalCommitOutcome::Conflict { current_revision } => {
                    let current = super::load_account_store_after_conflict(
                        super::SubscriptionProvider::Opencode,
                        slot,
                        current_revision,
                    )
                    .await?;
                    match current.credential {
                        Some(StoredCredential::Api { key, metadata }) => {
                            log::info!(
                                "opencode refresh reused the current API credential after a concurrent update"
                            );
                            Ok(FreshCredential {
                                access: key,
                                expires_at_ms: None,
                                metadata,
                            })
                        }
                        Some(StoredCredential::Oauth {
                            access,
                            expires,
                            metadata,
                            ..
                        }) if expires > now_ms() => {
                            log::info!(
                                "opencode refresh reused tokens committed by a concurrent refresh"
                            );
                            Ok(FreshCredential {
                                access,
                                expires_at_ms: Some(expires),
                                metadata,
                            })
                        }
                        _ => Err(super::store_revision_conflict(
                            super::SubscriptionProvider::Opencode,
                            current_revision,
                        )),
                    }
                }
            }
        }
    }
}

/// Refreshes account/org/catalog metadata using a fresh credential.
pub(crate) async fn refresh_account_profile(
    slot: &str,
    options: &SubscriptionHttpOptions,
) -> Result<()> {
    ensure_fresh_for_account(slot, None, options).await?;
    let snapshot = store::load_entry_with_revision(slot).await?;
    let entry = snapshot
        .credential
        .ok_or_else(|| anyhow!("OpenCode is not connected; sign in first"))?;
    // Bind the network credential to the same snapshot that is updated by CAS.
    // A sign-in between refresh and snapshot load must not attach the old
    // account's profile/catalog to the new account's credential.
    let (access, existing_metadata) = match &entry {
        StoredCredential::Oauth {
            access, metadata, ..
        } => (access, metadata.as_ref()),
        StoredCredential::Api { key, metadata } => (key, metadata.as_ref()),
    };
    let metadata = fetch_metadata(access, existing_metadata, options, true).await?;
    if existing_metadata == Some(&metadata) {
        return Ok(());
    }

    let updated = match entry {
        StoredCredential::Oauth {
            refresh,
            access,
            expires,
            account_id,
            ..
        } => StoredCredential::Oauth {
            refresh,
            access,
            expires,
            account_id: metadata
                .get("account_id")
                .and_then(serde_json::Value::as_str)
                .map(str::to_string)
                .or(account_id),
            metadata: Some(metadata),
        },
        StoredCredential::Api { key, .. } => StoredCredential::Api {
            key,
            metadata: Some(metadata),
        },
    };
    let outcome = super::accounts::persist_account_credential(
        super::SubscriptionProvider::Opencode,
        slot,
        snapshot.revision,
        updated,
    )
    .await?;
    super::require_current_store_revision(super::SubscriptionProvider::Opencode, outcome)?;
    log::info!("opencode account metadata refreshed");
    Ok(())
}

fn inference_headers() -> HashMap<String, String> {
    HashMap::from([
        (
            "User-Agent".to_string(),
            crate::providers::shared::product_user_agent(),
        ),
        ("x-opencode-client".to_string(), "openbitfun".to_string()),
    ])
}

fn route_for_model(
    plan: Option<OpenCodePlan>,
    configured_format: &str,
    model: &str,
    metadata: Option<&serde_json::Value>,
) -> Result<ConsoleRoute> {
    if plan == Some(OpenCodePlan::Go) {
        return Err(anyhow!(super::OPENCODE_GO_REQUIRES_API_KEY));
    }
    let routes: HashMap<String, ConsoleRoute> = serde_json::from_value(
        metadata
            .and_then(|value| value.get(CONSOLE_ROUTES_KEY))
            .cloned()
            .ok_or_else(|| anyhow!("OpenCode Console routing needs an account refresh"))?,
    )?;
    let route = routes.get(model.trim()).or_else(|| {
        // Legacy format-only callers have no model identity.
        model.is_empty().then(|| routes.values().find(|route| route.format == configured_format)).flatten()
    }).ok_or_else(|| anyhow!("OpenCode Console returned no supported route for this model; refresh the account model list"))?;
    let validated = console_route(&route.base_url, &route.format)?;
    if route.request_url != validated.request_url {
        return Err(anyhow!("Invalid stored OpenCode Console request URL"));
    }
    console_headers(Some(&serde_json::to_value(&route.headers)?))?;
    Ok(route.clone())
}

/// Account catalog owns the protocol; callers select only a plan and model.
/// Legacy credentials lazily acquire account routing without resetting saved models.
pub(crate) async fn resolve_account_for_model(
    slot: &str,
    plan: Option<OpenCodePlan>,
    configured_format: &str,
    model: &str,
    options: &SubscriptionHttpOptions,
) -> Result<ResolvedCredential> {
    if plan == Some(OpenCodePlan::Go) {
        return Err(anyhow!(super::OPENCODE_GO_REQUIRES_API_KEY));
    }
    let mut credential = ensure_fresh_for_account(slot, None, options).await?;
    if credential
        .metadata
        .as_ref()
        .and_then(|value| value.get(CONSOLE_ROUTES_KEY))
        .is_none()
    {
        refresh_account_profile(slot, options).await?;
        credential = ensure_fresh_for_account(slot, None, options).await?;
    }
    let route = route_for_model(plan, configured_format, model, credential.metadata.as_ref())?;
    let mut extra_headers = inference_headers();
    extra_headers.extend(route.headers.clone());
    Ok(ResolvedCredential {
        api_key: credential.access,
        base_url: Some(route.base_url.to_string()),
        request_url: Some(route.request_url.to_string()),
        format: Some(route.format.to_string()),
        extra_headers,
        expires_at: credential.expires_at_ms.map(|expires| expires / 1000),
    })
}

/// Resolves the legacy format-only entry through the current account catalog.
pub(crate) async fn resolve(options: &SubscriptionHttpOptions) -> Result<ResolvedCredential> {
    resolve_for_model(Some(OpenCodePlan::Zen), "openai", "", options).await
}

/// Resolves a concrete OpenCode plan and wire format to a trusted endpoint.
pub(crate) async fn resolve_for(
    plan: OpenCodePlan,
    format: &str,
    options: &SubscriptionHttpOptions,
) -> Result<ResolvedCredential> {
    resolve_for_model(Some(plan), format, "", options).await
}

/// Provider metadata used to seed a new model entry.
pub(crate) fn suggested() -> (&'static str, &'static str, &'static str) {
    ("openai", ZEN_BASE_URL, DEFAULT_MODEL)
}

pub(crate) async fn refresh_profile(options: &SubscriptionHttpOptions) -> Result<()> {
    refresh_account_profile(STORE_KEY, options).await
}
pub(crate) async fn resolve_for_model(
    plan: Option<OpenCodePlan>,
    format: &str,
    model: &str,
    options: &SubscriptionHttpOptions,
) -> Result<ResolvedCredential> {
    resolve_account_for_model(STORE_KEY, plan, format, model, options).await
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

    fn account_fixture() -> serde_json::Value {
        serde_json::json!({"provider":{"opencode":{
            "api":"https://opencode.ai/inference/openai/v1",
            "npm":"@ai-sdk/openai-compatible",
            "options":{"apiKey":"{env:OPENCODE_CONSOLE_TOKEN}","headers":{"x-opencode-org-id":"fixture-org"}},
            "models":{
                "big-pickle":{"name":"Big Pickle","provider":null},
                "response-model":{"provider":{"npm":"@ai-sdk/openai","api":"https://opencode.ai/inference/openai/v1"}},
                "message-model":{"provider":{"npm":"@ai-sdk/anthropic","api":"https://opencode.ai/inference/anthropic/v1"},"headers":{"x-opencode-org-id":"model-org"}}
            }
        }}})
    }

    #[test]
    fn account_routes_preserve_endpoint_protocol_and_org_without_secrets() {
        let config = account_fixture();
        let routes = console_routes(&config).unwrap();
        let offerings = console_offerings(&config, &routes);
        let metadata =
            serde_json::json!({CONSOLE_ROUTES_KEY: routes, OFFERINGS_METADATA_KEY: offerings});
        let decoded = offerings_from_metadata(Some(&metadata));
        assert_eq!(decoded.len(), 3);
        for (id, format, suffix, org) in [
            (
                "big-pickle",
                "openai",
                "openai/v1/chat/completions",
                "fixture-org",
            ),
            (
                "response-model",
                "responses",
                "openai/v1/responses",
                "fixture-org",
            ),
            (
                "message-model",
                "anthropic",
                "anthropic/v1/messages",
                "model-org",
            ),
        ] {
            let route = route_for_model(None, "openai", id, Some(&metadata)).unwrap();
            assert_eq!(route.format, format);
            assert_eq!(
                route.request_url,
                format!("https://opencode.ai/inference/{suffix}")
            );
            assert_eq!(route.headers["x-opencode-org-id"], org);
            assert!(!route.headers.contains_key("x-org-id"));
        }
        assert!(!metadata.to_string().contains("OPENCODE_CONSOLE_TOKEN"));
        assert!(route_for_model(
            Some(OpenCodePlan::Go),
            "openai",
            "big-pickle",
            Some(&metadata)
        )
        .is_err());
        assert!(route_for_model(None, "openai", "unknown", Some(&metadata)).is_err());
    }

    #[test]
    fn refreshed_catalog_persists_separate_offerings_and_routes_and_repairs_previous_shape() {
        let config = account_fixture();
        let routes = console_routes(&config).unwrap();
        let offerings = console_offerings(&config, &routes);
        // The previous implementation accidentally serialized this tuple into
        // api_offerings, leaving console_routes_v1 absent.
        let broken = serde_json::to_value((&offerings, &routes)).unwrap();
        for old in [
            serde_json::json!({"org_id":"legacy-org"}),
            serde_json::json!({"org_id":"legacy-org","api_offerings":broken}),
        ] {
            let mut metadata = old.as_object().unwrap().clone();
            persist_catalog_metadata(&mut metadata, offerings.clone(), routes.clone()).unwrap();
            let stored = serde_json::to_string(&metadata).unwrap();
            let reloaded: serde_json::Value = serde_json::from_str(&stored).unwrap();
            assert_eq!(reloaded["org_id"], "legacy-org");
            assert!(reloaded.get(CONSOLE_ROUTES_KEY).unwrap().is_object());
            let parsed: Vec<SubscriptionApiOffering> =
                serde_json::from_value(reloaded[OFFERINGS_METADATA_KEY].clone()).unwrap();
            assert_eq!(parsed.len(), 3);
            assert_eq!(offerings_from_metadata(Some(&reloaded)).len(), 3);
            let route = route_for_model(None, "openai", "big-pickle", Some(&reloaded)).unwrap();
            assert_eq!(
                route.request_url,
                "https://opencode.ai/inference/openai/v1/chat/completions"
            );
            assert_eq!(route.headers["x-opencode-org-id"], "fixture-org");
        }
    }

    #[test]
    fn sparse_overrides_keep_inherited_models_but_exclude_public_key_routes() {
        let mut base = serde_json::json!({"provider":{"opencode":{
            "npm":"@ai-sdk/openai-compatible", "api":"https://opencode.ai/zen/v1",
            "models":{"inherited":{"provider":null},"public-only":{"provider":{"api":"https://opencode.ai/zen/v1"}}}
        }}});
        merge_catalog_override(&mut base, account_fixture());
        let routes = console_routes(&base).unwrap();
        assert_eq!(
            routes["inherited"].request_url,
            "https://opencode.ai/inference/openai/v1/chat/completions"
        );
        assert!(routes.contains_key("big-pickle"));
        assert!(!routes.contains_key("public-only"));
    }

    #[test]
    fn rejects_public_foreign_and_malformed_oauth_routes_and_keys() {
        for url in [
            "https://opencode.ai/zen/v1",
            "https://opencode.ai/zen/go/v1",
            "https://evil.invalid/inference/openai/v1",
            "http://opencode.ai/inference/openai/v1",
            "https://opencode.ai:444/inference/openai/v1",
            "https://user@opencode.ai/inference/openai/v1",
            "https://opencode.ai/inference/openai/v1?key=x",
            "https://opencode.ai/inference/../zen/v1",
            "https://opencode.ai/inference/%2e%2e/zen/v1",
            "https://opencode.ai/inference/openai/v1#x",
        ] {
            assert!(console_route(url, "openai").is_err(), "{url}");
        }
        let mut config = account_fixture();
        config["provider"]["opencode"]["options"]["apiKey"] =
            serde_json::json!("unexpected-secret");
        assert!(console_routes(&config).is_err());
        config["provider"]["opencode"]["options"]["apiKey"] =
            serde_json::json!("{env:OPENCODE_CONSOLE_TOKEN}");
        config["provider"]["opencode"]["options"]["headers"]["Authorization"] =
            serde_json::json!("secret");
        assert!(console_routes(&config).is_err());
    }

    #[test]
    fn legacy_metadata_is_readable_but_requires_account_routing_refresh() {
        let metadata = serde_json::json!({"orgID":"old-org", "api_offerings":[
            {"plan":"zen","format":"openai","base_url":"https://opencode.ai/zen/v1","suggested_model":"big-pickle","models":[{"id":"big-pickle"}]}
        ]});
        let round_trip: serde_json::Value = serde_json::from_str(&metadata.to_string()).unwrap();
        assert_eq!(metadata, round_trip);
        assert!(offerings_from_metadata(Some(&round_trip))
            .iter()
            .any(|item| !item.models.is_empty()));
        assert!(route_for_model(None, "openai", "big-pickle", Some(&round_trip)).is_err());
    }

    #[test]
    fn prefixes_relative_device_verification_path() {
        assert_eq!(
            absolute_verification_url("/device?user_code=FBPH-VLFC&client_id=opencode-cli")
                .unwrap(),
            "https://opencode.ai/device?user_code=FBPH-VLFC&client_id=opencode-cli"
        );
        assert_eq!(
            absolute_verification_url("device?user_code=FBPH-VLFC").unwrap(),
            "https://opencode.ai/console/device?user_code=FBPH-VLFC"
        );
    }

    #[test]
    fn keeps_absolute_verification_url() {
        assert_eq!(
            absolute_verification_url(
                "https://opencode.ai/console/device?user_code=ABCD-1234&client_id=opencode-cli"
            )
            .unwrap(),
            "https://opencode.ai/console/device?user_code=ABCD-1234&client_id=opencode-cli"
        );
        assert!(absolute_verification_url("javascript:alert(1)").is_err());
    }

    #[test]
    fn device_poll_errors_distinguish_pending_and_terminal_outcomes() {
        let pending = PendingResponse {
            error: "authorization_pending".to_string(),
            error_description: None,
        };
        assert!(matches!(
            classify_device_poll_error(reqwest::StatusCode::BAD_REQUEST, &pending).unwrap(),
            DevicePoll::Pending
        ));

        for error in ["expired_token", "access_denied"] {
            let terminal = PendingResponse {
                error: error.to_string(),
                error_description: Some("terminal".to_string()),
            };
            assert!(
                classify_device_poll_error(reqwest::StatusCode::BAD_REQUEST, &terminal).is_err()
            );
        }
    }
}
