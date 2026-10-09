//! models.dev parsing, provider/model matching, and reasoning preset projection.

use openbitfun_core_types::{
    ModelsDevCatalogSource, ModelsDevReasoningCatalog, ModelsDevReasoningModel,
    ModelsDevReasoningProvider, ProviderCatalogModelCapabilities, ProviderCatalogModelLimits,
    ProviderCatalogModelPricing, ReasoningCapabilityStatus, ReasoningCatalogBinding,
    ReasoningCatalogProjection, ReasoningConfig, ReasoningPresetAction, ReasoningPresetDescriptor,
    ReasoningPresetSource,
};
use serde::Deserialize;
use serde_json::Value;
use std::collections::{BTreeMap, HashMap};

use crate::client::quirks::{
    is_deepseek_reasoning_effort_model, is_deepseek_url, is_glm_52_reasoning_effort_model,
    is_zhipuai_url, normalize_deepseek_reasoning_effort, normalize_glm_52_reasoning_effort,
};
use crate::providers::anthropic::request::{
    anthropic_thinking_capability, AnthropicThinkingCapability,
};
use crate::providers::openai::common::is_known_codex_reasoning_model;

#[derive(Debug, Clone, PartialEq)]
pub struct ModelsDevCatalog {
    providers: BTreeMap<String, ModelsDevProvider>,
}

#[derive(Debug, Clone, PartialEq)]
struct ModelsDevProvider {
    id: String,
    name: String,
    api: Option<String>,
    doc: Option<String>,
    env: Vec<String>,
    models: BTreeMap<String, ModelsDevModel>,
}

#[derive(Debug, Clone, PartialEq)]
struct ModelsDevModel {
    id: String,
    name: Option<String>,
    description: Option<String>,
    family: Option<String>,
    status: Option<String>,
    release_date: Option<String>,
    last_updated: Option<String>,
    knowledge: Option<String>,
    open_weights: Option<bool>,
    attachment: bool,
    reasoning: bool,
    tool_call: bool,
    structured_output: bool,
    input_modalities: Vec<String>,
    output_modalities: Vec<String>,
    /// `None` means the field was absent. `Some([])` is an authoritative
    /// declaration that the model exposes no selectable reasoning control.
    reasoning_options: Option<Vec<ModelsDevReasoningOption>>,
    has_unknown_options: bool,
    output_limit: Option<u32>,
    context_limit: Option<u32>,
    input_limit: Option<u32>,
    pricing: Option<ProviderCatalogModelPricing>,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct ModelsDevProviderFacts {
    pub id: String,
    pub name: String,
    pub api: Option<String>,
    pub doc: Option<String>,
    pub env: Vec<String>,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct ModelsDevModelFacts {
    pub id: String,
    pub display_name: Option<String>,
    pub description: Option<String>,
    pub family: Option<String>,
    pub status: Option<String>,
    pub release_date: Option<String>,
    pub last_updated: Option<String>,
    pub knowledge: Option<String>,
    pub open_weights: Option<bool>,
    pub capabilities: ProviderCatalogModelCapabilities,
    pub limits: Option<ProviderCatalogModelLimits>,
    pub pricing: Option<ProviderCatalogModelPricing>,
}

#[derive(Debug, Clone, PartialEq)]
enum ModelsDevReasoningOption {
    Effort { values: Vec<Option<String>> },
    Toggle,
    BudgetTokens { min: Option<u32>, max: Option<u32> },
}

#[derive(Debug, Deserialize, Default)]
struct RawProvider {
    #[serde(default)]
    id: String,
    #[serde(default)]
    name: String,
    #[serde(default)]
    api: Option<String>,
    #[serde(default)]
    doc: Option<String>,
    #[serde(default)]
    env: Vec<String>,
    #[serde(default)]
    models: HashMap<String, Value>,
}

#[derive(Debug, Deserialize, Default)]
struct RawModel {
    #[serde(default)]
    id: String,
    #[serde(default)]
    name: Option<String>,
    #[serde(default)]
    description: Option<String>,
    #[serde(default)]
    family: Option<String>,
    #[serde(default)]
    status: Option<String>,
    #[serde(default)]
    release_date: Option<String>,
    #[serde(default)]
    last_updated: Option<String>,
    #[serde(default)]
    knowledge: Option<String>,
    #[serde(default)]
    open_weights: Option<bool>,
    #[serde(default)]
    attachment: Option<bool>,
    #[serde(default)]
    reasoning: Option<bool>,
    #[serde(default)]
    tool_call: Option<bool>,
    #[serde(default)]
    structured_output: Option<bool>,
    #[serde(default)]
    modalities: Option<RawModalities>,
    #[serde(default)]
    limit: Option<RawLimit>,
    #[serde(default)]
    cost: Option<RawCost>,
}

#[derive(Debug, Deserialize, Default)]
struct RawLimit {
    #[serde(default)]
    context: Option<u32>,
    #[serde(default)]
    input: Option<u32>,
    #[serde(default)]
    output: Option<u32>,
}

#[derive(Debug, Deserialize, Default)]
struct RawModalities {
    #[serde(default)]
    input: Vec<String>,
    #[serde(default)]
    output: Vec<String>,
}

#[derive(Debug, Deserialize, Default)]
struct RawCost {
    #[serde(default)]
    input: Option<serde_json::Number>,
    #[serde(default)]
    output: Option<serde_json::Number>,
    #[serde(default)]
    cache_read: Option<serde_json::Number>,
    #[serde(default)]
    cache_write: Option<serde_json::Number>,
}

#[derive(Debug, Deserialize)]
#[serde(tag = "type", rename_all = "snake_case")]
enum RawReasoningOption {
    Effort {
        #[serde(default)]
        values: Vec<Option<String>>,
    },
    Toggle,
    BudgetTokens {
        #[serde(default)]
        min: Option<u32>,
        #[serde(default)]
        max: Option<u32>,
    },
}

fn parse_reasoning_options(raw_model: &Value) -> (Option<Vec<ModelsDevReasoningOption>>, bool) {
    let Some(raw_options) = raw_model.get("reasoning_options") else {
        return (None, false);
    };
    let values = match raw_options {
        Value::Array(values) => values.clone(),
        Value::Object(_) => vec![raw_options.clone()],
        _ => return (Some(Vec::new()), true),
    };
    let mut parsed = Vec::new();
    let mut has_unknown = false;
    for value in values {
        match serde_json::from_value::<RawReasoningOption>(value) {
            Ok(RawReasoningOption::Effort { values }) => {
                let values = values
                    .into_iter()
                    .filter_map(|value| match value {
                        Some(value) => {
                            let value = value.trim().to_ascii_lowercase();
                            (!value.is_empty()).then_some(Some(value))
                        }
                        None => Some(None),
                    })
                    .collect::<Vec<_>>();
                if values.is_empty() {
                    has_unknown = true;
                } else {
                    parsed.push(ModelsDevReasoningOption::Effort { values });
                }
            }
            Ok(RawReasoningOption::Toggle) => parsed.push(ModelsDevReasoningOption::Toggle),
            Ok(RawReasoningOption::BudgetTokens { min, max }) => {
                parsed.push(ModelsDevReasoningOption::BudgetTokens { min, max });
            }
            Err(_) => has_unknown = true,
        }
    }
    (Some(parsed), has_unknown)
}

impl ModelsDevCatalog {
    pub fn parse_str(body: &str) -> Result<Self, String> {
        let value: Value = serde_json::from_str(body)
            .map_err(|error| format!("models.dev catalog JSON is invalid: {error}"))?;
        Self::from_value(value)
    }

    pub fn from_value(value: Value) -> Result<Self, String> {
        let providers = value
            .as_object()
            .ok_or_else(|| "models.dev catalog must be a provider object".to_string())?;
        let mut parsed = BTreeMap::new();
        for (provider_id, provider_value) in providers {
            let provider_id = provider_id.trim().to_ascii_lowercase();
            if provider_id.is_empty() {
                continue;
            }
            let Ok(raw_provider) = serde_json::from_value::<RawProvider>(provider_value.clone())
            else {
                continue;
            };
            let mut models = BTreeMap::new();
            for (model_key, raw_model_value) in raw_provider.models {
                let Ok(raw_model) = serde_json::from_value::<RawModel>(raw_model_value.clone())
                else {
                    continue;
                };
                let model_id = if raw_model.id.trim().is_empty() {
                    model_key.clone()
                } else {
                    raw_model.id
                };
                if model_id.trim().is_empty() {
                    continue;
                }
                let (reasoning_options, has_unknown_options) =
                    parse_reasoning_options(&raw_model_value);
                models.insert(
                    model_key,
                    ModelsDevModel {
                        id: model_id,
                        name: raw_model.name.and_then(non_empty),
                        description: raw_model.description.and_then(non_empty),
                        family: raw_model.family.and_then(non_empty),
                        status: raw_model.status.and_then(non_empty),
                        release_date: raw_model.release_date.and_then(non_empty),
                        last_updated: raw_model.last_updated.and_then(non_empty),
                        knowledge: raw_model.knowledge.and_then(non_empty),
                        open_weights: raw_model.open_weights,
                        attachment: raw_model.attachment.unwrap_or(false),
                        reasoning: raw_model.reasoning.unwrap_or(false),
                        tool_call: raw_model.tool_call.unwrap_or(false),
                        structured_output: raw_model.structured_output.unwrap_or(false),
                        input_modalities: raw_model
                            .modalities
                            .as_ref()
                            .map(|modalities| normalize_string_values(modalities.input.clone()))
                            .unwrap_or_default(),
                        output_modalities: raw_model
                            .modalities
                            .as_ref()
                            .map(|modalities| normalize_string_values(modalities.output.clone()))
                            .unwrap_or_default(),
                        reasoning_options,
                        has_unknown_options,
                        output_limit: raw_model.limit.as_ref().and_then(|limit| limit.output),
                        context_limit: raw_model.limit.as_ref().and_then(|limit| limit.context),
                        input_limit: raw_model.limit.as_ref().and_then(|limit| limit.input),
                        pricing: raw_model.cost.and_then(provider_pricing),
                    },
                );
            }
            if !models.is_empty() {
                parsed.insert(
                    provider_id.clone(),
                    ModelsDevProvider {
                        id: non_empty(raw_provider.id).unwrap_or_else(|| provider_id.clone()),
                        name: non_empty(raw_provider.name).unwrap_or_else(|| provider_id.clone()),
                        api: raw_provider.api.and_then(non_empty),
                        doc: raw_provider.doc.and_then(non_empty),
                        env: normalize_provider_env(raw_provider.env),
                        models,
                    },
                );
            }
        }
        Ok(Self { providers: parsed })
    }

    fn model(&self, provider_id: &str, model_id: &str) -> Option<&ModelsDevModel> {
        let provider_id = provider_id.trim().to_ascii_lowercase();
        self.providers
            .get(&provider_id)
            .and_then(|provider| provider.models.get(model_id))
            .or_else(|| {
                self.providers.get(&provider_id).and_then(|provider| {
                    provider.models.values().find(|model| model.id == model_id)
                })
            })
    }

    pub fn provider_facts(&self, provider_id: &str) -> Option<ModelsDevProviderFacts> {
        let provider = self
            .providers
            .get(&provider_id.trim().to_ascii_lowercase())?;
        Some(ModelsDevProviderFacts {
            id: provider.id.clone(),
            name: provider.name.clone(),
            api: provider.api.clone(),
            doc: provider.doc.clone(),
            env: provider.env.clone(),
        })
    }

    pub fn provider_models(&self, provider_id: &str) -> Vec<ModelsDevModelFacts> {
        let Some(provider) = self.providers.get(&provider_id.trim().to_ascii_lowercase()) else {
            return Vec::new();
        };
        provider
            .models
            .values()
            .filter(|model| model.supports_text_generation())
            .map(ModelsDevModel::facts)
            .collect()
    }

    /// All provider ids present in the catalog.
    pub fn provider_ids(&self) -> Vec<String> {
        self.providers.keys().cloned().collect()
    }

    /// Every text-generation model in the catalog paired with the provider id
    /// that owns it. Used by catalog-wide scans such as pricing lookup and
    /// provider inference for historical usage records.
    pub fn all_models(&self) -> Vec<(String, ModelsDevModelFacts)> {
        self.providers
            .iter()
            .flat_map(|(provider_id, provider)| {
                provider
                    .models
                    .values()
                    .filter(|model| model.supports_text_generation())
                    .map(move |model| (provider_id.clone(), model.facts()))
            })
            .collect()
    }

    pub fn canonical_model_id(&self, provider_id: &str, model_id: &str) -> Option<String> {
        self.model(provider_id, model_id)
            .map(|model| model.id.clone())
    }

    pub fn reasoning_binding_catalog(
        &self,
        revision: String,
        source: ModelsDevCatalogSource,
    ) -> ModelsDevReasoningCatalog {
        let mut providers = self
            .providers
            .iter()
            .filter_map(|(provider_id, provider)| {
                let mut models_by_id = BTreeMap::new();
                for model in provider.models.values().filter(|model| model.reasoning) {
                    models_by_id.entry(model.id.clone()).or_insert_with(|| {
                        ModelsDevReasoningModel {
                            id: model.id.clone(),
                            display_name: model.name.clone(),
                        }
                    });
                }
                let mut models = models_by_id.into_values().collect::<Vec<_>>();
                models.sort_by(|a, b| {
                    a.display_name
                        .as_deref()
                        .unwrap_or(&a.id)
                        .to_ascii_lowercase()
                        .cmp(
                            &b.display_name
                                .as_deref()
                                .unwrap_or(&b.id)
                                .to_ascii_lowercase(),
                        )
                        .then_with(|| a.id.cmp(&b.id))
                });
                (!models.is_empty()).then(|| ModelsDevReasoningProvider {
                    id: provider_id.clone(),
                    name: provider.name.clone(),
                    models,
                })
            })
            .collect::<Vec<_>>();
        providers.sort_by(|a, b| {
            a.name
                .to_ascii_lowercase()
                .cmp(&b.name.to_ascii_lowercase())
                .then_with(|| a.id.cmp(&b.id))
        });
        ModelsDevReasoningCatalog {
            revision,
            source,
            providers,
        }
    }
}

impl ModelsDevModel {
    fn supports_text_generation(&self) -> bool {
        let model_id = self.id.to_ascii_lowercase();
        let family = self
            .family
            .as_deref()
            .unwrap_or_default()
            .to_ascii_lowercase();
        let is_specialized_non_chat = ["embed", "embedding", "rerank", "moderation"]
            .iter()
            .any(|marker| model_id.contains(marker) || family.contains(marker));
        !is_specialized_non_chat
            && (self.input_modalities.is_empty()
                || self.input_modalities.iter().any(|value| value == "text"))
            && (self.output_modalities.is_empty()
                || self.output_modalities.iter().any(|value| value == "text"))
    }

    fn facts(&self) -> ModelsDevModelFacts {
        let limits = ProviderCatalogModelLimits {
            context: self.context_limit,
            input: self.input_limit,
            output: self.output_limit,
        };
        ModelsDevModelFacts {
            id: self.id.clone(),
            display_name: self.name.clone(),
            description: self.description.clone(),
            family: self.family.clone(),
            status: self.status.clone(),
            release_date: self.release_date.clone(),
            last_updated: self.last_updated.clone(),
            knowledge: self.knowledge.clone(),
            open_weights: self.open_weights,
            capabilities: ProviderCatalogModelCapabilities {
                chat: self.input_modalities.is_empty()
                    || self.input_modalities.iter().any(|value| value == "text"),
                tool_call: self.tool_call,
                reasoning: self.reasoning,
                attachment: self.attachment
                    || self.input_modalities.iter().any(|value| value != "text"),
                structured_output: self.structured_output,
                input_modalities: self.input_modalities.clone(),
                output_modalities: self.output_modalities.clone(),
            },
            limits: (limits.context.is_some() || limits.input.is_some() || limits.output.is_some())
                .then_some(limits),
            pricing: self.pricing.clone(),
        }
    }
}

fn non_empty(value: String) -> Option<String> {
    let value = value.trim();
    (!value.is_empty()).then(|| value.to_string())
}

fn normalize_string_values(values: Vec<String>) -> Vec<String> {
    let mut values = values
        .into_iter()
        .filter_map(non_empty)
        .map(|value| value.to_ascii_lowercase())
        .collect::<Vec<_>>();
    values.sort();
    values.dedup();
    values
}

fn normalize_provider_env(values: Vec<String>) -> Vec<String> {
    let mut values = values.into_iter().filter_map(non_empty).collect::<Vec<_>>();
    values.sort();
    values.dedup();
    values
}

fn provider_pricing(cost: RawCost) -> Option<ProviderCatalogModelPricing> {
    let pricing = ProviderCatalogModelPricing {
        input: cost.input.map(|value| value.to_string()),
        output: cost.output.map(|value| value.to_string()),
        cache_read: cost.cache_read.map(|value| value.to_string()),
        cache_write: cost.cache_write.map(|value| value.to_string()),
    };
    (pricing.input.is_some()
        || pricing.output.is_some()
        || pricing.cache_read.is_some()
        || pricing.cache_write.is_some())
    .then_some(pricing)
}

#[derive(Debug, Clone, Copy, Default)]
struct AdapterReasoningSupport {
    effort: bool,
    nullable_effort: bool,
    toggle: bool,
    budget_tokens: bool,
}

/// Project a source catalog and user-configured presets into the stable DTO
/// consumed by remote and Web UI surfaces.
pub fn project_reasoning_catalog_with_limit(
    provider: &str,
    model_id: &str,
    base_url: &str,
    effective_max_output_tokens: u32,
    configured: Option<&ReasoningConfig>,
    models_dev: Option<&ModelsDevCatalog>,
) -> ReasoningCatalogProjection {
    project_reasoning_catalog_with_limit_and_auto_binding(
        provider,
        model_id,
        base_url,
        effective_max_output_tokens,
        configured,
        models_dev,
        None,
    )
}

pub fn project_reasoning_catalog_with_limit_and_auto_binding(
    provider: &str,
    model_id: &str,
    base_url: &str,
    effective_max_output_tokens: u32,
    configured: Option<&ReasoningConfig>,
    models_dev: Option<&ModelsDevCatalog>,
    trusted_auto_binding: Option<(&str, &str)>,
) -> ReasoningCatalogProjection {
    let binding = configured
        .map(|config| &config.catalog)
        .cloned()
        .unwrap_or_default();
    let source_match = match &binding {
        ReasoningCatalogBinding::Disabled => None,
        ReasoningCatalogBinding::Auto => models_dev.and_then(|catalog| {
            if let Some((source_provider, source_model)) = trusted_auto_binding {
                return Some((
                    source_provider,
                    catalog.model(source_provider, source_model)?,
                ));
            }
            let source_provider = auto_provider_id(provider, base_url)?;
            Some((source_provider, catalog.model(source_provider, model_id)?))
        }),
        ReasoningCatalogBinding::ModelsDev {
            provider: source_provider,
            model,
        } => models_dev
            .and_then(|catalog| catalog.model(source_provider, model))
            .map(|source_model| (source_provider.as_str(), source_model)),
    };

    let mut descriptors = BTreeMap::<String, ReasoningPresetDescriptor>::new();
    let mut unavailable_descriptors = BTreeMap::<String, ReasoningPresetDescriptor>::new();
    let mut has_unmapped_reasoning = false;
    if let Some((source_provider, source_model)) = source_match {
        if source_model.reasoning {
            let support =
                adapter_reasoning_support(provider, base_url, &source_model.id, source_provider);
            for option in source_model.reasoning_options.iter().flatten() {
                let generated = match option {
                    ModelsDevReasoningOption::Effort { values } if support.effort => {
                        effort_descriptors(
                            values,
                            support.nullable_effort,
                            ReasoningPresetSource::ModelsDev,
                            source_provider,
                            &source_model.id,
                        )
                    }
                    ModelsDevReasoningOption::Toggle if support.toggle => toggle_descriptors(
                        ReasoningPresetSource::ModelsDev,
                        source_provider,
                        &source_model.id,
                    ),
                    ModelsDevReasoningOption::BudgetTokens { min, max }
                        if support.budget_tokens =>
                    {
                        budget_descriptors(
                            *min,
                            *max,
                            source_model.output_limit,
                            effective_max_output_tokens,
                            provider,
                            ReasoningPresetSource::ModelsDev,
                            source_provider,
                            &source_model.id,
                        )
                    }
                    ModelsDevReasoningOption::Effort { .. }
                    | ModelsDevReasoningOption::Toggle
                    | ModelsDevReasoningOption::BudgetTokens { .. } => {
                        has_unmapped_reasoning = true;
                        if matches!(binding, ReasoningCatalogBinding::ModelsDev { .. }) {
                            let unavailable = match option {
                                ModelsDevReasoningOption::Effort { values } => effort_descriptors(
                                    values,
                                    support.nullable_effort,
                                    ReasoningPresetSource::ModelsDev,
                                    source_provider,
                                    &source_model.id,
                                ),
                                ModelsDevReasoningOption::Toggle => toggle_descriptors(
                                    ReasoningPresetSource::ModelsDev,
                                    source_provider,
                                    &source_model.id,
                                ),
                                ModelsDevReasoningOption::BudgetTokens { min, max } => {
                                    budget_descriptors(
                                        *min,
                                        *max,
                                        source_model.output_limit,
                                        effective_max_output_tokens,
                                        provider,
                                        ReasoningPresetSource::ModelsDev,
                                        source_provider,
                                        &source_model.id,
                                    )
                                }
                            };
                            for descriptor in unavailable {
                                unavailable_descriptors.insert(descriptor.id.clone(), descriptor);
                            }
                        }
                        Vec::new()
                    }
                };
                for descriptor in generated {
                    descriptors.insert(descriptor.id.clone(), descriptor);
                }
            }
            has_unmapped_reasoning |= source_model.has_unknown_options;

            // models.dev currently describes GLM-5.2's effective effort levels
            // but omits the vendor-documented thinking toggle. Fill only this
            // tested adapter gap for trusted auto bindings; explicit bindings
            // to arbitrary gateways do not gain adapter-inferred capability.
            if matches!(binding, ReasoningCatalogBinding::Auto)
                && source_provider.eq_ignore_ascii_case("zhipuai")
                && is_glm_52_reasoning_effort_model(&source_model.id)
                && support.toggle
            {
                for descriptor in toggle_descriptors(
                    ReasoningPresetSource::AdapterFallback,
                    source_provider,
                    &source_model.id,
                ) {
                    descriptors
                        .entry(descriptor.id.clone())
                        .or_insert(descriptor);
                }
            }
        }
    }

    // models.dev remains authoritative when it explicitly says the model is
    // not reasoning-capable or exposes no selectable control. Otherwise, a
    // tested adapter fallback fills gaps in a missing or incomplete snapshot.
    // An explicit models.dev binding may point at an arbitrary gateway and
    // must not grant adapter-inferred capability.
    let allows_adapter_fallback = matches!(binding, ReasoningCatalogBinding::Auto)
        && source_match.is_none_or(|(_, model)| model.reasoning)
        && source_match.is_none_or(|(_, model)| model.reasoning_options.is_none());
    if allows_adapter_fallback {
        let support = adapter_reasoning_support(provider, base_url, model_id, provider);
        for descriptor in adapter_fallback_descriptors(
            provider,
            model_id,
            base_url,
            effective_max_output_tokens,
            support,
        ) {
            descriptors
                .entry(descriptor.id.clone())
                .or_insert(descriptor);
        }
    }

    // A model catalog can never stay perfectly current. When auto detection
    // produced no usable projection, expose a small protocol-level manual
    // fallback instead of hiding the control. Auto remains the default; these
    // presets are applied only after an explicit user selection. More precise
    // model- or provider-specific presets continue to win above.
    if allows_adapter_fallback && descriptors.is_empty() {
        for descriptor in generic_reasoning_descriptors(provider, model_id) {
            descriptors.insert(descriptor.id.clone(), descriptor);
        }
    }

    if let Some(config) = configured {
        let (execution_provider, execution_model) = source_match
            .map(|(source_provider, source_model)| {
                (source_provider.to_string(), source_model.id.clone())
            })
            .unwrap_or_else(|| (provider.to_string(), model_id.to_string()));
        for preset in &config.presets {
            let preset_id = preset.id.trim();
            if preset_id.is_empty() {
                continue;
            }
            if preset.disabled {
                descriptors.remove(preset_id);
                unavailable_descriptors.remove(preset_id);
                continue;
            }
            if preset.actions.is_empty() {
                descriptors.remove(preset_id);
                unavailable_descriptors.remove(preset_id);
                continue;
            }
            unavailable_descriptors.remove(preset_id);
            descriptors.insert(
                preset_id.to_string(),
                ReasoningPresetDescriptor {
                    id: preset_id.to_string(),
                    label: preset
                        .label
                        .clone()
                        .filter(|label| !label.trim().is_empty())
                        .unwrap_or_else(|| display_label(preset_id)),
                    order: preset.order.unwrap_or(100),
                    actions: preset.actions.clone(),
                    source: ReasoningPresetSource::ModelConfig,
                    effective_effort: None,
                    execution_provider: Some(execution_provider.clone()),
                    execution_model: Some(execution_model.clone()),
                },
            );
        }
    }

    let mut presets = descriptors.into_values().collect::<Vec<_>>();
    for preset in &mut presets {
        preset.effective_effort = reasoning_display_effort(provider, base_url, preset);
    }
    presets.sort_by(|left, right| {
        left.order
            .cmp(&right.order)
            .then_with(|| left.id.cmp(&right.id))
    });
    let mut unavailable_presets = unavailable_descriptors.into_values().collect::<Vec<_>>();
    unavailable_presets.sort_by(|left, right| {
        left.order
            .cmp(&right.order)
            .then_with(|| left.id.cmp(&right.id))
    });
    let status = if !presets.is_empty() {
        ReasoningCapabilityStatus::Known
    } else if matches!(binding, ReasoningCatalogBinding::Disabled) {
        ReasoningCapabilityStatus::Unsupported
    } else if has_unmapped_reasoning {
        ReasoningCapabilityStatus::Unknown
    } else if source_match.is_some_and(|(_, model)| {
        model.reasoning
            && model.reasoning_options.as_ref().is_some_and(Vec::is_empty)
            && !model.has_unknown_options
    }) {
        ReasoningCapabilityStatus::Known
    } else if source_match.is_some() {
        ReasoningCapabilityStatus::Unsupported
    } else {
        ReasoningCapabilityStatus::Unknown
    };
    let default_preset = configured
        .and_then(|config| config.default_preset.as_deref())
        .map(str::trim)
        .filter(|id| !id.is_empty())
        .filter(|id| presets.iter().any(|preset| preset.id == *id));

    ReasoningCatalogProjection {
        status,
        default_preset: default_preset.map(ToOwned::to_owned),
        presets,
        unavailable_presets,
    }
}

#[cfg(test)]
fn project_reasoning_catalog(
    provider: &str,
    model_id: &str,
    base_url: &str,
    configured: Option<&ReasoningConfig>,
    models_dev: Option<&ModelsDevCatalog>,
) -> ReasoningCatalogProjection {
    project_reasoning_catalog_with_limit(
        provider, model_id, base_url, 32_000, configured, models_dev,
    )
}

fn auto_provider_id(provider: &str, base_url: &str) -> Option<&'static str> {
    let provider = provider.trim().to_ascii_lowercase();
    let endpoint = reqwest::Url::parse(base_url.trim()).ok()?;
    if endpoint.scheme() != "https" || endpoint.port_or_known_default() != Some(443) {
        return None;
    }
    let host = endpoint.host_str()?.trim_end_matches('.');
    match (provider.as_str(), host) {
        ("response" | "responses" | "openai", "api.openai.com") => Some("openai"),
        ("anthropic", "api.anthropic.com") => Some("anthropic"),
        ("gemini" | "google", "generativelanguage.googleapis.com") => Some("google"),
        ("deepseek" | "openai" | "anthropic", "api.deepseek.com") => Some("deepseek"),
        ("openai" | "anthropic", "open.bigmodel.cn" | "api.z.ai") => Some("zhipuai"),
        _ => None,
    }
}

fn adapter_reasoning_support(
    provider: &str,
    base_url: &str,
    execution_model: &str,
    execution_provider: &str,
) -> AdapterReasoningSupport {
    let provider = provider.trim().to_ascii_lowercase();
    let execution_provider = execution_provider.trim().to_ascii_lowercase();
    let execution_model = execution_model.trim().to_ascii_lowercase();
    if provider == "deepseek" || base_url.to_ascii_lowercase().contains("api.deepseek.com") {
        return AdapterReasoningSupport {
            effort: true,
            toggle: true,
            ..Default::default()
        };
    }
    if execution_provider == "deepseek"
        && is_deepseek_reasoning_effort_model(&execution_model)
        && matches!(provider.as_str(), "openai" | "anthropic")
    {
        return AdapterReasoningSupport {
            effort: true,
            toggle: true,
            ..Default::default()
        };
    }
    if (execution_provider == "zhipuai"
        && is_glm_52_reasoning_effort_model(&execution_model)
        && matches!(provider.as_str(), "openai" | "anthropic"))
        || (is_zhipuai_url(base_url)
            && is_glm_52_reasoning_effort_model(&execution_model)
            && matches!(provider.as_str(), "openai" | "anthropic"))
    {
        return AdapterReasoningSupport {
            effort: true,
            toggle: true,
            ..Default::default()
        };
    }
    if matches!(provider.as_str(), "response" | "responses")
        || (provider == "openai" && is_responses_endpoint(base_url))
    {
        return AdapterReasoningSupport {
            effort: true,
            nullable_effort: true,
            ..Default::default()
        };
    }
    match provider.as_str() {
        "anthropic" => {
            let capability = anthropic_thinking_capability(&execution_model);
            AdapterReasoningSupport {
                effort: !matches!(capability, AnthropicThinkingCapability::ManualOnly),
                toggle: !matches!(
                    capability,
                    AnthropicThinkingCapability::AdaptiveOnly
                        | AnthropicThinkingCapability::AdaptiveDefaultNoDisabled
                ),
                budget_tokens: !matches!(
                    capability,
                    AnthropicThinkingCapability::AdaptiveOnly
                        | AnthropicThinkingCapability::AdaptiveDefaultNoDisabled
                ),
                ..Default::default()
            }
        }
        "gemini" | "google" => gemini_reasoning_support(&execution_model),
        _ => Default::default(),
    }
}

fn gemini_reasoning_support(model: &str) -> AdapterReasoningSupport {
    let model = model.trim().to_ascii_lowercase();
    if model.starts_with("gemini-3-") {
        return AdapterReasoningSupport {
            effort: true,
            ..Default::default()
        };
    }
    if model.starts_with("gemini-2.5-") {
        return AdapterReasoningSupport {
            toggle: model.contains("flash"),
            budget_tokens: true,
            ..Default::default()
        };
    }
    AdapterReasoningSupport::default()
}

fn is_responses_endpoint(base_url: &str) -> bool {
    base_url
        .trim_end_matches('/')
        .to_ascii_lowercase()
        .ends_with("/responses")
}

fn is_codex_chatgpt_path(path: &str) -> bool {
    let path = path.trim_end_matches('/');
    path == "/backend-api/codex" || path == "/backend-api/codex/responses"
}

fn adapter_fallback_descriptors(
    provider: &str,
    model_id: &str,
    base_url: &str,
    effective_max_output_tokens: u32,
    support: AdapterReasoningSupport,
) -> Vec<ReasoningPresetDescriptor> {
    let Some(provider_id) = adapter_fallback_provider_id(provider, base_url) else {
        return Vec::new();
    };
    let model_id = model_id.trim().to_ascii_lowercase();
    let source = ReasoningPresetSource::AdapterFallback;

    match provider_id {
        // Keep these tables deliberately conservative. A future model is not
        // assumed compatible merely because the protocol has an effort field.
        "openai" if support.effort => {
            if is_codex_chatgpt_base_url(base_url) && is_known_codex_reasoning_model(&model_id) {
                // The Codex adapter clamps unsupported `minimal` and uses
                // medium by default. low/medium/high is the tested common set
                // across its built-in model table.
                effort_descriptors(
                    &[
                        Some("low".to_string()),
                        Some("medium".to_string()),
                        Some("high".to_string()),
                    ],
                    false,
                    source,
                    provider,
                    model_id.as_str(),
                )
            } else {
                match model_id.as_str() {
                    "gpt-5.4" => effort_descriptors(
                        &[
                            Some("none".into()),
                            Some("low".into()),
                            Some("medium".into()),
                            Some("high".into()),
                            Some("xhigh".into()),
                        ],
                        true,
                        source,
                        provider,
                        model_id.as_str(),
                    ),
                    "gpt-5.2-pro" => effort_descriptors(
                        &[
                            Some("medium".into()),
                            Some("high".into()),
                            Some("xhigh".into()),
                        ],
                        false,
                        source,
                        provider,
                        model_id.as_str(),
                    ),
                    _ => Vec::new(),
                }
            }
        }
        "anthropic" => match anthropic_thinking_capability(&model_id) {
            AnthropicThinkingCapability::AdaptivePreferred
            | AnthropicThinkingCapability::AdaptiveOnly
            | AnthropicThinkingCapability::AdaptiveDefaultNoDisabled
                if support.effort =>
            {
                // low/medium/high is the conservative common subset for the
                // adaptive families recognized by the request adapter. More
                // model-specific values such as max/xhigh remain models.dev
                // facts and are not inferred here.
                effort_descriptors(
                    &[
                        Some("low".into()),
                        Some("medium".into()),
                        Some("high".into()),
                    ],
                    false,
                    source,
                    provider,
                    model_id.as_str(),
                )
            }
            // These exact models are covered by the adapter's manual-thinking
            // request tests or built-in model list. `ManualOnly` is otherwise
            // the unknown/default classification, so it must never become a
            // family-wide fallback. Budget choices are derived from max_tokens
            // at request time, so the catalog exposes only a safe on/off mode.
            AnthropicThinkingCapability::ManualOnly
                if matches!(model_id.as_str(), "claude-sonnet-4-5" | "claude-haiku-4-5")
                    && support.toggle =>
            {
                toggle_descriptors(source, provider, model_id.as_str())
            }
            _ => Vec::new(),
        },
        "deepseek"
            if is_deepseek_reasoning_effort_model(&model_id)
                && support.effort
                && support.toggle =>
        {
            let mut descriptors = toggle_descriptors(source, provider, model_id.as_str());
            let efforts = if model_id == "deepseek-v4-flash" {
                vec![Some("low".into()), Some("high".into()), Some("max".into())]
            } else {
                vec![Some("high".into()), Some("max".into())]
            };
            descriptors.extend(effort_descriptors(
                &efforts,
                false,
                source,
                provider,
                model_id.as_str(),
            ));
            descriptors
        }
        "zhipuai" if is_glm_52_reasoning_effort_model(&model_id) && support.effort => {
            let mut descriptors = Vec::new();
            if support.toggle {
                descriptors.extend(toggle_descriptors(source, provider, model_id.as_str()));
            }
            descriptors.extend(effort_descriptors(
                &[Some("high".into()), Some("max".into())],
                false,
                source,
                provider,
                model_id.as_str(),
            ));
            descriptors
        }
        "google" if support.effort && model_id.starts_with("gemini-3-") => effort_descriptors(
            &[
                Some("low".into()),
                Some("medium".into()),
                Some("high".into()),
            ],
            false,
            source,
            provider,
            model_id.as_str(),
        ),
        "google" if support.budget_tokens && model_id.starts_with("gemini-2.5-") => {
            budget_descriptors(
                Some(1_024),
                None,
                None,
                effective_max_output_tokens,
                provider,
                source,
                provider,
                model_id.as_str(),
            )
        }
        // Gemini can serialize the current mode, but the adapter does not yet
        // own a tested model-level table for whether thinking can be disabled
        // or which budgets/levels are accepted. Keep it fail closed here.
        _ => Vec::new(),
    }
}

fn generic_reasoning_descriptors(provider: &str, model_id: &str) -> Vec<ReasoningPresetDescriptor> {
    let provider = provider.trim().to_ascii_lowercase();
    if !matches!(
        provider.as_str(),
        "openai" | "response" | "responses" | "anthropic" | "gemini" | "google"
    ) {
        return Vec::new();
    }

    let model_id = model_id.trim().to_ascii_lowercase();
    let source = ReasoningPresetSource::AdapterFallback;
    let execution_provider = crate::providers::shared::GENERIC_REASONING_PROVIDER_ID;
    let mut descriptors = toggle_descriptors(source, execution_provider, &model_id);
    descriptors.extend(effort_descriptors(
        &[
            Some("low".into()),
            Some("medium".into()),
            Some("high".into()),
        ],
        false,
        source,
        execution_provider,
        &model_id,
    ));
    descriptors
}

fn adapter_fallback_provider_id(provider: &str, base_url: &str) -> Option<&'static str> {
    if let Some(provider_id) = auto_provider_id(provider, base_url) {
        return Some(provider_id);
    }

    let provider = provider.trim().to_ascii_lowercase();
    let endpoint = reqwest::Url::parse(base_url.trim()).ok()?;
    if endpoint.scheme() != "https" || endpoint.port_or_known_default() != Some(443) {
        return None;
    }
    let host = endpoint.host_str()?.trim_end_matches('.');
    match (provider.as_str(), host) {
        ("response" | "responses", "chatgpt.com") if is_codex_chatgpt_path(endpoint.path()) => {
            Some("openai")
        }
        _ => None,
    }
}

fn is_codex_chatgpt_base_url(base_url: &str) -> bool {
    reqwest::Url::parse(base_url.trim())
        .ok()
        .is_some_and(|url| {
            url.scheme() == "https"
                && url.port_or_known_default() == Some(443)
                && url
                    .host_str()
                    .is_some_and(|host| host.trim_end_matches('.') == "chatgpt.com")
                && is_codex_chatgpt_path(url.path())
        })
}

// Display aliases follow the existing executing adapter without changing which
// presets the catalog recognizes, or their persisted ids and request actions.
fn reasoning_display_effort(
    provider: &str,
    base_url: &str,
    preset: &ReasoningPresetDescriptor,
) -> Option<String> {
    let execution_provider = preset.execution_provider.as_deref()?;
    if preset.source == ReasoningPresetSource::ModelConfig
        || execution_provider == crate::providers::shared::GENERIC_REASONING_PROVIDER_ID
    {
        return None;
    }
    let provider = provider.trim().to_ascii_lowercase();
    if !matches!(provider.as_str(), "openai" | "anthropic" | "deepseek")
        || (provider == "openai" && is_responses_endpoint(base_url))
    {
        return None;
    }
    let execution_model = preset.execution_model.as_deref()?;
    let effort = preset.actions.iter().find_map(|action| match action {
        ReasoningPresetAction::Effort { value } => Some(value.as_str()),
        _ => None,
    })?;
    if execution_provider.eq_ignore_ascii_case("deepseek")
        || is_deepseek_url(base_url)
        || is_deepseek_reasoning_effort_model(execution_model)
    {
        normalize_deepseek_reasoning_effort(execution_model, effort).map(ToOwned::to_owned)
    } else if is_glm_52_reasoning_effort_model(execution_model)
        && (execution_provider.eq_ignore_ascii_case("zhipuai") || is_zhipuai_url(base_url))
    {
        normalize_glm_52_reasoning_effort(effort).map(ToOwned::to_owned)
    } else {
        None
    }
}

fn effort_descriptors(
    values: &[Option<String>],
    nullable_effort: bool,
    source: ReasoningPresetSource,
    execution_provider: &str,
    execution_model: &str,
) -> Vec<ReasoningPresetDescriptor> {
    values
        .iter()
        .filter_map(|value| value.as_deref().or(nullable_effort.then_some("none")))
        .enumerate()
        .map(|(index, value)| ReasoningPresetDescriptor {
            id: effort_id(value),
            label: display_label(value),
            order: 10 + index as i32,
            actions: vec![ReasoningPresetAction::Effort {
                value: value.to_string(),
            }],
            source,
            effective_effort: None,
            execution_provider: Some(execution_provider.to_string()),
            execution_model: Some(execution_model.to_string()),
        })
        .collect()
}

fn effort_id(value: &str) -> String {
    let value = value.trim().to_ascii_lowercase();
    if matches!(value.as_str(), "on" | "off" | "budget-high" | "budget-max") {
        format!("effort-{value}")
    } else {
        value
    }
}

fn toggle_descriptors(
    source: ReasoningPresetSource,
    execution_provider: &str,
    execution_model: &str,
) -> Vec<ReasoningPresetDescriptor> {
    vec![
        ReasoningPresetDescriptor {
            id: "off".to_string(),
            label: "Off".to_string(),
            order: 0,
            actions: vec![ReasoningPresetAction::Toggle { enabled: false }],
            source,
            effective_effort: None,
            execution_provider: Some(execution_provider.to_string()),
            execution_model: Some(execution_model.to_string()),
        },
        ReasoningPresetDescriptor {
            id: "on".to_string(),
            label: "On".to_string(),
            order: 1,
            actions: vec![ReasoningPresetAction::Toggle { enabled: true }],
            source,
            effective_effort: None,
            execution_provider: Some(execution_provider.to_string()),
            execution_model: Some(execution_model.to_string()),
        },
    ]
}

fn budget_descriptors(
    min: Option<u32>,
    max: Option<u32>,
    source_output_limit: Option<u32>,
    effective_max_output_tokens: u32,
    target_provider: &str,
    source: ReasoningPresetSource,
    execution_provider: &str,
    execution_model: &str,
) -> Vec<ReasoningPresetDescriptor> {
    let min = min.unwrap_or(1).max(1);
    let mut safe_max = max.unwrap_or(u32::MAX).min(effective_max_output_tokens);
    if let Some(output_limit) = source_output_limit {
        safe_max = safe_max.min(output_limit);
    }
    if target_provider.eq_ignore_ascii_case("anthropic") {
        safe_max = safe_max.min(effective_max_output_tokens.saturating_sub(1));
    }
    if safe_max < min || safe_max == 0 {
        return Vec::new();
    }
    let high = min.saturating_add(safe_max.saturating_sub(min) / 2);
    let values = if high == safe_max {
        vec![("budget-max", safe_max)]
    } else {
        vec![("budget-high", high), ("budget-max", safe_max)]
    };
    values
        .into_iter()
        .enumerate()
        .map(|(index, (id, value))| ReasoningPresetDescriptor {
            id: id.to_string(),
            label: if id == "budget-high" {
                "Budget high".to_string()
            } else {
                "Budget max".to_string()
            },
            order: 30 + index as i32,
            actions: vec![ReasoningPresetAction::BudgetTokens { value }],
            source,
            effective_effort: None,
            execution_provider: Some(execution_provider.to_string()),
            execution_model: Some(execution_model.to_string()),
        })
        .collect()
}

fn display_label(value: &str) -> String {
    let mut chars = value.chars();
    chars
        .next()
        .map(|first| first.to_uppercase().collect::<String>() + chars.as_str())
        .unwrap_or_default()
}

#[cfg(test)]
mod tests {
    use super::{
        project_reasoning_catalog, project_reasoning_catalog_with_limit,
        project_reasoning_catalog_with_limit_and_auto_binding, ModelsDevCatalog,
    };
    use crate::providers::shared::GENERIC_REASONING_PROVIDER_ID;
    use openbitfun_core_types::{
        ModelsDevCatalogSource, ReasoningCapabilityStatus, ReasoningCatalogBinding,
        ReasoningConfig, ReasoningPreset, ReasoningPresetAction, ReasoningPresetSource,
    };

    fn catalog() -> ModelsDevCatalog {
        ModelsDevCatalog::parse_str(
            r#"{
                "openai": {"models": {
                    "gpt-test": {"id":"gpt-test","reasoning":true,
                        "reasoning_options":{"type":"effort","values":["low","high"]}}
                }},
                "anthropic": {"models": {
                    "claude-sonnet-4-6": {"id":"claude-sonnet-4-6","reasoning":true,
                        "reasoning_options":[{"type":"effort","values":["low","high"]},{"type":"budget_tokens","min":1024}]},
                    "claude-fable-5": {"id":"claude-fable-5","reasoning":true,
                        "reasoning_options":{"type":"effort","values":["low","medium","high","xhigh","max"]}}
                }},
                "deepseek": {"models": {
                    "deepseek-v4-flash": {"id":"deepseek-v4-flash","reasoning":true,
                        "reasoning_options":[{"type":"toggle"},{"type":"effort","values":["low","high","max"]}]},
                    "deepseek-v4-pro": {"id":"deepseek-v4-pro","reasoning":true,
                        "reasoning_options":[{"type":"toggle"},{"type":"effort","values":["high","max"]}]}
                }},
                "zhipuai": {"models": {
                    "glm-5.2": {"id":"glm-5.2","reasoning":true,
                        "reasoning_options":{"type":"effort","values":["high","max"]}}
                }},
                "google": {"models": {
                    "gemini-test": {"id":"gemini-test","reasoning":true,
                        "reasoning_options":{"type":"toggle"}}
                }}
            }"#,
        )
        .expect("catalog should parse")
    }

    #[test]
    fn reasoning_binding_catalog_projects_all_reasoning_providers_deterministically() {
        let catalog = ModelsDevCatalog::parse_str(
            r#"{
                "zeta": {"name":"Zeta", "models": {
                    "plain": {"id":"plain", "name":"Plain", "reasoning":false},
                    "reason-b": {"id":"reason-b", "name":"Beta", "reasoning":true},
                    "reason-a": {"id":"reason-a", "name":"Alpha", "reasoning":true}
                }},
                "alpha": {"name":"Alpha Provider", "models": {
                    "reason": {"id":"reason", "reasoning":true}
                }},
                "empty": {"name":"Empty", "models": {
                    "plain": {"id":"plain", "reasoning":false}
                }}
            }"#,
        )
        .expect("catalog");

        let projection = catalog
            .reasoning_binding_catalog("revision-1".to_string(), ModelsDevCatalogSource::Cache);

        assert_eq!(projection.revision, "revision-1");
        assert_eq!(projection.source, ModelsDevCatalogSource::Cache);
        assert_eq!(
            projection
                .providers
                .iter()
                .map(|provider| provider.id.as_str())
                .collect::<Vec<_>>(),
            vec!["alpha", "zeta"]
        );
        assert_eq!(
            projection.providers[1]
                .models
                .iter()
                .map(|model| (model.id.as_str(), model.display_name.as_deref()))
                .collect::<Vec<_>>(),
            vec![("reason-a", Some("Alpha")), ("reason-b", Some("Beta"))]
        );
    }

    #[test]
    fn provider_projection_tolerates_null_optional_fields_and_filters_non_chat_models() {
        let catalog = ModelsDevCatalog::parse_str(
            r#"{
                "nvidia": {
                    "id":"nvidia",
                    "name":"Nvidia",
                    "api":"https://integrate.api.nvidia.com/v1",
                    "env":["NVIDIA_API_KEY"],
                    "models": {
                        "chat": {"name":null,"family":null,"tool_call":true,
                            "modalities":{"input":["text"],"output":["text"]},
                            "release_date":"2026-01-02","open_weights":true,
                            "limit":{"context":128000,"output":8192},
                            "cost":{"input":0.5,"output":1.25}},
                        "embed": {"id":"nv-embed-v1","family":null,
                            "modalities":{"input":["text"],"output":["text"]}},
                        "tts": {"modalities":{"input":["text"],"output":["audio"]}}
                    }
                }
            }"#,
        )
        .expect("catalog");
        let provider = catalog.provider_facts("nvidia").expect("provider facts");
        assert_eq!(provider.env, vec!["NVIDIA_API_KEY"]);
        let models = catalog.provider_models("nvidia");
        assert_eq!(models.len(), 1);
        assert_eq!(models[0].id, "chat");
        assert_eq!(models[0].release_date.as_deref(), Some("2026-01-02"));
        assert_eq!(models[0].open_weights, Some(true));
        assert_eq!(
            models[0].limits.as_ref().and_then(|limit| limit.context),
            Some(128_000)
        );
        assert_eq!(
            models[0]
                .pricing
                .as_ref()
                .and_then(|pricing| pricing.input.as_deref()),
            Some("0.5")
        );
    }

    #[test]
    fn responses_effort_options_are_projected_as_known_presets() {
        let projection = project_reasoning_catalog(
            "responses",
            "gpt-test",
            "https://api.openai.com/v1/responses",
            None,
            Some(&catalog()),
        );

        assert_eq!(projection.status, ReasoningCapabilityStatus::Known);
        assert_eq!(
            projection
                .presets
                .iter()
                .map(|preset| preset.id.as_str())
                .collect::<Vec<_>>(),
            ["low", "high"]
        );
    }

    #[test]
    fn missing_options_allow_fallback_but_explicitly_empty_options_do_not() {
        let catalog = ModelsDevCatalog::parse_str(
            r#"{
                "openai": {"models": {
                    "gpt-5.4": {"reasoning":true},
                    "gpt-5.2-pro": {"reasoning":true,"reasoning_options":[]}
                }}
            }"#,
        )
        .expect("catalog should parse");

        let missing = project_reasoning_catalog(
            "responses",
            "gpt-5.4",
            "https://api.openai.com/v1/responses",
            None,
            Some(&catalog),
        );
        assert!(missing
            .presets
            .iter()
            .any(|preset| preset.source == ReasoningPresetSource::AdapterFallback));

        let empty = project_reasoning_catalog(
            "responses",
            "gpt-5.2-pro",
            "https://api.openai.com/v1/responses",
            None,
            Some(&catalog),
        );
        assert_eq!(empty.status, ReasoningCapabilityStatus::Known);
        assert!(empty.presets.is_empty());
    }

    #[test]
    fn nullable_effort_maps_to_none_only_for_an_exact_target_mapping() {
        let catalog = ModelsDevCatalog::parse_str(
            r#"{
                "openai": {"models": {
                    "gpt-null": {"reasoning":true,"reasoning_options":{
                        "type":"effort","values":[null,"high"]
                    }}
                }}
            }"#,
        )
        .expect("catalog should parse");

        let projection = project_reasoning_catalog(
            "responses",
            "gpt-null",
            "https://api.openai.com/v1/responses",
            Some(&ReasoningConfig {
                catalog: ReasoningCatalogBinding::ModelsDev {
                    provider: "openai".to_string(),
                    model: "gpt-null".to_string(),
                },
                ..Default::default()
            }),
            Some(&catalog),
        );
        assert!(projection.presets.iter().any(|preset| {
            preset.id == "none"
                && matches!(
                    preset.actions.as_slice(),
                    [ReasoningPresetAction::Effort { value }] if value == "none"
                )
        }));
    }

    #[test]
    fn budget_projection_honors_source_runtime_and_strict_provider_limits() {
        let catalog = ModelsDevCatalog::parse_str(
            r#"{
                "anthropic": {"models": {
                    "claude-sonnet-4-6": {
                        "reasoning":true,
                        "limit":{"output":6000},
                        "reasoning_options":{"type":"budget_tokens","min":1000,"max":10000}
                    }
                }}
            }"#,
        )
        .expect("catalog should parse");
        let projection = project_reasoning_catalog_with_limit(
            "anthropic",
            "claude-sonnet-4-6",
            "https://api.anthropic.com/v1/messages",
            4096,
            None,
            Some(&catalog),
        );
        let maximum = projection
            .presets
            .iter()
            .find(|preset| preset.id == "budget-max")
            .expect("bounded maximum");
        assert!(matches!(
            maximum.actions.as_slice(),
            [ReasoningPresetAction::BudgetTokens { value: 4095 }]
        ));
    }

    #[test]
    fn anthropic_budget_and_effort_options_are_merged() {
        let projection = project_reasoning_catalog(
            "anthropic",
            "claude-sonnet-4-6",
            "https://api.anthropic.com/v1/messages",
            None,
            Some(&catalog()),
        );

        assert_eq!(projection.status, ReasoningCapabilityStatus::Known);
        assert!(projection
            .presets
            .iter()
            .any(|preset| preset.id == "budget-high" || preset.id == "budget-max"));
        assert!(projection.presets.iter().any(|preset| {
            preset.id == "high"
                && matches!(
                    preset.actions.as_slice(),
                    [ReasoningPresetAction::Effort { value }] if value == "high"
                )
        }));
    }

    #[test]
    fn deepseek_toggle_and_effort_options_are_projected() {
        let projection = project_reasoning_catalog(
            "openai",
            "deepseek-v4-flash",
            "https://api.deepseek.com/v1",
            None,
            Some(&catalog()),
        );

        assert_eq!(projection.status, ReasoningCapabilityStatus::Known);
        assert!(projection.presets.iter().any(|preset| preset.id == "off"));
        assert!(projection.presets.iter().any(|preset| preset.id == "low"));
        assert!(projection.presets.iter().any(|preset| preset.id == "max"));
    }

    #[test]
    fn deepseek_flash_adapter_fallback_preserves_low_effort() {
        let projection = project_reasoning_catalog(
            "openai",
            "deepseek-v4-flash",
            "https://api.deepseek.com/v1",
            None,
            None,
        );

        assert_eq!(projection.status, ReasoningCapabilityStatus::Known);
        assert_eq!(
            projection
                .presets
                .iter()
                .map(|preset| preset.id.as_str())
                .collect::<Vec<_>>(),
            ["off", "on", "low", "high", "max"]
        );
        assert!(projection
            .presets
            .iter()
            .all(|preset| preset.source == ReasoningPresetSource::AdapterFallback));
    }

    #[test]
    fn zhipu_glm_52_uses_precise_fallback_only_on_official_endpoints() {
        for (provider, base_url) in [
            ("openai", "https://open.bigmodel.cn/api/paas/v4"),
            ("anthropic", "https://api.z.ai/api/anthropic"),
        ] {
            let projection = project_reasoning_catalog(provider, "glm-5.2", base_url, None, None);
            assert_eq!(projection.status, ReasoningCapabilityStatus::Known);
            assert_eq!(
                projection
                    .presets
                    .iter()
                    .map(|preset| preset.id.as_str())
                    .collect::<Vec<_>>(),
                ["off", "on", "high", "max"]
            );
            assert!(projection
                .presets
                .iter()
                .all(|preset| preset.source == ReasoningPresetSource::AdapterFallback));
        }

        let compatible_gateway = project_reasoning_catalog(
            "openai",
            "glm-5.2",
            "https://gateway.example.com/v1",
            None,
            None,
        );
        assert_eq!(compatible_gateway.status, ReasoningCapabilityStatus::Known);
        assert_eq!(
            compatible_gateway
                .presets
                .iter()
                .map(|preset| preset.id.as_str())
                .collect::<Vec<_>>(),
            ["off", "on", "low", "medium", "high"]
        );
        assert!(compatible_gateway.presets.iter().all(|preset| {
            preset.execution_provider.as_deref() == Some(GENERIC_REASONING_PROVIDER_ID)
        }));
    }

    #[test]
    fn trusted_relay_bindings_project_upstream_reasoning_options() {
        for (model, source_provider, expected) in [
            ("glm-5.2", "zhipuai", vec!["off", "on", "high", "max"]),
            (
                "deepseek-v4-flash",
                "deepseek",
                vec!["off", "on", "low", "high", "max"],
            ),
            (
                "deepseek-v4-pro",
                "deepseek",
                vec!["off", "on", "high", "max"],
            ),
        ] {
            let projection = project_reasoning_catalog_with_limit_and_auto_binding(
                "anthropic",
                model,
                "https://api.openbitfun.com",
                32_000,
                None,
                Some(&catalog()),
                Some((source_provider, model)),
            );

            assert_eq!(projection.status, ReasoningCapabilityStatus::Known);
            assert_eq!(
                projection
                    .presets
                    .iter()
                    .map(|preset| preset.id.as_str())
                    .collect::<Vec<_>>(),
                expected
            );
            assert!(projection.presets.iter().all(|preset| {
                preset.execution_provider.as_deref() == Some(source_provider)
                    && preset.execution_model.as_deref() == Some(model)
            }));
            assert!(projection.presets.iter().all(|preset| {
                preset.source == ReasoningPresetSource::ModelsDev
                    || (model == "glm-5.2"
                        && matches!(preset.id.as_str(), "off" | "on")
                        && preset.source == ReasoningPresetSource::AdapterFallback)
            }));
        }
    }

    #[test]
    fn tested_anthropic_family_uses_adapter_fallback_without_a_snapshot_model() {
        let projection = project_reasoning_catalog(
            "anthropic",
            "claude-opus-4-8",
            "https://api.anthropic.com/v1/messages",
            None,
            Some(&catalog()),
        );

        assert_eq!(projection.status, ReasoningCapabilityStatus::Known);
        assert_eq!(
            projection
                .presets
                .iter()
                .map(|preset| (preset.id.as_str(), preset.source))
                .collect::<Vec<_>>(),
            [
                ("low", ReasoningPresetSource::AdapterFallback),
                ("medium", ReasoningPresetSource::AdapterFallback),
                ("high", ReasoningPresetSource::AdapterFallback),
            ]
        );
    }

    #[test]
    fn tested_manual_anthropic_model_uses_conservative_toggle_fallback() {
        let projection = project_reasoning_catalog(
            "anthropic",
            "claude-haiku-4-5",
            "https://api.anthropic.com/v1/messages",
            None,
            None,
        );

        assert_eq!(projection.status, ReasoningCapabilityStatus::Known);
        assert_eq!(
            projection
                .presets
                .iter()
                .map(|preset| preset.id.as_str())
                .collect::<Vec<_>>(),
            ["off", "on"]
        );
        assert!(projection
            .presets
            .iter()
            .all(|preset| preset.source == ReasoningPresetSource::AdapterFallback));
    }

    #[test]
    fn codex_builtin_model_uses_adapter_fallback_without_a_snapshot_model() {
        let projection = project_reasoning_catalog(
            "responses",
            "gpt-5.5",
            "https://chatgpt.com/backend-api/codex",
            None,
            Some(&catalog()),
        );

        assert_eq!(projection.status, ReasoningCapabilityStatus::Known);
        assert_eq!(
            projection
                .presets
                .iter()
                .map(|preset| preset.id.as_str())
                .collect::<Vec<_>>(),
            ["low", "medium", "high"]
        );
        assert!(projection
            .presets
            .iter()
            .all(|preset| preset.source == ReasoningPresetSource::AdapterFallback));
    }

    #[test]
    fn codex_endpoint_does_not_auto_bind_public_openai_catalog_records() {
        let public_openai = ModelsDevCatalog::parse_str(
            r#"{
                "openai": {"models": {
                    "gpt-5.5": {
                        "id":"gpt-5.5",
                        "reasoning":true,
                        "reasoning_options":{"type":"effort","values":["xhigh"]}
                    }
                }}
            }"#,
        )
        .expect("catalog should parse");
        let projection = project_reasoning_catalog(
            "responses",
            "gpt-5.5",
            "https://chatgpt.com/backend-api/codex/responses",
            None,
            Some(&public_openai),
        );

        assert_eq!(
            projection
                .presets
                .iter()
                .map(|preset| preset.id.as_str())
                .collect::<Vec<_>>(),
            ["low", "medium", "high"]
        );
        assert!(projection
            .presets
            .iter()
            .all(|preset| preset.source == ReasoningPresetSource::AdapterFallback));
    }

    #[test]
    fn deepseek_exact_model_uses_adapter_fallback_when_catalog_is_unavailable() {
        let projection = project_reasoning_catalog(
            "deepseek",
            "deepseek-v4-pro",
            "https://api.deepseek.com/v1",
            None,
            None,
        );

        assert_eq!(projection.status, ReasoningCapabilityStatus::Known);
        assert_eq!(
            projection
                .presets
                .iter()
                .map(|preset| preset.id.as_str())
                .collect::<Vec<_>>(),
            ["off", "on", "high", "max"]
        );
        assert!(projection
            .presets
            .iter()
            .all(|preset| preset.source == ReasoningPresetSource::AdapterFallback));
    }

    #[test]
    fn explicit_options_suppress_fallback_and_model_config_still_wins() {
        let partial = ModelsDevCatalog::parse_str(
            r#"{
                "anthropic": {"models": {
                    "claude-opus-4-8": {
                        "id":"claude-opus-4-8",
                        "reasoning":true,
                        "reasoning_options":{"type":"budget_tokens","min":2048}
                    }
                }}
            }"#,
        )
        .expect("partial catalog should parse");
        let configured = ReasoningConfig {
            default_preset: Some("high".to_string()),
            presets: vec![ReasoningPreset {
                id: "high".to_string(),
                label: Some("Configured high".to_string()),
                actions: vec![ReasoningPresetAction::Effort {
                    value: "max".to_string(),
                }],
                ..Default::default()
            }],
            ..Default::default()
        };

        let projection = project_reasoning_catalog(
            "anthropic",
            "claude-opus-4-8",
            "https://api.anthropic.com/v1/messages",
            Some(&configured),
            Some(&partial),
        );

        assert_eq!(projection.default_preset.as_deref(), Some("high"));
        assert!(!projection.presets.iter().any(|preset| {
            preset.id.starts_with("budget-")
                || preset.source == ReasoningPresetSource::AdapterFallback
        }));
        let high = projection
            .presets
            .iter()
            .find(|preset| preset.id == "high")
            .expect("configured high");
        assert_eq!(high.label, "Configured high");
        assert_eq!(high.source, ReasoningPresetSource::ModelConfig);
    }

    #[test]
    fn explicit_non_reasoning_catalog_fact_blocks_adapter_fallback() {
        let non_reasoning = ModelsDevCatalog::parse_str(
            r#"{
                "openai": {"models": {
                    "gpt-5.4": {"id":"gpt-5.4","reasoning":false}
                }}
            }"#,
        )
        .expect("catalog should parse");
        let projection = project_reasoning_catalog(
            "responses",
            "gpt-5.4",
            "https://api.openai.com/v1/responses",
            None,
            Some(&non_reasoning),
        );

        assert_eq!(projection.status, ReasoningCapabilityStatus::Unsupported);
        assert!(projection.presets.is_empty());
    }

    #[test]
    fn unknown_official_model_gets_manual_generic_defaults() {
        let projection = project_reasoning_catalog(
            "responses",
            "gpt-9-unknown",
            "https://api.openai.com/v1/responses",
            None,
            None,
        );

        assert_eq!(projection.status, ReasoningCapabilityStatus::Known);
        assert_eq!(
            projection
                .presets
                .iter()
                .map(|preset| preset.id.as_str())
                .collect::<Vec<_>>(),
            ["off", "on", "low", "medium", "high"]
        );
        assert!(projection.presets.iter().all(|preset| {
            preset.source == ReasoningPresetSource::AdapterFallback
                && preset.execution_provider.as_deref() == Some(GENERIC_REASONING_PROVIDER_ID)
        }));
    }

    #[test]
    fn explicit_models_dev_binding_does_not_enable_adapter_fallback_on_a_gateway() {
        let configured = ReasoningConfig {
            catalog: ReasoningCatalogBinding::ModelsDev {
                provider: "anthropic".to_string(),
                model: "claude-opus-4-8".to_string(),
            },
            ..Default::default()
        };
        let projection = project_reasoning_catalog(
            "anthropic",
            "gateway-alias",
            "https://gateway.example.com/v1/messages",
            Some(&configured),
            None,
        );

        assert_eq!(projection.status, ReasoningCapabilityStatus::Unknown);
        assert!(projection.presets.is_empty());
    }

    #[test]
    fn auto_catalog_uses_only_generic_defaults_on_untrusted_endpoints() {
        for (provider, model, base_url) in [
            (
                "responses",
                "gpt-test",
                "https://gateway.example.com/v1/responses",
            ),
            (
                "anthropic",
                "claude-test",
                "https://gateway.example.com/anthropic",
            ),
            (
                "gemini",
                "gemini-test",
                "https://gateway.example.com/gemini",
            ),
            (
                "openai",
                "deepseek-v4-flash",
                "https://api.deepseek.com.evil.example/v1",
            ),
            (
                "responses",
                "gpt-test",
                "http://api.openai.com/v1/responses",
            ),
            (
                "responses",
                "gpt-test",
                "https://api.openai.com:8443/v1/responses",
            ),
            (
                "responses",
                "gpt-5.5",
                "https://chatgpt.com.evil.example/backend-api/codex",
            ),
            (
                "responses",
                "gpt-5.5",
                "https://chatgpt.com:8443/backend-api/codex",
            ),
            (
                "anthropic",
                "claude-opus-4-8",
                "https://gateway.example.com/v1/messages",
            ),
        ] {
            let projection =
                project_reasoning_catalog(provider, model, base_url, None, Some(&catalog()));
            assert_eq!(projection.status, ReasoningCapabilityStatus::Known);
            assert_eq!(
                projection
                    .presets
                    .iter()
                    .map(|preset| preset.id.as_str())
                    .collect::<Vec<_>>(),
                ["off", "on", "low", "medium", "high"],
                "auto catalog must use generic controls for {base_url}"
            );
            assert!(projection.presets.iter().all(|preset| {
                preset.source == ReasoningPresetSource::AdapterFallback
                    && preset.execution_provider.as_deref() == Some(GENERIC_REASONING_PROVIDER_ID)
            }));
        }
    }

    #[test]
    fn mismatched_official_endpoint_uses_generic_defaults_not_catalog_presets() {
        let projection = project_reasoning_catalog(
            "anthropic",
            "gpt-test",
            "https://api.openai.com/v1",
            None,
            Some(&catalog()),
        );

        assert_eq!(projection.status, ReasoningCapabilityStatus::Known);
        assert_eq!(
            projection
                .presets
                .iter()
                .map(|preset| preset.id.as_str())
                .collect::<Vec<_>>(),
            ["off", "on", "low", "medium", "high"]
        );
        assert!(projection.presets.iter().all(|preset| {
            preset.execution_provider.as_deref() == Some(GENERIC_REASONING_PROVIDER_ID)
        }));
    }

    #[test]
    fn explicit_models_dev_binding_allows_a_custom_endpoint() {
        let configured = ReasoningConfig {
            catalog: ReasoningCatalogBinding::ModelsDev {
                provider: "openai".to_string(),
                model: "gpt-test".to_string(),
            },
            ..Default::default()
        };
        let projection = project_reasoning_catalog(
            "responses",
            "gateway-model-alias",
            "https://gateway.example.com/v1/responses",
            Some(&configured),
            Some(&catalog()),
        );

        assert_eq!(projection.status, ReasoningCapabilityStatus::Known);
        assert_eq!(
            projection
                .presets
                .iter()
                .map(|preset| preset.id.as_str())
                .collect::<Vec<_>>(),
            ["low", "high"]
        );
        assert!(projection.presets.iter().all(|preset| {
            preset.execution_provider.as_deref() == Some("openai")
                && preset.execution_model.as_deref() == Some("gpt-test")
        }));
    }

    #[test]
    fn explicit_anthropic_binding_reports_efforts_unavailable_to_openai_chat() {
        let configured = ReasoningConfig {
            catalog: ReasoningCatalogBinding::ModelsDev {
                provider: "anthropic".to_string(),
                model: "claude-fable-5".to_string(),
            },
            ..Default::default()
        };
        let projection = project_reasoning_catalog(
            "openai",
            "dummy-model",
            "http://localhost:8000/v1/chat/completions",
            Some(&configured),
            Some(&catalog()),
        );

        assert_eq!(projection.status, ReasoningCapabilityStatus::Unknown);
        assert!(projection.presets.is_empty());
        assert_eq!(
            projection
                .unavailable_presets
                .iter()
                .map(|preset| preset.id.as_str())
                .collect::<Vec<_>>(),
            ["low", "medium", "high", "xhigh", "max"]
        );
    }

    #[test]
    fn custom_presets_keep_the_explicit_catalog_identity_for_adapter_compilation() {
        let configured = ReasoningConfig {
            catalog: ReasoningCatalogBinding::ModelsDev {
                provider: "anthropic".to_string(),
                model: "claude-sonnet-4-6".to_string(),
            },
            presets: vec![ReasoningPreset {
                id: "custom-high".to_string(),
                actions: vec![ReasoningPresetAction::Effort {
                    value: "high".to_string(),
                }],
                ..Default::default()
            }],
            ..Default::default()
        };
        let projection = project_reasoning_catalog(
            "anthropic",
            "local-model-alias",
            "https://gateway.example.com/v1/messages",
            Some(&configured),
            Some(&catalog()),
        );
        let preset = projection
            .presets
            .iter()
            .find(|preset| preset.id == "custom-high")
            .expect("custom preset");

        assert_eq!(preset.execution_provider.as_deref(), Some("anthropic"));
        assert_eq!(preset.execution_model.as_deref(), Some("claude-sonnet-4-6"));
    }

    #[test]
    fn official_google_endpoint_rejects_unverified_gemini_family_options() {
        let projection = project_reasoning_catalog(
            "gemini",
            "gemini-test",
            "https://generativelanguage.googleapis.com/v1beta",
            None,
            Some(&catalog()),
        );

        assert_eq!(projection.status, ReasoningCapabilityStatus::Unknown);
        assert!(projection.presets.is_empty());
    }

    #[test]
    fn generic_defaults_and_custom_presets_remain_available_together() {
        let configured = ReasoningConfig {
            catalog: ReasoningCatalogBinding::Auto,
            default_preset: Some("custom".to_string()),
            presets: vec![ReasoningPreset {
                id: "custom".to_string(),
                label: Some("Custom".to_string()),
                order: None,
                disabled: false,
                actions: vec![ReasoningPresetAction::RequestPatch {
                    body: serde_json::json!({"thinking": {"type": "enabled"}}),
                }],
            }],
        };
        let projection = project_reasoning_catalog(
            "openai",
            "gpt-test",
            "https://example.com/v1/chat/completions",
            Some(&configured),
            Some(&catalog()),
        );

        assert_eq!(projection.status, ReasoningCapabilityStatus::Known);
        assert_eq!(projection.default_preset.as_deref(), Some("custom"));
        assert_eq!(
            projection
                .presets
                .iter()
                .map(|preset| preset.id.as_str())
                .collect::<Vec<_>>(),
            ["off", "on", "low", "medium", "high", "custom"]
        );
    }

    #[test]
    fn unmaintained_glm_53_flash_on_a_custom_gateway_uses_generic_defaults() {
        let projection = project_reasoning_catalog(
            "openai",
            "GLM-5.3-Flash",
            "http://gateway.example.test/v1",
            None,
            Some(&catalog()),
        );

        assert_eq!(projection.status, ReasoningCapabilityStatus::Known);
        assert_eq!(
            projection
                .presets
                .iter()
                .map(|preset| preset.id.as_str())
                .collect::<Vec<_>>(),
            ["off", "on", "low", "medium", "high"]
        );
    }

    #[test]
    fn disabled_catalog_binding_hides_generated_options() {
        let configured = ReasoningConfig {
            catalog: ReasoningCatalogBinding::Disabled,
            ..Default::default()
        };
        let projection = project_reasoning_catalog(
            "responses",
            "gpt-test",
            "https://api.openai.com/v1/responses",
            Some(&configured),
            Some(&catalog()),
        );

        assert_eq!(projection.status, ReasoningCapabilityStatus::Unsupported);
        assert!(projection.presets.is_empty());
    }

    #[test]
    fn effort_display_metadata_preserves_ids_actions_and_generic_fallback() {
        let values = ["low", "medium", "high", "xhigh", "max"].map(|value| Some(value.to_string()));
        for (provider, model, expected) in [
            ("zhipuai", "glm-5.2", ["high", "high", "high", "max", "max"]),
            (
                "deepseek",
                "deepseek-v4-flash",
                ["low", "high", "high", "max", "max"],
            ),
        ] {
            let source = ModelsDevCatalog::parse_str(
                &serde_json::json!({
                    (provider): {"models": {(model): {"reasoning": true,
                        "reasoning_options": {"type": "effort", "values": values}}}}
                })
                .to_string(),
            )
            .unwrap();
            let config = ReasoningConfig {
                catalog: ReasoningCatalogBinding::ModelsDev {
                    provider: provider.into(),
                    model: model.into(),
                },
                ..Default::default()
            };
            let projection = project_reasoning_catalog(
                "openai",
                model,
                "https://gateway.example.com/v1/chat/completions",
                Some(&config),
                Some(&source),
            );
            assert_eq!(projection.status, ReasoningCapabilityStatus::Known);
            assert_eq!(projection.presets.len(), values.len());
            for ((descriptor, wire), effective) in
                projection.presets.iter().zip(&values).zip(expected)
            {
                assert_eq!(Some(descriptor.id.as_str()), wire.as_deref());
                assert_eq!(descriptor.effective_effort.as_deref(), Some(effective));
                assert_eq!(
                    descriptor.actions,
                    vec![ReasoningPresetAction::Effort {
                        value: wire.clone().unwrap(),
                    }]
                );
            }
            // The same source binding over Responses keeps that adapter's
            // original efforts; Chat/Anthropic aliases cannot cross protocols.
            for transport in ["responses", "openai"] {
                let responses = project_reasoning_catalog(
                    transport,
                    model,
                    "https://gateway.example.com/v1/responses",
                    Some(&config),
                    Some(&source),
                );
                assert_eq!(responses.presets.len(), values.len());
                assert!(responses
                    .presets
                    .iter()
                    .all(|preset| preset.effective_effort.is_none()));
            }
        }
        let generic = project_reasoning_catalog(
            "openai",
            "glm-5.2",
            "https://gateway.example.com/v1",
            None,
            None,
        );
        assert_eq!(generic.status, ReasoningCapabilityStatus::Known);
        assert_eq!(
            generic
                .presets
                .iter()
                .map(|preset| preset.id.as_str())
                .collect::<Vec<_>>(),
            ["off", "on", "low", "medium", "high"]
        );
        assert!(generic
            .presets
            .iter()
            .all(|preset| preset.effective_effort.is_none()));
    }

    #[test]
    fn model_config_can_hide_an_adapter_fallback_preset() {
        let configured = ReasoningConfig {
            presets: vec![ReasoningPreset {
                id: "medium".to_string(),
                disabled: true,
                ..Default::default()
            }],
            ..Default::default()
        };
        let projection = project_reasoning_catalog(
            "responses",
            "gpt-5.5",
            "https://chatgpt.com/backend-api/codex/responses",
            Some(&configured),
            None,
        );

        assert!(projection.presets.iter().any(|preset| preset.id == "low"));
        assert!(!projection
            .presets
            .iter()
            .any(|preset| preset.id == "medium"));
    }

    #[test]
    fn later_duplicate_without_setting_removes_the_earlier_descriptor() {
        let configured = ReasoningConfig {
            catalog: ReasoningCatalogBinding::Disabled,
            default_preset: Some("same".to_string()),
            presets: vec![
                ReasoningPreset {
                    id: "same".to_string(),
                    actions: vec![ReasoningPresetAction::Toggle { enabled: true }],
                    ..Default::default()
                },
                ReasoningPreset {
                    id: "same".to_string(),
                    actions: Vec::new(),
                    ..Default::default()
                },
            ],
        };

        let projection = project_reasoning_catalog(
            "responses",
            "gpt-test",
            "https://api.openai.com/v1/responses",
            Some(&configured),
            Some(&catalog()),
        );

        assert!(projection.presets.is_empty());
        assert!(projection.default_preset.is_none());
    }
}
