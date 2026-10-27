//! Resolution of the configured image generation service.
//!
//! The image service is selected in settings and is independent of the session's
//! text model: a session never decides which image provider is called. This
//! module is the single place that turns the persisted `media` section into a
//! callable adapter target.

use crate::infrastructure::ai::client_factory::apply_subscription_auth;
use crate::service::config::get_global_config_service;
use crate::service::config::types::{
    AIConfig as ServiceAIConfig, AuthConfig, ImageServiceConfig, MediaConfig, SubscriptionProvider,
};
use crate::util::errors::{OpenBitFunError, OpenBitFunResult};
use openbitfun_ai_adapters::client::image_generation::{
    generate, GeneratedImage, ImageGenerationError, ImageGenerationErrorKind,
    ImageGenerationRequest, ImageGenerationTarget,
};
use openbitfun_core_types::{AIConfig, ImageDialect, ProxyConfig};
use std::collections::HashMap;

/// Authentication material for one image call.
///
/// An image service can authenticate with its own API key or with an imported
/// subscription login. Resolving the login produces a bearer token and the
/// provider's extra headers, so both sources reach the adapter the same way.
#[derive(Debug, Clone, Default)]
pub struct ImageServiceCredentials {
    pub api_key: String,
    pub custom_headers: Option<HashMap<String, String>>,
    pub custom_headers_mode: Option<String>,
    /// Endpoint supplied by a subscription login. Only used when the service
    /// itself has no base URL, because an image service owns its own dialect
    /// endpoint rather than inheriting the chat endpoint.
    pub base_url: Option<String>,
}

impl ImageServiceCredentials {
    fn from_service(service: &ImageServiceConfig) -> Self {
        Self {
            api_key: service.api_key.clone(),
            custom_headers: service.custom_headers.clone(),
            custom_headers_mode: service.custom_headers_mode.clone(),
            base_url: None,
        }
    }
}

/// One resolved service plus the transport settings it inherits.
#[derive(Debug, Clone)]
pub struct ResolvedImageService {
    pub service: ImageServiceConfig,
    pub credentials: ImageServiceCredentials,
    pub proxy: Option<ProxyConfig>,
}

fn no_service_error() -> OpenBitFunError {
    OpenBitFunError::tool(
        "No image generation service is configured. Add one in Settings > Models > Image generation."
            .to_string(),
    )
}

/// Resolve the credential material for one service.
///
/// An API-key service needs no resolution. A subscription service reuses the
/// same login store the chat models use; when that login cannot be read the call
/// fails with the resolver's reason instead of sending an unauthenticated
/// request.
pub async fn resolve_credentials(
    service: &ImageServiceConfig,
) -> OpenBitFunResult<ImageServiceCredentials> {
    if matches!(service.auth, AuthConfig::SubscriptionPool { .. }) {
        return Err(OpenBitFunError::tool(
            "Image generation does not support subscription account pools; select a single account",
        ));
    }
    if !matches!(service.auth, AuthConfig::Subscription { .. }) {
        return Ok(ImageServiceCredentials::from_service(service));
    }

    let mut ai_config = transient_ai_config(service);
    apply_subscription_auth(&service.auth, &mut ai_config)
        .await
        .map_err(|err| {
            OpenBitFunError::tool(format!(
                "Image service '{}' uses a subscription login that could not be resolved: {err}",
                service.name.trim()
            ))
        })?;

    let subscription_base_url = ai_config.base_url.trim().to_string();
    // The subscription dialect is served from the provider's own backend, not
    // from the address a user would type for an API key. Keeping a typed-in
    // platform URL would send a subscription token to the wrong host, which the
    // provider answers with a missing-scope error rather than a routing error.
    let use_subscription_base_url = match service.dialect {
        ImageDialect::ChatgptCodex => !subscription_base_url.is_empty(),
        _ => service.base_url.trim().is_empty() && !subscription_base_url.is_empty(),
    };
    Ok(ImageServiceCredentials {
        api_key: ai_config.api_key,
        custom_headers: ai_config.custom_headers,
        custom_headers_mode: ai_config.custom_headers_mode,
        base_url: use_subscription_base_url.then_some(subscription_base_url),
    })
}

/// Minimal runtime config used to resolve a subscription login.
///
/// Only the fields the resolver reads are populated; image generation never
/// sends a chat request with this config.
fn transient_ai_config(service: &ImageServiceConfig) -> AIConfig {
    AIConfig {
        name: service.name.clone(),
        base_url: service.base_url.clone(),
        request_url: service.request_url.clone().unwrap_or_default(),
        api_key: service.api_key.clone(),
        model: service.model_name.clone(),
        format: String::new(),
        context_window: 0,
        max_tokens: None,
        max_images_per_request: None,
        temperature: None,
        top_p: None,
        inline_think_in_text: false,
        custom_headers: service.custom_headers.clone(),
        custom_headers_mode: service.custom_headers_mode.clone(),
        skip_ssl_verify: service.skip_ssl_verify,
        custom_request_body: None,
        custom_request_body_mode: None,
    }
}

/// Older credential-reuse UI saved Codex logins with the public image dialect.
/// Recover the callable view without rewriting or dropping the stored service.
fn service_with_auth_route(service: &ImageServiceConfig) -> ImageServiceConfig {
    let mut service = service.clone();
    if service.dialect == ImageDialect::OpenAiImages
        && matches!(
            service.auth,
            AuthConfig::Subscription {
                provider: SubscriptionProvider::Codex,
                ..
            }
        )
    {
        service.dialect = ImageDialect::ChatgptCodex;
        service.base_url.clear();
        service.request_url = None;
        // An image-model ID cannot drive a Responses tool call. Resolve a chat
        // model from this subscription's live catalog instead.
        service.model_name.clear();
        service.params.n = Some(1);
    }
    service
}

/// Pure resolution so the selection rules are testable without global config.
pub fn resolve_from_media(
    media: &MediaConfig,
    proxy: Option<ProxyConfig>,
    requested: Option<&str>,
) -> OpenBitFunResult<ResolvedImageService> {
    let service = match requested.map(str::trim).filter(|id| !id.is_empty()) {
        Some(id) => media.enabled_image_service(id).ok_or_else(|| {
            OpenBitFunError::tool(format!(
                "Image generation service '{id}' is not configured or is disabled."
            ))
        })?,
        None => {
            if media.default_image_service.is_none() {
                let enabled = media
                    .image_services
                    .iter()
                    .filter(|service| service.enabled)
                    .count();
                if enabled > 1 {
                    return Err(OpenBitFunError::tool(
                        "Multiple image generation services are enabled but no default is selected. Set one in Settings > Models > Image generation."
                            .to_string(),
                    ));
                }
            }
            media
                .effective_image_service()
                .ok_or_else(no_service_error)?
        }
    };

    let service = service_with_auth_route(service);
    let credentials = ImageServiceCredentials::from_service(&service);
    Ok(ResolvedImageService {
        service,
        credentials,
        proxy,
    })
}

/// Resolve the service the `generate_image` tool should call.
pub async fn resolve_image_service(
    requested: Option<&str>,
) -> OpenBitFunResult<ResolvedImageService> {
    let config_service = get_global_config_service().await?;
    let media: MediaConfig = config_service
        .get_config(Some("media"))
        .await
        .map_err(|err| {
            OpenBitFunError::service(format!("Failed to read image generation config: {err}"))
        })?;

    // Media services inherit the global proxy; a per-service proxy is not a
    // separate user-facing setting.
    let mut resolved = resolve_from_media(&media, configured_proxy().await, requested)?;
    resolved.credentials = resolve_credentials(&resolved.service).await?;
    Ok(resolved)
}

/// Whether any usable image service exists. Used to keep the tool out of the
/// model's tool list when generation would only be able to fail.
pub async fn has_enabled_image_service() -> bool {
    let Ok(config_service) = get_global_config_service().await else {
        return false;
    };
    config_service
        .get_config::<MediaConfig>(Some("media"))
        .await
        .map(|media| media.image_services.iter().any(|service| service.enabled))
        .unwrap_or(false)
}

/// Convert a resolved service into an adapter target for one call.
pub fn adapter_target(service: &ResolvedImageService) -> ImageGenerationTarget<'_> {
    target_for_credentials(
        &service.service,
        &service.credentials,
        service.proxy.clone(),
    )
}

/// Adapter target for one explicit service config and its credential material.
///
/// The settings test action uses this so it exercises exactly the same
/// transport path as the `generate_image` tool, including the resolved
/// subscription login, proxy, custom headers and TLS policy.
pub fn target_for_credentials<'a>(
    service: &'a ImageServiceConfig,
    credentials: &'a ImageServiceCredentials,
    proxy: Option<ProxyConfig>,
) -> ImageGenerationTarget<'a> {
    // A service owns its dialect endpoint. A subscription-supplied endpoint is
    // only a fallback for a draft that leaves the address empty, except on the
    // subscription dialect, whose address belongs to the login rather than to
    // anything a user types here.
    let subscription_endpoint_wins = credentials.base_url.is_some()
        && (service.dialect == ImageDialect::ChatgptCodex || service.base_url.trim().is_empty());
    let base_url = if subscription_endpoint_wins {
        credentials.base_url.as_deref().unwrap_or_default()
    } else {
        service.base_url.as_str()
    };

    ImageGenerationTarget {
        dialect: service.dialect,
        base_url,
        request_url: service.request_url.as_deref(),
        model: &service.model_name,
        api_key: &credentials.api_key,
        custom_headers: credentials.custom_headers.as_ref(),
        custom_headers_mode: credentials.custom_headers_mode.as_deref(),
        skip_ssl_verify: service.skip_ssl_verify,
        proxy,
    }
}

/// Request built from a service's persisted defaults and an explicit prompt.
///
/// A settings test always asks for a single image so a check cannot quietly bill
/// for the configured `n`.
pub fn request_with_defaults(service: &ImageServiceConfig, prompt: &str) -> ImageGenerationRequest {
    let params = &service.params;
    ImageGenerationRequest {
        prompt: prompt.to_string(),
        negative_prompt: params.negative_prompt.clone(),
        size: params.size.clone(),
        n: Some(1),
        quality: params.quality.clone(),
        background: params.background.clone(),
        output_format: params.output_format.clone(),
        watermark: params.watermark,
        prompt_extend: params.prompt_extend,
        seed: params.seed,
    }
}

/// Outcome of one settings-page connectivity check.
#[derive(Debug, Clone, serde::Serialize)]
pub struct ImageServiceTestOutcome {
    pub success: bool,
    pub elapsed_ms: u64,
    /// [`ImageGenerationErrorKind::wire_name`] when the call failed.
    pub error_kind: Option<String>,
    pub message: Option<String>,
    pub mime: Option<String>,
    pub image_base64: Option<String>,
}

impl ImageServiceTestOutcome {
    fn failure(elapsed_ms: u64, error: &ImageGenerationError) -> Self {
        Self {
            success: false,
            elapsed_ms,
            error_kind: Some(error.kind.wire_name().to_string()),
            message: Some(error.message.clone()),
            mime: None,
            image_base64: None,
        }
    }
}

/// Generate one real image with an unsaved service draft.
///
/// This bills the user's provider, so the caller must present it as a real
/// generation rather than a free probe.
pub async fn test_service(service: &ImageServiceConfig, prompt: &str) -> ImageServiceTestOutcome {
    let started = std::time::Instant::now();
    let service = service_with_auth_route(service);
    let credentials = match resolve_credentials(&service).await {
        Ok(credentials) => credentials,
        Err(error) => {
            return ImageServiceTestOutcome {
                success: false,
                elapsed_ms: started.elapsed().as_millis() as u64,
                error_kind: Some(ImageGenerationErrorKind::Auth.wire_name().to_string()),
                message: Some(error.to_string()),
                mime: None,
                image_base64: None,
            }
        }
    };

    let proxy = configured_proxy().await;
    let target = target_for_credentials(&service, &credentials, proxy);
    let request = request_with_defaults(&service, prompt);

    match generate(&target, request).await {
        Ok(response) => {
            let elapsed_ms = started.elapsed().as_millis() as u64;
            match response.images.into_iter().next() {
                Some(image) => success_outcome(elapsed_ms, image),
                None => ImageServiceTestOutcome::failure(
                    elapsed_ms,
                    &ImageGenerationError {
                        kind: ImageGenerationErrorKind::EmptyResult,
                        message: "The provider returned no image".to_string(),
                    },
                ),
            }
        }
        Err(error) => {
            ImageServiceTestOutcome::failure(started.elapsed().as_millis() as u64, &error)
        }
    }
}

fn success_outcome(elapsed_ms: u64, image: GeneratedImage) -> ImageServiceTestOutcome {
    let base64 = image.base64();
    ImageServiceTestOutcome {
        success: true,
        elapsed_ms,
        error_kind: None,
        message: None,
        mime: Some(image.mime),
        image_base64: Some(base64),
    }
}

/// Global HTTP proxy inherited by media services, when one is configured.
async fn configured_proxy() -> Option<ProxyConfig> {
    let config_service = get_global_config_service().await.ok()?;
    let ai = config_service
        .get_config::<ServiceAIConfig>(Some("ai"))
        .await
        .ok()?;
    ai.proxy.enabled.then_some(ai.proxy)
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::service::config::types::{ImageDialect, ImageGenerationParams};

    fn service(id: &str, enabled: bool) -> ImageServiceConfig {
        ImageServiceConfig {
            id: id.to_string(),
            name: id.to_string(),
            dialect: ImageDialect::OpenAiImages,
            base_url: "https://api.openai.com/v1".to_string(),
            model_name: "gpt-image-1".to_string(),
            api_key: "sk-test".to_string(),
            enabled,
            params: ImageGenerationParams::default(),
            ..ImageServiceConfig::default()
        }
    }

    fn media(services: Vec<ImageServiceConfig>, default: Option<&str>) -> MediaConfig {
        MediaConfig {
            image_services: services,
            default_image_service: default.map(str::to_string),
        }
    }

    #[test]
    fn explicit_request_wins_over_the_default() {
        let media = media(
            vec![service("svc-a", true), service("svc-b", true)],
            Some("svc-a"),
        );

        let resolved = resolve_from_media(&media, None, Some("svc-b")).unwrap();

        assert_eq!(resolved.service.id, "svc-b");
    }

    #[test]
    fn legacy_reused_codex_login_uses_its_subscription_route_without_mutating_storage() {
        let mut saved = service("legacy", true);
        saved.auth = AuthConfig::Subscription {
            provider: SubscriptionProvider::Codex,
            plan: None,
            account_id: None,
        };
        saved.request_url = Some("https://api.openai.com/v1/images/generations".to_string());
        let media: MediaConfig = serde_json::from_value(serde_json::json!({
            "image_services": [saved], "default_image_service": "legacy"
        }))
        .unwrap();
        let snapshot = serde_json::to_value(&media).unwrap();
        let resolved = resolve_from_media(&media, None, None).unwrap();
        assert_eq!(resolved.service.dialect, ImageDialect::ChatgptCodex);
        assert!(resolved.service.model_name.is_empty());
        assert!(resolved.service.base_url.is_empty());
        assert_eq!(resolved.service.request_url, None);
        assert_eq!(serde_json::to_value(&media).unwrap(), snapshot);
    }

    #[tokio::test]
    async fn account_pools_fail_explicitly_before_using_inline_api_credentials() {
        let mut saved = service("pool", true);
        saved.auth = AuthConfig::SubscriptionPool {
            provider: SubscriptionProvider::Codex,
            accounts: vec!["account-a".to_string()],
            revision: 1,
        };
        let error = resolve_credentials(&saved).await.unwrap_err();
        assert!(error
            .to_string()
            .contains("does not support subscription account pools"));
    }

    #[test]
    fn explicit_subscription_models_and_api_key_gateways_keep_their_configuration() {
        let mut subscription = service("codex", true);
        subscription.dialect = ImageDialect::ChatgptCodex;
        subscription.auth = AuthConfig::Subscription {
            provider: SubscriptionProvider::Codex,
            plan: None,
            account_id: None,
        };
        subscription.model_name = "account-model".to_string();
        assert_eq!(service_with_auth_route(&subscription), subscription);
        let mut api = service("gateway", true);
        api.request_url = Some("https://images.example/generate".to_string());
        assert_eq!(service_with_auth_route(&api), api);
    }

    #[test]
    fn explicit_request_must_be_enabled() {
        let media = media(vec![service("svc-a", false)], None);

        let error = resolve_from_media(&media, None, Some("svc-a")).unwrap_err();

        assert!(error.to_string().contains("not configured or is disabled"));
    }

    #[test]
    fn default_service_is_used_when_no_request_names_one() {
        let media = media(
            vec![service("svc-a", true), service("svc-b", true)],
            Some("svc-b"),
        );

        assert_eq!(
            resolve_from_media(&media, None, None).unwrap().service.id,
            "svc-b"
        );
    }

    #[test]
    fn a_single_enabled_service_needs_no_default() {
        let media = media(vec![service("svc-a", true), service("svc-b", false)], None);

        assert_eq!(
            resolve_from_media(&media, None, None).unwrap().service.id,
            "svc-a"
        );
    }

    #[test]
    fn ambiguous_services_without_a_default_are_reported() {
        let media = media(vec![service("svc-a", true), service("svc-b", true)], None);

        let error = resolve_from_media(&media, None, None).unwrap_err();

        assert!(error.to_string().contains("no default is selected"));
    }

    #[test]
    fn no_services_reports_the_settings_entry_point() {
        let error = resolve_from_media(&media(Vec::new(), None), None, None).unwrap_err();

        assert!(error
            .to_string()
            .contains("Settings > Models > Image generation"));
    }

    #[test]
    fn an_api_key_service_resolves_its_own_credentials() {
        let mut config = service("svc-a", true);
        config.custom_headers = Some(HashMap::from([(
            "x-tenant".to_string(),
            "acme".to_string(),
        )]));

        let credentials = ImageServiceCredentials::from_service(&config);

        assert_eq!(credentials.api_key, "sk-test");
        assert_eq!(credentials.base_url, None);
        assert_eq!(
            credentials
                .custom_headers
                .as_ref()
                .and_then(|headers| headers.get("x-tenant"))
                .map(String::as_str),
            Some("acme")
        );
    }

    #[test]
    fn subscription_endpoint_only_fills_a_missing_service_base_url() {
        let mut config = service("svc-a", true);
        config.base_url = String::new();
        let credentials = ImageServiceCredentials {
            api_key: "oauth-token".to_string(),
            base_url: Some("https://chatgpt.example/backend".to_string()),
            ..ImageServiceCredentials::default()
        };

        let target = target_for_credentials(&config, &credentials, None);

        assert_eq!(target.base_url, "https://chatgpt.example/backend");
        assert_eq!(target.api_key, "oauth-token");
    }

    #[test]
    fn a_service_base_url_survives_a_subscription_login() {
        let config = service("svc-a", true);
        let credentials = ImageServiceCredentials {
            api_key: "oauth-token".to_string(),
            base_url: Some("https://chatgpt.example/backend".to_string()),
            ..ImageServiceCredentials::default()
        };

        let target = target_for_credentials(&config, &credentials, None);

        assert_eq!(target.base_url, "https://api.openai.com/v1");
    }

    #[test]
    fn adapter_target_carries_the_service_fields() {
        let mut config = service("svc-a", true);
        config.custom_headers_mode = Some("replace".to_string());
        let resolved = ResolvedImageService {
            credentials: ImageServiceCredentials::from_service(&config),
            service: config,
            proxy: None,
        };

        let target = adapter_target(&resolved);

        assert_eq!(target.model, "gpt-image-1");
        assert_eq!(target.custom_headers_mode, Some("replace"));
        assert_eq!(target.dialect, ImageDialect::OpenAiImages);
        assert_eq!(target.api_key, "sk-test");
    }
}
