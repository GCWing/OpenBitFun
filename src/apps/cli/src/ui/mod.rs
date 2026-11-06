/// TUI interface module
///
/// Build terminal user interface using ratatui
pub(crate) mod agent_selector;
pub(crate) mod chat;
pub(crate) mod command_menu;
pub(crate) mod command_palette;
pub(crate) mod composer;
mod conversation_selector;
mod diff_render;
pub(crate) mod export_dialog;
pub(crate) mod fork_selector;
pub(crate) mod image_paste;
pub(crate) mod input;
pub(crate) mod login_form;
mod markdown;
pub(crate) mod mcp_add_dialog;
pub(crate) mod mcp_selector;
pub(crate) mod message_queue;
mod message_time;
pub(crate) mod model_config_form;
pub(crate) mod model_selector;
pub(crate) mod permission;
pub(crate) mod prompt_command_shell_review;
pub(crate) mod prompt_stash_selector;
pub(crate) mod provider_selector;
pub(crate) mod question;
mod responsive_popup;
pub(crate) mod session_lineage_selector;
pub(crate) mod session_selector;
pub(crate) mod skill_selector;
pub(crate) mod startup;
pub(crate) mod string_utils;
pub(crate) mod subagent_selector;
mod syntax_highlight;
mod text_input;
pub(crate) mod theme;
pub(crate) mod theme_selector;
pub(crate) mod timeline_selector;
mod tool_cards;
mod widgets;
pub(crate) mod workspace_diff;
pub(crate) mod workspace_reference;

use anyhow::Result;
use crossterm::{
    event::{DisableBracketedPaste, DisableMouseCapture, EnableBracketedPaste, EnableMouseCapture},
    execute,
    terminal::{disable_raw_mode, enable_raw_mode, EnterAlternateScreen, LeaveAlternateScreen},
};
use ratatui::{
    backend::CrosstermBackend,
    layout::{Alignment, Constraint, Direction, Layout},
    style::{Color, Modifier, Style},
    text::{Line, Span},
    widgets::Paragraph,
    Terminal,
};
use std::io;
use std::ops::{Deref, DerefMut};

type CliTerminal = Terminal<CrosstermBackend<io::Stdout>>;

pub(crate) struct TerminalGuard {
    terminal: Option<CliTerminal>,
}

impl Deref for TerminalGuard {
    type Target = CliTerminal;

    fn deref(&self) -> &Self::Target {
        self.terminal
            .as_ref()
            .expect("terminal guard must own a terminal")
    }
}

impl DerefMut for TerminalGuard {
    fn deref_mut(&mut self) -> &mut Self::Target {
        self.terminal
            .as_mut()
            .expect("terminal guard must own a terminal")
    }
}

impl TerminalGuard {
    /// Temporarily return the process terminal to normal mode while a blocking
    /// foreground operation (such as an editor) inherits its stdio.
    pub(crate) fn with_restored<T>(&mut self, operation: impl FnOnce() -> T) -> Result<T> {
        let mut terminal = self
            .terminal
            .take()
            .expect("terminal guard must own a terminal");
        restore_terminal_inner(&mut terminal)?;
        drop(terminal);

        let operation_result = operation();

        let mut resumed = init_terminal()?;
        if let Err(error) = resumed.clear() {
            drop(resumed);
            return Err(error.into());
        }
        self.terminal = resumed.terminal.take();
        Ok(operation_result)
    }
}

impl Drop for TerminalGuard {
    fn drop(&mut self) {
        if let Some(mut terminal) = self.terminal.take() {
            let _ = restore_terminal_inner(&mut terminal);
        }
    }
}

/// Initialize terminal
pub(crate) fn init_terminal() -> Result<TerminalGuard> {
    enable_raw_mode()?;
    let mut stdout = io::stdout();
    if let Err(error) = execute!(
        stdout,
        EnterAlternateScreen,
        EnableMouseCapture,
        EnableBracketedPaste
    ) {
        let cleanup = cleanup_partial_terminal(&mut stdout);
        return Err(merge_terminal_failure(error, cleanup));
    }
    let backend = CrosstermBackend::new(stdout);
    let terminal = match Terminal::new(backend) {
        Ok(terminal) => terminal,
        Err(error) => {
            let mut stdout = io::stdout();
            let cleanup = cleanup_partial_terminal(&mut stdout);
            return Err(merge_terminal_failure(error, cleanup));
        }
    };
    Ok(TerminalGuard {
        terminal: Some(terminal),
    })
}

/// Restore terminal
pub(crate) fn restore_terminal(mut guard: TerminalGuard) -> Result<()> {
    let result = guard
        .terminal
        .as_mut()
        .map(restore_terminal_inner)
        .unwrap_or(Ok(()));
    guard.terminal.take();
    result
}

fn restore_terminal_inner(terminal: &mut CliTerminal) -> Result<()> {
    let disable_raw = disable_raw_mode();
    let disable_bracketed_paste = execute!(terminal.backend_mut(), DisableBracketedPaste);
    let disable_mouse_capture = execute!(terminal.backend_mut(), DisableMouseCapture);
    let leave_alternate_screen = execute!(terminal.backend_mut(), LeaveAlternateScreen);
    let show_cursor = terminal.show_cursor();
    finish_terminal_cleanup([
        ("disable raw mode", disable_raw),
        ("disable bracketed paste", disable_bracketed_paste),
        ("disable mouse capture", disable_mouse_capture),
        ("leave alternate screen", leave_alternate_screen),
        ("show terminal cursor", show_cursor),
    ])
}

fn cleanup_partial_terminal(stdout: &mut io::Stdout) -> Result<()> {
    let disable_raw = disable_raw_mode();
    let disable_bracketed_paste = execute!(stdout, DisableBracketedPaste);
    let disable_mouse_capture = execute!(stdout, DisableMouseCapture);
    let leave_alternate_screen = execute!(stdout, LeaveAlternateScreen);
    finish_terminal_cleanup([
        ("disable raw mode", disable_raw),
        ("disable bracketed paste", disable_bracketed_paste),
        ("disable mouse capture", disable_mouse_capture),
        ("leave alternate screen", leave_alternate_screen),
    ])
}

fn finish_terminal_cleanup<const N: usize>(
    results: [(&'static str, std::io::Result<()>); N],
) -> Result<()> {
    let errors = results
        .into_iter()
        .filter_map(|(operation, result)| result.err().map(|error| format!("{operation}: {error}")))
        .collect::<Vec<_>>();
    if errors.is_empty() {
        Ok(())
    } else {
        Err(anyhow::anyhow!(errors.join("; ")))
    }
}

fn merge_terminal_failure(primary: std::io::Error, cleanup: Result<()>) -> anyhow::Error {
    match cleanup {
        Ok(()) => primary.into(),
        Err(cleanup_error) => {
            let context = format!("{primary}; failed to restore the terminal: {cleanup_error}");
            anyhow::Error::new(primary).context(context)
        }
    }
}

/// Render a loading/status message on the terminal (stays in alternate screen)
pub(crate) fn render_loading(
    terminal: &mut Terminal<CrosstermBackend<io::Stdout>>,
    message: &str,
) -> Result<()> {
    let msg = message.to_string();
    terminal.draw(|frame| {
        let area = frame.area();
        let chunks = Layout::default()
            .direction(Direction::Vertical)
            .constraints([
                Constraint::Percentage(45),
                Constraint::Length(3),
                Constraint::Percentage(45),
            ])
            .split(area);

        let text = vec![Line::from(Span::styled(
            msg,
            Style::default()
                .fg(Color::Cyan)
                .add_modifier(Modifier::BOLD),
        ))];

        let paragraph = Paragraph::new(text).alignment(Alignment::Center);
        frame.render_widget(paragraph, chunks[1]);
    })?;
    Ok(())
}

#[cfg(test)]
mod terminal_lifecycle_tests {
    use super::{finish_terminal_cleanup, merge_terminal_failure};

    #[test]
    fn terminal_cleanup_reports_every_failed_step_in_order() {
        let error = finish_terminal_cleanup([
            (
                "disable raw mode",
                Err(std::io::Error::other("raw failure")),
            ),
            (
                "disable bracketed paste",
                Err(std::io::Error::other("paste failure")),
            ),
            ("disable mouse capture", Ok(())),
            (
                "leave alternate screen",
                Err(std::io::Error::other("screen failure")),
            ),
            (
                "show terminal cursor",
                Err(std::io::Error::other("cursor failure")),
            ),
        ])
        .expect_err("cleanup failures must be reported")
        .to_string();

        assert_eq!(
            error,
            "disable raw mode: raw failure; disable bracketed paste: paste failure; leave alternate screen: screen failure; show terminal cursor: cursor failure"
        );
    }

    #[test]
    fn initialization_failure_without_cleanup_error_keeps_primary_io_error() {
        let error = merge_terminal_failure(
            std::io::Error::new(std::io::ErrorKind::NotConnected, "terminal unavailable"),
            Ok(()),
        );

        assert_eq!(
            error
                .downcast_ref::<std::io::Error>()
                .map(std::io::Error::kind),
            Some(std::io::ErrorKind::NotConnected)
        );
    }

    #[test]
    fn initialization_failure_keeps_primary_and_cleanup_diagnostics() {
        let cleanup = finish_terminal_cleanup([(
            "disable raw mode",
            Err(std::io::Error::other("cleanup failure")),
        )]);
        let error = merge_terminal_failure(
            std::io::Error::new(
                std::io::ErrorKind::PermissionDenied,
                "terminal initialization failure",
            ),
            cleanup,
        );
        let message = error.to_string();

        assert!(
            message.contains("terminal initialization failure"),
            "{message}"
        );
        assert!(
            message.contains("disable raw mode: cleanup failure"),
            "{message}"
        );
        assert_eq!(
            error
                .downcast_ref::<std::io::Error>()
                .map(std::io::Error::kind),
            Some(std::io::ErrorKind::PermissionDenied),
            "primary io::Error must remain in the anyhow source chain"
        );
    }
}
