use crate::client::utils::{dedupe_remote_models, normalize_base_url_for_discovery};
use crate::client::AIClient;
use crate::providers::reasoning::{
    self, normalize_dashscope_reasoning_effort, normalize_deepseek_reasoning_effort,
    normalize_glm_52_reasoning_effort, normalize_glm_53_reasoning_effort,
    normalize_siliconflow_reasoning_effort, resolve_reasoning_rule, ReasoningApiFormat,
    ReasoningRule,
};
use crate::providers::shared;
use crate::types::{
    ReasoningPresetAction, ReasoningPresetDescriptor, RemoteModelInfo, ToolDefinition,
};
use anyhow::{anyhow, Context, Result};
use reqwest::RequestBuilder;
use serde::Deserialize;

#[derive(Debug, Deserialize)]
struct OpenAIModelsResponse {
    data: Vec<OpenAIModelEntry>,
}

#[derive(Debug, Deserialize)]
struct OpenAIModelEntry {
    id: String,
}

pub(crate) fn apply_headers(client: &AIClient, builder: RequestBuilder) -> RequestBuilder {
    shared::apply_header_policy(client, builder, |mut builder| {
        builder = builder
            .header("Content-Type", "application/json")
            .header("Authorization", format!("Bearer {}", client.config.api_key));

        if client.config.base_url.contains("openbitfun.com") {
            builder = builder.header("X-Verification-Code", "from_openbitfun");
        }

        builder
    })
}

pub(crate) fn compile_chat_reasoning_action(
    preset: &ReasoningPresetDescriptor,
    action: &ReasoningPresetAction,
    request_body: &mut serde_json::Value,
    url: &str,
    configured_model: &str,
) -> Result<bool> {
    let execution_provider = preset.execution_provider.as_deref().unwrap_or("openai");
    let execution_model = preset
        .execution_model
        .as_deref()
        .unwrap_or(configured_model)
        .trim()
        .to_ascii_lowercase();
    let rule = resolve_reasoning_rule(
        ReasoningApiFormat::OpenAiChat,
        execution_provider,
        url,
        &execution_model,
    );
    let is_deepseek_reasoning_target = matches!(rule, ReasoningRule::DeepSeek { .. });
    let is_glm_reasoning_target = matches!(rule, ReasoningRule::Glm52 | ReasoningRule::Glm53);
    let is_generic_reasoning = shared::is_generic_reasoning_preset(preset);

    match action {
        ReasoningPresetAction::Toggle { enabled } if is_deepseek_reasoning_target => {
            request_body["thinking"] = serde_json::json!({
                "type": if *enabled { "enabled" } else { "disabled" }
            });
            if !enabled {
                request_body
                    .as_object_mut()
                    .map(|body| body.remove("reasoning_effort"));
            }
            Ok(true)
        }
        ReasoningPresetAction::Effort { value } if is_deepseek_reasoning_target => {
            let normalized = normalize_deepseek_reasoning_effort(&execution_model, value)
                .ok_or_else(|| {
                    anyhow!(
                        "DeepSeek reasoning effort '{}' is unsupported for model '{}'",
                        value,
                        execution_model
                    )
                })?;
            request_body["thinking"] = serde_json::json!({ "type": "enabled" });
            request_body["reasoning_effort"] = serde_json::json!(normalized);
            Ok(true)
        }
        ReasoningPresetAction::Toggle { enabled } if is_glm_reasoning_target => {
            if matches!(rule, ReasoningRule::Glm53) && !enabled {
                request_body["thinking"] = serde_json::json!({ "type": "enabled" });
                return Ok(true);
            }
            request_body["thinking"] = serde_json::json!({
                "type": if *enabled { "enabled" } else { "disabled" }
            });
            if !enabled {
                request_body
                    .as_object_mut()
                    .map(|body| body.remove("reasoning_effort"));
            }
            Ok(true)
        }
        ReasoningPresetAction::Effort { value } if is_glm_reasoning_target => {
            let normalized = match rule {
                ReasoningRule::Glm52 => normalize_glm_52_reasoning_effort(value),
                ReasoningRule::Glm53 => normalize_glm_53_reasoning_effort(value),
                _ => None,
            }
            .ok_or_else(|| anyhow!("GLM reasoning effort '{}' is unsupported", value))?;
            request_body["thinking"] = serde_json::json!({ "type": "enabled" });
            request_body["reasoning_effort"] = serde_json::json!(normalized);
            Ok(true)
        }
        ReasoningPresetAction::Toggle { enabled }
            if matches!(rule, ReasoningRule::DashScope { .. })
                || matches!(rule, ReasoningRule::SiliconFlow { .. }) =>
        {
            if matches!(rule, ReasoningRule::DashScope { forced: true, .. }) && !enabled {
                return Ok(true);
            }
            if !reasoning::apply_openai_compatible_toggle(request_body, *enabled, url) {
                request_body["enable_thinking"] = serde_json::json!(*enabled);
            }
            if !enabled {
                request_body
                    .as_object_mut()
                    .map(|body| body.remove("reasoning_effort"));
            }
            Ok(true)
        }
        ReasoningPresetAction::Effort { value }
            if matches!(rule, ReasoningRule::DashScope { effort: true, .. })
                || matches!(rule, ReasoningRule::SiliconFlow { effort: true }) =>
        {
            let normalized = match rule {
                ReasoningRule::DashScope { .. } => {
                    normalize_dashscope_reasoning_effort(&execution_model, value)
                }
                ReasoningRule::SiliconFlow { .. } => normalize_siliconflow_reasoning_effort(value),
                _ => None,
            }
            .ok_or_else(|| anyhow!("Reasoning effort '{}' is unsupported", value))?;
            request_body["enable_thinking"] = serde_json::json!(true);
            request_body["reasoning_effort"] = serde_json::json!(normalized);
            request_body
                .as_object_mut()
                .map(|body| body.remove("thinking_budget"));
            Ok(true)
        }
        ReasoningPresetAction::BudgetTokens { value }
            if matches!(
                rule,
                ReasoningRule::DashScope { .. } | ReasoningRule::SiliconFlow { .. }
            ) =>
        {
            if !reasoning::apply_openai_compatible_budget(request_body, *value, url) {
                request_body["enable_thinking"] = serde_json::json!(true);
                request_body["thinking_budget"] = serde_json::json!(*value);
            }
            Ok(true)
        }
        ReasoningPresetAction::Toggle { enabled } if is_generic_reasoning => {
            if !reasoning::apply_openai_compatible_toggle(request_body, *enabled, url) {
                request_body["thinking"] = serde_json::json!({
                    "type": if *enabled { "enabled" } else { "disabled" }
                });
            }
            if !enabled {
                request_body
                    .as_object_mut()
                    .map(|body| body.remove("reasoning_effort"));
            }
            Ok(true)
        }
        ReasoningPresetAction::Effort { value } if is_generic_reasoning => {
            reasoning::compile_format_fallback(
                ReasoningApiFormat::OpenAiChat,
                &ReasoningPresetAction::Effort {
                    value: value.clone(),
                },
                request_body,
                None,
            )
        }
        ReasoningPresetAction::Toggle { enabled } => {
            if reasoning::apply_openai_compatible_toggle(request_body, *enabled, url) {
                Ok(true)
            } else {
                reasoning::compile_format_fallback(
                    ReasoningApiFormat::OpenAiChat,
                    &ReasoningPresetAction::Toggle { enabled: *enabled },
                    request_body,
                    None,
                )
            }
        }
        ReasoningPresetAction::Effort { value } => reasoning::compile_format_fallback(
            ReasoningApiFormat::OpenAiChat,
            &ReasoningPresetAction::Effort {
                value: value.clone(),
            },
            request_body,
            None,
        ),
        ReasoningPresetAction::BudgetTokens { value } => reasoning::compile_format_fallback(
            ReasoningApiFormat::OpenAiChat,
            &ReasoningPresetAction::BudgetTokens { value: *value },
            request_body,
            None,
        ),
        ReasoningPresetAction::RequestPatch { .. } => {
            unreachable!("patches are compiled by shared code")
        }
    }
}

pub(crate) fn resolve_models_url(client: &AIClient) -> String {
    let mut base = normalize_base_url_for_discovery(&client.config.base_url);

    for suffix in ["/chat/completions", "/responses", "/models"] {
        if base.ends_with(suffix) {
            base.truncate(base.len() - suffix.len());
            break;
        }
    }

    if base.is_empty() {
        return "models".to_string();
    }

    format!("{}/models", base)
}

pub(crate) async fn list_models(client: &AIClient) -> Result<Vec<RemoteModelInfo>> {
    let url = resolve_models_url(client);

    // Codex CLI's ChatGPT backend (`chatgpt.com/backend-api/codex`) hosts a
    // private, non-OpenAI-shaped `/models` endpoint that returns
    // `{ "models": [{ "slug": "...", "display_name": "..." }, ...] }`. Detect
    // and route it through a dedicated parser instead of the public OpenAI
    // schema (which would yield zero models because of the envelope mismatch).
    if url.contains("chatgpt.com/backend-api/codex") {
        return list_codex_chatgpt_models(client, &url).await;
    }

    let response = apply_headers(client, client.client.get(&url))
        .send()
        .await?
        .error_for_status()?;

    let payload: OpenAIModelsResponse = response.json().await?;
    Ok(dedupe_remote_models(
        payload
            .data
            .into_iter()
            .map(|model| RemoteModelInfo {
                routing: None,
                id: model.id,
                display_name: None,
            })
            .collect(),
    ))
}

#[derive(Debug, Deserialize)]
struct CodexBackendModelsResponse {
    #[serde(default)]
    models: Vec<CodexBackendModelEntry>,
}

#[derive(Debug, Deserialize)]
struct CodexBackendModelEntry {
    slug: String,
    #[serde(default)]
    display_name: Option<String>,
    /// Codex backend marks deprecated/internal slugs with `visibility = "hide"`.
    /// We only surface entries the CLI itself shows (`list`).
    #[serde(default)]
    visibility: Option<String>,
    #[serde(default)]
    priority: Option<i64>,
}

fn codex_models_from_entries(mut entries: Vec<CodexBackendModelEntry>) -> Vec<RemoteModelInfo> {
    entries.retain(|model| {
        !model.slug.trim().is_empty()
            && !model.visibility.as_deref().is_some_and(|value| {
                matches!(
                    value.trim().to_ascii_lowercase().as_str(),
                    "hide" | "hidden"
                )
            })
    });
    entries.sort_by(|a, b| {
        a.priority
            .unwrap_or(10_000)
            .cmp(&b.priority.unwrap_or(10_000))
            .then_with(|| a.slug.cmp(&b.slug))
    });
    dedupe_remote_models(
        entries
            .into_iter()
            .map(|model| RemoteModelInfo {
                routing: None,
                id: model.slug,
                display_name: model.display_name,
            })
            .collect(),
    )
}

/// `chatgpt.com/backend-api/codex/models` returns each model's
/// `minimal_client_version`, and only emits entries whose minimum is satisfied
/// by the `client_version` query param. Hermes-agent uses `client_version=1.0.0`
/// for discovery, which avoids accidentally hiding newer models when the local
/// CLI binary is old or unavailable.
fn codex_models_url(base_models_url: &str) -> String {
    let separator = if base_models_url.contains('?') {
        '&'
    } else {
        '?'
    };
    format!("{base_models_url}{separator}client_version=1.0.0")
}

async fn list_codex_chatgpt_models(
    client: &AIClient,
    base_models_url: &str,
) -> Result<Vec<RemoteModelInfo>> {
    let url = codex_models_url(base_models_url);

    let response = apply_headers(client, client.client.get(&url))
        .send()
        .await
        .context("fetch Codex subscription models")?
        .error_for_status()
        .context("Codex subscription model discovery failed")?;
    let payload: CodexBackendModelsResponse = response
        .json()
        .await
        .context("parse Codex subscription models")?;
    let models = codex_models_from_entries(payload.models);
    if models.is_empty() {
        return Err(anyhow!("Codex returned no visible models for this account"));
    }
    Ok(models)
}

pub(crate) fn extract_tool_name(tool: &serde_json::Value) -> String {
    tool.get("function")
        .and_then(|function| function.get("name"))
        .and_then(|name| name.as_str())
        .or_else(|| tool.get("name").and_then(|name| name.as_str()))
        .unwrap_or("unknown")
        .to_string()
}

pub(crate) fn attach_tools(
    request_body: &mut serde_json::Value,
    tools: Option<Vec<serde_json::Value>>,
    target: &str,
) {
    match tools {
        Some(tools) if !tools.is_empty() => {
            let tool_names = tools.iter().map(extract_tool_name).collect::<Vec<_>>();
            shared::log_tool_names(target, tool_names);
            request_body["tools"] = serde_json::Value::Array(tools);
            let has_tool_choice = request_body
                .get("tool_choice")
                .is_some_and(|value| !value.is_null());
            if !has_tool_choice {
                request_body["tool_choice"] = serde_json::Value::String("auto".to_string());
            }
        }
        _ => {
            if request_body
                .as_object_mut()
                .and_then(|object| object.remove("tool_choice"))
                .is_some()
            {
                log::debug!(
                    target: target,
                    "Removed tool_choice from OpenAI request because no tools are attached"
                );
            }
        }
    }
}

pub(crate) fn convert_tools_flat(
    tools: Option<Vec<ToolDefinition>>,
) -> Option<Vec<serde_json::Value>> {
    tools.map(|defs| {
        defs.into_iter()
            .map(|tool| {
                serde_json::json!({
                    "type": "function",
                    "name": tool.name,
                    "description": tool.description,
                    "parameters": tool.parameters,
                    "strict": false,
                })
            })
            .collect()
    })
}

#[cfg(test)]
mod tests {
    use super::attach_tools;
    use crate::providers::reasoning::{
        codex_subscription_model_allowed, is_known_codex_reasoning_model,
    };
    use serde_json::json;

    #[test]
    fn live_codex_catalog_keeps_subscription_only_and_new_models() {
        let payload: super::CodexBackendModelsResponse = serde_json::from_value(json!({
            "models": [
                {"slug": "gpt-5.3-codex-spark", "supported_in_api": false, "priority": 1,
                 "display_name": "GPT-5.3 Codex Spark", "visibility": "list"},
                {"slug": "future-subscription-model", "priority": 2},
                {"slug": "gpt-5.5-pro", "priority": 3},
                {"slug": "internal", "visibility": "hidden"},
                {"slug": "  "},
                {"slug": "gpt-5.3-codex-spark", "priority": 8}
            ]
        }))
        .unwrap();
        let models = super::codex_models_from_entries(payload.models);
        assert_eq!(
            models
                .iter()
                .map(|model| model.id.as_str())
                .collect::<Vec<_>>(),
            [
                "gpt-5.3-codex-spark",
                "future-subscription-model",
                "gpt-5.5-pro"
            ]
        );
        assert_eq!(
            models[0].display_name.as_deref(),
            Some("GPT-5.3 Codex Spark")
        );
    }

    #[test]
    fn attach_tools_removes_tool_choice_without_tools() {
        let mut request_body = json!({
            "model": "test-model",
            "messages": [],
            "stream": true,
            "tool_choice": "none"
        });

        attach_tools(&mut request_body, None, "test");

        assert!(request_body.get("tools").is_none());
        assert!(request_body.get("tool_choice").is_none());
    }

    #[test]
    fn codex_subscription_models_match_opencode_and_allow_future_variants() {
        for model in [
            "gpt-5.5",
            "gpt-5.3-codex-spark",
            "gpt-5.4",
            "gpt-5.4-mini",
            "gpt-5.6-sol",
            "gpt-6.0-codex",
        ] {
            assert!(codex_subscription_model_allowed(model), "{model}");
        }
        for model in ["gpt-5.5-pro", "gpt-5.6", "gpt-5.4-pro", "o3"] {
            assert!(!codex_subscription_model_allowed(model), "{model}");
        }

        assert!(is_known_codex_reasoning_model("GPT-5.5"));
        assert!(is_known_codex_reasoning_model("gpt-5-codex"));
        assert!(is_known_codex_reasoning_model("gpt-5.5-proxy"));
        assert!(!is_known_codex_reasoning_model("gpt-5.5-pro"));
    }

    #[test]
    fn attach_tools_removes_tool_choice_for_empty_tools() {
        let mut request_body = json!({
            "model": "test-model",
            "messages": [],
            "stream": true,
            "tool_choice": "none"
        });

        attach_tools(&mut request_body, Some(vec![]), "test");

        assert!(request_body.get("tools").is_none());
        assert!(request_body.get("tool_choice").is_none());
    }

    #[test]
    fn attach_tools_preserves_explicit_tool_choice_with_tools() {
        let mut request_body = json!({
            "model": "test-model",
            "messages": [],
            "stream": true,
            "tool_choice": "none"
        });

        attach_tools(
            &mut request_body,
            Some(vec![json!({
                "type": "function",
                "function": {
                    "name": "example",
                    "description": "Example tool",
                    "parameters": { "type": "object" }
                }
            })]),
            "test",
        );

        assert_eq!(request_body["tool_choice"], json!("none"));
        assert_eq!(
            request_body["tools"][0]["function"]["name"],
            json!("example")
        );
    }
}
