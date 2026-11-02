//! Economy-model request policy for Router summaries, independent of chat reasoning.

use super::{
    configured_summary_model, summary_request_client, summary_system_prompt, RouterContextConfig,
};
use crate::infrastructure::ai::get_global_ai_client_factory;
use crate::infrastructure::ai::reasoning_catalog::{
    load_models_dev_reasoning_catalog_without_refresh, project_model_reasoning_catalog,
};
use crate::service::config::get_global_config_service;
use crate::util::errors::{OpenBitFunError, OpenBitFunResult};
use crate::util::types::Message as AIMessage;
use openbitfun_agent_runtime::router_context::{EstimatedRouterTokens, RouterTokenCounter};
use openbitfun_ai_adapters::models_dev::is_protocol_generic_reasoning_preset;
use openbitfun_ai_adapters::{AIClient, GeminiResponse};
use openbitfun_core_types::{
    ReasoningCatalogProjection, ReasoningPresetAction, ReasoningPresetDescriptor,
    ReasoningPresetSource,
};

/// Resolve on the execution host. This never borrows the primary model or changes
/// the factory's cached client, model defaults, or the main conversation's preset.
pub(super) async fn configured_client(
    summary_config: &RouterContextConfig,
) -> OpenBitFunResult<(String, AIClient)> {
    let config = get_global_config_service()
        .await?
        .get_effective_ai_config()
        .await?;
    let model_id = match summary_config.summary_model_id.as_deref() {
        Some(id) => config.resolve_model_reference(id).ok_or_else(|| {
            OpenBitFunError::Configuration("Router summary economy model is unavailable".into())
        })?,
        None => configured_summary_model(&config)?,
    };
    let model = config
        .models
        .iter()
        .find(|model| model.id == model_id)
        .ok_or_else(|| {
            OpenBitFunError::Configuration(
                "Router summary model configuration is unavailable".into(),
            )
        })?;
    let catalog = load_models_dev_reasoning_catalog_without_refresh().await;
    let projection = project_model_reasoning_catalog(model, catalog.catalog.as_deref());
    let shared = get_global_ai_client_factory()
        .await?
        .get_client_resolved(&model_id)
        .await
        .map_err(|error| OpenBitFunError::AIClient(error.to_string()))?;
    let client = request_client(shared.as_ref(), &projection, summary_config)?;
    Ok((model_id, client))
}

/// Input planning and send-time validation use the same resolved model limits.
/// Re-resolving the client can observe a changed model window while work waits
/// in the host queue; never send the old, larger snapshot in that case.
pub(super) fn input_budget(
    client: &AIClient,
    config: &RouterContextConfig,
) -> OpenBitFunResult<usize> {
    let window = client.config.context_window as usize;
    let output = client
        .config
        .max_tokens
        .map(|tokens| tokens as usize)
        .unwrap_or(config.summary_max_tokens);
    let budget = window
        .saturating_sub(window / 10)
        .saturating_sub(output)
        .saturating_sub(EstimatedRouterTokens.count(&summary_system_prompt(config)))
        .saturating_sub(256);
    if budget < 512 {
        return Err(OpenBitFunError::Configuration(
            "Summary model context window leaves insufficient room for routing history".into(),
        ));
    }
    Ok(budget)
}

pub(super) fn validate_input(
    client: &AIClient,
    config: &RouterContextConfig,
    prompt: &str,
) -> OpenBitFunResult<()> {
    let budget = input_budget(client, config)?;
    let input_tokens = EstimatedRouterTokens.count(prompt);
    if input_tokens > budget {
        return Err(OpenBitFunError::Configuration(format!(
            "Router summary input exceeds the current summary model budget: input_tokens={input_tokens}, budget_tokens={budget}"
        )));
    }
    Ok(())
}

/// Dispatch one auxiliary attempt. The queue owner retains timeout, cancellation
/// and next-round recovery; adapter retries must not repeat a rejected snapshot.
pub(super) async fn send_request(
    client: &AIClient,
    config: &RouterContextConfig,
    prompt: String,
) -> OpenBitFunResult<GeminiResponse> {
    validate_input(client, config, &prompt)?;
    client
        .send_message_once_with_trace_and_request_context(
            vec![
                AIMessage::system(summary_system_prompt(config)),
                AIMessage::user(prompt),
            ],
            None,
            None,
            None,
        )
        .await
        .map_err(|error| OpenBitFunError::AIClient(error.to_string()))
}

fn lowest_summary_reasoning_preset(
    presets: &[ReasoningPresetDescriptor],
) -> Option<&ReasoningPresetDescriptor> {
    presets.iter().min_by_key(|preset| {
        let rank = preset
            .actions
            .iter()
            .filter_map(|action| match action {
                ReasoningPresetAction::Toggle { enabled: false } => Some((0, 0)),
                ReasoningPresetAction::Effort { value } => {
                    match preset.effective_effort.as_deref().unwrap_or(value) {
                        "none" => Some((0, 0)),
                        "minimal" => Some((1, 0)),
                        "low" => Some((1, 1)),
                        "medium" => Some((1, 2)),
                        "high" => Some((1, 3)),
                        "xhigh" => Some((1, 4)),
                        "max" => Some((1, 5)),
                        "ultra" => Some((1, 6)),
                        _ => None,
                    }
                }
                ReasoningPresetAction::BudgetTokens { value } => Some((2, *value)),
                _ => None,
            })
            .min()
            .unwrap_or((3, 0));
        (rank, preset.order)
    })
}

fn automatic_preset(projection: &ReasoningCatalogProjection) -> Option<ReasoningPresetDescriptor> {
    // Manual protocol controls are offered for an explicit selection, not proof
    // that an unknown service accepts them. Only catalog/model declarations or
    // a model-specific adapter fallback may supply an automatic effort.
    let efforts = projection
        .presets
        .iter()
        .filter(|preset| {
            !is_protocol_generic_reasoning_preset(preset)
                && (preset.source != ReasoningPresetSource::AdapterFallback
                    || preset.execution_provider.is_some())
        })
        .filter(|preset| {
            preset
                .actions
                .iter()
                .any(|action| matches!(action, ReasoningPresetAction::Effort { .. }))
        })
        .cloned()
        .collect::<Vec<_>>();
    if let Some(preset) = lowest_summary_reasoning_preset(&efforts) {
        return Some(preset.clone());
    }
    let declared = projection
        .presets
        .iter()
        .filter(|preset| preset.source != ReasoningPresetSource::AdapterFallback)
        .cloned()
        .collect::<Vec<_>>();
    lowest_summary_reasoning_preset(&declared).cloned()
}

fn request_client(
    shared: &AIClient,
    projection: &ReasoningCatalogProjection,
    config: &RouterContextConfig,
) -> OpenBitFunResult<AIClient> {
    let preset = match config.summary_reasoning_preset.as_deref() {
        Some(requested) => Some(
            projection
                .presets
                .iter()
                .find(|preset| preset.id == requested)
                .cloned()
                .ok_or_else(|| {
                    OpenBitFunError::Configuration(format!(
                        "Router summary reasoning preset '{requested}' is unavailable for the summary model"
                    ))
                })?,
        ),
        None => {
            if shared.selected_reasoning_preset().is_some() {
                return Err(OpenBitFunError::Configuration(
                    "Router summary cannot inherit a session reasoning preset".into(),
                ));
            }
            automatic_preset(projection)
        }
    };
    let client = match preset {
        Some(preset) if config.summary_reasoning_preset.is_some() => {
            shared.with_reasoning_preset(&preset)
        }
        // Automatic policy stays below the user's custom request body, matching
        // model-default precedence. An explicit summary preset still wins above.
        Some(preset) => shared.with_model_reasoning_preset(&preset),
        // Unknown Auto retains explicit model defaults and raw custom fields;
        // it must neither invent low/off nor silently erase the user's policy.
        None => shared.clone(),
    };
    // This applies the summary output limit before validating the resolved
    // preset, so budget-based reasoning is checked against the actual request.
    let client = summary_request_client(&client, config)?;
    if config.summary_reasoning_preset.is_none() {
        if let Some(preset) = client.model_reasoning_preset() {
            client
                .validate_reasoning_preset(preset)
                .map_err(|error| OpenBitFunError::Configuration(error.to_string()))?;
        }
    }
    Ok(client)
}

#[cfg(test)]
mod tests;
