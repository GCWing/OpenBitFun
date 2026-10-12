use crate::agentic::agents::{Agent, AgentToolPolicyOverrides, UserContextPolicy};
use async_trait::async_trait;

pub struct MemoryPhase2Agent {
    default_tools: Vec<String>,
    tool_exposure_overrides: AgentToolPolicyOverrides,
}

impl Default for MemoryPhase2Agent {
    fn default() -> Self {
        Self::new()
    }
}

impl MemoryPhase2Agent {
    pub fn new() -> Self {
        Self {
            default_tools: vec![
                "Read".to_string(),
                "Grep".to_string(),
                "Glob".to_string(),
                "LS".to_string(),
                "Write".to_string(),
                "Edit".to_string(),
                "Delete".to_string(),
            ],
            tool_exposure_overrides: AgentToolPolicyOverrides::default(),
        }
    }
}

#[async_trait]
impl Agent for MemoryPhase2Agent {
    fn as_any(&self) -> &dyn std::any::Any {
        self
    }

    fn id(&self) -> &str {
        "MemoryPhase2"
    }

    fn name(&self) -> &str {
        "Memory Phase 2"
    }

    fn description(&self) -> &str {
        r#"Internal memory consolidation agent for stage-2 workspace synthesis. It reviews the generated memory workspace diff, updates MEMORY.md and memory_summary.md inside the memory workspace, and must not recurse into additional memory generation or launch new agents."#
    }

    fn prompt_template_name(&self, _model_name: Option<&str>) -> &str {
        "phase2_system"
    }

    fn default_tools(&self) -> Vec<String> {
        self.default_tools.clone()
    }

    fn user_context_policy(&self) -> UserContextPolicy {
        UserContextPolicy::empty()
            .with_workspace_context()
            .with_workspace_instructions()
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
    use super::{Agent, MemoryPhase2Agent};
    use crate::agentic::agents::{PromptBuilderContext, UserContextPolicy};
    use crate::agentic::memories::workspace::memory_root_dir;

    #[test]
    fn memory_phase2_agent_is_writable_and_workspace_bound_without_recursive_tools() {
        let agent = MemoryPhase2Agent::new();
        assert!(!agent.is_readonly());
        assert_eq!(
            agent.user_context_policy(),
            UserContextPolicy::empty()
                .with_workspace_context()
                .with_workspace_instructions()
        );
        assert!(agent.default_tools().contains(&"Read".to_string()));
        assert!(agent.default_tools().contains(&"Write".to_string()));
        assert!(agent.default_tools().contains(&"Edit".to_string()));
        assert!(!agent.default_tools().contains(&"Task".to_string()));
        assert_eq!(agent.prompt_template_name(None), "phase2_system");
    }

    #[tokio::test]
    async fn memory_phase2_agent_prompt_is_embedded() {
        let agent = MemoryPhase2Agent::new();
        let context =
            PromptBuilderContext::new("memory/workspace", Some("session-1".to_string()), None);

        let prompt = agent
            .build_prompt(&context)
            .await
            .expect("MemoryPhase2 prompt should be embedded");

        assert!(prompt.contains("Memory Writing Agent: Phase 2"));
        assert!(prompt.contains("memory_summary.md"));
        assert!(prompt.contains(&memory_root_dir().to_string_lossy().replace('\\', "/")));
        assert!(prompt.contains("phase2_workspace_diff.md"));
        assert!(!prompt.contains("{MEMORY_ROOT}"));
    }
}
