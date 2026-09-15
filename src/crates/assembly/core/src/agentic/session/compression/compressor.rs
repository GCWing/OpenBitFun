//! Context compressor
//!
//! Responsible only for transforming a session context into a compressed one.

use crate::agentic::core::{
    render_system_reminder, CompressedTodoSnapshot, CompressionContract, CompressionEntry,
    CompressionPayload, InternalReminderKind, Message, MessageContent, MessageHelper, MessageRole,
    MessageSemanticKind,
};
use crate::service::session::TranscriptLineRange;
use crate::util::errors::OpenBitFunResult;
use log::{debug, trace};
use std::borrow::Cow;

struct CompressionSummaryArtifact {
    summary_text: String,
    payload: CompressionPayload,
}

#[derive(Debug, Clone)]
pub struct CompressionResult {
    pub messages: Vec<Message>,
}

#[derive(Debug, Clone)]
pub struct CompressionPlan {
    pub summary_request_messages: Vec<Message>,
    pub summary_messages: Vec<Message>,
    pub retained_user_messages: Vec<Message>,
    pub recent_tail_messages: Vec<Message>,
    pub retained_user_token_budget: usize,
    pub retained_user_tokens: usize,
    pub recent_target_tokens: usize,
    pub recent_tail_tokens: usize,
    pub cutoff_message_index: usize,
    pub next_recent_target_tokens: Option<usize>,
    pub(crate) current_turn_todo_checkpoint: Option<CurrentTurnTodoCheckpoint>,
}

#[derive(Debug, Clone)]
pub(crate) struct CurrentTurnTodoCheckpoint {
    turn_id: String,
    snapshot: CompressedTodoSnapshot,
}

#[derive(Debug, Clone, Copy)]
struct AtomicMessageUnit {
    start: usize,
    tokens: usize,
}

/// Stateless context compression service.
#[derive(Default)]
pub struct ContextCompressor {}

impl ContextCompressor {
    pub const DEFAULT_RECENT_CONTEXT_TOKENS: usize = 10_000;
    pub const RECENT_CONTEXT_RETRY_STEP_TOKENS: usize = 10_000;
    const MAX_RETAINED_USER_TOKENS: usize = 20_000;
    const COMPRESSION_CONTINUATION_REMINDER: &'static str =
        "This conversation was compacted. Re-establish the working state from the retained user messages, summary, and recent context. Continue any unfinished work; otherwise use this context for the user's next request. Do not ask the user to repeat information already retained here. If a required detail is missing and a pre-compaction transcript is available, inspect the relevant part before proceeding.";

    pub fn new() -> Self {
        Self::default()
    }

    pub fn plan_compression(
        &self,
        session_id: &str,
        runtime_messages: &[Message],
        context_window: usize,
        recent_target_tokens: usize,
    ) -> OpenBitFunResult<Option<CompressionPlan>> {
        self.plan_compression_internal(
            session_id,
            None,
            runtime_messages,
            context_window,
            recent_target_tokens,
        )
    }

    pub(crate) fn plan_compression_for_turn(
        &self,
        session_id: &str,
        current_turn_id: &str,
        runtime_messages: &[Message],
        context_window: usize,
        recent_target_tokens: usize,
    ) -> OpenBitFunResult<Option<CompressionPlan>> {
        self.plan_compression_internal(
            session_id,
            Some(current_turn_id),
            runtime_messages,
            context_window,
            recent_target_tokens,
        )
    }

    fn plan_compression_internal(
        &self,
        session_id: &str,
        current_turn_id: Option<&str>,
        runtime_messages: &[Message],
        context_window: usize,
        recent_target_tokens: usize,
    ) -> OpenBitFunResult<Option<CompressionPlan>> {
        let runtime_messages = if runtime_messages.iter().any(|message| {
            message
                .internal_reminder_kind()
                .is_some_and(InternalReminderKind::should_drop_during_compaction)
        }) {
            Cow::Owned(
                runtime_messages
                    .iter()
                    .filter(|message| {
                        !message
                            .internal_reminder_kind()
                            .is_some_and(InternalReminderKind::should_drop_during_compaction)
                    })
                    .cloned()
                    .collect(),
            )
        } else {
            Cow::Borrowed(runtime_messages)
        };
        let runtime_messages = runtime_messages.as_ref();
        let system_message_count = runtime_messages
            .iter()
            .take_while(|message| message.role == MessageRole::System)
            .count();
        let conversation = &runtime_messages[system_message_count..];
        if conversation.is_empty() {
            debug!(
                "No conversation messages available for automatic compression planning: session_id={}",
                session_id
            );
            return Ok(None);
        }

        let units = Self::atomic_message_units(conversation);
        if units.is_empty() {
            return Ok(None);
        }

        let minimum_cutoff = if units.len() > 1 {
            units[1].start
        } else {
            conversation.len()
        };
        let mut cutoff = conversation.len();
        let mut accumulated_tokens = 0usize;
        let mut next_recent_target_tokens = None;

        for unit in units.iter().rev() {
            if unit.start < minimum_cutoff {
                break;
            }
            let next_tokens = accumulated_tokens.saturating_add(unit.tokens);
            if next_tokens > recent_target_tokens {
                next_recent_target_tokens = Some(next_tokens);
                break;
            }
            cutoff = unit.start;
            accumulated_tokens = next_tokens;
        }

        let summary_messages = conversation[..cutoff].to_vec();
        if summary_messages.is_empty() {
            debug!(
                "Automatic compression plan has no summary prefix: session_id={}, recent_target_tokens={}",
                session_id, recent_target_tokens
            );
            return Ok(None);
        }

        let recent_tail_messages = conversation[cutoff..].to_vec();
        let recent_tail_tokens = recent_tail_messages
            .iter()
            .map(|message| message.estimate_tokens_with_reasoning(true))
            .sum();
        let current_turn_todo_checkpoint = current_turn_id.and_then(|turn_id| {
            Self::latest_successful_todo_snapshot_for_turn(conversation, turn_id).and_then(
                |(source_message_index, snapshot)| {
                    (source_message_index < cutoff).then(|| CurrentTurnTodoCheckpoint {
                        turn_id: turn_id.to_string(),
                        snapshot,
                    })
                },
            )
        });
        let mut summary_request_messages = runtime_messages[..system_message_count].to_vec();
        summary_request_messages.extend(summary_messages.clone());

        let retained_user_token_budget = (context_window / 10).min(Self::MAX_RETAINED_USER_TOKENS);
        let (retained_user_messages, retained_user_tokens) =
            Self::retain_historical_user_messages(&summary_messages, retained_user_token_budget);
        debug!(
            "Compression plan: session_id={}, retained_user_token_budget={}, retained_user_tokens={}, retained_user_messages={}, recent_target_tokens={}, recent_tail_tokens={}, cutoff_message_index={}, summary_messages={}, recent_tail_messages={}, next_recent_target_tokens={:?}",
            session_id,
            retained_user_token_budget,
            retained_user_tokens,
            retained_user_messages.len(),
            recent_target_tokens,
            recent_tail_tokens,
            cutoff,
            summary_messages.len(),
            recent_tail_messages.len(),
            next_recent_target_tokens
        );

        Ok(Some(CompressionPlan {
            summary_request_messages,
            summary_messages,
            retained_user_messages,
            recent_tail_messages,
            retained_user_token_budget,
            retained_user_tokens,
            recent_target_tokens,
            recent_tail_tokens,
            cutoff_message_index: cutoff,
            next_recent_target_tokens,
            current_turn_todo_checkpoint,
        }))
    }

    fn latest_successful_todo_snapshot_for_turn(
        messages: &[Message],
        current_turn_id: &str,
    ) -> Option<(usize, CompressedTodoSnapshot)> {
        let mut latest = None;

        for (message_index, message) in messages.iter().enumerate() {
            if let Some(payload) = message.metadata.compression_payload.as_ref() {
                for entry in &payload.entries {
                    if let CompressionEntry::Turn {
                        turn_id: Some(turn_id),
                        todo: Some(todo),
                        ..
                    } = entry
                    {
                        if turn_id == current_turn_id {
                            latest = Some((message_index, todo.clone()));
                        }
                    }
                }
            }

            if message.role != MessageRole::Assistant
                || message.metadata.turn_id.as_deref() != Some(current_turn_id)
            {
                continue;
            }
            let MessageContent::Mixed { tool_calls, .. } = &message.content else {
                continue;
            };

            for tool_call in tool_calls {
                if tool_call.tool_name != "TodoWrite" || tool_call.is_error {
                    continue;
                }
                let Some(result) = messages[message_index + 1..]
                    .iter()
                    .take_while(|candidate| candidate.role == MessageRole::Tool)
                    .find_map(|candidate| match &candidate.content {
                        MessageContent::ToolResult {
                            tool_id,
                            result,
                            is_error,
                            ..
                        } if tool_id == &tool_call.tool_id
                            && !*is_error
                            && result.get("success").and_then(serde_json::Value::as_bool)
                                != Some(false) =>
                        {
                            Some(result)
                        }
                        _ => None,
                    })
                else {
                    continue;
                };

                if let Some(snapshot) = MessageHelper::todo_snapshot_from_value(result)
                    .or_else(|| MessageHelper::todo_snapshot_from_value(&tool_call.arguments))
                {
                    latest = Some((message_index, snapshot));
                }
            }
        }

        latest
    }

    fn atomic_message_units(messages: &[Message]) -> Vec<AtomicMessageUnit> {
        let mut units = Vec::new();
        let mut index = 0usize;

        while index < messages.len() {
            let start = index;
            index += 1;
            if messages[start].role == MessageRole::Assistant {
                while index < messages.len() && messages[index].role == MessageRole::Tool {
                    index += 1;
                }
            }
            let tokens = messages[start..index]
                .iter()
                .map(|message| message.estimate_tokens_with_reasoning(true))
                .sum();
            units.push(AtomicMessageUnit { start, tokens });
        }

        units
    }

    fn retain_historical_user_messages(
        summary_messages: &[Message],
        token_budget: usize,
    ) -> (Vec<Message>, usize) {
        let mut retained = Vec::new();
        let mut retained_tokens = 0usize;

        for message in summary_messages
            .iter()
            .rev()
            .filter(|message| message.is_actual_user_message())
        {
            let message_tokens = message.estimate_tokens_with_reasoning(true);
            if retained_tokens.saturating_add(message_tokens) > token_budget {
                break;
            }
            retained_tokens += message_tokens;
            retained.push(message.clone());
        }

        retained.reverse();
        (retained, retained_tokens)
    }

    pub fn compress_plan_with_contract(
        &self,
        session_id: &str,
        plan: CompressionPlan,
        contract: Option<CompressionContract>,
        model_summary: String,
    ) -> OpenBitFunResult<CompressionResult> {
        let summary = Self::normalize_model_summary_output(&model_summary).ok_or_else(|| {
            crate::OpenBitFunError::AIClient(
                "Context compression requires a non-empty model summary".to_string(),
            )
        })?;
        let mut summary_artifact = self.build_model_summary_artifact(summary, contract);
        if let Some(checkpoint) = plan.current_turn_todo_checkpoint {
            Self::append_current_turn_todo_checkpoint(&mut summary_artifact, checkpoint);
        }
        let summary_message = self.create_summary_message(summary_artifact);
        let mut messages = plan.retained_user_messages;
        messages.push(summary_message);
        messages.extend(plan.recent_tail_messages);
        messages.push(Message::internal_reminder(
            InternalReminderKind::CompressionContinuation,
            Self::COMPRESSION_CONTINUATION_REMINDER,
        ));

        debug!(
            "Compression completed: session_id={}, compressed_messages={}",
            session_id,
            messages.len()
        );
        Ok(CompressionResult { messages })
    }

    fn append_current_turn_todo_checkpoint(
        summary_artifact: &mut CompressionSummaryArtifact,
        checkpoint: CurrentTurnTodoCheckpoint,
    ) {
        let rendered = Self::render_current_turn_todo_checkpoint(&checkpoint.snapshot);
        summary_artifact.summary_text = format!(
            "{}\n\nCurrent task state at the compaction boundary (authoritative; overrides any conflicting task status in the generated summary):\n<todo>\n{}\n</todo>",
            summary_artifact.summary_text.trim_end(),
            rendered
        );

        for entry in &mut summary_artifact.payload.entries {
            if let CompressionEntry::Turn { turn_id, todo, .. } = entry {
                if turn_id.as_deref() == Some(checkpoint.turn_id.as_str()) {
                    *todo = None;
                }
            }
        }
        summary_artifact.payload.entries.retain(|entry| {
            !matches!(
                entry,
                CompressionEntry::Turn { messages, todo, .. }
                    if messages.is_empty() && todo.is_none()
            )
        });
        summary_artifact
            .payload
            .entries
            .push(CompressionEntry::Turn {
                turn_id: Some(checkpoint.turn_id),
                messages: Vec::new(),
                todo: Some(checkpoint.snapshot),
            });
    }

    fn render_current_turn_todo_checkpoint(snapshot: &CompressedTodoSnapshot) -> String {
        if snapshot.todos.is_empty() {
            return snapshot
                .summary
                .clone()
                .unwrap_or_else(|| "The current-turn task list is empty.".to_string());
        }

        snapshot
            .todos
            .iter()
            .map(|todo| {
                let id = todo
                    .id
                    .as_deref()
                    .map(|id| format!(" ({id})"))
                    .unwrap_or_default();
                format!("- [{}]{} {}", todo.status, id, todo.content)
            })
            .collect::<Vec<_>>()
            .join("\n")
    }

    pub fn append_transcript_reference(
        &self,
        result: &mut CompressionResult,
        transcript_uri: &str,
        transcript_index_range: &TranscriptLineRange,
    ) -> bool {
        let Some(summary) = result.messages.iter_mut().find(|message| {
            message.metadata.semantic_kind == Some(MessageSemanticKind::CompressionSummary)
        }) else {
            return false;
        };
        let MessageContent::Text(text) = &mut summary.content else {
            return false;
        };
        let Some(reminder_end) = text.rfind("\n</system_reminder>") else {
            return false;
        };
        let transcript_text =
            Self::render_transcript_reference_text(transcript_uri, transcript_index_range);
        text.insert_str(reminder_end, &format!("\n\n{transcript_text}"));
        summary.metadata.tokens = None;
        true
    }

    fn create_summary_message(&self, summary_artifact: CompressionSummaryArtifact) -> Message {
        let boundary_text = Self::render_boundary_marker_text();
        let content = render_system_reminder(&format!(
            "{}\n\n{}",
            boundary_text, summary_artifact.summary_text
        ));
        Message::user(content)
            .with_semantic_kind(MessageSemanticKind::CompressionSummary)
            .with_compression_payload(summary_artifact.payload)
    }

    fn render_boundary_marker_text() -> &'static str {
        "Some earlier user messages were retained verbatim, and the remaining earlier conversation has been summarized below. Use both as prior context."
    }

    fn render_transcript_reference_text(
        transcript_uri: &str,
        index_range: &TranscriptLineRange,
    ) -> String {
        format!(
            "The complete conversation history from before compression is available at:\n{}\nThe transcript index is at lines {}-{}. Inspect this file if historical details are needed. The file may be large. Recommended ways to access it: 1. Read the index first, then inspect the relevant line ranges. 2. Use Grep to search for the needed content.",
            transcript_uri, index_range.start_line, index_range.end_line
        )
    }

    fn build_model_summary_artifact(
        &self,
        summary: String,
        contract: Option<CompressionContract>,
    ) -> CompressionSummaryArtifact {
        trace!("Compression summary: {}", summary);
        let mut payload = CompressionPayload::from_summary(summary.clone());
        let summary_text = if let Some(contract) = contract.filter(|contract| !contract.is_empty())
        {
            payload.entries.insert(
                0,
                CompressionEntry::Contract {
                    contract: contract.clone(),
                },
            );
            format!(
                "{}\n\nSummary of the earlier conversation:\n<summary>\n{}\n</summary>",
                contract.render_for_model(),
                summary
            )
        } else {
            format!(
                "Summary of the earlier conversation:\n<summary>\n{}\n</summary>",
                summary
            )
        };

        CompressionSummaryArtifact {
            summary_text,
            payload,
        }
    }

    pub(crate) fn normalize_model_summary_output(raw: &str) -> Option<String> {
        let summary = raw.trim();
        (!summary.is_empty()).then(|| summary.to_string())
    }

    pub(crate) fn build_compact_prompt(&self) -> String {
        String::from(
            r#"You are performing a CONTEXT CHECKPOINT COMPACTION. Create a handoff summary for another LLM that will resume the task.

Include:
- Current progress and key decisions made
- Important context, constraints, or user preferences
- What remains to be done (clear next steps)
- Any critical data, examples, or references needed to continue

Be concise, structured, and focused on helping the next LLM seamlessly continue the work.

Note: Preserve durable, task-specific state, but do not reproduce information that can be obtained again from its source:
- Do not paste large file contents, long code blocks, command output, logs, tool results, or other bulky source material. Record the file path or source reference, plus a one-sentence description of its purpose or relevant contents. Include only a small exact snippet when it is essential and cannot be reliably reconstructed.
- Do not copy Skill instructions or other reloadable guidance. Record the Skill name, why it is relevant, and that the next LLM should reload it when needed.

IMPORTANT: This is a summary-only turn. Do not call tools or perform additional work. Respond with the handoff summary as plain text. Any tool call will be rejected and you will fail the task.
"#,
        )
    }
}

#[cfg(test)]
mod tests {
    use super::ContextCompressor;
    use crate::agentic::core::{
        render_system_reminder, CompressedTodoItem, CompressedTodoSnapshot, CompressionEntry,
        CompressionPayload, InternalReminderKind, Message, MessageContent, MessageSemanticKind,
        ToolCall, ToolResult,
    };
    use crate::service::session::TranscriptLineRange;

    fn todo_call() -> ToolCall {
        ToolCall {
            tool_id: "todo_recent".to_string(),
            tool_name: "TodoWrite".to_string(),
            arguments: serde_json::json!({
                "todos": [
                    {"content": "Keep recent context", "status": "in_progress"},
                    {"content": "Retry compression", "status": "pending"}
                ]
            }),
            raw_arguments: None,
            is_error: false,
            parse_error: None,
            recovered_from_truncation: false,
            repair_kind: Default::default(),
        }
    }

    fn todo_result() -> Message {
        Message::tool_result(ToolResult {
            tool_id: "todo_recent".to_string(),
            tool_name: "TodoWrite".to_string(),
            effective_tool_name: None,
            result: serde_json::json!({"success": true}),
            result_for_assistant: None,
            is_error: false,
            duration_ms: None,
            image_attachments: None,
        })
    }

    fn todo_call_with(tool_id: &str, todos: serde_json::Value) -> ToolCall {
        ToolCall {
            tool_id: tool_id.to_string(),
            tool_name: "TodoWrite".to_string(),
            arguments: serde_json::json!({ "todos": todos }),
            raw_arguments: None,
            is_error: false,
            parse_error: None,
            recovered_from_truncation: false,
            repair_kind: Default::default(),
        }
    }

    fn todo_result_with(tool_id: &str, todos: serde_json::Value, is_error: bool) -> Message {
        Message::tool_result(ToolResult {
            tool_id: tool_id.to_string(),
            tool_name: "TodoWrite".to_string(),
            effective_tool_name: None,
            result: serde_json::json!({
                "success": !is_error,
                "todos": todos,
                "merge": false
            }),
            result_for_assistant: None,
            is_error,
            duration_ms: None,
            image_attachments: None,
        })
    }

    #[test]
    fn recent_context_keeps_the_exact_suffix_that_fits_the_budget() {
        let compressor = ContextCompressor::new();
        let current_user = Message::user("Current request".to_string());
        let current_assistant = Message::assistant("Current answer".to_string());
        let recent_target = current_user.estimate_tokens_with_reasoning(true)
            + current_assistant.estimate_tokens_with_reasoning(true);
        let messages = vec![
            Message::system("system".to_string()),
            Message::user("Older request".repeat(200)),
            Message::assistant("Older answer".repeat(200)),
            current_user.clone(),
            current_assistant.clone(),
        ];

        let plan = compressor
            .plan_compression("session", &messages, 128_000, recent_target)
            .expect("planning succeeds")
            .expect("plan exists");

        assert_eq!(plan.recent_tail_tokens, recent_target);
        assert_eq!(plan.recent_tail_messages.len(), 2);
        assert_eq!(plan.recent_tail_messages[0].id, current_user.id);
        assert_eq!(plan.recent_tail_messages[1].id, current_assistant.id);
    }

    #[test]
    fn cutoff_can_split_a_turn_without_adding_an_anchor_or_boundary_reminder() {
        let compressor = ContextCompressor::new();
        let current_user = Message::user("Continue the current task".to_string())
            .with_turn_id("turn-current".to_string());
        let retained_assistant = Message::assistant("Latest evidence".to_string())
            .with_turn_id("turn-current".to_string());
        let recent_target = retained_assistant.estimate_tokens_with_reasoning(true);
        let messages = vec![
            Message::system("system".to_string()),
            Message::user("Older request".to_string()),
            Message::assistant("Older answer".to_string()),
            current_user.clone(),
            retained_assistant.clone(),
        ];

        let plan = compressor
            .plan_compression("session", &messages, 128_000, recent_target)
            .expect("planning succeeds")
            .expect("plan exists");

        assert_eq!(plan.recent_tail_messages.len(), 1);
        assert_eq!(plan.recent_tail_messages[0].id, retained_assistant.id);
        assert!(plan
            .retained_user_messages
            .iter()
            .any(|message| message.id == current_user.id));
        assert!(plan
            .summary_messages
            .iter()
            .any(|message| message.id == current_user.id));

        let result = compressor
            .compress_plan_with_contract("session", plan, None, "Earlier work summary".to_string())
            .expect("compression succeeds");
        assert_eq!(result.messages.len(), 5);
        assert_eq!(result.messages[0].content.to_string(), "Older request");
        assert_eq!(result.messages[1].id, current_user.id);
        let MessageContent::Text(summary) = &result.messages[2].content else {
            panic!("expected summary text");
        };
        assert!(!summary.contains("Most recent user message before this summary"));
        assert!(!summary.contains("Most recent task list snapshot before this summary"));
        assert_eq!(result.messages[3].id, retained_assistant.id);
        assert_eq!(
            result.messages[4].internal_reminder_kind(),
            Some(InternalReminderKind::CompressionContinuation)
        );
        assert_eq!(
            result.messages[4].content.to_string(),
            render_system_reminder(ContextCompressor::COMPRESSION_CONTINUATION_REMINDER)
        );
    }

    #[test]
    fn recent_context_never_splits_tool_results_from_their_assistant_call() {
        let compressor = ContextCompressor::new();
        let assistant = Message::assistant_with_tools("Planning".to_string(), vec![todo_call()]);
        let result = todo_result();
        let messages = vec![
            Message::system("system".to_string()),
            Message::user("Older request".to_string()),
            Message::assistant("Older answer".repeat(500)),
            Message::user("Current request".to_string()),
            assistant.clone(),
            result.clone(),
        ];

        let atomic_tokens = assistant.estimate_tokens_with_reasoning(true)
            + result.estimate_tokens_with_reasoning(true);
        let too_small = compressor
            .plan_compression("session", &messages, 128_000, atomic_tokens - 1)
            .expect("planning succeeds")
            .expect("plan exists");
        let exact = compressor
            .plan_compression("session", &messages, 128_000, atomic_tokens)
            .expect("planning succeeds")
            .expect("plan exists");

        assert!(too_small.recent_tail_messages.is_empty());
        assert_eq!(exact.recent_tail_messages[0].id, assistant.id);
        assert_eq!(exact.recent_tail_messages[1].id, result.id);
    }

    #[test]
    fn current_turn_todo_outside_recent_tail_is_checkpointed() {
        let compressor = ContextCompressor::new();
        let todos = serde_json::json!([
            {"id": "todo-1", "content": "Implement checkpoint", "status": "in_progress"},
            {"id": "todo-2", "content": "Run focused tests", "status": "pending"}
        ]);
        let todo_assistant = Message::assistant_with_tools(
            "Tracking work".to_string(),
            vec![todo_call_with("todo-current", todos.clone())],
        )
        .with_turn_id("turn-current".to_string());
        let todo_result =
            todo_result_with("todo-current", todos, false).with_turn_id("turn-current".to_string());
        let recent = Message::assistant("Latest implementation evidence".to_string())
            .with_turn_id("turn-current".to_string());
        let recent_target = recent.estimate_tokens_with_reasoning(true);
        let messages = vec![
            Message::system("system".to_string()),
            Message::user("Older request".to_string()).with_turn_id("turn-old".to_string()),
            Message::assistant("Older answer".to_string()).with_turn_id("turn-old".to_string()),
            Message::user("Current request".to_string()).with_turn_id("turn-current".to_string()),
            todo_assistant,
            todo_result,
            recent.clone(),
        ];

        let plan = compressor
            .plan_compression_for_turn("session", "turn-current", &messages, 128_000, recent_target)
            .expect("planning succeeds")
            .expect("plan exists");

        assert!(plan.current_turn_todo_checkpoint.is_some());
        assert_eq!(plan.recent_tail_messages.len(), 1);
        assert_eq!(plan.recent_tail_messages[0].id, recent.id);

        let result = compressor
            .compress_plan_with_contract("session", plan, None, "Earlier work summary".to_string())
            .expect("compression succeeds");
        let summary = result
            .messages
            .iter()
            .find(|message| {
                message.metadata.semantic_kind == Some(MessageSemanticKind::CompressionSummary)
            })
            .expect("summary exists");
        let MessageContent::Text(summary_text) = &summary.content else {
            panic!("expected summary text");
        };
        assert!(summary_text.contains("Current task state at the compaction boundary"));
        assert!(summary_text.contains("(todo-1) Implement checkpoint"));
        assert!(summary_text.contains("(todo-2) Run focused tests"));
        assert!(summary
            .metadata
            .compression_payload
            .as_ref()
            .expect("payload exists")
            .entries
            .iter()
            .any(|entry| matches!(
                entry,
                CompressionEntry::Turn {
                    turn_id: Some(turn_id),
                    todo: Some(todo),
                    ..
                } if turn_id == "turn-current" && todo.todos.len() == 2
            )));
    }

    #[test]
    fn historical_turn_todo_is_not_checkpointed_for_current_turn() {
        let compressor = ContextCompressor::new();
        let todos = serde_json::json!([
            {"id": "old-todo", "content": "Historical task", "status": "pending"}
        ]);
        let old_assistant = Message::assistant_with_tools(
            "Old planning".to_string(),
            vec![todo_call_with("todo-old", todos.clone())],
        )
        .with_turn_id("turn-old".to_string());
        let old_result =
            todo_result_with("todo-old", todos, false).with_turn_id("turn-old".to_string());
        let recent = Message::assistant("Current evidence".to_string())
            .with_turn_id("turn-current".to_string());
        let recent_target = recent.estimate_tokens_with_reasoning(true);
        let messages = vec![
            Message::system("system".to_string()),
            Message::user("Old request".to_string()).with_turn_id("turn-old".to_string()),
            old_assistant,
            old_result,
            Message::user("Current request".to_string()).with_turn_id("turn-current".to_string()),
            recent,
        ];

        let plan = compressor
            .plan_compression_for_turn("session", "turn-current", &messages, 128_000, recent_target)
            .expect("planning succeeds")
            .expect("plan exists");

        assert!(plan.current_turn_todo_checkpoint.is_none());
    }

    #[test]
    fn current_turn_todo_already_in_recent_tail_is_not_duplicated() {
        let compressor = ContextCompressor::new();
        let todos = serde_json::json!([
            {"id": "todo-tail", "content": "Stay in tail", "status": "in_progress"}
        ]);
        let todo_assistant = Message::assistant_with_tools(
            "Tail planning".to_string(),
            vec![todo_call_with("todo-tail", todos.clone())],
        )
        .with_turn_id("turn-current".to_string());
        let todo_result =
            todo_result_with("todo-tail", todos, false).with_turn_id("turn-current".to_string());
        let recent_target = todo_assistant.estimate_tokens_with_reasoning(true)
            + todo_result.estimate_tokens_with_reasoning(true);
        let messages = vec![
            Message::system("system".to_string()),
            Message::user("Old request".to_string()).with_turn_id("turn-old".to_string()),
            Message::assistant("Old answer".to_string()).with_turn_id("turn-old".to_string()),
            Message::user("Current request".to_string()).with_turn_id("turn-current".to_string()),
            todo_assistant,
            todo_result,
        ];

        let plan = compressor
            .plan_compression_for_turn("session", "turn-current", &messages, 128_000, recent_target)
            .expect("planning succeeds")
            .expect("plan exists");

        assert!(plan.current_turn_todo_checkpoint.is_none());
        assert_eq!(plan.recent_tail_messages.len(), 2);
    }

    #[test]
    fn current_turn_empty_todo_checkpoint_prevents_historical_state_resurrection() {
        let compressor = ContextCompressor::new();
        let cleared_assistant = Message::assistant_with_tools(
            "Clearing completed work".to_string(),
            vec![todo_call_with("todo-clear", serde_json::json!([]))],
        )
        .with_turn_id("turn-current".to_string());
        let cleared_result = todo_result_with("todo-clear", serde_json::json!([]), false)
            .with_turn_id("turn-current".to_string());
        let recent = Message::assistant("Continue after clearing".to_string())
            .with_turn_id("turn-current".to_string());
        let recent_target = recent.estimate_tokens_with_reasoning(true);
        let messages = vec![
            Message::system("system".to_string()),
            Message::user("Current request".to_string()).with_turn_id("turn-current".to_string()),
            cleared_assistant,
            cleared_result,
            recent,
        ];

        let plan = compressor
            .plan_compression_for_turn("session", "turn-current", &messages, 128_000, recent_target)
            .expect("planning succeeds")
            .expect("plan exists");
        let result = compressor
            .compress_plan_with_contract(
                "session",
                plan,
                None,
                "A historical task was pending.".to_string(),
            )
            .expect("compression succeeds");
        let summary = result
            .messages
            .iter()
            .find(|message| {
                message.metadata.semantic_kind == Some(MessageSemanticKind::CompressionSummary)
            })
            .expect("summary exists");

        assert!(summary.content.to_string().contains("explicitly cleared"));
        assert!(summary
            .metadata
            .compression_payload
            .as_ref()
            .expect("payload exists")
            .entries
            .iter()
            .any(|entry| matches!(
                entry,
                CompressionEntry::Turn {
                    turn_id: Some(turn_id),
                    todo: Some(todo),
                    ..
                } if turn_id == "turn-current" && todo.todos.is_empty()
            )));
    }

    #[test]
    fn failed_current_turn_todo_does_not_replace_the_last_successful_snapshot() {
        let compressor = ContextCompressor::new();
        let successful_todos = serde_json::json!([
            {"id": "todo-good", "content": "Keep successful state", "status": "in_progress"}
        ]);
        let successful_assistant = Message::assistant_with_tools(
            "Valid update".to_string(),
            vec![todo_call_with("todo-good", successful_todos.clone())],
        )
        .with_turn_id("turn-current".to_string());
        let successful_result = todo_result_with("todo-good", successful_todos, false)
            .with_turn_id("turn-current".to_string());
        let failed_todos = serde_json::json!([
            {"id": "todo-bad", "content": "Must not replace state", "status": "pending"}
        ]);
        let failed_assistant = Message::assistant_with_tools(
            "Invalid update".to_string(),
            vec![todo_call_with("todo-bad", failed_todos.clone())],
        )
        .with_turn_id("turn-current".to_string());
        let failed_result = todo_result_with("todo-bad", failed_todos, true)
            .with_turn_id("turn-current".to_string());
        let recent = Message::assistant("Continue working".to_string())
            .with_turn_id("turn-current".to_string());
        let recent_target = recent.estimate_tokens_with_reasoning(true);
        let messages = vec![
            Message::system("system".to_string()),
            Message::user("Current request".to_string()).with_turn_id("turn-current".to_string()),
            successful_assistant,
            successful_result,
            failed_assistant,
            failed_result,
            recent,
        ];

        let plan = compressor
            .plan_compression_for_turn("session", "turn-current", &messages, 128_000, recent_target)
            .expect("planning succeeds")
            .expect("plan exists");
        let checkpoint = plan
            .current_turn_todo_checkpoint
            .as_ref()
            .expect("successful checkpoint remains");

        assert_eq!(checkpoint.snapshot.todos.len(), 1);
        assert_eq!(
            checkpoint.snapshot.todos[0].id.as_deref(),
            Some("todo-good")
        );
    }

    #[test]
    fn current_turn_todo_checkpoint_survives_recompression_from_payload() {
        let compressor = ContextCompressor::new();
        let prior_summary = Message::user(render_system_reminder("Earlier compressed context"))
            .with_semantic_kind(MessageSemanticKind::CompressionSummary)
            .with_compression_payload(CompressionPayload {
                entries: vec![CompressionEntry::Turn {
                    turn_id: Some("turn-current".to_string()),
                    messages: Vec::new(),
                    todo: Some(CompressedTodoSnapshot {
                        todos: vec![CompressedTodoItem {
                            id: Some("todo-recompact".to_string()),
                            content: "Survive recompression".to_string(),
                            status: "in_progress".to_string(),
                        }],
                        summary: None,
                    }),
                }],
            });
        let recent = Message::assistant("New evidence after first compaction".to_string())
            .with_turn_id("turn-current".to_string());
        let recent_target = recent.estimate_tokens_with_reasoning(true);
        let messages = vec![
            Message::system("system".to_string()),
            Message::user("Older request".to_string()).with_turn_id("turn-old".to_string()),
            Message::assistant("Older answer".to_string()).with_turn_id("turn-old".to_string()),
            Message::user("Current request".to_string()).with_turn_id("turn-current".to_string()),
            prior_summary,
            recent,
        ];

        let plan = compressor
            .plan_compression_for_turn("session", "turn-current", &messages, 128_000, recent_target)
            .expect("planning succeeds")
            .expect("plan exists");
        let checkpoint = plan
            .current_turn_todo_checkpoint
            .as_ref()
            .expect("payload checkpoint survives");

        assert_eq!(checkpoint.snapshot.todos.len(), 1);
        assert_eq!(
            checkpoint.snapshot.todos[0].id.as_deref(),
            Some("todo-recompact")
        );
    }

    #[test]
    fn increasing_the_budget_to_the_next_atomic_unit_moves_the_cutoff() {
        let compressor = ContextCompressor::new();
        let messages = vec![
            Message::system("system".to_string()),
            Message::user("request".to_string()),
            Message::assistant("first".repeat(2_000)),
            Message::assistant("second".repeat(2_000)),
            Message::assistant("third".repeat(2_000)),
        ];

        let first = compressor
            .plan_compression("session", &messages, 128_000, 1)
            .expect("planning succeeds")
            .expect("first plan exists");
        let next_target = first
            .next_recent_target_tokens
            .expect("another atomic unit can be retained");
        let second = compressor
            .plan_compression("session", &messages, 128_000, next_target)
            .expect("planning succeeds")
            .expect("second plan exists");

        assert!(first.recent_tail_messages.is_empty());
        assert!(second.cutoff_message_index < first.cutoff_message_index);
        assert!(second.summary_messages.len() < first.summary_messages.len());
        assert!(second.recent_tail_messages.len() > first.recent_tail_messages.len());
    }

    #[test]
    fn compression_orders_retained_users_before_summary_and_recent_context() {
        let compressor = ContextCompressor::new();
        let user1 = Message::user("user1".to_string());
        let user2 = Message::user("user2".to_string());
        let user3 = Message::user("user3".to_string());
        let assistant3 = Message::assistant("assistant3".to_string());
        let recent_target = user3.estimate_tokens_with_reasoning(true)
            + assistant3.estimate_tokens_with_reasoning(true);
        let messages = vec![
            Message::system("system".to_string()),
            user1.clone(),
            Message::assistant("assistant1".to_string()),
            user2.clone(),
            Message::assistant("assistant2".to_string()),
            user3.clone(),
            assistant3.clone(),
        ];
        let plan = compressor
            .plan_compression("session", &messages, 128_000, recent_target)
            .expect("planning succeeds")
            .expect("plan exists");
        let mut result = compressor
            .compress_plan_with_contract("session", plan, None, "Model summary".to_string())
            .expect("compression succeeds");

        assert_eq!(result.messages.len(), 6);
        assert_eq!(result.messages[0].id, user1.id);
        assert_eq!(result.messages[1].id, user2.id);
        assert_eq!(
            result.messages[2].metadata.semantic_kind,
            Some(MessageSemanticKind::CompressionSummary)
        );
        assert_eq!(result.messages[3].id, user3.id);
        assert_eq!(result.messages[4].id, assistant3.id);
        assert_eq!(
            result.messages[5].internal_reminder_kind(),
            Some(InternalReminderKind::CompressionContinuation)
        );
        let MessageContent::Text(summary_text) = &result.messages[2].content else {
            panic!("expected summary text");
        };
        assert!(summary_text.starts_with("<system_reminder>\n"));
        assert!(summary_text.ends_with("\n</system_reminder>"));
        assert_eq!(summary_text.matches("<system_reminder>").count(), 1);
        assert_eq!(summary_text.matches("</system_reminder>").count(), 1);
        assert!(summary_text.contains(
            "Summary of the earlier conversation:\n<summary>\nModel summary\n</summary>"
        ));
        assert!(summary_text.contains("Model summary"));
        assert!(!summary_text.contains("Most recent user message before this summary"));
        assert!(!summary_text.contains("Most recent task list snapshot before this summary"));
        assert!(!summary_text.contains(ContextCompressor::COMPRESSION_CONTINUATION_REMINDER));
        assert_eq!(
            result.messages[5].content.to_string(),
            render_system_reminder(ContextCompressor::COMPRESSION_CONTINUATION_REMINDER)
        );

        let uri = "openbitfun://current-session/artifacts/compression-transcripts/12-a3f9.txt";
        let index_range = TranscriptLineRange {
            start_line: 1,
            end_line: 14,
        };
        assert!(compressor.append_transcript_reference(&mut result, uri, &index_range));
        let MessageContent::Text(summary_text) = &result.messages[2].content else {
            panic!("expected summary text");
        };
        assert!(summary_text.contains(uri));
        let summary_end = summary_text.find("</summary>").expect("summary tag exists");
        let transcript_start = summary_text
            .find("The complete conversation history")
            .expect("transcript reference exists");
        assert!(summary_end < transcript_start);
        assert!(summary_text.ends_with("\n</system_reminder>"));
        assert!(!summary_text.contains(ContextCompressor::COMPRESSION_CONTINUATION_REMINDER));
        assert_eq!(
            result.messages[5].content.to_string(),
            render_system_reminder(ContextCompressor::COMPRESSION_CONTINUATION_REMINDER)
        );
    }

    #[test]
    fn recompression_replaces_the_previous_continuation_reminder() {
        let compressor = ContextCompressor::new();
        let old_reminder = Message::internal_reminder(
            InternalReminderKind::CompressionContinuation,
            "old continuation",
        );
        let messages = vec![
            Message::system("system".to_string()),
            Message::user("older request".to_string()),
            Message::assistant("older answer".to_string()),
            old_reminder.clone(),
            Message::user("new request".to_string()),
            Message::assistant("new answer".to_string()),
        ];

        let plan = compressor
            .plan_compression("session", &messages, 128_000, 1)
            .expect("planning succeeds")
            .expect("plan exists");

        assert!(!plan
            .summary_request_messages
            .iter()
            .any(|message| message.id == old_reminder.id));
        assert!(!plan
            .recent_tail_messages
            .iter()
            .any(|message| message.id == old_reminder.id));

        let result = compressor
            .compress_plan_with_contract("session", plan, None, "updated summary".to_string())
            .expect("compression succeeds");

        assert_eq!(
            result
                .messages
                .iter()
                .filter(|message| {
                    message.internal_reminder_kind()
                        == Some(InternalReminderKind::CompressionContinuation)
                })
                .count(),
            1
        );
    }

    #[test]
    fn conditional_instruction_reminders_do_not_enter_any_compacted_context() {
        let compressor = ContextCompressor::new();
        let summarized_reminder = Message::internal_reminder(
            InternalReminderKind::ConditionalInstructions,
            "older path rule",
        );
        let recent_reminder = Message::internal_reminder(
            InternalReminderKind::ConditionalInstructions,
            "recent path rule",
        );
        let messages = vec![
            Message::system("system".to_string()),
            Message::user("older request".repeat(200)),
            summarized_reminder.clone(),
            Message::assistant("older answer".repeat(200)),
            Message::user("current request".to_string()),
            recent_reminder.clone(),
            Message::assistant("current answer".to_string()),
        ];

        let plan = compressor
            .plan_compression("session", &messages, 128_000, 100)
            .expect("planning succeeds")
            .expect("plan exists");

        for reminder in [summarized_reminder, recent_reminder] {
            assert!(!plan
                .summary_request_messages
                .iter()
                .any(|message| message.id == reminder.id));
            assert!(!plan
                .summary_messages
                .iter()
                .any(|message| message.id == reminder.id));
            assert!(!plan
                .recent_tail_messages
                .iter()
                .any(|message| message.id == reminder.id));
        }
    }

    #[test]
    fn retained_user_messages_use_only_the_token_budget_without_a_count_limit() {
        let messages: Vec<Message> = (0..25)
            .map(|index| Message::user(format!("user-{index}")))
            .collect();
        let total_tokens = messages
            .iter()
            .map(|message| message.estimate_tokens_with_reasoning(true))
            .sum();

        let (retained, retained_tokens) =
            ContextCompressor::retain_historical_user_messages(&messages, total_tokens);

        assert_eq!(retained.len(), 25);
        assert_eq!(retained_tokens, total_tokens);
    }

    #[test]
    fn retained_user_token_budget_is_ten_percent_capped_at_twenty_thousand() {
        let compressor = ContextCompressor::new();
        let messages = vec![
            Message::system("system".to_string()),
            Message::user("older request".to_string()),
            Message::assistant("older answer".to_string()),
            Message::user("current request".to_string()),
            Message::assistant("current answer".to_string()),
        ];

        let smaller = compressor
            .plan_compression("session", &messages, 50_000, 1)
            .expect("planning succeeds")
            .expect("plan exists");
        let larger = compressor
            .plan_compression("session", &messages, 200_000, 1)
            .expect("planning succeeds")
            .expect("plan exists");

        assert_eq!(smaller.retained_user_token_budget, 5_000);
        assert_eq!(larger.retained_user_token_budget, 20_000);
    }

    #[test]
    fn retained_user_messages_drop_the_older_prefix_when_the_next_message_does_not_fit() {
        let oldest = Message::user("oldest".to_string());
        let too_large = Message::user("large".repeat(500));
        let newest = Message::user("newest".to_string());
        let budget = newest.estimate_tokens_with_reasoning(true);

        let (retained, retained_tokens) = ContextCompressor::retain_historical_user_messages(
            &[oldest, too_large, newest.clone()],
            budget,
        );

        assert_eq!(retained.len(), 1);
        assert_eq!(retained[0].id, newest.id);
        assert_eq!(retained_tokens, budget);
    }

    #[test]
    fn retained_user_messages_are_empty_when_the_newest_candidate_exceeds_the_budget() {
        let older = Message::user("older".to_string());
        let newest = Message::user("newest".repeat(500));

        let (retained, retained_tokens) =
            ContextCompressor::retain_historical_user_messages(&[older, newest], 1);

        assert!(retained.is_empty());
        assert_eq!(retained_tokens, 0);
    }

    #[test]
    fn model_summary_output_trims_plain_text() {
        let normalized = ContextCompressor::normalize_model_summary_output("  Plain summary\n");

        assert_eq!(normalized.as_deref(), Some("Plain summary"));
    }

    #[test]
    fn empty_model_summary_output_is_rejected() {
        let normalized = ContextCompressor::normalize_model_summary_output(" \n\t ");

        assert_eq!(normalized, None);
    }
}
