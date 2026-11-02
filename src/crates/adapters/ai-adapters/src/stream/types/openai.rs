use super::unified::{UnifiedResponse, UnifiedTokenUsage, UnifiedToolCall};
use openbitfun_agent_stream::ToolCallCompletion;
use serde::Deserialize;

pub(crate) fn map_openai_finish_reason(reason: &str) -> ToolCallCompletion {
    match reason.trim().to_ascii_lowercase().as_str() {
        "tool_calls" | "function_call" => ToolCallCompletion::NormalToolUse,
        "length" => ToolCallCompletion::OutputLimit,
        "content_filter" => ToolCallCompletion::ContentFiltered,
        "stop" => ToolCallCompletion::NormalNoToolUse,
        _ => ToolCallCompletion::Unknown,
    }
}

#[derive(Debug, Deserialize)]
struct PromptTokensDetails {
    cached_tokens: Option<u32>,
}

#[derive(Debug, Deserialize)]
struct OpenAIUsage {
    #[serde(default)]
    prompt_tokens: u32,
    #[serde(default)]
    completion_tokens: u32,
    #[serde(default)]
    total_tokens: u32,
    prompt_tokens_details: Option<PromptTokensDetails>,
    /// DeepSeek extension. Subset of `prompt_tokens`. Absent on non-DeepSeek
    /// providers. Prefer this over `prompt_tokens_details.cached_tokens` when
    /// both are present — DeepSeek-native is the authoritative source.
    #[serde(default)]
    prompt_cache_hit_tokens: Option<u32>,
    /// DeepSeek extension. Equals `prompt_tokens - prompt_cache_hit_tokens`.
    /// Deserialized so a future strict serde lint doesn't reject the payload;
    /// not propagated (the miss count is derivable from the other two).
    #[serde(default)]
    #[allow(dead_code)]
    prompt_cache_miss_tokens: Option<u32>,
}

impl From<OpenAIUsage> for UnifiedTokenUsage {
    fn from(usage: OpenAIUsage) -> Self {
        let standard_cached = usage
            .prompt_tokens_details
            .and_then(|details| details.cached_tokens);
        // DeepSeek extension wins when both present.
        let cache_read = usage.prompt_cache_hit_tokens.or(standard_cached);

        Self {
            prompt_token_count: usage.prompt_tokens,
            candidates_token_count: usage.completion_tokens,
            total_token_count: usage.total_tokens,
            reasoning_token_count: None,
            cached_content_token_count: cache_read,
            cache_creation_token_count: None,
        }
    }
}

#[derive(Debug, Deserialize)]
struct Choice {
    #[allow(dead_code)]
    index: usize,
    /// MiniMax's last SSE frame switches to non-streaming `chat.completion`
    /// shape and puts the content under `message` instead of `delta`. We don't
    /// need that frame's content (earlier chunks already streamed it), but the
    /// frame also carries the only authoritative `usage` block. Default the
    /// field so such frames deserialize cleanly and the top-level usage flows
    /// through.
    #[serde(default)]
    delta: Delta,
    finish_reason: Option<String>,
}

/// MiniMax `reasoning_details` array element.
/// Only elements with `type == "reasoning.text"` carry thinking text.
#[derive(Debug, Deserialize)]
struct ReasoningDetail {
    #[serde(rename = "type")]
    detail_type: Option<String>,
    text: Option<String>,
}

#[derive(Debug, Default, Deserialize)]
struct Delta {
    #[allow(dead_code)]
    role: Option<String>,
    /// Standard OpenAI-compatible reasoning field (DeepSeek, Qwen, etc.)
    reasoning_content: Option<String>,
    /// Some OpenAI-compatible providers stream thinking under `reasoning`.
    reasoning: Option<String>,
    /// MiniMax-specific reasoning field; used as fallback when `reasoning_content` is absent.
    reasoning_details: Option<Vec<ReasoningDetail>>,
    content: Option<String>,
    tool_calls: Option<Vec<OpenAIToolCall>>,
}

#[derive(Debug, Deserialize, Clone)]
struct OpenAIToolCall {
    #[allow(dead_code)]
    index: usize,
    #[allow(dead_code)]
    id: Option<String>,
    #[allow(dead_code)]
    #[serde(rename = "type")]
    tool_type: Option<String>,
    #[serde(default)]
    arguments_is_snapshot: bool,
    function: Option<FunctionCall>,
}

impl From<OpenAIToolCall> for UnifiedToolCall {
    fn from(tool_call: OpenAIToolCall) -> Self {
        Self {
            tool_call_index: Some(tool_call.index),
            id: tool_call.id,
            name: tool_call.function.as_ref().and_then(|f| f.name.clone()),
            arguments: tool_call
                .function
                .as_ref()
                .and_then(|f| f.arguments.clone()),
            arguments_is_snapshot: tool_call.arguments_is_snapshot,
        }
    }
}

#[derive(Debug, Deserialize, Clone)]
struct FunctionCall {
    name: Option<String>,
    arguments: Option<String>,
}

#[derive(Debug, Deserialize)]
pub struct OpenAISSEData {
    #[allow(dead_code)]
    id: String,
    #[serde(default)]
    #[allow(dead_code)]
    created: Option<u64>,
    model: String,
    choices: Vec<Choice>,
    usage: Option<OpenAIUsage>,
}

impl OpenAISSEData {
    pub fn is_choices_empty(&self) -> bool {
        self.choices.is_empty()
    }

    pub fn first_choice_tool_call_count(&self) -> usize {
        self.choices
            .first()
            .and_then(|choice| choice.delta.tool_calls.as_ref())
            .map(|tool_calls| tool_calls.len())
            .unwrap_or(0)
    }

    pub fn into_unified_responses(self) -> Vec<UnifiedResponse> {
        let response_model = (!self.model.trim().is_empty()).then(|| self.model.clone());
        let mut responses = self.into_unified_response_parts();
        if let Some(first) = responses.first_mut() {
            first.response_model = response_model;
        } else if response_model.is_some() {
            responses.push(UnifiedResponse {
                response_model,
                ..Default::default()
            });
        }
        responses
    }

    fn into_unified_response_parts(self) -> Vec<UnifiedResponse> {
        let mut usage = self.usage.map(|usage| usage.into());

        let Some(first_choice) = self.choices.into_iter().next() else {
            // OpenAI can emit `choices: []` for the final usage chunk.
            return usage
                .map(|usage_data| {
                    vec![UnifiedResponse {
                        usage: Some(usage_data),
                        ..Default::default()
                    }]
                })
                .unwrap_or_default();
        };

        let Choice {
            delta,
            finish_reason,
            ..
        } = first_choice;
        let Delta {
            reasoning_content,
            reasoning,
            reasoning_details,
            content,
            tool_calls,
            ..
        } = delta;

        // Treat empty strings the same as absent fields for assistant text (MiniMax sends
        // `content: ""` in reasoning-only chunks). Keep empty reasoning content so downstream
        // can replay structurally present thinking blocks when a provider requires it.
        let content = content.filter(|s| !s.is_empty());
        let reasoning_content = reasoning_content.or(reasoning);

        // MiniMax uses `reasoning_details` instead of `reasoning_content`.
        // Collect all "reasoning.text" entries and join them as a fallback.
        let reasoning_content = reasoning_content.or_else(|| {
            reasoning_details.and_then(|details| {
                let text: String = details
                    .into_iter()
                    .filter(|d| d.detail_type.as_deref() == Some("reasoning.text"))
                    .filter_map(|d| d.text)
                    .collect();
                if text.is_empty() {
                    None
                } else {
                    Some(text)
                }
            })
        });

        let mut responses = Vec::new();

        if content.is_some() || reasoning_content.is_some() {
            responses.push(UnifiedResponse {
                text: content,
                reasoning_content,
                reasoning_content_kind: None,
                thinking_signature: None,
                tool_call: None,
                usage: usage.take(),
                tool_call_completion: None,
                finish_reason: None,
                provider_metadata: None,
                response_model: None,
                model_response_replay: None,
            });
        }

        if let Some(tool_calls) = tool_calls {
            for tool_call in tool_calls {
                let is_first_event = responses.is_empty();
                responses.push(UnifiedResponse {
                    text: None,
                    reasoning_content: None,
                    reasoning_content_kind: None,
                    thinking_signature: None,
                    tool_call: Some(UnifiedToolCall::from(tool_call)),
                    usage: if is_first_event { usage.take() } else { None },
                    tool_call_completion: None,
                    finish_reason: None,
                    provider_metadata: None,
                    response_model: None,
                    model_response_replay: None,
                });
            }
        }

        if let Some(finish_reason) = finish_reason {
            if let Some(last_response) = responses.last_mut() {
                last_response.tool_call_completion = Some(map_openai_finish_reason(&finish_reason));
                last_response.finish_reason = Some(finish_reason);
                return responses;
            }

            responses.push(UnifiedResponse {
                text: None,
                reasoning_content: None,
                reasoning_content_kind: None,
                thinking_signature: None,
                tool_call: None,
                usage,
                tool_call_completion: Some(map_openai_finish_reason(&finish_reason)),
                finish_reason: Some(finish_reason),
                provider_metadata: None,
                response_model: None,
                model_response_replay: None,
            });
            return responses;
        }

        if responses.is_empty() {
            responses.push(UnifiedResponse {
                text: None,
                reasoning_content: None,
                reasoning_content_kind: None,
                thinking_signature: None,
                tool_call: None,
                usage,
                tool_call_completion: None,
                finish_reason,
                provider_metadata: None,
                response_model: None,
                model_response_replay: None,
            });
        }

        responses
    }
}

impl From<OpenAISSEData> for UnifiedResponse {
    fn from(data: OpenAISSEData) -> Self {
        data.into_unified_responses()
            .into_iter()
            .next()
            .unwrap_or_default()
    }
}

#[cfg(test)]
mod tests {
    use super::{map_openai_finish_reason, OpenAISSEData};
    use openbitfun_agent_stream::ToolCallCompletion;

    #[test]
    fn maps_documented_openai_chat_finish_reasons_conservatively() {
        assert_eq!(
            map_openai_finish_reason("tool_calls"),
            ToolCallCompletion::NormalToolUse
        );
        assert_eq!(
            map_openai_finish_reason("length"),
            ToolCallCompletion::OutputLimit
        );
        assert_eq!(
            map_openai_finish_reason("content_filter"),
            ToolCallCompletion::ContentFiltered
        );
        assert_eq!(
            map_openai_finish_reason("custom_terminal_state"),
            ToolCallCompletion::Unknown
        );
    }

    #[test]
    fn splits_multiple_tool_calls_in_first_choice() {
        let raw = r#"{
            "id": "chatcmpl_test",
            "created": 123,
            "model": "gpt-test",
            "choices": [{
                "index": 0,
                "delta": {
                    "tool_calls": [
                        {
                            "index": 0,
                            "id": "call_1",
                            "type": "function",
                            "function": {
                                "name": "tool_a",
                                "arguments": "{\"a\":1}"
                            }
                        },
                        {
                            "index": 1,
                            "id": "call_2",
                            "type": "function",
                            "function": {
                                "name": "tool_b",
                                "arguments": "{\"b\":2}"
                            }
                        }
                    ]
                },
                "finish_reason": "tool_calls"
            }],
            "usage": {
                "prompt_tokens": 10,
                "completion_tokens": 5,
                "total_tokens": 15,
                "prompt_tokens_details": {
                    "cached_tokens": 3
                }
            }
        }"#;

        let sse_data: OpenAISSEData = serde_json::from_str(raw).expect("valid openai sse data");
        let responses = sse_data.into_unified_responses();

        assert_eq!(responses.len(), 2);
        assert_eq!(
            responses[0]
                .tool_call
                .as_ref()
                .and_then(|tool| tool.tool_call_index),
            Some(0)
        );
        assert_eq!(
            responses[1]
                .tool_call
                .as_ref()
                .and_then(|tool| tool.tool_call_index),
            Some(1)
        );
        assert_eq!(
            responses[0]
                .tool_call
                .as_ref()
                .and_then(|tool| tool.id.as_deref()),
            Some("call_1")
        );
        assert_eq!(
            responses[1]
                .tool_call
                .as_ref()
                .and_then(|tool| tool.id.as_deref()),
            Some("call_2")
        );
        assert!(responses[0].finish_reason.is_none());
        assert_eq!(responses[1].finish_reason.as_deref(), Some("tool_calls"));
        assert!(responses[0].usage.is_some());
        assert!(responses[1].usage.is_none());
    }

    #[test]
    fn preserves_empty_reasoning_content_chunk() {
        let raw = r#"{
            "id": "chatcmpl_test",
            "created": 123,
            "model": "deepseek-test",
            "choices": [{
                "index": 0,
                "delta": {
                    "reasoning_content": ""
                },
                "finish_reason": "stop"
            }]
        }"#;

        let sse_data: OpenAISSEData = serde_json::from_str(raw).expect("valid openai sse data");
        let responses = sse_data.into_unified_responses();

        assert_eq!(responses.len(), 1);
        assert_eq!(responses[0].reasoning_content.as_deref(), Some(""));
        assert_eq!(responses[0].finish_reason.as_deref(), Some("stop"));
    }

    #[test]
    fn parses_reasoning_alias_chunk() {
        let raw = r#"{
            "id": "chatcmpl_test",
            "created": 123,
            "model": "compatible-test",
            "choices": [{
                "index": 0,
                "delta": {
                    "reasoning": "I should check the provider-specific field."
                },
                "finish_reason": null
            }]
        }"#;

        let sse_data: OpenAISSEData = serde_json::from_str(raw).expect("valid openai sse data");
        let responses = sse_data.into_unified_responses();

        assert_eq!(responses.len(), 1);
        assert_eq!(
            responses[0].reasoning_content.as_deref(),
            Some("I should check the provider-specific field.")
        );
    }

    #[test]
    fn handles_missing_created_in_openai_compatible_chunk() {
        let raw = r#"{
            "id": "chatcmpl_test",
            "object": "chat.completion.chunk",
            "model": "compatible-model",
            "choices": [{
                "index": 0,
                "delta": {
                    "content": "hello"
                },
                "finish_reason": null
            }],
            "usage": {
                "prompt_tokens": 2,
                "completion_tokens": 1,
                "total_tokens": 3
            }
        }"#;

        let sse_data: OpenAISSEData =
            serde_json::from_str(raw).expect("compatible openai sse data");
        let responses = sse_data.into_unified_responses();

        assert_eq!(responses.len(), 1);
        assert_eq!(responses[0].text.as_deref(), Some("hello"));
        assert_eq!(
            responses[0]
                .usage
                .as_ref()
                .map(|usage| usage.total_token_count),
            Some(3)
        );
    }

    #[test]
    fn handles_empty_choices_with_usage_chunk() {
        let raw = r#"{
            "id": "chatcmpl_test",
            "created": 123,
            "model": "gpt-test",
            "choices": [],
            "usage": {
                "prompt_tokens": 7,
                "completion_tokens": 3,
                "total_tokens": 10
            }
        }"#;

        let sse_data: OpenAISSEData = serde_json::from_str(raw).expect("valid openai sse data");
        let responses = sse_data.into_unified_responses();

        assert_eq!(responses.len(), 1);
        assert!(responses[0].usage.is_some());
        assert!(responses[0].text.is_none());
        assert!(responses[0].tool_call.is_none());
    }

    #[test]
    fn parses_minimax_final_chunk_with_message_field_instead_of_delta() {
        // MiniMax's last SSE frame uses non-streaming `chat.completion` shape:
        // choice has `message` instead of `delta`, and the real usage lives at
        // the top level. Pre-fix this chunk failed to deserialize (`delta` was
        // a required field), so the real prompt/completion tokens were silently
        // dropped. After the fix, the chunk parses cleanly and usage flows
        // through.
        let raw = r#"{
            "id": "065b58b7a16cf30f1e20c8f1942efeae",
            "created": 1779180983,
            "model": "MiniMax-M2.7-highspeed",
            "object": "chat.completion",
            "choices": [{
                "finish_reason": "stop",
                "index": 0,
                "message": {
                    "content": "hi",
                    "role": "assistant",
                    "name": "MiniMax AI",
                    "reasoning_content": "The user wants hi."
                }
            }],
            "usage": {
                "total_tokens": 92,
                "prompt_tokens": 45,
                "completion_tokens": 47,
                "completion_tokens_details": {"reasoning_tokens": 45}
            }
        }"#;

        let sse_data: OpenAISSEData = serde_json::from_str(raw)
            .expect("MiniMax final chunk must deserialize even without delta");
        let responses = sse_data.into_unified_responses();

        // Critical: the usage from this chunk must propagate.
        let usage = responses
            .iter()
            .find_map(|r| r.usage.as_ref())
            .expect("usage from MiniMax final chunk must be preserved");
        assert_eq!(usage.prompt_token_count, 45);
        assert_eq!(usage.candidates_token_count, 47);
        assert_eq!(usage.total_token_count, 92);

        // finish_reason should also be preserved (lives at choice top level).
        assert!(
            responses
                .iter()
                .any(|r| r.finish_reason.as_deref() == Some("stop")),
            "finish_reason from MiniMax final chunk must be preserved"
        );
    }

    #[test]
    fn handles_empty_choices_without_usage_chunk() {
        let raw = r#"{
            "id": "chatcmpl_test",
            "created": 123,
            "model": "gpt-test",
            "choices": [],
            "usage": null
        }"#;

        let sse_data: OpenAISSEData = serde_json::from_str(raw).expect("valid openai sse data");
        let responses = sse_data.into_unified_responses();

        assert_eq!(responses.len(), 1);
        assert_eq!(responses[0].response_model.as_deref(), Some("gpt-test"));
        assert!(responses[0].text.is_none());
        assert!(responses[0].usage.is_none());
        assert!(responses[0].tool_call.is_none());
    }

    #[test]
    fn preserves_text_when_tool_calls_exist_in_same_chunk() {
        let raw = r#"{
            "id": "chatcmpl_test",
            "created": 123,
            "model": "gpt-test",
            "choices": [{
                "index": 0,
                "delta": {
                    "content": "hello",
                    "tool_calls": [
                        {
                            "index": 0,
                            "id": "call_1",
                            "type": "function",
                            "function": {
                                "name": "tool_a",
                                "arguments": "{\"a\":1}"
                            }
                        }
                    ]
                },
                "finish_reason": "tool_calls"
            }],
            "usage": {
                "prompt_tokens": 10,
                "completion_tokens": 5,
                "total_tokens": 15
            }
        }"#;

        let sse_data: OpenAISSEData = serde_json::from_str(raw).expect("valid openai sse data");
        let responses = sse_data.into_unified_responses();

        assert_eq!(responses.len(), 2);
        assert_eq!(responses[0].text.as_deref(), Some("hello"));
        assert!(responses[0].tool_call.is_none());
        assert!(responses[0].usage.is_some());
        assert!(responses[0].finish_reason.is_none());

        assert!(responses[1].text.is_none());
        assert_eq!(
            responses[1]
                .tool_call
                .as_ref()
                .and_then(|tool| tool.id.as_deref()),
            Some("call_1")
        );
        assert!(responses[1].usage.is_none());
        assert_eq!(responses[1].finish_reason.as_deref(), Some("tool_calls"));
    }

    #[test]
    fn stop_reason_tool_chunk_keeps_default_non_snapshot_behavior() {
        let data: OpenAISSEData = serde_json::from_str(
            r#"{
                "id": "chatcmpl_test",
                "created": 123,
                "model": "gpt-test",
                "choices": [{
                    "index": 0,
                    "delta": {
                        "tool_calls": [{
                            "index": 0,
                            "type": "function",
                            "function": {
                                "arguments": "{\"city\":\"Beijing\"}"
                            }
                        }]
                    },
                    "stop_reason": "stop"
                }]
            }"#,
        )
        .expect("valid stop_reason chunk");
        let responses = data.into_unified_responses();
        assert_eq!(
            responses[0]
                .tool_call
                .as_ref()
                .and_then(|tool| tool.arguments.as_deref()),
            Some("{\"city\":\"Beijing\"}")
        );
        assert!(
            !responses[0]
                .tool_call
                .as_ref()
                .expect("tool call")
                .arguments_is_snapshot
        );
        assert!(responses[0].finish_reason.is_none());
    }

    #[test]
    fn leaves_normal_tool_delta_chunks_as_non_snapshot() {
        let chunk: OpenAISSEData = serde_json::from_str(
            r#"{
                "id": "chatcmpl_test",
                "created": 123,
                "model": "gpt-test",
                "choices": [{
                    "index": 0,
                    "delta": {
                        "tool_calls": [{
                            "index": 0,
                            "type": "function",
                            "function": {
                                "arguments": "jing"
                            }
                        }]
                    },
                    "finish_reason": "tool_calls"
                }]
            }"#,
        )
        .expect("valid chunk");
        let responses = chunk.into_unified_responses();
        assert_eq!(responses.len(), 1);
        assert!(
            !responses[0]
                .tool_call
                .as_ref()
                .expect("tool call")
                .arguments_is_snapshot
        );
    }

    #[test]
    fn accepts_numeric_stop_reason_payload() {
        let data: OpenAISSEData = serde_json::from_str(
            r#"{
                "id": "chatcmpl_test",
                "created": 123,
                "model": "gpt-test",
                "choices": [{
                    "index": 0,
                    "delta": {
                        "tool_calls": [{
                            "index": 0,
                            "type": "function",
                            "function": {
                                "arguments": "{\"a\":1}"
                            }
                        }]
                    },
                    "stop_reason": 154829
                }]
            }"#,
        )
        .expect("valid numeric stop_reason payload");
        let responses = data.into_unified_responses();

        assert_eq!(responses.len(), 1);
        assert!(responses[0].tool_call.is_some());
    }

    #[test]
    fn accepts_string_stop_reason_payload() {
        let data: OpenAISSEData = serde_json::from_str(
            r#"{
                "id": "chatcmpl_test",
                "created": 123,
                "model": "gpt-test",
                "choices": [{
                    "index": 0,
                    "delta": {
                        "tool_calls": [{
                            "index": 0,
                            "type": "function",
                            "function": {
                                "arguments": "{\"a\":1}"
                            }
                        }]
                    },
                    "stop_reason": "154829"
                }]
            }"#,
        )
        .expect("valid string stop_reason payload");
        let responses = data.into_unified_responses();

        assert_eq!(responses.len(), 1);
        assert!(responses[0].tool_call.is_some());
    }

    #[test]
    fn standard_openai_cached_tokens_maps_through() {
        let raw = r#"{
            "id": "chatcmpl_test",
            "created": 1,
            "model": "gpt-test",
            "choices": [],
            "usage": {
                "prompt_tokens": 100,
                "completion_tokens": 20,
                "total_tokens": 120,
                "prompt_tokens_details": { "cached_tokens": 40 }
            }
        }"#;
        let data: OpenAISSEData = serde_json::from_str(raw).expect("valid openai sse data");
        let usage = data.into_unified_responses()[0]
            .usage
            .as_ref()
            .expect("usage")
            .clone();
        assert_eq!(usage.cached_content_token_count, Some(40));
        assert_eq!(usage.cache_creation_token_count, None);
    }

    #[test]
    fn deepseek_prompt_cache_hit_tokens_is_captured() {
        // Pre-fix this field was silently dropped (strict serde, unknown key).
        let raw = r#"{
            "id": "chatcmpl_test",
            "created": 1,
            "model": "deepseek-chat",
            "choices": [],
            "usage": {
                "prompt_tokens": 100,
                "completion_tokens": 20,
                "total_tokens": 120,
                "prompt_cache_hit_tokens": 64,
                "prompt_cache_miss_tokens": 36
            }
        }"#;
        let data: OpenAISSEData = serde_json::from_str(raw).expect("valid deepseek sse data");
        let usage = data.into_unified_responses()[0]
            .usage
            .as_ref()
            .expect("usage")
            .clone();
        assert_eq!(usage.cached_content_token_count, Some(64));
    }

    #[test]
    fn deepseek_extension_preferred_over_standard_cached_tokens_if_both() {
        // Defensive: if a proxy forwards both, prefer the DeepSeek-native field.
        let raw = r#"{
            "id": "chatcmpl_test",
            "created": 1,
            "model": "deepseek-chat",
            "choices": [],
            "usage": {
                "prompt_tokens": 100,
                "completion_tokens": 20,
                "total_tokens": 120,
                "prompt_cache_hit_tokens": 64,
                "prompt_tokens_details": { "cached_tokens": 0 }
            }
        }"#;
        let data: OpenAISSEData = serde_json::from_str(raw).expect("valid proxy payload");
        let usage = data.into_unified_responses()[0]
            .usage
            .as_ref()
            .expect("usage")
            .clone();
        assert_eq!(usage.cached_content_token_count, Some(64));
    }

    #[test]
    fn openai_no_cache_fields_stays_none() {
        let raw = r#"{
            "id": "chatcmpl_test",
            "created": 1,
            "model": "gpt-test",
            "choices": [],
            "usage": {
                "prompt_tokens": 100,
                "completion_tokens": 20,
                "total_tokens": 120
            }
        }"#;
        let data: OpenAISSEData = serde_json::from_str(raw).expect("valid openai sse data");
        let usage = data.into_unified_responses()[0]
            .usage
            .as_ref()
            .expect("usage")
            .clone();
        assert_eq!(usage.cached_content_token_count, None);
        assert_eq!(usage.cache_creation_token_count, None);
    }
}
