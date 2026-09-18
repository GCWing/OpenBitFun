use std::collections::{HashMap, HashSet, VecDeque};
/// Chat state module
///
/// Pure UI rendering state for the chat interface.
/// All session lifecycle and persistence is handled by openbitfun-core.
/// This module only maintains transient state needed for TUI rendering.
use std::time::{Duration, SystemTime, UNIX_EPOCH};

use openbitfun_agent_runtime::prompt_markup::strip_prompt_markup;
use openbitfun_agent_runtime::sdk::{
    PermissionRequest, SessionTranscript, TranscriptContent, TranscriptMessage,
};
use openbitfun_agent_tools::effective_tool_invocation;
use openbitfun_events::ToolEventData;
use openbitfun_runtime_ports::{AgentSessionWorkspaceBinding, SessionExecutionTarget};

use crate::ui::permission::PermissionPrompt;
use crate::ui::question::QuestionPrompt;

// ============ Display Status Types ============

/// Tool display status (for UI rendering)
#[derive(Debug, Clone, PartialEq)]
pub(crate) enum ToolDisplayStatus {
    EarlyDetected,
    ParamsPartial,
    Queued,
    Waiting,
    ConfirmationNeeded,
    Confirmed,
    Rejected,
    Pending,
    Running,
    Streaming,
    Success,
    Failed,
    Cancelled,
}

impl ToolDisplayStatus {
    /// Returns true if the tool has entered an active execution phase
    /// (Running, Streaming, or any terminal state). Early pipeline stages
    /// (ParamsPartial, Queued, Waiting) should not overwrite these states,
    /// since priority queue ordering can cause late-arriving low-priority
    /// events to arrive after high-priority state transitions.
    pub(crate) fn is_execution_phase(&self) -> bool {
        matches!(
            self,
            ToolDisplayStatus::Running
                | ToolDisplayStatus::Streaming
                | ToolDisplayStatus::Success
                | ToolDisplayStatus::Failed
                | ToolDisplayStatus::Cancelled
                | ToolDisplayStatus::Rejected
        )
    }
}

/// Message role for display
#[derive(Debug, Clone, PartialEq)]
pub(crate) enum MessageRole {
    User,
    Assistant,
    System,
    Tool,
}

impl From<&str> for MessageRole {
    fn from(role: &str) -> Self {
        match role {
            "user" => MessageRole::User,
            "assistant" => MessageRole::Assistant,
            "tool" => MessageRole::Tool,
            _ => MessageRole::System,
        }
    }
}

pub(crate) fn transcript_role_label(role: &str) -> &'static str {
    match role {
        "user" => "User",
        "assistant" => "Assistant",
        "tool" => "Tool",
        "system" => "System",
        _ => "Unknown",
    }
}

pub(crate) fn transcript_message_preview(message: &TranscriptMessage) -> String {
    match &message.content {
        TranscriptContent::Text(text) => text.lines().next().unwrap_or("").to_string(),
        TranscriptContent::Multimodal { text, image_count } => {
            if text.is_empty() {
                format!("[{image_count} images]")
            } else {
                text.lines().next().unwrap_or("").to_string()
            }
        }
        TranscriptContent::Mixed {
            text, tool_calls, ..
        } => {
            if text.is_empty() {
                format!("[{} tool calls]", tool_calls.len())
            } else {
                text.lines().next().unwrap_or("").to_string()
            }
        }
        TranscriptContent::ToolResult { tool_name, .. } => {
            format!("[Tool result: {tool_name}]")
        }
    }
}

fn display_text_for_role(role: &MessageRole, text: &str) -> String {
    if *role == MessageRole::User {
        strip_prompt_markup(text)
    } else {
        text.to_string()
    }
}

// ============ UI Display Types ============

/// Subagent progress tracking (for Task tool real-time display)
#[derive(Debug, Clone, Default)]
pub(crate) struct SubagentProgress {
    /// Total tool calls made by the subagent so far
    pub tool_count: usize,
    /// Name of the currently executing tool in the subagent (if any)
    pub current_tool_name: Option<String>,
    /// Summary/title of the current tool (e.g. file path, command)
    pub current_tool_title: Option<String>,
}

/// Tool call display state (for rendering tool cards)
#[derive(Debug, Clone)]
pub(crate) struct ToolDisplayState {
    pub tool_id: String,
    pub tool_name: String,
    pub parameters: serde_json::Value,
    pub status: ToolDisplayStatus,
    pub result: Option<String>,
    pub progress_message: Option<String>,
    pub duration_ms: Option<u64>,
    /// Optional metadata for richer display (e.g. full diff patch, diagnostics)
    pub metadata: Option<serde_json::Value>,
    /// Subagent progress (only for Task tools)
    pub subagent_progress: Option<SubagentProgress>,
}

/// A single content block in a message (text, thinking, or tool call)
#[derive(Debug, Clone)]
pub(crate) enum FlowItem {
    /// Text content block
    Text { content: String, is_streaming: bool },
    /// AI thinking/reasoning block
    Thinking { content: String },
    /// User steering injected between model-round flow items.
    UserSteering {
        steering_id: String,
        content: String,
        is_pending: bool,
    },
    /// Tool call block
    Tool { tool_state: ToolDisplayState },
}

/// A chat message for UI rendering (converted from core Message + streaming state)
#[derive(Debug, Clone)]
pub(crate) struct ChatMessage {
    pub id: String,
    /// Stable persisted DialogTurn identity used for history operations.
    pub turn_id: Option<String>,
    pub role: MessageRole,
    pub timestamp: SystemTime,
    pub flow_items: Vec<FlowItem>,
    pub is_streaming: bool,
    /// Monotonically increasing version number; incremented on every content change.
    /// Used by render cache to detect stale entries without deep comparison.
    pub version: u64,
}

impl ChatMessage {
    /// Convert a portable session transcript message to UI state.
    fn from_transcript_message(msg: &TranscriptMessage, index: usize) -> Self {
        let role = MessageRole::from(msg.role.as_str());
        let mut flow_items = Vec::new();

        match &msg.content {
            TranscriptContent::Text(text) => {
                if !text.is_empty() {
                    flow_items.push(FlowItem::Text {
                        content: display_text_for_role(&role, text),
                        is_streaming: false,
                    });
                }
            }
            TranscriptContent::Mixed {
                reasoning_content,
                text,
                tool_calls,
            } => {
                // Add reasoning/thinking block if present
                if let Some(reasoning) = reasoning_content {
                    if !reasoning.is_empty() {
                        flow_items.push(FlowItem::Thinking {
                            content: reasoning.clone(),
                        });
                    }
                }

                // Add text block if present
                if !text.is_empty() {
                    flow_items.push(FlowItem::Text {
                        content: display_text_for_role(&role, text),
                        is_streaming: false,
                    });
                }

                // Add tool call blocks
                for tc in tool_calls {
                    let (tool_name, parameters) =
                        effective_tool_invocation(&tc.tool_name, &tc.arguments);
                    flow_items.push(FlowItem::Tool {
                        tool_state: ToolDisplayState {
                            tool_id: tc.tool_id.clone(),
                            tool_name: tool_name.to_string(),
                            parameters: parameters.clone(),
                            status: ToolDisplayStatus::Success, // Historical messages are completed
                            result: None,
                            progress_message: None,
                            duration_ms: None,
                            metadata: None,
                            subagent_progress: None,
                        },
                    });
                }
            }
            TranscriptContent::Multimodal { text, .. } => {
                if !text.is_empty() {
                    flow_items.push(FlowItem::Text {
                        content: display_text_for_role(&role, text),
                        is_streaming: false,
                    });
                }
            }
            TranscriptContent::ToolResult {
                tool_id,
                tool_name,
                effective_tool_name,
                result,
                is_error,
            } => {
                let result_str = extract_fallback_summary(result);
                flow_items.push(FlowItem::Tool {
                    tool_state: ToolDisplayState {
                        tool_id: tool_id.clone(),
                        tool_name: effective_tool_name
                            .as_deref()
                            .unwrap_or(tool_name)
                            .to_string(),
                        parameters: serde_json::Value::Null,
                        status: if *is_error {
                            ToolDisplayStatus::Failed
                        } else {
                            ToolDisplayStatus::Success
                        },
                        result: Some(result_str),
                        progress_message: None,
                        subagent_progress: None,
                        duration_ms: None,
                        metadata: Some(result.clone()),
                    },
                });
            }
        }

        Self {
            id: msg
                .id
                .clone()
                .unwrap_or_else(|| format!("transcript-message-{index}")),
            turn_id: msg.turn_id.clone(),
            role,
            timestamp: UNIX_EPOCH
                .checked_add(Duration::from_millis(msg.timestamp_ms.unwrap_or_default()))
                .unwrap_or(UNIX_EPOCH),
            flow_items,
            is_streaming: false,
            version: 0,
        }
    }
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub(crate) struct SessionForkPoint {
    pub message_id: String,
    pub turn_id: String,
    pub prompt: String,
    pub timestamp: SystemTime,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub(crate) struct SessionTimelinePoint {
    pub message_id: String,
    pub prompt: String,
    pub timestamp: SystemTime,
}

fn visible_message_text(message: &ChatMessage) -> String {
    message
        .flow_items
        .iter()
        .filter_map(|item| match item {
            FlowItem::Text { content, .. } => Some(content.as_str()),
            FlowItem::Thinking { .. } | FlowItem::UserSteering { .. } | FlowItem::Tool { .. } => {
                None
            }
        })
        .collect::<Vec<_>>()
        .join("\n")
}

// ============ Chat Metadata ============

/// Statistics for the current chat session
#[derive(Debug, Clone, Default)]
pub(crate) struct ChatMetadata {
    pub message_count: usize,
    pub tool_calls: usize,
    pub total_rounds: usize,
}

/// Facts from the latest primary-model request observed by this TUI.
///
/// This is intentionally not a cumulative session-usage aggregate. The
/// authoritative cumulative report remains owned by the runtime `/usage` path.
#[derive(Debug, Clone, PartialEq, Eq)]
pub(crate) struct ModelTokenUsageSnapshot {
    pub model_config_id: String,
    pub effective_model_name: String,
    pub input_tokens: usize,
    pub output_tokens: Option<usize>,
    pub total_tokens: usize,
    pub max_context_tokens: Option<usize>,
    pub cached_tokens: Option<usize>,
}

// ============ ChatState ============

#[derive(Debug, Clone, Copy, Default, PartialEq, Eq)]
pub(crate) struct PermissionReconcileOutcome {
    pub(crate) changed: bool,
    pub(crate) added: bool,
}

/// Complete UI state for the chat interface.
/// This is the single source of truth for rendering — but NOT for persistence.
/// All persistence is handled by openbitfun-core's SessionManager.
pub(crate) struct ChatState {
    /// Core session ID (the real session managed by core)
    pub core_session_id: String,
    /// Session display name
    pub session_name: String,
    /// Agent type
    pub agent_type: String,
    /// Workspace path
    pub workspace: Option<String>,
    /// Persisted session workspace binding, including managed worktree facts.
    pub workspace_binding: Option<AgentSessionWorkspaceBinding>,
    /// Lightweight Git facts for the active execution workspace.
    git_branch: Option<String>,
    is_git_repository: bool,
    /// Whether this runtime exposes session worktree lifecycle controls.
    worktree_control_available: bool,
    /// Empty-session preference. The actual worktree is created only after the
    /// user submits the first prompt.
    worktree_isolation_requested: Option<bool>,
    /// Current Session model identity reported by the Runtime owner.
    pub current_model_id: Option<String>,
    /// Current canonical reasoning preset. `None` is the model default (Auto).
    pub current_reasoning_preset: Option<String>,
    /// Current model display name (shown in shortcuts bar).
    pub current_model_name: String,
    /// Effective Auto mode for permission results that evaluate to Ask.
    pub auto_approve_ask: bool,
    /// Messages for UI rendering
    pub messages: Vec<ChatMessage>,
    /// Session statistics
    pub metadata: ChatMetadata,
    /// Latest primary-model request observed by this TUI, if any.
    pub last_primary_model_usage: Option<ModelTokenUsageSnapshot>,

    // -- Streaming state (transient, not persisted) --
    /// Current turn ID being processed
    current_turn_id: Option<String>,
    /// Turns retired by authoritative Session operations. Their already queued
    /// events are fenced from the rebuilt visible transcript.
    ignored_turn_ids: HashSet<String>,
    /// Ordered flow items for the current streaming message.
    /// Text, thinking, and tool blocks are interleaved in chronological order,
    /// matching the actual conversation flow (inspired by opencode's Part model).
    current_flow_items: Vec<FlowItem>,
    /// Index from tool_id to position in current_flow_items (for fast in-place updates)
    tool_index: HashMap<String, usize>,
    /// Whether the assistant is currently processing
    pub is_processing: bool,

    // -- Permission state --
    /// Current pending permission prompt (if a tool needs user confirmation)
    pub permission_prompt: Option<PermissionPrompt>,
    /// Additional permission requests waiting behind the visible prompt.
    permission_queue: VecDeque<PermissionRequest>,

    // -- Question state --
    /// Current pending question prompt (if AskUserQuestion tool is waiting for answers)
    pub question_prompt: Option<QuestionPrompt>,
    pending_question_prompts: VecDeque<QuestionPrompt>,
}

impl ChatState {
    fn enqueue_question_prompt(&mut self, prompt: QuestionPrompt) {
        if self
            .question_prompt
            .as_ref()
            .is_some_and(|current| current.tool_id == prompt.tool_id)
            || self
                .pending_question_prompts
                .iter()
                .any(|queued| queued.tool_id == prompt.tool_id)
        {
            return;
        }
        if self.question_prompt.is_none() {
            self.question_prompt = Some(prompt);
        } else {
            self.pending_question_prompts.push_back(prompt);
        }
    }

    pub(crate) fn resolve_question_prompt(&mut self, tool_id: &str) {
        self.pending_question_prompts
            .retain(|prompt| prompt.tool_id != tool_id);
        if self
            .question_prompt
            .as_ref()
            .is_some_and(|prompt| prompt.tool_id == tool_id)
        {
            self.question_prompt = self.pending_question_prompts.pop_front();
        }
    }

    /// Create a new ChatState for a fresh session
    pub(crate) fn new(
        core_session_id: String,
        session_name: String,
        agent_type: String,
        workspace: Option<String>,
    ) -> Self {
        let workspace_binding =
            workspace
                .as_ref()
                .map(|workspace_path| AgentSessionWorkspaceBinding {
                    workspace_kind: None,
                    project_workspace_id: None,
                    workspace_id: None,
                    workspace_path: workspace_path.clone(),
                    project_workspace_path: Some(workspace_path.clone()),
                    execution_target: Some(SessionExecutionTarget::local(workspace_path.clone())),
                    remote_connection_id: None,
                    remote_ssh_host: None,
                });
        Self {
            core_session_id,
            session_name,
            agent_type,
            workspace,
            workspace_binding,
            git_branch: None,
            is_git_repository: false,
            worktree_control_available: true,
            worktree_isolation_requested: None,
            current_model_id: None,
            current_reasoning_preset: None,
            current_model_name: String::new(),
            auto_approve_ask: false,
            messages: Vec::new(),
            metadata: ChatMetadata::default(),
            last_primary_model_usage: None,
            current_turn_id: None,
            ignored_turn_ids: HashSet::new(),
            current_flow_items: Vec::new(),
            tool_index: HashMap::new(),
            is_processing: false,
            permission_prompt: None,
            permission_queue: VecDeque::new(),
            question_prompt: None,
            pending_question_prompts: VecDeque::new(),
        }
    }

    pub(crate) fn apply_workspace_binding(&mut self, binding: AgentSessionWorkspaceBinding) {
        self.workspace = Some(binding.workspace_path.clone());
        self.workspace_binding = Some(binding);
    }

    pub(crate) fn project_workspace_path(&self) -> Option<&str> {
        self.workspace_binding
            .as_ref()
            .and_then(|binding| binding.project_workspace_path.as_deref())
            .filter(|path| !path.trim().is_empty())
            .or(self.workspace.as_deref())
    }

    /// Owning project workspace ID from the bound session, falling back to the
    /// execution workspace ID when the binding predates linked worktrees.
    pub(crate) fn project_workspace_id(&self) -> Option<&str> {
        self.workspace_binding.as_ref().and_then(|binding| {
            binding
                .project_workspace_id
                .as_deref()
                .or(binding.workspace_id.as_deref())
                .filter(|id| !id.trim().is_empty())
        })
    }

    pub(crate) fn set_git_repository_status(
        &mut self,
        is_repository: bool,
        branch: Option<String>,
    ) {
        self.is_git_repository = is_repository;
        self.git_branch = branch.filter(|value| !value.trim().is_empty());
    }

    pub(crate) fn is_worktree_materialized(&self) -> bool {
        self.workspace_binding
            .as_ref()
            .and_then(|binding| binding.execution_target.as_ref())
            .and_then(|target| target.worktree_id.as_ref())
            .is_some()
    }

    pub(crate) fn is_worktree_enabled(&self) -> bool {
        self.worktree_isolation_requested
            .unwrap_or_else(|| self.is_worktree_materialized())
    }

    pub(crate) fn requested_worktree_enabled(&self) -> Option<bool> {
        self.worktree_isolation_requested
    }

    pub(crate) fn set_worktree_isolation_requested(&mut self, requested: Option<bool>) {
        self.worktree_isolation_requested = requested;
    }

    pub(crate) fn has_conversation_history(&self) -> bool {
        self.metadata.message_count > 0
    }

    /// User prompts eligible for `/fork`, newest first like OpenCode's fork dialog.
    pub(crate) fn session_fork_points(&self) -> Vec<SessionForkPoint> {
        self.messages
            .iter()
            .rev()
            .filter(|message| message.role == MessageRole::User)
            .filter_map(|message| {
                let turn_id = message.turn_id.clone()?;
                let prompt = visible_message_text(message);
                (!prompt.is_empty()).then_some(SessionForkPoint {
                    message_id: message.id.clone(),
                    turn_id,
                    prompt,
                    timestamp: message.timestamp,
                })
            })
            .collect()
    }

    /// User messages eligible for OpenCode-compatible `/timeline`, newest first.
    pub(crate) fn session_timeline_points(&self) -> Vec<SessionTimelinePoint> {
        self.messages
            .iter()
            .rev()
            .filter(|message| message.role == MessageRole::User)
            .filter_map(|message| {
                let prompt = visible_message_text(message);
                (!prompt.is_empty()).then_some(SessionTimelinePoint {
                    message_id: message.id.clone(),
                    prompt,
                    timestamp: message.timestamp,
                })
            })
            .collect()
    }

    pub(crate) fn latest_user_message_id(&self) -> Option<String> {
        self.messages
            .iter()
            .rev()
            .find(|message| message.role == MessageRole::User)
            .map(|message| message.id.clone())
    }

    pub(crate) fn set_worktree_control_available(&mut self, available: bool) {
        self.worktree_control_available = available;
    }

    pub(crate) fn worktree_control_available(&self) -> bool {
        self.worktree_control_available
    }

    pub(crate) fn branch_label(&self) -> String {
        let execution_target = self
            .workspace_binding
            .as_ref()
            .and_then(|binding| binding.execution_target.as_ref());
        if let Some(branch) = execution_target
            .and_then(|target| target.branch.as_deref())
            .map(str::trim)
            .filter(|branch| !branch.is_empty())
        {
            return branch.to_string();
        }

        let current_branch = self.git_branch.as_deref().map(str::trim);
        if let Some(branch) = current_branch.filter(|branch| *branch != "HEAD") {
            return branch.to_string();
        }

        if self.is_worktree_materialized() {
            if let Some(commit) = execution_target
                .and_then(|target| target.base_commit.as_deref())
                .map(str::trim)
                .filter(|commit| !commit.is_empty())
            {
                return format!("detached@{}", commit.chars().take(9).collect::<String>());
            }
        }

        if self.is_git_repository && current_branch == Some("HEAD") {
            "detached".to_string()
        } else {
            "—".to_string()
        }
    }

    pub(crate) fn worktree_status_label(&self) -> &'static str {
        if !self.worktree_control_available {
            "unavailable"
        } else if self.worktree_isolation_requested == Some(true)
            && !self.is_worktree_materialized()
        {
            "pending-on"
        } else if self.worktree_isolation_requested == Some(false)
            && self.is_worktree_materialized()
        {
            "pending-off"
        } else if self.is_worktree_enabled() {
            "on"
        } else if self.is_git_repository {
            "off"
        } else {
            "unavailable"
        }
    }

    pub(crate) fn workspace_context_label(&self) -> String {
        format!(
            "Branch: {} | Worktree: {}",
            self.branch_label(),
            self.worktree_status_label()
        )
    }

    pub(crate) fn enqueue_permission_request(&mut self, request: PermissionRequest) -> bool {
        let request_id = request.request_id.as_str();
        if self
            .permission_prompt
            .as_ref()
            .is_some_and(|prompt| prompt.request.request_id == request_id)
            || self
                .permission_queue
                .iter()
                .any(|queued| queued.request_id == request_id)
        {
            return false;
        }

        if self.permission_prompt.is_none() {
            self.permission_prompt = Some(PermissionPrompt::new(request));
        } else if self.permission_prompt.as_ref().is_some_and(|prompt| {
            prompt.request.round_id == request.round_id && request.order < prompt.request.order
        }) {
            let current = self
                .permission_prompt
                .take()
                .expect("permission prompt should exist when reordering");
            self.permission_prompt = Some(PermissionPrompt::new(request));
            self.insert_permission_request_sorted(current.request);
        } else {
            self.insert_permission_request_sorted(request);
        }
        true
    }

    fn insert_permission_request_sorted(&mut self, request: PermissionRequest) {
        let same_round_positions = self
            .permission_queue
            .iter()
            .enumerate()
            .filter_map(|(index, queued)| (queued.round_id == request.round_id).then_some(index))
            .collect::<Vec<_>>();

        let insert_position = if let Some(position) = same_round_positions
            .iter()
            .copied()
            .find(|&index| request.order < self.permission_queue[index].order)
        {
            position
        } else if let Some(position) = same_round_positions.last().copied() {
            position + 1
        } else if self
            .permission_prompt
            .as_ref()
            .is_some_and(|prompt| prompt.request.round_id == request.round_id)
        {
            0
        } else {
            self.permission_queue.len()
        };

        self.permission_queue.insert(insert_position, request);
    }

    pub(crate) fn resolve_permission_request(&mut self, request_id: &str) -> bool {
        if self
            .permission_prompt
            .as_ref()
            .is_some_and(|prompt| prompt.request.request_id == request_id)
        {
            self.permission_prompt = self.permission_queue.pop_front().map(PermissionPrompt::new);
            return true;
        }

        let Some(position) = self
            .permission_queue
            .iter()
            .position(|request| request.request_id == request_id)
        else {
            return false;
        };
        self.permission_queue.remove(position);
        true
    }

    pub(crate) fn reconcile_permission_requests(
        &mut self,
        requests: Vec<PermissionRequest>,
    ) -> PermissionReconcileOutcome {
        let expected = requests
            .iter()
            .map(|request| request.request_id.clone())
            .collect::<HashSet<_>>();
        let stale = self
            .permission_prompt
            .iter()
            .map(|prompt| prompt.request.request_id.clone())
            .chain(
                self.permission_queue
                    .iter()
                    .map(|request| request.request_id.clone()),
            )
            .filter(|request_id| !expected.contains(request_id))
            .collect::<Vec<_>>();
        let mut outcome = PermissionReconcileOutcome::default();
        for request_id in stale {
            outcome.changed |= self.resolve_permission_request(&request_id);
        }
        for request in requests {
            let added = self.enqueue_permission_request(request);
            outcome.changed |= added;
            outcome.added |= added;
        }
        outcome
    }

    /// Load historical messages from the portable runtime transcript.
    ///
    /// Tool results (ToolResult messages) are merged back into the corresponding
    /// tool calls (in Mixed messages) so that tool cards render with full result data.
    pub(crate) fn from_session_transcript(
        core_session_id: String,
        session_name: String,
        agent_type: String,
        workspace: Option<String>,
        transcript: &SessionTranscript,
    ) -> Self {
        // Step 1: Build tool_id -> (result_summary, metadata, is_error) lookup from ToolResult messages
        let mut tool_results: HashMap<String, (String, Option<serde_json::Value>, bool)> =
            HashMap::new();
        for msg in &transcript.messages {
            if let TranscriptContent::ToolResult {
                tool_id,
                result,
                is_error,
                ..
            } = &msg.content
            {
                let result_str = extract_fallback_summary(result);
                tool_results.insert(
                    tool_id.clone(),
                    (result_str, Some(result.clone()), *is_error),
                );
            }
        }

        // Step 2: Convert messages, merging tool results into tool call display states
        let messages: Vec<ChatMessage> = transcript
            .messages
            .iter()
            .enumerate()
            .filter(|msg| {
                // Skip tool result messages (merged into tool cards above)
                msg.1.role != "tool"
                // Skip system messages (internal)
                && msg.1.role != "system"
            })
            .map(|(index, msg)| {
                let mut chat_msg = ChatMessage::from_transcript_message(msg, index);
                // Merge tool results into corresponding tool display states
                for item in &mut chat_msg.flow_items {
                    if let FlowItem::Tool { tool_state } = item {
                        if let Some((result_str, metadata, is_error)) =
                            tool_results.get(&tool_state.tool_id)
                        {
                            tool_state.result = Some(result_str.clone());
                            tool_state.metadata = metadata.clone();
                            if *is_error {
                                tool_state.status = ToolDisplayStatus::Failed;
                            }
                        }
                    }
                }
                chat_msg
            })
            .collect();

        let tool_count = tool_results.len();

        let mut state = Self::new(core_session_id, session_name, agent_type, workspace);
        state.metadata.message_count = messages.len();
        state.metadata.tool_calls = tool_count;
        state.messages = messages;
        state
    }

    /// Continue projecting live events onto an authoritative transcript read
    /// without inserting a duplicate user/assistant turn.
    pub(crate) fn resume_transcript_turn(&mut self, turn_id: &str) {
        self.current_turn_id = Some(turn_id.to_string());
        self.is_processing = true;
        self.current_flow_items.clear();
        self.tool_index.clear();

        if let Some(message) = self.messages.iter_mut().rev().find(|message| {
            message.role == MessageRole::Assistant && message.turn_id.as_deref() == Some(turn_id)
        }) {
            message.is_streaming = true;
            self.current_flow_items = message.flow_items.clone();
            for (index, item) in self.current_flow_items.iter().enumerate() {
                if let FlowItem::Tool { tool_state } = item {
                    self.tool_index.insert(tool_state.tool_id.clone(), index);
                }
            }
        } else {
            self.push_streaming_assistant_message(turn_id);
        }
    }

    /// Ignore delayed lifecycle events for turns already represented by an
    /// authoritative transcript, while allowing one active turn to continue.
    pub(crate) fn reconcile_transcript_turn_events(&mut self, active_turn_id: Option<&str>) {
        self.ignored_turn_ids.extend(
            self.messages
                .iter()
                .filter_map(|message| message.turn_id.as_deref())
                .filter(|turn_id| Some(*turn_id) != active_turn_id)
                .map(str::to_string),
        );
        if let Some(turn_id) = active_turn_id {
            self.ignored_turn_ids.remove(turn_id);
        }
    }

    /// Replace the render projection from the Runtime-owned transcript while
    /// retaining Session/workspace/product settings owned by the TUI shell.
    pub(crate) fn replace_from_authoritative_transcript(
        &mut self,
        transcript: &SessionTranscript,
        retired_turn_ids: &[String],
    ) {
        debug_assert_eq!(transcript.session_id, self.core_session_id);
        let projected = Self::from_session_transcript(
            self.core_session_id.clone(),
            self.session_name.clone(),
            self.agent_type.clone(),
            self.workspace.clone(),
            transcript,
        );
        self.messages = projected.messages;
        self.metadata = projected.metadata;
        self.last_primary_model_usage = None;
        if let Some(turn_id) = self.current_turn_id.take() {
            self.ignored_turn_ids.insert(turn_id);
        }
        self.ignored_turn_ids
            .extend(retired_turn_ids.iter().cloned());
        self.current_flow_items.clear();
        self.tool_index.clear();
        self.is_processing = false;
        self.permission_prompt = None;
        self.permission_queue.clear();
        self.question_prompt = None;
        self.pending_question_prompts.clear();
    }

    // ============ Event Handlers ============

    /// Handle the start of a new dialog turn
    pub(crate) fn handle_turn_started(&mut self, turn_id: &str, user_input: &str) {
        self.current_turn_id = Some(turn_id.to_string());
        self.current_flow_items.clear();
        self.tool_index.clear();
        self.is_processing = true;
        let user_display_input = strip_prompt_markup(user_input);

        // Add user message
        self.messages.push(ChatMessage {
            id: uuid::Uuid::new_v4().to_string(),
            turn_id: Some(turn_id.to_string()),
            role: MessageRole::User,
            timestamp: SystemTime::now(),
            flow_items: vec![FlowItem::Text {
                content: user_display_input,
                is_streaming: false,
            }],
            is_streaming: false,
            version: 0,
        });
        self.metadata.message_count += 1;

        self.push_streaming_assistant_message(turn_id);
    }

    fn push_streaming_assistant_message(&mut self, turn_id: &str) {
        // Add an empty assistant message that incoming chunks can rebuild.
        self.messages.push(ChatMessage {
            id: uuid::Uuid::new_v4().to_string(),
            turn_id: Some(turn_id.to_string()),
            role: MessageRole::Assistant,
            timestamp: SystemTime::now(),
            flow_items: Vec::new(),
            is_streaming: true,
            version: 0,
        });
    }

    /// Handle a text chunk from the AI.
    /// Appends to the last Text flow item if it exists, otherwise creates a new one.
    /// This ensures text and tool blocks remain interleaved in chronological order.
    pub(crate) fn handle_text_chunk(&mut self, text: &str) {
        // Try to append to the last flow item if it's a Text block
        if let Some(FlowItem::Text { content, .. }) = self.current_flow_items.last_mut() {
            content.push_str(text);
        } else {
            // Last item is not Text (it's a Tool, Thinking, or empty) — create a new Text block
            self.current_flow_items.push(FlowItem::Text {
                content: text.to_string(),
                is_streaming: true,
            });
        }
        self.rebuild_streaming_message();
    }

    /// Handle a thinking/reasoning chunk from the AI.
    /// Thinking blocks typically appear at the start, before text/tool content.
    /// Appends to the last Thinking flow item if it exists, otherwise creates a new one.
    pub(crate) fn handle_thinking_chunk(&mut self, content: &str) {
        // Try to append to the last Thinking block
        // (Thinking usually comes before text, so check the last item)
        let appended = if let Some(FlowItem::Thinking { content: existing }) =
            self.current_flow_items.last_mut()
        {
            existing.push_str(content);
            true
        } else {
            false
        };

        if !appended {
            // Also check if there's a Thinking block earlier that we should append to
            // (e.g., if a Text block was inserted after Thinking but more thinking arrives)
            // For simplicity, just create a new Thinking block — this is rare in practice
            self.current_flow_items.push(FlowItem::Thinking {
                content: content.to_string(),
            });
        }
        self.rebuild_streaming_message();
    }

    /// Add an optimistic steering item or upgrade it when the runtime emits
    /// the authoritative injection event. Returns true only for a new item.
    pub(crate) fn handle_user_steering(
        &mut self,
        steering_id: &str,
        content: &str,
        is_pending: bool,
    ) -> bool {
        if !self.is_processing || self.current_turn_id.is_none() {
            return false;
        }
        if let Some(existing) = self.current_flow_items.iter_mut().find(|item| {
            matches!(
                item,
                FlowItem::UserSteering {
                    steering_id: existing_id,
                    ..
                } if existing_id == steering_id
            )
        }) {
            if let FlowItem::UserSteering {
                content: existing_content,
                is_pending: existing_pending,
                ..
            } = existing
            {
                *existing_content = content.to_string();
                if !is_pending {
                    *existing_pending = false;
                }
            }
            self.rebuild_streaming_message();
            return false;
        }

        self.current_flow_items.push(FlowItem::UserSteering {
            steering_id: steering_id.to_string(),
            content: content.to_string(),
            is_pending,
        });
        self.rebuild_streaming_message();
        true
    }

    /// Handle a tool event.
    /// New tools are appended to current_flow_items in chronological order.
    /// Existing tools are updated in-place via tool_index for O(1) lookup.
    pub(crate) fn handle_tool_event(&mut self, tool_event: &ToolEventData) {
        match tool_event {
            ToolEventData::EarlyDetected { identity } => {
                self.insert_or_update_tool(
                    &identity.tool_id,
                    |_existing| {
                        // Should not exist yet, but handle gracefully
                    },
                    || ToolDisplayState {
                        tool_id: identity.tool_id.clone(),
                        tool_name: identity.effective_name().to_string(),
                        parameters: serde_json::Value::Null,
                        status: ToolDisplayStatus::EarlyDetected,
                        result: None,
                        progress_message: None,
                        duration_ms: None,
                        metadata: None,
                        subagent_progress: None,
                    },
                );
                self.rebuild_streaming_message();
            }

            ToolEventData::ParamsPartial {
                identity, params, ..
            } => {
                self.update_tool(&identity.tool_id, |tool| {
                    // Only update status if not yet in an advanced execution state.
                    // Due to priority queue ordering, ParamsPartial (Normal priority) may
                    // arrive after Started (High priority), which would incorrectly
                    // revert the status from Running back to ParamsPartial.
                    if !tool.status.is_execution_phase() {
                        tool.status = ToolDisplayStatus::ParamsPartial;
                    }
                    tool.progress_message = Some(params.clone());
                });
                self.rebuild_streaming_message();
            }

            ToolEventData::Queued {
                identity, position, ..
            } => {
                self.update_tool(&identity.tool_id, |tool| {
                    if !tool.status.is_execution_phase() {
                        tool.status = ToolDisplayStatus::Queued;
                    }
                    tool.progress_message = Some(format!("Queue position: {}", position));
                });
                self.rebuild_streaming_message();
            }

            ToolEventData::Waiting {
                identity,
                dependencies,
                ..
            } => {
                self.update_tool(&identity.tool_id, |tool| {
                    if !tool.status.is_execution_phase() {
                        tool.status = ToolDisplayStatus::Waiting;
                    }
                    tool.progress_message = Some(format!("Waiting for: {:?}", dependencies));
                });
                self.rebuild_streaming_message();
            }

            ToolEventData::Started {
                identity,
                params,
                timeout_seconds: _,
            } => {
                let (tool_name, effective_params) =
                    effective_tool_invocation(&identity.tool_name, params);
                debug_assert_eq!(identity.effective_name(), tool_name);
                let params_for_update = effective_params.clone();
                let params_for_create = effective_params.clone();
                let tool_name_for_update = tool_name.to_string();
                let tool_name_for_create = tool_name.to_string();
                self.insert_or_update_tool(
                    &identity.tool_id,
                    |tool| {
                        tool.status = ToolDisplayStatus::Running;
                        tool.tool_name = tool_name_for_update;
                        tool.parameters = params_for_update;
                    },
                    || ToolDisplayState {
                        tool_id: identity.tool_id.clone(),
                        tool_name: tool_name_for_create,
                        parameters: params_for_create,
                        status: ToolDisplayStatus::Running,
                        result: None,
                        progress_message: None,
                        duration_ms: None,
                        metadata: None,
                        subagent_progress: None,
                    },
                );
                self.metadata.tool_calls += 1;

                // Auto-create question prompt for AskUserQuestion tool
                if tool_name == "AskUserQuestion" {
                    if let Some(prompt) =
                        QuestionPrompt::from_params(identity.tool_id.clone(), effective_params)
                    {
                        self.enqueue_question_prompt(prompt);
                    }
                }

                self.rebuild_streaming_message();
            }

            ToolEventData::Progress {
                identity, message, ..
            } => {
                self.update_tool(&identity.tool_id, |tool| {
                    tool.progress_message = Some(message.clone());
                });
                self.rebuild_streaming_message();
            }

            ToolEventData::Streaming {
                identity,
                chunks_received,
                ..
            } => {
                self.update_tool(&identity.tool_id, |tool| {
                    tool.status = ToolDisplayStatus::Streaming;
                    tool.progress_message = Some(format!("Received {} chunks", chunks_received));
                });
                self.rebuild_streaming_message();
            }

            ToolEventData::ConfirmationNeeded {
                identity, params, ..
            } => {
                let (tool_name, effective_params) =
                    effective_tool_invocation(&identity.tool_name, params);
                debug_assert_eq!(identity.effective_name(), tool_name);
                self.update_tool(&identity.tool_id, |tool| {
                    tool.status = ToolDisplayStatus::ConfirmationNeeded;
                    tool.tool_name = tool_name.to_string();
                    tool.parameters = effective_params.clone();
                    tool.progress_message = Some("Waiting for user confirmation".to_string());
                });
                self.rebuild_streaming_message();
            }

            ToolEventData::Confirmed { identity } => {
                self.update_tool(&identity.tool_id, |tool| {
                    tool.status = ToolDisplayStatus::Confirmed;
                });
                self.rebuild_streaming_message();
            }

            ToolEventData::Rejected { identity } => {
                self.update_tool(&identity.tool_id, |tool| {
                    tool.status = ToolDisplayStatus::Rejected;
                    tool.result = Some("User rejected execution".to_string());
                });
                self.rebuild_streaming_message();
            }

            ToolEventData::Completed {
                identity,
                result,
                result_for_assistant,
                duration_ms,
                ..
            } => {
                // Prefer result_for_assistant from tool, fallback to extracting from JSON
                let result_str = result_for_assistant
                    .clone()
                    .unwrap_or_else(|| extract_fallback_summary(result));
                let metadata = result.clone();
                let dur = *duration_ms;
                self.update_tool(&identity.tool_id, |tool| {
                    tool.tool_name = identity.effective_name().to_string();
                    let is_hmos_failed = identity.effective_name() == "HmosCompilation"
                        && result.get("success").and_then(|v| v.as_bool()) == Some(false);
                    tool.status = if is_hmos_failed {
                        ToolDisplayStatus::Failed
                    } else {
                        ToolDisplayStatus::Success
                    };
                    tool.result = Some(result_str);
                    tool.metadata = Some(metadata);
                    tool.duration_ms = Some(dur);
                });
                // Clear question prompt if this tool completed
                self.resolve_question_prompt(&identity.tool_id);
                self.rebuild_streaming_message();
            }

            ToolEventData::Failed {
                identity, error, ..
            } => {
                let err = error.clone();
                self.update_tool(&identity.tool_id, |tool| {
                    tool.tool_name = identity.effective_name().to_string();
                    tool.status = ToolDisplayStatus::Failed;
                    tool.result = Some(err);
                });
                // Clear question prompt if this tool failed
                self.resolve_question_prompt(&identity.tool_id);
                self.rebuild_streaming_message();
            }

            ToolEventData::Cancelled {
                identity, reason, ..
            } => {
                let rsn = reason.clone();
                self.update_tool(&identity.tool_id, |tool| {
                    tool.tool_name = identity.effective_name().to_string();
                    tool.status = ToolDisplayStatus::Cancelled;
                    tool.result = Some(rsn);
                });
                // Clear question prompt if this tool was cancelled
                self.resolve_question_prompt(&identity.tool_id);
                self.rebuild_streaming_message();
            }

            // StreamChunk and other variants we don't need to display
            _ => {}
        }
    }

    /// Handle a subagent event by updating the parent Task tool's progress.
    ///
    /// When a subagent emits events (tool started, completed, etc.), we forward
    /// key information to the parent Task tool so the UI can show real-time progress.
    pub(crate) fn handle_subagent_event(
        &mut self,
        parent_tool_id: &str,
        event: &openbitfun_events::AgenticEvent,
    ) {
        use openbitfun_events::AgenticEvent;

        match event {
            AgenticEvent::ToolEvent { tool_event, .. } => match tool_event {
                ToolEventData::Started {
                    identity, params, ..
                } => {
                    let (tool_name, effective_params) =
                        effective_tool_invocation(&identity.tool_name, params);
                    debug_assert_eq!(identity.effective_name(), tool_name);
                    let title = extract_tool_title(tool_name, effective_params);
                    self.update_tool(parent_tool_id, |tool| {
                        let progress = tool
                            .subagent_progress
                            .get_or_insert_with(SubagentProgress::default);
                        progress.tool_count += 1;
                        progress.current_tool_name = Some(tool_name.to_string());
                        progress.current_tool_title = title;
                    });
                    self.rebuild_streaming_message();
                }
                ToolEventData::Completed {
                    identity,
                    result_for_assistant,
                    result: _,
                    ..
                } => {
                    let tool_name = identity.effective_name();
                    let summary = result_for_assistant
                        .clone()
                        .unwrap_or_else(|| tool_name.to_string());
                    self.update_tool(parent_tool_id, |tool| {
                        let progress = tool
                            .subagent_progress
                            .get_or_insert_with(SubagentProgress::default);
                        progress.current_tool_name = Some(tool_name.to_string());
                        progress.current_tool_title = Some(summary);
                    });
                    self.rebuild_streaming_message();
                }
                ToolEventData::Failed {
                    identity, error, ..
                } => {
                    let tool_name = identity.effective_name();
                    self.update_tool(parent_tool_id, |tool| {
                        let progress = tool
                            .subagent_progress
                            .get_or_insert_with(SubagentProgress::default);
                        progress.current_tool_name = Some(tool_name.to_string());
                        progress.current_tool_title =
                            Some(format!("Error: {}", truncate_string(error, 60)));
                    });
                    self.rebuild_streaming_message();
                }
                _ => {}
            },
            AgenticEvent::ModelRoundStarted { round_index, .. } if *round_index > 0 => {
                self.update_tool(parent_tool_id, |tool| {
                    let progress = tool
                        .subagent_progress
                        .get_or_insert_with(SubagentProgress::default);
                    progress.current_tool_name = None;
                    progress.current_tool_title = Some(format!("Round {}", round_index + 1));
                });
                self.rebuild_streaming_message();
            }
            _ => {}
        }
    }

    /// Handle dialog turn completion
    pub(crate) fn handle_turn_completed(&mut self, total_rounds: usize, _total_tools: usize) {
        // Finalize the streaming message
        if let Some(last_msg) = self.messages.last_mut() {
            if last_msg.role == MessageRole::Assistant {
                last_msg.is_streaming = false;
                // Mark all text flow items as not streaming
                for item in &mut last_msg.flow_items {
                    if let FlowItem::Text { is_streaming, .. } = item {
                        *is_streaming = false;
                    }
                }
                last_msg.version += 1;
            }
        }

        self.metadata.total_rounds += total_rounds;
        self.current_turn_id = None;
        self.current_flow_items.clear();
        self.tool_index.clear();
        self.is_processing = false;
        self.question_prompt = None;
        self.pending_question_prompts.clear();
    }

    /// Handle dialog turn failure
    pub(crate) fn handle_turn_failed(&mut self, error: &str) {
        // Add error to the last assistant message
        if let Some(last_msg) = self.messages.last_mut() {
            if last_msg.role == MessageRole::Assistant {
                last_msg.is_streaming = false;
                last_msg.flow_items.push(FlowItem::Text {
                    content: format!("[Error: {}]", error),
                    is_streaming: false,
                });
                last_msg.version += 1;
            }
        }

        self.current_turn_id = None;
        self.current_flow_items.clear();
        self.tool_index.clear();
        self.is_processing = false;
        self.question_prompt = None;
        self.pending_question_prompts.clear();
    }

    /// Handle dialog turn cancellation
    pub(crate) fn handle_turn_cancelled(&mut self) {
        if let Some(last_msg) = self.messages.last_mut() {
            if last_msg.role == MessageRole::Assistant {
                last_msg.is_streaming = false;
                last_msg.flow_items.push(FlowItem::Text {
                    content: "[Cancelled]".to_string(),
                    is_streaming: false,
                });
                last_msg.version += 1;
            }
        }

        self.current_turn_id = None;
        self.current_flow_items.clear();
        self.tool_index.clear();
        self.is_processing = false;
        self.question_prompt = None;
        self.pending_question_prompts.clear();
    }

    pub(crate) fn should_apply_turn_cancelled(&mut self, turn_id: &str) -> bool {
        if self.should_ignore_turn_event(turn_id) {
            return false;
        }
        self.current_turn_id.is_none() || self.current_turn_id.as_deref() == Some(turn_id)
    }

    pub(crate) fn should_ignore_turn_event(&self, turn_id: &str) -> bool {
        self.ignored_turn_ids.contains(turn_id)
    }

    /// Record the latest primary-model request observed by this TUI.
    pub(crate) fn handle_primary_model_usage(&mut self, usage: ModelTokenUsageSnapshot) {
        self.last_primary_model_usage = Some(usage);
    }

    /// Add a system message for commands that intentionally enter the transcript.
    pub(crate) fn add_system_message(&mut self, content: String) {
        self.messages.push(ChatMessage {
            id: uuid::Uuid::new_v4().to_string(),
            turn_id: None,
            role: MessageRole::System,
            timestamp: SystemTime::now(),
            flow_items: vec![FlowItem::Text {
                content,
                is_streaming: false,
            }],
            is_streaming: false,
            version: 0,
        });
    }

    /// Add a local assistant message (for rendered reports and other UI-only content).
    pub(crate) fn add_assistant_message(&mut self, content: String) {
        self.messages.push(ChatMessage {
            id: uuid::Uuid::new_v4().to_string(),
            turn_id: None,
            role: MessageRole::Assistant,
            timestamp: SystemTime::now(),
            flow_items: vec![FlowItem::Text {
                content,
                is_streaming: false,
            }],
            is_streaming: false,
            version: 0,
        });
    }

    /// Get the current turn ID (if processing)
    pub(crate) fn current_turn_id(&self) -> Option<&str> {
        self.current_turn_id.as_deref()
    }

    // ============ Internal ============

    /// Rebuild the last assistant message from current streaming state.
    /// Simply clones the chronologically-ordered current_flow_items into the message.
    /// Text, thinking, and tool blocks are already interleaved in the correct order.
    fn rebuild_streaming_message(&mut self) {
        let last_msg = match self.messages.last_mut() {
            Some(msg) if msg.role == MessageRole::Assistant && msg.is_streaming => msg,
            _ => return,
        };

        last_msg.flow_items = self.current_flow_items.clone();
        last_msg.version += 1;
    }

    /// Insert a new tool into current_flow_items (appended at end, preserving chronological order),
    /// or update an existing tool in-place if it already exists.
    fn insert_or_update_tool(
        &mut self,
        tool_id: &str,
        update_fn: impl FnOnce(&mut ToolDisplayState),
        create_fn: impl FnOnce() -> ToolDisplayState,
    ) {
        if let Some(&idx) = self.tool_index.get(tool_id) {
            // Tool already exists — update in-place
            if let Some(FlowItem::Tool { tool_state }) = self.current_flow_items.get_mut(idx) {
                update_fn(tool_state);
            }
        } else {
            // New tool — append to flow items in chronological order
            let new_state = create_fn();
            let idx = self.current_flow_items.len();
            self.current_flow_items.push(FlowItem::Tool {
                tool_state: new_state,
            });
            self.tool_index.insert(tool_id.to_string(), idx);
        }
    }

    /// Update an existing tool in current_flow_items via tool_index.
    /// No-op if the tool_id is not found (defensive).
    fn update_tool(&mut self, tool_id: &str, update_fn: impl FnOnce(&mut ToolDisplayState)) {
        if let Some(&idx) = self.tool_index.get(tool_id) {
            if let Some(FlowItem::Tool { tool_state }) = self.current_flow_items.get_mut(idx) {
                update_fn(tool_state);
            }
        }
    }
}

/// Extract a human-readable summary from a tool result JSON Value.
/// Used as fallback when `display_summary` is not provided (e.g. MCP tools, old data).
fn extract_fallback_summary(result: &serde_json::Value) -> String {
    if let Some(obj) = result.as_object() {
        // Try common text fields first
        for key in &[
            "display_summary",
            "result_for_assistant",
            "output",
            "result",
            "content",
            "message",
        ] {
            if let Some(text) = obj.get(*key).and_then(|v| v.as_str()) {
                if !text.is_empty() && text.len() < 200 {
                    return text.to_string();
                } else if !text.is_empty() {
                    let truncated: String = text.chars().take(200).collect();
                    return format!("{}...", truncated);
                }
            }
        }

        // Try success field
        if let Some(true) = obj.get("success").and_then(|v| v.as_bool()) {
            return "Done".to_string();
        }

        // Try extracting key parameter values
        let priority_keys = ["path", "file_path", "query", "pattern", "command", "url"];
        for key in &priority_keys {
            if let Some(s) = obj.get(*key).and_then(|v| v.as_str()) {
                if !s.is_empty() && s.len() < 100 {
                    return s.to_string();
                }
            }
        }
    }

    // If it's a plain string
    if let Some(text) = result.as_str() {
        if text.len() < 200 {
            return text.to_string();
        }
        let truncated: String = text.chars().take(200).collect();
        return format!("{}...", truncated);
    }

    "Done".to_string()
}

/// Extract a short title from tool parameters for subagent progress display.
/// Returns a concise description like the file path, command, or query.
fn extract_tool_title(tool_name: &str, params: &serde_json::Value) -> Option<String> {
    let obj = params.as_object()?;

    // Tool-specific extraction for common tools
    match tool_name {
        "Write" => obj
            .get("payload")
            .and_then(|value| value.as_str())
            .and_then(|value| {
                let first_line = value.split_once('\n').map_or(value, |(path, _)| path);
                first_line
                    .strip_suffix('\r')
                    .unwrap_or(first_line)
                    .strip_prefix("+++ ")
            })
            .filter(|path| !path.trim().is_empty())
            .or_else(|| {
                obj.get("file_path")
                    .or_else(|| obj.get("path"))
                    .and_then(|value| value.as_str())
            })
            .map(|path| truncate_string(path, 50)),
        "Read" | "Edit" | "Delete" | "GetFileDiff" => obj
            .get("path")
            .and_then(|v| v.as_str())
            .map(|s| truncate_string(s, 50)),
        "Bash" => obj
            .get("command")
            .and_then(|v| v.as_str())
            .map(|s| truncate_string(s, 50)),
        "Grep" => obj
            .get("pattern")
            .and_then(|v| v.as_str())
            .map(|s| truncate_string(s, 40)),
        "Glob" | "LS" => obj
            .get("glob_pattern")
            .or_else(|| obj.get("target_directory"))
            .and_then(|v| v.as_str())
            .map(|s| truncate_string(s, 50)),
        "WebSearch" => obj
            .get("search_term")
            .and_then(|v| v.as_str())
            .map(|s| truncate_string(s, 40)),
        "WebFetch" => obj
            .get("url")
            .and_then(|v| v.as_str())
            .map(|s| truncate_string(s, 50)),
        _ => {
            // Generic: try common parameter names
            for key in &[
                "path",
                "file_path",
                "command",
                "query",
                "pattern",
                "url",
                "description",
            ] {
                if let Some(s) = obj.get(*key).and_then(|v| v.as_str()) {
                    if !s.is_empty() {
                        return Some(truncate_string(s, 50));
                    }
                }
            }
            None
        }
    }
}

/// Truncate a string to a maximum number of characters, adding "..." if truncated.
fn truncate_string(s: &str, max_len: usize) -> String {
    if s.chars().count() <= max_len {
        s.to_string()
    } else {
        let truncated: String = s.chars().take(max_len).collect();
        format!("{}...", truncated)
    }
}

#[cfg(test)]
mod tests {
    use super::{
        ChatState, FlowItem, ModelTokenUsageSnapshot, PermissionReconcileOutcome, ToolDisplayStatus,
    };
    use openbitfun_agent_runtime::sdk::{
        PermissionDelegationContext, PermissionRequest, PermissionRequestSource,
        PermissionRequestSourceKind, SessionTranscript, TranscriptContent, TranscriptMessage,
        TranscriptToolCall,
    };
    use openbitfun_events::{ToolEventData, ToolEventIdentity};
    use openbitfun_runtime_ports::{
        AgentSessionWorkspaceBinding, SessionExecutionTarget, SessionExecutionTargetKind,
        WorktreeLifecycle,
    };
    use serde_json::json;

    fn managed_worktree_binding(
        branch: Option<&str>,
        base_commit: Option<&str>,
    ) -> AgentSessionWorkspaceBinding {
        AgentSessionWorkspaceBinding {
            workspace_kind: None,
            project_workspace_id: None,
            workspace_id: Some("workspace-1".to_string()),
            workspace_path: "/tmp/managed-worktree".to_string(),
            project_workspace_path: Some("/tmp/project".to_string()),
            execution_target: Some(SessionExecutionTarget {
                kind: SessionExecutionTargetKind::ManagedWorktree,
                worktree_id: Some("worktree-1".to_string()),
                root_path: "/tmp/managed-worktree".to_string(),
                base_ref: None,
                base_commit: base_commit.map(str::to_string),
                branch: branch.map(str::to_string),
                lifecycle: Some(WorktreeLifecycle::Managed),
            }),
            remote_connection_id: None,
            remote_ssh_host: None,
        }
    }

    #[test]
    fn workspace_context_reports_local_repository_state() {
        let mut state = ChatState::new(
            "session-1".to_string(),
            "Session".to_string(),
            "Standard".to_string(),
            Some("/tmp/project".to_string()),
        );
        state.set_git_repository_status(true, Some("main".to_string()));

        assert!(!state.is_worktree_enabled());
        assert_eq!(state.branch_label(), "main");
        assert_eq!(
            state.workspace_context_label(),
            "Branch: main | Worktree: off"
        );

        state.set_worktree_control_available(false);
        assert_eq!(
            state.workspace_context_label(),
            "Branch: main | Worktree: unavailable"
        );
    }

    #[test]
    fn worktree_binding_history_ignores_local_system_messages() {
        let mut state = ChatState::new(
            "session-1".to_string(),
            "Session".to_string(),
            "Standard".to_string(),
            Some("/tmp/project".to_string()),
        );
        state.add_system_message("Worktree: off".to_string());
        assert!(!state.has_conversation_history());

        state.metadata.message_count = 1;
        assert!(state.has_conversation_history());
    }

    #[test]
    fn latest_primary_model_usage_keeps_round_facts_without_claiming_a_session_total() {
        let mut state = ChatState::new(
            "session-1".to_string(),
            "Session".to_string(),
            "Standard".to_string(),
            Some("/tmp/project".to_string()),
        );
        let usage = ModelTokenUsageSnapshot {
            model_config_id: "model-config-1".to_string(),
            effective_model_name: "example-model".to_string(),
            input_tokens: 80_000,
            output_tokens: Some(2_000),
            total_tokens: 82_000,
            max_context_tokens: Some(128_000),
            cached_tokens: Some(10_000),
        };

        state.handle_primary_model_usage(usage.clone());

        assert_eq!(state.last_primary_model_usage.as_ref(), Some(&usage));
        assert_eq!(state.metadata.message_count, 0);
        assert_eq!(state.metadata.tool_calls, 0);
    }

    #[test]
    fn worktree_preference_is_visible_before_materialization() {
        let mut state = ChatState::new(
            "session-1".to_string(),
            "Session".to_string(),
            "Standard".to_string(),
            Some("/tmp/project".to_string()),
        );
        state.set_git_repository_status(true, Some("main".to_string()));
        state.set_worktree_isolation_requested(Some(true));

        assert!(state.is_worktree_enabled());
        assert!(!state.is_worktree_materialized());
        assert_eq!(state.worktree_status_label(), "pending-on");
        assert_eq!(
            state.workspace_context_label(),
            "Branch: main | Worktree: pending-on"
        );
    }

    #[test]
    fn workspace_context_prefers_managed_worktree_branch_or_detached_commit() {
        let mut state = ChatState::new(
            "session-1".to_string(),
            "Session".to_string(),
            "Standard".to_string(),
            Some("/tmp/project".to_string()),
        );
        state.apply_workspace_binding(managed_worktree_binding(Some("feature/test"), None));
        state.set_git_repository_status(true, Some("HEAD".to_string()));

        assert!(state.is_worktree_enabled());
        assert_eq!(state.branch_label(), "feature/test");
        assert_eq!(state.worktree_status_label(), "on");

        state.apply_workspace_binding(managed_worktree_binding(None, Some("123456789abcdef")));
        assert_eq!(state.branch_label(), "detached@123456789");
    }

    fn permission_request(request_id: &str, child_session_id: &str) -> PermissionRequest {
        PermissionRequest {
            request_id: request_id.to_string(),
            round_id: format!("synthetic:{request_id}"),
            order: 0,
            tool_call_id: Some(format!("{request_id}-tool")),
            project_path: None,
            project_id: "project-1".to_string(),
            session_id: child_session_id.to_string(),
            agent_id: "Explore".to_string(),
            action: "edit".to_string(),
            resources: vec!["src/main.rs".to_string()],
            save_resources: Vec::new(),
            source: PermissionRequestSource {
                kind: PermissionRequestSourceKind::ToolCall,
                identity: "Write".to_string(),
            },
            delegation: Some(PermissionDelegationContext {
                parent_session_id: "parent-session".to_string(),
                parent_dialog_turn_id: Some("parent-turn".to_string()),
                parent_tool_call_id: format!("{request_id}-parent-task"),
                subagent_type: "Explore".to_string(),
            }),
            display_metadata: serde_json::Map::new(),
        }
    }

    fn deferred_input() -> serde_json::Value {
        json!({
            "tool_name": "CreatePlan",
            "args": {
                "title": "Deferred tool plan",
                "steps": ["Inspect", "Implement"]
            }
        })
    }

    fn assert_create_plan_item(item: &FlowItem) {
        let FlowItem::Tool { tool_state } = item else {
            panic!("expected tool item");
        };
        assert_eq!(tool_state.tool_name, "CreatePlan");
        assert_eq!(
            tool_state.parameters,
            json!({
                "title": "Deferred tool plan",
                "steps": ["Inspect", "Implement"]
            })
        );
    }

    #[test]
    fn question_queue_preserves_active_draft_and_retires_only_matching_tools() {
        let mut state = ChatState::new("session".into(), "Session".into(), "Standard".into(), None);
        let started = |id: &str| ToolEventData::Started {
            identity: ToolEventIdentity::direct(id, "AskUserQuestion"),
            params: json!({"questions": [{"question": "Choose", "options": [{"label": "Yes"}, {"label": "No"}]}]}),
            timeout_seconds: None,
        };
        state.handle_tool_event(&started("first"));
        state
            .question_prompt
            .as_mut()
            .unwrap()
            .interaction_acknowledged = true;
        state.handle_tool_event(&started("second"));
        state.handle_tool_event(&started("third"));
        state.handle_tool_event(&started("first"));
        assert_eq!(state.question_prompt.as_ref().unwrap().tool_id, "first");
        assert!(
            state
                .question_prompt
                .as_ref()
                .unwrap()
                .interaction_acknowledged
        );
        state.handle_tool_event(&ToolEventData::Cancelled {
            identity: ToolEventIdentity::direct("second", "AskUserQuestion"),
            reason: "timeout".into(),
            duration_ms: None,
            queue_wait_ms: None,
            preflight_ms: None,
            confirmation_wait_ms: None,
            execution_ms: None,
        });
        assert_eq!(state.question_prompt.as_ref().unwrap().tool_id, "first");
        state.resolve_question_prompt("first");
        assert_eq!(state.question_prompt.as_ref().unwrap().tool_id, "third");
        state.resolve_question_prompt("first");
        assert_eq!(state.question_prompt.as_ref().unwrap().tool_id, "third");
        state.resolve_question_prompt("third");
        assert!(state.question_prompt.is_none());
        assert!(state.pending_question_prompts.is_empty());
    }

    #[test]
    fn permission_queue_deduplicates_and_advances_in_fifo_order() {
        let mut state = ChatState::new(
            "parent-session".to_string(),
            "Session".to_string(),
            "Standard".to_string(),
            None,
        );
        let first = permission_request("request-z", "child-a");
        let second = permission_request("request-a", "child-b");
        let third = permission_request("request-m", "child-c");

        assert!(state.enqueue_permission_request(first.clone()));
        assert!(state.enqueue_permission_request(second.clone()));
        assert!(state.enqueue_permission_request(third.clone()));
        assert!(!state.enqueue_permission_request(second));
        assert_eq!(
            state
                .permission_prompt
                .as_ref()
                .map(|prompt| prompt.request.request_id.as_str()),
            Some("request-z")
        );

        assert!(state.resolve_permission_request("request-a"));
        assert!(state.resolve_permission_request("request-z"));
        assert_eq!(
            state
                .permission_prompt
                .as_ref()
                .map(|prompt| prompt.request.request_id.as_str()),
            Some("request-m")
        );
        assert!(!state.resolve_permission_request("unrelated"));
        assert!(state.resolve_permission_request("request-m"));
        assert!(state.permission_prompt.is_none());

        assert!(state.enqueue_permission_request(first));
        let outcome = state.reconcile_permission_requests(vec![third.clone()]);
        assert!(outcome.changed);
        assert!(outcome.added);
        assert_eq!(
            state
                .permission_prompt
                .as_ref()
                .map(|prompt| prompt.request.request_id.as_str()),
            Some("request-m")
        );
        assert_eq!(
            state.reconcile_permission_requests(vec![third]),
            PermissionReconcileOutcome::default()
        );
    }

    #[test]
    fn permission_queue_orders_requests_within_their_round() {
        let mut state = ChatState::new(
            "session-1".to_string(),
            "Session".to_string(),
            "Standard".to_string(),
            None,
        );
        let first = PermissionRequest {
            round_id: "round-1".to_string(),
            order: 2,
            ..permission_request("request-2", "session-1")
        };
        let second = PermissionRequest {
            round_id: "round-1".to_string(),
            order: 0,
            ..permission_request("request-0", "session-1")
        };
        let third = PermissionRequest {
            round_id: "round-1".to_string(),
            order: 1,
            ..permission_request("request-1", "session-1")
        };

        assert!(state.enqueue_permission_request(first));
        assert!(state.enqueue_permission_request(second));
        assert!(state.enqueue_permission_request(third));
        assert_eq!(
            state
                .permission_prompt
                .as_ref()
                .map(|prompt| prompt.request.request_id.as_str()),
            Some("request-0")
        );

        assert!(state.resolve_permission_request("request-0"));
        assert_eq!(
            state
                .permission_prompt
                .as_ref()
                .map(|prompt| prompt.request.request_id.as_str()),
            Some("request-1")
        );
        assert!(state.resolve_permission_request("request-1"));
        assert_eq!(
            state
                .permission_prompt
                .as_ref()
                .map(|prompt| prompt.request.request_id.as_str()),
            Some("request-2")
        );
    }

    #[test]
    fn deferred_started_event_replaces_early_wire_display_with_effective_view() {
        let mut state = ChatState::new(
            "session-1".to_string(),
            "Session".to_string(),
            "Standard".to_string(),
            None,
        );
        state.handle_turn_started("turn-1", "Create a plan");
        state.handle_tool_event(&ToolEventData::EarlyDetected {
            identity: ToolEventIdentity::direct(
                "tool-1",
                openbitfun_agent_tools::CALL_DEFERRED_TOOL_NAME,
            ),
        });
        state.handle_tool_event(&ToolEventData::Started {
            identity: ToolEventIdentity::resolved(
                "tool-1",
                openbitfun_agent_tools::CALL_DEFERRED_TOOL_NAME,
                "CreatePlan",
            ),
            params: deferred_input(),
            timeout_seconds: None,
        });

        assert_create_plan_item(&state.current_flow_items[0]);
    }

    #[test]
    fn user_steering_is_deduplicated_and_preserves_stream_order() {
        let mut state = ChatState::new(
            "session-1".to_string(),
            "Session".to_string(),
            "Standard".to_string(),
            None,
        );
        state.handle_turn_started("turn-1", "Start the task");
        state.handle_text_chunk("Before steering");

        assert!(state.handle_user_steering("steer-1", "Also check tests", true));
        assert!(!state.handle_user_steering("steer-1", "Also check tests", false));
        state.handle_text_chunk("After steering");

        assert!(matches!(
            state.current_flow_items.as_slice(),
            [
                FlowItem::Text { content: before, .. },
                FlowItem::UserSteering {
                    steering_id,
                    content,
                    is_pending: false,
                },
                FlowItem::Text { content: after, .. },
            ] if before == "Before steering"
                && steering_id == "steer-1"
                && content == "Also check tests"
                && after == "After steering"
        ));
        assert_eq!(
            state.current_flow_items.len(),
            state
                .messages
                .last()
                .expect("assistant message")
                .flow_items
                .len()
        );
    }

    #[test]
    fn deferred_history_projects_effective_view_without_mutating_wire_message() {
        let wire_input = deferred_input();
        let transcript = SessionTranscript {
            session_id: "session-1".to_string(),
            messages: vec![TranscriptMessage {
                id: Some("message-1".to_string()),
                role: "assistant".to_string(),
                turn_id: Some("turn-1".to_string()),
                timestamp_ms: Some(1234),
                content: TranscriptContent::Mixed {
                    reasoning_content: None,
                    text: String::new(),
                    tool_calls: vec![TranscriptToolCall {
                        tool_id: "tool-1".to_string(),
                        tool_name: openbitfun_agent_tools::CALL_DEFERRED_TOOL_NAME.to_string(),
                        arguments: wire_input.clone(),
                    }],
                },
            }],
        };

        let state = ChatState::from_session_transcript(
            "session-1".to_string(),
            "Session".to_string(),
            "Standard".to_string(),
            None,
            &transcript,
        );

        assert_create_plan_item(&state.messages[0].flow_items[0]);
        assert_eq!(
            match &transcript.messages[0].content {
                TranscriptContent::Mixed { tool_calls, .. } => tool_calls[0].tool_name.as_str(),
                _ => panic!("expected mixed transcript content"),
            },
            openbitfun_agent_tools::CALL_DEFERRED_TOOL_NAME
        );
        assert_eq!(
            match &transcript.messages[0].content {
                TranscriptContent::Mixed { tool_calls, .. } => &tool_calls[0].arguments,
                _ => panic!("expected mixed transcript content"),
            },
            &wire_input
        );
    }

    #[test]
    fn authoritative_transcript_replaces_only_session_projection_and_clears_active_turn() {
        let mut state = ChatState::new(
            "session-1".to_string(),
            "Session".to_string(),
            "Standard".to_string(),
            Some("D:/workspace/project".to_string()),
        );
        state.current_model_id = Some("model-1".to_string());
        state.handle_turn_started("turn-2", "Hidden prompt");
        let transcript = SessionTranscript {
            session_id: "session-1".to_string(),
            messages: vec![TranscriptMessage {
                id: Some("user-1".to_string()),
                role: "user".to_string(),
                turn_id: Some("turn-1".to_string()),
                timestamp_ms: Some(1_000),
                content: TranscriptContent::Text("Visible prompt".to_string()),
            }],
        };

        state.replace_from_authoritative_transcript(&transcript, &[]);

        assert_eq!(state.messages.len(), 1);
        assert_eq!(state.messages[0].turn_id.as_deref(), Some("turn-1"));
        assert_eq!(state.current_model_id.as_deref(), Some("model-1"));
        assert_eq!(state.workspace.as_deref(), Some("D:/workspace/project"));
        assert!(!state.is_processing);
        assert!(state.current_turn_id().is_none());
        assert!(!state.should_apply_turn_cancelled("turn-2"));
    }

    #[test]
    fn authoritative_transcript_fences_a_turn_start_that_arrives_after_revert() {
        let mut state = ChatState::new(
            "session-1".to_string(),
            "Session".to_string(),
            "Standard".to_string(),
            None,
        );
        let transcript = SessionTranscript {
            session_id: "session-1".to_string(),
            messages: vec![TranscriptMessage {
                id: Some("assistant-visible".to_string()),
                role: "assistant".to_string(),
                turn_id: Some("turn-visible".to_string()),
                timestamp_ms: Some(1_000),
                content: TranscriptContent::Text("Visible answer".to_string()),
            }],
        };

        state.replace_from_authoritative_transcript(
            &transcript,
            &["retired-turn".to_string(), "queued-turn".to_string()],
        );

        assert!(state.should_ignore_turn_event("retired-turn"));
        assert!(state.should_ignore_turn_event("queued-turn"));
        if !state.should_ignore_turn_event("retired-turn") {
            state.handle_turn_started("retired-turn", "late prompt");
        }
        assert_eq!(state.messages.len(), 1);
        assert!(!state.is_processing);
        assert!(!state.should_apply_turn_cancelled("retired-turn"));
        assert!(!state.should_apply_turn_cancelled("queued-turn"));
        if state.should_apply_turn_cancelled("queued-turn") {
            state.handle_turn_cancelled();
        }
        assert!(matches!(
            state.messages[0].flow_items.as_slice(),
            [FlowItem::Text { content, .. }] if content == "Visible answer"
        ));
    }

    #[test]
    fn session_fork_points_keep_stable_turn_ids_and_newest_prompt_first() {
        let transcript = SessionTranscript {
            session_id: "session-1".to_string(),
            messages: vec![
                TranscriptMessage {
                    id: Some("user-1".to_string()),
                    role: "user".to_string(),
                    turn_id: Some("turn-1".to_string()),
                    timestamp_ms: Some(1_000),
                    content: TranscriptContent::Text("First prompt".to_string()),
                },
                TranscriptMessage {
                    id: Some("assistant-1".to_string()),
                    role: "assistant".to_string(),
                    turn_id: Some("turn-1".to_string()),
                    timestamp_ms: Some(1_100),
                    content: TranscriptContent::Text("First answer".to_string()),
                },
                TranscriptMessage {
                    id: Some("user-2".to_string()),
                    role: "user".to_string(),
                    turn_id: Some("turn-2".to_string()),
                    timestamp_ms: Some(2_000),
                    content: TranscriptContent::Text("Second\nprompt".to_string()),
                },
            ],
        };
        let state = ChatState::from_session_transcript(
            "session-1".to_string(),
            "Session".to_string(),
            "Standard".to_string(),
            None,
            &transcript,
        );

        let points = state.session_fork_points();

        assert_eq!(points.len(), 2);
        assert_eq!(points[0].turn_id, "turn-2");
        assert_eq!(points[0].prompt, "Second\nprompt");
        assert_eq!(points[1].turn_id, "turn-1");
        assert_eq!(points[1].prompt, "First prompt");
    }

    #[test]
    fn timeline_points_match_opencode_user_message_order_without_needing_turn_ids() {
        let transcript = SessionTranscript {
            session_id: "session-1".to_string(),
            messages: vec![
                TranscriptMessage {
                    id: Some("user-1".to_string()),
                    role: "user".to_string(),
                    turn_id: None,
                    timestamp_ms: Some(1_000),
                    content: TranscriptContent::Text("First\nprompt".to_string()),
                },
                TranscriptMessage {
                    id: Some("assistant-1".to_string()),
                    role: "assistant".to_string(),
                    turn_id: Some("turn-1".to_string()),
                    timestamp_ms: Some(2_000),
                    content: TranscriptContent::Text("Answer".to_string()),
                },
                TranscriptMessage {
                    id: Some("user-2".to_string()),
                    role: "user".to_string(),
                    turn_id: Some("turn-2".to_string()),
                    timestamp_ms: Some(3_000),
                    content: TranscriptContent::Multimodal {
                        text: "Second prompt".to_string(),
                        image_count: 1,
                    },
                },
            ],
        };
        let state = ChatState::from_session_transcript(
            "session-1".to_string(),
            "Session".to_string(),
            "Standard".to_string(),
            None,
            &transcript,
        );

        let points = state.session_timeline_points();

        assert_eq!(points.len(), 2);
        assert_eq!(points[0].message_id, "user-2");
        assert_eq!(points[0].prompt, "Second prompt");
        assert_eq!(points[1].message_id, "user-1");
        assert_eq!(points[1].prompt, "First\nprompt");
    }

    #[test]
    fn transcript_history_merges_tool_results_into_the_rendered_tool_card() {
        let transcript = SessionTranscript {
            session_id: "session-1".to_string(),
            messages: vec![
                TranscriptMessage {
                    id: Some("assistant-1".to_string()),
                    role: "assistant".to_string(),
                    turn_id: Some("turn-1".to_string()),
                    timestamp_ms: Some(1234),
                    content: TranscriptContent::Mixed {
                        reasoning_content: None,
                        text: String::new(),
                        tool_calls: vec![TranscriptToolCall {
                            tool_id: "tool-1".to_string(),
                            tool_name: "Read".to_string(),
                            arguments: json!({ "file_path": "README.md" }),
                        }],
                    },
                },
                TranscriptMessage {
                    id: Some("tool-result-1".to_string()),
                    role: "tool".to_string(),
                    turn_id: Some("turn-1".to_string()),
                    timestamp_ms: Some(1300),
                    content: TranscriptContent::ToolResult {
                        tool_id: "tool-1".to_string(),
                        tool_name: "Read".to_string(),
                        effective_tool_name: None,
                        result: json!({ "display_summary": "README contents" }),
                        is_error: true,
                    },
                },
            ],
        };

        let state = ChatState::from_session_transcript(
            "session-1".to_string(),
            "Session".to_string(),
            "Standard".to_string(),
            None,
            &transcript,
        );

        assert_eq!(state.messages.len(), 1);
        assert_eq!(state.messages[0].id, "assistant-1");
        let FlowItem::Tool { tool_state } = &state.messages[0].flow_items[0] else {
            panic!("expected tool item");
        };
        assert_eq!(tool_state.status, ToolDisplayStatus::Failed);
        assert_eq!(tool_state.result.as_deref(), Some("README contents"));
        assert_eq!(
            tool_state.metadata,
            Some(json!({ "display_summary": "README contents" }))
        );
    }

    #[test]
    fn active_transcript_resume_reuses_the_existing_assistant_message() {
        let transcript = SessionTranscript {
            session_id: "child-1".to_string(),
            messages: vec![
                TranscriptMessage {
                    id: Some("user-1".to_string()),
                    role: "user".to_string(),
                    turn_id: Some("turn-1".to_string()),
                    timestamp_ms: Some(1_000),
                    content: TranscriptContent::Text("Investigate".to_string()),
                },
                TranscriptMessage {
                    id: Some("assistant-1".to_string()),
                    role: "assistant".to_string(),
                    turn_id: Some("turn-1".to_string()),
                    timestamp_ms: Some(1_100),
                    content: TranscriptContent::Text("Working".to_string()),
                },
            ],
        };
        let mut state = ChatState::from_session_transcript(
            "child-1".to_string(),
            "Explore".to_string(),
            "explore".to_string(),
            None,
            &transcript,
        );

        state.resume_transcript_turn("turn-1");

        assert!(state.is_processing);
        assert_eq!(state.current_turn_id(), Some("turn-1"));
        assert_eq!(state.messages.len(), 2);
        assert!(state.messages[1].is_streaming);
        assert!(matches!(
            state.current_flow_items.as_slice(),
            [FlowItem::Text { content, .. }] if content == "Working"
        ));
    }

    #[test]
    fn active_transcript_resume_creates_streaming_target_before_first_assistant_content() {
        let transcript = SessionTranscript {
            session_id: "child-1".to_string(),
            messages: vec![TranscriptMessage {
                id: Some("user-1".to_string()),
                role: "user".to_string(),
                turn_id: Some("turn-1".to_string()),
                timestamp_ms: Some(1_000),
                content: TranscriptContent::Text("Investigate".to_string()),
            }],
        };
        let mut state = ChatState::from_session_transcript(
            "child-1".to_string(),
            "Explore".to_string(),
            "explore".to_string(),
            None,
            &transcript,
        );

        state.resume_transcript_turn("turn-1");
        state.handle_text_chunk("First chunk");

        assert_eq!(state.messages.len(), 2);
        assert!(state.messages[1].is_streaming);
        assert!(matches!(
            state.messages[1].flow_items.as_slice(),
            [FlowItem::Text { content, .. }] if content == "First chunk"
        ));
    }
}
