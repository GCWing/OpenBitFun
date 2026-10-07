/// Tool card rendering — InlineTool + BlockTool dual-layer system
///
/// Inspired by opencode TUI's InlineTool/BlockTool pattern:
/// - InlineTool: single-line for simple/exploratory tools (Read, Grep, Glob, LS, etc.)
/// - BlockTool: multi-line with left border for complex tools (Bash, Edit, Write, Task, etc.)
/// - Phase-aware: same tool can switch from Inline (pending) to Block (has output)
use std::collections::HashMap;

use ratatui::{
    style::{Modifier, Style},
    text::{Line, Span},
    widgets::ListItem,
};

use super::diff_render::{self, DiffViewMode};
use super::string_utils::{strip_ansi_codes, truncate_str, wrap_to_display_width};
use super::syntax_highlight::{self, HighlightTheme};
use super::theme::{tool_icon, StyleKind, Theme};
use crate::chat_state::{ToolDisplayState, ToolDisplayStatus};

// ============ Tool Card Render Cache ============

/// Cache key for a tool card render result
#[derive(Hash, Eq, PartialEq, Clone)]
struct ToolCardCacheKey {
    tool_id: String,
    expanded: bool,
    focused: bool,
    width: u16,
}

// Thread-local cache for completed tool card renders.
// Only caches tools in terminal states (Success/Failed/Rejected/Cancelled).
// Cleared when the session changes.
thread_local! {
    static TOOL_CARD_CACHE: std::cell::RefCell<HashMap<ToolCardCacheKey, ToolCardRenderOutput>> =
        std::cell::RefCell::new(HashMap::new());
}

#[derive(Clone)]
pub(super) struct ToolCardRenderOutput {
    pub(super) items: Vec<ListItem<'static>>,
    pub(super) plain_lines: Vec<String>,
}

struct BlockAssembly<'a> {
    title: &'a str,
    content_lines: Vec<Line<'static>>,
    theme: &'a Theme,
    is_running: bool,
    error: Option<&'a str>,
    focused: bool,
    tool_state: &'a ToolDisplayState,
    spinner_frame: &'a str,
    available_width: u16,
}

/// Clear the tool card render cache (call on session switch or /clear)
pub(super) fn clear_tool_card_cache() {
    TOOL_CARD_CACHE.with(|cache| cache.borrow_mut().clear());
}

/// Check if a tool is in a terminal (cacheable) state
fn is_terminal_status(status: &ToolDisplayStatus) -> bool {
    matches!(
        status,
        ToolDisplayStatus::Success
            | ToolDisplayStatus::Failed
            | ToolDisplayStatus::Rejected
            | ToolDisplayStatus::Cancelled
    )
}

// ============ Display Mode ============

/// Tool display mode — determines rendering strategy
#[derive(Debug, Clone, Copy, PartialEq)]
enum ToolDisplayMode {
    /// Single-line: icon + text (Read, Grep, Glob, LS, WebSearch, etc.)
    Inline,
    /// Multi-line with left border (Bash output, Edit diff, Task details, etc.)
    Block,
}

/// Determine display mode based on tool name and current state.
/// Phase-aware: same tool can switch from Inline (pending) to Block (has output).
fn tool_display_mode(tool_name: &str, tool_state: &ToolDisplayState) -> ToolDisplayMode {
    match normalize_tool_name(tool_name) {
        // Always inline tools
        "Read" | "Grep" | "Glob" | "LS" | "WebSearch" | "WebFetch" | "Skill" | "ReadLints"
        | "Git" | "GetFileDiff" | "IdeControl" | "MermaidInteractive" | "ContextCompression"
        | "AnalyzeImage" => ToolDisplayMode::Inline,

        // Phase-aware: Inline when pending, Block when has output/result
        "Bash" => {
            if tool_state.result.is_some()
                || matches!(
                    tool_state.status,
                    ToolDisplayStatus::Running | ToolDisplayStatus::Streaming
                )
            {
                ToolDisplayMode::Block
            } else {
                ToolDisplayMode::Inline
            }
        }
        "HmosCompilation" => {
            if matches!(
                tool_state.status,
                ToolDisplayStatus::Running
                    | ToolDisplayStatus::Streaming
                    | ToolDisplayStatus::Failed
            ) || tool_state.result.is_some()
            {
                ToolDisplayMode::Block
            } else {
                ToolDisplayMode::Inline
            }
        }
        "Edit" | "Write" | "Delete" => {
            if tool_state.result.is_some() {
                ToolDisplayMode::Block
            } else {
                ToolDisplayMode::Inline
            }
        }
        // Agent launches always render as Block — even during early detection / params streaming,
        // we want to show the subagent card with real-time progress rather than inline "Delegating...".
        "Task" | "AgentSpawn" => ToolDisplayMode::Block,

        // Always block tools
        "TodoWrite" | "AskUserQuestion" | "CreatePlan" => ToolDisplayMode::Block,

        // MCP tools: inline when pending, block when has output
        _ if tool_name.starts_with("mcp_") => {
            if tool_state.result.is_some() {
                ToolDisplayMode::Block
            } else {
                ToolDisplayMode::Inline
            }
        }

        // Unknown tools: inline
        _ => ToolDisplayMode::Inline,
    }
}

/// Normalize tool name to canonical form (supports both old and new naming)
fn normalize_tool_name(name: &str) -> &str {
    match name {
        "read_file" | "read_file_tool" => "Read",
        "write_file" | "write_file_tool" => "Write",
        "search_replace" => "Edit",
        "bash_tool" | "run_terminal_cmd" => "Bash",
        "codebase_search" => "Glob",
        "grep" => "Grep",
        "list_dir" | "ls" => "LS",
        other => other,
    }
}

// ============ Public API ============

/// Render a tool card. Returns a list of ListItems for the chat message list.
///
/// Parameters:
/// - `tool_state`: current tool display state
/// - `theme`: UI theme
/// - `expanded`: whether this block tool is expanded (for output truncation)
/// - `focused`: whether this tool card is currently focused (for border highlight)
/// - `spinner_frame`: current spinner animation frame (for running tools)
/// - `available_width`: terminal width available for rendering (for split diff)
pub(super) fn render_tool_card(
    tool_state: &ToolDisplayState,
    theme: &Theme,
    expanded: bool,
    focused: bool,
    spinner_frame: &str,
    available_width: u16,
) -> ToolCardRenderOutput {
    // Check cache for completed tools
    if is_terminal_status(&tool_state.status) {
        let key = ToolCardCacheKey {
            tool_id: tool_state.tool_id.clone(),
            expanded,
            focused,
            width: available_width,
        };
        let cached = TOOL_CARD_CACHE.with(|cache| cache.borrow().get(&key).cloned());
        if let Some(rendered) = cached {
            return rendered;
        }

        // Render and cache
        let rendered = render_tool_card_inner(
            tool_state,
            theme,
            expanded,
            focused,
            spinner_frame,
            available_width,
        );
        let rendered_clone = rendered.clone();
        TOOL_CARD_CACHE.with(|cache| {
            cache.borrow_mut().insert(key, rendered_clone);
        });
        return rendered;
    }

    // Non-terminal tools: render without caching
    render_tool_card_inner(
        tool_state,
        theme,
        expanded,
        focused,
        spinner_frame,
        available_width,
    )
}

/// Internal render function (no caching)
fn render_tool_card_inner(
    tool_state: &ToolDisplayState,
    theme: &Theme,
    expanded: bool,
    focused: bool,
    spinner_frame: &str,
    available_width: u16,
) -> ToolCardRenderOutput {
    let canonical = normalize_tool_name(&tool_state.tool_name);
    let mode = tool_display_mode(&tool_state.tool_name, tool_state);

    let mut items = Vec::new();
    let mut plain_lines = Vec::new();

    // Add a top spacing line to visually separate consecutive tool cards
    items.push(ListItem::new(Line::from(Span::raw("".to_string()))));
    plain_lines.push(String::new());

    match mode {
        ToolDisplayMode::Inline => {
            let rendered = render_inline_dispatch(
                canonical,
                tool_state,
                theme,
                spinner_frame,
                available_width,
            );
            items.extend(rendered.items);
            plain_lines.extend(rendered.plain_lines);
        }
        ToolDisplayMode::Block => {
            let rendered = render_block_dispatch(
                canonical,
                tool_state,
                theme,
                expanded,
                focused,
                spinner_frame,
                available_width,
            );
            items.extend(rendered.items);
            plain_lines.extend(rendered.plain_lines);
        }
    }

    if plain_lines.len() < items.len() {
        plain_lines.resize(items.len(), String::new());
    } else if plain_lines.len() > items.len() {
        plain_lines.truncate(items.len());
    }

    ToolCardRenderOutput { items, plain_lines }
}

// ============ Inline Tool Rendering ============

fn block_content_max_width(available_width: u16) -> usize {
    available_width.saturating_sub(8).max(1) as usize
}

fn wrap_display_lines(text: &str, max_width: usize) -> Vec<String> {
    let mut out = Vec::new();
    for raw in text.lines() {
        let sanitized = raw.replace('\t', "    ");
        out.extend(wrap_to_display_width(&sanitized, max_width));
    }
    if out.is_empty() {
        out.push(String::new());
    }
    out
}

/// Dispatch to the appropriate inline renderer
fn render_inline_dispatch(
    canonical: &str,
    tool_state: &ToolDisplayState,
    theme: &Theme,
    spinner_frame: &str,
    available_width: u16,
) -> ToolCardRenderOutput {
    let icon = tool_icon(&tool_state.tool_name);
    let is_complete = matches!(
        tool_state.status,
        ToolDisplayStatus::Success
            | ToolDisplayStatus::Failed
            | ToolDisplayStatus::Rejected
            | ToolDisplayStatus::Cancelled
    );
    let is_error = matches!(tool_state.status, ToolDisplayStatus::Failed);
    let is_rejected = matches!(tool_state.status, ToolDisplayStatus::Rejected);
    let is_confirmation = matches!(tool_state.status, ToolDisplayStatus::ConfirmationNeeded);

    if !is_complete && !is_confirmation {
        // Pending state: spinner + pending text
        let pending_text = inline_pending_text(canonical, tool_state);
        return ToolCardRenderOutput {
            items: vec![ListItem::new(Line::from(vec![
                Span::raw("   ".to_string()),
                Span::styled(
                    format!("{} ", spinner_frame),
                    theme.style(StyleKind::Primary),
                ),
                Span::styled(pending_text.clone(), theme.style(StyleKind::Muted)),
            ]))],
            plain_lines: vec![format!("   {} {}", spinner_frame, pending_text)],
        };
    }

    // Icon style: independent color for normal, error color for failures
    let icon_style = if is_error || is_rejected {
        theme.style(StyleKind::Error)
    } else if is_confirmation {
        theme.style(StyleKind::Warning)
    } else {
        theme.style(StyleKind::InlineIcon)
    };

    // Content style: muted for completed (consistent with thinking), error for failures
    let content_style = if is_error {
        theme.style(StyleKind::Error)
    } else if is_rejected {
        theme
            .style(StyleKind::Error)
            .add_modifier(Modifier::CROSSED_OUT)
    } else if is_confirmation {
        theme.style(StyleKind::Warning)
    } else {
        theme.style(StyleKind::Muted)
    };

    // Display icon: use error icon for failures
    let display_icon = if is_error || is_rejected {
        "\u{2717}".to_string()
    } else {
        icon.to_string()
    };

    let content = inline_complete_text(canonical, tool_state);
    let duration_text = tool_state
        .duration_ms
        .map(|ms| {
            if ms < 1000 {
                format!("{}ms", ms)
            } else {
                format!("{:.1}s", ms as f64 / 1000.0)
            }
        })
        .unwrap_or_default();

    let mut items = vec![ListItem::new(Line::from(vec![
        Span::raw("   ".to_string()),
        Span::styled(display_icon.clone(), icon_style),
        Span::raw(" ".to_string()),
        Span::styled(content.clone(), content_style),
        Span::raw("  ".to_string()),
        Span::styled(duration_text.clone(), theme.style(StyleKind::Muted)),
    ]))];
    let mut plain_lines = vec![if duration_text.is_empty() {
        format!("   {} {}", display_icon, content)
    } else {
        format!("   {} {}  {}", display_icon, content, duration_text)
    }];

    // Show error on a second line if failed (not rejected)
    if is_error {
        if let Some(ref result) = tool_state.result {
            let max_width = available_width.saturating_sub(5).max(1) as usize;
            let wrapped = wrap_display_lines(result, max_width);
            let max_lines = 3usize;
            for line in wrapped.iter().take(max_lines) {
                items.push(ListItem::new(Line::from(vec![
                    Span::raw("     ".to_string()),
                    Span::styled(line.clone(), theme.style(StyleKind::Error)),
                ])));
                plain_lines.push(format!("     {}", line));
            }
            if wrapped.len() > max_lines {
                items.push(ListItem::new(Line::from(vec![
                    Span::raw("     ".to_string()),
                    Span::styled(
                        format!("\u{2026} ({} more lines)", wrapped.len() - max_lines),
                        theme.style(StyleKind::Muted),
                    ),
                ])));
                plain_lines.push(format!("     … ({} more lines)", wrapped.len() - max_lines));
            }
        }
    }

    ToolCardRenderOutput { items, plain_lines }
}

/// Generate pending text for inline tools
fn inline_pending_text(canonical: &str, tool_state: &ToolDisplayState) -> String {
    match canonical {
        "Read" => "Reading file...".to_string(),
        "Write" => "Preparing write...".to_string(),
        "Edit" => "Preparing edit...".to_string(),
        "Delete" => "Preparing delete...".to_string(),
        "Bash" => "Writing command...".to_string(),
        "Grep" => "Searching content...".to_string(),
        "Glob" => "Finding files...".to_string(),
        "LS" => "Listing directory...".to_string(),
        "WebSearch" => "Searching web...".to_string(),
        "WebFetch" => "Fetching from the web...".to_string(),
        "Task" | "AgentSpawn" => "Launching agent...".to_string(),
        "TodoWrite" => "Updating todos...".to_string(),
        "HmosCompilation" => "Compiling HarmonyOS project...".to_string(),
        "Skill" => "Loading skill...".to_string(),
        "Git" => "Running git...".to_string(),
        "ReadLints" => "Checking lints...".to_string(),
        "AskUserQuestion" => "Asking questions...".to_string(),
        "CreatePlan" => "Creating plan...".to_string(),
        "GetFileDiff" => "Computing diff...".to_string(),
        _ => {
            if tool_state.tool_name.starts_with("mcp_") {
                // Parse mcp_{server}_{tool} to show a cleaner name
                let parts: Vec<&str> = tool_state.tool_name.splitn(3, '_').collect();
                let tool = if parts.len() >= 3 {
                    parts[2]
                } else {
                    &tool_state.tool_name
                };
                if let Some(ref msg) = tool_state.progress_message {
                    msg.clone()
                } else {
                    format!("Running MCP tool {}...", tool)
                }
            } else if let Some(ref msg) = tool_state.progress_message {
                msg.clone()
            } else {
                format!("Running {}...", tool_state.tool_name)
            }
        }
    }
}

/// Generate complete text for inline tools
fn inline_complete_text(canonical: &str, tool_state: &ToolDisplayState) -> String {
    match canonical {
        "Read" => {
            let path = param_str(
                &tool_state.parameters,
                &["file_path", "target_file", "path"],
            );
            format!("Read {}", path)
        }
        "Grep" => {
            let pattern = param_str(&tool_state.parameters, &["pattern"]);
            let path = param_str_opt(&tool_state.parameters, &["path"]);
            let count = tool_state
                .metadata
                .as_ref()
                .and_then(|m| m.get("total_matches"))
                .and_then(|v| v.as_u64())
                .map(|v| v as usize)
                .or_else(|| tool_state.result.as_ref().map(|r| r.lines().count()))
                .unwrap_or(0);
            let mut text = format!("Grep \"{}\"", pattern);
            if let Some(p) = path {
                text.push_str(&format!(" in {}", p));
            }
            if count > 0 {
                text.push_str(&format!(" ({} matches)", count));
            }
            text
        }
        "Glob" => {
            let pattern = param_str(
                &tool_state.parameters,
                &["glob_pattern", "pattern", "query"],
            );
            let count = tool_state
                .metadata
                .as_ref()
                .and_then(|m| m.get("match_count"))
                .and_then(|v| v.as_u64())
                .map(|v| v as usize)
                .or_else(|| tool_state.result.as_ref().map(|r| r.lines().count()))
                .unwrap_or(0);
            let mut text = format!("Glob \"{}\"", pattern);
            if count > 0 {
                text.push_str(&format!(" ({} matches)", count));
            }
            text
        }
        "LS" => {
            let path = param_str(&tool_state.parameters, &["target_directory", "path"]);
            let count = tool_state
                .metadata
                .as_ref()
                .and_then(|m| m.get("total"))
                .and_then(|v| v.as_u64())
                .map(|v| v as usize)
                .or_else(|| tool_state.result.as_ref().map(|r| r.lines().count()))
                .unwrap_or(0);
            let mut text = format!("List {}", if path.is_empty() { "." } else { &path });
            if count > 0 {
                text.push_str(&format!(" ({} items)", count));
            }
            text
        }
        "WebSearch" => {
            let query = param_str(&tool_state.parameters, &["search_term", "query"]);
            format!("Web Search \"{}\"", query)
        }
        "WebFetch" => {
            let url = param_str(&tool_state.parameters, &["url"]);
            format!("WebFetch {}", truncate_str(&url, 60))
        }
        "Skill" => {
            let name = skill_display_name(&tool_state.parameters);
            format!("Skill \"{}\"", name)
        }
        "Git" => {
            let cmd = param_str(&tool_state.parameters, &["command", "subcommand"]);
            format!("Git {}", truncate_str(&cmd, 60))
        }
        "ReadLints" => {
            let paths = param_str_opt(&tool_state.parameters, &["paths"]);
            match paths {
                Some(p) => format!("Lint Check {}", truncate_str(&p, 50)),
                None => "Lint Check".to_string(),
            }
        }
        "GetFileDiff" => {
            let path = param_str(&tool_state.parameters, &["file_path", "path"]);
            format!("File Diff {}", path)
        }
        "IdeControl" => {
            let action = param_str(&tool_state.parameters, &["action", "command"]);
            format!("IDE {}", action)
        }
        "MermaidInteractive" => "Mermaid Diagram".to_string(),
        "ContextCompression" => "Context Compressed".to_string(),
        "AnalyzeImage" => {
            let path = param_str(&tool_state.parameters, &["image_path", "path"]);
            format!("Analyze Image {}", path)
        }
        "HmosCompilation" => {
            let path = param_str(
                &tool_state.parameters,
                &["project_abs_path", "project_path"],
            );
            if path.is_empty() {
                "HarmonyOS Compile".to_string()
            } else {
                format!("HarmonyOS Compile {}", truncate_str(&path, 60))
            }
        }
        _ => {
            if tool_state.tool_name.starts_with("mcp_") {
                // Parse mcp_{server}_{tool} → "tool_name params (server)"
                let parts: Vec<&str> = tool_state.tool_name.splitn(3, '_').collect();
                let (server, tool) = if parts.len() >= 3 {
                    (parts[1], parts[2])
                } else {
                    ("mcp", tool_state.tool_name.as_str())
                };
                let summary = extract_key_params(&tool_state.parameters);
                if summary.is_empty() {
                    format!("{} ({})", tool, server)
                } else {
                    format!("{} {} ({})", tool, truncate_str(&summary, 40), server)
                }
            } else {
                // Unknown tools
                let summary = extract_key_params(&tool_state.parameters);
                if summary.is_empty() {
                    tool_state.tool_name.clone()
                } else {
                    format!("{} {}", tool_state.tool_name, truncate_str(&summary, 50))
                }
            }
        }
    }
}

// ============ Block Tool Rendering ============

/// Dispatch to the appropriate block renderer
fn render_block_dispatch(
    canonical: &str,
    tool_state: &ToolDisplayState,
    theme: &Theme,
    expanded: bool,
    focused: bool,
    spinner_frame: &str,
    available_width: u16,
) -> ToolCardRenderOutput {
    match canonical {
        "Bash" => render_bash_block(
            tool_state,
            theme,
            expanded,
            focused,
            spinner_frame,
            available_width,
        ),
        "Edit" => render_edit_block(
            tool_state,
            theme,
            expanded,
            focused,
            spinner_frame,
            available_width,
        ),
        "Write" => render_write_block(
            tool_state,
            theme,
            expanded,
            focused,
            spinner_frame,
            available_width,
        ),
        "Delete" => render_delete_block(tool_state, theme, focused, spinner_frame, available_width),
        "Task" | "AgentSpawn" => {
            render_task_block(tool_state, theme, focused, spinner_frame, available_width)
        }
        "TodoWrite" => {
            render_todo_block(tool_state, theme, focused, spinner_frame, available_width)
        }
        "AskUserQuestion" => {
            render_question_block(tool_state, theme, focused, spinner_frame, available_width)
        }
        "CreatePlan" => {
            render_plan_block(tool_state, theme, focused, spinner_frame, available_width)
        }
        "HmosCompilation" => render_hmos_compilation_block(
            tool_state,
            theme,
            expanded,
            focused,
            spinner_frame,
            available_width,
        ),
        _ => render_generic_block(
            tool_state,
            theme,
            expanded,
            focused,
            spinner_frame,
            available_width,
        ),
    }
}

fn filter_hmos_errors(stderr: &str) -> Vec<&str> {
    if stderr.trim().is_empty() {
        return Vec::new();
    }
    if !stderr.contains("ERROR") {
        return stderr.lines().collect();
    }

    let mut lines = Vec::new();
    let mut skipping_warning_block = false;
    for line in stderr.lines() {
        if line.contains("WARN") {
            skipping_warning_block = true;
            continue;
        }
        if line.contains("ERROR") {
            skipping_warning_block = false;
            lines.push(line);
            continue;
        }
        if !skipping_warning_block {
            lines.push(line);
        }
    }
    lines
}

#[cfg(target_os = "macos")]
const DEVECO_HOME_HELP_FALLBACK: &str = "Set DEVECO_HOME to the DevEco Studio installation directory.\nmacOS example (zsh):\nexport DEVECO_HOME=\"/Applications/DevEco Studio.app/Contents\"\nRestart the terminal after setting it.";

#[cfg(target_os = "windows")]
const DEVECO_HOME_HELP_FALLBACK: &str = "Set DEVECO_HOME to the DevEco Studio installation directory.\nWindows PowerShell example:\n[Environment]::SetEnvironmentVariable(\"DEVECO_HOME\",\"C:\\Program Files\\DevEco Studio\",\"User\")\nRestart the terminal after setting it.";

#[cfg(all(not(target_os = "macos"), not(target_os = "windows")))]
const DEVECO_HOME_HELP_FALLBACK: &str = "Set DEVECO_HOME to the DevEco Studio installation directory.\nLinux example (bash):\nexport DEVECO_HOME=\"$HOME/DevEco-Studio\"\nRestart the terminal after setting it.";

fn render_hmos_compilation_block(
    tool_state: &ToolDisplayState,
    theme: &Theme,
    expanded: bool,
    focused: bool,
    spinner_frame: &str,
    available_width: u16,
) -> ToolCardRenderOutput {
    let is_running = matches!(
        tool_state.status,
        ToolDisplayStatus::Running | ToolDisplayStatus::Streaming
    );

    let project_path = param_str_opt(
        &tool_state.parameters,
        &["project_abs_path", "project_path"],
    )
    .or_else(|| {
        tool_state
            .metadata
            .as_ref()
            .and_then(|m| m.get("project_path"))
            .and_then(|v| v.as_str())
            .map(|s| s.to_string())
    })
    .unwrap_or_default();

    let product = param_str_opt(&tool_state.parameters, &["product"])
        .or_else(|| {
            tool_state
                .metadata
                .as_ref()
                .and_then(|m| m.get("product"))
                .and_then(|v| v.as_str())
                .map(|s| s.to_string())
        })
        .unwrap_or_else(|| "default".to_string());
    let build_mode = param_str_opt(&tool_state.parameters, &["build_mode"])
        .or_else(|| {
            tool_state
                .metadata
                .as_ref()
                .and_then(|m| m.get("build_mode"))
                .and_then(|v| v.as_str())
                .map(|s| s.to_string())
        })
        .unwrap_or_else(|| "debug".to_string());

    let (
        success,
        exit_code,
        execution_time_ms,
        deveco_home,
        stderr,
        stdout,
        error_kind,
        error_message,
        help,
    ) = tool_state
        .metadata
        .as_ref()
        .and_then(|m| m.as_object())
        .map(|obj| {
            let success = obj.get("success").and_then(|v| v.as_bool());
            let exit_code = obj.get("exit_code").and_then(|v| v.as_i64());
            let execution_time_ms = obj.get("execution_time_ms").and_then(|v| v.as_u64());
            let deveco_home = obj
                .get("deveco_home")
                .and_then(|v| v.as_str())
                .map(|s| s.to_string());
            let stderr = obj
                .get("stderr")
                .and_then(|v| v.as_str())
                .unwrap_or("")
                .to_string();
            let stdout = obj
                .get("stdout")
                .and_then(|v| v.as_str())
                .unwrap_or("")
                .to_string();
            let error_kind = obj
                .get("error_kind")
                .and_then(|v| v.as_str())
                .map(|s| s.to_string());
            let error_message = obj
                .get("error_message")
                .and_then(|v| v.as_str())
                .map(|s| s.to_string());
            let help = obj
                .get("help")
                .and_then(|v| v.as_str())
                .map(|s| s.to_string());
            (
                success,
                exit_code,
                execution_time_ms,
                deveco_home,
                stderr,
                stdout,
                error_kind,
                error_message,
                help,
            )
        })
        .unwrap_or((
            None,
            None,
            None,
            None,
            String::new(),
            String::new(),
            None,
            None,
            None,
        ));

    let mut title = "HarmonyOS Compile".to_string();
    if !project_path.is_empty() {
        title.push_str(&format!(" {}", truncate_str(&project_path, 50)));
    }

    let mut content_lines = Vec::new();

    content_lines.push(Line::from(vec![
        Span::styled("mode: ", theme.style(StyleKind::Muted)),
        Span::styled(
            format!("product={} buildMode={}", product, build_mode),
            theme.style(StyleKind::Info),
        ),
    ]));

    if let Some(home) = deveco_home {
        content_lines.push(Line::from(vec![
            Span::styled("DevEco: ", theme.style(StyleKind::Muted)),
            Span::raw(truncate_str(&home, 80)),
        ]));
    }

    if let Some(ms) = execution_time_ms {
        content_lines.push(Line::from(vec![
            Span::styled("exec: ", theme.style(StyleKind::Muted)),
            Span::raw(format!("{}ms", ms)),
        ]));
    }

    let status_line = match success {
        Some(true) => Some((true, "succeeded".to_string())),
        Some(false) => Some((false, "failed".to_string())),
        None => None,
    };

    if let Some((ok, status_text)) = status_line {
        let style = if ok {
            theme.style(StyleKind::Success)
        } else {
            theme.style(StyleKind::Error)
        };
        let mut text = format!("status: {}", status_text);
        if let Some(code) = exit_code {
            text.push_str(&format!(" (exit_code={})", code));
        }
        content_lines.push(Line::from(Span::styled(text, style)));
    }

    let inferred_missing_deveco_home =
        matches!(tool_state.result.as_deref(), Some(s) if s.contains("DEVECO_HOME"));

    let should_show_deveco_hint = matches!(
        error_kind.as_deref(),
        Some("missing_deveco_home") | Some("invalid_deveco_home")
    ) || inferred_missing_deveco_home;

    let max_line_width = block_content_max_width(available_width);

    if !is_running && should_show_deveco_hint {
        let headline = match error_kind.as_deref() {
            Some("missing_deveco_home") => "DEVECO_HOME is not set.",
            Some("invalid_deveco_home") => "DEVECO_HOME is set but looks invalid.",
            _ => "DevEco Studio toolchain not detected.",
        };
        content_lines.push(Line::from(vec![
            Span::styled("hint: ", theme.style(StyleKind::Muted)),
            Span::styled(headline, theme.style(StyleKind::Info)),
        ]));

        let display_error_message = error_message.clone().or_else(|| tool_state.result.clone());
        if let Some(msg) = display_error_message.as_deref() {
            if !msg.trim().is_empty() {
                let wrapped = wrap_display_lines(msg, max_line_width.saturating_sub(7).max(1));
                if let Some(first) = wrapped.first() {
                    content_lines.push(Line::from(vec![
                        Span::styled("error: ", theme.style(StyleKind::Muted)),
                        Span::raw(first.clone()),
                    ]));
                }
                for line in wrapped.iter().skip(1) {
                    content_lines.push(Line::from(vec![
                        Span::styled("       ", theme.style(StyleKind::Muted)),
                        Span::raw(line.clone()),
                    ]));
                }
            }
        }

        let help_text = help.as_deref().unwrap_or(DEVECO_HOME_HELP_FALLBACK);
        let mut help_lines_wrapped: Vec<String> = Vec::new();
        for line in help_text.lines() {
            let clean = strip_ansi_codes(line);
            if clean.trim().is_empty() {
                continue;
            }
            help_lines_wrapped.extend(wrap_display_lines(&clean, max_line_width));
        }
        let max = if expanded { usize::MAX } else { 6 };
        for line in help_lines_wrapped.iter().take(max) {
            content_lines.push(Line::from(Span::styled(
                line.clone(),
                theme.style(StyleKind::Muted),
            )));
        }
        if help_lines_wrapped.len() > max {
            content_lines.push(Line::from(Span::styled(
                format!(
                    "\u{25bc} {} more lines (Tab/Click to expand)",
                    help_lines_wrapped.len() - max
                ),
                theme.style(StyleKind::Muted),
            )));
        }
    }

    if !is_running {
        if matches!(success, Some(false)) {
            let filtered = filter_hmos_errors(&stderr);
            let mut wrapped_filtered: Vec<String> = Vec::new();
            for line in &filtered {
                let clean = strip_ansi_codes(line);
                if clean.trim().is_empty() {
                    continue;
                }
                wrapped_filtered.extend(wrap_display_lines(&clean, max_line_width));
            }
            let max = if expanded { usize::MAX } else { 12 };
            for line in wrapped_filtered.iter().take(max) {
                content_lines.push(Line::from(Span::raw(line.clone())));
            }
            if wrapped_filtered.len() > max {
                content_lines.push(Line::from(Span::styled(
                    format!(
                        "\u{25bc} {} more lines (Tab/Click to expand)",
                        wrapped_filtered.len() - max
                    ),
                    theme.style(StyleKind::Muted),
                )));
            }
        } else if matches!(success, Some(true)) {
            let output_lines: Vec<&str> = stdout.lines().filter(|l| !l.trim().is_empty()).collect();
            let mut wrapped_output: Vec<String> = Vec::new();
            for line in output_lines {
                let clean = strip_ansi_codes(line);
                wrapped_output.extend(wrap_display_lines(&clean, max_line_width));
            }
            let max = if expanded { usize::MAX } else { 5 };
            for line in wrapped_output.iter().rev().take(max).rev() {
                content_lines.push(Line::from(Span::raw(line.clone())));
            }
            if !wrapped_output.is_empty() && wrapped_output.len() > max {
                content_lines.push(Line::from(Span::styled(
                    format!(
                        "\u{25bc} {} more lines (Tab/Click to expand)",
                        wrapped_output.len() - max
                    ),
                    theme.style(StyleKind::Muted),
                )));
            }
        } else if let Some(ref result) = tool_state.result {
            let wrapped = wrap_display_lines(result, max_line_width);
            let max = if expanded { usize::MAX } else { 6 };
            for line in wrapped.iter().take(max) {
                content_lines.push(Line::from(Span::styled(
                    line.clone(),
                    theme.style(StyleKind::Muted),
                )));
            }
            if wrapped.len() > max {
                content_lines.push(Line::from(Span::styled(
                    format!(
                        "\u{25bc} {} more lines (Tab/Click to expand)",
                        wrapped.len() - max
                    ),
                    theme.style(StyleKind::Muted),
                )));
            }
        }
    } else if let Some(ref msg) = tool_state.progress_message {
        for line in wrap_display_lines(msg, max_line_width) {
            content_lines.push(Line::from(Span::styled(
                line,
                theme.style(StyleKind::Muted),
            )));
        }
    } else {
        content_lines.push(Line::from(Span::styled(
            "Compiling...",
            theme.style(StyleKind::Muted),
        )));
    }

    let error = if matches!(tool_state.status, ToolDisplayStatus::Failed) {
        tool_state.result.as_deref()
    } else if matches!(success, Some(false)) {
        Some("Compilation failed")
    } else {
        None
    };

    assemble_block(BlockAssembly {
        title: &title,
        content_lines,
        theme,
        is_running,
        error,
        focused,
        tool_state,
        spinner_frame,
        available_width,
    })
}

/// Render a Bash tool as a block (command + output + expand/collapse)
fn render_bash_block(
    tool_state: &ToolDisplayState,
    theme: &Theme,
    expanded: bool,
    focused: bool,
    spinner_frame: &str,
    available_width: u16,
) -> ToolCardRenderOutput {
    let command = param_str(&tool_state.parameters, &["command"]);
    let description = param_str_opt(&tool_state.parameters, &["description"]);
    let workdir = param_str_opt(&tool_state.parameters, &["working_directory", "workdir"]);
    let is_running = matches!(
        tool_state.status,
        ToolDisplayStatus::Running | ToolDisplayStatus::Streaming
    );

    // Title: "Shell" or "Shell in ~/path"
    let base_title = description.unwrap_or_else(|| "Shell".to_string());
    let title = match workdir {
        Some(ref wd) if !wd.is_empty() && wd != "." => {
            if base_title.contains(wd) {
                base_title
            } else {
                format!("{} in {}", base_title, wd)
            }
        }
        _ => base_title,
    };

    // Command line with syntax highlighting
    let hl_theme = HighlightTheme::Dark; // TODO: derive from theme
    let cmd_line = syntax_highlight::highlight_bash_command(&command, hl_theme);
    let mut cmd_spans = vec![Span::styled("$ ", theme.style(StyleKind::CommandText))];
    cmd_spans.extend(cmd_line.spans);

    let mut content_lines = vec![Line::from(cmd_spans)];

    // Extract output: prefer metadata.output (structured), fallback to result (display summary)
    let output_text = tool_state
        .metadata
        .as_ref()
        .and_then(|m| m.get("output"))
        .and_then(|v| v.as_str())
        .map(|s| s.to_string())
        .or_else(|| tool_state.result.clone());

    if let Some(ref output) = output_text {
        let output = output.trim();
        if !output.is_empty() {
            // Strip ANSI escape codes from the entire output first
            let clean_output = strip_ansi_codes(output);
            let mut output_lines: Vec<String> = Vec::new();
            let max_line_width = block_content_max_width(available_width);
            for line in clean_output.lines() {
                let sanitized = line.replace('\t', "    ");
                output_lines.extend(wrap_to_display_width(&sanitized, max_line_width));
            }
            let max_lines = if expanded { usize::MAX } else { 10 };

            for line in output_lines.iter().take(max_lines) {
                content_lines.push(Line::from(Span::raw(line.clone())));
            }

            if output_lines.len() > 10 && !expanded {
                content_lines.push(Line::from(Span::styled(
                    format!(
                        "\u{2026} ({} more lines, Ctrl+O to expand)",
                        output_lines.len() - 10
                    ),
                    theme.style(StyleKind::Muted),
                )));
            } else if expanded && output_lines.len() > 10 {
                content_lines.push(Line::from(Span::styled(
                    "Ctrl+O to collapse".to_string(),
                    theme.style(StyleKind::Muted),
                )));
            }
        }
    }

    let error = if matches!(tool_state.status, ToolDisplayStatus::Failed) {
        tool_state.result.as_deref()
    } else {
        None
    };

    assemble_block(BlockAssembly {
        title: &title,
        content_lines,
        theme,
        is_running,
        error,
        focused,
        tool_state,
        spinner_frame,
        available_width,
    })
}

/// Render an Edit tool as a block (file path + diff preview)
fn render_edit_block(
    tool_state: &ToolDisplayState,
    theme: &Theme,
    expanded: bool,
    focused: bool,
    spinner_frame: &str,
    available_width: u16,
) -> ToolCardRenderOutput {
    let file_path = param_str(
        &tool_state.parameters,
        &["file_path", "target_file", "path"],
    );

    let mut content_lines = Vec::new();

    // Try to show diff from old_string/new_string parameters
    let old_str = tool_state
        .parameters
        .get("old_string")
        .and_then(|v| v.as_str());
    let new_str = tool_state
        .parameters
        .get("new_string")
        .and_then(|v| v.as_str());

    // Compute stats for title
    let (additions, deletions) = match (old_str, new_str) {
        (Some(old), Some(new)) => diff_render::diff_stats(old, new),
        _ => (0, 0),
    };

    // Title with stats
    let title = if additions > 0 || deletions > 0 {
        format!("Edit {} (+{}, -{})", file_path, additions, deletions)
    } else {
        format!("Edit {}", file_path)
    };

    if let (Some(old), Some(new)) = (old_str, new_str) {
        let max = if expanded { usize::MAX } else { 8 };
        // Use the block's available width minus border overhead (~8 chars)
        let diff_width = available_width.saturating_sub(8);
        let diff_lines =
            diff_render::render_diff(old, new, theme, max, DiffViewMode::Auto, diff_width);
        content_lines.extend(diff_lines);

        let total_changes = additions + deletions;
        if total_changes > max && !expanded {
            content_lines.push(Line::from(Span::styled(
                "\u{2026} (more changes, Ctrl+O to expand)".to_string(),
                theme.style(StyleKind::Muted),
            )));
        } else if expanded && total_changes > 8 {
            content_lines.push(Line::from(Span::styled(
                "Ctrl+O to collapse".to_string(),
                theme.style(StyleKind::Muted),
            )));
        }
    }

    // Show result summary (now a clean display_summary, not raw JSON)
    if let Some(ref result) = tool_state.result {
        if !result.is_empty() {
            let max_width = block_content_max_width(available_width);
            for line in wrap_display_lines(result, max_width) {
                content_lines.push(Line::from(Span::styled(
                    line,
                    theme.style(StyleKind::Success),
                )));
            }
        }
    }

    let error = if matches!(tool_state.status, ToolDisplayStatus::Failed) {
        tool_state.result.as_deref()
    } else {
        None
    };

    assemble_block(BlockAssembly {
        title: &title,
        content_lines,
        theme,
        is_running: false,
        error,
        focused,
        tool_state,
        spinner_frame,
        available_width,
    })
}

/// Render a Write tool as a block (file path + syntax-highlighted content preview)
fn render_write_block(
    tool_state: &ToolDisplayState,
    theme: &Theme,
    expanded: bool,
    focused: bool,
    spinner_frame: &str,
    available_width: u16,
) -> ToolCardRenderOutput {
    let payload = tool_state
        .parameters
        .get("payload")
        .and_then(|value| value.as_str());
    let combined = payload.and_then(|value| {
        let (first_line, content) = value.split_once('\n').unwrap_or((value, ""));
        let first_line = first_line.strip_suffix('\r').unwrap_or(first_line);
        let file_path = first_line.strip_prefix("+++ ")?;
        (!file_path.trim().is_empty()).then_some((file_path, content))
    });
    let file_path = combined
        .map(|(file_path, _)| file_path.to_string())
        .unwrap_or_else(|| {
            let legacy_path = param_str(
                &tool_state.parameters,
                &["file_path", "target_file", "path"],
            );
            if legacy_path.is_empty() && payload.is_some() {
                "workspace temporary file".to_string()
            } else {
                legacy_path
            }
        });

    let mut content_lines = Vec::new();

    // Show content preview with syntax highlighting and line numbers
    if let Some(content) = combined
        .map(|(_, content)| content)
        .or(payload.filter(|_| combined.is_none()))
        .or_else(|| {
            tool_state
                .parameters
                .get("contents")
                .or_else(|| tool_state.parameters.get("content"))
                .and_then(|value| value.as_str())
        })
    {
        let total_lines = content.lines().count();
        let max = if expanded { usize::MAX } else { 8 };
        let ext = syntax_highlight::ext_from_path(&file_path);
        let hl_theme = HighlightTheme::Dark; // TODO: derive from theme

        // Use syntax highlighting with line numbers
        let highlighted = syntax_highlight::highlight_code_with_line_numbers(
            content,
            ext,
            hl_theme,
            theme.style(StyleKind::DiffLineNumber),
            theme.style(StyleKind::Muted),
        );

        for line in highlighted.into_iter().take(max) {
            content_lines.push(line);
        }

        if total_lines > 8 && !expanded {
            content_lines.push(Line::from(Span::styled(
                format!(
                    "\u{2026} ({} more lines, Ctrl+O to expand)",
                    total_lines - 8
                ),
                theme.style(StyleKind::Muted),
            )));
        } else if expanded && total_lines > 8 {
            content_lines.push(Line::from(Span::styled(
                "Ctrl+O to collapse".to_string(),
                theme.style(StyleKind::Muted),
            )));
        }

        // Title with line count
        let title = format!("Write {} ({} lines)", file_path, total_lines);

        if let Some(ref result) = tool_state.result {
            if !result.is_empty() {
                let max_width = block_content_max_width(available_width);
                for line in wrap_display_lines(result, max_width) {
                    content_lines.push(Line::from(Span::styled(
                        line,
                        theme.style(StyleKind::Success),
                    )));
                }
            }
        }

        let error = if matches!(tool_state.status, ToolDisplayStatus::Failed) {
            tool_state.result.as_deref()
        } else {
            None
        };

        return assemble_block(BlockAssembly {
            title: &title,
            content_lines,
            theme,
            is_running: false,
            error,
            focused,
            tool_state,
            spinner_frame,
            available_width,
        });
    }

    // Fallback: no content available
    let title = format!("Write {}", file_path);

    if let Some(ref result) = tool_state.result {
        if !result.is_empty() {
            let max_width = block_content_max_width(available_width);
            for line in wrap_display_lines(result, max_width) {
                content_lines.push(Line::from(Span::styled(
                    line,
                    theme.style(StyleKind::Success),
                )));
            }
        }
    }

    let error = if matches!(tool_state.status, ToolDisplayStatus::Failed) {
        tool_state.result.as_deref()
    } else {
        None
    };

    assemble_block(BlockAssembly {
        title: &title,
        content_lines,
        theme,
        is_running: false,
        error,
        focused,
        tool_state,
        spinner_frame,
        available_width,
    })
}

/// Render a Delete tool as a block
fn render_delete_block(
    tool_state: &ToolDisplayState,
    theme: &Theme,
    focused: bool,
    spinner_frame: &str,
    available_width: u16,
) -> ToolCardRenderOutput {
    let file_path = param_str(
        &tool_state.parameters,
        &["file_path", "target_file", "path"],
    );
    let title = format!("Delete {}", file_path);

    let mut content_lines = Vec::new();
    if let Some(ref result) = tool_state.result {
        if !result.is_empty() {
            let max_width = block_content_max_width(available_width);
            for line in wrap_display_lines(result, max_width) {
                content_lines.push(Line::from(Span::styled(
                    line,
                    theme.style(StyleKind::Muted),
                )));
            }
        }
    }

    let error = if matches!(tool_state.status, ToolDisplayStatus::Failed) {
        tool_state.result.as_deref()
    } else {
        None
    };

    assemble_block(BlockAssembly {
        title: &title,
        content_lines,
        theme,
        is_running: false,
        error,
        focused,
        tool_state,
        spinner_frame,
        available_width,
    })
}

/// Render an agent launch as a block (agent type + prompt + real-time progress)
fn render_task_block(
    tool_state: &ToolDisplayState,
    theme: &Theme,
    focused: bool,
    spinner_frame: &str,
    available_width: u16,
) -> ToolCardRenderOutput {
    let subagent_type = param_str_opt(&tool_state.parameters, &["subagent_type", "agent_type"])
        .unwrap_or_else(|| "Unknown".to_string());
    let description = param_str_opt(&tool_state.parameters, &["description"])
        .or_else(|| param_str_opt(&tool_state.parameters, &["prompt"]))
        .unwrap_or_else(|| "Agent".to_string());
    let is_running = matches!(
        tool_state.status,
        ToolDisplayStatus::Running | ToolDisplayStatus::Streaming
    );

    let title = format!("{} Agent", capitalize_first(&subagent_type));

    // Build description line with tool call count (if available)
    let desc_text = if let Some(ref progress) = tool_state.subagent_progress {
        if progress.tool_count > 0 {
            format!("{} ({} toolcalls)", description, progress.tool_count)
        } else {
            description.clone()
        }
    } else {
        description.clone()
    };

    let mut content_lines = vec![Line::from(Span::styled(
        desc_text,
        theme.style(StyleKind::Muted),
    ))];

    // Show real-time subagent progress (current tool being executed)
    if is_running {
        if let Some(ref progress) = tool_state.subagent_progress {
            if let Some(ref tool_name) = progress.current_tool_name {
                let progress_text = if let Some(ref title) = progress.current_tool_title {
                    format!("\u{2514} {} {}", capitalize_first(tool_name), title)
                // └
                } else {
                    format!("\u{2514} {}", capitalize_first(tool_name)) // └
                };
                content_lines.push(Line::from(Span::styled(
                    progress_text,
                    theme.style(StyleKind::Muted),
                )));
            }
        }
    }

    // Show final result when completed
    if let Some(ref result) = tool_state.result {
        let max_width = block_content_max_width(available_width)
            .saturating_sub(2)
            .max(1);
        for line in wrap_display_lines(result, max_width) {
            content_lines.push(Line::from(Span::styled(
                format!("\u{2514} {}", line), // └
                theme.style(StyleKind::Success),
            )));
        }
    }

    assemble_block(BlockAssembly {
        title: &title,
        content_lines,
        theme,
        is_running,
        error: None,
        focused,
        tool_state,
        spinner_frame,
        available_width,
    })
}

/// Render a TodoWrite tool as a block (todo list with upgraded icons)
fn render_todo_block(
    tool_state: &ToolDisplayState,
    theme: &Theme,
    focused: bool,
    spinner_frame: &str,
    available_width: u16,
) -> ToolCardRenderOutput {
    let mut content_lines = Vec::new();

    if let Some(todos) = tool_state
        .parameters
        .get("todos")
        .and_then(|v| v.as_array())
    {
        for todo in todos {
            let status = todo
                .get("status")
                .and_then(|v| v.as_str())
                .unwrap_or("pending");
            let content = todo.get("content").and_then(|v| v.as_str()).unwrap_or("");

            let (marker, marker_style, content_style) = match status {
                "completed" => (
                    "\u{2713}", // ✓
                    theme.style(StyleKind::Success),
                    theme
                        .style(StyleKind::Muted)
                        .add_modifier(Modifier::CROSSED_OUT),
                ),
                "in_progress" => (
                    "\u{25cf}", // ●
                    theme.style(StyleKind::Warning),
                    theme.style(StyleKind::Warning),
                ),
                "cancelled" => (
                    "\u{2014}", // —
                    theme.style(StyleKind::Muted),
                    theme
                        .style(StyleKind::Muted)
                        .add_modifier(Modifier::CROSSED_OUT),
                ),
                _ => (
                    "\u{25cb}", // ○
                    theme.style(StyleKind::Primary),
                    Style::default(),
                ),
            };

            content_lines.push(Line::from(vec![
                Span::styled(format!("{} ", marker), marker_style),
                Span::styled(content.to_string(), content_style),
            ]));
        }
    }

    if content_lines.is_empty() {
        content_lines.push(Line::from(Span::styled(
            "Updating todos...",
            theme.style(StyleKind::Muted),
        )));
    }

    assemble_block(BlockAssembly {
        title: "Todos",
        content_lines,
        theme,
        is_running: false,
        error: None,
        focused,
        tool_state,
        spinner_frame,
        available_width,
    })
}

/// Render an AskUserQuestion tool as a block
fn render_question_block(
    tool_state: &ToolDisplayState,
    theme: &Theme,
    focused: bool,
    spinner_frame: &str,
    available_width: u16,
) -> ToolCardRenderOutput {
    let mut content_lines = Vec::new();

    // If completed, show answer summary instead of options
    if tool_state.status == ToolDisplayStatus::Success {
        if let Some(ref result) = tool_state.result {
            // Try to parse the result as JSON to show answers
            if let Ok(result_val) = serde_json::from_str::<serde_json::Value>(result) {
                if let Some(obj) = result_val.as_object() {
                    for (key, val) in obj {
                        let answer_text = match val {
                            serde_json::Value::String(s) => s.clone(),
                            serde_json::Value::Array(arr) => {
                                let items: Vec<String> = arr
                                    .iter()
                                    .filter_map(|v| v.as_str().map(String::from))
                                    .collect();
                                items.join(", ")
                            }
                            _ => val.to_string(),
                        };
                        let key_prefix = format!("{}: ", key);
                        let value_width = block_content_max_width(available_width)
                            .saturating_sub(key_prefix.len())
                            .max(1);
                        let wrapped_answers = wrap_display_lines(&answer_text, value_width);
                        if let Some(first) = wrapped_answers.first() {
                            content_lines.push(Line::from(vec![
                                Span::styled(key_prefix.clone(), theme.style(StyleKind::Muted)),
                                Span::styled(first.clone(), theme.style(StyleKind::Success)),
                            ]));
                        }
                        for line in wrapped_answers.iter().skip(1) {
                            content_lines.push(Line::from(vec![
                                Span::styled(
                                    " ".repeat(key_prefix.len()),
                                    theme.style(StyleKind::Muted),
                                ),
                                Span::styled(line.clone(), theme.style(StyleKind::Success)),
                            ]));
                        }
                    }
                }
                if content_lines.is_empty() {
                    content_lines.push(Line::from(Span::styled(
                        "Answered".to_string(),
                        theme.style(StyleKind::Success),
                    )));
                }
            } else {
                let max_width = block_content_max_width(available_width);
                for line in wrap_display_lines(result, max_width) {
                    content_lines.push(Line::from(Span::styled(
                        line,
                        theme.style(StyleKind::Success),
                    )));
                }
            }
        } else {
            content_lines.push(Line::from(Span::styled(
                "Answered".to_string(),
                theme.style(StyleKind::Success),
            )));
        }
    } else if tool_state.status == ToolDisplayStatus::Running {
        if let Some(questions) = tool_state
            .parameters
            .get("questions")
            .and_then(|v| v.as_array())
        {
            for q in questions {
                let question_text = q.get("question").and_then(|v| v.as_str()).unwrap_or("?");
                content_lines.push(Line::from(Span::styled(
                    question_text.to_string(),
                    theme.style(StyleKind::Info),
                )));
            }
        }
        content_lines.push(Line::from(Span::styled(
            "Waiting for your answer...".to_string(),
            theme.style(StyleKind::Warning),
        )));
    } else {
        if let Some(questions) = tool_state
            .parameters
            .get("questions")
            .and_then(|v| v.as_array())
        {
            for q in questions {
                let prompt = q
                    .get("question")
                    .and_then(|v| v.as_str())
                    .or_else(|| q.get("prompt").and_then(|v| v.as_str()))
                    .unwrap_or("?");
                content_lines.push(Line::from(Span::styled(
                    prompt.to_string(),
                    theme.style(StyleKind::Info),
                )));

                if let Some(options) = q.get("options").and_then(|v| v.as_array()) {
                    for opt in options {
                        let label = opt.get("label").and_then(|v| v.as_str()).unwrap_or("?");
                        content_lines.push(Line::from(vec![
                            Span::raw("  ".to_string()),
                            Span::styled("\u{2022} ".to_string(), theme.style(StyleKind::Muted)),
                            Span::raw(label.to_string()),
                        ]));
                    }
                }
            }
        }

        if content_lines.is_empty() {
            content_lines.push(Line::from(Span::styled(
                "Asking questions...",
                theme.style(StyleKind::Muted),
            )));
        }
    }

    assemble_block(BlockAssembly {
        title: "Questions",
        content_lines,
        theme,
        is_running: false,
        error: None,
        focused,
        tool_state,
        spinner_frame,
        available_width,
    })
}

/// Render a CreatePlan tool as a block
fn render_plan_block(
    tool_state: &ToolDisplayState,
    theme: &Theme,
    focused: bool,
    spinner_frame: &str,
    available_width: u16,
) -> ToolCardRenderOutput {
    let mut content_lines = Vec::new();

    let title_text = param_str_opt(&tool_state.parameters, &["title", "name"])
        .unwrap_or_else(|| "Plan".to_string());

    if let Some(steps) = tool_state
        .parameters
        .get("steps")
        .and_then(|v| v.as_array())
    {
        for (i, step) in steps.iter().enumerate() {
            let desc = step
                .as_str()
                .or_else(|| step.get("description").and_then(|v| v.as_str()))
                .unwrap_or("...");
            content_lines.push(Line::from(vec![
                Span::styled(format!("{}. ", i + 1), theme.style(StyleKind::Muted)),
                Span::raw(desc.to_string()),
            ]));
        }
    }

    if let Some(ref result) = tool_state.result {
        let max_width = block_content_max_width(available_width);
        for line in wrap_display_lines(result, max_width) {
            content_lines.push(Line::from(Span::styled(
                line,
                theme.style(StyleKind::Success),
            )));
        }
    }

    if content_lines.is_empty() {
        content_lines.push(Line::from(Span::styled(
            "Creating plan...",
            theme.style(StyleKind::Muted),
        )));
    }

    assemble_block(BlockAssembly {
        title: &title_text,
        content_lines,
        theme,
        is_running: false,
        error: None,
        focused,
        tool_state,
        spinner_frame,
        available_width,
    })
}

/// Render a generic block tool (fallback for unknown block tools)
fn render_generic_block(
    tool_state: &ToolDisplayState,
    theme: &Theme,
    expanded: bool,
    focused: bool,
    spinner_frame: &str,
    available_width: u16,
) -> ToolCardRenderOutput {
    let title = tool_state.tool_name.clone();
    let mut content_lines = Vec::new();

    let summary = extract_key_params(&tool_state.parameters);
    if !summary.is_empty() {
        content_lines.push(Line::from(Span::styled(
            summary,
            theme.style(StyleKind::Info),
        )));
    }

    if let Some(ref msg) = tool_state.progress_message {
        for line in wrap_display_lines(msg, block_content_max_width(available_width)) {
            content_lines.push(Line::from(Span::styled(
                line,
                theme.style(StyleKind::Muted),
            )));
        }
    }

    if let Some(ref result) = tool_state.result {
        let lines = wrap_display_lines(result, block_content_max_width(available_width));
        let max = if expanded { usize::MAX } else { 5 };
        for line in lines.iter().take(max) {
            content_lines.push(Line::from(Span::raw(line.clone())));
        }
        if lines.len() > max {
            content_lines.push(Line::from(Span::styled(
                format!(
                    "\u{25bc} {} more lines (Tab/Click to expand)",
                    lines.len() - max
                ),
                theme.style(StyleKind::Muted),
            )));
        }
    }

    let is_running = matches!(
        tool_state.status,
        ToolDisplayStatus::Running | ToolDisplayStatus::Streaming
    );
    let error = if matches!(tool_state.status, ToolDisplayStatus::Failed) {
        tool_state.result.as_deref()
    } else {
        None
    };

    assemble_block(BlockAssembly {
        title: &title,
        content_lines,
        theme,
        is_running,
        error,
        focused,
        tool_state,
        spinner_frame,
        available_width,
    })
}

// ============ Block Assembly ============

/// Assemble a block tool card with a full box frame using Unicode box-drawing characters.
/// The background color fills the entire box width uniformly.
///
/// Layout:
/// ```text
///   ╭──────────────────────────────────────────────╮
///   │  Title                        (1.2s)  ✓      │
///   │    content line 1                             │
///   │    content line 2                             │
///   │    error message (if any)                     │
///   ╰──────────────────────────────────────────────╯
/// ```
fn assemble_block(assembly: BlockAssembly<'_>) -> ToolCardRenderOutput {
    let BlockAssembly {
        title,
        content_lines,
        theme,
        is_running,
        error,
        focused,
        tool_state,
        spinner_frame,
        available_width,
    } = assembly;
    let mut items = Vec::new();
    let mut plain_lines = Vec::new();

    let border_style = if focused {
        theme.style(StyleKind::BlockBorderActive)
    } else if is_running {
        theme.style(StyleKind::Primary)
    } else {
        theme.style(StyleKind::Border)
    };

    // Background style for the entire block
    let bg_style = if focused {
        theme.style(StyleKind::BlockBackgroundHover)
    } else {
        theme.style(StyleKind::BlockBackground)
    };

    let (status_icon, status_style) =
        status_icon_and_style(&tool_state.status, theme, spinner_frame);

    // Duration text
    let duration_text = tool_state
        .duration_ms
        .map(|ms| {
            if ms < 1000 {
                format!("{}ms", ms)
            } else {
                format!("{:.1}s", ms as f64 / 1000.0)
            }
        })
        .unwrap_or_default();

    // Box dimensions:
    // Layout: "  ╭─...─╮" => 2 (left margin) + 1 (corner) + inner_width (horizontal lines) + 1 (corner)
    // The inner content area width = available_width - 2 (margin) - 2 (left+right border) = available_width - 4
    let total_w = available_width as usize;
    // Minimum box width
    let box_w = if total_w > 6 { total_w - 2 } else { 20 }; // box width excluding left margin
    let inner_w = if box_w > 2 { box_w - 2 } else { 18 }; // content area inside borders

    // Helper: build a padded line inside the box.
    // Returns: "  │" + content_spans + padding + "│"
    // Content is expected to be pre-wrapped by callers; this layer should not truncate.
    let build_box_line =
        |content_spans: Vec<Span<'static>>, bs: Style, bgs: Style| -> (ListItem<'static>, String) {
            let used_width: usize = content_spans
                .iter()
                .map(|span| unicode_display_width(span.content.as_ref()))
                .sum();
            let pad = inner_w.saturating_sub(used_width);
            let content_plain = content_spans
                .iter()
                .map(|span| span.content.as_ref())
                .collect::<String>();

            let mut spans = Vec::with_capacity(content_spans.len() + 4);
            spans.push(Span::styled("  \u{2502}".to_string(), bs)); // "  │"
            spans.extend(content_spans);
            if pad > 0 {
                spans.push(Span::styled(" ".repeat(pad), bgs));
            }
            spans.push(Span::styled("\u{2502}".to_string(), bs)); // "│"
            let plain = format!("  │{}{}│", content_plain, " ".repeat(pad));

            (ListItem::new(Line::from(spans)).style(bgs), plain)
        };

    // ── Top border: "  ╭─────...─────╮"
    let horiz_len = if inner_w > 0 { inner_w } else { 1 };
    let top_line = format!("  \u{256D}{}\u{256E}", "\u{2500}".repeat(horiz_len));
    items.push(
        ListItem::new(Line::from(vec![Span::styled(
            top_line.clone(),
            border_style,
        )]))
        .style(bg_style),
    );
    plain_lines.push(top_line);

    // ── Title line
    let title_display = if is_running {
        format!("{} {}", spinner_frame, title)
    } else {
        title.to_string()
    };

    let mut title_content = vec![
        Span::raw("  ".to_string()),
        Span::styled(
            title_display,
            theme.style(StyleKind::Muted).add_modifier(Modifier::BOLD),
        ),
    ];

    if !duration_text.is_empty() {
        title_content.push(Span::raw("  ".to_string()));
        title_content.push(Span::styled(duration_text, theme.style(StyleKind::Muted)));
    }

    title_content.push(Span::raw("  ".to_string()));
    title_content.push(Span::styled(status_icon, status_style));

    let (title_item, title_plain) = build_box_line(title_content, border_style, bg_style);
    items.push(title_item);
    plain_lines.push(title_plain);

    // ── Content lines
    for line in content_lines {
        let mut content = Vec::with_capacity(line.spans.len() + 1);
        content.push(Span::raw("    ".to_string())); // 4-space indent for content
        content.extend(line.spans);
        let (item, plain) = build_box_line(content, border_style, bg_style);
        items.push(item);
        plain_lines.push(plain);
    }

    // ── Error line
    if let Some(err) = error {
        let err_border_style = theme.style(StyleKind::Error);
        let err_max_width = inner_w.saturating_sub(4).max(1);
        for err_line in wrap_display_lines(err, err_max_width) {
            let content = vec![
                Span::raw("    ".to_string()),
                Span::styled(err_line, theme.style(StyleKind::Error)),
            ];
            let (item, plain) = build_box_line(content, err_border_style, bg_style);
            items.push(item);
            plain_lines.push(plain);
        }
    }

    // ── Bottom border: "  ╰─────...─────╯"
    let bottom_line = format!("  \u{2570}{}\u{256F}", "\u{2500}".repeat(horiz_len));
    items.push(
        ListItem::new(Line::from(vec![Span::styled(
            bottom_line.clone(),
            border_style,
        )]))
        .style(bg_style),
    );
    plain_lines.push(bottom_line);

    ToolCardRenderOutput { items, plain_lines }
}

/// Calculate the display width of a string, accounting for Unicode characters.
/// CJK characters count as 2, most others as 1.
fn unicode_display_width(s: &str) -> usize {
    use unicode_width::UnicodeWidthStr;
    UnicodeWidthStr::width(s)
}

/// Status icon and style for block tool headers
fn status_icon_and_style(
    status: &ToolDisplayStatus,
    theme: &Theme,
    spinner_frame: &str,
) -> (String, Style) {
    match status {
        ToolDisplayStatus::Running | ToolDisplayStatus::Streaming => {
            (spinner_frame.to_string(), theme.style(StyleKind::Primary))
        }
        ToolDisplayStatus::Success => ("\u{2713}".to_string(), theme.style(StyleKind::Success)), // ✓
        ToolDisplayStatus::Failed => ("\u{2717}".to_string(), theme.style(StyleKind::Error)), // ✗
        ToolDisplayStatus::Queued => ("\u{2016}".to_string(), theme.style(StyleKind::Muted)), // ‖
        ToolDisplayStatus::Waiting => ("\u{2026}".to_string(), theme.style(StyleKind::Warning)), // …
        ToolDisplayStatus::EarlyDetected | ToolDisplayStatus::ParamsPartial => {
            (spinner_frame.to_string(), theme.style(StyleKind::Muted))
        }
        ToolDisplayStatus::ConfirmationNeeded => ("?".to_string(), theme.style(StyleKind::Warning)),
        ToolDisplayStatus::Confirmed => ("\u{2713}".to_string(), theme.style(StyleKind::Success)),
        ToolDisplayStatus::Rejected => ("\u{2717}".to_string(), theme.style(StyleKind::Error)),
        ToolDisplayStatus::Cancelled => ("\u{2014}".to_string(), theme.style(StyleKind::Muted)), // —
        ToolDisplayStatus::Pending => ("\u{2014}".to_string(), theme.style(StyleKind::Muted)),
    }
}

// ============ Parameter Helpers ============

/// Extract a string parameter by trying multiple key names
fn param_str(params: &serde_json::Value, keys: &[&str]) -> String {
    for key in keys {
        if let Some(v) = params.get(*key).and_then(|v| v.as_str()) {
            return v.to_string();
        }
    }
    "unknown".to_string()
}

/// Extract the Skill tool's command, retaining legacy parameter aliases.
fn skill_display_name(params: &serde_json::Value) -> String {
    param_str(params, &["command", "name", "skill_name"])
}

/// Extract an optional string parameter
fn param_str_opt(params: &serde_json::Value, keys: &[&str]) -> Option<String> {
    for key in keys {
        if let Some(v) = params.get(*key).and_then(|v| v.as_str()) {
            return Some(v.to_string());
        }
    }
    None
}

/// Extract a key parameter summary from JSON params
fn extract_key_params(params: &serde_json::Value) -> String {
    if let Some(obj) = params.as_object() {
        let priority_keys = [
            "path",
            "file_path",
            "target_file",
            "query",
            "pattern",
            "command",
            "message",
            "url",
        ];

        for key in &priority_keys {
            if let Some(value) = obj.get(*key) {
                if let Some(s) = value.as_str() {
                    return truncate_str(s, 60);
                }
            }
        }

        for (_key, value) in obj.iter() {
            if let Some(s) = value.as_str() {
                if s.len() < 100 {
                    return truncate_str(s, 60);
                }
            }
        }
    }

    String::new()
}

/// Capitalize the first letter of a string
fn capitalize_first(s: &str) -> String {
    let mut chars = s.chars();
    match chars.next() {
        None => String::new(),
        Some(c) => c.to_uppercase().to_string() + chars.as_str(),
    }
}

#[cfg(test)]
mod tests {
    use super::skill_display_name;

    #[test]
    fn skill_name_is_read_from_command_parameter() {
        let params = serde_json::json!({"command": "arkts-error-fixes"});

        assert_eq!(skill_display_name(&params), "arkts-error-fixes");
    }
}
