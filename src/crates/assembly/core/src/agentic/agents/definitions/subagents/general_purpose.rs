use crate::agentic::agents::{Agent, UserContextPolicy};
use async_trait::async_trait;

pub struct GeneralPurposeAgent {
    default_tools: Vec<String>,
}

impl Default for GeneralPurposeAgent {
    fn default() -> Self {
        Self::new()
    }
}

impl GeneralPurposeAgent {
    pub fn new() -> Self {
        Self {
            default_tools: vec![
                "Read".to_string(),
                "view_image".to_string(),
                "analyze_image".to_string(),
                "generate_image".to_string(),
                "Glob".to_string(),
                "Grep".to_string(),
                "Write".to_string(),
                "Edit".to_string(),
                "Delete".to_string(),
                "ExecCommand".to_string(),
                "WriteStdin".to_string(),
                "ExecControl".to_string(),
                "WebSearch".to_string(),
                "WebFetch".to_string(),
            ],
        }
    }
}

#[async_trait]
impl Agent for GeneralPurposeAgent {
    fn as_any(&self) -> &dyn std::any::Any {
        self
    }

    fn id(&self) -> &str {
        "GeneralPurpose"
    }

    fn name(&self) -> &str {
        "General Purpose"
    }

    fn description(&self) -> &str {
        r#"General-purpose implementation and research subagent for multi-step tasks that need focused codebase search, targeted file edits."#
    }

    fn prompt_template_name(&self, _model_name: Option<&str>) -> &str {
        "general_purpose_agent"
    }

    fn default_tools(&self) -> Vec<String> {
        self.default_tools.clone()
    }

    fn user_context_policy(&self) -> UserContextPolicy {
        UserContextPolicy::empty()
            .with_workspace_context()
            .with_workspace_instructions()
    }

    fn is_readonly(&self) -> bool {
        false
    }
}
