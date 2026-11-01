use std::collections::HashMap;

use anyhow::{anyhow, Result};
use openbitfun_core::service::config::AIConfig;
use openbitfun_core_types::model::{
    ModelListProjection, ModelMutation, ModelSummary, SecretUpdate,
};

pub(crate) use openbitfun_core::service::config::model_projection::{
    model_catalog_projection, model_edit_projection, model_list_projection, resolve_model_selector,
};

/// Resolve the shared future-mode selector to the concrete enabled model shown
/// by CLI model pickers and status surfaces.
pub(crate) fn resolve_mode_model_id(ai_config: &AIConfig) -> Option<String> {
    ai_config
        .mode_model_reference()
        .ok()
        .and_then(|reference| resolve_model_selector(ai_config, &reference))
}

/// Resolve the Runtime-owned Session selector to the concrete catalog model
/// used by CLI display surfaces. A missing selector is limited to the fresh
/// Session fallback; it does not become Session authority in the Client.
pub(crate) fn resolve_session_model_display_id(
    ai_config: &AIConfig,
    session_selector: Option<&str>,
) -> Option<String> {
    let fallback = ai_config.mode_model_reference().ok();
    let selector = session_selector
        .map(str::trim)
        .filter(|selector| !selector.is_empty())
        .or(fallback.as_deref())?;
    resolve_model_selector(ai_config, selector)
}

pub(crate) fn resolve_tui_model_id(
    catalog: &ModelListProjection,
    session_selector: Option<&str>,
) -> Option<String> {
    let selector = session_selector
        .map(str::trim)
        .filter(|selector| !selector.is_empty());
    match selector {
        None => catalog.mode_default_model_id.clone(),
        Some("default" | "primary") => catalog.primary_model_id.clone(),
        Some("fast") => catalog
            .fast_model_id
            .clone()
            .or_else(|| catalog.primary_model_id.clone()),
        Some(model_id) => catalog
            .models
            .iter()
            .find(|model| model.enabled && model.id == model_id)
            .map(|model| model.id.clone()),
    }
}

pub(crate) fn tui_model_display_name(model: &ModelSummary) -> String {
    let raw_name = model.name.trim();
    let model_name = model.model_name.trim();
    let provider = if !raw_name.is_empty() && !model_name.is_empty() {
        let dashed_suffix = format!(" - {model_name}");
        let slash_suffix = format!("/{model_name}");
        raw_name
            .strip_suffix(&dashed_suffix)
            .or_else(|| raw_name.strip_suffix(&slash_suffix))
            .map(str::trim)
            .filter(|value| !value.is_empty())
            .unwrap_or(raw_name)
    } else if raw_name.is_empty() {
        &model.provider
    } else {
        raw_name
    };
    format!("{} / {}", model.model_name, provider)
}

pub(crate) fn model_from_mutation(
    mutation: ModelMutation,
    existing: Option<openbitfun_core::service::config::AIModelConfig>,
) -> Result<openbitfun_core::service::config::AIModelConfig> {
    let current = existing.unwrap_or_default();
    let api_key = secret_update_value(mutation.api_key, Some(current.api_key));
    let custom_headers = headers_update(mutation.custom_headers, current.custom_headers)?;
    let custom_request_body =
        string_update(mutation.custom_request_body, current.custom_request_body);
    Ok(openbitfun_core::service::config::AIModelConfig {
        id: mutation.id,
        name: mutation.name,
        provider: mutation.provider,
        model_name: mutation.model_name,
        base_url: mutation.base_url,
        request_url: current.request_url,
        api_key,
        context_window: mutation.context_window,
        max_tokens: mutation.max_tokens,
        max_images_per_request: mutation
            .max_images_per_request
            .unwrap_or(current.max_images_per_request),
        temperature: current.temperature,
        top_p: current.top_p,
        enabled: mutation.enabled,
        category: current.category,
        capabilities: current.capabilities,
        recommended_for: current.recommended_for,
        metadata: current.metadata,
        reasoning: mutation.reasoning,
        inline_think_in_text: mutation.inline_think_in_text,
        custom_headers,
        custom_headers_mode: mutation.custom_headers_mode.or(current.custom_headers_mode),
        skip_ssl_verify: mutation.skip_ssl_verify,
        custom_request_body,
        custom_request_body_mode: current.custom_request_body_mode,
        auth: current.auth,
        channel_routing: current.channel_routing,
    })
}

fn secret_update_value(update: Option<SecretUpdate>, existing: Option<String>) -> String {
    match update.unwrap_or(SecretUpdate::Preserve) {
        SecretUpdate::Preserve => existing.unwrap_or_default(),
        SecretUpdate::Replace(value) => value,
        SecretUpdate::Clear => String::new(),
    }
}

fn headers_update(
    update: Option<SecretUpdate>,
    existing: Option<HashMap<String, String>>,
) -> Result<Option<HashMap<String, String>>> {
    match update.unwrap_or(SecretUpdate::Preserve) {
        SecretUpdate::Preserve => Ok(existing),
        SecretUpdate::Clear => Ok(None),
        SecretUpdate::Replace(value) => serde_json::from_str(&value)
            .map(Some)
            .map_err(|_| anyhow!("Custom headers must be valid JSON")),
    }
}

fn string_update(update: Option<SecretUpdate>, existing: Option<String>) -> Option<String> {
    match update.unwrap_or(SecretUpdate::Preserve) {
        SecretUpdate::Preserve => existing,
        SecretUpdate::Clear => None,
        SecretUpdate::Replace(value) => (!value.is_empty()).then_some(value),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn config_with_selector(selector: &str) -> AIConfig {
        serde_json::from_value(serde_json::json!({
            "models": [
                {
                    "id": "primary-model",
                    "name": "Primary",
                    "provider": "openai",
                    "model_name": "primary-model",
                    "enabled": true
                },
                {
                    "id": "fast-model",
                    "name": "Fast",
                    "provider": "openai",
                    "model_name": "fast-model",
                    "enabled": true
                },
                {
                    "id": "explicit-model",
                    "name": "Explicit",
                    "provider": "openai",
                    "model_name": "explicit-model",
                    "enabled": true
                }
            ],
            "default_models": {
                "primary": "primary-model",
                "fast": "fast-model"
            },
            "agent_model_selections": {
                "mode": {"kind": "model", "model_ref": selector},
                "subagents": {
                    "default": {"kind": "model", "model_ref": "fast"},
                    "builtin": {},
                    "fork": {"kind": "inherit"}
                }
            }
        }))
        .expect("test AI config should deserialize")
    }

    #[test]
    fn legacy_model_mutation_preserves_channel_selection_and_credentials() {
        let mutation: ModelMutation = serde_json::from_value(serde_json::json!({
            "id":"model-1", "name":"Edited", "provider":"openai", "modelName":"model",
            "baseUrl":"https://fixture.invalid/v1", "enabled":true,
            "inlineThinkInText":false, "skipSslVerify":false
        }))
        .unwrap();
        let existing = openbitfun_core::service::config::AIModelConfig {
            api_key: "synthetic-existing".into(),
            max_images_per_request: Some(3),
            channel_routing: Some(serde_json::from_value(serde_json::json!({"version":1,"fallback_model_ids":["backup"],"manual_channel":"backup"})).unwrap()),
            ..Default::default()
        };
        let preserved = model_from_mutation(mutation.clone(), Some(existing.clone())).unwrap();
        assert_eq!(preserved.channel_routing, existing.channel_routing);
        assert_eq!(preserved.api_key, existing.api_key);
        assert_eq!(preserved.max_images_per_request, Some(3));
        assert_eq!(preserved.name, "Edited");

        let mut limited = mutation;
        limited.max_images_per_request = Some(Some(5));
        let updated = model_from_mutation(limited, Some(existing)).unwrap();
        assert_eq!(updated.max_images_per_request, Some(5));
    }

    #[test]
    fn resolves_symbolic_and_explicit_mode_defaults_for_cli_display() {
        assert_eq!(
            resolve_mode_model_id(&config_with_selector("primary")).as_deref(),
            Some("primary-model")
        );
        assert_eq!(
            resolve_mode_model_id(&config_with_selector("fast")).as_deref(),
            Some("fast-model")
        );
        assert_eq!(
            resolve_mode_model_id(&config_with_selector("explicit-model")).as_deref(),
            Some("explicit-model")
        );
    }

    #[test]
    fn resolves_runtime_session_selectors_to_the_effective_catalog_model() {
        let config = config_with_selector("fast");

        assert_eq!(
            resolve_session_model_display_id(&config, Some("primary")).as_deref(),
            Some("primary-model")
        );
        assert_eq!(
            resolve_session_model_display_id(&config, Some("fast")).as_deref(),
            Some("fast-model")
        );
        assert_eq!(
            resolve_session_model_display_id(&config, Some("explicit-model")).as_deref(),
            Some("explicit-model")
        );
    }

    #[test]
    fn missing_runtime_session_selector_uses_the_future_session_default_for_display_only() {
        let config = config_with_selector("fast");

        assert_eq!(
            resolve_session_model_display_id(&config, None).as_deref(),
            Some("fast-model")
        );
    }
}
