//! Google Cloud Code Assist transport (`cloudcode-pa.googleapis.com`).
//!
//! Used by `gemini-cli` after a personal Google login. The endpoint accepts the
//! regular Gemini request body but wrapped in
//! `{ "model": "...", "project": "...", "request": { ... } }` and authenticated
//! with a Bearer access_token (we don't pass `x-goog-api-key`).

use super::{request as gemini_request, GeminiMessageConverter};
use crate::client::sse::execute_sse_request;
use crate::client::{AIClient, StreamResponse};
use crate::providers::shared;
use crate::stream::handle_gemini_code_assist_stream;
use crate::trace::ModelExchangeTraceConfig;
use crate::types::{Message, RemoteModelInfo, ToolDefinition};
use anyhow::{anyhow, Context, Result};
use log::{debug, warn};
use openbitfun_core_types::errors::AiProviderError;
use reqwest::RequestBuilder;
use serde::Deserialize;
use sha2::{Digest, Sha256};
use std::path::{Path, PathBuf};
use std::sync::OnceLock;
use std::time::Duration;
use tokio::sync::Mutex;

const CODE_ASSIST_BASE: &str = "https://cloudcode-pa.googleapis.com";
pub(crate) const ANTIGRAVITY_DAILY_BASE: &str = "https://daily-cloudcode-pa.googleapis.com";
const ANTIGRAVITY_SANDBOX_BASE: &str = "https://daily-cloudcode-pa.sandbox.googleapis.com";
const STREAM_ENDPOINT: &str = "/v1internal:streamGenerateContent?alt=sse";
const AVAILABLE_MODELS_ENDPOINT: &str = "/v1internal:fetchAvailableModels";

fn cached_project() -> &'static Mutex<Option<(String, String)>> {
    static CACHE: OnceLock<Mutex<Option<(String, String)>>> = OnceLock::new();
    CACHE.get_or_init(|| Mutex::new(None))
}

pub(crate) fn apply_headers(client: &AIClient, builder: RequestBuilder) -> RequestBuilder {
    let has_custom_user_agent = client
        .config
        .custom_headers
        .as_ref()
        .is_some_and(|headers| {
            headers
                .keys()
                .any(|key| key.eq_ignore_ascii_case("user-agent"))
        });
    shared::apply_header_policy(client, builder, |builder| {
        let builder = builder
            .header("Content-Type", "application/json")
            .header("Authorization", format!("Bearer {}", client.config.api_key));
        if has_custom_user_agent {
            builder
        } else {
            builder.header("User-Agent", "OpenBitFun-CodeAssist/1.0")
        }
    })
}

#[derive(Debug, Deserialize)]
struct LoadCodeAssistResponse {
    #[serde(default, rename = "cloudaicompanionProject")]
    cloudaicompanion_project: Option<serde_json::Value>,
    #[serde(default, rename = "allowedTiers")]
    allowed_tiers: Vec<CodeAssistTier>,
    #[serde(default, rename = "ineligibleTiers")]
    ineligible_tiers: Vec<IneligibleTier>,
}

#[derive(Debug, Deserialize)]
struct IneligibleTier {
    #[serde(default, rename = "reasonMessage")]
    reason_message: String,
    #[serde(default, rename = "validationUrl")]
    validation_url: Option<String>,
}

impl LoadCodeAssistResponse {
    fn ineligibility_error(&self) -> Option<AiProviderError> {
        if self.ineligible_tiers.is_empty() {
            return None;
        }
        let reasons = self
            .ineligible_tiers
            .iter()
            .map(|tier| match &tier.validation_url {
                Some(url) => format!("{} ({url})", tier.reason_message),
                None => tier.reason_message.clone(),
            })
            .collect::<Vec<_>>()
            .join("; ");
        let mut error = AiProviderError::classified(
            format!("Antigravity account is not eligible: {reasons}"),
            openbitfun_core_types::errors::ErrorCategory::Permission,
        );
        error.provider = Some("Antigravity".to_string());
        Some(error)
    }
}

#[derive(Debug, Deserialize)]
struct CodeAssistTier {
    #[serde(default)]
    id: Option<String>,
    #[serde(default, rename = "isDefault")]
    is_default: Option<bool>,
}

#[derive(Debug, Deserialize)]
struct OnboardOperation {
    #[serde(default)]
    done: Option<bool>,
    #[serde(default)]
    response: Option<OnboardResponse>,
    #[serde(default)]
    error: Option<serde_json::Value>,
}

#[derive(Debug, Deserialize)]
struct OnboardResponse {
    #[serde(default, rename = "cloudaicompanionProject")]
    cloudaicompanion_project: Option<serde_json::Value>,
}

fn is_antigravity(client: &AIClient) -> bool {
    client
        .config
        .custom_headers
        .as_ref()
        .and_then(|headers| headers.get("Client-Metadata"))
        .is_some_and(|value| value.contains("ANTIGRAVITY"))
}

#[derive(Debug, PartialEq, Eq)]
struct AntigravityModelRoute {
    model: String,
    thinking_level: Option<String>,
    thinking_budget: Option<i64>,
}

fn configured_thinking_level(request: &serde_json::Value) -> Option<String> {
    request
        .get("generationConfig")
        .and_then(|value| value.get("thinkingConfig"))
        .and_then(|value| value.get("thinkingLevel"))
        .and_then(serde_json::Value::as_str)
        .map(str::trim)
        .filter(|value| !value.is_empty())
        .map(str::to_ascii_lowercase)
}

fn configured_thinking_budget(request: &serde_json::Value) -> Option<i64> {
    request
        .get("generationConfig")
        .and_then(|value| value.get("thinkingConfig"))
        .and_then(|value| {
            value
                .get("thinking_budget")
                .or_else(|| value.get("thinkingBudget"))
        })
        .and_then(serde_json::Value::as_i64)
        .filter(|value| *value > 0)
}

fn strip_thinking_tier(model: &str) -> (&str, Option<&str>) {
    for tier in ["minimal", "low", "medium", "high", "max"] {
        let suffix = format!("-{tier}");
        if let Some(base) = model.strip_suffix(suffix.as_str()) {
            return (base, Some(tier));
        }
    }
    (model, None)
}

/// Resolves current Antigravity wire ids and keeps old Gemini CLI preview ids
/// working for model configurations persisted by earlier OpenBitFun releases.
fn resolve_antigravity_model(
    configured_model: &str,
    request: &serde_json::Value,
) -> AntigravityModelRoute {
    let wire_model = configured_model.trim();
    let wire_model = wire_model
        .strip_prefix("antigravity-")
        .unwrap_or(wire_model);
    let normalized = configured_model.trim().to_ascii_lowercase();
    let normalized = normalized
        .strip_prefix("antigravity-")
        .unwrap_or(&normalized)
        .to_string();
    let normalized = normalized
        .strip_suffix("-preview-customtools")
        .or_else(|| normalized.strip_suffix("-preview"))
        .unwrap_or(&normalized)
        .to_string();
    let (base, requested_tier) = strip_thinking_tier(&normalized);
    let configured_level = configured_thinking_level(request);

    if matches!(base, "gemini-3-pro" | "gemini-3.1-pro") {
        let level = match requested_tier.or(configured_level.as_deref()) {
            Some("high") => "high",
            _ => "low",
        };
        return AntigravityModelRoute {
            model: format!("{base}-{level}"),
            thinking_level: Some(level.to_string()),
            thinking_budget: None,
        };
    }

    if base == "gemini-3-flash" {
        let level = match requested_tier.or(configured_level.as_deref()) {
            Some(level @ ("minimal" | "low" | "medium" | "high")) => level,
            _ => "low",
        };
        return AntigravityModelRoute {
            model: base.to_string(),
            thinking_level: Some(level.to_string()),
            thinking_budget: None,
        };
    }

    if base.starts_with("claude-") && base.contains("-thinking") {
        let thinking_budget = match requested_tier {
            Some("low") => 8_192,
            Some("medium") => 16_384,
            Some("high" | "max") => 32_768,
            _ => configured_thinking_budget(request).unwrap_or(32_768),
        };
        return AntigravityModelRoute {
            model: base.to_string(),
            thinking_level: None,
            thinking_budget: Some(thinking_budget),
        };
    }

    AntigravityModelRoute {
        // New catalog IDs are already wire IDs. Only the legacy aliases above
        // need translation; do not strip a future model's preview/tier suffix.
        model: wire_model.to_string(),
        thinking_level: None,
        thinking_budget: None,
    }
}

fn configure_antigravity_claude_tools(request: &mut serde_json::Value) {
    let request = request
        .as_object_mut()
        .expect("Gemini request body must be an object");
    let tool_config = request
        .entry("toolConfig")
        .or_insert_with(|| serde_json::json!({}));
    if !tool_config.is_object() {
        *tool_config = serde_json::json!({});
    }
    let tool_config = tool_config
        .as_object_mut()
        .expect("toolConfig must be an object");
    let function_calling = tool_config
        .entry("functionCallingConfig")
        .or_insert_with(|| serde_json::json!({}));
    if !function_calling.is_object() {
        *function_calling = serde_json::json!({});
    }
    function_calling
        .as_object_mut()
        .expect("functionCallingConfig must be an object")
        .insert(
            "mode".to_string(),
            serde_json::Value::String("VALIDATED".to_string()),
        );

    let Some(tools) = request
        .get_mut("tools")
        .and_then(serde_json::Value::as_array_mut)
    else {
        return;
    };
    for declarations in tools.iter_mut().filter_map(|tool| {
        tool.get_mut("functionDeclarations")
            .and_then(serde_json::Value::as_array_mut)
    }) {
        for declaration in declarations {
            let Some(declaration) = declaration.as_object_mut() else {
                continue;
            };
            let parameters = declaration
                .entry("parameters")
                .or_insert_with(|| serde_json::json!({ "type": "object" }));
            if !parameters.is_object() {
                *parameters = serde_json::json!({ "type": "object" });
            }
            let parameters = parameters
                .as_object_mut()
                .expect("tool parameters must be an object");
            let has_properties = parameters
                .get("properties")
                .and_then(serde_json::Value::as_object)
                .is_some_and(|properties| !properties.is_empty());
            if has_properties {
                continue;
            }
            parameters.insert("type".to_string(), serde_json::json!("object"));
            parameters.insert(
                "properties".to_string(),
                serde_json::json!({
                    "_placeholder": {
                        "type": "boolean",
                        "description": "Placeholder. Always pass true."
                    }
                }),
            );
            parameters.insert("required".to_string(), serde_json::json!(["_placeholder"]));
        }
    }
}

fn apply_antigravity_thinking(request: &mut serde_json::Value, route: &AntigravityModelRoute) {
    if route.model.starts_with("claude-") {
        configure_antigravity_claude_tools(request);
    }
    if route.thinking_level.is_none() && route.thinking_budget.is_none() {
        return;
    }
    if !request
        .get("generationConfig")
        .is_some_and(serde_json::Value::is_object)
    {
        request["generationConfig"] = serde_json::json!({});
    }
    let generation = request["generationConfig"]
        .as_object_mut()
        .expect("generationConfig must be an object");
    let thinking = generation
        .entry("thinkingConfig")
        .or_insert_with(|| serde_json::json!({}));
    if !thinking.is_object() {
        *thinking = serde_json::json!({});
    }
    let thinking = thinking
        .as_object_mut()
        .expect("thinkingConfig must be an object");

    if let Some(level) = &route.thinking_level {
        thinking.remove("thinkingBudget");
        thinking.remove("thinking_budget");
        thinking.insert("includeThoughts".to_string(), serde_json::Value::Bool(true));
        thinking.insert(
            "thinkingLevel".to_string(),
            serde_json::Value::String(level.clone()),
        );
    } else if let Some(budget) = route.thinking_budget {
        let include_thoughts = thinking
            .remove("includeThoughts")
            .and_then(|value| value.as_bool())
            .unwrap_or(true);
        thinking.remove("thinkingLevel");
        thinking.remove("thinkingBudget");
        thinking.insert(
            "include_thoughts".to_string(),
            serde_json::Value::Bool(include_thoughts),
        );
        thinking.insert(
            "thinking_budget".to_string(),
            serde_json::Value::Number(budget.into()),
        );
        let max_output_tokens = generation
            .get("maxOutputTokens")
            .and_then(serde_json::Value::as_i64);
        if max_output_tokens.is_none_or(|limit| limit <= budget) {
            generation.insert(
                "maxOutputTokens".to_string(),
                serde_json::Value::Number(64_000.into()),
            );
        }
    }
}

// HTTP Client-Metadata fingerprints are not the protobuf metadata accepted by
// loadCodeAssist. In particular, MACOS/WINDOWS are invalid body platform enums.
fn antigravity_metadata() -> serde_json::Value {
    serde_json::json!({ "ideType": "ANTIGRAVITY" })
}

fn antigravity_onboard_body(client: &AIClient, tier: &str) -> serde_json::Value {
    let mut metadata = serde_json::json!({
        "ide_type": "ANTIGRAVITY",
        "ide_name": "antigravity",
    });
    if let Some(version) = client
        .config
        .custom_headers
        .as_ref()
        .and_then(|headers| headers.get("User-Agent"))
        .and_then(|ua| ua.strip_prefix("antigravity/hub/"))
        .and_then(|ua| ua.split_whitespace().next())
    {
        metadata["ide_version"] = serde_json::json!(version);
    }
    serde_json::json!({ "tier_id": tier, "metadata": metadata })
}

fn antigravity_session_id(request: &serde_json::Value) -> String {
    let contents = request
        .get("contents")
        .and_then(serde_json::Value::as_array);
    let first_user =
        contents.and_then(|contents| contents.iter().find(|content| content["role"] == "user"));
    let text = first_user
        .and_then(|content| content["parts"].as_array())
        .and_then(|parts| {
            parts
                .iter()
                .find_map(|part| part["text"].as_str().filter(|text| !text.is_empty()))
        });
    // Match Magpie's conversation identity without keeping host/session state in
    // the adapter. Image-only requests still get a stable, content-derived id.
    let fallback = first_user.unwrap_or(&serde_json::Value::Null).to_string();
    let digest = Sha256::digest(text.unwrap_or(&fallback).as_bytes());
    let value =
        u64::from_be_bytes(digest[..8].try_into().expect("SHA-256 prefix")) & i64::MAX as u64;
    format!("-{value}")
}

fn extract_project(value: Option<&serde_json::Value>) -> Option<String> {
    value
        .and_then(|value| {
            value.as_str().map(str::to_string).or_else(|| {
                value
                    .get("id")
                    .and_then(serde_json::Value::as_str)
                    .map(str::to_string)
            })
        })
        .filter(|project| !project.trim().is_empty())
}

fn default_tier(load: &LoadCodeAssistResponse) -> String {
    load.allowed_tiers
        .iter()
        .find(|tier| tier.is_default.unwrap_or(false))
        .or_else(|| load.allowed_tiers.first())
        .and_then(|tier| tier.id.clone())
        .filter(|tier| !tier.trim().is_empty())
        .unwrap_or_else(|| "free-tier".to_string())
}

async fn remember_project(client: &AIClient, project: String) -> String {
    *cached_project().lock().await = Some((client.config.api_key.clone(), project.clone()));
    project
}

fn code_assist_error(label: &str, status: u16, body: &str) -> anyhow::Error {
    let code = serde_json::from_str::<serde_json::Value>(body)
        .ok()
        .and_then(|value| value["error"]["status"].as_str().map(str::to_string));
    AiProviderError::from_parts(
        format!("{label} failed: HTTP {status}: {body}"),
        Some("Gemini Code Assist".to_string()),
        code,
        Some(status),
    )
    .into()
}

// Only an unavailable route/transport may select another discovery endpoint.
// Account denials and invalid payloads must retain their structured cause.
fn should_try_next_discovery_endpoint(error: &anyhow::Error) -> bool {
    match error.downcast_ref::<AiProviderError>() {
        Some(error) => matches!(error.http_status, Some(404 | 500..=599)),
        None => error.downcast_ref::<reqwest::Error>().is_some(),
    }
}

async fn post_code_assist(
    client: &AIClient,
    endpoint: &str,
    method: &str,
    body: &serde_json::Value,
) -> Result<serde_json::Value> {
    validate_control_request(client).await?;
    let url = format!("{endpoint}/v1internal:{method}");
    let mut request =
        apply_headers(client, client.client.post(&url)).timeout(Duration::from_secs(30));
    if is_antigravity(client) && method == "onboardUser" {
        let mut headers = reqwest::header::HeaderMap::new();
        if let Some(ua) = client
            .config
            .custom_headers
            .as_ref()
            .and_then(|headers| headers.get("User-Agent"))
        {
            headers.insert(
                reqwest::header::USER_AGENT,
                format!("{ua} google-api-nodejs-client/10.3.0").parse()?,
            );
        }
        headers.insert("x-goog-api-client", "gl-node/22.21.1".parse()?);
        request = request.headers(headers);
    }
    let response = request
        .json(body)
        .send()
        .await
        .with_context(|| format!("{method} connection failed at {endpoint}"))?;
    let status = response.status();
    if !status.is_success() {
        let body = response.text().await?;
        return Err(code_assist_error(method, status.as_u16(), &body));
    }
    response
        .json()
        .await
        .with_context(|| format!("parse {method} response"))
}

async fn validate_control_request(client: &AIClient) -> Result<()> {
    if let Some(authorization) = client.request_authorization.as_ref() {
        authorization.validate().await?;
    }
    #[cfg(feature = "subscription-auth")]
    if let Some(identity) = client.account_identity.as_ref() {
        identity.validate(client).await?;
    }
    Ok(())
}

async fn post_code_assist_at(
    client: &AIClient,
    endpoints: &[&str],
    method: &str,
    body: &serde_json::Value,
) -> Result<serde_json::Value> {
    for (index, endpoint) in endpoints.iter().enumerate() {
        match post_code_assist(client, endpoint, method, body).await {
            Ok(value) => return Ok(value),
            Err(error)
                if index + 1 < endpoints.len() && should_try_next_discovery_endpoint(&error) =>
            {
                warn!("Code Assist control endpoint unavailable: endpoint={endpoint}, error={error:#}");
            }
            Err(error) => return Err(error),
        }
    }
    Err(anyhow!("No Code Assist control endpoint was available"))
}

async fn discover_project_at(
    client: &AIClient,
    load_endpoints: &[&str],
    onboard_endpoints: &[&str],
) -> Result<String> {
    let antigravity = is_antigravity(client);
    let metadata = if antigravity {
        antigravity_metadata()
    } else {
        serde_json::json!({
            "ideType": "IDE_UNSPECIFIED", "platform": "PLATFORM_UNSPECIFIED",
            "pluginType": "GEMINI",
        })
    };
    let load_body = serde_json::json!({ "metadata": metadata });
    let load: LoadCodeAssistResponse = serde_json::from_value(
        post_code_assist_at(client, load_endpoints, "loadCodeAssist", &load_body).await?,
    )
    .context("parse loadCodeAssist response")?;
    if let Some(project) = extract_project(load.cloudaicompanion_project.as_ref()) {
        return Ok(project);
    }
    if antigravity && load.allowed_tiers.is_empty() && !load.ineligible_tiers.is_empty() {
        return Err(load
            .ineligibility_error()
            .expect("nonempty ineligible tiers")
            .into());
    }
    let tier = default_tier(&load);
    let body = if antigravity {
        antigravity_onboard_body(client, &tier)
    } else {
        serde_json::json!({ "tierId": tier, "metadata": metadata })
    };
    let attempts = if antigravity { 5 } else { 10 };
    for attempt in 0..attempts {
        let value = post_code_assist_at(client, onboard_endpoints, "onboardUser", &body).await?;
        let operation: OnboardOperation =
            serde_json::from_value(value).context("parse onboardUser response")?;
        if let Some(error) = operation.error {
            let status = error["code"]
                .as_u64()
                .and_then(|code| match code {
                    // google.rpc.Code uses canonical RPC codes, not HTTP status.
                    3 => Some(400),
                    7 => Some(403),
                    8 => Some(429),
                    16 => Some(401),
                    14 => Some(503),
                    _ => None,
                })
                .unwrap_or(500);
            return Err(code_assist_error(
                "onboardUser",
                status,
                &serde_json::json!({ "error": error }).to_string(),
            ));
        }
        if operation.done.unwrap_or(false) {
            let setup = if antigravity {
                "Antigravity app"
            } else {
                "Code Assist"
            };
            return operation
                .response
                .and_then(|response| extract_project(response.cloudaicompanion_project.as_ref()))
                .ok_or_else(|| {
                    if antigravity {
                        if let Some(error) = load.ineligibility_error() {
                            return error.into();
                        }
                    }
                    AiProviderError::classified(
                        format!("Code Assist onboardUser completed without a project; sign in to {setup} to finish account setup"),
                        openbitfun_core_types::errors::ErrorCategory::InvalidRequest,
                    ).into()
                });
        }
        if attempt + 1 < attempts {
            tokio::time::sleep(Duration::from_secs(if antigravity { 2 } else { 5 })).await;
        }
    }
    Err(anyhow!(
        "Code Assist onboardUser did not complete; try again shortly"
    ))
}

async fn discover_project(client: &AIClient) -> Result<String> {
    {
        let guard = cached_project().lock().await;
        if let Some((credential, project)) = guard.as_ref() {
            if credential == &client.config.api_key {
                return Ok(project.clone());
            }
        }
    }
    if let Ok(project) = std::env::var("GOOGLE_CLOUD_PROJECT") {
        if !project.trim().is_empty() {
            return Ok(remember_project(client, project).await);
        }
    }
    let antigravity = is_antigravity(client);
    // Magpie discovers the managed project at production but sends Antigravity
    // onboarding/inference to daily. Never invent a project after discovery fails.
    let load_endpoints: &[&str] = if antigravity {
        &[
            CODE_ASSIST_BASE,
            ANTIGRAVITY_DAILY_BASE,
            ANTIGRAVITY_SANDBOX_BASE,
        ]
    } else {
        &[CODE_ASSIST_BASE]
    };
    let onboard: &[&str] = if antigravity {
        &[ANTIGRAVITY_DAILY_BASE, ANTIGRAVITY_SANDBOX_BASE]
    } else {
        &[CODE_ASSIST_BASE]
    };
    let discovery = discover_project_at(client, load_endpoints, onboard);
    let project = if antigravity {
        tokio::time::timeout(Duration::from_secs(30), discovery)
            .await
            .map_err(|_| {
                AiProviderError::classified(
                    "Code Assist project discovery timed out after 30s".to_string(),
                    openbitfun_core_types::errors::ErrorCategory::Timeout,
                )
            })??
    } else {
        discovery.await?
    };
    Ok(remember_project(client, project).await)
}

pub(crate) async fn send_stream(
    client: &AIClient,
    messages: Vec<Message>,
    tools: Option<Vec<ToolDefinition>>,
    extra_body: Option<serde_json::Value>,
    max_tries: usize,
    trace: Option<ModelExchangeTraceConfig>,
) -> Result<StreamResponse> {
    let project = discover_project(client).await?;

    let (system_instruction, contents) =
        GeminiMessageConverter::convert_messages(messages, &client.config.model);
    let gemini_tools = GeminiMessageConverter::convert_tools(tools);
    let mut inner = gemini_request::try_build_request_body(
        client,
        system_instruction,
        contents,
        gemini_tools,
        extra_body,
    )?;

    let antigravity = is_antigravity(client);
    let model = if antigravity {
        let route = resolve_antigravity_model(&client.config.model, &inner);
        apply_antigravity_thinking(&mut inner, &route);
        inner["sessionId"] = serde_json::json!(antigravity_session_id(&inner));
        route.model
    } else {
        client.config.model.clone()
    };
    let mut request_body = serde_json::json!({
        "model": model,
        "project": project,
        "request": inner,
    });
    if antigravity {
        if let Some(obj) = request_body.as_object_mut() {
            obj.insert(
                "userAgent".to_string(),
                serde_json::Value::String("antigravity".to_string()),
            );
            obj.insert(
                "requestType".to_string(),
                serde_json::Value::String("agent".to_string()),
            );
            #[cfg(feature = "subscription-auth")]
            obj.insert(
                "requestId".to_string(),
                serde_json::Value::String(format!("agent-{}", uuid::Uuid::new_v4())),
            );
        }
    }

    let configured_url = if client.config.request_url.is_empty() {
        format!("{}{}", CODE_ASSIST_BASE, STREAM_ENDPOINT)
    } else {
        client.config.request_url.clone()
    };
    // Hub clients use daily first, with the legacy sandbox as a transport/route
    // fallback. Production Code Assist inference serves a different product.
    let urls = if antigravity {
        vec![
            format!("{ANTIGRAVITY_DAILY_BASE}{STREAM_ENDPOINT}"),
            format!("{ANTIGRAVITY_SANDBOX_BASE}{STREAM_ENDPOINT}"),
        ]
    } else {
        vec![configured_url]
    };
    debug!(
        "Gemini Code Assist config: model={}, configured_model={}, request_url={}, max_tries={}",
        model, client.config.model, urls[0], max_tries
    );
    send_code_assist_stream(client, &urls, &request_body, max_tries, trace).await
}

async fn send_code_assist_stream(
    client: &AIClient,
    urls: &[String],
    request_body: &serde_json::Value,
    max_tries: usize,
    trace: Option<ModelExchangeTraceConfig>,
) -> Result<StreamResponse> {
    let idle_timeout = client.stream_options.idle_timeout;
    let mut prior_error: Option<anyhow::Error> = None;
    for (index, url) in urls.iter().enumerate() {
        let result = execute_sse_request(
            Some(client),
            "Gemini Code Assist Streaming API",
            url,
            request_body,
            max_tries,
            client.stream_options.ttft_timeout,
            trace.clone(),
            || apply_headers(client, client.client.post(url)),
            move |response, tx, tx_raw, remaining_ttft_timeout| {
                handle_gemini_code_assist_stream(
                    response,
                    tx,
                    tx_raw,
                    remaining_ttft_timeout,
                    idle_timeout,
                )
            },
        )
        .await;
        match result {
            Ok(response) => return Ok(response),
            Err(error) if index + 1 < urls.len() && should_try_next_stream_endpoint(&error) => {
                warn!(
                    "Antigravity inference endpoint unavailable: endpoint={url}, error={error:#}"
                );
                prior_error = Some(error);
            }
            Err(error) => {
                if error
                    .downcast_ref::<AiProviderError>()
                    .and_then(|e| e.http_status)
                    .is_none()
                {
                    if let Some(prior) = prior_error {
                        if prior
                            .downcast_ref::<AiProviderError>()
                            .and_then(|e| e.http_status)
                            .is_some()
                        {
                            return Err(prior
                                .context(format!("Antigravity fallback also failed: {error:#}")));
                        }
                    }
                }
                return Err(error);
            }
        }
    }
    Err(anyhow!("No Code Assist inference endpoint was available"))
}

fn should_try_next_stream_endpoint(error: &anyhow::Error) -> bool {
    match error.downcast_ref::<AiProviderError>() {
        Some(error) => match error.http_status {
            Some(404 | 500..=599) => true,
            None => matches!(
                error.category,
                openbitfun_core_types::errors::ErrorCategory::Network
                    | openbitfun_core_types::errors::ErrorCategory::Timeout
            ),
            _ => false,
        },
        // The shared SSE executor currently returns untyped transport/TTFT errors.
        None => true,
    }
}

const DEFAULT_CODE_ASSIST_MODELS: &[(&str, &str)] = &[
    ("gemini-3.1-pro-preview", "Gemini 3.1 Pro"),
    ("gemini-3-pro-preview", "Gemini 3 Pro"),
    ("gemini-3-flash-preview", "Gemini 3 Flash"),
    ("gemini-3.1-flash-lite-preview", "Gemini 3.1 Flash Lite"),
    ("gemini-2.5-pro", "Gemini 2.5 Pro"),
    ("gemini-2.5-flash", "Gemini 2.5 Flash"),
    ("gemini-2.5-flash-lite", "Gemini 2.5 Flash-Lite"),
];

#[derive(Deserialize)]
struct AvailableModelsResponse {
    models: std::collections::BTreeMap<String, AvailableModel>,
}

#[derive(Deserialize)]
struct AvailableModel {
    #[serde(default, rename = "displayName")]
    display_name: Option<String>,
}

async fn list_antigravity_models(
    client: &AIClient,
    endpoints: &[&str],
) -> Result<Vec<RemoteModelInfo>> {
    // The hub catalog accepts an optional project. Listing must not provision a project just to open a
    // picker, or borrow a different account's cached project.
    let mut body = serde_json::json!({});
    if let Some((credential, project)) = cached_project().lock().await.as_ref() {
        if credential == &client.config.api_key {
            body["project"] = serde_json::json!(project);
        }
    }
    let mut last_error = None;
    for endpoint in endpoints {
        validate_control_request(client).await?;
        let url = format!("{endpoint}{AVAILABLE_MODELS_ENDPOINT}");
        let response = match apply_headers(client, client.client.post(&url))
            .timeout(std::time::Duration::from_secs(10))
            .json(&body)
            .send()
            .await
        {
            Ok(response) => response,
            Err(error) => {
                last_error = Some(anyhow!(error).context("fetch Antigravity model catalog"));
                continue;
            }
        };
        let status = response.status();
        if !status.is_success() {
            let body = response.text().await?;
            let error = code_assist_error("Antigravity model discovery", status.as_u16(), &body);
            if status.as_u16() == 404 || status.is_server_error() {
                last_error = Some(error);
                continue;
            }
            return Err(error);
        }
        let payload = response
            .json::<AvailableModelsResponse>()
            .await
            .context("parse Antigravity model catalog")?;
        let models = crate::client::utils::dedupe_remote_models(
            payload
                .models
                .into_iter()
                .map(|(id, model)| RemoteModelInfo {
                    routing: None,
                    // Map keys are wire IDs. Display names and quota state must
                    // never rename or hide newly published/account-specific IDs.
                    id,
                    display_name: model.display_name,
                })
                .collect(),
        );
        if models.is_empty() {
            return Err(anyhow!(
                "Antigravity returned no available models for this account"
            ));
        }
        return Ok(models);
    }
    Err(last_error.unwrap_or_else(|| anyhow!("No Antigravity model endpoint was available")))
}

fn gemini_home_dir() -> Option<PathBuf> {
    std::env::var_os("HOME").map(|home| PathBuf::from(home).join(".gemini"))
}

fn read_gemini_settings_model(gemini_home: &Path) -> Option<String> {
    let settings_path = gemini_home.join("settings.json");
    let bytes = match std::fs::read(&settings_path) {
        Ok(b) => b,
        Err(e) => {
            if e.kind() != std::io::ErrorKind::NotFound {
                warn!(
                    "Failed to read Gemini settings from {}: {}",
                    settings_path.display(),
                    e
                );
            }
            return None;
        }
    };
    let value: serde_json::Value = match serde_json::from_slice(&bytes) {
        Ok(v) => v,
        Err(e) => {
            warn!(
                "Failed to parse Gemini settings JSON from {}: {}",
                settings_path.display(),
                e
            );
            return None;
        }
    };
    value
        .get("model")
        .and_then(serde_json::Value::as_str)
        .map(str::trim)
        .filter(|model| !model.is_empty())
        .map(str::to_string)
}

fn read_gemini_env_model(gemini_home: &Path) -> Option<String> {
    let env_path = gemini_home.join(".env");
    let text = match std::fs::read_to_string(&env_path) {
        Ok(t) => t,
        Err(e) => {
            if e.kind() != std::io::ErrorKind::NotFound {
                warn!(
                    "Failed to read Gemini .env from {}: {}",
                    env_path.display(),
                    e
                );
            }
            return None;
        }
    };
    text.lines().find_map(|line| {
        let line = line.trim();
        if line.is_empty() || line.starts_with('#') {
            return None;
        }
        let (key, value) = line.split_once('=')?;
        if key.trim() != "GEMINI_MODEL" {
            return None;
        }
        let model = value.trim().trim_matches(|ch| ch == '"' || ch == '\'');
        (!model.is_empty()).then(|| model.to_string())
    })
}

/// Antigravity exposes an authenticated model catalog, distinct from Gemini
/// CLI's static defaults. Never report those defaults as live account models.
pub(crate) async fn list_models(client: &AIClient) -> Result<Vec<RemoteModelInfo>> {
    if is_antigravity(client) {
        return list_antigravity_models(
            client,
            &[ANTIGRAVITY_DAILY_BASE, ANTIGRAVITY_SANDBOX_BASE],
        )
        .await;
    }

    let mut models = Vec::new();

    if let Some(gemini_home) = gemini_home_dir() {
        if let Some(model) =
            read_gemini_settings_model(&gemini_home).or_else(|| read_gemini_env_model(&gemini_home))
        {
            models.push(RemoteModelInfo {
                routing: None,
                id: model,
                display_name: None,
            });
        }
    }

    for (id, display_name) in DEFAULT_CODE_ASSIST_MODELS {
        models.push(RemoteModelInfo {
            routing: None,
            id: (*id).to_string(),
            display_name: Some((*display_name).to_string()),
        });
    }

    Ok(crate::client::utils::dedupe_remote_models(models))
}

#[cfg(test)]
mod tests {
    use super::{
        antigravity_metadata, apply_antigravity_thinking, default_tier, extract_project,
        resolve_antigravity_model, should_try_next_discovery_endpoint, AiProviderError,
        CodeAssistTier, LoadCodeAssistResponse,
    };

    #[tokio::test]
    async fn discovers_live_account_models_and_preserves_their_wire_ids() {
        use axum::{
            http::{HeaderMap, StatusCode},
            routing::post,
            Json, Router,
        };
        use serde_json::{json, Value};
        let app = Router::new()
            .route("/unavailable/v1internal:fetchAvailableModels", post(|| async { StatusCode::NOT_FOUND }))
            .route("/live/v1internal:fetchAvailableModels", post(|headers: HeaderMap, Json(body): Json<Value>| async move {
                assert_eq!(headers["authorization"], "Bearer antigravity-catalog-test");
                assert_eq!(headers["user-agent"], "antigravity/test");
                assert_eq!(body, json!({}));
                Json(json!({"models": {
                    "gemini-3.8-flash-medium": {"displayName": "Gemini 3.8 Flash (Medium)"},
                    "future-preview": {"displayName": "Future model", "quotaInfo": {"remainingFraction": 0}},
                    "gpt-oss-120b-medium": {"displayName": "GPT-OSS 120B"}
                }}))
            }));
        let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
        let base = format!("http://{}", listener.local_addr().unwrap());
        let server = tokio::spawn(async move {
            axum::serve(listener, app).await.unwrap();
        });
        let client = super::AIClient::new(serde_json::from_value(json!({
            "name": "catalog-test", "base_url": base, "request_url": base,
            "api_key": "antigravity-catalog-test", "model": "", "format": "gemini-code-assist",
            "context_window": 128000, "inline_think_in_text": false, "skip_ssl_verify": false,
            "custom_headers": {"User-Agent": "antigravity/test", "Client-Metadata": "ANTIGRAVITY"}
        })).unwrap());
        let unavailable = format!("{base}/unavailable");
        let live = format!("{base}/live");
        let models = super::list_antigravity_models(&client, &[&unavailable, &live])
            .await
            .unwrap();
        server.abort();
        assert_eq!(
            models
                .iter()
                .map(|model| model.id.as_str())
                .collect::<Vec<_>>(),
            [
                "future-preview",
                "gemini-3.8-flash-medium",
                "gpt-oss-120b-medium"
            ]
        );
        assert_eq!(
            models[1].display_name.as_deref(),
            Some("Gemini 3.8 Flash (Medium)")
        );
        for model in models {
            assert_eq!(
                resolve_antigravity_model(&model.id, &json!({})).model,
                model.id
            );
        }
    }

    #[tokio::test]
    async fn catalog_failure_does_not_masquerade_as_a_static_success() {
        use axum::{http::StatusCode, routing::post, Json, Router};
        use serde_json::json;
        let app = Router::new()
            .route(
                "/denied/v1internal:fetchAvailableModels",
                post(|| async { StatusCode::UNAUTHORIZED }),
            )
            .route(
                "/empty/v1internal:fetchAvailableModels",
                post(|| async { Json(json!({"models": {}})) }),
            )
            .route(
                "/malformed/v1internal:fetchAvailableModels",
                post(|| async { Json(json!({"unrecognized": []})) }),
            );
        let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
        let base = format!("http://{}", listener.local_addr().unwrap());
        let server = tokio::spawn(async move {
            axum::serve(listener, app).await.unwrap();
        });
        let client = super::AIClient::new(
            serde_json::from_value(json!({
                "name": "catalog-test", "base_url": base, "request_url": base,
                "api_key": "synthetic", "model": "", "format": "gemini-code-assist",
                "context_window": 128000, "inline_think_in_text": false, "skip_ssl_verify": false
            }))
            .unwrap(),
        );
        for path in ["denied", "empty", "malformed"] {
            let endpoint = format!("{base}/{path}");
            let error = super::list_antigravity_models(&client, &[&endpoint])
                .await
                .unwrap_err();
            assert!(error.to_string().contains("Antigravity"), "{error:#}");
        }
        server.abort();
    }

    #[test]
    fn accepts_string_and_object_project_shapes() {
        assert_eq!(
            extract_project(Some(&serde_json::json!("project-string"))).as_deref(),
            Some("project-string")
        );
        assert_eq!(
            extract_project(Some(&serde_json::json!({ "id": "project-object" }))).as_deref(),
            Some("project-object")
        );
    }

    #[test]
    fn selects_the_provider_default_tier() {
        let load = LoadCodeAssistResponse {
            cloudaicompanion_project: None,
            ineligible_tiers: vec![],
            allowed_tiers: vec![
                CodeAssistTier {
                    id: Some("FIRST".to_string()),
                    is_default: Some(false),
                },
                CodeAssistTier {
                    id: Some("DEFAULT".to_string()),
                    is_default: Some(true),
                },
            ],
        };
        assert_eq!(default_tier(&load), "DEFAULT");
    }

    fn antigravity_test_client() -> super::AIClient {
        super::AIClient::new(
            serde_json::from_value(serde_json::json!({
                "name": "antigravity-test", "base_url": "", "request_url": "",
                "api_key": "synthetic", "model": "gemini-3-flash-preview",
                "format": "gemini-code-assist", "context_window": 128000,
                "inline_think_in_text": false, "skip_ssl_verify": false,
                "custom_headers": {"User-Agent": "antigravity/hub/2.19.1 darwin/arm64",
                    "Client-Metadata": "{\"ideType\":\"ANTIGRAVITY\"}"}
            }))
            .unwrap(),
        )
    }

    #[test]
    fn sends_hub_control_plane_metadata_and_free_tier() {
        let client = antigravity_test_client();
        assert_eq!(
            antigravity_metadata(),
            serde_json::json!({"ideType": "ANTIGRAVITY"})
        );
        assert_eq!(
            super::antigravity_onboard_body(&client, "free-tier"),
            serde_json::json!({
                "tier_id": "free-tier", "metadata": {
                    "ide_type": "ANTIGRAVITY", "ide_name": "antigravity", "ide_version": "2.19.1"
                }
            })
        );
        let load: LoadCodeAssistResponse = serde_json::from_value(serde_json::json!({})).unwrap();
        assert_eq!(default_tier(&load), "free-tier");
    }

    #[test]
    fn discovery_does_not_retry_account_or_protocol_denials_at_other_products() {
        let error = |status| {
            anyhow::Error::new(AiProviderError::from_parts(
                format!("HTTP {status}"),
                Some("Antigravity".into()),
                None,
                Some(status),
            ))
            .context("request failed")
        };
        for status in [400, 401, 403, 429] {
            assert!(!should_try_next_discovery_endpoint(&error(status)));
        }
        for status in [404, 503] {
            assert!(should_try_next_discovery_endpoint(&error(status)));
        }
        assert!(!should_try_next_discovery_endpoint(&anyhow::anyhow!(
            "invalid local config"
        )));
    }

    #[test]
    fn session_id_is_stable_across_turns_and_is_a_signed_decimal() {
        use serde_json::json;
        let mut request = json!({"contents": [{"role":"user", "parts":[{"text":"hi"}]}]});
        let session = super::antigravity_session_id(&request);
        // Magpie hashes the first user text and uses the first 63 bits.
        assert_eq!(session, "-1099796703622425494");
        request["contents"]
            .as_array_mut()
            .unwrap()
            .push(json!({"role":"model", "parts":[{"text":"reply"}]}));
        request["contents"]
            .as_array_mut()
            .unwrap()
            .push(json!({"role":"user", "parts":[{"text":"next"}]}));
        assert_eq!(super::antigravity_session_id(&request), session);
        request["contents"][0]["parts"][0]["text"] = json!("another conversation");
        assert_ne!(super::antigravity_session_id(&request), session);
    }

    #[tokio::test]
    async fn discovers_and_onboards_the_real_account_project_in_both_response_shapes() {
        use axum::{http::HeaderMap, routing::post, Json, Router};
        use serde_json::{json, Value};
        let app = Router::new()
            .route("/v1internal:loadCodeAssist", post(|headers: HeaderMap, Json(body): Json<Value>| async move {
                assert_eq!(headers["authorization"], "Bearer synthetic");
                assert_eq!(headers["user-agent"], "antigravity/hub/2.19.1 darwin/arm64");
                assert_eq!(body, json!({"metadata":{"ideType":"ANTIGRAVITY"}}));
                Json(json!({"allowedTiers":[{"id":"free-tier","isDefault":true}]}))
            }))
            .route("/string/v1internal:onboardUser", post(|headers: HeaderMap, Json(body): Json<Value>| async move {
                assert_eq!(headers["user-agent"], "antigravity/hub/2.19.1 darwin/arm64 google-api-nodejs-client/10.3.0");
                assert_eq!(headers["x-goog-api-client"], "gl-node/22.21.1");
                assert_eq!(body, json!({"tier_id":"free-tier","metadata":{
                    "ide_type":"ANTIGRAVITY","ide_name":"antigravity","ide_version":"2.19.1"}}));
                Json(json!({"done":true,"response":{"cloudaicompanionProject":"managed-project"}}))
            }))
            .route("/object/v1internal:onboardUser", post(|| async {
                Json(json!({"done":true,"response":{"cloudaicompanionProject":{"id":"managed-project"}}}))
            }))
            .route("/existing/v1internal:loadCodeAssist", post(|| async {
                Json(json!({"cloudaicompanionProject":"existing-project"}))
            }));
        let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
        let base = format!("http://{}", listener.local_addr().unwrap());
        let server = tokio::spawn(async move {
            axum::serve(listener, app).await.unwrap();
        });
        let client = antigravity_test_client();
        for path in ["string", "object"] {
            assert_eq!(
                super::discover_project_at(&client, &[&base], &[&format!("{base}/{path}")])
                    .await
                    .unwrap(),
                "managed-project"
            );
        }
        assert_eq!(
            super::discover_project_at(
                &client,
                &[&format!("{base}/existing")],
                &[&format!("{base}/must-not-onboard")]
            )
            .await
            .unwrap(),
            "existing-project"
        );
        server.abort();
    }

    #[tokio::test]
    async fn discovery_and_onboarding_errors_never_invent_a_project() {
        use axum::{http::StatusCode, routing::post, Json, Router};
        use serde_json::json;
        let app = Router::new()
            .route("/denied/v1internal:loadCodeAssist", post(|| async {
                (StatusCode::FORBIDDEN, Json(json!({"error":{"code":403,"status":"PERMISSION_DENIED","message":"UNSUPPORTED_LOCATION"}})))
            }))
            .route("/missing/v1internal:loadCodeAssist", post(|| async { StatusCode::NOT_FOUND }))
            .route("/live/v1internal:loadCodeAssist", post(|| async { Json(json!({"cloudaicompanionProject":{"id":"live-project"}})) }))
            .route("/empty/v1internal:loadCodeAssist", post(|| async { Json(json!({})) }))
            .route("/ineligible/v1internal:loadCodeAssist", post(|| async {
                Json(json!({"ineligibleTiers":[{"reasonMessage":"Verify your account","validationUrl":"https://example.test/verify"}]}))
            }))
            .route("/empty/v1internal:onboardUser", post(|| async { Json(json!({"done":true,"response":{}})) }))
            .route("/operation-error/v1internal:onboardUser", post(|| async {
                Json(json!({"done":true,"error":{"code":7,"message":"Permission denied"}}))
            }));
        let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
        let base = format!("http://{}", listener.local_addr().unwrap());
        let server = tokio::spawn(async move {
            axum::serve(listener, app).await.unwrap();
        });
        let client = antigravity_test_client();
        let denied = format!("{base}/denied");
        let live = format!("{base}/live");
        let error = super::discover_project_at(&client, &[&denied, &live], &[&live])
            .await
            .unwrap_err();
        assert_eq!(
            error.downcast_ref::<AiProviderError>().unwrap().http_status,
            Some(403)
        );
        assert!(error.to_string().contains("UNSUPPORTED_LOCATION"));
        assert_eq!(
            super::discover_project_at(&client, &[&format!("{base}/missing"), &live], &[&live])
                .await
                .unwrap(),
            "live-project"
        );
        let error = super::discover_project_at(&client, &[&format!("{base}/ineligible")], &[&live])
            .await
            .unwrap_err();
        assert_eq!(
            error.downcast_ref::<AiProviderError>().unwrap().category,
            openbitfun_core_types::errors::ErrorCategory::Permission
        );
        assert!(error.to_string().contains("https://example.test/verify"));
        let empty = format!("{base}/empty");
        let error = super::discover_project_at(&client, &[&empty], &[&empty])
            .await
            .unwrap_err();
        assert!(error.to_string().contains("without a project"));
        let error =
            super::discover_project_at(&client, &[&empty], &[&format!("{base}/operation-error")])
                .await
                .unwrap_err();
        assert_eq!(
            error.downcast_ref::<AiProviderError>().unwrap().http_status,
            Some(403)
        );
        server.abort();
    }

    #[tokio::test]
    async fn inference_falls_back_on_transport_failure_but_preserves_account_denials() {
        use axum::{http::StatusCode, routing::post, Json, Router};
        use futures::StreamExt;
        use serde_json::json;
        use std::sync::{
            atomic::{AtomicUsize, Ordering},
            Arc,
        };
        let live_calls = Arc::new(AtomicUsize::new(0));
        let counter = live_calls.clone();
        let app = Router::new()
            .route("/live", post(move || {
                counter.fetch_add(1, Ordering::SeqCst);
                async { ([("content-type", "text/event-stream")],
                    "data: {\"response\":{\"candidates\":[{\"content\":{\"parts\":[{\"text\":\"OK\"}]},\"finishReason\":\"STOP\"}]}}\n\n") }
            }))
            .route("/denied", post(|| async {
                (StatusCode::FORBIDDEN, Json(json!({"error":{"status":"PERMISSION_DENIED","message":"UNSUPPORTED_LOCATION"}})))
            }))
            .route("/quota", post(|| async {
                (StatusCode::TOO_MANY_REQUESTS, Json(json!({"error":{"status":"RESOURCE_EXHAUSTED","message":"Resource exhausted"}})))
            }))
            .route("/unavailable", post(|| async { StatusCode::SERVICE_UNAVAILABLE }));
        let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
        let base = format!("http://{}", listener.local_addr().unwrap());
        let unused = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
        let refused = format!("http://{}/stream", unused.local_addr().unwrap());
        drop(unused);
        let server = tokio::spawn(async move {
            axum::serve(listener, app).await.unwrap();
        });
        let client = antigravity_test_client();
        let mut response = super::send_code_assist_stream(
            &client,
            &[refused.clone(), format!("{base}/live")],
            &json!({}),
            1,
            None,
        )
        .await
        .unwrap();
        let mut text = String::new();
        while let Some(chunk) = response.stream.next().await {
            if let Some(part) = chunk.unwrap().text {
                text.push_str(&part);
            }
        }
        assert_eq!(text, "OK");
        for (path, status) in [("denied", 403), ("quota", 429)] {
            let error = super::send_code_assist_stream(
                &client,
                &[format!("{base}/{path}"), format!("{base}/live")],
                &json!({}),
                1,
                None,
            )
            .await
            .err()
            .expect("account denial must fail");
            assert_eq!(
                error.downcast_ref::<AiProviderError>().unwrap().http_status,
                Some(status)
            );
        }
        assert_eq!(live_calls.load(Ordering::SeqCst), 1);
        let error = super::send_code_assist_stream(
            &client,
            &[format!("{base}/unavailable"), refused],
            &json!({}),
            1,
            None,
        )
        .await
        .err()
        .expect("both endpoints failed");
        assert_eq!(
            error.downcast_ref::<AiProviderError>().unwrap().http_status,
            Some(503)
        );
        server.abort();
    }

    #[tokio::test]
    async fn onboarding_fallback_retains_upstream_ineligibility_when_project_is_null() {
        use axum::{http::StatusCode, routing::post, Json, Router};
        use serde_json::json;
        let app = Router::new()
            .route("/v1internal:loadCodeAssist", post(|| async { Json(json!({
                "allowedTiers":[{"id":"standard-tier","isDefault":true}],
                "ineligibleTiers":[{"tierId":"free-tier","reasonMessage":"Antigravity is not available in your location"}]
            })) }))
            .route("/old/v1internal:onboardUser", post(|| async { StatusCode::NOT_FOUND }))
            .route("/live/v1internal:onboardUser", post(|| async {
                Json(json!({"done":true,"response":{"cloudaicompanionProject":null}}))
            }));
        let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
        let base = format!("http://{}", listener.local_addr().unwrap());
        let server = tokio::spawn(async move {
            axum::serve(listener, app).await.unwrap();
        });
        let error = super::discover_project_at(
            &antigravity_test_client(),
            &[&base],
            &[&format!("{base}/old"), &format!("{base}/live")],
        )
        .await
        .unwrap_err();
        let detail = error.downcast_ref::<AiProviderError>().unwrap();
        assert_eq!(
            detail.category,
            openbitfun_core_types::errors::ErrorCategory::Permission
        );
        assert_eq!(detail.http_status, None);
        assert!(detail.message.contains("not available in your location"));
        server.abort();
    }

    #[tokio::test]
    async fn control_plane_revocation_is_not_retried_or_sent_to_fallback_hosts() {
        use crate::client::ModelRequestAuthorization;
        use openbitfun_core_types::errors::ErrorCategory;
        use std::sync::{
            atomic::{AtomicUsize, Ordering},
            Arc,
        };
        #[derive(Debug)]
        struct Revoked(Arc<AtomicUsize>);
        impl ModelRequestAuthorization for Revoked {
            fn validate(
                &self,
            ) -> std::pin::Pin<Box<dyn std::future::Future<Output = anyhow::Result<()>> + Send + '_>>
            {
                self.0.fetch_add(1, Ordering::SeqCst);
                Box::pin(async {
                    Err(AiProviderError::classified(
                        "Model configuration was disabled".into(),
                        ErrorCategory::InvalidRequest,
                    )
                    .into())
                })
            }
        }
        let calls = Arc::new(AtomicUsize::new(0));
        let client =
            antigravity_test_client().with_request_authorization(Arc::new(Revoked(calls.clone())));
        let endpoints = ["http://127.0.0.1:0/primary", "http://127.0.0.1:0/fallback"];
        let error = super::discover_project_at(&client, &endpoints, &endpoints)
            .await
            .unwrap_err();
        assert_eq!(
            error.downcast_ref::<AiProviderError>().unwrap().category,
            ErrorCategory::InvalidRequest
        );
        assert_eq!(calls.load(Ordering::SeqCst), 1);
        let error = super::list_antigravity_models(&client, &endpoints)
            .await
            .unwrap_err();
        let detail = error.downcast_ref::<AiProviderError>().unwrap();
        assert_eq!(detail.http_status, None);
        assert_eq!(detail.provider, None);
        assert_eq!(calls.load(Ordering::SeqCst), 2);
    }

    #[tokio::test]
    async fn gemini_cli_retains_its_own_metadata_and_onboarding_fields() {
        use axum::{routing::post, Json, Router};
        use serde_json::{json, Value};
        let app = Router::new()
            .route("/v1internal:loadCodeAssist", post(|Json(body): Json<Value>| async move {
                assert_eq!(body, json!({"metadata":{"ideType":"IDE_UNSPECIFIED",
                    "platform":"PLATFORM_UNSPECIFIED","pluginType":"GEMINI"}}));
                Json(json!({"allowedTiers":[{"id":"free-tier","isDefault":true}]}))
            }))
            .route("/v1internal:onboardUser", post(|Json(body): Json<Value>| async move {
                assert_eq!(body["tierId"], "free-tier");
                assert!(body.get("tier_id").is_none());
                assert_eq!(body["metadata"]["platform"],"PLATFORM_UNSPECIFIED");
                Json(json!({"done":true,"response":{"cloudaicompanionProject":{"id":"cli-project"}}}))
            }));
        let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
        let base = format!("http://{}", listener.local_addr().unwrap());
        let server = tokio::spawn(async move {
            axum::serve(listener, app).await.unwrap();
        });
        let mut client = antigravity_test_client();
        client.config.custom_headers = None;
        assert_eq!(
            super::discover_project_at(&client, &[&base], &[&base])
                .await
                .unwrap(),
            "cli-project"
        );
        server.abort();
    }

    #[test]
    fn maps_legacy_and_current_antigravity_models_to_subscription_wire_ids() {
        let empty_request = serde_json::json!({});
        let cases = [
            ("gemini-3-pro-preview", "gemini-3-pro-low"),
            ("gemini-3.1-pro-preview-customtools", "gemini-3.1-pro-low"),
            ("antigravity-gemini-3-pro-high", "gemini-3-pro-high"),
            ("gemini-3-flash-preview", "gemini-3-flash"),
            ("claude-opus-4-6-thinking-high", "claude-opus-4-6-thinking"),
            ("claude-sonnet-4-6", "claude-sonnet-4-6"),
        ];

        for (configured, expected) in cases {
            assert_eq!(
                resolve_antigravity_model(configured, &empty_request).model,
                expected
            );
        }
    }

    #[test]
    fn writes_provider_specific_antigravity_thinking_fields() {
        let mut gemini_request = serde_json::json!({});
        let gemini_route = resolve_antigravity_model("gemini-3.1-pro-high", &gemini_request);
        apply_antigravity_thinking(&mut gemini_request, &gemini_route);
        assert_eq!(
            gemini_request["generationConfig"]["thinkingConfig"]["thinkingLevel"],
            "high"
        );

        let mut claude_request = serde_json::json!({});
        let claude_route =
            resolve_antigravity_model("claude-opus-4-6-thinking-low", &claude_request);
        apply_antigravity_thinking(&mut claude_request, &claude_route);
        assert_eq!(
            claude_request["generationConfig"]["thinkingConfig"]["thinking_budget"],
            8_192
        );
        assert_eq!(
            claude_request["generationConfig"]["maxOutputTokens"],
            64_000
        );
    }

    #[test]
    fn configures_validated_claude_tool_calls_and_nonempty_schemas() {
        let mut request = serde_json::json!({
            "tools": [{
                "functionDeclarations": [{
                    "name": "empty_tool",
                    "parameters": { "type": "object", "properties": {} }
                }]
            }]
        });
        let route = resolve_antigravity_model("claude-sonnet-4-6", &request);
        apply_antigravity_thinking(&mut request, &route);

        assert_eq!(
            request["toolConfig"]["functionCallingConfig"]["mode"],
            "VALIDATED"
        );
        assert_eq!(
            request["tools"][0]["functionDeclarations"][0]["parameters"]["required"],
            serde_json::json!(["_placeholder"])
        );
    }
}
