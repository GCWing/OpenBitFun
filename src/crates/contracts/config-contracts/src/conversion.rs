use crate::types::AIModelConfig;
use crate::types::{
    automatic_max_output_tokens, is_valid_configured_max_output_tokens,
    DEFAULT_MODEL_CONTEXT_WINDOW_TOKENS, MAX_CONFIGURED_OUTPUT_TOKENS_RATIO_PERCENT,
    MIN_MODEL_CONTEXT_WINDOW_TOKENS,
};
use log::warn;
pub use openbitfun_core_types::AIConfig;

fn append_endpoint(base_url: &str, endpoint: &str) -> String {
    let base = base_url.trim();
    if base.is_empty() {
        return endpoint.to_string();
    }
    if base.ends_with(endpoint) {
        return base.to_string();
    }
    format!("{}/{}", base.trim_end_matches('/'), endpoint)
}

fn gemini_base_url(url: &str) -> &str {
    let mut u = url;
    if let Some(pos) = u.find("/v1beta") {
        u = &u[..pos];
    }
    if let Some(pos) = u.find("/models/") {
        u = &u[..pos];
    }
    u.trim_end_matches('/')
}

fn resolve_gemini_request_url(base_url: &str, model_name: &str) -> String {
    let trimmed = base_url.trim().trim_end_matches('/');
    if trimmed.is_empty() {
        return String::new();
    }

    if let Some(stripped) = trimmed.strip_suffix('#') {
        return stripped.trim_end_matches('/').to_string();
    }

    let model = model_name.trim();
    if model.is_empty() {
        return trimmed.to_string();
    }

    let base = gemini_base_url(trimmed);
    format!(
        "{}/v1beta/models/{}:streamGenerateContent?alt=sse",
        base, model
    )
}

pub fn resolve_request_url(base_url: &str, provider: &str, model_name: &str) -> String {
    let trimmed = base_url.trim().trim_end_matches('/').to_string();
    if trimmed.is_empty() {
        return String::new();
    }

    if let Some(stripped) = trimmed.strip_suffix('#') {
        return stripped.trim_end_matches('/').to_string();
    }

    match provider.trim().to_ascii_lowercase().as_str() {
        "openai" | "nvidia" | "openrouter" => append_endpoint(&trimmed, "chat/completions"),
        "response" | "responses" => append_endpoint(&trimmed, "responses"),
        "anthropic" => append_endpoint(&trimmed, "v1/messages"),
        "gemini" | "google" => resolve_gemini_request_url(&trimmed, model_name),
        _ => trimmed,
    }
}

impl TryFrom<AIModelConfig> for AIConfig {
    type Error = String;

    fn try_from(other: AIModelConfig) -> Result<Self, Self::Error> {
        if crate::protected_account_models::is_guarded_account_model(&other) {
            return Err("This subscription account binding requires an account-capable OpenBitFun; the original configuration was preserved".into());
        }
        if !other.supports_text_generation() {
            return Err(format!(
                "Model '{}' does not support text_chat and cannot be used for text generation",
                other.name
            ));
        }

        if other.max_images_per_request == Some(0) {
            return Err(format!(
                "Model '{}' max_images_per_request must be greater than 0",
                other.name
            ));
        }

        let custom_request_body = if let Some(body_str) = other
            .custom_request_body
            .as_deref()
            .filter(|body| !body.trim().is_empty())
        {
            match serde_json::from_str::<serde_json::Value>(body_str) {
                Ok(value) => Some(value),
                Err(e) => {
                    warn!(
                        "Failed to parse custom_request_body: {}, config: {}",
                        e, other.name
                    );
                    None
                }
            }
        } else {
            None
        };

        crate::normalization::validate_image_budget_request_body(
            other.max_images_per_request,
            custom_request_body.as_ref(),
        )
        .map_err(|error| format!("Model '{}' {error}", other.name))?;

        let request_url = other
            .request_url
            .clone()
            .filter(|url| !url.is_empty())
            .unwrap_or_else(|| {
                resolve_request_url(&other.base_url, &other.provider, &other.model_name)
            });

        let context_window = other
            .context_window
            .unwrap_or(DEFAULT_MODEL_CONTEXT_WINDOW_TOKENS);
        if context_window < MIN_MODEL_CONTEXT_WINDOW_TOKENS {
            return Err(format!(
                "Model '{}' context_window must be at least {}",
                other.name, MIN_MODEL_CONTEXT_WINDOW_TOKENS
            ));
        }

        let max_tokens = match other.max_tokens {
            Some(configured_max_tokens)
                if is_valid_configured_max_output_tokens(context_window, configured_max_tokens) =>
            {
                configured_max_tokens
            }
            Some(configured_max_tokens) => {
                let automatic_max_tokens = automatic_max_output_tokens(context_window);
                let maximum_allowed_tokens = u64::from(context_window)
                    * u64::from(MAX_CONFIGURED_OUTPUT_TOKENS_RATIO_PERCENT)
                    / 100;
                warn!(
                    "Invalid model max_tokens; falling back to automatic output limit: model_id={}, model_name={}, context_window={}, configured_max_tokens={}, maximum_allowed_tokens={}, automatic_max_tokens={}",
                    other.id,
                    other.name,
                    context_window,
                    configured_max_tokens,
                    maximum_allowed_tokens,
                    automatic_max_tokens
                );
                automatic_max_tokens
            }
            None => automatic_max_output_tokens(context_window),
        };

        Ok(AIConfig {
            name: other.name.clone(),
            base_url: other.base_url.clone(),
            request_url,
            api_key: other.api_key.clone(),
            model: other.model_name.clone(),
            format: other.provider.clone(),
            context_window,
            max_tokens: Some(max_tokens),
            max_images_per_request: other.max_images_per_request,
            temperature: other.temperature,
            top_p: other.top_p,
            inline_think_in_text: other.inline_think_in_text,
            custom_headers: other.custom_headers,
            custom_headers_mode: other.custom_headers_mode,
            skip_ssl_verify: other.skip_ssl_verify,
            custom_request_body,
            custom_request_body_mode: other.custom_request_body_mode,
        })
    }
}

#[cfg(test)]
mod tests {
    use super::{resolve_request_url, AIConfig};
    use crate::types::{AIModelConfig, ModelCapability, ModelCategory};

    #[test]
    fn resolves_openai_request_url() {
        assert_eq!(
            resolve_request_url("https://api.openai.com/v1", "openai", ""),
            "https://api.openai.com/v1/chat/completions"
        );
    }

    #[test]
    fn resolves_responses_request_url() {
        assert_eq!(
            resolve_request_url("https://api.openai.com/v1", "responses", ""),
            "https://api.openai.com/v1/responses"
        );
    }

    #[test]
    fn resolves_response_alias_request_url() {
        assert_eq!(
            resolve_request_url("https://api.openai.com/v1", "response", ""),
            "https://api.openai.com/v1/responses"
        );
    }

    #[test]
    fn keeps_forced_request_url() {
        assert_eq!(
            resolve_request_url("https://api.openai.com/v1/responses#", "responses", ""),
            "https://api.openai.com/v1/responses"
        );
    }

    #[test]
    fn resolves_gemini_request_url_with_v1beta() {
        assert_eq!(
            resolve_request_url(
                "https://generativelanguage.googleapis.com/v1beta",
                "gemini",
                "gemini-2.5-pro"
            ),
            "https://generativelanguage.googleapis.com/v1beta/models/gemini-2.5-pro:streamGenerateContent?alt=sse"
        );
    }

    #[test]
    fn resolves_gemini_request_url_bare_host() {
        assert_eq!(
            resolve_request_url("https://api.openbitfun.com", "gemini", "gemini-2.5-pro"),
            "https://api.openbitfun.com/v1beta/models/gemini-2.5-pro:streamGenerateContent?alt=sse"
        );
    }

    #[test]
    fn resolves_nvidia_request_url() {
        assert_eq!(
            resolve_request_url("https://integrate.api.nvidia.com/v1", "nvidia", ""),
            "https://integrate.api.nvidia.com/v1/chat/completions"
        );
    }

    #[test]
    fn resolves_openrouter_request_url() {
        assert_eq!(
            resolve_request_url("https://openrouter.ai/api/v1", "openrouter", ""),
            "https://openrouter.ai/api/v1/chat/completions"
        );
    }

    fn base_model_config() -> AIModelConfig {
        AIModelConfig {
            id: "model_1".to_string(),
            name: "Provider".to_string(),
            provider: "openai".to_string(),
            model_name: "test-model".to_string(),
            base_url: "https://example.com/v1".to_string(),
            request_url: Some("https://example.com/v1/chat/completions".to_string()),
            api_key: "key".to_string(),
            context_window: Some(128000),
            max_tokens: Some(4096),
            max_images_per_request: None,
            temperature: None,
            top_p: None,
            enabled: true,
            category: ModelCategory::GeneralChat,
            capabilities: vec![],
            recommended_for: vec![],
            metadata: None,
            reasoning: None,
            inline_think_in_text: false,
            custom_headers: None,
            custom_headers_mode: None,
            skip_ssl_verify: false,
            custom_request_body: None,
            custom_request_body_mode: None,
            auth: Default::default(),
            channel_routing: None,
        }
    }

    #[test]
    fn missing_reasoning_default_does_not_change_runtime_config() {
        let config = AIConfig::try_from(base_model_config()).expect("conversion should succeed");
        assert_eq!(config.model, "test-model");
    }

    #[test]
    fn image_budget_preserves_legacy_payloads_and_runtime_round_trips() {
        let legacy_payload = serde_json::to_value(base_model_config()).unwrap();
        assert!(legacy_payload.get("max_images_per_request").is_none());
        let legacy: AIModelConfig = serde_json::from_value(legacy_payload.clone()).unwrap();
        assert_eq!(legacy.max_images_per_request, None);
        assert_eq!(serde_json::to_value(&legacy).unwrap(), legacy_payload);
        let fingerprint = crate::types::model_runtime_binding_fingerprint(&legacy);
        let mut limited = legacy.clone();
        limited.max_images_per_request = Some(3);
        let saved = serde_json::to_value(&limited).unwrap();
        assert_eq!(saved["max_images_per_request"], 3);
        let loaded: AIModelConfig = serde_json::from_value(saved).unwrap();
        let runtime = AIConfig::try_from(loaded).unwrap();
        assert_eq!(runtime.max_images_per_request, Some(3));
        let runtime_payload = serde_json::to_value(runtime).unwrap();
        let restored: AIConfig = serde_json::from_value(runtime_payload).unwrap();
        assert_eq!(restored.max_images_per_request, Some(3));
        assert_ne!(
            crate::types::model_runtime_binding_fingerprint(&limited),
            fingerprint
        );
        limited.max_images_per_request = None;
        assert_eq!(
            crate::types::model_runtime_binding_fingerprint(&limited),
            fingerprint
        );

        let runtime = AIConfig::try_from(legacy).unwrap();
        let payload = serde_json::to_value(runtime).unwrap();
        assert!(payload.get("max_images_per_request").is_none());
        let restored: AIConfig = serde_json::from_value(payload).unwrap();
        assert_eq!(restored.max_images_per_request, None);
    }

    #[test]
    fn image_budget_rejects_zero_without_discarding_model_configuration() {
        let mut model = base_model_config();
        model.max_images_per_request = Some(0);
        assert!(crate::normalization::validate_model_config(&model, 0)
            .unwrap_err()
            .contains("max_images_per_request"));
        assert!(AIConfig::try_from(model.clone())
            .unwrap_err()
            .contains("max_images_per_request"));
        let mut config = crate::GlobalConfig::default();
        config.ai.models.push(model.clone());
        crate::normalization::recover_persisted_config(&mut config);
        assert_eq!(config.ai.models.len(), 1);
        assert!(!config.ai.models[0].enabled);
        assert_eq!(config.ai.models[0].api_key, model.api_key);
        assert_eq!(config.ai.models[0].max_images_per_request, Some(0));
    }

    #[test]
    fn image_budget_rejects_wire_message_overrides_but_keeps_other_custom_options() {
        for key in ["messages", "input", "contents"] {
            let mut model = base_model_config();
            model.custom_request_body = Some(serde_json::json!({key: []}).to_string());
            assert!(
                AIConfig::try_from(model.clone()).is_ok(),
                "legacy override: {key}"
            );
            model.max_images_per_request = Some(3);
            assert!(crate::normalization::validate_model_config(&model, 0)
                .unwrap_err()
                .contains("custom_request_body"));
            assert!(AIConfig::try_from(model)
                .unwrap_err()
                .contains("custom_request_body"));
        }
        let mut model = base_model_config();
        model.max_images_per_request = Some(3);
        model.custom_request_body = Some(r#"{"temperature":0.2}"#.into());
        assert!(crate::normalization::validate_model_config(&model, 0).is_ok());
        assert_eq!(
            AIConfig::try_from(model)
                .unwrap()
                .custom_request_body
                .unwrap()["temperature"],
            0.2
        );
    }

    #[test]
    fn accepts_legacy_missing_null_and_blank_custom_request_bodies() {
        for body in [
            None,
            Some(serde_json::Value::Null),
            Some("".into()),
            Some(" \n\t ".into()),
        ] {
            let mut payload = serde_json::to_value(base_model_config()).unwrap();
            payload
                .as_object_mut()
                .unwrap()
                .remove("custom_request_body");
            if let Some(body) = body {
                payload["custom_request_body"] = body;
            }
            let model: AIModelConfig = serde_json::from_value(payload).unwrap();
            let round_trip: AIModelConfig =
                serde_json::from_value(serde_json::to_value(model).unwrap()).unwrap();
            let config =
                AIConfig::try_from(round_trip).expect("legacy config should remain usable");
            assert_eq!(config.custom_request_body, None);
        }
    }

    #[test]
    fn preserves_non_empty_custom_request_body_and_mode() {
        let mut model = base_model_config();
        model.custom_request_body = Some(" \n{\"temperature\":0.2}\n ".to_string());
        model.custom_request_body_mode = Some("trim".to_string());

        let config = AIConfig::try_from(model).expect("conversion should succeed");
        assert_eq!(
            config.custom_request_body,
            Some(serde_json::json!({"temperature": 0.2}))
        );
        assert_eq!(config.custom_request_body_mode.as_deref(), Some("trim"));
    }

    #[test]
    fn ignores_malformed_non_empty_custom_request_body() {
        let mut model = base_model_config();
        model.custom_request_body = Some("{".to_string());

        let config =
            AIConfig::try_from(model).expect("existing parse fallback should remain usable");
        assert_eq!(config.custom_request_body, None);
    }

    #[test]
    fn derives_the_largest_output_tier_within_one_quarter_of_context() {
        for (context_window, expected_max_tokens) in [
            (32_000, 8_000),
            (48_000, 8_000),
            (64_000, 16_000),
            (128_000, 32_000),
            (128_128, 32_000),
            (256_000, 64_000),
            (1_000_000, 64_000),
        ] {
            let mut model = base_model_config();
            model.context_window = Some(context_window);
            model.max_tokens = None;

            let config = AIConfig::try_from(model).expect("conversion should succeed");

            assert_eq!(config.max_tokens, Some(expected_max_tokens));
        }
    }

    #[test]
    fn preserves_a_configured_output_limit_within_forty_percent_of_context() {
        let mut model = base_model_config();
        model.context_window = Some(1_000_000);
        model.max_tokens = Some(384_000);

        let config = AIConfig::try_from(model).expect("conversion should succeed");

        assert_eq!(config.max_tokens, Some(384_000));
    }

    #[test]
    fn falls_back_to_the_automatic_output_limit_when_configured_limit_is_too_large() {
        let mut model = base_model_config();
        model.context_window = Some(128_000);
        model.max_tokens = Some(64_000);

        let config = AIConfig::try_from(model).expect("conversion should succeed");

        assert_eq!(config.max_tokens, Some(32_000));
    }

    #[test]
    fn rejects_a_context_window_smaller_than_the_supported_minimum() {
        let mut model = base_model_config();
        model.context_window = Some(16_000);

        let error = AIConfig::try_from(model).expect_err("conversion should reject small context");

        assert!(error.contains("at least 32000"));
    }

    #[test]
    fn rejects_pure_speech_models_at_the_text_generation_boundary() {
        let mut model = base_model_config();
        model.category = ModelCategory::SpeechRecognition;
        model.capabilities = vec![ModelCapability::SpeechRecognition];
        model.context_window = None;
        model.max_tokens = None;

        let error = AIConfig::try_from(model).expect_err("speech model is not a chat model");

        assert!(error.contains("does not support text_chat"));
    }
}
