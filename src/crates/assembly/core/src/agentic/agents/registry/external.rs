use super::types::{AgentCategory, AgentEntry, AgentInfo, AgentSource, SubAgentSource};
use super::AgentRegistry;
use crate::agentic::agents::{Agent, SubagentVisibilityPolicy};
use crate::agentic::deep_review_policy::{
    CODE_REVIEW_AGENT_TYPE, DEEP_REVIEW_AGENT_TYPE, REVIEW_FIXER_AGENT_TYPE,
};
use log::{debug, warn};
use openbitfun_agent_runtime::prompt_cache::prompt_cache_scope_key;
use openbitfun_core_types::{
    SessionAgentRouteOwner, SessionContinuationPolicy, SessionModelBindingPolicy,
};
use openbitfun_product_domains::external_sources::EcosystemId;
use openbitfun_product_domains::external_subagents::ExternalSubagentMode;
use std::collections::{BTreeMap, HashMap, HashSet};
use std::sync::{Arc, RwLock, Weak};

#[cfg(feature = "external-sources")]
pub(crate) const EXTERNAL_SUBAGENT_RUNTIME_KEY_PREFIX: &str = "external_subagent_runtime:";

#[cfg(feature = "external-sources")]
pub(crate) fn external_subagent_runtime_key(digest: &str) -> String {
    format!("{EXTERNAL_SUBAGENT_RUNTIME_KEY_PREFIX}{digest}")
}

#[derive(Clone, Debug, PartialEq, Eq)]
pub enum ExternalSubagentModelBinding {
    Fixed {
        model_id: String,
        configuration_fingerprint: String,
    },
    InheritParent,
}

impl ExternalSubagentModelBinding {
    pub fn fixed_model_id(&self) -> Option<&str> {
        match self {
            Self::Fixed { model_id, .. } => Some(model_id),
            Self::InheritParent => None,
        }
    }

    pub fn configuration_fingerprint(&self) -> Option<&str> {
        match self {
            Self::Fixed {
                configuration_fingerprint,
                ..
            } => Some(configuration_fingerprint),
            Self::InheritParent => None,
        }
    }
}

#[derive(Clone)]
pub struct ExternalSubagentRegistration {
    pub runtime_key: String,
    pub logical_id: String,
    pub route_key: String,
    pub ecosystem_id: EcosystemId,
    pub provider_label: String,
    pub model_binding: ExternalSubagentModelBinding,
    pub hidden: bool,
    pub mode: ExternalSubagentMode,
    pub agent: Arc<dyn Agent>,
}

#[derive(Clone, Copy)]
enum ExternalAgentProjection {
    Primary,
    Subagent,
}

impl ExternalAgentProjection {
    fn is_supported_by(self, mode: ExternalSubagentMode) -> bool {
        match self {
            Self::Primary => mode.supports_primary(),
            Self::Subagent => mode.supports_subagent(),
        }
    }
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub enum ExternalSubagentRoute {
    Local,
    External(String),
    Unavailable,
}

#[derive(Clone)]
struct ExternalSubagentGenerationEntry {
    registration: ExternalSubagentRegistration,
    agent_entry: AgentEntry,
    lease_count: usize,
}

pub(super) struct ExternalSubagentRegistryState {
    generations: RwLock<HashMap<String, ExternalSubagentGenerationEntry>>,
    workspace_routes: RwLock<HashMap<String, BTreeMap<String, ExternalSubagentRoute>>>,
    workspace_route_overlays:
        RwLock<HashMap<String, BTreeMap<String, BTreeMap<String, ExternalSubagentRoute>>>>,
}

impl ExternalSubagentRegistryState {
    pub(super) fn new() -> Self {
        Self {
            generations: RwLock::new(HashMap::new()),
            workspace_routes: RwLock::new(HashMap::new()),
            workspace_route_overlays: RwLock::new(HashMap::new()),
        }
    }

    fn read_generations(
        &self,
    ) -> std::sync::RwLockReadGuard<'_, HashMap<String, ExternalSubagentGenerationEntry>> {
        self.generations
            .read()
            .unwrap_or_else(std::sync::PoisonError::into_inner)
    }

    fn write_generations(
        &self,
    ) -> std::sync::RwLockWriteGuard<'_, HashMap<String, ExternalSubagentGenerationEntry>> {
        self.generations
            .write()
            .unwrap_or_else(std::sync::PoisonError::into_inner)
    }

    fn read_routes(
        &self,
    ) -> std::sync::RwLockReadGuard<'_, HashMap<String, BTreeMap<String, ExternalSubagentRoute>>>
    {
        self.workspace_routes
            .read()
            .unwrap_or_else(std::sync::PoisonError::into_inner)
    }

    fn write_routes(
        &self,
    ) -> std::sync::RwLockWriteGuard<'_, HashMap<String, BTreeMap<String, ExternalSubagentRoute>>>
    {
        self.workspace_routes
            .write()
            .unwrap_or_else(std::sync::PoisonError::into_inner)
    }

    fn read_route_overlays(
        &self,
    ) -> std::sync::RwLockReadGuard<
        '_,
        HashMap<String, BTreeMap<String, BTreeMap<String, ExternalSubagentRoute>>>,
    > {
        self.workspace_route_overlays
            .read()
            .unwrap_or_else(std::sync::PoisonError::into_inner)
    }

    fn write_route_overlays(
        &self,
    ) -> std::sync::RwLockWriteGuard<
        '_,
        HashMap<String, BTreeMap<String, BTreeMap<String, ExternalSubagentRoute>>>,
    > {
        self.workspace_route_overlays
            .write()
            .unwrap_or_else(std::sync::PoisonError::into_inner)
    }

    fn effective_routes_for_workspace(
        &self,
        workspace_id: &str,
    ) -> BTreeMap<String, ExternalSubagentRoute> {
        let mut effective = self
            .read_routes()
            .get(workspace_id)
            .cloned()
            .unwrap_or_default();
        if let Some(overlays) = self.read_route_overlays().get(workspace_id) {
            // Owner keys provide deterministic overlay precedence. The
            // OpenCode Config owner is currently the only overlay publisher;
            // unlike the base table, removing it reveals the latest route
            // published by another external-source owner.
            for routes in overlays.values() {
                effective.extend(routes.clone());
            }
        }
        effective
    }

    pub(super) fn find_generation_entry(&self, runtime_key: &str) -> Option<AgentEntry> {
        self.read_generations()
            .get(runtime_key)
            .map(|entry| entry.agent_entry.clone())
    }

    /// Resolve a user-facing logical Agent id through the external route table
    /// for one workspace. External generations are keyed by an opaque runtime
    /// key, while sessions and product surfaces use the logical id.
    pub(super) fn find_external_route_entry(
        &self,
        logical_id: &str,
        workspace_id: &str,
    ) -> Option<AgentEntry> {
        let workspace_id = workspace_id.to_owned();
        let logical_key = normalize_external_logical_id(logical_id);
        let runtime_key = match self
            .effective_routes_for_workspace(&workspace_id)
            .get(&logical_key)?
        {
            ExternalSubagentRoute::External(runtime_key) => runtime_key.clone(),
            ExternalSubagentRoute::Local | ExternalSubagentRoute::Unavailable => return None,
        };
        self.find_generation_entry(&runtime_key)
    }

    pub(super) fn has_generation(&self, runtime_key: &str) -> bool {
        self.read_generations().contains_key(runtime_key)
    }

    fn prune_unrouted_generations(&self) {
        let mut routed = self
            .read_routes()
            .values()
            .flat_map(BTreeMap::values)
            .filter_map(|route| match route {
                ExternalSubagentRoute::External(runtime_key) => Some(runtime_key.clone()),
                ExternalSubagentRoute::Local | ExternalSubagentRoute::Unavailable => None,
            })
            .collect::<HashSet<_>>();
        routed.extend(
            self.read_route_overlays()
                .values()
                .flat_map(BTreeMap::values)
                .flat_map(BTreeMap::values)
                .filter_map(|route| match route {
                    ExternalSubagentRoute::External(runtime_key) => Some(runtime_key.clone()),
                    ExternalSubagentRoute::Local | ExternalSubagentRoute::Unavailable => None,
                }),
        );
        self.write_generations()
            .retain(|runtime_key, entry| entry.lease_count > 0 || routed.contains(runtime_key));
    }

    fn acquire_matching(
        self: &Arc<Self>,
        runtime_key: &str,
        expected_ecosystem_id: Option<&EcosystemId>,
        projection: ExternalAgentProjection,
    ) -> Option<ExternalSubagentInvocationBinding> {
        let mut generations = self.write_generations();
        let entry = generations.get_mut(runtime_key)?;
        if expected_ecosystem_id
            .is_some_and(|expected| expected != &entry.registration.ecosystem_id)
        {
            return None;
        }
        if !projection.is_supported_by(entry.registration.mode) {
            return None;
        }
        entry.lease_count = entry.lease_count.saturating_add(1);
        Some(ExternalSubagentInvocationBinding {
            runtime_agent_key: runtime_key.to_string(),
            logical_id: entry.registration.logical_id.clone(),
            supports_follow_up: false,
            continuation_policy: SessionContinuationPolicy::FreshOnly,
            model_binding_policy: SessionModelBindingPolicy::ApprovedImmutable,
            lease: Some(ExternalSubagentGenerationLease {
                state: Arc::downgrade(self),
                runtime_key: runtime_key.to_string(),
                model_binding: entry.registration.model_binding.clone(),
            }),
        })
    }

    fn acquire(self: &Arc<Self>, runtime_key: &str) -> Option<ExternalSubagentInvocationBinding> {
        self.acquire_matching(runtime_key, None, ExternalAgentProjection::Subagent)
    }

    fn acquire_primary(
        self: &Arc<Self>,
        runtime_key: &str,
    ) -> Option<ExternalPrimaryAgentTurnBinding> {
        let mut generations = self.write_generations();
        let entry = generations.get_mut(runtime_key)?;
        if !entry.registration.mode.supports_primary() {
            return None;
        }
        entry.lease_count = entry.lease_count.saturating_add(1);
        let model_binding = entry.registration.model_binding.clone();
        Some(ExternalPrimaryAgentTurnBinding {
            runtime_agent_key: runtime_key.to_string(),
            route_key: Some(entry.registration.route_key.clone()),
            model_binding: Some(model_binding.clone()),
            route_owner: SessionAgentRouteOwner::External,
            lease: Some(ExternalSubagentGenerationLease {
                state: Arc::downgrade(self),
                runtime_key: runtime_key.to_string(),
                model_binding,
            }),
        })
    }

    fn release(&self, runtime_key: &str) {
        if let Some(entry) = self.write_generations().get_mut(runtime_key) {
            entry.lease_count = entry.lease_count.saturating_sub(1);
        }
        self.prune_unrouted_generations();
    }
}

pub struct ExternalSubagentGenerationLease {
    state: Weak<ExternalSubagentRegistryState>,
    runtime_key: String,
    model_binding: ExternalSubagentModelBinding,
}

impl std::fmt::Debug for ExternalSubagentGenerationLease {
    fn fmt(&self, formatter: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        formatter
            .debug_struct("ExternalSubagentGenerationLease")
            .field("runtime_key", &self.runtime_key)
            .field("model_binding", &self.model_binding)
            .finish_non_exhaustive()
    }
}

impl Clone for ExternalSubagentGenerationLease {
    fn clone(&self) -> Self {
        if let Some(state) = self.state.upgrade() {
            if let Some(entry) = state.write_generations().get_mut(&self.runtime_key) {
                entry.lease_count = entry.lease_count.saturating_add(1);
            }
        }
        Self {
            state: self.state.clone(),
            runtime_key: self.runtime_key.clone(),
            model_binding: self.model_binding.clone(),
        }
    }
}

impl ExternalSubagentGenerationLease {
    pub fn model_binding(&self) -> &ExternalSubagentModelBinding {
        &self.model_binding
    }
}

impl Drop for ExternalSubagentGenerationLease {
    fn drop(&mut self) {
        if let Some(state) = self.state.upgrade() {
            state.release(&self.runtime_key);
        }
    }
}

pub struct ExternalSubagentInvocationBinding {
    pub runtime_agent_key: String,
    pub logical_id: String,
    pub supports_follow_up: bool,
    pub continuation_policy: SessionContinuationPolicy,
    pub model_binding_policy: SessionModelBindingPolicy,
    pub lease: Option<ExternalSubagentGenerationLease>,
}

pub struct ExternalPrimaryAgentTurnBinding {
    pub runtime_agent_key: String,
    pub route_key: Option<String>,
    pub model_binding: Option<ExternalSubagentModelBinding>,
    pub route_owner: SessionAgentRouteOwner,
    pub lease: Option<ExternalSubagentGenerationLease>,
}

impl AgentRegistry {
    pub(super) fn find_external_route_entry(
        &self,
        logical_id: &str,
        workspace_id: &str,
    ) -> Option<AgentEntry> {
        self.external_subagents
            .find_external_route_entry(logical_id, workspace_id)
    }

    /// Returns whether the logical id is owned by an external route in the
    /// requested workspace. `Unavailable` remains externally owned so a
    /// withdrawn candidate cannot expose a same-name local mutation path.
    pub fn is_external_subagent_route(&self, logical_id: &str, workspace_id: Option<&str>) -> bool {
        let logical_key = normalize_external_logical_id(logical_id);
        let is_external = |route: &ExternalSubagentRoute| {
            matches!(
                route,
                ExternalSubagentRoute::External(_) | ExternalSubagentRoute::Unavailable
            )
        };
        workspace_id.is_some_and(|workspace| {
            let workspace = workspace.to_owned();
            self.external_subagents
                .effective_routes_for_workspace(&workspace)
                .get(&logical_key)
                .is_some_and(is_external)
        })
    }

    pub fn install_external_subagent_routes(
        &self,
        workspace_id: &str,
        registrations: Vec<ExternalSubagentRegistration>,
        routes: BTreeMap<String, ExternalSubagentRoute>,
    ) {
        self.install_external_subagent_routes_with_policy(
            workspace_id,
            registrations,
            routes,
            true,
        );
    }

    /// Atomically publish a complete, validated external route generation.
    /// Routes omitted by the new generation are intentionally released so a
    /// same-name local Agent becomes visible again.
    pub fn replace_external_subagent_routes(
        &self,
        workspace_id: &str,
        registrations: Vec<ExternalSubagentRegistration>,
        routes: BTreeMap<String, ExternalSubagentRoute>,
    ) {
        self.install_external_subagent_routes_with_policy(
            workspace_id,
            registrations,
            routes,
            false,
        );
    }

    fn install_external_subagent_routes_with_policy(
        &self,
        workspace_id: &str,
        registrations: Vec<ExternalSubagentRegistration>,
        routes: BTreeMap<String, ExternalSubagentRoute>,
        preserve_missing_external_routes: bool,
    ) {
        let workspace_id = workspace_id.to_owned();
        {
            let mut generations = self.external_subagents.write_generations();
            for registration in registrations {
                let runtime_key = registration.runtime_key.clone();
                let lease_count = generations
                    .get(&runtime_key)
                    .map_or(0, |entry| entry.lease_count);
                let agent_entry = AgentEntry {
                    category: AgentCategory::SubAgent,
                    source: AgentSource::External,
                    subagent_source: Some(SubAgentSource::External),
                    agent: registration.agent.clone(),
                    visibility_policy: SubagentVisibilityPolicy::public(),
                    custom_config: None,
                };
                generations.insert(
                    runtime_key,
                    ExternalSubagentGenerationEntry {
                        registration,
                        agent_entry,
                        lease_count,
                    },
                );
            }
        }
        let mut routes = routes
            .into_iter()
            .map(|(logical_id, route)| (normalize_external_logical_id(&logical_id), route))
            .collect::<BTreeMap<_, _>>();
        let previous = self
            .external_subagents
            .read_routes()
            .get(&workspace_id)
            .cloned()
            .unwrap_or_default();
        // Discovery and temporary-unavailable updates preserve missing
        // external ownership. A validated plugin generation replacement does
        // not, because removing a contributed Agent must restore local routing.
        for (logical_id, previous_route) in previous {
            if preserve_missing_external_routes
                && !routes.contains_key(&logical_id)
                && matches!(
                    previous_route,
                    ExternalSubagentRoute::External(_) | ExternalSubagentRoute::Unavailable
                )
            {
                routes.insert(logical_id, ExternalSubagentRoute::Unavailable);
            }
        }
        self.external_subagents
            .write_routes()
            .insert(workspace_id, routes);
        self.external_subagents.prune_unrouted_generations();
    }

    pub fn release_external_subagent_workspace(&self, workspace_id: &str) {
        let workspace_id = workspace_id.to_owned();
        self.external_subagents.write_routes().remove(&workspace_id);
        self.external_subagents.prune_unrouted_generations();
    }

    /// Publish a complete route overlay owned by one extension source.
    /// Replacing or removing this owner never mutates the base external-source
    /// routes for the workspace.
    pub fn replace_external_subagent_route_overlay(
        &self,
        workspace_id: &str,
        owner: &str,
        registrations: Vec<ExternalSubagentRegistration>,
        routes: BTreeMap<String, ExternalSubagentRoute>,
    ) {
        let workspace_id = workspace_id.to_owned();
        let routes = routes
            .into_iter()
            .map(|(logical_id, route)| (normalize_external_logical_id(&logical_id), route))
            .collect();
        // Hold the overlay publication lock before making its generations
        // visible. A concurrent base-route refresh may prune generations, but
        // it cannot observe the new entries without also observing this route
        // overlay.
        let mut overlays = self.external_subagents.write_route_overlays();
        {
            let mut generations = self.external_subagents.write_generations();
            for registration in registrations {
                let runtime_key = registration.runtime_key.clone();
                let lease_count = generations
                    .get(&runtime_key)
                    .map_or(0, |entry| entry.lease_count);
                let agent_entry = AgentEntry {
                    category: AgentCategory::SubAgent,
                    source: AgentSource::External,
                    subagent_source: Some(SubAgentSource::External),
                    agent: registration.agent.clone(),
                    visibility_policy: SubagentVisibilityPolicy::public(),
                    custom_config: None,
                };
                generations.insert(
                    runtime_key,
                    ExternalSubagentGenerationEntry {
                        registration,
                        agent_entry,
                        lease_count,
                    },
                );
            }
        }
        let workspace_overlays = overlays.entry(workspace_id).or_default();
        workspace_overlays.insert(owner.to_string(), routes);
        drop(overlays);
        self.external_subagents.prune_unrouted_generations();
    }

    pub fn release_external_subagent_route_overlay(&self, workspace_id: &str, owner: &str) {
        let workspace_id = workspace_id.to_owned();
        let mut overlays = self.external_subagents.write_route_overlays();
        if let Some(workspace_overlays) = overlays.get_mut(&workspace_id) {
            workspace_overlays.remove(owner);
            if workspace_overlays.is_empty() {
                overlays.remove(&workspace_id);
            }
        }
        drop(overlays);
        self.external_subagents.prune_unrouted_generations();
    }

    pub fn resolve_subagent_for_fresh_invocation(
        &self,
        logical_id: &str,
        workspace_id: Option<&str>,
        external_sources_supported: bool,
    ) -> Option<ExternalSubagentInvocationBinding> {
        let logical_key = normalize_external_logical_id(logical_id);
        if external_sources_supported {
            if let Some(workspace_id) = workspace_id {
                let workspace_key = workspace_id.to_owned();
                if let Some(route) = self
                    .external_subagents
                    .effective_routes_for_workspace(&workspace_key)
                    .get(&logical_key)
                    .cloned()
                {
                    return match route {
                        ExternalSubagentRoute::Local => self
                            .find_agent_entry(logical_id, Some(workspace_id))
                            .map(|entry| local_binding(logical_id, entry.agent.id())),
                        ExternalSubagentRoute::External(runtime_key) => {
                            self.external_subagents.acquire(&runtime_key)
                        }
                        ExternalSubagentRoute::Unavailable => None,
                    };
                }
            }
        }
        self.find_agent_entry(logical_id, workspace_id)
            .map(|entry| local_binding(logical_id, entry.agent.id()))
    }

    /// Resolve a user-facing main-agent id to the exact generation that owns
    /// the next turn. The returned lease keeps prompt, tools, permissions, and
    /// model metadata stable until that turn settles.
    pub fn resolve_primary_agent_for_turn(
        &self,
        logical_id: &str,
        workspace_id: Option<&str>,
        external_sources_supported: bool,
        expected_owner: Option<SessionAgentRouteOwner>,
    ) -> Option<ExternalPrimaryAgentTurnBinding> {
        self.resolve_primary_agent_for_turn_with_route(
            logical_id,
            workspace_id,
            external_sources_supported,
            expected_owner,
            None,
        )
    }

    pub fn resolve_primary_agent_for_turn_with_route(
        &self,
        logical_id: &str,
        workspace_id: Option<&str>,
        external_sources_supported: bool,
        expected_owner: Option<SessionAgentRouteOwner>,
        expected_route_key: Option<&str>,
    ) -> Option<ExternalPrimaryAgentTurnBinding> {
        let logical_key = normalize_external_logical_id(logical_id);
        if external_sources_supported {
            if let Some(workspace_id) = workspace_id {
                let workspace_key = workspace_id.to_owned();
                if let Some(route) = self
                    .external_subagents
                    .effective_routes_for_workspace(&workspace_key)
                    .get(&logical_key)
                    .cloned()
                {
                    let binding = match route {
                        ExternalSubagentRoute::Local => {
                            match self.find_agent_entry(logical_id, Some(workspace_id)) {
                                Some(entry) if is_local_session_primary_entry(&entry) => {
                                    Some(local_primary_binding(&entry))
                                }
                                Some(entry) => {
                                    warn!(
                                        "Session primary agent resolution rejected a registered non-mode agent under a Local route: logical_id={}, category={:?}, source={:?}",
                                        logical_id,
                                        entry.category,
                                        entry.source
                                    );
                                    None
                                }
                                None => None,
                            }
                        }
                        ExternalSubagentRoute::External(runtime_key) => {
                            self.external_subagents.acquire_primary(&runtime_key)
                        }
                        ExternalSubagentRoute::Unavailable => None,
                    };
                    return binding.filter(|binding| {
                        expected_owner.is_none_or(|owner| binding.route_owner == owner)
                            && expected_route_key.is_none_or(|route_key| {
                                binding.route_key.as_deref() == Some(route_key)
                            })
                    });
                }
            }
        }
        if expected_owner == Some(SessionAgentRouteOwner::External) {
            return None;
        }
        let binding = match self.find_agent_entry(logical_id, workspace_id) {
            Some(entry) if is_local_session_primary_entry(&entry) => {
                Some(local_primary_binding(&entry))
            }
            Some(entry) => {
                warn!(
                    "Session primary agent resolution rejected a registered non-mode agent: logical_id={}, category={:?}, source={:?}, expected_owner={:?}",
                    logical_id,
                    entry.category,
                    entry.source,
                    expected_owner
                );
                None
            }
            None => {
                debug!(
                    "Session primary agent resolution found no registered agent: logical_id={}, expected_owner={:?}",
                    logical_id, expected_owner
                );
                None
            }
        };
        binding.filter(|binding| {
            expected_route_key
                .is_none_or(|route_key| binding.route_key.as_deref() == Some(route_key))
        })
    }

    /// Resolve only the currently approved external route for an exact
    /// ecosystem. Command delegation must never fall back to a same-name local
    /// agent or cross an ecosystem boundary after the command was expanded.
    pub fn resolve_external_subagent_for_fresh_invocation(
        &self,
        logical_id: &str,
        ecosystem_id: &EcosystemId,
        workspace_id: Option<&str>,
    ) -> Option<ExternalSubagentInvocationBinding> {
        let workspace_id = workspace_id?;
        let workspace_key = workspace_id.to_owned();
        let logical_key = normalize_external_logical_id(logical_id);
        let route = self
            .external_subagents
            .effective_routes_for_workspace(&workspace_key)
            .get(&logical_key)
            .cloned()?;
        match route {
            ExternalSubagentRoute::External(runtime_key) => {
                self.external_subagents.acquire_matching(
                    &runtime_key,
                    Some(ecosystem_id),
                    ExternalAgentProjection::Subagent,
                )
            }
            ExternalSubagentRoute::Local | ExternalSubagentRoute::Unavailable => None,
        }
    }

    pub(super) fn apply_external_routes_to_query(
        &self,
        workspace_id: &str,
        mut local: Vec<AgentInfo>,
    ) -> Vec<AgentInfo> {
        let workspace_id = workspace_id.to_owned();
        let routes = self
            .external_subagents
            .effective_routes_for_workspace(&workspace_id);
        let generations = self.external_subagents.read_generations();
        for (logical_id, route) in routes {
            match route {
                ExternalSubagentRoute::Local => {}
                ExternalSubagentRoute::Unavailable => {
                    local.retain(|agent| normalize_external_logical_id(&agent.id) != logical_id);
                }
                ExternalSubagentRoute::External(runtime_key) => {
                    local.retain(|agent| normalize_external_logical_id(&agent.id) != logical_id);
                    let Some(entry) = generations.get(&runtime_key) else {
                        continue;
                    };
                    if entry.registration.hidden || !entry.registration.mode.supports_subagent() {
                        continue;
                    }
                    local.push(external_agent_info(
                        entry,
                        ExternalAgentProjection::Subagent,
                    ));
                }
            }
        }
        local
    }

    pub(super) fn apply_external_routes_to_modes(
        &self,
        workspace_id: &str,
        mut local: Vec<AgentInfo>,
    ) -> Vec<AgentInfo> {
        let workspace_id = workspace_id.to_owned();
        let routes = self
            .external_subagents
            .effective_routes_for_workspace(&workspace_id);
        let generations = self.external_subagents.read_generations();
        for (logical_id, route) in routes {
            match route {
                ExternalSubagentRoute::Local => {}
                ExternalSubagentRoute::Unavailable => {
                    local.retain(|agent| normalize_external_logical_id(&agent.id) != logical_id);
                }
                ExternalSubagentRoute::External(runtime_key) => {
                    local.retain(|agent| normalize_external_logical_id(&agent.id) != logical_id);
                    let Some(entry) = generations.get(&runtime_key) else {
                        continue;
                    };
                    if entry.registration.hidden || !entry.registration.mode.supports_primary() {
                        continue;
                    }
                    local.push(external_agent_info(entry, ExternalAgentProjection::Primary));
                }
            }
        }
        local
    }
}

fn normalize_external_logical_id(logical_id: &str) -> String {
    logical_id.to_ascii_lowercase()
}

fn local_binding(logical_id: &str, runtime_agent_key: &str) -> ExternalSubagentInvocationBinding {
    ExternalSubagentInvocationBinding {
        runtime_agent_key: runtime_agent_key.to_string(),
        logical_id: logical_id.to_string(),
        supports_follow_up: true,
        continuation_policy: SessionContinuationPolicy::Reusable,
        model_binding_policy: SessionModelBindingPolicy::Mutable,
        lease: None,
    }
}

/// Builtin agents that are allowed to act as the main agent of a session even
/// though they are not registered as `Mode` (review and product-control sessions).
///
/// Review child sessions are created by the product surfaces with
/// `agentType=CodeReview` (standard) or `agentType=DeepReview` (strict), and
/// the remediation phase of either session runs with `agentType=ReviewFixer`.
/// These and the hidden OpenBitFun control Agent resolve through the primary path for create, turn,
/// restore, and compaction. Other subagents (e.g. `ReviewWorker`,
/// `ReviewJudge`) stay restricted.
fn is_builtin_session_primary_agent(id: &str) -> bool {
    matches!(
        id,
        CODE_REVIEW_AGENT_TYPE | DEEP_REVIEW_AGENT_TYPE | REVIEW_FIXER_AGENT_TYPE | "OpenBitFun"
    )
}

/// Whether a locally-resolved agent entry may act as a session primary agent.
///
/// Used by both the explicit `ExternalSubagentRoute::Local` branch and the
/// no-route fallback so review child sessions (CodeReview/DeepReview) resolve
/// identically regardless of whether a workspace route table pins them to the
/// local implementation.
fn is_local_session_primary_entry(entry: &AgentEntry) -> bool {
    entry.category == AgentCategory::Mode
        || (entry.source == AgentSource::Builtin
            && is_builtin_session_primary_agent(entry.agent.id()))
}

fn local_primary_binding(entry: &AgentEntry) -> ExternalPrimaryAgentTurnBinding {
    let route_key = AgentInfo::from_agent_entry(entry).key;
    ExternalPrimaryAgentTurnBinding {
        runtime_agent_key: entry.agent.id().to_string(),
        route_key: Some(route_key),
        model_binding: None,
        route_owner: SessionAgentRouteOwner::Local,
        lease: None,
    }
}

fn external_agent_info(
    entry: &ExternalSubagentGenerationEntry,
    projection: ExternalAgentProjection,
) -> AgentInfo {
    let agent = entry.registration.agent.as_ref();
    let default_tools = agent.default_tools();
    AgentInfo {
        key: entry.registration.route_key.clone(),
        id: entry.registration.logical_id.clone(),
        name: agent.name().to_string(),
        description: agent.description().to_string(),
        is_readonly: agent.is_readonly(),
        is_review: false,
        tool_count: default_tools.len(),
        default_tools,
        prompt_cache_scope_key: prompt_cache_scope_key(
            &agent.system_prompt_cache_identity(None),
            &agent.user_context_cache_identity(),
        ),
        config_profile_id: None,
        config_profile_label: None,
        config_profile_member_mode_ids: Vec::new(),
        default_enabled: true,
        effective_enabled: true,
        override_state: None,
        state_reason: None,
        source: AgentSource::External,
        subagent_source: matches!(projection, ExternalAgentProjection::Subagent)
            .then_some(SubAgentSource::External),
        path: None,
        model: entry
            .registration
            .model_binding
            .fixed_model_id()
            .map(str::to_string),
        model_is_explicit: Some(entry.registration.model_binding.fixed_model_id().is_some()),
        visibility: matches!(projection, ExternalAgentProjection::Subagent)
            .then(|| SubagentVisibilityPolicy::public().summary()),
        external_provider_label: Some(entry.registration.provider_label.clone()),
        supports_follow_up: matches!(projection, ExternalAgentProjection::Primary),
    }
}
