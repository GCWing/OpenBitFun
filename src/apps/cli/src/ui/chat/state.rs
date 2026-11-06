use ratatui::{
    layout::{Alignment, Constraint, Direction, Layout, Rect},
    style::{Modifier, Style},
    text::{Line, Span},
    widgets::{Block, Borders, List, ListItem, ListState, Paragraph, Wrap},
    Frame,
};
use std::collections::{HashMap, HashSet, VecDeque};
use unicode_width::{UnicodeWidthChar, UnicodeWidthStr};

use super::agent_selector::{AgentItem, AgentSelectorAction, AgentSelectorState};
use super::command_menu::{CommandMenuSelection, CommandMenuState};
use super::command_palette::{CommandPaletteState, PaletteAction};
use super::composer::{ComposerDraft, ComposerImageAttachment};
use super::export_dialog::ExportDialogState;
use super::fork_selector::{ForkAction, ForkSelectorState};
use super::login_form::{LoginFormAction, LoginFormState};
use super::markdown::MarkdownRenderer;
use super::mcp_add_dialog::{McpAddAction, McpAddDialogState};
use super::mcp_selector::{McpAction, McpItem, McpSelectorState};
use super::model_config_form::{ModelConfigFormState, ModelFormAction};
use super::model_selector::{ModelItem, ModelSelectorState};
use super::permission::render_permission_overlay;
use super::prompt_stash_selector::PromptStashSelectorState;
use super::provider_selector::{ProviderSelection, ProviderSelectorState};
use super::question::render_question_overlay;
use super::session_lineage_selector::{SessionLineageAction, SessionLineageSelectorState};
use super::session_selector::{SessionAction, SessionItem, SessionSelectorState};
use super::skill_selector::{SkillItem, SkillSelectorAction, SkillSelectorState};
use super::subagent_selector::{SubagentItem, SubagentSelectorAction, SubagentSelectorState};
use super::text_input::TextInput;
use super::theme::{StyleKind, Theme};
use super::theme_selector::{ThemeItem, ThemeSelectorState};
use super::timeline_selector::{TimelineAction, TimelineSelectorState};
use super::widgets::Spinner;
use super::workspace_diff::WorkspaceDiffViewState;
use super::workspace_reference::{WorkspaceReferencePopupState, WorkspaceReferenceQuery};
use crate::actions::{ActionState, ResolvedKeymap};
use crate::chat_state::{ChatMessage, ChatState, FlowItem, MessageRole};

#[derive(Debug)]
struct SubmittedDraftRecord {
    sequence: u64,
    draft: ComposerDraft,
    mode: ComposerMode,
}

#[derive(Debug, Clone, Copy, Default, PartialEq, Eq)]
pub(crate) enum ComposerMode {
    #[default]
    Chat,
    Shell,
}

#[derive(Debug, Default)]
struct InactiveSessionComposer {
    draft: ComposerDraft,
    mode: ComposerMode,
}

#[derive(Debug, Default)]
struct SessionSubmittedDraftHistory {
    active: Vec<SubmittedDraftRecord>,
    undone: Vec<SubmittedDraftRecord>,
}

#[derive(Debug, Default)]
struct SubmittedDraftHistory {
    sessions: HashMap<String, SessionSubmittedDraftHistory>,
    next_sequence: u64,
}

/// Types of popups that can be shown in the ChatView
#[derive(Debug, Clone, PartialEq)]
pub(crate) enum PopupType {
    CommandPalette,
    ModelSelector,
    AgentSelector,
    SessionSelector,
    SessionLineageSelector,
    ForkSelector,
    TimelineSelector,
    PromptStashSelector,
    MessageQueue,
    ExportDialog,
    SkillSelector,
    SubagentSelector,
    McpSelector,
    McpAddDialog,
    ProviderSelector,
    ModelConfigForm,
    LoginForm,
    ThemeSelector,
    InfoPopup,
    WorkspaceDiff,
}

/// Navigation stack for managing popup hierarchy
#[derive(Debug, Default)]
pub(crate) struct PopupStack {
    stack: Vec<PopupType>,
}

impl PopupStack {
    fn new() -> Self {
        Self { stack: Vec::new() }
    }

    /// Push a popup onto the stack
    fn push(&mut self, popup: PopupType) {
        // Avoid duplicates at the top
        if self.stack.last() != Some(&popup) {
            self.stack.push(popup);
        }
    }

    /// Pop the top popup from the stack
    pub(crate) fn pop(&mut self) -> Option<PopupType> {
        self.stack.pop()
    }

    /// Peek at the top popup without removing it
    pub(crate) fn peek(&self) -> Option<&PopupType> {
        self.stack.last()
    }

    /// Clear all popups from the stack
    pub(crate) fn clear(&mut self) {
        self.stack.clear();
    }
}

/// Cached render result for a single message
struct MessageRenderEntry {
    items: Vec<ListItem<'static>>,
    line_count: usize,
    version: u64,
    width: u16,
    plain_lines: Vec<String>,
    /// Message-local clickable regions for block tools: (tool_id, y_start, y_end)
    tool_regions: Vec<(String, u16, u16)>,
    /// Message-local clickable regions for thinking blocks: (message_id, y_start, y_end)
    thinking_regions: Vec<(String, u16, u16)>,
}

struct MessageRenderResult {
    items: Vec<ListItem<'static>>,
    tool_regions: Vec<(String, u16, u16)>,
    thinking_regions: Vec<(String, u16, u16)>,
    plain_lines: Vec<String>,
}

#[derive(Debug, Default)]
struct DisclosureOverrides {
    flipped: HashSet<String>,
}

impl DisclosureOverrides {
    fn is_collapsed(&self, id: &str, default_collapsed: bool) -> bool {
        default_collapsed ^ self.flipped.contains(id)
    }

    fn toggle(&mut self, id: &str) {
        if !self.flipped.remove(id) {
            self.flipped.insert(id.to_string());
        }
    }

    fn clear(&mut self) {
        self.flipped.clear();
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
struct TranscriptPresentation {
    timestamps: bool,
    thinking: crate::config::ThinkingMode,
    tool_details: bool,
}

impl Default for TranscriptPresentation {
    fn default() -> Self {
        Self {
            timestamps: false,
            thinking: crate::config::ThinkingMode::Hide,
            tool_details: true,
        }
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
struct TextSelectionPoint {
    line: usize,
    col: usize,
}

/// Chat interface state (input + view state only, no session data)
pub(crate) struct ChatView {
    /// Theme
    theme: Theme,
    /// Multiline text input component
    pub(crate) text_input: TextInput,
    /// Slash command menu state
    command_menu: CommandMenuState,
    /// Command palette state (Ctrl+P)
    command_palette: CommandPaletteState,
    /// Footer hints derived from the resolved CLI action bindings.
    shortcut_hints: Vec<(String, &'static str)>,
    /// List scroll state
    list_state: ListState,
    /// Whether to auto-scroll to bottom
    auto_scroll: bool,
    /// Loading animation
    spinner: Spinner,
    /// Status message
    status: Option<String>,
    /// Input history (for up/down arrows)
    input_history: VecDeque<ComposerDraft>,
    /// Shell command history is intentionally isolated from chat prompts.
    shell_input_history: VecDeque<ComposerDraft>,
    composer_mode: ComposerMode,
    /// Unsent composer state for inactive Sessions. The active Session remains
    /// represented by the existing composer fields, so rich drafts are never
    /// duplicated between two UI owners.
    inactive_session_composers: HashMap<String, InactiveSessionComposer>,
    /// Drafts accepted by the Runtime, isolated by Session for local undo/redo identity.
    submitted_drafts: SubmittedDraftHistory,
    workspace_references: Vec<openbitfun_agent_runtime::sdk::AgentWorkspaceReference>,
    image_attachments: Vec<ComposerImageAttachment>,
    workspace_reference_popup: WorkspaceReferencePopupState,
    /// History position
    history_index: Option<usize>,
    /// Markdown renderer
    markdown_renderer: MarkdownRenderer,
    /// Whether in browse mode (for scrolling through history)
    pub(crate) browse_mode: bool,
    /// Message scroll offset (from bottom up)
    scroll_offset: usize,
    /// Message pinned by an accepted timeline jump while the transcript grows.
    committed_message_anchor: Option<String>,
    /// Model selector popup state
    model_selector: ModelSelectorState,
    /// Agent selector popup state
    agent_selector: AgentSelectorState,
    /// Session selector popup state
    session_selector: SessionSelectorState,
    session_lineage_selector: SessionLineageSelectorState,
    /// OpenCode-compatible session fork-point selector.
    fork_selector: ForkSelectorState,
    /// OpenCode-compatible user-message timeline selector.
    timeline_selector: TimelineSelectorState,
    lineage_inspection_label: Option<String>,
    prompt_stash_selector: PromptStashSelectorState,
    message_queue: super::message_queue::MessageQueueState,
    export_dialog: ExportDialogState,
    /// Skill selector popup state
    skill_selector: SkillSelectorState,
    /// Subagent selector popup state
    subagent_selector: SubagentSelectorState,
    /// MCP selector popup state
    mcp_selector: McpSelectorState,
    /// MCP add dialog state
    mcp_add_dialog: McpAddDialogState,
    /// Provider selector popup state (step 1 of add model)
    provider_selector: ProviderSelectorState,
    /// Model config form state (step 2 of add model)
    model_config_form: ModelConfigFormState,
    /// Account login form (dedicated full-viewport page)
    login_form: LoginFormState,
    /// Theme selector popup state
    theme_selector: ThemeSelectorState,

    // -- Tool card expand/collapse state --
    /// Per-tool overrides relative to the configured default.
    tool_disclosures: DisclosureOverrides,
    /// Currently focused block tool ID (for Ctrl+O toggle)
    focused_block_tool: Option<String>,

    // -- Thinking expand/collapse state --
    /// Per-thinking-block manual-expand overrides. Only consulted while
    /// thinking defaults to collapsed (Hide); in Show mode all blocks are
    /// expanded regardless of these overrides so a `/thinking` round-trip
    /// preserves manual expansions.
    thinking_disclosures: DisclosureOverrides,
    presentation: TranscriptPresentation,

    // -- Mouse click tracking --
    /// Pending command from mouse click on command menu (consumed by caller)
    pending_command: Option<CommandMenuSelection>,
    /// Pending theme preview selection (consumed by caller)
    pending_theme_preview: Option<ThemeItem>,
    /// Original theme before entering theme preview mode
    theme_preview_original: Option<Theme>,

    /// Pending MCP toggle from mouse click (consumed by caller)
    pending_mcp_toggle: Option<McpItem>,
    /// Pending skill selector action from mouse click (consumed by caller)
    pending_skill_action: Option<SkillSelectorAction>,
    /// Pending Agent entry action from mouse click (consumed by caller)
    pending_agent_action: Option<AgentSelectorAction>,
    /// Pending subagent selector action from mouse click (consumed by caller)
    pending_subagent_action: Option<SubagentSelectorAction>,

    /// Info popup message and vertical scroll position.
    info_popup: Option<String>,
    info_popup_scroll: u16,
    info_popup_max_scroll: u16,
    prompt_command_shell_review:
        Option<crate::ui::prompt_command_shell_review::PromptCommandShellReviewPrompt>,
    workspace_diff: WorkspaceDiffViewState,

    /// Hovered thinking block (message_id) for mouse-over highlight
    hovered_thinking_block_id: Option<String>,

    /// Recorded y-coordinate regions for block tools: (tool_id, y_start, y_end)
    /// Updated each render frame for mouse click hit-testing.
    block_tool_regions: Vec<(String, u16, u16)>,
    /// Recorded y-coordinate regions for thinking blocks: (message_id, y_start, y_end)
    /// Updated each render frame for mouse click hit-testing.
    thinking_regions: Vec<(String, u16, u16)>,
    /// The messages area rect (for converting absolute mouse coords to relative)
    messages_area: Option<Rect>,
    /// Plain-text lines for the currently rendered message list subset.
    /// Index space matches the List rows before `list_state.offset`.
    visible_plain_lines: Vec<String>,
    /// Mouse selection anchor point in `visible_plain_lines`.
    selection_anchor: Option<TextSelectionPoint>,
    /// Mouse selection focus point in `visible_plain_lines`.
    selection_focus: Option<TextSelectionPoint>,
    /// Mouse down origin used to distinguish click vs drag.
    selection_mouse_down: Option<(u16, u16)>,
    /// Whether current mouse gesture has moved enough to be treated as drag selection.
    selection_dragged: bool,

    /// Popup navigation stack for back navigation
    pub(crate) popup_stack: PopupStack,

    // -- Render cache state (performance optimization) --
    /// Cached total rendered line count (updated each render frame)
    cached_total_lines: usize,
    /// Message count when cache was last updated
    cached_msg_count: usize,
    /// Terminal width when cache was last updated
    cached_width: u16,
    /// Whether the line cache needs recalculation (set true during streaming)
    lines_cache_dirty: bool,
    /// Per-message render cache: msg_id -> cached render result.
    /// Only caches completed (non-streaming) messages.
    render_cache: HashMap<String, MessageRenderEntry>,
}

impl ChatView {
    /// Create new Chat view
    pub(crate) fn new(theme: Theme, shortcut_hints: Vec<(String, &'static str)>) -> Self {
        let markdown_renderer = MarkdownRenderer::new(theme.clone());
        Self {
            spinner: Spinner::new(theme.style(StyleKind::Primary)),
            markdown_renderer,
            theme,
            text_input: TextInput::new(),
            command_menu: CommandMenuState::new(ActionState::chat(false, false)),
            command_palette: CommandPaletteState::new(),
            shortcut_hints,
            list_state: ListState::default(),
            auto_scroll: true,
            status: None,
            input_history: VecDeque::with_capacity(50),
            shell_input_history: VecDeque::with_capacity(50),
            composer_mode: ComposerMode::Chat,
            inactive_session_composers: HashMap::new(),
            submitted_drafts: SubmittedDraftHistory::default(),
            workspace_references: Vec::new(),
            image_attachments: Vec::new(),
            workspace_reference_popup: WorkspaceReferencePopupState::default(),
            history_index: None,
            browse_mode: false,
            scroll_offset: 0,
            committed_message_anchor: None,
            model_selector: ModelSelectorState::new(),
            agent_selector: AgentSelectorState::new(),
            session_selector: SessionSelectorState::new(),
            session_lineage_selector: SessionLineageSelectorState::new(),
            fork_selector: ForkSelectorState::new(),
            timeline_selector: TimelineSelectorState::new(),
            lineage_inspection_label: None,
            prompt_stash_selector: PromptStashSelectorState::new(),
            message_queue: super::message_queue::MessageQueueState::new(),
            export_dialog: ExportDialogState::new(),
            skill_selector: SkillSelectorState::new(),
            subagent_selector: SubagentSelectorState::new(),
            mcp_selector: McpSelectorState::new(),
            mcp_add_dialog: McpAddDialogState::new(),
            provider_selector: ProviderSelectorState::new(),
            model_config_form: ModelConfigFormState::new(),
            login_form: LoginFormState::new(),
            theme_selector: ThemeSelectorState::new(),
            pending_command: None,
            pending_mcp_toggle: None,
            pending_skill_action: None,
            pending_agent_action: None,
            pending_subagent_action: None,
            pending_theme_preview: None,
            theme_preview_original: None,
            info_popup: None,
            info_popup_scroll: 0,
            info_popup_max_scroll: 0,
            prompt_command_shell_review: None,
            workspace_diff: WorkspaceDiffViewState::new(),
            hovered_thinking_block_id: None,
            tool_disclosures: DisclosureOverrides::default(),
            focused_block_tool: None,
            thinking_disclosures: DisclosureOverrides::default(),
            presentation: TranscriptPresentation::default(),
            block_tool_regions: Vec::new(),
            thinking_regions: Vec::new(),
            messages_area: None,
            visible_plain_lines: Vec::new(),
            selection_anchor: None,
            selection_focus: None,
            selection_mouse_down: None,
            selection_dragged: false,
            popup_stack: PopupStack::new(),
            cached_total_lines: 0,
            cached_msg_count: 0,
            cached_width: 0,
            lines_cache_dirty: true,
            render_cache: HashMap::new(),
        }
    }

    pub(crate) fn set_action_state(&mut self, state: ActionState, keymap: &ResolvedKeymap) {
        self.shortcut_hints = keymap.compact_hints(state);
        self.agent_selector
            .set_mode_switch_allowed(!state.is_processing);
        self.command_palette.set_action_state(state);
        if self.command_menu.set_action_state(state) {
            self.refresh_command_menu();
        }
    }

    pub(crate) fn apply_presentation_config(&mut self, config: &crate::config::UiConfig) {
        self.presentation = TranscriptPresentation {
            timestamps: config.timestamps,
            thinking: config.thinking,
            tool_details: config.tool_details,
        };
        self.invalidate_render_cache();
    }

    #[cfg(test)]
    pub(crate) fn timestamps_visible(&self) -> bool {
        self.presentation.timestamps
    }

    #[cfg(test)]
    pub(crate) fn thinking_mode(&self) -> crate::config::ThinkingMode {
        self.presentation.thinking
    }

    /// Simulate a mouse click that manually expands/collapses a thinking
    /// block, identified by the owning message id and the block's index
    /// within that message. Mirrors the id scheme used by `render_message`.
    #[cfg(test)]
    pub(crate) fn toggle_thinking_block_for_test(&mut self, message_id: &str, block_index: usize) {
        let id = format!("{}::thinking:{}", message_id, block_index);
        self.thinking_disclosures.toggle(&id);
        self.invalidate_render_cache();
    }

    #[cfg(test)]
    pub(crate) fn tool_details_visible(&self) -> bool {
        self.presentation.tool_details
    }

    pub(crate) fn toggle_timestamps(&mut self) -> bool {
        self.presentation.timestamps = !self.presentation.timestamps;
        self.invalidate_render_cache();
        self.presentation.timestamps
    }

    pub(crate) fn toggle_thinking(&mut self) -> crate::config::ThinkingMode {
        self.presentation.thinking = match self.presentation.thinking {
            crate::config::ThinkingMode::Show => crate::config::ThinkingMode::Hide,
            crate::config::ThinkingMode::Hide => crate::config::ThinkingMode::Show,
        };
        self.invalidate_render_cache();
        self.presentation.thinking
    }

    pub(crate) fn toggle_tool_details(&mut self) -> bool {
        self.presentation.tool_details = !self.presentation.tool_details;
        self.invalidate_render_cache();
        self.presentation.tool_details
    }
}

#[cfg(test)]
mod presentation_state_tests {
    use super::{ChatView, DisclosureOverrides};
    use crate::config::{ThinkingMode, UiConfig};
    use crate::ui::theme::Theme;

    #[test]
    fn one_disclosure_override_model_serves_thinking_and_tool_defaults() {
        let mut overrides = DisclosureOverrides::default();

        assert!(overrides.is_collapsed("block-1", true));
        assert!(!overrides.is_collapsed("block-1", false));

        overrides.toggle("block-1");
        assert!(!overrides.is_collapsed("block-1", true));
        assert!(overrides.is_collapsed("block-1", false));

        overrides.toggle("block-1");
        assert!(!overrides.is_collapsed("block-1", false));
    }

    #[test]
    fn presentation_state_projects_config_and_toggles_exact_open_code_modes() {
        let mut view = ChatView::new(Theme::dark(), Vec::new());
        let mut config = UiConfig::default();
        config.timestamps = true;
        config.thinking = ThinkingMode::Show;
        config.tool_details = false;

        view.apply_presentation_config(&config);
        assert!(view.timestamps_visible());
        assert_eq!(view.thinking_mode(), ThinkingMode::Show);
        assert!(!view.tool_details_visible());

        assert!(!view.toggle_timestamps());
        assert_eq!(view.toggle_thinking(), ThinkingMode::Hide);
        assert!(view.toggle_tool_details());
    }
}
