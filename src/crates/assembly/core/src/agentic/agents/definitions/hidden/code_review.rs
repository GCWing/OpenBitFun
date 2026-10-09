//! Independent, read-only code reviewer.

use crate::agentic::agents::{Agent, AgentToolPolicyOverrides, UserContextPolicy};
use crate::agentic::tools::framework::ToolExposure;
use async_trait::async_trait;

pub struct CodeReviewAgent {
    default_tools: Vec<String>,
    tool_exposure_overrides: AgentToolPolicyOverrides,
}

impl CodeReviewAgent {
    pub fn new() -> Self {
        let mut tool_exposure_overrides = AgentToolPolicyOverrides::default();
        tool_exposure_overrides.insert("GetFileDiff".to_string(), ToolExposure::Direct);
        tool_exposure_overrides.insert("LaunchReviewAgent".to_string(), ToolExposure::Deferred);

        Self {
            default_tools: vec![
                "Read".to_string(),
                "Grep".to_string(),
                "Glob".to_string(),
                "LS".to_string(),
                "GetFileDiff".to_string(),
                "LaunchReviewAgent".to_string(),
                "submit_code_review".to_string(),
            ],
            tool_exposure_overrides,
        }
    }
}

impl Default for CodeReviewAgent {
    fn default() -> Self {
        Self::new()
    }
}

#[async_trait]
impl Agent for CodeReviewAgent {
    fn as_any(&self) -> &dyn std::any::Any {
        self
    }

    fn id(&self) -> &str {
        "CodeReview"
    }

    fn name(&self) -> &str {
        "CodeReview"
    }

    fn description(&self) -> &str {
        r#"Independent adversarial, read-only code reviewer. Direct AgentSpawn calls use one isolated instance. Multi-reviewer execution is owned by the unified Review decision and launch plan. Reviewers report evidence-backed findings and never implement fixes."#
    }

    fn prompt_template_name(&self, _model_name: Option<&str>) -> &str {
        "code_review"
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
            .with_project_layout()
    }

    fn is_readonly(&self) -> bool {
        true
    }
}

#[cfg(test)]
mod tests {
    use super::{Agent, CodeReviewAgent};
    use crate::agentic::tools::framework::ToolExposure;

    #[test]
    fn code_review_agent_is_an_independent_readonly_reviewer() {
        let agent = CodeReviewAgent::new();
        let tools = agent.default_tools();

        assert!(tools.contains(&"Read".to_string()));
        assert!(tools.contains(&"Grep".to_string()));
        assert!(tools.contains(&"GetFileDiff".to_string()));
        assert!(tools.contains(&"LaunchReviewAgent".to_string()));
        assert_eq!(
            agent.tool_exposure_overrides().get("GetFileDiff"),
            Some(&ToolExposure::Direct),
        );
        assert_eq!(
            agent.tool_exposure_overrides().get("LaunchReviewAgent"),
            Some(&ToolExposure::Deferred),
        );
        assert!(tools.contains(&"submit_code_review".to_string()));
        assert!(agent.description().contains("one isolated instance"));
        assert!(!agent.description().contains("two or three"));
        assert!(!tools.contains(&"AskUserQuestion".to_string()));
        assert!(!tools.contains(&"Edit".to_string()));
        assert!(!tools.contains(&"Write".to_string()));
        assert!(!tools.contains(&"ExecCommand".to_string()));
        assert!(!tools.contains(&"WriteStdin".to_string()));
        assert!(!tools.contains(&"ExecControl".to_string()));
        assert!(!tools.contains(&"TodoWrite".to_string()));
        assert!(agent.is_readonly());
    }
}
