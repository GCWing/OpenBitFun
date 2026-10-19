//! AI client factory - centrally manages client instances for all models
//!
//! Responsibilities:
//! 1. Create and cache AI clients on demand
//! 2. Manage agent model configuration
//! 3. Invalidate cache when configuration changes
//! 4. Provide global singleton access

use crate::infrastructure::ai::reasoning_catalog::{
    apply_default_reasoning_preset, apply_selected_reasoning_preset,
    load_models_dev_reasoning_catalog, project_model_reasoning_catalog,
    resolve_default_reasoning_preset,
};
use crate::infrastructure::ai::{build_stream_options_for_model, AIClient};
#[cfg(feature = "subscription-auth")]
use crate::infrastructure::subscription_auth::{
    self, SubscriptionHttpOptions, SubscriptionProvider as AdapterProvider,
};
#[cfg(feature = "subscription-auth")]
use crate::service::config::types::SubscriptionProvider;
use crate::service::config::types::{model_runtime_binding_fingerprint, AIModelConfig, AuthConfig};
use crate::service::config::{get_global_config_service, ConfigService};
use crate::util::errors::{OpenBitFunError, OpenBitFunResult};
use crate::util::types::AIConfig;
use anyhow::{anyhow, Result};
use log::{debug, info, warn};
use openbitfun_ai_adapters::resolve_required_model_selector;
use sha2::{Digest, Sha256};
use std::collections::HashMap;
use std::sync::{Arc, OnceLock, RwLock};

#[cfg(all(test, feature = "subscription-auth"))]
pub(crate) static SUBSCRIPTION_STORE_TEST_LOCK: tokio::sync::Mutex<()> =
    tokio::sync::Mutex::const_new(());

pub struct AIClientFactory {
    config_service: Arc<ConfigService>,
    client_cache: RwLock<HashMap<(String, Option<String>), CachedAIClient>>,
    #[cfg(test)]
    account_test_endpoints: RwLock<HashMap<String, String>>,
}

struct CachedAIClient {
    configuration_fingerprint: String,
    default_reasoning_preset: Option<openbitfun_core_types::ReasoningPresetDescriptor>,
    client: Arc<AIClient>,
    /// Unix seconds when the resolved subscription credential expires.
    #[cfg(feature = "subscription-auth")]
    credential_expires_at: Option<i64>,
    #[cfg(feature = "subscription-auth")]
    credential_revision: Option<u64>,
}

struct ApprovedModelRequest {
    config_service: Arc<ConfigService>,
    model_id: String,
    fingerprint: String,
    static_key_digest: Option<[u8; 32]>,
}

impl std::fmt::Debug for ApprovedModelRequest {
    fn fmt(&self, formatter: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        formatter
            .debug_struct("ApprovedModelRequest")
            .field("model_id", &self.model_id)
            .finish_non_exhaustive()
    }
}

impl openbitfun_ai_adapters::client::ModelRequestAuthorization for ApprovedModelRequest {
    fn validate(
        &self,
    ) -> std::pin::Pin<Box<dyn std::future::Future<Output = Result<()>> + Send + '_>> {
        Box::pin(async move {
            let validated = async {
                let global = self.config_service.get_config(None).await?;
                let current = configured_model_in_service(&self.config_service, &global, &self.model_id, Some(&self.fingerprint)).await?;
                if self.static_key_digest.is_some_and(|expected| <[u8; 32]>::from(Sha256::digest(current.api_key.as_bytes())) != expected) {
                    return Err(anyhow!("The configured API key changed while this request was waiting; retry with the current model configuration"));
                }
                Ok(())
            }.await;
            validated.map_err(|error: anyhow::Error| {
                let mut detail = openbitfun_core_types::errors::AiProviderError::classified(
                    format!("Local model authorization failed: {error}"),
                    openbitfun_core_types::errors::ErrorCategory::InvalidRequest,
                );
                detail.provider_code = Some("local_model_authorization_unavailable".into());
                anyhow::Error::new(detail)
            })
        })
    }
}

/// Exhausted candidate preferences are distinct from a changed binding or
/// failed storage contract. An existing attempt may still use its own budget.
#[derive(Debug)]
pub(crate) struct AccountPoolUnavailable {
    reasons: Vec<openbitfun_agent_runtime::account_routing::RejectedAccount>,
}

impl std::fmt::Display for AccountPoolUnavailable {
    fn fmt(&self, formatter: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        write!(
            formatter,
            "No subscription account in this model's pool is available: {:?}",
            self.reasons
        )
    }
}

impl std::error::Error for AccountPoolUnavailable {}

impl AccountPoolUnavailable {
    #[cfg_attr(not(feature = "subscription-auth"), allow(dead_code))]
    pub(crate) fn new(
        reasons: Vec<openbitfun_agent_runtime::account_routing::RejectedAccount>,
    ) -> Self {
        Self { reasons }
    }

    /// Earliest expiry of a routing-inferred cooldown. Only this inference may
    /// be probed before expiry; provider-reported exhaustion, disabled seats
    /// and missing credentials stay rejected.
    pub(crate) fn soonest_cooldown(&self) -> Option<i64> {
        self.reasons
            .iter()
            .filter(|rejected| {
                rejected.reason
                    == openbitfun_agent_runtime::account_routing::AccountRejection::Cooldown
            })
            .filter_map(|rejected| rejected.recovery_at)
            .min()
    }
}

/// Only authentication preparation failures may advance an ordered pool.
/// Configuration, immutable binding, reasoning and storage-policy errors must
/// not be reinterpreted as a reason to select a different account.
#[derive(Debug)]
pub(crate) struct AccountCredentialPreparationError {
    pub account_id: String,
    source: anyhow::Error,
}

impl std::fmt::Display for AccountCredentialPreparationError {
    fn fmt(&self, formatter: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        write!(
            formatter,
            "Failed to prepare subscription account {}: {}",
            self.account_id, self.source
        )
    }
}

impl std::error::Error for AccountCredentialPreparationError {
    fn source(&self) -> Option<&(dyn std::error::Error + 'static)> {
        Some(self.source.as_ref())
    }
}

/// Once a cached subscription credential is within this window of expiry, the
/// client is rebuilt so subscription authentication refreshes the token. Kept
/// equal to the providers' refresh leeway so the rebuilt client always gets a
/// fresh token.
#[cfg(feature = "subscription-auth")]
const SUBSCRIPTION_CREDENTIAL_STALE_LEEWAY_SECS: i64 = 5 * 60;

#[cfg(feature = "subscription-auth")]
fn now_unix_secs() -> i64 {
    std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.as_secs() as i64)
        .unwrap_or(0)
}

#[cfg(feature = "subscription-auth")]
fn subscription_credential_stale(auth: &AuthConfig, cached: &CachedAIClient) -> bool {
    if !matches!(
        auth,
        AuthConfig::Subscription { .. } | AuthConfig::SubscriptionPool { .. }
    ) {
        return false;
    }
    cached.credential_expires_at.is_some_and(|expires_at| {
        expires_at <= now_unix_secs() + SUBSCRIPTION_CREDENTIAL_STALE_LEEWAY_SECS
    })
}

#[cfg(not(feature = "subscription-auth"))]
fn subscription_credential_stale(auth: &AuthConfig, _cached: &CachedAIClient) -> bool {
    matches!(
        auth,
        AuthConfig::Subscription { .. } | AuthConfig::SubscriptionPool { .. }
    )
}

async fn configured_model_in_service(
    config_service: &ConfigService,
    global_config: &crate::service::config::GlobalConfig,
    model_id: &str,
    expected_configuration_fingerprint: Option<&str>,
) -> Result<AIModelConfig> {
    let normalized_model_id = model_id.trim();
    if normalized_model_id.is_empty() {
        return Err(anyhow!("Model configuration id is empty"));
    }
    let model = if let Some(model) = config_service
        .get_runtime_ai_model(normalized_model_id)
        .await
    {
        model
    } else {
        let mut matching = global_config
            .ai
            .models
            .iter()
            .filter(|model| model.id == normalized_model_id);
        let model = matching
            .next()
            .cloned()
            .ok_or_else(|| anyhow!("Model configuration not found: {normalized_model_id}"))?;
        if matching.next().is_some() {
            return Err(anyhow!(
                "Multiple model configurations use the same ID: {normalized_model_id}"
            ));
        }
        model
    };
    if openbitfun_config_contracts::protected_account_models::is_guarded_account_model(&model) {
        return Err(anyhow!("This subscription account binding requires an account-capable OpenBitFun; the original configuration was preserved"));
    }
    if !model.enabled {
        return Err(anyhow!(
            "Model '{}' (id={}) is currently disabled; enable it in settings or pick another model",
            model.name,
            model.id
        ));
    }
    if expected_configuration_fingerprint
        .is_some_and(|expected| expected != model_runtime_binding_fingerprint(&model))
    {
        return Err(anyhow!(
            "Approved model binding changed for configuration id: {normalized_model_id}"
        ));
    }
    Ok(model)
}

impl AIClientFactory {
    pub(crate) async fn validate_channel_snapshot(&self, members: &[AIModelConfig]) -> Result<()> {
        let effective = self.config_service.get_effective_ai_config().await?;
        for model in members {
            let current = effective
                .models
                .iter()
                .filter(|current| current.id == model.id)
                .collect::<Vec<_>>();
            if current.len() != 1
                || model_runtime_binding_fingerprint(current[0])
                    != model_runtime_binding_fingerprint(model)
            {
                return Err(anyhow!("Approved channel binding changed: {}", model.id));
            }
        }
        Ok(())
    }

    pub(crate) async fn prepare_native_routed_model_client(
        self: &Arc<Self>,
        model_id: &str,
        fingerprint: &str,
        reasoning_preset: Option<&str>,
        lineage: Option<&str>,
        temperature: Option<f64>,
    ) -> Result<(
        super::channel_client_source::PreparedChannel,
        Option<Arc<super::channel_client_source::ChannelClientSource>>,
    )> {
        let global: crate::service::config::GlobalConfig =
            self.config_service.get_config(None).await?;
        let model = self
            .configured_model(&global, model_id, Some(fingerprint))
            .await?;
        if model.channel_routing.is_none() {
            let prepared = self
                .prepare_native_model_candidate_or_probe(
                    model_id,
                    fingerprint,
                    reasoning_preset,
                    lineage,
                    temperature,
                )
                .await?;
            return Ok((prepared, None));
        }
        let effective = self.config_service.get_effective_ai_config().await?;
        let members = openbitfun_config_contracts::channel_routing::channel_members(
            &model,
            &effective.models,
        )
        .map_err(anyhow::Error::msg)?
        .into_iter()
        .cloned()
        .collect();
        let source = Arc::new(super::channel_client_source::ChannelClientSource::new(
            self.clone(),
            members,
            reasoning_preset.map(str::to_string),
            temperature,
            openbitfun_services_core::routing_state::RoutingStateStore::new(
                self.config_service
                    .user_data_dir()
                    .await
                    .join("model-channel-routing"),
            ),
        ));
        let prepared = source
            .resolve(&[], None, lineage, None)
            .await?
            .ok_or_else(|| anyhow!("No eligible channel in the configured route"))?;
        Ok((prepared, Some(source)))
    }

    #[cfg(feature = "subscription-auth")]
    pub(crate) async fn recover_account_authentication(
        &self,
        model_id: &str,
        fingerprint: &str,
        origin: &openbitfun_core_types::ModelAccountOrigin,
        rejected: &AIClient,
    ) -> Result<()> {
        if AdapterProvider::from_key(&origin.provider).is_none()
            || rejected
                .subscription_account_origin(&origin.account_id)
                .as_ref()
                != Some(origin)
        {
            return Err(anyhow!(
                "Rejected request has no matching subscription account identity"
            ));
        }
        let current = self
            .get_client_for_account(model_id, fingerprint, &origin.account_id)
            .await?;
        if current
            .subscription_account_origin(&origin.account_id)
            .as_ref()
            != Some(origin)
        {
            return Err(anyhow!(
                "Subscription account identity changed after the rejected request"
            ));
        }
        let global: crate::service::config::GlobalConfig =
            self.config_service.get_config(None).await?;
        let options = SubscriptionHttpOptions::new(
            global.ai.proxy.enabled.then_some(global.ai.proxy),
            current.config.skip_ssl_verify,
        );
        subscription_auth::recover_rejected_account_with_options(
            AdapterProvider::from_key(&origin.provider)
                .ok_or_else(|| anyhow!("Unknown subscription provider"))?,
            &origin.account_id,
            &rejected.config.api_key,
            origin.upstream_account_id.as_deref(),
            &options,
        )
        .await
    }

    fn new(config_service: Arc<ConfigService>) -> Self {
        Self {
            config_service,
            client_cache: RwLock::new(HashMap::new()),
            #[cfg(test)]
            account_test_endpoints: RwLock::new(HashMap::new()),
        }
    }

    /// Replace only external model IO in factory-backed integration fixtures.
    /// Credential resolution, revision checks and request guards remain real.
    #[cfg(test)]
    pub(crate) fn set_account_test_endpoint(&self, account: &str, endpoint: &str) {
        assert!(endpoint.starts_with("http://127.0.0.1:"));
        self.account_test_endpoints
            .write()
            .unwrap()
            .insert(account.into(), endpoint.into());
    }

    #[cfg(test)]
    pub(crate) fn apply_account_test_endpoint(&self, account: &str, client: &mut AIClient) {
        if let Some(endpoint) = self.account_test_endpoints.read().unwrap().get(account) {
            client.config.base_url = endpoint.clone();
            client.config.request_url = endpoint.clone();
        }
    }

    #[cfg(test)]
    pub(crate) fn new_for_test(config_service: Arc<ConfigService>) -> Self {
        Self::new(config_service)
    }

    pub async fn get_client_by_id(&self, model_id: &str) -> Result<Arc<AIClient>> {
        self.get_or_create_client(model_id, None).await
    }

    /// Resolve the fixed model configured for Git commit-message generation.
    pub async fn get_git_commit_task_client(&self) -> Result<Arc<AIClient>> {
        let global_config: crate::service::config::GlobalConfig =
            self.config_service.get_config(None).await?;
        let model_id = global_config
            .ai
            .task_models
            .git_commit
            .fixed_model_id()
            .ok_or_else(|| anyhow!("Git commit task model cannot inherit a session model"))?;
        self.get_client_resolved(model_id).await
    }

    /// Resolves an immutable concrete model id only when its current runtime
    /// identity still matches the user-approved binding.
    pub async fn get_client_by_approved_binding(
        &self,
        model_id: &str,
        configuration_fingerprint: &str,
    ) -> Result<Arc<AIClient>> {
        self.get_or_create_client(model_id, Some(configuration_fingerprint))
            .await
    }

    /// Resolve an approved base client and apply one session preset without
    /// inserting the derived client into the factory cache.
    pub async fn get_client_by_approved_binding_with_reasoning_preset(
        &self,
        model_id: &str,
        configuration_fingerprint: &str,
        reasoning_preset: Option<&str>,
    ) -> Result<Arc<AIClient>> {
        let client = self
            .get_client_by_approved_binding(model_id, configuration_fingerprint)
            .await?;
        self.apply_session_reasoning_preset(model_id, client, reasoning_preset)
            .await
    }

    /// Get a client (supports resolving primary/fast)
    pub async fn get_client_resolved(&self, model_id: &str) -> Result<Arc<AIClient>> {
        let resolved_model_id = self.resolve_model_id(model_id).await?;
        self.get_or_create_client(&resolved_model_id, None).await
    }

    /// Resolve a base client and apply one session preset without caching the
    /// derived client. An unknown preset fails closed to the model default.
    pub async fn get_client_resolved_with_reasoning_preset(
        &self,
        model_id: &str,
        reasoning_preset: Option<&str>,
    ) -> Result<Arc<AIClient>> {
        let resolved_model_id = self.resolve_model_id(model_id).await?;
        let client = self.get_or_create_client(&resolved_model_id, None).await?;
        self.apply_session_reasoning_preset(&resolved_model_id, client, reasoning_preset)
            .await
    }

    async fn resolve_model_id(&self, model_id: &str) -> Result<String> {
        let ai_config = self.config_service.get_effective_ai_config().await?;
        resolve_required_model_selector(
            model_id,
            |selector| ai_config.resolve_model_selection(selector),
            |model_ref| ai_config.resolve_model_reference(model_ref),
        )
        .map_err(|error| anyhow!(error.to_string()))
    }

    pub(crate) async fn apply_session_reasoning_preset(
        &self,
        model_id: &str,
        client: Arc<AIClient>,
        reasoning_preset: Option<&str>,
    ) -> Result<Arc<AIClient>> {
        let Some(reasoning_preset) = reasoning_preset
            .map(str::trim)
            .filter(|preset| !preset.is_empty())
        else {
            return Ok(client);
        };
        let ai_config = self.config_service.get_effective_ai_config().await?;
        let model = ai_config
            .models
            .iter()
            .find(|model| model.id == model_id)
            .ok_or_else(|| anyhow!("Model configuration not found: {}", model_id))?;
        let models_dev = load_models_dev_reasoning_catalog().await;
        let projection = project_model_reasoning_catalog(model, models_dev.catalog.as_deref());
        let Some(client) = apply_selected_reasoning_preset(&client, &projection, reasoning_preset)
        else {
            warn!(
                "Session reasoning preset is not available for the resolved model; falling back to model default: model_id={}, preset_id={}",
                model_id, reasoning_preset
            );
            return Ok(client);
        };

        Ok(Arc::new(client))
    }

    pub fn invalidate_cache(&self) {
        let mut cache = match self.client_cache.write() {
            Ok(cache) => cache,
            Err(poisoned) => {
                warn!("AI client cache write lock poisoned during invalidate_cache, recovering");
                poisoned.into_inner()
            }
        };
        let count = cache.len();
        cache.clear();
        info!("AI client cache cleared (removed {} clients)", count);
    }

    pub fn get_cache_size(&self) -> usize {
        let cache = match self.client_cache.read() {
            Ok(cache) => cache,
            Err(poisoned) => {
                warn!("AI client cache read lock poisoned during get_cache_size, recovering");
                poisoned.into_inner()
            }
        };
        cache.len()
    }

    pub fn invalidate_model(&self, model_id: &str) {
        let mut cache = match self.client_cache.write() {
            Ok(cache) => cache,
            Err(poisoned) => {
                warn!("AI client cache write lock poisoned during invalidate_model, recovering");
                poisoned.into_inner()
            }
        };
        let before = cache.len();
        cache.retain(|(id, _), _| id != model_id);
        if cache.len() != before {
            debug!("Client cache cleared for model: {}", model_id);
        }
    }

    async fn get_or_create_client(
        &self,
        model_id: &str,
        expected_configuration_fingerprint: Option<&str>,
    ) -> Result<Arc<AIClient>> {
        self.get_or_create_client_with_account(model_id, expected_configuration_fingerprint, None)
            .await
    }

    pub(crate) async fn get_client_for_account(
        &self,
        model_id: &str,
        fingerprint: &str,
        account_id: &str,
    ) -> Result<Arc<AIClient>> {
        self.get_or_create_client_with_account(model_id, Some(fingerprint), Some(account_id))
            .await
    }

    #[cfg(feature = "subscription-auth")]
    pub(crate) fn account_client_revision(
        &self,
        model_id: &str,
        account_id: &str,
        client: &Arc<AIClient>,
    ) -> Result<u64> {
        let cache = self
            .client_cache
            .read()
            .unwrap_or_else(|error| error.into_inner());
        cache
            .get(&(model_id.to_string(), Some(account_id.to_string())))
            .filter(|entry| Arc::ptr_eq(&entry.client, client))
            .and_then(|entry| entry.credential_revision)
            .ok_or_else(|| {
                anyhow!("Account credentials changed while the request client was being resolved")
            })
    }

    pub(crate) async fn account_client_source(
        self: &Arc<Self>,
        model_id: &str,
        fingerprint: &str,
        reasoning_preset: Option<String>,
        template: &AIClient,
    ) -> Result<Option<Arc<dyn super::account_client_source::AccountClientSource>>> {
        self.account_client_source_with_probe(
            model_id,
            fingerprint,
            reasoning_preset,
            template,
            false,
        )
        .await
    }

    async fn account_client_source_with_probe(
        self: &Arc<Self>,
        model_id: &str,
        fingerprint: &str,
        reasoning_preset: Option<String>,
        template: &AIClient,
        probe_cooled: bool,
    ) -> Result<Option<Arc<dyn super::account_client_source::AccountClientSource>>> {
        use super::account_client_source::FactoryAccountClientSource;
        use openbitfun_agent_runtime::account_routing::AccountPolicy;
        let config = self.config_service.get_effective_ai_config().await?;
        let mut models = config.models.iter().filter(|model| model.id == model_id);
        let model = models
            .next()
            .ok_or_else(|| anyhow!("Model configuration not found: {model_id}"))?;
        if models.next().is_some() || model_runtime_binding_fingerprint(model) != fingerprint {
            return Err(anyhow!(
                "Model binding changed before account routing was prepared"
            ));
        }
        let policy = match &model.auth {
            AuthConfig::Subscription {
                provider,
                account_id,
                ..
            } => AccountPolicy::Fixed(account_id.clone().unwrap_or_else(|| provider.key().into())),
            AuthConfig::SubscriptionPool { accounts, .. } => {
                AccountPolicy::Ordered(accounts.clone())
            }
            _ => return Ok(None),
        };
        let data_dir = self.config_service.user_data_dir().await;
        Ok(Some(Arc::new(FactoryAccountClientSource::new(
            self.clone(),
            model_id.into(),
            fingerprint.into(),
            policy,
            model.auth.clone(),
            reasoning_preset,
            template,
            openbitfun_services_core::routing_state::RoutingStateStore::new(
                data_dir.join("subscription-routing"),
            ),
            crate::infrastructure::PathManager::native_path_digest(&data_dir),
            probe_cooled,
        ))))
    }

    /// Native initialization chooses an account before any account credential
    /// is required. The credential-free template is private to this method;
    /// only a resolved, account-stamped client may leave the routing branch.
    pub(crate) async fn prepare_native_model_client(
        self: &Arc<Self>,
        model_id: &str,
        fingerprint: &str,
        reasoning_preset: Option<&str>,
        lineage: Option<&str>,
        temperature: Option<f64>,
    ) -> Result<(
        Arc<AIClient>,
        Option<Arc<dyn super::account_client_source::AccountClientSource>>,
    )> {
        let prepared = self
            .prepare_native_model_candidate_or_probe(
                model_id,
                fingerprint,
                reasoning_preset,
                lineage,
                temperature,
            )
            .await?;
        Ok((prepared.client, prepared.account_source))
    }

    /// Cooldown is a preference. When every declared account is cooling, the
    /// soonest-recovering one is probed so the user sees the provider's real
    /// answer instead of a local refusal that only time can clear.
    async fn prepare_native_model_candidate_or_probe(
        self: &Arc<Self>,
        model_id: &str,
        fingerprint: &str,
        reasoning_preset: Option<&str>,
        lineage: Option<&str>,
        temperature: Option<f64>,
    ) -> Result<super::channel_client_source::PreparedChannel> {
        match self
            .prepare_native_model_candidate(
                model_id,
                fingerprint,
                reasoning_preset,
                lineage,
                temperature,
                None,
                false,
            )
            .await
        {
            Err(error)
                if error
                    .downcast_ref::<AccountPoolUnavailable>()
                    .is_some_and(|unavailable| unavailable.soonest_cooldown().is_some()) =>
            {
                self.prepare_native_model_candidate(
                    model_id,
                    fingerprint,
                    reasoning_preset,
                    lineage,
                    temperature,
                    None,
                    true,
                )
                .await
            }
            other => other,
        }
    }

    /// Carry the actual selected identity with its resolved client. Wrappers
    /// must not select again merely to recover the credential revision.
    pub(crate) async fn prepare_native_model_candidate(
        self: &Arc<Self>,
        model_id: &str,
        fingerprint: &str,
        reasoning_preset: Option<&str>,
        lineage: Option<&str>,
        temperature: Option<f64>,
        required: Option<&openbitfun_core_types::ModelAccountOrigin>,
        probe_cooled: bool,
    ) -> Result<super::channel_client_source::PreparedChannel> {
        let global: crate::service::config::GlobalConfig =
            self.config_service.get_config(None).await?;
        let model = self
            .configured_model(&global, model_id, Some(fingerprint))
            .await?;
        let account_routed = matches!(
            &model.auth,
            AuthConfig::Subscription {
                provider: crate::service::config::types::SubscriptionProvider::Codex,
                ..
            } | AuthConfig::Subscription {
                account_id: Some(_),
                ..
            } | AuthConfig::SubscriptionPool { .. }
        );
        if !account_routed {
            let client = self
                .get_client_by_approved_binding_with_reasoning_preset(
                    model_id,
                    fingerprint,
                    reasoning_preset,
                )
                .await?;
            let client = if let Some(temperature) = temperature {
                let mut derived = (*client).clone();
                derived.config.temperature = Some(temperature);
                Arc::new(derived)
            } else {
                client
            };
            if required.is_some() {
                return Err(anyhow!(
                    "This channel cannot supply the required subscription identity"
                ));
            }
            return Ok(super::channel_client_source::PreparedChannel {
                model_id: model_id.into(),
                client,
                account_source: None,
                origin: None,
                credential_revision: None,
            });
        }
        #[cfg(not(feature = "subscription-auth"))]
        {
            let _ = (lineage, required, probe_cooled);
            return Err(anyhow!(
                "Subscription authentication is not available in this product build"
            ));
        }
        #[cfg(feature = "subscription-auth")]
        {
            let mut config = AIConfig::try_from(model.clone())
                .map_err(|error| anyhow!("AI configuration conversion failed: {error}"))?;
            config.api_key.clear();
            config.custom_headers = None;
            let provider = match &model.auth {
                AuthConfig::Subscription { provider, .. }
                | AuthConfig::SubscriptionPool { provider, .. } => to_adapter_provider(*provider),
                _ => unreachable!("account routing requires subscription auth"),
            };
            subscription_auth::prepare_account_request_route(provider, &mut config)?;
            if let Some(temperature) = temperature {
                config.temperature = Some(temperature);
            }
            let models_dev = load_models_dev_reasoning_catalog().await;
            let projection = project_model_reasoning_catalog(&model, models_dev.catalog.as_deref());
            let template = apply_default_reasoning_preset(
                AIClient::new_with_runtime_options(
                    config,
                    global.ai.proxy.enabled.then_some(global.ai.proxy.clone()),
                    build_stream_options_for_model(&global.ai, Some(&model)),
                ),
                &projection,
            );
            let template = match reasoning_preset
                .map(str::trim)
                .filter(|preset| !preset.is_empty())
            {
                Some(preset) => apply_selected_reasoning_preset(&template, &projection, preset)
                    .unwrap_or(template),
                None => template,
            };
            let source = self
                .account_client_source_with_probe(
                    model_id,
                    fingerprint,
                    reasoning_preset.map(str::to_string),
                    &template,
                    probe_cooled,
                )
                .await?
                .ok_or_else(|| anyhow!("Native subscription account routing was not prepared"))?;
            let selected = source
                .resolve_for_request(&[], required, lineage)
                .await?
                .ok_or_else(|| {
                    anyhow!("No eligible subscription account for native model initialization")
                })?;
            Ok(super::channel_client_source::PreparedChannel {
                model_id: model_id.into(),
                client: selected.client,
                account_source: Some(source),
                origin: Some(selected.origin),
                credential_revision: Some(selected.credential_revision),
            })
        }
    }

    async fn configured_model(
        &self,
        global_config: &crate::service::config::GlobalConfig,
        model_id: &str,
        expected_configuration_fingerprint: Option<&str>,
    ) -> Result<AIModelConfig> {
        configured_model_in_service(
            &self.config_service,
            global_config,
            model_id,
            expected_configuration_fingerprint,
        )
        .await
    }

    async fn get_or_create_client_with_account(
        &self,
        model_id: &str,
        expected_configuration_fingerprint: Option<&str>,
        selected_account: Option<&str>,
    ) -> Result<Arc<AIClient>> {
        let global_config: crate::service::config::GlobalConfig =
            self.config_service.get_config(None).await?;
        let normalized_model_id = model_id.trim().to_string();
        if normalized_model_id.is_empty() {
            return Err(anyhow!("Model configuration id is empty"));
        }
        debug!("Creating new AI client: model_id={}", normalized_model_id);
        let model_config = self
            .configured_model(
                &global_config,
                &normalized_model_id,
                expected_configuration_fingerprint,
            )
            .await?;
        let configuration_fingerprint = model_runtime_binding_fingerprint(&model_config);

        let models_dev = load_models_dev_reasoning_catalog().await;
        let reasoning_projection =
            project_model_reasoning_catalog(&model_config, models_dev.catalog.as_deref());
        let default_reasoning_preset =
            resolve_default_reasoning_preset(&reasoning_projection).cloned();
        let effective_auth = if let Some(id) = selected_account {
            match &model_config.auth {
                AuthConfig::SubscriptionPool {
                    provider, accounts, ..
                } if accounts.iter().any(|member| member == id) => AuthConfig::Subscription {
                    provider: *provider,
                    plan: None,
                    account_id: Some(id.into()),
                },
                AuthConfig::Subscription {
                    provider,
                    plan,
                    account_id,
                } if account_id
                    .clone()
                    .unwrap_or_else(|| format!("{provider:?}").to_ascii_lowercase())
                    == id =>
                {
                    AuthConfig::Subscription {
                        provider: *provider,
                        plan: *plan,
                        account_id: Some(id.into()),
                    }
                }
                _ => {
                    return Err(anyhow!(
                        "Account is outside this model's declared subscription binding"
                    ))
                }
            }
        } else {
            resolve_account_pool_auth(
                &model_config.auth,
                &model_config.id,
                &model_config.model_name,
            )
            .await?
        };
        let account_key = match &effective_auth {
            AuthConfig::Subscription {
                provider,
                account_id,
                ..
            } => Some(
                account_id
                    .clone()
                    .unwrap_or_else(|| format!("{provider:?}").to_ascii_lowercase()),
            ),
            _ => None,
        };
        let cache_key = (normalized_model_id.clone(), account_key);

        #[cfg(feature = "subscription-auth")]
        let credential_revision = match &effective_auth {
            AuthConfig::Subscription {
                provider,
                account_id,
                ..
            } => {
                let provider = to_adapter_provider(*provider);
                Some(
                    subscription_auth::account_credential_revision(
                        provider,
                        account_id.as_deref().unwrap_or(provider.key()),
                    )
                    .await?,
                )
            }
            AuthConfig::ApiKey => None,
            AuthConfig::SubscriptionPool { .. } => {
                unreachable!("pool was resolved into an explicit account")
            }
        };

        {
            let cache = match self.client_cache.read() {
                Ok(cache) => cache,
                Err(poisoned) => {
                    warn!(
                        "AI client cache read lock poisoned during get_or_create_client, recovering"
                    );
                    poisoned.into_inner()
                }
            };
            if let Some(cached) = cache.get(&cache_key) {
                #[cfg(feature = "subscription-auth")]
                let account_unchanged = cached.credential_revision == credential_revision;
                #[cfg(not(feature = "subscription-auth"))]
                let account_unchanged = true;
                let static_key_unchanged = !matches!(&effective_auth, AuthConfig::ApiKey)
                    || cached.client.config.api_key == model_config.api_key;
                if account_unchanged
                    && static_key_unchanged
                    && cached.configuration_fingerprint == configuration_fingerprint
                    && cached.default_reasoning_preset == default_reasoning_preset
                    && !subscription_credential_stale(&effective_auth, cached)
                {
                    return Ok(cached.client.clone());
                }
            }
        }

        let mut ai_config = AIConfig::try_from(model_config.clone())
            .map_err(|e| anyhow!("AI configuration conversion failed: {}", e))?;
        let skip_ssl_verify = ai_config.skip_ssl_verify;
        let proxy_config = if global_config.ai.proxy.enabled {
            Some(global_config.ai.proxy.clone())
        } else {
            None
        };
        let credential_expires_at = apply_configured_auth(
            &effective_auth,
            &mut ai_config,
            proxy_config.clone(),
            skip_ssl_verify,
        )
        .await
        .map_err(|source| {
            if let AuthConfig::Subscription {
                account_id,
                provider,
                ..
            } = &effective_auth
            {
                anyhow::Error::new(AccountCredentialPreparationError {
                    account_id: account_id.clone().unwrap_or_else(|| provider.key().into()),
                    source,
                })
            } else {
                source
            }
        })?;
        #[cfg(not(feature = "subscription-auth"))]
        let _ = credential_expires_at;

        let stream_options = build_stream_options_for_model(&global_config.ai, Some(&model_config));
        let client = apply_default_reasoning_preset(
            apply_subscription_request_profile(
                &effective_auth,
                AIClient::new_with_runtime_options(ai_config, proxy_config, stream_options),
            ),
            &reasoning_projection,
        );
        #[cfg(feature = "subscription-auth")]
        let client = if let AuthConfig::Subscription {
            provider,
            account_id,
            ..
        } = &effective_auth
        {
            subscription_auth::bind_resolved_account_identity(
                client,
                to_adapter_provider(*provider),
                account_id.as_deref().unwrap_or(provider.key()),
            )
            .await?
        } else {
            client
        };
        let client = client.with_request_authorization(Arc::new(ApprovedModelRequest {
            config_service: self.config_service.clone(),
            model_id: model_config.id.clone(),
            fingerprint: configuration_fingerprint.clone(),
            static_key_digest: matches!(&model_config.auth, AuthConfig::ApiKey)
                .then(|| Sha256::digest(model_config.api_key.as_bytes()).into()),
        }));
        let client = Arc::new(client);

        {
            let mut cache = match self.client_cache.write() {
                Ok(cache) => cache,
                Err(poisoned) => {
                    warn!(
                        "AI client cache write lock poisoned during get_or_create_client, recovering"
                    );
                    poisoned.into_inner()
                }
            };
            cache.insert(
                cache_key,
                CachedAIClient {
                    configuration_fingerprint,
                    default_reasoning_preset,
                    client: client.clone(),
                    #[cfg(feature = "subscription-auth")]
                    credential_expires_at,
                    // Capture before resolution: a concurrent mutation or token
                    // rotation conservatively causes another rebuild, never a
                    // stale client stamped with a newer account's epoch.
                    #[cfg(feature = "subscription-auth")]
                    credential_revision,
                },
            );
        }

        debug!(
            "AI client created: model_id={}, name={}",
            model_config.id, model_config.name
        );

        Ok(client)
    }
}

static GLOBAL_AI_CLIENT_FACTORY: OnceLock<Arc<tokio::sync::RwLock<Option<Arc<AIClientFactory>>>>> =
    OnceLock::new();

impl AIClientFactory {
    /// Initialize the global AIClientFactory singleton
    pub async fn initialize_global() -> OpenBitFunResult<()> {
        if Self::is_global_initialized() {
            return Ok(());
        }

        info!("Initializing global AIClientFactory...");

        let config_service = get_global_config_service().await.map_err(|e| {
            OpenBitFunError::service(format!("Failed to get global config service: {}", e))
        })?;

        let factory = Arc::new(AIClientFactory::new(config_service));
        let wrapper = Arc::new(tokio::sync::RwLock::new(Some(factory)));

        GLOBAL_AI_CLIENT_FACTORY.set(wrapper).map_err(|_| {
            OpenBitFunError::service("Failed to initialize global AIClientFactory".to_string())
        })?;

        info!("Global AIClientFactory initialized");
        Ok(())
    }

    /// Get the global AIClientFactory instance
    pub async fn get_global() -> OpenBitFunResult<Arc<AIClientFactory>> {
        let wrapper = GLOBAL_AI_CLIENT_FACTORY.get().ok_or_else(|| {
            OpenBitFunError::service(
                "Global AIClientFactory not initialized. Call initialize_global() first."
                    .to_string(),
            )
        })?;

        let guard = wrapper.read().await;
        guard
            .as_ref()
            .ok_or_else(|| OpenBitFunError::service("Global AIClientFactory is None".to_string()))
            .map(Arc::clone)
    }

    pub fn is_global_initialized() -> bool {
        GLOBAL_AI_CLIENT_FACTORY.get().is_some()
    }

    /// Update the global AIClientFactory instance (used for config reload)
    pub async fn update_global(new_factory: Arc<AIClientFactory>) -> OpenBitFunResult<()> {
        let wrapper = GLOBAL_AI_CLIENT_FACTORY.get().ok_or_else(|| {
            OpenBitFunError::service("Global AIClientFactory not initialized".to_string())
        })?;

        {
            let mut guard = wrapper.write().await;
            *guard = Some(new_factory);
        }

        debug!("Global AIClientFactory updated");
        Ok(())
    }
}

pub async fn get_global_ai_client_factory() -> OpenBitFunResult<Arc<AIClientFactory>> {
    AIClientFactory::get_global().await
}

pub async fn initialize_global_ai_client_factory() -> OpenBitFunResult<()> {
    AIClientFactory::initialize_global().await
}

#[cfg(feature = "subscription-auth")]
fn to_adapter_provider(provider: SubscriptionProvider) -> AdapterProvider {
    match provider {
        SubscriptionProvider::Codex => AdapterProvider::Codex,
        SubscriptionProvider::Antigravity => AdapterProvider::Antigravity,
        SubscriptionProvider::Opencode => AdapterProvider::Opencode,
        SubscriptionProvider::Grok => AdapterProvider::Grok,
        SubscriptionProvider::Hermes => AdapterProvider::Hermes,
        SubscriptionProvider::Workbuddy => AdapterProvider::Workbuddy,
        SubscriptionProvider::WorkbuddyAi => AdapterProvider::WorkbuddyAi,
        SubscriptionProvider::Zcode => AdapterProvider::Zcode,
        SubscriptionProvider::ZcodeCn => AdapterProvider::ZcodeCn,
    }
}

/// Attach request policy from explicit auth identity after credential resolution.
pub fn apply_subscription_request_profile(auth: &AuthConfig, client: AIClient) -> AIClient {
    #[cfg(feature = "subscription-auth")]
    if let AuthConfig::Subscription {
        provider,
        account_id,
        ..
    } = auth
    {
        let provider = to_adapter_provider(*provider);
        return client
            .with_subscription_account(provider, account_id.as_deref().unwrap_or(provider.key()));
    }
    #[cfg(feature = "subscription-auth")]
    if let AuthConfig::SubscriptionPool { provider, .. } = auth {
        return client.with_subscription_provider(to_adapter_provider(*provider));
    }
    #[cfg(not(feature = "subscription-auth"))]
    let _ = auth;
    client
}

/// Initial ordered selection shared by native and auxiliary callers. The round
/// executor will own retries/affinity; this path never sends a quota request or
/// enlarges the declared account set.
pub(crate) async fn resolve_account_pool_auth(
    auth: &AuthConfig,
    model_id: &str,
    request_model: &str,
) -> Result<AuthConfig> {
    resolve_account_pool_auth_with_state(
        auth,
        model_id,
        request_model,
        None,
        None,
        &HashMap::new(),
        false,
    )
    .await
}

pub(crate) async fn resolve_account_pool_auth_with_state(
    auth: &AuthConfig,
    model_id: &str,
    request_model: &str,
    scope: Option<&openbitfun_agent_runtime::account_routing::RouteScope>,
    affinity: Option<&openbitfun_agent_runtime::account_routing::AccountAffinity>,
    cooldowns: &HashMap<String, openbitfun_services_core::routing_state::ResourceCooldown>,
    probe_cooled: bool,
) -> Result<AuthConfig> {
    let AuthConfig::SubscriptionPool {
        provider,
        accounts,
        revision,
    } = auth
    else {
        return Ok(auth.clone());
    };
    #[cfg(not(feature = "subscription-auth"))]
    {
        let _ = (
            provider,
            accounts,
            revision,
            model_id,
            request_model,
            scope,
            affinity,
            cooldowns,
            probe_cooled,
        );
        return Err(anyhow!(
            "Subscription account routing is not available in this product build"
        ));
    }
    #[cfg(feature = "subscription-auth")]
    {
        use openbitfun_agent_runtime::account_routing::{
            select_account, AccountCandidate, AccountPolicy, AccountSelection, RouteScope,
            UnknownQuotaPolicy,
        };
        if accounts.is_empty()
            || accounts
                .iter()
                .collect::<std::collections::HashSet<_>>()
                .len()
                != accounts.len()
        {
            return Err(anyhow!(
                "Subscription account pool must contain distinct account IDs"
            ));
        }
        let adapter_provider = to_adapter_provider(*provider);
        for id in accounts {
            subscription_auth::account_credential_revision(adapter_provider, id).await?;
        }
        let instances = subscription_auth::list_account_instances().await?;
        let mut observations = HashMap::new();
        for id in accounts {
            match subscription_auth::cached_account_quota(adapter_provider, id).await {
                Ok(snapshot) => { observations.insert(id.clone(), snapshot); }
                Err(_) => warn!("Subscription account quota cache is unavailable; using the pool's unknown-quota probe policy"),
            }
        }
        let mut candidates = Vec::new();
        for id in accounts {
            if let Some(instance) = instances.iter().find(|instance| &instance.account_id == id) {
                let credential_revision =
                    subscription_auth::account_credential_revision(adapter_provider, id).await?;
                candidates.push(AccountCandidate {
                    account_id: id,
                    provider: adapter_provider.key(),
                    request_model: subscription_auth::runtime_model_override(
                        adapter_provider,
                        request_model,
                    )
                    .unwrap_or(request_model),
                    credential_revision,
                    enabled: instance.enabled,
                    connected: instance.account.connected,
                    supports_model: true,
                    user_limit_exhausted: false,
                    cooldown_until: cooldowns
                        .get(id)
                        .filter(|cooldown| cooldown.revision == credential_revision)
                        .map(|cooldown| cooldown.until),
                    at_capacity: false,
                    quota: observations.get(id).map(|snapshot| {
                        subscription_auth::model_quota_observation(
                            snapshot,
                            subscription_auth::runtime_model_override(
                                adapter_provider,
                                request_model,
                            )
                            .unwrap_or(request_model),
                            chrono::Utc::now().timestamp(),
                        )
                    }),
                });
            }
        }
        // This initial lookup has no session affinity. Its placeholder scope is
        // never persisted or shared with request-scoped routing state.
        let initial_scope = RouteScope {
            execution_host: "initial-client-resolution".into(),
            provider: adapter_provider.key().into(),
            model_config_id: model_id.into(),
            policy_revision: *revision,
            cache_lineage: String::new(),
        };
        match select_account(
            &AccountPolicy::Ordered(accounts.clone()),
            scope.unwrap_or(&initial_scope),
            &candidates,
            affinity,
            UnknownQuotaPolicy::Probe,
            chrono::Utc::now().timestamp(),
        ) {
            AccountSelection::Selected { account_id, .. } => Ok(AuthConfig::Subscription {
                provider: *provider,
                plan: None,
                account_id: Some(account_id),
            }),
            AccountSelection::Unavailable(reasons) => {
                let unavailable = AccountPoolUnavailable { reasons };
                let probe = probe_cooled
                    .then(|| unavailable.soonest_cooldown())
                    .flatten()
                    .and_then(|soonest| {
                        unavailable.reasons.iter().find(|rejected| {
                            rejected.reason
                                == openbitfun_agent_runtime::account_routing::AccountRejection::Cooldown
                                && rejected.recovery_at == Some(soonest)
                        })
                    });
                match probe {
                    Some(rejected) => Ok(AuthConfig::Subscription {
                        provider: *provider,
                        plan: None,
                        account_id: Some(rejected.account_id.clone()),
                    }),
                    None => Err(anyhow::Error::new(unavailable)),
                }
            }
            AccountSelection::InvalidPolicy => {
                Err(anyhow!("Invalid subscription account pool policy"))
            }
        }
    }
}

/// Resolve a subscription `AuthConfig` and overlay it onto the runtime
/// `AIConfig`. No-op when `auth == AuthConfig::ApiKey`. Returns the resolved
/// credential's expiry (Unix seconds) so callers can invalidate cached
/// clients before the token goes stale.
pub async fn apply_subscription_auth(
    auth: &AuthConfig,
    ai_config: &mut AIConfig,
) -> Result<Option<i64>> {
    #[cfg(feature = "subscription-auth")]
    return apply_subscription_auth_with_options(
        auth,
        ai_config,
        &SubscriptionHttpOptions::default(),
    )
    .await;

    #[cfg(not(feature = "subscription-auth"))]
    {
        let _ = ai_config;
        match auth {
            AuthConfig::ApiKey => Ok(None),
            AuthConfig::Subscription { .. } | AuthConfig::SubscriptionPool { .. } => Err(anyhow!(
                "Subscription authentication is not available in this product build"
            )),
        }
    }
}

#[cfg(feature = "subscription-auth")]
async fn apply_configured_auth(
    auth: &AuthConfig,
    ai_config: &mut AIConfig,
    proxy_config: Option<openbitfun_core_types::ProxyConfig>,
    skip_ssl_verify: bool,
) -> Result<Option<i64>> {
    let options = SubscriptionHttpOptions::new(proxy_config, skip_ssl_verify);
    apply_subscription_auth_with_options(auth, ai_config, &options).await
}

#[cfg(not(feature = "subscription-auth"))]
async fn apply_configured_auth(
    auth: &AuthConfig,
    ai_config: &mut AIConfig,
    _proxy_config: Option<openbitfun_core_types::ProxyConfig>,
    _skip_ssl_verify: bool,
) -> Result<Option<i64>> {
    apply_subscription_auth(auth, ai_config).await
}

/// Resolves subscription authentication with an explicit transport policy.
#[cfg(feature = "subscription-auth")]
pub async fn apply_subscription_auth_with_options(
    auth: &AuthConfig,
    ai_config: &mut AIConfig,
    options: &SubscriptionHttpOptions,
) -> Result<Option<i64>> {
    let effective_auth = resolve_account_pool_auth(auth, &ai_config.name, &ai_config.model).await?;
    let resolved = match &effective_auth {
        AuthConfig::ApiKey => return Ok(None),
        AuthConfig::Subscription {
            provider,
            plan,
            account_id,
        } => {
            let adapter_provider = to_adapter_provider(*provider);
            if let Some(model) =
                subscription_auth::runtime_model_override(adapter_provider, &ai_config.model)
            {
                ai_config.model = model.to_string();
            }
            if let Some(account_id) = account_id {
                let plan = plan.map(|plan| match plan {
                    crate::service::config::types::OpenCodePlan::Zen => {
                        subscription_auth::OpenCodePlan::Zen
                    }
                    crate::service::config::types::OpenCodePlan::Go => {
                        subscription_auth::OpenCodePlan::Go
                    }
                });
                let resolved = subscription_auth::resolve_account_model_with_options(
                    adapter_provider,
                    account_id,
                    plan,
                    &ai_config.format,
                    &ai_config.model,
                    options,
                )
                .await?;
                return Ok(resolved.apply_to(ai_config));
            }
            let resolved = match (*provider, *plan) {
                (SubscriptionProvider::Opencode, plan) => {
                    if plan == Some(crate::service::config::types::OpenCodePlan::Go)
                        || ai_config.base_url.trim_end_matches('/')
                            == "https://opencode.ai/zen/go/v1"
                        || ai_config
                            .request_url
                            .starts_with("https://opencode.ai/zen/go/")
                    {
                        return Err(anyhow!(subscription_auth::OPENCODE_GO_REQUIRES_API_KEY));
                    }
                    subscription_auth::resolve_opencode_model_with_options(
                        Some(subscription_auth::OpenCodePlan::Zen),
                        &ai_config.format,
                        &ai_config.model,
                        options,
                    )
                    .await
                }
                (SubscriptionProvider::Grok, None) => {
                    subscription_auth::resolve_grok_with_options(&ai_config.model, options).await
                }
                (SubscriptionProvider::Hermes, None) => {
                    subscription_auth::resolve_hermes_with_options(&ai_config.model, options).await
                }
                (_, None) => {
                    subscription_auth::resolve_with_options(adapter_provider, options).await
                }
                (_, Some(plan)) => Err(anyhow!(
                    "OpenCode plan {plan:?} cannot be used with provider {provider:?}"
                )),
            };
            resolved.map_err(|e| {
                anyhow!(
                    "Failed to resolve {provider:?} subscription credential: {e:#}. \
                     Subscription logins must be available on the host running this model request."
                )
            })?
        }
        AuthConfig::SubscriptionPool { .. } => {
            unreachable!("pool was resolved into an explicit account")
        }
    };

    Ok(resolved.apply_to(ai_config))
}

/// List subscription accounts (Codex / Antigravity / xAI / Hermes).
#[cfg(feature = "subscription-auth")]
pub async fn list_subscription_accounts() -> Vec<subscription_auth::SubscriptionAccount> {
    subscription_auth::list_accounts().await
}

#[cfg(test)]
mod tests {
    use std::sync::Arc;

    use super::{apply_subscription_auth, AIClientFactory};
    use crate::infrastructure::PathManager;
    #[cfg(not(feature = "subscription-auth"))]
    use crate::service::config::types::SubscriptionProvider;
    use crate::service::config::types::{
        model_runtime_binding_fingerprint, AIModelConfig, AuthConfig, GlobalConfig,
    };
    use crate::service::config::{ConfigManagerSettings, ConfigService};
    use crate::util::types::AIConfig;
    use openbitfun_ai_adapters::{
        classify_model_selector, resolve_required_model_selector, ModelSelectorKind,
    };

    #[cfg(feature = "subscription-auth")]
    use super::SUBSCRIPTION_STORE_TEST_LOCK;

    #[cfg(feature = "subscription-auth")]
    struct PreparationProxy {
        url: String,
        requests: Arc<std::sync::Mutex<Vec<String>>>,
        stop: Arc<std::sync::atomic::AtomicBool>,
        thread: Option<std::thread::JoinHandle<()>>,
    }

    #[cfg(feature = "subscription-auth")]
    impl PreparationProxy {
        fn new(stall: bool) -> Self {
            use std::io::{BufRead, Write};
            use std::sync::atomic::{AtomicBool, Ordering};
            let listener = std::net::TcpListener::bind("127.0.0.1:0").unwrap();
            listener.set_nonblocking(true).unwrap();
            let url = format!("http://{}", listener.local_addr().unwrap());
            let requests = Arc::new(std::sync::Mutex::new(Vec::new()));
            let captured = requests.clone();
            let stop = Arc::new(AtomicBool::new(false));
            let stopped = stop.clone();
            let thread = std::thread::spawn(move || {
                while !stopped.load(Ordering::Relaxed) {
                    let mut socket = match listener.accept() {
                        Ok((socket, _)) => socket,
                        Err(error) if error.kind() == std::io::ErrorKind::WouldBlock => {
                            std::thread::sleep(std::time::Duration::from_millis(5));
                            continue;
                        }
                        Err(error) => panic!("accept preparation proxy connection: {error}"),
                    };
                    socket
                        .set_read_timeout(Some(std::time::Duration::from_secs(5)))
                        .unwrap();
                    let mut reader = std::io::BufReader::new(&mut socket);
                    let mut first = String::new();
                    if reader.read_line(&mut first).unwrap_or(0) == 0 {
                        continue;
                    }
                    loop {
                        let mut line = String::new();
                        if reader.read_line(&mut line).unwrap_or(0) == 0 || line == "\r\n" {
                            break;
                        }
                    }
                    captured.lock().unwrap().push(first.trim().to_string());
                    while stall && !stopped.load(Ordering::Relaxed) {
                        std::thread::sleep(std::time::Duration::from_millis(5));
                    }
                    let _ = socket.write_all(
                        b"HTTP/1.1 502 Fixture\r\nContent-Length: 0\r\nConnection: close\r\n\r\n",
                    );
                }
            });
            Self {
                url,
                requests,
                stop,
                thread: Some(thread),
            }
        }
    }

    #[cfg(feature = "subscription-auth")]
    impl Drop for PreparationProxy {
        fn drop(&mut self) {
            self.stop.store(true, std::sync::atomic::Ordering::Relaxed);
            if let Some(thread) = self.thread.take() {
                thread.join().unwrap();
            }
        }
    }

    #[cfg(feature = "subscription-auth")]
    async fn native_preparation_fixture(
        dir: &std::path::Path,
        proxy: &PreparationProxy,
    ) -> (Arc<AIClientFactory>, AIModelConfig, String) {
        use crate::infrastructure::subscription_auth::{self, store, StoredCredential};
        subscription_auth::set_store_path_for_test(dir.join("subscription.json"));
        let config = Arc::new(
            ConfigService::with_settings(ConfigManagerSettings {
                path_manager: Some(Arc::new(PathManager::with_user_root_for_tests(
                    dir.join("host"),
                ))),
                auto_save: true,
                backup_count: 0,
            })
            .await
            .unwrap(),
        );
        config
            .set_config(
                "ai.proxy",
                openbitfun_core_types::ProxyConfig {
                    enabled: true,
                    url: proxy.url.clone(),
                    ..Default::default()
                },
            )
            .await
            .unwrap();
        let backup = format!("codex-account-{}", uuid::Uuid::new_v4());
        for (id, seat, expires) in [
            (
                "codex",
                "primary-seat",
                chrono::Utc::now().timestamp_millis() - 1000,
            ),
            (
                backup.as_str(),
                "backup-seat",
                chrono::Utc::now().timestamp_millis() + 3_600_000,
            ),
        ] {
            store::upsert(
                id,
                StoredCredential::Oauth {
                    access: format!("synthetic-{seat}"),
                    refresh: format!("synthetic-refresh-{seat}"),
                    expires,
                    account_id: Some(seat.into()),
                    metadata: None,
                },
            )
            .await
            .unwrap();
        }
        let mut model = build_model("native-preparation", "Native preparation", "fixture-model");
        model.provider = "responses".into();
        model.base_url = "https://saved-route.invalid".into();
        model.api_key = "saved-key-must-not-be-used".into();
        model.auth = AuthConfig::SubscriptionPool {
            provider: super::SubscriptionProvider::Codex,
            accounts: vec!["codex".into(), backup.clone()],
            revision: 1,
        };
        config
            .install_runtime_ai_model(model.clone())
            .await
            .unwrap();
        (Arc::new(AIClientFactory::new(config)), model, backup)
    }

    #[cfg(feature = "subscription-auth")]
    #[tokio::test]
    async fn native_preparation_survives_primary_refresh_failure_without_weakening_fixed_or_replay_binding(
    ) {
        let _guard = SUBSCRIPTION_STORE_TEST_LOCK.lock().await;
        let dir = tempfile::tempdir().unwrap();
        let proxy = PreparationProxy::new(false);
        let (factory, model, backup) = native_preparation_fixture(dir.path(), &proxy).await;
        let fingerprint = model_runtime_binding_fingerprint(&model);
        let (client, source) = factory
            .prepare_native_model_client(
                &model.id,
                &fingerprint,
                None,
                Some("native-lineage"),
                Some(0.25),
            )
            .await
            .unwrap();
        assert_eq!(client.config.api_key, "synthetic-backup-seat");
        assert_eq!(
            client
                .subscription_account_origin(&backup)
                .unwrap()
                .upstream_account_id
                .as_deref(),
            Some("backup-seat")
        );
        assert_eq!(client.config.temperature, Some(0.25));
        assert_eq!(client.config.format, "responses");
        assert!(!client.config.request_url.contains("saved-route.invalid"));
        assert_eq!(
            factory.get_cache_size(),
            1,
            "a private unresolved template cannot enter the client cache"
        );
        let preparations = proxy.requests.lock().unwrap().len();
        assert!(preparations > 0);
        assert!(proxy
            .requests
            .lock()
            .unwrap()
            .iter()
            .all(|request| request.starts_with("CONNECT auth.openai.com:")));
        let source = source.unwrap();
        assert_eq!(
            source
                .resolve_for_request(&[], None, Some("native-lineage"))
                .await
                .unwrap()
                .unwrap()
                .origin
                .account_id,
            backup
        );
        assert_eq!(
            proxy.requests.lock().unwrap().len(),
            preparations,
            "the prepared account is reused within this request scope"
        );
        let mut changed = model.clone();
        changed.model_name = "changed-wire".into();
        factory
            .config_service
            .install_runtime_ai_model(changed)
            .await
            .unwrap();
        assert!(source
            .resolve_for_request(&[], None, Some("native-lineage"))
            .await
            .err()
            .unwrap()
            .to_string()
            .contains("binding changed"));
        assert_eq!(
            proxy.requests.lock().unwrap().len(),
            preparations,
            "configuration drift cannot be treated as another account credential failure"
        );
        factory
            .config_service
            .install_runtime_ai_model(model.clone())
            .await
            .unwrap();
        assert!(
            !factory
                .config_service
                .user_data_dir()
                .await
                .join("subscription-routing/affinity")
                .exists(),
            "preparation alone cannot claim successful persistent affinity"
        );
        assert!(factory
            .prepare_native_model_client(
                &model.id,
                "stale-binding",
                None,
                Some("native-lineage"),
                None
            )
            .await
            .is_err());
        assert_eq!(proxy.requests.lock().unwrap().len(), preparations);
        let pinned = openbitfun_core_types::ModelAccountOrigin {
            provider: "codex".into(),
            account_id: "codex".into(),
            upstream_account_id: Some("primary-seat".into()),
        };
        assert!(source
            .resolve_for_request(&[], Some(&pinned), Some("native-lineage"))
            .await
            .is_err());

        let mut fixed = model.clone();
        fixed.id = "native-fixed".into();
        fixed.auth = AuthConfig::Subscription {
            provider: super::SubscriptionProvider::Codex,
            plan: None,
            account_id: None,
        };
        let fixed_fingerprint = model_runtime_binding_fingerprint(&fixed);
        factory
            .config_service
            .install_runtime_ai_model(fixed.clone())
            .await
            .unwrap();
        let error = factory
            .prepare_native_model_client(
                &fixed.id,
                &fixed_fingerprint,
                None,
                Some("native-lineage"),
                None,
            )
            .await
            .err()
            .unwrap();
        assert!(error.is::<super::AccountCredentialPreparationError>());
        assert_eq!(factory.get_cache_size(), 1);

        let mut ordinary = model;
        ordinary.id = "native-api-key".into();
        ordinary.auth = AuthConfig::ApiKey;
        let ordinary_fingerprint = model_runtime_binding_fingerprint(&ordinary);
        factory
            .config_service
            .install_runtime_ai_model(ordinary.clone())
            .await
            .unwrap();
        let before = proxy.requests.lock().unwrap().len();
        let (client, source) = factory
            .prepare_native_model_client(&ordinary.id, &ordinary_fingerprint, None, None, None)
            .await
            .unwrap();
        assert!(source.is_none());
        assert_eq!(client.config.api_key, "saved-key-must-not-be-used");
        assert!(client.subscription_provider_key().is_none());
        assert_eq!(proxy.requests.lock().unwrap().len(), before);
    }

    #[cfg(feature = "subscription-auth")]
    #[tokio::test]
    async fn cancelling_native_preparation_cannot_advance_to_a_backup_client() {
        use crate::infrastructure::subscription_auth::{
            self, SubscriptionHttpOptions, SubscriptionProvider,
        };
        let _guard = SUBSCRIPTION_STORE_TEST_LOCK.lock().await;
        let dir = tempfile::tempdir().unwrap();
        let proxy = PreparationProxy::new(true);
        let (factory, model, _) = native_preparation_fixture(dir.path(), &proxy).await;
        let fingerprint = model_runtime_binding_fingerprint(&model);
        let (cancel, cancelled) = tokio::sync::oneshot::channel::<()>();
        let waiter = {
            let factory = factory.clone();
            tokio::spawn(async move {
                tokio::select! { biased; _ = cancelled => None,
                result = factory.prepare_native_model_client(&model.id,&fingerprint,None,Some("cancelled-lineage"),None) => Some(result), }
            })
        };
        tokio::time::timeout(std::time::Duration::from_secs(5), async {
            while proxy.requests.lock().unwrap().is_empty() {
                tokio::task::yield_now().await;
            }
        })
        .await
        .unwrap();
        cancel.send(()).unwrap();
        assert!(
            tokio::time::timeout(std::time::Duration::from_secs(5), waiter)
                .await
                .unwrap()
                .unwrap()
                .is_none()
        );
        let closed_proxy_url = proxy.url.clone();
        drop(proxy);
        // Drain an already-owned OAuth operation through its existing account
        // lease before another test changes the process-wide store override.
        let options = SubscriptionHttpOptions::new(
            Some(openbitfun_core_types::ProxyConfig {
                enabled: true,
                url: closed_proxy_url,
                ..Default::default()
            }),
            false,
        );
        assert!(tokio::time::timeout(
            std::time::Duration::from_secs(5),
            subscription_auth::refresh_account_instance_with_options(
                SubscriptionProvider::Codex,
                "codex",
                &options
            )
        )
        .await
        .unwrap()
        .is_err());
        assert_eq!(
            factory.get_cache_size(),
            0,
            "cancellation cannot authorize preparing a backup or cache an unresolved template"
        );
    }

    fn build_model(id: &str, name: &str, model_name: &str) -> AIModelConfig {
        AIModelConfig {
            id: id.to_string(),
            name: name.to_string(),
            model_name: model_name.to_string(),
            provider: "anthropic".to_string(),
            enabled: true,
            ..Default::default()
        }
    }

    fn test_runtime_ai_config() -> AIConfig {
        AIConfig {
            name: "test".to_string(),
            base_url: "https://example.test".to_string(),
            request_url: String::new(),
            api_key: "unchanged".to_string(),
            model: "test-model".to_string(),
            format: "openai".to_string(),
            context_window: 4096,
            max_tokens: None,
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

    #[tokio::test]
    async fn static_key_rotation_invalidates_the_cached_client_without_reapproving_the_model() {
        let dir = tempfile::tempdir().unwrap();
        let config = Arc::new(
            ConfigService::with_settings(ConfigManagerSettings {
                path_manager: Some(Arc::new(PathManager::with_user_root_for_tests(
                    dir.path().join("host"),
                ))),
                auto_save: false,
                backup_count: 0,
            })
            .await
            .unwrap(),
        );
        let mut model = AIModelConfig {
            id: "key-rotation".into(),
            name: "Key rotation".into(),
            provider: "openai".into(),
            model_name: "model".into(),
            enabled: true,
            base_url: "https://fixture.invalid".into(),
            api_key: "synthetic-old".into(),
            ..Default::default()
        };
        config
            .install_runtime_ai_model(model.clone())
            .await
            .unwrap();
        let factory = AIClientFactory::new_for_test(config.clone());
        let fingerprint = model_runtime_binding_fingerprint(&model);
        let old = factory
            .get_client_by_approved_binding(&model.id, &fingerprint)
            .await
            .unwrap();
        model.api_key = "synthetic-new".into();
        assert_eq!(model_runtime_binding_fingerprint(&model), fingerprint);
        config
            .install_runtime_ai_model(model.clone())
            .await
            .unwrap();
        let new = factory
            .get_client_by_approved_binding(&model.id, &fingerprint)
            .await
            .unwrap();
        assert_eq!(old.config.api_key, "synthetic-old");
        assert_eq!(new.config.api_key, "synthetic-new");
        assert!(!Arc::ptr_eq(&old, &new));
        assert_ne!(
            old.channel_replay_fingerprint(),
            new.channel_replay_fingerprint()
        );
    }

    #[tokio::test]
    async fn prepared_key_client_cannot_send_after_live_key_disable_or_binding_changes() {
        for change in ["key", "disable", "endpoint"] {
            let dir = tempfile::tempdir().unwrap();
            let config = Arc::new(
                ConfigService::with_settings(ConfigManagerSettings {
                    path_manager: Some(Arc::new(PathManager::with_user_root_for_tests(
                        dir.path().join("host"),
                    ))),
                    auto_save: false,
                    backup_count: 0,
                })
                .await
                .unwrap(),
            );
            let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
            let url = format!("http://{}/chat/completions", listener.local_addr().unwrap());
            let mut model = AIModelConfig {
                id: "live-guard".into(),
                name: "Live guard".into(),
                provider: "openai".into(),
                model_name: "fixture".into(),
                enabled: true,
                base_url: url.clone(),
                request_url: Some(url),
                api_key: "synthetic-original".into(),
                ..Default::default()
            };
            config
                .install_runtime_ai_model(model.clone())
                .await
                .unwrap();
            let factory = AIClientFactory::new_for_test(config.clone());
            let client = factory
                .get_client_by_approved_binding(
                    &model.id,
                    &model_runtime_binding_fingerprint(&model),
                )
                .await
                .unwrap();
            match change {
                "key" => model.api_key = "synthetic-replacement".into(),
                "disable" => model.enabled = false,
                _ => model.base_url = "https://changed.invalid".into(),
            }
            config.install_runtime_ai_model(model).await.unwrap();
            let result = tokio::time::timeout(
                std::time::Duration::from_secs(1),
                client.send_message_stream_once(
                    vec![openbitfun_core_types::Message::user("Continue".into())],
                    None,
                    None,
                ),
            )
            .await
            .expect("live guard must reject without waiting for a provider response");
            let error = result.err().expect("a stale prepared client must not send");
            let detail = error
                .downcast_ref::<openbitfun_core_types::errors::AiProviderError>()
                .unwrap();
            assert_eq!(
                detail.category,
                openbitfun_core_types::errors::ErrorCategory::InvalidRequest
            );
            assert!(
                detail.provider.is_none() && detail.http_status.is_none(),
                "local config rejection must not look like provider failure"
            );
            assert!(
                tokio::time::timeout(std::time::Duration::from_millis(20), listener.accept())
                    .await
                    .is_err(),
                "no provider connection may open after revocation"
            );
        }
    }

    #[tokio::test]
    #[cfg(feature = "subscription-auth")]
    async fn legacy_go_oauth_round_trips_and_returns_api_key_error() {
        for payload in [
            serde_json::json!({"type": "subscription", "provider": "opencode", "plan": "go"}),
            serde_json::json!({"type": "subscription", "provider": "opencode"}),
        ] {
            let auth: AuthConfig = serde_json::from_value(payload).unwrap();
            let round_trip: AuthConfig =
                serde_json::from_value(serde_json::to_value(&auth).unwrap()).unwrap();
            assert_eq!(auth, round_trip);
            let mut config = test_runtime_ai_config();
            config.base_url = "https://opencode.ai/zen/go/v1".to_string();
            let error = apply_subscription_auth(&auth, &mut config)
                .await
                .unwrap_err();
            assert_eq!(
                error.to_string(),
                super::subscription_auth::OPENCODE_GO_REQUIRES_API_KEY
            );
            assert_eq!(config.api_key, "unchanged");
            assert_eq!(config.base_url, "https://opencode.ai/zen/go/v1");
        }
    }

    #[tokio::test]
    async fn runtime_model_is_available_to_ai_client_factory() {
        let dir = tempfile::tempdir().expect("temporary config directory");
        let config = Arc::new(
            ConfigService::with_settings(ConfigManagerSettings {
                path_manager: Some(Arc::new(PathManager::with_user_root_for_tests(
                    dir.path().join("runtime-client"),
                ))),
                auto_save: true,
                backup_count: 0,
            })
            .await
            .expect("test ConfigService"),
        );
        let mut model = build_model("sdk:openai:fixture", "SDK fixture", "fixture-model");
        model.provider = "openai".to_string();
        model.base_url = "http://127.0.0.1:43123/v1".to_string();
        model.api_key = "fixture-secret".to_string();
        config.install_runtime_ai_model(model).await.unwrap();

        AIClientFactory::new(config)
            .get_client_by_id("sdk:openai:fixture")
            .await
            .expect("runtime model should resolve through the AI client factory");
    }

    #[tokio::test]
    async fn unsupported_account_guard_rejects_primary_without_selecting_another_model() {
        use openbitfun_config_contracts::protected_account_models::{
            protect_account_models, ACCOUNT_MODEL_GUARD_KEY,
        };
        let dir = tempfile::tempdir().unwrap();
        let config = Arc::new(
            ConfigService::with_settings(ConfigManagerSettings {
                path_manager: Some(Arc::new(PathManager::with_user_root_for_tests(
                    dir.path().join("guard-client"),
                ))),
                auto_save: true,
                backup_count: 0,
            })
            .await
            .unwrap(),
        );
        let mut protected = build_model("guarded", "Guarded", "fixture-model");
        protected.auth = AuthConfig::Subscription {
            provider: crate::service::config::types::SubscriptionProvider::Codex,
            plan: None,
            account_id: Some("codex-account-58134808-15a6-45db-ae33-2ad7d85cc570".into()),
        };
        let mut value = serde_json::json!({"ai":{"models":[protected]}});
        protect_account_models(&mut value);
        value["ai"]["models"][0]["metadata"][ACCOUNT_MODEL_GUARD_KEY]["version"] =
            serde_json::json!(99);
        let protected: AIModelConfig =
            serde_json::from_value(value["ai"]["models"][0].clone()).unwrap();
        config
            .set_config(
                "ai.models",
                vec![
                    protected,
                    build_model("legacy-other", "Other", "fixture-model"),
                ],
            )
            .await
            .unwrap();
        config
            .set_config("ai.default_models.primary", "guarded")
            .await
            .unwrap();
        let error = AIClientFactory::new(config)
            .get_client_resolved("primary")
            .await
            .unwrap_err();
        assert!(
            error.to_string().contains("account-capable OpenBitFun"),
            "{error}"
        );
    }

    #[cfg(feature = "subscription-auth")]
    #[tokio::test]
    async fn subscription_cache_rebuilds_after_account_changes_and_rejects_logout() {
        let _test_guard = SUBSCRIPTION_STORE_TEST_LOCK.lock().await;
        use crate::infrastructure::subscription_auth::{self, store, StoredCredential};
        let dir = tempfile::tempdir().unwrap();
        subscription_auth::set_store_path_for_test(dir.path().join("subscription.json"));
        let config = Arc::new(
            ConfigService::with_settings(ConfigManagerSettings {
                path_manager: Some(Arc::new(PathManager::with_user_root_for_tests(
                    dir.path().join("config"),
                ))),
                auto_save: true,
                backup_count: 0,
            })
            .await
            .unwrap(),
        );
        let mut model = build_model("subscription:fixture", "Codex", "fixture-model");
        model.provider = "openai".into();
        model.base_url = "https://chatgpt.com/backend-api/codex".into();
        model.auth = AuthConfig::Subscription {
            provider: super::SubscriptionProvider::Codex,
            plan: None,
            account_id: None,
        };
        config
            .install_runtime_ai_model(model.clone())
            .await
            .unwrap();
        let slot = format!("codex-account-{}", uuid::Uuid::new_v4());
        let mut fixed_model = model;
        fixed_model.id = "subscription:fixed".into();
        fixed_model.auth = AuthConfig::Subscription {
            provider: super::SubscriptionProvider::Codex,
            plan: None,
            account_id: Some(slot.clone()),
        };
        config.install_runtime_ai_model(fixed_model).await.unwrap();
        let factory = Arc::new(AIClientFactory::new(config));
        store::upsert(
            &slot,
            StoredCredential::Oauth {
                access: "fixed-synthetic-key".into(),
                refresh: "fixed-refresh".into(),
                expires: chrono::Utc::now().timestamp_millis() + 3_600_000,
                account_id: Some("fixed-seat".into()),
                metadata: None,
            },
        )
        .await
        .unwrap();
        let fixed = factory
            .get_client_by_id("subscription:fixed")
            .await
            .unwrap();
        assert_eq!(fixed.config.api_key, "fixed-synthetic-key");
        assert_eq!(
            fixed.config.custom_headers.as_ref().unwrap()["ChatGPT-Account-ID"],
            "fixed-seat"
        );
        store::upsert(
            "codex",
            StoredCredential::Oauth {
                access: "first-synthetic-key".into(),
                refresh: "synthetic-refresh".into(),
                expires: chrono::Utc::now().timestamp_millis() + 3_600_000,
                account_id: Some("synthetic-account".into()),
                metadata: None,
            },
        )
        .await
        .unwrap();
        let first = factory
            .get_client_by_id("subscription:fixture")
            .await
            .unwrap();
        assert_eq!(first.subscription_provider_key(), Some("codex"));
        assert!(Arc::ptr_eq(
            &first,
            &factory
                .get_client_by_id("subscription:fixture")
                .await
                .unwrap()
        ));
        // A different process would advance the same on-disk provider epoch.
        store::upsert(
            "codex",
            StoredCredential::Oauth {
                access: "replacement-synthetic-key".into(),
                refresh: "synthetic-refresh".into(),
                expires: chrono::Utc::now().timestamp_millis() + 3_600_000,
                account_id: Some("synthetic-account".into()),
                metadata: None,
            },
        )
        .await
        .unwrap();
        let replacement = factory
            .get_client_by_id("subscription:fixture")
            .await
            .unwrap();
        assert!(!Arc::ptr_eq(&first, &replacement));
        assert_eq!(replacement.config.api_key, "replacement-synthetic-key");
        assert!(Arc::ptr_eq(
            &fixed,
            &factory
                .get_client_by_id("subscription:fixed")
                .await
                .unwrap()
        ));
        subscription_auth::logout(subscription_auth::SubscriptionProvider::Codex)
            .await
            .unwrap();
        assert!(factory
            .get_client_by_id("subscription:fixture")
            .await
            .is_err());
        assert!(Arc::ptr_eq(
            &fixed,
            &factory
                .get_client_by_id("subscription:fixed")
                .await
                .unwrap()
        ));
        store::upsert(
            &slot,
            StoredCredential::Oauth {
                access: "fixed-refreshed-key".into(),
                refresh: "fixed-refresh".into(),
                expires: chrono::Utc::now().timestamp_millis() + 3_600_000,
                account_id: Some("fixed-seat".into()),
                metadata: None,
            },
        )
        .await
        .unwrap();
        let renewed = factory
            .get_client_by_id("subscription:fixed")
            .await
            .unwrap();
        assert!(!Arc::ptr_eq(&fixed, &renewed));
        assert_eq!(renewed.config.api_key, "fixed-refreshed-key");
        let mut pool = build_model("subscription:pool", "Codex pool", "fixture-model");
        pool.provider = "responses".into();
        pool.auth = AuthConfig::SubscriptionPool {
            provider: super::SubscriptionProvider::Codex,
            accounts: vec!["codex".into(), slot.clone()],
            revision: 1,
        };
        let pool_fingerprint = super::model_runtime_binding_fingerprint(&pool);
        factory
            .config_service
            .install_runtime_ai_model(pool)
            .await
            .unwrap();
        let baseline_cache_size = factory.get_cache_size();
        let backup = factory.get_client_by_id("subscription:pool").await.unwrap();
        assert_eq!(backup.config.api_key, "fixed-refreshed-key");
        assert_eq!(
            backup.config.custom_headers.as_ref().unwrap()["ChatGPT-Account-ID"],
            "fixed-seat"
        );
        assert_eq!(factory.get_cache_size(), baseline_cache_size + 1);
        store::upsert(
            "codex",
            StoredCredential::Oauth {
                access: "restored-primary-key".into(),
                refresh: "synthetic-refresh".into(),
                expires: chrono::Utc::now().timestamp_millis() + 3_600_000,
                account_id: Some("primary-seat".into()),
                metadata: None,
            },
        )
        .await
        .unwrap();
        let primary = factory.get_client_by_id("subscription:pool").await.unwrap();
        assert_eq!(primary.config.api_key, "restored-primary-key");
        assert_eq!(
            primary.config.custom_headers.as_ref().unwrap()["ChatGPT-Account-ID"],
            "primary-seat"
        );
        assert!(!Arc::ptr_eq(&backup, &primary));
        assert_eq!(factory.get_cache_size(), baseline_cache_size + 2);
        subscription_auth::set_account_instance_enabled(
            subscription_auth::SubscriptionProvider::Codex,
            "codex",
            false,
        )
        .await
        .unwrap();
        let disabled_backup = factory.get_client_by_id("subscription:pool").await.unwrap();
        assert!(Arc::ptr_eq(&backup, &disabled_backup));
        assert!(factory
            .get_client_by_id("subscription:fixture")
            .await
            .err()
            .unwrap()
            .to_string()
            .contains("disabled"));
        subscription_auth::set_account_instance_enabled(
            subscription_auth::SubscriptionProvider::Codex,
            "codex",
            true,
        )
        .await
        .unwrap();
        let reenabled_primary = factory.get_client_by_id("subscription:pool").await.unwrap();
        assert_eq!(reenabled_primary.config.api_key, "restored-primary-key");
        assert!(!Arc::ptr_eq(&primary, &reenabled_primary));
        let observed = chrono::Utc::now().timestamp();
        let revision = subscription_auth::account_credential_revision(
            subscription_auth::SubscriptionProvider::Codex,
            "codex",
        )
        .await
        .unwrap();
        let mut quota_record = serde_json::json!({
            "version":1,"accounts":{"codex":{
                "account_id":"codex","provider":"codex","credential_revision":revision,
                "state":"known","observed_at":observed,"valid_until":observed+60,
                "allowed":false,"windows":[],"details":{"version":1,"valid_until":observed+60}
            }}
        });
        tokio::fs::write(
            dir.path().join("subscription.quotas.json"),
            serde_json::to_vec(&quota_record).unwrap(),
        )
        .await
        .unwrap();
        let quota_backup = factory.get_client_by_id("subscription:pool").await.unwrap();
        assert!(Arc::ptr_eq(&backup, &quota_backup));
        quota_record["accounts"]["codex"]["has_credits"] = serde_json::json!(true);
        tokio::fs::write(
            dir.path().join("subscription.quotas.json"),
            serde_json::to_vec(&quota_record).unwrap(),
        )
        .await
        .unwrap();
        let funded_primary = factory.get_client_by_id("subscription:pool").await.unwrap();
        assert!(Arc::ptr_eq(&reenabled_primary, &funded_primary));
        quota_record["accounts"]["codex"]["details"]["models"] = serde_json::json!([{
            "model":"fixture-model", "available":false, "credits_would_enable":false
        }]);
        tokio::fs::write(
            dir.path().join("subscription.quotas.json"),
            serde_json::to_vec(&quota_record).unwrap(),
        )
        .await
        .unwrap();
        let model_blocked = factory.get_client_by_id("subscription:pool").await.unwrap();
        assert!(Arc::ptr_eq(&backup, &model_blocked));
        let source = factory
            .account_client_source(
                "subscription:pool",
                &pool_fingerprint,
                None,
                &funded_primary,
            )
            .await
            .unwrap()
            .unwrap();
        assert_eq!(
            source
                .resolve(&[], None)
                .await
                .unwrap()
                .unwrap()
                .origin
                .account_id,
            slot
        );
        quota_record["accounts"]["codex"]["details"]["models"][0]["model"] =
            serde_json::json!("another-wire-model");
        tokio::fs::write(
            dir.path().join("subscription.quotas.json"),
            serde_json::to_vec(&quota_record).unwrap(),
        )
        .await
        .unwrap();
        assert!(Arc::ptr_eq(
            &funded_primary,
            &factory.get_client_by_id("subscription:pool").await.unwrap()
        ));
        quota_record["accounts"]["codex"]["has_credits"] = serde_json::json!(false);
        tokio::fs::write(
            dir.path().join("subscription.quotas.json"),
            serde_json::to_vec(&quota_record).unwrap(),
        )
        .await
        .unwrap();
        let mut template = (*quota_backup).clone();
        template.config.temperature = Some(0.25);
        let route = factory
            .account_client_source("subscription:pool", &pool_fingerprint, None, &template)
            .await
            .unwrap()
            .unwrap();
        let routed = route.resolve(&[], None).await.unwrap().unwrap();
        assert_eq!(routed.origin.account_id, slot);
        assert_eq!(
            routed.origin.upstream_account_id.as_deref(),
            Some("fixed-seat")
        );
        assert_eq!(routed.client.config.api_key, "fixed-refreshed-key");
        assert_eq!(routed.client.config.temperature, Some(0.25));
        let ordinary_client =
            crate::infrastructure::ai::AIClient::new(routed.client.config.clone());
        assert!(route
            .recover_authentication(&routed.origin, &ordinary_client)
            .await
            .err()
            .unwrap()
            .to_string()
            .contains("matching subscription account identity"));
        let foreign = openbitfun_core_types::ModelAccountOrigin {
            upstream_account_id: Some("another-seat".into()),
            ..routed.origin.clone()
        };
        assert!(route.resolve(&[], Some(&foreign)).await.is_err());
        assert!(factory
            .account_client_source("subscription:pool", "changed-fingerprint", None, &template)
            .await
            .is_err());
        let changed_reasoning: openbitfun_core_types::ReasoningPresetDescriptor =
            serde_json::from_value(serde_json::json!({
                "id":"medium", "label":"Medium", "order":10,
                "actions":[{"type":"effort","value":"medium"}], "source":"models_dev"
            }))
            .unwrap();
        let changed_template = template.with_reasoning_preset(&changed_reasoning);
        let changed_route = factory
            .account_client_source(
                "subscription:pool",
                &pool_fingerprint,
                None,
                &changed_template,
            )
            .await
            .unwrap()
            .unwrap();
        assert!(changed_route
            .resolve(&[], None)
            .await
            .err()
            .unwrap()
            .to_string()
            .contains("reasoning contract changed"));
        factory.invalidate_model("subscription:pool");
        assert_eq!(factory.get_cache_size(), baseline_cache_size);
        subscription_auth::logout_account(subscription_auth::SubscriptionProvider::Codex, &slot)
            .await
            .unwrap();
        assert!(
            route.resolve(&[], Some(&routed.origin)).await.is_err(),
            "an existing route must reject logout instead of reusing cached credentials"
        );
        assert!(
            route
                .recover_authentication(&routed.origin, routed.client.as_ref())
                .await
                .is_err(),
            "authentication recovery must not revive a logged-out slot"
        );
        assert!(factory
            .get_client_by_id("subscription:fixed")
            .await
            .is_err());
        assert!(factory
            .get_client_by_id("subscription:pool")
            .await
            .unwrap_err()
            .to_string()
            .contains("No subscription account in this model's pool is available"));
    }

    #[cfg(feature = "subscription-auth")]
    #[tokio::test]
    async fn durable_account_routing_restores_lineage_affinity_and_epoch_scoped_cooldowns() {
        use crate::infrastructure::subscription_auth::{self, store, StoredCredential};
        let _test_guard = SUBSCRIPTION_STORE_TEST_LOCK.lock().await;
        let dir = tempfile::tempdir().unwrap();
        subscription_auth::set_store_path_for_test(dir.path().join("subscription.json"));
        let config = Arc::new(
            ConfigService::with_settings(ConfigManagerSettings {
                path_manager: Some(Arc::new(PathManager::with_user_root_for_tests(
                    dir.path().join("host-profile"),
                ))),
                auto_save: true,
                backup_count: 0,
            })
            .await
            .unwrap(),
        );
        let backup_id = format!("codex-account-{}", uuid::Uuid::new_v4());
        for (id, seat) in [
            ("codex", "primary-seat"),
            (backup_id.as_str(), "backup-seat"),
        ] {
            store::upsert(
                id,
                StoredCredential::Oauth {
                    access: format!("synthetic-{seat}"),
                    refresh: format!("synthetic-refresh-{seat}"),
                    expires: chrono::Utc::now().timestamp_millis() + 3_600_000,
                    account_id: Some(seat.into()),
                    metadata: None,
                },
            )
            .await
            .unwrap();
        }
        let mut model = build_model("routing-model", "Routing", "fixture-model");
        model.provider = "responses".into();
        model.base_url = "https://chatgpt.com/backend-api/codex".into();
        model.auth = AuthConfig::SubscriptionPool {
            provider: super::SubscriptionProvider::Codex,
            accounts: vec!["codex".into(), backup_id.clone()],
            revision: 1,
        };
        let fingerprint = model_runtime_binding_fingerprint(&model);
        config
            .install_runtime_ai_model(model.clone())
            .await
            .unwrap();
        let factory = Arc::new(AIClientFactory::new(config.clone()));
        let template = factory.get_client_by_id("routing-model").await.unwrap();
        let route = factory
            .account_client_source("routing-model", &fingerprint, None, &template)
            .await
            .unwrap()
            .unwrap();
        let primary = route
            .resolve_for_request(&[], None, Some("lineage-a"))
            .await
            .unwrap()
            .unwrap();
        assert_eq!(primary.origin.account_id, "codex");
        let backup = route
            .resolve_for_request(&["codex".into()], None, Some("lineage-a"))
            .await
            .unwrap()
            .unwrap();
        route
            .completed(
                &backup.origin,
                backup.credential_revision,
                Some("lineage-a"),
            )
            .await
            .unwrap();

        let restarted = Arc::new(AIClientFactory::new(config.clone()));
        let restored = restarted
            .account_client_source("routing-model", &fingerprint, None, &template)
            .await
            .unwrap()
            .unwrap();
        assert_eq!(
            restored
                .resolve_for_request(&[], None, Some("lineage-a"))
                .await
                .unwrap()
                .unwrap()
                .origin
                .account_id,
            backup_id
        );
        assert_eq!(
            restored
                .resolve_for_request(&[], None, Some("lineage-b"))
                .await
                .unwrap()
                .unwrap()
                .origin
                .account_id,
            "codex"
        );
        assert_eq!(
            restored
                .resolve_for_request(&[], Some(&primary.origin), Some("lineage-a"))
                .await
                .unwrap()
                .unwrap()
                .origin,
            primary.origin
        );

        // A policy revision changes the affinity scope even with identical members.
        let mut changed = model.clone();
        if let AuthConfig::SubscriptionPool { revision, .. } = &mut changed.auth {
            *revision = 2;
        }
        let changed_fingerprint = model_runtime_binding_fingerprint(&changed);
        config.install_runtime_ai_model(changed).await.unwrap();
        assert!(route
            .revalidate_for_retry(&primary.origin)
            .await
            .err()
            .unwrap()
            .to_string()
            .contains("binding changed"));
        let changed_route = restarted
            .account_client_source("routing-model", &changed_fingerprint, None, &template)
            .await
            .unwrap()
            .unwrap();
        assert_eq!(
            changed_route
                .resolve_for_request(&[], None, Some("lineage-a"))
                .await
                .unwrap()
                .unwrap()
                .origin
                .account_id,
            "codex"
        );
        config.install_runtime_ai_model(model).await.unwrap();

        let until = chrono::Utc::now().timestamp() + 600;
        route
            .failed(&backup.origin, backup.credential_revision, until)
            .await
            .unwrap();
        assert_eq!(
            restored
                .resolve_for_request(&[], None, Some("lineage-a"))
                .await
                .unwrap()
                .unwrap()
                .origin
                .account_id,
            "codex"
        );
        route
            .failed(&primary.origin, primary.credential_revision, until)
            .await
            .unwrap();
        assert!(restored
            .resolve_for_request(&[], None, Some("lineage-a"))
            .await
            .err()
            .unwrap()
            .to_string()
            .contains("No subscription account"));
        // Once every declared seat is cooling, the probe source selects the
        // soonest recovery instead of refusing; exclusions still hold.
        route
            .failed(&primary.origin, primary.credential_revision, until + 300)
            .await
            .unwrap();
        let probing = restarted
            .account_client_source_with_probe("routing-model", &fingerprint, None, &template, true)
            .await
            .unwrap()
            .unwrap();
        let probed = probing
            .resolve_for_request(&[], None, None)
            .await
            .unwrap()
            .unwrap();
        assert_eq!(probed.origin.account_id, backup.origin.account_id);
        assert_eq!(
            probing
                .resolve_for_request(&[backup.origin.account_id.clone()], None, None)
                .await
                .unwrap()
                .unwrap()
                .origin
                .account_id,
            "codex"
        );

        // A retry within the admitted round checks live authority, not the
        // preference cooldown that this very round just wrote.
        let retry = restored
            .revalidate_for_retry(&primary.origin)
            .await
            .unwrap()
            .unwrap();
        assert_eq!(retry.origin, primary.origin);
        assert_eq!(retry.credential_revision, primary.credential_revision);
        let foreign_seat = openbitfun_core_types::ModelAccountOrigin {
            upstream_account_id: Some("foreign-seat".into()),
            ..primary.origin.clone()
        };
        assert!(restored.revalidate_for_retry(&foreign_seat).await.is_err());

        // A late failure refers to the old request epoch, never today's login.
        store::upsert(
            "codex",
            StoredCredential::Oauth {
                access: "synthetic-new-login".into(),
                refresh: "synthetic-new-refresh".into(),
                expires: chrono::Utc::now().timestamp_millis() + 3_600_000,
                account_id: Some("primary-seat".into()),
                metadata: None,
            },
        )
        .await
        .unwrap();
        route
            .failed(&primary.origin, primary.credential_revision, until + 1000)
            .await
            .unwrap();
        let renewed = restored
            .resolve_for_request(&[], None, Some("lineage-a"))
            .await
            .unwrap()
            .unwrap();
        assert_eq!(renewed.origin.account_id, "codex");
        assert!(renewed.credential_revision > primary.credential_revision);
        assert_eq!(renewed.client.config.api_key, "synthetic-new-login");
        let refreshed_retry = restored
            .revalidate_for_retry(&primary.origin)
            .await
            .unwrap()
            .unwrap();
        assert_eq!(refreshed_retry.client.config.api_key, "synthetic-new-login");
        assert_eq!(refreshed_retry.origin, primary.origin);
        assert!(config
            .user_data_dir()
            .await
            .join("subscription-routing")
            .is_dir());
        let routing_dir = config.user_data_dir().await.join("subscription-routing");
        let mut entries = tokio::fs::read_dir(routing_dir.join("affinity"))
            .await
            .unwrap();
        let mut affinity_file = None;
        while let Some(entry) = entries.next_entry().await.unwrap() {
            if entry
                .path()
                .extension()
                .is_some_and(|extension| extension == "json")
            {
                affinity_file = Some(entry.path());
            }
        }
        let affinity_file = affinity_file.unwrap();
        route
            .completed(
                &primary.origin,
                primary.credential_revision,
                Some("lineage-a"),
            )
            .await
            .unwrap();
        let binding: serde_json::Value =
            serde_json::from_slice(&tokio::fs::read(&affinity_file).await.unwrap()).unwrap();
        assert_eq!(
            binding["binding"]["resource_key"], backup_id,
            "a stale completion must not replace the current affinity"
        );
        let future = b"{\"version\":99,\"binding\":{\"resource_key\":\"codex\",\"revision\":0}}";
        tokio::fs::write(&affinity_file, future).await.unwrap();
        let selected = restored
            .resolve_for_request(&[], None, Some("lineage-a"))
            .await
            .unwrap()
            .unwrap();
        assert_eq!(selected.origin.account_id, "codex");
        assert_eq!(restored.take_routing_warnings(), ["affinity_unavailable"]);
        assert!(
            restored.take_routing_warnings().is_empty(),
            "observations are drained per attempt"
        );
        // A preference read failure must not authorize crossing required replay identity.
        let pinned = restored
            .resolve_for_request(&[], Some(&renewed.origin), Some("lineage-a"))
            .await
            .unwrap()
            .unwrap();
        assert_eq!(pinned.origin, renewed.origin);
        assert_eq!(tokio::fs::read(&affinity_file).await.unwrap(), future);
        assert_eq!(
            restored
                .resolve_for_request(&[], None, Some("lineage-b"))
                .await
                .unwrap()
                .unwrap()
                .origin
                .account_id,
            "codex"
        );
        subscription_auth::set_account_instance_enabled(
            subscription_auth::SubscriptionProvider::Codex,
            "codex",
            false,
        )
        .await
        .unwrap();
        assert!(restored
            .revalidate_for_retry(&renewed.origin)
            .await
            .is_err());
    }

    #[cfg(feature = "subscription-auth")]
    #[tokio::test]
    async fn api_key_auth_remains_a_noop_when_subscription_support_is_compiled() {
        let mut config = test_runtime_ai_config();

        let expires_at = apply_subscription_auth(&AuthConfig::ApiKey, &mut config)
            .await
            .expect("API-key auth");

        assert_eq!(expires_at, None);
        assert_eq!(config.api_key, "unchanged");
        assert_eq!(config.base_url, "https://example.test");
        let client = super::apply_subscription_request_profile(
            &AuthConfig::ApiKey,
            super::AIClient::new(config),
        );
        assert_eq!(client.subscription_provider_key(), None);
    }

    #[cfg(not(feature = "subscription-auth"))]
    #[tokio::test]
    async fn subscription_auth_fails_closed_when_not_compiled() {
        let auth = AuthConfig::Subscription {
            provider: SubscriptionProvider::Codex,
            plan: None,
            account_id: None,
        };
        let mut config = test_runtime_ai_config();

        let error = apply_subscription_auth(&auth, &mut config)
            .await
            .expect_err("subscription auth must not degrade to an API-key client");

        assert!(error
            .to_string()
            .contains("Subscription authentication is not available"));
        assert_eq!(config.api_key, "unchanged");
    }

    #[test]
    fn resolve_model_reference_requires_a_config_id() {
        let mut config = GlobalConfig::default();
        config.ai.models = vec![build_model(
            "model-123",
            "Primary Chat",
            "claude-sonnet-4.5",
        )];

        assert_eq!(
            config.ai.resolve_model_reference("model-123"),
            Some("model-123".to_string())
        );
        assert_eq!(config.ai.resolve_model_reference("Primary Chat"), None);
        assert_eq!(config.ai.resolve_model_reference("claude-sonnet-4.5"), None);

        config.ai.models.push(build_model(
            "model-123",
            "Duplicate Config",
            "claude-sonnet-4.5-duplicate",
        ));
        assert_eq!(config.ai.resolve_model_reference("model-123"), None);
    }

    #[test]
    fn concrete_reserved_model_ids_remain_exact_config_references() {
        let mut config = GlobalConfig::default();
        config.ai.models = ["inherit", "primary", "fast", "default"]
            .into_iter()
            .map(|id| build_model(id, id, &format!("runtime-{id}")))
            .collect();

        for id in ["inherit", "primary", "fast", "default"] {
            assert_eq!(
                config.ai.resolve_model_reference(id),
                Some(id.to_string()),
                "approved concrete ids must bypass selector classification"
            );
        }
    }

    #[test]
    fn runtime_binding_fingerprint_tracks_identity_but_not_secret_rotation() {
        let mut model = build_model("model-123", "Provider", "runtime-model");
        model.base_url = "https://models.example/v1".to_string();
        model.api_key = "secret-one".to_string();
        let first = model_runtime_binding_fingerprint(&model);

        model.api_key = "secret-two".to_string();
        assert_eq!(model_runtime_binding_fingerprint(&model), first);

        model.base_url = "https://models.example/v2".to_string();
        assert_ne!(model_runtime_binding_fingerprint(&model), first);
    }

    #[test]
    fn default_and_empty_selectors_normalize_to_primary_for_client_lookup() {
        assert_eq!(
            classify_model_selector(" default "),
            ModelSelectorKind::Primary
        );
        assert_eq!(classify_model_selector(""), ModelSelectorKind::Primary);
        assert_eq!(
            classify_model_selector("model-primary"),
            ModelSelectorKind::Explicit("model-primary".to_string())
        );
    }

    #[test]
    fn resolve_fast_selection_falls_back_to_primary_when_fast_missing() {
        let mut config = GlobalConfig::default();
        config.ai.models = vec![build_model(
            "model-primary",
            "Primary Chat",
            "claude-sonnet-4.5",
        )];
        config.ai.default_models.primary = Some("model-primary".to_string());

        assert_eq!(
            resolve_required_model_selector(
                "fast",
                |selector| config.ai.resolve_model_selection(selector),
                |model_ref| config.ai.resolve_model_reference(model_ref),
            )
            .expect("fast should fall back to primary"),
            "model-primary"
        );
    }

    #[test]
    fn resolve_fast_selection_falls_back_to_primary_when_fast_is_stale() {
        let mut config = GlobalConfig::default();
        config.ai.models = vec![build_model(
            "model-primary",
            "Primary Chat",
            "claude-sonnet-4.5",
        )];
        config.ai.default_models.primary = Some("model-primary".to_string());
        config.ai.default_models.fast = Some("deleted-fast-model".to_string());

        assert_eq!(
            resolve_required_model_selector(
                "fast",
                |selector| config.ai.resolve_model_selection(selector),
                |model_ref| config.ai.resolve_model_reference(model_ref),
            )
            .expect("stale fast should fall back to primary"),
            "model-primary"
        );
    }
}
