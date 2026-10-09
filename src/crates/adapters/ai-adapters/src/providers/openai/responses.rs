use super::{common, OpenAIMessageConverter};
use crate::client::sse::execute_sse_request;
use crate::client::{AIClient, StreamResponse};
use crate::providers::shared;
use crate::stream::handle_responses_stream;
use crate::trace::ModelExchangeTraceConfig;
use crate::types::{
    Message, ModelRequestContext, ReasoningPresetAction, ReasoningPresetDescriptor, ToolDefinition,
};
use anyhow::{anyhow, Result};
use log::debug;
use sha2::{Digest, Sha256};

const TARGET: &str = "ai::responses_stream_request";

fn hash_json(value: &serde_json::Value) -> String {
    hex::encode(Sha256::digest(
        serde_json::to_vec(value).unwrap_or_default(),
    ))
}

fn hash_text(value: Option<&str>) -> String {
    hex::encode(Sha256::digest(value.unwrap_or_default().as_bytes()))
}

fn short_hash(value: &str) -> &str {
    value.get(..12).unwrap_or(value)
}

fn prompt_cache_key_hash(request_body: &serde_json::Value) -> Option<String> {
    request_body
        .get("prompt_cache_key")
        .and_then(serde_json::Value::as_str)
        .map(|key| hex::encode(Sha256::digest(key.as_bytes())))
}

fn log_prompt_cache_diagnostics(request_body: &serde_json::Value) {
    let input = request_body
        .get("input")
        .cloned()
        .unwrap_or_else(|| serde_json::json!([]));
    let tools = request_body
        .get("tools")
        .cloned()
        .unwrap_or_else(|| serde_json::json!([]));
    let instructions = request_body
        .get("instructions")
        .and_then(serde_json::Value::as_str);
    let cache_key_hash = prompt_cache_key_hash(request_body);
    let input_hash = hash_json(&input);
    let tools_hash = hash_json(&tools);
    let instructions_hash = hash_text(instructions);

    debug!(
        target: TARGET,
        "Responses prompt cache diagnostics: cache_key_hash={}, instructions_hash={}, input_hash={}, tools_hash={}, input_items={}, tool_count={}",
        cache_key_hash
            .as_deref()
            .map(short_hash)
            .unwrap_or("none"),
        short_hash(&instructions_hash),
        short_hash(&input_hash),
        short_hash(&tools_hash),
        input.as_array().map(Vec::len).unwrap_or(0),
        tools.as_array().map(Vec::len).unwrap_or(0),
    );
}

fn ensure_reasoning_summary_opt_in(request_body: &mut serde_json::Value) {
    let Some(reasoning) = request_body
        .get_mut("reasoning")
        .and_then(serde_json::Value::as_object_mut)
    else {
        return;
    };
    reasoning
        .entry("summary".to_string())
        .or_insert_with(|| serde_json::Value::String("auto".to_string()));
}

fn compile_reasoning_action(
    preset: &ReasoningPresetDescriptor,
    action: &ReasoningPresetAction,
    body: &mut serde_json::Value,
) -> Result<bool> {
    match action {
        ReasoningPresetAction::Effort { value } => {
            if value.trim().is_empty() {
                return Err(anyhow!("Responses reasoning effort must not be empty"));
            }
            body["reasoning"] = serde_json::json!({ "effort": value, "summary": "auto" });
            Ok(true)
        }
        ReasoningPresetAction::Toggle { enabled }
            if shared::is_generic_reasoning_preset(preset) =>
        {
            body["reasoning"] = serde_json::json!({
                "effort": if *enabled { "medium" } else { "none" },
                "summary": "auto"
            });
            Ok(true)
        }
        ReasoningPresetAction::Toggle { .. } | ReasoningPresetAction::BudgetTokens { .. } => {
            Ok(false)
        }
        ReasoningPresetAction::RequestPatch { .. } => {
            unreachable!("patches are compiled by shared code")
        }
    }
}

fn try_build_request_body_with_context(
    client: &AIClient,
    instructions: Option<String>,
    response_input: Vec<serde_json::Value>,
    openai_tools: Option<Vec<serde_json::Value>>,
    extra_body: Option<serde_json::Value>,
    request_context: Option<&ModelRequestContext>,
) -> Result<serde_json::Value> {
    let mut request_body = serde_json::json!({
        "model": client.config.model,
        "input": response_input,
        "stream": true,
        "store": false
    });

    if let Some(instructions) = instructions.filter(|value| !value.trim().is_empty()) {
        request_body["instructions"] = serde_json::Value::String(instructions);
    }

    if let Some(max_tokens) = client.config.max_tokens {
        request_body["max_output_tokens"] = serde_json::json!(max_tokens);
    }

    if let Some(prompt_cache_route_key) = request_context
        .and_then(|context| context.prompt_cache_route_key.as_deref())
        .map(str::trim)
        .filter(|key| !key.is_empty())
    {
        request_body["prompt_cache_key"] = serde_json::Value::String(prompt_cache_route_key.into());
    }

    let base_reasoning_fields =
        shared::capture_reasoning_fields(&request_body, &["reasoning"], &[]);
    let protected_keys = &[
        "model",
        "input",
        "instructions",
        "stream",
        "store",
        "max_output_tokens",
        "prompt_cache_key",
        "tools",
    ];
    if let Some(preset) = client.model_reasoning_preset.as_ref() {
        shared::apply_reasoning_actions(
            preset,
            &mut request_body,
            protected_keys,
            &[],
            |action, body| compile_reasoning_action(preset, action, body),
        )?;
    }

    let protected_body = shared::protect_request_body(
        client,
        &mut request_body,
        &[
            "model",
            "input",
            "instructions",
            "stream",
            "store",
            "max_output_tokens",
            "prompt_cache_key",
        ],
        &[],
    );

    if let Some(extra) = extra_body {
        if let Some(extra_obj) = extra.as_object() {
            shared::merge_extra_body(&mut request_body, extra_obj);
            shared::log_extra_body_keys(TARGET, extra_obj);
        }
    }

    shared::restore_protected_body(&mut request_body, protected_body);
    if let Some(prompt_cache_route_key) = request_context
        .and_then(|context| context.prompt_cache_route_key.as_deref())
        .map(str::trim)
        .filter(|key| !key.is_empty())
    {
        request_body["prompt_cache_key"] = serde_json::Value::String(prompt_cache_route_key.into());
    }
    if let Some(preset) = client.selected_reasoning_preset.as_ref() {
        shared::reset_reasoning_fields(
            &mut request_body,
            base_reasoning_fields.as_ref(),
            &["reasoning"],
            &[],
        );
        shared::apply_reasoning_actions(
            preset,
            &mut request_body,
            protected_keys,
            &[],
            |action, body| compile_reasoning_action(preset, action, body),
        )?;
    }
    ensure_reasoning_summary_opt_in(&mut request_body);
    if let Some(schema) = request_context.and_then(|context| context.output_schema.as_ref()) {
        request_body["text"]["format"] = serde_json::json!({
            "type": "json_schema",
            "name": "openbitfun_output",
            "strict": true,
            "schema": schema
        });
    }

    shared::log_request_body(
        TARGET,
        "Responses stream request body (excluding tools):",
        &request_body,
    );

    common::attach_tools(&mut request_body, openai_tools, TARGET);
    log_prompt_cache_diagnostics(&request_body);

    Ok(request_body)
}

pub(crate) fn try_build_request_body(
    client: &AIClient,
    instructions: Option<String>,
    response_input: Vec<serde_json::Value>,
    openai_tools: Option<Vec<serde_json::Value>>,
    extra_body: Option<serde_json::Value>,
) -> Result<serde_json::Value> {
    try_build_request_body_with_context(
        client,
        instructions,
        response_input,
        openai_tools,
        extra_body,
        None,
    )
}

#[cfg(test)]
pub(crate) fn build_request_body(
    client: &AIClient,
    instructions: Option<String>,
    response_input: Vec<serde_json::Value>,
    openai_tools: Option<Vec<serde_json::Value>>,
    extra_body: Option<serde_json::Value>,
) -> serde_json::Value {
    try_build_request_body(
        client,
        instructions,
        response_input,
        openai_tools,
        extra_body,
    )
    .expect("request body should compile")
}

#[cfg(test)]
fn build_request_body_with_context(
    client: &AIClient,
    instructions: Option<String>,
    response_input: Vec<serde_json::Value>,
    openai_tools: Option<Vec<serde_json::Value>>,
    extra_body: Option<serde_json::Value>,
    request_context: Option<&ModelRequestContext>,
) -> serde_json::Value {
    try_build_request_body_with_context(
        client,
        instructions,
        response_input,
        openai_tools,
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
    // Codex CLI's ChatGPT-login backend (`chatgpt.com/backend-api/codex`)
    // speaks a constrained Responses dialect with several extra
    // requirements (flat tool schema, mandatory `instructions`,
    // `store: false`, no `max_output_tokens`, etc.). Keep that adapter
    // self-contained so the standard Responses path stays untouched.
    if super::codex_chatgpt::is_codex_chatgpt_endpoint(&client.config.request_url) {
        return super::codex_chatgpt::send_stream(
            client,
            messages,
            tools,
            extra_body,
            max_tries,
            trace,
            request_context,
        )
        .await;
    }

    let url = client.config.request_url.clone();
    let request_context = shared::prepare_request_context(client, request_context);
    debug!(
        "Responses config: model={}, request_url={}, max_tries={}",
        client.config.model, client.config.request_url, max_tries
    );

    let (instructions, response_input) =
        OpenAIMessageConverter::convert_messages_to_responses_input(messages);
    let openai_tools = common::convert_tools_flat(tools);
    let request_body = try_build_request_body_with_context(
        client,
        instructions,
        response_input,
        openai_tools,
        extra_body,
        request_context.as_ref(),
    )?;
    let expected_prompt_cache_key_hash = prompt_cache_key_hash(&request_body);
    let idle_timeout = client.stream_options.idle_timeout;
    let ttft_timeout = client.stream_options.ttft_timeout;

    execute_sse_request(
        "Responses API",
        &url,
        &request_body,
        max_tries,
        ttft_timeout,
        trace,
        || {
            shared::apply_affinity_headers(
                client,
                common::apply_headers(client, client.client.post(&url)),
                &url,
                request_context.as_ref(),
            )
        },
        move |response, tx, tx_raw, remaining_ttft_timeout| {
            handle_responses_stream(
                response,
                tx,
                tx_raw,
                remaining_ttft_timeout,
                idle_timeout,
                expected_prompt_cache_key_hash.clone(),
            )
        },
    )
    .await
}

#[cfg(test)]
mod tests {
    use super::{build_request_body, build_request_body_with_context};
    use crate::types::{ModelRequestContext, ToolDefinition};
    use crate::{client::AIClient, types::AIConfig};
    use openbitfun_core_types::{
        ReasoningPresetAction, ReasoningPresetDescriptor, ReasoningPresetSource,
    };
    use serde_json::json;

    fn test_client() -> AIClient {
        AIClient::new(AIConfig {
            name: "test".to_string(),
            base_url: "https://api.openai.com/v1".to_string(),
            request_url: "https://api.openai.com/v1/responses".to_string(),
            api_key: "test-key".to_string(),
            model: "gpt-5.4".to_string(),
            format: "responses".to_string(),
            context_window: 128_000,
            max_tokens: None,
            temperature: None,
            top_p: None,
            inline_think_in_text: false,
            custom_headers: None,
            custom_headers_mode: None,
            skip_ssl_verify: false,
            custom_request_body: None,
            custom_request_body_mode: None,
        })
    }

    #[test]
    fn attaches_flat_tool_schema_for_responses_api() {
        let client = test_client();
        let request_body = build_request_body(
            &client,
            None,
            vec![json!({
                "type": "message",
                "role": "user",
                "content": [{ "type": "input_text", "text": "hello" }]
            })],
            crate::providers::openai::common::convert_tools_flat(Some(vec![ToolDefinition {
                name: "get_weather".to_string(),
                description: "Get weather".to_string(),
                parameters: json!({
                    "type": "object",
                    "properties": {
                        "city": { "type": "string" }
                    }
                }),
            }])),
            None,
        );

        assert_eq!(request_body["tools"][0]["name"], json!("get_weather"));
        assert_eq!(request_body["tools"][0]["type"], json!("function"));
        assert!(request_body["tools"][0].get("function").is_none());
    }

    #[test]
    fn responses_requests_disable_remote_storage_by_default() {
        let request_body = build_request_body(&test_client(), None, Vec::new(), None, None);

        assert_eq!(request_body["store"], json!(false));
    }

    #[test]
    fn trim_custom_body_keeps_remote_storage_disabled() {
        let mut client = test_client();
        client.config.custom_request_body_mode = Some("trim".to_string());
        let request_body = build_request_body(
            &client,
            None,
            Vec::new(),
            None,
            Some(json!({ "reasoning": { "effort": "low" } })),
        );

        assert_eq!(request_body["store"], json!(false));
    }

    #[test]
    fn ordinary_responses_request_does_not_add_encrypted_reasoning_include() {
        let request_body = build_request_body(
            &test_client(),
            None,
            vec![json!({
                "type": "message",
                "role": "user",
                "content": [{ "type": "input_text", "text": "hello" }]
            })],
            None,
            None,
        );

        assert!(request_body.get("include").is_none());
    }

    #[test]
    fn responses_reasoning_effort_requests_auto_summary() {
        let client = test_client().with_reasoning_preset(&ReasoningPresetDescriptor {
            id: "high".to_string(),
            label: "High".to_string(),
            order: 0,
            actions: vec![ReasoningPresetAction::Effort {
                value: "high".to_string(),
            }],
            source: ReasoningPresetSource::ModelConfig,
            effective_effort: None,
            execution_provider: None,
            execution_model: None,
        });
        let request_body = build_request_body(&client, None, Vec::new(), None, None);

        assert_eq!(
            request_body["reasoning"],
            json!({ "effort": "high", "summary": "auto" })
        );
    }

    #[test]
    fn responses_reasoning_summary_preserves_explicit_override() {
        let concise_request_body = build_request_body(
            &test_client(),
            None,
            Vec::new(),
            None,
            Some(json!({ "reasoning": { "effort": "low", "summary": "concise" } })),
        );
        let disabled_request_body = build_request_body(
            &test_client(),
            None,
            Vec::new(),
            None,
            Some(json!({ "reasoning": { "effort": "low", "summary": null } })),
        );

        assert_eq!(
            concise_request_body["reasoning"]["summary"],
            json!("concise")
        );
        assert_eq!(disabled_request_body["reasoning"]["summary"], json!(null));
    }

    #[test]
    fn attaches_runtime_prompt_cache_key_after_custom_body_merge() {
        let client = test_client();
        let request_context = ModelRequestContext {
            prompt_cache_route_key: Some("lineage-1".to_string()),
            output_schema: None,
        };
        let request_body = build_request_body_with_context(
            &client,
            Some("stable instructions".to_string()),
            Vec::new(),
            None,
            Some(json!({ "prompt_cache_key": "user-override" })),
            Some(&request_context),
        );

        assert_eq!(request_body["prompt_cache_key"], json!("lineage-1"));
    }

    #[test]
    fn attaches_turn_output_schema_after_custom_body_merge() {
        let schema = json!({
            "type": "object",
            "properties": { "summary": { "type": "string" } }
        });
        let request_context = ModelRequestContext {
            prompt_cache_route_key: None,
            output_schema: Some(schema.clone()),
        };
        let request_body = build_request_body_with_context(
            &test_client(),
            None,
            Vec::new(),
            None,
            Some(json!({ "text": { "format": { "type": "text" } } })),
            Some(&request_context),
        );

        assert_eq!(request_body["text"]["format"]["type"], "json_schema");
        assert_eq!(request_body["text"]["format"]["schema"], schema);
    }
}
