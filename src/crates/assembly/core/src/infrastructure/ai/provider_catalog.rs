use std::collections::{BTreeMap, BTreeSet};

use openbitfun_ai_adapters::models_dev::{ModelsDevCatalog, ModelsDevModelFacts};
use openbitfun_core_types::{
    ProviderCatalog, ProviderCatalogEndpoint, ProviderCatalogModel,
    ProviderCatalogModelCapabilities, ProviderCatalogModelSource, ProviderCatalogProvider,
    ProviderCatalogSource, ProviderCatalogUpstreamProvider,
};
use serde::Deserialize;
use sha2::{Digest, Sha256};

const BUILTIN_PROVIDER_OVERLAY: &str =
    include_str!("../../../../../../shared/ai-provider-catalog/providers.json");

#[derive(Debug, Clone, Deserialize)]
struct ProviderOverlayDocument {
    schema_version: u32,
    providers: Vec<ProviderOverlay>,
}

#[derive(Debug, Clone, Deserialize)]
struct ProviderOverlay {
    id: String,
    display_order: i32,
    name: String,
    description: String,
    help_url: Option<String>,
    requires_api_key: bool,
    #[serde(default)]
    catalog_provider_ids: Vec<String>,
    endpoints: Vec<EndpointOverlay>,
    model_policy: ModelPolicyOverlay,
}

#[derive(Debug, Clone, Deserialize)]
struct EndpointOverlay {
    id: String,
    base_url: String,
    api_format: String,
    label: String,
    #[serde(default)]
    is_default: bool,
    #[serde(default)]
    trusted_for_auto_detection: bool,
    #[serde(default)]
    trusted_aliases: Vec<String>,
    #[serde(default)]
    catalog_provider_ids: Vec<String>,
    #[serde(default)]
    reasoning_catalog_bindings: Vec<ReasoningCatalogBindingOverlay>,
}

#[derive(Debug, Clone, Deserialize)]
struct ReasoningCatalogBindingOverlay {
    model_id: String,
    source_provider_id: String,
    source_model_id: String,
}

#[derive(Debug, Clone, Copy, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "snake_case")]
enum ModelPolicyMode {
    Curated,
    Catalog,
    CatalogWithFallback,
}

#[derive(Debug, Clone, Deserialize)]
struct ModelPolicyOverlay {
    mode: ModelPolicyMode,
    #[serde(default)]
    curated_models: Vec<String>,
    #[serde(default)]
    additional_models: Vec<String>,
}

pub(crate) fn resolve_builtin_provider_catalog(
    models_dev: Option<&ModelsDevCatalog>,
    revision: String,
    source: ProviderCatalogSource,
) -> ProviderCatalog {
    let overlay = parse_overlay().expect("built-in AI provider overlay must be valid");
    let mut providers = overlay
        .providers
        .iter()
        .map(|provider| resolve_provider(provider, models_dev))
        .collect::<Vec<_>>();
    providers.sort_by(|left, right| {
        left.display_order
            .cmp(&right.display_order)
            .then_with(|| left.id.cmp(&right.id))
    });
    ProviderCatalog {
        revision: resolved_catalog_revision(&revision),
        source: promoted_catalog_source(&overlay, models_dev, source),
        providers,
    }
}

/// The identity of the built-in provider catalog without projecting its
/// providers.
///
/// A caller that must not ship the projected bodies — a peer answer, a session
/// poll, a mobile or bot controller — still has to report the same `revision`
/// and `source` the full build would: the revision drives
/// `RemoteModelCatalog::version`, and an attached controller only accepts a new
/// catalog when that version moves. Projecting the providers themselves is the
/// expensive part, so the slim build keeps the identity and drops the bodies.
pub(crate) fn builtin_provider_catalog_identity(
    models_dev: Option<&ModelsDevCatalog>,
    revision: String,
    source: ProviderCatalogSource,
) -> ProviderCatalog {
    let overlay = parse_overlay().expect("built-in AI provider overlay must be valid");
    ProviderCatalog {
        revision: resolved_catalog_revision(&revision),
        source: promoted_catalog_source(&overlay, models_dev, source),
        providers: Vec::new(),
    }
}

/// A models.dev snapshot that contributes provider bindings makes the catalog
/// mixed even when the caller passed the OpenBitFun-only source.
fn promoted_catalog_source(
    overlay: &ProviderOverlayDocument,
    models_dev: Option<&ModelsDevCatalog>,
    source: ProviderCatalogSource,
) -> ProviderCatalogSource {
    let has_bound_catalog_data = models_dev.is_some_and(|catalog| {
        overlay.providers.iter().any(|provider| {
            provider
                .catalog_provider_ids
                .iter()
                .any(|provider_id| catalog.provider_facts(provider_id).is_some())
        })
    });
    if has_bound_catalog_data && source == ProviderCatalogSource::OpenBitFun {
        ProviderCatalogSource::Mixed
    } else {
        source
    }
}

fn resolved_catalog_revision(source_revision: &str) -> String {
    let mut digest = Sha256::new();
    digest.update(b"openbitfun-provider-catalog-v1\0");
    digest.update(BUILTIN_PROVIDER_OVERLAY.as_bytes());
    digest.update(b"\0models-dev\0");
    digest.update(source_revision.as_bytes());
    digest
        .finalize()
        .iter()
        .map(|byte| format!("{byte:02x}"))
        .collect()
}

pub(crate) fn trusted_models_dev_binding(
    api_format: &str,
    base_url: &str,
    model_id: &str,
    models_dev: &ModelsDevCatalog,
) -> Option<(String, String)> {
    let overlay = parse_overlay().ok()?;
    let normalized_base_url = normalize_base_url(base_url);
    let endpoint = overlay
        .providers
        .iter()
        .flat_map(|provider| &provider.endpoints)
        .find(|endpoint| {
            endpoint.trusted_for_auto_detection
                && endpoint.api_format.eq_ignore_ascii_case(api_format.trim())
                && (normalize_base_url(&endpoint.base_url) == normalized_base_url
                    || endpoint
                        .trusted_aliases
                        .iter()
                        .any(|alias| normalize_base_url(alias) == normalized_base_url))
        })?;
    if let Some(binding) = endpoint.reasoning_catalog_bindings.iter().find(|binding| {
        binding
            .model_id
            .trim()
            .eq_ignore_ascii_case(model_id.trim())
    }) {
        return models_dev
            .canonical_model_id(&binding.source_provider_id, &binding.source_model_id)
            .map(|canonical_model| (binding.source_provider_id.clone(), canonical_model));
    }
    endpoint
        .catalog_provider_ids
        .iter()
        .find_map(|provider_id| {
            models_dev
                .canonical_model_id(provider_id, model_id)
                .map(|canonical_model| (provider_id.clone(), canonical_model))
        })
}

fn parse_overlay() -> Result<ProviderOverlayDocument, String> {
    let overlay: ProviderOverlayDocument = serde_json::from_str(BUILTIN_PROVIDER_OVERLAY)
        .map_err(|error| format!("built-in provider overlay is invalid: {error}"))?;
    validate_overlay(&overlay)?;
    Ok(overlay)
}

fn validate_overlay(overlay: &ProviderOverlayDocument) -> Result<(), String> {
    if overlay.schema_version != 1 {
        return Err(format!(
            "unsupported built-in provider overlay schema {}",
            overlay.schema_version
        ));
    }
    let mut provider_ids = BTreeSet::new();
    let mut catalog_provider_owners = BTreeMap::<String, String>::new();
    let mut trusted_urls = BTreeMap::<String, String>::new();
    let mut trusted_routes = BTreeSet::new();
    for provider in &overlay.providers {
        if provider.id.trim().is_empty() || !provider_ids.insert(provider.id.as_str()) {
            return Err(format!("duplicate or empty provider ID '{}'", provider.id));
        }
        if provider.endpoints.is_empty() {
            return Err(format!("provider '{}' has no endpoint", provider.id));
        }
        let mut provider_catalog_ids = BTreeSet::new();
        for catalog_provider_id in &provider.catalog_provider_ids {
            if catalog_provider_id.trim().is_empty()
                || !provider_catalog_ids.insert(catalog_provider_id.as_str())
            {
                return Err(format!(
                    "provider '{}' has a duplicate or empty catalog provider ID",
                    provider.id
                ));
            }
            if let Some(previous) =
                catalog_provider_owners.insert(catalog_provider_id.clone(), provider.id.clone())
            {
                return Err(format!(
                    "catalog provider '{}' is claimed by providers '{previous}' and '{}'",
                    catalog_provider_id, provider.id
                ));
            }
        }
        let mut declared_models = BTreeSet::new();
        for model_id in &provider.model_policy.curated_models {
            if model_id.trim().is_empty() || !declared_models.insert(model_id.as_str()) {
                return Err(format!(
                    "provider '{}' has a duplicate or empty curated model ID",
                    provider.id
                ));
            }
        }
        for model_id in &provider.model_policy.additional_models {
            if model_id.trim().is_empty() || !declared_models.insert(model_id.as_str()) {
                return Err(format!(
                    "provider '{}' has a duplicate, conflicting, or empty additional model ID",
                    provider.id
                ));
            }
        }
        if matches!(
            provider.model_policy.mode,
            ModelPolicyMode::Catalog | ModelPolicyMode::CatalogWithFallback
        ) && provider.catalog_provider_ids.is_empty()
        {
            return Err(format!(
                "provider '{}' uses a catalog mode without a catalog binding",
                provider.id
            ));
        }
        if provider.model_policy.mode == ModelPolicyMode::CatalogWithFallback
            && provider.model_policy.curated_models.is_empty()
        {
            return Err(format!(
                "provider '{}' uses catalog-with-fallback mode without fallback models",
                provider.id
            ));
        }
        if provider
            .endpoints
            .iter()
            .filter(|endpoint| endpoint.is_default)
            .count()
            != 1
        {
            return Err(format!(
                "provider '{}' must define exactly one default endpoint",
                provider.id
            ));
        }
        let mut endpoint_ids = BTreeSet::new();
        for endpoint in &provider.endpoints {
            if endpoint.id.trim().is_empty() || !endpoint_ids.insert(endpoint.id.as_str()) {
                return Err(format!(
                    "provider '{}' has a duplicate or empty endpoint ID",
                    provider.id
                ));
            }
            if endpoint.base_url.trim().is_empty() || endpoint.api_format.trim().is_empty() {
                return Err(format!(
                    "provider '{}' endpoint '{}' is incomplete",
                    provider.id, endpoint.id
                ));
            }
            if endpoint
                .catalog_provider_ids
                .iter()
                .any(|catalog_provider_id| {
                    !provider_catalog_ids.contains(catalog_provider_id.as_str())
                })
            {
                return Err(format!(
                    "provider '{}' endpoint '{}' references an unbound catalog provider",
                    provider.id, endpoint.id
                ));
            }
            let mut reasoning_model_ids = BTreeSet::new();
            for binding in &endpoint.reasoning_catalog_bindings {
                let model_id = binding.model_id.trim();
                if model_id.is_empty() || !reasoning_model_ids.insert(model_id.to_ascii_lowercase())
                {
                    return Err(format!(
                        "provider '{}' endpoint '{}' has a duplicate or empty reasoning model binding",
                        provider.id, endpoint.id
                    ));
                }
                if binding.source_provider_id.trim().is_empty()
                    || binding.source_model_id.trim().is_empty()
                {
                    return Err(format!(
                        "provider '{}' endpoint '{}' has an incomplete reasoning catalog binding for model '{}'",
                        provider.id, endpoint.id, binding.model_id
                    ));
                }
            }
            if endpoint.trusted_for_auto_detection {
                for url in std::iter::once(&endpoint.base_url).chain(&endpoint.trusted_aliases) {
                    let normalized = normalize_base_url(url);
                    if normalized.is_empty() {
                        return Err(format!(
                            "provider '{}' endpoint '{}' has an empty trusted URL",
                            provider.id, endpoint.id
                        ));
                    }
                    // One provider may expose multiple protocols at the same base,
                    // but ownership and each protocol's binding must be unambiguous.
                    let unique_route = trusted_routes.insert((
                        normalized.clone(),
                        endpoint.api_format.trim().to_ascii_lowercase(),
                    ));
                    if let Some(previous) = trusted_urls.insert(normalized, provider.id.clone()) {
                        if previous != provider.id || !unique_route {
                            return Err(format!(
                                "trusted endpoint is claimed by providers '{previous}' and '{}'",
                                provider.id
                            ));
                        }
                    }
                }
            }
        }
    }
    Ok(())
}

fn resolve_provider(
    provider: &ProviderOverlay,
    models_dev: Option<&ModelsDevCatalog>,
) -> ProviderCatalogProvider {
    let endpoints = provider
        .endpoints
        .iter()
        .map(|endpoint| ProviderCatalogEndpoint {
            id: endpoint.id.clone(),
            base_url: endpoint.base_url.clone(),
            api_format: endpoint.api_format.clone(),
            label: endpoint.label.clone(),
            is_default: endpoint.is_default,
            trusted_for_auto_detection: endpoint.trusted_for_auto_detection,
            catalog_provider_ids: endpoint.catalog_provider_ids.clone(),
        })
        .collect::<Vec<_>>();

    let mut dynamic_models = BTreeMap::<String, (ModelsDevModelFacts, BTreeSet<String>)>::new();
    let mut deprecated_models = BTreeSet::<String>::new();
    if provider.model_policy.mode != ModelPolicyMode::Curated {
        if let Some(catalog) = models_dev {
            for catalog_provider_id in &provider.catalog_provider_ids {
                for model in catalog.provider_models(catalog_provider_id) {
                    if model
                        .status
                        .as_deref()
                        .is_some_and(|status| status.eq_ignore_ascii_case("deprecated"))
                    {
                        if !dynamic_models.contains_key(&model.id) {
                            deprecated_models.insert(model.id);
                        }
                        continue;
                    }
                    deprecated_models.remove(&model.id);
                    dynamic_models
                        .entry(model.id.clone())
                        .and_modify(|(_, providers)| {
                            providers.insert(catalog_provider_id.clone());
                        })
                        .or_insert_with(|| (model, BTreeSet::from([catalog_provider_id.clone()])));
                }
            }
        }
    }

    let recommended = provider
        .model_policy
        .curated_models
        .iter()
        .map(|model| model.as_str())
        .collect::<BTreeSet<_>>();
    let mut models = Vec::new();
    let catalog_is_usable = !dynamic_models.is_empty();
    if catalog_is_usable {
        // Curated IDs only influence recommendation and ordering while a usable
        // catalog is available. Missing IDs are not reintroduced as fallback
        // records; models.dev is authoritative for catalog membership.
        for curated_model in &provider.model_policy.curated_models {
            if let Some((facts, source_providers)) = dynamic_models.remove(curated_model) {
                models.push(catalog_model(provider, facts, source_providers, true));
            }
        }
        models.extend(
            dynamic_models
                .into_values()
                .map(|(facts, source_providers)| {
                    let is_recommended = recommended.contains(facts.id.as_str());
                    catalog_model(provider, facts, source_providers, is_recommended)
                }),
        );
    } else if matches!(
        provider.model_policy.mode,
        ModelPolicyMode::Curated | ModelPolicyMode::CatalogWithFallback
    ) {
        models.extend(
            provider
                .model_policy
                .curated_models
                .iter()
                .filter(|model_id| !deprecated_models.contains(model_id.as_str()))
                .map(|model_id| curated_model_fallback(provider, model_id, true)),
        );
    }

    // Explicit additions are independent from disaster fallback. They are
    // appended only when models.dev did not already provide the same model and
    // never revive a model that the catalog explicitly deprecated.
    let included_model_ids = models
        .iter()
        .map(|model| model.id.clone())
        .collect::<BTreeSet<_>>();
    for model_id in &provider.model_policy.additional_models {
        if !included_model_ids.contains(model_id.as_str()) && !deprecated_models.contains(model_id)
        {
            models.push(curated_model_fallback(provider, model_id, false));
        }
    }

    ProviderCatalogProvider {
        id: provider.id.clone(),
        display_order: provider.display_order,
        name: provider.name.clone(),
        description: provider.description.clone(),
        help_url: provider.help_url.clone(),
        requires_api_key: provider.requires_api_key,
        catalog_provider_ids: provider.catalog_provider_ids.clone(),
        catalog_providers: provider
            .catalog_provider_ids
            .iter()
            .filter_map(|provider_id| {
                models_dev
                    .and_then(|catalog| catalog.provider_facts(provider_id))
                    .map(|facts| ProviderCatalogUpstreamProvider {
                        id: facts.id,
                        name: facts.name,
                        api: facts.api,
                        doc: facts.doc,
                        env: facts.env,
                    })
            })
            .collect(),
        endpoints,
        models,
    }
}

fn catalog_model(
    provider: &ProviderOverlay,
    facts: ModelsDevModelFacts,
    source_providers: BTreeSet<String>,
    recommended: bool,
) -> ProviderCatalogModel {
    let source_provider_ids = source_providers.into_iter().collect::<Vec<_>>();
    let endpoint_ids = provider
        .endpoints
        .iter()
        .filter(|endpoint| {
            endpoint
                .catalog_provider_ids
                .iter()
                .any(|id| source_provider_ids.iter().any(|source| source == id))
        })
        .map(|endpoint| endpoint.id.clone())
        .collect();
    ProviderCatalogModel {
        id: facts.id,
        display_name: facts.display_name,
        description: facts.description,
        recommended,
        source: if recommended {
            ProviderCatalogModelSource::Merged
        } else {
            ProviderCatalogModelSource::ModelsDev
        },
        family: facts.family,
        status: facts.status,
        release_date: facts.release_date,
        last_updated: facts.last_updated,
        knowledge: facts.knowledge,
        open_weights: facts.open_weights,
        catalog_provider_ids: source_provider_ids,
        endpoint_ids,
        capabilities: facts.capabilities,
        limits: facts.limits,
        pricing: facts.pricing,
    }
}

fn curated_model_fallback(
    provider: &ProviderOverlay,
    model_id: &str,
    recommended: bool,
) -> ProviderCatalogModel {
    ProviderCatalogModel {
        id: model_id.to_string(),
        display_name: None,
        description: None,
        recommended,
        source: ProviderCatalogModelSource::OpenBitFun,
        catalog_provider_ids: provider.catalog_provider_ids.clone(),
        endpoint_ids: provider
            .endpoints
            .iter()
            .map(|endpoint| endpoint.id.clone())
            .collect(),
        capabilities: ProviderCatalogModelCapabilities {
            chat: true,
            ..Default::default()
        },
        limits: None,
        pricing: None,
        family: None,
        status: None,
        release_date: None,
        last_updated: None,
        knowledge: None,
        open_weights: None,
    }
}

fn normalize_base_url(url: &str) -> String {
    let mut normalized = url.trim().trim_end_matches('/').to_ascii_lowercase();
    for suffix in ["/chat/completions", "/responses", "/v1/messages", "/models"] {
        if normalized.ends_with(suffix) {
            normalized.truncate(normalized.len() - suffix.len());
            normalized = normalized.trim_end_matches('/').to_string();
            break;
        }
    }
    normalized
}

#[cfg(test)]
mod tests {
    use openbitfun_core_types::{ProviderCatalogModelSource, ProviderCatalogSource};

    use super::{parse_overlay, resolve_builtin_provider_catalog, trusted_models_dev_binding};
    use openbitfun_ai_adapters::models_dev::ModelsDevCatalog;

    #[test]
    fn trusted_urls_allow_distinct_protocols_only_within_one_provider() {
        let overlay = parse_overlay().expect("valid overlay with MiMo protocols");
        let index = overlay
            .providers
            .iter()
            .position(|p| p.id == "xiaomi")
            .unwrap();
        let mut duplicate = overlay.clone();
        // A second spelling of the same protocol/normalized URL is ambiguous.
        duplicate.providers[index].endpoints[1].api_format = " OpenAI ".into();
        assert!(super::validate_overlay(&duplicate).is_err());

        let mut cross_provider = overlay.clone();
        let mut other = overlay.providers[index].clone();
        other.id = "other-provider".into();
        other.endpoints.truncate(1);
        other.endpoints[0].api_format = "gemini".into();
        cross_provider.providers.push(other);
        assert!(super::validate_overlay(&cross_provider).is_err());
    }

    #[test]
    fn overlay_is_valid_and_keeps_product_endpoint_decisions() {
        let overlay = parse_overlay().expect("valid overlay");
        assert_eq!(overlay.providers.len(), 17);
        let stepfun = overlay
            .providers
            .iter()
            .find(|provider| provider.id == "stepfun")
            .expect("Step Plan preset");
        assert!(stepfun.requires_api_key);
        assert_eq!(
            stepfun.endpoints[0].base_url,
            "https://api.stepfun.com/step_plan/v1"
        );
        assert!(stepfun.endpoints[0].is_default);
        assert_eq!(
            stepfun.endpoints[1].base_url,
            "https://api.stepfun.ai/step_plan/v1"
        );
        assert!(stepfun
            .endpoints
            .iter()
            .all(|endpoint| endpoint.api_format == "openai"));
        assert!(stepfun.model_policy.curated_models.is_empty());
        assert_eq!(stepfun.model_policy.mode, super::ModelPolicyMode::Catalog);
        let go = overlay
            .providers
            .iter()
            .find(|provider| provider.id == "opencode-go")
            .expect("Go API-key preset");
        assert!(go.requires_api_key);
        assert_eq!(go.catalog_provider_ids, ["opencode-go"]);
        assert_eq!(go.model_policy.mode, super::ModelPolicyMode::Catalog);
        assert_eq!(go.endpoints.len(), 1);
        assert_eq!(go.endpoints[0].base_url, "https://opencode.ai/zen/go/v1");
        assert!(go.endpoints[0].is_default);
        let zen = overlay
            .providers
            .iter()
            .find(|provider| provider.id == "opencode-zen")
            .expect("Zen preset");
        assert!(!zen.requires_api_key);
        // Zen's account-independent model list and wire routes come from the
        // live OpenCode catalog rather than the bundled models.dev subset.
        assert!(zen.catalog_provider_ids.is_empty());
        assert_eq!(zen.endpoints[0].base_url, "https://opencode.ai/zen/v1");
        let openbitfun = overlay
            .providers
            .iter()
            .find(|provider| provider.id == "openbitfun")
            .expect("openbitfun");
        assert_eq!(
            openbitfun.model_policy.curated_models,
            ["glm-5.2", "deepseek-v4-flash", "deepseek-v4-pro"]
        );
        assert_eq!(
            openbitfun
                .endpoints
                .iter()
                .map(|endpoint| (
                    endpoint.id.as_str(),
                    endpoint.base_url.as_str(),
                    endpoint.api_format.as_str(),
                    endpoint.is_default,
                ))
                .collect::<Vec<_>>(),
            [
                ("default", "https://api.openbitfun.com", "anthropic", true,),
                ("openai", "https://api.openbitfun.com/v1", "openai", false,),
            ]
        );
        let qwen = overlay
            .providers
            .iter()
            .find(|provider| provider.id == "qwen")
            .expect("qwen");
        assert_eq!(
            qwen.endpoints
                .iter()
                .find(|endpoint| endpoint.is_default)
                .map(|endpoint| endpoint.base_url.as_str()),
            Some("https://dashscope.aliyuncs.com/compatible-mode/v1")
        );
        let tokendance = overlay
            .providers
            .iter()
            .find(|provider| provider.id == "tokendance")
            .expect("tokendance");
        assert_eq!(
            tokendance.help_url.as_deref(),
            Some("https://tokendance.space/keys")
        );
        assert_eq!(
            tokendance
                .endpoints
                .iter()
                .map(|endpoint| (
                    endpoint.id.as_str(),
                    endpoint.base_url.as_str(),
                    endpoint.api_format.as_str(),
                    endpoint.is_default,
                ))
                .collect::<Vec<_>>(),
            [(
                "default",
                "https://tokendance.space/gateway/v1",
                "openai",
                true,
            )]
        );
        assert_eq!(
            tokendance.model_policy.curated_models,
            ["glm-5.2", "deepseek-v4-flash", "deepseek-v4-pro"]
        );
    }

    #[test]
    fn usable_models_dev_catalog_is_authoritative_and_curated_models_only_recommend() {
        let catalog = ModelsDevCatalog::parse_str(
            r#"{
                "alibaba": {
                  "id":"alibaba","name":"Alibaba Cloud","api":"https://dashscope.aliyuncs.com",
                  "doc":"https://help.aliyun.com/zh/model-studio/","env":["DASHSCOPE_API_KEY"],
                  "models": {
                    "qwen3.7-plus": {"name":"Qwen Plus","tool_call":true,
                        "modalities":{"input":["text","image"],"output":["text"]},
                        "limit":{"context":1000000,"output":32768},
                        "release_date":"2026-07-01","status":"active",
                        "cost":{"input":0.4,"output":1.2}},
                    "qwen3.7-max": {"status":"deprecated",
                        "modalities":{"input":["text"],"output":["text"]}},
                    "qwen-new": {"modalities":{"input":["text"],"output":["text"]}},
                    "qwen-asr": {"modalities":{"input":["audio"],"output":["audio"]}}
                  }
                }
            }"#,
        )
        .expect("catalog");
        let resolved = resolve_builtin_provider_catalog(
            Some(&catalog),
            "42".to_string(),
            ProviderCatalogSource::Cache,
        );
        let qwen = resolved
            .providers
            .iter()
            .find(|provider| provider.id == "qwen")
            .expect("qwen");
        let plus = qwen
            .models
            .iter()
            .find(|model| model.id == "qwen3.7-plus")
            .expect("merged curated model");
        assert_eq!(plus.source, ProviderCatalogModelSource::Merged);
        assert!(plus.recommended);
        assert!(plus.capabilities.attachment);
        assert_eq!(plus.release_date.as_deref(), Some("2026-07-01"));
        assert_eq!(
            plus.pricing
                .as_ref()
                .and_then(|pricing| pricing.input.as_deref()),
            Some("0.4")
        );
        assert_eq!(
            qwen.catalog_providers
                .first()
                .map(|provider| (provider.id.as_str(), provider.name.as_str())),
            Some(("alibaba", "Alibaba Cloud"))
        );
        assert!(qwen.models.iter().any(|model| model.id == "qwen-new"));
        assert!(!qwen.models.iter().any(|model| model.id == "qwen-asr"));
        assert!(!qwen.models.iter().any(|model| model.id == "qwen3.7-max"));
        assert!(!qwen.models.iter().any(|model| model.id == "qwen3.6-flash"));
        assert_eq!(resolved.source, ProviderCatalogSource::Cache);
        assert_ne!(resolved.revision, "42");
        assert_eq!(resolved.revision.len(), 64);
    }

    #[test]
    fn unavailable_or_empty_catalog_uses_provider_level_curated_fallback() {
        let unavailable = resolve_builtin_provider_catalog(
            None,
            "none".to_string(),
            ProviderCatalogSource::OpenBitFun,
        );
        let qwen = unavailable
            .providers
            .iter()
            .find(|provider| provider.id == "qwen")
            .expect("qwen fallback");
        assert_eq!(
            qwen.models
                .iter()
                .map(|model| (model.id.as_str(), model.source))
                .collect::<Vec<_>>(),
            [
                ("qwen3.7-plus", ProviderCatalogModelSource::OpenBitFun),
                ("qwen3.7-max", ProviderCatalogModelSource::OpenBitFun),
                ("qwen3.6-flash", ProviderCatalogModelSource::OpenBitFun),
            ]
        );

        let filtered = ModelsDevCatalog::parse_str(
            r#"{"alibaba":{"models":{"qwen-asr":{"modalities":{"input":["audio"],"output":["audio"]}}}}}"#,
        )
        .expect("filtered catalog");
        let resolved = resolve_builtin_provider_catalog(
            Some(&filtered),
            "filtered".to_string(),
            ProviderCatalogSource::Cache,
        );
        let qwen = resolved
            .providers
            .iter()
            .find(|provider| provider.id == "qwen")
            .expect("qwen filtered fallback");
        assert_eq!(qwen.models.len(), 3);
        assert!(qwen
            .models
            .iter()
            .all(|model| model.source == ProviderCatalogModelSource::OpenBitFun));
    }

    #[test]
    fn explicit_additional_models_are_independent_from_catalog_fallback() {
        let overlay = parse_overlay().expect("valid overlay");
        let mut qwen = overlay
            .providers
            .into_iter()
            .find(|provider| provider.id == "qwen")
            .expect("qwen");
        qwen.model_policy.additional_models = vec!["qwen-early-access".to_string()];
        let catalog = ModelsDevCatalog::parse_str(
            r#"{"alibaba":{"models":{"qwen-catalog":{"modalities":{"input":["text"],"output":["text"]}}}}}"#,
        )
        .expect("catalog");

        let resolved = super::resolve_provider(&qwen, Some(&catalog));

        assert!(resolved
            .models
            .iter()
            .any(|model| model.id == "qwen-catalog"
                && model.source == ProviderCatalogModelSource::ModelsDev));
        assert!(resolved
            .models
            .iter()
            .any(|model| model.id == "qwen-early-access"
                && model.source == ProviderCatalogModelSource::OpenBitFun
                && !model.recommended));
        assert!(!resolved
            .models
            .iter()
            .any(|model| model.id == "qwen3.7-plus"));
    }

    #[test]
    fn bundled_reasoning_snapshot_still_produces_all_product_providers() {
        let catalog = ModelsDevCatalog::parse_str(include_str!(
            "../../../../../services/services-integrations/assets/models-dev.json"
        ))
        .expect("bundled catalog");
        let resolved = resolve_builtin_provider_catalog(
            Some(&catalog),
            "bundle".to_string(),
            ProviderCatalogSource::Bundle,
        );
        assert_eq!(resolved.providers.len(), 17);
        let go = resolved
            .providers
            .iter()
            .find(|provider| provider.id == "opencode-go")
            .expect("bundled Go provider");
        assert!(
            !go.models.is_empty(),
            "Go must have an offline model catalog"
        );
        let zen = resolved
            .providers
            .iter()
            .find(|provider| provider.id == "opencode-zen")
            .expect("bundled Zen provider");
        assert!(
            zen.models.is_empty(),
            "Zen models require live route discovery"
        );
        assert!(resolved
            .providers
            .iter()
            .find(|provider| provider.id == "volcengine")
            .is_some_and(|provider| !provider.models.is_empty()));
    }

    #[test]
    fn trusted_endpoint_resolves_catalog_identity_but_custom_gateway_does_not() {
        let catalog = ModelsDevCatalog::parse_str(
            r#"{"alibaba":{"models":{"qwen-test":{"id":"qwen-test"}}}}"#,
        )
        .expect("catalog");
        assert_eq!(
            trusted_models_dev_binding(
                "openai",
                "https://dashscope.aliyuncs.com/compatible-mode/v1/chat/completions",
                "qwen-test",
                &catalog,
            ),
            Some(("alibaba".to_string(), "qwen-test".to_string()))
        );
        let deepseek = ModelsDevCatalog::parse_str(
            r#"{"deepseek":{"models":{"deepseek-test":{"id":"deepseek-test"}}}}"#,
        )
        .expect("deepseek catalog");
        assert_eq!(
            trusted_models_dev_binding(
                "openai",
                "https://api.deepseek.com/chat/completions",
                "deepseek-test",
                &deepseek,
            ),
            Some(("deepseek".to_string(), "deepseek-test".to_string()))
        );
        let relayed = ModelsDevCatalog::parse_str(
            r#"{
                "zhipuai":{"models":{"glm-5.2":{"id":"glm-5.2"}}},
                "deepseek":{"models":{
                    "deepseek-v4-flash":{"id":"deepseek-v4-flash"},
                    "deepseek-v4-pro":{"id":"deepseek-v4-pro"}
                }}
            }"#,
        )
        .expect("relay catalog");
        assert_eq!(
            trusted_models_dev_binding(
                "anthropic",
                "https://api.openbitfun.com/v1/messages",
                "GLM-5.2",
                &relayed,
            ),
            Some(("zhipuai".to_string(), "glm-5.2".to_string()))
        );
        assert_eq!(
            trusted_models_dev_binding(
                "openai",
                "https://api.openbitfun.com/v1",
                "GLM-5.2",
                &relayed,
            ),
            Some(("zhipuai".to_string(), "glm-5.2".to_string()))
        );
        assert_eq!(
            trusted_models_dev_binding(
                "anthropic",
                "https://api.openbitfun.com",
                "deepseek-v4-flash",
                &relayed,
            ),
            Some(("deepseek".to_string(), "deepseek-v4-flash".to_string()))
        );
        assert_eq!(
            trusted_models_dev_binding(
                "openai",
                "https://api.openbitfun.com/v1/chat/completions",
                "deepseek-v4-flash",
                &relayed,
            ),
            Some(("deepseek".to_string(), "deepseek-v4-flash".to_string()))
        );
        assert_eq!(
            trusted_models_dev_binding(
                "openai",
                "https://tokendance.space/gateway/v1/chat/completions",
                "GLM-5.2",
                &relayed,
            ),
            Some(("zhipuai".to_string(), "glm-5.2".to_string()))
        );
        assert_eq!(
            trusted_models_dev_binding(
                "anthropic",
                "https://api.openbitfun.com",
                "deepseek-v4-pro",
                &relayed,
            ),
            Some(("deepseek".to_string(), "deepseek-v4-pro".to_string()))
        );
        assert_eq!(
            trusted_models_dev_binding(
                "anthropic",
                "https://api.openbitfun.com",
                "unmapped-model",
                &relayed,
            ),
            None
        );
        assert_eq!(
            trusted_models_dev_binding(
                "openai",
                "https://gateway.example.com/v1",
                "qwen-test",
                &catalog,
            ),
            None
        );
    }
}
