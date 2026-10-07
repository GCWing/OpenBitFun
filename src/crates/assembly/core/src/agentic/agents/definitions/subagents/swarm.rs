use crate::agentic::agents::Agent;
use crate::agentic::agents::UserContextPolicy;
use async_trait::async_trait;

pub struct SwarmPlannerAgent;

impl Default for SwarmPlannerAgent {
    fn default() -> Self {
        Self::new()
    }
}
impl SwarmPlannerAgent {
    pub fn new() -> Self {
        Self
    }
}

#[async_trait]
impl Agent for SwarmPlannerAgent {
    fn as_any(&self) -> &dyn std::any::Any {
        self
    }
    fn id(&self) -> &str {
        "SwarmPlanner"
    }
    fn name(&self) -> &str {
        "Swarm Planner"
    }
    fn description(&self) -> &str {
        "Recursive planning agent that investigates scope and coordinates Swarm workers."
    }
    fn prompt_template_name(&self, _model_name: Option<&str>) -> &str {
        "swarm_planner_agent"
    }
    fn default_tools(&self) -> Vec<String> {
        [
            "AgentSpawn",
            "AgentSendInput",
            "AgentControl",
            "AgentList",
            "AgentWait",
            "Read",
            "Grep",
            "Glob",
            "ExecCommand",
            "WriteStdin",
            "ExecControl",
        ]
        .into_iter()
        .map(str::to_string)
        .collect()
    }
    fn user_context_policy(&self) -> crate::agentic::agents::UserContextPolicy {
        crate::agentic::agents::UserContextPolicy::empty()
            .with_workspace_context()
            .with_workspace_instructions()
            .with_project_layout()
    }
}

pub struct SwarmReviewerAgent {
    default_tools: Vec<String>,
}

impl Default for SwarmReviewerAgent {
    fn default() -> Self {
        Self::new()
    }
}

impl SwarmReviewerAgent {
    pub fn new() -> Self {
        Self {
            default_tools: [
                "Read",
                "Grep",
                "Glob",
                "ExecCommand",
                "WriteStdin",
                "ExecControl",
            ]
            .into_iter()
            .map(str::to_string)
            .collect(),
        }
    }
}

#[async_trait]
impl Agent for SwarmReviewerAgent {
    fn as_any(&self) -> &dyn std::any::Any {
        self
    }

    fn id(&self) -> &str {
        "SwarmReviewer"
    }

    fn name(&self) -> &str {
        "Swarm Reviewer"
    }

    fn description(&self) -> &str {
        "Read-only reviewer that independently validates a coherent change set from one or more Swarm Workers against their assignments and acceptance criteria."
    }

    fn prompt_template_name(&self, _model_name: Option<&str>) -> &str {
        "swarm_reviewer_agent"
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
        true
    }
}

pub struct SwarmWorkerAgent {
    default_tools: Vec<String>,
}
impl Default for SwarmWorkerAgent {
    fn default() -> Self {
        Self::new()
    }
}
impl SwarmWorkerAgent {
    pub fn new() -> Self {
        Self {
            default_tools: [
                "Read",
                "view_image",
                "analyze_image",
                "Glob",
                "Grep",
                "Write",
                "Edit",
                "Delete",
                "ExecCommand",
                "WriteStdin",
                "ExecControl",
                "WebSearch",
                "WebFetch",
                "Skill",
            ]
            .into_iter()
            .map(str::to_string)
            .collect(),
        }
    }
}
#[async_trait]
impl Agent for SwarmWorkerAgent {
    fn as_any(&self) -> &dyn std::any::Any {
        self
    }
    fn id(&self) -> &str {
        "SwarmWorker"
    }
    fn name(&self) -> &str {
        "Swarm Worker"
    }
    fn description(&self) -> &str {
        "Execution agent for one bounded Swarm work package."
    }
    fn prompt_template_name(&self, _model_name: Option<&str>) -> &str {
        "swarm_worker_agent"
    }
    fn default_tools(&self) -> Vec<String> {
        self.default_tools.clone()
    }
    fn user_context_policy(&self) -> crate::agentic::agents::UserContextPolicy {
        crate::agentic::agents::UserContextPolicy::empty()
            .with_workspace_context()
            .with_workspace_instructions()
            .with_project_layout()
    }
}
