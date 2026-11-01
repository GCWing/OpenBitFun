use crate::agentic::memories::external_context::is_external_context_tool_name;
use crate::agentic::session::transcript_render::{
    transcript_display_user_content, transcript_value_string,
};
use crate::agentic::tools::registry::GET_TOOL_SPEC_TOOL_NAME;
use crate::service::config::types::MemoryExternalContextPolicy;
use crate::service::session::{DialogTurnData, ToolItemData, ToolItemIdentityExt};
use crate::util::errors::{OpenBitFunError, OpenBitFunResult};
use regex::Regex;
use serde::Serialize;
use serde_json::Value;
use std::sync::OnceLock;

const APPROX_BYTES_PER_TOKEN: usize = 4;
const MESSAGE_CONTENT_TOKEN_LIMIT: usize = 8_000;
const TOOL_INPUT_TOKEN_LIMIT: usize = 6_000;
const TOOL_RESULT_TOKEN_LIMIT: usize = 12_000;
const TOOL_ERROR_TOKEN_LIMIT: usize = 1_000;

#[derive(Debug, Clone, Serialize)]
#[serde(untagged)]
enum MemoryTranscriptMessage {
    User {
        role: &'static str,
        content: String,
    },
    Assistant {
        role: &'static str,
        content: String,
        #[serde(skip_serializing_if = "Vec::is_empty")]
        tool_calls: Vec<MemoryTranscriptToolCall>,
    },
    Tool {
        role: &'static str,
        name: String,
        tool_call_id: String,
        content: String,
    },
}

#[derive(Debug, Clone, Serialize)]
struct MemoryTranscriptToolCall {
    id: String,
    #[serde(rename = "type")]
    kind: &'static str,
    function: MemoryTranscriptToolFunction,
}

#[derive(Debug, Clone, Serialize)]
struct MemoryTranscriptToolFunction {
    name: String,
    arguments: String,
}

pub(crate) fn render_memory_phase1_transcript(
    turns: &[DialogTurnData],
    token_limit: usize,
    external_context_policy: MemoryExternalContextPolicy,
) -> OpenBitFunResult<String> {
    let items = collect_memory_transcript_items(turns, external_context_policy);
    if items.is_empty() {
        return Ok(String::new());
    }

    let serialized = serde_json::to_string(&items).map_err(|error| {
        OpenBitFunError::serialization(format!(
            "Failed to serialize memory phase1 transcript: {}",
            error
        ))
    })?;
    Ok(truncate_middle_tokens(
        &redact_memory_secrets(&serialized),
        token_limit,
    ))
}

pub(crate) fn redact_memory_secrets(text: &str) -> String {
    let mut redacted = text.to_string();
    for (regex, replacement) in secret_redaction_rules() {
        redacted = regex.replace_all(&redacted, *replacement).into_owned();
    }
    redacted
}

fn collect_memory_transcript_items(
    turns: &[DialogTurnData],
    external_context_policy: MemoryExternalContextPolicy,
) -> Vec<MemoryTranscriptMessage> {
    let mut messages = Vec::new();
    for turn in turns {
        if !turn.kind.is_model_visible() {
            continue;
        }

        let user_content = transcript_display_user_content(turn);
        if !user_content.trim().is_empty() {
            messages.push(MemoryTranscriptMessage::User {
                role: "user",
                content: truncate_middle_tokens(user_content.trim(), MESSAGE_CONTENT_TOKEN_LIMIT),
            });
        }

        for round in &turn.model_rounds {
            let assistant_content = round
                .text_items
                .iter()
                .filter(|item| !item.is_subagent_item.unwrap_or(false))
                .map(|item| item.content.trim())
                .filter(|value| !value.is_empty())
                .collect::<Vec<_>>()
                .join("\n\n");
            let tools = round
                .tool_items
                .iter()
                .filter(|item| !item.is_subagent_item.unwrap_or(false))
                .collect::<Vec<_>>();
            let tool_calls = tools
                .iter()
                .map(|tool| MemoryTranscriptToolCall {
                    id: tool_call_id(tool),
                    kind: "function",
                    function: MemoryTranscriptToolFunction {
                        name: tool.effective_name().to_string(),
                        arguments: serialize_tool_arguments(tool.effective_input()),
                    },
                })
                .collect::<Vec<_>>();
            if !assistant_content.is_empty() || !tool_calls.is_empty() {
                messages.push(MemoryTranscriptMessage::Assistant {
                    role: "assistant",
                    content: truncate_middle_tokens(
                        &assistant_content,
                        MESSAGE_CONTENT_TOKEN_LIMIT,
                    ),
                    tool_calls,
                });
            }

            for tool in tools {
                if let Some(result) = tool.tool_result.as_ref() {
                    messages.push(MemoryTranscriptMessage::Tool {
                        role: "tool",
                        name: tool.effective_name().to_string(),
                        tool_call_id: tool_call_id(tool),
                        content: truncate_middle_tokens(
                            &memory_tool_result_content(
                                tool,
                                result.success,
                                external_context_policy,
                            ),
                            TOOL_RESULT_TOKEN_LIMIT,
                        ),
                    });
                }
            }
        }
    }
    messages
}

fn tool_call_id(tool: &ToolItemData) -> String {
    if tool.tool_call.id.trim().is_empty() {
        tool.id.clone()
    } else {
        tool.tool_call.id.clone()
    }
}

fn serialize_tool_arguments(input: &Value) -> String {
    let input = truncate_json_value(input, TOOL_INPUT_TOKEN_LIMIT);
    serde_json::to_string(&input).unwrap_or_else(|_| "{}".to_string())
}

fn memory_tool_result_content(
    tool: &ToolItemData,
    success: bool,
    external_context_policy: MemoryExternalContextPolicy,
) -> String {
    let Some(result) = tool.tool_result.as_ref() else {
        return String::new();
    };
    if tool.effective_name() == GET_TOOL_SPEC_TOOL_NAME {
        return "[cleared]".to_string();
    }
    if external_context_policy == MemoryExternalContextPolicy::ClearToolResults
        && is_external_context_tool_name(tool.effective_name())
    {
        return "[external tool result cleared]".to_string();
    }

    let content = if let Some(text) = result
        .result_for_assistant
        .as_ref()
        .map(|value| value.trim())
        .filter(|value| !value.is_empty())
    {
        text.to_string()
    } else {
        transcript_value_string(&result.result)
    };

    let error = result
        .error
        .as_deref()
        .map(str::trim)
        .filter(|value| !value.is_empty())
        .map(|value| truncate_middle_tokens(value, TOOL_ERROR_TOKEN_LIMIT));
    if success {
        content
    } else {
        match error {
            None => content,
            Some(error) if content.trim().is_empty() => format!("Tool failed: {}", error),
            Some(error) => format!("Tool failed: {}\n\n{}", error, content),
        }
    }
}

fn truncate_json_value(value: &Value, token_limit: usize) -> Value {
    let serialized = serde_json::to_string(value).unwrap_or_else(|_| value.to_string());
    if approx_token_count(&serialized) <= token_limit {
        return value.clone();
    }

    match value {
        Value::String(text) => Value::String(truncate_middle_tokens(text, token_limit)),
        _ => serde_json::json!({
            "truncated": true,
            "preview": truncate_middle_tokens(&serialized, token_limit),
        }),
    }
}

fn truncate_middle_tokens(text: &str, token_limit: usize) -> String {
    if text.is_empty() {
        return String::new();
    }

    let byte_limit = token_limit.saturating_mul(APPROX_BYTES_PER_TOKEN);
    if byte_limit == 0 {
        return format_truncation_marker(approx_token_count(text));
    }
    if text.len() <= byte_limit {
        text.to_string()
    } else {
        truncate_middle_bytes(text, byte_limit)
    }
}

fn truncate_middle_bytes(text: &str, byte_limit: usize) -> String {
    let marker = format_truncation_marker(approx_tokens_from_byte_count(
        text.len().saturating_sub(byte_limit),
    ));
    if byte_limit <= marker.len() {
        return marker;
    }

    let content_budget = byte_limit.saturating_sub(marker.len());
    let head_budget = content_budget / 2;
    let tail_budget = content_budget.saturating_sub(head_budget);
    let head_end = previous_char_boundary(text, head_budget);
    let tail_start = next_char_boundary(text, text.len().saturating_sub(tail_budget));

    format!("{}{}{}", &text[..head_end], marker, &text[tail_start..])
}

fn format_truncation_marker(removed_tokens: usize) -> String {
    format!("…{} tokens truncated…", removed_tokens)
}

fn approx_token_count(text: &str) -> usize {
    approx_tokens_from_byte_count(text.len())
}

fn approx_tokens_from_byte_count(bytes: usize) -> usize {
    bytes.saturating_add(APPROX_BYTES_PER_TOKEN.saturating_sub(1)) / APPROX_BYTES_PER_TOKEN
}

fn previous_char_boundary(text: &str, max_bytes: usize) -> usize {
    if max_bytes >= text.len() {
        return text.len();
    }
    let mut index = max_bytes;
    while index > 0 && !text.is_char_boundary(index) {
        index -= 1;
    }
    index
}

fn next_char_boundary(text: &str, min_bytes: usize) -> usize {
    if min_bytes >= text.len() {
        return text.len();
    }
    let mut index = min_bytes;
    while index < text.len() && !text.is_char_boundary(index) {
        index += 1;
    }
    index
}

fn secret_redaction_rules() -> &'static [(Regex, &'static str)] {
    static RULES: OnceLock<Vec<(Regex, &'static str)>> = OnceLock::new();
    RULES.get_or_init(|| {
        vec![
            (
                Regex::new(r"(?i)\bBearer\s+[A-Za-z0-9._~+/=-]{12,}").unwrap(),
                "Bearer [REDACTED]",
            ),
            (
                Regex::new(r"\bsk-[A-Za-z0-9_-]{20,}\b").unwrap(),
                "[REDACTED_OPENAI_KEY]",
            ),
            (
                Regex::new(r"\bgh[pousr]_[A-Za-z0-9_]{20,}\b").unwrap(),
                "[REDACTED_GITHUB_TOKEN]",
            ),
            (
                Regex::new(r"\bgithub_pat_[A-Za-z0-9_]{20,}\b").unwrap(),
                "[REDACTED_GITHUB_TOKEN]",
            ),
            (
                Regex::new(r"\bAKIA[0-9A-Z]{16}\b").unwrap(),
                "[REDACTED_AWS_ACCESS_KEY]",
            ),
            (
                Regex::new(
                    r#"(?i)(api[_-]?key|access[_-]?token|refresh[_-]?token|id[_-]?token|client[_-]?secret|password|secret|token)(\s*[:=]\s*)(")?[^"',\s\\}\[]{6,}(")?"#,
                )
                .unwrap(),
                "$1$2$3[REDACTED]$4",
            ),
        ]
    })
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::service::session::{
        DialogTurnKind, ModelRoundData, TextItemData, ThinkingItemData, ToolCallData,
        ToolResultData, TurnStatus, UserMessageData,
    };
    use serde_json::json;

    fn base_turn(user_content: &str) -> DialogTurnData {
        DialogTurnData {
            turn_id: "turn_1".to_string(),
            turn_index: 0,
            session_id: "session_1".to_string(),
            timestamp: 1,
            kind: DialogTurnKind::UserDialog,
            agent_type: Some("coder".to_string()),
            user_message: UserMessageData {
                id: "user_1".to_string(),
                content: user_content.to_string(),
                timestamp: 1,
                metadata: None,
            },
            model_rounds: Vec::new(),
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
        }
    }

    fn base_round() -> ModelRoundData {
        ModelRoundData {
            id: "round_1".to_string(),
            turn_id: "turn_1".to_string(),
            round_index: 0,
            round_group_id: None,
            timestamp: 1,
            text_items: Vec::new(),
            tool_items: Vec::new(),
            thinking_items: Vec::new(),
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
            attempt_count: None,
            attempt_diagnostics: vec![],
            failure_category: None,
            token_details: None,
            status: "completed".to_string(),
        }
    }

    #[test]
    fn memory_transcript_includes_tool_input_and_result_with_redaction() {
        let mut turn = base_turn("remember this");
        let mut round = base_round();
        round.text_items.push(TextItemData {
            id: "text_1".to_string(),
            content: "I will inspect it.".to_string(),
            is_streaming: false,
            timestamp: 1,
            is_markdown: true,
            order_index: None,
            is_subagent_item: None,
            parent_task_tool_id: None,
            subagent_session_id: None,
            status: None,
            attempt_id: None,
            attempt_index: None,
        });
        round.tool_items.push(ToolItemData {
            id: "tool_1".to_string(),
            tool_name: "WebFetch".to_string(),
            tool_call: ToolCallData {
                id: "call_1".to_string(),
                input: json!({
                    "url": "https://example.test",
                    "api_key": "sk-abcdefghijklmnopqrstuvwxyz"
                }),
            },
            tool_result: Some(ToolResultData {
                result: json!({"raw": "Authorization: Bearer abcdefghijklmnopqrstuvwxyz"}),
                success: true,
                result_for_assistant: Some(
                    "Fetched page with token=ghp_abcdefghijklmnopqrstuvwxyz".to_string(),
                ),
                image_attachments: None,
                error: None,
                duration_ms: Some(1),
            }),
            ai_intent: Some("fetch reference".to_string()),
            start_time: 1,
            end_time: Some(2),
            duration_ms: Some(1),
            queue_wait_ms: None,
            preflight_ms: None,
            confirmation_wait_ms: None,
            execution_ms: None,
            order_index: None,
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
        });
        turn.model_rounds.push(round);

        let transcript =
            render_memory_phase1_transcript(&[turn], 20_000, MemoryExternalContextPolicy::Allow)
                .unwrap();

        assert!(transcript.contains("\"role\":\"assistant\""));
        assert!(transcript.contains("\"tool_calls\":["));
        assert!(transcript.contains("\"id\":\"call_1\""));
        assert!(transcript.contains("\"type\":\"function\""));
        assert!(transcript.contains("\"function\":{\"name\":\"WebFetch\""));
        assert!(transcript.contains("\"role\":\"tool\""));
        assert!(transcript.contains("\"name\":\"WebFetch\""));
        assert!(transcript.contains("\"tool_call_id\":\"call_1\""));
        assert!(transcript.contains("https://example.test"));
        assert!(transcript.contains("[REDACTED_OPENAI_KEY]"));
        assert!(transcript.contains("[REDACTED_GITHUB_TOKEN]"));
        assert!(!transcript.contains("sk-abcdefghijklmnopqrstuvwxyz"));
        assert!(!transcript.contains("ghp_abcdefghijklmnopqrstuvwxyz"));
        assert!(!transcript.contains("fetch reference"));
    }

    #[test]
    fn memory_transcript_clears_get_tool_spec_results() {
        let mut turn = base_turn("load a deferred tool");
        let mut round = base_round();
        round.tool_items.push(ToolItemData {
            id: "tool_1".to_string(),
            tool_name: GET_TOOL_SPEC_TOOL_NAME.to_string(),
            tool_call: ToolCallData {
                id: "call_1".to_string(),
                input: json!({ "tool_name": "Worktree" }),
            },
            tool_result: Some(ToolResultData {
                result: json!({
                    "name": "Worktree",
                    "description": "full schema definition",
                    "input_schema": {
                        "type": "object",
                        "properties": {
                            "command": { "type": "string" }
                        }
                    }
                }),
                success: true,
                result_for_assistant: Some(
                    r#"{"description":"full schema definition","input_schema":{"type":"object"}}"#
                        .to_string(),
                ),
                image_attachments: None,
                error: None,
                duration_ms: Some(1),
            }),
            ai_intent: None,
            start_time: 1,
            end_time: Some(2),
            duration_ms: Some(1),
            queue_wait_ms: None,
            preflight_ms: None,
            confirmation_wait_ms: None,
            execution_ms: None,
            order_index: None,
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
        });
        turn.model_rounds.push(round);

        let transcript =
            render_memory_phase1_transcript(&[turn], 20_000, MemoryExternalContextPolicy::Allow)
                .unwrap();

        assert!(transcript.contains("\"function\":{\"name\":\"GetToolSpec\""));
        assert!(transcript.contains("\\\"tool_name\\\":\\\"Worktree\\\""));
        assert!(transcript.contains("\"name\":\"GetToolSpec\""));
        assert!(transcript.contains("\"content\":\"[cleared]\""));
        assert!(!transcript.contains("full schema definition"));
        assert!(!transcript.contains("input_schema"));
    }

    #[test]
    fn memory_transcript_clears_external_tool_results_when_configured() {
        let mut turn = base_turn("search and remember local preference");
        let mut round = base_round();
        round.tool_items.push(ToolItemData {
            id: "tool_1".to_string(),
            tool_name: openbitfun_agent_tools::CALL_DEFERRED_TOOL_NAME.to_string(),
            tool_call: ToolCallData {
                id: "call_1".to_string(),
                input: json!({
                    "tool_name": "WebFetch",
                    "args": { "url": "https://example.test/preferences" }
                }),
            },
            tool_result: Some(ToolResultData {
                result: json!({
                    "content": "external page content that should not enter memory extraction"
                }),
                success: true,
                result_for_assistant: Some(
                    "external page content that should not enter memory extraction".to_string(),
                ),
                image_attachments: None,
                error: None,
                duration_ms: Some(1),
            }),
            ai_intent: None,
            start_time: 1,
            end_time: Some(2),
            duration_ms: Some(1),
            queue_wait_ms: None,
            preflight_ms: None,
            confirmation_wait_ms: None,
            execution_ms: None,
            order_index: None,
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
        });
        turn.model_rounds.push(round);

        let transcript = render_memory_phase1_transcript(
            &[turn],
            20_000,
            MemoryExternalContextPolicy::ClearToolResults,
        )
        .unwrap();

        assert!(transcript.contains("\"function\":{\"name\":\"WebFetch\""));
        assert!(!transcript.contains(openbitfun_agent_tools::CALL_DEFERRED_TOOL_NAME));
        assert!(transcript.contains("https://example.test/preferences"));
        assert!(transcript.contains("\"content\":\"[external tool result cleared]\""));
        assert!(
            !transcript.contains("external page content that should not enter memory extraction")
        );
    }

    #[test]
    fn memory_transcript_truncates_large_items_before_serialization() {
        let mut turn = base_turn(&"u".repeat(MESSAGE_CONTENT_TOKEN_LIMIT * 5));
        let mut round = base_round();
        round.tool_items.push(ToolItemData {
            id: "tool_1".to_string(),
            tool_name: "Read".to_string(),
            tool_call: ToolCallData {
                id: "call_1".to_string(),
                input: json!({
                    "path": "huge.txt",
                    "content": "i".repeat(TOOL_INPUT_TOKEN_LIMIT * 5),
                }),
            },
            tool_result: Some(ToolResultData {
                result: json!({"content": "r".repeat(TOOL_RESULT_TOKEN_LIMIT * 5)}),
                success: true,
                result_for_assistant: None,
                image_attachments: None,
                error: Some("e".repeat(TOOL_ERROR_TOKEN_LIMIT * 5)),
                duration_ms: Some(1),
            }),
            ai_intent: None,
            start_time: 1,
            end_time: Some(2),
            duration_ms: Some(1),
            queue_wait_ms: None,
            preflight_ms: None,
            confirmation_wait_ms: None,
            execution_ms: None,
            order_index: None,
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
        });
        turn.model_rounds.push(round);

        let transcript =
            render_memory_phase1_transcript(&[turn], 120_000, MemoryExternalContextPolicy::Allow)
                .unwrap();

        assert!(transcript.contains("tokens truncated"));
        assert!(transcript.contains("\\\"truncated\\\":true"));
        assert!(transcript.contains("\\\"preview\\\""));
        assert!(!transcript.contains(&"u".repeat(MESSAGE_CONTENT_TOKEN_LIMIT * 5)));
        assert!(!transcript.contains(&"i".repeat(TOOL_INPUT_TOKEN_LIMIT * 5)));
        assert!(!transcript.contains(&"r".repeat(TOOL_RESULT_TOKEN_LIMIT * 5)));
    }

    #[test]
    fn memory_transcript_applies_head_tail_total_token_limit() {
        let turns = [
            base_turn(&format!("head-{}", "a".repeat(10_000))),
            base_turn(&format!("{}-tail", "z".repeat(10_000))),
        ];

        let transcript =
            render_memory_phase1_transcript(&turns, 256, MemoryExternalContextPolicy::Allow)
                .unwrap();

        assert!(transcript.contains("head-"));
        assert!(transcript.contains("-tail"));
        assert!(transcript.contains("tokens truncated"));
        assert!(transcript.len() <= 256 * APPROX_BYTES_PER_TOKEN);
    }

    #[test]
    fn memory_transcript_strips_system_reminder_suffix_and_excludes_thinking_and_subagent_items() {
        let mut turn = base_turn(
            "actual request\n<system_reminder>\n# User Context\nAGENTS.md content\n</system_reminder>",
        );
        let mut round = base_round();
        round.thinking_items.push(ThinkingItemData {
            id: "thinking_1".to_string(),
            content: "private reasoning".to_string(),
            reasoning_kind: None,
            is_streaming: false,
            is_collapsed: true,
            timestamp: 1,
            order_index: None,
            status: None,
            is_subagent_item: None,
            parent_task_tool_id: None,
            subagent_session_id: None,
            attempt_id: None,
            attempt_index: None,
        });
        round.text_items.push(TextItemData {
            id: "text_subagent".to_string(),
            content: "subagent result".to_string(),
            is_streaming: false,
            timestamp: 1,
            is_markdown: true,
            order_index: None,
            is_subagent_item: Some(true),
            parent_task_tool_id: None,
            subagent_session_id: Some("child".to_string()),
            status: None,
            attempt_id: None,
            attempt_index: None,
        });
        turn.model_rounds.push(round);

        let transcript =
            render_memory_phase1_transcript(&[turn], 20_000, MemoryExternalContextPolicy::Allow)
                .unwrap();

        assert!(transcript.contains("actual request"));
        assert!(!transcript.contains("AGENTS.md"));
        assert!(!transcript.contains("private reasoning"));
        assert!(!transcript.contains("subagent result"));
    }

    #[test]
    fn memory_transcript_drops_system_reminder_only_user_content() {
        let turn = base_turn(
            "<system_reminder>\n# Skill Listing\n<available_skills></available_skills>\n</system_reminder>",
        );

        let transcript =
            render_memory_phase1_transcript(&[turn], 20_000, MemoryExternalContextPolicy::Allow)
                .unwrap();

        assert!(transcript.is_empty());
    }
}
