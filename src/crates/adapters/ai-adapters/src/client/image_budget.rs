//! Model-specific image input budgets for an outgoing request copy.

use crate::types::Message;
use anyhow::Result;
use openbitfun_core_types::errors::{AiProviderError, ErrorCategory};
use serde_json::{json, Value};

/// Message payload overrides are merged after the message projection. Reject
/// them when a budget is configured rather than accepting an uncounted payload.
pub(super) fn validate_extra_body(
    max_images: Option<usize>,
    extra_body: Option<&Value>,
) -> Result<()> {
    if max_images.is_some()
        && extra_body.and_then(Value::as_object).is_some_and(|fields| {
            ["messages", "input", "contents"]
                .iter()
                .any(|key| fields.contains_key(*key))
        })
    {
        return Err(AiProviderError::classified(
            "A model image limit cannot be combined with custom messages, input or contents. Remove the message payload override and use ordinary model messages.".into(),
            ErrorCategory::InvalidRequest,
        )
        .into());
    }
    Ok(())
}

/// Keep the newest image-bearing messages within the selected model's budget.
/// Within one message, retain the first images in their original order. Tool
/// identities, text, reasoning and replay state are otherwise left intact.
pub(super) fn project(
    mut messages: Vec<Message>,
    max_images: Option<usize>,
) -> Result<Vec<Message>> {
    let Some(mut remaining) = max_images else {
        return Ok(messages);
    };
    if remaining == 0 {
        return Err(AiProviderError::classified(
            "max_images_per_request must be greater than zero".into(),
            ErrorCategory::InvalidRequest,
        )
        .into());
    }

    for message in messages.iter_mut().rev() {
        match message.role.as_str() {
            "tool" => {
                let Some(images) = message.tool_image_attachments.as_mut() else {
                    continue;
                };
                let total = images.len();
                let keep = total.min(remaining);
                remaining -= keep;
                let omitted = total - keep;
                if omitted > 0 {
                    images.truncate(keep);
                    if images.is_empty() {
                        message.tool_image_attachments = None;
                    }
                    let text = message.content.get_or_insert_with(String::new);
                    let retained = if keep > 0 {
                        format!(" Only the first {keep} of {total} images from this tool result are included.")
                    } else {
                        String::new()
                    };
                    text.push_str(&format!(
                        "\n\n[{omitted} tool image(s) omitted to fit the model's per-request image limit.{retained} Read images in smaller batches if their pixels are needed.]"
                    ));
                }
            }
            "user" => project_user_content(&mut message.content, &mut remaining),
            _ => {}
        }
    }
    Ok(messages)
}

fn project_user_content(content: &mut Option<String>, remaining: &mut usize) {
    let Some(original) = content.as_deref() else {
        return;
    };
    let Ok(Value::Array(mut parts)) = serde_json::from_str::<Value>(original) else {
        return;
    };
    // Ordinary JSON remains text. Require a recognizable content-part array,
    // rather than recursively treating arbitrary image-looking fields as pixels.
    if !parts.iter().all(is_content_part) {
        return;
    }
    let image_count = parts.iter().filter(|part| is_image_part(part)).count();
    let keep = image_count.min(*remaining);
    *remaining -= keep;
    let omitted = image_count - keep;
    if omitted == 0 {
        return;
    }
    let mut seen = 0usize;
    parts.retain(|part| {
        if is_image_part(part) {
            seen += 1;
            seen <= keep
        } else {
            true
        }
    });
    let retained = if keep > 0 {
        format!(" Only the first {keep} of {image_count} images from this message are included.")
    } else {
        String::new()
    };
    parts.push(json!({
        "type": "text",
        "text": format!("[{omitted} image(s) omitted to fit the model's per-request image limit.{retained} Reattach or read images in smaller batches if their pixels are needed.]"),
    }));
    *content = Some(Value::Array(parts).to_string());
}

fn image_url(value: Option<&Value>) -> bool {
    value
        .and_then(|value| value.as_str().or_else(|| value.get("url")?.as_str()))
        .is_some_and(|url| !url.is_empty())
}

fn inline_media(part: &Value) -> Option<(&str, &str)> {
    let data = part.get("inline_data").or_else(|| part.get("inlineData"))?;
    Some((
        data.get("mime_type")
            .or_else(|| data.get("mimeType"))?
            .as_str()?,
        data.get("data")?.as_str()?,
    ))
}

fn is_image_part(part: &Value) -> bool {
    match part.get("type").and_then(Value::as_str) {
        Some("image_url") => image_url(part.get("image_url")),
        Some("input_image") => {
            image_url(part.get("image_url"))
                || part.get("file_id").and_then(Value::as_str).is_some()
        }
        Some("image") => part.get("source").is_some_and(|source| {
            image_url(source.get("url"))
                || (source
                    .get("media_type")
                    .and_then(Value::as_str)
                    .is_some_and(|mime| mime.starts_with("image/"))
                    && source.get("data").and_then(Value::as_str).is_some())
        }),
        _ => inline_media(part).is_some_and(|(mime, _)| mime.starts_with("image/")),
    }
}

fn is_content_part(part: &Value) -> bool {
    if is_image_part(part) || inline_media(part).is_some() {
        return true;
    }
    match part.get("type").and_then(Value::as_str) {
        Some("text" | "input_text" | "output_text") | None => {
            part.get("text").and_then(Value::as_str).is_some()
        }
        // Preserve non-image multimodal parts without charging the image budget.
        Some("input_audio" | "audio" | "video" | "file" | "input_file" | "document") => true,
        _ => false,
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::providers::anthropic::message_converter::AnthropicMessageConverter;
    use crate::providers::gemini::message_converter::GeminiMessageConverter;
    use crate::providers::openai::message_converter::OpenAIMessageConverter;
    use crate::types::ToolImageAttachment;

    fn image(id: &str) -> Value {
        json!({"type": "image_url", "image_url": {"url": format!("data:image/png;base64,{id}")}})
    }

    fn user_images(ids: &[&str]) -> Message {
        let mut parts = vec![json!({"type": "text", "text": "Inspect these images."})];
        parts.extend(ids.iter().map(|id| image(id)));
        Message::user(Value::Array(parts).to_string())
    }

    fn tool_images(id: &str, count: usize) -> Message {
        let mut message = Message::user("Image attached".into());
        message.role = "tool".into();
        message.tool_call_id = Some(id.into());
        message.name = Some("view_image".into());
        message.tool_image_attachments = Some(
            (0..count)
                .map(|index| ToolImageAttachment {
                    mime_type: "image/png".into(),
                    data_base64: format!("{id}_{index}"),
                })
                .collect(),
        );
        message
    }

    fn count(messages: &[Message]) -> usize {
        messages
            .iter()
            .map(|message| {
                let tool_count = message.tool_image_attachments.as_ref().map_or(0, Vec::len);
                let user_count = if message.role == "user" {
                    message
                        .content
                        .as_deref()
                        .and_then(|content| serde_json::from_str::<Value>(content).ok())
                        .and_then(|value| value.as_array().cloned())
                        .map_or(0, |parts| {
                            parts.iter().filter(|part| is_image_part(part)).count()
                        })
                } else {
                    0
                };
                tool_count + user_count
            })
            .sum()
    }

    fn wire_count(value: &Value) -> usize {
        match value {
            Value::Array(items) => items.iter().map(wire_count).sum(),
            Value::Object(fields) => {
                usize::from(is_image_part(value)) + fields.values().map(wire_count).sum::<usize>()
            }
            _ => 0,
        }
    }

    fn client_config(format: &str, url: &str, limit: usize) -> crate::types::AIConfig {
        serde_json::from_value(json!({
            "name": "image-budget-test",
            "base_url": url,
            "request_url": url,
            "api_key": "synthetic",
            "model": "test",
            "format": format,
            "context_window": 4096,
            "max_images_per_request": limit,
            "inline_think_in_text": false,
            "skip_ssl_verify": false
        }))
        .unwrap()
    }

    #[test]
    fn mixed_user_and_tool_images_share_the_request_budget() {
        let original = vec![user_images(&["old-a", "old-b"]), tool_images("latest", 2)];
        let original_json = serde_json::to_value(&original).unwrap();
        let projected = project(original.clone(), Some(3)).unwrap();
        assert_eq!(count(&projected), 3);
        let content = projected[0].content.as_deref().unwrap();
        assert!(content.contains("old-a"));
        assert!(!content.contains("old-b"));
        assert!(content.contains("1 image(s) omitted"));
        assert!(content.contains("first 1 of 2 images"));
        assert_eq!(projected[1].tool_call_id.as_deref(), Some("latest"));
        assert_eq!(serde_json::to_value(original).unwrap(), original_json);
    }

    #[test]
    fn four_parallel_tool_results_keep_the_latest_three_without_losing_results() {
        let messages = (0..4)
            .map(|index| tool_images(&format!("call-{index}"), 1))
            .collect();
        let projected = project(messages, Some(3)).unwrap();
        assert_eq!(projected.len(), 4);
        assert_eq!(count(&projected), 3);
        assert!(projected[0].tool_image_attachments.is_none());
        assert!(projected[0]
            .content
            .as_deref()
            .unwrap()
            .contains("Read images in smaller batches"));
        for (index, message) in projected.iter().enumerate() {
            assert_eq!(message.tool_call_id, Some(format!("call-{index}")));
            assert_eq!(message.name.as_deref(), Some("view_image"));
            assert!(message
                .content
                .as_deref()
                .unwrap()
                .starts_with("Image attached"));
        }
    }

    #[test]
    fn one_tool_result_can_be_partially_projected() {
        let mut original = tool_images("batch", 4);
        original.reasoning_content = Some("keep reasoning".into());
        original.thinking_signature = Some("keep signature".into());
        original.is_error = Some(false);
        original.model_response_replay = Some(
            serde_json::from_value(json!({
                "protocol": "test", "items": []
            }))
            .unwrap(),
        );
        let mut expected = serde_json::to_value(&original).unwrap();
        let projected = project(vec![original], Some(3)).unwrap();
        let images = projected[0].tool_image_attachments.as_ref().unwrap();
        assert_eq!(images.len(), 3);
        assert_eq!(images[0].data_base64, "batch_0");
        assert_eq!(images[2].data_base64, "batch_2");
        assert!(projected[0]
            .content
            .as_deref()
            .unwrap()
            .contains("1 tool image(s) omitted"));
        assert!(projected[0]
            .content
            .as_deref()
            .unwrap()
            .contains("first 3 of 4 images"));
        // The content placeholder and truncated attachment vector are the only
        // permitted differences; metadata and result identities remain intact.
        let actual = serde_json::to_value(&projected[0]).unwrap();
        expected["content"] = actual["content"].clone();
        expected["tool_image_attachments"] = actual["tool_image_attachments"].clone();
        assert_eq!(actual, expected);
    }

    #[test]
    fn a_plain_continue_reprojects_old_history_with_the_actual_clients_limit() {
        let mut history = vec![tool_images("batch", 4)];
        assert_eq!(count(&project(history.clone(), Some(5)).unwrap()), 4);
        assert_eq!(count(&project(history.clone(), Some(3)).unwrap()), 3);
        history.push(Message::user("Continue.".into()));
        let projected = project(history.clone(), Some(3)).unwrap();
        assert_eq!(count(&projected), 3);
        assert_eq!(projected[1].content.as_deref(), Some("Continue."));
        assert_eq!(count(&history), 4);
        assert_eq!(count(&project(projected, Some(3)).unwrap()), 3);
    }

    #[test]
    fn unconfigured_and_within_budget_requests_are_byte_for_byte_unchanged() {
        let mut message = user_images(&["a", "b", "c", "d"]);
        message.content = Some(format!("\n {} \n", message.content.unwrap()));
        message.reasoning_content = Some("Reasoning remains attached.".into());
        message.thinking_signature = Some("signature".into());
        let messages = vec![message, tool_images("tool", 1)];
        let expected = serde_json::to_value(&messages).unwrap();
        assert_eq!(
            serde_json::to_value(project(messages.clone(), None).unwrap()).unwrap(),
            expected
        );
        assert_eq!(
            serde_json::to_value(project(messages, Some(5)).unwrap()).unwrap(),
            expected
        );
    }

    #[test]
    fn zero_limit_is_a_structured_invalid_request() {
        let error = project(vec![Message::user("hello".into())], Some(0)).unwrap_err();
        let error = error.downcast_ref::<AiProviderError>().unwrap();
        assert_eq!(error.category, ErrorCategory::InvalidRequest);
        assert!(error.provider.is_none());
        assert!(error.http_status.is_none());
    }

    #[test]
    fn message_payload_overrides_cannot_bypass_a_configured_image_limit() {
        for key in ["messages", "input", "contents"] {
            let override_body = json!({(key): [image("custom")]});
            let error = validate_extra_body(Some(3), Some(&override_body)).unwrap_err();
            let error = error.downcast_ref::<AiProviderError>().unwrap();
            assert_eq!(error.category, ErrorCategory::InvalidRequest);
            assert!(error.provider.is_none());
            assert!(error.http_status.is_none());
            assert!(error
                .message
                .contains("Remove the message payload override"));
            assert!(validate_extra_body(None, Some(&override_body)).is_ok());
        }
        assert!(validate_extra_body(Some(3), None).is_ok());
        assert!(validate_extra_body(
            Some(3),
            Some(&json!({
                "temperature": 0.2, "thinking": {"type": "enabled"}
            }))
        )
        .is_ok());
    }

    #[tokio::test]
    async fn every_send_entry_point_rejects_a_zero_budget_before_transport() {
        for format in ["openai", "responses", "anthropic", "gemini"] {
            let config = client_config(format, "invalid-image-budget-test", 0);
            let client = crate::AIClient::new(config);
            let messages = vec![Message::user("hello".into())];
            let errors = [
                client
                    .send_message_stream_once(messages.clone(), None, None)
                    .await
                    .err()
                    .unwrap(),
                client
                    .send_message_once_with_trace_and_request_context(
                        messages.clone(),
                        None,
                        None,
                        None,
                    )
                    .await
                    .err()
                    .unwrap(),
            ];
            for error in errors {
                assert_eq!(
                    error.downcast_ref::<AiProviderError>().unwrap().category,
                    ErrorCategory::InvalidRequest
                );
            }
            for key in ["messages", "input", "contents"] {
                let mut bounded = client.clone();
                bounded.config.max_images_per_request = Some(3);
                bounded.config.custom_request_body = Some(json!({(key): []}));
                let error = bounded
                    .send_message_stream_once(messages.clone(), None, None)
                    .await
                    .err()
                    .unwrap();
                assert_eq!(
                    error.downcast_ref::<AiProviderError>().unwrap().category,
                    ErrorCategory::InvalidRequest
                );
            }
        }
    }

    #[tokio::test]
    async fn selected_client_budget_is_applied_to_each_actual_http_send() {
        use axum::{extract::State, routing::post, Json, Router};
        use std::sync::{Arc, Mutex};

        async fn receive(
            State(requests): State<Arc<Mutex<Vec<Value>>>>,
            Json(body): Json<Value>,
        ) -> ([(&'static str, &'static str); 1], String) {
            requests.lock().unwrap().push(body);
            let content_chunk = json!({
                "id": "image-budget-test",
                "object": "chat.completion.chunk",
                "created": 1,
                "model": "test",
                "choices": [{
                    "index": 0,
                    "delta": {"role": "assistant", "content": "ok"},
                    "finish_reason": null
                }]
            });
            let stop_chunk = json!({
                "id": "image-budget-test",
                "object": "chat.completion.chunk",
                "created": 1,
                "model": "test",
                "choices": [{"index": 0, "delta": {}, "finish_reason": "stop"}]
            });
            (
                [("content-type", "text/event-stream")],
                format!("data: {content_chunk}\n\ndata: {stop_chunk}\n\ndata: [DONE]\n\n"),
            )
        }

        let requests = Arc::new(Mutex::new(Vec::<Value>::new()));
        let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
        let url = format!("http://{}/chat/completions", listener.local_addr().unwrap());
        let router = Router::new()
            .route("/chat/completions", post(receive))
            .with_state(requests.clone());
        let server = tokio::spawn(async move { axum::serve(listener, router).await.unwrap() });
        let initial = crate::AIClient::new(client_config("openai", &url, 5));
        let mut selected = initial.clone();
        selected.config.max_images_per_request = Some(3);
        let mut history = vec![tool_images("batch", 4)];
        tokio::time::timeout(std::time::Duration::from_secs(5), async {
            initial
                .send_message_once_with_trace_and_request_context(history.clone(), None, None, None)
                .await
                .unwrap();
            selected
                .send_message_once_with_trace_and_request_context(history.clone(), None, None, None)
                .await
                .unwrap();
            history.push(Message::user("Continue.".into()));
            selected
                .send_message_once_with_trace_and_request_context(history.clone(), None, None, None)
                .await
                .unwrap();
        })
        .await
        .unwrap();
        server.abort();
        let requests = requests.lock().unwrap();
        assert_eq!(requests.len(), 3);
        assert_eq!(wire_count(&requests[0]["messages"]), 4);
        assert_eq!(wire_count(&requests[1]["messages"]), 3);
        assert_eq!(wire_count(&requests[2]["messages"]), 3);
        assert_eq!(count(&history), 4);
    }

    #[test]
    fn tool_json_is_opaque_even_if_it_looks_like_image_content() {
        let mut message = tool_images("opaque", 0);
        message.content = user_images(&["a", "b", "c", "d"]).content;
        let expected = serde_json::to_value(&message).unwrap();
        assert_eq!(
            serde_json::to_value(&project(vec![message], Some(1)).unwrap()[0]).unwrap(),
            expected
        );
    }

    #[test]
    fn ordinary_json_and_non_image_inline_media_do_not_consume_the_budget() {
        let ordinary = Message::user(json!({"images": [image("metadata")]}).to_string());
        let array = Message::user(json!([{"record": image("metadata")}]).to_string());
        let audio = Message::user(
            json!([
                {"inlineData": {"mimeType": "audio/wav", "data": "sound"}},
                {"type": "text", "text": "transcribe"}
            ])
            .to_string(),
        );
        let expected = serde_json::to_value([&ordinary, &array, &audio]).unwrap();
        let projected = project(
            vec![ordinary, array, audio, tool_images("latest", 1)],
            Some(1),
        )
        .unwrap();
        assert_eq!(serde_json::to_value(&projected[..3]).unwrap(), expected);
        assert_eq!(count(&projected), 1);
    }

    #[test]
    fn recognizes_all_image_content_dialects_and_keeps_non_image_parts() {
        let dialects = [
            image("pixels"),
            json!({"type": "input_image", "image_url": "data:image/png;base64,pixels"}),
            json!({"type": "image", "source": {"type": "base64", "media_type": "image/png", "data": "pixels"}}),
            json!({"inline_data": {"mime_type": "image/png", "data": "pixels"}}),
            json!({"inlineData": {"mimeType": "image/png", "data": "pixels"}}),
        ];
        for image_part in dialects {
            let text = json!({"type": "text", "text": "Preserve this text."});
            let parts = vec![
                image_part.clone(),
                text.clone(),
                image_part.clone(),
                image_part,
            ];
            let projected =
                project(vec![Message::user(json!(parts).to_string())], Some(2)).unwrap();
            let parts: Vec<Value> =
                serde_json::from_str(projected[0].content.as_deref().unwrap()).unwrap();
            assert_eq!(parts.iter().filter(|part| is_image_part(part)).count(), 2);
            assert_eq!(parts[1], text);
            assert!(parts.last().unwrap()["text"]
                .as_str()
                .unwrap()
                .contains("1 image(s) omitted"));
        }
    }

    #[test]
    fn projected_pixels_stay_within_budget_in_every_provider_wire_format() {
        for format in ["openai", "responses", "anthropic", "gemini"] {
            let mut user = user_images(&["a", "b"]);
            if format == "anthropic" {
                user.content = Some(json!([
                    {"type": "image", "source": {"type": "base64", "media_type": "image/png", "data": "a"}},
                    {"type": "image", "source": {"type": "base64", "media_type": "image/png", "data": "b"}},
                    {"type": "text", "text": "Inspect these images."}
                ]).to_string());
            }
            let projected = project(vec![user, tool_images("a", 2)], Some(3)).unwrap();
            let wire = match format {
                "openai" => json!(OpenAIMessageConverter::convert_messages(projected)),
                "responses" => {
                    json!(OpenAIMessageConverter::convert_messages_to_responses_input(projected).1)
                }
                "anthropic" => json!(AnthropicMessageConverter::convert_messages(projected).1),
                _ => json!(GeminiMessageConverter::convert_messages(projected, "gemini-3-pro").1),
            };
            assert_eq!(wire_count(&wire), 3, "format={format}, wire={wire}");
        }
    }
}
