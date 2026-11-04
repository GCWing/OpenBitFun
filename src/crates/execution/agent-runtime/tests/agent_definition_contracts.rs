//! Agent definition, discovery, prompt, and skill contracts.
#![cfg(feature = "agent-runtime")]

#[path = "agent_definition_contracts/agent_registry_contracts.rs"]
mod agent_registry_contracts;
#[path = "agent_definition_contracts/custom_agent_mode_contracts.rs"]
mod custom_agent_mode_contracts;
#[path = "agent_definition_contracts/custom_subagent_contracts.rs"]
mod custom_subagent_contracts;
#[path = "agent_definition_contracts/custom_subagent_discovery_contracts.rs"]
mod custom_subagent_discovery_contracts;
#[path = "agent_definition_contracts/prompt_cache_contracts.rs"]
mod prompt_cache_contracts;
#[path = "agent_definition_contracts/prompt_contracts.rs"]
mod prompt_contracts;
#[path = "agent_definition_contracts/skill_contracts.rs"]
mod skill_contracts;
