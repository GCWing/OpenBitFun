use super::agent_selector::{AgentItem, AgentSelectorAction, AgentSelectorState};
use super::command_menu::CommandMenuState;
use super::command_palette::{CommandPaletteState, PaletteAction};
use super::composer::{ComposerDraft, ComposerImageAttachment};
use super::image_paste::{self, ImagePaste};
use super::login_form::{LoginFormAction, LoginFormState};
use super::model_config_form::{ModelConfigFormState, ModelFormAction, ModelFormResult};
use super::model_selector::{ModelItem, ModelSelectorState};
use super::provider_selector::{ProviderSelection, ProviderSelectorState};
use super::session_selector::{SessionAction, SessionItem, SessionSelectorState};
use super::skill_selector::{SkillItem, SkillSelectorAction, SkillSelectorState};
use super::subagent_selector::{SubagentItem, SubagentSelectorAction, SubagentSelectorState};
use super::text_input::{TextInput, TextInputStyle};
use super::theme::{
    builtin_theme_ids, builtin_theme_json, resolve_appearance, resolve_effective_color_scheme,
    Appearance, EffectiveColorScheme, Theme,
};
use super::theme_selector::{ThemeItem, ThemeSelectorState};
use crate::actions::{
    action_by_id, action_for_alias, removed_management_command_hint, ActionContext, ActionHandler,
    ActionSpec, ActionState, ResolvedKeymap, IMAGE_ATTACHMENTS_REQUIRE_MESSAGE,
    SHARED_TUI_HELP_NOTE,
};
use crate::config::CliConfig;
/// Startup page module
///
/// Full-featured startup page with:
/// - Centered logo and input box
/// - Slash command menu with real execution
/// - Model/Agent/Session/Skill/Subagent selector popups
/// - Random tips
use anyhow::{anyhow, Result};
use crossterm::event::{Event, KeyCode, KeyEvent, KeyEventKind, KeyModifiers};
use openbitfun_product_domains::agent_catalog::{SkillSummary, SubagentSummary};
use ratatui::{
    backend::Backend,
    layout::{Alignment, Constraint, Direction, Layout, Rect},
    style::{Color, Modifier, Style},
    text::{Line, Span},
    widgets::{Block, Paragraph},
    Frame, Terminal,
};
use std::sync::Arc;
use std::time::Duration;

use crate::account::{
    account_login_status_message, account_snapshot_projection, redact_login_error,
};
use crate::agent::runtime_client::{CliAgentMode as TuiAgentMode, CliAgentRuntimeClient};
use crate::model_selection::{
    model_catalog_projection, model_edit_projection, model_from_mutation, model_list_projection,
};
use openbitfun_core::service::remote_connect::account_runtime::AccountRuntime;

/// Types of popups that can be shown on the startup page
#[derive(Debug, Clone, PartialEq)]
enum PopupType {
    CommandPalette,
    ModelSelector,
    AgentSelector,
    SessionSelector,
    SkillSelector,
    SubagentSelector,
    ThemeSelector,
    ProviderSelector,
    ModelConfigForm,
    LoginForm,
}

/// Navigation stack for managing popup hierarchy
#[derive(Debug, Default)]
struct PopupStack {
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
    fn pop(&mut self) -> Option<PopupType> {
        self.stack.pop()
    }

    /// Clear all popups from the stack
    fn clear(&mut self) {
        self.stack.clear();
    }
}

/// Startup menu result
#[derive(Debug, Clone)]
pub(crate) enum StartupResult {
    /// Start a new session with an optional initial prompt
    NewSession { prompt: Option<ComposerDraft> },
    /// Continue last session (session ID)
    ContinueSession(String),
    /// User cancelled exit
    Exit,
}

/// Random tips shown on the startup page
const TIPS: &[&str] = &[
    "Type / for slash commands (e.g. /help, /login, /models)",
    "Press Tab to cycle between agents",
    "Use /login to sign in for Peer Device Mode / multi-device sync",
    "Use /init to explore your repo and generate AGENTS.md",
    "Press Ctrl+E to toggle browse mode for scrolling history",
    "Use /sessions to list and continue previous conversations",
    "Press Ctrl+O to expand/collapse tool output",
    "Use /skills to browse and execute available skills",
    "Use /usage inside a session to generate a usage report",
    "Use /theme to switch the CLI theme",
    "Use /acp to copy editor setup commands for ACP hosts",
    "Press Up/Down to cycle through input history",
    "Use /new to start a fresh conversation session",
];

const SHARED_TUI_TIPS: &[&str] = &[
    "Type /help to see the Shared TUI command scope",
    "Use /sessions to list and continue previous conversations",
    "Use /new to start a fresh conversation session",
    "Press Ctrl+E to toggle browse mode for scrolling history",
    "Press Ctrl+O to expand or collapse tool output",
    "Use /theme to switch the CLI theme",
];

const FANCY_LOGO: [&str; 6] = [
    "  ██████╗ ██╗████████╗███████╗██╗   ██╗███╗   ██╗",
    "  ██╔══██╗██║╚══██╔══╝██╔════╝██║   ██║████╗  ██║",
    "  ██████╔╝██║   ██║   █████╗  ██║   ██║██╔██╗ ██║",
    "  ██╔══██╗██║   ██║   ██╔══╝  ██║   ██║██║╚██╗██║",
    "  ██████╔╝██║   ██║   ██║     ╚██████╔╝██║ ╚████║",
    "  ╚═════╝ ╚═╝   ╚═╝   ╚═╝      ╚═════╝ ╚═╝  ╚═══╝",
];

const COMPACT_LOGO: [&str; 5] = [
    "  ____  _ _   _____            ",
    " | __ )(_) |_|  ___|   _ _ __  ",
    " |  _ \\| | __| |_ | | | | '_ \\ ",
    " | |_) | | |_|  _|| |_| | | | |",
    " |____/|_|\\__|_|   \\__,_|_| |_|",
];

fn append_styled_logo_lines(
    lines: &mut Vec<Line<'static>>,
    logo: &'static [&'static str],
    colors: &[Color],
) {
    for (index, line) in logo.iter().enumerate() {
        lines.push(Line::from(Span::styled(
            *line,
            Style::default()
                .fg(colors[index % colors.len()])
                .add_modifier(Modifier::BOLD),
        )));
    }
}

/// Startup page
pub(crate) struct StartupPage {
    /// Multiline text input component
    text_input: TextInput,
    image_attachments: Vec<ComposerImageAttachment>,
    /// Theme
    theme: Theme,
    /// CLI config, including persisted theme preference.
    config: CliConfig,
    /// Resolved host-owned action bindings for the current config.
    keymap: ResolvedKeymap,
    /// Current tip text
    tip: &'static str,

    // ── Command menu ──
    command_menu: CommandMenuState,

    // ── Command palette (Ctrl+P) ──
    command_palette: CommandPaletteState,

    // ── Selector popups ──
    model_selector: ModelSelectorState,
    agent_selector: AgentSelectorState,
    session_selector: SessionSelectorState,
    skill_selector: SkillSelectorState,
    subagent_selector: SubagentSelectorState,
    theme_selector: ThemeSelectorState,
    provider_selector: ProviderSelectorState,
    model_config_form: ModelConfigFormState,
    login_form: LoginFormState,
    theme_preview_original: Option<Theme>,

    // ── System context ──
    agent: Arc<CliAgentRuntimeClient>,
    account_runtime: Option<Arc<AccountRuntime>>,

    // ── State ──
    /// Selected agent type (can be changed via /agent or Tab)
    agent_type: String,
    /// Display name of selected model
    model_display_name: String,
    /// Explicit model chosen for the new Session being composed. Persisted
    /// defaults and an agent profile remain inputs only until the user chooses.
    selected_model_id: Option<String>,
    /// Workspace path for display in bottom bar
    workspace_display: String,
    /// Status message (temporarily shown instead of tip)
    status: Option<String>,
    /// Info popup message (rendered as overlay, dismissed by any key)
    info_popup: Option<String>,

    /// Popup navigation stack for back navigation
    popup_stack: PopupStack,
}

impl StartupPage {
    pub(crate) fn new(
        config: CliConfig,
        agent: Arc<CliAgentRuntimeClient>,
        account_runtime: Option<Arc<AccountRuntime>>,
        default_agent: String,
        workspace: Option<String>,
    ) -> Self {
        let appearance = resolve_appearance(&config.ui.theme);
        let scheme = resolve_effective_color_scheme(&config.ui.color_scheme);
        let base_is_light = appearance.is_light();
        let base = match (base_is_light, scheme) {
            (_, EffectiveColorScheme::Monochrome) => Theme::monochrome(),
            (true, EffectiveColorScheme::Ansi16) => Theme::light_ansi16(),
            (true, EffectiveColorScheme::Truecolor) => Theme::light(),
            (false, EffectiveColorScheme::Ansi16) => Theme::dark_ansi16(),
            (false, EffectiveColorScheme::Truecolor) => Theme::dark(),
        };
        let theme = if scheme == EffectiveColorScheme::Monochrome {
            Theme::monochrome()
        } else {
            let id = config.ui.theme_id.trim();
            if id.is_empty() {
                base
            } else if let Some(json) = builtin_theme_json(id) {
                base.apply_opencode_theme_json(json, appearance)
                    .unwrap_or(base)
                    .with_effective_scheme(scheme)
            } else {
                base
            }
        };

        let tips = if agent.is_shared() {
            SHARED_TUI_TIPS
        } else {
            TIPS
        };
        let tip_index = std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .unwrap_or_default()
            .as_millis() as usize
            % tips.len();

        let keymap = ResolvedKeymap::new(&config.shortcuts);
        let action_state = ActionState::startup(false).with_shared_tui(agent.is_shared());
        let mut page = Self {
            text_input: TextInput::new(),
            image_attachments: Vec::new(),
            theme,
            config,
            keymap,
            tip: tips[tip_index],
            command_menu: CommandMenuState::new(action_state),
            command_palette: CommandPaletteState::new(),
            model_selector: ModelSelectorState::new(),
            agent_selector: AgentSelectorState::new(),
            session_selector: SessionSelectorState::new(),
            skill_selector: SkillSelectorState::new(),
            subagent_selector: SubagentSelectorState::new(),
            theme_selector: ThemeSelectorState::new(),
            provider_selector: ProviderSelectorState::new(),
            model_config_form: ModelConfigFormState::new(),
            login_form: LoginFormState::new(),
            theme_preview_original: None,
            agent,
            account_runtime,
            agent_type: default_agent,
            model_display_name: String::new(),
            selected_model_id: None,
            workspace_display: workspace.unwrap_or_else(|| {
                std::env::current_dir()
                    .ok()
                    .and_then(|p| dunce::canonicalize(&p).ok())
                    .map(|p| p.to_string_lossy().to_string())
                    .unwrap_or_else(|| ".".to_string())
            }),
            status: None,
            info_popup: None,
            popup_stack: PopupStack::new(),
        };

        // Load current model name
        page.load_current_model_name();
        page
    }

    /// Get the currently selected agent type
    pub(crate) fn agent_type(&self) -> &str {
        &self.agent_type
    }

    pub(crate) fn selected_agent_route_key(&self) -> Option<String> {
        self.selected_agent_mode()
            .map(|mode| mode.route_key)
            .filter(|route_key| !route_key.is_empty())
    }

    /// Set a model ID override (from `--model` flag) for display and session
    /// composition. The ID is validated when applied to the session; an invalid
    /// ID logs a warning and falls back to the default model.
    pub(crate) fn set_model_override(&mut self, model_id: Option<String>) {
        if model_id.is_some() {
            self.selected_model_id = model_id;
        }
        self.load_current_model_name();
    }

    /// Return the model explicitly selected for the new Session, if any.
    pub(crate) fn selected_model_id(&self) -> Option<&str> {
        self.selected_model_id.as_deref()
    }

    /// Get the current workspace path for this CLI process.
    pub(crate) fn workspace(&self) -> Option<String> {
        if self.workspace_display.is_empty() {
            None
        } else {
            Some(self.workspace_display.clone())
        }
    }

    fn action_state(&self, popup_open: bool) -> ActionState {
        ActionState::startup(popup_open).with_shared_tui(self.agent.is_shared())
    }

    /// Get the current CLI config after startup-page edits.
    pub(crate) fn config(&self) -> &CliConfig {
        &self.config
    }

    fn workspace_path_buf(&self) -> std::path::PathBuf {
        self.workspace()
            .map(std::path::PathBuf::from)
            .or_else(|| std::env::current_dir().ok())
            .unwrap_or_else(|| std::path::PathBuf::from("."))
    }

    /// Check if any popup is currently visible
    fn any_popup_visible(&self) -> bool {
        self.command_palette.is_visible()
            || self.model_selector.is_visible()
            || self.agent_selector.is_visible()
            || self.session_selector.is_visible()
            || self.skill_selector.is_visible()
            || self.subagent_selector.is_visible()
            || self.theme_selector.is_visible()
            || self.provider_selector.is_visible()
            || self.model_config_form.is_visible()
            || self.login_form.is_visible()
    }

    pub(crate) fn run<B: Backend>(&mut self, terminal: &mut Terminal<B>) -> Result<StartupResult> {
        terminal.clear()?;
        let mut event_reader = crate::ui::input::EventReader::default();

        loop {
            terminal.draw(|f| self.render(f))?;

            if let Some(events) = event_reader.read_event_batch(Duration::from_millis(50))? {
                for event in events {
                    match event {
                        Event::Key(key)
                            if key.kind == KeyEventKind::Press
                                || key.kind == KeyEventKind::Repeat =>
                        {
                            if let Some(result) = self.handle_key(key) {
                                return Ok(result);
                            }
                        }
                        other => {
                            if let Some(result) = self.handle_non_key_event(other, terminal)? {
                                return Ok(result);
                            }
                        }
                    }
                }
            }
        }
    }

    fn handle_non_key_event<B: Backend>(
        &mut self,
        ev: Event,
        terminal: &mut Terminal<B>,
    ) -> Result<Option<StartupResult>> {
        match ev {
            Event::Mouse(mouse) => {
                if self.command_palette.captures_mouse(&mouse) {
                    let action = self.command_palette.handle_mouse_event(&mouse);
                    match action {
                        PaletteAction::Execute(id) => {
                            return Ok(self.handle_palette_action(&id));
                        }
                        PaletteAction::Dismiss => self.navigate_back(),
                        PaletteAction::None => {}
                    }
                } else if self.theme_selector.captures_mouse(&mouse) {
                    self.theme_selector.handle_mouse_event(&mouse);
                    if let Some(selected) = self.theme_selector.selected_item().cloned() {
                        self.preview_theme_selection(&selected);
                    }
                } else if self.provider_selector.captures_mouse(&mouse) {
                    if let Some(selection) = self.provider_selector.handle_mouse_event(&mouse) {
                        self.handle_provider_selection(selection);
                    }
                } else if self.command_menu.captures_mouse(&mouse) {
                    if let Some(action_id) = self.command_menu.handle_mouse_event(&mouse) {
                        if !self.image_attachments.is_empty() {
                            self.status = Some(IMAGE_ATTACHMENTS_REQUIRE_MESSAGE.to_string());
                            return Ok(None);
                        }
                        self.clear_composer();
                        self.refresh_command_menu();
                        return Ok(self.handle_palette_action(&action_id));
                    }
                }
            }
            Event::Paste(text) => {
                if self.login_form.is_visible() {
                    self.login_form.insert_paste(&text);
                } else if self.info_popup.is_none() && !self.any_popup_visible() {
                    self.paste_terminal_text(&text);
                }
            }
            Event::Resize(_, _) => {
                // Avoid full-screen clear on every resize event to reduce flicker.
                let _ = terminal;
            }
            _ => {}
        }
        Ok(None)
    }

    // ======================== Rendering ========================

    fn render(&mut self, frame: &mut Frame) {
        let size = frame.area();
        frame.render_widget(
            Block::default().style(Style::default().bg(self.theme.background)),
            size,
        );

        let chunks = Layout::default()
            .direction(Direction::Vertical)
            .constraints([
                Constraint::Min(1),    // main content
                Constraint::Length(1), // bottom bar
            ])
            .split(size);

        let main_area = chunks[0];
        let input_area = self.render_main(frame, main_area);
        self.render_bottom_bar(frame, chunks[1]);

        // Overlay: command menu (above input area)
        if self.command_menu.is_visible() {
            let menu_area = Rect {
                x: input_area.x,
                y: main_area.y,
                width: input_area.width,
                height: input_area.y.saturating_sub(main_area.y),
            };
            self.command_menu.render(frame, menu_area, &self.theme);
        }

        // Overlay: selector popups (centered on full screen)
        self.model_selector.render(frame, size, &self.theme);
        self.agent_selector.render(frame, size, &self.theme);
        self.session_selector.render(frame, size, &self.theme);
        self.skill_selector.render(frame, size, &self.theme);
        self.subagent_selector.render(frame, size, &self.theme);
        self.theme_selector.render(frame, size, &self.theme);
        self.provider_selector.render(frame, size, &self.theme);
        self.model_config_form.render_mut(frame, size, &self.theme);

        // Overlay: command palette (Ctrl+P)
        self.command_palette.render(frame, size, &self.theme);

        // Dedicated login page (full viewport takeover)
        self.login_form.render(frame, size, &self.theme);

        // Overlay: info popup (highest priority)
        if let Some(ref msg) = self.info_popup {
            super::widgets::render_info_popup(frame, size, msg, self.theme.primary);
        }
    }

    /// Render main content, returns the input box area (for command menu positioning)
    fn render_main(&mut self, frame: &mut Frame, area: Rect) -> Rect {
        let max_width = 75u16.min(area.width.saturating_sub(4));

        // Dynamic input height: content lines (1..6) + 2 (padding top + agent label row) + 1 (gap)
        let input_content_width = max_width.saturating_sub(2 + 4); // left bar(2) + inner padding(4)
        let visual_lines =
            self.text_input
                .visual_line_count_with_prefix(input_content_width, 0) as u16;
        let content_lines = visual_lines.clamp(1, 6);
        let input_box_height = content_lines + 3; // +1 top padding, +1 gap, +1 agent label

        let v_chunks = Layout::default()
            .direction(Direction::Vertical)
            .constraints([
                Constraint::Percentage(20),           // top space
                Constraint::Length(12),               // logo
                Constraint::Length(1),                // gap
                Constraint::Length(input_box_height), // input box
                Constraint::Length(2),                // gap + tip/status
                Constraint::Min(1),                   // bottom space
            ])
            .split(area);

        // Logo
        self.render_logo(frame, v_chunks[1]);

        // Input box - centered horizontally
        let h_pad = area.width.saturating_sub(max_width) / 2;
        let input_area = Rect {
            x: area.x + h_pad,
            y: v_chunks[3].y,
            width: max_width,
            height: v_chunks[3].height,
        };
        self.render_input(frame, input_area);

        // Tip / status
        let tip_area = Rect {
            x: area.x + h_pad,
            y: v_chunks[4].y + 1,
            width: max_width,
            height: 1,
        };
        self.render_tip_or_status(frame, tip_area);

        input_area
    }

    fn render_input(&mut self, frame: &mut Frame, area: Rect) {
        let highlight_color = self.theme.primary;
        let input_bg = self.input_background();

        // Split: 2 cols for left bar, rest for content
        let h_chunks = Layout::default()
            .direction(Direction::Horizontal)
            .constraints([
                Constraint::Length(2), // left bar
                Constraint::Min(1),    // content
            ])
            .split(area);

        // Left bar: full-height ┃
        let bar_lines: Vec<Line> = (0..area.height)
            .map(|_| {
                Line::from(Span::styled(
                    " ┃",
                    Style::default().fg(highlight_color).bg(input_bg),
                ))
            })
            .collect();
        let bar = Paragraph::new(bar_lines).style(Style::default().bg(input_bg));
        frame.render_widget(bar, h_chunks[0]);

        // Content area with background
        let content_area = h_chunks[1];

        // Fill background
        let bg = Paragraph::new(vec![Line::from(""); content_area.height as usize])
            .style(Style::default().bg(input_bg));
        frame.render_widget(bg, content_area);

        // Inner content with padding
        let inner = Rect {
            x: content_area.x + 2,
            y: content_area.y + 1,
            width: content_area.width.saturating_sub(4),
            height: content_area.height.saturating_sub(1),
        };

        // Calculate how many lines are available for text input
        // Reserve 2 lines at the bottom: 1 gap + 1 agent label
        let text_height = inner.height.saturating_sub(2).max(1);
        let text_area = Rect {
            x: inner.x,
            y: inner.y,
            width: inner.width,
            height: text_height,
        };

        // Render text input using shared TextInput component
        let style = TextInputStyle {
            first_line_prefix: "",
            continuation_prefix: "",
            placeholder: "Ask anything... or type / for commands".to_string(),
            text_style: Style::default().fg(self.theme.command_text).bg(input_bg),
            placeholder_style: Style::default().fg(self.theme.muted).bg(input_bg),
        };
        self.text_input.render(frame, text_area, &style, true);

        // Agent label + model name below input (with 1 line gap)
        if inner.height >= 3 {
            let mut spans = vec![Span::styled(
                &self.agent_type,
                Style::default().fg(highlight_color),
            )];
            if !self.model_display_name.is_empty() {
                spans.push(Span::styled(" | ", Style::default().fg(self.theme.muted)));
                spans.push(Span::styled(
                    &self.model_display_name,
                    Style::default().fg(self.theme.muted),
                ));
            }
            let agent_line = Line::from(spans);
            let agent_area = Rect {
                x: inner.x,
                y: inner.y + text_height + 1,
                width: inner.width,
                height: 1,
            };
            frame.render_widget(Paragraph::new(agent_line), agent_area);
        }
    }

    fn input_background(&self) -> ratatui::style::Color {
        self.theme.input_background
    }

    fn render_tip_or_status(&self, frame: &mut Frame, area: Rect) {
        let line = if let Some(ref status) = self.status {
            Line::from(vec![
                Span::styled("● ", Style::default().fg(self.theme.success)),
                Span::styled(status.as_str(), Style::default().fg(self.theme.muted)),
            ])
        } else {
            Line::from(vec![
                Span::styled("● ", Style::default().fg(self.theme.warning)),
                Span::styled("Tip ", Style::default().fg(self.theme.warning)),
                Span::styled(self.tip, Style::default().fg(self.theme.muted)),
            ])
        };
        frame.render_widget(Paragraph::new(line), area);
    }

    fn render_bottom_bar(&self, frame: &mut Frame, area: Rect) {
        let version = format!("v{}", env!("CARGO_PKG_VERSION"));
        let (runtime_status, runtime_color) = if self.agent.is_shared() {
            ("Runtime: Shared".to_string(), self.theme.success)
        } else {
            let mcp_status = crate::get_mcp_status_text();
            let color = if mcp_status.contains("Ready") {
                self.theme.success
            } else if mcp_status.contains("Failed") {
                self.theme.error
            } else {
                self.theme.warning
            };
            (mcp_status, color)
        };

        // Left: workspace path
        let left = Paragraph::new(Line::from(Span::styled(
            format!("  {}", self.workspace_display),
            Style::default().fg(self.theme.muted),
        )));
        frame.render_widget(left, area);

        // Right: deployment/MCP status | version
        let right = Paragraph::new(Line::from(vec![
            Span::styled(&runtime_status, Style::default().fg(runtime_color)),
            Span::styled(
                format!(" | {}  ", version),
                Style::default().fg(self.theme.muted),
            ),
        ]))
        .alignment(Alignment::Right);
        frame.render_widget(right, area);
    }

    fn render_logo(&self, frame: &mut Frame, area: Rect) {
        let use_fancy_logo = area.width >= 80;
        let mut lines = vec![];
        lines.push(Line::from(""));

        if use_fancy_logo {
            let colors = [
                self.theme.primary,
                self.theme.info,
                self.theme.success,
                self.theme.warning,
                self.theme.error,
                self.theme.muted,
            ];

            append_styled_logo_lines(&mut lines, &FANCY_LOGO, &colors);
        } else {
            let colors = [
                self.theme.primary,
                self.theme.info,
                self.theme.success,
                self.theme.warning,
                self.theme.error,
            ];

            append_styled_logo_lines(&mut lines, &COMPACT_LOGO, &colors);
        }

        lines.push(Line::from(""));
        lines.push(Line::from(Span::styled(
            "AI agent-driven command-line programming assistant",
            Style::default()
                .fg(self.theme.muted)
                .add_modifier(Modifier::ITALIC),
        )));

        let version = format!("v{}", env!("CARGO_PKG_VERSION"));
        lines.push(Line::from(Span::styled(
            version,
            Style::default().fg(self.theme.muted),
        )));

        let paragraph = Paragraph::new(lines).alignment(Alignment::Center);
        frame.render_widget(paragraph, area);
    }

    // ======================== Input handling ========================

    fn handle_key(&mut self, key: KeyEvent) -> Option<StartupResult> {
        if key.kind != KeyEventKind::Press {
            return None;
        }

        // Clear transient status on any key press
        self.status = None;

        let modal_state = self.action_state(self.info_popup.is_some() || self.any_popup_visible());
        if let Some(action) = self.keymap.resolve_modal_safe(key, modal_state) {
            return self.dispatch_action(action, modal_state);
        }

        // ── Info popup intercepts all keys ──
        if self.info_popup.is_some() {
            self.info_popup = None;
            return None;
        }

        // Host recovery keys win over configured actions while a popup is open.
        if self.any_popup_visible() {
            let state = self.action_state(true);
            if let Some(action) = self.keymap.resolve_reserved(key, state) {
                return self.dispatch_action(action, state);
            }
        }

        // ── Selector popups intercept all keys when active ──

        if self.theme_selector.is_visible() {
            match key.code {
                KeyCode::Up => {
                    self.theme_selector.move_up();
                    if let Some(selected) = self.theme_selector.selected_item().cloned() {
                        self.preview_theme_selection(&selected);
                    }
                }
                KeyCode::Down => {
                    self.theme_selector.move_down();
                    if let Some(selected) = self.theme_selector.selected_item().cloned() {
                        self.preview_theme_selection(&selected);
                    }
                }
                KeyCode::Enter => {
                    if let Some(selected) = self.theme_selector.confirm_selection() {
                        self.theme_selector.hide();
                        self.apply_theme_selection(&selected);
                    }
                }
                KeyCode::Esc => self.navigate_back(),
                _ => {}
            }
            return None;
        }

        if self.model_selector.is_visible() {
            match key.code {
                KeyCode::Up => self.model_selector.move_up(),
                KeyCode::Down => self.model_selector.move_down(),
                KeyCode::Enter => {
                    if let Some(selected) = self.model_selector.confirm_selection() {
                        self.model_selector.hide();
                        self.apply_model_selection(&selected);
                    }
                }
                KeyCode::Char('e') => {
                    if let Some(selected) = self.model_selector.confirm_selection() {
                        self.model_selector.hide();
                        self.edit_model(&selected);
                    }
                }
                KeyCode::Esc => self.navigate_back(),
                _ => {}
            }
            return None;
        }

        if self.agent_selector.is_visible() {
            match key.code {
                KeyCode::Up => self.agent_selector.move_up(),
                KeyCode::Down => self.agent_selector.move_down(),
                KeyCode::Enter => {
                    if let Some(action) = self.agent_selector.confirm_selection() {
                        self.handle_agent_selector_action(action);
                    }
                }
                KeyCode::Esc => self.navigate_back(),
                _ => {}
            }
            return None;
        }

        if self.session_selector.is_visible() {
            let action = self.session_selector.handle_key_event(key);
            match action {
                SessionAction::Switch(item) => {
                    return Some(StartupResult::ContinueSession(item.session_id));
                }
                SessionAction::Delete(item) => {
                    self.handle_session_delete(&item);
                }
                SessionAction::Close => {
                    self.navigate_back();
                }
                SessionAction::None => {}
            }
            return None;
        }

        if self.skill_selector.is_visible() {
            match key.code {
                KeyCode::Up => self.skill_selector.move_up(),
                KeyCode::Down => self.skill_selector.move_down(),
                KeyCode::Enter | KeyCode::Char(' ') => {
                    if let Some(action) = self.skill_selector.confirm_selection() {
                        self.handle_skill_selector_action(action);
                    }
                }
                KeyCode::Esc => self.navigate_back(),
                _ => {}
            }
            return None;
        }

        if self.subagent_selector.is_visible() {
            match key.code {
                KeyCode::Up => self.subagent_selector.move_up(),
                KeyCode::Down => self.subagent_selector.move_down(),
                KeyCode::Enter | KeyCode::Char(' ') => {
                    if let Some(action) = self.subagent_selector.confirm_selection() {
                        self.handle_subagent_selector_action(action);
                    }
                }
                KeyCode::Esc => self.navigate_back(),
                _ => {}
            }
            return None;
        }

        if self.provider_selector.is_visible() {
            if let Some(selection) = self.provider_selector.handle_key_event(key) {
                self.handle_provider_selection(selection);
            }
            return None;
        }

        if self.model_config_form.is_visible() {
            let action = self.model_config_form.handle_key_event(key);
            match action {
                ModelFormAction::Save(result) => {
                    if result.editing_model_id.is_some() {
                        self.update_existing_model(result);
                    } else {
                        self.save_new_model(result);
                    }
                }
                ModelFormAction::Cancel => {
                    self.navigate_back();
                    self.status = Some("Model form cancelled".to_string());
                }
                ModelFormAction::None => {}
            }
            return None;
        }

        if self.login_form.is_visible() {
            let action = self.login_form.handle_key_event(key);
            return self.handle_login_form_action(action);
        }

        // ── Command palette intercepts all keys when visible ──

        if self.command_palette.is_visible() {
            let action = self.command_palette.handle_key_event(key);
            match action {
                PaletteAction::Execute(id) => {
                    return self.handle_palette_action(&id);
                }
                PaletteAction::Dismiss => {
                    self.navigate_back();
                }
                PaletteAction::None => {}
            }
            return None;
        }

        // ── Command menu navigation ──

        if self.command_menu.is_visible() {
            match key.code {
                KeyCode::Up => {
                    self.command_menu.move_up();
                    return None;
                }
                KeyCode::Down => {
                    self.command_menu.move_down();
                    return None;
                }
                _ => {
                    // Fall through to normal input handling, which updates the menu
                }
            }
        }

        // ── Normal key handling ──

        if let Some(action) = self.keymap.resolve(key, self.action_state(false)) {
            return self.dispatch_action(action, self.action_state(false));
        }

        match (key.code, key.modifiers) {
            (KeyCode::Esc, _) => {
                if !self.text_input.is_empty() {
                    self.clear_composer();
                    self.refresh_command_menu();
                }
            }
            (KeyCode::Up, KeyModifiers::NONE) => {
                if !self.text_input.move_cursor_up() {
                    self.text_input.set_cursor_home();
                }
                self.snap_cursor_out_of_image();
                self.refresh_command_menu();
            }
            (KeyCode::Down, KeyModifiers::NONE) => {
                if !self.text_input.move_cursor_down() {
                    self.text_input.set_cursor_end();
                }
                self.snap_cursor_out_of_image();
                self.refresh_command_menu();
            }
            (KeyCode::Char(c), _) => {
                self.handle_composer_char(c);
            }
            (KeyCode::Backspace, _) => {
                self.handle_composer_backspace();
            }
            (KeyCode::Delete, _) => {
                self.handle_composer_delete();
            }
            (KeyCode::Left, _) => {
                self.text_input.cursor = self.draft_snapshot().cursor_left(self.text_input.cursor);
            }
            (KeyCode::Right, _) => {
                self.text_input.cursor = self.draft_snapshot().cursor_right(self.text_input.cursor);
            }
            (KeyCode::Home, _) => {
                self.text_input.set_cursor_home();
            }
            (KeyCode::End, _) => {
                self.text_input.set_cursor_end();
            }
            _ => {}
        }
        None
    }

    // ======================== Palette action execution ========================

    fn handle_palette_action(&mut self, action_id: &str) -> Option<StartupResult> {
        let Some(action) = action_by_id(action_id, ActionContext::Startup) else {
            self.status = Some(format!("Unknown palette action: {action_id}"));
            return None;
        };
        self.dispatch_action(action, self.action_state(false))
    }

    fn dispatch_action(
        &mut self,
        action: &'static ActionSpec,
        state: ActionState,
    ) -> Option<StartupResult> {
        if !action.available(state) {
            self.status = Some(action.unavailable_message(state));
            return None;
        }
        match action.handler {
            ActionHandler::Help => {
                let mut help = self.keymap.help_text(self.action_state(false));
                if self.agent.is_shared() {
                    help.push_str("\n\n");
                    help.push_str(SHARED_TUI_HELP_NOTE);
                }
                self.info_popup = Some(help);
            }
            ActionHandler::Exit => return Some(StartupResult::Exit),
            ActionHandler::NewSession => {
                return Some(StartupResult::NewSession { prompt: None });
            }
            ActionHandler::Sessions => self.show_session_selector(),
            ActionHandler::SelectModel => self.show_model_selector(),
            ActionHandler::SelectTheme => self.show_theme_selector(),
            ActionHandler::AddModel => {
                let catalog = tokio::task::block_in_place(|| {
                    tokio::runtime::Handle::current().block_on(async {
                        let catalog = openbitfun_core::get_ai_model_catalog()
                            .await
                            .map_err(anyhow::Error::msg)?;
                        Ok::<_, anyhow::Error>(model_catalog_projection(catalog))
                    })
                });
                match catalog {
                    Ok(catalog) => {
                        self.push_current_popup_to_stack();
                        self.provider_selector.show(catalog.provider_catalog);
                    }
                    Err(error) => {
                        self.status = Some(format!("Failed to load model providers: {error}"));
                    }
                }
            }
            ActionHandler::OpenAgentSelector => self.show_agent_selector(),
            ActionHandler::SwitchAgent => self.cycle_agent(1),
            ActionHandler::SwitchAgentReverse => self.cycle_agent(-1),
            ActionHandler::Skills => self.show_skill_selector(),
            ActionHandler::McpServers => {
                return Some(StartupResult::NewSession {
                    prompt: Some(ComposerDraft::from_text("/mcp")),
                });
            }
            ActionHandler::AcpHelp => {
                return Some(StartupResult::NewSession {
                    prompt: Some(ComposerDraft::from_text("/acp")),
                });
            }
            ActionHandler::Login => self.show_login_form(),
            ActionHandler::Logout => self.logout(),
            ActionHandler::Usage => {
                self.status = Some("No active session for /usage.".to_string());
            }
            ActionHandler::Init => match crate::prompts::get_cli_prompt("init") {
                Some(prompt) => {
                    return Some(StartupResult::NewSession {
                        prompt: Some(ComposerDraft::from_text(prompt)),
                    });
                }
                None => self.status = Some("Init prompt not found".to_string()),
            },
            ActionHandler::OpenPalette => {
                self.push_current_popup_to_stack();
                self.command_palette.show(self.action_state(false));
            }
            ActionHandler::SubmitInput => return self.submit_input(),
            ActionHandler::InsertNewline => {
                self.handle_composer_newline();
            }
            ActionHandler::Paste => self.paste_clipboard(),
            ActionHandler::ClosePopups => self.close_all_popups(),
            ActionHandler::NavigateBack => self.navigate_back(),
            ActionHandler::RenameSession
            | ActionHandler::ViewSubagents
            | ActionHandler::Timeline
            | ActionHandler::ForkSession
            | ActionHandler::UndoSession
            | ActionHandler::RedoSession
            | ActionHandler::Reload
            | ActionHandler::Tools
            | ActionHandler::Extensions
            | ActionHandler::NativeHooks
            | ActionHandler::ExternalHooks
            | ActionHandler::Status
            | ActionHandler::WorkspaceDiff
            | ActionHandler::CompactSession
            | ActionHandler::Editor
            | ActionHandler::PromptStash
            | ActionHandler::PromptStashPop
            | ActionHandler::PromptStashList
            | ActionHandler::ToggleTimestamps
            | ActionHandler::ToggleThinking
            | ActionHandler::ToggleToolDetails
            | ActionHandler::CopyTranscript
            | ActionHandler::ExportTranscript
            | ActionHandler::ToggleAutoApprove
            | ActionHandler::ToggleWorktree
            | ActionHandler::Interrupt
            | ActionHandler::ToggleFocusedTool
            | ActionHandler::PreviousTool
            | ActionHandler::NextTool
            | ActionHandler::HistoryPrevious
            | ActionHandler::HistoryNext
            | ActionHandler::JumpTop
            | ActionHandler::JumpBottom
            | ActionHandler::ClearInput
            | ActionHandler::ToggleBrowse
            | ActionHandler::ScrollUp
            | ActionHandler::ScrollDown => {
                self.status = Some("Action is unavailable on the startup page.".to_string());
            }
        }
        None
    }

    fn draft_snapshot(&self) -> ComposerDraft {
        ComposerDraft {
            text: self.text_input.text().to_string(),
            workspace_references: Vec::new(),
            image_attachments: self.image_attachments.clone(),
        }
    }

    fn apply_draft_at_cursor(&mut self, draft: ComposerDraft, cursor: usize) {
        self.text_input.set_text_and_cursor(&draft.text, cursor);
        self.image_attachments = draft.image_attachments;
        self.refresh_command_menu();
    }

    fn clear_composer(&mut self) {
        self.text_input.clear();
        self.image_attachments.clear();
    }

    fn snap_cursor_out_of_image(&mut self) {
        self.text_input.cursor = self
            .draft_snapshot()
            .safe_insertion_cursor(self.text_input.cursor);
    }

    fn reconcile_composer_edit(
        &mut self,
        edit_start: usize,
        removed_chars: usize,
        inserted_chars: usize,
    ) {
        let cursor = self.text_input.cursor;
        let mut draft = self.draft_snapshot();
        draft.reconcile_edit(edit_start, removed_chars, inserted_chars);
        draft.retain_valid_sources();
        self.apply_draft_at_cursor(draft, cursor);
    }

    fn handle_composer_char(&mut self, character: char) {
        self.snap_cursor_out_of_image();
        let cursor = self.text_input.cursor;
        self.text_input.handle_char(character);
        let inserted = self.text_input.cursor.saturating_sub(cursor);
        self.reconcile_composer_edit(cursor, 0, inserted);
    }

    fn handle_composer_newline(&mut self) {
        self.snap_cursor_out_of_image();
        let cursor = self.text_input.cursor;
        self.text_input.handle_newline();
        self.reconcile_composer_edit(cursor, 0, 1);
    }

    fn handle_composer_backspace(&mut self) {
        let cursor = self.text_input.cursor;
        if cursor > 0 {
            let mut draft = self.draft_snapshot();
            if let Some(cursor) = draft.remove_image_overlapping_edit(cursor - 1, 1) {
                self.apply_draft_at_cursor(draft, cursor);
                return;
            }
        }
        self.text_input.handle_backspace();
        if self.text_input.cursor < cursor {
            self.reconcile_composer_edit(cursor - 1, 1, 0);
        } else {
            self.refresh_command_menu();
        }
    }

    fn handle_composer_delete(&mut self) {
        let mut draft = self.draft_snapshot();
        if let Some(cursor) = draft.remove_image_overlapping_edit(self.text_input.cursor, 1) {
            self.apply_draft_at_cursor(draft, cursor);
            return;
        }
        let cursor = self.text_input.cursor;
        let before = self.text_input.text().chars().count();
        self.text_input.handle_delete();
        if self.text_input.text().chars().count() < before {
            self.reconcile_composer_edit(cursor, 1, 0);
        } else {
            self.refresh_command_menu();
        }
    }

    fn paste_clipboard(&mut self) {
        match image_paste::read_clipboard(&self.workspace_path_buf()) {
            Ok(Some(paste)) => self.apply_composer_paste(paste),
            Ok(None) => {}
            Err(error) => self.status = Some(error.to_string()),
        }
    }

    fn paste_terminal_text(&mut self, text: &str) {
        match image_paste::classify_pasted_text(text, &self.workspace_path_buf()) {
            Ok(paste) => self.apply_composer_paste(paste),
            Err(error) => self.status = Some(error.to_string()),
        }
    }

    fn apply_composer_paste(&mut self, paste: ImagePaste) {
        match paste {
            ImagePaste::Text(text) => {
                self.snap_cursor_out_of_image();
                let cursor = self.text_input.cursor;
                self.text_input.insert_paste(&text);
                let inserted = self.text_input.cursor.saturating_sub(cursor);
                self.reconcile_composer_edit(cursor, 0, inserted);
            }
            ImagePaste::Image(_image) if self.agent.is_shared() => {
                self.status = Some(crate::actions::shared_tui_image_attachment_error());
                return;
            }
            ImagePaste::Image(image) => {
                let name = image.name.clone();
                let mut draft = self.draft_snapshot();
                let cursor = draft.safe_insertion_cursor(self.text_input.cursor);
                match draft.insert_image(cursor, image) {
                    Ok(cursor) => self.apply_draft_at_cursor(draft, cursor),
                    Err(error) => {
                        self.status = Some(error.to_string());
                        return;
                    }
                }
                self.status = Some(format!("Attached image: {name}"));
            }
        }
        self.refresh_command_menu();
    }

    fn submit_input(&mut self) -> Option<StartupResult> {
        if !self.image_attachments.is_empty() && self.command_menu.is_visible() {
            self.status = Some(IMAGE_ATTACHMENTS_REQUIRE_MESSAGE.to_string());
            return None;
        }
        if let Some(action_id) = self.command_menu.apply_selection() {
            self.clear_composer();
            self.refresh_command_menu();
            return self.handle_palette_action(&action_id);
        }
        if self.text_input.is_empty() {
            return Some(StartupResult::NewSession { prompt: None });
        }

        let trimmed = self.text_input.text().trim().to_string();
        if trimmed == "exit" || trimmed == "quit" {
            return Some(StartupResult::Exit);
        }
        if trimmed.starts_with('/') {
            if !self.image_attachments.is_empty() {
                self.status = Some(IMAGE_ATTACHMENTS_REQUIRE_MESSAGE.to_string());
                return None;
            }
            return self.handle_command(&trimmed);
        }
        let mut draft = self.draft_snapshot();
        draft.replace_text_from_external_editor(trimmed);
        Some(StartupResult::NewSession {
            prompt: Some(draft),
        })
    }

    fn logout(&mut self) {
        self.status = Some(
            match tokio::task::block_in_place(|| {
                tokio::runtime::Handle::current().block_on(async {
                    let account = self.account_runtime.as_ref().ok_or_else(|| {
                        anyhow::anyhow!("Account management is unavailable for this TUI Host")
                    })?;
                    account.logout().await?;
                    Ok::<(), anyhow::Error>(())
                })
            }) {
                Ok(_) => "Logged out.".to_string(),
                Err(error) => format!("Logout failed: {error}"),
            },
        );
    }

    // ======================== Command execution ========================

    fn handle_command(&mut self, command: &str) -> Option<StartupResult> {
        let cmd = command.split_whitespace().next().unwrap_or("");

        self.clear_composer();
        self.refresh_command_menu();
        let Some(action) = action_for_alias(cmd, ActionContext::Startup) else {
            self.status = Some(
                removed_management_command_hint(cmd, ActionContext::Startup)
                    .map(str::to_string)
                    .unwrap_or_else(|| {
                        format!("Unknown command: {cmd}. Type /help for available commands.")
                    }),
            );
            return None;
        };
        self.dispatch_action(action, self.action_state(false))
    }

    // ======================== Selectors ========================

    /// Push the currently visible popup onto the navigation stack and hide it
    fn push_current_popup_to_stack(&mut self) {
        if self.command_palette.is_visible() {
            self.popup_stack.push(PopupType::CommandPalette);
            self.command_palette.hide();
        } else if self.model_selector.is_visible() {
            self.popup_stack.push(PopupType::ModelSelector);
            self.model_selector.hide();
        } else if self.agent_selector.is_visible() {
            self.popup_stack.push(PopupType::AgentSelector);
            self.agent_selector.hide();
        } else if self.session_selector.is_visible() {
            self.popup_stack.push(PopupType::SessionSelector);
            self.session_selector.hide();
        } else if self.skill_selector.is_visible() {
            self.popup_stack.push(PopupType::SkillSelector);
            self.skill_selector.hide();
        } else if self.subagent_selector.is_visible() {
            self.popup_stack.push(PopupType::SubagentSelector);
            self.subagent_selector.hide();
        } else if self.theme_selector.is_visible() {
            self.popup_stack.push(PopupType::ThemeSelector);
            self.theme_selector.hide();
        } else if self.provider_selector.is_visible() {
            self.popup_stack.push(PopupType::ProviderSelector);
            self.provider_selector.hide();
        } else if self.model_config_form.is_visible() {
            self.popup_stack.push(PopupType::ModelConfigForm);
            self.model_config_form.hide();
        } else if self.login_form.is_visible() {
            self.popup_stack.push(PopupType::LoginForm);
            self.login_form.hide();
        }
    }

    fn show_login_form(&mut self) {
        self.close_all_popups();
        let logged_in = tokio::task::block_in_place(|| {
            tokio::runtime::Handle::current().block_on(async {
                let account = self.account_runtime.as_ref().ok_or_else(|| {
                    anyhow::anyhow!("Account management is unavailable for this TUI Host")
                })?;
                Ok::<_, anyhow::Error>(account_snapshot_projection(account.snapshot().await))
            })
        });
        match logged_in {
            Ok(snapshot) if snapshot.logged_in => self.open_account_panel(snapshot),
            Ok(_) => self.login_form.show(),
            Err(error) => {
                self.login_form.show();
                self.login_form
                    .set_error(format!("Failed to load account: {error}"));
            }
        }
    }

    fn open_account_panel(
        &mut self,
        snapshot: openbitfun_product_domains::account::AccountSnapshotProjection,
    ) {
        let Some(info) = snapshot.info else {
            self.login_form.show();
            return;
        };
        self.login_form.show_account(info, snapshot.devices);
    }

    fn handle_login_form_action(&mut self, action: LoginFormAction) -> Option<StartupResult> {
        match action {
            LoginFormAction::Submit(transaction_id) => {
                let result = tokio::task::block_in_place(|| {
                    tokio::runtime::Handle::current().block_on(async {
                        let account = self.account_runtime.as_ref().ok_or_else(|| {
                            anyhow::anyhow!("Account management is unavailable for this TUI Host")
                        })?;
                        account.advance_github_login(transaction_id).await
                    })
                });
                use openbitfun_core::service::remote_connect::account_runtime::AccountLoginProgress;
                match result {
                    Ok(AccountLoginProgress::Authorization(authorization)) => {
                        self.login_form.set_authorization(authorization)
                    }
                    Ok(AccountLoginProgress::Waiting) => self.login_form.set_status(
                        "Waiting for sign-in. Complete it in your browser, then press Enter.",
                    ),
                    Ok(AccountLoginProgress::Complete(login)) => {
                        self.status = Some(account_login_status_message(&login));
                        self.show_login_form();
                    }
                    Err(error) => self.login_form.set_error(format!("Login failed: {error}")),
                }
            }
            LoginFormAction::Logout => {
                match tokio::task::block_in_place(|| {
                    tokio::runtime::Handle::current().block_on(async {
                        let account = self.account_runtime.as_ref().ok_or_else(|| {
                            anyhow::anyhow!("Account management is unavailable for this TUI Host")
                        })?;
                        account.logout().await?;
                        Ok::<_, anyhow::Error>(account_snapshot_projection(
                            account.snapshot().await,
                        ))
                    })
                }) {
                    Ok(_) => {
                        self.login_form.show();
                        self.status = Some("Logged out.".to_string());
                    }
                    Err(e) => {
                        self.login_form.set_error(format!("Logout failed: {e}"));
                    }
                }
            }
            LoginFormAction::Cancel => {
                self.status = Some("Account panel closed".to_string());
            }
            LoginFormAction::None => {}
        }
        None
    }

    fn show_session_selector(&mut self) {
        self.push_current_popup_to_stack();
        let agent = Arc::clone(&self.agent);
        let sessions = tokio::task::block_in_place(|| {
            tokio::runtime::Handle::current().block_on(agent.list_sessions())
        });
        let sessions = match sessions {
            Ok(sessions) => sessions,
            Err(error) => {
                tracing::error!("Failed to list sessions: {error}");
                self.status = Some(format!("Failed to load sessions: {error}"));
                return;
            }
        };

        if sessions.is_empty() {
            self.status = Some("No sessions found.".to_string());
            return;
        }

        let session_items: Vec<SessionItem> = sessions
            .into_iter()
            .map(|s| {
                let last_activity = {
                    let last_activity =
                        std::time::UNIX_EPOCH + Duration::from_millis(s.last_active_at_ms);
                    let elapsed = last_activity.elapsed().unwrap_or_default();
                    if elapsed.as_secs() < 60 {
                        "just now".to_string()
                    } else if elapsed.as_secs() < 3600 {
                        format!("{}m ago", elapsed.as_secs() / 60)
                    } else if elapsed.as_secs() < 86400 {
                        format!("{}h ago", elapsed.as_secs() / 3600)
                    } else {
                        format!("{}d ago", elapsed.as_secs() / 86400)
                    }
                };
                SessionItem {
                    session_id: s.session_id,
                    session_name: s.session_name,
                    last_activity,
                    workspace: Some(self.workspace_display.clone()),
                }
            })
            .collect();

        self.session_selector.show(session_items, None, true);
    }

    fn handle_session_delete(&mut self, item: &SessionItem) {
        let agent = Arc::clone(&self.agent);
        let sid = item.session_id.clone();

        let result = tokio::task::block_in_place(|| {
            tokio::runtime::Handle::current().block_on(async { agent.delete_session(&sid).await })
        });

        match result {
            Ok(()) => {
                self.session_selector.remove_item(&item.session_id);
                self.status = Some(format!("Session deleted: {}", item.session_name));
            }
            Err(e) => {
                self.status = Some(format!("Failed to delete session: {}", e));
            }
        }
    }

    fn show_model_selector(&mut self) {
        self.push_current_popup_to_stack();
        let profile_model_id = self.selected_agent_mode().and_then(|mode| mode.model_id);
        let explicitly_selected_model_id = self.selected_model_id.clone();

        let result = tokio::task::block_in_place(|| {
            tokio::runtime::Handle::current().block_on(async {
                let config_service = openbitfun_core::service::config::get_global_config_service()
                    .await
                    .ok()?;
                let models = config_service.get_ai_models().await.ok()?;
                let config = config_service.get_config(None).await.ok()?;
                let catalog = model_list_projection(&models, &config);
                let current_model_id = resolve_startup_model_id(
                    explicitly_selected_model_id,
                    profile_model_id,
                    catalog.mode_default_model_id.clone(),
                );
                let model_items: Vec<ModelItem> = catalog
                    .models
                    .into_iter()
                    .filter(|model| model.enabled)
                    .map(|model| ModelItem {
                        id: model.id,
                        name: model.name,
                        provider: model.provider,
                        model_name: model.model_name,
                    })
                    .collect();

                Some((model_items, current_model_id))
            })
        });

        match result {
            Some((models, current_id)) if !models.is_empty() => {
                self.model_selector.show(models, current_id, true, false);
            }
            _ => {
                self.status = Some("No available models found.".to_string());
            }
        }
    }

    fn apply_model_selection(&mut self, selected: &ModelItem) {
        let selected_id = selected.id.clone();
        let selected_display_name = format!("{} / {}", selected.model_name, selected.name);
        let selected_agent_mode = self.selected_agent_mode();
        let persist_shared_default =
            should_persist_shared_model_default(selected_agent_mode.as_ref());

        let success = tokio::task::block_in_place(|| {
            tokio::runtime::Handle::current().block_on(async {
                if !persist_shared_default {
                    return true;
                }
                let config_service =
                    match openbitfun_core::service::config::get_global_config_service().await {
                        Ok(service) => service,
                        Err(error) => {
                            tracing::error!("Failed to load model configuration: {error}");
                            return false;
                        }
                    };
                if let Err(error) = config_service
                    .set_config("ai.agent_model_defaults.mode", &selected_id)
                    .await
                {
                    tracing::error!("Failed to set future mode model: {error}");
                    return false;
                }

                true
            })
        });

        if success {
            self.selected_model_id = Some(selected_id);
            self.model_display_name = selected_display_name.clone();
            self.status = Some(format!("Model switched to: {}", selected_display_name));
            if persist_shared_default {
                let _ = tokio::task::block_in_place(|| {
                    tokio::runtime::Handle::current().block_on(async {
                        let Some(account) = self.account_runtime.as_ref() else {
                            return Ok(());
                        };
                        Ok::<_, anyhow::Error>(())
                    })
                });
            }
        } else {
            self.status = Some("Failed to switch model".to_string());
        }
    }

    /// Handle provider selection result (step 1 → step 2 of add model)
    fn handle_provider_selection(&mut self, selection: ProviderSelection) {
        match selection {
            ProviderSelection::Provider(template) => {
                let default_model = template.models.first().cloned().unwrap_or_default();
                self.model_config_form.show_from_provider(
                    &template.name,
                    &template.base_url,
                    &template.format,
                    &default_model,
                );
            }
            ProviderSelection::Custom => {
                self.model_config_form.show_custom();
            }
        }
    }

    /// Save new model to global config
    fn save_new_model(&mut self, result: ModelFormResult) {
        let model_id = format!(
            "model_{}",
            std::time::SystemTime::now()
                .duration_since(std::time::UNIX_EPOCH)
                .unwrap_or_default()
                .as_millis()
        );

        let result_name = result.name.clone();
        let result_model_display = format!("{} / {}", result.model_name, result.name);
        let mutation = result.to_mutation(model_id.clone());

        let success = tokio::task::block_in_place(|| {
            tokio::runtime::Handle::current()
                .block_on(async {
                    let config_service =
                        openbitfun_core::service::config::get_global_config_service().await?;
                    let model = model_from_mutation(mutation, None)?;
                    config_service
                        .add_ai_model(model)
                        .await
                        .map_err(anyhow::Error::msg)
                })
                .map_err(|error| tracing::error!("Failed to add AI model: {error}"))
                .is_ok()
        });

        if success {
            self.model_display_name = result_model_display;
            self.status = Some(format!("Model added: {}", result_name));
            tracing::info!("Added new AI model: {}", model_id);
            let _ = tokio::task::block_in_place(|| {
                tokio::runtime::Handle::current().block_on(async {
                    if let Some(account) = self.account_runtime.as_ref() {}
                    Ok::<_, anyhow::Error>(())
                })
            });
            // Reload model name display
            self.load_current_model_name();
        } else {
            self.status = Some("Failed to add model".to_string());
        }
    }

    /// Fetch full model config and open the edit form
    fn edit_model(&mut self, selected: &ModelItem) {
        let model_id = selected.id.clone();
        let result = tokio::task::block_in_place(|| {
            tokio::runtime::Handle::current().block_on(async {
                let config_service =
                    openbitfun_core::service::config::get_global_config_service().await?;
                let model = config_service
                    .get_ai_models()
                    .await
                    .map_err(anyhow::Error::msg)?
                    .into_iter()
                    .find(|model| model.id == model_id)
                    .ok_or_else(|| anyhow!("AI model '{model_id}' was not found"))?;
                Ok::<_, anyhow::Error>(model_edit_projection(&model))
            })
        });

        match result {
            Ok(projection) => {
                let form_data = ModelFormResult::from_projection(projection);
                self.model_config_form.show_for_edit(&model_id, &form_data);
            }
            Err(error) => {
                self.status = Some(format!("Failed to load model configuration: {error}"));
            }
        }
    }

    /// Update an existing model in global config
    fn update_existing_model(&mut self, result: ModelFormResult) {
        let model_id = match &result.editing_model_id {
            Some(id) => id.clone(),
            None => return,
        };

        let result_name = result.name.clone();
        let result_model_display = format!("{} / {}", result.model_name, result.name);
        let mutation = result.to_mutation(model_id.clone());

        let success = tokio::task::block_in_place(|| {
            tokio::runtime::Handle::current()
                .block_on(async {
                    if mutation.id != model_id {
                        anyhow::bail!("Model update identity does not match the request target")
                    }
                    let config_service =
                        openbitfun_core::service::config::get_global_config_service().await?;
                    let existing = config_service
                        .get_ai_models()
                        .await
                        .map_err(anyhow::Error::msg)?
                        .into_iter()
                        .find(|model| model.id == model_id)
                        .ok_or_else(|| anyhow!("AI model '{model_id}' was not found"))?;
                    let model = model_from_mutation(mutation, Some(existing))?;
                    config_service
                        .update_ai_model(&model_id, model)
                        .await
                        .map_err(anyhow::Error::msg)
                })
                .map_err(|error| tracing::error!("Failed to update AI model: {error}"))
                .is_ok()
        });

        if success {
            self.model_display_name = result_model_display;
            self.status = Some(format!("Model updated: {}", result_name));
            tracing::info!("Updated AI model: {}", model_id);
            let _ = tokio::task::block_in_place(|| {
                tokio::runtime::Handle::current().block_on(async {
                    if let Some(account) = self.account_runtime.as_ref() {}
                    Ok::<_, anyhow::Error>(())
                })
            });
            self.load_current_model_name();
        } else {
            self.status = Some("Failed to update model".to_string());
        }
    }

    fn show_agent_selector(&mut self) {
        let modes = self.get_mode_agents();
        if modes.is_empty() {
            let message = if self.agent.is_shared() {
                "Main agent modes are unavailable."
            } else {
                "Main agent modes are unavailable; agent management remains available."
            };
            self.status = Some(message.to_string());
            if self.agent.is_shared() {
                return;
            }
        }

        self.push_current_popup_to_stack();

        let agent_items: Vec<AgentItem> = modes
            .into_iter()
            .map(|m| AgentItem {
                id: m.id,
                route_key: (!m.route_key.is_empty()).then_some(m.route_key),
                description: m.description,
            })
            .collect();

        self.agent_selector
            .show(agent_items, Some(self.agent_type.clone()), false, true);
    }

    fn handle_agent_selector_action(&mut self, action: AgentSelectorAction) {
        match action {
            AgentSelectorAction::SwitchMode(selected) => {
                self.agent_selector.hide();
                self.apply_agent_selection(&selected);
            }
            AgentSelectorAction::ManageSubagents => self.show_subagent_selector(),
            AgentSelectorAction::ReviewExternalSources => {
                self.status = Some(
                    "External agent sources are available after starting a session.".to_string(),
                );
            }
        }
    }

    fn apply_agent_selection(&mut self, selected: &AgentItem) {
        if selected.id != self.agent_type {
            self.agent_type = selected.id.clone();
            self.status = Some(format!("Agent switched to: {}", selected.id));
            // Reload model name for new agent
            self.load_current_model_name();
        }
    }

    fn show_theme_selector(&mut self) {
        let themes = self.list_available_themes();
        if themes.is_empty() {
            self.status = Some("No themes available.".to_string());
            return;
        }

        self.push_current_popup_to_stack();
        self.begin_theme_preview();
        self.theme_selector
            .show(themes, Some(self.config.ui.theme_id.clone()));
        if let Some(selected) = self.theme_selector.selected_item().cloned() {
            self.preview_theme_selection(&selected);
        }
    }

    fn list_available_themes(&self) -> Vec<ThemeItem> {
        let mut themes: Vec<ThemeItem> = builtin_theme_ids()
            .into_iter()
            .map(|id| ThemeItem { id })
            .collect();

        themes.sort_by_cached_key(|theme| theme.id.to_ascii_lowercase());
        themes.dedup_by(|a, b| a.id == b.id);
        themes
    }

    fn current_base_theme(&self) -> (Theme, Appearance, EffectiveColorScheme) {
        let appearance = resolve_appearance(&self.config.ui.theme);
        let scheme = resolve_effective_color_scheme(&self.config.ui.color_scheme);
        let base_is_light = appearance.is_light();
        let base = match (base_is_light, scheme) {
            (_, EffectiveColorScheme::Monochrome) => Theme::monochrome(),
            (true, EffectiveColorScheme::Ansi16) => Theme::light_ansi16(),
            (true, EffectiveColorScheme::Truecolor) => Theme::light(),
            (false, EffectiveColorScheme::Ansi16) => Theme::dark_ansi16(),
            (false, EffectiveColorScheme::Truecolor) => Theme::dark(),
        };

        (base, appearance, scheme)
    }

    fn resolve_theme_by_id(
        &self,
        base: Theme,
        appearance: Appearance,
        scheme: EffectiveColorScheme,
        id: &str,
    ) -> Theme {
        if scheme == EffectiveColorScheme::Monochrome {
            return Theme::monochrome();
        }

        let id = id.trim();
        if id.is_empty() {
            return base;
        }

        if let Some(json) = builtin_theme_json(id) {
            return base
                .apply_opencode_theme_json(json, appearance)
                .unwrap_or(base)
                .with_effective_scheme(scheme);
        }

        base
    }

    fn begin_theme_preview(&mut self) {
        if self.theme_preview_original.is_none() {
            self.theme_preview_original = Some(self.theme.clone());
        }
    }

    fn cancel_theme_preview(&mut self) {
        if let Some(original) = self.theme_preview_original.take() {
            self.theme = original;
        }
    }

    fn preview_theme_selection(&mut self, theme: &ThemeItem) {
        self.begin_theme_preview();
        let (base, appearance, scheme) = self.current_base_theme();
        self.theme = self.resolve_theme_by_id(base, appearance, scheme, &theme.id);
        self.status = Some(format!(
            "Preview theme: {} (Enter apply, Esc cancel)",
            theme.id
        ));
    }

    fn apply_theme_selection(&mut self, theme: &ThemeItem) {
        let (base, appearance, scheme) = self.current_base_theme();
        match self
            .config
            .update(|config| config.ui.theme_id = theme.id.clone())
        {
            Ok(()) => {
                self.status = Some(format!("Theme set to: {}", theme.id));
            }
            Err(e) => {
                self.status = Some(format!("Failed to save config: {}", e));
            }
        }

        self.theme = self.resolve_theme_by_id(base, appearance, scheme, &theme.id);
        self.theme_preview_original = None;
    }

    fn show_skill_selector(&mut self) {
        self.push_current_popup_to_stack();
        self.skill_selector.show_menu();
    }

    fn show_available_skill_list(&mut self) {
        let skills = tokio::task::block_in_place(|| {
            tokio::runtime::Handle::current().block_on(async {
                if self.agent.is_remote_workspace() {
                    anyhow::bail!("Skill management is unavailable for a Remote workspace")
                }
                let workspace_id = self
                    .agent
                    .workspace_id()
                    .ok_or_else(|| anyhow::anyhow!("Workspace ID is unavailable"))?;
                let workspace =
                    openbitfun_core::agentic::workspace::WorkspaceBinding::resolve(&workspace_id)
                        .await?;
                let values =
                    openbitfun_core::agentic::tools::implementations::skills::get_skill_registry()
                        .get_user_invocable_skills_for_workspace(
                            Some(&workspace),
                            Some(&self.agent_type),
                        )
                        .await;
                Ok::<_, anyhow::Error>(
                    values
                        .into_iter()
                        .map(startup_skill_summary)
                        .collect::<Vec<_>>(),
                )
            })
        });
        let skills = match skills {
            Ok(skills) => skills,
            Err(error) => {
                self.status = Some(format!("Could not load skills: {error}"));
                return;
            }
        };

        if skills.is_empty() {
            self.status = Some(format!(
                "No user-invocable skills found for agent mode '{}'.",
                self.agent_type
            ));
            return;
        }

        let skill_items: Vec<SkillItem> = skills
            .into_iter()
            .map(Self::skill_item_from_summary)
            .collect();

        if skill_items.is_empty() {
            self.status = Some("No skills found.".to_string());
            return;
        }

        self.skill_selector.show_list(skill_items);
    }

    fn show_skill_config_selector(&mut self) {
        let skills = tokio::task::block_in_place(|| {
            tokio::runtime::Handle::current().block_on(async {
                if self.agent.is_remote_workspace() {
                    anyhow::bail!("Skill management is unavailable for a Remote workspace")
                }
                let workspace_id = self
                    .agent
                    .workspace_id()
                    .ok_or_else(|| anyhow::anyhow!("Workspace ID is unavailable"))?;
                let workspace =
                    openbitfun_core::agentic::workspace::WorkspaceBinding::resolve(&workspace_id)
                        .await?;
                let values =
                    openbitfun_core::agentic::tools::implementations::skills::get_skill_registry()
                        .get_mode_skill_infos_for_workspace(
                            openbitfun_core::agentic::tools::implementations::skills::mode_overrides::SkillPolicyWorkspace::from_binding(&workspace),
                            &self.agent_type,
                        )
                        .await;
                Ok::<_, anyhow::Error>(
                    values
                        .into_iter()
                        .map(startup_mode_skill_summary)
                        .collect::<Vec<_>>(),
                )
            })
        });
        let skills = match skills {
            Ok(skills) => skills,
            Err(error) => {
                self.status = Some(format!("Could not load skills: {error}"));
                return;
            }
        };

        let skill_items: Vec<SkillItem> = skills
            .into_iter()
            .map(Self::skill_item_from_summary)
            .collect();

        if skill_items.is_empty() {
            self.status = Some("No skills found.".to_string());
            return;
        }

        self.skill_selector.show_config(skill_items);
    }

    fn handle_skill_selector_action(&mut self, action: SkillSelectorAction) {
        match action {
            SkillSelectorAction::ListSkills => self.show_available_skill_list(),
            SkillSelectorAction::ConfigureSkills => self.show_skill_config_selector(),
            SkillSelectorAction::Execute(selected) => {
                self.skill_selector.hide();
                self.set_input(&selected.invocation_text());
            }
            SkillSelectorAction::Toggle(selected) => {
                self.set_skill_enabled(&selected, !selected.enabled);
                self.show_skill_config_selector();
            }
        }
    }

    fn set_skill_enabled(&mut self, selected: &SkillItem, enabled: bool) {
        let mode_id = self.agent_type.clone();
        let skill = selected.clone();

        let result = tokio::task::block_in_place(|| {
            tokio::runtime::Handle::current().block_on(async {
                if self.agent.is_remote_workspace() {
                    anyhow::bail!("Skill management is unavailable for a Remote workspace")
                }
                let workspace = std::path::PathBuf::from(self.agent.workspace_path_string());
                match skill.level.as_str() {
                    "user" => {
                        openbitfun_core::agentic::tools::implementations::skills::mode_overrides::set_user_mode_skill_state(&mode_id, &skill.key, enabled, skill.default_enabled).await.map_err(anyhow::Error::msg)?;
                    }
                    "project" => {
                        let mut document = openbitfun_core::agentic::tools::implementations::skills::mode_overrides::load_project_mode_skills_document_local(&workspace).await.map_err(anyhow::Error::msg)?;
                        openbitfun_core::agentic::tools::implementations::skills::mode_overrides::set_mode_skill_disabled_in_document(&mut document, &mode_id, &skill.key, !enabled).map_err(anyhow::Error::msg)?;
                        openbitfun_core::agentic::tools::implementations::skills::mode_overrides::save_project_mode_skills_document_local(&workspace, &document).await.map_err(anyhow::Error::msg)?;
                    }
                    level => anyhow::bail!("Unsupported skill level '{level}'"),
                }
                Ok::<_, anyhow::Error>(())
            })
        });

        self.status = Some(match result {
            Ok(_) => format!(
                "Skill '{}' {} for mode '{}'.",
                selected.name,
                if enabled { "enabled" } else { "disabled" },
                self.agent_type
            ),
            Err(error) => format!("Failed to update skill '{}': {}", selected.name, error),
        });
    }

    fn skill_item_from_summary(info: SkillSummary) -> SkillItem {
        SkillItem {
            key: info.key,
            name: info.name,
            description: info.description,
            level: info.level,
            source_slot: info.source_slot.unwrap_or_default(),
            source_label: info.source_label.unwrap_or_default(),
            enabled: info.enabled,
            selected_for_runtime: info.selected_for_runtime,
            default_enabled: info.default_enabled,
            is_shadowed: info.is_shadowed,
            shadowed_by_key: info.shadowed_by_key,
            argument_hint: info.argument_hint,
        }
    }

    fn show_subagent_selector(&mut self) {
        self.push_current_popup_to_stack();
        self.subagent_selector.show_menu();
    }

    fn show_available_subagent_list(&mut self) {
        let subagents = tokio::task::block_in_place(|| {
            tokio::runtime::Handle::current().block_on(async {
                if self.agent.is_remote_workspace() {
                    anyhow::bail!("Subagent management is unavailable for a Remote workspace")
                }
                let workspace_id = self
                    .agent
                    .workspace_id()
                    .ok_or_else(|| anyhow::anyhow!("Workspace ID is unavailable"))?;
                let values = openbitfun_core::agentic::agents::get_agent_registry()
                    .get_subagents_for_query(
                        &openbitfun_core::agentic::agents::SubagentQueryContext {
                            parent_agent_type: Some(&self.agent_type),
                            workspace_id: Some(&workspace_id),
                            list_scope:
                                openbitfun_core::agentic::agents::SubagentListScope::TaskVisible,
                            include_disabled: false,
                            external_sources_supported: true,
                        },
                    )
                    .await;
                Ok::<_, anyhow::Error>(
                    values
                        .into_iter()
                        .map(startup_subagent_summary)
                        .collect::<Vec<_>>(),
                )
            })
        });
        let subagents = match subagents {
            Ok(response) => response,
            Err(error) => {
                self.status = Some(format!("Could not load subagents: {error}"));
                return;
            }
        };

        if subagents.is_empty() {
            self.status = Some(format!(
                "No enabled subagents found for agent mode '{}'.",
                self.agent_type
            ));
            return;
        }

        let subagent_items: Vec<SubagentItem> = subagents
            .into_iter()
            .map(Self::subagent_item_from_summary)
            .collect();

        if subagent_items.is_empty() {
            self.status = Some("No subagents found.".to_string());
            return;
        }

        self.subagent_selector.show_list(subagent_items);
    }

    fn show_subagent_config_selector(&mut self) {
        let subagents = tokio::task::block_in_place(|| {
            tokio::runtime::Handle::current().block_on(async {
                if self.agent.is_remote_workspace() {
                    anyhow::bail!("Subagent management is unavailable for a Remote workspace")
                }
                let workspace_id = self.agent.workspace_id().ok_or_else(|| anyhow::anyhow!("Workspace ID is unavailable"))?;
                let values = openbitfun_core::agentic::agents::get_agent_registry()
                    .get_subagents_for_query(&openbitfun_core::agentic::agents::SubagentQueryContext {
                        parent_agent_type: Some(&self.agent_type),
                        workspace_id: Some(&workspace_id),
                        list_scope:
                            openbitfun_core::agentic::agents::SubagentListScope::RegistryManagement,
                        include_disabled: true,
                        external_sources_supported: true,
                    })
                    .await;
                let has_external = values.iter().any(|info| {
                    info.subagent_source
                        == Some(openbitfun_core::agentic::agents::SubAgentSource::External)
                });
                Ok::<_, anyhow::Error>((
                    values
                        .into_iter()
                        .filter(|info| {
                            info.subagent_source
                                != Some(openbitfun_core::agentic::agents::SubAgentSource::External)
                        })
                        .map(startup_subagent_summary)
                        .collect::<Vec<_>>(),
                    has_external,
                ))
            })
        });
        let (subagents, _has_external) = match subagents {
            Ok(response) => response,
            Err(error) => {
                self.status = Some(format!("Could not load subagents: {error}"));
                return;
            }
        };
        let subagent_items: Vec<SubagentItem> = subagents
            .into_iter()
            .map(Self::subagent_item_from_summary)
            .collect();

        if subagent_items.is_empty() {
            self.status = Some("No subagents found.".to_string());
            return;
        }

        self.subagent_selector.show_config(subagent_items);
    }

    fn handle_subagent_selector_action(&mut self, action: SubagentSelectorAction) {
        match action {
            SubagentSelectorAction::ListSubagents => self.show_available_subagent_list(),
            SubagentSelectorAction::ConfigureSubagents => self.show_subagent_config_selector(),
            SubagentSelectorAction::Launch(selected) => {
                self.subagent_selector.hide();
                self.set_input(&format!(
                    "Launch subagent {} to finish task: ",
                    selected.name
                ));
            }
            SubagentSelectorAction::Toggle(selected) => {
                self.set_subagent_enabled(&selected, !selected.enabled);
                self.show_subagent_config_selector();
            }
        }
    }

    fn set_subagent_enabled(&mut self, selected: &SubagentItem, enabled: bool) {
        let mode_id = self.agent_type.clone();
        let subagent = selected.clone();

        let result = tokio::task::block_in_place(|| {
            tokio::runtime::Handle::current().block_on(async {
                if self.agent.is_remote_workspace() {
                    anyhow::bail!("Subagent management is unavailable for a Remote workspace")
                }
                let workspace_id = self
                    .agent
                    .workspace_id()
                    .ok_or_else(|| anyhow::anyhow!("Workspace ID is unavailable"))?;
                openbitfun_core::agentic::agents::get_agent_registry()
                    .update_subagent_override(&mode_id, &subagent.id, enabled, Some(&workspace_id))
                    .await
                    .map_err(anyhow::Error::msg)
            })
        });

        self.status = Some(match result {
            Ok(_) => format!(
                "Subagent '{}' {} for mode '{}'.",
                selected.name,
                if enabled { "enabled" } else { "disabled" },
                self.agent_type
            ),
            Err(error) => format!("Failed to update subagent '{}': {}", selected.name, error),
        });
    }

    fn subagent_item_from_summary(info: SubagentSummary) -> SubagentItem {
        SubagentItem {
            key: info.key,
            id: info.id,
            name: info.name,
            description: info.description,
            source: info.source,
            enabled: info.enabled,
        }
    }

    // ======================== Helpers ========================

    /// Navigate back to the previous popup in the stack, or close current if at the root
    fn navigate_back(&mut self) {
        // First hide the currently visible popup
        if self.command_palette.is_visible() {
            self.command_palette.hide();
        } else if self.model_selector.is_visible() {
            self.model_selector.hide();
        } else if self.agent_selector.is_visible() {
            self.agent_selector.hide();
        } else if self.session_selector.is_visible() {
            self.session_selector.hide();
        } else if self.skill_selector.is_visible() {
            self.skill_selector.hide();
        } else if self.subagent_selector.is_visible() {
            self.subagent_selector.hide();
        } else if self.theme_selector.is_visible() {
            self.theme_selector.hide();
            self.cancel_theme_preview();
        } else if self.provider_selector.is_visible() {
            self.provider_selector.hide();
        } else if self.model_config_form.is_visible() {
            self.model_config_form.hide();
        } else if self.login_form.is_visible() {
            self.login_form.hide();
        }

        // If there's a previous popup in the stack, re-show it
        if let Some(previous) = self.popup_stack.pop() {
            match previous {
                PopupType::CommandPalette => self.command_palette.reshow(),
                PopupType::ModelSelector => self.model_selector.reshow(),
                PopupType::AgentSelector => self.agent_selector.reshow(),
                PopupType::SessionSelector => self.session_selector.reshow(),
                PopupType::SkillSelector => self.skill_selector.reshow(),
                PopupType::SubagentSelector => self.subagent_selector.reshow(),
                PopupType::ThemeSelector => self.theme_selector.reshow(),
                PopupType::ProviderSelector => self.provider_selector.reshow(),
                PopupType::ModelConfigForm => self.model_config_form.reshow(),
                PopupType::LoginForm => self.login_form.show(),
            }
        }
    }

    /// Close all popups and clear the navigation stack
    fn close_all_popups(&mut self) {
        self.info_popup = None;
        self.command_palette.hide();
        self.model_selector.hide();
        self.agent_selector.hide();
        self.session_selector.hide();
        self.skill_selector.hide();
        self.subagent_selector.hide();
        self.theme_selector.hide();
        self.cancel_theme_preview();
        self.provider_selector.hide();
        self.model_config_form.hide();
        self.login_form.hide();
        self.popup_stack.clear();
    }

    fn get_mode_agents(&self) -> Vec<TuiAgentMode> {
        tokio::task::block_in_place(|| {
            tokio::runtime::Handle::current()
                .block_on(self.agent.available_agent_modes())
                .unwrap_or_else(|error| {
                    tracing::warn!("Failed to load main agent modes: {error}");
                    Vec::new()
                })
        })
    }

    fn selected_agent_mode(&self) -> Option<TuiAgentMode> {
        self.get_mode_agents()
            .into_iter()
            .find(|mode| mode.id == self.agent_type)
    }

    fn cycle_agent(&mut self, offset: isize) {
        let modes = self.get_mode_agents();
        if modes.len() <= 1 {
            return;
        }

        let current_idx = modes
            .iter()
            .position(|m| m.id == self.agent_type)
            .unwrap_or(0);

        let len = modes.len() as isize;
        let next_idx = ((current_idx as isize + offset) % len + len) % len;
        let next = &modes[next_idx as usize];

        self.agent_type = next.id.clone();
        self.load_current_model_name();
    }

    fn load_current_model_name(&mut self) {
        let explicitly_selected_model_id = self.selected_model_id.clone();
        let profile_model_id = self.selected_agent_mode().and_then(|mode| mode.model_id);
        let result: Option<String> = tokio::task::block_in_place(|| {
            tokio::runtime::Handle::current().block_on(async {
                let config_service = openbitfun_core::service::config::get_global_config_service()
                    .await
                    .ok()?;
                let models = config_service.get_ai_models().await.ok()?;
                let config = config_service.get_config(None).await.ok()?;
                let catalog = model_list_projection(&models, &config);
                let model_id = resolve_startup_model_id(
                    explicitly_selected_model_id,
                    profile_model_id,
                    catalog.mode_default_model_id.clone(),
                )?;
                catalog
                    .models
                    .iter()
                    .find(|model| model.id == model_id)
                    .map(crate::model_selection::tui_model_display_name)
            })
        });

        self.model_display_name = result.unwrap_or_default();
    }

    fn set_input(&mut self, text: &str) {
        self.text_input.set_text(text);
        self.refresh_command_menu();
    }

    fn refresh_command_menu(&mut self) {
        self.command_menu
            .update(&self.text_input.input, self.text_input.cursor);
    }
}

fn startup_skill_summary(
    info: openbitfun_core::agentic::tools::implementations::skills::SkillInfo,
) -> SkillSummary {
    SkillSummary {
        key: info.key,
        name: info.name,
        description: info.description,
        level: info.level.as_str().to_string(),
        source_slot: Some(info.source_slot),
        source_label: Some(info.source_label),
        enabled: true,
        selected_for_runtime: true,
        default_enabled: true,
        is_shadowed: info.is_shadowed,
        shadowed_by_key: info.shadowed_by_key,
        argument_hint: info.argument_hint,
    }
}

fn startup_mode_skill_summary(
    info: openbitfun_core::agentic::tools::implementations::skills::ModeSkillInfo,
) -> SkillSummary {
    let skill = info.skill;
    SkillSummary {
        key: skill.key,
        name: skill.name,
        description: skill.description,
        level: skill.level.as_str().to_string(),
        source_slot: Some(skill.source_slot),
        source_label: Some(skill.source_label),
        enabled: info.effective_enabled,
        selected_for_runtime: info.selected_for_runtime,
        default_enabled: info.default_enabled,
        is_shadowed: skill.is_shadowed,
        shadowed_by_key: skill.shadowed_by_key,
        argument_hint: skill.argument_hint,
    }
}

fn startup_subagent_summary(info: openbitfun_core::agentic::agents::AgentInfo) -> SubagentSummary {
    SubagentSummary {
        key: info.key,
        id: info.id,
        name: info.name,
        description: info.description,
        source: format!(
            "{:?}",
            info.subagent_source
                .unwrap_or(openbitfun_core::agentic::agents::SubAgentSource::Builtin)
        )
        .to_ascii_lowercase(),
        enabled: info.effective_enabled,
        is_external: info.subagent_source
            == Some(openbitfun_core::agentic::agents::SubAgentSource::External),
        supports_follow_up: info.supports_follow_up,
    }
}

fn resolve_startup_model_id(
    explicitly_selected_model_id: Option<String>,
    profile_model_id: Option<String>,
    default_model_id: Option<String>,
) -> Option<String> {
    explicitly_selected_model_id
        .or(profile_model_id)
        .or(default_model_id)
}

fn should_persist_shared_model_default(mode: Option<&TuiAgentMode>) -> bool {
    mode.is_some_and(|mode| !mode.is_external)
}

#[cfg(test)]
mod logo_contract_tests {
    use super::*;
    use ratatui::style::Color;

    #[test]
    fn explicit_startup_model_overrides_profile_and_default() {
        assert_eq!(
            resolve_startup_model_id(
                Some("explicit".to_string()),
                Some("profile".to_string()),
                Some("default".to_string()),
            )
            .as_deref(),
            Some("explicit")
        );
        assert_eq!(
            resolve_startup_model_id(
                None,
                Some("profile".to_string()),
                Some("default".to_string()),
            )
            .as_deref(),
            Some("profile")
        );
    }

    #[test]
    fn external_or_unknown_startup_modes_do_not_change_the_shared_default() {
        let local = TuiAgentMode {
            id: "Standard".to_string(),
            route_key: "Standard".to_string(),
            description: String::new(),
            model_id: None,
            is_external: false,
        };
        let external = TuiAgentMode {
            id: "reviewer".to_string(),
            route_key: "external::reviewer".to_string(),
            description: String::new(),
            model_id: None,
            is_external: true,
        };

        assert!(should_persist_shared_model_default(Some(&local)));
        assert!(!should_persist_shared_model_default(Some(&external)));
        assert!(!should_persist_shared_model_default(None));
    }

    #[test]
    fn fancy_logo_keeps_line_order_and_color_style_mapping() {
        let expected = [
            "  ██████╗ ██╗████████╗███████╗██╗   ██╗███╗   ██╗",
            "  ██╔══██╗██║╚══██╔══╝██╔════╝██║   ██║████╗  ██║",
            "  ██████╔╝██║   ██║   █████╗  ██║   ██║██╔██╗ ██║",
            "  ██╔══██╗██║   ██║   ██╔══╝  ██║   ██║██║╚██╗██║",
            "  ██████╔╝██║   ██║   ██║     ╚██████╔╝██║ ╚████║",
            "  ╚═════╝ ╚═╝   ╚═╝   ╚═╝      ╚═════╝ ╚═╝  ╚═══╝",
        ];
        let colors = [
            Color::Red,
            Color::Green,
            Color::Blue,
            Color::Yellow,
            Color::Magenta,
            Color::Cyan,
        ];
        let mut rendered = Vec::new();

        append_styled_logo_lines(&mut rendered, &FANCY_LOGO, &colors);

        assert_logo_contract(&rendered, &expected, &colors);
    }

    #[test]
    fn compact_logo_keeps_line_order_and_color_style_mapping() {
        let expected = [
            "  ____  _ _   _____            ",
            " | __ )(_) |_|  ___|   _ _ __  ",
            " |  _ \\| | __| |_ | | | | '_ \\ ",
            " | |_) | | |_|  _|| |_| | | | |",
            " |____/|_|\\__|_|   \\__,_|_| |_|",
        ];
        let colors = [
            Color::Red,
            Color::Green,
            Color::Blue,
            Color::Yellow,
            Color::Magenta,
        ];
        let mut rendered = Vec::new();

        append_styled_logo_lines(&mut rendered, &COMPACT_LOGO, &colors);

        assert_logo_contract(&rendered, &expected, &colors);
    }

    fn assert_logo_contract(lines: &[Line<'_>], expected: &[&str], colors: &[Color]) {
        assert_eq!(lines.len(), expected.len());
        for (index, ((line, expected_text), expected_color)) in
            lines.iter().zip(expected).zip(colors).enumerate()
        {
            assert_eq!(line.spans.len(), 1, "logo line {index} span count");
            let span = &line.spans[0];
            assert_eq!(span.content.as_ref(), *expected_text, "logo line {index}");
            assert_eq!(span.style.fg, Some(*expected_color), "logo line {index}");
            assert!(
                span.style.add_modifier.contains(Modifier::BOLD),
                "logo line {index} must stay bold"
            );
        }
    }
}
