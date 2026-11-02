use crate::agentic::core::{Message, MessageContent, ToolResult};

/// Ensure a fork never carries an assistant tool call without a matching
/// result. A fork may be requested while the parent is between model output
/// and tool execution; providers commonly reject that history shape outright.
pub(crate) fn normalize_fork_context_messages(mut messages: Vec<Message>) -> Vec<Message> {
    normalize_incomplete_tool_calls(
        &mut messages,
        "Tool execution was still in progress when forking context; no result was available.",
    );
    messages
}

/// Close assistant tool calls that are still in flight at a provider-history
/// boundary. Live session history intentionally publishes those calls before
/// execution so readers can observe them; snapshots used for a new model
/// request must contain a result for every call.
///
/// The runtime appends each completed model round as one closed group, and an
/// interruption/fork can only leave the final active round incomplete. We use
/// that invariant to inspect only the final round (`O(k)` for the final round,
/// instead of `O(M)` for the full context). The trade-off is intentional:
/// malformed older history with an incomplete *earlier* round is not repaired
/// by this fast path. Snapshots without round metadata are treated as legacy
/// one-round contexts and use the same logic over the whole snapshot.
pub(crate) fn normalize_incomplete_tool_calls(messages: &mut Vec<Message>, result_text: &str) {
    let Some(last_round_id) = messages
        .iter()
        .rev()
        .find_map(|message| message.metadata.round_id.as_deref())
        .map(str::to_string)
    else {
        normalize_round_messages(messages, result_text, None);
        return;
    };

    let last_index = messages
        .iter()
        .rposition(|message| message.metadata.round_id.as_deref() == Some(last_round_id.as_str()))
        .unwrap_or(0);
    let mut start = last_index;
    while start > 0
        && messages[start - 1].metadata.round_id.as_deref() == Some(last_round_id.as_str())
    {
        start -= 1;
    }
    let mut round_messages = messages.split_off(start);
    normalize_round_messages(&mut round_messages, result_text, Some(&last_round_id));
    messages.extend(round_messages);
}

fn normalize_round_messages(
    messages: &mut Vec<Message>,
    result_text: &str,
    round_id: Option<&str>,
) {
    let result_ids = messages
        .iter()
        .filter_map(|message| match &message.content {
            MessageContent::ToolResult { tool_id, .. } => Some(tool_id.clone()),
            _ => None,
        })
        .collect::<std::collections::HashSet<_>>();
    let mut normalized = Vec::with_capacity(messages.len());
    for message in messages.drain(..) {
        let missing = match &message.content {
            MessageContent::Mixed { tool_calls, .. } => tool_calls
                .iter()
                .filter(|call| !result_ids.contains(&call.tool_id))
                .map(|call| ToolResult {
                    tool_id: call.tool_id.clone(),
                    tool_name: call.tool_name.clone(),
                    effective_tool_name: None,
                    result: serde_json::json!(result_text),
                    result_for_assistant: Some(result_text.to_string()),
                    is_error: false,
                    duration_ms: None,
                    image_attachments: None,
                })
                .collect::<Vec<_>>(),
            _ => Vec::new(),
        };
        normalized.push(message);
        normalized.extend(missing.into_iter().map(|result| {
            let message = Message::tool_result(result);
            match round_id {
                Some(round_id) => message.with_round_id(round_id.to_string()),
                None => message,
            }
        }));
    }
    *messages = normalized;
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::agentic::core::{Message, ToolCall, ToolResult};

    #[test]
    fn fork_context_inserts_in_progress_results_for_unclosed_tool_calls() {
        let call = ToolCall {
            tool_id: "call-1".to_string(),
            tool_name: "Read".to_string(),
            arguments: serde_json::json!({"path": "a.txt"}),
            ..Default::default()
        };
        let messages = normalize_fork_context_messages(vec![Message::assistant_with_tools(
            String::new(),
            vec![call],
        )]);

        assert_eq!(messages.len(), 2);
        assert!(matches!(
            messages[1].content,
            MessageContent::ToolResult {
                ref tool_id,
                is_error: false,
                ref result,
                ..
            } if tool_id == "call-1"
                && result == &serde_json::json!("Tool execution was still in progress when forking context; no result was available.")
        ));
    }

    #[test]
    fn fork_context_does_not_duplicate_existing_tool_results() {
        let call = ToolCall {
            tool_id: "call-1".to_string(),
            tool_name: "Read".to_string(),
            arguments: serde_json::json!({}),
            ..Default::default()
        };
        let result = ToolResult {
            tool_id: "call-1".to_string(),
            tool_name: "Read".to_string(),
            effective_tool_name: None,
            result: serde_json::json!("ok"),
            result_for_assistant: None,
            is_error: false,
            duration_ms: None,
            image_attachments: None,
        };
        let messages = normalize_fork_context_messages(vec![
            Message::assistant_with_tools(String::new(), vec![call]),
            Message::tool_result(result),
        ]);

        assert_eq!(messages.len(), 2);
    }
}
