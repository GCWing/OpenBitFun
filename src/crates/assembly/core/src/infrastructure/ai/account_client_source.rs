//! Request-scoped account resolution. Provider IO stays in the existing factory;
//! the round executor owns attempts, cancellation and the commit boundary.

use super::{
    client_factory::resolve_account_pool_auth_with_state,
    reasoning_catalog::reasoning_preset_runtime_fingerprint, AIClient, AIClientFactory,
};
use crate::service::config::types::AuthConfig;
use anyhow::{anyhow, Result};
use openbitfun_agent_runtime::account_routing::{AccountAffinity, AccountPolicy, RouteScope};
use openbitfun_core_types::{ModelAccountOrigin, ModelResponseReplayItem};
use openbitfun_services_core::routing_state::{
    ResourceBinding, ResourceCooldown, RoutingStateStore,
};
use std::{
    fmt,
    future::Future,
    pin::Pin,
    sync::{Arc, Mutex},
};

pub(crate) struct AccountClient {
    pub client: Arc<AIClient>,
    pub origin: ModelAccountOrigin,
    pub credential_revision: u64,
}

pub(crate) type AccountClientFuture<'a> =
    Pin<Box<dyn Future<Output = Result<Option<AccountClient>>> + Send + 'a>>;
pub(crate) type AccountRoutingEffect<'a> = Pin<Box<dyn Future<Output = Result<()>> + Send + 'a>>;

pub(crate) trait AccountClientSource: fmt::Debug + Send + Sync {
    fn policy(&self) -> &AccountPolicy;
    /// Drain nonfatal preference-read observations into the next actual attempt.
    /// Codes contain no filesystem paths, credentials or raw storage errors.
    fn take_routing_warnings(&self) -> Vec<String> {
        Vec::new()
    }
    fn policy_revision(&self) -> Option<u64> {
        None
    }
    /// Frozen model configuration identity, independent of the selected seat.
    fn channel_binding_fingerprint(&self) -> Option<&str> {
        None
    }
    fn resolve<'a>(
        &'a self,
        excluded: &'a [String],
        required: Option<&'a ModelAccountOrigin>,
    ) -> AccountClientFuture<'a>;
    fn resolve_for_request<'a>(
        &'a self,
        excluded: &'a [String],
        required: Option<&'a ModelAccountOrigin>,
        _lineage: Option<&'a str>,
    ) -> AccountClientFuture<'a> {
        self.resolve(excluded, required)
    }
    /// Recheck the live authority of an already selected attempt, without
    /// treating this round's own failure cooldown as a new selection decision.
    fn revalidate_for_retry<'a>(
        &'a self,
        origin: &'a ModelAccountOrigin,
    ) -> AccountClientFuture<'a> {
        self.resolve(&[], Some(origin))
    }
    fn recover_authentication<'a>(
        &'a self,
        _origin: &'a ModelAccountOrigin,
        _rejected: &'a AIClient,
    ) -> AccountClientFuture<'a> {
        Box::pin(async { Ok(None) })
    }
    fn accepted(&self, _origin: &ModelAccountOrigin) {}
    fn completed<'a>(
        &'a self,
        origin: &'a ModelAccountOrigin,
        _revision: u64,
        _lineage: Option<&'a str>,
    ) -> AccountRoutingEffect<'a> {
        Box::pin(async move {
            self.accepted(origin);
            Ok(())
        })
    }
    fn failed<'a>(
        &'a self,
        _origin: &'a ModelAccountOrigin,
        _revision: u64,
        _until: i64,
    ) -> AccountRoutingEffect<'a> {
        Box::pin(async { Ok(()) })
    }
}

/// Opaque replay binds requests to the account that produced it. Unproven
/// historical replay must never authorize moving to a different account.
pub(crate) fn opaque_replay_origin(
    messages: &[openbitfun_core_types::Message],
) -> Result<Option<ModelAccountOrigin>> {
    let mut origin = None;
    for message in messages {
        let replay = message.model_response_replay.as_ref();
        let opaque = replay.is_some_and(|replay| {
            replay
                .items
                .iter()
                .any(|item| matches!(item, ModelResponseReplayItem::OpaqueReasoning { .. }))
        });
        if !opaque && message.thinking_signature.is_none() {
            continue;
        }
        let account = replay.and_then(|replay| replay.account_origin.as_ref()).ok_or_else(|| anyhow!("Signed or opaque model replay has no account provenance; automatic account routing is unavailable for this history"))?;
        if account
            .upstream_account_id
            .as_deref()
            .is_none_or(|identity| identity.trim().is_empty())
        {
            return Err(anyhow!("Opaque model replay has no upstream account identity; automatic account routing is unavailable for this history"));
        }
        if origin.as_ref().is_some_and(|existing| existing != account) {
            return Err(anyhow!(
                "Opaque model replay contains incompatible account origins"
            ));
        }
        origin = Some(account.clone());
    }
    Ok(origin)
}

pub(crate) struct FactoryAccountClientSource {
    factory: Arc<AIClientFactory>,
    model_id: String,
    provider: crate::service::config::types::SubscriptionProvider,
    request_model: String,
    fingerprint: String,
    policy: AccountPolicy,
    auth: AuthConfig,
    reasoning_preset: Option<String>,
    temperature: Option<f64>,
    reasoning_fingerprint: String,
    routing_state: RoutingStateStore,
    health_scope: String,
    host_scope: String,
    prepared_affinity: Mutex<Option<AccountAffinity>>,
    routing_warnings: Mutex<Vec<String>>,
    /// Set only after every declared candidate was found cooling: the source
    /// may then select a cooling account as a probe instead of refusing.
    probe_cooled: bool,
}

impl fmt::Debug for FactoryAccountClientSource {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        formatter
            .debug_struct("FactoryAccountClientSource")
            .field("model_id", &self.model_id)
            .field("policy", &self.policy)
            .finish_non_exhaustive()
    }
}

impl FactoryAccountClientSource {
    fn note_routing_warning(&self, code: &str) {
        let mut warnings = self
            .routing_warnings
            .lock()
            .unwrap_or_else(|error| error.into_inner());
        if !warnings.iter().any(|warning| warning == code) {
            warnings.push(code.into());
        }
    }

    pub(crate) fn new(
        factory: Arc<AIClientFactory>,
        model_id: String,
        fingerprint: String,
        policy: AccountPolicy,
        auth: AuthConfig,
        reasoning_preset: Option<String>,
        template: &AIClient,
        routing_state: RoutingStateStore,
        host_scope: String,
        probe_cooled: bool,
    ) -> Self {
        let provider = match &auth {
            AuthConfig::Subscription { provider, .. }
            | AuthConfig::SubscriptionPool { provider, .. } => *provider,
            _ => unreachable!("account source requires subscription auth"),
        };
        Self {
            factory,
            model_id,
            provider,
            request_model: template.config.model.clone(),
            fingerprint,
            policy,
            auth,
            reasoning_preset,
            temperature: template.config.temperature,
            reasoning_fingerprint: reasoning_preset_runtime_fingerprint(
                template
                    .selected_reasoning_preset()
                    .or_else(|| template.model_reasoning_preset()),
            ),
            routing_state,
            health_scope: serde_json::to_string(&(
                provider.key(),
                &template.config.model,
                &template.config.base_url,
            ))
            .expect("string tuple serializes"),
            host_scope,
            prepared_affinity: Mutex::new(None),
            routing_warnings: Mutex::new(Vec::new()),
            probe_cooled,
        }
    }

    fn route_scope(&self, lineage: &str) -> RouteScope {
        RouteScope {
            execution_host: self.host_scope.clone(),
            provider: self.provider.key().into(),
            model_config_id: self.model_id.clone(),
            policy_revision: self.policy_revision().unwrap_or(0),
            cache_lineage: lineage.into(),
        }
    }

    fn affinity_key(&self, lineage: &str) -> String {
        serde_json::to_string(&(
            &self.host_scope,
            &self.model_id,
            &self.fingerprint,
            self.policy_revision(),
            lineage,
        ))
        .expect("string tuple serializes")
    }

    fn validate_origin(&self, origin: &ModelAccountOrigin) -> Result<()> {
        let member = match &self.policy {
            AccountPolicy::Fixed(id) => *id == origin.account_id,
            AccountPolicy::Ordered(ids) => ids.contains(&origin.account_id),
        };
        if origin.provider != self.provider.key() || !member {
            return Err(anyhow!(
                "Account routing feedback is outside the declared model binding"
            ));
        }
        Ok(())
    }
    async fn client_for_account(
        &self,
        account_id: &str,
        required: Option<&ModelAccountOrigin>,
    ) -> Result<AccountClient> {
        let client = self
            .factory
            .get_client_for_account(&self.model_id, &self.fingerprint, account_id)
            .await?;
        #[cfg(feature = "subscription-auth")]
        let credential_revision =
            self.factory
                .account_client_revision(&self.model_id, &account_id, &client)?;
        #[cfg(not(feature = "subscription-auth"))]
        let credential_revision = 0;
        let client = self
            .factory
            .apply_session_reasoning_preset(
                &self.model_id,
                client,
                self.reasoning_preset.as_deref(),
            )
            .await?;
        let reasoning_fingerprint = reasoning_preset_runtime_fingerprint(
            client
                .selected_reasoning_preset()
                .or_else(|| client.model_reasoning_preset()),
        );
        if reasoning_fingerprint != self.reasoning_fingerprint {
            return Err(anyhow!(
                "Model reasoning contract changed during account resolution"
            ));
        }
        let mut client = (*client).clone();
        client.config.temperature = self.temperature;
        #[cfg(test)]
        self.factory
            .apply_account_test_endpoint(account_id, &mut client);
        let origin = client
            .subscription_account_origin(&account_id)
            .ok_or_else(|| anyhow!("Resolved client has no subscription account identity"))?;
        if required.is_some_and(|required| required != &origin) {
            return Err(anyhow!("Selected account cannot replay this model history"));
        }
        Ok(AccountClient {
            client: Arc::new(client),
            origin,
            credential_revision,
        })
    }
}

impl AccountClientSource for FactoryAccountClientSource {
    fn channel_binding_fingerprint(&self) -> Option<&str> {
        Some(&self.fingerprint)
    }
    fn take_routing_warnings(&self) -> Vec<String> {
        std::mem::take(
            &mut *self
                .routing_warnings
                .lock()
                .unwrap_or_else(|error| error.into_inner()),
        )
    }

    fn policy_revision(&self) -> Option<u64> {
        match &self.auth {
            AuthConfig::SubscriptionPool { revision, .. } => Some(*revision),
            _ => None,
        }
    }
    fn policy(&self) -> &AccountPolicy {
        &self.policy
    }

    fn revalidate_for_retry<'a>(
        &'a self,
        origin: &'a ModelAccountOrigin,
    ) -> AccountClientFuture<'a> {
        Box::pin(async move {
            self.validate_origin(origin)?;
            self.client_for_account(&origin.account_id, Some(origin))
                .await
                .map(Some)
        })
    }

    fn recover_authentication<'a>(
        &'a self,
        origin: &'a ModelAccountOrigin,
        rejected: &'a AIClient,
    ) -> AccountClientFuture<'a> {
        Box::pin(async move {
            #[cfg(feature = "subscription-auth")]
            {
                self.factory
                    .recover_account_authentication(
                        &self.model_id,
                        &self.fingerprint,
                        origin,
                        rejected,
                    )
                    .await?;
                self.revalidate_for_retry(origin).await
            }
            #[cfg(not(feature = "subscription-auth"))]
            {
                let _ = (origin, rejected);
                Ok(None)
            }
        })
    }

    fn resolve<'a>(
        &'a self,
        excluded: &'a [String],
        required: Option<&'a ModelAccountOrigin>,
    ) -> AccountClientFuture<'a> {
        self.resolve_for_request(excluded, required, None)
    }

    fn resolve_for_request<'a>(
        &'a self,
        excluded: &'a [String],
        required: Option<&'a ModelAccountOrigin>,
        lineage: Option<&'a str>,
    ) -> AccountClientFuture<'a> {
        Box::pin(async move {
            let mut excluded = excluded.to_vec();
            let mut preparation_failure = None;
            loop {
                let mut auth = self.auth.clone();
                if let AuthConfig::SubscriptionPool { accounts, .. } = &mut auth {
                    accounts.retain(|id| {
                        !excluded.contains(id)
                            && required.is_none_or(|origin| {
                                origin.provider == self.provider.key() && origin.account_id == *id
                            })
                    });
                    if accounts.is_empty() {
                        return match preparation_failure {
                            Some(error) => Err(error),
                            None => Ok(None),
                        };
                    }
                }
                let scope = lineage
                    .filter(|lineage| !lineage.is_empty())
                    .filter(|_| matches!(self.policy, AccountPolicy::Ordered(_)))
                    .map(|lineage| self.route_scope(lineage));
                let persisted_affinity = if let Some(scope) = &scope {
                    self.routing_state
                        .binding(&self.affinity_key(&scope.cache_lineage))
                        .await
                        .unwrap_or_else(|error| {
                            self.note_routing_warning("affinity_unavailable");
                            log::warn!("Subscription affinity is unavailable; preserving stored state and selecting from the declared account policy: {error}");
                            None
                        })
                        .map(|binding| AccountAffinity {
                            scope: scope.clone(),
                            account_id: binding.resource_key,
                            credential_revision: binding.revision,
                        })
                } else {
                    None
                };
                let affinity = self
                    .prepared_affinity
                    .lock()
                    .unwrap_or_else(|error| error.into_inner())
                    .as_ref()
                    .filter(|binding| Some(&binding.scope) == scope.as_ref())
                    .cloned()
                    .or(persisted_affinity);
                let members = match &auth {
                    AuthConfig::SubscriptionPool { accounts, .. } => accounts.clone(),
                    AuthConfig::Subscription { account_id, .. } => {
                        vec![account_id
                            .clone()
                            .unwrap_or_else(|| self.provider.key().into())]
                    }
                    _ => Vec::new(),
                };
                let mut cooldowns = std::collections::HashMap::new();
                for id in members {
                    if let Some(cooldown) = self
                        .routing_state
                        .cooldown(&self.health_scope, &id)
                        .await
                        .unwrap_or_else(|error| {
                            self.note_routing_warning("cooldown_unavailable");
                            log::warn!("Subscription cooldown observation is unavailable; preserving stored state and probing declared candidates: {error}");
                            None
                        })
                    {
                        cooldowns.insert(id, cooldown);
                    }
                }
                let resolved = resolve_account_pool_auth_with_state(
                    &auth,
                    &self.model_id,
                    &self.request_model,
                    scope.as_ref(),
                    affinity.as_ref(),
                    &cooldowns,
                    self.probe_cooled,
                )
                .await?;
                let AuthConfig::Subscription { account_id, .. } = resolved else {
                    return Err(anyhow!("Account routing requires a subscription account"));
                };
                let account_id = account_id.unwrap_or_else(|| self.provider.key().into());
                if excluded.contains(&account_id) {
                    return Ok(None);
                }
                let resolved = match self.client_for_account(&account_id, required).await {
                    Ok(resolved) => resolved,
                    Err(error) if required.is_none()
                        && matches!(self.policy, AccountPolicy::Ordered(_))
                        && error.downcast_ref::<super::client_factory::AccountCredentialPreparationError>()
                            .is_some_and(|error| error.account_id == account_id) => {
                        log::warn!("Subscription credential preparation failed for a declared account; checking the remaining authorized pool");
                        excluded.push(account_id);
                        preparation_failure = Some(error);
                        continue;
                    }
                    Err(error) => return Err(error),
                };
                let credential_revision = resolved.credential_revision;
                if let Some(cooldown) = cooldowns.get(&account_id).filter(|cooldown| {
                    !self.probe_cooled
                        && cooldown.revision == credential_revision
                        && cooldown.until > chrono::Utc::now().timestamp()
                }) {
                    // Typed so a channel route skips this member, and an
                    // all-cooling route can still probe it.
                    return Err(anyhow::Error::new(
                        super::client_factory::AccountPoolUnavailable::new(vec![
                            openbitfun_agent_runtime::account_routing::RejectedAccount {
                                account_id,
                                reason: openbitfun_agent_runtime::account_routing::AccountRejection::Cooldown,
                                recovery_at: Some(cooldown.until),
                            },
                        ]),
                    ));
                }
                if let Some(scope) = scope {
                    *self
                        .prepared_affinity
                        .lock()
                        .unwrap_or_else(|error| error.into_inner()) = Some(AccountAffinity {
                        scope,
                        account_id: account_id.clone(),
                        credential_revision,
                    });
                }
                return Ok(Some(resolved));
            }
        })
    }

    fn completed<'a>(
        &'a self,
        origin: &'a ModelAccountOrigin,
        revision: u64,
        lineage: Option<&'a str>,
    ) -> AccountRoutingEffect<'a> {
        Box::pin(async move {
            self.validate_origin(origin)?;
            if matches!(self.policy, AccountPolicy::Ordered(_)) {
                if let Some(lineage) = lineage.filter(|lineage| !lineage.is_empty()) {
                    #[cfg(feature = "subscription-auth")]
                    if crate::infrastructure::subscription_auth::account_credential_revision(
                        crate::infrastructure::subscription_auth::SubscriptionProvider::from_key(
                            self.provider.key(),
                        )
                        .expect("registered provider"),
                        &origin.account_id,
                    )
                    .await?
                        != revision
                    {
                        return Ok(());
                    }
                    self.routing_state
                        .bind(
                            &self.affinity_key(lineage),
                            ResourceBinding {
                                resource_key: origin.account_id.clone(),
                                revision,
                            },
                        )
                        .await
                        .map_err(anyhow::Error::msg)?;
                }
            }
            Ok(())
        })
    }

    fn failed<'a>(
        &'a self,
        origin: &'a ModelAccountOrigin,
        revision: u64,
        until: i64,
    ) -> AccountRoutingEffect<'a> {
        Box::pin(async move {
            self.validate_origin(origin)?;
            self.routing_state
                .extend_cooldown(
                    &self.health_scope,
                    &origin.account_id,
                    ResourceCooldown { revision, until },
                )
                .await
                .map_err(anyhow::Error::msg)
        })
    }
}

#[cfg(test)]
mod replay_tests {
    use super::*;
    use openbitfun_core_types::{Message, ModelResponseReplay};
    #[test]
    fn signed_subscription_history_pins_its_account_even_without_opaque_responses_items() {
        let mut signed = Message::assistant("prior answer".into());
        signed.thinking_signature = Some("preserved-signature".into());
        assert!(
            opaque_replay_origin(&[signed.clone()]).is_err(),
            "legacy signatures cannot authorize selecting an arbitrary pool member"
        );
        for provider in ["antigravity", "opencode", "grok", "hermes"] {
            let origin = ModelAccountOrigin {
                provider: provider.into(),
                account_id: provider.into(),
                upstream_account_id: Some("original-subject".into()),
            };
            let mut bound = signed.clone();
            bound.model_response_replay = Some(ModelResponseReplay {
                protocol: "gemini-code-assist".into(),
                channel_origin: Some("connection".into()),
                channel_fingerprint: Some("original-credential".into()),
                account_origin: Some(origin.clone()),
                items: vec![],
            });
            assert_eq!(
                opaque_replay_origin(&[bound.clone()]).unwrap(),
                Some(origin.clone())
            );
            let mut other = signed.clone();
            other.model_response_replay = Some(ModelResponseReplay {
                protocol: "gemini-code-assist".into(),
                channel_origin: Some("connection".into()),
                channel_fingerprint: Some("other-credential".into()),
                account_origin: Some(ModelAccountOrigin {
                    account_id: "other-slot".into(),
                    ..origin
                }),
                items: vec![],
            });
            assert!(opaque_replay_origin(&[bound, other]).is_err());
        }
        assert_eq!(
            opaque_replay_origin(&[Message::assistant("portable answer".into())]).unwrap(),
            None
        );
    }
}
