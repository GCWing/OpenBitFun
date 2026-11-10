use crate::agentic::agents::{Agent, UserContextPolicy};
use async_trait::async_trait;

pub(crate) struct PaperWritingAgent;

#[async_trait]
impl Agent for PaperWritingAgent {
    fn as_any(&self) -> &dyn std::any::Any {
        self
    }

    fn id(&self) -> &str {
        "PaperWriting"
    }

    fn name(&self) -> &str {
        "Paper Writing"
    }

    fn description(&self) -> &str {
        "Draft and revise academic papers in a LaTeX workspace, with sources, bibliography, figures, and a compiled PDF."
    }

    fn prompt_template_name(&self, _model_name: Option<&str>) -> &str {
        "paper_writing_agent"
    }

    fn default_tools(&self) -> Vec<String> {
        [
            "Glob",
            "Grep",
            "Read",
            "Edit",
            "Write",
            "WebSearch",
            "WebFetch",
            "ExecCommand",
            "ExecControl",
            "WriteStdin",
            "AskUserQuestion",
            // Every standard primary mode defaults to the thread-goal
            // lifecycle, and the Desktop composer gates its goal affordance on
            // the complete set.
            "get_goal",
            "create_goal",
            "update_goal",
        ]
        .into_iter()
        .map(String::from)
        .collect()
    }

    fn user_context_policy(&self) -> UserContextPolicy {
        UserContextPolicy::empty()
            .with_workspace_context()
            .with_workspace_instructions()
    }
}
