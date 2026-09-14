use super::availability::{prune_override_config, resolve_default_enabled, set_override_state};
use super::support::{
    get_subagent_overrides, load_project_subagent_overrides_local,
    save_project_subagent_overrides_local,
};
use super::types::{
    agent_source_from_custom_level, subagent_key_for, AgentEntry, AgentSource, CustomAgentConfig,
};
use super::{AgentRegistry, CustomAgentDetail};
use crate::agentic::agents::definitions::custom::{CustomAgentData, CustomMode, CustomSubagent};
use crate::agentic::agents::registry::visibility::SubagentVisibilityPolicy;
use crate::agentic::agents::{
    subagent_source_from_custom_kind, Agent, AgentCategory, SubAgentSource,
};
use crate::agentic::tools::{get_all_registered_tool_names, get_readonly_registered_tool_names};
use crate::infrastructure::get_path_manager_arc;
use crate::service::config::global::GlobalConfigManager;
use crate::service::config::mode_config_canonicalizer::persist_agent_profile_from_value;
use crate::service::config::types::AgentSubagentOverrideState;
use crate::util::errors::{OpenBitFunError, OpenBitFunResult};
use log::{debug, error, warn};
use openbitfun_agent_runtime::custom_agent::{
    custom_agent_review_writable_tools, default_custom_agent_tools, load_custom_agent_definitions,
    validate_custom_agent_definition, CustomAgentDefinition, CustomAgentDiscoveryRoots,
    CustomAgentFrontMatterMetadata, CustomAgentKind, CustomAgentLevel,
    CustomAgentValidationContext, CustomAgentValidationReport,
};
use std::collections::HashMap;
use std::path::Path;
use std::sync::Arc;

impl AgentRegistry {
    pub async fn ensure_user_custom_agents_loaded(&self) {
        let mut state = self.custom_load_state.lock().await;
        // Some registry fixtures install in-memory user entries without discovery.
        #[cfg(test)]
        if self.user_custom_agents_loaded() && state.roots.is_none() {
            return;
        }
        let roots = state
            .roots
            .clone()
            .unwrap_or_else(|| custom_agent_discovery_roots(None));
        let dirty = state.prepare(&roots).await;
        if !self.user_custom_agents_loaded() || dirty {
            self.scan_custom_agents(None, &roots).await;
            state.published = true;
        }
    }

    /// Load user custom agents globally and project subagents for the given workspace.
    pub async fn load_custom_agents(&self, workspace_root: Option<&Path>) {
        self.load_custom_agents_from_discovery_roots(
            workspace_root,
            &custom_agent_discovery_roots(workspace_root),
        )
        .await;
    }

    #[cfg(test)]
    pub(crate) async fn load_custom_agents_from_test_roots(
        &self,
        workspace_root: Option<&Path>,
        roots: &CustomAgentDiscoveryRoots,
    ) {
        self.load_custom_agents_from_discovery_roots(workspace_root, roots)
            .await;
    }

    async fn load_custom_agents_from_discovery_roots(
        &self,
        workspace_root: Option<&Path>,
        roots: &CustomAgentDiscoveryRoots,
    ) {
        let mut state = self.custom_load_state.lock().await;
        state.prepare(roots).await;
        state.published = false;
        self.scan_custom_agents(workspace_root, roots).await;
        state.published = true;
    }

    async fn scan_custom_agents(
        &self,
        workspace_root: Option<&Path>,
        roots: &CustomAgentDiscoveryRoots,
    ) {
        let valid_tools = get_all_registered_tool_names().await;
        let readonly_tools = get_readonly_registered_tool_names().await;
        let valid_models = Self::get_valid_model_ids().await;

        let custom = load_custom_agent_definitions(roots);
        for load_error in custom.errors {
            if load_error.error == "Project-scoped custom modes are not supported" {
                warn!(
                    "Skipping custom agent from {}: {}",
                    load_error.path.display(),
                    load_error.error
                );
            } else {
                let error = OpenBitFunError::Agent(load_error.error);
                error!(
                    "Failed to load custom agent from {}: {}",
                    load_error.path.display(),
                    error
                );
            }
        }

        let mut user_entries = HashMap::new();
        let mut project_entries = HashMap::new();

        for loaded in custom.definitions {
            let mut definition = loaded.definition;
            Self::validate_custom_agent(
                &mut definition,
                &loaded.metadata,
                &valid_tools,
                &readonly_tools,
                &valid_models,
            );

            let id = definition.id.clone();
            let source = agent_source_from_custom_level(definition.level);
            let subagent_source = (definition.kind == CustomAgentKind::Subagent)
                .then(|| subagent_source_from_custom_kind(definition.level));
            let custom_config = CustomAgentConfig {
                model: definition.model.clone(),
                model_is_explicit: definition.model_is_explicit,
            };
            let entry = AgentEntry {
                category: match definition.kind {
                    CustomAgentKind::Mode => AgentCategory::Mode,
                    CustomAgentKind::Subagent => AgentCategory::SubAgent,
                },
                source,
                subagent_source,
                agent: custom_agent_from_definition(
                    loaded.path.to_string_lossy().to_string(),
                    definition,
                ),
                visibility_policy: SubagentVisibilityPolicy::public(),
                custom_config: Some(custom_config),
            };

            match source {
                AgentSource::Builtin => {}
                AgentSource::User => {
                    user_entries.entry(id).or_insert(entry);
                }
                AgentSource::Project => {
                    project_entries.entry(id).or_insert(entry);
                }
                AgentSource::External => {
                    debug_assert!(false, "file-backed discovery cannot create external agents");
                }
            }
        }

        {
            let mut map = self.write_agents();
            map.retain(|_, entry| entry.source != AgentSource::User);
            for (id, entry) in user_entries {
                if map.contains_key(&id) {
                    warn!("Custom agent {} conflicts with existing entry, skip", id);
                    continue;
                }
                map.insert(id, entry);
            }
        }

        if let Some(root) = workspace_root {
            let map = self.read_agents();
            let filtered_project_entries = project_entries
                .into_iter()
                .filter(|(id, _)| {
                    if map.contains_key(id) {
                        warn!(
                            "Custom project agent {} conflicts with global entry, skip",
                            id
                        );
                        return false;
                    }
                    true
                })
                .collect();
            drop(map);
            self.write_project_subagents()
                .insert(root.to_path_buf(), filtered_project_entries);
        }

        self.set_user_custom_agents_loaded(true);
    }

    /// Compatibility wrapper for existing project-subagent callers.
    pub async fn load_custom_subagents(&self, workspace_root: &Path) {
        self.load_custom_agents(Some(workspace_root)).await;
    }

    async fn get_valid_model_ids() -> Vec<String> {
        let mut valid_models: Vec<String> =
            if let Ok(config_service) = GlobalConfigManager::get_service().await {
                config_service
                    .get_ai_models()
                    .await
                    .unwrap_or_default()
                    .into_iter()
                    .map(|m| m.id)
                    .collect()
            } else {
                Vec::new()
            };
        valid_models.push("primary".to_string());
        valid_models.push("fast".to_string());
        valid_models.push("inherit".to_string());
        valid_models
    }

    fn validate_custom_agent(
        definition: &mut CustomAgentDefinition,
        metadata: &CustomAgentFrontMatterMetadata,
        valid_tools: &[String],
        readonly_tools: &[String],
        valid_models: &[String],
    ) {
        let agent_id = definition.id.clone();
        let report = validate_custom_agent_definition(
            definition,
            metadata,
            CustomAgentValidationContext {
                valid_tools,
                readonly_tools,
                valid_models,
            },
        );

        Self::log_custom_agent_validation_report(&agent_id, &report);
    }

    fn log_custom_agent_validation_report(agent_id: &str, report: &CustomAgentValidationReport) {
        if report.default_mode_tools_used {
            warn!(
                "[Custom mode {}] No tools configured; defaulting to mode tool set {:?}",
                agent_id,
                default_custom_agent_tools(CustomAgentKind::Mode)
            );
        }

        if !report.invalid_tools.is_empty() {
            warn!(
                "[Custom agent {}] Invalid tools filtered out: {:?}",
                agent_id, report.invalid_tools
            );
        }

        if !report.writable_review_tools.is_empty() {
            warn!(
                "[Custom subagent {}] Writable tools filtered out from review subagent: {:?}",
                agent_id, report.writable_review_tools
            );
        }

        if let Some(model_fallback) = &report.model_fallback {
            warn!(
                "[Custom agent {}] Invalid model '{}', reset to '{}'",
                agent_id, model_fallback.original, model_fallback.fallback
            );
        }
    }

    fn ensure_review_tools_are_readonly(
        agent_id: &str,
        tools: &[String],
        readonly_tools: &[String],
    ) -> OpenBitFunResult<()> {
        let writable_tools = custom_agent_review_writable_tools(tools, readonly_tools);

        if writable_tools.is_empty() {
            return Ok(());
        }

        Err(OpenBitFunError::agent(format!(
            "Review Sub-Agent '{}' can only use read-only tools; remove writable tools: {}",
            agent_id,
            writable_tools.join(", ")
        )))
    }

    /// Clear workspace-scoped project custom agents. User custom agents remain loaded globally.
    pub fn clear_custom_agents(&self) {
        let before = self.read_project_subagents().len();
        self.write_project_subagents().clear();
        debug!("Cleared project custom agent caches: workspaces {}", before);
    }

    pub fn clear_custom_subagents(&self) {
        self.clear_custom_agents();
    }

    pub fn get_custom_agent_config(
        &self,
        agent_id: &str,
        workspace_root: Option<&Path>,
    ) -> Option<CustomAgentConfig> {
        if let Some(entry) = self.read_agents().get(agent_id) {
            return entry.custom_config.clone();
        }

        workspace_root
            .and_then(|root| self.read_project_subagents().get(root).cloned())
            .and_then(|entries| entries.get(agent_id).cloned())
            .and_then(|entry| entry.custom_config)
    }

    pub fn get_custom_subagent_config(
        &self,
        agent_id: &str,
        workspace_root: Option<&Path>,
    ) -> Option<CustomAgentConfig> {
        self.find_agent_entry(agent_id, workspace_root)
            .filter(|entry| entry.category == AgentCategory::SubAgent)
            .and_then(|entry| entry.custom_config)
    }

    pub fn has_project_custom_subagent(&self, agent_id: &str) -> bool {
        self.read_project_subagents().values().any(|entries| {
            entries.get(agent_id).is_some_and(|entry| {
                entry.category == AgentCategory::SubAgent
                    && entry.subagent_source == Some(SubAgentSource::Project)
                    && entry.custom_config.is_some()
            })
        })
    }

    pub fn update_and_save_custom_agent_config(
        &self,
        agent_id: &str,
        model: Option<String>,
        clear_model_override: bool,
        workspace_root: Option<&Path>,
    ) -> OpenBitFunResult<()> {
        let mut map = self.write_agents();
        if let Some(entry) = map.get_mut(agent_id) {
            return Self::update_custom_entry_config(agent_id, entry, model, clear_model_override);
        }
        drop(map);

        let workspace_root = workspace_root.ok_or_else(|| {
            OpenBitFunError::agent(format!(
                "workspace_path is required to update project custom agent '{}'",
                agent_id
            ))
        })?;
        let mut project_maps = self.write_project_subagents();
        let entries = project_maps.get_mut(workspace_root).ok_or_else(|| {
            OpenBitFunError::agent(format!(
                "Project custom agents are not loaded for workspace: {}",
                workspace_root.display()
            ))
        })?;
        let entry = entries
            .get_mut(agent_id)
            .ok_or_else(|| OpenBitFunError::agent(format!("Agent not found: {}", agent_id)))?;

        Self::update_custom_entry_config(agent_id, entry, model, clear_model_override)
    }

    pub fn update_and_save_custom_subagent_config(
        &self,
        agent_id: &str,
        model: Option<String>,
        clear_model_override: bool,
        workspace_root: Option<&Path>,
    ) -> OpenBitFunResult<()> {
        self.update_and_save_custom_agent_config(
            agent_id,
            model,
            clear_model_override,
            workspace_root,
        )
    }

    fn update_custom_entry_config(
        agent_id: &str,
        entry: &mut AgentEntry,
        model: Option<String>,
        clear_model_override: bool,
    ) -> OpenBitFunResult<()> {
        let config = entry.custom_config.as_mut().ok_or_else(|| {
            OpenBitFunError::agent(format!(
                "Agent '{}' is not a custom file-backed agent",
                agent_id
            ))
        })?;

        if model.is_none() && !clear_model_override {
            return Err(OpenBitFunError::agent(
                "A model or clear_model_override is required".to_string(),
            ));
        }

        let new_model = model.unwrap_or_else(|| config.model.clone());

        if let Some(custom_mode) = entry.agent.as_any().downcast_ref::<CustomMode>() {
            if clear_model_override {
                return Err(OpenBitFunError::agent(
                    "Clearing the model override is only supported for custom subagents"
                        .to_string(),
                ));
            }
            custom_mode.save_to_file(Some(&new_model))?;
            config.model = new_model;
            config.model_is_explicit = true;
            return Ok(());
        }

        let custom_subagent = entry
            .agent
            .as_any()
            .downcast_ref::<CustomSubagent>()
            .ok_or_else(|| {
                OpenBitFunError::agent(format!(
                    "Failed to downcast agent '{}' to a custom file-backed agent",
                    agent_id
                ))
            })?;

        custom_subagent
            .save_to_file_with_model_override(Some(&new_model), !clear_model_override)?;
        config.model = new_model;
        config.model_is_explicit = !clear_model_override;
        Ok(())
    }

    pub async fn get_custom_agent_detail(
        &self,
        agent_id: &str,
        workspace_root: Option<&Path>,
    ) -> OpenBitFunResult<CustomAgentDetail> {
        self.ensure_user_custom_agents_loaded().await;
        if let Some(root) = workspace_root {
            self.load_custom_agents(Some(root)).await;
        }
        self.get_custom_agent_detail_inner(agent_id, workspace_root)
    }

    pub async fn get_custom_subagent_detail(
        &self,
        agent_id: &str,
        workspace_root: Option<&Path>,
    ) -> OpenBitFunResult<CustomAgentDetail> {
        let detail = self
            .get_custom_agent_detail(agent_id, workspace_root)
            .await?;
        if detail.kind != "subagent" {
            return Err(OpenBitFunError::agent(format!(
                "Agent '{}' is not a subagent",
                agent_id
            )));
        }
        Ok(detail)
    }

    pub async fn get_custom_subagent_detail_by_key(
        &self,
        agent_key: &str,
        workspace_root: Option<&Path>,
    ) -> OpenBitFunResult<CustomAgentDetail> {
        self.ensure_user_custom_agents_loaded().await;
        if let Some(root) = workspace_root {
            self.load_custom_agents(Some(root)).await;
        }
        let detail = self.get_custom_agent_detail_by_key_inner(agent_key, workspace_root)?;
        if detail.kind != "subagent" {
            return Err(OpenBitFunError::agent(format!(
                "Agent '{}' is not a subagent",
                agent_key
            )));
        }
        Ok(detail)
    }

    fn get_custom_agent_detail_inner(
        &self,
        agent_id: &str,
        workspace_root: Option<&Path>,
    ) -> OpenBitFunResult<CustomAgentDetail> {
        let entry = self
            .find_agent_entry(agent_id, workspace_root)
            .ok_or_else(|| OpenBitFunError::agent(format!("Agent not found: {}", agent_id)))?;
        Self::custom_agent_detail_from_entry(agent_id, entry)
    }

    pub(super) fn get_custom_agent_detail_by_key_inner(
        &self,
        agent_key: &str,
        workspace_root: Option<&Path>,
    ) -> OpenBitFunResult<CustomAgentDetail> {
        let entry = {
            let agents = self.read_agents();
            agents
                .values()
                .find(|entry| {
                    subagent_key_for(entry.subagent_source, entry.agent.as_ref()).as_deref()
                        == Some(agent_key)
                })
                .cloned()
        }
        .or_else(|| {
            let root = workspace_root?;
            self.read_project_subagents()
                .get(root)
                .and_then(|entries| {
                    entries.values().find(|entry| {
                        subagent_key_for(entry.subagent_source, entry.agent.as_ref()).as_deref()
                            == Some(agent_key)
                    })
                })
                .cloned()
        })
        .ok_or_else(|| OpenBitFunError::agent(format!("Agent not found: {}", agent_key)))?;
        Self::custom_agent_detail_from_entry(agent_key, entry)
    }

    fn custom_agent_detail_from_entry(
        agent_id: &str,
        entry: AgentEntry,
    ) -> OpenBitFunResult<CustomAgentDetail> {
        if entry.source == AgentSource::Builtin {
            return Err(OpenBitFunError::agent(
                "Built-in agents cannot be edited here".to_string(),
            ));
        }

        if let Some(custom) = entry.agent.as_any().downcast_ref::<CustomMode>() {
            return Ok(Self::build_custom_agent_detail(
                &custom.data,
                &entry,
                "mode",
            ));
        }

        let custom = entry
            .agent
            .as_any()
            .downcast_ref::<CustomSubagent>()
            .ok_or_else(|| {
                OpenBitFunError::agent(format!("Agent '{}' is not a custom agent file", agent_id))
            })?;

        Ok(Self::build_custom_agent_detail(
            &custom.data,
            &entry,
            "subagent",
        ))
    }

    fn build_custom_agent_detail(
        data: &CustomAgentData,
        entry: &AgentEntry,
        kind: &str,
    ) -> CustomAgentDetail {
        let level = match data.level {
            CustomAgentLevel::User => "user",
            CustomAgentLevel::Project => "project",
        };
        CustomAgentDetail {
            agent_id: data.id.clone(),
            kind: kind.to_string(),
            name: data.name.clone(),
            description: data.description.clone(),
            prompt: data.prompt.clone(),
            tools: data.tools.clone(),
            readonly: data.readonly,
            review: data.review,
            model: entry
                .custom_config
                .as_ref()
                .map(|config| config.model.clone())
                .unwrap_or_else(|| data.model.clone()),
            path: data.path.clone(),
            user_context_policy: data
                .user_context_policy
                .sections
                .iter()
                .map(|section| match section {
                    openbitfun_agent_runtime::prompt::UserContextSection::WorkspaceContext => {
                        "workspace_context"
                    }
                    openbitfun_agent_runtime::prompt::UserContextSection::WorkspaceInstructions => {
                        "workspace_instructions"
                    }
                    openbitfun_agent_runtime::prompt::UserContextSection::ProjectLayout => {
                        "project_layout"
                    }
                    openbitfun_agent_runtime::prompt::UserContextSection::MemorySummary => {
                        "memory_summary"
                    }
                })
                .map(str::to_string)
                .collect(),
            level: level.to_string(),
        }
    }

    #[allow(clippy::too_many_arguments)]
    pub async fn update_custom_agent_definition(
        &self,
        agent_id: &str,
        workspace_root: Option<&Path>,
        name: String,
        description: String,
        prompt: String,
        tools: Option<Vec<String>>,
        readonly: Option<bool>,
        review: Option<bool>,
        user_context_policy: Option<openbitfun_agent_runtime::prompt::UserContextPolicy>,
        model: Option<String>,
    ) -> OpenBitFunResult<()> {
        self.ensure_user_custom_agents_loaded().await;
        if let Some(root) = workspace_root {
            self.load_custom_agents(Some(root)).await;
        }
        let entry = self
            .find_agent_entry(agent_id, workspace_root)
            .ok_or_else(|| OpenBitFunError::agent(format!("Agent not found: {}", agent_id)))?;
        if entry.source == AgentSource::Builtin {
            return Err(OpenBitFunError::agent(
                "Built-in agents cannot be edited".to_string(),
            ));
        }
        let current_model_config = entry.custom_config.as_ref().ok_or_else(|| {
            OpenBitFunError::agent(format!(
                "Agent '{}' is not a custom file-backed agent",
                agent_id
            ))
        })?;
        let definition_model = model
            .as_deref()
            .unwrap_or(current_model_config.model.as_str());
        let definition_model_is_explicit =
            model.is_some() || current_model_config.model_is_explicit;

        let readonly_tools = get_readonly_registered_tool_names().await;
        let valid_tools = get_all_registered_tool_names().await;
        let valid_models = Self::get_valid_model_ids().await;

        let replacement = if let Some(old) = entry.agent.as_any().downcast_ref::<CustomMode>() {
            let mut definition = old
                .data
                .to_definition(Some(definition_model), Some(definition_model_is_explicit));
            let used_default_tools = tools.is_none();
            definition.name = name;
            definition.description = description;
            definition.prompt = prompt;
            definition.tools = tools
                .filter(|value| !value.is_empty())
                .unwrap_or_else(|| default_custom_agent_tools(CustomAgentKind::Mode));
            definition.readonly = readonly.unwrap_or(old.data.readonly);
            definition.user_context_policy =
                user_context_policy.unwrap_or_else(|| old.data.user_context_policy.clone());
            Self::validate_custom_agent(
                &mut definition,
                &CustomAgentFrontMatterMetadata {
                    used_default_tools,
                    ..Default::default()
                },
                &valid_tools,
                &readonly_tools,
                &valid_models,
            );
            custom_agent_from_definition(old.data.path.clone(), definition)
        } else {
            let old = entry
                .agent
                .as_any()
                .downcast_ref::<CustomSubagent>()
                .ok_or_else(|| {
                    OpenBitFunError::agent(format!(
                        "Agent '{}' is not a custom agent file",
                        agent_id
                    ))
                })?;
            let review = review.unwrap_or(old.data.review);
            let tools = tools
                .filter(|value| !value.is_empty())
                .unwrap_or_else(|| default_custom_agent_tools(CustomAgentKind::Subagent));
            if review {
                Self::ensure_review_tools_are_readonly(agent_id, &tools, &readonly_tools)?;
            }
            let mut definition = old
                .data
                .to_definition(Some(definition_model), Some(definition_model_is_explicit));
            definition.name = name;
            definition.description = description;
            definition.prompt = prompt;
            definition.tools = tools;
            definition.readonly = if review {
                true
            } else {
                readonly.unwrap_or(old.data.readonly)
            };
            definition.review = review;
            definition.user_context_policy =
                user_context_policy.unwrap_or_else(|| old.data.user_context_policy.clone());
            Self::validate_custom_agent(
                &mut definition,
                &CustomAgentFrontMatterMetadata {
                    used_default_tools: false,
                    ..Default::default()
                },
                &valid_tools,
                &readonly_tools,
                &valid_models,
            );
            custom_agent_from_definition(old.data.path.clone(), definition)
        };

        save_runtime_custom_agent(&replacement)?;
        self.replace_custom_agent_entry(agent_id, workspace_root, replacement)
    }

    pub async fn update_custom_subagent_definition(
        &self,
        agent_id: &str,
        workspace_root: Option<&Path>,
        description: String,
        prompt: String,
        tools: Option<Vec<String>>,
        readonly: Option<bool>,
        review: Option<bool>,
    ) -> OpenBitFunResult<()> {
        let detail = self
            .get_custom_subagent_detail(agent_id, workspace_root)
            .await?;
        self.update_custom_agent_definition(
            agent_id,
            workspace_root,
            detail.name,
            description,
            prompt,
            tools,
            readonly,
            review,
            None,
            None,
        )
        .await
    }

    fn replace_custom_agent_entry(
        &self,
        agent_id: &str,
        workspace_root: Option<&Path>,
        new_agent: Arc<dyn Agent>,
    ) -> OpenBitFunResult<()> {
        let mut map = self.write_agents();
        if map.contains_key(agent_id) {
            let old_entry = map
                .get(agent_id)
                .ok_or_else(|| OpenBitFunError::agent(format!("Agent not found: {}", agent_id)))?;
            if old_entry.source == AgentSource::Builtin {
                return Err(OpenBitFunError::agent(
                    "Cannot replace built-in agent".to_string(),
                ));
            }
            let category = old_entry.category;
            let source = old_entry.source;
            let subagent_source = old_entry.subagent_source;
            let cfg = custom_config_from_agent(new_agent.as_ref())?;
            map.insert(
                agent_id.to_string(),
                AgentEntry {
                    category,
                    source,
                    subagent_source,
                    agent: new_agent,
                    visibility_policy: SubagentVisibilityPolicy::public(),
                    custom_config: Some(cfg),
                },
            );
            return Ok(());
        }
        drop(map);

        let root = workspace_root.ok_or_else(|| {
            OpenBitFunError::agent(
                "Workspace path is required to update project subagent".to_string(),
            )
        })?;
        let mut pm = self.write_project_subagents();
        let entries = pm.get_mut(root).ok_or_else(|| {
            OpenBitFunError::agent(
                "Project subagent cache not loaded for this workspace".to_string(),
            )
        })?;
        let old_entry = entries
            .get(agent_id)
            .ok_or_else(|| OpenBitFunError::agent(format!("Agent not found: {}", agent_id)))?;
        if old_entry.source == AgentSource::Builtin {
            return Err(OpenBitFunError::agent(
                "Cannot replace built-in agent".to_string(),
            ));
        }
        let category = old_entry.category;
        let source = old_entry.source;
        let subagent_source = old_entry.subagent_source;
        let cfg = custom_config_from_agent(new_agent.as_ref())?;
        entries.insert(
            agent_id.to_string(),
            AgentEntry {
                category,
                source,
                subagent_source,
                agent: new_agent,
                visibility_policy: SubagentVisibilityPolicy::public(),
                custom_config: Some(cfg),
            },
        );
        Ok(())
    }

    pub fn remove_custom_agent(&self, agent_id: &str) -> OpenBitFunResult<Option<String>> {
        let mut map = self.write_agents();
        if let Some(entry) = map.get(agent_id) {
            if entry.source == AgentSource::Builtin {
                return Err(OpenBitFunError::agent(format!(
                    "Cannot remove built-in agent: {}",
                    agent_id
                )));
            }
            let path = custom_agent_path(entry.agent.as_ref());
            map.remove(agent_id);
            return Ok(path);
        }
        drop(map);

        let mut project_maps = self.write_project_subagents();
        for entries in project_maps.values_mut() {
            if let Some(entry) = entries.get(agent_id) {
                let path = custom_agent_path(entry.agent.as_ref());
                entries.remove(agent_id);
                return Ok(path);
            }
        }

        Err(OpenBitFunError::agent(format!(
            "Agent not found: {}",
            agent_id
        )))
    }

    pub fn remove_subagent(&self, agent_id: &str) -> OpenBitFunResult<Option<String>> {
        let entry = self
            .find_agent_entry(agent_id, None)
            .or_else(|| {
                self.read_project_subagents()
                    .values()
                    .find_map(|entries| entries.get(agent_id).cloned())
            })
            .ok_or_else(|| OpenBitFunError::agent(format!("Subagent not found: {}", agent_id)))?;
        if entry.category != AgentCategory::SubAgent {
            return Err(OpenBitFunError::agent(format!(
                "Agent '{}' is not a subagent",
                agent_id
            )));
        }
        self.remove_custom_agent(agent_id)
    }

    pub async fn update_subagent_override(
        &self,
        parent_agent_type: &str,
        agent_id: &str,
        enabled: bool,
        workspace_root: Option<&Path>,
    ) -> OpenBitFunResult<()> {
        let parent_agent_type = parent_agent_type.trim();
        if parent_agent_type.is_empty() {
            return Err(OpenBitFunError::agent(
                "parent_agent_type is required to update subagent availability".to_string(),
            ));
        }

        let entry = self
            .find_agent_entry(agent_id, workspace_root)
            .ok_or_else(|| OpenBitFunError::agent(format!("Subagent not found: {}", agent_id)))?;
        if entry.category != AgentCategory::SubAgent {
            return Err(OpenBitFunError::agent(format!(
                "Agent '{}' is not a subagent",
                agent_id
            )));
        }

        let subagent_key = subagent_key_for(entry.subagent_source, entry.agent.as_ref())
            .ok_or_else(|| {
                OpenBitFunError::agent(format!("Failed to resolve subagent key for '{}'", agent_id))
            })?;
        let default_enabled = resolve_default_enabled(&entry, Some(parent_agent_type));
        let state = if enabled {
            AgentSubagentOverrideState::Enabled
        } else {
            AgentSubagentOverrideState::Disabled
        };

        match entry.subagent_source {
            Some(SubAgentSource::Project) => {
                let workspace_root = workspace_root.ok_or_else(|| {
                    OpenBitFunError::agent(format!(
                        "workspace_path is required to update project subagent availability for '{}'",
                        agent_id
                    ))
                })?;
                let mut project_overrides =
                    load_project_subagent_overrides_local(workspace_root).await?;
                if enabled == default_enabled {
                    prune_override_config(&mut project_overrides, parent_agent_type, &subagent_key);
                } else {
                    set_override_state(
                        &mut project_overrides,
                        parent_agent_type,
                        &subagent_key,
                        state,
                    );
                }
                save_project_subagent_overrides_local(workspace_root, &project_overrides).await?;
                Ok(())
            }
            Some(SubAgentSource::Builtin) | Some(SubAgentSource::User) => {
                let mut user_overrides = get_subagent_overrides().await;
                let profile_id =
                    crate::agentic::agents::resolve_mode_config_profile_id(parent_agent_type)
                        .into_owned();
                let mut profile_overrides = user_overrides.remove(&profile_id).unwrap_or_default();
                if enabled == default_enabled {
                    profile_overrides.remove(&subagent_key);
                } else {
                    profile_overrides.insert(subagent_key.clone(), state);
                }
                persist_agent_profile_from_value(
                    parent_agent_type,
                    serde_json::json!({
                        "subagent_overrides": profile_overrides,
                    }),
                )
                .await?;
                Ok(())
            }
            Some(SubAgentSource::External) => Err(OpenBitFunError::agent(format!(
                "External subagent '{}' is read-only; manage it in External AI Apps",
                agent_id
            ))),
            None => Err(OpenBitFunError::agent(format!(
                "Agent '{}' has no subagent source",
                agent_id
            ))),
        }
    }
}

fn custom_agent_discovery_roots(workspace_root: Option<&Path>) -> CustomAgentDiscoveryRoots {
    CustomAgentDiscoveryRoots {
        workspace_root: workspace_root.map(Path::to_path_buf),
        openbitfun_user_agents_dir: Some(get_path_manager_arc().user_agents_dir()),
        home_dir: dirs::home_dir(),
    }
}

fn custom_agent_from_definition(path: String, definition: CustomAgentDefinition) -> Arc<dyn Agent> {
    match definition.kind {
        CustomAgentKind::Mode => Arc::new(CustomMode::from_definition(path, definition)),
        CustomAgentKind::Subagent => Arc::new(CustomSubagent::from_definition(path, definition)),
    }
}

fn save_runtime_custom_agent(agent: &Arc<dyn Agent>) -> OpenBitFunResult<()> {
    if let Some(custom_mode) = agent.as_any().downcast_ref::<CustomMode>() {
        return custom_mode.save_to_file(None);
    }
    let custom_subagent = agent
        .as_any()
        .downcast_ref::<CustomSubagent>()
        .ok_or_else(|| OpenBitFunError::agent("Failed to save custom agent".to_string()))?;
    custom_subagent.save_to_file(None)
}

fn custom_config_from_agent(agent: &dyn Agent) -> OpenBitFunResult<CustomAgentConfig> {
    if let Some(custom_mode) = agent.as_any().downcast_ref::<CustomMode>() {
        return Ok(CustomAgentConfig {
            model: custom_mode.data.model.clone(),
            model_is_explicit: custom_mode.data.model_is_explicit,
        });
    }
    let custom_subagent = agent
        .as_any()
        .downcast_ref::<CustomSubagent>()
        .ok_or_else(|| OpenBitFunError::agent("Failed to read custom agent config".to_string()))?;
    Ok(CustomAgentConfig {
        model: custom_subagent.data.model.clone(),
        model_is_explicit: custom_subagent.data.model_is_explicit,
    })
}

fn custom_agent_path(agent: &dyn Agent) -> Option<String> {
    if let Some(custom_mode) = agent.as_any().downcast_ref::<CustomMode>() {
        return Some(custom_mode.data.path.clone());
    }
    agent
        .as_any()
        .downcast_ref::<CustomSubagent>()
        .map(|custom_subagent| custom_subagent.data.path.clone())
}
