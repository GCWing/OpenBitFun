mod external_editor;
mod prompt_stash;
/// Chat mode implementation
///
/// Interactive chat mode with TUI interface.
/// Events are observed through an independent runtime broadcast subscription.
mod resize;
mod transcript;

use anyhow::{anyhow, Result};
use arboard::Clipboard;
use crossterm::event::{
    Event, KeyCode, KeyEvent, KeyEventKind, KeyModifiers, MouseButton, MouseEventKind,
};
use std::collections::{BTreeMap, BTreeSet, HashMap, VecDeque};
use std::sync::{
    mpsc::{self, Receiver, TryRecvError as MpscTryRecvError},
    Arc,
};
use std::time::{Duration, Instant};
use tokio::sync::broadcast::error::TryRecvError;

use openbitfun_events::{AgenticEvent, LoopDetectionEscalation, ToolEventData, ToolEventIdentity};
use openbitfun_product_domains::account::AccountSnapshotProjection;
use openbitfun_product_domains::agent_catalog::{SkillSummary, SubagentSummary};
use openbitfun_product_domains::native_hooks::{
    NativeHookOverview, NativeHookRuleSummary as NativeHookRuleView,
};
use openbitfun_runtime_ports::{
    AgentSessionComposerUpdate, AgentSessionLineageEntry, AgentSessionLineageInspection,
    AgentSessionLineageSnapshot, AgentSessionUsageRequest, AgentTurnCancellationResult,
    AgentWorkspaceReferenceSearchResult, SessionTranscript, WorkspaceDiffSnapshot,
};
use resize::ResizeRedrawState;

use crate::actions::{
    action_by_id, action_conflict_behavior_version, action_for_alias,
    removed_management_command_hint, slash_actions, ActionContext, ActionHandler, ActionSpec,
    ActionState, ResolvedKeymap, IMAGE_ATTACHMENTS_REQUIRE_MESSAGE, SHARED_TUI_EMBEDDED_HANDOFF,
    SHARED_TUI_HELP_NOTE,
};
use crate::agent::runtime_client::{
    CliAgentMode as TuiAgentMode, CliAgentRuntimeClient, SessionOperationError,
};
use crate::chat_state::{ChatState, ModelTokenUsageSnapshot};
use crate::config::CliConfig;
use crate::ui::agent_selector::{AgentItem, AgentSelectorAction};
use crate::ui::chat::{session_status_text, ChatView, MouseGestureOutcome};
use crate::ui::command_menu::{ExternalCommandProjection, NativeCommandCollisionProjection};
use crate::ui::command_palette::PaletteAction;
use crate::ui::fork_selector::{ForkAction, ForkTarget};
use crate::ui::image_paste::{self, ImagePaste};
use crate::ui::login_form::LoginFormAction;
use crate::ui::mcp_add_dialog::McpAddAction;
use crate::ui::mcp_selector::{McpItem, McpItemAction};
use crate::ui::model_config_form::{ModelFormAction, ModelFormResult};
use crate::ui::model_selector::ModelItem;
use crate::ui::permission::PermissionAction;
use crate::ui::prompt_command_shell_review::PromptCommandShellReviewAction;
use crate::ui::prompt_stash_selector::PromptStashAction;
use crate::ui::provider_selector::ProviderSelection;
use crate::ui::question::QuestionAction;
use crate::ui::session_lineage_selector::SessionLineageAction;
use crate::ui::session_selector::{SessionAction, SessionItem};
use crate::ui::skill_selector::{SkillItem, SkillSelectorAction};
use crate::ui::subagent_selector::{SubagentItem, SubagentSelectorAction};
use crate::ui::theme::{
    builtin_theme_ids, builtin_theme_json, resolve_appearance, resolve_effective_color_scheme,
    Appearance, EffectiveColorScheme, Theme,
};
use crate::ui::theme_selector::ThemeItem;
use crate::ui::{init_terminal, restore_terminal, TerminalGuard};
use openbitfun_core::service::remote_connect::account_runtime::AccountRuntime;
use openbitfun_core::service::session_usage::render_usage_report_markdown;
use openbitfun_product_domains::external_hook_catalog::{
    ExternalHookCatalogSnapshotV1, ExternalHookMatcherSummary, ExternalHookNativeActivation,
    ExternalHookProjectionStatus,
};
use openbitfun_product_domains::external_hook_import::{
    ExternalHookImportApplyOutcomeV1, ExternalHookImportApplyRequestV1,
    ExternalHookImportMutationRequestV1, ExternalHookImportMutationV1, ExternalHookImportPlanV1,
    ExternalHookImportSnapshotV1, EXTERNAL_HOOK_IMPORT_SCHEMA_V1,
};
use openbitfun_product_domains::external_source_control::{
    ExternalSourceControlActionV1, ExternalSourceControlRequestV1,
    EXTERNAL_SOURCE_CONTROL_SCHEMA_V1,
};
use openbitfun_product_domains::external_sources::{
    native_prompt_command_conflict_key, ExternalSourceAssetKind, ExternalSourceDiagnosticSeverity,
    ExternalSourceHealth, ExternalSourceOperationError, ExternalSourceOperationErrorCode,
    ExternalSourcePublicSnapshot as ExternalSourceCatalogSnapshot, ExternalSourceScope,
    ExternalToolActivationState, ExternalToolCapability, ExternalToolCatalogEntry,
    ExternalToolRuntimeKind, NativePromptCommandDescriptor, PromptCommandAvailability,
    PromptCommandExecutionTarget, PromptCommandInvocationOutcome, PromptCommandShellReviewDecision,
    PromptCommandShellReviewMode, PromptCommandShellReviewPlan, SourceKey,
};
use openbitfun_product_domains::external_subagents::{
    ExternalSubagentActivationState, ExternalSubagentCompatibilityState,
    ExternalSubagentModelBindingMethod, ExternalSubagentModelBindingTarget,
    ExternalSubagentModelProfileRequest, ExternalSubagentModelRequest,
};

/// Spinner/UI redraw interval while a turn is processing.
const SPINNER_REDRAW_INTERVAL_MS: u64 = 100;
/// Coalesce rapid resize bursts to reduce flicker during window drag.
const RESIZE_REDRAW_DEBOUNCE_MS: u64 = 75;

include!("chat/external_review.rs");
include!("chat/external_sources.rs");
include!("chat/external_hooks.rs");
include!("chat/native_hooks.rs");

fn agent_event_stream_failure(error: TryRecvError) -> Option<String> {
    match error {
        TryRecvError::Empty => None,
        TryRecvError::Lagged(skipped) => Some(format!(
            "Agent event stream lagged by {skipped} events; chat state can no longer be trusted"
        )),
        TryRecvError::Closed => {
            Some("Agent event stream closed; chat state can no longer be trusted".to_string())
        }
    }
}

fn mark_active_turn_failed(chat_state: &mut ChatState, error: &str) -> bool {
    if chat_state.current_turn_id().is_none() {
        return false;
    }

    chat_state.handle_turn_failed(error);
    true
}

#[derive(Debug, Default)]
struct TranscriptProjectionOutcome {
    changed: bool,
    requested_input: bool,
    terminal: Option<TranscriptTerminalOutcome>,
}

#[derive(Debug)]
enum TranscriptTerminalOutcome {
    Completed,
    Failed(String),
    Cancelled,
    SystemError(String),
}

/// Transcript status line for one loop-detection intervention.
///
/// Only a steer is reported from the event: a hard stop is reported from the
/// turn's `loop_detected` finalization reason instead, so one stopped turn never
/// renders two lines for the same decision. Report-only decisions
/// (`ai.loop_detection.mode` calibration) stay in the log.
fn loop_detection_status_line(
    kind: &str,
    confidence: f32,
    escalation: LoopDetectionEscalation,
) -> Option<String> {
    if escalation != LoopDetectionEscalation::Steered {
        return None;
    }
    Some(format!(
        "[loop detection] The agent started repeating itself ({kind} signal, confidence {confidence:.2}). A correction reminder was injected and the turn continues."
    ))
}

/// Transcript status line for a turn ended by the loop-detection fallback.
fn loop_detected_turn_status_line() -> String {
    "[loop detection] The turn was stopped because the agent kept repeating itself after correction attempts."
        .to_string()
}

/// Shared event-to-transcript projection used by the root conversation and a
/// read-only inspected descendant. Host notifications and git refresh remain
/// root-only side effects in the caller.
fn project_transcript_event(
    chat_state: &mut ChatState,
    event: &AgenticEvent,
    interactive: bool,
) -> TranscriptProjectionOutcome {
    if event
        .turn_id()
        .is_some_and(|turn_id| chat_state.should_ignore_turn_event(turn_id))
    {
        return TranscriptProjectionOutcome::default();
    }

    let mut outcome = TranscriptProjectionOutcome::default();
    match event {
        AgenticEvent::DialogTurnStarted {
            turn_id,
            user_input,
            ..
        } if chat_state.current_turn_id() != Some(turn_id.as_str()) => {
            chat_state.handle_turn_started(turn_id, user_input);
            outcome.changed = true;
        }
        AgenticEvent::TextChunk { turn_id, text, .. }
            if chat_state.current_turn_id() == Some(turn_id.as_str()) =>
        {
            chat_state.handle_text_chunk(text);
            outcome.changed = true;
        }
        AgenticEvent::ThinkingChunk {
            turn_id, content, ..
        } if chat_state.current_turn_id() == Some(turn_id.as_str()) => {
            chat_state.handle_thinking_chunk(content);
            outcome.changed = true;
        }
        AgenticEvent::ToolEvent {
            turn_id,
            tool_event,
            ..
        } if chat_state.current_turn_id() == Some(turn_id.as_str()) => {
            let question_pending = chat_state.question_prompt.is_some();
            chat_state.handle_tool_event(tool_event);
            outcome.requested_input = !question_pending && chat_state.question_prompt.is_some();
            if !interactive {
                chat_state.question_prompt = None;
                chat_state.permission_prompt = None;
            }
            outcome.changed = true;
        }
        AgenticEvent::UserSteeringInjected {
            turn_id,
            steering_id,
            display_content,
            ..
        } if chat_state.current_turn_id() == Some(turn_id.as_str()) => {
            chat_state.handle_user_steering(steering_id, display_content, false);
            outcome.changed = true;
        }
        AgenticEvent::ContextCompressionStarted { .. }
        | AgenticEvent::ContextCompressionCompleted { .. }
        | AgenticEvent::ContextCompressionFailed { .. } => {
            if let Some(tool_event) = context_compression_tool_event(event, chat_state) {
                chat_state.handle_tool_event(&tool_event);
                outcome.changed = true;
            }
        }
        AgenticEvent::LoopDetectionNoted {
            turn_id,
            kind,
            confidence,
            escalation,
            ..
        } if chat_state.current_turn_id() == Some(turn_id.as_str()) => {
            if let Some(status_line) = loop_detection_status_line(kind, *confidence, *escalation) {
                chat_state.add_system_message(status_line);
                outcome.changed = true;
            }
        }
        AgenticEvent::DialogTurnCompleted {
            turn_id,
            total_rounds,
            total_tools,
            finish_reason,
            ..
        } if chat_state.current_turn_id() == Some(turn_id.as_str()) => {
            chat_state.handle_turn_completed(*total_rounds, *total_tools);
            if finish_reason.as_deref() == Some("loop_detected") {
                chat_state.add_system_message(loop_detected_turn_status_line());
            }
            outcome.changed = true;
            outcome.terminal = Some(TranscriptTerminalOutcome::Completed);
        }
        AgenticEvent::DialogTurnFailed { turn_id, error, .. }
            if chat_state.current_turn_id() == Some(turn_id.as_str()) =>
        {
            chat_state.handle_turn_failed(error);
            outcome.changed = true;
            outcome.terminal = Some(TranscriptTerminalOutcome::Failed(error.clone()));
        }
        AgenticEvent::DialogTurnCancelled { turn_id, .. }
            if chat_state.should_apply_turn_cancelled(turn_id) =>
        {
            chat_state.handle_turn_cancelled();
            outcome.changed = true;
            outcome.terminal = Some(TranscriptTerminalOutcome::Cancelled);
        }
        AgenticEvent::TokenUsageUpdated { .. } => {
            if let Some(usage) = primary_model_usage_for_active_turn(event, chat_state) {
                chat_state.handle_primary_model_usage(usage);
                outcome.changed = true;
            }
        }
        AgenticEvent::SystemError { error, .. } => {
            chat_state.add_system_message(format!("[System error: {error}]"));
            outcome.changed = true;
            outcome.terminal = Some(TranscriptTerminalOutcome::SystemError(error.clone()));
        }
        _ => {}
    }
    outcome
}

/// Chat mode exit reason
#[derive(Debug, Clone, PartialEq)]
pub(crate) enum ChatExitReason {
    /// User exits program
    Quit,
    /// Switch to a different session
    SwitchSession(String),
    /// Fork the current session at the selected OpenCode-compatible boundary.
    ForkSession(crate::ui::fork_selector::ForkTarget),
    /// Create a new session
    NewSession,
}

/// Pending MCP operation (deferred to allow a render frame for loading state)
enum PendingMcpOp {
    Toggle(String),
    External(McpItem),
    Add { name: String, config_json: String },
    Delete(String),
}

enum PendingMcpTask {
    Toggle {
        server_id: String,
        handle: tokio::task::JoinHandle<std::result::Result<(), String>>,
    },
    Add {
        name: String,
        handle: tokio::task::JoinHandle<std::result::Result<(), String>>,
    },
    Delete {
        server_id: String,
        handle: tokio::task::JoinHandle<std::result::Result<(), String>>,
    },
    External {
        item_id: String,
        item_name: String,
        handle: tokio::task::JoinHandle<std::result::Result<(), String>>,
    },
}

enum PendingSessionOperationKind {
    Mode {
        mode_id: String,
    },
    Model {
        model_id: String,
        display_name: String,
    },
    Rename {
        session_name: String,
    },
    Delete {
        session_name: String,
    },
}

impl PendingSessionOperationKind {
    fn name(&self) -> &'static str {
        match self {
            Self::Mode { .. } => "agent mode",
            Self::Model { .. } => "model",
            Self::Rename { .. } => "name",
            Self::Delete { .. } => "deletion",
        }
    }

    fn selected_id(&self) -> &str {
        match self {
            Self::Mode { mode_id } => mode_id,
            Self::Model { model_id, .. } => model_id,
            Self::Rename { session_name } => session_name,
            Self::Delete { session_name } => session_name,
        }
    }
}

struct PendingSessionOperation {
    session_id: String,
    kind: PendingSessionOperationKind,
    started_at: Instant,
    slow_notice_shown: bool,
    exit_warning_shown: bool,
    handle: tokio::task::JoinHandle<std::result::Result<(), SessionOperationError>>,
}

struct PendingWorkspaceReferenceSearch {
    generation: u64,
    query: String,
    handle:
        tokio::task::JoinHandle<std::result::Result<AgentWorkspaceReferenceSearchResult, String>>,
}

struct PendingWorkspaceDiff {
    handle: tokio::task::JoinHandle<std::result::Result<WorkspaceDiffSnapshot, String>>,
}

enum LineageInspectionTaskError {
    Runtime(SessionOperationError),
    Deadline,
}

impl LineageInspectionTaskError {
    fn outcome_unknown(&self) -> bool {
        matches!(self, Self::Runtime(error) if error.outcome_unknown())
    }
}

impl std::fmt::Display for LineageInspectionTaskError {
    fn fmt(&self, formatter: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        match self {
            Self::Runtime(error) => error.fmt(formatter),
            Self::Deadline => formatter.write_str("the transcript settlement deadline elapsed"),
        }
    }
}

enum PendingLineageOperation {
    Query {
        root_session_id: String,
        handle: tokio::task::JoinHandle<anyhow::Result<Option<AgentSessionLineageSnapshot>>>,
    },
    Inspect {
        entry: AgentSessionLineageEntry,
        refresh: bool,
        event_generation: u64,
        handle: tokio::task::JoinHandle<
            std::result::Result<AgentSessionLineageInspection, LineageInspectionTaskError>,
        >,
    },
}

impl PendingLineageOperation {
    fn is_finished(&self) -> bool {
        match self {
            Self::Query { handle, .. } => handle.is_finished(),
            Self::Inspect { handle, .. } => handle.is_finished(),
        }
    }

    fn abort(&self) {
        match self {
            Self::Query { handle, .. } => handle.abort(),
            Self::Inspect { handle, .. } => handle.abort(),
        }
    }
}

struct PendingLineageCancellation {
    root_session_id: String,
    session_id: String,
    navigation_generation: u64,
    handle: tokio::task::JoinHandle<anyhow::Result<AgentTurnCancellationResult>>,
}

#[derive(Debug, Clone)]
struct ExternalPromptCommandInvocation {
    command_name: String,
    arguments: String,
    native_commands: Vec<NativePromptCommandDescriptor>,
    candidate_id: Option<String>,
    content_version: Option<String>,
    native_conflict_key: Option<String>,
    expected_preference_revision: Option<u64>,
}

struct PendingPromptCommandShellInvocation {
    invocation: ExternalPromptCommandInvocation,
    review: PromptCommandShellReviewPlan,
}

enum PendingLocalEffect {
    EditComposer {
        command: external_editor::EditorCommand,
        draft: crate::ui::composer::ComposerDraft,
    },
    ExportTranscript {
        markdown: String,
        target: Option<std::path::PathBuf>,
        editor_command: Option<external_editor::EditorCommand>,
        editor_error: Option<String>,
        overwrite_confirmed: bool,
    },
}

fn terminal_event_allowed_while_local_effect_pending(event: &Event) -> bool {
    matches!(event, Event::Resize(_, _))
}

const SESSION_OPERATION_SLOW_NOTICE: Duration = Duration::from_secs(15);
const SHARED_TUI_CHAT_STATUS: &str = "Shared TUI preview: this view controls sessions, including deleting an idle Session, turns, the current Session name, current Session Agent mode, and declarative context via /reload [skills|instructions]. Model, Skill, Subagent, and MCP management use this CLI process's local compatibility owner; MCP process state and tool registration are local to this CLI process and do not reconfigure an already-running Shared Runtime Host. Local extension, account, usage, and other management remain Embedded.";

#[derive(Default)]
struct NonKeyEventOutcome {
    request_redraw: bool,
    resize_observed: bool,
}

struct ChatEventContext<'a> {
    this: &'a mut ChatMode,
    chat_view: &'a mut ChatView,
    chat_state: &'a mut ChatState,
    session_id: &'a mut String,
    rt_handle: &'a tokio::runtime::Handle,
    should_quit: &'a mut bool,
    exit_reason: &'a mut ChatExitReason,
}

struct AgentSessionInspection {
    selected_session_id: String,
    chat_state: ChatState,
    /// Runtime events invalidate this read model. Live chunks are projected
    /// directly; Runtime transcript reads replace it authoritatively.
    refresh_pending: bool,
    refresh_due_at: Instant,
    refresh_deadline: Option<Instant>,
    refresh_retry_delay: Duration,
}

struct BufferedLineageEvent {
    event: AgenticEvent,
    encoded_bytes: usize,
}

const LINEAGE_EVENT_BUFFER_MAX_BYTES: usize = 1024 * 1024;
const LINEAGE_EVENT_BUFFER_MAX_EVENTS: usize = 4096;
const LINEAGE_READ_BARRIER_MAX_TURNS_PER_SESSION: usize = 256;
const LINEAGE_SETTLEMENT_RETRY_WINDOW: Duration = Duration::from_secs(5);
const LINEAGE_SETTLEMENT_RETRY_MIN: Duration = Duration::from_millis(250);
const LINEAGE_SETTLEMENT_RETRY_MAX: Duration = Duration::from_secs(1);

pub(crate) struct ChatMode {
    config: CliConfig,
    keymap: ResolvedKeymap,
    /// Current agent type (e.g. "Standard", "Cowork", "DeepResearch")
    agent_type: String,
    workspace: Option<String>,
    local_cwd: std::path::PathBuf,
    agent: Arc<CliAgentRuntimeClient>,
    account_runtime: Option<Arc<AccountRuntime>>,
    /// User-level default resolved from shared config for this TUI run.
    auto_approve_ask_default: bool,
    /// Temporary override for the current session only.
    auto_approve_ask_override: Option<bool>,
    /// If set, restore this existing session instead of creating a new one
    restore_session_id: Option<String>,
    /// If set, send this prompt automatically when the session starts
    initial_prompt: Option<crate::ui::composer::ComposerDraft>,
    /// If set, override the session model after create/restore
    model_id: Option<String>,
    /// Pending MCP operation — set in key handler, executed after one render frame
    pending_mcp_op: Option<PendingMcpOp>,
    /// Running MCP tasks (non-blocking, polled in main loop)
    pending_mcp_tasks: Vec<PendingMcpTask>,
    /// One Session operation in flight. The event loop remains responsive while
    /// the Runtime owner updates or deletes Session state.
    pending_session_operation: Option<PendingSessionOperation>,
    pending_workspace_diff: Option<PendingWorkspaceDiff>,
    pending_local_effect: Option<PendingLocalEffect>,
    pending_workspace_reference_search: Option<PendingWorkspaceReferenceSearch>,
    /// One lineage read in flight. Runtime I/O never blocks the TUI
    /// event loop, and refresh requests cannot overlap.
    pending_lineage_operation: Option<PendingLineageOperation>,
    /// Side-effecting cancellation outlives navigation resets, but its result
    /// is only surfaced to the lineage generation that initiated it.
    pending_lineage_cancellation: Option<PendingLineageCancellation>,
    /// Last authoritative flat lineage read. This is a presentation cache only;
    /// Services remains the membership/order owner.
    lineage_snapshot: Option<AgentSessionLineageSnapshot>,
    /// Presentation-only index for the immutable ordering owned by Services.
    lineage_session_index: HashMap<String, usize>,
    lineage_inspection: Option<AgentSessionInspection>,
    /// Bounded presentation tail for active descendants. It bridges live
    /// broadcast output until the Runtime-owned transcript settles.
    lineage_event_buffer: VecDeque<BufferedLineageEvent>,
    lineage_event_buffer_bytes: usize,
    /// Advances whenever a lineage event can make an in-flight transcript read
    /// stale. Async inspection results are applied only to the generation they
    /// observed, so a late read cannot erase newer live projection state.
    lineage_event_generations: HashMap<String, u64>,
    lineage_navigation_generation: u64,
    /// Exact terminal Turns observed from Runtime events but not yet reflected
    /// by an authoritative inspection. These are read-consistency tokens, not
    /// a second settlement state machine.
    lineage_required_settled_turns: BTreeMap<String, Vec<String>>,
    workspace_reference_search_generation: u64,
    last_workspace_reference_query: Option<String>,
    /// One explicit native slash-menu choice waiting for its parameterized submission.
    selected_native_command_once: Option<String>,
    pending_prompt_command_shell_invocation: Option<PendingPromptCommandShellInvocation>,
    external_source_snapshot: Option<ExternalSourceCatalogSnapshot>,
    external_source_conflict_choices: BTreeMap<String, String>,
    external_source_conflict_lineage_current_keys: BTreeMap<String, String>,
    external_source_conflicted_candidate_ids: BTreeSet<String>,
    external_tool_notice_key: Option<String>,
    external_tool_review_snapshot: Option<ExternalSourceCatalogSnapshot>,
    external_tool_mutation_rx: Option<Receiver<ExternalToolMutationResult>>,
    external_control_snapshot: Option<
        openbitfun_product_domains::external_source_control::ExternalSourceControlSnapshotV1,
    >,
    external_control_mutation_rx: Option<Receiver<ExternalControlMutationResult>>,
    external_agent_notice_key: Option<String>,
    external_agent_review_snapshot: Option<ExternalSourceCatalogSnapshot>,
    external_agent_mutation_rx: Option<Receiver<ExternalAgentMutationResult>>,
    hook_management_rx:
        Option<Receiver<std::result::Result<HookManagementResult, ExternalSourceOperationError>>>,
    hook_management_snapshot: Option<HookManagementSnapshot>,
    pending_hook_plan: Option<ExternalHookImportPlanV1>,
}

/// Map agent_type to a display name for status messages
fn agent_display_name(agent_type: &str) -> &'static str {
    match agent_type {
        "Standard" => "Fang",
        _ => "AI Assistant",
    }
}

impl ChatMode {
    pub(crate) fn new(
        config: CliConfig,
        agent_type: String,
        workspace: Option<String>,
        agent: Arc<CliAgentRuntimeClient>,
        account_runtime: Option<Arc<AccountRuntime>>,
    ) -> Self {
        let keymap = ResolvedKeymap::new(&config.shortcuts);
        Self {
            config,
            keymap,
            agent_type,
            workspace,
            local_cwd: std::env::current_dir().unwrap_or_else(|_| std::path::PathBuf::from(".")),
            agent,
            account_runtime,
            auto_approve_ask_default: false,
            auto_approve_ask_override: None,
            restore_session_id: None,
            initial_prompt: None,
            model_id: None,
            pending_mcp_op: None,
            pending_mcp_tasks: Vec::new(),
            pending_session_operation: None,
            pending_workspace_diff: None,
            pending_local_effect: None,
            pending_workspace_reference_search: None,
            pending_lineage_operation: None,
            pending_lineage_cancellation: None,
            lineage_snapshot: None,
            lineage_session_index: HashMap::new(),
            lineage_inspection: None,
            lineage_event_buffer: VecDeque::new(),
            lineage_event_buffer_bytes: 0,
            lineage_event_generations: HashMap::new(),
            lineage_navigation_generation: 0,
            lineage_required_settled_turns: BTreeMap::new(),
            workspace_reference_search_generation: 0,
            last_workspace_reference_query: None,
            selected_native_command_once: None,
            pending_prompt_command_shell_invocation: None,
            external_source_snapshot: None,
            external_source_conflict_choices: BTreeMap::new(),
            external_source_conflict_lineage_current_keys: BTreeMap::new(),
            external_source_conflicted_candidate_ids: BTreeSet::new(),
            external_tool_notice_key: None,
            external_tool_review_snapshot: None,
            external_tool_mutation_rx: None,
            external_control_snapshot: None,
            external_control_mutation_rx: None,
            external_agent_notice_key: None,
            external_agent_review_snapshot: None,
            external_agent_mutation_rx: None,
            hook_management_rx: None,
            hook_management_snapshot: None,
            pending_hook_plan: None,
        }
    }

    /// Set a session ID to restore (for "Continue Last Session")
    pub(crate) fn with_restore_session(mut self, session_id: String) -> Self {
        self.restore_session_id = Some(session_id);
        self
    }

    /// Set an initial prompt to send automatically when the session starts
    pub(crate) fn with_initial_prompt(
        mut self,
        prompt: crate::ui::composer::ComposerDraft,
    ) -> Self {
        self.initial_prompt = Some(prompt);
        self
    }

    /// Set a model ID to override the session model after create/restore
    pub(crate) fn with_model(mut self, model_id: String) -> Self {
        self.model_id = Some(model_id);
        self
    }

    fn action_state(&self, is_processing: bool, popup_open: bool) -> ActionState {
        ActionState::chat(is_processing, popup_open)
            .with_shared_tui(self.agent.is_shared())
            .with_lineage_inspection(self.lineage_inspection.is_some())
    }
}

include!("chat/account.rs");
include!("chat/run.rs");
include!("chat/input.rs");
include!("chat/commands.rs");
include!("chat/worktree.rs");
include!("chat/selection.rs");
include!("chat/mcp.rs");
include!("chat/sessions.rs");
include!("chat/workspace_references.rs");
include!("chat/capabilities.rs");
include!("chat/session_lineage.rs");
include!("chat/provider_models.rs");
include!("chat/tests.rs");
