use std::collections::HashMap;
use std::path::{Component, Path, PathBuf};

use crate::chat_state::{ChatState, FlowItem, MessageRole, ToolDisplayState, ToolDisplayStatus};

#[derive(Debug, Clone, Copy, Default, PartialEq, Eq)]
pub(super) struct MarkdownTranscriptOptions {
    pub(super) include_reasoning: bool,
    pub(super) include_tool_details: bool,
}

#[derive(Debug, thiserror::Error, PartialEq, Eq)]
pub(super) enum ExportPathError {
    #[error("Enter a relative Markdown file path")]
    Empty,
    #[error("Export paths must be relative to the directory where OpenBitFun was started")]
    Absolute,
    #[error("Export paths cannot contain '..'")]
    ParentTraversal,
}

pub(super) fn default_export_filename(session_id: &str) -> String {
    let short = session_id.chars().take(8).collect::<String>();
    if short.is_empty() {
        "session.md".to_string()
    } else {
        format!("session-{short}.md")
    }
}

pub(super) fn resolve_export_target(root: &Path, input: &str) -> Result<PathBuf, ExportPathError> {
    let input = input.trim();
    if input.is_empty() {
        return Err(ExportPathError::Empty);
    }
    if looks_absolute_on_any_supported_platform(input) {
        return Err(ExportPathError::Absolute);
    }
    let relative = Path::new(input);
    let mut clean = PathBuf::new();
    for component in relative.components() {
        match component {
            Component::Normal(value) => clean.push(value),
            Component::CurDir => {}
            Component::ParentDir => return Err(ExportPathError::ParentTraversal),
            Component::Prefix(_) | Component::RootDir => return Err(ExportPathError::Absolute),
        }
    }
    if clean.as_os_str().is_empty() {
        return Err(ExportPathError::Empty);
    }
    Ok(root.join(clean))
}

fn looks_absolute_on_any_supported_platform(value: &str) -> bool {
    let bytes = value.as_bytes();
    value.starts_with('/')
        || value.starts_with('\\')
        || (bytes.len() >= 2 && bytes[0].is_ascii_alphabetic() && bytes[1] == b':')
}

pub(super) fn render_session_markdown(
    state: &ChatState,
    options: MarkdownTranscriptOptions,
) -> String {
    let title = state
        .session_name
        .split_whitespace()
        .collect::<Vec<_>>()
        .join(" ");
    let title = if title.is_empty() {
        "OpenBitFun Session"
    } else {
        title.as_str()
    };
    let mut output = format!("# {title}\n\n**Session ID:** {}\n", state.core_session_id);
    let tool_results = collect_tool_results(state);

    for message in &state.messages {
        let heading = match message.role {
            MessageRole::User => "User",
            MessageRole::Assistant => "Assistant",
            MessageRole::System | MessageRole::Tool => continue,
        };
        let mut body = String::new();
        for item in &message.flow_items {
            match item {
                FlowItem::Text { content, .. } if !content.is_empty() => {
                    push_block(&mut body, content);
                }
                FlowItem::Thinking { content }
                    if options.include_reasoning && !content.is_empty() =>
                {
                    push_block(&mut body, &format!("_Thinking:_\n\n{content}"));
                }
                FlowItem::UserSteering {
                    content,
                    is_pending,
                    ..
                } if !content.is_empty() => {
                    let status = if *is_pending { " (pending)" } else { "" };
                    push_block(&mut body, &format!("> **You steered{status}:** {content}"));
                }
                FlowItem::Tool { tool_state } => {
                    let paired = tool_results.get(tool_state.tool_id.as_str()).copied();
                    push_block(
                        &mut body,
                        &render_tool(tool_state, paired, options.include_tool_details),
                    );
                }
                FlowItem::Text { .. }
                | FlowItem::Thinking { .. }
                | FlowItem::UserSteering { .. } => {}
            }
        }
        if body.is_empty() {
            continue;
        }
        output.push_str(&format!("\n---\n\n## {heading}\n\n{body}\n"));
    }
    output
}

#[cfg(test)]
fn role_label(role: &MessageRole) -> &'static str {
    match role {
        MessageRole::User => "user",
        MessageRole::Assistant => "assistant",
        MessageRole::System => "system",
        MessageRole::Tool => "tool",
    }
}

fn collect_tool_results(state: &ChatState) -> HashMap<&str, &ToolDisplayState> {
    state
        .messages
        .iter()
        .filter(|message| message.role == MessageRole::Tool)
        .flat_map(|message| message.flow_items.iter())
        .filter_map(|item| match item {
            FlowItem::Tool { tool_state } => Some((tool_state.tool_id.as_str(), tool_state)),
            FlowItem::Text { .. } | FlowItem::Thinking { .. } | FlowItem::UserSteering { .. } => {
                None
            }
        })
        .collect()
}

fn render_tool(
    call: &ToolDisplayState,
    paired_result: Option<&ToolDisplayState>,
    include_details: bool,
) -> String {
    let mut output = format!("**Tool: {}**", call.tool_name);
    if !include_details {
        return output;
    }
    if !call.parameters.is_null() {
        let input = serde_json::to_string_pretty(&call.parameters)
            .unwrap_or_else(|_| call.parameters.to_string());
        output.push_str("\n\n**Input:**\n\n");
        output.push_str(&fenced_block("json", &input));
    }
    let result = paired_result.unwrap_or(call);
    if let Some(content) = result.result.as_deref() {
        let label = if result.status == ToolDisplayStatus::Failed {
            "Error"
        } else {
            "Output"
        };
        output.push_str(&format!("\n\n**{label}:**\n\n"));
        output.push_str(&fenced_block("text", content));
    } else if !matches!(
        result.status,
        ToolDisplayStatus::Success | ToolDisplayStatus::Failed | ToolDisplayStatus::Cancelled
    ) {
        output.push_str(&format!(
            "\n\n_Status: {}_",
            tool_status_label(&result.status)
        ));
    }
    output
}

fn tool_status_label(status: &ToolDisplayStatus) -> &'static str {
    match status {
        ToolDisplayStatus::EarlyDetected | ToolDisplayStatus::ParamsPartial => "preparing",
        ToolDisplayStatus::Queued => "queued",
        ToolDisplayStatus::Waiting | ToolDisplayStatus::ConfirmationNeeded => "waiting",
        ToolDisplayStatus::Confirmed | ToolDisplayStatus::Pending => "pending",
        ToolDisplayStatus::Running | ToolDisplayStatus::Streaming => "running",
        ToolDisplayStatus::Success => "completed",
        ToolDisplayStatus::Failed => "failed",
        ToolDisplayStatus::Cancelled => "cancelled",
        ToolDisplayStatus::Rejected => "rejected",
    }
}

fn push_block(output: &mut String, block: &str) {
    if !output.is_empty() {
        output.push_str("\n\n");
    }
    output.push_str(block);
}

fn fenced_block(language: &str, content: &str) -> String {
    let longest = content
        .split(|character| character != '`')
        .map(str::len)
        .max()
        .unwrap_or_default();
    let fence = "`".repeat(longest.saturating_add(1).max(3));
    format!("{fence}{language}\n{content}\n{fence}")
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::chat_state::{
        ChatMessage, ChatState, FlowItem, MessageRole, ToolDisplayState, ToolDisplayStatus,
    };
    use std::time::SystemTime;

    fn message(role: MessageRole, flow_items: Vec<FlowItem>) -> ChatMessage {
        ChatMessage {
            id: format!("message-{}", role_label(&role)),
            turn_id: None,
            role,
            timestamp: SystemTime::UNIX_EPOCH,
            flow_items,
            is_streaming: false,
            version: 0,
        }
    }

    fn text(content: &str) -> FlowItem {
        FlowItem::Text {
            content: content.to_string(),
            is_streaming: false,
        }
    }

    fn tool(role_result: Option<&str>) -> FlowItem {
        FlowItem::Tool {
            tool_state: ToolDisplayState {
                tool_id: "tool-1".to_string(),
                tool_name: "Read".to_string(),
                parameters: serde_json::json!({"path": "src/main.rs"}),
                status: ToolDisplayStatus::Success,
                result: role_result.map(str::to_string),
                progress_message: None,
                duration_ms: Some(12),
                metadata: None,
                subagent_progress: None,
            },
        }
    }

    #[test]
    fn safe_markdown_projection_skips_system_reasoning_and_tool_payloads() {
        let mut state = ChatState::new(
            "session-123456789".to_string(),
            "A session\nwith title".to_string(),
            "Standard".to_string(),
            None,
        );
        state.messages = vec![
            message(MessageRole::System, vec![text("local notice")]),
            message(MessageRole::User, vec![text("Please inspect")]),
            message(
                MessageRole::Assistant,
                vec![
                    FlowItem::Thinking {
                        content: "private chain".to_string(),
                    },
                    tool(None),
                    text("Done"),
                ],
            ),
            message(MessageRole::Tool, vec![tool(Some("secret payload"))]),
        ];

        let markdown = render_session_markdown(&state, MarkdownTranscriptOptions::default());

        assert!(
            markdown.starts_with("# A session with title\n"),
            "{markdown}"
        );
        assert!(markdown.contains("**Session ID:** session-123456789"));
        assert!(markdown.contains("## User\n\nPlease inspect"));
        assert!(markdown.contains("## Assistant\n\n**Tool: Read**\n\nDone"));
        assert!(!markdown.contains("local notice"));
        assert!(!markdown.contains("private chain"));
        assert!(!markdown.contains("secret payload"));
        assert!(!markdown.contains("src/main.rs"));
    }

    #[test]
    fn detailed_projection_pairs_tool_results_and_uses_safe_code_fences() {
        let mut state = ChatState::new(
            "session".to_string(),
            "New Session".to_string(),
            "Standard".to_string(),
            None,
        );
        state.messages = vec![
            message(
                MessageRole::Assistant,
                vec![
                    FlowItem::Thinking {
                        content: "considering".to_string(),
                    },
                    tool(None),
                ],
            ),
            message(MessageRole::Tool, vec![tool(Some("output ``` nested"))]),
        ];

        let markdown = render_session_markdown(
            &state,
            MarkdownTranscriptOptions {
                include_reasoning: true,
                include_tool_details: true,
            },
        );

        assert!(markdown.contains("_Thinking:_\n\nconsidering"));
        assert!(markdown.contains("\"path\": \"src/main.rs\""));
        assert!(markdown.contains("output ``` nested"));
        assert!(markdown.contains("````text\noutput ``` nested\n````"));
    }

    #[test]
    fn export_paths_stay_under_the_local_cli_directory() {
        let root = std::path::Path::new("C:/workspace/project");
        assert_eq!(
            resolve_export_target(root, "notes/session.md").unwrap(),
            root.join("notes/session.md")
        );
        for invalid in [
            "",
            "../outside.md",
            "notes/../../outside.md",
            "C:/absolute.md",
            "\\\\server\\share\\x.md",
        ] {
            assert!(resolve_export_target(root, invalid).is_err(), "{invalid}");
        }
    }

    #[test]
    fn default_export_name_uses_a_short_session_id() {
        assert_eq!(
            default_export_filename("123456789abcdef"),
            "session-12345678.md"
        );
        assert_eq!(default_export_filename(""), "session.md");
    }
}
