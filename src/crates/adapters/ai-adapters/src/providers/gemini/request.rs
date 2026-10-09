use super::GeminiMessageConverter;
use crate::client::sse::execute_sse_request;
use crate::client::{AIClient, StreamResponse};
use crate::providers::shared;
use crate::stream::handle_gemini_stream;
use crate::trace::ModelExchangeTraceConfig;
use crate::types::{
    Message, ModelRequestContext, ReasoningPresetAction, ReasoningPresetDescriptor, ToolDefinition,
};
use anyhow::{anyhow, Result};
use log::debug;
use reqwest::RequestBuilder;

pub(crate) fn apply_headers(
    client: &AIClient,
    builder: RequestBuilder,
    url: &str,
) -> RequestBuilder {
    shared::apply_header_policy(client, builder, |mut builder| {
        builder = builder
            .header("Content-Type", "application/json")
            .header("x-goog-api-key", &client.config.api_key);

        // Google interprets Authorization as an OAuth access token, not an AI
        // Studio API key. Keep Bearer compatibility for third-party gateways.
        if !shared::is_https_endpoint(url, "generativelanguage.googleapis.com", "") {
            builder = builder.header("Authorization", format!("Bearer {}", client.config.api_key));
        }

        if client.config.base_url.contains("openbitfun.com") {
            builder = builder.header("X-Verification-Code", "from_openbitfun");
        }

        builder
    })
}

pub(crate) fn gemini_base_url(url: &str) -> &str {
    let mut value = url.trim().trim_end_matches('/');
    if let Some(pos) = value.find("/v1beta") {
        value = &value[..pos];
    }
    if let Some(pos) = value.find("/models/") {
        value = &value[..pos];
    }
    value.trim_end_matches('/')
}

pub(crate) fn resolve_request_url(base_url: &str, model_name: &str) -> String {
    let trimmed = base_url.trim().trim_end_matches('/');
    if trimmed.is_empty() {
        return String::new();
    }

    let base = gemini_base_url(trimmed);
    let encoded_model = urlencoding::encode(model_name.trim());
    format!(
        "{}/v1beta/models/{}:streamGenerateContent?alt=sse",
        base, encoded_model
    )
}

fn ensure_generation_config(
    request_body: &mut serde_json::Value,
) -> &mut serde_json::Map<String, serde_json::Value> {
    if !request_body
        .get("generationConfig")
        .is_some_and(serde_json::Value::is_object)
    {
        request_body["generationConfig"] = serde_json::json!({});
    }

    request_body["generationConfig"]
        .as_object_mut()
        .expect("generationConfig must be an object")
}

fn insert_generation_field(
    request_body: &mut serde_json::Value,
    key: &str,
    value: serde_json::Value,
) {
    ensure_generation_config(request_body).insert(key.to_string(), value);
}

fn compile_reasoning_action(
    preset: &ReasoningPresetDescriptor,
    action: &ReasoningPresetAction,
    request_body: &mut serde_json::Value,
    configured_model: &str,
    max_tokens: Option<u32>,
) -> Result<bool> {
    let model = preset
        .execution_model
        .as_deref()
        .unwrap_or(configured_model)
        .trim()
        .to_ascii_lowercase();
    let is_generic_reasoning = shared::is_generic_reasoning_preset(preset);
    match action {
        ReasoningPresetAction::Effort { value }
            if model.starts_with("gemini-3-") || is_generic_reasoning =>
        {
            let value = if is_generic_reasoning {
                shared::normalize_generic_reasoning_effort(value)
                    .ok_or_else(|| anyhow!("Generic reasoning effort '{}' is unsupported", value))?
            } else {
                value.trim()
            };
            insert_generation_field(
                request_body,
                "thinkingConfig",
                serde_json::json!({
                    "includeThoughts": true,
                    "thinkingLevel": value.to_ascii_uppercase(),
                }),
            );
            Ok(true)
        }
        ReasoningPresetAction::BudgetTokens { value } if model.starts_with("gemini-2.5-") => {
            if max_tokens.is_some_and(|limit| *value > limit) {
                return Err(anyhow!(
                    "Gemini reasoning budget {} exceeds max output tokens {}",
                    value,
                    max_tokens.unwrap_or_default()
                ));
            }
            insert_generation_field(
                request_body,
                "thinkingConfig",
                serde_json::json!({
                    "includeThoughts": true,
                    "thinkingBudget": value,
                }),
            );
            Ok(true)
        }
        ReasoningPresetAction::Toggle { enabled } if model.starts_with("gemini-2.5-flash") => {
            insert_generation_field(
                request_body,
                "thinkingConfig",
                serde_json::json!({
                    "includeThoughts": enabled,
                    "thinkingBudget": if *enabled { -1 } else { 0 },
                }),
            );
            Ok(true)
        }
        ReasoningPresetAction::Toggle { enabled } if is_generic_reasoning => {
            insert_generation_field(
                request_body,
                "thinkingConfig",
                if *enabled {
                    serde_json::json!({
                        "includeThoughts": true,
                        "thinkingLevel": "MEDIUM",
                    })
                } else {
                    serde_json::json!({
                        "includeThoughts": false,
                        "thinkingBudget": 0,
                    })
                },
            );
            Ok(true)
        }
        ReasoningPresetAction::Effort { .. }
        | ReasoningPresetAction::Toggle { .. }
        | ReasoningPresetAction::BudgetTokens { .. } => Ok(false),
        ReasoningPresetAction::RequestPatch { .. } => {
            unreachable!("patches are compiled by shared code")
        }
    }
}

fn normalize_stop_sequences(value: &serde_json::Value) -> Option<serde_json::Value> {
    match value {
        serde_json::Value::String(sequence) => {
            Some(serde_json::Value::Array(vec![serde_json::Value::String(
                sequence.clone(),
            )]))
        }
        serde_json::Value::Array(items) => {
            let sequences = items
                .iter()
                .filter_map(|item| item.as_str().map(|sequence| sequence.to_string()))
                .map(serde_json::Value::String)
                .collect::<Vec<_>>();

            if sequences.is_empty() {
                None
            } else {
                Some(serde_json::Value::Array(sequences))
            }
        }
        _ => None,
    }
}

fn apply_response_format_translation(
    request_body: &mut serde_json::Value,
    response_format: &serde_json::Value,
) -> bool {
    match response_format {
        serde_json::Value::String(kind) if matches!(kind.as_str(), "json" | "json_object") => {
            insert_generation_field(
                request_body,
                "responseMimeType",
                serde_json::Value::String("application/json".to_string()),
            );
            true
        }
        serde_json::Value::Object(map) => {
            let Some(kind) = map.get("type").and_then(serde_json::Value::as_str) else {
                return false;
            };

            match kind {
                "json" | "json_object" => {
                    insert_generation_field(
                        request_body,
                        "responseMimeType",
                        serde_json::Value::String("application/json".to_string()),
                    );
                    true
                }
                "json_schema" => {
                    insert_generation_field(
                        request_body,
                        "responseMimeType",
                        serde_json::Value::String("application/json".to_string()),
                    );

                    if let Some(schema) = map
                        .get("json_schema")
                        .and_then(serde_json::Value::as_object)
                        .and_then(|json_schema| json_schema.get("schema"))
                        .or_else(|| map.get("schema"))
                    {
                        insert_generation_field(
                            request_body,
                            "responseJsonSchema",
                            GeminiMessageConverter::sanitize_schema(schema.clone()),
                        );
                    }

                    true
                }
                _ => false,
            }
        }
        _ => false,
    }
}

fn translate_extra_body(
    request_body: &mut serde_json::Value,
    extra_obj: &mut serde_json::Map<String, serde_json::Value>,
) {
    if let Some(max_tokens) = extra_obj.remove("max_tokens") {
        insert_generation_field(request_body, "maxOutputTokens", max_tokens);
    }

    if let Some(temperature) = extra_obj.remove("temperature") {
        insert_generation_field(request_body, "temperature", temperature);
    }

    let top_p = extra_obj
        .remove("top_p")
        .or_else(|| extra_obj.remove("topP"));
    if let Some(top_p) = top_p {
        insert_generation_field(request_body, "topP", top_p);
    }

    if let Some(stop_sequences) = extra_obj.get("stop").and_then(normalize_stop_sequences) {
        extra_obj.remove("stop");
        insert_generation_field(request_body, "stopSequences", stop_sequences);
    }

    if let Some(response_mime_type) = extra_obj
        .remove("responseMimeType")
        .or_else(|| extra_obj.remove("response_mime_type"))
    {
        insert_generation_field(request_body, "responseMimeType", response_mime_type);
    }

    if let Some(response_schema) = extra_obj
        .remove("responseJsonSchema")
        .or_else(|| extra_obj.remove("responseSchema"))
        .or_else(|| extra_obj.remove("response_schema"))
    {
        insert_generation_field(
            request_body,
            "responseJsonSchema",
            GeminiMessageConverter::sanitize_schema(response_schema),
        );
    }

    if let Some(response_format) = extra_obj.get("response_format").cloned() {
        if apply_response_format_translation(request_body, &response_format) {
            extra_obj.remove("response_format");
        }
    }
}

fn try_build_request_body_with_context(
    client: &AIClient,
    system_instruction: Option<serde_json::Value>,
    contents: Vec<serde_json::Value>,
    gemini_tools: Option<Vec<serde_json::Value>>,
    extra_body: Option<serde_json::Value>,
    request_context: Option<&ModelRequestContext>,
) -> Result<serde_json::Value> {
    let mut request_body = serde_json::json!({
        "contents": contents,
    });

    if let Some(system_instruction) = system_instruction {
        request_body["systemInstruction"] = system_instruction;
    }

    if let Some(max_tokens) = client.config.max_tokens {
        insert_generation_field(
            &mut request_body,
            "maxOutputTokens",
            serde_json::json!(max_tokens),
        );
    }

    if let Some(temperature) = client.config.temperature {
        insert_generation_field(
            &mut request_body,
            "temperature",
            serde_json::json!(temperature),
        );
    }

    if let Some(top_p) = client.config.top_p {
        insert_generation_field(&mut request_body, "topP", serde_json::json!(top_p));
    }

    let base_reasoning_fields = shared::capture_reasoning_fields(
        &request_body,
        &[],
        &[("generationConfig", "thinkingConfig")],
    );

    if let Some(tools) = gemini_tools {
        let tool_names = tools
            .iter()
            .flat_map(shared::collect_function_declaration_names_or_object_keys)
            .collect::<Vec<_>>();
        shared::log_tool_names("ai::gemini_stream_request", tool_names);

        if !tools.is_empty() {
            request_body["tools"] = serde_json::Value::Array(tools);
            let has_function_declarations = request_body["tools"]
                .as_array()
                .map(|tools| {
                    tools
                        .iter()
                        .any(|tool| tool.get("functionDeclarations").is_some())
                })
                .unwrap_or(false);

            if has_function_declarations {
                request_body["toolConfig"] = serde_json::json!({
                    "functionCallingConfig": {
                        "mode": "AUTO"
                    }
                });
            }
        }
    }

    let protected_keys = &["contents", "systemInstruction", "tools", "toolConfig"];
    let protected_nested = &[("generationConfig", "maxOutputTokens")];
    if let Some(preset) = client.model_reasoning_preset.as_ref() {
        shared::apply_reasoning_actions(
            preset,
            &mut request_body,
            protected_keys,
            protected_nested,
            |action, body| {
                compile_reasoning_action(
                    preset,
                    action,
                    body,
                    &client.config.model,
                    client.config.max_tokens,
                )
            },
        )?;
    }

    let protected_body = shared::protect_request_body(
        client,
        &mut request_body,
        &["contents", "systemInstruction", "tools", "toolConfig"],
        &[("generationConfig", "maxOutputTokens")],
    );

    if let Some(extra) = extra_body {
        if let Some(mut extra_obj) = extra.as_object().cloned() {
            translate_extra_body(&mut request_body, &mut extra_obj);
            let override_keys = extra_obj.keys().cloned().collect::<Vec<_>>();
            shared::merge_extra_body_recursively(&mut request_body, extra_obj);
            debug!(
                target: "ai::gemini_stream_request",
                "Applied extra_body overrides: {:?}",
                override_keys
            );
        }
    }

    shared::restore_protected_body(&mut request_body, protected_body);
    if let Some(preset) = client.selected_reasoning_preset.as_ref() {
        shared::reset_reasoning_fields(
            &mut request_body,
            base_reasoning_fields.as_ref(),
            &[],
            &[("generationConfig", "thinkingConfig")],
        );
        shared::apply_reasoning_actions(
            preset,
            &mut request_body,
            protected_keys,
            protected_nested,
            |action, body| {
                compile_reasoning_action(
                    preset,
                    action,
                    body,
                    &client.config.model,
                    client.config.max_tokens,
                )
            },
        )?;
    }
    if let Some(schema) = request_context.and_then(|context| context.output_schema.as_ref()) {
        insert_generation_field(
            &mut request_body,
            "responseMimeType",
            serde_json::json!("application/json"),
        );
        insert_generation_field(
            &mut request_body,
            "responseJsonSchema",
            GeminiMessageConverter::sanitize_schema(schema.clone()),
        );
    }

    shared::log_request_body(
        "ai::gemini_stream_request",
        "Gemini stream request body:",
        &request_body,
    );

    Ok(request_body)
}

pub(crate) fn try_build_request_body(
    client: &AIClient,
    system_instruction: Option<serde_json::Value>,
    contents: Vec<serde_json::Value>,
    gemini_tools: Option<Vec<serde_json::Value>>,
    extra_body: Option<serde_json::Value>,
) -> Result<serde_json::Value> {
    try_build_request_body_with_context(
        client,
        system_instruction,
        contents,
        gemini_tools,
        extra_body,
        None,
    )
}

#[cfg(test)]
pub(crate) fn build_request_body(
    client: &AIClient,
    system_instruction: Option<serde_json::Value>,
    contents: Vec<serde_json::Value>,
    gemini_tools: Option<Vec<serde_json::Value>>,
    extra_body: Option<serde_json::Value>,
) -> serde_json::Value {
    try_build_request_body(
        client,
        system_instruction,
        contents,
        gemini_tools,
        extra_body,
    )
    .expect("request body should compile")
}

#[cfg(test)]
pub(crate) fn build_request_body_with_context(
    client: &AIClient,
    system_instruction: Option<serde_json::Value>,
    contents: Vec<serde_json::Value>,
    gemini_tools: Option<Vec<serde_json::Value>>,
    extra_body: Option<serde_json::Value>,
    request_context: Option<&ModelRequestContext>,
) -> serde_json::Value {
    try_build_request_body_with_context(
        client,
        system_instruction,
        contents,
        gemini_tools,
        extra_body,
        request_context,
    )
    .expect("request body should compile")
}

pub(crate) async fn send_stream(
    client: &AIClient,
    messages: Vec<Message>,
    tools: Option<Vec<ToolDefinition>>,
    extra_body: Option<serde_json::Value>,
    max_tries: usize,
    trace: Option<ModelExchangeTraceConfig>,
    request_context: Option<ModelRequestContext>,
) -> Result<StreamResponse> {
    let url = resolve_request_url(&client.config.request_url, &client.config.model);
    debug!(
        "Gemini config: model={}, request_url={}, max_tries={}",
        client.config.model, url, max_tries
    );

    let (system_instruction, contents) =
        GeminiMessageConverter::convert_messages(messages, &client.config.model);
    let gemini_tools = GeminiMessageConverter::convert_tools(tools);
    let request_body = try_build_request_body_with_context(
        client,
        system_instruction,
        contents,
        gemini_tools,
        extra_body,
        request_context.as_ref(),
    )?;
    let idle_timeout = client.stream_options.idle_timeout;
    let ttft_timeout = client.stream_options.ttft_timeout;

    execute_sse_request(
        "Gemini Streaming API",
        &url,
        &request_body,
        max_tries,
        ttft_timeout,
        trace,
        || apply_headers(client, client.client.post(&url), &url),
        move |response, tx, tx_raw, remaining_ttft_timeout| {
            handle_gemini_stream(response, tx, tx_raw, remaining_ttft_timeout, idle_timeout)
        },
    )
    .await
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::providers::gemini::{code_assist, discovery};

    fn api_key_client(base_url: &str) -> AIClient {
        AIClient::new(
            serde_json::from_value(serde_json::json!({
                "name": "Google Gemini",
                "base_url": base_url,
                "request_url": resolve_request_url(base_url, "gemini-2.5-flash"),
                "api_key": "synthetic-api-key",
                "model": "gemini-2.5-flash",
                "format": "gemini",
                "context_window": 4096,
                "inline_think_in_text": false,
                "skip_ssl_verify": false
            }))
            .unwrap(),
        )
    }

    #[test]
    fn google_api_key_authentication_covers_generation_and_model_discovery() {
        for base_url in [
            "https://generativelanguage.googleapis.com",
            "https://generativelanguage.googleapis.com/v1beta",
        ] {
            let client = api_key_client(base_url);
            let stream_url = resolve_request_url(&client.config.request_url, &client.config.model);
            let models_url = discovery::resolve_models_url(&client);
            assert_eq!(
                stream_url,
                "https://generativelanguage.googleapis.com/v1beta/models/gemini-2.5-flash:streamGenerateContent?alt=sse"
            );
            assert_eq!(
                models_url,
                "https://generativelanguage.googleapis.com/v1beta/models"
            );

            for (method, url) in [
                (reqwest::Method::POST, stream_url),
                (reqwest::Method::GET, models_url),
            ] {
                let request = apply_headers(&client, client.client.request(method, &url), &url)
                    .build()
                    .unwrap();
                assert_eq!(request.headers()["x-goog-api-key"], "synthetic-api-key");
                assert_eq!(request.headers()["content-type"], "application/json");
                assert!(!request.headers().contains_key("authorization"));
            }
        }
    }

    #[test]
    fn gemini_authentication_follows_request_origin_and_preserves_gateway_bearer() {
        let client = api_key_client("https://generativelanguage.googleapis.com");
        for url in [
            "https://gateway.example.com/v1beta/models",
            "https://generativelanguage.googleapis.com.gateway.example.com/v1beta/models",
            "https://gateway.example.com/generativelanguage.googleapis.com/v1beta/models",
        ] {
            let request = apply_headers(&client, client.client.get(url), url)
                .build()
                .unwrap();
            assert_eq!(request.headers()["x-goog-api-key"], "synthetic-api-key");
            assert_eq!(
                request.headers()["authorization"],
                "Bearer synthetic-api-key"
            );
        }

        let client = api_key_client("https://gateway.example.com");
        let url = "https://generativelanguage.googleapis.com/v1beta/models";
        let request = apply_headers(&client, client.client.get(url), url)
            .build()
            .unwrap();
        assert!(!request.headers().contains_key("authorization"));
    }

    #[test]
    fn gemini_explicit_custom_authentication_preserves_merge_and_replace_modes() {
        for mode in ["merge", "replace"] {
            let mut client = api_key_client("https://generativelanguage.googleapis.com");
            client.config.custom_headers_mode = Some(mode.to_string());
            client.config.custom_headers = Some(std::collections::HashMap::from([(
                "Authorization".to_string(),
                "Bearer synthetic-custom-token".to_string(),
            )]));
            let url = discovery::resolve_models_url(&client);
            let request = apply_headers(&client, client.client.get(&url), &url)
                .build()
                .unwrap();
            assert_eq!(
                request.headers()["authorization"],
                "Bearer synthetic-custom-token"
            );
            assert_eq!(request.headers().get_all("authorization").iter().count(), 1);
            assert_eq!(
                request.headers().contains_key("x-goog-api-key"),
                mode == "merge"
            );
        }
    }

    #[test]
    fn code_assist_keeps_oauth_bearer_without_api_key_header() {
        let mut client = api_key_client("https://cloudcode-pa.googleapis.com");
        client.config.format = "gemini-code-assist".to_string();
        client.config.api_key = "synthetic-oauth-token".to_string();
        let request = code_assist::apply_headers(
            &client,
            client
                .client
                .post("https://cloudcode-pa.googleapis.com/v1internal:loadCodeAssist"),
        )
        .build()
        .unwrap();
        assert_eq!(
            request.headers()["authorization"],
            "Bearer synthetic-oauth-token"
        );
        assert!(!request.headers().contains_key("x-goog-api-key"));
    }
}
