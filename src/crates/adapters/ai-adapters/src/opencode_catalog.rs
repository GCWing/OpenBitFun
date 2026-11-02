//! Public OpenCode Zen/Go model catalog and API-key routes. No account or OAuth IO.
use anyhow::{anyhow, Context, Result};
use serde::{Deserialize, Serialize};
use std::collections::{HashMap, HashSet};
use std::time::Duration;
#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash)]
pub(crate) enum OpenCodePlan {
    Zen,
    Go,
}
struct CatalogModel {
    id: String,
    display_name: Option<String>,
}
struct CatalogOffering {
    plan: OpenCodePlan,
    format: String,
    base_url: String,
    suggested_model: String,
    models: Vec<CatalogModel>,
}
const ZEN_BASE_URL: &str = "https://opencode.ai/zen/v1";
const ZEN_REQUEST_URL: &str = "https://opencode.ai/zen/v1/chat/completions";
const ZEN_RESPONSES_URL: &str = "https://opencode.ai/zen/v1/responses";
const ZEN_MESSAGES_URL: &str = "https://opencode.ai/zen/v1/messages";
const GO_BASE_URL: &str = "https://opencode.ai/zen/go/v1";
const GO_REQUEST_URL: &str = "https://opencode.ai/zen/go/v1/chat/completions";
const GO_RESPONSES_URL: &str = "https://opencode.ai/zen/go/v1/responses";
const GO_MESSAGES_URL: &str = "https://opencode.ai/zen/go/v1/messages";
const SUPPORTED_FORMATS: [&str; 3] = ["openai", "responses", "anthropic"];
const BASE_CATALOG_URL: &str = "https://models.opencode.ai/api.json";
const BASE_CATALOG_TTL: Duration = Duration::from_secs(3600);

/// Match only official API product roots, never arbitrary lookalike URLs.
pub(crate) fn api_key_plan(base_url: &str) -> Option<OpenCodePlan> {
    match base_url.trim_end_matches('/') {
        ZEN_BASE_URL => Some(OpenCodePlan::Zen),
        GO_BASE_URL => Some(OpenCodePlan::Go),
        _ => None,
    }
}

pub(crate) async fn api_key_models(
    client: &reqwest::Client,
    plan: OpenCodePlan,
) -> Result<Vec<openbitfun_core_types::RemoteModelInfo>> {
    let catalog = load_base_catalog(client).await?;
    api_key_models_from_catalog(catalog, plan)
}

fn api_key_models_from_catalog(
    catalog: RemoteConfig,
    plan: OpenCodePlan,
) -> Result<Vec<openbitfun_core_types::RemoteModelInfo>> {
    let mut result = Vec::new();
    for offering in offerings_from_remote_config(catalog)
        .into_iter()
        .filter(|item| item.plan == plan)
    {
        let route = route_for(plan, &offering.format)?;
        for model in offering.models {
            result.push(openbitfun_core_types::RemoteModelInfo {
                id: model.id,
                display_name: model.display_name,
                routing: Some(openbitfun_core_types::RemoteModelRouting {
                    format: route.format.to_string(),
                    base_url: route.base_url.to_string(),
                    request_url: route.request_url.to_string(),
                }),
            });
        }
    }
    Ok(result)
}

#[derive(Debug, Clone, Default, Deserialize, Serialize)]
struct RemoteConfig {
    #[serde(default)]
    provider: HashMap<String, RemoteProvider>,
}

#[derive(Debug, Clone, Default, Deserialize, Serialize)]
struct RemoteProvider {
    #[serde(default)]
    npm: Option<String>,
    #[serde(default)]
    api: Option<String>,
    #[serde(default)]
    models: HashMap<String, RemoteModel>,
}

#[derive(Debug, Clone, Default, Deserialize, Serialize)]
struct RemoteModel {
    #[serde(default)]
    id: Option<String>,
    #[serde(default)]
    name: Option<String>,
    #[serde(default)]
    status: Option<String>,
    #[serde(default)]
    provider: Option<RemoteModelProvider>,
    #[serde(default)]
    cost: Option<RemoteCost>,
}

#[derive(Debug, Clone, Default, Deserialize, Serialize)]
struct RemoteCost {
    #[serde(default)]
    input: Option<f64>,
    #[serde(default)]
    output: Option<f64>,
}

static FREE_MODELS: std::sync::RwLock<Option<HashSet<(OpenCodePlan, String)>>> =
    std::sync::RwLock::new(None);

fn free_model_ids(catalog: &RemoteConfig) -> HashSet<(OpenCodePlan, String)> {
    catalog
        .provider
        .iter()
        .flat_map(|(provider, entry)| {
            let plan = plan_for_provider(provider);
            entry.models.iter().filter_map(move |(id, model)| {
                let cost = model.cost.as_ref()?;
                if cost.input != Some(0.0)
                    || cost.output != Some(0.0)
                    || model.status.as_deref() == Some("deprecated")
                {
                    return None;
                }
                Some((plan?, model.id.as_deref().unwrap_or(id).to_string()))
            })
        })
        .collect()
}

/// Public discovery remembers zero-cost IDs that have no `-free` suffix.
/// This is non-secret catalog metadata, never another application's cache.
pub(crate) fn cached_free_model(plan: OpenCodePlan, model: &str) -> bool {
    FREE_MODELS.read().ok().is_some_and(|cache| {
        cache
            .as_ref()
            .is_some_and(|models| models.contains(&(plan, model.to_string())))
    })
}

#[derive(Debug, Clone, Default, Deserialize, Serialize)]
struct RemoteModelProvider {
    #[serde(default)]
    npm: Option<String>,
    #[serde(default)]
    api: Option<String>,
}

#[derive(Debug, Clone, Copy)]
struct OpenCodeRoute {
    base_url: &'static str,
    request_url: &'static str,
    format: &'static str,
}

fn plan_base_url(plan: OpenCodePlan) -> &'static str {
    match plan {
        OpenCodePlan::Zen => ZEN_BASE_URL,
        OpenCodePlan::Go => GO_BASE_URL,
    }
}

fn route_for(plan: OpenCodePlan, format: &str) -> Result<OpenCodeRoute> {
    let normalized = format.trim().to_ascii_lowercase();
    let route = match (plan, normalized.as_str()) {
        (OpenCodePlan::Zen, "openai") => OpenCodeRoute {
            base_url: ZEN_BASE_URL,
            request_url: ZEN_REQUEST_URL,
            format: "openai",
        },
        (OpenCodePlan::Zen, "response" | "responses") => OpenCodeRoute {
            base_url: ZEN_BASE_URL,
            request_url: ZEN_RESPONSES_URL,
            format: "responses",
        },
        (OpenCodePlan::Zen, "anthropic") => OpenCodeRoute {
            base_url: ZEN_BASE_URL,
            request_url: ZEN_MESSAGES_URL,
            format: "anthropic",
        },
        (OpenCodePlan::Go, "openai") => OpenCodeRoute {
            base_url: GO_BASE_URL,
            request_url: GO_REQUEST_URL,
            format: "openai",
        },
        (OpenCodePlan::Go, "response" | "responses") => OpenCodeRoute {
            base_url: GO_BASE_URL,
            request_url: GO_RESPONSES_URL,
            format: "responses",
        },
        (OpenCodePlan::Go, "anthropic") => OpenCodeRoute {
            base_url: GO_BASE_URL,
            request_url: GO_MESSAGES_URL,
            format: "anthropic",
        },
        _ => {
            return Err(anyhow!(
                "OpenCode {:?} does not support OpenBitFun request format '{}'",
                plan,
                format.trim()
            ));
        }
    };
    Ok(route)
}

fn empty_offering(plan: OpenCodePlan, format: &str) -> CatalogOffering {
    CatalogOffering {
        plan,
        format: format.to_string(),
        base_url: plan_base_url(plan).to_string(),
        suggested_model: String::new(),
        models: Vec::new(),
    }
}

fn fallback_offerings() -> Vec<CatalogOffering> {
    [OpenCodePlan::Zen, OpenCodePlan::Go]
        .into_iter()
        .flat_map(|plan| {
            SUPPORTED_FORMATS
                .into_iter()
                .map(move |format| empty_offering(plan, format))
        })
        .collect()
}

fn canonicalize_offerings(
    offerings: impl IntoIterator<Item = CatalogOffering>,
) -> Vec<CatalogOffering> {
    let mut result = fallback_offerings();

    for mut offering in offerings {
        let normalized_format = offering.format.trim().to_ascii_lowercase();
        let normalized_format = match normalized_format.as_str() {
            "response" | "responses" => "responses",
            "openai" => "openai",
            "anthropic" => "anthropic",
            _ => continue,
        };
        offering.format = normalized_format.to_string();
        offering.base_url = plan_base_url(offering.plan).to_string();

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

fn plan_for_provider(provider_id: &str) -> Option<OpenCodePlan> {
    match provider_id {
        "opencode" => Some(OpenCodePlan::Zen),
        "opencode-go" => Some(OpenCodePlan::Go),
        _ => None,
    }
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

fn parse_base_catalog(value: serde_json::Value) -> Result<RemoteConfig> {
    let object = value
        .as_object()
        .ok_or_else(|| anyhow!("OpenCode base catalog must be an object"))?;
    let mut config = RemoteConfig::default();
    for id in ["opencode", "opencode-go"] {
        let provider = object
            .get(id)
            .ok_or_else(|| anyhow!("OpenCode base catalog is missing {id}"))?;
        config.provider.insert(
            id.to_string(),
            serde_json::from_value(provider.clone())
                .with_context(|| format!("parse OpenCode base provider {id}"))?,
        );
    }
    Ok(config)
}

async fn load_base_catalog(client: &reqwest::Client) -> Result<RemoteConfig> {
    static CACHE: tokio::sync::Mutex<Option<(std::time::Instant, RemoteConfig)>> =
        tokio::sync::Mutex::const_new(None);
    let mut cache = CACHE.lock().await;
    if let Some((loaded, catalog)) = cache.as_ref() {
        if loaded.elapsed() < BASE_CATALOG_TTL {
            return Ok(catalog.clone());
        }
    }
    // This client has network policy only; no account headers are attached.
    let value = client
        .get(BASE_CATALOG_URL)
        .timeout(Duration::from_secs(15))
        .send()
        .await
        .context("fetch OpenCode base catalog")?
        .error_for_status()
        .context("OpenCode base catalog request failed")?
        .json()
        .await
        .context("decode OpenCode base catalog")?;
    let catalog = parse_base_catalog(value)?;
    if let Ok(mut models) = FREE_MODELS.write() {
        *models = Some(free_model_ids(&catalog));
    }
    *cache = Some((std::time::Instant::now(), catalog.clone()));
    Ok(catalog)
}

fn offerings_from_remote_config(config: RemoteConfig) -> Vec<CatalogOffering> {
    let mut offerings = fallback_offerings();

    for (provider_id, provider) in config.provider {
        let Some(plan) = plan_for_provider(&provider_id) else {
            continue;
        };
        for (catalog_id, model) in provider.models {
            if model.status.as_deref() == Some("deprecated") {
                continue;
            }
            let npm = model
                .provider
                .as_ref()
                .and_then(|item| item.npm.as_deref())
                .or(provider.npm.as_deref());
            let api = model
                .provider
                .as_ref()
                .and_then(|item| item.api.as_deref())
                .or(provider.api.as_deref());
            let Some(format) = format_for_remote_model(npm, api) else {
                // OpenBitFun does not currently have a compatible adapter for
                // every AI SDK package returned by OpenCode (for example its
                // Google-native gateway shape). Do not offer a model with an
                // endpoint we cannot faithfully reproduce.
                continue;
            };
            let id = model.id.unwrap_or(catalog_id).trim().to_string();
            if id.is_empty() {
                continue;
            }
            let display_name = model
                .name
                .map(|name| name.trim().to_string())
                .filter(|name| !name.is_empty() && name != &id);
            if let Some(offering) = offerings
                .iter_mut()
                .find(|candidate| candidate.plan == plan && candidate.format == format)
            {
                offering.models.push(CatalogModel { id, display_name });
            }
        }
    }

    let offerings = canonicalize_offerings(offerings);
    offerings
}

#[cfg(test)]
mod tests {
    #[test]
    fn zero_cost_detection_is_plan_specific_and_requires_both_prices() {
        let catalog = super::parse_base_catalog(serde_json::json!({
            "opencode": {"models": {
                "anonymous": {"cost":{"input":0,"output":0}},
                "missing": {},
                "partial": {"cost":{"input":0}},
                "paid": {"cost":{"input":0,"output":1}},
                "retired": {"cost":{"input":0,"output":0},"status":"deprecated"}
            }},
            "opencode-go": {"models":{"anonymous":{"cost":{"input":1,"output":1}}}}
        }))
        .unwrap();
        let ids = super::free_model_ids(&catalog);
        assert_eq!(ids.len(), 1);
        assert!(ids.contains(&(super::OpenCodePlan::Zen, "anonymous".into())));
    }

    #[test]
    fn api_key_catalog_returns_per_model_routes_and_rejects_lookalike_origins() {
        let catalog = super::parse_base_catalog(serde_json::json!({
            "opencode": {"npm":"@ai-sdk/openai-compatible", "models":{}},
            "opencode-go": {"npm":"@ai-sdk/openai-compatible", "models":{
                "chat":{}, "responses":{"provider":{"npm":"@ai-sdk/openai"}},
                "messages":{"provider":{"npm":"@ai-sdk/anthropic"}}
            }}
        }))
        .unwrap();
        let models = super::api_key_models_from_catalog(catalog, super::OpenCodePlan::Go).unwrap();
        assert_eq!(models.len(), 3);
        for (id, format, suffix) in [
            ("chat", "openai", "chat/completions"),
            ("responses", "responses", "responses"),
            ("messages", "anthropic", "messages"),
        ] {
            let route = models
                .iter()
                .find(|model| model.id == id)
                .unwrap()
                .routing
                .as_ref()
                .unwrap();
            assert_eq!(route.format, format);
            assert_eq!(
                route.request_url,
                format!("https://opencode.ai/zen/go/v1/{suffix}")
            );
        }
        assert_eq!(
            super::api_key_plan(super::GO_BASE_URL),
            Some(super::OpenCodePlan::Go)
        );
        assert!(super::api_key_plan("https://opencode.ai.evil.invalid/zen/go/v1").is_none());
        assert!(super::api_key_plan("http://opencode.ai/zen/go/v1").is_none());
    }
}

/// Public catalog only; account overrides are merged by the Console adapter.
#[cfg(feature = "subscription-auth")]
pub(crate) async fn base_catalog_value(client: &reqwest::Client) -> Result<serde_json::Value> {
    Ok(serde_json::to_value(load_base_catalog(client).await?)?)
}
