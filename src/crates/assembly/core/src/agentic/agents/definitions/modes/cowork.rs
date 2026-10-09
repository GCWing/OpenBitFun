//! Cowork Mode
//!
//! A collaborative mode that prioritizes early clarification and lightweight progress tracking.

use crate::agentic::agents::{Agent, UserContextPolicy};
use async_trait::async_trait;

pub struct CoworkMode {
    default_tools: Vec<String>,
}

impl Default for CoworkMode {
    fn default() -> Self {
        Self::new()
    }
}

impl CoworkMode {
    pub fn new() -> Self {
        Self {
            default_tools: vec![
                // Clarification + planning helpers
                "AskUserQuestion".to_string(),
                "TodoWrite".to_string(),
                "get_goal".to_string(),
                "create_goal".to_string(),
                "update_goal".to_string(),
                "AgentSpawn".to_string(),
                "AgentSendInput".to_string(),
                "AgentControl".to_string(),
                "AgentList".to_string(),
                "ListModels".to_string(),
                "AgentWait".to_string(),
                "Skill".to_string(),
                // Discovery + editing
                "LS".to_string(),
                "Read".to_string(),
                "view_image".to_string(),
                "analyze_image".to_string(),
                "Grep".to_string(),
                "Glob".to_string(),
                "Write".to_string(),
                "Edit".to_string(),
                "Delete".to_string(),
                // Utilities
                "GetFileDiff".to_string(),
                "ExecCommand".to_string(),
                "WriteStdin".to_string(),
                "ExecControl".to_string(),
                // The companion to ExecCommand for remote work: a server
                // started on an SSH host is unreachable from the user's
                // machine until a forward exists.
                "PortForward".to_string(),
                "WebSearch".to_string(),
                "WebFetch".to_string(),
                "ControlHub".to_string(),
                "ComputerUse".to_string(),
                // Recurring office work ("check these channels every 30
                // minutes") is squarely this mode's job, and ControlHub's
                // `wait` sends schedules here rather than pinning a turn open
                // for the interval.
                "Cron".to_string(),
                "PublishAppearance".to_string(),
            ],
        }
    }
}

#[async_trait]
impl Agent for CoworkMode {
    fn as_any(&self) -> &dyn std::any::Any {
        self
    }

    fn id(&self) -> &str {
        "Cowork"
    }

    fn name(&self) -> &str {
        "Cowork"
    }

    fn description(&self) -> &str {
        "Office and collaboration mode for documents, research, drafting, and structured multi-step work"
    }

    fn prompt_template_name(&self, _model_name: Option<&str>) -> &str {
        "cowork_mode"
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
    use super::CoworkMode;
    use crate::agentic::agents::Agent;

    #[test]
    fn cowork_mode_includes_goal_lifecycle_tools_in_defaults() {
        let tools = CoworkMode::new().default_tools();
        for tool in ["get_goal", "create_goal", "update_goal"] {
            assert!(tools.contains(&tool.to_string()));
        }
    }

    #[test]
    fn cowork_mode_can_schedule_recurring_work() {
        // Asked to sweep a set of channels every 30 minutes, this mode used to
        // reply that it had no cron tool — accurately, because Cron was not in
        // its list — and fall back to chaining long waits.
        let tools = CoworkMode::new().default_tools();
        assert!(tools.contains(&"Cron".to_string()));
    }

    #[test]
    fn cowork_mode_excludes_creation_only_tools_from_defaults() {
        let tools = CoworkMode::new().default_tools();
        assert!(!tools.contains(&"InitMiniApp".to_string()));
        assert!(!tools.contains(&"FinalizeMiniApp".to_string()));
        assert!(!tools.contains(&"PublishMiniApp".to_string()));
        assert!(!tools.contains(&"FrontendWorkbench".to_string()));
        assert!(tools.contains(&"ListModels".to_string()));
    }
}
