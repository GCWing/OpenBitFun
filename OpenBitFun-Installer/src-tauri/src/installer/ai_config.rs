//! Map installer `ModelConfig` to shared AI adapter config.

use crate::installer::types::ModelConfig;
use log::warn;
use openbitfun_ai_adapters::types::{resolve_request_url, AIConfig};

/// Build `AIConfig` for the shared AI client.
pub(super) fn ai_config_from_installer_model(m: &ModelConfig) -> Result<AIConfig, String> {
    let custom_request_body = if let Some(body_str) = &m.custom_request_body {
        let t = body_str.trim();
        if t.is_empty() {
            None
        } else {
            match serde_json::from_str::<serde_json::Value>(t) {
                Ok(value) => Some(value),
                Err(e) => {
                    warn!("Failed to parse custom_request_body: {}", e);
                    None
                }
            }
        }
    } else {
        None
    };

    let format_key = m.format.trim();
    if format_key.is_empty() {
        return Err("Model format is required".to_string());
    }

    let request_url = resolve_request_url(m.base_url.trim(), format_key, m.model_name.trim());

    Ok(AIConfig {
        name: m
            .config_name
            .as_deref()
            .map(str::trim)
            .filter(|s| !s.is_empty())
            .map(|s| s.to_string())
            .unwrap_or_else(|| format!("{} - {}", m.provider.trim(), m.model_name.trim())),
        base_url: m.base_url.trim().to_string(),
        request_url,
        api_key: m.api_key.trim().to_string(),
        model: m.model_name.trim().to_string(),
        format: format_key.to_string(),
        context_window: 128_128,
        max_tokens: None,
        max_images_per_request: None,
        temperature: None,
        top_p: None,
        inline_think_in_text: false,
        custom_headers: m.custom_headers.clone(),
        custom_headers_mode: m.custom_headers_mode.clone(),
        skip_ssl_verify: m.skip_ssl_verify.unwrap_or(false),
        custom_request_body,
        custom_request_body_mode: None,
    })
}

/// Whether to run the image-input check (same rules as desktop `test_ai_config_connection`).
pub(super) fn supports_image_input(m: &ModelConfig) -> bool {
    m.capabilities
        .as_ref()
        .map(|c| {
            c.iter()
                .any(|x| x.eq_ignore_ascii_case("image_understanding"))
        })
        .unwrap_or(false)
        || m.category
            .as_deref()
            .map(|c| c.eq_ignore_ascii_case("multimodal"))
            .unwrap_or(false)
}
