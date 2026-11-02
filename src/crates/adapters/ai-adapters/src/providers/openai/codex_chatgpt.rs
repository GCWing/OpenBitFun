//! Adapter for the Codex CLI ChatGPT-login backend
//! (`https://chatgpt.com/backend-api/codex/responses`).
//!
//! This endpoint speaks a constrained dialect of the OpenAI Responses API
//! used internally by the official `codex` CLI. It is *not* the public
//! `https://api.openai.com/v1/responses` surface — sending a vanilla
//! Responses-shaped body to it produces 400 errors such as:
//!
//! - `Instructions are required`
//! - `Store must be set to false`
//! - `Unsupported parameter: max_output_tokens`
//! - `Missing required parameter: 'tools[0].name'`  (it requires the *flat*
//!   Responses tool schema, not the Chat Completions `{type, function:{...}}`
//!   wrapper)
//!
//! Rather than scattering URL-conditional patches throughout the generic
//! Responses adapter, all backend-specific quirks live in this module.
//! Dispatch happens in `super::responses::send_stream` via
//! [`is_codex_chatgpt_endpoint`].

use super::{common, OpenAIMessageConverter};
use crate::client::sse::execute_sse_request;
use crate::client::{AIClient, StreamResponse};
use crate::providers::shared;
use crate::stream::handle_responses_stream;
use crate::trace::ModelExchangeTraceConfig;
use crate::types::{Message, ModelRequestContext, ReasoningPresetAction, ToolDefinition};
use anyhow::Result;
use log::debug;
use serde_json::{json, Value};

const TARGET: &str = "ai::codex_chatgpt_request";
const DEFAULT_INSTRUCTIONS: &str = "You are a helpful AI assistant.";

/// Returns true when `request_url` points at Codex CLI's ChatGPT backend.
pub(crate) fn is_codex_chatgpt_endpoint(request_url: &str) -> bool {
    request_url.contains("chatgpt.com/backend-api/codex")
}

fn attach_tools(request_body: &mut Value, tools: Option<Vec<Value>>) {
    if let Some(tools) = tools {
        let names: Vec<String> = tools
            .iter()
            .filter_map(|t| t.get("name").and_then(|v| v.as_str()).map(str::to_string))
            .collect();
        shared::log_tool_names(TARGET, names);
        if !tools.is_empty() {
            request_body["tools"] = Value::Array(tools);
            if request_body.get("tool_choice").is_none() {
                request_body["tool_choice"] = Value::String("auto".to_string());
            }
            // Mirror hermes-agent / codex CLI: parallel tool calls allowed.
            if request_body.get("parallel_tool_calls").is_none() {
                request_body["parallel_tool_calls"] = Value::Bool(true);
            }
        }
    }
}

/// Clamp reasoning effort to values accepted by the Codex backend models.
/// `minimal` is rejected by GPT-5.2 / GPT-5.4 family — fall back to `low`,
/// matching hermes-agent's clamp table.
fn clamp_reasoning_effort(effort: &str) -> String {
    match effort {
        "minimal" => "low".to_string(),
        other => other.to_string(),
    }
}

pub(crate) fn try_build_request_body(
    client: &AIClient,
    instructions: Option<String>,
    response_input: Vec<Value>,
    tools_flat: Option<Vec<Value>>,
    extra_body: Option<Value>,
) -> Result<Value> {
    try_build_request_body_with_context(
        client,
        instructions,
        response_input,
        tools_flat,
        extra_body,
        None,
    )
}

fn try_build_request_body_with_context(
    client: &AIClient,
    instructions: Option<String>,
    response_input: Vec<Value>,
    tools_flat: Option<Vec<Value>>,
    extra_body: Option<Value>,
    request_context: Option<&ModelRequestContext>,
) -> Result<Value> {
    let mut body = json!({
        "model": client.config.model,
        "input": response_input,
        "stream": true,
        // Codex backend mandates `store: false`.
        "store": false,
    });

    let resolved_instructions = instructions
        .filter(|v| !v.trim().is_empty())
        .unwrap_or_else(|| DEFAULT_INSTRUCTIONS.to_string());
    body["instructions"] = Value::String(resolved_instructions.clone());

    // Reasoning — mirror hermes-agent: default effort `medium` when enabled,
    // clamp `minimal -> low`, request encrypted reasoning trace for chain
    // continuity. When explicitly disabled, send `include: []` (empty array)
    // so the backend doesn't attach reasoning items it expects to be replayed.
    body["reasoning"] = json!({ "effort": "medium", "summary": "auto" });
    body["include"] = json!(["reasoning.encrypted_content"]);
    let base_reasoning_fields =
        shared::capture_reasoning_fields(&body, &["reasoning", "include"], &[]);
    let protected_keys = &[
        "model",
        "input",
        "instructions",
        "stream",
        "store",
        "include",
        "tools",
    ];
    let compile = |action: &ReasoningPresetAction, body: &mut Value| -> Result<bool> {
        match action {
            ReasoningPresetAction::Effort { value } => {
                body["reasoning"] = json!({
                    "effort": clamp_reasoning_effort(value.trim()),
                    "summary": "auto"
                });
                body["include"] = json!(["reasoning.encrypted_content"]);
                Ok(true)
            }
            ReasoningPresetAction::Toggle { enabled: false } => {
                body.as_object_mut().map(|body| body.remove("reasoning"));
                body["include"] = json!([]);
                Ok(true)
            }
            ReasoningPresetAction::Toggle { enabled: true } => {
                body["reasoning"] = json!({ "effort": "medium", "summary": "auto" });
                body["include"] = json!(["reasoning.encrypted_content"]);
                Ok(true)
            }
            ReasoningPresetAction::BudgetTokens { .. } => Ok(false),
            ReasoningPresetAction::RequestPatch { .. } => {
                unreachable!("patches are compiled by shared code")
            }
        }
    };
    if let Some(preset) = client.model_reasoning_preset.as_ref() {
        shared::apply_reasoning_actions(preset, &mut body, protected_keys, &[], compile)?;
    }

    let protected = shared::protect_request_body(
        client,
        &mut body,
        &[
            "model",
            "input",
            "instructions",
            "stream",
            "store",
            "include",
        ],
        &[],
    );

    if let Some(extra) = extra_body {
        if let Some(extra_obj) = extra.as_object() {
            shared::merge_extra_body(&mut body, extra_obj);
            shared::log_extra_body_keys(TARGET, extra_obj);
        }
    }

    shared::restore_protected_body(&mut body, protected);
    if let Some(preset) = client.selected_reasoning_preset.as_ref() {
        shared::reset_reasoning_fields(
            &mut body,
            base_reasoning_fields.as_ref(),
            &["reasoning", "include"],
            &[],
        );
        shared::apply_reasoning_actions(preset, &mut body, protected_keys, &[], compile)?;
    }

    attach_tools(&mut body, tools_flat);
    if client.subscription_provider_key() == Some("codex")
        && shared::is_https_endpoint(
            &client.config.request_url,
            "chatgpt.com",
            "/backend-api/codex",
        )
    {
        // These are backend requirements even for legacy configs with a custom body.
        body["store"] = json!(false);
        body["stream"] = json!(true);
        if body
            .get("instructions")
            .and_then(Value::as_str)
            .is_none_or(|text| text.trim().is_empty())
        {
            body["instructions"] = json!(resolved_instructions);
        }
        if let Some(object) = body.as_object_mut() {
            for unsupported in ["max_output_tokens", "max_tokens", "temperature", "top_p"] {
                object.remove(unsupported);
            }
        }
        if let Some(key) = request_context
            .and_then(|context| context.prompt_cache_route_key.as_deref())
            .map(str::trim)
            .filter(|key| !key.is_empty())
        {
            body["prompt_cache_key"] = json!(key);
        }
    }

    shared::log_request_body(
        TARGET,
        "Codex ChatGPT request body (excluding tools):",
        &body,
    );

    Ok(body)
}

pub(crate) async fn send_stream(
    client: &AIClient,
    messages: Vec<Message>,
    tools: Option<Vec<ToolDefinition>>,
    extra_body: Option<Value>,
    max_tries: usize,
    trace: Option<ModelExchangeTraceConfig>,
    request_context: Option<ModelRequestContext>,
) -> Result<StreamResponse> {
    let url = client.config.request_url.clone();
    debug!(
        "CodexChatGPT config: model={}, request_url={}, max_tries={}",
        client.config.model, url, max_tries
    );

    let (instructions, response_input) =
        OpenAIMessageConverter::convert_messages_to_responses_input(messages);
    let tools_flat = common::convert_tools_flat(tools);
    let request_body = try_build_request_body_with_context(
        client,
        instructions,
        response_input,
        tools_flat,
        extra_body,
        request_context.as_ref(),
    )?;
    let idle_timeout = client.stream_options.idle_timeout;
    let ttft_timeout = client.stream_options.ttft_timeout;

    execute_sse_request(
        Some(client),
        "Codex ChatGPT Responses API",
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
                None,
            )
        },
    )
    .await
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn ordinary_api_codex_endpoint_preserves_custom_body_and_does_not_gain_affinity() {
        let client = AIClient::new(
            serde_json::from_value(json!({
                "name": "test", "base_url": "https://chatgpt.com/backend-api/codex",
                "request_url": "https://chatgpt.com/backend-api/codex/responses",
                "api_key": "synthetic", "model": "gpt-5.5", "format": "responses",
                "context_window": 128000, "inline_think_in_text": false, "skip_ssl_verify": false
            }))
            .unwrap(),
        );
        let context = ModelRequestContext {
            prompt_cache_route_key: Some("runtime".into()),
            ..Default::default()
        };
        let custom = json!({"max_output_tokens": 8000, "max_tokens": 4000, "temperature": 0.5,
            "top_p": 0.9, "prompt_cache_key": "user-managed"});
        let before =
            try_build_request_body(&client, None, vec![], None, Some(custom.clone())).unwrap();
        let after = try_build_request_body_with_context(
            &client,
            None,
            vec![],
            None,
            Some(custom.clone()),
            Some(&context),
        )
        .unwrap();
        assert_eq!(before, after);
        for (key, value) in custom.as_object().unwrap() {
            assert_eq!(&after[key], value);
        }
        let request = shared::apply_affinity_headers(
            &client,
            common::apply_headers(&client, client.client.post(&client.config.request_url)),
            &client.config.request_url,
            Some(&context),
        )
        .build()
        .unwrap();
        assert!(!request.headers().contains_key("session_id"));
        assert!(!request.headers().contains_key("x-client-request-id"));
        assert_eq!(request.headers()["authorization"], "Bearer synthetic");
    }

    #[cfg(feature = "subscription-auth")]
    #[test]
    fn legacy_custom_body_cannot_break_codex_contract_or_cache_routing() {
        let client = AIClient::new(serde_json::from_value(json!({
            "name": "test", "base_url": "https://chatgpt.com/backend-api/codex",
            "request_url": "https://chatgpt.com/backend-api/codex/responses",
            "api_key": "synthetic", "model": "gpt-5.5", "format": "responses", "context_window": 128000, "inline_think_in_text": false, "skip_ssl_verify": false
        })).unwrap()).with_subscription_provider(crate::subscription_auth::SubscriptionProvider::Codex);
        let context = ModelRequestContext {
            prompt_cache_route_key: Some("conversation-a".into()),
            ..Default::default()
        };
        let body = try_build_request_body_with_context(
            &client, Some("Help with this task".into()), vec![],
            Some(vec![json!({"type": "function", "name": "read_file", "parameters": {"type": "object"}})]),
            Some(json!({"store": true, "stream": false, "instructions": "", "max_output_tokens": 8000,
                "max_tokens": 8000, "temperature": 0.5, "top_p": 0.9, "prompt_cache_key": "stale"})), Some(&context),
        ).unwrap();
        assert_eq!(body["store"], false);
        assert_eq!(body["stream"], true);
        assert_eq!(body["instructions"], "Help with this task");
        assert_eq!(body["prompt_cache_key"], "conversation-a");
        assert_eq!(body["tools"][0]["name"], "read_file");
        for unsupported in ["max_output_tokens", "max_tokens", "temperature", "top_p"] {
            assert!(body.get(unsupported).is_none());
        }
        let request = shared::apply_affinity_headers(
            &client,
            common::apply_headers(&client, client.client.post(&client.config.request_url)),
            &client.config.request_url,
            Some(&context),
        )
        .json(&body)
        .build()
        .unwrap();
        assert_eq!(
            request.headers()["x-client-request-id"],
            body["prompt_cache_key"].as_str().unwrap()
        );
        assert_eq!(request.headers()["session_id"], "conversation-a");
        assert_eq!(request.headers()["authorization"], "Bearer synthetic");
    }
}
