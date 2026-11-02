//! Narrow model-catalog and model-default projection owner used by both the
//! embedded CLI and the App Server. Keeping selector and display projection
//! policy here avoids entrypoints drifting into their own copies.

use crate::service::config::{AIConfig, AIModelConfig, AuthConfig, GlobalConfig};
#[cfg(feature = "remote-connect")]
use crate::AIModelCatalog;
use openbitfun_core_types::model::{ModelEditProjection, ModelListProjection, ModelSummary};

pub fn resolve_selector(ai: &AIConfig, selector: &Option<String>) -> Option<String> {
    selector
        .as_deref()
        .and_then(|selector| ai.resolve_model_selection(selector))
}

pub fn resolve_model_selector(ai: &AIConfig, selector: &str) -> Option<String> {
    match selector.trim() {
        "" | "default" => ai.resolve_model_selection("primary"),
        selector => ai.resolve_model_selection(selector),
    }
}

pub fn selector_is_unset(selector: &Option<String>) -> bool {
    selector
        .as_deref()
        .is_none_or(|selector| selector.trim().is_empty())
}

pub fn model_summary(model: &AIModelConfig) -> ModelSummary {
    let mut custom_header_names = model
        .custom_headers
        .as_ref()
        .map(|headers| headers.keys().cloned().collect::<Vec<_>>())
        .unwrap_or_default();
    custom_header_names.sort();
    ModelSummary {
        id: model.id.clone(),
        name: model.name.clone(),
        provider: model.provider.clone(),
        model_name: model.model_name.clone(),
        base_url: model.base_url.clone(),
        enabled: model.enabled,
        context_window: model.context_window,
        max_tokens: model.max_tokens,
        max_images_per_request: model.max_images_per_request,
        api_key_configured: !model.api_key.is_empty(),
        custom_header_names,
        custom_request_body_configured: model.custom_request_body.is_some(),
        auth_source: Some(match model.auth {
            AuthConfig::ApiKey => "api_key".to_string(),
            AuthConfig::Subscription { provider, .. } => {
                format!("subscription:{provider:?}").to_ascii_lowercase()
            }
            AuthConfig::SubscriptionPool { provider, .. } => {
                format!("subscription_pool:{provider:?}").to_ascii_lowercase()
            }
        }),
    }
}

pub fn model_list_projection(
    models: &[AIModelConfig],
    config: &GlobalConfig,
) -> ModelListProjection {
    ModelListProjection {
        models: models.iter().map(model_summary).collect(),
        primary_model_id: resolve_selector(&config.ai, &config.ai.default_models.primary),
        fast_model_id: resolve_selector(&config.ai, &config.ai.default_models.fast),
        mode_default_model_id: config
            .ai
            .mode_model_reference()
            .ok()
            .and_then(|reference| resolve_model_selector(&config.ai, &reference)),
    }
}

pub fn model_edit_projection(model: &AIModelConfig) -> ModelEditProjection {
    ModelEditProjection {
        summary: model_summary(model),
        reasoning_preset_options: model
            .reasoning
            .as_ref()
            .map(|reasoning| {
                reasoning
                    .presets
                    .iter()
                    .map(|preset| preset.id.clone())
                    .collect()
            })
            .unwrap_or_default(),
        reasoning: model.reasoning.clone(),
        inline_think_in_text: model.inline_think_in_text,
        skip_ssl_verify: model.skip_ssl_verify,
        custom_headers_mode: model
            .custom_headers_mode
            .clone()
            .unwrap_or_else(|| "merge".to_string()),
    }
}

#[cfg(feature = "remote-connect")]
pub fn model_catalog_projection(
    catalog: AIModelCatalog,
) -> openbitfun_core_types::model::TuiModelCatalogProjection {
    let reasoning_presets_by_model = catalog
        .models
        .into_iter()
        .filter_map(|model| {
            model.reasoning.map(|reasoning| {
                (
                    model.id,
                    reasoning
                        .presets
                        .into_iter()
                        .map(|preset| preset.id)
                        .collect(),
                )
            })
        })
        .collect();
    openbitfun_core_types::model::TuiModelCatalogProjection {
        provider_catalog: catalog.provider_catalog,
        reasoning_presets_by_model,
    }
}
