use super::*;

impl AgentExecutionTool {
    pub(super) fn background_subagent_started_assistant_message(
        agent_id: &str,
        bg_task_id: &str,
    ) -> String {
        format!(
            "Background subagent started successfully.\nagent_id: \"{}\"\nbg_task_id: \"{}\"\nUse AgentWait with this bg_task_id when you need its result. The result will not be delivered automatically.",
            agent_id, bg_task_id
        )
    }
}
