use super::AnthropicMessageConverter;
use crate::client::quirks::{
    is_deepseek_reasoning_effort_model, is_deepseek_url, is_glm_52_reasoning_effort_model,
    is_zhipuai_url, normalize_deepseek_reasoning_effort, normalize_glm_52_reasoning_effort,
    should_append_tool_stream,
};
use crate::client::sse::execute_sse_request;
use crate::client::{AIClient, StreamResponse};
use crate::providers::shared;
use crate::stream::handle_anthropic_stream;
use crate::trace::ModelExchangeTraceConfig;
use crate::types::{
    Message, ModelRequestContext, ReasoningPresetAction, ReasoningPresetDescriptor, ToolDefinition,
};
use anyhow::{anyhow, Result};
use log::debug;
use reqwest::RequestBuilder;

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub(crate) enum AnthropicThinkingCapability {
    ManualOnly,
    AdaptivePreferred,
    AdaptiveOnly,
    AdaptiveDefaultNoDisabled,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
struct ClaudeModelVersion {
    major: u32,
    minor: u32,
}

/// Anthropic-compatible endpoints whose vendors document `Authorization: Bearer`
/// (ANTHROPIC_AUTH_TOKEN) instead of `x-api-key`: Zhipu bigmodel.cn / Z.AI,
/// Moonshot's /anthropic gateway, Kimi For Coding, and Xiaomi MiMo.
fn wants_bearer_auth(url: &str) -> bool {
    // Nous Portal uses the same OAuth bearer for its Messages and model-list
    // endpoints. Do not send that subscription token as an Anthropic API key.
    let nous_portal = reqwest::Url::parse(url).ok().is_some_and(|url| {
        url.scheme() == "https"
            && url.host_str() == Some("inference-api.nousresearch.com")
            && url.port_or_known_default() == Some(443)
    });
    // MiMo accepts Bearer or api-key, rather than Anthropic's x-api-key.
    let xiaomi_mimo = reqwest::Url::parse(url).ok().is_some_and(|url| {
        url.scheme() == "https"
            && matches!(
                url.host_str(),
                Some("api.xiaomimimo.com" | "token-plan-cn.xiaomimimo.com")
            )
            && url.port_or_known_default() == Some(443)
            && (url.path() == "/anthropic" || url.path().starts_with("/anthropic/"))
    });
    nous_portal
        || xiaomi_mimo
        || url.contains("bigmodel.cn")
        || url.contains("api.z.ai")
        || url.contains("api.kimi.com/coding")
        || ((url.contains("api.moonshot.cn") || url.contains("api.moonshot.ai"))
            && url.contains("/anthropic"))
}

pub(crate) fn apply_headers(
    client: &AIClient,
    builder: RequestBuilder,
    url: &str,
) -> RequestBuilder {
    shared::apply_header_policy(client, builder, |mut builder| {
        builder = builder.header("Content-Type", "application/json");

        if wants_bearer_auth(url) {
            builder = builder.header("Authorization", format!("Bearer {}", client.config.api_key));
            // Keep bigmodel.cn exactly as it shipped (no version header); the other
            // bearer gateways follow the Anthropic protocol, which requires it.
            if !url.contains("bigmodel.cn") {
                builder = builder.header("anthropic-version", "2023-06-01");
            }
        } else {
            builder = builder
                .header("x-api-key", &client.config.api_key)
                .header("anthropic-version", "2023-06-01");
        }

        if url.contains("openbitfun.com") {
            builder = builder.header("X-Verification-Code", "from_openbitfun");
        }

        builder
    })
}

fn parse_claude_model_version(model_name: &str, family: &str) -> Option<ClaudeModelVersion> {
    let prefix = format!("claude-{family}-");
    let rest = model_name.strip_prefix(&prefix)?;
    let mut parts = rest.split('-');
    let major = parts.next()?.parse().ok()?;
    let minor = parts.next().and_then(|part| part.parse().ok()).unwrap_or(0);
    Some(ClaudeModelVersion { major, minor })
}

pub(crate) fn anthropic_thinking_capability(model_name: &str) -> AnthropicThinkingCapability {
    if model_name.starts_with("claude-mythos") || model_name.starts_with("claude-fable") {
        return AnthropicThinkingCapability::AdaptiveDefaultNoDisabled;
    }

    if let Some(version) = parse_claude_model_version(model_name, "opus") {
        if version.major == 4 && version.minor >= 7 {
            return AnthropicThinkingCapability::AdaptiveOnly;
        }
        if version.major > 4 || (version.major == 4 && version.minor >= 6) {
            return AnthropicThinkingCapability::AdaptivePreferred;
        }
    }

    if let Some(version) = parse_claude_model_version(model_name, "sonnet") {
        if version.major > 4 || (version.major == 4 && version.minor >= 6) {
            return AnthropicThinkingCapability::AdaptivePreferred;
        }
    }

    AnthropicThinkingCapability::ManualOnly
}

fn anthropic_supports_adaptive_reasoning(capability: AnthropicThinkingCapability) -> bool {
    !matches!(capability, AnthropicThinkingCapability::ManualOnly)
}

fn default_anthropic_budget_tokens(max_tokens: u32) -> u32 {
    10_000u32.min(max_tokens.saturating_mul(3) / 4).max(1)
}

fn anthropic_adaptive_effort(reasoning_effort: Option<&str>) -> &str {
    reasoning_effort
        .filter(|value| !value.trim().is_empty())
        .unwrap_or("medium")
}

fn apply_anthropic_adaptive_reasoning(
    request_body: &mut serde_json::Value,
    reasoning_effort: Option<&str>,
) {
    request_body["thinking"] = serde_json::json!({ "type": "adaptive" });
    request_body["output_config"] = serde_json::json!({
        "effort": anthropic_adaptive_effort(reasoning_effort)
    });
}

fn compile_reasoning_action(
    preset: &ReasoningPresetDescriptor,
    action: &ReasoningPresetAction,
    request_body: &mut serde_json::Value,
    url: &str,
    configured_model: &str,
    max_tokens: u32,
) -> Result<bool> {
    let execution_provider = preset.execution_provider.as_deref().unwrap_or("anthropic");
    let execution_model = preset
        .execution_model
        .as_deref()
        .unwrap_or(configured_model)
        .trim()
        .to_ascii_lowercase();
    let is_generic_reasoning = shared::is_generic_reasoning_preset(preset);

    if is_generic_reasoning {
        return match action {
            ReasoningPresetAction::Effort { value } => {
                let normalized =
                    shared::normalize_generic_reasoning_effort(value).ok_or_else(|| {
                        anyhow!("Generic reasoning effort '{}' is unsupported", value)
                    })?;
                apply_anthropic_adaptive_reasoning(request_body, Some(normalized));
                Ok(true)
            }
            ReasoningPresetAction::Toggle { enabled: true } => {
                apply_anthropic_adaptive_reasoning(request_body, None);
                Ok(true)
            }
            ReasoningPresetAction::Toggle { enabled: false } => {
                request_body["thinking"] = serde_json::json!({ "type": "disabled" });
                request_body
                    .as_object_mut()
                    .map(|body| body.remove("output_config"));
                Ok(true)
            }
            ReasoningPresetAction::BudgetTokens { .. } => Ok(false),
            ReasoningPresetAction::RequestPatch { .. } => {
                unreachable!("patches are compiled by shared code")
            }
        };
    }

    let is_deepseek_reasoning_target = execution_provider.eq_ignore_ascii_case("deepseek")
        || is_deepseek_url(url)
        || is_deepseek_reasoning_effort_model(&execution_model);

    if is_deepseek_reasoning_target {
        return match action {
            ReasoningPresetAction::Toggle { enabled } => {
                request_body["thinking"] = serde_json::json!({
                    "type": if *enabled { "enabled" } else { "disabled" }
                });
                if !enabled {
                    request_body
                        .as_object_mut()
                        .map(|body| body.remove("output_config"));
                }
                Ok(true)
            }
            ReasoningPresetAction::Effort { value } => {
                let effort = normalize_deepseek_reasoning_effort(&execution_model, value)
                    .ok_or_else(|| {
                        anyhow!(
                            "DeepSeek reasoning effort '{}' has no enabled mapping",
                            value
                        )
                    })?;
                request_body["thinking"] = serde_json::json!({ "type": "enabled" });
                request_body["output_config"] = serde_json::json!({ "effort": effort });
                Ok(true)
            }
            ReasoningPresetAction::BudgetTokens { .. } => Ok(false),
            ReasoningPresetAction::RequestPatch { .. } => {
                unreachable!("patches are compiled by shared code")
            }
        };
    }

    let is_glm_52_reasoning_target = is_glm_52_reasoning_effort_model(&execution_model)
        && (execution_provider.eq_ignore_ascii_case("zhipuai") || is_zhipuai_url(url));
    if is_glm_52_reasoning_target {
        return match action {
            ReasoningPresetAction::Effort { value } => {
                let normalized = normalize_glm_52_reasoning_effort(value).ok_or_else(|| {
                    anyhow!("GLM-5.2 reasoning effort '{}' is unsupported", value)
                })?;
                request_body["thinking"] = serde_json::json!({ "type": "adaptive" });
                request_body["output_config"] = serde_json::json!({
                    "effort": normalized
                });
                Ok(true)
            }
            ReasoningPresetAction::Toggle { enabled } => {
                request_body["thinking"] = serde_json::json!({
                    "type": if *enabled { "adaptive" } else { "disabled" }
                });
                if !enabled {
                    request_body
                        .as_object_mut()
                        .map(|body| body.remove("output_config"));
                }
                Ok(true)
            }
            ReasoningPresetAction::BudgetTokens { .. } => Ok(false),
            ReasoningPresetAction::RequestPatch { .. } => {
                unreachable!("patches are compiled by shared code")
            }
        };
    }

    let capability = anthropic_thinking_capability(&execution_model);
    match action {
        ReasoningPresetAction::Effort { value }
            if anthropic_supports_adaptive_reasoning(capability) =>
        {
            apply_anthropic_adaptive_reasoning(request_body, Some(value));
            Ok(true)
        }
        ReasoningPresetAction::Effort { .. } => Ok(false),
        ReasoningPresetAction::Toggle { enabled: false }
            if capability != AnthropicThinkingCapability::AdaptiveDefaultNoDisabled =>
        {
            request_body["thinking"] = serde_json::json!({ "type": "disabled" });
            request_body
                .as_object_mut()
                .map(|body| body.remove("output_config"));
            Ok(true)
        }
        ReasoningPresetAction::Toggle { enabled: true } => {
            if anthropic_supports_adaptive_reasoning(capability) {
                apply_anthropic_adaptive_reasoning(request_body, None);
            } else {
                request_body["thinking"] = serde_json::json!({
                    "type": "enabled",
                    "budget_tokens": default_anthropic_budget_tokens(max_tokens)
                });
            }
            Ok(true)
        }
        ReasoningPresetAction::BudgetTokens { value }
            if !matches!(
                capability,
                AnthropicThinkingCapability::AdaptiveOnly
                    | AnthropicThinkingCapability::AdaptiveDefaultNoDisabled
            ) =>
        {
            if *value >= max_tokens {
                return Err(anyhow!(
                    "Anthropic reasoning budget {} must be less than max_tokens {}",
                    value,
                    max_tokens
                ));
            }
            request_body["thinking"] = serde_json::json!({
                "type": "enabled",
                "budget_tokens": value
            });
            request_body
                .as_object_mut()
                .map(|body| body.remove("output_config"));
            Ok(true)
        }
        ReasoningPresetAction::Toggle { enabled: false }
        | ReasoningPresetAction::BudgetTokens { .. } => Ok(false),
        ReasoningPresetAction::RequestPatch { .. } => {
            unreachable!("patches are compiled by shared code")
        }
    }
}

fn try_build_request_body_with_context(
    client: &AIClient,
    url: &str,
    system_message: Option<String>,
    anthropic_messages: Vec<serde_json::Value>,
    anthropic_tools: Option<Vec<serde_json::Value>>,
    extra_body: Option<serde_json::Value>,
    request_context: Option<&ModelRequestContext>,
) -> Result<serde_json::Value> {
    let max_tokens = client.config.max_tokens.unwrap_or(32000);

    let mut request_body = serde_json::json!({
        "model": client.config.model,
        "messages": anthropic_messages,
        "max_tokens": max_tokens,
        "stream": true
    });

    let model_name = client.config.model.to_lowercase();

    if should_append_tool_stream(url, &model_name) {
        request_body["tool_stream"] = serde_json::Value::Bool(true);
    }

    let base_reasoning_fields =
        shared::capture_reasoning_fields(&request_body, &["thinking", "output_config"], &[]);

    if let Some(system) = system_message {
        request_body["system"] = serde_json::Value::String(system);
    }

    let protected_keys = &[
        "model",
        "messages",
        "max_tokens",
        "stream",
        "system",
        "tool_stream",
        "tools",
    ];
    if let Some(preset) = client.model_reasoning_preset.as_ref() {
        shared::apply_reasoning_actions(
            preset,
            &mut request_body,
            protected_keys,
            &[],
            |action, body| {
                compile_reasoning_action(preset, action, body, url, &model_name, max_tokens)
            },
        )?;
    }

    let protected_body = shared::protect_request_body(
        client,
        &mut request_body,
        &[
            "model",
            "messages",
            "max_tokens",
            "stream",
            "system",
            "tool_stream",
        ],
        &[],
    );

    if let Some(extra) = extra_body {
        if let Some(extra_obj) = extra.as_object() {
            shared::merge_extra_body(&mut request_body, extra_obj);
            shared::log_extra_body_keys("ai::anthropic_stream_request", extra_obj);
        }
    }

    shared::restore_protected_body(&mut request_body, protected_body);
    if let Some(preset) = client.selected_reasoning_preset.as_ref() {
        shared::reset_reasoning_fields(
            &mut request_body,
            base_reasoning_fields.as_ref(),
            &["thinking", "output_config"],
            &[],
        );
        shared::apply_reasoning_actions(
            preset,
            &mut request_body,
            protected_keys,
            &[],
            |action, body| {
                compile_reasoning_action(preset, action, body, url, &model_name, max_tokens)
            },
        )?;
    }
    if let Some(schema) = request_context.and_then(|context| context.output_schema.as_ref()) {
        if !request_body["output_config"].is_object() {
            request_body["output_config"] = serde_json::json!({});
        }
        request_body["output_config"]["format"] = serde_json::json!({
            "type": "json_schema",
            "schema": schema
        });
    }

    suspend_thinking_for_unsigned_tool_loop(&mut request_body, &model_name);

    shared::log_request_body(
        "ai::anthropic_stream_request",
        "Anthropic stream request body (excluding tools):",
        &request_body,
    );

    if let Some(tools) = anthropic_tools {
        let tool_names = tools
            .iter()
            .map(|tool| {
                shared::extract_top_level_string_field(tool, "name")
                    .unwrap_or_else(|| "unknown".to_string())
            })
            .collect::<Vec<_>>();
        shared::log_tool_names("ai::anthropic_stream_request", tool_names);
        if !tools.is_empty() {
            request_body["tools"] = serde_json::Value::Array(tools);
        }
    }

    apply_prompt_cache_breakpoints(&mut request_body);

    Ok(request_body)
}

/// With thinking on, Anthropic requires the final assistant tool turn to
/// start with its signed thinking block. History continued from another
/// account or provider has no such block, so this request runs without
/// thinking; the next user turn starts a fresh signed loop.
fn suspend_thinking_for_unsigned_tool_loop(request_body: &mut serde_json::Value, model_name: &str) {
    let thinking_on = request_body["thinking"]["type"]
        .as_str()
        .is_some_and(|kind| kind != "disabled");
    if !thinking_on {
        return;
    }
    let Some(last_assistant) = request_body["messages"].as_array().and_then(|messages| {
        messages
            .iter()
            .rev()
            .find(|message| message["role"] == "assistant")
    }) else {
        return;
    };
    let blocks = last_assistant["content"].as_array();
    let has_tool_use =
        blocks.is_some_and(|blocks| blocks.iter().any(|block| block["type"] == "tool_use"));
    let signed_start = blocks
        .and_then(|blocks| blocks.first())
        .is_some_and(|block| {
            matches!(
                block["type"].as_str(),
                Some("thinking" | "redacted_thinking")
            ) && block["signature"]
                .as_str()
                .is_some_and(|signature| !signature.is_empty())
                || block["type"] == "redacted_thinking"
        });
    if !has_tool_use || signed_start {
        return;
    }
    let Some(body) = request_body.as_object_mut() else {
        return;
    };
    if anthropic_thinking_capability(model_name)
        == AnthropicThinkingCapability::AdaptiveDefaultNoDisabled
    {
        // These models reject an explicit disabled value; omit the request.
        body.remove("thinking");
    } else {
        body.insert("thinking".into(), serde_json::json!({ "type": "disabled" }));
    }
    if let Some(output) = body
        .get_mut("output_config")
        .and_then(|value| value.as_object_mut())
    {
        output.remove("effort");
        if output.is_empty() {
            body.remove("output_config");
        }
    }
}

/// Anthropic only caches prompts that carry `cache_control`, and only writes
/// cache entries at those breakpoints. Mark the end of the stable head
/// (tools + system) so new sessions reuse it, and the last two messages so each
/// request extends the previous request's entry within the 20-block lookback.
/// That is three of the four allowed breakpoints. Compatible gateways accept
/// the same block-level markers that Claude Code sends; a top-level
/// `cache_control` from the custom request body (automatic caching, or `null`
/// to opt out) replaces this policy, and existing markers are left untouched.
fn apply_prompt_cache_breakpoints(request_body: &mut serde_json::Value) {
    let Some(body) = request_body.as_object_mut() else {
        return;
    };
    if let Some(custom) = body.get("cache_control") {
        if custom.is_null() {
            body.remove("cache_control");
        }
        return;
    }
    if ["system", "tools", "messages"]
        .iter()
        .any(|key| body.get(*key).is_some_and(contains_cache_control))
    {
        return;
    }

    let head_marked = body
        .get_mut("system")
        .is_some_and(mark_last_cacheable_content_block);
    if !head_marked {
        if let Some(last_tool) = body
            .get_mut("tools")
            .and_then(serde_json::Value::as_array_mut)
            .and_then(|tools| tools.last_mut())
            .and_then(serde_json::Value::as_object_mut)
        {
            last_tool.insert("cache_control".to_string(), ephemeral_cache_control());
        }
    }

    if let Some(messages) = body
        .get_mut("messages")
        .and_then(serde_json::Value::as_array_mut)
    {
        for content in messages
            .iter_mut()
            .rev()
            .take(2)
            .filter_map(|message| message.get_mut("content"))
        {
            mark_last_cacheable_content_block(content);
        }
    }
}

fn ephemeral_cache_control() -> serde_json::Value {
    serde_json::json!({ "type": "ephemeral" })
}

fn contains_cache_control(value: &serde_json::Value) -> bool {
    match value {
        serde_json::Value::Object(map) => {
            map.contains_key("cache_control") || map.values().any(contains_cache_control)
        }
        serde_json::Value::Array(items) => items.iter().any(contains_cache_control),
        _ => false,
    }
}

/// Accepts the string or block-array forms of `system` and message `content`.
/// A non-empty string becomes one text block so it can carry the marker.
fn mark_last_cacheable_content_block(content: &mut serde_json::Value) -> bool {
    if let Some(text) = content
        .as_str()
        .filter(|text| !text.trim().is_empty())
        .map(str::to_owned)
    {
        *content = serde_json::json!([{
            "type": "text",
            "text": text,
            "cache_control": ephemeral_cache_control(),
        }]);
        return true;
    }
    content
        .as_array_mut()
        .is_some_and(|blocks| mark_last_cacheable_block(blocks))
}

/// Thinking blocks and blank text blocks cannot carry `cache_control`.
fn mark_last_cacheable_block(blocks: &mut [serde_json::Value]) -> bool {
    let Some(block) = blocks
        .iter_mut()
        .rev()
        .filter_map(serde_json::Value::as_object_mut)
        .find(
            |block| match block.get("type").and_then(|kind| kind.as_str()) {
                Some("thinking" | "redacted_thinking") | None => false,
                Some("text") => block
                    .get("text")
                    .and_then(|text| text.as_str())
                    .is_some_and(|text| !text.trim().is_empty()),
                Some(_) => true,
            },
        )
    else {
        return false;
    };
    block.insert("cache_control".to_string(), ephemeral_cache_control());
    true
}

pub(crate) fn try_build_request_body(
    client: &AIClient,
    url: &str,
    system_message: Option<String>,
    anthropic_messages: Vec<serde_json::Value>,
    anthropic_tools: Option<Vec<serde_json::Value>>,
    extra_body: Option<serde_json::Value>,
) -> Result<serde_json::Value> {
    try_build_request_body_with_context(
        client,
        url,
        system_message,
        anthropic_messages,
        anthropic_tools,
        extra_body,
        None,
    )
}

#[cfg(test)]
pub(crate) fn build_request_body(
    client: &AIClient,
    url: &str,
    system_message: Option<String>,
    anthropic_messages: Vec<serde_json::Value>,
    anthropic_tools: Option<Vec<serde_json::Value>>,
    extra_body: Option<serde_json::Value>,
) -> serde_json::Value {
    try_build_request_body(
        client,
        url,
        system_message,
        anthropic_messages,
        anthropic_tools,
        extra_body,
    )
    .expect("request body should compile")
}

#[cfg(test)]
pub(crate) fn build_request_body_with_context(
    client: &AIClient,
    url: &str,
    system_message: Option<String>,
    anthropic_messages: Vec<serde_json::Value>,
    anthropic_tools: Option<Vec<serde_json::Value>>,
    extra_body: Option<serde_json::Value>,
    request_context: Option<&ModelRequestContext>,
) -> serde_json::Value {
    try_build_request_body_with_context(
        client,
        url,
        system_message,
        anthropic_messages,
        anthropic_tools,
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
    let url = client.config.request_url.clone();
    let request_context = shared::prepare_request_context(client, request_context);
    debug!(
        "Anthropic config: model={}, request_url={}, max_tries={}",
        client.config.model, client.config.request_url, max_tries
    );

    let (system_message, anthropic_messages) =
        AnthropicMessageConverter::convert_messages(messages);
    let anthropic_tools = AnthropicMessageConverter::convert_tools(tools);
    let mut request_body = try_build_request_body_with_context(
        client,
        &url,
        system_message,
        anthropic_messages,
        anthropic_tools,
        extra_body,
        request_context.as_ref(),
    )?;
    let inline_think_in_text = client.config.inline_think_in_text;
    let idle_timeout = client.stream_options.idle_timeout;
    let ttft_timeout = client.stream_options.ttft_timeout;

    let compatibility = crate::providers::opencode::FreeTools::prepare(client, &mut request_body)?;

    execute_sse_request(
        Some(client),
        "Anthropic Streaming API",
        &url,
        &request_body,
        max_tries,
        ttft_timeout,
        trace,
        || {
            shared::apply_affinity_headers(
                client,
                apply_headers(client, client.client.post(&url), &url),
                &url,
                request_context.as_ref(),
            )
        },
        move |response, tx, tx_raw, remaining_ttft_timeout| {
            handle_anthropic_stream(
                response,
                tx,
                tx_raw,
                inline_think_in_text,
                remaining_ttft_timeout,
                idle_timeout,
            )
        },
    )
    .await
    .map(|response| compatibility.wrap(response))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn unsigned_tool_loop_runs_without_thinking_but_signed_loops_keep_it() {
        let body = |assistant: serde_json::Value| {
            serde_json::json!({
                "thinking": {"type": "enabled", "budget_tokens": 1024},
                "output_config": {"effort": "high"},
                "messages": [
                    {"role": "user", "content": [{"type": "text", "text": "go"}]},
                    assistant,
                    {"role": "user", "content": [{"type": "tool_result", "tool_use_id": "t1", "content": "ok"}]}
                ]
            })
        };
        let tool_use =
            serde_json::json!({"type": "tool_use", "id": "t1", "name": "read", "input": {}});
        let mut unsigned =
            body(serde_json::json!({"role": "assistant", "content": [tool_use.clone()]}));
        suspend_thinking_for_unsigned_tool_loop(&mut unsigned, "claude-sonnet-4-5");
        assert_eq!(
            unsigned["thinking"],
            serde_json::json!({"type": "disabled"})
        );
        assert!(unsigned.get("output_config").is_none());

        let mut adaptive_only =
            body(serde_json::json!({"role": "assistant", "content": [tool_use.clone()]}));
        suspend_thinking_for_unsigned_tool_loop(&mut adaptive_only, "claude-fable-5");
        assert!(adaptive_only.get("thinking").is_none());

        let mut signed = body(serde_json::json!({"role": "assistant", "content": [
            {"type": "thinking", "thinking": "plan", "signature": "sig"}, tool_use.clone()
        ]}));
        suspend_thinking_for_unsigned_tool_loop(&mut signed, "claude-sonnet-4-5");
        assert_eq!(signed["thinking"]["type"], "enabled");

        let mut plain = body(
            serde_json::json!({"role": "assistant", "content": [{"type": "text", "text": "done"}]}),
        );
        suspend_thinking_for_unsigned_tool_loop(&mut plain, "claude-sonnet-4-5");
        assert_eq!(plain["thinking"]["type"], "enabled");
    }

    #[test]
    fn xiaomi_mimo_headers_use_bearer_for_messages_and_discovery() {
        for host in ["api.xiaomimimo.com", "token-plan-cn.xiaomimimo.com"] {
            for suffix in ["v1/messages", "v1/models"] {
                let url = format!("https://{host}/anthropic/{suffix}");
                let client = AIClient::new(
                    serde_json::from_value(serde_json::json!({
                        "name": "MiMo", "base_url": format!("https://{host}/anthropic"),
                        "request_url": url, "api_key": "synthetic",
                        "model": "mimo-v2.6-pro", "format": "anthropic",
                        "context_window": 4096, "inline_think_in_text": false,
                        "skip_ssl_verify": false
                    }))
                    .unwrap(),
                );
                let request = apply_headers(&client, client.client.post(&url), &url)
                    .build()
                    .unwrap();
                assert_eq!(request.headers()["authorization"], "Bearer synthetic");
                assert!(!request.headers().contains_key("x-api-key"));
            }
        }
        for url in [
            "https://api.xiaomimimo.com.evil.test/anthropic/v1/messages",
            "https://evil.test/anthropic/api.xiaomimimo.com/v1/messages",
            "http://api.xiaomimimo.com/anthropic/v1/messages",
            "https://api.xiaomimimo.com:8443/anthropic/v1/messages",
            "https://api.xiaomimimo.com/v1/chat/completions",
            "https://api.xiaomimimo.com/anthropic-other/v1/messages",
        ] {
            assert!(!wants_bearer_auth(url), "{url}");
        }
    }

    #[test]
    fn bearer_auth_matches_each_gateway_documented_scheme() {
        // Vendors that document ANTHROPIC_AUTH_TOKEN for their Claude-compatible gateway.
        for url in [
            "https://inference-api.nousresearch.com/v1/messages",
            "https://inference-api.nousresearch.com/v1/models",
            "https://open.bigmodel.cn/api/anthropic/v1/messages",
            "https://api.z.ai/api/anthropic/v1/messages",
            "https://api.kimi.com/coding/v1/messages",
            "https://api.moonshot.cn/anthropic/v1/messages",
            "https://api.moonshot.ai/anthropic/v1/messages",
        ] {
            assert!(
                wants_bearer_auth(url),
                "{url} should authenticate with a bearer token"
            );
        }

        // These document ANTHROPIC_API_KEY (x-api-key) instead, so they must stay on the
        // default branch even though their paths look similar.
        for url in [
            "https://inference-api.nousresearch.com.evil.test/v1/messages",
            "http://inference-api.nousresearch.com/v1/messages",
            "https://api.deepseek.com/anthropic/v1/messages",
            "https://api.minimaxi.com/anthropic/v1/messages",
            "https://api.minimax.io/anthropic/v1/messages",
            "https://api.siliconflow.cn/v1/messages",
            "https://api.anthropic.com/v1/messages",
        ] {
            assert!(
                !wants_bearer_auth(url),
                "{url} should authenticate with x-api-key"
            );
        }
    }

    #[test]
    fn bearer_auth_holds_for_model_discovery_urls() {
        // Discovery hits /v1/models on the same base, so both paths must agree.
        assert!(wants_bearer_auth("https://api.kimi.com/coding/v1/models"));
        assert!(wants_bearer_auth(
            "https://api.moonshot.cn/anthropic/v1/models"
        ));
        assert!(!wants_bearer_auth("https://api.moonshot.cn/v1/models"));
    }

    #[test]
    fn moonshot_bearer_auth_is_limited_to_the_anthropic_gateway() {
        // The OpenAI-compatible Moonshot base never reaches this module, but keep the
        // qualifier honest so a future caller cannot pick up the wrong scheme.
        assert!(!wants_bearer_auth(
            "https://api.moonshot.cn/v1/chat/completions"
        ));
        assert!(!wants_bearer_auth(
            "https://api.moonshot.ai/v1/chat/completions"
        ));
    }

    #[test]
    fn claude_5_family_thinking_capabilities() {
        use AnthropicThinkingCapability::*;

        // Fable rejects an explicit thinking.type=disabled, so it must omit the field.
        assert_eq!(
            anthropic_thinking_capability("claude-fable-5"),
            AdaptiveDefaultNoDisabled
        );
        assert_eq!(
            anthropic_thinking_capability("claude-mythos-preview"),
            AdaptiveDefaultNoDisabled
        );
        assert_eq!(
            anthropic_thinking_capability("claude-opus-5"),
            AdaptivePreferred
        );
        assert_eq!(
            anthropic_thinking_capability("claude-sonnet-5"),
            AdaptivePreferred
        );
        // Haiku 4.5 takes budget_tokens and errors on effort.
        assert_eq!(
            anthropic_thinking_capability("claude-haiku-4-5"),
            ManualOnly
        );
    }

    fn cache_test_client() -> AIClient {
        AIClient::new(
            serde_json::from_value(serde_json::json!({
                "name": "Claude", "base_url": "https://api.anthropic.com",
                "request_url": "https://api.anthropic.com/v1/messages", "api_key": "synthetic",
                "model": "claude-sonnet-5", "format": "anthropic",
                "context_window": 200000, "inline_think_in_text": false,
                "skip_ssl_verify": false
            }))
            .unwrap(),
        )
    }

    fn cache_test_tools() -> Option<Vec<serde_json::Value>> {
        Some(vec![
            serde_json::json!({"name": "Read", "description": "Read", "input_schema": {"type": "object"}}),
            serde_json::json!({"name": "Bash", "description": "Bash", "input_schema": {"type": "object"}}),
        ])
    }

    fn cache_marker_paths(value: &serde_json::Value, path: String, out: &mut Vec<String>) {
        match value {
            serde_json::Value::Object(map) => {
                if map.contains_key("cache_control") {
                    out.push(path.clone());
                }
                for (key, child) in map {
                    cache_marker_paths(child, format!("{path}/{key}"), out);
                }
            }
            serde_json::Value::Array(items) => {
                for (index, child) in items.iter().enumerate() {
                    cache_marker_paths(child, format!("{path}/{index}"), out);
                }
            }
            _ => {}
        }
    }

    fn cache_markers(body: &serde_json::Value) -> Vec<String> {
        let mut out = Vec::new();
        cache_marker_paths(body, String::new(), &mut out);
        out
    }

    #[test]
    fn prompt_cache_breakpoints_mark_stable_head_and_last_two_messages() {
        let client = cache_test_client();
        let messages = vec![
            serde_json::json!({"role": "user", "content": [{"type": "text", "text": "Fix the build"}]}),
            serde_json::json!({"role": "assistant", "content": [
                {"type": "thinking", "thinking": "plan", "signature": "sig"},
                {"type": "text", "text": "Reading."},
                {"type": "tool_use", "id": "call_1", "name": "Read", "input": {"path": "a"}}
            ]}),
            serde_json::json!({"role": "user", "content": [
                {"type": "tool_result", "tool_use_id": "call_1", "content": "file body"}
            ]}),
        ];
        let body = build_request_body(
            &client,
            &client.config.request_url,
            Some("System prompt".to_string()),
            messages,
            cache_test_tools(),
            None,
        );

        assert_eq!(
            cache_markers(&body),
            vec![
                "/messages/1/content/2",
                "/messages/2/content/0",
                "/system/0"
            ]
        );
        assert_eq!(
            body["system"],
            serde_json::json!([{
                "type": "text", "text": "System prompt",
                "cache_control": {"type": "ephemeral"}
            }])
        );
        assert_eq!(body["messages"][0]["content"][0]["text"], "Fix the build");
    }

    #[test]
    fn prompt_cache_breakpoints_skip_thinking_and_blank_blocks() {
        let client = cache_test_client();
        let body = build_request_body(
            &client,
            &client.config.request_url,
            None,
            vec![
                serde_json::json!({"role": "user", "content": [
                    {"type": "text", "text": "Explain"},
                    {"type": "text", "text": "   "}
                ]}),
                serde_json::json!({"role": "assistant", "content": [
                    {"type": "thinking", "thinking": "only reasoning", "signature": "sig"}
                ]}),
            ],
            cache_test_tools(),
            None,
        );

        // Without a system prompt the last tool ends the stable head.
        assert_eq!(
            cache_markers(&body),
            vec!["/messages/0/content/0", "/tools/1"]
        );
    }

    #[test]
    fn custom_top_level_cache_control_replaces_the_breakpoint_policy() {
        let client = cache_test_client();
        let messages = vec![
            serde_json::json!({"role": "user", "content": [{"type": "text", "text": "hello"}]}),
        ];

        let automatic = build_request_body(
            &client,
            &client.config.request_url,
            Some("System prompt".to_string()),
            messages.clone(),
            cache_test_tools(),
            Some(serde_json::json!({"cache_control": {"type": "ephemeral", "ttl": "1h"}})),
        );
        assert_eq!(cache_markers(&automatic), vec![""]);
        assert_eq!(automatic["system"], "System prompt");

        let opted_out = build_request_body(
            &client,
            &client.config.request_url,
            Some("System prompt".to_string()),
            messages,
            cache_test_tools(),
            Some(serde_json::json!({"cache_control": null})),
        );
        assert!(cache_markers(&opted_out).is_empty());
        assert!(opted_out.get("cache_control").is_none());
        assert_eq!(opted_out["system"], "System prompt");
    }

    #[test]
    fn existing_block_level_cache_control_is_left_untouched() {
        let client = cache_test_client();
        let body = build_request_body(
            &client,
            &client.config.request_url,
            Some("System prompt".to_string()),
            vec![serde_json::json!({"role": "user", "content": [
                {"type": "text", "text": "pinned", "cache_control": {"type": "ephemeral", "ttl": "1h"}},
                {"type": "text", "text": "hello"}
            ]})],
            None,
            None,
        );

        assert_eq!(cache_markers(&body), vec!["/messages/0/content/0"]);
        assert_eq!(body["system"], "System prompt");
    }

    #[test]
    fn non_claude_models_never_take_the_claude_thinking_paths() {
        use AnthropicThinkingCapability::*;

        // These reach the Anthropic builder through vendor gateways; emitting Claude's
        // adaptive fields to them would be rejected.
        for model in ["minimax-m3", "glm-5.2", "kimi-k3", "kimi-k2.7-code"] {
            assert_eq!(anthropic_thinking_capability(model), ManualOnly, "{model}");
        }
    }
}
