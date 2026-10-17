//! Runtime-owned model pool coordination. Network IO remains in AI adapters.

use super::context_budget::CompressionTriggerBudget;
use crate::agentic::image_analysis::image_processing::ImageInputRequirement;
use crate::service::config::{
    get_global_config_service,
    types::{model_runtime_binding_fingerprint, AIConfig},
};
use crate::util::errors::{OpenBitFunError, OpenBitFunResult};
use openbitfun_agent_runtime::model_pool::{Candidate, ModelPoolRouter, Reservation};
use openbitfun_core_types::errors::AiProviderError;
use openbitfun_core_types::model_pool::{
    ModelPoolBinding, ModelPoolContextBudget, ModelPoolMemberStatus,
};
use std::collections::BTreeSet;
use std::sync::{Arc, Mutex};
use std::time::{SystemTime, UNIX_EPOCH};

pub const POOL_REVISION_KEY: &str = "runtime_model_pool_selection_revision";

pub const POOL_CONTEXT_KEY: &str = "runtime_model_pool_id";

pub fn now_ms() -> u64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .unwrap_or_default()
        .as_millis()
        .min(u64::MAX as u128) as u64
}

#[derive(Default)]
pub struct ModelPoolRuntime {
    router: Arc<Mutex<ModelPoolRouter>>,
    persistence: Arc<PoolStatePersistence>,
}

#[derive(Default)]
struct PoolStatePersistence {
    path: tokio::sync::OnceCell<std::path::PathBuf>,
    writes: tokio::sync::Mutex<()>,
}

impl PoolStatePersistence {
    async fn load(&self, router: &Mutex<ModelPoolRouter>) -> OpenBitFunResult<()> {
        self.path
            .get_or_try_init(|| async {
                let service = get_global_config_service().await?;
                let path = service.model_pool_store().await.runtime_state_path();
                let saved: Option<ModelPoolRouter> =
                    openbitfun_services_core::json_store::JsonFileStore
                        .read_locked_optional(&path)
                        .await
                        .map_err(|error| {
                            OpenBitFunError::config(format!(
                                "Failed to read model pool runtime state: {error}"
                            ))
                        })?;
                if let Some(saved) = saved {
                    *router.lock().map_err(|_| {
                        OpenBitFunError::service("Model pool state lock poisoned")
                    })? = saved;
                }
                Ok::<_, OpenBitFunError>(path)
            })
            .await?;
        Ok(())
    }

    async fn save(&self, router: &Mutex<ModelPoolRouter>) -> OpenBitFunResult<()> {
        let _write = self.writes.lock().await;
        let path = self
            .path
            .get()
            .ok_or_else(|| OpenBitFunError::service("Model pool state is not loaded"))?;
        let snapshot = router
            .lock()
            .map_err(|_| OpenBitFunError::service("Model pool state lock poisoned"))?
            .clone();
        let store = openbitfun_services_core::json_store::JsonFileStore;
        let _lease = store
            .acquire_cross_process_lock(path)
            .await
            .map_err(|error| {
                OpenBitFunError::service(format!("Failed to lock model pool state: {error}"))
            })?;
        store
            .write_atomic_strict(path, &snapshot)
            .await
            .map_err(|error| {
                OpenBitFunError::service(format!("Failed to persist model pool state: {error}"))
            })
    }
}

pub struct PoolAttempt {
    router: Arc<Mutex<ModelPoolRouter>>,
    persistence: Arc<PoolStatePersistence>,
    pub reservation: Reservation,
    pub selection_revision: u64,
    pub context_budget: ModelPoolContextBudget,
    candidates: Vec<Candidate>,
    excluded: BTreeSet<String>,
    heartbeat: tokio::task::JoinHandle<()>,
}

impl Drop for PoolAttempt {
    fn drop(&mut self) {
        self.heartbeat.abort();
        if let Ok(mut router) = self.router.lock() {
            router.cancel(&self.reservation);
        }
    }
}

impl PoolAttempt {
    pub fn has_available_alternative(&self) -> bool {
        self.router
            .lock()
            .map(|router| {
                router.has_available_alternative(
                    &self.reservation.binding.model_id,
                    &self.candidates,
                    &self.excluded,
                    now_ms(),
                )
            })
            .unwrap_or(false)
    }

    pub async fn accept(&self) -> OpenBitFunResult<ModelPoolBinding> {
        {
            let mut router = self
                .router
                .lock()
                .map_err(|_| OpenBitFunError::service("Model pool state lock poisoned"))?;
            if !router.accept(&self.reservation) {
                return Err(OpenBitFunError::service(
                    "Model pool attempt was superseded",
                ));
            }
        }
        // Output is committed; persistence must never cause it to be replayed.
        if let Err(error) = self.persistence.save(&self.router).await {
            log::warn!("Model pool state persistence failed after response acceptance: {error}");
        }
        Ok(self.reservation.binding.clone())
    }

    pub async fn fail(&self, error: &AiProviderError, delay_ms: u64) -> bool {
        let retry = self
            .router
            .lock()
            .map(|mut router| router.fail(&self.reservation, error, now_ms(), delay_ms))
            .unwrap_or(false);
        if let Err(error) = self.persistence.save(&self.router).await {
            log::warn!("Model pool health persistence failed: {error}");
        }
        retry
    }
}

impl ModelPoolRuntime {
    fn member_context_budget(
        config: &AIConfig,
        candidate: &Candidate,
    ) -> Option<ModelPoolContextBudget> {
        if !candidate.eligible {
            return None;
        }
        let model = config
            .models
            .iter()
            .find(|model| model.id == candidate.model_id)?;
        // Use the same conversion as AIClientFactory, including default context
        // size and validation/fallback of the configured output limit. No auth or
        // network access is needed to resolve these limits.
        let resolved = crate::util::types::AIConfig::try_from(model.clone()).ok()?;
        let budget = CompressionTriggerBudget::for_model(
            resolved.context_window as usize,
            resolved.max_tokens,
        );
        Some(ModelPoolContextBudget {
            context_window: resolved.context_window,
            input_limit: budget.input_limit as u32,
        })
    }

    fn configured_context_budget(
        config: &AIConfig,
        member_ids: &[String],
    ) -> OpenBitFunResult<ModelPoolContextBudget> {
        // Request-specific image/tool requirements and transient health must not
        // make the shared pool budget fluctuate between requests.
        Self::candidates(config, member_ids, false, ImageInputRequirement::None)
            .iter()
            .filter_map(|candidate| Self::member_context_budget(config, candidate))
            .reduce(|left, right| ModelPoolContextBudget {
                context_window: left.context_window.min(right.context_window),
                input_limit: left.input_limit.min(right.input_limit),
            })
            .ok_or_else(|| {
                OpenBitFunError::AIClient(
                    "Model pool has no members with a valid context budget".into(),
                )
            })
    }

    pub async fn context_budget(&self, pool_id: &str) -> OpenBitFunResult<ModelPoolContextBudget> {
        let service = get_global_config_service().await?;
        let pool = service.model_pool_store().await.get(pool_id).await?;
        let config: AIConfig = service.get_config(Some("ai")).await?;
        Self::configured_context_budget(&config, &pool.member_model_ids)
    }

    fn candidates(
        config: &AIConfig,
        member_ids: &[String],
        require_tools: bool,
        image_requirement: ImageInputRequirement,
    ) -> Vec<Candidate> {
        use crate::service::config::types::ModelCapability;
        member_ids
            .iter()
            .map(|id| {
                let model = config.models.iter().find(|model| &model.id == id);
                Candidate {
                    model_id: id.clone(),
                    fingerprint: model
                        .map(model_runtime_binding_fingerprint)
                        .unwrap_or_default(),
                    eligible: model.is_some_and(|model| {
                        model.enabled
                            && model.supports_text_generation()
                            && config.models.iter().filter(|entry| &entry.id == id).count() == 1
                            && (!require_tools
                                || model.capabilities.is_empty()
                                || model
                                    .capabilities
                                    .contains(&ModelCapability::FunctionCalling))
                            && image_requirement.validate(config, &model.id).is_ok()
                    }),
                }
            })
            .collect()
    }

    fn unavailable_error(
        pool_id: &str,
        error: openbitfun_agent_runtime::model_pool::SelectionError,
        router: &ModelPoolRouter,
        candidates: &[Candidate],
        excluded: &BTreeSet<String>,
        image_requirement: ImageInputRequirement,
    ) -> OpenBitFunError {
        let members = candidates
            .iter()
            .map(|candidate| {
                let status = router.member_status(candidate, now_ms());
                let state = if !candidate.eligible {
                    "disabled, missing or incompatible".to_owned()
                } else if excluded.contains(&candidate.model_id) {
                    format!("attempted: {:?}", status.status)
                } else {
                    format!("{:?}", status.status)
                };
                format!(
                    "{}: {}{}",
                    candidate.model_id,
                    state,
                    status
                        .reason
                        .map(|reason| format!(" ({reason})"))
                        .unwrap_or_default()
                )
            })
            .collect::<Vec<_>>()
            .join("; ");
        let requirement = match image_requirement {
            ImageInputRequirement::None => "",
            ImageInputRequirement::Native => "; request requires native image support",
            ImageInputRequirement::NativeOrAnalysisTool => "; request requires native image support or tool-call support with a configured, enabled image understanding model",
        };
        OpenBitFunError::AIClient(format!(
            "Model pool unavailable: {pool_id}: {error:?}{requirement}; members: [{members}]"
        ))
    }

    pub fn clear_session(&self, session_id: &str) -> OpenBitFunResult<()> {
        self.router
            .lock()
            .map_err(|_| OpenBitFunError::service("Model pool state lock poisoned"))?
            .clear_session(session_id);
        Ok(())
    }

    pub async fn restore_binding(
        &self,
        session_id: &str,
        selection_revision: u64,
        binding: ModelPoolBinding,
    ) -> OpenBitFunResult<()> {
        self.persistence.load(&self.router).await?;
        self.router
            .lock()
            .map_err(|_| OpenBitFunError::service("Model pool state lock poisoned"))?
            .restore_binding(&format!("{session_id}:{selection_revision}"), binding);
        Ok(())
    }

    pub async fn retry_member(&self, model_id: &str) -> OpenBitFunResult<()> {
        self.persistence.load(&self.router).await?;
        self.router
            .lock()
            .map_err(|_| OpenBitFunError::service("Model pool state lock poisoned"))?
            .retry_member(model_id);
        self.persistence.save(&self.router).await
    }

    pub async fn statuses(&self, pool_id: &str) -> OpenBitFunResult<Vec<ModelPoolMemberStatus>> {
        self.persistence.load(&self.router).await?;
        let service = get_global_config_service().await?;
        let pool = service.model_pool_store().await.get(pool_id).await?;
        let config: AIConfig = service.get_config(Some("ai")).await?;
        let candidates = Self::candidates(
            &config,
            &pool.member_model_ids,
            false,
            ImageInputRequirement::None,
        );
        let router = self
            .router
            .lock()
            .map_err(|_| OpenBitFunError::service("Model pool state lock poisoned"))?;
        Ok(candidates
            .iter()
            .map(|candidate| {
                let mut status = router.member_status(candidate, now_ms());
                status.context_budget = Self::member_context_budget(&config, candidate);
                if let Some(model) = config
                    .models
                    .iter()
                    .find(|model| model.id == candidate.model_id)
                {
                    if !model.enabled {
                        status.status =
                            openbitfun_core_types::model_pool::ModelPoolHealthStatus::Disabled;
                    }
                } else {
                    status.status =
                        openbitfun_core_types::model_pool::ModelPoolHealthStatus::Missing;
                }
                status
            })
            .collect())
    }

    /// Preview is read-only: admission/UI reads never advance the shared cursor.
    pub(crate) async fn preview(
        &self,
        session_id: &str,
        selection_revision: u64,
        pool_id: &str,
        require_tools: bool,
        image_requirement: ImageInputRequirement,
    ) -> OpenBitFunResult<(String, String)> {
        self.persistence.load(&self.router).await?;
        let service = get_global_config_service().await?;
        let pool = service.model_pool_store().await.get(pool_id).await?;
        let config: AIConfig = service.get_config(Some("ai")).await?;
        self.preview_with_config(
            &format!("{session_id}:{selection_revision}"),
            &pool,
            &config,
            require_tools,
            image_requirement,
        )
    }

    fn preview_with_config(
        &self,
        key: &str,
        pool: &crate::service::config::model_pool_store::ModelPoolDefinition,
        config: &AIConfig,
        require_tools: bool,
        image_requirement: ImageInputRequirement,
    ) -> OpenBitFunResult<(String, String)> {
        let pool_id = &pool.id;
        let candidates = Self::candidates(
            &config,
            &pool.member_model_ids,
            require_tools,
            image_requirement,
        );
        let mut preview = self
            .router
            .lock()
            .map_err(|_| OpenBitFunError::service("Model pool state lock poisoned"))?
            .clone();
        preview.release_session_reservation(key);
        let reservation = preview
            .reserve(
                &key,
                pool_id,
                pool.strategy_kind(),
                &candidates,
                &BTreeSet::new(),
                now_ms(),
                1,
            )
            .map_err(|error| {
                Self::unavailable_error(
                    pool_id,
                    error,
                    &preview,
                    &candidates,
                    &BTreeSet::new(),
                    image_requirement,
                )
            })?;
        Ok((
            reservation.binding.model_id,
            reservation.binding.configuration_fingerprint,
        ))
    }

    #[allow(clippy::too_many_arguments)]
    pub(crate) async fn prepare(
        &self,
        session_id: &str,
        selection_revision: u64,
        pool_id: &str,
        excluded: &mut BTreeSet<String>,
        require_tools: bool,
        image_requirement: ImageInputRequirement,
    ) -> OpenBitFunResult<(PoolAttempt, Arc<crate::infrastructure::ai::AIClient>)> {
        let factory = crate::infrastructure::ai::get_global_ai_client_factory()
            .await
            .map_err(|error| OpenBitFunError::AIClient(error.to_string()))?;
        // Each failed preparation is excluded, so traverse all configured
        // candidates independently of any member's request retry budget.
        loop {
            let attempt = self
                .reserve(
                    session_id,
                    selection_revision,
                    pool_id,
                    excluded,
                    require_tools,
                    image_requirement,
                )
                .await?;
            let binding = &attempt.reservation.binding;
            match factory
                .get_client_by_approved_binding_with_reasoning_preset(
                    &binding.model_id,
                    &binding.configuration_fingerprint,
                    None,
                )
                .await
            {
                Ok(client) => return Ok((attempt, client)),
                Err(_) => {
                    // No request payload has been sent. A client preparation failure
                    // concerns this configured member, never the user's content.
                    self.router
                        .lock()
                        .map_err(|_| OpenBitFunError::service("Model pool state lock poisoned"))?
                        .configuration_failed(&attempt.reservation);
                    self.persistence.save(&self.router).await?;
                    excluded.insert(binding.model_id.clone());
                }
            }
        }
    }

    pub(crate) async fn reserve(
        &self,
        session_id: &str,
        selection_revision: u64,
        pool_id: &str,
        excluded: &BTreeSet<String>,
        require_tools: bool,
        image_requirement: ImageInputRequirement,
    ) -> OpenBitFunResult<PoolAttempt> {
        self.persistence.load(&self.router).await?;
        let service = get_global_config_service().await?;
        let pool = service.model_pool_store().await.get(pool_id).await?;
        let config: AIConfig = service.get_config(Some("ai")).await?;
        let candidates = Self::candidates(
            &config,
            &pool.member_model_ids,
            require_tools,
            image_requirement,
        );
        let context_budget = Self::configured_context_budget(&config, &pool.member_model_ids)?;
        // The live attempt is released by RAII. The lease bounds orphaned probes.
        let lease_ms = config
            .stream_ttft_timeout_secs
            .unwrap_or(300)
            .saturating_mul(1000)
            .saturating_add(
                config
                    .stream_idle_timeout_secs
                    .unwrap_or(300)
                    .saturating_mul(1000),
            )
            .max(60_000);
        let reservation = {
            let mut router = self
                .router
                .lock()
                .map_err(|_| OpenBitFunError::service("Model pool state lock poisoned"))?;
            router
                .reserve(
                    &format!("{session_id}:{selection_revision}"),
                    pool_id,
                    pool.strategy_kind(),
                    &candidates,
                    excluded,
                    now_ms(),
                    lease_ms,
                )
                .map_err(|error| {
                    Self::unavailable_error(
                        pool_id,
                        error,
                        &router,
                        &candidates,
                        excluded,
                        image_requirement,
                    )
                })?
        };
        let heartbeat_router = Arc::downgrade(&self.router);
        let heartbeat_reservation = reservation.clone();
        let heartbeat = tokio::spawn(async move {
            let mut interval = tokio::time::interval(std::time::Duration::from_millis(
                (lease_ms / 3).clamp(1, 30_000),
            ));
            loop {
                interval.tick().await;
                let Some(router) = heartbeat_router.upgrade() else {
                    break;
                };
                if let Ok(mut router) = router.lock() {
                    router.renew(&heartbeat_reservation, now_ms(), lease_ms);
                };
            }
        });
        Ok(PoolAttempt {
            router: Arc::clone(&self.router),
            persistence: Arc::clone(&self.persistence),
            reservation,
            selection_revision,
            context_budget,
            candidates,
            excluded: excluded.clone(),
            heartbeat,
        })
    }
}

#[cfg(test)]
pub(super) fn test_attempt(
    router: Arc<Mutex<ModelPoolRouter>>,
    path: std::path::PathBuf,
) -> PoolAttempt {
    test_attempt_excluding(router, path, BTreeSet::new())
}

#[cfg(test)]
pub(super) fn test_attempt_excluding(
    router: Arc<Mutex<ModelPoolRouter>>,
    path: std::path::PathBuf,
    excluded: BTreeSet<String>,
) -> PoolAttempt {
    let persistence = Arc::new(PoolStatePersistence::default());
    persistence.path.set(path).unwrap();
    let candidates = ["a", "b"].map(|id| Candidate {
        model_id: id.into(),
        fingerprint: id.into(),
        eligible: true,
    });
    let reservation = router
        .lock()
        .unwrap()
        .reserve(
            "session-1:0",
            "p",
            openbitfun_core_types::model_pool::ModelPoolStrategy::Ordered,
            &candidates,
            &excluded,
            now_ms(),
            60_000,
        )
        .unwrap();
    PoolAttempt {
        router,
        persistence,
        reservation,
        selection_revision: 0,
        context_budget: ModelPoolContextBudget {
            context_window: 128_000,
            input_limit: 86_000,
        },
        candidates: candidates.to_vec(),
        excluded,
        heartbeat: tokio::spawn(async {}),
    }
}

/// Project provider-private data for the destination without mutating stable history.
/// Unknown provenance is deliberately not replayed when entering a model pool.
pub(super) fn replay_safe_messages<'a>(
    messages: &'a [crate::agentic::core::Message],
    fingerprint: &str,
    pool_selected: bool,
) -> std::borrow::Cow<'a, [crate::agentic::core::Message]> {
    use crate::agentic::core::{MessageContent, MessageRole};
    let incompatible = |message: &crate::agentic::core::Message| {
        message.role == MessageRole::Assistant
            && match message.metadata.model_pool_replay_fingerprint.as_deref() {
                Some(source) => source != fingerprint,
                None => pool_selected,
            }
    };
    if !messages.iter().any(incompatible) {
        return std::borrow::Cow::Borrowed(messages);
    }
    let mut projected = messages.to_vec();
    for message in projected.iter_mut().filter(|message| incompatible(message)) {
        message.metadata.thinking_signature = None;
        message.metadata.model_response_replay = None;
        message.metadata.reasoning_content_kind = None;
        if let MessageContent::Mixed {
            reasoning_content, ..
        } = &mut message.content
        {
            *reasoning_content = None;
        }
    }
    std::borrow::Cow::Owned(projected)
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::agentic::core::{Message, MessageContent, ToolCall};
    use crate::service::config::types::{AIModelConfig, ModelCapability};

    fn budget_model(id: &str, context: Option<u32>, output: Option<u32>) -> AIModelConfig {
        AIModelConfig {
            id: id.into(),
            enabled: true,
            context_window: context,
            max_tokens: output,
            capabilities: vec![ModelCapability::TextChat],
            ..Default::default()
        }
    }

    fn image_pool_fixture(
        strategy: &str,
    ) -> (
        AIConfig,
        crate::service::config::model_pool_store::ModelPoolDefinition,
    ) {
        let mut text = budget_model("text", Some(128_000), None);
        text.capabilities.push(ModelCapability::FunctionCalling);
        let mut native = text.clone();
        native.id = "native".into();
        native
            .capabilities
            .push(ModelCapability::ImageUnderstanding);
        let config = AIConfig {
            models: vec![text, native],
            ..Default::default()
        };
        let pool = crate::service::config::model_pool_store::ModelPoolDefinition {
            id: "pool-images".into(),
            name: "Images".into(),
            strategy: strategy.into(),
            member_model_ids: vec!["text".into(), "native".into()],
            extensions: Default::default(),
        };
        (config, pool)
    }

    #[test]
    fn model_pool_image_preview_and_reservation_use_same_compatibility_without_mutating_state() {
        for strategy in ["ordered", "balanced"] {
            for tool_available in [false, true] {
                for vision_configured in [false, true] {
                    let (mut config, pool) = image_pool_fixture(strategy);
                    if vision_configured {
                        config.default_models.image_understanding = Some("native".into());
                    }
                    let requirement = if tool_available {
                        ImageInputRequirement::NativeOrAnalysisTool
                    } else {
                        ImageInputRequirement::Native
                    };
                    let expected = if tool_available && vision_configured {
                        "text"
                    } else {
                        "native"
                    };
                    let runtime = ModelPoolRuntime::default();
                    let before = serde_json::to_value(&*runtime.router.lock().unwrap()).unwrap();
                    for _ in 0..2 {
                        let selected = runtime
                            .preview_with_config("session:0", &pool, &config, true, requirement)
                            .unwrap();
                        assert_eq!(
                            selected.0, expected,
                            "{strategy}, tool={tool_available}, vision={vision_configured}"
                        );
                        requirement.validate(&config, &selected.0).unwrap();
                    }
                    assert_eq!(
                        serde_json::to_value(&*runtime.router.lock().unwrap()).unwrap(),
                        before
                    );
                    let candidates = ModelPoolRuntime::candidates(
                        &config,
                        &pool.member_model_ids,
                        true,
                        requirement,
                    );
                    let mut router = runtime.router.lock().unwrap();
                    let reserved = router
                        .reserve(
                            "session:0",
                            &pool.id,
                            pool.strategy_kind(),
                            &candidates,
                            &BTreeSet::new(),
                            now_ms(),
                            60_000,
                        )
                        .unwrap();
                    assert_eq!(reserved.binding.model_id, expected);
                    assert!(router.accept(&reserved));
                }
            }
        }
    }

    #[test]
    fn model_pool_image_affinity_is_retained_only_when_compatible_and_does_not_poison_health() {
        for strategy in ["ordered", "balanced"] {
            let (mut config, pool) = image_pool_fixture(strategy);
            let runtime = ModelPoolRuntime::default();
            let ordinary = ModelPoolRuntime::candidates(
                &config,
                &pool.member_model_ids,
                true,
                ImageInputRequirement::None,
            );
            {
                let mut router = runtime.router.lock().unwrap();
                let first = router
                    .reserve(
                        "parent:0",
                        &pool.id,
                        pool.strategy_kind(),
                        &ordinary,
                        &BTreeSet::new(),
                        now_ms(),
                        60_000,
                    )
                    .unwrap();
                assert_eq!(first.binding.model_id, "text");
                assert!(router.accept(&first));
                // BTW inherits a binding but its request must still be compatible.
                router.restore_binding("btw:0", first.binding);
            }
            let before = serde_json::to_value(&*runtime.router.lock().unwrap()).unwrap();
            for key in ["parent:0", "btw:0"] {
                assert_eq!(
                    runtime
                        .preview_with_config(
                            key,
                            &pool,
                            &config,
                            true,
                            ImageInputRequirement::NativeOrAnalysisTool
                        )
                        .unwrap()
                        .0,
                    "native"
                );
            }
            assert_eq!(
                serde_json::to_value(&*runtime.router.lock().unwrap()).unwrap(),
                before
            );
            config.default_models.image_understanding = Some("native".into());
            assert_eq!(
                runtime
                    .preview_with_config(
                        "btw:0",
                        &pool,
                        &config,
                        true,
                        ImageInputRequirement::NativeOrAnalysisTool
                    )
                    .unwrap()
                    .0,
                "text"
            );
            assert_eq!(
                runtime
                    .preview_with_config(
                        "btw:0",
                        &pool,
                        &config,
                        false,
                        ImageInputRequirement::Native
                    )
                    .unwrap()
                    .0,
                "native"
            );
            assert_eq!(
                runtime
                    .preview_with_config("btw:0", &pool, &config, true, ImageInputRequirement::None)
                    .unwrap()
                    .0,
                "text"
            );
        }
    }

    #[test]
    fn model_pool_image_unavailable_error_explains_requirement_and_leaves_text_member_usable() {
        let (config, mut pool) = image_pool_fixture("ordered");
        pool.member_model_ids = vec!["text".into()];
        let runtime = ModelPoolRuntime::default();
        let error = runtime
            .preview_with_config(
                "session:0",
                &pool,
                &config,
                true,
                ImageInputRequirement::NativeOrAnalysisTool,
            )
            .unwrap_err()
            .to_string();
        assert!(
            error.contains("request requires native image support"),
            "{error}"
        );
        assert_eq!(
            runtime
                .preview_with_config(
                    "session:0",
                    &pool,
                    &config,
                    true,
                    ImageInputRequirement::None
                )
                .unwrap()
                .0,
            "text"
        );
        assert!(runtime
            .router
            .lock()
            .unwrap()
            .binding("session:0")
            .is_none());
    }

    #[test]
    fn model_pool_context_budget_uses_independent_minima_and_preserves_member_limits() {
        let config = AIConfig {
            models: vec![
                budget_model("small", Some(128_000), Some(8_000)),
                budget_model("large", Some(160_000), Some(64_000)),
            ],
            ..Default::default()
        };
        let ids = vec!["small".into(), "large".into()];
        let common = ModelPoolRuntime::configured_context_budget(&config, &ids).unwrap();
        assert_eq!(
            common,
            ModelPoolContextBudget {
                context_window: 128_000,
                input_limit: 86_000
            }
        );
        let candidates =
            ModelPoolRuntime::candidates(&config, &ids, false, ImageInputRequirement::None);
        let router = ModelPoolRouter::default();
        for candidate in candidates {
            // Unverified/offline members still constrain admission; it must not
            // depend on a successful request or current routing preference.
            assert_eq!(
                router.member_status(&candidate, 0).status,
                openbitfun_core_types::model_pool::ModelPoolHealthStatus::Unverified
            );
            let member = ModelPoolRuntime::member_context_budget(&config, &candidate).unwrap();
            assert!(common.context_window <= member.context_window);
            assert!(common.input_limit <= member.input_limit);
        }
        let trigger = CompressionTriggerBudget::for_pool(common);
        assert_eq!(trigger.input_limit, 86_000);
        assert_eq!(
            trigger.input_limit + trigger.output_reserve_tokens + trigger.safety_reserve_tokens,
            128_000
        );
        assert_eq!(config.models[0].max_tokens, Some(8_000));
        assert_eq!(config.models[1].context_window, Some(160_000));
    }

    #[test]
    fn model_pool_context_budget_resolves_defaults_and_ignores_unroutable_records() {
        let mut config = AIConfig {
            models: vec![
                budget_model("default", None, Some(u32::MAX)),
                budget_model("disabled", Some(32_000), None),
                budget_model("invalid", Some(1), None),
                budget_model("duplicate", Some(32_000), None),
                budget_model("duplicate", Some(32_000), None),
            ],
            ..Default::default()
        };
        config.models[1].enabled = false;
        let ids = ["default", "disabled", "invalid", "duplicate", "missing"].map(String::from);
        let resolved = crate::util::types::AIConfig::try_from(config.models[0].clone()).unwrap();
        let common = ModelPoolRuntime::configured_context_budget(&config, &ids).unwrap();
        assert_eq!(common.context_window, resolved.context_window);
        assert_eq!(
            common.input_limit,
            resolved.context_window - resolved.max_tokens.unwrap() - 10_000
        );
        config.models[1].enabled = true;
        let updated = ModelPoolRuntime::configured_context_budget(&config, &ids).unwrap();
        assert_eq!(
            updated,
            ModelPoolContextBudget {
                context_window: 32_000,
                input_limit: 14_000
            }
        );
        config.models.clear();
        assert!(ModelPoolRuntime::configured_context_budget(&config, &ids).is_err());
    }

    #[test]
    fn model_pool_switch_preserves_tool_history_but_not_foreign_signatures() {
        let original = Message::assistant_with_reasoning(
            Some("private reasoning".into()),
            "answer".into(),
            vec![ToolCall {
                tool_id: "call-1".into(),
                tool_name: "Read".into(),
                ..Default::default()
            }],
        )
        .with_thinking_signature(Some("private-signature".into()))
        .with_model_pool_replay_fingerprint(Some("a".into()));
        let messages = vec![original];
        let same = replay_safe_messages(&messages, "a", true);
        assert_eq!(
            same[0].metadata.thinking_signature.as_deref(),
            Some("private-signature")
        );
        let other = replay_safe_messages(&messages, "b", true);
        assert!(other[0].metadata.thinking_signature.is_none());
        assert_eq!(other[0].id, messages[0].id);
        let MessageContent::Mixed {
            reasoning_content,
            text,
            tool_calls,
        } = &other[0].content
        else {
            panic!("tool history lost")
        };
        assert!(reasoning_content.is_none());
        assert_eq!(text, "answer");
        assert_eq!(tool_calls[0].tool_id, "call-1");
        assert!(messages[0].metadata.thinking_signature.is_some());
        let mut legacy = serde_json::to_value(&messages[0]).unwrap();
        legacy["metadata"]
            .as_object_mut()
            .unwrap()
            .remove("model_pool_replay_fingerprint");
        let legacy: Message = serde_json::from_value(legacy).unwrap();
        assert!(replay_safe_messages(&[legacy], "b", true)[0]
            .metadata
            .thinking_signature
            .is_none());
    }
}
