use crate::agentic::image_analysis::ImageContextData;
use crate::util::types::{Message as AIMessage, ToolCall as AIToolCall, ToolImageAttachment};
use crate::util::TokenCounter;
use log::warn;
use openbitfun_agent_runtime::prompt_markup::is_system_reminder_only;
use openbitfun_core_types::{ModelResponseReplay, ReasoningContentKind};
pub use openbitfun_runtime_ports::{CompressionContract, CompressionContractItem};
use serde::{Deserialize, Serialize};
use std::fmt::{self, Display};
use std::time::SystemTime;
use uuid::Uuid;

// ============ Message ============

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct Message {
    /// Identity of a stable history message. After publication to stable context,
    /// changing content or compression-relevant semantics must allocate a new ID.
    /// Token bookkeeping and temporary provider projections do not replace history.
    pub id: String,
    pub role: MessageRole,
    pub content: MessageContent,
    pub timestamp: SystemTime,
    pub metadata: MessageMetadata,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub enum MessageRole {
    User,
    Assistant,
    Tool,
    System,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub enum MessageContent {
    Text(String),
    Multimodal {
        text: String,
        images: Vec<ImageContextData>,
    },
    ToolResult {
        tool_id: String,
        tool_name: String,
        #[serde(default, skip_serializing_if = "Option::is_none")]
        effective_tool_name: Option<String>,
        result: serde_json::Value,
        result_for_assistant: Option<String>,
        is_error: bool,
        #[serde(default, skip_serializing_if = "Option::is_none")]
        image_attachments: Option<Vec<ToolImageAttachment>>,
    },
    Mixed {
        /// Reasoning content (for interleaved thinking mode)
        reasoning_content: Option<String>,
        text: String,
        tool_calls: Vec<ToolCall>,
    },
}

#[derive(Debug, Clone, Default, Serialize, Deserialize)]
pub struct MessageMetadata {
    pub turn_id: Option<String>,
    pub round_id: Option<String>,
    pub tokens: Option<usize>,
    /// Anthropic extended thinking signature (for passing back in multi-turn conversations)
    #[serde(skip_serializing_if = "Option::is_none")]
    pub thinking_signature: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub reasoning_content_kind: Option<ReasoningContentKind>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub semantic_kind: Option<MessageSemanticKind>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub internal_reminder_kind: Option<InternalReminderKind>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub compression_payload: Option<CompressionPayload>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub memory_citation: Option<MemoryCitation>,
    /// Stable source identities carried only by conditional instruction
    /// reminders so activation can be reconstructed from persisted history.
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub activated_instruction_sources: Vec<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub model_response_replay: Option<ModelResponseReplay>,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum MessageSemanticKind {
    ActualUserInput,
    InternalReminder,
    CompressionBoundaryMarker,
    CompressionSummary,
    /// Shown in chat after Computer use; omitted from model API requests (see `build_ai_messages_for_send`).
    ComputerUseVerificationScreenshot,
    /// Full-screen snapshot appended after mutating ComputerUse tool results within the same turn;
    /// **included** in the next model request so the agent sees the desktop without calling screenshot again.
    ComputerUsePostActionSnapshot,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum InternalReminderKind {
    Generic,
    SkillListingDiff,
    AgentListingDiff,
    AgentMode,
    SideQuestion,
    InitAgentsMd,
    ScheduledJob,
    ForkSubagent,
    GoalMode,
    GoalContinuation,
    GoalObjectiveUpdated,
    RemoteFileDelivery,
    SessionMessageRequest,
    SessionMessageReply,
    LoopRecovery,
    PeriodicLoopRecovery,
    UserSteering,
    BackgroundResult,
    InterruptedContinue,
    ThinkingOnlyRescue,
    FinalizeCacheAnchor,
    /// Re-establishes execution after compaction; replaced by the next compaction.
    CompressionContinuation,
    /// A Stop hook blocked the end of a turn and asked the agent to continue.
    StopHookBlock,
    /// Model-visible context contributed by a SessionStart or
    /// UserPromptSubmit hook.
    HookContext,
    /// Instructions activated after a successful read of a matching file.
    ConditionalInstructions,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct MemoryCitation {
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub entries: Vec<MemoryCitationEntry>,
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub rollout_ids: Vec<String>,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct MemoryCitationEntry {
    pub path: String,
    pub line_start: u32,
    pub line_end: u32,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub note: Option<String>,
}

impl InternalReminderKind {
    pub fn should_drop_during_compaction(self) -> bool {
        matches!(
            self,
            Self::SkillListingDiff
                | Self::AgentListingDiff
                | Self::LoopRecovery
                | Self::PeriodicLoopRecovery
                | Self::InterruptedContinue
                | Self::ThinkingOnlyRescue
                | Self::FinalizeCacheAnchor
                | Self::CompressionContinuation
                | Self::ConditionalInstructions
                // Mid-turn scaffolding: the Stop hook's feedback matters only
                // while the reopened turn is still running. HookContext is
                // deliberately absent — it carries real context a hook asked
                // the model to keep.
                | Self::StopHookBlock
        )
    }

    pub fn is_listing_diff(self) -> bool {
        matches!(self, Self::SkillListingDiff | Self::AgentListingDiff)
    }
}

#[derive(Debug, Clone, Default, Serialize, Deserialize)]
pub struct CompressionPayload {
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub entries: Vec<CompressionEntry>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(tag = "kind", rename_all = "snake_case")]
pub enum CompressionEntry {
    Contract {
        contract: CompressionContract,
    },
    ModelSummary {
        text: String,
    },
    Turn {
        #[serde(skip_serializing_if = "Option::is_none")]
        turn_id: Option<String>,
        #[serde(default, skip_serializing_if = "Vec::is_empty")]
        messages: Vec<CompressedMessage>,
        #[serde(skip_serializing_if = "Option::is_none")]
        todo: Option<CompressedTodoSnapshot>,
    },
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct CompressedMessage {
    pub role: CompressedMessageRole,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub text: Option<String>,
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub tool_calls: Vec<CompressedToolCall>,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum CompressedMessageRole {
    User,
    Assistant,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct CompressedToolCall {
    pub tool_name: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub arguments: Option<serde_json::Value>,
    #[serde(default, skip_serializing_if = "is_false")]
    pub is_error: bool,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct CompressedTodoSnapshot {
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub todos: Vec<CompressedTodoItem>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub summary: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct CompressedTodoItem {
    #[serde(skip_serializing_if = "Option::is_none")]
    pub id: Option<String>,
    pub content: String,
    pub status: String,
}

impl CompressionPayload {
    pub fn from_summary(text: String) -> Self {
        Self {
            entries: vec![CompressionEntry::ModelSummary { text }],
        }
    }

    pub fn is_empty(&self) -> bool {
        self.entries.is_empty()
    }
}

fn is_false(value: &bool) -> bool {
    !*value
}

impl From<Message> for AIMessage {
    fn from(msg: Message) -> Self {
        let role = match msg.role {
            MessageRole::User => "user",
            MessageRole::Assistant => "assistant",
            MessageRole::Tool => "tool",
            MessageRole::System => "system",
        };
        let thinking_signature = msg.metadata.thinking_signature.clone();
        let reasoning_content_kind = msg.metadata.reasoning_content_kind;
        let model_response_replay = msg.metadata.model_response_replay.clone();

        match msg.content {
            MessageContent::Text(text) => {
                // Check if text is empty to avoid sending empty content to API
                let content = if text.trim().is_empty() {
                    // Should not have empty text messages, but provide default value for defensive programming
                    warn!("Empty text message detected: role={}", role);
                    if role == "user" {
                        Some("(empty message)".to_string())
                    } else if role == "system" {
                        Some("You are a helpful assistant.".to_string())
                    } else {
                        Some(" ".to_string()) // Minimum valid value
                    }
                } else {
                    Some(text)
                };

                Self {
                    role: role.to_string(),
                    content,
                    reasoning_content: None,
                    thinking_signature: None,
                    tool_calls: None,
                    tool_call_id: None,
                    name: None,
                    is_error: None,
                    tool_image_attachments: None,
                    model_response_replay: model_response_replay.clone(),
                }
            }
            MessageContent::Multimodal { text, images } => {
                let mut content = text;
                if !images.is_empty() {
                    content.push_str("\n\n[Attached image(s):\n");
                    for image in images {
                        let name = image
                            .metadata
                            .as_ref()
                            .and_then(|m| m.get("name"))
                            .and_then(|v| v.as_str())
                            .filter(|s| !s.is_empty())
                            .map(str::to_string)
                            .or_else(|| {
                                image.image_path.as_ref().filter(|s| !s.is_empty()).cloned()
                            })
                            .unwrap_or_else(|| image.id.clone());

                        content.push_str(&format!("- {} ({})\n", name, image.mime_type));
                    }
                    content.push(']');
                }

                Self {
                    role: "user".to_string(),
                    content: Some(content),
                    reasoning_content: None,
                    thinking_signature: None,
                    tool_calls: None,
                    tool_call_id: None,
                    name: None,
                    is_error: None,
                    tool_image_attachments: None,
                    model_response_replay: model_response_replay.clone(),
                }
            }
            MessageContent::Mixed {
                mut reasoning_content,
                text,
                tool_calls,
            } => {
                if reasoning_content_kind == Some(ReasoningContentKind::Summary) {
                    reasoning_content = None;
                }
                let converted_tool_calls = if tool_calls.is_empty() {
                    // Set to None when tool_call is empty to avoid deepseek model errors
                    None
                } else {
                    Some(
                        tool_calls
                            .into_iter()
                            .map(|tc| AIToolCall {
                                id: tc.tool_id,
                                name: tc.tool_name,
                                arguments: tc.arguments,
                                raw_arguments: tc.raw_arguments,
                            })
                            .collect(),
                    )
                };

                // When there are tool_calls, empty text should use None
                let content = if text.trim().is_empty() {
                    None // OpenAI API allows content to be null when assistant + tool_calls
                } else {
                    Some(text)
                };

                // Reasoning content (interleaved thinking mode)
                Self {
                    role: "assistant".to_string(),
                    content,
                    reasoning_content,
                    thinking_signature: thinking_signature.clone(),
                    tool_calls: converted_tool_calls,
                    tool_call_id: None,
                    name: None,
                    is_error: None,
                    tool_image_attachments: None,
                    model_response_replay: model_response_replay.clone(),
                }
            }
            MessageContent::ToolResult {
                tool_id,
                tool_name,
                effective_tool_name: _,
                result,
                result_for_assistant,
                is_error,
                image_attachments,
            } => {
                // Tool messages must include tool_call_id
                // Prefer result_for_assistant (text specifically for AI), if None or empty then use result (data field)
                let content_for_ai = if let Some(assistant_text) = result_for_assistant {
                    // Check if empty string
                    if assistant_text.trim().is_empty() {
                        // If empty, use serialized result
                        serde_json::to_string(&result)
                            .unwrap_or(format!("Tool {} execution completed", tool_name))
                    } else {
                        assistant_text
                    }
                } else {
                    // If no result_for_assistant, use serialized result
                    serde_json::to_string(&result)
                        .unwrap_or(format!("Tool {} execution completed", tool_name))
                };

                Self {
                    role: "tool".to_string(),
                    content: Some(content_for_ai),
                    reasoning_content: None,
                    thinking_signature: None,
                    tool_calls: None,
                    tool_call_id: Some(tool_id),
                    name: Some(tool_name),
                    is_error: Some(is_error),
                    tool_image_attachments: image_attachments.clone(),
                    model_response_replay: model_response_replay.clone(),
                }
            }
        }
    }
}

impl From<&Message> for AIMessage {
    fn from(msg: &Message) -> Self {
        // Reference version calls owned version after clone to avoid duplicate logic
        AIMessage::from(msg.clone())
    }
}

impl Message {
    pub fn system(text: String) -> Self {
        Self {
            id: Uuid::new_v4().to_string(),
            role: MessageRole::System,
            content: MessageContent::Text(text),
            timestamp: SystemTime::now(),
            metadata: MessageMetadata::default(),
        }
    }

    pub fn user(text: String) -> Self {
        Self {
            id: Uuid::new_v4().to_string(),
            role: MessageRole::User,
            content: MessageContent::Text(text),
            timestamp: SystemTime::now(),
            metadata: MessageMetadata::default(),
        }
    }

    pub fn internal_reminder(reminder_kind: InternalReminderKind, text: impl Into<String>) -> Self {
        Self::user(Self::render_internal_reminder(text))
            .with_semantic_kind(MessageSemanticKind::InternalReminder)
            .with_internal_reminder_kind(reminder_kind)
    }

    /// An internal reminder that also carries images — used when a message that
    /// arrives mid-turn (steering) has attachments, so the model sees the same
    /// multimodal payload it would have seen at a turn boundary.
    pub fn internal_reminder_multimodal(
        reminder_kind: InternalReminderKind,
        text: impl Into<String>,
        images: Vec<ImageContextData>,
    ) -> Self {
        Self::user_multimodal(Self::render_internal_reminder(text), images)
            .with_semantic_kind(MessageSemanticKind::InternalReminder)
            .with_internal_reminder_kind(reminder_kind)
    }

    fn render_internal_reminder(text: impl Into<String>) -> String {
        let text = text.into();
        if crate::agentic::core::has_prompt_markup(&text) {
            text
        } else {
            crate::agentic::core::render_system_reminder(&text)
        }
    }

    pub fn user_multimodal(text: String, images: Vec<ImageContextData>) -> Self {
        Self {
            id: Uuid::new_v4().to_string(),
            role: MessageRole::User,
            content: MessageContent::Multimodal { text, images },
            timestamp: SystemTime::now(),
            metadata: MessageMetadata::default(),
        }
    }

    pub fn assistant(text: String) -> Self {
        Self {
            id: Uuid::new_v4().to_string(),
            role: MessageRole::Assistant,
            content: MessageContent::Text(text),
            timestamp: SystemTime::now(),
            metadata: MessageMetadata::default(),
        }
    }

    pub fn assistant_with_tools(text: String, tool_calls: Vec<ToolCall>) -> Self {
        Self {
            id: Uuid::new_v4().to_string(),
            role: MessageRole::Assistant,
            content: MessageContent::Mixed {
                reasoning_content: None,
                text,
                tool_calls,
            },
            timestamp: SystemTime::now(),
            metadata: MessageMetadata::default(),
        }
    }

    /// Create assistant message with reasoning content (supports interleaved thinking mode)
    pub fn assistant_with_reasoning(
        reasoning_content: Option<String>,
        text: String,
        tool_calls: Vec<ToolCall>,
    ) -> Self {
        Self {
            id: Uuid::new_v4().to_string(),
            role: MessageRole::Assistant,
            content: MessageContent::Mixed {
                reasoning_content,
                text,
                tool_calls,
            },
            timestamp: SystemTime::now(),
            metadata: MessageMetadata::default(),
        }
    }

    pub fn tool_result(result: ToolResult) -> Self {
        Self {
            id: Uuid::new_v4().to_string(),
            role: MessageRole::Tool,
            content: MessageContent::ToolResult {
                tool_id: result.tool_id.clone(),
                tool_name: result.tool_name.clone(),
                effective_tool_name: result.effective_tool_name.clone(),
                result: result.result.clone(),
                result_for_assistant: result.result_for_assistant.clone(),
                is_error: result.is_error,
                image_attachments: result.image_attachments.clone(),
            },
            timestamp: SystemTime::now(),
            metadata: MessageMetadata::default(),
        }
    }

    /// Check if message should be treated as an actual user-turn boundary.
    pub fn is_actual_user_message(&self) -> bool {
        if self.role != MessageRole::User {
            return false;
        }
        if let Some(semantic_kind) = self.metadata.semantic_kind {
            return semantic_kind == MessageSemanticKind::ActualUserInput;
        }
        let text = match &self.content {
            MessageContent::Text(text) => Some(text.as_str()),
            MessageContent::Multimodal { text, .. } => Some(text.as_str()),
            _ => None,
        };
        if text.is_some_and(is_system_reminder_only) {
            return false;
        }
        true
    }

    /// Set message's turn_id (to identify which dialog turn the message belongs to)
    pub fn with_turn_id(mut self, turn_id: String) -> Self {
        self.metadata.turn_id = Some(turn_id);
        self
    }

    /// Set message's round_id (to identify which model round the message belongs to)
    pub fn with_round_id(mut self, round_id: String) -> Self {
        self.metadata.round_id = Some(round_id);
        self
    }

    pub fn with_semantic_kind(mut self, semantic_kind: MessageSemanticKind) -> Self {
        self.metadata.semantic_kind = Some(semantic_kind);
        self
    }

    pub fn with_internal_reminder_kind(mut self, reminder_kind: InternalReminderKind) -> Self {
        self.metadata.internal_reminder_kind = Some(reminder_kind);
        self
    }

    pub fn internal_reminder_kind(&self) -> Option<InternalReminderKind> {
        self.metadata.internal_reminder_kind
    }

    pub fn with_activated_instruction_sources(mut self, sources: Vec<String>) -> Self {
        self.metadata.activated_instruction_sources = sources;
        self
    }

    pub fn activated_instruction_sources(&self) -> &[String] {
        &self.metadata.activated_instruction_sources
    }

    pub fn with_compression_payload(mut self, compression_payload: CompressionPayload) -> Self {
        self.metadata.compression_payload = Some(compression_payload);
        self.metadata.tokens = None;
        self
    }

    /// Set message's thinking_signature (for Anthropic extended thinking multi-turn conversations)
    pub fn with_thinking_signature(mut self, signature: Option<String>) -> Self {
        self.metadata.thinking_signature = signature;
        self
    }

    pub fn with_reasoning_content_kind(
        mut self,
        reasoning_content_kind: Option<ReasoningContentKind>,
    ) -> Self {
        self.metadata.reasoning_content_kind = reasoning_content_kind;
        self
    }

    pub fn with_memory_citation(mut self, memory_citation: Option<MemoryCitation>) -> Self {
        self.metadata.memory_citation = memory_citation;
        self
    }

    pub fn with_model_response_replay(
        mut self,
        model_response_replay: Option<ModelResponseReplay>,
    ) -> Self {
        self.metadata.model_response_replay = model_response_replay;
        self
    }

    /// Get message's token count
    pub fn get_tokens(&mut self) -> usize {
        if let Some(tokens) = self.metadata.tokens {
            return tokens;
        }
        let tokens = self.estimate_tokens();
        self.metadata.tokens = Some(tokens);
        tokens
    }

    fn estimate_image_tokens(metadata: Option<&serde_json::Value>) -> usize {
        let (width, height) = metadata
            .and_then(|m| {
                let w = m.get("width").and_then(|v| v.as_u64());
                let h = m.get("height").and_then(|v| v.as_u64());
                match (w, h) {
                    (Some(w), Some(h)) if w > 0 && h > 0 => Some((w as u32, h as u32)),
                    _ => None,
                }
            })
            .unwrap_or((1024, 1024));

        let tiles_w = width.div_ceil(512);
        let tiles_h = height.div_ceil(512);
        let tiles = (tiles_w.max(1) * tiles_h.max(1)) as usize;
        50 + tiles * 200
    }

    pub fn estimate_tokens_with_reasoning(&self, include_reasoning: bool) -> usize {
        let mut total = 0usize;
        total += 4;

        match &self.content {
            MessageContent::Text(text) => {
                total += TokenCounter::estimate_tokens(text);
            }
            MessageContent::Multimodal { text, images } => {
                total += TokenCounter::estimate_tokens(text);
                for image in images {
                    total += Self::estimate_image_tokens(image.metadata.as_ref());
                }
            }
            MessageContent::Mixed {
                reasoning_content,
                text,
                tool_calls,
            } => {
                if include_reasoning {
                    if let Some(reasoning) = reasoning_content.as_ref() {
                        total += TokenCounter::estimate_tokens(reasoning);
                    }
                }
                total += TokenCounter::estimate_tokens(text);

                for tool_call in tool_calls {
                    total += TokenCounter::estimate_tokens(&tool_call.tool_name);
                    let serialized_arguments = tool_call
                        .raw_arguments
                        .clone()
                        .filter(|raw| serde_json::from_str::<serde_json::Value>(raw).is_ok())
                        .unwrap_or_else(|| {
                            serde_json::to_string(&tool_call.arguments)
                                .unwrap_or_else(|_| "{}".to_string())
                        });
                    total += TokenCounter::estimate_tokens(&serialized_arguments);
                    total += 10;
                }
            }
            MessageContent::ToolResult {
                tool_name,
                result,
                result_for_assistant,
                image_attachments,
                ..
            } => {
                if let Some(text) = result_for_assistant.as_ref().filter(|s| !s.is_empty()) {
                    total += TokenCounter::estimate_tokens(text);
                } else if let Ok(json_str) = serde_json::to_string(result) {
                    total += TokenCounter::estimate_tokens(&json_str);
                } else {
                    total += TokenCounter::estimate_tokens(tool_name);
                }
                if let Some(imgs) = image_attachments {
                    for _ in imgs {
                        total += Self::estimate_image_tokens(None);
                    }
                }
            }
        }

        total
    }

    fn estimate_tokens(&self) -> usize {
        self.estimate_tokens_with_reasoning(true)
    }
}

impl Display for MessageContent {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        match self {
            MessageContent::Text(text) => write!(f, "{}", text),
            MessageContent::Multimodal { text, images } => write!(
                f,
                "Multimodal: text_length={}, images={}",
                text.len(),
                images.len()
            ),
            MessageContent::ToolResult {
                tool_id,
                tool_name,
                effective_tool_name: _,
                result,
                result_for_assistant,
                is_error,
                image_attachments,
            } => write!(
                f,
                "ToolResult: tool_id={}, tool_name={}, result={}, result_for_assistant={:?}, is_error={}, images={}",
                tool_id,
                tool_name,
                result,
                result_for_assistant,
                is_error,
                image_attachments.as_ref().map(|v| v.len()).unwrap_or(0)
            ),
            MessageContent::Mixed {
                reasoning_content,
                text,
                tool_calls,
            } => write!(
                f,
                "Mixed: reasoning_content={:?}, text={}, tool_calls={}",
                reasoning_content,
                text,
                tool_calls
                    .iter()
                    .map(|tc| format!(
                        "ToolCall: tool_id={}, tool_name={}, arguments={}",
                        tc.tool_id, tc.tool_name, tc.arguments
                    ))
                    .collect::<Vec<String>>()
                    .join(", ")
            ),
        }
    }
}

#[cfg(test)]
mod tests {
    use super::{Message, ToolCall};
    use crate::util::types::Message as AIMessage;
    use openbitfun_agent_stream::ToolArgumentRepairKind;
    use openbitfun_core_types::{
        ModelResponseReplay, ModelResponseReplayItem, ReasoningContentKind,
    };
    use serde_json::json;

    #[test]
    fn preserves_empty_reasoning_content_for_provider_replay() {
        let msg = Message::assistant_with_reasoning(Some(String::new()), String::new(), vec![])
            .with_thinking_signature(Some("sig_1".to_string()));

        let ai_msg = AIMessage::from(msg);

        assert_eq!(ai_msg.reasoning_content.as_deref(), Some(""));
        assert_eq!(ai_msg.thinking_signature.as_deref(), Some("sig_1"));
    }

    #[test]
    fn reasoning_summary_is_not_sent_as_generic_reasoning_content() {
        let msg = Message::assistant_with_reasoning(
            Some("display summary".to_string()),
            "answer".to_string(),
            vec![],
        )
        .with_reasoning_content_kind(Some(ReasoningContentKind::Summary));

        let ai_msg = AIMessage::from(msg);

        assert!(ai_msg.reasoning_content.is_none());
        assert_eq!(ai_msg.content.as_deref(), Some("answer"));
    }

    #[test]
    fn legacy_message_without_reasoning_content_kind_still_deserializes() {
        let message = Message::assistant_with_reasoning(
            Some("legacy reasoning".to_string()),
            "answer".to_string(),
            vec![],
        );
        let mut encoded = serde_json::to_value(message).expect("serialize message");
        encoded["metadata"]
            .as_object_mut()
            .expect("metadata object")
            .remove("reasoning_content_kind");

        let restored: Message = serde_json::from_value(encoded).expect("legacy message");
        assert!(restored.metadata.reasoning_content_kind.is_none());
    }

    #[test]
    fn persists_and_restores_model_response_replay() {
        let message = Message::assistant("done".to_string()).with_model_response_replay(Some(
            ModelResponseReplay {
                protocol: "openai_responses".to_string(),
                items: vec![ModelResponseReplayItem::OpaqueReasoning {
                    item_id: Some("rs_1".to_string()),
                    summary: vec![],
                    opaque_state: "opaque".to_string(),
                }],
            },
        ));

        let encoded = serde_json::to_string(&message).expect("serialize message");
        let restored: Message = serde_json::from_str(&encoded).expect("deserialize message");
        let replay = restored
            .metadata
            .model_response_replay
            .expect("restored replay");

        assert_eq!(replay.protocol, "openai_responses");
        assert!(matches!(
            &replay.items[0],
            ModelResponseReplayItem::OpaqueReasoning { opaque_state, .. }
                if opaque_state == "opaque"
        ));
    }

    #[test]
    fn legacy_message_without_model_response_replay_still_deserializes() {
        let message = Message::assistant("done".to_string());
        let mut encoded = serde_json::to_value(message).expect("serialize message");
        encoded["metadata"]
            .as_object_mut()
            .expect("metadata object")
            .remove("model_response_replay");

        let restored: Message = serde_json::from_value(encoded).expect("legacy message");
        assert!(restored.metadata.model_response_replay.is_none());
    }

    #[test]
    fn carries_model_response_replay_into_adapter_message() {
        let message = Message::assistant("done".to_string()).with_model_response_replay(Some(
            ModelResponseReplay {
                protocol: "openai_responses".to_string(),
                items: vec![ModelResponseReplayItem::AssistantMessage],
            },
        ));

        let ai_message = AIMessage::from(message);
        assert!(ai_message.model_response_replay.is_some());
    }

    #[test]
    fn preserves_tool_argument_repair_provenance_from_stream_contract() {
        let tool_call = ToolCall::from(openbitfun_agent_stream::ToolCall {
            tool_id: "call_1".to_string(),
            tool_name: "Read".to_string(),
            arguments: json!({ "path": "src/main.rs" }),
            raw_arguments: Some(r#"{"path":"src/main.rs" "line_end":4}"#.to_string()),
            is_error: false,
            parse_error: None,
            recovered_from_truncation: false,
            repair_kind: ToolArgumentRepairKind::PermissiveNormalToolJsonRepair,
        });

        assert_eq!(
            tool_call.repair_kind,
            ToolArgumentRepairKind::PermissiveNormalToolJsonRepair
        );
        assert!(!tool_call.recovered_from_truncation);
    }
}

// ============ Tool Calls and Results ============

#[derive(Debug, Clone, Default, Serialize, Deserialize)]
pub struct ToolCall {
    pub tool_id: String,
    pub tool_name: String,
    pub arguments: serde_json::Value,
    /// Original provider-emitted argument JSON, preserved for replay stability when available.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub raw_arguments: Option<String>,
    /// Record whether tool parameters are valid
    #[serde(default)]
    pub is_error: bool,
    /// Original JSON parser error when the provider emitted invalid arguments.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub parse_error: Option<String>,
    /// True when the raw JSON arguments were truncated mid-stream and we
    /// successfully repaired them. Downstream consumers can flag this to the
    /// model so it understands the content may be incomplete.
    #[serde(default, skip_serializing_if = "std::ops::Not::not")]
    pub recovered_from_truncation: bool,
    /// Provenance for any argument repair accepted before tool validation.
    #[serde(
        default,
        skip_serializing_if = "openbitfun_agent_stream::ToolArgumentRepairKind::is_none"
    )]
    pub repair_kind: openbitfun_agent_stream::ToolArgumentRepairKind,
}

impl ToolCall {
    pub fn is_valid(&self) -> bool {
        !self.tool_id.is_empty() && !self.tool_name.is_empty() && !self.is_error
    }
}

impl From<openbitfun_agent_stream::ToolCall> for ToolCall {
    fn from(tool_call: openbitfun_agent_stream::ToolCall) -> Self {
        Self {
            tool_id: tool_call.tool_id,
            tool_name: tool_call.tool_name,
            arguments: tool_call.arguments,
            raw_arguments: tool_call.raw_arguments,
            is_error: tool_call.is_error,
            parse_error: tool_call.parse_error,
            recovered_from_truncation: tool_call.recovered_from_truncation,
            repair_kind: tool_call.repair_kind,
        }
    }
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct ToolResult {
    pub tool_id: String,
    /// Provider-facing tool name. Deferred calls retain the gateway name.
    pub tool_name: String,
    /// Runtime target for internal persistence, classification, and UI projection.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub effective_tool_name: Option<String>,
    pub result: serde_json::Value,
    /// Result text specifically for passing to AI assistant (if None, then use result)
    pub result_for_assistant: Option<String>,
    pub is_error: bool,
    pub duration_ms: Option<u64>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub image_attachments: Option<Vec<ToolImageAttachment>>,
}

impl From<ToolCall> for AIToolCall {
    fn from(tc: ToolCall) -> Self {
        Self {
            id: tc.tool_id.clone(),
            name: tc.tool_name.clone(),
            arguments: tc.arguments,
            raw_arguments: tc.raw_arguments,
        }
    }
}
