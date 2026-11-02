use crate::types::ReasoningPresetAction;
use anyhow::{anyhow, Result};
use serde_json::Value;

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub(crate) enum AnthropicThinkingCapability {
    ManualOnly,
    ManualEffort,
    AdaptivePreferred,
    AdaptiveOnly,
    AdaptiveDefaultNoDisabled,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub(crate) enum ReasoningRule {
    DeepSeek { flash: bool },
    Glm52,
    Glm53,
    DashScope { effort: bool, forced: bool },
    SiliconFlow { effort: bool },
    Claude(AnthropicThinkingCapability),
    Gemini3 { minimal: bool },
    Gemini25 { flash: bool },
    CodexChatGpt,
    Incompatible,
    FormatFallback,
}

#[derive(Debug, Clone, Copy, Default, PartialEq, Eq)]
pub(crate) struct ReasoningRuleCapabilities {
    pub(crate) effort: bool,
    pub(crate) toggle: bool,
    pub(crate) budget_tokens: bool,
    pub(crate) nullable_effort: bool,
}

/// Protocol-level defaults used when no provider/model-specific reasoning rule
/// is known. Provider quirks are handled before reaching this function.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub(crate) enum ReasoningApiFormat {
    OpenAiChat,
    OpenAiResponses,
    Anthropic,
    Gemini,
}

pub(crate) fn resolve_reasoning_rule(
    format: ReasoningApiFormat,
    provider: &str,
    base_url: &str,
    model: &str,
) -> ReasoningRule {
    let provider = provider.trim().to_ascii_lowercase();
    let model = model.trim().to_ascii_lowercase();

    if matches!(
        format,
        ReasoningApiFormat::OpenAiChat | ReasoningApiFormat::Anthropic
    ) && (provider == "deepseek"
        || is_deepseek_url(base_url)
        || is_deepseek_reasoning_effort_model(&model))
    {
        return ReasoningRule::DeepSeek {
            flash: is_deepseek_flash_model(&model),
        };
    }

    if matches!(
        format,
        ReasoningApiFormat::OpenAiChat | ReasoningApiFormat::Anthropic
    ) && is_glm_53_reasoning_effort_model(&model)
        && (provider == "zhipuai" || is_zhipuai_url(base_url))
    {
        return ReasoningRule::Glm53;
    }

    if matches!(
        format,
        ReasoningApiFormat::OpenAiChat | ReasoningApiFormat::Anthropic
    ) && is_glm_52_reasoning_effort_model(&model)
        && (provider == "zhipuai" || is_zhipuai_url(base_url))
    {
        return ReasoningRule::Glm52;
    }

    match format {
        ReasoningApiFormat::OpenAiChat => {
            if matches!(provider.as_str(), "anthropic" | "gemini" | "google") {
                ReasoningRule::Incompatible
            } else if matches!(provider.as_str(), "dashscope" | "alibaba" | "aliyun")
                || is_dashscope_url(base_url)
            {
                ReasoningRule::DashScope {
                    effort: is_dashscope_effort_model(&model),
                    forced: is_dashscope_forced_model(&model),
                }
            } else if matches!(provider.as_str(), "siliconflow" | "silicon_flow")
                || is_siliconflow_url(base_url)
            {
                ReasoningRule::SiliconFlow {
                    effort: is_siliconflow_effort_model(&model),
                }
            } else {
                ReasoningRule::FormatFallback
            }
        }
        ReasoningApiFormat::OpenAiResponses => {
            if is_codex_chatgpt_endpoint(base_url) {
                ReasoningRule::CodexChatGpt
            } else {
                ReasoningRule::FormatFallback
            }
        }
        ReasoningApiFormat::Anthropic => {
            ReasoningRule::Claude(anthropic_thinking_capability(&model))
        }
        ReasoningApiFormat::Gemini => {
            if model.starts_with("gemini-3-") || model.starts_with("gemini-3.1-") {
                ReasoningRule::Gemini3 {
                    minimal: gemini_supports_minimal_thinking_level(&model),
                }
            } else if model.starts_with("gemini-2.5-") {
                ReasoningRule::Gemini25 {
                    flash: model.starts_with("gemini-2.5-flash"),
                }
            } else {
                ReasoningRule::FormatFallback
            }
        }
    }
}

impl ReasoningRule {
    pub(crate) fn capabilities(self, format: ReasoningApiFormat) -> ReasoningRuleCapabilities {
        match self {
            Self::DeepSeek { .. } | Self::Glm52 => ReasoningRuleCapabilities {
                effort: true,
                toggle: true,
                ..Default::default()
            },
            Self::Glm53 => ReasoningRuleCapabilities {
                effort: true,
                ..Default::default()
            },
            Self::DashScope { effort, forced } => ReasoningRuleCapabilities {
                effort,
                toggle: !forced,
                budget_tokens: true,
                ..Default::default()
            },
            Self::SiliconFlow { effort } => ReasoningRuleCapabilities {
                effort,
                toggle: true,
                budget_tokens: true,
                ..Default::default()
            },
            Self::Claude(capability) => ReasoningRuleCapabilities {
                effort: true,
                toggle: !matches!(
                    capability,
                    AnthropicThinkingCapability::AdaptiveOnly
                        | AnthropicThinkingCapability::AdaptiveDefaultNoDisabled
                ),
                budget_tokens: !matches!(
                    capability,
                    AnthropicThinkingCapability::AdaptiveOnly
                        | AnthropicThinkingCapability::AdaptiveDefaultNoDisabled
                ),
                ..Default::default()
            },
            Self::Gemini3 { .. } => ReasoningRuleCapabilities {
                effort: true,
                ..Default::default()
            },
            Self::Gemini25 { flash } => ReasoningRuleCapabilities {
                toggle: flash,
                budget_tokens: true,
                ..Default::default()
            },
            Self::CodexChatGpt => ReasoningRuleCapabilities {
                effort: true,
                toggle: true,
                nullable_effort: true,
                ..Default::default()
            },
            Self::Incompatible => ReasoningRuleCapabilities::default(),
            Self::FormatFallback => match format {
                ReasoningApiFormat::OpenAiChat => ReasoningRuleCapabilities {
                    effort: true,
                    toggle: true,
                    ..Default::default()
                },
                ReasoningApiFormat::OpenAiResponses => ReasoningRuleCapabilities {
                    effort: true,
                    toggle: true,
                    nullable_effort: true,
                    ..Default::default()
                },
                ReasoningApiFormat::Anthropic | ReasoningApiFormat::Gemini => {
                    ReasoningRuleCapabilities {
                        effort: true,
                        toggle: true,
                        budget_tokens: true,
                        ..Default::default()
                    }
                }
            },
        }
    }
}

pub(crate) fn api_format_for_provider(provider: &str, base_url: &str) -> ReasoningApiFormat {
    let provider = provider.trim().to_ascii_lowercase();
    if matches!(provider.as_str(), "response" | "responses")
        || (provider == "openai" && is_responses_endpoint(base_url))
    {
        ReasoningApiFormat::OpenAiResponses
    } else if provider == "anthropic" {
        ReasoningApiFormat::Anthropic
    } else if matches!(provider.as_str(), "gemini" | "google") {
        ReasoningApiFormat::Gemini
    } else {
        ReasoningApiFormat::OpenAiChat
    }
}

pub(crate) fn is_responses_endpoint(base_url: &str) -> bool {
    base_url
        .trim_end_matches('/')
        .to_ascii_lowercase()
        .ends_with("/responses")
}

pub(crate) fn anthropic_thinking_capability(model_name: &str) -> AnthropicThinkingCapability {
    if model_name.starts_with("claude-mythos") || model_name.starts_with("claude-fable") {
        return AnthropicThinkingCapability::AdaptiveDefaultNoDisabled;
    }

    if let Some(version) = parse_claude_model_version(model_name, "opus") {
        if version.major > 4 || (version.major == 4 && version.minor >= 7) {
            return AnthropicThinkingCapability::AdaptiveOnly;
        }
        if version.major == 4 && version.minor >= 6 {
            return AnthropicThinkingCapability::AdaptivePreferred;
        }
        if version.major == 4 && version.minor == 5 {
            return AnthropicThinkingCapability::ManualEffort;
        }
    }

    if let Some(version) = parse_claude_model_version(model_name, "sonnet") {
        if version.major > 4 || (version.major == 4 && version.minor >= 7) {
            return AnthropicThinkingCapability::AdaptiveOnly;
        }
        if version.major == 4 && version.minor >= 6 {
            return AnthropicThinkingCapability::AdaptivePreferred;
        }
    }

    if let Some(version) = parse_claude_model_version(model_name, "haiku") {
        if version.major > 4 || (version.major == 4 && version.minor >= 7) {
            return AnthropicThinkingCapability::AdaptiveOnly;
        }
    }

    AnthropicThinkingCapability::ManualOnly
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
struct ClaudeModelVersion {
    major: u32,
    minor: u32,
}

fn parse_claude_model_version(model_name: &str, family: &str) -> Option<ClaudeModelVersion> {
    let prefix = format!("claude-{family}-");
    let rest = model_name.strip_prefix(&prefix)?;
    let mut parts = rest.split('-');
    let major = parts.next()?.parse().ok()?;
    let minor = parts.next().and_then(|part| part.parse().ok()).unwrap_or(0);
    Some(ClaudeModelVersion { major, minor })
}

pub(crate) fn is_dashscope_url(url: &str) -> bool {
    let url = url.to_ascii_lowercase();
    url.contains("dashscope.aliyuncs.com")
        || url.contains("dashscope-intl.aliyuncs.com")
        || url.contains(".maas.aliyuncs.com")
}

pub(crate) fn is_siliconflow_url(url: &str) -> bool {
    let url = url.to_ascii_lowercase();
    url.contains("api.siliconflow.cn") || url.contains("api.siliconflow.com")
}

pub(crate) fn is_deepseek_url(url: &str) -> bool {
    url.to_ascii_lowercase().contains("api.deepseek.com")
}

pub(crate) fn is_zhipuai_url(url: &str) -> bool {
    reqwest::Url::parse(url.trim()).ok().is_some_and(|url| {
        url.scheme() == "https"
            && url.port_or_known_default() == Some(443)
            && url.host_str().is_some_and(|host| {
                matches!(host.trim_end_matches('.'), "open.bigmodel.cn" | "api.z.ai")
            })
    })
}

pub(crate) fn is_deepseek_reasoning_effort_model(model_name: &str) -> bool {
    matches!(
        model_name.trim().to_ascii_lowercase().as_str(),
        "deepseek-flash" | "deepseek-v4-flash" | "deepseek-v4-pro"
    )
}

fn is_deepseek_flash_model(model_name: &str) -> bool {
    matches!(
        model_name.trim().to_ascii_lowercase().as_str(),
        "deepseek-flash" | "deepseek-v4-flash"
    )
}

pub(crate) fn is_glm_52_reasoning_effort_model(model_name: &str) -> bool {
    matches!(
        model_name.trim().to_ascii_lowercase().as_str(),
        "glm-5.2" | "glm-5-2" | "glm-5p2"
    )
}

pub(crate) fn is_glm_53_reasoning_effort_model(model_name: &str) -> bool {
    matches!(
        model_name.trim().to_ascii_lowercase().as_str(),
        "glm-5.3" | "glm-5-3" | "glm-5p3" | "glm-5.3-flash" | "glm-5-3-flash"
    )
}

pub(crate) fn is_dashscope_effort_model(model_name: &str) -> bool {
    let model = model_name.trim().to_ascii_lowercase();
    model.contains("deepseek-v4") || model.contains("glm-5.3") || model.contains("glm-5-3")
}

pub(crate) fn is_dashscope_forced_model(model_name: &str) -> bool {
    let model = model_name.trim().to_ascii_lowercase();
    model.contains("glm-5.3") || model.contains("glm-5-3")
}

pub(crate) fn is_siliconflow_effort_model(model_name: &str) -> bool {
    let model = model_name.trim().to_ascii_lowercase();
    model.contains("deepseek-v4") || model.contains("glm-5.2") || model.contains("glm-5-2")
}

pub(crate) fn gemini_supports_minimal_thinking_level(model_name: &str) -> bool {
    let model = model_name.trim().to_ascii_lowercase();
    model.starts_with("gemini-3.1-") && !model.contains("pro")
}

pub(crate) fn normalize_gemini_reasoning_effort(
    model_name: &str,
    effort: &str,
) -> Option<&'static str> {
    match effort.trim().to_ascii_lowercase().as_str() {
        "minimal" if gemini_supports_minimal_thinking_level(model_name) => Some("MINIMAL"),
        "minimal" => Some("LOW"),
        "low" => Some("LOW"),
        "medium" => Some("MEDIUM"),
        "high" | "xhigh" | "max" => Some("HIGH"),
        "" | "none" => None,
        _ => None,
    }
}

pub(crate) fn parse_glm_major_minor(model_name: &str) -> Option<(u32, u32)> {
    let lower = model_name.to_ascii_lowercase();
    let tail = lower.strip_prefix("glm-")?;
    let mut parts = tail.split('-');
    let version = parts.next()?;

    let mut version_parts = version.split('.');
    let major = version_parts.next()?.parse().ok()?;
    let minor = version_parts
        .next()
        .and_then(|value| value.parse().ok())
        .unwrap_or(0);

    Some((major, minor))
}

pub(crate) fn normalize_deepseek_reasoning_effort(
    model_name: &str,
    effort: &str,
) -> Option<&'static str> {
    let is_flash = is_deepseek_flash_model(model_name);
    match effort.trim().to_ascii_lowercase().as_str() {
        "" => None,
        "low" if is_flash => Some("low"),
        "high" => Some("high"),
        "max" => Some("max"),
        "medium" => Some("high"),
        "low" | "xhigh" if !is_flash => Some("high"),
        "xhigh" if is_flash => Some("high"),
        "none" | "minimal" => None,
        _ => None,
    }
}

pub(crate) fn normalize_glm_53_reasoning_effort(effort: &str) -> Option<&'static str> {
    match effort.trim().to_ascii_lowercase().as_str() {
        "low" => Some("low"),
        "high" => Some("high"),
        "max" | "xhigh" => Some("max"),
        "" | "none" | "minimal" | "medium" => None,
        _ => None,
    }
}

pub(crate) fn normalize_siliconflow_reasoning_effort(effort: &str) -> Option<&'static str> {
    match effort.trim().to_ascii_lowercase().as_str() {
        "high" | "low" | "medium" => Some("high"),
        "max" | "xhigh" => Some("max"),
        "" | "none" | "minimal" => None,
        _ => None,
    }
}

pub(crate) fn normalize_dashscope_reasoning_effort(
    model_name: &str,
    effort: &str,
) -> Option<&'static str> {
    if model_name.trim().to_ascii_lowercase().contains("glm-5.3")
        || model_name.trim().to_ascii_lowercase().contains("glm-5-3")
    {
        return normalize_glm_53_reasoning_effort(effort);
    }
    normalize_siliconflow_reasoning_effort(effort)
}

pub(crate) fn apply_openai_compatible_budget(
    request_body: &mut Value,
    value: u32,
    url: &str,
) -> bool {
    if is_dashscope_url(url) || is_siliconflow_url(url) {
        request_body["enable_thinking"] = Value::Bool(true);
        request_body["thinking_budget"] = serde_json::json!(value);
        return true;
    }
    false
}

pub(crate) fn normalize_glm_52_reasoning_effort(effort: &str) -> Option<&'static str> {
    match effort.trim().to_ascii_lowercase().as_str() {
        "high" | "low" | "medium" => Some("high"),
        "max" | "xhigh" => Some("max"),
        "" | "none" | "minimal" => None,
        _ => None,
    }
}

const DEFAULT_CODEX_MODELS: &[&str] =
    &["gpt-5.5", "gpt-5.3-codex-spark", "gpt-5.4", "gpt-5.4-mini"];

fn parsed_gpt_version(model_id: &str) -> Option<(u32, u32)> {
    let version = model_id.strip_prefix("gpt-")?.split('-').next()?;
    let (major, minor) = version.split_once('.')?;
    if minor.contains('.') {
        return None;
    }
    Some((major.parse().ok()?, minor.parse().ok()?))
}

/// Mirrors the ChatGPT Codex subscription allowlist used for reasoning presets.
/// Exact `gpt-5.6` and the Pro entitlement remain excluded because the
/// subscription endpoint does not offer those products.
pub(crate) fn codex_subscription_model_allowed(model_id: &str) -> bool {
    let model_id = model_id.trim().to_ascii_lowercase();
    if DEFAULT_CODEX_MODELS.contains(&model_id.as_str()) {
        return true;
    }
    if matches!(model_id.as_str(), "gpt-5.5-pro" | "gpt-5.6") {
        return false;
    }
    parsed_gpt_version(&model_id).is_some_and(|version| version > (5, 4))
}

pub(crate) fn is_known_codex_reasoning_model(model_id: &str) -> bool {
    let model_id = model_id.trim().to_ascii_lowercase();
    model_id == "gpt-5-codex" || codex_subscription_model_allowed(&model_id)
}

pub(crate) fn apply_openai_compatible_toggle(
    request_body: &mut Value,
    enabled: bool,
    url: &str,
) -> bool {
    if is_dashscope_url(url) || is_siliconflow_url(url) {
        request_body["enable_thinking"] = serde_json::json!(enabled);
        return true;
    }
    if is_deepseek_url(url) {
        request_body["thinking"] = serde_json::json!({
            "type": if enabled { "enabled" } else { "disabled" }
        });
        return true;
    }
    false
}

fn is_codex_chatgpt_endpoint(url: &str) -> bool {
    reqwest::Url::parse(url.trim()).ok().is_some_and(|url| {
        url.scheme() == "https"
            && url.port_or_known_default() == Some(443)
            && url
                .host_str()
                .is_some_and(|host| host.trim_end_matches('.') == "chatgpt.com")
            && is_codex_chatgpt_path(url.path())
    })
}

pub(crate) fn is_codex_chatgpt_path(path: &str) -> bool {
    matches!(
        path.trim_end_matches('/'),
        "/backend-api/codex" | "/backend-api/codex/responses"
    )
}

pub(crate) fn compile_format_fallback(
    format: ReasoningApiFormat,
    action: &ReasoningPresetAction,
    request_body: &mut Value,
    max_tokens: Option<u32>,
) -> Result<bool> {
    match (format, action) {
        (ReasoningApiFormat::OpenAiChat, ReasoningPresetAction::Effort { value }) => {
            if value.trim().is_empty() {
                return Err(anyhow!("OpenAI Chat reasoning effort must not be empty"));
            }
            if let Some(body) = request_body.as_object_mut() {
                body.remove("thinking");
                body.remove("enable_thinking");
            }
            request_body["reasoning_effort"] = Value::String(value.clone());
            Ok(true)
        }
        (ReasoningApiFormat::OpenAiChat, ReasoningPresetAction::Toggle { enabled }) => {
            if let Some(body) = request_body.as_object_mut() {
                body.remove("thinking");
                body.remove("enable_thinking");
            }
            request_body["reasoning_effort"] =
                Value::String(if *enabled { "medium" } else { "none" }.to_string());
            Ok(true)
        }
        (ReasoningApiFormat::OpenAiChat, ReasoningPresetAction::BudgetTokens { .. }) => Ok(false),

        (ReasoningApiFormat::OpenAiResponses, ReasoningPresetAction::Effort { value }) => {
            if value.trim().is_empty() {
                return Err(anyhow!("Responses reasoning effort must not be empty"));
            }
            request_body["reasoning"] = serde_json::json!({
                "effort": value,
                "summary": "auto"
            });
            Ok(true)
        }
        (ReasoningApiFormat::OpenAiResponses, ReasoningPresetAction::Toggle { enabled }) => {
            request_body["reasoning"] = serde_json::json!({
                "effort": if *enabled { "medium" } else { "none" },
                "summary": "auto"
            });
            Ok(true)
        }
        (ReasoningApiFormat::OpenAiResponses, ReasoningPresetAction::BudgetTokens { .. }) => {
            Ok(false)
        }

        (ReasoningApiFormat::Anthropic, ReasoningPresetAction::Effort { value }) => {
            if value.trim().is_empty() {
                return Err(anyhow!("Anthropic reasoning effort must not be empty"));
            }
            request_body["thinking"] = serde_json::json!({ "type": "adaptive" });
            request_body["output_config"] = serde_json::json!({ "effort": value });
            Ok(true)
        }
        (ReasoningApiFormat::Anthropic, ReasoningPresetAction::Toggle { enabled: true }) => {
            request_body["thinking"] = serde_json::json!({ "type": "adaptive" });
            Ok(true)
        }
        (ReasoningApiFormat::Anthropic, ReasoningPresetAction::Toggle { enabled: false }) => {
            request_body["thinking"] = serde_json::json!({ "type": "disabled" });
            request_body
                .as_object_mut()
                .map(|body| body.remove("output_config"));
            Ok(true)
        }
        (ReasoningApiFormat::Anthropic, ReasoningPresetAction::BudgetTokens { value }) => {
            if max_tokens.is_some_and(|limit| *value >= limit) {
                return Err(anyhow!(
                    "Anthropic reasoning budget {} must be less than max_tokens {}",
                    value,
                    max_tokens.unwrap_or_default()
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

        (ReasoningApiFormat::Gemini, ReasoningPresetAction::Effort { value }) => {
            if value.trim().is_empty() {
                return Err(anyhow!("Gemini reasoning effort must not be empty"));
            }
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
        (ReasoningApiFormat::Gemini, ReasoningPresetAction::Toggle { enabled: true }) => {
            insert_generation_field(
                request_body,
                "thinkingConfig",
                serde_json::json!({
                    "includeThoughts": true,
                    "thinkingLevel": "MEDIUM",
                }),
            );
            Ok(true)
        }
        (ReasoningApiFormat::Gemini, ReasoningPresetAction::Toggle { enabled: false }) => {
            insert_generation_field(
                request_body,
                "thinkingConfig",
                serde_json::json!({
                    "includeThoughts": false,
                    "thinkingBudget": 0,
                }),
            );
            Ok(true)
        }
        (ReasoningApiFormat::Gemini, ReasoningPresetAction::BudgetTokens { value }) => {
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

        (_, ReasoningPresetAction::RequestPatch { .. }) => {
            unreachable!("patches are compiled by shared code")
        }
    }
}

fn insert_generation_field(request_body: &mut Value, key: &str, value: Value) {
    if !request_body
        .get("generationConfig")
        .is_some_and(Value::is_object)
    {
        request_body["generationConfig"] = serde_json::json!({});
    }
    request_body["generationConfig"][key] = value;
}

#[cfg(test)]
mod tests {
    use super::{
        compile_format_fallback, is_dashscope_url, normalize_deepseek_reasoning_effort,
        normalize_gemini_reasoning_effort, resolve_reasoning_rule, AnthropicThinkingCapability,
        ReasoningApiFormat, ReasoningRule,
    };
    use crate::types::ReasoningPresetAction;
    use serde_json::json;

    #[test]
    fn unknown_provider_effort_uses_the_api_format_fallback() {
        let mut chat = json!({});
        assert!(compile_format_fallback(
            ReasoningApiFormat::OpenAiChat,
            &ReasoningPresetAction::Effort {
                value: "xhigh".to_string()
            },
            &mut chat,
            None,
        )
        .unwrap());
        assert_eq!(chat["reasoning_effort"], "xhigh");

        let mut gemini = json!({});
        assert!(compile_format_fallback(
            ReasoningApiFormat::Gemini,
            &ReasoningPresetAction::Effort {
                value: "xhigh".to_string()
            },
            &mut gemini,
            None,
        )
        .unwrap());
        assert_eq!(
            gemini["generationConfig"]["thinkingConfig"]["thinkingLevel"],
            "XHIGH"
        );
    }

    #[test]
    fn provider_and_model_rules_resolve_from_one_registry() {
        assert_eq!(
            resolve_reasoning_rule(
                ReasoningApiFormat::OpenAiChat,
                "openai",
                "https://api.deepseek.com/v1",
                "deepseek-v4-pro",
            ),
            ReasoningRule::DeepSeek { flash: false }
        );
        assert_eq!(
            resolve_reasoning_rule(
                ReasoningApiFormat::Anthropic,
                "zhipuai",
                "https://api.z.ai/api/anthropic",
                "glm-5.2",
            ),
            ReasoningRule::Glm52
        );
        assert_eq!(
            resolve_reasoning_rule(
                ReasoningApiFormat::Anthropic,
                "anthropic",
                "https://api.anthropic.com/v1/messages",
                "claude-opus-4-7",
            ),
            ReasoningRule::Claude(AnthropicThinkingCapability::AdaptiveOnly)
        );
        assert_eq!(
            resolve_reasoning_rule(
                ReasoningApiFormat::Gemini,
                "google",
                "https://generativelanguage.googleapis.com",
                "gemini-2.5-flash",
            ),
            ReasoningRule::Gemini25 { flash: true }
        );
        assert_eq!(
            resolve_reasoning_rule(
                ReasoningApiFormat::OpenAiChat,
                "openai",
                "https://gateway.example/v1",
                "vendor-new-reasoning-model",
            ),
            ReasoningRule::FormatFallback
        );
    }

    #[test]
    fn current_vendor_model_rules_cover_documented_effort_shapes() {
        assert!(is_dashscope_url(
            "https://qwen.cn-beijing.maas.aliyuncs.com/v1/chat/completions"
        ));
        assert_eq!(
            resolve_reasoning_rule(
                ReasoningApiFormat::OpenAiChat,
                "openai",
                "https://api.deepseek.com/v1",
                "deepseek-flash",
            ),
            ReasoningRule::DeepSeek { flash: true }
        );
        assert_eq!(
            normalize_deepseek_reasoning_effort("deepseek-flash", "xhigh"),
            Some("high")
        );
        assert_eq!(
            resolve_reasoning_rule(
                ReasoningApiFormat::OpenAiChat,
                "zhipuai",
                "https://api.z.ai/api/paas/v4",
                "GLM-5.3-Flash",
            ),
            ReasoningRule::Glm53
        );
        assert_eq!(
            resolve_reasoning_rule(
                ReasoningApiFormat::OpenAiChat,
                "openai",
                "https://api.siliconflow.cn/v1",
                "Pro/zai-org/GLM-5.2",
            ),
            ReasoningRule::SiliconFlow { effort: true }
        );
        assert_eq!(
            resolve_reasoning_rule(
                ReasoningApiFormat::OpenAiChat,
                "openai",
                "https://dashscope.aliyuncs.com/compatible-mode/v1",
                "glm-5.3",
            ),
            ReasoningRule::DashScope {
                effort: true,
                forced: true
            }
        );
        assert_eq!(
            resolve_reasoning_rule(
                ReasoningApiFormat::Gemini,
                "google",
                "",
                "gemini-3.1-flash-lite-preview",
            ),
            ReasoningRule::Gemini3 { minimal: true }
        );
        assert_eq!(
            normalize_gemini_reasoning_effort("gemini-3.1-pro-preview", "minimal"),
            Some("LOW")
        );
    }
}
