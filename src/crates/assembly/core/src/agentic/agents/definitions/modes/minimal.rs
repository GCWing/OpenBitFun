use crate::agentic::agents::{Agent, UserContextPolicy};
use async_trait::async_trait;

/// A focused Agent with a stable prompt and tool manifest.
pub struct MinimalHarness {
    default_tools: Vec<String>,
}

impl Default for MinimalHarness {
    fn default() -> Self {
        Self::new()
    }
}

impl MinimalHarness {
    pub fn new() -> Self {
        let default_tools = [
            "Read",
            "Edit",
            "Write",
            "ExecCommand",
            "WriteStdin",
            "ExecControl",
        ]
        .into_iter()
        .map(str::to_string)
        .collect::<Vec<_>>();
        Self { default_tools }
    }
}

#[async_trait]
impl Agent for MinimalHarness {
    fn as_any(&self) -> &dyn std::any::Any {
        self
    }

    fn id(&self) -> &str {
        "Minimal"
    }

    fn name(&self) -> &str {
        "Minimal"
    }

    fn description(&self) -> &str {
        "Minimal Harness for coding with a stable, focused tool set."
    }

    fn prompt_template_name(&self, _model_name: Option<&str>) -> &str {
        "minimal_mode"
    }

    fn default_tools(&self) -> Vec<String> {
        self.default_tools.clone()
    }

    fn user_context_policy(&self) -> UserContextPolicy {
        UserContextPolicy::empty()
            .with_workspace_context()
            .with_workspace_instructions()
    }

    fn include_dynamic_mcp_tools(&self) -> bool {
        false
    }

    fn is_readonly(&self) -> bool {
        false
    }
}

#[cfg(test)]
mod tests {
    use super::MinimalHarness;
    use crate::agentic::agents::Agent;

    #[test]
    fn minimal_manifest_is_stable_and_has_no_listing_tools() {
        let mode = MinimalHarness::new();
        assert_eq!(
            mode.default_tools(),
            [
                "Read",
                "Edit",
                "Write",
                "ExecCommand",
                "WriteStdin",
                "ExecControl"
            ]
            .into_iter()
            .map(str::to_string)
            .collect::<Vec<_>>()
        );
        assert!(!mode.include_dynamic_mcp_tools());
    }
}
