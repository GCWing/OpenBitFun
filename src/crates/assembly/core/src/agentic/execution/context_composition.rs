//! Usage estimates and opt-in preview sources share the same typed category provenance.
use crate::agentic::core::{
    InternalReminderKind, Message, MessageContent, MessageRole, MessageSemanticKind,
};
use crate::util::{types::ToolDefinition, TokenCounter};
use openbitfun_agent_runtime::prompt::PrependedPromptReminders;
use openbitfun_agent_runtime::prompt_markup::render_system_reminder;
use openbitfun_core_types::{UsageContextBreakdown, UsageContextCategory};
use std::collections::BTreeMap;

fn preview_category(message: &Message) -> Option<UsageContextCategory> {
    use UsageContextCategory::*;
    if message.role == MessageRole::System {
        return Some(SystemPrompt);
    }
    if message.metadata.semantic_kind == Some(MessageSemanticKind::CompressionSummary) {
        return None;
    }
    match message.metadata.internal_reminder_kind {
        Some(InternalReminderKind::SkillListingDiff) => Some(Skills),
        Some(InternalReminderKind::AgentListingDiff) => Some(SubagentDefinitions),
        Some(
            InternalReminderKind::ConditionalInstructions | InternalReminderKind::InitAgentsMd,
        ) => Some(Rules),
        _ => match &message.content {
            MessageContent::ToolResult {
                tool_name,
                effective_tool_name,
                ..
            } => match effective_tool_name.as_deref().unwrap_or(tool_name) {
                "GetToolSpec" => Some(McpTools),
                "Skill" => Some(Skills),
                _ => None,
            },
            _ => None,
        },
    }
}

fn json_markdown(value: &impl serde::Serialize) -> Result<String, serde_json::Error> {
    let json = serde_json::to_string_pretty(value)?;
    let fence = "`".repeat(
        json.split(|c| c != '`')
            .map(str::len)
            .max()
            .unwrap_or(0)
            .max(2)
            + 1,
    );
    Ok(format!("{fence}json\n{json}\n{fence}"))
}

pub(super) fn context_preview_contents<'a>(
    messages: impl Iterator<Item = &'a Message>,
    reminders: &PrependedPromptReminders,
    tools: Option<&[ToolDefinition]>,
) -> Result<BTreeMap<UsageContextCategory, String>, serde_json::Error> {
    use UsageContextCategory::*;
    let mut contents: BTreeMap<_, _> = [
        SystemPrompt,
        ToolDefinitions,
        Rules,
        Skills,
        McpTools,
        SubagentDefinitions,
    ]
    .into_iter()
    .map(|category| (category, String::new()))
    .collect();
    let mut append = |category, text: &str| {
        if text.trim().is_empty() {
            return;
        }
        let content = contents.entry(category).or_default();
        if !content.is_empty() {
            content.push_str("\n\n---\n\n");
        }
        content.push_str(text);
    };
    for (category, text) in [
        (SystemPrompt, reminders.runtime_context.as_deref()),
        (Rules, reminders.user_context.as_deref()),
        (Skills, reminders.skill_listing.as_deref()),
        (SubagentDefinitions, reminders.agent_listing.as_deref()),
        (McpTools, reminders.deferred_tool_listing.as_deref()),
        (ToolDefinitions, reminders.ptc_tool_calling_guide.as_deref()),
    ] {
        if let Some(text) = text {
            append(category, text);
        }
    }
    if let Some(tools) = tools.filter(|tools| !tools.is_empty()) {
        append(ToolDefinitions, &json_markdown(&tools)?);
    }
    for message in messages {
        let Some(category) = preview_category(message) else {
            continue;
        };
        match &message.content {
            MessageContent::Text(text)
            | MessageContent::Multimodal { text, .. }
            | MessageContent::Mixed { text, .. } => append(category, text),
            MessageContent::ToolResult {
                result,
                result_for_assistant,
                ..
            } => {
                if let Some(text) = result_for_assistant.as_deref().or_else(|| result.as_str()) {
                    append(category, text);
                } else {
                    append(category, &json_markdown(result)?);
                }
            }
        }
    }
    Ok(contents)
}

pub(super) fn estimate_context_composition<'a>(
    messages: impl Iterator<Item = (&'a Message, u64)>,
    reminders: &PrependedPromptReminders,
    tools: Option<&[ToolDefinition]>,
    context_window: usize,
) -> UsageContextBreakdown {
    let mut result = UsageContextBreakdown {
        context_window: (context_window > 0).then_some(context_window as u64),
        ..Default::default()
    };
    for (message, count) in messages {
        let bucket = match preview_category(message) {
            Some(UsageContextCategory::SystemPrompt) => &mut result.system_prompt,
            Some(UsageContextCategory::Rules) => &mut result.rules,
            Some(UsageContextCategory::Skills) => &mut result.skills,
            Some(UsageContextCategory::McpTools) => &mut result.mcp_tools,
            Some(UsageContextCategory::SubagentDefinitions) => &mut result.subagent_definitions,
            _ if message.metadata.semantic_kind
                == Some(MessageSemanticKind::CompressionSummary) =>
            {
                &mut result.summarized_conversation
            }
            _ => &mut result.conversation,
        };
        *bucket = bucket.saturating_add(count);
    }
    let reminder_tokens = |text: Option<&str>| -> u64 {
        text.filter(|text| !text.trim().is_empty())
            .map(|text| {
                Message::user(render_system_reminder(text.trim()))
                    .estimate_tokens_with_reasoning(false) as u64
            })
            .unwrap_or(0)
    };
    result.system_prompt += reminder_tokens(reminders.runtime_context.as_deref());
    result.rules += reminder_tokens(reminders.user_context.as_deref());
    result.skills += reminder_tokens(reminders.skill_listing.as_deref());
    result.subagent_definitions += reminder_tokens(reminders.agent_listing.as_deref());
    result.mcp_tools += reminder_tokens(reminders.deferred_tool_listing.as_deref());
    result.tool_definitions = tools
        .map(TokenCounter::estimate_tool_definitions_tokens)
        .unwrap_or(0) as u64
        + reminder_tokens(reminders.ptc_tool_calling_guide.as_deref());
    result
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn context_composition_previews_keep_typed_sources_and_model_visible_tool_results() {
        use UsageContextCategory::*;
        let system = Message::system("# System\nExact instructions".into());
        let user = Message::user(
            "<system-reminder>Rules and skills are user text</system-reminder>".into(),
        );
        let mut rules = Message::user("# Conditional rules\nLoaded rules".into());
        rules.metadata.internal_reminder_kind = Some(InternalReminderKind::ConditionalInstructions);
        let mut skill = Message::user(String::new());
        skill.content = MessageContent::ToolResult {
            tool_id: "skill-1".into(),
            tool_name: "Skill".into(),
            effective_tool_name: None,
            result: serde_json::json!({"privateStorageField": "not model visible"}),
            result_for_assistant: Some("# Loaded skill\nSkill body".into()),
            is_error: false,
            image_attachments: None,
        };
        let mut mcp = Message::user(String::new());
        mcp.content = MessageContent::ToolResult {
            tool_id: "spec-1".into(),
            tool_name: "CallTool".into(),
            effective_tool_name: Some("GetToolSpec".into()),
            result: serde_json::json!({"name": "mcp_test", "description": "Schema includes ``` markers"}),
            result_for_assistant: None,
            is_error: false,
            image_attachments: None,
        };
        let tools = [ToolDefinition {
            name: "Read".into(),
            description: "Read a file".into(),
            parameters: serde_json::json!({"type":"object"}),
        }];
        let contents = context_preview_contents(
            [&system, &user, &rules, &skill, &mcp].into_iter(),
            &PrependedPromptReminders {
                runtime_context: Some("Runtime environment".into()),
                user_context: Some("Repository instructions".into()),
                skill_listing: Some("Available skills".into()),
                deferred_tool_listing: Some("Available MCP and dynamic tools".into()),
                agent_listing: Some("Available subagents".into()),
                ptc_tool_calling_guide: Some("PTC guide".into()),
            },
            Some(&tools),
        )
        .unwrap();
        assert!(contents[&SystemPrompt].contains("Runtime environment"));
        assert!(contents[&SystemPrompt].contains("Exact instructions"));
        assert!(contents[&ToolDefinitions].contains("\"parameters\""));
        assert!(contents[&ToolDefinitions].contains("PTC guide"));
        assert!(contents[&Rules].contains("Repository instructions"));
        assert!(contents[&Rules].contains("Conditional rules"));
        assert!(contents[&Skills].contains("Available skills"));
        assert!(contents[&Skills].contains("Skill body"));
        assert!(contents[&McpTools].contains("Available MCP and dynamic tools"));
        assert!(contents[&McpTools].contains("````json"));
        assert!(contents[&SubagentDefinitions].contains("Available subagents"));
        assert!(contents
            .values()
            .all(|text| !text.contains("privateStorageField") && !text.contains("are user text")));
        let empty = context_preview_contents(
            std::iter::empty(),
            &PrependedPromptReminders::default(),
            None,
        )
        .unwrap();
        assert_eq!(empty.len(), 6);
        assert!(empty.values().all(String::is_empty));
    }

    #[test]
    fn context_composition_classifies_deferred_definitions_by_effective_tool() {
        let mut message = Message::user(String::new());
        message.content = MessageContent::ToolResult {
            tool_id: "call-1".into(),
            tool_name: "CallTool".into(),
            effective_tool_name: Some("GetToolSpec".into()),
            result: serde_json::json!({"description": "Dynamic tool schema"}),
            result_for_assistant: None,
            is_error: false,
            image_attachments: None,
        };
        let tokens = message.estimate_tokens_with_reasoning(true) as u64;
        let composition = estimate_context_composition(
            std::iter::once((&message, tokens)),
            &PrependedPromptReminders::default(),
            None,
            128_000,
        );
        assert_eq!(composition.mcp_tools, tokens);
        assert_eq!(composition.conversation, 0);
    }

    #[test]
    fn uses_typed_sources_without_classifying_user_text_as_instructions() {
        let system = Message::system("System instructions".into());
        let user = Message::user("<system-reminder>Skills and rules</system-reminder>".into());
        let mut summary = Message::user("Earlier conversation summary".into());
        summary.metadata.semantic_kind = Some(MessageSemanticKind::CompressionSummary);
        let mut rules = Message::user("Activated repository instructions".into());
        rules.metadata.internal_reminder_kind = Some(InternalReminderKind::ConditionalInstructions);
        let result = estimate_context_composition(
            [&system, &user, &summary, &rules]
                .into_iter()
                .map(|message| (message, message.estimate_tokens_with_reasoning(true) as u64)),
            &PrependedPromptReminders {
                skill_listing: Some("Available skills".into()),
                agent_listing: Some("Available agents".into()),
                deferred_tool_listing: Some("MCP tool definitions".into()),
                ..Default::default()
            },
            None,
            128_000,
        );
        assert_eq!(
            result.conversation,
            user.estimate_tokens_with_reasoning(true) as u64
        );
        assert_eq!(
            result.system_prompt,
            system.estimate_tokens_with_reasoning(true) as u64
        );
        assert_eq!(
            result.rules,
            rules.estimate_tokens_with_reasoning(true) as u64
        );
        assert_eq!(
            result.summarized_conversation,
            summary.estimate_tokens_with_reasoning(true) as u64
        );
        assert!(result.skills > 0 && result.subagent_definitions > 0 && result.mcp_tools > 0);
        assert_eq!(result.tool_definitions, 0);
        assert_eq!(result.context_window, Some(128_000));
    }
}
