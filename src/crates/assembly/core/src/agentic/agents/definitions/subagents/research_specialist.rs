use crate::define_readonly_subagent_with_context_policy;

define_readonly_subagent_with_context_policy!(
    ResearchSpecialistAgent,
    "ResearchSpecialist",
    "Research Specialist",
    r#"Read-only subagent for **web research**. Has WebSearch (Exa) and WebFetch tools. Use to delegate one focused research role (primary sources, news/timeline, expert analysis, counter-evidence, or competitor profile) so multiple roles can run in parallel without polluting the parent context. The specialist runs 3–5 searches, fetches the most relevant pages, and returns a structured markdown report with claim / URL / direct-quote / authority for each finding. The parent agent is responsible for any file writes — specialists return findings through AgentWait, they do not write to disk."#,
    "research_specialist_agent",
    &["WebSearch", "WebFetch", "Read"],
    crate::agentic::agents::UserContextPolicy::empty()
        .with_workspace_context()
        .with_workspace_instructions()
);

#[cfg(test)]
mod tests {
    use super::ResearchSpecialistAgent;
    use crate::agentic::agents::Agent;

    #[test]
    fn has_web_research_tools() {
        let agent = ResearchSpecialistAgent::new();
        let tools = agent.default_tools();
        assert!(tools.contains(&"WebSearch".to_string()));
        assert!(tools.contains(&"WebFetch".to_string()));
        assert!(tools.contains(&"Read".to_string()));
    }

    #[test]
    fn is_readonly_for_concurrent_dispatch() {
        let agent = ResearchSpecialistAgent::new();
        assert!(
            agent.is_readonly(),
            "ResearchSpecialist must be readonly so multiple specialists can run in parallel via AgentSpawn"
        );
    }

    #[test]
    fn always_uses_default_prompt_template() {
        let agent = ResearchSpecialistAgent::new();
        assert_eq!(
            agent.prompt_template_name(Some("gpt-5.1")),
            "research_specialist_agent"
        );
        assert_eq!(
            agent.prompt_template_name(None),
            "research_specialist_agent"
        );
    }
}
