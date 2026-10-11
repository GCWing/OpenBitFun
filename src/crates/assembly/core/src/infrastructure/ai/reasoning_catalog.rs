use std::sync::Arc;
#[cfg(feature = "model-catalog")]
use std::sync::{Mutex, OnceLock, RwLock};
#[cfg(feature = "model-catalog")]
use std::time::{Duration, Instant};

#[cfg(feature = "model-catalog")]
use log::debug;
use openbitfun_ai_adapters::models_dev::{
    project_reasoning_catalog_with_limit_and_auto_binding, ModelsDevCatalog,
};
#[cfg(feature = "model-catalog")]
use openbitfun_core_types::ReasoningCatalogProjectionRequest;
#[cfg(feature = "model-catalog")]
use openbitfun_core_types::{
    ModelsDevCatalogSource, ModelsDevCatalogStatus, ModelsDevRefreshResult, ModelsDevRefreshStatus,
};
use openbitfun_core_types::{
    ReasoningCatalogBinding, ReasoningCatalogProjection, ReasoningPresetDescriptor,
};
#[cfg(feature = "model-catalog")]
use openbitfun_events::{AIModelCatalogUpdatedEvent, AI_MODEL_CATALOG_UPDATED_EVENT};
#[cfg(feature = "model-catalog")]
use openbitfun_services_integrations::models_dev::{
    ModelsDevCatalogService, ModelsDevRefreshOutcome, ModelsDevSnapshot, ModelsDevSnapshotSource,
};
use sha2::{Digest, Sha256};

use crate::infrastructure::ai::provider_catalog::trusted_models_dev_binding;
use crate::infrastructure::ai::AIClient;
use crate::service::config::types::AIModelConfig;

#[derive(Clone)]
pub(crate) struct ModelsDevReasoningCatalogSnapshot {
    pub(crate) catalog: Option<Arc<ModelsDevCatalog>>,
    #[cfg(feature = "model-catalog")]
    pub(crate) version: u64,
    #[cfg(feature = "model-catalog")]
    pub(crate) sha256: String,
    #[cfg(feature = "model-catalog")]
    pub(crate) source: ModelsDevSnapshotSource,
}

// This is a background check interval, not a snapshot expiration time.
#[cfg(feature = "model-catalog")]
const CATALOG_CHECK_INTERVAL: Duration = Duration::from_secs(60);

#[cfg(feature = "model-catalog")]
struct CachedReasoningCatalogSnapshot {
    snapshot: ModelsDevReasoningCatalogSnapshot,
}

#[cfg(feature = "model-catalog")]
#[derive(Default)]
struct ParsedCatalogCache {
    snapshot: RwLock<Option<CachedReasoningCatalogSnapshot>>,
    // Covers reading, parsing and publication, including manual refreshes.
    update: tokio::sync::Mutex<()>,
    last_check: Mutex<Option<Instant>>,
}

#[cfg(feature = "model-catalog")]
impl ParsedCatalogCache {
    fn current(&self) -> Option<ModelsDevReasoningCatalogSnapshot> {
        self.snapshot
            .read()
            .unwrap_or_else(|error| error.into_inner())
            .as_ref()
            .map(|cached| cached.snapshot.clone())
    }

    async fn load(&self, service: &ModelsDevCatalogService) -> ModelsDevReasoningCatalogSnapshot {
        if let Some(snapshot) = self.current() {
            return snapshot;
        }
        let _update = self.update.lock().await;
        if let Some(snapshot) = self.current() {
            return snapshot;
        }
        let source = service.load_cached_or_bundled().await;
        self.publish(source).await;
        self.current().expect("initial catalog snapshot")
    }

    // Caller holds update so a cold read cannot publish over a newer refresh.
    async fn publish(&self, source: ModelsDevSnapshot) -> bool {
        let current = self.current();
        if let Some(current) = current
            .as_ref()
            .filter(|current| current.sha256 == source.sha256)
        {
            if current.source == source.source {
                return false;
            }
            let mut updated = current.clone();
            updated.source = source.source;
            return replace_cached_catalog(
                &mut self
                    .snapshot
                    .write()
                    .unwrap_or_else(|error| error.into_inner()),
                updated,
            );
        }
        let version = source.version;
        let sha256 = source.sha256.clone();
        let source_kind = source.source;
        let parsed = tokio::task::spawn_blocking(move || parse_models_dev_snapshot(&source))
            .await
            .ok()
            .flatten();
        let updated = match parsed {
            Some(updated) => updated,
            None if current.is_some() => return false,
            None => ModelsDevReasoningCatalogSnapshot {
                catalog: None,
                version,
                sha256,
                source: source_kind,
            },
        };
        replace_cached_catalog(
            &mut self
                .snapshot
                .write()
                .unwrap_or_else(|error| error.into_inner()),
            updated,
        )
    }

    fn claim_background_check(&self) -> bool {
        let mut last = self
            .last_check
            .lock()
            .unwrap_or_else(|error| error.into_inner());
        if last.is_some_and(|last| last.elapsed() < CATALOG_CHECK_INTERVAL) {
            return false;
        }
        *last = Some(Instant::now());
        true
    }
}

#[cfg(feature = "model-catalog")]
fn parsed_catalog_cache() -> &'static ParsedCatalogCache {
    static CACHE: OnceLock<ParsedCatalogCache> = OnceLock::new();
    CACHE.get_or_init(ParsedCatalogCache::default)
}

#[cfg(feature = "model-catalog")]
fn models_dev_catalog_service() -> &'static ModelsDevCatalogService {
    static SERVICE: OnceLock<ModelsDevCatalogService> = OnceLock::new();
    SERVICE.get_or_init(|| {
        let cache_file = crate::infrastructure::get_path_manager_arc()
            .cache_root()
            .join("models-dev")
            .join("catalog.json");
        ModelsDevCatalogService::new(cache_file)
    })
}

#[cfg(feature = "model-catalog")]
fn models_dev_catalog_source(source: ModelsDevSnapshotSource) -> ModelsDevCatalogSource {
    match source {
        ModelsDevSnapshotSource::Cache => ModelsDevCatalogSource::Cache,
        ModelsDevSnapshotSource::Bundled => ModelsDevCatalogSource::Bundle,
        ModelsDevSnapshotSource::Empty => ModelsDevCatalogSource::Empty,
    }
}

#[cfg(feature = "model-catalog")]
async fn models_dev_catalog_status() -> ModelsDevCatalogStatus {
    let service = models_dev_catalog_service();
    let snapshot = load_models_dev_reasoning_catalog_without_refresh().await;
    let metadata = service.cache_metadata().await;
    let projection = snapshot.catalog.as_deref().map(|catalog| {
        catalog.reasoning_binding_catalog(
            snapshot.sha256.clone(),
            models_dev_catalog_source(snapshot.source),
        )
    });
    ModelsDevCatalogStatus {
        active_source: models_dev_catalog_source(snapshot.source),
        revision: snapshot.sha256,
        cache_path: metadata.path.to_string_lossy().into_owned(),
        cache_exists: metadata.exists,
        cache_updated_at_ms: metadata.updated_at_ms,
        provider_count: projection.as_ref().map_or(0, |value| value.providers.len()),
        reasoning_model_count: projection.as_ref().map_or(0, |value| {
            value
                .providers
                .iter()
                .map(|provider| provider.models.len())
                .sum()
        }),
        refresh_in_progress: service.refresh_in_progress(),
    }
}

#[cfg(feature = "model-catalog")]
pub(crate) async fn get_models_dev_catalog_status() -> ModelsDevCatalogStatus {
    models_dev_catalog_status().await
}

#[cfg(feature = "model-catalog")]
pub(crate) async fn refresh_models_dev_catalog_now() -> Result<ModelsDevRefreshResult, String> {
    let cache = parsed_catalog_cache();
    let service = models_dev_catalog_service();
    // Ensure status reads never have to wait on an in-progress network refresh.
    cache.load(service).await;
    let outcome = if let Ok(_update) = cache.update.try_lock() {
        let outcome = service.refresh_now().await;
        match &outcome {
            ModelsDevRefreshOutcome::Failed => {
                return Err("Failed to refresh models.dev catalog".to_string())
            }
            ModelsDevRefreshOutcome::Throttled => {}
            _ => publish_current_catalog(cache, service).await,
        }
        outcome
    } else {
        ModelsDevRefreshOutcome::Throttled
    };
    Ok(ModelsDevRefreshResult {
        outcome: match outcome {
            ModelsDevRefreshOutcome::Updated(_) => ModelsDevRefreshStatus::Updated,
            ModelsDevRefreshOutcome::Throttled => ModelsDevRefreshStatus::Throttled,
            _ => ModelsDevRefreshStatus::Unchanged,
        },
        status: models_dev_catalog_status().await,
    })
}

#[cfg(feature = "model-catalog")]
async fn publish_current_catalog(cache: &ParsedCatalogCache, service: &ModelsDevCatalogService) {
    let source = service.load_cached_or_bundled().await;
    let event = AIModelCatalogUpdatedEvent {
        source_version: source.version.to_string(),
        sha256: source.sha256.clone(),
    };
    if cache.publish(source).await {
        emit_models_dev_catalog_updated(event).await;
    }
}

#[cfg(feature = "model-catalog")]
pub(crate) async fn load_models_dev_reasoning_catalog_without_refresh(
) -> ModelsDevReasoningCatalogSnapshot {
    parsed_catalog_cache()
        .load(models_dev_catalog_service())
        .await
}

#[cfg(feature = "model-catalog")]
pub(crate) async fn load_models_dev_reasoning_catalog() -> ModelsDevReasoningCatalogSnapshot {
    let loaded = load_models_dev_reasoning_catalog_without_refresh().await;
    schedule_catalog_refresh();
    loaded
}

#[cfg(feature = "model-catalog")]
fn schedule_catalog_refresh() {
    let cache = parsed_catalog_cache();
    if !cache.claim_background_check() {
        return;
    }
    tokio::spawn(async move {
        let Ok(_update) = cache.update.try_lock() else {
            return;
        };
        let service = models_dev_catalog_service();
        // Observe changes written by another host process, then check the source.
        publish_current_catalog(cache, service).await;
        if !matches!(
            service.refresh_if_stale().await,
            ModelsDevRefreshOutcome::Failed | ModelsDevRefreshOutcome::Throttled
        ) {
            publish_current_catalog(cache, service).await;
        }
    });
}

/// Prepare local capabilities once the host configuration is available. Network
/// freshness is optional; readers always retain the last valid local snapshot.
#[cfg(feature = "model-catalog")]
pub(crate) fn prepare_model_catalog() {
    tokio::spawn(async {
        load_models_dev_reasoning_catalog().await;
    });
}

#[cfg(feature = "model-catalog")]
fn parse_models_dev_snapshot(
    snapshot: &ModelsDevSnapshot,
) -> Option<ModelsDevReasoningCatalogSnapshot> {
    let catalog = match ModelsDevCatalog::parse_str(&snapshot.body) {
        Ok(catalog) => Some(Arc::new(catalog)),
        Err(error) => {
            debug!(
                "Failed to parse refreshed models.dev catalog snapshot: {}",
                error
            );
            return None;
        }
    };
    Some(ModelsDevReasoningCatalogSnapshot {
        catalog,
        version: snapshot.version,
        sha256: snapshot.sha256.clone(),
        source: snapshot.source,
    })
}

#[cfg(feature = "model-catalog")]
fn replace_cached_catalog(
    cache: &mut Option<CachedReasoningCatalogSnapshot>,
    updated: ModelsDevReasoningCatalogSnapshot,
) -> bool {
    if cache.as_ref().is_some_and(|cached| {
        cached.snapshot.sha256 == updated.sha256 && cached.snapshot.source == updated.source
    }) {
        return false;
    }
    *cache = Some(CachedReasoningCatalogSnapshot { snapshot: updated });
    true
}

#[cfg(feature = "model-catalog")]
async fn emit_models_dev_catalog_updated(event: AIModelCatalogUpdatedEvent) {
    crate::service::config::GlobalConfigManager::broadcast_update(
        crate::service::config::ConfigUpdateEvent::ReasoningCatalogUpdated,
    )
    .await;
    let payload = match serde_json::to_value(event) {
        Ok(payload) => payload,
        Err(error) => {
            debug!(
                "Failed to serialize models.dev catalog update event: {}",
                error
            );
            return;
        }
    };
    let _ = crate::infrastructure::events::get_global_event_system()
        .emit(crate::infrastructure::events::BackendEvent::Custom {
            event_name: AI_MODEL_CATALOG_UPDATED_EVENT.to_string(),
            payload,
        })
        .await;
}

#[cfg(not(feature = "model-catalog"))]
pub(crate) async fn load_models_dev_reasoning_catalog() -> ModelsDevReasoningCatalogSnapshot {
    ModelsDevReasoningCatalogSnapshot { catalog: None }
}

#[cfg(not(feature = "model-catalog"))]
pub(crate) async fn load_models_dev_reasoning_catalog_without_refresh(
) -> ModelsDevReasoningCatalogSnapshot {
    ModelsDevReasoningCatalogSnapshot { catalog: None }
}

pub(crate) fn project_model_reasoning_catalog(
    model: &AIModelConfig,
    models_dev: Option<&ModelsDevCatalog>,
) -> ReasoningCatalogProjection {
    let trusted_binding = models_dev.and_then(|catalog| {
        trusted_models_dev_binding(&model.provider, &model.base_url, &model.model_name, catalog)
    });
    project_reasoning_catalog_with_limit_and_auto_binding(
        &model.provider,
        &model.model_name,
        &model.base_url,
        model.max_tokens.unwrap_or_else(|| {
            crate::service::config::types::automatic_max_output_tokens(
                model
                    .context_window
                    .unwrap_or(crate::service::config::types::DEFAULT_MODEL_CONTEXT_WINDOW_TOKENS),
            )
        }),
        model.reasoning.as_ref(),
        models_dev,
        trusted_binding
            .as_ref()
            .map(|(provider, model)| (provider.as_str(), model.as_str())),
    )
}

#[cfg(feature = "model-catalog")]
pub(crate) async fn project_reasoning_catalog_request(
    request: ReasoningCatalogProjectionRequest,
) -> ReasoningCatalogProjection {
    let models_dev = load_models_dev_reasoning_catalog().await;
    project_model_reasoning_catalog(
        &AIModelConfig {
            provider: request.provider,
            model_name: request.model_name,
            base_url: request.base_url,
            context_window: request.context_window,
            max_tokens: request.max_tokens,
            reasoning: Some(request.reasoning),
            ..Default::default()
        },
        models_dev.catalog.as_deref(),
    )
}

pub(crate) fn resolve_reasoning_preset<'a>(
    projection: &'a ReasoningCatalogProjection,
    preset_id: &str,
) -> Option<&'a ReasoningPresetDescriptor> {
    let preset_id = preset_id.trim();
    projection
        .presets
        .iter()
        .find(|preset| preset.id == preset_id)
}

pub(crate) fn reasoning_preset_runtime_fingerprint(
    preset: Option<&ReasoningPresetDescriptor>,
) -> String {
    let value = preset.map_or(serde_json::Value::Null, |preset| {
        serde_json::json!({
            "id": preset.id,
            "actions": preset.actions,
            "source": preset.source,
            "execution_provider": preset.execution_provider,
            "execution_model": preset.execution_model,
        })
    });
    let encoded = serde_json::to_vec(&value).unwrap_or_default();
    format!("{:x}", Sha256::digest(encoded))
}

/// Normalizes a session-scoped reasoning preset against one concrete model.
///
/// `None` is the canonical Auto state. A configured preset can always be
/// validated from the model config alone. Catalog-derived presets are only
/// cleared when a models.dev snapshot is available; a transient catalog load
/// failure must not erase the user's selection.
pub(crate) fn normalize_reasoning_preset_for_model(
    model: &AIModelConfig,
    models_dev: Option<&ModelsDevCatalog>,
    preset_id: Option<&str>,
) -> Option<String> {
    let preset_id = preset_id
        .map(str::trim)
        .filter(|preset_id| !preset_id.is_empty() && !preset_id.eq_ignore_ascii_case("auto"))?;

    let configured = model.reasoning.as_ref();
    if configured.is_some_and(|reasoning| reasoning.preset(preset_id).is_some()) {
        return Some(preset_id.to_string());
    }
    if configured.is_some_and(|reasoning| {
        reasoning
            .presets
            .iter()
            .any(|preset| preset.id.trim() == preset_id)
    }) {
        // An explicit disabled/tombstone preset is authoritative even when the
        // external catalog is temporarily unavailable.
        return None;
    }

    let catalog_is_authoritative = match configured.map(|reasoning| &reasoning.catalog) {
        Some(ReasoningCatalogBinding::Disabled) => true,
        Some(ReasoningCatalogBinding::Auto | ReasoningCatalogBinding::ModelsDev { .. }) | None => {
            models_dev.is_some()
        }
    };
    if !catalog_is_authoritative {
        return Some(preset_id.to_string());
    }

    resolve_reasoning_preset(
        &project_model_reasoning_catalog(model, models_dev),
        preset_id,
    )
    .map(|preset| preset.id.clone())
}

pub(crate) fn resolve_default_reasoning_preset(
    projection: &ReasoningCatalogProjection,
) -> Option<&ReasoningPresetDescriptor> {
    projection
        .default_preset
        .as_deref()
        .and_then(|preset_id| resolve_reasoning_preset(projection, preset_id))
}

pub(crate) fn apply_default_reasoning_preset(
    client: AIClient,
    projection: &ReasoningCatalogProjection,
) -> AIClient {
    match resolve_default_reasoning_preset(projection) {
        Some(preset) => client.with_model_reasoning_preset(preset),
        None => client,
    }
}

pub(crate) fn apply_selected_reasoning_preset(
    client: &AIClient,
    projection: &ReasoningCatalogProjection,
    preset_id: &str,
) -> Option<AIClient> {
    resolve_reasoning_preset(projection, preset_id)
        .map(|preset| client.with_reasoning_preset(preset))
}

#[cfg(test)]
mod tests {
    use openbitfun_core_types::{
        ReasoningCatalogBinding, ReasoningCatalogProjectionRequest, ReasoningConfig,
        ReasoningPreset, ReasoningPresetAction, ReasoningPresetDescriptor, ReasoningPresetSource,
    };

    use super::{
        apply_default_reasoning_preset, apply_selected_reasoning_preset,
        normalize_reasoning_preset_for_model, project_model_reasoning_catalog,
        reasoning_preset_runtime_fingerprint, resolve_default_reasoning_preset,
        resolve_reasoning_preset, ModelsDevCatalog,
    };
    use crate::infrastructure::ai::AIClient;
    use crate::service::config::types::AIModelConfig;
    use crate::util::types::AIConfig;

    #[test]
    fn runtime_fingerprint_detects_same_id_action_drift() {
        let preset = ReasoningPresetDescriptor {
            id: "high".to_string(),
            label: "High".to_string(),
            order: 1,
            actions: vec![ReasoningPresetAction::Effort {
                value: "high".to_string(),
            }],
            source: ReasoningPresetSource::ModelsDev,
            effective_effort: None,
            execution_provider: Some("openai".to_string()),
            execution_model: Some("model-v1".to_string()),
        };
        let mut changed = preset.clone();
        changed.actions = vec![ReasoningPresetAction::BudgetTokens { value: 32_000 }];

        assert_ne!(
            reasoning_preset_runtime_fingerprint(Some(&preset)),
            reasoning_preset_runtime_fingerprint(Some(&changed)),
        );
        assert_ne!(
            reasoning_preset_runtime_fingerprint(None),
            reasoning_preset_runtime_fingerprint(Some(&preset)),
        );
    }

    fn catalog() -> ModelsDevCatalog {
        ModelsDevCatalog::parse_str(
            r#"{
                "openai": {"models": {
                    "gpt-test": {"id":"gpt-test","reasoning":true,
                        "reasoning_options":{"type":"effort","values":["low","high"]}}
                }},
                "zhipuai": {"models": {
                    "glm-5.2": {"id":"glm-5.2","reasoning":true,
                        "reasoning_options":{"type":"effort","values":["high","max"]}}
                }},
                "deepseek": {"models": {
                    "deepseek-v4-flash": {"id":"deepseek-v4-flash","reasoning":true,
                        "reasoning_options":[{"type":"toggle"},{"type":"effort","values":["low","high","max"]}]},
                    "deepseek-v4-pro": {"id":"deepseek-v4-pro","reasoning":true,
                        "reasoning_options":[{"type":"toggle"},{"type":"effort","values":["high","max"]}]}
                }}
            }"#,
        )
        .expect("models.dev fixture")
    }

    fn model(reasoning: Option<ReasoningConfig>) -> AIModelConfig {
        AIModelConfig {
            id: "model-1".to_string(),
            name: "GPT Test".to_string(),
            provider: "responses".to_string(),
            model_name: "gpt-test".to_string(),
            base_url: "https://api.openai.com/v1/responses".to_string(),
            reasoning,
            ..Default::default()
        }
    }

    fn runtime_config() -> AIConfig {
        AIConfig {
            name: "GPT Test".to_string(),
            base_url: "https://api.openai.com/v1".to_string(),
            request_url: "https://api.openai.com/v1/responses".to_string(),
            api_key: "test-key".to_string(),
            model: "gpt-test".to_string(),
            format: "responses".to_string(),
            context_window: 128_000,
            max_tokens: Some(8192),
            temperature: None,
            top_p: None,
            inline_think_in_text: false,
            custom_headers: None,
            custom_headers_mode: None,
            skip_ssl_verify: false,
            custom_request_body: None,
            custom_request_body_mode: None,
        }
    }

    #[test]
    fn generated_preset_and_default_resolve_to_actions() {
        let projection = project_model_reasoning_catalog(
            &model(Some(ReasoningConfig {
                catalog: ReasoningCatalogBinding::Auto,
                default_preset: Some("high".to_string()),
                presets: Vec::new(),
            })),
            Some(&catalog()),
        );

        let high = resolve_reasoning_preset(&projection, "high").expect("generated high");
        assert_eq!(high.source, ReasoningPresetSource::ModelsDev);
        assert!(matches!(
            high.actions.as_slice(),
            [ReasoningPresetAction::Effort { value }] if value == "high"
        ));
        assert_eq!(resolve_default_reasoning_preset(&projection), Some(high));
    }

    #[test]
    fn projection_request_shape_projects_explicit_models_dev_presets() {
        let request = ReasoningCatalogProjectionRequest {
            provider: "responses".to_string(),
            model_name: "gateway-alias".to_string(),
            base_url: "https://gateway.example.com/v1/responses".to_string(),
            context_window: Some(128_000),
            max_tokens: Some(8_192),
            reasoning: ReasoningConfig {
                catalog: ReasoningCatalogBinding::ModelsDev {
                    provider: "openai".to_string(),
                    model: "gpt-test".to_string(),
                },
                ..Default::default()
            },
        };
        let projection = project_model_reasoning_catalog(
            &AIModelConfig {
                provider: request.provider,
                model_name: request.model_name,
                base_url: request.base_url,
                context_window: request.context_window,
                max_tokens: request.max_tokens,
                reasoning: Some(request.reasoning),
                ..Default::default()
            },
            Some(&catalog()),
        );

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
    fn openbitfun_models_use_their_exact_upstream_reasoning_catalogs() {
        for (provider, base_url) in [
            ("anthropic", "https://api.openbitfun.com"),
            ("openai", "https://api.openbitfun.com/v1"),
        ] {
            for (model_name, expected_provider, expected_presets) in [
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
                let projection = project_model_reasoning_catalog(
                    &AIModelConfig {
                        id: format!("openbitfun-{provider}-{model_name}"),
                        name: model_name.to_string(),
                        provider: provider.to_string(),
                        model_name: model_name.to_string(),
                        base_url: base_url.to_string(),
                        ..Default::default()
                    },
                    Some(&catalog()),
                );

                assert_eq!(
                    projection
                        .presets
                        .iter()
                        .map(|preset| preset.id.as_str())
                        .collect::<Vec<_>>(),
                    expected_presets
                );
                assert!(projection.presets.iter().all(|preset| {
                    preset.execution_provider.as_deref() == Some(expected_provider)
                        && preset.execution_model.as_deref() == Some(model_name)
                }));
                assert!(projection.presets.iter().all(|preset| {
                    preset.source == ReasoningPresetSource::ModelsDev
                        || (model_name == "glm-5.2"
                            && matches!(preset.id.as_str(), "off" | "on")
                            && preset.source == ReasoningPresetSource::AdapterFallback)
                }));
            }
        }
    }

    #[test]
    fn zhipu_glm_52_projects_protocol_specific_toggle_and_effort_presets() {
        for (provider, base_url) in [
            ("openai", "https://open.bigmodel.cn/api/paas/v4"),
            ("anthropic", "https://open.bigmodel.cn/api/anthropic"),
        ] {
            let projection = project_model_reasoning_catalog(
                &AIModelConfig {
                    id: format!("zhipu-{provider}-glm-5.2"),
                    name: "GLM-5.2".to_string(),
                    provider: provider.to_string(),
                    model_name: "glm-5.2".to_string(),
                    base_url: base_url.to_string(),
                    ..Default::default()
                },
                Some(&catalog()),
            );

            assert_eq!(
                projection
                    .presets
                    .iter()
                    .map(|preset| preset.id.as_str())
                    .collect::<Vec<_>>(),
                ["off", "on", "high", "max"]
            );
        }
    }

    #[test]
    fn adapter_fallback_default_resolves_without_models_dev() {
        let fallback_model = AIModelConfig {
            id: "model-fallback".to_string(),
            name: "Claude fallback".to_string(),
            provider: "anthropic".to_string(),
            model_name: "claude-opus-4-8".to_string(),
            base_url: "https://api.anthropic.com/v1/messages".to_string(),
            reasoning: Some(ReasoningConfig {
                default_preset: Some("high".to_string()),
                ..Default::default()
            }),
            ..Default::default()
        };
        let projection = project_model_reasoning_catalog(&fallback_model, None);
        let high = resolve_reasoning_preset(&projection, "high").expect("fallback high");

        assert_eq!(high.source, ReasoningPresetSource::AdapterFallback);
        assert_eq!(resolve_default_reasoning_preset(&projection), Some(high));

        let client = apply_default_reasoning_preset(AIClient::new(runtime_config()), &projection);
        assert_eq!(client.model_reasoning_preset(), Some(high));
    }

    #[test]
    fn configured_override_and_disable_rules_match_the_projected_catalog() {
        let overridden = project_model_reasoning_catalog(
            &model(Some(ReasoningConfig {
                catalog: ReasoningCatalogBinding::Auto,
                default_preset: Some("high".to_string()),
                presets: vec![ReasoningPreset {
                    id: "high".to_string(),
                    actions: vec![ReasoningPresetAction::Toggle { enabled: false }],
                    ..Default::default()
                }],
            })),
            Some(&catalog()),
        );
        let high = resolve_reasoning_preset(&overridden, "high").expect("configured override");
        assert_eq!(high.source, ReasoningPresetSource::ModelConfig);
        assert_eq!(
            high.actions,
            vec![ReasoningPresetAction::Toggle { enabled: false }]
        );

        let disabled = project_model_reasoning_catalog(
            &model(Some(ReasoningConfig {
                catalog: ReasoningCatalogBinding::Auto,
                default_preset: Some("high".to_string()),
                presets: vec![ReasoningPreset {
                    id: "high".to_string(),
                    disabled: true,
                    ..Default::default()
                }],
            })),
            Some(&catalog()),
        );
        assert!(resolve_reasoning_preset(&disabled, "high").is_none());
        assert!(resolve_default_reasoning_preset(&disabled).is_none());
    }

    #[test]
    fn generated_default_and_session_presets_are_applied_to_runtime_clients() {
        let projection = project_model_reasoning_catalog(
            &model(Some(ReasoningConfig {
                catalog: ReasoningCatalogBinding::Auto,
                default_preset: Some("high".to_string()),
                presets: Vec::new(),
            })),
            Some(&catalog()),
        );
        let base = apply_default_reasoning_preset(AIClient::new(runtime_config()), &projection);
        assert_eq!(
            base.model_reasoning_preset()
                .map(|preset| preset.id.as_str()),
            Some("high")
        );

        let selected = apply_selected_reasoning_preset(&base, &projection, "low")
            .expect("generated low session preset");
        assert_eq!(
            selected
                .selected_reasoning_preset()
                .map(|preset| preset.id.as_str()),
            Some("low")
        );
    }

    #[test]
    fn session_preset_normalization_fails_closed_when_catalog_is_authoritative() {
        let generated = model(Some(ReasoningConfig {
            catalog: ReasoningCatalogBinding::Auto,
            ..Default::default()
        }));

        assert_eq!(
            normalize_reasoning_preset_for_model(&generated, Some(&catalog()), Some(" high ")),
            Some("high".to_string())
        );
        assert_eq!(
            normalize_reasoning_preset_for_model(&generated, Some(&catalog()), Some("obsolete")),
            None
        );
        assert_eq!(
            normalize_reasoning_preset_for_model(&generated, Some(&catalog()), Some("auto")),
            None
        );
    }

    #[test]
    fn session_preset_normalization_preserves_selection_when_catalog_is_unavailable() {
        let generated = model(Some(ReasoningConfig {
            catalog: ReasoningCatalogBinding::Auto,
            ..Default::default()
        }));
        assert_eq!(
            normalize_reasoning_preset_for_model(&generated, None, Some("high")),
            Some("high".to_string())
        );

        let disabled = model(Some(ReasoningConfig {
            catalog: ReasoningCatalogBinding::Disabled,
            ..Default::default()
        }));
        assert_eq!(
            normalize_reasoning_preset_for_model(&disabled, None, Some("high")),
            None
        );
    }

    #[test]
    fn configured_session_preset_does_not_require_models_dev() {
        let configured = model(Some(ReasoningConfig {
            catalog: ReasoningCatalogBinding::Auto,
            presets: vec![ReasoningPreset {
                id: "custom".to_string(),
                actions: vec![ReasoningPresetAction::Toggle { enabled: true }],
                ..Default::default()
            }],
            ..Default::default()
        }));

        assert_eq!(
            normalize_reasoning_preset_for_model(&configured, None, Some("custom")),
            Some("custom".to_string())
        );

        let disabled = model(Some(ReasoningConfig {
            catalog: ReasoningCatalogBinding::Auto,
            presets: vec![ReasoningPreset {
                id: "high".to_string(),
                disabled: true,
                ..Default::default()
            }],
            ..Default::default()
        }));
        assert_eq!(
            normalize_reasoning_preset_for_model(&disabled, None, Some("high")),
            None
        );
    }

    #[cfg(feature = "model-catalog")]
    #[test]
    fn refreshed_catalog_replaces_projection_without_waiting_for_reload_interval() {
        let mut cache = Some(super::CachedReasoningCatalogSnapshot {
            snapshot: super::ModelsDevReasoningCatalogSnapshot {
                catalog: None,
                version: 1,
                sha256: "one".to_string(),
                source:
                    openbitfun_services_integrations::models_dev::ModelsDevSnapshotSource::Cache,
            },
        });
        let updated = super::ModelsDevReasoningCatalogSnapshot {
            catalog: None,
            version: 2,
            sha256: "two".to_string(),
            source: openbitfun_services_integrations::models_dev::ModelsDevSnapshotSource::Cache,
        };

        assert!(super::replace_cached_catalog(&mut cache, updated));
        assert_eq!(cache.as_ref().map(|value| value.snapshot.version), Some(2));
    }

    #[cfg(feature = "model-catalog")]
    #[test]
    fn cache_source_change_replaces_equal_bundled_snapshot() {
        let catalog = std::sync::Arc::new(catalog());
        let mut cache = Some(super::CachedReasoningCatalogSnapshot {
            snapshot: super::ModelsDevReasoningCatalogSnapshot {
                catalog: Some(catalog.clone()),
                version: 1,
                sha256: "same".to_string(),
                source:
                    openbitfun_services_integrations::models_dev::ModelsDevSnapshotSource::Bundled,
            },
        });
        let updated = super::ModelsDevReasoningCatalogSnapshot {
            catalog: Some(catalog),
            version: 1,
            sha256: "same".to_string(),
            source: openbitfun_services_integrations::models_dev::ModelsDevSnapshotSource::Cache,
        };

        assert!(super::replace_cached_catalog(&mut cache, updated));
        assert_eq!(
            cache.as_ref().map(|value| value.snapshot.source),
            Some(openbitfun_services_integrations::models_dev::ModelsDevSnapshotSource::Cache)
        );
    }
    #[cfg(feature = "model-catalog")]
    #[tokio::test]
    async fn catalog_readers_share_initial_parse_and_keep_snapshot_until_publication() {
        let directory = tempfile::tempdir().unwrap();
        let file = directory.path().join("catalog.json");
        tokio::fs::write(&file, r#"{"openai":{"models":{"a":{"id":"a"}}}}"#)
            .await
            .unwrap();
        let service =
            openbitfun_services_integrations::models_dev::ModelsDevCatalogService::new(&file);
        let cache = super::ParsedCatalogCache::default();
        let (a, b) = tokio::join!(cache.load(&service), cache.load(&service));
        assert!(std::sync::Arc::ptr_eq(
            a.catalog.as_ref().unwrap(),
            b.catalog.as_ref().unwrap()
        ));
        tokio::fs::write(
            &file,
            r#"{"openai":{"models":{"new-model":{"id":"new-model"}}}}"#,
        )
        .await
        .unwrap();
        // A read never revalidates the source, even after the background deadline.
        *cache.last_check.lock().unwrap() =
            Some(std::time::Instant::now() - std::time::Duration::from_secs(120));
        assert_eq!(cache.load(&service).await.sha256, a.sha256);
        assert!(cache.claim_background_check());
        assert!(!cache.claim_background_check());
        let _update = cache.update.lock().await;
        assert!(cache.publish(service.load_cached_or_bundled().await).await);
        let updated = cache.load(&service).await;
        assert_ne!(updated.sha256, a.sha256);
        assert!(!cache.publish(service.load_cached_or_bundled().await).await);
        assert!(std::sync::Arc::ptr_eq(
            updated.catalog.as_ref().unwrap(),
            cache.current().unwrap().catalog.as_ref().unwrap()
        ));
        tokio::fs::write(&file, "corrupt").await.unwrap();
        assert!(!cache.publish(service.load_cached_or_bundled().await).await);
        assert_eq!(cache.load(&service).await.sha256, updated.sha256);
    }
}
