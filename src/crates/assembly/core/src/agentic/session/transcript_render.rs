use crate::agentic::core::strip_prompt_markup;
use crate::service::session::{
    DialogTurnData, ModelRoundData, SessionTranscriptExportOptions, SessionTranscriptIndexEntry,
    ToolItemData, ToolItemIdentityExt, TranscriptLineRange,
};
use crate::util::errors::{OpenBitFunError, OpenBitFunResult};
use serde::Serialize;
use sha2::{Digest, Sha256};

const SESSION_TRANSCRIPT_PREVIEW_CHAR_LIMIT: usize = 120;

#[derive(Debug, Clone)]
struct TranscriptToolBlock {
    tool_name: String,
    tool_input: Option<String>,
    result: Option<String>,
}

#[derive(Debug, Clone)]
enum TranscriptRoundBlock {
    Thinking(String),
    Assistant(String),
    Tool(TranscriptToolBlock),
}

#[derive(Debug, Clone)]
struct TranscriptRoundData {
    round_index: usize,
    blocks: Vec<TranscriptRoundBlock>,
}

fn transcript_text_lines(content: &str) -> Vec<String> {
    if content.is_empty() {
        return vec!["(empty)".to_string()];
    }

    let lines = content
        .lines()
        .map(|line| line.to_string())
        .collect::<Vec<_>>();
    if lines.is_empty() {
        vec!["(empty)".to_string()]
    } else {
        lines
    }
}

pub(crate) fn transcript_value_string(value: &serde_json::Value) -> String {
    match value {
        serde_json::Value::String(text) => text.clone(),
        _ => serde_json::to_string_pretty(value).unwrap_or_else(|_| value.to_string()),
    }
}

fn transcript_tool_input(item: &ToolItemData, tool_inputs: bool) -> Option<String> {
    if !tool_inputs || item.effective_input().is_null() {
        return None;
    }

    Some(transcript_value_string(item.effective_input()))
}

fn transcript_tool_result(item: &ToolItemData) -> Option<String> {
    item.tool_result.as_ref().and_then(|result| {
        result
            .result_for_assistant
            .as_ref()
            .map(|value| value.trim().to_string())
            .filter(|value| !value.is_empty())
            .or_else(|| {
                if result.result.is_null() {
                    None
                } else {
                    Some(transcript_value_string(&result.result))
                }
            })
    })
}

pub(crate) fn transcript_display_user_content(turn: &DialogTurnData) -> String {
    turn.user_message
        .metadata
        .as_ref()
        .and_then(|metadata| metadata.get("original_text"))
        .and_then(|value| value.as_str())
        .map(str::to_string)
        .unwrap_or_else(|| strip_prompt_markup(&turn.user_message.content))
}

/// Returns the last visible assistant response from the effective model
/// attempt. Intermediate tool rounds and private subagent output are excluded.
pub(crate) fn transcript_final_assistant_content(turn: &DialogTurnData) -> Option<String> {
    transcript_round_blocks(turn, &SessionTranscriptExportOptions::default())
        .into_iter()
        .rev()
        .find_map(|round| {
            round.blocks.into_iter().find_map(|block| match block {
                TranscriptRoundBlock::Assistant(content) => Some(content),
                TranscriptRoundBlock::Thinking(_) | TranscriptRoundBlock::Tool(_) => None,
            })
        })
}

/// Final visible assistant prose for product search and other read-only views.
/// Thinking, tool inputs/results, superseded attempts, and subagent items are
/// excluded by the same transcript projection used for exports.
#[cfg(feature = "product-search")]
pub(crate) fn transcript_display_assistant_content(turn: &DialogTurnData) -> String {
    transcript_round_blocks(turn, &SessionTranscriptExportOptions::default())
        .into_iter()
        .flat_map(|round| round.blocks)
        .filter_map(|block| match block {
            TranscriptRoundBlock::Assistant(content) => Some(content),
            TranscriptRoundBlock::Thinking(_) | TranscriptRoundBlock::Tool(_) => None,
        })
        .collect::<Vec<_>>()
        .join("\n\n")
}

fn effective_attempt_index(round: &ModelRoundData) -> Option<u32> {
    round
        .text_items
        .iter()
        .filter_map(|item| item.attempt_index)
        .chain(
            round
                .thinking_items
                .iter()
                .filter_map(|item| item.attempt_index),
        )
        .chain(
            round
                .tool_items
                .iter()
                .filter_map(|item| item.attempt_index),
        )
        .max()
}

fn is_effective_attempt(attempt_index: Option<u32>, effective_attempt_index: Option<u32>) -> bool {
    effective_attempt_index
        .map(|effective| attempt_index == Some(effective))
        .unwrap_or(true)
}

fn transcript_round_blocks(
    turn: &DialogTurnData,
    options: &SessionTranscriptExportOptions,
) -> Vec<TranscriptRoundData> {
    turn.model_rounds
        .iter()
        .filter_map(|round| {
            let effective_attempt_index = effective_attempt_index(round);
            let thinking_content = if options.thinking {
                round
                    .thinking_items
                    .iter()
                    .filter(|item| {
                        is_effective_attempt(item.attempt_index, effective_attempt_index)
                    })
                    .filter(|item| !item.is_subagent_item.unwrap_or(false))
                    .map(|item| item.content.trim())
                    .filter(|value| !value.is_empty())
                    .collect::<Vec<_>>()
                    .join("\n\n")
            } else {
                String::new()
            };

            let assistant_content = round
                .text_items
                .iter()
                .filter(|item| is_effective_attempt(item.attempt_index, effective_attempt_index))
                .filter(|item| !item.is_subagent_item.unwrap_or(false))
                .map(|item| item.content.trim())
                .filter(|value| !value.is_empty())
                .collect::<Vec<_>>()
                .join("\n\n");

            let tool_blocks = if options.tools {
                round
                    .tool_items
                    .iter()
                    .filter(|item| {
                        is_effective_attempt(item.attempt_index, effective_attempt_index)
                    })
                    .filter(|item| !item.is_subagent_item.unwrap_or(false))
                    .map(|item| TranscriptToolBlock {
                        tool_name: item.effective_name().to_string(),
                        tool_input: transcript_tool_input(item, options.tool_inputs),
                        result: transcript_tool_result(item),
                    })
                    .collect::<Vec<_>>()
            } else {
                Vec::new()
            };

            if thinking_content.is_empty() && assistant_content.is_empty() && tool_blocks.is_empty()
            {
                return None;
            }

            let mut blocks = Vec::new();
            if !thinking_content.is_empty() {
                blocks.push(TranscriptRoundBlock::Thinking(thinking_content));
            }
            if !assistant_content.is_empty() {
                blocks.push(TranscriptRoundBlock::Assistant(assistant_content));
            }
            for tool in tool_blocks {
                blocks.push(TranscriptRoundBlock::Tool(tool));
            }

            Some(TranscriptRoundData {
                round_index: round.round_index,
                blocks,
            })
        })
        .collect()
}

#[derive(Debug)]
pub(crate) struct RenderedTranscript {
    pub(crate) lines: Vec<String>,
    pub(crate) index_range: TranscriptLineRange,
    pub(crate) index: Vec<SessionTranscriptIndexEntry>,
}

#[derive(Debug, Clone, Serialize)]
struct TranscriptFingerprintPayload {
    session_id: String,
    tools: bool,
    tool_inputs: bool,
    thinking: bool,
    turn_selectors: Option<Vec<String>>,
    turns: Vec<TranscriptFingerprintTurn>,
}

#[derive(Debug, Clone, Serialize)]
struct TranscriptFingerprintTurn {
    turn_id: String,
    turn_index: usize,
    status: String,
    user: String,
    assistant: Vec<TranscriptFingerprintTextBlock>,
    tools: Vec<TranscriptFingerprintTool>,
    thinking: Vec<TranscriptFingerprintTextBlock>,
}

#[derive(Debug, Clone, Serialize)]
struct TranscriptFingerprintTextBlock {
    round_index: usize,
    content: String,
}

#[derive(Debug, Clone, Serialize)]
struct TranscriptFingerprintTool {
    tool_name: String,
    tool_input: Option<String>,
    result: Option<String>,
}

#[derive(Debug, Clone)]
struct TranscriptSectionData {
    turn_index: usize,
    preview: String,
    lines: Vec<String>,
    turn_range: TranscriptLineRange,
    user_range: TranscriptLineRange,
}

fn turn_status_label(status: &crate::service::session::TurnStatus) -> &'static str {
    match status {
        crate::service::session::TurnStatus::InProgress => "inprogress",
        crate::service::session::TurnStatus::Completed => "completed",
        crate::service::session::TurnStatus::Error => "error",
        crate::service::session::TurnStatus::Cancelled => "cancelled",
    }
}

fn transcript_preview(content: &str) -> String {
    let normalized = content.split_whitespace().collect::<Vec<_>>().join(" ");
    if normalized.is_empty() {
        return "(empty user message)".to_string();
    }

    let mut preview: String = normalized
        .chars()
        .take(SESSION_TRANSCRIPT_PREVIEW_CHAR_LIMIT)
        .collect();
    if normalized.chars().count() > SESSION_TRANSCRIPT_PREVIEW_CHAR_LIMIT {
        preview.push_str("...");
    }
    preview
}

fn transcript_fingerprint_turn(
    turn: &DialogTurnData,
    options: &SessionTranscriptExportOptions,
) -> TranscriptFingerprintTurn {
    let mut assistant = Vec::new();
    let mut tools = Vec::new();
    let mut thinking = Vec::new();

    for round in transcript_round_blocks(turn, options) {
        let round_index = round.round_index;
        for block in round.blocks {
            match block {
                TranscriptRoundBlock::Thinking(content) => {
                    thinking.push(TranscriptFingerprintTextBlock {
                        round_index,
                        content,
                    });
                }
                TranscriptRoundBlock::Assistant(content) => {
                    assistant.push(TranscriptFingerprintTextBlock {
                        round_index,
                        content,
                    });
                }
                TranscriptRoundBlock::Tool(tool) => {
                    tools.push(TranscriptFingerprintTool {
                        tool_name: tool.tool_name,
                        tool_input: tool.tool_input,
                        result: tool.result,
                    });
                }
            }
        }
    }

    TranscriptFingerprintTurn {
        turn_id: turn.turn_id.clone(),
        turn_index: turn.turn_index,
        status: turn_status_label(&turn.status).to_string(),
        user: transcript_display_user_content(turn),
        assistant,
        tools,
        thinking,
    }
}

pub(crate) fn transcript_fingerprint(
    session_id: &str,
    turns: &[DialogTurnData],
    options: &SessionTranscriptExportOptions,
) -> OpenBitFunResult<String> {
    let payload = TranscriptFingerprintPayload {
        session_id: session_id.to_string(),
        tools: options.tools,
        tool_inputs: options.tool_inputs,
        thinking: options.thinking,
        turn_selectors: options.turns.clone(),
        turns: turns
            .iter()
            .map(|turn| transcript_fingerprint_turn(turn, options))
            .collect(),
    };

    let bytes = serde_json::to_vec(&payload).map_err(|e| {
        OpenBitFunError::serialization(format!("Failed to serialize transcript fingerprint: {}", e))
    })?;
    let mut hasher = Sha256::new();
    hasher.update(bytes);
    Ok(format!("{:x}", hasher.finalize()))
}

fn push_transcript_block(
    lines: &mut Vec<String>,
    label: &str,
    body_lines: Vec<String>,
) -> TranscriptLineRange {
    let start_line = lines.len() + 1;
    lines.push(format!("[{}]", label));
    lines.extend(body_lines);
    lines.push(format!("[/{}]", label));
    TranscriptLineRange {
        start_line,
        end_line: lines.len(),
    }
}

fn build_transcript_section(
    turn: &DialogTurnData,
    options: &SessionTranscriptExportOptions,
) -> TranscriptSectionData {
    let user_content = transcript_display_user_content(turn);
    let round_blocks = transcript_round_blocks(turn, options);

    let mut lines = Vec::new();
    lines.push(format!("## Turn {}", turn.turn_index));

    let user_range =
        push_transcript_block(&mut lines, "user", transcript_text_lines(&user_content));

    for round in &round_blocks {
        lines.push(format!("[assistant step={}]", round.round_index));
        for block in &round.blocks {
            match block {
                TranscriptRoundBlock::Thinking(content) => {
                    lines.push("[thinking]".to_string());
                    lines.extend(transcript_text_lines(content));
                    lines.push("[/thinking]".to_string());
                }
                TranscriptRoundBlock::Assistant(content) => {
                    lines.extend(transcript_text_lines(content));
                }
                TranscriptRoundBlock::Tool(tool) => {
                    lines.push(format!("[tool name={}]", tool.tool_name));
                    if let Some(tool_input) = tool.tool_input.as_ref() {
                        lines.push("input:".to_string());
                        lines.extend(transcript_text_lines(tool_input));
                    }
                    if let Some(result) = tool.result.as_ref() {
                        lines.push("result:".to_string());
                        lines.extend(transcript_text_lines(result));
                    }
                    lines.push("[/tool]".to_string());
                }
            }
        }
        lines.push("[/assistant]".to_string());
    }

    TranscriptSectionData {
        turn_index: turn.turn_index,
        preview: transcript_preview(&user_content),
        turn_range: TranscriptLineRange {
            start_line: 1,
            end_line: lines.len(),
        },
        user_range,
        lines,
    }
}

/// The character contribution of one complete rendered turn, excluding the
/// shared index. Reference transcripts select whole turns from newest to
/// oldest against this value, then render the selected turns chronologically.
pub(crate) fn rendered_turn_char_count(
    turn: &DialogTurnData,
    options: &SessionTranscriptExportOptions,
) -> usize {
    build_transcript_section(turn, options)
        .lines
        .join("\n")
        .chars()
        .count()
}

fn offset_range(range: &TranscriptLineRange, offset: usize) -> TranscriptLineRange {
    TranscriptLineRange {
        start_line: range.start_line + offset,
        end_line: range.end_line + offset,
    }
}

fn format_range(range: &TranscriptLineRange) -> String {
    format!("{}-{}", range.start_line, range.end_line)
}

pub(crate) fn render_transcript(
    all_turns: &[DialogTurnData],
    selected_indices: &[usize],
    options: &SessionTranscriptExportOptions,
) -> RenderedTranscript {
    let sections = selected_indices
        .iter()
        .map(|&index| (index, build_transcript_section(&all_turns[index], options)))
        .collect::<Vec<_>>();

    let mut lines = vec!["## Index".to_string()];
    let mut index = Vec::with_capacity(sections.len());
    if sections.is_empty() {
        lines.push(if all_turns.is_empty() {
            "(no persisted turns)".to_string()
        } else {
            "(no matching turns)".to_string()
        });
    } else {
        let index_offset = lines.len() + sections.len() + 1;
        let mut body_lines = Vec::new();

        for (position, (source_index, section)) in sections.iter().enumerate() {
            let omitted_range = if position == 0 {
                (*source_index > 0).then(|| (0, *source_index - 1))
            } else {
                let previous_index = sections[position - 1].0;
                (*source_index > previous_index + 1)
                    .then(|| (previous_index + 1, *source_index - 1))
            };

            if let Some((start, end)) = omitted_range {
                if !body_lines.is_empty() {
                    body_lines.push(String::new());
                }
                body_lines.push(transcript_omitted_turns_label(all_turns, start, end));
                body_lines.push(String::new());
            } else if !body_lines.is_empty() {
                body_lines.push(String::new());
            }

            let section_offset = index_offset + body_lines.len();
            let turn_range = offset_range(&section.turn_range, section_offset);
            let user_range = offset_range(&section.user_range, section_offset);

            lines.push(format!(
                "- turn={} range={} preview=\"{}\"",
                section.turn_index,
                format_range(&turn_range),
                section.preview.replace('"', "'")
            ));
            index.push(SessionTranscriptIndexEntry {
                turn_index: section.turn_index,
                preview: section.preview.clone(),
                turn_range,
                user_range,
            });
            body_lines.extend(section.lines.iter().cloned());
        }

        if let Some((last_index, _)) = sections.last() {
            if *last_index + 1 < all_turns.len() {
                body_lines.push(String::new());
                body_lines.push(transcript_omitted_turns_label(
                    all_turns,
                    *last_index + 1,
                    all_turns.len() - 1,
                ));
            }
        }

        lines.push(String::new());
        lines.extend(body_lines);
    }

    let index_range = TranscriptLineRange {
        start_line: 1,
        end_line: lines
            .iter()
            .position(|line| line.is_empty())
            .unwrap_or(lines.len()),
    };
    RenderedTranscript {
        lines,
        index_range,
        index,
    }
}

fn transcript_omitted_turns_label(turns: &[DialogTurnData], start: usize, end: usize) -> String {
    let start_turn = turns[start].turn_index;
    let end_turn = turns[end].turn_index;
    if start_turn == end_turn {
        format!("(omitted turn {})", start_turn)
    } else {
        format!("(omitted turns {}-{})", start_turn, end_turn)
    }
}

#[cfg(all(test, feature = "product-search"))]
mod search_projection_tests {
    use super::*;
    use crate::service::session::{
        DialogTurnKind, TextItemData, ThinkingItemData, TurnStatus, UserMessageData,
    };

    fn text(id: &str, content: &str, attempt_index: u32, subagent: bool) -> TextItemData {
        TextItemData {
            id: id.to_string(),
            content: content.to_string(),
            is_streaming: false,
            timestamp: 1,
            is_markdown: true,
            order_index: None,
            is_subagent_item: Some(subagent),
            parent_task_tool_id: None,
            subagent_session_id: None,
            status: None,
            attempt_id: None,
            attempt_index: Some(attempt_index),
        }
    }

    #[test]
    fn search_projection_contains_only_final_visible_assistant_prose() {
        let round = ModelRoundData {
            id: "round_1".to_string(),
            turn_id: "turn_1".to_string(),
            round_index: 0,
            round_group_id: None,
            timestamp: 1,
            text_items: vec![
                text("old", "superseded private draft", 0, false),
                text("visible", "final visible answer", 1, false),
                text("subagent", "subagent private output", 1, true),
            ],
            tool_items: Vec::new(),
            thinking_items: vec![ThinkingItemData {
                id: "thinking".to_string(),
                content: "private reasoning".to_string(),
                reasoning_kind: None,
                is_streaming: false,
                is_collapsed: false,
                timestamp: 1,
                order_index: None,
                is_subagent_item: Some(false),
                parent_task_tool_id: None,
                subagent_session_id: None,
                status: None,
                attempt_id: None,
                attempt_index: Some(1),
            }],
            start_time: 1,
            end_time: Some(2),
            duration_ms: Some(1),
            provider_id: None,
            model_config_id: None,
            effective_model_name: None,
            routing: None,
            first_chunk_ms: None,
            first_visible_output_ms: None,
            stream_duration_ms: None,
            ttft_ms: None,
            attempt_count: Some(2),
            attempt_diagnostics: Vec::new(),
            failure_category: None,
            token_details: None,
            status: "completed".to_string(),
        };
        let turn = DialogTurnData {
            turn_id: "turn_1".to_string(),
            turn_index: 0,
            session_id: "session_1".to_string(),
            timestamp: 1,
            kind: DialogTurnKind::UserDialog,
            agent_type: Some("Standard".to_string()),
            user_message: UserMessageData {
                id: "user_1".to_string(),
                content: "question".to_string(),
                timestamp: 1,
                metadata: None,
            },
            model_rounds: vec![round],
            start_time: 1,
            end_time: Some(2),
            duration_ms: Some(1),
            token_usage: None,
            finish_reason: None,
            has_final_response: Some(true),
            error: None,
            error_detail: None,
            recovery: None,
            recovery_epoch: None,
            status: TurnStatus::Completed,
        };

        let content = transcript_display_assistant_content(&turn);
        assert_eq!(content, "final visible answer");
        assert!(!content.contains("private"));
        assert!(!content.contains("subagent"));

        let mut prior_round = turn.model_rounds[0].clone();
        prior_round.id = "round_0".to_string();
        prior_round.round_index = 0;
        prior_round.text_items = vec![text("intermediate", "intermediate answer", 0, false)];
        let mut final_turn = turn;
        final_turn.model_rounds[0].round_index = 1;
        final_turn.model_rounds.insert(0, prior_round);

        assert_eq!(
            transcript_final_assistant_content(&final_turn).as_deref(),
            Some("final visible answer")
        );
    }
}
