mod availability;
mod builtin;
pub(super) mod catalog;
mod custom;
mod custom_watch;
mod external;
mod query;
mod resolution;
mod support;
#[cfg(test)]
mod tests;
pub(super) mod types;
pub(super) mod visibility;

use self::types::AgentEntry;
use self::types::{AgentCategory, SubAgentSource};
use super::Agent;
use crate::agentic::deep_review_policy::canonical_review_worker_agent_type;
use log::{debug, warn};
use serde::{Deserialize, Serialize};
use std::collections::HashMap;
use std::path::{Path, PathBuf};
use std::sync::RwLock;
use std::sync::{Arc, OnceLock};

#[cfg(feature = "external-sources")]
pub(crate) use external::external_subagent_runtime_key;
pub use external::{
    ExternalPrimaryAgentTurnBinding, ExternalSubagentGenerationLease,
    ExternalSubagentInvocationBinding, ExternalSubagentModelBinding, ExternalSubagentRegistration,
    ExternalSubagentRoute,
};

/// Full file-backed custom agent definition for editing.
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct CustomAgentDetail {
    pub agent_id: String,
    pub kind: String,
    pub name: String,
    pub description: String,
    pub prompt: String,
    pub tools: Vec<String>,
    pub readonly: bool,
    pub review: bool,
    pub model: String,
    pub path: String,
    pub user_context_policy: Vec<String>,
    /// `"user"` or `"project"`
    pub level: String,
}

pub type CustomSubagentDetail = CustomAgentDetail;

/// Registry for managing all available agents
pub struct AgentRegistry {
    /// id -> agent_entry
    agents: RwLock<HashMap<String, AgentEntry>>,
    /// workspace root -> (project subagent id -> agent_entry)
    project_subagents: RwLock<HashMap<PathBuf, HashMap<String, AgentEntry>>>,
    user_custom_agents_loaded: RwLock<bool>,
    custom_load_state: tokio::sync::Mutex<custom_watch::CustomAgentLoadState>,
    external_subagents: Arc<external::ExternalSubagentRegistryState>,
}

impl Default for AgentRegistry {
    fn default() -> Self {
        Self::new()
    }
}

impl AgentRegistry {
    fn read_agents(&self) -> std::sync::RwLockReadGuard<'_, HashMap<String, AgentEntry>> {
        match self.agents.read() {
            Ok(guard) => guard,
            Err(poisoned) => {
                warn!("Agent registry read lock poisoned, recovering");
                poisoned.into_inner()
            }
        }
    }

    fn write_agents(&self) -> std::sync::RwLockWriteGuard<'_, HashMap<String, AgentEntry>> {
        match self.agents.write() {
            Ok(guard) => guard,
            Err(poisoned) => {
                warn!("Agent registry write lock poisoned, recovering");
                poisoned.into_inner()
            }
        }
    }

    fn read_project_subagents(
        &self,
    ) -> std::sync::RwLockReadGuard<'_, HashMap<PathBuf, HashMap<String, AgentEntry>>> {
        match self.project_subagents.read() {
            Ok(guard) => guard,
            Err(poisoned) => {
                warn!("Agent project registry read lock poisoned, recovering");
                poisoned.into_inner()
            }
        }
    }

    fn write_project_subagents(
        &self,
    ) -> std::sync::RwLockWriteGuard<'_, HashMap<PathBuf, HashMap<String, AgentEntry>>> {
        match self.project_subagents.write() {
            Ok(guard) => guard,
            Err(poisoned) => {
                warn!("Agent project registry write lock poisoned, recovering");
                poisoned.into_inner()
            }
        }
    }

    fn find_agent_entry(
        &self,
        agent_type: &str,
        workspace_root: Option<&Path>,
    ) -> Option<AgentEntry> {
        if let Some(entry) = self.external_subagents.find_generation_entry(agent_type) {
            return Some(entry);
        }
        if let Some(entry) = self.read_agents().get(agent_type).cloned() {
            return Some(entry);
        }

        if let Some(root) = workspace_root {
            let project_subagents = self.read_project_subagents();
            if let Some(entry) = project_subagents
                .get(root)
                .and_then(|entries| entries.get(agent_type).cloned())
            {
                return Some(entry);
            }
        }

        let canonical = openbitfun_core_types::agent_identity::canonical_agent_id(agent_type);
        if canonical != agent_type {
            if let Some(entry) = self.read_agents().get(canonical).cloned() {
                if entry.source == types::AgentSource::Builtin {
                    return Some(entry);
                }
            }
        }
        let canonical = canonical_review_worker_agent_type(agent_type);
        (canonical != agent_type)
            .then(|| self.read_agents().get(canonical).cloned())
            .flatten()
    }

    /// Get a agent by ID (searches all categories including hidden)
    pub fn get_agent(
        &self,
        agent_type: &str,
        workspace_root: Option<&Path>,
    ) -> Option<Arc<dyn Agent>> {
        self.find_agent_entry(agent_type, workspace_root)
            .map(|entry| entry.agent)
    }

    /// Resolve the effective non-external definition that an external route
    /// displaces. Plugin generations use this immutable baseline instead of
    /// accidentally inheriting a previous external generation.
    pub(crate) fn get_local_agent(
        &self,
        agent_type: &str,
        workspace_root: Option<&Path>,
    ) -> Option<Arc<dyn Agent>> {
        if let Some(entry) = self.read_agents().values().find(|entry| {
            entry.source != types::AgentSource::External
                && entry.agent.id().eq_ignore_ascii_case(agent_type)
        }) {
            return Some(entry.agent.clone());
        }
        workspace_root
            .and_then(|root| {
                self.read_project_subagents()
                    .get(root)?
                    .values()
                    .find(|entry| {
                        entry.source != types::AgentSource::External
                            && entry.agent.id().eq_ignore_ascii_case(agent_type)
                    })
                    .cloned()
            })
            .map(|entry| entry.agent)
    }

    /// Check if an agent exists
    pub fn check_agent_exists(&self, agent_type: &str) -> bool {
        self.external_subagents.has_generation(agent_type)
            || self.read_agents().contains_key(agent_type)
            || self
                .read_project_subagents()
                .values()
                .any(|entries| entries.contains_key(agent_type))
            || {
                let canonical = canonical_review_worker_agent_type(agent_type);
                canonical != agent_type && self.read_agents().contains_key(canonical)
            }
    }

    /// Get a mode by ID
    pub fn get_mode_agent(&self, agent_type: &str) -> Option<Arc<dyn Agent>> {
        self.read_agents().get(agent_type).and_then(|e| {
            if e.category == AgentCategory::Mode {
                Some(e.agent.clone())
            } else {
                None
            }
        })
    }

    /// check if a subagent exists with specified source (used for duplicate check before adding)
    pub fn has_subagent(&self, agent_id: &str, source: SubAgentSource) -> bool {
        if self.read_agents().get(agent_id).is_some_and(|e| {
            e.category == AgentCategory::SubAgent && e.subagent_source == Some(source)
        }) {
            return true;
        }

        self.read_project_subagents().values().any(|entries| {
            entries.get(agent_id).is_some_and(|entry| {
                entry.category == AgentCategory::SubAgent && entry.subagent_source == Some(source)
            })
        })
    }

    fn user_custom_agents_loaded(&self) -> bool {
        match self.user_custom_agents_loaded.read() {
            Ok(guard) => *guard,
            Err(poisoned) => {
                warn!("Agent custom-user loaded flag read lock poisoned, recovering");
                *poisoned.into_inner()
            }
        }
    }

    fn set_user_custom_agents_loaded(&self, loaded: bool) {
        match self.user_custom_agents_loaded.write() {
            Ok(mut guard) => *guard = loaded,
            Err(poisoned) => {
                warn!("Agent custom-user loaded flag write lock poisoned, recovering");
                *poisoned.into_inner() = loaded;
            }
        }
    }
}

impl openbitfun_agent_runtime::sdk::RuntimeAgentRegistry for AgentRegistry {
    fn agent_ids(
        &self,
        query: openbitfun_agent_runtime::sdk::RuntimeAgentRegistryQuery<'_>,
    ) -> Vec<String> {
        let mut ids = self.read_agents().keys().cloned().collect::<Vec<_>>();
        if let Some(workspace_root) = query.workspace_root {
            if let Some(entries) = self.read_project_subagents().get(workspace_root) {
                ids.extend(entries.keys().cloned());
            }
        }
        ids.sort();
        ids.dedup();
        ids
    }
}

struct GlobalAgentRegistry {
    profile: Option<openbitfun_product_capabilities::DeliveryProfile>,
    registry: Arc<AgentRegistry>,
}

// Global agent registry singleton
static GLOBAL_AGENT_REGISTRY: OnceLock<GlobalAgentRegistry> = OnceLock::new();

pub(crate) fn initialize_global_agent_registry_for_profile(
    profile: openbitfun_product_capabilities::DeliveryProfile,
) -> Result<Arc<AgentRegistry>, String> {
    if let Some(global) = GLOBAL_AGENT_REGISTRY.get() {
        return if global.profile == Some(profile) {
            Ok(global.registry.clone())
        } else {
            Err(format!(
                "Global agent registry already uses {}; cannot replace it with {}",
                global
                    .profile
                    .map(|selected| selected.to_string())
                    .unwrap_or_else(|| "the compatibility catalog".to_string()),
                profile
            ))
        };
    }

    let _ = GLOBAL_AGENT_REGISTRY.set(GlobalAgentRegistry {
        profile: Some(profile),
        registry: Arc::new(AgentRegistry::for_profile(profile)),
    });
    let global = GLOBAL_AGENT_REGISTRY
        .get()
        .expect("global agent registry must be initialized");
    if global.profile != Some(profile) {
        return Err(format!(
            "Global agent registry concurrently selected {}; requested {}",
            global
                .profile
                .map(|selected| selected.to_string())
                .unwrap_or_else(|| "the compatibility catalog".to_string()),
            profile
        ));
    }
    Ok(global.registry.clone())
}

/// Get the global agent registry
pub fn get_agent_registry() -> Arc<AgentRegistry> {
    GLOBAL_AGENT_REGISTRY
        .get_or_init(|| {
            debug!("Initializing global agent registry");
            GlobalAgentRegistry {
                #[cfg(feature = "product-full")]
                profile: Some(openbitfun_product_capabilities::DeliveryProfile::ProductFull),
                #[cfg(not(feature = "product-full"))]
                profile: None,
                registry: Arc::new(AgentRegistry::new()),
            }
        })
        .registry
        .clone()
}
