//! Claw Mode

use crate::agentic::agents::{Agent, UserContextPolicy};
use async_trait::async_trait;
pub struct ClawMode {
    default_tools: Vec<String>,
}

impl Default for ClawMode {
    fn default() -> Self {
        Self::new()
    }
}

impl ClawMode {
    pub fn new() -> Self {
        Self {
            default_tools: vec![
                "Task".to_string(),
                "ListModels".to_string(),
                "AgentWait".to_string(),
                "Read".to_string(),
                "view_image".to_string(),
                "analyze_image".to_string(),
                "Write".to_string(),
                "Edit".to_string(),
                "Delete".to_string(),
                "ExecCommand".to_string(),
                "WriteStdin".to_string(),
                "ExecControl".to_string(),
                // The companion to ExecCommand for remote work: a server
                // started on an SSH host is unreachable from the user's
                // machine until a forward exists.
                "PortForward".to_string(),
                "Grep".to_string(),
                "Glob".to_string(),
                "WebSearch".to_string(),
                "WebFetch".to_string(),
                "get_goal".to_string(),
                "create_goal".to_string(),
                "update_goal".to_string(),
                "Skill".to_string(),
                "SessionControl".to_string(),
                "SessionMessage".to_string(),
                "SessionHistory".to_string(),
                "Cron".to_string(),
                // Browser, terminal, and routing metadata live under ControlHub.
                // Local desktop/system control is delegated to the ComputerUse
                // agent/tool instead of being surfaced as a ControlHub domain.
                "ControlHub".to_string(),
                "OpenBitFunControl".to_string(),
                "PublishAppearance".to_string(),
                "PageDeploy".to_string(),
                "PagePublish".to_string(),
            ],
        }
    }
}

#[async_trait]
impl Agent for ClawMode {
    fn as_any(&self) -> &dyn std::any::Any {
        self
    }

    fn id(&self) -> &str {
        "Claw"
    }

    fn name(&self) -> &str {
        "Claw"
    }

    fn description(&self) -> &str {
        "Personal assistant for daily tasks"
    }

    fn prompt_template_name(&self, _model_name: Option<&str>) -> &str {
        "claw_mode"
    }

    fn default_tools(&self) -> Vec<String> {
        self.default_tools.clone()
    }

    fn user_context_policy(&self) -> UserContextPolicy {
        UserContextPolicy::empty()
            .with_workspace_context()
            .with_workspace_instructions()
            .with_memory_summary()
    }

    fn is_readonly(&self) -> bool {
        false
    }
}

#[cfg(test)]
mod tests {
    use super::ClawMode;
    use crate::agentic::agents::{Agent, PromptBuilderContext};
    use openbitfun_agent_runtime::prompt::UserContextSection;

    #[test]
    fn claw_mode_excludes_creation_only_tools_from_defaults() {
        let tools = ClawMode::new().default_tools();
        assert!(!tools.contains(&"InitMiniApp".to_string()));
        assert!(!tools.contains(&"FinalizeMiniApp".to_string()));
        assert!(!tools.contains(&"PublishMiniApp".to_string()));
        assert!(!tools.contains(&"FrontendWorkbench".to_string()));
        assert!(tools.contains(&"ListModels".to_string()));
    }

    #[test]
    fn claw_mode_user_context_policy_includes_memory_summary() {
        assert!(ClawMode::new()
            .user_context_policy()
            .includes(UserContextSection::MemorySummary));
    }

    #[tokio::test]
    async fn claw_prompt_conditions_optional_control_and_session_tools() {
        let prompt = ClawMode::new()
            .get_system_prompt(Some(&PromptBuilderContext::new("/workspace", None, None)))
            .await
            .expect("Claw prompt");

        assert!(prompt.contains("only when it appears in your current tool list"));
        assert!(prompt.contains("only when both tools appear in your current tool list"));
    }
}
