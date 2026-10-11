use crate::agentic::agents::{Agent, UserContextPolicy};
use async_trait::async_trait;

pub struct DeepResearchMode {
    default_tools: Vec<String>,
}

impl Default for DeepResearchMode {
    fn default() -> Self {
        Self::new()
    }
}

impl DeepResearchMode {
    pub fn new() -> Self {
        Self {
            default_tools: vec![
                "AgentSpawn".to_string(),
                "AgentSendInput".to_string(),
                "AgentControl".to_string(),
                "AgentList".to_string(),
                "ListModels".to_string(),
                "AgentWait".to_string(),
                "WebSearch".to_string(),
                "WebFetch".to_string(),
                "get_goal".to_string(),
                "create_goal".to_string(),
                "update_goal".to_string(),
                "Read".to_string(),
                "view_image".to_string(),
                "analyze_image".to_string(),
                "Grep".to_string(),
                "Glob".to_string(),
                "Write".to_string(),
                "Edit".to_string(),
                "ExecCommand".to_string(),
                "WriteStdin".to_string(),
                "ExecControl".to_string(),
                // The companion to ExecCommand for remote work: a server
                // started on an SSH host is unreachable from the user's
                // machine until a forward exists.
                "PortForward".to_string(),
                "ControlHub".to_string(),
                // Standing research ("re-check these sources every morning")
                // belongs on a schedule, and ControlHub's `wait` points here
                // rather than at an hour-long turn.
                "Cron".to_string(),
                "AskUserQuestion".to_string(),
            ],
        }
    }
}

#[async_trait]
impl Agent for DeepResearchMode {
    fn as_any(&self) -> &dyn std::any::Any {
        self
    }

    fn id(&self) -> &str {
        "DeepResearch"
    }

    fn name(&self) -> &str {
        "Deep Research"
    }

    fn description(&self) -> &str {
        r#"Produces an evidence-driven deep-research report on any subject through a 6-phase quality pipeline: (1) query understanding + sub-question decomposition with user confirmation, (2) four parallel specialists gather primary sources, news/timeline, expert opinion, and counter-evidence, (3) every claim is registered as a citable cit_XXX entry, (4) two rounds of adversarial debate (Advocate vs Critic) stress-test the findings, (5) a fact checker classifies HARD_CONFLICT / GENUINE_UNCERTAINTY / UNVERIFIED, (6) a research manager arbitrates each sub-question and writes the final report. Designed for questions where source quality, contested points, and traceable reasoning matter — controversies, market analyses, technical comparisons, and open-ended investigative topics."#
    }

    fn prompt_template_name(&self, _model_name: Option<&str>) -> &str {
        "deep_research_mode"
    }

    fn default_tools(&self) -> Vec<String> {
        self.default_tools.clone()
    }

    fn user_context_policy(&self) -> UserContextPolicy {
        UserContextPolicy::empty()
            .with_workspace_context()
            .with_workspace_instructions()
            .with_project_layout()
    }

    fn is_readonly(&self) -> bool {
        false
    }
}

#[cfg(test)]
mod tests {
    use super::{Agent, DeepResearchMode};

    #[test]
    fn has_expected_default_tools() {
        let agent = DeepResearchMode::new();
        let tools = agent.default_tools();
        for tool in [
            "AgentSpawn",
            "AgentSendInput",
            "AgentControl",
            "AgentList",
            "AgentWait",
        ] {
            assert!(
                tools.contains(&tool.to_string()),
                "{tool} required for sub-agent orchestration"
            );
        }
        assert!(!tools.contains(&"Task".to_string()));
        assert!(tools.contains(&"ListModels".to_string()));
        assert!(tools.contains(&"WebSearch".to_string()));
        assert!(tools.contains(&"WebFetch".to_string()));
        assert!(tools.contains(&"Write".to_string()));
        assert!(
            tools.contains(&"Edit".to_string()),
            "Edit required for targeted file updates during research synthesis"
        );
        assert!(tools.contains(&"ExecCommand".to_string()));
        assert!(tools.contains(&"WriteStdin".to_string()));
        assert!(tools.contains(&"ExecControl".to_string()));
        assert!(tools.contains(&"ControlHub".to_string()));
        assert!(
            tools.contains(&"AskUserQuestion".to_string()),
            "AskUserQuestion required for Phase 0 plan confirmation and Phase 5 GAP fill"
        );
    }

    #[test]
    fn always_uses_default_prompt_template() {
        let agent = DeepResearchMode::new();
        assert_eq!(
            agent.prompt_template_name(Some("gpt-5.1")),
            "deep_research_mode"
        );
        assert_eq!(agent.prompt_template_name(None), "deep_research_mode");
    }
}
