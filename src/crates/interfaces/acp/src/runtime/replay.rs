//! Replays persisted conversation history back to the client as
//! `session/update` notifications during `session/load`.
//!
//! Per the Agent Client Protocol, an agent that advertises the `loadSession`
//! capability must not only restore its own runtime context but also *stream
//! the entire conversation history back to the client via notifications* so the
//! client can reconstruct the transcript UI. This module owns that replay pass.

use agent_client_protocol::schema::{
    ContentBlock, ContentChunk, ImageContent, SessionUpdate, TextContent,
};
use agent_client_protocol::{Client, ConnectionTo, Result};
use openbitfun_core::service::session::{
    DialogTurnData, ModelRoundData, TextItemData, ThinkingItemData, ToolItemData, UserMessageData,
};

use super::events::{send_update, tool_call_replay_updates};

/// Stream the persisted turn history for `session_id` to the client as
/// `session/update` notifications, in the order the turns originally occurred.
///
/// Non-model-visible turns (local commands, manual compactions) are skipped
/// because they never produced client-visible dialog.
pub(super) fn replay_session_history(
    connection: &ConnectionTo<Client>,
    acp_session_id: &str,
    turns: &[DialogTurnData],
) -> Result<()> {
    for turn in turns {
        if !turn.kind.is_model_visible() {
            continue;
        }

        for block in user_message_blocks(&turn.user_message) {
            send_update(
                connection,
                acp_session_id,
                SessionUpdate::UserMessageChunk(ContentChunk::new(block)),
            )?;
        }

        for round in &turn.model_rounds {
            replay_round(connection, acp_session_id, round)?;
        }
    }

    Ok(())
}

fn replay_round(
    connection: &ConnectionTo<Client>,
    acp_session_id: &str,
    round: &ModelRoundData,
) -> Result<()> {
    for item in order_round_items(round) {
        match item {
            OrderedRoundItem::Thinking(item) => {
                send_update(
                    connection,
                    acp_session_id,
                    SessionUpdate::AgentThoughtChunk(ContentChunk::new(ContentBlock::Text(
                        TextContent::new(item.content.clone()),
                    ))),
                )?;
            }
            OrderedRoundItem::Text(item) => {
                send_update(
                    connection,
                    acp_session_id,
                    SessionUpdate::AgentMessageChunk(ContentChunk::new(ContentBlock::Text(
                        TextContent::new(item.content.clone()),
                    ))),
                )?;
            }
            OrderedRoundItem::Tool(item) => {
                for update in tool_call_replay_updates(item) {
                    send_update(connection, acp_session_id, update)?;
                }
            }
        }
    }

    Ok(())
}

/// A flattened, insertion-ordered view over the items in a model round.
///
/// Text, thinking, and tool items share a single `order_index` sequence when
/// persisted; interleaving them here preserves the original streaming order
/// (e.g. text → tool call → text) instead of grouping by kind.
enum OrderedRoundItem<'a> {
    Thinking(&'a ThinkingItemData),
    Text(&'a TextItemData),
    Tool(&'a ToolItemData),
}

fn order_round_items(round: &ModelRoundData) -> Vec<OrderedRoundItem<'_>> {
    let mut items = Vec::with_capacity(
        round.text_items.len() + round.thinking_items.len() + round.tool_items.len(),
    );
    items.extend(round.thinking_items.iter().map(OrderedRoundItem::Thinking));
    items.extend(round.text_items.iter().map(OrderedRoundItem::Text));
    items.extend(round.tool_items.iter().map(OrderedRoundItem::Tool));
    items.sort_by_key(order_index);
    items
}

fn order_index(item: &OrderedRoundItem<'_>) -> usize {
    match item {
        OrderedRoundItem::Thinking(item) => item.order_index,
        OrderedRoundItem::Text(item) => item.order_index,
        OrderedRoundItem::Tool(item) => item.order_index,
    }
    .unwrap_or(0)
}

/// Build the `ContentBlock` sequence to replay for a persisted user message.
///
/// The stored `UserMessageData.content` is a model-facing flattened string in
/// which image attachments are replaced by `[Attached image: …]` placeholder
/// text (see `content::parse_prompt_blocks`). The user's original pre-image
/// text is preserved separately in `metadata.original_text` (written by the
/// coordinator), so prefer it for the replayed `Text` block and fall back to
/// `content` only when that field is absent. Any residual image placeholder
/// paragraphs (e.g. image-only turns where the original text *is* the
/// placeholder) are stripped so the client never sees the internal marker.
///
/// Image attachments live in `metadata.images` (written by the coordinator
/// when a turn is started with image contexts). Text is emitted first, then
/// one `Image` block per stored image. The original streaming interleaving of
/// text and images is not preserved in storage, so it cannot be reconstructed
/// here.
fn user_message_blocks(user_message: &UserMessageData) -> Vec<ContentBlock> {
    let mut blocks = Vec::new();

    let source_text = user_message
        .metadata
        .as_ref()
        .and_then(|metadata| metadata.get("original_text"))
        .and_then(serde_json::Value::as_str)
        .filter(|text| !text.trim().is_empty())
        .unwrap_or(&user_message.content);

    let user_text = strip_image_placeholders(&strip_remote_user_input_tags(source_text));
    if !user_text.trim().is_empty() {
        blocks.push(ContentBlock::Text(TextContent::new(user_text)));
    }

    if let Some(images) = user_message
        .metadata
        .as_ref()
        .and_then(|metadata| metadata.get("images"))
        .and_then(serde_json::Value::as_array)
    {
        for image in images {
            if let Some(block) = image_block_from_metadata(image) {
                blocks.push(block);
            }
        }
    }

    blocks
}

/// Reconstruct an ACP `ContentBlock::Image` from a stored image metadata entry.
///
/// Stored entries (see `coordinator::start_dialog_turn_internal`) carry `id`,
/// `name`, `mime_type`, and either a `data_url` (`data:{mime};base64,{payload}`)
/// or an `image_path` referencing a local file. Entries with neither payload
/// are skipped, since an image block with no resolvable bytes is useless to the
/// client.
fn image_block_from_metadata(image: &serde_json::Value) -> Option<ContentBlock> {
    let mime_type = image
        .get("mime_type")
        .and_then(serde_json::Value::as_str)
        .unwrap_or("image/png");

    if let Some(data_url) = image.get("data_url").and_then(serde_json::Value::as_str) {
        if let Some((mime, data)) = split_data_url(data_url) {
            return Some(ContentBlock::Image(ImageContent::new(
                data,
                if mime.is_empty() {
                    mime_type.to_string()
                } else {
                    mime
                },
            )));
        }
    }

    if let Some(image_path) = image.get("image_path").and_then(serde_json::Value::as_str) {
        if !image_path.trim().is_empty() {
            // Match the URI-only round-trip the live path accepts: empty `data`
            // plus a `file://` URI that the client/runtime resolves to a path.
            return Some(ContentBlock::Image(
                ImageContent::new(String::new(), mime_type).uri(format!("file://{}", image_path)),
            ));
        }
    }

    None
}

/// Split a `data:{mime};base64,{payload}` URL into its mime type and base64
/// payload. Returns `None` for malformed data URLs.
fn split_data_url(data_url: &str) -> Option<(String, String)> {
    let body = data_url.strip_prefix("data:")?;
    let (header, payload) = body.split_once(',')?;
    let (mime, _) = header.split_once(';').unwrap_or((header, ""));
    Some((mime.to_string(), payload.to_string()))
}

/// Drop the internal image-attachment placeholder paragraphs that
/// `content::parse_prompt_blocks` injects into the model-facing user text
/// (e.g. `[Attached image: …]`, `[Attached image resource: …]`). They are
/// stand-ins for `Image` blocks that are replayed separately from
/// `metadata.images`, so any leftover occurrence is pure noise.
///
/// Operates paragraph-by-paragraph so surrounding user text survives even if a
/// placeholder somehow lands mid-message; a bare placeholder-only message
/// collapses to an empty string.
fn strip_image_placeholders(content: &str) -> String {
    content
        .split("\n\n")
        .filter(|paragraph| {
            let trimmed = paragraph.trim();
            !trimmed.starts_with("[Attached image:")
                && !trimmed.starts_with("[Attached image resource:")
        })
        .collect::<Vec<_>>()
        .join("\n\n")
}

/// Strip the `<remote_user_input>` wrapper tags that the remote-connect layer
/// records around user messages so the replayed user text is clean.
fn strip_remote_user_input_tags(content: &str) -> String {
    const OPEN: &str = "<remote_user_input>";
    const CLOSE: &str = "</remote_user_input>";

    let trimmed = content.trim();
    let inner = trimmed
        .strip_prefix(OPEN)
        .and_then(|rest| rest.strip_suffix(CLOSE))
        .map(|inner| inner.trim())
        .unwrap_or(trimmed);

    inner.to_string()
}

#[cfg(test)]
mod tests {
    use super::*;
    use openbitfun_core::service::session::{
        DialogTurnData, DialogTurnKind, ModelRoundData, TextItemData, ThinkingItemData,
        ToolCallData, ToolItemData, UserMessageData,
    };
    use serde_json::json;

    fn text_item(id: &str, content: &str, order_index: Option<usize>) -> TextItemData {
        TextItemData {
            id: id.to_string(),
            content: content.to_string(),
            is_streaming: false,
            timestamp: 0,
            is_markdown: true,
            order_index,
            is_subagent_item: None,
            parent_task_tool_id: None,
            subagent_session_id: None,
            status: None,
            attempt_id: None,
            attempt_index: None,
        }
    }

    fn thinking_item(id: &str, content: &str, order_index: Option<usize>) -> ThinkingItemData {
        ThinkingItemData {
            id: id.to_string(),
            content: content.to_string(),
            reasoning_kind: None,
            is_streaming: false,
            is_collapsed: false,
            timestamp: 0,
            order_index,
            status: None,
            is_subagent_item: None,
            parent_task_tool_id: None,
            subagent_session_id: None,
            attempt_id: None,
            attempt_index: None,
        }
    }

    fn tool_item(id: &str, name: &str, order_index: Option<usize>) -> ToolItemData {
        ToolItemData {
            id: id.to_string(),
            tool_name: name.to_string(),
            tool_call: ToolCallData {
                input: serde_json::json!({ "path": "a.txt" }),
                id: id.to_string(),
            },
            tool_result: None,
            ai_intent: None,
            start_time: 0,
            end_time: None,
            duration_ms: None,
            queue_wait_ms: None,
            preflight_ms: None,
            confirmation_wait_ms: None,
            execution_ms: None,
            order_index,
            is_subagent_item: None,
            parent_task_tool_id: None,
            subagent_session_id: None,
            subagent_dialog_turn_id: None,
            attempt_id: None,
            attempt_index: None,
            subagent_model_id: None,
            subagent_model_display_name: None,
            status: None,
            interruption_reason: None,
        }
    }

    fn round_with(
        text: Vec<TextItemData>,
        tools: Vec<ToolItemData>,
        thinking: Vec<ThinkingItemData>,
    ) -> ModelRoundData {
        ModelRoundData {
            id: "r1".to_string(),
            turn_id: "t1".to_string(),
            round_index: 0,
            round_group_id: None,
            timestamp: 0,
            text_items: text,
            tool_items: tools,
            thinking_items: thinking,
            start_time: 0,
            end_time: None,
            duration_ms: None,
            provider_id: None,
            model_config_id: None,
            effective_model_name: None,
            routing: None,
            first_chunk_ms: None,
            first_visible_output_ms: None,
            stream_duration_ms: None,
            ttft_ms: None,
            attempt_count: None,
            attempt_diagnostics: vec![],
            failure_category: None,
            token_details: None,
            status: "completed".to_string(),
        }
    }

    fn turn_with(kind: DialogTurnKind, content: &str, round: ModelRoundData) -> DialogTurnData {
        let mut turn = DialogTurnData::new_with_kind(
            kind,
            "turn-1".to_string(),
            0,
            "session-1".to_string(),
            None,
            UserMessageData {
                id: "u1".to_string(),
                content: content.to_string(),
                timestamp: 0,
                metadata: None,
            },
        );
        turn.model_rounds = vec![round];
        turn
    }

    #[test]
    fn order_round_items_interleaves_by_order_index() {
        let round = round_with(
            vec![
                text_item("text-after", "after", Some(2)),
                text_item("text-before", "before", Some(0)),
            ],
            vec![tool_item("tool", "Read", Some(1))],
            vec![thinking_item("think", "hmm", Some(3))],
        );

        let ordered = order_round_items(&round);
        let labels: Vec<&str> = ordered
            .iter()
            .map(|item| match item {
                OrderedRoundItem::Text(item) => item.id.as_str(),
                OrderedRoundItem::Thinking(item) => item.id.as_str(),
                OrderedRoundItem::Tool(item) => item.id.as_str(),
            })
            .collect();

        assert_eq!(labels, vec!["text-before", "tool", "text-after", "think"]);
    }

    #[test]
    fn order_round_items_defaults_missing_order_index_to_zero() {
        let round = round_with(
            vec![text_item("text", "hi", None)],
            vec![tool_item("tool", "Read", None)],
            vec![],
        );

        // Both items have order_index None -> 0; sort is stable, no panic.
        let ordered = order_round_items(&round);
        assert_eq!(ordered.len(), 2);
    }

    #[test]
    fn strip_remote_user_input_tags_removes_wrapper() {
        assert_eq!(
            strip_remote_user_input_tags("<remote_user_input>hello</remote_user_input>"),
            "hello"
        );
        assert_eq!(strip_remote_user_input_tags("plain text"), "plain text");
        assert_eq!(
            strip_remote_user_input_tags("  <remote_user_input>  spaced  </remote_user_input>  "),
            "spaced"
        );
    }

    fn user_message_with(content: &str, metadata: Option<serde_json::Value>) -> UserMessageData {
        UserMessageData {
            id: "u1".to_string(),
            content: content.to_string(),
            timestamp: 0,
            metadata,
        }
    }

    #[test]
    fn user_message_blocks_emits_text_only_without_image_metadata() {
        let msg = user_message_with("hello", None);
        let blocks = user_message_blocks(&msg);
        assert_eq!(blocks.len(), 1);
        match &blocks[0] {
            ContentBlock::Text(text) => assert_eq!(text.text, "hello"),
            other => panic!("expected Text block, got {other:?}"),
        }
    }

    #[test]
    fn user_message_blocks_skips_empty_text() {
        let msg = user_message_with(
            "   ",
            Some(json!({ "images": [{ "data_url": "data:image/png;base64,abc" }] })),
        );
        let blocks = user_message_blocks(&msg);
        assert_eq!(blocks.len(), 1);
        assert!(matches!(blocks[0], ContentBlock::Image(_)));
    }

    #[test]
    fn user_message_blocks_reconstructs_image_from_data_url() {
        let msg = user_message_with(
            "describe this",
            Some(json!({
                "images": [{
                    "id": "img-1",
                    "name": "clip.png",
                    "mime_type": "image/png",
                    "data_url": "data:image/png;base64,QkFNDQ=="
                }]
            })),
        );
        let blocks = user_message_blocks(&msg);
        assert_eq!(blocks.len(), 2);
        assert!(matches!(blocks[0], ContentBlock::Text(_)));
        match &blocks[1] {
            ContentBlock::Image(image) => {
                assert_eq!(image.data, "QkFNDQ==");
                assert_eq!(image.mime_type, "image/png");
                assert!(image.uri.is_none());
            }
            other => panic!("expected Image block, got {other:?}"),
        }
    }

    #[test]
    fn user_message_blocks_reconstructs_image_from_path() {
        let msg = user_message_with(
            "see attached",
            Some(json!({
                "images": [{
                    "id": "img-2",
                    "mime_type": "image/jpeg",
                    "image_path": "/workspace/clip.jpg"
                }]
            })),
        );
        let blocks = user_message_blocks(&msg);
        assert_eq!(blocks.len(), 2);
        match &blocks[1] {
            ContentBlock::Image(image) => {
                assert_eq!(image.mime_type, "image/jpeg");
                assert_eq!(image.uri.as_deref(), Some("file:///workspace/clip.jpg"));
                assert!(image.data.is_empty());
            }
            other => panic!("expected Image block, got {other:?}"),
        }
    }

    #[test]
    fn user_message_blocks_skips_image_with_no_payload() {
        let msg = user_message_with(
            "no real image",
            Some(json!({ "images": [{ "id": "img-3", "mime_type": "image/png" }] })),
        );
        let blocks = user_message_blocks(&msg);
        assert_eq!(blocks.len(), 1);
        assert!(matches!(blocks[0], ContentBlock::Text(_)));
    }

    #[test]
    fn user_message_blocks_defaults_mime_type_when_missing() {
        let msg = user_message_with(
            "",
            Some(json!({ "images": [{ "data_url": "data:;base64,abc" }] })),
        );
        let blocks = user_message_blocks(&msg);
        assert_eq!(blocks.len(), 1);
        match &blocks[0] {
            ContentBlock::Image(image) => {
                assert_eq!(image.data, "abc");
                assert_eq!(image.mime_type, "image/png");
            }
            other => panic!("expected Image block, got {other:?}"),
        }
    }

    #[test]
    fn user_message_blocks_prefers_original_text_over_placeholder_content() {
        // `content` carries the model-facing placeholder; `original_text`
        // holds the user's real text. Replay must surface the real text.
        let msg = user_message_with(
            "describe this\n\n[Attached image: acp_image_s1_0]",
            Some(json!({
                "original_text": "describe this",
                "images": [{ "id": "acp_image_s1_0", "data_url": "data:image/png;base64,QQ==" }]
            })),
        );
        let blocks = user_message_blocks(&msg);
        assert_eq!(blocks.len(), 2);
        match &blocks[0] {
            ContentBlock::Text(text) => assert_eq!(text.text, "describe this"),
            other => panic!("expected Text block, got {other:?}"),
        }
        assert!(matches!(blocks[1], ContentBlock::Image(_)));
    }

    #[test]
    fn user_message_blocks_strips_placeholder_when_original_text_missing() {
        // Image-only turn: no `original_text`, so `content` itself is the
        // placeholder. Replay emits only the Image block, never the marker.
        let msg = user_message_with(
            "[Attached image: acp_image_s1_0]",
            Some(json!({
                "images": [{ "id": "acp_image_s1_0", "data_url": "data:image/png;base64,QQ==" }]
            })),
        );
        let blocks = user_message_blocks(&msg);
        assert_eq!(blocks.len(), 1);
        assert!(matches!(blocks[0], ContentBlock::Image(_)));
    }

    #[test]
    fn user_message_blocks_preserves_surrounding_text_around_placeholder() {
        // If a placeholder slips into `original_text` (shouldn't happen, but
        // defense in depth), keep the user's real prose and drop only the
        // marker paragraph.
        let msg = user_message_with(
            "see this\n\n[Attached image: acp_image_s1_0]\n\nand describe",
            Some(json!({
                "original_text": "see this\n\n[Attached image: acp_image_s1_0]\n\nand describe",
                "images": [{ "id": "acp_image_s1_0", "data_url": "data:image/png;base64,QQ==" }]
            })),
        );
        let blocks = user_message_blocks(&msg);
        assert_eq!(blocks.len(), 2);
        match &blocks[0] {
            ContentBlock::Text(text) => assert_eq!(text.text, "see this\n\nand describe"),
            other => panic!("expected Text block, got {other:?}"),
        }
    }

    #[test]
    fn strip_image_placeholders_removes_marker_paragraphs() {
        assert_eq!(strip_image_placeholders("hello"), "hello");
        assert_eq!(
            strip_image_placeholders("hello\n\n[Attached image: foo]\n\nworld"),
            "hello\n\nworld"
        );
        assert_eq!(
            strip_image_placeholders("[Attached image resource: bar]"),
            ""
        );
        // Marker text only partially matching the prefix is left alone.
        assert_eq!(
            strip_image_placeholders("[Attached image"),
            "[Attached image"
        );
    }

    #[test]
    fn split_data_url_parses_well_formed_url() {
        let (mime, data) = split_data_url("data:image/png;base64,QkFN").unwrap();
        assert_eq!(mime, "image/png");
        assert_eq!(data, "QkFN");
    }

    #[test]
    fn split_data_url_rejects_malformed() {
        assert!(split_data_url("not-a-data-url").is_none());
        assert!(split_data_url("data:image/png;base64").is_none()); // no comma
    }

    #[test]
    fn is_model_visible_gates_user_dialog_only() {
        assert!(DialogTurnKind::UserDialog.is_model_visible());
        assert!(!DialogTurnKind::ManualCompaction.is_model_visible());
        assert!(!DialogTurnKind::LocalCommand.is_model_visible());
    }

    #[test]
    fn dialog_turn_kind_default_is_user_dialog() {
        assert_eq!(DialogTurnKind::default(), DialogTurnKind::UserDialog);
    }

    #[test]
    fn local_command_turn_is_not_model_visible() {
        let turn = turn_with(
            DialogTurnKind::LocalCommand,
            "ignored",
            round_with(vec![text_item("t1", "agent text", Some(0))], vec![], vec![]),
        );
        assert!(!turn.kind.is_model_visible());
        // Round items still orderable without panic even on non-visible turns.
        let _ = order_round_items(&turn.model_rounds[0]);
    }
}
