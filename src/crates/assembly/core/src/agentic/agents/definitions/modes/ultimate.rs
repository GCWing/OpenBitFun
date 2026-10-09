use crate::agentic::agents::{Agent, UserContextPolicy};
use async_trait::async_trait;

/// The user-facing entry point for the Swarm planner.
pub struct UltimateHarness {
    default_tools: Vec<String>,
}

impl Default for UltimateHarness {
    fn default() -> Self {
        Self::new()
    }
}

impl UltimateHarness {
    pub fn new() -> Self {
        Self {
            default_tools: [
                "AgentSpawn",
                "AgentSendInput",
                "AgentControl",
                "AgentList",
                "AgentWait",
                "Read",
                "Edit",
                "Write",
                "Delete",
                "Grep",
                "Glob",
                "AskUserQuestion",
                "ExecCommand",
                "WriteStdin",
                "ExecControl",
                "ListModels",
                "Skill",
            ]
            .into_iter()
            .map(str::to_string)
            .collect(),
        }
    }
}

#[async_trait]
impl Agent for UltimateHarness {
    fn as_any(&self) -> &dyn std::any::Any {
        self
    }
    fn id(&self) -> &str {
        "Ultimate"
    }
    fn name(&self) -> &str {
        "Ultimate"
    }
    fn description(&self) -> &str {
        "Ultimate Harness for decomposing complex work into coordinated worker and review tasks. It may issue many model requests concurrently, increasing API cost and provider rate-limit pressure."
    }
    fn prompt_template_name(&self, _model_name: Option<&str>) -> &str {
        "ultimate_mode"
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
