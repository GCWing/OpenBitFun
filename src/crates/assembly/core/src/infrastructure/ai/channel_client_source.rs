//! Host-scoped channel composition over the existing model/account factory.
//! Accounts are exhausted inside a channel before the round asks for another.
use super::{account_client_source::AccountClientSource, AIClient, AIClientFactory};
use crate::service::config::types::AIModelConfig;
use anyhow::{anyhow, Result};
use openbitfun_config_contracts::model_runtime_binding_fingerprint;
use openbitfun_services_core::routing_state::{
    ResourceBinding, ResourceCooldown, RoutingStateStore,
};
use sha2::{Digest, Sha256};
use std::sync::{Arc, Mutex};

#[derive(Clone, Debug)]
pub(crate) struct PreparedChannel {
    pub model_id: String,
    pub client: Arc<AIClient>,
    pub account_source: Option<Arc<dyn AccountClientSource>>,
    pub origin: Option<openbitfun_core_types::ModelAccountOrigin>,
    pub credential_revision: Option<u64>,
}

#[derive(Debug)]
pub(crate) struct ChannelReplayRequirement(&'static str);

impl std::fmt::Display for ChannelReplayRequirement {
    fn fmt(&self, formatter: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        formatter.write_str(self.0)
    }
}
impl std::error::Error for ChannelReplayRequirement {}

#[cfg(test)]
mod tests {
    use super::*;
    #[tokio::test]
    async fn an_all_cooling_route_probes_the_soonest_recovery_instead_of_refusing() {
        use crate::service::config::{ConfigManagerSettings, ConfigService};
        let dir = tempfile::tempdir().unwrap();
        let config = Arc::new(
            ConfigService::with_settings(ConfigManagerSettings {
                path_manager: Some(Arc::new(
                    crate::infrastructure::PathManager::with_user_root_for_tests(
                        dir.path().join("host"),
                    ),
                )),
                auto_save: true,
                backup_count: 0,
            })
            .await
            .unwrap(),
        );
        let member = |id: &str| AIModelConfig {
            id: id.into(),
            name: id.into(),
            provider: "openai".into(),
            enabled: true,
            model_name: "fixture".into(),
            api_key: format!("synthetic-{id}-key"),
            base_url: format!("https://{id}.invalid"),
            ..Default::default()
        };
        let primary = AIModelConfig {
            channel_routing: Some(
                openbitfun_config_contracts::channel_routing::ModelChannelRouting {
                    fallback_model_ids: vec!["relay".into()],
                    ..Default::default()
                },
            ),
            ..member("primary")
        };
        config
            .set_config("ai.models", vec![primary.clone(), member("relay")])
            .await
            .unwrap();
        let factory = Arc::new(AIClientFactory::new_for_test(config.clone()));
        let fingerprint = model_runtime_binding_fingerprint(
            &config
                .get_effective_ai_config()
                .await
                .unwrap()
                .models
                .into_iter()
                .find(|model| model.id == "primary")
                .unwrap(),
        );
        let (_, source) = factory
            .prepare_native_routed_model_client("primary", &fingerprint, None, None, None)
            .await
            .unwrap();
        let source = source.unwrap();
        let now = chrono::Utc::now().timestamp();
        source.failed("primary", Some(now + 7200)).await;
        source.failed("relay", Some(now + 600)).await;
        let probed = source
            .resolve(&[], None, None, None)
            .await
            .unwrap()
            .unwrap();
        assert_eq!(probed.model_id, "relay");
        // An excluded member (already failed this round) is never re-probed.
        let excluded = source
            .resolve(&["relay".into()], None, None, None)
            .await
            .unwrap()
            .unwrap();
        assert_eq!(excluded.model_id, "primary");
        assert!(source
            .resolve(&["relay".into(), "primary".into()], None, None, None)
            .await
            .unwrap()
            .is_none());
    }

    #[tokio::test]
    async fn a_late_failure_from_the_previous_key_cannot_cool_down_its_replacement() {
        use crate::service::config::{ConfigManagerSettings, ConfigService};
        let dir = tempfile::tempdir().unwrap();
        let config = Arc::new(
            ConfigService::with_settings(ConfigManagerSettings {
                path_manager: Some(Arc::new(
                    crate::infrastructure::PathManager::with_user_root_for_tests(
                        dir.path().join("host"),
                    ),
                )),
                auto_save: true,
                backup_count: 0,
            })
            .await
            .unwrap(),
        );
        let model = AIModelConfig {
            id: "primary".into(),
            name: "Primary".into(),
            provider: "openai".into(),
            enabled: true,
            model_name: "fixture".into(),
            api_key: "synthetic-old-key".into(),
            base_url: "https://primary.invalid".into(),
            channel_routing: Some(Default::default()),
            ..Default::default()
        };
        config
            .set_config("ai.models", vec![model.clone()])
            .await
            .unwrap();
        let mut model = config
            .get_effective_ai_config()
            .await
            .unwrap()
            .models
            .into_iter()
            .find(|model| model.id == "primary")
            .unwrap();
        let factory = Arc::new(AIClientFactory::new_for_test(config.clone()));
        let fingerprint = model_runtime_binding_fingerprint(&model);
        let (_, old) = factory
            .prepare_native_routed_model_client(&model.id, &fingerprint, None, None, None)
            .await
            .unwrap();
        let old = old.unwrap();
        model.api_key = "synthetic-new-key".into();
        config.set_config("ai.models", vec![model]).await.unwrap();
        old.failed("primary", Some(chrono::Utc::now().timestamp() + 3600))
            .await;
        assert!(
            old.state
                .cooldown(&old.scope, "primary")
                .await
                .unwrap()
                .is_some_and(|cooldown| cooldown.until > chrono::Utc::now().timestamp()),
            "fixture must retain the previous key's real cooldown"
        );
        let (prepared, _) = factory
            .prepare_native_routed_model_client("primary", &fingerprint, None, None, None)
            .await
            .unwrap();
        assert_eq!(prepared.client.config.api_key, "synthetic-new-key");
    }
    #[test]
    fn missing_requested_reasoning_cannot_silently_use_the_channel_default() {
        let config = openbitfun_core_types::AIConfig::try_from(AIModelConfig {
            id: "backup".into(),
            provider: "openai".into(),
            enabled: true,
            model_name: "backup-model".into(),
            ..Default::default()
        })
        .unwrap();
        let client = AIClient::new(config);
        assert!(ChannelClientSource::validate_reasoning_selection(None, &client).is_ok());
        assert!(ChannelClientSource::validate_reasoning_selection(Some("high"), &client).is_err());
    }
    #[test]
    fn signed_history_cannot_follow_a_changed_endpoint_or_key() {
        let config = openbitfun_core_types::AIConfig::try_from(AIModelConfig {
            id: "primary".into(),
            name: "Primary".into(),
            provider: "anthropic".into(),
            enabled: true,
            api_key: "synthetic-original".into(),
            base_url: "https://primary.invalid".into(),
            model_name: "model".into(),
            ..Default::default()
        })
        .unwrap();
        let client = AIClient::new(config);
        let mut message = openbitfun_core_types::Message::assistant("Completed".into());
        message.thinking_signature = Some("signed-state".into());
        message.model_response_replay = Some(openbitfun_core_types::ModelResponseReplay {
            protocol: "anthropic".into(),
            channel_origin: Some("primary".into()),
            channel_fingerprint: Some(client.channel_replay_fingerprint()),
            account_origin: None,
            items: vec![],
        });
        let history = vec![message];
        assert!(
            ChannelClientSource::validate_replay_binding(&history, "primary", &client, true)
                .is_ok()
        );
        for (key, endpoint, channel) in [
            (
                "synthetic-replacement",
                "https://primary.invalid",
                "primary",
            ),
            ("synthetic-original", "https://backup.invalid", "primary"),
            ("synthetic-original", "https://primary.invalid", "backup"),
        ] {
            let mut changed = client.clone();
            changed.config.api_key = key.into();
            changed.config.base_url = endpoint.into();
            assert!(ChannelClientSource::validate_replay_binding(
                &history, channel, &changed, true
            )
            .is_err());
            let mut projected = history.clone();
            assert_eq!(
                ChannelClientSource::project_replay_for_target(
                    &mut projected,
                    channel,
                    &changed,
                    None
                ),
                1
            );
            assert!(projected[0].thinking_signature.is_none());
            assert!(projected[0].model_response_replay.is_none());
            assert_eq!(projected[0].content, history[0].content);
            assert!(ChannelClientSource::validate_replay_binding(
                &projected, channel, &changed, true
            )
            .is_ok());
        }
        let mut changed_model = client.clone();
        changed_model.config.model = "another-model".into();
        let mut mixed = history.clone();
        let mut other = history[0].clone();
        other
            .model_response_replay
            .as_mut()
            .unwrap()
            .channel_fingerprint = Some(changed_model.channel_replay_fingerprint());
        mixed.push(other);
        assert_eq!(
            ChannelClientSource::project_replay_for_target(&mut mixed, "primary", &client, None),
            1
        );
        assert_eq!(
            serde_json::to_value(&mixed[0]).unwrap(),
            serde_json::to_value(&history[0]).unwrap()
        );
        assert!(mixed[1].thinking_signature.is_none());
        let mut legacy = history[0].clone();
        legacy.model_response_replay = None;
        assert!(ChannelClientSource::validate_replay_binding(
            &[legacy.clone()],
            "primary",
            &client,
            true
        )
        .is_err());
        assert!(
            ChannelClientSource::validate_replay_binding(&[legacy], "primary", &client, false)
                .is_ok()
        );
    }

    #[test]
    fn replay_projection_preserves_legacy_seat_provenance_but_drops_unknown_state() {
        let client = AIClient::new(
            openbitfun_core_types::AIConfig::try_from(AIModelConfig::default()).unwrap(),
        );
        let account = openbitfun_core_types::ModelAccountOrigin {
            provider: "codex".into(),
            account_id: "account-a".into(),
            upstream_account_id: Some("seat-a".into()),
        };
        let mut message = openbitfun_core_types::Message::assistant("Saved answer".into());
        message.thinking_signature = Some("original-signature".into());
        message.reasoning_content = Some("Signed reasoning".into());
        let mut unknown = vec![message.clone()];
        assert_eq!(
            ChannelClientSource::project_replay_for_target(&mut unknown, "primary", &client, None),
            1
        );
        assert!(unknown[0].reasoning_content.is_none());
        message.model_response_replay = Some(openbitfun_core_types::ModelResponseReplay {
            protocol: "openai_responses".into(),
            channel_origin: None,
            channel_fingerprint: None,
            account_origin: Some(account.clone()),
            items: vec![],
        });
        let before = serde_json::to_value(&message).unwrap();
        let mut projected = vec![message];
        assert_eq!(
            ChannelClientSource::project_replay_for_target(
                &mut projected,
                "primary",
                &client,
                Some(&account)
            ),
            0
        );
        assert_eq!(serde_json::to_value(&projected[0]).unwrap(), before);
        let changed = openbitfun_core_types::ModelAccountOrigin {
            upstream_account_id: Some("replacement-seat".into()),
            ..account
        };
        assert_eq!(
            ChannelClientSource::project_replay_for_target(
                &mut projected,
                "primary",
                &client,
                Some(&changed)
            ),
            1
        );
        assert!(projected[0].model_response_replay.is_none());
    }
}

pub(crate) struct ChannelClientSource {
    factory: Arc<AIClientFactory>,
    members: Vec<AIModelConfig>,
    reasoning_preset: Option<String>,
    temperature: Option<f64>,
    state: RoutingStateStore,
    scope: String,
    selected: Mutex<Option<String>>,
    warnings: Mutex<Vec<String>>,
}

impl std::fmt::Debug for ChannelClientSource {
    fn fmt(&self, formatter: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        formatter
            .debug_struct("ChannelClientSource")
            .field(
                "members",
                &self
                    .members
                    .iter()
                    .map(|model| &model.id)
                    .collect::<Vec<_>>(),
            )
            .finish_non_exhaustive()
    }
}

impl ChannelClientSource {
    pub(crate) fn binding_fingerprint(&self, id: &str) -> Option<String> {
        self.members
            .iter()
            .find(|model| model.id == id)
            .map(model_runtime_binding_fingerprint)
    }
    fn validate_reasoning_selection(requested: Option<&str>, client: &AIClient) -> Result<()> {
        if let Some(requested) = requested.map(str::trim).filter(|id| !id.is_empty()) {
            if client
                .selected_reasoning_preset()
                .is_none_or(|preset| preset.id != requested)
            {
                return Err(anyhow!(
                    "Selected channel cannot preserve the requested reasoning preset: {requested}"
                ));
            }
        }
        Ok(())
    }
    fn note_warning(&self, code: &str) {
        let mut warnings = self
            .warnings
            .lock()
            .unwrap_or_else(|error| error.into_inner());
        if !warnings.iter().any(|warning| warning == code) {
            warnings.push(code.into());
        }
    }
    pub(crate) fn take_routing_warnings(&self) -> Vec<String> {
        std::mem::take(
            &mut *self
                .warnings
                .lock()
                .unwrap_or_else(|error| error.into_inner()),
        )
    }
    pub(crate) async fn revalidate_plain_channel(
        &self,
        id: &str,
        lineage: Option<&str>,
    ) -> Result<Arc<AIClient>> {
        self.validate().await?;
        let model = self
            .members
            .iter()
            .find(|model| model.id == id)
            .ok_or_else(|| anyhow!("Selected channel is outside the approved route"))?;
        let (client, account_source) = self
            .factory
            .prepare_native_model_client(
                id,
                &model_runtime_binding_fingerprint(model),
                self.reasoning_preset.as_deref(),
                lineage,
                self.temperature,
            )
            .await?;
        if account_source.is_some() {
            return Err(anyhow!("Selected channel authentication changed"));
        }
        Self::validate_reasoning_selection(self.reasoning_preset.as_deref(), &client)?;
        let mut bounded = (*client).clone();
        bounded.config.context_window = bounded.config.context_window.min(
            self.members[0]
                .context_window
                .unwrap_or(openbitfun_config_contracts::DEFAULT_MODEL_CONTEXT_WINDOW_TOKENS),
        );
        Ok(Arc::new(bounded))
    }
    pub(crate) fn validate_replay_binding(
        messages: &[openbitfun_core_types::Message],
        channel: &str,
        client: &AIClient,
        require_provenance: bool,
    ) -> Result<()> {
        let fingerprint = client.channel_replay_fingerprint();
        for message in messages {
            if !Self::has_nonportable_history(std::slice::from_ref(message)) {
                continue;
            }
            let identity = message.model_response_replay.as_ref().and_then(|replay| {
                replay
                    .channel_origin
                    .as_ref()
                    .zip(replay.channel_fingerprint.as_ref())
            });
            match identity {
                Some((origin, original)) if origin != channel || original != &fingerprint => return Err(anyhow!("Signed or opaque history requires its original channel and credential identity")),
                None if require_provenance => return Err(anyhow!("Signed or opaque history has no proven channel identity")),
                _ => {},
            }
        }
        Ok(())
    }
    pub(crate) fn automatic(&self) -> bool {
        self.members[0]
            .channel_routing
            .as_ref()
            .is_none_or(|route| route.manual_channel.is_none())
    }

    /// Project the request copy for the actual destination, including manually
    /// selected models and fixed accounts. Keep compatible state per message so
    /// switching back can still reuse the originals in durable history.
    pub(crate) fn project_replay_for_target(
        messages: &mut [openbitfun_core_types::Message],
        channel: &str,
        client: &AIClient,
        account: Option<&openbitfun_core_types::ModelAccountOrigin>,
    ) -> usize {
        let fingerprint = client.channel_replay_fingerprint();
        let mut stripped = 0;
        for message in messages {
            if !Self::has_nonportable_history(std::slice::from_ref(message)) {
                continue;
            }
            let compatible = message
                .model_response_replay
                .as_ref()
                .is_some_and(|replay| {
                    let same_account = replay.account_origin.as_ref() == account
                        && account.is_none_or(|origin| {
                            origin
                                .upstream_account_id
                                .as_deref()
                                .is_some_and(|id| !id.trim().is_empty())
                        });
                    let same_channel = match (&replay.channel_origin, &replay.channel_fingerprint) {
                        (Some(origin), Some(original)) => {
                            origin == channel && original == &fingerprint
                        }
                        // Older subscription history can prove its producing seat
                        // without channel fields. Preserve that existing replay path.
                        (None, None) => account.is_some(),
                        _ => false,
                    };
                    same_channel && same_account
                });
            if !compatible {
                Self::make_portable(message);
                stripped += 1;
            }
        }
        stripped
    }
    /// Removes provider-signed reasoning from one message. Text, tool calls
    /// and tool results stay; any account or channel can then replay it.
    fn make_portable(message: &mut openbitfun_core_types::Message) {
        if !Self::has_nonportable_history(std::slice::from_ref(message)) {
            return;
        }
        message.thinking_signature = None;
        // Reasoning text from a signed block is only valid inside that block.
        message.reasoning_content = None;
        message.model_response_replay = None;
    }

    /// A switched attempt cannot present another credential's signed state.
    /// The session keeps the originals; only this request copy is rewritten.
    pub(crate) fn portable_history(
        messages: &[openbitfun_core_types::Message],
    ) -> Vec<openbitfun_core_types::Message> {
        let mut messages = messages.to_vec();
        messages.iter_mut().for_each(Self::make_portable);
        messages
    }

    /// Earlier failovers leave signed state from several producers. Keep only
    /// the most recent producer's state (it pins this round), and degrade
    /// older or unproven state so routed history always has one origin.
    pub(crate) fn retain_latest_replay_origin(
        messages: &[openbitfun_core_types::Message],
    ) -> Vec<openbitfun_core_types::Message> {
        let provenance = |message: &openbitfun_core_types::Message| {
            message.model_response_replay.as_ref().and_then(|replay| {
                let channel = replay
                    .channel_origin
                    .clone()
                    .filter(|id| !id.is_empty())
                    .zip(replay.channel_fingerprint.clone());
                (channel.is_some() || replay.account_origin.is_some())
                    .then(|| (channel, replay.account_origin.clone()))
            })
        };
        let latest = messages
            .iter()
            .rev()
            .find(|message| Self::has_nonportable_history(std::slice::from_ref(*message)))
            .and_then(provenance);
        let mut messages = messages.to_vec();
        for message in &mut messages {
            if latest.is_none() || provenance(message) != latest {
                Self::make_portable(message);
            }
        }
        messages
    }

    pub(crate) fn has_nonportable_history(messages: &[openbitfun_core_types::Message]) -> bool {
        messages.iter().any(|message| message.thinking_signature.is_some() || message.model_response_replay.as_ref().is_some_and(|replay| replay.items.iter().any(|item| matches!(item, openbitfun_core_types::ModelResponseReplayItem::OpaqueReasoning { .. }))))
    }
    pub(crate) async fn validate(&self) -> Result<()> {
        self.factory.validate_channel_snapshot(&self.members).await
    }
    pub(crate) fn new(
        factory: Arc<AIClientFactory>,
        members: Vec<AIModelConfig>,
        reasoning_preset: Option<String>,
        temperature: Option<f64>,
        state: RoutingStateStore,
    ) -> Self {
        let scope = serde_json::to_string(
            &members
                .iter()
                .map(|model| {
                    (
                        &model.id,
                        model_runtime_binding_fingerprint(model),
                        // A late failure from an old static credential cannot
                        // cool down a replacement key. Never persist the key.
                        matches!(
                            model.auth,
                            crate::service::config::types::AuthConfig::ApiKey
                        )
                        .then(|| format!("{:x}", Sha256::digest(model.api_key.as_bytes()))),
                    )
                })
                .collect::<Vec<_>>(),
        )
        .expect("channel identities serialize");
        Self {
            factory,
            members,
            reasoning_preset,
            temperature,
            state,
            scope,
            selected: Mutex::new(None),
            warnings: Mutex::new(Vec::new()),
        }
    }

    pub(crate) fn replay_channel(
        messages: &[openbitfun_core_types::Message],
    ) -> Result<Option<String>> {
        let mut required = None;
        for message in messages {
            let signed = message.thinking_signature.is_some();
            if !signed
                && !message
                    .model_response_replay
                    .as_ref()
                    .is_some_and(|replay| {
                        replay.items.iter().any(|item| {
                matches!(
                    item,
                    openbitfun_core_types::ModelResponseReplayItem::OpaqueReasoning { .. }
                )
            })
                    })
            {
                continue;
            }
            let replay = message
                .model_response_replay
                .as_ref()
                .ok_or_else(|| anyhow!("Signed model history has no channel provenance"))?;
            if replay.channel_fingerprint.is_none() {
                return Err(anyhow!(
                    "Signed or opaque history has no proven channel identity"
                ));
            }
            let channel = replay.channel_origin.as_ref().filter(|id| !id.is_empty()).ok_or_else(|| anyhow!("Opaque model history has no channel provenance; cross-channel routing is unavailable"))?;
            if required.as_ref().is_some_and(|old| old != channel) {
                return Err(anyhow!(
                    "Opaque model history contains incompatible channels"
                ));
            }
            required = Some(channel.clone());
        }
        Ok(required)
    }

    fn affinity_key(&self, lineage: &str) -> String {
        format!("{}:{lineage}", self.scope)
    }

    pub(crate) async fn resolve(
        &self,
        excluded: &[String],
        required: Option<&str>,
        lineage: Option<&str>,
        required_account: Option<&openbitfun_core_types::ModelAccountOrigin>,
    ) -> Result<Option<PreparedChannel>> {
        self.factory
            .validate_channel_snapshot(&self.members)
            .await?;
        let mut ids = self
            .members
            .iter()
            .map(|model| model.id.clone())
            .collect::<Vec<_>>();
        let mut preferred = self
            .selected
            .lock()
            .unwrap_or_else(|error| error.into_inner())
            .clone();
        if preferred.is_none() {
            if let Some(lineage) = lineage {
                match self.state.binding(&self.affinity_key(lineage)).await {
                    Ok(Some(binding)) => preferred = Some(binding.resource_key),
                    Ok(None) => {}
                    Err(error) => {
                        self.note_warning("channel_affinity_unavailable");
                        log::warn!("Channel affinity unavailable; probing declared route: {error}")
                    }
                }
            }
        }
        if let Some(required) = required {
            if !ids.iter().any(|id| id == required) {
                return Err(ChannelReplayRequirement(
                    "Opaque history requires a channel outside the approved route",
                )
                .into());
            }
            ids = vec![required.into()];
        } else if let Some(preferred) = preferred {
            if let Some(index) = ids.iter().position(|id| id == &preferred) {
                let id = ids.remove(index);
                ids.insert(0, id);
            }
        }
        if let Some(manual) = self.members[0]
            .channel_routing
            .as_ref()
            .and_then(|route| route.manual_channel.as_ref())
        {
            if required.is_some_and(|required| required != manual) {
                return Err(ChannelReplayRequirement("The manually selected channel cannot replay this opaque history; restore its original channel or start a new conversation").into());
            }
            ids = vec![manual.clone()];
        }
        // Cooling members are skipped first; if nothing else is eligible the
        // soonest-recovering one is probed rather than refusing locally.
        let mut cooling: Vec<(i64, String)> = Vec::new();
        for id in ids {
            let model = self
                .members
                .iter()
                .find(|model| model.id == id)
                .expect("declared member");
            if !model.enabled || excluded.contains(&id) {
                continue;
            }
            if required.is_none() {
                match self.state.cooldown(&self.scope, &id).await {
                    Ok(Some(cooldown)) if cooldown.until > chrono::Utc::now().timestamp() => {
                        cooling.push((cooldown.until, id));
                        continue;
                    }
                    Err(error) => {
                        self.note_warning("channel_cooldown_unavailable");
                        log::warn!("Channel cooldown unavailable; probing declared route: {error}")
                    }
                    _ => {}
                }
            }
            match self
                .prepare_member(&id, model, lineage, required_account, false)
                .await
            {
                Ok(prepared) => return Ok(Some(prepared)),
                Err(error) if required.is_none() => {
                    if let Some(unavailable) =
                        error.downcast_ref::<super::client_factory::AccountPoolUnavailable>()
                    {
                        if let Some(until) = unavailable.soonest_cooldown() {
                            cooling.push((until, id));
                        }
                    } else if error
                        .downcast_ref::<super::client_factory::AccountCredentialPreparationError>()
                        .is_none()
                    {
                        return Err(error);
                    }
                }
                Err(error) => return Err(error),
            }
        }
        cooling.sort();
        for (_, id) in cooling {
            let model = self
                .members
                .iter()
                .find(|model| model.id == id)
                .expect("declared member");
            match self.prepare_member(&id, model, lineage, required_account, true).await {
                Ok(prepared) => return Ok(Some(prepared)),
                Err(error)
                    if error.downcast_ref::<super::client_factory::AccountPoolUnavailable>().is_some()
                        || error
                            .downcast_ref::<super::client_factory::AccountCredentialPreparationError>()
                            .is_some() => {}
                Err(error) => return Err(error),
            }
        }
        Ok(None)
    }

    async fn prepare_member(
        &self,
        id: &str,
        model: &AIModelConfig,
        lineage: Option<&str>,
        required_account: Option<&openbitfun_core_types::ModelAccountOrigin>,
        probe_cooled: bool,
    ) -> Result<PreparedChannel> {
        let mut prepared = self
            .factory
            .prepare_native_model_candidate(
                id,
                &model_runtime_binding_fingerprint(model),
                self.reasoning_preset.as_deref(),
                lineage,
                self.temperature,
                required_account,
                probe_cooled,
            )
            .await?;
        Self::validate_reasoning_selection(self.reasoning_preset.as_deref(), &prepared.client)?;
        let mut bounded = (*prepared.client).clone();
        bounded.config.context_window = bounded.config.context_window.min(
            self.members[0]
                .context_window
                .unwrap_or(openbitfun_config_contracts::DEFAULT_MODEL_CONTEXT_WINDOW_TOKENS),
        );
        prepared.client = Arc::new(bounded);
        *self
            .selected
            .lock()
            .unwrap_or_else(|error| error.into_inner()) = Some(id.into());
        Ok(prepared)
    }

    pub(crate) async fn completed(&self, id: &str, lineage: Option<&str>) {
        if let Some(lineage) = lineage {
            if let Err(error) = self
                .state
                .bind(
                    &self.affinity_key(lineage),
                    ResourceBinding {
                        resource_key: id.into(),
                        revision: 0,
                    },
                )
                .await
            {
                log::warn!("Failed to persist channel affinity: {error}");
            }
        }
    }

    pub(crate) async fn failed(&self, id: &str, until: Option<i64>) {
        // Subscription cooldown belongs to its account/credential owner.
        // Aggregating it again at channel level would outlive a new login.
        if !self.members.iter().any(|model| {
            model.id == id
                && matches!(
                    model.auth,
                    crate::service::config::types::AuthConfig::ApiKey
                )
        }) {
            return;
        }
        if let Some(until) = until {
            if let Err(error) = self
                .state
                .extend_cooldown(&self.scope, id, ResourceCooldown { revision: 0, until })
                .await
            {
                log::warn!("Failed to persist channel cooldown: {error}");
            }
        }
    }
}
