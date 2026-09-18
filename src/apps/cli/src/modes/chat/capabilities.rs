impl ChatMode {
    fn show_skill_selector(
        &self,
        chat_view: &mut ChatView,
        _chat_state: &mut ChatState,
        _rt_handle: &tokio::runtime::Handle,
    ) {
        chat_view.show_skill_menu();
    }

    fn reload_context(
        &self,
        target: openbitfun_runtime_ports::AgentContextReloadTarget,
        chat_view: &mut ChatView,
        chat_state: &mut ChatState,
        rt_handle: &tokio::runtime::Handle,
    ) {
        use openbitfun_runtime_ports::{AgentContextReloadRequest, AgentContextReloadTarget};

        let request = AgentContextReloadRequest {
            session_id: chat_state.core_session_id.clone(),
            target,
        };
        let outcome =
            tokio::task::block_in_place(|| rt_handle.block_on(self.agent.reload_context(request)));

        match outcome {
            Ok(_) => {
                let message = match target {
                    AgentContextReloadTarget::All => {
                        "Reloaded skills. Instructions will be reread for the next message."
                    }
                    AgentContextReloadTarget::Skills => "Reloaded skills.",
                    AgentContextReloadTarget::Instructions => {
                        "Instructions will be reread for the next message."
                    }
                };
                chat_state.add_system_message(message.to_string());
                chat_view.set_status(Some(message.to_string()));
            }
            Err(error) => {
                chat_state.add_system_message(format!("Could not reload context: {error}"));
                chat_view.set_status(Some("Context reload failed".to_string()));
            }
        }
    }

    fn show_available_skill_list(
        &self,
        chat_view: &mut ChatView,
        chat_state: &mut ChatState,
        rt_handle: &tokio::runtime::Handle,
    ) {
        let skills = tokio::task::block_in_place(|| {
            rt_handle.block_on(async {
                if self.agent.is_remote_workspace() {
                    anyhow::bail!("Skill management is unavailable for a Remote workspace")
                }
                let workspace_id = self
                    .agent
                    .workspace_id()
                    .ok_or_else(|| anyhow::anyhow!("Workspace ID is unavailable"))?;
                let workspace =
                    openbitfun_core::agentic::workspace::WorkspaceBinding::resolve(&workspace_id)
                        .await?;
                let registry =
                    openbitfun_core::agentic::tools::implementations::skills::get_skill_registry();
                let skills = registry
                    .get_user_invocable_skills_for_workspace(
                        Some(&workspace),
                        Some(&self.agent_type),
                    )
                    .await;
                Ok::<_, anyhow::Error>(skills.into_iter().map(skill_summary).collect::<Vec<_>>())
            })
        });
        let skills = match skills {
            Ok(skills) => skills,
            Err(error) => {
                chat_state.add_system_message(format!("Could not load skills: {error}"));
                return;
            }
        };

        if skills.is_empty() {
            chat_state.add_system_message(format!(
                "No user-invocable skills found for agent mode '{}'. Add or enable a skill, then check its user-invocable metadata.",
                self.agent_type
            ));
            return;
        }

        let skill_items: Vec<SkillItem> = skills
            .into_iter()
            .map(Self::skill_item_from_summary)
            .collect();

        if skill_items.is_empty() {
            chat_state.add_system_message("No skills found.".to_string());
            return;
        }

        chat_view.show_skill_list(skill_items);
    }

    fn show_skill_config_selector(
        &self,
        chat_view: &mut ChatView,
        chat_state: &mut ChatState,
        rt_handle: &tokio::runtime::Handle,
    ) {
        let skills = tokio::task::block_in_place(|| {
            rt_handle.block_on(async {
                if self.agent.is_remote_workspace() {
                    anyhow::bail!("Skill management is unavailable for a Remote workspace")
                }
                let workspace_id = self
                    .agent
                    .workspace_id()
                    .ok_or_else(|| anyhow::anyhow!("Workspace ID is unavailable"))?;
                let workspace =
                    openbitfun_core::agentic::workspace::WorkspaceBinding::resolve(&workspace_id)
                        .await?;
                let registry =
                    openbitfun_core::agentic::tools::implementations::skills::get_skill_registry();
                let skills = registry
                    .get_mode_skill_infos_for_workspace(
                        openbitfun_core::agentic::tools::implementations::skills::mode_overrides::SkillPolicyWorkspace::from_binding(&workspace),
                        &self.agent_type,
                    )
                    .await;
                Ok::<_, anyhow::Error>(
                    skills
                        .into_iter()
                        .map(mode_skill_summary)
                        .collect::<Vec<_>>(),
                )
            })
        });
        let skills = match skills {
            Ok(skills) => skills,
            Err(error) => {
                chat_state.add_system_message(format!("Could not load skills: {error}"));
                return;
            }
        };

        let skill_items: Vec<SkillItem> = skills
            .into_iter()
            .map(Self::skill_item_from_summary)
            .collect();

        if skill_items.is_empty() {
            chat_state.add_system_message("No skills found.".to_string());
            return;
        }

        chat_view.show_skill_config(skill_items);
    }

    fn handle_skill_selector_action(
        &mut self,
        action: SkillSelectorAction,
        chat_view: &mut ChatView,
        chat_state: &mut ChatState,
        rt_handle: &tokio::runtime::Handle,
    ) {
        match action {
            SkillSelectorAction::ListSkills => {
                self.show_available_skill_list(chat_view, chat_state, rt_handle);
            }
            SkillSelectorAction::ConfigureSkills => {
                self.show_skill_config_selector(chat_view, chat_state, rt_handle);
            }
            SkillSelectorAction::Execute(selected) => {
                chat_view.hide_skill_selector();
                self.apply_skill_selection(&selected, chat_view);
            }
            SkillSelectorAction::Toggle(selected) => {
                self.set_skill_enabled(&selected, !selected.enabled, chat_state, rt_handle);
                self.show_skill_config_selector(chat_view, chat_state, rt_handle);
            }
        }
    }

    /// Apply skill selection: fill input box with execution command
    fn apply_skill_selection(&mut self, selected: &SkillItem, chat_view: &mut ChatView) {
        chat_view.set_input(&selected.invocation_text());
        self.selected_native_command_once = None;
    }

    fn set_skill_enabled(
        &self,
        selected: &SkillItem,
        enabled: bool,
        chat_state: &mut ChatState,
        rt_handle: &tokio::runtime::Handle,
    ) {
        let mode_id = self.agent_type.clone();
        let skill = selected.clone();

        let result = tokio::task::block_in_place(|| {
            rt_handle.block_on(async {
                if self.agent.is_remote_workspace() {
                    anyhow::bail!("Skill management is unavailable for a Remote workspace")
                }
                let workspace = std::path::PathBuf::from(self.agent.workspace_path_string());
                match skill.level.as_str() {
                    "user" => {
                        openbitfun_core::agentic::tools::implementations::skills::mode_overrides::set_user_mode_skill_state(
                            &mode_id, &skill.key, enabled, skill.default_enabled,
                        )
                        .await
                        .map_err(|error| anyhow::anyhow!(error.to_string()))?;
                    }
                    "project" => {
                        let mut document = openbitfun_core::agentic::tools::implementations::skills::mode_overrides::load_project_mode_skills_document_local(&workspace)
                            .await
                            .map_err(|error| anyhow::anyhow!(error.to_string()))?;
                        openbitfun_core::agentic::tools::implementations::skills::mode_overrides::set_mode_skill_disabled_in_document(
                            &mut document, &mode_id, &skill.key, !enabled,
                        )
                        .map_err(|error| anyhow::anyhow!(error.to_string()))?;
                        openbitfun_core::agentic::tools::implementations::skills::mode_overrides::save_project_mode_skills_document_local(
                            &workspace, &document,
                        )
                        .await
                        .map_err(|error| anyhow::anyhow!(error.to_string()))?;
                    }
                    level => anyhow::bail!("Unsupported skill level '{level}'"),
                }
                Ok::<(), anyhow::Error>(())
            })
        });

        match result {
            Ok(_) => chat_state.add_system_message(format!(
                "Skill '{}' {} for mode '{}'.",
                selected.name,
                if enabled { "enabled" } else { "disabled" },
                self.agent_type
            )),
            Err(error) => chat_state.add_system_message(format!(
                "Failed to update skill '{}': {}",
                selected.name, error
            )),
        }
    }

    fn skill_item_from_summary(info: SkillSummary) -> SkillItem {
        SkillItem {
            key: info.key,
            name: info.name,
            description: info.description,
            level: info.level,
            source_slot: info.source_slot.unwrap_or_default(),
            source_label: info.source_label.unwrap_or_default(),
            enabled: info.enabled,
            selected_for_runtime: info.selected_for_runtime,
            default_enabled: info.default_enabled,
            is_shadowed: info.is_shadowed,
            shadowed_by_key: info.shadowed_by_key,
            argument_hint: info.argument_hint,
        }
    }

    /// Show subagent list/configuration menu.
    fn show_subagent_selector(
        &self,
        chat_view: &mut ChatView,
        _chat_state: &mut ChatState,
        _rt_handle: &tokio::runtime::Handle,
    ) {
        chat_view.show_subagent_menu();
    }

    fn show_available_subagent_list(
        &self,
        chat_view: &mut ChatView,
        chat_state: &mut ChatState,
        rt_handle: &tokio::runtime::Handle,
    ) {
        let subagents = tokio::task::block_in_place(|| {
            rt_handle.block_on(async {
                if self.agent.is_remote_workspace() {
                    anyhow::bail!("Subagent management is unavailable for a Remote workspace")
                }
                let workspace_id = self
                    .agent
                    .workspace_id()
                    .ok_or_else(|| anyhow::anyhow!("Workspace ID is unavailable"))?;
                let values = openbitfun_core::agentic::agents::get_agent_registry()
                    .get_subagents_for_query(
                        &openbitfun_core::agentic::agents::SubagentQueryContext {
                            parent_agent_type: Some(&self.agent_type),
                            workspace_id: Some(&workspace_id),
                            list_scope:
                                openbitfun_core::agentic::agents::SubagentListScope::TaskVisible,
                            include_disabled: false,
                            external_sources_supported: true,
                        },
                    )
                    .await;
                Ok::<_, anyhow::Error>((
                    values.into_iter().map(subagent_summary).collect::<Vec<_>>(),
                    false,
                ))
            })
        });
        let subagents = match subagents {
            Ok((subagents, _has_external)) => subagents,
            Err(error) => {
                chat_state.add_system_message(format!("Could not load subagents: {error}"));
                return;
            }
        };

        if subagents.is_empty() {
            chat_state.add_system_message(format!(
                "No enabled subagents found for agent mode '{}'.",
                self.agent_type
            ));
            return;
        }

        let subagent_items: Vec<SubagentItem> = subagents
            .into_iter()
            .map(Self::subagent_item_from_summary)
            .collect();

        if subagent_items.is_empty() {
            chat_state.add_system_message("No subagents found.".to_string());
            return;
        }

        chat_view.show_subagent_list(subagent_items);
    }

    fn show_subagent_config_selector(
        &self,
        chat_view: &mut ChatView,
        chat_state: &mut ChatState,
        rt_handle: &tokio::runtime::Handle,
    ) {
        let subagents = tokio::task::block_in_place(|| {
            rt_handle.block_on(async {
                if self.agent.is_remote_workspace() {
                    anyhow::bail!("Subagent management is unavailable for a Remote workspace")
                }
                let workspace_id = self.agent.workspace_id().ok_or_else(|| anyhow::anyhow!("Workspace ID is unavailable"))?;
                let values = openbitfun_core::agentic::agents::get_agent_registry()
                    .get_subagents_for_query(&openbitfun_core::agentic::agents::SubagentQueryContext {
                        parent_agent_type: Some(&self.agent_type),
                        workspace_id: Some(&workspace_id),
                        list_scope:
                            openbitfun_core::agentic::agents::SubagentListScope::RegistryManagement,
                        include_disabled: true,
                        external_sources_supported: true,
                    })
                    .await;
                let has_external = values.iter().any(|info| {
                    info.subagent_source
                        == Some(openbitfun_core::agentic::agents::SubAgentSource::External)
                });
                Ok::<_, anyhow::Error>((
                    values
                        .into_iter()
                        .filter(|info| {
                            info.subagent_source
                                != Some(openbitfun_core::agentic::agents::SubAgentSource::External)
                        })
                        .map(subagent_summary)
                        .collect::<Vec<_>>(),
                    has_external,
                ))
            })
        });
        let (subagents, has_external_subagents) = match subagents {
            Ok((subagents, has_external)) => (subagents, has_external),
            Err(error) => {
                chat_state.add_system_message(format!("Could not load subagents: {error}"));
                return;
            }
        };
        let subagent_items: Vec<SubagentItem> = subagents
            .into_iter()
            .map(Self::subagent_item_from_summary)
            .collect();

        if subagent_items.is_empty() {
            chat_state.add_system_message(if has_external_subagents {
                "No locally manageable subagents found. Open Agents from the command palette to review imported agents."
                    .to_string()
            } else {
                "No subagents found.".to_string()
            });
            return;
        }

        chat_view.show_subagent_config(subagent_items);
    }

    fn handle_subagent_selector_action(
        &mut self,
        action: SubagentSelectorAction,
        chat_view: &mut ChatView,
        chat_state: &mut ChatState,
        rt_handle: &tokio::runtime::Handle,
    ) {
        match action {
            SubagentSelectorAction::ListSubagents => {
                self.show_available_subagent_list(chat_view, chat_state, rt_handle);
            }
            SubagentSelectorAction::ConfigureSubagents => {
                self.show_subagent_config_selector(chat_view, chat_state, rt_handle);
            }
            SubagentSelectorAction::Launch(selected) => {
                chat_view.hide_subagent_selector();
                self.apply_subagent_selection(&selected, chat_view);
            }
            SubagentSelectorAction::Toggle(selected) => {
                self.set_subagent_enabled(&selected, !selected.enabled, chat_state, rt_handle);
                self.show_subagent_config_selector(chat_view, chat_state, rt_handle);
            }
        }
    }

    /// Apply subagent selection: fill input box with launch command
    fn apply_subagent_selection(&mut self, selected: &SubagentItem, chat_view: &mut ChatView) {
        chat_view.set_input(&format!(
            "Launch subagent {} to finish task: ",
            selected.name
        ));
        self.selected_native_command_once = None;
    }

    fn set_subagent_enabled(
        &self,
        selected: &SubagentItem,
        enabled: bool,
        chat_state: &mut ChatState,
        rt_handle: &tokio::runtime::Handle,
    ) {
        let mode_id = self.agent_type.clone();
        let subagent = selected.clone();

        let result = tokio::task::block_in_place(|| {
            rt_handle.block_on(async {
                if self.agent.is_remote_workspace() {
                    anyhow::bail!("Subagent management is unavailable for a Remote workspace")
                }
                let workspace_id = self
                    .agent
                    .workspace_id()
                    .ok_or_else(|| anyhow::anyhow!("Workspace ID is unavailable"))?;
                openbitfun_core::agentic::agents::get_agent_registry()
                    .update_subagent_override(&mode_id, &subagent.id, enabled, Some(&workspace_id))
                    .await
                    .map_err(|error| anyhow::anyhow!(error.to_string()))?;
                Ok::<(), anyhow::Error>(())
            })
        });

        match result {
            Ok(_) => chat_state.add_system_message(format!(
                "Subagent '{}' {} for mode '{}'.",
                selected.name,
                if enabled { "enabled" } else { "disabled" },
                self.agent_type
            )),
            Err(error) => chat_state.add_system_message(format!(
                "Failed to update subagent '{}': {}",
                selected.name, error
            )),
        }
    }

    fn subagent_item_from_summary(info: SubagentSummary) -> SubagentItem {
        SubagentItem {
            key: info.key,
            id: info.id,
            name: info.name,
            description: info.description,
            source: info.source,
            enabled: info.enabled,
        }
    }
}

fn skill_summary(
    info: openbitfun_core::agentic::tools::implementations::skills::SkillInfo,
) -> SkillSummary {
    SkillSummary {
        key: info.key,
        name: info.name,
        description: info.description,
        level: info.level.as_str().to_string(),
        source_slot: Some(info.source_slot),
        source_label: Some(info.source_label),
        enabled: true,
        selected_for_runtime: true,
        default_enabled: true,
        is_shadowed: info.is_shadowed,
        shadowed_by_key: info.shadowed_by_key,
        argument_hint: info.argument_hint,
    }
}

fn mode_skill_summary(
    info: openbitfun_core::agentic::tools::implementations::skills::ModeSkillInfo,
) -> SkillSummary {
    let skill = info.skill;
    SkillSummary {
        key: skill.key,
        name: skill.name,
        description: skill.description,
        level: skill.level.as_str().to_string(),
        source_slot: Some(skill.source_slot),
        source_label: Some(skill.source_label),
        enabled: info.effective_enabled,
        selected_for_runtime: info.selected_for_runtime,
        default_enabled: info.default_enabled,
        is_shadowed: skill.is_shadowed,
        shadowed_by_key: skill.shadowed_by_key,
        argument_hint: skill.argument_hint,
    }
}

fn subagent_summary(info: openbitfun_core::agentic::agents::AgentInfo) -> SubagentSummary {
    let is_external =
        info.subagent_source == Some(openbitfun_core::agentic::agents::SubAgentSource::External);
    SubagentSummary {
        key: info.key,
        id: info.id,
        name: info.name,
        description: info.description,
        source: format!(
            "{:?}",
            info.subagent_source
                .unwrap_or(openbitfun_core::agentic::agents::SubAgentSource::Builtin)
        )
        .to_ascii_lowercase(),
        enabled: info.effective_enabled,
        is_external,
        supports_follow_up: info.supports_follow_up,
    }
}
