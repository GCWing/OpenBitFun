use super::availability::resolve_availability;
use super::support::{
    get_mode_configs, get_subagent_overrides, load_project_subagent_overrides_local,
    merge_dynamic_mcp_tools,
};
use super::AgentRegistry;
use crate::agentic::agents::registry::types::{is_review_agent_entry, AgentEntry, AgentSource};
use crate::agentic::agents::{
    is_swarm_delegate_agent_type, is_swarm_planner_agent_type, mode_presentation_rank,
    resolve_mode_config_profile_id, AgentCategory, AgentInfo, AgentToolPolicy, SubagentListScope,
    SubagentQueryContext,
};
use crate::agentic::deep_review_policy::canonical_review_worker_agent_type;
use crate::agentic::tools::get_all_registered_tool_names;
use crate::service::config::mode_config_canonicalizer::resolve_effective_tools;
use openbitfun_agent_runtime::agents::subagent_source_presentation_rank;
use std::collections::HashSet;
use std::path::Path;

impl AgentRegistry {
    /// Return every effective local agent definition that can participate in
    /// product-level external-source conflict resolution. Main-agent modes and
    /// subagents share one logical id namespace in external ecosystems, so a
    /// same-name local definition in either role must prevent silent takeover.
    #[cfg(feature = "external-sources")]
    pub(crate) async fn get_local_agents_for_external_resolution(
        &self,
        workspace_root: Option<&Path>,
    ) -> Vec<AgentInfo> {
        self.ensure_user_custom_agents_loaded().await;
        if let Some(workspace_root) = workspace_root {
            if !self.read_project_subagents().contains_key(workspace_root) {
                self.load_custom_agents(Some(workspace_root)).await;
            }
        }

        let user_overrides = get_subagent_overrides().await;
        let project_overrides = match workspace_root {
            Some(workspace_root) => load_project_subagent_overrides_local(workspace_root)
                .await
                .ok(),
            None => None,
        };
        let mut result = Vec::new();
        {
            let map = self.read_agents();
            result.extend(map.values().filter_map(|entry| {
                local_conflict_info(entry, None, project_overrides.as_ref(), &user_overrides)
            }));
        }
        if let Some(workspace_root) = workspace_root {
            if let Some(project_entries) = self.read_project_subagents().get(workspace_root) {
                result.extend(project_entries.values().filter_map(|entry| {
                    local_conflict_info(entry, None, project_overrides.as_ref(), &user_overrides)
                }));
            }
        }
        Self::sort_subagents_for_presentation(result)
    }

    fn sort_subagents_for_presentation(mut result: Vec<AgentInfo>) -> Vec<AgentInfo> {
        result.sort_by(|a, b| {
            subagent_source_presentation_rank(a.subagent_source)
                .cmp(&subagent_source_presentation_rank(b.subagent_source))
                .then_with(|| a.id.to_lowercase().cmp(&b.id.to_lowercase()))
                .then_with(|| a.id.cmp(&b.id))
                .then_with(|| a.name.to_lowercase().cmp(&b.name.to_lowercase()))
                .then_with(|| a.name.cmp(&b.name))
        });
        result
    }

    /// Resolve the current tool policy for an agent.
    ///
    /// This returns both the allowed tool set and any per-agent exposure
    /// overrides that should be applied on top of tool defaults.
    pub async fn get_agent_tool_policy(
        &self,
        agent_type: &str,
        workspace_root: Option<&Path>,
    ) -> AgentToolPolicy {
        let entry = self.find_agent_entry(agent_type, workspace_root);
        let Some(entry) = entry else {
            return AgentToolPolicy {
                allowed_tools: Vec::new(),
                exposure_overrides: Default::default(),
                permission_constraints: Default::default(),
            };
        };
        let registered_tool_names = get_all_registered_tool_names().await;
        match entry.category {
            AgentCategory::Mode => {
                let mode_configs = get_mode_configs().await;
                let valid_tools: HashSet<String> = registered_tool_names.iter().cloned().collect();
                let profile_id = resolve_mode_config_profile_id(agent_type);
                let default_tools = entry.agent.default_tools();
                let config = mode_configs.get(profile_id.as_ref());
                let resolved_tools = resolve_effective_tools(&default_tools, config, &valid_tools);
                let allowed_tools = if entry.agent.include_dynamic_mcp_tools() {
                    merge_dynamic_mcp_tools(resolved_tools, &registered_tool_names)
                } else {
                    resolved_tools
                };
                let allowed_tool_set: HashSet<&str> =
                    allowed_tools.iter().map(String::as_str).collect();
                let mut exposure_overrides = entry.agent.tool_exposure_overrides().clone();
                exposure_overrides
                    .retain(|tool_name, _| allowed_tool_set.contains(tool_name.as_str()));

                AgentToolPolicy {
                    allowed_tools,
                    exposure_overrides,
                    permission_constraints: entry.agent.permission_constraints().clone(),
                }
            }
            AgentCategory::SubAgent | AgentCategory::Hidden => {
                let allowed_tools = entry.agent.default_tools();
                let allowed_tool_set: HashSet<&str> =
                    allowed_tools.iter().map(String::as_str).collect();
                let mut exposure_overrides = entry.agent.tool_exposure_overrides().clone();
                exposure_overrides
                    .retain(|tool_name, _| allowed_tool_set.contains(tool_name.as_str()));

                AgentToolPolicy {
                    allowed_tools,
                    exposure_overrides,
                    permission_constraints: entry.agent.permission_constraints().clone(),
                }
            }
        }
    }

    /// get agent tools from config
    /// if not set, return default tools
    /// mode config canonicalization is handled separately; this only reads resolved configuration
    pub async fn get_agent_tools(
        &self,
        agent_type: &str,
        workspace_root: Option<&Path>,
    ) -> Vec<String> {
        self.get_agent_tool_policy(agent_type, workspace_root)
            .await
            .allowed_tools
    }

    /// get all mode agent information, used for frontend mode selector etc.
    pub async fn get_modes_info(&self) -> Vec<AgentInfo> {
        self.get_modes_info_for_workspace(None, false).await
    }

    /// Return main-agent profiles for one execution workspace. External
    /// profiles are a workspace projection over the same generation registry
    /// used by Task; remote/read-only hosts must keep this disabled.
    pub async fn get_modes_info_for_workspace(
        &self,
        workspace_root: Option<&Path>,
        external_sources_supported: bool,
    ) -> Vec<AgentInfo> {
        self.ensure_user_custom_agents_loaded().await;
        let map = self.read_agents();
        let mut result: Vec<AgentInfo> = map
            .values()
            .filter(|e| e.category == AgentCategory::Mode)
            .map(AgentInfo::from_agent_entry)
            .collect();
        drop(map);
        if external_sources_supported {
            if let Some(workspace_root) = workspace_root {
                result = self.apply_external_routes_to_modes(workspace_root, result);
            }
        }
        result.sort_by(|a, b| {
            let a_rank = match a.source {
                AgentSource::Builtin => mode_presentation_rank(&a.id),
                AgentSource::User => 100,
                AgentSource::Project => 101,
                AgentSource::External => 102,
            };
            let b_rank = match b.source {
                AgentSource::Builtin => mode_presentation_rank(&b.id),
                AgentSource::User => 100,
                AgentSource::Project => 101,
                AgentSource::External => 102,
            };
            a_rank
                .cmp(&b_rank)
                .then_with(|| a.id.to_lowercase().cmp(&b.id.to_lowercase()))
                .then_with(|| a.id.cmp(&b.id))
        });
        result
    }

    /// check if a subagent is readonly (used for TaskTool.is_concurrency_safe etc.)
    pub fn get_subagent_is_readonly(&self, id: &str) -> Option<bool> {
        if let Some(entry) = self.read_agents().get(id) {
            if entry.category == AgentCategory::SubAgent {
                return Some(entry.agent.is_readonly());
            }
        }

        for entries in self.read_project_subagents().values() {
            if let Some(entry) = entries.get(id) {
                if entry.category == AgentCategory::SubAgent {
                    return Some(entry.agent.is_readonly());
                }
            }
        }

        let canonical = canonical_review_worker_agent_type(id);
        if canonical != id {
            return self
                .read_agents()
                .get(canonical)
                .filter(|entry| entry.category == AgentCategory::SubAgent)
                .map(|entry| entry.agent.is_readonly());
        }

        None
    }

    pub fn get_subagent_is_review(&self, id: &str) -> Option<bool> {
        if let Some(entry) = self.read_agents().get(id) {
            if entry.category == AgentCategory::SubAgent {
                return Some(is_review_agent_entry(entry));
            }
        }

        for entries in self.read_project_subagents().values() {
            if let Some(entry) = entries.get(id) {
                if entry.category == AgentCategory::SubAgent {
                    return Some(is_review_agent_entry(entry));
                }
            }
        }

        let canonical = canonical_review_worker_agent_type(id);
        if canonical != id {
            return self
                .read_agents()
                .get(canonical)
                .filter(|entry| entry.category == AgentCategory::SubAgent)
                .map(is_review_agent_entry);
        }

        None
    }

    pub async fn get_subagent_is_review_for_workspace(
        &self,
        id: &str,
        workspace_root: Option<&Path>,
    ) -> Option<bool> {
        self.ensure_user_custom_agents_loaded().await;
        if let Some(workspace_root) = workspace_root {
            let is_project_cache_loaded =
                self.read_project_subagents().contains_key(workspace_root);
            if !is_project_cache_loaded {
                self.load_custom_agents(Some(workspace_root)).await;
            }
        }

        self.find_agent_entry(id, workspace_root)
            .filter(|entry| entry.category == AgentCategory::SubAgent)
            .map(|entry| is_review_agent_entry(&entry))
    }

    fn entry_is_visible_for_query(
        entry: &AgentEntry,
        query: &SubagentQueryContext<'_>,
        project_overrides: Option<&crate::service::config::types::AgentSubagentOverrideConfig>,
        user_overrides: &crate::service::config::types::AgentSubagentOverrideConfig,
    ) -> bool {
        if entry.category != AgentCategory::SubAgent {
            return false;
        }
        if query.list_scope == SubagentListScope::TaskVisible
            && query
                .parent_agent_type
                .is_some_and(is_swarm_planner_agent_type)
            && !is_swarm_delegate_agent_type(entry.agent.id())
        {
            return false;
        }

        let availability = resolve_availability(
            entry,
            query.parent_agent_type,
            project_overrides,
            user_overrides,
        );
        if !query.include_disabled && !availability.effective_enabled {
            return false;
        }

        match query.list_scope {
            SubagentListScope::RegistryManagement => {
                entry.visibility_policy.show_in_global_registry
            }
            SubagentListScope::TaskVisible => {
                entry.visibility_policy.show_in_global_registry
                    || entry
                        .visibility_policy
                        .can_access_from_parent(query.parent_agent_type)
            }
        }
    }

    /// get all subagent information (including source and availability status, used for TaskTool and frontend subagent list etc.)
    pub async fn get_subagents_info(&self, workspace_root: Option<&Path>) -> Vec<AgentInfo> {
        self.get_subagents_for_query(&SubagentQueryContext {
            parent_agent_type: None,
            workspace_root,
            list_scope: SubagentListScope::RegistryManagement,
            include_disabled: true,
            external_sources_supported: true,
        })
        .await
    }

    pub async fn get_subagents_for_query(
        &self,
        query: &SubagentQueryContext<'_>,
    ) -> Vec<AgentInfo> {
        self.ensure_user_custom_agents_loaded().await;
        if let Some(workspace_root) = query.workspace_root {
            let is_project_cache_loaded =
                self.read_project_subagents().contains_key(workspace_root);
            if !is_project_cache_loaded {
                self.load_custom_agents(Some(workspace_root)).await;
            }
        }

        let user_overrides = get_subagent_overrides().await;
        let project_overrides = match query.workspace_root {
            Some(workspace_root) => load_project_subagent_overrides_local(workspace_root)
                .await
                .ok(),
            None => None,
        };
        let map = self.read_agents();
        let mut result: Vec<AgentInfo> = map
            .values()
            .filter(|entry| {
                Self::entry_is_visible_for_query(
                    entry,
                    query,
                    project_overrides.as_ref(),
                    &user_overrides,
                )
            })
            .map(|e| {
                let mut agent_info = AgentInfo::from_agent_entry(e);
                let availability = resolve_availability(
                    e,
                    query.parent_agent_type,
                    project_overrides.as_ref(),
                    &user_overrides,
                );
                agent_info.subagent_source = e.subagent_source;
                agent_info.default_enabled = availability.default_enabled;
                agent_info.effective_enabled = availability.effective_enabled;
                agent_info.override_state = availability.override_state;
                agent_info.state_reason = availability.state_reason;
                agent_info
            })
            .collect();
        drop(map);
        if let Some(workspace_root) = query.workspace_root {
            if let Some(project_entries) = self.read_project_subagents().get(workspace_root) {
                result.extend(
                    project_entries
                        .values()
                        .filter(|entry| {
                            Self::entry_is_visible_for_query(
                                entry,
                                query,
                                project_overrides.as_ref(),
                                &user_overrides,
                            )
                        })
                        .map(|entry| {
                            let mut info = AgentInfo::from_agent_entry(entry);
                            let availability = resolve_availability(
                                entry,
                                query.parent_agent_type,
                                project_overrides.as_ref(),
                                &user_overrides,
                            );
                            info.default_enabled = availability.default_enabled;
                            info.effective_enabled = availability.effective_enabled;
                            info.override_state = availability.override_state;
                            info.state_reason = availability.state_reason;
                            info
                        }),
                );
            }
        }
        if query.external_sources_supported {
            if let Some(workspace_root) = query.workspace_root {
                result = self.apply_external_routes_to_query(workspace_root, result);
            }
        }
        Self::sort_subagents_for_presentation(result)
    }

    pub async fn can_parent_access_subagent(
        &self,
        subagent_id: &str,
        workspace_root: Option<&Path>,
        parent_agent_type: Option<&str>,
    ) -> bool {
        let query = SubagentQueryContext {
            parent_agent_type,
            workspace_root,
            list_scope: SubagentListScope::TaskVisible,
            include_disabled: false,
            external_sources_supported: false,
        };
        let user_overrides = get_subagent_overrides().await;
        let project_overrides = match query.workspace_root {
            Some(workspace_root) => load_project_subagent_overrides_local(workspace_root)
                .await
                .ok(),
            None => None,
        };

        if let Some(workspace_root) = query.workspace_root {
            let is_project_cache_loaded =
                self.read_project_subagents().contains_key(workspace_root);
            if !is_project_cache_loaded {
                self.load_custom_agents(Some(workspace_root)).await;
            }
        }

        self.find_agent_entry(subagent_id, workspace_root)
            .is_some_and(|entry| {
                Self::entry_is_visible_for_query(
                    &entry,
                    &query,
                    project_overrides.as_ref(),
                    &user_overrides,
                )
            })
    }
}

#[cfg(feature = "external-sources")]
fn local_conflict_info(
    entry: &AgentEntry,
    parent_agent_type: Option<&str>,
    project_overrides: Option<&crate::service::config::types::AgentSubagentOverrideConfig>,
    user_overrides: &crate::service::config::types::AgentSubagentOverrideConfig,
) -> Option<AgentInfo> {
    if !matches!(
        entry.category,
        AgentCategory::Mode | AgentCategory::SubAgent
    ) || entry.source == AgentSource::External
    {
        return None;
    }
    if entry.category == AgentCategory::Mode {
        return Some(AgentInfo::from_agent_entry(entry));
    }
    let availability =
        resolve_availability(entry, parent_agent_type, project_overrides, user_overrides);
    if !availability.effective_enabled {
        return None;
    }
    let mut info = AgentInfo::from_agent_entry(entry);
    info.subagent_source = entry.subagent_source;
    info.default_enabled = availability.default_enabled;
    info.effective_enabled = availability.effective_enabled;
    info.override_state = availability.override_state;
    info.state_reason = availability.state_reason;
    Some(info)
}
