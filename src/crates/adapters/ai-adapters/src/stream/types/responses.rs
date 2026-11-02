use super::unified::{UnifiedResponse, UnifiedTokenUsage, UnifiedToolCall};
use openbitfun_agent_stream::ModelResponseReplayCapture;
use openbitfun_core_types::{ModelReasoningSummaryPart, ModelResponseReplayItem};
use serde::Deserialize;
use serde_json::Value;

pub const OPENAI_RESPONSES_REPLAY_PROTOCOL: &str = "openai_responses";

#[derive(Debug, Deserialize)]
pub struct ResponsesStreamEvent {
    #[serde(rename = "type")]
    pub kind: String,
    /// Output item index in the `response.output` array.
    #[serde(default)]
    pub output_index: Option<usize>,
    /// Content part index within an output item (for content-part events).
    #[allow(dead_code)]
    #[serde(default)]
    pub content_index: Option<usize>,
    /// Summary part index within a reasoning output item.
    #[serde(default)]
    pub summary_index: Option<usize>,
    #[serde(default)]
    pub response: Option<Value>,
    #[serde(default)]
    pub item: Option<Value>,
    #[serde(default)]
    pub delta: Option<String>,
}

#[derive(Debug, Deserialize)]
pub struct ResponsesCompleted {
    #[allow(dead_code)]
    pub id: String,
    #[serde(default)]
    pub usage: Option<ResponsesUsage>,
}

#[derive(Debug, Deserialize)]
pub struct ResponsesDone {
    #[serde(default)]
    pub id: Option<String>,
    #[serde(default)]
    pub usage: Option<ResponsesUsage>,
}

#[derive(Debug, Deserialize)]
pub struct ResponsesUsage {
    pub input_tokens: u32,
    #[serde(default)]
    pub input_tokens_details: Option<ResponsesInputTokensDetails>,
    pub output_tokens: u32,
    pub total_tokens: u32,
}

#[derive(Debug, Deserialize)]
pub struct ResponsesInputTokensDetails {
    pub cached_tokens: u32,
    #[serde(default)]
    pub cache_write_tokens: Option<u32>,
}

impl From<ResponsesUsage> for UnifiedTokenUsage {
    fn from(usage: ResponsesUsage) -> Self {
        let (cached_content_token_count, cache_creation_token_count) = usage
            .input_tokens_details
            .map(|details| (Some(details.cached_tokens), details.cache_write_tokens))
            .unwrap_or((None, None));
        Self {
            prompt_token_count: usage.input_tokens,
            candidates_token_count: usage.output_tokens,
            total_token_count: usage.total_tokens,
            reasoning_token_count: None,
            cached_content_token_count,
            cache_creation_token_count,
        }
    }
}

pub fn parse_responses_output_item(
    item_value: Value,
    tool_call_index: Option<usize>,
) -> Option<UnifiedResponse> {
    let item_type = item_value.get("type")?.as_str()?;

    match item_type {
        "function_call" => Some(UnifiedResponse {
            text: None,
            reasoning_content: None,
            reasoning_content_kind: None,
            thinking_signature: None,
            tool_call: Some(UnifiedToolCall {
                tool_call_index,
                id: item_value
                    .get("call_id")
                    .and_then(Value::as_str)
                    .map(ToString::to_string),
                name: item_value
                    .get("name")
                    .and_then(Value::as_str)
                    .map(ToString::to_string),
                arguments: item_value
                    .get("arguments")
                    .and_then(Value::as_str)
                    .map(ToString::to_string),
                arguments_is_snapshot: false,
            }),
            usage: None,
            tool_call_completion: None,
            finish_reason: None,
            provider_metadata: None,
            response_model: None,
            model_response_replay: None,
        }),
        "message" => {
            let text = item_value
                .get("content")
                .and_then(Value::as_array)
                .map(|content| {
                    content
                        .iter()
                        .filter(|item| {
                            item.get("type").and_then(Value::as_str) == Some("output_text")
                        })
                        .filter_map(|item| item.get("text").and_then(Value::as_str))
                        .collect::<String>()
                })
                .filter(|text| !text.is_empty());

            text.map(|text| UnifiedResponse {
                text: Some(text),
                reasoning_content: None,
                reasoning_content_kind: None,
                thinking_signature: None,
                tool_call: None,
                usage: None,
                tool_call_completion: None,
                finish_reason: None,
                provider_metadata: None,
                response_model: None,
                model_response_replay: None,
            })
        }
        _ => None,
    }
}

pub fn parse_responses_replay_capture(output: &[Value]) -> Option<ModelResponseReplayCapture> {
    if output.is_empty() {
        return None;
    }

    let mut contains_opaque_reasoning = false;
    let mut items = Vec::with_capacity(output.len());
    for item in output {
        let replay_item = parse_responses_replay_item(item)?;
        contains_opaque_reasoning |=
            matches!(replay_item, ModelResponseReplayItem::OpaqueReasoning { .. });
        items.push(replay_item);
    }

    contains_opaque_reasoning.then(|| ModelResponseReplayCapture {
        protocol: OPENAI_RESPONSES_REPLAY_PROTOCOL.to_string(),
        items,
    })
}

fn parse_responses_replay_item(item: &Value) -> Option<ModelResponseReplayItem> {
    match item.get("type")?.as_str()? {
        "reasoning" => {
            let opaque_state = item
                .get("encrypted_content")
                .and_then(Value::as_str)
                .filter(|value| !value.is_empty())?
                .to_string();
            let item_id = item
                .get("id")
                .and_then(Value::as_str)
                .filter(|value| !value.is_empty())
                .map(ToString::to_string);
            let summary = match item.get("summary").filter(|summary| !summary.is_null()) {
                Some(summary) => parse_reasoning_summary(summary)?,
                None => Vec::new(),
            };
            Some(ModelResponseReplayItem::OpaqueReasoning {
                item_id,
                summary,
                opaque_state,
            })
        }
        "message"
            if item
                .get("role")
                .and_then(Value::as_str)
                .is_none_or(|role| role == "assistant") =>
        {
            Some(ModelResponseReplayItem::AssistantMessage)
        }
        "function_call" => item
            .get("call_id")
            .and_then(Value::as_str)
            .filter(|call_id| !call_id.is_empty())
            .map(|call_id| ModelResponseReplayItem::FunctionCall {
                call_id: call_id.to_string(),
            }),
        _ => None,
    }
}

fn parse_reasoning_summary(value: &Value) -> Option<Vec<ModelReasoningSummaryPart>> {
    value
        .as_array()?
        .iter()
        .map(|part| {
            (part.get("type").and_then(Value::as_str) == Some("summary_text"))
                .then(|| part.get("text").and_then(Value::as_str))
                .flatten()
                .map(|text| ModelReasoningSummaryPart {
                    text: text.to_string(),
                })
        })
        .collect()
}

#[cfg(test)]
mod tests {
    use super::{
        parse_responses_output_item, parse_responses_replay_capture, ResponsesCompleted,
        ResponsesStreamEvent, ResponsesUsage,
    };
    use crate::stream::types::unified::UnifiedTokenUsage;
    use openbitfun_core_types::ModelResponseReplayItem;
    use serde_json::json;

    #[test]
    fn responses_cached_tokens_maps_to_cached_content() {
        let raw = r#"{
            "input_tokens": 200,
            "input_tokens_details": { "cached_tokens": 80, "cache_write_tokens": 64 },
            "output_tokens": 40,
            "total_tokens": 240
        }"#;
        let usage: ResponsesUsage = serde_json::from_str(raw).expect("valid responses usage");
        let unified: UnifiedTokenUsage = usage.into();
        assert_eq!(unified.cached_content_token_count, Some(80));
        assert_eq!(unified.cache_creation_token_count, Some(64));
    }

    #[test]
    fn responses_absent_cache_stays_none() {
        let raw = r#"{ "input_tokens": 200, "output_tokens": 40, "total_tokens": 240 }"#;
        let usage: ResponsesUsage = serde_json::from_str(raw).expect("valid responses usage");
        let unified: UnifiedTokenUsage = usage.into();
        assert_eq!(unified.cached_content_token_count, None);
        assert_eq!(unified.cache_creation_token_count, None);
    }

    #[test]
    fn responses_explicit_zero_cache_write_is_preserved() {
        let raw = r#"{
            "input_tokens": 200,
            "input_tokens_details": { "cached_tokens": 80, "cache_write_tokens": 0 },
            "output_tokens": 40,
            "total_tokens": 240
        }"#;
        let usage: ResponsesUsage = serde_json::from_str(raw).expect("valid responses usage");
        let unified: UnifiedTokenUsage = usage.into();
        assert_eq!(unified.cached_content_token_count, Some(80));
        assert_eq!(unified.cache_creation_token_count, Some(0));
    }

    #[test]
    fn parses_output_text_message_item() {
        let response = parse_responses_output_item(
            json!({
                "type": "message",
                "role": "assistant",
                "content": [
                    {
                        "type": "output_text",
                        "text": "hello"
                    }
                ]
            }),
            None,
        )
        .expect("message item");

        assert_eq!(response.text.as_deref(), Some("hello"));
    }

    #[test]
    fn parses_function_call_item() {
        let response = parse_responses_output_item(
            json!({
                "type": "function_call",
                "call_id": "call_1",
                "name": "get_weather",
                "arguments": "{\"city\":\"Beijing\"}"
            }),
            Some(3),
        )
        .expect("function call item");

        let tool_call = response.tool_call.expect("tool call");
        assert_eq!(tool_call.tool_call_index, Some(3));
        assert_eq!(tool_call.id.as_deref(), Some("call_1"));
        assert_eq!(tool_call.name.as_deref(), Some("get_weather"));
    }

    #[test]
    fn parses_completed_payload_usage() {
        let event: ResponsesStreamEvent = serde_json::from_value(json!({
            "type": "response.completed",
            "response": {
                "id": "resp_1",
                "usage": {
                    "input_tokens": 10,
                    "input_tokens_details": { "cached_tokens": 2 },
                    "output_tokens": 4,
                    "total_tokens": 14
                }
            }
        }))
        .expect("event");

        let completed: ResponsesCompleted =
            serde_json::from_value(event.response.expect("response")).expect("completed");
        assert_eq!(completed.id, "resp_1");
        assert_eq!(completed.usage.expect("usage").total_tokens, 14);
    }

    #[test]
    fn parses_output_item_added_indices() {
        let event: ResponsesStreamEvent = serde_json::from_value(json!({
            "type": "response.output_item.added",
            "output_index": 3,
            "item": { "type": "function_call", "call_id": "call_1", "name": "tool", "arguments": "" }
        }))
        .expect("event");

        assert_eq!(event.output_index, Some(3));
        assert!(event.item.is_some());
    }

    #[test]
    fn parses_function_call_arguments_delta_indices() {
        let event: ResponsesStreamEvent = serde_json::from_value(json!({
            "type": "response.function_call_arguments.delta",
            "output_index": 1,
            "delta": "{\"a\":"
        }))
        .expect("event");

        assert_eq!(event.output_index, Some(1));
        assert_eq!(event.delta.as_deref(), Some("{\"a\":"));
    }

    #[test]
    fn captures_reasoning_message_and_function_call_in_output_order() {
        let capture = parse_responses_replay_capture(&[
            json!({
                "id": "rs_1",
                "type": "reasoning",
                "summary": [{ "type": "summary_text", "text": "summary" }],
                "encrypted_content": "opaque"
            }),
            json!({
                "type": "function_call",
                "call_id": "call_1",
                "name": "tool",
                "arguments": "{}"
            }),
            json!({
                "type": "message",
                "role": "assistant",
                "content": [{ "type": "output_text", "text": "done" }]
            }),
        ])
        .expect("replay capture");

        assert_eq!(capture.items.len(), 3);
        assert!(matches!(
            &capture.items[0],
            ModelResponseReplayItem::OpaqueReasoning { item_id, summary, opaque_state }
                if item_id.as_deref() == Some("rs_1")
                    && summary.first().map(|part| part.text.as_str()) == Some("summary")
                    && opaque_state == "opaque"
        ));
        assert!(matches!(
            &capture.items[1],
            ModelResponseReplayItem::FunctionCall { call_id } if call_id == "call_1"
        ));
        assert!(matches!(
            &capture.items[2],
            ModelResponseReplayItem::AssistantMessage
        ));
    }

    #[test]
    fn does_not_capture_reasoning_without_opaque_state() {
        assert!(parse_responses_replay_capture(&[json!({
            "id": "rs_1",
            "type": "reasoning",
            "summary": [{ "type": "summary_text", "text": "summary" }]
        })])
        .is_none());
    }

    #[test]
    fn capture_is_atomic_when_output_contains_an_unsupported_item() {
        assert!(parse_responses_replay_capture(&[
            json!({
                "type": "reasoning",
                "encrypted_content": "opaque",
                "summary": []
            }),
            json!({ "type": "computer_call", "id": "computer_1" }),
        ])
        .is_none());
    }
}
