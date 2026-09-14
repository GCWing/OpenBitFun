//! Computer Use sub-agent
//!
//! Dedicated agent for perceiving and operating the user's local computer.

use crate::agentic::agents::{Agent, AgentToolPolicyOverrides, UserContextPolicy};
use crate::agentic::tools::framework::ToolExposure;
use async_trait::async_trait;

pub struct ComputerUseMode {
    default_tools: Vec<String>,
    tool_exposure_overrides: AgentToolPolicyOverrides,
}

impl Default for ComputerUseMode {
    fn default() -> Self {
        Self::new()
    }
}

impl ComputerUseMode {
    pub fn new() -> Self {
        let mut tool_exposure_overrides = AgentToolPolicyOverrides::default();
        tool_exposure_overrides.insert("ControlHub".to_string(), ToolExposure::Direct);
        tool_exposure_overrides.insert("ComputerUse".to_string(), ToolExposure::Direct);
        Self {
            default_tools: vec![
                "AskUserQuestion".to_string(),
                "TodoWrite".to_string(),
                "Skill".to_string(),
                "view_image".to_string(),
                "analyze_image".to_string(),
                "ExecCommand".to_string(),
                "WriteStdin".to_string(),
                "ExecControl".to_string(),
                "ControlHub".to_string(),
                "OpenBitFunControl".to_string(),
                "ComputerUse".to_string(),
            ],
            tool_exposure_overrides,
        }
    }
}

#[async_trait]
impl Agent for ComputerUseMode {
    fn as_any(&self) -> &dyn std::any::Any {
        self
    }

    fn id(&self) -> &str {
        "ComputerUse"
    }

    fn name(&self) -> &str {
        "Computer Use"
    }

    fn description(&self) -> &str {
        "Dedicated desktop automation agent for perceiving the local environment and operating apps, browsers, and OS UI"
    }

    fn prompt_template_name(&self, _model_name: Option<&str>) -> &str {
        "computer_use_mode"
    }

    fn default_tools(&self) -> Vec<String> {
        self.default_tools.clone()
    }

    fn user_context_policy(&self) -> UserContextPolicy {
        UserContextPolicy::empty()
            .with_workspace_instructions()
            .with_project_layout()
    }

    fn tool_exposure_overrides(&self) -> &AgentToolPolicyOverrides {
        &self.tool_exposure_overrides
    }

    fn is_readonly(&self) -> bool {
        false
    }
}

#[cfg(test)]
mod tests {
    use super::{Agent, ComputerUseMode};
    use crate::agentic::agents::PromptBuilderContext;

    #[test]
    fn computer_use_mode_basics() {
        let agent = ComputerUseMode::new();
        assert_eq!(agent.id(), "ComputerUse");
        assert_eq!(agent.name(), "Computer Use");
        assert_eq!(agent.prompt_template_name(None), "computer_use_mode");
        assert!(agent.default_tools().contains(&"ControlHub".to_string()));
        assert!(agent.default_tools().contains(&"ComputerUse".to_string()));
        assert!(!agent.default_tools().contains(&"Write".to_string()));
        assert!(!agent.is_readonly());
    }

    #[tokio::test]
    async fn computer_use_prompt_conditions_optional_browser_control() {
        let prompt = ComputerUseMode::new()
            .get_system_prompt(Some(&PromptBuilderContext::new("/workspace", None, None)))
            .await
            .expect("ComputerUse prompt");

        assert!(prompt.contains("When `ControlHub` appears in your current tool list"));
        assert!(prompt.contains("If `ControlHub` is unavailable"));
    }
}
