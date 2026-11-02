use crossterm::event::{KeyCode, KeyEvent, KeyModifiers};

use crate::config::ShortcutsConfig;

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub(crate) enum ActionContext {
    Startup,
    Chat,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub(crate) enum ActionAvailability {
    Always,
    Idle,
    Processing,
    Popup,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub(crate) struct ActionState {
    pub context: ActionContext,
    pub is_processing: bool,
    pub popup_open: bool,
    shared_tui: bool,
    lineage_inspection: bool,
}

impl ActionState {
    pub(crate) const fn startup(popup_open: bool) -> Self {
        Self {
            context: ActionContext::Startup,
            is_processing: false,
            popup_open,
            shared_tui: false,
            lineage_inspection: false,
        }
    }

    pub(crate) const fn chat(is_processing: bool, popup_open: bool) -> Self {
        Self {
            context: ActionContext::Chat,
            is_processing,
            popup_open,
            shared_tui: false,
            lineage_inspection: false,
        }
    }

    pub(crate) const fn with_shared_tui(mut self, shared_tui: bool) -> Self {
        self.shared_tui = shared_tui;
        self
    }

    pub(crate) const fn with_lineage_inspection(mut self, lineage_inspection: bool) -> Self {
        self.lineage_inspection = lineage_inspection;
        self
    }

    #[cfg(test)]
    pub(crate) const fn for_shared_tui(self) -> Self {
        self.with_shared_tui(true)
    }
}

const STARTUP_ACTION_STATES: &[ActionState] =
    &[ActionState::startup(false), ActionState::startup(true)];
const CHAT_ACTION_STATES: &[ActionState] = &[
    ActionState::chat(false, false),
    ActionState::chat(true, false),
    ActionState::chat(false, true),
    ActionState::chat(true, true),
];

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub(crate) enum ActionHandler {
    Help,
    OpenAgentSelector,
    SwitchAgent,
    SwitchAgentReverse,
    SelectModel,
    SelectTheme,
    AddModel,
    NewSession,
    Sessions,
    ViewSubagents,
    Timeline,
    ForkSession,
    UndoSession,
    RedoSession,
    RenameSession,
    Skills,
    Reload,
    McpServers,
    Tools,
    Extensions,
    NativeHooks,
    ExternalHooks,
    AcpHelp,
    Init,
    Status,
    WorkspaceDiff,
    CompactSession,
    GoalPrompt,
    Usage,
    Editor,
    PromptStash,
    PromptStashPop,
    PromptStashList,
    ToggleTimestamps,
    ToggleThinking,
    ToggleToolDetails,
    CopyTranscript,
    ExportTranscript,
    ToggleAutoApprove,
    ToggleWorktree,
    Exit,
    Login,
    Logout,
    OpenPalette,
    SubmitInput,
    Interrupt,
    ClosePopups,
    NavigateBack,
    InsertNewline,
    Paste,
    ToggleFocusedTool,
    PreviousTool,
    NextTool,
    HistoryPrevious,
    HistoryNext,
    JumpTop,
    JumpBottom,
    ClearInput,
    ToggleBrowse,
    ScrollUp,
    ScrollDown,
}

pub(crate) const SHARED_TUI_EMBEDDED_HANDOFF: &str =
    "Exit all Shared TUI clients, wait up to 30 seconds for their Runtime to stop, then use default Embedded `openbitfun chat`";
pub(crate) const IMAGE_ATTACHMENTS_REQUIRE_MESSAGE: &str =
    "Remove image attachments before running a slash command.";
pub(crate) fn shared_tui_image_attachment_error() -> String {
    format!("Image attachments are unavailable in Shared TUI. {SHARED_TUI_EMBEDDED_HANDOFF}.")
}
pub(crate) const SHARED_TUI_HELP_NOTE: &str =
    "Shared TUI: start with `openbitfun chat --shared`. Multiple TUI processes reuse one workspace Runtime, while each TUI controls at most one Session and each Session has one controller. Use `/sessions` and Ctrl+D to delete an idle, non-current Session; use `View subagents` in the command palette to inspect this Session's subagents; use `/timeline` to navigate user messages, `/fork` to branch the current idle Session, `/rename <name>` to rename it, `/compact` to compact its context, `/diff` to review workspace changes, `/agent`, Tab, or Shift+Tab to change its Agent mode, `/models` and `/connect` to manage models, `/skills` to manage skills, `/mcp` to manage MCP servers, and `/reload [skills|instructions]` to refresh declarative context for the next message. Model, Skill, Subagent, and MCP management use this CLI process's local compatibility owner; MCP process state and tool registration are local to this CLI process and do not reconfigure an already-running Shared Runtime Host. Extensions, account-sync, usage, and other management remain Embedded. Exit all Shared TUI clients and wait up to 30 seconds before returning to default Embedded `openbitfun chat`.";

impl ActionHandler {
    pub(crate) const fn available_in_shared_tui(self, _context: ActionContext) -> bool {
        matches!(
            self,
            Self::Help
                | Self::SelectTheme
                | Self::NewSession
                | Self::Sessions
                | Self::ViewSubagents
                | Self::SelectModel
                | Self::AddModel
                | Self::Skills
                | Self::McpServers
                | Self::Timeline
                | Self::ForkSession
                | Self::UndoSession
                | Self::RedoSession
                | Self::RenameSession
                | Self::AcpHelp
                | Self::Init
                | Self::Status
                | Self::WorkspaceDiff
                | Self::CompactSession
                | Self::GoalPrompt
                | Self::Editor
                | Self::PromptStash
                | Self::PromptStashPop
                | Self::PromptStashList
                | Self::ToggleTimestamps
                | Self::ToggleThinking
                | Self::ToggleToolDetails
                | Self::CopyTranscript
                | Self::ExportTranscript
                | Self::ToggleAutoApprove
                | Self::OpenAgentSelector
                | Self::SwitchAgent
                | Self::SwitchAgentReverse
                | Self::Reload
                | Self::Exit
                | Self::OpenPalette
                | Self::SubmitInput
                | Self::Interrupt
                | Self::ClosePopups
                | Self::NavigateBack
                | Self::InsertNewline
                | Self::Paste
                | Self::ToggleFocusedTool
                | Self::PreviousTool
                | Self::NextTool
                | Self::HistoryPrevious
                | Self::HistoryNext
                | Self::JumpTop
                | Self::JumpBottom
                | Self::ClearInput
                | Self::ToggleBrowse
                | Self::ScrollUp
                | Self::ScrollDown
        )
    }

    const fn available_in_lineage_inspection(self) -> bool {
        matches!(
            self,
            Self::Help
                | Self::Sessions
                | Self::ViewSubagents
                | Self::Timeline
                | Self::SelectTheme
                | Self::ToggleTimestamps
                | Self::ToggleThinking
                | Self::ToggleToolDetails
                | Self::CopyTranscript
                | Self::ExportTranscript
                | Self::Exit
                | Self::OpenPalette
                | Self::Interrupt
                | Self::ClosePopups
                | Self::NavigateBack
                | Self::ToggleFocusedTool
                | Self::PreviousTool
                | Self::NextTool
                | Self::JumpTop
                | Self::JumpBottom
                | Self::ToggleBrowse
                | Self::ScrollUp
                | Self::ScrollDown
        )
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum ShortcutField {
    SendMessage,
    Interrupt,
    Menu,
}

impl ShortcutField {
    fn value(self, shortcuts: &ShortcutsConfig) -> Option<&str> {
        match self {
            Self::SendMessage => shortcuts.send_message.as_deref(),
            Self::Interrupt => shortcuts.interrupt.as_deref(),
            Self::Menu => shortcuts.menu.as_deref(),
        }
    }

    const fn source(self) -> &'static str {
        match self {
            Self::SendMessage => "shortcuts.send_message",
            Self::Interrupt => "shortcuts.interrupt",
            Self::Menu => "shortcuts.menu",
        }
    }
}

#[derive(Debug, Clone, Copy)]
pub(crate) struct PaletteSpec {
    pub group: &'static str,
    pub suggested: bool,
}

#[derive(Debug, Clone, Copy)]
pub(crate) struct ActionSpec {
    pub id: &'static str,
    pub name: &'static str,
    pub aliases: &'static [&'static str],
    pub description: &'static str,
    pub contexts: &'static [ActionContext],
    pub availability: ActionAvailability,
    pub handler: ActionHandler,
    pub default_bindings: &'static [&'static str],
    fallback_bindings: &'static [&'static str],
    shortcut_field: Option<ShortcutField>,
    pub palette: Option<PaletteSpec>,
    pub shortcut_label: Option<&'static str>,
    slash_on_startup: bool,
}

#[derive(Debug, Clone, Copy)]
pub(crate) struct ActionProjection {
    pub id: &'static str,
    pub name: &'static str,
    pub description: &'static str,
    pub palette_group: Option<&'static str>,
    pub suggested: bool,
}

const CHAT: &[ActionContext] = &[ActionContext::Chat];
const BOTH: &[ActionContext] = &[ActionContext::Startup, ActionContext::Chat];

const fn palette(group: &'static str, suggested: bool) -> Option<PaletteSpec> {
    Some(PaletteSpec { group, suggested })
}

static ACTION_SPECS: &[ActionSpec] = &[
    ActionSpec {
        id: "help",
        name: "Help",
        aliases: &["/help"],
        description: "Show keyboard shortcuts",
        contexts: BOTH,
        availability: ActionAvailability::Always,
        handler: ActionHandler::Help,
        default_bindings: &[],
        fallback_bindings: &[],
        shortcut_field: None,
        palette: palette("System", false),
        shortcut_label: None,
        slash_on_startup: true,
    },
    ActionSpec {
        id: "switch_agent",
        name: "Agent",
        aliases: &["/agent", "/agents"],
        description: "Switch modes and manage agents",
        contexts: BOTH,
        availability: ActionAvailability::Always,
        handler: ActionHandler::OpenAgentSelector,
        default_bindings: &[],
        fallback_bindings: &[],
        shortcut_field: None,
        palette: palette("Agent", true),
        shortcut_label: None,
        slash_on_startup: true,
    },
    ActionSpec {
        id: "cycle_agent",
        name: "Cycle agent",
        aliases: &[],
        description: "Switch to the next agent mode",
        contexts: BOTH,
        availability: ActionAvailability::Idle,
        handler: ActionHandler::SwitchAgent,
        default_bindings: &["Tab"],
        fallback_bindings: &[],
        shortcut_field: None,
        palette: None,
        shortcut_label: Some("Switch Agent"),
        slash_on_startup: false,
    },
    ActionSpec {
        id: "switch_agent_reverse",
        name: "Switch agent backwards",
        aliases: &[],
        description: "Switch to the previous agent mode",
        contexts: BOTH,
        availability: ActionAvailability::Idle,
        handler: ActionHandler::SwitchAgentReverse,
        default_bindings: &["Shift+Tab"],
        fallback_bindings: &[],
        shortcut_field: None,
        palette: None,
        shortcut_label: None,
        slash_on_startup: false,
    },
    ActionSpec {
        id: "select_model",
        name: "Select model",
        aliases: &["/models"],
        description: "Select model",
        contexts: BOTH,
        availability: ActionAvailability::Idle,
        handler: ActionHandler::SelectModel,
        default_bindings: &[],
        fallback_bindings: &[],
        shortcut_field: None,
        palette: palette("Models", true),
        shortcut_label: None,
        slash_on_startup: true,
    },
    ActionSpec {
        id: "theme",
        name: "Theme",
        aliases: &["/theme"],
        description: "Switch UI theme",
        contexts: BOTH,
        availability: ActionAvailability::Always,
        handler: ActionHandler::SelectTheme,
        default_bindings: &[],
        fallback_bindings: &[],
        shortcut_field: None,
        palette: palette("Appearance", true),
        shortcut_label: None,
        slash_on_startup: true,
    },
    ActionSpec {
        id: "add_model",
        name: "Add model",
        aliases: &["/connect"],
        description: "Add a new AI model configuration",
        contexts: BOTH,
        availability: ActionAvailability::Always,
        handler: ActionHandler::AddModel,
        default_bindings: &[],
        fallback_bindings: &[],
        shortcut_field: None,
        palette: palette("Models", false),
        shortcut_label: None,
        slash_on_startup: true,
    },
    ActionSpec {
        id: "new_session",
        name: "New session",
        aliases: &["/new", "/clear"],
        description: "Start a fresh conversation session",
        contexts: BOTH,
        availability: ActionAvailability::Idle,
        handler: ActionHandler::NewSession,
        default_bindings: &[],
        fallback_bindings: &[],
        shortcut_field: None,
        palette: palette("Session", true),
        shortcut_label: None,
        slash_on_startup: false,
    },
    ActionSpec {
        id: "sessions",
        name: "Sessions",
        aliases: &["/sessions", "/resume", "/continue", "/history"],
        description: "Browse and switch sessions",
        contexts: BOTH,
        availability: ActionAvailability::Idle,
        handler: ActionHandler::Sessions,
        default_bindings: &[],
        fallback_bindings: &[],
        shortcut_field: None,
        palette: palette("Session", false),
        shortcut_label: None,
        slash_on_startup: true,
    },
    ActionSpec {
        id: "timeline",
        name: "Timeline",
        aliases: &["/timeline"],
        description: "Jump to a user message in the current session",
        contexts: CHAT,
        availability: ActionAvailability::Always,
        handler: ActionHandler::Timeline,
        default_bindings: &[],
        fallback_bindings: &[],
        shortcut_field: None,
        palette: palette("Session", false),
        shortcut_label: None,
        slash_on_startup: false,
    },
    ActionSpec {
        id: "view_subagents",
        name: "View subagents",
        aliases: &[],
        description: "Inspect child agent sessions",
        contexts: CHAT,
        availability: ActionAvailability::Always,
        handler: ActionHandler::ViewSubagents,
        default_bindings: &[],
        fallback_bindings: &[],
        shortcut_field: None,
        palette: palette("Session", false),
        shortcut_label: None,
        slash_on_startup: false,
    },
    ActionSpec {
        id: "rename_session",
        name: "Rename session",
        aliases: &["/rename"],
        description: "Rename the current session: /rename <name>",
        contexts: CHAT,
        availability: ActionAvailability::Idle,
        handler: ActionHandler::RenameSession,
        default_bindings: &[],
        fallback_bindings: &[],
        shortcut_field: None,
        palette: None,
        shortcut_label: None,
        slash_on_startup: false,
    },
    ActionSpec {
        id: "fork_session",
        name: "Fork session",
        aliases: &["/fork"],
        description: "Fork from the full session or a previous prompt",
        contexts: CHAT,
        availability: ActionAvailability::Idle,
        handler: ActionHandler::ForkSession,
        default_bindings: &[],
        fallback_bindings: &[],
        shortcut_field: None,
        palette: palette("Session", false),
        shortcut_label: None,
        slash_on_startup: false,
    },
    ActionSpec {
        id: "undo_session",
        name: "Undo session",
        aliases: &["/undo"],
        description: "Undo the latest user prompt and restore it to the composer",
        contexts: CHAT,
        availability: ActionAvailability::Always,
        handler: ActionHandler::UndoSession,
        default_bindings: &[],
        fallback_bindings: &[],
        shortcut_field: None,
        palette: None,
        shortcut_label: None,
        slash_on_startup: false,
    },
    ActionSpec {
        id: "redo_session",
        name: "Redo session",
        aliases: &["/redo"],
        description: "Redo the most recently undone session history",
        contexts: CHAT,
        availability: ActionAvailability::Always,
        handler: ActionHandler::RedoSession,
        default_bindings: &[],
        fallback_bindings: &[],
        shortcut_field: None,
        palette: None,
        shortcut_label: None,
        slash_on_startup: false,
    },
    ActionSpec {
        id: "skills",
        name: "Skills",
        aliases: &["/skills"],
        description: "List and configure skills",
        contexts: BOTH,
        availability: ActionAvailability::Always,
        handler: ActionHandler::Skills,
        default_bindings: &[],
        fallback_bindings: &[],
        shortcut_field: None,
        palette: palette("Prompt", false),
        shortcut_label: None,
        slash_on_startup: true,
    },
    ActionSpec {
        id: "reload",
        name: "Reload context",
        aliases: &["/reload"],
        description: "Reload skills and instructions; optionally choose one target",
        contexts: CHAT,
        availability: ActionAvailability::Always,
        handler: ActionHandler::Reload,
        default_bindings: &[],
        fallback_bindings: &[],
        shortcut_field: None,
        palette: None,
        shortcut_label: None,
        slash_on_startup: false,
    },
    ActionSpec {
        id: "mcp_servers",
        name: "MCP servers",
        aliases: &["/mcp", "/mcps"],
        description: "Manage MCP servers",
        contexts: BOTH,
        availability: ActionAvailability::Always,
        handler: ActionHandler::McpServers,
        default_bindings: &[],
        fallback_bindings: &[],
        shortcut_field: None,
        palette: palette("MCP", false),
        shortcut_label: None,
        slash_on_startup: true,
    },
    ActionSpec {
        id: "tools",
        name: "Tools",
        aliases: &["/tools"],
        description: "View tool sources and manage external tools",
        contexts: CHAT,
        availability: ActionAvailability::Always,
        handler: ActionHandler::Tools,
        default_bindings: &[],
        fallback_bindings: &[],
        shortcut_field: None,
        palette: palette("Tools", false),
        shortcut_label: None,
        slash_on_startup: false,
    },
    ActionSpec {
        id: "extensions",
        name: "Extensions",
        aliases: &["/extensions"],
        description: "View and manage extensions",
        contexts: CHAT,
        availability: ActionAvailability::Always,
        handler: ActionHandler::Extensions,
        default_bindings: &[],
        fallback_bindings: &[],
        shortcut_field: None,
        palette: palette("Tools", false),
        shortcut_label: None,
        slash_on_startup: false,
    },
    ActionSpec {
        id: "hooks",
        name: "Hooks",
        aliases: &["/hooks"],
        description: "View and manage Hooks",
        contexts: CHAT,
        availability: ActionAvailability::Always,
        handler: ActionHandler::NativeHooks,
        default_bindings: &[],
        fallback_bindings: &[],
        shortcut_field: None,
        palette: palette("Tools", false),
        shortcut_label: None,
        slash_on_startup: false,
    },
    ActionSpec {
        id: "hooks_external",
        name: "Hooks (compatibility alias)",
        aliases: &["/hooks_external", "/hooks-external"],
        description: "Open the unified Hook management view",
        contexts: CHAT,
        availability: ActionAvailability::Always,
        handler: ActionHandler::ExternalHooks,
        default_bindings: &[],
        fallback_bindings: &[],
        shortcut_field: None,
        palette: None,
        shortcut_label: None,
        slash_on_startup: false,
    },
    ActionSpec {
        id: "acp_help",
        name: "ACP setup",
        aliases: &["/acp"],
        description: "Show ACP server setup",
        contexts: BOTH,
        availability: ActionAvailability::Always,
        handler: ActionHandler::AcpHelp,
        default_bindings: &[],
        fallback_bindings: &[],
        shortcut_field: None,
        palette: None,
        shortcut_label: None,
        slash_on_startup: true,
    },
    ActionSpec {
        id: "init",
        name: "Initialize repository",
        aliases: &["/init"],
        description: "Explore repo and generate AGENTS.md",
        contexts: BOTH,
        availability: ActionAvailability::Idle,
        handler: ActionHandler::Init,
        default_bindings: &[],
        fallback_bindings: &[],
        shortcut_field: None,
        palette: None,
        shortcut_label: None,
        slash_on_startup: true,
    },
    ActionSpec {
        id: "status",
        name: "View status",
        aliases: &["/status"],
        description: "Show current session and runtime status",
        contexts: CHAT,
        availability: ActionAvailability::Always,
        handler: ActionHandler::Status,
        default_bindings: &[],
        fallback_bindings: &[],
        shortcut_field: None,
        palette: palette("System", false),
        shortcut_label: None,
        slash_on_startup: false,
    },
    ActionSpec {
        id: "workspace_diff",
        name: "Workspace diff",
        aliases: &["/diff"],
        description: "Review current workspace changes",
        contexts: CHAT,
        availability: ActionAvailability::Idle,
        handler: ActionHandler::WorkspaceDiff,
        default_bindings: &[],
        fallback_bindings: &[],
        shortcut_field: None,
        palette: palette("Session", false),
        shortcut_label: None,
        slash_on_startup: false,
    },
    ActionSpec {
        id: "goal",
        name: "Set a goal",
        aliases: &["/goal"],
        description: "Send /goal <objective> to start goal mode",
        contexts: CHAT,
        availability: ActionAvailability::Always,
        handler: ActionHandler::GoalPrompt,
        default_bindings: &[],
        fallback_bindings: &[],
        shortcut_field: None,
        palette: palette("Session", false),
        shortcut_label: None,
        slash_on_startup: false,
    },
    ActionSpec {
        id: "compact_session",
        name: "Compact context",
        aliases: &["/compact", "/summarize"],
        description: "Compact the current session context",
        contexts: CHAT,
        availability: ActionAvailability::Idle,
        handler: ActionHandler::CompactSession,
        default_bindings: &[],
        fallback_bindings: &[],
        shortcut_field: None,
        palette: palette("Session", false),
        shortcut_label: None,
        slash_on_startup: false,
    },
    ActionSpec {
        id: "usage",
        name: "Usage report",
        aliases: &["/usage"],
        description: "Generate a usage report for the current session",
        contexts: BOTH,
        availability: ActionAvailability::Idle,
        handler: ActionHandler::Usage,
        default_bindings: &[],
        fallback_bindings: &[],
        shortcut_field: None,
        palette: palette("Session", true),
        shortcut_label: None,
        slash_on_startup: true,
    },
    ActionSpec {
        id: "editor",
        name: "Open editor",
        aliases: &["/editor"],
        description: "Compose the current prompt in an external editor",
        contexts: CHAT,
        availability: ActionAvailability::Idle,
        handler: ActionHandler::Editor,
        default_bindings: &[],
        fallback_bindings: &[],
        shortcut_field: None,
        palette: palette("Prompt", false),
        shortcut_label: None,
        slash_on_startup: false,
    },
    ActionSpec {
        id: "prompt_stash",
        name: "Stash prompt",
        aliases: &[],
        description: "Save the current prompt for later",
        contexts: CHAT,
        availability: ActionAvailability::Always,
        handler: ActionHandler::PromptStash,
        default_bindings: &[],
        fallback_bindings: &[],
        shortcut_field: None,
        palette: palette("Prompt", false),
        shortcut_label: None,
        slash_on_startup: false,
    },
    ActionSpec {
        id: "prompt_stash_pop",
        name: "Stash pop",
        aliases: &[],
        description: "Restore the most recently stashed prompt",
        contexts: CHAT,
        availability: ActionAvailability::Always,
        handler: ActionHandler::PromptStashPop,
        default_bindings: &[],
        fallback_bindings: &[],
        shortcut_field: None,
        palette: palette("Prompt", false),
        shortcut_label: None,
        slash_on_startup: false,
    },
    ActionSpec {
        id: "prompt_stash_list",
        name: "Stash list",
        aliases: &[],
        description: "Browse and restore stashed prompts",
        contexts: CHAT,
        availability: ActionAvailability::Always,
        handler: ActionHandler::PromptStashList,
        default_bindings: &[],
        fallback_bindings: &[],
        shortcut_field: None,
        palette: palette("Prompt", false),
        shortcut_label: None,
        slash_on_startup: false,
    },
    ActionSpec {
        id: "toggle_timestamps",
        name: "Timestamps",
        aliases: &["/timestamps", "/toggle-timestamps"],
        description: "Toggle message timestamps",
        contexts: CHAT,
        availability: ActionAvailability::Always,
        handler: ActionHandler::ToggleTimestamps,
        default_bindings: &[],
        fallback_bindings: &[],
        shortcut_field: None,
        palette: palette("Session", false),
        shortcut_label: None,
        slash_on_startup: false,
    },
    ActionSpec {
        id: "toggle_thinking",
        name: "Thinking blocks",
        aliases: &["/thinking", "/toggle-thinking"],
        description: "Toggle thinking block visibility",
        contexts: CHAT,
        availability: ActionAvailability::Always,
        handler: ActionHandler::ToggleThinking,
        default_bindings: &[],
        fallback_bindings: &[],
        shortcut_field: None,
        palette: palette("Session", false),
        shortcut_label: None,
        slash_on_startup: false,
    },
    ActionSpec {
        id: "toggle_tool_details",
        name: "Tool details",
        aliases: &[],
        description: "Toggle tool detail visibility",
        contexts: CHAT,
        availability: ActionAvailability::Always,
        handler: ActionHandler::ToggleToolDetails,
        default_bindings: &[],
        fallback_bindings: &[],
        shortcut_field: None,
        palette: palette("Session", false),
        shortcut_label: None,
        slash_on_startup: false,
    },
    ActionSpec {
        id: "copy_transcript",
        name: "Copy transcript",
        aliases: &["/copy"],
        description: "Copy the current session as Markdown",
        contexts: CHAT,
        availability: ActionAvailability::Idle,
        handler: ActionHandler::CopyTranscript,
        default_bindings: &[],
        fallback_bindings: &[],
        shortcut_field: None,
        palette: palette("Session", false),
        shortcut_label: None,
        slash_on_startup: false,
    },
    ActionSpec {
        id: "export_transcript",
        name: "Export transcript",
        aliases: &["/export"],
        description: "Export the current session as Markdown",
        contexts: CHAT,
        availability: ActionAvailability::Idle,
        handler: ActionHandler::ExportTranscript,
        default_bindings: &[],
        fallback_bindings: &[],
        shortcut_field: None,
        palette: palette("Session", false),
        shortcut_label: None,
        slash_on_startup: false,
    },
    ActionSpec {
        id: "toggle_auto_approve",
        name: "Auto mode",
        aliases: &["/auto"],
        description: "Toggle Auto mode for the current session",
        contexts: CHAT,
        availability: ActionAvailability::Idle,
        handler: ActionHandler::ToggleAutoApprove,
        default_bindings: &[],
        fallback_bindings: &[],
        shortcut_field: None,
        palette: palette("Session", false),
        shortcut_label: None,
        slash_on_startup: false,
    },
    ActionSpec {
        id: "toggle_worktree",
        name: "Worktree",
        aliases: &["/worktree"],
        description: "Toggle worktree isolation for the current session",
        contexts: CHAT,
        availability: ActionAvailability::Idle,
        handler: ActionHandler::ToggleWorktree,
        default_bindings: &[],
        fallback_bindings: &[],
        shortcut_field: None,
        palette: palette("Session", false),
        shortcut_label: None,
        slash_on_startup: false,
    },
    ActionSpec {
        id: "exit",
        name: "Exit the app",
        aliases: &["/exit"],
        description: "Quit the application",
        contexts: BOTH,
        availability: ActionAvailability::Always,
        handler: ActionHandler::Exit,
        default_bindings: &[],
        fallback_bindings: &["Ctrl+C"],
        shortcut_field: None,
        palette: palette("System", false),
        shortcut_label: Some("Quit"),
        slash_on_startup: true,
    },
    ActionSpec {
        id: "login",
        name: "Login",
        aliases: &["/login"],
        description: "Account login / status",
        contexts: BOTH,
        availability: ActionAvailability::Idle,
        handler: ActionHandler::Login,
        default_bindings: &[],
        fallback_bindings: &[],
        shortcut_field: None,
        palette: palette("Account", false),
        shortcut_label: None,
        slash_on_startup: true,
    },
    ActionSpec {
        id: "logout",
        name: "Logout",
        aliases: &["/logout"],
        description: "Log out of OpenBitFun account",
        contexts: BOTH,
        availability: ActionAvailability::Always,
        handler: ActionHandler::Logout,
        default_bindings: &[],
        fallback_bindings: &[],
        shortcut_field: None,
        palette: palette("Account", false),
        shortcut_label: None,
        slash_on_startup: true,
    },
    ActionSpec {
        id: "open_palette",
        name: "Command Palette",
        aliases: &[],
        description: "Open the command palette",
        contexts: BOTH,
        availability: ActionAvailability::Always,
        handler: ActionHandler::OpenPalette,
        default_bindings: &["Ctrl+P"],
        fallback_bindings: &[],
        shortcut_field: Some(ShortcutField::Menu),
        palette: None,
        shortcut_label: Some("Commands"),
        slash_on_startup: false,
    },
    ActionSpec {
        id: "submit_input",
        name: "Send message",
        aliases: &[],
        description: "Submit the current input",
        contexts: BOTH,
        availability: ActionAvailability::Always,
        handler: ActionHandler::SubmitInput,
        default_bindings: &["Enter"],
        fallback_bindings: &[],
        shortcut_field: Some(ShortcutField::SendMessage),
        palette: None,
        shortcut_label: Some("Send"),
        slash_on_startup: false,
    },
    ActionSpec {
        id: "interrupt",
        name: "Interrupt",
        aliases: &[],
        description: "Cancel the active turn",
        contexts: CHAT,
        availability: ActionAvailability::Processing,
        handler: ActionHandler::Interrupt,
        default_bindings: &[],
        fallback_bindings: &["Esc", "Ctrl+C"],
        shortcut_field: Some(ShortcutField::Interrupt),
        palette: None,
        shortcut_label: Some("Interrupt"),
        slash_on_startup: false,
    },
    ActionSpec {
        id: "close_popups",
        name: "Close all popups",
        aliases: &[],
        description: "Close all open TUI popups",
        contexts: BOTH,
        availability: ActionAvailability::Popup,
        handler: ActionHandler::ClosePopups,
        default_bindings: &[],
        fallback_bindings: &["Ctrl+W"],
        shortcut_field: None,
        palette: None,
        shortcut_label: Some("Close All Popups"),
        slash_on_startup: false,
    },
    ActionSpec {
        id: "navigate_back",
        name: "Back",
        aliases: &[],
        description: "Close the current TUI popup",
        contexts: BOTH,
        availability: ActionAvailability::Popup,
        handler: ActionHandler::NavigateBack,
        default_bindings: &[],
        fallback_bindings: &["Esc"],
        shortcut_field: None,
        palette: None,
        shortcut_label: Some("Back"),
        slash_on_startup: false,
    },
    ActionSpec {
        id: "insert_newline",
        name: "Insert newline",
        aliases: &[],
        description: "Insert a newline without submitting",
        contexts: BOTH,
        availability: ActionAvailability::Always,
        handler: ActionHandler::InsertNewline,
        default_bindings: &["Alt+Enter"],
        fallback_bindings: &[],
        shortcut_field: None,
        palette: None,
        shortcut_label: Some("Newline"),
        slash_on_startup: false,
    },
    ActionSpec {
        id: "paste",
        name: "Paste",
        aliases: &[],
        description: "Paste clipboard text or image",
        contexts: BOTH,
        availability: ActionAvailability::Always,
        handler: ActionHandler::Paste,
        default_bindings: &["Ctrl+V"],
        fallback_bindings: &[],
        shortcut_field: None,
        palette: None,
        shortcut_label: None,
        slash_on_startup: false,
    },
    ActionSpec {
        id: "toggle_focused_tool",
        name: "Expand or collapse tool",
        aliases: &[],
        description: "Expand or collapse the focused tool",
        contexts: CHAT,
        availability: ActionAvailability::Always,
        handler: ActionHandler::ToggleFocusedTool,
        default_bindings: &["Ctrl+O"],
        fallback_bindings: &[],
        shortcut_field: None,
        palette: None,
        shortcut_label: Some("Expand / Collapse Tool"),
        slash_on_startup: false,
    },
    ActionSpec {
        id: "previous_tool",
        name: "Previous tool",
        aliases: &[],
        description: "Focus the previous tool",
        contexts: CHAT,
        availability: ActionAvailability::Always,
        handler: ActionHandler::PreviousTool,
        default_bindings: &["Ctrl+J"],
        fallback_bindings: &[],
        shortcut_field: None,
        palette: None,
        shortcut_label: Some("Previous Tool"),
        slash_on_startup: false,
    },
    ActionSpec {
        id: "next_tool",
        name: "Next tool",
        aliases: &[],
        description: "Focus the next tool",
        contexts: CHAT,
        availability: ActionAvailability::Always,
        handler: ActionHandler::NextTool,
        default_bindings: &["Ctrl+K"],
        fallback_bindings: &[],
        shortcut_field: None,
        palette: None,
        shortcut_label: Some("Next Tool"),
        slash_on_startup: false,
    },
    ActionSpec {
        id: "history_previous",
        name: "Previous input",
        aliases: &[],
        description: "Select the previous input history entry",
        contexts: CHAT,
        availability: ActionAvailability::Always,
        handler: ActionHandler::HistoryPrevious,
        default_bindings: &["Up"],
        fallback_bindings: &[],
        shortcut_field: None,
        palette: None,
        shortcut_label: Some("Previous Input"),
        slash_on_startup: false,
    },
    ActionSpec {
        id: "history_next",
        name: "Next input",
        aliases: &[],
        description: "Select the next input history entry",
        contexts: CHAT,
        availability: ActionAvailability::Always,
        handler: ActionHandler::HistoryNext,
        default_bindings: &["Down"],
        fallback_bindings: &[],
        shortcut_field: None,
        palette: None,
        shortcut_label: Some("Next Input"),
        slash_on_startup: false,
    },
    ActionSpec {
        id: "jump_top",
        name: "Jump to top",
        aliases: &[],
        description: "Jump to the top of the conversation",
        contexts: CHAT,
        availability: ActionAvailability::Always,
        handler: ActionHandler::JumpTop,
        default_bindings: &["Ctrl+Home"],
        fallback_bindings: &[],
        shortcut_field: None,
        palette: None,
        shortcut_label: Some("Jump to Top"),
        slash_on_startup: false,
    },
    ActionSpec {
        id: "jump_bottom",
        name: "Jump to bottom",
        aliases: &[],
        description: "Jump to the bottom of the conversation",
        contexts: CHAT,
        availability: ActionAvailability::Always,
        handler: ActionHandler::JumpBottom,
        default_bindings: &["Ctrl+End"],
        fallback_bindings: &[],
        shortcut_field: None,
        palette: None,
        shortcut_label: Some("Jump to Bottom"),
        slash_on_startup: false,
    },
    ActionSpec {
        id: "clear_input",
        name: "Clear input",
        aliases: &[],
        description: "Clear the current input",
        contexts: CHAT,
        availability: ActionAvailability::Always,
        handler: ActionHandler::ClearInput,
        default_bindings: &["Ctrl+U"],
        fallback_bindings: &[],
        shortcut_field: None,
        palette: None,
        shortcut_label: Some("Clear Input"),
        slash_on_startup: false,
    },
    ActionSpec {
        id: "toggle_browse",
        name: "Toggle browse mode",
        aliases: &[],
        description: "Toggle conversation browse mode",
        contexts: CHAT,
        availability: ActionAvailability::Always,
        handler: ActionHandler::ToggleBrowse,
        default_bindings: &["Ctrl+E"],
        fallback_bindings: &[],
        shortcut_field: None,
        palette: None,
        shortcut_label: Some("Browse"),
        slash_on_startup: false,
    },
    ActionSpec {
        id: "scroll_up",
        name: "Scroll messages up",
        aliases: &[],
        description: "Scroll the conversation up",
        contexts: CHAT,
        availability: ActionAvailability::Always,
        handler: ActionHandler::ScrollUp,
        default_bindings: &["PageUp"],
        fallback_bindings: &[],
        shortcut_field: None,
        palette: None,
        shortcut_label: Some("Scroll Messages Up"),
        slash_on_startup: false,
    },
    ActionSpec {
        id: "scroll_down",
        name: "Scroll messages down",
        aliases: &[],
        description: "Scroll the conversation down",
        contexts: CHAT,
        availability: ActionAvailability::Always,
        handler: ActionHandler::ScrollDown,
        default_bindings: &["PageDown"],
        fallback_bindings: &[],
        shortcut_field: None,
        palette: None,
        shortcut_label: Some("Scroll Messages Down"),
        slash_on_startup: false,
    },
];

impl ActionSpec {
    fn supports_context(&self, context: ActionContext) -> bool {
        self.contexts.contains(&context)
    }

    pub(crate) fn available(&self, state: ActionState) -> bool {
        if !self.supports_context(state.context) {
            return false;
        }
        if state.shared_tui && !self.handler.available_in_shared_tui(state.context) {
            return false;
        }
        if state.lineage_inspection && !self.handler.available_in_lineage_inspection() {
            return false;
        }
        match self.availability {
            ActionAvailability::Always => true,
            ActionAvailability::Idle => !state.is_processing,
            ActionAvailability::Processing => state.is_processing,
            ActionAvailability::Popup => state.popup_open,
        }
    }

    fn description(&self, state: ActionState) -> &'static str {
        match (self.handler, state.context) {
            (ActionHandler::OpenAgentSelector, _) if state.shared_tui => "Choose an Agent mode",
            (ActionHandler::SelectModel, ActionContext::Chat) => {
                "Select model for the current session"
            }
            (ActionHandler::SelectModel, ActionContext::Startup) => {
                "Select default model for future sessions"
            }
            _ => self.description,
        }
    }

    pub(crate) fn unavailable_message(&self, state: ActionState) -> String {
        if state.shared_tui && !self.handler.available_in_shared_tui(state.context) {
            return format!(
                "{} is unavailable in Shared TUI preview. {}",
                self.name, SHARED_TUI_EMBEDDED_HANDOFF
            );
        }
        if state.lineage_inspection && !self.handler.available_in_lineage_inspection() {
            return format!("{} is unavailable while inspecting a subagent.", self.name);
        }
        match self.availability {
            ActionAvailability::Idle if state.is_processing => format!(
                "{} is unavailable while a turn is processing. Use the interrupt shortcut first.",
                self.name
            ),
            ActionAvailability::Processing => {
                format!(
                    "{} is available only while a turn is processing.",
                    self.name
                )
            }
            ActionAvailability::Popup => {
                format!("{} is available only while a popup is open.", self.name)
            }
            _ => format!("{} is unavailable here.", self.name),
        }
    }
}

#[cfg(test)]
pub(crate) fn action_specs() -> &'static [ActionSpec] {
    ACTION_SPECS
}

pub(crate) fn action_by_id(id: &str, context: ActionContext) -> Option<&'static ActionSpec> {
    ACTION_SPECS
        .iter()
        .find(|spec| spec.id == id && spec.supports_context(context))
}

pub(crate) fn action_for_alias(alias: &str, context: ActionContext) -> Option<&'static ActionSpec> {
    ACTION_SPECS.iter().find(|spec| {
        spec.supports_context(context)
            && spec
                .aliases
                .iter()
                .any(|candidate| candidate.eq_ignore_ascii_case(alias))
    })
}

/// Stable behavior version used when a built-in slash action participates in a
/// persisted external-command conflict. Update an override only when that
/// action's user-visible behavior changes in a way that requires reconfirmation.
pub(crate) fn action_conflict_behavior_version(action_id: &str) -> &'static str {
    match action_id {
        "switch_agent" => "agents-management-v1",
        _ => env!("CARGO_PKG_VERSION"),
    }
}

pub(crate) fn removed_management_command_hint(
    alias: &str,
    context: ActionContext,
) -> Option<&'static str> {
    match (alias.to_ascii_lowercase().as_str(), context) {
        ("/subagents", _) => Some(
            "/subagents was removed. Open Agents from the command palette and choose Subagents.",
        ),
        ("/external-tools", ActionContext::Chat) => Some(
            "/external-tools was removed. Open Tools from the command palette; external sources are shown in that view.",
        ),
        ("/external-agents", ActionContext::Chat) => Some(
            "/external-agents was removed. Open Agents from the command palette and choose External AI applications.",
        ),
        ("/external-tools", ActionContext::Startup) => Some(
            "/external-tools was removed. Start a session, then open Tools from the command palette.",
        ),
        ("/external-agents", ActionContext::Startup) => Some(
            "/external-agents was removed. Start a session, then open Agents from the command palette and choose External AI applications.",
        ),
        _ => None,
    }
}

pub(crate) fn slash_actions(state: ActionState) -> Vec<ActionProjection> {
    ACTION_SPECS
        .iter()
        .filter(|spec| {
            spec.available(state)
                && !spec.aliases.is_empty()
                && spec.id != "hooks_external"
                && (state.context != ActionContext::Startup || spec.slash_on_startup)
        })
        .flat_map(|spec| {
            spec.aliases.iter().map(|alias| ActionProjection {
                id: spec.id,
                name: alias,
                description: spec.description(state),
                palette_group: None,
                suggested: false,
            })
        })
        .collect()
}

pub(crate) fn palette_actions(state: ActionState) -> Vec<ActionProjection> {
    ACTION_SPECS
        .iter()
        .filter_map(|spec| {
            let palette = spec.palette?;
            spec.available(state).then_some(ActionProjection {
                id: spec.id,
                name: spec.name,
                description: spec.description(state),
                palette_group: Some(palette.group),
                suggested: palette.suggested,
            })
        })
        .collect()
}

#[derive(Debug, Clone, PartialEq, Eq)]
struct KeyChord {
    code: KeyCode,
    modifiers: KeyModifiers,
    display: String,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum ModifierMatch {
    Exact,
    Any,
    ContainsExpected,
    WithoutAlt,
}

impl KeyChord {
    fn parse(value: &str) -> Result<Self, String> {
        let value = value.trim();
        if value.is_empty() {
            return Err("binding is empty".to_string());
        }

        let parts: Vec<&str> = value.split('+').map(str::trim).collect();
        let Some(key_name) = parts.last().copied() else {
            return Err("binding is empty".to_string());
        };
        if key_name.is_empty() {
            return Err("binding has no key".to_string());
        }

        let mut modifiers = KeyModifiers::NONE;
        for modifier in &parts[..parts.len().saturating_sub(1)] {
            match modifier.to_ascii_lowercase().as_str() {
                "ctrl" | "control" => modifiers.insert(KeyModifiers::CONTROL),
                "alt" | "option" => modifiers.insert(KeyModifiers::ALT),
                "shift" => modifiers.insert(KeyModifiers::SHIFT),
                "super" | "cmd" | "command" => modifiers.insert(KeyModifiers::SUPER),
                other => return Err(format!("unsupported modifier `{other}`")),
            }
        }

        let normalized = key_name.to_ascii_lowercase();
        let code = match normalized.as_str() {
            "enter" | "return" | "↵" => KeyCode::Enter,
            "esc" | "escape" => KeyCode::Esc,
            "tab" if modifiers.contains(KeyModifiers::SHIFT) => KeyCode::BackTab,
            "tab" => KeyCode::Tab,
            "backtab" => {
                modifiers.insert(KeyModifiers::SHIFT);
                KeyCode::BackTab
            }
            "up" | "↑" => KeyCode::Up,
            "down" | "↓" => KeyCode::Down,
            "left" | "←" => KeyCode::Left,
            "right" | "→" => KeyCode::Right,
            "pageup" | "pgup" => KeyCode::PageUp,
            "pagedown" | "pgdown" | "pgdn" => KeyCode::PageDown,
            "home" => KeyCode::Home,
            "end" => KeyCode::End,
            "backspace" => KeyCode::Backspace,
            "delete" | "del" => KeyCode::Delete,
            "space" => KeyCode::Char(' '),
            _ if normalized.chars().count() == 1 => {
                KeyCode::Char(normalized.chars().next().unwrap())
            }
            _ if normalized.starts_with('f') => {
                let number = normalized[1..]
                    .parse::<u8>()
                    .map_err(|_| format!("unsupported key `{key_name}`"))?;
                if !(1..=12).contains(&number) {
                    return Err(format!("unsupported key `{key_name}`"));
                }
                KeyCode::F(number)
            }
            _ => return Err(format!("unsupported key `{key_name}`")),
        };

        let display = Self::display_for(&code, modifiers);
        Ok(Self {
            code,
            modifiers,
            display,
        })
    }

    fn matches(&self, key: KeyEvent, modifier_match: ModifierMatch) -> bool {
        let relevant = KeyModifiers::CONTROL
            | KeyModifiers::ALT
            | KeyModifiers::SHIFT
            | KeyModifiers::SUPER
            | KeyModifiers::HYPER
            | KeyModifiers::META;
        let modifiers = key.modifiers & relevant;
        let code_matches = match (&self.code, key.code) {
            (KeyCode::Char(expected), KeyCode::Char(actual)) => {
                expected.eq_ignore_ascii_case(&actual)
            }
            (expected, actual) => *expected == actual,
        };
        let modifiers_match = match modifier_match {
            ModifierMatch::Exact => self.modifiers == modifiers,
            ModifierMatch::Any => true,
            ModifierMatch::ContainsExpected => modifiers.contains(self.modifiers),
            ModifierMatch::WithoutAlt => !modifiers.contains(KeyModifiers::ALT),
        };
        code_matches && modifiers_match
    }

    fn display_for(code: &KeyCode, modifiers: KeyModifiers) -> String {
        let mut parts = Vec::new();
        if modifiers.contains(KeyModifiers::CONTROL) {
            parts.push("Ctrl".to_string());
        }
        if modifiers.contains(KeyModifiers::ALT) {
            parts.push("Alt".to_string());
        }
        if modifiers.contains(KeyModifiers::SHIFT) && !matches!(code, KeyCode::BackTab) {
            parts.push("Shift".to_string());
        }
        if modifiers.contains(KeyModifiers::SUPER) {
            parts.push("Super".to_string());
        }
        let key = match code {
            KeyCode::Enter => "Enter".to_string(),
            KeyCode::Esc => "Esc".to_string(),
            KeyCode::Tab => "Tab".to_string(),
            KeyCode::BackTab => "Shift+Tab".to_string(),
            KeyCode::Up => "↑".to_string(),
            KeyCode::Down => "↓".to_string(),
            KeyCode::Left => "←".to_string(),
            KeyCode::Right => "→".to_string(),
            KeyCode::PageUp => "PageUp".to_string(),
            KeyCode::PageDown => "PageDown".to_string(),
            KeyCode::Home => "Home".to_string(),
            KeyCode::End => "End".to_string(),
            KeyCode::Backspace => "Backspace".to_string(),
            KeyCode::Delete => "Delete".to_string(),
            KeyCode::Char(' ') => "Space".to_string(),
            KeyCode::Char(character) => character.to_ascii_uppercase().to_string(),
            KeyCode::F(number) => format!("F{number}"),
            other => format!("{other:?}"),
        };
        parts.push(key);
        parts.join("+")
    }
}

#[derive(Debug, Clone)]
struct BindingPolicy {
    availability: ActionAvailability,
    modifier_match: ModifierMatch,
    reserved: bool,
    above_modals: bool,
}

#[derive(Debug, Clone)]
struct ResolvedBinding {
    spec: &'static ActionSpec,
    chord: KeyChord,
    source: String,
    policy: BindingPolicy,
}

impl ResolvedBinding {
    fn available(&self, state: ActionState, above_modals: bool) -> bool {
        if !self.spec.supports_context(state.context) {
            return false;
        }
        if state.shared_tui && !self.spec.handler.available_in_shared_tui(state.context) {
            return false;
        }
        if state.popup_open
            && !above_modals
            && self.policy.availability != ActionAvailability::Popup
        {
            return false;
        }
        match self.policy.availability {
            ActionAvailability::Always => true,
            ActionAvailability::Idle => !state.is_processing,
            ActionAvailability::Processing => state.is_processing,
            ActionAvailability::Popup => state.popup_open,
        }
    }
}

#[derive(Debug, Clone)]
struct KeymapDiagnostic {
    message: String,
    contexts: Vec<ActionContext>,
}

#[derive(Debug, Clone, Default)]
pub(crate) struct ResolvedKeymap {
    bindings: Vec<ResolvedBinding>,
    diagnostics: Vec<KeymapDiagnostic>,
}

impl ResolvedKeymap {
    pub(crate) fn new(shortcuts: &ShortcutsConfig) -> Self {
        let mut keymap = Self::default();

        for spec in ACTION_SPECS {
            for binding in spec.fallback_bindings {
                let availability = match spec.handler {
                    ActionHandler::Exit => ActionAvailability::Idle,
                    _ => spec.availability,
                };
                keymap.push_binding(
                    spec,
                    binding,
                    "OpenBitFun safety".to_string(),
                    BindingPolicy {
                        availability,
                        modifier_match: built_in_modifier_match(spec, binding),
                        reserved: true,
                        above_modals: binding.eq_ignore_ascii_case("Ctrl+C"),
                    },
                );
            }
        }

        let mut valid_overrides = Vec::new();
        for field in [
            ShortcutField::SendMessage,
            ShortcutField::Interrupt,
            ShortcutField::Menu,
        ] {
            let Some(value) = field.value(shortcuts) else {
                continue;
            };
            let Some(spec) = ACTION_SPECS
                .iter()
                .find(|spec| spec.shortcut_field == Some(field))
            else {
                continue;
            };
            match KeyChord::parse(value) {
                Ok(chord) => {
                    valid_overrides.push(field);
                    keymap.push_resolved_binding(ResolvedBinding {
                        spec,
                        chord,
                        source: field.source().to_string(),
                        policy: BindingPolicy {
                            availability: spec.availability,
                            modifier_match: ModifierMatch::Exact,
                            reserved: false,
                            above_modals: false,
                        },
                    });
                }
                Err(error) => keymap.push_diagnostic(
                    format!(
                        "Invalid {} ({}); using OpenBitFun default",
                        field.source(),
                        binding_error_summary(&error)
                    ),
                    spec.contexts.to_vec(),
                ),
            }
        }

        for spec in ACTION_SPECS {
            let overridden = spec
                .shortcut_field
                .is_some_and(|field| valid_overrides.contains(&field));
            if overridden {
                continue;
            }
            for binding in spec.default_bindings {
                keymap.push_binding(
                    spec,
                    binding,
                    "OpenBitFun default".to_string(),
                    BindingPolicy {
                        availability: spec.availability,
                        modifier_match: built_in_modifier_match(spec, binding),
                        reserved: false,
                        above_modals: false,
                    },
                );
            }
        }

        keymap
    }

    /// Resolve a key to its registry entry without executing product behavior.
    pub(crate) fn resolve(&self, key: KeyEvent, state: ActionState) -> Option<&'static ActionSpec> {
        self.resolve_binding_index(key, state)
            .map(|index| self.bindings[index].spec)
    }

    fn resolve_binding_index(&self, key: KeyEvent, state: ActionState) -> Option<usize> {
        if state.popup_open {
            if let Some((index, _)) = self.bindings.iter().enumerate().find(|(_, binding)| {
                binding.policy.availability == ActionAvailability::Popup
                    && binding.available(state, false)
                    && binding_matches(binding, key)
            }) {
                return Some(index);
            }
        }
        self.bindings
            .iter()
            .enumerate()
            .find(|(_, binding)| binding.available(state, false) && binding_matches(binding, key))
            .map(|(index, _)| index)
    }

    /// Resolve reserved keys while a normal popup owns the input focus.
    pub(crate) fn resolve_reserved(
        &self,
        key: KeyEvent,
        state: ActionState,
    ) -> Option<&'static ActionSpec> {
        if state.popup_open {
            if let Some(binding) = self.bindings.iter().find(|binding| {
                binding.policy.reserved
                    && binding.policy.availability == ActionAvailability::Popup
                    && binding.available(state, true)
                    && binding.chord.matches(key, binding.policy.modifier_match)
            }) {
                return Some(binding.spec);
            }
        }
        self.bindings
            .iter()
            .find(|binding| {
                binding.policy.reserved
                    && binding.available(state, true)
                    && binding.chord.matches(key, binding.policy.modifier_match)
            })
            .map(|binding| binding.spec)
    }

    /// Resolve only Ctrl+C, which must remain available above permission,
    /// question, and popup handlers.
    pub(crate) fn resolve_modal_safe(
        &self,
        key: KeyEvent,
        state: ActionState,
    ) -> Option<&'static ActionSpec> {
        self.bindings
            .iter()
            .find(|binding| {
                binding.policy.above_modals
                    && binding.available(state, true)
                    && binding.chord.matches(key, binding.policy.modifier_match)
            })
            .map(|binding| binding.spec)
    }

    #[cfg(test)]
    pub(crate) fn diagnostics(&self) -> Vec<&str> {
        self.diagnostics
            .iter()
            .map(|diagnostic| diagnostic.message.as_str())
            .collect()
    }

    pub(crate) fn help_text(&self, state: ActionState) -> String {
        let groups: &[(&[&str], &str)] = match state.context {
            ActionContext::Startup => &[
                (&["submit_input", "insert_newline"], "Send / Newline"),
                (&["cycle_agent", "switch_agent_reverse"], "Switch Agent"),
                (&["open_palette"], "Command Palette"),
                (&["exit"], "Quit"),
            ],
            ActionContext::Chat => &[
                (&["submit_input", "insert_newline"], "Send / Newline"),
                (&["cycle_agent", "switch_agent_reverse"], "Switch Agent"),
                (&["open_palette"], "Command Palette"),
                (&["previous_tool", "next_tool"], "Prev / Next Tool"),
                (&["toggle_focused_tool"], "Expand / Collapse Tool"),
                (&["toggle_browse"], "Toggle Browse Mode"),
                (&["history_previous", "history_next"], "Input History"),
                (&["scroll_up", "scroll_down"], "Scroll Messages"),
                (&["jump_top", "jump_bottom"], "Jump to Top / Bottom"),
                (&["clear_input"], "Clear Input"),
                (&["interrupt"], "Interrupt"),
                (&["exit"], "Quit"),
            ],
        };

        let mut rows = Vec::new();
        for (action_ids, label) in groups {
            let mut active = Vec::new();
            for action_id in *action_ids {
                let keys = self.keys_for_state(&[action_id], state);
                if keys.is_empty() {
                    continue;
                }
                let action_label = ACTION_SPECS
                    .iter()
                    .find(|spec| spec.id == *action_id)
                    .and_then(|spec| spec.shortcut_label)
                    .unwrap_or(label);
                active.push((keys, action_label));
            }
            if active.len() == 1 {
                let (keys, action_label) = active.pop().unwrap();
                let row_label = if action_ids.len() == 1 {
                    *label
                } else {
                    action_label
                };
                rows.push((keys.join(" / "), row_label.to_string()));
            } else if !active.is_empty() {
                let keys = active
                    .into_iter()
                    .flat_map(|(keys, _)| keys)
                    .collect::<Vec<_>>();
                rows.push((keys.join(" / "), (*label).to_string()));
            }
        }

        let popup_state = ActionState {
            popup_open: true,
            ..state
        };
        let recovery_keys = self.keys_for_state(&["close_popups", "navigate_back"], popup_state);
        if !recovery_keys.is_empty() {
            rows.push((
                recovery_keys.join(" / "),
                "Close All Popups / Back".to_string(),
            ));
        }

        let width = rows.iter().map(|(keys, _)| keys.len()).max().unwrap_or(0);
        let mut output = String::from("Keyboard Shortcuts\n─────────────────────────────────\n");
        for (keys, label) in rows {
            output.push_str(&format!("{keys:<width$}   {label}\n"));
        }
        let notices = self.diagnostics_for(state.context);
        if !notices.is_empty() {
            output.push_str("\nShortcut notices\n");
            let mut available_lines = 19usize.saturating_sub(output.lines().count());
            let mut shown = 0usize;
            for diagnostic in &notices {
                let lines = wrap_help_notice(diagnostic, 72);
                let summary_line = usize::from(shown + 1 < notices.len());
                if lines.len() + summary_line > available_lines {
                    break;
                }
                for (index, line) in lines.iter().enumerate() {
                    output.push_str(if index == 0 { "- " } else { "  " });
                    output.push_str(line);
                    output.push('\n');
                }
                available_lines -= lines.len();
                shown += 1;
            }
            if notices.len() > shown && available_lines > 0 {
                output.push_str(&format!(
                    "- {} more shortcut notices\n",
                    notices.len() - shown
                ));
            }
        }
        output.trim_end().to_string()
    }

    pub(crate) fn compact_hints(&self, state: ActionState) -> Vec<(String, &'static str)> {
        let mut hints = Vec::new();
        for id in ["cycle_agent", "insert_newline", "open_palette"] {
            self.push_compact_hint(&mut hints, id, state);
        }

        let mut history_keys = self.keys_for_state(&["history_previous"], state);
        history_keys.extend(self.keys_for_state(&["history_next"], state));
        history_keys.dedup();
        if !history_keys.is_empty() {
            hints.push((history_keys.join(""), "History"));
        }

        self.push_compact_hint(&mut hints, "toggle_browse", state);
        self.push_compact_hint(
            &mut hints,
            if state.is_processing {
                "interrupt"
            } else {
                "exit"
            },
            state,
        );
        hints
    }

    fn push_compact_hint(
        &self,
        hints: &mut Vec<(String, &'static str)>,
        id: &str,
        state: ActionState,
    ) {
        let Some(spec) = ACTION_SPECS.iter().find(|spec| spec.id == id) else {
            return;
        };
        let Some(label) = spec.shortcut_label else {
            return;
        };
        let mut keys = self.keys_for_state(&[id], state);
        if id == "interrupt" {
            keys.truncate(1);
        }
        for key in &mut keys {
            if key == "Alt+Enter" {
                *key = "Alt+↵".to_string();
            }
        }
        if !keys.is_empty() {
            hints.push((keys.join("/"), label));
        }
    }

    #[cfg(test)]
    fn keys_for(&self, action_id: &str, context: ActionContext) -> Vec<String> {
        let mut keys = Vec::new();
        for (index, binding) in self.bindings.iter().enumerate() {
            if binding.spec.id == action_id
                && binding.spec.supports_context(context)
                && self.binding_is_effective(index, context)
                && !keys.contains(&binding.chord.display)
            {
                keys.push(binding.chord.display.clone());
            }
        }
        keys
    }

    #[cfg(test)]
    fn binding_is_effective(&self, index: usize, context: ActionContext) -> bool {
        let binding = &self.bindings[index];
        let states = match context {
            ActionContext::Startup => STARTUP_ACTION_STATES,
            ActionContext::Chat => CHAT_ACTION_STATES,
        };

        states.iter().copied().any(|state| {
            binding.available(state, false) && self.canonical_binding_is_effective_at(index, state)
        })
    }

    fn canonical_binding_is_effective_at(&self, index: usize, state: ActionState) -> bool {
        let binding = &self.bindings[index];
        let key = KeyEvent::new(binding.chord.code, binding.chord.modifiers);
        binding_matches(binding, key) && self.resolve_binding_index(key, state) == Some(index)
    }

    fn keys_for_state(&self, action_ids: &[&str], state: ActionState) -> Vec<String> {
        let mut keys = Vec::new();
        for (index, binding) in self.bindings.iter().enumerate() {
            if action_ids.contains(&binding.spec.id)
                && binding.available(state, false)
                && self.canonical_binding_is_effective_at(index, state)
                && !keys.contains(&binding.chord.display)
            {
                keys.push(binding.chord.display.clone());
            }
        }
        keys
    }

    fn diagnostics_for(&self, context: ActionContext) -> Vec<&str> {
        self.diagnostics
            .iter()
            .filter(|diagnostic| diagnostic.contexts.contains(&context))
            .map(|diagnostic| diagnostic.message.as_str())
            .collect()
    }

    fn push_binding(
        &mut self,
        spec: &'static ActionSpec,
        binding: &str,
        source: String,
        policy: BindingPolicy,
    ) {
        match KeyChord::parse(binding) {
            Ok(chord) => self.push_resolved_binding(ResolvedBinding {
                spec,
                chord,
                source,
                policy,
            }),
            Err(error) => self.push_diagnostic(
                format!(
                    "Invalid built-in binding `{binding}` for {}: {error}",
                    spec.id
                ),
                spec.contexts.to_vec(),
            ),
        }
    }

    fn push_resolved_binding(&mut self, binding: ResolvedBinding) {
        if self.bindings.iter().any(|existing| {
            existing.spec.handler == binding.spec.handler && existing.chord == binding.chord
        }) {
            return;
        }

        let conflicts = self
            .bindings
            .iter()
            .filter(|existing| {
                existing.spec.handler != binding.spec.handler
                    && bindings_share_input(existing, &binding)
                    && availability_overlaps(existing, &binding)
            })
            .map(|winner| {
                let contexts = overlapping_contexts(winner, &binding);
                let message = format!(
                    "{}: {} ({})\nignored: {} ({})",
                    conflict_display(winner, &binding),
                    notice_label(winner.spec),
                    winner.source,
                    notice_label(binding.spec),
                    binding.source
                );
                KeymapDiagnostic { message, contexts }
            })
            .collect::<Vec<_>>();
        self.diagnostics.extend(conflicts);

        self.bindings.push(binding);
    }

    fn push_diagnostic(&mut self, message: String, contexts: Vec<ActionContext>) {
        self.diagnostics
            .push(KeymapDiagnostic { message, contexts });
    }
}

fn built_in_modifier_match(spec: &ActionSpec, binding: &str) -> ModifierMatch {
    match (spec.id, binding) {
        ("submit_input", "Enter") => ModifierMatch::WithoutAlt,
        ("insert_newline", "Alt+Enter") => ModifierMatch::ContainsExpected,
        ("cycle_agent", "Tab")
        | ("switch_agent_reverse", "Shift+Tab")
        | ("scroll_up", "PageUp")
        | ("scroll_down", "PageDown")
        | ("interrupt", "Esc")
        | ("navigate_back", "Esc") => ModifierMatch::Any,
        _ => ModifierMatch::Exact,
    }
}

fn binding_matches(binding: &ResolvedBinding, key: KeyEvent) -> bool {
    binding.chord.matches(key, binding.policy.modifier_match)
}

fn relevant_modifier_variants() -> impl Iterator<Item = KeyModifiers> {
    const MODIFIERS: [KeyModifiers; 6] = [
        KeyModifiers::CONTROL,
        KeyModifiers::ALT,
        KeyModifiers::SHIFT,
        KeyModifiers::SUPER,
        KeyModifiers::HYPER,
        KeyModifiers::META,
    ];

    (0u8..64).map(|mask| {
        MODIFIERS
            .iter()
            .enumerate()
            .fold(KeyModifiers::NONE, |mut value, (index, modifier)| {
                if mask & (1 << index) != 0 {
                    value.insert(*modifier);
                }
                value
            })
    })
}

fn bindings_share_input(left: &ResolvedBinding, right: &ResolvedBinding) -> bool {
    relevant_modifier_variants().any(|modifiers| {
        let key = KeyEvent::new(left.chord.code, modifiers);
        binding_matches(left, key) && binding_matches(right, key)
    })
}

fn conflict_display<'a>(left: &'a ResolvedBinding, right: &'a ResolvedBinding) -> &'a str {
    match (
        left.policy.modifier_match == ModifierMatch::Exact,
        right.policy.modifier_match == ModifierMatch::Exact,
    ) {
        (true, false) => &left.chord.display,
        (false, true) => &right.chord.display,
        _ => &right.chord.display,
    }
}

fn notice_label(spec: &ActionSpec) -> &str {
    spec.shortcut_label.unwrap_or(spec.name)
}

fn availability_overlaps(left: &ResolvedBinding, right: &ResolvedBinding) -> bool {
    STARTUP_ACTION_STATES
        .iter()
        .chain(CHAT_ACTION_STATES)
        .copied()
        .any(|state| left.available(state, false) && right.available(state, false))
}

fn overlapping_contexts(left: &ResolvedBinding, right: &ResolvedBinding) -> Vec<ActionContext> {
    [ActionContext::Startup, ActionContext::Chat]
        .into_iter()
        .filter(|context| {
            let states = match context {
                ActionContext::Startup => STARTUP_ACTION_STATES,
                ActionContext::Chat => CHAT_ACTION_STATES,
            };
            states
                .iter()
                .copied()
                .any(|state| left.available(state, false) && right.available(state, false))
        })
        .collect()
}

fn wrap_help_notice(value: &str, max_chars: usize) -> Vec<String> {
    let max_chars = max_chars.max(1);

    value
        .lines()
        .flat_map(|line| wrap_help_notice_line(line, max_chars))
        .collect()
}

fn wrap_help_notice_line(line: &str, max_chars: usize) -> Vec<String> {
    if line.is_empty() {
        return vec![String::new()];
    }

    let mut wrapped = Vec::new();
    let mut current = String::new();

    for word in line.split_whitespace() {
        if !current.is_empty() && current.chars().count() + 1 + word.chars().count() <= max_chars {
            current.push(' ');
            current.push_str(word);
            continue;
        }

        if !current.is_empty() {
            wrapped.push(std::mem::take(&mut current));
        }

        let mut remaining = word;
        while remaining.chars().count() > max_chars {
            let chunk = remaining.chars().take(max_chars).collect::<String>();
            wrapped.push(chunk);
            remaining = &remaining[remaining
                .char_indices()
                .nth(max_chars)
                .map(|(index, _)| index)
                .expect("remaining is longer than max_chars")..];
        }
        current.push_str(remaining);
    }

    if !current.is_empty() {
        wrapped.push(current);
    }

    wrapped
}

fn binding_error_summary(error: &str) -> &str {
    if error.starts_with("unsupported modifier") {
        "unsupported modifier"
    } else if error.starts_with("unsupported key") {
        "unsupported key"
    } else {
        error
    }
}

#[cfg(test)]
mod tests {
    use std::collections::HashSet;

    use crossterm::event::{KeyCode, KeyEvent, KeyModifiers};

    use super::*;

    #[test]
    fn shared_tui_exposes_local_compatibility_management() {
        assert!(ActionHandler::Sessions.available_in_shared_tui(ActionContext::Chat));
        assert!(ActionHandler::Interrupt.available_in_shared_tui(ActionContext::Chat));
        for action in [
            ActionHandler::OpenAgentSelector,
            ActionHandler::SwitchAgent,
            ActionHandler::SwitchAgentReverse,
            ActionHandler::SelectModel,
            ActionHandler::AddModel,
            ActionHandler::Skills,
            ActionHandler::McpServers,
            ActionHandler::RenameSession,
        ] {
            assert!(
                action.available_in_shared_tui(ActionContext::Chat),
                "{action:?}"
            );
        }
        for action in [
            ActionHandler::Tools,
            ActionHandler::Extensions,
            ActionHandler::NativeHooks,
            ActionHandler::ExternalHooks,
            ActionHandler::Login,
            ActionHandler::Usage,
        ] {
            assert!(
                !action.available_in_shared_tui(ActionContext::Chat),
                "{action:?}"
            );
        }
        assert!(ActionHandler::SelectModel.available_in_shared_tui(ActionContext::Startup));
        assert!(ActionHandler::AddModel.available_in_shared_tui(ActionContext::Startup));
        assert!(ActionHandler::Skills.available_in_shared_tui(ActionContext::Startup));
        assert!(ActionHandler::McpServers.available_in_shared_tui(ActionContext::Startup));
        assert!(SHARED_TUI_HELP_NOTE.contains("openbitfun chat --shared"));
        assert!(SHARED_TUI_HELP_NOTE.contains("one Session"));
        assert!(SHARED_TUI_HELP_NOTE.contains("`/models`"));
        assert!(SHARED_TUI_HELP_NOTE.contains("`/connect`"));
        assert!(SHARED_TUI_HELP_NOTE.contains("`/skills`"));
        assert!(SHARED_TUI_HELP_NOTE.contains("`/mcp`"));
        assert!(SHARED_TUI_HELP_NOTE.contains("`View subagents`"));
        assert!(SHARED_TUI_HELP_NOTE.contains("`/fork`"));
        assert!(SHARED_TUI_HELP_NOTE.contains("`/rename <name>`"));
        assert!(SHARED_TUI_HELP_NOTE.contains("`/reload [skills|instructions]`"));
        assert!(SHARED_TUI_HELP_NOTE.contains("Ctrl+D"));
        assert!(SHARED_TUI_HELP_NOTE.contains("idle, non-current Session"));
        assert!(SHARED_TUI_HELP_NOTE.contains("local compatibility owner"));
        assert!(SHARED_TUI_HELP_NOTE
            .contains("do not reconfigure an already-running Shared Runtime Host"));
        assert!(SHARED_TUI_HELP_NOTE.contains("remain Embedded"));
    }

    #[test]
    fn shared_startup_session_list_keeps_the_supported_delete_action() {
        let source = include_str!("ui/startup.rs").replace("\r\n", "\n");
        let selector = source
            .split_once("fn show_session_selector(&mut self)")
            .expect("startup session selector")
            .1
            .split_once("fn show_model_selector(&mut self)")
            .expect("startup session selector boundary")
            .0;

        assert!(selector.contains(".show(session_items, None, true)"));
        assert!(!selector.contains("Session deletion is unavailable in Shared TUI"));
    }

    #[test]
    fn rename_is_an_idle_current_session_chat_action() {
        let action = action_by_id("rename_session", ActionContext::Chat)
            .expect("current session rename action");

        assert_eq!(action.aliases, &["/rename"]);
        assert_eq!(action.handler, ActionHandler::RenameSession);
        assert_eq!(action.availability, ActionAvailability::Idle);
        assert!(action.description.contains("/rename <name>"));
        assert!(action.available(ActionState::chat(false, false)));
        assert!(action.available(ActionState::chat(false, false).for_shared_tui()));
        assert!(!action.available(ActionState::chat(true, false)));
        assert!(action_by_id("rename_session", ActionContext::Startup).is_none());
    }

    #[test]
    fn fork_uses_only_the_opencode_command_and_is_idle_in_both_deployments() {
        let action = action_by_id("fork_session", ActionContext::Chat)
            .expect("OpenCode-compatible session fork action");

        assert_eq!(action.aliases, &["/fork"]);
        assert_eq!(action.handler, ActionHandler::ForkSession);
        assert_eq!(action.availability, ActionAvailability::Idle);
        assert!(action.default_bindings.is_empty());
        assert!(action.available(ActionState::chat(false, false)));
        assert!(action.available(ActionState::chat(false, false).for_shared_tui()));
        assert!(!action.available(ActionState::chat(true, false)));
        assert!(action_by_id("fork_session", ActionContext::Startup).is_none());
        assert!(action_for_alias("/branch", ActionContext::Chat).is_none());
    }

    #[test]
    fn diff_uses_only_the_opencode_command_in_both_deployments() {
        let action = action_by_id("workspace_diff", ActionContext::Chat)
            .expect("OpenCode-compatible workspace diff action");

        assert_eq!(action.aliases, &["/diff"]);
        assert_eq!(action.handler, ActionHandler::WorkspaceDiff);
        assert_eq!(action.availability, ActionAvailability::Idle);
        assert!(action.default_bindings.is_empty());
        assert!(action.available(ActionState::chat(false, false)));
        assert!(!action.available(ActionState::chat(true, false)));
        assert!(action.available(ActionState::chat(false, false).for_shared_tui()));
        assert!(action_by_id("workspace_diff", ActionContext::Startup).is_none());
        assert!(action_for_alias("/changes", ActionContext::Chat).is_none());
    }

    #[test]
    fn undo_and_redo_use_only_the_opencode_commands_in_both_deployments() {
        let undo = action_by_id("undo_session", ActionContext::Chat)
            .expect("OpenCode-compatible session undo action");
        let redo = action_by_id("redo_session", ActionContext::Chat)
            .expect("OpenCode-compatible session redo action");

        assert_eq!(undo.aliases, &["/undo"]);
        assert_eq!(undo.handler, ActionHandler::UndoSession);
        assert_eq!(undo.availability, ActionAvailability::Always);
        assert!(undo.default_bindings.is_empty());
        assert!(undo.fallback_bindings.is_empty());
        assert!(undo.available(ActionState::chat(false, false).for_shared_tui()));
        assert!(undo.available(ActionState::chat(true, false).for_shared_tui()));

        assert_eq!(redo.aliases, &["/redo"]);
        assert_eq!(redo.handler, ActionHandler::RedoSession);
        assert_eq!(redo.availability, ActionAvailability::Always);
        assert!(redo.default_bindings.is_empty());
        assert!(redo.fallback_bindings.is_empty());
        assert!(redo.available(ActionState::chat(false, false).for_shared_tui()));
        assert!(redo.available(ActionState::chat(true, false).for_shared_tui()));

        assert!(action_for_alias("/rewind", ActionContext::Chat).is_none());
        assert!(action_for_alias("/revert", ActionContext::Chat).is_none());
        assert!(action_by_id("undo_session", ActionContext::Startup).is_none());
        assert!(action_by_id("redo_session", ActionContext::Startup).is_none());
    }

    #[test]
    fn compact_uses_opencode_commands_without_an_invented_shortcut() {
        let action = action_by_id("compact_session", ActionContext::Chat)
            .expect("current session compaction action");

        assert_eq!(action.aliases, &["/compact", "/summarize"]);
        assert_eq!(action.handler, ActionHandler::CompactSession);
        assert_eq!(action.availability, ActionAvailability::Idle);
        assert!(action.default_bindings.is_empty());
        assert!(action.fallback_bindings.is_empty());
        assert!(action.shortcut_field.is_none());
        assert!(action.available(ActionState::chat(false, false).for_shared_tui()));
        assert!(!action.available(ActionState::chat(true, false).for_shared_tui()));
        assert!(action_for_alias("/compress", ActionContext::Chat).is_none());
    }

    #[test]
    fn status_is_a_shared_chat_action() {
        let action = action_for_alias("/status", ActionContext::Chat)
            .expect("current session status action");

        assert_eq!(action.id, "status");
        assert!(action.available(ActionState::chat(false, false)));
        assert!(action.available(ActionState::chat(true, false)));
        assert!(action.available(ActionState::chat(false, false).for_shared_tui()));
        assert!(action_by_id("status", ActionContext::Startup).is_none());
    }

    #[test]
    fn session_browser_uses_opencode_aliases_and_keeps_history_compatible() {
        let sessions =
            action_for_alias("/sessions", ActionContext::Chat).expect("session browser action");
        let resume = action_for_alias("/resume", ActionContext::Chat)
            .expect("OpenCode-compatible resume alias");
        let continue_session = action_for_alias("/continue", ActionContext::Chat)
            .expect("OpenCode-compatible continue alias");
        let history = action_for_alias("/history", ActionContext::Chat)
            .expect("existing history compatibility alias");

        assert_eq!(resume.id, sessions.id);
        assert_eq!(continue_session.id, sessions.id);
        assert_eq!(history.id, sessions.id);
        assert_eq!(history.handler, ActionHandler::Sessions);
        assert_eq!(history.availability, ActionAvailability::Idle);
    }

    #[test]
    fn clear_alias_matches_opencode_new_session_semantics() {
        let new_session =
            action_for_alias("/new", ActionContext::Chat).expect("new session action");
        let clear = action_for_alias("/clear", ActionContext::Chat)
            .expect("OpenCode-compatible clear alias");

        assert_eq!(clear.id, new_session.id);
        assert_eq!(clear.handler, ActionHandler::NewSession);
        assert_eq!(clear.availability, ActionAvailability::Idle);
        assert!(clear.description.contains("fresh conversation"));
        assert!(clear.available(ActionState::chat(false, false)));
        assert!(clear.available(ActionState::chat(false, false).for_shared_tui()));
        assert!(!clear.available(ActionState::chat(true, false)));
        assert!(action_for_alias("/clear-screen", ActionContext::Chat).is_none());
    }

    #[test]
    fn shared_tui_projections_expose_compatibility_management_actions() {
        let state = ActionState::chat(false, false).for_shared_tui();
        let slash_ids = slash_actions(state)
            .into_iter()
            .map(|action| action.id)
            .collect::<Vec<_>>();
        let palette_ids = palette_actions(state)
            .into_iter()
            .map(|action| action.id)
            .collect::<Vec<_>>();

        for unavailable in ["tools", "extensions", "hooks", "usage"] {
            assert!(!slash_ids.contains(&unavailable), "{unavailable}");
            assert!(!palette_ids.contains(&unavailable), "{unavailable}");
        }
        for available in [
            "new_session",
            "sessions",
            "select_model",
            "add_model",
            "skills",
            "mcp_servers",
            "theme",
            "help",
            "exit",
        ] {
            assert!(palette_ids.contains(&available), "{available}");
        }
        assert!(slash_ids.contains(&"switch_agent"));
        assert!(palette_ids.contains(&"switch_agent"));
        assert!(slash_ids.contains(&"rename_session"));
        assert!(slash_ids.contains(&"reload"));
        assert!(!slash_ids.contains(&"reload_skills"));

        let reload =
            action_for_alias("/reload", ActionContext::Chat).expect("unified reload action");
        assert_eq!(reload.id, "reload");
        assert!(reload.available(state));
        assert!(action_for_alias("/reload-skills", ActionContext::Chat).is_none());

        let help = ResolvedKeymap::new(&ShortcutsConfig::default()).help_text(state);
        assert!(help.contains("Switch Agent"));
        let model_action = slash_actions(state)
            .into_iter()
            .find(|action| action.id == "select_model")
            .expect("shared chat model action");
        assert_eq!(
            model_action.description,
            "Select model for the current session"
        );

        let startup_state = ActionState::startup(false).for_shared_tui();
        assert!(slash_actions(startup_state)
            .iter()
            .any(|action| action.id == "select_model"));
    }

    #[test]
    fn model_action_describes_session_scope_in_chat_and_default_scope_at_startup() {
        let model = action_by_id("select_model", ActionContext::Chat).expect("model action");

        assert_eq!(
            model.description(ActionState::chat(false, false)),
            "Select model for the current session"
        );
        assert_eq!(
            model.description(ActionState::startup(false)),
            "Select default model for future sessions"
        );
        assert!(!model.available(ActionState::chat(true, false)));
    }

    fn resolve_id(
        keymap: &ResolvedKeymap,
        key: KeyEvent,
        state: ActionState,
    ) -> Option<&'static str> {
        keymap.resolve(key, state).map(|action| action.id)
    }

    #[test]
    fn registry_has_unique_stable_ids_and_aliases() {
        let specs = action_specs();
        assert!(!specs.is_empty(), "the action registry must not be empty");

        let mut ids = HashSet::new();
        let mut aliases = HashSet::new();
        for spec in specs {
            assert!(ids.insert(spec.id), "duplicate action id: {}", spec.id);
            for alias in spec.aliases {
                assert!(
                    aliases.insert(alias.to_ascii_lowercase()),
                    "duplicate action alias: {alias}"
                );
            }
        }
    }

    #[test]
    fn slash_and_palette_project_the_same_handler() {
        let state = ActionState::chat(false, false);
        let slash = slash_actions(state);
        let palette = palette_actions(state);
        assert!(!slash.is_empty());
        assert!(!palette.is_empty());

        for palette_action in palette {
            assert!(action_by_id(palette_action.id, ActionContext::Chat).is_some());
        }
    }

    #[test]
    fn agent_selector_and_agent_cycle_are_distinct_actions() {
        let slash = action_for_alias("/agent", ActionContext::Chat).unwrap();
        assert_eq!(slash.handler, ActionHandler::OpenAgentSelector);
        assert_eq!(
            action_for_alias("/agents", ActionContext::Chat).unwrap().id,
            slash.id
        );

        let keymap = ResolvedKeymap::new(&ShortcutsConfig::default());
        assert_eq!(
            resolve_id(
                &keymap,
                KeyEvent::new(KeyCode::Tab, KeyModifiers::NONE),
                ActionState::chat(false, false).for_shared_tui(),
            ),
            Some("cycle_agent")
        );
        assert_eq!(
            resolve_id(
                &keymap,
                KeyEvent::new(KeyCode::BackTab, KeyModifiers::SHIFT),
                ActionState::chat(false, false).for_shared_tui(),
            ),
            Some("switch_agent_reverse")
        );
    }

    #[test]
    fn auto_mode_is_chat_only_and_idle_only() {
        assert!(action_for_alias("/auto", ActionContext::Startup).is_none());

        let action = action_for_alias("/auto", ActionContext::Chat).unwrap();
        assert_eq!(action.handler, ActionHandler::ToggleAutoApprove);
        assert!(action.available(ActionState::chat(false, false)));
        assert!(!action.available(ActionState::chat(true, false)));
    }

    #[test]
    fn worktree_is_chat_only_and_idle_only() {
        assert!(action_for_alias("/worktree", ActionContext::Startup).is_none());

        let action = action_for_alias("/worktree", ActionContext::Chat).unwrap();
        assert_eq!(action.handler, ActionHandler::ToggleWorktree);
        assert!(action.available(ActionState::chat(false, false)));
        assert!(!action.available(ActionState::chat(true, false)));
    }

    #[test]
    fn extension_management_uses_capability_entries_instead_of_external_commands() {
        let tools = action_for_alias("/tools", ActionContext::Chat).unwrap();
        assert_eq!(tools.handler, ActionHandler::Tools);
        let extensions = action_for_alias("/extensions", ActionContext::Chat).unwrap();
        assert_eq!(extensions.handler, ActionHandler::Extensions);
        assert_eq!(extensions.name, "Extensions");
        assert_eq!(extensions.description, "View and manage extensions");
        assert_eq!(
            action_for_alias("/hooks_external", ActionContext::Chat)
                .expect("legacy Hook alias remains parseable")
                .handler,
            ActionHandler::ExternalHooks
        );
        assert!(!slash_actions(ActionState::chat(false, false))
            .iter()
            .any(|action| action.id == "hooks_external"));
        assert!(!palette_actions(ActionState::chat(false, false))
            .iter()
            .any(|action| action.id == "hooks_external"));
        let hooks = action_for_alias("/hooks", ActionContext::Chat).unwrap();
        assert_eq!(hooks.description, "View and manage Hooks");
        let agents = action_for_alias("/agent", ActionContext::Chat).unwrap();
        assert_eq!(agents.handler, ActionHandler::OpenAgentSelector);
        assert_eq!(agents.description, "Switch modes and manage agents");
        assert!(agents.available(ActionState::chat(true, false)));
        assert!(action_for_alias("/subagents", ActionContext::Chat).is_none());
        assert!(action_for_alias("/external-tools", ActionContext::Chat).is_none());
        assert!(action_for_alias("/external-agents", ActionContext::Chat).is_none());
        assert!(
            removed_management_command_hint("/subagents", ActionContext::Chat)
                .unwrap()
                .contains("choose Subagents")
        );
        assert!(
            removed_management_command_hint("/external-tools", ActionContext::Startup)
                .unwrap()
                .contains("Start a session")
        );
    }

    #[test]
    fn agent_action_description_matches_each_tui_shape() {
        let embedded = ActionState::chat(false, false);
        let shared = embedded.for_shared_tui();

        for (projections, expected) in [
            (slash_actions(embedded), "Switch modes and manage agents"),
            (palette_actions(embedded), "Switch modes and manage agents"),
            (slash_actions(shared), "Choose an Agent mode"),
            (palette_actions(shared), "Choose an Agent mode"),
        ] {
            let agent = projections
                .iter()
                .find(|action| action.id == "switch_agent")
                .expect("Agent action projection");
            assert_eq!(agent.description, expected);
        }
    }

    #[test]
    fn no_config_uses_current_real_dispatch_defaults() {
        let keymap = ResolvedKeymap::new(&ShortcutsConfig::default());

        assert_eq!(
            resolve_id(
                &keymap,
                KeyEvent::new(KeyCode::Enter, KeyModifiers::NONE),
                ActionState::chat(false, false),
            ),
            Some("submit_input")
        );
        assert_eq!(
            resolve_id(
                &keymap,
                KeyEvent::new(KeyCode::Char('p'), KeyModifiers::CONTROL),
                ActionState::startup(false),
            ),
            Some("open_palette")
        );
    }

    #[test]
    fn explicit_non_default_binding_resolves_real_key_event() {
        let shortcuts = ShortcutsConfig {
            send_message: Some("Ctrl+S".to_string()),
            interrupt: None,
            menu: None,
        };
        let keymap = ResolvedKeymap::new(&shortcuts);

        assert_eq!(
            resolve_id(
                &keymap,
                KeyEvent::new(KeyCode::Char('s'), KeyModifiers::CONTROL),
                ActionState::chat(false, false),
            ),
            Some("submit_input")
        );
    }

    #[test]
    fn all_explicit_non_default_fields_override_non_reserved_defaults() {
        let shortcuts = ShortcutsConfig {
            send_message: Some("Ctrl+S".to_string()),
            interrupt: Some("Ctrl+X".to_string()),
            menu: Some("Alt+M".to_string()),
        };
        let keymap = ResolvedKeymap::new(&shortcuts);

        assert_eq!(
            resolve_id(
                &keymap,
                KeyEvent::new(KeyCode::Char('s'), KeyModifiers::CONTROL),
                ActionState::chat(false, false),
            ),
            Some("submit_input")
        );
        assert_eq!(
            resolve_id(
                &keymap,
                KeyEvent::new(KeyCode::Char('x'), KeyModifiers::CONTROL),
                ActionState::chat(true, false),
            ),
            Some("interrupt")
        );
        assert_eq!(
            resolve_id(
                &keymap,
                KeyEvent::new(KeyCode::Char('m'), KeyModifiers::ALT),
                ActionState::startup(false),
            ),
            Some("open_palette")
        );
        assert_eq!(
            resolve_id(
                &keymap,
                KeyEvent::new(KeyCode::Enter, KeyModifiers::NONE),
                ActionState::chat(false, false),
            ),
            None,
            "an explicit send binding must replace the built-in Enter binding"
        );
    }

    #[test]
    fn user_binding_conflicts_are_deterministic_and_explainable() {
        let shortcuts = ShortcutsConfig {
            send_message: Some("Ctrl+D".to_string()),
            interrupt: None,
            menu: Some("Ctrl+D".to_string()),
        };
        let keymap = ResolvedKeymap::new(&shortcuts);

        assert_eq!(
            resolve_id(
                &keymap,
                KeyEvent::new(KeyCode::Char('d'), KeyModifiers::CONTROL),
                ActionState::chat(false, false),
            ),
            Some("submit_input"),
            "field order is the documented deterministic tie-breaker"
        );
        let diagnostic = keymap.diagnostics().join("\n");
        assert!(diagnostic.contains("shortcuts.send_message"));
        assert!(diagnostic.contains("shortcuts.menu"));
    }

    #[test]
    fn invalid_user_binding_falls_back_to_builtin_and_is_reported() {
        let shortcuts = ShortcutsConfig {
            send_message: Some("Ctrl+DefinitelyNotAKey".to_string()),
            interrupt: None,
            menu: None,
        };
        let keymap = ResolvedKeymap::new(&shortcuts);

        assert_eq!(
            resolve_id(
                &keymap,
                KeyEvent::new(KeyCode::Enter, KeyModifiers::NONE),
                ActionState::chat(false, false),
            ),
            Some("submit_input")
        );
        assert!(keymap
            .diagnostics()
            .iter()
            .any(|diagnostic| diagnostic.contains("Invalid shortcuts.send_message")));
    }

    #[test]
    fn safety_binding_takes_priority_and_conflict_reports_both_sources() {
        let shortcuts = ShortcutsConfig {
            send_message: None,
            interrupt: None,
            menu: Some("Ctrl+C".to_string()),
        };
        let keymap = ResolvedKeymap::new(&shortcuts);

        assert_eq!(
            resolve_id(
                &keymap,
                KeyEvent::new(KeyCode::Char('c'), KeyModifiers::CONTROL),
                ActionState::startup(false),
            ),
            Some("exit")
        );
        let diagnostic = keymap.diagnostics().join("\n");
        assert!(diagnostic.contains("OpenBitFun safety"));
        assert!(diagnostic.contains("shortcuts.menu"));
        assert!(diagnostic.contains("Quit"));
        assert!(diagnostic.contains("Interrupt"));
        assert!(
            keymap
                .keys_for("open_palette", ActionContext::Startup)
                .is_empty(),
            "help must not advertise a binding that can never win"
        );
    }

    #[test]
    fn popup_and_turn_recovery_bindings_remain_contextual_fallbacks() {
        let shortcuts = ShortcutsConfig {
            send_message: Some("Esc".to_string()),
            interrupt: None,
            menu: Some("Ctrl+W".to_string()),
        };
        let keymap = ResolvedKeymap::new(&shortcuts);

        assert_eq!(
            resolve_id(
                &keymap,
                KeyEvent::new(KeyCode::Esc, KeyModifiers::NONE),
                ActionState::chat(false, false),
            ),
            Some("submit_input")
        );
        assert_eq!(
            resolve_id(
                &keymap,
                KeyEvent::new(KeyCode::Esc, KeyModifiers::NONE),
                ActionState::chat(true, false),
            ),
            Some("interrupt")
        );
        assert_eq!(
            resolve_id(
                &keymap,
                KeyEvent::new(KeyCode::Esc, KeyModifiers::NONE),
                ActionState::chat(false, true),
            ),
            Some("navigate_back")
        );
        assert_eq!(
            keymap
                .resolve_reserved(
                    KeyEvent::new(KeyCode::Esc, KeyModifiers::NONE),
                    ActionState::chat(true, true),
                )
                .map(|action| action.id),
            Some("navigate_back"),
            "popup-local Esc must remain Back even while a turn is processing"
        );
        assert_eq!(
            resolve_id(
                &keymap,
                KeyEvent::new(KeyCode::Char('w'), KeyModifiers::CONTROL),
                ActionState::startup(false),
            ),
            Some("open_palette")
        );
        assert_eq!(
            resolve_id(
                &keymap,
                KeyEvent::new(KeyCode::Char('w'), KeyModifiers::CONTROL),
                ActionState::startup(true),
            ),
            Some("close_popups")
        );
    }

    #[test]
    fn reserved_ctrl_c_remains_available_above_modal_layers() {
        let keymap = ResolvedKeymap::new(&ShortcutsConfig::default());
        let ctrl_c = KeyEvent::new(KeyCode::Char('c'), KeyModifiers::CONTROL);

        assert_eq!(
            keymap
                .resolve_modal_safe(ctrl_c, ActionState::startup(true))
                .map(|action| action.id),
            Some("exit")
        );
        assert_eq!(
            keymap
                .resolve_modal_safe(ctrl_c, ActionState::chat(true, true))
                .map(|action| action.id),
            Some("interrupt")
        );
    }

    #[test]
    fn action_availability_is_enforced_at_the_dispatch_boundary() {
        let agents = action_by_id("switch_agent", ActionContext::Chat).unwrap();
        let cycle_agent = action_by_id("cycle_agent", ActionContext::Chat).unwrap();
        let exit = action_by_id("exit", ActionContext::Chat).unwrap();

        assert!(agents.available(ActionState::chat(true, false)));
        assert!(!cycle_agent.available(ActionState::chat(true, false)));
        assert!(exit.available(ActionState::chat(true, false)));
    }

    #[test]
    fn built_in_key_matching_preserves_legacy_modifier_behavior() {
        let keymap = ResolvedKeymap::new(&ShortcutsConfig::default());
        let idle = ActionState::chat(false, false);

        for modifiers in [KeyModifiers::SHIFT, KeyModifiers::CONTROL] {
            assert_eq!(
                resolve_id(&keymap, KeyEvent::new(KeyCode::Enter, modifiers), idle),
                Some("submit_input")
            );
        }
        assert_eq!(
            resolve_id(
                &keymap,
                KeyEvent::new(KeyCode::Enter, KeyModifiers::ALT | KeyModifiers::SHIFT),
                idle,
            ),
            Some("insert_newline")
        );
        assert_eq!(
            resolve_id(
                &keymap,
                KeyEvent::new(KeyCode::Tab, KeyModifiers::CONTROL),
                idle,
            ),
            Some("cycle_agent")
        );
        assert_eq!(
            resolve_id(
                &keymap,
                KeyEvent::new(KeyCode::PageDown, KeyModifiers::SHIFT),
                idle,
            ),
            Some("scroll_down")
        );
    }

    #[test]
    fn modifier_overlap_uses_the_same_runtime_and_help_semantics() {
        let keymap = ResolvedKeymap::new(&ShortcutsConfig {
            send_message: None,
            interrupt: None,
            menu: Some("Ctrl+Esc".to_string()),
        });
        let ctrl_esc = KeyEvent::new(KeyCode::Esc, KeyModifiers::CONTROL);

        assert_eq!(
            resolve_id(&keymap, ctrl_esc, ActionState::chat(true, false)),
            Some("interrupt")
        );
        let processing_help = keymap.help_text(ActionState::chat(true, false));
        assert!(!processing_help
            .lines()
            .any(|line| { line.contains("Ctrl+Esc") && line.contains("Command Palette") }));
        let idle_help = keymap.help_text(ActionState::chat(false, false));
        assert!(idle_help
            .lines()
            .any(|line| { line.contains("Ctrl+Esc") && line.contains("Command Palette") }));

        let diagnostic = keymap.diagnostics().join("\n");
        assert!(diagnostic.contains("Ctrl+Esc"));
        assert!(diagnostic.contains("shortcuts.menu"));
        assert!(diagnostic.contains("OpenBitFun safety"));
    }

    #[test]
    fn partial_modifier_overlap_is_reported_without_hiding_effective_keys() {
        let keymap = ResolvedKeymap::new(&ShortcutsConfig {
            send_message: None,
            interrupt: None,
            menu: Some("Ctrl+Tab".to_string()),
        });

        assert_eq!(
            resolve_id(
                &keymap,
                KeyEvent::new(KeyCode::Tab, KeyModifiers::CONTROL),
                ActionState::chat(false, false),
            ),
            Some("open_palette")
        );
        assert_eq!(
            resolve_id(
                &keymap,
                KeyEvent::new(KeyCode::Tab, KeyModifiers::NONE),
                ActionState::chat(false, false),
            ),
            Some("cycle_agent")
        );
        let help = keymap.help_text(ActionState::chat(false, false));
        assert!(help.contains("Ctrl+Tab"));
        assert!(help.contains("Tab"));
        assert!(keymap.diagnostics().join("\n").contains("Ctrl+Tab"));
    }

    #[test]
    fn help_does_not_advertise_a_shadowed_canonical_key() {
        for binding in ["Enter", "Tab"] {
            let keymap = ResolvedKeymap::new(&ShortcutsConfig {
                send_message: None,
                interrupt: None,
                menu: Some(binding.to_string()),
            });
            let code = if binding == "Enter" {
                KeyCode::Enter
            } else {
                KeyCode::Tab
            };

            assert_eq!(
                resolve_id(
                    &keymap,
                    KeyEvent::new(code, KeyModifiers::NONE),
                    ActionState::chat(false, false),
                ),
                Some("open_palette")
            );
            let help = keymap.help_text(ActionState::chat(false, false));
            let shadowed_action = if binding == "Enter" {
                "submit_input"
            } else {
                "cycle_agent"
            };
            assert!(
                keymap
                    .keys_for(shadowed_action, ActionContext::Chat)
                    .is_empty(),
                "{binding} must not be advertised for both actions:\n{help}"
            );
        }
    }

    #[test]
    fn help_uses_single_action_labels_when_only_one_group_key_remains() {
        let cases = [
            (
                ShortcutsConfig {
                    send_message: Some("Ctrl+C".to_string()),
                    interrupt: None,
                    menu: None,
                },
                "Alt+Enter",
                "Newline",
                "Send / Newline",
            ),
            (
                ShortcutsConfig {
                    send_message: None,
                    interrupt: None,
                    menu: Some("Alt+Enter".to_string()),
                },
                "Enter",
                "Send",
                "Send / Newline",
            ),
            (
                ShortcutsConfig {
                    send_message: None,
                    interrupt: None,
                    menu: Some("Ctrl+J".to_string()),
                },
                "Ctrl+K",
                "Next Tool",
                "Prev / Next Tool",
            ),
            (
                ShortcutsConfig {
                    send_message: None,
                    interrupt: None,
                    menu: Some("Ctrl+Home".to_string()),
                },
                "Ctrl+End",
                "Jump to Bottom",
                "Jump to Top / Bottom",
            ),
        ];

        for (shortcuts, key, expected_label, combined_label) in cases {
            let help = ResolvedKeymap::new(&shortcuts).help_text(ActionState::chat(false, false));
            let shortcuts_section = help.split("Shortcut notices").next().unwrap();
            let row = shortcuts_section
                .lines()
                .find(|line| line.contains(key))
                .unwrap_or_else(|| panic!("missing {key} row:\n{help}"));
            assert!(row.contains(expected_label), "{row}");
            assert!(!row.contains(combined_label), "{row}");
        }
    }

    #[test]
    fn help_exposes_custom_send_and_popup_recovery_keys() {
        let keymap = ResolvedKeymap::new(&ShortcutsConfig {
            send_message: Some("Ctrl+S".to_string()),
            interrupt: None,
            menu: None,
        });
        let help = keymap.help_text(ActionState::chat(false, false));

        assert!(help
            .lines()
            .any(|line| line.contains("Ctrl+S") && line.contains("Send")));
        assert!(help.lines().any(|line| {
            line.contains("Ctrl+W / Esc") && line.contains("Close All Popups / Back")
        }));
    }

    #[test]
    fn processing_slash_projection_omits_init() {
        let ids = slash_actions(ActionState::chat(true, false))
            .into_iter()
            .map(|action| action.id)
            .collect::<Vec<_>>();

        assert!(!ids.contains(&"init"));
    }

    #[test]
    fn hints_follow_the_current_turn_state() {
        let keymap = ResolvedKeymap::new(&ShortcutsConfig::default());
        let idle = keymap.compact_hints(ActionState::chat(false, false));
        let processing = keymap.compact_hints(ActionState::chat(true, false));

        assert!(idle.iter().any(|(_, label)| *label == "Quit"));
        assert!(!idle.iter().any(|(_, label)| *label == "Interrupt"));
        assert!(processing.iter().any(|(_, label)| *label == "Interrupt"));
        assert!(!processing.iter().any(|(_, label)| *label == "Quit"));
    }

    #[test]
    fn default_chat_help_fits_an_80_by_24_popup() {
        let keymap = ResolvedKeymap::new(&ShortcutsConfig::default());
        let help = keymap.help_text(ActionState::chat(false, false));

        assert!(help.lines().count() <= 19, "{help}");
        assert!(
            help.lines().all(|line| line.chars().count() <= 74),
            "{help}"
        );
    }

    #[test]
    fn conflicting_shortcut_notices_still_fit_an_80_by_24_popup() {
        let keymap = ResolvedKeymap::new(&ShortcutsConfig {
            send_message: Some("Ctrl+C".to_string()),
            interrupt: Some("Ctrl+C".to_string()),
            menu: Some("Ctrl+C".to_string()),
        });
        let help = keymap.help_text(ActionState::chat(false, false));

        assert!(help.lines().count() <= 19, "{help}");
        assert!(
            help.lines().all(|line| line.chars().count() <= 74),
            "{help}"
        );
        assert!(help.contains("OpenBitFun safety"));
    }

    #[test]
    fn shortcut_notices_use_user_facing_names_and_keep_both_sources() {
        let keymap = ResolvedKeymap::new(&ShortcutsConfig {
            send_message: Some("Ctrl+P".to_string()),
            interrupt: None,
            menu: None,
        });
        let help = keymap.help_text(ActionState::chat(false, false));

        assert!(help.contains("shortcuts.send_message"), "{help}");
        assert!(help.contains("OpenBitFun default"), "{help}");
        assert!(help.contains("Commands"), "{help}");
        assert!(!help.contains("open_palette"), "{help}");
        assert!(help.lines().all(|line| line.chars().count() <= 74));
    }

    #[test]
    fn long_valid_conflict_keeps_both_sources_without_exceeding_help_bounds() {
        let chord = "Ctrl+Alt+Shift+Super+F12";
        let keymap = ResolvedKeymap::new(&ShortcutsConfig {
            send_message: Some(chord.to_string()),
            interrupt: None,
            menu: Some(chord.to_string()),
        });
        let help = keymap.help_text(ActionState::chat(false, false));

        assert!(help.contains(chord), "{help}");
        assert!(help.contains("shortcuts.send_message"), "{help}");
        assert!(help.contains("shortcuts.menu"), "{help}");
        assert!(!help.contains("..."), "{help}");
        assert!(help.lines().count() <= 19, "{help}");
        assert!(help.lines().all(|line| line.chars().count() <= 74));
    }

    #[test]
    fn long_invalid_binding_keeps_field_and_fallback_visible() {
        let keymap = ResolvedKeymap::new(&ShortcutsConfig {
            send_message: Some(format!("Ctrl+{}", "X".repeat(512))),
            interrupt: None,
            menu: None,
        });
        let help = keymap.help_text(ActionState::chat(false, false));

        assert!(help.contains("Invalid shortcuts.send_message"), "{help}");
        assert!(help.contains("unsupported key"), "{help}");
        assert!(help.contains("using OpenBitFun"), "{help}");
        assert!(help.lines().any(|line| line.trim() == "default"), "{help}");
        assert!(!help.contains("more shortcut notices"), "{help}");
        assert!(help.lines().count() <= 19, "{help}");
        assert!(help.lines().all(|line| line.chars().count() <= 74));
    }

    #[test]
    fn opencode_transcript_actions_use_exact_command_names_and_availability() {
        let editor = action_for_alias("/editor", ActionContext::Chat).expect("/editor action");
        let copy = action_for_alias("/copy", ActionContext::Chat).expect("/copy action");
        let export = action_for_alias("/export", ActionContext::Chat).expect("/export action");

        assert_eq!(editor.aliases, ["/editor"]);
        assert_eq!(copy.aliases, ["/copy"]);
        assert_eq!(export.aliases, ["/export"]);
        assert_eq!(editor.handler, ActionHandler::Editor);
        assert_eq!(copy.handler, ActionHandler::CopyTranscript);
        assert_eq!(export.handler, ActionHandler::ExportTranscript);
        assert!(!editor.available(ActionState::chat(true, false)));
        assert!(!copy.available(ActionState::chat(true, false)));
        assert!(!export.available(ActionState::chat(true, false)));
        assert!(editor.default_bindings.is_empty());
        assert!(copy.default_bindings.is_empty());
        assert!(export.default_bindings.is_empty());
        assert!(editor.handler.available_in_shared_tui(ActionContext::Chat));
        assert!(copy.handler.available_in_shared_tui(ActionContext::Chat));
        assert!(export.handler.available_in_shared_tui(ActionContext::Chat));
    }

    #[test]
    fn opencode_view_subagents_is_palette_only_and_read_only() {
        let action = action_by_id("view_subagents", ActionContext::Chat)
            .expect("View subagents palette action");
        let inspection = ActionState::chat(true, false).with_lineage_inspection(true);

        assert_eq!(action.name, "View subagents");
        assert_eq!(action.handler, ActionHandler::ViewSubagents);
        assert!(action.aliases.is_empty());
        assert!(action.default_bindings.is_empty());
        assert_eq!(action.palette.map(|palette| palette.group), Some("Session"));
        assert!(action.available(inspection));
        assert!(action.handler.available_in_shared_tui(ActionContext::Chat));
        assert!(action_for_alias("/subagents", ActionContext::Chat).is_none());

        for handler in [
            ActionHandler::SubmitInput,
            ActionHandler::InsertNewline,
            ActionHandler::Paste,
            ActionHandler::UndoSession,
            ActionHandler::RedoSession,
            ActionHandler::ForkSession,
            ActionHandler::CompactSession,
        ] {
            assert!(!handler.available_in_lineage_inspection());
        }
    }

    #[test]
    fn opencode_prompt_stash_uses_palette_only_entrypoints_without_default_bindings() {
        let state = ActionState::chat(false, false);
        let expected = [
            ("prompt_stash", "Stash prompt", ActionHandler::PromptStash),
            (
                "prompt_stash_pop",
                "Stash pop",
                ActionHandler::PromptStashPop,
            ),
            (
                "prompt_stash_list",
                "Stash list",
                ActionHandler::PromptStashList,
            ),
        ];

        for (id, name, handler) in expected {
            let action = action_by_id(id, ActionContext::Chat).expect("stash action");
            assert_eq!(action.name, name);
            assert_eq!(action.handler, handler);
            assert!(action.aliases.is_empty());
            assert!(action.default_bindings.is_empty());
            assert_eq!(action.palette.map(|palette| palette.group), Some("Prompt"));
            assert!(action.handler.available_in_shared_tui(ActionContext::Chat));
        }

        let slash_ids = slash_actions(state)
            .into_iter()
            .map(|action| action.id)
            .collect::<Vec<_>>();
        assert!(!slash_ids.iter().any(|id| id.starts_with("prompt_stash")));
    }

    #[test]
    fn opencode_navigation_and_presentation_actions_keep_exact_entrypoints() {
        let timeline =
            action_for_alias("/timeline", ActionContext::Chat).expect("/timeline action");
        let timestamps =
            action_for_alias("/timestamps", ActionContext::Chat).expect("/timestamps action");
        let timestamps_alias = action_for_alias("/toggle-timestamps", ActionContext::Chat)
            .expect("/toggle-timestamps action");
        let thinking =
            action_for_alias("/thinking", ActionContext::Chat).expect("/thinking action");
        let thinking_alias = action_for_alias("/toggle-thinking", ActionContext::Chat)
            .expect("/toggle-thinking action");
        let tool_details = action_by_id("toggle_tool_details", ActionContext::Chat)
            .expect("tool details palette action");

        assert_eq!(timeline.id, "timeline");
        assert_eq!(timeline.aliases, ["/timeline"]);
        assert_eq!(timestamps.id, "toggle_timestamps");
        assert_eq!(timestamps.aliases, ["/timestamps", "/toggle-timestamps"]);
        assert_eq!(timestamps.id, timestamps_alias.id);
        assert_eq!(thinking.id, "toggle_thinking");
        assert_eq!(thinking.aliases, ["/thinking", "/toggle-thinking"]);
        assert_eq!(thinking.id, thinking_alias.id);
        assert!(tool_details.aliases.is_empty());
        for action in [timeline, timestamps, thinking, tool_details] {
            assert_eq!(action.palette.map(|palette| palette.group), Some("Session"));
            assert!(action.available(ActionState::chat(false, false)));
            assert!(action.available(ActionState::chat(true, false)));
            assert!(action.handler.available_in_shared_tui(ActionContext::Chat));
        }
    }
}
