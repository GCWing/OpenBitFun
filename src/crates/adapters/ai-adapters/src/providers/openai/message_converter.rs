//! OpenAI message format converter

use crate::stream::types::responses::OPENAI_RESPONSES_REPLAY_PROTOCOL;
use crate::types::{Message, ToolDefinition};
use log::{error, warn};
use openbitfun_core_types::ModelResponseReplayItem;
use serde_json::{json, Value};
use std::collections::{HashMap, HashSet};

pub struct OpenAIMessageConverter;

impl OpenAIMessageConverter {
    pub fn convert_messages_to_responses_input(
        messages: Vec<Message>,
    ) -> (Option<String>, Vec<Value>) {
        let mut instructions = Vec::new();
        let mut input = Vec::new();

        for msg in messages {
            match msg.role.as_str() {
                "system" => {
                    if let Some(content) = msg.content.filter(|content| !content.trim().is_empty())
                    {
                        instructions.push(content);
                    }
                }
                "tool" => {
                    if let Some(tool_item) = Self::convert_tool_message_to_responses_item(msg) {
                        input.push(tool_item);
                    }
                }
                "assistant" => {
                    if let Some(replay_items) = Self::convert_assistant_replay_items(&msg) {
                        input.extend(replay_items);
                        continue;
                    }

                    if let Some(content_items) = Self::convert_message_content_to_responses_items(
                        &msg.role,
                        msg.content.as_deref(),
                    ) {
                        input.push(json!({
                            "type": "message",
                            "role": "assistant",
                            "content": content_items,
                        }));
                    }

                    if let Some(tool_calls) = msg.tool_calls {
                        for tool_call in tool_calls {
                            input.push(json!({
                                "type": "function_call",
                                "call_id": tool_call.id,
                                "name": tool_call.name,
                                "arguments": tool_call.serialized_arguments(),
                            }));
                        }
                    }
                }
                role => {
                    if let Some(content_items) = Self::convert_message_content_to_responses_items(
                        role,
                        msg.content.as_deref(),
                    ) {
                        input.push(json!({
                            "type": "message",
                            "role": role,
                            "content": content_items,
                        }));
                    }
                }
            }
        }
        Self::trim_final_assistant_trailing_whitespace(&mut input);

        let instructions = if instructions.is_empty() {
            None
        } else {
            Some(instructions.join("\n\n"))
        };

        (instructions, input)
    }

    fn convert_assistant_replay_items(msg: &Message) -> Option<Vec<Value>> {
        let replay = msg.model_response_replay.as_ref()?;
        if replay.protocol != OPENAI_RESPONSES_REPLAY_PROTOCOL || replay.items.is_empty() {
            return None;
        }

        let assistant_message =
            Self::convert_message_content_to_responses_items("assistant", msg.content.as_deref())
                .map(|content| {
                    json!({
                        "type": "message",
                        "role": "assistant",
                        "content": content,
                    })
                });

        let tool_calls = msg.tool_calls.as_deref().unwrap_or_default();
        let mut tool_calls_by_id = HashMap::with_capacity(tool_calls.len());
        for tool_call in tool_calls {
            if tool_call.id.is_empty()
                || tool_calls_by_id
                    .insert(tool_call.id.as_str(), tool_call)
                    .is_some()
            {
                return None;
            }
        }

        let mut output = Vec::with_capacity(replay.items.len());
        let mut assistant_message_used = false;
        let mut used_tool_calls = HashSet::with_capacity(tool_calls.len());
        let mut saw_opaque_reasoning = false;

        for replay_item in &replay.items {
            match replay_item {
                ModelResponseReplayItem::OpaqueReasoning {
                    item_id,
                    summary,
                    opaque_state,
                } => {
                    if opaque_state.is_empty() {
                        return None;
                    }
                    saw_opaque_reasoning = true;
                    let mut item = json!({
                        "type": "reasoning",
                        "summary": summary
                            .iter()
                            .map(|part| json!({
                                "type": "summary_text",
                                "text": part.text,
                            }))
                            .collect::<Vec<_>>(),
                        "encrypted_content": opaque_state,
                    });
                    if let Some(item_id) = item_id.as_ref().filter(|value| !value.is_empty()) {
                        item["id"] = Value::String(item_id.clone());
                    }
                    output.push(item);
                }
                ModelResponseReplayItem::AssistantMessage => {
                    if assistant_message_used {
                        return None;
                    }
                    output.push(assistant_message.clone()?);
                    assistant_message_used = true;
                }
                ModelResponseReplayItem::FunctionCall { call_id } => {
                    if !used_tool_calls.insert(call_id.as_str()) {
                        return None;
                    }
                    let tool_call = tool_calls_by_id.get(call_id.as_str())?;
                    output.push(json!({
                        "type": "function_call",
                        "call_id": tool_call.id,
                        "name": tool_call.name,
                        "arguments": tool_call.serialized_arguments(),
                    }));
                }
            }
        }

        if !saw_opaque_reasoning
            || assistant_message_used != assistant_message.is_some()
            || used_tool_calls.len() != tool_calls.len()
        {
            return None;
        }

        Some(output)
    }

    pub fn convert_messages(messages: Vec<Message>) -> Vec<Value> {
        let mut converted = Vec::with_capacity(messages.len());
        let mut tool_images = Vec::new();
        for mut msg in messages {
            // Chat Completions tool content supports text only. Defer image context
            // until every result in this contiguous tool batch has been emitted,
            // so a synthetic user message never splits parallel tool responses.
            if msg.role != "tool" && !tool_images.is_empty() {
                converted.push(json!({
                    "role": "user",
                    "content": std::mem::take(&mut tool_images),
                }));
            }
            if msg.role == "tool" {
                if let Some(attachments) =
                    msg.tool_image_attachments.take().filter(|a| !a.is_empty())
                {
                    tool_images.push(json!({
                        "type": "text",
                        "text": format!(
                            "Images returned by tool {} (tool_call_id: {}):",
                            msg.name.as_deref().unwrap_or("unknown"),
                            msg.tool_call_id.as_deref().unwrap_or("unknown"),
                        ),
                    }));
                    tool_images.extend(attachments.into_iter().map(|attachment| json!({
                        "type": "image_url",
                        "image_url": {
                            "url": format!("data:{};base64,{}", attachment.mime_type, attachment.data_base64),
                            "detail": "auto",
                        },
                    })));
                }
            }
            converted.push(Self::convert_single_message(msg));
        }
        if !tool_images.is_empty() {
            converted.push(json!({ "role": "user", "content": tool_images }));
        }
        Self::trim_final_assistant_trailing_whitespace(&mut converted);
        converted
    }

    fn trim_final_assistant_trailing_whitespace(messages: &mut [Value]) {
        let Some(last) = messages.last_mut() else {
            return;
        };
        if last.get("role").and_then(Value::as_str) != Some("assistant") {
            return;
        }

        match last.get_mut("content") {
            Some(Value::String(text)) => {
                let trimmed_len = text.trim_end().len();
                text.truncate(trimmed_len);
            }
            Some(Value::Array(items)) => {
                for item in items.iter_mut().rev() {
                    let Some(Value::String(last_text)) = item.get_mut("text") else {
                        continue;
                    };
                    let trimmed_len = last_text.trim_end().len();
                    last_text.truncate(trimmed_len);
                    break;
                }
            }
            _ => {}
        }
    }

    fn convert_tool_message_to_responses_item(msg: Message) -> Option<Value> {
        let call_id = msg.tool_call_id?;
        let is_error = msg.is_error.unwrap_or(false);
        let text = msg.content.unwrap_or_default();
        let text = if is_error && !text.starts_with("[TOOL ERROR]") {
            format!("[TOOL ERROR] {}", text)
        } else {
            text
        };

        // Responses API: `output` may be a string or a list of input_text / input_image / input_file
        // (see OpenAI FunctionCallOutput schema).
        let output: Value =
            if let Some(attachments) = msg.tool_image_attachments.filter(|a| !a.is_empty()) {
                let mut parts: Vec<Value> = attachments
                    .into_iter()
                    .map(|att| {
                        let data_url = format!("data:{};base64,{}", att.mime_type, att.data_base64);
                        json!({
                            "type": "input_image",
                            "image_url": data_url
                        })
                    })
                    .collect();
                parts.push(json!({
                    "type": "input_text",
                    "text": if text.is_empty() {
                        "Tool execution completed".to_string()
                    } else {
                        text
                    }
                }));
                json!(parts)
            } else {
                json!(if text.is_empty() {
                    "Tool execution completed".to_string()
                } else {
                    text
                })
            };

        Some(json!({
            "type": "function_call_output",
            "call_id": call_id,
            "output": output,
        }))
    }

    fn convert_message_content_to_responses_items(
        role: &str,
        content: Option<&str>,
    ) -> Option<Vec<Value>> {
        let content = content?;
        let text_item_type = Self::responses_text_item_type(role);

        if content.trim().is_empty() {
            return Some(vec![json!({
                "type": text_item_type,
                "text": " ",
            })]);
        }

        Some(
            Self::parse_responses_content_parts(role, content).unwrap_or_else(|| {
                vec![json!({
                    "type": text_item_type,
                    "text": content,
                })]
            }),
        )
    }

    fn responses_text_item_type(role: &str) -> &'static str {
        if role == "assistant" {
            "output_text"
        } else {
            "input_text"
        }
    }

    fn parse_responses_content_parts(role: &str, content: &str) -> Option<Vec<Value>> {
        let items = serde_json::from_str::<Value>(content)
            .ok()?
            .as_array()?
            .clone();
        if items.is_empty() {
            return None;
        }
        let text_item_type = Self::responses_text_item_type(role);
        let mut content_items = Vec::with_capacity(items.len());

        for item in items {
            let item_type = item.get("type").and_then(Value::as_str)?;
            match item_type {
                "text" | "input_text" | "output_text" => {
                    let text = item.get("text").and_then(Value::as_str)?;
                    content_items.push(json!({
                        "type": text_item_type,
                        "text": text,
                    }));
                }
                "image_url" if role != "assistant" => {
                    let image_url = Self::extract_image_url_value(item.get("image_url")?)?;
                    content_items.push(json!({
                        "type": "input_image",
                        "image_url": image_url,
                    }));
                }
                _ => return None,
            }
        }

        Some(content_items)
    }

    fn parse_chat_completions_content_parts(role: &str, content: &str) -> Option<Vec<Value>> {
        // Tool text is opaque, even when it happens to contain JSON content parts.
        // Keeping it a string also works with providers that reject text arrays.
        if role == "tool" {
            return None;
        }
        let items = serde_json::from_str::<Value>(content)
            .ok()?
            .as_array()?
            .clone();
        if items.is_empty() {
            return None;
        }
        let mut content_items = Vec::with_capacity(items.len());

        for item in items {
            let item_type = item.get("type").and_then(Value::as_str)?;
            match item_type {
                "text" | "input_text" | "output_text" => {
                    let text = item.get("text").and_then(Value::as_str)?;
                    content_items.push(json!({
                        "type": "text",
                        "text": text,
                    }));
                }
                "image_url" if role == "user" => {
                    let image_url_value = item.get("image_url")?;
                    let image_url = Self::extract_image_url_value(image_url_value)?;
                    let mut content_item = json!({
                        "type": "image_url",
                        "image_url": {
                            "url": image_url,
                        }
                    });
                    if let Some(detail) = image_url_value.get("detail").and_then(Value::as_str) {
                        content_item["image_url"]["detail"] = Value::String(detail.to_string());
                    }
                    content_items.push(content_item);
                }
                _ => return None,
            }
        }

        Some(content_items)
    }

    fn extract_image_url_value(value: &Value) -> Option<String> {
        value
            .get("url")
            .and_then(Value::as_str)
            .or_else(|| value.as_str())
            .map(ToString::to_string)
    }

    fn convert_single_message(mut msg: Message) -> Value {
        // Prefix tool error content so the model can distinguish failures from normal results.
        if msg.role == "tool" && msg.is_error.unwrap_or(false) {
            if let Some(ref content) = msg.content {
                if !content.starts_with("[TOOL ERROR]") {
                    msg.content = Some(format!("[TOOL ERROR] {}", content));
                }
            }
        }

        let mut openai_msg = json!({
            "role": msg.role,
        });

        let has_tool_calls = msg.tool_calls.is_some();

        if let Some(content) = msg.content {
            if content.trim().is_empty() {
                if msg.role == "assistant" && has_tool_calls {
                    openai_msg["content"] = Value::String(content);
                } else if msg.role == "tool" {
                    openai_msg["content"] = Value::String("Tool execution completed".to_string());
                    warn!(
                        "[OpenAI] Tool response content is empty: name={:?}",
                        msg.name
                    );
                } else {
                    openai_msg["content"] = Value::String(" ".to_string());
                    warn!("[OpenAI] Message content is empty: role={}", msg.role);
                }
            } else {
                if let Some(content_parts) =
                    Self::parse_chat_completions_content_parts(&msg.role, &content)
                {
                    openai_msg["content"] = Value::Array(content_parts);
                } else {
                    openai_msg["content"] = Value::String(content);
                }
            }
        } else {
            if msg.role == "assistant" && has_tool_calls {
            } else if msg.role == "tool" {
                openai_msg["content"] = Value::String("Tool execution completed".to_string());

                warn!(
                    "[OpenAI] Tool response message content is empty, set to default: name={:?}",
                    msg.name
                );
            } else {
                error!(
                    "[OpenAI] Message content is empty and violates API spec: role={}, has_tool_calls={}", 
                    msg.role,
                    has_tool_calls
                );

                openai_msg["content"] = Value::String(" ".to_string());
            }
        }

        if let Some(reasoning) = msg.reasoning_content {
            // Official OpenAI Chat Completions may ignore replayed reasoning_content, but
            // many OpenAI-compatible providers require it to continue interleaved thinking.
            // Preserve even the empty-string case so providers like DeepSeek can validate the
            // original assistant turn shape on follow-up requests.
            openai_msg["reasoning_content"] = Value::String(reasoning);
        }

        if let Some(tool_calls) = msg.tool_calls {
            let openai_tool_calls: Vec<Value> = tool_calls
                .into_iter()
                .map(|tc| {
                    json!({
                        "id": tc.id,
                        "type": "function",
                        "function": {
                            "name": tc.name,
                            "arguments": tc.serialized_arguments()
                        }
                    })
                })
                .collect();
            openai_msg["tool_calls"] = Value::Array(openai_tool_calls);
        }

        if let Some(tool_call_id) = msg.tool_call_id {
            openai_msg["tool_call_id"] = Value::String(tool_call_id);
        }

        if msg.role != "tool" {
            if let Some(name) = msg.name {
                openai_msg["name"] = Value::String(name);
            }
        }

        openai_msg
    }

    pub fn convert_tools(tools: Option<Vec<ToolDefinition>>) -> Option<Vec<Value>> {
        tools.map(|tool_defs| {
            tool_defs
                .into_iter()
                .map(|tool| {
                    json!({
                        "type": "function",
                        "function": {
                            "name": tool.name,
                            "description": tool.description,
                            "parameters": tool.parameters
                        }
                    })
                })
                .collect()
        })
    }
}

#[cfg(test)]
mod tests {
    use super::OpenAIMessageConverter;
    use crate::types::{Message, ToolCall, ToolImageAttachment};
    use openbitfun_core_types::{
        ModelReasoningSummaryPart, ModelResponseReplay, ModelResponseReplayItem,
    };
    use serde_json::json;

    fn assistant_with_replay(
        content: Option<&str>,
        tool_calls: Vec<ToolCall>,
        items: Vec<ModelResponseReplayItem>,
    ) -> Message {
        Message {
            role: "assistant".to_string(),
            content: content.map(ToString::to_string),
            reasoning_content: Some("readable summary".to_string()),
            thinking_signature: None,
            tool_calls: (!tool_calls.is_empty()).then_some(tool_calls),
            tool_call_id: None,
            name: None,
            is_error: None,
            tool_image_attachments: None,
            model_response_replay: Some(ModelResponseReplay {
                protocol: "openai_responses".to_string(),
                channel_origin: None,
                channel_fingerprint: None,
                account_origin: None,
                items,
            }),
        }
    }

    fn opaque_reasoning(id: &str, state: &str) -> ModelResponseReplayItem {
        ModelResponseReplayItem::OpaqueReasoning {
            item_id: Some(id.to_string()),
            summary: vec![ModelReasoningSummaryPart {
                text: format!("summary {id}"),
            }],
            opaque_state: state.to_string(),
        }
    }

    #[test]
    fn replays_reasoning_before_final_assistant_message() {
        let message = assistant_with_replay(
            Some("done"),
            vec![],
            vec![
                opaque_reasoning("rs_1", "opaque_1"),
                ModelResponseReplayItem::AssistantMessage,
            ],
        );

        let (_, input) = OpenAIMessageConverter::convert_messages_to_responses_input(vec![message]);

        assert_eq!(input.len(), 2);
        assert_eq!(input[0]["type"], json!("reasoning"));
        assert_eq!(input[0]["id"], json!("rs_1"));
        assert_eq!(input[0]["encrypted_content"], json!("opaque_1"));
        assert_eq!(input[1]["type"], json!("message"));
        assert_eq!(input[1]["content"][0]["text"], json!("done"));
    }

    #[test]
    fn replays_multiple_reasoning_and_function_calls_in_original_order() {
        let message = assistant_with_replay(
            None,
            vec![
                ToolCall {
                    id: "call_1".to_string(),
                    name: "one".to_string(),
                    arguments: json!({"value": 1}),
                    raw_arguments: None,
                },
                ToolCall {
                    id: "call_2".to_string(),
                    name: "two".to_string(),
                    arguments: json!({"value": 2}),
                    raw_arguments: Some("{\"value\":2}".to_string()),
                },
            ],
            vec![
                opaque_reasoning("rs_1", "opaque_1"),
                ModelResponseReplayItem::FunctionCall {
                    call_id: "call_2".to_string(),
                },
                opaque_reasoning("rs_2", "opaque_2"),
                ModelResponseReplayItem::FunctionCall {
                    call_id: "call_1".to_string(),
                },
            ],
        );

        let (_, input) = OpenAIMessageConverter::convert_messages_to_responses_input(vec![message]);

        assert_eq!(
            input
                .iter()
                .map(|item| item["type"].as_str().unwrap())
                .collect::<Vec<_>>(),
            vec!["reasoning", "function_call", "reasoning", "function_call"]
        );
        assert_eq!(input[1]["call_id"], json!("call_2"));
        assert_eq!(input[1]["arguments"], json!("{\"value\":2}"));
        assert_eq!(input[3]["call_id"], json!("call_1"));
    }

    #[test]
    fn invalid_replay_layout_falls_back_atomically() {
        let message = assistant_with_replay(
            None,
            vec![
                ToolCall {
                    id: "call_1".to_string(),
                    name: "one".to_string(),
                    arguments: json!({"value": 1}),
                    raw_arguments: None,
                },
                ToolCall {
                    id: "call_2".to_string(),
                    name: "two".to_string(),
                    arguments: json!({"value": 2}),
                    raw_arguments: None,
                },
            ],
            vec![
                opaque_reasoning("rs_1", "opaque_1"),
                ModelResponseReplayItem::FunctionCall {
                    call_id: "call_1".to_string(),
                },
            ],
        );

        let (_, input) = OpenAIMessageConverter::convert_messages_to_responses_input(vec![message]);

        assert_eq!(input.len(), 2);
        assert!(input.iter().all(|item| item["type"] == "function_call"));
        assert!(input
            .iter()
            .all(|item| item.get("encrypted_content").is_none()));
    }

    #[test]
    fn converts_messages_to_responses_input() {
        let messages = vec![
            Message::system("You are helpful".to_string()),
            Message::user("Hello".to_string()),
            Message::assistant_with_tools(vec![ToolCall {
                id: "call_1".to_string(),
                name: "get_weather".to_string(),
                arguments: json!({"city": "Beijing"}),
                raw_arguments: None,
            }]),
            Message {
                role: "tool".to_string(),
                content: Some("Sunny".to_string()),
                reasoning_content: None,
                thinking_signature: None,
                tool_calls: None,
                tool_call_id: Some("call_1".to_string()),
                name: Some("get_weather".to_string()),
                is_error: None,
                tool_image_attachments: None,
                model_response_replay: None,
            },
        ];

        let (instructions, input) =
            OpenAIMessageConverter::convert_messages_to_responses_input(messages);

        assert_eq!(instructions.as_deref(), Some("You are helpful"));
        assert_eq!(input.len(), 3);
        assert_eq!(input[0]["type"], json!("message"));
        assert_eq!(input[1]["type"], json!("function_call"));
        assert_eq!(input[1]["arguments"], json!("{\"city\":\"Beijing\"}"));
        assert_eq!(input[2]["type"], json!("function_call_output"));
    }

    #[test]
    fn preserves_raw_tool_arguments_for_openai_replay() {
        let openai =
            OpenAIMessageConverter::convert_messages(vec![Message::assistant_with_tools(vec![
                ToolCall {
                    id: "call_1".to_string(),
                    name: "get_weather".to_string(),
                    arguments: json!({"city": "Beijing", "unit": "celsius"}),
                    raw_arguments: Some("{\"unit\":\"celsius\",\"city\":\"Beijing\"}".to_string()),
                },
            ])]);

        assert_eq!(
            openai[0]["tool_calls"][0]["function"]["arguments"],
            json!("{\"unit\":\"celsius\",\"city\":\"Beijing\"}")
        );
    }

    #[test]
    fn falls_back_to_stable_serialization_when_raw_arguments_are_invalid() {
        let openai =
            OpenAIMessageConverter::convert_messages(vec![Message::assistant_with_tools(vec![
                ToolCall {
                    id: "call_1".to_string(),
                    name: "get_weather".to_string(),
                    arguments: json!({"city": "Beijing", "unit": "celsius"}),
                    raw_arguments: Some("{\"city\":\"Beijing\"".to_string()),
                },
            ])]);

        assert_eq!(
            openai[0]["tool_calls"][0]["function"]["arguments"],
            json!("{\"city\":\"Beijing\",\"unit\":\"celsius\"}")
        );
    }

    #[test]
    fn converts_openai_style_image_content_to_responses_input() {
        let messages = vec![Message {
            role: "user".to_string(),
            content: Some(
                json!([
                    {
                        "type": "image_url",
                        "image_url": {
                            "url": "data:image/png;base64,abc"
                        }
                    },
                    {
                        "type": "text",
                        "text": "Describe this image"
                    }
                ])
                .to_string(),
            ),
            reasoning_content: None,
            thinking_signature: None,
            tool_calls: None,
            tool_call_id: None,
            name: None,
            is_error: None,
            tool_image_attachments: None,
            model_response_replay: None,
        }];

        let (_, input) = OpenAIMessageConverter::convert_messages_to_responses_input(messages);
        let content = input[0]["content"].as_array().expect("content array");

        assert_eq!(content[0]["type"], json!("input_image"));
        assert_eq!(content[1]["type"], json!("input_text"));
    }

    #[test]
    fn converts_tool_message_with_images_to_responses_function_call_output() {
        let messages = vec![Message {
            role: "tool".to_string(),
            content: Some("Screen captured".to_string()),
            reasoning_content: None,
            thinking_signature: None,
            tool_calls: None,
            tool_call_id: Some("call_cu_1".to_string()),
            name: Some("computer_use".to_string()),
            is_error: None,
            tool_image_attachments: Some(vec![ToolImageAttachment {
                mime_type: "image/jpeg".to_string(),
                data_base64: "AAA".to_string(),
            }]),
            model_response_replay: None,
        }];

        let (_, input) = OpenAIMessageConverter::convert_messages_to_responses_input(messages);
        let out = &input[0];
        assert_eq!(out["type"], json!("function_call_output"));
        assert_eq!(out["call_id"], json!("call_cu_1"));
        let output = out["output"].as_array().expect("multimodal output");
        assert_eq!(output[0]["type"], json!("input_image"));
        assert!(output[0]["image_url"]
            .as_str()
            .unwrap()
            .starts_with("data:image/jpeg;base64,"));
        assert_eq!(output[1]["type"], json!("input_text"));
        assert_eq!(output[1]["text"], json!("Screen captured"));
    }

    #[test]
    fn moves_tool_images_to_user_context_for_chat_completions() {
        let msg = Message {
            role: "tool".to_string(),
            content: Some("ok".to_string()),
            reasoning_content: None,
            thinking_signature: None,
            tool_calls: None,
            tool_call_id: Some("call_1".to_string()),
            name: Some("computer_use".to_string()),
            is_error: None,
            tool_image_attachments: Some(vec![ToolImageAttachment {
                mime_type: "image/jpeg".to_string(),
                data_base64: "YmFi".to_string(),
            }]),
            model_response_replay: None,
        };

        let openai = OpenAIMessageConverter::convert_messages(vec![msg]);
        assert_eq!(openai.len(), 2);
        assert_eq!(
            openai[0],
            json!({
                "role": "tool", "tool_call_id": "call_1", "content": "ok",
            })
        );
        assert_eq!(openai[1]["role"], "user");
        assert_eq!(
            openai[1]["content"],
            json!([
                {"type": "text", "text": "Images returned by tool computer_use (tool_call_id: call_1):"},
                {"type": "image_url", "image_url": {"url": "data:image/jpeg;base64,YmFi", "detail": "auto"}},
            ])
        );
    }

    #[test]
    fn replays_legacy_tool_images_after_all_parallel_results() {
        // This is the existing provider-neutral shape, including attachments in
        // old history. Conversion must not require a persisted-data migration.
        let legacy = json!([
            {"role": "assistant", "reasoning_content": "inspect both", "tool_calls": [
                {"id": "a", "name": "view_image", "arguments": {"path": "a.png"}},
                {"id": "b", "name": "view_image", "arguments": {"path": "b.jpg"}},
                {"id": "c", "name": "Read", "arguments": {"path": "notes.txt"}}
            ]},
            {"role": "tool", "tool_call_id": "a", "name": "view_image", "content": "",
             "tool_image_attachments": [
                 {"mime_type": "image/png", "data_base64": "AAA"},
                 {"mime_type": "image/png", "data_base64": "BBB"}
             ]},
            {"role": "tool", "tool_call_id": "b", "content": "partial image", "is_error": true,
             "tool_image_attachments": [{"mime_type": "image/jpeg", "data_base64": "CCC"}]},
            {"role": "tool", "tool_call_id": "c", "content": "notes"},
            {"role": "assistant", "content": "Images inspected."},
            {"role": "user", "content": "Continue."}
        ]);
        let messages: Vec<Message> = serde_json::from_value(legacy).unwrap();
        let round_trip: Vec<Message> =
            serde_json::from_value(serde_json::to_value(&messages).unwrap()).unwrap();
        let converted = OpenAIMessageConverter::convert_messages(messages);
        assert_eq!(
            converted,
            OpenAIMessageConverter::convert_messages(round_trip)
        );
        assert_eq!(
            converted
                .iter()
                .map(|m| m["role"].as_str().unwrap())
                .collect::<Vec<_>>(),
            [
                "assistant",
                "tool",
                "tool",
                "tool",
                "user",
                "assistant",
                "user"
            ]
        );
        assert_eq!(converted[0]["reasoning_content"], "inspect both");
        for (index, id) in [(1, "a"), (2, "b"), (3, "c")] {
            assert_eq!(converted[index]["tool_call_id"], id);
            assert!(converted[index]["content"].is_string());
        }
        assert_eq!(converted[1]["content"], "Tool execution completed");
        assert_eq!(converted[2]["content"], "[TOOL ERROR] partial image");
        let images = converted[4]["content"].as_array().unwrap();
        assert_eq!(images.len(), 5);
        assert!(images[0]["text"]
            .as_str()
            .unwrap()
            .contains("tool_call_id: a"));
        assert_eq!(images[1]["image_url"]["url"], "data:image/png;base64,AAA");
        assert_eq!(images[2]["image_url"]["url"], "data:image/png;base64,BBB");
        assert!(images[3]["text"]
            .as_str()
            .unwrap()
            .contains("tool_call_id: b"));
        assert_eq!(images[4]["image_url"]["url"], "data:image/jpeg;base64,CCC");
        assert_eq!(converted[6]["content"], "Continue.");
    }

    #[test]
    fn keeps_tool_batches_without_images_unchanged() {
        let messages: Vec<Message> = serde_json::from_value(json!([
            {"role": "tool", "tool_call_id": "a", "content": "ok", "tool_image_attachments": []},
            {"role": "user", "content": "Continue."}
        ]))
        .unwrap();
        let converted = OpenAIMessageConverter::convert_messages(messages);
        assert_eq!(
            converted,
            json!([
                {"role": "tool", "tool_call_id": "a", "content": "ok"},
                {"role": "user", "content": "Continue."}
            ])
            .as_array()
            .unwrap()
            .clone()
        );
    }

    #[test]
    fn keeps_tool_text_that_looks_like_content_parts_as_a_string() {
        let text = r#"[{"type":"text","text":"tool data"}]"#;
        let message: Message = serde_json::from_value(json!({
            "role": "tool", "tool_call_id": "a", "content": text,
        }))
        .unwrap();
        let converted = OpenAIMessageConverter::convert_messages(vec![message]);
        assert_eq!(converted[0]["content"], text);
    }

    #[test]
    fn keeps_tool_json_array_result_as_plain_text_for_chat_completions() {
        let raw_json = json!([
            {
                "name": ".github",
                "type": "dir"
            }
        ])
        .to_string();

        let msg = Message {
            role: "tool".to_string(),
            content: Some(raw_json.clone()),
            reasoning_content: None,
            thinking_signature: None,
            tool_calls: None,
            tool_call_id: Some("call_1".to_string()),
            name: Some("WebFetch".to_string()),
            is_error: None,
            tool_image_attachments: None,
            model_response_replay: None,
        };

        let openai = OpenAIMessageConverter::convert_messages(vec![msg]);

        assert_eq!(openai[0]["content"], json!(raw_json));
        assert!(openai[0].get("name").is_none());
    }

    #[test]
    fn keeps_non_content_json_array_as_plain_text_for_chat_completions() {
        let raw_json = json!([
            {
                "name": ".github",
                "type": "dir"
            }
        ])
        .to_string();

        let msg = Message {
            role: "user".to_string(),
            content: Some(raw_json.clone()),
            reasoning_content: None,
            thinking_signature: None,
            tool_calls: None,
            tool_call_id: None,
            name: None,
            is_error: None,
            tool_image_attachments: None,
            model_response_replay: None,
        };

        let openai = OpenAIMessageConverter::convert_messages(vec![msg]);

        assert_eq!(openai[0]["content"], json!(raw_json));
    }

    #[test]
    fn keeps_mixed_valid_and_invalid_json_array_as_plain_text_for_chat_completions() {
        let raw_json = json!([
            {
                "type": "text",
                "text": "hello"
            },
            {
                "type": "dir",
                "name": ".github"
            }
        ])
        .to_string();

        let msg = Message {
            role: "user".to_string(),
            content: Some(raw_json.clone()),
            reasoning_content: None,
            thinking_signature: None,
            tool_calls: None,
            tool_call_id: None,
            name: None,
            is_error: None,
            tool_image_attachments: None,
            model_response_replay: None,
        };

        let openai = OpenAIMessageConverter::convert_messages(vec![msg]);

        assert_eq!(openai[0]["content"], json!(raw_json));
    }

    #[test]
    fn keeps_non_content_json_array_as_plain_text_for_responses_input() {
        let raw_json = json!([
            {
                "name": ".github",
                "type": "dir"
            }
        ])
        .to_string();

        let (_, input) =
            OpenAIMessageConverter::convert_messages_to_responses_input(vec![Message {
                role: "user".to_string(),
                content: Some(raw_json.clone()),
                reasoning_content: None,
                thinking_signature: None,
                tool_calls: None,
                tool_call_id: None,
                name: None,
                is_error: None,
                tool_image_attachments: None,
                model_response_replay: None,
            }]);

        assert_eq!(input[0]["content"][0]["type"], json!("input_text"));
        assert_eq!(input[0]["content"][0]["text"], json!(raw_json));
    }

    #[test]
    fn keeps_mixed_valid_and_invalid_json_array_as_plain_text_for_responses_input() {
        let raw_json = json!([
            {
                "type": "text",
                "text": "hello"
            },
            {
                "type": "dir",
                "name": ".github"
            }
        ])
        .to_string();

        let (_, input) =
            OpenAIMessageConverter::convert_messages_to_responses_input(vec![Message {
                role: "user".to_string(),
                content: Some(raw_json.clone()),
                reasoning_content: None,
                thinking_signature: None,
                tool_calls: None,
                tool_call_id: None,
                name: None,
                is_error: None,
                tool_image_attachments: None,
                model_response_replay: None,
            }]);

        assert_eq!(input[0]["content"][0]["type"], json!("input_text"));
        assert_eq!(input[0]["content"][0]["text"], json!(raw_json));
    }

    #[test]
    fn preserves_empty_reasoning_content_for_chat_completions() {
        let msg = Message {
            role: "assistant".to_string(),
            content: Some("Answer".to_string()),
            reasoning_content: Some(String::new()),
            thinking_signature: None,
            tool_calls: None,
            tool_call_id: None,
            name: None,
            is_error: None,
            tool_image_attachments: None,
            model_response_replay: None,
        };

        let openai = OpenAIMessageConverter::convert_messages(vec![msg]);

        assert_eq!(openai[0]["reasoning_content"], json!(""));
    }

    #[test]
    fn preserves_empty_assistant_content_for_tool_calls() {
        let msg = Message {
            role: "assistant".to_string(),
            content: Some(String::new()),
            reasoning_content: Some("thinking".to_string()),
            thinking_signature: None,
            tool_calls: Some(vec![ToolCall {
                id: "call_1".to_string(),
                name: "get_weather".to_string(),
                arguments: json!({"city": "Beijing"}),
                raw_arguments: None,
            }]),
            tool_call_id: None,
            name: None,
            is_error: None,
            tool_image_attachments: None,
            model_response_replay: None,
        };

        let openai = OpenAIMessageConverter::convert_messages(vec![msg]);

        assert_eq!(openai[0]["content"], json!(""));
        assert_eq!(openai[0]["reasoning_content"], json!("thinking"));
    }

    #[test]
    fn omits_missing_assistant_content_for_tool_calls() {
        let openai =
            OpenAIMessageConverter::convert_messages(vec![Message::assistant_with_tools(vec![
                ToolCall {
                    id: "call_1".to_string(),
                    name: "get_weather".to_string(),
                    arguments: json!({"city": "Beijing"}),
                    raw_arguments: None,
                },
            ])]);

        assert!(openai[0].get("content").is_none());
    }

    #[test]
    fn trims_trailing_whitespace_from_final_assistant_prefill_for_chat_completions() {
        let openai = OpenAIMessageConverter::convert_messages(vec![
            Message::user("Continue the assistant response.".to_string()),
            Message::assistant("<assistant_prefill>\n".to_string()),
        ]);

        assert_eq!(openai[1]["content"], json!("<assistant_prefill>"));
    }

    #[test]
    fn trims_trailing_whitespace_from_final_assistant_prefill_for_responses() {
        let (_, input) = OpenAIMessageConverter::convert_messages_to_responses_input(vec![
            Message::user("Continue the assistant response.".to_string()),
            Message::assistant("<assistant_prefill>\n".to_string()),
        ]);

        assert_eq!(input[1]["content"][0]["text"], json!("<assistant_prefill>"));
    }
}
