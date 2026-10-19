//! Attribution resolution for usage statistics.
//!
//! Maps a raw `TokenUsageRecord` to the dimensions shown on the usage
//! statistics page. Model and provider identities are resolved strictly from
//! `model_config_id`; deleted configurations remain isolated instead of being
//! guessed from an ambiguous effective model name.

use super::types::TokenUsageRecord;
use crate::service::config::types::AIModelConfig;
use openbitfun_services_core::token_usage::{
    UsageAttribution, UsageAttributionStatus, UsageDimensionAttribution, UsageStatisticsFilterKind,
};
use std::collections::HashMap;

const PROVIDER_INSTANCE_METADATA_KEY: &str = "provider_instance_id";
const UNKNOWN_MODEL: &str = "unknown";
const UNKNOWN_ENDPOINT: &str = "/unknown";

/// Resolver owning every lookup table used while attributing usage records.
#[derive(Debug, Default)]
pub struct UsageAttributionResolver {
    /// Model configs by `AIModelConfig.id`.
    configs: HashMap<String, AIModelConfig>,
}

impl UsageAttributionResolver {
    pub fn new(configs: &[AIModelConfig]) -> Self {
        Self {
            configs: configs
                .iter()
                .filter(|config| !config.id.is_empty())
                .map(|config| (config.id.clone(), config.clone()))
                .collect(),
        }
    }

    pub fn attribute(&self, record: &TokenUsageRecord) -> UsageAttribution {
        match self.configs.get(&record.model_config_id) {
            Some(config) => self.attribute_resolved(record, config),
            None => self.attribute_missing(record),
        }
    }

    pub fn matches_filter(
        &self,
        record: &TokenUsageRecord,
        kind: UsageStatisticsFilterKind,
        normalized_query: &str,
    ) -> bool {
        if normalized_query.is_empty() {
            return true;
        }

        let config = self.configs.get(&record.model_config_id);
        let provider_matches = config
            .and_then(|config| non_empty(&config.name))
            .is_some_and(|name| contains_normalized(name, normalized_query));
        let model_matches = config
            .and_then(|config| non_empty(&config.model_name))
            .is_some_and(|name| contains_normalized(name, normalized_query))
            || non_empty(&record.effective_model_name)
                .is_some_and(|name| contains_normalized(name, normalized_query));

        match kind {
            UsageStatisticsFilterKind::All => provider_matches || model_matches,
            UsageStatisticsFilterKind::Provider => provider_matches,
            UsageStatisticsFilterKind::Model => model_matches,
        }
    }

    fn attribute_resolved(
        &self,
        record: &TokenUsageRecord,
        config: &AIModelConfig,
    ) -> UsageAttribution {
        let model_name = non_empty(&config.model_name)
            .or_else(|| non_empty(&record.effective_model_name))
            .unwrap_or(UNKNOWN_MODEL)
            .to_string();
        let provider_name = non_empty(&config.name).map(str::to_string);
        let group_name = provider_name
            .clone()
            .unwrap_or_else(|| UNKNOWN_MODEL.to_string());
        let group_key = provider_instance_id(config)
            .map(|id| format!("provider:{id}"))
            .unwrap_or_else(|| format!("model-config:{}", config.id));
        let endpoint = self.resolve_endpoint(config);
        let endpoint_key = if endpoint == UNKNOWN_ENDPOINT {
            format!("model-config:{}:unknown-endpoint", config.id)
        } else {
            format!("endpoint:{endpoint}")
        };

        UsageAttribution {
            model: UsageDimensionAttribution {
                key: format!("model-config:{}", config.id),
                name: model_name,
                provider_name,
                attribution_status: UsageAttributionStatus::Resolved,
            },
            group: UsageDimensionAttribution {
                key: group_key,
                name: group_name,
                provider_name: None,
                attribution_status: UsageAttributionStatus::Resolved,
            },
            endpoint: UsageDimensionAttribution {
                key: endpoint_key,
                name: endpoint,
                provider_name: None,
                attribution_status: UsageAttributionStatus::Resolved,
            },
        }
    }

    fn attribute_missing(&self, record: &TokenUsageRecord) -> UsageAttribution {
        let config_id = record.model_config_id.trim();
        let model_name = non_empty(&record.effective_model_name)
            .unwrap_or(UNKNOWN_MODEL)
            .to_string();
        let (key, status) = if config_id.is_empty() {
            (
                format!("missing-config-id:{model_name}"),
                UsageAttributionStatus::ConfigIdMissing,
            )
        } else {
            (
                format!("missing-config:{config_id}"),
                UsageAttributionStatus::ConfigMissing,
            )
        };

        UsageAttribution {
            model: UsageDimensionAttribution {
                key: key.clone(),
                name: model_name.clone(),
                provider_name: None,
                attribution_status: status,
            },
            group: UsageDimensionAttribution {
                key: key.clone(),
                name: model_name,
                provider_name: None,
                attribution_status: status,
            },
            endpoint: UsageDimensionAttribution {
                key,
                name: UNKNOWN_ENDPOINT.to_string(),
                provider_name: None,
                attribution_status: status,
            },
        }
    }

    fn resolve_endpoint(&self, config: &AIModelConfig) -> String {
        if let Some(request_url) = config.request_url.as_deref().and_then(non_empty) {
            return endpoint_from_base_url(request_url, "");
        }
        if let Some(base_url) = non_empty(&config.base_url) {
            return endpoint_from_base_url(base_url, provider_endpoint_path(&config.provider));
        }
        UNKNOWN_ENDPOINT.to_string()
    }
}

fn non_empty(value: &str) -> Option<&str> {
    let value = value.trim();
    (!value.is_empty()).then_some(value)
}

fn contains_normalized(value: &str, normalized_query: &str) -> bool {
    value.to_lowercase().contains(normalized_query)
}

fn provider_instance_id(config: &AIModelConfig) -> Option<&str> {
    config
        .metadata
        .as_ref()?
        .get(PROVIDER_INSTANCE_METADATA_KEY)?
        .as_str()
        .and_then(non_empty)
}

/// Canonical request path for a provider's API format.
fn provider_endpoint_path(provider: &str) -> &'static str {
    let provider = provider.trim().to_ascii_lowercase();
    if provider.contains("anthropic") {
        "/v1/messages"
    } else if provider.contains("gemini") || provider.contains("google") {
        "/v1beta/models:generateContent"
    } else {
        "/v1/chat/completions"
    }
}

/// Build the endpoint label from a base URL (scheme stripped) plus the request
/// path. When `path` is empty the URL is used as-is; a missing chat-completions
/// suffix is appended as a last resort so the label reads like an endpoint.
fn endpoint_from_base_url(base_url: &str, path: &str) -> String {
    let host = strip_scheme(base_url.trim().trim_end_matches('/'));
    if host.is_empty() {
        return "/unknown".to_string();
    }
    if host.ends_with("/chat/completions") || host.ends_with("/v1/messages") {
        return host;
    }
    if path.is_empty() {
        return host;
    }
    // Avoid duplicating "/v1" when the base URL already carries it
    // (e.g. "https://api.example.com/v1" + "/v1/chat/completions").
    if let Some(rest) = path.strip_prefix("/v1") {
        if host.ends_with("/v1") {
            return format!("{host}{rest}");
        }
    }
    format!("{host}{path}")
}

fn strip_scheme(url: &str) -> String {
    let url = url.trim();
    for scheme in ["https://", "http://"] {
        if let Some(rest) = url.strip_prefix(scheme) {
            return rest.trim_end_matches('/').to_string();
        }
    }
    url.trim_end_matches('/').to_string()
}

#[cfg(test)]
mod tests {
    use super::*;

    fn config(
        id: &str,
        name: &str,
        provider: &str,
        model_name: &str,
        base_url: &str,
        request_url: Option<&str>,
        provider_instance_id: Option<&str>,
    ) -> AIModelConfig {
        AIModelConfig {
            id: id.to_string(),
            name: name.to_string(),
            provider: provider.to_string(),
            model_name: model_name.to_string(),
            base_url: base_url.to_string(),
            request_url: request_url.map(|value| value.to_string()),
            api_key: String::new(),
            context_window: None,
            max_tokens: None,
            temperature: None,
            top_p: None,
            enabled: true,
            category: crate::service::config::types::ModelCategory::GeneralChat,
            capabilities: Vec::new(),
            recommended_for: Vec::new(),
            metadata: provider_instance_id
                .map(|id| serde_json::json!({ PROVIDER_INSTANCE_METADATA_KEY: id })),
            reasoning: None,
            inline_think_in_text: true,
            custom_headers: None,
            custom_headers_mode: None,
            skip_ssl_verify: false,
            custom_request_body: None,
            custom_request_body_mode: None,
            auth: crate::service::config::types::AuthConfig::ApiKey,
            channel_routing: None,
        }
    }

    fn record(config_id: &str, model: &str) -> TokenUsageRecord {
        TokenUsageRecord {
            model_config_id: config_id.to_string(),
            effective_model_name: model.to_string(),
            session_id: "session".to_string(),
            turn_id: "turn".to_string(),
            timestamp: chrono::Utc::now(),
            input_tokens: 100,
            output_tokens: 50,
            cached_tokens: 0,
            cached_tokens_available: false,
            cache_write_tokens: 0,
            total_tokens: 150,
            token_details: None,
            is_subagent: false,
        }
    }

    #[test]
    fn config_identity_resolves_model_supplier_group_and_endpoint() {
        let resolver = UsageAttributionResolver::new(&[config(
            "cfg-1",
            "DeepSeek",
            "openai",
            "deepseek-v4-flash",
            "https://api.deepseek.com",
            Some("https://api.deepseek.com/chat/completions"),
            Some("provider-deepseek"),
        )]);
        let attribution = resolver.attribute(&record("cfg-1", "deepseek-v4-flash"));

        assert_eq!(attribution.model.key, "model-config:cfg-1");
        assert_eq!(attribution.model.name, "deepseek-v4-flash");
        assert_eq!(attribution.model.provider_name.as_deref(), Some("DeepSeek"));
        assert_eq!(
            attribution.model.attribution_status,
            UsageAttributionStatus::Resolved
        );
        assert_eq!(attribution.group.key, "provider:provider-deepseek");
        assert_eq!(attribution.group.name, "DeepSeek");
        assert_eq!(
            attribution.endpoint.name,
            "api.deepseek.com/chat/completions"
        );
    }

    #[test]
    fn request_url_absent_derives_endpoint_from_base_url_and_provider() {
        let resolver = UsageAttributionResolver::new(&[config(
            "cfg-1",
            "MiniMax",
            "anthropic",
            "MiniMax-M3",
            "https://api.minimax.io/anthropic",
            None,
            Some("provider-minimax"),
        )]);
        let attribution = resolver.attribute(&record("cfg-1", "deepseek-v4-flash"));
        assert_eq!(
            attribution.endpoint.name,
            "api.minimax.io/anthropic/v1/messages"
        );
    }

    #[test]
    fn same_provider_instance_groups_multiple_model_configs() {
        let resolver = UsageAttributionResolver::new(&[
            config(
                "cfg-1",
                "MiniMax",
                "anthropic",
                "MiniMax-M3",
                "https://api.minimax.io/anthropic",
                None,
                Some("provider-minimax"),
            ),
            config(
                "cfg-2",
                "MiniMax",
                "anthropic",
                "MiniMax-M2.7",
                "https://api.minimax.io/anthropic",
                None,
                Some("provider-minimax"),
            ),
        ]);

        let first = resolver.attribute(&record("cfg-1", "MiniMax-M3"));
        let second = resolver.attribute(&record("cfg-2", "MiniMax-M2.7"));
        assert_ne!(first.model.key, second.model.key);
        assert_eq!(first.group.key, second.group.key);
        assert_eq!(first.group.name, "MiniMax");
    }

    #[test]
    fn same_named_models_from_different_suppliers_keep_distinct_keys() {
        let resolver = UsageAttributionResolver::new(&[
            config(
                "cfg-openbitfun",
                "OpenBitFun",
                "anthropic",
                "MiniMax-M3",
                "https://gateway.example.com",
                None,
                Some("provider-openbitfun"),
            ),
            config(
                "cfg-minimax",
                "MiniMax",
                "anthropic",
                "MiniMax-M3",
                "https://api.minimax.io/anthropic",
                None,
                Some("provider-minimax"),
            ),
        ]);

        let first = resolver.attribute(&record("cfg-openbitfun", "MiniMax-M3"));
        let second = resolver.attribute(&record("cfg-minimax", "MiniMax-M3"));
        assert_eq!(first.model.name, second.model.name);
        assert_ne!(first.model.key, second.model.key);
        assert_eq!(first.model.provider_name.as_deref(), Some("OpenBitFun"));
        assert_eq!(second.model.provider_name.as_deref(), Some("MiniMax"));
    }

    #[test]
    fn provider_filter_uses_display_name_not_api_format() {
        let resolver = UsageAttributionResolver::new(&[config(
            "cfg-deepseek",
            "DeepSeek",
            "openai",
            "deepseek-v4-flash",
            "https://api.deepseek.com",
            None,
            Some("provider-deepseek"),
        )]);
        let record = record("cfg-deepseek", "deepseek-v4-flash");

        assert!(resolver.matches_filter(&record, UsageStatisticsFilterKind::Provider, "deep"));
        assert!(resolver.matches_filter(&record, UsageStatisticsFilterKind::Provider, "deepseek"));
        assert!(!resolver.matches_filter(&record, UsageStatisticsFilterKind::Provider, "openai"));
    }

    #[test]
    fn model_filter_matches_configured_and_effective_model_names() {
        let resolver = UsageAttributionResolver::new(&[config(
            "cfg-model",
            "Custom Provider",
            "anthropic",
            "Configured-Model",
            "https://api.example.com",
            None,
            Some("provider-custom"),
        )]);
        let record = record("cfg-model", "effective-model-alias");

        assert!(resolver.matches_filter(&record, UsageStatisticsFilterKind::Model, "configured"));
        assert!(resolver.matches_filter(
            &record,
            UsageStatisticsFilterKind::Model,
            "effective-model"
        ));
        assert!(resolver.matches_filter(&record, UsageStatisticsFilterKind::All, "custom"));
    }

    #[test]
    fn deleted_config_can_only_be_filtered_by_effective_model_name() {
        let resolver = UsageAttributionResolver::new(&[]);
        let record = record("deleted-config", "legacy-model");

        assert!(resolver.matches_filter(&record, UsageStatisticsFilterKind::Model, "legacy"));
        assert!(resolver.matches_filter(&record, UsageStatisticsFilterKind::All, "legacy"));
        assert!(!resolver.matches_filter(&record, UsageStatisticsFilterKind::Provider, "legacy"));
    }

    #[test]
    fn missing_provider_instance_id_does_not_merge_config_groups() {
        let resolver = UsageAttributionResolver::new(&[
            config(
                "cfg-1",
                "Legacy Provider",
                "openai",
                "model-a",
                "https://api.example.com",
                None,
                None,
            ),
            config(
                "cfg-2",
                "Legacy Provider",
                "openai",
                "model-b",
                "https://api.example.com",
                None,
                None,
            ),
        ]);

        let first = resolver.attribute(&record("cfg-1", "model-a"));
        let second = resolver.attribute(&record("cfg-2", "model-b"));
        assert_ne!(first.group.key, second.group.key);
    }

    #[test]
    fn missing_config_stays_isolated_without_catalog_inference() {
        let resolver = UsageAttributionResolver::new(&[]);
        let attribution = resolver.attribute(&record("deleted-config", "deepseek-v4-pro"));

        assert_eq!(attribution.model.key, "missing-config:deleted-config");
        assert_eq!(attribution.model.name, "deepseek-v4-pro");
        assert_eq!(attribution.model.provider_name, None);
        assert_eq!(
            attribution.model.attribution_status,
            UsageAttributionStatus::ConfigMissing
        );
        assert_eq!(attribution.group.key, "missing-config:deleted-config");
        assert_eq!(attribution.endpoint.name, UNKNOWN_ENDPOINT);
    }

    #[test]
    fn missing_config_id_has_a_distinct_status() {
        let resolver = UsageAttributionResolver::new(&[]);
        let attribution = resolver.attribute(&record("", "custom-model"));

        assert_eq!(attribution.model.key, "missing-config-id:custom-model");
        assert_eq!(
            attribution.model.attribution_status,
            UsageAttributionStatus::ConfigIdMissing
        );
    }
}
