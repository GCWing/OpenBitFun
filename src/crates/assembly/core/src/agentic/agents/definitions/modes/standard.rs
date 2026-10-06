//! Standard Harness
//!
//! Uses the shared coding prompt, tools, and user context.

use crate::agentic::agents::{
    standard_harness_tools, standard_harness_user_context_policy, Agent, UserContextPolicy,
    STANDARD_HARNESS_PROMPT_TEMPLATE,
};
use async_trait::async_trait;

pub struct StandardHarness {
    default_tools: Vec<String>,
}

impl Default for StandardHarness {
    fn default() -> Self {
        Self::new()
    }
}

impl StandardHarness {
    pub fn new() -> Self {
        let mut default_tools = standard_harness_tools();
        default_tools.push("ComputerUse".to_string());
        Self { default_tools }
    }
}

#[async_trait]
impl Agent for StandardHarness {
    fn as_any(&self) -> &dyn std::any::Any {
        self
    }

    fn id(&self) -> &str {
        "Standard"
    }

    fn name(&self) -> &str {
        "Standard"
    }

    fn description(&self) -> &str {
        "Standard Harness for software development with task planning, tools, and delegated subagents"
    }

    fn prompt_template_name(&self, _model_name: Option<&str>) -> &str {
        STANDARD_HARNESS_PROMPT_TEMPLATE
    }

    fn default_tools(&self) -> Vec<String> {
        self.default_tools.clone()
    }

    fn user_context_policy(&self) -> UserContextPolicy {
        standard_harness_user_context_policy()
    }

    fn is_readonly(&self) -> bool {
        false
    }
}
