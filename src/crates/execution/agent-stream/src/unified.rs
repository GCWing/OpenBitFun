use crate::tool_call_accumulator::ToolCallCompletion;
use openbitfun_core_types::{ModelResponseReplayItem, ReasoningContentKind};
use serde::{Deserialize, Serialize};
use serde_json::Value;
use std::borrow::Cow;
use std::fmt;

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct UnifiedToolCall {
    #[serde(skip_serializing_if = "Option::is_none")]
    pub tool_call_index: Option<usize>,
    pub id: Option<String>,
    pub name: Option<String>,
    pub arguments: Option<String>,
    #[serde(default)]
    pub arguments_is_snapshot: bool,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
pub struct ModelResponseReplayCapture {
    pub protocol: String,
    pub items: Vec<ModelResponseReplayItem>,
}

/// Unified AI response format
#[derive(Clone, Serialize, Deserialize, Default)]
pub struct UnifiedResponse {
    /// Model identifier explicitly reported by the provider for this attempt.
    /// Missing observations must not be filled from the request configuration.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub response_model: Option<String>,
    pub text: Option<String>,
    pub reasoning_content: Option<String>,
    /// Distinguishes provider reasoning text from a user-displayable reasoning summary.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub reasoning_content_kind: Option<ReasoningContentKind>,
    /// Signature for Anthropic extended thinking (returned in multi-turn conversations)
    #[serde(skip_serializing_if = "Option::is_none")]
    pub thinking_signature: Option<String>,
    pub tool_call: Option<UnifiedToolCall>,
    pub usage: Option<UnifiedTokenUsage>,
    /// Provider adapter's normalized terminal completion fact. This is only
    /// populated on terminal events and remains separate from the raw finish
    /// reason retained for diagnostics and replay.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub tool_call_completion: Option<ToolCallCompletion>,
    pub finish_reason: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub provider_metadata: Option<Value>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub model_response_replay: Option<ModelResponseReplayCapture>,
}

impl fmt::Debug for UnifiedResponse {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        let reasoning_summary = self.reasoning_content.as_ref().map(|s| {
            if s.len() > 100 {
                let end = s
                    .char_indices()
                    .take_while(|(i, _)| *i < 100)
                    .last()
                    .map(|(i, c)| i + c.len_utf8())
                    .unwrap_or(0);
                // Guard against multi-byte chars pushing end past the string length
                let end = end.min(s.len());
                Cow::Owned(format!("{}... ({} bytes)", &s[..end], s.len()))
            } else {
                Cow::Borrowed(s.as_str())
            }
        });
        f.debug_struct("UnifiedResponse")
            .field("response_model", &self.response_model)
            .field("text", &self.text)
            .field("reasoning_content", &reasoning_summary)
            .field("reasoning_content_kind", &self.reasoning_content_kind)
            .field("thinking_signature", &"<omitted>")
            .field("tool_call", &self.tool_call)
            .field("usage", &self.usage)
            .field("tool_call_completion", &self.tool_call_completion)
            .field("finish_reason", &self.finish_reason)
            .field("provider_metadata", &"<omitted>")
            .field(
                "model_response_replay",
                &self.model_response_replay.as_ref().map(|replay| {
                    format!("protocol={}, items={}", replay.protocol, replay.items.len())
                }),
            )
            .finish()
    }
}

/// Unified token usage statistics
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct UnifiedTokenUsage {
    pub prompt_token_count: u32,
    pub candidates_token_count: u32,
    pub total_token_count: u32,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub reasoning_token_count: Option<u32>,
    /// Cache READ tokens (i.e., served from cache this call). Universal across
    /// providers: OpenAI `cached_tokens`, DeepSeek `prompt_cache_hit_tokens`,
    /// Anthropic `cache_read_input_tokens`, Gemini `cachedContentTokenCount`.
    /// Hit rate consumers must use this as numerator and `prompt_token_count`
    /// as denominator.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub cached_content_token_count: Option<u32>,
    /// Cache WRITE tokens (only Anthropic reports this per-token; others either
    /// have no creation concept or bill creation by storage time). Disjoint from
    /// `cached_content_token_count`. Do NOT include in hit-rate numerator.
    #[serde(skip_serializing_if = "Option::is_none", default)]
    pub cache_creation_token_count: Option<u32>,
}
