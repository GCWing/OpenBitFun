use super::unified::{UnifiedResponse, UnifiedTokenUsage, UnifiedToolCall};
use openbitfun_agent_stream::ToolCallCompletion;
use serde::Deserialize;

pub(crate) fn map_anthropic_stop_reason(reason: &str) -> ToolCallCompletion {
    match reason.trim().to_ascii_lowercase().as_str() {
        "tool_use" => ToolCallCompletion::NormalToolUse,
        "max_tokens" => ToolCallCompletion::OutputLimit,
        "refusal" => ToolCallCompletion::Failed,
        "end_turn" | "stop_sequence" | "pause_turn" => ToolCallCompletion::NormalNoToolUse,
        _ => ToolCallCompletion::Unknown,
    }
}

#[derive(Debug, Deserialize)]
pub struct MessageStart {
    pub message: Message,
}

#[derive(Debug, Deserialize)]
pub struct Message {
    pub usage: Option<Usage>,
}

#[derive(Debug, Clone, Deserialize, Default)]
pub struct Usage {
    input_tokens: Option<u32>,
    output_tokens: Option<u32>,
    cache_read_input_tokens: Option<u32>,
    cache_creation_input_tokens: Option<u32>,
}

impl Usage {
    pub fn update(&mut self, other: &Usage) {
        if other.input_tokens.is_some() {
            self.input_tokens = other.input_tokens;
        }
        if other.output_tokens.is_some() {
            self.output_tokens = other.output_tokens;
        }
        if other.cache_read_input_tokens.is_some() {
            self.cache_read_input_tokens = other.cache_read_input_tokens;
        }
        if other.cache_creation_input_tokens.is_some() {
            self.cache_creation_input_tokens = other.cache_creation_input_tokens;
        }
    }

    pub fn is_empty(&self) -> bool {
        self.input_tokens.is_none()
            && self.output_tokens.is_none()
            && self.cache_read_input_tokens.is_none()
            && self.cache_creation_input_tokens.is_none()
    }
}

impl From<Usage> for UnifiedTokenUsage {
    fn from(value: Usage) -> Self {
        let cache_read = value.cache_read_input_tokens;
        let cache_creation = value.cache_creation_input_tokens;

        // prompt_token_count = total context tokens occupied (industry-standard
        // "input tokens" metric). For Anthropic this is the three disjoint
        // components summed; for other providers the API reports this directly.
        let prompt_token_count =
            value.input_tokens.unwrap_or(0) + cache_read.unwrap_or(0) + cache_creation.unwrap_or(0);
        let candidates_token_count = value.output_tokens.unwrap_or(0);

        Self {
            prompt_token_count,
            candidates_token_count,
            total_token_count: prompt_token_count + candidates_token_count,
            reasoning_token_count: None,
            // cached_content_token_count = cache READS only. This is the
            // numerator for `cache hit rate = cached / prompt`. Writes go
            // to cache_creation_token_count below.
            cached_content_token_count: cache_read,
            cache_creation_token_count: cache_creation,
        }
    }
}

#[derive(Debug, Deserialize)]
pub struct MessageDelta {
    pub delta: MessageDeltaDelta,
    pub usage: Option<Usage>,
}

#[derive(Debug, Deserialize)]
pub struct MessageDeltaDelta {
    pub stop_reason: Option<String>,
    pub stop_sequence: Option<String>,
}

impl From<MessageDelta> for UnifiedResponse {
    fn from(value: MessageDelta) -> Self {
        Self {
            text: None,
            reasoning_content: None,
            reasoning_content_kind: None,
            thinking_signature: None,
            tool_call: None,
            usage: value.usage.map(UnifiedTokenUsage::from),
            tool_call_completion: value
                .delta
                .stop_reason
                .as_deref()
                .map(map_anthropic_stop_reason),
            finish_reason: value.delta.stop_reason,
            provider_metadata: None,
            response_model: None,
            model_response_replay: None,
        }
    }
}

#[derive(Debug, Deserialize)]
pub struct ContentBlockStart {
    pub index: Option<usize>,
    pub content_block: ContentBlock,
}

#[derive(Debug, Deserialize)]
#[serde(tag = "type")]
pub enum ContentBlock {
    #[serde(rename = "thinking")]
    Thinking {
        thinking: Option<String>,
        signature: Option<String>,
    },
    #[serde(rename = "text")]
    Text,
    #[serde(rename = "tool_use")]
    ToolUse { id: String, name: String },
    #[serde(other)]
    Unknown,
}

impl From<ContentBlockStart> for UnifiedResponse {
    fn from(value: ContentBlockStart) -> Self {
        let mut result = UnifiedResponse::default();
        match value.content_block {
            ContentBlock::ToolUse { id, name } => {
                let tool_call = UnifiedToolCall {
                    tool_call_index: value.index,
                    id: Some(id),
                    name: Some(name),
                    arguments: None,
                    arguments_is_snapshot: false,
                };
                result.tool_call = Some(tool_call);
            }
            ContentBlock::Thinking {
                thinking,
                signature,
            } => {
                result.reasoning_content = thinking;
                result.thinking_signature = signature;
            }
            _ => {}
        }
        result
    }
}

#[derive(Debug, Deserialize)]
pub struct ContentBlockDelta {
    index: Option<usize>,
    delta: Delta,
}

#[derive(Debug, Deserialize)]
#[serde(tag = "type")]
pub enum Delta {
    #[serde(rename = "thinking_delta")]
    Thinking { thinking: String },
    #[serde(rename = "text_delta")]
    Text { text: String },
    #[serde(rename = "input_json_delta")]
    InputJson { partial_json: String },
    #[serde(rename = "signature_delta")]
    Signature { signature: String },
    #[serde(other)]
    Unknown,
}

impl TryFrom<ContentBlockDelta> for UnifiedResponse {
    type Error = String;
    fn try_from(value: ContentBlockDelta) -> Result<Self, Self::Error> {
        let mut result = UnifiedResponse::default();
        match value.delta {
            Delta::Thinking { thinking } => {
                result.reasoning_content = Some(thinking);
            }
            Delta::Text { text } => {
                result.text = Some(text);
            }
            Delta::InputJson { partial_json } => {
                let tool_call = UnifiedToolCall {
                    tool_call_index: value.index,
                    id: None,
                    name: None,
                    arguments: Some(partial_json),
                    arguments_is_snapshot: false,
                };
                result.tool_call = Some(tool_call);
            }
            Delta::Signature { signature } => {
                result.thinking_signature = Some(signature);
            }
            Delta::Unknown => {
                return Err("Unsupported anthropic delta type".to_string());
            }
        }
        Ok(result)
    }
}

#[derive(Debug, Deserialize)]
pub struct AnthropicSSEError {
    pub error: AnthropicSSEErrorDetails,
}

#[derive(Debug, Deserialize)]
pub struct AnthropicSSEErrorDetails {
    #[serde(rename = "type")]
    pub error_type: String,
    pub message: String,
}

impl From<AnthropicSSEErrorDetails> for String {
    fn from(value: AnthropicSSEErrorDetails) -> Self {
        format!("{}: {}", value.error_type, value.message)
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::stream::types::unified::UnifiedTokenUsage;
    use openbitfun_agent_stream::ToolCallCompletion;

    #[test]
    fn cached_content_token_count_is_reads_only_not_sum() {
        let raw = r#"{
            "input_tokens": 100,
            "output_tokens": 50,
            "cache_read_input_tokens": 30,
            "cache_creation_input_tokens": 20
        }"#;
        let usage: Usage = serde_json::from_str(raw).expect("valid anthropic usage");
        let unified: UnifiedTokenUsage = usage.into();

        // cached_content_token_count must be reads only — NOT read + creation.
        // This guarantees `cached_content / prompt` is a correct hit rate.
        assert_eq!(unified.cached_content_token_count, Some(30));
        assert_eq!(unified.cache_creation_token_count, Some(20));

        // prompt_token_count keeps "total context" semantic (matches industry
        // standard "input tokens" metric across providers).
        assert_eq!(unified.prompt_token_count, 150);
        assert_eq!(unified.candidates_token_count, 50);
        assert_eq!(unified.total_token_count, 200);

        // Hit rate computed by downstream:
        //   30 / 150 == 20% (correct: only reads count as hits)
        // Pre-fix this would have been wrongly 50/150 == 33%.
    }

    #[test]
    fn maps_anthropic_end_turn_as_normal_no_tool_use() {
        assert_eq!(
            map_anthropic_stop_reason("tool_use"),
            ToolCallCompletion::NormalToolUse
        );
        assert_eq!(
            map_anthropic_stop_reason("max_tokens"),
            ToolCallCompletion::OutputLimit
        );
        assert_eq!(
            map_anthropic_stop_reason("end_turn"),
            ToolCallCompletion::NormalNoToolUse
        );
        assert_eq!(
            map_anthropic_stop_reason("unknown_stop"),
            ToolCallCompletion::Unknown
        );
    }

    #[test]
    fn absent_cache_fields_stay_none() {
        let raw = r#"{ "input_tokens": 100, "output_tokens": 50 }"#;
        let usage: Usage = serde_json::from_str(raw).expect("valid anthropic usage");
        let unified: UnifiedTokenUsage = usage.into();
        assert_eq!(unified.cached_content_token_count, None);
        assert_eq!(unified.cache_creation_token_count, None);
    }

    #[test]
    fn zero_cache_fields_are_some_zero_not_none() {
        // Cache support reported but zero this call must be distinguishable
        // from "provider did not report cache fields at all".
        let raw = r#"{
            "input_tokens": 100,
            "output_tokens": 50,
            "cache_read_input_tokens": 0,
            "cache_creation_input_tokens": 0
        }"#;
        let usage: Usage = serde_json::from_str(raw).expect("valid anthropic usage");
        let unified: UnifiedTokenUsage = usage.into();
        assert_eq!(unified.cached_content_token_count, Some(0));
        assert_eq!(unified.cache_creation_token_count, Some(0));
    }

    #[test]
    fn only_read_present_no_creation() {
        let raw = r#"{
            "input_tokens": 100,
            "output_tokens": 50,
            "cache_read_input_tokens": 30
        }"#;
        let usage: Usage = serde_json::from_str(raw).expect("valid anthropic usage");
        let unified: UnifiedTokenUsage = usage.into();
        assert_eq!(unified.cached_content_token_count, Some(30));
        assert_eq!(unified.cache_creation_token_count, None);
        // prompt_token_count = input + read (no creation contribution)
        assert_eq!(unified.prompt_token_count, 130);
    }
}
