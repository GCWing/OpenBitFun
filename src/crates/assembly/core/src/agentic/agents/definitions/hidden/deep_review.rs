use crate::agentic::agents::{Agent, AgentToolPolicyOverrides, UserContextPolicy};
use crate::agentic::tools::framework::ToolExposure;
use async_trait::async_trait;

pub struct DeepReviewAgent {
    default_tools: Vec<String>,
    tool_exposure_overrides: AgentToolPolicyOverrides,
}

impl Default for DeepReviewAgent {
    fn default() -> Self {
        Self::new()
    }
}

impl DeepReviewAgent {
    pub fn new() -> Self {
        let mut tool_exposure_overrides = AgentToolPolicyOverrides::default();
        tool_exposure_overrides.insert("GetFileDiff".to_string(), ToolExposure::Direct);

        Self {
            default_tools: vec![
                "LaunchReviewAgent".to_string(),
                "Read".to_string(),
                "Grep".to_string(),
                "Glob".to_string(),
                "LS".to_string(),
                "GetFileDiff".to_string(),
                "submit_code_review".to_string(),
            ],
            tool_exposure_overrides,
        }
    }
}

#[async_trait]
impl Agent for DeepReviewAgent {
    fn as_any(&self) -> &dyn std::any::Any {
        self
    }

    fn id(&self) -> &str {
        "DeepReview"
    }

    fn name(&self) -> &str {
        "DeepReview"
    }

    fn description(&self) -> &str {
        r#"Read-only strict reviewer for substantial changes. It reviews the prepared target directly, may spend its bounded shared allowance on focused checks or a conditional quality check, and submits one evidence-backed report. A separate ReviewFixer owns approved remediation."#
    }

    fn prompt_template_name(&self, _model_name: Option<&str>) -> &str {
        "deep_review_agent"
    }

    fn default_tools(&self) -> Vec<String> {
        self.default_tools.clone()
    }

    fn tool_exposure_overrides(&self) -> &AgentToolPolicyOverrides {
        &self.tool_exposure_overrides
    }

    fn user_context_policy(&self) -> UserContextPolicy {
        UserContextPolicy::empty()
            .with_workspace_context()
            .with_workspace_instructions()
    }

    fn is_readonly(&self) -> bool {
        true
    }
}

#[cfg(test)]
mod tests {
    use super::{Agent, DeepReviewAgent};
    use crate::agentic::tools::framework::ToolExposure;

    #[test]
    fn deep_review_agent_has_optional_validation_tools() {
        let agent = DeepReviewAgent::new();
        let tools = agent.default_tools();

        assert!(tools.contains(&"LaunchReviewAgent".to_string()));
        assert!(!tools.contains(&"Task".to_string()));
        assert_eq!(
            agent.tool_exposure_overrides().get("GetFileDiff"),
            Some(&ToolExposure::Direct),
        );
        assert!(tools.contains(&"submit_code_review".to_string()));
        assert!(!tools.contains(&"AskUserQuestion".to_string()));
        assert!(!tools.contains(&"Edit".to_string()));
        assert!(!tools.contains(&"Write".to_string()));
        assert!(!tools.contains(&"ExecCommand".to_string()));
        assert!(!tools.contains(&"WriteStdin".to_string()));
        assert!(!tools.contains(&"ExecControl".to_string()));
        assert!(agent.is_readonly());
    }
}
