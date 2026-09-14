use super::types::{AgentEntry, AgentSource};
use super::visibility::SubagentVisibilityPolicy;
use super::AgentRegistry;
use crate::agentic::agents::registry::catalog::{builtin_agent_specs, builtin_agent_specs_for_ids};
use crate::agentic::agents::{Agent, AgentCategory, SubAgentSource};
use log::error;
use openbitfun_agent_runtime::agents as runtime_agents;
use std::collections::HashMap;
use std::sync::Arc;

pub(crate) fn default_model_id_for_builtin_agent(agent_type: &str) -> &'static str {
    runtime_agents::default_model_id_for_builtin_agent(agent_type)
}

impl AgentRegistry {
    pub(crate) fn build_builtin_agents() -> HashMap<String, AgentEntry> {
        Self::build_builtin_agents_from_specs(builtin_agent_specs())
    }

    fn build_builtin_agents_for_ids(agent_ids: &[&str]) -> HashMap<String, AgentEntry> {
        Self::build_builtin_agents_from_specs(builtin_agent_specs_for_ids(
            agent_ids.iter().copied(),
        ))
    }

    fn build_builtin_agents_from_specs(
        specs: Vec<crate::agentic::agents::registry::catalog::BuiltinAgentSpec>,
    ) -> HashMap<String, AgentEntry> {
        let mut agents = HashMap::new();

        let register = |agents: &mut HashMap<String, AgentEntry>,
                        agent: Arc<dyn Agent>,
                        category: AgentCategory,
                        subagent_source: Option<SubAgentSource>,
                        visibility_policy: SubagentVisibilityPolicy| {
            let id = agent.id().to_string();
            if agents.contains_key(&id) {
                error!("Agent {} already registered, skip registration", id);
                return;
            }
            agents.insert(
                id,
                AgentEntry {
                    category,
                    source: AgentSource::Builtin,
                    subagent_source,
                    agent,
                    visibility_policy,
                    custom_config: None,
                },
            );
        };

        for spec in specs {
            let source = if spec.category == AgentCategory::SubAgent {
                Some(SubAgentSource::Builtin)
            } else {
                None
            };
            register(
                &mut agents,
                (spec.factory)(),
                spec.category,
                source,
                spec.visibility_policy,
            );
        }

        agents
    }

    /// Create a new agent registry with built-in agents
    pub fn new() -> Self {
        Self::from_builtin_agents(Self::build_builtin_agents())
    }

    pub(crate) fn for_profile(profile: openbitfun_product_capabilities::DeliveryProfile) -> Self {
        let plan = openbitfun_product_capabilities::product_assembly_plan_for_profile(profile);
        Self::from_builtin_agents(Self::build_builtin_agents_for_ids(plan.agent_ids()))
    }

    fn from_builtin_agents(agents: HashMap<String, AgentEntry>) -> Self {
        Self {
            agents: std::sync::RwLock::new(agents),
            project_subagents: std::sync::RwLock::new(HashMap::new()),
            user_custom_agents_loaded: std::sync::RwLock::new(false),
            custom_load_state: tokio::sync::Mutex::new(Default::default()),
            external_subagents: std::sync::Arc::new(
                super::external::ExternalSubagentRegistryState::new(),
            ),
        }
    }

    /// Register a new agent. For custom SubAgent, pass Some(custom_config); for builtin/Mode/Hidden pass None.
    pub fn register_agent(
        &self,
        agent: Arc<dyn Agent>,
        category: AgentCategory,
        source: AgentSource,
        subagent_source: Option<SubAgentSource>,
        custom_config: Option<super::types::CustomAgentConfig>,
    ) {
        let id = agent.id().to_string();
        let visibility_policy = SubagentVisibilityPolicy::public();
        let mut map = self.write_agents();
        if map.contains_key(&id) {
            error!("Agent {} already registered, skip registration", id);
            return;
        }
        map.insert(
            id,
            AgentEntry {
                category,
                source,
                subagent_source,
                agent,
                visibility_policy,
                custom_config,
            },
        );
    }
}
